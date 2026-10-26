/* ═══════════════════════════════════════════════════════════════════════════
   TRÆNING — FÆLLES ADFÆRD (tilgængelighed) for dashboard, SBD og løb
   Semantik (roller, labels, aria-*) ligger i HTML'en/skabelonerne. Denne fil
   rummer kun ADFÆRD, som ikke kan udtrykkes i markup:
     1) Fokusstyring for overlays/modaler  (.modal-overlay, .timer-overlay)
     2) Piletast-navigation i role="tablist"
     3) En høflig live-region til statusbeskeder  (DS.announce)
   Ingen afhængigheder. Ingen global MutationObserver på body.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  var FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

  /* ── 3) Live-region ── */
  var live = null;
  function ensureLive() {
    if (live) return live;
    live = document.createElement('div');
    live.className = 'sr-only';
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');
    live.setAttribute('aria-atomic', 'true');
    document.body.appendChild(live);
    return live;
  }
  function announce(msg) {
    var el = ensureLive();
    el.textContent = '';
    setTimeout(function () { el.textContent = String(msg); }, 30);
  }

  /* ── 1) Fokusstyring for overlays ── */
  function visible(el) { return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length); }
  function focusables(root) { return Array.prototype.filter.call(root.querySelectorAll(FOCUSABLE), visible); }

  function watchOverlay(overlay, opts) {
    if (!overlay || overlay.__dsWatched) return;
    overlay.__dsWatched = true;
    opts = opts || {};
    var opener = null;
    var wasOpen = overlay.classList.contains('open');
    function onKey(e) {
      if (!overlay.classList.contains('open')) return;
      if (e.key === 'Escape' && opts.escape) {
        var btn = overlay.querySelector(opts.escape);
        if (btn) { e.preventDefault(); btn.click(); }
        return;
      }
      if (e.key !== 'Tab') return;
      var f = focusables(overlay);
      if (!f.length) { e.preventDefault(); return; }
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && (document.activeElement === first || !overlay.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !overlay.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', onKey);
    new MutationObserver(function () {
      var open = overlay.classList.contains('open');
      if (open && !wasOpen) {
        opener = document.activeElement;
        setTimeout(function () {
          var target = overlay.querySelector('[data-autofocus]') || focusables(overlay)[0];
          if (target) target.focus();
        }, 0);
      } else if (!open && wasOpen) {
        if (opener && document.contains(opener) && typeof opener.focus === 'function') { try { opener.focus(); } catch (e) {} }
        opener = null;
      }
      wasOpen = open;
    }).observe(overlay, { attributes: true, attributeFilter: ['class'] });
  }

  /* ── 2) Piletaster i tablist (automatisk aktivering) ── */
  document.addEventListener('keydown', function (e) {
    var t = e.target;
    if (!t || !t.getAttribute || t.getAttribute('role') !== 'tab') return;
    var list = t.closest('[role="tablist"]');
    if (!list) return;
    var tabs = Array.prototype.filter.call(list.querySelectorAll('[role="tab"]'), visible);
    var i = tabs.indexOf(t), n = tabs.length, to = -1;
    var vertical = list.getAttribute('aria-orientation') === 'vertical';
    var next = vertical ? 'ArrowDown' : 'ArrowRight', prev = vertical ? 'ArrowUp' : 'ArrowLeft';
    if (e.key === next) to = (i + 1) % n;
    else if (e.key === prev) to = (i - 1 + n) % n;
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = n - 1;
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); t.click(); return; }
    if (to < 0) return;
    e.preventDefault();
    tabs[to].focus();
    tabs[to].click();
  });

  function init() {
    watchOverlay(document.getElementById('modal'), { escape: '.modal-cancel' });
    watchOverlay(document.getElementById('timer-overlay'), {});
    document.querySelectorAll('[data-ds-overlay]').forEach(function (o) { watchOverlay(o, { escape: o.getAttribute('data-ds-escape') || null }); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

  window.DS = { announce: announce, watchOverlay: watchOverlay };
})();
