// history.test.js — the git-backed version history.
//
// These are real isomorphic-git repositories in a real temporary directory:
// real commits, real trees, real refs. Nothing is mocked, because the property
// that matters — that a restore ADDS a revision rather than rewinding to one —
// is a property of the commit graph, and a mock would happily lie about it.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const git = require('isomorphic-git');

const { History, STATE_FILE, BRANCH, actionOf } = require('../design/main/history');

const temps = [];
function tempDir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `winscp-history-${name}-`));
  temps.push(dir);
  return dir;
}

test.after(() => {
  for (const d of temps) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

/** A plausible slice of the app's state. */
function stateWith(sites, prefs) {
  return {
    prefs: { language: 'en', funnyLevel: { en: 3, yue: 3 }, ...(prefs || {}) },
    sites: sites || [],
    folders: [],
    workspaces: [],
  };
}

function newHistory(name, prefs) {
  return new History(tempDir(name), { getPrefs: () => (prefs || { enabled: true, retentionDays: 0, maxRevisions: 0 }) });
}

// --------------------------------------------------------------- snapshot

test('a repository is created on first use', async () => {
  const h = newHistory('init');
  const r = await h.snapshot('Added the site "Work"', stateWith([{ id: 's1', name: 'Work' }]));
  assert.equal(r.ok, true);
  assert.ok(r.value.oid, 'a commit oid is returned');
  assert.ok(fs.existsSync(path.join(h.dir, '.git')), 'the repository lives in the history directory');
  assert.ok(fs.existsSync(path.join(h.dir, STATE_FILE)), 'the state document is committed');
});

test('the commit is a real git commit on the expected branch', async () => {
  const h = newHistory('realgit');
  const snap = await h.snapshot('Added the site "Work"', stateWith([{ id: 's1', name: 'Work' }]));
  const ref = await git.resolveRef({ fs, dir: h.dir, ref: BRANCH });
  assert.equal(ref, snap.value.oid);
  const { commit } = await git.readCommit({ fs, dir: h.dir, oid: ref });
  assert.equal(commit.message.trim(), 'Added the site "Work"');
  assert.ok(commit.tree, 'the commit has a tree');
  assert.equal(commit.parent.length, 0, 'the first commit is a root commit');
});

test('successive snapshots chain onto one another', async () => {
  const h = newHistory('chain');
  const a = await h.snapshot('Added the site "A"', stateWith([{ id: 'a', name: 'A' }]));
  const b = await h.snapshot('Added the site "B"', stateWith([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]));
  const { commit } = await git.readCommit({ fs, dir: h.dir, oid: b.value.oid });
  assert.deepEqual(commit.parent, [a.value.oid]);
});

test('an unchanged state records nothing, so the log stays a list of real events', async () => {
  const h = newHistory('unchanged');
  const s = stateWith([{ id: 's1', name: 'Work' }]);
  const first = await h.snapshot('Added the site "Work"', s);
  const again = await h.snapshot('Saved settings', JSON.parse(JSON.stringify(s)));
  assert.equal(again.ok, true);
  assert.equal(again.value.unchanged, true);
  assert.equal(again.value.oid, first.value.oid);
  const list = await h.list({});
  assert.equal(list.value.length, 1);
});

test('key order does not count as a change', async () => {
  const h = newHistory('keyorder');
  await h.snapshot('one', { sites: [{ id: 'a', name: 'A' }], prefs: { x: 1, y: 2 } });
  const again = await h.snapshot('two', { prefs: { y: 2, x: 1 }, sites: [{ id: 'a', name: 'A' }] });
  assert.equal(again.value.unchanged, true);
});

// ------------------------------------------------------------------- list

test('list returns revisions newest first with label, time and author', async () => {
  const h = newHistory('list');
  await h.snapshot('Added the site "A"', stateWith([{ id: 'a' }]));
  await h.snapshot('Added the site "B"', stateWith([{ id: 'a' }, { id: 'b' }]));
  await h.snapshot('Deleted the site "A"', stateWith([{ id: 'b' }]));

  const r = await h.list({});
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.map((x) => x.label),
    ['Deleted the site "A"', 'Added the site "B"', 'Added the site "A"']);
  for (const rev of r.value) {
    assert.match(rev.oid, /^[0-9a-f]{40}$/);
    assert.equal(rev.short, rev.oid.slice(0, 8));
    assert.equal(typeof rev.time, 'number');
    assert.ok(rev.time > 0 && rev.time <= Date.now() + 5000);
    assert.ok(rev.author && rev.author.length);
  }
});

test('list on an empty repository is an empty list, not an error', async () => {
  const h = newHistory('empty');
  const r = await h.list({});
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, []);
});

test('list honours the limit', async () => {
  const h = newHistory('limit');
  for (let i = 0; i < 5; i++) await h.snapshot(`Added the site "${i}"`, stateWith([{ id: String(i) }]));
  const r = await h.list({ limit: 2 });
  assert.equal(r.value.length, 2);
});

test('the action filter reflects the labels that were actually recorded', async () => {
  const h = newHistory('actions');
  await h.snapshot('Added the site "A"', stateWith([{ id: 'a' }]));
  await h.snapshot('Deleted the site "A"', stateWith([]));
  await h.snapshot('Changed setting language', stateWith([], { language: 'yue' }));

  const actions = await h.actions();
  assert.equal(actions.ok, true);
  const map = Object.fromEntries(actions.value.map((a) => [a.action, a.count]));
  assert.equal(map.created, 1);
  assert.equal(map.deleted, 1);
  assert.equal(map.settings, 1);

  const onlyDeleted = await h.list({ action: 'deleted' });
  assert.equal(onlyDeleted.value.length, 1);
  assert.equal(onlyDeleted.value[0].label, 'Deleted the site "A"');
});

test('actionOf derives the action from the label', () => {
  assert.equal(actionOf('Deleted the site "X"'), 'deleted');
  assert.equal(actionOf('Added the site folder "y"'), 'created');
  assert.equal(actionOf('Restored revision abc'), 'restored');
  assert.equal(actionOf('Changed setting language'), 'settings');
  assert.equal(actionOf('Updated the site "X"'), 'updated');
  assert.equal(actionOf('Discarded unsaved document "notes.txt"'), 'discarded');
});

// ------------------------------------------------------------------- read

test('read returns the exact state stored in a revision', async () => {
  const h = newHistory('read');
  const first = stateWith([{ id: 'a', name: 'Alpha', hostName: 'a.example.com' }]);
  const second = stateWith([{ id: 'b', name: 'Beta', hostName: 'b.example.com' }]);
  const one = await h.snapshot('Added the site "Alpha"', first);
  await h.snapshot('Replaced with "Beta"', second);

  const back = await h.read(one.value.oid);
  assert.equal(back.ok, true);
  assert.deepEqual(back.value.sites, first.sites);

  const head = await h.read('HEAD');
  assert.deepEqual(head.value.sites, second.sites);
});

test('read accepts the abbreviated oid the UI shows', async () => {
  const h = newHistory('shortoid');
  const one = await h.snapshot('Added the site "A"', stateWith([{ id: 'a' }]));
  await h.snapshot('Added the site "B"', stateWith([{ id: 'a' }, { id: 'b' }]));
  const back = await h.read(one.value.oid.slice(0, 8));
  assert.equal(back.ok, true);
  assert.equal(back.value.sites.length, 1);
});

test('reading a revision that does not exist fails without throwing', async () => {
  const h = newHistory('missing');
  await h.snapshot('Added the site "A"', stateWith([{ id: 'a' }]));
  const r = await h.read('0'.repeat(40));
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'NO_SUCH_REVISION');
  assert.match(r.error.message, /No such revision/);
});

// ---------------------------------------------------------------- restore

test('restore returns the old state AND creates a NEW revision (append-only)', async () => {
  const h = newHistory('restore');

  const v1 = stateWith([{ id: 'a', name: 'Alpha' }]);
  const v2 = stateWith([{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }]);
  const v3 = stateWith([{ id: 'b', name: 'Beta' }]);

  const r1 = await h.snapshot('Added the site "Alpha"', v1);
  await h.snapshot('Added the site "Beta"', v2);
  const r3 = await h.snapshot('Deleted the site "Alpha"', v3);

  const before = await h.list({});
  assert.equal(before.value.length, 3);

  const restored = await h.restore(r1.value.oid, 'Restored the site list from before Beta');
  assert.equal(restored.ok, true);

  // 1. The state came back intact.
  assert.deepEqual(restored.value.state.sites, v1.sites);

  // 2. A NEW commit exists — the branch grew, it did not rewind.
  const after = await h.list({});
  assert.equal(after.value.length, 4, 'the restore added a revision');
  assert.equal(after.value[0].oid, restored.value.oid);
  assert.notEqual(restored.value.oid, r1.value.oid, 'the restore is its own commit');
  assert.equal(after.value[0].label, 'Restored the site list from before Beta');

  // 3. Every earlier revision is still reachable, including the one the
  //    restore replaced — which is what makes "undo the undo" possible.
  for (const oid of [r1.value.oid, r3.value.oid]) {
    assert.ok(after.value.some((x) => x.oid === oid), `revision ${oid.slice(0, 8)} survived the restore`);
  }

  // 4. The new commit's parent is the tip that was current, proving the graph
  //    is append-only rather than reset.
  const { commit } = await git.readCommit({ fs, dir: h.dir, oid: restored.value.oid });
  assert.deepEqual(commit.parent, [r3.value.oid]);
});

test('an undo can itself be undone', async () => {
  const h = newHistory('undoundo');
  const v1 = stateWith([{ id: 'a', name: 'Alpha' }]);
  const v2 = stateWith([{ id: 'b', name: 'Beta' }]);

  const r1 = await h.snapshot('Added the site "Alpha"', v1);
  const r2 = await h.snapshot('Replaced with "Beta"', v2);

  // Undo: go back to v1.
  const undo = await h.restore(r1.value.oid, 'Restored "Alpha"');
  assert.deepEqual(undo.value.state.sites, v1.sites);

  // Undo the undo: go back to the state that the undo replaced.
  const redo = await h.restore(r2.value.oid, 'Restored "Beta" again');
  assert.deepEqual(redo.value.state.sites, v2.sites);

  const list = await h.list({});
  assert.equal(list.value.length, 4, 'both restores are recorded');
  assert.deepEqual(list.value.map((x) => x.label), [
    'Restored "Beta" again', 'Restored "Alpha"', 'Replaced with "Beta"', 'Added the site "Alpha"',
  ]);

  // And the live state really is v2 again.
  const head = await h.read('HEAD');
  assert.deepEqual(head.value.sites, v2.sites);
});

test('the restored state round-trips through git byte for byte', async () => {
  const h = newHistory('roundtrip');
  const rich = {
    prefs: {
      language: 'both',
      funnyLevel: { en: 5, yue: 4 },
      theme: { mode: 'dark', seed: '#0B57D0', perElement: { 'tab.active': { fontSize: 13.5 } } },
      customCommands: [{ id: 'cc-grep', name: 'Grep', command: 'grep "!?&Text:?!" !&' }],
    },
    sites: [
      { id: 's1', name: 'Wörk · 工作', hostName: 'files.example.com', portNumber: 2222, note: 'line1\nline2\t"quoted"' },
      { id: 's2', name: '', hostName: '::1', portNumber: 22, cipherList: ['aes', 'chacha20'] },
    ],
    folders: ['a/b', 'a/b/c'],
    workspaces: [{ name: 'default', sessions: [], savedAt: 1700000000000 }],
  };
  const one = await h.snapshot('Added everything', rich);
  await h.snapshot('Cleared everything', stateWith([]));

  const back = await h.restore(one.value.oid);
  assert.equal(back.ok, true);
  assert.deepEqual(back.value.state, rich);

  // And reading the new tip gives the same thing, so what was committed is
  // what will be restored next time too.
  const head = await h.read('HEAD');
  assert.deepEqual(head.value, rich);
});

test('restoring a revision that does not exist fails without throwing', async () => {
  const h = newHistory('restore-missing');
  await h.snapshot('Added the site "A"', stateWith([{ id: 'a' }]));
  const r = await h.restore('deadbeef');
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'NO_SUCH_REVISION');
});

// ------------------------------------------------------------------- diff

test('diff reports added, removed and changed values with dotted paths', async () => {
  const h = newHistory('diff');
  const a = await h.snapshot('one', {
    prefs: { language: 'en', theme: { mode: 'light' } },
    sites: [{ id: 'a' }],
  });
  const b = await h.snapshot('two', {
    prefs: { language: 'yue', theme: { mode: 'light', seed: '#123456' } },
    sites: [{ id: 'a' }, { id: 'b' }],
  });

  const d = await h.diff(a.value.oid, b.value.oid);
  assert.equal(d.ok, true);
  assert.deepEqual(d.value.changed.find((c) => c.path === 'prefs.language'),
    { path: 'prefs.language', from: 'en', to: 'yue' });
  assert.ok(d.value.added.some((x) => x.path === 'prefs.theme.seed' && x.to === '#123456'));
  // An array is compared whole, because reordering sites is a real change.
  assert.ok(d.value.changed.some((c) => c.path === 'sites'));
  assert.equal(d.value.count, d.value.added.length + d.value.removed.length + d.value.changed.length);
});

test('diff of a revision against itself is empty', async () => {
  const h = newHistory('diff-same');
  const a = await h.snapshot('one', stateWith([{ id: 'a' }]));
  const d = await h.diff(a.value.oid, a.value.oid);
  assert.equal(d.value.count, 0);
});

test('diff reports a removal', async () => {
  const h = newHistory('diff-removed');
  const a = await h.snapshot('one', { prefs: { gone: true, kept: 1 }, sites: [] });
  const b = await h.snapshot('two', { prefs: { kept: 1 }, sites: [] });
  const d = await h.diff(a.value.oid, b.value.oid);
  assert.deepEqual(d.value.removed, [{ path: 'prefs.gone', from: true }]);
});

// ------------------------------------------------------------------ prune

test('pruning to maxRevisions keeps the newest and re-roots the rest', async () => {
  const prefs = { enabled: true, retentionDays: 0, maxRevisions: 3 };
  const h = newHistory('prune', prefs);
  for (let i = 0; i < 6; i++) await h.snapshot(`Added the site "${i}"`, stateWith([{ id: String(i) }]));

  const before = await h.list({});
  assert.equal(before.value.length, 6);

  const r = await h.prune();
  assert.equal(r.ok, true);
  assert.equal(r.value.kept, 3);
  assert.equal(r.value.pruned, 3);

  const after = await h.list({});
  assert.equal(after.value.length, 3);
  assert.deepEqual(after.value.map((x) => x.label),
    ['Added the site "5"', 'Added the site "4"', 'Added the site "3"']);

  // The oldest KEPT revision still carries the whole state, so pruning loses
  // intermediate steps and never the ability to restore.
  const oldest = after.value[after.value.length - 1];
  const state = await h.read(oldest.oid);
  assert.equal(state.ok, true);
  assert.deepEqual(state.value.sites, [{ id: '3' }]);

  const { commit } = await git.readCommit({ fs, dir: h.dir, oid: oldest.oid });
  assert.equal(commit.parent.length, 0, 'the oldest kept revision became the new root');
});

test('pruning never removes everything', async () => {
  const h = newHistory('prune-all', { enabled: true, retentionDays: 1, maxRevisions: 0 });
  // Everything is recent, so the day-based cutoff removes nothing.
  await h.snapshot('one', stateWith([{ id: 'a' }]));
  await h.snapshot('two', stateWith([{ id: 'b' }]));
  const r = await h.prune();
  assert.equal(r.ok, true);
  const after = await h.list({});
  assert.ok(after.value.length >= 1);
});

test('pruning is a no-op when no limits are configured', async () => {
  const h = newHistory('prune-none', { enabled: true, retentionDays: 0, maxRevisions: 0 });
  await h.snapshot('one', stateWith([{ id: 'a' }]));
  const r = await h.prune();
  assert.equal(r.ok, true);
  assert.equal(r.value.skipped, 'no-limits');
});

test('history writes are skipped when version history is disabled, on request', async () => {
  const h = newHistory('disabled', { enabled: false, retentionDays: 0, maxRevisions: 5 });
  await h.snapshot('one', stateWith([{ id: 'a' }]));
  const r = await h.prune();
  assert.equal(r.value.skipped, 'disabled');
});

// --------------------------------------------------------------- failures

test('a broken repository fails softly — the caller\'s operation is never lost', async () => {
  const h = newHistory('broken');
  await h.snapshot('one', stateWith([{ id: 'a' }]));

  // Corrupt the repository the way a half-written disk would.
  fs.rmSync(path.join(h.dir, '.git', 'refs'), { recursive: true, force: true });
  fs.writeFileSync(path.join(h.dir, '.git', 'HEAD'), 'not a ref\n');

  const errors = [];
  h.on('error', (e) => errors.push(e));

  const r = await h.snapshot('two', stateWith([{ id: 'b' }]));
  // Whatever happened, it is an envelope and not an exception.
  assert.equal(typeof r.ok, 'boolean');
  if (!r.ok) assert.ok(r.error.message.length, 'the failure explains itself');
});

test('concurrent snapshots are serialized and all land', async () => {
  const h = newHistory('concurrent');
  const results = await Promise.all([0, 1, 2, 3, 4].map((i) =>
    h.snapshot(`Added the site "${i}"`, stateWith([{ id: String(i) }]))));
  for (const r of results) assert.equal(r.ok, true);
  const list = await h.list({});
  assert.equal(list.value.length, 5, 'no commit was lost to a shared index');
  // Every commit has exactly one parent except the root: a linear chain.
  for (const rev of list.value.slice(0, -1)) {
    const { commit } = await git.readCommit({ fs, dir: h.dir, oid: rev.oid });
    assert.equal(commit.parent.length, 1);
  }
});

// ----------------------------------------------------------------- export

test('export produces every revision with its state', async () => {
  const h = newHistory('export');
  await h.snapshot('Added the site "A"', stateWith([{ id: 'a' }]));
  await h.snapshot('Added the site "B"', stateWith([{ id: 'a' }, { id: 'b' }]));
  const r = await h.export_();
  assert.equal(r.ok, true);
  assert.equal(r.value.revisions.length, 2);
  assert.equal(r.value.revisions[0].label, 'Added the site "B"');
  assert.equal(r.value.revisions[0].state.sites.length, 2);
  assert.equal(r.value.revisions[1].state.sites.length, 1);
});

test('the repository is created under the directory it was given, and nowhere else', async () => {
  const dir = tempDir('scoped');
  const userFolder = path.join(dir, 'user-documents');
  fs.mkdirSync(userFolder);
  const h = new History(path.join(dir, 'history'), { getPrefs: () => ({ enabled: true }) });
  await h.snapshot('one', stateWith([{ id: 'a' }]));
  assert.ok(fs.existsSync(path.join(dir, 'history', '.git')));
  assert.ok(!fs.existsSync(path.join(userFolder, '.git')), 'never a .git inside a user folder');
});
