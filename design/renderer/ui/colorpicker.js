// ui/colorpicker.js — the infinite colour picker and colour translator.
//
// "Infinite" is the requirement and the design: a continuous 2-D saturation /
// value field plus a continuous hue rail and alpha rail, backed by numeric
// entry in every supported space. Swatches, recents and the eyedropper sit on
// top as conveniences; none of them replaces the continuous field, and no path
// through this component limits the user to a fixed palette.
//
// The translator converts BIDIRECTIONALLY among: named CSS colours, HEX/HEX8,
// RGB/RGBA, HSL/HSLA, HSV/HSB, HWB, CIELAB, LCH, OKLab, OKLCH and CMYK.
// Forward conversion reuses design/winscp-data.js; the inverse transforms live
// here because the mockup never needed them.
//
// It names the active colour space, warns BEFORE clipping when a value the
// user typed (Lab, LCH, OKLab, OKLCH, CMYK) is outside the sRGB gamut, keeps
// alpha through every conversion, shows an accessible contrast readout against
// the surface the colour will actually sit on, and lets the user copy any
// representation.

import {
  translateColor, parseColor, hexToRgb, rgbToHex, rgbToHsl, hslToRgb, rgbToHsv,
  hsvToRgb, rgbToHwb, rgbToCmyk, rgbToXyz, xyzToLab, labToLch, rgbToOklab,
  NAMED_COLORS, nearestNamed,
} from '../../winscp-data.js';
import { h, icon, layer, anchorTo, trapFocus, focusMemory, announce, copyText, clamp, uid, appearanceTarget } from '../dom.js';
import { t } from '../i18n.js';
import { store, persistCurrent } from '../state.js';
import { contrastHex, currentScheme } from '../theme.js';

/* ------------------------------------------------------------------ */
/* inverse colour maths (the forward direction is in winscp-data.js)   */
/* ------------------------------------------------------------------ */

const D65 = [95.047, 100, 108.883];
const clamp255 = (v) => clamp(Math.round(v), 0, 255);

function delin(v) { // linear 0..1 -> sRGB 0..255
  return v <= 0.0031308 ? v * 12.92 * 255 : (1.055 * v ** (1 / 2.4) - 0.055) * 255;
}

/** XYZ (0..100) -> {r,g,b} 0..255 plus an in-gamut flag before clipping. */
export function xyzToRgb(x, y, z) {
  const X = x / 100, Y = y / 100, Z = z / 100;
  const lr = 3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z;
  const lg = -0.9692660 * X + 1.8760108 * Y + 0.0415560 * Z;
  const lb = 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z;
  const inGamut = [lr, lg, lb].every((v) => v >= -0.0005 && v <= 1.0005);
  return { r: clamp255(delin(clamp(lr, 0, 1))), g: clamp255(delin(clamp(lg, 0, 1))), b: clamp255(delin(clamp(lb, 0, 1))), inGamut };
}

export function labToXyz(L, a, b) {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const inv = (f) => (f ** 3 > 0.008856 ? f ** 3 : (f - 16 / 116) / 7.787);
  return { x: inv(fx) * D65[0], y: inv(fy) * D65[1], z: inv(fz) * D65[2] };
}
export function lchToLab(L, C, H) {
  const r = (H * Math.PI) / 180;
  return { L, a: C * Math.cos(r), b: C * Math.sin(r) };
}
export function oklabToRgb(L, a, b) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  const lr = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const lb = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
  const inGamut = [lr, lg, lb].every((v) => v >= -0.0005 && v <= 1.0005);
  return { r: clamp255(delin(clamp(lr, 0, 1))), g: clamp255(delin(clamp(lg, 0, 1))), b: clamp255(delin(clamp(lb, 0, 1))), inGamut };
}
export function hwbToRgb(hue, w, bl) {
  let W = w / 100, B = bl / 100;
  if (W + B >= 1) { const g = clamp255((W / (W + B)) * 255); return { r: g, g, b: g, inGamut: true }; }
  const c = hsvToRgb(hue, 100 * (1 - W / (1 - B)), 100 * (1 - B));
  return { r: clamp255(c.r), g: clamp255(c.g), b: clamp255(c.b), inGamut: true };
}
export function cmykToRgb(c, m, y, k) {
  const C = c / 100, M = m / 100, Y = y / 100, K = k / 100;
  return {
    r: clamp255(255 * (1 - C) * (1 - K)),
    g: clamp255(255 * (1 - M) * (1 - K)),
    b: clamp255(255 * (1 - Y) * (1 - K)),
    inGamut: true,
  };
}

const num = (s) => { const v = parseFloat(s); return Number.isFinite(v) ? v : 0; };
function args(str) {
  // A truncated notation ('rgb(', 'rgba(1,2') has no closing paren, so
  // lastIndexOf returns -1 and the slice silently produces garbage that
  // clamp255 then passes through as NaN — because every NaN comparison is
  // false. A colour of NaN is worse than no colour: the picker would write it
  // into a style value. Refuse it here instead.
  const close = str.lastIndexOf(')');
  if (str.indexOf('(') < 0 || close < 0) return null;
  const inside = str.slice(str.indexOf('(') + 1, close);
  const [main, alphaPart] = inside.split('/');
  const parts = main.trim().split(/[\s,]+/).filter(Boolean).map((v) => num(v.replace('%', '')));
  let alpha = 1;
  if (alphaPart != null) {
    const a = alphaPart.trim();
    alpha = a.endsWith('%') ? num(a) / 100 : num(a);
  } else if (parts.length > 3 && !/^(lab|lch|oklab|oklch|cmyk)\(/.test(str)) {
    alpha = parts[3] > 1 ? parts[3] / 100 : parts[3];
  }
  if (!parts.length || parts.some((v) => !Number.isFinite(v))) return null;
  return { parts, alpha: clamp(alpha, 0, 1) };
}

/**
 * Parse ANY representation the translator emits back into rgba plus the space
 * it came from and whether it needed gamut clipping.
 * Returns { r,g,b,a, space, inGamut } or null.
 */
/**
 * The notations that cannot express transparency at all. Copying one of these
 * while alpha is below 1 loses it; the translator says so rather than handing
 * the user a value that quietly differs from the colour on screen.
 */
export const ALPHA_FREE_NOTATIONS = new Set(['Named', 'HEX', 'HSV/HSB', 'CMYK']);

function alphaLossNote() { return 'this notation cannot carry transparency, so the alpha channel is dropped'; }

export function parseAnyColor(input) {
  const s = String(input || '').trim().toLowerCase();
  if (!s) return null;
  if (NAMED_COLORS[s]) { const c = hexToRgb(NAMED_COLORS[s]); return { ...c, a: 1, space: 'Named', inGamut: true }; }
  if (s.startsWith('#')) { const c = hexToRgb(s); return c ? { ...c, space: s.replace('#', '').length > 6 ? 'HEX8' : 'HEX', inGamut: true } : null; }
  if (/^rgba?\(/.test(s)) { const a_ = args(s); if (!a_) return null; const { parts, alpha } = a_; return { r: clamp255(parts[0]), g: clamp255(parts[1]), b: clamp255(parts[2]), a: alpha, space: 'RGB', inGamut: true }; }
  if (/^hsla?\(/.test(s)) { const a_ = args(s); if (!a_) return null; const { parts, alpha } = a_; const c = hslToRgb(parts[0], parts[1], parts[2]); return { r: clamp255(c.r), g: clamp255(c.g), b: clamp255(c.b), a: alpha, space: 'HSL', inGamut: true }; }
  if (/^hs[vb]\(/.test(s)) { const a_ = args(s); if (!a_) return null; const { parts, alpha } = a_; const c = hsvToRgb(parts[0], parts[1], parts[2]); return { r: clamp255(c.r), g: clamp255(c.g), b: clamp255(c.b), a: alpha, space: 'HSV/HSB', inGamut: true }; }
  if (/^hwb\(/.test(s)) { const a_ = args(s); if (!a_) return null; const { parts, alpha } = a_; const c = hwbToRgb(parts[0], parts[1], parts[2]); return { ...c, a: alpha, space: 'HWB' }; }
  if (/^lab\(/.test(s)) { const a_ = args(s); if (!a_) return null; const { parts, alpha } = a_; const xyz = labToXyz(parts[0], parts[1], parts[2]); const c = xyzToRgb(xyz.x, xyz.y, xyz.z); return { ...c, a: alpha, space: 'CIELAB' }; }
  if (/^lch\(/.test(s)) { const a_ = args(s); if (!a_) return null; const { parts, alpha } = a_; const lab = lchToLab(parts[0], parts[1], parts[2]); const xyz = labToXyz(lab.L, lab.a, lab.b); const c = xyzToRgb(xyz.x, xyz.y, xyz.z); return { ...c, a: alpha, space: 'LCH' }; }
  if (/^oklab\(/.test(s)) { const a_ = args(s); if (!a_) return null; const { parts, alpha } = a_; const c = oklabToRgb(parts[0], parts[1], parts[2]); return { ...c, a: alpha, space: 'OKLab' }; }
  if (/^oklch\(/.test(s)) { const a_ = args(s); if (!a_) return null; const { parts, alpha } = a_; const lab = lchToLab(parts[0], parts[1], parts[2]); const c = oklabToRgb(lab.L, lab.a, lab.b); return { ...c, a: alpha, space: 'OKLCH' }; }
  if (/^cmyk\(/.test(s)) { const a_ = args(s); if (!a_) return null; const { parts } = a_; const c = cmykToRgb(parts[0], parts[1], parts[2], parts[3]); return { ...c, a: 1, space: 'CMYK' }; }
  const legacy = parseColor(s);
  return legacy ? { ...legacy, a: legacy.a ?? 1, space: 'CSS', inGamut: true } : null;
}

/* ------------------------------------------------------------------ */
/* the picker                                                          */
/* ------------------------------------------------------------------ */

const RECENT_MAX = 18;

function readRecent() { return (store.get('theme.recentColors') || []).slice(0, RECENT_MAX); }
function pushRecent(hex8) {
  const list = readRecent().filter((c) => c.toLowerCase() !== hex8.toLowerCase());
  list.unshift(hex8);
  store.set('theme.recentColors', list.slice(0, RECENT_MAX));
  persistCurrent('theme');
}

/**
 * createColorPicker(opts) -> { element, getValue, setValue, destroy }
 *
 * opts:
 *   value            initial colour, any representation (default #0B57D0)
 *   alpha            allow alpha (default true)
 *   onChange(hex8)   live, on every drag frame
 *   contrastAgainst  hex the colour will sit on, for the readout
 *                    (defaults to the current surface role)
 *   swatches         optional convenience swatch list
 */
export function createColorPicker(opts = {}) {
  const allowAlpha = opts.alpha !== false;
  const start = parseAnyColor(opts.value) || { r: 11, g: 87, b: 208, a: 1 };
  let hsv = rgbToHsv(start.r, start.g, start.b);
  let alpha = allowAlpha ? (start.a ?? 1) : 1;

  const ids = { field: uid('cp-field'), hue: uid('cp-hue'), alpha: uid('cp-alpha') };

  const field = h('div', {
    class: 'cp-field', id: ids.field, role: 'application', tabindex: '0',
    'aria-label': 'Saturation and brightness field. Arrow keys adjust, Shift for larger steps.',
  }, h('div', { class: 'cp-field-white' }), h('div', { class: 'cp-field-black' }), h('div', { class: 'cp-thumb' }));
  const fieldThumb = field.querySelector('.cp-thumb');

  const hueRail = h('div', {
    class: 'cp-rail cp-hue', id: ids.hue, role: 'slider', tabindex: '0',
    'aria-label': 'Hue', 'aria-valuemin': '0', 'aria-valuemax': '360',
  }, h('div', { class: 'cp-thumb' }));
  const hueThumb = hueRail.querySelector('.cp-thumb');

  const alphaRail = h('div', {
    class: 'cp-rail cp-alpha', id: ids.alpha, role: 'slider', tabindex: '0',
    'aria-label': 'Alpha', 'aria-valuemin': '0', 'aria-valuemax': '100',
  }, h('div', { class: 'cp-alpha-fill' }), h('div', { class: 'cp-thumb' }));
  const alphaThumb = alphaRail.querySelector('.cp-thumb');
  const alphaFill = alphaRail.querySelector('.cp-alpha-fill');

  const preview = h('div', { class: 'cp-preview', 'aria-hidden': 'true' }, h('div', { class: 'cp-preview-fill' }));
  const previewFill = preview.querySelector('.cp-preview-fill');

  const spaceLabel = h('div', { class: 'cp-space' });
  const gamutWarn = h('div', { class: 'cp-gamut', role: 'status', hidden: true });
  const contrastEl = h('div', { class: 'cp-contrast' });

  const hexInput = h('input', { type: 'text', class: 'cp-hex mono', spellcheck: 'false', 'aria-label': 'Colour value (any supported notation)' });

  const rgbInputs = ['r', 'g', 'b'].map((ch) => h('input', {
    type: 'number', min: '0', max: '255', step: '1', class: 'cp-num', 'aria-label': `${ch.toUpperCase()} 0-255`,
  }));
  const alphaInput = h('input', { type: 'number', min: '0', max: '100', step: '1', class: 'cp-num', 'aria-label': 'Alpha percent' });

  const translatorEl = h('div', { class: 'cp-translator' });
  const recentEl = h('div', { class: 'cp-recent', role: 'group', 'aria-label': 'Recent colours' });
  const swatchEl = h('div', { class: 'cp-swatches', role: 'group', 'aria-label': 'Swatches' });

  const eyedropperBtn = h('button', {
    type: 'button', class: 'btn-text', title: 'Pick a colour from the screen',
    onclick: pickWithEyedropper,
  }, icon('colorize', 16), 'Eyedropper');
  if (typeof window === 'undefined' || typeof window.EyeDropper !== 'function') {
    eyedropperBtn.disabled = true;
    eyedropperBtn.title = 'The eyedropper is not available in this window. Use the field or type a value.';
  }

  const root = h('div', { class: 'cp' },
    h('div', { class: 'cp-top' },
      field,
      h('div', { class: 'cp-rails' }, hueRail, allowAlpha ? alphaRail : null)),
    h('div', { class: 'cp-row' },
      preview,
      h('div', { class: 'cp-entry' },
        hexInput,
        h('div', { class: 'cp-nums' },
          h('label', { class: 'cp-numlab' }, 'R', rgbInputs[0]),
          h('label', { class: 'cp-numlab' }, 'G', rgbInputs[1]),
          h('label', { class: 'cp-numlab' }, 'B', rgbInputs[2]),
          allowAlpha ? h('label', { class: 'cp-numlab' }, 'A%', alphaInput) : null))),
    spaceLabel, gamutWarn, contrastEl,
    h('div', { class: 'cp-section' }, 'Translate — every representation is editable'),
    translatorEl,
    h('div', { class: 'cp-section' }, 'Recent'),
    recentEl,
    opts.swatches ? h('div', { class: 'cp-section' }, 'Swatches') : null,
    opts.swatches ? swatchEl : null,
    h('div', { class: 'cp-tools' }, eyedropperBtn));

  appearanceTarget(root, 'color-picker', 'Colour picker');

  /* ---------- rendering ---------- */

  function rgb() { const c = hsvToRgb(hsv.h, hsv.s, hsv.v); return { r: clamp255(c.r), g: clamp255(c.g), b: clamp255(c.b) }; }
  function hex6() { const c = rgb(); return rgbToHex(c.r, c.g, c.b); }
  function hex8() {
    const c = rgb();
    const a = Math.round(clamp(alpha, 0, 1) * 255).toString(16).padStart(2, '0');
    return `${rgbToHex(c.r, c.g, c.b)}${allowAlpha && alpha < 1 ? a : ''}`;
  }
  function cssValue() {
    const c = rgb();
    return allowAlpha && alpha < 1 ? `rgba(${c.r}, ${c.g}, ${c.b}, ${Math.round(alpha * 100) / 100})` : rgbToHex(c.r, c.g, c.b);
  }

  function backdropHex() {
    if (opts.contrastAgainst) return opts.contrastAgainst;
    const scheme = currentScheme();
    return scheme?.surface || '#ffffff';
  }

  let suppressInputs = false;

  function paint(source) {
    const c = rgb();
    const pure = hsvToRgb(hsv.h, 100, 100);
    field.style.background = rgbToHex(clamp255(pure.r), clamp255(pure.g), clamp255(pure.b));
    fieldThumb.style.left = `${hsv.s}%`;
    fieldThumb.style.top = `${100 - hsv.v}%`;
    fieldThumb.style.background = rgbToHex(c.r, c.g, c.b);
    hueThumb.style.left = `${(hsv.h / 360) * 100}%`;
    hueThumb.style.background = rgbToHex(clamp255(pure.r), clamp255(pure.g), clamp255(pure.b));
    hueRail.setAttribute('aria-valuenow', String(Math.round(hsv.h)));
    hueRail.setAttribute('aria-valuetext', `${Math.round(hsv.h)} degrees`);
    if (allowAlpha) {
      alphaThumb.style.left = `${alpha * 100}%`;
      alphaFill.style.background = `linear-gradient(90deg, transparent, ${rgbToHex(c.r, c.g, c.b)})`;
      alphaRail.setAttribute('aria-valuenow', String(Math.round(alpha * 100)));
      alphaRail.setAttribute('aria-valuetext', `${Math.round(alpha * 100)} percent opaque`);
    }
    previewFill.style.background = cssValue();

    if (!suppressInputs) {
      if (source !== 'hex') hexInput.value = hex8();
      if (source !== 'rgb') { rgbInputs[0].value = c.r; rgbInputs[1].value = c.g; rgbInputs[2].value = c.b; }
      if (allowAlpha && source !== 'alpha') alphaInput.value = Math.round(alpha * 100);
    }

    const named = nearestNamed(c.r, c.g, c.b);
    spaceLabel.textContent = `sRGB · ${named.exact ? named.name : `nearest named: ${named.name}`}${allowAlpha && alpha < 1 ? ` · ${Math.round(alpha * 100)}% opaque` : ''}`;

    const bg = backdropHex();
    const ratio = contrastHex(hex6(), bg);
    const level = ratio >= 7 ? 'AAA' : ratio >= 4.5 ? 'AA' : ratio >= 3 ? 'AA large text only' : 'fails WCAG';
    contrastEl.textContent = '';
    contrastEl.append(
      icon(ratio >= 4.5 ? 'check_circle' : 'warning', 14),
      h('span', {}, `Contrast against ${bg}: ${ratio.toFixed(2)}:1 — ${level}`),
    );
    contrastEl.classList.toggle('is-warn', ratio < 4.5);

    renderTranslator();
    if (source !== 'silent') opts.onChange?.(hex8(), { r: c.r, g: c.g, b: c.b, a: alpha });
  }

  function renderTranslator() {
    const c = rgb();
    const rows = translateColor(c.r, c.g, c.b, alpha);
    const losesAlpha = alpha < 1;
    translatorEl.textContent = '';
    for (const row of rows) {
      // Four notations have no way to carry transparency. Copying one of them
      // while alpha is below 1 loses it, and losing it silently is exactly what
      // a customization surface must never do — so the row says so, in its
      // label, its title and its accessible name, and the copy button repeats
      // it. The value itself is left alone: it is the correct opaque colour.
      const drops = losesAlpha && ALPHA_FREE_NOTATIONS.has(row.k);
      const note = drops ? ` — ${alphaLossNote()}` : '';
      const inp = h('input', {
        type: 'text', class: `cp-tr-val mono${drops ? ' is-lossy' : ''}`, spellcheck: 'false',
        'aria-label': `${row.k} value${note}`, title: drops ? alphaLossNote() : undefined, value: row.v,
      });
      inp.value = row.v;
      inp.addEventListener('change', () => applyTyped(inp.value, row.k, inp));
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); applyTyped(inp.value, row.k, inp); } });
      translatorEl.appendChild(h('div', { class: `cp-tr-row${drops ? ' is-lossy' : ''}` },
        h('span', { class: 'cp-tr-key' }, row.k,
          drops ? h('span', { class: 'cp-tr-lossy', title: alphaLossNote() }, icon('warning', 12)) : null),
        inp,
        h('button', {
          type: 'button', class: 'icon-btn cp-tr-copy',
          title: drops ? `Copy ${row.k} — ${alphaLossNote()}` : `Copy ${row.k}`,
          'aria-label': `Copy ${row.k} value${note}`,
          onclick: async () => {
            const ok = await copyText(inp.value);
            if (!ok) { announce('Copy failed.'); return; }
            announce(drops ? `${row.k} copied — ${alphaLossNote()}` : `${row.k} copied.`);
          },
        }, icon('content_copy', 14))));
    }
    if (losesAlpha) {
      translatorEl.appendChild(h('p', { class: 'cp-tr-foot', role: 'note' },
        `${alphaLossNote()} (${Array.from(ALPHA_FREE_NOTATIONS).join(', ')})`));
    }
  }

  function renderRecent() {
    recentEl.textContent = '';
    const list = readRecent();
    if (!list.length) { recentEl.appendChild(h('div', { class: 'cp-empty' }, 'No recent colours yet.')); return; }
    for (const hexv of list) {
      recentEl.appendChild(h('button', {
        type: 'button', class: 'cp-swatch', title: hexv, 'aria-label': `Recent colour ${hexv}`,
        style: { background: hexv }, onclick: () => setValue(hexv),
      }));
    }
  }

  if (opts.swatches) {
    for (const sw of opts.swatches) {
      const hexv = typeof sw === 'string' ? sw : sw.hex;
      const lab = typeof sw === 'string' ? sw : (sw.label || sw.hex);
      swatchEl.appendChild(h('button', {
        type: 'button', class: 'cp-swatch', title: lab, 'aria-label': lab,
        style: { background: hexv }, onclick: () => setValue(hexv),
      }));
    }
  }

  /* ---------- typed entry ---------- */

  function applyTyped(text, spaceHint, sourceEl) {
    const parsed = parseAnyColor(text);
    gamutWarn.hidden = true;
    if (!parsed) {
      // Never silently drop what the user typed.
      sourceEl?.classList.add('is-invalid');
      gamutWarn.hidden = false;
      gamutWarn.textContent = `"${text}" is not a colour this picker can read. The value was kept in the field so you can correct it; the colour has not changed.`;
      gamutWarn.className = 'cp-gamut is-error';
      return false;
    }
    sourceEl?.classList.remove('is-invalid');
    if (parsed.inGamut === false) {
      gamutWarn.hidden = false;
      gamutWarn.className = 'cp-gamut is-warn';
      gamutWarn.textContent = `That ${spaceHint || parsed.space} value is outside the sRGB gamut. It has been clipped to the nearest colour this display can show — the numbers you typed are preserved above.`;
    }
    hsv = rgbToHsv(parsed.r, parsed.g, parsed.b);
    if (allowAlpha && parsed.a != null) alpha = clamp(parsed.a, 0, 1);
    paint();
    return true;
  }

  hexInput.addEventListener('change', () => applyTyped(hexInput.value, 'HEX', hexInput));
  hexInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); applyTyped(hexInput.value, 'HEX', hexInput); } });
  rgbInputs.forEach((inp) => inp.addEventListener('input', () => {
    const c = { r: clamp255(num(rgbInputs[0].value)), g: clamp255(num(rgbInputs[1].value)), b: clamp255(num(rgbInputs[2].value)) };
    hsv = rgbToHsv(c.r, c.g, c.b);
    suppressInputs = true; paint('rgb'); suppressInputs = false;
  }));
  alphaInput.addEventListener('input', () => {
    alpha = clamp(num(alphaInput.value) / 100, 0, 1);
    suppressInputs = true; paint('alpha'); suppressInputs = false;
  });

  /* ---------- continuous dragging ---------- */

  function dragify(el, onPos) {
    let dragging = false;
    const pos = (e) => {
      const r = el.getBoundingClientRect();
      return {
        x: clamp((e.clientX - r.left) / Math.max(1, r.width), 0, 1),
        y: clamp((e.clientY - r.top) / Math.max(1, r.height), 0, 1),
      };
    };
    el.addEventListener('pointerdown', (e) => {
      dragging = true;
      el.setPointerCapture?.(e.pointerId);
      el.focus();
      onPos(pos(e));
      e.preventDefault();
    });
    el.addEventListener('pointermove', (e) => { if (dragging) onPos(pos(e)); });
    const stop = (e) => { if (!dragging) return; dragging = false; el.releasePointerCapture?.(e.pointerId); commitRecent(); };
    el.addEventListener('pointerup', stop);
    el.addEventListener('pointercancel', stop);
  }

  dragify(field, ({ x, y }) => { hsv = { ...hsv, s: x * 100, v: (1 - y) * 100 }; paint(); });
  dragify(hueRail, ({ x }) => { hsv = { ...hsv, h: x * 360 }; paint(); });
  if (allowAlpha) dragify(alphaRail, ({ x }) => { alpha = x; paint(); });

  field.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 10 : 1;
    let handled = true;
    if (e.key === 'ArrowRight') hsv = { ...hsv, s: clamp(hsv.s + step, 0, 100) };
    else if (e.key === 'ArrowLeft') hsv = { ...hsv, s: clamp(hsv.s - step, 0, 100) };
    else if (e.key === 'ArrowUp') hsv = { ...hsv, v: clamp(hsv.v + step, 0, 100) };
    else if (e.key === 'ArrowDown') hsv = { ...hsv, v: clamp(hsv.v - step, 0, 100) };
    else handled = false;
    if (handled) { e.preventDefault(); paint(); }
  });
  hueRail.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 15 : 2;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); hsv = { ...hsv, h: (hsv.h + step) % 360 }; paint(); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); hsv = { ...hsv, h: (hsv.h - step + 360) % 360 }; paint(); }
    else if (e.key === 'Home') { e.preventDefault(); hsv = { ...hsv, h: 0 }; paint(); }
    else if (e.key === 'End') { e.preventDefault(); hsv = { ...hsv, h: 359 }; paint(); }
  });
  if (allowAlpha) alphaRail.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 0.1 : 0.01;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); alpha = clamp(alpha + step, 0, 1); paint(); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); alpha = clamp(alpha - step, 0, 1); paint(); }
  });

  async function pickWithEyedropper() {
    if (typeof window.EyeDropper !== 'function') return;
    try {
      const result = await new window.EyeDropper().open();
      if (result?.sRGBHex) setValue(result.sRGBHex);
    } catch { /* the user cancelled — nothing to report */ }
  }

  let recentTimer = 0;
  function commitRecent() {
    clearTimeout(recentTimer);
    recentTimer = setTimeout(() => { pushRecent(hex8()); renderRecent(); }, 400);
  }

  function setValue(value) {
    const parsed = parseAnyColor(value);
    if (!parsed) return false;
    hsv = rgbToHsv(parsed.r, parsed.g, parsed.b);
    if (allowAlpha) alpha = parsed.a ?? 1;
    paint();
    return true;
  }

  renderRecent();
  paint('silent');

  return {
    element: root,
    getValue: () => hex8(),
    getRgba: () => ({ ...rgb(), a: alpha }),
    setValue,
    commitRecent,
    destroy() { clearTimeout(recentTimer); root.remove(); },
  };
}

/* ------------------------------------------------------------------ */
/* anchored popover form                                               */
/* ------------------------------------------------------------------ */

let openPicker = null;

/**
 * openColorPicker({ anchor, value, onChange, onApply, title, alpha,
 *                   contrastAgainst, swatches })
 * The popover is anchored to the control that opened it, non-modal, and
 * returns focus on close.
 */
export function openColorPicker(opts = {}) {
  if (!opts.anchor) throw new Error('openColorPicker needs an anchor element');
  openPicker?.close();

  const restoreFocus = focusMemory();
  const picker = createColorPicker({
    value: opts.value, alpha: opts.alpha, contrastAgainst: opts.contrastAgainst,
    swatches: opts.swatches,
    onChange: (hex, rgba) => opts.onChange?.(hex, rgba),
  });

  const root = h('div', {
    class: 'cp-popover surface-3', role: 'dialog', 'aria-modal': 'false',
    'aria-label': opts.title || 'Colour picker', tabindex: '-1',
  },
  h('header', { class: 'cp-head' },
    icon('palette', 18),
    h('span', { class: 'cp-head-title' }, opts.title || 'Colour'),
    h('button', {
      type: 'button', class: 'icon-btn', 'aria-label': t('close'), title: t('close'),
      onclick: () => close(),
    }, icon('close', 18))),
  picker.element,
  h('footer', { class: 'cp-foot' },
    h('button', { type: 'button', class: 'btn-text', onclick: () => { picker.setValue(opts.value || '#0B57D0'); } }, t('reset')),
    h('div', { class: 'spacer' }),
    h('button', { type: 'button', class: 'btn-text', onclick: () => close() }, t('cancel')),
    h('button', {
      type: 'button', class: 'btn-filled',
      onclick: () => { picker.commitRecent(); opts.onApply?.(picker.getValue(), picker.getRgba()); close(); },
    }, t('ok'))));

  layer('popover').appendChild(root);
  const anchoring = anchorTo(root, opts.anchor, { placement: opts.placement || 'bottom-start', gap: 8, onDetach: () => close() });
  const untrap = trapFocus(root);

  root.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
  function onDocPointer(e) {
    if (root.contains(e.target) || opts.anchor.contains(e.target)) return;
    close();
  }
  setTimeout(() => document.addEventListener('pointerdown', onDocPointer, true), 0);

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('pointerdown', onDocPointer, true);
    untrap();
    anchoring.dispose();
    picker.destroy();
    root.remove();
    openPicker = null;
    opts.onClose?.();
    restoreFocus();
  }

  openPicker = { close, element: root, picker };
  requestAnimationFrame(() => root.focus());
  return openPicker;
}

/** A small round button that opens the picker for a bound value. */
export function colorSwatchButton({ value, label, onChange, alpha = true, contrastAgainst }) {
  let current = value || '#0B57D0';
  const btn = h('button', {
    type: 'button', class: 'cp-swatch-btn', 'aria-label': label || 'Choose a colour',
    title: label || 'Choose a colour', style: { background: current },
  });
  btn.addEventListener('click', () => {
    openColorPicker({
      anchor: btn, value: current, alpha, title: label, contrastAgainst,
      onChange: (hex) => { btn.style.background = hex; },
      onApply: (hex) => { current = hex; btn.style.background = hex; onChange?.(hex); },
      onClose: () => { btn.style.background = current; },
    });
  });
  return {
    element: btn,
    get value() { return current; },
    setValue(v) { current = v; btn.style.background = v; },
  };
}
