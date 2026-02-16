const TelegramBot = require('node-telegram-bot-api');
const crypto = require('crypto');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const {
  calculateCurrentStreak,
  calculateSevenDayCompletion,
} = require('./services/streak');
const texts = require('./texts');

dayjs.extend(utc);
dayjs.extend(timezone);

const DEFAULT_TIMEZONE = 'Europe/Prague';
const DEFAULT_REMINDER_TIME = '20:00';
const REFERRAL_XP_BONUS = 50;
const HERO_COINS_PER_100_XP = 10;

// URL WebApp. ВАЖЛИВО: HTTPS
const FORCE_WEBAPP_VERSION = 'FORCE_RELOAD_1';
const WEBAPP_VERSION = process.env.WEBAPP_VERSION
  ? `${process.env.WEBAPP_VERSION}-${FORCE_WEBAPP_VERSION}`
  : FORCE_WEBAPP_VERSION;

function withWebAppVersion(url) {
  if (!url) return url;
  if (!WEBAPP_VERSION) return url;
  try {
    const parsed = new URL(url);
    parsed.searchParams.set('v', WEBAPP_VERSION);
    return parsed.toString();
  } catch (err) {
    const hasQuery = url.includes('?');
    const hasVersion = /[?&]v=/.test(url);
    if (hasVersion) {
      return url.replace(/([?&]v=)[^&]*/, `$1${WEBAPP_VERSION}`);
    }
    return `${url}${hasQuery ? '&' : '?'}v=${WEBAPP_VERSION}`;
  }
}

const WEBAPP_URL = withWebAppVersion(
  process.env.WEBAPP_URL || 'https://habitsystem.cz/app/'
);

function startBot(db) {
  const token = process.env.BOT_TOKEN;
  if (!token) throw new Error('BOT_TOKEN is required');

  const bot = new TelegramBot(token, { polling: true });
  const statements = prepareStatements(db);

  const LAZY_UNDO_TTL_MS = 5 * 60 * 1000;
  const analyticsLast = new Map();

  function getTodayKey(timezoneName) {
    return getUserNow(timezoneName).format('YYYY-MM-DD');
  }

  function ensureUserAndHabits(telegramId) {
    let user = statements.getUser.get(telegramId);
    if (!user) {
      const createdAt = new Date().toISOString();
      statements.createUser.run(
        telegramId,
        DEFAULT_TIMEZONE,
        DEFAULT_REMINDER_TIME,
        createdAt
      );
      user = statements.getUser.get(telegramId);
    }

    if (!user.timezone) {
      statements.updateTimezone.run(DEFAULT_TIMEZONE, user.id);
      user = { ...user, timezone: DEFAULT_TIMEZONE };
    }

    if (!user.reminder_time) {
      statements.updateReminderTime.run(DEFAULT_REMINDER_TIME, user.id);
      user = { ...user, reminder_time: DEFAULT_REMINDER_TIME };
    }

    const habits = statements.getHabits.all(user.id);

    return { user, habits };
  }

  const XP_PER_CHECKIN = 10;

  function calculateHeroCoinsDelta(beforeXp, xpDelta) {
    const start = Math.floor((Number(beforeXp) || 0) / 100) * HERO_COINS_PER_100_XP;
    const end = Math.floor((Number(beforeXp) + Number(xpDelta || 0)) / 100) * HERO_COINS_PER_100_XP;
    return Math.max(0, end - start);
  }

  function awardXpAndCoins(userId, xpDelta) {
    const before = statements.getUserById.get(userId);
    const beforeXp = before?.xp ?? 0;
    const coinsDelta = calculateHeroCoinsDelta(beforeXp, xpDelta);
    statements.incrementUserXp.run(xpDelta, xpDelta, coinsDelta, userId);
  }

  function saveHabitStatus(userId, habitId, status, date) {
    const createdAt = new Date().toISOString();
    const previous = statements.getCheckinStatusForDate.get(userId, habitId, date);
    statements.upsertCheckin.run(userId, habitId, date, status, createdAt);
    if (status === 'done' && previous?.status !== 'done') {
      awardXpAndCoins(userId, XP_PER_CHECKIN);
    }
    return date;
  }

  function getTodayStatusMap(userId, date) {
    const rows = statements.getCheckinsForDate.all(userId, date);
    const map = new Map();
    for (const row of rows) map.set(row.habit_id, row.status);
    return map;
  }

  function createUndoToken(payload) {
    const token = `${payload.userId}_${Date.now().toString(36)}_${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const expiresAt = new Date(Date.now() + LAZY_UNDO_TTL_MS).toISOString();
    const storedPayload = JSON.stringify({
      userId: payload.userId,
      date: payload.date,
      previous: Array.from(payload.previous.entries()),
    });
    statements.createLazyUndoToken.run(token, payload.userId, storedPayload, expiresAt);
    return token;
  }

  function getUndoPayload(token) {
    const row = statements.getLazyUndoToken.get(token);
    if (!row) return null;
    const expiresAt = Date.parse(row.expires_at);
    if (!Number.isNaN(expiresAt) && Date.now() > expiresAt) {
      statements.deleteLazyUndoToken.run(token);
      return null;
    }
    try {
      const parsed = JSON.parse(row.payload);
      return {
        userId: row.user_id,
        date: parsed.date,
        previous: new Map(parsed.previous || []),
      };
    } catch {
      statements.deleteLazyUndoToken.run(token);
      return null;
    }
  }

  function clearUndoPayload(token) {
    statements.deleteLazyUndoToken.run(token);
  }

  function buildFocusMessage(habits, statusMap) {
    const lines = [texts.focusTitle];

    for (const habit of habits) {
      const status = statusMap.get(habit.id);
      if (status === 'done') lines.push(texts.habitDone(habit.title));
      else if (status === 'skip') lines.push(texts.habitSkip(habit.title));
      else lines.push(texts.habitPending(habit.title));
    }

    const keyboard = habits.map((habit) => {
      const status = statusMap.get(habit.id);

      if (status === 'done') {
        return [{ text: texts.buttonDoneState, callback_data: `noop:${habit.id}` }];
      }
      if (status === 'skip') {
        return [{ text: texts.buttonSkipState, callback_data: `noop:${habit.id}` }];
      }

      return [
        { text: texts.buttonDone, callback_data: `habit:${habit.id}:done` },
        { text: texts.buttonSkip, callback_data: `habit:${habit.id}:skip` },
      ];
    });

    // ✅ Додаємо рядок з WebApp кнопкою під фокусом (дуже зручно)
    keyboard.push([{ text: '⚙️ Dashboard (WebApp)', web_app: { url: WEBAPP_URL } }]);

    return {
      text: lines.join('\n'),
      reply_markup: { inline_keyboard: keyboard },
    };
  }

  function buildLazySuccessMessage(chatId, messageId, message, undoToken) {
    return bot.editMessageText(message, {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: {
        inline_keyboard: [[{ text: texts.lazyUndoButton, callback_data: `lazy_undo:${undoToken}` }]],
      },
    });
  }

  function buildLazyUndoneMessage(chatId, messageId) {
    return bot.editMessageText(texts.lazyUndone, {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [] },
    });
  }

  function clearLazyButtons(chatId, messageId) {
    return bot.editMessageReplyMarkup(
      { inline_keyboard: [] },
      {
        chat_id: chatId,
        message_id: messageId,
      }
    );
  }

  function applyStatusForHabits({ userId, habits, status, date, statusMap }) {
    const createdAt = new Date().toISOString();
    const previous = new Map();
    for (const habit of habits) {
      const prevStatus = statusMap.get(habit.id) || null;
      previous.set(habit.id, prevStatus);
      statements.upsertCheckin.run(userId, habit.id, date, status, createdAt);
      if (status === 'done' && prevStatus !== 'done') {
        awardXpAndCoins(userId, XP_PER_CHECKIN);
      }
    }
    return previous;
  }

  function restoreStatuses({ userId, date, previous }) {
    for (const [habitId, status] of previous.entries()) {
      if (!status) {
        statements.deleteCheckinForDate.run(userId, habitId, date);
      } else {
        const createdAt = new Date().toISOString();
        statements.upsertCheckin.run(userId, habitId, date, status, createdAt);
      }
    }
  }

  function recordAnalyticsEvent(userId, event, meta = null) {
    if (!userId) return;
    const now = Date.now();
    const key = `${userId}:${event}`;
    const last = analyticsLast.get(key) || 0;
    if (now - last < 2000) return;
    analyticsLast.set(key, now);
    let payload = null;
    if (meta && typeof meta === 'object') {
      try {
        payload = JSON.stringify(meta);
      } catch {
        payload = null;
      }
    }
    statements.insertAnalyticsEvent.run(
      userId,
      event,
      payload,
      new Date().toISOString()
    );
  }

  function updateFocusMessage(chatId, messageId, user) {
    const habits = statements.getHabits.all(user.id);
    const date = getTodayKey(user.timezone);
    const statusMap = getTodayStatusMap(user.id, date);
    const payload = buildFocusMessage(habits, statusMap);

    return bot.editMessageText(payload.text, {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: payload.reply_markup,
    });
  }

  // ✅ окрема функція для "відкрити WebApp" — однакова для /start і /app
  function sendStartMessage(chatId, telegramId) {
    ensureUserAndHabits(telegramId);

    return bot.sendMessage(chatId, texts.welcome, {
      reply_markup: {
        inline_keyboard: [
          // ВАЖЛИВО: WebApp button — саме через web_app
          [{ text: '⚙️ Dashboard (WebApp)', web_app: { url: WEBAPP_URL } }],
          [{ text: texts.startDayButton, callback_data: 'start_day' }],
        ],
      },
    });
  }

  function getUserNow(timezoneName) {
    const tz = timezoneName || DEFAULT_TIMEZONE;
    try {
      return dayjs().tz(tz);
    } catch {
      return dayjs().tz(DEFAULT_TIMEZONE);
    }
  }

  function handleInviteRequest(chatId, telegramId, payload) {
    const rawId = payload.replace('invite_monitor_', '');
    const userId = Number(rawId);
    if (!userId) {
      bot.sendMessage(chatId, texts.inviteInvalid);
      return;
    }

    const invitedUser = statements.getUserById.get(userId);
    if (!invitedUser) {
      bot.sendMessage(chatId, texts.inviteInvalid);
      return;
    }

    if (invitedUser.telegram_id === telegramId) {
      bot.sendMessage(chatId, texts.inviteSelf);
      return;
    }

    const existing = statements.getMonitorByUserId.get(userId);
    if (existing && existing.enabled) {
      bot.sendMessage(chatId, texts.inviteAlreadyConnected);
      return;
    }

    bot.sendMessage(chatId, texts.inviteConsent, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: texts.inviteAccept, callback_data: `monitor_accept:${userId}` },
            { text: texts.inviteDecline, callback_data: `monitor_decline:${userId}` },
          ],
        ],
      },
    });
  }

  function normalizeStartPayload(payload) {
    if (!payload) return '';
    if (payload.startsWith('ref=')) return payload.slice(4);
    if (payload.startsWith('ref_')) return payload.slice(4);
    return payload;
  }

  async function resolveUserLabel(invitedUser) {
    const fallback = invitedUser?.telegram_id
      ? `User ${invitedUser.telegram_id}`
      : `User ${invitedUser?.id || ''}`.trim();
    if (!invitedUser?.telegram_id) return fallback;
    try {
      const chat = await bot.getChat(invitedUser.telegram_id);
      const name = [chat?.first_name, chat?.last_name].filter(Boolean).join(' ').trim();
      if (name) return name;
      if (chat?.username) return `@${chat.username}`;
    } catch {}
    return fallback;
  }

  async function handlePartnerHandshake(msg, payload) {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;
    const rawId = payload.replace(/^invite_/, '');
    const userId = Number(rawId);
    if (!userId) {
      bot.sendMessage(chatId, texts.inviteInvalid);
      return;
    }

    const invitedUser = statements.getUserById.get(userId);
    if (!invitedUser) {
      bot.sendMessage(chatId, texts.inviteInvalid);
      return;
    }

    if (invitedUser.telegram_id === telegramId) {
      bot.sendMessage(chatId, texts.inviteSelf);
      return;
    }

    const monitorName = [msg.from?.first_name, msg.from?.last_name]
      .filter(Boolean)
      .join(' ')
      .trim();
    const monitorUsername = msg.from?.username ? `@${msg.from.username}` : null;
    const createdAt = new Date().toISOString();

    statements.upsertMonitor.run(userId, telegramId, monitorUsername, monitorName || null, createdAt);
    statements.updatePartnerId.run(chatId, userId);

    const userLabel = await resolveUserLabel(invitedUser);
    bot.sendMessage(
      chatId,
      `Вітаємо! Тепер ти — Вартовий для ${userLabel}. Якщо вони зхалтурять, ми тобі напишемо. Будь суворим! ⚔️`
    );

    if (invitedUser.telegram_id) {
      bot.sendMessage(invitedUser.telegram_id, texts.monitorConnected);
    }
  }

  function createReferralToken(inviterUserId) {
    const token = crypto.randomBytes(16).toString('hex');
    const createdAt = new Date().toISOString();
    statements.createReferralToken.run(token, inviterUserId, createdAt);
    return token;
  }

  function buildReferralLink(token) {
    const username = process.env.TELEGRAM_BOT_USERNAME;
    if (!username) return null;
    return `https://t.me/${username}?start=ref_${token}`;
  }

  function grantTrial(inviterUserId, days = 7) {
    const inviter = statements.getUserById.get(inviterUserId);
    if (!inviter) return null;

    const now = dayjs();
    let base = now;
    if (inviter.trial_until) {
      const parsed = dayjs(inviter.trial_until);
      if (parsed.isValid() && parsed.isAfter(now)) {
        base = parsed;
      }
    }
    const next = base.add(days, 'day');
    statements.updateTrialUntil.run(next.toISOString(), inviterUserId);
    return next.format('YYYY-MM-DD');
  }

  function sendPremiumInvite(chatId, telegramId) {
    const { user } = ensureUserAndHabits(telegramId);
    const username = process.env.TELEGRAM_BOT_USERNAME;
    if (!username) {
      bot.sendMessage(chatId, texts.referralBotMissing);
      return;
    }

    const link = buildReferralLink(createReferralToken(user.id));
    if (!link) {
      bot.sendMessage(chatId, texts.referralBotMissing);
      return;
    }

    bot.sendMessage(chatId, texts.referralInviteMessage(link), {
      reply_markup: {
        inline_keyboard: [[{ text: texts.referralInviteButton, url: link }]],
      },
      disable_web_page_preview: true,
    });
  }

  function handleReferralStart(chatId, telegramId, payload) {
    const raw = payload.replace('ref_', '').trim();
    if (!raw) {
      bot.sendMessage(chatId, texts.referralInvalid);
      return;
    }

    if (/^\d+$/.test(raw)) {
      const inviterId = Number(raw);
      const inviter = statements.getUserById.get(inviterId);
      if (!inviter) {
        bot.sendMessage(chatId, texts.referralInvalid);
        return;
      }
      const { user: friend } = ensureUserAndHabits(telegramId);
      if (friend.id === inviter.id) {
        bot.sendMessage(chatId, texts.referralSelf);
        return;
      }
      if (friend.referred_by_user_id) {
        bot.sendMessage(chatId, texts.referralAlreadyUsed);
        sendStartMessage(chatId, telegramId);
        return;
      }
      statements.setReferredBy.run(inviter.id, friend.id);
      awardXpAndCoins(inviter.id, REFERRAL_XP_BONUS);
      awardXpAndCoins(friend.id, REFERRAL_XP_BONUS);
      statements.incrementReferralBonusPending.run(REFERRAL_XP_BONUS, inviter.id);
      statements.incrementReferralBonusPending.run(REFERRAL_XP_BONUS, friend.id);

      bot.sendMessage(chatId, texts.referralFriendBonus, {
        reply_markup: {
          inline_keyboard: [[{ text: '⚙️ Dashboard (WebApp)', web_app: { url: WEBAPP_URL } }]],
        },
      });
      if (inviter.telegram_id) {
        bot.sendMessage(inviter.telegram_id, texts.referralInviterBonus);
      }
      sendStartMessage(chatId, telegramId);
      return;
    }

    const token = raw;
    const ref = statements.getReferralToken.get(token);
    if (!ref) {
      bot.sendMessage(chatId, texts.referralInvalid);
      return;
    }

    if (ref.used_by_user_id) {
      bot.sendMessage(chatId, texts.referralUsed);
      return;
    }

    const inviter = statements.getUserById.get(ref.inviter_user_id);
    if (!inviter) {
      bot.sendMessage(chatId, texts.referralInvalid);
      return;
    }

    const { user: friend } = ensureUserAndHabits(telegramId);
    if (friend.id === inviter.id) {
      bot.sendMessage(chatId, texts.referralSelf);
      return;
    }

    if (friend.referred_by_user_id) {
      bot.sendMessage(chatId, texts.referralAlreadyUsed);
      sendStartMessage(chatId, telegramId);
      return;
    }

    const usedAt = new Date().toISOString();
    const used = statements.useReferralToken.run(friend.id, usedAt, token);
    if (used.changes === 0) {
      bot.sendMessage(chatId, texts.referralUsed);
      return;
    }

    statements.setReferredBy.run(inviter.id, friend.id);
    const untilDate = grantTrial(inviter.id) || '';

    bot.sendMessage(chatId, texts.referralFriendWelcome, {
      reply_markup: {
        inline_keyboard: [[{ text: '⚙️ Dashboard (WebApp)', web_app: { url: WEBAPP_URL } }]],
      },
    });
    if (inviter.telegram_id) {
      bot.sendMessage(inviter.telegram_id, texts.referralInviterSuccess(untilDate));
    }

    sendStartMessage(chatId, telegramId);
  }

  // /start + invite deep link
  bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;
    const rawPayload = match && match[1] ? match[1].trim() : '';
    const payload = normalizeStartPayload(rawPayload);

    if (payload.startsWith('invite_monitor_')) {
      handleInviteRequest(chatId, telegramId, payload);
      return;
    }

    if (payload.startsWith('invite_')) {
      await handlePartnerHandshake(msg, payload);
      return;
    }

    if (payload === 'premium_interest') {
      bot.sendMessage(chatId, texts.premiumInterestMessage, {
        reply_markup: {
          inline_keyboard: [[{ text: '⚙️ Відкрити Habit System', web_app: { url: WEBAPP_URL } }]],
        },
      });
      return;
    }

    if (payload === 'premium') {
      sendPremiumInvite(chatId, telegramId);
      return;
    }

    if (payload.startsWith('ref_')) {
      handleReferralStart(chatId, telegramId, payload);
      return;
    }

    sendStartMessage(chatId, telegramId);
  });

  bot.onText(/\/premium/, (msg) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;
    sendPremiumInvite(chatId, telegramId);
  });

  // ✅ /app — завжди відкриває WebApp правильно (дуже корисно на iOS)
  bot.onText(/\/app/, (msg) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;
    ensureUserAndHabits(telegramId);

    bot.sendMessage(chatId, 'Відкриваю Dashboard 👇', {
      reply_markup: {
        inline_keyboard: [[{ text: '⚙️ Open Dashboard', web_app: { url: WEBAPP_URL } }]],
      },
    });
  });

  // /time
  bot.onText(/\/time(?:\s+([0-9]{2}:[0-9]{2}))?/, (msg, match) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;
    const timeValue = match && match[1] ? match[1].trim() : '';

    const parsed = parseTime(timeValue);
    if (!parsed) return bot.sendMessage(chatId, texts.timePrompt);

    const { user } = ensureUserAndHabits(telegramId);
    statements.updateReminderTime.run(parsed, user.id);
    bot.sendMessage(chatId, texts.timeSet(parsed));
  });

  // /tz
  bot.onText(/\/tz(?:\s+(.+))?/, (msg, match) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;
    const tzValue = match && match[1] ? match[1].trim() : '';
    if (!tzValue) return bot.sendMessage(chatId, texts.tzPrompt);

    const { user } = ensureUserAndHabits(telegramId);
    statements.updateTimezone.run(tzValue, user.id);
    bot.sendMessage(chatId, texts.tzSet(tzValue));
  });

  // /unlink partner
  bot.onText(/\/unlink/, (msg) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;
    const user = statements.getUser.get(telegramId);
    if (!user) {
      bot.sendMessage(chatId, texts.monitorUnlinked);
      return;
    }
    statements.disableMonitor.run(user.id);
    bot.sendMessage(chatId, texts.monitorUnlinked);
  });

  // callbacks
  bot.on('callback_query', (query) => {
    const data = query.data || '';
    const chatId = query.message?.chat?.id;
    const messageId = query.message?.message_id;
    const telegramId = query.from?.id;

    if (!chatId || !messageId || !telegramId) {
      bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('monitor_accept:')) {
      const userId = Number(data.split(':')[1]);
      const invitedUser = statements.getUserById.get(userId);
      if (!invitedUser) {
        bot.answerCallbackQuery(query.id, { text: texts.inviteInvalid });
        return;
      }
      if (invitedUser.telegram_id === telegramId) {
        bot.answerCallbackQuery(query.id, { text: texts.inviteSelf });
        return;
      }

      const existing = statements.getMonitorByUserId.get(userId);
      if (existing && existing.enabled) {
        bot.answerCallbackQuery(query.id, { text: texts.inviteAlreadyConnected });
        return;
      }

      const createdAt = new Date().toISOString();
      const monitorName = [query.from?.first_name, query.from?.last_name]
        .filter(Boolean)
        .join(' ')
        .trim();
      const monitorUsername = query.from?.username ? `@${query.from.username}` : null;
      statements.upsertMonitor.run(userId, telegramId, monitorUsername, monitorName, createdAt);

      bot.answerCallbackQuery(query.id, { text: texts.inviteAccepted });
      bot.sendMessage(chatId, texts.inviteAccepted);
      bot.sendMessage(invitedUser.telegram_id, texts.monitorConnected);
      return;
    }

    if (data.startsWith('monitor_decline:')) {
      bot.answerCallbackQuery(query.id, { text: texts.inviteDeclined });
      bot.sendMessage(chatId, texts.inviteDeclined);
      return;
    }

    if (data.startsWith('kick:')) {
      const userId = Number(data.split(':')[1]);
      const monitor = statements.getMonitorByUserId.get(userId);
      const invitedUser = statements.getUserById.get(userId);

      if (!monitor || !invitedUser || !monitor.enabled) {
        bot.answerCallbackQuery(query.id);
        return;
      }
      if (monitor.monitor_telegram_id !== telegramId) {
        bot.answerCallbackQuery(query.id);
        return;
      }

      const today = getUserNow(invitedUser.timezone).format('YYYY-MM-DD');
      if (monitor.last_kick_date === today) {
        bot.answerCallbackQuery(query.id, { text: texts.kickAlready });
        return;
      }

      const habitCount = statements.getActiveHabitsCount.get(userId).count || 0;
      const checkinsCount =
        statements.getCheckinsCountForDate.get(userId, today).count || 0;

      if (habitCount === 0 || checkinsCount >= habitCount) {
        bot.answerCallbackQuery(query.id, { text: texts.kickNotNeeded });
        return;
      }

      statements.updateMonitorKickDate.run(today, userId);
      bot.sendMessage(invitedUser.telegram_id, texts.kickUserMessage, {
        reply_markup: {
          inline_keyboard: [[{ text: 'Відкрити Habit System', web_app: { url: WEBAPP_URL } }]],
        },
      });
      recordAnalyticsEvent(userId, 'accountability_kick_sent', { source: 'monitor' });
      bot.answerCallbackQuery(query.id, { text: texts.kickSent });
      return;
    }

    if (data.startsWith('lazy_')) {
      const { user } = ensureUserAndHabits(telegramId);
      const date = getTodayKey(user.timezone);
      const habits = statements.getHabits.all(user.id);
      const statusMap = getTodayStatusMap(user.id, date);
      const markedCount = habits.filter((habit) => statusMap.has(habit.id)).length;

      if (data.startsWith('lazy_undo:')) {
        const token = data.split(':')[1];
        const payload = getUndoPayload(token);
        if (!payload || payload.userId !== user.id) {
          bot.answerCallbackQuery(query.id, { text: texts.lazyUndoExpired });
          clearLazyButtons(chatId, messageId);
          return;
        }

        restoreStatuses({ userId: payload.userId, date: payload.date, previous: payload.previous });
        clearUndoPayload(token);
        bot.answerCallbackQuery(query.id, { text: texts.lazyUndone });
        buildLazyUndoneMessage(chatId, messageId);
        return;
      }

      if (!habits || habits.length === 0) {
        bot.answerCallbackQuery(query.id, { text: texts.lazyNoHabits });
        return;
      }

      if (data === 'lazy_done_routine' || data === 'lazy_skip_routine') {
        if (markedCount >= habits.length) {
          bot.answerCallbackQuery(query.id, { text: texts.lazyAlready });
          return;
        }

        const status = data === 'lazy_done_routine' ? 'done' : 'skip';
        const previous = applyStatusForHabits({
          userId: user.id,
          habits,
          status,
          date,
          statusMap,
        });
        const undoToken = createUndoToken({
          userId: user.id,
          date,
          previous,
        });

        bot.answerCallbackQuery(query.id, { text: texts.saved });
        const message =
          status === 'done' ? texts.lazySuccess : texts.lazySkipMessage || texts.lazySuccess;
        buildLazySuccessMessage(chatId, messageId, message, undoToken);
        recordAnalyticsEvent(user.id, 'lazy_entry_used', {
          scope: 'routine',
          status,
        });
        return;
      }

      if (data.startsWith('lazy_done_habit_') || data.startsWith('lazy_skip_habit_')) {
        const status = data.startsWith('lazy_done_habit_') ? 'done' : 'skip';
        const habitId = Number(data.split('_').pop());
        const habit = habits.find((item) => item.id === habitId);
        if (!habit) {
          bot.answerCallbackQuery(query.id);
          return;
        }
        if (statusMap.has(habitId)) {
          bot.answerCallbackQuery(query.id, { text: texts.lazyAlready });
          return;
        }

        const previous = applyStatusForHabits({
          userId: user.id,
          habits: [habit],
          status,
          date,
          statusMap,
        });
        const undoToken = createUndoToken({
          userId: user.id,
          date,
          previous,
        });

        bot.answerCallbackQuery(query.id, { text: texts.saved });
        const message =
          status === 'done' ? texts.lazySuccess : texts.lazySkipMessage || texts.lazySuccess;
        buildLazySuccessMessage(chatId, messageId, message, undoToken);
        recordAnalyticsEvent(user.id, 'lazy_entry_used', {
          scope: 'habit',
          status,
        });
        return;
      }
    }

    const { user } = ensureUserAndHabits(telegramId);

    if (data === 'start_day') {
      bot.answerCallbackQuery(query.id);
      updateFocusMessage(chatId, messageId, user);
      return;
    }

    if (data.startsWith('noop:')) {
      bot.answerCallbackQuery(query.id, { text: texts.alreadyMarkedShort });
      return;
    }

    if (!data.startsWith('habit:')) {
      bot.answerCallbackQuery(query.id);
      return;
    }

    const [, habitIdRaw, status] = data.split(':');
    const habitId = Number(habitIdRaw);

    if (!habitId || (status !== 'done' && status !== 'skip')) {
      bot.answerCallbackQuery(query.id);
      return;
    }

    const date = getTodayKey(user.timezone);
    const statusMap = getTodayStatusMap(user.id, date);
    if (statusMap.has(habitId)) {
      bot.answerCallbackQuery(query.id, { text: texts.alreadyMarked });
      return;
    }

    saveHabitStatus(user.id, habitId, status, date);
    bot.answerCallbackQuery(query.id, { text: texts.saved });

    updateFocusMessage(chatId, messageId, user);

    const updatedMap = getTodayStatusMap(user.id, date);
    const habits = statements.getHabits.all(user.id);
    const allMarked = habits.every((habit) => updatedMap.has(habit.id));
    if (allMarked) bot.sendMessage(chatId, texts.dayComplete);
  });

  // /stats
  bot.onText(/\/stats/, (msg) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;
    const { user, habits } = ensureUserAndHabits(telegramId);
    const now = getUserNow(user.timezone);

    const lines = habits.map((habit) => {
      const checkins = statements.getCheckinsForHabit.all(user.id, habit.id);
      const streak = calculateCurrentStreak(checkins, now);
      const completion = calculateSevenDayCompletion(checkins, now);
      return texts.statsItem(habit.title, streak, completion);
    });

    bot.sendMessage(chatId, [texts.statsHeader, ...lines].join('\n\n'));
  });

  bot.on('polling_error', (error) => {
    console.error('Bot polling error:', error.message);
  });

  return bot;
}

function parseTime(value) {
  if (!value) return null;
  const match = value.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) return null;
  return `${match[1]}:${match[2]}`;
}

function prepareStatements(db) {
  return {
    getUser: db.prepare('SELECT * FROM users WHERE telegram_id = ?'),
    getUserById: db.prepare('SELECT * FROM users WHERE id = ?'),
    createUser: db.prepare(
      'INSERT INTO users (telegram_id, timezone, reminder_time, created_at) VALUES (?, ?, ?, ?)'
    ),
    updateReminderTime: db.prepare('UPDATE users SET reminder_time = ? WHERE id = ?'),
    updateTimezone: db.prepare('UPDATE users SET timezone = ? WHERE id = ?'),
    updatePartnerId: db.prepare('UPDATE users SET partner_id = ? WHERE id = ?'),
    getMonitorByUserId: db.prepare(
      'SELECT user_id, monitor_telegram_id, enabled, last_kick_date FROM monitors WHERE user_id = ?'
    ),
    upsertMonitor: db.prepare(
      `INSERT INTO monitors (user_id, monitor_telegram_id, monitor_username, monitor_name, enabled, created_at)
       VALUES (?, ?, ?, ?, 1, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         monitor_telegram_id = excluded.monitor_telegram_id,
         monitor_username = excluded.monitor_username,
         monitor_name = excluded.monitor_name,
         enabled = 1`
    ),
    disableMonitor: db.prepare('UPDATE monitors SET enabled = 0 WHERE user_id = ?'),
    updateMonitorKickDate: db.prepare(
      'UPDATE monitors SET last_kick_date = ? WHERE user_id = ?'
    ),
    insertAnalyticsEvent: db.prepare(
      'INSERT INTO analytics_events (user_id, event, meta, created_at) VALUES (?, ?, ?, ?)'
    ),
    createReferralToken: db.prepare(
      'INSERT INTO referral_tokens (token, inviter_user_id, created_at) VALUES (?, ?, ?)'
    ),
    getReferralToken: db.prepare(
      'SELECT token, inviter_user_id, used_by_user_id, used_at FROM referral_tokens WHERE token = ?'
    ),
    useReferralToken: db.prepare(
      `UPDATE referral_tokens
       SET used_by_user_id = ?, used_at = ?
       WHERE token = ? AND used_by_user_id IS NULL`
    ),
    setReferredBy: db.prepare(
      'UPDATE users SET referred_by_user_id = ? WHERE id = ? AND referred_by_user_id IS NULL'
    ),
    updateTrialUntil: db.prepare('UPDATE users SET trial_until = ? WHERE id = ?'),
    getHabits: db.prepare(
      'SELECT * FROM habits WHERE user_id = ? AND active = 1 ORDER BY sort_order, id'
    ),
    createHabit: db.prepare(
      'INSERT INTO habits (user_id, title, icon, color, sort_order, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)'
    ),
    upsertCheckin: db.prepare(
      `INSERT INTO checkins (user_id, habit_id, date, status, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, habit_id, date) DO UPDATE SET status = excluded.status`
    ),
    getCheckinStatusForDate: db.prepare(
      'SELECT status FROM checkins WHERE user_id = ? AND habit_id = ? AND date = ?'
    ),
    getCheckinsForHabit: db.prepare(
      'SELECT date, status FROM checkins WHERE user_id = ? AND habit_id = ?'
    ),
    getCheckinsForDate: db.prepare(
      'SELECT habit_id, status FROM checkins WHERE user_id = ? AND date = ?'
    ),
    createLazyUndoToken: db.prepare(
      'INSERT INTO lazy_undo_tokens (token, user_id, payload, expires_at) VALUES (?, ?, ?, ?)'
    ),
    getLazyUndoToken: db.prepare(
      'SELECT token, user_id, payload, expires_at FROM lazy_undo_tokens WHERE token = ?'
    ),
    deleteLazyUndoToken: db.prepare('DELETE FROM lazy_undo_tokens WHERE token = ?'),
    deleteCheckinForDate: db.prepare(
      'DELETE FROM checkins WHERE user_id = ? AND habit_id = ? AND date = ?'
    ),
    getActiveHabitsCount: db.prepare(
      'SELECT COUNT(*) as count FROM habits WHERE user_id = ? AND active = 1'
    ),
    getCheckinsCountForDate: db.prepare(
      `SELECT COUNT(*) as count
       FROM checkins
       INNER JOIN habits ON habits.id = checkins.habit_id
       WHERE checkins.user_id = ? AND checkins.date = ? AND habits.active = 1`
    ),
    incrementUserXp: db.prepare(
      `UPDATE users
       SET xp = COALESCE(xp, 0) + ?,
           level = CAST((COALESCE(xp, 0) + ?) / 100 AS INT) + 1,
           hero_coins = COALESCE(hero_coins, 0) + ?
       WHERE id = ?`
    ),
    incrementReferralBonusPending: db.prepare(
      `UPDATE users
       SET referral_bonus_pending = COALESCE(referral_bonus_pending, 0) + ?
       WHERE id = ?`
    ),
  };
}

module.exports = { startBot };
