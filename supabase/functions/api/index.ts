// Supabase Edge Function "api": the whole BioCraft backend (replaces the Firebase Cloud Function "api").
// Deploy with:  supabase functions deploy api --no-verify-jwt --project-ref <ref>
// (--no-verify-jwt is REQUIRED: callers present Firebase ID tokens / webhook tokens, not Supabase JWTs.
//  Every route is protected inside handler.mjs.)
import { createHandler } from "./handler.mjs";
import { createFirebaseVerifier } from "./auth.mjs";

const handler = createHandler({ verifyIdToken: createFirebaseVerifier() });

Deno.serve(handler);
