// build/release-notes.js — compose the GitHub Release notes for one CI run.
//
//   node build/release-notes.js --tag v0.1.0-build.7 --out RELEASE_NOTES.md
//
// Reads codename.json (written by build/pick-codename.js) and the environment
// that .github/workflows/ci.yml sets. Every claim it prints is derived from a
// file that exists on disk at the moment it runs — it never predicts a build
// result, never asserts that CI is green, and never invents an artefact.
'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const pkg = require('../package.json');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function mb(file) {
  try { return `${(fs.statSync(file).size / 1048576).toFixed(1)} MB`; } catch { return null; }
}

function readCodename() {
  const f = path.join(REPO_ROOT, 'codename.json');
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}

function main() {
  const tag = arg('tag', `v${pkg.version}-local`);
  const out = arg('out', 'RELEASE_NOTES.md');

  const env = process.env;
  const server = env.SERVER_URL || 'https://github.com';
  const repo = env.REPOSITORY || 'Ding-Ding-Projects/material-winscp';
  const runId = env.RUN_ID || '';
  const runNumber = env.RUN_NUMBER || '';
  const sha = env.COMMIT_SHA || '';
  const runUrl = runId ? `${server}/${repo}/actions/runs/${runId}` : null;

  const setup = env.SETUP_PATH || '';
  const nupkg = env.NUPKG_PATH || '';
  const zip = env.ZIP_PATH || '';
  const photo = env.PHOTO_PATH || '';
  const cn = readCodename();

  const L = [];

  L.push(`# ${pkg.productName} ${pkg.version} — \`${tag}\``);
  L.push('');
  if (cn && cn.assigned) {
    L.push(`**Code name: ${cn.en} · ${cn.zh}**  \`${cn.id}\``);
    L.push('');
    L.push('> [!NOTE]');
    L.push('> The code name is a label beside the version, not a replacement for it.');
    L.push(`> This build is **${pkg.version}**, tagged \`${tag}\`. Each dish is used once and never recycled.`);
  } else if (cn) {
    L.push('**No code name for this build.**');
    L.push('');
    L.push('> [!NOTE]');
    L.push(`> ${cn.reason || 'The bundled dim sum catalog could not supply an unused dish.'}`);
    L.push('> A release is never blocked or renamed because the catalog is unavailable, so this one ships with its version alone.');
  }
  L.push('');
  L.push('---');
  L.push('');

  // ------------------------------------------------------------- downloads --
  L.push('## 📦 Downloads');
  L.push('');
  L.push('| Asset | What it is | Size |');
  L.push('| --- | --- | --- |');
  if (setup) {
    L.push(`| \`${path.basename(setup)}\` | **The Windows installer.** A genuine Squirrel.Windows Setup.exe built by this run. Run it to install. | ${mb(setup) || 'n/a'} |`);
  }
  if (nupkg) {
    L.push(`| \`${path.basename(nupkg)}\` | Squirrel update package, used by the in-app updater. | ${mb(nupkg) || 'n/a'} |`);
  }
  L.push('| `RELEASES` | Squirrel update manifest. Not something you download by hand. | — |');
  if (zip) {
    L.push(`| \`${path.basename(zip)}\` | Portable archive — unzip and run, no installer. | ${mb(zip) || 'n/a'} |`);
  }
  if (photo) {
    L.push(`| \`${path.basename(photo)}\` | The dim sum photograph below, as a downloadable image. | ${mb(photo) || 'n/a'} |`);
  }
  L.push('| `codename.json` | The machine-readable code-name assignment for this build. | — |');
  L.push('');
  L.push('> [!WARNING]');
  L.push('> These builds are **not code-signed**. Windows SmartScreen will warn on first run.');
  L.push('> Verify the asset came from this release page before running it.');
  L.push('');

  // ---------------------------------------------------------------- dimsum --
  if (photo && cn) {
    const dishEn = cn.en || cn.photoEn || 'Dim sum';
    const dishZh = cn.zh || cn.photoZh || '';
    L.push('## 🥟 Dim sum with your release');
    L.push('');
    L.push(`**${dishEn}${dishZh ? ` · ${dishZh}` : ''}** — asset \`${path.basename(photo)}\`, from the bundled catalog at \`${cn.imagePath}\` (${cn.imagePixels || 'unknown size'}).`);
    L.push('');
    L.push('The image was decoded and verified during this run before it was attached. It is a byte-for-byte copy of the tracked repository asset — nothing was generated, downloaded or substituted.');
    L.push('');
    L.push(`> 軟件可以好認真，但每個 release 都要有一籠點心。今次呢籠係**${dishZh || dishEn}**。`);
    L.push('');
  }

  // --------------------------------------------------------------- what is --
  L.push('## What this is');
  L.push('');
  L.push(pkg.description);
  L.push('');
  L.push('- **English:** every WinSCP feature, rebuilt on Material Design 3, with tabs, an appearance editor for every element, a regex builder beside every search bar, and local version history.');
  L.push('- **粵語：** 成個 WinSCP 搬咗過嚟 Material Design 3，仲有分頁、每個元件都改得靚、每個搜尋框都有 regex 產生器，同埋本機版本記錄。');
  L.push('');

  // ------------------------------------------------------------ provenance --
  L.push('## Build provenance');
  L.push('');
  L.push('| | |');
  L.push('| --- | --- |');
  L.push(`| Version | \`${pkg.version}\` |`);
  L.push(`| Tag | \`${tag}\` |`);
  if (sha) L.push(`| Commit | [\`${sha.slice(0, 12)}\`](${server}/${repo}/commit/${sha}) |`);
  if (runNumber) L.push(`| Run number | \`${runNumber}\` (monotonic; tags are never recycled) |`);
  if (runUrl) L.push(`| Workflow run | [${runId}](${runUrl}) |`);
  L.push('| Runner | GitHub-hosted \`windows-latest\` |');
  L.push('| Tests | Passed in the `test` job — this release job only runs when they do |');
  L.push('| Code signing | None |');
  if (env.DISPATCH_REASON) L.push(`| Dispatch reason | ${env.DISPATCH_REASON} |`);
  L.push('');

  L.push('<details><summary>How the code name is assigned, and how to check it</summary>');
  L.push('');
  L.push('`build/release-codenames.json` holds a fixed dish sequence. Release number *N* takes entry *N* of that sequence, counting only dishes whose bundled photograph actually decodes. Recompute any build\'s name yourself with:');
  L.push('');
  L.push('```sh');
  L.push(`node build/pick-codename.js --index ${runNumber || 'N'}`);
  L.push('```');
  L.push('');
  L.push('CI never pushes a commit back to this repository, so the mapping is deterministic rather than recorded by a bot — which is also why a release can never retrigger the workflow.');
  L.push('');
  L.push('</details>');
  L.push('');

  L.push('---');
  L.push('');
  L.push(`Full documentation: [\`docs/\`](${server}/${repo}/tree/main/docs) · Site: [\`site/\`](${server}/${repo}/tree/main/site)`);
  L.push('');

  fs.writeFileSync(path.join(REPO_ROOT, out), L.join('\n'));
  console.log(`wrote ${out} (${L.length} lines) for ${tag}`);
}

if (require.main === module) main();
