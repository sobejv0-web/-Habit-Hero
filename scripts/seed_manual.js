const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function formatDateUtc(date) {
  return date.toISOString().slice(0, 10);
}

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'habit.db');
ensureDir(dbPath);

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

// Minimal schema to ensure inserts work even if migrations haven't run yet.
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER UNIQUE NOT NULL,
    timezone TEXT DEFAULT 'Europe/Prague',
    reminder_time TEXT DEFAULT '20:00',
    plan TEXT DEFAULT 'free',
    trial_until TEXT,
    referred_by_user_id INTEGER,
    last_reminded_date TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS habits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS checkins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    habit_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('done', 'skip')),
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (habit_id) REFERENCES habits(id) ON DELETE CASCADE
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_checkins_unique
    ON checkins (user_id, habit_id, date);
`);

const createdAt = new Date().toISOString();

let user = db.prepare('SELECT id FROM users ORDER BY id DESC LIMIT 1').get();
if (!user) {
  const dummyTelegramId = 999999999;
  const result = db
    .prepare('INSERT INTO users (telegram_id, created_at) VALUES (?, ?)')
    .run(dummyTelegramId, createdAt);
  user = { id: result.lastInsertRowid };
}

const maxOrder = db
  .prepare('SELECT MAX(sort_order) AS max FROM habits WHERE user_id = ?')
  .get(user.id).max || 0;

const habitResult = db
  .prepare(
    'INSERT INTO habits (user_id, title, sort_order, active, created_at) VALUES (?, ?, ?, ?, ?)'
  )
  .run(user.id, 'Test Habit 🚀', maxOrder + 1, 1, createdAt);

const habitId = habitResult.lastInsertRowid;

const insertCheckin = db.prepare(
  'INSERT OR IGNORE INTO checkins (user_id, habit_id, date, status, created_at) VALUES (?, ?, ?, ?, ?)'
);

for (let i = 0; i < 5; i += 1) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - i);
  const dateStr = formatDateUtc(d);
  insertCheckin.run(user.id, habitId, dateStr, 'done', createdAt);
}

db.close();
console.log('Database Seeded Successfully');
