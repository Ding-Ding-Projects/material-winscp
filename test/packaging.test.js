'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const forge = require('../forge.config');
const workflow = require('fs').readFileSync(require('path').join(__dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { verify } = require('../build/verify-squirrel-artifacts');

function isIgnored(relativePath) {
  const normalized = `/${relativePath.replaceAll('\\', '/')}`;
  return forge.packagerConfig.ignore.some((pattern) =>
    pattern instanceof RegExp ? pattern.test(normalized) : new RegExp(pattern).test(normalized));
}

test('packaging excludes linked-agent worktrees from the shipped app', () => {
  assert.equal(isIgnored('.claude/worktrees/example/node_modules'), true);
});

test('packaging excludes its own output directory', () => {
  assert.equal(isIgnored('out/WinSCP Material-win32-x64/resources/app.asar'), true);
});

test('CI refuses an incomplete Squirrel update set', () => {
  assert.match(workflow, /missing=\(\)/);
  assert.match(workflow, /missing\+=\("\.nupkg"\)/);
  assert.match(workflow, /missing\+=\("RELEASES"\)/);
  assert.match(workflow, /required Squirrel artefacts/);
});

test('CI requires a tracked, decodable dim sum photo before publishing', () => {
  assert.match(workflow, /No verified dim sum photo is available; issue #15 requires every release to carry one/);
  assert.match(workflow, /design\/assets\/\*\.png/);
  assert.match(workflow, /git ls-files --error-unmatch/);
  assert.match(workflow, /Dim sum asset is not tracked in the repository/);
  assert.match(workflow, /echo "::error::No verified dim sum photo[\s\S]*?exit 1/);
  assert.doesNotMatch(workflow, /shipping without one/);
});

test('Forge declares the real Windows Squirrel maker and workflow release gate', () => {
  const squirrel = forge.makers.find((maker) => maker.name === '@electron-forge/maker-squirrel');
  assert.ok(squirrel, 'the Windows installer maker must be configured');
  assert.deepEqual(squirrel.platforms, ['win32']);
  assert.equal(squirrel.config.name, 'winscp_material');
  assert.equal(squirrel.config.exe, 'WinSCPMaterial.exe');
  assert.equal(squirrel.config.noMsi, true);
  assert.equal(squirrel.config.iconUrl, undefined, 'Forge must not publish a URL for an untracked icon product');

  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /tags-ignore:\s*\r?\n\s*-\s*'\*\*'/);
  assert.match(workflow, /release:\s*\r?\n[\s\S]*?needs:\s*test/);
  assert.match(workflow, /gh release create[\s\S]*?--target/);
  assert.match(workflow, /--latest/);
});

test('Squirrel verification rejects a truthful-looking but mismatched RELEASES file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'winscp-squirrel-'));
  try {
    const setup = path.join(dir, 'WinSCP Material 0.1.0 Setup.exe');
    const nupkg = path.join(dir, 'winscp_material-0.1.0-full.nupkg');
    const releases = path.join(dir, 'RELEASES');
    fs.writeFileSync(setup, 'installer');
    fs.writeFileSync(nupkg, 'package');
    fs.writeFileSync(releases, `${'0'.repeat(40)} ${path.basename(nupkg)} 7\n`);
    assert.throws(() => verify({ setup, nupkg, releases }), /SHA-1 does not match/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Squirrel verification accepts the exact hash and byte count in RELEASES', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'winscp-squirrel-'));
  try {
    const setup = path.join(dir, 'WinSCP Material 0.1.0 Setup.exe');
    const nupkg = path.join(dir, 'winscp_material-0.1.0-full.nupkg');
    const releases = path.join(dir, 'RELEASES');
    const body = Buffer.from('package');
    fs.writeFileSync(setup, 'installer');
    fs.writeFileSync(nupkg, body);
    const sha1 = crypto.createHash('sha1').update(body).digest('hex');
    fs.writeFileSync(releases, `${sha1} ${path.basename(nupkg)} ${body.length}\n`);
    assert.equal(verify({ setup, nupkg, releases }).nupkg.sha1, sha1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
