// ── Trading API keys in the account page ──────────────────────────────────────
// Separate from the read-only journal key: these keys can trade. They go to the
// trader process on the server (encrypted at rest) and are never sent back —
// the page only sees a masked key. Saving or deleting needs the account password.

import { tradeRequest } from './api.js';
import { checkAccess } from './terminal.js';

var ENV_LABEL = { testnet: 'Testnet', mainnet: 'Live' };

export function tradingKeysHTML() {
  return '<div id="acc-trade-keys" style="display:none">'
    + '<div class="acc-row">'
      + '<div class="acc-row-left">'
        + '<div class="acc-row-label">TRADING API</div>'
        + '<span class="acc-row-val" id="acc-tk-active"></span>'
      + '</div>'
    + '</div>'
    + '<div id="acc-tk-list"></div>'
    + '<div id="acc-tk-form" class="acc-tk-form" style="display:none">'
      + '<div class="acc-tk-note">'
        + '<strong>Trade-enabled key</strong> from your Tiger.com Broker cabinet (Binance tab): Read + Trade, no withdrawals. '
        + '<span id="acc-tk-ip-note"></span> '
        + 'The key is encrypted on the trading server and is never shown again.'
      + '</div>'
      + '<div class="acc-tk-field"><div class="acc-row-label">Environment</div>'
        + '<select id="acc-tk-env" class="ds-input"><option value="testnet">Testnet</option><option value="mainnet">Live</option></select></div>'
      + '<div class="acc-tk-field"><div class="acc-row-label">API Key</div>'
        + '<input type="text" id="acc-tk-key" placeholder="Paste API key..." autocomplete="off" class="ds-input"></div>'
      + '<div class="acc-tk-field"><div class="acc-row-label">Secret Key</div>'
        + '<input type="password" id="acc-tk-sec" placeholder="Paste Secret key..." autocomplete="off" class="ds-input"></div>'
      + '<div class="acc-tk-field"><div class="acc-row-label">Account password</div>'
        + '<input type="password" id="acc-tk-pw" placeholder="Your QuestTick password" autocomplete="current-password" class="ds-input"></div>'
      + '<div class="acc-field-err" id="acc-tk-err"></div>'
      + '<div class="acc-bin-actions">'
        + '<button class="btn-cta" id="acc-tk-save">Check and save</button>'
        + '<button class="acc-delete-cancel" id="acc-tk-cancel">Cancel</button>'
      + '</div>'
    + '</div>'
  + '</div>';
}

// Shown only to the trading account (the trader status check succeeds).
export function initTradingKeys() {
  var root = document.getElementById('acc-trade-keys');
  if (!root) return;
  checkAccess().then(function (status) {
    if (!status || !root.isConnected) return;
    root.style.display = 'block';
    var ipNote = document.getElementById('acc-tk-ip-note');
    if (ipNote) ipNote.textContent = status.publicIp
      ? 'For Live, restrict the key to IP ' + status.publicIp + '.'
      : 'For Live, restrict the key to the trading server IP.';
    _load();
  });
  document.getElementById('acc-tk-cancel').onclick = function () { _showForm(false); };
  document.getElementById('acc-tk-save').onclick = _save;
}

function _load() {
  tradeRequest('GET', 'keys').then(_renderList).catch(function (e) {
    var list = document.getElementById('acc-tk-list');
    if (list) list.innerHTML = '<div class="acc-field-err">' + e.message + '</div>';
  });
}

function _renderList(d) {
  var active = document.getElementById('acc-tk-active');
  var list = document.getElementById('acc-tk-list');
  if (!active || !list) return;
  active.textContent = 'Active: ' + ENV_LABEL[d.activeEnv];
  list.innerHTML = ['testnet', 'mainnet'].map(function (env) {
    var k = d.keys[env];
    var val = k
      ? k.apiKey + (k.savedAt ? ' · ' + new Date(k.savedAt).toLocaleDateString() : '') + (k.source === 'config' ? ' · server config' : '')
      : 'Not set';
    var warn = k && k.checks && k.checks.warning ? '<div class="acc-tk-warn">' + k.checks.warning + '</div>' : '';
    return '<div class="acc-row acc-tk-row">'
      + '<div class="acc-row-left"><div class="acc-row-label">' + ENV_LABEL[env] + (env === d.activeEnv ? ' · active' : '') + '</div>'
      + '<span class="acc-row-val">' + val + '</span>' + warn + '</div>'
      + '<div class="acc-tk-btns">'
      + '<button class="acc-row-edit" data-tk-edit="' + env + '">' + (k ? 'Change' : 'Add') + '</button>'
      + (k && k.source !== 'config' ? '<button class="acc-row-edit" data-tk-del="' + env + '">Delete</button>' : '')
      + '</div></div>';
  }).join('');
  list.querySelectorAll('[data-tk-edit]').forEach(function (b) {
    b.onclick = function () { document.getElementById('acc-tk-env').value = b.dataset.tkEdit; _showForm(true); };
  });
  list.querySelectorAll('[data-tk-del]').forEach(function (b) {
    b.onclick = function () { _delete(b.dataset.tkDel, b); };
  });
}

function _showForm(show) {
  var form = document.getElementById('acc-tk-form');
  if (!form) return;
  form.style.display = show ? 'block' : 'none';
  ['acc-tk-key', 'acc-tk-sec', 'acc-tk-pw'].forEach(function (id) { document.getElementById(id).value = ''; });
  document.getElementById('acc-tk-err').textContent = '';
}

function _save() {
  var btn = document.getElementById('acc-tk-save');
  var err = document.getElementById('acc-tk-err');
  var body = {
    env: document.getElementById('acc-tk-env').value,
    apiKey: document.getElementById('acc-tk-key').value.trim(),
    apiSecret: document.getElementById('acc-tk-sec').value.trim(),
    password: document.getElementById('acc-tk-pw').value,
  };
  err.textContent = '';
  if (!body.apiKey || !body.apiSecret) { err.textContent = 'Enter API key and Secret key'; return; }
  if (!body.password) { err.textContent = 'Enter your account password'; return; }
  btn.disabled = true; btn.classList.add('btn-loading');
  // HTTP, not the WebSocket shortcut: key management is password-gated on the server
  _post('keys', body).then(function (d) {
    _showForm(false);
    _renderList(d);
  }).catch(function (e) {
    err.textContent = e.message;
  }).finally(function () {
    btn.disabled = false; btn.classList.remove('btn-loading');
  });
}

function _delete(env, btn) {
  var password = prompt('Delete the ' + ENV_LABEL[env] + ' trading key? Enter your account password to confirm.');
  if (!password) return;
  btn.disabled = true;
  _post('keys/delete', { env: env, password: password }).then(_renderList).catch(function (e) {
    alert(e.message);
    btn.disabled = false;
  });
}

function _post(action, body) {
  // tradeRequest would route POSTs over the WebSocket; key changes must use HTTP
  return tradeRequest('POST_HTTP', action, body);
}
