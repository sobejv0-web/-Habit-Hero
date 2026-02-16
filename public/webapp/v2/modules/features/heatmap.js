// =============================================================================
// heatmap.js — GitHub-style Contribution Heatmap Widget
//
// Renders a 7-row × N-column grid of small squares representing
// daily completion rates over the last 60 days.
//
// Color scale:  Gray (0%) → Dim green (1-39%) → Green (40-79%) → Neon (80-100%)
//
// Data source: /api/stats/heatmap?days=60  → { dates: { [YYYY-MM-DD]: pct } }
// Falls back to building from state.checkins for today only.
// =============================================================================

'use strict';

import { el, appendAll, todayKey } from '../utils.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const DAYS = 60;

const LEVEL_CLASSES = [
  'heatmap__cell--l0',  // 0 %
  'heatmap__cell--l1',  // 1-39 %
  'heatmap__cell--l2',  // 40-79 %
  'heatmap__cell--l3',  // 80-100 %
];

function pctToLevel(pct) {
  if (pct <= 0)  return 0;
  if (pct < 40)  return 1;
  if (pct < 80)  return 2;
  return 3;
}

// ─── Date helpers ────────────────────────────────────────────────────────────

function dateRange(days) {
  const result = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    result.push(d.toISOString().slice(0, 10));
  }
  return result;
}

function dayOfWeek(dateStr) {
  return new Date(dateStr + 'T12:00:00').getDay(); // 0=Sun
}

function monthLabel(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('uk', { month: 'short' });
}

// ─── Build DOM ───────────────────────────────────────────────────────────────

let _container = null;
let _built = false;

/**
 * Build / update the heatmap widget.
 *
 * @param {HTMLElement} container  - #heatmap-container
 * @param {Object} data           - { [YYYY-MM-DD]: percentNumber }
 * @param {number} [streak]       - current streak for the flame badge
 */
export function renderHeatmap(container, data, streak) {
  if (!container) return;
  _container = container;

  const dates = dateRange(DAYS);

  // ── Build grid only once, then patch ──
  if (!_built) {
    container.innerHTML = '';

    // Header
    const header = el('div', 'heatmap__header');
    const title  = el('div', 'heatmap__title', 'Активність');
    const flame  = el('div', 'heatmap__streak');
    flame.id = 'heatmap-streak';
    appendAll(header, title, flame);

    // Grid wrapper (scrollable horizontally on small screens)
    const grid = el('div', 'heatmap__grid');
    grid.id = 'heatmap-grid';

    // We arrange cells in columns (one per day), 7 rows per column.
    // But since we have 60 days, it's simpler to do a flat flex-wrap grid
    // with grid-template-rows: repeat(7, 1fr) and auto-flow: column.

    for (const dateStr of dates) {
      const pct   = data[dateStr] ?? 0;
      const level = pctToLevel(pct);
      const cell  = el('div', `heatmap__cell ${LEVEL_CLASSES[level]}`, null, {
        'data-date':  dateStr,
        'data-level': String(level),
        title:        `${dateStr}: ${Math.round(pct)}%`,
      });
      grid.appendChild(cell);
    }

    // Month labels row
    const months = el('div', 'heatmap__months');
    let lastMonth = '';
    for (const dateStr of dates) {
      const m = monthLabel(dateStr);
      if (m !== lastMonth) {
        const lbl = el('span', 'heatmap__month-label', m);
        months.appendChild(lbl);
        lastMonth = m;
      }
    }

    appendAll(container, header, months, grid);
    _built = true;
  } else {
    // Patch existing cells
    const cells = container.querySelectorAll('.heatmap__cell');
    let i = 0;
    for (const dateStr of dates) {
      const cell = cells[i++];
      if (!cell) break;
      const pct   = data[dateStr] ?? 0;
      const level = pctToLevel(pct);
      cell.className = `heatmap__cell ${LEVEL_CLASSES[level]}`;
      cell.dataset.date  = dateStr;
      cell.dataset.level = String(level);
      cell.title = `${dateStr}: ${Math.round(pct)}%`;
    }
  }

  // Streak badge
  const streakEl = document.getElementById('heatmap-streak');
  if (streakEl) {
    if (streak && streak > 0) {
      streakEl.textContent = `🔥 ${streak}`;
      streakEl.hidden = false;
    } else {
      streakEl.hidden = true;
    }
  }
}

/**
 * Force a full rebuild on next renderHeatmap call.
 */
export function resetHeatmap() {
  _built = false;
}
