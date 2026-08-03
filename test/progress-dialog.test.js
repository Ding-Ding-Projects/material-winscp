import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync('design/renderer/ui/dialogs/progress.js', 'utf8');

test('progress dialog remains a non-modal, keyboard-dismissible surface', () => {
  assert.match(source, /role: 'dialog', 'aria-modal': 'false'/);
  assert.match(source, /e\.key === 'Escape'.*close\(\)/s);
});

test('cancel is gated while the asynchronous queue request is pending', () => {
  assert.match(source, /if \(actionBusy\) return;/);
  assert.match(source, /actionBusy = true;\s+setStatus\(t\('txPgCancelling'\)\);\s+paint\(\);/);
  assert.match(source, /cancelBtn\.disabled = cancelBtn\.disabled \|\| actionBusy;/);
});

test('cancel failures remain visible and do not masquerade as success', () => {
  assert.match(source, /const message = err\?\.message \|\| String\(err \|\| 'Unknown error'\);/);
  assert.match(source, /setStatus\(t\('txPgActionFailed', message\), true\);/);
  assert.match(source, /notify\.error\(t\('txPgTitle'\), message\);/);
});

test('terminal queue state is announced and no longer offers transfer actions', () => {
  assert.match(source, /item\.state === 'done'\) setStatus\(t\('txPgFinished'\)\)/);
  assert.match(source, /item\.state === 'error'\) setStatus\(t\('txPgFinishedWithErrors'\), true\)/);
  assert.match(source, /const terminal = item\?\.state === 'done' \|\| item\?\.state === 'error' \|\| item\?\.state === 'cancelled'/);
  assert.match(source, /cancelBtn\.disabled = !item \|\| terminal;/);
  assert.match(source, /speedBtn\.disabled = !item \|\| terminal;/);
});

test('long paths use an accessible title while the value can shrink in narrow layouts', () => {
  assert.match(source, /value\.title = String\(text \?\? ''\);/);
  assert.match(source, /class: 'tx-pg-line-value'/);
  assert.match(source, /min-width: 0; flex: 1 1 auto/);
});

test('progress bars expose their visible labels to assistive technology', () => {
  assert.match(source, /id: uid\('tx-pg-label'\)/);
  assert.match(source, /node\.setAttribute\('aria-labelledby', label\.id\)/);
});
