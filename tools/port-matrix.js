// port-matrix.js — the coverage ledger for the port.
//
// "Every feature ported" is only a meaningful claim if it is measurable, so
// this walks WinSCP's own source tree, pairs each unit with the file in this
// repository that carries its behaviour, and reports what is still unclaimed.
// The mapping lives in port-map.json; this tool never invents a pairing, and a
// unit with no mapping is reported as missing rather than quietly skipped.
//
// Run: node tools/port-matrix.js            (write docs/port-coverage.md)
//      node tools/port-matrix.js --check    (exit non-zero if anything regressed)
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WINSCP = path.join(ROOT, 'vendor', 'winscp', 'source');
const MAP_FILE = path.join(__dirname, 'port-map.json');
const OUT = path.join(ROOT, 'docs', 'port-coverage.md');

/** WinSCP's own code. PuTTY and FileZilla are third-party engines it vendors. */
const OWN_AREAS = ['core', 'windows', 'forms', 'components', 'console', 'dragext', 'resource'];
const VENDORED = ['putty', 'filezilla'];

const STATUS = {
  done: { icon: '✅', label: 'Ported' },
  partial: { icon: '🚧', label: 'In progress' },
  replaced: { icon: '🔁', label: 'Replaced by an equivalent' },
  na: { icon: '➖', label: 'Not applicable' },
  todo: { icon: '⬜', label: 'Not started' },
};
const VALID_STATUSES = new Set(Object.keys(STATUS));

function lineCount(file) {
  try {
    const buf = fs.readFileSync(file);
    let n = 0;
    for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++;
    return n + (buf.length && buf[buf.length - 1] !== 10 ? 1 : 0);
  } catch { return 0; }
}

/**
 * Delphi .dfm files embed binary resources — icon sheets, animation frames — as
 * page after page of hex. Animations144.dfm is 18,155 lines of which 15,747 are
 * pure hex behind a 14-line .cpp.
 *
 * That matters because line-weighted coverage is meaningless if a third of the
 * "code" is base64 bitmaps: classifying eight such units as replaced moved the
 * headline figure from 9.1% to 39.5% without a single behaviour being ported.
 * So both numbers are reported — the raw one, and the one that counts only
 * lines a person actually wrote logic into. The second is the honest one.
 */
function resourceLines(file) {
  if (!/\.dfm$/i.test(file)) return 0;
  try {
    const text = fs.readFileSync(file, 'utf8');
    let n = 0;
    for (const line of text.split('\n')) {
      const t = line.trim();
      // A run of hex pairs, optionally space-separated, and long enough that it
      // cannot be an ordinary property value.
      if (t.length >= 20 && /^[0-9A-F]+(\s[0-9A-F]+)*$/.test(t)) n++;
    }
    return n;
  } catch { return 0; }
}

function walk(dir, exts) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let items;
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const it of items) {
      const p = path.join(d, it.name);
      if (it.isDirectory()) stack.push(p);
      else if (exts.some((e) => it.name.toLowerCase().endsWith(e))) out.push(p);
    }
  }
  return out.sort();
}

function loadMap() {
  if (!fs.existsSync(MAP_FILE)) return { units: {} };
  try { return JSON.parse(fs.readFileSync(MAP_FILE, 'utf8')); } catch (e) {
    console.error('port-map.json is not valid JSON: ' + e.message);
    process.exit(2);
  }
}

/** A "unit" is one WinSCP translation unit: the .cpp/.h/.dfm sharing a stem. */
function collectUnits() {
  const units = new Map();
  for (const area of OWN_AREAS) {
    const dir = path.join(WINSCP, area);
    if (!fs.existsSync(dir)) continue;
    for (const file of walk(dir, ['.cpp', '.h', '.dfm', '.rc'])) {
      const rel = path.relative(WINSCP, file).replace(/\\/g, '/');
      const stem = rel.replace(/\.(cpp|h|dfm|rc)$/i, '');
      if (!units.has(stem)) units.set(stem, { stem, area, files: [], lines: 0, resource: 0 });
      const u = units.get(stem);
      u.files.push(rel);
      u.lines += lineCount(file);
      u.resource += resourceLines(file);
    }
  }
  return [...units.values()].sort((a, b) => b.lines - a.lines);
}

function collectVendored() {
  const out = [];
  for (const area of VENDORED) {
    const dir = path.join(WINSCP, area);
    if (!fs.existsSync(dir)) continue;
    let lines = 0;
    const files = walk(dir, ['.c', '.cpp', '.h']);
    for (const f of files) lines += lineCount(f);
    out.push({ area, files: files.length, lines });
  }
  return out;
}

function fileExists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

function main() {
  const check = process.argv.includes('--check');
  const map = loadMap();
  const units = collectUnits();
  const vendored = collectVendored();

  let totalLines = 0, coveredLines = 0;
  let totalLogic = 0, coveredLogic = 0;
  const rows = [];
  const problems = [];

  const mappedStems = new Set(Object.keys(map.units || {}));
  const sourceStems = new Set(units.map((u) => u.stem));
  for (const stem of mappedStems) {
    const mapping = map.units[stem];
    // Directory-level exclusions are intentionally represented in the ledger
    // even though they do not have a one-to-one source translation unit.
    if (!sourceStems.has(stem) && (!mapping || mapping.status !== 'na')) {
      problems.push(`${stem}: mapping has no matching WinSCP source unit`);
    }
  }

  for (const u of units) {
    totalLines += u.lines;
    const logic = Math.max(0, u.lines - u.resource);
    totalLogic += logic;
    const m = map.units[u.stem];
    const status = m ? (m.status || 'todo') : 'todo';
    const rawTargets = m && m.targets;
    const targets = Array.isArray(rawTargets) ? rawTargets : [];
    if (!VALID_STATUSES.has(status)) problems.push(`${u.stem}: unknown status ${JSON.stringify(status)}`);
    const requiresTargets = status === 'done' || status === 'partial' || status === 'replaced';
    if (requiresTargets && (!Array.isArray(rawTargets) || targets.some((t) => typeof t !== 'string' || !t.trim()))) {
      problems.push(`${u.stem}: targets must be an array of non-empty strings`);
    }
    if (m && Object.prototype.hasOwnProperty.call(m, 'progress') &&
        (!Number.isFinite(m.progress) || m.progress < 0 || m.progress > 1)) {
      problems.push(`${u.stem}: progress must be a finite number between 0 and 1`);
    }
    if (m && status !== 'partial' && Object.prototype.hasOwnProperty.call(m, 'progress')) {
      problems.push(`${u.stem}: progress is only valid for partial mappings`);
    }
    // A mapping that names a file which does not exist is a broken claim, not
    // coverage — surface it loudly instead of counting it.
    const missing = targets.filter((t) => !fileExists(t));
    if (missing.length) problems.push(`${u.stem}: mapped to missing file(s) ${missing.join(', ')}`);
    if ((status === 'done' || status === 'replaced') && !missing.length) {
      coveredLines += u.lines; coveredLogic += logic;
    } else if (status === 'partial') {
      const p = (m && m.progress) || 0.5;
      coveredLines += u.lines * p; coveredLogic += logic * p;
    }

    const declaredProgress = m && m.progress;
    const progress = status === 'partial' && Number.isFinite(declaredProgress) &&
      declaredProgress >= 0 && declaredProgress <= 1 ? declaredProgress :
      (status === 'partial' ? 0.5 : 1);
    rows.push({
      stem: u.stem, area: u.area, lines: u.lines, resource: u.resource, status,
      targets, progress,
      note: (m && m.note) || '', missing,
    });
  }

  const pct = totalLines ? (coveredLines / totalLines) * 100 : 0;
  const logicPct = totalLogic ? (coveredLogic / totalLogic) * 100 : 0;
  const resourceLinesTotal = totalLines - totalLogic;
  const byArea = {};
  for (const r of rows) {
    const a = byArea[r.area] || (byArea[r.area] = { lines: 0, covered: 0, units: 0, done: 0 });
    a.lines += r.lines; a.units++;
    if (r.status === 'done' || r.status === 'replaced') { a.covered += r.lines; a.done++; }
    else if (r.status === 'partial') a.covered += r.lines * r.progress;
  }

  const esc = (s) => String(s).replace(/\|/g, '\\|');
  const lines = [];
  lines.push('# Port coverage');
  lines.push('');
  lines.push('Generated by `node tools/port-matrix.js` — do not edit by hand.');
  lines.push('');
  lines.push('This ledger pairs every unit of WinSCP\'s own source with the file in this');
  lines.push('repository that carries its behaviour. A unit with no mapping is reported as');
  lines.push('not started; a mapping pointing at a file that does not exist is reported as a');
  lines.push('problem. The percentage is weighted by source lines, so a large subsystem');
  lines.push('cannot be made to look finished by porting a handful of small files.');
  lines.push('');
  lines.push(`**Logic coverage: ${logicPct.toFixed(1)}%** of ${totalLogic.toLocaleString()} lines that are actually code.`);
  lines.push('');
  lines.push(`Raw line coverage is ${pct.toFixed(1)}% of ${totalLines.toLocaleString()} lines across ${units.length} units, but that figure is`);
  lines.push(`distorted: ${resourceLinesTotal.toLocaleString()} of those lines (${((resourceLinesTotal / totalLines) * 100).toFixed(0)}%) are binary resources embedded as hex in`);
  lines.push('`.dfm` files — icon sheets and animation frames, at four DPI variants each.');
  lines.push('Classifying those eight units as replaced moved the raw number from 9.1% to');
  lines.push('39.5% without a single behaviour being ported, which is precisely why the');
  lines.push('**logic figure is the one to quote**.');
  lines.push('');

  if (problems.length) {
    lines.push('> [!WARNING]');
    lines.push('> The following mappings are broken and are NOT counted as coverage:');
    for (const p of problems) lines.push('> - ' + esc(p));
    lines.push('');
  }

  lines.push('## By area');
  lines.push('');
  lines.push('| Area | Units | Ported | Lines | Coverage |');
  lines.push('|---|---:|---:|---:|---:|');
  for (const [area, a] of Object.entries(byArea).sort((x, y) => y[1].lines - x[1].lines)) {
    lines.push(`| \`${area}\` | ${a.units} | ${a.done} | ${a.lines.toLocaleString()} | ${((a.covered / a.lines) * 100).toFixed(1)}% |`);
  }
  lines.push('');

  lines.push('## Third-party engines vendored by WinSCP');
  lines.push('');
  lines.push('WinSCP embeds these rather than authoring them. This port supplies the same');
  lines.push('capability through a maintained JavaScript equivalent, which is why they are');
  lines.push('counted as replaced rather than transcribed.');
  lines.push('');
  lines.push('| Engine | Files | Lines | Replacement |');
  lines.push('|---|---:|---:|---|');
  const REPL = { putty: '`ssh2` (SSH transport, auth, SFTP)', filezilla: '`basic-ftp` (FTP/FTPS engine)' };
  for (const v of vendored) {
    lines.push(`| \`${v.area}\` | ${v.files} | ${v.lines.toLocaleString()} | ${REPL[v.area] || '—'} |`);
  }
  lines.push('');

  lines.push('## Units');
  lines.push('');
  lines.push('| Status | Unit | Area | Lines | Ported to | Note |');
  lines.push('|---|---|---|---:|---|---|');
  for (const r of rows) {
    const s = STATUS[r.status] || STATUS.todo;
    const targets = r.targets.length
      ? r.targets.map((t) => (r.missing.includes(t) ? `⚠️ \`${t}\`` : `\`${t}\``)).join('<br>')
      : '—';
    lines.push(`| ${s.icon} ${s.label} | \`${esc(r.stem)}\` | ${r.area} | ${r.lines.toLocaleString()} | ${targets} | ${esc(r.note)} |`);
  }
  lines.push('');

  const report = lines.join('\n');
  if (check) {
    let current = '';
    try {
      // Git may check tracked Markdown out with CRLF on Windows while the
      // generator deliberately emits LF. Compare the report's content, not
      // the workstation's line-ending preference.
      current = fs.readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n');
    } catch { current = ''; }
    if (current !== report) problems.push('docs/port-coverage.md is stale; run node tools/port-matrix.js');
  } else {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, report, 'utf8');
  }

  console.log(check ? `Checked ${path.relative(ROOT, OUT)}` : `Wrote ${path.relative(ROOT, OUT)}`);
  console.log(`  units:     ${units.length}`);
  console.log(`  lines:     ${totalLines.toLocaleString()} (WinSCP's own code)`);
  console.log(`  LOGIC coverage:  ${logicPct.toFixed(1)}%  (of ${totalLogic.toLocaleString()} real code lines)`);
  console.log(`  raw coverage:    ${pct.toFixed(1)}%  (includes ${resourceLinesTotal.toLocaleString()} lines of embedded hex resources — distorted, do not quote)`);
  for (const [area, a] of Object.entries(byArea).sort((x, y) => y[1].lines - x[1].lines)) {
    console.log(`    ${area.padEnd(12)} ${a.done}/${a.units} units  ${((a.covered / a.lines) * 100).toFixed(1)}%`);
  }
  if (problems.length) {
    console.log('\nBroken mappings (not counted):');
    for (const p of problems) console.log('  - ' + p);
  }
  if (check && problems.length) process.exit(1);
}

if (require.main === module) main();
module.exports = { collectUnits, collectVendored, lineCount };
