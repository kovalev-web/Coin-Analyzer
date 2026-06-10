import { state, filteredCoins } from './state.js';
import {
  fetchCoins, analyzeCoinBySymbol, analyzeAll,
  loadCache, startChartPolling, fetchAllNATR, fetchNATR,
  fetchBriefingTrades, fetchAllBriefingTrades, fetchWeekTrades, generateWeeklySummary,
  fetchNotifications,
  fetchJournalToday, saveJournalMorning, saveJournalEvening, fetchJournalRecent,
} from './api.js';
import {
  render, openAnalysisPopup, setChartTF, openTVMode, closeTVMode, toggleTheme, clearLevels, clearAlerts, loadAlerts, handleAlertTriggered, openCoinFullView, closeCoinFullView, setFVChartTF, applyFVTradeMarkers,
  toggleBriefing, openBriefingPanel, closeBriefingPanel, loadBriefing, renderBriefingPanel,
  briefingNavDate, briefingCycleStatus, briefingRemove, briefingClearNote, toggleBpExpand, toggleFvExpand, briefingNoteAction,
  renderFVBriefingDrawer, toggleFVBriefingDrawer, openFVBriefingDrawer, closeFVBriefingDrawer, autoSetTradedStatus, syncBriefingNow, refreshBriefingFromServer, briefingJustSynced,
  openSearchPopup, closeSearchPopup, renderScreener, setScreenerMode, screenerCoins,
  openClearPopup, closeClearPopup, clearAllCrosshairs,
  forceUnlockScroll, reapplyOverlayPositions,
  setUserId, setUserEmail, setUserAvatar, showAccountModal,
  loadLevels, fetchServerLevels,
  toggleNotifDropdown, updateNotifBadge, showNotifToast, clearNotifications,
  showMorningModal, hideMorningModal, showEveningModal, hideEveningModal, renderProfileJournal, showToast,
  updateSessionTimer,
} from './ui.js';
import { on } from './events.js';
import { icon } from './utils.js';

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
    document.querySelectorAll('.tf-dd').forEach(function (el) { el.classList.remove('open'); });
    document.querySelectorAll('.coin-card.dd-open').forEach(function (el) { el.classList.remove('dd-open'); });
  }
}, { passive: true });

document.body.addEventListener('click', function (e) {
  // Close burger dropdown on any click outside .burger-wrap
  var burgerDd = document.getElementById('burger-dd');
  if (burgerDd && burgerDd.classList.contains('open') && !e.target.closest('.burger-wrap')) {
    burgerDd.classList.remove('open');
  }
  // Close avatar dropdown on any click outside .avatar-wrap
  var avatarDd = document.getElementById('avatar-dd');
  if (avatarDd && avatarDd.classList.contains('open') && !e.target.closest('.avatar-wrap')) {
    avatarDd.classList.remove('open');
  }
  // Close notifications dropdown on any click outside #notif-wrap
  var notifDd = document.getElementById('notif-dd');
  if (notifDd && notifDd.classList.contains('open') && !e.target.closest('#notif-wrap')) {
    notifDd.classList.remove('open');
  }

  // Close popups on any outside click — runs before data-action check so clicking
  // any button outside a popup (e.g. "expand", "open-ms") also closes it.
  var _aoPopup = document.getElementById('analysis-overlay');
  if (_aoPopup && _aoPopup.style.display === 'block' && !_aoPopup.contains(e.target) && !e.target.closest('[data-action="open-analysis"]') && !e.target.closest('[data-action="analyze"]')) {
    if (_aoPopup._popupCard) { _aoPopup._popupCard.style.overflow = ''; _aoPopup._popupCard = null; }
    _aoPopup.style.display = 'none';
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
    document.querySelectorAll('.tf-dd').forEach(function (el) { el.classList.remove('open'); });
    document.querySelectorAll('.coin-card.dd-open').forEach(function (el) { el.classList.remove('dd-open'); });
  }

  var target = e.target.closest('[data-action]');
  if (!target) return;

  var action = target.dataset.action;
  var sym = target.dataset.sym;
  var tf = target.dataset.tf;

  // Close burger on any action except its own toggle
  if (action !== 'toggle-burger' && action !== 'toggle-avatar-dd') {
    var _bdd = document.getElementById('burger-dd');
    if (_bdd) _bdd.classList.remove('open');
    var _add = document.getElementById('avatar-dd');
    if (_add) _add.classList.remove('open');
  }
  if (action !== 'toggle-notif' && action !== 'notif-open' && action !== 'notif-clear') {
    var _ndd = document.getElementById('notif-dd');
    if (_ndd) _ndd.classList.remove('open');
  }

  switch (action) {
    case 'toggle-burger': {
      e.stopPropagation();
      var bDd = document.getElementById('burger-dd');
      if (bDd) bDd.classList.toggle('open');
      break;
    }
    case 'toggle-avatar-dd': {
      e.stopPropagation();
      var aDd = document.getElementById('avatar-dd');
      if (aDd) aDd.classList.toggle('open');
      break;
    }
    case 'toggle-notif': {
      e.stopPropagation();
      toggleNotifDropdown();
      break;
    }
    case 'notif-open': {
      var _ndd2 = document.getElementById('notif-dd');
      if (_ndd2) _ndd2.classList.remove('open');
      openFV(sym);
      break;
    }
    case 'notif-clear': {
      e.stopPropagation();
      clearNotifications();
      break;
    }
    case 'analyze': {
      document.querySelectorAll('.tf-dd').forEach(function (el) { el.classList.remove('open'); });
      var c = state.coins.find(function (x) { return x.symbol === sym; });
      if (c) { openAnalysisPopup(sym, target); }
      break;
    }
    case 'open-analysis': {
      document.querySelectorAll('.tf-dd').forEach(function (el) { el.classList.remove('open'); });
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
        document.querySelectorAll('.tf-dd').forEach(function (el) { el.classList.remove('open'); });
        document.querySelectorAll('.coin-card.dd-open').forEach(function (el) { el.classList.remove('dd-open'); });
        dd.classList.toggle('open');
        var _card = target.closest('.coin-card');
        if (_card && dd.classList.contains('open')) _card.classList.add('dd-open');
      }
      break;
    }
    case 'tf-opt': {
      e.stopPropagation();
      document.querySelectorAll('.tf-dd').forEach(function (el) { el.classList.remove('open'); });
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
        var _anchor = target.closest('.coin-card') || target.closest('#fv-overlay');
        if (_anchor) {
          var _old = _anchor.querySelector('._ctip');
          if (_old) _old.remove();
          var _ar = _anchor.getBoundingClientRect();
          var _tr = target.getBoundingClientRect();
          var _tip = document.createElement('div');
          _tip.className = '_ctip';
          _tip.textContent = 'Ticker copied';
          _tip.style.cssText = 'position:absolute;left:' + Math.round(_tr.left - _ar.left) + 'px;top:' + Math.round(_tr.bottom - _ar.top + 4) + 'px;background:var(--ink-deep);color:var(--canvas);font-size:var(--text-xs);font-family:var(--font-family);font-weight:var(--font-medium);padding:var(--space-2) var(--space-5);border-radius:var(--radius-md);pointer-events:none;z-index:50;white-space:nowrap;';
          _anchor.appendChild(_tip);
          setTimeout(function () { if (_tip.parentNode) _tip.remove(); }, 1400);
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
        document.querySelectorAll('.tf-dd').forEach(function (el) { el.classList.remove('open'); });
        fvDd.classList.toggle('open');
      }
      break;
    }
    case 'fv-tf-opt': {
      e.stopPropagation();
      document.querySelectorAll('.tf-dd').forEach(function (el) { el.classList.remove('open'); });
      setFVChartTF(target.dataset.tf);
      break;
    }
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
    case 'open-account':
      showAccountModal();
      break;
    case 'open-evening-journal':
      showEveningModal();
      break;
    case 'close-evening-journal':
      hideEveningModal();
      break;
    case 'save-morning-journal': {
      var mBtn = target;
      mBtn.disabled = true;
      var mModal = document.getElementById('morning-journal-modal');
      saveJournalMorning({
        morningState: mModal.querySelector('[name="morningState"]').value.trim(),
        volume:       mModal.querySelector('[name="volume"]').value.trim(),
        dayPlan:      mModal.querySelector('[name="dayPlan"]').value.trim(),
      }).then(function () {
        hideMorningModal();
      }).catch(function () {
        mBtn.disabled = false;
        showToast('Network error — please try again');
      });
      break;
    }
    case 'save-evening-journal': {
      var eBtn = target;
      eBtn.disabled = true;
      var eModal = document.getElementById('evening-journal-modal');
      saveJournalEvening({
        followedProcess:  eModal.querySelector('[name="followedProcess"]').value,
        tradedPlanned:    eModal.querySelector('[name="tradedPlanned"]').value,
        tradeCount:       parseInt(eModal.querySelector('[name="tradeCount"]').value) || 0,
        stopCraneKept:    eModal.querySelector('[name="stopCraneKept"]').value,
        volumeOk:         eModal.querySelector('[name="volumeOk"]').value,
        triggerFired:     eModal.querySelector('[name="triggerFired"]').value,
        eveningState:     eModal.querySelector('[name="eveningState"]').value.trim(),
        feltWorthless:    eModal.querySelector('[name="feltWorthless"]').value,
        freeConclusion:   eModal.querySelector('[name="freeConclusion"]').value.trim(),
      }).then(function () {
        hideEveningModal();
        showToast('Review saved');
      }).catch(function () {
        eBtn.disabled = false;
        showToast('Network error — please try again');
      });
      break;
    }
    case 'logout': {
      var _wsEnv2 = import.meta.env.VITE_WS_URL || '';
      var _apiBase2 = _wsEnv2.replace(/^wss?:\/\//, 'https://').replace(/\/ws$/, '');
      fetch(_apiBase2 + '/auth/sign-out', { method: 'POST', credentials: 'include' })
        .finally(function () { window.location.replace('/login'); });
      break;
    }
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
      var _td = new Date();
      var today = _td.getFullYear() + '-' + String(_td.getMonth() + 1).padStart(2, '0') + '-' + String(_td.getDate()).padStart(2, '0');
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
      target.disabled = true;
      target.classList.add('btn-loading');
      fetchWeekTrades(true);
      break;
    case 'bp-gen-ai': {
      var _aiBtn = target;
      _aiBtn.disabled = true;
      _aiBtn.classList.add('btn-loading');
      generateWeeklySummary().catch(function (e) { console.error('AI summary:', e); }).finally(function () {
        _aiBtn.disabled = false;
        _aiBtn.classList.remove('btn-loading');
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

on('notify:received', function (entry) {
  updateNotifBadge();
  showNotifToast(entry);
});

on('notify:ready', function () {
  updateNotifBadge();
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
var _appHiddenAt = null;
document.addEventListener('visibilitychange', function () {
  if (document.hidden) {
    syncBriefingNow();
    _appHiddenAt = Date.now();
  } else {
    refreshBriefingFromServer();
    // Re-check session after long background (>5 min) — handles iOS killing the tab
    if (_appHiddenAt && Date.now() - _appHiddenAt > 5 * 60 * 1000) {
      _revalidateSession();
    }
    _appHiddenAt = null;
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

// Session timer (Asia/Europe/America) — refresh every 30s
setInterval(updateSessionTimer, 30000);

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
  document.querySelectorAll('.tf-dd').forEach(function (el) { el.classList.remove('open'); });
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
      render(); startChartPolling();
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
  app.innerHTML = '<div class="topbar" style="padding:var(--space-12) var(--space-16);margin:var(--space-10) var(--space-16) 0;">' +
    '<h2 style="font-size:var(--text-lg);font-weight:var(--font-bold);margin-bottom:var(--space-6);">⚙️ Settings</h2>' +
    '<p style="color:var(--graphite);font-size:var(--text-sm);">Settings page — coming soon.</p>' +
    '<p style="color:var(--graphite);font-size:var(--text-sm);margin-top:var(--space-4);">Planned: notifications, default filters, subscription management.</p>' +
    '<a href="#/" style="display:inline-block;margin-top:var(--space-8);color:var(--primary);font-weight:var(--font-semi);text-decoration:none;">← Back to home</a>' +
    '</div>';
});

registerRoute('/journal', function () {
  var app = document.getElementById('app');
  app.innerHTML = '<div class="topbar" style="padding:var(--space-12) var(--space-16);margin:var(--space-10) var(--space-16) 0;">' +
    '<div style="display:flex;align-items:center;gap:var(--space-8);margin-bottom:var(--space-6);">' +
    '<h2 style="display:flex;align-items:center;gap:var(--space-4);font-size:var(--text-lg);font-weight:var(--font-bold);">' + icon('book-open', 18) + 'Journal</h2>' +
    '<button data-action="open-evening-journal" class="btn-cta" style="margin-left:auto;height:var(--h-input);">Evening review</button>' +
    '</div>' +
    '<div id="profile-journal-section"></div>' +
    '<a href="#/" style="display:inline-block;margin-top:var(--space-8);color:var(--primary);font-weight:var(--font-semi);text-decoration:none;">← Back to home</a>' +
    '</div>';
  fetchJournalRecent().then(function (entries) {
    renderProfileJournal(document.getElementById('profile-journal-section'), entries);
  });
});

registerRoute('/404', function () {
  var app = document.getElementById('app');
  app.innerHTML = '<div class="topbar" style="padding:var(--space-12) var(--space-16);margin:var(--space-10) var(--space-16) 0;">' +
    '<h2 style="font-size:var(--text-lg);font-weight:var(--font-bold);margin-bottom:var(--space-6);">404 — Page not found</h2>' +
    '<a href="#/" style="color:var(--primary);font-weight:var(--font-semi);text-decoration:none;">← Back to home</a>' +
    '</div>';
});

// ── Init ───────────────────────────────────────────────────────────────────

var _API_BASE = (import.meta.env.VITE_WS_URL || '').replace(/^wss?:\/\//, 'https://').replace(/\/ws$/, '');
var _sessionVerified = false; // true once session confirmed — prevents double-init on revalidate

// Fetch session and apply user state. Returns true (ok), false (no session → redirected), null (network err).
async function _applySession() {
  try {
    var r = await fetch(_API_BASE + '/auth/get-session', { credentials: 'include' });
    if (!r.ok) { window.location.replace('/login'); return false; }
    var s = await r.json();
    if (!s || !s.user || !s.user.id) { window.location.replace('/login'); return false; }
    setUserId(s.user.id);
    if (s.user.email) setUserEmail(s.user.email);

    return true;
  } catch (e) {
    return null; // network error — caller decides
  }
}

// Re-check session when returning from long background.
// Updates emailVerified badge and catches expired sessions without a full reload.
async function _revalidateSession() {
  var result = await _applySession();
  if (result === null) return; // server unreachable — keep current state, WS will surface it
  // result === false → already redirected to /login
  // result === true → userId/emailVerified refreshed; if first successful auth, load user data
  if (result === true && !_sessionVerified) {
    _sessionVerified = true;
    loadAlerts();
    loadBriefing();
    fetchServerLevels();
    fetchNotifications();
  }
}

// Show the morning journal modal once per day, between 09:30 and 00:00 MSK.
function _checkMorningGate() {
  // Москва = UTC+3. Утренний гейт: 09:30 МСК = 06:30 UTC
  var now = new Date();
  var minutesUTC = now.getUTCHours() * 60 + now.getUTCMinutes();
  var gateUTC = 6 * 60 + 30; // 06:30 UTC = 09:30 МСК
  var endUTC  = 21 * 60;     // 21:00 UTC = 00:00 МСК — ночью не показываем
  if (minutesUTC < gateUTC || minutesUTC >= endUTC) return;
  if (!state.journalToday || !state.journalToday.morningAt) {
    showMorningModal();
  }
}

// Check session first — redirect to /login if not authenticated.
// On network error (server down) we still load the app so WS reconnect can recover.
(async function () {
  var result = await _applySession();
  if (result === false) return; // redirected
  if (result === true) {
    _sessionVerified = true;
    fetch(_API_BASE + '/api/account', { credentials: 'include' })
      .then(function (ar) { return ar.json(); })
      .then(function (d) { if (d.avatar) setUserAvatar(d.avatar); })
      .catch(function () {});
    fetchJournalToday().then(function () {
      _checkMorningGate();
    });
  }
  // result === null: server unreachable — load app anyway; WS will surface the error

  loadCache();
  loadAlerts();
  loadBriefing();
  loadLevels();
  fetchNotifications();
  initRouter('/');
})();
