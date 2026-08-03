'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'design', 'renderer', 'ui', 'dialogs', 'authenticate.js'), 'utf8');

test('host-key acceptance closes only after answer delivery succeeds', () => {
  assert.match(source, /function accept\(remember, close\)/);
  assert.match(source, /if \(!ok\) \{ submitting = false; return; \}\s*answered = true;\s*close\?\.\('action'\)/);
  assert.match(source, /onSelect: \(close\) => \{ accept\(false, close\); return true; \}/);
});

test('host-key acceptance fails closed when the presented fingerprint is missing', () => {
  assert.match(source, /const presentedFingerprint = String\(payload\?\.fingerprintSHA256 \|\| ''\)\.trim\(\);/);
  assert.match(source, /if \(!presentedFingerprint\) \{[\s\S]*?notify\.error\(t\('hostKeyTitle'\), t\('txHkRejected', hostPort\)\);[\s\S]*?return;/);
  assert.match(source, /fingerprintBlock\(changed \? 'txHkPresented' : 'txHkFingerprint', presentedFingerprint\)/);
});

test('changed host-key replacement keeps the second confirmation before delivery', () => {
  assert.match(source, /defaultAnswer: 'no'/);
  assert.match(source, /if \(r\.answer === 'yes'\) accept\(true, close\)/);
  assert.doesNotMatch(source, /if \(r\.answer === 'yes'\) \{ accept\(true\); close\(\); \}/);
});

test('certificate acceptance has the same retry-safe delivery semantics', () => {
  assert.match(source, /function accept\(remember, close\)/g);
  assert.match(source, /txCertAcceptOnce.*onSelect: \(close\) => \{ accept\(false, close\); return true; \}/s);
  assert.match(source, /txCertAcceptStore.*onSelect: \(close\) => \{ accept\(true, close\); return true; \}/s);
});

test('credential delivery stays retryable and wipes fields after the answer is delivered', () => {
  assert.match(source, /let submitting = false;[\s\S]*?async function submit\(close\)/);
  assert.match(source, /if \(!ok\) \{\s*submitting = false; return;\s*\}/);
  assert.match(source, /answered = true;\s*for \(const input of inputs\) input\.value = '';\s*close\?\.\('action'\)/);
  assert.match(source, /onSelect: \(close\) => \{[\s\S]*?void submit\(close\);\s*return true;/);
});

test('cancelled prompts do not send a second refusal, and untrusted keys are not focused for acceptance', () => {
  assert.equal((source.match(/reason === 'prompt-cancelled'/g) || []).length, 3);
  assert.match(source, /handle\.close\('prompt-cancelled'\)/);
  assert.match(source, /txHkReject'.*autofocus: true/s);
  assert.match(source, /txHkAcceptStore'.*autofocus: false/s);
});

test('certificate approval fails closed without a SHA-256 fingerprint', () => {
  assert.match(source, /const presentedFingerprint = String\(payload\?\.fingerprintSHA256 \|\| ''\)\.trim\(\);/);
  assert.match(source, /if \(!presentedFingerprint\) \{[\s\S]*?notify\.error\(t\('txCertTitle'\), t\('txCertRejected', hostPort\)\);[\s\S]*?return;/);
});

test('authentication dialogs expose the live session log without handling secrets', () => {
  assert.match(source, /function authenticationLog\(sessionId\)/);
  assert.match(source, /b\?\.session\?\.log\?\.\(sessionId, 0\)/);
  assert.match(source, /payload\?\.sessionId === sessionId/);
  assert.match(source, /log\.destroy\(\)/);
  assert.doesNotMatch(source, /console\.(log|debug|error).*value/);
});
