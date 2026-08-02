// fix-node26-deps.js — local workarounds for build dependencies that are
// broken on Node 26.
//
// Two packaging dependencies use APIs Node 26 removed or changed. Neither
// failure is ours, but both stop `npm run make` from producing an installer,
// and one of them fails *silently* while still reporting success — which is the
// worst possible failure mode for a release pipeline.
//
//   1. extract-zip 2.0.1 — unpacks exactly one entry, then the promise never
//      settles and the process exits 0. This is why node_modules/electron/dist
//      had to be unpacked by hand before the app would run, and why
//      `electron-forge make` stalled at "Finalizing package" leaving no out/
//      directory while still exiting 0.
//
//   2. cross-zip 4.x — calls fs.rmdir(path, { recursive: true }), which Node 26
//      rejects outright: "The property 'options.recursive' is no longer
//      supported." fs.rm is the replacement. This one at least crashes loudly.
//
// This patches node_modules, which is NOT committed. CI runs on a Node version
// where both packages behave, so nothing here reaches the published build. Run
// it after `npm install` if a build stalls or throws in a maker.
//
// Run: node tools/fix-node26-deps.js [--check]
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..');
const MARKER = 'winscp-material-node26-workaround';

// --------------------------------------------------------------- extract-zip
const EXTRACT_ZIP_REPLACEMENT = `// PATCHED by tools/fix-node26-deps.js — ${MARKER}
// Upstream extract-zip 2.0.1 never settles on Node 26 (see that file). Same API:
//   extract(zipPath, { dir, onEntry?, defaultDirMode?, defaultFileMode? })
'use strict';
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

function expandArchiveWindows(zipPath, dir) {
  const script = [
    '$ErrorActionPreference = "Stop"',
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    '$zip = ' + JSON.stringify(zipPath),
    '$dest = ' + JSON.stringify(dir),
    // Windows PowerShell's ExtractToDirectory has no overwrite overload — its
    // three-argument form takes an encoding, so clear the destination instead.
    'if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }',
    'New-Item -ItemType Directory -Force -Path $dest | Out-Null',
    '[System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $dest)',
  ].join('; ');

  const res = cp.spawnSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });

  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error('Expand failed for ' + zipPath + ': ' + (res.stderr || res.stdout || 'exit ' + res.status));
  }
}

async function extract(zipPath, opts) {
  const dir = path.resolve(opts && opts.dir ? opts.dir : process.cwd());
  if (process.platform !== 'win32') {
    return require('./index.original.js')(zipPath, opts);
  }
  fs.mkdirSync(dir, { recursive: true });
  expandArchiveWindows(zipPath, dir);

  // Callers use onEntry for progress; replay it from what actually landed
  // rather than pretending the archive was empty.
  if (opts && typeof opts.onEntry === 'function') {
    const walk = (d, base) => {
      for (const it of fs.readdirSync(d, { withFileTypes: true })) {
        const rel = base ? base + '/' + it.name : it.name;
        if (it.isDirectory()) { opts.onEntry({ fileName: rel + '/' }, null); walk(path.join(d, it.name), rel); }
        else opts.onEntry({ fileName: rel }, null);
      }
    };
    try { walk(dir, ''); } catch { /* progress must never fail a build */ }
  }
}

module.exports = extract;
module.exports.default = extract;
`;

/** cross-zip needs one call swapped, so patch in place rather than replacing. */
function patchCrossZip(source) {
  return source.replace(
    /fs\.rmdir\(\s*outPath\s*,\s*\{\s*recursive:\s*true\s*,\s*maxRetries:\s*3\s*\}\s*,\s*doZip2\s*\)/,
    'fs.rm(outPath, { recursive: true, force: true, maxRetries: 3 }, doZip2)  // ' + MARKER
  );
}

const PATCHES = [
  {
    pkg: 'extract-zip',
    file: 'index.js',
    apply: () => EXTRACT_ZIP_REPLACEMENT,
    why: 'promise never settles on Node 26; unpacks one entry then exits 0',
  },
  {
    pkg: 'cross-zip',
    file: 'index.js',
    apply: patchCrossZip,
    why: 'fs.rmdir({recursive:true}) was removed in Node 26',
  },
];

/** A package can be hoisted or nested; patch every copy that exists. */
function findPackage(name) {
  const found = [];
  const seen = new Set();
  const stack = [path.join(ROOT, 'node_modules')];
  while (stack.length) {
    const dir = stack.pop();
    let items;
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const it of items) {
      if (!it.isDirectory()) continue;
      const p = path.join(dir, it.name);
      if (it.name === name) {
        if (!seen.has(p)) { seen.add(p); found.push(p); }
        continue;
      }
      // Only descend into nested node_modules and scoped folders — walking
      // every package's source takes minutes and finds nothing.
      if (it.name === 'node_modules' || it.name.startsWith('@')) stack.push(p);
    }
  }
  return found;
}

function verifyExtractZip(pkgDir) {
  const cache = path.join(process.env.LOCALAPPDATA || '', 'electron', 'Cache');
  let zip = null;
  try {
    for (const d of fs.readdirSync(cache)) {
      for (const f of fs.readdirSync(path.join(cache, d))) {
        if (f.endsWith('.zip') && f.includes('win32-x64')) zip = path.join(cache, d, f);
      }
    }
  } catch { return; }
  if (!zip) return;

  const probe = path.join(os.tmpdir(), 'extract-zip-probe-' + process.pid);
  const extract = require(path.join(pkgDir, 'index.js'));
  const t = Date.now();
  extract(zip, { dir: probe })
    .then(() => {
      const n = fs.readdirSync(probe).length;
      console.log(`  verified: ${n} entries from ${path.basename(zip)} in ${Date.now() - t} ms`);
      fs.rmSync(probe, { recursive: true, force: true });
    })
    .catch((e) => console.error('  verification FAILED: ' + e.message));
}

/**
 * Repair node_modules/electron/dist.
 *
 * The patch above arrives too late to help the install that created the mess.
 * npm runs electron's postinstall DURING `npm install`, when extract-zip is
 * still the broken upstream copy — so the binary is unpacked with the very bug
 * this file exists to fix, and `npm install && node tools/fix-node26-deps.js`
 * leaves a dist/ holding exactly one entry (LICENSES.chromium.html, whichever
 * happens to be first in the zip) and no path.txt.
 *
 * Nothing complains. `require('electron')` throws "Electron failed to install
 * correctly", which every e2e suite reports as its own failure rather than as a
 * broken dependency, and the suite then HANGS instead of exiting — so the
 * symptom a human meets is a test run that never finishes, three layers away
 * from the cause.
 *
 * Re-running electron's own install.js now that extract-zip works is the whole
 * repair. It re-reads the same cached zip, so there is no download.
 */
function repairElectronDist(check) {
  const dirs = findPackage('electron');
  if (!dirs.length) { console.log('  - not installed    electron'); return 0; }

  let fixed = 0;
  for (const dir of dirs) {
    const installer = path.join(dir, 'install.js');
    const pointer = path.join(dir, 'path.txt');
    if (!fs.existsSync(installer)) continue;

    // Believe path.txt only as far as the file it names. A pointer to a binary
    // that is not there is exactly what a half-finished unpack leaves behind.
    let ok = false;
    try {
      const bin = fs.readFileSync(pointer, 'utf8').trim();
      ok = !!bin && fs.existsSync(path.join(dir, 'dist', bin));
    } catch { ok = false; }

    const rel = path.relative(ROOT, dir);
    if (ok) { console.log(`  = already unpacked ${rel}/dist`); continue; }

    if (check) {
      console.log(`  ! needs unpacking  ${rel}/dist  (dist is empty or path.txt is missing)`);
      fixed++;
      continue;
    }

    // install.js short-circuits when it believes the version is already there,
    // and a one-entry dist is enough to confuse that check. Clear it first.
    fs.rmSync(path.join(dir, 'dist'), { recursive: true, force: true });
    const res = cp.spawnSync(process.execPath, [installer],
      { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    if (res.error) { console.error(`  ! unpack FAILED    ${rel}: ${res.error.message}`); continue; }
    if (res.status !== 0) {
      console.error(`  ! unpack FAILED    ${rel}: install.js exited ${res.status}`);
      if (res.stderr) console.error(`    ${res.stderr.trim().split('\n').slice(-3).join('\n    ')}`);
      continue;
    }

    let bin = '';
    try { bin = fs.readFileSync(pointer, 'utf8').trim(); } catch { /* reported below */ }
    if (bin && fs.existsSync(path.join(dir, 'dist', bin))) {
      const n = fs.readdirSync(path.join(dir, 'dist')).length;
      console.log(`  + unpacked         ${rel}/dist  (${n} entries, ${bin})`);
      fixed++;
    } else {
      console.error(`  ! unpack FAILED    ${rel}: install.js exited 0 but dist/ still has no binary`);
    }
  }
  return fixed;
}

function main() {
  const check = process.argv.includes('--check');
  let patched = 0, already = 0, missing = 0, needed = 0;

  for (const p of PATCHES) {
    const dirs = findPackage(p.pkg);
    if (!dirs.length) { missing++; console.log(`  - not installed    ${p.pkg}`); continue; }

    for (const dir of dirs) {
      const target = path.join(dir, p.file);
      if (!fs.existsSync(target)) continue;
      const current = fs.readFileSync(target, 'utf8');

      if (current.includes(MARKER)) {
        already++;
        console.log(`  = already patched  ${path.relative(ROOT, target)}`);
        continue;
      }
      if (check) { needed++; console.log(`  ! needs patching   ${path.relative(ROOT, target)}  (${p.why})`); continue; }

      const backup = path.join(dir, 'index.original.js');
      if (!fs.existsSync(backup)) fs.writeFileSync(backup, current, 'utf8');

      const next = p.apply(current);
      if (next === current) {
        console.error(`  ! patch did not apply — upstream source changed: ${path.relative(ROOT, target)}`);
        continue;
      }
      fs.writeFileSync(target, next, 'utf8');
      patched++;
      console.log(`  + patched          ${path.relative(ROOT, target)}  (${p.why})`);
      if (p.pkg === 'extract-zip') verifyExtractZip(dir);
    }
  }

  // Order matters: the patch above has to be on disk before this runs, because
  // this re-unpacks electron THROUGH it. Doing it the other way round repeats
  // the original bug and leaves the same one-entry dist behind.
  const unpacked = repairElectronDist(check);

  if (check) {
    console.log(`\n${needed} need patching, ${already} already patched, ${missing} not installed.`);
    if (unpacked) console.log(`${unpacked} electron dist(s) need unpacking.`);
    process.exit(needed || unpacked ? 1 : 0);
  }
  console.log(`\n${patched} patched, ${already} already patched, ${missing} not installed.`);
  if (unpacked) console.log(`${unpacked} electron dist(s) unpacked.`);
}

if (require.main === module) main();
module.exports = { findPackage, MARKER, PATCHES };
