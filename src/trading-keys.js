// ── Trading API keys in the account page ──────────────────────────────────────
// Separate from the read-only journal key: these keys can trade. They go to the
// trader process on the server (encrypted at rest) and are never sent back —
// the page only sees a masked key. Saving or deleting needs the account password.

import { tradeRequest } from './api.js';
import { checkAccess } from './terminal.js';
import qrcode from 'qrcode-generator';

var ENV_LABEL = { testnet: 'Testnet', mainnet: 'Live' };
var _twoFA = { enabled: false };

export function tradingKeysHTML() {
  return '<div id="acc-trade-keys" style="display:none">'
    + '<div class="acc-row">'
      + '<div class="acc-row-left">'
        + '<div class="acc-row-label">TRADING API</div>'
        + '<span class="acc-row-val" id="acc-tk-active"></span>'
      + '</div>'
    + '</div>'
    + '<div id="acc-tk-list"></div>'
    + '<div class="acc-row acc-tk-row">'
      + '<div class="acc-row-left"><div class="acc-row-label">2FA for trading</div>'
        + '<span class="acc-row-val" id="acc-2fa-val">…</span></div>'
      + '<div class="acc-tk-btns" id="acc-2fa-btns"></div>'
    + '</div>'
    + '<div id="acc-2fa-box" class="acc-tk-form" style="display:none"></div>'
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
      + '<div class="acc-tk-field" id="acc-tk-code-wrap" style="display:none"><div class="acc-row-label">2FA code</div>'
        + '<input type="text" id="acc-tk-code" inputmode="numeric" maxlength="6" placeholder="123456" autocomplete="one-time-code" class="ds-input"></div>'
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
    _load2fa();
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
  ['acc-tk-key', 'acc-tk-sec', 'acc-tk-pw', 'acc-tk-code'].forEach(function (id) { document.getElementById(id).value = ''; });
  document.getElementById('acc-tk-code-wrap').style.display = _twoFA.enabled ? 'block' : 'none';
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
    code: document.getElementById('acc-tk-code').value.trim(),
  };
  err.textContent = '';
  if (!body.apiKey || !body.apiSecret) { err.textContent = 'Enter API key and Secret key'; return; }
  if (!body.password) { err.textContent = 'Enter your account password'; return; }
  if (_twoFA.enabled && !/^\d{6}$/.test(body.code)) { err.textContent = 'Enter the 6-digit code from your authenticator'; return; }
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
  var code = _twoFA.enabled ? prompt('Enter the 6-digit 2FA code') : undefined;
  if (_twoFA.enabled && !code) return;
  btn.disabled = true;
  _post('keys/delete', { env: env, password: password, code: code }).then(_renderList).catch(function (e) {
    alert(e.message);
    btn.disabled = false;
  });
}

function _post(action, body) {
  // tradeRequest would route POSTs over the WebSocket; key changes must use HTTP
  return tradeRequest('POST_HTTP', action, body);
}

// ── 2FA (TOTP) ──────────────────────────────────────────────────────────────

function _load2fa() {
  tradeRequest('GET', '2fa').then(_render2fa).catch(function () {});
}

function _render2fa(st) {
  _twoFA = st || { enabled: false };
  var val = document.getElementById('acc-2fa-val');
  var btns = document.getElementById('acc-2fa-btns');
  if (!val || !btns) return;
  val.textContent = _twoFA.enabled ? 'On' : (_twoFA.required ? 'Off — required for live trading' : 'Off');
  btns.innerHTML = _twoFA.enabled
    ? '<button class="acc-row-edit" id="acc-2fa-off">Turn off</button>'
    : '<button class="acc-row-edit" id="acc-2fa-on">Set up</button>';
  var on = document.getElementById('acc-2fa-on'), off = document.getElementById('acc-2fa-off');
  if (on) on.onclick = _startSetup;
  if (off) off.onclick = _disable2fa;
  var codeWrap = document.getElementById('acc-tk-code-wrap');
  if (codeWrap) codeWrap.style.display = _twoFA.enabled ? 'block' : 'none';
}

function _box(html) {
  var box = document.getElementById('acc-2fa-box');
  box.style.display = html ? 'block' : 'none';
  box.innerHTML = html || '';
  return box;
}

function _startSetup() {
  _box('<div class="acc-tk-field"><div class="acc-row-label">Account password</div>'
    + '<input type="password" id="acc-2fa-pw" autocomplete="current-password" class="ds-input"></div>'
    + '<div class="acc-field-err" id="acc-2fa-err"></div>'
    + '<div class="acc-bin-actions"><button class="btn-cta" id="acc-2fa-gen">Continue</button>'
    + '<button class="acc-delete-cancel" id="acc-2fa-cancel">Cancel</button></div>');
  document.getElementById('acc-2fa-cancel').onclick = function () { _box(null); };
  document.getElementById('acc-2fa-gen').onclick = function () {
    var btn = this, err = document.getElementById('acc-2fa-err');
    var pw = document.getElementById('acc-2fa-pw').value;
    if (!pw) { err.textContent = 'Enter your account password'; return; }
    btn.disabled = true; btn.classList.add('btn-loading');
    _post('2fa/setup', { password: pw }).then(_showQr).catch(function (e) {
      err.textContent = e.message; btn.disabled = false; btn.classList.remove('btn-loading');
    });
  };
}

function _showQr(setup) {
  var qr = qrcode(0, 'M');
  qr.addData(setup.uri);
  qr.make();
  _box('<div class="acc-tk-note">Scan with Google Authenticator (or any TOTP app), then enter the 6-digit code it shows.</div>'
    + '<div class="acc-2fa-qr">' + qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }) + '</div>'
    + '<div class="acc-2fa-secret">Can\'t scan? Enter this key: <code>' + setup.secret.replace(/(.{4})/g, '$1 ').trim() + '</code></div>'
    + '<div class="acc-tk-field"><div class="acc-row-label">Code</div>'
    + '<input type="text" id="acc-2fa-code" inputmode="numeric" maxlength="6" placeholder="123456" autocomplete="one-time-code" class="ds-input"></div>'
    + '<div class="acc-field-err" id="acc-2fa-err"></div>'
    + '<div class="acc-bin-actions"><button class="btn-cta" id="acc-2fa-confirm">Turn on</button>'
    + '<button class="acc-delete-cancel" id="acc-2fa-cancel">Cancel</button></div>');
  document.getElementById('acc-2fa-cancel').onclick = function () { _box(null); };
  document.getElementById('acc-2fa-confirm').onclick = function () {
    var btn = this, err = document.getElementById('acc-2fa-err');
    var code = document.getElementById('acc-2fa-code').value.trim();
    if (!/^\d{6}$/.test(code)) { err.textContent = 'Enter the 6-digit code'; return; }
    btn.disabled = true; btn.classList.add('btn-loading');
    _post('2fa/confirm', { code: code }).then(function (st) { _box(null); _render2fa(st); }).catch(function (e) {
      err.textContent = e.message; btn.disabled = false; btn.classList.remove('btn-loading');
    });
  };
}

function _disable2fa() {
  _box('<div class="acc-tk-note">Turning 2FA off removes the code check before trading. Live trading stays blocked without it.</div>'
    + '<div class="acc-tk-field"><div class="acc-row-label">Account password</div>'
    + '<input type="password" id="acc-2fa-pw" autocomplete="current-password" class="ds-input"></div>'
    + '<div class="acc-tk-field"><div class="acc-row-label">2FA code</div>'
    + '<input type="text" id="acc-2fa-code" inputmode="numeric" maxlength="6" placeholder="123456" autocomplete="one-time-code" class="ds-input"></div>'
    + '<div class="acc-field-err" id="acc-2fa-err"></div>'
    + '<div class="acc-bin-actions"><button class="btn-cta danger" id="acc-2fa-confirm">Turn off</button>'
    + '<button class="acc-delete-cancel" id="acc-2fa-cancel">Cancel</button></div>');
  document.getElementById('acc-2fa-cancel').onclick = function () { _box(null); };
  document.getElementById('acc-2fa-confirm').onclick = function () {
    var btn = this, err = document.getElementById('acc-2fa-err');
    var pw = document.getElementById('acc-2fa-pw').value, code = document.getElementById('acc-2fa-code').value.trim();
    if (!pw || !/^\d{6}$/.test(code)) { err.textContent = 'Enter your password and the 6-digit code'; return; }
    btn.disabled = true; btn.classList.add('btn-loading');
    _post('2fa/disable', { password: pw, code: code }).then(function (st) { _box(null); _render2fa(st); }).catch(function (e) {
      err.textContent = e.message; btn.disabled = false; btn.classList.remove('btn-loading');
    });
  };
}
