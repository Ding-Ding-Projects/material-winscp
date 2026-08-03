import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../design/renderer/ui/dialogs/filefind.js', import.meta.url), 'utf8');

test('FileFind exposes a mask-anchored regex builder', () => {
  assert.match(source, /openRegexBuilder\(\{/);
  assert.match(source, /anchor:\s*regexMaskButton/);
  assert.match(source, /labelledRow\('ffMask', maskInput, regexMaskButton, editMaskButton\)/);
});

test('FileFind does not claim empty results while verification is pending', () => {
  assert.match(source, /pending > 0 \? tx\('ffChecking'\)/);
  assert.match(source, /ffChecking: \[/);
});

test('FileFind rejects late hits and verification callbacks', () => {
  assert.match(source, /if \(generation !== searchGeneration \|\| \(state !== 'finding' && state !== 'aborting'\)\) return;/);
  assert.match(source, /if \(generationAtStart !== searchGeneration\) return;/);
  assert.match(source, /searchGeneration \+= 1;\s*state = 'aborted';/);
});

test('FileFind makes result export keyboard reachable', () => {
  assert.match(source, /resultList\.addEventListener\('keydown', \(e\) => \{/);
  assert.match(source, /\(e\.ctrlKey \|\| e\.metaKey\) && e\.key\.toLowerCase\(\) === 'c'/);
  assert.match(source, /e\.preventDefault\(\);\s*copyResults\(\);/);
});

test('FileFind disables the regex builder while a search is running', () => {
  assert.match(source, /limitInput, editMaskButton, regexMaskButton,/);
});

test('FileFind reaches native grep, depth, and result limit options', () => {
  assert.match(source, /grep: textInput\.value \|\| undefined/);
  assert.match(source, /maxDepth: recursiveCheck\.input\.checked \? Infinity : 0/);
  assert.match(source, /limit: Math\.max\(1, Number\(limitInput\.value\) \|\| DEFAULT_LIMIT\)/);
});
