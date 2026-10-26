// Tests for fase 2: øvelsesskift (regler), alternativbibliotek og evaluering. Kør: node tests/tp-substitution.test.js
const assert = require('assert'), path = require('path');
const TP = require(path.join(__dirname, '..', 'tp-core.js'));
let ok = 0, bad = 0;
const T = (n, f) => { try { f(); ok++; console.log('  ok   ' + n); } catch (e) { bad++; console.log('  FEJL ' + n + '\n       ' + (e.stack || e).toString().split('\n').slice(0, 3).join('\n       ')); } };

const mkState = () => ({ logs: { day5: { exercises: [
  { name: 'Squat', sets: [{ kg: 100, reps: 5, done: false }, { kg: 100, reps: 5, done: false }] },
  { name: 'Leg Extension', sets: [{ kg: 40, reps: 12, done: false }] }] } } });
const plan = [
  { name: 'Squat', type: 'primary', warmup: true, scheme: { sets: 2, reps: 5, kg: 100, pct: 80, isRampBack: true, rampCeilingKg: 90 } },
  { name: 'Leg Extension', type: 'acc', scheme: { sets: 1, reps: 12, kg: 40 } }];

console.log('tp-substitution');
T('alle bibliotekposter har højst 2 alternativer; uden alternativer kræver begrundelse', () => {
  Object.keys(TP.ALT_LIB).forEach(k => {
    const L = TP.ALT_LIB[k];
    assert(L.alts.length <= 2, k);
    if (!L.alts.length) assert(L.noAltWhy, k + ' mangler noAltWhy');
    L.alts.forEach(a => { assert(a.n && a.w && a.g && a.p, k + ' → ' + a.n + ' mangler felter'); assert.notStrictEqual(a.n, k); });
  });
});
T('hovedløft har 2 alternativer og er beskyttede; Jefferson Curl har ingen', () => {
  ['Squat', 'Bench Press', 'Deadlift (Conv.)'].forEach(n => assert.strictEqual(TP.altsFor(n).alts.length, 2, n));
  const j = TP.altsFor('Jefferson Curl'); assert.strictEqual(j.alts.length, 0); assert(j.noAltWhy);
  assert(TP.isProtectedType('primary') && TP.isProtectedType('backdown') && !TP.isProtectedType('acc'));
});
T('baseName: suffikser slår op på samme post', () => {
  assert.strictEqual(TP.baseName('Squat — Backdown'), 'Squat');
  assert.deepStrictEqual(TP.altsFor('Squat — Backdown').alts.map(a => a.name), TP.altsFor('Squat').alts.map(a => a.name));
});
T('1RM-forsøg kan ikke substitueres', () => { const r = TP.altsFor('Deadlift — 1RM Forsøg'); assert.strictEqual(r.alts.length, 0); assert(/1RM/.test(r.noAltWhy)); });
T('ukendt øvelse: ingen opfundne alternativer', () => {
  const r = TP.altsFor('Helt Ukendt Øvelse'); assert.strictEqual(r.alts.length, 0); assert(r.noAltWhy);
});
T('muscle-mapping dækker alle alternativer', () => {
  Object.keys(TP.ALT_LIB).forEach(k => TP.ALT_LIB[k].alts.forEach(a => assert(TP.MUSCLE_EXTRA[a.n], a.n)));
});
T('custom override: max 2, kan fjernes, påvirker kun den øvelse', () => {
  const st = mkState();
  TP.setAltOverride(st, 'Leg Extension', ['A', 'B', 'C']);
  const r = TP.altsFor('Leg Extension', st); assert(r.custom); assert.strictEqual(r.alts.length, 2);
  assert.strictEqual(TP.altsFor('Squat', st).custom, false);
  TP.setAltOverride(st, 'Leg Extension', []); assert(!TP.altsFor('Leg Extension', st).custom);
});
T('skift kun-i-dag: navn = udført, plannedName bevaret, vægt ikke overført', () => {
  const st = mkState();
  const r = TP.switchLogExercise(st, 'day5', 0, 'Squat', 'Front Squat', 'session', 1000);
  assert(r.ok); const e = st.logs.day5.exercises[0];
  assert.strictEqual(e.name, 'Front Squat'); assert.strictEqual(e.plannedName, 'Squat');
  e.sets.forEach(s => assert.strictEqual(s.kg, '')); assert(!st.exerciseSubs || !st.exerciseSubs.Squat);
});
T('skift blokeret efter første gennemførte sæt', () => {
  const st = mkState(); st.logs.day5.exercises[0].sets[0].done = true;
  const r = TP.switchLogExercise(st, 'day5', 0, 'Squat', 'Front Squat', 'session'); assert(!r.ok);
  assert.strictEqual(st.logs.day5.exercises[0].name, 'Squat');
});
T('skift tilbage til primær rydder plannedName', () => {
  const st = mkState();
  TP.switchLogExercise(st, 'day5', 0, 'Squat', 'Front Squat', 'session');
  TP.switchLogExercise(st, 'day5', 0, 'Squat', 'Squat', 'session');
  const e = st.logs.day5.exercises[0]; assert.strictEqual(e.name, 'Squat'); assert(!('plannedName' in e)); assert(!('sub' in e));
});
T('future scope gemmer exerciseSubs; tilbage fjerner den', () => {
  const st = mkState();
  TP.switchLogExercise(st, 'day5', 1, 'Leg Extension', 'Sissy Squat', 'future', Date.UTC(2026, 9, 26, 10));
  assert.strictEqual(st.exerciseSubs['Leg Extension'].to, 'Sissy Squat');
  TP.switchLogExercise(st, 'day5', 1, 'Leg Extension', 'Leg Extension', 'future');
  assert(!st.exerciseSubs['Leg Extension']);
});
T('applySubstitutions: ren, ingen vægtoverførsel, alternativets EGEN historik bruges', () => {
  const st = mkState(); TP.switchLogExercise(st, 'day5', 0, 'Squat', 'Front Squat', 'session');
  const before = JSON.stringify(plan);
  const out = TP.applySubstitutions(plan, { log: st.logs.day5, lastPerf: n => n === 'Front Squat' ? { kg: 70, reps: 5 } : null });
  assert.strictEqual(JSON.stringify(plan), before, 'input muteret');
  assert.strictEqual(out[0].name, 'Front Squat'); assert.strictEqual(out[0].plannedName, 'Squat');
  assert.strictEqual(out[0].scheme.kg, 70); assert(!('pct' in out[0].scheme)); assert(!out[0].scheme.isRampBack);
  assert.strictEqual(out[0].warmup, false); assert(out[0].protectedSub);
  assert.strictEqual(out[1].name, 'Leg Extension'); // andre øvelser urørt
});
T('applySubstitutions: alternativ uden historik giver tom vægt, ikke primærens', () => {
  const st = mkState(); TP.switchLogExercise(st, 'day5', 0, 'Squat', 'Safety Bar Squat', 'session');
  const out = TP.applySubstitutions(plan, { log: st.logs.day5, lastPerf: () => null });
  assert.strictEqual(out[0].scheme.kg, '');
});
T('applySubstitutions: permanent sub bruges kun når der ikke er log', () => {
  const subs = { 'Leg Extension': { to: 'Sissy Squat', since: '2026-10-01' } };
  assert.strictEqual(TP.applySubstitutions(plan, { subs, log: null })[1].name, 'Sissy Squat');
  const log = { exercises: [{ name: 'Squat' }, { name: 'Leg Extension' }] };
  assert.strictEqual(TP.applySubstitutions(plan, { subs, log })[1].name, 'Leg Extension');
});
T('sessionSubstitutions rapporterer kun reelle skift', () => {
  const st = mkState(); TP.switchLogExercise(st, 'day5', 0, 'Squat', 'Front Squat', 'session');
  assert.deepStrictEqual(TP.sessionSubstitutions(st.logs.day5), [{ planned: 'Squat', actual: 'Front Squat', scope: 'session' }]);
});
T('migration beholder substitutioner (idempotent)', () => {
  const st = mkState(); TP.switchLogExercise(st, 'day5', 0, 'Squat', 'Front Squat', 'session');
  TP.migrateSbd(st, 'main'); const a = JSON.stringify(st); TP.migrateSbd(st, 'main'); assert.strictEqual(JSON.stringify(st), a);
  assert.strictEqual(st.logs.day5.exercises[0].plannedName, 'Squat');
});

console.log('evaluering');
T('normalizeEval: tom → null; clamp og filtrering', () => {
  assert.strictEqual(TP.normalizeEval({}), null); assert.strictEqual(TP.normalizeEval(null), null);
  const e = TP.normalizeEval({ effort: 14, energy: 3, vs: 'rod', pain: ['Knæ', 'Knæ', 'Hjerne'], comment: ' hej   du ' }, 5);
  assert.strictEqual(e.effort, null); assert.strictEqual(e.energy, 3); assert.strictEqual(e.vs, null);
  assert.deepStrictEqual(e.pain, ['Knæ']); assert.strictEqual(e.comment, 'hej du'); assert.strictEqual(e.ts, 5);
});
T('normalizeEval: kommentar kappes ved 500', () => {
  assert.strictEqual(TP.normalizeEval({ comment: 'x'.repeat(900) }).comment.length, 500);
});
T('evalPattern: under 3 svar → ingen konklusioner (ét dårligt pas ændrer intet)', () => {
  assert.strictEqual(TP.evalPattern([{ vs: 'harder', energy: 1, effort: 10, pain: ['Knæ'] }, { vs: 'harder', energy: 1 }]).notes.length, 0);
});
T('evalPattern: gentagne mønstre giver forsigtige noter uden diagnose', () => {
  const l = [{ vs: 'harder', energy: 2, pain: ['Skulder'] }, { vs: 'harder', energy: 1, pain: ['Skulder'] }, { vs: 'harder', energy: 2 }, { vs: 'as', energy: 4 }];
  const r = TP.evalPattern(l); assert(r.notes.length >= 3);
  assert(r.notes.some(n => /ikke en diagnose/.test(n)));
});
console.log(`\n${ok} bestået, ${bad} fejlet`); process.exit(bad ? 1 : 0);
