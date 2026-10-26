// Tests for tp-plan.js (fase 3): kalenderoverlay, hybrid belastningsregler, forslag. Kør: node tests/tp-plan.test.js
const assert = require('assert'), path = require('path');
const TP = require(path.join(__dirname, '..', 'tp-core.js'));
const P = require(path.join(__dirname, '..', 'tp-plan.js'));
let ok = 0, bad = 0;
const T = (n, f) => { try { f(); ok++; console.log('  ok   ' + n); } catch (e) { bad++; console.log('  FEJL ' + n + '\n       ' + (e.stack || e).toString().split('\n').slice(0, 3).join('\n       ')); } };

const TODAY = '2026-10-26'; // mandag
const sbd = (id, label, o) => Object.assign({ id, kind: 'sbd', status: 'planned', label, lower: false, hinge: false, hard: false }, o);
const run = (id, label, o) => Object.assign({ id, kind: 'run', status: 'planned', label, hard: false, long: false }, o);
const LOWER = id => sbd(id, 'Lower', { lower: true, hard: true });
const DL = id => sbd(id, 'B&B', { lower: true, hinge: true, hard: true });
const UPPER = id => sbd(id, 'CST');
const HARD = id => run(id, 'Løb (kvalitet)', { hard: true, load: 'hard' });
const EASY = id => run(id, 'Let løb', { load: 'easy' });
// plan: { 'YYYY-MM-DD': [items] }
const mk = (plan, n, changes, blockedExtra) => P.buildDays({ from: TODAY, days: n || 14, changes: changes || [], plannedFn: d => (plan[d] || []).map(x => Object.assign({}, x)), doneFn: () => [] });
const keys = f => f.map(x => x.key);

console.log('tp-plan: overlay');
T('moveRun flytter kun planlagt løb og markerer movedFrom; styrke urørt', () => {
  const plan = { '2026-10-27': [LOWER('s1'), HARD('r1')] };
  const days = mk(plan, 7, [{ id: 'c1', type: 'moveRun', from: '2026-10-27', to: '2026-10-29' }]);
  const d27 = days.find(d => d.date === '2026-10-27'), d29 = days.find(d => d.date === '2026-10-29');
  assert.deepStrictEqual(d27.items.map(i => i.id), ['s1']); assert.deepStrictEqual(d29.items.map(i => i.id), ['r1']); assert.strictEqual(d29.items[0].movedFrom, '2026-10-27');
});
T('forældet ændring (intet løb den dag) ignoreres og rapporteres som stale', () => {
  const days = mk({}, 7, [{ id: 'cX', type: 'moveRun', from: '2026-10-27', to: '2026-10-28' }]);
  assert.deepStrictEqual(days.stale, ['cX']); assert(days.every(d => !d.items.length));
});
T('easyRun / skipRun / swapRun', () => {
  const plan = { '2026-10-27': [HARD('r1')], '2026-10-29': [EASY('r2')] };
  let days = mk(plan, 7, [{ id: 'a', type: 'easyRun', date: '2026-10-27' }]);
  assert.strictEqual(days[1].items[0].hard, false); assert.strictEqual(days[1].items[0].label, 'Let løb');
  days = mk(plan, 7, [{ id: 'b', type: 'skipRun', date: '2026-10-27' }]); assert.strictEqual(days[1].items[0].status, 'skipped');
  days = mk(plan, 7, [{ id: 'c', type: 'swapRun', a: '2026-10-27', b: '2026-10-29' }]);
  assert.strictEqual(days[1].items[0].id, 'r2'); assert.strictEqual(days[3].items[0].id, 'r1');
});
T('overlay muterer ikke inputdata', () => {
  const plan = { '2026-10-27': [HARD('r1')] }; const before = JSON.stringify(plan);
  mk(plan, 7, [{ id: 'c', type: 'easyRun', date: '2026-10-27' }]); assert.strictEqual(JSON.stringify(plan), before);
});

console.log('tp-plan: regler');
T('R1: tung benstyrke + hårdt løb samme dag / ±1 dag flagges; let løb ikke', () => {
  let f = P.analyze(mk({ '2026-10-27': [LOWER('s'), HARD('r')] }), { today: TODAY });
  assert(keys(f).includes('R1:2026-10-27:2026-10-27'));
  f = P.analyze(mk({ '2026-10-27': [LOWER('s')], '2026-10-28': [HARD('r')] }), { today: TODAY }); assert(keys(f).includes('R1:2026-10-27:2026-10-28'));
  f = P.analyze(mk({ '2026-10-27': [LOWER('s')], '2026-10-28': [EASY('r')] }), { today: TODAY }); assert(!f.some(x => x.rule === 'R1'));
  f = P.analyze(mk({ '2026-10-27': [LOWER('s')], '2026-10-30': [HARD('r')] }), { today: TODAY }); assert(!f.some(x => x.rule === 'R1'), '2+ dages afstand er ok');
  f = P.analyze(mk({ '2026-10-27': [UPPER('s')], '2026-10-27x': [] , '2026-10-28': [HARD('r')] }), { today: TODAY }); assert(!f.some(x => x.rule === 'R1'), 'overkrop er ikke et benkonflikt');
});
T('R1: deload-benstyrke (hard=false) flagges ikke; sprunget over tæller ikke', () => {
  let f = P.analyze(mk({ '2026-10-27': [Object.assign(LOWER('s'), { hard: false }), HARD('r')] }), { today: TODAY }); assert(!f.some(x => x.rule === 'R1'));
  const sk = Object.assign(LOWER('s'), { status: 'skipped' });
  f = P.analyze(mk({ '2026-10-27': [sk, HARD('r')] }), { today: TODAY }); assert(!f.some(x => x.rule === 'R1'));
});
T('R2: dødløft ±1 dag fra LANGT løb', () => {
  const lg = Object.assign(HARD('r'), { long: true });
  let f = P.analyze(mk({ '2026-10-27': [DL('s')], '2026-10-28': [lg] }), { today: TODAY }); assert(f.some(x => x.rule === 'R2'));
  f = P.analyze(mk({ '2026-10-27': [DL('s')], '2026-10-28': [EASY('r')] }), { today: TODAY }); assert(!f.some(x => x.rule === 'R2'));
});
T('R3: 3 intensive dage i træk flagges, 2 gør ikke', () => {
  const p3 = { '2026-10-27': [LOWER('a')], '2026-10-28': [HARD('b')], '2026-10-29': [DL('c')] };
  assert(P.analyze(mk(p3), { today: TODAY }).some(x => x.rule === 'R3'));
  const p2 = { '2026-10-27': [LOWER('a')], '2026-10-28': [HARD('b')], '2026-10-30': [DL('c')] };
  assert(!P.analyze(mk(p2), { today: TODAY }).some(x => x.rule === 'R3'));
});
T('R3b: 5+ dage i træk uden restitutionsdag er kun info; roligt løb tæller som restitution', () => {
  const easyOnly = {}; for (let i = 0; i < 7; i++) easyOnly[TP.addDays('2026-10-26', i)] = [EASY('e' + i)];
  assert(!P.analyze(mk(easyOnly), { today: TODAY }).some(x => x.rule === 'R3b' || x.rule === 'R5'), 'kun roligt løb = ingen advarsel');
  const p = {}; for (let i = 0; i < 6; i++) p[TP.addDays('2026-10-26', i)] = [UPPER('e' + i)];
  const f = P.analyze(mk(p), { today: TODAY }).filter(x => x.rule === 'R3b'); assert.strictEqual(f.length, 1); assert.strictEqual(f[0].level, 'info');
});
T('R4: løbevolumen +30 % og ≥4 km over snit flagges; lille absolut stigning ikke', () => {
  const wk = TP.weekStart(TODAY), w = i => TP.addDays(wk, -7 * i);
  const ctx = km => ({ today: TODAY, weekly: { runKm: { [wk]: km, [w(1)]: 20, [w(2)]: 20, [w(3)]: 20 } } });
  assert(P.analyze(mk({}), ctx(27)).some(x => x.rule === 'R4'));
  assert(!P.analyze(mk({}), ctx(25)).some(x => x.rule === 'R4'));
  const small = { today: TODAY, weekly: { runKm: { [wk]: 6, [w(1)]: 4, [w(2)]: 4 } } }; assert(!P.analyze(mk({}), small).some(x => x.rule === 'R4'), '+50 % men kun +2 km');
  const few = { today: TODAY, weekly: { runKm: { [wk]: 40, [w(1)]: 10 } } }; assert(!P.analyze(mk({}), few).some(x => x.rule === 'R4'), 'for lidt historik');
});
T('R5: hel uge uden restitutionsdag flagges', () => {
  const p = {}; for (let i = 0; i < 7; i++) p[TP.addDays(TODAY, i)] = [UPPER('e' + i)];
  assert(P.analyze(mk(p, 14), { today: TODAY }).some(x => x.rule === 'R5'));
  p[TP.addDays(TODAY, 3)] = [EASY('x')]; assert(!P.analyze(mk(p, 14), { today: TODAY }).some(x => x.rule === 'R5'), 'roligt løb = restitution');
});
T('R6: kræver ≥3 svar OG ≥5 træningsdage; ellers intet', () => {
  const done = i => ({ id: 'd' + i, kind: 'run', status: 'done', label: 'Løb', hard: false });
  const mkDone = n => P.buildDays({ from: TP.addDays(TODAY, -6), days: 7, doneFn: d => (TP.diffDays(TP.addDays(TODAY, -6), d) < n ? [done(d)] : []), plannedFn: () => [] });
  const ep = { n: 4, notes: ['x'] };
  assert(P.analyze(mkDone(5), { today: TODAY, evalPattern: ep }).some(x => x.rule === 'R6'));
  assert(!P.analyze(mkDone(3), { today: TODAY, evalPattern: ep }).some(x => x.rule === 'R6'), 'for få træningsdage');
  assert(!P.analyze(mkDone(5), { today: TODAY, evalPattern: { n: 2, notes: ['x'] } }).some(x => x.rule === 'R6'), 'for få svar');
  assert(!P.analyze(mkDone(5), { today: TODAY, evalPattern: { n: 4, notes: [] } }).some(x => x.rule === 'R6'));
});
T('R7: tung benstyrke 3 dage før løbsmål og hårdt løb 1–2 dage før', () => {
  const race = { date: '2026-11-01', label: 'Halvmarathon' };
  let f = P.analyze(mk({ '2026-10-29': [LOWER('s')] }), { today: TODAY, races: [race] }); assert(f.some(x => x.rule === 'R7'));
  f = P.analyze(mk({ '2026-10-30': [HARD('r')] }), { today: TODAY, races: [race] }); assert(f.some(x => x.rule === 'R7'));
  f = P.analyze(mk({ '2026-10-27': [LOWER('s')] }), { today: TODAY, races: [race] }); assert(!f.some(x => x.rule === 'R7'), '5 dage før er ok');
});
T('afviste/ignorerede fund markeres dismissed og tæller ikke som advarsler', () => {
  const days = mk({ '2026-10-27': [LOWER('s'), HARD('r')] });
  const k = 'R1:2026-10-27:2026-10-27';
  const f = P.analyze(days, { today: TODAY, dismissed: { [k]: { at: 1 } } });
  assert(f.find(x => x.key === k).dismissed); assert.strictEqual(P.warnCount(f), 0);
});
T('hvert fund har forklaring, konsekvens og fakta', () => {
  P.analyze(mk({ '2026-10-27': [LOWER('s'), HARD('r')] }), { today: TODAY }).forEach(f => { assert(f.title && f.why && f.consequence && f.facts.length, f.key); });
});

console.log('tp-plan: forslag');
const rebuilderFor = (plan, base) => (extra, blocked) => mk(plan, 14, (base || []).concat(extra.map((c, i) => Object.assign({ id: 'x' + i }, c))));
T('forslag flytter løb til dag uden nyt konflikt; ændrer aldrig automatisk', () => {
  const plan = { '2026-10-27': [LOWER('s'), HARD('r')] };
  const ctx = { today: TODAY, analyzeCtx: { today: TODAY }, rebuild: rebuilderFor(plan), focus: 'balanced' };
  const f = P.analyze(mk(plan), { today: TODAY })[0];
  const opts = P.suggest(f, ctx); assert(opts.length > 0 && opts.length <= 3);
  opts.forEach(o => { assert(o.consequence); assert(o.after < o.before); });
  assert(opts.some(o => o.change.type === 'moveRun'));
  const mv = opts.find(o => o.change.type === 'moveRun');
  const after = P.analyze(rebuilderFor(plan)([mv.change], []), { today: TODAY }); assert(!after.some(x => x.key === f.key));
  assert.strictEqual(P.analyze(mk(plan), { today: TODAY }).length, 1, 'planen er uændret indtil brugeren godkender');
});
T('Ellen (faste løbedage): ingen moveRun-forslag', () => {
  const plan = { '2026-10-27': [LOWER('s'), HARD('r')] };
  const ctx = { today: TODAY, analyzeCtx: { today: TODAY }, rebuild: rebuilderFor(plan), runsFixed: true };
  const opts = P.suggest(P.analyze(mk(plan), { today: TODAY })[0], ctx); assert(opts.every(o => o.change.type !== 'moveRun'));
});
T('fokus styrke: tunge styrkepas foreslås aldrig rykket', () => {
  const plan = { '2026-10-27': [LOWER('s'), HARD('r')] };
  const ctx = { today: TODAY, analyzeCtx: { today: TODAY }, rebuild: rebuilderFor(plan), focus: 'strength' };
  assert(P.suggest(P.analyze(mk(plan), { today: TODAY })[0], ctx).every(o => o.change.type !== 'skipSbd'));
});
T('fokus løb tæt på løbsmål: hårdt løb gøres ikke let; styrke rykkes', () => {
  const plan = { '2026-10-29': [HARD('r')], '2026-10-30': [LOWER('s')] };
  const race = { date: '2026-11-08', label: 'Løb' };
  const ctx = { today: TODAY, analyzeCtx: { today: TODAY, races: [race] }, rebuild: (e, blocked) => { const p2 = JSON.parse(JSON.stringify(plan)); (blocked || []).forEach(b => { const mv = (p2[b] || []).filter(x => x.kind === 'sbd'); p2[b] = (p2[b] || []).filter(x => x.kind !== 'sbd'); const nx = TP.addDays(b, 1); p2[nx] = (p2[nx] || []).concat(mv); }); return mk(p2, 14, e.filter(c => c.type !== 'skipSbd').map((c, i) => Object.assign({ id: 'x' + i }, c))); }, focus: 'run', raceNear: d => TP.diffDays(d, race.date) <= 14 };
  const opts = P.suggest(P.analyze(mk(plan), { today: TODAY, races: [race] }).find(f => f.rule === 'R1'), ctx);
  assert(opts.every(o => o.change.type !== 'easyRun')); assert(opts.some(o => o.change.type === 'skipSbd'));
  assert(opts.find(o => o.change.type === 'skipSbd').because);
});
T('ingen forslag der skaber flere advarsler', () => {
  const plan = { '2026-10-27': [LOWER('s'), HARD('r')], '2026-10-28': [DL('s2')], '2026-10-29': [HARD('r2')] };
  const ctx = { today: TODAY, analyzeCtx: { today: TODAY }, rebuild: rebuilderFor(plan) };
  const base = P.warnCount(P.analyze(mk(plan), { today: TODAY }));
  P.analyze(mk(plan), { today: TODAY }).forEach(f => P.suggest(f, ctx).forEach(o => assert(o.after < base || f.level !== 'warn')));
});

console.log('tp-plan: overblik');
T('overview tæller uden samlet score', () => {
  const days = P.buildDays({ from: TP.addDays(TODAY, -6), days: 7, doneFn: d => d === '2026-10-24' ? [Object.assign(LOWER('s'), { status: 'done' }), Object.assign(HARD('r'), { status: 'done', km: 6 })] : (d === '2026-10-22' ? [Object.assign(EASY('e'), { status: 'done', km: 5 })] : []), plannedFn: () => [] });
  const o = P.overview(days, TODAY, 7);
  assert.deepStrictEqual([o.strengthSessions, o.heavyLower, o.runs, o.runKm, o.hardRuns, o.trainingDays, o.restDays, o.sameDayHard], [1, 1, 2, 11, 1, 2, 5, 1]);
  assert(!('score' in o));
});
T('classifyRun: hård via puls, langt via distance; ellers let', () => {
  assert.strictEqual(P.classifyRun({ distanceKm: 6, avgHR: 170 }, { maxHR: 190 }).hard, true);
  assert.strictEqual(P.classifyRun({ distanceKm: 6, avgHR: 140 }, { maxHR: 190 }).hard, false);
  assert.strictEqual(P.classifyRun({ distanceKm: 16, avgHR: 140 }, { maxHR: 190, medianKm: 8 }).long, true);
  assert.strictEqual(P.classifyRun({ distanceKm: 7, avgHR: 0 }, {}).hard, false);
});
T('ændringslog: tilføj/fjern (fortryd) og beskrivelse', () => {
  const meta = TP.defaultMeta(); const c = P.newChange({ type: 'moveRun', from: '2026-10-27', to: '2026-10-29' }, 5);
  P.addChange(meta, c); assert.strictEqual(meta.planChanges.length, 1); assert(/flyttet/.test(P.describe(c)));
  P.removeChange(meta, c.id); assert.strictEqual(meta.planChanges.length, 0);
});
console.log(`\n${ok} bestået, ${bad} fejlet`); process.exit(bad ? 1 : 0);
