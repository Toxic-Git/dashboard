// Tests for tp-core.js: fælles datatilgang, migration, samlet backup/gendannelse (Fase 1).
// Kør: node tests/tp-core.test.js   — ingen netværk, ingen hemmeligheder, kun syntetiske data.
const assert = require('assert'), path = require('path');
const TP = require(path.join(__dirname, '..', 'tp-core.js'));
const demo = require(path.join(__dirname, '..', 'e2e', 'fixtures', 'demo.json'));

let ok = 0, bad = 0;
const T = (n, f) => { try { f(); ok++; console.log('  ok   ' + n); } catch (e) { bad++; console.log('  FEJL ' + n + '\n       ' + (e.stack || e).toString().split('\n').slice(0, 3).join('\n       ')); } };

function mem(init, opts) {
  opts = opts || {};
  const m = Object.assign({}, init || {}); let writes = 0;
  return {
    _m: m,
    getItem: k => (k in m ? m[k] : null),
    setItem: (k, v) => { writes++; if (opts.failOnWrite && writes === opts.failOnWrite) throw new Error('QuotaExceededError'); m[k] = String(v); },
    removeItem: k => { delete m[k]; }
  };
}
const J = o => JSON.stringify(o);
const seeded = () => {
  const s = {}; Object.keys(demo).forEach(k => s[k] = J(demo[k]));
  s.sync_token = 'SECRET-TOKEN-SKAL-IKKE-I-BACKUP';
  s.dash_blocked_dates_oliver = J(['2026-10-27']); s.dash_blocked_dates_ellen = J(['2026-10-28']);
  s.dash_catchup_dates_oliver = J([]);
  s.dash_schedule_anchor = '2026-10-01'; // dashboardet lagrer ankeret som RÅ datostreng (ikke JSON) — fixturen skal afspejle det
  s.tp_meta_main = J({ tpv: 3, planChanges: [{ id: 'a', type: 'move' }], dismissed: {}, goalPriority: { focus: 'strength', goalIds: [], since: null }, reports: {} });
  return mem(s);
};

console.log('— Hjælpere');
T('exId normaliserer navne stabilt', () => {
  assert.strictEqual(TP.exId('Hack Squat (Machine)'), 'hack-squat-machine');
  assert.strictEqual(TP.exId('Deadlift (Conv.) — Backdown'), 'deadlift-conv-backdown');
  assert.strictEqual(TP.exId('Hammer Curl (DB)'), TP.exId(' hammer  curl (db) '));
});
T('localISO/addDays/weekStart bruger lokal dato', () => {
  assert.strictEqual(TP.addDays('2026-10-31', 1), '2026-11-01');
  assert.strictEqual(TP.weekStart('2026-10-25'), '2026-10-19'); // søndag → mandag før
  assert.strictEqual(TP.weekStart('2026-10-26'), '2026-10-26');
  assert.strictEqual(TP.diffDays('2026-10-26', '2026-11-02'), 7);
});
T('hash er deterministisk og følsom', () => {
  assert.strictEqual(TP.hash('abc'), TP.hash('abc')); assert.notStrictEqual(TP.hash('abc'), TP.hash('abd'));
});

console.log('— Migration');
T('migrateSbd tilføjer felter + deterministiske sid uden at slette noget', () => {
  const s = JSON.parse(J(demo.sbd_state)); const before = J(s.logs);
  TP.migrateSbd(s, 'main');
  assert(s.exerciseSubs && s.altOverrides && s.sessionEval); assert.strictEqual(s.tpv, 3);
  Object.keys(s.logs).forEach(k => { assert(s.logs[k].sid); });
  const stripped = JSON.parse(J(s.logs)); Object.keys(stripped).forEach(k => delete stripped[k].sid);
  assert.strictEqual(J(stripped), before, 'logs må kun få sid');
  const sid1 = s.logs[Object.keys(s.logs)[0]].sid; TP.migrateSbd(s, 'main');
  assert.strictEqual(s.logs[Object.keys(s.logs)[0]].sid, sid1, 'idempotent');
});
T('migrateLob giver løb stabile id uden at ændre eksisterende', () => {
  const s = JSON.parse(J(demo.lob_state)); s.runs[0].id = 'behold-mig'; delete s.runs[1].id;
  TP.migrateLob(s); assert.strictEqual(s.runs[0].id, 'behold-mig'); assert(s.runs[1].id);
  const id = s.runs[1].id; TP.migrateLob(s); assert.strictEqual(s.runs[1].id, id);
});
T('migrateMeta håndterer null/ældre/manglende felter', () => {
  const a = TP.migrateMeta(null); assert.strictEqual(a.goalPriority.focus, 'balanced'); assert(Array.isArray(a.planChanges));
  const b = TP.migrateMeta({ planChanges: 'forkert', goalPriority: { focus: 'run' } }); assert(Array.isArray(b.planChanges)); assert.strictEqual(b.goalPriority.focus, 'run');
});
T('TP.load er ikke-skrivende og profil-isoleret', () => {
  const st = seeded(); const snapshot = J(st._m);
  const a = TP.load('sbd', 'main', st), b = TP.load('sbd', 'partner', st);
  assert.strictEqual(J(st._m), snapshot, 'load må ikke skrive');
  assert(a && b && a !== b); assert.strictEqual(TP.load('lob', 'main', st).runs.length, demo.lob_state.runs.length);
  assert.strictEqual(TP.load('sbd', 'main', mem({})), null);
});
T('sessions samler styrke + løb pr. profil uden at blande', () => {
  const st = seeded(); const m = TP.sessions('main', st), p = TP.sessions('partner', st);
  assert.strictEqual(m.filter(x => x.type === 'run').length, demo.lob_state.runs.length);
  assert.strictEqual(m.filter(x => x.type === 'sbd').length, demo.sbd_state.completedDays.length);
  assert.strictEqual(p.filter(x => x.type === 'run').length, demo.lob_partner.runs.length);
  assert(m.every(x => x.profile === 'main') && p.every(x => x.profile === 'partner'));
  assert(new Set(m.map(x => x.sid)).size === m.length, 'unikke id');
});

console.log('— Backup (eksport)');
T('samlet backup har version, tid, profiler, checksum og begge profiler', () => {
  const b = TP.buildBackup('all', seeded());
  assert.strictEqual(b.app, 'traening-platform'); assert.strictEqual(b.format, 3); assert(b.exportedAt && b.appVersion);
  assert.deepStrictEqual(b.profiles.map(p => p.id), ['main', 'partner']); assert(b.meta.checksum);
  ['sbd_state', 'sbd_partner', 'lob_state', 'lob_partner', 'tp_meta_main'].forEach(k => assert(b.data[k], k));
  assert(b.data.dash.dash_blocked_dates_oliver && b.data.dash.dash_blocked_dates_ellen && b.data.dash.dash_schedule_anchor);
});
T('backup indeholder ALDRIG sync_token eller andre hemmeligheder', () => {
  const s = J(TP.buildBackup('all', seeded())); assert(!/SECRET-TOKEN|sync_token/.test(s));
});
T('profil-backup indeholder kun den profils nøgler', () => {
  const b = TP.buildBackup('partner', seeded()); assert(b.data.sbd_partner && b.data.lob_partner);
  assert(!b.data.sbd_state && !b.data.lob_state && !b.data.tp_meta_main);
  assert(!b.data.dash || !b.data.dash.dash_blocked_dates_oliver);
});

console.log('— Import: validering');
T('afkortet/ugyldig JSON afvises', () => { const r = TP.parseBackup('{"app":"traening-platform","format":3,"data":{'); assert(!r.ok); });
T('ændret indhold (forkert checksum) afvises', () => {
  const b = TP.buildBackup('all', seeded()); b.data.lob_state.runs[0].distanceKm = 999;
  const r = TP.parseBackup(J(b)); assert(!r.ok && /Kontrolsum/i.test(r.errors[0]));
});
T('nyere formatversion afvises med tydelig besked', () => {
  const b = TP.buildBackup('all', seeded()); b.format = 99; const r = TP.parseBackup(J(b)); assert(!r.ok && /NYERE/.test(r.errors[0]));
});
T('analyse-eksport og ukendte filer afvises', () => {
  assert(!TP.parseBackup(J({ foo: 1 })).ok);
  assert(!TP.parseBackup(J(demo.sbd_state)).ok);
  assert(!TP.parseBackup('[1,2]').ok);
});
T('beskadigede blobs afvises i planen (ingen delvis gendannelse mulig)', () => {
  const b = TP.buildBackup('all', seeded()); b.data.lob_state.runs[1].durationSec = -5;
  b.meta.checksum = TP.hash(J(b.data));
  const plan = TP.planRestore(TP.parseBackup(J(b)), seeded()); assert(!plan.ok); assert(plan.errors.some(e => /løb/i.test(e)));
  const r = TP.applyRestore(plan, seeded()); assert(!r.ok && !r.changed);
});
T('gamle formater (SBD v1, løb v1, enkelt-løb) genkendes', () => {
  const a = TP.parseBackup(J({ backupVersion: 1, exportedAt: 'x', sbd_state: demo.sbd_state, sbd_partner: demo.sbd_partner }));
  assert(a.ok && a.legacy && a.data.sbd_state && a.data.sbd_partner && !a.data.lob_state);
  const b = TP.parseBackup(J({ app: 'lob-tracker', version: 1, main: demo.lob_state, partner: demo.lob_partner }));
  assert(b.ok && b.data.lob_state && b.data.lob_partner);
  const c = TP.parseBackup(J(demo.lob_state)); assert(c.ok && c.scope === 'single-lob');
  const plan = TP.planRestore(c, mem({}), { singleLobTarget: 'partner' }); assert(plan.ok && plan.items[0].key === 'lob_partner');
});

console.log('— Import: plan og konflikter');
T('plan viser hvad der gendannes + markerer identiske data som "same"', () => {
  const st = seeded(); const plan = TP.planRestore(TP.parseBackup(J(TP.buildBackup('all', st))), st);
  assert(plan.ok); assert(plan.items.length >= 6);
  assert(plan.items.filter(i => i.key === 'lob_state')[0].action === 'same');
});
T('konflikt: backup med færre løb/styrketræninger end nu', () => {
  const old = seeded(); const b = TP.buildBackup('all', old);
  const st = seeded(); const lob = JSON.parse(st._m.lob_state); lob.runs.push({ id: 'ny', date: '2026-10-25', distanceKm: 5, durationSec: 1500 });
  st._m.lob_state = J(lob);
  const plan = TP.planRestore(TP.parseBackup(J(b)), st);
  const it = plan.items.find(i => i.key === 'lob_state'); assert.strictEqual(it.action, 'replace');
  assert(it.conflicts.some(c => /færre løb/.test(c)), J(it.conflicts));
});
T('advarsel når synkronisering er sat op', () => {
  const st = seeded(); const plan = TP.planRestore(TP.parseBackup(J(TP.buildBackup('all', st))), st);
  assert(plan.warnings.some(w => /Synkronisering/.test(w)));
});

console.log('— Import: gendannelse, rollback, fortryd');
T('fuld gendannelse: data tilbage, sid/migration, __updatedAt urørt, epoch sat, snapshot findes', () => {
  const src = seeded(); const b = TP.buildBackup('all', src);
  const dst = mem({ sbd_state: J({ totalDays: 0, logs: {}, completedDays: [], profile: 'partner' }), lob_state: J({ profile: { navn: 'x' }, runs: [] }) });
  const plan = TP.planRestore(TP.parseBackup(J(b)), dst); assert(plan.ok);
  const r = TP.applyRestore(plan, dst, { now: 1234567890000 }); assert(r.ok, J(r));
  const lob = JSON.parse(dst._m.lob_state); assert.strictEqual(lob.runs.length, demo.lob_state.runs.length); assert(lob.runs[0].id);
  const sbd = JSON.parse(dst._m.sbd_state); assert.strictEqual(sbd.completedDays.length, demo.sbd_state.completedDays.length);
  assert.strictEqual(sbd.profile, 'partner', 'aktiv profilvælger bevares');
  assert.strictEqual(dst._m['lob_state__updatedAt'], undefined, 'V3.1: __updatedAt er serverens version og røres ikke af gendannelse'); assert.strictEqual(dst._m[TP.RESTORE_EPOCH_KEY], '1234567890000');
  assert(!('sync_token' in dst._m));
  assert(TP.hasSnapshot(dst));
});
T('fortryd gendannelse genskaber de gamle data præcist', () => {
  const dst = mem({ lob_state: J({ profile: { navn: 'gammel' }, runs: [{ id: 'r1', date: '2026-01-01', distanceKm: 1, durationSec: 300 }] }) });
  const before = dst._m.lob_state;
  const plan = TP.planRestore(TP.parseBackup(J(TP.buildBackup('all', seeded()))), dst); TP.applyRestore(plan, dst);
  assert.notStrictEqual(dst._m.lob_state, before);
  const u = TP.undoRestore(dst); assert(u.ok); assert.strictEqual(dst._m.lob_state, before);
  assert(!('sbd_state' in dst._m), 'nøgler der ikke fandtes før fjernes igen'); assert(!TP.hasSnapshot(dst));
});
T('skrivefejl midt i gendannelsen → alt rulles tilbage, gamle data intakte', () => {
  const dst = seeded(); const before = J(dst._m);
  // anden backup (modificeret), så der er noget at skrive
  const srcB = TP.buildBackup('all', seeded()); srcB.data.lob_state.runs.pop(); srcB.meta.checksum = TP.hash(J(srcB.data));
  const plan = TP.planRestore(TP.parseBackup(J(srcB)), dst); assert(plan.ok);
  const dst2 = mem(JSON.parse(before), { failOnWrite: 3 }); // 1 = snapshot, 2 = første blob, 3 = fejl
  const r = TP.applyRestore(plan, dst2); assert(!r.ok && r.rolledBack, J(r));
  ['sbd_state', 'lob_state', 'lob_partner', 'tp_meta_main'].forEach(k => assert.strictEqual(dst2._m[k], JSON.parse(before)[k], k + ' skulle være uændret'));
});
T('kan ikke oprette sikkerhedskopi → intet ændres', () => {
  const dst = mem(JSON.parse(J(seeded()._m)), { failOnWrite: 1 }); const before = J(dst._m);
  const srcB = TP.buildBackup('all', seeded()); srcB.data.lob_state.runs.pop(); srcB.meta.checksum = TP.hash(J(srcB.data));
  const r = TP.applyRestore(TP.planRestore(TP.parseBackup(J(srcB)), dst), dst); assert(!r.ok && !r.changed);
  assert.strictEqual(J(dst._m), before);
});
T('kun valgte poster gendannes (fravalg respekteres)', () => {
  const dst = mem({}); const plan = TP.planRestore(TP.parseBackup(J(TP.buildBackup('all', seeded()))), dst);
  plan.items.forEach(i => { i.selected = i.key === 'lob_partner'; });
  const r = TP.applyRestore(plan, dst); assert(r.ok); assert.deepStrictEqual(r.written, ['lob_partner']); assert(!('lob_state' in dst._m));
});
T('profil-isolering: gendannelse af Ellens backup rører ikke Olivers data', () => {
  const dst = seeded(); const oliverBefore = [dst._m.sbd_state, dst._m.lob_state, dst._m.tp_meta_main].join('|');
  const b = TP.buildBackup('partner', seeded()); const lp = b.data.lob_partner; lp.runs.pop(); b.meta.checksum = TP.hash(J(b.data));
  const plan = TP.planRestore(TP.parseBackup(J(b)), dst); assert(plan.ok);
  assert(plan.items.every(i => !/sbd_state|lob_state|tp_meta_main|oliver/.test(i.key)), J(plan.items.map(i => i.key)));
  assert(TP.applyRestore(plan, dst).ok);
  assert.strictEqual([dst._m.sbd_state, dst._m.lob_state, dst._m.tp_meta_main].join('|'), oliverBefore);
});
T('roundtrip: eksport → import → eksport giver samme data', () => {
  const src = seeded(); const b1 = TP.buildBackup('all', src);
  const dst = mem({}); TP.applyRestore(TP.planRestore(TP.parseBackup(J(b1)), dst), dst);
  ['sbd_state', 'sbd_partner', 'lob_state', 'lob_partner'].forEach(k => {
    const a = TP.load(k.startsWith('sbd') ? 'sbd' : 'lob', k.endsWith('partner') ? 'partner' : 'main', src);
    const c = TP.load(k.startsWith('sbd') ? 'sbd' : 'lob', k.endsWith('partner') ? 'partner' : 'main', dst);
    assert.strictEqual(J(a.runs || a.completedDays), J(c.runs || c.completedDays), k);
  });
});

console.log(`\n${bad ? bad + ' FEJL, ' : ''}${ok} ok`);
process.exit(bad ? 1 : 0);
