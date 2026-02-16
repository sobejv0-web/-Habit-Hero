// =============================================================================
// settings.js — Settings Controller for Habit System v2
//
// Renders and wires the Settings tab:
//   • Vacation Mode (pause streaks)
//   • Supervisor toggle (social shame)
//   • Dark Mode force-override
//   • Delete All Data (danger zone)
// =============================================================================

'use strict';

import { el, appendAll, haptic } from './utils.js';
import {
  isSupervisorEnabled, setSupervisorEnabled,
  isVacationMode, setVacationMode,
  getDeadline, setDeadline,
  forceCheck,
} from './features/social-shame.js';
import { saveSettings, apiFetch } from './api.js';
import { showToast } from './renderer.js';

// ─── State ───────────────────────────────────────────────────────────────────

let _store = null;
let _built = false;

// Dark mode override: 'auto' | 'dark' | 'light'
const LS_THEME = 'habit_theme_override';

function getThemeOverride() {
  return localStorage.getItem(LS_THEME) || 'auto';
}

function setThemeOverride(value) {
  localStorage.setItem(LS_THEME, value);
  applyThemeOverride(value);
}

function applyThemeOverride(value) {
  document.documentElement.classList.remove('theme-dark', 'theme-light');
  if (value === 'dark') {
    document.documentElement.classList.add('theme-dark');
  } else if (value === 'light') {
    document.documentElement.classList.add('theme-light');
  }
  // 'auto' — no class, falls through to Telegram's theme vars
}

// ─── Build UI ────────────────────────────────────────────────────────────────

function buildSettingsUI(container) {
  container.innerHTML = '';

  // ── Profile info ──
  const state = _store.getState();
  const me    = state.me;
  const name  = me?.user?.first_name || me?.first_name || 'Користувач';
  const plan  = state.features.isPremium ? 'Premium' : 'Free';

  const profileCard = el('div', 'settings-card card card--md');
  const profileTitle = el('div', 'settings-card__title', `👤 ${name}`);
  const profileSub   = el('div', 'settings-card__subtitle', `План: ${plan}`);
  appendAll(profileCard, profileTitle, profileSub);

  // ── Supervisor section ──
  const supervisorCard = el('div', 'settings-card card card--md');
  const supervisorLabel = el('div', 'field-label', '👮 Наглядач (Social Shame)');
  const supervisorDesc  = el('div', 'hint', 'Попередження коли звички не виконані до дедлайну');

  const supervisorRow = el('div', 'settings-field');
  const supervisorText = el('div', 'settings-field__text', 'Увімкнути наглядача');
  const supervisorToggle = buildToggle('supervisor-toggle', isSupervisorEnabled());
  appendAll(supervisorRow, supervisorText, supervisorToggle);

  const deadlineRow = el('div', 'settings-field');
  const deadlineText = el('div', 'settings-field__text', 'Дедлайн');
  const deadlineInput = el('input', 'input', null, {
    type: 'time',
    id: 'deadline-input',
  });
  deadlineInput.value = getDeadline();
  deadlineInput.style.width = '100px';
  deadlineInput.style.minHeight = '36px';
  appendAll(deadlineRow, deadlineText, deadlineInput);

  appendAll(supervisorCard, supervisorLabel, supervisorDesc, supervisorRow, deadlineRow);

  // ── Vacation Mode ──
  const vacationCard = el('div', 'settings-card card card--md');
  const vacationLabel = el('div', 'field-label', '🏖 Режим відпустки');
  const vacationDesc  = el('div', 'hint', 'Призупинити серію та нагадування');

  const vacationRow = el('div', 'settings-field');
  const vacationText = el('div', 'settings-field__text', 'Увімкнути');
  const vacationToggle = buildToggle('vacation-toggle', isVacationMode());
  appendAll(vacationRow, vacationText, vacationToggle);

  appendAll(vacationCard, vacationLabel, vacationDesc, vacationRow);

  // ── Dark Mode ──
  const themeCard = el('div', 'settings-card card card--md');
  const themeLabel = el('div', 'field-label', '🎨 Тема');
  const themeDesc  = el('div', 'hint', 'Авто — слідує темі Telegram');

  const themeRow = el('div', 'settings-field');
  const themeSegmented = el('div', 'segmented', null, { id: 'theme-segmented' });
  const currentTheme = getThemeOverride();

  const themeOpts = [
    { value: 'auto',  label: 'Авто' },
    { value: 'dark',  label: '🌙 Темна' },
    { value: 'light', label: '☀️ Світла' },
  ];

  for (const opt of themeOpts) {
    const btn = el('button', `segmented__btn${opt.value === currentTheme ? ' is-active' : ''}`,
      opt.label, { type: 'button', 'data-theme': opt.value });
    themeSegmented.appendChild(btn);
  }

  appendAll(themeRow, themeSegmented);
  appendAll(themeCard, themeLabel, themeDesc, themeRow);

  // ── Danger Zone ──
  const dangerCard = el('div', 'settings-card card card--md');
  const dangerLabel = el('div', 'field-label', '⚠️ Небезпечна зона');

  const deleteBtn = el('button', 'ghost', '🗑 Видалити всі дані', {
    type: 'button',
    id: 'settings-delete-all',
  });
  deleteBtn.style.color = 'var(--danger)';

  const unlinkBtn = el('button', 'ghost', '🔗 Від\'єднати наглядача', {
    type: 'button',
    id: 'settings-unlink',
  });

  appendAll(dangerCard, dangerLabel, deleteBtn, unlinkBtn);

  // ── Assemble ──
  appendAll(container, profileCard, supervisorCard, vacationCard, themeCard, dangerCard);

  // ── Wire events ──
  wireSettingsEvents(container);
  _built = true;
}

// ─── Toggle component ────────────────────────────────────────────────────────

function buildToggle(id, checked) {
  const toggle = el('button', `toggle${checked ? ' is-active' : ''}`, null, {
    type: 'button',
    id,
    role: 'switch',
    'aria-pressed': checked ? 'true' : 'false',
  });
  const knob = el('span', 'toggle__knob');
  toggle.appendChild(knob);
  return toggle;
}

function flipToggle(btn) {
  const isActive = btn.classList.contains('is-active');
  btn.classList.toggle('is-active', !isActive);
  btn.setAttribute('aria-pressed', String(!isActive));
  return !isActive;
}

// ─── Wire events ─────────────────────────────────────────────────────────────

function wireSettingsEvents(container) {
  // Supervisor toggle
  const supToggle = container.querySelector('#supervisor-toggle');
  if (supToggle) {
    supToggle.addEventListener('click', () => {
      const on = flipToggle(supToggle);
      setSupervisorEnabled(on);
      haptic('selection');
      if (on) forceCheck();
      showToast({
        type: 'success',
        message: on ? 'Наглядач увімкнено' : 'Наглядач вимкнено',
        duration: 1400,
      });
    });
  }

  // Deadline input
  const deadlineInput = container.querySelector('#deadline-input');
  if (deadlineInput) {
    deadlineInput.addEventListener('change', () => {
      setDeadline(deadlineInput.value);
      haptic('selection');
      showToast({
        type: 'success',
        message: `Дедлайн: ${deadlineInput.value}`,
        duration: 1400,
      });
    });
  }

  // Vacation toggle
  const vacToggle = container.querySelector('#vacation-toggle');
  if (vacToggle) {
    vacToggle.addEventListener('click', () => {
      const on = flipToggle(vacToggle);
      setVacationMode(on);
      haptic('selection');

      // Sync to server
      saveSettings({ vacation: on }).catch(() => {});

      showToast({
        type: 'success',
        message: on ? '🏖 Відпустка увімкнена' : 'Відпустка вимкнена',
        duration: 1400,
      });
    });
  }

  // Theme segmented
  const themeSegmented = container.querySelector('#theme-segmented');
  if (themeSegmented) {
    themeSegmented.addEventListener('click', (evt) => {
      const btn = evt.target.closest('[data-theme]');
      if (!btn) return;
      const value = btn.dataset.theme;
      setThemeOverride(value);
      themeSegmented.querySelectorAll('.segmented__btn').forEach(b =>
        b.classList.toggle('is-active', b === btn));
      haptic('selection');
    });
  }

  // Delete all data
  const deleteBtn = container.querySelector('#settings-delete-all');
  if (deleteBtn) {
    deleteBtn.addEventListener('click', () => {
      haptic('warning');
      showToast({
        type: 'error',
        message: 'Видалити ВСІ дані? Цю дію не можна скасувати.',
        actionLabel: 'Підтвердити',
        duration: 5000,
        onAction: async () => {
          try {
            await apiFetch('/api/settings/delete-all', { method: 'POST' });
            localStorage.clear();
            showToast({ type: 'success', message: 'Дані видалено. Перезавантаження…' });
            setTimeout(() => window.location.reload(), 1500);
          } catch (err) {
            showToast({ type: 'error', message: 'Не вдалося видалити.' });
          }
        },
      });
    });
  }

  // Unlink monitor
  const unlinkBtn = container.querySelector('#settings-unlink');
  if (unlinkBtn) {
    unlinkBtn.addEventListener('click', async () => {
      try {
        await apiFetch('/api/monitor/unlink', { method: 'POST' });
        haptic('success');
        showToast({ type: 'success', message: 'Наглядача від\'єднано.' });
      } catch {
        showToast({ type: 'error', message: 'Не вдалося від\'єднати.' });
      }
    });
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Initialize settings controller.
 * @param {Store} store
 */
export function initSettings(store) {
  _store = store;
  // Apply saved theme override on boot
  applyThemeOverride(getThemeOverride());
}

/**
 * Render settings tab content.
 * Called when user switches to the settings tab.
 */
export function renderSettings() {
  const container = document.getElementById('settings-content');
  const skeleton  = document.getElementById('settings-skeleton');
  if (!container) return;

  if (skeleton) skeleton.hidden = true;
  container.hidden = false;

  // Always rebuild to reflect latest state
  buildSettingsUI(container);
}
