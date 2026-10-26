// Service workers må ikke cache/besvare synk-Workerens svar (/kv/…, /version på andet origin). Kør: node tests/sw-sync.test.js
// (Playwrights route() når ikke service workers, så dette testes som enhedstest af SW-koden i et stub-miljø.)
const fs = require('fs'), vm = require('vm'), path = require('path'), assert = require('assert');
let ok = 0, bad = 0;
const T = (n, f) => { try { f(); ok++; console.log('  ok   ' + n); } catch (e) { bad++; console.log('  FEJL ' + n + '\n       ' + e.message); } };
function load(file) {
  const handlers = {}; const self = { location: { origin: 'https://app.example' }, addEventListener: (t, f) => { handlers[t] = f; }, skipWaiting() {}, clients: { claim() {} }, registration: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), { self, caches: { open: async () => ({ addAll: async () => {}, put: async () => {} }), keys: async () => [], match: async () => null, delete: async () => {} }, fetch: async () => ({ clone() { return {}; } }), URL, setTimeout, Promise, console, Notification: {} });
  return handlers.fetch;
}
const fire = (h, url, method) => { let responded = false; h({ request: { url, method: method || 'GET' }, respondWith() { responded = true; } }); return responded; };
['sw.js', 'sbd/sw.js', 'lob/sw.js'].forEach(f => {
  const h = load(f);
  T(f + ': synk-kald (andet origin) caches ikke og besvares ikke fra cache', () => {
    assert.strictEqual(fire(h, 'https://sync.example.workers.dev/kv/sbd_state'), false); assert.strictEqual(fire(h, 'https://sync.example.workers.dev/version'), false);
  });
  T(f + ': egne filer og skrifttyper håndteres stadig (offline-fallback bevaret)', () => {
    assert.strictEqual(fire(h, 'https://app.example/ds.css'), true); assert.strictEqual(fire(h, 'https://fonts.googleapis.com/css2?family=Barlow'), true);
  });
});
console.log(`\n${bad ? bad + ' FEJL, ' : ''}${ok} ok`); process.exit(bad ? 1 : 0);
