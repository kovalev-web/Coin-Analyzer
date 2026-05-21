import { state, filteredCoins } from './state.js';
import {
  fetchCoins, analyzeCoinBySymbol, analyzeAll,
  fetchMarketStrength, loadCache, startChartPolling, startMSPolling, fetchAllNATR,
} from './api.js';
import {
  render, openAnalysisPopup, openMSPopup, closeMSPopup, setChartTF, openTVMode, closeTVMode, toggleTheme, clearLevels, showCodeModal, clearAlerts, loadAlerts, handleAlertTriggered, openCoinFullView, closeCoinFullView, setFVChartTF,
  toggleBriefing, openBriefingPanel, closeBriefingPanel, loadBriefing,
  briefingNavDate, briefingCycleStatus, briefingRemove,
  renderFVBriefingDrawer, toggleFVBriefingDrawer, openFVBriefingDrawer, closeFVBriefingDrawer,
} from './ui.js';
import { on } from './events.js';
import { initRouter, registerRoute } from './router.js';
import './styles.css';

// ── Event delegation ───────────────────────────────────────────────────────

document.body.addEventListener('click', function (e) {
  // Close burger dropdown on any click outside .burger-wrap
  var burgerDd = document.getElementById('burger-dd');
  if (burgerDd && burgerDd.classList.contains('open') && !e.target.closest('.burger-wrap')) {
    burgerDd.classList.remove('open');
  }

  var target = e.target.closest('[data-action]');
  if (!target) {
    // Close popups on outside click
    var popup = document.getElementById('analysis-overlay');
    if (popup && popup.style.display === 'block' && !popup.contains(e.target) && !e.target.closest('[data-action="open-analysis"]') && !e.target.closest('[data-action="analyze"]')) {
      if (popup._popupCard) { popup._popupCard.style.overflow = ''; popup._popupCard = null; }
      popup.style.display = 'none';
    }
    var msPopup = document.getElementById('ms-popup');
    if (msPopup && msPopup.style.display !== 'none' && !msPopup.contains(e.target) && !e.target.closest('[data-action="open-ms"]')) {
      msPopup.style.display = 'none';
    }
    var bpPopup = document.getElementById('bp-popup');
    if (bpPopup && bpPopup.style.display !== 'none' && !bpPopup.contains(e.target) && !e.target.closest('[data-action="open-briefing"]')) {
      bpPopup.style.display = 'none';
    }
    if (!e.target.closest('.tf-picker')) {
      document.querySelectorAll('.tf-dd').forEach(function (el) { el.style.display = 'none'; });
    }
    return;
  }

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
      var c = state.coins.find(function (x) { return x.symbol === sym; });
      if (c) { openAnalysisPopup(sym, target); }
      break;
    }
    case 'open-analysis': {
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
      }
      break;
    }
    case 'tf-pick': {
      e.stopPropagation();
      var dd = target.parentElement.querySelector('.tf-dd');
      if (dd) {
        document.querySelectorAll('.tf-dd').forEach(function (el) { el.style.display = 'none'; });
        dd.style.display = dd.style.display === 'none' ? 'block' : 'none';
      }
      break;
    }
    case 'tf-opt': {
      e.stopPropagation();
      document.querySelectorAll('.tf-dd').forEach(function (el) { el.style.display = 'none'; });
      if (sym) setChartTF(sym, tf);
      break;
    }
    case 'analyze-all': {
      if (state.analyzingAll) { state.analyzeAllAbort = true; }
      else { analyzeAll(); }
      break;
    }
    case 'refresh':
      location.reload();
      break;
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
    case 'expand': {
      openCoinFullView(sym);
      break;
    }
    case 'close-fv': {
      closeCoinFullView();
      break;
    }
    case 'fv-tf-pick': {
      e.stopPropagation();
      var fvDd = document.querySelector('#fv-overlay .fv-tf-dd');
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
      if (confirm('Удалить все уровни для ' + sym.toUpperCase() + '?')) clearLevels(sym);
      break;
    case 'clear-alerts':
      if (confirm('Удалить все алерты для ' + sym.toUpperCase() + '?')) clearAlerts(sym);
      break;
    case 'open-settings':
      showCodeModal();
      break;
    case 'toggle-briefing':
      toggleBriefing(sym);
      break;
    case 'open-briefing':
      openBriefingPanel();
      break;
    case 'close-briefing':
      closeBriefingPanel();
      break;
    case 'bp-prev-date':
      briefingNavDate(-1);
      break;
    case 'bp-next-date':
      briefingNavDate(+1);
      break;
    case 'bp-cycle-status': {
      var bStatusDate = target.dataset.date;
      briefingCycleStatus(sym, bStatusDate);
      break;
    }
    case 'bp-open':
      closeBriefingPanel();
      openCoinFullView(sym);
      break;
    case 'go-briefing': {
      var today = new Date().toISOString().slice(0, 10);
      var first = (state.briefing || []).find(function (e) { return e.date === today; });
      if (first) {
        closeBriefingPanel();
        openCoinFullView(first.sym);
        setTimeout(function () { openFVBriefingDrawer(); }, 50);
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
    case 'bp-toggle-note': {
      // Use DOM sibling instead of getElementById to avoid collision between popup and drawer
      var bpRow = target.closest('.bp-row');
      var noteEl = bpRow ? bpRow.nextElementSibling : null;
      if (noteEl && noteEl.classList.contains('bp-note-row')) {
        var showing = noteEl.style.display !== 'none';
        noteEl.style.display = showing ? 'none' : 'block';
        if (!showing) { var ta = noteEl.querySelector('textarea'); if (ta) ta.focus(); }
      }
      break;
    }
    case 'toggle-fv-briefing':
      toggleFVBriefingDrawer();
      break;
    case 'fvbd-open':
      openCoinFullView(sym);
      break;
  }
});

// ── WS events ─────────────────────────────────────────────────────────────

on('alert:triggered', function (msg) {
  handleAlertTriggered(msg.sym, msg.price);
});

// ── Router ─────────────────────────────────────────────────────────────────

registerRoute('/', function () {
  render();
  if (state.coins.length === 0) {
    fetchCoins().then(function () { render(); startChartPolling(); fetchMarketStrength(false); startMSPolling(); });
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
