// Verify the Squirrel.Windows files belong to one build before publication.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function option(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : '';
}

function fileInfo(file, label) {
  const resolved = path.resolve(file || '');
  if (!file || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(`${label} is missing: ${file || '(empty)'}`);
  }
  const bytes = fs.readFileSync(resolved);
  return { path: resolved, name: path.basename(resolved), size: bytes.length, sha1: crypto.createHash('sha1').update(bytes).digest('hex') };
}

function verify({ setup, nupkg, releases }) {
  const setupInfo = fileInfo(setup, 'Setup.exe');
  const packageInfo = fileInfo(nupkg, '.nupkg');
  const releasesInfo = fileInfo(releases, 'RELEASES');
  if (!/setup\.exe$/i.test(setupInfo.name)) throw new Error(`installer is not a Setup.exe: ${setupInfo.name}`);
  if (!/\.nupkg$/i.test(packageInfo.name)) throw new Error(`update package is not a .nupkg: ${packageInfo.name}`);

  const lines = releasesInfo.path && fs.readFileSync(releasesInfo.path, 'utf8')
    .split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  // Squirrel's RELEASES format is: SHA1 filename byteCount.
  const match = lines.map((line) => line.split(/\s+/)).find((parts) => parts[1] === packageInfo.name);
  if (!match || match.length < 3) throw new Error(`RELEASES does not reference ${packageInfo.name}`);
  const [sha1, , sizeText] = match;
  if (!/^[a-f0-9]{40}$/i.test(sha1)) throw new Error(`RELEASES has an invalid SHA-1 for ${packageInfo.name}`);
  if (Number(sizeText) !== packageInfo.size) throw new Error(`RELEASES size ${sizeText} does not match ${packageInfo.name} (${packageInfo.size})`);
  if (sha1.toLowerCase() !== packageInfo.sha1) throw new Error(`RELEASES SHA-1 does not match ${packageInfo.name}`);
  return { setup: setupInfo, nupkg: packageInfo, releases: releasesInfo, entries: lines.length };
}

function main() {
  const result = verify({ setup: option('setup'), nupkg: option('nupkg'), releases: option('releases') });
  process.stdout.write(JSON.stringify({ ok: true, setup: result.setup.name, nupkg: result.nupkg.name, releases: result.releases.name, entries: result.entries }) + '\n');
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(`Squirrel artifact verification failed: ${error.message}`); process.exitCode = 1; }
}

module.exports = { verify };
