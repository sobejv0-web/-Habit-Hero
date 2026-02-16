// =============================================================================
// drag-drop.js — SortableJS-based Drag & Drop for Bento Grid
//
// Uses SortableJS for smooth 60fps touch-friendly reordering.
// Key features:
//   - 200ms delay to distinguish tap from drag (critical for UX)
//   - Haptic feedback on drag start/end
//   - iOS Home Screen-style visual feedback
//   - Hero card excluded from sorting
//
// Integration: call initDragDrop(grid, { onReorder }) after grid renders.
// =============================================================================

'use strict';

import { haptic } from '../utils.js';

// ─── State ───────────────────────────────────────────────────────────────────

let _sortable  = null;
let _grid      = null;
let _onReorder = null;  // (newOrder: Array<{id, sort_order}>) => void
let _enabled   = true;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Get all habit cards (excluding hero).
 */
function getHabitCards() {
  if (!_grid) return [];
  return [..._grid.querySelectorAll('.habit-card[data-habit-id]')];
}

/**
 * Calculate new order from current DOM positions.
 */
function calculateNewOrder() {
  const cards = getHabitCards();
  return cards.map((card, index) => ({
    id: Number(card.dataset.habitId),
    sort_order: index,
  }));
}

// ─── SortableJS Initialization ───────────────────────────────────────────────

/**
 * Initialise SortableJS on the bento grid.
 *
 * @param {HTMLElement} grid - #bento-grid element
 * @param {{ onReorder: Function }} opts
 */
export function initDragDrop(grid, opts) {
  _grid      = grid;
  _onReorder = opts.onReorder;

  // Check if SortableJS is loaded
  if (typeof Sortable === 'undefined') {
    console.warn('[DragDrop] SortableJS not loaded, DnD disabled');
    return;
  }

  // Destroy previous instance if exists
  if (_sortable) {
    _sortable.destroy();
  }

  _sortable = new Sortable(grid, {
    // ── Animation ──
    animation: 250,
    easing: 'cubic-bezier(0.25, 0.8, 0.25, 1)',

    // ── Touch delay (CRITICAL: prevents conflict with tap) ──
    delay: 200,
    delayOnTouchOnly: true,
    touchStartThreshold: 5,

    // ── Visual classes ──
    ghostClass: 'sortable-ghost',
    dragClass: 'sortable-drag',
    chosenClass: 'sortable-chosen',

    // ── Filtering ──
    // Hero card should NOT be draggable
    filter: '.hero-card',
    preventOnFilter: false,   // Allow clicks on hero card

    // Only habit cards are draggable
    draggable: '.habit-card',

    // ── Scroll behavior ──
    scroll: true,
    scrollSensitivity: 80,
    scrollSpeed: 10,
    bubbleScroll: true,

    // ── Events ──
    onStart: function(evt) {
      // Haptic feedback on drag start
      haptic('medium');

      // Add class to grid for CSS styling
      grid.classList.add('is-sorting');
    },

    onMove: function(evt, originalEvent) {
      // Prevent dropping before hero card
      if (evt.related && evt.related.classList.contains('hero-card')) {
        return false;  // Cancel this move
      }
      return true;
    },

    onEnd: function(evt) {
      // Remove sorting class
      grid.classList.remove('is-sorting');

      // Haptic feedback on drop
      haptic('selection');

      // Only emit if position actually changed
      if (evt.oldIndex !== evt.newIndex) {
        const newOrder = calculateNewOrder();

        // Callback to app.js
        if (_onReorder) {
          _onReorder(newOrder);
        }
      }
    },

    onChange: function(evt) {
      // Light haptic on each position change
      haptic('light');
    },
  });

  _enabled = true;
}

/**
 * Call after renderer reconciles grid to ensure SortableJS picks up new cards.
 * SortableJS handles this automatically, but we can force a refresh if needed.
 */
export function refreshDraggable() {
  // SortableJS automatically detects new children
  // No action needed, but keep API for compatibility
  if (!_enabled || !_sortable) return;
}

/**
 * Temporarily disable DnD (e.g. during focus mode).
 */
export function disableDragDrop() {
  if (_sortable) {
    _sortable.option('disabled', true);
  }
  _enabled = false;
  if (_grid) {
    _grid.classList.remove('is-sorting');
  }
}

/**
 * Re-enable DnD.
 */
export function enableDragDrop() {
  if (_sortable) {
    _sortable.option('disabled', false);
  }
  _enabled = true;
}

/**
 * Destroy SortableJS instance (cleanup).
 */
export function destroyDragDrop() {
  if (_sortable) {
    _sortable.destroy();
    _sortable = null;
  }
  _grid = null;
  _onReorder = null;
  _enabled = false;
}
