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
global.TP = require('../tp-core.js'); global.TPSYNC = require('../tp-sync.js');

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
T('Sync: Authorization-header sendes kun med token (delt synk-motor)', async () => {
  const seen = [];
  const mk = (tok) => TPSYNC.create({ storage: global.localStorage, baseUrl: 'https://x.test', getToken: () => tok,
    fetch: async (u, o) => { seen.push((o && o.headers && o.headers.Authorization) || null); return { ok: true, status: 200, json: async () => ({ value: null, updatedAt: 0 }), headers: { get: () => '2' } }; } });
  await mk('').syncKey('lob_state'); await mk('abc').syncKey('lob_state');
  assert(seen.length >= 2 && seen[0] === null && seen[seen.length - 1] === 'Bearer abc', JSON.stringify(seen));
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

const R = (date, km, sec) => ({ id: date + km, date, distanceKm: km, durationSec: sec });
T('Mål: km pr. uge tæller kun indeværende uge (man–søn)', () => {
  const runs = [R('2026-10-04', 10, 3000), R('2026-10-05', 5, 1500), R('2026-10-11', 4, 1200), R('2026-10-12', 9, 2700)];
  const p = goalProgress({ kind: 'weekKm', target: 10 }, runs, '2026-10-08');
  assert.strictEqual(Math.round(p.cur), 9); assert.strictEqual(p.done, false);
  assert.strictEqual(p.validUntil, '2026-10-11');
  assert.strictEqual(goalProgress({ kind: 'weekKm', target: 9 }, runs, '2026-10-08').done, true);
});
T('Mål: km pr. måned og i år', () => {
  const runs = [R('2026-09-30', 20, 6000), R('2026-10-01', 5, 1500), R('2026-10-31', 5, 1500)];
  assert.strictEqual(goalProgress({ kind: 'monthKm', target: 10 }, runs, '2026-10-15').cur, 10);
  assert.strictEqual(goalProgress({ kind: 'monthKm', target: 10 }, runs, '2026-10-15').validUntil, '2026-10-31');
  assert.strictEqual(goalProgress({ kind: 'yearKm', target: 100 }, runs, '2026-10-15').cur, 30);
  assert.strictEqual(goalProgress({ kind: 'yearKm', target: 100 }, [R('2025-12-31', 50, 15000)], '2026-01-02').cur, 0);
});
T('Mål: længste tur og løb pr. uge', () => {
  const runs = [R('2026-10-05', 12, 4000), R('2026-10-07', 6, 2000), R('2026-10-09', 8, 2500)];
  assert.strictEqual(goalProgress({ kind: 'longest', target: 15 }, runs, '2026-10-10').cur, 12);
  assert.strictEqual(Math.round(goalProgress({ kind: 'longest', target: 15 }, runs, '2026-10-10').pct), 80);
  assert.strictEqual(goalProgress({ kind: 'weekRuns', target: 3 }, runs, '2026-10-10').done, true);
});
T('Mål: streak ignorerer ufærdig indeværende uge, brydes af tom uge', () => {
  const runs = [R('2026-09-21', 5, 1500), R('2026-09-23', 5, 1500), R('2026-09-28', 5, 1500), R('2026-09-30', 5, 1500)];
  // tirsdag i ny uge, kun 0 løb endnu → streak = 2 (ugerne 21/9 og 28/9)
  assert.strictEqual(goalProgress({ kind: 'streak', target: 4, perWeek: 2 }, runs, '2026-10-06').cur, 2);
  // uge 5/10 med 2 løb tæller med → 3
  const r2 = runs.concat([R('2026-10-05', 5, 1500), R('2026-10-06', 5, 1500)]);
  assert.strictEqual(goalProgress({ kind: 'streak', target: 4, perWeek: 2 }, r2, '2026-10-06').cur, 3);
  // hul i ugen 14/9 bryder ikke noget bagud: kun sammenhængende tæller
  const r3 = r2.concat([R('2026-09-08', 5, 1500), R('2026-09-09', 5, 1500)]);
  assert.strictEqual(goalProgress({ kind: 'streak', target: 4, perWeek: 2 }, r3, '2026-10-06').cur, 3);
});
T('Mål: tid på distance (5 km under 25:00) skalerer tæt-på-distancer', () => {
  const g = { kind: 'time', distKm: 5, targetSec: 1500 };
  let p = goalProgress(g, [R('2026-10-01', 5.0, 1560)], '2026-10-10');
  assert.strictEqual(p.done, false); assert.strictEqual(Math.round(p.pct), 96); assert.strictEqual(p.curLabel, '26:00');
  p = goalProgress(g, [R('2026-10-01', 5.0, 1560), R('2026-10-02', 5.1, 1500)], '2026-10-10'); // 5,1 km på 25:00 → ~24:30 pr. 5 km
  assert.strictEqual(p.done, true);
  p = goalProgress(g, [R('2026-10-01', 8, 1000)], '2026-10-10'); // for lang distance tæller ikke
  assert.strictEqual(p.curLabel, '—'); assert.strictEqual(p.pct, 0);
});
T('Mål: snittempo over mindste distance', () => {
  const g = { kind: 'pace', distKm: 8, targetSec: 330 }; // 5:30/km
  let p = goalProgress(g, [R('2026-10-01', 10, 3400), R('2026-10-02', 5, 1200)], '2026-10-10');
  assert.strictEqual(p.curLabel, '5:40/km'); assert.strictEqual(p.done, false); // 5 km-turen er for kort
  p = goalProgress(g, [R('2026-10-01', 8, 2600)], '2026-10-10');
  assert.strictEqual(p.done, true);
});
T('Mål: addGoal/removeGoal og validering', () => {
  state = defaultState(); activeProfile = 'main'; partnerState = defaultState();
  const vals = { 'gl-kind': 'time', 'gl-target': '', 'gl-extra': '5', 'gl-time': '25:00', 'gl-deadline': '' };
  document.getElementById = (id) => ({ value: vals[id] !== undefined ? vals[id] : '', style: {}, innerHTML: '', textContent: '' });
  global.alert = () => {}; global.confirm = () => true; global.renderAll = () => {};
  addGoal();
  assert.strictEqual(state.profile.goals.length, 1);
  assert.strictEqual(state.profile.goals[0].targetSec, 1500); assert.strictEqual(state.profile.goals[0].distKm, 5);
  vals['gl-time'] = '';
  addGoal(); assert.strictEqual(state.profile.goals.length, 1, 'ugyldigt mål afvises');
  assert.strictEqual(goalTitle(state.profile.goals[0]), '5 km under 25:00');
  const id = state.profile.goals[0].id;
  removeGoal(id); assert.strictEqual(state.profile.goals.length, 0);
});
T('Mål: loadState tilføjer goals til gamle states', () => {
  const old = defaultState(); delete old.profile.goals;
  localStorage.setItem('lob_state_x', JSON.stringify(old));
  assert.deepStrictEqual(loadState('lob_state_x').profile.goals, []);
});
T('Mål: renderGoals markerer nået mål (sticky) og gemmer dashboard-resumé', () => {
  state = defaultState(); activeProfile = 'main'; partnerState = defaultState();
  const today = localDateStr();
  state.runs = [R(today, 6, 1800)];
  state.profile.goals = [{ id: 'g1', kind: 'longest', target: 5, createdDate: today }, { id: 'g2', kind: 'weekKm', target: 50, createdDate: today }];
  document.getElementById = () => ({ innerHTML: '', style: {}, value: '' });
  renderGoals();
  assert(state.profile.goals[0].achievedDate, 'longest nået');
  assert(!state.profile.goals[1].achievedDate, 'periodisk mål markeres ikke permanent');
  const sum = JSON.parse(localStorage.getItem('lob_goals_summary_main'));
  assert.strictEqual(sum.goals.length, 1); assert.strictEqual(sum.goals[0].pct, 12);
  state.runs = []; renderGoals();
  assert(state.profile.goals[0].achievedDate, 'forbliver nået selv hvis løbet slettes');
});
T('Plan-justering: tryk én gang skubber planen og fjerner banneret (ingen dobbelt-skub)', () => {
  state = defaultState(); activeProfile = 'main'; partnerState = defaultState();
  document.getElementById = () => ({ innerHTML: '', style: {}, value: '', textContent: '' });
  global.alert = () => {}; global.renderAll = () => {};
  const old = new Date(); old.setDate(old.getDate() - 20);
  state.profile.seasonStart = '2026-01-05';
  state.runs = [R(localDateStr(old), 5, 1500)];
  assert(detectPlanGap(), 'hul opdaget');
  applyPlanAdjustment();
  const after = state.profile.seasonStart;
  assert.strictEqual(after, localDateStr(new Date(new Date('2026-01-05T00:00:00').setDate(5 + 20 - 0 + 0 - 0 + 0))) , 'skubbet 20 dage');
  assert.strictEqual(detectPlanGap(), null, 'banner væk efter skub');
  applyPlanAdjustment();
  assert.strictEqual(state.profile.seasonStart, after, 'andet tryk skubber ikke igen');
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
