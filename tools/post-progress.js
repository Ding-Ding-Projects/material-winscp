// post-progress.js — publish the coverage percentage to the rolling Discussion.
//
// Progress is reported where people can see it, not only in a file in the repo.
// This reads the ledger that tools/port-matrix.js produces and posts a comment
// on the rolling progress thread. It reports whatever the ledger says — there is
// deliberately no way to pass a percentage in by hand.
//
// Run: node tools/post-progress.js "what landed this round"
//      node tools/post-progress.js --dry "..."   (print, do not post)
'use strict';
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const REPO = 'Ding-Ding-Projects/material-winscp';
const DISCUSSION = 1;
const COVERAGE = path.join(ROOT, 'docs', 'port-coverage.md');

function sh(args, opts = {}) {
  return cp.execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...opts });
}

/** Regenerate the ledger first, so a stale file cannot be reported as current. */
function refreshLedger() {
  cp.execFileSync(process.execPath, [path.join(__dirname, 'port-matrix.js')],
    { cwd: ROOT, encoding: 'utf8' });
}

function readLedger() {
  const text = fs.readFileSync(COVERAGE, 'utf8');
  const overall = /\*\*Overall: ([\d.]+)% of ([\d,]+) lines across (\d+) units\.\*\*/.exec(text);
  const areas = [];
  const areaTable = /## By area\n\n\| Area .*?\n\|[-|: ]+\|\n([\s\S]*?)\n\n/.exec(text);
  if (areaTable) {
    for (const line of areaTable[1].split('\n')) {
      const m = /^\| `([^`]+)` \| (\d+) \| (\d+) \| ([\d,]+) \| ([\d.]+)% \|$/.exec(line.trim());
      if (m) areas.push({ area: m[1], units: +m[2], done: +m[3], lines: m[4], pct: +m[5] });
    }
  }
  const statuses = {};
  for (const m of text.matchAll(/^\| (✅|🚧|🔁|➖|⬜) /gm)) {
    statuses[m[1]] = (statuses[m[1]] || 0) + 1;
  }
  return {
    pct: overall ? +overall[1] : 0,
    lines: overall ? overall[2] : '?',
    units: overall ? +overall[3] : 0,
    areas,
    statuses,
    broken: /> \[!WARNING\]/.test(text),
  };
}

function bar(pct, width = 28) {
  const filled = Math.round((pct / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled));
}

function testSummary() {
  try {
    const out = cp.execSync('npm test --silent', { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 600000 });
    const pass = /# pass (\d+)/.exec(out);
    const fail = /# fail (\d+)/.exec(out);
    return { pass: pass ? +pass[1] : 0, fail: fail ? +fail[1] : 0, ran: true };
  } catch (e) {
    const out = (e.stdout || '') + (e.stderr || '');
    const pass = /# pass (\d+)/.exec(out);
    const fail = /# fail (\d+)/.exec(out);
    return { pass: pass ? +pass[1] : 0, fail: fail ? +fail[1] : 0, ran: !!pass, error: !pass };
  }
}

function gitInfo() {
  const g = (args) => cp.execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
  try {
    return { sha: g(['rev-parse', '--short', 'HEAD']), full: g(['rev-parse', 'HEAD']), subject: g(['log', '-1', '--format=%s']) };
  } catch { return null; }
}

function build(note) {
  const L = readLedger();
  const t = testSummary();
  const git = gitInfo();
  const stamp = new Date().toISOString();

  const md = [];
  md.push(`## 📊 Port coverage — **${L.pct.toFixed(1)}%**`);
  md.push('');
  md.push('```');
  md.push(`${bar(L.pct)}  ${L.pct.toFixed(1)}%`);
  md.push('```');
  md.push('');
  md.push(`Weighted by source lines across **${L.lines} lines** of WinSCP's own code in **${L.units} units**. The ledger counts an unmapped unit as not started and a mapping naming a missing file as **zero**, so this number cannot be talked upwards.`);
  md.push('');
  md.push(`用原始碼行數加權計，總共 **${L.lines} 行**、**${L.units}** 個單元。冇對應嘅當冇做，對應唔到檔案嘅當零分——呢個數字吹唔脹。`);
  md.push('');

  if (L.broken) {
    md.push('> [!WARNING]');
    md.push('> The ledger currently contains a **broken mapping** (a unit pointing at a file that does not exist). It is counted as zero. See `docs/port-coverage.md`.');
    md.push('');
  }

  if (note) {
    md.push('### 🔨 This round · 今輪做咗乜');
    md.push('');
    md.push(note);
    md.push('');
  }

  if (L.areas.length) {
    md.push('### 📁 By area · 分區進度');
    md.push('');
    md.push('| Area | Units ported | Lines | Coverage |');
    md.push('|---|---:|---:|---:|');
    for (const a of L.areas) {
      md.push(`| \`${a.area}\` | ${a.done} / ${a.units} | ${a.lines} | ${a.pct.toFixed(1)}% |`);
    }
    md.push('');
  }

  const s = L.statuses;
  if (Object.keys(s).length) {
    md.push('### 🚦 Unit status · 單元狀態');
    md.push('');
    md.push(`✅ Ported **${s['✅'] || 0}** · 🚧 In progress **${s['🚧'] || 0}** · 🔁 Replaced **${s['🔁'] || 0}** · ⬜ Not started **${s['⬜'] || 0}**`);
    md.push('');
  }

  md.push('### 🧪 Tests · 測試');
  md.push('');
  if (!t.ran) {
    md.push('The test run did not produce a summary — treat this as **unverified**, not as passing.');
    md.push('測試冇出到報告，當佢**未驗證**，唔好當佢過咗。');
  } else {
    const verdict = t.fail === 0 ? '✅ passing' : '❌ **failing**';
    md.push(`${verdict} — ${t.pass} passed, ${t.fail} failed.`);
    md.push(`${t.fail === 0 ? '全部過晒' : '有嘢肥佬咗'}：${t.pass} 過、${t.fail} 唔過。`);
  }
  md.push('');

  if (git) {
    md.push('### 📌 Evidence · 憑證');
    md.push('');
    md.push(`- Commit \`${git.sha}\` — ${git.subject}`);
    md.push(`- Ledger: [\`docs/port-coverage.md\`](https://github.com/${REPO}/blob/main/docs/port-coverage.md)`);
    md.push(`- Mandate: [\`docs/porting-mandate.md\`](https://github.com/${REPO}/blob/main/docs/porting-mandate.md)`);
    md.push('');
  }

  md.push('---');
  md.push(`<sub>Posted ${stamp} · generated by \`tools/post-progress.js\` from the ledger, never typed by hand.</sub>`);

  return md.join('\n');
}

function post(body) {
  const q = `
{ repository(owner:"${REPO.split('/')[0]}", name:"${REPO.split('/')[1]}") {
    discussion(number:${DISCUSSION}) { id } } }`;
  const id = JSON.parse(sh(['api', 'graphql', '-f', 'query=' + q])).data.repository.discussion.id;
  const tmp = path.join(os.tmpdir(), 'progress-' + Date.now() + '.md');
  fs.writeFileSync(tmp, body, 'utf8');
  try {
    const out = sh(['api', 'graphql', '-F', 'body=@' + tmp, '-f', 'query=' + `
mutation($body:String!) {
  addDiscussionComment(input:{discussionId:"${id}", body:$body}) { comment { url } } }`]);
    return JSON.parse(out).data.addDiscussionComment.comment.url;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function main() {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry');
  const note = args.filter((a) => a !== '--dry').join(' ');
  refreshLedger();
  const body = build(note);
  if (dry) { console.log(body); return; }
  console.log('Posted: ' + post(body));
}

if (require.main === module) main();
module.exports = { build, readLedger };
