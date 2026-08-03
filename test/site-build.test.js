// site-build.test.js — the documentation site's builder and its verifier.
//
// The site's homepage field advertises a URL where every path 404s, and the
// reason is a chain of quiet failures rather than one loud one: the client
// application was never committed, so index.html referenced files that did not
// exist, and `--verify` — the check written precisely to name that — read
// app.js unconditionally and died ENOENT before it reached its own report. A
// tool that reports a missing file by crashing has reported nothing: the exit
// code is 1 either way, and the operator sees a stack trace about fs instead of
// the sentence "app.js is missing from the output".
//
// So these tests are about the verifier TELLING THE TRUTH, in the two ways it
// can fail to:
//   * throwing where it should report, and
//   * passing a build that is going to 404 in production.
//
// The second is the base-path trap. A static site that emits "/app.css" instead
// of "/material-winscp/app.css" builds green, deploys green, and serves a blank
// page — the assets are being fetched from the domain root, where nothing lives.
// The only place that can be caught is in the EMITTED BYTES, so every assertion
// below reads output, never configuration.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const BUILD = path.join(ROOT, 'site', 'build.js');
const { build, verify, walk, normalizeBase } = require(BUILD);

const BASE = '/material-winscp/';

/* --------------------------------------------------------------- fixtures */

const scratch = [];
function tmpdir(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `site-${tag}-`));
  scratch.push(d);
  return d;
}
test.after(() => {
  for (const d of scratch) fs.rmSync(d, { recursive: true, force: true });
});

function put(dir, rel, text) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

/**
 * A minimal but COMPLETE emitted site: everything index.html references really
 * exists, every URL carries the prefix, nothing is fetched from another host.
 * Each test then breaks exactly one thing, so a failure names one cause.
 */
function emitted(overrides = {}) {
  const out = tmpdir('out');
  const data = {
    base: BASE,
    version: '0.1.0',
    categories: [{ id: '/protocols', articles: [{ id: '/protocols/sftp' }] }],
    catalog: [{ id: 'dim-0001', file: 'dim-0001-har-gow.png' }],
  };
  const files = Object.assign({
    'index.html':
      '<!doctype html><html><head>' +
      `<link rel="stylesheet" href="${BASE}app.css">` +
      `<link rel="icon" href="${BASE}favicon.svg">` +
      '</head><body>' +
      `<script src="${BASE}content.js"></script>` +
      `<script src="${BASE}app.js"></script>` +
      '</body></html>\n',
    'app.css': ':root { color-scheme: light dark; }\n',
    'app.js': '// the application\n',
    'favicon.svg': '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n',
    'content.js': `window.SITE_DATA = ${JSON.stringify(data)};\n`,
    'assets/dim-0001-har-gow.png': 'PNG',
  }, overrides);

  for (const [rel, text] of Object.entries(files)) {
    if (text === null) continue;              // null means "leave it out"
    put(out, rel, text);
  }
  return out;
}

/** The problems, joined, so an assertion can just look for a phrase. */
const said = (result) => result.problems.join('\n');

/**
 * A throwaway copy of everything the builder reads, so the CLI can be driven
 * end to end without writing fixtures into the repository's own site/src.
 *
 * design/assets is created EMPTY on purpose: the dim sum catalog only bundles
 * dishes whose image really exists, so an empty directory yields an empty
 * catalog and saves copying fourteen megabytes of photographs per test. The
 * catalog is covered by its own assertions above.
 */
function tempRepo() {
  const repo = tmpdir('repo');
  fs.mkdirSync(path.join(repo, 'design', 'assets'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'site'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'docs'), path.join(repo, 'docs'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'design', 'winscp-data.js'), path.join(repo, 'design', 'winscp-data.js'));
  fs.cpSync(BUILD, path.join(repo, 'site', 'build.js'));
  fs.cpSync(path.join(ROOT, 'site', 'config.json'), path.join(repo, 'site', 'config.json'));
  fs.cpSync(path.join(ROOT, 'site', 'src'), path.join(repo, 'site', 'src'), { recursive: true });

  // The real application is copied above; these stand-ins replace it so a CLI
  // test fails for its OWN reason rather than dragging the whole lib/ module
  // graph into a fixture that is meant to isolate one broken thing.
  put(repo, 'site/src/app.js', '// stand-in for the application\n');
  put(repo, 'site/src/app.css', '/* stand-in for the stylesheet */\n');
  return repo;
}

/** Add a <link>/<script> for `rel` to the temp repository's index.html, so the
 *  fixture file is unambiguously part of the page rather than a stray file. */
function reference(repo, rel) {
  const idx = path.join(repo, 'site', 'src', 'index.html');
  const tag = rel.endsWith('.css')
    ? `<link rel="stylesheet" href="{{BASE}}${rel}">`
    : `<script src="{{BASE}}${rel}"></script>`;
  fs.writeFileSync(idx, fs.readFileSync(idx, 'utf8').replace('</head>', `${tag}\n</head>`));
}

function runCli(repo, ...extra) {
  const r = spawnSync(process.execPath, [path.join(repo, 'site', 'build.js'), '--verify', ...extra],
    { encoding: 'utf8' });
  return { status: r.status, text: `${r.stdout}\n${r.stderr}` };
}

/* ------------------------------------------------- the control, first ---- */

test('a complete emitted site verifies clean', () => {
  // Without this the tests below prove nothing: any of them would "pass" if the
  // fixture were broken in some unrelated way.
  const result = verify({ out: emitted(), base: BASE });
  assert.deepStrictEqual(result.problems, []);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.stats.articles, 1);
});

/* -------------------------------------- reporting instead of exploding --- */

test('a referenced file that was never built is REPORTED, not thrown', () => {
  // The exact shape of the live defect: index.html asks for app.js and app.css,
  // neither was ever committed. The verifier must survive reading them.
  const out = emitted({ 'app.js': null, 'app.css': null });
  let result;
  assert.doesNotThrow(() => { result = verify({ out, base: BASE }); });
  assert.strictEqual(result.ok, false);
  assert.match(said(result), /referenced file is missing from the output: \/material-winscp\/app\.js/);
  assert.match(said(result), /referenced file is missing from the output: \/material-winscp\/app\.css/);
});

test('every problem is collected, not just the first one', () => {
  // A verifier that stops at the first finding makes fixing a broken build a
  // sequence of rebuilds. There are four distinct faults here.
  const out = emitted({
    'app.js': null,
    'app.css': 'body { background: url(/logo.png); }\n',
    'extra.js': '// {{BASE}} never substituted\n',
    'other.css': '@import url("https://fonts.example/x.css");\n',
  });
  const result = verify({ out, base: BASE });
  assert.strictEqual(result.ok, false);
  assert.ok(result.problems.length >= 4, `expected several problems, got ${result.problems.length}`);
  assert.match(said(result), /app\.js/);
  assert.match(said(result), /logo\.png/);
  assert.match(said(result), /\{\{BASE\}\}/);
  assert.match(said(result), /fonts\.example/);
});

test('a missing index.html is reported rather than crashing the verifier', () => {
  const result = verify({ out: emitted({ 'index.html': null }), base: BASE });
  assert.strictEqual(result.ok, false);
  assert.match(said(result), /index\.html is missing from the output/);
});

test('content.js that is missing or unparseable is reported, not thrown', () => {
  const missing = verify({ out: emitted({ 'content.js': null }), base: BASE });
  assert.match(said(missing), /content\.js is missing from the output/);

  let broken;
  assert.doesNotThrow(() => {
    broken = verify({ out: emitted({ 'content.js': 'window.SITE_DATA = {oops;\n' }), base: BASE });
  });
  assert.match(said(broken), /content\.js does not contain parseable data/);
});

test('an output directory that does not exist is a finding, not an exception', () => {
  const result = verify({ out: path.join(tmpdir('gone'), 'never-built'), base: BASE });
  assert.strictEqual(result.ok, false);
  assert.match(said(result), /produced no output directory/);
});

/* ---------------------------------------------------- the base-path trap - */

test('a root-absolute asset URL without the base prefix is caught', () => {
  // The green-deploy-404. The browser fetches https://owner.github.io/app.css,
  // which is not where this site lives.
  const out = emitted({
    'index.html':
      '<!doctype html><html><head><link rel="stylesheet" href="/app.css"></head><body>' +
      `<script src="${BASE}content.js"></script><script src="${BASE}app.js"></script>` +
      '</body></html>\n',
  });
  const result = verify({ out, base: BASE });
  assert.strictEqual(result.ok, false);
  assert.match(said(result), /root-absolute URL without the base prefix \/material-winscp\/: \/app\.css/);
});

test('the prefix is checked in stylesheets and scripts too, not only in index.html', () => {
  // The trap is not an HTML-only trap: a background-image or a fetched module
  // written root-absolute 404s exactly the same way.
  const out = emitted({ 'app.css': '.brand { background: url(/assets/dim-0001-har-gow.png); }\n' });
  const result = verify({ out, base: BASE });
  assert.strictEqual(result.ok, false);
  assert.match(said(result), /app\.css emits a root-absolute URL without the base prefix/);
});

test('the check reads the emitted bytes, so agreeing with the config is not enough', () => {
  // Built under one base, verified against another: the configuration would say
  // yes to either, only the output can say which one it actually carries.
  const out = emitted();
  assert.strictEqual(verify({ out, base: BASE }).ok, true);
  const wrong = verify({ out, base: '/somewhere-else/' });
  assert.strictEqual(wrong.ok, false);
  assert.match(said(wrong), /index\.html does not reference \/somewhere-else\/app\.css/);
});

test('content.js built for a different base than the markup is caught', () => {
  // Half the links resolve and the rest 404 — worse than a page that fails
  // outright, because it looks like it works.
  const data = { base: '/other/', categories: [{ articles: [{}] }], catalog: [] };
  const out = emitted({
    'content.js': `window.SITE_DATA = ${JSON.stringify(data)};\n`,
    'assets/dim-0001-har-gow.png': null,
  });
  const result = verify({ out, base: BASE });
  assert.strictEqual(result.ok, false);
  assert.match(said(result), /content\.js was generated for base "\/other\/", not \/material-winscp\//);
});

/* ------------------------------------------------------ nothing remote --- */

test('a remote subresource is caught wherever it hides', () => {
  const out = emitted({
    'index.html':
      '<!doctype html><html><head>' +
      `<link rel="stylesheet" href="${BASE}app.css">` +
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Roboto">' +
      '</head><body><img src="https://cdn.example/hero.png">' +
      `<script src="${BASE}content.js"></script><script src="${BASE}app.js"></script>` +
      '</body></html>\n',
  });
  const result = verify({ out, base: BASE });
  assert.strictEqual(result.ok, false);
  assert.match(said(result), /fetches a remote subresource \(link\): https:\/\/fonts\.googleapis\.com/);
  assert.match(said(result), /fetches a remote subresource \(src\): https:\/\/cdn\.example\/hero\.png/);
});

test('a link a user clicks is not mistaken for a subresource', () => {
  // <a href> is navigation, not a fetch. Flagging it would make the repository
  // link on the page a build failure.
  const out = emitted({
    'index.html':
      '<!doctype html><html><head>' +
      `<link rel="stylesheet" href="${BASE}app.css">` +
      '</head><body><a href="https://github.com/Ding-Ding-Projects/material-winscp">Repository</a>' +
      `<script src="${BASE}content.js"></script><script src="${BASE}app.js"></script>` +
      '</body></html>\n',
  });
  assert.deepStrictEqual(verify({ out, base: BASE }).problems, []);
});

test('generated prose may quote a placeholder or a URL, but not fetch one', () => {
  // content.js carries the articles, and the articles document this builder —
  // so it legitimately contains the literal string "{{BASE}}" and sentences
  // with an https:// URL in them. Those are quotations. An <img src> pointing
  // at another host is not, and must still fail.
  const quoted = {
    base: BASE,
    categories: [{ articles: [{ html: '<p>{{BASE}}app.js, and https://example.test/logo.png</p>' }] }],
    catalog: [],
  };
  const ok = verify({
    out: emitted({ 'content.js': `window.SITE_DATA = ${JSON.stringify(quoted)};\n` }),
    base: BASE,
  });
  assert.deepStrictEqual(ok.problems, []);

  const fetched = {
    base: BASE,
    categories: [{ articles: [{ html: '<img src="https://example.test/logo.png" alt="">' }] }],
    catalog: [],
  };
  const bad = verify({
    out: emitted({ 'content.js': `window.SITE_DATA = ${JSON.stringify(fetched)};\n` }),
    base: BASE,
  });
  assert.match(said(bad), /content\.js fetches a remote subresource \(src\): https:\/\/example\.test\/logo\.png/);
});

/* ------------------------------------------------- subdirectories exist -- */

test('the verifier walks subdirectories rather than the top level only', () => {
  const out = emitted({
    'app/theme.css': '@import url("https://fonts.example/x.css");\n',
    'app/boot.js': '// {{VERSION}}\n',
  });
  const result = verify({ out, base: BASE });
  assert.strictEqual(result.ok, false);
  assert.match(said(result), /app\/theme\.css @imports a remote stylesheet/);
  assert.match(said(result), /app\/boot\.js still contains the unsubstituted placeholder \{\{VERSION\}\}/);
});

test('a module imported from a subdirectory must exist, and is resolved relative to its importer', () => {
  const out = emitted({
    'index.html':
      '<!doctype html><html><head>' +
      `<link rel="stylesheet" href="${BASE}app.css">` +
      '</head><body>' +
      `<script src="${BASE}content.js"></script><script src="${BASE}app.js"></script>` +
      `<script src="${BASE}app/tabs.js"></script>` +
      '</body></html>\n',
    'app/tabs.js': 'const s = new Image(); s.src = "./missing-icon.svg";\n',
  });
  const result = verify({ out, base: BASE });
  assert.strictEqual(result.ok, false);
  assert.match(said(result), /referenced file is missing from the output: \.\/missing-icon\.svg \(referenced by app\/tabs\.js\)/);
});

test('an ES module import that resolves nowhere is caught, like any other fetch', () => {
  // app.js is a module and pulls lib/*.js in by relative specifier. That is a
  // fetch the browser makes, and it appears in no src=, href= or url() — so the
  // scan that caught the original bug would sail straight past a missing lib/
  // file, which fails the WHOLE module graph and blanks the page. An import is
  // a subresource; it is checked like one.
  const out = emitted({
    'app.js': "import { render } from './lib/pages.js';\nimport './lib/gone.js';\nrender();\n",
    'lib/pages.js': "export { x } from './helpers.js';\nexport const render = () => {};\n",
  });
  const result = verify({ out, base: BASE });
  assert.strictEqual(result.ok, false);
  assert.match(said(result), /imported module is missing from the output: \.\/lib\/gone\.js \(imported by app\.js\)/);
  // …and resolved relative to the IMPORTER, not the output root: pages.js lives
  // in lib/, so './helpers.js' means lib/helpers.js.
  assert.match(said(result), /imported module is missing from the output: \.\/helpers\.js \(imported by lib\/pages\.js\)/);
});

test('a bare specifier and a cross-origin import are both refused', () => {
  const out = emitted({
    'app.js': "import fs from 'node:fs';\nimport x from 'https://cdn.example.invalid/x.js';\n",
  });
  const result = verify({ out, base: BASE });
  assert.strictEqual(result.ok, false);
  // A bare specifier works in Node and silently does not work in a browser,
  // which is the worst possible place for it to be discovered.
  assert.match(said(result), /bare specifier "node:fs"/);
  assert.match(said(result), /imports from another host: https:\/\/cdn\.example\.invalid\/x\.js/);
});

test('an import that does resolve is not reported', () => {
  const out = emitted({
    'app.js': "import { render } from './lib/pages.js';\nrender();\n",
    'lib/pages.js': 'export const render = () => {};\n',
  });
  const result = verify({ out, base: BASE });
  assert.deepStrictEqual(result.problems, []);
});

test('build() copies a subdirectory of the sources and substitutes inside it', () => {
  // The copy loop used to `continue` on any directory, so the client app had to
  // be three files at the top of site/src/ forever. Splitting it into modules
  // produced a green build that shipped none of them.
  const src = tmpdir('src');
  const out = tmpdir('built');
  put(src, 'index.html', `<link rel="stylesheet" href="{{BASE}}app/theme.css"><script src="{{BASE}}app.js"></script><script src="{{BASE}}content.js"></script>`);
  put(src, 'app.js', '// v{{VERSION}}\n');
  put(src, 'app/theme.css', '.t { background: url({{BASE}}assets/x.png); }\n');
  put(src, 'app/ui/tabs.js', 'const BASE = "{{BASE}}";\n');
  put(src, 'app/ui/icon.bin', 'not-text');

  build({ src, out, base: '/material-winscp/' });

  assert.ok(fs.existsSync(path.join(out, 'app', 'theme.css')), 'a first-level subdirectory file was not copied');
  assert.ok(fs.existsSync(path.join(out, 'app', 'ui', 'tabs.js')), 'a nested subdirectory file was not copied');
  assert.ok(fs.existsSync(path.join(out, 'app', 'ui', 'icon.bin')), 'a binary file in a subdirectory was not copied');
  assert.match(fs.readFileSync(path.join(out, 'app', 'theme.css'), 'utf8'), /url\(\/material-winscp\/assets\/x\.png\)/);
  assert.match(fs.readFileSync(path.join(out, 'app', 'ui', 'tabs.js'), 'utf8'), /const BASE = "\/material-winscp\/";/);
  assert.ok(!fs.readFileSync(path.join(out, 'app', 'ui', 'tabs.js'), 'utf8').includes('{{'),
    'a placeholder survived the copy into a subdirectory');
});

test('walk() returns slash-separated paths for the whole tree', () => {
  const d = tmpdir('walk');
  put(d, 'a.txt', 'a');
  put(d, 'x/b.txt', 'b');
  put(d, 'x/y/c.txt', 'c');
  assert.deepStrictEqual(walk(d).sort(), ['a.txt', 'x/b.txt', 'x/y/c.txt']);
});

/* ------------------------------------------------ the real build, on CLI - */

test('normalizeBase always yields exactly one leading and trailing slash', () => {
  assert.strictEqual(normalizeBase('material-winscp'), '/material-winscp/');
  assert.strictEqual(normalizeBase('/material-winscp'), '/material-winscp/');
  assert.strictEqual(normalizeBase('//material-winscp//'), '/material-winscp/');
  assert.strictEqual(normalizeBase('/'), '/');
});

test('`node site/build.js --verify` names a missing file instead of a stack trace', () => {
  // This used to run against the repository itself, because app.js and app.css
  // were genuinely absent and that WAS the repository's state. They exist now,
  // so asserting the real tree still fails would be asserting that the site
  // stays broken. The property being tested has not changed — the verifier must
  // report a missing referenced file in words an operator can act on, never by
  // exploding — so it is asserted against a tree where the file is deliberately
  // removed, and the green case is asserted separately below.
  const repo = tempRepo();
  fs.rmSync(path.join(repo, 'site', 'src', 'app.js'));

  const r = runCli(repo);
  assert.strictEqual(r.status, 1, 'a failing verify must exit non-zero');
  assert.match(r.text, /VERIFY FAILED/);
  assert.match(r.text, /app\.js/);
  assert.doesNotMatch(r.text, /ENOENT/, 'the verifier crashed instead of reporting');
  assert.doesNotMatch(r.text, /at Object\.readFileSync/, 'a stack trace is not a report');
});

test('the repository itself now verifies clean, end to end, exactly as CI runs it', () => {
  // The whole point of the exercise: site/src/ contains a real client
  // application, every file index.html and app.js reference is emitted, and no
  // URL loses the base prefix. If this ever goes red the published site is
  // serving 404s again, which is precisely how it got into that state before.
  const r = spawnSync(process.execPath, [BUILD, '--verify'], { cwd: ROOT, encoding: 'utf8' });
  const all = `${r.stdout}\n${r.stderr}`;

  assert.strictEqual(r.status, 0, `the real build must verify clean:\n${all}`);
  assert.match(all, /VERIFY OK/);
  assert.doesNotMatch(all, /VERIFY FAILED/);
});

test('concurrent CLI builds serialize their shared output and all verify clean', { timeout: 600000 }, async () => {
  const children = Array.from({ length: 6 }, () => spawn(process.execPath, [BUILD, '--verify'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
  const results = await Promise.all(children.map((child) => new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
  })));

  for (const result of results) {
    assert.strictEqual(result.status, 0,
      `concurrent build failed (${result.signal || 'exit ' + result.status}):\n${result.stdout}\n${result.stderr}`);
    assert.match(`${result.stdout}\n${result.stderr}`, /VERIFY OK/);
  }
});

test('the CLI catches a base-path trap inside a source subdirectory', () => {
  // Both halves of the deployment failure in one run: a stylesheet in a
  // subdirectory has to REACH the output at all, and once there its
  // root-absolute url() has to be reported. A copy loop that skips directories
  // hides the trap by never emitting the file that carries it.
  const repo = tempRepo();
  put(repo, 'site/src/app/theme.css', '.brand { background: url(/assets/logo.png); }\n');
  reference(repo, 'app/theme.css');

  const r = runCli(repo);
  assert.ok(fs.existsSync(path.join(repo, 'site', '_site', 'app', 'theme.css')),
    'the source subdirectory never reached the output');
  assert.strictEqual(r.status, 1, 'a site that will 404 in production must not verify green');
  assert.match(r.text, /app\/theme\.css emits a root-absolute URL without the base prefix \/material-winscp\//);
});

test('the CLI verifies a complete site green, modules and all', () => {
  // The state the next change should reach: application files, including ones
  // in subdirectories, present and correctly prefixed. Without this the failing
  // tests above could be satisfied by a verifier that simply always fails.
  const repo = tempRepo();
  put(repo, 'site/src/app/ui/tabs.js', 'const BASE = "{{BASE}}";\nconst icon = "{{BASE}}favicon.svg";\n');
  reference(repo, 'app/ui/tabs.js');

  const r = runCli(repo);
  assert.strictEqual(r.status, 0, r.text);
  assert.match(r.text, /VERIFY OK/);
  // A count, not THE count: articles are generated from docs/, so hardcoding
  // today's number would turn writing documentation into a test failure.
  const articles = Number((r.text.match(/(\d+) articles/) || [, 0])[1]);
  assert.ok(articles > 40, `only ${articles} articles were generated`);
});

test('the real build emits the base prefix on its own asset references', () => {
  // Guards the live output, not a fixture: whatever the next change to the
  // page is, the emitted URLs still have to carry /material-winscp/.
  const r = spawnSync(process.execPath, [BUILD], { cwd: ROOT, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);

  const out = path.join(ROOT, 'site', '_site');
  const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  for (const want of [`${BASE}app.css`, `${BASE}app.js`, `${BASE}content.js`, `${BASE}favicon.svg`]) {
    assert.ok(html.includes(want), `index.html does not reference ${want}`);
  }
  assert.ok(!html.includes('{{'), 'a placeholder survived into the emitted index.html');

  const rooted = [...html.matchAll(/(?:src|href)="(\/[^"]*)"/g)].map((m) => m[1]);
  assert.ok(rooted.length > 0, 'no root-absolute URLs at all — the fixture stopped testing anything');
  for (const u of rooted) assert.ok(u.startsWith(BASE), `root-absolute URL without the prefix: ${u}`);
});

test('the real site carries the verified changelog ledger with exact commit links', () => {
  const out = path.join(ROOT, 'site', '_site');
  const text = fs.readFileSync(path.join(out, 'content.js'), 'utf8');
  const data = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  const entries = data.changelog && data.changelog.development;
  assert.ok(Array.isArray(entries) && entries.length > 0, 'the site must emit generated changelog entries');
  for (const entry of entries) {
    assert.match(entry.oid, /^[0-9a-f]{40}$/);
    assert.equal(entry.commitUrl, `${REPO_URL}/commit/${entry.oid}`);
    assert.equal(entry.commitUrl.endsWith(entry.oid), true);
    assert.match(entry.date, /^\d{4}-\d{2}-\d{2}$/);
  }
});

/* ------------------------------------------- the installer download button */

/**
 * The landing page's download button exists only when the builder can PROVE
 * what it points at, and the proof is a manifest whose asset URLs are the
 * immutable /releases/download/<tag>/<file> form on this repository.
 *
 * The failure this guards against is the tempting one: assembling
 * ".../releases/latest/download/Setup.exe" out of the version number. That link
 * builds green, deploys green, and 404s the first time an asset is named
 * something other than what was guessed. A download button that does not
 * download is worse than no button, because the reader concludes the project
 * does not ship rather than that the page is wrong.
 */
function withRelease(manifest) {
  const repo = tempRepo();
  if (manifest !== null) put(repo, 'site/release.json', JSON.stringify(manifest));
  const r = spawnSync(process.execPath, [path.join(repo, 'site', 'build.js')], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const text = fs.readFileSync(path.join(repo, 'site', '_site', 'content.js'), 'utf8');
  return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)).release;
}

const REPO_URL = 'https://github.com/Ding-Ding-Projects/material-winscp';

test('no manifest means no release data at all, so the page shows no button', () => {
  assert.strictEqual(withRelease(null), null);
});

test('a real manifest yields an immutable installer URL', () => {
  const rel = withRelease({
    tagName: 'v9.9.9',
    name: 'WinSCP Material 9.9.9',
    publishedAt: '2026-01-01T00:00:00Z',
    assets: [
      { name: 'RELEASES', size: 88, url: `${REPO_URL}/releases/download/v9.9.9/RELEASES` },
      { name: 'WinSCP.Material.9.9.9.Setup.exe', size: 1234, url: `${REPO_URL}/releases/download/v9.9.9/WinSCP.Material.9.9.9.Setup.exe` },
    ],
  });
  assert.strictEqual(rel.tag, 'v9.9.9');
  assert.strictEqual(rel.version, '9.9.9');
  assert.strictEqual(rel.installer.name, 'WinSCP.Material.9.9.9.Setup.exe');
  assert.strictEqual(rel.installer.platform, 'Windows');
  assert.ok(rel.installer.url.startsWith(`${REPO_URL}/releases/download/v9.9.9/`));
});

test('a mutable or foreign asset URL is dropped rather than turned into a button', () => {
  const mutable = withRelease({
    tagName: 'v9.9.9',
    assets: [{ name: 'Setup.exe', size: 1, url: `${REPO_URL}/releases/latest/download/Setup.exe` }],
  });
  assert.strictEqual(mutable.installer, null, 'a "latest" link became a download button');
  assert.deepStrictEqual(mutable.assets, [], 'a mutable URL survived into the asset list');

  const foreign = withRelease({
    tagName: 'v9.9.9',
    assets: [{ name: 'Setup.exe', size: 1, url: 'https://example.invalid/releases/download/v9.9.9/Setup.exe' }],
  });
  assert.strictEqual(foreign.installer, null, 'another host became a download button');
});

test('a draft, a tagless manifest and unparseable JSON all mean no release', () => {
  assert.strictEqual(withRelease({ tagName: 'v9.9.9', isDraft: true, assets: [] }), null);
  assert.strictEqual(withRelease({ assets: [] }), null);

  // A broken manifest must not fail the docs build. The page loses its button
  // and says why; it does not lose the documentation.
  const repo = tempRepo();
  put(repo, 'site/release.json', '{ not json');
  const r = spawnSync(process.execPath, [path.join(repo, 'site', 'build.js')], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, 'a broken manifest must not fail the whole build');
  assert.match(r.stdout, /not parseable JSON/);
});

test('a release with no installer asset still records the release, without a button', () => {
  const rel = withRelease({
    tagName: 'v9.9.9',
    assets: [{ name: 'notes.txt', size: 10, url: `${REPO_URL}/releases/download/v9.9.9/notes.txt` }],
  });
  assert.strictEqual(rel.installer, null);
  assert.strictEqual(rel.assets.length, 1);
});
