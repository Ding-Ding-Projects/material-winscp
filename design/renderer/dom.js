// dom.js — the renderer's DOM toolkit.
//
// Everything in the UI is built with h() rather than innerHTML, so no module
// ever injects markup from data. The helpers here are deliberately small and
// dependency-free: hyperscript, a local SVG icon set (no webfont, no CDN),
// anchored-popover positioning with viewport-collision handling, focus
// management, roving focus for composite widgets, and the screen-reader
// live region every module announces through.
//
// Conventions for other modules:
//   * build DOM with h(); never assign innerHTML from user or remote data
//   * mark an element as an appearance target with appearanceTarget(el, key)
//   * open anything floating through layer() so stacking stays predictable

export const NS_SVG = 'http://www.w3.org/2000/svg';

let _uid = 0;
/** A stable unique id, useful for aria-controls / aria-labelledby wiring. */
export function uid(prefix = 'id') { _uid += 1; return `${prefix}-${_uid.toString(36)}`; }

export function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

export function debounce(fn, ms = 120) {
  let t = 0;
  const wrapped = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  wrapped.cancel = () => clearTimeout(t);
  wrapped.flush = (...args) => { clearTimeout(t); fn(...args); };
  return wrapped;
}

export function throttleRaf(fn) {
  let pending = false, lastArgs = null;
  return (...args) => {
    lastArgs = args;
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; fn(...lastArgs); });
  };
}

/* ------------------------------------------------------------------ */
/* hyperscript                                                         */
/* ------------------------------------------------------------------ */

function applyProp(el, k, v) {
  if (v == null || v === false) return;
  if (k === 'class' || k === 'className') { el.setAttribute('class', String(v)); return; }
  if (k === 'style') {
    if (typeof v === 'string') el.setAttribute('style', v);
    else for (const [p, val] of Object.entries(v)) {
      if (val == null) continue;
      if (p.startsWith('--')) el.style.setProperty(p, String(val));
      else el.style[p] = typeof val === 'number' && !UNITLESS.has(p) ? `${val}px` : String(val);
    }
    return;
  }
  if (k === 'dataset') { for (const [p, val] of Object.entries(v)) if (val != null) el.dataset[p] = String(val); return; }
  if (k === 'ref') { if (typeof v === 'function') v(el); return; }
  if (k.startsWith('on') && typeof v === 'function') {
    const type = k.slice(2).toLowerCase();
    el.addEventListener(type, v);
    return;
  }
  if (k === 'html') return;                       // deliberately unsupported
  if (v === true) { el.setAttribute(k, ''); return; }
  el.setAttribute(k, String(v));
}

const UNITLESS = new Set(['opacity', 'zIndex', 'fontWeight', 'lineHeight', 'flex', 'flexGrow', 'flexShrink', 'order', 'gridRow', 'gridColumn']);

export function append(el, child) {
  if (child == null || child === false || child === true) return;
  if (Array.isArray(child)) { child.forEach((c) => append(el, c)); return; }
  el.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
}

/** h('div', {class:'x'}, 'text', child) — the only way this app builds DOM. */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props && (props instanceof Node || Array.isArray(props) || typeof props !== 'object')) {
    children.unshift(props);
  } else if (props) {
    for (const [k, v] of Object.entries(props)) applyProp(el, k, v);
  }
  children.forEach((c) => append(el, c));
  return el;
}

export function svg(tag, props, ...children) {
  const el = document.createElementNS(NS_SVG, tag);
  if (props) for (const [k, v] of Object.entries(props)) { if (v != null && v !== false) el.setAttribute(k, String(v)); }
  children.forEach((c) => { if (c) el.appendChild(c); });
  return el;
}

export function frag(...children) {
  const f = document.createDocumentFragment();
  children.forEach((c) => append(f, c));
  return f;
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

export function on(target, type, fn, opts) {
  target.addEventListener(type, fn, opts);
  return () => target.removeEventListener(type, fn, opts);
}

/* ------------------------------------------------------------------ */
/* icons — bundled locally, drawn as stroked SVG, no webfont            */
/* ------------------------------------------------------------------ */
// Every icon is authored here as SVG path data on a 24x24 grid, stroked with
// currentColor. The app links no font from a CDN, so icons must ship as
// geometry. registerIcon() lets a later module add its own.

const S = (d) => ({ d });                                  // stroked path
const F = (d) => ({ d, fill: true });                      // filled path

export const ICONS = {
  swap_vert:      S('M7 4v14M7 4 4 7.5M7 4l3 3.5M17 20V6M17 20l3-3.5M17 20l-3-3.5'),
  close:          S('M6 6l12 12M18 6L6 18'),
  minimize:       S('M5 12h14'),
  maximize:       S('M5 5h14v14H5z'),
  restore_window: S('M8 8h11v11H8zM5 16V5h11'),
  notifications:  S('M12 3a5 5 0 0 0-5 5v4l-2 3h14l-2-3V8a5 5 0 0 0-5-5zM10 18a2 2 0 0 0 4 0'),
  translate:      S('M3 6h9M7.5 4v2M9.5 6c0 4-3 7-6 8M6 9c1 2.5 3 4.5 5.5 5.5M13 20l4-10 4 10M14.6 16.5h4.8'),
  search:         S('M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM16 16l4.5 4.5'),
  manage_search:  S('M9 3a6 6 0 1 0 0 12A6 6 0 0 0 9 3zM13.5 13.5 18 18M3 19h9M3 22h6'),
  add:            S('M12 5v14M5 12h14'),
  remove:         S('M5 12h14'),
  expand_more:    S('M6 9.5l6 6 6-6'),
  expand_less:    S('M6 14.5l6-6 6 6'),
  chevron_right:  S('M9.5 6l6 6-6 6'),
  chevron_left:   S('M14.5 6l-6 6 6 6'),
  arrow_drop_down:F('M7 10h10l-5 5z'),
  arrow_upward:   S('M12 19V5M12 5l-6 6M12 5l6 6'),
  arrow_downward: S('M12 5v14M12 19l-6-6M12 19l6-6'),
  check:          S('M5 12.5l4.5 4.5L19 7.5'),
  check_circle:   S('M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM8 12.2l2.8 2.8L16 9.5'),
  info:           S('M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v6M12 7.6v.6'),
  warning:        S('M12 4 2.5 20h19zM12 10v4.5M12 17v.6'),
  error:          S('M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7.5v6M12 16v.6'),
  push_pin:       S('M9 3h6l-1 6 3.5 3H6.5L10 9zM12 12v9'),
  topic:          S('M3 6.5A1.5 1.5 0 0 1 4.5 5h4L11 7.5h8.5A1.5 1.5 0 0 1 21 9v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18z'),
  folder:         S('M3 6.5A1.5 1.5 0 0 1 4.5 5h4L11 7.5h8.5A1.5 1.5 0 0 1 21 9v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18z'),
  folder_open:    S('M3 18V6.5A1.5 1.5 0 0 1 4.5 5h4L11 7.5h7A1.5 1.5 0 0 1 19.5 9v1.5M3 18l3-7.5h16L19 18z'),
  description:    S('M6 3h7l5 5v13H6zM13 3v5h5'),
  settings:       S('M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1v.3a2 2 0 1 1-4 0v-.2a1.6 1.6 0 0 0-2.8-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3.5 15h-.2a2 2 0 1 1 0-4h.2a1.6 1.6 0 0 0 1.1-2.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 10 4.5v-.2a2 2 0 1 1 4 0v.2a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7h.2a2 2 0 1 1 0 4h-.2a1.6 1.6 0 0 0-1.2.9z'),
  tune:           S('M4 7h10M18 7h2M4 17h4M12 17h8M16 5v4M10 15v4'),
  palette:        S('M12 3a9 9 0 0 0 0 18c1.1 0 1.7-.8 1.7-1.6 0-.5-.2-.8-.5-1.2-.3-.3-.4-.6-.4-1 0-.8.7-1.4 1.5-1.4H16a5 5 0 0 0 5-5c0-4-4-7.8-9-7.8zM7.5 12.5a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4zM10.5 8.4a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4zM15.5 8.9a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4z'),
  colorize:       S('M15.5 3.5 17 5l1.8-1.8a1.8 1.8 0 0 1 2.5 2.5L19.5 7.5 21 9l-2 2-1.4-1.4L8 19.2 4 20.5l1.3-4 9.6-9.6L13.5 5.5z'),
  format_size:    S('M4 7h10M9 7v11M15 12h6M18 12v6'),
  text_fields:    S('M3 6h11M8.5 6v12M14 11h7M17.5 11v7'),
  content_copy:   S('M9 9h10v12H9zM5 15H3.5A.5.5 0 0 1 3 14.5V3.5A.5.5 0 0 1 3.5 3h11a.5.5 0 0 1 .5.5V5'),
  download:       S('M12 4v11M12 15l-4.5-4.5M12 15l4.5-4.5M4 19h16'),
  upload:         S('M12 19V8M12 8 7.5 12.5M12 8l4.5 4.5M4 4h16'),
  refresh:        S('M20 12a8 8 0 1 1-2.4-5.7M20 4v4h-4'),
  history:        S('M3.5 12a8.5 8.5 0 1 0 2.6-6.1M3.5 4.5V10h5.5M12 7.5V12l3.5 2'),
  restart_alt:    S('M4 12a8 8 0 1 1 3 6.2M4 8v4h4'),
  terminal:       S('M3 5h18v14H3zM6.5 9.5l3 2.5-3 2.5M13 15h5'),
  code:           S('M8.5 8 4 12l4.5 4M15.5 8 20 12l-4.5 4M13.5 5l-3 14'),
  receipt_long:   S('M6 3h12v18l-2-1.5L14 21l-2-1.5L10 21l-2-1.5L6 21zM9 8h6M9 12h6M9 16h4'),
  visibility:     S('M2.5 12S6 6.5 12 6.5 21.5 12 21.5 12 18 17.5 12 17.5 2.5 12 2.5 12zM12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z'),
  edit:           S('M4 20h4L20 8l-4-4L4 16zM14.5 5.5l4 4'),
  delete:         S('M5 6.5h14M9.5 6.5V4h5v2.5M6.5 6.5 7.5 21h9l1-14.5M10 10v7M14 10v7'),
  drag_indicator: S('M9 6.5v.01M9 12v.01M9 17.5v.01M15 6.5v.01M15 12v.01M15 17.5v.01'),
  more_vert:      S('M12 6.2v.01M12 12v.01M12 17.8v.01'),
  more_horiz:     S('M6.2 12h.01M12 12h.01M17.8 12h.01'),
  light_mode:     S('M12 7.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM12 2v2.4M12 19.6V22M2 12h2.4M19.6 12H22M5 5l1.7 1.7M17.3 17.3 19 19M19 5l-1.7 1.7M6.7 17.3 5 19'),
  dark_mode:      S('M20 13.5A8.5 8.5 0 0 1 10.5 4 8.5 8.5 0 1 0 20 13.5z'),
  contrast:       S('M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 3v18'),
  keyboard:       S('M3 6.5h18v11H3zM6.5 10v.01M10 10v.01M13.5 10v.01M17 10v.01M8 14h8'),
  help:           S('M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9.6 9.6a2.5 2.5 0 1 1 3.2 2.9c-.6.2-.8.7-.8 1.3v.4M12 17v.6'),
  bookmark:       S('M6.5 3.5h11v17l-5.5-4-5.5 4z'),
  label:          S('M3 7.5h11l5 4.5-5 4.5H3z'),
  computer:       S('M3 5.5h18v10H3zM8 19.5h8M12 15.5v4'),
  dns:            S('M4 4.5h16v6H4zM4 13.5h16v6H4zM7.5 7.5v.01M7.5 16.5v.01'),
  lan:            S('M9 3.5h6v4H9zM2.5 16.5h5v4h-5zM16.5 16.5h5v4h-5zM12 7.5V12M5 16.5V12h14v4.5'),
  sync_alt:       S('M4 9h13l-3-3M20 15H7l3 3'),
  filter:         S('M3.5 5h17l-6.5 8v6.5l-4 1.5V13z'),
  select_all:     S('M4 4.5h4M16 4.5h4M4 19.5h4M16 19.5h4M4 9.5v5M20 9.5v5M9.5 9.5h5v5h-5z'),
  open_in_new:    S('M14 4h6v6M20 4l-9 9M18 14v5.5H4.5V6H10'),
  star:           S('M12 3.5l2.7 5.5 6 .9-4.35 4.2 1.03 6L12 17.3 6.62 20.1l1.03-6L3.3 9.9l6-.9z'),
  group_work:     S('M4 5.5h7v13H4zM13 5.5h7v6h-7zM13 12.5h7v6h-7z'),
  unfold_more:    S('M8 9l4-4 4 4M8 15l4 4 4-4'),
  vertical_split: S('M3 4.5h8v15H3zM13 4.5h8v6h-8zM13 12.5h8v7h-8z'),
  wysiwyg:        S('M3 5h18v14H3zM3 9h18M6 12.5h7M6 15.5h5'),
  swap_horiz:     S('M4 9h14l-3.5-3.5M20 15H6l3.5 3.5'),
  cloud:          S('M7 18.5a4 4 0 0 1-.2-8A5.5 5.5 0 0 1 17.4 10a3.9 3.9 0 0 1 .3 8.5z'),
  key:            S('M14.5 4a5.5 5.5 0 1 0-3.7 9.6L10 14.5H8v2H6v2H3v-3l6.4-6.4A5.5 5.5 0 0 1 14.5 4zM16.2 7.8v.01'),
  shield_lock:    S('M12 3 4.5 6v6c0 4.5 3.2 7.8 7.5 9 4.3-1.2 7.5-4.5 7.5-9V6zM10 12h4v4h-4zM10.8 12v-1.4a1.2 1.2 0 0 1 2.4 0V12'),
  database:       S('M12 3.5c-4.1 0-7.5 1.2-7.5 2.6S7.9 8.7 12 8.7s7.5-1.2 7.5-2.6S16.1 3.5 12 3.5zM4.5 6.1v11.8c0 1.4 3.4 2.6 7.5 2.6s7.5-1.2 7.5-2.6V6.1M4.5 12c0 1.4 3.4 2.6 7.5 2.6s7.5-1.2 7.5-2.6'),
  language:       S('M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3.3 9.5h17.4M3.3 14.5h17.4M12 3c-2.4 2.4-3.6 5.4-3.6 9s1.2 6.6 3.6 9c2.4-2.4 3.6-5.4 3.6-9S14.4 5.4 12 3z'),
  sentiment:      S('M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM8.8 9.8v.01M15.2 9.8v.01M8 14.5c1 1.3 2.4 2 4 2s3-.7 4-2'),
  restaurant:     S('M6 3v7a2 2 0 0 0 4 0V3M8 10v11M16.5 3c-1.4 1-2 2.6-2 4.6s.6 3.3 2 4.1V21'),
  done_all:       S('M2.5 12.5 6 16l7.5-8M10 16l1.5 1.5L21 8'),
  mark_email:     S('M3 6h18v12H3zM3 6.6l9 6 9-6'),
  notifications_off: S('M4 4l16 16M7 8.8V8a5 5 0 0 1 8.6-3.4M17 12V8M5 15h12l-2-3M10 18a2 2 0 0 0 4 0'),
  pending:        S('M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM8 12h.01M12 12h.01M16 12h.01'),
  format_bold:    S('M6.5 4.5H13a3.5 3.5 0 0 1 0 7H6.5zM6.5 11.5h7.2a4 4 0 0 1 0 8H6.5z'),
  format_italic:  S('M10 4.5h6M8 19.5h6M14 4.5l-4 15'),
  format_underline: S('M7 4v7a5 5 0 0 0 10 0V4M5.5 20.5h13'),
  format_strike:  S('M4 12h16M7.5 8.4c0-2.3 1.9-3.9 4.6-3.9 2.4 0 4 1 4.6 2.6M6.8 15c.4 2.7 2.4 4.5 5.4 4.5 3 0 5-1.6 5-3.8 0-1.2-.5-2.2-1.5-2.9'),
  format_align_left:   S('M4 6h16M4 10.5h10M4 15h16M4 19.5h10'),
  format_align_center: S('M4 6h16M7 10.5h10M4 15h16M7 19.5h10'),
  format_align_right:  S('M4 6h16M10 10.5h10M4 15h16M10 19.5h10'),
  format_align_justify:S('M4 6h16M4 10.5h16M4 15h16M4 19.5h16'),
  border_style:   S('M3.5 3.5h17v17h-17zM8 8.5h8v7H8z'),
  rounded_corner: S('M4 20V10A6 6 0 0 1 10 4h10'),
  space_bar:      S('M5 10v4h14v-4'),
  vertical_align: S('M12 5v14M8 8.5 12 5l4 3.5M8 15.5 12 19l4-3.5M4 12h3M17 12h3'),
  layers:         S('M12 3 3 8l9 5 9-5zM3 13l9 5 9-5M3 17.5l9 5 9-5'),
  file_download:  S('M6 3h7l5 5v13H6zM13 3v5h5M12 11v6M12 17l-2.5-2.5M12 17l2.5-2.5'),
  file_upload:    S('M6 3h7l5 5v13H6zM13 3v5h5M12 18v-6M12 12l-2.5 2.5M12 12l2.5 2.5'),
  category:       S('M12 3l4.5 6.5h-9zM4 13.5h6.5V20H4zM17 13.2a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8z'),
  numbers:        S('M6 4l-1.5 16M14 4l-1.5 16M3.5 9h16M2.5 15h16'),
  view_column:    S('M3 4.5h5.6v15H3zM9.2 4.5h5.6v15H9.2zM15.4 4.5H21v15h-5.6z'),
  playlist:       S('M4 7h11M4 12h11M4 17h7M17 10v8.2M17 18.2a1.9 1.9 0 1 0 0 .1M17 10l4-1v3'),
};

export function registerIcon(name, def) { ICONS[name] = typeof def === 'string' ? S(def) : def; }

/**
 * icon('search', 18) -> <svg>. Unknown names render a neutral placeholder
 * square rather than throwing, so a late-added module never breaks the shell.
 */
export function icon(name, size = 18, opts = {}) {
  const def = ICONS[name] || ICONS[opts.fallback] || null;
  const el = svg('svg', {
    class: 'mi', width: size, height: size, viewBox: '0 0 24 24',
    fill: 'none', 'aria-hidden': 'true', focusable: 'false',
    'data-icon': name,
  });
  if (!def) {
    el.appendChild(svg('rect', { x: 5, y: 5, width: 14, height: 14, rx: 3, stroke: 'currentColor', 'stroke-width': 1.6 }));
    return el;
  }
  const p = svg('path', {
    d: def.d,
    fill: def.fill ? 'currentColor' : 'none',
    stroke: def.fill ? 'none' : 'currentColor',
    'stroke-width': opts.weight || 1.7,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  });
  el.appendChild(p);
  return el;
}

/* ------------------------------------------------------------------ */
/* layers — every floating surface lives in a known stacking context   */
/* ------------------------------------------------------------------ */

const LAYER_ORDER = { popover: 400, menu: 500, dialog: 600, toast: 700, drag: 800 };

export function layer(kind = 'popover') {
  const id = `layer-${kind}`;
  let root = document.getElementById(id);
  if (!root) {
    root = h('div', { id, class: `layer layer-${kind}`, style: { zIndex: LAYER_ORDER[kind] || 400 } });
    document.body.appendChild(root);
  }
  return root;
}

/* ------------------------------------------------------------------ */
/* anchored positioning                                                */
/* ------------------------------------------------------------------ */

/**
 * Anchor `el` to `anchorEl`, tracking scroll/resize until dispose() is called.
 * Collision handling flips the placement and, as a last resort, clamps inside
 * the viewport — the surface never becomes visually detached from its anchor,
 * and never renders off screen.
 *
 * opts: { placement:'bottom-start'|'bottom-end'|'top-start'|'right-start'|…,
 *         gap:number, matchWidth:boolean, onDetach:fn }
 */
export function anchorTo(el, anchorEl, opts = {}) {
  const gap = opts.gap ?? 6;
  const pad = 8;
  let disposed = false;

  function place() {
    if (disposed || !el.isConnected) return;
    if (!anchorEl.isConnected) { opts.onDetach?.(); return; }
    const a = anchorEl.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    if (opts.matchWidth) el.style.minWidth = `${Math.round(a.width)}px`;
    // measure after width is applied
    el.style.maxHeight = '';
    const r = el.getBoundingClientRect();
    const w = r.width, hgt = r.height;

    let [side, align] = String(opts.placement || 'bottom-start').split('-');
    const fits = {
      bottom: vh - a.bottom - gap >= hgt + pad,
      top: a.top - gap >= hgt + pad,
      right: vw - a.right - gap >= w + pad,
      left: a.left - gap >= w + pad,
    };
    if (!fits[side]) {
      const flip = { bottom: 'top', top: 'bottom', right: 'left', left: 'right' }[side];
      if (fits[flip]) side = flip;
    }

    let top, left;
    if (side === 'bottom' || side === 'top') {
      top = side === 'bottom' ? a.bottom + gap : a.top - gap - hgt;
      left = align === 'end' ? a.right - w : align === 'center' ? a.left + (a.width - w) / 2 : a.left;
      // vertical space is finite: cap the height and let the surface scroll
      const avail = side === 'bottom' ? vh - a.bottom - gap - pad : a.top - gap - pad;
      el.style.maxHeight = `${Math.max(140, Math.floor(avail))}px`;
    } else {
      left = side === 'right' ? a.right + gap : a.left - gap - w;
      top = align === 'end' ? a.bottom - hgt : align === 'center' ? a.top + (a.height - hgt) / 2 : a.top;
      el.style.maxHeight = `${Math.max(140, vh - 2 * pad)}px`;
    }
    left = clamp(left, pad, Math.max(pad, vw - w - pad));
    top = clamp(top, pad, Math.max(pad, vh - hgt - pad));
    el.style.position = 'fixed';
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
    el.dataset.side = side;
  }

  const relayout = throttleRaf(place);
  place();
  requestAnimationFrame(place);                 // after fonts/first paint settle
  window.addEventListener('resize', relayout);
  window.addEventListener('scroll', relayout, true);
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(relayout) : null;
  ro?.observe(el);
  ro?.observe(anchorEl);

  return {
    update: place,
    dispose() {
      disposed = true;
      window.removeEventListener('resize', relayout);
      window.removeEventListener('scroll', relayout, true);
      ro?.disconnect();
    },
  };
}

/* ------------------------------------------------------------------ */
/* focus                                                               */
/* ------------------------------------------------------------------ */

export const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(',');

export function focusables(root) {
  return Array.from(root.querySelectorAll(FOCUSABLE)).filter((el) => {
    if (el.getAttribute('aria-hidden') === 'true') return false;
    const r = el.getClientRects();
    return r.length > 0;
  });
}

/** Keeps Tab inside `root` while open. Returns dispose(). */
export function trapFocus(root) {
  function onKey(e) {
    if (e.key !== 'Tab') return;
    const list = focusables(root);
    if (!list.length) { e.preventDefault(); root.focus?.(); return; }
    const first = list[0], last = list[list.length - 1];
    if (e.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault(); first.focus();
    }
  }
  root.addEventListener('keydown', onKey);
  return () => root.removeEventListener('keydown', onKey);
}

/**
 * Roving tabindex over `selector` children of `container`. Used by the tab
 * strip, menus and toolbars so a composite widget is one tab stop.
 * opts: { orientation:'horizontal'|'vertical'|'both', loop:true, onActivate }
 */
export function rovingFocus(container, selector, opts = {}) {
  const orientation = opts.orientation || 'horizontal';
  const loop = opts.loop !== false;
  function items() { return Array.from(container.querySelectorAll(selector)).filter((el) => !el.hasAttribute('disabled')); }
  function sync(active) {
    const list = items();
    list.forEach((el) => { el.tabIndex = el === active ? 0 : -1; });
    if (!list.includes(active) && list.length) list[0].tabIndex = 0;
  }
  function move(delta) {
    const list = items();
    if (!list.length) return;
    const cur = list.indexOf(document.activeElement.closest(selector));
    let next = cur < 0 ? 0 : cur + delta;
    if (next < 0) next = loop ? list.length - 1 : 0;
    if (next >= list.length) next = loop ? 0 : list.length - 1;
    list[next].focus();
    sync(list[next]);
  }
  function onKey(e) {
    const horiz = orientation === 'horizontal' || orientation === 'both';
    const vert = orientation === 'vertical' || orientation === 'both';
    if (horiz && e.key === 'ArrowRight') { e.preventDefault(); move(1); }
    else if (horiz && e.key === 'ArrowLeft') { e.preventDefault(); move(-1); }
    else if (vert && e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (vert && e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Home') { e.preventDefault(); const l = items(); l[0]?.focus(); sync(l[0]); }
    else if (e.key === 'End') { e.preventDefault(); const l = items(); l[l.length - 1]?.focus(); sync(l[l.length - 1]); }
    else if ((e.key === 'Enter' || e.key === ' ') && opts.onActivate) {
      const it = document.activeElement.closest(selector);
      if (it) { e.preventDefault(); opts.onActivate(it, e); }
    }
  }
  container.addEventListener('keydown', onKey);
  container.addEventListener('focusin', (e) => { const it = e.target.closest(selector); if (it) sync(it); });
  sync(items()[0]);
  return { sync, dispose: () => container.removeEventListener('keydown', onKey) };
}

/** Remembers the focused element and restores it. Every popover uses this. */
export function focusMemory() {
  const prev = document.activeElement;
  return () => {
    if (prev && prev.isConnected && typeof prev.focus === 'function') {
      try { prev.focus({ preventScroll: true }); } catch { prev.focus(); }
    }
  };
}

/* ------------------------------------------------------------------ */
/* live region                                                         */
/* ------------------------------------------------------------------ */

let _politeRegion = null, _assertiveRegion = null;
function region(assertive) {
  const key = assertive ? '_a' : '_p';
  let el = assertive ? _assertiveRegion : _politeRegion;
  if (el && el.isConnected) return el;
  el = h('div', {
    class: 'sr-only', role: 'status', id: `live${key}`,
    'aria-live': assertive ? 'assertive' : 'polite', 'aria-atomic': 'true',
  });
  document.body.appendChild(el);
  if (assertive) _assertiveRegion = el; else _politeRegion = el;
  return el;
}

/** Announce to assistive technology without moving focus. */
export function announce(message, assertive = false) {
  const el = region(assertive);
  el.textContent = '';
  // a tick apart so repeated identical strings are still announced
  setTimeout(() => { el.textContent = String(message); }, 30);
}

/* ------------------------------------------------------------------ */
/* appearance targets                                                  */
/* ------------------------------------------------------------------ */

/**
 * Mark an element as editable by the appearance editor.
 *
 *   appearanceTarget(el, 'tab-strip', 'Session tab strip');
 *
 * The key is the persistence key under config theme.perElement; the label is
 * what the editor's header shows. Any element carrying data-ap gets the
 * "Edit appearance…" context-menu entry and the Shift+right-click shortcut
 * automatically — modules never wire that themselves.
 */
export function appearanceTarget(el, key, label) {
  el.dataset.ap = key;
  if (label) el.dataset.apLabel = label;
  return el;
}

/** Nearest appearance target from an event target, or null. */
export function closestAppearanceTarget(node) {
  return node && node.closest ? node.closest('[data-ap]') : null;
}

/* ------------------------------------------------------------------ */
/* misc                                                                */
/* ------------------------------------------------------------------ */

/** Escape a string for safe display inside a title/aria attribute. */
export function oneLine(s, max = 160) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Copy text to the clipboard, resolving to true/false — never throws. */
export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall through to the textarea path */ }
  try {
    const ta = h('textarea', { style: { position: 'fixed', opacity: 0, pointerEvents: 'none' } });
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

/** Offer `text` as a downloaded file without touching the network. */
export function downloadText(filename, text, mime = 'application/json') {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename, style: { display: 'none' } });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 1000);
}

/* ------------------------------------------------------------------ */
/* modal primitive                                                     */
/* ------------------------------------------------------------------ */

/**
 * A blocking modal dialog. RESERVED for decisions the user must make before
 * continuing — confirmations, destructive-action gates, unsaved-changes
 * prompts, credentials. Anything that only informs is a toast instead.
 *
 * openModal({ title, content, actions, label, onClose, width })
 *   content: Node or (close) => Node
 *   actions: [{ label, kind:'filled'|'text'|'danger', onSelect(close), autofocus }]
 *
 * ui/dialogs.js is expected to build its higher-level dialogs on this so the
 * scrim, focus trap, Escape handling and focus restoration are identical
 * everywhere.
 */
export function openModal(opts = {}) {
  const restore = focusMemory();
  const titleId = uid('modal-title');

  let scrim, dialog;
  function close(reason) {
    if (!scrim || !scrim.isConnected) return;
    untrap();
    document.removeEventListener('keydown', onKey, true);
    scrim.remove();
    opts.onClose?.(reason);
    restore();
  }

  const body = typeof opts.content === 'function' ? opts.content(close) : opts.content;
  const footer = h('div', { class: 'modal-actions' });
  let autofocusEl = null;
  for (const a of opts.actions || []) {
    const btn = h('button', {
      type: 'button',
      class: a.kind === 'filled' ? 'btn-filled' : a.kind === 'danger' ? 'btn-filled is-danger' : 'btn-text',
      onclick: () => { const keep = a.onSelect?.(close); if (keep !== true) close(a.id || 'action'); },
    }, a.label);
    if (a.disabled) btn.disabled = true;
    if (a.autofocus) autofocusEl = btn;
    if (a.ref) a.ref(btn);
    footer.appendChild(btn);
  }

  dialog = h('div', {
    class: 'modal surface-3', role: 'dialog', 'aria-modal': 'true',
    'aria-labelledby': titleId, tabindex: '-1',
    style: opts.width ? { maxWidth: `${opts.width}px` } : null,
  },
  h('h2', { class: 'modal-title', id: titleId }, opts.title || ''),
  h('div', { class: 'modal-body' }, body),
  (opts.actions || []).length ? footer : null);

  scrim = h('div', { class: 'modal-scrim' }, dialog);
  scrim.addEventListener('pointerdown', (e) => {
    if (e.target === scrim && opts.dismissOnScrim !== false) close('scrim');
  });

  layer('dialog').appendChild(scrim);
  const untrap = trapFocus(dialog);
  function onKey(e) {
    if (e.key === 'Escape' && dialog.contains(document.activeElement)) { e.stopPropagation(); close('escape'); }
  }
  document.addEventListener('keydown', onKey, true);

  requestAnimationFrame(() => {
    (autofocusEl || focusables(dialog)[0] || dialog).focus();
  });

  return { close, element: dialog, scrim };
}

/** Ask the user for a local file and resolve its text. */
export function pickTextFile(accept = '.json,application/json') {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, style: { display: 'none' } });
    input.addEventListener('change', () => {
      const f = input.files && input.files[0];
      if (!f) { input.remove(); resolve(null); return; }
      const fr = new FileReader();
      fr.onload = () => { input.remove(); resolve({ name: f.name, text: String(fr.result) }); };
      fr.onerror = () => { input.remove(); resolve(null); };
      fr.readAsText(f);
    });
    document.body.appendChild(input);
    input.click();
  });
}
