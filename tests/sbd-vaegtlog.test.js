const fs=require('fs'),vm=require('vm'),assert=require('assert'),path=require('path');
// Kør: node tests/sbd-vaegtlog.test.js  (fra repo-roden eller tests/)
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
const mk=(sets,extra)=>Object.assign({name:'Squat',plannedKg:80,sets:Array.from({length:sets},()=>({kg:80,reps:5,done:false}))},extra||{});
T('opvarmning: ændring logges med fase og tidspunkt',()=>{
  const e=mk(3); assert(recordWeightChange(e,75,1000));
  assert.deepStrictEqual(e.weightChanges,[{at:1000,from:80,to:75,phase:'opvarmning'}]);
  assert.equal(e.plannedKg,80,'planlagt vægt må aldrig ændres');
});
T('tastning 8 → 80 → 82 slås sammen til én post (samme fase)',()=>{
  const e=mk(3); recordWeightChange(e,8,1); recordWeightChange(e,82,2);
  assert.equal(e.weightChanges.length,1); assert.equal(e.weightChanges[0].to,82); assert.equal(e.weightChanges[0].from,80);
});
T('tilbage til udgangspunktet i samme fase fjerner posten',()=>{
  const e=mk(3); recordWeightChange(e,75,1); recordWeightChange(e,80,2);
  assert.equal(e.weightChanges.length,0);
});
T('uændret vægt og ugyldige værdier logger intet',()=>{
  const e=mk(3); assert.equal(recordWeightChange(e,80,1),false); assert.equal(recordWeightChange(e,'',1),false);
  assert.equal(recordWeightChange(e,'abc',1),false); assert.equal(recordWeightChange(e,0,1),false); assert.equal(recordWeightChange(e,-5,1),false);
  assert.equal(recordWeightChange(null,75,1),false); assert.equal((e.weightChanges||[]).length,0);
});
T('efter gennemført sæt: ny fase "efter sæt N" (separat post fra opvarmning)',()=>{
  const e=mk(3); recordWeightChange(e,75,1); e.sets[0].done=true; recordWeightChange(e,77.5,2);
  assert.deepStrictEqual(e.weightChanges.map(c=>[c.from,c.to,c.phase]),[[80,75,'opvarmning'],[75,77.5,'efter sæt 1']]);
  e.sets[1].done=true; recordWeightChange(e,80,3);
  assert.equal(e.weightChanges[2].phase,'efter sæt 2');
});
T('appens eget RPE-forslag (suggestedKg) er udgangspunktet — ikke planlagt vægt',()=>{
  const e=mk(3,{suggestedKg:82.5}); assert.equal(recordWeightChange(e,82.5,1),false,'at acceptere forslaget er ingen ændring');
  assert(recordWeightChange(e,80,2)); assert.equal(e.weightChanges[0].from,82.5);
});
T('uden udgangspunkt (ingen plan, intet forslag) logges intet',()=>{
  const e=mk(3,{plannedKg:null}); assert.equal(recordWeightChange(e,70,1),false);
});
T('ensurePlannedKg: gamle logs får plan fra skabelon, eksisterende ændres ikke',()=>{
  const old={name:'Squat',sets:[]}; assert.equal(ensurePlannedKg(old,{scheme:{kg:100}}),100);
  assert.equal(ensurePlannedKg(old,{scheme:{kg:90}}),100,'låst');
  const none={name:'X'}; assert.equal(ensurePlannedKg(none,null),null);
});
T('weightChangeNote: tom uden ændring, ellers plan + ændringer',()=>{
  assert.equal(weightChangeNote(mk(3)),''); assert.equal(weightChangeNote(null),'');
  const e=mk(3); recordWeightChange(e,75,1);
  assert.equal(weightChangeNote(e),'Planlagt 80 kg · 80 → 75 kg (opvarmning)');
});
T('skift af øvelse nulstiller vægtlog (ingen sammenligning på tværs af øvelser)',()=>{
  const st={logs:{day1:{exercises:[mk(3,{suggestedKg:82,weightChanges:[{at:1,from:80,to:75,phase:'opvarmning'}],warmupKg:75})]}}};
  const r=TP.switchLogExercise(st,'day1',0,'Squat','Box Squat','session',5);
  assert(r.ok); const e=st.logs.day1.exercises[0];
  assert.equal(e.plannedKg,null); assert.equal(e.weightChanges,undefined); assert.equal(e.suggestedKg,undefined); assert.equal(e.warmupKg,undefined);
});
T('kildekode: log-oprettelse, input, toggleSet og eksport er koblet på',()=>{
  assert(/plannedKg:\s*ex\.scheme\.kg \|\| null/.test(h),'plannedKg ved log-oprettelse');
  assert(/onchange="commitWorkingKg\(\$\{ei\}, this\.value\)"/.test(h),'onchange på arbejdsvægt');
  assert(/function toggleSet[\s\S]*?recordWeightChange\(lx, lx\.warmupKg/.test(h),'toggleSet lukker ventende ændring');
  assert(/weightChanges: ex\.weightChanges \|\| \[\]/.test(h)&&/topSetDeltaKg/.test(h),'eksport');
});
console.log(bad?`\n${bad} FEJL`:`\nAlle ${ok} tests bestået`);process.exit(bad?1:0);
