const { betterAuth } = require('better-auth');
const { drizzleAdapter } = require('better-auth/adapters/drizzle');
const { getDb } = require('./db/index');
const schema = require('./db/schema');

var _auth = null;

function getAuth() {
  if (_auth) return _auth;
  var { drizzle } = getDb();
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
    emailAndPassword: { enabled: true },
    secret:  process.env.BETTER_AUTH_SECRET,
    baseURL: process.env.BETTER_AUTH_URL || 'https://api.questtick.com',
    trustedOrigins: [
      'https://questtick.com',
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
