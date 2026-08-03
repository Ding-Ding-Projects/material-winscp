// e2e-notifications.test.js — the real renderer's persisted centre contract.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/app-harness');

async function waitFor(app, source, timeoutMs = 10000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await app.evaluate(source)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${source}`);
}

function notificationButton() {
  return [...document.querySelectorAll('button')]
    .find((el) => /notification/i.test(el.getAttribute('aria-label') || el.title || ''));
}

test('real renderer keeps an error notification reviewable after reload', async () => {
  const app = await startApp();
  try {
    const viewport = await app.resize(420, 260);
    await app.waitForRenderer(40, 30000);

    await app.evaluate(`window.dispatchEvent(new ErrorEvent('error', { message: 'renderer persistence smoke' }))`);
    await waitFor(app, '!!document.querySelector(".toast.is-error")');
    assert.equal(await app.evaluate('document.querySelector(".toast.is-error")?.getAttribute("aria-live")'), 'assertive');

    // Allow the renderer's existing coalesced config write to reach the real
    // main process before deliberately reloading the real renderer.
    await new Promise((resolve) => setTimeout(resolve, 500));
    await app.evaluate('location.reload()');
    await app.waitForRenderer(40, 30000);

    await app.evaluate(`(${notificationButton.toString()})()?.click()`);
    await waitFor(app, '!!document.querySelector(".nc")');
    const centre = await app.evaluate(`(() => {
      const root = document.querySelector('.nc');
      const item = [...document.querySelectorAll('.nc-item')]
        .find((el) => /renderer persistence smoke/.test(el.textContent || ''));
      const r = root?.getBoundingClientRect();
      return { found: !!item, role: root?.getAttribute('role'),
        left: r?.left, top: r?.top, right: r?.right, bottom: r?.bottom };
    })()`);
    assert.equal(centre.found, true, 'the persisted error is absent from the centre after reload');
    assert.equal(centre.role, 'dialog');
    assert.ok(centre.left >= 0 && centre.top >= 0
      && centre.right <= viewport.width + 1 && centre.bottom <= viewport.height + 1,
    `notification centre escaped the narrow viewport: ${JSON.stringify(centre)}`);
  } finally {
    await app.stop();
  }
});
