/**
 * test-binance-keys.js
 * Запуск: node test-binance-keys.js --cookie="__Secure-better-auth.session_token=VALUE"
 *
 * Тестирует per-user Binance API keys flow:
 * 1. /api/proxy без ключей → 403
 * 2. save-binance → сохранение ключей
 * 3. GET /api/account → binanceConnected: true
 * 4. /api/proxy с ключами → не 403 (ключи читаются из Redis)
 * 5. delete-binance → удаление ключей
 * 6. GET /api/account → binanceConnected: false
 * 7. /api/proxy снова → 403
 */

var https = require('https');
var http  = require('http');

var BASE   = 'https://api.questtick.com';
var COOKIE = '';

process.argv.slice(2).forEach(function (a) {
  if (a.startsWith('--cookie=')) COOKIE = a.slice(9);
  else if (!a.startsWith('--')) BASE = a.replace(/\/$/, '');
});

if (!COOKIE) {
  console.error('Нужна сессия: node test-binance-keys.js --cookie="__Secure-better-auth.session_token=VALUE"');
  process.exit(1);
}

var pass = 0, fail = 0;

function log(ok, name, detail) {
  if (ok) { pass++; console.log('  ✅  ' + name); }
  else     { fail++; console.log('  ❌  ' + name + (detail ? ' — ' + detail : '')); }
}

function req(method, path, body, cookie) {
  return new Promise(function (resolve, reject) {
    var data = body ? JSON.stringify(body) : '';
    var url  = new URL(BASE + path);
    var mod  = url.protocol === 'https:' ? https : http;
    var headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'Origin': BASE };
    if (cookie) headers['Cookie'] = cookie;
    var r = mod.request({ hostname: url.hostname, port: url.port || 443, path: url.pathname, method: method, headers: headers }, function (res) {
      var buf = '';
      res.on('data', function (c) { buf += c; });
      res.on('end', function () {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch (e) { resolve({ status: res.statusCode, body: buf }); }
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function post(path, body) { return req('POST', path, body, COOKIE); }
function get(path)        { return req('GET',  path, null, COOKIE); }

// Fake keys for testing (obviously invalid, but test the flow)
var FAKE_KEY = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
var FAKE_SEC = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

async function run() {
  console.log('\nТестируем: ' + BASE + '\n');

  // ── 1. /api/proxy без ключей должен вернуть 403 ──────────────────────
  console.log('── 1. Proxy без ключей ──');

  // Сначала убедимся что ключей нет — удалим на всякий случай
  await post('/api/account', { action: 'delete-binance' });

  var r1 = await post('/api/proxy', { service: 'binance', payload: { symbol: 'BTCUSDT' } });
  log(r1.status === 403, '/api/proxy без ключей → 403 (status=' + r1.status + ')');

  var r1b = await post('/api/proxy', { service: 'binance-income', payload: {} });
  log(r1b.status === 403, '/api/proxy binance-income без ключей → 403 (status=' + r1b.status + ')');

  // ── 2. Сохраняем ключи ────────────────────────────────────────────────
  console.log('\n── 2. Сохранение ключей ──');

  var r2 = await post('/api/account', { action: 'save-binance', apiKey: FAKE_KEY, apiSecret: FAKE_SEC });
  log(r2.status === 200 && r2.body.ok, 'save-binance → 200 ok (status=' + r2.status + ')');

  // Валидация: пустые поля должны вернуть 400
  var r2b = await post('/api/account', { action: 'save-binance', apiKey: '', apiSecret: '' });
  log(r2b.status === 400, 'save-binance с пустыми полями → 400 (status=' + r2b.status + ')');

  // ── 3. GET /api/account должен вернуть binanceConnected: true ─────────
  console.log('\n── 3. binanceConnected после сохранения ──');

  var r3 = await get('/api/account');
  log(r3.status === 200 && r3.body.binanceConnected === true, 'GET /api/account → binanceConnected: true');
  // Ключи НЕ должны возвращаться в ответе
  log(!r3.body.apiKey && !r3.body.apiSecret && !r3.body.binanceKey,
      'Ключи не возвращаются в GET /api/account');

  // ── 4. /api/proxy с ключами — дойдёт до Binance (вернёт ошибку от них, но не 403) ──
  console.log('\n── 4. Proxy с ключами (fake) ──');

  var r4 = await post('/api/proxy', { service: 'binance', payload: { symbol: 'BTCUSDT' } });
  log(r4.status !== 403, '/api/proxy с ключами не возвращает 403 (читает из Redis) (status=' + r4.status + ')');
  // Ожидаем 502 с ошибкой от Binance (подпись неверная), но не 403
  log(r4.status === 502 || r4.status === 400, 'Binance вернул ошибку подписи (ожидаемо для fake keys) (status=' + r4.status + ')');

  // ── 5. Удаляем ключи ──────────────────────────────────────────────────
  console.log('\n── 5. Удаление ключей ──');

  var r5 = await post('/api/account', { action: 'delete-binance' });
  log(r5.status === 200 && r5.body.ok, 'delete-binance → 200 ok');

  // ── 6. binanceConnected должен стать false ────────────────────────────
  console.log('\n── 6. binanceConnected после удаления ──');

  var r6 = await get('/api/account');
  log(r6.status === 200 && r6.body.binanceConnected === false, 'GET /api/account → binanceConnected: false');

  // ── 7. /api/proxy снова → 403 ─────────────────────────────────────────
  console.log('\n── 7. Proxy после удаления ──');

  var r7 = await post('/api/proxy', { service: 'binance', payload: { symbol: 'BTCUSDT' } });
  log(r7.status === 403, '/api/proxy после delete-binance → 403 снова');

  // ── Итог ─────────────────────────────────────────────────────────────
  console.log('\n── Итог: ' + pass + ' прошло, ' + fail + ' упало ──\n');
  if (fail > 0) process.exit(1);
}

run().catch(function (e) { console.error(e); process.exit(1); });
