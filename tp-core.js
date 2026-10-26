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

  /* ═══════════════ FASE 2: ØVELSESBIBLIOTEK (alternativer) ═══════════════
     Hver planlagt øvelse har som udgangspunkt 2 alternativer — men KUN hvor de er fagligt forsvarlige.
     Felter: g = muskelgruppe (som i dashboardets MUSCLE_MAP), p = bevægelsesmønster, e = udstyr, w = kort begrundelse.
     Hovedløft (squat/bænk/dødløft + backdowns + sekundære varianter) har alternativer, men er "beskyttede":
     et skift tæller ikke i programmets progression/1RM og kræver ekstra bekræftelse (se TP.substitutionPolicy).
     Øvelser uden jævnbyrdig erstatning (fx Jefferson Curl) har BEVIDST ingen alternativer.            */
  var A = function (n, g, p, e, w) { return { n: n, g: g, p: p, e: e, w: w }; };
  TP.ALT_LIB = {
    // ── Hovedløft (beskyttede) ──
    'Squat': { g: 'Quad', role: 'main', alts: [
      A('Front Squat', 'Quad', 'squat', 'stang+rack', 'Samme knæ-dominante squat-mønster med mere quad og oprejst overkrop; kræver lavere vægt — tæller ikke som din squat.'),
      A('Safety Bar Squat', 'Quad', 'squat', 'safety bar', 'Tæt på lavstang-squat, men lettere for skuldre/albuer; bruges ved skulder- eller håndledsgener.')] },
    'Bench Press': { g: 'Bryst', role: 'main', alts: [
      A('Dumbbell Bench Press', 'Bryst', 'push-horisontal', 'hantler+bænk', 'Samme bryst/skulder/triceps-mønster med friere bane og større bevægelsesudslag; vægte er ikke sammenlignelige med stang.'),
      A('Smith Machine Bench Press', 'Bryst', 'push-horisontal', 'Smith', 'Fast bane — en mulighed uden spotter eller når stangen er optaget; ikke 1:1 med fri stang.')] },
    'Deadlift (Conv.)': { g: 'Post. Chain', role: 'main', alts: [
      A('Trap Bar Deadlift', 'Post. Chain', 'hinge', 'trap bar', 'Samme hofte/ben-løft med mere quad-bidrag og lettere for lænden; vægte ikke direkte sammenlignelige.'),
      A('Rack Pull', 'Post. Chain', 'hinge', 'stang+rack', 'Dødløft fra forhøjet start: træner lockout og ryg/greb med mindre træthed i bunden.')] },
    // ── Sekundære hovedløft-varianter (beskyttede) ──
    'Pause Bench Press': { g: 'Bryst', role: 'main', alts: [
      A('Spoto Press', 'Bryst', 'push-horisontal', 'stang+bænk', 'Pause lige over brystet — træner samme svage punkt som pause-bænk.'),
      A('Dumbbell Bench Press (pause)', 'Bryst', 'push-horisontal', 'hantler+bænk', 'Pause i bunden med hantler — skulder-venligere og styrer ensidighed.')] },
    'Box Squat': { g: 'Quad', role: 'main', alts: [
      A('Pause Squat', 'Quad', 'squat', 'stang+rack', 'Pause i bunden uden boks — samme styrke i hullet og kontrol.'),
      A('Front Squat', 'Quad', 'squat', 'stang+rack', 'Quad-dominant squat med oprejst overkrop; lavere vægte.')] },
    'Deficit Deadlift (2 cm)': { g: 'Post. Chain', role: 'main', alts: [
      A('Rack Pull', 'Post. Chain', 'hinge', 'stang+rack', 'Kortere vej: mindre krævende alternativ ved træthed — men træner ikke starten som deficit.'),
      A('Trap Bar Deadlift', 'Post. Chain', 'hinge', 'trap bar', 'Hofte/ben-løft med lavere lændebelastning.')] },
    'Box Jump': { g: 'Core', role: 'power', alts: [
      A('Squat Jump (bodyvægt)', 'Quad', 'power', 'ingen', 'Samme eksplosive hoftestræk/knæstræk uden boks — mindre landingsbelastning.'),
      A('Standing Broad Jump', 'Quad', 'power', 'ingen', 'Horisontal power — samme rate-of-force-development uden udstyr.')] },
    // ── Accessories ──
    'Incline DB Press': { g: 'Bryst', role: 'acc', alts: [
      A('Incline Machine Press', 'Bryst', 'push-skrå', 'maskine', 'Samme øvre-bryst-mønster med fast bane — nemt at køre tæt på udmattelse.'),
      A('Incline Smith Machine Press', 'Bryst', 'push-skrå', 'Smith', 'Skråt press med stabil bane; justerbar bænk kræves.')] },
    'Overhead Triceps Ext. (Cable)': { g: 'Triceps', role: 'acc', alts: [
      A('Overhead Triceps Extension (Hantel)', 'Triceps', 'triceps-over-hoved', 'hantel', 'Samme overhead-position og langhoved-fokus uden kabel.'),
      A('Skull Crushers (EZ-stang)', 'Triceps', 'triceps-lig', 'EZ-stang+bænk', 'Tung triceps-ekstension med god belastning i strakt arm.')] },
    'Triceps Extension (Cable)': { g: 'Triceps', role: 'acc', alts: [
      A('Triceps Pushdown (Reb)', 'Triceps', 'triceps-nedtryk', 'kabel', 'Nedtræk med reb — samme triceps-funktion, lidt mere udadrotation i bunden.'),
      A('Skull Crushers (EZ-stang)', 'Triceps', 'triceps-lig', 'EZ-stang+bænk', 'Fri-vægt triceps-ekstension.')] },
    'Chest Fly (Machine)': { g: 'Bryst', role: 'acc', alts: [
      A('Cable Fly', 'Bryst', 'fly', 'kabel', 'Samme adduktions-mønster med konstant spænding gennem hele bevægelsen.'),
      A('Dumbbell Fly', 'Bryst', 'fly', 'hantler+bænk', 'Strakt-muskel-stimulus i bunden; brug moderat vægt.')] },
    'Lateral Raise (Machine)': { g: 'Skulder', role: 'acc', alts: [
      A('Lateral Raise (Kabel)', 'Skulder', 'sidehæv', 'kabel', 'Konstant spænding i bunden — samme midt-deltoid-fokus.'),
      A('Lateral Raise (Hantler)', 'Skulder', 'sidehæv', 'hantler', 'Klassisk sidehæv; mest spænding i toppen.')] },
    'Hack Squat (Machine)': { g: 'Quad', role: 'acc', alts: [
      A('Leg Press', 'Quad', 'squat-maskine', 'maskine', 'Samme knæ-dominante mønster og quad-fokus med fast bane og mindre rygbelastning.'),
      A('Smith Machine Squat', 'Quad', 'squat-maskine', 'Smith', 'Stabil bane — foden frem giver quad-fokus som hack squat.')] },
    'Leg Extension (Machine)': { g: 'Quad', role: 'acc', alts: [
      A('Sissy Squat', 'Quad', 'quad-isolation', 'ingen/støtte', 'Isolerer quad (især rectus femoris) med kropsvægt; god i strakt position.'),
      A('Reverse Nordic Curl', 'Quad', 'quad-isolation', 'ingen/pude', 'Excentrisk quad-stimulus i lang muskellængde — kropsvægt.')] },
    'Seated Leg Curl (Machine)': { g: 'Post. Chain', role: 'acc', alts: [
      A('Lying Leg Curl (Machine)', 'Post. Chain', 'knæbøj', 'maskine', 'Samme hamstring-knæfleksion; liggende position belaster hamstrings lidt anderledes.'),
      A('Nordic Hamstring Curl (støttet)', 'Post. Chain', 'knæbøj', 'ingen/støtte', 'Excentrisk hamstring-arbejde; brug elastik/hænder til at tage af.')] },
    'Calf Raise (Machine)': { g: 'Lægge', role: 'acc', alts: [
      A('Standing Calf Raise (Smith)', 'Lægge', 'lægge', 'Smith', 'Samme stående lægge-hæv med fri bane.'),
      A('Leg Press Calf Raise', 'Lægge', 'lægge', 'benpres', 'Lægge-hæv i benpres — stabil og let at lægge vægt på.')] },
    'Cable Crunch': { g: 'Core', role: 'acc', alts: [
      A('Machine Crunch', 'Core', 'bugfleksion', 'maskine', 'Samme belastede mavebøjning med fast bane.'),
      A('Hanging Knee Raise', 'Core', 'bugfleksion', 'chinsstang', 'Bug/hoftebøjere med kropsvægt; kræver greb.')] },
    'Overhead Press (Seated DB)': { g: 'Skulder', role: 'acc', alts: [
      A('Overhead Press (Maskine)', 'Skulder', 'push-lodret', 'maskine', 'Samme skulderpres med fast bane.'),
      A('Overhead Press (Stående stang)', 'Skulder', 'push-lodret', 'stang+rack', 'Klassisk skulderpres — mere core/balancekrav.')] },
    'Lat Pulldown Wide Grip': { g: 'Ryg', role: 'acc', alts: [
      A('Assisted Pull-up (Maskine)', 'Ryg', 'træk-lodret', 'maskine', 'Samme lodrette træk i bredt greb med kropsvægt-reference.'),
      A('Single-Arm Cable Pulldown', 'Ryg', 'træk-lodret', 'kabel', 'Ensidigt lodret træk — længere bevægelse og lat-fokus.')] },
    'Smith Machine Row': { g: 'Ryg', role: 'acc', alts: [
      A('Barbell Row (Pendlay)', 'Ryg', 'træk-vandret', 'stang', 'Samme vandrette roning med stang fra gulvet.'),
      A('One-Arm Dumbbell Row', 'Ryg', 'træk-vandret', 'hantel+bænk', 'Ensidig roning med støtte — skåner lænden.')] },
    'Seated Cable Row (V-Grip)': { g: 'Ryg', role: 'acc', alts: [
      A('Seated Row (Maskine)', 'Ryg', 'træk-vandret', 'maskine', 'Samme vandrette træk med fast bane og brystpude.'),
      A('One-Arm Cable Row', 'Ryg', 'træk-vandret', 'kabel', 'Ensidigt kabelroning — større bevægelsesudslag.')] },
    'Hammer Curl (DB)': { g: 'Biceps', role: 'acc', alts: [
      A('Hammer Curl (Kabel)', 'Biceps', 'curl', 'kabel', 'Samme neutrale greb (brachialis/underarm) med konstant spænding.'),
      A('Cross-Body Hammer Curl', 'Biceps', 'curl', 'hantler', 'Neutral curl henover kroppen — fokus på brachialis.')] },
    'Close Grip Bench Press': { g: 'Triceps', role: 'acc', alts: [
      A('Close Grip Bench Press (Smith)', 'Triceps', 'push-horisontal', 'Smith', 'Samme smalle bænk med fast bane.'),
      A('Dumbbell Close-Grip Press (neutral)', 'Triceps', 'push-horisontal', 'hantler+bænk', 'Neutral håndled-position — mere triceps, skånsom for albuer.')] },
    'Rear Delt Reverse Fly (Machine)': { g: 'Skulder', role: 'acc', alts: [
      A('Rear Delt Fly (Kabel)', 'Skulder', 'bagskulder', 'kabel', 'Samme bagskulder-træk med kabel.'),
      A('Rear Delt Fly (Hantler, foroverbøjet)', 'Skulder', 'bagskulder', 'hantler', 'Klassisk bagskulderløft — brug let vægt og kontrol.')] },
    'Face Pull (Cable)': { g: 'Skulder', role: 'acc', alts: [
      A('Band Pull-Apart', 'Skulder', 'bagskulder', 'elastik', 'Samme bagskulder/rotator-fokus uden kabel.'),
      A('Rear Delt Row (Kabel)', 'Skulder', 'bagskulder', 'kabel', 'Højt roning mod brystet — samme muskler.')] },
    'Romanian Deadlift': { g: 'Post. Chain', role: 'acc', alts: [
      A('Romanian Deadlift (Hantler)', 'Post. Chain', 'hinge', 'hantler', 'Samme hofte-hinge og hamstring-stræk med hantler.'),
      A('Cable Pull-Through', 'Post. Chain', 'hinge', 'kabel', 'Hinge-mønster med kabel — skånsomt for lænden.')] },
    'Hip Thrust (Barbell)': { g: 'Post. Chain', role: 'acc', alts: [
      A('Hip Thrust (Maskine)', 'Post. Chain', 'hofte-ekstension', 'maskine', 'Samme glute-hofteekstension med fast bane.'),
      A('Glute Bridge (Stang)', 'Post. Chain', 'hofte-ekstension', 'stang', 'Fra gulvet — kortere bane, samme glute-mønster.')] },
    'Hip Adduction (Machine)': { g: 'Adduktor', role: 'acc', alts: [
      A('Cable Hip Adduction', 'Adduktor', 'adduktion', 'kabel', 'Samme adduktor-funktion med kabel (ensidigt).'),
      A('Copenhagen Plank', 'Adduktor', 'adduktion', 'bænk', 'Isometrisk adduktor-arbejde med kropsvægt.')] },
    'Weighted Pull-up': { g: 'Ryg', role: 'acc', alts: [
      A('Pull-up (Assisteret)', 'Ryg', 'træk-lodret', 'maskine/elastik', 'Samme pull-up med hjælp — når vægt-pull-ups er for tunge.'),
      A('Lat Pulldown Wide Grip', 'Ryg', 'træk-lodret', 'kabel', 'Lodret træk i maskine, nem at doseres.')] },
    'Chest Supported Row (Machine)': { g: 'Ryg', role: 'acc', alts: [
      A('Chest Supported DB Row', 'Ryg', 'træk-vandret', 'hantler+bænk', 'Samme understøttede roning med hantler.'),
      A('T-Bar Row (brystunderstøttet)', 'Ryg', 'træk-vandret', 'T-bar', 'Tung, understøttet roning — mindre lændebelastning.')] },
    'Neutral Grip Pulldown': { g: 'Ryg', role: 'acc', alts: [
      A('Lat Pulldown (Underhånd)', 'Ryg', 'træk-lodret', 'kabel', 'Lodret træk med underhånd — mere biceps og lat.'),
      A('Assisted Pull-up (Neutral)', 'Ryg', 'træk-lodret', 'maskine', 'Neutralt greb, kropsvægt-reference.')] },
    'Preacher Curl (DB)': { g: 'Biceps', role: 'acc', alts: [
      A('Preacher Curl (Maskine)', 'Biceps', 'curl', 'maskine', 'Samme understøttede curl med fast bane.'),
      A('Incline Dumbbell Curl', 'Biceps', 'curl', 'hantler+bænk', 'Strakt-position curl — stor muskellængde.')] },
    // ── Ingen jævnbyrdig erstatning: bevidst tom ──
    'Jefferson Curl': { g: 'Post. Chain', role: 'acc', alts: [], noAltWhy: 'Mobilitets-/rygøvelse under let belastning — ingen jævnbyrdig erstatning. Spring over eller behold.' }
  };
  // Muskelgrupper for alternative navne (flettes ind i sidernes MUSCLE_MAP, så historik/volumen tæller dem rigtigt)
  TP.MUSCLE_EXTRA = (function () {
    var m = {};
    Object.keys(TP.ALT_LIB).forEach(function (k) {
      var L = TP.ALT_LIB[k];
      L.alts.forEach(function (a) { m[a.n] = a.g; });
    });
    return m;
  })();

  /* ═══════════════ FASE 2: SUBSTITUTION — rene regler ═══════════════ */
  // Basisnavn: fjerner suffikser, så "Squat — Backdown", "… — Let", "… — Volumen" slår op på samme bibliotekspost.
  TP.baseName = function (name) {
    return String(name || '').replace(/ — (Backdown|Let|Volumen|1RM Forsøg)$/i, '').replace(/ \(variation\)$/i, '').trim();
  };
  // Beskyttede = hovedløft, backdowns og sekundære hovedløft-varianter. Deres progression må aldrig påvirkes af et skift.
  TP.isProtectedType = function (type) { return type === 'primary' || type === 'secondary' || type === 'backdown'; };

  // Alternativer for en planlagt øvelse. state = profilens SBD-blob (kun til altOverrides). Altid max 2.
  TP.altsFor = function (plannedName, state) {
    var base = TP.baseName(plannedName), lib = TP.ALT_LIB[base] || null;
    var ov = state && state.altOverrides && state.altOverrides[TP.exId(base)];
    var out = { planned: plannedName, base: base, role: lib ? lib.role : null, group: lib ? lib.g : null, alts: [], custom: false, noAltWhy: null };
    if (Array.isArray(ov) && ov.length) {
      out.custom = true;
      ov.slice(0, 2).forEach(function (n) {
        var hit = null;
        Object.keys(TP.ALT_LIB).forEach(function (k) { TP.ALT_LIB[k].alts.forEach(function (a) { if (a.n === n) hit = a; }); });
        out.alts.push({ name: n, group: hit ? hit.g : (lib && lib.g), pattern: hit ? hit.p : null, equip: hit ? hit.e : null, why: hit ? hit.w : 'Valgt af dig som alternativ.', source: 'custom' });
      });
      return out;
    }
    if (/1RM Forsøg$/i.test(plannedName)) { out.noAltWhy = 'Et 1RM-forsøg kan ikke erstattes — det måler netop den konkrete øvelse.'; return out; }
    if (!lib) { out.noAltWhy = 'Ingen standardalternativer er defineret for denne øvelse.'; return out; }
    lib.alts.slice(0, 2).forEach(function (a) { out.alts.push({ name: a.n, group: a.g, pattern: a.p, equip: a.e, why: a.w, source: 'standard' }); });
    if (!out.alts.length) out.noAltWhy = lib.noAltWhy || 'Ingen jævnbyrdig erstatning.';
    return out;
  };
  // Redigér alternativer for én øvelse (valgfrit: max 2 navne). Returnerer ny override-liste.
  TP.setAltOverride = function (state, plannedName, names) {
    if (!state.altOverrides) state.altOverrides = {};
    var key = TP.exId(TP.baseName(plannedName));
    var clean = (names || []).map(function (n) { return String(n || '').trim(); }).filter(Boolean).slice(0, 2);
    if (!clean.length) delete state.altOverrides[key]; else state.altOverrides[key] = clean;
    return state.altOverrides[key] || null;
  };

  // Lægger substitutioner oven på en planlagt øvelsesliste. Returnerer ny liste (muterer ikke input).
  //  ctx.subs      : state.exerciseSubs  { plannedName: { to, since } }  (permanent/"fremtidige")
  //  ctx.log       : dagens log (eller null) — logEx.plannedName/name er kilde til "kun dette pas"
  //  ctx.lastPerf  : fn(name) -> { kg, reps } | null  — KUN den valgte øvelses egen historik
  // Regler: vægte overføres ALDRIG fra den planlagte øvelse; navnet bliver den faktisk udførte øvelse
  // (så historik, PR og 1RM automatisk holdes adskilt); plannedName bevares; beskyttede typer får ingen auto-vægt.
  TP.applySubstitutions = function (list, ctx) {
    ctx = ctx || {};
    return list.map(function (ex, ei) {
      var logEx = ctx.log && ctx.log.exercises && ctx.log.exercises[ei];
      var to = null, scope = null;
      if (logEx && logEx.plannedName === ex.name && logEx.name && logEx.name !== ex.name) { to = logEx.name; scope = (logEx.sub && logEx.sub.scope) || 'session'; }
      else if (!logEx && ctx.subs && ctx.subs[ex.name] && ctx.subs[ex.name].to) { to = ctx.subs[ex.name].to; scope = 'future'; }
      if (!to) return ex;
      var out = {}; Object.keys(ex).forEach(function (k) { out[k] = ex[k]; });
      out.plannedName = ex.name; out.name = to; out.substituted = true; out.subScope = scope;
      out.scheme = {}; Object.keys(ex.scheme || {}).forEach(function (k) { out.scheme[k] = ex.scheme[k]; });
      var lp = ctx.lastPerf ? ctx.lastPerf(to) : null;
      out.scheme.kg = lp && lp.kg > 0 ? lp.kg : '';
      delete out.scheme.pct; delete out.scheme.isRampBack; delete out.scheme.rampCeilingKg;
      if (TP.isProtectedType(ex.type)) { out.warmup = false; out.protectedSub = true; }
      return out;
    });
  };
  // Opretter/ændrer en logpost (kun hvis ingen sæt er gennemført). Returnerer {ok, reason}.
  TP.switchLogExercise = function (state, key, ei, plannedName, toName, scope, now) {
    var log = state.logs && state.logs[key]; var logEx = log && log.exercises && log.exercises[ei];
    if (!logEx) return { ok: false, reason: 'Øvelsen findes ikke i dagens log.' };
    if ((logEx.sets || []).some(function (s) { return s.done; })) return { ok: false, reason: 'Du har allerede gennemført sæt — skift er kun muligt før første sæt.' };
    var planned = logEx.plannedName || logEx.name;
    if (planned !== plannedName) return { ok: false, reason: 'Planlagt øvelse matcher ikke.' };
    if (toName === plannedName) { // tilbage til primær
      logEx.name = plannedName; delete logEx.plannedName; delete logEx.sub;
    } else {
      logEx.plannedName = plannedName; logEx.name = toName; logEx.sub = { scope: scope || 'session', at: now || Date.now() };
    }
    (logEx.sets || []).forEach(function (s) { s.kg = ''; }); // aldrig overfør vægt til/fra en anden øvelse
    delete logEx.warmupKg;
    if (scope === 'future') {
      if (!state.exerciseSubs) state.exerciseSubs = {};
      if (toName === plannedName) delete state.exerciseSubs[plannedName];
      else state.exerciseSubs[plannedName] = { to: toName, since: TP.localISO(new Date(now || Date.now())) };
    }
    return { ok: true };
  };
  TP.clearFutureSub = function (state, plannedName) { if (state.exerciseSubs) delete state.exerciseSubs[plannedName]; };
  // Resumé af substitutioner i en session (til historik/visning).
  TP.sessionSubstitutions = function (log) {
    return ((log && log.exercises) || []).filter(function (e) { return e && e.plannedName && e.plannedName !== e.name; })
      .map(function (e) { return { planned: e.plannedName, actual: e.name, scope: (e.sub && e.sub.scope) || 'session' }; });
  };

  /* ═══════════════ FASE 2: EFTER-TRÆNING-EVALUERING ═══════════════
     Subjektiv selvrapportering — vises ALDRIG som fysiologisk måling. Bruges forsigtigt: først ved gentagne mønstre. */
  TP.EVAL_PAIN = ['Skulder', 'Albue', 'Håndled', 'Lænd', 'Hofte', 'Knæ', 'Ankel/fod', 'Andet'];
  TP.EVAL_VS = { easier: 'Lettere end ventet', as: 'Som ventet', harder: 'Hårdere end ventet' };
  // Renser og validerer en evaluering. Returnerer null hvis intet meningsfuldt er udfyldt.
  TP.normalizeEval = function (e, now) {
    if (!e || typeof e !== 'object') return null;
    var int = function (v, lo, hi) { v = parseInt(v, 10); return isFinite(v) && v >= lo && v <= hi ? v : null; };
    var out = { effort: int(e.effort, 1, 10), energy: int(e.energy, 1, 5), vs: TP.EVAL_VS[e.vs] ? e.vs : null,
      pain: Array.isArray(e.pain) ? e.pain.filter(function (p, i, a) { return TP.EVAL_PAIN.indexOf(p) >= 0 && a.indexOf(p) === i; }) : [],
      comment: String(e.comment || '').replace(/\s+/g, ' ').trim().slice(0, 500), ts: e.ts || now || Date.now() };
    if (out.effort == null && out.energy == null && !out.vs && !out.pain.length && !out.comment) return null;
    return out;
  };
  // Resumé af seneste evalueringer (liste af {date, effort, energy, vs, pain}). Gentagelser kræves før noget udledes.
  TP.evalPattern = function (list) {
    var l = (list || []).filter(Boolean).slice(-6), n = l.length, res = { n: n, notes: [] };
    if (n < 3) return res; // én eller to svar er for tyndt et grundlag
    var harder = l.filter(function (x) { return x.vs === 'harder'; }).length;
    var lowEnergy = l.filter(function (x) { return x.energy != null && x.energy <= 2; }).length;
    var hiEffort = l.filter(function (x) { return x.effort != null && x.effort >= 9; }).length;
    var painCount = {}; l.forEach(function (x) { (x.pain || []).forEach(function (p) { painCount[p] = (painCount[p] || 0) + 1; }); });
    if (harder >= 3) res.notes.push('Du har oplevet ' + harder + ' af de seneste ' + n + ' pas som hårdere end ventet.');
    if (lowEnergy >= 3) res.notes.push('Lav energi (1–2) rapporteret i ' + lowEnergy + ' af de seneste ' + n + ' pas.');
    if (hiEffort >= 3) res.notes.push('Anstrengelse 9–10 rapporteret i ' + hiEffort + ' af de seneste ' + n + ' pas.');
    Object.keys(painCount).forEach(function (p) { if (painCount[p] >= 2) res.notes.push(p + ' er nævnt som ømhed/smerte i ' + painCount[p] + ' af de seneste ' + n + ' pas. Det er selvrapporteret — ikke en diagnose; tal med en fagperson hvis det fortsætter.'); });
    return res;
  };

  return TP;
});
