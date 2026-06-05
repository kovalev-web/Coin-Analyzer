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

// Подставляем сохранённый email если есть
var savedEmail = localStorage.getItem('pa_last_email');
if (savedEmail) emailEl.value = savedEmail;
var passEl   = document.getElementById('password');
var submitEl = document.getElementById('submit-btn');
var toggleEl = document.getElementById('toggle-mode');
var forgotEl = document.getElementById('forgot-btn');
var googleEl = document.getElementById('google-btn');
var errEl    = document.getElementById('login-error');
var msgEl    = document.getElementById('login-msg');

function setMode(reg) {
  isRegister = reg;
  formEl.dataset.mode = '';
  submitEl.textContent = reg ? 'Sign up' : 'Sign in';
  toggleEl.textContent = reg ? 'Already have an account? Sign in' : 'No account? Sign up';
  errEl.style.display = 'none';
  msgEl.style.display = 'none';
  formEl.style.display = 'block';
  passEl.style.display = 'block';
  passEl.required = true;
  toggleEl.style.display = 'block';
  forgotEl.style.display = reg ? 'none' : 'block';
}

googleEl.addEventListener('click', async function () {
  googleEl.disabled = true;
  try {
    var res = await fetch(API_BASE + '/auth/sign-in/social', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ provider: 'google', callbackURL: 'https://questtick.com' }),
    });
    var data = await res.json();
    if (data.url) {
      window.location.href = data.url;
    } else {
      errEl.textContent = data.message || 'Google sign-in error';
      errEl.style.display = 'block';
      googleEl.disabled = false;
    }
  } catch (err) {
    errEl.textContent = 'Network error: ' + err.message;
    errEl.style.display = 'block';
    googleEl.disabled = false;
  }
});

toggleEl.addEventListener('click', function () { setMode(!isRegister); });

forgotEl.addEventListener('click', function () {
  errEl.style.display = 'none';
  msgEl.style.display = 'none';
  passEl.style.display = 'none';
  passEl.required = false;
  toggleEl.style.display = 'none';
  forgotEl.style.display = 'none';
  submitEl.textContent = 'Send email';
  isRegister = false;
  formEl.dataset.mode = 'forgot';
});

formEl.addEventListener('submit', async function (e) {
  e.preventDefault();
  errEl.style.display = 'none';
  msgEl.style.display = 'none';
  submitEl.disabled = true;
  submitEl.classList.add('btn-loading');

  var email = emailEl.value.trim();

  if (formEl.dataset.mode === 'forgot') {
    try {
      await fetch(API_BASE + '/auth/request-password-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, redirectTo: 'https://questtick.com/reset-password' }),
      });
      formEl.style.display = 'none';
      msgEl.innerHTML = 'Email sent to <b>' + email + '</b><br>Click the link in the email to set a new password.';
      msgEl.style.display = 'block';
      forgotEl.style.display = 'none';
    } catch (err) {
      errEl.textContent = 'Network error: ' + err.message;
      errEl.style.display = 'block';
      submitEl.disabled = false;
      submitEl.classList.remove('btn-loading');
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
        errEl.textContent = data.message || (isRegister ? 'Sign up error' : 'Invalid email or password');
        errEl.style.display = 'block';
      }
    } else {
      if (isRegister) {
        showEmailSent(email);
      } else {
        try { localStorage.setItem('pa_last_email', email); } catch (e) {}
        window.location.replace('/');
      }
    }
  } catch (err) {
    errEl.textContent = 'Network error: ' + err.message;
    errEl.style.display = 'block';
  }

  submitEl.disabled = false;
  submitEl.classList.remove('btn-loading');
});

function showEmailSent(email) {
  formEl.style.display = 'none';
  toggleEl.style.display = 'none';
  msgEl.innerHTML = 'Email sent to <b>' + email + '</b><br>Click the link in the email to verify your account and sign in.';
  msgEl.style.display = 'block';
}

function showUnverified(email) {
  errEl.innerHTML = 'Email not verified. <button id="resend-btn" style="background:none;border:none;color:var(--danger);text-decoration:underline;cursor:pointer;padding:0;font-size:var(--text-xs);">Resend</button>';
  errEl.style.display = 'block';
  document.getElementById('resend-btn').addEventListener('click', async function () {
    var btn = document.getElementById('resend-btn');
    btn.classList.add('btn-loading'); btn.disabled = true;
    try {
      await fetch(API_BASE + '/auth/send-verification-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email: email, callbackURL: 'https://questtick.com' }),
      });
      errEl.textContent = 'Email sent — check your inbox.';
    } catch (err) {
      errEl.textContent = 'Failed to send. Please try again.';
    }
  });
}
