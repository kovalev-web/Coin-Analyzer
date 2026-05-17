const Database = require('better-sqlite3');
const { drizzle } = require('drizzle-orm/better-sqlite3');
const schema = require('./schema');
const path = require('path');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'pump-analyzer.db');

let db;
let drizzleDb;

function getDb() {
  if (!db) {
    const fs = require('fs');
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    drizzleDb = drizzle(db, { schema });
  }
  return { sqlite: db, drizzle: drizzleDb, schema };
}

function closeDb() {
  if (db) { db.close(); db = null; drizzleDb = null; }
}

module.exports = { getDb, closeDb };
