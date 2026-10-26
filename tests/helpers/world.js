// Testhjælper: en "verden" med en rigtig Worker-kildekode (sync-worker/worker.js eller v1-fixture) kørt i Node
// mod en in-memory KV + flere "enheder" (egen storage + egen sync-motor). INGEN netværk, INGEN rigtige data/tokens.
// Bemærk: dette er en integrationstest af Worker-KODEN, ikke af Cloudflares runtime (se tests/worker-local.js for workerd).
const fs = require('fs'), path = require('path');
const TP = require('../../tp-core.js'), TPSYNC = require('../../tp-sync.js');

function loadWorker(file) {
  const src = fs.readFileSync(file, 'utf8').replace('export default', 'module.exports =');
  const m = { exports: {} }; new Function('module', src)(m); return m.exports;
}
function mem(init) {
  const m = Object.assign({}, init || {}); const o = { _m: m, failWrites: false };
  o.getItem = k => (k in m ? m[k] : null);
  o.setItem = (k, v) => { if (o.failWrites) throw new Error('QuotaExceededError'); m[k] = String(v); };
  o.removeItem = k => { delete m[k]; };
  return o;
}
class KV { constructor() { this.m = {}; } async get(k) { return k in this.m ? this.m[k] : null; } async put(k, v) { this.m[k] = v; } }

function world(opts) {
  opts = opts || {};
  const worker = loadWorker(opts.workerFile || path.join(__dirname, '..', '..', 'sync-worker', 'worker.js'));
  const kv = new KV(); const env = opts.legacyBinding ? { KV: kv } : { TRAINING_KV: kv }; if (opts.token) env.SYNC_TOKEN = opts.token; // legacyBinding = den eksisterende produktions-Workers binding (KV, nøgler som "kv:<nøgle>")
  const W = { kv, env, worker, calls: [], devices: {} };
  W.record = (key) => { const r = kv.m[opts.legacyBinding ? 'kv:' + key : key]; return r ? JSON.parse(r) : null; };
  W.device = function (name, init) {
    const storage = mem(init); const dev = { name, storage, offline: false, token: opts.clientToken === undefined ? opts.token : opts.clientToken, clock: 1000 };
    const fetchFn = async (url, init2) => {
      init2 = init2 || {};
      W.calls.push({ dev: name, method: init2.method || 'GET', path: url.replace('https://sync.test', ''), hasAuth: !!(init2.headers && init2.headers.Authorization), body: init2.body });
      if (dev.offline) throw new TypeError('Failed to fetch');
      const req = new Request(url, { method: init2.method || 'GET', headers: init2.headers, body: init2.body });
      return worker.fetch(req, env);
    };
    dev.engine = TPSYNC.create({ storage, fetch: fetchFn, baseUrl: 'https://sync.test', getToken: () => dev.token || '', now: () => (dev.clock += 1000) });
    W.devices[name] = dev; return dev;
  };
  return W;
}
const J = o => JSON.stringify(o);
const sbdState = (n, extra) => Object.assign({ totalDays: n, logs: {}, completedDays: Array.from({ length: n }, (_, i) => i + 1), oneRM: { sq: 100, bp: 80, dl: 150 }, profile: 'main' }, extra || {});
const lobState = (n, extra) => Object.assign({ profile: { navn: 'T', onboarded: true, goals: [] }, runs: Array.from({ length: n }, (_, i) => ({ id: 'r' + i, date: '2026-09-' + String(i + 1).padStart(2, '0'), distanceKm: 5, durationSec: 1800 })) }, extra || {});
module.exports = { world, mem, J, sbdState, lobState, TP, TPSYNC, loadWorker };
