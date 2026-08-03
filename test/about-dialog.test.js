import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync('design/renderer/ui/dialogs/about.js', 'utf8');

test('About exposes copy-details as a reachable dialog action', () => {
  assert.match(source, /\{ label: s\('abCopyDetails'\), kind: 'text', onSelect: \(\) => \{ body\.copyDetails\(\); return true; \} \}/);
});

test('copy-details action keeps the existing truthful clipboard feedback path', () => {
  assert.match(source, /const ok = await copyText\(detailsText\(\)\);/);
  assert.match(source, /if \(ok\) notify\.success\(t\('aboutMenu'\), s\('abCopied'\)\);/);
  assert.match(source, /else notify\.error\(t\('aboutMenu'\), s\('abCopyFailed'\)\);/);
});
