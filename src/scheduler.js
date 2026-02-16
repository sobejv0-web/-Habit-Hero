const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const cron = require('node-cron');

dayjs.extend(utc);
dayjs.extend(timezone);

const DEFAULT_REMINDER_TIME = '20:00';
const DEFAULT_TIMEZONE = 'Europe/Prague';
const PARTNER_CHECK_TIME = '21:00';
const SHAME_TIME = process.env.SHAME_TIME || '21:00';
const RETENTION_TIME = process.env.RETENTION_TIME || '18:00';
const MORNING_TIME = process.env.MORNING_PROMPT_TIME || '08:00';
const TRIAL_NUDGE_TIME = process.env.TRIAL_NUDGE_TIME || '12:00';
const ANALYTICS_SNAPSHOT_TIME = process.env.ANALYTICS_SNAPSHOT_TIME || '01:00';
const ANALYTICS_ENABLED = process.env.ANALYTICS_ENABLED !== 'false';
const FORCE_WEBAPP_VERSION = 'FORCE_RELOAD_1';
const WEBAPP_VERSION = process.env.WEBAPP_VERSION
  ? `${process.env.WEBAPP_VERSION}-${FORCE_WEBAPP_VERSION}`
  : FORCE_WEBAPP_VERSION;
const WEBAPP_URL_BASE = process.env.WEBAPP_URL || 'https://habitsystem.cz/app/';
const texts = require('./texts');

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

const WEBAPP_URL = withWebAppVersion(WEBAPP_URL_BASE);

function startScheduler({ db, bot, intervalMs = 60000 }) {
  const statements = prepareStatements(db);
  let lastCleanupAt = 0;

  const tick = () => {
    const nowUtc = Date.now();
    if (nowUtc - lastCleanupAt > 60 * 60 * 1000) {
      statements.deleteExpiredLazyUndoTokens.run(new Date().toISOString());
      lastCleanupAt = nowUtc;
    }

    const users = statements.getUsers.all();
    for (const user of users) {
      const now = getUserNow(user.timezone);
      const today = now.format('YYYY-MM-DD');
      const currentTime = now.format('HH:mm');
      const reminderTime = (user.reminder_time || DEFAULT_REMINDER_TIME).trim();
      const shameTime = reminderTime || SHAME_TIME;
      const reminderState = parseReminderState(user.last_reminded_date);
      const trialDaysLeft = getTrialDaysLeft(user.trial_until, now);

      if (currentTime === MORNING_TIME && reminderState.morning !== today) {
        const habits = statements.getHabits.all(user.id);
        if (!habits || habits.length === 0) {
          reminderState.morning = today;
          persistReminderState(statements, user.id, reminderState);
        } else {
          const statusMap = getStatusMap(
            statements.getCheckinsForDate.all(user.id, today)
          );
          if (statusMap.size >= habits.length) {
            reminderState.morning = today;
            persistReminderState(statements, user.id, reminderState);
          } else {
            const routineMode = habits.length > 1;
            const routineTitle = texts.morningRoutineTitle || 'Ранок ☀️';
            const stepsText = formatStepsText(habits.length);
            const lines = [texts.morningGreeting, '', texts.morningToday];
            const pendingHabit =
              habits.find((habit) => !statusMap.has(habit.id)) || habits[0];
            if (routineMode) {
              lines.push(texts.morningRoutineLine(routineTitle, stepsText));
            } else {
              lines.push(texts.morningHabitLine(pendingHabit.title));
            }
            lines.push('', texts.morningQuestion);

            const keyboard = routineMode
              ? [
                  [
                    {
                      text: texts.lazyRoutineDoneButton,
                      callback_data: 'lazy_done_routine',
                    },
                  ],
                  [
                    {
                      text: texts.lazyRoutineSkipButton,
                      callback_data: 'lazy_skip_routine',
                    },
                  ],
                ]
              : [
                  [
                    {
                      text: texts.lazyHabitDoneButton,
                      callback_data: `lazy_done_habit_${pendingHabit.id}`,
                    },
                    {
                      text: texts.lazyHabitSkipButton,
                      callback_data: `lazy_skip_habit_${pendingHabit.id}`,
                    },
                  ],
                ];

            bot.sendMessage(user.telegram_id, lines.join('\n'), {
              reply_markup: { inline_keyboard: keyboard },
            });

            reminderState.morning = today;
            persistReminderState(statements, user.id, reminderState);
          }
        }
      }

      if (
        currentTime === TRIAL_NUDGE_TIME &&
        trialDaysLeft !== null &&
        trialDaysLeft > 0 &&
        trialDaysLeft <= 2 &&
        reminderState.trialDay5 !== today
      ) {
        bot.sendMessage(user.telegram_id, texts.trialDay5Message, {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: texts.trialDay5Button,
                  web_app: { url: WEBAPP_URL },
                },
              ],
            ],
          },
        });

        reminderState.trialDay5 = today;
        persistReminderState(statements, user.id, reminderState);
      }

      if (currentTime === ANALYTICS_SNAPSHOT_TIME && reminderState.analyticsDaily !== today) {
        if (ANALYTICS_ENABLED) {
          const createdAt = new Date().toISOString();
          const meta = JSON.stringify({ date: today, source: 'scheduler' });

          const checkinsCount =
            statements.getCheckinsCountForDate.get(user.id, today).count || 0;
          if (checkinsCount > 0) {
            statements.insertAnalyticsEvent.run(user.id, 'daily_active_user', meta, createdAt);
          }

          if (trialDaysLeft !== null && trialDaysLeft > 0) {
            statements.insertAnalyticsEvent.run(user.id, 'trial_active_user', meta, createdAt);
          } else if (user.plan === 'premium') {
            statements.insertAnalyticsEvent.run(
              user.id,
              'premium_active_user',
              meta,
              createdAt
            );
          }

          reminderState.analyticsDaily = today;
          persistReminderState(statements, user.id, reminderState);
        }
      }

      if (currentTime === shameTime && reminderState.shame !== today) {
        if (user.social_shame && !user.vacation_mode) {
          const habitCount = statements.getActiveHabitsCount.get(user.id).count || 0;
          if (habitCount > 0) {
            const checkinsCount = statements.getCheckinsCountForDate.get(user.id, today).count || 0;
            if (checkinsCount < habitCount) {
              const partner = String(user.social_shame_partner_username || '').trim();
              const normalized = partner.replace(/^@+/, '');
              if (normalized) {
                const handle = `@${normalized}`;
                const label = user.telegram_id ? `User ${user.telegram_id}` : `User ${user.id}`;
                bot.sendMessage(handle, `Attention! ${label} failed their habits today. Hold them accountable! ⚡️`);
              }
            }
          }
        }

        reminderState.shame = today;
        persistReminderState(statements, user.id, reminderState);
      }

      if (currentTime === RETENTION_TIME && reminderState.retention !== today) {
        if (!user.vacation_mode) {
          const habitCount = statements.getActiveHabitsCount.get(user.id).count || 0;
          if (habitCount > 0) {
            const checkinsCount = statements.getCheckinsCountForDate.get(user.id, today).count || 0;
            if (checkinsCount === 0) {
              bot.sendMessage(user.telegram_id, getRetentionMessage());
            }
          }
        }

        reminderState.retention = today;
        persistReminderState(statements, user.id, reminderState);
      }

      if (currentTime !== reminderTime) {
        continue;
      }

      if (reminderState.evening === today) {
        continue;
      }

      const habitCount = statements.getActiveHabitsCount.get(user.id).count || 0;
      if (habitCount === 0) {
        reminderState.evening = today;
        persistReminderState(statements, user.id, reminderState);
        continue;
      }

      const checkinsCount = statements.getCheckinsCountForDate.get(user.id, today).count || 0;
      if (checkinsCount >= habitCount) {
        reminderState.evening = today;
        persistReminderState(statements, user.id, reminderState);
        continue;
      }

      bot.sendMessage(user.telegram_id, texts.reminder, {
        reply_markup: {
          inline_keyboard: [[{ text: texts.startDayButton, callback_data: 'start_day' }]],
        },
      });

      reminderState.evening = today;
      persistReminderState(statements, user.id, reminderState);
    }

    const monitors = statements.getMonitors.all();
    for (const monitor of monitors) {
      const now = getUserNow(monitor.timezone, monitor.user_id);
      const today = now.format('YYYY-MM-DD');
      const currentTime = now.format('HH:mm');

      if (currentTime !== PARTNER_CHECK_TIME) {
        continue;
      }

      if (monitor.last_notified_date === today) {
        continue;
      }

      if (!monitor.monitor_telegram_id || monitor.monitor_telegram_id === monitor.user_telegram_id) {
        statements.updateMonitorNotifiedDate.run(today, monitor.user_id);
        continue;
      }

      const habitCount = statements.getActiveHabitsCount.get(monitor.user_id).count || 0;
      if (habitCount === 0) {
        statements.updateMonitorNotifiedDate.run(today, monitor.user_id);
        continue;
      }

      const checkinsCount =
        statements.getCheckinsCountForDate.get(monitor.user_id, today).count || 0;
      if (checkinsCount >= habitCount) {
        statements.updateMonitorNotifiedDate.run(today, monitor.user_id);
        continue;
      }

      bot.sendMessage(monitor.monitor_telegram_id, texts.monitorNotify, {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: texts.monitorKickButton,
                callback_data: `kick:${monitor.user_id}`,
              },
            ],
          ],
        },
      });

      statements.updateMonitorNotifiedDate.run(today, monitor.user_id);
    }
  };

  tick();
  let timer = null;
  let cronTask = null;
  try {
    if (cron && typeof cron.schedule === 'function') {
      cronTask = cron.schedule('* * * * *', tick);
    } else {
      timer = setInterval(tick, intervalMs);
    }
  } catch (error) {
    timer = setInterval(tick, intervalMs);
  }

  return {
    stop() {
      if (cronTask) cronTask.stop();
      if (timer) clearInterval(timer);
    },
  };
}

function formatStepsText(total) {
  if (total === 1) return '1 звичка';
  if (total > 1 && total < 5) return `${total} звички`;
  return `${total} звичок`;
}

function getStatusMap(rows) {
  const map = new Map();
  for (const row of rows || []) {
    map.set(row.habit_id, row.status);
  }
  return map;
}

function getShameMessage(lang) {
  const key = String(lang || '').toLowerCase().split('-')[0];
  const messages = {
    uk: 'Де твій прогрес? Твій стрік під загрозою! Не дай ліні перемогти. 🔥',
    en: 'Where is your progress? Your streak is at risk! Don’t let laziness win. 🔥',
    cs: 'Kde je tvůj pokrok? Tvá série je v ohrožení! Nenech lenost vyhrát. 🔥',
    ru: 'Где твой прогресс? Твой стрик под угрозой! Не дай лени победить. 🔥',
  };
  return messages[key] || messages.uk;
}

function getRetentionMessage() {
  return 'Твоя серія під загрозою! 🔥 Ранг може впасти. Повертайся в гру!';
}

function parseReminderState(value) {
  if (!value) return { morning: null, evening: null, trialDay5: null, shame: null, retention: null };
  const text = String(value).trim();
  if (!text) return { morning: null, evening: null, trialDay5: null, shame: null, retention: null };
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      return {
        morning: parsed.morning || null,
        evening: parsed.evening || null,
        trialDay5: parsed.trialDay5 || parsed.trial_day5 || null,
        shame: parsed.shame || null,
        retention: parsed.retention || null,
      };
    } catch {
      return { morning: null, evening: null, trialDay5: null, shame: null, retention: null };
    }
  }
  return { morning: null, evening: text, trialDay5: null, shame: null, retention: null };
}

function persistReminderState(statements, userId, state) {
  const payload = JSON.stringify({
    morning: state.morning || null,
    evening: state.evening || null,
    trialDay5: state.trialDay5 || null,
    shame: state.shame || null,
    retention: state.retention || null,
  });
  statements.updateLastRemindedDate.run(payload, userId);
}

function getUserNow(timezoneName, userId) {
  if (!timezoneName) {
    return dayjs().tz(DEFAULT_TIMEZONE);
  }

  try {
    return dayjs().tz(timezoneName);
  } catch (error) {
    console.warn('[scheduler] invalid timezone, fallback', {
      userId,
      timezone: timezoneName,
      fallback: DEFAULT_TIMEZONE,
    });
    return dayjs().tz(DEFAULT_TIMEZONE);
  }
}

function getTrialDaysLeft(trialUntil, now) {
  if (!trialUntil) return null;
  const parsed = dayjs(trialUntil);
  if (!parsed.isValid()) return null;
  const diff = parsed.diff(now, 'day', true);
  return Math.max(0, Math.ceil(diff));
}

function prepareStatements(db) {
  return {
    getUsers: db.prepare(
      'SELECT id, telegram_id, timezone, reminder_time, last_reminded_date, trial_until, plan, social_shame, vacation_mode, language_code, social_shame_partner_username FROM users'
    ),
    getHabits: db.prepare(
      'SELECT id, title FROM habits WHERE user_id = ? AND active = 1 ORDER BY sort_order, id'
    ),
    getCheckinsForDate: db.prepare(
      'SELECT habit_id, status FROM checkins WHERE user_id = ? AND date = ?'
    ),
    deleteExpiredLazyUndoTokens: db.prepare(
      'DELETE FROM lazy_undo_tokens WHERE expires_at <= ?'
    ),
    insertAnalyticsEvent: db.prepare(
      'INSERT INTO analytics_events (user_id, event, meta, created_at) VALUES (?, ?, ?, ?)'
    ),
    getMonitors: db.prepare(
      `SELECT m.user_id, m.monitor_telegram_id, m.enabled, m.last_notified_date,
              u.telegram_id as user_telegram_id, u.timezone
       FROM monitors m
       INNER JOIN users u ON u.id = m.user_id
       WHERE m.enabled = 1`
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
    updateLastRemindedDate: db.prepare(
      'UPDATE users SET last_reminded_date = ? WHERE id = ?'
    ),
    updateMonitorNotifiedDate: db.prepare(
      'UPDATE monitors SET last_notified_date = ? WHERE user_id = ?'
    ),
  };
}

module.exports = {
  startScheduler,
};
