// lib/theme.js — turn the stored settings into CSS custom properties.
//
// app.css ships a light-scheme FLOOR so the very first paint is styled even
// before this module runs; everything here overwrites it from the seed. That
// order matters: a page whose colours only exist once a module has executed
// flashes unstyled text on a slow connection, and on a module error it stays
// that way permanently.
//
// prefers-color-scheme is followed by default and overridable explicitly, which
// is the rule for every surface in this project: the system is a default, not a
// verdict.

import { buildScheme, cssVarName, contrastHex } from './color.js';
import { FONT_STACKS } from './store.js';

/** Short aliases (--p, --onp, --sfc …) mirror the desktop app's token names so
 *  a rule copied from design/renderer/styles reads the same here. */
const ALIAS = {
  primary: 'p', onPrimary: 'onp', primaryContainer: 'pc', onPrimaryContainer: 'onpc',
  secondary: 'sec', onSecondary: 'onsec', secondaryContainer: 'secc', onSecondaryContainer: 'onsecc',
  tertiary: 'ter', onTertiary: 'onter', tertiaryContainer: 'terc', onTertiaryContainer: 'onterc',
  error: 'err', onError: 'onerr', errorContainer: 'errc', onErrorContainer: 'onerrc',
  surface: 'sfc', onSurface: 'onsfc', surfaceVariant: 'sv', onSurfaceVariant: 'onsv',
  surfaceContainerLowest: 'c-lowest', surfaceContainerLow: 'c-low', surfaceContainer: 'c',
  surfaceContainerHigh: 'c-high', surfaceContainerHighest: 'c-highest',
  outline: 'outline', outlineVariant: 'outline-var',
  inverseSurface: 'inv-sfc', inverseOnSurface: 'inv-onsfc', inversePrimary: 'inv-p',
  surfaceTint: 'tint',
};

let media = null;
let current = { dark: false, scheme: null };

export function isDark() { return current.dark; }
export function scheme() { return current.scheme; }

function resolveDark(settings) {
  if (settings.theme === 'dark') return true;
  if (settings.theme === 'light') return false;
  return Boolean(media && media.matches);
}

/**
 * Write the whole scheme onto :root.
 *
 * Also reports the primary/on-primary and surface/on-surface contrast so the
 * settings page can show a real readout rather than a promise: a seed the user
 * picked can genuinely produce a scheme that fails AA, and the honest answer is
 * to say so beside the picker.
 */
export function applyTheme(settings) {
  const dark = resolveDark(settings);
  const s = buildScheme(settings.seed, dark, settings.contrastBoost);
  const root = document.documentElement;

  for (const [role, hex] of Object.entries(s)) {
    root.style.setProperty(cssVarName(role), hex);
    if (ALIAS[role]) root.style.setProperty(`--${ALIAS[role]}`, hex);
  }
  root.dataset.theme = dark ? 'dark' : 'light';
  root.style.colorScheme = dark ? 'dark' : 'light';

  root.style.setProperty('--ui', FONT_STACKS[settings.fontFamily]?.stack || FONT_STACKS.system.stack);
  root.style.setProperty('--font-size', `${settings.fontSize}px`);
  root.style.setProperty('--font-weight', String(settings.fontWeight));
  // Material's density scale: 0 → 1, each step down tightens by 8%.
  root.style.setProperty('--den', String(1 + settings.density * 0.08));
  root.dataset.rm = settings.reduceMotion ? '1' : '0';
  root.lang = settings.lang === 'yue' ? 'zh-HK' : 'en';

  current = {
    dark,
    scheme: s,
    contrast: {
      primary: contrastHex(s.primary, s.onPrimary),
      surface: contrastHex(s.surface, s.onSurface),
      body: contrastHex(s.surface, s.onSurfaceVariant),
    },
  };
  return current;
}

/** Follow the system while `theme` is 'system'. Re-applied on change, not read
 *  once at boot: a visitor who flips their OS to dark mid-read should not have
 *  to reload. */
export function startTheme(store) {
  media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  const apply = () => applyTheme(store.get());
  if (media && media.addEventListener) media.addEventListener('change', apply);
  store.subscribe((_, changed) => {
    if (changed.some((k) => ['theme', 'seed', 'contrastBoost', 'density', 'fontFamily',
      'fontSize', 'fontWeight', 'reduceMotion', 'lang'].includes(k))) apply();
  });
  apply();
}

/** The explicit override the topbar button toggles: system → the opposite of
 *  what is currently shown, then light ↔ dark from there. */
export function nextTheme(settings) {
  if (settings.theme === 'system') return resolveDark(settings) ? 'light' : 'dark';
  return settings.theme === 'dark' ? 'light' : 'dark';
}
