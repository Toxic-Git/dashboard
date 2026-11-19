// Krop — beregningskerne (krop/krop-core.js). Ingen DOM, ingen netværk.
const K = require('../krop/krop-core.js');
let bad = 0; const ok = (c, m) => { if (!c) { bad++; console.log('  FEJL: ' + m); } }; const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m + ' — fik ' + JSON.stringify(a) + ', forventede ' + JSON.stringify(b));
const near = (a, b, t, m) => ok(Math.abs(a - b) <= t, m + ' — fik ' + a + ', forventede ca. ' + b);

// datoer
eq(K.addDays('2026-10-24', 2), '2026-10-26', 'addDays over sommertid'); eq(K.diffDays('2026-03-28', '2026-03-30'), 2, 'diffDays over sommertid');
eq(K.ageAt('2005-10-07', '2026-10-06'), 20, 'alder dagen før fødselsdag'); eq(K.ageAt('2005-10-07', '2026-10-07'), 21, 'alder på fødselsdag'); eq(K.ageAt('x', '2026-10-07'), null, 'alder ugyldig');

// BMR (Mifflin-St Jeor mand): 10*112.5 + 6.25*185 - 5*21 + 5 = 2181
eq(K.bmr({ kg: 112.5, heightCm: 185, age: 21 }), 2181, 'BMR 112,5 kg'); eq(K.bmr({ kg: 117.8, heightCm: 185, age: 21 }), 2234, 'BMR 117,8 kg');
eq(K.bmr({ kg: 'x', heightCm: 185, age: 21 }), null, 'BMR ugyldig'); eq(K.bmr(null), null, 'BMR null');

// vedligehold ~3.500–3.600 for Olivers profil
const mt = K.maintenance({ kg: 117.7, heightCm: 185, age: 21, steps: 16700, trainingKcalWeek: 1700 });
ok(mt.total >= 3400 && mt.total <= 3700, 'vedligehold i forventet område: ' + mt.total); ok(mt.low < mt.total && mt.total < mt.high, 'interval omkring vedligehold'); ok(mt.total % 50 === 0, 'vedligehold rundet til 50');
const mt0 = K.maintenance({ kg: 100, heightCm: 180, age: 30, steps: 0, trainingKcalWeek: 0 }); ok(mt0.total > mt0.bmr, 'vedligehold > BMR uden skridt');
eq(K.maintenance({ kg: 0, heightCm: 180, age: 30 }), null, 'vedligehold ugyldig');

// kalorie-mål
eq(K.targetKcal(3550, -20, 2234), 2850, 'cut −20 %'); eq(K.targetKcal(3550, 7.5, 2234), 3800, 'lean +7,5 %');
eq(K.targetKcal(2300, -25, 2234), 1750 < 2234 ? 2250 : 0, 'aldrig under BMR (rundet op til 50)'); ok(K.targetKcal(2300, -25, 2234) >= 2234, 'mål ≥ BMR');
eq(K.targetKcal(NaN, -20, 2000), null, 'targetKcal NaN');
near(K.pctOf(2850, 3550), -19.7, 0.1, 'pctOf');

// calibratedMaintenance: spiser 2850, taber 0,5 kg/uge → vedligehold ≈ 2850 + 550 = 3400
eq(K.calibratedMaintenance(2850, -0.5), 3400, 'kalibreret vedligehold (tab)'); eq(K.calibratedMaintenance(3000, 0.25), 2750, 'kalibreret vedligehold (stigning)');

// makroer
const m = K.macros({ kcal: 2850, kg: 117.7, fatPct: 33.9, phase: 'cut' });
ok(m.protein >= 170 && m.protein <= 200, 'protein 170–200 g i cut: ' + m.protein); eq(m.fat, 80, 'fedt ≈ 0,7 g/kg'); ok(m.carbs > 300 && m.carbs < 400, 'kulhydrat: ' + m.carbs);
near(m.protein * 4 + m.fat * 9 + m.carbs * 4, 2850, 8, 'makroer summer til kcal');
const mNoFat = K.macros({ kcal: 3000, kg: 100, phase: 'bulk' }); near(mNoFat.leanKg, 75, 0.1, 'uden fedt% → 75 % fedtfri'); eq(mNoFat.protein, 150, 'bulk protein 2,0 × lean');
const lowM = K.macros({ kcal: 1800, kg: 117.7, fatPct: 33.9, phase: 'cut' }); ok(lowM.carbs >= 0 && lowM.fat >= Math.round(117.7 * 0.6), 'lavt kcal: kulhydrat ≥ 0 og fedt ≥ minimum'); ok(lowM.lowCarb === true || lowM.carbs >= 100, 'lowCarb-flag');
eq(K.macros({ kcal: 'x', kg: 100 }), null, 'macros ugyldig');

// måltider
[2, 3, 4, 5, 6].forEach(n => {
  const ms = K.mealSplit(m, n); eq(ms.length, n, n + ' måltider');
  const sum = k => ms.reduce((s, x) => s + x[k], 0);
  eq(sum('protein'), m.protein, n + ': protein summer'); eq(sum('fat'), m.fat, n + ': fedt summer'); eq(sum('kcal'), m.kcal, n + ': kcal summer'); eq(sum('carbs'), m.carbs, n + ': kulhydrat summer');
  ms.forEach(x => ok(x.kcal > 0 && x.protein >= 0 && x.fat >= 0 && x.carbs >= 0, n + ': ingen negative tal'));
});
eq(K.mealSplit(m, 99).length, 6, 'måltider klemmes til 6'); eq(K.mealSplit(m, 1).length, 2, 'måltider klemmes til 2'); eq(K.mealSplit(null, 3), [], 'mealSplit null');
ok(K.mealSplit(m, 2).some(x => x.proteinHigh), '2 måltider → >60 g protein markeres'); ok(!K.mealSplit(m, 4).some(x => x.proteinHigh), '4 måltider → ingen markering');
eq(K.suggestedMeals('cut'), 3, 'cut forslag 3'); eq(K.suggestedMeals('lean'), 4, 'lean forslag 4'); eq(K.suggestedMeals('bulk'), 4, 'bulk forslag 4');

// vejninger og trend
const st = K.emptyState(); eq(st.weighins.length, 5, 'import af 5 vejninger'); eq(st.weighins[4], { date: '2026-11-17', kg: 117.8, fat: 33.9 }, 'seneste import');
eq(K.trend([], '2026-11-19'), null, 'trend uden data'); const t2 = K.trend([{ date: '2026-11-17', kg: 117 }, { date: '2026-11-18', kg: 117 }], '2026-11-19'); eq(t2.enough, false, 'trend kræver ≥ 3'); eq(t2.n, 2, 'n=2');
const lin = []; for (let i = 0; i < 14; i++) lin.push({ date: K.addDays('2026-12-01', i), kg: 100 - i * 0.1 });
const t3 = K.trend(lin, '2026-12-14'); eq(t3.enough, true, 'trend nok data'); near(t3.kgPerWeek, -0.7, 0.01, 'lineær hældning'); near(t3.fitted, 98.7, 0.05, 'udjævnet vægt'); near(t3.pctPerWeek, -0.71, 0.02, 'pct pr. uge');
const t4 = K.trend([{ date: '2026-12-01', kg: 100 }, { date: '2026-12-01', kg: 102 }, { date: '2026-12-03', kg: 101 }, { date: '2026-12-05', kg: 101 }], '2026-12-06'); eq(t4.n, 3, 'flere vejninger samme dag gennemsnitsberegnes');
eq(K.cleanWeighins([{ date: 'x', kg: 1 }, { date: '2026-01-01', kg: 5 }, { date: '2026-01-02', kg: '100,5' }, null]).length, 1, 'cleanWeighins fjerner ugyldige');
ok(K.trend([{ date: '2026-01-01', kg: 100 }, { date: '2026-01-02', kg: 100 }, { date: '2026-01-03', kg: 100 }], '2026-06-01').enough === false, 'gamle vejninger giver ikke trend i dag');

// kalibrering (pausedage tæller ikke)
const w5 = []; for (let i = 0; i < 6; i++) w5.push({ date: K.addDays('2026-11-30', i * 2), kg: 117 });
let c = K.calibration({ start: '2026-11-30', today: '2026-12-13', pauses: [], weighins: w5 }); eq(c.endDate, '2026-12-13', 'kalibrering slutter efter 14 dage'); eq(c.done, true, 'kalibrering færdig med ≥ 5 vejninger');
c = K.calibration({ start: '2026-11-30', today: '2026-12-13', pauses: [{ from: '2026-12-01', to: '2026-12-03' }], weighins: w5 }); eq(c.endDate, '2026-12-16', 'pausedage skubber kalibreringsslut'); eq(c.done, false, 'ikke færdig før pausedage er skubbet');
c = K.calibration({ start: '2026-11-30', today: '2026-12-20', pauses: [], weighins: [{ date: '2026-12-01', kg: 117 }, { date: '2026-12-05', kg: 117 }, { date: '2026-12-09', kg: 117 }] }); eq(c.needDays, 21, 'få vejninger → 3 uger'); eq(c.endDate, '2026-12-20', 'slutdato 3 uger'); eq(c.done, true, 'færdig efter 3 uger med 3 vejninger');
c = K.calibration({ start: '2026-11-30', today: '2026-12-20', pauses: [], weighins: [{ date: '2026-12-01', kg: 117 }] }); eq(c.done, false, 'mindst 3 vejninger'); eq(c.needMoreWeighins, true, 'needMoreWeighins');
eq(K.calibration({ start: 'x', today: '2026-12-01' }), null, 'kalibrering ugyldig');
eq(K.inPause([{ from: '2026-11-23', to: '2026-11-29' }], '2026-11-29'), true, 'pause slutdato inklusive'); eq(K.inPause(null, '2026-11-29'), false, 'inPause null');

// startPhase
const sp = K.startPhase(st, { type: 'cut', start: '2026-11-30', pct: -20, meals: 3 });
eq(sp.type, 'cut', 'fase type'); eq(sp.kcal, 2850, 'start-kcal cut'); eq(sp.meals, 3, 'måltider'); ok(sp.startKg > 117 && sp.startKg < 118.5, 'startvægt: ' + sp.startKg);
eq(K.startPhase(st, { type: 'cut', start: '2026-11-30', pct: -80, meals: 6 }).pct, -20, 'pct og måltider vælges automatisk (input ignoreres)'); eq(sp.meals, 3, 'cut: 3 måltider'); eq(sp.kcalStart, sp.kcal, 'kcalStart gemmes'); eq(K.startPhase(st, { type: 'nope', start: '2026-11-30' }), null, 'ukendt fase');
eq(K.startPhase({ profile: st.profile, weighins: [] }, { type: 'cut', start: '2026-11-30' }), null, 'ingen vejninger → ingen fase');
eq(K.startPhase(st, { type: 'bulk', start: '2026-11-30' }).pct, 15, 'bulk standard +15 %'); eq(K.startPhase(st, { type: 'maint', start: '2026-11-30' }).kcal, sp.maintenance, 'vedligehold = estimat');


// automatisk plan (kun type, vægt, evt. deadline, evt. målvægt)
const mtA = 3550;
let ap = K.autoPlan({ type: 'cut', kg: 117.7, maintenance: mtA, start: '2026-11-30' }); eq(ap.ok, true, 'autoPlan uden mål'); eq(ap.pct, -20, 'standard cut −20 %');
ap = K.autoPlan({ type: 'cut', kg: 117.7, maintenance: mtA, start: '2026-11-30', targetKg: 105, deadline: '2027-04-10' }); eq(ap.ok, true, 'autoPlan med mål+deadline');
ok(ap.pct <= -8 && ap.pct >= -25, 'pct inden for blød cut-grænse: ' + ap.pct); ok(ap.notes.length === 1, 'forklaring medfølger');
// realistisk: 12,7 kg på ~19 uger = ca. 0,57 %/uge → ca. 0,67 kg/uge ≈ 740 kcal/dag ≈ −21 %
near(ap.pct, -21, 3, 'mål/deadline giver passende pct');
ap = K.autoPlan({ type: 'cut', kg: 117.7, maintenance: mtA, start: '2026-11-30', targetKg: 100, deadline: '2026-12-31' }); eq(ap.pct, -25, 'urealistisk mål → pct begrænses til grænsen'); ok(/over grænsen/.test(ap.notes[0]), 'advarsel om urealistisk mål');
ap = K.autoPlan({ type: 'cut', kg: 117.7, maintenance: mtA, start: '2026-11-30', targetKg: 116, deadline: '2027-06-01' }); ok(ap.pct >= -15 && ap.pct <= -8, 'nemt mål → roligere tempo (blødt interval): ' + ap.pct); ok(/roligt/.test(ap.notes[0]), 'note om roligt tempo');
eq(K.autoPlan({ type: 'cut', kg: 117.7, maintenance: mtA, targetKg: 120 }).ok, false, 'cut-mål over nuværende vægt afvises'); eq(K.autoPlan({ type: 'bulk', kg: 117.7, maintenance: mtA, targetKg: 110 }).ok, false, 'bulk-mål under nuværende vægt afvises');
eq(K.autoPlan({ type: 'nope', kg: 100 }).ok, false, 'ukendt fase'); eq(K.autoPlan({ type: 'cut', kg: 0 }).ok, false, 'mangler vægt');
eq(K.autoPlan({ type: 'lean', kg: 117.7, maintenance: mtA }).pct, 7.5, 'lean standard'); eq(K.autoPlan({ type: 'maint', kg: 117.7, maintenance: mtA }).pct, 0, 'vedligehold 0 %');
const badPhase = K.startPhase(st, { type: 'cut', start: '2026-11-30', targetKg: 130 }); ok(badPhase && badPhase.error, 'startPhase returnerer fejl ved forkert målvægt');
eq(K.autoMeals('cut', 180), 3, '180 g → 3 måltider'); eq(K.autoMeals('cut', 200), 4, '200 g → 4 måltider'); eq(K.autoMeals('bulk', 150), 4, 'bulk 4 måltider'); eq(K.autoMeals('cut', 400), 5, 'højst 5 automatisk');
// ønsket tempo
near(K.desiredRate({ type: 'cut' }, 117, '2026-12-01'), 0.625, 0.001, 'standard ønsket tempo = midt i intervallet'); eq(K.desiredRate({ type: 'maint' }, 117, '2026-12-01'), null, 'ingen tempo i vedligehold');
near(K.desiredRate({ type: 'cut', targetKg: 105, deadline: '2027-04-10' }, 117, '2026-12-01'), 0.5, 0.15, 'tempo ud fra mål og deadline');
eq(K.desiredRate({ type: 'cut', targetKg: 105, deadline: '2026-12-08' }, 117, '2026-12-01'), 0.75, 'urealistisk deadline begrænses til cap'); ok(K.desiredRate({ type: 'cut', targetKg: 120, deadline: '2027-04-10' }, 117, '2026-12-01') <= 0.3, 'mål nået → roligt tempo');
const pd1 = K.weeklyProposal({ phase: 'cut', calibrationDone: true, adherence: 'ja', trend: { enough: true, fitted: 117, kgPerWeek: -0.35, pctPerWeek: -0.3 }, kcal: 2850, bmr: 2234, desiredRate: 0.3 }); eq(pd1.change, 0, 'tempo ≈ ønsket (deadline-tilstand) → ingen ændring');
const pd2 = K.weeklyProposal({ phase: 'cut', calibrationDone: true, adherence: 'ja', trend: { enough: true, fitted: 117, kgPerWeek: -0.35, pctPerWeek: -0.3 }, kcal: 2850, bmr: 2234, desiredRate: 0.75 }); eq(pd2.change, -150, 'for langsomt ift. ønsket tempo → −150');

// ugentligt forslag
const tr = { enough: true, fitted: 117, kgPerWeek: -0.2, pctPerWeek: -0.17 };
eq(K.weeklyProposal({ phase: 'cut', calibrationDone: false, adherence: 'ja', trend: tr, kcal: 2850, bmr: 2234 }).change, 0, 'ingen forslag før kalibrering');
eq(K.weeklyProposal({ phase: 'cut', calibrationDone: true, adherence: 'nej', trend: tr, kcal: 2850, bmr: 2234 }).change, 0, 'ingen forslag hvis kost ikke fulgt');
eq(K.weeklyProposal({ phase: 'cut', calibrationDone: true, adherence: 'delvist', trend: tr, kcal: 2850, bmr: 2234 }).change, 0, 'ingen forslag ved delvist');
eq(K.weeklyProposal({ phase: 'cut', calibrationDone: true, adherence: 'ja', trend: { enough: false }, kcal: 2850, bmr: 2234 }).change, 0, 'ingen forslag uden trend');
let p = K.weeklyProposal({ phase: 'cut', calibrationDone: true, adherence: 'ja', trend: tr, kcal: 2850, bmr: 2234 }); eq(p.change, -150, 'for langsomt tab → −150 (max)'); eq(p.next, 2700, 'nyt mål');
p = K.weeklyProposal({ phase: 'cut', calibrationDone: true, adherence: 'ja', trend: { enough: true, fitted: 117, kgPerWeek: -1.4, pctPerWeek: -1.2 }, kcal: 2850, bmr: 2234 }); eq(p.change, 150, 'for hurtigt tab → +150');
eq(K.weeklyProposal({ phase: 'cut', calibrationDone: true, adherence: 'ja', trend: { enough: true, fitted: 117, kgPerWeek: -0.7, pctPerWeek: -0.6 }, kcal: 2850, bmr: 2234 }).change, 0, 'tempo i målområdet → ingen ændring');
p = K.weeklyProposal({ phase: 'cut', calibrationDone: true, adherence: 'ja', trend: tr, kcal: 2250, bmr: 2234 }); ok(p.change === 0 || p.next >= 2234, 'forslag går ikke under BMR');
p = K.weeklyProposal({ phase: 'bulk', calibrationDone: true, adherence: 'ja', trend: { enough: true, fitted: 117, kgPerWeek: 0.05, pctPerWeek: 0.04 }, kcal: 3800, bmr: 2234 }); ok(p.change > 0 && p.change <= 150, 'bulk for langsomt → plus (højst 150)');
eq(K.weeklyProposal({ phase: 'maint', calibrationDone: true, adherence: 'ja', trend: tr, kcal: 3500, bmr: 2234 }).change, 0, 'ingen justering i vedligehold');
p = K.weeklyProposal({ phase: 'cut', calibrationDone: true, adherence: 'ja', trend: { enough: true, fitted: 117, kgPerWeek: 0.3, pctPerWeek: 0.26 }, kcal: 2850, bmr: 2234 }); eq(p.change, -150, 'vægt stiger i cut → trin på −150, ikke mere');

// fasestatus
const base = { phase: { type: 'cut', start: '2026-11-30', deadline: null, targetKg: null, lastBreak: null }, today: '2026-12-20', trend: { enough: true, fitted: 116, kgPerWeek: -0.6, pctPerWeek: -0.5, latest: { kg: 116 } }, calibrationDone: true, checkins: [] };
const codes = o => K.phaseStatus(o).items.map(i => i.code);
eq(codes(base), [], 'ingen advarsler ved sund cut');
ok(codes(Object.assign({}, base, { trend: { enough: true, fitted: 116, kgPerWeek: -1.2, pctPerWeek: -1.0, latest: { kg: 116 } } })).indexOf('toofast') >= 0, 'for hurtigt tab advarer');
ok(codes(Object.assign({}, base, { trend: { enough: true, fitted: 118, kgPerWeek: 0.4, pctPerWeek: 0.34, latest: { kg: 118 } } })).indexOf('wrongway') >= 0, 'forkert retning advarer');
ok(codes(Object.assign({}, base, { today: '2027-03-01' })).indexOf('duration-max') >= 0, 'varighed → foreslår afslutning (uden deadline)');
ok(codes(Object.assign({}, base, { today: '2027-03-01', phase: Object.assign({}, base.phase, { deadline: '2027-04-10' }) })).indexOf('duration-max') < 0, 'med deadline: ingen stop-forslag pga. varighed');
ok(codes(Object.assign({}, base, { today: '2027-03-01', phase: Object.assign({}, base.phase, { deadline: '2027-04-10' }) })).indexOf('long-phase') >= 0, 'med deadline: kun info om lang fase');
ok(codes(Object.assign({}, base, { today: '2027-04-11', phase: Object.assign({}, base.phase, { deadline: '2027-04-10' }) })).indexOf('deadline-passed') >= 0, 'deadline passeret → forslag');
ok(codes(Object.assign({}, base, { phase: Object.assign({}, base.phase, { targetKg: 117, deadline: '2027-04-10' }) })).indexOf('target') >= 0, 'målvægt nået før deadline → forslag om vedligehold');
ok(codes(Object.assign({}, base, { today: '2026-12-01', phase: Object.assign({}, base.phase, { targetKg: 90, deadline: '2026-12-15' }) })).indexOf('tempo-needed') >= 0, 'urealistisk tempo mod deadline → forslag om lavere tempo');
ok(codes(Object.assign({}, base, { today: '2027-01-20' })).indexOf('break') >= 0, 'cut > 6 uger → pause foreslås'); ok(codes(Object.assign({}, base, { today: '2027-01-20', phase: Object.assign({}, base.phase, { lastBreak: '2027-01-10' }) })).indexOf('break') < 0, 'nylig pause → intet forslag');
ok(codes(Object.assign({}, base, { checkins: [{ energy: 2 }, { energy: 1 }] })).indexOf('energy') >= 0, 'lav energi to uger → advarsel'); ok(codes(Object.assign({}, base, { checkins: [{ energy: 2 }, { energy: 4 }] })).indexOf('energy') < 0, 'kun én lav uge → ingen advarsel');
ok(codes(Object.assign({}, base, { checkins: [{ energy: 3, symptoms: true }, { energy: 3, symptoms: true }] })).indexOf('doctor') >= 0, 'vedvarende symptomer → læge');
ok(codes(Object.assign({}, base, { trend: null })).length === 0, 'trend null kaster ikke');
ok(codes(Object.assign({}, base, { phase: { type: 'maint', start: '2026-11-30' } })).indexOf('toofast') < 0, 'vedligehold har ingen tempo-advarsel');

// sikkerhed: ingen fund må foreslå automatisk skift
K.phaseStatus(base).items.forEach(i => ok(['info', 'warn', 'suggest'].indexOf(i.level) >= 0, 'gyldigt niveau'));
console.log(bad ? bad + ' fejl' : 'Alle Krop-tests bestået'); process.exit(bad ? 1 : 0);
