'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const MATRIX = path.join(ROOT, 'tools', 'port-matrix.js');

// Copy real checkout inputs, but deliberately omit the optional source tree.
// CI initializes that submodule; the caller's checkout must not select this path.
function plainCloneFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'port-matrix-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const relative of ['tools/port-matrix.js', 'tools/port-map.json', 'docs/port-coverage.md']) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(ROOT, relative), target);
  }
  fs.mkdirSync(path.join(root, 'vendor', 'winscp'), { recursive: true });
  assert.equal(fs.existsSync(path.join(root, 'vendor', 'winscp', 'source')), false,
    'the fixture must exercise the documented plain-clone path');
  return { root, report: path.join(root, 'docs', 'port-coverage.md') };
}

function snapshot(root) {
  const entries = [];
  function visit(relative) {
    const absolute = path.join(root, relative);
    const stat = fs.statSync(absolute, { bigint: true });
    entries.push([relative, stat.mtimeNs.toString(),
      stat.isDirectory() ? null : fs.readFileSync(absolute)]);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(absolute).sort()) visit(path.join(relative, name));
    }
  }
  visit('');
  return entries;
}

function runUnchanged(fixture, args) {
  const before = snapshot(fixture.root);
  const result = spawnSync(process.execPath, [path.join(fixture.root, 'tools', 'port-matrix.js'), ...args], {
    cwd: fixture.root, encoding: 'utf8',
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.deepEqual(snapshot(fixture.root), before,
    'the command must not create, rewrite, or remove any fixture files');
  return result;
}

for (const ending of ['LF', 'CRLF']) {
  test(`the coverage check is read-only without optional source (${ending})`, (t) => {
    const fixture = plainCloneFixture(t);
    const report = fs.readFileSync(fixture.report, 'utf8').replace(/\r\n/g, '\n');
    fs.writeFileSync(fixture.report, ending === 'CRLF' ? report.replace(/\n/g, '\r\n') : report);
    const result = runUnchanged(fixture, ['--check']);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Checked docs[\\/]port-coverage\.md without the optional WinSCP source reference/);
    assert.match(result.stdout, /source comparison: skipped/);
  });
}

for (const ledger of ['missing', 'invalid']) {
  test(`the coverage check fails read-only for a ${ledger} ledger without optional source`, (t) => {
    const fixture = plainCloneFixture(t);
    if (ledger === 'missing') fs.unlinkSync(fixture.report);
    else fs.writeFileSync(fixture.report, '# An unrelated document\n');
    const result = runUnchanged(fixture, ['--check']);
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stderr, /docs\/port-coverage\.md is missing or is not a generated coverage ledger/);
    assert.doesNotMatch(result.stdout, /source comparison: skipped/);
  });
}

for (const ledger of ['existing', 'missing']) {
  test(`regeneration fails closed without optional source and a ${ledger} ledger`, (t) => {
    const fixture = plainCloneFixture(t);
    if (ledger === 'missing') fs.unlinkSync(fixture.report);
    const result = runUnchanged(fixture, []);
    assert.equal(result.status, 2, result.stderr || result.stdout);
    assert.match(result.stderr, /WinSCP source not found/);
    assert.match(result.stderr, /git submodule update --init --depth 1 vendor\/winscp/);
    assert.doesNotMatch(result.stdout, /Wrote/);
  });
}

test('area coverage uses each partial mapping progress value', () => {
  const source = fs.readFileSync(MATRIX, 'utf8');
  assert.match(source, /r\.lines \* r\.progress/,
    'area totals must use the mapping progress, not a hidden 50% default');
});
