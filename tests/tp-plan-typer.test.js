// Problem B: konfliktregler skelner mellem styrke- og løbetyper. Kør: node tests/tp-plan-typer.test.js
const assert = require('assert'), path = require('path');
const P = require(path.join(__dirname, '..', 'tp-plan.js'));
let ok = 0, bad = 0;
const T = (n, f) => { try { f(); ok++; console.log('  ok   ' + n); } catch (e) { bad++; console.log('  FEJL ' + n + '\n       ' + (e.stack || e).toString().split('\n').slice(0, 3).join('\n       ')); } };
const TODAY = '2026-10-26';
const S = (cid, o) => Object.assign({ id: 's-' + cid, kind: 'sbd', status: 'planned', label: cid, cycleId: cid }, P.sbdFlags(cid, o));
const R = (id, o) => Object.assign({ id, kind: 'run', status: 'planned', label: 'Løb', hard: false, long: false, load: 'easy', kindLabel: '', confidence: 'middel', limits: [] }, o);
const HARD = id => R(id, { hard: true, load: 'hard', kindLabel: 'Tempo/intervaller', confidence: 'lav', limits: ['skøn'] });
const LONG = id => R(id, { long: true, hard: false, load: 'long', kindLabel: 'Langt løb', confidence: 'høj' });
const days = plan => P.buildDays({ from: TODAY, days: 14, changes: [], plannedFn: d => (plan[d] || []).map(x => Object.assign({}, x)), doneFn: () => [] });
const rules = plan => P.analyze(days(plan), { today: TODAY, weekly: { runKm: {}, sbdSets: {} }, evalPattern: { n: 0 }, dismissed: {}, races: [] });
const ids = f => f.map(x => x.rule).sort();

console.log('Styrketyper (programmets egen cyklus)');
T('cyklus-typer: tung vs. teknik vs. overkrop', () => {
  assert.strictEqual(P.sbdFlags('low1').hard, true); assert.strictEqual(P.sbdFlags('bb1').hinge, true);
  const low2 = P.sbdFlags('low2'); assert.strictEqual(low2.hard, false); assert.strictEqual(low2.moderateLower, true); assert.strictEqual(low2.lowerLoad, 'moderate');
  const bb2 = P.sbdFlags('bb2'); assert.strictEqual(bb2.hard, false); assert.strictEqual(bb2.hinge, true);
  assert.strictEqual(P.sbdFlags('cst1').lower, false); assert.strictEqual(P.sbdFlags('cst2').lower, false);
});
T('deload og Ellen: aldrig "tung"', () => {
  assert.strictEqual(P.sbdFlags('low1', { deload: true }).hard, false); assert.strictEqual(P.sbdFlags('low1', { heavyOk: false }).hard, false);
  assert.strictEqual(P.sbdFlags('bb1', { deload: true }).lowerLoad, 'light');
});
T('ukendt cyklus-id giver ingen påstande (ingen opfundet belastning)', () => {
  const f = P.sbdFlags('xyz'); assert.strictEqual(f.lower, false); assert.strictEqual(f.hard, false); assert.strictEqual(f.mainLift, null);
});

console.log('Løbetyper');
T('classifyRun: puls ≥ 80 % = hårdt, 70–80 = jævnt, < 70 = roligt; lang og race overstyrer', () => {
  const ctx = { maxHR: 190, medianKm: 5 };
  assert.strictEqual(P.classifyRun({ distanceKm: 5, avgHR: 160 }, ctx).hard, true);
  const st = P.classifyRun({ distanceKm: 5, avgHR: 140 }, ctx); assert.strictEqual(st.kind, 'steady'); assert.strictEqual(st.hard, false);
  assert.strictEqual(P.classifyRun({ distanceKm: 5, avgHR: 120 }, ctx).kind, 'easy');
  assert.strictEqual(P.classifyRun({ distanceKm: 12, avgHR: 120 }, ctx).long, true);
  const race = P.classifyRun({ distanceKm: 10, avgHR: 120, date: '2026-11-01' }, Object.assign({ raceDate: '2026-11-01' }, ctx)); assert.strictEqual(race.kind, 'race'); assert.strictEqual(race.hard, true);
});
T('uden puls: "ukendt", regnes roligt, lav sikkerhed og begrænsning angivet (ingen opfundet intensitet)', () => {
  const k = P.classifyRun({ distanceKm: 5 }, { maxHR: 0, medianKm: 5 });
  assert.strictEqual(k.kind, 'unknown'); assert.strictEqual(k.hard, false); assert.strictEqual(k.confidence, 'lav'); assert(k.limits.length);
});
T('plannedRunKind: deload → roligt; Base → lang jævn (ikke hård); Build → tempo; Peak → intervaller; Taper → let', () => {
  assert.strictEqual(P.plannedRunKind({ phase: 'Build', isDeload: true }).hard, false);
  const base = P.plannedRunKind({ phase: 'Base', isDeload: false, posInBlock: 2 }); assert.strictEqual(base.kind, 'long'); assert.strictEqual(base.hard, false); assert.strictEqual(base.long, true);
  assert.strictEqual(P.plannedRunKind({ phase: 'Build', isDeload: false, posInBlock: 7 }).kind, 'tempo');
  assert.strictEqual(P.plannedRunKind({ phase: 'Peak', isDeload: false, posInBlock: 11 }).kind, 'interval');
  assert.strictEqual(P.plannedRunKind({ phase: 'Taper', isDeload: false }).hard, false);
  assert.strictEqual(P.plannedRunKind({ phase: 'Peak', isDeload: false, posInBlock: 10, raceMode: false }).kind, 'test');
  assert.strictEqual(P.plannedRunKind({ phase: 'Base', isDeload: false }).confidence, 'lav');
});
T('plannedRunKind uden løbeprofil: antager hårdt men lav sikkerhed', () => {
  const k = P.plannedRunKind(null); assert.strictEqual(k.hard, true); assert.strictEqual(k.confidence, 'lav');
});
T('phaseFor: uden profil/seasonStart → null; med seasonStart giver fase og deload hver 4. uge', () => {
  assert.strictEqual(P.phaseFor(null, TODAY), null); assert.strictEqual(P.phaseFor({}, TODAY), null);
  const p = { seasonStart: '2026-10-05' };
  assert.strictEqual(P.phaseFor(p, '2026-10-05').phase, 'Base'); assert.strictEqual(P.phaseFor(p, '2026-10-26').isDeload, true); assert.strictEqual(P.phaseFor(p, '2026-10-19').isDeload, false);
});

console.log('Konfliktregler pr. type');
T('R1: tung squat + hårdt løb samme dag → advarsel (høj alvor); dagen efter → moderat', () => {
  const same = rules({ '2026-10-27': [S('low1'), HARD('r')] }).filter(f => f.rule === 'R1');
  assert.strictEqual(same.length, 1); assert.strictEqual(same[0].level, 'warn'); assert.strictEqual(same[0].sev, 'høj');
  const next = rules({ '2026-10-27': [S('low1')], '2026-10-28': [HARD('r')] }).filter(f => f.rule === 'R1');
  assert.strictEqual(next[0].sev, 'moderat');
});
T('R1b: teknik-squat (box squat 3×3) + hårdt løb → kun info, ingen R1-advarsel', () => {
  const f = rules({ '2026-10-27': [S('low2'), HARD('r')] });
  assert(!f.some(x => x.rule === 'R1')); const b = f.filter(x => x.rule === 'R1b'); assert.strictEqual(b.length, 1); assert.strictEqual(b[0].level, 'info'); assert.strictEqual(b[0].sev, 'lav');
});
T('R2: tung dødløft + langt løb → advarsel; R2b: deficit-dødløft (teknik) + langt løb → info', () => {
  const a = rules({ '2026-10-27': [S('bb1')], '2026-10-28': [LONG('r')] });
  assert(a.some(x => x.rule === 'R2' && x.level === 'warn'));
  const b = rules({ '2026-10-27': [S('bb2')], '2026-10-28': [LONG('r')] });
  assert(!b.some(x => x.rule === 'R2')); assert(b.some(x => x.rule === 'R2b' && x.level === 'info'));
});
T('overkropsdag (CST) + hårdt løb → ingen benkonflikt', () => {
  const f = rules({ '2026-10-27': [S('cst1'), HARD('r')] }); assert(!f.some(x => /^R(1|1b|2|2b)$/.test(x.rule)), ids(f).join());
});
T('roligt løb + tung squat → ingen konflikt (kun hårde/lange løb tæller)', () => {
  const f = rules({ '2026-10-27': [S('low1'), R('r')] }); assert(!f.some(x => /^R(1|1b|2|2b)$/.test(x.rule)));
});
T('R8: to tunge benpas dagen efter hinanden → advarsel; to hårde løb dagen efter hinanden → advarsel', () => {
  assert(rules({ '2026-10-27': [S('low1')], '2026-10-28': [S('bb1')] }).some(x => x.rule === 'R8'));
  assert(rules({ '2026-10-27': [HARD('a')], '2026-10-28': [HARD('b')] }).some(x => x.rule === 'R8'));
  assert(!rules({ '2026-10-27': [S('low1')], '2026-10-29': [S('bb1')] }).some(x => x.rule === 'R8'), 'rolig dag imellem');
});
T('forklarbarhed: hver konklusion har alvor, begrundelse, "bygger på", begrænsninger og alternativer kan beregnes', () => {
  const f = rules({ '2026-10-27': [S('low1'), HARD('r')] }).filter(x => x.level === 'warn');
  assert(f.length); f.forEach(x => { assert(x.sev && x.sevWhy, 'sev ' + x.rule); assert(x.basedOn.length >= 2, 'basedOn ' + x.rule); assert(x.limits.length, 'limits ' + x.rule); assert(x.why && x.consequence); });
  const hasPlannedLimit = f.some(x => x.limits.some(l => /skøn|klassificeret/.test(l))); assert(hasPlannedLimit, 'planlagt løb markeret som skøn');
});
T('analyze ændrer aldrig dagene/planen (ren funktion)', () => {
  const d = days({ '2026-10-27': [S('low1'), HARD('r')] }); const before = JSON.stringify(d);
  P.analyze(d, { today: TODAY, weekly: { runKm: {}, sbdSets: {} }, evalPattern: { n: 0 }, dismissed: {}, races: [] }); assert.strictEqual(JSON.stringify(d), before);
});
T('Ellens pas: benpas er moderate (aldrig tunge), øvrige lette/ingen; deload → let; egne labels og ingen hovedløft', () => {
  const f = (id, o) => P.sbdFlags(id, Object.assign({ heavyOk: false }, o || {}));
  ['low1', 'low2'].forEach(id => { const x = f(id); assert.strictEqual(x.lowerLoad, 'moderate'); assert.strictEqual(x.hard, false); assert.strictEqual(x.moderateLower, true); assert.strictEqual(x.mainLift, null); });
  assert.strictEqual(f('low1', { deload: true }).lowerLoad, 'light');
  assert.strictEqual(f('bb1').lowerLoad, 'light'); assert.strictEqual(f('cst1').lowerLoad, 'none');
  ['cst1', 'low1', 'bb1', 'cst2', 'low2', 'bb2'].forEach(id => assert(f(id).kindLabel && !/Tung|dødløft|bænk|squat/i.test(f(id).kindLabel), id + ': ' + f(id).kindLabel));
  assert.strictEqual(P.sbdFlags('low1', { heavyOk: true }).lowerLoad, 'heavy'); // Olivers uændret
});
console.log(`\n${bad ? bad + ' FEJL, ' : ''}${ok} ok`); process.exit(bad ? 1 : 0);
