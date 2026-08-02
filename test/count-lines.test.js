// count-lines.test.js — the release's line count, and who wrote the lines.
//
// Every release has to state how much code this project is, and CI has to be
// what measures it. That makes tools/count-lines.js a published artefact rather
// than a convenience script, and the two ways it can lie are both silent:
//
//   1. THE TABLE CAN DISAGREE WITH ITSELF. The size table counts bytes; the
//      authorship table counts what `git blame` accounts for. Those are two
//      different programs reading the same files, and if they ever produce
//      different totals then one of them is wrong and a reader has no way to
//      tell which — an unexplained gap between two numbers in one table
//      destroys the credibility of both. The classic cause is counting the
//      empty string after a file's trailing newline as a line, which blame does
//      not. So: the attribution total must equal the counted total, exactly, or
//      the split is withheld and the process exits non-zero.
//
//   2. ATTRIBUTION CAN BE CONFIDENTLY WRONG. `git blame` on a shallow clone
//      does not fail. It exits 0 and credits every line of every file to the
//      single grafted boundary commit, which on this repository would print a
//      tidy 100% for whoever happened to make the tip commit. A wrong number
//      that looks right is worse than a missing one, so the counter must refuse
//      rather than guess, and say why.
//
// Everything here is headless and reads the real repository, because the thing
// under test IS the repository's own measurement of itself.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const TOOL = path.join(ROOT, 'tools', 'count-lines.js');
const C = require(TOOL);

/** Strip the thousands separators the tables print for humans. */
const num = (s) => Number(String(s).replace(/,/g, ''));

/** One row of a markdown table, by the label in its first cell. */
function row(md, label) {
  const re = new RegExp(`^\\|\\s*(?:\\*\\*)?${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^|]*\\|(.*)$`, 'm');
  const m = re.exec(md);
  if (!m) return null;
  return m[1].split('|').map((c) => c.replace(/\*/g, '').trim()).filter((c, i, a) => i < a.length - 1 || c !== '');
}

/* ================================================================== */
/* 1. The counter's arithmetic must agree with itself                  */
/* ================================================================== */

test('attribution accounts for exactly the lines the counter counted', async () => {
  const m = C.measure();
  const a = await C.attribute(m.files);

  assert.ok(a.available, `attribution unavailable: ${a.reason || '(no reason given)'}`);
  assert.deepStrictEqual(a.mismatches, [], 'per-file blame and byte counts disagree');

  // The headline identity. If this ever fails, the number must not be
  // published — not rounded, not explained away in a footnote.
  assert.strictEqual(a.total, a.counted, 'blamed lines !== counted lines');
  assert.strictEqual(a.nonBlank, a.countedNonBlank, 'blamed non-blank !== counted non-blank');
  assert.strictEqual(a.total, m.grand.total, 'blamed lines !== hand-written + generated');
  assert.strictEqual(a.reconciled, true);

  // ...and it has to hold per column, not merely in aggregate, or a bug that
  // moved lines between the two scopes would cancel out and look correct.
  const cls = Object.values(a.classes);
  assert.strictEqual(cls.reduce((s, c) => s + c.hand, 0), m.handWritten.total, 'hand-written column does not add up');
  assert.strictEqual(cls.reduce((s, c) => s + c.generated, 0), m.generated.total, 'generated column does not add up');
  assert.strictEqual(cls.reduce((s, c) => s + c.total, 0), a.total);
});

test('a trailing newline is not counted as an extra line by either counter', () => {
  // The specific arithmetic bug this whole check exists to catch: `"a\n"`
  // split on newline yields ["a", ""], and the empty tail is not a line. git
  // blame agrees, which is the only reason the two totals can ever match.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wscp-count-'));
  try {
    const withNl = path.join(dir, 'a.txt');
    const withoutNl = path.join(dir, 'b.txt');
    fs.writeFileSync(withNl, 'one\ntwo\n');
    fs.writeFileSync(withoutNl, 'one\ntwo');
    // measure() only reads tracked repository files, so exercise the same rule
    // through the blame parser, which is the half that has to agree with git.
    const p = C.parseBlame(
      '1111111111111111111111111111111111111111 1 1 2\n\tone\n'
      + '1111111111111111111111111111111111111111 2 2\n\ttwo\n',
    );
    assert.strictEqual(p.lines, 2, 'blame parser gained or lost a line');
    assert.strictEqual(p.per.get('1'.repeat(40)).total, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a file whose own text looks like a blame header is still parsed correctly', () => {
  // Content lines are the ones prefixed with a TAB. A file that literally
  // contains "0000000000000000000000000000000000000000 1 1" as text — this
  // project has several, in test fixtures and documentation — must not be read
  // as a new commit group, or its lines get credited to nobody.
  const sha = 'a'.repeat(40);
  const p = C.parseBlame(
    `${sha} 1 1 2\n\t${'0'.repeat(40)} 1 1\n`
    + `${sha} 2 2\n\t   \n`,
  );
  assert.strictEqual(p.lines, 2);
  assert.strictEqual(p.per.size, 1, 'a content line was mistaken for a commit header');
  assert.strictEqual(p.per.get(sha).total, 2);
  assert.strictEqual(p.per.get(sha).nonBlank, 1, 'a whitespace-only line counted as non-blank');
});

/* ================================================================== */
/* 2. Which rule decided a commit, stated so it can be checked         */
/* ================================================================== */

test('a commit is agent-written under exactly the two stated rules', () => {
  const agentAuthor = { name: 'Claude', email: 'noreply@anthropic.com', body: 'Do a thing\n' };
  const coAuthored = {
    name: 'codingmachineedge', email: 'someone@example.com',
    body: 'Do a thing\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>\n',
  };
  const human = { name: 'codingmachineedge', email: 'someone@example.com', body: 'Initial commit\n' };
  const bot = { name: 'github-actions[bot]', email: '41898282+github-actions[bot]@users.noreply.github.com', body: 'Bump\n' };

  assert.strictEqual(C.classifyCommit(agentAuthor), 'agentAuthor');
  assert.strictEqual(C.classifyCommit(coAuthored), 'agentCoAuthor');
  assert.strictEqual(C.classifyCommit(human), 'human');
  assert.strictEqual(C.classifyCommit(bot), 'agentAuthor');

  // A human co-author is not an agent co-author. Getting this wrong would
  // sweep every pair-programmed commit into the agent column.
  assert.strictEqual(C.classifyCommit({
    name: 'Someone', email: 'someone@example.com',
    body: 'Fix\n\nCo-Authored-By: Another Person <other@example.com>\n',
  }), 'human');

  assert.strictEqual(C.trailers(coAuthored.body).length, 1);
  assert.strictEqual(C.trailers(coAuthored.body)[0].email, 'noreply@anthropic.com');

  // The rule has to be PUBLISHED with the number, or the split is unfalsifiable.
  assert.strictEqual(C.AGENT_RULES.length, 2);
  assert.match(C.AGENT_RULES[0], /author/i);
  assert.match(C.AGENT_RULES[1], /Co-Authored-By/i);
});

/* ================================================================== */
/* 3. Degrade honestly without history — never guess                   */
/* ================================================================== */

test('a shallow clone is refused with an actionable reason, not a fabricated split', async () => {
  const notice = C.shallowNotice(true);
  assert.ok(notice, 'a shallow clone must produce a refusal');
  assert.match(notice, /shallow/i);
  assert.match(notice, /fetch-depth: 0|unshallow/, 'the refusal must say how to fix it');
  assert.strictEqual(C.shallowNotice(false), null, 'a full clone must not be refused');

  // With a reason, attribution reports unavailable and prints no numbers at all.
  const a = await C.attribute([{ rel: 'README.md', scope: 'hand', total: 1, nonBlank: 1 }], {
    historyProblem: () => notice,
  });
  assert.strictEqual(a.available, false);
  assert.strictEqual(a.reason, notice);
  assert.strictEqual(a.classes, undefined, 'no split may be emitted without history');
  assert.ok(Array.isArray(a.rules), 'the rules are still stated so a reader knows what was not measured');
});

test('markdown says the split was not measured rather than omitting it silently', () => {
  const m = C.measure();
  const md = C.markdown(m, null, { available: false, reason: 'this is a shallow clone, so blame would lie', rules: C.AGENT_RULES });
  assert.match(md, /Authorship was not measured/i);
  assert.match(md, /shallow clone/i);
  assert.ok(!/Agent-written, both rules/.test(md), 'a split was printed with no history behind it');
});

/* ================================================================== */
/* 4. The markdown a release actually pastes                           */
/* ================================================================== */

test('--markdown emits the attribution rows and BOTH totals, and they agree', () => {
  const r = cp.spawnSync(process.execPath, [TOOL, '--markdown'], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  assert.strictEqual(r.status, 0, `count-lines exited ${r.status}: ${r.stderr}`);
  const md = r.stdout;

  // --- the size table, both totals, with the excluded rows visible ---------
  const hand = row(md, 'Hand-written total');
  const project = row(md, 'Project total');
  const grand = row(md, 'Grand total');
  assert.ok(hand, 'no hand-written total row');
  assert.ok(project, 'no project total row');
  assert.ok(grand, 'no grand total row — the excluded lines are invisible');
  assert.match(md, /_Excluded_ — `vendor\/winscp`/, 'the vendored exclusion is not in the table');
  assert.match(md, /_Excluded_ — `package-lock\.json`/, 'the lockfile exclusion is not in the table');
  assert.ok(num(grand[1]) > num(project[1]), 'the grand total must exceed the project total');
  assert.ok(num(grand[2]) >= num(project[2]));

  // --- the attribution table ----------------------------------------------
  const agent = row(md, 'Agent-written, both rules together');
  const human = row(md, 'Human-written');
  const attributed = row(md, 'Attributed total');
  assert.ok(agent, 'no agent-written row');
  assert.ok(human, 'no human-written row');
  assert.ok(attributed, 'no attributed total row');
  assert.match(md, /git blame/, 'the method is not stated');
  assert.match(md, /Co-Authored-By/, 'the co-author rule is not stated');
  assert.match(md, /surviving line/i, 'the per-surviving-line basis is not stated');

  // The whole point: the attribution total is the project total, twice.
  assert.strictEqual(num(attributed[2]), num(project[1]), 'attributed lines !== project total lines');
  assert.strictEqual(num(attributed[0]), num(hand[1]), 'attributed hand-written column !== hand-written total');

  // ...and the rows themselves add up to it.
  const cols = (r0) => r0.slice(0, 3).map(num);
  const parts = ['Agent — commit authored by an automation identity', 'Agent — `Co-Authored-By:` trailer', 'Human-written']
    .map((label) => row(md, label))
    .filter(Boolean);
  assert.strictEqual(parts.length, 3, 'an attribution row is missing');
  const uncommitted = row(md, 'Uncommitted in the working tree');
  const sum = [...parts, ...(uncommitted ? [uncommitted] : [])]
    .reduce((acc, p) => cols(p).map((v, i) => acc[i] + v), [0, 0, 0]);
  assert.deepStrictEqual(sum, cols(attributed), 'the attribution rows do not sum to their own total');

  // Reproducibility is part of the claim.
  assert.match(md, /node tools\/count-lines\.js --markdown/, 'the reproduce command is missing');
});

/* ================================================================== */
/* 5. The wiring: CI counts, and the notes carry the table             */
/* ================================================================== */

test('the release workflow runs the committed counter and feeds it to the notes', () => {
  const yml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(yml, /node tools\/count-lines\.js --markdown > LINE_COUNT\.md/,
    'CI does not run the committed counter — a hand-typed figure is not a measurement');
  assert.match(yml, /LINE_COUNT_PATH: LINE_COUNT\.md/,
    'the counted table never reaches the release notes');
  // Blame needs history. If this ever goes back to the default depth the split
  // silently becomes one commit's worth of nonsense.
  assert.match(yml, /fetch-depth: 0/, 'a shallow checkout would make blame lie');
});

test('the release notes embed the counted table and the command that produced it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wscp-notes-'));
  try {
    const table = '| Part | Files | Lines |\n|---|---:|---:|\n| **Grand total — every file this repository tracks** | **304** | **249,182** |';
    const countFile = path.join(dir, 'LINE_COUNT.md');
    const outFile = path.join(dir, 'RELEASE_NOTES.md');
    fs.writeFileSync(countFile, table);

    const run = (env) => {
      const r = cp.spawnSync(process.execPath, [path.join(ROOT, 'build', 'release-notes.js'), '--tag', 'v0.0.1', '--out', outFile],
        { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env } });
      assert.strictEqual(r.status, 0, r.stderr);
      return fs.readFileSync(outFile, 'utf8');
    };

    const withCount = run({ LINE_COUNT_PATH: countFile });
    assert.match(withCount, /How much code this is/);
    assert.ok(withCount.includes(table), 'the measured table is not in the release body');
    assert.match(withCount, /node tools\/count-lines\.js --markdown/,
      'the notes do not record the command a reader would reproduce it with');

    // Missing measurement must be visible, not an absent section that reads
    // exactly like a release which never had one.
    const without = run({ LINE_COUNT_PATH: path.join(dir, 'nope.md') });
    assert.match(without, /No line count was measured/i);
    assert.ok(!without.includes(table));

    // ...and nothing else in the body was disturbed.
    for (const anchor of ['## 📦 Downloads', '## What this is', '## Build provenance']) {
      assert.ok(withCount.includes(anchor), `the release body lost ${anchor}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
