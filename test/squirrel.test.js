'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const squirrel = require('../design/main/squirrel');

test('Squirrel update completion runs once when Update.exe emits an error', async () => {
  const child = new EventEmitter();
  let calls = 0;
  const promise = new Promise((resolve) => {
    squirrel.runUpdate(['--createShortcut', 'app.exe'], () => {
      calls += 1;
      resolve();
    }, () => child);
  });

  child.emit('error', new Error('Update.exe unavailable'));
  child.emit('close', 1);
  await promise;
  assert.equal(calls, 1);
});

test('Squirrel update completion runs when Update.exe closes normally', async () => {
  const child = new EventEmitter();
  let calls = 0;
  squirrel.runUpdate([], () => { calls += 1; }, () => child);
  child.emit('close', 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
});
