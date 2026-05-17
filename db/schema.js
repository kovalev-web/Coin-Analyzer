const { sqliteTable, text, integer, real } = require('drizzle-orm/sqlite-core');

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
