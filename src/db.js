const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function runMigrations(db) {
  try {
    db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id INTEGER UNIQUE NOT NULL,
      timezone TEXT DEFAULT 'Europe/Prague',
      reminder_time TEXT DEFAULT '20:00',
      plan TEXT DEFAULT 'free',
      trial_until TEXT,
      is_premium INTEGER DEFAULT 0,
      subscription_end_date TEXT,
      referred_by_user_id INTEGER,
      partner_id INTEGER,
      last_reminded_date TEXT,
      xp INTEGER DEFAULT 0,
      level INTEGER DEFAULT 1,
      hero_coins INTEGER DEFAULT 0,
      streak_shield_count INTEGER DEFAULT 0,
      streak_shield_last_used TEXT,
      active_theme TEXT DEFAULT 'default',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS monitors (
      user_id INTEGER NOT NULL UNIQUE,
      monitor_telegram_id INTEGER NOT NULL,
      monitor_username TEXT,
      monitor_name TEXT,
      enabled INTEGER DEFAULT 1,
      last_notified_date TEXT,
      last_kick_date TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS habits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      icon TEXT,
      color TEXT,
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

    CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      utm_source TEXT,
      utm_medium TEXT,
      utm_campaign TEXT,
      utm_content TEXT,
      utm_term TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS lazy_undo_tokens (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      payload TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS referral_tokens (
      token TEXT PRIMARY KEY,
      inviter_user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      used_by_user_id INTEGER,
      used_at TEXT,
      FOREIGN KEY (inviter_user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (used_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS analytics_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      event TEXT NOT NULL,
      meta TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS user_badges (
      user_id INTEGER NOT NULL,
      badge TEXT NOT NULL,
      awarded_at TEXT NOT NULL,
      PRIMARY KEY (user_id, badge),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS duels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      challenger_id INTEGER NOT NULL,
      opponent_id INTEGER NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      winner_id INTEGER,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      FOREIGN KEY (challenger_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (opponent_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (winner_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS guilds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      owner_user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS guild_members (
      guild_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      joined_at TEXT NOT NULL,
      PRIMARY KEY (guild_id, user_id),
      FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_checkins_unique
      ON checkins (user_id, habit_id, date);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_telegram_id
      ON users (telegram_id);

    CREATE INDEX IF NOT EXISTS idx_habits_user_id
      ON habits (user_id);

    CREATE INDEX IF NOT EXISTS idx_lazy_undo_expires
      ON lazy_undo_tokens (expires_at);

    CREATE INDEX IF NOT EXISTS idx_referral_inviter
      ON referral_tokens (inviter_user_id);

    CREATE INDEX IF NOT EXISTS idx_analytics_event
      ON analytics_events (user_id, event, created_at);

    CREATE INDEX IF NOT EXISTS idx_duels_status
      ON duels (status, end_date);

    CREATE INDEX IF NOT EXISTS idx_guild_members_user
      ON guild_members (user_id);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_guild_members_user_unique
      ON guild_members (user_id);
  `);
  } catch (error) {
    console.error('[db] Migration bootstrap failed:', error?.message || error);
  }

  ensureColumn(db, 'users', 'telegram_id', 'INTEGER');
  ensureColumn(db, 'users', 'timezone', "TEXT DEFAULT 'Europe/Prague'");
  ensureColumn(db, 'users', 'reminder_time', "TEXT DEFAULT '20:00'");
  ensureColumn(db, 'users', 'plan', "TEXT DEFAULT 'free'");
  ensureColumn(db, 'users', 'trial_until', 'TEXT');
  ensureColumn(db, 'users', 'is_premium', 'INTEGER DEFAULT 0');
  ensureColumn(db, 'users', 'subscription_end_date', 'TEXT');
  ensureColumn(db, 'users', 'referred_by_user_id', 'INTEGER');
  ensureColumn(db, 'users', 'partner_id', 'INTEGER');
  ensureColumn(db, 'users', 'last_reminded_date', 'TEXT');
  ensureColumn(db, 'users', 'xp', 'INTEGER DEFAULT 0');
  ensureColumn(db, 'users', 'level', 'INTEGER DEFAULT 1');
  ensureColumn(db, 'users', 'hero_coins', 'INTEGER DEFAULT 0');
  ensureColumn(db, 'users', 'streak_shield_count', 'INTEGER DEFAULT 0');
  ensureColumn(db, 'users', 'streak_shield_last_used', 'TEXT');
  ensureColumn(db, 'users', 'active_theme', "TEXT DEFAULT 'default'");
  ensureColumn(db, 'users', 'social_shame', 'INTEGER DEFAULT 0');
  ensureColumn(db, 'users', 'vacation_mode', 'INTEGER DEFAULT 0');
  ensureColumn(db, 'users', 'language_code', 'TEXT');
  ensureColumn(db, 'users', 'social_shame_partner_username', 'TEXT');
  ensureColumn(db, 'users', 'referral_bonus_pending', 'INTEGER DEFAULT 0');

  ensureColumn(db, 'monitors', 'enabled', 'INTEGER DEFAULT 1');
  ensureColumn(db, 'monitors', 'last_notified_date', 'TEXT');
  ensureColumn(db, 'monitors', 'last_kick_date', 'TEXT');
  ensureColumn(db, 'monitors', 'monitor_username', 'TEXT');
  ensureColumn(db, 'monitors', 'monitor_name', 'TEXT');
  ensureColumn(db, 'habits', 'user_id', 'INTEGER');
  ensureColumn(db, 'habits', 'icon', 'TEXT');
  ensureColumn(db, 'habits', 'color', 'TEXT');
  ensureColumn(db, 'checkins', 'user_id', 'INTEGER');

  try {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_checkins_unique
        ON checkins (user_id, habit_id, date);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_telegram_id
        ON users (telegram_id);

      CREATE INDEX IF NOT EXISTS idx_habits_user_id
        ON habits (user_id);

      CREATE INDEX IF NOT EXISTS idx_lazy_undo_expires
        ON lazy_undo_tokens (expires_at);

      CREATE INDEX IF NOT EXISTS idx_referral_inviter
        ON referral_tokens (inviter_user_id);

      CREATE INDEX IF NOT EXISTS idx_analytics_event
        ON analytics_events (user_id, event, created_at);

      CREATE INDEX IF NOT EXISTS idx_duels_status
        ON duels (status, end_date);

      CREATE INDEX IF NOT EXISTS idx_guild_members_user
        ON guild_members (user_id);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_guild_members_user_unique
        ON guild_members (user_id);
    `);
  } catch (error) {
    console.error('[db] Migration index bootstrap failed:', error?.message || error);
  }

  db.exec(`
    UPDATE users SET timezone = 'Europe/Prague'
    WHERE timezone IS NULL OR timezone = '';
  `);

  db.exec(`
    UPDATE users SET reminder_time = '20:00'
    WHERE reminder_time IS NULL OR reminder_time = '';
  `);

  db.exec(`
    UPDATE users SET plan = 'free'
    WHERE plan IS NULL OR plan = '';
  `);

  db.exec(`
    UPDATE users SET is_premium = 0
    WHERE is_premium IS NULL;
  `);

  db.exec(`
    UPDATE monitors SET enabled = 1
    WHERE enabled IS NULL;
  `);

  db.exec(`
    UPDATE users SET social_shame = 0
    WHERE social_shame IS NULL;
  `);

  db.exec(`
    UPDATE users SET vacation_mode = 0
    WHERE vacation_mode IS NULL;
  `);

  db.exec(`
    UPDATE users SET referral_bonus_pending = 0
    WHERE referral_bonus_pending IS NULL;
  `);

  db.exec(`
    UPDATE users SET hero_coins = 0
    WHERE hero_coins IS NULL;
  `);

  db.exec(`
    UPDATE users SET streak_shield_count = 0
    WHERE streak_shield_count IS NULL;
  `);

  db.exec(`
    UPDATE users SET active_theme = 'default'
    WHERE active_theme IS NULL OR active_theme = '';
  `);

  db.exec(`
    UPDATE users SET language_code = 'en'
    WHERE language_code IS NULL OR language_code = '';
  `);

  db.exec(`
    DELETE FROM habits
    WHERE LOWER(title) IN ('groud', 'я блок', 'я-блок');
  `);
}

function initDb(dbPath) {
  const filename = dbPath || path.join(__dirname, '..', 'data', 'habit.db');
  ensureDir(filename);

  const db = new Database(filename);
  db.pragma('journal_mode = WAL');
  runMigrations(db);

  return db;
}

function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  const exists = columns.some((item) => item.name === column);
  if (!exists) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

module.exports = {
  initDb,
};
