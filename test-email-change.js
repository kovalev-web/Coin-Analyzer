// test-email-change.js
// Проверяет флоу смены email через прямые HTTP-запросы к серверу.
// Запуск: npm run dev:ws  →  node test-email-change.js
//
// Нужны env-переменные (в .env):
//   TEST_USER_EMAIL    — email существующего тест-аккаунта с паролем
//   TEST_USER_PASS     — пароль тест-аккаунта
//   TEST_NEW_EMAIL     — новый email (например user+test@gmail.com)
//   UPSTASH_REDIS_REST_URL
//   UPSTASH_REDIS_REST_TOKEN

'use strict';
const fs = require('fs');
const path = require('path');

// Load .env
fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n').forEach(function (line) {
  var m = line.match(/^([A-Z0-9_]+)\s*=\s*"?([^"\r\n]*)"?\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
});

const BASE         = process.env.TEST_SERVER || 'http://localhost:3001';
const USER_EMAIL   = process.env.TEST_USER_EMAIL;
const USER_PASS    = process.env.TEST_USER_PASS;
const NEW_EMAIL    = process.env.TEST_NEW_EMAIL;
const REDIS_URL    = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN  = process.env.UPSTASH_REDIS_REST_TOKEN;

// ── helpers ──────────────────────────────────────────────────────────────────

var passed = 0, failed = 0;

function ok(label) { console.log('  ✓', label); passed++; }
function fail(label, detail) { console.log('  ✗', label, detail ? '→ ' + detail : ''); failed++; }

function assert(cond, label, detail) { cond ? ok(label) : fail(label, detail); }

async function redis(cmd) {
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + REDIS_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  return r.json();
}

// Сохраняет Set-Cookie из ответа
var _cookieJar = {};

function storeCookies(headers) {
  var raw = headers.get ? headers.get('set-cookie') : (headers['set-cookie'] || '');
  if (!raw) return;
  // node fetch может вернуть одну строку или массив
  var parts = Array.isArray(raw) ? raw : [raw];
  parts.forEach(function (c) {
    var m = c.match(/^([^=]+)=([^;]*)/);
    if (m) _cookieJar[m[1].trim()] = m[2].trim();
  });
}

function cookieHeader() {
  return Object.entries(_cookieJar).map(function (e) { return e[0] + '=' + e[1]; }).join('; ');
}

async function post(url, body) {
  var r = await fetch(BASE + url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(), Origin: 'https://questtick.com' },
    body: JSON.stringify(body),
  });
  storeCookies(r.headers);
  return { status: r.status, body: await r.json() };
}

async function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// Читаем код из Redis напрямую — имитирует «посмотрел письмо»
async function getCodeFromRedis(userId) {
  var r = await redis(['GET', 'email_chg_code:' + userId]);
  if (!r || !r.result) return null;
  try { return JSON.parse(r.result); } catch (e) { return null; }
}

async function getUserId() {
  var r = await post('/auth/get-session', {});
  return r.body && r.body.user ? r.body.user.id : null;
}

// ── login ─────────────────────────────────────────────────────────────────────

async function login() {
  var r = await post('/auth/sign-in/email', { email: USER_EMAIL, password: USER_PASS });
  if (r.status !== 200 || !r.body.user) {
    console.error('Не удалось войти:', r.body);
    process.exit(1);
  }
  console.log('Вошли как', r.body.user.email);
  return r.body.user.id;
}

// ── cleanup ───────────────────────────────────────────────────────────────────

async function cleanup(userId) {
  if (!userId) return;
  await Promise.all([
    redis(['DEL', 'email_chg_auth:' + userId]),
    redis(['DEL', 'email_chg_auth_code:' + userId]),
    redis(['DEL', 'email_chg_code:' + userId]),
  ]);
  // Убедиться что email вернулся к оригинальному (на случай если тест прошёл насквозь)
  // Это делается вручную или отдельным сценарием
}

// ── scenarios ─────────────────────────────────────────────────────────────────

async function scenario1_happyPath(userId) {
  console.log('\nСценарий 1 — счастливый путь');

  // Шаг 1: неверный пароль
  var r = await post('/api/account', { action: 'email-change-verify-identity', password: 'wrongpassword123' });
  assert(r.status === 400 && r.body.error, 'Неверный пароль → ошибка', JSON.stringify(r.body));

  // Шаг 1: верный пароль
  r = await post('/api/account', { action: 'email-change-verify-identity', password: USER_PASS });
  assert(r.status === 200 && r.body.ok, 'Верный пароль → ok', JSON.stringify(r.body));

  // Шаг 2: одинаковый email (текущий)
  r = await post('/api/account', { action: 'email-change-request', newEmail: USER_EMAIL });
  assert(r.status === 400, 'Свой же email → ошибка', JSON.stringify(r.body));

  // Нужно снова пройти re-auth после ошибки
  await post('/api/account', { action: 'email-change-verify-identity', password: USER_PASS });

  // Шаг 2: нормальный новый email
  r = await post('/api/account', { action: 'email-change-request', newEmail: NEW_EMAIL });
  assert(r.status === 200 && r.body.ok, 'Запрос смены → оба письма отправлены', JSON.stringify(r.body));

  // Проверяем что код появился в Redis
  var chgData = await getCodeFromRedis(userId);
  assert(!!chgData && !!chgData.code, 'Код в Redis существует', String(chgData));
  assert(chgData.newEmail === NEW_EMAIL, 'Redis содержит правильный новый email', String(chgData && chgData.newEmail));

  // Шаг 3: неверный код
  r = await post('/api/account', { action: 'email-change-confirm', code: '000000' });
  assert(r.status === 400 && /Неверный код/.test(r.body.error), 'Неверный код → ошибка с остатком попыток', JSON.stringify(r.body));

  // Шаг 3: верный код из Redis
  chgData = await getCodeFromRedis(userId);  // attempts обновились, перечитать
  r = await post('/api/account', { action: 'email-change-confirm', code: chgData.code });
  assert(r.status === 200 && r.body.ok, 'Верный код → ok', JSON.stringify(r.body));
  assert(r.body.newEmail === NEW_EMAIL, 'Ответ содержит новый email', JSON.stringify(r.body));

  // GET /api/account → email обновился
  var acc = await post('/auth/get-session', {});
  // Сессия обновится при следующем запросе, проверяем через api/account
  var accR = await fetch(BASE + '/api/account', { headers: { Cookie: cookieHeader() } });
  // session был revoked — ожидаем 401 (другие сессии убиты, текущая жива)
  // Текущая сессия должна работать
  assert(accR.status === 200, 'Текущая сессия жива после смены', 'status=' + accR.status);

  console.log('  → Нужно вручную вернуть email обратно для следующих тестов!');
}

async function scenario2_cancel(userId) {
  console.log('\nСценарий 2 — отмена через ссылку из письма');

  // re-auth
  var r = await post('/api/account', { action: 'email-change-verify-identity', password: USER_PASS });
  if (!r.body.ok) { fail('re-auth', JSON.stringify(r.body)); return; }

  // Запрос смены
  r = await post('/api/account', { action: 'email-change-request', newEmail: NEW_EMAIL });
  if (!r.body.ok) { fail('email-change-request', JSON.stringify(r.body)); return; }

  // Читаем cancelToken из Redis
  var chgData = await getCodeFromRedis(userId);
  assert(!!chgData && !!chgData.cancelToken, 'cancelToken в Redis', String(chgData));

  // Симулируем клик по ссылке из письма
  var cancelR = await fetch(BASE + '/api/cancel-email-change?token=' + chgData.cancelToken);
  assert(cancelR.status === 200, 'Cancel endpoint вернул 200');
  var html = await cancelR.text();
  assert(html.includes('Смена email отменена'), 'HTML страница содержит сообщение об отмене', html.slice(0, 200));

  // Redis должен быть очищен
  var after = await getCodeFromRedis(userId);
  assert(!after, 'Redis ключ удалён после отмены', JSON.stringify(after));

  // Попытка ввести код после отмены
  r = await post('/api/account', { action: 'email-change-confirm', code: chgData.code });
  assert(r.status === 400, 'Код после отмены → ошибка', JSON.stringify(r.body));
}

async function scenario3_pendingOnReopen(userId) {
  console.log('\nСценарий 3 — незавершённый флоу при переоткрытии модалки');

  // re-auth + запрос
  await post('/api/account', { action: 'email-change-verify-identity', password: USER_PASS });
  var r = await post('/api/account', { action: 'email-change-request', newEmail: NEW_EMAIL });
  if (!r.body.ok) { fail('email-change-request', JSON.stringify(r.body)); return; }

  // GET /api/account → pendingEmailChange должен быть в ответе
  var accR = await fetch(BASE + '/api/account', { headers: { Cookie: cookieHeader() } });
  var accData = await accR.json();
  assert(accData.pendingEmailChange === NEW_EMAIL, 'GET /api/account возвращает pendingEmailChange', JSON.stringify(accData.pendingEmailChange));

  // Cleanup — удаляем pending чтобы не мешало следующим тестам
  await redis(['DEL', 'email_chg_code:' + userId]);
  var check = await getCodeFromRedis(userId);
  assert(!check, 'Redis очищен после теста');
}

async function scenario4_maxAttempts(userId) {
  console.log('\nСценарий 4 — исчерпание попыток');

  await post('/api/account', { action: 'email-change-verify-identity', password: USER_PASS });
  var r = await post('/api/account', { action: 'email-change-request', newEmail: NEW_EMAIL });
  if (!r.body.ok) { fail('email-change-request', JSON.stringify(r.body)); return; }

  // 5 неверных попыток
  for (var i = 0; i < 4; i++) {
    r = await post('/api/account', { action: 'email-change-confirm', code: '000000' });
    assert(r.status === 400 && /Неверный код/.test(r.body.error), 'Попытка ' + (i+1) + ' → ошибка с остатком', r.body.error);
  }

  // 5-я попытка — должно заблокировать
  r = await post('/api/account', { action: 'email-change-confirm', code: '000000' });
  assert(r.status === 400 && /Слишком много/.test(r.body.error), '5-я попытка → "Слишком много попыток"', r.body.error);

  // После блокировки Redis должен быть очищен
  var after = await getCodeFromRedis(userId);
  assert(!after, 'Ключ удалён из Redis после исчерпания попыток');
}

async function scenario5_noAuthFlag(userId) {
  console.log('\nСценарий 5 — email-change-request без re-auth (прямой вызов)');

  // Убедиться что флага нет
  await redis(['DEL', 'email_chg_auth:' + userId]);

  var r = await post('/api/account', { action: 'email-change-request', newEmail: NEW_EMAIL });
  assert(r.status === 403 && /подтвердите личность/.test(r.body.error), 'Без re-auth → 403', JSON.stringify(r.body));
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!USER_EMAIL || !USER_PASS || !NEW_EMAIL || !REDIS_URL || !REDIS_TOKEN) {
    console.error('Не заданы env-переменные. Добавь в .env:');
    console.error('  TEST_USER_EMAIL=...');
    console.error('  TEST_USER_PASS=...');
    console.error('  TEST_NEW_EMAIL=...  (например user+test@gmail.com)');
    process.exit(1);
  }

  var userId = await login();
  await cleanup(userId);

  await scenario2_cancel(userId);
  await scenario3_pendingOnReopen(userId);
  await scenario4_maxAttempts(userId);
  await scenario5_noAuthFlag(userId);

  // Сценарий 1 последним — он реально меняет email
  console.log('\n⚠️  Сценарий 1 реально изменит email на', NEW_EMAIL);
  console.log('   После него нужно вручную вернуть email обратно (или использовать throwaway-аккаунт)\n');
  var lines = ['  y — запустить сценарий 1', '  n — пропустить'];
  lines.forEach(function (l) { console.log(l); });

  // В CI/автоматическом режиме — пропускаем сценарий 1
  if (process.env.CI || process.argv.includes('--no-email-change')) {
    console.log('\nCI-режим: сценарий 1 пропущен.');
  } else {
    await scenario1_happyPath(userId);
  }

  console.log('\n────────────────────────────────────');
  console.log('Результат:', passed, 'passed,', failed, 'failed');
  if (failed > 0) process.exit(1);
}

main().catch(function (e) { console.error(e); process.exit(1); });
