// ══════════════════════════════════════════════════════════════════════════
// Træning-sync — Cloudflare Worker (API v2)
// Simpel key-value sync til SBD- og løbe-trackeren + dashboardet.
// Adgangskontrol: sæt hemmeligheden SYNC_TOKEN (wrangler secret put SYNC_TOKEN).
// Når den er sat, kræver alle /kv-kald headeren  Authorization: Bearer <token>.
// Er den IKKE sat, er Worker'en åben som før (så eksisterende opsætning ikke
// går i stykker, før du har deployet og indtastet token i appen).
//
// v2 (bagudkompatibel med v1-klienter og eksisterende KV-data):
//  • Betinget skrivning: PUT { value, baseUpdatedAt } → 409 hvis serverens version er ændret siden
//    klienten sidst så den (så to enheder ikke tavst overskriver hinanden). PUT uden baseUpdatedAt
//    opfører sig som før (v1-klienter).
//  • Nye nøgler til V3-metadata pr. profil: tp_meta_main / tp_meta_partner.
//  • Validering: kun JSON-objekter, størrelsesgrænse, profil-match for tp_meta_*.
//  • GET /version → { api: 2, keys: [...] } (ingen data; bruges af klienten til at se om Worker'en er opdateret).
// KV har ingen atomisk compare-and-swap: to PUT'er i præcis samme øjeblik kan stadig race
// (se docs/V3-TECHNICAL-REVIEW.md). For en enkelt brugers to enheder er vinduet meget lille.
// ══════════════════════════════════════════════════════════════════════════

const API_VERSION = 2;
const BLOB_KEYS = ['sbd_state', 'sbd_partner', 'lob_state', 'lob_partner'];
const META_KEYS = { tp_meta_main: 'main', tp_meta_partner: 'partner' };
const ALLOWED_KEYS = new Set(BLOB_KEYS.concat(Object.keys(META_KEYS)));
const MAX_BYTES = 2 * 1024 * 1024; // 2 MB pr. nøgle (KV tillader mere; dette er et fornuftigt loft)

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,PUT,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-TP-Api': String(API_VERSION) },
  });
}

// Sammenligning i konstant tid, så tokenet ikke kan gættes via svartid.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function isAuthorized(request, env) {
  if (!env.SYNC_TOKEN) return true; // ikke konfigureret endnu → åben (bagudkompatibel)
  const header = request.headers.get('Authorization') || '';
  const m = header.match(/^Bearer (.+)$/);
  return !!m && safeEqual(m[1], env.SYNC_TOKEN);
}

function isObj(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }

// Returnerer en fejltekst eller null. Bevidst løs for blob-nøgler (appens egne formater ændrer sig),
// men afviser tydeligt forkerte former, så en fejl-PUT ikke kan ødelægge den gode kopi.
function validate(key, value) {
  if (!isObj(value)) return 'værdien skal være et JSON-objekt';
  if (key === 'sbd_state' || key === 'sbd_partner') {
    if (value.logs != null && !isObj(value.logs)) return 'sbd: logs skal være et objekt';
    if (value.completedDays != null && !Array.isArray(value.completedDays)) return 'sbd: completedDays skal være en liste';
  } else if (key === 'lob_state' || key === 'lob_partner') {
    if (!isObj(value.profile) || !Array.isArray(value.runs)) return 'løb: mangler profile/runs';
  } else if (META_KEYS[key]) {
    if (value.profile !== META_KEYS[key]) return 'tp_meta: profilen i data matcher ikke nøglen';
    if (value.v !== 1) return 'tp_meta: ukendt format-version';
    if (value.planChanges != null && !Array.isArray(value.planChanges)) return 'tp_meta: planChanges skal være en liste';
  }
  return null;
}

// KV-binding og nøgleformat. To deployments findes i praksis:
//  • Ny opsætning (DEPLOY.md): binding TRAINING_KV, nøgler gemmes som de er.
//  • Den eksisterende produktions-Worker: binding KV, nøgler gemmes som "kv:<nøgle>" (ældre version).
// v2 understøtter begge, så eksisterende data findes uændret efter opdatering.
function store(env) { return env.TRAINING_KV || env.KV; }
function storageKey(env, key) { return env.TRAINING_KV ? key : 'kv:' + key; }

async function readRecord(env, key) {
  const raw = await store(env).get(storageKey(env, key));
  if (!raw) return null;
  try { const r = JSON.parse(raw); return isObj(r) ? r : null; } catch (e) { return null; }
}

// ── /kv/:key — bruges af SBD/løb/dashboard til cross-device sync ──────────
async function handleKv(request, env, key) {
  if (!isAuthorized(request, env)) return json({ error: 'uautoriseret' }, 401);
  if (!ALLOWED_KEYS.has(key)) return json({ error: 'ukendt nøgle' }, 400);

  if (request.method === 'GET') {
    const rec = await readRecord(env, key);
    return json(rec || { value: null, updatedAt: 0 });
  }

  if (request.method === 'PUT') {
    const text = await request.text();
    if (text.length > MAX_BYTES) return json({ error: 'for stor (max 2 MB)' }, 413);
    let body;
    try {
      body = JSON.parse(text);
    } catch (e) {
      return json({ error: 'ugyldig JSON' }, 400);
    }
    if (!isObj(body)) return json({ error: 'ugyldig JSON' }, 400);
    const bad = validate(key, body.value);
    if (bad) return json({ error: 'ugyldig værdi: ' + bad }, 422);

    const cur = await readRecord(env, key);
    const curTs = cur && Number(cur.updatedAt) ? Number(cur.updatedAt) : 0;

    // Betinget skrivning (kun hvis klienten sender baseUpdatedAt; v1-klienter gør ikke)
    if (body.baseUpdatedAt !== undefined && body.baseUpdatedAt !== null) {
      if (curTs !== Number(body.baseUpdatedAt)) return json({ error: 'konflikt', current: cur || { value: null, updatedAt: 0 } }, 409);
    }

    // Versionen er monotont stigende, også ved ur-skævhed.
    const ts = Math.max(Date.now(), curTs + 1);
    const record = { value: body.value, updatedAt: ts };
    await store(env).put(storageKey(env, key), JSON.stringify(record));
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

    if (url.pathname === '/version' && request.method === 'GET') {
      return json({ api: API_VERSION, keys: Array.from(ALLOWED_KEYS), conditionalPut: true });
    }

    const kvMatch = url.pathname.match(/^\/kv\/([a-zA-Z0-9_]+)$/);
    if (kvMatch) return handleKv(request, env, kvMatch[1]);

    return json({ error: 'not found' }, 404);
  },
};
