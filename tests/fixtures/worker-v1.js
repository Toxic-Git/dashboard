// KOPI af den oprindelige (V2) Worker — bruges kun i tests til at bevise bagudkompatibilitet. Ingen hemmeligheder.
const ALLOWED_KEYS = new Set(['sbd_state', 'sbd_partner', 'lob_state', 'lob_partner']);
const CORS_HEADERS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,PUT,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' };
function json(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }); }
function safeEqual(a, b) { if (typeof a !== 'string' || typeof b !== 'string') return false; let diff = a.length ^ b.length; const n = Math.max(a.length, b.length); for (let i = 0; i < n; i++) { diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0); } return diff === 0; }
function isAuthorized(request, env) { if (!env.SYNC_TOKEN) return true; const header = request.headers.get('Authorization') || ''; const m = header.match(/^Bearer (.+)$/); return !!m && safeEqual(m[1], env.SYNC_TOKEN); }
async function handleKv(request, env, key) {
  if (!isAuthorized(request, env)) return json({ error: 'uautoriseret' }, 401);
  if (!ALLOWED_KEYS.has(key)) return json({ error: 'ukendt nøgle' }, 400);
  if (request.method === 'GET') { const raw = await env.TRAINING_KV.get(key); if (!raw) return json({ value: null, updatedAt: 0 }); try { return json(JSON.parse(raw)); } catch (e) { return json({ value: null, updatedAt: 0 }); } }
  if (request.method === 'PUT') { let body; try { body = await request.json(); } catch (e) { return json({ error: 'ugyldig JSON' }, 400); } const record = { value: body.value, updatedAt: Date.now() }; await env.TRAINING_KV.put(key, JSON.stringify(record)); return json(record); }
  return json({ error: 'metode ikke tilladt' }, 405);
}
export default { async fetch(request, env) { if (request.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS }); const url = new URL(request.url); const kvMatch = url.pathname.match(/^\/kv\/([a-zA-Z0-9_]+)$/); if (kvMatch) return handleKv(request, env, kvMatch[1]); return json({ error: 'not found' }, 404); } };
