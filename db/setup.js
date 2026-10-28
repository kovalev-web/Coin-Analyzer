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
      max_trades       INTEGER,
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
      skipped          INTEGER,
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
  ['trigger_fomo_other', 'trigger_fomo_active', 'trigger_add_funds', 'trigger_replan', 'trigger_revenge', 'trigger_size_up', 'trigger_fomo'].forEach(function (col) {
    if (journalCols.indexOf(col) === -1) {
      sqlite.exec('ALTER TABLE "journal_entries" ADD COLUMN "' + col + '" INTEGER');
    }
  });
  if (journalCols.indexOf('pnl') === -1) {
    sqlite.exec('ALTER TABLE "journal_entries" ADD COLUMN "pnl" REAL');
  }
  if (journalCols.indexOf('skipped') === -1) {
    sqlite.exec('ALTER TABLE "journal_entries" ADD COLUMN "skipped" INTEGER');
  }
  // Day facts computed from fills at evening review (journal/facts.js)
  if (journalCols.indexOf('facts_json') === -1) {
    sqlite.exec('ALTER TABLE "journal_entries" ADD COLUMN "facts_json" TEXT');
  }
  // Journal v2 (docs/TRADER_EDGE.md): morning state split into scales + if-then
  // intention; evening asks only what the data can't know.
  [['sleep_hours', 'REAL'], ['sleep_quality', 'INTEGER'], ['energy', 'INTEGER'], ['carryover', 'INTEGER'], ['focus', 'INTEGER'],
   ['if_then', 'TEXT'], ['did_well', 'TEXT'], ['fix_tomorrow', 'TEXT'], ['why_breaks', 'TEXT'], ['self_talk', 'TEXT']].forEach(function (c) {
    if (journalCols.indexOf(c[0]) === -1) sqlite.exec('ALTER TABLE "journal_entries" ADD COLUMN "' + c[0] + '" ' + c[1]);
  });
  // One tag per closed trade, tapped right after it closes (setup quality + what drove it)
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS "trade_tags" (
      "user_id" TEXT NOT NULL,
      "symbol" TEXT NOT NULL,
      "close_time" INTEGER NOT NULL,
      "setup" TEXT,
      "emotion" TEXT,
      "created_at" INTEGER NOT NULL,
      PRIMARY KEY ("user_id", "symbol", "close_time")
    )
  `);
  // Notes on a coin while watching it: many per coin, each with the time and
  // price it was written at, shown on the chart and in the briefing
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS "coin_notes" (
      "id" INTEGER PRIMARY KEY AUTOINCREMENT,
      "user_id" TEXT NOT NULL,
      "symbol" TEXT NOT NULL,
      "ts" INTEGER NOT NULL,
      "price" REAL,
      "text" TEXT NOT NULL,
      "created_at" INTEGER NOT NULL
    )
  `);
  sqlite.exec('CREATE INDEX IF NOT EXISTS "coin_notes_user_symbol_ts" ON "coin_notes" ("user_id", "symbol", "ts")');
  // Your own setup list (names you type and rename). trade_tags.pattern holds a setup's key;
  // `exclude` = not counted in My edge (misclicks, tests), `archived` = hidden from the buttons
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS "user_setups" (
      "user_id" TEXT NOT NULL,
      "key" TEXT NOT NULL,
      "name" TEXT NOT NULL,
      "position" INTEGER NOT NULL DEFAULT 0,
      "exclude" INTEGER NOT NULL DEFAULT 0,
      "archived" INTEGER NOT NULL DEFAULT 0,
      "created_at" INTEGER NOT NULL,
      PRIMARY KEY ("user_id", "key")
    )
  `);
  // Levels drawn on a trade's review chart in the journal — kept per trade, never on the live chart
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS "review_levels" (
      "user_id" TEXT NOT NULL,
      "symbol" TEXT NOT NULL,
      "close_time" INTEGER NOT NULL,
      "prices" TEXT NOT NULL,
      "updated_at" INTEGER NOT NULL,
      PRIMARY KEY ("user_id", "symbol", "close_time")
    )
  `);
  // One-off data migrations, applied once and recorded
  sqlite.exec('CREATE TABLE IF NOT EXISTS "migrations" ("name" TEXT PRIMARY KEY, "applied_at" INTEGER NOT NULL)');
  function once(name, fn) {
    if (sqlite.prepare('SELECT 1 FROM migrations WHERE name = ?').get(name)) return;
    fn();
    sqlite.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run(name, Date.now());
  }
  // Setup type of a closed trade (what kind of entry it was); `setup` stays the A/B/C quality
  var tagCols = sqlite.prepare('PRAGMA table_info("trade_tags")').all().map(function (c) { return c.name; });
  if (tagCols.indexOf('pattern') === -1) sqlite.exec('ALTER TABLE "trade_tags" ADD COLUMN "pattern" TEXT');
  // 2026-10-27: the setup list starts over with the six diagrammed setups
  // (server-vps.js DEFAULT_SETUPS): old setups are removed and trades unlinked
  // from them (A/B/C quality and emotion tags stay)
  once('setups_v2_reset', function () {
    sqlite.exec('DELETE FROM user_setups');
    sqlite.exec('UPDATE trade_tags SET pattern = NULL');
  });
  if (journalCols.indexOf('max_trades') === -1) {
    sqlite.exec('ALTER TABLE "journal_entries" ADD COLUMN "max_trades" INTEGER');
  }
}

module.exports = { ensureAuthTables };
