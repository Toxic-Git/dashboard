// De tre debug-runder (statisk/semantisk). Kør: node tests/debug-rounds.js   — exit 1 ved fund.
const fs = require('fs'), path = require('path'), vm = require('vm');
const R = p => path.join(__dirname, '..', p); const read = p => fs.readFileSync(R(p), 'utf8');
const pages = ['index.html', 'sbd/index.html', 'lob/index.html'], libs = ['tp-core.js', 'tp-sync.js', 'tp-plan.js', 'tp-report.js', 'tp-ui.js', 'ds.js', 'sw.js', 'sbd/sw.js', 'lob/sw.js', 'sync-worker/worker.js'];
const inline = p => [...read(p).matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
let bad = 0; const F = (round, msg) => { bad++; console.log('  FUND [' + round + '] ' + msg); };

console.log('Runde 1 — logik/runtime, Safari-kompatibilitet');
const sources = {}; libs.forEach(f => sources[f] = read(f)); pages.forEach(p => sources[p] = inline(p));
const FORBID = [[/\.replaceAll\(/, 'replaceAll'], [/\bstructuredClone\(/, 'structuredClone'], [/Object\.hasOwn\(/, 'Object.hasOwn'], [/\.at\(-?\d/, 'Array.at'], [/\bawait\b[^\n]*\n/, null]];
Object.keys(sources).forEach(f => {
  const src = sources[f].replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  FORBID.slice(0, 4).forEach(([re, n]) => { if (re.test(src)) F(1, f + ' bruger ' + n); });
  try { new Function(f === 'sync-worker/worker.js' ? sources[f].replace('export default', 'var _d =') : sources[f]); } catch (e) { F(1, f + ' syntaksfejl: ' + e.message); }
  // top-level await: kun tilladt i async-funktion — tjek ved at kompilere som script (ikke async)
  if (f !== 'sync-worker/worker.js') { try { new vm.Script(sources[f]); } catch (e) { F(1, f + ' kompilerer ikke som klassisk script (top-level await?): ' + e.message); } }
  // dublerede top-level function-deklarationer
  const names = {}; for (const m of sources[f].matchAll(/^(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/gm)) names[m[1]] = (names[m[1]] || 0) + 1;
  Object.keys(names).filter(n => names[n] > 1).forEach(n => F(1, f + ': function ' + n + ' defineret ' + names[n] + '×'));
});
const must = { 'index.html': ['hybBuild', 'hybDetail', 'renderHybridLoad', 'hybApplyOption'], 'sbd/index.html': ['syncPush', 'syncEnabled'], 'lob/index.html': ['syncPush', 'syncEnabled', 'detectPlanGap', 'applyPlanAdjustment', 'saveSyncToken'] };
Object.keys(must).forEach(p => must[p].forEach(fn => { if (!new RegExp('function\\s+' + fn + '\\s*\\(').test(sources[p])) F(1, p + ': ' + fn + ' mangler'); }));
// matematik: simulér kritiske funktioner
const P = require(R('tp-plan.js')), TP = require(R('tp-core.js'));
const chk = (c, m) => { if (!c) F(1, m); };
chk(P.classifyRun({ distanceKm: 0, avgHR: 0 }, {}).kind === 'unknown', 'classifyRun(0 km, ingen puls)'); chk(!P.classifyRun({}, undefined).hard, 'classifyRun({})');
chk(P.phaseFor({ seasonStart: '2026-10-05' }, '2026-10-05').phase === 'Base', 'phaseFor uge 1'); chk(P.sbdFlags(undefined).lower === false, 'sbdFlags(undefined)');
chk(TP.addDays('2026-10-25', 1) === '2026-10-26' && TP.addDays('2026-03-28', 1) === '2026-03-29', 'addDays over sommertid'); chk(TP.diffDays('2026-10-24', '2026-10-26') === 2, 'diffDays over vintertid');

console.log('Runde 2 — state, handlere, CSS-variabler');
pages.forEach(p => {
  const html = read(p), all = sources[p] + '\n' + libs.filter(l => /^tp-|^ds\.js/.test(l)).map(l => sources[l]).join('\n');
  const handlers = new Set(); for (const m of html.matchAll(/\bon(?:click|input|change|submit|keydown)\s*=\s*"([^"]*)"/g)) for (const c of m[1].matchAll(/(?:^|[;\s(!])([A-Za-z_$][\w$]*)\s*\(/g)) handlers.add(c[1]);
  // handlere genereret i template-strenge i scripts
  for (const m of sources[p].matchAll(/on(?:click|change|input)=\\?"([A-Za-z_$][\w$.]*)\(/g)) handlers.add(m[1].split('.')[0]);
  const builtin = new Set(['if', 'event', 'this', 'return', 'document', 'window', 'confirm', 'alert', 'stopPropagation', 'preventDefault', 'getElementById', 'querySelector', 'setTimeout', 'Number', 'String', 'parseInt', 'parseFloat', 'JSON', 'location', 'history', 'Math', 'localStorage', 'open', 'focus', 'click']);
  handlers.forEach(h => { if (builtin.has(h)) return; if (!new RegExp('(function\\s+' + h + '\\s*\\(|(?:const|let|var)\\s+' + h + '\\b|window\\.' + h + '\\s*=|\\b' + h + '\\s*[:=]\\s*(?:async\\s*)?(?:function|\\())').test(all)) F(2, p + ': handler ' + h + '() har ingen definition'); });
  const defined = new Set([...(html.match(/^\s*:root\s*\{[\s\S]*?\n\}/m) || [''])[0].matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1])); for (const m of read('ds.css').matchAll(/(--[\w-]+)\s*:/g)) defined.add(m[1]);
  for (const m of html.matchAll(/\bvar\((--[\w-]+)(?:\s*,[^)]*)?\)/g)) { if (!defined.has(m[1]) && !/var\(--[\w-]+\s*,/.test(m[0])) F(2, p + ': CSS-variabel ' + m[1] + ' ikke defineret i :root/ds.css (og uden fallback)'); }
});
// state-felter i defaults: meta
const dm = TP.defaultMeta(); ['planChanges', 'dismissed', 'goalPriority', 'reports', 'tombs', 'dismissTombs', 'cal'].forEach(k => { if (!(k in dm)) F(2, 'defaultMeta mangler ' + k); });

console.log('Runde 3 — dybe flows og null-guards');
// getElementById(...).X uden guard i NY kode (tp-sync/tp-ui) og i de nye dashboard-/løbeblokke
['tp-sync.js', 'tp-ui.js', 'tp-plan.js', 'tp-report.js'].forEach(f => {
  sources[f].split('\n').forEach((ln, i) => { if (/getElementById\([^)]*\)\s*\.\s*(style|innerHTML|textContent|value|classList|appendChild|parentNode|setAttribute)\b/.test(ln)) F(3, f + ':' + (i + 1) + ' getElementById(..).X uden guard'); });
});
// kantfald for formatering/beregning
chk(TP.hash('') !== undefined && TP.hash(null) !== undefined, 'hash(tom/null) kaster ikke'); chk(TP.canon({ b: 1, a: [2, { d: 1, c: 2 }] }) === TP.canon({ a: [2, { c: 2, d: 1 }], b: 1 }), 'canon er ikke rækkefølge-uafhængig');
try { TP.summarize('lob_state', { runs: 'x', profile: 5 }); TP.summarize('sbd_state', { completedDays: 'x' }); TP.summarize('tp_meta_main', { planChanges: 5 }); } catch (e) { F(3, 'summarize kaster på korrupt input: ' + e.message); }
try { P.analyze(P.buildDays({ from: '2026-10-26', days: 3, changes: 'ikke-liste', plannedFn: () => [{ id: 'x', kind: 'run', status: 'planned', hard: true }], doneFn: () => [] }), {}); } catch (e) { F(3, 'analyze/buildDays kaster på ugyldige input: ' + e.message); }
const TPSYNC = require(R('tp-sync.js')); const st = (m => ({ getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: k => { delete m[k]; } }))({ sbd_state: '{ikke json', lob_state: 'null' });
try { const e = TPSYNC.create({ storage: st, fetch: async () => { throw new TypeError('x'); }, baseUrl: 'https://x.test', getToken: () => '' }); e.status(); e.isDirty('sbd_state'); e.conflicts(); } catch (e) { F(3, 'synkmotor kaster på korrupt lager: ' + e.message); }
console.log(bad ? '\n' + bad + ' fund' : '\nAlle tre runder rene'); process.exit(bad ? 1 : 0);
