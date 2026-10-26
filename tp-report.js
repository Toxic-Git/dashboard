/* tp-report.js — Månedsrapport (V3 fase 4). DOM-fri, ren logik. Alt er regelbaseret og kan spores til tal.
   INGEN AI-tekst genereres her. Hvis AI-tekst senere tilføjes, SKAL den vises adskilt og mærket "AI-genereret".
   Rapporten er et øjebliksbillede (snapshot) af eksisterende data — den ændrer aldrig data. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./tp-core.js'));
  else root.TPREPORT = factory(root.TP);
})(typeof self !== 'undefined' ? self : this, function (TP) {
  'use strict';
  var R = { VERSION: 1 };
  var CYCLE_IDS = ['cst1', 'low1', 'rest1', 'bb1', 'cst2', 'rest2', 'low2', 'bb2'];
  var LIFTS = { sq: { label: 'Squat', names: ['Squat', 'Squat — 1RM Forsøg', 'Box Squat'] }, bp: { label: 'Bænkpres', names: ['Bench Press', 'Bench Press — 1RM Forsøg', 'Pause Bench Press'] }, dl: { label: 'Dødløft', names: ['Deadlift (Conv.)', 'Deadlift — 1RM Forsøg', 'Deficit Deadlift (2 cm)'] } };
  var MONTHS = ['januar', 'februar', 'marts', 'april', 'maj', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'december'];
  // Tærskler (dokumenterede, konservative)
  R.TH = { e1rmDropPct: 3, sessionsDropPct: 25, sessionsDropMinPrior: 4, kmDropPct: 25, kmDropMinPrior: 20, kmGrowthMaxPct: 25, kmGrowthMinPrior: 10,
    plannedGood: 0.85, plannedBad: 0.6, paceSlowPct: 3, paceMinRuns: 3, paceMinKm: 3, gapDays: 10, splitShiftPts: 10, evalMin: 4, painMin: 2 };
  R.RULES = [
    { id: 'RP1', kind: 'good', text: 'Ny bedste estimerede 1RM (Epley) på et hovedløft i måneden sammenlignet med alt før måneden.' },
    { id: 'RP2', kind: 'good', text: 'Gennemført ≥ 85 % af de planlagte pas (planlagt = rytmen i kalenderen; kun når planen kendes for hele måneden).' },
    { id: 'RP3', kind: 'good', text: 'Løbe-km steg 0–25 % i forhold til forrige måned (min. 10 km forrige måned) — gradvis stigning.' },
    { id: 'RP4', kind: 'good', text: 'Et eller flere løbemål blev nået i måneden.' },
    { id: 'RP5', kind: 'good', text: 'Min. 4 selvvurderinger, og flertallet føltes som ventet eller lettere (selvrapporteret).' },
    { id: 'RN1', kind: 'bad', text: 'Månedens bedste e1RM på et hovedløft er ≥ 3 % lavere end forrige måneds bedste (begge måneder med data). Kan skyldes variation i RPE/dagsform.' },
    { id: 'RN2', kind: 'bad', text: 'Antal styrkepas + løb ≥ 25 % lavere end forrige måned (forrige måned ≥ 4 pas).' },
    { id: 'RN3', kind: 'bad', text: 'Løbe-km ≥ 25 % lavere end forrige måned (forrige måned ≥ 20 km).' },
    { id: 'RN4', kind: 'bad', text: 'Gennemført < 60 % af de planlagte pas.' },
    { id: 'RN5', kind: 'bad', text: 'Snit-tempo ≥ 3 % langsommere end forrige måned (≥ 3 løb à ≥ 3 km i begge måneder). Påvirkes af hvor hårde løbene var.' },
    { id: 'RN6', kind: 'bad', text: 'Samme ømhed/smerte-område nævnt i ≥ 2 selvvurderinger (selvrapporteret — ikke en diagnose).' },
    { id: 'RN7', kind: 'bad', text: '≥ 10 dage i træk uden nogen registreret træning i måneden.' }
  ];
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  R.monthLabel = function (ym) { return MONTHS[parseInt(ym.slice(5), 10) - 1] + ' ' + ym.slice(0, 4); };
  R.prevMonth = function (ym) { var y = +ym.slice(0, 4), m = +ym.slice(5); m--; if (m < 1) { m = 12; y--; } return y + '-' + pad(m); };
  R.nextMonth = function (ym) { var y = +ym.slice(0, 4), m = +ym.slice(5); m++; if (m > 12) { m = 1; y++; } return y + '-' + pad(m); };
  R.monthRange = function (ym) {
    var first = ym + '-01', last = TP.addDays(R.nextMonth(ym) + '-01', -1); return { first: first, last: last, days: TP.diffDays(first, last) + 1 };
  };
  var epley = function (kg, reps) { return reps === 1 ? kg : kg * (1 + reps / 30); };
  var r1 = function (x) { return Math.round(x * 10) / 10; };
  var pct = function (a, b) { return b ? Math.round(((a - b) / b) * 1000) / 10 : null; };

  // ── Rå sessioner ───────────────────────────────────────────────────────────
  // Returnerer {sessions:[{date,dayN,week,sets,tonnage,minutes,exercises:{name:bestE1rm}}], ...}
  function sbdSessions(s) {
    var out = [];
    if (!s) return out;
    (s.completedDays || []).forEach(function (d) {
      var id = CYCLE_IDS[d % 8]; if (id && /^rest/.test(id)) return; // pausedage er ikke pas
      var date = TP.sbdSessionDate(s, d); if (!date) return;
      var log = (s.logs || {})['day' + d] || { exercises: [] }, sets = 0, ton = 0, ex = {};
      (log.exercises || []).forEach(function (e) {
        (e.sets || []).forEach(function (st) {
          var kg = parseFloat(st.kg), reps = parseInt(st.reps, 10);
          if (st.done && kg > 0 && reps > 0) { sets++; ton += kg * reps; var e1 = epley(kg, reps); if (!ex[e.name] || e1 > ex[e.name]) ex[e.name] = e1; }
        });
      });
      var t = (s.sessionTimes || {})['day' + d], min = null;
      if (t && t.end && (t.sessionStart || t.start)) { var m = (t.end - (t.sessionStart || t.start)) / 60000; if (m > 0 && m < 300) min = Math.round(m); }
      out.push({ date: date, dayN: d, week: Math.floor(d / 7) + 1, cycle: id, sets: sets, tonnage: Math.round(ton), minutes: min, exercises: ex });
    });
    return out.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
  }
  var inMonth = function (date, rg) { return date >= rg.first && date <= rg.last; };

  function liftBest(sessions, key, rg, before) {
    var best = 0, names = LIFTS[key].names;
    sessions.forEach(function (x) {
      if (before ? x.date >= rg.first : !inMonth(x.date, rg)) return;
      names.forEach(function (n) { if (x.exercises[n] && x.exercises[n] > best) best = x.exercises[n]; });
    });
    return best ? r1(best) : null;
  }

  // ── Månedsstatistik for én måned ───────────────────────────────────────────
  R.monthStats = function (input, ym) {
    var rg = R.monthRange(ym), sAll = sbdSessions(input.sbd), runsAll = ((input.lob && input.lob.runs) || []).slice();
    var sess = sAll.filter(function (x) { return inMonth(x.date, rg); });
    var runs = runsAll.filter(function (x) { return inMonth(x.date, rg); }).sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    var km = runs.reduce(function (a, x) { return a + (+x.distanceKm || 0); }, 0), sec = runs.reduce(function (a, x) { return a + (+x.durationSec || 0); }, 0);
    var paceRuns = runs.filter(function (x) { return +x.distanceKm >= R.TH.paceMinKm && +x.durationSec > 0; });
    var paceKm = paceRuns.reduce(function (a, x) { return a + x.distanceKm; }, 0), paceSec = paceRuns.reduce(function (a, x) { return a + x.durationSec; }, 0);
    var weeks = {}; sess.forEach(function (x) { weeks[TP.weekStart(x.date)] = 1; }); runs.forEach(function (x) { weeks[TP.weekStart(x.date)] = 1; });
    var trainDates = {}; sess.forEach(function (x) { trainDates[x.date] = 1; }); runs.forEach(function (x) { trainDates[x.date] = 1; });
    var dates = Object.keys(trainDates).sort(), maxGap = 0, i;
    if (dates.length) { maxGap = Math.max(TP.diffDays(rg.first, dates[0]), TP.diffDays(dates[dates.length - 1], rg.last)); for (i = 1; i < dates.length; i++) maxGap = Math.max(maxGap, TP.diffDays(dates[i - 1], dates[i]) - 1); }
    else maxGap = rg.days;
    var deloadWeeks = {}; sess.forEach(function (x) { if (x.week === 4 || x.week === 8 || ((input.sbd && input.sbd.deloadWeeks) || []).indexOf(x.week) >= 0) deloadWeeks[x.week] = 1; });
    var lifts = {}; Object.keys(LIFTS).forEach(function (k) { lifts[k] = { label: LIFTS[k].label, monthBest: liftBest(sAll, k, rg, false), priorBest: liftBest(sAll, k, rg, true) }; });
    var sbdMin = sess.reduce(function (a, x) { return a + (x.minutes || 0); }, 0), sbdMinKnown = sess.every(function (x) { return x.minutes != null; });
    return { month: ym, range: rg,
      strength: { sessions: sess.length, perWeek: r1(sess.length / (rg.days / 7)), sets: sess.reduce(function (a, x) { return a + x.sets; }, 0), tonnage: sess.reduce(function (a, x) { return a + x.tonnage; }, 0), lifts: lifts, deloadWeeks: Object.keys(deloadWeeks).map(Number), minutes: sbdMin, minutesComplete: sbdMinKnown },
      running: { runs: runs.length, km: r1(km), avgKm: runs.length ? r1(km / runs.length) : 0, longestKm: runs.reduce(function (a, x) { return Math.max(a, +x.distanceKm || 0); }, 0), minutes: Math.round(sec / 60), paceSecPerKm: paceKm ? Math.round(paceSec / paceKm) : null, paceRuns: paceRuns.length },
      overall: { sessions: sess.length + runs.length, trainingDays: dates.length, activeWeeks: Object.keys(weeks).length, longestGapDays: maxGap } };
  };

  // Planlagt (fra rytmen) — udfyldes af kalderen: input.planned = {sbd:n, run:n} eller null hvis planen ikke kendes for hele måneden
  R.build = function (input, ym, now) {
    var cur = R.monthStats(input, ym), prev = R.monthStats(input, R.prevMonth(ym)), rg = cur.range;
    var rep = { v: R.VERSION, month: ym, label: R.monthLabel(ym), generatedAt: now || Date.now(), profile: input.profile || 'main', ruleBased: true,
      note: 'Regelbaseret opsummering — ingen AI. Hvert udsagn henviser til de tal det bygger på.', partial: false };
    var today = input.today || TP.localISO(new Date());
    rep.partial = today <= rg.last; // måneden er ikke slut
    rep.strength = cur.strength; rep.running = cur.running;
    rep.prev = { strengthSessions: prev.strength.sessions, sets: prev.strength.sets, runs: prev.running.runs, km: prev.running.km, paceSecPerKm: prev.running.paceSecPerKm, sessions: prev.overall.sessions };
    var planned = input.planned || null, completedStr = cur.strength.sessions, completedRun = cur.running.runs;
    rep.overall = Object.assign({}, cur.overall, {
      split: { strengthPct: cur.overall.sessions ? Math.round(cur.strength.sessions / cur.overall.sessions * 100) : null, runPct: cur.overall.sessions ? Math.round(cur.running.runs / cur.overall.sessions * 100) : null },
      planned: planned ? { sbd: planned.sbd, run: planned.run, total: planned.sbd + planned.run, completed: completedStr + completedRun, ratio: (planned.sbd + planned.run) ? r1((completedStr + completedRun) / (planned.sbd + planned.run)) : null } : null,
      volumeChange: { sets: pct(cur.strength.sets, prev.strength.sets), km: pct(cur.running.km, prev.running.km), sessions: pct(cur.overall.sessions, prev.overall.sessions) } });
    // Evalueringer i måneden
    var evs = [];
    ((input.sbd && input.sbd.sessionEval) || {}) && Object.keys((input.sbd && input.sbd.sessionEval) || {}).forEach(function (k) { var d = TP.sbdSessionDate(input.sbd, parseInt(k.replace('day', ''), 10)); if (d && inMonth(d, rg)) evs.push(input.sbd.sessionEval[k]); });
    ((input.lob && input.lob.runs) || []).forEach(function (x) { if (x.eval && inMonth(x.date, rg)) evs.push(x.eval); });
    var effort = evs.filter(function (e) { return e.effort != null; }), painCount = {};
    evs.forEach(function (e) { (e.pain || []).forEach(function (p) { painCount[p] = (painCount[p] || 0) + 1; }); });
    rep.evaluation = { n: evs.length, avgEffort: effort.length ? r1(effort.reduce(function (a, e) { return a + e.effort; }, 0) / effort.length) : null,
      harder: evs.filter(function (e) { return e.vs === 'harder'; }).length, easier: evs.filter(function (e) { return e.vs === 'easier'; }).length, as: evs.filter(function (e) { return e.vs === 'as'; }).length, pain: painCount };
    // Mål
    var goals = (input.lob && input.lob.profile && input.lob.profile.goals) || [];
    rep.goals = { achieved: goals.filter(function (g) { return g.achievedDate && inMonth(g.achievedDate, rg); }).map(function (g) { return { id: g.id, date: g.achievedDate, title: g.title || g.kind }; }),
      missed: goals.filter(function (g) { return g.deadline && !g.achievedDate && inMonth(g.deadline, rg) && g.deadline < today; }).map(function (g) { return { id: g.id, deadline: g.deadline, title: g.title || g.kind }; }),
      race: (input.lob && input.lob.profile && input.lob.profile.raceGoal && input.lob.profile.raceGoal.active && input.lob.profile.raceGoal.date && inMonth(input.lob.profile.raceGoal.date, rg)) ? input.lob.profile.raceGoal.date : null,
      focus: input.focus || 'balanced' };
    rep.conclusion = R.conclude(rep, cur, prev, input);
    return rep;
  };

  var S = function (rule, text, basis) { return { rule: rule, text: text, basis: basis || [] }; };
  R.conclude = function (rep, cur, prev, input) {
    var T = R.TH, good = [], dev = [], bad = [], focus = [];
    // Hovedløft
    Object.keys(cur.strength.lifts).forEach(function (k) {
      var l = cur.strength.lifts[k];
      if (l.monthBest != null && l.priorBest != null && l.monthBest > l.priorBest) good.push(S('RP1', 'Ny bedste e1RM på ' + l.label + ': ' + l.priorBest + ' → ' + l.monthBest + ' kg (+' + pct(l.monthBest, l.priorBest) + ' %).', [['Før måneden', l.priorBest + ' kg'], ['I måneden', l.monthBest + ' kg']]));
      var pl = prev.strength.lifts[k];
      if (l.monthBest != null && pl && pl.monthBest != null && pct(l.monthBest, pl.monthBest) <= -T.e1rmDropPct) bad.push(S('RN1', l.label + ': månedens bedste e1RM er ' + Math.abs(pct(l.monthBest, pl.monthBest)) + ' % lavere end forrige måned (' + pl.monthBest + ' → ' + l.monthBest + ' kg). Kan skyldes variation i RPE/dagsform.', [['Forrige måned', pl.monthBest + ' kg'], ['Denne måned', l.monthBest + ' kg']]));
    });
    // Planlagt vs gennemført
    var pl = rep.overall.planned;
    if (pl && pl.total >= 4 && pl.ratio != null) {
      if (pl.ratio >= T.plannedGood && !rep.partial) good.push(S('RP2', 'Du gennemførte ' + pl.completed + ' af ' + pl.total + ' planlagte pas (' + Math.round(pl.ratio * 100) + ' %).', [['Planlagt', pl.total], ['Gennemført', pl.completed]]));
      if (pl.ratio < T.plannedBad && !rep.partial) bad.push(S('RN4', 'Kun ' + pl.completed + ' af ' + pl.total + ' planlagte pas blev gennemført (' + Math.round(pl.ratio * 100) + ' %).', [['Planlagt', pl.total], ['Gennemført', pl.completed]]));
    }
    // Volumen / antal
    var d = rep.overall.volumeChange;
    if (!rep.partial) {
      if (prev.overall.sessions >= T.sessionsDropMinPrior && d.sessions != null && d.sessions <= -T.sessionsDropPct) bad.push(S('RN2', 'Antal pas faldt ' + Math.abs(d.sessions) + ' % (' + prev.overall.sessions + ' → ' + cur.overall.sessions + ').', [['Forrige måned', prev.overall.sessions], ['Denne måned', cur.overall.sessions]]));
      if (prev.running.km >= T.kmDropMinPrior && d.km != null && d.km <= -T.kmDropPct) bad.push(S('RN3', 'Løbe-km faldt ' + Math.abs(d.km) + ' % (' + prev.running.km + ' → ' + cur.running.km + ' km).', [['Forrige måned', prev.running.km + ' km'], ['Denne måned', cur.running.km + ' km']]));
    }
    if (prev.running.km >= T.kmGrowthMinPrior && d.km != null && d.km >= 0 && d.km <= T.kmGrowthMaxPct) good.push(S('RP3', 'Løbevolumen steg gradvist: ' + prev.running.km + ' → ' + cur.running.km + ' km (+' + d.km + ' %).', [['Forrige måned', prev.running.km + ' km'], ['Denne måned', cur.running.km + ' km']]));
    if (d.km != null && d.km > T.kmGrowthMaxPct && prev.running.km >= T.kmGrowthMinPrior) dev.push(S('', 'Løbevolumen steg ' + d.km + ' % (' + prev.running.km + ' → ' + cur.running.km + ' km) — hurtigere end 25 %; følg med i restitution.', [['Forrige måned', prev.running.km + ' km'], ['Denne måned', cur.running.km + ' km']]));
    if (d.sets != null && Math.abs(d.sets) >= 10 && prev.strength.sets >= 20) dev.push(S('', 'Styrkevolumen (arbejdssæt) ' + (d.sets > 0 ? 'steg ' : 'faldt ') + Math.abs(d.sets) + ' % (' + prev.strength.sets + ' → ' + cur.strength.sets + ' sæt).', [['Forrige måned', prev.strength.sets + ' sæt'], ['Denne måned', cur.strength.sets + ' sæt']]));
    // Tempo
    if (cur.running.paceRuns >= T.paceMinRuns && prev.running.paceRuns >= T.paceMinRuns && cur.running.paceSecPerKm && prev.running.paceSecPerKm) {
      var pd = pct(cur.running.paceSecPerKm, prev.running.paceSecPerKm); // positiv = langsommere
      if (pd >= T.paceSlowPct) bad.push(S('RN5', 'Snit-tempo er ' + pd + ' % langsommere end forrige måned. Hvis flere af månedens løb var rolige, er det forventeligt.', [['Forrige måned', fmtPace(prev.running.paceSecPerKm)], ['Denne måned', fmtPace(cur.running.paceSecPerKm)]]));
      else if (pd <= -T.paceSlowPct) good.push(S('', 'Snit-tempo er ' + Math.abs(pd) + ' % hurtigere end forrige måned (' + fmtPace(prev.running.paceSecPerKm) + ' → ' + fmtPace(cur.running.paceSecPerKm) + ').', [['Forrige måned', fmtPace(prev.running.paceSecPerKm)], ['Denne måned', fmtPace(cur.running.paceSecPerKm)]]));
    }
    // Mål
    if (rep.goals.achieved.length) good.push(S('RP4', rep.goals.achieved.length + ' løbemål nået i måneden.', rep.goals.achieved.map(function (g) { return [g.date, g.title]; })));
    if (rep.goals.missed.length) dev.push(S('', rep.goals.missed.length + ' mål havde deadline i måneden uden at være nået.', rep.goals.missed.map(function (g) { return [g.deadline, g.title]; })));
    // Evalueringer
    var ev = rep.evaluation;
    if (ev.n >= T.evalMin && (ev.as + ev.easier) > ev.harder * 2 && (ev.as + ev.easier) >= ev.n / 2) good.push(S('RP5', 'Af ' + ev.n + ' selvvurderinger føltes de fleste som ventet eller lettere (selvrapporteret).', [['Som ventet', ev.as], ['Lettere', ev.easier], ['Hårdere', ev.harder]]));
    Object.keys(ev.pain).forEach(function (p) { if (ev.pain[p] >= T.painMin) bad.push(S('RN6', p + ' er nævnt som ømhed/smerte i ' + ev.pain[p] + ' selvvurderinger (selvrapporteret — ikke en diagnose).', [[p, ev.pain[p] + ' gange']])); });
    // Kontinuitet
    if (!rep.partial && cur.overall.sessions > 0 && cur.overall.longestGapDays >= T.gapDays) bad.push(S('RN7', 'Længste pause uden registreret træning: ' + cur.overall.longestGapDays + ' dage.', [['Længste pause', cur.overall.longestGapDays + ' dage']]));
    // Fordeling + deload
    var sp = rep.overall.split;
    if (cur.overall.sessions >= 6 && prev.overall.sessions >= 6) {
      var ps = Math.round(prev.strength.sessions / prev.overall.sessions * 100);
      if (Math.abs(sp.strengthPct - ps) >= T.splitShiftPts) dev.push(S('', 'Fordelingen skiftede: styrke udgjorde ' + sp.strengthPct + ' % af pas (forrige måned ' + ps + ' %).', [['Styrke nu', sp.strengthPct + ' %'], ['Styrke før', ps + ' %']]));
    }
    if (cur.strength.deloadWeeks.length) dev.push(S('', 'Deload-uge(r) i måneden (styrke): uge ' + cur.strength.deloadWeeks.join(', ') + '.', [['Deload', cur.strength.deloadWeeks.join(', ')]]));
    // Fokus næste måned (afledt af ovenstående + mål)
    var has = function (arr, id) { return arr.some(function (x) { return x.rule === id; }); };
    if (has(bad, 'RN3') || has(bad, 'RN2')) focus.push(S('', 'Genopbyg kontinuiteten først: få faste, rolige pas pr. uge, før du øger fart eller vægt.', [['Begrundelse', 'Færre pas/km end forrige måned']]));
    if (has(bad, 'RN4')) focus.push(S('', 'Gør ugeplanen mere realistisk (færre, men gennemførte pas) — brug kalenderens "flyt"/"kan ikke i dag".', [['Begrundelse', 'Under 60 % af planen gennemført']]));
    if (has(bad, 'RN6')) focus.push(S('', 'Følg op på de nævnte ømme områder (selvrapporteret). Overvej lettere belastning i den periode — og tal med en fagperson, hvis det fortsætter.', [['Begrundelse', 'Gentagen ømhed i selvvurderinger']]));
    if (has(bad, 'RN1')) focus.push(S('', 'Tjek restitution og RPE-aflæsning, før vægten øges — et lavere e1RM kan være variation.', [['Begrundelse', 'Lavere e1RM på hovedløft']]));
    if (has(bad, 'RN5')) focus.push(S('', 'Skil rolige og hårde løb ad, så tempo-sammenligningen bliver mere retvisende.', [['Begrundelse', 'Langsommere snit-tempo']]));
    if (good.some(function (x) { return x.rule === 'RP1'; })) focus.push(S('', 'Bevar det der virker på de løft, der satte rekord — undgå store spring i vægt.', [['Begrundelse', 'Ny bedste e1RM']]));
    if (rep.goals.focus === 'run') focus.push(S('', 'Dit fokus er løbepræstation: beskyt hårde løb og hold styrke på vedligeholdelse, når en dato nærmer sig.', [['Fokus', 'Løb']]));
    if (rep.goals.focus === 'strength' || rep.goals.focus === 'hypertrophy') focus.push(S('', 'Dit fokus er ' + (rep.goals.focus === 'strength' ? 'styrke' : 'hypertrofi') + ': beskyt styrkepasene og hold løb roligt, hvor det støder sammen.', [['Fokus', rep.goals.focus]]));
    if (!good.length && !dev.length && !bad.length) dev.push(S('', 'For lidt data i måneden til at drage konklusioner.', [['Pas', rep.overall.sessions]]));
    return { good: good, developed: dev, regressed: bad, focus: focus.slice(0, 5) };
  };
  function fmtPace(sec) { var m = Math.floor(sec / 60), s = Math.round(sec % 60); if (s === 60) { m++; s = 0; } return m + ':' + pad(s) + ' /km'; }
  R.fmtPace = fmtPace;

  // ── Eksport ────────────────────────────────────────────────────────────────
  var esc = function (t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  R.toText = function (rep) {
    var L = [], c = rep.conclusion;
    L.push('MÅNEDSRAPPORT — ' + rep.label + (rep.partial ? ' (måneden er ikke slut)' : '')); L.push(rep.note); L.push('');
    L.push('STYRKE: ' + rep.strength.sessions + ' pas (' + rep.strength.perWeek + '/uge), ' + rep.strength.sets + ' arbejdssæt, tonnage ' + rep.strength.tonnage + ' kg');
    Object.keys(rep.strength.lifts).forEach(function (k) { var l = rep.strength.lifts[k]; L.push('  ' + l.label + ': bedste e1RM i måneden ' + (l.monthBest != null ? l.monthBest + ' kg' : '—') + ' (før: ' + (l.priorBest != null ? l.priorBest + ' kg' : '—') + ')'); });
    L.push('LØB: ' + rep.running.runs + ' ture, ' + rep.running.km + ' km, snit ' + rep.running.avgKm + ' km, længste ' + r1(rep.running.longestKm) + ' km' + (rep.running.paceSecPerKm ? ', snit-tempo ' + fmtPace(rep.running.paceSecPerKm) : ''));
    L.push('SAMLET: ' + rep.overall.sessions + ' pas på ' + rep.overall.trainingDays + ' dage; længste pause ' + rep.overall.longestGapDays + ' dage' + (rep.overall.planned ? '; planlagt ' + rep.overall.planned.total + ', gennemført ' + rep.overall.planned.completed : ''));
    if (rep.evaluation.n) L.push('SELVVURDERING (selvrapporteret): ' + rep.evaluation.n + ' svar' + (rep.evaluation.avgEffort != null ? ', snit anstrengelse ' + rep.evaluation.avgEffort + '/10' : ''));
    [['HVAD GIK GODT', c.good], ['HVAD UDVIKLEDE SIG', c.developed], ['HVAD GIK TILBAGE', c.regressed], ['FOKUS NÆSTE MÅNED', c.focus]].forEach(function (g) { L.push(''); L.push(g[0]); if (!g[1].length) L.push('  —'); g[1].forEach(function (x) { L.push('  • ' + x.text + (x.rule ? ' [' + x.rule + ']' : '')); }); });
    return L.join('\n');
  };
  R.toHtml = function (rep) {
    var c = rep.conclusion, sec = function (t, arr) { return '<h2>' + t + '</h2>' + (arr.length ? '<ul>' + arr.map(function (x) { return '<li>' + esc(x.text) + (x.rule ? ' <small>[' + esc(x.rule) + ']</small>' : '') + (x.basis.length ? '<br><small>Grundlag: ' + x.basis.map(function (b) { return esc(b[0]) + ': ' + esc(b[1]); }).join(' · ') + '</small>' : '') + '</li>'; }).join('') + '</ul>' : '<p>—</p>'); };
    return '<!doctype html><html lang="da"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Månedsrapport ' + esc(rep.label) + '</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:760px;margin:24px auto;padding:0 16px;color:#1b1d22}h1{font-size:22px}h2{font-size:17px;margin-top:22px;border-bottom:1px solid #ccc;padding-bottom:4px}small{color:#555}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:4px 6px;text-align:left}.note{background:#f3efe2;padding:8px 10px;border-radius:6px}</style></head><body><h1>Månedsrapport — ' + esc(rep.label) + '</h1><p class="note">' + esc(rep.note) + (rep.partial ? ' Måneden er ikke slut — tallene er foreløbige.' : '') + '</p>' +
      '<h2>Styrke</h2><table><tr><th>Pas</th><td>' + rep.strength.sessions + ' (' + rep.strength.perWeek + ' pr. uge)</td></tr><tr><th>Arbejdssæt</th><td>' + rep.strength.sets + '</td></tr><tr><th>Tonnage</th><td>' + rep.strength.tonnage + ' kg</td></tr>' +
      Object.keys(rep.strength.lifts).map(function (k) { var l = rep.strength.lifts[k]; return '<tr><th>' + esc(l.label) + ' (bedste e1RM)</th><td>' + (l.monthBest != null ? l.monthBest + ' kg' : '—') + ' <small>(før måneden: ' + (l.priorBest != null ? l.priorBest + ' kg' : '—') + ')</small></td></tr>'; }).join('') + '</table>' +
      '<h2>Løb</h2><table><tr><th>Ture</th><td>' + rep.running.runs + '</td></tr><tr><th>Distance</th><td>' + rep.running.km + ' km (snit ' + rep.running.avgKm + ' km, længste ' + r1(rep.running.longestKm) + ' km)</td></tr>' + (rep.running.paceSecPerKm ? '<tr><th>Snit-tempo</th><td>' + fmtPace(rep.running.paceSecPerKm) + '</td></tr>' : '') + '</table>' +
      '<h2>Samlet</h2><table><tr><th>Pas i alt</th><td>' + rep.overall.sessions + ' på ' + rep.overall.trainingDays + ' dage</td></tr>' + (rep.overall.planned ? '<tr><th>Planlagt / gennemført</th><td>' + rep.overall.planned.total + ' / ' + rep.overall.planned.completed + '</td></tr>' : '') + '<tr><th>Længste pause</th><td>' + rep.overall.longestGapDays + ' dage</td></tr></table>' +
      sec('Hvad gik godt', c.good) + sec('Hvad udviklede sig', c.developed) + sec('Hvad gik tilbage', c.regressed) + sec('Fokus næste måned', c.focus) + '<p><small>Genereret ' + new Date(rep.generatedAt).toISOString().slice(0, 10) + ' · regelbaseret, ingen AI · selvvurderinger er selvrapporterede.</small></p></body></html>';
  };
  return R;
});
