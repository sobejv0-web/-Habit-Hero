// =============================================================================
// social-shame.js — Social Shame / Supervisor Frontend Logic
//
// Checks if it's past the deadline (21:00 user-local) and habits are undone.
// Shows a warning toast or a "shame modal" to nudge the user.
//
// Settings:
//   - supervisorEnabled: boolean  (localStorage)
//   - shameDeadline:     '21:00'  (localStorage, default 21:00)
//
// This is a frontend mock — the real notifications are sent by the bot.
// =============================================================================

'use strict';

import { Selectors } from '../store.js';
import { haptic } from '../utils.js';

// ─── LocalStorage keys ──────────────────────────────────────────────────────

const LS_SUPERVISOR = 'habit_supervisor_enabled';
const LS_DEADLINE   = 'habit_shame_deadline';
const LS_VACATION   = 'habit_vacation_mode';

// ─── State ───────────────────────────────────────────────────────────────────

let _store    = null;
let _interval = null;
let _lastWarnDate = null;   // prevent repeat warnings on same day
let _showToast = null;      // injected from app.js

// ─── Settings helpers ────────────────────────────────────────────────────────

export function isSupervisorEnabled() {
  return localStorage.getItem(LS_SUPERVISOR) === '1';
}

export function setSupervisorEnabled(on) {
  localStorage.setItem(LS_SUPERVISOR, on ? '1' : '0');
}

export function getDeadline() {
  return localStorage.getItem(LS_DEADLINE) || '21:00';
}

export function setDeadline(time) {
  localStorage.setItem(LS_DEADLINE, time);
}

export function isVacationMode() {
  return localStorage.getItem(LS_VACATION) === '1';
}

export function setVacationMode(on) {
  localStorage.setItem(LS_VACATION, on ? '1' : '0');
}

// ─── Core check ──────────────────────────────────────────────────────────────

function checkShame() {
  if (!_store) return;
  if (!isSupervisorEnabled()) return;
  if (isVacationMode()) return;

  const state = _store.getState();
  if (!state.me || state.habits.length === 0) return;

  const tz       = state.me?.user?.timezone || state.me?.timezone;
  const nowStr   = new Intl.DateTimeFormat('en-CA', { timeZone: tz || undefined })
    .format(new Date());
  const timeStr  = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz || undefined,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date());

  const deadline = getDeadline();

  // Already warned today?
  if (_lastWarnDate === nowStr) return;

  // Is it past deadline?
  if (timeStr < deadline) return;

  // Are there undone habits?
  const progress = Selectors.todayProgress(state);
  if (progress.done + Selectors.pendingHabits(state).length === 0) return;  // no habits
  if (progress.done >= progress.total) return;                              // all done

  const pending = progress.total - progress.done - progress.skip;
  if (pending <= 0) return;

  // Fire shame warning!
  _lastWarnDate = nowStr;
  haptic('warning');

  if (_showToast) {
    _showToast({
      type: 'warning',
      message: `⚠️ ${pending} ${pending === 1 ? 'звичка' : 'звичок'} не виконано! Дедлайн ${deadline}.`,
      duration: 6000,
    });
  }
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

/**
 * Start the social shame checker.
 *
 * @param {Store}    store
 * @param {Function} showToastFn - renderer's showToast
 */
export function initSocialShame(store, showToastFn) {
  _store     = store;
  _showToast = showToastFn;

  // Check immediately, then every 60 seconds
  checkShame();
  _interval = setInterval(checkShame, 60_000);
}

/**
 * Stop the checker (e.g. on app teardown).
 */
export function stopSocialShame() {
  if (_interval) {
    clearInterval(_interval);
    _interval = null;
  }
}

/**
 * Force a check right now (e.g. after toggling supervisor on).
 */
export function forceCheck() {
  _lastWarnDate = null;
  checkShame();
}
