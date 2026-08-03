// ui/appearance.js — the per-element appearance editor.
//
// Every rendered element that carries data-ap (set with appearanceTarget())
// gets "Edit appearance…" in its context menu, a keyboard equivalent
// (Shift+F10 / the Context-Menu key open the same menu), and Shift+right-click
// opens this editor directly. That wiring is registered once, here, so no
// other module has to remember it.
//
// The editor is NON-MODAL and anchored beside the element it edits. It tracks
// the anchor while open, handles viewport-edge collision through anchorTo(),
// and returns focus to the originating element on close.
//
// Depth is the Microsoft Word standard, not a token picker: family (every
// installed and bundled face, each name rendered in its own typeface), size as
// a stepper AND free entry, weight, italic/oblique, underline style and colour,
// single and double strikethrough, overline, capitalisation and small caps,
// super/subscript, text colour, highlight, outline, shadow, glow, character and
// word spacing, line height, baseline offset, direction and alignment — plus
// shape, radius, border, padding, elevation, opacity and icon size, each with
// hover / focus / active variants.
//
// It themes ITSELF and the app chrome: the editor's own surfaces are
// appearance targets, so the customisation system can style its own dialog.
//
// A value the platform cannot represent is never silently dropped: it is kept
// in the stored overrides, still shown in the field, and labelled with the
// reason it is not currently rendering.

import {
  h, icon, uid, clear, layer, anchorTo, focusMemory, trapFocus, appearanceTarget,
  announce, downloadText, pickTextFile, closestAppearanceTarget,
} from '../dom.js';
import { t, bindText } from '../i18n.js';
import { store, persistCurrent, bus, api, deepMerge } from '../state.js';
import { styleSheet, fontStack } from '../theme.js';
import { addMenuContributor } from './contextmenu.js';
import { colorSwatchButton } from './colorpicker.js';
import { createSearchBar, filterBy } from './searchbar.js';
import { notify } from './notifications.js';
import { FONTS } from '../../winscp-data.js';

/* ================================================================== */
/* capability detection                                                */
/* ================================================================== */

const supports = (prop, value) => {
  try { return typeof CSS !== 'undefined' && CSS.supports ? CSS.supports(prop, value) : true; }
  catch { return true; }
};

const CAPS = {
  textStroke: () => supports('-webkit-text-stroke', '1px red') || supports('text-stroke', '1px red'),
  textDecorationStyle: () => supports('text-decoration-style', 'wavy'),
  textDecorationThickness: () => supports('text-decoration-thickness', '2px'),
  fontVariantCaps: () => supports('font-variant-caps', 'small-caps'),
  fontSynthesis: () => supports('font-synthesis', 'none'),
  writingDirection: () => true,
};

/* ================================================================== */
/* the property model                                                  */
/* ================================================================== */

const px = (v) => (v === '' || v == null ? null : `${v}px`);

/**
 * Each property knows how to turn a stored value into CSS declarations, and
 * whether the current engine can render it. `unsupported` returns a reason
 * string when it cannot — the editor shows that reason and keeps the value.
 */
const PROPS = [
  // ---- Typography -------------------------------------------------
  { g: 'apTypography', k: 'fontFamily', labelKey: 'apFontFamily', type: 'font',
    css: (v) => ({ 'font-family': fontStack(v) }) },
  { g: 'apTypography', k: 'fontSize', labelKey: 'apFontSize', type: 'stepper', min: 6, max: 96, step: 1, unit: 'px',
    css: (v) => ({ 'font-size': px(v) }) },
  { g: 'apTypography', k: 'fontWeight', labelKey: 'apWeight', type: 'select',
    options: [['', '—'], ['100', '100 Thin'], ['200', '200 Extra Light'], ['300', '300 Light'], ['400', '400 Regular'],
      ['500', '500 Medium'], ['600', '600 Semi Bold'], ['700', '700 Bold'], ['800', '800 Extra Bold'], ['900', '900 Black']],
    css: (v) => ({ 'font-weight': v }) },
  { g: 'apTypography', k: 'fontStyle', labelKey: 'apItalic', type: 'select',
    options: [['', '—'], ['normal', 'Normal'], ['italic', 'Italic'], ['oblique 14deg', 'Oblique']],
    css: (v) => ({ 'font-style': v }) },
  { g: 'apTypography', k: 'fontStretch', labelKey: 'apWeight', label: 'Width (variable axis)', type: 'select',
    options: [['', '—'], ['75%', 'Condensed'], ['87.5%', 'Semi condensed'], ['100%', 'Normal'], ['112.5%', 'Semi expanded'], ['125%', 'Expanded']],
    css: (v) => ({ 'font-stretch': v }) },
  { g: 'apTypography', k: 'textTransform', labelKey: 'apCaps', type: 'select',
    options: [['', '—'], ['none', 'apCapsNone'], ['uppercase', 'apCapsUpper'], ['lowercase', 'apCapsLower'], ['capitalize', 'apCapsTitle']],
    css: (v) => ({ 'text-transform': v }) },
  { g: 'apTypography', k: 'smallCaps', labelKey: 'apSmallCaps', type: 'toggle',
    css: (v) => (v ? { 'font-variant-caps': 'small-caps' } : null),
    unsupported: () => (CAPS.fontVariantCaps() ? null : 'This engine does not support font-variant-caps; the value is stored and will apply where it is supported.') },
  { g: 'apTypography', k: 'script', labelKey: 'apScript', type: 'select',
    options: [['', 'apScriptNormal'], ['super', 'apSuper'], ['sub', 'apSub']],
    css: (v) => (v ? { 'vertical-align': v, 'font-size': '0.75em' } : null) },
  { g: 'apTypography', k: 'letterSpacing', labelKey: 'apLetterSpacing', type: 'stepper', min: -5, max: 20, step: 0.1, unit: 'px',
    css: (v) => ({ 'letter-spacing': px(v) }) },
  { g: 'apTypography', k: 'wordSpacing', labelKey: 'apWordSpacing', type: 'stepper', min: -10, max: 40, step: 0.5, unit: 'px',
    css: (v) => ({ 'word-spacing': px(v) }) },
  { g: 'apTypography', k: 'lineHeight', labelKey: 'apLineHeight', type: 'stepper', min: 0.8, max: 4, step: 0.05,
    css: (v) => ({ 'line-height': String(v) }) },
  { g: 'apTypography', k: 'baseline', labelKey: 'apBaseline', type: 'stepper', min: -20, max: 20, step: 0.5, unit: 'px',
    css: (v) => ({ 'vertical-align': px(v) }) },
  { g: 'apTypography', k: 'direction', labelKey: 'apDirection', type: 'select',
    options: [['', '—'], ['ltr', 'Left to right'], ['rtl', 'Right to left']],
    css: (v) => ({ direction: v }) },
  { g: 'apTypography', k: 'textAlign', labelKey: 'apAlign', type: 'select',
    options: [['', '—'], ['left', 'Left'], ['center', 'Center'], ['right', 'Right'], ['justify', 'Justify']],
    css: (v) => ({ 'text-align': v }) },

  // ---- Decoration -------------------------------------------------
  { g: 'apUnderline', k: 'underline', labelKey: 'apUnderline', type: 'toggle', css: () => null },
  { g: 'apUnderline', k: 'underlineStyle', labelKey: 'apUnderlineStyle', type: 'select',
    options: [['solid', 'Solid'], ['double', 'Double'], ['dotted', 'Dotted'], ['dashed', 'Dashed'], ['wavy', 'Wavy']],
    css: () => null,
    unsupported: () => (CAPS.textDecorationStyle() ? null : 'text-decoration-style is unavailable here; the style is stored and the underline renders solid.') },
  { g: 'apUnderline', k: 'underlineColor', labelKey: 'apUnderlineColor', type: 'color', css: () => null },
  { g: 'apUnderline', k: 'strike', labelKey: 'apStrike', type: 'toggle', css: () => null },
  { g: 'apUnderline', k: 'strikeDouble', labelKey: 'apStrikeDouble', type: 'toggle', css: () => null },
  { g: 'apUnderline', k: 'overline', labelKey: 'apOverline', type: 'toggle', css: () => null },

  // ---- Colour -----------------------------------------------------
  { g: 'apTextColor', k: 'color', labelKey: 'apTextColor', type: 'color', css: (v) => ({ color: v }) },
  { g: 'apTextColor', k: 'background', labelKey: 'apBg', type: 'color', css: (v) => ({ 'background-color': v }) },
  { g: 'apTextColor', k: 'highlight', labelKey: 'apHighlight', type: 'color',
    css: (v) => ({ 'background-image': `linear-gradient(${v}, ${v})`, 'background-clip': 'padding-box' }) },
  { g: 'apTextColor', k: 'opacity', labelKey: 'apOpacity', type: 'stepper', min: 0, max: 1, step: 0.05,
    css: (v) => ({ opacity: String(v) }) },

  // ---- Effects ----------------------------------------------------
  { g: 'apShadow', k: 'outlineColor', labelKey: 'apOutline', type: 'color',
    css: (v) => ({ '-webkit-text-stroke': `0.6px ${v}` }),
    unsupported: () => (CAPS.textStroke() ? null : 'Text outline needs -webkit-text-stroke, which this engine does not expose. The colour is kept and will apply where it is supported.') },
  { g: 'apShadow', k: 'shadow', labelKey: 'apShadow', type: 'color',
    css: (v) => ({ 'text-shadow': `0 1px 2px ${v}` }) },
  { g: 'apShadow', k: 'glow', labelKey: 'apGlow', type: 'color',
    css: (v) => ({ 'text-shadow': `0 0 8px ${v}` }) },
  { g: 'apShadow', k: 'elevation', labelKey: 'apElevation', type: 'select',
    options: [['', '—'], ['none', 'None'], ['var(--e1)', 'Level 1'], ['var(--e2)', 'Level 2'], ['var(--e3)', 'Level 3'], ['var(--e4)', 'Level 4'], ['var(--e5)', 'Level 5']],
    css: (v) => ({ 'box-shadow': v }) },

  // ---- Box --------------------------------------------------------
  { g: 'apBox', k: 'radius', labelKey: 'apRadius', type: 'stepper', min: 0, max: 999, step: 1, unit: 'px',
    css: (v) => ({ 'border-radius': px(v) }) },
  { g: 'apBox', k: 'borderWidth', labelKey: 'apBorder', type: 'stepper', min: 0, max: 12, step: 0.5, unit: 'px',
    css: (v) => ({ 'border-width': px(v), 'border-style': 'solid' }) },
  { g: 'apBox', k: 'borderColor', labelKey: 'apBorderColor', type: 'color',
    css: (v) => ({ 'border-color': v }) },
  { g: 'apBox', k: 'paddingX', labelKey: 'apPadding', label: 'Padding — horizontal', type: 'stepper', min: 0, max: 64, step: 1, unit: 'px',
    css: (v) => ({ 'padding-left': px(v), 'padding-right': px(v) }) },
  { g: 'apBox', k: 'paddingY', labelKey: 'apPadding', label: 'Padding — vertical', type: 'stepper', min: 0, max: 64, step: 1, unit: 'px',
    css: (v) => ({ 'padding-top': px(v), 'padding-bottom': px(v) }) },
  { g: 'apBox', k: 'minHeight', labelKey: 'apBox', label: 'Minimum height', type: 'stepper', min: 0, max: 200, step: 1, unit: 'px',
    css: (v) => ({ 'min-height': px(v) }) },
  { g: 'apBox', k: 'iconSize', labelKey: 'apBox', label: 'Icon size', type: 'stepper', min: 8, max: 48, step: 1, unit: 'px',
    css: (v) => ({ '--ap-icon-size': px(v) }) },
];

const GROUPS = ['apTypography', 'apUnderline', 'apTextColor', 'apShadow', 'apBox'];
const STATES = [
  { id: 'base', label: 'Normal', selector: '' },
  { id: 'hover', label: 'Hover', selector: ':hover' },
  { id: 'focus', label: 'Focus', selector: ':focus-visible' },
  { id: 'active', label: 'Active', selector: ':active' },
];

/* ================================================================== */
/* CSS generation                                                      */
/* ================================================================== */

const cssEscape = (s) => String(s).replace(/["\\]/g, '\\$&');

function declarationsFor(values) {
  const out = {};
  for (const p of PROPS) {
    const v = values[p.k];
    if (v === undefined || v === '' || v === null || v === false) continue;
    const decls = p.css(v);
    if (decls) Object.assign(out, decls);
  }
  // text-decoration is composed from four independent toggles, so build it once
  const lines = [];
  if (values.underline) lines.push('underline');
  if (values.overline) lines.push('overline');
  if (values.strike || values.strikeDouble) lines.push('line-through');
  if (lines.length) {
    out['text-decoration-line'] = lines.join(' ');
    const style = values.strikeDouble ? 'double' : (values.underlineStyle || 'solid');
    if (CAPS.textDecorationStyle()) out['text-decoration-style'] = style;
    if (values.underlineColor) out['text-decoration-color'] = values.underlineColor;
    if (CAPS.textDecorationThickness() && values.strikeDouble) out['text-decoration-thickness'] = '2px';
  }
  return out;
}

function ruleFor(key, state, values) {
  const decls = declarationsFor(values);
  const entries = Object.entries(decls).filter(([, v]) => v != null && v !== '');
  if (!entries.length) return '';
  const sel = `[data-ap="${cssEscape(key)}"]${state.selector}`;
  const body = entries.map(([k, v]) => `  ${k}: ${v} !important;`).join('\n');
  return `${sel} {\n${body}\n}\n`;
}

const sheet = () => styleSheet('appearance');

/** Rebuild the whole managed stylesheet from config. Cheap and idempotent. */
export function applyAppearance() {
  const per = store.get('theme.perElement') || {};
  let css = '';
  for (const [key, byState] of Object.entries(per)) {
    if (!byState || typeof byState !== 'object') continue;
    for (const state of STATES) {
      const values = byState[state.id];
      if (values && typeof values === 'object') css += ruleFor(key, state, values);
    }
  }
  // Icon size is exposed as a custom property so SVG icons follow it.
  css += '[data-ap] > svg.mi { width: var(--ap-icon-size, auto); height: var(--ap-icon-size, auto); }\n';
  sheet().set(css);
  bus.emit('appearance:applied', { count: Object.keys(per).length });
}

/* ================================================================== */
/* stored values                                                       */
/* ================================================================== */

function readValues(key, stateId) {
  const per = store.get('theme.perElement') || {};
  return { ...(per[key]?.[stateId] || {}) };
}

function writeValue(key, stateId, prop, value) {
  const per = { ...(store.get('theme.perElement') || {}) };
  const forKey = { ...(per[key] || {}) };
  const forState = { ...(forKey[stateId] || {}) };
  if (value === '' || value === null || value === undefined || value === false) delete forState[prop];
  else forState[prop] = value;
  if (Object.keys(forState).length) forKey[stateId] = forState;
  else delete forKey[stateId];
  if (Object.keys(forKey).length) per[key] = forKey;
  else delete per[key];
  store.set('theme.perElement', per);
  persistCurrent('theme');
  applyAppearance();
  api.historyRecord(`Changed the appearance of "${key}"`, { key, stateId, prop, value });
}

export function resetElement(key) {
  const per = { ...(store.get('theme.perElement') || {}) };
  delete per[key];
  store.set('theme.perElement', per);
  persistCurrent('theme');
  applyAppearance();
  api.historyRecord(`Reset the appearance of "${key}"`, { key });
}

export function resetAllAppearance() {
  store.set('theme.perElement', {});
  persistCurrent('theme');
  applyAppearance();
  api.historyRecord('Reset every per-element appearance override', {});
}

/* ================================================================== */
/* presets                                                             */
/* ================================================================== */

export function savePreset(name) {
  const presets = (store.get('theme.presets') || []).slice();
  const entry = {
    id: uid('preset'),
    name: name || `Preset ${presets.length + 1}`,
    savedAt: new Date().toISOString(),
    theme: { ...store.get('theme'), perElement: undefined, presets: undefined },
    perElement: store.get('theme.perElement') || {},
  };
  presets.push(entry);
  store.set('theme.presets', presets);
  persistCurrent('theme');
  api.historyRecord(`Saved the appearance preset "${entry.name}"`, { id: entry.id });
  return entry;
}

export function applyPreset(id) {
  const entry = (store.get('theme.presets') || []).find((p) => p.id === id);
  if (!entry) return false;
  const next = deepMerge(store.get('theme'), { ...(entry.theme || {}), perElement: entry.perElement || {} });
  store.set('theme', next);
  persistCurrent('theme');
  applyAppearance();
  api.historyRecord(`Applied the appearance preset "${entry.name}"`, { id });
  return true;
}

export function deletePreset(id) {
  const presets = (store.get('theme.presets') || []).filter((p) => p.id !== id);
  store.set('theme.presets', presets);
  persistCurrent('theme');
}

export function exportAppearance() {
  const payload = {
    kind: 'winscp-material-appearance',
    version: 1,
    exportedAt: new Date().toISOString(),
    theme: { ...store.get('theme') },
  };
  downloadText('winscp-material-appearance.json', JSON.stringify(payload, null, 2));
  notify.success(t('apExportTheme'), 'The current theme and every per-element override were written to the file.');
}

export async function importAppearance() {
  const file = await pickTextFile('.json,application/json');
  if (!file) return false;
  let payload = null;
  try { payload = JSON.parse(file.text); }
  catch (err) {
    notify.error(t('apImportTheme'), `${file.name} is not valid JSON, so nothing was changed. ${err.message}`);
    return false;
  }
  if (!payload || payload.kind !== 'winscp-material-appearance' || !payload.theme) {
    notify.error(t('apImportTheme'), `${file.name} is not a WinSCP Material appearance file. Nothing was changed.`);
    return false;
  }
  store.set('theme', deepMerge(store.get('theme'), payload.theme));
  persistCurrent('theme');
  applyAppearance();
  api.historyRecord(`Imported an appearance file (${file.name})`, { file: file.name });
  notify.success(t('apImportTheme'), `${file.name} applied.`);
  return true;
}

/* ================================================================== */
/* font list                                                           */
/* ================================================================== */

let fontCache = null;
async function fontList() {
  if (fontCache) return fontCache;
  const bundled = FONTS.map((f) => f.name);
  let installed = [];
  try { installed = (await api.listFonts()) || []; } catch { installed = []; }
  const names = Array.from(new Set([...bundled, ...installed.map((f) => (typeof f === 'string' ? f : f.family))].filter(Boolean)));
  names.sort((a, b) => a.localeCompare(b));
  fontCache = names.map((name) => ({ name, bundled: bundled.includes(name) }));
  return fontCache;
}

/* ================================================================== */
/* the editor                                                          */
/* ================================================================== */

let openEditor = null;

/**
 * openAppearanceEditor({ key, element, label })
 * Non-modal, anchored to `element`, tracks it, returns focus on close.
 */
export function openAppearanceEditor({ key, element, label, stateId: initialStateId = 'base', propertyKey = null } = {}) {
  if (!key) return null;
  if (openEditor) openEditor.close();
  const anchorEl = element && element.isConnected ? element : document.body;
  const restore = focusMemory();

  let stateId = STATES.some((state) => state.id === initialStateId) ? initialStateId : 'base';
  const bodyEl = h('div', { class: 'ap-body' });
  const noticeEl = h('div', { class: 'ap-notice', hidden: true, role: 'status' });

  const stateTabs = h('div', { class: 'ap-states', role: 'tablist', 'aria-label': 'Element state' });
  const stateButtons = new Map();
  for (const s of STATES) {
    const b = h('button', {
      type: 'button', class: 'ap-state', role: 'tab',
      'aria-selected': String(s.id === stateId), tabindex: s.id === stateId ? '0' : '-1',
      onclick: () => { stateId = s.id; syncStates(); renderProps(); },
    }, s.label);
    stateButtons.set(s.id, b);
    stateTabs.appendChild(b);
  }
  function syncStates() {
    for (const [sid, b] of stateButtons) {
      b.setAttribute('aria-selected', String(sid === stateId));
      b.tabIndex = sid === stateId ? 0 : -1;
      b.classList.toggle('is-on', sid === stateId);
    }
  }
  syncStates();

  const search = createSearchBar({
    id: `appearance-props-${key}`,
    labelKey: 'apSearchPh', placeholderKey: 'apSearchPh',
    compact: true, persist: false,
    appearanceKey: 'search-appearance', appearanceLabel: 'Appearance editor search',
    sampleProvider: () => PROPS.map((p) => p.label || t(p.labelKey)).join('\n'),
    onChange: renderProps,
  });

  /* ---------- controls ---------- */

  function controlFor(prop, values) {
    const current = values[prop.k];
    const labelText = prop.label || t(prop.labelKey);
    const controlId = uid('ap-c');
    let control;

    if (prop.type === 'font') {
      control = h('select', { class: 'field-input', id: controlId });
      control.appendChild(h('option', { value: '' }, '—'));
      fontList().then((list) => {
        for (const f of list) {
          const opt = h('option', { value: f.name }, `${f.name}${f.bundled ? '' : ' (installed)'}`);
          // Each family name is rendered in its own face, as Word does.
          opt.style.fontFamily = fontStack(f.name);
          if (current === f.name) opt.selected = true;
          control.appendChild(opt);
        }
        if (current) control.value = current;
      });
      control.addEventListener('change', () => commit(prop, control.value));
    } else if (prop.type === 'select') {
      control = h('select', { class: 'field-input', id: controlId });
      for (const [value, lab] of prop.options) {
        const text = lab.startsWith('ap') && t(lab) !== lab ? t(lab) : lab;
        const opt = h('option', { value }, text);
        if (String(current ?? '') === value) opt.selected = true;
        control.appendChild(opt);
      }
      control.addEventListener('change', () => commit(prop, control.value));
    } else if (prop.type === 'toggle') {
      control = h('input', { type: 'checkbox', id: controlId, class: 'check-input' });
      control.checked = !!current;
      control.addEventListener('change', () => commit(prop, control.checked));
    } else if (prop.type === 'color') {
      const swatch = colorSwatchButton({
        value: current || '#000000', label: labelText,
        onChange: (hex) => commit(prop, hex),
      });
      const clearBtn = h('button', {
        type: 'button', class: 'icon-btn', 'aria-label': `${t('reset')} ${labelText}`, title: t('reset'),
        onclick: () => { commit(prop, ''); renderProps(); },
      }, icon('restart_alt', 15));
      control = h('span', { class: 'ap-colorwrap' }, swatch.element, clearBtn,
        h('span', { class: 'ap-colorval mono' }, current || t('default_')));
    } else {
      // stepper: a free-entry number field with explicit − / + steppers
      const input = h('input', {
        type: 'number', class: 'field-input ap-num', id: controlId,
        min: String(prop.min), max: String(prop.max), step: String(prop.step),
        'aria-label': labelText,
      });
      input.value = current ?? '';
      const bump = (delta) => {
        const base = Number(input.value === '' ? (prop.min === 0 ? 0 : 1) : input.value);
        const next = Math.round((base + delta * prop.step) * 1000) / 1000;
        input.value = Math.min(prop.max, Math.max(prop.min, next));
        commit(prop, input.value);
      };
      input.addEventListener('change', () => {
        if (input.value === '') { commit(prop, ''); return; }
        const n = Number(input.value);
        if (!Number.isFinite(n)) {
          showNotice(`"${input.value}" is not a number, so ${labelText} was left unchanged. Your text is still in the field.`);
          return;
        }
        if (n < prop.min || n > prop.max) {
          showNotice(`${labelText} accepts ${prop.min}–${prop.max}${prop.unit || ''}. "${n}" is outside that range and was not applied; your value is kept in the field so you can adjust it.`);
          return;
        }
        commit(prop, n);
      });
      control = h('span', { class: 'ap-stepper' },
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': `${labelText} −`, onclick: () => bump(-1) }, icon('remove', 14)),
        input,
        prop.unit ? h('span', { class: 'ap-unit' }, prop.unit) : null,
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': `${labelText} +`, onclick: () => bump(1) }, icon('add', 14)));
    }

    const reason = prop.unsupported?.();
    const row = h('div', { class: `ap-row${reason ? ' is-unsupported' : ''}`, 'data-prop': prop.k },
      h('label', { class: 'ap-row-label', for: controlId }, labelText),
      control,
      current !== undefined && current !== '' && prop.type !== 'color'
        ? h('button', {
          type: 'button', class: 'icon-btn ap-clear', 'aria-label': `${t('reset')} ${labelText}`, title: t('reset'),
          onclick: () => { commit(prop, ''); renderProps(); },
        }, icon('restart_alt', 14))
        : null);
    if (reason) {
      row.appendChild(h('div', { class: 'ap-unsupported' }, icon('warning', 13), h('span', {}, `${t('apUnsupported')} ${reason}`)));
    }
    return row;
  }

  function showNotice(text) {
    noticeEl.hidden = false;
    noticeEl.textContent = '';
    noticeEl.append(icon('warning', 14), h('span', {}, text));
    announce(text, true);
  }

  function commit(prop, value) {
    noticeEl.hidden = true;
    writeValue(key, stateId, prop.k, value);
    // Underline sub-properties only mean anything with the underline on.
    if (prop.k === 'underlineStyle' && value && !readValues(key, stateId).underline) {
      writeValue(key, stateId, 'underline', true);
    }
    announce(`${prop.label || t(prop.labelKey)} ${t('apApplied')}`);
  }

  function renderProps() {
    clear(bodyEl);
    const values = readValues(key, stateId);
    const active = search.isActive ? search.predicate : null;
    for (const g of GROUPS) {
      let list = PROPS.filter((p) => p.g === g);
      if (active) list = filterBy(list, active, (p) => [p.label || t(p.labelKey), p.k]);
      if (!list.length) continue;
      bodyEl.appendChild(h('div', { class: 'ap-group-title' }, t(g)));
      for (const p of list) bodyEl.appendChild(controlFor(p, values));
    }
    if (!bodyEl.children.length) {
      bodyEl.appendChild(h('div', { class: 'ts-empty' }, 'No appearance property matches that search.'));
    }
    if (propertyKey) {
      const row = bodyEl.querySelector(`[data-prop="${CSS.escape(propertyKey)}"]`);
      const target = row?.querySelector('input, select, textarea, button');
      if (target) {
        target.focus({ preventScroll: true });
        row.classList.add('is-destination');
        target.scrollIntoView?.({ block: 'nearest' });
        propertyKey = null;
      }
    }
  }

  /* ---------- presets bar ---------- */

  const presetsRow = h('div', { class: 'ap-presets' });
  function renderPresets() {
    clear(presetsRow);
    const presets = store.get('theme.presets') || [];
    presetsRow.appendChild(h('span', { class: 'ap-presets-label' }, t('apPresets')));
    if (!presets.length) {
      presetsRow.appendChild(h('span', { class: 'ap-presets-empty' },
        'No saved appearance presets yet. Save one to reuse this look, or export it to a file.'));
    }
    for (const p of presets) {
      presetsRow.appendChild(h('span', { class: 'ap-preset' },
        h('button', { type: 'button', class: 'btn-text', onclick: () => { applyPreset(p.id); renderProps(); } }, p.name),
        h('button', {
          type: 'button', class: 'icon-btn', 'aria-label': `${t('remove')} ${p.name}`, title: t('remove'),
          onclick: () => { deletePreset(p.id); renderPresets(); },
        }, icon('close', 13))));
    }
    presetsRow.appendChild(h('button', {
      type: 'button', class: 'btn-text', onclick: () => {
        const name = window.prompt(t('apSavePreset'), `Preset ${(store.get('theme.presets') || []).length + 1}`);
        if (name == null) return;
        savePreset(name.trim() || undefined);
        renderPresets();
        notify.success(t('apSavePreset'), name);
      },
    }, icon('add', 14), t('apSavePreset')));
  }

  /* ---------- shell ---------- */

  const root = h('div', {
    class: 'ap surface-3', role: 'dialog', 'aria-modal': 'false',
    'aria-label': `${t('apTitle')} — ${label || key}`, tabindex: '-1',
  },
  h('header', { class: 'ap-head' },
    icon('palette', 18),
    h('div', { class: 'ap-head-main' },
      h('div', { class: 'ap-head-title' }, t('apTitle')),
      h('div', { class: 'ap-head-target' }, `${t('apTarget')}: ${label || key}`)),
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('close'), title: t('close'), onclick: () => close() }, icon('close', 18))),
  stateTabs,
  h('div', { class: 'ap-searchrow' }, search.element),
  noticeEl,
  bodyEl,
  presetsRow,
  h('footer', { class: 'ap-foot' },
    h('button', { type: 'button', class: 'btn-text', onclick: () => { resetElement(key); renderProps(); notify.info(t('apResetDone'), label || key); } }, icon('restart_alt', 15), t('apResetEl')),
    h('button', { type: 'button', class: 'btn-text', onclick: () => { resetAllAppearance(); renderProps(); notify.info(t('apResetDone'), t('apResetAll')); } }, t('apResetAll')),
    h('div', { class: 'spacer' }),
    h('button', { type: 'button', class: 'btn-text', onclick: exportAppearance }, icon('file_download', 15), t('apExportTheme')),
    h('button', { type: 'button', class: 'btn-text', onclick: async () => { await importAppearance(); renderProps(); renderPresets(); } }, icon('file_upload', 15), t('apImportTheme'))));

  // The editor themes itself: its own chrome is an appearance target too.
  appearanceTarget(root, 'appearance-editor', 'Appearance editor');
  appearanceTarget(stateTabs, 'appearance-editor-states', 'Appearance editor state tabs');

  layer('popover').appendChild(root);
  const anchoring = anchorTo(root, anchorEl, { placement: 'right-start', gap: 10, onDetach: () => close() });
  const untrap = trapFocus(root);
  root.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    untrap();
    anchoring.dispose();
    search.destroy();
    root.remove();
    openEditor = null;
    restore();
  }

  renderProps();
  renderPresets();
  requestAnimationFrame(() => root.focus());
  openEditor = { close, element: root, key };
  return openEditor;
}

/* ================================================================== */
/* installation                                                        */
/* ================================================================== */

let installed = false;

/**
 * Registers the global "Edit appearance…" contribution and the bus listener
 * used by Shift+right-click. Called once by app.js.
 */
export function startAppearance() {
  if (installed) return;
  installed = true;

  applyAppearance();
  store.subscribe('theme.perElement', applyAppearance, { immediate: false });

  addMenuContributor((ctx) => {
    const target = ctx.appearanceTarget || closestAppearanceTarget(ctx.target);
    if (!target) return [];
    const key = target.dataset.ap;
    const label = target.dataset.apLabel || key;
    const isTab = key.startsWith('tab-') && !key.startsWith('tab-group') && !key.startsWith('tab-strip');
    const isGroup = key.startsWith('tab-group-');
    return [{
      labelKey: isGroup ? 'editGroupAppearance' : isTab ? 'editTabAppearance' : 'editAppearance',
      icon: 'palette',
      description: `${t('apTarget')}: ${label} — Shift+right-click opens this directly`,
      onSelect: () => openAppearanceEditor({ key, element: target, label }),
    }];
  });

  bus.on('appearance:open', ({ key, element, label }) => {
    openAppearanceEditor({ key, element, label });
  });

  // Keyboard equivalent that does not need the context menu at all.
  window.addEventListener('keydown', (e) => {
    if (!(e.altKey && e.shiftKey && e.key.toLowerCase() === 'e')) return;
    const target = closestAppearanceTarget(document.activeElement);
    if (!target) { announce('No customisable element is focused.', true); return; }
    e.preventDefault();
    openAppearanceEditor({ key: target.dataset.ap, element: target, label: target.dataset.apLabel });
  });
}

export { PROPS, STATES, bindText };
