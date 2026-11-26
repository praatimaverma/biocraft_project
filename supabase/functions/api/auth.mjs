// Firebase ID-token verification for Supabase Edge Functions (no Firebase Admin SDK, no extra packages).
//  1. Signature: RS256 against Google's public signing keys (securetoken JWKS), key picked by "kid".
//  2. Claims: iss = https://securetoken.google.com/<projectId>, aud = <projectId>, exp/iat/auth_time, sub.
//  3. Disabled / revoked users (same effect as admin.auth().verifyIdToken(token, true)): the token is sent
//     to Google's Identity Toolkit accounts:lookup (public Web API key). A disabled user or a token issued
//     before the user's "validSince" (revokeRefreshTokens) is rejected. Result cached for 30 s.
import { Buffer } from 'node:buffer';
import { env } from './env.mjs';

const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const LOOKUP_URL = 'https://identitytoolkit.googleapis.com/v1/accounts:lookup';
const JWKS_TTL_MS = 60 * 60 * 1000;
const JWKS_MIN_REFETCH_MS = 5 * 60 * 1000;
const LOOKUP_TTL_MS = 30 * 1000;
const CLOCK_SKEW_S = 5;

export class AuthError extends Error {
  constructor(message, status = 401) { super(message); this.name = 'AuthError'; this.status = status; }
}

const b64urlToBuf = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
function parseJson(buf, what) {
  try { return JSON.parse(buf.toString('utf8')); } catch (_) { throw new AuthError('Malformed token ' + what); }
}

export function createFirebaseVerifier({
  projectId = env('FIREBASE_PROJECT_ID') || 'biocraft-af718',
  webApiKey = env('FIREBASE_WEB_API_KEY'),
  fetchImpl = (...a) => fetch(...a),
  now = () => Date.now()
} = {}) {
  let jwks = null; let jwksAt = 0; let lastRefetch = 0;
  const keyCache = new Map();
  const lookupCache = new Map();

  async function loadJwks(force) {
    if (!force && jwks && now() - jwksAt < JWKS_TTL_MS) return jwks;
    if (force && jwks && now() - lastRefetch < JWKS_MIN_REFETCH_MS) return jwks;
    lastRefetch = now();
    let res;
    try { res = await fetchImpl(JWKS_URL); } catch (_) { throw new AuthError('Could not reach Google to verify the sign-in token', 503); }
    if (!res.ok) throw new AuthError('Could not load Google signing keys', 503);
    jwks = (await res.json()).keys || []; jwksAt = now(); keyCache.clear();
    return jwks;
  }

  async function getKey(kid) {
    for (const force of [false, true]) {
      const keys = await loadJwks(force);
      const jwk = keys.find((k) => k.kid === kid && k.kty === 'RSA');
      if (jwk) {
        if (!keyCache.has(kid)) {
          keyCache.set(kid, await crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
            { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']));
        }
        return keyCache.get(kid);
      }
    }
    throw new AuthError('Unknown token signing key');
  }

  async function verify(token) {
    if (!projectId) throw new AuthError('FIREBASE_PROJECT_ID is not configured', 503);
    if (!webApiKey) throw new AuthError('FIREBASE_WEB_API_KEY is not configured, so sign-in tokens cannot be checked for revocation', 503);
    const parts = String(token || '').split('.');
    if (parts.length !== 3 || parts.some((p) => !p)) throw new AuthError('Malformed token');
    const header = parseJson(b64urlToBuf(parts[0]), 'header');
    const claims = parseJson(b64urlToBuf(parts[1]), 'payload');
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new AuthError('Unsupported token algorithm');

    const key = await getKey(header.kid);
    const okSig = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlToBuf(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1]));
    if (!okSig) throw new AuthError('Invalid token signature');

    const nowS = Math.floor(now() / 1000);
    if (claims.aud !== projectId) throw new AuthError('Token audience mismatch');
    if (claims.iss !== 'https://securetoken.google.com/' + projectId) throw new AuthError('Token issuer mismatch');
    if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 128) throw new AuthError('Token has no valid subject');
    if (typeof claims.exp !== 'number' || claims.exp <= nowS - CLOCK_SKEW_S) throw new AuthError('Token expired');
    if (typeof claims.iat !== 'number' || claims.iat > nowS + CLOCK_SKEW_S) throw new AuthError('Token issued in the future');
    if (typeof claims.auth_time !== 'number' || claims.auth_time > nowS + CLOCK_SKEW_S) throw new AuthError('Token auth_time invalid');

    // Disabled / revoked check.
    const ck = claims.sub + ':' + claims.iat;
    const hit = lookupCache.get(ck);
    if (hit && now() - hit < LOOKUP_TTL_MS) return { ...claims, uid: claims.sub };
    let res;
    try {
      res = await fetchImpl(LOOKUP_URL + '?key=' + encodeURIComponent(webApiKey), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: token })
      });
    } catch (_) { throw new AuthError('Could not reach Google to check the account status', 503); }
    if (res.status >= 500) throw new AuthError('Google account check is unavailable', 503);
    if (!res.ok) throw new AuthError('Account not valid for this token');   // USER_NOT_FOUND, INVALID_ID_TOKEN, TOKEN_EXPIRED...
    const user = ((await res.json()).users || [])[0];
    if (!user || user.localId !== claims.sub) throw new AuthError('Account not found');
    if (user.disabled === true) throw new AuthError('This account has been disabled');
    if (user.validSince && claims.auth_time < Number(user.validSince)) throw new AuthError('Sign-in has been revoked');
    lookupCache.set(ck, now());
    if (lookupCache.size > 500) lookupCache.clear();
    return { ...claims, uid: claims.sub };
  }
  return verify;
}
