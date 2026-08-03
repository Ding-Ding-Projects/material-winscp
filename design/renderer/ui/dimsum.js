// ui/dimsum.js — the startup dim sum surprise.
//
// A 10% chance per launch of a small delight: a randomly chosen dim sum dish,
// named in both languages, with its bundled local image.
//
// The rules this implements, exactly:
//   * a FRESH random draw per launch — never a schedule, never more frequent
//     than one in ten, and never twice in the same launch
//   * non-blocking and auto-dismissing: it never gates startup, never delays
//     the app becoming usable, and never takes focus
//   * never during a first run, and never on an error path
//   * bundled local images only — no network fetch, no CDN, no tracking
//   * alt text names the dish, so a screen-reader user gets the same delight
//   * reduced motion and quiet settings are respected
//   * there is NO opt-out. This module deliberately exposes no setting to
//     disable it, and migrateAwayFromOptOut() removes any that an older
//     profile carried, so old profiles simply rejoin the draw.

import { h, layer, uid, announce } from '../dom.js';
import { t, tPair, getLanguage } from '../i18n.js';
import { store, persistCurrent, api, hasBridge, LAUNCH_ID, bus } from '../state.js';
import { DISHES } from '../../winscp-data.js';

export const CHANCE = 0.10;
const VISIBLE_MS = 8000;

/** Resolve only the verified bundled PNGs when the bridge is unavailable. */
export function localAssetUrl(value) {
  const source = String(value || '');
  if (/^data:image\//i.test(source) || /^file:/i.test(source)) return source;
  const name = source.replace(/^.*[\\/]/, '');
  if (!/^dim-\d+-[a-z0-9-]+\.png$/i.test(name)) return '';
  return new URL(`../../assets/${name}`, import.meta.url).href;
}

/** Prefer main's validated data URI; reject remote or malformed records. */
export function normalizeDish(dish) {
  if (!dish) return null;
  const img = localAssetUrl(dish.dataUri || dish.img);
  if (!img || !(dish.en || dish.zh)) return null;
  return { ...dish, img };
}

let drawnThisLaunch = false;

function reducedMotion() {
  return !!store.get('theme.reduceMotion')
    || (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
}

/**
 * Older profiles may carry an opt-out flag from before the rule was settled.
 * It is removed rather than honoured, so those profiles rejoin the draw.
 */
export function migrateAwayFromOptOut() {
  const ds = store.get('dimSum') || {};
  if ('enabled' in ds || 'disabled' in ds || 'optOut' in ds) {
    const next = { ...ds };
    delete next.enabled;
    delete next.disabled;
    delete next.optOut;
    store.set('dimSum', next);
    persistCurrent('dimSum');
  }
}

/** A dish from main's catalog if it has one, otherwise the bundled list. */
async function pickDish() {
  try {
    const fromMain = await api.dimSumRandom();
    const normalized = normalizeDish(fromMain);
    if (normalized) return normalized;
  } catch { /* the bundled catalog is the floor, never a network call */ }
  const seen = new Set((store.get('dimSum.seen') || []).slice(-3));
  const fresh = DISHES.filter((d) => !seen.has(d.id));
  const pool = fresh.length ? fresh : DISHES;
  return normalizeDish(pool[Math.floor(Math.random() * pool.length)]);
}

/**
 * Show the card. Exported so an About screen or a test can display one
 * deliberately; the automatic path is maybeShowDimSum().
 */
export function showDish(dish) {
  if (!dish) return null;
  const heading = t('dsSurprise');
  const pair = { en: dish.en || dish.zh, yue: dish.zh || dish.en };
  const lang = getLanguage();
  const nameText = lang === 'en' ? pair.en : lang === 'yue' ? pair.yue : `${pair.en} · ${pair.yue}`;
  const alt = `${pair.en} (${pair.yue})${dish.jy ? ` — ${dish.jy}` : ''}`;
  const id = uid('dimsum');

  const img = h('img', {
    class: 'ds-img', src: dish.img, alt, width: 96, height: 96, draggable: 'false',
    loading: 'eager', decoding: 'async',
  });
  // A missing asset must never leave a broken image in the corner.
  img.addEventListener('error', () => { card.remove(); });

  const card = h('div', {
    class: `ds-card${reducedMotion() ? ' no-motion' : ''}`,
    id, role: 'status', 'aria-live': 'polite',
    // Not focusable and not modal: it never steals focus or blocks anything.
    'aria-label': `${heading}: ${alt}`,
  },
  img,
  h('div', { class: 'ds-main' },
    h('div', { class: 'ds-head' }, heading),
    h('div', { class: 'ds-name' },
      h('span', { class: 'ds-name-en' }, pair.en),
      h('span', { class: 'ds-name-zh', lang: 'yue-Hant-HK' }, pair.zh || pair.yue)),
    dish.jy ? h('div', { class: 'ds-jy' }, dish.jy) : null),
  h('button', {
    type: 'button', class: 'ds-close icon-btn', 'aria-label': t('close'), title: t('close'),
    onclick: () => dismiss(),
  }, h('span', { 'aria-hidden': 'true' }, '×')));

  layer('toast').appendChild(card);

  let timer = setTimeout(dismiss, VISIBLE_MS);
  card.addEventListener('mouseenter', () => clearTimeout(timer));
  card.addEventListener('mouseleave', () => { timer = setTimeout(dismiss, 2500); });

  function dismiss() {
    clearTimeout(timer);
    if (!card.isConnected) return;
    card.classList.add('is-leaving');
    if (reducedMotion()) card.remove();
    else setTimeout(() => card.remove(), 220);
  }

  announce(`${heading}: ${alt}`);
  const seen = (store.get('dimSum.seen') || []).concat(dish.id).slice(-20);
  store.set('dimSum', { ...(store.get('dimSum') || {}), seen, lastLaunchId: LAUNCH_ID });
  persistCurrent('dimSum');
  api.dimSumSeen(dish.id);
  bus.emit('dimsum:shown', { dish });

  return { dismiss, element: card, dish };
}

/**
 * The automatic path. Call once, after the shell is interactive.
 *
 * WHO ROLLS THE DICE. When the preload bridge is present, the MAIN process
 * owns the draw: it decides once per launch and pushes `event:dimsum`. The
 * renderer only listens, so the renderer cannot re-roll and the chance stays
 * exactly one in ten rather than compounding. Without a bridge (a plain
 * browser), this module does the draw itself so the behaviour is the same.
 *
 * opts.firstRun   skip when true (main checks this too)
 * opts.errorPath  skip when the launch is recovering from an error
 * opts.busy       skip when the user is mid-task
 */
export async function maybeShowDimSum(opts = {}) {
  if (drawnThisLaunch) return null;         // never twice in one launch
  drawnThisLaunch = true;

  migrateAwayFromOptOut();

  if (opts.errorPath || opts.busy || opts.firstRun) return null;

  if (hasBridge()) {
    // Main is authoritative. Listen once; if it never fires, this launch
    // simply lost the draw, which is the correct outcome nine times in ten.
    let shown = false;
    try {
      window.api.on('event:dimsum', (dish) => {
        if (shown || !dish) return;
        shown = true;
        showDish({ ...dish, img: dish.dataUri || dish.img });
      });
    } catch (err) {
      console.warn('[dimsum] the event channel is unavailable:', err?.message || err);
    }
    return null;
  }

  try { if (await api.isFirstRun()) return null; } catch { /* not fatal */ }

  // A fresh draw, this launch. Not a counter, not a schedule.
  if (Math.random() >= CHANCE) {
    bus.emit('dimsum:skipped', { reason: 'draw' });
    return null;
  }

  const dish = await pickDish();
  return showDish(dish);
}

/** True once the draw has happened this launch, whatever its outcome. */
export function drawnAlready() { return drawnThisLaunch; }

export { DISHES, tPair };
