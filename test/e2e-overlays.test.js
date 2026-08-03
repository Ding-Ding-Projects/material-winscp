// e2e-overlays.test.js — a narrow real-renderer smoke for floating surfaces.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/app-harness');

async function waitFor(app, source, timeoutMs = 8000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await app.evaluate(source)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${source}`);
}

function rectProbe(selector) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom,
      width: r.width, height: r.height, scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight, overflowY: s.overflowY,
      background: s.backgroundColor, backgroundImage: s.backgroundImage };
  })()`;
}

test('real renderer keeps regex, menu and queue surfaces painted and in viewport', async () => {
  const app = await startApp();
  try {
    await app.waitForRenderer(40, 30000);
    const viewport = await app.resize(420, 260);
    assert.ok(viewport.width <= 420 && viewport.height <= 260,
      `the Electron smoke did not enter the requested narrow viewport: ${JSON.stringify(viewport)}`);

    await app.evaluate(`(() => {
      const button = [...document.querySelectorAll('button')]
        .find((el) => el.classList.contains('sb-rb'));
      if (!button) throw new Error('no regex-builder button was rendered');
      button.click();
    })()`);
    await waitFor(app, '!!document.querySelector(".rb-popover")');
    const regex = await app.evaluate(rectProbe('.rb-popover'));
    assert.ok(regex.left >= 0 && regex.top >= 0 && regex.right <= viewport.width + 1 && regex.bottom <= viewport.height + 1,
      `regex builder escaped the viewport: ${JSON.stringify(regex)}`);
    assert.notEqual(regex.background, 'rgba(0, 0, 0, 0)', 'regex builder is transparent');
    assert.match(regex.overflowY, /auto|scroll/, 'regex builder has no scroll contract');

    await app.evaluate('document.querySelector(".rb-popover .rb-head button")?.click()');
    await waitFor(app, '!document.querySelector(".rb-popover")');
    await app.evaluate(`(() => {
      const button = [...document.querySelectorAll('button')]
        .find((el) => /queue/i.test(el.title || el.getAttribute('aria-label') || ''));
      if (!button) throw new Error('no queue button was rendered');
      button.click();
    })()`);
    await waitFor(app, '!!document.querySelector(".tx-q-popover")');
    const queue = await app.evaluate(rectProbe('.tx-q-popover'));
    assert.ok(queue.left >= 0 && queue.top >= 0 && queue.right <= viewport.width + 1 && queue.bottom <= viewport.height + 1,
      `queue popover escaped the viewport: ${JSON.stringify(queue)}`);
    assert.notEqual(queue.background, 'rgba(0, 0, 0, 0)', 'queue popover is transparent');
    assert.equal(queue.overflowY, 'hidden');
  } finally {
    await app.stop();
  }
});
