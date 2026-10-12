// Kør:  TZ=Europe/Copenhagen node tests/lob.test.js
// Indlæser <script> fra lob/index.html i et stub-miljø (uden init/DOM) og tester kernelogik.
const fs = require('fs'), path = require('path'), assert = require('assert');
const html = fs.readFileSync(path.join(__dirname, '..', 'lob', 'index.html'), 'utf8');
let code = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
code = code.replace(/\ninit\(\)\.catch\([\s\S]*$/, '\n'); // start ikke appen

const mem = {};
global.localStorage = { getItem: k => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: k => { delete mem[k]; } };
const el = () => ({ innerHTML: '', style: {}, value: '', files: [], classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {} });
global.document = { getElementById: el, querySelectorAll: () => [], addEventListener() {}, createElement: el, body: el() };
global.window = global; global.navigator = { userAgent: 'node' };

require('vm').runInThisContext(code, { filename: 'lob/index.html' }); // let/function lægges i global scope

const tests = [];
const T = (name, fn) => tests.push([name, fn]);

T('localDateStr bruger lokal dato (ikke UTC)', () => {
  assert.strictEqual(localDateStr(new Date(2026, 9, 9, 0, 30)), '2026-10-09');
  assert.strictEqual(localDateStr(new Date(2026, 0, 1, 23, 59)), '2026-01-01');
});
T('getWeekStart giver mandag for alle ugens dage', () => {
  const days = ['2026-10-05','2026-10-06','2026-10-07','2026-10-08','2026-10-09','2026-10-10','2026-10-11'];
  days.forEach(d => assert.strictEqual(getWeekStart(d), '2026-10-05', d));
  assert.strictEqual(getWeekStart('2026-10-12'), '2026-10-12');
});
T('getWeekStart krydser skiftet til vintertid (25. okt 2026)', () => {
  assert.strictEqual(getWeekStart('2026-10-25'), '2026-10-19');
  assert.strictEqual(getWeekStart('2026-10-26'), '2026-10-26');
});
T('VDOT: 20 min / 4,5 km ≈ 43,7 (håndregnet)', () => {
  const v = vdotFromDistanceTime(4.5, 20);
  assert(Math.abs(v - 43.73) < 0.1, 'vdot=' + v);
});
T('VDOT 40 → racetider i Daniels-området', () => {
  const f = (m) => predictRacePace(40, m).totalSec / 60;
  assert(Math.abs(f(5000) - 24.5) < 1.5, '5k ' + f(5000));
  assert(Math.abs(f(10000) - 50.8) < 2.5, '10k ' + f(10000));
  assert(Math.abs(f(21097.5) - 112) < 5, 'half ' + f(21097.5));
});
T('Racetid vokser monotont med distance og VDOT', () => {
  assert(predictRacePace(40, 10000).totalSec > predictRacePace(40, 5000).totalSec);
  assert(predictRacePace(50, 10000).totalSec < predictRacePace(40, 10000).totalSec);
});
T('paceZones er korrekt ordnet (let langsommere end rep-tempo)', () => {
  state = defaultState(); activeProfile = 'main';
  state.runs.push({ id: 'a', date: '2026-10-01', distanceKm: 4.5, durationSec: 1200, avgHR: 160, maxHR: 175, elev: 0 });
  const z = paceZones();
  assert(z.easyHi < z.easyLo, 'easyHi (hurtig ende) skal være færre sek/km end easyLo');
  assert(z.easyHi > z.marathon && z.marathon > z.threshold && z.threshold > z.interval && z.interval > z.repetition);
});
T('paceZones/computeVDOT = null uden egnede løb', () => {
  state = defaultState(); activeProfile = 'main';
  assert.strictEqual(computeVDOT(), null);
  assert.strictEqual(paceZones(), null);
  state.runs.push({ id: 'b', date: '2026-10-01', distanceKm: 1.5, durationSec: 600, avgHR: null, maxHR: null, elev: 0 });
  assert.strictEqual(computeVDOT(), null, 'løb < 15 min eller < 2 km tæller ikke');
});
T('parseWorkoutStructure: reps/tid/pause/opvarmning', () => {
  const s = parseWorkoutStructure('Varm op 10 min. 4 x 4 min hårdt med 2 min pause.');
  assert.deepStrictEqual([s.reps, s.workSec, s.restSec, s.warmupMin], [4, 240, 120, 10]);
  const m = parseWorkoutStructure('6 x 400 m, 90 sek pause');
  assert.deepStrictEqual([m.reps, m.workMeters, m.restSec], [6, 400, 90]);
  const none = parseWorkoutStructure('Fartlek efter fornemmelse');
  assert.strictEqual(none.reps, null);
});
T('estimateSessionKm: tal ved struktur, null ved ustruktureret', () => {
  const km = estimateSessionKm('6 x 400 m, 90 sek pause', 300, 360);
  assert(km > 2.4 && km < 4, 'km=' + km);
  assert.strictEqual(estimateSessionKm('Fartlek efter fornemmelse', 300, 360), null);
});
T('fmtPace formatterer og afviser ugyldigt', () => {
  assert.strictEqual(fmtPace(312), '5:12/km');
  assert.strictEqual(fmtPace(0), '—');
  assert.strictEqual(fmtPace(NaN), '—');
});
T('checkRunPlausibility: fejl vs. advarsler', () => {
  state = defaultState(); activeProfile = 'main'; state.profile.maxHR = 190;
  const ok = checkRunPlausibility({ distanceKm: 5, durationSec: 1500, avgHR: 150, maxHR: 170, elev: 20, date: '2026-10-01' });
  assert.deepStrictEqual([ok.errors.length, ok.warnings.length], [0, 0]);
  assert(checkRunPlausibility({ distanceKm: 5, durationSec: 1500, avgHR: 150, maxHR: 235 }).errors.length > 0);
  assert(checkRunPlausibility({ distanceKm: 5, durationSec: 1500, avgHR: 180, maxHR: 170 }).errors.length > 0);
  assert(checkRunPlausibility({ distanceKm: 5, durationSec: 60 }).warnings.length > 0, 'for hurtigt tempo');
  assert(checkRunPlausibility({ distanceKm: 5, durationSec: 1500, avgHR: 200 }).warnings.length > 0, 'over profilens maxpuls');
  assert(checkRunPlausibility({ distanceKm: 5, durationSec: 1500, date: '2999-01-01' }).warnings.length > 0, 'fremtid');
});
T('isValidLobState afviser beskadiget backup', () => {
  const good = { profile: {}, runs: [{ date: '2026-10-01', distanceKm: 5, durationSec: 1500 }] };
  assert(isValidLobState(good));
  assert(!isValidLobState(null));
  assert(!isValidLobState({ profile: {}, runs: [{ date: 'i går', distanceKm: 5, durationSec: 1500 }] }));
  assert(!isValidLobState({ profile: {}, runs: [{ date: '2026-10-01', distanceKm: -1, durationSec: 1500 }] }));
  assert(!isValidLobState({ profile: {}, runs: 'x' }));
});
T('Backup-roundtrip: adoptState migrerer manglende felter', () => {
  const old = { profile: { maxHR: 190 }, runs: [] };
  const s = adoptState('lob_state', old);
  assert.deepStrictEqual(s.weekPlanOverrides, {});
  assert(s.profile.raceGoal && s.profile.raceGoal.active === false);
});
T('Sync: header kun med token', () => {
  localStorage.removeItem('sync_token');
  assert.strictEqual(syncHeaders().Authorization, undefined);
  localStorage.setItem('sync_token', 'abc');
  assert.strictEqual(syncHeaders({ 'Content-Type': 'x' }).Authorization, 'Bearer abc');
  assert.strictEqual(syncHeaders({ 'Content-Type': 'x' })['Content-Type'], 'x');
  localStorage.removeItem('sync_token');
});

// Worker-auth testes separat (ren funktion i worker.js)
const wsrc = fs.readFileSync(path.join(__dirname, '..', 'sync-worker', 'worker.js'), 'utf8').replace('export default', 'const __default =');
const W = new Function(wsrc + '\nreturn {isAuthorized, safeEqual, handler: __default};')();
const req = (h) => ({ headers: { get: (k) => (h && h[k]) || null } });
T('Worker: åben uden SYNC_TOKEN, lukket med', () => {
  assert(W.isAuthorized(req({}), {}));
  assert(!W.isAuthorized(req({}), { SYNC_TOKEN: 's3cret' }));
  assert(!W.isAuthorized(req({ Authorization: 'Bearer forkert' }), { SYNC_TOKEN: 's3cret' }));
  assert(!W.isAuthorized(req({ Authorization: 's3cret' }), { SYNC_TOKEN: 's3cret' }));
  assert(W.isAuthorized(req({ Authorization: 'Bearer s3cret' }), { SYNC_TOKEN: 's3cret' }));
});
T('Worker: 401 uden token, 200 med token (hele handler)', async () => {
  const kv = { get: async () => null, put: async () => {} };
  const env = { SYNC_TOKEN: 'k', TRAINING_KV: kv };
  const mk = (auth) => ({ method: 'GET', url: 'https://x.dev/kv/lob_state', headers: { get: (h) => (h === 'Authorization' ? auth : null) } });
  assert.strictEqual((await W.handler.fetch(mk(null), env)).status, 401);
  assert.strictEqual((await W.handler.fetch(mk('Bearer k'), env)).status, 200);
});

(async () => {
  let fail = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log('  ok   ' + name); }
    catch (e) { fail++; console.log('  FEJL ' + name + '\n       ' + (e.message || e)); }
  }
  console.log(fail ? `\n${fail} test(s) fejlede` : `\nAlle ${tests.length} tests bestået`);
  process.exit(fail ? 1 : 0);
})();
