/* ═══════════════════════════════════════════════════════════════════════════
   TRÆNING — FÆLLES SYNKRONISERING (V3.1)  — kræver tp-core.js
   Erstatter de tre kopier af syncPull/syncPush (dashboard, SBD, løb) med ÉN implementering.

   Hvad den gør ud over den gamle "sidste skrivning vinder":
     • Ændringsdetektion: hver nøgle har en synk-hash (indholdet som serveren sidst bekræftede). Er lokale data
       ændret siden (offline-ændringer) OG serveren er nyere → KONFLIKT. Intet overskrives tavst.
     • Betinget skrivning (baseUpdatedAt) mod Worker v2; mod en gammel Worker tjekkes serverens version først.
     • Blob-nøgler (sbd_*, lob_*): konflikt → brugeren vælger "denne enhed" / "den anden enhed" / henter begge som filer.
       Den version der fravælges lægges altid i en lokal sikkerhedskopi (1 plads pr. nøgle).
     • Metadata (tp_meta_*): tabsfri tilstandsbaseret sammenfletning (union + tombstones + tidsstempel-registre) — ingen konflikt-dialog nødvendig.
     • Profilisolering: hver nøgle synkroniseres for sig; metadata bærer sin profil og afvises hvis den ikke matcher nøglen.
       sbd_state.profile (den AKTIVE profil på enheden) ignoreres ved pull, så en anden enhed aldrig kan skifte hvem du logger som.
     • sync_token læses kun til Authorization-headeren — skrives aldrig til log, status eller backup.
   Testbar i Node: TPSYNC.create({storage, fetch, baseUrl, token, now}).
   ═══════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./tp-core.js'));
  else root.TPSYNC = factory(root.TP);
})(typeof self !== 'undefined' ? self : this, function (TP) {
  'use strict';
  var S = {};
  S.BLOB_KEYS = ['sbd_state', 'sbd_partner', 'lob_state', 'lob_partner'];
  S.META_KEYS = ['tp_meta_main', 'tp_meta_partner'];
  S.ALL_KEYS = S.BLOB_KEYS.concat(S.META_KEYS);
  var META_PROFILE = { tp_meta_main: 'main', tp_meta_partner: 'partner' };
  var TOMB_DAYS = 120;
  var DAY = 86400000;

  function isObj(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }
  function clone(x) { return x == null ? x : JSON.parse(JSON.stringify(x)); }
  function isMeta(key) { return !!META_PROFILE[key]; }
  S.isMeta = isMeta;
  var LABELS = { sbd_state: 'Styrke (Oliver)', sbd_partner: 'Styrke (Ellen)', lob_state: 'Løb (Oliver)', lob_partner: 'Løb (Ellen)', tp_meta_main: 'Planlægning (Oliver)', tp_meta_partner: 'Planlægning (Ellen)' };
  S.label = function (k) { return LABELS[k] || k; };

  /* ═══════════ Metadata: projektion + tabsfri sammenfletning ═══════════ */
  // Kun brugerdata synkroniseres. IKKE: reports (kan genberegnes ud fra de synkroniserede logs), lastRestore (lokal hændelse).
  S.projectMeta = function (meta, profile) {
    var m = TP.migrateMeta(meta);
    return clone({
      v: 1, profile: profile,
      planChanges: m.planChanges, tombs: m.tombs,
      dismissed: m.dismissed, dismissTombs: m.dismissTombs,
      goalPriority: m.goalPriority,
      cal: { blocked: m.cal.blocked, catchup: m.cal.catchup, anchor: profile === 'main' ? m.cal.anchor : null }
    });
  };
  function normProj(p, profile) {
    var base = TP.defaultMeta();
    var o = isObj(p) ? p : {};
    return {
      v: 1, profile: profile,
      planChanges: Array.isArray(o.planChanges) ? o.planChanges.filter(function (c) { return isObj(c) && c.id; }) : [],
      tombs: isObj(o.tombs) ? o.tombs : {},
      dismissed: isObj(o.dismissed) ? o.dismissed : {},
      dismissTombs: isObj(o.dismissTombs) ? o.dismissTombs : {},
      goalPriority: isObj(o.goalPriority) ? o.goalPriority : base.goalPriority,
      cal: {
        blocked: isObj(o.cal && o.cal.blocked) ? o.cal.blocked : {},
        catchup: isObj(o.cal && o.cal.catchup) ? o.cal.catchup : {},
        anchor: o.cal && isObj(o.cal.anchor) ? o.cal.anchor : null
      }
    };
  }
  function maxMap(a, b) {
    var out = {}; [a, b].forEach(function (m) { Object.keys(m || {}).forEach(function (k) { var v = +m[k] || 0; if (out[k] == null || v > out[k]) out[k] = v; }); });
    return out;
  }
  function mergeReg(a, b) { // register {dato: {on,t}} — største t vinder; ved lighed vinder "on" (fortrydelse af en dag er mere skånsomt end at miste den)
    var out = {};
    var keys = {}; Object.keys(a || {}).concat(Object.keys(b || {})).forEach(function (k) { keys[k] = 1; });
    Object.keys(keys).forEach(function (k) {
      var x = a && a[k], y = b && b[k];
      if (!isObj(x)) out[k] = y; else if (!isObj(y)) out[k] = x;
      else if ((+x.t || 0) > (+y.t || 0)) out[k] = x; else if ((+y.t || 0) > (+x.t || 0)) out[k] = y; else out[k] = { on: !!(x.on || y.on), t: +x.t || 0 };
    });
    return out;
  }
  var FOCUS_NAME = { balanced: 'Balanceret hybrid', strength: 'Styrke først', hypertrophy: 'Hypertrofi først', run: 'Løb først' };
  // Returnerer {value, notes[]}. Kommutativ + idempotent: merge(a,b) ≡ merge(b,a), merge(a,a) ≡ a.
  S.mergeMeta = function (local, remote, profile, now) {
    now = now || Date.now();
    var l = normProj(local, profile), r = normProj(remote, profile), notes = [];
    var cutoff = now - TOMB_DAYS * DAY;

    var tombs = maxMap(l.tombs, r.tombs);
    var seen = {}, changes = [];
    [l.planChanges, r.planChanges].forEach(function (list) {
      list.forEach(function (c) { if (seen[c.id]) return; seen[c.id] = 1; if (tombs[c.id]) return; changes.push(c); });
    });
    changes.sort(function (a, b) { return ((+a.at || 0) - (+b.at || 0)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); });
    var lIds = {}; l.planChanges.forEach(function (c) { lIds[c.id] = 1; });
    var added = changes.filter(function (c) { return !lIds[c.id]; }).length;
    var removed = l.planChanges.filter(function (c) { return tombs[c.id]; }).length;
    if (added) notes.push(added + ' planændring' + (added > 1 ? 'er' : '') + ' hentet fra en anden enhed');
    if (removed) notes.push(removed + ' planændring' + (removed > 1 ? 'er' : '') + ' fortrudt på en anden enhed');
    Object.keys(tombs).forEach(function (id) { if (tombs[id] < cutoff) delete tombs[id]; });

    var dTombs = maxMap(l.dismissTombs, r.dismissTombs), dis = {};
    [l.dismissed, r.dismissed].forEach(function (m) {
      Object.keys(m).forEach(function (k) {
        var e = m[k], at = isObj(e) ? (+e.at || 0) : (+e || 0);
        if (dTombs[k] != null && dTombs[k] >= at) return;
        var cur = dis[k]; var curAt = cur ? (isObj(cur) ? (+cur.at || 0) : (+cur || 0)) : -1;
        if (at > curAt) dis[k] = e;
      });
    });
    Object.keys(dTombs).forEach(function (k) { if (dTombs[k] < cutoff) delete dTombs[k]; });

    var lg = l.goalPriority, rg = r.goalPriority, goal = lg;
    if ((+rg.at || 0) > (+lg.at || 0)) {
      goal = rg;
      if ((+lg.at || 0) > 0 && lg.focus !== rg.focus) notes.push('Fokus er ændret på en anden enhed: ' + (FOCUS_NAME[rg.focus] || rg.focus) + ' (var ' + (FOCUS_NAME[lg.focus] || lg.focus) + ' her)');
    }
    var blocked = mergeReg(l.cal.blocked, r.cal.blocked), catchup = mergeReg(l.cal.catchup, r.cal.catchup);
    [blocked, catchup].forEach(function (reg) { Object.keys(reg).forEach(function (d) { if (!reg[d].on && (+reg[d].t || 0) < cutoff && (+reg[d].t || 0) > 0) delete reg[d]; }); });
    var anchor = l.cal.anchor, ra = r.cal.anchor;
    if (!anchor || (ra && (+ra.t || 0) > (+anchor.t || 0))) anchor = ra || anchor;
    if (profile !== 'main') anchor = null;

    return {
      value: { v: 1, profile: profile, planChanges: changes, tombs: tombs, dismissed: dis, dismissTombs: dTombs, goalPriority: clone(goal), cal: { blocked: blocked, catchup: catchup, anchor: anchor } },
      notes: notes
    };
  };

  /* ═══════════ Motor ═══════════ */
  S.create = function (opts) {
    opts = opts || {};
    var E = {};
    var storage = opts.storage || TP.storage();
    var fetchFn = opts.fetch || (typeof fetch === 'function' ? fetch.bind(typeof self !== 'undefined' ? self : undefined) : null);
    var baseUrl = (opts.baseUrl || '').replace(/\/+$/, '');
    var getToken = opts.getToken || function () { return sget('sync_token') || ''; };
    var now = opts.now || function () { return Date.now(); };
    var timers = {}, locks = {}, listeners = [];
    var caps = null; // {api, conditionalPut}

    function sget(k) { try { return storage.getItem(k); } catch (e) { return null; } }
    function sset(k, v) { try { storage.setItem(k, v); return true; } catch (e) { return false; } }
    function sdel(k) { try { storage.removeItem(k); } catch (e) {} }
    function readJson(k) { var r = sget(k); if (r == null) return null; try { return JSON.parse(r); } catch (e) { return null; } }
    function int(v) { v = parseInt(v, 10); return isFinite(v) ? v : 0; }
    function emit(ev) { listeners.slice().forEach(function (fn) { try { fn(ev); } catch (e) {} }); }
    E.on = function (fn) { listeners.push(fn); };
    E.enabled = function () { return !!baseUrl && baseUrl.indexOf('REPLACE-ME') < 0 && baseUrl.indexOf('REDACTED') < 0 && !!fetchFn; };

    /* ── status (lokal, aldrig med i backup/sync) ── */
    var ST_KEY = 'tp_sync_state';
    function getState() { var s = readJson(ST_KEY); return isObj(s) ? s : { lastOk: 0, lastErr: null, unsupported: {}, auth: false }; }
    function setState(patch) { var s = getState(); Object.keys(patch).forEach(function (k) { s[k] = patch[k]; }); sset(ST_KEY, JSON.stringify(s)); }
    function noteOk() { setState({ lastOk: now(), lastErr: null, auth: false }); }
    function noteErr(kind, key) { var s = getState(); s.lastErr = { at: now(), kind: kind, key: key || null }; if (kind === 'auth') s.auth = true; sset(ST_KEY, JSON.stringify(s)); }
    function pushNote(text) {
      var n = readJson('tp_sync_notes'); if (!Array.isArray(n)) n = [];
      n.push({ at: now(), text: text }); sset('tp_sync_notes', JSON.stringify(n.slice(-8)));
    }

    /* ── hjælpere pr. nøgle ── */
    // sbd_state.profile er enhedens AKTIVE profil (UI-valg) — ikke data. Ignoreres i hash og ved pull.
    function comparable(key, value) {
      if (key === 'sbd_state' && isObj(value)) { var c = clone(value); delete c.profile; return c; }
      return value;
    }
    function hashOf(key, value) { return TP.hash(TP.canon(comparable(key, value))); }
    function localValue(key) { var raw = sget(key); if (raw == null) return { raw: null, value: null }; try { return { raw: raw, value: JSON.parse(raw) }; } catch (e) { return { raw: raw, value: null, corrupt: true }; } }
    function metaProjection(key) { var lv = localValue(key); return S.projectMeta(lv.value, META_PROFILE[key]); }
    function syncedHash(key) { return sget(key + '__sh'); }
    function baseTs(key) { return int(sget(key + '__updatedAt')); }
    function isEmptyBlob(key, v) {
      if (!isObj(v)) return true;
      if (/^sbd_/.test(key)) return !((v.completedDays || []).length || Object.keys(v.logs || {}).length);
      if (/^lob_/.test(key)) return !((v.runs || []).length);
      return false;
    }
    function currentHash(key) {
      if (isMeta(key)) return TP.hash(TP.canon(metaProjection(key)));
      var lv = localValue(key); if (lv.raw == null || lv.corrupt) return null;
      return hashOf(key, lv.value);
    }
    // Er der lokale ændringer serveren ikke har bekræftet?
    E.isDirty = function (key) {
      var h = currentHash(key);
      if (isMeta(key)) { var sh = syncedHash(key); return h !== sh; }
      if (h == null) return false;
      var sh2 = syncedHash(key);
      return sh2 != null && h !== sh2; // sh2 == null → ukendt (se pull)
    };
    E.pending = function () { return S.ALL_KEYS.filter(function (k) { return !conflictOf(k) && E.isDirty(k); }); };

    /* ── netværk ── */
    function headers(extra) {
      var h = {}; Object.keys(extra || {}).forEach(function (k) { h[k] = extra[k]; });
      var t = getToken(); if (t) h['Authorization'] = 'Bearer ' + t;
      return h;
    }
    function req(method, path, body) {
      var init = { method: method, cache: 'no-store', headers: headers(body ? { 'Content-Type': 'application/json' } : null) };
      if (body) init.body = JSON.stringify(body);
      return fetchFn(baseUrl + path, init);
    }
    async function getCaps() {
      if (caps) return caps;
      try {
        var res = await req('GET', '/version');
        if (res.ok) { var j = await res.json(); caps = { api: +j.api || 1, conditionalPut: !!j.conditionalPut, keys: j.keys || [] }; }
        else caps = { api: 1, conditionalPut: false, keys: S.BLOB_KEYS.slice() };
      } catch (e) { return { api: 0, conditionalPut: false, keys: [], offline: true }; } // ikke cachet
      var st = getState(); st.api = caps.api; sset(ST_KEY, JSON.stringify(st));
      return caps;
    }
    E.capabilities = getCaps;
    async function fetchRecord(key) {
      var res;
      try { res = await req('GET', '/kv/' + key); } catch (e) { return { status: 'offline' }; }
      if (res.status === 401) { noteErr('auth', key); return { status: 'auth' }; }
      if (res.status === 400 || res.status === 404) { var u = getState().unsupported || {}; u[key] = true; setState({ unsupported: u }); return { status: 'unsupported' }; }
      if (!res.ok) { noteErr('http-' + res.status, key); return { status: 'error' }; }
      var j; try { j = await res.json(); } catch (e) { noteErr('bad-json', key); return { status: 'error' }; }
      var u2 = getState().unsupported || {}; if (u2[key]) { delete u2[key]; setState({ unsupported: u2 }); }
      return { status: 'ok', rec: { value: j.value == null ? null : j.value, updatedAt: int(j.updatedAt) } };
    }
    async function putRecord(key, value, base, withBase) {
      var body = { value: value }; if (withBase) body.baseUpdatedAt = base;
      var res;
      try { res = await req('PUT', '/kv/' + key, body); } catch (e) { return { status: 'offline' }; }
      if (res.status === 401) { noteErr('auth', key); return { status: 'auth' }; }
      if (res.status === 409) { var j409 = null; try { j409 = await res.json(); } catch (e) {} return { status: 'conflict', current: j409 && j409.current ? { value: j409.current.value == null ? null : j409.current.value, updatedAt: int(j409.current.updatedAt) } : null }; }
      if (res.status === 400) { var u = getState().unsupported || {}; u[key] = true; setState({ unsupported: u }); return { status: 'unsupported' }; }
      if (res.status === 413 || res.status === 422) { var msg = ''; try { msg = (await res.json()).error || ''; } catch (e) {} noteErr('rejected', key); return { status: 'rejected', message: msg }; }
      if (!res.ok) { noteErr('http-' + res.status, key); return { status: 'error' }; }
      var j; try { j = await res.json(); } catch (e) { return { status: 'error' }; }
      return { status: 'ok', updatedAt: int(j.updatedAt) };
    }

    /* ── konflikter + sikkerhedskopi ── */
    function conflictOf(key) { return readJson('tp_sync_conflict_' + key); }
    E.conflicts = function () {
      return S.BLOB_KEYS.map(function (k) {
        var c = conflictOf(k); if (!c) return null;
        var lv = localValue(k);
        return { key: k, label: S.label(k), at: c.at, remoteUpdatedAt: c.remote.updatedAt, local: TP.summarize ? TP.summarize(k, lv.value) : null, remote: TP.summarize ? TP.summarize(k, c.remote.value) : null };
      }).filter(Boolean);
    };
    function backupLocal(key, reason) {
      var raw = sget(key); if (raw == null) return true;
      return sset('tp_sync_backup_' + key, JSON.stringify({ at: now(), reason: reason, raw: raw }));
    }
    E.backupInfo = function (key) { var b = readJson('tp_sync_backup_' + key); return b ? { at: b.at, reason: b.reason } : null; };
    E.backups = function () { return S.ALL_KEYS.map(function (k) { var b = E.backupInfo(k); return b ? { key: k, label: S.label(k), at: b.at, reason: b.reason } : null; }).filter(Boolean); };
    function applyBlob(key, rec) {
      var cur = localValue(key), val = clone(rec.value);
      if (key === 'sbd_state' && isObj(val) && cur.value && cur.value.profile) val.profile = cur.value.profile; // aldrig skift enhedens aktive profil
      var txt = JSON.stringify(val);
      if (!sset(key, txt)) return false;
      sset(key + '__updatedAt', String(rec.updatedAt));
      sset(key + '__sh', hashOf(key, val));
      return true;
    }
    function storeConflict(key, rec) {
      sset('tp_sync_conflict_' + key, JSON.stringify({ at: now(), remote: rec }));
      emit({ type: 'conflict', key: key });
    }

    /* ── pull (enkelt nøgle) ── */
    // Returnerer { status, changed, needsPush }
    function decideBlob(key, rec) {
      var lv = localValue(key), lts = baseTs(key), sh = syncedHash(key);
      if (rec.value == null) return { status: 'empty', needsPush: lv.raw != null };
      if (!isObj(rec.value)) return { status: 'invalid' };
      if (lv.raw == null || lv.corrupt) { if (lv.corrupt) backupLocal(key, 'beskadiget lokal kopi erstattet'); return applyBlob(key, rec) ? { status: 'updated', changed: true } : { status: 'error' }; }
      var remoteHash = hashOf(key, rec.value), localHash = hashOf(key, lv.value);
      if (remoteHash === localHash) { sset(key + '__updatedAt', String(rec.updatedAt)); sset(key + '__sh', localHash); return { status: 'unchanged' }; }
      if (rec.updatedAt <= lts && lts > 0) return { status: 'unchanged', needsPush: true }; // serveren er ikke nyere, men indholdet er forskelligt → lokale ændringer skal sendes
      // Serveren er nyere (eller denne enhed har aldrig synkroniseret) og indholdet er forskelligt:
      if (sh != null) {
        if (localHash !== sh) { storeConflict(key, rec); return { status: 'conflict' }; }       // lokale ændringer + nyere server
        return applyBlob(key, rec) ? { status: 'updated', changed: true } : { status: 'error' }; // ren lokal kopi → tag serverens
      }
      // sh == null: ældre klient uden synk-hash.
      if (lts === 0) { // denne enhed har aldrig synkroniseret
        if (isEmptyBlob(key, lv.value)) return applyBlob(key, rec) ? { status: 'updated', changed: true } : { status: 'error' };
        storeConflict(key, rec); return { status: 'conflict' }; // begge sider har data, ingen fælles historik → bed om valg
      }
      // Ældre synket enhed: vi kan ikke vide om der er usendte ændringer. Gem lokal kopi først; kan den ikke gemmes → konflikt.
      if (!backupLocal(key, 'erstattet af nyere version fra en anden enhed')) { storeConflict(key, rec); return { status: 'conflict' }; }
      pushNote(S.label(key) + ': opdateret fra en anden enhed (din tidligere version ligger i sikkerhedskopi)');
      return applyBlob(key, rec) ? { status: 'updated', changed: true, legacy: true } : { status: 'error' };
    }
    function applyMetaLocal(key, value) {
      var profile = META_PROFILE[key], lv = localValue(key);
      var m = TP.migrateMeta(lv.value);
      m.planChanges = value.planChanges; m.tombs = value.tombs; m.dismissed = value.dismissed; m.dismissTombs = value.dismissTombs;
      m.goalPriority = value.goalPriority; m.cal.blocked = value.cal.blocked; m.cal.catchup = value.cal.catchup;
      if (profile === 'main' && value.cal.anchor) m.cal.anchor = value.cal.anchor;
      if (!sset(key, JSON.stringify(m))) return false;
      // Spejl registrene til de eksisterende dash_*-nøgler (som kalenderen læser)
      var dk = TP.dashKeysFor(profile);
      var on = function (reg) { return Object.keys(reg).filter(function (d) { return reg[d] && reg[d].on; }).sort(); };
      sset(dk[0], JSON.stringify(on(value.cal.blocked)));
      sset(dk[1], JSON.stringify(on(value.cal.catchup)));
      if (profile === 'main' && value.cal.anchor && value.cal.anchor.v) sset(TP.DASH_ANCHOR_KEY, String(value.cal.anchor.v));
      return true;
    }
    // Gør registrene i meta lig de faktiske dash_*-lister (ændringer lavet uden om calNote, fx via gendannet backup)
    function reconcileCal(profile) {
      var key = TP.KEYS.meta[profile], dk = TP.dashKeysFor(profile), t = now();
      var lv = localValue(key), m = TP.migrateMeta(lv.value), changed = false;
      [['blocked', dk[0]], ['catchup', dk[1]]].forEach(function (pair) {
        var kind = pair[0], arr = readJson(pair[1]); if (!Array.isArray(arr)) arr = [];
        var reg = m.cal[kind], inArr = {}; arr.forEach(function (d) { if (typeof d === 'string') inArr[d] = 1; });
        Object.keys(inArr).forEach(function (d) { if (!reg[d] || !reg[d].on) { reg[d] = { on: true, t: reg[d] ? t : 0 }; if (reg[d].t) changed = true; else changed = true; } });
        Object.keys(reg).forEach(function (d) { if (reg[d].on && !inArr[d]) { reg[d] = { on: false, t: t }; changed = true; } });
      });
      if (profile === 'main') {
        var a = sget(TP.DASH_ANCHOR_KEY);
        if (a) {
          if (!m.cal.anchor) { m.cal.anchor = { v: a, t: 0 }; changed = true; }
          else if (m.cal.anchor.v !== a) { m.cal.anchor = { v: a, t: t }; changed = true; }
        }
      }
      if (changed) sset(key, JSON.stringify(m));
    }
    async function pullMeta(key, rec) {
      var profile = META_PROFILE[key];
      reconcileCal(profile);
      var before = metaProjection(key);
      if (rec.value == null) return { status: 'empty', needsPush: true };
      if (!isObj(rec.value) || rec.value.profile !== profile) { noteErr('profile-mismatch', key); return { status: 'invalid' }; }
      var res = S.mergeMeta(before, rec.value, profile, now());
      var changed = TP.canon(res.value) !== TP.canon(before);
      if (changed && !applyMetaLocal(key, res.value)) return { status: 'error' };
      res.notes.forEach(function (n) { pushNote(n); });
      sset(key + '__updatedAt', String(rec.updatedAt));
      var needsPush = TP.canon(res.value) !== TP.canon(normProj(rec.value, profile));
      if (!needsPush) sset(key + '__sh', TP.hash(TP.canon(res.value)));
      return { status: changed ? 'merged' : 'unchanged', changed: changed, needsPush: needsPush, merged: res.value };
    }

    E.pull = async function (key) {
      if (!E.enabled()) return { status: 'disabled', changed: false };
      if (conflictOf(key)) return { status: 'conflict', changed: false };
      var c = await getCaps();
      if (isMeta(key) && c.api && c.api < 2) { var u = getState().unsupported || {}; u[key] = true; setState({ unsupported: u }); return { status: 'unsupported', changed: false }; }
      var r = await fetchRecord(key);
      if (r.status !== 'ok') return { status: r.status, changed: false };
      noteOk();
      var d = isMeta(key) ? await pullMeta(key, r.rec) : decideBlob(key, r.rec);
      d.changed = !!d.changed; d.rec = r.rec;
      if (d.changed) emit({ type: 'changed', key: key });
      return d;
    };

    /* ── push (enkelt nøgle) ── */
    E.push = async function (key, _depth) {
      _depth = _depth || 0;
      if (!E.enabled()) return { status: 'disabled' };
      if (conflictOf(key)) return { status: 'conflict' };
      var c = await getCaps(); if (c.offline) return { status: 'offline' };
      if (isMeta(key)) {
        if (c.api < 2) return { status: 'unsupported' };
        reconcileCal(META_PROFILE[key]);
      }
      var value;
      if (isMeta(key)) value = metaProjection(key);
      else { var lv = localValue(key); if (lv.raw == null || lv.corrupt) return { status: 'nothing' }; value = lv.value; }
      var h = isMeta(key) ? TP.hash(TP.canon(value)) : hashOf(key, value);
      if (syncedHash(key) === h) return { status: 'clean' };
      var base = baseTs(key);
      if (!c.conditionalPut) { // gammel Worker: tjek serverens version først (beskytter mod de fleste tavse overskrivninger; ikke race-fri)
        var pre = await fetchRecord(key); if (pre.status !== 'ok') return { status: pre.status };
        if (pre.rec.updatedAt > base && pre.rec.value != null) return await handleServerNewer(key, pre.rec, _depth);
      }
      var res = await putRecord(key, value, base, c.conditionalPut);
      if (res.status === 'ok') { sset(key + '__updatedAt', String(res.updatedAt)); sset(key + '__sh', h); noteOk(); emit({ type: 'pushed', key: key }); return { status: 'ok' }; }
      if (res.status === 'conflict' && res.current) return await handleServerNewer(key, res.current, _depth);
      return { status: res.status, message: res.message };
    };
    async function handleServerNewer(key, rec, depth) {
      if (isMeta(key)) { // tabsfri sammenfletning, derefter ny betinget skrivning
        if (depth >= 3) return { status: 'busy' };
        var d = await pullMeta(key, rec);
        if (d.changed) emit({ type: 'changed', key: key });
        if (d.status === 'invalid' || d.status === 'error') return d;
        return await E.push(key, depth + 1);
      }
      var dd = decideBlob(key, rec);
      if (dd.changed) emit({ type: 'changed', key: key });
      if (dd.status === 'unchanged' && dd.needsPush) return await E.push(key, depth + 1);
      return dd;
    }

    /* ── samlet synkronisering ── */
    function serial(key, fn) { // én operation ad gangen pr. nøgle
      var prev = locks[key] || Promise.resolve();
      var next = prev.then(fn, fn); locks[key] = next.catch(function () {}); return next;
    }
    E.syncKey = function (key) {
      return serial(key, async function () {
        var p = await E.pull(key);
        if (p.status === 'disabled' || p.status === 'offline' || p.status === 'auth' || p.status === 'unsupported' || p.status === 'conflict' || p.status === 'error' || p.status === 'invalid') return p;
        var dirty = p.needsPush || E.isDirty(key);
        if (dirty) { var q = await E.push(key); q.changed = p.changed; return q; }
        return p;
      });
    };
    E.syncAll = async function (keys) {
      var out = {}; var list = keys || S.ALL_KEYS;
      for (var i = 0; i < list.length; i++) out[list[i]] = await E.syncKey(list[i]);
      emit({ type: 'synced' });
      return out;
    };
    E.schedulePush = function (key, delay) {
      if (!E.enabled()) return;
      clearTimeout(timers[key]);
      timers[key] = setTimeout(function () { E.syncKey(key).catch(function () {}); }, delay == null ? 1500 : delay);
    };

    /* ── konfliktløsning ── */
    E.resolve = function (key, choice) {
      return serial(key, async function () {
        var c = conflictOf(key); if (!c) return { ok: false, error: 'Ingen konflikt for denne nøgle.' };
        if (choice === 'remote') {
          if (!backupLocal(key, 'valgte den anden enhed ved konflikt')) return { ok: false, error: 'Kunne ikke lægge din nuværende version i sikkerhedskopi (lager fuldt?). Intet er ændret.' };
          if (!applyBlob(key, c.remote)) return { ok: false, error: 'Kunne ikke skrive den hentede version. Intet er ændret.' };
          sdel('tp_sync_conflict_' + key); emit({ type: 'changed', key: key }); emit({ type: 'resolved', key: key });
          return { ok: true, changed: true };
        }
        if (choice === 'local') {
          // Behold denne enhed: serverens version lægges i sikkerhedskopi, og vi skriver betinget oven på DEN version vi så.
          sset('tp_sync_backup_' + key, JSON.stringify({ at: now(), reason: 'serverversion fravalgt ved konflikt', raw: JSON.stringify(c.remote.value) }));
          sset(key + '__updatedAt', String(c.remote.updatedAt));
          sdel('tp_sync_conflict_' + key);
          var q = await E.push(key);
          if (q.status === 'ok' || q.status === 'clean') { emit({ type: 'resolved', key: key }); return { ok: true, changed: false }; }
          if (q.status === 'conflict') return { ok: true, again: true };
          return { ok: true, pending: true, status: q.status }; // fx offline: bliver sendt senere (stadig "ændret siden synk")
        }
        return { ok: false, error: 'Ukendt valg.' };
      });
    };
    E.bothVersions = function (key) {
      var c = conflictOf(key); if (!c) return null;
      var lv = localValue(key);
      return { exportedAt: new Date(now()).toISOString(), key: key, note: 'Begge versioner ved synk-konflikt. Indeholder ingen adgangskode.', thisDevice: lv.value, otherDevice: c.remote.value, otherDeviceVersion: c.remote.updatedAt };
    };
    // Fortryd en overskrivning (fra anden enhed / valgt konflikt) ved at genskabe sikkerhedskopien — bliver ny "lokal ændring"
    E.restoreBackup = function (key) {
      var b = readJson('tp_sync_backup_' + key); if (!b || typeof b.raw !== 'string') return { ok: false, error: 'Ingen sikkerhedskopi.' };
      var cur = sget(key);
      if (cur != null && !sset('tp_sync_backup_' + key, JSON.stringify({ at: now(), reason: 'erstattet ved fortryd', raw: cur }))) return { ok: false, error: 'Kunne ikke bytte om på sikkerhedskopien.' };
      if (!sset(key, b.raw)) return { ok: false, error: 'Kunne ikke skrive.' };
      emit({ type: 'changed', key: key });
      return { ok: true };
    };

    /* ── status til UI ── */
    E.status = function () {
      var s = getState(), notes = readJson('tp_sync_notes');
      return {
        enabled: E.enabled(), lastOk: s.lastOk || 0, lastErr: s.lastErr || null, auth: !!s.auth, api: s.api || 0,
        unsupported: Object.keys(s.unsupported || {}), pending: E.pending(), conflicts: E.conflicts(), backups: E.backups(), notes: Array.isArray(notes) ? notes : [],
        online: typeof navigator === 'undefined' || navigator.onLine !== false
      };
    };
    E.clearNotes = function () { sdel('tp_sync_notes'); };
    return E;
  };

  /* ═══════════ Browser-del: opstart, konfliktbanner, statuspanel ═══════════ */
  function esc(x) { return String(x == null ? '' : x).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function sumText(sm) {
    if (!sm) return 'ingen data';
    var p = [];
    if (sm.sessions != null) p.push(sm.sessions + ' styrketræninger');
    if (sm.runs != null) p.push(sm.runs + ' løb');
    if (sm.last) p.push('seneste ' + sm.last);
    return p.length ? p.join(', ') : 'tom';
  }
  function fmtTime(ts) { try { return new Date(ts).toLocaleString('da-DK', { dateStyle: 'short', timeStyle: 'short' }); } catch (e) { return String(ts); } }
  S.statusHtml = function (engine) {
    var e = engine || S.engine; if (!e) return '';
    var st = e.status(), h = '';
    if (!st.enabled) return '<div class="tp-note">Synkronisering er ikke sat op (ingen Worker-adresse i appen) — data gemmes kun på denne enhed.</div>';
    if (st.auth) h += '<div class="tp-box err" role="alert">Worker\'en afviste adgangskoden (401). Tjek koden under Opsætning i løb-appen — data synkroniseres ikke før den er rigtig.</div>';
    if (st.unsupported.some(function (k) { return isMeta(k); }) && !st.auth) h += '<div class="tp-box warn">Din Worker er endnu ikke opdateret til v2. Styrke- og løbedata synkroniseres som før, men planlægningsdata (kalenderændringer, afviste forslag, fokus, "ikke mulig"-dage) deles <strong>ikke</strong> mellem enheder, før Worker\'en er deployet igen (se sync-worker/DEPLOY.md).</div>';
    if (!st.online) h += '<div class="tp-note">Offline — ændringer gemmes her og sendes, når du er online igen.</div>';
    h += '<div class="tp-note">' + (st.lastOk ? 'Sidst synkroniseret: ' + esc(fmtTime(st.lastOk)) + '.' : 'Endnu ikke synkroniseret fra denne enhed.') +
      (st.pending.length ? ' Venter på at blive sendt: ' + st.pending.map(function (k) { return esc(S.label(k)); }).join(', ') + '.' : ' Alt er sendt.') + '</div>';
    if (st.lastErr && !st.auth) h += '<div class="tp-note">Seneste problem: ' + esc(fmtTime(st.lastErr.at)) + ' (' + esc(st.lastErr.kind) + (st.lastErr.key ? ', ' + esc(S.label(st.lastErr.key)) : '') + ').</div>';
    st.notes.slice().reverse().slice(0, 4).forEach(function (n) { h += '<div class="tp-note">• ' + esc(n.text) + ' <span style="opacity:.7">(' + esc(fmtTime(n.at)) + ')</span></div>'; });
    if (st.backups.length) {
      h += '<div class="tp-note"><strong>Sikkerhedskopier fra synkronisering</strong> — hvis noget blev erstattet, kan du genskabe det:</div>';
      st.backups.forEach(function (b) { h += '<div class="tp-row"><span class="tp-note" style="flex:1 1 200px;align-self:center">' + esc(b.label) + ' · ' + esc(fmtTime(b.at)) + ' · ' + esc(b.reason) + '</span><button type="button" class="tp-btn" data-act="sync-restore" data-key="' + esc(b.key) + '">Genskab denne version</button></div>'; });
    }
    return h;
  };

  if (typeof document !== 'undefined' && typeof window !== 'undefined') {
    var STYLE_ID = 'tp-sync-style';
    var ensureStyle = function () {
      if (document.getElementById(STYLE_ID)) return;
      var st = document.createElement('style'); st.id = STYLE_ID;
      st.textContent = [
        '#tp-sync-banner{margin:0;padding:12px 16px;background:var(--surface2,#22262f);border-bottom:2px solid var(--gold,#d4a843);color:var(--text,#f0ece4);font-size:14px;line-height:1.45}',
        '#tp-sync-banner .tpsb-in{max-width:860px;margin:0 auto;display:flex;flex-direction:column;gap:8px}',
        '#tp-sync-banner h2{margin:0;font-size:16px;font-family:var(--font-disp,inherit);letter-spacing:.03em}',
        '#tp-sync-banner ul{margin:0;padding-left:18px;color:var(--text-2,#c6cad3)}',
        '#tp-sync-banner .tpsb-row{display:flex;flex-wrap:wrap;gap:8px}',
        '#tp-sync-banner button{min-height:44px;padding:10px 14px;border-radius:10px;border:1px solid var(--border-strong,#3c4254);background:var(--surface3,#2a2f3a);color:var(--text,#f0ece4);font:inherit;font-weight:600;cursor:pointer;flex:1 1 150px}',
        '#tp-sync-banner button.primary{background:var(--gold,#d4a843);border-color:var(--gold,#d4a843);color:#181a1f}',
        '#tp-sync-banner button:focus-visible{outline:3px solid var(--gold,#d4a843);outline-offset:2px}',
        '#tp-sync-banner .err{color:var(--danger,#ee7566)}'
      ].join('\n');
      document.head.appendChild(st);
    };
    S.renderBanner = function () {
      var e = S.engine; if (!e) return;
      var cs = e.conflicts(), el = document.getElementById('tp-sync-banner');
      if (!cs.length) { if (el && el.parentNode) el.parentNode.removeChild(el); return; }
      ensureStyle();
      var isNew = !el;
      if (!el) { el = document.createElement('div'); el.id = 'tp-sync-banner'; el.setAttribute('role', 'alert'); document.body.insertBefore(el, document.body.firstChild); }
      var c = cs[0];
      el.innerHTML = '<div class="tpsb-in"><h2>Synkroniseringskonflikt: ' + esc(c.label) + '</h2>' +
        '<div>Dette er ændret både her og på en anden enhed. <strong>Intet er overskrevet endnu</strong> — vælg hvilken version der skal bruges. Den du fravælger lægges i en sikkerhedskopi.</div>' +
        '<ul><li>Denne enhed: ' + esc(sumText(c.local)) + '</li><li>Den anden enhed (' + esc(fmtTime(c.remoteUpdatedAt)) + '): ' + esc(sumText(c.remote)) + '</li></ul>' +
        '<div class="tpsb-row"><button type="button" class="primary" data-act="local" data-key="' + esc(c.key) + '">Behold denne enhed</button>' +
        '<button type="button" data-act="remote" data-key="' + esc(c.key) + '">Brug den anden enhed</button>' +
        '<button type="button" data-act="both" data-key="' + esc(c.key) + '">Hent begge som fil</button></div>' +
        '<div class="err" data-role="msg" aria-live="polite"></div>' +
        (cs.length > 1 ? '<div>Der er ' + (cs.length - 1) + ' konflikt(er) mere efter denne.</div>' : '') + '</div>';
      if (isNew) { /* role=alert oplæses ved oprettelse */ }
      el.onclick = function (ev) {
        var b = ev.target.closest ? ev.target.closest('button[data-act]') : null; if (!b) return;
        var act = b.getAttribute('data-act'), key = b.getAttribute('data-key'), msg = el.querySelector('[data-role=msg]');
        if (act === 'both') {
          var both = e.bothVersions(key); if (!both) return;
          var blob = new Blob([JSON.stringify(both, null, 2)], { type: 'application/json' }), url = URL.createObjectURL(blob), a = document.createElement('a');
          a.href = url; a.download = 'synk-konflikt-' + key + '-' + new Date().toISOString().slice(0, 10) + '.json'; document.body.appendChild(a); a.click(); document.body.removeChild(a);
          setTimeout(function () { URL.revokeObjectURL(url); }, 1000); return;
        }
        b.disabled = true;
        e.resolve(key, act).then(function (r) {
          if (!r.ok) { if (msg) msg.textContent = r.error || 'Kunne ikke løse konflikten.'; b.disabled = false; return; }
          if (act === 'remote') { try { location.reload(); } catch (x) {} return; } // frisk start så sidens gamle hukommelsestilstand ikke skrives tilbage
          S.renderBanner();
        });
      };
      // Fokus flyttes bevidst ikke (kunne afbryde indtastning midt i et pas); role="alert" sørger for at skærmlæsere får besked.
    };
    S.boot = function (baseUrl) {
      if (S.engine) return S.engine;
      var e = S.create({ baseUrl: baseUrl }); S.engine = e;
      if (TP) TP.onMetaSaved = function (key) { e.schedulePush(key); };
      var lastAll = 0;
      var all = function () { if (Date.now() - lastAll < 15000) return; lastAll = Date.now(); e.syncAll().catch(function () {}); };
      try { window.addEventListener('online', function () { lastAll = 0; all(); }); } catch (x) {}
      try { document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') all(); }); } catch (x) {}
      e.on(function (ev) { if (ev.type === 'conflict' || ev.type === 'resolved' || ev.type === 'synced') S.renderBanner(); });
      var mount = function () { S.renderBanner(); };
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
      return e;
    };
  }

  return S;
});
