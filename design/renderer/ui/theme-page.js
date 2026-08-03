// ui/theme-page.js — the renderer-safe ThemePageControl.
//
// This page is deliberately a small controller rather than a second theme
// engine. The renderer state store remains the source of truth; this module
// validates the values it writes, persists the complete theme object, and
// renders a keyboard-accessible radio group for the four supported modes.

import { h, clear, uid, appearanceTarget, announce } from '../dom.js';
import { store as defaultStore, persistCurrent as defaultPersistCurrent } from '../state.js';
import { defineStrings, t, bindRender } from '../i18n.js';
import { styleSheet } from '../theme.js';

export const THEME_MODES = Object.freeze([
  { value: 'light', labelKey: 'themeLight', descriptionKey: 'themePageLightDescription' },
  { value: 'dark', labelKey: 'themeDark', descriptionKey: 'themePageDarkDescription' },
  { value: 'system', labelKey: 'themeAuto', descriptionKey: 'themePageSystemDescription' },
  { value: 'high-contrast', labelKey: 'themePageHighContrast', descriptionKey: 'themePageHighContrastDescription' },
]);

export const THEME_MODE_VALUES = Object.freeze(THEME_MODES.map((mode) => mode.value));

defineStrings({
  themePageTitle: ['Theme and appearance', '主題同外觀'],
  themePageDescription: [[
    'Choose the colour mode used by the application. The choice is saved immediately and stays after restart.',
    'Choose the colour mode used by the application. It is saved immediately and stays after restart.',
    'Choose the app colour mode; the setting is saved straight away and remembers itself after restart.',
    'Choose the app colour mode. The setting is written now, so the next launch knows what you picked.',
    'Choose the app colour mode — the setting is saved now, because even colours deserve a memory.',
  ], [
    '揀程式用咩顏色模式。選擇會即刻儲存，重開之後都會保留。',
    '揀程式顏色模式，會即刻儲存，重開都仲喺度。',
    '揀個 app 用咩色；設定即刻寫低，重開唔使再估。',
    '揀程式顏色模式。設定而家寫好，下一次開機識得跟返你。',
    '揀程式顏色模式——顏色都有記性，設定即刻幫你記低。',
  ]],
  themePageModeLegend: ['Appearance mode', '外觀模式'],
  themePageLightDescription: ['Use a light colour scheme.', '使用淺色配色。'],
  themePageDarkDescription: ['Use a dark colour scheme.', '使用深色配色。'],
  themePageSystemDescription: ['Follow the operating system colour preference.', '跟隨作業系統嘅顏色偏好。'],
  themePageHighContrast: ['High contrast', '高對比'],
  themePageHighContrastDescription: [[
    'Use the highest supported contrast separation for interface roles.',
    'Use high contrast separation for interface roles.',
    'Use the app’s high-contrast colour separation for clearer edges.',
    'Use the highest supported separation, so controls do not blend into the wallpaper.',
    'Turn the contrast dial to maximum — the controls are putting on their brightest hi-vis jackets.',
  ], [
    '用介面角色支援到嘅最高對比度分隔。',
    '用高對比度分隔介面角色。',
    '用程式嘅高對比配色，等控制項邊界清楚啲。',
    '用支援到嘅最高分隔，等控制項唔會同背景撈埋一碟。',
    '將對比度扭到最大——控制項而家着晒最光猛嘅反光背心。',
  ]],
  themePageReducedMotion: ['Reduce motion', '減少動態效果'],
  themePageReducedMotionDescription: [[
    'Disable interface transitions when enabled. The operating system reduced-motion preference is also honoured.',
    'Disable interface transitions when enabled. The operating system preference is also honoured.',
    'Disable interface transitions here; the operating system preference joins in too.',
    'Disable interface transitions here and respect the operating system request for less motion.',
    'Keep the interface still here, and listen when the operating system says the animation train should park.',
  ], [
    '開啟後停用介面轉場；亦會尊重作業系統嘅減少動態設定。',
    '開啟後停用介面轉場，亦會跟作業系統設定。',
    '喺呢度停用介面轉場；作業系統叫少啲郁都會照跟。',
    '停用介面轉場，亦尊重作業系統要求少啲動態效果。',
    '等介面定定企喺度，作業系統叫動畫班車泊站就照做。',
  ]],
  themePageMotionOn: ['Reduced motion is active.', '減少動態效果已啟用。'],
  themePageMotionOff: ['Reduced motion is not active.', '減少動態效果未啟用。'],
  themePageSelection: ['Theme mode: {0}', '主題模式：{0}'],
});

/** Validate and return one of the four persisted theme mode values. */
export function validateThemeMode(value) {
  if (!THEME_MODE_VALUES.includes(value)) {
    throw new RangeError(
      `Unsupported theme mode "${String(value)}". Supported values: ${THEME_MODE_VALUES.join(', ')}`,
    );
  }
  return value;
}

/** Validate the persisted boolean rather than silently accepting truthy data. */
export function validateReducedMotion(value) {
  if (typeof value !== 'boolean') {
    throw new TypeError(`Reduced motion must be a boolean; received ${String(value)}`);
  }
  return value;
}

/**
 * Validate the theme fields owned by this page while preserving the rest of
 * the theme object (seed, density, typography and appearance overrides).
 */
export function normalizeThemeState(themeState = {}) {
  if (themeState === null || typeof themeState !== 'object' || Array.isArray(themeState)) {
    throw new TypeError('Theme state must be an object');
  }
  const mode = validateThemeMode(themeState.mode === undefined ? 'system' : themeState.mode);
  const reduceMotion = validateReducedMotion(
    themeState.reduceMotion === undefined ? false : themeState.reduceMotion,
  );
  return { ...themeState, mode, reduceMotion };
}

/**
 * Return the next mode for keyboard navigation. Arrow keys select in place;
 * Home and End make the whole group reachable without pointer movement.
 */
export function nextThemeMode(current, key) {
  const value = validateThemeMode(current);
  const index = THEME_MODE_VALUES.indexOf(value);
  const delta = key === 'ArrowRight' || key === 'ArrowDown' ? 1
    : key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 0;
  if (delta) {
    return THEME_MODE_VALUES[(index + delta + THEME_MODE_VALUES.length) % THEME_MODE_VALUES.length];
  }
  if (key === 'Home') return THEME_MODE_VALUES[0];
  if (key === 'End') return THEME_MODE_VALUES[THEME_MODE_VALUES.length - 1];
  return value;
}

/** Resolve the persisted preference and the OS preference without touching DOM. */
export function reducedMotionIsActive(themeState, mediaQueryList = null) {
  const state = normalizeThemeState(themeState);
  return state.reduceMotion || !!mediaQueryList?.matches;
}

function defaultMatchMedia(query) {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(query) : null;
}

function installStyles() {
  styleSheet('theme-page').set(`
.theme-page { display: flex; flex-direction: column; gap: calc(18px * var(--den));
               min-width: 0; padding: calc(20px * var(--den)); color: var(--onsfc); }
.theme-page-title { margin: 0; font-size: var(--type-headline-sm); font-weight: 500; }
.theme-page-description, .theme-page-motion-description { max-width: 72ch; margin: 0;
  color: var(--onsv); line-height: 1.5; }
.theme-page-modes { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(220px, 100%), 1fr));
  gap: calc(10px * var(--den)); border: 0; margin: 0; min-width: 0; padding: 0; }
.theme-page-modes legend { margin-bottom: calc(8px * var(--den)); font-size: var(--type-title-md); }
.theme-page-option { display: flex; align-items: flex-start; gap: calc(10px * var(--den));
  min-height: calc(72px * var(--den)); padding: calc(12px * var(--den));
  border: 1px solid var(--outline-var); border-radius: var(--shape-md);
  background: var(--c-lowest); color: var(--onsfc); cursor: pointer; }
.theme-page-option:focus-within { outline: 2px solid var(--p); outline-offset: 2px; }
.theme-page-option:has(input:checked) { border-color: var(--p); background: var(--pc); color: var(--onpc); }
.theme-page-option input { flex: 0 0 auto; width: 18px; height: 18px; margin: 2px 0 0;
  accent-color: var(--p); }
.theme-page-option-copy { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.theme-page-option-label { font-weight: 600; }
.theme-page-option-description { color: var(--onsv); line-height: 1.4; }
.theme-page-option:has(input:checked) .theme-page-option-description { color: var(--onpc); }
.theme-page-motion { display: flex; flex-direction: column; gap: 8px; border-top: 1px solid var(--outline-var);
  padding-top: calc(16px * var(--den)); }
.theme-page-check { display: inline-flex; align-items: center; gap: 10px; min-height: 32px; cursor: pointer; }
.theme-page-check input { width: 18px; height: 18px; accent-color: var(--p); }
.theme-page-status { margin: 0; color: var(--onsv); font-size: var(--type-label-md); }
@media (prefers-reduced-motion: reduce), :root[data-rm="1"] {
  .theme-page-option, .theme-page-option * { transition: none !important; animation: none !important; }
}
`);
}

/**
 * Create a mountable ThemePageControl.
 *
 * `persistTheme(next)` is injectable for headless callers. In the real
 * renderer it defaults to state.js's coalescing `persistCurrent('theme')`.
 */
export function createThemePageController(options = {}) {
  const stateStore = options.store || defaultStore;
  const persistTheme = options.persistTheme || (() => {
    if (stateStore === defaultStore) defaultPersistCurrent('theme');
  });
  const matchMedia = options.matchMedia || defaultMatchMedia;
  const announceState = options.announce || announce;
  let page = null;
  let unsubscribeState = null;
  let unsubscribeLanguage = null;
  let motionQuery = null;
  let onMotionChange = null;
  let modeInputs = new Map();
  let pageTitleId = '';
  let modeGroupName = '';

  function read() {
    return normalizeThemeState(stateStore.get('theme'));
  }

  function write(patch) {
    const current = read();
    const next = normalizeThemeState({ ...current, ...patch });
    stateStore.set('theme', next);
    persistTheme(next);
    return next;
  }

  function setMode(value) {
    const mode = validateThemeMode(value);
    const current = read();
    // High contrast is a mode, not a second toggle. The existing Material
    // engine's high contrast role shift is enabled with contrast=1. Returning
    // to a normal mode restores the standard role separation.
    const contrast = mode === 'high-contrast' ? 1
      : current.mode === 'high-contrast' ? 0 : current.contrast;
    const next = write({ mode, contrast });
    if (page?.isConnected) announceState(t('themePageSelection', mode));
    return next;
  }

  function setReducedMotion(value) {
    const reduceMotion = validateReducedMotion(value);
    return write({ reduceMotion });
  }

  function render() {
    if (!page) return;
    const state = read();
    const media = motionQuery || matchMedia('(prefers-reduced-motion: reduce)');
    const reduced = reducedMotionIsActive(state, media);
    page.dataset.reducedMotion = reduced ? '1' : '0';
    clear(page);
    modeInputs = new Map();

    const titleId = pageTitleId || uid('theme-page-title');
    const legendId = uid('theme-page-modes');
    const motionId = uid('theme-page-motion');
    const title = h('h1', { class: 'theme-page-title', id: titleId }, t('themePageTitle'));
    const description = h('p', { class: 'theme-page-description' }, t('themePageDescription'));
    const fieldset = h('fieldset', {
      class: 'theme-page-modes', role: 'radiogroup', 'aria-labelledby': legendId,
    });
    fieldset.appendChild(h('legend', { id: legendId }, t('themePageModeLegend')));

    for (const mode of THEME_MODES) {
      const inputId = uid(`theme-${mode.value.replace('-', '-')}`);
      const descriptionId = uid(`${inputId}-description`);
      const input = h('input', {
        id: inputId, type: 'radio', name: modeGroupName || 'theme-page-mode', value: mode.value,
        'aria-describedby': descriptionId,
      });
      input.checked = state.mode === mode.value;
      input.addEventListener('change', () => { if (input.checked) setMode(mode.value); });
      input.addEventListener('keydown', (event) => {
        if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const next = nextThemeMode(mode.value, event.key);
        setMode(next);
        queueMicrotask(() => modeInputs.get(next)?.focus());
      });
      modeInputs.set(mode.value, input);
      fieldset.appendChild(h('label', { class: 'theme-page-option', for: inputId },
        input,
        h('span', { class: 'theme-page-option-copy' },
          h('span', { class: 'theme-page-option-label' }, t(mode.labelKey)),
          h('span', { class: 'theme-page-option-description', id: descriptionId }, t(mode.descriptionKey)),
        ),
      ));
    }

    const motionLabel = h('label', { class: 'theme-page-check', for: motionId },
      h('input', { id: motionId, type: 'checkbox' }),
      h('span', {}, t('themePageReducedMotion')),
    );
    const motionInput = motionLabel.querySelector('input');
    motionInput.checked = state.reduceMotion;
    motionInput.addEventListener('change', () => setReducedMotion(motionInput.checked));
    const motionDescription = h('p', { class: 'theme-page-motion-description' }, t('themePageReducedMotionDescription'));
    const status = h('p', { class: 'theme-page-status', role: 'status', 'aria-live': 'polite' },
      t(reduced ? 'themePageMotionOn' : 'themePageMotionOff'));

    page.append(title, description, fieldset,
      h('section', { class: 'theme-page-motion', 'aria-labelledby': motionId }, motionLabel, motionDescription, status));
  }

  function mount(container) {
    if (!container || typeof container.appendChild !== 'function') {
      throw new TypeError('ThemePageControl.mount needs a DOM container');
    }
    if (page?.isConnected) return page;
    installStyles();
    pageTitleId = uid('theme-page-title');
    modeGroupName = uid('theme-page-mode-group');
    page = h('section', {
      class: 'theme-page', tabindex: '-1', 'aria-labelledby': pageTitleId,
    });
    appearanceTarget(page, 'theme-page', 'Theme and appearance');
    container.appendChild(page);
    render();
    unsubscribeState = typeof stateStore.subscribe === 'function'
      ? stateStore.subscribe('theme', render, { immediate: false }) : null;
    unsubscribeLanguage = bindRender(page, render);
    motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
    onMotionChange = () => render();
    if (motionQuery?.addEventListener) motionQuery.addEventListener('change', onMotionChange);
    else if (motionQuery?.addListener) motionQuery.addListener(onMotionChange);
    render();
    return page;
  }

  function dispose() {
    unsubscribeState?.();
    unsubscribeLanguage?.();
    unsubscribeState = null;
    unsubscribeLanguage = null;
    if (motionQuery?.removeEventListener && onMotionChange) motionQuery.removeEventListener('change', onMotionChange);
    else if (motionQuery?.removeListener && onMotionChange) motionQuery.removeListener(onMotionChange);
    motionQuery = null;
    onMotionChange = null;
    modeInputs = new Map();
    pageTitleId = '';
    modeGroupName = '';
    page?.remove();
    page = null;
  }

  return Object.freeze({
    mount,
    dispose,
    getState: read,
    setMode,
    setReducedMotion,
    isReducedMotion: () => reducedMotionIsActive(read(), motionQuery || matchMedia('(prefers-reduced-motion: reduce)')),
    render,
  });
}

export function mountThemePage(container, options) {
  const controller = createThemePageController(options);
  controller.mount(container);
  return controller;
}
