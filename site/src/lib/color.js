// lib/color.js — the site's colour engine: conversion, parsing, contrast, and
// the tonal palette the whole Material 3 scheme is derived from.
//
// Every function here is PURE and DOM-free, because the parts of a colour
// control that can actually be wrong are the arithmetic parts. A picker that
// looks right and emits `hsl(360 0% 0%)` for black is a picker nobody can
// trust, and no screenshot catches that. So the maths lives here and is tested
// headlessly; colorpicker.js only draws it.
//
// WHY OKLab AND NOT HCT. The desktop app derives its scheme with CAM16/HCT
// (design/renderer/theme.js). Reproducing CAM16 here would be ~300 lines of
// duplicated colour appearance modelling in a repository that already has one
// copy, so the site derives its tonal palette in OKLab instead — perceptually
// uniform, an order of magnitude smaller, and needed anyway because the colour
// translator has to speak OKLCH. The consequence is honest and worth stating:
// a given seed can land a shade or two away from what the desktop app produces
// for the same seed. Both are valid Material 3 tonal palettes; they are not
// byte-identical, and nothing here pretends otherwise.

/* ------------------------------------------------------------------ basics */

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const round = (v, n = 0) => {
  const f = 10 ** n;
  return Math.round(v * f) / f;
};
const hex2 = (v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0');

/** sRGB 0..255 → "#rrggbb". Alpha is the caller's business. */
export function hexFromRgb([r, g, b]) { return `#${hex2(r)}${hex2(g)}${hex2(b)}`; }

/**
 * "#abc", "#abcd", "#aabbcc", "#aabbccdd" → { rgb, a }. Returns null rather
 * than throwing, because this parses user keystrokes: a half-typed "#a2" is a
 * normal intermediate state, not an error to shout about.
 */
export function rgbFromHex(hex) {
  const s = String(hex).trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]+$/.test(s)) return null;
  const grow = (c) => parseInt(c + c, 16);
  if (s.length === 3) return { rgb: [grow(s[0]), grow(s[1]), grow(s[2])], a: 1 };
  if (s.length === 4) return { rgb: [grow(s[0]), grow(s[1]), grow(s[2])], a: grow(s[3]) / 255 };
  if (s.length === 6) {
    return { rgb: [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16)), a: 1 };
  }
  if (s.length === 8) {
    return { rgb: [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16)), a: parseInt(s.slice(6, 8), 16) / 255 };
  }
  return null;
}

/* ------------------------------------------------------- sRGB ⇄ linear ⇄ XYZ */

const toLinear = (c) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (v) => {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
  return clamp(c * 255, 0, 255);
};

/** Linear sRGB → CIE XYZ (D65), the hub every non-RGB space routes through. */
function xyzFromLinear([r, g, b]) {
  return [
    0.4124564 * r + 0.3575761 * g + 0.1804375 * b,
    0.2126729 * r + 0.7151522 * g + 0.0721750 * b,
    0.0193339 * r + 0.1191920 * g + 0.9503041 * b,
  ];
}
function linearFromXyz([x, y, z]) {
  return [
    3.2404542 * x - 1.5371385 * y - 0.4985314 * z,
    -0.9692660 * x + 1.8760108 * y + 0.0415560 * z,
    0.0556434 * x - 0.2040259 * y + 1.0572252 * z,
  ];
}

const WHITE = [0.95047, 1.0, 1.08883];

/* ------------------------------------------------------------------- OKLab */

/** sRGB 0..255 → OKLab. Björn Ottosson's matrices, verbatim. */
export function oklabFromRgb([r, g, b]) {
  const R = toLinear(r), G = toLinear(g), B = toLinear(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}

/** OKLab → sRGB 0..255. `inGamut` says whether the answer had to be clipped —
 *  the picker uses it to warn instead of silently lying about the colour. */
export function rgbFromOklab([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
  const inGamut = lin.every((v) => v >= -0.0005 && v <= 1.0005);
  return { rgb: lin.map(fromLinear), inGamut };
}

export function oklchFromRgb(rgb) {
  const [L, a, b] = oklabFromRgb(rgb);
  const C = Math.hypot(a, b);
  let H = (Math.atan2(b, a) * 180) / Math.PI;
  if (H < 0) H += 360;
  return [L, C, C < 1e-6 ? 0 : H];
}
export function rgbFromOklch([L, C, H]) {
  const rad = (H * Math.PI) / 180;
  return rgbFromOklab([L, C * Math.cos(rad), C * Math.sin(rad)]);
}

/* --------------------------------------------------------------- CIELAB/LCH */

const labF = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
const labInvF = (t) => (t ** 3 > 216 / 24389 ? t ** 3 : (116 * t - 16) / (24389 / 27));

export function labFromRgb(rgb) {
  const [x, y, z] = xyzFromLinear(rgb.map(toLinear));
  const fx = labF(x / WHITE[0]), fy = labF(y / WHITE[1]), fz = labF(z / WHITE[2]);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
export function rgbFromLab([L, a, b]) {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const xyz = [labInvF(fx) * WHITE[0], labInvF(fy) * WHITE[1], labInvF(fz) * WHITE[2]];
  const lin = linearFromXyz(xyz);
  const inGamut = lin.every((v) => v >= -0.0005 && v <= 1.0005);
  return { rgb: lin.map(fromLinear), inGamut };
}
export function lchFromRgb(rgb) {
  const [L, a, b] = labFromRgb(rgb);
  const C = Math.hypot(a, b);
  let H = (Math.atan2(b, a) * 180) / Math.PI;
  if (H < 0) H += 360;
  return [L, C, C < 1e-6 ? 0 : H];
}
export function rgbFromLch([L, C, H]) {
  const rad = (H * Math.PI) / 180;
  return rgbFromLab([L, C * Math.cos(rad), C * Math.sin(rad)]);
}

/* ------------------------------------------------------- HSL / HSV / HWB / CMYK */

export function hslFromRgb([r, g, b]) {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B);
  const l = (max + min) / 2;
  const d = max - min;
  if (!d) return [0, 0, l * 100];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h;
  if (max === R) h = ((G - B) / d) % 6;
  else if (max === G) h = (B - R) / d + 2;
  else h = (R - G) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return [h, s * 100, l * 100];
}
export function rgbFromHsl([h, s, l]) {
  const H = ((h % 360) + 360) % 360, S = clamp(s, 0, 100) / 100, L = clamp(l, 0, 100) / 100;
  const c = (1 - Math.abs(2 * L - 1)) * S;
  const x = c * (1 - Math.abs(((H / 60) % 2) - 1));
  const m = L - c / 2;
  const t = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.floor(H / 60) % 6];
  return t.map((v) => (v + m) * 255);
}

export function hsvFromRgb([r, g, b]) {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B), d = max - min;
  let h = 0;
  if (d) {
    if (max === R) h = (((G - B) / d) % 6) * 60;
    else if (max === G) h = ((B - R) / d + 2) * 60;
    else h = ((R - G) / d + 4) * 60;
    if (h < 0) h += 360;
  }
  return [h, max ? (d / max) * 100 : 0, max * 100];
}
export function rgbFromHsv([h, s, v]) {
  const S = clamp(s, 0, 100) / 100, V = clamp(v, 0, 100) / 100;
  const L = V * (1 - S / 2);
  const sl = L === 0 || L === 1 ? 0 : ((V - L) / Math.min(L, 1 - L)) * 100;
  return rgbFromHsl([h, sl, L * 100]);
}

export function hwbFromRgb([r, g, b]) {
  const [h] = hsvFromRgb([r, g, b]);
  const w = Math.min(r, g, b) / 255, bl = 1 - Math.max(r, g, b) / 255;
  return [h, w * 100, bl * 100];
}
export function rgbFromHwb([h, w, bl]) {
  let W = clamp(w, 0, 100) / 100, BL = clamp(bl, 0, 100) / 100;
  if (W + BL >= 1) { const g = (W / (W + BL)) * 255; return [g, g, g]; }
  return rgbFromHsl([h, 100, 50]).map((c) => (c / 255) * (1 - W - BL) * 255 + W * 255);
}

export function cmykFromRgb([r, g, b]) {
  const R = r / 255, G = g / 255, B = b / 255;
  const k = 1 - Math.max(R, G, B);
  if (k === 1) return [0, 0, 0, 100];
  return [((1 - R - k) / (1 - k)) * 100, ((1 - G - k) / (1 - k)) * 100, ((1 - B - k) / (1 - k)) * 100, k * 100];
}
export function rgbFromCmyk([c, m, y, k]) {
  const C = clamp(c, 0, 100) / 100, M = clamp(m, 0, 100) / 100;
  const Y = clamp(y, 0, 100) / 100, K = clamp(k, 0, 100) / 100;
  return [255 * (1 - C) * (1 - K), 255 * (1 - M) * (1 - K), 255 * (1 - Y) * (1 - K)];
}

/* -------------------------------------------------------------- named colours */

/** The CSS named colours, so "Named" is a real notation and not a stub. A
 *  colour that has no name simply reports that it has none. */
export const NAMED = {
  aliceblue: 'f0f8ff', antiquewhite: 'faebd7', aqua: '00ffff', aquamarine: '7fffd4',
  azure: 'f0ffff', beige: 'f5f5dc', bisque: 'ffe4c4', black: '000000',
  blanchedalmond: 'ffebcd', blue: '0000ff', blueviolet: '8a2be2', brown: 'a52a2a',
  burlywood: 'deb887', cadetblue: '5f9ea0', chartreuse: '7fff00', chocolate: 'd2691e',
  coral: 'ff7f50', cornflowerblue: '6495ed', cornsilk: 'fff8dc', crimson: 'dc143c',
  cyan: '00ffff', darkblue: '00008b', darkcyan: '008b8b', darkgoldenrod: 'b8860b',
  darkgray: 'a9a9a9', darkgreen: '006400', darkgrey: 'a9a9a9', darkkhaki: 'bdb76b',
  darkmagenta: '8b008b', darkolivegreen: '556b2f', darkorange: 'ff8c00', darkorchid: '9932cc',
  darkred: '8b0000', darksalmon: 'e9967a', darkseagreen: '8fbc8f', darkslateblue: '483d8b',
  darkslategray: '2f4f4f', darkslategrey: '2f4f4f', darkturquoise: '00ced1', darkviolet: '9400d3',
  deeppink: 'ff1493', deepskyblue: '00bfff', dimgray: '696969', dimgrey: '696969',
  dodgerblue: '1e90ff', firebrick: 'b22222', floralwhite: 'fffaf0', forestgreen: '228b22',
  fuchsia: 'ff00ff', gainsboro: 'dcdcdc', ghostwhite: 'f8f8ff', gold: 'ffd700',
  goldenrod: 'daa520', gray: '808080', green: '008000', greenyellow: 'adff2f',
  grey: '808080', honeydew: 'f0fff0', hotpink: 'ff69b4', indianred: 'cd5c5c',
  indigo: '4b0082', ivory: 'fffff0', khaki: 'f0e68c', lavender: 'e6e6fa',
  lavenderblush: 'fff0f5', lawngreen: '7cfc00', lemonchiffon: 'fffacd', lightblue: 'add8e6',
  lightcoral: 'f08080', lightcyan: 'e0ffff', lightgoldenrodyellow: 'fafad2', lightgray: 'd3d3d3',
  lightgreen: '90ee90', lightgrey: 'd3d3d3', lightpink: 'ffb6c1', lightsalmon: 'ffa07a',
  lightseagreen: '20b2aa', lightskyblue: '87cefa', lightslategray: '778899', lightslategrey: '778899',
  lightsteelblue: 'b0c4de', lightyellow: 'ffffe0', lime: '00ff00', limegreen: '32cd32',
  linen: 'faf0e6', magenta: 'ff00ff', maroon: '800000', mediumaquamarine: '66cdaa',
  mediumblue: '0000cd', mediumorchid: 'ba55d3', mediumpurple: '9370db', mediumseagreen: '3cb371',
  mediumslateblue: '7b68ee', mediumspringgreen: '00fa9a', mediumturquoise: '48d1cc', mediumvioletred: 'c71585',
  midnightblue: '191970', mintcream: 'f5fffa', mistyrose: 'ffe4e1', moccasin: 'ffe4b5',
  navajowhite: 'ffdead', navy: '000080', oldlace: 'fdf5e6', olive: '808000',
  olivedrab: '6b8e23', orange: 'ffa500', orangered: 'ff4500', orchid: 'da70d6',
  palegoldenrod: 'eee8aa', palegreen: '98fb98', paleturquoise: 'afeeee', palevioletred: 'db7093',
  papayawhip: 'ffefd5', peachpuff: 'ffdab9', peru: 'cd853f', pink: 'ffc0cb',
  plum: 'dda0dd', powderblue: 'b0e0e6', purple: '800080', rebeccapurple: '663399',
  red: 'ff0000', rosybrown: 'bc8f8f', royalblue: '4169e1', saddlebrown: '8b4513',
  salmon: 'fa8072', sandybrown: 'f4a460', seagreen: '2e8b57', seashell: 'fff5ee',
  sienna: 'a0522d', silver: 'c0c0c0', skyblue: '87ceeb', slateblue: '6a5acd',
  slategray: '708090', slategrey: '708090', snow: 'fffafa', springgreen: '00ff7f',
  steelblue: '4682b4', tan: 'd2b48c', teal: '008080', thistle: 'd8bfd8',
  tomato: 'ff6347', turquoise: '40e0d0', violet: 'ee82ee', wheat: 'f5deb3',
  white: 'ffffff', whitesmoke: 'f5f5f5', yellow: 'ffff00', yellowgreen: '9acd32',
};

/** Reverse lookup. Several names share a value (gray/grey, aqua/cyan); the
 *  first spelling in the table above wins so the answer is stable. */
const BY_HEX = (() => {
  const m = new Map();
  for (const [name, hex] of Object.entries(NAMED)) if (!m.has(hex)) m.set(hex, name);
  return m;
})();
export function nameOf(rgb) { return BY_HEX.get(hexFromRgb(rgb).slice(1)) || null; }

/* ----------------------------------------------------------------- parsing */

const nums = (s) => (s.match(/-?\d*\.?\d+%?/g) || []);
const pct = (tok, full) => (String(tok).endsWith('%') ? (parseFloat(tok) / 100) * full : parseFloat(tok));
const alphaOf = (tok) => (tok === undefined ? 1 : clamp(String(tok).endsWith('%') ? parseFloat(tok) / 100 : parseFloat(tok), 0, 1));

/**
 * The inverse half of the translator: every representation the picker emits
 * must read back as the same colour, with its alpha intact. Returns
 * { rgb, a, notation } or null.
 *
 * Deliberately liberal about separators — `rgb(1,2,3)`, `rgb(1 2 3)` and
 * `rgb(1 2 3 / 50%)` are all the same colour, and a user pasting from a design
 * tool should not have to know which dialect it wrote.
 */
export function parseAnyColor(input) {
  if (input == null) return null;
  const s = String(input).trim();
  if (!s) return null;

  const lower = s.toLowerCase();
  if (lower === 'transparent') return { rgb: [0, 0, 0], a: 0, notation: 'Named' };
  if (Object.prototype.hasOwnProperty.call(NAMED, lower)) {
    return { rgb: rgbFromHex(NAMED[lower]).rgb, a: 1, notation: 'Named' };
  }
  if (/^#?[0-9a-fA-F]{3,8}$/.test(s) && (s.startsWith('#') || /^[0-9a-fA-F]{6}$/.test(s))) {
    const h = rgbFromHex(s);
    if (h) return { ...h, notation: 'HEX' };
  }

  const fn = lower.match(/^([a-z]+)\s*\(([^)]*)\)$/);
  if (!fn) return null;
  const [, name, bodyRaw] = fn;
  const body = bodyRaw.replace(/\//g, ' / ');
  const parts = body.split('/');
  const t = nums(parts[0]);
  const a = parts[1] !== undefined ? alphaOf(nums(parts[1])[0]) : (t.length > (name === 'cmyk' ? 4 : 3) ? alphaOf(t[name === 'cmyk' ? 4 : 3]) : 1);
  const N = (i, full = 100) => pct(t[i], full);

  switch (name) {
    case 'rgb': case 'rgba':
      if (t.length < 3) return null;
      return { rgb: [pct(t[0], 255), pct(t[1], 255), pct(t[2], 255)].map((v) => clamp(v, 0, 255)), a, notation: 'RGB' };
    case 'hsl': case 'hsla':
      if (t.length < 3) return null;
      return { rgb: rgbFromHsl([parseFloat(t[0]), N(1), N(2)]), a, notation: 'HSL' };
    case 'hsv': case 'hsb':
      if (t.length < 3) return null;
      return { rgb: rgbFromHsv([parseFloat(t[0]), N(1), N(2)]), a, notation: 'HSV/HSB' };
    case 'hwb':
      if (t.length < 3) return null;
      return { rgb: rgbFromHwb([parseFloat(t[0]), N(1), N(2)]), a, notation: 'HWB' };
    case 'lab':
      if (t.length < 3) return null;
      return { rgb: rgbFromLab([N(0), parseFloat(t[1]), parseFloat(t[2])]).rgb, a, notation: 'CIELAB' };
    case 'lch':
      if (t.length < 3) return null;
      return { rgb: rgbFromLch([N(0), parseFloat(t[1]), parseFloat(t[2])]).rgb, a, notation: 'CIELCH' };
    case 'oklab':
      if (t.length < 3) return null;
      return { rgb: rgbFromOklab([pct(t[0], 1), parseFloat(t[1]), parseFloat(t[2])]).rgb, a, notation: 'OKLab' };
    case 'oklch':
      if (t.length < 3) return null;
      return { rgb: rgbFromOklch([pct(t[0], 1), pct(t[1], 0.4), parseFloat(t[2])]).rgb, a, notation: 'OKLCH' };
    case 'cmyk': case 'device-cmyk':
      if (t.length < 4) return null;
      return { rgb: rgbFromCmyk([N(0), N(1), N(2), N(3)]), a, notation: 'CMYK' };
    default:
      return null;
  }
}

/** Notations that cannot carry alpha. The picker says so rather than dropping
 *  the value silently — "never let a customization surface silently drop a
 *  value it cannot represent". */
export const ALPHA_FREE = new Set(['Named', 'HEX', 'HSV/HSB', 'CMYK', 'CIELAB', 'CIELCH', 'OKLab']);

export const NOTATIONS = [
  'Named', 'HEX', 'HEX8', 'RGB', 'RGBA', 'HSL', 'HSLA',
  'HSV/HSB', 'HWB', 'CIELAB', 'CIELCH', 'OKLab', 'OKLCH', 'CMYK',
];

/** Render one colour in one notation. The strings this returns are exactly the
 *  strings parseAnyColor() must read back — that round trip is a test. */
export function formatColor(rgb, a, notation) {
  const A = clamp(a ?? 1, 0, 1);
  switch (notation) {
    case 'Named': {
      if (A === 0) return 'transparent';
      const n = nameOf(rgb);
      return n || '(no CSS name)';
    }
    case 'HEX': return hexFromRgb(rgb);
    case 'HEX8': return `${hexFromRgb(rgb)}${hex2(A * 255)}`;
    case 'RGB': return `rgb(${rgb.map((v) => Math.round(v)).join(' ')})`;
    case 'RGBA': return `rgb(${rgb.map((v) => Math.round(v)).join(' ')} / ${round(A, 3)})`;
    case 'HSL': { const [h, s, l] = hslFromRgb(rgb); return `hsl(${round(h, 1)} ${round(s, 1)}% ${round(l, 1)}%)`; }
    case 'HSLA': { const [h, s, l] = hslFromRgb(rgb); return `hsl(${round(h, 1)} ${round(s, 1)}% ${round(l, 1)}% / ${round(A, 3)})`; }
    case 'HSV/HSB': { const [h, s, v] = hsvFromRgb(rgb); return `hsv(${round(h, 1)} ${round(s, 1)}% ${round(v, 1)}%)`; }
    case 'HWB': { const [h, w, b] = hwbFromRgb(rgb); return `hwb(${round(h, 1)} ${round(w, 1)}% ${round(b, 1)}%)`; }
    case 'CIELAB': { const [L, x, y] = labFromRgb(rgb); return `lab(${round(L, 2)}% ${round(x, 2)} ${round(y, 2)})`; }
    case 'CIELCH': { const [L, C, H] = lchFromRgb(rgb); return `lch(${round(L, 2)}% ${round(C, 2)} ${round(H, 2)})`; }
    case 'OKLab': { const [L, x, y] = oklabFromRgb(rgb); return `oklab(${round(L * 100, 2)}% ${round(x, 4)} ${round(y, 4)})`; }
    case 'OKLCH': { const [L, C, H] = oklchFromRgb(rgb); return `oklch(${round(L * 100, 2)}% ${round(C, 4)} ${round(H, 2)})`; }
    case 'CMYK': { const c = cmykFromRgb(rgb); return `cmyk(${c.map((v) => `${round(v, 1)}%`).join(' ')})`; }
    default: return hexFromRgb(rgb);
  }
}

/** Every notation at once, for the translator panel. */
export function translate(rgb, a) {
  return NOTATIONS.map((n) => ({
    notation: n,
    value: formatColor(rgb, a, n),
    losesAlpha: ALPHA_FREE.has(n) && (a ?? 1) < 1,
  }));
}

/* ---------------------------------------------------------------- contrast */

export function relativeLuminance([r, g, b]) {
  const [R, G, B] = [r, g, b].map(toLinear);
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}
/** WCAG 2.1 contrast ratio, 1..21. */
export function contrast(a, b) {
  const la = relativeLuminance(a), lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
export function contrastHex(a, b) {
  const A = rgbFromHex(a), B = rgbFromHex(b);
  return A && B ? contrast(A.rgb, B.rgb) : 1;
}
export const meetsAA = (ratio, large = false) => ratio >= (large ? 3 : 4.5);
export const meetsAAA = (ratio, large = false) => ratio >= (large ? 4.5 : 7);

/* -------------------------------------------------------- tonal palettes */

/**
 * The OKLab lightness of the neutral grey whose CIE L* is `tone`.
 *
 * Material's tones are L* values, and OKLab's L is not L*. Mapping one onto
 * the other by eye is how a "tone 90" container ends up visibly darker than a
 * "tone 90" surface; going through the actual grey keeps the two scales
 * anchored to the same perceptual ladder.
 */
export function oklabLForTone(tone) {
  const y = 100 * labInvF((clamp(tone, 0, 100) + 16) / 116) / 100;
  const c = fromLinear(y);
  return oklabFromRgb([c, c, c])[0];
}

/** One tone of one palette, gamut-mapped by walking chroma down until sRGB can
 *  hold it. Clipping instead would shift the hue, which is exactly the bug
 *  that makes a generated dark theme look muddy. */
export function toneHex(hue, chroma, tone) {
  const L = oklabLForTone(tone);
  let c = chroma;
  for (let i = 0; i < 24; i++) {
    const r = rgbFromOklch([L, c, hue]);
    if (r.inGamut || c <= 0.0005) return hexFromRgb(r.rgb);
    c *= 0.85;
  }
  return hexFromRgb(rgbFromOklch([L, 0, hue]).rgb);
}

/** The five Material 3 key palettes, derived from one seed. Chroma values are
 *  OKLCH chroma (0…~0.37), chosen to sit where M3's HCT chromas land. */
export function tonalPalettes(seedHex) {
  const parsed = rgbFromHex(seedHex) || rgbFromHex('#0b57d0');
  const [, C, H] = oklchFromRgb(parsed.rgb);
  const primaryC = clamp(C, 0.09, 0.16);
  return {
    primary: { hue: H, chroma: primaryC },
    secondary: { hue: H, chroma: primaryC * 0.36 },
    tertiary: { hue: (H + 60) % 360, chroma: primaryC * 0.55 },
    neutral: { hue: H, chroma: 0.005 },
    neutralVariant: { hue: H, chroma: 0.013 },
    error: { hue: 27, chroma: 0.16 },
  };
}

/** role → [lightTone, darkTone]. Material 3's own assignments. */
const ROLE_TONES = {
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
  surface: ['neutral', 98, 6],
  onSurface: ['neutral', 10, 90],
  surfaceVariant: ['neutralVariant', 90, 30],
  onSurfaceVariant: ['neutralVariant', 30, 80],
  surfaceContainerLowest: ['neutral', 100, 4],
  surfaceContainerLow: ['neutral', 96, 10],
  surfaceContainer: ['neutral', 94, 12],
  surfaceContainerHigh: ['neutral', 92, 17],
  surfaceContainerHighest: ['neutral', 90, 22],
  outline: ['neutralVariant', 50, 60],
  outlineVariant: ['neutralVariant', 80, 30],
  inverseSurface: ['neutral', 20, 90],
  inverseOnSurface: ['neutral', 95, 20],
  surfaceTint: ['primary', 40, 80],
};

/**
 * A complete Material 3 scheme from one seed.
 *
 * `contrastBoost` (0…1) pushes every on-* role away from its background — the
 * accessibility control, not a decorative one, so it is part of the scheme
 * rather than a filter applied afterwards.
 */
export function buildScheme(seedHex, dark = false, contrastBoost = 0) {
  const pals = tonalPalettes(seedHex);
  const out = {};
  for (const [role, [pal, lightTone, darkTone]] of Object.entries(ROLE_TONES)) {
    let tone = dark ? darkTone : lightTone;
    if (contrastBoost > 0 && /^on[A-Z]/.test(role)) {
      // Move the foreground tone toward the end of the ladder it is already on.
      tone = tone > 50 ? Math.min(100, tone + 10 * contrastBoost) : Math.max(0, tone - 10 * contrastBoost);
    }
    out[role] = toneHex(pals[pal].hue, pals[pal].chroma, tone);
  }
  return out;
}

/** `--md-sys-color-on-surface-variant` from `onSurfaceVariant`. */
export const cssVarName = (role) => `--md-sys-color-${role.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()}`;
