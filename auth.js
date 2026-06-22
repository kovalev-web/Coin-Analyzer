const { betterAuth } = require('better-auth');
const { drizzleAdapter } = require('better-auth/adapters/drizzle');
const { getDb } = require('./db/index');
const schema = require('./db/schema');
const { Resend } = require('resend');

var _auth = null;

// Temporary registration freeze while the product is in development — flip
// to true (and the matching REGISTRATION_OPEN flag in src/login.js) to reopen
// sign-ups. Existing users are unaffected: disableSignUp only blocks the
// "no account found yet" branch, sign-in for already-registered users (email
// or Google) keeps working either way.
var REGISTRATION_OPEN = false;

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
      disableSignUp: !REGISTRATION_OPEN,
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
    socialProviders: {
      google: {
        clientId:     process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        disableSignUp: !REGISTRATION_OPEN,
      },
    },
    session: {
      expiresIn:  60 * 60 * 24 * 30, // 30 дней
      updateAge:  60 * 60 * 24,       // обновлять сессию раз в сутки
      freshAge:   0,                  // не требовать «свежую» сессию для чувствительных операций
    },
    rateLimit: {
      enabled: true,
      window:  60,
      max:     10,
      customRules: {
        '/get-session':            { window: 60, max: 120 },
        '/sign-in/email':          { window: 60, max: 5 },
        '/sign-up/email':          { window: 60, max: 3 },
        '/request-password-reset': { window: 60, max: 3 },
        '/change-email':           { window: 60, max: 3 },
      },
    },
    user: {
      deleteUser: {
        enabled: true,
        // journal_entries.user_id has no ON DELETE CASCADE, and foreign_keys
        // is ON (db/index.js) — without this, deleting a user who has ever
        // filled in a journal entry fails on the FK constraint when better-auth
        // tries to delete the user row.
        beforeDelete: async function (user) {
          try { getDb().sqlite.prepare('DELETE FROM journal_entries WHERE user_id = ?').run(user.id); } catch (e) {}
        },
        afterDelete: async function (user) {
          try {
            var REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
            var REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
            if (!REDIS_URL || !REDIS_TOKEN) return;
            var uid = user.id;
            function redisCall(args) {
              return fetch(REDIS_URL, {
                method: 'POST',
                headers: { 'Authorization': 'Bearer ' + REDIS_TOKEN, 'Content-Type': 'application/json' },
                body: JSON.stringify(args),
              }).then(function (r) { return r.json(); }).catch(function () { return null; });
            }
            var keys = ['levels', 'rays', 'alerts', 'briefing', 'briefing_ai', 'briefing_tz',
                        'tg_chat', 'binance_keys', 'avatar', 'account_tz', 'account_trading_limits',
                        'notifications'].map(function (k) { return k + ':' + uid; });
            // journal_ai is cached per range, not a single key
            ['1w', '2w', '1m'].forEach(function (range) { keys.push('journal_ai:' + uid + ':' + range); });
            // tg_user is reverse-keyed by chatId, not userId — read tg_chat first to find it
            var tgChatRes = await redisCall(['GET', 'tg_chat:' + uid]);
            if (tgChatRes && tgChatRes.result) keys.push('tg_user:' + tgChatRes.result);
            await Promise.all(keys.map(function (k) { return redisCall(['DEL', k]); }));
          } catch (e) {}
        },
      },
      changeEmail: {
        enabled: true,
        sendChangeEmailConfirmation: async function ({ user, newEmail, url }) {
          var frontendUrl = url.replace('https://api.questtick.com/api/auth/verify-email', 'https://questtick.com/verify-email');
          await resend.emails.send({
            from: 'Questtick <noreply@questtick.com>',
            to: user.email,
            subject: 'Подтверждение смены email — Questtick',
            html: '<p>Вы запросили смену email на <b>' + newEmail + '</b>.</p>'
                + '<p><a href="' + frontendUrl + '" style="display:inline-block;padding:12px 24px;background:#024ad8;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;">Подтвердить смену</a></p>'
                + '<p style="color:#888;font-size:12px;">Если вы не делали этого запроса — проигнорируйте письмо.</p>',
          });
        },
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
