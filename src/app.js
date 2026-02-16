const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const { calculateCurrentStreak } = require('./services/streak');
const texts = require('./texts');

dayjs.extend(utc);
dayjs.extend(timezone);

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TIME_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DEFAULT_PLAN = process.env.DEFAULT_PLAN || 'free';
const PLAN_OVERRIDE = process.env.PLAN_OVERRIDE;
const ANALYTICS_ENABLED = process.env.ANALYTICS_ENABLED !== 'false';
const ALLOW_DEBUG_AUTH =
  process.env.DEBUG_AUTH === 'true' || process.env.NODE_ENV !== 'production';
const DEFAULT_TIMEZONE = 'Europe/Prague';
const SHARE_DIR = path.join(__dirname, '..', 'public', 'shares');
const TEMP_SHARE_DIR = path.join(__dirname, '..', 'public', 'temp_shares');
const SHARE_PUBLIC_PATH = '/public/shares';
const TEMP_SHARE_PUBLIC_PATH = '/public/temp_shares';

const ANALYTICS_EVENTS = new Set([
  'trial_started',
  'trial_day5_seen',
  'premium_interest_clicked',
  'trial_expired_seen',
  'premium_retained_after_trial',
  'heatmap_opened',
  'routine_started',
  'routine_completed',
  'focus_mode_used',
  'accountability_kick_sent',
  'lazy_entry_used',
  'day_completed',
  'perfect_day',
  'app_opened',
  'daily_active_user',
  'trial_active_user',
  'premium_active_user',
]);

const DEFAULT_HABIT_ICON = '🚀';
const DEFAULT_HABIT_COLOR = '#3D8BFF';
const FREE_HABIT_LIMIT = 3;
const HABIT_COLOR_PRESETS = [
  '#3D8BFF', // Electric Blue
  '#36C98F', // Emerald
  '#FF8C5A', // Sunset Orange
  '#7B61FF', // Royal Purple
  '#FF5DA2', // Rose
  '#F0C571', // Gold
];
const HABIT_COLOR_NAMES = {
  blue: '#3D8BFF',
  emerald: '#36C98F',
  sunset: '#FF8C5A',
  purple: '#7B61FF',
  rose: '#FF5DA2',
  gold: '#F0C571',
};
const HABIT_ICON_PRESETS = ['🚀', '💧', '📚', '🧘', '🏃', '🍎', '🧠', '💎'];
const DEFAULT_HABITS = [
  { title: 'Water', sort: 1, icon: '💧', color: '#3D8BFF' },
  { title: 'Read', sort: 2, icon: '📚', color: '#7B61FF' },
  { title: 'Walk', sort: 3, icon: '🏃', color: '#36C98F' },
];
const XP_PER_CHECKIN = 10;
const HERO_COINS_PER_100_XP = 10;
const STREAK_SHIELD_COST = 50;
const DUEL_DURATION_DAYS = 7;
const THEMES = new Set(['default', 'cyberpunk', 'minimalist', 'forest']);


// Telegram initData freshness window (MVP):
// 6 hours is a good balance for security vs usability.
const MAX_AUTH_AGE_SECONDS = 6 * 60 * 60;

function normalizeHabitIcon(value) {
  if (typeof value !== 'string') return DEFAULT_HABIT_ICON;
  const trimmed = value.trim();
  if (!trimmed) return DEFAULT_HABIT_ICON;
  if (trimmed.length > 12) return DEFAULT_HABIT_ICON;
  return trimmed;
}

function normalizeHabitColor(value) {
  if (typeof value !== 'string') return DEFAULT_HABIT_COLOR;
  const trimmed = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toUpperCase();
  const named = HABIT_COLOR_NAMES[trimmed.toLowerCase()];
  if (named) return named;
  if (HABIT_COLOR_PRESETS.includes(trimmed)) return trimmed;
  return DEFAULT_HABIT_COLOR;
}

function resolveHabitVisuals(rawIcon, rawColor) {
  return {
    icon: normalizeHabitIcon(rawIcon),
    color: normalizeHabitColor(rawColor),
  };
}

function calculateLevel(totalXp) {
  const xp = Number(totalXp) || 0;
  return Math.floor(xp / 100) + 1;
}

function calculateHeroCoinsDelta(beforeXp, xpDelta) {
  const start = Math.floor((Number(beforeXp) || 0) / 100) * HERO_COINS_PER_100_XP;
  const end = Math.floor((Number(beforeXp) + Number(xpDelta || 0)) / 100) * HERO_COINS_PER_100_XP;
  return Math.max(0, end - start);
}

function awardXpAndCoins({ statements, userId, xpDelta }) {
  const before = statements.getUserById.get(userId);
  const beforeXp = before?.xp ?? 0;
  const coinsDelta = calculateHeroCoinsDelta(beforeXp, xpDelta);
  statements.incrementUserXp.run(xpDelta, xpDelta, coinsDelta, userId);
  return statements.getUserById.get(userId);
}

function applyStreakShieldIfNeeded({ statements, user, db }) {
  if (!user) return { used: false, user };
  const shields = Number(user.streak_shield_count) || 0;
  if (shields <= 0) return { used: false, user };
  if (user.vacation_mode) return { used: false, user };

  const now = getUserNow(user).startOf('day');
  const yesterday = now.subtract(1, 'day').format('YYYY-MM-DD');
  if (user.streak_shield_last_used === yesterday) return { used: false, user };

  const habitCount = statements.getActiveHabitsCount.get(user.id).count || 0;
  if (habitCount === 0) return { used: false, user };

  const checkins = statements.getCheckinsForDate.all(user.id, yesterday) || [];
  const doneCount = checkins.filter((row) => row.status === 'done').length;
  if (doneCount >= habitCount) return { used: false, user };

  const habits = statements.getHabits.all(user.id);
  const createdAt = new Date().toISOString();
  const tx = db.transaction(() => {
    habits.forEach((habit) => {
      statements.upsertCheckin.run(user.id, habit.id, yesterday, 'done', createdAt);
    });
    statements.decrementStreakShield.run(user.id);
    statements.updateStreakShieldLastUsed.run(yesterday, user.id);
  });
  tx();

  const updated = statements.getUserById.get(user.id);
  return { used: true, user: updated };
}

function resolveDueDuels({ statements }) {
  const today = dayjs().utc().format('YYYY-MM-DD');
  const due = statements.getDueDuels.all(today) || [];
  if (!due.length) return;

  due.forEach((duel) => {
    const start = duel.start_date;
    const end = duel.end_date;
    const days = Math.max(1, dayjs(end).diff(dayjs(start), 'day') + 1);

    const challengerDone =
      statements.getCheckinsDoneForRange.get(duel.challenger_id, start, end).count || 0;
    const opponentDone =
      statements.getCheckinsDoneForRange.get(duel.opponent_id, start, end).count || 0;

    const challengerHabits =
      statements.getActiveHabitsCount.get(duel.challenger_id).count || 0;
    const opponentHabits =
      statements.getActiveHabitsCount.get(duel.opponent_id).count || 0;

    const challengerTotal = challengerHabits * days;
    const opponentTotal = opponentHabits * days;

    const challengerRate =
      challengerTotal > 0 ? challengerDone / challengerTotal : 0;
    const opponentRate =
      opponentTotal > 0 ? opponentDone / opponentTotal : 0;

    let status = 'draw';
    let winnerId = null;
    if (challengerRate > opponentRate) {
      status = 'completed';
      winnerId = duel.challenger_id;
    } else if (opponentRate > challengerRate) {
      status = 'completed';
      winnerId = duel.opponent_id;
    }

    if (winnerId) {
      awardXpAndCoins({ statements, userId: winnerId, xpDelta: 100 });
      statements.awardBadge.run(winnerId, 'duel_winner', new Date().toISOString());
    }

    statements.resolveDuel.run(status, winnerId, new Date().toISOString(), duel.id);
  });
}

function createApp({ db, bot }) {
  if (!db) {
    throw new Error('DB instance is required');
  }

  const app = express();
  app.set('trust proxy', 1);
  const statements = prepareStatements(db);
  const buildGuildPayload = (userId) => {
    const guild = statements.getGuildByUser.get(userId);
    if (!guild) {
      return { guild: null };
    }
    const members = statements.getGuildMembers.all(guild.id);
    const powerRow = statements.getGuildPower.get(guild.id);
    return {
      guild,
      power: powerRow?.power || 0,
      members: (members || []).map((row) => ({
        id: row.id,
        xp: row.xp ?? 0,
        level: row.level ?? calculateLevel(row.xp ?? 0),
      })),
    };
  };

  app.use(express.json({ limit: '10mb' }));

  // High-priority V2 WebApp route (avoid stale cache)
  app.get('/app', (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.sendFile(path.join(__dirname, '..', 'public', 'webapp', 'v2', 'index.html'));
  });

  // Static V2 assets (served under /app to match index.html relative paths)
  app.use(
    '/app',
    express.static(path.join(__dirname, '..', 'public', 'webapp', 'v2'), { redirect: false })
  );

  function resolvePublicBaseUrl(req) {
    const raw = process.env.BASE_URL || process.env.PUBLIC_BASE_URL;
    const fallback = `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}`;
    return String(raw || fallback).replace(/\/+$/, '');
  }

  function isPrivateHost(hostname) {
    if (!hostname) return true;
    if (hostname === 'localhost' || hostname.endsWith('.local')) return true;
    if (/^127\./.test(hostname)) return true;
    if (/^10\./.test(hostname)) return true;
    if (/^192\.168\./.test(hostname)) return true;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)) return true;
    return false;
  }

  app.post(
    '/api/share/upload',
    express.raw({ type: ['image/*', 'application/octet-stream'], limit: '12mb' }),
    async (req, res) => {
    try {
      let buffer = null;
      if (req.is('application/json')) {
        const image = req.body?.image;
        if (!image || typeof image !== 'string') {
          return res.status(400).json({ error: 'No image' });
        }
        const base64Data = image.replace(/^data:image\/\w+;base64,/, '');
        buffer = Buffer.from(base64Data, 'base64');
      } else if (Buffer.isBuffer(req.body) && req.body.length) {
        buffer = req.body;
      }

      if (!buffer) {
        return res.status(400).json({ error: 'No image' });
      }

      const fileName = `share_${Date.now()}.jpg`;
      fs.mkdirSync(TEMP_SHARE_DIR, { recursive: true });
      const filePath = path.join(TEMP_SHARE_DIR, fileName);
      fs.writeFileSync(filePath, buffer);

      const baseUrl = resolvePublicBaseUrl(req);
      const httpsBase = baseUrl.replace(/^http:\/\//i, 'https://');
      const publicUrl = `${httpsBase}${TEMP_SHARE_PUBLIC_PATH}/${fileName}`;
      let warning = null;
      try {
        const hostname = new URL(publicUrl).hostname;
        if (isPrivateHost(hostname)) {
          warning = 'BASE_URL appears to be local or private. Story sharing may fail.';
        }
      } catch {}

      res.json({ ok: true, url: publicUrl, warning });
    } catch (err) {
      console.error('Upload Error:', err);
      res.status(500).json({ error: err.message });
    }
    }
  );

  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  });

  app.get('/health', (req, res) => {
    res.json({ ok: true });
  });

  // Leads (landing)
  app.post('/api/leads', (req, res) => {
    const body = req.body || {};
    const emailRaw = typeof body.email === 'string' ? body.email.trim() : '';

    if (!EMAIL_REGEX.test(emailRaw)) {
      res.status(400).json({ ok: false, error: 'Invalid email' });
      return;
    }

    const email = emailRaw.toLowerCase();
    const createdAt = new Date().toISOString();

    statements.upsertLead.run(
      email,
      normalizeUtm(body.utm_source),
      normalizeUtm(body.utm_medium),
      normalizeUtm(body.utm_campaign),
      normalizeUtm(body.utm_content),
      normalizeUtm(body.utm_term),
      createdAt
    );

    res.json({
      ok: true,
      telegramUrl: buildTelegramUrl(),
    });
  });

  // Telegram WebApp auth middleware
  const authenticateUser = buildTelegramMiddleware(statements);
  const requireTelegram = authenticateUser;
  const analyticsLastSeen = new Map();

  app.post('/api/analytics', requireTelegram, (req, res) => {
    if (!ANALYTICS_ENABLED) {
      res.json({ ok: true, disabled: true });
      return;
    }

    const rawEvent = typeof req.body?.event === 'string' ? req.body.event.trim() : '';
    if (!ANALYTICS_EVENTS.has(rawEvent)) {
      res.status(400).json({ ok: false, error: 'Invalid event' });
      return;
    }

    const now = Date.now();
    const key = `${req.user.id}:${rawEvent}`;
    const last = analyticsLastSeen.get(key) || 0;
    if (now - last < 2000) {
      res.json({ ok: true, ignored: true });
      return;
    }
    analyticsLastSeen.set(key, now);

    let meta = null;
    if (req.body?.meta && typeof req.body.meta === 'object') {
      try {
        meta = JSON.stringify(req.body.meta);
      } catch {
        meta = null;
      }
    }

    statements.insertAnalyticsEvent.run(req.user.id, rawEvent, meta, new Date().toISOString());
    res.json({ ok: true });
  });

  // --- WebApp API ---
  app.get('/api/me', requireTelegram, (req, res) => {
    resolveDueDuels({ statements });
    let user = statements.getUserById.get(req.user.id) || req.user;
    const shieldOutcome = applyStreakShieldIfNeeded({ statements, user, db });
    user = shieldOutcome.user || user;
    const now = getUserNow(user);
    const today = now.format('YYYY-MM-DD');
    const habits = statements.getHabits.all(req.user_id).map((habit) => {
      const checkins = statements.getCheckinsForHabit.all(req.user_id, habit.id);
      const streak = calculateCurrentStreak(checkins, now);
      return { ...habit, streak };
    });
    const streak = habits.reduce((max, habit) => Math.max(max, Number(habit.streak) || 0), 0);
    const checkins = statements.getCheckinsForDate.all(req.user.id, today);
    const monitor = statements.getMonitorByUserId.get(req.user.id);

    const todayCheckins = {};
    for (const checkin of checkins) {
      todayCheckins[checkin.habit_id] = checkin.status; // "done" | "skip"
    }

    const safeUser = sanitizeUser(user);
    const badges = statements.getUserBadges.all(user.id).map((row) => row.badge);
    const botUsername = process.env.TELEGRAM_BOT_USERNAME || '';
    const inviteLink = botUsername
      ? `https://t.me/${botUsername}?start=invite_${safeUser.id}`
      : null;
    const shareWidgetLink = botUsername ? `https://t.me/${botUsername}/app` : null;
    const referralBonus = Number(user.referral_bonus_pending) || 0;
    if (referralBonus > 0) {
      statements.clearReferralBonusPending.run(user.id);
    }
    const debugWhitelist = parseDebugWhitelist();
    const debugMonitorAllowed = debugWhitelist.has(String(req.user.telegram_id));

    res.json({
      ok: true,
      user: safeUser,
      plan: safeUser.plan,
      trialUntil: safeUser.trial_until || null,
      referralBonus: referralBonus > 0 ? referralBonus : null,
      botUsername: botUsername || null,
      monitor:
        monitor && monitor.enabled
          ? {
              connected: true,
              monitorTelegramId: monitor.monitor_telegram_id,
              monitorName: monitor.monitor_name,
              monitorUsername: monitor.monitor_username,
            }
          : { connected: false },
      inviteLink,
      shareWidgetLink,
      debugMonitorAllowed,
      habits,
      streak,
      todayCheckins,
      shieldUsed: shieldOutcome.used,
      badges,
    });
  });

  app.get('/api/habits', requireTelegram, (req, res) => {
    let user = statements.getUserById.get(req.user.id) || req.user;
    const shieldOutcome = applyStreakShieldIfNeeded({ statements, user, db });
    user = shieldOutcome.user || user;
    const now = getUserNow(user);
    const habits = statements.getHabits.all(user.id).map((habit) => {
      const checkins = statements.getCheckinsForHabit.all(req.user.id, habit.id);
      const streak = calculateCurrentStreak(checkins, now);
      return { ...habit, streak };
    });
    res.json({ ok: true, habits });
  });

  app.post('/api/habits', requireTelegram, (req, res) => {
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    if (!title) {
      res.status(400).json({ ok: false, error: 'Missing title' });
      return;
    }

    let userId = req.user_id;
    let dbUser = req.user || null;
    const allowDemoUser = process.env.ALLOW_DEMO_USER === '1';

    if (!userId) {
      if (allowDemoUser) {
        const demoTelegramId = -1;
        try {
          statements.createUserMinimal.run(demoTelegramId, new Date().toISOString());
        } catch (error) {
          // Ignore duplicate demo user errors.
          if (!String(error?.message || '').includes('UNIQUE')) {
            console.warn('[habits:create] Demo user create failed:', error?.message || error);
          }
        }
        dbUser = statements.getUserByTelegramId.get(demoTelegramId);
        userId = dbUser?.id;
        req.user = dbUser || req.user;
        req.user_id = userId;
        req.telegram_id = demoTelegramId;
      } else {
        res.status(401).json({ ok: false, error: 'Unauthorized' });
        return;
      }
    }

    if (!dbUser && userId) {
      dbUser = statements.getUserById.get(userId);
    }

    if (!dbUser && req.telegram_id) {
      const createdAt = new Date().toISOString();
      try {
        statements.createUserMinimal.run(req.telegram_id, createdAt);
      } catch (error) {
        if (!String(error?.message || '').includes('UNIQUE')) {
          console.warn('[habits:create] User auto-create failed:', error?.message || error);
        }
      }
      dbUser = statements.getUserByTelegramId.get(req.telegram_id);
      userId = dbUser?.id || userId;
      req.user = dbUser || req.user;
      req.user_id = userId;
    }

    if (!userId || !dbUser) {
      res.status(401).json({ ok: false, error: 'Unauthorized' });
      return;
    }

    const premiumActive = isPremiumActive(dbUser);
    const { icon, color } = resolveHabitVisuals(req.body?.icon, req.body?.color);

    if (!premiumActive) {
      const habitCount = statements.getActiveHabitsCount.get(userId).count || 0;
      console.log('[createHabit] userId:', userId, 'habitCount:', habitCount, 'limit:', FREE_HABIT_LIMIT, 'plan:', dbUser?.plan);
      if (habitCount >= FREE_HABIT_LIMIT) {
        res.status(403).json({
          ok: false,
          error: `Ліміт ${FREE_HABIT_LIMIT} звичок для безкоштовного плану`,
          code: 'premium_required',
          limit: FREE_HABIT_LIMIT,
          current: habitCount,
        });
        return;
      }
    }

    try {
      const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='habits'").get();
      if (!table) {
        res.status(500).json({ ok: false, error: 'Habits table missing' });
        return;
      }
    } catch (err) {
      console.error('[habits:create] Schema check failed:', err?.message || err);
      res.status(500).json({ ok: false, error: `Schema check failed: ${err.message}` });
      return;
    }

    try {
      const maxOrder = statements.getMaxSortOrder.get(userId).max || 0;
      const createdAt = new Date().toISOString();
      const result = statements.createHabit.run(userId, title, icon, color, maxOrder + 1, createdAt);
      const habit = statements.getHabitById.get(result.lastInsertRowid, userId);
      res.json({ ok: true, habit });
    } catch (err) {
      console.error('[habits:create] Insert failed:', err?.message || err);
      res.status(500).json({ ok: false, error: `Insert failed: ${err.message}` });
    }
  });

  app.put('/api/habits/:id', requireTelegram, (req, res) => {
    const habitId = Number(req.params.id);
    if (!habitId) {
      res.status(400).json({ ok: false, error: 'Bad habit id' });
      return;
    }

    const habit = statements.getHabitById.get(habitId, req.user_id);
    if (!habit) {
      res.status(404).json({ ok: false, error: 'Habit not found' });
      return;
    }

    const updates = req.body || {};

    if (typeof updates.title === 'string') {
      const title = updates.title.trim();
      if (title) {
        statements.updateHabitTitle.run(title, habitId, req.user.id);
      }
    }

    if (updates.active !== undefined) {
      const active = updates.active ? 1 : 0;
      statements.updateHabitActive.run(active, habitId, req.user.id);
    }

    if (updates.sort_order !== undefined) {
      const sortOrder = Number(updates.sort_order);
      if (!Number.isNaN(sortOrder)) {
        statements.updateHabitSortOrder.run(sortOrder, habitId, req.user.id);
      }
    }

    if (typeof updates.icon === 'string') {
      const icon = normalizeHabitIcon(updates.icon);
      statements.updateHabitIcon.run(icon, habitId, req.user.id);
    }

    if (typeof updates.color === 'string') {
      const color = normalizeHabitColor(updates.color);
      statements.updateHabitColor.run(color, habitId, req.user.id);
    }

    const updated = statements.getHabitById.get(habitId, req.user.id);
    res.json({ ok: true, habit: updated });
  });

  app.delete('/api/habits/:id', requireTelegram, (req, res) => {
    const habitId = Number(req.params.id);
    if (!habitId) {
      res.status(400).json({ ok: false, error: 'Bad habit id' });
      return;
    }

    const habit = statements.getHabitById.get(habitId, req.user.id);
    if (!habit) {
      res.status(404).json({ ok: false, error: 'Habit not found' });
      return;
    }

    try {
      const tx = db.transaction(() => {
        statements.deleteCheckinsForHabit.run(req.user.id, habitId);
        statements.deleteHabit.run(habitId, req.user.id);
      });
      tx();
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: `Delete failed: ${err.message}` });
    }
  });

  // Batch reorder habits
  app.post('/api/habits/reorder', requireTelegram, (req, res) => {
    const order = req.body?.order;

    if (!Array.isArray(order) || order.length === 0) {
      res.status(400).json({ ok: false, error: 'Invalid order array' });
      return;
    }

    // Validate and update each habit
    let updated = 0;
    for (const item of order) {
      const habitId = Number(item.id);
      const sortOrder = Number(item.sort_order);

      if (!habitId || !Number.isFinite(sortOrder)) continue;

      // Verify ownership
      const habit = statements.getHabitById.get(habitId, req.user.id);
      if (!habit) continue;

      statements.updateHabitSortOrder.run(sortOrder, habitId, req.user.id);
      updated++;
    }

    res.json({ ok: true, updated });
  });

  app.post('/api/today/checkin', requireTelegram, (req, res) => {
    const habitId = Number(req.body?.habitId) || Number(req.body?.habit_id);
    const status = req.body?.status;

    if (!habitId || (status !== 'done' && status !== 'skip')) {
      res.status(400).json({ ok: false, error: 'Bad payload' });
      return;
    }

    const habit = statements.getHabitById.get(habitId, req.user.id);
    if (!habit || habit.active !== 1) {
      res.status(404).json({ ok: false, error: 'Habit not found' });
      return;
    }

    const date = getUserNow(req.user).format('YYYY-MM-DD');
    const createdAt = new Date().toISOString();
    const previous = statements.getCheckinStatusForDate.get(req.user_id, habitId, date);
    statements.upsertCheckin.run(req.user_id, habitId, date, status, createdAt);

    const beforeUser = statements.getUserById.get(req.user.id);
    let xp = beforeUser?.xp ?? 0;
    let level = beforeUser?.level ?? calculateLevel(xp);
    let heroCoins = beforeUser?.hero_coins ?? 0;
    let levelUp = false;
    if (status === 'done' && previous?.status !== 'done') {
      const updatedUser = awardXpAndCoins({
        statements,
        userId: req.user.id,
        xpDelta: XP_PER_CHECKIN,
      });
      xp = updatedUser?.xp ?? xp + XP_PER_CHECKIN;
      level = updatedUser?.level ?? calculateLevel(xp);
      heroCoins = updatedUser?.hero_coins ?? heroCoins;
      levelUp = level > (beforeUser?.level ?? calculateLevel(beforeUser?.xp));
    }

    res.json({ ok: true, date, status, xp, level, levelUp, hero_coins: heroCoins });
  });

  // Alias for clients that call /api/habits/:id/checkin
  app.post('/api/habits/:id/checkin', requireTelegram, (req, res) => {
    const habitId = Number(req.params.id);
    const status = req.body?.status || 'done';

    if (!habitId || (status !== 'done' && status !== 'skip')) {
      res.status(400).json({ ok: false, error: 'Bad payload' });
      return;
    }

    const habit = statements.getHabitById.get(habitId, req.user_id);
    if (!habit || habit.active !== 1) {
      res.status(404).json({ ok: false, error: 'Habit not found' });
      return;
    }

    const date = getUserNow(req.user).format('YYYY-MM-DD');
    const createdAt = new Date().toISOString();
    const previous = statements.getCheckinStatusForDate.get(req.user_id, habitId, date);
    statements.upsertCheckin.run(req.user_id, habitId, date, status, createdAt);

    const beforeUser = statements.getUserById.get(req.user.id);
    let xp = beforeUser?.xp ?? 0;
    let level = beforeUser?.level ?? calculateLevel(xp);
    let heroCoins = beforeUser?.hero_coins ?? 0;
    let levelUp = false;
    if (status === 'done' && previous?.status !== 'done') {
      const updatedUser = awardXpAndCoins({
        statements,
        userId: req.user.id,
        xpDelta: XP_PER_CHECKIN,
      });
      xp = updatedUser?.xp ?? xp + XP_PER_CHECKIN;
      level = updatedUser?.level ?? calculateLevel(xp);
      heroCoins = updatedUser?.hero_coins ?? heroCoins;
      levelUp = level > (beforeUser?.level ?? calculateLevel(beforeUser?.xp));
    }

    res.json({ ok: true, date, status, xp, level, levelUp, hero_coins: heroCoins });
  });

  app.post('/api/today/undo', requireTelegram, (req, res) => {
    const habitId = Number(req.body?.habitId) || Number(req.body?.habit_id);

    if (!habitId) {
      res.status(400).json({ ok: false, error: 'Bad payload' });
      return;
    }

    const habit = statements.getHabitById.get(habitId, req.user_id);
    if (!habit || habit.active !== 1) {
      res.status(404).json({ ok: false, error: 'Habit not found' });
      return;
    }

    const date = getUserNow(req.user).format('YYYY-MM-DD');
    statements.deleteCheckinForDate.run(req.user_id, habitId, date);

    res.json({ ok: true, date });
  });

  app.post('/api/progress/reset', requireTelegram, (req, res) => {
    try {
      statements.deleteCheckinsForUser.run(req.user.id);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: `Reset failed: ${err.message}` });
    }
  });

  app.post('/api/user/reset', requireTelegram, (req, res) => {
    try {
      const tx = db.transaction(() => {
        statements.deleteCheckinsForUser.run(req.user.id);
        statements.deleteHabitsForUser.run(req.user.id);
        statements.resetUserXp.run(req.user.id);
      });
      tx();
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: `Reset failed: ${err.message}` });
    }
  });

  app.post('/api/settings', requireTelegram, (req, res) => {
    const payload = req.body || {};
    const previousReminderTime = req.user?.reminder_time || '';
    let newReminderTime = null;

    if (typeof payload.timezone === 'string' && payload.timezone.trim()) {
      statements.updateUserTimezone.run(payload.timezone.trim(), req.user.id);
    }

    if (typeof payload.reminder_time === 'string') {
      const time = payload.reminder_time.trim();
      if (!TIME_REGEX.test(time)) {
        res.status(400).json({ ok: false, error: 'Bad time format (HH:MM)' });
        return;
      }
      statements.updateUserReminderTime.run(time, req.user.id);
      newReminderTime = time;
    }

    if (payload.social_shame !== undefined) {
      const value = payload.social_shame ? 1 : 0;
      statements.updateUserSocialShame.run(value, req.user.id);
    }

    if (typeof payload.social_shame_partner_username === 'string') {
      const raw = payload.social_shame_partner_username.trim();
      const normalized = raw ? raw.replace(/^@/, '') : null;
      statements.updateUserSocialShamePartner.run(normalized, req.user.id);
    }

    if (payload.vacation_mode !== undefined) {
      const value = payload.vacation_mode ? 1 : 0;
      statements.updateUserVacationMode.run(value, req.user.id);
    }

    if (typeof payload.active_theme === 'string') {
      const theme = payload.active_theme.trim().toLowerCase();
      if (THEMES.has(theme)) {
        statements.updateUserActiveTheme.run(theme, req.user.id);
      }
    }

    const updated = statements.getUserById.get(req.user.id);
    if (
      newReminderTime &&
      newReminderTime !== previousReminderTime &&
      bot &&
      updated?.telegram_id
    ) {
      const tz = updated.timezone || DEFAULT_TIMEZONE;
      const message = texts.reminderTimeTest
        ? texts.reminderTimeTest(newReminderTime, tz)
        : `✅ Reminder time updated to ${newReminderTime} (${tz}). This is a test notification.`;
      try {
        bot.sendMessage(updated.telegram_id, message);
      } catch (err) {
        console.warn('Reminder test send failed:', err?.message || err);
      }
    }
    res.json({ ok: true, user: sanitizeUser(updated) });
  });

  app.post('/api/social-shame/test', requireTelegram, async (req, res) => {
    const user = statements.getUserById.get(req.user.id);
    const partnerRaw = String(user?.social_shame_partner_username || '').trim();
    if (!partnerRaw) {
      res.status(400).json({ ok: false, error: 'Partner username required' });
      return;
    }
    if (!bot || typeof bot.sendMessage !== 'function') {
      res.status(500).json({ ok: false, error: 'Bot unavailable' });
      return;
    }
    const normalized = partnerRaw.replace(/^@+/, '');
    const handle = `@${normalized}`;
    const label = user?.telegram_id ? `User ${user.telegram_id}` : `User ${user?.id}`;
    const message = texts.socialShameTestMessage
      ? texts.socialShameTestMessage(label)
      : `Test: ${label} is checking that accountability messages work.`;
    try {
      await bot.sendMessage(handle, message);
      res.json({ ok: true, handle });
    } catch (err) {
      console.warn('Social shame test send failed:', err?.message || err);
      res.status(500).json({
        ok: false,
        error: 'Unable to reach partner. Ensure they started the bot.',
      });
    }
  });

  app.post('/api/shop/purchase', requireTelegram, (req, res) => {
    const item = typeof req.body?.item === 'string' ? req.body.item.trim() : '';
    const currency = typeof req.body?.currency === 'string' ? req.body.currency.trim() : 'coins';
    if (!item) {
      res.status(400).json({ ok: false, error: 'Missing item' });
      return;
    }

    if (item !== 'streak_shield') {
      res.status(400).json({ ok: false, error: 'Unknown item' });
      return;
    }

    if (currency !== 'coins') {
      res.status(400).json({ ok: false, error: 'Currency not supported yet' });
      return;
    }

    const user = statements.getUserById.get(req.user.id);
    const coins = user?.hero_coins ?? 0;
    if (coins < STREAK_SHIELD_COST) {
      res.status(400).json({ ok: false, error: 'Not enough Hero Coins' });
      return;
    }

    const tx = db.transaction(() => {
      statements.spendHeroCoins.run(STREAK_SHIELD_COST, req.user.id);
      statements.incrementStreakShield.run(1, req.user.id);
    });
    tx();

    const updated = statements.getUserById.get(req.user.id);
    res.json({
      ok: true,
      hero_coins: updated?.hero_coins ?? coins - STREAK_SHIELD_COST,
      streak_shield_count: updated?.streak_shield_count ?? 0,
    });
  });

  app.post('/api/monitor/unlink', requireTelegram, (req, res) => {
    statements.disableMonitor.run(req.user.id);
    res.json({ ok: true });
  });

  app.get('/api/guilds', requireTelegram, (req, res) => {
    const payload = buildGuildPayload(req.user.id);
    res.json({ ok: true, ...payload });
  });

  app.post('/api/guilds', requireTelegram, (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const guildId = Number(req.body?.guild_id || req.body?.guildId);

    if (!name && !guildId) {
      res.status(400).json({ ok: false, error: 'Name or guild id required' });
      return;
    }

    const existing = statements.getGuildByUser.get(req.user.id);
    if (existing) {
      res.status(400).json({ ok: false, error: 'Already in a guild' });
      return;
    }

    if (name) {
      const createdAt = new Date().toISOString();
      const tx = db.transaction(() => {
        const info = statements.createGuild.run(name, req.user.id, createdAt);
        const newGuildId = info.lastInsertRowid;
        statements.addGuildMember.run(newGuildId, req.user.id, createdAt);
      });
      tx();
      const payload = buildGuildPayload(req.user.id);
      res.json({ ok: true, ...payload });
      return;
    }

    const guild = statements.getGuildById.get(guildId);
    if (!guild) {
      res.status(404).json({ ok: false, error: 'Guild not found' });
      return;
    }
    try {
      statements.addGuildMember.run(guildId, req.user.id, new Date().toISOString());
      const payload = buildGuildPayload(req.user.id);
      res.json({ ok: true, ...payload });
    } catch (err) {
      res.status(400).json({ ok: false, error: 'Unable to join guild' });
    }
  });

  app.post('/api/guilds/create', requireTelegram, (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name) {
      res.status(400).json({ ok: false, error: 'Name required' });
      return;
    }
    const existing = statements.getGuildByUser.get(req.user.id);
    if (existing) {
      res.status(400).json({ ok: false, error: 'Already in a guild' });
      return;
    }
    const createdAt = new Date().toISOString();
    const tx = db.transaction(() => {
      const info = statements.createGuild.run(name, req.user.id, createdAt);
      const guildId = info.lastInsertRowid;
      statements.addGuildMember.run(guildId, req.user.id, createdAt);
      return guildId;
    });
    const guildId = tx();
    const payload = buildGuildPayload(req.user.id);
    res.json({ ok: true, ...payload });
  });

  app.post('/api/guilds/join', requireTelegram, (req, res) => {
    const guildId = Number(req.body?.guild_id || req.body?.guildId);
    if (!guildId) {
      res.status(400).json({ ok: false, error: 'Guild id required' });
      return;
    }
    const existing = statements.getGuildByUser.get(req.user.id);
    if (existing) {
      res.status(400).json({ ok: false, error: 'Already in a guild' });
      return;
    }
    const guild = statements.getGuildById.get(guildId);
    if (!guild) {
      res.status(404).json({ ok: false, error: 'Guild not found' });
      return;
    }
    try {
      statements.addGuildMember.run(guildId, req.user.id, new Date().toISOString());
      const payload = buildGuildPayload(req.user.id);
      res.json({ ok: true, ...payload });
    } catch (err) {
      res.status(400).json({ ok: false, error: 'Unable to join guild' });
    }
  });

  app.get('/api/guilds/me', requireTelegram, (req, res) => {
    const payload = buildGuildPayload(req.user.id);
    res.json({ ok: true, ...payload });
  });

  app.post('/api/duels/challenge', requireTelegram, (req, res) => {
    const opponentId = Number(req.body?.opponent_id || req.body?.opponentId);
    if (!opponentId) {
      res.status(400).json({ ok: false, error: 'Opponent required' });
      return;
    }
    if (opponentId === req.user.id) {
      res.status(400).json({ ok: false, error: 'Cannot challenge yourself' });
      return;
    }
    const opponent = statements.getUserById.get(opponentId);
    if (!opponent) {
      res.status(404).json({ ok: false, error: 'Opponent not found' });
      return;
    }
    const existing = statements.getActiveDuelBetween.get(
      req.user.id,
      opponentId,
      opponentId,
      req.user.id
    );
    if (existing) {
      res.status(400).json({ ok: false, error: 'Duel already active' });
      return;
    }
    const start = dayjs().utc().startOf('day');
    const end = start.add(DUEL_DURATION_DAYS - 1, 'day');
    const createdAt = new Date().toISOString();
    statements.createDuel.run(
      req.user.id,
      opponentId,
      start.format('YYYY-MM-DD'),
      end.format('YYYY-MM-DD'),
      createdAt
    );
    res.json({ ok: true });
  });

  app.post('/debug/monitor/check-now', requireTelegram, (req, res) => {
    const whitelist = parseDebugWhitelist();
    if (!whitelist.size || !whitelist.has(String(req.user.telegram_id))) {
      res.status(403).json({ ok: false, error: 'Forbidden' });
      return;
    }

    if (!bot) {
      res.status(503).json({ ok: false, error: 'Bot not available' });
      return;
    }

    const outcome = runMonitorCheck({
      user: req.user,
      statements,
      bot,
    });

    res.json({ ok: true, ...outcome });
  });

  app.get('/api/leaderboard', requireTelegram, (req, res) => {
    const top = statements.getLeaderboardTop.all();
    const me = statements.getUserById.get(req.user.id);
    const xp = me?.xp ?? 0;
    const level = me?.level ?? calculateLevel(xp);
    const rankRow = statements.getUserRank.get(xp, xp, req.user.id);
    const rank = rankRow?.rank ?? 1;

    res.json({
      ok: true,
      top: top.map((row) => ({
        id: row.id,
        xp: row.xp ?? 0,
        level: row.level ?? calculateLevel(row.xp ?? 0),
      })),
      me: {
        id: req.user.id,
        xp,
        level,
        rank,
      },
    });
  });

  app.get('/api/stats', requireTelegram, (req, res) => {
    const rangeParam = Number(req.query.range || 7);
    const range = rangeParam === 30 ? 30 : 7;
    const today = getUserNow(req.user);

    const habits = statements.getHabits.all(req.user_id);
    const stats = habits.map((habit) => {
      const checkins = statements.getCheckinsForHabit.all(req.user_id, habit.id);
      const streak = calculateCurrentStreak(checkins, today);
      const completion = calculateCompletionForRange(checkins, range, today);
      return {
        id: habit.id,
        title: habit.title,
        streak,
        completion,
      };
    });

    res.json({ ok: true, range, stats });
  });

  app.get('/api/stats/weekly-summary', requireTelegram, (req, res) => {
    const today = getUserNow(req.user).startOf('day');
    const to = today.format('YYYY-MM-DD');
    const from = today.subtract(6, 'day').format('YYYY-MM-DD');
    const habits = statements.getHabits.all(req.user.id);
    const checkins = statements.getCheckinsForRange.all(req.user.id, from, to);
    const statusByDate = new Map();
    for (const row of checkins) {
      if (!statusByDate.has(row.date)) statusByDate.set(row.date, new Map());
      statusByDate.get(row.date).set(row.habit_id, row.status);
    }
    const days = [];
    const totalHabits = habits.length;
    for (let i = 0; i < 7; i += 1) {
      const date = dayjs(from).add(i, 'day').format('YYYY-MM-DD');
      const statusMap = statusByDate.get(date) || new Map();
      const doneCount = habits.filter((h) => statusMap.get(h.id) === 'done').length;
      const skipCount = habits.filter((h) => statusMap.get(h.id) === 'skip').length;
      days.push({
        date,
        done: doneCount,
        skip: skipCount,
        total: totalHabits,
        statuses: habits.map((h) => ({
          habit_id: h.id,
          title: h.title,
          status: statusMap.get(h.id) || 'none',
        })),
      });
    }
    res.json({
      ok: true,
      from,
      to,
      timezone: req.user.timezone || DEFAULT_TIMEZONE,
      habits: habits.map((h) => ({ id: h.id, title: h.title })),
      days,
    });
  });

  app.get('/api/stats/heatmap', requireTelegram, (req, res) => {
    const daysRaw = Number(req.query.days || 365);
    const days = Math.min(Math.max(Number.isFinite(daysRaw) ? daysRaw : 365, 7), 365);

    const today = getUserNow(req.user);
    const to = today.format('YYYY-MM-DD');
    const from = today.subtract(days - 1, 'day').format('YYYY-MM-DD');

    const rows = statements.getHeatmapRows.all({
      userId: req.user.id,
      from,
      to,
    });

    const data = rows.map((row) => {
      const total = row.total || 0;
      const done = row.done || 0;
      const completion = total > 0 ? done / total : 0;

      let level = 0;
      if (total > 0 && completion === 1) level = 3;
      else if (completion >= 0.5) level = 2;
      else if (completion > 0) level = 1;

      return {
        date: row.day,
        done,
        total,
        completion,
        level,
      };
    });

    res.json({
      ok: true,
      days,
      from,
      to,
      timezone: req.user.timezone || 'Europe/Prague',
      data,
    });
  });

  // Share assets alias for direct /public/shares URLs
  app.use('/public/shares', express.static(path.join(__dirname, '..', 'public', 'shares')));
  app.use(
    '/public/temp_shares',
    express.static(path.join(__dirname, '..', 'public', 'temp_shares'))
  );

  // Landing static
  app.use(express.static(path.join(__dirname, '..', 'public')));

  return app;
}

function startApp({ port, db, bot }) {
  const app = createApp({ db, bot });
  // If you want to allow external access to Node directly (not recommended with Nginx),
  // you can bind 0.0.0.0. With Nginx reverse-proxy, default is fine.
  const server = app.listen(port);
  return { app, server };
}

function buildTelegramUrl() {
  const username = process.env.TELEGRAM_BOT_USERNAME;
  if (!username) return 'https://t.me/';
  return `https://t.me/${username}?start=onboarding`;
}

function normalizeUtm(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

function isTrialActive(user) {
  if (!user?.trial_until) return false;
  const parsed = dayjs(user.trial_until);
  if (!parsed.isValid()) return false;
  return parsed.isAfter(dayjs());
}

function getPlanOverride() {
  return PLAN_OVERRIDE === 'premium' || PLAN_OVERRIDE === 'free' ? PLAN_OVERRIDE : null;
}

function isPremiumActive(user) {
  const override = getPlanOverride();
  if (override) return override === 'premium';
  if (user?.is_premium === 1 || user?.is_premium === true) return true;
  if (user?.subscription_end_date) {
    const parsed = dayjs(user.subscription_end_date);
    if (parsed.isValid() && parsed.isAfter(dayjs())) return true;
  }
  if (isTrialActive(user)) return true;
  const plan = user?.plan || DEFAULT_PLAN;
  return plan === 'premium';
}

function getEffectivePlan(user) {
  const override = getPlanOverride();
  if (override) return override;
  return isPremiumActive(user) ? 'premium' : user?.plan || DEFAULT_PLAN;
}

function sanitizeUser(user) {
  const plan = getEffectivePlan(user);
  const isPremium = isPremiumActive(user);
  return {
    id: user.id,
    telegram_id: user.telegram_id,
    timezone: user.timezone,
    reminder_time: user.reminder_time,
    trial_until: user.trial_until || null,
    referred_by_user_id: user.referred_by_user_id || null,
    social_shame: user.social_shame ?? 0,
    vacation_mode: user.vacation_mode ?? 0,
    social_shame_partner_username: user.social_shame_partner_username || null,
    language_code: user.language_code || 'en',
    xp: user.xp ?? 0,
    level: user.level ?? calculateLevel(user.xp ?? 0),
    hero_coins: user.hero_coins ?? 0,
    streak_shield_count: user.streak_shield_count ?? 0,
    streak_shield_last_used: user.streak_shield_last_used || null,
    active_theme: user.active_theme || 'default',
    is_premium: isPremium,
    subscription_end_date: user.subscription_end_date || null,
    plan,
  };
}

function parseDebugWhitelist() {
  const raw = process.env.DEBUG_MONITOR_WHITELIST || '';
  const list = raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return new Set(list);
}

function runMonitorCheck({ user, statements, bot }) {
  const monitor = statements.getMonitorByUserId.get(user.id);
  const today = getUserNow(user).format('YYYY-MM-DD');

  if (!monitor || !monitor.enabled) {
    return { sent: false, reason: 'no_monitor' };
  }

  if (monitor.last_notified_date === today) {
    return { sent: false, reason: 'already_notified' };
  }

  if (!monitor.monitor_telegram_id || monitor.monitor_telegram_id === user.telegram_id) {
    statements.updateMonitorNotifiedDate.run(today, user.id);
    return { sent: false, reason: 'invalid_monitor' };
  }

  const habitCount = statements.getActiveHabitsCount.get(user.id).count || 0;
  if (habitCount === 0) {
    statements.updateMonitorNotifiedDate.run(today, user.id);
    return { sent: false, reason: 'no_habits' };
  }

  const checkinsCount = statements.getCheckinsCountForDate.get(user.id, today).count || 0;
  if (checkinsCount >= habitCount) {
    statements.updateMonitorNotifiedDate.run(today, user.id);
    return { sent: false, reason: 'day_complete' };
  }

  bot.sendMessage(monitor.monitor_telegram_id, texts.monitorNotify, {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: texts.monitorKickButton,
            callback_data: `kick:${user.id}`,
          },
        ],
      ],
    },
  });

  statements.updateMonitorNotifiedDate.run(today, user.id);
  return { sent: true };
}

function getUserNow(user) {
  const tz = user?.timezone || DEFAULT_TIMEZONE;
  try {
    return dayjs().tz(tz);
  } catch {
    return dayjs().tz(DEFAULT_TIMEZONE);
  }
}

function calculateCompletionForRange(checkins, range, today) {
  const statusMap = new Map();
  for (const checkin of checkins) {
    statusMap.set(checkin.date, checkin.status);
  }

  let doneCount = 0;
  for (let i = 0; i < range; i += 1) {
    const dateKey = today.subtract(i, 'day').format('YYYY-MM-DD');
    if (statusMap.get(dateKey) === 'done') {
      doneCount += 1;
    }
  }

  return Math.round((doneCount / range) * 100);
}

function buildTelegramMiddleware(statements) {
  function attachDebugUser(req, next) {
    const debugTelegramId = 1;
    let dbUser = statements.getUserByTelegramId.get(debugTelegramId);
    if (!dbUser) {
      const createdAt = new Date().toISOString();
      statements.createUserMinimal.run(debugTelegramId, createdAt);
      dbUser = statements.getUserByTelegramId.get(debugTelegramId);
    }
    const user = { ...dbUser, username: 'tester' };
    req.telegramUser = { id: debugTelegramId, username: 'tester' };
    req.user = user;
    req.user_id = user.id;
    req.telegram_id = debugTelegramId;
    next();
  }

  return (req, res, next) => {
    const initData = getInitDataFromRequest(req);
    const isDebugHeader = initData === 'debug-mode';
    const hasInitData = Boolean(initData && !isDebugHeader);
    const botToken = process.env.BOT_TOKEN;

    if (!hasInitData) {
      if (ALLOW_DEBUG_AUTH && isDebugHeader) {
        attachDebugUser(req, next);
        return;
      }
      res.status(401).json({ ok: false, error: 'Missing initData' });
      return;
    }

    if (!botToken) {
      if (ALLOW_DEBUG_AUTH) {
        attachDebugUser(req, next);
        return;
      }
      res.status(500).json({ ok: false, error: 'Server misconfigured (BOT_TOKEN missing)' });
      return;
    }

    const verified = verifyTelegramInitData(initData, botToken);
    if (!verified) {
      if (ALLOW_DEBUG_AUTH) {
        attachDebugUser(req, next);
        return;
      }
      res.status(401).json({ ok: false, error: 'Invalid initData' });
      return;
    }

    // Create/load local user
    const telegramId = verified.user.id;
    let user = statements.getUserByTelegramId.get(telegramId);
    let isNewUser = false;
    if (!user) {
      const createdAt = new Date().toISOString();
      statements.createUserMinimal.run(telegramId, createdAt);
      user = statements.getUserByTelegramId.get(telegramId);
      isNewUser = true;
    }

    if (verified.user.language_code && statements.updateUserLanguage) {
      statements.updateUserLanguage.run(verified.user.language_code, user.id);
      user = statements.getUserByTelegramId.get(telegramId);
    }

    if (isNewUser) {
      // No auto-seeding for cold start.
    }

    req.telegramUser = verified.user;
    req.user = user;
    req.user_id = user.id;
    req.telegram_id = telegramId;
    next();
  };
}

function getInitDataFromRequest(req) {
  const authHeader = req.header('Authorization');
  if (typeof authHeader === 'string' && authHeader.trim()) {
    const raw = authHeader.trim();
    const lower = raw.toLowerCase();
    if (lower.startsWith('bearer ')) return raw.slice(7).trim();
    if (lower.startsWith('tma ')) return raw.slice(4).trim();
    return raw;
  }

  const header = req.header('X-TG-INIT-DATA');
  if (typeof header === 'string' && header.trim()) return header;

  const query = req.query || {};
  const candidates = [
    query.tgWebAppData,
    query.initData,
    query.init_data,
  ];

  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) return value;
  }

  return '';
}

function seedDefaultHabits(statements, userId) {
  if (!statements?.createHabit || !statements?.getHabits) return;
  const existing = statements.getHabits.all(userId);
  if (existing && existing.length > 0) return;
  const createdAt = new Date().toISOString();
  for (const habit of DEFAULT_HABITS) {
    const visuals = resolveHabitVisuals(habit.icon, habit.color);
    statements.createHabit.run(userId, habit.title, visuals.icon, visuals.color, habit.sort, createdAt);
  }
}

function verifyTelegramInitData(initData, botToken) {
  try {
    const params = new URLSearchParams(initData);

    const hash = params.get('hash');
    if (!hash) return null;

    // Freshness check
    const authDateStr = params.get('auth_date');
    const authDate = authDateStr ? Number(authDateStr) : NaN;
    if (!Number.isNaN(authDate)) {
      const nowSec = Math.floor(Date.now() / 1000);
      const age = nowSec - authDate;
      if (age < 0 || age > MAX_AUTH_AGE_SECONDS) {
        return null;
      }
    }

    params.delete('hash');

    // data_check_string: sort keys
    const keys = Array.from(params.keys()).sort();
    const dataCheckString = keys.map((key) => `${key}=${params.get(key)}`).join('\n');

    // Telegram WebApp secret key:
    // secret_key = HMAC_SHA256("WebAppData", bot_token)
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();

    const computedHash = crypto
      .createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex');

    // timing-safe compare
    const a = Buffer.from(computedHash, 'hex');
    const b = Buffer.from(String(hash), 'hex');
    if (a.length !== b.length) return null;
    if (!crypto.timingSafeEqual(a, b)) return null;

    const userRaw = params.get('user');
    if (!userRaw) return null;

    const user = JSON.parse(userRaw);
    if (!user?.id) return null;

    return { user };
  } catch {
    return null;
  }
}

function prepareStatements(db) {
  return {
    upsertLead: db.prepare(
      `INSERT INTO leads (email, utm_source, utm_medium, utm_campaign, utm_content, utm_term, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET
         utm_source = excluded.utm_source,
         utm_medium = excluded.utm_medium,
         utm_campaign = excluded.utm_campaign,
         utm_content = excluded.utm_content,
         utm_term = excluded.utm_term`
    ),

    getUserByTelegramId: db.prepare('SELECT * FROM users WHERE telegram_id = ?'),
    getUserById: db.prepare('SELECT * FROM users WHERE id = ?'),

    insertAnalyticsEvent: db.prepare(
      'INSERT INTO analytics_events (user_id, event, meta, created_at) VALUES (?, ?, ?, ?)'
    ),

    createUserMinimal: db.prepare(
      'INSERT INTO users (telegram_id, created_at) VALUES (?, ?)'
    ),

    getHabits: db.prepare(
      'SELECT id, title, icon, color, sort_order, active FROM habits WHERE user_id = ? AND active = 1 ORDER BY sort_order, id'
    ),

    getHabitById: db.prepare(
      'SELECT id, title, icon, color, sort_order, active FROM habits WHERE id = ? AND user_id = ?'
    ),

    getMaxSortOrder: db.prepare(
      'SELECT MAX(sort_order) as max FROM habits WHERE user_id = ?'
    ),

    createHabit: db.prepare(
      'INSERT INTO habits (user_id, title, icon, color, sort_order, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)'
    ),

    updateHabitTitle: db.prepare(
      'UPDATE habits SET title = ? WHERE id = ? AND user_id = ?'
    ),

    updateHabitActive: db.prepare(
      'UPDATE habits SET active = ? WHERE id = ? AND user_id = ?'
    ),

    updateHabitSortOrder: db.prepare(
      'UPDATE habits SET sort_order = ? WHERE id = ? AND user_id = ?'
    ),

    updateHabitIcon: db.prepare(
      'UPDATE habits SET icon = ? WHERE id = ? AND user_id = ?'
    ),

    updateHabitColor: db.prepare(
      'UPDATE habits SET color = ? WHERE id = ? AND user_id = ?'
    ),

    deleteHabit: db.prepare(
      'DELETE FROM habits WHERE id = ? AND user_id = ?'
    ),

    upsertCheckin: db.prepare(
      `INSERT INTO checkins (user_id, habit_id, date, status, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, habit_id, date) DO UPDATE SET status = excluded.status`
    ),

    getCheckinsForDate: db.prepare(
      'SELECT habit_id, status FROM checkins WHERE user_id = ? AND date = ?'
    ),

    getCheckinStatusForDate: db.prepare(
      'SELECT status FROM checkins WHERE user_id = ? AND habit_id = ? AND date = ?'
    ),

    getCheckinsForHabit: db.prepare(
      'SELECT date, status FROM checkins WHERE user_id = ? AND habit_id = ?'
    ),

    getCheckinsForRange: db.prepare(
      'SELECT date, habit_id, status FROM checkins WHERE user_id = ? AND date BETWEEN ? AND ?'
    ),

    deleteCheckinForDate: db.prepare(
      'DELETE FROM checkins WHERE user_id = ? AND habit_id = ? AND date = ?'
    ),

    deleteCheckinsForHabit: db.prepare(
      'DELETE FROM checkins WHERE user_id = ? AND habit_id = ?'
    ),

    deleteCheckinsForUser: db.prepare(
      'DELETE FROM checkins WHERE user_id = ?'
    ),

    deleteHabitsForUser: db.prepare(
      'DELETE FROM habits WHERE user_id = ?'
    ),

    incrementUserXp: db.prepare(
      `UPDATE users
       SET xp = COALESCE(xp, 0) + ?,
           level = CAST((COALESCE(xp, 0) + ?) / 100 AS INT) + 1,
           hero_coins = COALESCE(hero_coins, 0) + ?
       WHERE id = ?`
    ),

    resetUserXp: db.prepare(
      `UPDATE users
       SET xp = 0,
           level = 1,
           hero_coins = 0,
           streak_shield_count = 0,
           streak_shield_last_used = NULL
       WHERE id = ?`
    ),

    updateUserTimezone: db.prepare(
      'UPDATE users SET timezone = ? WHERE id = ?'
    ),

    updateUserReminderTime: db.prepare(
      'UPDATE users SET reminder_time = ? WHERE id = ?'
    ),

    updateUserSocialShame: db.prepare(
      'UPDATE users SET social_shame = ? WHERE id = ?'
    ),

    updateUserSocialShamePartner: db.prepare(
      'UPDATE users SET social_shame_partner_username = ? WHERE id = ?'
    ),

    updateUserVacationMode: db.prepare(
      'UPDATE users SET vacation_mode = ? WHERE id = ?'
    ),

    updateUserLanguage: db.prepare(
      'UPDATE users SET language_code = ? WHERE id = ?'
    ),

    updateUserActiveTheme: db.prepare(
      'UPDATE users SET active_theme = ? WHERE id = ?'
    ),

    incrementStreakShield: db.prepare(
      `UPDATE users
       SET streak_shield_count = COALESCE(streak_shield_count, 0) + ?
       WHERE id = ?`
    ),

    decrementStreakShield: db.prepare(
      `UPDATE users
       SET streak_shield_count = CASE
         WHEN COALESCE(streak_shield_count, 0) > 0 THEN COALESCE(streak_shield_count, 0) - 1
         ELSE 0
       END
       WHERE id = ?`
    ),

    updateStreakShieldLastUsed: db.prepare(
      'UPDATE users SET streak_shield_last_used = ? WHERE id = ?'
    ),

    spendHeroCoins: db.prepare(
      `UPDATE users
       SET hero_coins = COALESCE(hero_coins, 0) - ?
       WHERE id = ?`
    ),

    getActiveHabitsCount: db.prepare(
      'SELECT COUNT(*) as count FROM habits WHERE user_id = ? AND active = 1'
    ),

    getCheckinsDoneForRange: db.prepare(
      `SELECT COUNT(*) as count
       FROM checkins
       WHERE user_id = ? AND date BETWEEN ? AND ? AND status = 'done'`
    ),

    getUserBadges: db.prepare(
      'SELECT badge FROM user_badges WHERE user_id = ?'
    ),

    awardBadge: db.prepare(
      `INSERT OR IGNORE INTO user_badges (user_id, badge, awarded_at)
       VALUES (?, ?, ?)`
    ),

    getActiveDuelBetween: db.prepare(
      `SELECT * FROM duels
       WHERE status = 'active'
         AND ((challenger_id = ? AND opponent_id = ?) OR (challenger_id = ? AND opponent_id = ?))
       LIMIT 1`
    ),

    createDuel: db.prepare(
      `INSERT INTO duels (challenger_id, opponent_id, start_date, end_date, status, created_at)
       VALUES (?, ?, ?, ?, 'active', ?)`
    ),

    getDueDuels: db.prepare(
      `SELECT * FROM duels
       WHERE status = 'active' AND end_date < ?`
    ),

    resolveDuel: db.prepare(
      `UPDATE duels
       SET status = ?, winner_id = ?, resolved_at = ?
       WHERE id = ?`
    ),

    createGuild: db.prepare(
      `INSERT INTO guilds (name, owner_user_id, created_at)
       VALUES (?, ?, ?)`
    ),

    addGuildMember: db.prepare(
      `INSERT INTO guild_members (guild_id, user_id, joined_at)
       VALUES (?, ?, ?)`
    ),

    getGuildByUser: db.prepare(
      `SELECT g.id, g.name, g.owner_user_id, g.created_at
       FROM guilds g
       INNER JOIN guild_members m ON m.guild_id = g.id
       WHERE m.user_id = ?`
    ),

    getGuildById: db.prepare(
      'SELECT id, name, owner_user_id, created_at FROM guilds WHERE id = ?'
    ),

    getGuildMembers: db.prepare(
      `SELECT u.id, u.xp, u.level
       FROM guild_members m
       INNER JOIN users u ON u.id = m.user_id
       WHERE m.guild_id = ?
       ORDER BY COALESCE(u.xp, 0) DESC, u.id ASC
       LIMIT 10`
    ),

    getGuildPower: db.prepare(
      `SELECT SUM(COALESCE(u.xp, 0)) as power
       FROM guild_members m
       INNER JOIN users u ON u.id = m.user_id
       WHERE m.guild_id = ?`
    ),

    clearReferralBonusPending: db.prepare(
      'UPDATE users SET referral_bonus_pending = 0 WHERE id = ?'
    ),

    getLeaderboardTop: db.prepare(
      'SELECT id, xp, level FROM users ORDER BY COALESCE(xp, 0) DESC, id ASC LIMIT 10'
    ),

    getUserRank: db.prepare(
      `SELECT COUNT(*) + 1 as rank
       FROM users
       WHERE (COALESCE(xp, 0) > ?)
          OR (COALESCE(xp, 0) = ? AND id < ?)`
    ),

    getMonitorByUserId: db.prepare(
      `SELECT user_id, monitor_telegram_id, monitor_username, monitor_name,
              enabled, last_notified_date, last_kick_date
       FROM monitors WHERE user_id = ?`
    ),

    disableMonitor: db.prepare(
      'UPDATE monitors SET enabled = 0 WHERE user_id = ?'
    ),

    updateMonitorNotifiedDate: db.prepare(
      'UPDATE monitors SET last_notified_date = ? WHERE user_id = ?'
    ),

    getHeatmapRows: db.prepare(
      `WITH RECURSIVE days(d) AS (
        SELECT date(:to)
        UNION ALL
        SELECT date(d, '-1 day') FROM days WHERE d > date(:from)
      ),
      habit_totals AS (
        SELECT
          days.d AS day,
          COUNT(h.id) AS total
        FROM days
        LEFT JOIN habits h
          ON h.user_id = :userId
         AND h.active = 1
         AND date(h.created_at) <= days.d
        GROUP BY days.d
      ),
      done_counts AS (
        SELECT
          c.date AS day,
          COUNT(*) AS done
        FROM checkins c
        WHERE c.user_id = :userId
          AND c.status = 'done'
          AND c.date BETWEEN :from AND :to
        GROUP BY c.date
      )
      SELECT
        days.d AS day,
        COALESCE(done_counts.done, 0) AS done,
        COALESCE(habit_totals.total, 0) AS total
      FROM days
      LEFT JOIN habit_totals ON habit_totals.day = days.d
      LEFT JOIN done_counts ON done_counts.day = days.d
      ORDER BY days.d ASC;`
    ),
  };
}

module.exports = {
  createApp,
  startApp,
};
