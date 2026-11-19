/* Krop — beregningskerne (ren logik, ingen DOM). Bruges af krop/index.html og testes i node (tests/krop.test.js).
   Alle tal er ESTIMATER: startmålet kalibreres mod faktiske vejninger. Ingen kostlog.
   Datoer er ISO-strenge (YYYY-MM-DD) og regnes ved middag for at undgå sommertids-fejl. */
(function (root) {
  'use strict';

  var KCAL_PER_KG = 7700;

  // Fasedefinitioner. pct = kcal-justering ift. vedligehold. rate = ønsket vægtændring i % af kropsvægt pr. uge (absolut). cap = øvre grænse (% pr. uge).
  var PHASES = {
    cut:  { key: 'cut',  label: 'Cut',       sign: -1, pct: [-25, -15], pctDefault: -20, rate: [0.5, 0.75], cap: 0.75, weeks: [8, 12],  meals: 3, protPerKgLean: 2.3 },
    lean: { key: 'lean', label: 'Lean Gain', sign: 1,  pct: [5, 10],    pctDefault: 7.5, rate: [0.1, 0.25], cap: 0.25, weeks: [12, 24], meals: 4, protPerKgLean: 2.0 },
    bulk: { key: 'bulk', label: 'Bulk',      sign: 1,  pct: [10, 20],   pctDefault: 15,  rate: [0.25, 0.5], cap: 0.5,  weeks: [12, 20], meals: 4, protPerKgLean: 2.0 },
    maint:{ key: 'maint',label: 'Vedligehold', sign: 0, pct: [0, 0],    pctDefault: 0,   rate: [0, 0.1],    cap: 0.25, weeks: [1, 2],   meals: 4, protPerKgLean: 2.0 }
  };

  /* ── dato-hjælpere ── */
  function parse(iso) { return new Date(String(iso) + 'T12:00:00'); }
  function isISO(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(parse(s).getTime()); }
  function toISO(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function addDays(iso, n) { var d = parse(iso); d.setDate(d.getDate() + n); return toISO(d); }
  function diffDays(a, b) { return Math.round((parse(b) - parse(a)) / 86400000); }
  function ageAt(birth, iso) {
    if (!isISO(birth) || !isISO(iso)) return null;
    var b = parse(birth), d = parse(iso), a = d.getFullYear() - b.getFullYear();
    if (d.getMonth() < b.getMonth() || (d.getMonth() === b.getMonth() && d.getDate() < b.getDate())) a--;
    return a;
  }
  function num(x) { var n = parseFloat(String(x).replace(',', '.')); return isFinite(n) ? n : null; }
  function round(x, step) { step = step || 1; return Math.round(x / step) * step; }
  function r1(x) { return Math.round(x * 10) / 10; }
  function r2(x) { return Math.round(x * 100) / 100; }

  /* ── energi ── */
  // Mifflin-St Jeor (mand).
  function bmr(o) {
    var kg = num(o && o.kg), h = num(o && o.heightCm), age = num(o && o.age);
    if (kg === null || h === null || age === null || kg <= 0 || h <= 0) return null;
    return Math.round(10 * kg + 6.25 * h - 5 * age + 5);
  }
  // Vedligehold = BMR × 1,12 (dagligdags bevægelse + fordøjelse) + skridt-forbrug + gennemsnitligt træningsforbrug.
  // Skridt: ca. 0,0004 kcal pr. skridt pr. kg (netto, så overlap med BMR undgås). Interval ±8 %.
  function maintenance(o) {
    var b = bmr(o); if (b === null) return null;
    var kg = num(o.kg), steps = Math.max(0, num(o.steps) || 0), trainWk = Math.max(0, num(o.trainingKcalWeek) || 0);
    var walk = steps * 0.0004 * kg, train = trainWk / 7;
    var total = b * 1.12 + walk + train;
    return { bmr: b, base: Math.round(b * 1.12), walk: Math.round(walk), train: Math.round(train), total: round(total, 50), low: round(total * 0.92, 50), high: round(total * 1.08, 50) };
  }
  // Kalibreret vedligehold ud fra faktisk vægtændring: indtag − (kg/uge × 7700 / 7). Kun meningsfuldt hvis målet er fulgt nogenlunde.
  function calibratedMaintenance(targetKcal, kgPerWeek) {
    if (!isFinite(targetKcal) || !isFinite(kgPerWeek)) return null;
    return round(targetKcal - kgPerWeek * KCAL_PER_KG / 7, 50);
  }
  // Kalorie-mål. Aldrig under BMR. Rundet til nærmeste 50.
  function targetKcal(maint, pct, bmrVal) {
    if (!isFinite(maint) || !isFinite(pct)) return null;
    var t = round(maint * (1 + pct / 100), 50);
    if (isFinite(bmrVal) && t < bmrVal) t = round(Math.ceil(bmrVal / 50) * 50, 50);
    return t;
  }
  function pctOf(kcal, maint) { return maint ? r1((kcal / maint - 1) * 100) : null; }

  /* ── makroer ── */
  // Protein ud fra fedtfri masse (fat% hvis kendt, ellers 75 % af vægten); fedt 0,7 g/kg (min. 0,6); resten kulhydrat.
  function macros(o) {
    var kcal = num(o && o.kcal), kg = num(o && o.kg); if (kcal === null || kg === null || kg <= 0) return null;
    var ph = PHASES[o.phase] || PHASES.cut, fat = num(o.fatPct);
    var lean = (fat !== null && fat > 3 && fat < 60) ? kg * (1 - fat / 100) : kg * 0.75;
    var protein = round(lean * ph.protPerKgLean, 5);
    var fatG = round(kg * 0.7, 5), minFat = Math.round(kg * 0.6);
    if (fatG < minFat) fatG = minFat;
    var carbsG = Math.floor((kcal - protein * 4 - fatG * 9) / 4);
    var lowCarb = false;
    if (carbsG < 100) { // meget lavt kcal-mål: pres fedt ned mod minimum før kulhydrat
      fatG = Math.max(minFat, fatG - 15); carbsG = Math.floor((kcal - protein * 4 - fatG * 9) / 4); lowCarb = true;
    }
    if (carbsG < 0) carbsG = 0;
    return { kcal: kcal, protein: protein, fat: fatG, carbs: carbsG, leanKg: r1(lean), proteinPerKg: r2(protein / kg), lowCarb: lowCarb };
  }

  /* ── måltider ── */
  var MEAL_WEIGHTS = {
    2: [0.45, 0.55],
    3: [0.30, 0.35, 0.35],
    4: [0.25, 0.25, 0.30, 0.20],
    5: [0.20, 0.20, 0.25, 0.20, 0.15],
    6: [0.18, 0.17, 0.20, 0.18, 0.17, 0.10]
  };
  var MEAL_NAMES = {
    2: ['Måltid 1', 'Måltid 2'],
    3: ['Morgenmad', 'Frokost', 'Aftensmad'],
    4: ['Morgenmad', 'Frokost', 'Aftensmad', 'Aftenmåltid'],
    5: ['Morgenmad', 'Formiddag', 'Frokost', 'Aftensmad', 'Aftenmåltid'],
    6: ['Morgenmad', 'Formiddag', 'Frokost', 'Eftermiddag', 'Aftensmad', 'Aftenmåltid']
  };
  function clampMeals(n) { n = Math.round(num(n) || 3); return Math.min(6, Math.max(2, n)); }
  // Protein fordeles lige; kcal efter vægte; fedt følger kcal; kulhydrat = resten (så hvert måltid summer til sin kcal).
  function mealSplit(m, n) {
    if (!m) return [];
    n = clampMeals(n);
    var w = MEAL_WEIGHTS[n], names = MEAL_NAMES[n], out = [], usedP = 0, usedF = 0, usedC = 0, usedK = 0;
    for (var i = 0; i < n; i++) {
      var last = i === n - 1;
      var p = last ? m.protein - usedP : Math.round(m.protein / n);
      var f = last ? m.fat - usedF : Math.round(m.fat * w[i]);
      var k = last ? m.kcal - usedK : round(m.kcal * w[i], 5);
      var c = last ? m.carbs - usedC : Math.max(0, Math.round((k - p * 4 - f * 9) / 4));
      if (last) { c = Math.max(0, c); }
      usedP += p; usedF += f; usedC += c; usedK += k;
      out.push({ name: names[i], kcal: k, protein: p, fat: f, carbs: c, proteinHigh: p > 60 });
    }
    return out;
  }
  function suggestedMeals(phase) { return (PHASES[phase] || PHASES.cut).meals; }

  /* ── vejninger og trend ── */
  function cleanWeighins(list) {
    var byDay = {};
    (Array.isArray(list) ? list : []).forEach(function (w) {
      if (!w || !isISO(w.date)) return; var kg = num(w.kg); if (kg === null || kg < 30 || kg > 300) return;
      (byDay[w.date] = byDay[w.date] || []).push(kg);
    });
    return Object.keys(byDay).sort().map(function (d) { var a = byDay[d]; return { date: d, kg: a.reduce(function (s, x) { return s + x; }, 0) / a.length }; });
  }
  // Mindste-kvadraters trend over de seneste 14 dage (udvides til 21 hvis færre end 3 punkter). Kræver ≥ 3 vejedage.
  function trend(list, asOf) {
    var all = cleanWeighins(list); if (!all.length) return null;
    var end = asOf && isISO(asOf) ? asOf : all[all.length - 1].date;
    all = all.filter(function (w) { return w.date <= end; }); if (!all.length) return null;
    var pts = null;
    [14, 21].some(function (win) {
      var s = all.filter(function (w) { return diffDays(w.date, end) < win; });
      if (s.length >= 3) { pts = s; return true; } return false;
    });
    if (!pts) return { n: all.length, enough: false, latest: all[all.length - 1] };
    var x0 = pts[0].date, n = pts.length, sx = 0, sy = 0, sxx = 0, sxy = 0;
    pts.forEach(function (p) { var x = diffDays(x0, p.date), y = p.kg; sx += x; sy += y; sxx += x * x; sxy += x * y; });
    var den = n * sxx - sx * sx; if (den === 0) return { n: n, enough: false, latest: all[all.length - 1] };
    var slope = (n * sxy - sx * sy) / den, icpt = (sy - slope * sx) / n;
    var lastDay = pts[pts.length - 1].date, fitted = icpt + slope * diffDays(x0, lastDay);
    return {
      enough: true, n: n, spanDays: diffDays(x0, lastDay), kgPerWeek: r2(slope * 7), pctPerWeek: r2(slope * 7 / fitted * 100),
      fitted: r1(fitted), asOf: lastDay, latest: all[all.length - 1]
    };
  }

  /* ── pauser/kalibrering ── */
  function inPause(pauses, iso) {
    return (Array.isArray(pauses) ? pauses : []).some(function (p) { return p && isISO(p.from) && isISO(p.to) && p.from <= iso && iso <= p.to; });
  }
  // Kalibrering: 14 "almindelige" dage (pausedage tæller ikke) — 21, hvis der er under 5 vejninger i de første 14 almindelige dage — og mindst 3 vejninger.
  function calibration(o) {
    var start = o && o.start, today = o && o.today; if (!isISO(start) || !isISO(today)) return null;
    var wi = cleanWeighins(o.weighins).filter(function (w) { return w.date >= start; });
    var d = start, count = 0, i = 0, need = 14, endDate = null, guard = 0;
    function weighinsWithin(until) { return wi.filter(function (w) { return w.date <= until; }).length; }
    var fourteenth = null;
    while (guard++ < 400) {
      if (!inPause(o.pauses, d)) { count++; if (count === 14) fourteenth = d; }
      if (count === 14 && need === 14) { if (weighinsWithin(d) < 5) need = 21; }
      if (count >= need) { endDate = d; break; }
      d = addDays(d, 1);
    }
    var cnt = 0, dd = start; // almindelige dage indtil i dag
    while (dd <= today) { if (!inPause(o.pauses, dd)) cnt++; dd = addDays(dd, 1); }
    var nW = wi.filter(function (w) { return w.date <= today; }).length;
    var done = endDate !== null && today >= endDate && nW >= 3;
    return { doneDays: Math.min(cnt, need), needDays: need, endDate: endDate, weighins: nW, done: done, needMoreWeighins: today >= (endDate || '9999') && nW < 3 };
  }

  /* ── ugentligt forslag ── */
  // Foreslår max ±150 kcal og kun hvis kalibreringen er færdig og kosten er noteret fulgt ("ja"). Kræver bekræftelse i UI.
  function weeklyProposal(o) {
    var ph = PHASES[o.phase]; if (!ph || ph.sign === 0) return { change: 0, reason: 'Ingen justering i denne fase.' };
    if (!o.calibrationDone) return { change: 0, reason: 'Kalibreringen er ikke færdig endnu.' };
    if (o.adherence !== 'ja') return { change: 0, reason: o.adherence === 'delvist' ? 'Kosten er kun delvist fulgt — samler mere data før justering.' : 'Kosten er ikke fulgt — ingen justering, tallet siger ikke noget om målet.' };
    var t = o.trend; if (!t || !t.enough) return { change: 0, reason: 'For få vejninger (mindst 3) til en trend.' };
    var kg = t.fitted, mid = (ph.rate[0] + ph.rate[1]) / 2 / 100 * kg * ph.sign;     // ønsket kg/uge (fortegn)
    var raw = (mid - t.kgPerWeek) * KCAL_PER_KG / 7;                                  // kcal/dag der mangler
    var inRange = Math.abs(t.pctPerWeek) >= ph.rate[0] && Math.abs(t.pctPerWeek) <= ph.rate[1] && Math.sign(t.kgPerWeek) === ph.sign;
    if (inRange || Math.abs(raw) < 75) return { change: 0, reason: 'Tempoet ligger i målområdet — ingen ændring.' };
    var ch = Math.max(-150, Math.min(150, round(raw, 50)));
    var next = o.kcal + ch;
    if (isFinite(o.bmr) && next < o.bmr) { ch = Math.max(0, Math.ceil(o.bmr / 50) * 50 - o.kcal); next = o.kcal + ch; if (!ch) return { change: 0, reason: 'Må ikke gå under BMR.' }; }
    return { change: ch, next: next, reason: 'Trend ' + t.kgPerWeek + ' kg/uge (' + t.pctPerWeek + ' %/uge) mod mål ' + ph.rate[0] + '–' + ph.rate[1] + ' %/uge.' };
  }

  /* ── fasestatus: advarsler og forslag ── */
  // Deadline-tilstand: fasen løber til datoen; stopregler bliver advarsler/forslag (aldrig automatiske skift).
  function phaseStatus(o) {
    var ph = PHASES[o.phase.type] || PHASES.cut, p = o.phase, today = o.today, out = [];
    var weeks = isISO(p.start) ? Math.floor(Math.max(0, diffDays(p.start, today)) / 7) : 0;
    var t = o.trend, cur = t && t.enough ? t.fitted : (t && t.latest ? t.latest.kg : null);
    function add(level, code, text) { out.push({ level: level, code: code, text: text }); }
    // tempo
    if (t && t.enough && o.calibrationDone && ph.sign !== 0) {
      var signed = t.pctPerWeek * ph.sign;
      if (signed < 0) add('warn', 'wrongway', 'Vægten bevæger sig den modsatte vej af fasen (' + t.kgPerWeek + ' kg/uge). Tjek om kosten er fulgt, før målet ændres.');
      else if (Math.abs(t.pctPerWeek) > ph.cap) add('warn', 'toofast', 'Tempoet (' + Math.abs(t.pctPerWeek) + ' %/uge) er over grænsen på ' + ph.cap + ' %/uge — overvej at hæve kcal lidt for at skåne muskler/energi.');
    }
    // mållevering / varighed
    var reached = false;
    if (p.targetKg && cur !== null) reached = ph.sign < 0 ? cur <= p.targetKg : (ph.sign > 0 ? cur >= p.targetKg : false);
    if (reached) add('suggest', 'target', 'Målvægten ' + p.targetKg + ' kg er nået' + (p.deadline ? ' før deadline (' + p.deadline + ')' : '') + '. Jeg foreslår at skifte til vedligehold. Siger du ikke til, fortsætter fasen uændret.');
    if (p.deadline && isISO(p.deadline)) {
      var left = diffDays(today, p.deadline);
      if (left < 0) add('suggest', 'deadline-passed', 'Deadline (' + p.deadline + ') er passeret — vælg næste fase eller vedligehold.');
      else if (p.targetKg && cur !== null && left > 0 && ph.sign !== 0) {
        var needPct = Math.abs(cur - p.targetKg) / (left / 7) / cur * 100;
        if (!reached && needPct > ph.cap) add('suggest', 'tempo-needed', 'For at nå ' + p.targetKg + ' kg til ' + p.deadline + ' kræves ' + r2(needPct) + ' %/uge — over grænsen (' + ph.cap + '). Overvej at sænke tempoet eller flytte målet.');
      }
      // deadline overruler "stop efter X uger": kun info
      if (left >= 0 && weeks >= ph.weeks[1]) add('info', 'long-phase', 'Fasen er over ' + ph.weeks[1] + ' uger, men kører til din deadline. Hold øje med energi og søvn.');
    } else if (ph.sign !== 0) {
      if (weeks >= ph.weeks[1]) add('suggest', 'duration-max', 'Fasen har varet ' + weeks + ' uger (typisk ' + ph.weeks[0] + '–' + ph.weeks[1] + '). Jeg foreslår at afslutte eller holde pause. Siger du ikke til, fortsætter vi.');
      else if (weeks >= ph.weeks[0]) add('info', 'duration-min', 'Fasen har varet ' + weeks + ' uger — du er i det typiske vindue for at afslutte.');
    }
    // vedligeholdelsespause i cut (foreslået, aldrig automatisk)
    if (p.type === 'cut') {
      var since = isISO(p.lastBreak) ? diffDays(p.lastBreak, today) : diffDays(p.start, today);
      if (since >= 42) add('suggest', 'break', 'Der er gået ' + Math.floor(since / 7) + ' uger i underskud. En vedligeholdelsespause på 1–2 uger kan hjælpe på energi og restitution. Det er et forslag, ikke et krav.');
    }
    // energi / symptomer
    var ci = (o.checkins || []).slice(-2);
    if (ci.length === 2 && ci.every(function (c) { return num(c.energy) !== null && num(c.energy) <= 2; }) && ph.sign < 0)
      add('warn', 'energy', 'Energien har været lav to uger i træk. Overvej at stoppe cutten tidligt eller holde en vedligeholdelsespause.');
    var sy = (o.checkins || []).slice(-2);
    if (sy.length === 2 && sy.every(function (c) { return c.symptoms; }))
      add('warn', 'doctor', 'Du har meldt symptomer to uger i træk (fx svimmelhed, søvnbesvær, uvilje mod mad). Tal med din læge, og hold pause med underskuddet imens.');
    return { weeks: weeks, reached: reached, items: out };
  }

  /* ── hele planen ud fra tilstand ── */
  function emptyState(todayIso) {
    return {
      v: 1,
      profile: { heightCm: 185, birth: '2005-10-07', steps: 16700, trainingKcalWeek: 1700 }, profileAt: 0,
      phase: null, phaseAt: 0, tombs: {},
      weighins: [
        { date: '2026-11-02', kg: 116.5, fat: 33.6 }, { date: '2026-11-05', kg: 115.15, fat: 33.3 },
        { date: '2026-11-11', kg: 115.95, fat: 33.5 }, { date: '2026-11-14', kg: 116.5, fat: 33.6 },
        { date: '2026-11-17', kg: 117.8, fat: 33.9 }
      ],
      checkins: [], adjustments: [], snapshots: [], history: []
    };
  }
  // Opret fase med startmål ud fra vedligehold og valgt pct.
  function startPhase(st, o) {
    var type = o.type, ph = PHASES[type]; if (!ph) return null;
    var w = trend(st.weighins, o.start), kg = w ? (w.enough ? w.fitted : w.latest.kg) : null;
    var lastFat = null; cleanFatLast(st.weighins, function (f) { lastFat = f; });
    if (kg === null) return null;
    var age = ageAt(st.profile.birth, o.start);
    var mt = maintenance({ kg: kg, heightCm: st.profile.heightCm, age: age, steps: st.profile.steps, trainingKcalWeek: st.profile.trainingKcalWeek });
    var pct = num(o.pct); if (pct === null) pct = ph.pctDefault;
    pct = Math.max(ph.pct[0], Math.min(ph.pct[1], pct));
    return {
      type: type, start: o.start, deadline: isISO(o.deadline) ? o.deadline : null, targetKg: num(o.targetKg), pct: pct,
      meals: clampMeals(o.meals || ph.meals), maintenance: mt.total, startKg: r1(kg), kcal: targetKcal(mt.total, pct, mt.bmr), lastBreak: null
    };
  }
  function cleanFatLast(list, cb) {
    var l = (Array.isArray(list) ? list : []).filter(function (w) { return w && isISO(w.date) && num(w.fat) !== null; }).sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    if (l.length) cb(num(l[l.length - 1].fat));
  }
  function latestFat(list) { var f = null; cleanFatLast(list, function (x) { f = x; }); return f; }

  var API = {
    PHASES: PHASES, KCAL_PER_KG: KCAL_PER_KG, MEAL_WEIGHTS: MEAL_WEIGHTS,
    isISO: isISO, toISO: toISO, addDays: addDays, diffDays: diffDays, ageAt: ageAt, num: num, round: round,
    bmr: bmr, maintenance: maintenance, calibratedMaintenance: calibratedMaintenance, targetKcal: targetKcal, pctOf: pctOf,
    macros: macros, mealSplit: mealSplit, suggestedMeals: suggestedMeals, clampMeals: clampMeals,
    cleanWeighins: cleanWeighins, trend: trend, inPause: inPause, calibration: calibration,
    weeklyProposal: weeklyProposal, phaseStatus: phaseStatus, emptyState: emptyState, startPhase: startPhase, latestFat: latestFat
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = API; else root.KropCore = API;
})(typeof window !== 'undefined' ? window : this);
