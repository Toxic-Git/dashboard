// Cloudflare Worker — cross-device sync (KV)
//
// Endpoints (matcher hvad index.html, sbd/ og lob/ kalder):
//   GET  /kv/:key                → { value, updatedAt }
//   PUT  /kv/:key   body {value} → { updatedAt }
//
// Bindings (se wrangler.toml):
//   KV — KV-namespace
//
// Ingen adgangskontrol — Worker-URL'en er den eneste "nøgle". Del den ikke.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const kvMatch = url.pathname.match(/^\/kv\/([A-Za-z0-9_-]+)$/);
    if (kvMatch) {
      const key = kvMatch[1];
      if (request.method === 'GET') {
        const stored = await env.KV.get(`kv:${key}`, 'json');
        return json(stored || { value: null, updatedAt: 0 });
      }
      if (request.method === 'PUT') {
        let body;
        try { body = await request.json(); }
        catch { return json({ error: 'invalid JSON' }, 400); }
        if (!body || !('value' in body)) return json({ error: 'missing value' }, 400);
        const updatedAt = Date.now();
        await env.KV.put(`kv:${key}`, JSON.stringify({ value: body.value, updatedAt }));
        return json({ updatedAt });
      }
      return json({ error: 'method not allowed' }, 405);
    }

    return json({ error: 'not found' }, 404);
  },
};
