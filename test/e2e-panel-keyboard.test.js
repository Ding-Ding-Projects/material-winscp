// e2e-panel-keyboard.test.js — real Commander panel keyboard boundaries.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { startApp } = require('./helpers/app-harness');

async function waitFor(check, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error('panel condition did not become true');
}

function keydown(key) {
  return `(() => { const view = document.querySelector('.fp-local .fp-view');
    view.focus(); view.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true })); })()`;
}

test('Commander Insert selects the focused last row, not its predecessor', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'winscp-panel-keyboard-'));
  await fsp.writeFile(path.join(dir, 'first.txt'), '1');
  await fsp.writeFile(path.join(dir, 'last.txt'), '2');
  const app = await startApp();
  try {
    await app.waitForRenderer(40);
    const encodedPath = JSON.stringify(dir);
    await app.evaluate(`(() => { const input = document.querySelector('input[aria-label="Local"], input[aria-label="Local panel"]');
      input.value = ${encodedPath}; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
    // A Windows runner may start in a populated checkout directory. Waiting
    // only for a row count can therefore observe the old listing before the
    // requested temp directory has arrived; wait for the exact fixture row.
    await waitFor(() => app.evaluate(`!!document.querySelector('.fp-local .fp-row[data-name="last.txt"]')`));

    await app.evaluate(keydown('End'));
    // The real panel may still be completing the directory render when the
    // synthetic key event returns.  Wait for the observable focus state before
    // sending the dependent Insert command, or a slow runner can apply Insert
    // to the old first row while the End render is still queued.
    await waitFor(() => app.evaluate(`document.querySelector('.fp-local .fp-row.is-focus')?.dataset.name === 'last.txt'`));
    await app.evaluate(keydown('Insert'));
    const state = await app.evaluate(`(() => ({
      focused: document.querySelector('.fp-local .fp-row.is-focus')?.dataset.name || null,
      selected: Array.from(document.querySelectorAll('.fp-local .fp-row[aria-selected="true"]')).map((row) => row.dataset.name),
    }))()`);
    assert.equal(state.focused, 'last.txt');
    assert.deepEqual(state.selected, ['last.txt']);
  } finally {
    await app.stop();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
