// lib/dom.js — the small amount of DOM plumbing every component shares.
//
// Deliberately tiny: an element factory, an anchoring routine, focus memory,
// and a live-region announcer. Everything else is plain DOM. There is no
// framework here because the site must load as plain ES modules with no build
// step, and a hand-rolled framework is a build step you cannot see.

let seq = 0;
export const uid = (p = 'id') => `${p}-${++seq}`;
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * h('button.icon', { onclick, 'aria-label': … }, child, child)
 *
 * A leading `tag.class.class` shorthand keeps call sites readable. Anything
 * whose key starts with `on` becomes a listener; `dataset` and `style` take
 * objects; everything else is a real attribute, so a caller cannot accidentally
 * set a property where an attribute was needed (the usual cause of an
 * `aria-*` that assistive technology never sees).
 */
export function h(spec, props = null, ...children) {
  const [tag, ...classes] = String(spec).split('.');
  const el = document.createElement(tag || 'div');
  if (classes.length) el.className = classes.join(' ');
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'text') el.textContent = v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

/**
 * Position a floating surface beside the element that opened it, and KEEP it
 * there while it is open.
 *
 * An anchored popover that detaches on scroll reads as a bug even when the
 * content is right, and one that paints off the viewport edge reads as missing
 * entirely. So: flip above when there is no room below, slide horizontally to
 * stay on screen, and bound the height to the space actually available with
 * `overflow:auto` — a capped height with hidden overflow silently deletes the
 * last week of a calendar and the last items of a menu, with no scrollbar to
 * say anything is missing.
 */
export function anchorTo(panel, anchor, opts = {}) {
  const gap = opts.gap ?? 8;
  const place = () => {
    const a = anchor.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    panel.style.maxHeight = '';
    const p = panel.getBoundingClientRect();
    const below = vh - a.bottom - gap * 2;
    const above = a.top - gap * 2;
    const flip = below < Math.min(p.height, 220) && above > below;
    const room = Math.max(120, flip ? above : below);
    panel.style.maxHeight = `${room}px`;
    const top = flip ? Math.max(gap, a.top - Math.min(p.height, room) - gap) : a.bottom + gap;
    let left = opts.align === 'right' ? a.right - p.width : a.left;
    left = clamp(left, gap, Math.max(gap, vw - p.width - gap));
    panel.style.top = `${Math.round(top)}px`;
    panel.style.left = `${Math.round(left)}px`;
    panel.dataset.flipped = flip ? '1' : '0';
  };
  place();
  const onScroll = () => place();
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onScroll);
  return () => {
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onScroll);
  };
}

/**
 * Open a dismissible anchored surface. Returns `close()`.
 *
 * Focus goes back to whatever opened it — a popover that leaves focus on
 * `<body>` has stranded every keyboard user at the top of the document.
 */
export function openPopover({ anchor, panel, layer, onClose, align }) {
  const previous = document.activeElement;
  layer.append(panel);
  const unanchor = anchorTo(panel, anchor, { align });
  if (anchor.setAttribute) anchor.setAttribute('aria-expanded', 'true');

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    unanchor();
    panel.remove();
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('pointerdown', onDown, true);
    if (anchor.setAttribute) anchor.setAttribute('aria-expanded', 'false');
    if (previous && previous.focus) previous.focus();
    if (onClose) onClose();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
    if (e.key !== 'Tab') return;
    // Keep Tab inside the surface while it is open, so the sequence a keyboard
    // user experiences matches what a sighted user sees floating on top.
    const items = focusables(panel);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  const onDown = (e) => {
    if (!panel.contains(e.target) && !anchor.contains(e.target)) close();
  };
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('pointerdown', onDown, true);

  const first = focusables(panel)[0];
  if (first) first.focus();
  return close;
}

export function focusables(root) {
  return $$('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),'
    + 'textarea:not([disabled]),[tabindex]:not([tabindex="-1"])', root)
    .filter((el) => el.offsetParent !== null || el === document.activeElement);
}

/** Announce to assistive technology without moving focus or drawing anything. */
let liveRegion = null;
export function announce(message, assertive = false) {
  if (!liveRegion) {
    liveRegion = h('div.sr-only', { 'aria-live': 'polite', 'aria-atomic': 'true' });
    document.body.append(liveRegion);
  }
  liveRegion.setAttribute('aria-live', assertive ? 'assertive' : 'polite');
  liveRegion.textContent = '';
  // A same-text update is not an update to a live region; the empty frame in
  // between is what makes a repeated announcement actually announce.
  window.setTimeout(() => { liveRegion.textContent = message; }, 30);
}

/** Copy without assuming the async clipboard exists (it does not on an
 *  insecure origin, which is exactly how somebody previews this site). */
export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return { ok: true };
    }
  } catch { /* fall through to the legacy path */ }
  try {
    const ta = h('textarea', { style: { position: 'fixed', opacity: '0', pointerEvents: 'none' } });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok ? { ok: true } : { ok: false, error: 'the browser refused the copy' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Offer text as a file download, from a blob URL that is revoked afterwards. */
export function downloadText(filename, text, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Read a file the user picked. Returns null when they cancel. */
export function pickFile(accept = 'application/json') {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, style: { display: 'none' } });
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      if (!file) { input.remove(); resolve(null); return; }
      const reader = new FileReader();
      reader.onload = () => { input.remove(); resolve({ name: file.name, text: String(reader.result) }); };
      reader.onerror = () => { input.remove(); resolve(null); };
      reader.readAsText(file);
    });
    document.body.append(input);
    input.click();
  });
}

/** Draw attention to a control the command palette or a settings search just
 *  teleported the reader to. Landing them on the right tab and leaving them to
 *  hunt does not count as arriving. */
export function flashTarget(el) {
  if (!el) return;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.remove('flash-target');
  void el.offsetWidth;                    // restart the animation
  el.classList.add('flash-target');
  window.setTimeout(() => el.classList.remove('flash-target'), 2200);
  const focusTarget = el.matches('input,select,button,textarea') ? el : focusables(el)[0];
  if (focusTarget) focusTarget.focus({ preventScroll: true });
}
