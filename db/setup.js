// Creates Better Auth tables if they don't exist yet.
// Called once at server startup before any request handling.

const { getDb } = require('./index');

function ensureAuthTables() {
  const { sqlite } = getDb();
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS "user" (
      id           TEXT PRIMARY KEY NOT NULL,
      name         TEXT NOT NULL,
      email        TEXT NOT NULL UNIQUE,
      email_verified INTEGER NOT NULL DEFAULT 0,
      image        TEXT,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS "session" (
      id         TEXT PRIMARY KEY NOT NULL,
      expires_at INTEGER NOT NULL,
      token      TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      ip_address TEXT,
      user_agent TEXT,
      user_id    TEXT NOT NULL REFERENCES "user"(id)
    );
    CREATE TABLE IF NOT EXISTS "account" (
      id                       TEXT PRIMARY KEY NOT NULL,
      account_id               TEXT NOT NULL,
      provider_id              TEXT NOT NULL,
      user_id                  TEXT NOT NULL REFERENCES "user"(id),
      access_token             TEXT,
      refresh_token            TEXT,
      id_token                 TEXT,
      access_token_expires_at  INTEGER,
      refresh_token_expires_at INTEGER,
      scope                    TEXT,
      password                 TEXT,
      created_at               INTEGER NOT NULL,
      updated_at               INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS "verification" (
      id         TEXT PRIMARY KEY NOT NULL,
      identifier TEXT NOT NULL,
      value      TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER,
      updated_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS "journal_entries" (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id          TEXT NOT NULL REFERENCES "user"(id),
      date             TEXT NOT NULL,
      morning_state    TEXT,
      volume           TEXT,
      stop_level       TEXT,
      day_plan         TEXT,
      planned_coins    TEXT,
      trigger_watch    TEXT,
      channels_closed  TEXT,
      morning_at       INTEGER,
      followed_process TEXT,
      traded_planned   TEXT,
      trade_count      INTEGER,
      stop_crane_kept  TEXT,
      volume_ok        TEXT,
      trigger_fired    TEXT,
      trigger_revenge  INTEGER,
      trigger_size_up  INTEGER,
      trigger_fomo     INTEGER,
      trigger_other    TEXT,
      trigger_fomo_other INTEGER,
      trigger_add_funds  INTEGER,
      trigger_replan     INTEGER,
      missed_screening   TEXT,
      pnl              REAL,
      evening_state    TEXT,
      felt_worthless   TEXT,
      free_conclusion  TEXT,
      evening_at       INTEGER,
      UNIQUE(user_id, date)
    );
  `);

  // Idempotent migration: add columns introduced after the initial table creation
  // for installs whose journal_entries table predates them.
  var journalCols = sqlite.prepare('PRAGMA table_info(journal_entries)').all().map(function (c) { return c.name; });
  ['stop_level', 'planned_coins', 'trigger_watch', 'trigger_other'].forEach(function (col) {
    if (journalCols.indexOf(col) === -1) {
      sqlite.exec('ALTER TABLE "journal_entries" ADD COLUMN "' + col + '" TEXT');
    }
  });
  ['channels_closed', 'missed_screening'].forEach(function (col) {
    if (journalCols.indexOf(col) === -1) {
      sqlite.exec('ALTER TABLE "journal_entries" ADD COLUMN "' + col + '" TEXT');
    }
  });
  ['trigger_fomo_other', 'trigger_add_funds', 'trigger_replan', 'trigger_revenge', 'trigger_size_up', 'trigger_fomo'].forEach(function (col) {
    if (journalCols.indexOf(col) === -1) {
      sqlite.exec('ALTER TABLE "journal_entries" ADD COLUMN "' + col + '" INTEGER');
    }
  });
  if (journalCols.indexOf('pnl') === -1) {
    sqlite.exec('ALTER TABLE "journal_entries" ADD COLUMN "pnl" REAL');
  }
}

module.exports = { ensureAuthTables };
