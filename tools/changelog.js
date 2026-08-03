// changelog.js — keep the in-app changelog current, from the real git history.
//
// The shared instructions require the changelog to be brought current in every
// project-changing task, and every entry to link the commit that made the
// change. A hand-maintained list satisfies neither for long: this one had
// already drifted seven commits behind within a day.
//
// So the DEVELOPMENT block in design/renderer/ui/changelog.js is generated from
// `git log`. Rules that make it trustworthy rather than merely present:
//
//   * Every entry carries the FULL object name, not just the abbreviation. An
//     abbreviated sha is ambiguous in a repository that grows.
//   * Every sha is verified to exist with `git cat-file` before it is written.
//     A wrong sha is worse than none, because it sends a reader somewhere
//     confidently irrelevant.
//   * Bullets are taken from the commit message body. Nothing is invented, and
//     a commit whose message says nothing produces an entry that says so
//     rather than a fabricated summary.
//   * Bilingual commit bodies are split: the English half becomes the bullets,
//     and the Cantonese half is preserved separately so the viewer's language
//     modes have real copy rather than a machine translation.
//
// Run: node tools/changelog.js            (rewrite the DEVELOPMENT block)
//      node tools/changelog.js --check    (exit non-zero if it is stale)
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..');
const TARGET = path.join(ROOT, 'design', 'renderer', 'ui', 'changelog.js');
const BEGIN = 'export const DEVELOPMENT = [';
const END = '];';

// Generated report commits are repository bookkeeping, not product changes.
// Including them makes the generated block stale immediately after the
// required handoff/changelog refresh commits land.
const GENERATED_ONLY_FILES = new Set([
  'HANDOFF.md',
  'ROADMAP.md',
  'docs/tooling.md',
  'tools/changelog.js',
  'design/renderer/ui/changelog.js',
]);

/** How many commits the in-app viewer carries. Older history stays in git. */
const LIMIT = 60;

const RECORD = '\x1e';
const FIELD = '\x1f';

function git(args) {
  return cp.execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** True when the object really is a commit in this repository. */
function commitExists(oid) {
  try { return git(['cat-file', '-t', oid]).trim() === 'commit'; } catch { return false; }
}

function isGeneratedOnlyCommit(oid) {
  const files = git(['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', oid])
    .split(/\r?\n/).filter(Boolean);
  return files.length > 0 && files.every((file) => GENERATED_ONLY_FILES.has(file));
}

/**
 * WinSCP Material's commit messages are bilingual: an English body, then a
 * Cantonese one. Split on the first line that is predominantly CJK, so each
 * language keeps its own bullets instead of the viewer rendering both at once
 * whatever mode it is in.
 */
function splitBilingual(body) {
  const lines = body.split('\n');
  const cjk = (s) => {
    const letters = (s.match(/[A-Za-z]/g) || []).length;
    const han = (s.match(/[㐀-鿿豈-﫿]/g) || []).length;
    return han > 0 && han >= letters;
  };
  let split = -1;
  for (let i = 0; i < lines.length; i++) {
    if (cjk(lines[i])) { split = i; break; }
  }
  if (split < 0) return { en: lines, yue: [] };
  // Walk back over the blank lines that separate the two halves.
  let e = split;
  while (e > 0 && !lines[e - 1].trim()) e--;
  return { en: lines.slice(0, e), yue: lines.slice(split) };
}

/**
 * Turn a commit body into changelog bullets. A body written as prose becomes
 * paragraph bullets; one written with `*` or `-` markers keeps its structure.
 */
function bullets(lines) {
  const out = [];
  let current = null;

  const flush = () => {
    if (current) {
      const text = current.join(' ').replace(/\s+/g, ' ').trim();
      if (text) out.push(text);
    }
    current = null;
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) { flush(); continue; }
    // Trailer lines are metadata, not user-facing changes.
    if (/^(Co-Authored-By|Signed-off-by|Refs|Closes|Fixes):/i.test(line.trim())) { flush(); continue; }
    const marker = /^\s*[*-]\s+(.*)$/.exec(line);
    if (marker) { flush(); current = [marker[1]]; continue; }
    if (current) current.push(line.trim());
    else current = [line.trim()];
  }
  flush();
  return out;
}

/**
 * Classify a bullet the way the viewer groups them. Deliberately conservative:
 * anything that does not clearly announce itself is "changed", because
 * mislabelling a fix as a feature is a small lie that compounds.
 */
function categorize(text) {
  const t = text.toLowerCase();
  if (/\b(fix|fixed|fixes|broke|broken|defect|bug|regression|crash|refuse[sd]?\b.*wrong)\b/.test(t)) return 'fixed';
  if (/\b(add|adds|added|new|ship|ships|shipped|introduce[sd]?|now (also )?(supports|carries|produces))\b/.test(t)) return 'added';
  if (/\b(remove|removed|delete|deleted|drop|dropped|no longer)\b/.test(t)) return 'removed';
  if (/\b(secur|password|secret|credential|encrypt|redact)\w*/.test(t)) return 'security';
  return 'changed';
}

function collect() {
  const fmt = ['%H', '%h', '%aI', '%s', '%b'].join(FIELD) + RECORD;
  // Scan the full history before applying LIMIT: generated report commits are
  // filtered below, so limiting the git walk first would silently shorten the
  // in-app history whenever bookkeeping commits occupy the recent window.
  const raw = git(['log', `--format=${fmt}`]);
  const out = [];

  for (const rec of raw.split(RECORD)) {
    const r = rec.replace(/^\n+/, '');
    if (!r.trim()) continue;
    const [oid, ref, iso, subject, body = ''] = r.split(FIELD);
    if (!oid || !commitExists(oid)) {
      console.error(`  ! skipping an entry whose object could not be verified: ${oid || '(none)'}`);
      continue;
    }
    if (isGeneratedOnlyCommit(oid)) continue;
    const { en, yue } = splitBilingual(body);
    const enBullets = bullets(en);
    const yueBullets = bullets(yue);
    const refs = [...new Set((subject + '\n' + body).match(/#\d+/g) || [])];

    out.push({
      id: ref, kind: 'commit', ref, oid,
      date: iso.slice(0, 10),
      title: subject.trim(),
      refs,
      // A commit with no body gets an EMPTY changes list, not a manufactured
      // bullet saying it is empty. The viewer already renders "No recorded
      // changes" for that case, and two components both explaining the same
      // absence is how the two eventually disagree.
      changes: enBullets.map((text) => ({ category: categorize(text), text })),
      changesYue: yueBullets.map((text) => ({ category: 'changed', text })),
    });
  }
  return out.slice(0, LIMIT);
}

function render(entries) {
  const esc = (s) => JSON.stringify(String(s));
  const lines = [BEGIN];
  for (const e of entries) {
    lines.push('  {');
    lines.push(`    id: ${esc(e.id)}, kind: 'commit', ref: ${esc(e.ref)}, oid: ${esc(e.oid)}, date: ${esc(e.date)},`);
    lines.push(`    title: ${esc(e.title)},`);
    if (e.refs.length) lines.push(`    refs: [${e.refs.map(esc).join(', ')}],`);
    lines.push('    changes: [');
    for (const c of e.changes) lines.push(`      { category: ${esc(c.category)}, text: ${esc(c.text)} },`);
    lines.push('    ],');
    if (e.changesYue.length) {
      lines.push('    changesYue: [');
      for (const c of e.changesYue) lines.push(`      { category: ${esc(c.category)}, text: ${esc(c.text)} },`);
      lines.push('    ],');
    }
    lines.push('  },');
  }
  lines.push(END);
  return lines.join('\n');
}

function main() {
  const check = process.argv.includes('--check');
  const source = fs.readFileSync(TARGET, 'utf8');

  const start = source.indexOf(BEGIN);
  if (start < 0) {
    console.error(`Could not find "${BEGIN}" in ${path.relative(ROOT, TARGET)}.`);
    process.exit(2);
  }
  // Find the block's closing bracket at column 0, which is where the generated
  // block ends and ordinary code resumes.
  const after = source.indexOf('\n' + END, start);
  if (after < 0) {
    console.error('Could not find the end of the DEVELOPMENT block.');
    process.exit(2);
  }
  const existing = source.slice(start, after + 1 + END.length);

  const entries = collect();
  const block = render(entries);

  if (existing.trim() === block.trim()) {
    console.log(`Changelog is current: ${entries.length} commits, newest ${entries[0].ref} (${entries[0].date}).`);
    return;
  }
  if (check) {
    console.error(`Changelog is STALE. Newest commit ${entries[0].ref} (${entries[0].date}) is not in it.`);
    console.error('Run: node tools/changelog.js');
    process.exit(1);
  }

  fs.writeFileSync(TARGET, source.slice(0, start) + block + source.slice(after + 1 + END.length), 'utf8');
  console.log(`Wrote ${entries.length} entries to ${path.relative(ROOT, TARGET)}.`);
  console.log(`  newest: ${entries[0].ref}  ${entries[0].date}  ${entries[0].title.slice(0, 60)}`);
  console.log(`  every object name verified with git cat-file`);
  const withYue = entries.filter((e) => e.changesYue.length).length;
  console.log(`  ${withYue} of ${entries.length} entries carry Cantonese copy from the commit itself`);
}

if (require.main === module) main();
module.exports = { collect, render, splitBilingual, bullets, categorize };
