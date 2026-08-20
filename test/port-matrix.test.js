'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const MATRIX = path.join(ROOT, 'tools', 'port-matrix.js');
const REPORT = path.join(ROOT, 'docs', 'port-coverage.md');

test('the coverage check is read-only in a plain clone without the optional submodule', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'vendor', 'winscp', 'source')), false,
    'this regression must exercise the documented plain-clone path');
  const before = fs.readFileSync(REPORT);
  const result = spawnSync(process.execPath, [MATRIX, '--check'], {
    cwd: ROOT, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Checked docs[\\/]port-coverage\.md without the optional WinSCP source reference/);
  assert.match(result.stdout, /source comparison: skipped/);
  assert.deepEqual(fs.readFileSync(REPORT), before,
    'a check must not rewrite the generated report');
});

test('regeneration fails closed when the optional source reference is absent', () => {
  const result = spawnSync(process.execPath, [MATRIX], {
    cwd: ROOT, encoding: 'utf8',
  });
  assert.equal(result.status, 2, result.stderr || result.stdout);
  assert.match(result.stderr, /WinSCP source not found/);
});

test('area coverage uses each partial mapping progress value', () => {
  const source = fs.readFileSync(MATRIX, 'utf8');
  assert.match(source, /r\.lines \* r\.progress/,
    'area totals must use the mapping progress, not a hidden 50% default');
});
