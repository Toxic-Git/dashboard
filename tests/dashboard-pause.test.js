// Kør: node tests/dashboard-pause.test.js — dashboardets læsning af SBD-pauser (kun accessories)
const fs=require('fs'),assert=require('assert'),path=require('path');
const s=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
const cut=(a,b)=>s.slice(s.indexOf(a),s.indexOf(b,s.indexOf(a)));
require('vm').runInThisContext(cut('// Planlagt pause (kun accessories)','function sbdCompletedByDate')+';globalThis.__t={sbdPauseFor,sbdPauseLabel}');
const {sbdPauseFor,sbdPauseLabel}=globalThis.__t;
const raw=(o)=>Object.assign({pauses:[{id:'a',from:'2026-11-23',to:'2026-11-29',name:'Skole',mode:'acc'}],pauseSkip:{}},o||{});
assert(sbdPauseFor(raw(),'2026-11-23')&&sbdPauseFor(raw(),'2026-11-29'),'begge ender inkluderet');
assert.strictEqual(sbdPauseFor(raw(),'2026-11-22'),null); assert.strictEqual(sbdPauseFor(raw(),'2026-11-30'),null);
assert.strictEqual(sbdPauseFor(raw({pauseSkip:{'2026-11-25':true}}),'2026-11-25'),null,'ignoreret dag');
assert(sbdPauseFor(raw({pauseSkip:{'2026-11-25':true}}),'2026-11-26'));
assert.strictEqual(sbdPauseFor(null,'2026-11-25'),null); assert.strictEqual(sbdPauseFor({},'2026-11-25'),null); assert.strictEqual(sbdPauseFor({pauses:'x'},'2026-11-25'),null);
assert.strictEqual(sbdPauseLabel(raw().pauses[0]),'Kun accessories · Skole'); assert.strictEqual(sbdPauseLabel({}),'Kun accessories');
// kildekode: hybBuild lader ikke pausedage forbruge programmets cursor, og pausedage tæller aldrig som aktiv styrke i analysen (status skipped)
assert(/if\(pz&&slotMap\[date\]&&slotMap\[date\]\.sbd\)\{ paused\[date\]=pz; continue; \}/.test(s),'cursor springes over på pausedage');
assert(/id:'sbd-pause', kind:'sbd', status:'skipped', pause:true/.test(s),'planlagt pausedag er skipped (ikke aktiv styrke)');
console.log('OK');
