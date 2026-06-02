const { betterAuth } = require('better-auth');
const { drizzleAdapter } = require('better-auth/adapters/drizzle');
const { getDb } = require('./db/index');
const schema = require('./db/schema');
const { Resend } = require('resend');

var _auth = null;

function getAuth() {
  if (_auth) return _auth;
  var { drizzle } = getDb();
  var resend = new Resend(process.env.RESEND_API_KEY);
  _auth = betterAuth({
    database: drizzleAdapter(drizzle, {
      provider: 'sqlite',
      schema: {
        user:         schema.user,
        session:      schema.session,
        account:      schema.account,
        verification: schema.verification,
      },
    }),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      minPasswordLength: 8,
      sendResetPassword: async function ({ user, token }) {
        var resetUrl = 'https://questtick.com/reset-password?token=' + token;
        await resend.emails.send({
          from: 'Questtick <noreply@questtick.com>',
          to: user.email,
          subject: 'Сброс пароля — Questtick',
          html: '<p>Нажмите кнопку ниже, чтобы задать новый пароль.</p>'
              + '<p><a href="' + resetUrl + '" style="display:inline-block;padding:12px 24px;background:#024ad8;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;">Задать новый пароль</a></p>'
              + '<p style="color:#888;font-size:12px;">Если вы не запрашивали сброс — просто проигнорируйте это письмо.</p>',
        });
      },
    },
    session: {
      expiresIn:  60 * 60 * 24 * 30, // 30 дней
      updateAge:  60 * 60 * 24,       // обновлять сессию раз в сутки
    },
    rateLimit: {
      enabled: true,
      window:  60,  // 60 секунд
      max:     10,  // не более 10 запросов к /api/auth/* за окно
      customRules: {
        '/sign-in/email':   { window: 60, max: 5 },
        '/sign-up/email':   { window: 60, max: 3 },
        '/forget-password': { window: 60, max: 3 },
      },
    },
    emailVerification: {
      sendVerificationEmail: async function ({ user, url }) {
        var frontendUrl = url.replace('https://api.questtick.com/api/auth/verify-email', 'https://questtick.com/verify-email');
        await resend.emails.send({
          from: 'Questtick <noreply@questtick.com>',
          to: user.email,
          subject: 'Подтвердите email — Questtick',
          html: '<p>Нажмите кнопку ниже, чтобы подтвердить email и войти в Questtick.</p><p><a href="' + frontendUrl + '" style="display:inline-block;padding:12px 24px;background:#024ad8;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;">Подтвердить email</a></p><p style="color:#888;font-size:12px;">Если вы не регистрировались — просто проигнорируйте это письмо.</p>',
        });
      },
      autoSignInAfterVerification: true,
    },
    secret:  process.env.BETTER_AUTH_SECRET,
    baseURL: process.env.BETTER_AUTH_URL || 'https://api.questtick.com',
    trustedOrigins: [
      'https://questtick.com',
      'https://www.questtick.com',
      'http://localhost:5173',
    ],
    advanced: {
      crossSubDomainCookies: {
        enabled: true,
        domain: 'questtick.com',
      },
    },
  });
  return _auth;
}

module.exports = { getAuth };
