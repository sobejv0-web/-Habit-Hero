#!/usr/bin/env node
/*
 * SQLite sanity checks for analytics_events.
 * Usage:
 *   DB_PATH=/var/www/habit-system/data/habit.db node scripts/analytics_sanity.js
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
require('dotenv').config();

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'habit.db');

if (!fs.existsSync(dbPath)) {
  console.error(`DB file not found: ${dbPath}`);
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true });

const queries = {
  recentCreatedAt: `
    SELECT created_at
    FROM analytics_events
    ORDER BY id DESC
    LIMIT 5;
  `,
  counts24h: `
    SELECT event, COUNT(*) AS cnt
    FROM analytics_events
    WHERE datetime(created_at) >= datetime('now', '-24 hours')
    GROUP BY event
    ORDER BY cnt DESC;
  `,
  topUsers24h: `
    SELECT user_id, COUNT(*) AS cnt
    FROM analytics_events
    WHERE datetime(created_at) >= datetime('now', '-24 hours')
    GROUP BY user_id
    ORDER BY cnt DESC
    LIMIT 20;
  `,
  rapidDupes24h: `
    WITH x AS (
      SELECT
        user_id,
        event,
        created_at,
        LAG(created_at) OVER (
          PARTITION BY user_id, event
          ORDER BY datetime(created_at)
        ) AS prev_at
      FROM analytics_events
      WHERE datetime(created_at) >= datetime('now', '-24 hours')
    )
    SELECT event, COUNT(*) AS rapid_dupes
    FROM x
    WHERE prev_at IS NOT NULL
      AND (strftime('%s', created_at) - strftime('%s', prev_at)) <= 2
    GROUP BY event
    ORDER BY rapid_dupes DESC;
  `,
  appOpenedMultiPerDay14d: `
    SELECT user_id, date(created_at) AS day, COUNT(*) AS cnt
    FROM analytics_events
    WHERE event = 'app_opened'
      AND date(created_at) >= date('now', '-14 days')
    GROUP BY user_id, day
    HAVING COUNT(*) > 1
    ORDER BY cnt DESC
    LIMIT 50;
  `,
  appOpenedOffenders14d: `
    WITH offenders AS (
      SELECT user_id, date(created_at) AS day, COUNT(*) AS cnt
      FROM analytics_events
      WHERE event = 'app_opened'
        AND date(created_at) >= date('now', '-14 days')
      GROUP BY user_id, day
      HAVING COUNT(*) > 1
    )
    SELECT COUNT(DISTINCT user_id) AS users, COUNT(*) AS user_days
    FROM offenders;
  `,
  trialFunnel30d: `
    SELECT event, COUNT(DISTINCT user_id) AS users
    FROM analytics_events
    WHERE event IN (
      'trial_started',
      'trial_day5_seen',
      'trial_expired_seen',
      'premium_interest_clicked'
    )
      AND date(created_at) >= date('now', '-30 days')
    GROUP BY event
    ORDER BY users DESC;
  `,
  trialInterestRate30d: `
    WITH s AS (
      SELECT DISTINCT user_id
      FROM analytics_events
      WHERE event = 'trial_started'
        AND date(created_at) >= date('now', '-30 days')
    ),
    p AS (
      SELECT DISTINCT user_id
      FROM analytics_events
      WHERE event = 'premium_interest_clicked'
        AND date(created_at) >= date('now', '-30 days')
    )
    SELECT
      (SELECT COUNT(*) FROM s) AS trial_started_users,
      (SELECT COUNT(*) FROM p) AS premium_interest_users,
      ROUND(
        (SELECT COUNT(*) FROM p) * 1.0 / NULLIF((SELECT COUNT(*) FROM s), 0),
        4
      ) AS interest_rate;
  `,
  schedulerSnapshots14d: `
    SELECT date(created_at) AS day, event, COUNT(*) AS cnt
    FROM analytics_events
    WHERE event IN (
      'daily_active_user',
      'trial_active_user',
      'premium_active_user'
    )
      AND date(created_at) >= date('now', '-14 days')
    GROUP BY day, event
    ORDER BY day DESC, event;
  `,
  recentEvents50: `
    SELECT id, created_at, user_id, event, meta
    FROM analytics_events
    ORDER BY id DESC
    LIMIT 50;
  `,
  schedulerSnapshotsYesterday: `
    SELECT COUNT(*) AS cnt
    FROM analytics_events
    WHERE event IN (
      'daily_active_user',
      'trial_active_user',
      'premium_active_user'
    )
      AND date(created_at) = date('now', '-1 day');
  `,
};

function printTable(title, rows) {
  console.log(`\n=== ${title} ===`);
  if (!rows.length) {
    console.log('(empty)');
    return;
  }
  console.table(rows);
}

try {
  const criticalDupeEvents = new Set([
    'trial_started',
    'trial_day5_seen',
    'trial_expired_seen',
    'premium_interest_clicked',
    'daily_active_user',
    'trial_active_user',
    'premium_active_user',
  ]);
  let rapidDupesCritical = 0;
  let schedulerYesterdayCount = null;

  for (const [key, sql] of Object.entries(queries)) {
    const rows = db.prepare(sql).all();
    printTable(key, rows);
    if (key === 'rapidDupes24h') {
      rapidDupesCritical = rows
        .filter((row) => criticalDupeEvents.has(row.event))
        .reduce((sum, row) => sum + Number(row.rapid_dupes || 0), 0);
    }
    if (key === 'schedulerSnapshotsYesterday' && rows[0]) {
      schedulerYesterdayCount = Number(rows[0].cnt || 0);
    }
  }

  if (rapidDupesCritical > 0) {
    console.error(`\n[FAIL] rapid duplicates <=2s for critical events: ${rapidDupesCritical}`);
    process.exit(2);
  }

  if (schedulerYesterdayCount === 0) {
    console.error('\n[FAIL] scheduler snapshots missing for yesterday');
    process.exit(3);
  }
} finally {
  db.close();
}
