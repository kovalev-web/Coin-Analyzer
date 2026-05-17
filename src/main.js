import { state } from './state.js';
import {
  fetchCoins, refreshCoins, analyzeCoinBySymbol, analyzeAll,
  fetchMarketStrength, loadCache, startChartPolling, startMSPolling,
} from './api.js';
import {
  render, openAnalysisPopup, openMSPopup, closeMSPopup, setChartTF,
} from './ui.js';
import { initRouter, registerRoute } from './router.js';
import './styles.css';

// ── Event delegation ───────────────────────────────────────────────────────

document.body.addEventListener('click', function (e) {
  var target = e.target.closest('[data-action]');
  if (!target) {
    // Close popups on outside click
    var popup = document.getElementById('analysis-overlay');
    if (popup && popup.style.display === 'block' && !popup.contains(e.target) && !e.target.closest('[data-action="open-analysis"]') && !e.target.closest('[data-action="analyze"]')) {
      popup.style.display = 'none';
    }
    var msPopup = document.getElementById('ms-popup');
    if (msPopup && msPopup.style.display !== 'none' && !msPopup.contains(e.target) && !e.target.closest('#ms-card') && !e.target.closest('[data-action="open-ms"]')) {
      msPopup.style.display = 'none';
    }
    if (!e.target.closest('.tf-picker')) {
      document.querySelectorAll('.tf-dd').forEach(function (el) { el.style.display = 'none'; });
    }
    return;
  }

  var action = target.dataset.action;
  var sym = target.dataset.sym;
  var tf = target.dataset.tf;

  switch (action) {
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
      if (ap) ap.style.display = 'none';
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
      refreshCoins();
      break;
    case 'sort': {
      var col = target.dataset.col;
      if (state.sortCol === col) { state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc'; }
      else { state.sortCol = col; state.sortDir = 'desc'; }
      render();
      break;
    }
    case 'vol-pick': {
      e.stopPropagation();
      var dd2 = document.getElementById('vol-dd');
      if (dd2) {
        document.querySelectorAll('.tf-dd').forEach(function (el) { el.style.display = 'none'; });
        dd2.style.display = dd2.style.display === 'none' ? 'block' : 'none';
      }
      break;
    }
    case 'pick-vol': {
      e.stopPropagation();
      document.querySelectorAll('.tf-dd').forEach(function (el) { el.style.display = 'none'; });
      state.minVolume = parseFloat(target.dataset.val);
      render();
      break;
    }
    case 'change-pick': {
      e.stopPropagation();
      var dd3 = document.getElementById('change-dd');
      if (dd3) {
        document.querySelectorAll('.tf-dd').forEach(function (el) { el.style.display = 'none'; });
        dd3.style.display = dd3.style.display === 'none' ? 'block' : 'none';
      }
      break;
    }
    case 'pick-change': {
      e.stopPropagation();
      document.querySelectorAll('.tf-dd').forEach(function (el) { el.style.display = 'none'; });
      state.minChange = parseFloat(target.dataset.val);
      render();
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
  }
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

initRouter('/');
