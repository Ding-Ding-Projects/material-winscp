// handoff.js — regenerate HANDOFF.md and ROADMAP.md from the project's real state.
//
// A handoff written by hand goes stale the moment the next commit lands, and a
// stale handoff is worse than none: it is confidently wrong about where the
// work stopped, which is exactly the thing its reader cannot check. So the
// numbers here are read from the same sources that produce them elsewhere —
// the coverage ledger, the test run, the git log, the open issues — and nothing
// in the generated sections is typed by a person.
//
// What a person DOES write lives between the two marker comments in each file
// and is preserved across regeneration, because judgement ("this subsystem is
// riskier than its percentage suggests") does not come out of a tool.
//
// Run: node tools/handoff.js            (rewrite both files)
//      node tools/handoff.js --check    (exit non-zero if stale)
//      node tools/handoff.js --no-tests (skip the test run; faster)
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..');
const HANDOFF = path.join(ROOT, 'HANDOFF.md');
const ROADMAP = path.join(ROOT, 'ROADMAP.md');

const KEEP_BEGIN = '<!-- hand-written: preserved across regeneration -->';
const KEEP_END = '<!-- /hand-written -->';

function sh(cmd, args, opts = {}) {
  try {
    return cp.execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  } catch (e) {
    return (e.stdout || '') + (e.stderr || '');
  }
}

/** Everything the ledger knows, without re-deriving any of it here. */
function coverage() {
  const out = sh(process.execPath, [path.join(__dirname, 'port-matrix.js')]);
  const logic = /LOGIC coverage:\s+([\d.]+)%\s+\(of ([\d,]+)/.exec(out);
  const raw = /raw coverage:\s+([\d.]+)%/.exec(out);
  const areas = [];
  for (const m of out.matchAll(/^\s{4}(\w+)\s+(\d+)\/(\d+) units\s+([\d.]+)%$/gm)) {
    areas.push({ area: m[1], done: +m[2], units: +m[3], pct: +m[4] });
  }
  return {
    logic: logic ? +logic[1] : 0,
    logicLines: logic ? logic[2] : '?',
    raw: raw ? +raw[1] : 0,
    areas,
  };
}

function tests(skip) {
  if (skip) return null;
  // Invoke the test runner directly rather than through npm. `npm` is a shell
  // shim on Windows, which either needs shell:true (a command-injection foot-gun
  // the runtime now warns about) or silently produces nothing — and a handoff
  // that reports "tests: null" is worse than one that says it did not run them.
  //
  // --test-timeout for the same reason package.json's script carries it: node
  // --test has no default, so one test that never settles hangs the handoff
  // generator forever. The escape hatch then looks like --skip-tests, and the
  // handoff quietly ships "Tests | not run in this regeneration" — which is how
  // this file came to describe a suite nobody had seen the result of.
  const out = sh(process.execPath, ['--test', '--test-timeout=120000', 'test/**/*.test.js']);
  const g = (re) => { const m = re.exec(out); return m ? +m[1] : null; };
  const total = g(/^.\s*tests (\d+)/m);
  if (total === null) return { unavailable: true, raw: out.slice(-400) };
  return { total, pass: g(/^.\s*pass (\d+)/m), fail: g(/^.\s*fail (\d+)/m), skipped: g(/^.\s*skipped (\d+)/m) };
}

function lines() {
  const out = sh(process.execPath, [path.join(__dirname, 'count-lines.js')]);
  const hand = /HAND-WRITTEN TOTAL\s+([\d,]+) files\s+([\d,]+) lines/.exec(out);
  const total = /TOTAL incl\. generated\s+([\d,]+) lines/.exec(out);
  return { files: hand ? hand[1] : '?', hand: hand ? hand[2] : '?', total: total ? total[1] : '?' };
}

function git() {
  return {
    head: sh('git', ['rev-parse', '--short', 'HEAD']).trim(),
    headFull: sh('git', ['rev-parse', 'HEAD']).trim(),
    subject: sh('git', ['log', '-1', '--format=%s']).trim(),
    branch: sh('git', ['rev-parse', '--abbrev-ref', 'HEAD']).trim(),
    remote: sh('git', ['rev-parse', '--short', 'origin/main']).trim(),
    count: sh('git', ['rev-list', '--count', 'HEAD']).trim(),
    dirty: sh('git', ['status', '--porcelain']).trim().split('\n').filter(Boolean).length,
    recent: sh('git', ['log', '-8', '--format=%h\t%ad\t%s', '--date=short']).trim().split('\n').filter(Boolean),
  };
}

function issues() {
  const out = sh('gh', ['issue', 'list', '--repo', 'Ding-Ding-Projects/material-winscp',
    '--state', 'open', '--limit', '60', '--json', 'number,title,labels']);
  try {
    return JSON.parse(out).map((i) => ({
      number: i.number, title: i.title,
      labels: (i.labels || []).map((l) => l.name),
    }));
  } catch { return null; }
}

function installer() {
  const dir = path.join(ROOT, 'out', 'make', 'squirrel.windows', 'x64');
  if (!fs.existsSync(dir)) return null;
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    const st = fs.statSync(path.join(dir, f));
    out.push({ name: f, mb: (st.size / 1048576).toFixed(2), mtime: st.mtime.toISOString().slice(0, 10) });
  }
  return out;
}

/** The outstanding units, largest first — what a successor should pick up. */
function outstanding() {
  const text = fs.readFileSync(path.join(ROOT, 'docs', 'port-coverage.md'), 'utf8');
  const rows = [];
  for (const line of text.split('\n')) {
    const m = /^\| (⬜|🚧) [\w ]+ \| `([^`]+)` \| (\w+) \| ([\d,]+) \|/.exec(line);
    if (m) rows.push({ state: m[1] === '⬜' ? 'not started' : 'in progress', stem: m[2], area: m[3], lines: +m[4].replace(/,/g, '') });
  }
  rows.sort((a, b) => b.lines - a.lines);
  return rows;
}

function preserved(file) {
  if (!fs.existsSync(file)) return '';
  const s = fs.readFileSync(file, 'utf8');
  const a = s.indexOf(KEEP_BEGIN);
  const b = s.indexOf(KEEP_END);
  if (a < 0 || b < 0 || b < a) return '';
  return s.slice(a + KEEP_BEGIN.length, b).trim();
}

function buildHandoff(d) {
  const L = [];
  const t = d.tests;
  L.push('# Handoff');
  L.push('');
  L.push('> Generated by `node tools/handoff.js`. The numbers come from the coverage');
  L.push('> ledger, a real test run and the git log — none of them are typed by hand, so');
  L.push('> this file cannot flatter the state of the work. Re-run it at the end of any');
  L.push('> task that changes the repository.');
  L.push('');
  L.push(`**At commit \`${d.git.head}\`** — ${d.git.subject}`);
  L.push('');
  L.push('## Where the work stands');
  L.push('');
  L.push('| | |');
  L.push('|---|---|');
  L.push(`| **Port coverage (logic)** | **${d.cov.logic.toFixed(1)}%** of ${d.cov.logicLines} lines that are actually code |`);
  L.push(`| Port coverage (raw) | ${d.cov.raw.toFixed(1)}% — includes embedded hex resources, **do not quote this one** |`);
  if (t && !t.unavailable) L.push(`| Tests | ${t.total} run, **${t.pass} pass, ${t.fail} fail**${t.skipped ? `, ${t.skipped} skipped` : ''} |`);
  else if (t) L.push('| Tests | **could not be read** — treat as unverified, not as passing |');
  else L.push('| Tests | not run in this regeneration |');
  L.push(`| Hand-written code | ${d.lines.hand} lines across ${d.lines.files} files |`);
  L.push(`| Commits | ${d.git.count} on \`${d.git.branch}\` |`);
  L.push(`| Working tree | ${d.git.dirty === 0 ? 'clean' : `**${d.git.dirty} uncommitted change(s)**`} |`);
  L.push(`| Remote | \`origin/main\` at \`${d.git.remote}\`${d.git.remote === d.git.head ? ' — in sync' : ' — **differs from HEAD**'} |`);
  L.push('');

  L.push('### Coverage by area');
  L.push('');
  L.push('| Area | Units ported | Coverage |');
  L.push('|---|---:|---:|');
  for (const a of d.cov.areas) L.push(`| \`${a.area}\` | ${a.done} / ${a.units} | ${a.pct.toFixed(1)}% |`);
  L.push('');

  L.push('## Verification evidence');
  L.push('');
  if (d.installer) {
    L.push('**Installer** — built and verified on disk:');
    L.push('');
    L.push('| Artifact | Size (MB) | Built |');
    L.push('|---|---:|---|');
    for (const f of d.installer) L.push(`| \`${f.name}\` | ${f.mb} | ${f.mtime} |`);
    L.push('');
  } else {
    L.push('**Installer** — not present in `out/make`. Build it with `npm run make`.');
    L.push('If it stalls at "Finalizing package", run `node tools/fix-node26-deps.js` first.');
    L.push('');
  }
  L.push('Reproduce every number in this file:');
  L.push('');
  L.push('```bash');
  L.push('npm test && node tools/port-matrix.js && node tools/count-lines.js');
  L.push('```');
  L.push('');

  L.push('## What a successor should pick up next');
  L.push('');
  L.push('The largest outstanding units, by lines of the original still unported.');
  L.push('`in progress` means some behaviour landed and the ledger records how much;');
  L.push('`not started` means nothing is mapped to it at all.');
  L.push('');
  L.push('| Lines | State | Unit |');
  L.push('|---:|---|---|');
  for (const r of d.outstanding.slice(0, 20)) {
    L.push(`| ${r.lines.toLocaleString()} | ${r.state} | \`${r.stem}\` |`);
  }
  L.push('');
  L.push(`${d.outstanding.length} units remain outstanding in total. The full list is in`);
  L.push('[`docs/port-coverage.md`](docs/port-coverage.md).');
  L.push('');

  L.push('## External-state dependencies');
  L.push('');
  L.push('Things that are true of the environment rather than of the code, and that will');
  L.push('bite a successor who assumes otherwise:');
  L.push('');
  L.push('- **Node 26 breaks two packaging dependencies.** `extract-zip` unpacks one entry');
  L.push('  and then exits 0 without settling its promise; `cross-zip` calls a removed API.');
  L.push('  `node tools/fix-node26-deps.js` patches both in `node_modules` (not committed).');
  L.push('  CI runs on a Node where both behave, so this is a local-only workaround.');
  L.push('- **Silent updates need a plain-semver, non-prerelease, `--latest` release** with');
  L.push('  the Squirrel trio attached, and the app version must actually increase. All');
  L.push('  four are enforced in CI and asserted in `test/autoupdate.test.js`.');
  L.push('- **`update.electronjs.org` only serves public repositories.** If this repo ever');
  L.push('  goes private, silent updates stop and the failure is invisible.');
  L.push('- The end-to-end suites stand up **real** SFTP, FTP, WebDAV and S3 servers');
  L.push('  in-process on ephemeral ports. They need no network, but they do bind sockets.');
  L.push('');

  if (d.issues) {
    L.push('## Open issues');
    L.push('');
    L.push(`${d.issues.length} open on the tracker.`);
    L.push('');
    for (const i of d.issues.slice(0, 30)) {
      L.push(`- [#${i.number}](https://github.com/Ding-Ding-Projects/material-winscp/issues/${i.number}) ${i.title}`);
    }
    L.push('');
  }

  L.push('## Recent history');
  L.push('');
  L.push('| Commit | Date | Subject |');
  L.push('|---|---|---|');
  for (const line of d.git.recent) {
    const [h, date, ...rest] = line.split('\t');
    L.push(`| \`${h}\` | ${date} | ${rest.join('\t').replace(/\|/g, '\\|')} |`);
  }
  L.push('');

  L.push('## Notes from whoever worked on this last');
  L.push('');
  L.push(KEEP_BEGIN);
  L.push('');
  L.push(d.keepHandoff || '_Nothing recorded yet._');
  L.push('');
  L.push(KEEP_END);
  L.push('');
  return L.join('\n');
}

function buildRoadmap(d) {
  const L = [];
  L.push('# Roadmap');
  L.push('');
  L.push('> Partly generated by `node tools/handoff.js`. The roadmap also lives as GitHub');
  L.push('> issues, which are the authoritative tracker — this file is the readable');
  L.push('> summary of the same thing.');
  L.push('');
  L.push('The goal is stated in [`docs/porting-mandate.md`](docs/porting-mandate.md) and is');
  L.push('not negotiable: **port 100% of WinSCP, however many lines it takes.** Scale is');
  L.push('not a reason to narrow scope.');
  L.push('');
  L.push(`**Currently ${d.cov.logic.toFixed(1)}% of ${d.cov.logicLines} logic lines.**`);
  L.push('');
  L.push('## Done');
  L.push('');
  L.push('- Electron application with a Material Design 3 interface, booting and usable');
  L.push('- Squirrel installer: built, installed and launched from the installed location');
  L.push('- Silent background updates, Chrome-style, with no prompt at any point');
  L.push('- Six protocol backends: SFTP, SCP, FTP/FTPS, WebDAV, S3 and the local filesystem');
  L.push('- Transfer queue, synchronizer, file masks, recursive search, session management');
  L.push('- All 301 WinSCP actions registered and reachable; 48 dialogs built');
  L.push('- End-to-end suites against real in-process SFTP, FTP, WebDAV and S3 servers');
  L.push('- Three language modes and two per-language funny sliders, wired to real copy');
  L.push('- Git-backed append-only version history for settings and sites');
  L.push('');
  L.push('## In progress');
  L.push('');
  const wip = d.outstanding.filter((r) => r.state === 'in progress').slice(0, 12);
  for (const r of wip) L.push(`- \`${r.stem}\` — ${r.lines.toLocaleString()} lines`);
  L.push('');
  L.push('## Not started');
  L.push('');
  const todo = d.outstanding.filter((r) => r.state === 'not started').slice(0, 12);
  for (const r of todo) L.push(`- \`${r.stem}\` — ${r.lines.toLocaleString()} lines`);
  L.push('');
  if (d.issues) {
    L.push('## Tracked as issues');
    L.push('');
    for (const i of d.issues.slice(0, 40)) {
      L.push(`- [#${i.number}](https://github.com/Ding-Ding-Projects/material-winscp/issues/${i.number}) ${i.title}`);
    }
    L.push('');
  }
  L.push('## Direction and judgement calls');
  L.push('');
  L.push(KEEP_BEGIN);
  L.push('');
  L.push(d.keepRoadmap || '_Nothing recorded yet._');
  L.push('');
  L.push(KEEP_END);
  L.push('');
  return L.join('\n');
}

function main() {
  const check = process.argv.includes('--check');
  const noTests = process.argv.includes('--no-tests');

  const d = {
    cov: coverage(),
    tests: tests(noTests || check),
    lines: lines(),
    git: git(),
    issues: issues(),
    installer: installer(),
    outstanding: outstanding(),
    keepHandoff: preserved(HANDOFF),
    keepRoadmap: preserved(ROADMAP),
  };

  const handoff = buildHandoff(d);
  const roadmap = buildRoadmap(d);

  if (check) {
    const stale = [];
    // Compare ignoring the test row, which --check does not compute.
    const strip = (s) => s.replace(/^\| Tests \|.*$/m, '');
    if (!fs.existsSync(HANDOFF) || strip(fs.readFileSync(HANDOFF, 'utf8')) !== strip(handoff)) stale.push('HANDOFF.md');
    if (!fs.existsSync(ROADMAP) || fs.readFileSync(ROADMAP, 'utf8') !== roadmap) stale.push('ROADMAP.md');
    if (stale.length) {
      console.error('Stale: ' + stale.join(', ') + '\nRun: node tools/handoff.js');
      process.exit(1);
    }
    console.log('HANDOFF.md and ROADMAP.md are current.');
    return;
  }

  fs.writeFileSync(HANDOFF, handoff, 'utf8');
  fs.writeFileSync(ROADMAP, roadmap, 'utf8');
  console.log('Wrote HANDOFF.md and ROADMAP.md');
  console.log(`  coverage:    ${d.cov.logic.toFixed(1)}% logic`);
  if (d.tests && !d.tests.unavailable) console.log(`  tests:       ${d.tests.pass}/${d.tests.total} pass, ${d.tests.fail} fail`);
  else if (d.tests) console.log('  tests:       COULD NOT BE READ — reported as unverified');
  console.log(`  outstanding: ${d.outstanding.length} units`);
  console.log(`  issues:      ${d.issues ? d.issues.length + ' open' : 'could not read'}`);
  console.log(`  installer:   ${d.installer ? d.installer.length + ' artifacts' : 'not built'}`);
  if (d.keepHandoff) console.log('  preserved the hand-written notes section');
}

if (require.main === module) main();
module.exports = { coverage, outstanding, buildHandoff, buildRoadmap };
