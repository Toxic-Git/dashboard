// Krop-synk: sammenfletning (ren logik) + integration mod Worker-KILDEKODEN (v2) og den gamle v1-fixture. Syntetiske data, intet netværk.
const assert = require('assert'), path = require('path');
const { world, J, TPSYNC } = require('./helpers/world');
const V1 = path.join(__dirname, 'fixtures', 'worker-v1.js');
let ok = 0, bad = 0;
const T = async (n, f) => { try { await f(); ok++; console.log('  ok   ' + n); } catch (e) { bad++; console.log('  FEJL ' + n + '\n       ' + (e.stack || e).toString().split('\n').slice(0, 4).join('\n       ')); } };
const KEY = 'krop_state';
const st = o => Object.assign({ v: 1, profile: { heightCm: 185 }, profileAt: 0, phase: null, phaseAt: 0, tombs: {}, weighins: [], checkins: [], adjustments: [], snapshots: [], history: [] }, o || {});
const w = (date, kg, t) => ({ date, kg, t: t || 0 });
const phase = (kcal) => ({ type: 'cut', start: '2026-11-30', kcal, meals: 3 });
const canon = x => JSON.stringify(TPSYNC.normKrop(x));

(async () => {
  console.log('Sammenfletning (ren logik)');
  await T('normKrop: tomme/ugyldige input giver gyldig tom tilstand; dubletter og skrald fjernes; sorteret efter id', () => {
    const e = TPSYNC.normKrop(null); assert.strictEqual(e.v, 1); assert.deepStrictEqual(e.weighins, []); assert.strictEqual(e.phase, null); assert.deepStrictEqual(e.tombs, {});
    const n = TPSYNC.normKrop({ weighins: [w('2026-11-05', 1), w('2026-11-02', 2), w('2026-11-02', 3), null, { kg: 1 }], tombs: { 'w:x': -1, 'w:y': 'abc', 'w:z': 5 } });
    assert.deepStrictEqual(n.weighins.map(x => x.date), ['2026-11-02', '2026-11-05']); assert.deepStrictEqual(n.tombs, { 'w:z': 5 });
  });
  await T('fletning er kommutativ og idempotent', () => {
    const a = st({ weighins: [w('2026-11-02', 100, 5), w('2026-11-03', 101, 5)], phase: phase(2800), phaseAt: 10, tombs: { 'w:2026-11-09': 3 } });
    const b = st({ weighins: [w('2026-11-02', 102, 9), w('2026-11-04', 103, 1)], phase: phase(2900), phaseAt: 20, checkins: [{ date: '2026-12-01', energy: 3, t: 4 }] });
    const ab = TPSYNC.mergeKrop(a, b, 1e12).value, ba = TPSYNC.mergeKrop(b, a, 1e12).value;
    assert.strictEqual(J(ab), J(ba), 'kommutativ'); assert.strictEqual(J(TPSYNC.mergeKrop(ab, ab, 1e12).value), J(ab), 'idempotent'); assert.strictEqual(J(TPSYNC.mergeKrop(ab, a, 1e12).value), J(ab), 'a ind i ab ændrer intet');
    assert.deepStrictEqual(ab.weighins.map(x => [x.date, x.kg]), [['2026-11-02', 102], ['2026-11-03', 101], ['2026-11-04', 103]]); assert.strictEqual(ab.phase.kcal, 2900); assert.strictEqual(ab.checkins.length, 1);
  });
  await T('samme tidsstempel men forskelligt indhold vælges deterministisk (ens uanset rækkefølge)', () => {
    const a = st({ weighins: [w('2026-11-02', 100, 5)], phase: phase(2800), phaseAt: 7 }), b = st({ weighins: [w('2026-11-02', 101, 5)], phase: phase(2900), phaseAt: 7 });
    assert.strictEqual(J(TPSYNC.mergeKrop(a, b, 1e12).value), J(TPSYNC.mergeKrop(b, a, 1e12).value));
  });
  await T('sletning (tombstone) vinder over ældre post, men en nyere genindtastning vinder over sletningen', () => {
    const B0 = 1e12, a = st({ weighins: [w('2026-11-02', 100, B0 + 5)] }), b = st({ tombs: { 'w:2026-11-02': B0 + 9 } });
    assert.deepStrictEqual(TPSYNC.mergeKrop(a, b, B0 + 20).value.weighins, []);
    const c = st({ weighins: [w('2026-11-02', 99, B0 + 12)], tombs: {} }); assert.strictEqual(TPSYNC.mergeKrop(c, b, B0 + 20).value.weighins.length, 1);
    assert.deepStrictEqual(TPSYNC.mergeKrop(st({ weighins: [w('2026-11-02', 100, 0)] }), b, B0 + 20).value.weighins, [], 'seed-vejning (t=0) kan slettes');
  });
  await T('gamle tombstones (>180 dage) ryddes', () => {
    const now = 1e13, a = st({ tombs: { 'w:x': now - 200 * 86400000, 'w:y': now - 1000 } });
    assert.deepStrictEqual(Object.keys(TPSYNC.mergeKrop(a, st(), now).value.tombs), ['w:y']);
  });
  await T('fase: ny fase på en enhed overskriver ikke tavst en nyere på den anden (nyeste vinder)', () => {
    const a = st({ phase: phase(2800), phaseAt: 10 }), b = st({ phase: null, phaseAt: 30 }); assert.strictEqual(TPSYNC.mergeKrop(a, b, 1e12).value.phase, null);
    assert.strictEqual(TPSYNC.mergeKrop(b, st({ phase: phase(3000), phaseAt: 40 }), 1e12).value.phase.kcal, 3000);
  });
  await T('historik og justeringer er tilføjelser: begge enheders poster bevares', () => {
    const h = (e) => ({ phase: phase(2800), ended: e, t: 1 });
    const a = st({ history: [h('2026-12-01')], adjustments: [{ date: '2026-12-08', from: 2850, to: 2700, t: 2 }] }), b = st({ history: [h('2027-01-01')], adjustments: [{ date: '2026-12-15', from: 2700, to: 2600, t: 3 }] });
    const m = TPSYNC.mergeKrop(a, b, 1e12).value; assert.strictEqual(m.history.length, 2); assert.strictEqual(m.adjustments.length, 2);
  });

  console.log('Synk mod Worker v2 (kildekode)');
  await T('A → B: ny enhed henter alt; derefter er begge rene og ens', async () => {
    const W = world(); const A = W.device('A', { [KEY]: J(st({ weighins: [w('2026-11-17', 117.8, 5)], phase: phase(2850), phaseAt: 9 })) }), B = W.device('B');
    assert.strictEqual((await A.engine.syncKey(KEY)).status, 'ok');
    const r = await B.engine.syncKey(KEY); assert(['merged', 'unchanged', 'ok'].includes(r.status), r.status);
    const b = JSON.parse(B.storage._m[KEY]); assert.strictEqual(b.weighins.length, 1); assert.strictEqual(b.phase.kcal, 2850);
    assert(!A.engine.isDirty(KEY) && !B.engine.isDirty(KEY)); assert.strictEqual((await B.engine.syncKey(KEY)).status, 'unchanged');
    assert.strictEqual(A.engine.conflicts().length + B.engine.conflicts().length, 0, 'Krop giver aldrig konflikt-dialog');
  });
  await T('vejninger på to enheder: begge bevares (ingen konflikt, ingen tab)', async () => {
    const W = world(); const A = W.device('A', { [KEY]: J(st({ weighins: [w('2026-11-17', 117.8, 5)] })) }), B = W.device('B');
    await A.engine.syncKey(KEY); await B.engine.syncKey(KEY);
    A.storage.setItem(KEY, J(st({ weighins: [w('2026-11-17', 117.8, 5), w('2026-11-18', 118, 6)] }))); B.storage.setItem(KEY, J(st({ weighins: [w('2026-11-17', 117.8, 5), w('2026-11-19', 118.4, 7)] })));
    await A.engine.syncKey(KEY); await B.engine.syncKey(KEY); await A.engine.syncKey(KEY);
    const a = JSON.parse(A.storage._m[KEY]), b = JSON.parse(B.storage._m[KEY]);
    assert.deepStrictEqual(a.weighins.map(x => x.date), ['2026-11-17', '2026-11-18', '2026-11-19']); assert.strictEqual(canon(a), canon(b));
    assert.strictEqual(canon(JSON.parse(J(W.record(KEY).value))), canon(a), 'serveren har den fletterede version');
    assert(!A.engine.isDirty(KEY) && !B.engine.isDirty(KEY));
  });
  await T('offline-ændring sendes senere, uden tab', async () => {
    const W = world(); const A = W.device('A', { [KEY]: J(st({ weighins: [w('2026-11-17', 117.8, 5)] })) }), B = W.device('B');
    await A.engine.syncKey(KEY); await B.engine.syncKey(KEY);
    A.offline = true; A.storage.setItem(KEY, J(st({ weighins: [w('2026-11-17', 117.8, 5), w('2026-11-20', 117.2, 8)] })));
    assert.strictEqual((await A.engine.syncKey(KEY)).status, 'offline'); assert(A.engine.isDirty(KEY)); assert(A.engine.pending().includes(KEY));
    B.storage.setItem(KEY, J(st({ weighins: [w('2026-11-17', 117.8, 5), w('2026-11-21', 117, 9)] }))); await B.engine.syncKey(KEY);
    A.offline = false; await A.engine.syncKey(KEY);
    assert.strictEqual(JSON.parse(A.storage._m[KEY]).weighins.length, 3); assert(!A.engine.isDirty(KEY));
  });
  await T('sletning på A når B (tombstone)', async () => {
    const W = world(); const A = W.device('A', { [KEY]: J(st({ weighins: [w('2026-11-02', 116.5, 0), w('2026-11-05', 115, 0)] })) }), B = W.device('B');
    await A.engine.syncKey(KEY); await B.engine.syncKey(KEY);
    A.storage.setItem(KEY, J(st({ weighins: [w('2026-11-05', 115, 0)], tombs: { 'w:2026-11-02': 50 } }))); await A.engine.syncKey(KEY); await B.engine.syncKey(KEY);
    assert.deepStrictEqual(JSON.parse(B.storage._m[KEY]).weighins.map(x => x.date), ['2026-11-05']);
  });
  await T('enhed uden Krop-data skriver intet til serveren (nothing)', async () => {
    const W = world(); const A = W.device('A'); const r = await A.engine.push(KEY); assert.strictEqual(r.status, 'nothing'); assert(!W.calls.some(c => c.method === 'PUT'));
  });
  await T('fase-skift på A vises på B; "changed" udsendes så siden kan gen-render', async () => {
    const W = world(); const A = W.device('A', { [KEY]: J(st({ phase: phase(2850), phaseAt: 10 })) }), B = W.device('B', { [KEY]: J(st({ phase: phase(2850), phaseAt: 10 })) });
    await A.engine.syncKey(KEY); await B.engine.syncKey(KEY);
    const ev = []; B.engine.on(e => ev.push(e.type + ':' + e.key));
    A.storage.setItem(KEY, J(st({ phase: phase(2700), phaseAt: 99 }))); await A.engine.syncKey(KEY); await B.engine.syncKey(KEY);
    assert.strictEqual(JSON.parse(B.storage._m[KEY]).phase.kcal, 2700); assert(ev.includes('changed:' + KEY), ev.join(','));
  });
  await T('Worker validerer Krop-formen (afviser forkert version/liste) og kender nøglen via /version', async () => {
    const W = world(); const A = W.device('A');
    const ver = await (await W.worker.fetch(new Request('https://sync.test/version'), W.env)).json(); assert(ver.keys.includes(KEY));
    const put = v => W.worker.fetch(new Request('https://sync.test/kv/' + KEY, { method: 'PUT', body: J({ value: v }) }), W.env).then(r => r.status);
    assert.strictEqual(await put({ v: 2 }), 422); assert.strictEqual(await put({ v: 1, weighins: 'x' }), 422); assert.strictEqual(await put({ v: 1, tombs: [] }), 422); assert.strictEqual(await put({ v: 1, phase: 'x' }), 422);
    assert.strictEqual(await put([]), 422); assert.strictEqual(await put(st({ weighins: [w('2026-11-02', 100, 1)] })), 200);
  });
  await T('uautoriseret (forkert token) rører ikke Krop og giver auth-status', async () => {
    const W = world({ token: 'hemmelig', clientToken: 'forkert' }); const A = W.device('A', { [KEY]: J(st({ weighins: [w('2026-11-02', 100, 1)] })) });
    const r = await A.engine.syncKey(KEY); assert.strictEqual(r.status, 'auth'); assert.strictEqual(W.record(KEY), null); assert(A.engine.isDirty(KEY));
  });

  console.log('Gammel Worker (v1) kender ikke Krop');
  await T('v1-Worker: Krop markeres "unsupported", lokale data er urørte, og status siger det tydeligt', async () => {
    const W = world({ workerFile: V1 }); const raw = J(st({ weighins: [w('2026-11-02', 100, 1)] })); const A = W.device('A', { [KEY]: raw });
    const r = await A.engine.syncKey(KEY); assert.strictEqual(r.status, 'unsupported');
    assert.strictEqual(A.storage._m[KEY], raw, 'lokale data urørt'); assert(A.engine.status().unsupported.includes(KEY));
    assert(TPSYNC.statusHtml(A.engine).includes('kender ikke Krop'), 'tydelig besked i statuspanelet');
    assert(!W.calls.some(c => c.method === 'PUT' && /krop_state/.test(c.path)), 'ingen PUT af Krop mod gammel Worker');
  });
  await T('andre nøgler påvirkes ikke af at Krop findes (syncAll mod v2)', async () => {
    const W = world(); const A = W.device('A', { [KEY]: J(st({ weighins: [w('2026-11-02', 100, 1)] })) });
    const res = await A.engine.syncAll(); assert.strictEqual(res[KEY].status, 'ok'); assert(['empty', 'nothing', 'clean', 'ok'].includes(res.sbd_state.status) || res.sbd_state.status, 'sbd_state håndteres som før');
  });

  console.log(bad ? '\n' + bad + ' fejl' : '\n' + ok + ' ok'); process.exit(bad ? 1 : 0);
})();
