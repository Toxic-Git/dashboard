/* ═══════════════════════════════════════════════════════════════════════════
   TRÆNING — FÆLLES UI (V3)  — kræver tp-core.js
   Genbrugelige UI-dele, som ellers ville blive kopieret i tre sider:
     • Samlet backup/gendannelse-panel (monteres under Indstillinger/Opsætning)
     • Lyt efter gendannelse i en anden fane (genindlæs, så en forældet fane ikke overskriver)
   Semantik (labels, aria-live, roller) ligger i den genererede HTML.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (typeof TP === 'undefined') return;
  var UI = {};

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  UI.esc = esc;

  /* Styles — bruger designsystemets tokens (ds.css). Injiceres én gang. */
  function ensureStyle() {
    if (document.getElementById('tp-ui-style')) return;
    var st = document.createElement('style'); st.id = 'tp-ui-style';
    st.textContent = [
      '.tp-panel{display:flex;flex-direction:column;gap:10px;font-size:14px;color:var(--text)}',
      '.tp-panel h3,.tp-panel h4{margin:0;font-family:var(--font-disp,inherit);letter-spacing:.04em}',
      '.tp-note{font-size:13px;line-height:1.5;color:var(--muted,var(--text-dim,#9098a8))}',
      '.tp-row{display:flex;flex-wrap:wrap;gap:8px}',
      '.tp-btn{min-height:44px;padding:10px 14px;border-radius:10px;border:1px solid var(--border-strong,#3c4254);background:var(--surface2,#22262f);color:var(--text,#f0ece4);font:inherit;font-weight:600;cursor:pointer;flex:1 1 150px}',
      '.tp-btn.primary{background:var(--gold,#d4a843);border-color:var(--gold,#d4a843);color:#181a1f}',
      '.tp-btn.danger{background:var(--danger-bg,#c4402f);border-color:var(--danger-bg,#c4402f);color:#fff}',
      '.tp-btn[disabled]{opacity:.45;cursor:not-allowed}',
      '.tp-box{border:1px solid var(--border,#2e3240);border-radius:12px;padding:12px;background:var(--surface,#1a1d24);display:flex;flex-direction:column;gap:8px}',
      '.tp-box.err{border-color:var(--danger,#ee7566)}',
      '.tp-box.warn{border-color:var(--gold,#d4a843)}',
      '.tp-item{display:flex;gap:10px;align-items:flex-start;padding:8px 0;border-top:1px solid var(--border,#2e3240)}',
      '.tp-item:first-child{border-top:0}',
      '.tp-item input[type=checkbox]{width:22px;height:22px;margin-top:2px;flex:none}',
      '.tp-item .lbl{font-weight:600}',
      '.tp-item .sub{font-size:12.5px;color:var(--muted,var(--text-dim,#9098a8))}',
      '.tp-conf{font-size:12.5px;color:var(--danger,#ee7566)}',
      '.tp-ok{color:var(--success,#5fbf8a)}',
      '.tp-file{width:100%;min-height:44px}'
    ].join('\n');
    document.head.appendChild(st);
  }

  function fmtSum(sum) {
    if (!sum) return 'ingen data nu';
    if (sum.empty) return 'tom';
    var p = [];
    if (sum.sessions != null) p.push(sum.sessions + ' styrketræninger');
    if (sum.runs != null) p.push(sum.runs + ' løb');
    if (sum.changes != null) p.push(sum.changes + ' planændringer');
    if (sum.reports != null && sum.reports) p.push(sum.reports + ' rapporter');
    if (sum.evals) p.push(sum.evals + ' evalueringer');
    if (sum.subs) p.push(sum.subs + ' øvelsesbytter');
    if (sum.last) p.push('seneste ' + sum.last);
    if (sum.entries != null && !p.length) p.push(sum.entries + ' poster');
    return p.length ? p.join(', ') : 'tom';
  }

  function download(name, obj) {
    var blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  UI.exportBackup = function (scope) {
    var b = TP.buildBackup(scope);
    var suffix = scope === 'all' ? '' : '-' + (scope === 'main' ? 'oliver' : 'ellen');
    download('traening-backup-' + TP.localISO(new Date()) + suffix + '.json', b);
    try { TP.storage().setItem('tp_last_export', new Date().toISOString()); } catch (e) {}
    return b;
  };

  /* ── Panel ── */
  UI.mountBackup = function (container) {
    if (!container) return;
    ensureStyle();
    var id = 'tpb' + Math.random().toString(36).slice(2, 6);
    var last = null; try { last = TP.storage().getItem('tp_last_export'); } catch (e) {}
    var snap = TP.hasSnapshot();
    container.innerHTML =
      '<div class="tp-panel" id="' + id + '">' +
      '<h3>Samlet backup</h3>' +
      '<div class="tp-note">Én fil med styrketræning, løb, programmer, planændringer, mål, restitutionsdata, øvelsesbytter, evalueringer og indstillinger. Sync-adgangskoden gemmes <strong>ikke</strong> i filen.' +
      (last ? ' Seneste eksport fra denne enhed: ' + esc(last.slice(0, 16).replace('T', ' ')) + '.' : ' Der er endnu ikke eksporteret fra denne enhed.') + '</div>' +
      '<div class="tp-row">' +
      '<button type="button" class="tp-btn primary" data-act="exp-all">Eksportér alt (begge profiler)</button>' +
      '<button type="button" class="tp-btn" data-act="exp-main">Kun Oliver</button>' +
      '<button type="button" class="tp-btn" data-act="exp-partner">Kun Ellen</button>' +
      '</div>' +
      '<h4 style="margin-top:6px">Gendan fra backup</h4>' +
      '<label for="' + id + '-file" class="tp-note">Vælg backupfil (.json)</label>' +
      '<input class="tp-file" type="file" id="' + id + '-file" accept=".json,application/json">' +
      '<div class="tp-row"><button type="button" class="tp-btn" data-act="check">Kontrollér fil</button></div>' +
      '<div data-role="result" aria-live="polite"></div>' +
      '<div data-role="undo">' + (snap ? undoHtml(snap) : '') + '</div>' +
      '</div>';
    var root = container.querySelector('#' + id), result = root.querySelector('[data-role=result]'), undoBox = root.querySelector('[data-role=undo]');
    var state = { parsed: null, plan: null, text: null };

    function undoHtml(s) {
      return '<div class="tp-box warn"><div class="tp-note">Der findes en sikkerhedskopi af dine data fra før seneste gendannelse (' + esc(new Date(s.at).toLocaleString('da-DK')) + ').</div>' +
        '<button type="button" class="tp-btn" data-act="undo">Fortryd seneste gendannelse</button></div>';
    }
    function renderPlan() {
      var plan = state.plan, h = '';
      if (!plan.ok) {
        h += '<div class="tp-box err" role="alert"><strong>Filen kan ikke gendannes — intet er ændret.</strong><ul style="margin:0;padding-left:18px">' +
          plan.errors.map(function (e) { return '<li>' + esc(e) + '</li>'; }).join('') + '</ul></div>';
        result.innerHTML = h; return;
      }
      h += '<div class="tp-box"><strong>Backup fra ' + esc(plan.exportedAt ? new Date(plan.exportedAt).toLocaleString('da-DK') : 'ukendt tidspunkt') + '</strong>';
      if (state.parsed.legacyKind === 'lob-single') {
        h += '<label class="tp-note" for="' + id + '-tgt">Gendan denne løbefil til profil</label><select id="' + id + '-tgt" data-role="tgt"><option value="main">Oliver</option><option value="partner">Ellen</option></select>';
      }
      plan.warnings.forEach(function (w) { h += '<div class="tp-note">⚠️ ' + esc(w) + '</div>'; });
      plan.items.forEach(function (it, i) {
        var dis = it.action === 'same' || it.action === 'invalid';
        h += '<div class="tp-item"><input type="checkbox" id="' + id + '-c' + i + '" data-i="' + i + '"' + (it.selected ? ' checked' : '') + (dis ? ' disabled' : '') + '>' +
          '<label for="' + id + '-c' + i + '" style="flex:1"><div class="lbl">' + esc(it.label) + '</div>' +
          '<div class="sub">' + (it.action === 'same' ? 'Identisk med nuværende data — springes over.' :
            (it.action === 'add' ? 'Ny på denne enhed: ' + esc(fmtSum(it.incoming)) :
              'Nu: ' + esc(fmtSum(it.current)) + ' → Backup: ' + esc(fmtSum(it.incoming)))) + '</div>' +
          it.conflicts.map(function (c) { return '<div class="tp-conf">⚠️ ' + esc(c) + '</div>'; }).join('') + '</label></div>';
      });
      h += '<div class="tp-note">De markerede data <strong>erstatter</strong> de nuværende. En sikkerhedskopi af dem lægges til side først, så du kan fortryde.</div>' +
        '<label class="tp-item" style="border:0"><input type="checkbox" data-role="confirm" id="' + id + '-ok"><span>Jeg har forstået, at de markerede data overskrives</span></label>' +
        '<div class="tp-row"><button type="button" class="tp-btn danger" data-act="apply" disabled>Gendan nu</button><button type="button" class="tp-btn" data-act="cancel">Annullér</button></div></div>';
      result.innerHTML = h;
      syncApply();
    }
    function syncApply() {
      var ok = result.querySelector('[data-role=confirm]'), btn = result.querySelector('[data-act=apply]'); if (!ok || !btn) return;
      var any = state.plan.items.some(function (i) { return i.selected; });
      btn.disabled = !(ok.checked && any);
    }
    function doCheck() {
      var f = root.querySelector('input[type=file]').files && root.querySelector('input[type=file]').files[0];
      if (!f) { result.innerHTML = '<div class="tp-box err" role="alert">Vælg en backupfil først.</div>'; return; }
      var rd = new FileReader();
      rd.onload = function () {
        state.text = String(rd.result); state.parsed = TP.parseBackup(state.text);
        state.plan = TP.planRestore(state.parsed, TP.storage());
        renderPlan();
      };
      rd.onerror = function () { result.innerHTML = '<div class="tp-box err" role="alert">Filen kunne ikke læses.</div>'; };
      rd.readAsText(f);
    }
    root.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-act]') : null; if (!b) return;
      var a = b.getAttribute('data-act');
      if (a === 'exp-all') { UI.exportBackup('all'); UI.toast('Samlet backup downloadet'); }
      else if (a === 'exp-main') { UI.exportBackup('main'); UI.toast('Backup (Oliver) downloadet'); }
      else if (a === 'exp-partner') { UI.exportBackup('partner'); UI.toast('Backup (Ellen) downloadet'); }
      else if (a === 'check') doCheck();
      else if (a === 'cancel') { state = { parsed: null, plan: null, text: null }; result.innerHTML = ''; }
      else if (a === 'apply') {
        var tgt = result.querySelector('[data-role=tgt]');
        if (tgt) state.plan = TP.planRestore(state.parsed, TP.storage(), { singleLobTarget: tgt.value }), state.plan.items.forEach(function (i) { i.selected = true; });
        else result.querySelectorAll('input[data-i]').forEach(function (cb) { state.plan.items[+cb.getAttribute('data-i')].selected = cb.checked && !cb.disabled; });
        var r = TP.applyRestore(state.plan, TP.storage());
        if (r.ok) {
          flashAndReload('Gendannet: ' + r.written.length + ' dataposter er skrevet. Sikkerhedskopi af de tidligere data ligger klar under "Fortryd".');
        } else {
          result.innerHTML = '<div class="tp-box err" role="alert"><strong>Gendannelsen mislykkedes' + (r.rolledBack ? ' — alt er rullet tilbage' : '') + '.</strong> ' + esc(r.error) + ' Dine nuværende data er intakte.</div>';
        }
      } else if (a === 'undo') {
        var u = TP.undoRestore();
        if (u.ok) flashAndReload('Fortrudt: dine data fra før gendannelsen er genskabt.');
        else result.innerHTML = '<div class="tp-box err" role="alert">' + esc(u.error) + '</div>';
      }
    });
    root.addEventListener('change', function (e) {
      var t = e.target;
      if (t.getAttribute && t.getAttribute('data-role') === 'confirm') syncApply();
      else if (t.getAttribute && t.hasAttribute('data-i')) { state.plan.items[+t.getAttribute('data-i')].selected = t.checked; syncApply(); }
      else if (t.getAttribute && t.getAttribute('data-role') === 'tgt') {
        state.plan = TP.planRestore(state.parsed, TP.storage(), { singleLobTarget: t.value }); renderPlan();
        var s2 = result.querySelector('[data-role=tgt]'); if (s2) s2.value = t.value;
      }
    });
  };

  // Genindlæs STRAKS efter en gendannelse, så sidens gamle hukommelsestilstand aldrig når at skrive tilbage.
  function flashAndReload(msg) {
    try { sessionStorage.setItem('tp_flash', msg); } catch (e) {}
    try { location.reload(); } catch (e) {}
  }
  function showFlash() {
    var m = null; try { m = sessionStorage.getItem('tp_flash'); if (m) sessionStorage.removeItem('tp_flash'); } catch (e) {}
    if (!m) return;
    setTimeout(function () { UI.toast(m); if (window.DS && DS.announce) DS.announce(m); }, 600);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', showFlash); else showFlash();

  /* ── Beskeder ── */
  UI.toast = function (msg) {
    try {
      if (typeof showToast === 'function') { showToast(msg); return; }
    } catch (e) {}
    if (window.DS && DS.announce) DS.announce(msg);
  };

  /* ── Gendannelse i en anden fane → genindlæs denne, så forældet tilstand ikke skrives tilbage ── */
  UI.watchRestore = function () {
    try {
      window.addEventListener('storage', function (e) {
        if (e.key === TP.RESTORE_EPOCH_KEY && e.newValue) { try { location.reload(); } catch (x) {} }
      });
    } catch (e) {}
  };
  UI.watchRestore();

  window.TPUI = UI;
})();
