/* End-to-end funktionstest (Playwright + Chromium) af dashboard, SBD og løb.
   - Bruger SYNTETISKE data (e2e/fixtures/demo.json) seedet i en ny, tom browserprofil pr. test.
   - Rører aldrig rigtige data: hver test kører i en frisk browser-kontekst, og alle kald til sync-Workeren
     opfanges og besvares af en mock (der sendes intet ud på nettet).
   Kør:  npm i && node e2e/e2e.js     (miljøvariabel: BROWSER=chromium|firefox|webkit, default chromium)
   Resultat: konsol-tabel + e2e/results.json                                                          */
const fs = require('fs'), path = require('path');
const { start } = require('./server');
const pw = require('playwright');
const demo = require('./fixtures/demo.json');
const BROWSER = process.env.BROWSER || 'chromium';
const launchOpts = { args: ['--no-sandbox'] };
if (process.env.CHROMIUM_PATH) launchOpts.executablePath = process.env.CHROMIUM_PATH;

const results = [];
function rec(area, name, status, detail) {
  results.push({ area, name, status, detail: detail || '' });
  console.log((status === 'PASS' ? '  ✔ ' : status === 'FAIL' ? '  ✘ ' : '  – ') + area + ' · ' + name + (detail ? '  [' + detail + ']' : ''));
}
async function check(area, name, fn) {
  if (process.env.ONLY && !new RegExp(process.env.ONLY).test(area + ' ' + name)) return; // ONLY=regex: kør kun matchende (til hurtig iteration)
  try { const d = await fn(); rec(area, name, 'PASS', typeof d === 'string' ? d : ''); }
  catch (e) { rec(area, name, 'FAIL', String(e.message || e).split('\n').slice(0,3).join(' ').slice(0, 300)); }
}
function eq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((msg || 'ikke ens') + ': ' + JSON.stringify(a) + ' ≠ ' + JSON.stringify(b)); }
function ok(c, msg) { if (!c) throw new Error(msg || 'forventede sand'); }

(async () => {
  const { srv, url } = await start(0);
  const browser = await pw[BROWSER].launch(launchOpts);
  const kv = {};            // mock-KV for sync
  const syncLog = [];       // kald til "Workeren"

  async function newPage(width = 390, height = 844, seed = true) {
    for (const k of Object.keys(kv)) delete kv[k]; // hver test starter med tom mock-server (ingen læk mellem tests)
    const ctx = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'allow' });
    if (seed) await ctx.addInitScript(d => { try { if (!localStorage.getItem('__seeded')) { Object.keys(d).forEach(k => localStorage.setItem(k, JSON.stringify(d[k]))); localStorage.setItem('__seeded', '1'); } } catch (e) {} }, demo);
    await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
    await ctx.route(/workers\.dev|REDACTED-SYNC-WORKER/, async r => {
      const req = r.request(); const m = req.url().match(/\/kv\/([a-z_]+)/);
      syncLog.push({ method: req.method(), key: m && m[1], auth: req.headers()['authorization'] || null });
      if (!m) return r.fulfill({ status: 404, body: '{}' });
      if (req.method() === 'GET') return r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(kv[m[1]] || { value: null }) });
      if (req.method() === 'PUT') { const v = JSON.parse(req.postData()).value; kv[m[1]] = { value: v, updatedAt: Date.now() }; return r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ ok: true, updatedAt: kv[m[1]].updatedAt }) }); }
      return r.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }, body: '' });
    });
    const page = await ctx.newPage();
    page.setDefaultTimeout(8000); page.errors = []; page.on('pageerror', e => page.errors.push(e.message + (process.env.STACK ? ' @ ' + String(e.stack).split('\n')[1] : '')));
    page.ctx = ctx;
    return page;
  }
  const ls = (p, k) => p.evaluate(k => JSON.parse(localStorage.getItem(k)), k);
  const startSession = async p => { await p.click('text=START TRÆNING'); await p.waitForSelector('#kg_0_0'); await p.waitForTimeout(200); };
  const open = async (p, rel) => { await p.goto(url + rel); await p.waitForTimeout(700); };

  /* ───────── PROFILSKIFT & DATAISOLERING ───────── */
  await check('Profilskift', 'Dashboard: Oliver↔Ellen skifter indhold og vender tilbage identisk', async () => {
    const p = await newPage(); await open(p, 'index.html');
    const t = () => p.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
    await p.waitForTimeout(3000); /* dashboardets løbe-prognose hentes asynkront */ const a = await t(); await p.click('#btn-ellen'); await p.waitForTimeout(400); const b = await t();
    eq(await p.getAttribute('#btn-ellen', 'aria-pressed'), 'true');
    await p.click('#btn-oliver'); await p.waitForTimeout(400); const c = await t();
    ok(a !== b, 'indhold skiftede ikke'); const n = Math.min(a.length, c.length, 1400); eq(a.slice(0, n), c.slice(0, n), 'tilbage-visning afviger (første ' + n + ' tegn)'); eq(p.errors, []); await p.ctx.close();
  });
  await check('Profilskift', 'Løb: Ellens historik ≠ Olivers, og logning som Ellen rører kun lob_partner', async () => {
    const p = await newPage(); await open(p, 'lob/index.html');
    const before = { m: await ls(p, 'lob_state'), p: await ls(p, 'lob_partner') };
    await p.click('#btn-partner'); await p.waitForTimeout(400); await p.click('#newrun-card > summary');
    await p.fill('#lg-dist', '3.2'); await p.fill('#lg-tid', '20:00'); await p.click('text=Gem løbetur'); await p.waitForTimeout(500);
    const after = { m: await ls(p, 'lob_state'), p: await ls(p, 'lob_partner') };
    eq(after.m.runs.length, before.m.runs.length, 'Olivers løb ændret af Ellens logning');
    eq(after.p.runs.length, before.p.runs.length + 1, 'Ellens løb ikke gemt');
    eq(after.m.runs, before.m.runs, 'Olivers løbehistorik ændret'); eq(after.m.profile.navn, before.m.profile.navn); // (schema-migrering tilføjer tomme standardfelter ved første gem – ikke datalækage)
    eq(p.errors, []); await p.ctx.close();
  });
  await check('Profilskift', 'SBD: Ellen vælges, logning rører kun sbd_partner, Oliver uændret', async () => {
    const p = await newPage(); await open(p, 'sbd/index.html');
    await p.click('.nav-btn:nth-child(4)'); await p.click('#btn-partner'); await p.waitForTimeout(400);
    eq(await p.getAttribute('#btn-partner', 'aria-pressed'), 'true');
    const m0 = JSON.stringify(await ls(p, 'sbd_state')), p0 = JSON.stringify(await ls(p, 'sbd_partner'));
    await p.click('.nav-btn:nth-child(1)'); await p.waitForTimeout(300);
    const hasSets = await p.locator('.check-btn').count();
    if (hasSets) { await p.locator('.check-btn').first().click(); await p.waitForTimeout(500); }
    const m1 = JSON.stringify(await ls(p, 'sbd_state')), p1 = JSON.stringify(await ls(p, 'sbd_partner'));
    eq(m1, m0, 'Olivers sbd_state ændret under Ellens profil');
    if (hasSets) ok(p1 !== p0, 'Ellens data blev ikke ændret af logning'); else rec('Profilskift', '(note) Ellen har ingen sæt i dag (pausedag) – logning ikke afprøvet', 'SKIP');
    eq(p.errors, []); await p.ctx.close();
  });

  /* ───────── AKTIV STYRKETRÆNING ───────── */
  await check('SBD aktiv træning', 'Registrer, ændr og gennemfør sæt; gemmes og overlever genindlæsning', async () => {
    const p = await newPage(); await open(p, 'sbd/index.html');
    await startSession(p);
    await p.fill('#kg_0_0', '112.5'); await p.dispatchEvent('#kg_0_0', 'change');
    await p.fill('#reps_0_0', '4'); await p.dispatchEvent('#reps_0_0', 'change');
    await p.click('#chk_0_0'); await p.waitForTimeout(600);
    eq(await p.getAttribute('#chk_0_0', 'aria-pressed'), 'true', 'sæt ikke markeret gennemført');
    await p.click('.timer-skip'); await p.waitForTimeout(300);
    await p.click('#chk_0_0'); await p.waitForTimeout(400);            // fortryd
    eq(await p.getAttribute('#chk_0_0', 'aria-pressed'), 'false', 'fortryd virkede ikke');
    await p.click('#chk_0_0'); await p.waitForTimeout(400); await p.click('.timer-skip');       // gennemfør igen
    await p.reload(); await p.waitForTimeout(800);
    eq(await p.inputValue('#kg_0_0'), '112.5'); eq(await p.inputValue('#reps_0_0'), '4');
    eq(await p.getAttribute('#chk_0_0', 'aria-pressed'), 'true', 'gennemført-status mistet efter reload');
    eq(p.errors, []); await p.ctx.close();
  });
  await check('RPE', 'Decimaler (7.5) kan indtastes, gemmes og genindlæses; feltbredde ≥ 60 px på mobil', async () => {
    const p = await newPage(360); await open(p, 'sbd/index.html');
    await startSession(p);
    const w = await p.evaluate(() => document.querySelector('.rpe-input').getBoundingClientRect().width);
    ok(w >= 60, 'RPE-bredde ' + w);
    await p.fill('#rpe_0_0', '7.5'); await p.dispatchEvent('#rpe_0_0', 'change'); await p.waitForTimeout(300);
    await p.reload(); await p.waitForTimeout(800);
    eq(await p.inputValue('#rpe_0_0'), '7.5');
    const st = await p.evaluate(() => { const k = Object.keys(JSON.parse(localStorage.sbd_state).logs).pop(); return JSON.parse(localStorage.sbd_state).logs[k].exercises[0].sets[0].rpe; });
    ok(String(st) === '7.5', 'gemt rpe=' + st); eq(p.errors, []); await p.ctx.close(); return 'bredde ' + Math.round(w) + ' px';
  });
  await check('Pausetimer', 'Starter ved gennemført sæt, tæller ned, +1 min, lukker (Spring over)', async () => {
    const p = await newPage(); await open(p, 'sbd/index.html');
    await startSession(p); await p.click('#chk_0_0'); await p.waitForTimeout(400);
    ok(await p.locator('#timer-overlay.open').count() === 1, 'overlay åbnede ikke');
    const t1 = await p.innerText('#timer-display'); await p.waitForTimeout(2300); const t2 = await p.innerText('#timer-display');
    ok(t1 !== t2, 'nedtælling stod stille: ' + t1 + '→' + t2);
    await p.click('.timer-add'); await p.waitForTimeout(300); const t3 = await p.innerText('#timer-display');
    ok(t3 > t2 || t3.length > t2.length || t3 !== t2, '+1 min virkede ikke');
    await p.click('.timer-skip'); await p.waitForTimeout(300);
    ok(await p.locator('#timer-overlay.open').count() === 0, 'overlay lukkede ikke'); await p.ctx.close(); return t1 + ' → ' + t2 + ' → (+1 min) ' + t3;
  });
  await check('Pausetimer', 'Pausetimer overlever genindlæsning midt i pause og fortsætter nedtælling; lukket timer genoptages ikke', async () => {
    const p = await newPage(); await open(p, 'sbd/index.html');
    await startSession(p); await p.click('#chk_0_0'); await p.waitForTimeout(400);
    await p.reload(); await p.waitForTimeout(800);
    const open_ = await p.locator('#timer-overlay.open').count();
    if (!open_) throw new Error('timeren genoptages IKKE efter reload');
    const t1 = await p.innerText('#timer-display'); await p.waitForTimeout(2100); const t2 = await p.innerText('#timer-display'); ok(t1 !== t2, 'nedtælling stod stille efter reload: ' + t1);
    await p.click('.timer-skip'); await p.waitForTimeout(300); await p.reload(); await p.waitForTimeout(800);
    eq(await p.locator('#timer-overlay.open').count(), 0, 'lukket timer dukkede op igen'); eq(p.errors, []);
    await p.ctx.close();
  });

  /* ───────── LØB ───────── */
  await check('Løb', 'Registrering gemmes (lob_state) og vises i historikken, også efter reload', async () => {
    const p = await newPage(); await open(p, 'lob/index.html');
    const n0 = (await ls(p, 'lob_state')).runs.length;
    await p.click('#newrun-card > summary'); await p.fill('#lg-dato', '2026-10-20'); await p.fill('#lg-dist', '6.5'); await p.fill('#lg-tid', '34:10');
    await p.fill('#lg-avghr', '150'); await p.click('text=Gem løbetur'); await p.waitForTimeout(500);
    const st = await ls(p, 'lob_state'); eq(st.runs.length, n0 + 1);
    const r = st.runs.find(x => x.date === '2026-10-20'); ok(r && r.distanceKm === 6.5 && r.durationSec === 2050, 'forkerte felter ' + JSON.stringify(r));
    let hist = await p.innerText('#run-list'); ok(hist.includes('6.5') && /34:10/.test(hist), 'ikke i historik: ' + hist.slice(0, 80));
    await p.reload(); await p.waitForTimeout(800); hist = await p.innerText('#run-list'); ok(hist.includes('6.5'), 'mistet efter reload');
    eq(p.errors, []); await p.ctx.close(); return 'pace i historik: ' + (hist.match(/\d:\d\d\/km/) || ['?'])[0];
  });
  await check('Løb', 'Ugyldig input viser inline fejl (role=alert) i stedet for alert(), fokus flyttes til feltet', async () => {
    const p = await newPage(); await open(p, 'lob/index.html'); let dialogs = 0; p.on('dialog', d => { dialogs++; d.dismiss(); });
    await p.fill('#lg-dist', '0', {timeout:1500}).catch(()=>{}); await p.click('#newrun-card > summary').catch(()=>{}); await p.fill('#lg-dist', '0'); await p.click('text=Gem løbetur'); await p.waitForTimeout(300);
    ok(await p.isVisible('#lg-error'), 'fejlboks ikke synlig'); eq(await p.getAttribute('#lg-error', 'role'), 'alert');
    eq(await p.evaluate(() => document.activeElement.id), 'lg-dist'); eq(dialogs, 0, 'native alert brugt'); await p.ctx.close();
  });
  await check('Løbetimer', 'Start, pause, genoptag og stop; status og nedtælling opdateres', async () => {
    const p = await newPage(); await open(p, 'lob/index.html'); p.on('dialog', d => d.dismiss());
    await p.click('#tab-timer'); await p.fill('#tm-warmup', '1'); await p.fill('#tm-reps', '2'); await p.fill('#tm-work', '0:30'); await p.fill('#tm-rest', '0:20'); await p.fill('#tm-cooldown', '0');
    await p.click('text=Start session'); await p.waitForTimeout(600);
    ok(await p.isVisible('#timer-run-card'), 'run-kort ikke synligt');
    const c1 = await p.innerText('#tm-countdown'); await p.waitForTimeout(2200); const c2 = await p.innerText('#tm-countdown'); ok(c1 !== c2, 'nedtælling stod stille');
    await p.click('#tm-pause-btn'); const lab1 = await p.innerText('#tm-pause-btn'); const p1 = await p.innerText('#tm-countdown'); await p.waitForTimeout(1600); const p2 = await p.innerText('#tm-countdown');
    eq(p1, p2, 'tæller videre mens pauset'); await p.click('#tm-pause-btn'); const lab2 = await p.innerText('#tm-pause-btn'); ok(lab1 !== lab2, 'knaptekst skiftede ikke');
    await p.waitForTimeout(1300); const p3 = await p.innerText('#tm-countdown'); ok(p3 !== p2, 'genoptog ikke');
    await p.click('#timer-run-card button.danger'); await p.waitForTimeout(400); ok(await p.isVisible('#timer-setup-card'), 'tilbage til setup ikke vist');
    eq(p.errors, []); await p.ctx.close(); return c1 + '→' + c2 + ', pause "' + lab1 + '"→"' + lab2 + '"';
  });

  /* ───────── NAVIGATION OG GENINDLÆSNING ───────── */
  await check('Navigation', 'Løb: alle faner skifter panel, aria-selected følger, data bevares', async () => {
    const p = await newPage(); await open(p, 'lob/index.html'); const n = (await ls(p, 'lob_state')).runs.length;
    for (const k of ['analyse', 'periode', 'timer', 'settings', 'log']) {
      await p.click('#tab-' + k); await p.waitForTimeout(150);
      eq(await p.getAttribute('#tab-' + k, 'aria-selected'), 'true', k); ok(await p.isVisible('#view-' + k), 'panel ' + k + ' ikke synligt');
      eq(await p.locator('[role=tab][aria-selected=true]').count(), 1);
    }
    eq((await ls(p, 'lob_state')).runs.length, n); eq(p.errors, []); await p.ctx.close();
  });
  await check('Navigation', 'SBD: bundmenu skifter side, aria-current følger, logget sæt bevares', async () => {
    const p = await newPage(); await open(p, 'sbd/index.html'); await startSession(p); await p.fill('#kg_0_0', '111'); await p.dispatchEvent('#kg_0_0', 'change');
    for (const i of [2, 3, 4, 1]) { await p.click('.nav-btn:nth-child(' + i + ')'); await p.waitForTimeout(150); eq(await p.locator('.nav-btn[aria-current=page]').count(), 1); }
    eq(await p.inputValue('#kg_0_0'), '111', 'vægt mistet ved navigation'); eq(p.errors, []); await p.ctx.close();
  });
  await check('Genindlæsning', 'Dashboard, SBD og løb starter uden fejl efter reload og bevarer data', async () => {
    const p = await newPage();
    for (const rel of ['index.html', 'sbd/index.html', 'lob/index.html']) { await open(p, rel); await p.reload(); await p.waitForTimeout(600); eq(p.errors, [], rel); }
    const keys = await p.evaluate(() => ['sbd_state', 'sbd_partner', 'lob_state', 'lob_partner'].map(k => !!localStorage.getItem(k)));
    eq(keys, [true, true, true, true]); await p.ctx.close();
  });

  /* ───────── TASTATUR ───────── */
  await check('Tastatur', 'Tab viser synlig fokusring (≥2 px) på første elementer – dashboard, SBD, løb', async () => {
    const out = [];
    for (const rel of ['index.html', 'sbd/index.html', 'lob/index.html']) {
      const p = await newPage(1366, 800); await open(p, rel);
      for (let i = 0; i < 4; i++) await p.keyboard.press('Tab');
      const o = await p.evaluate(() => { const e = document.activeElement, c = getComputedStyle(e); return { tag: e.tagName, style: c.outlineStyle, w: parseFloat(c.outlineWidth) }; });
      ok(o.style !== 'none' && o.w >= 2, rel + ' fokus-outline: ' + JSON.stringify(o)); out.push(rel.split('/')[0] + ':' + o.w + 'px'); await p.ctx.close();
    }
    return out.join(' ');
  });
  await check('Tastatur', 'Løb: faner har roving tabindex og piletaster/Home/End skifter fane og panel', async () => {
    const p = await newPage(1366, 800); await open(p, 'lob/index.html');
    eq(await p.locator('[role=tab][tabindex="0"]').count(), 1);
    await p.focus('#tab-log'); await p.keyboard.press('ArrowRight'); await p.waitForTimeout(200);
    eq(await p.evaluate(() => document.activeElement.id), 'tab-analyse'); ok(await p.isVisible('#view-analyse'));
    await p.keyboard.press('End'); eq(await p.evaluate(() => document.activeElement.id), 'tab-settings'); ok(await p.isVisible('#view-settings'));
    await p.keyboard.press('ArrowRight'); eq(await p.evaluate(() => document.activeElement.id), 'tab-log');
    await p.keyboard.press('Home'); eq(await p.evaluate(() => document.activeElement.id), 'tab-log');
    await p.keyboard.press('ArrowLeft'); eq(await p.evaluate(() => document.activeElement.id), 'tab-settings');
    eq(await p.locator('[role=tab][tabindex="0"]').count(), 1); eq(p.errors, []); await p.ctx.close();
  });
  await check('Tastatur', 'SBD: sæt kan gennemføres kun med tastatur (Mellemrum); pausetimer fanger fokus og kan lukkes med Enter', async () => {
    const p = await newPage(1366, 800); await open(p, 'sbd/index.html'); await startSession(p);
    await p.focus('#chk_0_0'); await p.keyboard.press('Space'); await p.waitForTimeout(500);
    eq(await p.getAttribute('#chk_0_0', 'aria-pressed'), 'true');
    ok(await p.evaluate(() => document.getElementById('timer-overlay').contains(document.activeElement)), 'fokus ikke flyttet ind i timer-overlay');
    for (let i = 0; i < 5; i++) { await p.keyboard.press('Tab'); ok(await p.evaluate(() => document.getElementById('timer-overlay').contains(document.activeElement)), 'fokus forlod overlay ved Tab ' + i); }
    await p.focus('.timer-skip'); await p.keyboard.press('Enter'); await p.waitForTimeout(300);
    ok(await p.locator('#timer-overlay.open').count() === 0, 'overlay lukkede ikke');
    const back = await p.evaluate(() => document.activeElement && document.activeElement.id);
    ok(back === 'chk_0_0', 'fokus vendte ikke tilbage til sæt-knappen (aktivt: ' + back + ')'); eq(p.errors, []); await p.ctx.close();
  });
  await check('Tastatur', 'SBD: modal (Genstart) – fokus ind, Tab fanget, Escape lukker, fokus tilbage til udløser', async () => {
    const p = await newPage(1366, 800); await open(p, 'sbd/index.html'); await p.click('.nav-btn:nth-child(4)');
    const btn = p.locator('button:has-text("Genstart")').first(); await btn.scrollIntoViewIfNeeded(); await btn.focus(); await p.keyboard.press('Enter'); await p.waitForTimeout(400);
    const inside = () => p.evaluate(() => document.getElementById('modal').contains(document.activeElement));
    ok(await p.locator('#modal.open').count() === 1, 'modal åbnede ikke'); ok(await inside(), 'fokus ikke i modal');
    for (let i = 0; i < 12; i++) { await p.keyboard.press('Tab'); ok(await inside(), 'fokus lækkede ud ved Tab ' + i); }
    await p.keyboard.press('Shift+Tab'); ok(await inside());
    await p.keyboard.press('Escape'); await p.waitForTimeout(300); ok(await p.locator('#modal.open').count() === 0, 'Escape lukkede ikke');
    const txt = await p.evaluate(() => document.activeElement.textContent.trim()); ok(/Genstart/.test(txt), 'fokus ikke tilbage på udløser: "' + txt.slice(0, 30) + '"');
    eq(await p.getAttribute('#modal .modal', 'role'), 'dialog'); await p.ctx.close();
  });

  /* ───────── RESPONSIVT ───────── */
  const widths = [360, 390, 430, 768, 1024, 1366, 1920];
  const views = [
    ['Dashboard', 'index.html', null], ['SBD I dag', 'sbd/index.html', null], ['SBD Program', 'sbd/index.html', '.nav-btn:nth-child(2)'],
    ['SBD Historik', 'sbd/index.html', '.nav-btn:nth-child(3)'], ['SBD Indstillinger', 'sbd/index.html', '.nav-btn:nth-child(4)'],
    ['Løb Log', 'lob/index.html', null], ['Løb Analyse', 'lob/index.html', '#tab-analyse'], ['Løb Periode', 'lob/index.html', '#tab-periode'],
    ['Løb Timer', 'lob/index.html', '#tab-timer'], ['Løb Opsætning', 'lob/index.html', '#tab-settings'],
  ];
  await check('Responsivt', 'Ingen vandret scroll / element ud over viewport: ' + views.length + ' visninger × ' + widths.length + ' bredder', async () => {
    const bad = [];
    for (const w of widths) {
      const p = await newPage(w, w < 700 ? 844 : 900);
      for (const [name, rel, sel] of views) {
        await open(p, rel); if (sel) { await p.click(sel); await p.waitForTimeout(250); }
        const r = await p.evaluate(() => { const W = document.documentElement.clientWidth; const off = [...document.querySelectorAll('body *')].filter(e => { const b = e.getBoundingClientRect(); const cs = getComputedStyle(e); return b.width > 0 && b.right > W + 1 && cs.position !== 'fixed' && !e.closest('[hidden],.hidden'); }).slice(0, 2).map(e => e.tagName + '.' + e.className); return { sw: document.documentElement.scrollWidth, W, off }; });
        if (r.sw > r.W || r.off.length) bad.push(name + '@' + w + ': sw ' + r.sw + '/' + r.W + ' ' + r.off.join(','));
        if (p.errors.length) bad.push(name + '@' + w + ' JS-fejl: ' + p.errors[0]);
      }
      await p.ctx.close();
    }
    ok(!bad.length, bad.slice(0, 4).join(' | ')); return (views.length * widths.length) + ' kombinationer ok';
  });

  /* ───────── PWA / SERVICE WORKER ───────── */
  await check('PWA', 'Service worker registreres, cacher ds.css + ds.js, og dashboardet loader offline fra cache', async () => {
    const p = await newPage(); await open(p, 'index.html'); await p.waitForTimeout(1500);
    const info = await p.evaluate(async () => { const reg = await navigator.serviceWorker.getRegistration(); const keys = await caches.keys(); const c = keys.length ? await (await caches.open(keys[0])).keys() : []; return { reg: !!reg, keys, urls: c.map(r => new URL(r.url).pathname) }; });
    ok(info.reg, 'ingen SW-registrering'); ok(info.urls.some(u => u.endsWith('ds.css')) && info.urls.some(u => u.endsWith('ds.js')), 'ds.css/ds.js ikke i cache: ' + info.urls.join(','));
    await p.ctx.setOffline(true); await p.reload(); await p.waitForTimeout(800);
    ok((await p.innerText('body')).includes('I DAG') || (await p.innerText('body')).toLowerCase().includes('i dag'), 'offline-visning tom'); await p.ctx.close(); return info.keys.join(',') + ' (' + info.urls.length + ' filer)';
  });

  /* ───────── SYNC (kun mod MOCK-Worker) ───────── */
  await check('Sync (mock)', 'SBD pull: nyere serverversion overskriver lokal; push sender PUT; løb sender Authorization når token er sat', async () => {
    syncLog.length = 0;
    const p = await newPage(); await open(p, 'sbd/index.html');
    const server = JSON.parse(JSON.stringify(await ls(p, 'sbd_partner'))); server.oneRM = { sq: 99, bp: 99, dl: 99 };
    kv['sbd_partner'] = { value: server, updatedAt: Date.now() + 60000 };
    await p.reload(); await p.waitForTimeout(1500);
    eq((await ls(p, 'sbd_partner')).oneRM.sq, 99, 'pull overskrev ikke lokalt');
    ok(syncLog.some(x => x.method === 'GET' && x.key === 'sbd_partner'), 'ingen GET set');
    await p.click('.nav-btn:nth-child(4)'); await p.fill('#input-sq', '140'); await p.dispatchEvent('#input-sq', 'change'); await p.waitForTimeout(2600);
    ok(syncLog.some(x => x.method === 'PUT'), 'ingen PUT set');
    const q = await newPage(); await q.addInitScript(() => localStorage.setItem('sync_token', 'TESTTOKEN')); await open(q, 'lob/index.html'); await q.waitForTimeout(1500);
    ok(syncLog.some(x => x.auth === 'Bearer TESTTOKEN'), 'løb sendte ikke Authorization-header');
    await p.ctx.close(); await q.ctx.close(); return 'MOCK – ikke verificeret mod rigtig Worker';
  });

  /* ───────── V3 · FASE 1: SAMLET BACKUP & GENDANNELSE ───────── */
  const settingsMount = async (p) => { await p.waitForSelector('#tp-backup-mount .tp-panel', { state: 'attached' }); await p.locator('#tp-backup-mount').scrollIntoViewIfNeeded().catch(() => {}); };
  await check('Backup (V3)', 'Panelet findes i dashboard, SBD-indstillinger og løb-opsætning', async () => {
    let p = await newPage(1366, 900); await open(p, 'index.html'); await settingsMount(p); await p.ctx.close();
    p = await newPage(1366, 900); await open(p, 'sbd/index.html'); await p.click('.nav-btn:nth-child(4)'); await settingsMount(p); await p.ctx.close();
    p = await newPage(1366, 900); await open(p, 'lob/index.html'); await p.click('#tab-settings'); await settingsMount(p); eq(p.errors, []); await p.ctx.close();
  });
  await check('Backup (V3)', 'Eksport (download) → fil har version/checksum/begge profiler og ingen sync_token', async () => {
    const p = await newPage(1366, 900); await p.addInitScript(() => localStorage.setItem('sync_token', 'HEMMELIG-TEST-TOKEN'));
    await open(p, 'index.html'); await settingsMount(p);
    const [dl] = await Promise.all([p.waitForEvent('download'), p.click('#tp-backup-mount [data-act=exp-all]')]);
    const txt = fs.readFileSync(await dl.path(), 'utf8'); const b = JSON.parse(txt);
    eq(b.app, 'traening-platform'); eq(b.format, 3); ok(b.exportedAt && b.meta.checksum && b.appVersion);
    ok(b.data.sbd_state && b.data.sbd_partner && b.data.lob_state && b.data.lob_partner, 'begge profiler mangler');
    ok(!/HEMMELIG-TEST-TOKEN|sync_token/.test(txt), 'token lækket i backup'); await p.ctx.close();
    return dl.suggestedFilename();
  });
  await check('Backup (V3)', 'Gendannelse: korrupt fil afvises uden ændring; gyldig fil viser plan+konflikt og kræver bekræftelse', async () => {
    const p = await newPage(1366, 900); await open(p, 'index.html'); await settingsMount(p);
    const [dl] = await Promise.all([p.waitForEvent('download'), p.click('#tp-backup-mount [data-act=exp-all]')]);
    const good = fs.readFileSync(await dl.path(), 'utf8');
    const before = await p.evaluate(() => JSON.stringify(Object.keys(localStorage).sort().map(k => [k, localStorage.getItem(k)])));
    // 1) afkortet fil
    await p.setInputFiles('#tp-backup-mount input[type=file]', { name: 'x.json', mimeType: 'application/json', buffer: Buffer.from(good.slice(0, good.length >> 1)) });
    await p.click('#tp-backup-mount [data-act=check]'); await p.waitForSelector('#tp-backup-mount [role=alert]');
    ok(/kan ikke gendannes/i.test(await p.innerText('#tp-backup-mount [role=alert]')));
    eq(await p.evaluate(() => JSON.stringify(Object.keys(localStorage).sort().map(k => [k, localStorage.getItem(k)]))), before, 'afvist import ændrede data');
    // 2) manipuleret indhold (checksum)
    const tam = JSON.parse(good); tam.data.lob_state.runs[0].distanceKm = 42;
    await p.setInputFiles('#tp-backup-mount input[type=file]', { name: 'y.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(tam)) });
    await p.click('#tp-backup-mount [data-act=check]'); await p.waitForTimeout(300);
    ok(/Kontrolsum/i.test(await p.innerText('#tp-backup-mount [role=alert]')), 'checksum-fejl vist ikke');
    // 3) gyldig fil, men nuværende data har ét løb mere → konflikt, knap deaktiveret til bekræftelse
    await p.evaluate(() => { const s = JSON.parse(localStorage.lob_state); s.runs.push({ id: 'ekstra', date: '2026-10-25', distanceKm: 5, durationSec: 1500 }); localStorage.lob_state = JSON.stringify(s); });
    await p.setInputFiles('#tp-backup-mount input[type=file]', { name: 'z.json', mimeType: 'application/json', buffer: Buffer.from(good) });
    await p.click('#tp-backup-mount [data-act=check]'); await p.waitForSelector('#tp-backup-mount [data-act=apply]');
    ok(await p.isDisabled('#tp-backup-mount [data-act=apply]'), 'Gendan-knap skal være deaktiveret før bekræftelse');
    ok(/færre løb/.test(await p.innerText('#tp-backup-mount')), 'konflikt ikke vist');
    await p.check('#tp-backup-mount [data-role=confirm]'); ok(!(await p.isDisabled('#tp-backup-mount [data-act=apply]')));
    await p.click('#tp-backup-mount [data-act=cancel]'); ok((await p.locator('#tp-backup-mount [data-act=apply]').count()) === 0);
    eq(p.errors, []); await p.ctx.close();
  });
  await check('Backup (V3)', 'Gendannelse + genindlæs: data tilbage, Ellens data uændret ved Olivers-fil, "Fortryd" genskaber', async () => {
    const p = await newPage(1366, 900); await open(p, 'index.html'); await settingsMount(p);
    const [dl] = await Promise.all([p.waitForEvent('download'), p.click('#tp-backup-mount [data-act=exp-main]')]);
    const mainOnly = fs.readFileSync(await dl.path(), 'utf8');
    const orig = await p.evaluate(() => ({ r: JSON.parse(localStorage.lob_state).runs.length, p: localStorage.lob_partner, sp: localStorage.sbd_partner }));
    await p.evaluate(() => { const s = JSON.parse(localStorage.lob_state); s.runs.push({ id: 'ekstra', date: '2026-10-25', distanceKm: 5, durationSec: 1500 }); localStorage.lob_state = JSON.stringify(s); const q = JSON.parse(localStorage.lob_partner); q.runs.push({ id: 'ellen-ny', date: '2026-10-25', distanceKm: 3, durationSec: 1000 }); localStorage.lob_partner = JSON.stringify(q); });
    const ellenNow = await p.evaluate(() => localStorage.lob_partner);
    await p.setInputFiles('#tp-backup-mount input[type=file]', { name: 'main.json', mimeType: 'application/json', buffer: Buffer.from(mainOnly) });
    await p.click('#tp-backup-mount [data-act=check]'); await p.waitForSelector('#tp-backup-mount [data-act=apply]');
    ok(!/Ellen/.test(await p.innerText('#tp-backup-mount .tp-box')) || /Oliver/.test(await p.innerText('#tp-backup-mount')), 'plan');
    await p.check('#tp-backup-mount [data-role=confirm]');
    await Promise.all([p.waitForNavigation({ waitUntil: 'load' }), p.click('#tp-backup-mount [data-act=apply]')]); await p.waitForTimeout(900);
    const after = await p.evaluate(() => ({ r: JSON.parse(localStorage.lob_state).runs.length, p: localStorage.lob_partner, snap: !!localStorage.tp_prerestore_snapshot }));
    eq(after.r, orig.r, 'Olivers løb ikke gendannet'); eq(after.p, ellenNow, 'Ellens data ændret af Olivers backup'); ok(after.snap, 'ingen sikkerhedskopi');
    await settingsMount(p); await p.waitForSelector('#tp-backup-mount [data-act=undo]');
    await Promise.all([p.waitForNavigation({ waitUntil: 'load' }), p.click('#tp-backup-mount [data-act=undo]')]); await p.waitForTimeout(700);
    eq(await p.evaluate(() => JSON.parse(localStorage.lob_state).runs.length), orig.r + 1, 'fortryd genskabte ikke de nye data');
    eq(p.errors, []); await p.ctx.close();
  });
  await check('Backup (V3)', 'Gammelt SBD-/løbe-format kan stadig gendannes (kun sin del)', async () => {
    const p = await newPage(1366, 900); await open(p, 'sbd/index.html'); await p.click('.nav-btn:nth-child(4)'); await settingsMount(p);
    const legacy = { app: 'lob-tracker', version: 1, exportedAt: new Date().toISOString(), main: demo.lob_state, partner: demo.lob_partner };
    await p.evaluate(() => { const s = JSON.parse(localStorage.lob_state); s.runs = s.runs.slice(0, 3); localStorage.lob_state = JSON.stringify(s); });
    const sbdBefore = await p.evaluate(() => localStorage.sbd_state);
    await p.setInputFiles('#tp-backup-mount input[type=file]', { name: 'gammel.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(legacy)) });
    await p.click('#tp-backup-mount [data-act=check]'); await p.waitForSelector('#tp-backup-mount [data-act=apply]');
    ok(/Gammelt løbe-backupformat/.test(await p.innerText('#tp-backup-mount')));
    await p.check('#tp-backup-mount [data-role=confirm]');
    await Promise.all([p.waitForNavigation({ waitUntil: 'load' }), p.click('#tp-backup-mount [data-act=apply]')]); await p.waitForTimeout(800);
    eq(await p.evaluate(() => JSON.parse(localStorage.lob_state).runs.length), demo.lob_state.runs.length);
    const sbdAfter = JSON.parse(await p.evaluate(() => localStorage.sbd_state)); eq(sbdAfter.completedDays.length, JSON.parse(sbdBefore).completedDays.length, 'SBD blev rørt af løbefil');
    await p.ctx.close();
  });
  await check('Backup (V3)', 'Sync-sikkerhed (mock): gendannede data overskrives ikke af en ÆLDRE serverkopi ved næste opstart', async () => {
    const p = await newPage(1366, 900); await open(p, 'index.html'); await settingsMount(p);
    const [dl] = await Promise.all([p.waitForEvent('download'), p.click('#tp-backup-mount [data-act=exp-main]')]);
    const backup = fs.readFileSync(await dl.path(), 'utf8'); const n = demo.lob_state.runs.length;
    await p.evaluate(() => { const s = JSON.parse(localStorage.lob_state); s.runs.push({ id: 'ekstra', date: '2026-10-25', distanceKm: 5, durationSec: 1500 }); localStorage.lob_state = JSON.stringify(s); });
    const old = JSON.parse(JSON.stringify(demo.lob_state)); old.runs = old.runs.slice(0, 2);
    kv['lob_state'] = { value: old, updatedAt: Date.now() - 3600000 };  // serverens kopi er ÆLDRE end gendannelsen
    await p.setInputFiles('#tp-backup-mount input[type=file]', { name: 'm.json', mimeType: 'application/json', buffer: Buffer.from(backup) });
    await p.click('#tp-backup-mount [data-act=check]'); await p.waitForSelector('#tp-backup-mount [data-role=confirm]'); await p.check('#tp-backup-mount [data-role=confirm]');
    await Promise.all([p.waitForNavigation({ waitUntil: 'load' }), p.click('#tp-backup-mount [data-act=apply]')]); await p.waitForTimeout(1500);
    eq(await p.evaluate(() => JSON.parse(localStorage.lob_state).runs.length), n, 'ældre serverkopi overskrev gendannelsen');
    await open(p, 'lob/index.html'); await p.waitForTimeout(800);
    eq(await p.evaluate(() => JSON.parse(localStorage.lob_state).runs.length), n, 'løb-siden hentede ældre serverdata');
    eq(p.errors, []); await p.ctx.close(); return 'MOCK – ikke verificeret mod rigtig Worker';
  });
  await check('Backup (V3)', 'Gendannelse i én fane får en anden åben fane til at genindlæse (ingen forældet overskrivning)', async () => {
    const a = await newPage(1366, 900); await open(a, 'sbd/index.html');
    const b = await a.ctx.newPage(); await b.goto(url + 'index.html'); await b.waitForTimeout(600);
    let reloaded = false; a.on('load', () => { reloaded = true; });
    await b.evaluate(() => localStorage.setItem('tp_restore_epoch', String(Date.now()))); await a.waitForTimeout(1200);
    ok(reloaded, 'SBD-fanen genindlæste ikke'); await a.ctx.close();
  });

  /* ───────── AXE ───────── */
  let axeSrc = null;
  for (const c of [process.env.AXE_PATH, path.join(__dirname, '..', 'node_modules', 'axe-core', 'axe.min.js'), path.join(__dirname, '..', '..', 'axe', 'node_modules', 'axe-core', 'axe.min.js')]) if (c && fs.existsSync(c)) { axeSrc = fs.readFileSync(c, 'utf8'); break; }
  if (!axeSrc) rec('Tilgængelighed (axe)', 'axe-core ikke fundet – kør npm i', 'SKIP');
  else {
    const states = [
      ['Dashboard', 'index.html', async p => {}], ['SBD I dag', 'sbd/index.html', async p => {}],
      ['SBD aktiv session', 'sbd/index.html', async p => { await startSession(p); }],
      ['SBD pausetimer-overlay', 'sbd/index.html', async p => { await startSession(p); await p.click('#chk_0_0'); await p.waitForTimeout(400); }],
      ['SBD Program', 'sbd/index.html', async p => { await p.click('.nav-btn:nth-child(2)'); }], ['SBD Historik', 'sbd/index.html', async p => { await p.click('.nav-btn:nth-child(3)'); }],
      ['SBD Indstillinger', 'sbd/index.html', async p => { await p.click('.nav-btn:nth-child(4)'); }],
      ['SBD genstart-modal', 'sbd/index.html', async p => { await p.click('.nav-btn:nth-child(4)'); await p.locator('button:has-text("Genstart")').first().click(); await p.waitForTimeout(300); }],
      ['Løb Log', 'lob/index.html', async p => {}], ['Løb Log (fejlbesked)', 'lob/index.html', async p => { await p.fill('#lg-dist', '0', {timeout:1500}).catch(()=>{}); await p.click('#newrun-card > summary').catch(()=>{}); await p.fill('#lg-dist', '0'); await p.click('text=Gem løbetur'); await p.waitForTimeout(200); }],
      ['Løb Analyse', 'lob/index.html', async p => { await p.click('#tab-analyse'); }], ['Løb Periode', 'lob/index.html', async p => { await p.click('#tab-periode'); }],
      ['Løb Timer (setup)', 'lob/index.html', async p => { await p.click('#tab-timer'); }],
      ['Løb Timer (kører)', 'lob/index.html', async p => { await p.click('#tab-timer'); await p.fill('#tm-reps', '2'); await p.fill('#tm-work', '0:30'); await p.fill('#tm-rest', '0:20'); await p.click('text=Start session'); await p.waitForTimeout(500); }],
      ['Løb Opsætning', 'lob/index.html', async p => { await p.click('#tab-settings'); }],
      ['Dashboard backup-plan', 'index.html', async p => { await p.waitForSelector('#tp-backup-mount .tp-panel', { state: 'attached' }); if (!(await p.isVisible('#tp-backup-mount [data-act=check]'))) await p.locator('.section-label', { hasText: 'Indstillinger' }).click(); const b = JSON.stringify(await p.evaluate(() => TP.buildBackup('all'))); await p.setInputFiles('#tp-backup-mount input[type=file]', { name: 'a.json', mimeType: 'application/json', buffer: Buffer.from(b) }); await p.click('#tp-backup-mount [data-act=check]'); await p.waitForSelector('#tp-backup-mount [data-role=confirm]'); }],
    ];
    for (const w of [390, 1366]) for (const [name, rel, prep] of states) {
      await check('Tilgængelighed (axe)', name + ' @' + w, async () => {
        const p = await newPage(w, w < 700 ? 844 : 900); p.on('dialog', d => d.dismiss()); await open(p, rel); await prep(p);
        await p.evaluate(axeSrc);
        const r = await p.evaluate(() => axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] }));
        await p.ctx.close();
        const v = r.violations; ok(!v.length, v.map(x => x.id + '×' + x.nodes.length + ' (' + x.nodes[0].target.join(' ').slice(0, 60) + ')').join('; '));
      });
    }
  }

  await browser.close(); srv.close();
  const pass = results.filter(r => r.status === 'PASS').length, fail = results.filter(r => r.status === 'FAIL').length, skip = results.filter(r => r.status === 'SKIP').length;
  console.log('\n' + BROWSER + ': ' + pass + ' bestået, ' + fail + ' fejlet, ' + skip + ' ikke gennemført (af ' + results.length + ')');
  fs.writeFileSync(path.join(__dirname, 'results' + (BROWSER === 'chromium' ? '' : '-' + BROWSER) + '.json'), JSON.stringify({ browser: BROWSER, pass, fail, skip, results }, null, 1));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
