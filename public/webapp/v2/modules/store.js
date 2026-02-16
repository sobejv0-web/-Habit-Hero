// =============================================================================
// store.js — Centralised State Management for Habit System v2
// Pattern: single source of truth, dispatch → reduce → notify → render
// + Offline-first: localStorage cache with hydration & revalidation
// =============================================================================

'use strict';

// ─── LocalStorage Cache ──────────────────────────────────────────────────────

const LS_CACHE_KEY = 'habit_cache_v2';
const CACHE_VERSION = 1;
let _saveTimer = null;
const SAVE_DEBOUNCE_MS = 1000;

/**
 * Load cached state from localStorage.
 * Returns partial state object or null if cache is invalid/missing.
 */
export function loadFromCache() {
  try {
    const raw = localStorage.getItem(LS_CACHE_KEY);
    if (!raw) return null;

    const data = JSON.parse(raw);

    // Version check
    if (data._version !== CACHE_VERSION) {
      localStorage.removeItem(LS_CACHE_KEY);
      return null;
    }

    // Staleness check: cache older than 7 days is considered stale
    const age = Date.now() - (data._timestamp || 0);
    if (age > 7 * 24 * 60 * 60 * 1000) {
      localStorage.removeItem(LS_CACHE_KEY);
      return null;
    }

    return {
      me: data.me || null,
      habits: Array.isArray(data.habits) ? data.habits : [],
      checkins: data.checkins || {},
      routines: Array.isArray(data.routines) ? data.routines : [],
      trial: data.trial || null,
      features: data.features || null,
      stats: data.stats || {},
      _fromCache: true,
      _cacheTimestamp: data._timestamp,
    };
  } catch (err) {
    console.warn('[Cache] Failed to load:', err);
    return null;
  }
}

/**
 * Save relevant state slices to localStorage (debounced).
 * @param {Object} state - Current store state
 */
export function saveToCache(state) {
  if (_saveTimer) clearTimeout(_saveTimer);

  _saveTimer = setTimeout(() => {
    try {
      const data = {
        _version: CACHE_VERSION,
        _timestamp: Date.now(),
        me: state.me,
        habits: state.habits,
        checkins: state.checkins,
        routines: state.routines,
        trial: state.trial,
        features: state.features,
        stats: state.stats,
      };
      localStorage.setItem(LS_CACHE_KEY, JSON.stringify(data));
    } catch (err) {
      console.warn('[Cache] Failed to save:', err);
    }
  }, SAVE_DEBOUNCE_MS);
}

/**
 * Clear the cache (for logout or reset).
 */
export function clearCache() {
  localStorage.removeItem(LS_CACHE_KEY);
}

// ─── Action Types ────────────────────────────────────────────────────────────

export const Actions = Object.freeze({
  // ── Bootstrap ──
  INIT:                  'INIT',
  HYDRATE_FROM_CACHE:    'HYDRATE_FROM_CACHE',
  SET_ME:                'SET_ME',
  SET_HABITS:            'SET_HABITS',
  SET_CHECKINS:          'SET_CHECKINS',
  SET_ROUTINES:          'SET_ROUTINES',

  // ── Habit CRUD ──
  ADD_HABIT:             'ADD_HABIT',
  UPDATE_HABIT:          'UPDATE_HABIT',
  DELETE_HABIT:          'DELETE_HABIT',
  REORDER_HABITS:        'REORDER_HABITS',

  // ── Boolean intent ──
  HABIT_TAP:             'HABIT_TAP',

  // ── Counter ──
  COUNTER_INCREMENT:     'COUNTER_INCREMENT',
  COUNTER_SET:           'COUNTER_SET',

  // ── Timer ──
  TIMER_START:           'TIMER_START',
  TIMER_STOP:            'TIMER_STOP',
  TIMER_TICK:            'TIMER_TICK',
  TIMER_RESET:           'TIMER_RESET',

  // ── Optimistic UI ──
  OPTIMISTIC_APPLY:      'OPTIMISTIC_APPLY',
  OPTIMISTIC_ROLLBACK:   'OPTIMISTIC_ROLLBACK',
  OPTIMISTIC_FINALIZE:   'OPTIMISTIC_FINALIZE',

  // ── 5-minute rule ──
  FIVE_MIN_SHOW:         'FIVE_MIN_SHOW',
  FIVE_MIN_ACCEPT:       'FIVE_MIN_ACCEPT',
  FIVE_MIN_TICK:         'FIVE_MIN_TICK',
  FIVE_MIN_DONE:         'FIVE_MIN_DONE',
  FIVE_MIN_DISMISS:      'FIVE_MIN_DISMISS',

  // ── Focus mode ──
  FOCUS_START:           'FOCUS_START',
  FOCUS_NEXT:            'FOCUS_NEXT',
  FOCUS_EXIT:            'FOCUS_EXIT',

  // ── UI chrome ──
  SET_ACTIVE_TAB:        'SET_ACTIVE_TAB',
  CONTEXT_MENU_OPEN:     'CONTEXT_MENU_OPEN',
  CONTEXT_MENU_CLOSE:    'CONTEXT_MENU_CLOSE',
  SET_LOADING:           'SET_LOADING',
  SET_ERROR:             'SET_ERROR',
  CLEAR_ERROR:           'CLEAR_ERROR',
  SET_STATS:             'SET_STATS',
});

// ─── Initial State ───────────────────────────────────────────────────────────

function createInitialState() {
  return {
    // ── Server data ──
    me: null,
    habits: [],
    checkins: {},           // { [habitId]: { status, counterValue?, timerElapsed? } }
    routines: [],
    trial: { active: false, daysLeft: 0, trialUntil: null },
    features: {
      isPremium: false,
      routines: true,
      routineLimit: 1,
      unlimitedHabits: false,
      heatmap365: false,
      perHabitReminders: false,
      streakFreeze: false,
    },

    // ── Focus mode ──
    focus: {
      active: false,
      routineId: null,
      stepIndex: 0,
    },

    // ── Optimistic bookkeeping ──
    optimistic: {
      inFlight: {},         // { [habitId]: true }
      queued: {},            // { [habitId]: intent }
      snapshots: {},         // { [habitId]: checkinBefore | null }
    },

    // ── UI state ──
    ui: {
      activeTab: 'dashboard',
      activeModal: null,            // 'five-min-rule' | 'context-menu' | null
      contextMenuHabitId: null,
      contextMenuScope: 'habit',    // 'habit' | 'routine'
      fiveMin: {
        habitId: null,
        remaining: 300,             // seconds
        running: false,
      },
      dragging: false,
    },

    // ── Stats data (heatmap, analytics) ──
    stats: {},

    // ── Loading / errors ──
    loading: {
      me: false,
      habits: false,
      byHabitId: {},
    },
    error: null,
  };
}

// ─── Pure Helpers ─────────────────────────────────────────────────────────────

/**
 * Shallow-clone object, replacing keys. A tiny immutable helper.
 */
function patch(obj, changes) {
  return Object.assign({}, obj, changes);
}

/**
 * Return next intent for Boolean habit cycle: none → done → skip → undo.
 */
function nextBooleanIntent(currentStatus) {
  if (currentStatus === 'done') return 'skip';
  if (currentStatus === 'skip') return 'undo';
  return 'done';                       // 'none' or undefined → done
}

/**
 * Derive feature flags from /api/me payload.
 */
function deriveFeatures(me) {
  const plan = me?.plan || me?.user?.plan || 'free';
  const isPremium = plan === 'premium';
  return {
    isPremium,
    routines: true,
    routineLimit: isPremium ? Infinity : 1,
    unlimitedHabits: isPremium,
    heatmap365: isPremium,
    perHabitReminders: isPremium,
    streakFreeze: isPremium,
  };
}

/**
 * Derive trial info from /api/me payload.
 */
function deriveTrial(me) {
  const raw = me?.trialUntil || me?.user?.trial_until;
  if (!raw) return { active: false, daysLeft: 0, trialUntil: null };
  const until = new Date(raw);
  if (Number.isNaN(until.getTime())) return { active: false, daysLeft: 0, trialUntil: null };
  const diff = until.getTime() - Date.now();
  return {
    active: diff > 0,
    daysLeft: Math.max(0, Math.ceil(diff / 86_400_000)),
    trialUntil: until.toISOString(),
  };
}

/**
 * Sort habits by sort_order.
 */
function sortHabits(habits) {
  return [...habits].sort((a, b) => {
    const ao = Number.isFinite(a.sort_order) ? a.sort_order : 0;
    const bo = Number.isFinite(b.sort_order) ? b.sort_order : 0;
    return ao - bo;
  });
}

// ─── Reducer ──────────────────────────────────────────────────────────────────

/**
 * Pure reducer. Takes current state + action, returns NEW state object.
 * State is treated as immutable — every branch returns a new top-level ref.
 */
function reduce(state, action) {
  const { type, payload } = action;

  switch (type) {

    // ════════════════════  Bootstrap  ════════════════════

    case Actions.INIT:
      return createInitialState();

    case Actions.HYDRATE_FROM_CACHE: {
      // Merge cached data into current state (instant UI)
      // Preserves UI state, only hydrates server data
      const cached = payload;
      if (!cached) return state;

      return patch(state, {
        me: cached.me || state.me,
        habits: cached.habits?.length ? sortHabits(cached.habits) : state.habits,
        checkins: cached.checkins || state.checkins,
        routines: cached.routines || state.routines,
        trial: cached.trial ? cached.trial : state.trial,
        features: cached.features ? cached.features : state.features,
        stats: cached.stats || state.stats,
      });
    }

    case Actions.SET_ME: {
      const me = payload;
      return patch(state, {
        me,
        features: deriveFeatures(me),
        trial: deriveTrial(me),
        habits: sortHabits(Array.isArray(me?.habits) ? me.habits : state.habits),
        checkins: me?.todayCheckins && typeof me.todayCheckins === 'object'
          ? normalizeCheckins(me.todayCheckins)
          : state.checkins,
      });
    }

    case Actions.SET_HABITS:
      return patch(state, { habits: sortHabits(payload) });

    case Actions.SET_CHECKINS:
      return patch(state, { checkins: normalizeCheckins(payload) });

    case Actions.SET_ROUTINES:
      return patch(state, { routines: payload });

    // ════════════════════  Habit CRUD  ════════════════════

    case Actions.ADD_HABIT:
      return patch(state, {
        habits: sortHabits([...state.habits, payload]),
      });

    case Actions.UPDATE_HABIT:
      return patch(state, {
        habits: sortHabits(
          state.habits.map((h) => (h.id === payload.id ? patch(h, payload) : h))
        ),
      });

    case Actions.DELETE_HABIT: {
      const id = payload;
      const newCheckins = { ...state.checkins };
      delete newCheckins[id];
      return patch(state, {
        habits: state.habits.filter((h) => h.id !== id),
        checkins: newCheckins,
        routines: state.routines.map((r) => patch(r, {
          habitIds: (r.habitIds || []).filter((hid) => hid !== id),
        })),
      });
    }

    case Actions.REORDER_HABITS:
      // payload = [{ id, sort_order }, ...]
      return patch(state, {
        habits: sortHabits(
          state.habits.map((h) => {
            const update = payload.find((u) => u.id === h.id);
            return update ? patch(h, { sort_order: update.sort_order }) : h;
          })
        ),
      });

    // ════════════════════  Boolean Tap  ════════════════════

    case Actions.HABIT_TAP: {
      const { habitId } = payload;
      const current = state.checkins[habitId]?.status || 'none';
      const intent = nextBooleanIntent(current);
      if (intent === 'undo') {
        const c = { ...state.checkins };
        delete c[habitId];
        return patch(state, { checkins: c });
      }
      return patch(state, {
        checkins: patch(state.checkins, {
          [habitId]: { status: intent },
        }),
      });
    }

    // ════════════════════  Counter  ════════════════════

    case Actions.COUNTER_INCREMENT: {
      const { habitId, step } = payload;
      const prev = state.checkins[habitId] || { status: 'none', counterValue: 0 };
      const newValue = (prev.counterValue || 0) + (step || 1);
      const habit = state.habits.find((h) => h.id === habitId);
      const target = habit?.counterTarget || Infinity;
      const status = newValue >= target ? 'done' : 'none';
      return patch(state, {
        checkins: patch(state.checkins, {
          [habitId]: { status, counterValue: newValue },
        }),
      });
    }

    case Actions.COUNTER_SET: {
      const { habitId, value } = payload;
      const habit = state.habits.find((h) => h.id === habitId);
      const target = habit?.counterTarget || Infinity;
      const status = value >= target ? 'done' : 'none';
      return patch(state, {
        checkins: patch(state.checkins, {
          [habitId]: { status, counterValue: value },
        }),
      });
    }

    // ════════════════════  Timer  ════════════════════

    case Actions.TIMER_START: {
      const { habitId } = payload;
      const prev = state.checkins[habitId] || { status: 'none', timerElapsed: 0 };
      return patch(state, {
        checkins: patch(state.checkins, {
          [habitId]: patch(prev, { timerRunning: true }),
        }),
      });
    }

    case Actions.TIMER_STOP: {
      const { habitId } = payload;
      const prev = state.checkins[habitId];
      if (!prev) return state;
      return patch(state, {
        checkins: patch(state.checkins, {
          [habitId]: patch(prev, { timerRunning: false }),
        }),
      });
    }

    case Actions.TIMER_TICK: {
      const { habitId, elapsed } = payload;
      const prev = state.checkins[habitId];
      if (!prev) return state;
      const habit = state.habits.find((h) => h.id === habitId);
      const target = habit?.timerDuration || Infinity;
      const status = elapsed >= target ? 'done' : prev.status;
      return patch(state, {
        checkins: patch(state.checkins, {
          [habitId]: patch(prev, { timerElapsed: elapsed, status }),
        }),
      });
    }

    case Actions.TIMER_RESET: {
      const { habitId } = payload;
      const prev = state.checkins[habitId];
      if (!prev) return state;
      return patch(state, {
        checkins: patch(state.checkins, {
          [habitId]: patch(prev, { timerElapsed: 0, timerRunning: false, status: 'none' }),
        }),
      });
    }

    // ════════════════════  Optimistic UI  ════════════════════

    case Actions.OPTIMISTIC_APPLY: {
      const { habitId, intent } = payload;
      // Save snapshot before mutation
      const snapshot = state.checkins[habitId] ?? null;
      const newOptimistic = patch(state.optimistic, {
        inFlight: patch(state.optimistic.inFlight, { [habitId]: true }),
        snapshots: patch(state.optimistic.snapshots, { [habitId]: snapshot }),
      });

      // Apply the intent to checkins (same logic as HABIT_TAP but explicit)
      let newCheckins;
      if (intent === 'undo') {
        newCheckins = { ...state.checkins };
        delete newCheckins[habitId];
      } else {
        newCheckins = patch(state.checkins, {
          [habitId]: { status: intent },
        });
      }

      return patch(state, {
        checkins: newCheckins,
        optimistic: newOptimistic,
        loading: patch(state.loading, {
          byHabitId: patch(state.loading.byHabitId, { [habitId]: true }),
        }),
      });
    }

    case Actions.OPTIMISTIC_ROLLBACK: {
      const { habitId } = payload;
      const snapshot = state.optimistic.snapshots[habitId];
      const newCheckins = { ...state.checkins };
      if (snapshot === null || snapshot === undefined) {
        delete newCheckins[habitId];
      } else {
        newCheckins[habitId] = snapshot;
      }

      const newSnapshots = { ...state.optimistic.snapshots };
      delete newSnapshots[habitId];
      const newInFlight = { ...state.optimistic.inFlight };
      delete newInFlight[habitId];
      const newQueued = { ...state.optimistic.queued };
      delete newQueued[habitId];

      return patch(state, {
        checkins: newCheckins,
        optimistic: patch(state.optimistic, {
          inFlight: newInFlight,
          snapshots: newSnapshots,
          queued: newQueued,
        }),
        loading: patch(state.loading, {
          byHabitId: patch(state.loading.byHabitId, { [habitId]: false }),
        }),
      });
    }

    case Actions.OPTIMISTIC_FINALIZE: {
      const { habitId, serverStatus } = payload;
      // Server confirmed — apply server truth
      const newCheckins = { ...state.checkins };
      if (serverStatus === 'done' || serverStatus === 'skip') {
        newCheckins[habitId] = { status: serverStatus };
      } else {
        delete newCheckins[habitId];
      }

      const newSnapshots = { ...state.optimistic.snapshots };
      delete newSnapshots[habitId];
      const newInFlight = { ...state.optimistic.inFlight };
      delete newInFlight[habitId];

      // Process queued intent if any
      const queuedIntent = state.optimistic.queued[habitId];
      const newQueued = { ...state.optimistic.queued };
      delete newQueued[habitId];

      const nextState = patch(state, {
        checkins: newCheckins,
        optimistic: patch(state.optimistic, {
          inFlight: newInFlight,
          snapshots: newSnapshots,
          queued: newQueued,
        }),
        loading: patch(state.loading, {
          byHabitId: patch(state.loading.byHabitId, { [habitId]: false }),
        }),
      });

      // If there was a queued intent, we tag it for the caller to process
      // (side-effects like new API calls happen outside the reducer)
      if (queuedIntent) {
        nextState._sideEffect = { type: 'QUEUED_INTENT', habitId, intent: queuedIntent };
      }

      return nextState;
    }

    // ════════════════════  5-Minute Rule  ════════════════════

    case Actions.FIVE_MIN_SHOW:
      return patch(state, {
        ui: patch(state.ui, {
          activeModal: 'five-min-rule',
          fiveMin: { habitId: payload.habitId, remaining: 300, running: false },
        }),
      });

    case Actions.FIVE_MIN_ACCEPT:
      return patch(state, {
        ui: patch(state.ui, {
          activeModal: null,
          fiveMin: patch(state.ui.fiveMin, { running: true }),
        }),
      });

    case Actions.FIVE_MIN_TICK: {
      const remaining = Math.max(0, state.ui.fiveMin.remaining - 1);
      const done = remaining === 0;
      return patch(state, {
        ui: patch(state.ui, {
          fiveMin: patch(state.ui.fiveMin, {
            remaining,
            running: !done,
          }),
        }),
      });
    }

    case Actions.FIVE_MIN_DONE:
    case Actions.FIVE_MIN_DISMISS:
      return patch(state, {
        ui: patch(state.ui, {
          activeModal: null,
          fiveMin: { habitId: null, remaining: 300, running: false },
        }),
      });

    // ════════════════════  Focus mode  ════════════════════

    case Actions.FOCUS_START: {
      const { routineId } = payload;
      return patch(state, {
        focus: { active: true, routineId, stepIndex: 0 },
      });
    }

    case Actions.FOCUS_NEXT:
      return patch(state, {
        focus: patch(state.focus, {
          stepIndex: state.focus.stepIndex + 1,
        }),
      });

    case Actions.FOCUS_EXIT:
      return patch(state, {
        focus: { active: false, routineId: null, stepIndex: 0 },
      });

    // ════════════════════  UI chrome  ════════════════════

    case Actions.SET_ACTIVE_TAB:
      return patch(state, {
        ui: patch(state.ui, { activeTab: payload }),
      });

    case Actions.CONTEXT_MENU_OPEN:
      return patch(state, {
        ui: patch(state.ui, {
          activeModal: 'context-menu',
          contextMenuHabitId: payload.habitId ?? null,
          contextMenuScope: payload.scope || 'habit',
        }),
      });

    case Actions.CONTEXT_MENU_CLOSE:
      return patch(state, {
        ui: patch(state.ui, {
          activeModal: null,
          contextMenuHabitId: null,
          contextMenuScope: 'habit',
        }),
      });

    case Actions.SET_LOADING:
      return patch(state, {
        loading: patch(state.loading, payload),
      });

    case Actions.SET_ERROR:
      return patch(state, { error: payload });

    case Actions.CLEAR_ERROR:
      return patch(state, { error: null });

    case Actions.SET_STATS:
      return patch(state, {
        stats: patch(state.stats, payload),
      });

    // ── Default (unknown action — return unchanged) ──
    default:
      if (typeof console !== 'undefined') {
        console.warn(`[Store] Unknown action: ${type}`);
      }
      return state;
  }
}

// ─── Normalise legacy checkin format ─────────────────────────────────────────

/**
 * The v1 API returns todayCheckins as { [id]: 'done'|'skip' }.
 * v2 store expects { [id]: { status, counterValue?, timerElapsed? } }.
 * This function normalises both formats.
 */
function normalizeCheckins(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const [id, value] of Object.entries(raw)) {
    if (typeof value === 'string') {
      out[id] = { status: value };
    } else if (value && typeof value === 'object') {
      out[id] = value;
    }
  }
  return out;
}

// ─── Store Class ──────────────────────────────────────────────────────────────

export class Store {
  /** @type {Object} */
  #state;

  /** @type {Set<Function>} */
  #listeners = new Set();

  /** @type {boolean} */
  #notifyScheduled = false;

  /** @type {Function[]} - middleware pipeline: (store, action) => action|null */
  #middleware = [];

  /** @type {Object|null} - previous state (for diffing in listeners) */
  #prevState = null;

  /** @type {Array} - actions batched during current microtask */
  #batch = [];

  /**
   * @param {Object} [preloadedState] Optional initial state (for tests / SSR).
   */
  constructor(preloadedState) {
    this.#state = preloadedState || createInitialState();
    this.#prevState = this.#state;
  }

  // ── Public API ──

  /**
   * Returns current state snapshot (read-only by convention).
   */
  getState() {
    return this.#state;
  }

  /**
   * Returns previous state (before the latest batch of dispatches).
   * Useful for diffing inside subscribers.
   */
  getPrevState() {
    return this.#prevState;
  }

  /**
   * Dispatch an action: { type: string, payload?: any }.
   * Multiple dispatches in the same microtask are batched into a single
   * subscriber notification (one render pass).
   *
   * @param {Object} action - { type, payload }
   * @returns {Object|null} side-effect descriptor if any, else null
   */
  dispatch(action) {
    if (!action || !action.type) {
      throw new Error('[Store] dispatch requires an action with a .type');
    }

    // Run middleware — any middleware can transform or swallow the action
    let current = action;
    for (const mw of this.#middleware) {
      current = mw(this, current);
      if (!current) return null; // middleware swallowed the action
    }

    // Reduce
    const nextState = reduce(this.#state, current);

    // Extract and clear transient side-effect before assigning state
    const sideEffect = nextState._sideEffect || null;
    if (sideEffect) delete nextState._sideEffect;

    this.#state = nextState;
    this.#batch.push(current);

    // Schedule a single notification per microtask
    if (!this.#notifyScheduled) {
      this.#notifyScheduled = true;
      queueMicrotask(() => this.#flush());
    }

    return sideEffect;
  }

  /**
   * Subscribe to state changes. Called once after each batch of dispatches.
   *
   * @param {Function} listener - fn(state, prevState, actions[])
   * @returns {Function} unsubscribe
   */
  subscribe(listener) {
    if (typeof listener !== 'function') {
      throw new Error('[Store] subscribe expects a function');
    }
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Register middleware. Middleware signature: (store, action) => action|null.
   * Return the action (possibly transformed) to continue, or null to swallow.
   */
  use(middleware) {
    if (typeof middleware !== 'function') {
      throw new Error('[Store] middleware must be a function');
    }
    this.#middleware.push(middleware);
    return this;
  }

  /**
   * Convenience: check if a specific habit has an in-flight API call.
   */
  isInFlight(habitId) {
    return !!this.#state.optimistic.inFlight[habitId];
  }

  /**
   * Convenience: get checkin status for a habit.
   */
  getCheckinStatus(habitId) {
    return this.#state.checkins[habitId]?.status || 'none';
  }

  /**
   * Convenience: queue an intent for when current in-flight resolves.
   */
  queueIntent(habitId, intent) {
    this.#state = patch(this.#state, {
      optimistic: patch(this.#state.optimistic, {
        queued: patch(this.#state.optimistic.queued, { [habitId]: intent }),
      }),
    });
  }

  // ── Private ──

  /**
   * Flush batched dispatches: notify all listeners once.
   */
  #flush() {
    this.#notifyScheduled = false;
    const actions = this.#batch.slice();
    this.#batch.length = 0;

    const prev = this.#prevState;
    const current = this.#state;
    this.#prevState = current;

    // Skip if nothing changed (same reference)
    if (prev === current) return;

    for (const listener of this.#listeners) {
      try {
        listener(current, prev, actions);
      } catch (err) {
        console.error('[Store] subscriber error:', err);
      }
    }
  }
}

// ─── Singleton Factory ───────────────────────────────────────────────────────

let _instance = null;

/**
 * Get (or create) the singleton Store instance.
 * @param {Object} [preloaded] - initial state for first creation
 * @returns {Store}
 */
export function getStore(preloaded) {
  if (!_instance) {
    _instance = new Store(preloaded);
  }
  return _instance;
}

// ─── Selector helpers (pure functions) ───────────────────────────────────────

export const Selectors = {
  /**
   * All habits, already sorted.
   */
  habits: (s) => s.habits,

  /**
   * Habits not yet checked in today.
   */
  pendingHabits: (s) =>
    s.habits.filter((h) => {
      const ci = s.checkins[h.id];
      return !ci || ci.status === 'none';
    }),

  /**
   * Number done / total for today.
   */
  todayProgress: (s) => {
    const total = s.habits.length;
    let done = 0;
    let skip = 0;
    for (const h of s.habits) {
      const st = s.checkins[h.id]?.status;
      if (st === 'done') done++;
      else if (st === 'skip') skip++;
    }
    return { total, done, skip, percent: total ? Math.round((done / total) * 100) : 0 };
  },

  /**
   * Is the 5-min timer actively counting down inside a card?
   */
  fiveMinActive: (s) => s.ui.fiveMin.running && s.ui.fiveMin.remaining > 0,

  /**
   * Hero habit — first pending habit, or first habit.
   */
  heroHabit: (s) => {
    const pending = s.habits.find((h) => {
      const ci = s.checkins[h.id];
      return !ci || ci.status === 'none';
    });
    return pending || s.habits[0] || null;
  },

  /**
   * Active tab.
   */
  activeTab: (s) => s.ui.activeTab,
};

// Re-export helpers so other modules can derive features/trial
export { deriveFeatures, deriveTrial, nextBooleanIntent, normalizeCheckins };
