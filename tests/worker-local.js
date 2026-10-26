// NIVEAU: lokal Worker-RUNTIME (workerd via wrangler dev --local, lokal KV). IKKE en deployet Cloudflare-Worker.
// Kør: WORKER_URL=http://127.0.0.1:8799 SYNC_TOKEN=<lokal test-token> node tests/worker-local.js   (springes over uden WORKER_URL)
// Bruger kun syntetiske data. Token udskrives aldrig.
const assert = require('assert');
const URL_ = process.env.WORKER_URL, TOK = process.env.SYNC_TOKEN || '';
if (!URL_) { console.log('SPRUNGET OVER: WORKER_URL ikke sat (kræver wrangler dev --local)'); process.exit(0); }
let ok = 0, bad = 0;
const T = async (n, f) => { try { await f(); ok++; console.log('  ok   ' + n); } catch (e) { bad++; console.log('  FEJL ' + n + '\n       ' + String(e.message).split('\n')[0]); } };
const H = (t, extra) => Object.assign({ 'Content-Type': 'application/json' }, t === false ? {} : { Authorization: 'Bearer ' + (t || TOK) }, extra || {});
const get = (k, t) => fetch(URL_ + '/kv/' + k, { headers: H(t) });
const put = (k, body, t) => fetch(URL_ + '/kv/' + k, { method: 'PUT', headers: H(t), body: typeof body === 'string' ? body : JSON.stringify(body) });
const lob = n => ({ profile: { x: 1 }, runs: Array.from({ length: n }, (_, i) => ({ id: i })) });
(async () => {
  await T('GET /version → api 2, conditionalPut, meta-nøgler', async () => { const j = await (await fetch(URL_ + '/version')).json(); assert.strictEqual(j.api, 2); assert(j.conditionalPut); assert(j.keys.includes('tp_meta_main')); });
  await T('401 uden/forkert token; 200 med', async () => { assert.strictEqual((await get('lob_state', false)).status, 401); assert.strictEqual((await get('lob_state', 'forkert')).status, 401); assert.strictEqual((await get('lob_state')).status, 200); });
  await T('ukendt nøgle → 400; ugyldig JSON → 400; forkert form → 422', async () => {
    assert.strictEqual((await get('hemmelig')).status, 400); assert.strictEqual((await put('lob_state', '{not json')).status, 400);
    assert.strictEqual((await put('lob_state', { value: { runs: 'nej' } })).status, 422);
  });
  let ts1;
  await T('PUT uden base (v1-klient) virker; GET returnerer samme værdi + updatedAt', async () => {
    const r = await put('lob_state', { value: lob(1) }); assert.strictEqual(r.status, 200); ts1 = (await r.json()).updatedAt; assert(ts1 > 0);
    const g = await (await get('lob_state')).json(); assert.strictEqual(g.value.runs.length, 1); assert.strictEqual(g.updatedAt, ts1);
  });
  await T('betinget PUT med forældet base → 409 med serverens version; korrekt base → 200 og stigende version', async () => {
    const bad_ = await put('lob_state', { value: lob(9), baseUpdatedAt: ts1 - 1 }); assert.strictEqual(bad_.status, 409); assert.strictEqual((await bad_.json()).current.value.runs.length, 1);
    const good = await put('lob_state', { value: lob(2), baseUpdatedAt: ts1 }); assert.strictEqual(good.status, 200); assert((await good.json()).updatedAt > ts1);
  });
  await T('tp_meta: profil skal matche nøglen', async () => {
    assert.strictEqual((await put('tp_meta_main', { value: { v: 1, profile: 'partner' } })).status, 422);
    assert.strictEqual((await put('tp_meta_main', { value: { v: 1, profile: 'main', planChanges: [] } })).status, 200);
  });
  await T('for stor (> 2 MB) → 413', async () => { assert.strictEqual((await put('sbd_state', { value: { logs: {}, pad: 'x'.repeat(2.2 * 1024 * 1024) } })).status, 413); });
  await T('KLIENTMOTOR mod lokal runtime: to enheder, samtidig ændring → konflikt (ingen tavs overskrivning), derefter løsning', async () => {
    const TPSYNC = require('../tp-sync.js'); const J = JSON.stringify;
    const mem = (init) => { const m = Object.assign({}, init); return { _m: m, getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: k => { delete m[k]; } }; };
    let clk = 5e12; const dev = (init) => { const storage = mem(init); return { storage, e: TPSYNC.create({ storage, fetch: (u, o) => fetch(u, o), baseUrl: URL_, getToken: () => TOK, now: () => (clk += 1000) }) }; };
    await put('sbd_state', { value: { profile: 'main', logs: {}, completedDays: [] } }); // nulstil nøgle til kendt tilstand
    const A = dev({}), B = dev({});
    await A.e.syncKey('sbd_state'); await B.e.syncKey('sbd_state');
    A.storage.setItem('sbd_state', J({ profile: 'main', logs: {}, completedDays: [1, 2], note: 'A' }));
    B.storage.setItem('sbd_state', J({ profile: 'main', logs: {}, completedDays: [1], note: 'B' }));
    assert.strictEqual((await A.e.syncKey('sbd_state')).status, 'ok');
    const rb = await B.e.syncKey('sbd_state'); assert.strictEqual(rb.status, 'conflict');
    assert.strictEqual(JSON.parse(B.storage._m.sbd_state).note, 'B', 'B\'s data urørt indtil brugeren vælger');
    assert.strictEqual((await B.e.resolve('sbd_state', 'remote')).ok, true);
    assert.strictEqual(JSON.parse(B.storage._m.sbd_state).note, 'A');
  });
  await T('OPTIONS/CORS svarer', async () => { const r = await fetch(URL_ + '/kv/lob_state', { method: 'OPTIONS' }); assert(r.status < 300); assert(r.headers.get('access-control-allow-origin')); });
  console.log(`\n${bad ? bad + ' FEJL, ' : ''}${ok} ok  [niveau: lokal workerd-runtime]`); process.exit(bad ? 1 : 0);
})();
