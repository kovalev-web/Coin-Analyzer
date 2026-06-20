import { state, filteredCoins } from './state.js';
import {
  fetchCoins, analyzeCoinBySymbol, analyzeAll,
  loadCache, startChartPolling, fetchAllNATR, fetchNATR,
  fetchBriefingTrades, fetchAllBriefingTrades,
  fetchNotifications,
  fetchJournalToday, saveJournalMorning, saveJournalEvening, fetchJournalRecent, exportJournalCsv, fetchPnlHistory,
  fetchJournalSummary, generateJournalAiSummary, deleteJournalAiSummary,
} from './api.js';
import {
  render, openAnalysisPopup, setChartTF, openTVMode, closeTVMode, toggleTheme, clearLevels, clearAlerts, clearRays, loadAlerts, handleAlertTriggered, openCoinFullView, closeCoinFullView, setFVChartTF, applyFVTradeMarkers,
  toggleBriefing, openBriefingPanel, closeBriefingPanel, loadBriefing, renderBriefingPanel,
  briefingNavDate, briefingCycleStatus, briefingRemove, briefingClearNote, toggleBpExpand, toggleFvExpand, briefingNoteAction,
  renderFVBriefingDrawer, toggleFVBriefingDrawer, openFVBriefingDrawer, closeFVBriefingDrawer, autoSetTradedStatus, syncBriefingNow, refreshBriefingFromServer, briefingJustSynced,
  openSearchPopup, closeSearchPopup, renderScreener, setScreenerMode, screenerCoins,
  openClearPopup, closeClearPopup, clearAllCrosshairs,
  forceUnlockScroll, reapplyOverlayPositions, resyncChartLayouts,
  setUserId, setUserEmail, setUserAvatar, showAccountModal,
  loadLevels, fetchServerLevels, loadRays, fetchServerRays,
  toggleNotifDropdown, updateNotifBadge, showNotifToast, clearNotifications, markNotificationAsRead, requestDesktopNotifPermission,
  showMorningModal, hideMorningModal, showEveningModal, hideEveningModal, renderProfileJournal, showToast,
  showWeeklyReportModal, hideWeeklyReportModal, renderJournalChart,
  renderJournalSummarySection, showJournalAiModal, hideJournalAiModal, renderJournalAiModalContent,
  openHintsPopup, closeHintsPopup,
  updateSessionTimer, injectDemoBanner,
} from './ui.js';
import { on } from './events.js';
import { icon, tzDateStr } from './utils.js';

function openFV(sym) {
  openCoinFullView(sym);
  if (!state.natrData[sym] || state.natrData[sym] === 'error') fetchNATR(sym);
}
import { initRouter, registerRoute, reloadRoute, navigate, getCurrentRoute } from './router.js';
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

  if (target.dataset.notifId) markNotificationAsRead(target.dataset.notifId);

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
    case 'open-weekly-report': {
      var _ndd3 = document.getElementById('notif-dd');
      if (_ndd3) _ndd3.classList.remove('open');
      var _n = state.notifications.find(function (n) { return n.id === target.dataset.notifId; });
      if (_n) showWeeklyReportModal(_n.report);
      break;
    }
    case 'close-weekly-report':
      hideWeeklyReportModal();
      break;
    case 'notif-clear': {
      e.stopPropagation();
      clearNotifications();
      break;
    }
    case 'enable-desktop-notifs': {
      e.stopPropagation();
      requestDesktopNotifPermission();
      break;
    }
    case 'analyze': {
      if (state.isDemoMode) { window.location.href = '/login'; break; }
      document.querySelectorAll('.tf-dd').forEach(function (el) { el.classList.remove('open'); });
      var c = state.coins.find(function (x) { return x.symbol === sym; });
      if (c) { openAnalysisPopup(sym, target); }
      break;
    }
    case 'open-analysis': {
      if (state.isDemoMode) { window.location.href = '/login'; break; }
      document.querySelectorAll('.tf-dd').forEach(function (el) { el.classList.remove('open'); });
      openAnalysisPopup(sym, target);
      break;
    }
    case 'reanalyze': {
      if (state.isDemoMode) { window.location.href = '/login'; break; }
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
    case 'global-tf-pick': {
      e.stopPropagation();
      var gdd = target.parentElement.querySelector('.tf-dd');
      if (gdd) {
        document.querySelectorAll('.tf-dd').forEach(function (el) { el.classList.remove('open'); });
        gdd.classList.toggle('open');
      }
      break;
    }
    case 'global-tf-opt': {
      e.stopPropagation();
      document.querySelectorAll('.tf-dd').forEach(function (el) { el.classList.remove('open'); });
      var newTf = target.dataset.tf;
      if (!newTf) break;
      state.globalTF = newTf;
      var gPill = document.querySelector('.sort-bar .tf-picker .pill');
      if (gPill) gPill.textContent = newTf;
      var gDd = document.querySelector('.sort-bar .tf-picker .tf-dd');
      if (gDd) gDd.querySelectorAll('button').forEach(function (btn) { btn.className = btn.dataset.tf === newTf ? 'active' : ''; });
      state.coins.forEach(function (c) { state.chartTF[c.symbol] = newTf; });
      document.querySelectorAll('.coin-card[data-sym]').forEach(function (card) {
        setChartTF(card.dataset.sym, newTf);
      });
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
    case 'open-hints':
      openHintsPopup();
      break;
    case 'close-hints':
      closeHintsPopup();
      break;
    case 'close-tv':
      closeTVMode();
      break;
    case 'clear-levels':
      closeClearPopup();
      clearLevels(sym);
      break;
    case 'clear-rays':
      closeClearPopup();
      clearRays(sym);
      break;
    case 'clear-alerts':
      closeClearPopup();
      clearAlerts(sym);
      break;
    case 'acc-clear-sym': {
      clearLevels(sym);
      clearAlerts(sym);
      clearRays(sym);
      var row = target.closest('.acc-levels-row');
      if (row) row.remove();
      var accList = document.getElementById('acc-levels-list');
      if (accList && !accList.querySelector('.acc-levels-row')) {
        accList.innerHTML = '<span class="acc-row-val" style="color:var(--graphite)">No levels or alerts set</span>';
      }
      break;
    }
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
      if (state.isDemoMode) { window.location.href = '/login'; break; }
      showAccountModal();
      break;
    case 'open-evening-journal':
      if (state.isDemoMode) { window.location.href = '/login'; break; }
      if (!state.journalToday || !state.journalToday.morningAt) {
        showToast('Fill in the morning journal first');
        break;
      }
      if (state.journalToday.skipped) {
        showToast('Today is marked as a no-trading day');
        break;
      }
      showEveningModal();
      break;
    case 'close-evening-journal':
      hideEveningModal();
      break;
    case 'toggle-journal-export': {
      e.stopPropagation();
      var _jdd = document.getElementById('journal-export-dd');
      if (_jdd) {
        document.querySelectorAll('.tf-dd').forEach(function (el) { el.classList.remove('open'); });
        _jdd.classList.toggle('open');
      }
      break;
    }
    case 'export-journal-csv': {
      e.stopPropagation();
      document.querySelectorAll('.tf-dd').forEach(function (el) { el.classList.remove('open'); });
      exportJournalCsv(target.dataset.range);
      break;
    }
    case 'journal-range-pick': {
      e.stopPropagation();
      var _jrdd = document.getElementById('journal-range-dd');
      if (_jrdd) {
        document.querySelectorAll('.tf-dd').forEach(function (el) { el.classList.remove('open'); });
        _jrdd.classList.toggle('open');
      }
      break;
    }
    case 'journal-range-opt': {
      e.stopPropagation();
      document.querySelectorAll('.tf-dd').forEach(function (el) { el.classList.remove('open'); });
      var newRange = target.dataset.range;
      if (!newRange || newRange === state.journalRange) break;
      state.journalRange = newRange;
      var _jrBtn = document.querySelector('[data-action="journal-range-pick"]');
      if (_jrBtn) _jrBtn.textContent = target.textContent;
      var _jrDd = document.getElementById('journal-range-dd');
      if (_jrDd) _jrDd.querySelectorAll('button').forEach(function (btn) { btn.classList.toggle('active', btn.dataset.range === newRange); });
      _refreshJournalSummary();
      break;
    }
    case 'journal-gen-ai': {
      var _hasAiText = state.aiSummary && state.aiSummaryRange === state.journalRange;
      if (_hasAiText) { showJournalAiModal(); break; }
      var _jaiBtn = target;
      _jaiBtn.disabled = true;
      _jaiBtn.classList.add('btn-loading');
      generateJournalAiSummary(state.journalRange).catch(function (err) { console.error('Journal AI summary:', err); }).finally(function () {
        _jaiBtn.disabled = false;
        _jaiBtn.classList.remove('btn-loading');
        renderJournalSummarySection();
        if (state.aiSummary && state.aiSummaryRange === state.journalRange) showJournalAiModal();
      });
      break;
    }
    case 'journal-regen-ai': {
      var _jrgBtn = target;
      _jrgBtn.disabled = true;
      _jrgBtn.classList.add('btn-loading');
      generateJournalAiSummary(state.journalRange).catch(function (err) { console.error('Journal AI summary:', err); }).finally(function () {
        _jrgBtn.disabled = false;
        _jrgBtn.classList.remove('btn-loading');
        renderJournalSummarySection();
        renderJournalAiModalContent();
      });
      break;
    }
    case 'close-journal-ai-modal':
      hideJournalAiModal();
      break;
    case 'journal-ai-delete':
      deleteJournalAiSummary();
      renderJournalSummarySection();
      hideJournalAiModal();
      break;
    case 'open-morning-journal': {
      if (state.isDemoMode) { window.location.href = '/login'; break; }
      var _mNdd = document.getElementById('notif-dd');
      if (_mNdd) _mNdd.classList.remove('open');
      if (state.journalToday && state.journalToday.morningAt) {
        showToast('Morning journal already filled today');
        break;
      }
      showMorningModal();
      break;
    }
    case 'close-morning-journal':
      hideMorningModal();
      break;
    case 'save-morning-journal': {
      var mBtn = target;
      mBtn.disabled = true;
      var mModal = document.getElementById('morning-journal-modal');
      var mToday = tzDateStr();
      var mPlannedCoins = (state.briefing || [])
        .filter(function (e) { return e.date === mToday; })
        .map(function (e) { return e.sym.toUpperCase(); })
        .join(', ');
      saveJournalMorning({
        morningState: (mModal.querySelector('[name="morningState"]:checked') || {}).value || '',
        volume:       '50',
        stopLevel:    '0.5%',
        dayPlan:      mModal.querySelector('[name="dayPlan"]').value.trim(),
        plannedCoins: mPlannedCoins,
        triggerWatch: mModal.querySelector('[name="triggerWatch"]').value.trim(),
        channelsClosed: (mModal.querySelector('[name="channelsClosed"]:checked') || {}).value || '',
      }).then(function () {
        hideMorningModal();
        _refreshJournalHistory();
        var mBtn2 = document.querySelector('[data-action="open-morning-journal"]');
        if (mBtn2) { mBtn2.disabled = true; mBtn2.innerHTML = 'Morning' + icon('check', 14); }
        var eBtn2 = document.querySelector('[data-action="open-evening-journal"]');
        if (eBtn2) eBtn2.disabled = !!state.journalToday.skipped;
        state.notifications.forEach(function (n) {
          if (n.type === 'journal_reminder') markNotificationAsRead(n.id);
        });
      }).catch(function () {
        mBtn.disabled = false;
        showToast('Network error — please try again');
      });
      break;
    }
    case 'skip-morning-journal': {
      if (!confirm('Mark today as a no-trading day? The evening journal will be unavailable.')) break;
      var skipBtn = target;
      skipBtn.disabled = true;
      saveJournalMorning({ skip: true }).then(function () {
        hideMorningModal();
        _refreshJournalHistory();
        var mBtn2 = document.querySelector('[data-action="open-morning-journal"]');
        if (mBtn2) { mBtn2.disabled = true; mBtn2.innerHTML = 'Morning' + icon('check', 14); }
        var eBtn2 = document.querySelector('[data-action="open-evening-journal"]');
        if (eBtn2) eBtn2.disabled = true;
      }).catch(function () {
        skipBtn.disabled = false;
        showToast('Network error — please try again');
      });
      break;
    }
    case 'journal-trigger-pill': {
      target.classList.toggle('active');
      var eOtherText = document.querySelector('#evening-journal-modal [name="triggerOtherText"]');
      if (target.dataset.trigger === 'triggerOther' && eOtherText) {
        eOtherText.hidden = !target.classList.contains('active');
        if (!eOtherText.hidden) eOtherText.dispatchEvent(new Event('input'));
      }
      break;
    }
    case 'save-evening-journal': {
      var eBtn = target;
      eBtn.disabled = true;
      var eModal = document.getElementById('evening-journal-modal');
      function _pill(name) { return !!eModal.querySelector('.journal-trigger-pill[data-trigger="' + name + '"].active'); }
      saveJournalEvening({
        followedProcess:  (eModal.querySelector('[name="followedProcess"]:checked') || {}).value || '',
        tradedPlanned:    (eModal.querySelector('[name="tradedPlanned"]:checked') || {}).value || '',
        tradeCount:       parseInt(eModal.querySelector('[name="tradeCount"]').value) || 0,
        stopCraneKept:    (eModal.querySelector('[name="stopCraneKept"]:checked') || {}).value || '',
        volumeOk:         (eModal.querySelector('[name="volumeOk"]:checked') || {}).value || '',
        triggerRevenge:   _pill('triggerRevenge'),
        triggerSizeUp:    _pill('triggerSizeUp'),
        triggerFomo:      _pill('triggerFomo'),
        triggerOther:     _pill('triggerOther') ? eModal.querySelector('[name="triggerOtherText"]').value.trim() : '',
        triggerFomoOther: _pill('triggerFomoOther'),
        triggerAddFunds:  _pill('triggerAddFunds'),
        triggerReplan:    _pill('triggerReplan'),
        missedScreening:  eModal.querySelector('[name="missedScreening"]').value.trim(),
        eveningState:     (eModal.querySelector('[name="eveningState"]:checked') || {}).value || '',
        feltWorthless:    (eModal.querySelector('[name="feltWorthless"]:checked') || {}).value || '',
        freeConclusion:   eModal.querySelector('[name="freeConclusion"]').value.trim(),
        pnl:              eModal.dataset.pnl != null ? parseFloat(eModal.dataset.pnl) : null,
      }).then(function () {
        hideEveningModal();
        showToast('Review saved');
        _refreshJournalHistory();
      }).catch(function () {
        eBtn.disabled = false;
        showToast('Network error — please try again');
      });
      break;
    }
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
    case 'open-briefing':
      openBriefingPanel();
      fetchBriefingTrades(state.briefingViewDate || tzDateStr());
      break;
    case 'close-briefing':
      closeBriefingPanel();
      break;
    case 'toggle-liq-panel': {
      var liqPanel = document.getElementById('fv-liquidity');
      if (liqPanel) liqPanel.classList.toggle('open');
      break;
    }
    case 'close-liq-panel': {
      var liqPanelClose = document.getElementById('fv-liquidity');
      if (liqPanelClose) liqPanelClose.classList.remove('open');
      break;
    }
    case 'bp-prev-date':
      briefingNavDate(-1);
      fetchBriefingTrades(state.briefingViewDate || tzDateStr());
      break;
    case 'bp-next-date':
      briefingNavDate(+1);
      fetchBriefingTrades(state.briefingViewDate || tzDateStr());
      break;
    case 'bp-cycle-status': {
      var bStatusDate = target.dataset.date;
      briefingCycleStatus(sym, bStatusDate);
      break;
    }
    case 'bp-open':
      closeBriefingPanel();
      openFV(sym);
      setTimeout(function () { openFVBriefingDrawer(); fetchAllBriefingTrades(); }, 50);
      break;
    case 'go-briefing': {
      var today = tzDateStr();
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
        setTimeout(function () { openFVBriefingDrawer(); fetchAllBriefingTrades(); }, 50);
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
      // Already viewing this coin — don't reopen it (would reset chart zoom and close the orderbook popup).
      var _fvCurrentRow = document.querySelector('.bp-row.fvbd-current');
      if (!_fvCurrentRow || _fvCurrentRow.dataset.sym !== sym) openFV(sym);
      break;
    }
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


registerRoute('/settings', function () {
  var app = document.getElementById('app');
  app.innerHTML = '<div class="topbar" style="padding:var(--space-12) var(--space-16);margin:var(--space-10) var(--space-16) 0;">' +
    '<h2 style="font-size:var(--text-lg);font-weight:var(--font-bold);margin-bottom:var(--space-6);">⚙️ Settings</h2>' +
    '<p style="color:var(--graphite);font-size:var(--text-sm);">Settings page — coming soon.</p>' +
    '<p style="color:var(--graphite);font-size:var(--text-sm);margin-top:var(--space-4);">Planned: notifications, default filters, subscription management.</p>' +
    '<a href="/" style="display:inline-block;margin-top:var(--space-8);color:var(--primary);font-weight:var(--font-semi);text-decoration:none;">← Back to home</a>' +
    '</div>';
});

var GEMINI_ICON_SVG = '<svg width="30" height="30" viewBox="0 0 30 30" fill="none" xmlns="http://www.w3.org/2000/svg">' +
  '<g clip-path="url(#clip0_73_811)">' +
  '<mask id="mask0_73_811" style="mask-type:alpha" maskUnits="userSpaceOnUse" x="4" y="4" width="22" height="22">' +
  '<path d="M14.9821 4C15.2122 4 15.4129 4.15738 15.4691 4.38077C15.6408 5.064 15.8671 5.73235 16.1457 6.37938C16.8741 8.07169 17.8735 9.5528 19.1424 10.8217C20.412 12.0909 21.8928 13.0904 23.5847 13.8188C24.2319 14.0973 24.9004 14.3236 25.5837 14.4954C25.8071 14.5515 25.9641 14.7519 25.9641 14.9821C25.9641 15.2122 25.8071 15.4129 25.5834 15.4691C24.9001 15.6408 24.2318 15.8671 23.5847 16.1457C21.8924 16.8741 20.4117 17.8735 19.1424 19.1424C17.8735 20.412 16.8741 21.8928 16.1457 23.5847C15.867 24.2319 15.6407 24.9004 15.4688 25.5837C15.4416 25.6922 15.3789 25.7886 15.2908 25.8575C15.2026 25.9264 15.094 25.9639 14.9821 25.9641C14.7519 25.9641 14.5515 25.8071 14.4954 25.5834C14.3235 24.9001 14.0972 24.2318 13.8184 23.5847C13.0904 21.8924 12.0913 20.4117 10.8217 19.1424C9.55246 17.8735 8.07169 16.8741 6.37938 16.1457C5.73233 15.867 5.06398 15.6407 4.38077 15.4688C4.27222 15.4416 4.17583 15.3791 4.10685 15.291C4.03788 15.2029 4.00028 15.0943 4 14.9824C4 14.7522 4.15738 14.5519 4.38077 14.4957C5.06401 14.3239 5.73236 14.0975 6.37938 13.8188C8.07169 13.0907 9.5528 12.0913 10.8217 10.822C12.0909 9.55314 13.0904 8.07203 13.8188 6.37972C14.0973 5.73265 14.3236 5.06431 14.4954 4.38111C14.5224 4.27244 14.585 4.17593 14.6732 4.10688C14.7614 4.03784 14.8701 4.00022 14.9821 4Z" fill="black"/>' +
  '<path d="M14.9821 4C15.2122 4 15.4129 4.15738 15.4691 4.38077C15.6408 5.064 15.8671 5.73235 16.1457 6.37938C16.8741 8.07169 17.8735 9.5528 19.1424 10.8217C20.412 12.0909 21.8928 13.0904 23.5847 13.8188C24.2319 14.0973 24.9004 14.3236 25.5837 14.4954C25.8071 14.5515 25.9641 14.7519 25.9641 14.9821C25.9641 15.2122 25.8071 15.4129 25.5834 15.4691C24.9001 15.6408 24.2318 15.8671 23.5847 16.1457C21.8924 16.8741 20.4117 17.8735 19.1424 19.1424C17.8735 20.412 16.8741 21.8928 16.1457 23.5847C15.867 24.2319 15.6407 24.9004 15.4688 25.5837C15.4416 25.6922 15.3789 25.7886 15.2908 25.8575C15.2026 25.9264 15.094 25.9639 14.9821 25.9641C14.7519 25.9641 14.5515 25.8071 14.4954 25.5834C14.3235 24.9001 14.0972 24.2318 13.8184 23.5847C13.0904 21.8924 12.0913 20.4117 10.8217 19.1424C9.55246 17.8735 8.07169 16.8741 6.37938 16.1457C5.73233 15.867 5.06398 15.6407 4.38077 15.4688C4.27222 15.4416 4.17583 15.3791 4.10685 15.291C4.03788 15.2029 4.00028 15.0943 4 14.9824C4 14.7522 4.15738 14.5519 4.38077 14.4957C5.06401 14.3239 5.73236 14.0975 6.37938 13.8188C8.07169 13.0907 9.5528 12.0913 10.8217 10.822C12.0909 9.55314 13.0904 8.07203 13.8188 6.37972C14.0973 5.73265 14.3236 5.06431 14.4954 4.38111C14.5224 4.27244 14.585 4.17593 14.6732 4.10688C14.7614 4.03784 14.8701 4.00022 14.9821 4Z" fill="url(#paint0_linear_73_811)"/>' +
  '</mask>' +
  '<g mask="url(#mask0_73_811)">' +
  '<g filter="url(#filter0_f_73_811)"><path d="M2.01719 21.1716C4.55498 22.0729 7.47184 20.383 8.53224 17.3971C9.59264 14.4115 8.39482 11.2605 5.85704 10.3591C3.31925 9.45781 0.40239 11.1477 -0.658348 14.1333C-1.71841 17.1192 -0.520594 20.2703 2.01719 21.1716Z" fill="#FFE432"/></g>' +
  '<g filter="url(#filter1_f_73_811)"><path d="M13.285 11.3273C16.7712 11.3273 19.5976 8.43857 19.5976 4.87558C19.5976 1.31226 16.7715 -1.57617 13.285 -1.57617C9.79851 -1.57617 6.97168 1.3126 6.97168 4.87558C6.97168 8.43857 9.79817 11.3273 13.285 11.3273Z" fill="#FC413D"/></g>' +
  '<g filter="url(#filter2_f_73_811)"><path d="M10.8316 31.9598C14.4711 31.7821 17.2347 27.8157 17.0042 23.1009C16.774 18.3861 13.6365 14.7081 9.99699 14.8861C6.35751 15.0641 3.59397 19.0302 3.82447 23.745C4.05496 28.4597 7.19216 32.1378 10.8316 31.9598Z" fill="#00B95C"/></g>' +
  '<g filter="url(#filter3_f_73_811)"><path d="M10.8316 31.9598C14.4711 31.7821 17.2347 27.8157 17.0042 23.1009C16.774 18.3861 13.6365 14.7081 9.99699 14.8861C6.35751 15.0641 3.59397 19.0302 3.82447 23.745C4.05496 28.4597 7.19216 32.1378 10.8316 31.9598Z" fill="#00B95C"/></g>' +
  '<g filter="url(#filter4_f_73_811)"><path d="M14.4769 29.1071C17.5277 27.2507 18.3445 23.0229 16.3008 19.6641C14.2572 16.3048 10.1269 15.0867 7.07572 16.9428C4.02449 18.7996 3.20778 23.0273 5.25141 26.3866C7.29572 29.7455 11.4256 30.9636 14.4769 29.1071Z" fill="#00B95C"/></g>' +
  '<g filter="url(#filter5_f_73_811)"><path d="M26.8095 18.5516C30.2388 18.5516 33.0189 15.8744 33.0189 12.5724C33.0189 9.27 30.2388 6.59277 26.8095 6.59277C23.3802 6.59277 20.6001 9.27 20.6001 12.5724C20.6001 15.8747 23.3802 18.5516 26.8095 18.5516Z" fill="#3186FF"/></g>' +
  '<g filter="url(#filter6_f_73_811)"><path d="M-0.421889 17.8578C2.73596 20.2589 7.34885 19.5058 9.88156 16.175C12.4143 12.8445 11.9079 8.1978 8.75008 5.79675C5.59223 3.39537 0.97968 4.14844 -1.55337 7.47924C-4.08607 10.8097 -3.5794 15.4568 -0.421889 17.8578Z" fill="#FBBC04"/></g>' +
  '<g filter="url(#filter7_f_73_811)"><path d="M15.7583 21.4073C19.5271 23.9985 24.5231 23.2769 26.9167 19.7948C29.3106 16.3131 28.1957 11.3902 24.4266 8.79889C20.6575 6.20695 15.6618 6.92923 13.2679 10.4106C10.8743 13.8927 11.9888 18.8157 15.758 21.4073H15.7583Z" fill="#3186FF"/></g>' +
  '<g filter="url(#filter8_f_73_811)"><path d="M22.6103 3.20926C23.5692 4.51302 22.3369 7.04742 19.8583 8.87071C17.3794 10.694 14.5929 11.115 13.634 9.81163C12.6751 8.50754 13.9071 5.9728 16.3857 4.14985C18.8646 2.32655 21.6515 1.90551 22.61 3.20892L22.6103 3.20926Z" fill="#749BFF"/></g>' +
  '<g filter="url(#filter9_f_73_811)"><path d="M14.7384 9.45055C18.5718 5.89467 19.8874 1.0804 17.6772 -1.30237C15.4671 -3.68514 10.5675 -2.73474 6.73409 0.821136C2.90068 4.37701 1.58474 9.19129 3.79523 11.5741C6.00538 13.9568 10.905 13.0064 14.7384 9.45055Z" fill="#FC413D"/></g>' +
  '<g filter="url(#filter10_f_73_811)"><path d="M6.88039 22.2221C9.15891 23.8528 11.7745 24.1005 12.7229 22.7758C13.6713 21.4507 12.5929 19.0547 10.3144 17.424C8.03624 15.7933 5.42027 15.5456 4.47224 16.8703C3.52387 18.1954 4.60187 20.5913 6.88039 22.2221Z" fill="#FFEE48"/></g>' +
  '</g></g>' +
  '<defs>' +
  '<filter id="filter0_f_73_811" x="-2.25551" y="8.90562" width="12.385" height="13.7195" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape"/><feGaussianBlur stdDeviation="0.605538" result="effect1_foregroundBlur_73_811"/></filter>' +
  '<filter id="filter1_f_73_811" x="1.11765" y="-7.4302" width="24.334" height="24.6114" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape"/><feGaussianBlur stdDeviation="2.92702" result="effect1_foregroundBlur_73_811"/></filter>' +
  '<filter id="filter2_f_73_811" x="-1.1657" y="9.90314" width="23.16" height="27.0394" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape"/><feGaussianBlur stdDeviation="2.48837" result="effect1_foregroundBlur_73_811"/></filter>' +
  '<filter id="filter3_f_73_811" x="-1.1657" y="9.90314" width="23.16" height="27.0394" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape"/><feGaussianBlur stdDeviation="2.48837" result="effect1_foregroundBlur_73_811"/></filter>' +
  '<filter id="filter4_f_73_811" x="-0.850762" y="11.098" width="23.2538" height="23.8544" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape"/><feGaussianBlur stdDeviation="2.48837" result="effect1_foregroundBlur_73_811"/></filter>' +
  '<filter id="filter5_f_73_811" x="15.871" y="1.86367" width="21.8772" height="21.4172" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape"/><feGaussianBlur stdDeviation="2.36455" result="effect1_foregroundBlur_73_811"/></filter>' +
  '<filter id="filter6_f_73_811" x="-7.45156" y="0.106059" width="23.2312" height="23.4422" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape"/><feGaussianBlur stdDeviation="2.14302" result="effect1_foregroundBlur_73_811"/></filter>' +
  '<filter id="filter7_f_73_811" x="8.17914" y="3.41596" width="23.8263" height="23.3741" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape"/><feGaussianBlur stdDeviation="1.91385" result="effect1_foregroundBlur_73_811"/></filter>' +
  '<filter id="filter8_f_73_811" x="9.88361" y="-0.973324" width="16.4769" height="14.9672" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape"/><feGaussianBlur stdDeviation="1.71249" result="effect1_foregroundBlur_73_811"/></filter>' +
  '<filter id="filter9_f_73_811" x="-0.170144" y="-5.50803" width="21.8125" height="21.2876" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape"/><feGaussianBlur stdDeviation="1.4464" result="effect1_foregroundBlur_73_811"/></filter>' +
  '<filter id="filter10_f_73_811" x="0.547376" y="12.438" width="16.1006" height="14.77" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape"/><feGaussianBlur stdDeviation="1.79028" result="effect1_foregroundBlur_73_811"/></filter>' +
  '<linearGradient id="paint0_linear_73_811" x1="10.2436" y1="18.696" x2="21.6518" y2="9.07828" gradientUnits="userSpaceOnUse"><stop stop-color="#4893FC"/><stop offset="0.27" stop-color="#4893FC"/><stop offset="0.777" stop-color="#969DFF"/><stop offset="1" stop-color="#BD99FE"/></linearGradient>' +
  '<clipPath id="clip0_73_811"><rect width="22" height="22" fill="white" transform="translate(4 4)"/></clipPath>' +
  '</defs></svg>';

var JOURNAL_EXPORT_RANGES = [
  { value: '1w', label: '1 week' },
  { value: '2w', label: '2 weeks' },
  { value: '1m', label: '1 month' },
  { value: '2m', label: '2 months' },
  { value: '3m', label: '3 months' },
  { value: '6m', label: '6 months' },
  { value: 'all', label: 'All time' },
];

function _refreshJournalHistory() {
  var section = document.getElementById('profile-journal-section');
  if (!section) return;
  fetchJournalRecent().then(function (entries) {
    renderProfileJournal(section, entries);
  });
}

var JOURNAL_SUMMARY_RANGES = [
  { value: '1w', label: '1 week' },
  { value: '2w', label: '2 weeks' },
  { value: '1m', label: '1 month' },
  { value: '2m', label: '2 months' },
  { value: '3m', label: '3 months' },
  { value: '6m', label: '6 months' },
];
var JOURNAL_RANGE_DAYS = { '1w': 7, '2w': 14, '1m': 30, '2m': 60, '3m': 90, '6m': 180 };
var _journalPnlHistoryFull = [];

function _renderJournalPnlChart() {
  var days = JOURNAL_RANGE_DAYS[state.journalRange] || 7;
  var fromDate = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  var filtered = _journalPnlHistoryFull.filter(function (h) { return h.date >= fromDate; });
  renderJournalChart(document.getElementById('journal-pnl-chart'), filtered);
}

function _refreshJournalSummary() {
  _renderJournalPnlChart();
  renderJournalSummarySection();
  fetchJournalSummary(state.journalRange).then(function () {
    renderJournalSummarySection();
  });
}

registerRoute('/journal', function () {
  var app = document.getElementById('app');
  app.innerHTML = '<div class="journal-page">' +
    '<div class="journal-page-header">' +
    '<h2 class="journal-page-title">' +
    '<a href="/" class="btn-icon" title="Back">' + icon('arrow-left', 18) + '</a>Journal</h2>' +
    '<div class="journal-page-actions">' +
    '<button data-action="open-morning-journal" class="btn-cta"' + (state.journalToday && state.journalToday.morningAt ? ' disabled' : '') + '>Morning' + (state.journalToday && state.journalToday.morningAt ? icon('check', 14) : '') + '</button>' +
    '<button data-action="open-evening-journal" class="btn-cta"' + (!state.journalToday || !state.journalToday.morningAt || state.journalToday.skipped ? ' disabled' : '') + '>Evening</button>' +
    '<div class="tf-picker">' +
    '<button data-action="journal-range-pick" class="btn-cta">' + (JOURNAL_SUMMARY_RANGES.find(function (r) { return r.value === state.journalRange; }) || JOURNAL_SUMMARY_RANGES[0]).label + '</button>' +
    '<div class="dropdown tf-dd" id="journal-range-dd">' +
    JOURNAL_SUMMARY_RANGES.map(function (r) {
      return '<button class="' + (r.value === state.journalRange ? 'active' : '') + '" data-action="journal-range-opt" data-range="' + r.value + '">' + r.label + '</button>';
    }).join('') +
    '</div>' +
    '</div>' +
    '<div class="tf-picker">' +
    '<button data-action="toggle-journal-export" class="btn-cta">CSV</button>' +
    '<div class="dropdown tf-dd" id="journal-export-dd">' +
    JOURNAL_EXPORT_RANGES.map(function (r) {
      return '<button data-action="export-journal-csv" data-range="' + r.value + '">' + r.label + '</button>';
    }).join('') +
    '</div>' +
    '</div>' +
    '<button data-action="journal-gen-ai" class="btn-cta journal-icon-btn" id="journal-gen-ai-btn" title="Generate">' + GEMINI_ICON_SVG + '</button>' +
    '</div>' +
    '</div>' +
    '<div class="journal-chart-row">' +
    '<div id="journal-pnl-chart" style="height:400px;border-radius:var(--radius-xl);overflow:hidden;"></div>' +
    '<div id="journal-stats-col" class="journal-stats-col"></div>' +
    '</div>' +
    '<div id="journal-summary-section"></div>' +
    '<div id="profile-journal-section"></div>' +
    '</div>';
  if (state.journalEntries) {
    renderProfileJournal(document.getElementById('profile-journal-section'), state.journalEntries);
  }
  fetchPnlHistory().then(function (history) {
    _journalPnlHistoryFull = history;
    _renderJournalPnlChart();
  });
  renderJournalSummarySection();
  fetchJournalSummary(state.journalRange).then(function () {
    renderJournalSummarySection();
  });
  fetchJournalRecent().then(function (entries) {
    renderProfileJournal(document.getElementById('profile-journal-section'), entries);
  });
  fetchJournalToday().then(function () {
    var mBtn = document.querySelector('[data-action="open-morning-journal"]');
    if (mBtn) {
      var filled = !!(state.journalToday && state.journalToday.morningAt);
      mBtn.disabled = filled;
      mBtn.innerHTML = 'Morning' + (filled ? icon('check', 14) : '');
    }
    var eBtn = document.querySelector('[data-action="open-evening-journal"]');
    if (eBtn) eBtn.disabled = !state.journalToday || !state.journalToday.morningAt || !!state.journalToday.skipped;
  });
});

registerRoute('/404', function () {
  var app = document.getElementById('app');
  app.innerHTML = '<div class="topbar" style="padding:var(--space-12) var(--space-16);margin:var(--space-10) var(--space-16) 0;">' +
    '<h2 style="font-size:var(--text-lg);font-weight:var(--font-bold);margin-bottom:var(--space-6);">404 — Page not found</h2>' +
    '<a href="/" style="color:var(--primary);font-weight:var(--font-semi);text-decoration:none;">← Back to home</a>' +
    '</div>';
});

// ── Init ───────────────────────────────────────────────────────────────────

var _API_BASE = (import.meta.env.VITE_WS_URL || '').replace(/^wss?:\/\//, 'https://').replace(/\/ws$/, '');
var _sessionVerified = false; // true once session confirmed — prevents double-init on revalidate

// Fetch session and apply user state. Returns true (ok), false (no session → demo mode), null (network err).
async function _applySession() {
  try {
    var r = await fetch(_API_BASE + '/auth/get-session', { credentials: 'include' });
    if (!r.ok) { state.isDemoMode = true; return false; }
    var s = await r.json();
    if (!s || !s.user || !s.user.id) { state.isDemoMode = true; return false; }
    setUserId(s.user.id);
    if (s.user.email) setUserEmail(s.user.email);
    return true;
  } catch (e) {
    return null; // network error — caller decides
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
      .then(function (d) { if (d.avatar) setUserAvatar(d.avatar); state.timezone = d.timezone || null; })
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
  if (state.isDemoMode) injectDemoBanner();
})();
