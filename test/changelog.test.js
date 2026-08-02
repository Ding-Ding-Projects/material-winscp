// changelog.test.js — the pure logic behind the changelog viewer and the
// advanced date filter it shares with the version-history panel.
//
// design/renderer/ui/changelog.js is a browser ES module, but everything tested
// here is deliberately free of the DOM: the date parser, the filter composer
// and the export statement are plain functions so they can be proved headless
// rather than by clicking. Node imports the module directly — the renderer's
// module graph has no top-level DOM access, so it loads without a window.
//
// The three things under test are the three that are easy to get quietly wrong:
//
//   1. A TYPED DATE MUST NEVER EAT WHAT THE USER TYPED. A partial or invalid
//      entry has to be reported and the text kept, because a field that clears
//      itself while you are still typing is unusable.
//   2. FILTERS MUST COMPOSE, NOT OVERRIDE. Date and search narrow each other;
//      neither may put back a row the other removed.
//   3. AN EXPORT MUST STATE ITS RANGE. A changelog extract with no stated range
//      is a document nobody can check later.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const url = require('node:url');

const MODULE = url.pathToFileURL(
  path.join(__dirname, '..', 'design', 'renderer', 'ui', 'changelog.js'),
).href;

/** Filled by the before hook; a CJS test file cannot await at module scope. */
let C = null;

test.before(async () => { C = await import(MODULE); });

/** Local-midnight epoch ms, matching how the filter snaps its bounds. */
function localMs(y, m, d) { return new Date(y, m - 1, d).getTime(); }

/* ================================================================== */
/* parseDateInput — ISO                                                */
/* ================================================================== */

test('an ISO date parses in any locale', () => {
  for (const locale of ['en-US', 'en-GB', 'ja-JP', 'de-DE', 'zh-HK']) {
    const r = C.parseDateInput('2026-08-02', { locale });
    assert.equal(r.status, 'ok', `ISO should parse under ${locale}`);
    assert.equal(C.isoDate(r.ms), '2026-08-02');
  }
});

test('year-first input is read year-first even where the locale is day-first', () => {
  // 2026-03-04 must be 4 March, never 3 April, in en-GB. A year-first string is
  // unambiguous, so it is tried before the locale order for exactly this reason.
  const r = C.parseDateInput('2026-03-04', { locale: 'en-GB' });
  assert.equal(r.status, 'ok');
  assert.equal(r.date.getMonth(), 2);
  assert.equal(r.date.getDate(), 4);
});

test('ISO separators other than the hyphen are accepted', () => {
  for (const text of ['2026/08/02', '2026.08.02', '2026-8-2']) {
    const r = C.parseDateInput(text);
    assert.equal(r.status, 'ok', `${text} should parse`);
    assert.equal(C.isoDate(r.ms), '2026-08-02');
  }
});

/* ================================================================== */
/* parseDateInput — the locale's own format                            */
/* ================================================================== */

test('the locale order is read from Intl, not assumed', () => {
  assert.deepEqual(C.localeDateOrder('en-US').order, ['month', 'day', 'year']);
  assert.deepEqual(C.localeDateOrder('en-GB').order, ['day', 'month', 'year']);
  assert.deepEqual(C.localeDateOrder('ja-JP').order, ['year', 'month', 'day']);
});

test('a locale-format date parses in that locale', () => {
  const us = C.parseDateInput('8/2/2026', { locale: 'en-US' });
  assert.equal(us.status, 'ok');
  assert.equal(C.isoDate(us.ms), '2026-08-02');

  const gb = C.parseDateInput('02/08/2026', { locale: 'en-GB' });
  assert.equal(gb.status, 'ok');
  assert.equal(C.isoDate(gb.ms), '2026-08-02');
});

test('the same ambiguous string means different days in different locales', () => {
  const us = C.parseDateInput('2/8/2026', { locale: 'en-US' });
  const gb = C.parseDateInput('2/8/2026', { locale: 'en-GB' });
  assert.equal(C.isoDate(us.ms), '2026-02-08');
  assert.equal(C.isoDate(gb.ms), '2026-08-02');
});

test('a two-digit year is expanded and the field can show the result', () => {
  const r = C.parseDateInput('8/2/26', { locale: 'en-US' });
  assert.equal(r.status, 'ok');
  assert.equal(r.date.getFullYear(), 2026);
  // formatDateInput is what the field writes back on blur, so the guess is
  // visible rather than silent.
  assert.equal(C.formatDateInput(r.date, 'en-US'), '08/02/2026');
});

test('formatDateInput writes the locale spelling and round-trips', () => {
  const d = new Date(2026, 7, 2);
  for (const locale of ['en-US', 'en-GB', 'ja-JP']) {
    const text = C.formatDateInput(d, locale);
    const back = C.parseDateInput(text, { locale });
    assert.equal(back.status, 'ok', `${locale}: ${text} should parse back`);
    assert.equal(C.isoDate(back.ms), '2026-08-02', `${locale}: ${text}`);
  }
});

/* ================================================================== */
/* parseDateInput — partial and invalid keep the text                  */
/* ================================================================== */

test('a partial date is reported, not parsed, and the text is kept exactly', () => {
  for (const text of ['2026', '2026-08', '2026-08-', '8/', '8/2']) {
    const r = C.parseDateInput(text, { locale: 'en-US' });
    assert.equal(r.status, 'partial', `${text} should be partial`);
    assert.equal(r.ms, null, `${text} must not produce a bound`);
    assert.equal(r.text, text, `${text} must be preserved verbatim`);
    assert.ok(r.message.length > 0, `${text} should say what is missing`);
  }
});

test('an invalid date is reported, not parsed, and the text is kept exactly', () => {
  const cases = [
    ['2026-13-02', 'en-US'],
    ['2026-02-30', 'en-US'],
    ['31/02/2026', 'en-GB'],
    ['hello', 'en-US'],
    ['1/2/3/4', 'en-US'],
  ];
  for (const [text, locale] of cases) {
    const r = C.parseDateInput(text, { locale });
    assert.equal(r.status, 'invalid', `${text} should be invalid`);
    assert.equal(r.ms, null, `${text} must not produce a bound`);
    assert.equal(r.text, text, `${text} must be preserved verbatim`);
    assert.ok(r.message.length > 0, `${text} should say why`);
  }
});

test('surrounding whitespace is tolerated for parsing and preserved in the text', () => {
  const r = C.parseDateInput('  2026-08-02  ');
  assert.equal(r.status, 'ok');
  assert.equal(r.text, '  2026-08-02  ');

  const partial = C.parseDateInput('  2026-08  ');
  assert.equal(partial.status, 'partial');
  assert.equal(partial.text, '  2026-08  ');
});

test('an empty field is empty, not invalid', () => {
  for (const text of ['', '   ', null, undefined]) {
    const r = C.parseDateInput(text);
    assert.equal(r.status, 'empty');
    assert.equal(r.ms, null);
    assert.equal(r.message, '');
  }
});

test('the message names the actual problem', () => {
  assert.match(C.parseDateInput('2026-13-02').message, /13/);
  assert.match(C.parseDateInput('2026-02-30').message, /30/);
  assert.match(C.parseDateInput('2026-08').message, /year|month|day/i);
});

/* ================================================================== */
/* ranges                                                              */
/* ================================================================== */

test('a range is snapped to whole local days so a to-bound includes its day', () => {
  const r = C.normalizeRange({ from: localMs(2026, 8, 1) + 5000, to: localMs(2026, 8, 2) + 5000 });
  assert.equal(r.from, C.startOfDay(localMs(2026, 8, 1)));
  assert.equal(r.to, C.endOfDay(localMs(2026, 8, 2)));
  assert.ok(C.rangeContains(r, localMs(2026, 8, 2) + 23 * 3600 * 1000));
});

test('bounds entered the wrong way round are swapped rather than matching nothing', () => {
  const r = C.normalizeRange({ from: localMs(2026, 8, 5), to: localMs(2026, 8, 1) });
  assert.equal(r.swapped, true);
  assert.equal(C.isoDate(r.from), '2026-08-01');
  assert.equal(C.isoDate(r.to), '2026-08-05');
  assert.ok(C.rangeContains(r, localMs(2026, 8, 3)));
});

test('an open bound never excludes, and an undated row is out of any closed range', () => {
  assert.ok(C.rangeContains(C.normalizeRange({}), localMs(1999, 1, 1)));
  assert.ok(C.rangeContains(C.normalizeRange({}), null));
  assert.ok(C.rangeIsOpen(C.normalizeRange({})));

  const from = C.normalizeRange({ from: localMs(2026, 8, 2) });
  assert.ok(C.rangeContains(from, localMs(2026, 9, 1)));
  assert.equal(C.rangeContains(from, localMs(2026, 7, 1)), false);
  assert.equal(C.rangeContains(from, null), false);
});

test('every named preset resolves to a usable range', () => {
  const now = localMs(2026, 8, 2) + 12 * 3600 * 1000;
  for (const p of C.DATE_PRESETS) {
    const r = C.normalizeRange(C.resolvePreset(p.id, now));
    if (p.id === 'all') { assert.ok(C.rangeIsOpen(r), 'all must be open'); continue; }
    assert.ok(r.from != null && r.to != null, `${p.id} should bound both ends`);
    assert.ok(r.from <= r.to, `${p.id} should not be inverted`);
    if (p.id !== 'lastMonth') assert.ok(C.rangeContains(r, now), `${p.id} should contain now`);
  }
});

/* ================================================================== */
/* composeFilters — narrowing, never overriding                        */
/* ================================================================== */

const ROWS = [
  { id: 'a', time: localMs(2026, 8, 1), text: 'queue rewritten' },
  { id: 'b', time: localMs(2026, 8, 2), text: 'queue paused' },
  { id: 'c', time: localMs(2026, 8, 3), text: 'editor saved' },
  { id: 'd', time: localMs(2026, 9, 1), text: 'queue resumed' },
  { id: 'e', time: null, text: 'undated note' },
];

function dateFilter(range) {
  return { id: 'date', active: !C.rangeIsOpen(range), test: (r) => C.rangeContains(range, r.time) };
}
function textFilter(needle) {
  return { id: 'search', active: !!needle, test: (r) => r.text.includes(needle) };
}

test('two filters produce the intersection, not the last one applied', () => {
  const range = C.normalizeRange({ from: localMs(2026, 8, 1), to: localMs(2026, 8, 3) });
  const { rows } = C.composeFilters(ROWS, [dateFilter(range), textFilter('queue')]);
  assert.deepEqual(rows.map((r) => r.id), ['a', 'b']);

  // The date alone would keep c; the search alone would keep d. Neither
  // survives the composition, which is exactly the property being asserted.
  const dateOnly = C.composeFilters(ROWS, [dateFilter(range)]).rows.map((r) => r.id);
  const textOnly = C.composeFilters(ROWS, [textFilter('queue')]).rows.map((r) => r.id);
  assert.ok(dateOnly.includes('c'));
  assert.ok(textOnly.includes('d'));
  assert.ok(!rows.some((r) => r.id === 'c' || r.id === 'd'));
});

test('the order the filters are given in does not change the result', () => {
  const range = C.normalizeRange({ from: localMs(2026, 8, 2), to: localMs(2026, 9, 30) });
  const one = C.composeFilters(ROWS, [dateFilter(range), textFilter('queue')]).rows.map((r) => r.id);
  const two = C.composeFilters(ROWS, [textFilter('queue'), dateFilter(range)]).rows.map((r) => r.id);
  assert.deepEqual(one, two);
  assert.deepEqual(one, ['b', 'd']);
});

test('an inactive filter is skipped and can never widen the result', () => {
  const range = C.normalizeRange({ from: localMs(2026, 8, 1), to: localMs(2026, 8, 2) });
  const withInactive = C.composeFilters(ROWS, [dateFilter(range), textFilter('')]);
  const alone = C.composeFilters(ROWS, [dateFilter(range)]);
  assert.deepEqual(withInactive.rows.map((r) => r.id), alone.rows.map((r) => r.id));
  assert.deepEqual(withInactive.applied.map((a) => a.id), ['date']);
});

test('adding a third filter only ever removes rows', () => {
  const range = C.normalizeRange({ from: localMs(2026, 8, 1), to: localMs(2026, 9, 30) });
  const two = C.composeFilters(ROWS, [dateFilter(range), textFilter('queue')]).rows.map((r) => r.id);
  const three = C.composeFilters(ROWS, [
    dateFilter(range),
    textFilter('queue'),
    { id: 'idAfterB', active: true, test: (r) => r.id > 'b' },
  ]).rows.map((r) => r.id);
  assert.ok(three.every((id) => two.includes(id)), 'a third filter must not reintroduce a row');
  assert.deepEqual(three, ['d']);
});

test('a filter that throws excludes the row instead of taking the panel down', () => {
  const { rows } = C.composeFilters(ROWS, [
    { id: 'boom', active: true, test: (r) => { if (r.id === 'c') throw new Error('nope'); return true; } },
  ]);
  assert.deepEqual(rows.map((r) => r.id), ['a', 'b', 'd', 'e']);
});

test('composeFilters reports what each filter removed', () => {
  const range = C.normalizeRange({ from: localMs(2026, 8, 1), to: localMs(2026, 8, 3) });
  const res = C.composeFilters(ROWS, [dateFilter(range), textFilter('queue')]);
  assert.equal(res.total, ROWS.length);
  assert.deepEqual(res.applied.map((a) => [a.id, a.before, a.after]), [
    ['date', 5, 3],
    ['search', 3, 2],
  ]);
});

test('a filter with no test function is ignored rather than matching nothing', () => {
  const { rows, applied } = C.composeFilters(ROWS, [null, {}, { id: 'x', active: true }]);
  assert.equal(rows.length, ROWS.length);
  assert.equal(applied.length, 0);
});

/* ================================================================== */
/* exportRangeStatement                                                */
/* ================================================================== */

function statementLines(opts) { return C.exportRangeStatement(opts).split('\n'); }
function lineStarting(lines, prefix) { return lines.find((l) => l.startsWith(prefix)); }

test('an export with no dates says so rather than leaving the range unstated', () => {
  const lines = statementLines({ shown: 3, total: 9 });
  assert.equal(lineStarting(lines, 'Range:'), 'Range: all dates');
  assert.equal(lineStarting(lines, 'Search:'), 'Search: none');
  assert.equal(lineStarting(lines, 'Entries:'), 'Entries: 3 of 9');
});

test('the stated range names both bounds in ISO', () => {
  const lines = statementLines({
    range: { from: localMs(2026, 8, 1), to: localMs(2026, 8, 2) },
    shown: 2, total: 9,
  });
  assert.equal(lineStarting(lines, 'Range:'), 'Range: 2026-08-01 to 2026-08-02');
});

test('a half-open range is stated as half-open, not silently closed', () => {
  const fromOnly = statementLines({ range: { from: localMs(2026, 8, 1) }, shown: 1, total: 9 });
  assert.equal(lineStarting(fromOnly, 'Range:'), 'Range: from 2026-08-01 onwards');

  const toOnly = statementLines({ range: { to: localMs(2026, 8, 2) }, shown: 1, total: 9 });
  assert.equal(lineStarting(toOnly, 'Range:'), 'Range: up to 2026-08-02');
});

test('the statement carries the search, the preset and the actions when they are set', () => {
  const lines = statementLines({
    range: { from: localMs(2026, 8, 1), to: localMs(2026, 8, 2), presetId: 'last7' },
    search: 'contains "queue"',
    actions: ['created', 'deleted'],
    shown: 2, total: 9,
  });
  assert.equal(lineStarting(lines, 'Search:'), 'Search: contains "queue"');
  assert.equal(lineStarting(lines, 'Preset:'), 'Preset: last7');
  assert.equal(lineStarting(lines, 'Actions:'), 'Actions: created, deleted');
});

test('the "all" preset adds no Preset line, because it states nothing', () => {
  const lines = statementLines({ range: { presetId: 'all' }, shown: 1, total: 1 });
  assert.equal(lineStarting(lines, 'Preset:'), undefined);
});

test('the statement is timestamped in ISO and names its source', () => {
  const at = Date.UTC(2026, 7, 2, 4, 48, 5);
  const lines = statementLines({ shown: 1, total: 1, generatedAt: at, scope: 'a scope' });
  assert.equal(lineStarting(lines, 'Source:'), 'Source: a scope');
  assert.equal(lineStarting(lines, 'Generated:'), `Generated: ${new Date(at).toISOString()}`);
});

test('a swapped range is stated the right way round', () => {
  const lines = statementLines({
    range: { from: localMs(2026, 8, 5), to: localMs(2026, 8, 1) },
    shown: 0, total: 9,
  });
  assert.equal(lineStarting(lines, 'Range:'), 'Range: 2026-08-01 to 2026-08-05');
});

/* ================================================================== */
/* the export itself                                                   */
/* ================================================================== */

test('the Markdown export leads with the range statement', () => {
  const range = { from: localMs(2026, 8, 1), to: localMs(2026, 8, 2) };
  const shown = C.changelogEntries().slice(0, 2);
  const statement = C.exportRangeStatement({ range, shown: shown.length, total: 9 });
  const md = C.entriesToMarkdown(shown, statement, 'Changelog');
  assert.ok(md.startsWith('# Changelog'));
  assert.ok(md.includes('Range: 2026-08-01 to 2026-08-02'), 'the export must state its range');
});

test('an empty filtered view exports honestly instead of exporting everything', () => {
  const md = C.entriesToMarkdown([], C.exportRangeStatement({ shown: 0, total: 9 }), 'Changelog');
  assert.ok(md.includes('Entries: 0 of 9'));
  assert.ok(/nothing matched/i.test(md));
});

test('a version with no recorded changes says so rather than being omitted', () => {
  const entry = C.CHANGELOG.development.find((e) => !(e.changes || []).length);
  assert.ok(entry, 'the recorded history contains a commit with no itemised changes');
  const md = C.entriesToMarkdown([entry], 'x', 'Changelog');
  assert.ok(md.includes('_No recorded changes._'));
});

/* ================================================================== */
/* the recorded content is honest                                      */
/* ================================================================== */

test('no release is claimed that has not been published', () => {
  assert.deepEqual(C.CHANGELOG.releases, [], 'releases must stay empty until one is published');
  assert.equal(C.CURRENT_BUILD.released, false);
  assert.equal(C.CURRENT_BUILD.date, null, 'an unreleased build has no release date to state');
});

test('every development entry names a real commit and a real date', () => {
  assert.ok(C.CHANGELOG.development.length > 0);
  for (const e of C.CHANGELOG.development) {
    assert.match(e.ref, /^[0-9a-f]{7,40}$/, `${e.id} should carry a commit id`);
    assert.match(e.oid, /^[0-9a-f]{40}$/, `${e.id} should carry the FULL sha, not just the abbreviation`);
    assert.ok(e.oid.startsWith(e.ref), `${e.id}: the abbreviation and the full sha disagree`);
    assert.match(e.date, /^\d{4}-\d{2}-\d{2}$/, `${e.id} should carry an ISO date`);
    assert.ok(e.title && e.title.length > 0, `${e.id} should carry its subject`);
    for (const c of e.changes || []) {
      assert.ok(['added', 'changed', 'fixed', 'removed', 'security', 'breaking'].includes(c.category),
        `${e.id}: unexpected category ${c.category}`);
      assert.ok(c.text && c.text.length > 0);
    }
  }
});

test('every entry links to its commit, and the link is built from the full sha', () => {
  for (const e of C.CHANGELOG.development) {
    const url = C.commitUrl(e);
    assert.ok(url.startsWith(C.COMMIT_BASE), `${e.id}: the link must resolve against this project's forge`);
    assert.ok(url.endsWith(e.oid), `${e.id}: the link must carry the full sha`);
  }
  // An entry with no recorded commit gets no link at all rather than one that
  // guesses at a neighbour.
  assert.equal(C.commitUrl({ ref: 'abc1234' }), '');
  assert.equal(C.commitUrl(null), '');
});

/**
 * The referenced commits are resolved against the repository itself. A WRONG
 * sha is worse than none — it sends a reader somewhere confidently irrelevant —
 * so this fails the build rather than letting a dead link ship. It is skipped
 * only when the tree genuinely is not a git checkout (an unpacked tarball),
 * because there is then nothing to resolve against.
 */
test('every referenced commit exists in this repository', (t) => {
  const cp = require('node:child_process');
  const repo = path.join(__dirname, '..');
  try {
    cp.execFileSync('git', ['rev-parse', '--git-dir'], { cwd: repo, stdio: 'pipe' });
  } catch {
    t.skip('not a git checkout, so there is nothing to resolve the shas against');
    return;
  }
  for (const e of C.CHANGELOG.development) {
    let type = '';
    try {
      type = cp.execFileSync('git', ['cat-file', '-t', e.oid], { cwd: repo, stdio: 'pipe' }).toString().trim();
    } catch (err) {
      assert.fail(`${e.id}: commit ${e.oid} is not in this repository — a changelog link that 404s is worse than no link`);
    }
    assert.equal(type, 'commit', `${e.id}: ${e.oid} is a ${type}, not a commit`);
  }
});

/**
 * The test above needs history to exist, and on CI it did not.
 *
 * actions/checkout defaults to `fetch-depth: 1` — a shallow clone containing
 * the triggering commit and nothing before it. Every sha above then resolves
 * to nothing and the suite fails on CI while passing for everyone locally,
 * which is the worst shape a failure can take: the machine whose output people
 * actually read is the only one that disagrees.
 *
 * The tempting fix is to skip the sha check when the clone is shallow. That
 * turns the one assertion protecting against dead changelog links permanently
 * green in the only place it is ever run, so it is not a fix. The checkout
 * gets history instead, and this guards that single YAML line — it is one word
 * on one line, invisible in a reformat, and dropping it costs nothing until a
 * red build appears with no obvious cause.
 *
 * Other assertions about ci.yml live in test/autoupdate.test.js; this one sits
 * here so that when the sha check above goes red on CI, its cause is the next
 * thing a reader scrolls past.
 */
test('every CI checkout fetches full history, or the sha check above cannot run', () => {
  const fs = require('node:fs');
  const raw = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8');
  // Strip comments first, exactly as autoupdate.test.js does, so the paragraph
  // explaining fetch-depth cannot be what satisfies the assertion about it.
  // The trailing \r goes first: `.` never matches a carriage return, so against
  // a CRLF checkout a comment stripper anchored on `$` silently does nothing.
  const ci = raw.split('\n')
    .map((l) => l.replace(/\r$/, '').replace(/(^|\s)#.*$/, ''))
    .join('\n');

  const checkouts = (ci.match(/uses:\s*actions\/checkout@/g) || []).length;
  assert.ok(checkouts > 0, 'ci.yml must still check the repository out');

  // Checked BEFORE the count, so that a fixed depth is reported as a fixed
  // depth. `fetch-depth: 50` would fail the count assertion too, but with a
  // message about missing history, which sends the reader looking for a line
  // that is right there in front of them.
  const finite = ci.match(/^\s*fetch-depth:\s*(?!0\s*$)\S+.*$/gm);
  assert.equal(finite, null,
    `fetch-depth must be 0, not a fixed depth that the changelog will outgrow (found ${finite})`);

  // Counted, not merely matched once. Both jobs check out, and a third job
  // added later without full history would reintroduce exactly this bug in a
  // way a single `assert.match` over the whole file would never notice.
  const full = (ci.match(/^\s*fetch-depth:\s*0\s*$/gm) || []).length;
  assert.equal(full, checkouts,
    `every actions/checkout must set fetch-depth: 0 (${checkouts} checkouts, ${full} with full history) — ` +
    'the default is a depth-1 shallow clone in which no changelog sha resolves');

  // vendor/winscp is the large read-only porting reference. fetch-depth and
  // submodules are independent inputs, so asking for history must never have
  // been paid for by quietly pulling 300k lines of C++ into every run.
  assert.equal((ci.match(/^\s*submodules:\s*false\s*$/gm) || []).length, checkouts,
    'every checkout must still skip the vendor/winscp submodule');
});

test('the exported Markdown keeps the full sha and the link in plain text', () => {
  const entry = C.CHANGELOG.development[0];
  const md = C.entriesToMarkdown([entry], 'x', 'Changelog');
  assert.ok(md.includes(entry.oid), 'a copied changelog must stay traceable');
  assert.ok(md.includes(C.commitUrl(entry)));
});

test('every entry is searchable by its own text', () => {
  for (const e of C.changelogEntries()) {
    const fields = C.entryText(e);
    assert.ok(fields.length > 0, `${e.id} should expose something to search`);
    if (e.ref) assert.ok(fields.includes(e.ref));
  }
});

test('the release code name carries both names so it can be shown in either language', () => {
  assert.ok(C.CURRENT_BUILD.codeName.en);
  assert.ok(C.CURRENT_BUILD.codeName.zh);
  assert.ok(C.CURRENT_BUILD.codeName.file, 'the code name must know which bundled image is its own');
});
