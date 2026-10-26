/* tp-plan.js — Samlet kalender + hybrid belastning (V3 fase 3). DOM-fri, ren logik; kræver tp-core.js.
   Bygger OVEN PÅ dashboardets eksisterende ugeplan (slotForDate) — ingen parallel planlægning.
   Alle regler er konservative, forklarede og dokumenterede (se P.RULES og docs/hybrid-regler.md).
   Ingen medicinske diagnoser. Selvrapporterede data (evalueringer) vises aldrig som fysiologiske målinger. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./tp-core.js'));
  else root.TPPLAN = factory(root.TP);
})(typeof self !== 'undefined' ? self : this, function (TP) {
  'use strict';
  var P = {};
  var DA = ['søn', 'man', 'tir', 'ons', 'tor', 'fre', 'lør'];
  var dow = function (iso) { return new Date(iso + 'T12:00:00').getDay(); };
  P.dayName = function (iso) { return DA[dow(iso)]; };
  var fmt = function (iso) { return P.dayName(iso) + ' ' + iso.slice(8, 10) + '/' + iso.slice(5, 7); };
  P.fmtDate = fmt;

  // ── Tærskler (alle ét sted, så de kan dokumenteres og testes) ──────────────
  P.TH = {
    adjacencyDays: 1,        // R1/R2: "tæt på" = samme dag eller ±1 dag
    consecutiveIntensive: 3, // R3: antal intensive dage i træk
    consecutiveTraining: 5,  // R3b: træningsdage i træk uden hvile (kun info)
    runKmJump: 1.3,          // R4: ugens løbe-km i forhold til snit af de foregående uger
    runKmJumpMinDelta: 4,    // R4: og mindst +4 km, så små tal ikke udløser advarsel
    setsJump: 1.3, setsJumpMinDelta: 10, // R4b: styrkesæt (info)
    minRestDaysPerWeek: 1,   // R5
    fatigueTrainingDays: 5,  // R6: træningsdage de seneste 7 dage
    taperHeavyLowerDays: 3,  // R7: tung benstyrke tættere end 3 dage på et løb
    taperHardRunDays: 2,     // R7: hård løbetur tættere end 2 dage på et løb
    moveSearchDays: 3        // forslag: flyt løb højst ±3 dage
  };
  P.RULES = [
    { id: 'R1', name: 'Tung benstyrke tæt på hårdt løb', text: 'Tung squat/dødløft (ikke deload) samme dag eller ±1 dag fra et hårdt løb (intervaller/tempo/langt). Begge belaster benene; hård løbetur lige før/efter tung benstyrke forringer typisk begge pas.' },
    { id: 'R2', name: 'Dødløft tæt på langt løb', text: 'Dødløfts-dag samme dag eller ±1 dag fra et langt løb (≥ 1,4× dit snit og ≥ 8 km). Lænd/baglår belastes fra begge sider.' },
    { id: 'R3', name: 'Flere intensive dage i træk', text: '3 eller flere dage i træk, hvor hver dag har tung benstyrke eller hårdt løb. (Info: 5+ dage i træk uden restitutionsdag.)' },
    { id: 'R4', name: 'Markant volumenstigning', text: 'Ugens løbe-km mere end 1,3× snittet af de op til 3 foregående uger (og mindst +4 km). Styrkesæt: samme tærskel, vises kun som info.' },
    { id: 'R5', name: 'Ingen restitutionsdag', text: 'En uge (man–søn) uden en eneste restitutionsdag. Restitutionsdag = ingen styrketræning og intet hårdt løb; et roligt løb tæller som aktiv restitution.' },
    { id: 'R6', name: 'Mulig ophobet træthed', text: '≥ 5 træningsdage i de seneste 7 dage OG dine egne efter-træning-svar viser et gentaget mønster (min. 3 svar: hårdere end ventet / lav energi). Selvrapporteret — ikke en måling.' },
    { id: 'R7', name: 'Tæt på løbsmål', text: 'Tung benstyrke inden for 3 dage før et registreret løb, eller hårdt løb 1–2 dage før.' }
  ];

  // ── Klassificering ─────────────────────────────────────────────────────────
  // Gennemført løb → 'hard' / 'long' / 'easy'. ctx: {maxHR, medianKm}
  P.classifyRun = function (run, ctx) {
    ctx = ctx || {}; var km = +run.distanceKm || 0, out = { hard: false, long: false, load: 'easy' };
    var maxHR = +ctx.maxHR || 0, avg = +run.avgHR || 0;
    if (maxHR > 0 && avg > 0 && avg >= 0.82 * maxHR) { out.hard = true; out.load = 'hard'; }
    var med = +ctx.medianKm || 0;
    if (km >= 8 && med > 0 && km >= 1.4 * med) { out.long = true; out.hard = true; out.load = 'long'; }
    return out;
  };

  // ── Opbyg dage ─────────────────────────────────────────────────────────────
  // opts: {from, days, doneFn(date)->items[], plannedFn(date)->items[], markersFn(date)->markers[], changes}
  P.buildDays = function (opts) {
    var days = [], i, date, items;
    for (i = 0; i < opts.days; i++) {
      date = TP.addDays(opts.from, i);
      items = (opts.doneFn ? opts.doneFn(date) : []).concat(opts.plannedFn ? opts.plannedFn(date) : []);
      days.push({ date: date, items: items.map(function (x) { return Object.assign({}, x); }), markers: opts.markersFn ? opts.markersFn(date) : [] });
    }
    return P.applyChanges(days, opts.changes || []);
  };
  P.applyChanges = function (days, changes) {
    var by = {}; days.forEach(function (d) { by[d.date] = d; });
    var stale = [];
    var plannedRun = function (date) { var d = by[date]; return d ? d.items.filter(function (x) { return x.kind === 'run' && x.status === 'planned'; })[0] : null; };
    (changes || []).forEach(function (c) {
      var it, d;
      if (c.type === 'moveRun') {
        it = plannedRun(c.from); d = by[c.to];
        if (!it || !d || c.from === c.to) { stale.push(c.id); return; }
        by[c.from].items.splice(by[c.from].items.indexOf(it), 1);
        it.movedFrom = c.from; it.changeId = c.id; d.items.push(it);
      } else if (c.type === 'easyRun') {
        it = plannedRun(c.date); if (!it) { stale.push(c.id); return; }
        it.hard = false; it.long = false; it.load = 'easy'; it.label = 'Let løb'; it.easied = true; it.changeId = c.id;
      } else if (c.type === 'skipRun') {
        it = plannedRun(c.date); if (!it) { stale.push(c.id); return; }
        it.status = 'skipped'; it.changeId = c.id;
      } else if (c.type === 'swapRun') {
        var a = plannedRun(c.a), b = plannedRun(c.b);
        if (!a || !b || !by[c.a] || !by[c.b]) { stale.push(c.id); return; }
        by[c.a].items.splice(by[c.a].items.indexOf(a), 1); by[c.b].items.splice(by[c.b].items.indexOf(b), 1);
        a.movedFrom = c.a; b.movedFrom = c.b; a.changeId = b.changeId = c.id; by[c.b].items.push(a); by[c.a].items.push(b);
      } // 'skipSbd' er en log-post: selve skiftet sker i det eksisterende blokerede-dage-sæt (se plannedFn)
    });
    days.stale = stale; return days;
  };

  // ── Analyse ────────────────────────────────────────────────────────────────
  var active = function (d) { return d.items.filter(function (x) { return x.status !== 'skipped'; }); };
  var isHeavyLower = function (x) { return x.kind === 'sbd' && x.lower && x.hard; };
  var isHardRun = function (x) { return x.kind === 'run' && x.hard; };
  var isIntensive = function (x) { return isHeavyLower(x) || isHardRun(x); };
  // Restitutionsdag = ingen styrketræning og ingen hårdt løb. Et roligt løb tæller som aktiv restitution (Olivers rytme har ingen helt fri dag).
  var isRecoveryDay = function (d) { return !active(d).some(function (x) { return x.kind === 'sbd' || isHardRun(x); }); };

  // ctx: {today, weekly:{runKm:{mondayISO:km}, sbdSets:{...}}, evalPattern, dismissed, races:[]}
  P.analyze = function (days, ctx) {
    ctx = ctx || {}; var out = [], by = {}, n = days.length;
    days.forEach(function (d) { by[d.date] = d; });
    var today = ctx.today || (days[0] && days[0].date), adj = P.TH.adjacencyDays;
    var add = function (f) { f.dismissed = !!(ctx.dismissed && ctx.dismissed[f.key]); out.push(f); };

    days.forEach(function (d) {
      active(d).forEach(function (s) {
        if (!isHeavyLower(s) && !(s.kind === 'sbd' && s.hinge && s.hard)) return;
        for (var k = -adj; k <= adj; k++) {
          var o = by[TP.addDays(d.date, k)]; if (!o) continue;
          active(o).forEach(function (r) {
            if (r.kind !== 'run') return;
            if (isHeavyLower(s) && r.hard) {
              var when = k === 0 ? 'samme dag' : (k < 0 ? 'dagen før' : 'dagen efter');
              add({ key: 'R1:' + d.date + ':' + o.date, rule: 'R1', level: 'warn', dates: [d.date, o.date].sort(),
                title: 'Tung benstyrke (' + s.label + ', ' + fmt(d.date) + ') og hårdt løb (' + fmt(o.date) + ') ' + (k === 0 ? 'på samme dag' : 'tæt på hinanden'),
                why: 'Hårdt løb ligger ' + when + ' ' + (k === 0 ? 'som' : (k < 0 ? 'efter' : 'før')) + ' tung ' + s.label + '. Begge pas belaster ben og hofter; det forringer ofte kvaliteten af begge.',
                consequence: 'Hvis du ignorerer: begge pas køres på trætte ben — højere belastning og lavere sandsynlighed for at ramme de planlagte vægte/tempo.',
                facts: [s.label + ' ' + fmt(d.date) + ' (tung)', r.label + ' ' + fmt(o.date) + (r.long ? ' (langt)' : ' (hårdt)')], movable: [{ kind: 'run', date: o.date, id: r.id }, { kind: 'sbd', date: d.date, id: s.id }] });
            }
            if (s.hinge && r.long) {
              add({ key: 'R2:' + d.date + ':' + o.date, rule: 'R2', level: 'warn', dates: [d.date, o.date].sort(),
                title: 'Dødløft (' + fmt(d.date) + ') tæt på langt løb (' + fmt(o.date) + ')',
                why: 'Dødløft og langt løb belaster begge lænd og baglår. Samme dag eller ±1 dag giver lidt restitution imellem.',
                consequence: 'Hvis du ignorerer: øget træthed i baglår/lænd; vægten eller løbetempoet kan blive lavere end planlagt.',
                facts: [s.label + ' ' + fmt(d.date), r.label + ' ' + fmt(o.date) + ' (langt)'], movable: [{ kind: 'run', date: o.date, id: r.id }, { kind: 'sbd', date: d.date, id: s.id }] });
            }
          });
        }
      });
    });

    // R3: intensive dage i træk + R3b: træningsdage i træk
    var run = [], runT = [], mov = function (arr, onlyIntensive) {
      var m = []; arr.forEach(function (dt) { active(by[dt]).forEach(function (x) { if (x.status === 'planned' && (!onlyIntensive || isIntensive(x))) m.push({ kind: x.kind, date: dt, id: x.id }); }); }); return m;
    };
    var flush = function (arr, minLen, rule, level, titleFn, why, cons) {
      if (arr.length >= minLen) add({ key: rule + ':' + arr[0] + ':' + arr[arr.length - 1], rule: rule, level: level, dates: arr.slice(), title: titleFn(arr), why: why, consequence: cons, facts: arr.map(fmt), movable: mov(arr, rule === 'R3') });
    };
    var f3 = function () { flush(run, P.TH.consecutiveIntensive, 'R3', 'warn', function (a) { return a.length + ' intensive dage i træk (' + fmt(a[0]) + ' – ' + fmt(a[a.length - 1]) + ')'; },
      'Hver af dagene har tung benstyrke eller et hårdt løb, uden en rolig dag imellem.', 'Hvis du ignorerer: restitutionen bliver kortere end belastningen — risiko for dårligere pas og ophobet træthed.'); run = []; };
    var f5 = function () { flush(runT, P.TH.consecutiveTraining, 'R3b', 'info', function (a) { return a.length + ' dage i træk uden restitutionsdag (' + fmt(a[0]) + ' – ' + fmt(a[a.length - 1]) + ')'; },
      'Hver dag har styrketræning eller hårdt løb. (En dag med kun roligt løb eller hvile tæller som restitutionsdag.)', 'Hvis du ignorerer: ingen lettere dag til restitution. Vurder selv, om det passer til dig.'); runT = []; };
    days.forEach(function (d) {
      var a = active(d);
      if (a.some(isIntensive)) run.push(d.date); else f3();
      if (!isRecoveryDay(d)) runT.push(d.date); else f5();
    }); f3(); f5();

    // R4: volumenstigning (denne uge vs. foregående uger)
    var wk = TP.weekStart(today), w = ctx.weekly || {};
    var jump = function (series, th, minDelta, unit, rule, level, name) {
      if (!series) return;
      var prior = []; for (var i = 1; i <= 3; i++) { var k = TP.addDays(wk, -7 * i); if (series[k] != null) prior.push(series[k]); }
      if (prior.length < 2 || series[wk] == null) return;
      var avg = prior.reduce(function (a, b) { return a + b; }, 0) / prior.length; if (!avg) return;
      var cur = series[wk], ratio = cur / avg;
      if (ratio > th && cur - avg >= minDelta) add({ key: rule + ':' + wk, rule: rule, level: level, dates: [wk],
        title: name + ' denne uge: ' + Math.round(cur * 10) / 10 + ' ' + unit + ' (' + Math.round(ratio * 100) + ' % af snit ' + Math.round(avg * 10) / 10 + ')',
        why: 'Ugen ligger ' + Math.round((ratio - 1) * 100) + ' % over snittet af de ' + prior.length + ' foregående uger. Hurtige stigninger giver oftere ømhed og træthed end gradvise.',
        consequence: 'Hvis du ignorerer: kroppen får mindre tid til at tilpasse sig. Ugen er ikke slut endnu — tallet kan stige yderligere.', facts: ['Denne uge: ' + Math.round(cur * 10) / 10 + ' ' + unit, 'Snit foregående: ' + Math.round(avg * 10) / 10 + ' ' + unit], movable: [] });
    };
    jump(w.runKm, P.TH.runKmJump, P.TH.runKmJumpMinDelta, 'km løb', 'R4', 'warn', 'Løbevolumen');
    jump(w.sbdSets, P.TH.setsJump, P.TH.setsJumpMinDelta, 'sæt styrke', 'R4b', 'info', 'Styrkevolumen');

    // R5: ugevis hviledage (kun uger der berører i dag → frem)
    var weeks = {}; days.forEach(function (d) { if (d.date >= TP.weekStart(today)) (weeks[TP.weekStart(d.date)] = weeks[TP.weekStart(d.date)] || []).push(d); });
    Object.keys(weeks).forEach(function (k) {
      var ds = weeks[k]; if (ds.length < 7) return; // kun hele uger vi kan se
      var rest = ds.filter(isRecoveryDay).length;
      if (rest < P.TH.minRestDaysPerWeek) add({ key: 'R5:' + k, rule: 'R5', level: 'warn', dates: [k],
        title: 'Ingen restitutionsdag i ugen fra ' + fmt(k), why: 'Alle 7 dage har styrketræning eller hårdt løb. Et roligt løb eller en pause tæller som restitutionsdag.', consequence: 'Hvis du ignorerer: ingen lettere dag i ugen — overvej at gøre ét pas roligt eller holde fri.', facts: ds.map(function (d) { return fmt(d.date) + ': ' + (active(d).map(function (x) { return x.label; }).join(' + ')); }), movable: mov(ds.map(function (d) { return d.date; }), true) });
    });

    // R6: ophobet træthed — kun med ≥3 selvrapporterede svar OG høj frekvens
    var ep = ctx.evalPattern;
    if (ep && ep.notes && ep.notes.length && ep.n >= 3) {
      var last7 = days.filter(function (d) { return d.date <= today && d.date > TP.addDays(today, -7); }).filter(function (d) { return active(d).some(function (x) { return x.status === 'done'; }); }).length;
      if (last7 >= P.TH.fatigueTrainingDays) add({ key: 'R6:' + TP.weekStart(today), rule: 'R6', level: 'warn', dates: [today],
        title: 'Mulig ophobet træthed: ' + last7 + ' træningsdage på 7 dage + dine svar', why: 'Dine egne efter-træning-svar viser et gentaget mønster, og frekvensen er høj. Det er selvrapporteret og ikke en måling.',
        consequence: 'Hvis du ignorerer: intet sker automatisk. Overvej en let dag/deload hvis du også selv oplever træthed.', facts: ep.notes.slice(), movable: [] });
    }

    // R7: løbsmål
    (ctx.races || []).forEach(function (r) {
      for (var dd = 1; dd <= P.TH.taperHeavyLowerDays; dd++) { // dage før løbet
        var day = by[TP.addDays(r.date, -dd)]; if (!day) continue;
        active(day).forEach(function (x) {
          if (isHeavyLower(x)) add({ key: 'R7:' + day.date + ':' + r.date, rule: 'R7', level: 'warn', dates: [day.date, r.date], title: 'Tung benstyrke ' + fmt(day.date) + ', ' + dd + ' dag(e) før ' + (r.label || 'løb') + ' (' + fmt(r.date) + ')',
            why: 'Tung squat/dødløft de sidste ' + P.TH.taperHeavyLowerDays + ' dage før et løb giver ofte tunge ben på løbsdagen.', consequence: 'Hvis du ignorerer: risiko for tunge ben til løbet.', facts: [x.label + ' ' + fmt(day.date), (r.label || 'Løb') + ' ' + fmt(r.date)], movable: [{ kind: 'sbd', date: day.date, id: x.id }] });
          if (isHardRun(x) && dd <= P.TH.taperHardRunDays) add({ key: 'R7r:' + day.date + ':' + r.date, rule: 'R7', level: 'warn', dates: [day.date, r.date], title: 'Hårdt løb ' + fmt(day.date) + ', ' + dd + ' dag(e) før ' + (r.label || 'løb'),
            why: 'Hårde pas lige før et løb æder af formen i stedet for at bygge den.', consequence: 'Hvis du ignorerer: mindre frisk på løbsdagen.', facts: [x.label + ' ' + fmt(day.date)], movable: [{ kind: 'run', date: day.date, id: x.id }] });
        });
      }
    });
    return out;
  };
  P.visible = function (findings) { return findings.filter(function (f) { return !f.dismissed; }); };
  P.warnCount = function (findings) { return findings.filter(function (f) { return f.level === 'warn' && !f.dismissed; }).length; };

  // ── Forslag til omlægning (aldrig automatisk) ──────────────────────────────
  // ctx: {rebuild(extraChanges, extraBlocked)->days, analyzeCtx, today, focus, runsFixed, raceNear(dateISO)->bool, changes}
  P.suggest = function (finding, ctx) {
    var base = P.warnCount(P.analyze(ctx.rebuild([], []), ctx.analyzeCtx)), opts = [], focus = ctx.focus || 'balanced';
    var tryChange = function (label, change, extraBlocked, consequence, because) {
      var after = P.analyze(ctx.rebuild(change ? [change] : [], extraBlocked || []), ctx.analyzeCtx);
      var gone = !after.some(function (f) { return f.key === finding.key && !f.dismissed; });
      var cnt = P.warnCount(after);
      var better = finding.level === 'warn' ? cnt < base : cnt <= base;
      if (gone && better) opts.push({ label: label, change: change, extraBlocked: extraBlocked || [], after: cnt, before: base, consequence: consequence, because: because || null, resolves: gone });
    };
    (finding.movable || []).forEach(function (m) {
      if (m.date < ctx.today) return;
      if (m.kind === 'run') {
        var raceProtect = focus === 'run' && ctx.raceNear && ctx.raceNear(m.date) && true;
        if (!ctx.runsFixed) for (var k = 1; k <= P.TH.moveSearchDays; k++) [k, -k].forEach(function (dd) {
          var to = TP.addDays(m.date, dd); if (to < ctx.today) return;
          tryChange('Flyt løbet fra ' + fmt(m.date) + ' til ' + fmt(to), { id: 'tmp', type: 'moveRun', from: m.date, to: to }, [],
            'Kun løbet flyttes. Styrkeprogrammet, cyklus og progression påvirkes ikke.', focus === 'strength' ? 'Dit fokus er styrke: tunge styrkepas flyttes ikke — løbet viger.' : null);
        });
        if (!raceProtect) {
          var it = ctx.rebuild([], []).reduce(function (a, d) { return a || (d.date === m.date ? d.items.filter(function (x) { return x.kind === 'run' && x.status === 'planned'; })[0] : null); }, null);
          if (it && it.hard) tryChange('Gør løbet ' + fmt(m.date) + ' til et roligt løb', { id: 'tmp', type: 'easyRun', date: m.date }, [],
            'Dagens hårde løb erstattes af et roligt (zone 1–2). Ugens kvalitetsløb udgår — det kan påvirke løbemålene lidt.', null);
        }
      } else if (m.kind === 'sbd') {
        if (focus === 'strength') return; // beskytter tunge styrkepas
        tryChange('Ryk styrkepasset ' + fmt(m.date) + ' én dag frem ("Kan ikke i dag")', { id: 'tmp', type: 'skipSbd', date: m.date }, [m.date],
          'Bruger den eksisterende "Kan ikke i dag"-funktion: styrkedagene rykkes én dag frem, rækkefølgen (og dermed progressionen) er uændret.', focus === 'run' ? 'Dit fokus er løb: det hårde løb beskyttes, styrkepasset rykkes.' : null);
      }
    });
    var order = focus === 'run' ? { skipSbd: 0, moveRun: 1, easyRun: 2 } : { moveRun: 0, easyRun: 1, skipSbd: 2 };
    var rank = function (o) { return order[o.change.type] != null ? order[o.change.type] : 9; };
    opts.sort(function (a, b) { return (a.after - b.after) || (rank(a) - rank(b)); });
    // mangfoldighed: bedste forslag af hver type først, derefter resten — maks 3 i alt
    var seen = {}, out = [], types = {};
    opts.forEach(function (o) { var t = o.change.type, k = JSON.stringify(o.change); if (!types[t] && !seen[k]) { types[t] = 1; seen[k] = 1; out.push(o); } });
    opts.forEach(function (o) { var k = JSON.stringify(o.change); if (!seen[k] && out.length < 3) { seen[k] = 1; out.push(o); } });
    out.sort(function (a, b) { return (a.after - b.after) || (rank(a) - rank(b)); });
    out = out.slice(0, 3);
    return out;
  };

  // ── Overblik (ingen samlet score) ──────────────────────────────────────────
  // win: antal dage bagud fra today (inkl. i dag)
  P.overview = function (days, today, win) {
    var from = TP.addDays(today, -(win - 1)), inWin = days.filter(function (d) { return d.date >= from && d.date <= today; });
    var done = []; inWin.forEach(function (d) { d.items.forEach(function (x) { if (x.status === 'done') done.push({ date: d.date, it: x }); }); });
    var sbd = done.filter(function (x) { return x.it.kind === 'sbd'; }), runs = done.filter(function (x) { return x.it.kind === 'run'; });
    var trainDays = {}; done.forEach(function (x) { trainDays[x.date] = 1; });
    var km = runs.reduce(function (a, x) { return a + (+x.it.km || 0); }, 0);
    var hardDays = {}; done.forEach(function (x) { if (isIntensive(x.it)) hardDays[x.date] = 1; });
    var coincide = 0; Object.keys(hardDays).forEach(function (d) { var hasL = done.some(function (x) { return x.date === d && isHeavyLower(x.it); }), hasR = done.some(function (x) { return x.date === d && isHardRun(x.it); }); if (hasL && hasR) coincide++; });
    return { windowDays: win, strengthSessions: sbd.length, heavyLower: sbd.filter(function (x) { return isHeavyLower(x.it); }).length,
      runs: runs.length, runKm: Math.round(km * 10) / 10, hardRuns: runs.filter(function (x) { return isHardRun(x.it); }).length, longestRunKm: runs.reduce(function (a, x) { return Math.max(a, +x.it.km || 0); }, 0),
      trainingDays: Object.keys(trainDays).length, restDays: win - Object.keys(trainDays).length, intensiveDays: Object.keys(hardDays).length, sameDayHard: coincide };
  };

  // ── Ændringslog (tp_meta.planChanges) ──────────────────────────────────────
  P.newChange = function (change, now) { return Object.assign({ id: TP.uid('chg'), at: now || Date.now() }, change); };
  P.addChange = function (meta, change) { meta.planChanges = (meta.planChanges || []).concat([change]); return meta; };
  P.removeChange = function (meta, id) { meta.planChanges = (meta.planChanges || []).filter(function (c) { return c.id !== id; }); return meta; };
  // Beskriv en ændring på dansk (til listen + fortryd)
  P.describe = function (c) {
    if (c.type === 'moveRun') return 'Løb flyttet ' + fmt(c.from) + ' → ' + fmt(c.to);
    if (c.type === 'easyRun') return 'Løb ' + fmt(c.date) + ' gjort til roligt løb';
    if (c.type === 'skipRun') return 'Løb ' + fmt(c.date) + ' sprunget over';
    if (c.type === 'swapRun') return 'Løb byttet mellem ' + fmt(c.a) + ' og ' + fmt(c.b);
    if (c.type === 'skipSbd') return 'Styrke ' + fmt(c.date) + ' rykket én dag frem';
    return c.type;
  };
  // Fjern forældede ændringer (løb der ikke længere findes / datoer i fortiden) — returnerer nye meta
  P.pruneChanges = function (changes, today) {
    return (changes || []).filter(function (c) { var d = c.date || c.to || c.b || c.from; return !d || d >= TP.addDays(today, -14); });
  };
  return P;
});
