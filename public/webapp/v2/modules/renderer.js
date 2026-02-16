// =============================================================================
// renderer.js — DOM Renderer for Habit System v2
//
// Pure render(state, prevState) function.
// Builds / patches the bento-grid and stats-strip from state.
// Uses DocumentFragment for bulk inserts to avoid layout thrashing.
//
// Rendering strategy:
//   • hero card  — always the first child of #bento-grid
//   • habit cards — keyed by habit.id; reconciled (add / remove / update)
//   • routine cards — keyed by routine.id; rendered after habits
//   • stats strip — updated in-place (no DOM churn)
//   • 5-min overlay — toggled on the active card
//
// All CSS classes emitted here MUST match bento-grid.css / cards.css.
// =============================================================================

'use strict';

import { Selectors } from './store.js';
import {
  el,
  appendAll,
  statusClass,
  pickEmoji,
  formatTimer,
  formatDays,
  formatSteps,
  todayKey,
  STATUS_COPY,
} from './utils.js';
import { renderHeatmap }    from './features/heatmap.js';
import { maybeConfetti }    from './features/confetti.js';
import { refreshDraggable } from './features/drag-drop.js';
import { renderSettings }   from './settings.js';

// ─── DOM references (cached once) ───────────────────────────────────────────

let $grid        = null;  // #bento-grid
let $statsVal    = null;  // #stats-progress
let $statsMeta   = null;  // #stats-meta
let $statsBar    = null;  // #stats-strip-bar
let $statsStrip  = null;  // .stats-strip wrapper
let $trial       = null;  // #dashboard-trial

let $skeleton    = null;  // #dashboard-skeleton
let $content     = null;  // #dashboard-content
let $empty       = null;  // #dashboard-empty
let $error       = null;  // #dashboard-error

let $habitsList  = null;  // #habits-list (Habits tab)
let $heatmap     = null;  // #heatmap-container

/** Map<habitId|routineId, HTMLElement> — live card lookup */
const cardMap = new Map();

/** Reference to the hero card element */
let $hero = null;

/** Last rendered completion % (for haptic on 100 %) */
let _lastPercent = -1;

// ─── Initialise DOM refs ─────────────────────────────────────────────────────

/**
 * Call once after DOMContentLoaded.  Caches all static container refs.
 */
export function initRenderer() {
  $grid       = document.getElementById('bento-grid');
  $statsVal   = document.getElementById('stats-progress');
  $statsMeta  = document.getElementById('stats-meta');
  $statsBar   = document.getElementById('stats-strip-bar');
  $statsStrip = document.querySelector('.stats-strip');
  $trial      = document.getElementById('dashboard-trial');

  $skeleton   = document.getElementById('dashboard-skeleton');
  $content    = document.getElementById('dashboard-content');
  $empty      = document.getElementById('dashboard-empty');
  $error      = document.getElementById('dashboard-error');

  $habitsList = document.getElementById('habits-list');
  $heatmap    = document.getElementById('heatmap-container');
}

// ─── Visibility helpers ──────────────────────────────────────────────────────

function showOnly(target) {
  const map = { skeleton: $skeleton, content: $content, empty: $empty, error: $error };
  for (const [key, node] of Object.entries(map)) {
    if (node) node.hidden = key !== target;
  }
}

// =============================================================================
// HERO CARD — always first child of #bento-grid
// =============================================================================

function buildHeroCard(habit, checkin, progress) {
  const status = checkin?.status || 'none';
  const stCls  = statusClass(status);
  const emoji  = pickEmoji(habit.title);

  const card = el('div', `bento-card hero-card ${stCls}`, null, {
    'data-habit-id': habit.id,
    'data-kind':     'habit',
    role:            'button',
    tabindex:        '0',
    'aria-label':    `${habit.title}. ${STATUS_COPY[status] || STATUS_COPY.none}`,
  });

  if (status === 'none') card.classList.add('is-active');

  const kicker = el('div', 'hero-kicker', 'Фокус дня');
  const title  = el('div', 'hero-title', habit.title);
  const emojiE = el('div', 'hero-emoji', emoji);
  const sub    = el('div', 'hero-sub', STATUS_COPY[status] || STATUS_COPY.none);

  const meta     = el('div', 'hero-meta');
  const progText = el('div', 'hero-progress', `${progress.done}/${progress.total}`);
  const cta      = el('div', 'hero-cta', status === 'none' ? 'Тапни щоб відмітити' : '');
  appendAll(meta, progText, cta);

  appendAll(card, kicker, title, emojiE, sub, meta);

  // Stash refs for patching
  card.__refs = { title, sub, cta, kicker, progText, emojiE };

  return card;
}

function patchHeroCard(card, habit, checkin, progress) {
  const refs = card.__refs;
  if (!refs) return;

  const status  = checkin?.status || 'none';
  const stCls   = statusClass(status);

  // Update text
  refs.title.textContent    = habit.title;
  refs.sub.textContent      = STATUS_COPY[status] || STATUS_COPY.none;
  refs.progText.textContent = `${progress.done}/${progress.total}`;
  refs.cta.textContent      = status === 'none' ? 'Тапни щоб відмітити' : '';
  refs.emojiE.textContent   = pickEmoji(habit.title);

  // Update data attrs
  card.dataset.habitId = habit.id;

  // Swap state classes
  card.classList.remove('is-idle', 'is-done', 'is-skip', 'is-active');
  card.classList.add(stCls);
  if (status === 'none') card.classList.add('is-active');

  card.setAttribute('aria-label',
    `${habit.title}. ${STATUS_COPY[status] || STATUS_COPY.none}`);
}

// =============================================================================
// HERO ROUTINE CARD
// =============================================================================

function buildHeroRoutineCard(routine, checkins) {
  const total = (routine.habitIds || []).length;
  const done  = (routine.habitIds || []).filter(id => checkins[id]?.status === 'done').length;

  const card = el('div', 'bento-card hero-card is-idle', null, {
    'data-routine-id': routine.id,
    'data-kind':       'routine',
    role:              'button',
    tabindex:          '0',
    'aria-label':      `${routine.title}. ${total > 0 ? 'Почати рутину' : 'Додати кроки'}.`,
  });

  const kicker   = el('div', 'hero-kicker', 'Рутина');
  const title    = el('div', 'hero-title', routine.title);
  const sub      = el('div', 'hero-sub', total > 0 ? formatSteps(total) : 'Додай кроки у Habits');
  const meta     = el('div', 'hero-meta');
  const progText = el('div', 'hero-progress', total > 0 ? `${done}/${total}` : '');
  const cta      = el('div', 'hero-cta', total > 0 ? 'Почати' : 'Додати кроки');
  const hint     = el('div', 'hero-hint');
  hint.hidden = true;
  appendAll(meta, progText, cta);
  appendAll(card, kicker, title, sub, meta, hint);

  card.__refs = { title, sub, cta, progText, hint };
  return card;
}

function patchHeroRoutineCard(card, routine, checkins) {
  const refs = card.__refs;
  if (!refs) return;

  const total = (routine.habitIds || []).length;
  const done  = (routine.habitIds || []).filter(id => checkins[id]?.status === 'done').length;

  refs.title.textContent    = routine.title;
  refs.sub.textContent      = total > 0 ? formatSteps(total) : 'Додай кроки у Habits';
  refs.progText.textContent = total > 0 ? `${done}/${total}` : '';
  refs.cta.textContent      = total > 0 ? 'Почати' : 'Додати кроки';

  card.dataset.routineId = routine.id;
  card.setAttribute('aria-label',
    `${routine.title}. ${total > 0 ? 'Почати рутину' : 'Додати кроки'}.`);
}

// =============================================================================
// HABIT CARD — square 1:1 aspect in the bento grid
// =============================================================================

/**
 * Build a new habit card DOM node.
 * Handles 3 habit types: boolean (default), counter, timer.
 */
function buildHabitCard(habit, checkin, state) {
  const status = checkin?.status || 'none';
  const stCls  = statusClass(status);
  const type   = habit.type || 'boolean';
  const emoji  = pickEmoji(habit.title);

  const card = el('div', `bento-card habit-card ${stCls}`, null, {
    'data-habit-id': habit.id,
    'data-kind':     'habit',
    'data-type':     type,
    role:            'button',
    tabindex:        '0',
    'aria-label':    `${habit.title}. ${STATUS_COPY[status] || STATUS_COPY.none}`,
  });

  // In-flight shimmer
  if (state.optimistic.inFlight[habit.id]) {
    card.classList.add('is-loading');
  }

  // Emoji
  const emojiE = el('div', 'habit-card__emoji', emoji);

  // Body: title + meta + type-specific UI
  const body  = el('div', 'habit-card__body');
  const title = el('div', 'habit-card__title', habit.title);
  const meta  = el('div', 'habit-card__meta', STATUS_COPY[status] || STATUS_COPY.none);

  appendAll(body, title, meta);

  // ── Counter-specific ───────────────────────────────────
  let counterEl = null;
  let counterValEl = null;
  let counterTargetEl = null;
  let ringEl = null;

  if (type === 'counter') {
    const value  = checkin?.counterValue || 0;
    const target = habit.counterTarget || 0;

    counterEl = el('div', 'habit-card__counter');
    counterValEl    = el('span', 'habit-card__counter-value', String(value));
    counterTargetEl = el('span', 'habit-card__counter-target',
      target ? ` / ${target}` : '');
    appendAll(counterEl, counterValEl, counterTargetEl);
    body.appendChild(counterEl);

    // SVG ring progress
    if (target > 0) {
      ringEl = buildRingSvg(value, target);
      card.appendChild(ringEl);
    }

    // Override meta
    meta.textContent = target
      ? `${Math.round((value / target) * 100)}%`
      : String(value);
  }

  // ── Timer-specific ─────────────────────────────────────
  let timerEl = null;
  let timerValEl = null;
  let timerBtnEl = null;

  if (type === 'timer') {
    const elapsed  = checkin?.timerElapsed || 0;
    const running  = !!checkin?.timerRunning;
    const duration = habit.timerDuration || 0;

    timerEl    = el('div', 'habit-card__timer');
    timerValEl = el('span', 'habit-card__timer-value',
      duration > 0
        ? formatTimer(Math.max(0, duration - elapsed))
        : formatTimer(elapsed));
    timerBtnEl = el('button', 'habit-card__timer-btn',
      running ? '⏸' : '▶', { type: 'button', 'data-action': 'timer-toggle' });

    appendAll(timerEl, timerValEl, timerBtnEl);
    body.appendChild(timerEl);

    if (running) {
      card.classList.add('is-timer-running');
    }

    // Override meta for timer
    meta.textContent = running ? 'Працює…' : (
      status === 'done' ? STATUS_COPY.done : (
        duration > 0 ? formatTimer(duration) : STATUS_COPY.none
      )
    );
  }

  appendAll(card, emojiE, body);

  // ── 5-min overlay (if active for this habit) ───────────
  const fiveMin = state.ui.fiveMin;
  if (fiveMin.running && fiveMin.habitId === habit.id) {
    const overlay = buildFiveMinOverlay(fiveMin.remaining);
    card.appendChild(overlay);
  }

  // Stash refs for patching
  card.__refs = {
    title, meta, emojiE,
    counterValEl, counterTargetEl, ringEl,
    timerValEl, timerBtnEl,
  };

  cardMap.set(habit.id, card);
  return card;
}

/**
 * Patch an existing habit card in-place (no DOM rebuild).
 */
function patchHabitCard(card, habit, checkin, state) {
  const refs = card.__refs;
  if (!refs) return;

  const status = checkin?.status || 'none';
  const stCls  = statusClass(status);
  const type   = habit.type || 'boolean';
  const inFlight = !!state.optimistic.inFlight[habit.id];

  // State classes
  card.classList.remove('is-idle', 'is-done', 'is-skip', 'is-loading', 'is-timer-running');
  card.classList.add(stCls);
  if (inFlight) card.classList.add('is-loading');

  // Core text
  refs.title.textContent = habit.title;
  refs.emojiE.textContent = pickEmoji(habit.title);

  // ARIA
  card.setAttribute('aria-label',
    `${habit.title}. ${STATUS_COPY[status] || STATUS_COPY.none}`);

  // ── Boolean meta ──
  if (type === 'boolean' || !type) {
    refs.meta.textContent = STATUS_COPY[status] || STATUS_COPY.none;
  }

  // ── Counter ──
  if (type === 'counter') {
    const value  = checkin?.counterValue || 0;
    const target = habit.counterTarget || 0;
    if (refs.counterValEl) {
      refs.counterValEl.textContent = String(value);
    }
    if (refs.counterTargetEl) {
      refs.counterTargetEl.textContent = target ? ` / ${target}` : '';
    }
    if (refs.ringEl && target > 0) {
      patchRingSvg(refs.ringEl, value, target);
    }
    refs.meta.textContent = target
      ? `${Math.round((value / target) * 100)}%`
      : String(value);
  }

  // ── Timer ──
  if (type === 'timer') {
    const elapsed  = checkin?.timerElapsed || 0;
    const running  = !!checkin?.timerRunning;
    const duration = habit.timerDuration || 0;

    if (refs.timerValEl) {
      refs.timerValEl.textContent = duration > 0
        ? formatTimer(Math.max(0, duration - elapsed))
        : formatTimer(elapsed);
    }
    if (refs.timerBtnEl) {
      refs.timerBtnEl.textContent = running ? '⏸' : '▶';
    }
    if (running) {
      card.classList.add('is-timer-running');
    }
    refs.meta.textContent = running ? 'Працює…' : (
      status === 'done' ? STATUS_COPY.done : (
        duration > 0 ? formatTimer(duration) : STATUS_COPY.none
      )
    );
  }

  // ── 5-min overlay ──
  manageFiveMinOverlay(card, habit.id, state);
}

// =============================================================================
// SVG Ring (counter cards)
// =============================================================================

const RING_R      = 13;
const RING_CIRCUM = 2 * Math.PI * RING_R;

function buildRingSvg(value, target) {
  const pct    = Math.min(1, value / target);
  const offset = RING_CIRCUM * (1 - pct);

  const ns  = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'habit-card__ring');
  svg.setAttribute('viewBox', '0 0 32 32');

  const bg = document.createElementNS(ns, 'circle');
  bg.setAttribute('class', 'ring-bg');
  bg.setAttribute('cx', '16');
  bg.setAttribute('cy', '16');
  bg.setAttribute('r', String(RING_R));

  const fill = document.createElementNS(ns, 'circle');
  fill.setAttribute('class', 'ring-fill');
  fill.setAttribute('cx', '16');
  fill.setAttribute('cy', '16');
  fill.setAttribute('r', String(RING_R));
  fill.setAttribute('stroke-dasharray', String(RING_CIRCUM));
  fill.setAttribute('stroke-dashoffset', String(offset));
  fill.setAttribute('transform', 'rotate(-90 16 16)');

  svg.appendChild(bg);
  svg.appendChild(fill);
  return svg;
}

function patchRingSvg(svg, value, target) {
  const fill = svg.querySelector('.ring-fill');
  if (!fill) return;
  const pct = Math.min(1, value / target);
  fill.setAttribute('stroke-dashoffset', String(RING_CIRCUM * (1 - pct)));
}

// =============================================================================
// 5-Minute overlay inside habit card
// =============================================================================

function buildFiveMinOverlay(remaining) {
  const wrap  = el('div', 'habit-card__five-min');
  const value = el('div', 'habit-card__five-min-value', formatTimer(remaining));
  const label = el('div', 'habit-card__five-min-label', 'спробуй 5 хв');
  appendAll(wrap, value, label);
  return wrap;
}

function manageFiveMinOverlay(card, habitId, state) {
  const fm = state.ui.fiveMin;
  const existing = card.querySelector('.habit-card__five-min');

  if (fm.running && fm.habitId === habitId) {
    if (existing) {
      // Patch value
      const valEl = existing.querySelector('.habit-card__five-min-value');
      if (valEl) valEl.textContent = formatTimer(fm.remaining);
    } else {
      card.appendChild(buildFiveMinOverlay(fm.remaining));
    }
  } else if (existing) {
    existing.remove();
  }
}

// =============================================================================
// HABITS TAB — list items
// =============================================================================

function buildHabitListItem(habit, checkin) {
  const status = checkin?.status || 'none';
  const emoji  = pickEmoji(habit.title);
  const type   = habit.type || 'boolean';

  const item = el('div', 'list-item', null, {
    'data-habit-id': habit.id,
    'data-kind':     'habit-list',
    role:            'button',
    tabindex:        '0',
  });

  const main  = el('div', 'list-item__main');
  const title = el('div', 'list-item__title', `${emoji} ${habit.title}`);
  const sub   = el('div', 'list-item__subtitle');

  // Subtitle with type info
  if (type === 'counter' && habit.counterTarget) {
    sub.textContent = `Лічильник · ціль ${habit.counterTarget}`;
  } else if (type === 'timer' && habit.timerDuration) {
    sub.textContent = `Таймер · ${formatTimer(habit.timerDuration)}`;
  } else {
    sub.textContent = STATUS_COPY[status] || STATUS_COPY.none;
  }

  appendAll(main, title, sub);

  // Right side — status chip
  const right = el('div', 'list-item__right');
  const chip  = el('span', `chip ${status === 'done' ? 'chip--done' : status === 'skip' ? 'chip--skip' : ''}`,
    status === 'done' ? '✓' : status === 'skip' ? '—' : '·');
  right.appendChild(chip);

  appendAll(item, main, right);

  item.__refs = { title, sub, chip };
  return item;
}

function patchHabitListItem(item, habit, checkin) {
  const refs = item.__refs;
  if (!refs) return;

  const status = checkin?.status || 'none';
  const emoji  = pickEmoji(habit.title);
  const type   = habit.type || 'boolean';

  refs.title.textContent = `${emoji} ${habit.title}`;

  if (type === 'counter' && habit.counterTarget) {
    refs.sub.textContent = `Лічильник · ціль ${habit.counterTarget}`;
  } else if (type === 'timer' && habit.timerDuration) {
    refs.sub.textContent = `Таймер · ${formatTimer(habit.timerDuration)}`;
  } else {
    refs.sub.textContent = STATUS_COPY[status] || STATUS_COPY.none;
  }

  refs.chip.className = `chip ${status === 'done' ? 'chip--done' : status === 'skip' ? 'chip--skip' : ''}`;
  refs.chip.textContent = status === 'done' ? '✓' : status === 'skip' ? '—' : '·';
}

// =============================================================================
// STATS STRIP
// =============================================================================

function patchStatsStrip(state) {
  const progress = Selectors.todayProgress(state);
  const { total, done, skip, percent } = progress;

  if ($statsVal)  $statsVal.textContent = `${done}/${total}`;

  if ($statsMeta) {
    const streak = Number(state.me?.streak ?? state.me?.user?.streak);
    const parts = [];
    if (Number.isFinite(streak) && streak > 0) {
      parts.push(`Серія ${streak} ${formatDays(streak)}`);
    }
    if (skip > 0) parts.push(`Пропущено ${skip}`);
    $statsMeta.textContent = parts.join(' · ');
  }

  if ($statsBar) {
    $statsBar.style.setProperty('--progress', `${percent}%`);
  }

  if ($statsStrip) {
    $statsStrip.classList.toggle('is-complete', percent === 100 && total > 0);
  }

  // Haptic on reaching 100 %
  if (percent === 100 && _lastPercent !== 100 && total > 0) {
    try { window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('success'); } catch {}
    maybeConfetti(done, total, todayKey());
  }
  _lastPercent = percent;
}

// =============================================================================
// TRIAL LINE
// =============================================================================

function patchTrialLine(state) {
  if (!$trial) return;
  const t = state.trial;
  if (t?.active && t.daysLeft > 0) {
    $trial.hidden = false;
    $trial.textContent =
      `Premium активний · ще ${t.daysLeft} ${formatDays(t.daysLeft)} доступу`;
  } else {
    $trial.hidden = true;
  }
}

// =============================================================================
// RECONCILE BENTO GRID
// =============================================================================

/**
 * Full reconciliation of #bento-grid from state.
 * Tries to patch existing DOM nodes; rebuilds only what changed.
 */
function reconcileGrid(state) {
  if (!$grid) return;

  const habits   = Selectors.habits(state);
  const checkins = state.checkins;
  const progress = Selectors.todayProgress(state);

  // Nothing to show?
  if (habits.length === 0 && (state.routines || []).length === 0) {
    showOnly('empty');
    $grid.innerHTML = '';
    cardMap.clear();
    $hero = null;
    return;
  }

  showOnly('content');

  // ── Hero ──
  const heroHabit = Selectors.heroHabit(state);
  const firstRoutine = (state.routines || [])[0] || null;

  // Decide hero content: routine takes priority if it exists AND has steps
  const useRoutineHero = firstRoutine && (firstRoutine.habitIds || []).length > 0;

  if (useRoutineHero) {
    if ($hero && $hero.dataset.kind === 'routine' && $hero.dataset.routineId === String(firstRoutine.id)) {
      patchHeroRoutineCard($hero, firstRoutine, checkins);
    } else {
      // Rebuild hero
      if ($hero) $hero.remove();
      $hero = buildHeroRoutineCard(firstRoutine, checkins);
      $grid.prepend($hero);
    }
  } else if (heroHabit) {
    const heroCheckin = checkins[heroHabit.id] || null;
    if ($hero && $hero.dataset.kind === 'habit' && $hero.dataset.habitId === String(heroHabit.id)) {
      patchHeroCard($hero, heroHabit, heroCheckin, progress);
    } else {
      if ($hero) $hero.remove();
      $hero = buildHeroCard(heroHabit, heroCheckin, progress);
      $grid.prepend($hero);
    }
  }

  // ── Habit cards (keyed reconciliation) ──
  const desiredIds = new Set(habits.map(h => String(h.id)));
  const fragment   = document.createDocumentFragment();
  const toAppend   = [];

  for (const habit of habits) {
    const id   = String(habit.id);
    const ci   = checkins[habit.id] || null;
    const existing = cardMap.get(habit.id);

    if (existing && $grid.contains(existing)) {
      patchHabitCard(existing, habit, ci, state);
    } else {
      const card = buildHabitCard(habit, ci, state);
      toAppend.push(card);
    }
  }

  // Remove cards no longer in habits
  for (const [id, card] of cardMap) {
    if (!desiredIds.has(String(id)) && card !== $hero) {
      card.remove();
      cardMap.delete(id);
    }
  }

  // Append new cards via fragment (single reflow)
  if (toAppend.length > 0) {
    for (const c of toAppend) fragment.appendChild(c);
    $grid.appendChild(fragment);
  }

  // ── Routine cards (non-hero) ──
  const routines = (state.routines || []).slice(useRoutineHero ? 1 : 0);
  for (const routine of routines) {
    const key = `routine_${routine.id}`;
    const existing = cardMap.get(key);
    if (existing && $grid.contains(existing)) {
      patchHeroRoutineCard(existing, routine, checkins);
    } else {
      const rCard = buildHeroRoutineCard(routine, checkins);
      rCard.classList.remove('hero-card');        // non-hero routines are normal width
      rCard.classList.add('habit-card');
      rCard.style.aspectRatio = 'auto';           // no square constraint
      cardMap.set(key, rCard);
      $grid.appendChild(rCard);
    }
  }
}

// =============================================================================
// RECONCILE HABITS LIST (Habits tab)
// =============================================================================

/** Map<habitId, HTMLElement> for list items */
const listMap = new Map();

function reconcileHabitsList(state) {
  if (!$habitsList) return;

  // Always hide skeleton once we have data
  const skeletonEl = document.getElementById('habits-skeleton');
  if (skeletonEl) skeletonEl.hidden = true;

  const habits   = Selectors.habits(state);
  const checkins = state.checkins;

  if (habits.length === 0) {
    $habitsList.innerHTML = '';
    listMap.clear();
    // Show empty state — but keep content visible so "add habit" form is accessible
    const emptyEl = document.getElementById('habits-empty');
    const contentEl = document.getElementById('habits-content');
    if (emptyEl) emptyEl.hidden = false;
    if (contentEl) contentEl.hidden = false;
    return;
  }

  // Show content
  const emptyEl = document.getElementById('habits-empty');
  const contentEl = document.getElementById('habits-content');
  if (emptyEl) emptyEl.hidden = true;
  if (contentEl) contentEl.hidden = false;

  const desiredIds = new Set(habits.map(h => String(h.id)));
  const fragment   = document.createDocumentFragment();
  const toAppend   = [];

  for (const habit of habits) {
    const ci = checkins[habit.id] || null;
    const existing = listMap.get(habit.id);

    if (existing && $habitsList.contains(existing)) {
      patchHabitListItem(existing, habit, ci);
    } else {
      const item = buildHabitListItem(habit, ci);
      listMap.set(habit.id, item);
      toAppend.push(item);
    }
  }

  // Remove stale items
  for (const [id, item] of listMap) {
    if (!desiredIds.has(String(id))) {
      item.remove();
      listMap.delete(id);
    }
  }

  // Append new
  if (toAppend.length > 0) {
    for (const it of toAppend) fragment.appendChild(it);
    $habitsList.appendChild(fragment);
  }
}

// =============================================================================
// MAIN RENDER — called by store.subscribe(render)
// =============================================================================

/**
 * Primary render function.  Subscribes to store; receives (state, prevState).
 * Checks which slices changed and patches only the affected DOM.
 *
 * @param {Object} state
 * @param {Object} prevState
 * @param {Array}  actions — batch of actions that triggered this render
 */
export function render(state, prevState, actions) {
  if (!$grid) initRenderer();   // safety: auto-init if forgot to call init

  // ── Loading / Error states ──
  if (state.loading.me) {
    showOnly('skeleton');
    return;
  }

  if (state.error && !state.me) {
    showOnly('error');
    return;
  }

  // ── Dashboard tab ──
  const tabChanged   = state.ui.activeTab !== prevState?.ui?.activeTab;
  const justLoaded   = prevState?.loading?.me && !state.loading.me;
  const onDashboard  = state.ui.activeTab === 'dashboard';
  const habitsChanged =
    state.habits   !== prevState?.habits   ||
    state.checkins !== prevState?.checkins ||
    state.routines !== prevState?.routines ||
    state.optimistic !== prevState?.optimistic ||
    state.ui.fiveMin !== prevState?.ui?.fiveMin;

  // When data first loads — hide ALL skeletons globally
  if (justLoaded) {
    for (const id of ['habits-skeleton', 'stats-skeleton', 'settings-skeleton']) {
      const el = document.getElementById(id);
      if (el) el.hidden = true;
    }
    // Ensure habits-content is visible (form needs to be accessible)
    const hc = document.getElementById('habits-content');
    if (hc) hc.hidden = false;
    // Stats content
    const sc = document.getElementById('stats-content');
    if (sc) sc.hidden = false;
  }

  if (onDashboard && (habitsChanged || tabChanged || justLoaded || !prevState)) {
    reconcileGrid(state);
    patchStatsStrip(state);
    patchTrialLine(state);
    refreshDraggable();

    // Heatmap — use cached data from state.stats.heatmap
    if ($heatmap && state.stats?.heatmap) {
      const streak = Number(state.me?.streak ?? state.me?.user?.streak ?? 0);
      renderHeatmap($heatmap, state.stats.heatmap, streak);
      const wrapper = document.getElementById('heatmap-wrapper');
      if (wrapper) wrapper.hidden = false;
    }
  }

  // ── Habits tab ──
  const onHabits = state.ui.activeTab === 'habits';
  if (onHabits && (habitsChanged || tabChanged || justLoaded || !prevState)) {
    reconcileHabitsList(state);
  }

  // ── Stats tab ──
  const onStats = state.ui.activeTab === 'stats';
  if (onStats && tabChanged) {
    // Hide skeleton, show content
    const statsSkeleton = document.getElementById('stats-skeleton');
    const statsContent  = document.getElementById('stats-content');
    if (statsSkeleton) statsSkeleton.hidden = true;
    if (statsContent)  statsContent.hidden  = false;
  }

  // ── Settings tab ──
  const onSettings = state.ui.activeTab === 'settings';
  if (onSettings && tabChanged) {
    renderSettings();
  }

  // ── Focus mode overlay ──
  if (state.focus !== prevState?.focus) {
    renderFocusOverlay(state);
  }
}

// =============================================================================
// FOCUS MODE OVERLAY
// =============================================================================

function renderFocusOverlay(state) {
  const overlay = document.getElementById('focus-overlay');
  if (!overlay) return;

  if (!state.focus.active) {
    overlay.hidden = true;
    document.body.classList.remove('is-focus-mode');
    return;
  }

  overlay.hidden = false;
  document.body.classList.add('is-focus-mode');

  const routine = (state.routines || []).find(r => r.id === state.focus.routineId);
  if (!routine) return;

  const habitIds = routine.habitIds || [];
  const idx      = state.focus.stepIndex;
  const total    = habitIds.length;
  const habitId  = habitIds[idx];
  const habit    = state.habits.find(h => h.id === habitId);

  // Step text
  const stepEl = document.getElementById('focus-step');
  if (stepEl) stepEl.textContent = `Крок ${idx + 1} з ${total}`;

  const routineTitleEl = document.getElementById('focus-routine');
  if (routineTitleEl) routineTitleEl.textContent = routine.title;

  // Progress bar
  const progBar = document.getElementById('focus-progress-bar');
  if (progBar) {
    progBar.style.width = total > 0
      ? `${Math.round(((idx) / total) * 100)}%`
      : '0%';
  }

  // Habit info
  const titleEl = document.getElementById('focus-title');
  const subEl   = document.getElementById('focus-sub');
  if (titleEl) titleEl.textContent = habit ? `${pickEmoji(habit.title)} ${habit.title}` : '…';
  if (subEl)   subEl.textContent   = habit ? (STATUS_COPY[state.checkins[habitId]?.status] || STATUS_COPY.none) : '';

  // Timer section (show if habit is timer type)
  const timerSection = document.getElementById('focus-timer');
  if (timerSection && habit) {
    const isTimer = habit.type === 'timer';
    timerSection.hidden = !isTimer;
    if (isTimer) {
      const ci  = state.checkins[habitId] || {};
      const dur = habit.timerDuration || 0;
      const el  = ci.timerElapsed || 0;
      const timerVal = document.getElementById('focus-timer-value');
      if (timerVal) timerVal.textContent = dur > 0
        ? formatTimer(Math.max(0, dur - el))
        : formatTimer(el);
    }
  }
}

// =============================================================================
// TOAST SYSTEM
// =============================================================================

let _toastTimer = null;

/**
 * Show a toast notification.
 * @param {{ type?: string, message: string, actionLabel?: string, duration?: number, onAction?: Function }} opts
 */
export function showToast(opts) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  // Remove existing
  container.innerHTML = '';
  if (_toastTimer) clearTimeout(_toastTimer);

  const toast = el('div', `toast toast--${opts.type || 'success'}`);
  toast.textContent = opts.message;

  if (opts.actionLabel && opts.onAction) {
    const action = el('button', 'toast__action', opts.actionLabel, { type: 'button' });
    action.addEventListener('click', () => {
      hideToast();
      opts.onAction();
    });
    toast.appendChild(action);
  }

  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));

  const dur = opts.duration || (opts.type === 'error' ? 4200 : 1600);
  _toastTimer = setTimeout(hideToast, dur);
}

export function hideToast() {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = container.querySelector('.toast');
  if (toast) {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 200);
  }
  if (_toastTimer) {
    clearTimeout(_toastTimer);
    _toastTimer = null;
  }
}

// =============================================================================
// CONTEXT SHEET
// =============================================================================

/**
 * Open / close the context sheet based on state.
 */
export function syncContextSheet(state) {
  const backdrop = document.getElementById('sheet-backdrop');
  const sheet    = document.getElementById('context-sheet');
  const title    = document.getElementById('context-sheet-title');
  if (!backdrop || !sheet) return;

  if (state.ui.activeModal === 'context-menu' && state.ui.contextMenuHabitId) {
    const habit = state.habits.find(h => h.id === state.ui.contextMenuHabitId);
    if (title) title.textContent = habit?.title || '…';
    backdrop.hidden = false;
    sheet.hidden    = false;
    requestAnimationFrame(() => sheet.classList.add('is-open'));
  } else {
    sheet.classList.remove('is-open');
    backdrop.hidden = true;
    setTimeout(() => { sheet.hidden = true; }, 200);
  }
}

// =============================================================================
// 5-MIN MODAL (center modal, not the in-card overlay)
// =============================================================================

export function syncFiveMinModal(state) {
  const backdrop = document.getElementById('five-min-backdrop');
  const modal    = document.getElementById('five-min-modal');
  if (!backdrop || !modal) return;

  if (state.ui.activeModal === 'five-min-rule') {
    backdrop.hidden = false;
    modal.hidden    = false;
    requestAnimationFrame(() => modal.classList.add('is-open'));
  } else {
    modal.classList.remove('is-open');
    backdrop.hidden = true;
    setTimeout(() => { modal.hidden = true; }, 200);
  }
}
