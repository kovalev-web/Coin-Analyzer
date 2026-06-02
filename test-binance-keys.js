/**
 * test-binance-keys.js
 *
 * Режим 1 — без реальных ключей (базовые проверки):
 *   node test-binance-keys.js --cookie="..."
 *
 * Режим 2 — с реальными ключами (полный флоу):
 *   node test-binance-keys.js --cookie="..." --apiKey=KEY --apiSecret=SECRET
 *
 * Тесты без реальных ключей:
 *   1. /api/proxy без ключей → 403
 *   2. save-binance пустые поля → 400
 *   3. save-binance fake ключи → 400 (Binance отклоняет невалидные)
 *
 * Тесты с реальными ключами (дополнительно):
 *   4. save-binance валидные read-only → 200
 *   5. GET /api/account → binanceConnected: true, ключи не возвращаются
 *   6. /api/proxy с ключами → не 403
 *   7. delete-binance → 200
 *   8. GET /api/account → binanceConnected: false
 *   9. /api/proxy после удаления → 403
 */

var https = require('https');
var http  = require('http');

var BASE      = 'https://api.questtick.com';
var COOKIE    = '';
var REAL_KEY  = '';
var REAL_SEC  = '';

process.argv.slice(2).forEach(function (a) {
  if (a.startsWith('--cookie='))    COOKIE   = a.slice(9);
  else if (a.startsWith('--apiKey='))    REAL_KEY = a.slice(9);
  else if (a.startsWith('--apiSecret=')) REAL_SEC = a.slice(13);
  else if (!a.startsWith('--'))     BASE     = a.replace(/\/$/, '');
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

async function run() {
  console.log('\nТестируем: ' + BASE);
  console.log(REAL_KEY ? 'Режим: с реальными ключами (полные тесты)\n' : 'Режим: без реальных ключей (базовые тесты)\n');

  // Сбрасываем состояние
  await post('/api/account', { action: 'delete-binance' });

  // ── 1. /api/proxy без ключей → 403 ───────────────────────────────────
  console.log('── 1. Proxy без ключей ──');

  var r1a = await post('/api/proxy', { service: 'binance', payload: { symbol: 'BTCUSDT' } });
  log(r1a.status === 403, '/api/proxy (binance) без ключей → 403 (status=' + r1a.status + ')');

  var r1b = await post('/api/proxy', { service: 'binance-income', payload: {} });
  log(r1b.status === 403, '/api/proxy (binance-income) без ключей → 403 (status=' + r1b.status + ')');

  // ── 2. Валидация: пустые поля → 400 ──────────────────────────────────
  console.log('\n── 2. Валидация входных данных ──');

  var r2a = await post('/api/account', { action: 'save-binance', apiKey: '', apiSecret: '' });
  log(r2a.status === 400, 'Пустые ключи → 400 (status=' + r2a.status + ')');

  var r2b = await post('/api/account', { action: 'save-binance', apiKey: 'onlykey', apiSecret: '' });
  log(r2b.status === 400, 'Только apiKey без secret → 400 (status=' + r2b.status + ')');

  // ── 3. Валидация: fake ключи → Binance отклоняет → 400 ───────────────
  console.log('\n── 3. Проверка валидации через Binance ──');

  var FAKE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  var r3 = await post('/api/account', { action: 'save-binance', apiKey: FAKE, apiSecret: FAKE });
  log(r3.status === 400, 'Fake ключи отклонены Binance → 400 (status=' + r3.status + ')');
  log(r3.body && typeof r3.body.error === 'string' && r3.body.error.length > 0,
      'Возвращается понятное сообщение об ошибке: "' + (r3.body && r3.body.error ? r3.body.error.slice(0, 60) : '—') + '"');

  // Убеждаемся что fake ключи не сохранились
  var r3c = await get('/api/account');
  log(r3c.body && r3c.body.binanceConnected === false, 'После rejected save — binanceConnected остался false');

  if (!REAL_KEY || !REAL_SEC) {
    console.log('\n  ℹ️  Тесты 4-9 пропущены (нет --apiKey / --apiSecret).');
    console.log('     Запустите с реальными read-only Futures ключами для полного теста.\n');
  } else {
    // ── 4. Сохранение реальных read-only ключей ───────────────────────
    console.log('\n── 4. Сохранение валидных read-only ключей ──');

    var r4 = await post('/api/account', { action: 'save-binance', apiKey: REAL_KEY, apiSecret: REAL_SEC });
    log(r4.status === 200 && r4.body.ok, 'save-binance валидные ключи → 200 ok (status=' + r4.status + ')');

    // ── 5. GET /api/account ────────────────────────────────────────────
    console.log('\n── 5. binanceConnected + безопасность ──');

    var r5 = await get('/api/account');
    log(r5.body && r5.body.binanceConnected === true, 'binanceConnected: true после сохранения');
    log(!r5.body.apiKey && !r5.body.apiSecret && !r5.body.binanceKey,
        'Ключи не возвращаются в GET /api/account');

    // ── 6. /api/proxy читает ключи из Redis ───────────────────────────
    console.log('\n── 6. Proxy с реальными ключами ──');

    var r6 = await post('/api/proxy', { service: 'binance', payload: { symbol: 'BTCUSDT' } });
    log(r6.status !== 403, '/api/proxy не возвращает 403 (ключи из Redis) (status=' + r6.status + ')');
    log(r6.status === 200, '/api/proxy возвращает 200 с реальными ключами (status=' + r6.status + ')');

    // ── 7-9. Удаление и проверка ──────────────────────────────────────
    console.log('\n── 7. Удаление ключей ──');

    var r7 = await post('/api/account', { action: 'delete-binance' });
    log(r7.status === 200 && r7.body.ok, 'delete-binance → 200 ok');

    var r8 = await get('/api/account');
    log(r8.body && r8.body.binanceConnected === false, 'binanceConnected: false после удаления');

    var r9 = await post('/api/proxy', { service: 'binance', payload: { symbol: 'BTCUSDT' } });
    log(r9.status === 403, '/api/proxy после удаления → 403 снова');
  }

  // ── Итог ─────────────────────────────────────────────────────────────
  console.log('\n── Итог: ' + pass + ' прошло, ' + fail + ' упало ──\n');
  if (fail > 0) process.exit(1);
}

run().catch(function (e) { console.error(e); process.exit(1); });
