// Kører alle node-tests i tests/ og summerer. Ingen netværk, ingen hemmeligheder (sync testes mod kildekoden i sync-worker/worker.js).
const {spawnSync}=require('child_process'),fs=require('fs'),path=require('path');
let fail=0;
for(const f of fs.readdirSync(__dirname).filter(x=>x.endsWith('.test.js')).sort()){
  const r=spawnSync('node',[path.join(__dirname,f)],{encoding:'utf8',cwd:path.join(__dirname,'..')});
  const ok=r.status===0; if(!ok)fail++;
  console.log((ok?'PASS ':'FAIL ')+f); if(!ok)console.log((r.stdout+r.stderr).slice(-1500));
}
console.log(fail?fail+' testfil(er) fejlede':'Alle testfiler bestået'); process.exit(fail?1:0);
