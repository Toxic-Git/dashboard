const fs=require('fs'),vm=require('vm'),assert=require('assert'),path=require('path');
// Kør: node tests/sbd-pause.test.js  (fra repo-roden eller tests/)
const R=f=>path.join(__dirname,'..',f);
const h=fs.readFileSync(R('sbd/index.html'),'utf8');
const code=[...h.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]).join('\n');
const mem={};global.localStorage={getItem:k=>k in mem?mem[k]:null,setItem:(k,v)=>{mem[k]=String(v)},removeItem:k=>{delete mem[k]}};
const el=()=>new Proxy(function(){}, {get:(t,k)=>k==='style'||k==='classList'||k==='dataset'?el():(k==='length'?0:(k==='innerHTML'||k==='textContent'||k==='value'?'':el())),set:()=>true,apply:()=>el()});
global.document={getElementById:()=>el(),querySelectorAll:()=>[],querySelector:()=>el(),addEventListener(){},createElement:()=>el(),body:el()};
global.window=global;global.navigator={userAgent:'n'};global.fetch=async()=>({ok:false});
global.TP = require('../tp-core.js'); global.TPSYNC = require('../tp-sync.js');
vm.runInThisContext(code,{filename:'sbd'});
let ok=0,bad=0;const T=(n,f)=>{try{f();ok++;console.log('  ok   '+n)}catch(e){bad++;console.log('  FEJL '+n+'\n       '+e.message)}};
const mkAs=(o)=>Object.assign({totalDays:0,logs:{},completedDays:[],sessionTimes:{},pauses:[],pauseLogs:{},pauseSkip:{}},o||{});
T('isISODate / pauseDayDiff',()=>{
  assert(isISODate('2026-11-23')); assert(!isISODate('2026-13-40')); assert(!isISODate('23-11-2026')); assert(!isISODate(null));
  assert.equal(pauseDayDiff('2026-11-23','2026-11-29'),6); assert.equal(pauseDayDiff('2026-10-24','2026-10-26'),2,'sommertid må ikke give 1,96 dage');
});
T('pauseAdd: gyldig periode gemmes sorteret, med navn trimmet og mode acc',()=>{
  const as=mkAs(); assert(pauseAdd(as,'2027-02-01','2027-02-05','  Skole 2  ').ok); assert(pauseAdd(as,'2026-11-23','2026-11-29','Skole').ok);
  assert.deepStrictEqual(as.pauses.map(p=>p.from),['2026-11-23','2027-02-01']); assert.equal(as.pauses[1].name,'Skole 2'); assert.equal(as.pauses[0].mode,'acc');
  assert.notEqual(as.pauses[0].id,as.pauses[1].id);
});
T('pauseAdd: afviser ugyldigt, omvendt og overlappende',()=>{
  const as=mkAs(); assert.equal(pauseAdd(as,'','2026-11-29').ok,false); assert.equal(pauseAdd(as,'2026-11-29','2026-11-23').ok,false);
  pauseAdd(as,'2026-11-23','2026-11-29'); assert.equal(pauseAdd(as,'2026-11-29','2026-12-02').ok,false,'delt endedag overlapper');
  assert.equal(pauseAdd(as,'2026-11-30','2026-12-02').ok,true,'dagen efter er fri'); assert.equal(as.pauses.length,2);
});
T('pauseForDate: begge endepunkter inkluderet, udenfor = null, pauseSkip ignorerer',()=>{
  const as=mkAs(); pauseAdd(as,'2026-11-23','2026-11-29','Skole');
  for(const d of ['2026-11-23','2026-11-26','2026-11-29']) assert(pauseForDate(as,d),d);
  for(const d of ['2026-11-22','2026-11-30']) assert.equal(pauseForDate(as,d),null,d);
  as.pauseSkip['2026-11-26']=true; assert.equal(pauseForDate(as,'2026-11-26'),null); assert(pauseForDate(as,'2026-11-27'));
  assert.equal(pauseForDate(mkAs(),'2026-11-26'),null); assert.equal(pauseForDate(null,'2026-11-26'),null); assert.equal(pauseForDate(as,'xx'),null);
});
T('pauseWorkoutOrder: kun træningsdage, fra programmets position',()=>{
  const o0=pauseWorkoutOrder(mkAs({totalDays:0})).map(d=>d.id); assert(o0.length>=5&&o0.every(id=>id!=='rest1'&&id!=='rest2'),o0.join());
  const as=mkAs({totalDays:3}); assert.equal(pauseWorkoutOrder(as)[0].id,CYCLE[3].type==='workout'?CYCLE[3].id:CYCLE[4].id);
});
T('pauseEnsureLog: kun accessories, stabil log, rotation efter færdige pausedage, rører ikke programmet',()=>{
  state.profile='main'; state.totalDays=0; state.logs={}; state.completedDays=[]; state.sessionTimes={}; state.pauses=[]; state.pauseLogs={}; state.pauseSkip={};
  const as=aState(); const p=pauseAdd(as,'2026-11-23','2026-11-29','Skole').pause; const before=JSON.stringify([as.totalDays,as.logs,as.completedDays,as.sessionTimes]);
  const l1=pauseEnsureLog(as,p,'2026-11-23',1); assert(l1&&l1.exercises.length>0);
  assert(l1.exercises.every(e=>!/Backdown|Box Jump/.test(e.name)&&e.sets.length===e.scheme.sets&&e.sets.every(s=>s.done===false)));
  const main=getExercisesBase(l1.cycleId,1).filter(e=>e.type==='acc').map(e=>e.name); assert.deepStrictEqual(l1.exercises.map(e=>e.name),main);
  assert.strictEqual(pauseEnsureLog(as,p,'2026-11-23',3),l1,'samme dag = samme log (planen låses)');
  l1.done=true; const l2=pauseEnsureLog(as,p,'2026-11-24',1); assert.notEqual(l2.cycleId,l1.cycleId,'næste pausedag = næste træningsdag');
  assert.equal(JSON.stringify([as.totalDays,as.logs,as.completedDays,as.sessionTimes]),before,'programdag/completedDays/sessionTimes uændrede');
  assert.equal(daysSinceLastSbdSession(as),null,'pausedage må ikke tælle som SBD-session i gap-beregningen');
});
T('pauseEnsureLog: ufærdig pausedag giver samme dag næste gang (rotation rykker kun ved færdige)',()=>{
  state.pauseLogs={}; const as=aState(); const p=state.pauses[0];
  const a=pauseEnsureLog(as,p,'2026-11-25',1); const b=pauseEnsureLog(as,p,'2026-11-26',1); assert.equal(a.cycleId,b.cycleId);
});
T('pauseEnsureLog: rotationen løber rundt ved lange pauser',()=>{
  state.pauseLogs={}; const as=aState(); const n=pauseWorkoutOrder(as).length; const p=pauseAdd(as,'2027-03-01','2027-03-31','Lang').pause;
  const ids=[]; for(let i=0;i<n+1;i++){ const iso='2027-03-'+String(i+1).padStart(2,'0'); const l=pauseEnsureLog(as,p,iso,1); l.done=true; ids.push(l.cycleId); }
  assert.equal(ids[0],ids[n],'efter n dage starter rotationen forfra'); assert.equal(new Set(ids.slice(0,n)).size,n);
});
T('lastPauseEntry + getLastPerformance: pausedag bruges som seneste præstation, kun færdige sæt',()=>{
  state.pauseLogs={}; const as=aState(); const p=state.pauses[0]; const l=pauseEnsureLog(as,p,'2026-11-23',1); const ex=l.exercises[0];
  assert.equal(lastPauseEntry(as,ex.name),null,'ingen færdige sæt endnu');
  ex.sets[0]={kg:20,reps:10,done:true}; ex.sets[1]={kg:22.5,reps:8,done:true}; ex.sets[2]={kg:99,reps:1,done:false};
  const e=lastPauseEntry(as,ex.name); assert(e&&e.kg>0&&e.setsSummary==='20×10, 22.5×8'); const lp=getLastPerformance(ex.name,true); assert(lp&&lp.setsSummary==='20×10, 22.5×8');
  assert.equal(getExerciseHistory(ex.name).length>=1,true); assert.equal(getExercisePracticeCount(ex.name)>=1,true);
});
T('getLastPerformance: nyere regulær session slår ældre pausedag, nyere pausedag slår regulær',()=>{
  state.pauseLogs={}; state.logs={}; state.completedDays=[]; state.sessionTimes={}; const as=aState(); const p=state.pauses[0];
  const l=pauseEnsureLog(as,p,'2026-11-23',1); const ex=l.exercises[0]; ex.sets[0]={kg:20,reps:10,done:true}; l.end=1000;
  as.logs.day5={exercises:[{name:ex.name,sets:[{kg:30,reps:8,done:true}]}]}; as.completedDays=[5]; as.sessionTimes.day5={end:2000,start:1500};
  assert.equal(getLastPerformance(ex.name,true).kg,30,'regulær er nyest'); l.end=3000; assert.equal(getLastPerformance(ex.name,true).kg,20,'pausedag er nyest');
  state.logs={}; state.completedDays=[]; state.sessionTimes={};
});
T('kildekode: hook i renderToday, indstillinger, eksport og nulstilling er koblet på',()=>{
  assert(/const activePause = pauseForDate\(as, pauseISO\(\)\);\s*\n\s*if \(activePause\) \{ renderPauseToday/.test(h),'hook');
  assert(h.includes('id="setting-pause-section"')&&/renderPauseSettings\(\);\n\}/.test(h),'indstillinger');
  assert(/plannedPauses:/.test(h)&&/pauseSessions:/.test(h)&&/plannedPause: true/.test(h),'eksport');
  assert((h.match(/pauseLogs = \{\}/g)||[]).length>=4,'nulstilling');
});
console.log(bad?`\n${bad} FEJL`:`\nAlle ${ok} tests bestået`);process.exit(bad?1:0);
