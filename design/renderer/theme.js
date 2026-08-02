// theme.js — the Material Design 3 token engine.
//
// The whole colour system is derived at runtime from one seed colour using
// HCT (hue / chroma / tone), the colour space Material 3 is specified in.
// That means a real CAM16 implementation plus the tone→L* relationship, not
// an HSL approximation: HSL lightness is not perceptual, so an HSL "tonal
// palette" produces containers that fail contrast at the same tone number.
//
// Everything downstream reads CSS custom properties, so a theme change is a
// single write to :root and the live UI updates with no restart and no
// re-render.
//
// Exports
//   applyTheme(theme)        write every token + typography/density var
//   currentScheme()          the resolved {light|dark} role map
//   tonalPalettes(seed)      the five/six palettes for a seed
//   hexFromHct / hctFromHex  the colour maths, reused by the colour picker
//   startThemeEngine()       binds the store to the DOM and OS colour scheme

import { store, persistCurrent, bus } from './state.js';
import { FONTS } from '../winscp-data.js';

/* ================================================================== */
/* colour science: sRGB ↔ XYZ ↔ CAM16 ↔ HCT                            */
/* ================================================================== */

const PI = Math.PI;
const SRGB_TO_XYZ = [
  [0.41233895, 0.35762064, 0.18051042],
  [0.2126, 0.7152, 0.0722],
  [0.01932141, 0.11916382, 0.95034478],
];
const XYZ_TO_SRGB = [
  [3.2413774792388685, -1.5376652402851851, -0.49885366846268053],
  [-0.9691452513005321, 1.8758853451067872, 0.04156585616912061],
  [0.05562093689691305, -0.20395524564742123, 1.0571799111220335],
];
const WHITE_POINT_D65 = [95.047, 100.0, 108.883];

const signum = (v) => (v < 0 ? -1 : v === 0 ? 0 : 1);
const lerp = (a, b, t) => a + (b - a) * t;
const clampD = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function linearized(rgbComponent) {
  const n = rgbComponent / 255;
  return (n <= 0.040449936 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4) * 100;
}
function delinearized(rgbComponent) {
  const n = rgbComponent / 100;
  const v = n <= 0.0031308 ? n * 12.92 : 1.055 * n ** (1 / 2.4) - 0.055;
  return clampD(Math.round(v * 255), 0, 255);
}
function labF(t) { const e = 216 / 24389, k = 24389 / 27; return t > e ? Math.cbrt(t) : (k * t + 16) / 116; }
function labInvf(ft) {
  const e = 216 / 24389, k = 24389 / 27;
  const ft3 = ft * ft * ft;
  return ft3 > e ? ft3 : (116 * ft - 16) / k;
}
/** CIE L* for a relative luminance Y in 0..100. Tone in HCT *is* L*. */
export function lstarFromY(y) { return 116 * labF(y / 100) - 16; }
export function yFromLstar(lstar) { return 100 * labInvf((lstar + 16) / 116); }

function xyzFromRgb(r, g, b) {
  const lr = linearized(r), lg = linearized(g), lb = linearized(b);
  return [
    SRGB_TO_XYZ[0][0] * lr + SRGB_TO_XYZ[0][1] * lg + SRGB_TO_XYZ[0][2] * lb,
    SRGB_TO_XYZ[1][0] * lr + SRGB_TO_XYZ[1][1] * lg + SRGB_TO_XYZ[1][2] * lb,
    SRGB_TO_XYZ[2][0] * lr + SRGB_TO_XYZ[2][1] * lg + SRGB_TO_XYZ[2][2] * lb,
  ];
}
function rgbFromXyz(x, y, z) {
  const lr = XYZ_TO_SRGB[0][0] * x + XYZ_TO_SRGB[0][1] * y + XYZ_TO_SRGB[0][2] * z;
  const lg = XYZ_TO_SRGB[1][0] * x + XYZ_TO_SRGB[1][1] * y + XYZ_TO_SRGB[1][2] * z;
  const lb = XYZ_TO_SRGB[2][0] * x + XYZ_TO_SRGB[2][1] * y + XYZ_TO_SRGB[2][2] * z;
  return [delinearized(lr), delinearized(lg), delinearized(lb)];
}

/** Viewing conditions for CAM16 — the Material 3 defaults. */
function makeViewingConditions() {
  const wp = WHITE_POINT_D65;
  const adaptingLuminance = (200 / PI) * (yFromLstar(50) / 100);
  const backgroundLstar = 50, surround = 2, discounting = false;
  const rW = wp[0] * 0.401288 + wp[1] * 0.650173 + wp[2] * -0.051461;
  const gW = wp[0] * -0.250268 + wp[1] * 1.204414 + wp[2] * 0.045854;
  const bW = wp[0] * -0.002079 + wp[1] * 0.048952 + wp[2] * 0.953127;
  const f = 0.8 + surround / 10;
  const c = f >= 0.9 ? lerp(0.59, 0.69, (f - 0.9) * 10) : lerp(0.525, 0.59, (f - 0.8) * 10);
  let d = discounting ? 1 : f * (1 - (1 / 3.6) * Math.exp((-adaptingLuminance - 42) / 92));
  d = clampD(d, 0, 1);
  const nc = f;
  const rgbD = [d * (100 / rW) + 1 - d, d * (100 / gW) + 1 - d, d * (100 / bW) + 1 - d];
  const k = 1 / (5 * adaptingLuminance + 1);
  const k4 = k * k * k * k, k4F = 1 - k4;
  const fl = k4 * adaptingLuminance + 0.1 * k4F * k4F * Math.cbrt(5 * adaptingLuminance);
  const n = yFromLstar(backgroundLstar) / wp[1];
  const z = 1.48 + Math.sqrt(n);
  const nbb = 0.725 / n ** 0.2;
  const ncb = nbb;
  const rgbAFactors = [
    (fl * rgbD[0] * rW / 100) ** 0.42,
    (fl * rgbD[1] * gW / 100) ** 0.42,
    (fl * rgbD[2] * bW / 100) ** 0.42,
  ];
  const rgbA = rgbAFactors.map((v) => (400 * v) / (v + 27.13));
  const aw = ((40 * rgbA[0] + 20 * rgbA[1] + rgbA[2]) / 20) * nbb;
  return { n, aw, nbb, ncb, c, nc, rgbD, fl, fLRoot: fl ** 0.25, z };
}
const VC = makeViewingConditions();

/** CAM16 appearance correlates for an sRGB triple. */
function cam16FromRgb(r, g, b) {
  const [x, y, z] = xyzFromRgb(r, g, b);
  const rC = 0.401288 * x + 0.650173 * y - 0.051461 * z;
  const gC = -0.250268 * x + 1.204414 * y + 0.045854 * z;
  const bC = -0.002079 * x + 0.048952 * y + 0.953127 * z;
  const rD = VC.rgbD[0] * rC, gD = VC.rgbD[1] * gC, bD = VC.rgbD[2] * bC;
  const rAF = ((VC.fl * Math.abs(rD)) / 100) ** 0.42;
  const gAF = ((VC.fl * Math.abs(gD)) / 100) ** 0.42;
  const bAF = ((VC.fl * Math.abs(bD)) / 100) ** 0.42;
  const rA = (signum(rD) * 400 * rAF) / (rAF + 27.13);
  const gA = (signum(gD) * 400 * gAF) / (gAF + 27.13);
  const bA = (signum(bD) * 400 * bAF) / (bAF + 27.13);
  const a = (11 * rA + -12 * gA + bA) / 11;
  const bb = (rA + gA - 2 * bA) / 9;
  const u = (20 * rA + 20 * gA + 21 * bA) / 20;
  const p2 = (40 * rA + 20 * gA + bA) / 20;
  const atanDegrees = (Math.atan2(bb, a) * 180) / PI;
  const hue = atanDegrees < 0 ? atanDegrees + 360 : atanDegrees >= 360 ? atanDegrees - 360 : atanDegrees;
  const hueRadians = (hue * PI) / 180;
  const ac = p2 * VC.nbb;
  const J = 100 * (ac / VC.aw) ** (VC.c * VC.z);
  const huePrime = hue < 20.14 ? hue + 360 : hue;
  const eHue = 0.25 * (Math.cos((huePrime * PI) / 180 + 2) + 3.8);
  const p1 = ((50000 / 13) * eHue * VC.nc) * VC.ncb;
  const t = (p1 * Math.hypot(a, bb)) / (u + 0.305);
  const alpha = t ** 0.9 * (1.64 - 0.29 ** VC.n) ** 0.73;
  const C = alpha * Math.sqrt(J / 100);
  const M = C * VC.fLRoot;
  // CAM16-UCS coordinates, used for the perceptual distance in the solver
  const jstar = ((1 + 100 * 0.007) * J) / (1 + 0.007 * J);
  const mstar = (1 / 0.0228) * Math.log(1 + 0.0228 * M);
  return { j: J, chroma: C, hue, jstar, astar: mstar * Math.cos(hueRadians), bstar: mstar * Math.sin(hueRadians) };
}

/** Inverse CAM16: J/C/h back to an sRGB triple (clipped into gamut). */
function rgbFromJch(J, C, h) {
  const alpha = C === 0 || J === 0 ? 0 : C / Math.sqrt(J / 100);
  const t = (alpha / (1.64 - 0.29 ** VC.n) ** 0.73) ** (1 / 0.9);
  const hRad = (h * PI) / 180;
  const eHue = 0.25 * (Math.cos(hRad + 2) + 3.8);
  const ac = VC.aw * (J / 100) ** (1 / VC.c / VC.z);
  const p1 = eHue * (50000 / 13) * VC.nc * VC.ncb;
  const p2 = ac / VC.nbb;
  const hSin = Math.sin(hRad), hCos = Math.cos(hRad);
  const gamma = (23 * (p2 + 0.305) * t) / (23 * p1 + 11 * t * hCos + 108 * t * hSin);
  const a = gamma * hCos, b = gamma * hSin;
  const rA = (460 * p2 + 451 * a + 288 * b) / 1403;
  const gA = (460 * p2 - 891 * a - 261 * b) / 1403;
  const bA = (460 * p2 - 220 * a - 6300 * b) / 1403;
  const inv = (v) => {
    const base = Math.max(0, (27.13 * Math.abs(v)) / (400 - Math.abs(v)));
    return signum(v) * (100 / VC.fl) * base ** (1 / 0.42);
  };
  const rCc = inv(rA), gCc = inv(gA), bCc = inv(bA);
  const rF = rCc / VC.rgbD[0], gF = gCc / VC.rgbD[1], bF = bCc / VC.rgbD[2];
  const x = 1.86206786 * rF - 1.01125463 * gF + 0.14918677 * bF;
  const y = 0.38752654 * rF + 0.62144744 * gF - 0.00897398 * bF;
  const z = -0.01584150 * rF - 0.03412294 * gF + 1.04996444 * bF;
  return rgbFromXyz(x, y, z);
}

function camDistance(a, b) {
  const dJ = a.jstar - b.jstar, dA = a.astar - b.astar, dB = a.bstar - b.bstar;
  return 1.41 * Math.sqrt(dJ * dJ + dA * dA + dB * dB) ** 0.63;
}

/**
 * Solve for the sRGB colour with the requested hue and tone and as much of the
 * requested chroma as sRGB can actually hold. Out-of-gamut requests degrade to
 * the most chromatic in-gamut colour rather than clipping to something with
 * the wrong hue — that is what keeps a tonal palette's hue constant.
 */
export function rgbFromHct(hue, chroma, tone) {
  if (chroma < 1 || Math.round(tone) <= 0 || Math.round(tone) >= 100) {
    const y = yFromLstar(tone);
    const c = delinearized(y);
    return [c, c, c];
  }
  const hueN = ((hue % 360) + 360) % 360;
  const chromaN = Math.max(0, chroma);

  const byJ = (targetChroma) => {
    let low = 0, high = 100, best = null, bestDE = 1000;
    while (Math.abs(low - high) > 0.01) {
      const mid = low + (high - low) / 2;
      const rgb = rgbFromJch(mid, targetChroma, hueN);
      const lstar = lstarFromY(xyzFromRgb(rgb[0], rgb[1], rgb[2])[1]);
      if (Math.abs(tone - lstar) < 0.2) {
        const cam = cam16FromRgb(rgb[0], rgb[1], rgb[2]);
        const want = { ...cam };
        const de = camDistance(cam, want) + Math.abs(cam.hue - hueN) * 0.0;
        const hueErr = Math.min(Math.abs(cam.hue - hueN), 360 - Math.abs(cam.hue - hueN));
        const chromaErr = Math.abs(cam.chroma - targetChroma);
        const total = de + hueErr + chromaErr;
        if (hueErr <= 4 && chromaErr <= 2.5 && total <= bestDE) { bestDE = total; best = rgb; }
      }
      if (lstar < tone) low = mid; else high = mid;
    }
    return best;
  };

  const exact = byJ(chromaN);
  if (exact) return exact;
  // Binary-search downward for the highest achievable chroma at this tone.
  let low = 0, high = chromaN, answer = null;
  while (high - low > 0.4) {
    const mid = low + (high - low) / 2;
    const got = byJ(mid);
    if (got) { answer = got; low = mid; } else high = mid;
  }
  if (answer) return answer;
  const y = yFromLstar(tone);
  const c = delinearized(y);
  return [c, c, c];
}

export function hexFromRgb([r, g, b]) {
  const p = (v) => clampD(Math.round(v), 0, 255).toString(16).padStart(2, '0');
  return `#${p(r)}${p(g)}${p(b)}`;
}
export function rgbFromHex(hex) {
  let h = String(hex || '').trim().replace('#', '');
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  if (h.length === 8) h = h.slice(0, 6);
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** HCT of a hex colour: { hue, chroma, tone }. */
export function hctFromHex(hex) {
  const rgb = rgbFromHex(hex) || [11, 87, 208];
  const cam = cam16FromRgb(rgb[0], rgb[1], rgb[2]);
  return { hue: cam.hue, chroma: cam.chroma, tone: lstarFromY(xyzFromRgb(rgb[0], rgb[1], rgb[2])[1]) };
}
export function hexFromHct(hue, chroma, tone) { return hexFromRgb(rgbFromHct(hue, chroma, tone)); }

/** WCAG contrast ratio between two hex colours (1..21). */
export function contrastHex(a, b) {
  const ra = rgbFromHex(a) || [0, 0, 0], rb = rgbFromHex(b) || [255, 255, 255];
  const lum = ([r, g, b2]) => 0.2126 * (linearized(r) / 100) + 0.7152 * (linearized(g) / 100) + 0.0722 * (linearized(b2) / 100);
  const l1 = lum(ra), l2 = lum(rb);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/* ================================================================== */
/* tonal palettes and schemes                                          */
/* ================================================================== */

export const TONES = [0, 4, 6, 10, 12, 17, 20, 22, 24, 30, 40, 50, 60, 70, 80, 87, 90, 92, 94, 95, 96, 98, 99, 100];

function palette(hue, chroma) {
  const cache = new Map();
  return {
    hue, chroma,
    tone(t) {
      const key = Math.round(t * 10);
      if (!cache.has(key)) cache.set(key, hexFromHct(hue, chroma, t));
      return cache.get(key);
    },
    all() { const o = {}; for (const t of TONES) o[t] = this.tone(t); return o; },
  };
}

/**
 * The six Material 3 palettes for a seed, using the "tonal spot" scheme —
 * the default Material You mapping.
 */
export function tonalPalettes(seedHex) {
  const { hue, chroma } = hctFromHex(seedHex);
  return {
    primary: palette(hue, Math.max(48, chroma)),
    secondary: palette(hue, 16),
    tertiary: palette(hue + 60, 24),
    neutral: palette(hue, 4),
    neutralVariant: palette(hue, 8),
    error: palette(25, 84),
  };
}

// Role → [palette, lightTone, darkTone]. This is the M3 baseline mapping; the
// mockup's own tokens sit exactly on these tones, so the derived scheme
// reproduces the approved design for the default seed.
const ROLES = {
  primary: ['primary', 40, 80],
  onPrimary: ['primary', 100, 20],
  primaryContainer: ['primary', 90, 30],
  onPrimaryContainer: ['primary', 10, 90],
  inversePrimary: ['primary', 80, 40],
  secondary: ['secondary', 40, 80],
  onSecondary: ['secondary', 100, 20],
  secondaryContainer: ['secondary', 90, 30],
  onSecondaryContainer: ['secondary', 10, 90],
  tertiary: ['tertiary', 40, 80],
  onTertiary: ['tertiary', 100, 20],
  tertiaryContainer: ['tertiary', 90, 30],
  onTertiaryContainer: ['tertiary', 10, 90],
  error: ['error', 40, 80],
  onError: ['error', 100, 20],
  errorContainer: ['error', 90, 30],
  onErrorContainer: ['error', 10, 90],
  background: ['neutral', 98, 6],
  onBackground: ['neutral', 10, 90],
  surface: ['neutral', 98, 6],
  onSurface: ['neutral', 10, 90],
  surfaceVariant: ['neutralVariant', 90, 30],
  onSurfaceVariant: ['neutralVariant', 30, 80],
  outline: ['neutralVariant', 50, 60],
  outlineVariant: ['neutralVariant', 80, 30],
  shadow: ['neutral', 0, 0],
  scrim: ['neutral', 0, 0],
  inverseSurface: ['neutral', 20, 90],
  inverseOnSurface: ['neutral', 95, 20],
  surfaceDim: ['neutral', 87, 6],
  surfaceBright: ['neutral', 98, 24],
  surfaceContainerLowest: ['neutral', 100, 4],
  surfaceContainerLow: ['neutral', 96, 10],
  surfaceContainer: ['neutral', 94, 12],
  surfaceContainerHigh: ['neutral', 92, 17],
  surfaceContainerHighest: ['neutral', 90, 22],
  surfaceTint: ['primary', 40, 80],
};

/**
 * contrast 0 = standard, 0.5 = medium, 1 = high. Raising it pushes "on" roles
 * further from their containers, exactly the tone-shift M3 specifies, so the
 * hue stays put while the separation grows.
 */
function shiftTone(role, tone, dark, contrast) {
  if (!contrast) return tone;
  const isOn = role.startsWith('on') || role === 'outline' || role === 'outlineVariant';
  const dir = dark ? 1 : -1;                     // "on" roles move away from mid grey
  const amount = contrast * 12;
  if (isOn) return clampD(tone + dir * amount, 0, 100);
  if (role.endsWith('Container')) return clampD(tone - dir * amount * 0.5, 0, 100);
  return tone;
}

/** The complete resolved role map for one mode. */
export function buildScheme(seedHex, dark, contrast = 0) {
  const pals = tonalPalettes(seedHex);
  const out = {};
  for (const [role, [pal, lt, dt]] of Object.entries(ROLES)) {
    const tone = shiftTone(role, dark ? dt : lt, dark, contrast);
    out[role] = pals[pal].tone(tone);
  }
  return out;
}

/* ================================================================== */
/* CSS variables                                                       */
/* ================================================================== */

const kebab = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

// The approved mockup uses short alias names (--p, --onp, --sfc …). Emitting
// both names keeps the mockup's component styles portable into this app while
// new code can use the full role names.
const ALIASES = {
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

const DENSITY_SCALE = { 0: 1, '-1': 0.92, '-2': 0.84, '-3': 0.76 };

/** Resolve a family name to a full CSS stack with CJK-safe fallbacks. */
export function fontStack(familyName) {
  const known = FONTS.find((f) => f.name === familyName);
  if (known) return known.stack;
  if (!familyName) return "system-ui,'Segoe UI','Microsoft JhengHei','Noto Sans HK',sans-serif";
  const quoted = /[\s]/.test(familyName) ? `'${familyName.replace(/'/g, '')}'` : familyName;
  return `${quoted},system-ui,'Segoe UI','Microsoft JhengHei','Noto Sans HK',sans-serif`;
}

let _scheme = null;
let _resolvedDark = false;

export function currentScheme() { return _scheme; }
export function isDark() { return _resolvedDark; }

function prefersDark() {
  return typeof window !== 'undefined'
    && window.matchMedia
    && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** Write every token for `theme` onto :root. Idempotent and cheap. */
export function applyTheme(theme) {
  const t = { ...store.get('theme'), ...(theme || {}) };
  const dark = t.mode === 'dark' || (t.mode === 'system' && prefersDark());
  _resolvedDark = dark;
  const scheme = buildScheme(t.seed || '#0B57D0', dark, Number(t.contrast) || 0);
  _scheme = scheme;

  const root = document.documentElement;
  const st = root.style;
  for (const [role, hex] of Object.entries(scheme)) {
    st.setProperty(`--md-sys-color-${kebab(role)}`, hex);
    const alias = ALIASES[role];
    if (alias) st.setProperty(`--${alias}`, hex);
  }
  // Full tonal palettes, so a component can reach a specific tone directly.
  const pals = tonalPalettes(t.seed || '#0B57D0');
  for (const [name, pal] of Object.entries(pals)) {
    for (const tone of TONES) st.setProperty(`--md-ref-palette-${kebab(name)}-${tone}`, pal.tone(tone));
  }

  // The "desktop" backdrop behind the app window in the mockup.
  st.setProperty('--desk', dark ? pals.neutral.tone(4) : pals.neutralVariant.tone(90));

  // Elevation — M3 shadow ramp, tuned darker in dark mode as the spec does.
  const sh = dark ? 0.55 : 0.3;
  st.setProperty('--e1', `0 1px 2px rgba(0,0,0,${sh}),0 1px 3px 1px rgba(0,0,0,${sh * 0.5})`);
  st.setProperty('--e2', `0 1px 2px rgba(0,0,0,${sh}),0 2px 6px 2px rgba(0,0,0,${sh * 0.5})`);
  st.setProperty('--e3', `0 4px 8px 3px rgba(0,0,0,${sh * 0.5}),0 1px 3px rgba(0,0,0,${sh})`);
  st.setProperty('--e4', `0 6px 10px 4px rgba(0,0,0,${sh * 0.5}),0 2px 3px rgba(0,0,0,${sh})`);
  st.setProperty('--e5', `0 8px 12px 6px rgba(0,0,0,${sh * 0.5}),0 4px 4px rgba(0,0,0,${sh})`);

  // Typography, density, scale.
  st.setProperty('--ui', fontStack(t.fontFamily));
  st.setProperty('--mono', fontStack('Roboto Mono').includes('Roboto Mono')
    ? "'Roboto Mono',Consolas,'Courier New',monospace" : 'monospace');
  st.setProperty('--font-size', `${Number(t.fontSize) || 14}px`);
  st.setProperty('--font-weight', String(Number(t.fontWeight) || 400));
  st.setProperty('--uiscale', String(Number(t.uiScale) || 1));
  st.setProperty('--den', String(DENSITY_SCALE[String(t.density ?? 0)] ?? 1));

  root.dataset.theme = dark ? 'dark' : 'light';
  root.dataset.density = String(t.density ?? 0);
  root.dataset.rm = t.reduceMotion ? '1' : '0';
  root.style.colorScheme = dark ? 'dark' : 'light';

  bus.emit('theme:applied', { theme: t, dark, scheme });
  return scheme;
}

/* ================================================================== */
/* runtime style sheets (used by the appearance editor)                */
/* ================================================================== */

const sheets = new Map();
/** A managed <style> element; writing to it replaces its whole contents. */
export function styleSheet(id) {
  if (sheets.has(id)) return sheets.get(id);
  const el = document.createElement('style');
  el.id = `sheet-${id}`;
  document.head.appendChild(el);
  const handle = {
    set(cssText) { el.textContent = cssText; },
    clear() { el.textContent = ''; },
    get element() { return el; },
  };
  sheets.set(id, handle);
  return handle;
}

/* ================================================================== */
/* engine                                                             */
/* ================================================================== */

let started = false;

/**
 * Bind the theme to the store. Any write to `theme.*` re-applies tokens
 * immediately (no restart) and queues a persisted config write.
 */
export function startThemeEngine() {
  if (started) return;
  started = true;

  applyTheme(store.get('theme'));

  store.subscribe('theme', (t) => { applyTheme(t); }, { immediate: false });

  // Persist separately from applying, so a live drag of the colour wheel
  // repaints every frame but only writes config once it settles.
  store.subscribe('theme', () => persistCurrent('theme'), { immediate: false });

  if (typeof window !== 'undefined' && window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => { if (store.get('theme.mode') === 'system') applyTheme(store.get('theme')); };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);

    const rmq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onRm = () => { document.documentElement.dataset.osrm = rmq.matches ? '1' : '0'; };
    onRm();
    if (rmq.addEventListener) rmq.addEventListener('change', onRm);
  }
}

/** Convenience mutators used by preferences and the appearance editor. */
export const theme = {
  set(key, value) { store.set(`theme.${key}`, value); },
  get(key) { return store.get(`theme.${key}`); },
  setMode(mode) { this.set('mode', mode); },
  setSeed(hex) { if (rgbFromHex(hex)) this.set('seed', hexFromRgb(rgbFromHex(hex))); },
  setDensity(d) { this.set('density', clampD(Math.round(Number(d)), -3, 0)); },
  setScale(s) { this.set('uiScale', clampD(Number(s) || 1, 0.75, 2)); },
  setFontFamily(f) { this.set('fontFamily', f); },
  setFontSize(px) { this.set('fontSize', clampD(Math.round(Number(px)), 10, 28)); },
  setFontWeight(w) { this.set('fontWeight', clampD(Math.round(Number(w)), 100, 900)); },
  setReduceMotion(v) { this.set('reduceMotion', !!v); },
  setContrast(c) { this.set('contrast', clampD(Number(c) || 0, 0, 1)); },
  reset() {
    store.set('theme', {
      mode: 'system', seed: '#0B57D0', contrast: 0, density: 0, uiScale: 1,
      fontFamily: 'system-ui', fontSize: 14, fontWeight: 400, reduceMotion: false,
      perElement: {}, presets: store.get('theme.presets') || [],
    });
  },
};

/** True when a foreground/background pair clears WCAG AA for body text. */
export function meetsAA(fg, bg, large = false) {
  return contrastHex(fg, bg) >= (large ? 3 : 4.5);
}
