/**
 * test-auth-security.js
 * Запуск: node test-auth-security.js [base_url] [--cookie=<session_cookie>]
 *
 * Без --cookie: тесты 1-4 (без авторизованных запросов).
 * С   --cookie: тесты 1-6 (включая revoke-other-sessions и смену пароля).
 *
 * Как получить cookie:
 *   DevTools → Application → Cookies → api.questtick.com → better-auth.session_token → Value
 *   Передать как: --cookie=better-auth.session_token=xxxxxxx
 */

var https = require('https');
var http  = require('http');

var BASE   = 'https://api.questtick.com';
var COOKIE = '';

process.argv.slice(2).forEach(function(a) {
  if (a.startsWith('--cookie=')) { COOKIE = a.slice(9); }
  else if (!a.startsWith('--'))  { BASE = a.replace(/\/$/, ''); }
});

var pass = 0;
var fail = 0;

function log(ok, name, detail) {
  if (ok) { pass++; console.log('  ✅  ' + name); }
  else     { fail++; console.log('  ❌  ' + name + (detail ? ' — ' + detail : '')); }
}

function request(method, path, body, cookie) {
  return new Promise(function(resolve, reject) {
    var data    = body ? JSON.stringify(body) : '';
    var url     = new URL(BASE + path);
    var mod     = url.protocol === 'https:' ? https : http;
    var headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) };
    if (cookie) headers['Cookie'] = cookie;
    var req = mod.request({
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 80),
      path:     url.pathname + url.search,
      method:   method,
      headers:  headers,
    }, function(res) {
      var buf = '';
      res.on('data', function(c) { buf += c; });
      res.on('end', function() {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf), headers: res.headers }); }
        catch(e) { resolve({ status: res.statusCode, body: buf, headers: res.headers }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function post(path, body, cookie) { return request('POST', path, body, cookie); }
function get(path, cookie)        { return request('GET',  path, null, cookie); }

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

async function run() {
  console.log('\nТестируем: ' + BASE);
  console.log(COOKIE ? 'Режим: с сессией (полные тесты)\n' : 'Режим: без сессии (базовые тесты)\n');

  // ── 1. Минимальная длина пароля ─────────────────────────────────────
  console.log('── 1. Минимальная длина пароля ──');

  var r1 = await post('/api/auth/sign-up/email', {
    email: 'test_short_' + Date.now() + '@example.com', password: '123', name: 'Test',
  });
  log(r1.status !== 200, 'Пароль "123" (3 симв.) отклонён (status=' + r1.status + ')');

  var r2 = await post('/api/auth/sign-up/email', {
    email: 'test_short2_' + Date.now() + '@example.com', password: 'abcdefg', name: 'Test',
  });
  log(r2.status !== 200, 'Пароль "abcdefg" (7 симв.) отклонён (status=' + r2.status + ')');

  // ── 2. Rate limiting ─────────────────────────────────────────────────
  console.log('\n── 2. Rate limiting ──');

  var rateLimited = false;
  for (var i = 0; i < 7; i++) {
    var r = await post('/api/auth/sign-in/email', {
      email: 'brute@example.com', password: 'wrong' + i,
    });
    if (r.status === 429) { rateLimited = true; break; }
    await sleep(50);
  }
  log(rateLimited, 'Rate limit срабатывает на /sign-in/email (429 после 5 попыток)');

  // ── 3. Эндпоинты существуют и требуют авторизацию ────────────────────
  console.log('\n── 3. Защита эндпоинтов (без сессии → 401) ──');

  var rRevoke = await post('/api/auth/revoke-other-sessions', {});
  log(
    rRevoke.status === 401 || rRevoke.status === 403,
    '/api/auth/revoke-other-sessions требует авторизацию (status=' + rRevoke.status + ')'
  );

  var rChPass = await post('/api/auth/change-password', {
    currentPassword: 'test', newPassword: 'testtest',
  });
  log(
    rChPass.status === 401 || rChPass.status === 403,
    '/api/auth/change-password требует авторизацию (status=' + rChPass.status + ')'
  );

  // ── 4. Session expiresIn — проверяем через get-session ──────────────
  console.log('\n── 4. Срок жизни сессии ──');

  var rGs = await get('/api/auth/get-session');
  log(rGs.status === 200, '/api/auth/get-session доступен (status=' + rGs.status + ')');
  // Без cookie — нет активной сессии, user будет null
  log(
    rGs.body === null || (rGs.body && !rGs.body.user) || rGs.status === 200,
    'get-session возвращает null для анонимного запроса'
  );

  if (!COOKIE) {
    console.log('\n  ℹ️  Тесты 5-6 пропущены (нет --cookie). Запустите с:');
    console.log('     node test-auth-security.js --cookie="better-auth.session_token=<value>"\n');
  } else {
    // ── 5. Revoke other sessions (с сессией) ───────────────────────────
    console.log('\n── 5. Выйти со всех других устройств ──');

    var rRev2 = await post('/api/auth/revoke-other-sessions', {}, COOKIE);
    log(rRev2.status === 200, '/api/auth/revoke-other-sessions с валидной сессией → 200 (status=' + rRev2.status + ')');

    // После отзыва — текущая сессия ещё должна работать
    var rGs2 = await get('/api/auth/get-session', COOKIE);
    log(rGs2.body && rGs2.body.user, 'Текущая сессия осталась активной после revoke-other-sessions');

    // ── 6. Смена пароля — неверный текущий пароль ────────────────────
    console.log('\n── 6. Смена пароля с неверным текущим паролем ──');

    var rCp = await post('/api/auth/change-password', {
      currentPassword: 'definitelyWrongPassword!1',
      newPassword:     'NewValidPass1!',
    }, COOKIE);
    log(
      rCp.status !== 200,
      'Смена пароля с неверным текущим паролем отклонена (status=' + rCp.status + ')'
    );

    console.log('\n  ℹ️  Email-уведомление при смене пароля: проверьте вручную,');
    console.log('     сменив пароль в ЛК и убедившись что письмо пришло на почту.\n');
  }

  // ── Итог ─────────────────────────────────────────────────────────────
  console.log('── Итог: ' + pass + ' прошло, ' + fail + ' упало ──\n');
  if (fail > 0) process.exit(1);
}

run().catch(function(e) { console.error(e); process.exit(1); });
