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
var forgotEl = document.getElementById('forgot-btn');
var magicEl  = document.getElementById('magic-btn');
var errEl    = document.getElementById('login-error');
var msgEl    = document.getElementById('login-msg');

function setMode(reg) {
  isRegister = reg;
  formEl.dataset.mode = '';
  submitEl.textContent = reg ? 'Зарегистрироваться' : 'Войти';
  toggleEl.textContent = reg ? 'Уже есть аккаунт? Войти' : 'Нет аккаунта? Зарегистрироваться';
  errEl.style.display = 'none';
  msgEl.style.display = 'none';
  formEl.style.display = 'block';
  passEl.style.display = 'block';
  passEl.required = true;
  toggleEl.style.display = 'block';
  forgotEl.style.display = reg ? 'none' : 'block';
  magicEl.style.display  = reg ? 'none' : 'block';
}

toggleEl.addEventListener('click', function () { setMode(!isRegister); });

magicEl.addEventListener('click', function () {
  errEl.style.display = 'none';
  msgEl.style.display = 'none';
  passEl.style.display = 'none';
  passEl.required = false;
  toggleEl.style.display = 'none';
  forgotEl.style.display = 'none';
  magicEl.style.display = 'none';
  submitEl.textContent = 'Отправить ссылку';
  isRegister = false;
  formEl.dataset.mode = 'magic';
});

forgotEl.addEventListener('click', function () {
  errEl.style.display = 'none';
  msgEl.style.display = 'none';
  passEl.style.display = 'none';
  passEl.required = false;
  toggleEl.style.display = 'none';
  forgotEl.style.display = 'none';
  submitEl.textContent = 'Отправить письмо';
  isRegister = false;
  formEl.dataset.mode = 'forgot';
});

formEl.addEventListener('submit', async function (e) {
  e.preventDefault();
  errEl.style.display = 'none';
  msgEl.style.display = 'none';
  submitEl.disabled = true;
  submitEl.textContent = '…';

  var email = emailEl.value.trim();

  if (formEl.dataset.mode === 'magic') {
    try {
      var r = await fetch(API_BASE + '/auth/magic-link/send-magic-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, callbackURL: 'https://questtick.com' }),
      });
      if (!r.ok) {
        var d = await r.json();
        errEl.textContent = d.message || 'Ошибка отправки';
        errEl.style.display = 'block';
        submitEl.disabled = false;
        submitEl.textContent = 'Отправить ссылку';
      } else {
        formEl.style.display = 'none';
        msgEl.innerHTML = 'Письмо отправлено на <b>' + email + '</b><br>Перейдите по ссылке в письме чтобы войти.';
        msgEl.style.display = 'block';
      }
    } catch (err) {
      errEl.textContent = 'Сетевая ошибка: ' + err.message;
      errEl.style.display = 'block';
      submitEl.disabled = false;
      submitEl.textContent = 'Отправить ссылку';
    }
    return;
  }

  if (formEl.dataset.mode === 'forgot') {
    try {
      var r = await fetch(API_BASE + '/auth/request-password-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, redirectTo: 'https://questtick.com/reset-password' }),
      });
      formEl.style.display = 'none';
      msgEl.innerHTML = 'Письмо отправлено на <b>' + email + '</b><br>Перейдите по ссылке в письме чтобы задать новый пароль.';
      msgEl.style.display = 'block';
      forgotEl.style.display = 'none';
    } catch (err) {
      errEl.textContent = 'Сетевая ошибка: ' + err.message;
      errEl.style.display = 'block';
      submitEl.disabled = false;
      submitEl.textContent = 'Отправить письмо';
    }
    return;
  }

  var password = passEl.value;
  var endpoint = isRegister ? '/auth/sign-up/email' : '/auth/sign-in/email';
  var body     = isRegister
    ? { email: email, password: password, name: email.split('@')[0], callbackURL: 'https://questtick.com' }
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
      var isUnverified = data.code === 'EMAIL_NOT_VERIFIED' ||
        (data.message || '').toLowerCase().includes('not verified') ||
        (data.message || '').toLowerCase().includes('email verification');
      if (isUnverified) {
        showUnverified(email);
      } else {
        errEl.textContent = data.message || (isRegister ? 'Ошибка регистрации' : 'Неверный email или пароль');
        errEl.style.display = 'block';
      }
    } else {
      if (isRegister) {
        showEmailSent(email);
      } else {
        window.location.replace('/');
      }
    }
  } catch (err) {
    errEl.textContent = 'Сетевая ошибка: ' + err.message;
    errEl.style.display = 'block';
  }

  submitEl.disabled = false;
  submitEl.textContent = isRegister ? 'Зарегистрироваться' : 'Войти';
});

function showEmailSent(email) {
  formEl.style.display = 'none';
  toggleEl.style.display = 'none';
  msgEl.innerHTML = 'Письмо отправлено на <b>' + email + '</b><br>Перейдите по ссылке в письме чтобы подтвердить аккаунт и войти.';
  msgEl.style.display = 'block';
}

function showUnverified(email) {
  errEl.innerHTML = 'Email не подтверждён. <button id="resend-btn" style="background:none;border:none;color:#f08080;text-decoration:underline;cursor:pointer;padding:0;font-size:13px;">Отправить повторно</button>';
  errEl.style.display = 'block';
  document.getElementById('resend-btn').addEventListener('click', async function () {
    var btn = document.getElementById('resend-btn');
    btn.textContent = '…'; btn.disabled = true;
    try {
      await fetch(API_BASE + '/auth/send-verification-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email: email, callbackURL: 'https://questtick.com' }),
      });
      errEl.textContent = 'Письмо отправлено — проверьте почту.';
    } catch (err) {
      errEl.textContent = 'Ошибка отправки. Попробуйте ещё раз.';
    }
  });
}
