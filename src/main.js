import { state, filteredCoins } from './state.js';
import {
  fetchCoins, analyzeCoinBySymbol, analyzeAll,
  loadCache, startChartPolling, fetchAllNATR, fetchNATR,
  fetchBriefingTrades, fetchAllBriefingTrades,
  fetchNotifications,
  fetchJournalToday, saveJournalMorning, saveJournalEvening, fetchJournalRecent,
} from './api.js';
import {
  render, openAnalysisPopup, openLiquidityPopup, openOriginPopup, setChartTF, openTVMode, closeTVMode, toggleTheme, clearLevels, clearAlerts, clearRays, loadAlerts, handleAlertTriggered, openCoinFullView, closeCoinFullView, setFVChartTF, applyFVTradeMarkers, openFVNote,
  toggleBriefing, openBriefingPanel, closeBriefingPanel, loadBriefing, renderBriefingPanel,
  isBriefingPanelOpen,
  renderFVBriefingDrawer, toggleFVBriefingDrawer, openFVBriefingDrawer, closeFVBriefingDrawer, autoSetTradedStatus, syncBriefingNow, refreshBriefingFromServer, briefingJustSynced,
  openSearchPopup, closeSearchPopup, renderScreener, setScreenerMode, screenerCoins,
  openClearPopup, closeClearPopup, clearAllCrosshairs,
  forceUnlockScroll, reapplyOverlayPositions, resyncChartLayouts,
  setUserId, setUserEmail, setUserAvatar,
  loadLevels, fetchServerLevels, loadRays, fetchServerRays,
  toggleNotifDropdown, updateNotifBadge, showNotifToast, clearNotifications, markNotificationAsRead, requestDesktopNotifPermission,
  renderProfileJournal, showToast,
  showWeeklyReportModal, hideWeeklyReportModal,
  openHintsPopup, closeHintsPopup,
  updateSessionTimer, injectDemoBanner,
  briefingThisWeekEntries,
} from './ui.js';
import { toggleTerminal } from './terminal.js';
import { openMorningJournal, openEveningJournal } from './journal-cards.js';
import { preloadReactHost, closeSurface, toast } from './react-bridge.js';
import { mountIsland, unmountIslands } from './react/islands.jsx';
import { NotFound } from './react/home/HomeState.jsx';
import { on } from './events.js';
import { icon, tzDateStr } from './utils.js';

function openFV(sym) {
  openCoinFullView(sym);
  if (!state.natrData[sym] || state.natrData[sym] === 'error') fetchNATR(sym);
}
import { initRouter, registerRoute, reloadRoute, navigate, getCurrentRoute, onRouteChange } from './router.js';
import './styles.css';

// ── Event delegation ───────────────────────────────────────────────────────

// Close tf-dd on touch outside .tf-picker (mobile — click doesn't fire over chart)
document.body.addEventListener('touchstart', function (e) {
  if (!e.target.closest('.tf-picker')) {
    document.querySelectorAll('.tf-dd').forEach(function (el) { el.classList.remove('open'); });
  }
}, { passive: true });

// ⌘K / Ctrl+K — coin search (shadcn Command dialog)
window.addEventListener('keydown', function (e) {
  if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault();
    openSearchPopup();
  }
});

document.body.addEventListener('click', function (e) {
  // Close popups on any outside click — runs before data-action check so clicking
  // any button outside a popup (e.g. "expand", "open-ms") also closes it.

  // Close tf-dd on any click outside .tf-picker
  if (!e.target.closest('.tf-picker')) {
    document.querySelectorAll('.tf-dd').forEach(function (el) { el.classList.remove('open'); });
  }

  var target = e.target.closest('[data-action]');
  if (!target) return;

  var action = target.dataset.action;
  var sym = target.dataset.sym;
  var tf = target.dataset.tf;

  if (target.dataset.notifId) markNotificationAsRead(target.dataset.notifId);

  switch (action) {
    case 'toggle-notif': {
      e.stopPropagation();
      toggleNotifDropdown();
      break;
    }
    case 'analyze': {
      if (state.isDemoMode) { window.location.href = '/login'; break; }
      document.querySelectorAll('.tf-dd').forEach(function (el) { el.classList.remove('open'); });
      var c = state.coins.find(function (x) { return x.symbol === sym; });
      if (c) { openAnalysisPopup(sym, target); }
      break;
    }
    case 'open-origin':
      if (state.isDemoMode) { window.location.href = '/login'; break; }
      openOriginPopup(sym, target);
      break;
    case 'open-analysis': {
      if (state.isDemoMode) { window.location.href = '/login'; break; }
      document.querySelectorAll('.tf-dd').forEach(function (el) { el.classList.remove('open'); });
      openAnalysisPopup(sym, target);
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
    case 'toggle-theme':
      toggleTheme();
      break;
    case 'tv':
      openTVMode();
      break;
    case 'open-hints':
      openHintsPopup();
      break;
    case 'close-tv':
      closeTVMode();
      break;
    case 'open-clear-popup':
      openClearPopup(sym, target);
      break;
    case 'open-search':
      openSearchPopup();
      break;
    case 'open-account':
      if (state.isDemoMode) { window.location.href = '/login'; break; }
      navigate('/settings');
      break;
    case 'open-evening-journal':
      openEveningJournal();
      break;
    case 'open-morning-journal':
      closeSurface('notifications');
      openMorningJournal();
      break;
    case 'logout': {
      if (state.isDemoMode) { window.location.replace('/login'); break; }
      var _wsEnv2 = import.meta.env.VITE_WS_URL || '';
      var _apiBase2 = _wsEnv2.replace(/^wss?:\/\//, 'https://').replace(/\/ws$/, '');
      fetch(_apiBase2 + '/auth/sign-out', { method: 'POST', credentials: 'include' })
        .finally(function () { window.location.replace('/login'); });
      break;
    }
    case 'toggle-briefing':
      toggleBriefing(sym);
      break;
    case 'fv-note':
      openFVNote(sym);
      break;
    case 'toggle-terminal':
      toggleTerminal();
      break;
    case 'open-briefing':
      openBriefingPanel();
      fetchBriefingTrades(state.briefingViewDate || tzDateStr());
      break;
    case 'close-briefing':
      closeBriefingPanel();
      break;
    case 'toggle-liq-panel':
      openLiquidityPopup(target);
      break;
    case 'go-briefing': {
      var today = tzDateStr();
      var weekEntries = briefingThisWeekEntries();
      var first = weekEntries.find(function (e) { return e.date === today; });
      if (!first) {
        // Find the most recent past date this week and take its first entry
        var latestPastDate = '';
        weekEntries.forEach(function (e) { if (e.date < today && e.date > latestPastDate) latestPastDate = e.date; });
        if (latestPastDate) first = weekEntries.find(function (e) { return e.date === latestPastDate; });
      }
      if (first) {
        closeBriefingPanel();
        openFV(first.sym);
        setTimeout(function () { openFVBriefingDrawer(); fetchAllBriefingTrades(); }, 50);
      }
      break;
    }
    case 'close-fv-briefing':
      closeFVBriefingDrawer();
      break;
    case 'toggle-fv-briefing':
      toggleFVBriefingDrawer();
      fetchAllBriefingTrades();
      break;
    case 'go-main':
      navigate('/');
      break;
    case 'go-screener':
      navigate('/gainers');
      break;
    case 'open-journal':
      if (state.isDemoMode) { window.location.href = '/login'; break; }
      if (getCurrentRoute() === '/journal') {
        reloadRoute();
      } else {
        navigate('/journal');
      }
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

// An algorithm just showed up on a briefing coin (server algos/): a toast that opens its chart
on('algo:alert', function (msg) {
  var sym = String(msg.symbol || '').replace(/USDT$/, '').toLowerCase();
  if (!sym) return;
  toast(msg.text, {
    duration: 12000,
    action: { label: 'Открыть', onClick: function () { openCoinFullView(sym); } },
  });
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
  renderBriefingPanel(); // the shadcn list redraws itself (panel and drawer)
  applyFVTradeMarkers();
});

// iOS standalone app: re-sync route on restore from frozen/bfcache state
// (router's currentRoute can get stale relative to the displayed page,
// causing the next nav click to be ignored since the hash doesn't change)
window.addEventListener('pageshow', function (e) {
  if (e.persisted) reloadRoute();
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
// The header (React) refreshes the session timer itself

// Fallback poll every 15s when briefing is open (covers WS gaps/reconnects)
setInterval(function () {
  if (document.hidden) return;
  var drawer = document.getElementById('fv-briefing-drawer');
  if (isBriefingPanelOpen() || (drawer && drawer.classList.contains('open'))) {
    _briefingRefreshSafe();
  }
}, 15000);

// ── Orientation change: close transient UI, re-anchor full-screen overlays ─

window.addEventListener('orientationchange', function () {
  closeClearPopup();
  // Close only dropdown-mode popups (positions stale after resize).
  // Fullscreen-mode popups (_isFullscreenMode / _lockedScroll) stay open — reapplyOverlayPositions handles them.
  closeSurface('chart-menu');
  var ids = ['fv-add-btn', 'fv-drag-handle'];
  ids.forEach(function (id) { var el = document.getElementById(id); if (el) el.remove(); });
  document.querySelectorAll('.tf-dd').forEach(function (el) { el.classList.remove('open'); });
  clearAllCrosshairs();

  // iOS needs ~350ms after orientationchange before viewport dimensions are final.
  // reapplyOverlayPositions re-anchors fixed overlays; resyncChartLayouts
  // re-sizes the FV canvas overlay so rays don't overshoot the price scale.
  setTimeout(function () { reapplyOverlayPositions(); resyncChartLayouts(); }, 350);
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
  if (state.coins.length === 0) state.loading = true;
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

registerRoute('/gainers', function () {
  if (state.coins.length === 0) {
    fetchCoins().then(function () { renderScreener(); startChartPolling(); fetchAllNATR(screenerCoins()); });
  } else {
    renderScreener();
    fetchAllNATR(screenerCoins());
  }
});


// Account settings page (src/react/account), loaded on first visit
var _accountApp = null;
onRouteChange(function () { if (_accountApp) _accountApp.unmountAccount(); });
registerRoute('/settings', function () {
  if (state.isDemoMode) { window.location.replace('/login'); return; }
  var app = document.getElementById('app');
  import('./react/account/mount.jsx').then(function (m) {
    _accountApp = m;
    if (getCurrentRoute() === '/settings') m.mountAccount(app);
  });
});

function _refreshJournalHistory() {
  var section = document.getElementById('profile-journal-section');
  if (!section) return;
  fetchJournalRecent().then(function (entries) {
    renderProfileJournal(section, entries);
  });
}

// A journal card was saved (shadcn dialogs, src/react/host): update the
// header buttons and the history, clear today's reminder
on('journal:saved', function (ev) {
  _refreshJournalHistory();
  if (ev.kind === 'evening') return;
  var mBtn = document.querySelector('[data-action="open-morning-journal"]');
  if (mBtn) { mBtn.disabled = true; mBtn.innerHTML = 'Morning' + icon('check', 14); }
  var eBtn = document.querySelector('[data-action="open-evening-journal"]');
  if (eBtn) eBtn.disabled = ev.kind === 'skip' || !!(state.journalToday && state.journalToday.skipped);
  if (ev.kind === 'morning') {
    state.notifications.forEach(function (n) {
      if (n.type === 'journal_reminder') markNotificationAsRead(n.id);
    });
  }
});

// Journal page: React + shadcn/ui island (src/react/journal), loaded on first visit
var _journalApp = null;
onRouteChange(function () { if (_journalApp) _journalApp.unmountJournal(); });
registerRoute('/journal', function () {
  var app = document.getElementById('app');
  import('./react/journal/mount.jsx').then(function (m) {
    _journalApp = m;
    if (getCurrentRoute() === '/journal') m.mountJournal(app);
  });
});

registerRoute('/404', function () {
  var app = document.getElementById('app');
  unmountIslands(app);
  app.innerHTML = '<div id="not-found-root"></div>';
  mountIsland(document.getElementById('not-found-root'), NotFound); // src/react/home/HomeState.jsx
});

// ── Init ───────────────────────────────────────────────────────────────────

var _API_BASE = (import.meta.env.VITE_WS_URL || '').replace(/^wss?:\/\//, 'https://').replace(/\/ws$/, '');
var _sessionVerified = false; // true once session confirmed — prevents double-init on revalidate

// Fetch session and apply user state. Returns true (ok), false (no session → demo mode), null (network err).
// The first screen waits for this — a slow server must not leave the page blank:
// after 4 s it counts as a network error and the app loads anyway.
async function _applySession() {
  var ctl = new AbortController();
  var timer = setTimeout(function () { ctl.abort(); }, 4000);
  try {
    var r = await fetch(_API_BASE + '/auth/get-session', { credentials: 'include', signal: ctl.signal });
    if (!r.ok) { state.isDemoMode = true; return false; }
    var s = await r.json();
    if (!s || !s.user || !s.user.id) { state.isDemoMode = true; return false; }
    setUserId(s.user.id);
    if (s.user.email) setUserEmail(s.user.email);
    return true;
  } catch (e) {
    return null; // network error or too slow — caller decides
  } finally {
    clearTimeout(timer);
  }
}

// Re-check session when returning from long background.
async function _revalidateSession() {
  var result = await _applySession();
  if (result === null) return; // server unreachable — keep current state
  if (result === false && !document.getElementById('demo-banner')) injectDemoBanner();
  if (result === true && !_sessionVerified) {
    _sessionVerified = true;
    loadAlerts();
    loadBriefing();
    fetchServerLevels();
    fetchServerRays();
    fetchNotifications();
  }
}

// Check session; unauthenticated users get demo mode instead of redirect.
// On network error (server down) load the app anyway — WS reconnect recovers.
(async function () {
  var result = await _applySession();
  // result === true:  authenticated
  // result === false: no session → state.isDemoMode = true (set in _applySession)
  // result === null:  network error → load app, WS will surface the error

  if (result === true) {
    _sessionVerified = true;
    fetch(_API_BASE + '/api/account', { credentials: 'include' })
      .then(function (ar) { return ar.json(); })
      .then(function (d) { if (d.avatar) setUserAvatar(d.avatar); state.timezone = d.timezone || null; if (d.tradingLimits) state.tradingLimits = d.tradingLimits; })
      .catch(function () {});
    fetchJournalToday();
    fetchJournalRecent();
  }

  loadCache();
  loadAlerts();
  loadBriefing();
  loadLevels();
  loadRays();
  if (!state.isDemoMode) fetchNotifications();
  initRouter('/');
  preloadReactHost();
  if (state.isDemoMode) injectDemoBanner();
  // The server was slow or unreachable: pick the session up once it answers
  if (result === null) setTimeout(_revalidateSession, 5000);
})();
