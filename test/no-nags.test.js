// no-nags.test.js — the app must never nag.
//
// WinSCP ships a Donate action and shows donation prompts. This port keeps the
// menu entry (WinSCP is someone else's work and deserves the link) but refuses
// the prompt: no unsolicited dialog, banner, toast, badge or startup
// interruption asking for money, sponsorship, reviews, ratings or upgrades.
//
// This is easy to honour today and easy to break later — somebody adds a
// "support the project" toast six months from now and nobody notices. So the
// rule is enforced by reading the source rather than by remembering it.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/** Words that mark a promotional ask, as opposed to a neutral mention. */
const PROMO = /\b(donate|donation|sponsor|sponsorship|patreon|ko-?fi|buy\s?me\s?a\s?coffee|paypal|upgrade\s+to\s+pro|subscribe|subscription|rate\s+(us|this\s+app)|leave\s+a\s+review|star\s+us\s+on)\b/i;

/** Ways a surface appears without the user asking for it. */
const AUTO_SURFACE = /\b(notify\.(info|warn|error|success)|toast\(|showToast|openDialog\(|showModal|alert\(|setInterval|setTimeout)\b/;

function sourceFiles(dir, out = []) {
  for (const it of fs.readdirSync(dir, { withFileTypes: true })) {
    if (it.name === 'node_modules' || it.name === '.git') continue;
    const p = path.join(dir, it.name);
    if (it.isDirectory()) sourceFiles(p, out);
    else if (/\.(js|mjs|html|css)$/.test(it.name)) out.push(p);
  }
  return out;
}

/** The shipping application only — not the design mockup, tools or tests. */
function appFiles() {
  return [
    ...sourceFiles(path.join(ROOT, 'design', 'main')),
    ...sourceFiles(path.join(ROOT, 'design', 'preload')),
    ...sourceFiles(path.join(ROOT, 'design', 'renderer')),
  ].filter((p) => !/[\\/]forms\.json$/.test(p));
}

test('no promotional word appears on a line that also raises a surface', () => {
  const offenders = [];
  for (const file of appFiles()) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      // A comment explaining the policy is not a violation of it.
      const code = line.replace(/\/\/.*$/, '').replace(/\/\*[\s\S]*?\*\//g, '');
      if (PROMO.test(code) && AUTO_SURFACE.test(code)) {
        offenders.push(`${path.relative(ROOT, file)}:${i + 1}  ${line.trim()}`);
      }
    });
  }
  assert.deepStrictEqual(offenders, [],
    'A promotional term appears where a dialog, toast or timer is raised. ' +
    'The donation link is a menu command the user clicks — never a prompt:\n' + offenders.join('\n'));
});

test('the Donate action is removed, not merely quiet', () => {
  const src = fs.readFileSync(path.join(ROOT, 'design', 'renderer', 'ui', 'commands.js'), 'utf8');

  // The URL must not exist anywhere in the shipping app. A link that is only
  // hidden today is a link somebody re-surfaces tomorrow.
  for (const file of appFiles()) {
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(!/winscp\.net\/eng\/donate/.test(text),
      `${path.relative(ROOT, file)} still contains the donation URL`);
  }

  // It stays registered so the coverage ledger records a DECISION rather than
  // an oversight — but hidden and disabled, so nothing can surface it.
  assert.match(src, /def\('DonatePageAction',\s*\{[\s\S]*?visible:\s*\(\)\s*=>\s*false/,
    'DonatePageAction must be registered as hidden, so the ledger shows it was decided, not forgotten');
  assert.match(src, /def\('DonatePageAction',\s*\{[\s\S]*?unavailable:/,
    'DonatePageAction must carry a reason explaining why it is not ported');
});

test('nothing schedules a promotional surface on a timer or at startup', () => {
  const offenders = [];
  for (const file of appFiles()) {
    const text = fs.readFileSync(file, 'utf8');
    if (!PROMO.test(text)) continue;
    // Look at the whole neighbourhood, not one line: a nag is usually a timer
    // in one place and the message a few lines below.
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (!/\b(setInterval|setTimeout|whenReady|on\(\s*'ready'|app:started|startup)\b/.test(line)) return;
      const window = lines.slice(i, i + 12).join('\n').replace(/\/\/.*$/gm, '');
      if (PROMO.test(window)) {
        offenders.push(`${path.relative(ROOT, file)}:${i + 1}`);
      }
    });
  }
  assert.deepStrictEqual(offenders, [],
    'A promotional term appears near a startup or timer hook:\n' + offenders.join('\n'));
});

test('there is no setting that pretends to switch nagging off', () => {
  // A "don't ask me again" checkbox is not compliance — it is an admission that
  // the app nags by default. The correct number of such settings is zero.
  const defaults = fs.readFileSync(path.join(ROOT, 'design', 'main', 'defaults.js'), 'utf8');
  const keys = defaults.match(/^\s*(\w+):/gm) || [];
  const offenders = keys.filter((k) => PROMO.test(k));
  assert.deepStrictEqual(offenders, [],
    'No preference key should exist to disable a promotional prompt, because no such prompt should exist.');
});

test('the update check reports through a corner notification, not a modal', () => {
  // Update availability is legitimate information, but it is still unsolicited,
  // so it must not block. This guards the one place that is allowed to speak up.
  const updates = fs.readFileSync(path.join(ROOT, 'design', 'main', 'updates.js'), 'utf8');
  assert.ok(!/showMessageBoxSync|dialog\.showMessageBox\s*\(/.test(updates),
    'an update result must not open a blocking dialog from the main process');
});
