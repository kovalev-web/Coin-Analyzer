var API_BASE = (import.meta.env.VITE_WS_URL || '')
  .replace(/^wss?:\/\//, 'https://')
  .replace(/\/ws$/, '');

fetch(API_BASE + '/auth/get-session', { credentials: 'include' })
  .then(function (r) { return r.json(); })
  .then(function (s) { if (s && s.user) window.location.replace('/'); })
  .catch(function () {});

var isRegister = false;

var formEl   = document.getElementById('login-form');
var emailEl  = document.getElementById('email');
var passEl   = document.getElementById('password');
var submitEl = document.getElementById('submit-btn');
var toggleEl = document.getElementById('toggle-mode');
var errEl    = document.getElementById('login-error');

function setMode(reg) {
  isRegister = reg;
  submitEl.textContent = reg ? 'Зарегистрироваться' : 'Войти';
  toggleEl.textContent = reg ? 'Уже есть аккаунт? Войти' : 'Нет аккаунта? Зарегистрироваться';
  errEl.style.display = 'none';
}

toggleEl.addEventListener('click', function () { setMode(!isRegister); });

formEl.addEventListener('submit', async function (e) {
  e.preventDefault();
  errEl.style.display = 'none';
  submitEl.disabled = true;
  submitEl.textContent = '…';

  var email    = emailEl.value.trim();
  var password = passEl.value;
  var endpoint = isRegister ? '/auth/sign-up/email' : '/auth/sign-in/email';
  var body     = isRegister
    ? { email: email, password: password, name: email.split('@')[0] }
    : { email: email, password: password };

  try {
    var res  = await fetch(API_BASE + endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    });
    var data = await res.json();
    if (!res.ok) {
      errEl.textContent = data.message || (isRegister ? 'Ошибка регистрации' : 'Неверный email или пароль');
      errEl.style.display = 'block';
    } else {
      window.location.replace('/');
    }
  } catch (err) {
    errEl.textContent = 'Сетевая ошибка: ' + err.message;
    errEl.style.display = 'block';
  }

  submitEl.disabled = false;
  submitEl.textContent = isRegister ? 'Зарегистрироваться' : 'Войти';
});
