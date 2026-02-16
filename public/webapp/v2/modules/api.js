// =============================================================================
// api.js — API layer for Habit System v2
//
// Thin wrapper around fetch.  Every function returns a Promise.
// Side-effects (dispatch) happen in the caller (app.js), NOT here.
// =============================================================================

'use strict';

// ─── Config ──────────────────────────────────────────────────────────────────

const API_TIMEOUT_MS   = 12_000;
const NETWORK_RETRY    = 2;

// ─── Init data — set once at boot ────────────────────────────────────────────

let _initData = '';

/**
 * Must be called once during boot to provide auth headers (Authorization + X-TG-INIT-DATA).
 * @param {string} raw — Telegram.WebApp.initData
 */
export function setInitData(raw) {
  _initData = raw || '';
}

// ─── Error normalisation ─────────────────────────────────────────────────────

function httpError(status, body) {
  const msg =
    body?.error || body?.message || `HTTP ${status}`;
  return { type: 'http', status, message: msg, body };
}

function networkError(err) {
  return {
    type: 'network',
    message: err?.message || 'Network error',
    original: err,
  };
}

// ─── Core fetch ──────────────────────────────────────────────────────────────

/**
 * Low-level fetch with auth header, timeout, auto-retry on network errors,
 * JSON auto-parse.
 *
 * @param {string} path
 * @param {RequestInit} [opts]
 * @param {number} [attempt]
 * @returns {Promise<any>}
 */
export async function apiFetch(path, opts = {}, attempt = 0) {
  const headers = new Headers(opts.headers || {});
  headers.set('X-TG-INIT-DATA', _initData);
  headers.set('Authorization', _initData);
  headers.set('Cache-Control', 'no-store');

  const hasBody = opts.body !== undefined && opts.body !== null;
  if (hasBody && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const ac = new AbortController();
  const tid = setTimeout(() => ac.abort(), API_TIMEOUT_MS);

  try {
    const res = await fetch(path, {
      ...opts,
      headers,
      cache: 'no-store',
      signal: ac.signal,
    });
    clearTimeout(tid);

    if (!res.ok) {
      let body = null;
      try { body = await res.json(); } catch { /* ignore */ }
      throw httpError(res.status, body);
    }

    const ct = res.headers.get('content-type') || '';
    return ct.includes('application/json') ? res.json() : res.text();
  } catch (err) {
    clearTimeout(tid);

    const isNet =
      err?.name === 'AbortError' ||
      err instanceof TypeError  ||
      err?.type === 'network';

    if (isNet && attempt < NETWORK_RETRY) {
      return apiFetch(path, opts, attempt + 1);
    }

    if (err?.type === 'http') throw err;
    throw networkError(err);
  }
}

// ─── Domain endpoints ────────────────────────────────────────────────────────

/** GET /api/me — bootstrap payload */
export function loadMe() {
  return apiFetch('/api/me');
}

/** POST /api/today/checkin — mark habit done/skip */
export function sendCheckin(habitId, status) {
  return apiFetch('/api/today/checkin', {
    method: 'POST',
    body: JSON.stringify({ habitId, status }),
  });
}

/** POST /api/today/undo — revert today's checkin */
export function sendUndo(habitId) {
  return apiFetch('/api/today/undo', {
    method: 'POST',
    body: JSON.stringify({ habitId }),
  });
}

/**
 * High-level: send intent (done | skip | undo).
 * Returns server response payload.
 */
export function sendHabitIntent(habitId, intent) {
  if (intent === 'undo') return sendUndo(habitId);
  return sendCheckin(habitId, intent);
}

/** POST /api/habits — create habit */
export function createHabit(data) {
  return apiFetch('/api/habits', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

/** PUT /api/habits/:id — update habit */
export function updateHabit(habitId, data) {
  return apiFetch(`/api/habits/${habitId}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

/** DELETE /api/habits/:id */
export function deleteHabit(habitId) {
  return apiFetch(`/api/habits/${habitId}`, { method: 'DELETE' });
}

/** POST /api/analytics */
export function track(event, meta = {}) {
  const payload = { event };
  if (meta && typeof meta === 'object' && Object.keys(meta).length > 0) {
    payload.meta = meta;
  }
  return apiFetch('/api/analytics', {
    method: 'POST',
    body: JSON.stringify(payload),
  }).catch(() => {}); // fire-and-forget
}

/** GET /api/stats?range=... */
export function loadStats(range = '7d') {
  return apiFetch(`/api/stats?range=${range}`);
}

/** GET /api/stats/heatmap?days=... */
export function loadHeatmap(days = 90) {
  return apiFetch(`/api/stats/heatmap?days=${days}`);
}

/** POST /api/settings — update settings */
export function saveSettings(data) {
  return apiFetch('/api/settings', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

/** POST /api/monitor/unlink */
export function unlinkMonitor() {
  return apiFetch('/api/monitor/unlink', { method: 'POST' });
}

/**
 * POST /api/habits/reorder — reorder habits
 * 
 * Sends new order to server. If endpoint doesn't exist yet,
 * falls back to updating each habit individually (slower but works).
 * 
 * @param {Array<{id: number, sort_order: number}>} order
 * @returns {Promise<boolean>}
 */
export async function reorderHabits(order) {
  try {
    // Try the dedicated reorder endpoint first
    await apiFetch('/api/habits/reorder', {
      method: 'POST',
      body: JSON.stringify({ order }),
    });
    return true;
  } catch (err) {
    // If endpoint doesn't exist (404), fall back to individual updates
    if (err?.status === 404) {
      console.log('[API] /api/habits/reorder not found, using fallback');
      
      // Update each habit individually (slower but works)
      const updates = order.map(item => 
        apiFetch(`/api/habits/${item.id}`, {
          method: 'PUT',
          body: JSON.stringify({ sort_order: item.sort_order }),
        }).catch(() => null)  // Ignore individual failures
      );
      
      await Promise.all(updates);
      return true;
    }
    
    // Re-throw other errors
    throw err;
  }
}
