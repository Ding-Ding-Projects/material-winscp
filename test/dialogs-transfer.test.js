// dialogs-transfer.test.js — the pure logic behind the transfer dialogs.
//
// The renderer is native ES modules with no bundler; Node loads them directly
// through dynamic import(), so these assertions run against THE SHIPPED FILES
// rather than a copy of their rules. That matters more here than anywhere else
// in the UI, because three of the things tested below are promises the dialogs
// make to the user:
//
//   * the ETA and throughput formatting — what "time left" and the graph say
//   * the overwrite decision matrix — what each of the eight answers does, and
//     which of them a given query may legally use
//   * the checklist action-override rules — which action a comparison row may
//     be changed to, and the statement of consequence shown above the OK button
//
// If any of these drifts from design/main/queue.js or design/main/sync.js, a
// dialog starts describing something other than what will happen, which is the
// one failure mode a confirmation dialog must not have.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const importRenderer = (rel) => import(pathToFileURL(path.join(__dirname, '..', rel)).href);
const fs = require('node:fs');

let Q;              // design/renderer/ui/queue.js
let CL;             // design/renderer/ui/dialogs/checklist.js
let SY;             // design/renderer/ui/dialogs/synchronize.js
let MD;             // design/renderer/ui/dialogs/messagedlg.js
let FSI;            // design/renderer/ui/dialogs/fileysteminfo.js
let engine;         // design/main/queue.js, for the cross-checks

test.before(async () => {
  // Importing queue.js pulls the whole transfer surface in (it imports the six
  // dialogs for their registration side effects), which is itself worth
  // asserting: none of them may touch the DOM at module-evaluation time.
  Q = await importRenderer('design/renderer/ui/queue.js');
  CL = await importRenderer('design/renderer/ui/dialogs/checklist.js');
  SY = await importRenderer('design/renderer/ui/dialogs/synchronize.js');
  MD = await importRenderer('design/renderer/ui/dialogs/messagedlg.js');
  FSI = await importRenderer('design/renderer/ui/dialogs/fileysteminfo.js');
  engine = require('../design/main/queue');
});

test('directory-scoped check includes descendants but not similarly named siblings', () => {
  const rows = [
    item({ checked: false, local: { ...item().local, directory: '/local/a' } }),
    item({ checked: false, local: { ...item().local, directory: '/local/a/nested' } }),
    item({ checked: false, local: { ...item().local, directory: '/local/ab' } }),
  ];

  const checked = CL.setCheckedInDirectory(rows, '/local/a/', true);
  assert.deepEqual(checked.map((r) => r.checked), [true, true, false]);
  assert.equal(CL.isInDirectory('C:\\data\\a', 'C:\\data\\a\\nested'), true);
  assert.equal(CL.isInDirectory('C:\\data\\a', 'C:\\data\\ab'), false);
});

// ---------------------------------------------------------------------------
// byte, speed and clock formatting
// ---------------------------------------------------------------------------

test('formatBytes scales and keeps a stable number of digits', () => {
  assert.equal(Q.formatBytes(0), '0 B');
  assert.equal(Q.formatBytes(999), '999 B');
  assert.equal(Q.formatBytes(1024), '1.00 KiB');
  assert.equal(Q.formatBytes(1536), '1.50 KiB');
  assert.equal(Q.formatBytes(10 * 1024), '10.0 KiB');
  assert.equal(Q.formatBytes(100 * 1024), '100 KiB');
  assert.equal(Q.formatBytes(1024 * 1024), '1.00 MiB');
  assert.equal(Q.formatBytes(3 * 1024 ** 4), '3.00 TiB');
});

test('formatBytes honours the explicit byte and kilobyte styles', () => {
  assert.equal(Q.formatBytes(1048576, 'bytes'), '1 048 576 B');
  assert.equal(Q.formatBytes(1048576, 'kilo'), '1 024 KiB');
});

test('formatBytes never invents a number for a non-number', () => {
  assert.equal(Q.formatBytes(undefined), '—');
  assert.equal(Q.formatBytes(NaN), '—');
  assert.equal(Q.formatBytes('nonsense'), '—');
});

test('groupDigits is locale-independent', () => {
  assert.equal(Q.groupDigits(1), '1');
  assert.equal(Q.groupDigits(1000), '1 000');
  assert.equal(Q.groupDigits(1234567), '1 234 567');
  assert.equal(Q.groupDigits(-1234), '-1 234');
});

test('formatSpeed reports a stopped transfer as zero, not as unknown', () => {
  assert.equal(Q.formatSpeed(0), '0 B/s');
  assert.equal(Q.formatSpeed(-5), '0 B/s');
  assert.equal(Q.formatSpeed(2048), '2.00 KiB/s');
});

test('formatSpeedLimit returns null for "no limit" so the caller can say so', () => {
  assert.equal(Q.formatSpeedLimit(0), null);
  assert.equal(Q.formatSpeedLimit(-1), null);
  assert.equal(Q.formatSpeedLimit(65536), '64.0 KiB/s');
});

test('formatClock is HH:MM:SS, with days only when there are days', () => {
  assert.equal(Q.formatClock(0), '00:00:00');
  assert.equal(Q.formatClock(59), '00:00:59');
  assert.equal(Q.formatClock(90), '00:01:30');
  assert.equal(Q.formatClock(3661), '01:01:01');
  assert.equal(Q.formatClock(86400 + 3661), '1.01:01:01');
});

test('an unknown duration is visibly unknown, not zero', () => {
  // "00:00:00" reads as "finishing now"; the two states must not share a look.
  assert.equal(Q.formatClock(null), '--:--:--');
  assert.equal(Q.formatClock(undefined), '--:--:--');
  assert.equal(Q.formatClock(-1), '--:--:--');
  assert.equal(Q.formatEta(null), '--:--:--');
});

// ---------------------------------------------------------------------------
// ETA
// ---------------------------------------------------------------------------

test('etaSeconds divides what is left by the current rate', () => {
  assert.equal(Q.etaSeconds(1000, 0, 100), 10);
  assert.equal(Q.etaSeconds(1000, 500, 100), 5);
  assert.equal(Q.etaSeconds(1000, 999, 100), 0);       // rounds to zero, not null
});

test('etaSeconds is null while it genuinely cannot be known', () => {
  assert.equal(Q.etaSeconds(1000, 0, 0), null);
  assert.equal(Q.etaSeconds(1000, 0, undefined), null);
  assert.equal(Q.etaSeconds(undefined, 0, 100), null);
});

test('a queued item with no plan yet reports an unknown ETA, not zero', () => {
  // The engine reports total 0 until it has walked the source. "00:00:00" there
  // would tell the user a transfer that has not started is about to finish.
  assert.equal(Q.etaSeconds(0, 0, 0), null);
  assert.equal(Q.etaSeconds(0, 0, 5000), null);
  assert.equal(Q.formatEta(Q.etaSeconds(0, 0, 0)), '--:--:--');
});

test('etaSeconds is zero once every byte is accounted for', () => {
  assert.equal(Q.etaSeconds(1000, 1000, 0), 0);
  assert.equal(Q.etaSeconds(1000, 1200, 50), 0);
});

test('the renderer ETA agrees with the engine for every in-flight case', () => {
  // design/main/queue.js: eta = cps > 0 && left > 0 ? round(left / cps) : null
  const cases = [[1000, 0, 100], [4096, 1024, 512], [999, 998, 3], [10 ** 9, 5 * 10 ** 8, 1234]];
  for (const [total, done, cps] of cases) {
    const left = total - done;
    const engineValue = cps > 0 && left > 0 ? Math.round(left / cps) : null;
    assert.equal(Q.etaSeconds(total, done, cps), engineValue, `total=${total} done=${done} cps=${cps}`);
  }
});

test('progressFraction is clamped and never NaN', () => {
  assert.equal(Q.progressFraction(0, 0), 0);
  assert.equal(Q.progressFraction(50, 100), 0.5);
  assert.equal(Q.progressFraction(150, 100), 1);
  assert.equal(Q.progressFraction(-5, 100), 0);
  assert.equal(Q.formatPercent(Q.progressFraction(1, 3)), '33%');
});

// ---------------------------------------------------------------------------
// throughput series and the graph
// ---------------------------------------------------------------------------

test('pushThroughput keeps only the window and never mutates its input', () => {
  const start = [{ at: 1000, cps: 10 }, { at: 2000, cps: 20 }];
  const next = Q.pushThroughput(start, 30, 62001, 60000);
  assert.equal(start.length, 2, 'the original array is untouched');
  assert.deepEqual(next, [{ at: 62001, cps: 30 }], 'samples older than the window are dropped');
});

test('the window boundary is inclusive, so a sample exactly N ms old survives', () => {
  const next = Q.pushThroughput([{ at: 2000, cps: 20 }], 30, 62000, 60000);
  assert.deepEqual(next, [{ at: 2000, cps: 20 }, { at: 62000, cps: 30 }]);
});

test('pushThroughput records a stalled transfer as zero rather than dropping it', () => {
  const next = Q.pushThroughput([], -3, 500);
  assert.deepEqual(next, [{ at: 500, cps: 0 }]);
});

test('peak and average describe the series honestly', () => {
  const series = [{ at: 1, cps: 100 }, { at: 2, cps: 300 }, { at: 3, cps: 200 }];
  assert.equal(Q.throughputPeak(series), 300);
  assert.equal(Q.throughputAverage(series), 200);
  assert.equal(Q.throughputPeak([]), 0);
  assert.equal(Q.throughputAverage([]), 0);
});

test('sparklinePath draws nothing for no data instead of a flat zero line', () => {
  assert.equal(Q.sparklinePath([], 100, 50), '');
  assert.equal(Q.sparklinePath(null, 100, 50), '');
});

test('sparklinePath scales to the peak and spans the full width', () => {
  assert.equal(Q.sparklinePath([0, 50, 100], 100, 50), 'M0,50 L50,25 L100,0');
  assert.equal(Q.sparklinePath([5], 100, 50), 'M0,0');
});

test('sparklinePath respects an explicit maximum so two graphs can be compared', () => {
  assert.equal(Q.sparklinePath([50], 100, 50, 100), 'M0,25');
});

// ---------------------------------------------------------------------------
// speed limit parsing
// ---------------------------------------------------------------------------

test('a bare number in the speed field is kilobytes per second, as in WinSCP', () => {
  assert.equal(Q.parseSpeedLimit('512'), 512 * 1024);
  assert.equal(Q.parseSpeedLimit(''), 0);
  assert.equal(Q.parseSpeedLimit('  64  '), 64 * 1024);
});

test('the speed field accepts an explicit unit', () => {
  assert.equal(Q.parseSpeedLimit('1 MiB/s'), 1024 * 1024);
  assert.equal(Q.parseSpeedLimit('1.5mb'), Math.round(1.5 * 1024 * 1024));
  assert.equal(Q.parseSpeedLimit('900 b'), 900);
});

test('an unparseable speed is null, so the dialog can refuse instead of guessing', () => {
  assert.equal(Q.parseSpeedLimit('fast'), null);
  assert.equal(Q.parseSpeedLimit('-5'), null);
  assert.equal(Q.parseSpeedLimit('12 furlongs'), null);
});

// ---------------------------------------------------------------------------
// the overwrite decision matrix
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000_000;

function query(over = {}) {
  return {
    kind: 'overwrite',
    file: '/remote/dir/report.txt',
    source: { path: '/local/dir/report.txt', size: 2048, mtime: NOW },
    target: { path: '/remote/dir/report.txt', size: 1024, mtime: NOW - 60000 },
    canResume: true,
    canAppend: true,
    ...over,
  };
}

test('the renderer offers exactly the answers the engine accepts', () => {
  assert.deepEqual(Q.OVERWRITE_ANSWERS.slice().sort(), engine.OVERWRITE_ANSWERS.slice().sort());
});

test('every answer is available for an ordinary query', () => {
  const options = Q.overwriteOptions(query());
  assert.equal(options.length, 8);
  assert.ok(options.every((o) => o.enabled), 'nothing should be disabled here');
});

test('resume is unavailable when the transfer cannot restart from an offset', () => {
  const options = Q.overwriteOptions(query({ canResume: false }));
  const resume = options.find((o) => o.answer === 'resume');
  assert.equal(resume.enabled, false);
  assert.equal(resume.reasonKey, 'txOvDisabledResume');
  assert.ok(options.filter((o) => o.answer !== 'resume').every((o) => o.enabled));
});

test('append is unavailable when the query says so', () => {
  const append = Q.overwriteOptions(query({ canAppend: false })).find((o) => o.answer === 'append');
  assert.equal(append.enabled, false);
  assert.equal(append.reasonKey, 'txOvDisabledAppend');
});

test('newer-only needs both timestamps to mean anything', () => {
  for (const q of [query({ source: { path: 'a', size: 1, mtime: 0 } }), query({ target: { path: 'b', size: 1, mtime: 0 } })]) {
    const opt = Q.overwriteOptions(q).find((o) => o.answer === 'newer-only');
    assert.equal(opt.enabled, false);
    assert.equal(opt.reasonKey, 'txOvDisabledNewer');
  }
});

test('the "newer" test uses the engine\'s own two-second window', () => {
  assert.equal(Q.NEWER_TOLERANCE_MS, 1999);
  assert.equal(Q.sourceIsNewer(NOW + 2000, NOW), true);
  assert.equal(Q.sourceIsNewer(NOW + 1999, NOW), false, 'exactly at the tolerance is NOT newer');
  assert.equal(Q.sourceIsNewer(NOW + 1500, NOW), false);
  assert.equal(Q.sourceIsNewer(NOW, NOW + 5000), false);
  assert.equal(Q.sourceIsNewer(0, NOW), null, 'a missing timestamp is unknown, not false');
  assert.equal(Q.sourceIsNewer(NOW, 0), null);
});

test('overwrite writes the source over the target', () => {
  const r = Q.overwriteOutcome(query(), 'overwrite');
  assert.deepEqual(
    { valid: r.valid, action: r.action, mode: r.mode, sticky: r.sticky, targetPath: r.targetPath },
    { valid: true, action: 'transfer', mode: 'overwrite', sticky: null, targetPath: '/remote/dir/report.txt' },
  );
});

test('resume and append keep the target and pick their own mode', () => {
  const resume = Q.overwriteOutcome(query(), 'resume');
  assert.equal(resume.mode, 'resume');
  assert.equal(resume.action, 'transfer');
  const append = Q.overwriteOutcome(query(), 'append');
  assert.equal(append.mode, 'append');
  assert.equal(append.action, 'transfer');
});

test('skip leaves the file alone and moves nothing', () => {
  const r = Q.overwriteOutcome(query(), 'skip');
  assert.equal(r.action, 'skip');
  assert.equal(r.mode, null);
  assert.equal(r.sticky, null);
});

test('the "all" answers report that they stick to the rest of the transfer', () => {
  assert.equal(Q.overwriteOutcome(query(), 'skip-all').sticky, 'skip-all');
  assert.equal(Q.overwriteOutcome(query(), 'skip-all').action, 'skip');
  assert.equal(Q.overwriteOutcome(query(), 'overwrite-all').sticky, 'overwrite-all');
  assert.equal(Q.overwriteOutcome(query(), 'overwrite-all').action, 'transfer');
});

test('newer-only applies to THIS file too, exactly as the engine does', () => {
  // design/main/queue.js sets _newerOnly and then skips the current file when
  // entry.mtime <= existing.mtime + 1999.
  const newer = Q.overwriteOutcome(query(), 'newer-only');
  assert.equal(newer.action, 'transfer');
  assert.equal(newer.sticky, 'newer-only');

  const older = Q.overwriteOutcome(query({
    source: { path: '/local/a', size: 1, mtime: NOW },
    target: { path: '/remote/a', size: 1, mtime: NOW + 60000 },
  }), 'newer-only');
  assert.equal(older.action, 'skip');
  assert.equal(older.mode, null);
  assert.equal(older.sticky, 'newer-only');
});

test('newer-only skips a file inside the tolerance window', () => {
  const r = Q.overwriteOutcome(query({
    source: { path: '/local/a', size: 1, mtime: NOW + 1999 },
    target: { path: '/remote/a', size: 1, mtime: NOW },
  }), 'newer-only');
  assert.equal(r.action, 'skip');
});

test('rename rewrites the target path and keeps both files', () => {
  const r = Q.overwriteOutcome(query(), 'rename', { newName: 'report (1).txt' });
  assert.equal(r.valid, true);
  assert.equal(r.newName, 'report (1).txt');
  assert.equal(r.targetPath, '/remote/dir/report (1).txt');
  assert.equal(r.mode, 'overwrite');
});

test('rename keeps a Windows target path on backslashes', () => {
  const r = Q.overwriteOutcome(query({
    file: 'C:\\Users\\a\\report.txt',
    target: { path: 'C:\\Users\\a\\report.txt', size: 1, mtime: NOW },
    toLocal: true,
  }), 'rename', { newName: 'copy.txt' });
  assert.equal(r.targetPath, 'C:\\Users\\a\\copy.txt');
});

test('rename refuses an empty, unchanged or illegal name', () => {
  const empty = Q.overwriteOutcome(query(), 'rename', { newName: '   ' });
  assert.equal(empty.valid, false);
  assert.equal(empty.errorKey, 'txOvRenameNeedsName');

  const same = Q.overwriteOutcome(query(), 'rename', { newName: 'report.txt' });
  assert.equal(same.valid, false);
  assert.equal(same.errorKey, 'txOvRenameSameName');

  const slash = Q.overwriteOutcome(query(), 'rename', { newName: 'a/b.txt' });
  assert.equal(slash.valid, false);
  assert.equal(slash.errorKey, 'txOvRenameBadChars');
});

test('a local target rejects the whole Windows illegal set, a remote one does not', () => {
  const local = Q.overwriteOutcome(query({ toLocal: true }), 'rename', { newName: 'a:b.txt' });
  assert.equal(local.valid, false);
  assert.equal(local.errorKey, 'txOvRenameBadChars');

  const remote = Q.overwriteOutcome(query(), 'rename', { newName: 'a:b.txt' });
  assert.equal(remote.valid, true, 'a colon is legal in a POSIX file name');
});

test('a disabled answer produces its reason instead of an outcome', () => {
  const r = Q.overwriteOutcome(query({ canResume: false }), 'resume');
  assert.equal(r.valid, false);
  assert.equal(r.errorKey, 'txOvDisabledResume');
  assert.equal(r.action, null);
});

test('an answer the engine does not know is refused before it is sent', () => {
  const r = Q.overwriteOutcome(query(), 'obliterate');
  assert.equal(r.valid, false);
  assert.equal(r.errorKey, 'txOvUnknownAnswer');
});

test('every valid answer describes itself with a real message key', () => {
  for (const answer of Q.OVERWRITE_ANSWERS) {
    const opts = answer === 'rename' ? { newName: 'other.txt' } : undefined;
    const d = Q.describeOverwriteOutcome(query(), answer, opts);
    assert.ok(d.key && d.key.startsWith('txOv'), `${answer} -> ${d.key}`);
    assert.equal(d.outcome.valid, true, answer);
  }
});

test('the description matches the outcome for skip and for transfer', () => {
  assert.equal(Q.describeOverwriteOutcome(query(), 'skip').key, 'txOvWillSkip');
  assert.equal(Q.describeOverwriteOutcome(query(), 'overwrite').key, 'txOvWillTransfer');
  assert.equal(
    Q.describeOverwriteOutcome(query({
      source: { path: '/local/a', size: 1, mtime: NOW },
      target: { path: '/remote/a', size: 1, mtime: NOW + 60000 },
    }), 'newer-only').key,
    'txOvWillSkipNotNewer',
  );
});

test('the file comparison names both the time and the size relationship', () => {
  assert.deepEqual(Q.compareOverwriteFiles(query()), {
    timeKey: 'txOvNewer', sizeKey: 'txOvSizeBigger', sourceIsNewer: true,
  });
  assert.deepEqual(Q.compareOverwriteFiles(query({
    source: { path: 'a', size: 10, mtime: NOW },
    target: { path: 'b', size: 10, mtime: NOW },
  })), { timeKey: 'txOvSameTime', sizeKey: 'txOvSizeSame', sourceIsNewer: false });
  assert.equal(Q.compareOverwriteFiles(query({
    source: { path: 'a', size: 10, mtime: 0 },
  })).timeKey, 'txOvUnknownTime');
});

test('path helpers handle both separators and a root path', () => {
  assert.equal(Q.basenameOf('/a/b/c.txt'), 'c.txt');
  assert.equal(Q.basenameOf('C:\\a\\c.txt'), 'c.txt');
  assert.equal(Q.basenameOf('c.txt'), 'c.txt');
  assert.equal(Q.dirnameOf('/a/b/c.txt'), '/a/b');
  assert.equal(Q.dirnameOf('/c.txt'), '/');
  assert.equal(Q.dirnameOf('c.txt'), '');
});

test('an overwrite prompt is recognised in both shapes ipc can produce', () => {
  const intended = Q.normalizeQueueQuery({
    promptId: 'q7', kind: 'custom', payload: { source: 'queue', query: { kind: 'overwrite', file: '/x' } },
  });
  assert.deepEqual(intended, { itemId: 'q7', query: { kind: 'overwrite', file: '/x' } });

  // design/main/ipc.js currently forwards the queue's single-argument emit, so
  // promptId arrives holding the whole object. Both must be read.
  const actual = Q.normalizeQueueQuery({
    promptId: { item: { id: 'q9' }, query: { kind: 'overwrite', file: '/y' } },
    kind: 'custom', payload: { source: 'queue' },
  });
  assert.deepEqual(actual, { itemId: 'q9', query: { kind: 'overwrite', file: '/y' } });

  assert.equal(Q.normalizeQueueQuery({ promptId: 'p1', kind: 'password', payload: {} }), null);
  assert.equal(Q.normalizeQueueQuery(null), null);
});

// ---------------------------------------------------------------------------
// checklist action-override rules
// ---------------------------------------------------------------------------

function item(over = {}) {
  return {
    action: 'upload',
    isDirectory: false,
    checked: true,
    reason: 'new-on-local',
    timestampOnly: false,
    local: { name: 'a.txt', directory: '/local', path: '/local/a.txt', size: 100, mtime: NOW, exists: true },
    remote: { name: 'a.txt', directory: '/remote', path: '/remote/a.txt', size: 0, mtime: 0, exists: false },
    ...over,
  };
}

test('the renderer knows exactly the actions the sync engine knows', () => {
  const sync = require('../design/main/sync');
  assert.deepEqual(CL.CHECKLIST_ACTIONS.slice().sort(), sync.ACTIONS.slice().sort());
});

test('a row that exists only locally can be uploaded or deleted locally', () => {
  assert.deepEqual(CL.allowedActions(item()), ['upload', 'deleteLocal', 'nothing']);
});

test('a row that exists only remotely can be downloaded or deleted remotely', () => {
  const it = item({
    action: 'download',
    reason: 'new-on-remote',
    local: { name: 'a.txt', directory: '/local', path: '/local/a.txt', size: 0, mtime: 0, exists: false },
    remote: { name: 'a.txt', directory: '/remote', path: '/remote/a.txt', size: 50, mtime: NOW, exists: true },
  });
  assert.deepEqual(CL.allowedActions(it), ['download', 'deleteRemote', 'nothing']);
});

test('a row present on both sides may be sent either way or deleted either side', () => {
  const it = item({
    reason: 'local-newer',
    remote: { name: 'a.txt', directory: '/remote', path: '/remote/a.txt', size: 90, mtime: NOW - 10, exists: true },
  });
  assert.deepEqual(CL.allowedActions(it), ['upload', 'download', 'deleteLocal', 'deleteRemote', 'nothing']);
});

test('timestamp mode never offers a deletion', () => {
  const it = item({
    timestampOnly: true,
    reason: 'local-newer',
    remote: { name: 'a.txt', directory: '/remote', path: '/remote/a.txt', size: 100, mtime: NOW - 5000, exists: true },
  });
  assert.deepEqual(CL.allowedActions(it), ['upload', 'download', 'nothing']);
  const refused = CL.canOverride(it, 'deleteRemote');
  assert.equal(refused.ok, false);
  assert.equal(refused.reasonKey, 'txClNoDeleteTimestamp');
});

test('a type mismatch offers nothing but "do nothing"', () => {
  const it = item({
    action: 'nothing',
    reason: 'type-mismatch',
    isDirectory: true,
    remote: { name: 'a.txt', directory: '/remote', path: '/remote/a.txt', size: 0, mtime: NOW, exists: true },
  });
  assert.deepEqual(CL.allowedActions(it), ['nothing']);
  assert.equal(CL.canOverride(it, 'upload').reasonKey, 'txClNoTypeMismatch');
});

test('choosing an action ticks the row and choosing nothing unticks it', () => {
  const start = item({ checked: false });
  const chosen = CL.overrideAction(start, 'deleteLocal');
  assert.equal(chosen.ok, true);
  assert.equal(chosen.item.action, 'deleteLocal');
  assert.equal(chosen.item.checked, true);
  assert.equal(start.action, 'upload', 'the input row is not mutated');

  const none = CL.overrideAction(chosen.item, 'nothing');
  assert.equal(none.item.checked, false, 'a ticked row that does nothing would be ambiguous');
});

test('an illegal override is refused with its reason and changes nothing', () => {
  const it = item();
  const r = CL.overrideAction(it, 'download');
  assert.equal(r.ok, false);
  assert.equal(r.reasonKey, 'txClNoDownload');
  assert.equal(r.item, it);
});

test('reverse mirrors a legal action and refuses an impossible one', () => {
  const both = item({
    reason: 'local-newer',
    remote: { name: 'a.txt', directory: '/remote', path: '/remote/a.txt', size: 90, mtime: NOW - 10, exists: true },
  });
  assert.equal(CL.reverseAction(both).item.action, 'download');
  assert.equal(CL.reverseAction({ ...both, action: 'deleteLocal' }).item.action, 'deleteRemote');

  // Nothing on the remote side to download, so the mirror is refused.
  const refused = CL.reverseAction(item());
  assert.equal(refused.ok, false);
  assert.equal(refused.reasonKey, 'txClNoDownload');

  // A row that already does nothing has no mirror at all.
  assert.equal(CL.reverseAction(item({ action: 'nothing' })).ok, false);
});

test('setChecked leaves the action alone', () => {
  const it = item();
  const off = CL.setChecked(it, false);
  assert.equal(off.checked, false);
  assert.equal(off.action, 'upload');
  assert.equal(it.checked, true);
});

test('checkAll ticks actionable rows and keeps no-op rows unticked', () => {
  const rows = [item({ checked: false }), item({ action: 'nothing', checked: true })];
  const checked = CL.checkAll(rows);
  assert.deepEqual(checked.map((r) => r.checked), [true, false]);
  assert.deepEqual(checked.map((r) => r.action), ['upload', 'nothing']);
  assert.deepEqual(rows.map((r) => r.checked), [false, true]);
});

test('uncheckAll clears every row without changing actions', () => {
  const rows = [item(), item({ action: 'deleteLocal' })];
  const cleared = CL.uncheckAll(rows);
  assert.deepEqual(cleared.map((r) => r.checked), [false, false]);
  assert.deepEqual(cleared.map((r) => r.action), ['upload', 'deleteLocal']);
});

test('invertChecked flips actionable rows but never ticks do-nothing rows', () => {
  const rows = [
    item({ checked: true }),
    item({ action: 'download', checked: false, remote: { ...item().remote, exists: true } }),
    item({ action: 'nothing', checked: true }),
  ];
  const inverted = CL.invertChecked(rows);
  assert.deepEqual(inverted.map((r) => r.checked), [false, true, false]);
  assert.deepEqual(inverted.map((r) => r.action), rows.map((r) => r.action));
  assert.equal(rows[0].checked, true, 'the input rows are not mutated');
});

test('checklist toolbar controls expose explicit accessible names', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'design/renderer/ui/dialogs/checklist.js'), 'utf8');
  assert.match(source, /bindText\(btn, labelKey, \{ attr: 'aria-label' \}\)/);
  assert.match(source, /bindText\(btn, 'txClGroup', \{ attr: 'aria-label' \}\)/);
  assert.match(source, /registerContextMenu\(toolbar, \(\) => \[/);
  assert.match(source, /event\.key\.toLowerCase\(\) === 'a'/);
});

test('directory-scoped check and uncheck preserve other directories and actions', () => {
  const rows = [
    item({ checked: false, local: { ...item().local, directory: '/local/a' } }),
    item({ action: 'download', checked: false, reason: 'remote-newer',
      local: { ...item().local, directory: '/local/a', exists: true },
      remote: { ...item().remote, directory: '/remote/a', exists: true, size: 80 } }),
    item({ checked: false, local: { ...item().local, directory: '/local/b' } }),
    item({ action: 'nothing', checked: false, local: { ...item().local, directory: '/local/a' } }),
  ];

  const checked = CL.setCheckedInDirectory(rows, '/local/a', true);
  assert.deepEqual(checked.map((r) => r.checked), [true, true, false, false]);
  assert.deepEqual(checked.map((r) => r.action), rows.map((r) => r.action));

  const unchecked = CL.setCheckedInDirectory(checked, '/local/a', false);
  assert.deepEqual(unchecked.map((r) => r.checked), [false, false, false, false]);
  assert.deepEqual(unchecked[2], checked[2], 'a different directory is untouched');
});

// ---------------------------------------------------------------------------
// what will happen — the statement above the OK button
// ---------------------------------------------------------------------------

test('an empty selection says plainly that nothing will happen', () => {
  const summary = CL.summarizeChecklist([item({ checked: false })], { onlyChecked: true });
  assert.equal(summary.acted, 0);
  assert.deepEqual(CL.describeChecklist(summary), [{ key: 'txClNothing', params: [] }]);
});

test('the summary counts each action and totals the bytes it will move', () => {
  const rows = [
    item({ action: 'upload', local: { ...item().local, size: 1024 } }),
    item({ action: 'upload', local: { ...item().local, size: 1024 } }),
    item({
      action: 'download',
      remote: { name: 'b', directory: '/remote', path: '/remote/b', size: 2048, mtime: NOW, exists: true },
    }),
    item({ action: 'nothing', checked: false }),
  ];
  const summary = CL.summarizeChecklist(rows, { onlyChecked: true });
  assert.equal(summary.counts.upload, 2);
  assert.equal(summary.counts.download, 1);
  assert.equal(summary.bytes.upload, 2048);
  assert.equal(summary.bytes.download, 2048);
  assert.equal(summary.acted, 3);
  assert.equal(summary.deletions, 0);
});

test('unticked rows are excluded, and onlyChecked:false counts everything', () => {
  const rows = [item({ checked: true }), item({ checked: false })];
  assert.equal(CL.summarizeChecklist(rows, { onlyChecked: true }).acted, 1);
  assert.equal(CL.summarizeChecklist(rows, { onlyChecked: false }).acted, 2);
});

test('a timestamp-only row is counted as a timestamp change, not a transfer', () => {
  const rows = [item({ timestampOnly: true, action: 'upload' })];
  const summary = CL.summarizeChecklist(rows, { onlyChecked: true });
  assert.equal(summary.counts.timestamp, 1);
  assert.equal(summary.counts.upload, 0);
  assert.equal(summary.bytes.upload, 0);
  const lines = CL.describeChecklist(summary).map((l) => l.key);
  assert.deepEqual(lines, ['txClTimestamps']);
});

test('a deletion is stated as a deletion AND carries the no-undo warning', () => {
  const rows = [
    item({ action: 'deleteLocal' }),
    item({
      action: 'deleteRemote',
      remote: { name: 'a.txt', directory: '/remote', path: '/remote/a.txt', size: 1, mtime: NOW, exists: true },
    }),
  ];
  const summary = CL.summarizeChecklist(rows, { onlyChecked: true });
  assert.equal(summary.deletions, 2);
  const keys = CL.describeChecklist(summary).map((l) => l.key);
  assert.ok(keys.includes('txClDeleteLocal'));
  assert.ok(keys.includes('txClDeleteRemote'));
  assert.equal(keys[keys.length - 1], 'txClDeleteWarn', 'the warning comes last, after the counts');
});

test('every sentence the summary produces resolves to a real message', () => {
  const rows = [
    item({ action: 'upload' }),
    item({
      action: 'download',
      remote: { name: 'b', directory: '/remote', path: '/remote/b', size: 8, mtime: NOW, exists: true },
    }),
    item({ action: 'deleteLocal' }),
    item({
      action: 'deleteRemote',
      remote: { name: 'c', directory: '/remote', path: '/remote/c', size: 8, mtime: NOW, exists: true },
    }),
    item({ action: 'upload', timestampOnly: true }),
  ];
  const lines = CL.describeChecklist(CL.summarizeChecklist(rows, { onlyChecked: true }));
  assert.equal(lines.length, 6);
  for (const line of lines) {
    assert.ok(line.key.startsWith('txCl'), line.key);
    assert.ok(Array.isArray(line.params));
  }
});

// ---------------------------------------------------------------------------
// applying: what goes to sync:apply and what the renderer must do itself
// ---------------------------------------------------------------------------

test('untouched ticked rows go to the engine as ticked flags', () => {
  const original = [item(), item({ checked: false })];
  const current = original.map((i) => ({ ...i }));
  const { checked, overrides } = CL.partitionForApply(original, current);
  assert.deepEqual(checked, [true, false]);
  assert.deepEqual(overrides, []);
});

test('a hand-changed row is withheld from the engine and handled directly', () => {
  const original = [item(), item()];
  const current = [CL.overrideAction(original[0], 'deleteLocal').item, { ...original[1] }];
  const { checked, overrides } = CL.partitionForApply(original, current);
  // The engine's own checklist still says "upload" for row 0, so ticking it
  // there would perform the WRONG action; it is excluded and done here instead.
  assert.deepEqual(checked, [false, true]);
  assert.equal(overrides.length, 1);
  assert.equal(overrides[0].index, 0);
  assert.equal(overrides[0].item.action, 'deleteLocal');
});

test('a row changed to "do nothing" is neither ticked nor performed', () => {
  const original = [item()];
  const current = [CL.overrideAction(original[0], 'nothing').item];
  const { checked, overrides } = CL.partitionForApply(original, current);
  assert.deepEqual(checked, [false]);
  assert.deepEqual(overrides, []);
});

test('grouping keeps every row and preserves order', () => {
  const rows = [
    item({ local: { ...item().local, directory: '/local/a' } }),
    item({ local: { ...item().local, directory: '/local/b' } }),
    item({ local: { ...item().local, directory: '/local/a' } }),
  ];
  const groups = CL.groupByDirectory(rows);
  assert.deepEqual(Array.from(groups.keys()), ['/local/a', '/local/b']);
  assert.equal(groups.get('/local/a').length, 2);
  assert.equal(Array.from(groups.values()).flat().length, rows.length);
});

// ---------------------------------------------------------------------------
// synchronize options: the refusals, and the tick policy ipc drops
// ---------------------------------------------------------------------------

test('the two comparison checkboxes collapse into the engine\'s criteria value', () => {
  assert.equal(SY.criteriaOf({ byTime: true, bySize: false }), 'time');
  assert.equal(SY.criteriaOf({ byTime: false, bySize: true }), 'size');
  assert.equal(SY.criteriaOf({ byTime: true, bySize: true }), 'either');
  assert.equal(SY.criteriaOf({ byTime: false, bySize: false }), 'none');
});

test('the dialog refuses exactly the combinations the sync engine throws on', () => {
  const sync = require('../design/main/sync');
  const base = { ...SY.SYNC_DEFAULTS };
  const combos = [];
  for (const direction of ['local', 'remote', 'both']) {
    for (const mode of ['synchronize', 'mirror', 'timestamp']) {
      for (const byTime of [true, false]) {
        for (const bySize of [true, false]) {
          for (const deleteFiles of [true, false]) {
            combos.push({ ...base, direction, mode, byTime, bySize, deleteFiles });
          }
        }
      }
    }
  }
  for (const options of combos) {
    const refusedHere = !!SY.syncCombinationError(options);
    let engineRefused = false;
    try {
      sync.validateOptions({
        direction: options.direction,
        mode: options.mode,
        criteria: SY.criteriaOf(options),
        deleteFiles: options.deleteFiles,
      });
    } catch { engineRefused = true; }
    // "criteria: none" is legal for the engine but useless to a user, so the
    // dialog additionally refuses it; every OTHER refusal must match exactly.
    if (SY.criteriaOf(options) === 'none' && !engineRefused) {
      assert.equal(refusedHere, true, `criteria none should be refused: ${JSON.stringify(options)}`);
      continue;
    }
    assert.equal(refusedHere, engineRefused, JSON.stringify(options));
  }
});

test('each refusal names a real message key', () => {
  const key = SY.syncCombinationError({ ...SY.SYNC_DEFAULTS, mode: 'timestamp', deleteFiles: true });
  assert.equal(key, 'txSyRefuseTimestampDelete');
  assert.equal(
    SY.syncCombinationError({ ...SY.SYNC_DEFAULTS, direction: 'both', byTime: false, bySize: true }),
    'txSyRefuseBothSize',
  );
  assert.equal(
    SY.syncCombinationError({ ...SY.SYNC_DEFAULTS, byTime: false, bySize: false }),
    'txSyRefuseNoCriteria',
  );
  assert.equal(SY.syncCombinationError(SY.SYNC_DEFAULTS), '');
});

test('the compare request carries destructive and creation policy through ipc', () => {
  const req = SY.compareRequest({ ...SY.SYNC_DEFAULTS, bySize: true, fileMask: '*.txt',
    deleteFiles: true, existingOnly: true },
    { sessionId: 's1', localPath: '/l', remotePath: '/r' });
  assert.equal(req.sessionId, 's1');
  assert.equal(req.criteria, 'either');
  assert.equal(req.fileMask, '*.txt');
  assert.equal(req.deleteFiles, true, 'the engine must be allowed to include deletion rows');
  assert.equal(req.existingOnly, true, 'the engine must be allowed to suppress new-file rows');
  assert.equal(req.copyParam.preserveTime, true);
});

test('"delete files" off leaves deletion rows unticked', () => {
  const rows = [{ action: 'deleteRemote', reason: 'not-on-local', checked: true, isDirectory: false, local: {}, remote: {} }];
  const out = SY.applySelectionPolicy(rows, { deleteFiles: false });
  assert.equal(out[0].checked, false);
});

test('"delete files" on ticks the deletion rows the comparison produced', () => {
  const rows = [{ action: 'deleteRemote', reason: 'not-on-local', checked: false, isDirectory: false, local: {}, remote: {} }];
  const out = SY.applySelectionPolicy(rows, { deleteFiles: true });
  assert.equal(out[0].checked, true);
});

test('"existing files only" unticks the rows that would create something new', () => {
  const rows = [
    { action: 'upload', reason: 'new-on-local', checked: true, local: {}, remote: {} },
    { action: 'upload', reason: 'local-newer', checked: true, local: {}, remote: {} },
  ];
  const out = SY.applySelectionPolicy(rows, { existingOnly: true });
  assert.equal(out[0].checked, false);
  assert.equal(out[1].checked, true, 'an existing file is still updated');
});

test('a "do nothing" row is never ticked by the policy', () => {
  const rows = [{ action: 'nothing', reason: 'identical', checked: true, local: {}, remote: {} }];
  assert.equal(SY.applySelectionPolicy(rows, {})[0].checked, false);
});

test('a selection narrows the ticks to the selected paths only', () => {
  const rows = [
    { action: 'upload', reason: 'local-newer', checked: true, local: { path: '/l/a', name: 'a' }, remote: {} },
    { action: 'upload', reason: 'local-newer', checked: true, local: { path: '/l/b', name: 'b' }, remote: {} },
  ];
  const out = SY.applySelectionPolicy(rows, { selection: ['/l/a'] });
  assert.equal(out[0].checked, true);
  assert.equal(out[1].checked, false);
});

// ---------------------------------------------------------------------------
// the message dialog's button sets
// ---------------------------------------------------------------------------

test('every button set resolves and marks exactly one affirmative button', () => {
  for (const name of Object.keys(MD.BUTTON_SETS)) {
    const buttons = MD.resolveButtons({ buttons: name });
    assert.ok(buttons.length, name);
    assert.equal(buttons.filter((b) => b.primary).length, 1, name);
    assert.equal(buttons[buttons.length - 1].primary, true, name);
    for (const b of buttons) assert.ok(MD.MESSAGE_ANSWERS[b.answer], `${name}: ${b.answer}`);
  }
});

test('Escape resolves to cancel when there is one, and to a safe answer otherwise', () => {
  assert.equal(MD.escapeAnswer({ buttons: 'okCancel' }), 'cancel');
  assert.equal(MD.escapeAnswer({ buttons: 'yesNo' }), 'no');
  assert.equal(MD.escapeAnswer({ buttons: 'ok' }), 'ok');
  assert.equal(MD.escapeAnswer({ buttons: 'yesNo', cancelAnswer: 'yes' }), 'yes');
  // CancelAnswer's ladder is cancel -> no -> abort -> ok, and the last rung is
  // the one that used to be missing: this set escapes as OK, not as Retry.
  assert.equal(MD.escapeAnswer({ buttons: [{ answer: 'retry' }, { answer: 'ok' }] }), 'ok');
  assert.equal(MD.escapeAnswer({ buttons: 'abortRetryIgnore' }), 'abort');

  // DefaultAnswer is Yes, else OK, else Retry — a property of the answer set,
  // not of which button happens to be listed last.
  assert.equal(MD.defaultAnswerFor({ buttons: 'yesNoCancel' }), 'yes');
  assert.equal(MD.defaultAnswerFor({ buttons: 'okCancel' }), 'ok');
  assert.equal(MD.defaultAnswerFor({ buttons: 'retryCancel' }), 'retry');

  // Only a positive answer may be made permanent: "no, and never ask again"
  // would refuse every future occurrence with nothing on screen to say why.
  assert.equal(MD.isPositiveAnswer('yes'), true);
  assert.equal(MD.isPositiveAnswer('ok'), true);
  assert.equal(MD.isPositiveAnswer('yesToAll'), true);
  assert.equal(MD.isPositiveAnswer('no'), false);
  assert.equal(MD.isPositiveAnswer('cancel'), false);
  assert.equal(MD.isPositiveAnswer('skip'), false);
});

test('a custom button list keeps its own labels and its last button is primary', () => {
  const buttons = MD.resolveButtons({ buttons: [{ answer: 'skip' }, { answer: 'retry' }] });
  assert.equal(buttons.length, 2);
  assert.equal(buttons[1].answer, 'retry');
  assert.equal(buttons[1].primary, true);
});

// ---------------------------------------------------------------------------
// file system information is rendered from the capability object itself
// ---------------------------------------------------------------------------

test('the capability rows come from the adapter caps the engine checks', () => {
  const { DEFAULT_CAPS } = require('../design/main/protocols/base');
  const rows = FSI.capabilityRows({ capabilities: { ...DEFAULT_CAPS } });
  const names = new Set(rows.map((r) => r.name));
  for (const cap of Object.keys(DEFAULT_CAPS)) {
    assert.ok(names.has(cap), `capability ${cap} is not shown anywhere`);
  }
  const find = rows.find((r) => r.name === 'find');
  assert.equal(find.supported, DEFAULT_CAPS.find);
  const owner = rows.find((r) => r.name === 'owner');
  assert.equal(owner.supported, false);
});

test('a capability a protocol adds later is still listed, under its raw name', () => {
  const rows = FSI.capabilityRows({ capabilities: { rights: true, quantumTunnelling: true } });
  const extra = rows.find((r) => r.name === 'quantumTunnelling');
  assert.ok(extra, 'an unknown capability must not be silently dropped');
  assert.equal(extra.supported, true);
  assert.equal(extra.label, 'quantumTunnelling');
});

test('protocol rows skip what the server did not report', () => {
  const rows = FSI.protocolRows({ protocol: 'SFTP', remoteSystem: '', additional: { 'Max SFTP version': 6 } });
  const labels = rows.map((r) => r.labelKey || r.label);
  assert.ok(labels.includes('srvProtocol'));
  assert.ok(!labels.includes('txFsiRemoteSystem'), 'an empty field is omitted rather than shown as blank');
  assert.ok(labels.includes('Max SFTP version'));
});

test('space rows are empty when the protocol reports no space', () => {
  assert.deepEqual(FSI.spaceRows({ capabilities: { spaceInfo: false } }), []);
  const rows = FSI.spaceRows({ space: { path: '/', total: 2048, free: 1024 } });
  const byKey = Object.fromEntries(rows.map((r) => [r.labelKey || r.label, r.value]));
  assert.equal(byKey.txFsiSpaceTotal, '2.00 KiB');
  assert.equal(byKey.txFsiSpaceUsed, '1.00 KiB');
  assert.equal(byKey.txFsiSpaceFree, '1.00 KiB');
});
