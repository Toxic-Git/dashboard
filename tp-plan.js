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
    moveSearchDays: 3,       // forslag: flyt løb højst ±3 dage
    hardHrPct: 0.80,         // gennemført løb: gns.puls ≥ 80 % af maxpuls = Zone 4+ i løb-appens egne zoner (V3.1: var 82 %)
    steadyHrPct: 0.70,       // 70–80 % = Zone 3 ("moderat"/jævn); under = roligt
    longRunMinKm: 8, longRunFactor: 1.4 // "langt løb": ≥ 8 km og ≥ 1,4× dit snit (de seneste 12 løb)
  };
  P.RULES = [
    { id: 'R1', name: 'Tung benstyrke tæt på hårdt løb', text: 'Tung squat/dødløft (ikke deload) samme dag eller ±1 dag fra et hårdt løb (intervaller/tempo/langt). Begge belaster benene; hård løbetur lige før/efter tung benstyrke forringer typisk begge pas.' },
    { id: 'R1b', name: 'Benvolumen/teknik tæt på hårdt løb', text: 'Underkropsdag med teknik/moderat belastning (fx box squat, rumænsk dødløft, hip thrust, benpres/-curl) samme dag eller ±1 dag fra et hårdt løb. Mindre belastende end tung benstyrke → kun info.' },
    { id: 'R2', name: 'Dødløft tæt på langt løb', text: 'Tung dødløfts-dag samme dag eller ±1 dag fra et langt løb (≥ 1,4× dit snit og ≥ 8 km). Lænd/baglår belastes fra begge sider.' },
    { id: 'R2b', name: 'Dødløftsteknik tæt på langt løb', text: 'Som R2, men for den lettere dødløftsvariant (fx deficit-dødløft 3×3) — kun info.' },
    { id: 'R8', name: 'Hårde pas lige efter hinanden', text: 'To hårde løb, eller to tunge benstyrkedage, på hinanden følgende dage (uden en rolig dag imellem). Kombinationen tung benstyrke + hårdt løb dækkes af R1.' },
    { id: 'R3', name: 'Flere intensive dage i træk', text: '3 eller flere dage i træk, hvor hver dag har tung benstyrke eller hårdt løb. (Info: 5+ dage i træk uden restitutionsdag.)' },
    { id: 'R4', name: 'Markant volumenstigning', text: 'Ugens løbe-km mere end 1,3× snittet af de op til 3 foregående uger (og mindst +4 km). Styrkesæt: samme tærskel, vises kun som info.' },
    { id: 'R5', name: 'Ingen restitutionsdag', text: 'En uge (man–søn) uden en eneste restitutionsdag. Restitutionsdag = ingen styrketræning og intet hårdt løb; et roligt løb tæller som aktiv restitution.' },
    { id: 'R6', name: 'Mulig ophobet træthed', text: '≥ 5 træningsdage i de seneste 7 dage OG dine egne efter-træning-svar viser et gentaget mønster (min. 3 svar: hårdere end ventet / lav energi). Selvrapporteret — ikke en måling.' },
    { id: 'R7', name: 'Tæt på løbsmål', text: 'Tung benstyrke inden for 3 dage før et registreret løb, eller hårdt løb 1–2 dage før.' }
  ];

  // ── Klassificering ─────────────────────────────────────────────────────────
  // Gennemført løb → intensitet + type. ctx: {maxHR, medianKm, raceDate}
  // Princip: kun det data understøtter. Appen logger IKKE om et løb var intervaller/tempo — kun distance, tid, puls, følelse og højdemeter.
  // Derfor skelnes: lang (distance), hård (puls ≥ 80 % af maxpuls), jævn/moderat (70–80 %), rolig (< 70 %), konkurrence (dato = løbsmål).
  // Uden pulsdata klassificeres løbet som "ukendt intensitet" og regnes som roligt — det opfindes ikke.
  P.classifyRun = function (run, ctx) {
    ctx = ctx || {}; var km = +run.distanceKm || 0, T = P.TH;
    var out = { hard: false, long: false, load: 'easy', kind: 'easy', kindLabel: 'Roligt løb', basis: '', confidence: 'middel', limits: [] };
    var maxHR = +ctx.maxHR || 0, avg = +run.avgHR || 0, med = +ctx.medianKm || 0;
    if (maxHR > 0 && avg > 0) {
      var pct = avg / maxHR;
      if (pct >= T.hardHrPct) { out.hard = true; out.load = 'hard'; out.kind = 'quality'; out.kindLabel = 'Hårdt løb (høj puls)'; out.basis = 'Gns.puls ' + Math.round(pct * 100) + ' % af maxpuls (Zone 4+)'; out.confidence = 'høj'; }
      else if (pct >= T.steadyHrPct) { out.load = 'steady'; out.kind = 'steady'; out.kindLabel = 'Jævnt/moderat løb'; out.basis = 'Gns.puls ' + Math.round(pct * 100) + ' % af maxpuls (Zone 3)'; out.confidence = 'middel'; }
      else { out.basis = 'Gns.puls ' + Math.round(pct * 100) + ' % af maxpuls (Zone 1–2)'; out.confidence = 'høj'; }
    } else {
      out.kind = 'unknown'; out.kindLabel = 'Løb (intensitet ukendt)'; out.basis = 'Ingen pulsdata eller maxpuls — regnet som roligt'; out.confidence = 'lav';
      out.limits.push('Uden puls kan intensiteten ikke afgøres; løbet tæller som roligt. Interval/tempo kan ikke skelnes fra roligt løb ud fra de data appen gemmer.');
    }
    if (km >= T.longRunMinKm && med > 0 && km >= T.longRunFactor * med) {
      out.long = true; out.hard = out.hard || false; out.load = out.hard ? 'long' : 'long'; out.kind = 'long'; out.kindLabel = 'Langt løb';
      out.basis = (out.basis ? out.basis + '; ' : '') + km.toFixed(1) + ' km ≥ ' + T.longRunFactor + '× dit snit (' + med.toFixed(1) + ' km)';
      out.hard = true; // lang = belastende pga. varighed uanset puls (bevarer V3-adfærd: R1/R2 vurderer langt løb som hårdt)
      out.confidence = 'høj';
    }
    if (ctx.raceDate && run.date === ctx.raceDate) { out.kind = 'race'; out.kindLabel = 'Konkurrence/testløb'; out.hard = true; out.load = 'hard'; out.basis = 'Dato = dit løbsmål'; out.confidence = 'høj'; }
    return out;
  };

  // ── Løbets fase (spejl af lob/index.html: computeRacePhaseInfo + currentPhaseInfo, men for en vilkårlig dato) ──
  // profile = lob_state.profile. Returnerer {phase:'Base'|'Build'|'Peak'|'Taper'|'Race', isDeload, posInBlock, raceMode, distance} eller null.
  P.phaseFor = function (profile, dateISO) {
    if (!profile) return null;
    var rg = profile.raceGoal;
    var ms = function (iso) { return new Date(iso + 'T00:00:00').getTime(); };
    if (rg && rg.active && rg.date && rg.distance) {
      var raceDate = ms(rg.date), start = ms(rg.activatedDate || rg.date), today = ms(dateISO), WEEK = 7 * 86400000;
      var daysToRace = Math.ceil((raceDate - today) / 86400000);
      var totalWeeks = Math.round((raceDate - start) / WEEK); if (!isFinite(totalWeeks) || totalWeeks < 1) totalWeeks = 1;
      var beginner = rg.niveau === 'begynder' ? 1 : 0;
      var taperW = (rg.distance === 'half' ? 2 : 1) + beginner; taperW = Math.min(taperW, Math.max(1, totalWeeks - 1));
      var peakW = Math.min(3, Math.max(0, totalWeeks - taperW - 1));
      var bb = Math.max(0, totalWeeks - taperW - peakW), baseW = Math.round(bb * 0.55), buildW = bb - baseW;
      var weekIndex = Math.max(1, Math.floor(Math.floor((today - start) / 86400000) / 7) + 1);
      var phase;
      if (daysToRace <= 0) phase = 'Race'; else if (weekIndex <= baseW) phase = 'Base'; else if (weekIndex <= baseW + buildW) phase = 'Build'; else if (weekIndex <= baseW + buildW + peakW) phase = 'Peak'; else phase = 'Taper';
      return { phase: phase, isDeload: (phase === 'Base' || phase === 'Build') && weekIndex % 4 === 0, posInBlock: ((weekIndex - 1) % 12) + 1, raceMode: true, distance: rg.distance, week: weekIndex };
    }
    if (!profile.seasonStart) return null;
    var wk = Math.max(1, Math.floor(Math.floor((new Date(dateISO + 'T00:00:00') - new Date(profile.seasonStart + 'T00:00:00')) / 86400000) / 7) + 1);
    var pos = ((wk - 1) % 12) + 1;
    return { phase: pos <= 5 ? 'Base' : (pos <= 9 ? 'Build' : 'Peak'), isDeload: wk % 4 === 0, posInBlock: pos, raceMode: false, distance: null, week: wk };
  };
  // Forventet type for et PLANLAGT kvalitetsløb ud fra fasen — præcis den logik løb-appen bruger til at vælge dagens forslag (suggestNextWorkout).
  // Selve forslaget vælges først dagen før ud fra din form/seneste løb → dette er en forventning (confidence 'lav'), ikke en fast plan.
  P.plannedRunKind = function (info) {
    var base = { confidence: 'lav', basis: 'Fase i løbeplanen', limits: ['Typen er et skøn ud fra fasen i din løbeplan. Løb-appen vælger det konkrete pas først dagen før ud fra din form, seneste løb og puls — det kan ændre sig (fx til et roligt løb).'] };
    var mk = function (kind, label, hard, long, why) { return Object.assign({}, base, { kind: kind, kindLabel: label, hard: hard, long: long, load: long ? 'long' : (hard ? 'hard' : 'easy'), basis: 'Fase: ' + why }); };
    if (!info) return Object.assign({}, base, { kind: 'quality', kindLabel: 'Kvalitetsløb (type ukendt)', hard: true, long: false, load: 'hard', basis: 'Ingen løbeprofil fundet — kvalitetsløb antages hårdt', confidence: 'lav' });
    if (info.isDeload) return mk('easy', 'Roligt løb (deload-uge)', false, false, 'deload-uge');
    if (info.phase === 'Race') return mk('race', 'Løbsdag', true, false, 'løbsdag');
    if (info.phase === 'Taper') return mk('easy', 'Taper (kort, let + strides)', false, false, 'taper');
    if (!info.raceMode && info.posInBlock === 10) return mk('test', '20-min tempotest', true, false, 'test ved start af Peak (uge 10)');
    if (info.phase === 'Base') return mk('long', 'Lang, jævn tur (Zone 2)', false, true, 'Base — lang aerob tur, ikke fart');
    if (info.phase === 'Build') return info.raceMode && info.distance === 'half' ? mk('long', 'Lang tur med tempo', true, true, 'Build mod halvmarathon') : mk('tempo', 'Tempo/intervaller', true, false, 'Build — tærskel/interval');
    return mk('interval', 'Race-pace intervaller', true, false, 'Peak — skarphed');
  };

  // ── Styrkedage: hvad belaster de? (baseret på programmets egen SBD_CYCLE + primærløft) ──
  // heavy = tungt hovedløft med backdown (cst1/low1/bb1). technique = sekundær variant 3×3 @ ~60–65 % 1RM uden backdown (cst2/low2/bb2).
  P.SBD_KINDS = {
    cst1: { mainLift: 'bench', role: 'heavy', lowerLoad: 'none', hinge: false, legHyp: false, label: 'Tung bænkpres + overkrop' },
    cst2: { mainLift: 'bench', role: 'technique', lowerLoad: 'none', hinge: false, legHyp: false, label: 'Pause-bænk (teknik) + overkrop' },
    low1: { mainLift: 'squat', role: 'heavy', lowerLoad: 'heavy', hinge: false, legHyp: true, label: 'Tung squat + benassistance' },
    bb1:  { mainLift: 'deadlift', role: 'heavy', lowerLoad: 'heavy', hinge: true, legHyp: false, label: 'Tung dødløft + ryg/biceps' },
    low2: { mainLift: 'squat', role: 'technique', lowerLoad: 'moderate', hinge: false, legHyp: true, label: 'Box squat (teknik) + baglår/baller-volumen' },
    bb2:  { mainLift: 'deadlift', role: 'technique', lowerLoad: 'moderate', hinge: true, legHyp: false, label: 'Deficit-dødløft (teknik) + ryg' }
  };
  // deload/Ellen (kun tilbehør) → aldrig "tung". Returnerer felter der lægges på kalender-posten.
  P.sbdFlags = function (cycleId, opts) {
    opts = opts || {}; var k = P.SBD_KINDS[cycleId] || { mainLift: null, role: null, lowerLoad: 'none', hinge: false, legHyp: false, label: '' };
    var deload = !!opts.deload, heavyOk = opts.heavyOk !== false;
    var lowerLoad = (!heavyOk || deload) ? (k.lowerLoad === 'none' ? 'none' : 'light') : k.lowerLoad;
    return { mainLift: k.mainLift, role: k.role, lowerLoad: lowerLoad, lower: lowerLoad !== 'none', hinge: !!k.hinge && lowerLoad !== 'none', legHyp: !!k.legHyp && lowerLoad !== 'none',
      hard: lowerLoad === 'heavy', moderateLower: lowerLoad === 'moderate', kindLabel: k.label };
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
    return P.applyChanges(days, Array.isArray(opts.changes) ? opts.changes : []);
  };
  P.applyChanges = function (days, changes) {
    var by = {}; days.forEach(function (d) { by[d.date] = d; });
    var stale = [];
    var plannedRun = function (date) { var d = by[date]; return d ? d.items.filter(function (x) { return x.kind === 'run' && x.status === 'planned'; })[0] : null; };
    (Array.isArray(changes) ? changes : []).forEach(function (c) {
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

    var LIM_PLANNED = 'Fremtidige løb er klassificeret ud fra fasen i løbeplanen (skøn) — de konkrete pas vælges først dagen før.';
    var limitsFor = function (items) { var out = []; items.forEach(function (x) { (x.limits || []).forEach(function (l) { if (out.indexOf(l) < 0) out.push(l); }); if (x.kind === 'run' && x.status === 'planned' && x.confidence === 'lav' && out.indexOf(LIM_PLANNED) < 0) out.push(LIM_PLANNED); }); return out; };
    var runTag = function (r) { return r.label + (r.kindLabel && r.kindLabel !== r.label ? ' — ' + r.kindLabel : '') + (r.long && r.kind !== 'long' ? ' (langt)' : ''); };
    days.forEach(function (d) {
      active(d).forEach(function (s) {
        if (!(s.kind === 'sbd' && (s.lower || s.hinge))) return;
        for (var k = -adj; k <= adj; k++) {
          var o = by[TP.addDays(d.date, k)]; if (!o) continue;
          active(o).forEach(function (r) {
            if (r.kind !== 'run') return;
            var when = k === 0 ? 'samme dag' : (k < 0 ? 'dagen før' : 'dagen efter');
            var heavy = isHeavyLower(s), moderate = !heavy && s.lower;
            var hardRun = !!r.hard, longRun = !!r.long;
            var basis = [s.label + ' ' + fmt(d.date) + (s.kindLabel ? ' (' + s.kindLabel + ')' : ''), runTag(r) + ' ' + fmt(o.date) + (r.basis ? ' — ' + r.basis : '')];
            var mv = [{ kind: 'run', date: o.date, id: r.id }, { kind: 'sbd', date: d.date, id: s.id }];
            if (heavy && hardRun) {
              add({ key: 'R1:' + d.date + ':' + o.date, rule: 'R1', level: 'warn', sev: k === 0 ? 'høj' : 'moderat', sevWhy: k === 0 ? 'Samme dag: begge pas belaster benene med minimal restitution imellem.' : 'Én dag imellem: delvis restitution, men benene er stadig belastede.',
                dates: [d.date, o.date].sort(),
                title: 'Tung benstyrke (' + s.label + ', ' + fmt(d.date) + ') og hårdt løb (' + fmt(o.date) + ') ' + (k === 0 ? 'på samme dag' : 'tæt på hinanden'),
                why: 'Hårdt løb ligger ' + when + ' ' + (k === 0 ? 'som' : (k < 0 ? 'efter' : 'før')) + ' tung ' + s.label + '. Begge pas belaster ben og hofter; det forringer ofte kvaliteten af begge.',
                consequence: 'Hvis du ignorerer: begge pas køres på trætte ben — højere belastning og lavere sandsynlighed for at ramme de planlagte vægte/tempo.',
                facts: basis, basedOn: basis, limits: limitsFor([s, r]), movable: mv });
            } else if (moderate && hardRun) {
              add({ key: 'R1b:' + d.date + ':' + o.date, rule: 'R1b', level: 'info', sev: 'lav', sevWhy: 'Underkropsdagen er teknik/moderat (ca. 60–65 % 1RM eller assistancevolumen), ikke tung.',
                dates: [d.date, o.date].sort(), title: 'Benvolumen/teknik (' + s.label + ', ' + fmt(d.date) + ') tæt på hårdt løb (' + fmt(o.date) + ')',
                why: 'Hårdt løb ligger ' + when + '. Baglår/baller/quads får volumen fra begge pas. Mindre kritisk end tung benstyrke.',
                consequence: 'Hvis du ignorerer: du kan mærke trætte ben i det ene pas. Vurder selv ud fra, hvordan benene føles.', facts: basis, basedOn: basis, limits: limitsFor([s, r]), movable: mv });
            }
            if (s.hinge && longRun) {
              var hv = isHeavyLower(s);
              add({ key: (hv ? 'R2:' : 'R2b:') + d.date + ':' + o.date, rule: hv ? 'R2' : 'R2b', level: hv ? 'warn' : 'info', sev: hv ? 'moderat' : 'lav', sevWhy: hv ? 'Tung dødløft + langt løb belaster lænd/baglår fra to sider.' : 'Deficit-dødløft (teknik, ~65 %) er lettere end tung dødløft.',
                dates: [d.date, o.date].sort(),
                title: (hv ? 'Dødløft' : 'Dødløftsteknik') + ' (' + fmt(d.date) + ') tæt på langt løb (' + fmt(o.date) + ')',
                why: 'Dødløft og langt løb belaster begge lænd og baglår. Samme dag eller ±1 dag giver lidt restitution imellem.',
                consequence: 'Hvis du ignorerer: øget træthed i baglår/lænd; vægten eller løbetempoet kan blive lavere end planlagt.',
                facts: basis, basedOn: basis, limits: limitsFor([s, r]), movable: mv });
            }
          });
        }
      });
    });

    // R8: hårde pas lige efter hinanden (hårdt løb ↔ hårdt løb, tung benstyrke ↔ tung benstyrke). Lower+run dækkes af R1.
    for (var i8 = 0; i8 < n - 1; i8++) {
      var d1 = days[i8], d2 = days[i8 + 1];
      var h1 = active(d1), h2 = active(d2);
      var rr1 = h1.filter(isHardRun)[0], rr2 = h2.filter(isHardRun)[0], ll1 = h1.filter(isHeavyLower)[0], ll2 = h2.filter(isHeavyLower)[0];
      var pair = rr1 && rr2 ? [rr1, rr2, 'hårde løb'] : (ll1 && ll2 ? [ll1, ll2, 'tunge benstyrkedage'] : null);
      if (pair) add({ key: 'R8:' + d1.date + ':' + d2.date, rule: 'R8', level: 'warn', sev: 'moderat', sevWhy: 'Ingen rolig dag mellem to ensartede hårde belastninger.', dates: [d1.date, d2.date],
        title: 'To ' + pair[2] + ' i træk (' + fmt(d1.date) + ' og ' + fmt(d2.date) + ')', why: 'Der er ingen rolig dag imellem. Ensartet belastning to dage i træk giver mindre restitution til det samme område.',
        consequence: 'Hvis du ignorerer: det andet pas køres på ikke-restituerede muskler/led.', facts: [pair[0].label + ' ' + fmt(d1.date), pair[1].label + ' ' + fmt(d2.date)], basedOn: [pair[0].label + ' ' + fmt(d1.date), pair[1].label + ' ' + fmt(d2.date)], limits: limitsFor([pair[0], pair[1]]),
        movable: [pair[1]].map(function (x) { return { kind: x.kind, date: d2.date, id: x.id }; }) });
    }

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
    // Fælles forklaringsfelter: alvor (sev), hvad vurderingen bygger på (basedOn), begrænsninger (limits)
    var SEV = { R3: ['moderat', 'Flere hårde dage uden rolig dag imellem.'], R3b: ['lav', 'Ingen restitutionsdag, men dagene er ikke nødvendigvis hårde.'], R4: ['moderat', 'Hurtige volumenstigninger giver oftere ømhed og træthed end gradvise.'], R4b: ['lav', 'Kun info om antal sæt.'],
      R5: ['moderat', 'Ingen dag uden styrke/hårdt løb i hele ugen.'], R6: ['lav', 'Bygger på selvrapporterede svar — ikke en måling.'], R7: ['høj', 'Tæt på et løb betyder mere, fordi formen på dagen er målet.'] };
    out.forEach(function (f) {
      var sv = SEV[f.rule];
      if (!f.sev && sv) { f.sev = sv[0]; f.sevWhy = sv[1]; }
      if (f.rule === 'R3' && f.dates.length >= 4) { f.sev = 'høj'; f.sevWhy = f.dates.length + ' hårde dage i træk.'; }
      if (!f.sev) { f.sev = 'lav'; f.sevWhy = ''; }
      if (!f.basedOn) f.basedOn = (f.facts || []).slice();
      f.limits = (f.limits || []).concat(['Reglen er en konservativ tommelfingerregel — ikke en individuel vurdering eller medicinsk rådgivning. Du kender din krop bedst.']);
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

  // ── Målbaseret prioritering (fase 4) ───────────────────────────────────────
  // Fokus ændrer ALDRIG programmer eller planer. Det påvirker kun (1) hvilke omlægningsforslag der vises/foretrækkes
  // og (2) rækkefølgen af opmærksomhedspunkter. Alt forklares for brugeren.
  P.FOCUS = {
    balanced: { label: 'Balanceret hybrid', engine: 'balanced', short: 'Ingen disciplin foretrækkes — forslag vælges så de giver færrest konflikter og mindst forstyrrelse (løbeflytninger før styrkeændringer).',
      effects: ['Forslag med færrest advarsler vælges først; ved lighed foretrækkes den mindste ændring (flyt et løb frem for at ændre styrke).', 'Ingen pas er "fredet" — både løb og styrke kan foreslås flyttet.'] },
    strength: { label: 'Styrke først', engine: 'strength', short: 'Tunge styrkepas (især ben) beskyttes. Når styrke og hårdt løb støder sammen, er det løbet der foreslås flyttet eller gjort roligt.',
      effects: ['Tunge styrkepas foreslås aldrig rykket eller sprunget over.', 'Konflikter løses ved at flytte eller lette løbet.'] },
    hypertrophy: { label: 'Hypertrofi', engine: 'strength', short: 'Styrketræningsvolumen beskyttes: styrkepas foreslås ikke sprunget over, fordi hvert pas tæller for ugens sæt. Løb flyttes eller lettes i stedet.',
      effects: ['Styrkepas foreslås aldrig sprunget over (ugens sæt/volumen beskyttes).', 'Konflikter løses ved at flytte eller lette løbet.', 'Hviledage og restitutions-advarsler vises uændret.'] },
    run: { label: 'Løbepræstation', engine: 'run', short: 'Hårde løb (især tæt på et løb/mål) beskyttes. Når styrke og hårdt løb støder sammen, foreslås styrkepasset rykket én dag frem i stedet.',
      effects: ['Hårde løb tæt på et løb eller et tilknyttet mål (inden for 14 dage) foreslås aldrig gjort rolige.', 'Foreslåede omlægninger prioriterer at rykke styrkepasset ("Kan ikke i dag") før løbet.', 'Advarsler om tung benstyrke før løb vises øverst.'] }
  };
  P.focusKey = function (meta) { var f = meta && meta.goalPriority && meta.goalPriority.focus; return P.FOCUS[f] ? f : 'balanced'; };
  P.engineFocus = function (meta) { return P.FOCUS[P.focusKey(meta)].engine; };
  P.setFocus = function (meta, focus, goalIds, now) {
    if (!P.FOCUS[focus]) throw new Error('Ukendt fokus');
    var ids = Array.isArray(goalIds) ? goalIds.filter(function (x, i, a) { return typeof x === 'string' && a.indexOf(x) === i; }).slice(0, 12) : [];
    meta.goalPriority = { focus: focus, goalIds: ids, since: TP.localISO(new Date(now || Date.now())), at: now || Date.now() };
    return meta;
  };
  // Datoer for tilknyttede mål (deadlines) + løbsmål → "tæt på"-vurdering
  P.attachedDates = function (meta, goals, raceDate) {
    var ids = (meta && meta.goalPriority && meta.goalPriority.goalIds) || [], out = [];
    (goals || []).forEach(function (g) { if (ids.indexOf(g.id) >= 0 && g.deadline && !g.achievedDate) out.push(g.deadline); });
    if (raceDate && ids.indexOf('race') >= 0) out.push(raceDate);
    return out;
  };
  P.explainFocus = function (meta, ctx) {
    ctx = ctx || {}; var k = P.focusKey(meta), f = P.FOCUS[k], lines = f.effects.slice();
    var ids = (meta.goalPriority && meta.goalPriority.goalIds) || [];
    if (ids.length) lines.push(ids.length + ' mål er knyttet til dit fokus' + (ctx.nearDate ? ' — nærmeste dato: ' + fmt(ctx.nearDate) + (k === 'run' ? ' (hårde løb før den beskyttes ekstra)' : '') : '') + '.');
    else lines.push('Ingen mål er knyttet endnu — fokus gælder generelt.');
    lines.push('Programmer og planer omskrives aldrig af fokus; større ændringer kræver altid din godkendelse.');
    return { label: f.label, short: f.short, lines: lines };
  };
  // Sortering af opmærksomhedspunkter efter fokus (alvor først; derefter fokus-relevante regler)
  P.sortFindings = function (list, focus) {
    var boost = focus === 'run' ? { R7: 0, R1: 1, R2: 1 } : (focus === 'strength' ? { R1: 0, R2: 0, R4b: 1 } : {});
    return list.slice().sort(function (a, b) {
      var la = a.level === 'warn' ? 0 : 1, lb = b.level === 'warn' ? 0 : 1; if (la !== lb) return la - lb;
      var ba = boost[a.rule] != null ? boost[a.rule] : 9, bb = boost[b.rule] != null ? boost[b.rule] : 9; if (ba !== bb) return ba - bb;
      return a.dates[0] < b.dates[0] ? -1 : (a.dates[0] > b.dates[0] ? 1 : 0);
    });
  };

  // ── Ændringslog (tp_meta.planChanges) ──────────────────────────────────────
  P.newChange = function (change, now) { return Object.assign({ id: TP.uid('chg'), at: now || Date.now() }, change); };
  P.addChange = function (meta, change) { meta.planChanges = (meta.planChanges || []).concat([change]); return meta; };
  // Fjerner OG efterlader en tombstone, så ændringen ikke genopstår når en anden enhed synkroniserer (se tp-sync.js).
  P.removeChange = function (meta, id, now) { meta.planChanges = (meta.planChanges || []).filter(function (c) { return c.id !== id; }); TP.tombstone(meta, id, now); return meta; };
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
    return (Array.isArray(changes) ? changes : []).filter(function (c) { var d = c.date || c.to || c.b || c.from; return !d || d >= TP.addDays(today, -14); });
  };
  return P;
});
