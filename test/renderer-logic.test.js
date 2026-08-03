// renderer-logic.test.js — the renderer's shared, DOM-free machinery.
//
// Three things every search surface, every bulk action and every colour
// control in the app depends on:
//
//   1. makePredicate()  — THE match predicate. One object, used for a filter
//      and for its inverse, so flags, casing, Unicode and scope cannot drift
//      between "containing" and "not containing".
//   2. evaluate()       — bounded regex evaluation. A catastrophic pattern is
//      reported as a runaway, not left to hang the window.
//   3. parseAnyColor()  — the inverse half of the colour translator, so every
//      representation it emits reads back as the same colour with its alpha.
//
// All three are exported as pure functions precisely so they can be tested
// here rather than by driving a window.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Worker } = require('node:worker_threads');

const loadRegex = () => import('../design/renderer/ui/regexbuilder.js');
const loadSearch = () => import('../design/renderer/ui/searchbar.js');
const loadColor = () => import('../design/renderer/ui/colorpicker.js');
const loadData = () => import('../design/winscp-data.js');
const loadPanels = () => import('../design/renderer/ui/panels.js');

test('panel listings reject malformed rows without turning them into a fake empty state', async () => {
  const { normalizePanelEntries } = await loadPanels();
  const result = normalizePanelEntries([{ name: 'readme.txt', type: 'file' }, null, {}, { name: '' }, { name: 'folder', type: 'dir' }]);
  assert.deepEqual(result.entries.map((entry) => entry.name), ['readme.txt', 'folder']);
  assert.equal(result.invalidCount, 3);
  assert.deepEqual(normalizePanelEntries(undefined), { entries: [], invalidCount: 0 });
});

/* ================================================================== */
/* the match predicate                                                 */
/* ================================================================== */

test('plain text is a case-insensitive substring match', async () => {
  const { makePredicate } = await loadRegex();
  const p = makePredicate({ query: 'RepoRT', mode: 'text' });

  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.mode, 'text');
  assert.strictEqual(p.describe, 'contains "RepoRT"');
  assert.strictEqual(p.test('q1-REPORT.md'), true);
  assert.strictEqual(p.test('q1-report.md'), true);
  assert.strictEqual(p.test('deploy.sh'), false);

  // Plain text is literal: metacharacters are haystack, not syntax.
  const dotted = makePredicate({ query: 'a.b', mode: 'text' });
  assert.strictEqual(dotted.test('a.b'), true);
  assert.strictEqual(dotted.test('axb'), false);

  // An empty query matches everything, so "no filter" never means "no rows".
  const empty = makePredicate({ query: '', mode: 'text' });
  assert.strictEqual(empty.test('anything'), true);
  assert.strictEqual(empty.test(''), true);

  // A null or undefined value is not a crash and not a match.
  assert.strictEqual(p.test(null), false);
  assert.strictEqual(p.test(undefined), false);
  assert.strictEqual(makePredicate({ query: 'x', mode: 'text' }).test(0), false);
  assert.strictEqual(makePredicate({ query: '0', mode: 'text' }).test(0), true);
});

test('plain text folds case the way the platform does', async () => {
  const { makePredicate } = await loadRegex();

  // Locale-aware lower-casing, not ASCII tolower: these are the cases that
  // silently differ between a "containing" and a "not containing" filter if the
  // two are built separately.
  assert.strictEqual(makePredicate({ query: 'ÉTÉ', mode: 'text' }).test('rapport été.txt'), true);
  assert.strictEqual(makePredicate({ query: 'ΣΊΣΥΦΟΣ', mode: 'text' }).test('σίσυφος'), true);
  assert.strictEqual(makePredicate({ query: 'СЕКРЕТ', mode: 'text' }).test('секрет.key'), true);
  // CJK has no case, so it must survive folding untouched.
  assert.strictEqual(makePredicate({ query: '報表', mode: 'text' }).test('Q1 報表 v2.xlsx'), true);
  // Astral-plane characters are matched whole, not by surrogate half.
  assert.strictEqual(makePredicate({ query: '𝄞', mode: 'text' }).test('score 𝄞.mid'), true);
});

test('regex mode strips the g flag so one predicate can be reused', async () => {
  const { makePredicate } = await loadRegex();
  const p = makePredicate({ pattern: '\\.md$', flags: 'gi', mode: 'regex' });

  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.mode, 'regex');
  assert.strictEqual(p.describe, '/\\.md$/i', 'the g flag must not appear in the description either');

  // A sticky lastIndex is exactly how "close containing" and "close NOT
  // containing" would disagree about the same tab. Ten identical calls, ten
  // identical answers.
  for (let i = 0; i < 10; i += 1) {
    assert.strictEqual(p.test('notes.md'), true, `call ${i + 1} disagreed`);
  }
  assert.strictEqual(p.test('notes.MD'), true);      // the i flag survived
  assert.strictEqual(p.test('notes.txt'), false);
  assert.strictEqual(p.test('md.notes'), false);
});

test('regex flags are honoured', async () => {
  const { makePredicate } = await loadRegex();
  const multiline = makePredicate({ pattern: '^b', flags: 'm', mode: 'regex' });
  assert.strictEqual(multiline.test('a\nb'), true);
  assert.strictEqual(makePredicate({ pattern: '^b', flags: '', mode: 'regex' }).test('a\nb'), false);

  assert.strictEqual(makePredicate({ pattern: 'a.c', flags: 's', mode: 'regex' }).test('a\nc'), true);
  assert.strictEqual(makePredicate({ pattern: '\\p{Script=Han}', flags: 'u', mode: 'regex' }).test('報表'), true);
  assert.strictEqual(makePredicate({ pattern: 'ß', flags: 'iu', mode: 'regex' }).test('straße'), true);
});

test('an invalid pattern is reported, never thrown, and matches nothing', async () => {
  const { makePredicate } = await loadRegex();
  const bad = makePredicate({ pattern: '([', flags: 'i', mode: 'regex' });

  assert.strictEqual(bad.ok, false);
  assert.match(bad.error, /Invalid regular expression|Unterminated/);
  assert.strictEqual(bad.test('anything'), false);
  assert.strictEqual(bad.test(''), false);
  // Matching nothing rather than everything is the safe side for a bulk close.
});

test('the search predicate refuses a runaway pattern instead of hanging on it', async () => {
  // makePredicate is what every search bar and both bulk closes actually run,
  // and it runs SYNCHRONOUSLY on the UI thread: there is no Worker to
  // terminate and no deadline to check between matches. evaluate() has that
  // protection; this path never goes through evaluate(), so it must refuse.
  const { makePredicate, backtrackingRisk, RUNAWAY_REFUSAL } = await loadRegex();

  const evil = ['(a+)+b', '(a*)*c', '(?:a+)+b', '(a|a)*b'];
  for (const pattern of evil) {
    assert.ok(backtrackingRisk(pattern), `${pattern} is no longer flagged as a hazard`);
    const p = makePredicate({ pattern, flags: '', mode: 'regex' });
    assert.strictEqual(p.ok, false, `${pattern} was accepted by the search predicate`);
    assert.strictEqual(p.error, RUNAWAY_REFUSAL);
    // Refusing means matching nothing, which is the safe side for a bulk close.
    assert.strictEqual(p.test('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), false);
  }

  // And the refusal is narrow: ordinary patterns still work.
  for (const pattern of ['^web-\d+$', '[a-z]+@[a-z]+', '(foo|bar)', 'a{2,4}b']) {
    assert.strictEqual(backtrackingRisk(pattern), false, `${pattern} is falsely flagged`);
    assert.strictEqual(makePredicate({ pattern, mode: 'regex' }).ok, true, `${pattern} was refused`);
  }
});

test('escapeLiteral makes any string match itself', async () => {
  const { escapeLiteral, compile } = await loadRegex();

  const corpus = [
    'a.b*c(d)/e-f', 'q1-report.md', '[draft] notes {2}.txt', '^start$', 'a|b',
    'C:\\srv\\www\\index.html', '100%+ (copy).tar.gz', '報表 (第2版).xlsx', 'a+b?c',
  ];
  for (const literal of corpus) {
    const compiled = compile(escapeLiteral(literal), '');
    assert.strictEqual(compiled.ok, true, `${literal} produced an invalid pattern`);
    assert.strictEqual(compiled.regex.test(literal), true, `${literal} does not match itself`);
    assert.strictEqual(compiled.regex.test(`${literal}x`), true);
    // And it is a literal, not a pattern: nothing else it could have meant matches.
    if (literal.includes('.')) {
      assert.strictEqual(compiled.regex.test(literal.replace('.', 'Z')), false,
        `${literal}: the dot was still a metacharacter`);
    }
  }

  assert.strictEqual(compile('([', '').ok, false);
  assert.strictEqual(compile('a', 'zz').ok, false, 'an invalid flag must be reported too');
});

/* ================================================================== */
/* one predicate, negated once                                         */
/* ================================================================== */

test('a predicate and its negation partition any list exactly', async () => {
  const { makePredicate } = await loadRegex();

  const pool = [
    'q1-report.md', 'Q1-REPORT.MD', 'server-backup-2026-07.tar.gz', 'access.log',
    '報表 v2.xlsx', 'rapport été.txt', 'секрет.key', 'score 𝄞.mid', 'deploy.sh',
    '', '  ', 'MD', 'md', 'a.b', 'axb',
  ];
  const states = [
    { query: 'report', mode: 'text' },
    { query: 'MD', mode: 'text' },
    { query: '報', mode: 'text' },
    { query: '', mode: 'text' },
    { pattern: '\\.md$', flags: 'gi', mode: 'regex' },
    { pattern: '^\\s*$', flags: '', mode: 'regex' },
    { pattern: '\\p{Script=Han}', flags: 'gu', mode: 'regex' },
    { pattern: '2026', flags: 'g', mode: 'regex' },
  ];

  for (const state of states) {
    const predicate = makePredicate(state);
    // The two bulk-close directions, built exactly as ui/tabs.js builds them:
    // the SAME predicate object, negated once.
    const containing = pool.filter((v) => predicate.test(v));
    const notContaining = pool.filter((v) => !predicate.test(v));

    assert.strictEqual(containing.length + notContaining.length, pool.length,
      `${JSON.stringify(state)}: the two directions do not cover the pool`);
    assert.strictEqual(
      containing.filter((v) => notContaining.includes(v)).length, 0,
      `${JSON.stringify(state)}: an item landed in both directions`);
    assert.deepStrictEqual(
      [...containing, ...notContaining].slice().sort(), pool.slice().sort(),
      `${JSON.stringify(state)}: an item was lost or duplicated`);

    // Order within each side follows the pool, so a preview lists tabs in strip
    // order rather than match order.
    assert.deepStrictEqual(containing, pool.filter((v) => containing.includes(v)));
  }
});

test('two predicates built from the same state agree on every value', async () => {
  const { makePredicate } = await loadRegex();
  const state = { pattern: '(report|backup)', flags: 'gi', mode: 'regex' };
  const a = makePredicate(state);
  const b = makePredicate(state);

  for (const value of ['q1-report.md', 'BACKUP.tar', 'access.log', 'report', 'reportreport']) {
    assert.strictEqual(a.test(value), b.test(value), `predicates disagreed on "${value}"`);
    assert.strictEqual(a.test(value), b.test(value), 'a repeat call disagreed');
  }
  assert.strictEqual(a.describe, b.describe);
});

/* ================================================================== */
/* filterBy / noMatchMessage                                           */
/* ================================================================== */

test('filterBy never turns an empty query into an empty list', async () => {
  const { filterBy, noMatchMessage } = await loadSearch();
  const { makePredicate } = await loadRegex();

  const rows = [
    { label: 'Show hidden files', description: 'Panels', value: true },
    { label: 'Transfer mode', description: 'Binary', value: 'binary' },
    { label: '減少動態效果', description: 'Appearance', value: false },
  ];
  const fields = (r) => [r.label, r.description, String(r.value)];

  assert.deepStrictEqual(filterBy(rows, makePredicate({ query: '', mode: 'text' }), fields), rows);

  // A match on a secondary field still counts.
  assert.deepStrictEqual(
    filterBy(rows, makePredicate({ query: 'appearance', mode: 'text' }), fields).map((r) => r.label),
    ['減少動態效果']);
  assert.deepStrictEqual(
    filterBy(rows, makePredicate({ query: 'binary', mode: 'text' }), fields).map((r) => r.label),
    ['Transfer mode']);

  // An invalid pattern filters to nothing rather than silently to everything.
  assert.deepStrictEqual(filterBy(rows, makePredicate({ pattern: '([', mode: 'regex' }), fields), []);
  assert.deepStrictEqual(filterBy(rows, null, fields), []);

  // A bare string list works without a field accessor.
  assert.deepStrictEqual(
    filterBy(['alpha', 'beta'], makePredicate({ query: 'BET', mode: 'text' })),
    ['beta']);

  const message = noMatchMessage(makePredicate({ pattern: '\\.md$', flags: 'i', mode: 'regex' }), 'this page');
  assert.strictEqual(message, 'Nothing in this page matches pattern /\\.md$/i.');
  assert.match(noMatchMessage(makePredicate({ query: 'zzz', mode: 'text' }), 'the strip'),
    /Nothing in the strip matches contains "zzz"\./);
});

/* ================================================================== */
/* bounded regex evaluation                                            */
/* ================================================================== */

test('the evaluation bounds are the documented ones', async () => {
  const rb = await loadRegex();
  assert.strictEqual(rb.MAX_SAMPLE, 20000);
  assert.strictEqual(rb.MAX_MATCHES, 500);
  assert.strictEqual(rb.TIME_BUDGET_MS, 400);
  assert.strictEqual(rb.ENGINE_NAME, 'JavaScript RegExp (ECMAScript)');
});

test('evaluate reports matches, groups and named groups', async () => {
  const { evaluate } = await loadRegex();
  const result = await evaluate('(?<year>\\d{4})-(\\d{2})', 'g', '2026-08-02 and 1999-12-31', { inline: true });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.timedOut, false);
  assert.strictEqual(result.matches.length, 2);
  assert.strictEqual(result.matches[0].value, '2026-08');
  assert.strictEqual(result.matches[0].start, 0);
  assert.strictEqual(result.matches[0].end, 7);
  assert.deepStrictEqual(result.matches[0].groups, [
    { index: 1, value: '2026' }, { index: 2, value: '08' },
  ]);
  assert.deepStrictEqual(result.matches[0].named, [{ name: 'year', value: '2026' }]);
  assert.strictEqual(result.matches[1].value, '1999-12');
  assert.strictEqual(result.engine, 'JavaScript RegExp (ECMAScript)');
});

test('a zero-width pattern advances instead of looping forever', async () => {
  const { evaluate } = await loadRegex();
  const result = await evaluate('a*', 'g', 'bb', { inline: true });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.matches.length, 3);
  assert.deepStrictEqual(result.matches.map((m) => [m.start, m.end]), [[0, 0], [1, 1], [2, 2]]);
});

test('the sample is capped at MAX_SAMPLE characters', async () => {
  const { evaluate, MAX_SAMPLE } = await loadRegex();

  const beyond = 'y'.repeat(MAX_SAMPLE) + 'NEEDLE';
  assert.strictEqual((await evaluate('NEEDLE', 'g', beyond, { inline: true })).matches.length, 0,
    'text past the cap was still searched');

  const within = 'NEEDLE' + 'y'.repeat(MAX_SAMPLE);
  assert.strictEqual((await evaluate('NEEDLE', 'g', within, { inline: true })).matches.length, 1);
});

test('matches are capped at MAX_MATCHES and the truncation is reported', async () => {
  const { evaluate, MAX_MATCHES } = await loadRegex();
  const result = await evaluate('[a-z]+;', 'g', 'ab;'.repeat(MAX_MATCHES + 200), { inline: true });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.matches.length, MAX_MATCHES);
  assert.strictEqual(result.truncated, true, 'the cap was hit without saying so');
  assert.strictEqual(result.timedOut, false);
});

test('an invalid pattern resolves with the engine message and never rejects', async () => {
  const { evaluate } = await loadRegex();
  const result = await evaluate('([', 'g', 'abc', { inline: true });

  assert.strictEqual(result.ok, false);
  assert.match(result.error, /Invalid regular expression/);
  assert.deepStrictEqual(result.matches, []);
  assert.strictEqual(result.timedOut, false);

  const emptyPattern = await evaluate('', 'g', 'abc', { inline: true });
  assert.strictEqual(emptyPattern.ok, true);
  assert.deepStrictEqual(emptyPattern.matches, []);
});

test('the time budget is enforced and reported rather than exceeded', async () => {
  const { evaluate, TIME_BUDGET_MS } = await loadRegex();
  const sample = 'ab;'.repeat(600);

  // The real budget first, as the baseline for "how much work there was".
  const started = Date.now();
  const normal = await evaluate('[a-z]+;', 'g', sample, { inline: true });
  assert.strictEqual(normal.timedOut, false);
  assert.ok(normal.matches.length > 0);
  assert.ok(Date.now() - started < TIME_BUDGET_MS,
    `a routine evaluation took ${Date.now() - started} ms of a ${TIME_BUDGET_MS} ms budget`);

  // A budget below one clock tick: the deadline has certainly passed by the
  // first match, so this asserts the mechanism deterministically on any host.
  // The run stops early and SAYS it stopped early — the caller reads timedOut
  // and shows the runaway warning rather than presenting a short list as if it
  // were the whole answer.
  const starved = await evaluate('[a-z]+;', 'g', sample, { inline: true, budgetMs: 0.01 });
  assert.strictEqual(starved.ok, true);
  assert.strictEqual(starved.timedOut, true, 'the deadline was not enforced');
  assert.strictEqual(starved.truncated, false, 'a deadline stop is not a match-count truncation');
  assert.ok(starved.matches.length < normal.matches.length,
    `the starved run returned ${starved.matches.length} of ${normal.matches.length} matches — it did not stop early`);
});

test('the canonical catastrophic shapes are flagged before they can be run', async () => {
  const { backtrackingRisk } = await loadRegex();

  for (const evil of ['(a+)+$', '(a+)+b', '(a|a)*$', '(\\s*\\w*)+', '(?:a+)+', '(?:\\d+)+$', '([a-z]+)+@']) {
    assert.strictEqual(backtrackingRisk(evil), true, `${evil} was not flagged as a backtracking hazard`);
  }
  for (const safe of ['\\.(jpe?g|png)$', '^[a-z]+$', 'report', '\\d{4}-\\d{2}-\\d{2}', '(?<y>\\d{4})']) {
    assert.strictEqual(backtrackingRisk(safe), false, `${safe} was wrongly flagged`);
  }
});

test('a runaway pattern is terminated, not waited for', async (t) => {
  const { TIME_BUDGET_MS, backtrackingRisk } = await loadRegex();

  // The pattern the builder warns about. In the app it runs inside a Worker
  // that is terminated at TIME_BUDGET_MS; here the same strategy is applied
  // from the test, which proves two things at once — the pattern really does
  // run away (so the warning is not theatre), and terminating it is what keeps
  // the caller responsive.
  const pattern = '(a+)+b';
  const sample = `${'a'.repeat(32)}!`;
  assert.strictEqual(backtrackingRisk(pattern), true);

  const worker = new Worker(
    'const { parentPort, workerData } = require("node:worker_threads");'
    + 'parentPort.postMessage(new RegExp(workerData.pattern).test(workerData.sample));',
    { eval: true, workerData: { pattern, sample } },
  );

  const started = Date.now();
  const outcome = await new Promise((resolve) => {
    const timer = setTimeout(() => { worker.terminate().then(() => resolve('terminated')); }, TIME_BUDGET_MS);
    worker.on('message', () => { clearTimeout(timer); resolve('finished'); });
    worker.on('error', (err) => { clearTimeout(timer); resolve(`error: ${err.message}`); });
  });
  const elapsed = Date.now() - started;

  assert.strictEqual(outcome, 'terminated',
    'the "evil" pattern completed inside the budget, so it is no longer a useful runaway fixture');
  assert.ok(elapsed < TIME_BUDGET_MS * 4,
    `termination took ${elapsed} ms against a ${TIME_BUDGET_MS} ms budget`);
  t.diagnostic(`runaway pattern /${pattern}/ terminated after ${elapsed} ms`);
});

/* ================================================================== */
/* the colour translator                                               */
/* ================================================================== */

/**
 * Notations that structurally cannot carry alpha. `hsv()` and `cmyk()` have no
 * alpha component and six-digit hex has no alpha byte; the translator lists
 * HEX8 and RGB beside them, which do. Four of them, and the list is asserted
 * exactly, so a fifth cannot start dropping alpha unnoticed.
 *
 * Dropping alpha is allowed; dropping it SILENTLY is not — see the test below,
 * which pins the picker's own declaration of this set so the warning it shows
 * cannot drift from the notations that actually need it.
 */
const ALPHA_FREE_NOTATIONS = ['HEX', 'HSV/HSB', 'CMYK', 'Named'];

test('the picker warns on exactly the notations that cannot carry alpha', async () => {
  const { ALPHA_FREE_NOTATIONS: shipped } = await loadColor();
  assert.ok(shipped instanceof Set, 'ui/colorpicker.js no longer declares the alpha-free set');
  assert.deepStrictEqual([...shipped].sort(), [...ALPHA_FREE_NOTATIONS].sort(),
    'the set the picker warns about is not the set that actually drops alpha');

  // The warning must reach the row, its accessible name and the copy button —
  // a customization surface may not silently drop a value it cannot represent.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'design', 'renderer', 'ui', 'colorpicker.js'), 'utf8');
  assert.match(src, /ALPHA_FREE_NOTATIONS\.has\(row\.k\)/, 'the translator no longer checks for alpha loss');
  assert.match(src, /'aria-label': `Copy \$\{row\.k\} value\$\{note\}`/,
    'the copy button no longer names the alpha loss in its accessible name');
});

test('every notation the translator emits reads back as the same colour', async () => {
  const { translateColor } = await loadData();
  const { parseAnyColor } = await loadColor();

  const colours = [
    [11, 87, 208, 1], [179, 38, 30, 0.5], [20, 108, 46, 0.25], [255, 255, 255, 1],
    [0, 0, 0, 1], [128, 128, 128, 0.75], [255, 222, 63, 1], [0, 105, 110, 0.1],
    [103, 80, 164, 0.99], [1, 2, 3, 1],
  ];

  for (const [r, g, b, a] of colours) {
    const reps = translateColor(r, g, b, a);
    const emitted = reps.map((x) => x.k);
    assert.deepStrictEqual(emitted, [
      'Named', 'HEX', 'HEX8', 'RGB', 'HSL', 'HSV/HSB', 'HWB',
      'CIELAB', 'LCH', 'OKLab', 'OKLCH', 'CMYK',
    ], 'the translator gained or lost a representation');

    for (const { k, v } of reps) {
      // "≈ royalblue" is a nearest-name label, not a value; the picker shows it
      // as prose and never round-trips it.
      if (k === 'Named' && v.startsWith('≈')) continue;

      const back = parseAnyColor(v);
      assert.ok(back, `${k} "${v}" did not parse back`);
      for (const [channel, expected] of [['r', r], ['g', g], ['b', b]]) {
        assert.ok(Math.abs(back[channel] - expected) <= 2,
          `${k} "${v}": ${channel} came back as ${back[channel]}, expected ${expected}`);
      }

      if (ALPHA_FREE_NOTATIONS.includes(k)) {
        assert.strictEqual(back.a, 1, `${k} has no alpha component but reported ${back.a}`);
      } else if (k === 'HEX8') {
        // Alpha is one byte, so it round-trips to within 1/255.
        assert.ok(Math.abs(back.a - a) <= 1 / 255 + 1e-9,
          `${k} "${v}": alpha came back as ${back.a}, expected ${a}`);
      } else {
        assert.strictEqual(back.a, a, `${k} "${v}": alpha came back as ${back.a}, expected ${a}`);
      }
    }
  }
});

test('parseAnyColor names the space it read', async () => {
  const { parseAnyColor } = await loadColor();
  const cases = [
    ['#0b57d0', 'HEX'], ['#0B57D0', 'HEX'], ['#abc', 'HEX'], ['#0b57d080', 'HEX8'],
    ['royalblue', 'Named'], ['white', 'Named'],
    ['rgb(11 87 208)', 'RGB'], ['rgba(11,87,208,0.5)', 'RGB'], ['rgb(11 87 208 / 50%)', 'RGB'],
    ['hsl(217 90% 43%)', 'HSL'], ['hsv(217 95% 82%)', 'HSV/HSB'], ['hwb(217 4% 18%)', 'HWB'],
    ['lab(40% 27 -68)', 'CIELAB'], ['lch(40% 73 292)', 'LCH'],
    ['oklab(0.495 -0.033 -0.196)', 'OKLab'], ['oklch(0.495 0.199 261)', 'OKLCH'],
    ['cmyk(95% 58% 0% 18%)', 'CMYK'],
  ];
  for (const [value, space] of cases) {
    const parsed = parseAnyColor(value);
    assert.ok(parsed, `${value} did not parse`);
    assert.strictEqual(parsed.space, space, `${value} was read as ${parsed.space}`);
  }

  for (const junk of ['not a colour', '', null, undefined, '#12345g', '#12', 'rgb 11 87 208']) {
    assert.strictEqual(parseAnyColor(junk), null, `${JSON.stringify(junk)} was accepted`);
  }

  // For every well-formed notation, whole channels in range — the picker writes
  // these straight into a style value. (A truncated notation such as "rgb(" is
  // NOT covered: it currently returns NaN channels rather than null. That is a
  // defect in parseAnyColor, recorded in the verification article's known gaps,
  // not an invariant worth asserting here.)
  for (const value of cases.map((c) => c[0])) {
    const parsed = parseAnyColor(value);
    for (const channel of ['r', 'g', 'b']) {
      assert.ok(Number.isInteger(parsed[channel]) && parsed[channel] >= 0 && parsed[channel] <= 255,
        `${value}: ${channel} is ${parsed[channel]}`);
    }
    assert.ok(parsed.a >= 0 && parsed.a <= 1, `${value}: alpha is ${parsed.a}`);
  }
});

test('alpha survives every notation that can express it', async () => {
  const { parseAnyColor } = await loadColor();
  const withAlpha = [
    ['#0b57d080', 0.502], ['#abcd', 0.867],
    ['rgba(11, 87, 208, 0.4)', 0.4], ['rgb(11 87 208 / 40%)', 0.4],
    ['hsl(217 90% 43% / 0.4)', 0.4], ['hwb(217 4% 18% / 0.4)', 0.4],
    ['lab(40% 27 -68 / 0.4)', 0.4], ['lch(40% 73 292 / 0.4)', 0.4],
    ['oklab(0.495 -0.033 -0.196 / 0.4)', 0.4], ['oklch(0.495 0.199 261 / 0.4)', 0.4],
  ];
  for (const [value, expected] of withAlpha) {
    const parsed = parseAnyColor(value);
    assert.ok(parsed, `${value} did not parse`);
    assert.ok(Math.abs(parsed.a - expected) < 0.002, `${value}: alpha ${parsed.a}, expected ${expected}`);
  }

  // A legacy fourth argument above 1 is read as a percentage, which is how
  // `rgba(0,0,0,50)` from an older stylesheet keeps meaning half-transparent.
  assert.strictEqual(parseAnyColor('rgba(0,0,0,50)').a, 0.5);
  // And alpha is clamped into 0..1 rather than wrapping or being dropped.
  assert.strictEqual(parseAnyColor('rgba(0,0,0,-3)').a, 0);
  assert.strictEqual(parseAnyColor('rgb(0 0 0 / 150%)').a, 1);
  assert.strictEqual(parseAnyColor('rgb(0 0 0 / -20%)').a, 0);
});

test('a colour outside sRGB is flagged before it is clipped', async () => {
  const { parseAnyColor } = await loadColor();

  for (const outside of ['lab(60% 120 -80)', 'oklch(0.7 0.4 150)', 'lch(50% 150 30)']) {
    const parsed = parseAnyColor(outside);
    assert.ok(parsed, `${outside} did not parse`);
    assert.strictEqual(parsed.inGamut, false, `${outside} was not reported as out of gamut`);
    for (const channel of ['r', 'g', 'b']) {
      assert.ok(parsed[channel] >= 0 && parsed[channel] <= 255,
        `${outside}: ${channel} was not clipped into range`);
    }
  }

  for (const inside of ['lab(40% 27 -68)', 'oklch(0.495 0.199 261)', '#0b57d0', 'rgb(11 87 208)']) {
    assert.strictEqual(parseAnyColor(inside).inGamut, true, `${inside} was wrongly flagged`);
  }
});

test('the inverse colour transforms invert the forward ones', async () => {
  const { rgbToXyz, xyzToLab, labToLch, rgbToOklab, rgbToHwb, rgbToCmyk, rgbToHsv } = await loadData();
  const { xyzToRgb, labToXyz, lchToLab, oklabToRgb, hwbToRgb, cmykToRgb } = await loadColor();

  const colours = [[11, 87, 208], [179, 38, 30], [20, 108, 46], [255, 222, 63], [0, 0, 0], [255, 255, 255], [128, 128, 128]];

  for (const [r, g, b] of colours) {
    const xyz = rgbToXyz(r, g, b);
    const backXyz = xyzToRgb(xyz.x, xyz.y, xyz.z);
    assert.ok(Math.max(Math.abs(backXyz.r - r), Math.abs(backXyz.g - g), Math.abs(backXyz.b - b)) <= 1,
      `XYZ round trip lost ${[r, g, b]} -> ${[backXyz.r, backXyz.g, backXyz.b]}`);

    const lab = xyzToLab(xyz.x, xyz.y, xyz.z);
    const fromLab = xyzToRgb(...Object.values(labToXyz(lab.L, lab.a, lab.b)));
    assert.ok(Math.max(Math.abs(fromLab.r - r), Math.abs(fromLab.g - g), Math.abs(fromLab.b - b)) <= 1,
      `Lab round trip lost ${[r, g, b]}`);

    const lch = labToLch(lab.L, lab.a, lab.b);
    const backLab = lchToLab(lch.L, lch.C, lch.H);
    assert.ok(Math.abs(backLab.a - lab.a) < 1e-6 && Math.abs(backLab.b - lab.b) < 1e-6,
      'LCH round trip lost a or b');

    const ok = rgbToOklab(r, g, b);
    const backOk = oklabToRgb(ok.L, ok.a, ok.b);
    assert.ok(Math.max(Math.abs(backOk.r - r), Math.abs(backOk.g - g), Math.abs(backOk.b - b)) <= 1,
      `OKLab round trip lost ${[r, g, b]}`);

    const hwb = rgbToHwb(r, g, b);
    const backHwb = hwbToRgb(hwb.h, hwb.w, hwb.bl);
    assert.ok(Math.max(Math.abs(backHwb.r - r), Math.abs(backHwb.g - g), Math.abs(backHwb.b - b)) <= 1,
      `HWB round trip lost ${[r, g, b]}`);

    const cmyk = rgbToCmyk(r, g, b);
    const backCmyk = cmykToRgb(cmyk.c, cmyk.m, cmyk.y, cmyk.k);
    assert.ok(Math.max(Math.abs(backCmyk.r - r), Math.abs(backCmyk.g - g), Math.abs(backCmyk.b - b)) <= 1,
      `CMYK round trip lost ${[r, g, b]}`);

    // Achromatic input must not invent a hue on the way back.
    if (r === g && g === b) assert.strictEqual(rgbToHsv(r, g, b).s, 0);
  }
});
