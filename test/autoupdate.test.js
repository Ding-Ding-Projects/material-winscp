// autoupdate.test.js — the silent updater must stay silent, and must actually
// be capable of seeing a newer version.
//
// The failure mode this guards is nasty and quiet: an updater that is wired up,
// reports no errors, and never updates anything. That looks identical to an
// updater that works, right up until a release goes out and nobody receives it.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { AutoUpdater, FEED_HOST, REPO } = require('../design/main/autoupdate');

test('the feed URL is the shape update.electronjs.org expects', () => {
  const u = new AutoUpdater({ isPackaged: true });
  u.currentVersion = '0.1.4';
  const url = u.feedUrl();
  assert.strictEqual(url, `${FEED_HOST}/${REPO}/${process.platform}-${process.arch}/0.1.4`);
  assert.ok(url.startsWith('https://'), 'the update feed must be HTTPS');
});

test('an unpackaged build reports unsupported instead of pretending to work', () => {
  const u = new AutoUpdater({ isPackaged: false });
  assert.strictEqual(u.supported, false);
  u.start();
  assert.strictEqual(u.state, 'unsupported',
    'running from source must say so — an updater that silently does nothing is indistinguishable from one that works');
});

test('nothing is applied without an explicit request', () => {
  const u = new AutoUpdater({ isPackaged: false });
  // Not staged: applying must refuse rather than restart the app from under
  // someone mid-transfer.
  assert.strictEqual(u.applyAndRestart(), false);
});

test('the snapshot is passive information, never an instruction', () => {
  const u = new AutoUpdater({ isPackaged: false });
  const s = u.snapshot();
  assert.deepStrictEqual(Object.keys(s).sort(),
    ['currentVersion', 'lastCheck', 'staged'.concat('Version'), 'state', 'summary', 'supported'].sort());
  assert.strictEqual(s.summary, '', 'nothing to say when nothing is staged');
  // No field may read like a call to action.
  assert.ok(!/click|press|please|restart now|update now/i.test(JSON.stringify(s)));
});

test('the updater source contains no prompt, dialog or restart nag', () => {
  const src = fs.readFileSync(path.join(ROOT, 'design', 'main', 'autoupdate.js'), 'utf8');
  const code = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const forbidden of [/showMessageBox/, /dialog\./, /confirm\(/, /notify\./]) {
    assert.ok(!forbidden.test(code),
      `autoupdate.js must not raise UI: found ${forbidden}`);
  }
  // quitAndInstall must appear exactly once, inside the explicit apply path.
  const hits = (code.match(/quitAndInstall/g) || []).length;
  assert.strictEqual(hits, 1, 'quitAndInstall belongs only in the user-initiated path');
});

test('CI publishes a plain-semver tag whose version actually increments', () => {
  // Both of these were real defects. Every release shipped version 0.1.0, so
  // the .nupkg version never changed and Squirrel correctly found nothing new;
  // and the tag carried a `-build.N` prerelease suffix, which update feeds skip
  // and which semver sorts BEFORE the release it was built from.
  const raw = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  // Strip comments before asserting. The first version of this test failed on
  // the comment that explains why --prerelease is absent, which is a fine
  // reason to write a comment and a terrible reason to fail a build.
  //
  // The trailing \r has to go FIRST. `.` never matches a carriage return, so
  // against a CRLF checkout `/(^|\s)#.*$/` can never reach `$` and every
  // comment survives intact — the same explanatory comment then fails the
  // build again, but only on Windows, where the difference is invisible.
  const ci = raw.split('\n')
    .map((l) => l.replace(/\r$/, '').replace(/(^|\s)#.*$/, ''))
    .join('\n');

  assert.ok(!/tag=v\$\{\{ steps\.pkg\.outputs\.version \}\}-build\./.test(ci),
    'the release tag must not carry a prerelease suffix');
  assert.match(ci, /npm version "\$version" --no-git-tag-version/,
    'the build must set a real, increasing package version before packaging');
  assert.match(ci, /version="\$\{major\}\.\$\{minor\}\.\$\{\{ github\.run_number \}\}"/,
    'the patch component must come from the monotonic run number');
  assert.match(ci, /--latest/,
    'the release must be marked latest, or the update feed will not serve it');
  assert.ok(!/--prerelease/.test(ci), 'a prerelease is never served to updaters');
  assert.ok(!/--draft\b/.test(ci), 'a draft release is not published');
});

test('the update feed points at a public repository', () => {
  // update.electronjs.org only serves public repositories. If this ever moves
  // private, silent updates stop working and the failure is invisible.
  assert.match(REPO, /^[\w.-]+\/[\w.-]+$/);
  assert.strictEqual(FEED_HOST, 'https://update.electronjs.org');
});
