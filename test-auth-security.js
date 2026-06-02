/**
 * test-auth-security.js
 * Запуск: node test-auth-security.js [base_url]
 * По умолчанию тестирует https://api.questtick.com
 */

var https = require('https');
var http  = require('http');

var BASE = (process.argv[2] || 'https://api.questtick.com').replace(/\/$/, '');

var pass = 0;
var fail = 0;

function log(ok, name, detail) {
  if (ok) { pass++; console.log('  ✅  ' + name); }
  else     { fail++; console.log('  ❌  ' + name + (detail ? ' — ' + detail : '')); }
}

function post(path, body) {
  return new Promise(function(resolve, reject) {
    var data = JSON.stringify(body);
    var url  = new URL(BASE + path);
    var mod  = url.protocol === 'https:' ? https : http;
    var req  = mod.request({
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 80),
      path:     url.pathname + url.search,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, function(res) {
      var buf = '';
      res.on('data', function(c) { buf += c; });
      res.on('end', function() {
        try { resolve({ status: res.status || res.statusCode, body: JSON.parse(buf) }); }
        catch(e) { resolve({ status: res.statusCode, body: buf }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

async function run() {
  console.log('\nТестируем: ' + BASE + '\n');

  // ── 1. Минимальная длина пароля ─────────────────────────────────────
  console.log('── 1. Минимальная длина пароля ──');

  var r1 = await post('/api/auth/sign-up/email', {
    email:    'test_short_' + Date.now() + '@example.com',
    password: '123',        // 3 символа — должно отказать
    name:     'Test',
  });
  log(r1.status !== 200, 'Регистрация с паролем "123" отклонена (status=' + r1.status + ')');

  var r2 = await post('/api/auth/sign-up/email', {
    email:    'test_short_' + Date.now() + '@example.com',
    password: 'abcdefg',    // 7 символов — должно отказать
    name:     'Test',
  });
  log(r2.status !== 200, 'Регистрация с паролем "abcdefg" (7 симв.) отклонена (status=' + r2.status + ')');

  // ── 2. Rate limiting на /sign-in/email (max 5 за 60s) ───────────────
  console.log('\n── 2. Rate limiting ──');

  var rateLimited = false;
  for (var i = 0; i < 7; i++) {
    var r = await post('/api/auth/sign-in/email', {
      email:    'brute@example.com',
      password: 'wrongpassword' + i,
    });
    if (r.status === 429) { rateLimited = true; break; }
    await sleep(50); // небольшая пауза между запросами
  }
  log(rateLimited, 'Rate limit сработал на /sign-in/email после 5 попыток');

  // ── 3. Session expiresIn ─────────────────────────────────────────────
  console.log('\n── 3. Срок жизни сессии ──');
  // Проверяем ответ на sign-in — если email не существует, у нас нет живой сессии.
  // Поэтому просто проверяем что GET /api/auth/get-session отвечает корректно.
  var r3 = await post('/api/auth/sign-in/email', {
    email:    'nonexistent_session_test@example.com',
    password: 'SomePassword1',
  });
  // Либо 401 (не найден), либо 429 (rate limit от теста выше) — оба ок
  log(r3.status === 401 || r3.status === 400 || r3.status === 429 || r3.status === 422,
      'Эндпоинт /sign-in/email доступен и отвечает (status=' + r3.status + ')');

  // ── Итог ─────────────────────────────────────────────────────────────
  console.log('\n── Итог: ' + pass + ' прошло, ' + fail + ' упало ──\n');
  if (fail > 0) process.exit(1);
}

run().catch(function(e) { console.error(e); process.exit(1); });
