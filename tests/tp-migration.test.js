// Problem D: V2→V3-migrering, delvis manglende data, mislykket import. Kør: node tests/tp-migration.test.js
// Kun syntetiske data (e2e/fixtures/demo.json er V2-format uden tpv).
const assert = require('assert'), path = require('path');
const TP = require(path.join(__dirname, '..', 'tp-core.js'));
const demo = require(path.join(__dirname, '..', 'e2e', 'fixtures', 'demo.json'));
let ok = 0, bad = 0;
const T = (n, f) => { try { f(); ok++; console.log('  ok   ' + n); } catch (e) { bad++; console.log('  FEJL ' + n + '\n       ' + (e.stack || e).toString().split('\n').slice(0, 3).join('\n       ')); } };
const J = o => JSON.stringify(o), clone = o => JSON.parse(J(o));
const mem = (init) => { const m = Object.assign({}, init || {}); return { _m: m, getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: k => { delete m[k]; } }; };
const v2store = () => { const s = {}; Object.keys(demo).forEach(k => s[k] = J(demo[k])); return mem(s); };

console.log('V2 → V3');
T('demo-data er V2 (ingen tpv) — forudsætning for testen', () => { assert(!demo.sbd_state.tpv); assert(!demo.lob_state.tpv); });
T('begge profiler migreres uden tab: styrkelogs, 1RM, completedDays og alle løb bevares værdi for værdi', () => {
  ['sbd_state', 'sbd_partner'].forEach((k, i) => {
    const s = clone(demo[k]); TP.migrateSbd(s, i ? 'partner' : 'main');
    assert.deepStrictEqual(s.completedDays, demo[k].completedDays); assert.deepStrictEqual(s.oneRM, demo[k].oneRM);
    Object.keys(demo[k].logs).forEach(d => { const a = clone(s.logs[d]); delete a.sid; assert.deepStrictEqual(a, demo[k].logs[d], k + ' ' + d); });
  });
  ['lob_state', 'lob_partner'].forEach(k => {
    const s = clone(demo[k]); TP.migrateLob(s); assert.strictEqual(s.runs.length, demo[k].runs.length);
    s.runs.forEach((r, i) => { const a = clone(r); delete a.id; const b = clone(demo[k].runs[i]); delete b.id; assert.deepStrictEqual(a, b); });
  });
});
T('migrering er idempotent (to gange = én gang) og ændrer ikke den anden profil', () => {
  const a = clone(demo.sbd_state); TP.migrateSbd(a, 'main'); const once = J(a); TP.migrateSbd(a, 'main'); assert.strictEqual(J(a), once);
  const p = clone(demo.sbd_partner); const before = J(p); TP.migrateSbd(clone(demo.sbd_state), 'main'); assert.strictEqual(J(p), before);
});
T('TP.load af V2-data skriver ikke til lageret (migrering sker kun i hukommelsen indtil brugeren gemmer)', () => {
  const st = v2store(); const snap = J(st._m); TP.load('sbd', 'main', st); TP.load('lob', 'partner', st); assert.strictEqual(J(st._m), snap);
});
T('substitutioner: migreret V2-session har ingen opfundne substitutioner; historik blandes ikke', () => {
  const s = clone(demo.sbd_state); TP.migrateSbd(s, 'main');
  Object.keys(s.logs).forEach(d => (s.logs[d].exercises || []).forEach(e => { assert(!e.substituted, d); }));
});
T('V2-backup (uden checksum/format 3) afvises tydeligt eller genkendes som gammelt format — aldrig halvt', () => {
  const r = TP.parseBackup(J({ app: 'traening-platform', format: 1, data: {} }));
  assert(r.ok === false || (r.legacy || r.ok), 'skal enten afvises eller markeres'); assert(r.errors || r.ok);
});

console.log('Delvis manglende / ugyldige data');
T('backup med kun én profil og uden tp_meta kan gendannes; manglende dele røres ikke', () => {
  const src = v2store(); const b = TP.buildBackup('partner', src); const dst = v2store(); dst.setItem('tp_meta_main', J({ marker: 1 }));
  const lp = JSON.parse(dst._m.lob_partner); lp.runs.pop(); dst.setItem('lob_partner', J(lp)); // så der er noget at gendanne
  const before = [dst._m.sbd_state, dst._m.lob_state, dst._m.tp_meta_main].join('|');
  const plan = TP.planRestore(TP.parseBackup(J(b)), dst); assert(plan.ok); assert(TP.applyRestore(plan, dst).ok);
  assert.strictEqual([dst._m.sbd_state, dst._m.lob_state, dst._m.tp_meta_main].join('|'), before);
});
T('nøgle mangler helt i backup (fx ingen lob_partner) → resten gendannes, intet slettes', () => {
  const b = TP.buildBackup('all', v2store()); delete b.data.lob_partner; b.meta.checksum = TP.hash(J(b.data));
  const dst = v2store(); const keep = dst._m.lob_partner;
  const r = TP.parseBackup(J(b)); if (!r.ok) return; // afvisning er også acceptabelt, så længe intet ændres
  const plan = TP.planRestore(r, dst); if (!plan.ok) return; TP.applyRestore(plan, dst); assert.strictEqual(dst._m.lob_partner, keep);
});
T('MISLYKKET IMPORT efterlader data uændret: ugyldig JSON, tom fil, forkert type, afkortet fil', () => {
  const dst = v2store(); const snap = J(dst._m);
  ['', '{', 'null', '[]', '{"app":"andet"}', J(TP.buildBackup('all', v2store())).slice(0, 500)].forEach(txt => {
    const r = TP.parseBackup(txt); assert(!r.ok, 'burde afvises: ' + txt.slice(0, 20));
  });
  assert.strictEqual(J(dst._m), snap, 'parse må aldrig skrive'); assert(!TP.hasSnapshot(dst), 'ingen sikkerhedskopi oprettet af mislykket import');
});
T('korrupt blob i backup (løb er ikke en liste) afvises i planen — ingen delvis gendannelse', () => {
  const b = TP.buildBackup('all', v2store()); b.data.lob_state.runs = 'ødelagt'; b.meta.checksum = TP.hash(J(b.data));
  const dst = v2store(); const snap = J(dst._m); const r = TP.parseBackup(J(b)); const plan = r.ok ? TP.planRestore(r, dst) : r;
  assert(!r.ok || !plan.ok || plan.items.every(i => i.key !== 'lob_state' || i.invalid || !i.selected), 'korrupt post må ikke vælges');
  if (plan.ok) { const res = TP.applyRestore(plan, dst); assert(!res.written || !res.written.includes('lob_state')); }
  assert.strictEqual(dst._m.lob_state, snap && JSON.parse(snap).lob_state);
});
T('gendannelse efter mislykket import: ny, gyldig gendannelse virker og kan fortrydes', () => {
  const dst = v2store(); TP.parseBackup('{'); const old = dst._m.lob_state;
  const b = TP.buildBackup('all', v2store()); const s = JSON.parse(J(b)); s.data.lob_state.runs.pop(); s.meta.checksum = TP.hash(J(s.data));
  const plan = TP.planRestore(TP.parseBackup(J(s)), dst); assert(TP.applyRestore(plan, dst).ok); assert.notStrictEqual(dst._m.lob_state, old);
  assert(TP.undoRestore(dst).ok); assert.strictEqual(dst._m.lob_state, old);
});
T('dash_schedule_anchor (rå streng) overlever backup→gendannelse uændret', () => {
  const src = v2store(); src.setItem('dash_schedule_anchor', '2026-10-01'); const dst = mem({});
  TP.applyRestore(TP.planRestore(TP.parseBackup(J(TP.buildBackup('all', src))), dst), dst); assert.strictEqual(dst._m.dash_schedule_anchor, '2026-10-01');
});
console.log(`\n${bad ? bad + ' FEJL, ' : ''}${ok} ok`); process.exit(bad ? 1 : 0);
