/* ═══════════════════════════════════════════════════════════════════════════
   TRÆNING — FÆLLES KERNE (V3)
   Fælles datatilgang, versionering/migration, øvelsesbibliotek (alternativer),
   træningsevaluering og samlet backup/gendannelse for dashboard, SBD og løb.

   Princip: rene funktioner uden afhængighed af DOM, så de kan testes i Node.
   Lager injiceres (TP.setStorage) — i browseren er det localStorage.
   Ingen netværk. Ingen afhængighed af en ekstern tjeneste.

   Datamodel (alt per profil: 'main' = Oliver, 'partner' = Ellen):
     sbd_state / sbd_partner  — SBD-blob (synkroniseres). V3 tilføjer felter:
         tpv, exerciseSubs{}, altOverrides{}, sessionEval{}, logs[dayN].sid,
         logs[dayN].exercises[i].plannedName / .sub
     lob_state / lob_partner  — løbe-blob (synkroniseres). V3: run.eval, tpv
     tp_meta_main / tp_meta_partner — NY lokal blob (synkroniseres IKKE, Workerens
         nøgleliste er fast): planændringer, afviste forslag, målprioritering,
         månedsrapporter. Indgår i backup.
   ═══════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TP = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var TP = {};
  TP.APP_VERSION = '3.0.0';
  TP.SCHEMA = 3;               // nuværende datamodel-version
  TP.BACKUP_FORMAT = 3;        // nuværende backupformat
  TP.PROFILES = ['main', 'partner'];
  TP.PROFILE_NAME = { main: 'Oliver', partner: 'Ellen' };
  TP.KEYS = {
    sbd:  { main: 'sbd_state',     partner: 'sbd_partner' },
    lob:  { main: 'lob_state',     partner: 'lob_partner' },
    meta: { main: 'tp_meta_main',  partner: 'tp_meta_partner' }
  };
  var SNAP_KEY = 'tp_prerestore_snapshot';
  var EPOCH_KEY = 'tp_restore_epoch';
  // Dashboardets lokale planlægningsnøgler (ikke synkroniseret). sync_token er med vilje IKKE med.
  var DASH_PROFILE_KEYS = { main: 'oliver', partner: 'ellen' };
  function dashKeysFor(profile) {
    var p = DASH_PROFILE_KEYS[profile];
    return ['dash_blocked_dates_' + p, 'dash_catchup_dates_' + p];
  }
  var DASH_SHARED_KEYS = ['dash_schedule_anchor'];

  /* ───────── Lager ───────── */
  var _storage = null;
  TP.setStorage = function (s) { _storage = s; };
  TP.storage = function () {
    if (_storage) return _storage;
    try { if (typeof localStorage !== 'undefined') return localStorage; } catch (e) { /* privat tilstand */ }
    return null;
  };
  function sget(st, k) { try { return st.getItem(k); } catch (e) { return null; } }

  /* ───────── Hjælpere ───────── */
  function isObj(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }
  function clone(x) { return x == null ? x : JSON.parse(JSON.stringify(x)); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  TP.localISO = function (d) {
    d = d instanceof Date ? d : new Date(d);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  };
  TP.addDays = function (iso, n) {
    var d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return TP.localISO(d);
  };
  TP.diffDays = function (a, b) { return Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / 86400000); };
  TP.weekStart = function (iso) { // mandag
    var d = new Date(iso + 'T12:00:00'); var wd = (d.getDay() + 6) % 7; d.setDate(d.getDate() - wd); return TP.localISO(d);
  };
  // Hurtig, stabil hash (FNV-1a, 32 bit) — opdager beskadigede/afkortede filer. IKKE kryptografisk.
  TP.hash = function (str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0; }
    return ('00000000' + h.toString(16)).slice(-8);
  };
  var _uidN = 0;
  TP.uid = function (prefix) {
    _uidN++;
    return (prefix || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7) + _uidN.toString(36);
  };
  // Stabilt øvelses-ID ud fra navn (bruges som nøgle i bibliotek/overrides).
  TP.exId = function (name) {
    return String(name || '').toLowerCase()
      .replace(/æ/g, 'ae').replace(/ø/g, 'oe').replace(/å/g, 'aa')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  };

  /* ───────── Validering ───────── */
  TP.validateSbd = function (s) {
    var errs = [];
    if (!isObj(s)) return ['Ikke et objekt'];
    if (typeof s.totalDays !== 'number' || !isFinite(s.totalDays) || s.totalDays < 0) errs.push('totalDays mangler/er ugyldig');
    if (!Array.isArray(s.completedDays)) errs.push('completedDays mangler');
    if (!isObj(s.logs)) errs.push('logs mangler');
    if (isObj(s.logs)) {
      Object.keys(s.logs).forEach(function (k) {
        var l = s.logs[k];
        if (!isObj(l) || !Array.isArray(l.exercises)) errs.push('log ' + k + ' er beskadiget');
      });
    }
    return errs;
  };
  TP.validateLob = function (s) {
    var errs = [];
    if (!isObj(s)) return ['Ikke et objekt'];
    if (!isObj(s.profile)) errs.push('profile mangler');
    if (!Array.isArray(s.runs)) errs.push('runs mangler');
    else s.runs.forEach(function (r, i) {
      if (!r || typeof r.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.date) ||
          !isFinite(r.distanceKm) || !(r.distanceKm > 0) || !isFinite(r.durationSec) || !(r.durationSec > 0)) {
        errs.push('løb #' + (i + 1) + ' er ugyldigt');
      }
    });
    return errs;
  };
  TP.validateMeta = function (m) { return isObj(m) ? [] : ['Ikke et objekt']; };

  /* ───────── Migration (idempotent, aldrig destruktiv) ───────── */
  function defaultMeta() {
    return {
      tpv: TP.SCHEMA,
      planChanges: [],         // [{id, ts, type:'move'|'swap'|'skip'|'done', disc, from, to, note, undone}]
      dismissed: {},           // { regelId+dato: tidsstempel } — afviste/ignorerede forslag
      goalPriority: { focus: 'balanced', goalIds: [], since: null },
      reports: {},             // { 'YYYY-MM': rapport-snapshot }
      lastRestore: null
    };
  }
  TP.defaultMeta = defaultMeta;
  TP.migrateMeta = function (m) {
    var d = defaultMeta();
    if (!isObj(m)) return d;
    var out = clone(m);
    if (!Array.isArray(out.planChanges)) out.planChanges = d.planChanges;
    if (!isObj(out.dismissed)) out.dismissed = d.dismissed;
    if (!isObj(out.goalPriority)) out.goalPriority = d.goalPriority;
    if (!out.goalPriority.focus) out.goalPriority.focus = 'balanced';
    if (!Array.isArray(out.goalPriority.goalIds)) out.goalPriority.goalIds = [];
    if (!isObj(out.reports)) out.reports = d.reports;
    if (out.lastRestore === undefined) out.lastRestore = null;
    out.tpv = TP.SCHEMA;
    return out;
  };
  // SBD: tilføjer kun manglende felter. Eksisterende logs/ids røres ikke; session-id'er
  // tildeles deterministisk (samme resultat hver gang → stabilt på tværs af enheder).
  TP.migrateSbd = function (s, profile) {
    if (!isObj(s)) return s;
    var out = s; // muterer det objekt der gives (kald med clone ved behov)
    if (!isObj(out.exerciseSubs)) out.exerciseSubs = {};     // { plannedName: { alt, since, scope:'future' } }
    if (!isObj(out.altOverrides)) out.altOverrides = {};     // { plannedName: [navn, navn] }
    if (!isObj(out.sessionEval)) out.sessionEval = {};       // { dayN: evaluering }
    if (isObj(out.logs)) {
      Object.keys(out.logs).forEach(function (k) {
        var l = out.logs[k];
        if (!isObj(l)) return;
        if (!l.sid) {
          var t = (out.sessionTimes && out.sessionTimes[k]) ? (out.sessionTimes[k].sessionStart || out.sessionTimes[k].start || 0) : 0;
          l.sid = 'sbd-' + (profile || 'main') + '-' + k + '-' + t;
        }
      });
    }
    out.tpv = TP.SCHEMA;
    return out;
  };
  TP.migrateLob = function (s) {
    if (!isObj(s)) return s;
    var out = s;
    if (Array.isArray(out.runs)) {
      out.runs.forEach(function (r, i) {
        if (r && !r.id) r.id = 'run-' + r.date + '-' + i + '-' + Math.round((r.distanceKm || 0) * 100);
      });
    }
    out.tpv = TP.SCHEMA;
    return out;
  };

  /* ───────── Fælles datatilgang ───────── */
  // Læser og migrerer (i hukommelsen) — skriver ALDRIG til lageret.
  TP.load = function (kind, profile, storage) {
    var st = storage || TP.storage(); if (!st) return null;
    var raw = sget(st, TP.KEYS[kind][profile]);
    if (!raw) return null;
    var parsed; try { parsed = JSON.parse(raw); } catch (e) { return null; }
    if (kind === 'sbd') return isObj(parsed) ? TP.migrateSbd(parsed, profile) : null;
    if (kind === 'lob') return isObj(parsed) ? TP.migrateLob(parsed) : null;
    if (kind === 'meta') return TP.migrateMeta(parsed);
    return parsed;
  };
  TP.loadMeta = function (profile, storage) {
    var st = storage || TP.storage();
    var m = st ? TP.load('meta', profile, st) : null;
    return m || defaultMeta();
  };
  TP.saveMeta = function (profile, meta, storage) {
    var st = storage || TP.storage(); if (!st) return false;
    try { st.setItem(TP.KEYS.meta[profile], JSON.stringify(TP.migrateMeta(meta))); return true; } catch (e) { return false; }
  };
  // SBD-sessionens dato (lokal) ud fra tidsstempler.
  TP.sbdSessionDate = function (s, dayN) {
    var t = s && s.sessionTimes && s.sessionTimes['day' + dayN];
    var ts = t ? (t.end || t.start || t.sessionStart) : null;
    return ts ? TP.localISO(new Date(ts)) : null;
  };
  // Samlet, normaliseret sessionsliste (styrke + løb) for én profil. Dubler ikke data —
  // refererer kun til kilde-id'er.
  TP.sessions = function (profile, storage) {
    var out = [];
    var sbd = TP.load('sbd', profile, storage), lob = TP.load('lob', profile, storage);
    if (sbd) {
      (sbd.completedDays || []).forEach(function (n) {
        var key = 'day' + n, log = sbd.logs && sbd.logs[key];
        var date = TP.sbdSessionDate(sbd, n);
        out.push({ sid: (log && log.sid) || ('sbd-' + profile + '-' + key), type: 'sbd', profile: profile, date: date, ref: key,
          exercises: log ? log.exercises.length : 0, eval: (sbd.sessionEval && sbd.sessionEval[key]) || null });
      });
    }
    if (lob) {
      (lob.runs || []).forEach(function (r) {
        out.push({ sid: r.id, type: 'run', profile: profile, date: r.date, ref: r.id, km: r.distanceKm, sec: r.durationSec, eval: r.eval || null });
      });
    }
    out.sort(function (a, b) { return String(a.date || '').localeCompare(String(b.date || '')); });
    return out;
  };

  /* ═══════════════════════ BACKUP & GENDANNELSE ═══════════════════════ */
  function summarize(key, val) {
    if (!isObj(val)) return { empty: true };
    if (/^sbd_/.test(key)) {
      var last = null; (val.completedDays || []).forEach(function (n) { var d = TP.sbdSessionDate(val, n); if (d && (!last || d > last)) last = d; });
      return { sessions: (val.completedDays || []).length, totalDays: val.totalDays || 0, last: last,
        subs: Object.keys(val.exerciseSubs || {}).length, evals: Object.keys(val.sessionEval || {}).length };
    }
    if (/^lob_/.test(key)) {
      var lr = null; (val.runs || []).forEach(function (r) { if (!lr || r.date > lr) lr = r.date; });
      return { runs: (val.runs || []).length, last: lr, goals: ((val.profile || {}).goals || []).length };
    }
    if (/^tp_meta_/.test(key)) {
      return { changes: (val.planChanges || []).length, reports: Object.keys(val.reports || {}).length };
    }
    return { entries: Array.isArray(val) ? val.length : 1 };
  }
  TP.summarize = summarize;

  function keyLabel(key) {
    var m = {
      sbd_state: 'Styrketræning — Oliver', sbd_partner: 'Styrketræning — Ellen',
      lob_state: 'Løb — Oliver', lob_partner: 'Løb — Ellen',
      tp_meta_main: 'Planændringer, mål og rapporter — Oliver', tp_meta_partner: 'Planændringer, mål og rapporter — Ellen'
    };
    if (m[key]) return m[key];
    if (/^dash_blocked_dates_/.test(key)) return 'Ugeplan: "ryk styrke"-dage (' + key.split('_').pop() + ')';
    if (/^dash_catchup_dates_/.test(key)) return 'Ugeplan: "indhent"-dage (' + key.split('_').pop() + ')';
    if (key === 'dash_schedule_anchor') return 'Ugeplan: rytme-anker';
    return key;
  }
  TP.keyLabel = keyLabel;

  function selectKeys(scope) {
    var profiles = scope === 'all' ? TP.PROFILES : [scope];
    var keys = [];
    profiles.forEach(function (p) {
      keys.push(TP.KEYS.sbd[p], TP.KEYS.lob[p], TP.KEYS.meta[p]);
      dashKeysFor(p).forEach(function (k) { keys.push(k); });
    });
    DASH_SHARED_KEYS.forEach(function (k) { keys.push(k); });
    return keys;
  }

  // Bygger en samlet, versioneret backup. scope: 'all' | 'main' | 'partner'.
  TP.buildBackup = function (scope, storage, opts) {
    var st = storage || TP.storage();
    if (!st) throw new Error('Intet lager tilgængeligt');
    scope = scope || 'all';
    var data = {}, counts = {};
    selectKeys(scope).forEach(function (k) {
      var raw = sget(st, k); if (raw == null) return;
      var v; try { v = JSON.parse(raw); } catch (e) { return; }
      if (/^dash_/.test(k)) { data.dash = data.dash || {}; data.dash[k] = v; counts[k] = summarize(k, v); return; }
      data[k] = v; counts[k] = summarize(k, v);
    });
    var canonical = JSON.stringify(data);
    return {
      app: 'traening-platform', format: TP.BACKUP_FORMAT, appVersion: TP.APP_VERSION,
      exportedAt: (opts && opts.now) || new Date().toISOString(),
      scope: scope,
      profiles: scope === 'all' ? TP.PROFILES.map(function (p) { return { id: p, name: TP.PROFILE_NAME[p] }; })
                                : [{ id: scope, name: TP.PROFILE_NAME[scope] }],
      meta: { schema: TP.SCHEMA, counts: counts, checksum: TP.hash(canonical), bytes: canonical.length },
      data: data
    };
  };

  // Normaliserer kendte formater (inkl. de gamle, adskilte eksporter) til { data, format, exportedAt, ... }.
  TP.parseBackup = function (text) {
    var obj;
    try { obj = JSON.parse(text); } catch (e) { return { ok: false, errors: ['Filen er ikke gyldig JSON (kan være afkortet eller beskadiget).'] }; }
    if (!isObj(obj)) return { ok: false, errors: ['Filen indeholder ikke et backup-objekt.'] };

    // Nyt samlet format
    if (obj.app === 'traening-platform') {
      if (typeof obj.format !== 'number') return { ok: false, errors: ['Backupformat mangler.'] };
      if (obj.format > TP.BACKUP_FORMAT) {
        return { ok: false, errors: ['Filen er lavet med en NYERE version (format ' + obj.format + ', denne app forstår op til ' + TP.BACKUP_FORMAT + '). Opdatér appen først.'] };
      }
      if (!isObj(obj.data)) return { ok: false, errors: ['Backupfilen mangler data.'] };
      var warnings = [];
      if (obj.meta && obj.meta.checksum) {
        var calc = TP.hash(JSON.stringify(obj.data));
        if (calc !== obj.meta.checksum) return { ok: false, errors: ['Kontrolsummen passer ikke — filen er ændret eller beskadiget. Importen er stoppet.'] };
      } else warnings.push('Filen har ingen kontrolsum (kan ikke verificeres mod beskadigelse).');
      return { ok: true, legacy: false, format: obj.format, exportedAt: obj.exportedAt || null, appVersion: obj.appVersion || null,
        scope: obj.scope || 'all', data: obj.data, warnings: warnings };
    }
    // Gammelt SBD-format: { backupVersion:1, sbd_state, sbd_partner }
    if (obj.backupVersion === 1 && (obj.sbd_state || obj.sbd_partner)) {
      var d1 = {}; if (obj.sbd_state) d1.sbd_state = obj.sbd_state; if (obj.sbd_partner) d1.sbd_partner = obj.sbd_partner;
      return { ok: true, legacy: true, legacyKind: 'sbd', format: 1, exportedAt: obj.exportedAt || null, scope: 'all', data: d1,
        warnings: ['Gammelt SBD-backupformat — kun styrketræning gendannes; løb og øvrige data røres ikke.'] };
    }
    // Gammelt løbe-format: { app:'lob-tracker', version:1, main, partner }
    if (obj.app === 'lob-tracker' && obj.version === 1) {
      var d2 = {}; if (obj.main) d2.lob_state = obj.main; if (obj.partner) d2.lob_partner = obj.partner;
      return { ok: true, legacy: true, legacyKind: 'lob', format: 1, exportedAt: obj.exportedAt || null, scope: 'all', data: d2,
        warnings: ['Gammelt løbe-backupformat — kun løb gendannes; styrketræning og øvrige data røres ikke.'] };
    }
    if (isObj(obj.profile) && Array.isArray(obj.runs)) {
      return { ok: true, legacy: true, legacyKind: 'lob-single', format: 0, exportedAt: null, scope: 'single-lob', data: { __single_lob: obj },
        warnings: ['Gammel enkelt-profil-løbefil. Du vælger selv hvilken profil den skal gendannes til.'] };
    }
    if (obj.sessionTimes && obj.logs && obj.oneRM) {
      return { ok: false, errors: ['Dette ligner en SBD-analyse-eksport (til gennemlæsning), ikke en backup. Brug "Fuld backup".'] };
    }
    return { ok: false, errors: ['Filen genkendes ikke som en backup fra denne platform.'] };
  };

  function topKeysOf(parsed) { // flad liste over [key, value] i en parsed backup
    var out = [];
    Object.keys(parsed.data).forEach(function (k) {
      if (k === 'dash' && isObj(parsed.data.dash)) Object.keys(parsed.data.dash).forEach(function (dk) { out.push([dk, parsed.data.dash[dk]]); });
      else out.push([k, parsed.data[k]]);
    });
    return out;
  }
  var ALLOWED_KEY = /^(sbd_state|sbd_partner|lob_state|lob_partner|tp_meta_main|tp_meta_partner|dash_blocked_dates_(oliver|ellen)|dash_catchup_dates_(oliver|ellen)|dash_schedule_anchor)$/;

  // Trin 1–5: validér, vis hvad der gendannes, find konflikter. Rører IKKE lageret.
  // opts.singleLobTarget: 'main'|'partner' (kun for gammel enkelt-profil-fil)
  TP.planRestore = function (parsed, storage, opts) {
    opts = opts || {};
    var st = storage || TP.storage();
    var plan = { ok: true, errors: [], warnings: (parsed.warnings || []).slice(), items: [], exportedAt: parsed.exportedAt || null, legacy: !!parsed.legacy };
    if (!parsed.ok) { plan.ok = false; plan.errors = parsed.errors.slice(); return plan; }

    var pairs = topKeysOf(parsed);
    if (parsed.legacyKind === 'lob-single') {
      var tgt = opts.singleLobTarget || 'main';
      pairs = [[TP.KEYS.lob[tgt], parsed.data.__single_lob]];
    }
    if (!pairs.length) { plan.ok = false; plan.errors.push('Backupfilen indeholder ingen data.'); return plan; }

    pairs.forEach(function (pr) {
      var key = pr[0], val = pr[1];
      if (!ALLOWED_KEY.test(key)) { plan.warnings.push('Ukendt datafelt "' + key + '" ignoreres.'); return; }
      var errs = [];
      if (/^sbd_/.test(key)) errs = TP.validateSbd(val);
      else if (/^lob_/.test(key)) errs = TP.validateLob(val);
      else if (/^tp_meta_/.test(key)) errs = TP.validateMeta(val);
      else if (key === 'dash_schedule_anchor') errs = (typeof val === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(val)) ? [] : ['Ugyldig dato'];
      else errs = Array.isArray(val) ? [] : ['Forventede en liste'];
      var item = { key: key, label: keyLabel(key), selected: true, action: 'replace', errors: errs, conflicts: [], incoming: summarize(key, val), current: null, value: val };
      if (errs.length) {
        item.selected = false; item.action = 'invalid';
        plan.ok = false; plan.errors.push(keyLabel(key) + ': ' + errs.slice(0, 3).join('; ') + (errs.length > 3 ? ' …' : ''));
      } else if (st) {
        var raw = sget(st, key), cur = null;
        if (raw != null) { try { cur = JSON.parse(raw); } catch (e) { cur = null; } }
        item.current = cur == null ? null : summarize(key, cur);
        if (cur == null) item.action = 'add';
        else if (JSON.stringify(cur) === JSON.stringify(val)) { item.action = 'same'; item.selected = false; }
        else {
          var a = item.incoming, c = item.current;
          if (c.sessions != null && a.sessions < c.sessions) item.conflicts.push('Backuppen har ' + (c.sessions - a.sessions) + ' færre styrketræninger end nu (' + a.sessions + ' mod ' + c.sessions + ').');
          if (c.runs != null && a.runs < c.runs) item.conflicts.push('Backuppen har ' + (c.runs - a.runs) + ' færre løb end nu (' + a.runs + ' mod ' + c.runs + ').');
          if (c.last && a.last && a.last < c.last) item.conflicts.push('Backuppens seneste registrering (' + a.last + ') er ældre end nuværende (' + c.last + ').');
          if (c.last && !a.last && (c.sessions || c.runs)) item.conflicts.push('Backuppen har ingen datoer — nuværende data har.');
          var upd = parseInt(sget(st, key + '__updatedAt') || '0', 10);
          var exp = parsed.exportedAt ? Date.parse(parsed.exportedAt) : NaN;
          if (upd && !isNaN(exp) && upd > exp + 60000) item.conflicts.push('Data er ændret på denne enhed efter backuppen blev lavet.');
        }
      }
      plan.items.push(item);
    });
    if (st && sget(st, 'sync_token') != null && sget(st, 'sync_token') !== '') {
      plan.warnings.push('Synkronisering er sat op: efter gendannelsen markeres de gendannede data som nyeste og vil derfor overskrive serverens kopi ved næste gem. Andre enheder får dem ved næste synkronisering.');
    }
    if (!plan.items.length) { plan.ok = false; plan.errors.push('Ingen gyldige data at gendanne.'); }
    return plan;
  };

  // Trin 6–8: skriv. Sikkerhedskopi → skriv → verificér → ellers rul tilbage.
  // Ikke en ægte transaktion (localStorage har ingen), men: ingen ændring før sikkerhedskopien ligger
  // sikkert, alle skrivninger verificeres ved tilbagelæsning, og ved enhver fejl rulles tilbage.
  TP.applyRestore = function (plan, storage, opts) {
    opts = opts || {};
    var st = storage || TP.storage();
    if (!st) return { ok: false, error: 'Intet lager tilgængeligt', changed: false };
    if (!plan || !plan.ok) return { ok: false, error: 'Planen er ikke gyldig — intet er ændret.', changed: false };
    var items = plan.items.filter(function (i) { return i.selected && i.action !== 'invalid' && i.action !== 'same'; });
    if (!items.length) return { ok: false, error: 'Intet valgt til gendannelse.', changed: false };
    var now = opts.now || Date.now();

    // Forbered ALT i hukommelsen først (så en fejl her ikke har ændret noget).
    var staged = [];
    try {
      items.forEach(function (i) {
        var v = clone(i.value);
        if (/^sbd_/.test(i.key)) {
          var prof = i.key === 'sbd_partner' ? 'partner' : 'main';
          TP.migrateSbd(v, prof);
          // Bevar den aktuelle profilvælger (UI-tilstand) — den hører ikke til backup-data.
          try { var curRaw = sget(st, i.key); if (curRaw) { var cur = JSON.parse(curRaw); if (cur && cur.profile) v.profile = cur.profile; } } catch (e) {}
        } else if (/^lob_/.test(i.key)) TP.migrateLob(v);
        else if (/^tp_meta_/.test(i.key)) v = TP.migrateMeta(v);
        staged.push({ key: i.key, json: JSON.stringify(v) });
      });
    } catch (e) { return { ok: false, error: 'Forberedelsen fejlede: ' + (e.message || e), changed: false }; }

    // Sikkerhedskopi af alt der ændres.
    var snap = { at: now, keys: {} };
    staged.forEach(function (s) { snap.keys[s.key] = { v: sget(st, s.key), u: sget(st, s.key + '__updatedAt') }; });
    try { st.setItem(SNAP_KEY, JSON.stringify(snap)); }
    catch (e) { return { ok: false, error: 'Kunne ikke oprette sikkerhedskopi af nuværende data (lager fuldt?). Intet er ændret.', changed: false }; }

    function rollback() {
      Object.keys(snap.keys).forEach(function (k) {
        try {
          if (snap.keys[k].v == null) st.removeItem(k); else st.setItem(k, snap.keys[k].v);
          if (snap.keys[k].u == null) st.removeItem(k + '__updatedAt'); else st.setItem(k + '__updatedAt', snap.keys[k].u);
        } catch (e) { /* bedste forsøg */ }
      });
    }
    try {
      staged.forEach(function (s) {
        st.setItem(s.key, s.json);
        if (sget(st, s.key) !== s.json) throw new Error('Verifikation fejlede for ' + s.key);
        if (/^(sbd_|lob_)/.test(s.key)) st.setItem(s.key + '__updatedAt', String(now)); // lokal gendannelse vinder over ældre serverkopi
      });
      st.setItem(EPOCH_KEY, String(now)); // får andre åbne faner til at genindlæse
    } catch (e) {
      rollback();
      return { ok: false, error: 'Skrivning fejlede — alt er rullet tilbage: ' + (e.message || e), changed: false, rolledBack: true };
    }
    // Log gendannelsen i metadata (kun tilføjelse; fejl her ændrer ikke resultatet).
    try {
      ['main', 'partner'].forEach(function (p) {
        if (staged.some(function (s) { return s.key === TP.KEYS.sbd[p] || s.key === TP.KEYS.lob[p]; })) {
          var m = TP.loadMeta(p, st); m.lastRestore = { at: now, from: plan.exportedAt || null, keys: staged.map(function (s) { return s.key; }) };
          TP.saveMeta(p, m, st);
        }
      });
    } catch (e) {}
    return { ok: true, changed: true, written: staged.map(function (s) { return s.key; }), at: now };
  };

  TP.hasSnapshot = function (storage) {
    var st = storage || TP.storage(); if (!st) return null;
    var raw = sget(st, SNAP_KEY); if (!raw) return null;
    try { var s = JSON.parse(raw); return { at: s.at, keys: Object.keys(s.keys || {}) }; } catch (e) { return null; }
  };
  TP.undoRestore = function (storage) {
    var st = storage || TP.storage(); if (!st) return { ok: false, error: 'Intet lager' };
    var raw = sget(st, SNAP_KEY); if (!raw) return { ok: false, error: 'Ingen sikkerhedskopi at gendanne fra.' };
    var snap; try { snap = JSON.parse(raw); } catch (e) { return { ok: false, error: 'Sikkerhedskopien er beskadiget.' }; }
    var now = String(Date.now());
    try {
      Object.keys(snap.keys).forEach(function (k) {
        if (snap.keys[k].v == null) st.removeItem(k); else st.setItem(k, snap.keys[k].v);
        if (/^(sbd_|lob_)/.test(k)) st.setItem(k + '__updatedAt', now);
      });
      st.setItem(EPOCH_KEY, now);
      st.removeItem(SNAP_KEY);
    } catch (e) { return { ok: false, error: 'Fortryd fejlede: ' + (e.message || e) }; }
    return { ok: true, keys: Object.keys(snap.keys) };
  };
  TP.RESTORE_EPOCH_KEY = EPOCH_KEY;

  return TP;
});
