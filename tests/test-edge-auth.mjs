// Tests Firebase ID-token verification (supabase/functions/api/auth.mjs) with REAL RSA signatures made locally.
// Google's servers are replaced by a stub, so live Firebase behaviour is NOT covered. Run: node tests/test-edge-auth.mjs
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createFirebaseVerifier } from '../supabase/functions/api/auth.mjs';

const b64u = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const kp = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const otherKp = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const pubJwk = { ...(await crypto.subtle.exportKey('jwk', kp.publicKey)), kid: 'kid1', alg: 'RS256', use: 'sig' };
const NOW = 1_800_000_000_000; const nowS = NOW / 1000;
const PROJECT = 'biocraft-af718';

async function mint(over = {}, { key = kp.privateKey, header = {} } = {}) {
  const h = { alg: 'RS256', kid: 'kid1', typ: 'JWT', ...header };
  const c = { iss: 'https://securetoken.google.com/' + PROJECT, aud: PROJECT, sub: 'uid1', iat: nowS - 100, auth_time: nowS - 100, exp: nowS + 3000, ...over };
  const input = b64u(JSON.stringify(h)) + '.' + b64u(JSON.stringify(c));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(input));
  return input + '.' + b64u(new Uint8Array(sig));
}
let lookups = 0; let lookupBehaviour = () => ({ status: 200, body: { users: [{ localId: 'uid1', disabled: false, validSince: String(nowS - 10000) }] } });
let jwksDown = false; let netDown = false;
const fetchImpl = async (url) => {
  if (String(url).includes('/jwk/')) { if (jwksDown) throw new Error('down'); return { ok: true, status: 200, json: async () => ({ keys: [pubJwk] }) }; }
  lookups++; if (netDown) throw new Error('down');
  const r = lookupBehaviour(); return { ok: r.status < 400, status: r.status, json: async () => r.body };
};
const fresh = (o = {}) => createFirebaseVerifier({ projectId: PROJECT, webApiKey: 'public-web-key', fetchImpl, now: () => NOW, ...o });
const rejects = async (p, status = 401) => { try { await p; } catch (e) { assert.equal(e.status, status, e.message); return e; } assert.fail('should have been rejected'); };

let pass = 0; const ok = async (n, f) => { try { await f(); pass++; console.log('PASS', n); } catch (e) { console.log('FAIL', n, '-', e.stack.split('\n').slice(0, 3).join(' | ')); process.exitCode = 1; } };

await ok('valid token accepted, uid returned', async () => { const c = await fresh()(await mint()); assert.equal(c.uid, 'uid1'); });
await ok('tampered payload (signature no longer matches) rejected', async () => {
  const t = (await mint()).split('.'); t[1] = b64u(JSON.stringify({ iss: 'https://securetoken.google.com/' + PROJECT, aud: PROJECT, sub: 'attacker', iat: nowS - 5, auth_time: nowS - 5, exp: nowS + 3000 }));
  await rejects(fresh()(t.join('.'))); });
await ok('token signed with a DIFFERENT private key rejected', async () => { await rejects(fresh()(await mint({}, { key: otherKp.privateKey }))); });
await ok('wrong audience rejected', async () => { await rejects(fresh()(await mint({ aud: 'other-project' }))); });
await ok('wrong issuer rejected', async () => { await rejects(fresh()(await mint({ iss: 'https://securetoken.google.com/other' }))); });
await ok('expired token rejected', async () => { await rejects(fresh()(await mint({ exp: nowS - 60 }))); });
await ok('token issued in the future rejected', async () => { await rejects(fresh()(await mint({ iat: nowS + 600 }))); });
await ok('missing sub rejected', async () => { await rejects(fresh()(await mint({ sub: '' }))); });
await ok('alg "none" rejected', async () => { const t = b64u(JSON.stringify({ alg: 'none', kid: 'kid1' })) + '.' + b64u(JSON.stringify({ aud: PROJECT, sub: 'uid1' })) + '.'; await rejects(fresh()(t)); });
await ok('alg HS256 (key-confusion attempt) rejected', async () => { await rejects(fresh()(await mint({}, { header: { alg: 'HS256' } }))); });
await ok('unknown kid rejected', async () => { await rejects(fresh()(await mint({}, { header: { kid: 'nope' } }))); });
await ok('garbage / empty tokens rejected', async () => { for (const t of ['', 'abc', 'a.b', 'a.b.c', undefined]) await rejects(fresh()(t)); });
await ok('disabled Firebase user rejected', async () => { lookupBehaviour = () => ({ status: 200, body: { users: [{ localId: 'uid1', disabled: true }] } }); await rejects(fresh()(await mint())); });
await ok('revoked token (issued before validSince) rejected', async () => { lookupBehaviour = () => ({ status: 200, body: { users: [{ localId: 'uid1', validSince: String(nowS) }] } }); await rejects(fresh()(await mint())); });
await ok('Google lookup says invalid / user not found -> rejected', async () => { lookupBehaviour = () => ({ status: 400, body: { error: { message: 'USER_NOT_FOUND' } } }); await rejects(fresh()(await mint())); });
await ok('lookup returns a different user -> rejected', async () => { lookupBehaviour = () => ({ status: 200, body: { users: [{ localId: 'someone-else' }] } }); await rejects(fresh()(await mint())); });
await ok('Google keys unreachable -> 503 (fails closed, never lets the request through)', async () => { jwksDown = true; await rejects(fresh()(await mint()), 503); jwksDown = false; });
await ok('Google lookup unreachable -> 503 (fails closed)', async () => { lookupBehaviour = () => ({ status: 200, body: { users: [{ localId: 'uid1' }] } }); netDown = true; await rejects(fresh()(await mint()), 503); netDown = false; });
await ok('missing FIREBASE_WEB_API_KEY -> 503 (revocation cannot be checked, so it refuses)', async () => { await rejects(fresh({ webApiKey: '' })(await mint()), 503); });
await ok('lookup result is cached for 30 s (one Google call for repeated requests)', async () => {
  lookupBehaviour = () => ({ status: 200, body: { users: [{ localId: 'uid1' }] } }); lookups = 0; const v = fresh(); const t = await mint(); await v(t); await v(t); await v(t); assert.equal(lookups, 1); });
console.log(`\n${pass} passed`);
