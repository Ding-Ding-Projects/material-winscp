// lib/colorpicker.js — the infinite colour picker and its translator.
//
// INFINITE, NOT A SWATCH GRID. The control is a continuous two-dimensional
// saturation/value field plus a continuous hue rail plus direct numeric entry,
// so every colour sRGB can express is reachable. Swatches and recents sit on
// top of that as conveniences; they never replace it.
//
// THE TRANSLATOR IS BIDIRECTIONAL. Every notation the panel prints is a string
// parseAnyColor() reads back as the same colour — that round trip is asserted
// in test/site-app.test.js rather than eyeballed, because a picker that emits
// `hsl(0 0% 0%)` for a colour it will later parse as something else corrupts
// the setting quietly and only at the next reload.
//
// Notations that cannot carry alpha say so instead of dropping it: "never let
// a customization surface silently drop a value it cannot represent".

import { h, clear, copyText, announce, uid, clamp } from './dom.js';
import { text as T } from './i18n.js';
import { notify } from './toast.js';
import {
  hexFromRgb, rgbFromHex, hsvFromRgb, rgbFromHsv, parseAnyColor, formatColor,
  translate, NOTATIONS, ALPHA_FREE, contrast, meetsAA, nameOf, oklchFromRgb, rgbFromOklch,
} from './color.js';

const RECENT_KEY = 'winscp-material-site/recent-colors';

function recents() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]').filter((s) => /^#[0-9a-f]{6}$/i.test(s)); }
  catch { return []; }
}
function remember(hex) {
  try {
    const list = [hex.toLowerCase(), ...recents().filter((c) => c !== hex.toLowerCase())].slice(0, 12);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch { /* storage refused; recents are a convenience, not a requirement */ }
}

/**
 * A colour picker bound to one value.
 *
 * `contrastAgainst` is a hex the readout compares against — the picker states
 * the real WCAG ratio for the pair the colour will actually be used in, rather
 * than claiming accessibility in the abstract.
 */
export function createColorPicker({ value = '#0b57d0', alpha = false, onChange, contrastAgainst, store }) {
  const id = uid('cp');
  const opts = () => (store ? store.langOpts() : {});
  let rgb = (rgbFromHex(value) || rgbFromHex('#0b57d0')).rgb;
  let a = alpha ? (rgbFromHex(value)?.a ?? 1) : 1;
  let notation = 'HEX';

  const field = h('div.cp-field', {
    tabindex: '0', role: 'application',
    'aria-label': 'Saturation and brightness. Arrow keys adjust; hold Shift for larger steps.',
  }, h('span.cp-thumb'));
  const hue = h('input.cp-hue', {
    type: 'range', min: '0', max: '360', step: '0.1',
    'aria-label': 'Hue', value: String(hsvFromRgb(rgb)[0]),
  });
  const alphaRail = alpha ? h('input.cp-alpha', {
    type: 'range', min: '0', max: '1', step: '0.01', 'aria-label': 'Opacity', value: String(a),
  }) : null;

  const swatch = h('div.cp-swatch', { 'aria-hidden': 'true' });
  const entry = h('input.cp-entry.mono', { type: 'text', spellcheck: 'false', 'aria-label': 'Colour value' });
  const notationSel = h('select.cp-notation', { 'aria-label': 'Notation' },
    NOTATIONS.map((n) => h('option', { value: n, text: n })));
  const readout = h('p.cp-readout', { role: 'status', 'aria-live': 'polite' });
  const gamut = h('p.cp-gamut');
  const table = h('div.cp-translator');
  const recentRow = h('div.cp-recents', { role: 'group', 'aria-label': 'Recent colours' });

  const root = h('div.cp', { id },
    h('div.cp-top', null, field, h('div.cp-rails', null, hue, alphaRail)),
    h('div.cp-entryrow', null, swatch, entry, notationSel),
    readout, gamut,
    h('details.cp-translate', null,
      h('summary', { text: T('colourTranslator', opts()) }), table),
    recentRow);

  /* -------------------------------------------------------------- painting */

  function paint() {
    const [hDeg, s, v] = hsvFromRgb(rgb);
    field.style.setProperty('--cp-hue', String(hDeg));
    field.querySelector('.cp-thumb').style.left = `${s}%`;
    field.querySelector('.cp-thumb').style.top = `${100 - v}%`;
    hue.value = String(hDeg);
    swatch.style.background = `rgba(${rgb.map(Math.round).join(',')},${a})`;
    entry.value = formatColor(rgb, a, notation);
    entry.dataset.invalid = '';

    if (contrastAgainst) {
      const other = rgbFromHex(contrastAgainst);
      if (other) {
        const ratio = contrast(rgb, other.rgb);
        readout.textContent = `${T('contrastAgainst', opts(), [contrastAgainst, ratio.toFixed(2)])} — `
          + `${meetsAA(ratio) ? T('passesAA', opts()) : T('failsAA', opts())}`;
        readout.dataset.kind = meetsAA(ratio) ? 'ok' : 'warn';
      }
    } else {
      const name = nameOf(rgb);
      readout.textContent = name ? `CSS name: ${name}` : '';
      readout.dataset.kind = '';
    }

    // OKLCH round trip tells us whether the colour the user asked for is one
    // this gamut can hold. Saying so beats showing a clipped colour silently.
    const [L, C, H] = oklchFromRgb(rgb);
    gamut.textContent = rgbFromOklch([L, C, H]).inGamut ? '' : T('outOfGamut', opts());

    clear(table);
    for (const row of translate(rgb, a)) {
      table.append(h('div.cp-row', null,
        h('span.cp-not', { text: row.notation }),
        h('code.cp-val', { text: row.value }),
        row.losesAlpha ? h('span.cp-warn', { title: T('alphaDropped', opts(), [row.notation]), text: '⚠' }) : null,
        h('button.cp-copy', {
          type: 'button', 'aria-label': `Copy ${row.notation}`, text: '⧉',
          onclick: async () => {
            const r = await copyText(row.value);
            if (r.ok) notify.success(T('copied', opts()), `${row.notation} — ${row.value}`);
            else notify.error(T('copyFailed', opts(), [r.error]));
          },
        })));
    }

    clear(recentRow);
    for (const c of recents()) {
      recentRow.append(h('button.cp-recent', {
        type: 'button', title: c, 'aria-label': c,
        style: { background: c },
        onclick: () => { rgb = rgbFromHex(c).rgb; emit(); },
      }));
    }
  }

  function emit() {
    paint();
    remember(hexFromRgb(rgb));
    onChange?.({ hex: hexFromRgb(rgb), rgb: rgb.slice(), a });
  }

  /* --------------------------------------------------------------- input */

  const fromPoint = (e) => {
    const r = field.getBoundingClientRect();
    const s = clamp(((e.clientX - r.left) / r.width) * 100, 0, 100);
    const v = clamp(100 - ((e.clientY - r.top) / r.height) * 100, 0, 100);
    rgb = rgbFromHsv([Number(hue.value), s, v]);
    emit();
  };
  field.addEventListener('pointerdown', (e) => {
    field.setPointerCapture(e.pointerId);
    fromPoint(e);
    const move = (ev) => fromPoint(ev);
    const up = () => { field.removeEventListener('pointermove', move); field.removeEventListener('pointerup', up); };
    field.addEventListener('pointermove', move);
    field.addEventListener('pointerup', up);
  });
  // The field is operable from the keyboard, because a colour control that only
  // takes a drag is a colour control half the audience cannot use.
  field.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 10 : 1;
    const [hDeg, s, v] = hsvFromRgb(rgb);
    const map = {
      ArrowLeft: [s - step, v], ArrowRight: [s + step, v],
      ArrowUp: [s, v + step], ArrowDown: [s, v - step],
    };
    if (!map[e.key]) return;
    e.preventDefault();
    rgb = rgbFromHsv([hDeg, clamp(map[e.key][0], 0, 100), clamp(map[e.key][1], 0, 100)]);
    emit();
    announce(formatColor(rgb, a, 'HEX'));
  });
  hue.addEventListener('input', () => {
    const [, s, v] = hsvFromRgb(rgb);
    rgb = rgbFromHsv([Number(hue.value), s, v]);
    emit();
  });
  alphaRail?.addEventListener('input', () => { a = Number(alphaRail.value); emit(); });
  notationSel.addEventListener('change', () => { notation = notationSel.value; paint(); });
  entry.addEventListener('input', () => {
    const parsed = parseAnyColor(entry.value);
    if (!parsed) { entry.dataset.invalid = '1'; return; }
    entry.dataset.invalid = '';
    rgb = parsed.rgb;
    if (alpha && !ALPHA_FREE.has(parsed.notation)) a = parsed.a;
    paint();
    onChange?.({ hex: hexFromRgb(rgb), rgb: rgb.slice(), a });
  });

  paint();
  return {
    root,
    get value() { return hexFromRgb(rgb); },
    set(hex) { const p = rgbFromHex(hex); if (p) { rgb = p.rgb; paint(); } },
  };
}

/** A small button that opens the full picker anchored beside itself. */
export function colorSwatchButton({ value, label, onChange, store, layer, contrastAgainst }) {
  const btn = h('button.swatch-button', {
    type: 'button', 'aria-label': `${label}: ${value}`, 'aria-expanded': 'false',
    style: { background: value },
  });
  btn.addEventListener('click', async () => {
    const { openPopover } = await import('./dom.js');
    const picker = createColorPicker({
      value: btn.dataset.value || value, store, contrastAgainst,
      onChange: (c) => {
        btn.style.background = c.hex;
        btn.dataset.value = c.hex;
        btn.setAttribute('aria-label', `${label}: ${c.hex}`);
        onChange(c.hex);
      },
    });
    const panel = h('div.popover.cp-popover', { role: 'dialog', 'aria-label': label }, picker.root);
    openPopover({ anchor: btn, panel, layer });
  });
  btn.dataset.value = value;
  return btn;
}
