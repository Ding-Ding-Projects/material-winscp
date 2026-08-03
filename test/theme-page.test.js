'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../design/renderer/ui/theme-page.js');

function fakeStore(initialTheme = {}) {
  let theme = { ...initialTheme };
  const listeners = new Set();
  return {
    get(path) {
      assert.equal(path, 'theme');
      return theme;
    },
    set(path, value) {
      assert.equal(path, 'theme');
      theme = value;
      for (const listener of listeners) listener(theme);
    },
    subscribe(path, listener) {
      assert.equal(path, 'theme');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

test('ThemePageControl exposes exactly light, dark, system and high-contrast', async () => {
  const { THEME_MODES, THEME_MODE_VALUES } = await load();
  assert.deepEqual(THEME_MODE_VALUES, ['light', 'dark', 'system', 'high-contrast']);
  assert.deepEqual(THEME_MODES.map(({ value }) => value), THEME_MODE_VALUES);
  assert.ok(THEME_MODES.every((mode) => mode.labelKey && mode.descriptionKey));
});

test('unsupported theme modes are rejected before any state write', async () => {
  const { createThemePageController, validateThemeMode } = await load();
  assert.throws(() => validateThemeMode('auto'), /Unsupported theme mode "auto"/);
  assert.throws(() => validateThemeMode('highContrast'), /Supported values: light, dark, system, high-contrast/);

  const state = fakeStore({ mode: 'system', reduceMotion: false });
  const persisted = [];
  const controller = createThemePageController({
    store: state,
    persistTheme: (next) => persisted.push(next),
  });
  assert.throws(() => controller.setMode('sepia'), /Unsupported theme mode "sepia"/);
  assert.deepEqual(state.get('theme'), { mode: 'system', reduceMotion: false });
  assert.deepEqual(persisted, []);
});

test('mode changes persist the complete state and high contrast enables maximum separation', async () => {
  const { createThemePageController } = await load();
  const state = fakeStore({ mode: 'light', contrast: 0, reduceMotion: false, seed: '#0B57D0' });
  const persisted = [];
  const controller = createThemePageController({
    store: state,
    persistTheme: (next) => persisted.push(structuredClone(next)),
  });

  const high = controller.setMode('high-contrast');
  assert.equal(high.mode, 'high-contrast');
  assert.equal(high.contrast, 1);
  assert.equal(state.get('theme').seed, '#0B57D0');
  assert.deepEqual(persisted.at(-1), state.get('theme'));

  const dark = controller.setMode('dark');
  assert.equal(dark.mode, 'dark');
  assert.equal(dark.contrast, 0);
  assert.deepEqual(persisted.at(-1), state.get('theme'));
});

test('reduced motion accepts only booleans and combines with the OS preference', async () => {
  const { createThemePageController, reducedMotionIsActive, validateReducedMotion } = await load();
  assert.equal(reducedMotionIsActive({ mode: 'system', reduceMotion: false }, { matches: false }), false);
  assert.equal(reducedMotionIsActive({ mode: 'system', reduceMotion: false }, { matches: true }), true);
  assert.equal(reducedMotionIsActive({ mode: 'system', reduceMotion: true }, { matches: false }), true);
  assert.throws(() => validateReducedMotion('false'), /must be a boolean/);

  const state = fakeStore({ mode: 'system', reduceMotion: false });
  const persisted = [];
  const controller = createThemePageController({
    store: state,
    persistTheme: (next) => persisted.push(next),
  });
  controller.setReducedMotion(true);
  assert.equal(controller.getState().reduceMotion, true);
  assert.equal(persisted.length, 1);
  assert.throws(() => controller.setReducedMotion(1), /must be a boolean/);
  assert.equal(persisted.length, 1);
});

test('arrow, Home and End keys provide deterministic keyboard selection', async () => {
  const { nextThemeMode } = await load();
  assert.equal(nextThemeMode('light', 'ArrowRight'), 'dark');
  assert.equal(nextThemeMode('light', 'ArrowUp'), 'high-contrast');
  assert.equal(nextThemeMode('high-contrast', 'ArrowDown'), 'light');
  assert.equal(nextThemeMode('dark', 'Home'), 'light');
  assert.equal(nextThemeMode('light', 'End'), 'high-contrast');
  assert.equal(nextThemeMode('system', 'PageDown'), 'system');
  assert.throws(() => nextThemeMode('auto', 'ArrowRight'), /Unsupported theme mode/);
});

test('controller reads an existing persisted mode without rewriting it', async () => {
  const { createThemePageController } = await load();
  const state = fakeStore({ mode: 'high-contrast', contrast: 1, reduceMotion: true });
  const persisted = [];
  const controller = createThemePageController({ store: state, persistTheme: (next) => persisted.push(next) });
  assert.deepEqual(controller.getState(), state.get('theme'));
  assert.equal(controller.isReducedMotion(), true);
  assert.deepEqual(persisted, []);
});
