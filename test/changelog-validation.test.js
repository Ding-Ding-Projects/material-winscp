'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const ROOT = path.join(__dirname, '..');
function fixture(t) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'changelog-validation-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  fs.mkdirSync(path.join(repo, 'tools'));
  fs.copyFileSync(path.join(ROOT, 'tools/changelog.js'), path.join(repo, 'tools/changelog.js'));
  fs.mkdirSync(path.join(repo, 'design/renderer/ui'), { recursive: true });
  const target = path.join(repo, 'design/renderer/ui/changelog.js');
  const original = 'export const DEVELOPMENT = [\n];\n';
  fs.writeFileSync(target, original);
  const git = (...args) => cp.execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(repo, 'product.txt'), 'fixture product change\n');
  git('init', '-q');
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Add fixture');
  return { repo, target, original, git };
}

for (const mode of ['missing', 'blob']) {
  test(`generator rejects a ${mode} object and preserves the target`, (t) => {
    const { repo, target, original, git } = fixture(t);
    const oid = mode === 'missing' ? 'f'.repeat(40) : git('rev-parse', 'HEAD:tools/changelog.js');
    // Inject only the log record; cat-file still inspects a real Git database.
    const preload = path.join(repo, 'log-record.cjs');
    fs.writeFileSync(preload, `const cp = require('node:child_process');
const real = cp.execFileSync;
cp.execFileSync = function(file, args, options) {
  if (file === 'git' && args.includes('log')) return real(file, args, options) + ${JSON.stringify([oid, oid.slice(0, 7), '2026-08-03T00:00:00Z', 'Fixture', ''].join('\x1f') + '\x1e')};
  return real(file, args, options);
};\n`);
    for (const args of [[], ['--check']]) {
      const result = cp.spawnSync(process.execPath, ['--require', preload, path.join(repo, 'tools/changelog.js'), ...args], { encoding: 'utf8' });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /[Cc]hangelog.*verif/);
      assert.equal(fs.readFileSync(target, 'utf8'), original);
    }
  });
}

test('broken nested checkout metadata cannot borrow its parent history', (t) => {
  const { repo } = fixture(t);
  const nested = path.join(repo, 'nested');
  fs.mkdirSync(path.join(nested, 'tools'), { recursive: true });
  fs.mkdirSync(path.join(nested, '.git'));
  fs.copyFileSync(path.join(ROOT, 'tools/changelog.js'), path.join(nested, 'tools/changelog.js'));
  const result = cp.spawnSync(process.execPath, ['-e', 'require("./tools/changelog").collect()'], { cwd: nested, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not a git repository/);
});

test('a healthy linked worktree retains its verified commit ledger', (t) => {
  const { repo, git } = fixture(t);
  const worktree = path.join(repo, 'linked');
  git('worktree', 'add', '--detach', worktree, 'HEAD');
  assert.ok(fs.statSync(path.join(worktree, '.git')).isFile());
  const result = cp.spawnSync(process.execPath, ['-e', 'console.log(JSON.stringify(require("./tools/changelog").collect()))'], { cwd: worktree, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout)[0].oid, git('rev-parse', 'HEAD'));
});

for (const variable of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY']) {
  test(`ambient ${variable} cannot select a foreign changelog`, (t) => {
    const own = fixture(t);
    fs.writeFileSync(path.join(own.repo, 'product.txt'), 'own checkout change\n');
    own.git('add', 'product.txt');
    own.git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Own history');
    const foreign = fixture(t);
    foreign.git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'Foreign history');
    const target = variable === 'GIT_WORK_TREE' ? foreign.repo
      : variable === 'GIT_OBJECT_DIRECTORY' ? path.join(foreign.repo, '.git/objects')
      : path.join(foreign.repo, '.git');
    const env = { ...process.env, [variable]: target };
    if (variable === 'GIT_WORK_TREE') env.GIT_DIR = path.join(foreign.repo, '.git');
    const result = cp.spawnSync(process.execPath, ['-e', 'console.log(JSON.stringify(require("./tools/changelog").collect()))'], { cwd: own.repo, encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout)[0].oid, own.git('rev-parse', 'HEAD'));
  });
}
