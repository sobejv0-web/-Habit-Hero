// =============================================================================
// utils.js — Shared helpers for Habit System v2
// Pure functions, zero side-effects, zero DOM access.
// =============================================================================

'use strict';

// ─── Date / Time ──────────────────────────────────────────────────────────────

/**
 * Return today's date as YYYY-MM-DD in the user's timezone.
 * Falls back to UTC if timezone is invalid.
 *
 * @param {string} [tz] - IANA timezone, e.g. 'Europe/Kyiv'
 * @returns {string}
 */
export function todayKey(tz) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/**
 * Ukrainian-locale day-word declension: 1 день, 2 дні, 5 днів.
 * @param {number} count
 * @returns {string}
 */
export function formatDays(count) {
  const v = Math.abs(Number(count) || 0);
  const m10 = v % 10;
  const m100 = v % 100;
  if (m10 === 1 && m100 !== 11) return 'день';
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'дні';
  return 'днів';
}

/**
 * Format seconds into MM:SS.
 * @param {number} seconds
 * @returns {string}
 */
export function formatTimer(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

/**
 * Format steps count with Ukrainian declension.
 * @param {number} total
 * @returns {string}
 */
export function formatSteps(total) {
  if (total === 1) return '1 крок';
  if (total > 1 && total < 5) return `${total} кроки`;
  return `${total} кроків`;
}

// ─── Habit helpers ────────────────────────────────────────────────────────────

/**
 * Human-readable checkin copy.
 */
export const STATUS_COPY = Object.freeze({
  none: 'Ще не відмічено',
  done: 'Виконано',
  skip: 'Пропущено',
});

/**
 * CSS class suffix for a given checkin status.
 * @param {'none'|'done'|'skip'} status
 * @returns {string}
 */
export function statusClass(status) {
  if (status === 'done') return 'is-done';
  if (status === 'skip') return 'is-skip';
  return 'is-idle';
}

/**
 * Parse a timer/duration hint from habit title.
 * "Медитація 5хв" → 300 (seconds).
 *
 * @param {string} title
 * @returns {number|null}
 */
export function parseTimerFromTitle(title) {
  if (!title) return null;
  const minMatch = title.match(/(\d+)\s*(хв|min|m)\b/i);
  if (minMatch) return Number(minMatch[1]) * 60;
  const secMatch = title.match(/(\d+)\s*(сек|sec|s)\b/i);
  if (secMatch) return Number(secMatch[1]);
  return null;
}

/**
 * Pick a default emoji for a habit based on title heuristics.
 * @param {string} title
 * @returns {string}
 */
export function pickEmoji(title) {
  const t = (title || '').toLowerCase();
  if (t.includes('вод')) return '💧';
  if (t.includes('water')) return '💧';
  if (t.includes('читан')) return '📖';
  if (t.includes('read')) return '📖';
  if (t.includes('прогулянк') || t.includes('walk')) return '🚶';
  if (t.includes('англійськ') || t.includes('english')) return '🇬🇧';
  if (t.includes('розтяжк') || t.includes('stretch')) return '🧘';
  if (t.includes('медитац') || t.includes('meditat')) return '🧘‍♂️';
  if (t.includes('спорт') || t.includes('gym') || t.includes('тренуван')) return '💪';
  if (t.includes('сон') || t.includes('sleep')) return '😴';
  if (t.includes('код') || t.includes('code') || t.includes('програм')) return '💻';
  return '✨';
}

// ─── DOM helpers ──────────────────────────────────────────────────────────────

/**
 * Create an element with optional class, text and attributes.
 *
 * @param {string} tag
 * @param {string} [cls] - space-separated class names
 * @param {string} [text] - textContent
 * @param {Object} [attrs] - attribute key-values
 * @returns {HTMLElement}
 */
export function el(tag, cls, text, attrs) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text) node.textContent = text;
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'hidden') {
        node.hidden = !!v;
      } else if (k.startsWith('data-')) {
        node.dataset[k.slice(5)] = v;
      } else {
        node.setAttribute(k, v);
      }
    }
  }
  return node;
}

/**
 * Shortcut: append multiple children to a parent.
 * @param {HTMLElement} parent
 * @param  {...HTMLElement} children
 * @returns {HTMLElement} parent
 */
export function appendAll(parent, ...children) {
  for (const child of children) {
    if (child != null) parent.appendChild(child);
  }
  return parent;
}

// ─── Telegram helpers ─────────────────────────────────────────────────────────

/**
 * Safely call Telegram HapticFeedback.
 *
 * @param {'success'|'error'|'warning'|'light'|'medium'|'heavy'|'rigid'|'soft'|'selection'} type
 */
export function haptic(type) {
  const hf = window.Telegram?.WebApp?.HapticFeedback;
  if (!hf) return;

  switch (type) {
    case 'success':
    case 'error':
    case 'warning':
      hf.notificationOccurred(type);
      break;
    case 'light':
    case 'medium':
    case 'heavy':
    case 'rigid':
    case 'soft':
      hf.impactOccurred(type);
      break;
    case 'selection':
      hf.selectionChanged();
      break;
    default:
      hf.impactOccurred('light');
  }
}

// ─── Analytics helper ─────────────────────────────────────────────────────────

/**
 * Build a localStorage key scoped to user + event + suffix.
 * @param {string} userId
 * @param {string} name
 * @param {string} [suffix]
 * @returns {string}
 */
export function analyticsKey(userId, name, suffix = '') {
  return `analytics_${name}_${suffix}_${userId}`;
}

/**
 * Record an event at most once per key.
 * Returns true if this was the first time (event should be sent).
 * @param {string} key
 * @returns {boolean}
 */
export function oncePerKey(key) {
  if (localStorage.getItem(key)) return false;
  localStorage.setItem(key, '1');
  return true;
}

// ─── Misc  ────────────────────────────────────────────────────────────────────

/**
 * Throttle a function to run at most once per `ms` milliseconds.
 * @param {Function} fn
 * @param {number} ms
 * @returns {Function}
 */
export function throttle(fn, ms) {
  let last = 0;
  let timer = null;
  return function (...args) {
    const now = Date.now();
    const remaining = ms - (now - last);
    if (remaining <= 0) {
      last = now;
      fn.apply(this, args);
    } else if (!timer) {
      timer = setTimeout(() => {
        last = Date.now();
        timer = null;
        fn.apply(this, args);
      }, remaining);
    }
  };
}

/**
 * Debounce: call fn only after `ms` of silence.
 * @param {Function} fn
 * @param {number} ms
 * @returns {Function}
 */
export function debounce(fn, ms) {
  let timer = null;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), ms);
  };
}

/**
 * Generate a simple local id (for offline-created habits before server confirms).
 * @returns {string}
 */
export function localId() {
  return `_local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Clamp a value between min and max.
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
