// Kør: node tests/dashboard-skema.test.js — 'Ikke mulig'-knapper påvirker kun styrke, aldrig løb
const fs=require('fs'),assert=require('assert');
const s=fs.readFileSync(require('path').join(__dirname,'..','index.html'),'utf8');
const mem={};global.localStorage={getItem:k=>k in mem?mem[k]:null,setItem:(k,v)=>mem[k]=String(v)};
const cut=(a,b)=>s.slice(s.indexOf(a),s.indexOf(b,s.indexOf(a)));
let code=cut('const OLIVER_PATTERN','// Morgen-påmindelse')
 +'\n'+cut('function blockedDatesKey','function toggleBlockedDate')+'\n'+cut('function catchupDatesKey','function toggleCatchupDate')
 +'\n'+cut('function slotForDate','function sbdCompletedByDate')+'\n'+s.match(/function localISO[^\n]*\n/)[0];
require('vm').runInThisContext(code+';globalThis.__t={slotForDate,OLIVER_PATTERN}');
const {slotForDate,OLIVER_PATTERN}=globalThis.__t;
const len=OLIVER_PATTERN.length, anchor='2026-10-01';
const day=n=>{const d=new Date('2026-10-01T12:00:00');d.setDate(d.getDate()+n);return localISO(d)};
const lobSeq=()=>Array.from({length:14},(_,i)=>JSON.stringify(slotForDate(day(i),anchor,'oliver').lob));
const sbdSeq=()=>Array.from({length:14},(_,i)=>!!slotForDate(day(i),anchor,'oliver').sbd);
const base_l=lobSeq(), base_s=sbdSeq();
// blokér dag 3
mem['dash_blocked_dates_oliver']=JSON.stringify([day(3)]);
assert.deepStrictEqual(lobSeq(),base_l,'løb uændret ved ryk');
assert.strictEqual(slotForDate(day(3),anchor,'oliver').sbd,null,'sbd tom på blokeret dag');
assert.notDeepStrictEqual(sbdSeq(),base_s,'sbd er rykket');
// indhent dag 3
mem['dash_blocked_dates_oliver']='[]'; mem['dash_catchup_dates_oliver']=JSON.stringify([day(3)]);
assert.deepStrictEqual(lobSeq(),base_l,'løb uændret ved indhent');
assert.strictEqual(slotForDate(day(3),anchor,'oliver').sbd,null);
// uden knapper = oprindeligt
mem['dash_catchup_dates_oliver']='[]';
assert.deepStrictEqual(lobSeq(),base_l); assert.deepStrictEqual(sbdSeq(),base_s);
// styrke efter blokeret dag er rykket præcis én slot
mem['dash_blocked_dates_oliver']=JSON.stringify([day(3)]);
const orig=Array.from({length:14},(_,i)=>OLIVER_PATTERN[i%len].sbd);
for(let i=4;i<10;i++){ assert.strictEqual(!!slotForDate(day(i),anchor,'oliver').sbd,!!orig[i-1],'dag '+i); }
// Ellen: lob altid null i mønster
assert.strictEqual(slotForDate(day(5),anchor,'ellen').lob,null);
console.log('OK');
