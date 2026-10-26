// Integrationstests for tp-sync.js (V3.1) mod Worker-KILDEKODEN (v2 og v1-fixture) i Node. Syntetiske data, intet netværk.
// Niveau: unit + integration. Dette er IKKE en test mod en deployet Worker og ikke mod Cloudflares runtime.
const assert = require('assert'), path = require('path');
const { world, mem, J, sbdState, lobState, TP, TPSYNC } = require('./helpers/world');
const V1 = path.join(__dirname, 'fixtures', 'worker-v1.js');
let ok = 0, bad = 0;
const T = async (n, f) => { try { await f(); ok++; console.log('  ok   ' + n); } catch (e) { bad++; console.log('  FEJL ' + n + '\n       ' + (e.stack || e).toString().split('\n').slice(0, 4).join('\n       ')); } };
const tick = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log('Blob-synk (SBD/løb)');
  await T('A skriver → B (tom) henter; derefter er begge rene (ingen dirty)', async () => {
    const W = world(); const A = W.device('A', { sbd_state: J(sbdState(3)) }), B = W.device('B');
    const r1 = await A.engine.syncKey('sbd_state'); assert.strictEqual(r1.status, 'ok');
    const r2 = await B.engine.syncKey('sbd_state'); assert.strictEqual(r2.status, 'updated');
    assert.deepStrictEqual(JSON.parse(B.storage._m.sbd_state).completedDays, [1, 2, 3]);
    assert(!A.engine.isDirty('sbd_state') && !B.engine.isDirty('sbd_state'));
    assert.strictEqual((await B.engine.syncKey('sbd_state')).status, 'unchanged');
  });
  await T('ren enhed tager serverens nyere version uden konflikt', async () => {
    const W = world(); const A = W.device('A', { sbd_state: J(sbdState(1)) }), B = W.device('B');
    await A.engine.syncKey('sbd_state'); await B.engine.syncKey('sbd_state');
    A.storage.setItem('sbd_state', J(sbdState(2))); await A.engine.syncKey('sbd_state');
    const r = await B.engine.syncKey('sbd_state'); assert.strictEqual(r.status, 'updated');
    assert.strictEqual(JSON.parse(B.storage._m.sbd_state).completedDays.length, 2); assert.strictEqual(B.engine.conflicts().length, 0);
  });
  await T('OFFLINE-ÆNDRING mens anden enhed skriver → konflikt, intet overskrevet (v2-Worker)', async () => {
    const W = world(); const A = W.device('A', { sbd_state: J(sbdState(1)) }), B = W.device('B');
    await A.engine.syncKey('sbd_state'); await B.engine.syncKey('sbd_state');
    A.offline = true; A.storage.setItem('sbd_state', J(sbdState(2, { note: 'fra A offline' })));
    assert.strictEqual((await A.engine.syncKey('sbd_state')).status, 'offline'); assert(A.engine.isDirty('sbd_state'));
    B.storage.setItem('sbd_state', J(sbdState(5, { note: 'fra B' }))); await B.engine.syncKey('sbd_state');
    A.offline = false;
    const r = await A.engine.syncKey('sbd_state'); assert.strictEqual(r.status, 'conflict');
    assert.strictEqual(JSON.parse(A.storage._m.sbd_state).note, 'fra A offline', 'lokale data uberørt');
    assert.strictEqual(A.engine.conflicts().length, 1);
    assert.strictEqual(W.record('sbd_state').value.note, 'fra B', 'server uberørt af A');
    // push forsøges ikke mens konflikten er åben
    const before = W.calls.length; await A.engine.syncKey('sbd_state'); assert(!W.calls.slice(before).some(c => c.method === 'PUT'));
  });
  await T('konflikt → "behold denne enhed": serveren får A, B får A og har sikkerhedskopi', async () => {
    const W = world(); const A = W.device('A', { sbd_state: J(sbdState(1)) }), B = W.device('B');
    await A.engine.syncKey('sbd_state'); await B.engine.syncKey('sbd_state');
    A.offline = true; A.storage.setItem('sbd_state', J(sbdState(2, { note: 'A' }))); await A.engine.syncKey('sbd_state');
    B.storage.setItem('sbd_state', J(sbdState(5, { note: 'B' }))); await B.engine.syncKey('sbd_state'); A.offline = false;
    await A.engine.syncKey('sbd_state');
    const r = await A.engine.resolve('sbd_state', 'local'); assert(r.ok);
    assert.strictEqual(W.record('sbd_state').value.note, 'A'); assert.strictEqual(A.engine.conflicts().length, 0);
    assert(A.engine.backupInfo('sbd_state'), 'serverversionen (B) ligger i sikkerhedskopi');
    const rb = await B.engine.syncKey('sbd_state'); assert.strictEqual(rb.status, 'updated');
    assert.strictEqual(JSON.parse(B.storage._m.sbd_state).note, 'A');
  });
  await T('konflikt → "brug den anden enhed": lokal version i sikkerhedskopi, serverens skrevet', async () => {
    const W = world(); const A = W.device('A', { sbd_state: J(sbdState(1)) }), B = W.device('B');
    await A.engine.syncKey('sbd_state'); await B.engine.syncKey('sbd_state');
    A.offline = true; A.storage.setItem('sbd_state', J(sbdState(2, { note: 'A' }))); await A.engine.syncKey('sbd_state');
    B.storage.setItem('sbd_state', J(sbdState(5, { note: 'B' }))); await B.engine.syncKey('sbd_state'); A.offline = false;
    await A.engine.syncKey('sbd_state');
    const r = await A.engine.resolve('sbd_state', 'remote'); assert(r.ok && r.changed);
    assert.strictEqual(JSON.parse(A.storage._m.sbd_state).note, 'B');
    assert.strictEqual(JSON.parse(JSON.parse(A.storage._m['tp_sync_backup_sbd_state']).raw).note, 'A', 'A\'s version kan hentes igen');
    assert(!A.engine.isDirty('sbd_state'));
    const rr = A.engine.restoreBackup('sbd_state'); assert(rr.ok); assert.strictEqual(JSON.parse(A.storage._m.sbd_state).note, 'A');
  });
  await T('begge ændrer samtidig: den sidste skriver får 409 → konflikt (v2) — ingen tavs overskrivning', async () => {
    const W = world(); const A = W.device('A', { lob_state: J(lobState(1)) }), B = W.device('B');
    await A.engine.syncKey('lob_state'); await B.engine.syncKey('lob_state');
    A.storage.setItem('lob_state', J(lobState(2))); B.storage.setItem('lob_state', J(lobState(3)));
    // A skriver først; B's push bruger forældet base
    assert.strictEqual((await A.engine.push('lob_state')).status, 'ok');
    const r = await B.engine.push('lob_state'); assert.strictEqual(r.status, 'conflict');
    assert.strictEqual(W.record('lob_state').value.runs.length, 2, 'A\'s version står stadig');
    assert.strictEqual(B.engine.conflicts().length, 1);
  });
  await T('samme scenarie mod GAMMEL v1-Worker: tjek-før-skriv fanger det (ikke race-fri)', async () => {
    const W = world({ workerFile: V1 }); const A = W.device('A', { lob_state: J(lobState(1)) }), B = W.device('B');
    await A.engine.syncKey('lob_state'); await B.engine.syncKey('lob_state');
    A.storage.setItem('lob_state', J(lobState(2))); B.storage.setItem('lob_state', J(lobState(3)));
    await tick(5); // v1-Worker bruger Date.now() uden monotoni; i virkeligheden er der altid ms mellem to enheders skrivninger
    await A.engine.push('lob_state'); await tick(3);
    const r = await B.engine.push('lob_state'); assert.strictEqual(r.status, 'conflict');
    assert.strictEqual(W.record('lob_state').value.runs.length, 2);
  });
  await T('PRODUKTIONS-binding (env.KV, nøgler "kv:<nøgle>"): eksisterende data læses, nye skrives i samme format', async () => {
    const W = world({ legacyBinding: true }); W.kv.m['kv:lob_state'] = J({ value: lobState(3), updatedAt: 1700000000000 });
    const A = W.device('A'); const r = await A.engine.syncKey('lob_state'); assert.strictEqual(r.status, 'updated'); assert.strictEqual(JSON.parse(A.storage._m.lob_state).runs.length, 3);
    A.storage.setItem('lob_state', J(lobState(4))); assert.strictEqual((await A.engine.syncKey('lob_state')).status, 'ok');
    assert.strictEqual(W.record('lob_state').value.runs.length, 4); assert(!('lob_state' in W.kv.m), 'ingen nøgler uden kv:-præfiks');
  });
  await T('v1-Worker: blob-synk virker uændret; V3-metadata markeres "ikke understøttet" uden fejl', async () => {
    const W = world({ workerFile: V1 }); const A = W.device('A', { sbd_state: J(sbdState(2)), tp_meta_main: J(TP.defaultMeta()) }), B = W.device('B');
    const all = await A.engine.syncAll(); assert.strictEqual(all.sbd_state.status, 'ok'); assert.strictEqual(all.tp_meta_main.status, 'unsupported');
    await B.engine.syncKey('sbd_state'); assert.strictEqual(JSON.parse(B.storage._m.sbd_state).completedDays.length, 2);
    assert.strictEqual(A.engine.status().api, 1, 'klienten har registreret at Worker\'en er v1');
  });
  await T('eksisterende v1-data i KV læses af ny klient (bagudkompatibelt)', async () => {
    const W = world(); W.kv.m.sbd_state = J({ value: sbdState(4), updatedAt: 1700000000000 });
    const B = W.device('B'); const r = await B.engine.syncKey('sbd_state'); assert.strictEqual(r.status, 'updated');
    assert.strictEqual(B.storage._m.sbd_state__updatedAt, '1700000000000');
  });
  await T('ÆLDRE klient (ingen synk-hash) med usendte ændringer og server ikke nyere → sendes', async () => {
    const W = world(); const A = W.device('A', { sbd_state: J(sbdState(1)) }); await A.engine.syncKey('sbd_state');
    const ts = A.storage._m.sbd_state__updatedAt; delete A.storage._m.sbd_state__sh; // simulér klient fra før V3.1
    A.storage.setItem('sbd_state', J(sbdState(2)));
    const r = await A.engine.syncKey('sbd_state'); assert.strictEqual(r.status, 'ok'); assert.strictEqual(W.record('sbd_state').value.completedDays.length, 2);
    assert(ts);
  });
  await T('ÆLDRE klient (ingen synk-hash) og serveren er nyere → lokal version sikkerhedskopieres, serverens tages, besked noteres', async () => {
    const W = world(); const A = W.device('A', { sbd_state: J(sbdState(1)) }), B = W.device('B');
    await A.engine.syncKey('sbd_state'); await B.engine.syncKey('sbd_state'); delete A.storage._m.sbd_state__sh;
    B.storage.setItem('sbd_state', J(sbdState(4))); await B.engine.syncKey('sbd_state');
    const r = await A.engine.syncKey('sbd_state'); assert.strictEqual(r.status, 'updated');
    assert.strictEqual(JSON.parse(JSON.parse(A.storage._m.tp_sync_backup_sbd_state).raw).completedDays.length, 1);
    assert(A.engine.status().notes.some(n => /sikkerhedskopi/.test(n.text)));
  });
  await T('enhed der aldrig har synket + data på begge sider → konflikt; tom enhed → henter uden konflikt', async () => {
    const W = world(); const A = W.device('A', { lob_state: J(lobState(2)) }); await A.engine.syncKey('lob_state');
    const C = W.device('C', { lob_state: J(lobState(1)) }); assert.strictEqual((await C.engine.syncKey('lob_state')).status, 'conflict');
    const D = W.device('D', { lob_state: J(lobState(0)) }); assert.strictEqual((await D.engine.syncKey('lob_state')).status, 'updated');
  });
  await T('identisk indhold (anden nøglerækkefølge) giver ingen konflikt', async () => {
    const W = world(); const A = W.device('A', { sbd_state: J(sbdState(2)) }), B = W.device('B', { sbd_state: J({ profile: 'main', oneRM: { dl: 150, bp: 80, sq: 100 }, completedDays: [1, 2], logs: {}, totalDays: 2 }) });
    await A.engine.syncKey('sbd_state'); const r = await B.engine.syncKey('sbd_state'); assert.strictEqual(r.status, 'unchanged'); assert.strictEqual(B.engine.conflicts().length, 0);
  });
  await T('PROFILISOLERING: sbd_state.profile (aktiv profil) overskrives aldrig af pull; sbd_partner/lob_partner rører ikke main', async () => {
    const W = world(); const A = W.device('A', { sbd_state: J(sbdState(2, { profile: 'main' })), sbd_partner: J(sbdState(1)), lob_state: J(lobState(1)), lob_partner: J(lobState(2)) });
    const B = W.device('B', { sbd_state: J(sbdState(1, { profile: 'partner' })) });
    await A.engine.syncAll(S4()); await B.engine.syncKey('sbd_state'); // B har 1 dag og er "aldrig synket" → konflikt; løs med remote
    await B.engine.resolve('sbd_state', 'remote');
    assert.strictEqual(JSON.parse(B.storage._m.sbd_state).profile, 'partner', 'B\'s aktive profil bevaret');
    await B.engine.syncKey('lob_partner'); assert(!('lob_state' in B.storage._m)); assert.strictEqual(JSON.parse(B.storage._m.lob_partner).runs.length, 2);
    function S4() { return ['sbd_state', 'sbd_partner', 'lob_state', 'lob_partner']; }
  });
  await T('skift af aktiv profil alene giver hverken dirty eller push', async () => {
    const W = world(); const A = W.device('A', { sbd_state: J(sbdState(2, { profile: 'main' })) }); await A.engine.syncKey('sbd_state');
    const s = JSON.parse(A.storage._m.sbd_state); s.profile = 'partner'; A.storage.setItem('sbd_state', J(s));
    assert(!A.engine.isDirty('sbd_state')); const n = W.calls.length; await A.engine.syncKey('sbd_state'); assert(!W.calls.slice(n).some(c => c.method === 'PUT'));
  });
  await T('ugyldig serverdata (ikke et objekt) / beskadiget lokal kopi håndteres uden datatab', async () => {
    const W = world(); W.kv.m.lob_state = J({ value: 'tekst', updatedAt: 5 }); const A = W.device('A', { lob_state: J(lobState(2)) });
    const r = await A.engine.syncKey('lob_state'); assert.strictEqual(r.status, 'invalid'); assert.strictEqual(JSON.parse(A.storage._m.lob_state).runs.length, 2);
    W.kv.m.lob_state = J({ value: lobState(3), updatedAt: 9 }); A.storage._m.lob_state = '{ikke json';
    const r2 = await A.engine.syncKey('lob_state'); assert.strictEqual(r2.status, 'updated'); assert(JSON.parse(A.storage._m.tp_sync_backup_lob_state).raw.includes('ikke json'));
  });
  await T('fuldt lager under pull → status error, lokale data intakte', async () => {
    const W = world(); const A = W.device('A', { sbd_state: J(sbdState(1)) }), B = W.device('B');
    await A.engine.syncKey('sbd_state'); await B.engine.syncKey('sbd_state'); A.storage.setItem('sbd_state', J(sbdState(3))); await A.engine.syncKey('sbd_state');
    B.storage.failWrites = true; const before = B.storage._m.sbd_state;
    const r = await B.engine.syncKey('sbd_state'); assert.strictEqual(r.status, 'error'); assert.strictEqual(B.storage._m.sbd_state, before);
  });
  await T('server-validering: forkert form afvises (422), uden at ødelægge den gode kopi', async () => {
    const W = world(); const A = W.device('A', { lob_state: J(lobState(2)) }); await A.engine.syncKey('lob_state');
    A.storage.setItem('lob_state', J({ profile: {}, runs: 'x' })); const r = await A.engine.push('lob_state'); assert.strictEqual(r.status, 'rejected');
    assert.strictEqual(W.record('lob_state').value.runs.length, 2);
  });

  console.log('Adgangskode, status, offline');
  await T('SBD-sti: Authorization sendes; forkert/ingen kode → auth, data uændret, ingen konflikt', async () => {
    const W = world({ token: 'TEST-TOKEN-123' }); const A = W.device('A', { sbd_state: J(sbdState(1)) });
    assert.strictEqual((await A.engine.syncKey('sbd_state')).status, 'ok'); assert(W.calls.every(c => c.hasAuth));
    const B = W.device('B'); B.token = 'forkert'; const r = await B.engine.syncKey('sbd_state'); assert.strictEqual(r.status, 'auth'); assert(B.engine.status().auth);
    B.token = ''; assert.strictEqual((await B.engine.syncKey('sbd_state')).status, 'auth'); assert(!('sbd_state' in B.storage._m));
  });
  await T('adgangskoden findes ikke i status, noter, konflikter, backup eller serverdata', async () => {
    const W = world({ token: 'TEST-TOKEN-123' }); const A = W.device('A', { sbd_state: J(sbdState(1)), sync_token: 'TEST-TOKEN-123' });
    await A.engine.syncAll(); const b = TP.buildBackup('all', A.storage);
    const hay = J(A.engine.status()) + J(b) + J(W.kv.m) + J(Object.keys(A.storage._m).filter(k => k !== 'sync_token').map(k => A.storage._m[k]));
    assert(!hay.includes('TEST-TOKEN-123'));
  });
  await T('offline: ingen fejl, lokale ændringer bevares som "ventende", sendes når online', async () => {
    const W = world(); const A = W.device('A', { lob_state: J(lobState(1)) }); await A.engine.syncKey('lob_state');
    A.offline = true; A.storage.setItem('lob_state', J(lobState(2)));
    assert.strictEqual((await A.engine.syncKey('lob_state')).status, 'offline'); assert(A.engine.status().pending.includes('lob_state'));
    A.offline = false; assert.strictEqual((await A.engine.syncKey('lob_state')).status, 'ok'); assert(!A.engine.status().pending.includes('lob_state'));
    assert.strictEqual(W.record('lob_state').value.runs.length, 2);
  });
  await T('Worker-URL ikke sat → deaktiveret, rører intet', async () => {
    const st = mem({ sbd_state: J(sbdState(1)) }); const e = TPSYNC.create({ storage: st, fetch: async () => { throw new Error('skulle ikke kaldes'); }, baseUrl: 'https://REPLACE-ME.workers.dev' });
    assert.strictEqual((await e.syncKey('sbd_state')).status, 'disabled');
  });

  console.log('Gendannelse af backup + synk');
  await T('gendannet ÆLDRE backup erstatter serveren (server uændret siden sidst) — og kan fortrydes lokalt', async () => {
    const W = world(); const A = W.device('A', { sbd_state: J(sbdState(5)) }); await A.engine.syncKey('sbd_state');
    const old = TP.buildBackup('all', mem({ sbd_state: J(sbdState(2)) }));
    const plan = TP.planRestore(TP.parseBackup(J(old)), A.storage); assert(plan.ok); assert(TP.applyRestore(plan, A.storage).ok);
    assert(A.engine.isDirty('sbd_state')); const r = await A.engine.syncKey('sbd_state'); assert.strictEqual(r.status, 'ok');
    assert.strictEqual(W.record('sbd_state').value.completedDays.length, 2);
    assert(TP.undoRestore(A.storage).ok); assert.strictEqual(JSON.parse(A.storage._m.sbd_state).completedDays.length, 5);
  });
  await T('gendannet backup mens serveren er ændret fra en anden enhed → KONFLIKT i stedet for tavs overskrivning', async () => {
    const W = world(); const A = W.device('A', { sbd_state: J(sbdState(5)) }), B = W.device('B');
    await A.engine.syncKey('sbd_state'); await B.engine.syncKey('sbd_state');
    B.storage.setItem('sbd_state', J(sbdState(7))); await B.engine.syncKey('sbd_state');
    const old = TP.buildBackup('all', mem({ sbd_state: J(sbdState(2)) })); TP.applyRestore(TP.planRestore(TP.parseBackup(J(old)), A.storage), A.storage);
    const r = await A.engine.syncKey('sbd_state'); assert.strictEqual(r.status, 'conflict'); assert.strictEqual(W.record('sbd_state').value.completedDays.length, 7);
  });

  console.log('Metadata (V3-brugerdata)');
  const M = (o) => Object.assign(TP.defaultMeta(), o || {});
  const chg = (id, at, extra) => Object.assign({ id, at, type: 'skipRun', date: '2026-11-0' + ((at % 9) + 1) }, extra || {});
  await T('projektion: kun brugerdata — reports og lastRestore synkroniseres ikke', async () => {
    const m = M({ reports: { '2026-09': { x: 1 } }, lastRestore: { at: 1 }, planChanges: [chg('c1', 1)] });
    const p = TPSYNC.projectMeta(m, 'main'); assert(!('reports' in p) && !('lastRestore' in p)); assert.strictEqual(p.planChanges.length, 1); assert.strictEqual(p.profile, 'main');
  });
  await T('merge: union af planændringer fra begge enheder, kommutativ og idempotent', async () => {
    const a = TPSYNC.projectMeta(M({ planChanges: [chg('c1', 1), chg('c2', 2)] }), 'main'), b = TPSYNC.projectMeta(M({ planChanges: [chg('c2', 2), chg('c3', 3)] }), 'main');
    const ab = TPSYNC.mergeMeta(a, b, 'main', 5e12).value, ba = TPSYNC.mergeMeta(b, a, 'main', 5e12).value;
    assert.deepStrictEqual(ab.planChanges.map(c => c.id), ['c1', 'c2', 'c3']); assert.strictEqual(TP.canon(ab), TP.canon(ba));
    assert.strictEqual(TP.canon(TPSYNC.mergeMeta(ab, ab, 'main', 5e12).value), TP.canon(ab));
  });
  await T('merge: fortrudt ændring (tombstone) kommer ikke tilbage fra den anden enhed', async () => {
    const a = M({ planChanges: [chg('c1', 1)] }); const b = JSON.parse(J(a)); TP.tombstone(b, 'c1', 10); b.planChanges = [];
    const r = TPSYNC.mergeMeta(TPSYNC.projectMeta(a, 'main'), TPSYNC.projectMeta(b, 'main'), 'main', 20).value; assert.strictEqual(r.planChanges.length, 0);
  });
  await T('merge: afviste forslag og "Vis igen" — seneste handling vinder pr. forslag', async () => {
    const a = M({ dismissed: { k1: { at: 5, action: 'ignored' }, k2: { at: 5, action: 'rejected' } } });
    const b = M({ dismissed: { k1: { at: 5, action: 'ignored' } }, dismissTombs: { k1: 9 } }); // k1 "vist igen" senere
    const r = TPSYNC.mergeMeta(TPSYNC.projectMeta(a, 'main'), TPSYNC.projectMeta(b, 'main'), 'main', 20).value;
    assert(!('k1' in r.dismissed)); assert('k2' in r.dismissed);
    const c = M({ dismissed: { k1: { at: 12, action: 'ignored' } } }); // afvist igen EFTER "vis igen"
    assert('k1' in TPSYNC.mergeMeta(TPSYNC.projectMeta(c, 'main'), r, 'main', 20).value.dismissed);
  });
  await T('merge: fokus — nyeste vinder og skifte noteres (ikke tavst); tidsløst fokus overskriver ikke valgt', async () => {
    const a = M({ goalPriority: { focus: 'strength', goalIds: [], since: null, at: 100 } }), b = M({ goalPriority: { focus: 'run', goalIds: [], since: null, at: 200 } });
    const r = TPSYNC.mergeMeta(TPSYNC.projectMeta(a, 'main'), TPSYNC.projectMeta(b, 'main'), 'main', 300);
    assert.strictEqual(r.value.goalPriority.focus, 'run'); assert(r.notes.some(n => /Fokus/.test(n)));
    const d = M(); const r2 = TPSYNC.mergeMeta(TPSYNC.projectMeta(a, 'main'), TPSYNC.projectMeta(d, 'main'), 'main', 300); assert.strictEqual(r2.value.goalPriority.focus, 'strength');
  });
  await T('merge: "ikke mulig"-dage — registre pr. dato; anker kun for hovedprofil', async () => {
    const a = M({ cal: { blocked: { '2026-11-02': { on: true, t: 10 } }, catchup: {}, anchor: { v: '2026-10-01', t: 5 } } });
    const b = M({ cal: { blocked: { '2026-11-02': { on: false, t: 20 }, '2026-11-03': { on: true, t: 1 } }, catchup: {}, anchor: { v: '2026-10-08', t: 9 } } });
    const r = TPSYNC.mergeMeta(TPSYNC.projectMeta(a, 'main'), TPSYNC.projectMeta(b, 'main'), 'main', 30).value;
    assert.strictEqual(r.cal.blocked['2026-11-02'].on, false); assert.strictEqual(r.cal.blocked['2026-11-03'].on, true); assert.strictEqual(r.cal.anchor.v, '2026-10-08');
    const rp = TPSYNC.mergeMeta(TPSYNC.projectMeta(a, 'partner'), TPSYNC.projectMeta(b, 'partner'), 'partner', 30).value; assert.strictEqual(rp.cal.anchor, null);
  });
  await T('to enheder laver forskellige planændringer før synk → begge bevares efter synk (ingen konflikt-dialog)', async () => {
    const W = world(); const mk = (c) => ({ tp_meta_main: J(M({ planChanges: [c] })) });
    const A = W.device('A', mk(chg('cA', 1))), B = W.device('B', mk(chg('cB', 2)));
    await A.engine.syncKey('tp_meta_main'); await B.engine.syncKey('tp_meta_main'); await A.engine.syncKey('tp_meta_main');
    const ida = JSON.parse(A.storage._m.tp_meta_main).planChanges.map(c => c.id).sort(), idb = JSON.parse(B.storage._m.tp_meta_main).planChanges.map(c => c.id).sort();
    assert.deepStrictEqual(ida, ['cA', 'cB']); assert.deepStrictEqual(idb, ['cA', 'cB']); assert.deepStrictEqual(W.record('tp_meta_main').value.planChanges.map(c => c.id).sort(), ['cA', 'cB']);
    assert(!A.engine.isDirty('tp_meta_main') && !B.engine.isDirty('tp_meta_main'));
  });
  await T('samtidige skrivninger af metadata (409) flettes og prøves igen', async () => {
    const W = world(); const A = W.device('A', { tp_meta_main: J(M()) }), B = W.device('B', { tp_meta_main: J(M()) });
    await A.engine.syncKey('tp_meta_main'); await B.engine.syncKey('tp_meta_main');
    const set = (D, c) => { const m = JSON.parse(D.storage._m.tp_meta_main); m.planChanges.push(c); D.storage.setItem('tp_meta_main', J(m)); };
    set(A, chg('cA', 1)); set(B, chg('cB', 2)); await A.engine.push('tp_meta_main'); const r = await B.engine.push('tp_meta_main'); assert.strictEqual(r.status, 'ok');
    assert.deepStrictEqual(W.record('tp_meta_main').value.planChanges.map(c => c.id).sort(), ['cA', 'cB']);
  });
  await T('PROFILISOLERING for metadata: Ellens meta ender aldrig i Olivers nøgle og omvendt; forkert profil afvises', async () => {
    const W = world(); const A = W.device('A', { tp_meta_main: J(M({ planChanges: [chg('o1', 1)] })), tp_meta_partner: J(M({ planChanges: [chg('e1', 1)] })) });
    await A.engine.syncAll(['tp_meta_main', 'tp_meta_partner']);
    assert.deepStrictEqual(W.record('tp_meta_main').value.planChanges.map(c => c.id), ['o1']); assert.deepStrictEqual(W.record('tp_meta_partner').value.planChanges.map(c => c.id), ['e1']);
    W.kv.m.tp_meta_main = J({ value: TPSYNC.projectMeta(M(), 'partner'), updatedAt: 9e12 }); // forkert profil på serveren
    const B = W.device('B'); const r = await B.engine.syncKey('tp_meta_main'); assert.strictEqual(r.status, 'invalid'); assert(!('tp_meta_main' in B.storage._m && JSON.parse(B.storage._m.tp_meta_main).planChanges.length));
    const put = await W.worker.fetch(new Request('https://sync.test/kv/tp_meta_main', { method: 'PUT', body: J({ value: TPSYNC.projectMeta(M(), 'partner') }) }), W.env); assert.strictEqual(put.status, 422);
  });
  await T('"ikke mulig"-dage spejles til dash_*-nøglerne på den anden enhed (rå anker-streng bevares)', async () => {
    const W = world(); const A = W.device('A', { dash_blocked_dates_oliver: J(['2026-11-02']), dash_schedule_anchor: '2026-10-05', tp_meta_main: J(M()) }), B = W.device('B', { tp_meta_main: J(M()) });
    await A.engine.syncKey('tp_meta_main'); await B.engine.syncKey('tp_meta_main');
    assert.deepStrictEqual(JSON.parse(B.storage._m.dash_blocked_dates_oliver), ['2026-11-02']); assert.strictEqual(B.storage._m.dash_schedule_anchor, '2026-10-05');
    // fjernes på A → fjernes på B (ikke "genopstået")
    A.storage.setItem('dash_blocked_dates_oliver', J([])); await A.engine.syncKey('tp_meta_main'); await B.engine.syncKey('tp_meta_main');
    assert.deepStrictEqual(JSON.parse(B.storage._m.dash_blocked_dates_oliver), []);
  });
  await T('slettet-på-én-enhed: fortrudt planændring genopstår ikke efter synk af en tredje enhed', async () => {
    const W = world(); const A = W.device('A', { tp_meta_main: J(M({ planChanges: [chg('c1', 1)] })) }), B = W.device('B');
    await A.engine.syncKey('tp_meta_main'); await B.engine.syncKey('tp_meta_main');
    const m = JSON.parse(B.storage._m.tp_meta_main); TP.tombstone(m, 'c1', 5e12); m.planChanges = []; B.storage.setItem('tp_meta_main', J(m)); await B.engine.syncKey('tp_meta_main');
    await A.engine.syncKey('tp_meta_main'); assert.strictEqual(JSON.parse(A.storage._m.tp_meta_main).planChanges.length, 0);
    const C = W.device('C'); await C.engine.syncKey('tp_meta_main'); assert.strictEqual(JSON.parse(C.storage._m.tp_meta_main).planChanges.length, 0);
  });
  await T('hændelser: "changed" udsendes når data kom fra en anden enhed (så siden kan gen-render)', async () => {
    const W = world(); const A = W.device('A', { sbd_state: J(sbdState(2)) }), B = W.device('B'); const ev = []; B.engine.on(e => ev.push(e.type + ':' + e.key));
    await A.engine.syncKey('sbd_state'); await B.engine.syncKey('sbd_state'); assert(ev.includes('changed:sbd_state'));
  });

  console.log('\n' + (bad ? bad + ' FEJL, ' : '') + ok + ' ok'); process.exit(bad ? 1 : 0);
})();
