'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const R = pathToFileURL(path.join(__dirname, '..', 'design', 'renderer', 'ui', 'regexbuilder.js')).href;

let makePredicate;
test.before(async () => {
  ({ makePredicate } = await import(R));
});

test('regex search predicates reset sticky lastIndex for each field', () => {
  const predicate = makePredicate({ pattern: 'a', flags: 'y', mode: 'regex' });

  assert.equal(predicate.ok, true);
  assert.equal(predicate.test('a'), true);
  assert.equal(predicate.test('ba'), false, 'sticky matching still starts at the beginning of each field');
  assert.equal(predicate.test('a'), true, 'a later matching field is not poisoned by an earlier match');
});
