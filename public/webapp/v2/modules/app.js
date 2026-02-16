// =============================================================================
// app.js — Entry Point for Habit System v2
//
// Wires together: Store, Renderer, Interactions, API.
// Boot sequence: Telegram init → Store → Interactions → loadMe → Render.
// =============================================================================

'use strict';

import { getStore, Actions, Selectors, nextBooleanIntent, loadFromCache, saveToCache } from './store.js';
import { haptic, todayKey } from './utils.js';
import { initRenderer, render, showToast, hideToast, syncContextSheet, syncFiveMinModal } from './renderer.js';
import { initInteractions } from './interactions.js';
import { setInitData, loadMe, sendHabitIntent, createHabit, deleteHabit as apiDeleteHabit, track, loadHeatmap, apiFetch, reorderHabits } from './api.js';

// Phase 4 — Advanced features
import { initDragDrop, refreshDraggable } from './features/drag-drop.js';
import { initSocialShame, stopSocialShame } from './features/social-shame.js';
import { initSettings } from './settings.js';

// ─── Telegram init ──────────────────────────────────────────────────────────

const tg          = window.Telegram?.WebApp;
const isInTelegram = !!tg;

const overlay  = document.getElementById('telegram-only');
const appShell = document.getElementById('app-shell');

if (!isInTelegram) {
  if (overlay)  overlay.hidden = false;
  if (appShell) appShell.hidden = true;
} else {
  try {
    tg.ready();
    tg.expand();
    // Force dark background in Telegram chrome
    tg.setHeaderColor('#0F0F0F');
    tg.setBackgroundColor('#0F0F0F');
  } catch {}
  setInitData(tg.initData || '');
}

// ─── Global error handler for mobile debugging ──────────────────────────────

window.onerror = function(msg, url, line, col, error) {
  const errorLog = document.getElementById('error-log');
  if (errorLog) {
    errorLog.hidden = false;
    const timestamp = new Date().toLocaleTimeString();
    const errorHTML = `
      <div style="border-bottom: 1px solid rgba(255,255,255,0.2); padding: 8px 0;">
        <div style="font-weight: 700; margin-bottom: 4px;">[${timestamp}] ERROR</div>
        <div style="margin-bottom: 4px;"><strong>Message:</strong> ${msg}</div>
        <div style="margin-bottom: 4px;"><strong>File:</strong> ${url}</div>
        <div style="margin-bottom: 4px;"><strong>Line:</strong> ${line}:${col}</div>
        ${error?.stack ? `<div style="margin-top: 8px;"><strong>Stack:</strong><pre style="font-size: 0.65rem; margin-top: 4px; white-space: pre-wrap;">${error.stack}</pre></div>` : ''}
      </div>
    `;
    errorLog.innerHTML = errorHTML + errorLog.innerHTML;
  }
  console.error('Global error caught:', msg, url, line, col, error);
  return false; // Let default error handling also run
};

window.onunhandledrejection = function(event) {
  const errorLog = document.getElementById('error-log');
  if (errorLog) {
    errorLog.hidden = false;
    const timestamp = new Date().toLocaleTimeString();
    const errorHTML = `
      <div style="border-bottom: 1px solid rgba(255,255,255,0.2); padding: 8px 0;">
        <div style="font-weight: 700; margin-bottom: 4px; color: #ffcc00;">[${timestamp}] UNHANDLED PROMISE REJECTION</div>
        <div style="margin-bottom: 4px;">${event.reason}</div>
      </div>
    `;
    errorLog.innerHTML = errorHTML + errorLog.innerHTML;
  }
  console.error('Unhandled promise rejection:', event.reason);
};

function formatErrorDetail(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function logApiError(err, context) {
  const errorLog = document.getElementById('error-log');
  if (!errorLog) return;
  errorLog.hidden = false;

  const timestamp = new Date().toLocaleTimeString();
  const status = err?.status ? `HTTP ${err.status}` : '';
  const message = err?.message || 'Unknown API error';
  const body = formatErrorDetail(err?.body);
  const original = formatErrorDetail(err?.original);
  const ctx = context ? ` (${context})` : '';

  const errorHTML = `
    <div style="border-bottom: 1px solid rgba(255,255,255,0.2); padding: 8px 0;">
      <div style="font-weight: 700; margin-bottom: 4px; color: #ff9f1c;">[${timestamp}] API ERROR${ctx}</div>
      <div style="margin-bottom: 4px;"><strong>Message:</strong> ${message}</div>
      ${status ? `<div style="margin-bottom: 4px;"><strong>Status:</strong> ${status}</div>` : ''}
      ${body ? `<div style="margin-top: 6px;"><strong>Body:</strong><pre style="font-size: 0.65rem; margin-top: 4px; white-space: pre-wrap;">${body}</pre></div>` : ''}
      ${original ? `<div style="margin-top: 6px;"><strong>Original:</strong><pre style="font-size: 0.65rem; margin-top: 4px; white-space: pre-wrap;">${original}</pre></div>` : ''}
    </div>
  `;
  errorLog.innerHTML = errorHTML + errorLog.innerHTML;
  console.error('[API Error]', context || '', err);
}

// ─── Store ───────────────────────────────────────────────────────────────────

const store = getStore();

// Debug helpers
if (typeof window !== 'undefined') {
  window.__store    = store;
  window.__Actions  = Actions;
  window.__Selectors = Selectors;
}

// ─── Timer tick manager ──────────────────────────────────────────────────────

let _timerInterval = null;
const _runningTimers = new Set(); // habitIds with timerRunning

function startTimerTicks() {
  if (_timerInterval) return;
  _timerInterval = setInterval(() => {
    const state = store.getState();
    for (const habit of state.habits) {
      const ci = state.checkins[habit.id];
      if (ci?.timerRunning) {
        const newElapsed = (ci.timerElapsed || 0) + 1;
        store.dispatch({
          type: Actions.TIMER_TICK,
          payload: { habitId: habit.id, elapsed: newElapsed },
        });
      }
    }
  }, 1000);
}

function stopTimerTicks() {
  if (_timerInterval) {
    clearInterval(_timerInterval);
    _timerInterval = null;
  }
}

function syncTimerLoop(state) {
  let hasRunning = false;
  for (const habit of state.habits) {
    if (state.checkins[habit.id]?.timerRunning) {
      hasRunning = true;
      break;
    }
  }
  if (hasRunning) startTimerTicks();
  else stopTimerTicks();
}

// ─── 5-min countdown ─────────────────────────────────────────────────────────

let _fiveMinInterval = null;

function syncFiveMinLoop(state) {
  if (state.ui.fiveMin.running && state.ui.fiveMin.remaining > 0) {
    if (!_fiveMinInterval) {
      _fiveMinInterval = setInterval(() => {
        store.dispatch({ type: Actions.FIVE_MIN_TICK });
        const s = store.getState();
        if (!s.ui.fiveMin.running || s.ui.fiveMin.remaining <= 0) {
          clearInterval(_fiveMinInterval);
          _fiveMinInterval = null;
          if (s.ui.fiveMin.remaining <= 0) {
            store.dispatch({ type: Actions.FIVE_MIN_DONE });
            showToast({ type: 'success', message: '5 хвилин пройшли! Молодець 💪' });
          }
        }
      }, 1000);
    }
  } else {
    if (_fiveMinInterval) {
      clearInterval(_fiveMinInterval);
      _fiveMinInterval = null;
    }
  }
}

// ─── Optimistic intent runner ────────────────────────────────────────────────

/**
 * Run a habit intent with optimistic UI.
 * Dispatches OPTIMISTIC_APPLY → API call → FINALIZE or ROLLBACK.
 */
async function runHabitIntent(habitId, intent) {
  // If already in-flight, queue
  if (store.isInFlight(habitId)) {
    store.queueIntent(habitId, intent);
    return;
  }

  // Optimistic apply
  store.dispatch({
    type: Actions.OPTIMISTIC_APPLY,
    payload: { habitId, intent },
  });

  try {
    const payload = await sendHabitIntent(habitId, intent);

    const sideEffect = store.dispatch({
      type: Actions.OPTIMISTIC_FINALIZE,
      payload: { habitId, serverStatus: payload?.status },
    });

    // Process queued intent
    if (sideEffect?.type === 'QUEUED_INTENT') {
      runHabitIntent(sideEffect.habitId, sideEffect.intent);
    }

    // Success feedback
    if (intent === 'done') {
      showToast({
        type: 'success',
        message: 'Виконано',
        actionLabel: 'Undo',
        duration: 4200,
        onAction: () => runHabitIntent(habitId, 'undo'),
      });
    } else if (intent === 'skip') {
      showToast({
        type: 'success',
        message: 'Пропущено',
        actionLabel: 'Undo',
        duration: 4200,
        onAction: () => runHabitIntent(habitId, 'undo'),
      });
    }
  } catch (err) {
    store.dispatch({
      type: Actions.OPTIMISTIC_ROLLBACK,
      payload: { habitId },
    });

    logApiError(err, 'sendHabitIntent');
    haptic('error');
    showToast({
      type: 'error',
      message: err?.type === 'network'
        ? 'Немає звʼязку. Спробувати ще раз?'
        : 'Не вдалося зберегти.',
      actionLabel: 'Повторити',
      onAction: () => runHabitIntent(habitId, intent),
    });
  }
}

// ─── Interaction callbacks ───────────────────────────────────────────────────

function handleHabitTap(habitId) {
  const habit = store.getState().habits.find(h => h.id === habitId);
  if (!habit) return;

  const type = habit.type || 'boolean';

  // Counter type — tap increments
  if (type === 'counter') {
    handleCounterTap(habitId);
    return;
  }

  // Timer type — tap toggles timer, don't cycle boolean status
  if (type === 'timer') {
    handleTimerToggle(habitId);
    return;
  }

  // Boolean: cycle through done → skip → undo
  const currentStatus = store.getCheckinStatus(habitId);
  const intent = nextBooleanIntent(currentStatus);

  // 5-minute rule: on first skip attempt, offer the modal
  if (intent === 'skip') {
    store.dispatch({
      type: Actions.FIVE_MIN_SHOW,
      payload: { habitId },
    });
    return;
  }

  runHabitIntent(habitId, intent);
}

function handleCounterTap(habitId) {
  const habit = store.getState().habits.find(h => h.id === habitId);
  if (!habit) return;

  const step = habit.counterStep || 1;
  store.dispatch({
    type: Actions.COUNTER_INCREMENT,
    payload: { habitId, step },
  });

  // Check if we just reached target — then sync with server
  const ci = store.getState().checkins[habitId];
  if (ci?.status === 'done') {
    runHabitIntent(habitId, 'done');
    haptic('success');
  }
}

function handleTimerToggle(habitId) {
  const ci = store.getState().checkins[habitId];
  if (ci?.timerRunning) {
    store.dispatch({ type: Actions.TIMER_STOP, payload: { habitId } });
  } else {
    store.dispatch({ type: Actions.TIMER_START, payload: { habitId } });
  }
}

function handleRoutineTap(routineId) {
  store.dispatch({ type: Actions.FOCUS_START, payload: { routineId } });
  track('routine_started', { routineId });
}

function handleLongPress(id, kind) {
  if (kind === 'routine') {
    store.dispatch({
      type: Actions.CONTEXT_MENU_OPEN,
      payload: { habitId: id, scope: 'routine' },
    });
  } else {
    store.dispatch({
      type: Actions.CONTEXT_MENU_OPEN,
      payload: { habitId: id, scope: 'habit' },
    });
  }
}

function handleListItemTap(habitId) {
  // Long-press is handled by interactions.js; simple tap → navigate/edit
  // For now, open context menu as a way to interact
  store.dispatch({
    type: Actions.CONTEXT_MENU_OPEN,
    payload: { habitId, scope: 'habit' },
  });
}

async function handleAddHabit(data) {
  store.dispatch({ type: Actions.SET_LOADING, payload: { habits: true } });

  try {
    const result = await createHabit(data);
    console.log('[AddHabit] API result:', result);

    // Build a complete habit object by merging form data with API response.
    // The backend does NOT return type/counterTarget/timerDuration —
    // we must carry them from the original form data.
    const raw = result?.habit || (result?.id ? result : null);
    if (raw) {
      const fullHabit = {
        ...raw,
        type:           data.type           || raw.type || 'boolean',
        counterTarget:  data.counterTarget  ?? raw.counterTarget ?? null,
        counterStep:    data.counterStep    ?? raw.counterStep   ?? 1,
        timerDuration:  data.timerDuration  ?? raw.timerDuration ?? null,
        streak:         raw.streak          ?? 0,
      };
      console.log('[AddHabit] Dispatching ADD_HABIT:', fullHabit);
      store.dispatch({ type: Actions.ADD_HABIT, payload: fullHabit });

      // TEMPORARY DEBUG ALERT — REMOVE AFTER FIXING
      try {
        const st = store.getState();
        alert(`Habit created!\n\nID: ${fullHabit.id}\nTitle: ${fullHabit.title}\nType: ${fullHabit.type}\n\nStore habits: ${st.habits?.length}\nStore tab: ${st.ui?.activeTab}\nLoading.me: ${st.loading?.me}`);
      } catch (_) {}

      showToast({ type: 'success', message: `«${data.title}» додано` });
      track('habit_created', { type: fullHabit.type });

      // Silent background resync — ensures store matches server 100%.
      // Does NOT show loading skeleton; ADD_HABIT above is the instant update.
      loadMe().then(meData => {
        console.log('[AddHabit] Resync: habits from server:', meData?.habits?.length);
        store.dispatch({ type: Actions.SET_ME, payload: meData });
      }).catch(err => {
        console.warn('[AddHabit] Resync failed (non-critical):', err);
      });
    } else {
      console.error('[AddHabit] Unexpected API shape:', result);
      showToast({ type: 'warning', message: 'Звичку створено, оновлюю…' });
      // Fallback: full resync
      try {
        const meData = await loadMe();
        store.dispatch({ type: Actions.SET_ME, payload: meData });
      } catch (e) {
        console.error('[AddHabit] Fallback resync failed:', e);
      }
    }
  } catch (err) {
    logApiError(err, 'createHabit');
    haptic('error');
    showToast({
      type: 'error',
      message: err?.body?.error || 'Не вдалося додати звичку.',
    });
  } finally {
    store.dispatch({ type: Actions.SET_LOADING, payload: { habits: false } });
  }
}

async function handleDeleteHabit(habitId) {
  const habit = store.getState().habits.find(h => h.id === habitId);
  if (!habit) return;

  // Optimistic delete
  store.dispatch({ type: Actions.DELETE_HABIT, payload: habitId });

  try {
    await apiDeleteHabit(habitId);
    showToast({ type: 'success', message: 'Видалено', duration: 1400 });
  } catch (err) {
    // Rollback: reload everything
    logApiError(err, 'deleteHabit');
    haptic('error');
    showToast({ type: 'error', message: 'Не вдалося видалити.' });
    await boot();
  }
}

// ─── Drag & Drop reorder callback ────────────────────────────────────────────

function handleReorder(newOrder) {
  // newOrder: [{ id, sort_order }]
  
  // Optimistic update — UI updates immediately
  store.dispatch({ type: Actions.REORDER_HABITS, payload: newOrder });

  // Persist to server (with fallback to individual PUT calls)
  reorderHabits(newOrder).catch((err) => {
    logApiError(err, 'reorderHabits');
    console.error('[Reorder] Failed:', err);
    showToast({ type: 'error', message: 'Не вдалося зберегти порядок.' });
  });

  track('habits_reordered');
}

// ─── Context sheet action handler ────────────────────────────────────────────

function setupSheetActionHandler() {
  const sheet = document.getElementById('context-sheet');
  if (!sheet) return;

  sheet.addEventListener('sheet-action', (evt) => {
    const { action } = evt.detail;
    const state = store.getState();
    const habitId = state.ui.contextMenuHabitId;

    store.dispatch({ type: Actions.CONTEXT_MENU_CLOSE });

    if (!habitId) return;

    switch (action) {
      case 'edit':
        // Navigate to habits tab and open edit (Phase 4)
        store.dispatch({ type: Actions.SET_ACTIVE_TAB, payload: 'habits' });
        syncTabUI('habits');
        break;

      case 'freeze':
        showToast({ type: 'success', message: 'Заморозка буде скоро.' });
        break;

      case 'delete':
        showToast({
          type: 'error',
          message: `Видалити звичку?`,
          actionLabel: 'Підтвердити',
          duration: 3600,
          onAction: () => handleDeleteHabit(habitId),
        });
        break;
    }
  });
}

function syncTabUI(tab) {
  document.querySelectorAll('.tabbar__item').forEach(b => {
    const active = b.dataset.tab === tab;
    b.classList.toggle('is-active', active);
    b.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  document.querySelectorAll('.panel').forEach(p => {
    p.classList.toggle('is-active', p.dataset.tab === tab);
  });
}

// ─── Master subscriber ──────────────────────────────────────────────────────

function onStateChange(state, prevState, actions) {
  // Render DOM
  render(state, prevState, actions);

  // Sync overlays
  syncContextSheet(state);
  syncFiveMinModal(state);

  // Sync timer loop
  syncTimerLoop(state);

  // Sync 5-min countdown
  syncFiveMinLoop(state);

  // Dev log (disabled in production)
  // const types = actions.map(a => a.type).join(', ');
  // console.log(`[Store] ${types}`, state);
}

store.subscribe(onStateChange);

// ─── Persist to Cache ────────────────────────────────────────────────────────

/**
 * Persist subscriber: save state to localStorage on every change.
 * Debounced internally by saveToCache.
 */
store.subscribe((state, prevState) => {
  // Only persist if we have real data (not just loading states)
  if (state.me && state.habits.length > 0) {
    saveToCache(state);
  }
});

// ─── Boot ────────────────────────────────────────────────────────────────────

/**
 * Offline-first boot sequence:
 * 1. Hydrate from localStorage cache (instant UI)
 * 2. Fetch from API (revalidation)
 * 3. API data wins → update store → persist to cache
 */
async function boot() {
  if (!isInTelegram) return;

  // ── Phase 1: Instant Hydration ──
  const cached = loadFromCache();
  if (cached && cached.habits?.length > 0) {
    // Hydrate from cache for instant UI
    store.dispatch({ type: Actions.HYDRATE_FROM_CACHE, payload: cached });
    // Don't show skeleton — we have data!
  } else {
    // No cache → show skeleton
    store.dispatch({ type: Actions.SET_LOADING, payload: { me: true } });
  }

  store.dispatch({ type: Actions.CLEAR_ERROR });

  // ── Phase 2: Background Revalidation ──
  try {
    const data = await loadMe();
    console.log('[Boot] loadMe OK — habits:', data?.habits?.length, '| todayCheckins:', Object.keys(data?.todayCheckins || {}).length);

    // API wins: update store with fresh data
    store.dispatch({ type: Actions.SET_ME, payload: data });

    // Track app opened
    track('app_opened');

    // Ensure routines
    const routines = data?.routines || data?.user?.routines || [];
    if (routines.length > 0) {
      store.dispatch({ type: Actions.SET_ROUTINES, payload: routines });
    }

    // Load heatmap data (non-blocking)
    loadHeatmap(60).then(hm => {
      if (hm?.data) {
        // Convert array to { [date]: pct } object
        const heatmapData = {};
        for (const row of hm.data) {
          heatmapData[row.date] = Math.round((row.completion || 0) * 100);
        }
        store.dispatch({ type: Actions.SET_STATS, payload: { heatmap: heatmapData } });
      }
    }).catch((err) => {
      logApiError(err, 'loadHeatmap');
    }); // heatmap is optional

  } catch (err) {
    console.error('[Boot] loadMe failed:', err);
    logApiError(err, 'loadMe');

    // If we have cached data, don't show error — work offline
    if (!cached || !cached.habits?.length) {
      store.dispatch({ type: Actions.SET_ERROR, payload: err });
      haptic('error');
    } else {
      // Working offline with cached data
      showToast({
        type: 'warning',
        message: 'Немає зв\'язку. Працюємо офлайн.',
        duration: 3000,
      });
    }
  } finally {
    store.dispatch({ type: Actions.SET_LOADING, payload: { me: false } });
  }
}

// ─── Init ────────────────────────────────────────────────────────────────────

initRenderer();

initInteractions({
  store,
  onHabitTap:    handleHabitTap,
  onRoutineTap:  handleRoutineTap,
  onLongPress:   handleLongPress,
  onCounterTap:  handleCounterTap,
  onTimerToggle: handleTimerToggle,
  onAddHabit:    handleAddHabit,
  onRetry:       boot,
  onListItemTap: handleListItemTap,
});

setupSheetActionHandler();

// Phase 4 — DnD, Social Shame, Settings
const $grid = document.getElementById('bento-grid');
if ($grid) {
  initDragDrop($grid, { onReorder: handleReorder });
}

initSettings(store);
initSocialShame(store, showToast);

// Kick off
boot();
