// Cloudflare Worker — cross-device sync (KV) + Strava-import
//
// Endpoints (matcher hvad index.html, sbd/ og lob/ kalder):
//   GET  /kv/:key                      → { value, updatedAt }
//   PUT  /kv/:key   body {value}       → { updatedAt }
//   GET  /strava/connect?profile=      → redirect til Stravas OAuth-side
//   GET  /strava/callback              → token-udveksling, redirect til appen
//   GET  /strava/status?profile=       → { connected }
//   GET  /strava/disconnect?profile=   → { ok }
//   GET  /strava/sync?profile=         → { imported }
//   Cron (hver 3. time)                → auto-sync begge profiler
//
// Bindings/vars (se wrangler.toml):
//   KV                   — KV-namespace
//   LOB_APP_URL          — fuld URL til lob/index.html (til redirect efter OAuth)
//   STRAVA_CLIENT_ID     — secret
//   STRAVA_CLIENT_SECRET — secret
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

// profile=main → lob_state, profile=partner → lob_partner
function lobKeyForProfile(profile) {
  return profile === 'partner' ? 'lob_partner' : 'lob_state';
}
function tokenKeyForProfile(profile) {
  return `strava_tokens_${profile === 'partner' ? 'partner' : 'main'}`;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    // ── KV sync ───────────────────────────────────────────────────────────
    const kvMatch = path.match(/^\/kv\/([A-Za-z0-9_-]+)$/);
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

    // ── Strava ────────────────────────────────────────────────────────────
    const profile = url.searchParams.get('profile') === 'partner' ? 'partner' : 'main';

    if (path === '/strava/connect') {
      const redirectUri = `${url.origin}/strava/callback`;
      const authUrl =
        'https://www.strava.com/oauth/authorize' +
        `?client_id=${env.STRAVA_CLIENT_ID}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        '&response_type=code' +
        '&approval_prompt=auto' +
        '&scope=activity:read_all' +
        `&state=${profile}`;
      return Response.redirect(authUrl, 302);
    }

    if (path === '/strava/callback') {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state') === 'partner' ? 'partner' : 'main';
      const appUrl = env.LOB_APP_URL || '';
      if (!code) {
        return Response.redirect(`${appUrl}?strava_error=${encodeURIComponent('ingen kode modtaget')}`, 302);
      }
      try {
        const res = await fetch('https://www.strava.com/oauth/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_id: env.STRAVA_CLIENT_ID,
            client_secret: env.STRAVA_CLIENT_SECRET,
            code,
            grant_type: 'authorization_code',
          }),
        });
        if (!res.ok) throw new Error(`token-udveksling fejlede (${res.status})`);
        const tok = await res.json();
        await env.KV.put(tokenKeyForProfile(state), JSON.stringify({
          access_token: tok.access_token,
          refresh_token: tok.refresh_token,
          expires_at: tok.expires_at,
        }));
        return Response.redirect(`${appUrl}?strava_connected=1&profile=${state}`, 302);
      } catch (e) {
        return Response.redirect(`${appUrl}?strava_error=${encodeURIComponent(e.message)}`, 302);
      }
    }

    if (path === '/strava/status') {
      const tokens = await env.KV.get(tokenKeyForProfile(profile), 'json');
      return json({ connected: !!(tokens && tokens.refresh_token) });
    }

    if (path === '/strava/disconnect') {
      await env.KV.delete(tokenKeyForProfile(profile));
      return json({ ok: true });
    }

    if (path === '/strava/sync') {
      try {
        const imported = await syncStravaProfile(env, profile);
        return json({ imported });
      } catch (e) {
        return json({ error: e.message, imported: null }, 500);
      }
    }

    return json({ error: 'not found' }, 404);
  },

  // Cron Trigger — auto-import for begge profiler
  async scheduled(event, env, ctx) {
    for (const profile of ['main', 'partner']) {
      try { await syncStravaProfile(env, profile); }
      catch (e) { console.log(`Cron-sync fejlede for ${profile}:`, e.message); }
    }
  },
};

// ── Hjælpere ──────────────────────────────────────────────────────────────

async function getValidAccessToken(env, profile) {
  const key = tokenKeyForProfile(profile);
  const tokens = await env.KV.get(key, 'json');
  if (!tokens || !tokens.refresh_token) return null;

  // Forny hvis udløbet (eller udløber inden for 5 min)
  if (!tokens.expires_at || tokens.expires_at * 1000 < Date.now() + 5 * 60 * 1000) {
    const res = await fetch('https://www.strava.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: env.STRAVA_CLIENT_ID,
        client_secret: env.STRAVA_CLIENT_SECRET,
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
      }),
    });
    if (!res.ok) throw new Error(`token-fornyelse fejlede (${res.status})`);
    const tok = await res.json();
    await env.KV.put(key, JSON.stringify({
      access_token: tok.access_token,
      refresh_token: tok.refresh_token,
      expires_at: tok.expires_at,
    }));
    return tok.access_token;
  }
  return tokens.access_token;
}

async function syncStravaProfile(env, profile) {
  const accessToken = await getValidAccessToken(env, profile);
  if (!accessToken) return 0; // ikke forbundet

  // Hent seneste aktiviteter (30 dage tilbage er rigeligt for cron hver 3. time;
  // manuel sync henter det samme)
  const after = Math.floor(Date.now() / 1000) - 30 * 24 * 3600;
  const res = await fetch(
    `https://www.strava.com/api/v3/athlete/activities?after=${after}&per_page=100`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) throw new Error(`kunne ikke hente aktiviteter (${res.status})`);
  const activities = await res.json();

  const runs = activities.filter(a => a.type === 'Run' || a.sport_type === 'Run');
  if (!runs.length) return 0;

  // Merge ind i appens state i KV (samme format som appen selv gemmer)
  const stateKey = `kv:${lobKeyForProfile(profile)}`;
  const stored = await env.KV.get(stateKey, 'json');
  const state = (stored && stored.value) ? stored.value : { profile: {}, runs: [], notFeeling100: {} };
  if (!Array.isArray(state.runs)) state.runs = [];

  const existingIds = new Set(state.runs.map(r => String(r.id)));
  let imported = 0;
  for (const act of runs) {
    const id = `strava_${act.id}`;
    if (existingIds.has(id)) continue;
    state.runs.push({
      id,
      date: (act.start_date_local || act.start_date || '').slice(0, 10),
      distanceKm: Math.round((act.distance / 1000) * 100) / 100,
      durationSec: act.moving_time,
      avgHR: act.average_heartrate ? Math.round(act.average_heartrate) : null,
      maxHR: act.max_heartrate ? Math.round(act.max_heartrate) : null,
      elev: act.total_elevation_gain != null ? Math.round(act.total_elevation_gain) : null,
      feeling: null,
      notat: act.name || 'Importeret fra Strava',
    });
    imported++;
  }

  if (imported > 0) {
    state.runs.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    await env.KV.put(stateKey, JSON.stringify({ value: state, updatedAt: Date.now() }));
  }
  return imported;
}
