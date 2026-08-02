// lib/dimsum.js — the dim sum surprise.
//
// A 10% chance per visit of a dish appearing in the corner: its name in both
// languages and a photograph of it. It is a small delight, not a feature
// anybody manages — there is deliberately no setting to turn it off.
//
// What makes an un-optable surprise polite is everything it refuses to do. It
// never gates the page, never steals focus, never blocks a task, auto-dismisses
// itself, and makes exactly one chance check per load — called once from the
// boot path — so it can neither fire twice in a visit nor become more frequent
// than the 10% it advertises. The images are bundled
// locally from the repository's own catalog — no CDN, no third party, no
// tracking pixel wearing a dumpling costume.

import { h } from './dom.js';
import { text as T } from './i18n.js';

export const CHANCE = 0.10;
export const DISMISS_MS = 9000;

/** One draw. Separated from the DOM so the odds are testable rather than
 *  asserted in a comment. */
export function draw(catalog, random = Math.random) {
  if (!catalog || !catalog.length) return null;
  if (random() >= CHANCE) return null;
  return catalog[Math.min(catalog.length - 1, Math.floor(random() * catalog.length))];
}

export function maybeShowDimSum({ slot, data, store, random = Math.random }) {
  const dish = draw(data.catalog, random);
  if (!dish || !slot) return null;

  const opts = store.langOpts();
  const name = `${dish.en} · ${dish.zh}`;
  // Alt text names the dish, so a screen-reader user gets the same delight
  // rather than "image".
  const alt = T('dimsumAlt', opts, [dish.en, dish.zh]);

  const img = h('img.dimsum-img', { alt, width: '96', height: '96', loading: 'lazy', decoding: 'async' });
  img.src = `${data.base}assets/${dish.file}`;

  const card = h('aside.dimsum', { role: 'note', 'aria-label': `${T('dimsumIntro', opts)} — ${name}` },
    img,
    h('div.dimsum-text', null,
      h('p.dimsum-lead', { text: T('dimsumIntro', opts) }),
      h('p.dimsum-name', null,
        h('span.bi-primary', { text: dish.en }),
        h('span.bi-secondary', { text: `${dish.zh}${dish.jy ? ` · ${dish.jy}` : ''}` }))),
    h('button.dimsum-close', {
      type: 'button', 'aria-label': T('dismiss', opts), text: '✕',
      onclick: () => close(),
    }));

  slot.append(card);
  let timer = window.setTimeout(close, DISMISS_MS);
  card.addEventListener('pointerenter', () => { if (timer) { clearTimeout(timer); timer = null; } });
  card.addEventListener('pointerleave', () => { if (!timer) timer = window.setTimeout(close, 2500); });

  function close() {
    if (timer) clearTimeout(timer);
    card.dataset.closing = '1';
    window.setTimeout(() => card.remove(), 200);
  }
  return { close, dish };
}
