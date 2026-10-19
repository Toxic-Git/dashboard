// Kør: node tests/dashboard-lobplan.test.js — forkortelse af løbeforslag til dashboardet
const fs=require('fs'),assert=require('assert'),path=require('path');
const s=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
const i=s.indexOf('function shortPlanText'), j=s.indexOf('function readLob');
require('vm').runInThisContext(s.slice(i,j)+';globalThis.f=shortPlanText');
assert.strictEqual(f('~3 km (~31:56)'),'~3 km (~31:56)');
assert.strictEqual(f('~8 km (~45:00) (10-20% over din længste seneste lette tur på 7 km).'),'~8 km (~45:00)');
assert.strictEqual(f('~9 km (~50:10) i alt for økten.'),'~9 km (~50:10)');
assert.strictEqual(f('5:40/km (øvre ende af let tempo — hold det jævnt, ikke accelererende).'),'5:40/km');
assert.strictEqual(f('Målrace-tempo: 5:00/km — det er det tempo intervallerne ovenfor skal ramme.'),'5:00/km');
assert.strictEqual(f('11:51/km–9:27/km'),'11:51/km–9:27/km');
assert.strictEqual(f(null),''); assert(f('x'.repeat(200)).length<=70);
console.log('OK');
