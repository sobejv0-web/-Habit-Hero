const overlay = document.getElementById('telegram-only');
const overlayTitle = overlay ? overlay.querySelector('h2') : null;
const overlayText = overlay ? overlay.querySelector('p') : null;
const overlayCard = overlay ? overlay.querySelector('.overlay-card') : null;
const appShell = document.getElementById('app-shell');
const trialBackdrop = document.getElementById('trial-backdrop');
const trialSheet = document.getElementById('trial-sheet');
const trialSheetTitle = document.getElementById('trial-sheet-title');
const trialSheetBody = document.getElementById('trial-sheet-body');
const trialSheetAccept = document.getElementById('trial-sheet-accept');
const trialSheetLater = document.getElementById('trial-sheet-later');
const premiumBackdrop = document.getElementById('premium-backdrop');
const premiumModal = document.getElementById('premium-modal');
const premiumModalClose = document.getElementById('premium-modal-close');
const premiumModalCta = document.getElementById('premium-modal-cta');
const premiumModalLater = document.getElementById('premium-modal-later');

const tg = window.Telegram?.WebApp;
const isInTelegram = !!tg;
let initData = '';
let booted = false;

function showOverlay(title, text) {
  if (overlayTitle) overlayTitle.textContent = title;
  if (overlayText) overlayText.textContent = text;
  overlay.hidden = false;
  appShell.hidden = true;
}

function hideOverlay() {
  overlay.hidden = true;
  appShell.hidden = false;
}

function clearOverlayExtras() {
  if (!overlayCard) return;
  const existing = overlayCard.querySelector('.overlay-extra');
  if (existing) existing.remove();
}

function showOpenInsideTelegram() {
  clearOverlayExtras();
  showOverlay('Відкрий у Telegram', 'Цей WebApp працює лише всередині Telegram.');
}

function showLoadingScreen(message) {
  clearOverlayExtras();
  showOverlay('Зʼєднання з Telegram...', message);
}

function showRetryScreen(message) {
  clearOverlayExtras();
  showOverlay('Telegram не передав дані', message);

  if (!overlayCard) return;
  const extra = document.createElement('div');
  extra.className = 'overlay-extra';

  const hint = document.createElement('div');
  hint.className = 'overlay-hint';
  hint.textContent = 'Після цього натисни «Повторити».';

  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'overlay-button';
  retry.textContent = 'Повторити';
  retry.addEventListener('click', () => startInitFlow(true));

  extra.appendChild(hint);
  extra.appendChild(retry);
  overlayCard.appendChild(extra);
}

function showTrialSheet({ title, body }) {
  if (!trialSheet || !trialBackdrop) return;
  if (title && trialSheetTitle) trialSheetTitle.textContent = title;
  if (body && trialSheetBody) trialSheetBody.textContent = body;
  trialBackdrop.hidden = false;
  trialSheet.hidden = false;
  requestAnimationFrame(() => {
    trialSheet.classList.add('is-open');
  });
}

function hideTrialSheet() {
  if (!trialSheet || !trialBackdrop) return;
  trialSheet.classList.remove('is-open');
  setTimeout(() => {
    trialSheet.hidden = true;
    trialBackdrop.hidden = true;
  }, 160);
}

function openPremiumModal(source = 'paywall', options = {}) {
  if (!premiumModal || !premiumBackdrop) return;
  const { force = false } = options;
  if (!force && state.features?.isPremium) return;
  premiumBackdrop.hidden = false;
  premiumModal.hidden = false;
  requestAnimationFrame(() => {
    premiumModal.classList.add('is-open');
  });
  track('premium_interest_clicked', { source, surface: 'modal' });
}

function closePremiumModal() {
  if (!premiumModal || !premiumBackdrop) return;
  premiumModal.classList.remove('is-open');
  setTimeout(() => {
    premiumModal.hidden = true;
    premiumBackdrop.hidden = true;
  }, 160);
}

function bootOnce() {
  if (booted) return;
  booted = true;
  boot();
}

function getTelegramState() {
  const state = {
    tg: window.Telegram?.WebApp,
  };
  state.isInTelegram = !!state.tg;
  initData = state.tg?.initData || '';
  state.initData = initData;
  state.canCallApi = initData.length > 0;
  return state;
}

function startInitFlow() {
  if (!isInTelegram) {
    showOpenInsideTelegram();
    return;
  }

  try {
    tg.ready();
    tg.expand();
  } catch {
    // ignore
  }

  const state = getTelegramState();
  initData = state.initData;

  if (initData.length) {
    hideOverlay();
    bootOnce();
    return;
  }

  showLoadingScreen('Підключення до Telegram...');
  setTimeout(() => {
    const retryState = getTelegramState();
    initData = retryState.initData;
    if (retryState.canCallApi) {
      hideOverlay();
      bootOnce();
      return;
    }

    showRetryScreen(
      'Telegram не передав дані. Відкрий через кнопку бота або через меню.'
    );
  }, 1500);
}

// ------------------------------------------------------------
// Step D: Data layer (API wrapper + global state)
// ------------------------------------------------------------

const API_TIMEOUT_MS = 10000; // 10s timeout keeps UI responsive.
const NETWORK_RETRY_LIMIT = 1; // Exactly one retry on network failure.
const BUILD_ID = '2026.02.13';
const TRIAL_LENGTH_DAYS = 7;

function formatDays(count) {
  const value = Math.abs(Number(count) || 0);
  const mod10 = value % 10;
  const mod100 = value % 100;
  if (mod10 === 1 && mod100 !== 11) return 'день';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'дні';
  return 'днів';
}

function getTrialInfo(me) {
  const trialUntil = me?.trialUntil || me?.user?.trial_until;
  if (!trialUntil) {
    return { active: false, daysLeft: 0, trialUntil: null };
  }

  const until = new Date(trialUntil);
  if (Number.isNaN(until.getTime())) {
    return { active: false, daysLeft: 0, trialUntil: null };
  }

  const now = new Date();
  const diffMs = until.getTime() - now.getTime();
  const daysLeft = Math.max(0, Math.ceil(diffMs / (24 * 60 * 60 * 1000)));
  return {
    active: diffMs > 0,
    daysLeft,
    trialUntil: until.toISOString(),
  };
}

function isSubscriptionActive(value) {
  if (!value) return false;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.getTime() > Date.now();
}

function resolvePremiumStatus(me) {
  const plan = me?.plan || me?.user?.plan || 'free';
  const rawFlag = me?.user?.is_premium ?? me?.is_premium;
  if (rawFlag === true || rawFlag === 1 || rawFlag === '1' || rawFlag === 'true') return true;
  const subscriptionEnd = me?.user?.subscription_end_date || me?.subscription_end_date;
  if (isSubscriptionActive(subscriptionEnd)) return true;
  return plan === 'premium';
}

function getFeatureFlags(me) {
  const isPremium = resolvePremiumStatus(me);

  return {
    isPremium,
    routines: true,
    routineLimit: isPremium ? Number.POSITIVE_INFINITY : 1,
    unlimitedHabits: isPremium,
    heatmap365: isPremium,
    perHabitReminders: isPremium,
    streakFreeze: isPremium,
  };
}

const state = {
  me: null, // /api/me response
  habits: [],
  todayCheckins: {},
  features: getFeatureFlags({ plan: 'free' }),
  trial: getTrialInfo({}),
  routines: [],
  focus: {
    active: false,
    routineId: null,
    stepIndex: 0,
  },
  loading: {
    me: false,
    actionByHabitId: {},
  },
  errors: null,
  inFlightByHabitId: {},
  queuedIntentByHabitId: {},
  optimisticPrevByHabitId: {},
  analytics: {
    appOpened: false,
    heatmapOpened: false,
  },
};

function getTrialStorageKey(suffix) {
  const userId = state.me?.user?.id || state.me?.user_id || state.me?.id || 'guest';
  return `trial_${suffix}_${userId}`;
}

function maybeShowTrialDay5Sheet() {
  const trial = state.trial;
  if (!trial?.active || !trial.daysLeft) return;
  if (trial.daysLeft > 2) return;
  const key = `${getTrialStorageKey('day5')}_${new Date().toISOString().slice(0, 10)}`;
  if (localStorage.getItem(key)) return;
  localStorage.setItem(key, '1');
  showTrialSheet({
    title: 'Ти вже 5 днів з нами 💪',
    body: 'Хочеш зберегти прогрес, рутини та повну історію?',
  });
  track('trial_day5_seen', { daysLeft: trial.daysLeft });
}

function maybeShowTrialEndedToast() {
  const trial = state.trial;
  const hasTrial = !!(state.me?.trialUntil || state.me?.user?.trial_until);
  if (!hasTrial || trial?.active) return;
  const trialUntil = state.me?.trialUntil || state.me?.user?.trial_until || '';
  const key = `${getTrialStorageKey('ended')}_${String(trialUntil).slice(0, 10)}`;
  if (localStorage.getItem(key)) return;
  localStorage.setItem(key, '1');
  showToast({
    type: 'error',
    message: 'Trial завершився. Деякі можливості обмежені.',
    duration: 2600,
  });
  track('trial_expired_seen', { trialUntil: String(trialUntil).slice(0, 10) });
}

function maybeShowTrialPrompts() {
  maybeShowTrialDay5Sheet();
  maybeShowTrialEndedToast();
}

function trackTrialStarted() {
  const trial = state.trial;
  if (!trial?.active) return;
  const trialUntil = state.me?.trialUntil || state.me?.user?.trial_until || '';
  const key = `${getAnalyticsKey('trial_started', String(trialUntil).slice(0, 10))}`;
  if (localStorage.getItem(key)) return;
  localStorage.setItem(key, '1');
  track('trial_started', { daysLeft: trial.daysLeft });
}

function trackAppOpened() {
  const dateKey = getUserDateKey();
  const key = getAnalyticsKey('app_opened', dateKey);
  if (localStorage.getItem(key)) return;
  localStorage.setItem(key, '1');
  track('app_opened', { date: dateKey });
}

function openPremiumInterest(source = 'settings') {
  track('premium_interest_clicked', { source });
  const username = state.me?.botUsername || '';
  if (!username) {
    showToast({ type: 'error', message: 'Не вдалося відкрити бота.' });
    return;
  }
  const link = `https://t.me/${username}?start=premium_interest`;
  if (tg?.openTelegramLink) {
    tg.openTelegramLink(link);
    return;
  }
  window.open(link, '_blank');
}

let mePromise = null;

function normalizeHttpError(status, payload) {
  const message =
    payload?.error ||
    payload?.message ||
    (status ? `HTTP ${status}` : 'Request failed');
  return { type: 'http', status, message };
}

function normalizeNetworkError(error) {
  if (error?.type === 'network') return error;
  return {
    type: 'network',
    message: error?.message || 'Network error. Please try again.',
  };
}

function ensureRoutines() {
  if (!Array.isArray(state.routines)) state.routines = [];
  if (state.routines.length === 0) {
    state.routines = [
      {
        id: 'morning',
        title: 'Ранок ☀️',
        habitIds: [],
        active: true,
      },
    ];
  }

  const habitIds = new Set((state.habits || []).map((habit) => habit.id));
  state.routines = state.routines.map((routine) => {
    const unique = Array.from(new Set(routine.habitIds || []));
    return {
      ...routine,
      habitIds: unique.filter((id) => habitIds.has(id)),
    };
  });
}

function getPrimaryRoutine() {
  ensureRoutines();
  return state.routines[0] || null;
}

function isHabitInRoutine(habitId) {
  const routine = getPrimaryRoutine();
  if (!routine) return false;
  return routine.habitIds.includes(habitId);
}

function addHabitToRoutine(habitId) {
  const routine = getPrimaryRoutine();
  if (!routine) return;
  if (!routine.habitIds.includes(habitId)) {
    routine.habitIds.push(habitId);
  }
}

function removeHabitFromRoutine(habitId) {
  const routine = getPrimaryRoutine();
  if (!routine) return;
  routine.habitIds = routine.habitIds.filter((id) => id !== habitId);
}

async function apiFetch(path, options = {}, attempt = 0) {
  const headers = new Headers(options.headers || {});
  headers.set('X-TG-INIT-DATA', initData);
  headers.set('Authorization', initData);
  headers.set('Cache-Control', 'no-store');

  const hasBody = options.body !== undefined && options.body !== null;
  if (hasBody && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    const response = await fetch(path, {
      ...options,
      headers,
      cache: 'no-store',
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        // ignore JSON parse errors
      }
      throw normalizeHttpError(response.status, payload);
    }

    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      return response.json();
    }
    return response.text();
  } catch (error) {
    clearTimeout(timeoutId);
    const isNetwork =
      error?.name === 'AbortError' ||
      error instanceof TypeError ||
      error?.type === 'network';

    if (isNetwork && attempt < NETWORK_RETRY_LIMIT) {
      return apiFetch(path, options, attempt + 1);
    }

    if (error?.type === 'http') {
      throw error;
    }

    throw normalizeNetworkError(error);
  }
}

function getAnalyticsKey(name, suffix = '') {
  const userId = state.me?.user?.id || state.me?.user_id || state.me?.id || 'guest';
  return `analytics_${name}_${suffix}_${userId}`;
}

function getUserDateKey() {
  const tz = state.me?.user?.timezone;
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function track(event, meta = {}) {
  if (!state.me) return;
  const payload = { event };
  if (meta && typeof meta === 'object' && Object.keys(meta).length > 0) {
    payload.meta = meta;
  }
  apiFetch('/api/analytics', {
    method: 'POST',
    body: JSON.stringify(payload),
  }).catch(() => {});
}

async function loadMe() {
  if (mePromise) return mePromise;
  state.loading.me = true;
  state.errors = null;

  mePromise = (async () => {
    const data = await apiFetch('/api/me');
    state.me = data;
    state.habits = Array.isArray(data?.habits) ? data.habits : [];
    state.todayCheckins =
      data?.todayCheckins && typeof data.todayCheckins === 'object'
        ? { ...data.todayCheckins }
        : {};
    state.features = getFeatureFlags(data);
    state.trial = getTrialInfo(data);
    trackAppOpened();
    trackTrialStarted();
    ensureRoutines();
    return data;
  })();

  try {
    return await mePromise;
  } catch (error) {
    state.errors = error;
    throw error;
  } finally {
    state.loading.me = false;
    mePromise = null;
  }
}

function applyOptimistic(habitId, intent) {
  const previous =
    state.todayCheckins[habitId] !== undefined
      ? state.todayCheckins[habitId]
      : null;
  state.optimisticPrevByHabitId[habitId] = previous;

  if (intent === 'undo') {
    delete state.todayCheckins[habitId];
    return;
  }

  state.todayCheckins[habitId] = intent;
}

function rollbackOptimistic(habitId) {
  const previous = state.optimisticPrevByHabitId[habitId];
  if (previous === null || previous === undefined) {
    delete state.todayCheckins[habitId];
  } else {
    state.todayCheckins[habitId] = previous;
  }
  delete state.optimisticPrevByHabitId[habitId];
}

function finalizeOptimistic(habitId, payload) {
  if (payload?.status === 'done' || payload?.status === 'skip') {
    state.todayCheckins[habitId] = payload.status;
  } else {
    delete state.todayCheckins[habitId];
  }
  if (payload?.status === 'done' && state.me) {
    const current = Number(state.me.streak ?? state.me.user?.streak) || 0;
    if (current < 1) {
      if (state.me.user) state.me.user.streak = 1;
      state.me.streak = 1;
    }
  }
  delete state.optimisticPrevByHabitId[habitId];
}

async function sendHabitIntent(habitId, intent) {
  if (intent === 'undo') {
    return apiFetch('/api/today/undo', {
      method: 'POST',
      body: JSON.stringify({ habitId }),
    });
  }

  return apiFetch('/api/today/checkin', {
    method: 'POST',
    body: JSON.stringify({ habitId, status: intent }),
  });
}

async function runHabitIntent(habitId, intent) {
  if (state.inFlightByHabitId[habitId]) {
    state.queuedIntentByHabitId[habitId] = intent;
    return;
  }

  state.inFlightByHabitId[habitId] = true;
  state.loading.actionByHabitId[habitId] = true;
  state.errors = null;
  applyOptimistic(habitId, intent);

  try {
    const payload = await sendHabitIntent(habitId, intent);
    finalizeOptimistic(habitId, payload);
  } catch (error) {
    rollbackOptimistic(habitId);
    state.errors = error;
    throw error;
  } finally {
    state.inFlightByHabitId[habitId] = false;
    state.loading.actionByHabitId[habitId] = false;

    const queued = state.queuedIntentByHabitId[habitId];
    if (queued) {
      delete state.queuedIntentByHabitId[habitId];
      runHabitIntent(habitId, queued);
    }
  }
}

// ------------------------------------------------------------
// Step E: Dashboard UI wiring (Dashboard only)
// ------------------------------------------------------------

let toastElement = null;
let toastTimer = null;

function ensureToast() {
  if (toastElement) return toastElement;
  const toast = document.createElement('div');
  toast.className = 'toast';
  document.body.appendChild(toast);
  toastElement = toast;
  return toastElement;
}

function hideToast() {
  if (!toastElement) return;
  toastElement.classList.remove('show');
  if (toastTimer) {
    clearTimeout(toastTimer);
    toastTimer = null;
  }
}

function showToast({ type = 'success', message, actionLabel, onAction, duration }) {
  const toast = ensureToast();
  toast.className = `toast toast--${type}`;
  toast.textContent = '';

  const text = document.createElement('span');
  text.textContent = message;
  toast.appendChild(text);

  if (actionLabel && typeof onAction === 'function') {
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'toast__action';
    action.textContent = actionLabel;
    action.addEventListener('click', () => {
      hideToast();
      onAction();
    });
    toast.appendChild(action);
  }

  requestAnimationFrame(() => {
    toast.classList.add('show');
  });

  const timeout = duration || (type === 'error' ? 4200 : 1600);
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    hideToast();
  }, timeout);
}

const HAPTICS_KEY = 'haptics_enabled';
function isHapticsEnabled() {
  try {
    const stored = localStorage.getItem(HAPTICS_KEY);
    if (stored === null) {
      localStorage.setItem(HAPTICS_KEY, 'true');
      return true;
    }
    if (stored === '1') {
      localStorage.setItem(HAPTICS_KEY, 'true');
      return true;
    }
    if (stored === '0') {
      localStorage.setItem(HAPTICS_KEY, 'false');
      return false;
    }
    return stored === 'true';
  } catch (e) {
    return true;
  }
}

function haptic(type) {
  if (!isHapticsEnabled() || !tg?.HapticFeedback) return;
  if (type === 'success') {
    tg.HapticFeedback.notificationOccurred('success');
  } else if (type === 'error') {
    tg.HapticFeedback.notificationOccurred('error');
  }
}

function createDashboardController(navigateToTab) {
  const root = document.getElementById('dashboard');
  if (!root) {
    return { ensureLoaded: () => {}, refresh: () => {} };
  }

  const skeleton = document.getElementById('dashboard-skeleton');
  const content = document.getElementById('dashboard-content');
  const empty = document.getElementById('dashboard-empty');
  const error = document.getElementById('dashboard-error');
  const retryBtn = document.getElementById('dashboard-retry');
  const emptyCta = document.getElementById('dashboard-empty-cta');

  const heroKicker = document.getElementById('hero-kicker');
  const heroTitle = document.getElementById('hero-title');
  const heroSub = document.getElementById('hero-sub');
  const heroProgress = document.getElementById('hero-progress');
  const heroCta = document.getElementById('hero-cta');
  const heroCard = document.getElementById('hero-card');
  const heroHint = document.getElementById('hero-hint');
  const bentoItems = document.getElementById('bento-items');
  const statsProgress = document.getElementById('stats-progress');
  const statsMeta = document.getElementById('stats-meta');
  const statsStripBar = document.getElementById('stats-strip-bar');
  const dashboardTrial = document.getElementById('dashboard-trial');
  const bentoFooter = document.getElementById('bento-footer');
  const sheetBackdrop = document.getElementById('sheet-backdrop');
  const habitSheet = document.getElementById('habit-sheet');
  const habitSheetTitle = document.getElementById('habit-sheet-title');
  const focusOverlay = document.getElementById('focus-overlay');
  const focusExit = document.getElementById('focus-exit');
  const focusRoutineTitle = document.getElementById('focus-routine');
  const focusStep = document.getElementById('focus-step');
  const focusProgressBar = document.getElementById('focus-progress-bar');
  const focusTitle = document.getElementById('focus-title');
  const focusSub = document.getElementById('focus-sub');
  const focusNext = document.getElementById('focus-next');
  const focusDone = document.getElementById('focus-done');
  const focusSkip = document.getElementById('focus-skip');
  const focusTimer = document.getElementById('focus-timer');
  const focusTimerValue = document.getElementById('focus-timer-value');
  const focusTimerToggle = document.getElementById('focus-timer-toggle');
  const focusConfirm = document.getElementById('focus-confirm');
  const focusConfirmTitle = document.getElementById('focus-confirm-title');
  const focusConfirmText = document.getElementById('focus-confirm-text');
  const focusConfirmCancel = document.getElementById('focus-confirm-cancel');
  const focusConfirmExit = document.getElementById('focus-confirm-exit');
  const focusComplete = document.getElementById('focus-complete');
  const focusCompleteMeta = document.getElementById('focus-complete-meta');
  const focusCompleteBadge = document.getElementById('focus-complete-badge');
  const focusCompleteExit = document.getElementById('focus-complete-exit');

  const cardMap = new Map();
  let syncRaf = null;
  let lastCompletion = null;
  let focusHabitId = null;
  let focusPulseTimer = null;
  let sheetHabitId = null;
  let sheetScope = 'habit';
  let routineCards = new Map();
  let focusInterval = null;
  let focusRemaining = 0;
  let focusConfirmMode = 'exit';
  let focusActionLocked = false;

  const statusCopy = {
    none: 'Ще не відмічено',
    done: 'Виконано',
    skip: 'Пропущено',
  };

  if (emptyCta) {
    emptyCta.addEventListener('click', () => {
      navigateToTab('habits');
    });
  }

  if (retryBtn) {
    retryBtn.addEventListener('click', () => {
      loadDashboard();
    });
  }

  if (sheetBackdrop) {
    sheetBackdrop.addEventListener('click', () => closeSheet());
  }
  if (habitSheet) {
    habitSheet.addEventListener('click', (event) => {
      const action = event.target?.dataset?.action;
      if (!action) return;
      if (action === 'close') {
        closeSheet();
        return;
      }
      if (sheetScope === 'habit') {
        if (!sheetHabitId) return;
        if (action === 'edit-habit') {
          closeSheet();
          openHabitEdit(sheetHabitId);
          return;
        }
        if (action === 'delete-habit') {
          closeSheet();
          confirmDeleteHabit(sheetHabitId);
        }
      } else if (sheetScope === 'routine') {
        if (!sheetHabitId) return;
        if (action === 'edit-routine') {
          showToast({ type: 'success', message: 'Редагування буде скоро.' });
          closeSheet();
        }
        if (action === 'delete-routine') {
          showToast({ type: 'success', message: 'Видалення буде скоро.' });
          closeSheet();
        }
      }
    });
  }

  if (focusExit) {
    focusExit.addEventListener('click', () => showFocusConfirm('exit'));
  }
  if (focusConfirmCancel) {
    focusConfirmCancel.addEventListener('click', () => hideFocusConfirm());
  }
  if (focusConfirmExit) {
    focusConfirmExit.addEventListener('click', () => {
      if (focusConfirmMode === 'skip') {
        hideFocusConfirm();
        skipFocusStep();
      } else {
        exitFocusMode();
      }
    });
  }
  if (focusCompleteExit) {
    focusCompleteExit.addEventListener('click', () => exitFocusMode());
  }
  if (focusDone) {
    focusDone.addEventListener('click', () => completeFocusStep());
  }
  if (focusSkip) {
    focusSkip.addEventListener('click', () => showFocusConfirm('skip'));
  }
  if (focusTimerToggle) {
    focusTimerToggle.addEventListener('click', () => toggleFocusTimer());
  }

  function showSkeleton() {
    if (skeleton) skeleton.hidden = false;
    if (content) content.hidden = true;
    if (empty) empty.hidden = true;
    if (error) error.hidden = true;
  }

  function showContent() {
    if (skeleton) skeleton.hidden = true;
    if (content) content.hidden = false;
    if (empty) empty.hidden = true;
    if (error) error.hidden = true;
  }

  function showEmpty() {
    if (skeleton) skeleton.hidden = true;
    if (content) content.hidden = true;
    if (empty) empty.hidden = false;
    if (error) error.hidden = true;
  }

  function showError() {
    if (skeleton) skeleton.hidden = true;
    if (content) content.hidden = true;
    if (empty) empty.hidden = true;
    if (error) error.hidden = false;
  }

  function getStatus(habitId) {
    return state.todayCheckins[habitId] || 'none';
  }

  function getNextIntent(status) {
    if (status === 'none') return 'done';
    if (status === 'done') return 'skip';
    if (status === 'skip') return 'undo';
    return 'done';
  }

  function getStatusClass(status) {
    if (status === 'done') return 'is-done';
    if (status === 'skip') return 'is-skip';
    return 'is-idle';
  }

  function getSortedHabits(habits) {
    return [...habits].sort((a, b) => {
      const aOrder = Number.isFinite(a.sort_order) ? a.sort_order : 0;
      const bOrder = Number.isFinite(b.sort_order) ? b.sort_order : 0;
      return aOrder - bOrder;
    });
  }

  function formatSteps(total) {
    if (total === 1) return '1 крок';
    if (total > 1 && total < 5) return `${total} кроки`;
    return `${total} кроків`;
  }

  function updateHeroCard(habit, status) {
    if (!heroCard || !heroTitle || !heroSub) return;
    if (heroKicker) heroKicker.textContent = 'Фокус дня';
    heroTitle.textContent = habit ? habit.title : 'Немає звичок';
    heroSub.textContent = habit ? statusCopy[status] || statusCopy.none : '';
    if (heroHint) heroHint.hidden = true;
    heroCard.classList.remove('is-active', 'is-done', 'is-skip', 'is-idle');
    heroCard.classList.add('bento-card');
    heroCard.classList.add(getStatusClass(status));
    if (status === 'none') {
      heroCard.classList.add('is-active');
    }
    heroCard.setAttribute('role', 'button');
    heroCard.setAttribute('tabindex', '0');
    heroCard.setAttribute(
      'aria-label',
      habit ? `${habit.title}. ${statusCopy[status] || statusCopy.none}` : 'Немає звичок'
    );
    if (heroProgress) heroProgress.textContent = '';
    if (heroCta) heroCta.textContent = '';
  }

  function updateHeroRoutine(routine) {
    if (!heroCard || !heroTitle || !heroSub) return;
    const total = routine.habitIds.length;
    const doneCount = routine.habitIds.filter((id) => getStatus(id) === 'done').length;
    const actionLabel = total > 0 ? 'Почати рутину' : 'Додати кроки';
    if (heroKicker) heroKicker.textContent = 'Рутина';
    heroTitle.textContent = routine.title;
    heroSub.textContent = total > 0 ? formatSteps(total) : 'Додай кроки у Habits';
    if (heroProgress) heroProgress.textContent = total > 0 ? `${doneCount} / ${total}` : '';
    if (heroCta) heroCta.textContent = total > 0 ? 'Почати' : 'Додати кроки';
    if (heroHint) {
      const showHint = !!state.trial?.active && total > 0;
      heroHint.hidden = !showHint;
      if (showHint) {
        heroHint.textContent = 'Рутини залишаться, але Focus Mode буде заблокований';
      }
    }
    heroCard.classList.remove('is-active', 'is-done', 'is-skip', 'is-idle');
    heroCard.classList.add('bento-card');
    heroCard.classList.add('is-idle');
    heroCard.setAttribute('role', 'button');
    heroCard.setAttribute('tabindex', '0');
    heroCard.setAttribute('aria-label', `${routine.title}. ${actionLabel}.`);
  }

  function updateRoutineCard(card, routine) {
    const refs = card.__refs;
    if (!refs) return;
    const total = routine.habitIds.length;
    const doneCount = routine.habitIds.filter((id) => getStatus(id) === 'done').length;
    const actionLabel = total > 0 ? 'Почати' : 'Додати кроки';
    refs.title.textContent = routine.title;
    refs.sub.textContent = total > 0 ? formatSteps(total) : 'Додай кроки у Habits';
    if (refs.progress) refs.progress.textContent = total > 0 ? `${doneCount} / ${total}` : '';
    refs.cta.textContent = actionLabel;
    if (refs.hint) {
      const showHint = !!state.trial?.active && total > 0;
      refs.hint.hidden = !showHint;
      if (showHint) {
        refs.hint.textContent = 'Рутини залишаться, але Focus Mode буде заблокований';
      }
    }
    card.classList.remove('is-active', 'is-done', 'is-skip', 'is-idle');
    card.classList.add('is-idle');
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    card.setAttribute('aria-label', `${routine.title}. ${actionLabel}.`);
  }

  function updateStatsStrip(total, doneCount, skipCount) {
    const progress = total ? Math.round((doneCount / total) * 100) : 0;
    if (progress === 100 && lastCompletion !== 100 && total > 0) {
      if (isHapticsEnabled()) {
        tg?.HapticFeedback?.notificationOccurred('success');
      }
    }
    lastCompletion = progress;
    if (statsProgress) statsProgress.textContent = `${doneCount}/${total}`;
    if (statsMeta) {
      const streakValue = Number(state?.me?.streak ?? state?.me?.user?.streak);
      const streakText = Number.isFinite(streakValue) && streakValue > 0 ? `Серія ${streakValue} дн.` : '';
      const skipText = skipCount > 0 ? `Пропущено ${skipCount}` : '';
      statsMeta.textContent = [streakText, skipText].filter(Boolean).join(' · ');
    }
    if (statsStripBar) {
      statsStripBar.style.setProperty('--progress', `${progress}%`);
    }

    if (total > 0 && doneCount + skipCount === total) {
      const dateKey = getUserDateKey();
      const dayKey = getAnalyticsKey('day_completed', dateKey);
      if (!localStorage.getItem(dayKey)) {
        localStorage.setItem(dayKey, '1');
        track('day_completed', { date: dateKey });
      }
      if (skipCount === 0) {
        const perfectKey = getAnalyticsKey('perfect_day', dateKey);
        if (!localStorage.getItem(perfectKey)) {
          localStorage.setItem(perfectKey, '1');
          track('perfect_day', { date: dateKey });
        }
      }
    }
  }

  function updateTrialLine() {
    if (!dashboardTrial) return;
    const trial = state.trial;
    if (trial?.active && trial.daysLeft > 0) {
      dashboardTrial.hidden = false;
      dashboardTrial.textContent = `Premium активний · ще ${trial.daysLeft} ${formatDays(
        trial.daysLeft
      )} доступу`;
      return;
    }
    dashboardTrial.hidden = true;
  }

  function updateCard(card, habit, status) {
    const refs = card.__refs;
    if (!refs) return;
    refs.title.textContent = habit.title;
    refs.meta.textContent = statusCopy[status] || statusCopy.none;
    card.classList.remove('is-active', 'is-done', 'is-skip', 'is-idle');
    card.classList.add(getStatusClass(status));
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    card.setAttribute('aria-label', `${habit.title}. ${statusCopy[status] || statusCopy.none}`);
  }

  function createHabitCard(habit) {
    const card = document.createElement('div');
    card.className = 'card bento-card habit-card';
    card.dataset.habitId = habit.id;
    card.dataset.kind = 'habit';

    const title = document.createElement('div');
    title.className = 'habit-card__title';
    title.textContent = habit.title;

    const meta = document.createElement('div');
    meta.className = 'habit-card__meta';
    meta.textContent = statusCopy.none;

    card.appendChild(title);
    card.appendChild(meta);

    card.__refs = {
      title,
      meta,
    };

    attachCardInteractions(card);

    return card;
  }

  function createRoutineCard(routine) {
    const card = document.createElement('div');
    card.className = 'card bento-card hero-card';
    card.dataset.routineId = routine.id;
    card.dataset.kind = 'routine';

    const kicker = document.createElement('div');
    kicker.className = 'hero-kicker';
    kicker.textContent = 'Рутина';

    const title = document.createElement('div');
    title.className = 'hero-title';
    title.textContent = routine.title;

    const sub = document.createElement('div');
    sub.className = 'hero-sub';

    const meta = document.createElement('div');
    meta.className = 'hero-meta';

    const progress = document.createElement('div');
    progress.className = 'hero-progress';

    const cta = document.createElement('div');
    cta.className = 'hero-cta';

    const hint = document.createElement('div');
    hint.className = 'hero-hint';
    hint.hidden = true;

    meta.appendChild(progress);
    meta.appendChild(cta);

    card.appendChild(kicker);
    card.appendChild(title);
    card.appendChild(sub);
    card.appendChild(meta);
    card.appendChild(hint);

    card.__refs = { title, sub, cta, progress, hint };
    attachCardInteractions(card);
    return card;
  }

  function attachCardInteractions(card) {
    if (!card || card.__bound) return;
    card.__bound = true;
    let pressTimer = null;
    let moved = false;
    let longPressFired = false;
    let startX = 0;
    let startY = 0;

    const clearPress = () => {
      if (pressTimer) clearTimeout(pressTimer);
      pressTimer = null;
      moved = false;
    };

    card.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      startX = event.clientX;
      startY = event.clientY;
      moved = false;
      longPressFired = false;

      pressTimer = setTimeout(() => {
        longPressFired = true;
        const kind = card.dataset.kind || 'habit';
        if (kind === 'routine') {
          const routineId = card.dataset.routineId;
          if (routineId) openSheet(null, 'routine', routineId);
        } else {
          const currentHabitId = Number(card.dataset.habitId);
          if (currentHabitId) openSheet(currentHabitId, 'habit');
        }
      }, 650);
    });

    card.addEventListener('pointermove', (event) => {
      if (!pressTimer) return;
      const dx = Math.abs(event.clientX - startX);
      const dy = Math.abs(event.clientY - startY);
      if (dx > 8 || dy > 8) {
        moved = true;
        clearPress();
      }
    });

    card.addEventListener('pointerup', () => {
      if (pressTimer) clearTimeout(pressTimer);
      pressTimer = null;
      if (longPressFired || moved) return;
      const kind = card.dataset.kind || 'habit';
      if (kind === 'routine') {
        const routineId = card.dataset.routineId;
        if (routineId) startFocusMode(routineId);
      } else {
        const currentHabitId = Number(card.dataset.habitId);
        if (currentHabitId) handleHabitTap(currentHabitId);
      }
    });

    card.addEventListener('pointerleave', clearPress);
    card.addEventListener('pointercancel', clearPress);

    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        const kind = card.dataset.kind || 'habit';
        if (kind === 'routine') {
          const routineId = card.dataset.routineId;
          if (routineId) startFocusMode(routineId);
        } else {
          const currentHabitId = Number(card.dataset.habitId);
          if (currentHabitId) handleHabitTap(currentHabitId);
        }
      }
    });
  }

  function applyFocusHighlight(targetId, heroId) {
    const nextId = targetId || null;
    if (focusHabitId === nextId) return;

    if (focusHabitId && focusHabitId === heroId && heroCard) {
      heroCard.classList.remove('is-focus', 'is-focus-anim');
    } else if (focusHabitId && cardMap.has(focusHabitId)) {
      const previous = cardMap.get(focusHabitId);
      previous.classList.remove('is-focus', 'is-focus-anim');
    }

    focusHabitId = nextId;
    if (!focusHabitId) return;

    const target =
      focusHabitId === heroId ? heroCard : cardMap.get(focusHabitId);
    if (!target) return;
    target.classList.add('is-focus', 'is-focus-anim');
    if (focusPulseTimer) clearTimeout(focusPulseTimer);
    focusPulseTimer = setTimeout(() => {
      target.classList.remove('is-focus-anim');
    }, 160);
  }

  function openSheet(habitId, scope = 'habit', routineId = null) {
    if (!habitSheet || !sheetBackdrop) return;
    sheetScope = scope;
    sheetHabitId = habitId;
    const items = habitSheet.querySelectorAll('[data-scope]');
    items.forEach((item) => {
      const visible = item.dataset.scope === sheetScope;
      item.hidden = !visible;
    });
    if (sheetScope === 'routine') {
      const routine = state.routines.find((item) => item.id === routineId);
      if (habitSheetTitle) habitSheetTitle.textContent = routine?.title || 'Рутина';
      sheetHabitId = routine?.id || null;
      const deleteBtn = habitSheet.querySelector('[data-action="delete-routine"]');
      if (deleteBtn) {
        deleteBtn.hidden = !state.features?.isPremium;
      }
    } else {
      const habit = state.habits.find((item) => item.id === habitId);
      if (!habit) return;
      if (habitSheetTitle) habitSheetTitle.textContent = habit.title;
    }
    sheetBackdrop.hidden = false;
    habitSheet.hidden = false;
    requestAnimationFrame(() => {
      habitSheet.classList.add('is-open');
    });
  }

  function closeSheet() {
    if (!habitSheet || !sheetBackdrop) return;
    habitSheet.classList.remove('is-open');
    sheetBackdrop.hidden = true;
    setTimeout(() => {
      habitSheet.hidden = true;
      sheetHabitId = null;
      sheetScope = 'habit';
    }, 160);
  }

  function openHabitEdit(habitId) {
    navigateToTab('habits');
    if (window.__habitsController) {
      window.__habitsController.ensureLoaded();
      window.__habitsController.setActive(true);
      window.__habitsController.openEdit?.(habitId);
    }
  }

  function openHabitAdd() {
    navigateToTab('habits');
    if (window.__habitsController) {
      window.__habitsController.ensureLoaded();
      window.__habitsController.setActive(true);
      window.__habitsController.focusAdd?.();
    }
  }

  function confirmDeleteHabit(habitId) {
    const habit = state.habits.find((item) => item.id === habitId);
    if (!habit) return;
    showToast({
      type: 'error',
      message: `Видалити «${habit.title}»?`,
      actionLabel: 'Підтвердити',
      duration: 3600,
      onAction: () => deleteHabit(habitId),
    });
  }

  async function deleteHabit(habitId) {
    const snapshotHabits = [...state.habits];
    const snapshotCheckins = { ...state.todayCheckins };

    state.habits = state.habits.filter((item) => item.id !== habitId);
    removeHabitFromRoutine(habitId);
    delete state.todayCheckins[habitId];
    renderDashboard();
    if (window.__habitsController) window.__habitsController.refresh();
    if (window.__statsController) window.__statsController.refresh();

    try {
      await apiFetch(`/api/habits/${habitId}`, { method: 'DELETE' });
      showToast({ type: 'success', message: 'Видалено', duration: 1400 });
    } catch (error) {
      state.habits = snapshotHabits;
      state.todayCheckins = snapshotCheckins;
      renderDashboard();
      if (window.__habitsController) window.__habitsController.refresh();
      if (window.__statsController) window.__statsController.refresh();
      showToast({
        type: 'error',
        message:
          error?.type === 'network'
            ? 'Немає звʼязку. Спробуй ще раз.'
            : 'Не вдалося видалити.',
      });
    }
  }

  function handleHabitTap(habitId) {
    const current = getStatus(habitId);
    const intent = getNextIntent(current);
    const promise = runHabitIntent(habitId, intent);
    scheduleDashboardSync();
    if (!promise || typeof promise.then !== 'function') return;

    promise
      .then(() => {
        if (intent === 'done') {
          if (isHapticsEnabled()) {
            tg?.HapticFeedback?.notificationOccurred('success');
          }
          showToast({
            type: 'success',
            message: 'Виконано',
            actionLabel: 'Undo',
            duration: 4200,
            onAction: () => handleHabitUndo(habitId),
          });
        } else if (intent === 'skip') {
          if (isHapticsEnabled()) {
            tg?.HapticFeedback?.impactOccurred('light');
          }
          showToast({
            type: 'success',
            message: 'Пропущено',
            actionLabel: 'Undo',
            duration: 4200,
            onAction: () => handleHabitUndo(habitId),
          });
        }
        scheduleDashboardSync();
      })
      .catch((error) => {
        haptic('error');
        showToast({
          type: 'error',
          message:
            error?.type === 'network'
              ? 'Немає звʼязку. Спробувати ще раз?'
              : 'Не вдалося зберегти. Спробувати ще раз?',
          actionLabel: 'Повторити',
          onAction: () => handleHabitTap(habitId),
        });
        scheduleDashboardSync();
      });
  }

  function handleHabitUndo(habitId) {
    const promise = runHabitIntent(habitId, 'undo');
    scheduleDashboardSync();
    if (!promise || typeof promise.then !== 'function') return;

    promise.catch((error) => {
      haptic('error');
      showToast({
        type: 'error',
        message:
          error?.type === 'network'
            ? 'Немає звʼязку. Спробувати ще раз?'
            : 'Не вдалося скасувати. Спробувати ще раз?',
        actionLabel: 'Повторити',
        onAction: () => handleHabitUndo(habitId),
      });
      scheduleDashboardSync();
    });
  }

  function startFocusMode(routineId) {
    if (!focusOverlay) return;
    const routine = state.routines.find((item) => item.id === routineId);
    if (!routine) return;
    if ((routine.habitIds || []).length === 0) {
      openHabitAdd();
      return;
    }

    track('routine_started', { routineId, steps: routine.habitIds.length });
    track('focus_mode_used', { routineId });

    state.focus.active = true;
    state.focus.routineId = routineId;
    state.focus.stepIndex = 0;
    document.body.classList.add('is-focus-mode');
    focusOverlay.hidden = false;
    focusConfirm.hidden = true;
    focusComplete.hidden = true;
    renderFocusStep();

    if (tg?.BackButton) {
      tg.BackButton.show();
      tg.BackButton.onClick(() => showFocusConfirm());
    }
  }

  function exitFocusMode() {
    state.focus.active = false;
    state.focus.routineId = null;
    state.focus.stepIndex = 0;
    focusActionLocked = false;
    stopFocusTimer();
    if (focusOverlay) focusOverlay.hidden = true;
    document.body.classList.remove('is-focus-mode');
    hideFocusConfirm();
    if (tg?.BackButton) tg.BackButton.hide();
  }

  function showFocusConfirm(mode = 'exit') {
    showFocusConfirmMode(mode);
  }

  function showFocusConfirmMode(mode) {
    focusConfirmMode = mode;
    if (focusConfirmTitle) {
      focusConfirmTitle.textContent =
        mode === 'skip' ? 'Пропустити цей крок?' : 'Вийти з рутини?';
    }
    if (focusConfirmText) {
      focusConfirmText.textContent =
        mode === 'skip'
          ? 'Крок буде позначено як пропущений.'
          : 'Ти зможеш продовжити пізніше. Прогрес збережено.';
    }
    if (focusConfirmExit) {
      focusConfirmExit.textContent = mode === 'skip' ? 'Пропустити' : 'Вийти';
    }

    if (mode === 'exit') {
      const routine = state.routines.find((item) => item.id === state.focus.routineId);
      const steps = routine?.habitIds || [];
      if (state.focus.stepIndex >= steps.length) {
        exitFocusMode();
        return;
      }
    }

    if (focusConfirm) focusConfirm.hidden = false;
  }

  function hideFocusConfirm() {
    if (focusConfirm) focusConfirm.hidden = true;
  }

  function parseTimerFromTitle(title) {
    if (!title) return null;
    const match = title.match(/(\d+)\s*(хв|min|m)\b/i);
    if (match) return Number(match[1]) * 60;
    const matchSec = title.match(/(\d+)\s*(сек|s)\b/i);
    if (matchSec) return Number(matchSec[1]);
    return null;
  }

  function renderFocusStep() {
    const routine = state.routines.find((item) => item.id === state.focus.routineId);
    if (!routine) return;
    const steps = routine.habitIds;
    if (state.focus.stepIndex >= steps.length) {
      showCompletion();
      return;
    }

    const habitId = steps[state.focus.stepIndex];
    const habit = state.habits.find((item) => item.id === habitId);
    if (!habit) {
      state.focus.stepIndex += 1;
      renderFocusStep();
      return;
    }

    focusActionLocked = false;
    if (focusRoutineTitle) focusRoutineTitle.textContent = routine.title;
    if (focusStep) {
      focusStep.textContent = `Крок ${state.focus.stepIndex + 1} з ${steps.length}`;
    }
    if (focusProgressBar) {
      const progress = steps.length
        ? Math.round(((state.focus.stepIndex + 1) / steps.length) * 100)
        : 0;
      focusProgressBar.style.width = `${progress}%`;
    }
    if (focusTitle) focusTitle.textContent = habit.title;
    if (focusSub) focusSub.textContent = statusCopy[getStatus(habitId)] || '';

    if (focusNext) {
      const nextHabitId = steps[state.focus.stepIndex + 1];
      const nextHabit = state.habits.find((item) => item.id === nextHabitId);
      if (nextHabit) {
        focusNext.textContent = `Далі: ${nextHabit.title}`;
        focusNext.classList.remove('is-hidden');
      } else {
        focusNext.textContent = '';
        focusNext.classList.add('is-hidden');
      }
    }

    const timerSeconds = parseTimerFromTitle(habit.title);
    if (timerSeconds) {
      focusRemaining = timerSeconds;
      updateTimerUI(false);
      if (focusTimer) focusTimer.hidden = false;
      if (focusDone) focusDone.hidden = true;
    } else {
      stopFocusTimer();
      if (focusTimer) focusTimer.hidden = true;
      if (focusDone) focusDone.hidden = false;
    }
  }

  function updateTimerUI(isRunning) {
    if (!focusTimerValue || !focusTimerToggle) return;
    const minutes = Math.floor(focusRemaining / 60);
    const seconds = focusRemaining % 60;
    focusTimerValue.textContent = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(
      2,
      '0'
    )}`;
    focusTimerToggle.textContent = isRunning ? 'Стоп' : 'Старт';
  }

  function toggleFocusTimer() {
    if (focusInterval) {
      stopFocusTimer();
      return;
    }
    startFocusTimer();
  }

  function startFocusTimer() {
    if (focusInterval || focusRemaining <= 0) return;
    updateTimerUI(true);
    focusInterval = setInterval(() => {
      focusRemaining -= 1;
      updateTimerUI(true);
      if (focusRemaining <= 0) {
        stopFocusTimer();
        completeFocusStep();
      }
    }, 1000);
  }

  function stopFocusTimer() {
    if (focusInterval) {
      clearInterval(focusInterval);
      focusInterval = null;
    }
    updateTimerUI(false);
  }

  function completeFocusStep() {
    const routine = state.routines.find((item) => item.id === state.focus.routineId);
    if (!routine) return;
    const habitId = routine.habitIds[state.focus.stepIndex];
    if (!habitId) return;
    if (focusActionLocked) return;
    focusActionLocked = true;
    stopFocusTimer();
    runHabitIntent(habitId, 'done')
      .then(() => {
        if (isHapticsEnabled()) {
          tg?.HapticFeedback?.notificationOccurred('success');
        }
        state.focus.stepIndex += 1;
        renderFocusStep();
        scheduleDashboardSync();
      })
      .catch(() => {
        haptic('error');
        showToast({ type: 'error', message: 'Не вдалося зберегти. Спробуй ще раз.' });
      })
      .finally(() => {
        focusActionLocked = false;
      });
  }

  function skipFocusStep() {
    const routine = state.routines.find((item) => item.id === state.focus.routineId);
    if (!routine) return;
    const habitId = routine.habitIds[state.focus.stepIndex];
    if (!habitId) return;
    if (focusActionLocked) return;
    focusActionLocked = true;
    stopFocusTimer();
    runHabitIntent(habitId, 'skip')
      .then(() => {
        if (isHapticsEnabled()) {
          tg?.HapticFeedback?.impactOccurred('light');
        }
        state.focus.stepIndex += 1;
        renderFocusStep();
        scheduleDashboardSync();
      })
      .catch(() => {
        haptic('error');
        showToast({ type: 'error', message: 'Не вдалося зберегти. Спробуй ще раз.' });
      })
      .finally(() => {
        focusActionLocked = false;
      });
  }

  function showCompletion() {
    stopFocusTimer();
    if (focusConfirm) focusConfirm.hidden = true;
    if (focusComplete) focusComplete.hidden = false;
    if (focusProgressBar) {
      focusProgressBar.style.width = '100%';
    }
    const routine = state.routines.find((item) => item.id === state.focus.routineId);
    const steps = routine?.habitIds || [];
    const total = steps.length;
    let doneCount = 0;
    let skipCount = 0;
    steps.forEach((id) => {
      const status = getStatus(id);
      if (status === 'done') doneCount += 1;
      if (status === 'skip') skipCount += 1;
    });
    if (focusCompleteMeta) {
      focusCompleteMeta.textContent = `${doneCount}/${total} виконано`;
    }
    if (focusCompleteBadge) {
      focusCompleteBadge.hidden = !(total > 0 && skipCount === 0);
    }
    track('routine_completed', {
      routineId: state.focus.routineId,
      doneCount,
      skipCount,
      total,
    });
    if (isHapticsEnabled()) {
      tg?.HapticFeedback?.notificationOccurred('success');
    }
  }

  function renderDashboard() {
    const habits = Array.isArray(state.habits) ? state.habits : [];
    ensureRoutines();
    const routines = (state.routines || []).filter((item) => item.active);
    const routineLimit = Number.isFinite(state.features?.routineLimit)
      ? state.features.routineLimit
      : 1;
    const visibleRoutines = routines.slice(0, routineLimit);
    const routineHabitIds = new Set(
      visibleRoutines.flatMap((routine) => routine.habitIds || [])
    );

    const showRoutines = visibleRoutines.length > 0;
    if (!habits.length && !showRoutines) {
      showEmpty();
      return;
    }

    showContent();

    const sortedHabits = getSortedHabits(habits);
    const pending = [];
    const done = [];
    const skip = [];

    sortedHabits.forEach((habit) => {
      const status = getStatus(habit.id);
      if (status === 'done') done.push(habit);
      else if (status === 'skip') skip.push(habit);
      else pending.push(habit);
    });

    // routine state already prepared above

    let heroKind = 'habit';
    let heroHabit = pending[0] || sortedHabits[0];
    let heroRoutine = null;

    if (showRoutines) {
      heroKind = 'routine';
      heroRoutine = visibleRoutines[0];
      updateHeroRoutine(heroRoutine);
    } else {
      const heroStatus = heroHabit ? getStatus(heroHabit.id) : 'none';
      updateHeroCard(heroHabit, heroStatus);
    }

    if (heroCard) {
      if (heroKind === 'routine' && heroRoutine) {
        heroCard.dataset.kind = 'routine';
        heroCard.dataset.routineId = heroRoutine.id;
        heroCard.dataset.habitId = '';
      } else {
        heroCard.dataset.kind = 'habit';
        heroCard.dataset.habitId = heroHabit?.id || '';
      }
      attachCardInteractions(heroCard);
    }

    const MAX_CARDS = 6;
    let cards = [];
    const availableSlots = Math.max(0, MAX_CARDS - 1);
    const standaloneHabits = sortedHabits.filter((habit) => !routineHabitIds.has(habit.id));

    cards = standaloneHabits.filter((habit) => habit.id !== heroHabit?.id).slice(0, availableSlots);

    if (showRoutines && visibleRoutines.length > 1 && cards.length < availableSlots) {
      const routine = visibleRoutines[1];
      const routineCard = routineCards.get(routine.id) || createRoutineCard(routine);
      routineCards.set(routine.id, routineCard);
      routineCard.__routine = routine;
      updateRoutineCard(routineCard, routine);
      if (bentoItems && routineCard.parentElement !== bentoItems) {
        bentoItems.appendChild(routineCard);
      }
    }

    const currentIds = new Set(cards.map((habit) => habit.id));
    cards.forEach((habit) => {
      if (!cardMap.has(habit.id)) {
        cardMap.set(habit.id, createHabitCard(habit));
      }
      const card = cardMap.get(habit.id);
      updateCard(card, habit, getStatus(habit.id));
      if (bentoItems && card.parentElement !== bentoItems) {
        bentoItems.appendChild(card);
      }
    });

    cardMap.forEach((card, habitId) => {
      if (!currentIds.has(Number(habitId))) {
        card.remove();
        cardMap.delete(habitId);
      }
    });

    const doneCount = done.length;
    updateStatsStrip(sortedHabits.length, doneCount, skip.length);
    updateTrialLine();

    const focusCandidate = pending.find((habit) => !routineHabitIds.has(habit.id))?.id || null;
    applyFocusHighlight(focusCandidate, heroKind === 'habit' ? heroHabit?.id : null);

    if (bentoFooter) {
      if (!habits.length) {
        bentoFooter.textContent = 'Додай звички у вкладці Habits.';
      } else {
        const remaining = standaloneHabits.length - cards.length - (heroKind === 'habit' ? 1 : 0);
        bentoFooter.textContent =
          remaining > 0 ? `Ще ${remaining} звичок у вкладці Habits.` : '';
      }
    }
  }

  function scheduleDashboardSync() {
    if (syncRaf) return;
    const start = Date.now();
    const tick = () => {
      renderDashboard();
      const hasInFlight = Object.values(state.inFlightByHabitId).some(Boolean);
      const hasQueued = Object.keys(state.queuedIntentByHabitId).length > 0;
      if ((hasInFlight || hasQueued) && Date.now() - start < 5000) {
        syncRaf = requestAnimationFrame(tick);
      } else {
        syncRaf = null;
      }
    };
    syncRaf = requestAnimationFrame(tick);
  }

  function loadDashboard() {
    showSkeleton();
    loadMe()
      .then(() => {
        renderDashboard();
        maybeShowTrialPrompts();
      })
      .catch(() => {
        showError();
      });
  }

  function ensureLoaded() {
    if (state.me) {
      renderDashboard();
      return;
    }
    loadDashboard();
  }

  return {
    ensureLoaded,
    refresh: renderDashboard,
  };
}

function normalizeHabitTitle(value) {
  if (!value) return '';
  return value.trim().replace(/\s+/g, ' ');
}

function createHabitsController({ onHabitsChanged }) {
  const root = document.getElementById('habits');
  if (!root) {
    return { ensureLoaded: () => {}, refresh: () => {} };
  }

  const skeleton = document.getElementById('habits-skeleton');
  const content = document.getElementById('habits-content');
  const empty = document.getElementById('habits-empty');
  const emptyCta = document.getElementById('habits-empty-cta');

  const addCard = document.getElementById('habit-add-card');
  const addInput = document.getElementById('habit-add-input');
  const addBtn = document.getElementById('habit-add-btn');
  const addCancel = document.getElementById('habit-add-cancel');
  const addHint = document.getElementById('habit-add-hint');
  const lockedCard = document.getElementById('habits-locked');
  const chipButtons = root.querySelectorAll('.chip-btn');

  const list = document.getElementById('habits-list');

  const FREE_HABIT_LIMIT = 3;
  const MIN_TITLE_LENGTH = 2;

  const rowMap = new Map();
  const savingByHabitId = new Set();
  const reorderInFlight = new Set();
  let editHabitId = null;
  let pendingEditId = null;
  let pendingScrollId = null;
  let pendingAddFocus = false;
  let addSubmitting = false;
  let habitsActive = false;
  const mainButton = tg?.MainButton;

  if (emptyCta) {
    emptyCta.addEventListener('click', () => {
      showContent();
      if (gateHabitCreation('habit_empty_cta')) return;
      if (addInput) addInput.focus();
    });
  }

  function showSkeleton() {
    if (skeleton) skeleton.hidden = false;
    if (content) content.hidden = true;
    if (empty) empty.hidden = true;
  }

  function showContent() {
    if (skeleton) skeleton.hidden = true;
    if (content) content.hidden = false;
    if (empty) empty.hidden = true;
  }

  function showEmpty() {
    if (skeleton) skeleton.hidden = true;
    if (content) content.hidden = false;
    if (empty) empty.hidden = false;
  }

  function getSortedHabits(habits) {
    return [...habits].sort((a, b) => {
      const aOrder = Number.isFinite(a.sort_order) ? a.sort_order : 0;
      const bOrder = Number.isFinite(b.sort_order) ? b.sort_order : 0;
      return aOrder - bOrder;
    });
  }

  function setAddDirty(isDirty) {
    if (!addCard) return;
    addCard.classList.toggle('is-dirty', isDirty);
  }

  function getHabitLimit() {
    return state.features?.unlimitedHabits ? Number.POSITIVE_INFINITY : FREE_HABIT_LIMIT;
  }

  function isPremium() {
    return !!state.features?.isPremium;
  }

  function isFreeLimitReached() {
    return !isPremium() && state.habits.length >= FREE_HABIT_LIMIT;
  }

  function gateHabitCreation(source) {
    if (!isFreeLimitReached()) return false;
    openPremiumModal(source);
    return true;
  }

  function resetAddForm() {
    if (addInput) addInput.value = '';
    setAddDirty(false);
  }

  function updateAddState() {
    if (!addInput || !addBtn) return;
    const title = normalizeHabitTitle(addInput.value);
    const limitReached = state.habits.length >= getHabitLimit();
    const valid = title.length >= MIN_TITLE_LENGTH;
    const gateActive = isFreeLimitReached();

    if (lockedCard) lockedCard.hidden = isPremium() || !limitReached;

    if (addHint) {
      if (isPremium()) {
        addHint.textContent = 'Безлімітні звички активні.';
      } else {
        addHint.textContent = limitReached
          ? 'Ліміт 3 звички. Premium відкриває більше.'
          : 'До 3 звичок безкоштовно.';
      }
    }

    addInput.disabled = gateActive || addSubmitting;
    addBtn.disabled = addSubmitting || (!valid && !gateActive);

    setAddDirty(title.length > 0);
    updateMainButton();
  }

  async function handleAdd(presetTitle) {
    if (!addInput || !addBtn) return;
    if (gateHabitCreation('habit_add')) return;
    const title = normalizeHabitTitle(presetTitle || addInput.value);
    if (title.length < MIN_TITLE_LENGTH) {
      showToast({
        type: 'error',
        message: 'Назва має бути щонайменше 2 символи.',
      });
      return;
    }

    addSubmitting = true;
    addBtn.classList.add('is-loading');
    updateAddState();

    try {
      const response = await apiFetch('/api/habits', {
        method: 'POST',
        body: JSON.stringify({ title }),
      });
      if (response?.habit) {
        state.habits = [...state.habits, response.habit];
        resetAddForm();
        renderHabits();
        if (onHabitsChanged) onHabitsChanged();
        showToast({ type: 'success', message: 'Додано', duration: 1400 });
      }
    } catch (error) {
      if (error?.type === 'http') {
        alert(`Error: ${error.message || 'Request failed'}`);
      }
      if (error?.type === 'http' && error?.status === 403) {
        openPremiumModal('habit_limit_server');
        return;
      }
      showToast({
        type: 'error',
        message:
          error?.type === 'network'
            ? 'Немає звʼязку. Спробуй ще раз.'
            : 'Не вдалося додати звичку.',
      });
    } finally {
      addSubmitting = false;
      addBtn.classList.remove('is-loading');
      updateAddState();
    }
  }

  function exitEdit(row, restoreTitle = true) {
    row.classList.remove('is-editing');
    const habitId = Number(row.dataset.habitId);
    const habit = state.habits.find((item) => item.id === habitId);
    if (restoreTitle && habit && row.__refs?.editInput) {
      row.__refs.editInput.value = habit.title;
    }
    if (editHabitId === habitId) {
      editHabitId = null;
    }
  }

  function enterEdit(row) {
    const habitId = Number(row.dataset.habitId);
    if (editHabitId && editHabitId !== habitId) {
      const previousRow = rowMap.get(editHabitId);
      if (previousRow) exitEdit(previousRow, true);
    }
    editHabitId = habitId;
    row.classList.add('is-editing');
    if (row.__refs?.editInput) {
      row.__refs.editInput.value = row.__refs.title.textContent || '';
      row.__refs.editInput.focus();
    }
  }

  async function saveHabitTitle(habitId, newTitle) {
    const habit = state.habits.find((item) => item.id === habitId);
    if (!habit) return;

    const prevTitle = habit.title;
    habit.title = newTitle;
    renderHabits();

    savingByHabitId.add(habitId);
    renderHabits();

    try {
      await apiFetch(`/api/habits/${habitId}`, {
        method: 'PUT',
        body: JSON.stringify({ title: newTitle }),
      });
      const row = rowMap.get(habitId);
      if (row) exitEdit(row, false);
      if (onHabitsChanged) onHabitsChanged();
    } catch (error) {
      habit.title = prevTitle;
      renderHabits();
      showToast({
        type: 'error',
        message:
          error?.type === 'network'
            ? 'Немає звʼязку. Спробувати ще раз?'
            : 'Не вдалося зберегти. Спробувати ще раз?',
        actionLabel: 'Повторити',
        onAction: () => saveHabitTitle(habitId, newTitle),
      });
    } finally {
      savingByHabitId.delete(habitId);
      renderHabits();
    }
  }

  function handleSave(row) {
    const habitId = Number(row.dataset.habitId);
    const input = row.__refs?.editInput;
    if (!input) return;

    const title = normalizeHabitTitle(input.value);
    if (title.length < MIN_TITLE_LENGTH) {
      showToast({
        type: 'error',
        message: 'Назва має бути щонайменше 2 символи.',
      });
      return;
    }

    saveHabitTitle(habitId, title);
  }

  let dragRow = null;
  let dragPointer = null;
  let dragMoved = false;
  let dropTarget = null;
  let dropPosition = null;
  let lastReorderSnapshot = null;

  function snapshotOrder() {
    return state.habits.map((habit) => ({
      id: habit.id,
      sort_order: habit.sort_order,
    }));
  }

  function restoreSnapshot(snapshot) {
    const map = new Map(state.habits.map((habit) => [habit.id, habit]));
    const restored = [];
    snapshot.forEach((item) => {
      const habit = map.get(item.id);
      if (habit) {
        habit.sort_order = item.sort_order;
        restored.push(habit);
      }
    });
    state.habits = restored;
  }

  function applyOrder(orderedIds) {
    const map = new Map(state.habits.map((habit) => [habit.id, habit]));
    const updated = [];
    orderedIds.forEach((id, index) => {
      const habit = map.get(id);
      if (!habit) return;
      habit.sort_order = (index + 1) * 10;
      updated.push(habit);
    });
    state.habits = updated;
  }

  function getChangedHabits(snapshot) {
    const prevMap = new Map(snapshot.map((item) => [item.id, item.sort_order]));
    return state.habits.filter((habit) => prevMap.get(habit.id) !== habit.sort_order);
  }

  async function syncReorder(snapshot, orderedIds) {
    const changed = getChangedHabits(snapshot);
    if (changed.length === 0) return;

    changed.forEach((habit) => reorderInFlight.add(habit.id));
    renderHabits();

    try {
      await Promise.all(
        changed.map((habit) =>
          apiFetch(`/api/habits/${habit.id}`, {
            method: 'PUT',
            body: JSON.stringify({ sort_order: habit.sort_order }),
          })
        )
      );
      if (onHabitsChanged) onHabitsChanged();
    } catch (error) {
      restoreSnapshot(snapshot);
      renderHabits();
      showToast({
        type: 'error',
        message:
          error?.type === 'network'
            ? 'Немає звʼязку. Спробувати ще раз?'
            : 'Не вдалося змінити порядок.',
        actionLabel: 'Повторити',
        onAction: () => {
          applyOrder(orderedIds);
          renderHabits();
          syncReorder(snapshot, orderedIds);
        },
      });
    } finally {
      changed.forEach((habit) => reorderInFlight.delete(habit.id));
      renderHabits();
    }
  }

  function clearDropTarget() {
    if (dropTarget) {
      dropTarget.classList.remove('is-drop-target');
      dropTarget.removeAttribute('data-drop');
    }
    dropTarget = null;
    dropPosition = null;
  }

  function handlePointerMove(event) {
    if (!dragRow || !list) return;
    dragMoved = true;

    const y = event.clientY;
    const rows = Array.from(list.querySelectorAll('.habit-row')).filter(
      (row) => row !== dragRow
    );
    if (rows.length === 0) return;

    let target = null;
    let position = 'after';
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      const midpoint = rect.top + rect.height / 2;
      if (y < midpoint) {
        target = row;
        position = 'before';
        break;
      }
    }

    if (!target) {
      target = rows[rows.length - 1];
      position = 'after';
    }

    if (position === 'before') {
      list.insertBefore(dragRow, target);
    } else {
      list.insertBefore(dragRow, target.nextSibling);
    }

    if (dropTarget !== target || dropPosition !== position) {
      clearDropTarget();
      dropTarget = target;
      dropPosition = position;
      dropTarget.classList.add('is-drop-target');
      dropTarget.setAttribute('data-drop', position);
    }
  }

  function finishDrag() {
    if (!dragRow || !list) return;
    dragRow.classList.remove('is-dragging');
    document.body.classList.remove('is-dragging');
    clearDropTarget();

    const orderedIds = Array.from(list.querySelectorAll('.habit-row')).map((row) =>
      Number(row.dataset.habitId)
    );
    if (dragMoved) {
      const snapshot = snapshotOrder();
      lastReorderSnapshot = { snapshot, orderedIds };
      applyOrder(orderedIds);
      renderHabits();
      syncReorder(snapshot, orderedIds);
    }

    dragRow = null;
    dragPointer = null;
    dragMoved = false;
  }

  function handlePointerUp() {
    document.removeEventListener('pointermove', handlePointerMove);
    document.removeEventListener('pointerup', handlePointerUp);
    finishDrag();
  }

  function startDrag(event, row) {
    if (!row || reorderInFlight.size > 0) return;
    if (row.classList.contains('is-editing')) return;
    if (!list || list.children.length < 2) return;

    event.preventDefault();
    dragRow = row;
    dragPointer = event.pointerId;
    dragMoved = false;
    row.classList.add('is-dragging');
    document.body.classList.add('is-dragging');

    if (event.target && event.target.setPointerCapture) {
      event.target.setPointerCapture(event.pointerId);
    }

    document.addEventListener('pointermove', handlePointerMove);
    document.addEventListener('pointerup', handlePointerUp);
  }

  function updateRow(row, habit, index, total) {
    const refs = row.__refs;
    if (!refs) return;

    refs.title.textContent = habit.title;
    refs.subtitle.textContent = habit.active === 0 ? 'Пауза' : 'Щодня';

    const isSaving = savingByHabitId.has(habit.id);
    const isReorder = reorderInFlight.has(habit.id);
    const disabled = isSaving || isReorder;

    const isEditing = row.classList.contains('is-editing');
    refs.editBtn.disabled = disabled;
    refs.handleBtn.disabled = disabled || isEditing;
    if (refs.routineBtn) {
      refs.routineBtn.disabled = disabled || isEditing;
      const inRoutine = isHabitInRoutine(habit.id);
      refs.routineBtn.textContent = inRoutine ? 'Зняти з рутини' : 'Додати до рутини: Ранок';
      refs.routineBtn.setAttribute(
        'aria-label',
        inRoutine ? 'Зняти з рутини Ранок' : 'Додати до рутини Ранок'
      );
    }
    refs.saveBtn.disabled = isSaving;
    refs.cancelBtn.disabled = isSaving;

    if (isSaving) {
      refs.saveBtn.classList.add('is-loading');
    } else {
      refs.saveBtn.classList.remove('is-loading');
    }

    const reminderPremium = !!state.features?.perHabitReminders;
    if (refs.reminderLocked) refs.reminderLocked.hidden = reminderPremium;
    if (refs.reminderControls) refs.reminderControls.hidden = !reminderPremium;
    if (refs.reminderHelper) {
      refs.reminderHelper.textContent = reminderPremium
        ? 'Функція зʼявиться найближчим часом.'
        : 'Індивідуальні нагадування — Premium.';
    }
  }

  function createHabitRow(habit) {
    const row = document.createElement('div');
    row.className = 'row habit-row';
    row.dataset.habitId = habit.id;

    const view = document.createElement('div');
    view.className = 'habit-row__view';

    const main = document.createElement('div');
    main.className = 'row__main';

    const title = document.createElement('div');
    title.className = 'row__title';

    const subtitle = document.createElement('div');
    subtitle.className = 'row__subtitle';

    main.appendChild(title);
    main.appendChild(subtitle);

    const right = document.createElement('div');
    right.className = 'row__right habit-actions';

    const handleBtn = document.createElement('button');
    handleBtn.type = 'button';
    handleBtn.className = 'drag-handle';
    handleBtn.setAttribute('aria-label', 'Перетягнути');
    handleBtn.textContent = '☰';

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'ghost';
    editBtn.textContent = 'Редагувати';

    const routineBtn = document.createElement('button');
    routineBtn.type = 'button';
    routineBtn.className = 'ghost routine-toggle';
    routineBtn.textContent = 'Додати до рутини: Ранок';

    handleBtn.addEventListener('pointerdown', (event) => startDrag(event, row));
    editBtn.addEventListener('click', () => enterEdit(row));
    routineBtn.addEventListener('click', () => {
      const habitId = Number(row.dataset.habitId);
      if (!habitId) return;
      if (isHabitInRoutine(habitId)) {
        removeHabitFromRoutine(habitId);
      } else {
        addHabitToRoutine(habitId);
      }
      renderHabits();
      if (onHabitsChanged) onHabitsChanged();
    });

    right.appendChild(handleBtn);
    right.appendChild(editBtn);
    right.appendChild(routineBtn);

    view.appendChild(main);
    view.appendChild(right);

    const edit = document.createElement('div');
    edit.className = 'habit-row__edit';

    const editMain = document.createElement('div');
    editMain.className = 'habit-row__edit-main';

    const editInput = document.createElement('input');
    editInput.type = 'text';
    editInput.className = 'input';
    editInput.value = habit.title;
    editInput.autocomplete = 'off';

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'primary';
    saveBtn.textContent = 'Зберегти';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'ghost';
    cancelBtn.textContent = 'Скасувати';

    saveBtn.addEventListener('click', () => handleSave(row));
    cancelBtn.addEventListener('click', () => exitEdit(row, true));

    editInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        handleSave(row);
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        exitEdit(row, true);
      }
    });

    editMain.appendChild(editInput);
    editMain.appendChild(saveBtn);
    editMain.appendChild(cancelBtn);
    edit.appendChild(editMain);

    const reminder = document.createElement('div');
    reminder.className = 'habit-reminder';

    const reminderHeader = document.createElement('div');
    reminderHeader.className = 'habit-reminder__header';

    const reminderTitle = document.createElement('div');
    reminderTitle.className = 'row__title';
    reminderTitle.textContent = 'Нагадування';

    const reminderSubtitle = document.createElement('div');
    reminderSubtitle.className = 'row__subtitle';
    reminderSubtitle.textContent = 'Окремо для кожної звички';

    reminderHeader.appendChild(reminderTitle);
    reminderHeader.appendChild(reminderSubtitle);

    const reminderLocked = document.createElement('div');
    reminderLocked.className = 'habit-reminder__locked';
    reminderLocked.textContent = 'Індивідуальні нагадування — Premium.';

    const reminderLockedCta = document.createElement('button');
    reminderLockedCta.type = 'button';
    reminderLockedCta.className = 'secondary';
    reminderLockedCta.textContent = 'Відкрити Premium';
    reminderLocked.appendChild(reminderLockedCta);

    const reminderControls = document.createElement('div');
    reminderControls.className = 'habit-reminder__controls';

    const reminderRow = document.createElement('div');
    reminderRow.className = 'habit-reminder__row';

    const reminderInfo = document.createElement('div');
    reminderInfo.className = 'habit-reminder__info';
    const reminderRowTitle = document.createElement('div');
    reminderRowTitle.className = 'row__title';
    reminderRowTitle.textContent = 'Увімкнути нагадування';
    const reminderRowSub = document.createElement('div');
    reminderRowSub.className = 'row__subtitle';
    reminderRowSub.textContent = 'Telegram-бот';
    reminderInfo.appendChild(reminderRowTitle);
    reminderInfo.appendChild(reminderRowSub);

    const reminderToggle = document.createElement('button');
    reminderToggle.type = 'button';
    reminderToggle.className = 'toggle';
    reminderToggle.setAttribute('aria-pressed', 'false');
    reminderToggle.disabled = true;
    const reminderThumb = document.createElement('span');
    reminderThumb.className = 'toggle__thumb';
    reminderToggle.appendChild(reminderThumb);

    reminderRow.appendChild(reminderInfo);
    reminderRow.appendChild(reminderToggle);

    const reminderField = document.createElement('div');
    reminderField.className = 'habit-reminder__field';
    const reminderLabel = document.createElement('label');
    reminderLabel.className = 'field-label';
    reminderLabel.textContent = 'Час';
    const reminderTime = document.createElement('input');
    reminderTime.className = 'input';
    reminderTime.type = 'time';
    reminderTime.step = '60';
    reminderTime.disabled = true;
    reminderField.appendChild(reminderLabel);
    reminderField.appendChild(reminderTime);

    const reminderHelper = document.createElement('div');
    reminderHelper.className = 'habit-reminder__helper';
    reminderHelper.textContent = 'Функція зʼявиться найближчим часом.';

    reminderControls.appendChild(reminderRow);
    reminderControls.appendChild(reminderField);
    reminderControls.appendChild(reminderHelper);

    reminder.appendChild(reminderHeader);
    reminder.appendChild(reminderLocked);
    reminder.appendChild(reminderControls);

    edit.appendChild(reminder);

    row.appendChild(view);
    row.appendChild(edit);

    row.__refs = {
      title,
      subtitle,
      handleBtn,
      editBtn,
      routineBtn,
      editInput,
      saveBtn,
      cancelBtn,
      reminderLocked,
      reminderControls,
      reminderHelper,
    };

    return row;
  }

  function renderHabits() {
    if (!state.me) {
      showSkeleton();
      return;
    }

    ensureRoutines();
    const habits = Array.isArray(state.habits) ? state.habits : [];

    if (habits.length === 0) {
      showEmpty();
    } else {
      showContent();
    }

    if (list) {
      list.hidden = habits.length === 0;
    }

    updateAddState();

    const sorted = getSortedHabits(habits);
    const existingIds = new Set(sorted.map((habit) => habit.id));

    sorted.forEach((habit, index) => {
      if (!rowMap.has(habit.id)) {
        rowMap.set(habit.id, createHabitRow(habit));
      }
      const row = rowMap.get(habit.id);
      updateRow(row, habit, index, sorted.length);
      if (list && row.parentElement !== list) {
        list.appendChild(row);
      }
      const shouldEdit = pendingEditId && pendingEditId === habit.id;
      const shouldScroll = pendingScrollId && pendingScrollId === habit.id;
      if (shouldEdit) {
        enterEdit(row);
        pendingEditId = null;
      }
      if (shouldScroll) {
        requestAnimationFrame(() => {
          row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
        pendingScrollId = null;
      }
    });

    rowMap.forEach((row, habitId) => {
      if (!existingIds.has(Number(habitId))) {
        row.remove();
        rowMap.delete(habitId);
      }
    });

    if (pendingAddFocus) {
      pendingAddFocus = false;
      requestAnimationFrame(() => {
        if (addCard) addCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
        if (addInput) addInput.focus();
      });
    }
  }

  function ensureLoaded() {
    if (!state.me) {
      showSkeleton();
      loadMe().then(renderHabits).catch(showSkeleton);
      return;
    }
    renderHabits();
  }

  function updateMainButton() {
    if (!mainButton || !addInput) return;
    const title = normalizeHabitTitle(addInput.value);
    const limitReached = state.habits.length >= getHabitLimit();
    const valid = title.length >= MIN_TITLE_LENGTH;
    const shouldShow =
      habitsActive && document.activeElement === addInput && valid && !limitReached && !addSubmitting;

    if (shouldShow) {
      mainButton.setText('Додати');
      mainButton.show();
      mainButton.enable();
    } else {
      mainButton.hide();
    }
  }

  if (mainButton) {
    mainButton.onClick(() => {
      if (!habitsActive) return;
      handleAdd();
    });
  }

  if (addInput) {
    addInput.addEventListener('input', updateAddState);
    addInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        handleAdd();
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        resetAddForm();
        updateAddState();
        addInput.blur();
      }
    });
    addInput.addEventListener('blur', () => {
      setTimeout(() => {
        if (!root.contains(document.activeElement)) {
          resetAddForm();
          updateAddState();
        }
      }, 0);
    });
    addInput.addEventListener('focus', () => {
      if (gateHabitCreation('habit_add_focus')) {
        addInput.blur();
        return;
      }
      updateMainButton();
    });
  }

  if (addCard) {
    addCard.addEventListener('click', (event) => {
      if (gateHabitCreation('habit_add_card')) {
        event.preventDefault();
      }
    });
  }

  if (addBtn) {
    addBtn.addEventListener('click', () => {
      handleAdd();
    });
  }

  if (addCancel) {
    addCancel.addEventListener('click', () => {
      resetAddForm();
      updateAddState();
    });
  }

  chipButtons.forEach((button) => {
    button.addEventListener('click', () => {
      if (gateHabitCreation('habit_quick_chip')) return;
      const title = button.getAttribute('data-title') || button.textContent;
      handleAdd(title);
    });
  });

  updateAddState();
  updateMainButton();

  return {
    ensureLoaded,
    refresh: renderHabits,
    setActive: (active) => {
      habitsActive = active;
      updateMainButton();
      if (!active && mainButton) mainButton.hide();
    },
    openEdit: (habitId) => {
      pendingEditId = habitId;
      pendingScrollId = habitId;
      ensureLoaded();
    },
    focusAdd: () => {
      pendingAddFocus = true;
      ensureLoaded();
    },
  };
}

function buildDayLabels(range) {
  const labels = [];
  const today = new Date();
  for (let i = range - 1; i >= 0; i -= 1) {
    const date = new Date(today);
    date.setDate(today.getDate() - i);
    const label =
      range === 7
        ? date.toLocaleDateString('uk-UA', { weekday: 'short' })
        : String(date.getDate());
    labels.push({
      label,
      date,
      short: date.toLocaleDateString('uk-UA', { day: 'numeric', month: 'short' }),
    });
  }
  return labels;
}

function createStatsController() {
  const root = document.getElementById('stats');
  if (!root) {
    return { ensureLoaded: () => {}, refresh: () => {} };
  }

  const skeleton = document.getElementById('stats-skeleton');
  const content = document.getElementById('stats-content');
  const empty = document.getElementById('stats-empty');
  const rangeControl = document.getElementById('stats-range');
  const rangeButtons = rangeControl
    ? Array.from(rangeControl.querySelectorAll('.segmented__item'))
    : [];

  const streakValue = document.getElementById('stats-streak');
  const completionValue = document.getElementById('stats-completion');
  const consistencyValue = document.getElementById('stats-consistency');
  const chartCaption = document.getElementById('stats-chart-caption');
  const chart = document.getElementById('stats-chart');
  const barsContainer = document.getElementById('stats-bars');
  const labelsContainer = document.getElementById('stats-labels');
  const tooltip = document.getElementById('stats-tooltip');
  const lockedSection = document.getElementById('stats-locked');
  const heatmapGrid = document.getElementById('stats-heatmap-grid');
  const heatmapTooltip = document.getElementById('stats-heatmap-tooltip');
  const heatmapEmpty = document.getElementById('stats-heatmap-empty');
  const heatmapSkeleton = document.getElementById('stats-heatmap-skeleton');
  const heatmapMonths = document.getElementById('stats-heatmap-months');
  const heatmapCard = document.getElementById('stats-heatmap-card');
  const heatmapSubtitle = document.getElementById('stats-heatmap-subtitle');
  const heatmapHint = document.getElementById('stats-heatmap-hint');
  const heatmapLock = document.getElementById('stats-heatmap-lock');

  const cache = new Map();
  const loading = new Set();
  let activeRange = 7;
  let tooltipTimer = null;
  let heatmapTooltipTimer = null;
  let heatmapHintTimer = null;
  const heatmapCache = new Map();
  const HEATMAP_TEASER_DAYS = 7;
  let heatmapLoading = false;
  let heatmapBuilt = false;
  let heatmapDays = null;
  const heatmapCells = new Map();
  let selectedHeatmapCell = null;

  function showSkeleton() {
    if (skeleton) skeleton.hidden = false;
    if (content) content.hidden = true;
    if (empty) empty.hidden = true;
  }

  function showContent() {
    if (skeleton) skeleton.hidden = true;
    if (content) content.hidden = false;
    if (empty) empty.hidden = true;
  }

  function showEmpty() {
    if (skeleton) skeleton.hidden = true;
    if (content) content.hidden = true;
    if (empty) empty.hidden = false;
    updateLockedState();
  }

  function updateLockedState() {
    if (!lockedSection) return;
    lockedSection.hidden = !!state.features?.isPremium;
  }

  function updateRangeUI(range) {
    if (!rangeControl) return;
    rangeControl.dataset.active = range === 30 ? '1' : '0';
    rangeButtons.forEach((btn) => {
      const isActive = Number(btn.dataset.range) === range;
      btn.classList.toggle('is-active', isActive);
    });
  }

  function computeAggregates(stats, range) {
    if (!Array.isArray(stats) || stats.length === 0) return null;

    const streaks = stats.map((item) => Number(item.streak) || 0);
    const completions = stats.map((item) => Number(item.completion) || 0);

    const bestStreak = Math.max(0, ...streaks);
    const avgCompletion =
      Math.round(completions.reduce((sum, value) => sum + value, 0) / stats.length) || 0;
    const maxCompletion = Math.max(0, ...completions);

    const consistencyDays = Math.round((maxCompletion / 100) * range);

    const activeHeight = Math.min(100, Math.max(35, avgCompletion));
    const inactiveHeight = 16;

    const bars = Array.from({ length: range }, (_, index) => {
      const isActive = index >= range - consistencyDays;
      return {
        value: isActive ? activeHeight : inactiveHeight,
        active: isActive,
      };
    });

    return {
      bestStreak,
      avgCompletion,
      consistencyDays,
      bars,
    };
  }

  function shiftDate(dateString, deltaDays) {
    const parsed = new Date(`${dateString}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime())) return dateString;
    parsed.setUTCDate(parsed.getUTCDate() + deltaDays);
    return parsed.toISOString().slice(0, 10);
  }

  function applyHeatmapTeaser(payload) {
    const isPremium = !!state.features?.heatmap365;
    if (heatmapCard) heatmapCard.classList.toggle('is-teaser', !isPremium);
    if (heatmapLock) heatmapLock.hidden = isPremium;
    if (!heatmapGrid) return;
    if (isPremium) {
      heatmapCells.forEach((cell) => cell.classList.remove('is-blurred'));
      return;
    }
    const data = Array.isArray(payload?.data) ? payload.data : [];
    const lastDate = data.length ? data[data.length - 1].date : null;
    if (!lastDate) {
      heatmapCells.forEach((cell) => cell.classList.remove('is-blurred'));
      return;
    }
    const threshold = shiftDate(lastDate, -(HEATMAP_TEASER_DAYS - 1));
    heatmapCells.forEach((cell, dateKey) => {
      const shouldBlur = String(dateKey) < threshold;
      cell.classList.toggle('is-blurred', shouldBlur);
    });
  }

  function clearChart() {
    if (barsContainer) barsContainer.textContent = '';
    if (labelsContainer) labelsContainer.textContent = '';
  }

  function showTooltip(target, label, active) {
    if (!tooltip || !chart) return;
    const rect = target.getBoundingClientRect();
    const parentRect = chart.getBoundingClientRect();
    const scrollLeft = chart.scrollLeft || 0;
    tooltip.textContent = `${label} · ${active ? 'Фокус' : 'Без фокусу'}`;
    tooltip.style.left = `${rect.left - parentRect.left + scrollLeft + rect.width / 2}px`;
    tooltip.style.top = `${rect.top - parentRect.top - 8}px`;
    tooltip.hidden = false;
    if (tooltipTimer) clearTimeout(tooltipTimer);
    tooltipTimer = setTimeout(() => {
      tooltip.hidden = true;
    }, 1600);
  }

  function showHeatmapSkeleton() {
    if (heatmapSkeleton) heatmapSkeleton.hidden = false;
    if (heatmapGrid) heatmapGrid.hidden = true;
    if (heatmapEmpty) heatmapEmpty.hidden = true;
    if (heatmapMonths) heatmapMonths.hidden = true;
  }

  function showHeatmapGrid() {
    if (heatmapSkeleton) heatmapSkeleton.hidden = true;
    if (heatmapGrid) heatmapGrid.hidden = false;
    if (heatmapEmpty) heatmapEmpty.hidden = true;
    if (heatmapMonths) heatmapMonths.hidden = false;
  }

  function updateHeatmapHint() {
    if (!heatmapHint) return;
    const isPremium = !!state.features?.heatmap365;
    const trial = state.trial;
    heatmapHint.classList.remove('is-visible');
    if (isPremium && !trial?.active) {
      heatmapHint.hidden = true;
    } else {
      heatmapHint.hidden = false;
    }
    const isEmpty = heatmapEmpty && !heatmapEmpty.hidden;
    if (heatmapCard) heatmapCard.classList.toggle('is-locked', !isPremium);
    if (heatmapCard) heatmapCard.classList.toggle('is-teaser', !isPremium);
    if (heatmapLock) heatmapLock.hidden = isPremium || isEmpty;
    if (trial?.active && trial.daysLeft > 0) {
      heatmapHint.textContent = `Через ${trial.daysLeft} ${formatDays(
        trial.daysLeft
      )} історія обмежиться до 30 днів`;
    } else if (!isPremium) {
      heatmapHint.textContent = '365 днів історії — Premium';
    }
  }

  function revealHeatmapHint() {
    if (!heatmapHint || heatmapHint.hidden) return;
    heatmapHint.classList.add('is-visible');
    if (heatmapHintTimer) clearTimeout(heatmapHintTimer);
    heatmapHintTimer = setTimeout(() => {
      heatmapHint.classList.remove('is-visible');
    }, 2200);
  }

  function hideHeatmapHint() {
    if (!heatmapHint) return;
    heatmapHint.classList.remove('is-visible');
  }

  function updateHeatmapSubtitle(days) {
    if (!heatmapSubtitle) return;
    heatmapSubtitle.textContent = `Останні ${days} днів`;
  }

  function trackHeatmapOpened(days) {
    const dateKey = getUserDateKey();
    const key = getAnalyticsKey('heatmap_opened', `${dateKey}_${days}`);
    if (localStorage.getItem(key)) return;
    localStorage.setItem(key, '1');
    track('heatmap_opened', { days });
  }

  function showHeatmapEmpty(message) {
    if (heatmapSkeleton) heatmapSkeleton.hidden = true;
    if (heatmapGrid) heatmapGrid.hidden = true;
    if (heatmapMonths) heatmapMonths.textContent = '';
    if (heatmapMonths) heatmapMonths.hidden = true;
    if (heatmapEmpty) {
      heatmapEmpty.hidden = false;
      if (message) heatmapEmpty.textContent = message;
    }
    if (heatmapLock) heatmapLock.hidden = true;
    updateHeatmapHint();
  }

  function formatHeatmapDate(dateString) {
    const [year, month, day] = dateString.split('-').map(Number);
    if (!year || !month || !day) return dateString;
    const date = new Date(year, month - 1, day);
    return date.toLocaleDateString('uk-UA', {
      day: 'numeric',
      month: 'short',
    });
  }

  function getWeekdayIndex(dateString) {
    const [year, month, day] = dateString.split('-').map(Number);
    if (!year || !month || !day) return 0;
    const date = new Date(year, month - 1, day);
    const jsDay = date.getDay(); // 0 = Sunday
    return (jsDay + 6) % 7; // Monday = 0
  }

  function hideHeatmapTooltip() {
    if (!heatmapTooltip) return;
    if (heatmapTooltipTimer) {
      clearTimeout(heatmapTooltipTimer);
      heatmapTooltipTimer = null;
    }
    heatmapTooltip.classList.remove('is-visible');
    heatmapTooltip.hidden = true;
  }

  function showHeatmapTooltip(target) {
    if (!heatmapTooltip) return;
    const date = target.dataset.date;
    if (!date) return;

    const done = Number(target.dataset.done || 0);
    const total = Number(target.dataset.total || 0);
    const percent = total ? Math.round((done / total) * 100) : 0;
    const dateLabel = formatHeatmapDate(date);
    const detail = total > 0 ? `${done}/${total} · ${percent}%` : 'Без звичок';
    const level = Number(target.dataset.level || 0);
    const reward = total > 0 && level === 3 ? ' · Ідеальний день ✨' : '';

    heatmapTooltip.textContent = `${dateLabel} · ${detail}${reward}`;

    const rect = target.getBoundingClientRect();
    heatmapTooltip.style.left = `${rect.left + rect.width / 2}px`;
    heatmapTooltip.style.top = `${rect.top}px`;

    heatmapTooltip.hidden = false;
    requestAnimationFrame(() => {
      heatmapTooltip.classList.add('is-visible');
    });

    if (heatmapTooltipTimer) clearTimeout(heatmapTooltipTimer);
    heatmapTooltipTimer = setTimeout(() => {
      hideHeatmapTooltip();
    }, 1800);
  }

  function selectHeatmapCell(cell) {
    if (selectedHeatmapCell && selectedHeatmapCell !== cell) {
      selectedHeatmapCell.classList.remove('is-selected');
    }
    selectedHeatmapCell = cell;
    cell.classList.add('is-selected');
  }

  function bindHeatmapTooltip(cell) {
    cell.addEventListener('mouseenter', () => showHeatmapTooltip(cell));
    cell.addEventListener('focus', () => showHeatmapTooltip(cell));
    cell.addEventListener('click', () => {
      selectHeatmapCell(cell);
      showHeatmapTooltip(cell);
      if (Number(cell.dataset.level || 0) === 3) {
        haptic('success');
      }
    });
    cell.addEventListener('mouseleave', hideHeatmapTooltip);
    cell.addEventListener('blur', hideHeatmapTooltip);
  }

  function buildHeatmapMonths(data, offset) {
    if (!heatmapMonths) return;
    heatmapMonths.textContent = '';
    heatmapMonths.hidden = false;
    const columns = Math.ceil((offset + data.length) / 7);
    const monthLabels = new Array(columns).fill('');

    data.forEach((item, index) => {
      const [year, month, day] = item.date.split('-').map(Number);
      if (!year || !month || !day) return;
      if (day > 7) return;
      const weekIndex = Math.floor((offset + index) / 7);
      if (monthLabels[weekIndex]) return;
      const date = new Date(year, month - 1, day);
      const label = date.toLocaleDateString('uk-UA', { month: 'short' }).replace('.', '');
      monthLabels[weekIndex] = label;
    });

    monthLabels.forEach((label) => {
      const span = document.createElement('span');
      span.className = 'heatmap-month';
      span.textContent = label || '';
      if (!label) span.setAttribute('aria-hidden', 'true');
      heatmapMonths.appendChild(span);
    });
  }

  function buildHeatmapGrid(payload) {
    if (!heatmapGrid) return;
    heatmapGrid.textContent = '';
    heatmapCells.clear();

    const data = Array.isArray(payload?.data) ? payload.data : [];
    if (data.length === 0) {
      showHeatmapEmpty('Ритм стане видимим після кількох днів.');
      return;
    }

    const offset = getWeekdayIndex(data[0].date);
    buildHeatmapMonths(data, offset);
    for (let i = 0; i < offset; i += 1) {
      const filler = document.createElement('span');
      filler.className = 'hm-cell is-empty';
      filler.setAttribute('aria-hidden', 'true');
      heatmapGrid.appendChild(filler);
    }

    data.forEach((item) => {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = `hm-cell hm-${item.level || 0}`;
      cell.dataset.date = item.date;
      cell.dataset.done = String(item.done || 0);
      cell.dataset.total = String(item.total || 0);
      cell.dataset.level = String(item.level || 0);
      cell.setAttribute('aria-label', `${formatHeatmapDate(item.date)}`);
      bindHeatmapTooltip(cell);
      heatmapGrid.appendChild(cell);
      heatmapCells.set(item.date, cell);
    });

    heatmapBuilt = true;
  }

  function updateHeatmapGrid(payload) {
    if (!heatmapBuilt || !heatmapGrid) {
      buildHeatmapGrid(payload);
      return;
    }

    const data = Array.isArray(payload?.data) ? payload.data : [];
    data.forEach((item) => {
      const cell = heatmapCells.get(item.date);
      if (!cell) return;
      const level = item.level || 0;
      cell.className = `hm-cell hm-${level}`;
      cell.dataset.done = String(item.done || 0);
      cell.dataset.total = String(item.total || 0);
      cell.dataset.level = String(level);
    });
  }

  function renderHeatmap(payload, days) {
    if (heatmapDays !== days) {
      heatmapBuilt = false;
      heatmapDays = days;
      selectedHeatmapCell = null;
    }

    const data = Array.isArray(payload?.data) ? payload.data : [];
    const hasAny = data.some((item) => Number(item.total) > 0);
    if (!hasAny) {
      showHeatmapEmpty('Ритм стане видимим після кількох днів.');
      return;
    }

    updateHeatmapHint();
    showHeatmapGrid();
    updateHeatmapGrid(payload);
    applyHeatmapTeaser(payload);
  }

  async function loadHeatmap() {
    if (heatmapLoading) return;
    const days = state.features?.heatmap365 ? 365 : 30;
    updateHeatmapSubtitle(days);
    if (heatmapCache.has(days)) {
      renderHeatmap(heatmapCache.get(days), days);
      return;
    }
    heatmapLoading = true;
    showHeatmapSkeleton();

    try {
      const payload = await apiFetch(`/api/stats/heatmap?days=${days}`);
      heatmapCache.set(days, payload);
      renderHeatmap(payload, days);
    } catch (error) {
      showHeatmapEmpty('Не вдалося завантажити heatmap.');
      showToast({
        type: 'error',
        message:
          error?.type === 'network'
            ? 'Немає звʼязку. Спробуй ще раз.'
            : 'Не вдалося завантажити heatmap.',
      });
    } finally {
      heatmapLoading = false;
    }
  }

  function ensureHeatmap() {
    updateHeatmapHint();
    const days = state.features?.heatmap365 ? 365 : 30;
    trackHeatmapOpened(days);
    if (!state.habits || state.habits.length === 0) {
      showHeatmapEmpty('Ритм стане видимим після кількох днів.');
      return;
    }
    loadHeatmap();
  }

  function renderChart(range, data) {
    if (!barsContainer || !labelsContainer) return;
    clearChart();
    const labels = buildDayLabels(range);

    labels.forEach((item, index) => {
      const bar = document.createElement('button');
      bar.type = 'button';
      bar.className = `chart-bar${data.bars[index].active ? ' is-active' : ''}`;
      bar.style.setProperty('--bar-height', `${data.bars[index].value}%`);
      bar.setAttribute(
        'aria-label',
        `${item.short}: ${data.bars[index].active ? 'Фокус' : 'Без фокусу'}`
      );

      const fill = document.createElement('span');
      fill.className = 'chart-bar__fill';
      bar.appendChild(fill);

      bar.addEventListener('click', () => {
        showTooltip(bar, item.short, data.bars[index].active);
      });
      bar.addEventListener('mouseenter', () => {
        showTooltip(bar, item.short, data.bars[index].active);
      });
      bar.addEventListener('focus', () => {
        showTooltip(bar, item.short, data.bars[index].active);
      });
      bar.addEventListener('mouseleave', () => {
        if (tooltip) tooltip.hidden = true;
      });

      barsContainer.appendChild(bar);

      const label = document.createElement('div');
      label.textContent = item.label.replace('.', '');
      labelsContainer.appendChild(label);
    });
  }

  function renderStats(range) {
    const payload = cache.get(range);
    if (!payload) return;

    const stats = payload.stats || [];
    const aggregates = computeAggregates(stats, range);

    if (!aggregates || (aggregates.bestStreak === 0 && aggregates.avgCompletion === 0)) {
      showEmpty();
      return;
    }

    showContent();
    updateLockedState();

    if (streakValue) streakValue.textContent = `${aggregates.bestStreak} дн.`;
    if (completionValue) completionValue.textContent = `${aggregates.avgCompletion}%`;
    if (consistencyValue) {
      consistencyValue.textContent = `${aggregates.consistencyDays}/${range}`;
    }
    if (chartCaption) {
      chartCaption.textContent = `За останні ${range} днів`;
    }

    renderChart(range, aggregates);
    ensureHeatmap();
  }

  async function loadStats(range) {
    if (loading.has(range)) return;
    loading.add(range);
    showSkeleton();

    try {
      const payload = await apiFetch(`/api/stats?range=${range}`);
      cache.set(range, payload);
      renderStats(range);
      ensureHeatmap();
    } catch (error) {
      showEmpty();
      showToast({
        type: 'error',
        message:
          error?.type === 'network'
            ? 'Немає звʼязку. Спробуй ще раз.'
            : 'Не вдалося завантажити статистику.',
      });
    } finally {
      loading.delete(range);
    }
  }

  function ensureLoaded() {
    if (!state.me) {
      showSkeleton();
      loadMe().then(() => ensureLoaded()).catch(showSkeleton);
      return;
    }

    if (!state.habits || state.habits.length === 0) {
      showEmpty();
      updateLockedState();
      return;
    }

    if (cache.has(activeRange)) {
      renderStats(activeRange);
      ensureHeatmap();
      return;
    }

    loadStats(activeRange);
  }

  rangeButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const range = Number(button.dataset.range) === 30 ? 30 : 7;
      if (range === activeRange) return;
      activeRange = range;
      updateRangeUI(activeRange);
      ensureLoaded();
    });
  });

  updateRangeUI(activeRange);

  if (chart) {
    chart.addEventListener('scroll', () => {
      if (tooltip) tooltip.hidden = true;
    });
  }

  if (heatmapCard) {
    heatmapCard.addEventListener('mouseenter', () => revealHeatmapHint());
    heatmapCard.addEventListener('focusin', () => revealHeatmapHint());
    heatmapCard.addEventListener('mouseleave', () => hideHeatmapHint());
    heatmapCard.addEventListener('focusout', () => hideHeatmapHint());
    heatmapCard.addEventListener('click', () => revealHeatmapHint());
    heatmapCard.addEventListener('touchstart', () => revealHeatmapHint(), {
      passive: true,
    });
  }

  return {
    ensureLoaded,
    refresh: () => renderStats(activeRange),
  };
}

function createSettingsController() {
  const root = document.getElementById('settings');
  if (!root) {
    return { ensureLoaded: () => {}, refresh: () => {} };
  }

  const skeleton = document.getElementById('settings-skeleton');
  const content = document.getElementById('settings-content');
  const timezoneInput = document.getElementById('settings-timezone');
  const reminderToggle = document.getElementById('settings-reminders-toggle');
  const reminderTimeInput = document.getElementById('settings-reminder-time');
  const versionInput = document.getElementById('settings-version');
  const settingsAvatarText = document.getElementById('settings-avatar-text');
  const settingsProBadge = document.getElementById('settings-pro-badge');
  const settingsGoPro = document.getElementById('settings-go-pro');
  const appearanceLocked = document.getElementById('settings-appearance-locked');
  const premiumCard = document.getElementById('settings-premium-card');
  const debugUserId = document.getElementById('settings-user-id');
  const debugPremiumBtn = document.getElementById('settings-test-premium');
  const premiumSubtitle = document.getElementById('premium-subtitle');
  const premiumStatus = document.getElementById('premium-status');
  const premiumInviteBtn = document.getElementById('premium-invite-btn');
  const premiumAfterBtn = document.getElementById('premium-after-btn');
  const premiumAfterNote = document.getElementById('premium-after-note');
  const premiumTrialProgress = document.getElementById('premium-trial-progress');
  const premiumTrialBar = document.getElementById('premium-trial-bar');
  const premiumTrialLabels = document.getElementById('premium-trial-labels');
  const partnerStatus = document.getElementById('partner-status');
  const partnerEmpty = document.getElementById('partner-empty');
  const partnerConnected = document.getElementById('partner-connected');
  const partnerInviteBtn = document.getElementById('partner-invite-btn');
  const partnerCopyBtn = document.getElementById('partner-copy-btn');
  const partnerUnlinkBtn = document.getElementById('partner-unlink-btn');
  const partnerCheckTime = document.getElementById('partner-check-time');
  const partnerCheckTimeConnected = document.getElementById('partner-check-time-connected');
  const partnerUsername = document.getElementById('partner-username');
  const partnerPremiumHint = document.getElementById('partner-premium-hint');

  let reminderSaving = false;
  let lastReminderTime = '';

  function showSkeleton() {
    if (skeleton) skeleton.hidden = false;
    if (content) content.hidden = true;
  }

  function showContent() {
    if (skeleton) skeleton.hidden = true;
    if (content) content.hidden = false;
  }

  function formatDateShort(value) {
    if (!value) return '';
    const raw = String(value);
    const match = raw.match(/^(\d{4}-\d{2}-\d{2})/);
    return match ? match[1] : raw;
  }

  function resolveAvatarInitial() {
    const tgUser = tg?.initDataUnsafe?.user;
    const label = tgUser?.first_name || tgUser?.username || '';
    if (label) return label.trim().charAt(0).toUpperCase();
    return 'U';
  }

  function applySettingsHeader() {
    const isPremium = !!state.features?.isPremium;
    if (settingsAvatarText) settingsAvatarText.textContent = resolveAvatarInitial();
    if (settingsProBadge) settingsProBadge.hidden = !isPremium;
    if (settingsGoPro) settingsGoPro.hidden = isPremium;
  }

  function getPremiumInviteLink() {
    const username = state.me?.botUsername || '';
    if (!username) return '';
    return `https://t.me/${username}?start=premium`;
  }

  let premiumAction = 'invite';

  function applyPremiumState() {
    const plan = state.me?.plan || state.me?.user?.plan || 'free';
    const trial = state.trial || getTrialInfo(state.me);
    const hasTrial = !!(state.me?.trialUntil || state.me?.user?.trial_until);
    const trialEnded = hasTrial && !trial.active;

    premiumAction = 'invite';
    if (premiumCard) premiumCard.hidden = false;
    if (premiumStatus) premiumStatus.hidden = true;
    if (premiumAfterNote) premiumAfterNote.hidden = true;

    if (premiumSubtitle) {
      premiumSubtitle.textContent = 'Отримай 7 днів Premium — запроси друга';
    }

    if (premiumTrialProgress) premiumTrialProgress.hidden = true;
    if (premiumTrialLabels) premiumTrialLabels.hidden = true;
    if (premiumAfterBtn) premiumAfterBtn.hidden = true;
    if (premiumInviteBtn) premiumInviteBtn.hidden = false;

    if (plan === 'premium' && trial.active) {
      if (premiumSubtitle) premiumSubtitle.textContent = 'Без оплати. Просто спробуй Premium.';
      if (premiumStatus) {
        premiumStatus.hidden = false;
        premiumStatus.textContent = `Premium активний · залишилось ${trial.daysLeft} ${formatDays(
          trial.daysLeft
        )}`;
      }
      if (premiumTrialProgress && premiumTrialBar) {
        premiumTrialProgress.hidden = false;
        premiumTrialBar.style.setProperty(
          '--trial-progress',
          `${Math.min(100, Math.max(0, (trial.daysLeft / TRIAL_LENGTH_DAYS) * 100))}%`
        );
      }
      if (premiumTrialLabels) premiumTrialLabels.hidden = false;
      if (premiumInviteBtn) premiumInviteBtn.hidden = true;
      if (premiumAfterBtn) premiumAfterBtn.hidden = false;
      premiumAction = 'none';
      return;
    }

    if (trialEnded) {
      if (premiumSubtitle) {
        premiumSubtitle.textContent = 'Продовжити Premium — без втрати даних';
      }
      if (premiumStatus) {
        premiumStatus.hidden = false;
        premiumStatus.textContent = 'Trial завершився';
      }
      if (premiumInviteBtn) premiumInviteBtn.textContent = 'Залишити Premium';
      premiumAction = 'interest';
      return;
    }

    if (plan === 'premium' && !trial.active) {
      if (premiumSubtitle) premiumSubtitle.textContent = 'Premium активний';
      if (premiumInviteBtn) premiumInviteBtn.hidden = true;
      premiumAction = 'none';
    }
  }

  function handlePremiumAction() {
    if (premiumAction === 'none') return;
    if (premiumAction === 'interest') {
      openPremiumInterest('settings');
      return;
    }
    const link = getPremiumInviteLink();
    if (!link) {
      showToast({ type: 'error', message: 'Не вдалося сформувати лінк.' });
      return;
    }
    if (tg?.openTelegramLink) {
      tg.openTelegramLink(link);
      return;
    }
    window.open(link, '_blank');
  }

  function applyUser(user) {
    const isPremium = !!state.features?.isPremium;
    if (debugUserId) {
      const telegramId = user?.telegram_id;
      const value =
        telegramId !== undefined && telegramId !== null && telegramId !== ''
          ? telegramId
          : 'undefined';
      debugUserId.textContent = `UserID: ${value}`;
    }
    if (timezoneInput) {
      timezoneInput.value = user?.timezone || 'Europe/Prague';
    }
    if (reminderTimeInput) {
      reminderTimeInput.value = user?.reminder_time || '20:00';
      lastReminderTime = reminderTimeInput.value;
    }
    if (reminderToggle) {
      reminderToggle.setAttribute('aria-pressed', 'true');
      reminderToggle.disabled = true;
    }
    if (versionInput) {
      versionInput.value = BUILD_ID;
    }
    if (appearanceLocked) appearanceLocked.hidden = isPremium;
    applySettingsHeader();
    applyPremiumState();
    applyPartnerState();
  }

  function applyPartnerState() {
    const connected = !!state.me?.monitor?.connected;
    const username = state.me?.monitor?.monitorUsername || '';
    const name = state.me?.monitor?.monitorName || '';
    const label = username || name;
    const tz = state.me?.user?.timezone || 'Europe/Prague';
    const scheduleText = `Час перевірки: 21:00 (${tz})`;
    if (partnerStatus) {
      partnerStatus.textContent = connected
        ? label
          ? `Підключено: ${label}`
          : 'Підключено'
        : 'Не підключено';
      partnerStatus.classList.toggle('is-active', connected);
    }
    if (partnerEmpty) partnerEmpty.hidden = connected;
    if (partnerConnected) partnerConnected.hidden = !connected;
    if (partnerCheckTime) partnerCheckTime.textContent = scheduleText;
    if (partnerCheckTimeConnected) partnerCheckTimeConnected.textContent = scheduleText;
    if (partnerUsername) {
      partnerUsername.textContent = label ? `Партнер: ${label}` : '';
    }
    if (partnerPremiumHint) {
      const showHint = !!state.trial?.active || !state.features?.isPremium;
      partnerPremiumHint.hidden = !showHint;
    }
  }

  function getInviteLink() {
    return state.me?.inviteLink || '';
  }

  async function handleInvite() {
    const link = getInviteLink();
    if (!link) {
      showToast({ type: 'error', message: 'Не вдалося сформувати лінк.' });
      return;
    }
    if (tg?.openTelegramLink) {
      tg.openTelegramLink(link);
      return;
    }
    window.open(link, '_blank');
  }

  async function handleCopyLink() {
    const link = getInviteLink();
    if (!link) {
      showToast({ type: 'error', message: 'Не вдалося сформувати лінк.' });
      return;
    }
    try {
      await navigator.clipboard.writeText(link);
      showToast({ type: 'success', message: 'Лінк скопійовано' });
    } catch {
      showToast({ type: 'error', message: 'Не вдалося скопіювати лінк.' });
    }
  }

  async function handleUnlink() {
    try {
      await apiFetch('/api/monitor/unlink', { method: 'POST' });
      if (state.me) {
        state.me.monitor = { connected: false };
      }
      applyPartnerState();
      showToast({ type: 'success', message: 'Партнера відʼєднано' });
    } catch (error) {
      showToast({
        type: 'error',
        message:
          error?.type === 'network'
            ? 'Немає звʼязку. Спробуй ще раз.'
            : 'Не вдалося відʼєднати.',
      });
    }
  }

  function requestUnlinkConfirm() {
    showToast({
      type: 'error',
      message: 'Відʼєднати партнера?',
      actionLabel: 'Підтвердити',
      duration: 3200,
      onAction: () => handleUnlink(),
    });
  }

  async function saveReminderTime(value) {
    if (!value) {
      if (reminderTimeInput) reminderTimeInput.value = lastReminderTime;
      return;
    }
    if (reminderSaving || value === lastReminderTime) return;
    reminderSaving = true;
    if (reminderTimeInput) reminderTimeInput.disabled = true;

    try {
      const payload = await apiFetch('/api/settings', {
        method: 'POST',
        body: JSON.stringify({ reminder_time: value }),
      });

      if (payload?.user) {
        state.me = { ...state.me, user: payload.user };
      } else if (state.me?.user) {
        state.me.user = { ...state.me.user, reminder_time: value };
      }

      lastReminderTime = value;
      showToast({ type: 'success', message: 'Час оновлено' });
      haptic('success');
    } catch (error) {
      if (reminderTimeInput) reminderTimeInput.value = lastReminderTime;
      showToast({
        type: 'error',
        message:
          error?.type === 'network'
            ? 'Немає звʼязку. Спробуй ще раз.'
            : 'Не вдалося зберегти час.',
        actionLabel: 'Повторити',
        onAction: () => saveReminderTime(value),
      });
      haptic('error');
    } finally {
      reminderSaving = false;
      if (reminderTimeInput) reminderTimeInput.disabled = false;
    }
  }

  if (reminderTimeInput) {
    reminderTimeInput.addEventListener('change', () => {
      const value = reminderTimeInput.value;
      saveReminderTime(value);
    });
    reminderTimeInput.addEventListener('blur', () => {
      const value = reminderTimeInput.value;
      saveReminderTime(value);
    });
  }

  if (partnerInviteBtn) {
    partnerInviteBtn.addEventListener('click', () => {
      handleInvite();
    });
  }

  if (partnerCopyBtn) {
    partnerCopyBtn.addEventListener('click', () => {
      handleCopyLink();
    });
  }

  if (partnerUnlinkBtn) {
    partnerUnlinkBtn.addEventListener('click', () => {
      requestUnlinkConfirm();
    });
  }

  if (premiumInviteBtn) {
    premiumInviteBtn.addEventListener('click', () => {
      handlePremiumAction();
    });
  }

  if (settingsGoPro) {
    settingsGoPro.addEventListener('click', () => {
      openPremiumModal('settings_header');
    });
  }

  if (debugPremiumBtn) {
    debugPremiumBtn.addEventListener('click', () => {
      openPremiumModal('settings_debug', { force: true });
    });
  }

  if (premiumAfterBtn && premiumAfterNote) {
    premiumAfterBtn.addEventListener('click', () => {
      premiumAfterNote.hidden = !premiumAfterNote.hidden;
    });
  }

  function ensureLoaded() {
    if (!state.me) {
      showSkeleton();
      loadMe()
        .then(() => {
          showContent();
          applyUser(state.me?.user);
        })
        .catch(showSkeleton);
      return;
    }

    showContent();
    applyUser(state.me.user);
  }

  return {
    ensureLoaded,
    refresh: () => {
      if (state.me?.user) applyUser(state.me.user);
    },
  };
}

function boot() {
  // Step C: App shell routing only (no data)
  if (trialSheetAccept) {
    trialSheetAccept.addEventListener('click', () => {
      hideTrialSheet();
      openPremiumInterest('trial_day5_sheet');
    });
  }

  if (trialSheetLater) {
    trialSheetLater.addEventListener('click', () => {
      hideTrialSheet();
    });
  }

  if (trialBackdrop) {
    trialBackdrop.addEventListener('click', () => {
      hideTrialSheet();
    });
  }

  if (premiumModalClose) {
    premiumModalClose.addEventListener('click', () => closePremiumModal());
  }

  if (premiumModalLater) {
    premiumModalLater.addEventListener('click', () => closePremiumModal());
  }

  if (premiumBackdrop) {
    premiumBackdrop.addEventListener('click', () => closePremiumModal());
  }

  if (premiumModalCta) {
    premiumModalCta.addEventListener('click', () => {
      showToast({ type: 'success', message: 'Upgrade simulated. Welcome to Premium.' });
      closePremiumModal();
    });
  }

  const tabButtons = document.querySelectorAll('.tabbar__item');
  const panels = document.querySelectorAll('.panel');
  let currentTab = null;

  function setActiveTab(tab) {
    if (currentTab === tab) return;
    currentTab = tab;
    tabButtons.forEach((btn) => {
      const isActive = btn.dataset.tab === tab;
      btn.classList.toggle('is-active', isActive);
      btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });

    panels.forEach((panel) => {
      const isActive = panel.dataset.tab === tab;
      panel.classList.toggle('is-active', isActive);
    });
  }

  const dashboard = createDashboardController(setActiveTab);
  const habits = createHabitsController({ onHabitsChanged: dashboard.refresh });
  const stats = createStatsController();
  const settings = createSettingsController();

  window.__habitsController = habits;
  window.__statsController = stats;

  tabButtons.forEach((button) => {
    button.addEventListener('click', () => {
      setActiveTab(button.dataset.tab);
      if (button.dataset.tab === 'dashboard') {
        dashboard.ensureLoaded();
      }
      if (button.dataset.tab === 'habits') {
        habits.ensureLoaded();
      }
      habits.setActive(button.dataset.tab === 'habits');
      if (button.dataset.tab === 'stats') {
        stats.ensureLoaded();
      }
      if (button.dataset.tab === 'settings') {
        settings.ensureLoaded();
      }
    });
  });

  setActiveTab('dashboard');
  dashboard.ensureLoaded();
  habits.setActive(false);
}

startInitFlow();
