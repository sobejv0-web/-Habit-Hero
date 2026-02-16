// =============================================================================
// confetti.js — Confetti effect when all habits are done
//
// Uses canvas-confetti (loaded via CDN in index.html).
// If CDN fails to load, degrades silently.
// =============================================================================

'use strict';

import { haptic } from '../utils.js';

let _fired = false;   // fire only once per day
let _date  = '';

/**
 * Fire confetti if all habits are done for today.
 * Safe to call on every render — will only fire once per calendar day.
 *
 * @param {number} done
 * @param {number} total
 * @param {string} todayStr — YYYY-MM-DD
 */
export function maybeConfetti(done, total, todayStr) {
  // Reset if new day
  if (todayStr !== _date) {
    _date  = todayStr;
    _fired = false;
  }

  if (_fired || done < total || total === 0) return;
  _fired = true;

  // canvas-confetti loaded?
  const confetti = window.confetti;
  if (typeof confetti !== 'function') return;

  haptic('success');

  // Two-burst effect
  confetti({
    particleCount: 80,
    spread: 70,
    origin: { y: 0.7 },
    colors: ['#36c98f', '#5b8cff', '#f0c040', '#f07178'],
    disableForReducedMotion: true,
  });

  setTimeout(() => {
    confetti({
      particleCount: 40,
      spread: 100,
      origin: { y: 0.65 },
      colors: ['#36c98f', '#5b8cff'],
      disableForReducedMotion: true,
    });
  }, 250);
}
