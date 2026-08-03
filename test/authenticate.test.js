'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'design', 'renderer', 'ui', 'dialogs', 'authenticate.js'), 'utf8');

test('host-key acceptance closes only after answer delivery succeeds', () => {
  assert.match(source, /function accept\(remember, close\)/);
  assert.match(source, /if \(!ok\) return;\s*answered = true;\s*close\?\.\('action'\)/);
  assert.match(source, /onSelect: \(close\) => \{ accept\(false, close\); return true; \}/);
});

test('changed host-key replacement keeps the second confirmation before delivery', () => {
  assert.match(source, /defaultAnswer: 'no'/);
  assert.match(source, /if \(r\.answer === 'yes'\) accept\(true, close\)/);
  assert.doesNotMatch(source, /if \(r\.answer === 'yes'\) \{ accept\(true\); close\(\); \}/);
});

test('certificate acceptance has the same retry-safe delivery semantics', () => {
  assert.match(source, /function accept\(remember, close\)/g);
  assert.match(source, /txCertAcceptOnce.*onSelect: \(close\) => \{ accept\(false, close\); return true; \}/s);
  assert.match(source, /txCertAcceptStore.*onSelect: \(close\) => \{ accept\(true, close\); return true; \}/s);
});
