const fs=require('fs'),vm=require('vm'),assert=require('assert'),path=require('path');
// Kør: node tests/sbd-varianter.test.js  (fra repo-roden eller tests/)
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
const L='Lateral Raise (Machine)',LL=L+' — Let',TR='Overhead Triceps Ext. (Cable)',TRL=TR+' — Let',LC='Seated Leg Curl (Machine)',LCV=LC+' — Volumen';
const get=(day,wk,prof)=>{state.profile=prof;_exercisesCache&&Object.keys(_exercisesCache).forEach(k=>delete _exercisesCache[k]);return getExercises(day,wk).filter(e=>e.type==='acc');};
for(const prof of ['main','partner']){
  T(`[${prof}] navne pr. dag`,()=>{
    const names=d=>get(d,2,prof).map(e=>e.name);
    assert(names('cst1').includes(L)&&!names('cst1').includes(LL));
    assert(names('low2').includes(LL)&&!names('low2').includes(L));
    assert(names('low1').includes(LC)&&names('low2').includes(LCV)&&!names('low2').includes(LC));
    assert(names('cst1').includes(TR)&&names('bb2').includes(TRL)&&!names('bb2').includes(TR));
  });
  T(`[${prof}] let-varianter periodiseres ikke (2 sæt × 8–12 alle blokke, også deload-skalering)`,()=>{
    for(const wk of [1,2,3,5,6,9,10]){
      const l=get('low2',wk,prof).find(e=>e.name===LL).scheme;
      const t=get('bb2',wk,prof).find(e=>e.name===TRL).scheme;
      if(!isDeload(wk)){assert.equal(l.sets,2,'lat uge '+wk);assert.equal(l.repsRange,'8–12');assert.equal(t.sets,2,'tri uge '+wk);assert.equal(t.repsRange,'8–12');}
      else{assert(l.sets<=2&&t.sets<=2);}
    }
  });
  T(`[${prof}] tunge varianter periodiseres stadig (3 sæt, rep-range skifter med blok)`,()=>{
    const r=wk=>get('cst1',wk,prof).find(e=>e.name===L).scheme.repsRange;
    assert.equal(r(1),'10–12');assert.equal(r(5),'8–10');assert.equal(r(9),'6–8');
    const t=wk=>get('cst1',wk,prof).find(e=>e.name===TR).scheme.repsRange; assert.equal(t(1),'4–6');
  });
  T(`[${prof}] vægte uændrede (kg fra skabelon)`,()=>{
    const m=prof==='main'?{l:135,ll:50,t:29.65,tl:20,c:87.5,cv:82.5}:{l:50,ll:20,t:12,tl:8,c:35,cv:30};
    assert.equal(get('cst1',2,prof).find(e=>e.name===L).scheme.kg,m.l);
    assert.equal(get('low2',2,prof).find(e=>e.name===LL).scheme.kg,m.ll);
    assert.equal(get('cst1',2,prof).find(e=>e.name===TR).scheme.kg,m.t);
    assert.equal(get('bb2',2,prof).find(e=>e.name===TRL).scheme.kg,m.tl);
    assert.equal(get('low1',2,prof).find(e=>e.name===LC).scheme.kg,m.c);
    assert.equal(get('low2',2,prof).find(e=>e.name===LCV).scheme.kg,m.cv);
  });
  T(`[${prof}] ingen øvelsesnavn deles på tværs af dage med forskellig rolle`,()=>{
    const seen={};
    ['cst1','low1','bb1','cst2','low2','bb2'].forEach(d=>get(d,2,prof).forEach(e=>{(seen[e.name]=seen[e.name]||[]).push(d+':'+e.scheme.sets+'x'+e.scheme.repsRange+'@'+e.scheme.kg);}));
    const dup=Object.entries(seen).filter(([n,a])=>a.length>1&&new Set(a.map(x=>x.split(':')[1])).size>1);
    assert.deepStrictEqual(dup,[],JSON.stringify(dup));
  });
}
T('migration: logs flyttes efter programdag (inkl. dayOverrides)',()=>{
  const ex=n=>({name:n,sets:[{kg:'50',reps:'10',done:true}]});
  const as={dayOverrides:{9:6}, logs:{ day0:{exercises:[ex(L),ex(TR),ex(LC)]}, day6:{exercises:[ex(L),ex(LC),ex(TR)]}, day7:{exercises:[ex(TR),ex(L)]}, day8:{exercises:[ex(L)]}, day9:{exercises:[ex(L)]}, day14:{exercises:[ex(LC),ex(L)]} },
    autoregAdj:{[L]:{sessions:[{kg:135,pct:.02,day:0},{kg:50,pct:-.02,day:6},{kg:135,pct:.0,day:8},{kg:50,pct:.04,day:14}]}, [TR]:{sessions:[{kg:29,pct:.02,day:0},{kg:20,pct:.03,day:7}]}, [LC]:{sessions:[{kg:87.5,pct:0,day:1},{kg:82.5,pct:.02,day:6}]}}};
  migrateVariantNames(as);
  const n=d=>as.logs['day'+d].exercises.map(e=>e.name);
  assert.deepStrictEqual(n(0),[L,TR,LC]);            // cst1: urørt
  assert.deepStrictEqual(n(6),[LL,LCV,TR]);          // low2: lat+curl ændret, triceps urørt
  assert.deepStrictEqual(n(7),[TRL,L]);              // bb2: triceps let; lat urørt
  assert.deepStrictEqual(n(8),[L]);                  // cst1 (8%8=0)
  assert.deepStrictEqual(n(9),[LL]);                 // override → low2
  assert.deepStrictEqual(n(14),[LCV,LL]);            // 14%8=6 low2
  assert.deepStrictEqual(as.autoregAdj[L].sessions.map(s=>s.day),[0,8]);
  assert.deepStrictEqual(as.autoregAdj[LL].sessions.map(s=>s.day),[6,14]);
  assert.deepStrictEqual(as.autoregAdj[TR].sessions.map(s=>s.day),[0]);
  assert.deepStrictEqual(as.autoregAdj[TRL].sessions.map(s=>s.day),[7]);
  assert.deepStrictEqual(as.autoregAdj[LC].sessions.map(s=>s.day),[1]);
  assert.deepStrictEqual(as.autoregAdj[LCV].sessions.map(s=>s.day),[6]);
});
T('migration er idempotent og tåler tom/ufuldstændig state',()=>{
  const as={logs:{day6:{exercises:[{name:L,sets:[]}]}},autoregAdj:{[L]:{sessions:[{kg:50,pct:0,day:6}]}}};
  migrateVariantNames(as);const a=JSON.stringify(as);migrateVariantNames(as);assert.equal(JSON.stringify(as),a);
  migrateVariantNames({});migrateVariantNames(null);migrateVariantNames({logs:{dayx:{},day3:null,day4:{exercises:null}},autoregAdj:{[L]:{pct:.1}}});
});
T('historik adskilles: sidste præstation/historik for tung vs let',()=>{
  state.profile='main';
  state.completedDays=[0,6,8];
  state.logs={day0:{exercises:[{name:L,sets:[{kg:'135',reps:'10',done:true}]}]},day6:{exercises:[{name:LL,sets:[{kg:'50',reps:'10',done:true}]}]},day8:{exercises:[{name:L,sets:[{kg:'140',reps:'9',done:true}]}]}};
  assert.equal(getLastPerformance(L).kg,140);          // tung: seneste tunge session
  assert.equal(getLastPerformance(LL).kg,50);          // let: ikke 140/135
  assert.deepStrictEqual(getExerciseHistory(L).map(h=>h.day),[8,0]);
  assert.deepStrictEqual(getExerciseHistory(LL).map(h=>h.day),[6]);
  assert.equal(getLastPerformance(L+' — Backdown'),null);
});
T('MUSCLE_MAP kender de nye navne (SBD + dashboard)',()=>{
  assert.equal(MUSCLE_MAP[LL],'Skulder');assert.equal(MUSCLE_MAP[TRL],'Triceps');assert.equal(MUSCLE_MAP[LCV],'Post. Chain');
  const d=fs.readFileSync(R('index.html'),'utf8');
  [LL,TRL,LCV].forEach(n=>assert(d.includes("'"+n+"'"),n));
});
console.log(bad?`\n${bad} FEJL`:`\nAlle ${ok} tests bestået`);process.exit(bad?1:0);
