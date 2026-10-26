const fs=require('fs'),vm=require('vm'),assert=require('assert'),path=require('path');
// Kør: node tests/sbd-genstart.test.js
const h=fs.readFileSync(path.join(__dirname,'..','sbd/index.html'),'utf8');
const code=[...h.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]).join('\n');
const mem={};global.localStorage={getItem:k=>k in mem?mem[k]:null,setItem:(k,v)=>{mem[k]=String(v)},removeItem:k=>{delete mem[k]}};
const el=()=>new Proxy(function(){}, {get:(t,k)=>k==='style'||k==='classList'||k==='dataset'?el():(k==='length'?0:(k==='innerHTML'||k==='textContent'||k==='value'?'':el())),set:()=>true,apply:()=>el()});
global.document={getElementById:()=>el(),querySelectorAll:()=>[],querySelector:()=>el(),addEventListener(){},createElement:()=>el(),body:el()};
global.window=global;global.navigator={userAgent:'n'};global.fetch=async()=>({ok:false});
vm.runInThisContext(code,{filename:'sbd'});
let ok=0,bad=0;const T=(n,f)=>{try{f();ok++;console.log('  ok   '+n)}catch(e){bad++;console.log('  FEJL '+n+'\n       '+e.message)}};
const clear=()=>Object.keys(_exercisesCache).forEach(k=>delete _exercisesCache[k]);
for(const prof of ['main','partner']){
  state.profile=prof; clear();
  const as=aState();
  const acc=getAccessoryNames();
  const A=acc.includes('Romanian Deadlift')?'Romanian Deadlift':acc[0];
  T(`[${prof}] accessory-navne findes og indeholder ikke SBD-løft`,()=>{
    assert(acc.length>8,'for få: '+acc.length);
    assert(!acc.includes('Squat')&&!acc.includes('Bench Press')&&!acc.includes('Deadlift (Conv.)'));
  });
  // Sæt en historik op: dag 3 har logget accessory A med 100 kg, SBD-autoreg for Squat
  as.logs={day3:{exercises:[{name:A,sets:[{kg:'95',reps:'8',done:true},{kg:'100',reps:'6',done:true}]}]}};
  as.completedDays=[3]; as.totalDays=40; as.pr={sq:{x:1}}; as.bodyweight={3:80}; as.exerciseNotes={n:1};
  as.autoregAdj={[A]:{sessions:[{kg:100,pct:.02,day:3,applyFromDay:4}]},'Squat':{sessions:[{kg:100,pct:.02,day:3,nextKg:102}]}};
  const before={sq:getSQ(),bp:getBP(),dl:getDL()};
  restartToWeek1(10,100);
  T(`[${prof}] tilbage til uge 1, dag 0, log tom`,()=>{
    assert.equal(as.totalDays,0);assert.equal(getWeek(),1);assert(!as.logs.day3,'gammelt log fjernet');assert.deepStrictEqual(as.completedDays,[]);
  });
  T(`[${prof}] SBD sænket 10 % (rundet til 0,5) og baseline låst`,()=>{
    for(const k of ['sq','bp','dl']){assert.equal(as.oneRM[k],Math.round(before[k]*0.9*2)/2);assert.deepStrictEqual(as.programStart1RM,as.oneRM);}
  });
  T(`[${prof}] accessory-tal gemt og brugt som startvægt + 'Sidst'`,()=>{
    clear();
    assert.equal(as.accBaseline[A].kg,95); // bedste sæt efter e1RM (95×8 > 100×6), som 'Sidst'-visningen
    const ex=getExercises(Object.keys(ACC_TEMPLATES).find(d=>ACC_TEMPLATES[d].some(a=>a.name===A))||'cst1',1);
    // find i partner/main skabelon uanset dag
    let found=null;for(const d of ['cst1','low1','bb1','cst2','low2','bb2'])getExercises(d,1).forEach(e=>{if(e.name===A)found=e;});
    assert(found,'øvelse ikke fundet');assert.equal(found.scheme.kg,95);
    const lp=getLastPerformance(A);assert.equal(lp.kg,95);assert(/forrige program/.test(lp.setsSummary));
  });
  T(`[${prof}] SBD-autoreg fjernet, accessory-autoreg bevaret`,()=>{
    assert(!as.autoregAdj['Squat']||as.autoregAdj['Squat'].sessions.length===0);assert(as.autoregAdj[A]&&as.autoregAdj[A].sessions.length===1);assert.equal(as.autoregAdj[A].sessions[0].day,-1);
  });
  T(`[${prof}] PR, kropsvægt, noter og historik bevaret; gammelt program arkiveret`,()=>{
    assert.deepStrictEqual(as.pr,{sq:{x:1}});assert.deepStrictEqual(as.bodyweight,{3:80});assert.deepStrictEqual(as.exerciseNotes,{n:1});
    const h=as.programHistory[as.programHistory.length-1];assert(h.restart);assert(h.program.day3);assert.equal(h.sq,before.sq);
  });
  T(`[${prof}] dobbelt genstart skalerer ikke accessories to gange`,()=>{
    restartToWeek1(0,90);
    assert.equal(as.accBaseline[A].kg,95,'uden nye logs skal baseline være uændret: '+as.accBaseline[A].kg);
  });
  T(`[${prof}] ny logning overskriver baseline ved næste genstart`,()=>{
    as.logs={day1:{exercises:[{name:A,sets:[{kg:'60',reps:'10',done:true}]}]}};as.completedDays=[1];
    restartToWeek1(0,100);assert.equal(as.accBaseline[A].kg,60);
  });
}
T('uden baseline: skabelonens vægt uændret',()=>{
  state.profile='main';delete state.accBaseline;clear();
  assert.equal(accStartKg('Romanian Deadlift',80),80);
});

// ── Pr. løft-procent, letvægts-start og autoreg-dedupe ──
T('pr. løft-procenter (sq 15, bp 6, dl 10) rammer hvert løft for sig',()=>{
  state.profile='main';clear();
  state.oneRM={sq:117.02,bp:95.58,dl:178.19};
  restartToWeek1({sq:15,bp:6,dl:10},100,false);
  assert.equal(state.oneRM.sq,Math.round(117.02*0.85*2)/2);
  assert.equal(state.oneRM.bp,Math.round(95.58*0.94*2)/2);
  assert.equal(state.oneRM.dl,Math.round(178.19*0.90*2)/2);
  assert.deepStrictEqual(state.programStart1RM,state.oneRM);
  const h=state.programHistory[state.programHistory.length-1];assert.deepStrictEqual(h.sbdPct,{sq:15,bp:6,dl:10});
});
T('letvægts-start: dropper aldrig-nåede øvelser i uge 1–4, men ikke i uge 5+ eller for partner',()=>{
  state.profile='main';
  restartToWeek1({sq:15,bp:6,dl:10},100,true);clear();
  const names=(d,w)=>getExercises(d,w).map(e=>e.name);
  assert(state.lightStart===true);
  for(const w of [1,2,3,4]){
    assert(!names('low1',w).includes('Hack Squat (Machine)')&&!names('low1',w).includes('Cable Crunch')&&!names('low1',w).includes('Box Jump'),'low1 uge '+w);
    assert(!names('bb1',w).includes('Smith Machine Row'));
    assert(!names('low2',w).includes('Hip Adduction (Machine)')&&!names('low2',w).includes('Cable Crunch'));
    assert(!names('bb2',w).includes('Neutral Grip Pulldown')&&!names('bb2',w).includes('Overhead Triceps Ext. (Cable) — Let'));
  }
  assert(names('low1',1).includes('Leg Extension (Machine)')&&names('low1',1).includes('Squat'));
  assert(names('low1',5).includes('Hack Squat (Machine)')&&names('low1',5).includes('Box Jump'),'uge 5 uændret');
  state.profile='partner';clear();
  assert(names('low1',1).includes('Hack Squat (Machine)'),'partner uændret');
  state.profile='main';clear();
});
T('letvægts-start slås fra når fravalgt',()=>{
  state.profile='main';restartToWeek1({sq:0,bp:0,dl:0},100,false);clear();
  assert(!state.lightStart);assert(getExercises('low1',1).some(e=>e.name==='Hack Squat (Machine)'));
});
T('autoreg: samme øvelse samme dag erstattes, ikke dobbelt-tælles',()=>{
  state.profile='main';const as=aState();as.autoregAdj={};as.totalDays=9;
  saveAutoregAdjustment('Squat',-0.03,90);saveAutoregAdjustment('Squat',0,90);
  assert.equal(getSessionHistory('Squat').length,1);assert.equal(getSessionHistory('Squat')[0].pct,0);
  as.totalDays=10;saveAutoregAdjustment('Squat',-0.05,90);assert.equal(getSessionHistory('Squat').length,2);
});
console.log(`\n${ok} ok, ${bad} fejl`);process.exit(bad?1:0);
