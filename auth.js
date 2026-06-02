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
    },
    emailVerification: {
      sendVerificationEmail: async function ({ user, url }) {
        await resend.emails.send({
          from: 'Questtick <noreply@questtick.com>',
          to: user.email,
          subject: 'Подтвердите email — Questtick',
          html: '<p>Нажмите кнопку ниже, чтобы подтвердить email и войти в Questtick.</p><p><a href="' + url + '" style="display:inline-block;padding:12px 24px;background:#024ad8;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;">Подтвердить email</a></p><p style="color:#888;font-size:12px;">Если вы не регистрировались — просто проигнорируйте это письмо.</p>',
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
