// Reads a setting from the Supabase Edge runtime (Deno.env) and falls back to process.env so the same
// code also runs under Node for the local tests. Secrets are only ever read here at request time.
export function env(name) {
  const d = globalThis.Deno;
  if (d && d.env) {
    try { const v = d.env.get(name); if (v !== undefined) return v; } catch (_) { /* no permission: fall through */ }
  }
  const p = globalThis.process;
  return p && p.env ? p.env[name] : undefined;
}
