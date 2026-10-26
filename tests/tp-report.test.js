// Tests for fase 4: månedsrapport (tp-report.js) og målprioritering (tp-plan.js FOCUS). Kør: node tests/tp-report.test.js
const assert = require('assert'), path = require('path');
const TP = require(path.join(__dirname, '..', 'tp-core.js'));
const P = require(path.join(__dirname, '..', 'tp-plan.js'));
const R = require(path.join(__dirname, '..', 'tp-report.js'));
let ok = 0, bad = 0;
const T = (n, f) => { try { f(); ok++; console.log('  ok   ' + n); } catch (e) { bad++; console.log('  FEJL ' + n + '\n       ' + (e.stack || e).toString().split('\n').slice(0, 3).join('\n       ')); } };
const ts = (iso, h) => new Date(iso + 'T' + (h || '17:00') + ':00').getTime();

// Syntetisk SBD-state: dag N → dato via sessionTimes. cyklus: 0 cst1,1 low1,2 rest,3 bb1,4 cst2,5 rest,6 low2,7 bb2
function sbdState(sessions) { // [{day, date, exs:[{name,kg,reps}]}]
  const s = { totalDays: 40, completedDays: [], logs: {}, sessionTimes: {}, sessionEval: {} };
  sessions.forEach(x => { s.completedDays.push(x.day); s.logs['day' + x.day] = { exercises: x.exs.map(e => ({ name: e.name, sets: Array.from({ length: e.sets || 3 }, () => ({ kg: e.kg, reps: e.reps, done: true })) })) };
    s.sessionTimes['day' + x.day] = { sessionStart: ts(x.date, '16:00'), end: ts(x.date, '17:05') }; if (x.eval) s.sessionEval['day' + x.day] = x.eval; });
  return s;
}
const run = (date, km, min, o) => Object.assign({ id: 'r' + date + km, date, distanceKm: km, durationSec: Math.round(min * 60) }, o || {});

console.log('tp-report');
T('månedsgrænser og navigation', () => {
  assert.deepStrictEqual(R.monthRange('2026-02'), { first: '2026-02-01', last: '2026-02-28', days: 28 });
  assert.strictEqual(R.prevMonth('2026-01'), '2025-12'); assert.strictEqual(R.nextMonth('2025-12'), '2026-01'); assert.strictEqual(R.monthLabel('2026-10'), 'oktober 2026');
});
T('tæller kun pas i måneden; pausedage tælles ikke; løb summeres', () => {
  const sbd = sbdState([{ day: 0, date: '2026-09-28', exs: [{ name: 'Bench Press', kg: 100, reps: 5 }] }, { day: 1, date: '2026-10-02', exs: [{ name: 'Squat', kg: 140, reps: 5 }] }, { day: 2, date: '2026-10-03', exs: [] }, { day: 3, date: '2026-10-05', exs: [{ name: 'Deadlift (Conv.)', kg: 180, reps: 3 }] }]);
  const lob = { runs: [run('2026-10-01', 5, 30), run('2026-10-08', 10, 62), run('2026-09-30', 4, 25)], profile: {} };
  const r = R.build({ sbd, lob, today: '2026-11-05' }, '2026-10');
  assert.strictEqual(r.strength.sessions, 2, 'rest-dag (day 2) og september tæller ikke'); assert.strictEqual(r.running.runs, 2); assert.strictEqual(r.running.km, 15);
  assert.strictEqual(r.running.avgKm, 7.5); assert.strictEqual(r.overall.sessions, 4); assert.strictEqual(r.partial, false);
});
T('RP1: ny bedste e1RM vs. før måneden; substitution (andet navn) tæller ikke som hovedløft', () => {
  const sbd = sbdState([{ day: 1, date: '2026-09-20', exs: [{ name: 'Squat', kg: 130, reps: 5 }] }, { day: 6, date: '2026-10-10', exs: [{ name: 'Squat', kg: 140, reps: 5 }, { name: 'Front Squat', kg: 200, reps: 5 }] }]);
  const r = R.build({ sbd, lob: { runs: [] }, today: '2026-11-05' }, '2026-10');
  assert(r.conclusion.good.some(g => g.rule === 'RP1' && /Squat/.test(g.text)));
  const l = r.strength.lifts.sq; assert(l.monthBest > l.priorBest); assert(l.monthBest < 200, 'Front Squat må ikke blandes ind');
});
T('RN1: e1RM falder ≥3 % vs forrige måned', () => {
  const sbd = sbdState([{ day: 1, date: '2026-09-10', exs: [{ name: 'Squat', kg: 150, reps: 5 }] }, { day: 6, date: '2026-10-10', exs: [{ name: 'Squat', kg: 140, reps: 5 }] }]);
  assert(R.build({ sbd, lob: { runs: [] }, today: '2026-11-05' }, '2026-10').conclusion.regressed.some(x => x.rule === 'RN1'));
  const sbd2 = sbdState([{ day: 1, date: '2026-09-10', exs: [{ name: 'Squat', kg: 150, reps: 5 }] }, { day: 6, date: '2026-10-10', exs: [{ name: 'Squat', kg: 148, reps: 5 }] }]);
  assert(!R.build({ sbd: sbd2, lob: { runs: [] }, today: '2026-11-05' }, '2026-10').conclusion.regressed.some(x => x.rule === 'RN1'));
});
T('RP3/RN3: løbevolumen op gradvist / ned markant', () => {
  const mkLob = (sep, oct) => ({ runs: [run('2026-09-05', sep, sep * 6), run('2026-10-05', oct, oct * 6)] });
  assert(R.build({ sbd: sbdState([]), lob: mkLob(20, 23), today: '2026-11-05' }, '2026-10').conclusion.good.some(x => x.rule === 'RP3'));
  assert(R.build({ sbd: sbdState([]), lob: mkLob(40, 20), today: '2026-11-05' }, '2026-10').conclusion.regressed.some(x => x.rule === 'RN3'));
  assert(!R.build({ sbd: sbdState([]), lob: mkLob(8, 20), today: '2026-11-05' }, '2026-10').conclusion.good.some(x => x.rule === 'RP3'), 'for lille basis');
});
T('RP2/RN4: planlagt vs gennemført kun når planen kendes', () => {
  const sbd = sbdState([{ day: 0, date: '2026-10-02', exs: [{ name: 'Bench Press', kg: 100, reps: 5 }] }]);
  const lob = { runs: [run('2026-10-03', 5, 30), run('2026-10-06', 5, 30), run('2026-10-09', 5, 30)] };
  let r = R.build({ sbd, lob, planned: { sbd: 5, run: 5 }, today: '2026-11-05' }, '2026-10'); assert(r.conclusion.regressed.some(x => x.rule === 'RN4')); assert.strictEqual(r.overall.planned.completed, 4);
  r = R.build({ sbd, lob, planned: { sbd: 1, run: 3 }, today: '2026-11-05' }, '2026-10'); assert(r.conclusion.good.some(x => x.rule === 'RP2'));
  r = R.build({ sbd, lob, planned: null, today: '2026-11-05' }, '2026-10'); assert.strictEqual(r.overall.planned, null); assert(!r.conclusion.regressed.some(x => x.rule === 'RN4'));
});
T('løbende måned er "partial" og udløser ikke fald-/planregler', () => {
  const lob = { runs: [run('2026-09-05', 40, 240), run('2026-10-05', 5, 30)] };
  const r = R.build({ sbd: sbdState([]), lob, planned: { sbd: 5, run: 5 }, today: '2026-10-10' }, '2026-10');
  assert.strictEqual(r.partial, true); assert(!r.conclusion.regressed.some(x => ['RN2', 'RN3', 'RN4', 'RN7'].includes(x.rule)));
});
T('RN5: langsommere tempo kræver ≥3 løb i begge måneder', () => {
  const mk = (m, pace, n) => Array.from({ length: n }, (_, i) => run(m + '-' + String(5 + i * 3).padStart(2, '0'), 5, 5 * pace));
  const slow = { runs: mk('2026-09', 5.5, 3).concat(mk('2026-10', 6, 3)) }; // ~9 % langsommere
  assert(R.build({ sbd: sbdState([]), lob: slow, today: '2026-11-05' }, '2026-10').conclusion.regressed.some(x => x.rule === 'RN5'));
  const few = { runs: mk('2026-09', 5.5, 3).concat(mk('2026-10', 6, 2)) };
  assert(!R.build({ sbd: sbdState([]), lob: few, today: '2026-11-05' }, '2026-10').conclusion.regressed.some(x => x.rule === 'RN5'));
});
T('RN6/RP5: selvvurderinger — smerte kræver ≥2 omtaler; positivt mønster kræver ≥4 svar', () => {
  const ex = [{ name: 'Squat', kg: 100, reps: 5 }];
  const sbd = sbdState([{ day: 1, date: '2026-10-02', exs: ex, eval: { effort: 7, vs: 'as', pain: ['Knæ'] } }, { day: 3, date: '2026-10-05', exs: ex, eval: { effort: 6, vs: 'easier', pain: ['Knæ'] } }, { day: 4, date: '2026-10-07', exs: ex, eval: { effort: 6, vs: 'as' } }, { day: 6, date: '2026-10-09', exs: ex, eval: { effort: 5, vs: 'easier' } }]);
  const r = R.build({ sbd, lob: { runs: [] }, today: '2026-11-05' }, '2026-10');
  assert(r.conclusion.regressed.some(x => x.rule === 'RN6' && /Knæ/.test(x.text) && /ikke en diagnose/.test(x.text))); assert(r.conclusion.good.some(x => x.rule === 'RP5')); assert.strictEqual(r.evaluation.n, 4);
  const one = sbdState([{ day: 1, date: '2026-10-02', exs: ex, eval: { pain: ['Knæ'], vs: 'harder' } }]);
  const r1 = R.build({ sbd: one, lob: { runs: [] }, today: '2026-11-05' }, '2026-10'); assert(!r1.conclusion.regressed.some(x => x.rule === 'RN6'), 'én omtale er ikke et mønster');
});
T('RN7: lang pause; RP4: nåede mål', () => {
  const lob = { runs: [run('2026-10-02', 5, 30), run('2026-10-28', 5, 30)], profile: { goals: [{ id: 'g1', kind: 'weekKm', achievedDate: '2026-10-20' }] } };
  const r = R.build({ sbd: sbdState([]), lob, today: '2026-11-05' }, '2026-10');
  assert(r.conclusion.regressed.some(x => x.rule === 'RN7')); assert(r.conclusion.good.some(x => x.rule === 'RP4')); assert.strictEqual(r.goals.achieved.length, 1);
});
T('hvert udsagn har tekst; regel-udsagn har grundlag; ingen AI-påstand', () => {
  const sbd = sbdState([{ day: 1, date: '2026-09-10', exs: [{ name: 'Squat', kg: 150, reps: 5 }] }, { day: 6, date: '2026-10-10', exs: [{ name: 'Squat', kg: 140, reps: 5 }] }]);
  const r = R.build({ sbd, lob: { runs: [] }, today: '2026-11-05' }, '2026-10');
  [].concat(r.conclusion.good, r.conclusion.developed, r.conclusion.regressed).forEach(x => { assert(x.text); if (x.rule) assert(x.basis.length, x.rule); });
  assert.strictEqual(r.ruleBased, true); assert(/ingen AI/i.test(r.note)); assert(R.toText(r).indexOf('AI-genereret') < 0);
});
T('tom måned: ingen konklusioner opfindes', () => {
  const r = R.build({ sbd: sbdState([]), lob: { runs: [] }, today: '2026-11-05' }, '2026-10');
  assert.strictEqual(r.conclusion.good.length + r.conclusion.regressed.length, 0); assert(r.conclusion.developed.some(x => /For lidt data/.test(x.text)));
});
T('rapport er deterministisk og muterer ikke input', () => {
  const sbd = sbdState([{ day: 1, date: '2026-10-02', exs: [{ name: 'Squat', kg: 100, reps: 5 }] }]); const lob = { runs: [run('2026-10-03', 5, 30)] };
  const a = JSON.stringify({ sbd, lob }); const r1 = R.build({ sbd, lob, today: '2026-11-05' }, '2026-10', 1), r2 = R.build({ sbd, lob, today: '2026-11-05' }, '2026-10', 1);
  assert.strictEqual(JSON.stringify(r1), JSON.stringify(r2)); assert.strictEqual(JSON.stringify({ sbd, lob }), a);
});
T('eksport: tekst og HTML indeholder nøgletal, escaper tegn og er selvstændige', () => {
  const lob = { runs: [run('2026-10-03', 5, 30)], profile: { goals: [{ id: 'g<1>', kind: '<script>', achievedDate: '2026-10-20', title: '<b>x</b>' }] } };
  const r = R.build({ sbd: sbdState([]), lob, today: '2026-11-05' }, '2026-10');
  const h = R.toHtml(r), t = R.toText(r); assert(/Månedsrapport/.test(h) && !/<script>/.test(h) && !/<b>x<\/b>/.test(h)); assert(/LØB: 1 ture, 5 km/.test(t)); assert(!/https?:\/\//.test(h), 'ingen eksterne ressourcer');
});

console.log('målprioritering');
T('setFocus validerer og gemmer; ukendt fokus afvises', () => {
  const m = TP.defaultMeta(); P.setFocus(m, 'run', ['race', 'g1', 'g1', 5], Date.UTC(2026, 9, 26, 12));
  assert.deepStrictEqual(m.goalPriority, { focus: 'run', goalIds: ['race', 'g1'], since: '2026-10-26', at: Date.UTC(2026, 9, 26, 12) }); assert.throws(() => P.setFocus(m, 'nonsens', []));
  assert.strictEqual(P.focusKey({ goalPriority: { focus: 'xyz' } }), 'balanced');
});
T('hypertrofi bruger styrke-motoren (beskytter styrkepas); balanceret er standard', () => {
  assert.strictEqual(P.engineFocus({ goalPriority: { focus: 'hypertrophy' } }), 'strength'); assert.strictEqual(P.engineFocus(TP.defaultMeta()), 'balanced'); assert.strictEqual(P.engineFocus({ goalPriority: { focus: 'run' } }), 'run');
});
T('forklaring nævner effekt, tilknyttede mål og at planen ikke omskrives', () => {
  const m = TP.defaultMeta(); P.setFocus(m, 'run', ['race']); const e = P.explainFocus(m, { nearDate: '2026-11-08' });
  assert(e.lines.some(l => /1 mål/.test(l) && /08\/11/.test(l))); assert(e.lines.some(l => /omskrives aldrig/.test(l))); assert(e.label && e.short);
});
T('attachedDates: kun tilknyttede, ikke-nåede mål + løbsmål', () => {
  const m = TP.defaultMeta(); P.setFocus(m, 'run', ['g1', 'race']);
  assert.deepStrictEqual(P.attachedDates(m, [{ id: 'g1', deadline: '2026-12-01' }, { id: 'g2', deadline: '2026-12-02' }, { id: 'g3', deadline: '2026-12-03', achievedDate: 'x' }], '2026-11-08').sort(), ['2026-11-08', '2026-12-01']);
});
T('sortering: løbefokus løfter R7; styrkefokus løfter R1', () => {
  const f = [{ rule: 'R1', level: 'warn', dates: ['2026-10-27'] }, { rule: 'R7', level: 'warn', dates: ['2026-10-29'] }, { rule: 'R5', level: 'warn', dates: ['2026-10-26'] }];
  assert.strictEqual(P.sortFindings(f, 'run')[0].rule, 'R7'); assert.strictEqual(P.sortFindings(f, 'strength')[0].rule, 'R1');
  assert.strictEqual(P.sortFindings(f, 'balanced')[0].rule, 'R5');
});
console.log(`\n${ok} bestået, ${bad} fejlet`); process.exit(bad ? 1 : 0);
