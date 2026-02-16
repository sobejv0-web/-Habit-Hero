// =============================================================================
// interactions.js — Event Handling for Habit System v2
//
// ONE event listener on #bento-grid via event delegation.
// Handles:  tap, long-press (500 ms), counter "+", timer toggle,
//           keyboard (Enter / Space), scroll-cancel.
// =============================================================================

'use strict';

import { Actions } from './store.js';
import { haptic } from './utils.js';

// ─── Config ──────────────────────────────────────────────────────────────────

const LONG_PRESS_MS   = 500;
const MOVE_THRESHOLD  = 10;   // px — cancel long-press if finger moves

// ─── State ───────────────────────────────────────────────────────────────────

let _store     = null;
let _onHabitTap    = null;   // (habitId) => void  — supplied by app.js
let _onRoutineTap  = null;   // (routineId) => void
let _onLongPress   = null;   // (habitId | routineId, kind) => void
let _onCounterTap  = null;   // (habitId) => void
let _onTimerToggle = null;   // (habitId) => void
let _onListItemTap = null;   // (habitId) => void

let _pressTimer      = null;
let _longPressFired  = false;
let _moved           = false;
let _startX          = 0;
let _startY          = 0;
let _pressTargetCard = null;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Walk up from event.target to find the closest card / actionable element.
 * Returns { card, kind, id, action } or null.
 */
function resolveTarget(evt) {
  const target = evt.target;

  // Timer toggle button — check first (nested inside card)
  const timerBtn = target.closest('[data-action="timer-toggle"]');
  if (timerBtn) {
    const card = timerBtn.closest('.bento-card');
    const habitId = card?.dataset.habitId;
    if (habitId) return { card, kind: 'timer-toggle', id: Number(habitId), action: 'timer-toggle' };
  }

  // Counter increment button
  const counterBtn = target.closest('[data-action="counter-inc"]');
  if (counterBtn) {
    const card = counterBtn.closest('.bento-card');
    const habitId = card?.dataset.habitId;
    if (habitId) return { card, kind: 'counter-inc', id: Number(habitId), action: 'counter-inc' };
  }

  // Bento card (habit or routine)
  const card = target.closest('.bento-card');
  if (card) {
    const kind = card.dataset.kind || 'habit';
    const id   = kind === 'routine'
      ? card.dataset.routineId
      : Number(card.dataset.habitId);
    return { card, kind, id, action: 'tap' };
  }

  // Habit list item (Habits tab)
  const listItem = target.closest('.list-item[data-habit-id]');
  if (listItem) {
    return { card: listItem, kind: 'habit-list', id: Number(listItem.dataset.habitId), action: 'list-tap' };
  }

  return null;
}

function clearPress() {
  if (_pressTimer) {
    clearTimeout(_pressTimer);
    _pressTimer = null;
  }
  _moved           = false;
  _pressTargetCard = null;
}

// ─── Pointer Handlers ────────────────────────────────────────────────────────

function onPointerDown(evt) {
  // Ignore right-click
  if (evt.pointerType === 'mouse' && evt.button !== 0) return;

  const resolved = resolveTarget(evt);
  if (!resolved) return;

  // Immediate actions (don't need long-press logic)
  if (resolved.action === 'timer-toggle' || resolved.action === 'counter-inc') {
    return; // handled on pointerup / click
  }

  _startX          = evt.clientX;
  _startY          = evt.clientY;
  _moved           = false;
  _longPressFired  = false;
  _pressTargetCard = resolved.card;

  _pressTimer = setTimeout(() => {
    _longPressFired = true;
    haptic('medium');

    if (resolved.kind === 'routine') {
      _onLongPress?.(resolved.id, 'routine');
    } else if (resolved.kind === 'habit' || resolved.kind === 'habit-list') {
      _onLongPress?.(resolved.id, 'habit');
    }
  }, LONG_PRESS_MS);
}

function onPointerMove(evt) {
  if (!_pressTimer) return;
  const dx = Math.abs(evt.clientX - _startX);
  const dy = Math.abs(evt.clientY - _startY);
  if (dx > MOVE_THRESHOLD || dy > MOVE_THRESHOLD) {
    _moved = true;
    clearPress();
  }
}

function onPointerUp(evt) {
  if (_pressTimer) clearTimeout(_pressTimer);
  _pressTimer = null;

  if (_longPressFired || _moved) {
    _longPressFired = false;
    _moved = false;
    return;
  }

  const resolved = resolveTarget(evt);
  if (!resolved) return;

  // ── Immediate actions ──
  if (resolved.action === 'timer-toggle') {
    haptic('light');
    _onTimerToggle?.(resolved.id);
    return;
  }

  if (resolved.action === 'counter-inc') {
    haptic('light');
    _onCounterTap?.(resolved.id);
    return;
  }

  // ── Card tap ──
  if (resolved.kind === 'routine') {
    haptic('light');
    _onRoutineTap?.(resolved.id);
    return;
  }

  if (resolved.kind === 'habit-list') {
    haptic('selection');
    _onListItemTap?.(resolved.id);
    return;
  }

  // Default: habit card tap
  haptic('selection');
  _onHabitTap?.(resolved.id);
}

function onPointerLeave() {
  clearPress();
}

function onPointerCancel() {
  clearPress();
}

// ─── Keyboard ────────────────────────────────────────────────────────────────

function onKeyDown(evt) {
  if (evt.key !== 'Enter' && evt.key !== ' ') return;

  const resolved = resolveTarget(evt);
  if (!resolved) return;

  evt.preventDefault();

  if (resolved.action === 'timer-toggle') {
    _onTimerToggle?.(resolved.id);
    return;
  }

  if (resolved.kind === 'routine') {
    _onRoutineTap?.(resolved.id);
    return;
  }

  if (resolved.kind === 'habit-list') {
    _onListItemTap?.(resolved.id);
    return;
  }

  _onHabitTap?.(resolved.id);
}

// ─── Context Sheet Actions ───────────────────────────────────────────────────

function setupSheetActions() {
  const sheet = document.getElementById('context-sheet');
  if (!sheet) return;

  sheet.addEventListener('click', (evt) => {
    const action = evt.target?.dataset?.action;
    if (!action) return;
    if (action === 'close') {
      _store?.dispatch({ type: Actions.CONTEXT_MENU_CLOSE });
      return;
    }
    // Emit a custom event so app.js can handle specific actions
    sheet.dispatchEvent(new CustomEvent('sheet-action', {
      detail: { action },
      bubbles: true,
    }));
  });

  // Backdrop click closes
  const backdrop = document.getElementById('sheet-backdrop');
  if (backdrop) {
    backdrop.addEventListener('click', () => {
      _store?.dispatch({ type: Actions.CONTEXT_MENU_CLOSE });
    });
  }
}

// ─── 5-Min Modal Buttons ─────────────────────────────────────────────────────

function setupFiveMinModal() {
  const acceptBtn = document.getElementById('five-min-accept');
  const skipBtn   = document.getElementById('five-min-skip');

  if (acceptBtn) {
    acceptBtn.addEventListener('click', () => {
      haptic('light');
      _store?.dispatch({ type: Actions.FIVE_MIN_ACCEPT });
    });
  }

  if (skipBtn) {
    skipBtn.addEventListener('click', () => {
      haptic('light');
      // Skip = actually send the skip intent
      const habitId = _store?.getState().ui.fiveMin.habitId;
      if (habitId) {
        _store?.dispatch({ type: Actions.FIVE_MIN_DISMISS });
        _onHabitTap?.(habitId);      // will cycle to skip
      }
    });
  }
}

// ─── Focus Mode Buttons ──────────────────────────────────────────────────────

function setupFocusMode() {
  const done = document.getElementById('focus-done');
  const skip = document.getElementById('focus-skip');
  const exit = document.getElementById('focus-exit');

  if (done) {
    done.addEventListener('click', () => {
      haptic('success');
      const state = _store?.getState();
      if (!state?.focus.active) return;
      const routine = state.routines.find(r => r.id === state.focus.routineId);
      if (!routine) return;
      const habitId = (routine.habitIds || [])[state.focus.stepIndex];
      if (habitId) _onHabitTap?.(habitId);

      // Advance to next step
      const nextIdx = state.focus.stepIndex + 1;
      if (nextIdx < (routine.habitIds || []).length) {
        _store.dispatch({ type: Actions.FOCUS_NEXT });
      } else {
        _store.dispatch({ type: Actions.FOCUS_EXIT });
      }
    });
  }

  if (skip) {
    skip.addEventListener('click', () => {
      haptic('light');
      const state = _store?.getState();
      if (!state?.focus.active) return;
      const routine = state.routines.find(r => r.id === state.focus.routineId);
      if (!routine) return;

      const nextIdx = state.focus.stepIndex + 1;
      if (nextIdx < (routine.habitIds || []).length) {
        _store.dispatch({ type: Actions.FOCUS_NEXT });
      } else {
        _store.dispatch({ type: Actions.FOCUS_EXIT });
      }
    });
  }

  if (exit) {
    exit.addEventListener('click', () => {
      haptic('light');
      _store?.dispatch({ type: Actions.FOCUS_EXIT });
    });
  }
}

// ─── Tab bar ─────────────────────────────────────────────────────────────────

function setupTabBar() {
  const tabButtons = document.querySelectorAll('.tabbar__item');
  const panels     = document.querySelectorAll('.panel');

  tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      _store?.dispatch({ type: Actions.SET_ACTIVE_TAB, payload: tab });

      tabButtons.forEach((b) => {
        const active = b.dataset.tab === tab;
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-selected', active ? 'true' : 'false');
      });

      panels.forEach((p) => {
        p.classList.toggle('is-active', p.dataset.tab === tab);
      });

      haptic('selection');
    });
  });
}

// ─── Habit Add Form ──────────────────────────────────────────────────────────

let _onAddHabit = null;

function setupHabitAddForm() {
  const input       = document.getElementById('habit-add-input');
  const addBtn      = document.getElementById('habit-add-btn');
  const typeButtons = document.querySelectorAll('.type-btn');
  const counterConf = document.getElementById('counter-config');
  const timerConf   = document.getElementById('timer-config');
  const chips       = document.querySelectorAll('#habit-quick-chips .chip-btn');

  let selectedType = 'boolean';

  // Type selector
  typeButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      selectedType = btn.dataset.type || 'boolean';
      typeButtons.forEach(b => b.classList.toggle('is-active', b === btn));
      if (counterConf) counterConf.hidden = selectedType !== 'counter';
      if (timerConf)   timerConf.hidden   = selectedType !== 'timer';
      haptic('selection');
    });
  });

  // Add button
  if (addBtn && input) {
    addBtn.addEventListener('click', () => {
      const title = input.value.trim();
      if (!title) return;

      const data = { title, type: selectedType };

      if (selectedType === 'counter') {
        const targetEl = document.getElementById('counter-target');
        const stepEl   = document.getElementById('counter-step');
        if (targetEl?.value) data.counterTarget = Number(targetEl.value);
        if (stepEl?.value)   data.counterStep   = Number(stepEl.value);
      }

      if (selectedType === 'timer') {
        const durEl = document.getElementById('timer-duration');
        if (durEl?.value) data.timerDuration = Number(durEl.value) * 60; // minutes → seconds
      }

      _onAddHabit?.(data);

      // Reset form
      input.value = '';
      if (document.getElementById('counter-target')) document.getElementById('counter-target').value = '';
      if (document.getElementById('counter-step'))   document.getElementById('counter-step').value = '';
      if (document.getElementById('timer-duration'))  document.getElementById('timer-duration').value = '';
      selectedType = 'boolean';
      typeButtons.forEach(b => b.classList.toggle('is-active', b.dataset.type === 'boolean'));
      if (counterConf) counterConf.hidden = true;
      if (timerConf)   timerConf.hidden   = true;

      haptic('success');
    });
  }

  // Quick chips
  chips.forEach(chip => {
    chip.addEventListener('click', () => {
      const title    = chip.dataset.title;
      const type     = chip.dataset.type || 'boolean';
      const data     = { title, type };

      if (type === 'counter') {
        if (chip.dataset.target) data.counterTarget = Number(chip.dataset.target);
        if (chip.dataset.step)   data.counterStep   = Number(chip.dataset.step);
      }
      if (type === 'timer' && chip.dataset.duration) {
        data.timerDuration = Number(chip.dataset.duration) * 60;
      }

      _onAddHabit?.(data);
      haptic('success');
    });
  });
}

// ─── Retry button ─────────────────────────────────────────────────────────────

let _onRetry = null;

function setupRetry() {
  const retryBtn = document.getElementById('dashboard-retry');
  if (retryBtn) {
    retryBtn.addEventListener('click', () => _onRetry?.());
  }
}

// ─── Empty state CTA ─────────────────────────────────────────────────────────

function setupEmptyCta() {
  const cta = document.getElementById('dashboard-empty-cta');
  if (cta) {
    cta.addEventListener('click', () => {
      _store?.dispatch({ type: Actions.SET_ACTIVE_TAB, payload: 'habits' });
      // Sync tab UI
      document.querySelectorAll('.tabbar__item').forEach(b => {
        const active = b.dataset.tab === 'habits';
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      document.querySelectorAll('.panel').forEach(p => {
        p.classList.toggle('is-active', p.dataset.tab === 'habits');
      });
    });
  }

  // Same for habits empty CTA
  const habitsCta = document.getElementById('habits-empty-cta');
  if (habitsCta) {
    habitsCta.addEventListener('click', () => {
      const input = document.getElementById('habit-add-input');
      if (input) input.focus();
    });
  }
}

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Wire all event listeners. Call once during boot.
 *
 * @param {Object} opts
 * @param {Store}  opts.store
 * @param {Function} opts.onHabitTap     (habitId) => void
 * @param {Function} opts.onRoutineTap   (routineId) => void
 * @param {Function} opts.onLongPress    (id, kind) => void
 * @param {Function} opts.onCounterTap   (habitId) => void
 * @param {Function} opts.onTimerToggle  (habitId) => void
 * @param {Function} opts.onAddHabit     (data) => void
 * @param {Function} opts.onRetry        () => void
 * @param {Function} [opts.onListItemTap]  (habitId) => void
 */
export function initInteractions(opts) {
  _store          = opts.store;
  _onHabitTap     = opts.onHabitTap;
  _onRoutineTap   = opts.onRoutineTap;
  _onLongPress    = opts.onLongPress;
  _onCounterTap   = opts.onCounterTap;
  _onTimerToggle  = opts.onTimerToggle;
  _onAddHabit     = opts.onAddHabit;
  _onRetry        = opts.onRetry;
  _onListItemTap  = opts.onListItemTap || null;

  // ── Delegated pointer events on #bento-grid ──
  const grid = document.getElementById('bento-grid');
  if (grid) {
    grid.addEventListener('pointerdown',   onPointerDown,   { passive: true });
    grid.addEventListener('pointermove',   onPointerMove,   { passive: true });
    grid.addEventListener('pointerup',     onPointerUp);
    grid.addEventListener('pointerleave',  onPointerLeave);
    grid.addEventListener('pointercancel', onPointerCancel);
    grid.addEventListener('keydown',       onKeyDown);
  }

  // ── Delegated pointer events on #habits-list ──
  const list = document.getElementById('habits-list');
  if (list) {
    list.addEventListener('pointerdown',   onPointerDown,   { passive: true });
    list.addEventListener('pointermove',   onPointerMove,   { passive: true });
    list.addEventListener('pointerup',     onPointerUp);
    list.addEventListener('pointerleave',  onPointerLeave);
    list.addEventListener('pointercancel', onPointerCancel);
    list.addEventListener('keydown',       onKeyDown);
  }

  // ── Static UI wiring ──
  setupSheetActions();
  setupFiveMinModal();
  setupFocusMode();
  setupTabBar();
  setupHabitAddForm();
  setupRetry();
  setupEmptyCta();
}
