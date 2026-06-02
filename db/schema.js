const { sqliteTable, text, integer, real } = require('drizzle-orm/sqlite-core');

// ── Better Auth tables ─────────────────────────────────────────────────────

exports.user = sqliteTable('user', {
  id:            text('id').primaryKey(),
  name:          text('name').notNull(),
  email:         text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  image:         text('image'),
  createdAt:     integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt:     integer('updated_at', { mode: 'timestamp' }).notNull(),
});

exports.session = sqliteTable('session', {
  id:          text('id').primaryKey(),
  expiresAt:   integer('expires_at', { mode: 'timestamp' }).notNull(),
  token:       text('token').notNull().unique(),
  createdAt:   integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt:   integer('updated_at', { mode: 'timestamp' }).notNull(),
  ipAddress:   text('ip_address'),
  userAgent:   text('user_agent'),
  userId:      text('user_id').notNull().references(() => exports.user.id),
});

exports.account = sqliteTable('account', {
  id:                     text('id').primaryKey(),
  accountId:              text('account_id').notNull(),
  providerId:             text('provider_id').notNull(),
  userId:                 text('user_id').notNull().references(() => exports.user.id),
  accessToken:            text('access_token'),
  refreshToken:           text('refresh_token'),
  idToken:                text('id_token'),
  accessTokenExpiresAt:   integer('access_token_expires_at', { mode: 'timestamp' }),
  refreshTokenExpiresAt:  integer('refresh_token_expires_at', { mode: 'timestamp' }),
  scope:                  text('scope'),
  password:               text('password'),
  createdAt:              integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt:              integer('updated_at', { mode: 'timestamp' }).notNull(),
});

exports.verification = sqliteTable('verification', {
  id:         text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value:      text('value').notNull(),
  expiresAt:  integer('expires_at', { mode: 'timestamp' }).notNull(),
  createdAt:  integer('created_at', { mode: 'timestamp' }),
  updatedAt:  integer('updated_at', { mode: 'timestamp' }),
});

// ── Legacy tables (unused — kept for reference) ────────────────────────────


exports.users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

exports.subscriptions = sqliteTable('subscriptions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull().references(() => exports.users.id),
  symbol: text('symbol').notNull(),
  minChange: real('min_change'),
  minVolume: real('min_volume'),
  signalType: text('signal_type'), // 'bullish' | 'caution' | null
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at').notNull(),
});

exports.notifications = sqliteTable('notifications', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull().references(() => exports.users.id),
  subscriptionId: integer('subscription_id').references(() => exports.subscriptions.id),
  symbol: text('symbol').notNull(),
  type: text('type').notNull(), // 'pump' | 'signal' | 'price_alert'
  message: text('message').notNull(),
  data: text('data'), // JSON blob
  read: integer('read', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at').notNull(),
});

exports.sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => exports.users.id),
  expiresAt: integer('expires_at').notNull(),
  createdAt: integer('created_at').notNull(),
});
