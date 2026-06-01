import { state, filteredCoins } from './state.js';
import {
  fetchCoins, analyzeCoinBySymbol, analyzeAll,
  fetchMarketStrength, loadCache, startChartPolling, startMSPolling, fetchAllNATR, fetchNATR,
  fetchBriefingTrades, fetchAllBriefingTrades, fetchWeekTrades, generateWeeklySummary,
} from './api.js';
import {
  render, openAnalysisPopup, openMSPopup, closeMSPopup, setChartTF, openTVMode, closeTVMode, toggleTheme, clearLevels, showCodeModal, clearAlerts, loadAlerts, handleAlertTriggered, openCoinFullView, closeCoinFullView, setFVChartTF, applyFVTradeMarkers,
  toggleBriefing, openBriefingPanel, closeBriefingPanel, loadBriefing, renderBriefingPanel,
  briefingNavDate, briefingCycleStatus, briefingRemove, briefingClearNote, toggleBpExpand, toggleFvExpand, briefingNoteAction,
  renderFVBriefingDrawer, toggleFVBriefingDrawer, openFVBriefingDrawer, closeFVBriefingDrawer, autoSetTradedStatus, syncBriefingNow, refreshBriefingFromServer, briefingJustSynced,
  openSearchPopup, closeSearchPopup, renderScreener, setScreenerMode, screenerCoins,
  openClearPopup, closeClearPopup, clearAllCrosshairs,
  forceUnlockScroll, reapplyOverlayPositions,
} from './ui.js';
import { on } from './events.js';

function openFV(sym) {
  openCoinFullView(sym);
  if (!state.natrData[sym] || state.natrData[sym] === 'error') fetchNATR(sym);
}
import { initRouter, registerRoute } from './router.js';
import './styles.css';

// ── Event delegation ───────────────────────────────────────────────────────

// Close tf-dd on touch outside .tf-picker (mobile — click doesn't fire over chart)
document.body.addEventListener('touchstart', function (e) {
  if (!e.target.closest('.tf-picker')) {
    document.querySelectorAll('.tf-dd').forEach(function (el) { el.style.display = 'none'; });
    document.querySelectorAll('.coin-card.dd-open').forEach(function (el) { el.classList.remove('dd-open'); });
  }
}, { passive: true });

document.body.addEventListener('click', function (e) {
  // Close burger dropdown on any click outside .burger-wrap
  var burgerDd = document.getElementById('burger-dd');
  if (burgerDd && burgerDd.classList.contains('open') && !e.target.closest('.burger-wrap')) {
    burgerDd.classList.remove('open');
  }

  // Close popups on any outside click — runs before data-action check so clicking
  // any button outside a popup (e.g. "expand", "open-ms") also closes it.
  var _aoPopup = document.getElementById('analysis-overlay');
  if (_aoPopup && _aoPopup.style.display === 'block' && !_aoPopup.contains(e.target) && !e.target.closest('[data-action="open-analysis"]') && !e.target.closest('[data-action="analyze"]')) {
    if (_aoPopup._popupCard) { _aoPopup._popupCard.style.overflow = ''; _aoPopup._popupCard = null; }
    _aoPopup.style.display = 'none';
  }
  var _msPopup = document.getElementById('ms-popup');
  if (_msPopup && _msPopup.style.display !== 'none' && !_msPopup.contains(e.target) && !e.target.closest('[data-action="open-ms"]')) {
    _msPopup.style.display = 'none';
  }
  var _bpPopup = document.getElementById('bp-popup');
  if (_bpPopup && _bpPopup.style.display !== 'none' && !_bpPopup.contains(e.target) && !e.target.closest('[data-action="open-briefing"]')) {
    closeBriefingPanel();
  }
  var _searchPopup = document.getElementById('search-popup');
  if (_searchPopup && _searchPopup.style.display !== 'none' && !_searchPopup.contains(e.target) && !e.target.closest('[data-action="open-search"]')) {
    _searchPopup.style.display = 'none';
  }
  var _clearPopup = document.getElementById('clear-popup');
  if (_clearPopup && !_clearPopup.contains(e.target) && !e.target.closest('[data-action="open-clear-popup"]')) {
    closeClearPopup();
  }

  // Close tf-dd on any click outside .tf-picker
  if (!e.target.closest('.tf-picker')) {
    document.querySelectorAll('.tf-dd').forEach(function (el) { el.style.display = 'none'; });
    document.querySelectorAll('.coin-card.dd-open').forEach(function (el) { el.classList.remove('dd-open'); });
  }

  var target = e.target.closest('[data-action]');
  if (!target) return;

  var action = target.dataset.action;
  var sym = target.dataset.sym;
  var tf = target.dataset.tf;

  // Close burger on any action except its own toggle
  if (action !== 'toggle-burger') {
    var _bdd = document.getElementById('burger-dd');
    if (_bdd) _bdd.classList.remove('open');
  }

  switch (action) {
    case 'toggle-burger': {
      e.stopPropagation();
      var bDd = document.getElementById('burger-dd');
      if (bDd) bDd.classList.toggle('open');
      break;
    }
    case 'analyze': {
      document.querySelectorAll('.tf-dd').forEach(function (el) { el.style.display = 'none'; });
      var c = state.coins.find(function (x) { return x.symbol === sym; });
      if (c) { openAnalysisPopup(sym, target); }
      break;
    }
    case 'open-analysis': {
      document.querySelectorAll('.tf-dd').forEach(function (el) { el.style.display = 'none'; });
      openAnalysisPopup(sym, target);
      break;
    }
    case 'reanalyze': {
      delete state.analysisCache[sym];
      var popup = document.getElementById('analysis-overlay');
      if (popup) {
        popup.querySelector('.ao-spinner').style.display = 'flex';
        popup.querySelector('.ao-content').style.display = 'none';
      }
      analyzeCoinBySymbol(sym);
      break;
    }
    case 'close-analysis': {
      var ap = document.getElementById('analysis-overlay');
      if (ap) {
        if (ap._popupCard) { ap._popupCard.style.overflow = ''; ap._popupCard = null; }
        ap.style.display = 'none';
        // Only unlock if this popup called lockScroll (touch-fullscreen mode).
        // On desktop (positioned popup), _lockedScroll is not set — don't touch the lock.
        if (ap._lockedScroll) { ap._lockedScroll = false; forceUnlockScroll(); }
      }
      break;
    }
    case 'tf-pick': {
      e.stopPropagation();
      var dd = target.parentElement.querySelector('.tf-dd');
      if (dd) {
        document.querySelectorAll('.tf-dd').forEach(function (el) { el.style.display = 'none'; });
        document.querySelectorAll('.coin-card.dd-open').forEach(function (el) { el.classList.remove('dd-open'); });
        dd.style.display = dd.style.display === 'none' ? 'block' : 'none';
        var _card = target.closest('.coin-card');
        if (_card && dd.style.display === 'block') _card.classList.add('dd-open');
      }
      break;
    }
    case 'tf-opt': {
      e.stopPropagation();
      document.querySelectorAll('.tf-dd').forEach(function (el) { el.style.display = 'none'; });
      document.querySelectorAll('.coin-card.dd-open').forEach(function (el) { el.classList.remove('dd-open'); });
      if (sym) setChartTF(sym, tf);
      break;
    }
    case 'analyze-all': {
      if (state.analyzingAll) { state.analyzeAllAbort = true; }
      else { analyzeAll(); }
      break;
    }
    case 'refresh': {
      var _logo = e.target.closest('.topbar-logo');
      if (_logo) {
        _logo.classList.add('logo-wiggle');
        setTimeout(function () { location.reload(); }, 450);
      } else {
        location.reload();
      }
      break;
    }
    case 'sort': {
      var col = target.dataset.col;
      if (state.sortCol === col) { state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc'; }
      else { state.sortCol = col; state.sortDir = 'desc'; }
      render();
      break;
    }
    case 'pick-tier': {
      state.volTier = target.dataset.val;
      render();
      fetchAllNATR(filteredCoins());
      break;
    }
    case 'cycle-tier': {
      var _tiers = ['high', 'mid', 'low'];
      state.volTier = _tiers[(_tiers.indexOf(state.volTier) + 1) % _tiers.length];
      render();
      fetchAllNATR(filteredCoins());
      break;
    }
    case 'expand': {
      openFV(sym);
      break;
    }
    case 'close-fv': {
      closeCoinFullView();
      break;
    }
    case 'copy-sym': {
      if (sym) {
        navigator.clipboard.writeText(sym.toUpperCase()).catch(function () {});
        var _toast = document.getElementById('toast');
        if (_toast) {
          clearTimeout(_toast._t1); clearTimeout(_toast._t2);
          _toast.textContent = 'Тикер скопирован';
          _toast.style.display = 'block';
          _toast.style.opacity = '1';
          _toast.style.transition = '';
          var _r = target.getBoundingClientRect();
          _toast.style.bottom = 'auto';
          _toast.style.transform = 'none';
          _toast.style.left = _r.left + 'px';
          _toast.style.top = (_r.bottom + 6) + 'px';
          _toast._t1 = setTimeout(function () { _toast.style.transition = 'opacity 0.3s'; _toast.style.opacity = '0'; }, 1200);
          _toast._t2 = setTimeout(function () { _toast.style.display = 'none'; }, 1500);
        }
      }
      break;
    }
    case 'fv-tf-pick': {
      e.stopPropagation();
      var _ao = document.getElementById('analysis-overlay');
      if (_ao && _ao.style.display === 'block') { if (_ao._popupCard) { _ao._popupCard.style.overflow = ''; _ao._popupCard = null; } _ao.style.display = 'none'; }
      var fvDd = target.closest('.tf-picker').querySelector('.tf-dd');
      if (fvDd) {
        document.querySelectorAll('.tf-dd').forEach(function (el) { el.style.display = 'none'; });
        fvDd.style.display = fvDd.style.display === 'none' ? 'block' : 'none';
      }
      break;
    }
    case 'fv-tf-opt': {
      e.stopPropagation();
      document.querySelectorAll('.tf-dd').forEach(function (el) { el.style.display = 'none'; });
      setFVChartTF(target.dataset.tf);
      break;
    }
    case 'open-ms':
      openMSPopup();
      break;
    case 'close-ms':
      closeMSPopup();
      break;
    case 'refresh-ms':
      fetchMarketStrength(true);
      break;
    case 'toggle-theme':
      toggleTheme();
      break;
    case 'tv':
      openTVMode();
      break;
    case 'close-tv':
      closeTVMode();
      break;
    case 'clear-levels':
      closeClearPopup();
      clearLevels(sym);
      break;
    case 'clear-alerts':
      closeClearPopup();
      clearAlerts(sym);
      break;
    case 'open-clear-popup':
      openClearPopup(sym, target);
      break;
    case 'open-search':
      openSearchPopup();
      break;
    case 'close-search':
      closeSearchPopup();
      break;
    case 'search-pick':
      closeSearchPopup();
      openFV(sym);
      break;
    case 'open-settings':
      showCodeModal();
      break;
    case 'toggle-briefing':
      toggleBriefing(sym);
      break;
    case 'open-briefing':
      openBriefingPanel();
      fetchBriefingTrades(state.briefingViewDate || new Date().toISOString().slice(0, 10));
      break;
    case 'close-briefing':
      closeBriefingPanel();
      break;
    case 'bp-prev-date':
      briefingNavDate(-1);
      fetchBriefingTrades(state.briefingViewDate || new Date().toISOString().slice(0, 10));
      break;
    case 'bp-next-date':
      briefingNavDate(+1);
      fetchBriefingTrades(state.briefingViewDate || new Date().toISOString().slice(0, 10));
      break;
    case 'bp-cycle-status': {
      var bStatusDate = target.dataset.date;
      briefingCycleStatus(sym, bStatusDate);
      break;
    }
    case 'bp-open':
      closeBriefingPanel();
      openFV(sym);
      setTimeout(function () { openFVBriefingDrawer(); fetchAllBriefingTrades().then(function () { fetchWeekTrades(); }); }, 50);
      break;
    case 'go-briefing': {
      var today = new Date().toISOString().slice(0, 10);
      var first = (state.briefing || []).find(function (e) { return e.date === today; });
      if (!first) {
        // Find the most recent past date and take its first entry
        var latestPastDate = '';
        (state.briefing || []).forEach(function (e) { if (e.date < today && e.date > latestPastDate) latestPastDate = e.date; });
        if (latestPastDate) first = (state.briefing || []).find(function (e) { return e.date === latestPastDate; });
      }
      if (first) {
        closeBriefingPanel();
        openFV(first.sym);
        setTimeout(function () { openFVBriefingDrawer(); fetchAllBriefingTrades().then(function () { fetchWeekTrades(); }); }, 50);
      }
      break;
    }
    case 'close-fv-briefing':
      closeFVBriefingDrawer();
      break;
    case 'bp-remove': {
      var bRemoveDate = target.dataset.date;
      briefingRemove(sym, bRemoveDate);
      break;
    }
    case 'bp-clear-note': {
      var bClearDate = target.dataset.date;
      briefingClearNote(sym, bClearDate, target.closest('.bp-note-row'));
      break;
    }
    case 'bp-expand': {
      var bExpandDate = target.dataset.date;
      toggleBpExpand(sym, bExpandDate);
      break;
    }
    case 'bp-note-action': {
      var bNoteDate = target.dataset.date;
      briefingNoteAction(sym, bNoteDate, target.closest('.bp-note-row'), target);
      break;
    }
    case 'fvbd-expand': {
      var fvExpandDate = target.dataset.date;
      toggleFvExpand(sym, fvExpandDate);
      break;
    }
    case 'toggle-fv-briefing':
      toggleFVBriefingDrawer();
      fetchAllBriefingTrades().then(function () { fetchWeekTrades(); });
      break;
    case 'fvbd-open':
      openFV(sym);
      break;
    case 'fvbd-tab':
      state.briefingTab = target.dataset.tab;
      renderFVBriefingDrawer();
      break;
    case 'bp-load-week':
      target.innerHTML = '<span class="spinner" style="margin-right:0"></span>';
      target.disabled = true;
      fetchWeekTrades(true);
      break;
    case 'bp-gen-ai': {
      var _aiBtn = target;
      _aiBtn.disabled = true;
      _aiBtn.textContent = 'Генерирую...';
      generateWeeklySummary().catch(function (e) { console.error('AI summary:', e); }).finally(function () {
        _aiBtn.disabled = false;
        _aiBtn.textContent = 'Обновить';
      });
      break;
    }
    case 'go-main':
      window.location.hash = '#/';
      break;
    case 'go-screener':
      window.location.hash = '#/screener';
      break;
  }
});

// ── WS events ─────────────────────────────────────────────────────────────

on('alert:triggered', function (msg) {
  handleAlertTriggered(msg.sym, msg.price);
});

// Soft refresh — skips coins that already have NATR (initial load, new coins)
on('natr:refresh', function () {
  fetchAllNATR(screenerCoins());
  fetchAllNATR(filteredCoins());
});
// Force refresh — re-fetches all (5-min interval, back from background, UTC day change)
on('natr:force-refresh', function () {
  fetchAllNATR(screenerCoins(), true);
  fetchAllNATR(filteredCoins(), true);
});

// Re-render briefing pills when trade data arrives
on('trades:updated', function () {
  autoSetTradedStatus();
  var popup = document.getElementById('bp-popup');
  if (popup && popup.style.display !== 'none') renderBriefingPanel();
  var drawer = document.getElementById('fv-briefing-drawer');
  if (drawer && drawer.classList.contains('open')) renderFVBriefingDrawer();
  applyFVTradeMarkers();
});

// Re-render weekly summary block when week aggregate is ready
on('trades:week-updated', function () {
  var drawer = document.getElementById('fv-briefing-drawer');
  if (drawer && drawer.classList.contains('open')) renderFVBriefingDrawer();
});

// Re-render AI summary text when Gemini responds
on('trades:ai-updated', function () {
  var drawer = document.getElementById('fv-briefing-drawer');
  if (drawer && drawer.classList.contains('open')) renderFVBriefingDrawer();
});

// Sync on hide, pull from server on show — bidirectional cross-device sync
document.addEventListener('visibilitychange', function () {
  if (document.hidden) {
    syncBriefingNow();
  } else {
    refreshBriefingFromServer();
  }
});

function _briefingRefreshSafe() {
  // Don't refresh while typing in a textarea
  var a = document.activeElement;
  if (a && a.tagName === 'TEXTAREA' && a.dataset.sym) return;
  // Don't refresh if we just synced (avoids re-render on our own WS push)
  if (briefingJustSynced()) return;
  refreshBriefingFromServer();
}

// WS push: another device saved briefing → refresh immediately
on('briefing:updated', function () { _briefingRefreshSafe(); });

// Fallback poll every 15s when briefing is open (covers WS gaps/reconnects)
setInterval(function () {
  if (document.hidden) return;
  var popup = document.getElementById('bp-popup');
  var drawer = document.getElementById('fv-briefing-drawer');
  if ((popup && popup.style.display !== 'none') || (drawer && drawer.classList.contains('open'))) {
    _briefingRefreshSafe();
  }
}, 15000);

// ── Orientation change: close transient UI, re-anchor full-screen overlays ─

window.addEventListener('orientationchange', function () {
  closeMSPopup();
  closeClearPopup();
  // Close only dropdown-mode popups (positions stale after resize).
  // Fullscreen-mode popups (_isFullscreenMode / _lockedScroll) stay open — reapplyOverlayPositions handles them.
  var _sp = document.getElementById('search-popup');
  if (_sp && _sp.style.display !== 'none' && !_sp._isFullscreenMode) closeSearchPopup();
  var _bp = document.getElementById('bp-popup');
  if (_bp && _bp.style.display !== 'none' && !_bp._isFullscreenMode) closeBriefingPanel();
  var _ao = document.getElementById('analysis-overlay');
  if (_ao && _ao.style.display !== 'none' && !_ao._lockedScroll) {
    _ao.style.display = 'none';
    if (_ao._popupCard) { _ao._popupCard.style.overflow = ''; _ao._popupCard = null; }
  }
  var ids = ['fv-touch-menu', 'fv-add-btn', 'fv-drag-handle'];
  ids.forEach(function (id) { var el = document.getElementById(id); if (el) el.remove(); });
  document.querySelectorAll('.tf-dd').forEach(function (el) { el.style.display = 'none'; });
  clearAllCrosshairs();

  // iOS needs ~300ms after orientationchange before the new viewport dimensions
  // are reported. Re-apply fixed positions so overlays fill the new viewport.
  setTimeout(reapplyOverlayPositions, 300);
});

// ── Connectivity ────────────────────────────────────────────────────────────

window.addEventListener('offline', function () {
  state.error = 'Нет подключения к интернету.';
  render();
});
window.addEventListener('online', function () {
  if (state.error && state.error.startsWith('Нет подключения')) {
    state.error = null;
    fetchCoins();
  }
});

// ── Router ─────────────────────────────────────────────────────────────────

registerRoute('/', function () {
  setScreenerMode(false);
  render();
  var _autoSym = (new URLSearchParams(window.location.search).get('sym') || '').toLowerCase();
  if (_autoSym) history.replaceState(null, '', window.location.pathname + (window.location.hash || ''));
  if (state.coins.length === 0) {
    fetchCoins().then(function () {
      render(); startChartPolling(); fetchMarketStrength(false); startMSPolling();
      if (_autoSym) openFV(_autoSym);
    });
  } else if (_autoSym) {
    openFV(_autoSym);
  }
});

registerRoute('/screener', function () {
  if (state.coins.length === 0) {
    fetchCoins().then(function () { renderScreener(); startChartPolling(); fetchAllNATR(screenerCoins()); });
  } else {
    renderScreener();
    fetchAllNATR(screenerCoins());
  }
});


registerRoute('/settings', function () {
  var app = document.getElementById('app');
  app.innerHTML = '<div class="topbar" style="padding:24px 32px;margin:20px 32px 0;">' +
    '<h2 style="font-size:18px;font-weight:700;margin-bottom:12px;">⚙️ Настройки</h2>' +
    '<p style="color:var(--graphite);font-size:14px;">Страница настроек — в разработке.</p>' +
    '<p style="color:var(--graphite);font-size:14px;margin-top:8px;">Здесь будут: уведомления, фильтры по умолчанию, управление подписками.</p>' +
    '<a href="#/" style="display:inline-block;margin-top:16px;color:var(--primary);font-weight:600;text-decoration:none;">← На главную</a>' +
    '</div>';
});

registerRoute('/profile', function () {
  var app = document.getElementById('app');
  app.innerHTML = '<div class="topbar" style="padding:24px 32px;margin:20px 32px 0;">' +
    '<h2 style="font-size:18px;font-weight:700;margin-bottom:12px;">👤 Профиль</h2>' +
    '<p style="color:var(--graphite);font-size:14px;">Страница профиля — в разработке.</p>' +
    '<p style="color:var(--graphite);font-size:14px;margin-top:8px;">Здесь будут: история анализов, избранные монеты, настройки аккаунта.</p>' +
    '<a href="#/" style="display:inline-block;margin-top:16px;color:var(--primary);font-weight:600;text-decoration:none;">← На главную</a>' +
    '</div>';
});

registerRoute('/404', function () {
  var app = document.getElementById('app');
  app.innerHTML = '<div class="topbar" style="padding:24px 32px;margin:20px 32px 0;">' +
    '<h2 style="font-size:18px;font-weight:700;margin-bottom:12px;">404 — Страница не найдена</h2>' +
    '<a href="#/" style="color:var(--primary);font-weight:600;text-decoration:none;">← На главную</a>' +
    '</div>';
});

// ── Init ───────────────────────────────────────────────────────────────────

loadCache();
loadAlerts();
loadBriefing();

// Show code modal on first visit (no code set yet)
if (!localStorage.getItem('pa_user_code')) showCodeModal();

initRouter('/');
