// ══════════════════════════════════════════════════════════════════════════
// Træning-sync — Cloudflare Worker
// Simpel key-value sync til SBD- og løbe-trackeren + dashboardet.
// Ingen adgangskontrol (bevidst valg) — Worker-URL'en er den eneste
// "adgangskode".
// ══════════════════════════════════════════════════════════════════════════

const ALLOWED_KEYS = new Set(['sbd_state', 'sbd_partner', 'lob_state', 'lob_partner']);

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,PUT,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

// ── /kv/:key — bruges af SBD/løb/dashboard til cross-device sync ──────────
async function handleKv(request, env, key) {
  if (!ALLOWED_KEYS.has(key)) return json({ error: 'ukendt nøgle' }, 400);

  if (request.method === 'GET') {
    const raw = await env.TRAINING_KV.get(key);
    if (!raw) return json({ value: null, updatedAt: 0 });
    try {
      return json(JSON.parse(raw));
    } catch (e) {
      return json({ value: null, updatedAt: 0 });
    }
  }

  if (request.method === 'PUT') {
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json({ error: 'ugyldig JSON' }, 400);
    }
    const record = { value: body.value, updatedAt: Date.now() };
    await env.TRAINING_KV.put(key, JSON.stringify(record));
    return json(record);
  }

  return json({ error: 'metode ikke tilladt' }, 405);
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }
    const url = new URL(request.url);

    const kvMatch = url.pathname.match(/^\/kv\/([a-zA-Z0-9_]+)$/);
    if (kvMatch) return handleKv(request, env, kvMatch[1]);

    return json({ error: 'not found' }, 404);
  },
};
