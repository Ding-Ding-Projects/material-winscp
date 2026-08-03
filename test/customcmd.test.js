// customcmd.test.js — the custom-command pattern expansion.
//
// The expansion is a pure function, so this is a table: command in, string out.
// The expected values are what WinSCP itself produces, derived from
// vendor/winscp/source/core/FileMasks.cpp (TCustomCommand::Complete,
// TFileCustomCommand::PatternReplacement) and
// vendor/winscp/source/windows/GUITools.cpp (TLocalCustomCommand).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const cc = require('../design/main/customcmd');

/** The session a remote command expands against. */
const DATA = {
  protocol: 'sftp',
  hostName: 'files.example.com',
  portNumber: 2222,
  userName: 'martin',
  password: 'hunter2',
  publicKeyFile: 'C:\\keys\\id.ppk',
  name: 'Work server',
};

/** The per-invocation file context. */
const CTX = {
  fileName: 'report.txt',
  fileList: '"a.txt" "b.txt"',
  remotePath: '/var/www',
  localPath: 'C:\\Users\\martin\\Downloads\\',
  localFileName: 'C:\\Temp\\report.txt',
};

const expand = (cmd, opts) => cc.expand(cmd, DATA, CTX, opts);

// ------------------------------------------------------------------ basics

test('the bare ! pattern expands to the file name', () => {
  assert.equal(expand('cat !'), 'cat report.txt');
});

test('a trailing bare ! is still the file name', () => {
  assert.equal(expand('cat !'), 'cat report.txt');
  assert.equal(expand('!'), 'report.txt');
});

test('!! is a literal exclamation mark and does not become a pattern', () => {
  assert.equal(expand('echo hello!!'), 'echo hello!');
  assert.equal(expand('echo !!!!'), 'echo !!');
});

test('text with no patterns passes through untouched', () => {
  assert.equal(expand('ls -la /var/log'), 'ls -la /var/log');
});

test('an empty command expands to an empty string', () => {
  assert.equal(expand(''), '');
});

// ------------------------------------------------------------ file patterns

test('!& is the file list and is never re-quoted', () => {
  // The list arrives already delimited, so DelimitStr must not run on it.
  assert.equal(expand('tar -czf out.tgz !&'), 'tar -czf out.tgz "a.txt" "b.txt"');
});

test('!/ is the remote path and always carries a trailing slash', () => {
  assert.equal(expand('ls !/'), 'ls /var/www/');
  assert.equal(cc.expand('ls !/', DATA, { ...CTX, remotePath: '/var/www/' }), 'ls /var/www/');
  assert.equal(cc.expand('ls !/', DATA, { ...CTX, remotePath: '/' }), 'ls /');
});

test('!@ is the host name and is case-sensitive punctuation', () => {
  assert.equal(expand('ping !@'), 'ping files.example.com');
});

test('!U is the user name, in either case', () => {
  assert.equal(expand('id !U'), 'id martin');
  assert.equal(expand('id !u'), 'id martin');
});

test('!# is the port number', () => {
  assert.equal(expand('nc !@ !#'), 'nc files.example.com 2222');
});

test('!K is the private key file', () => {
  assert.equal(expand('ssh -i !K'), 'ssh -i C:\\\\keys\\\\id.ppk');
});

test('!N is the session name', () => {
  assert.equal(expand('echo !N'), 'echo Work server');
});

test('!S is the session URL without the password', () => {
  const out = expand('echo !S');
  assert.equal(out, 'echo sftp://martin@files.example.com:2222/');
  assert.ok(!out.includes('hunter2'), 'the session URL must not leak the password');
});

test('!E is the session URL including the password', () => {
  assert.equal(expand('echo !E'), 'echo sftp://martin:hunter2@files.example.com:2222/');
});

test('a default port is omitted from the session URL', () => {
  const d = { ...DATA, portNumber: 22 };
  assert.equal(cc.expand('echo !S', d, CTX), 'echo sftp://martin@files.example.com/');
});

test('!P expands to the password (which is why it is never logged)', () => {
  assert.equal(expand('login !U !P'), 'login martin hunter2');
  // The logging helper is the thing that keeps it out of the record.
  assert.equal(cc.redactForLog('login martin hunter2', ['hunter2']), 'login martin ***');
});

test('an unknown letter after ! is the file, and the letter stays literal', () => {
  // PatternLen returns 1 for anything outside the two-character set, so `!z`
  // is the file pattern followed by the text `z`.
  assert.equal(expand('run !z'), 'run report.txtz');
});

// --------------------------------------------------------------- delimiting

test('a replacement is escaped for the remote shell', () => {
  const out = cc.expand('cat !', DATA, { ...CTX, fileName: 'a $b\\c.txt' });
  assert.equal(out, 'cat a \\$b\\\\c.txt');
});

test('a replacement inside double quotes is escaped for double quotes', () => {
  const out = cc.expand('cat "!"', DATA, { ...CTX, fileName: 'a"b`c$d' });
  assert.equal(out, 'cat "a\\"b\\`c\\$d"');
});

test('a replacement inside single quotes is not escaped', () => {
  const out = cc.expand("cat '!'", DATA, { ...CTX, fileName: 'a$b\\c' });
  assert.equal(out, "cat 'a$b\\c'");
});

test('a file name starting with a dash is guarded with ./', () => {
  // Otherwise the remote shell reads the file name as a switch.
  const out = cc.expand('rm !', DATA, { ...CTX, fileName: '-rf' });
  assert.equal(out, 'rm ./-rf');
});

test('mismatched surrounding quotes do not count as quoting', () => {
  const out = cc.expand('cat "!\'', DATA, { ...CTX, fileName: 'a"b' });
  // NoQuote escaping: `$` and `\` only, so the embedded quote survives as-is.
  assert.equal(out, 'cat "a"b\'');
});

// ----------------------------------------------------------- local commands

const LOCAL = { local: true };

test('!\\ is the local path with its trailing separator removed', () => {
  // A trailing backslash escapes the closing quote in PowerShell.
  assert.equal(expand('explorer "!\\"', LOCAL), 'explorer "C:\\Users\\martin\\Downloads"');
});

test('!^! is the downloaded local file name', () => {
  assert.equal(expand('notepad "!^!"', LOCAL), 'notepad "C:\\Temp\\report.txt"');
});

test('local commands are never shell-escaped', () => {
  const out = cc.expand('open !', DATA, { ...CTX, fileName: 'C:\\a $b\\c.txt' }, LOCAL);
  assert.equal(out, 'open C:\\a $b\\c.txt');
});

test('a local command still resolves the session patterns', () => {
  assert.equal(expand('echo !@ !U', LOCAL), 'echo files.example.com martin');
});

test('!\\ and !^! are NOT patterns in a remote command', () => {
  // The remote rule set has no local patterns, so `!\` is the file pattern
  // followed by a literal backslash — matching TFileCustomCommand exactly.
  // The backslash is TEXT, so it is not escaped; only replacements are.
  assert.equal(expand('cat !\\'), 'cat report.txt\\');
  assert.equal(expand('notepad "!^!"'), 'notepad "report.txt^report.txt"');
});

// ------------------------------------------------------------------ prompts

test('an interactive prompt is discovered with its text and default', () => {
  const prompts = cc.collectPrompts('tar -czf "!?&Archive name:?archive.tgz!" !&');
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].prompt, '&Archive name:');
  assert.equal(prompts[0].default, 'archive.tgz');
  assert.equal(prompts[0].delimit, true);
});

test('a prompt with no default has an empty default', () => {
  const prompts = cc.collectPrompts('grep "!?&Text to find:?!" !&');
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].prompt, '&Text to find:');
  assert.equal(prompts[0].default, '');
});

test('an unanswered prompt falls back to its default', () => {
  assert.equal(expand('tar -czf "!?Name?archive.tgz!" !&'),
    'tar -czf "archive.tgz" "a.txt" "b.txt"');
});

test('an answered prompt is substituted', () => {
  const out = cc.expand('tar -czf "!?Name?archive.tgz!" !&', DATA, CTX, { answers: { 0: 'backup.tgz' } });
  assert.equal(out, 'tar -czf "backup.tgz" "a.txt" "b.txt"');
});

test('a prompt answer can also be keyed by its prompt text', () => {
  const out = cc.expand('grep "!?Text?!" !&', DATA, CTX, { answers: { Text: 'needle' } });
  assert.equal(out, 'grep "needle" "a.txt" "b.txt"');
});

test('a prompt answer containing ! cannot inject a new pattern', () => {
  // This is exactly why the interactive pass escapes what it substitutes.
  const out = cc.expand('echo "!?Text?!"', DATA, CTX, { answers: { 0: 'a!b' } });
  assert.equal(out, 'echo "a!b"');
});

test('a prompt answer is quoted for the shell like any other replacement', () => {
  const out = cc.expand('echo "!?Text?!"', DATA, CTX, { answers: { 0: 'a"b' } });
  assert.equal(out, 'echo "a\\"b"');
});

test('the \\? form suppresses quoting of the answer', () => {
  const out = cc.expand('echo !?Flags\\?-v!', DATA, CTX, {});
  assert.equal(out, 'echo -v');          // no ./ guard, because it is not delimited
});

test('several prompts are answered by index, in order', () => {
  const cmd = 'cp !?From?a! !?To?b!';
  assert.equal(cc.collectPrompts(cmd).length, 2);
  assert.equal(cc.expand(cmd, DATA, CTX, { answers: { 0: 'x', 1: 'y' } }), 'cp x y');
});

// ------------------------------------------------------ embedded execution

test('an embedded !`command` is discovered', () => {
  const execs = cc.collectExecs('echo !`hostname`');
  assert.equal(execs.length, 1);
  assert.equal(execs[0].command, 'hostname');
});

test('an embedded command result is spliced in unquoted', () => {
  const out = cc.expand('echo !`hostname`', DATA, CTX, { execResults: { 0: 'build-01' } });
  assert.equal(out, 'echo build-01');
});

test('an unresolved embedded command expands to nothing', () => {
  assert.equal(expand('echo !`hostname`'), 'echo ');
});

// ---------------------------------------------------------------- the real
// default commands shipped in config.js, end to end.

test('the shipped Touch command expands', () => {
  assert.equal(expand('touch "!"'), 'touch "report.txt"');
});

test('the shipped Execute command expands', () => {
  assert.equal(expand('"./!"'), '"./report.txt"');
});

test('the shipped Tar/GZip command expands', () => {
  assert.equal(cc.expand('tar -czf "!?&Archive name:?archive.tgz!" !&', DATA, CTX, { answers: { 0: 'site.tgz' } }),
    'tar -czf "site.tgz" "a.txt" "b.txt"');
});

test('the shipped UnTar/GZip command expands', () => {
  assert.equal(cc.expand('tar -xzf "!" -C "!?&Extract to:?.!"', DATA, CTX, {}),
    'tar -xzf "report.txt" -C "."');
});

test('the shipped Checksum command expands', () => {
  assert.equal(expand('sha256sum !&'), 'sha256sum "a.txt" "b.txt"');
});

// ---------------------------------------------------------------- predicates

test('hasPatterns distinguishes a plain command from one with patterns', () => {
  assert.equal(cc.hasPatterns('ls -la'), false);
  assert.equal(cc.hasPatterns('ls !'), true);
  assert.equal(cc.hasPatterns('echo !@'), true);
});

test('isFileListCommand detects !&', () => {
  assert.equal(cc.isFileListCommand('sha256sum !&'), true);
  assert.equal(cc.isFileListCommand('sha256sum !'), false);
});

test('isFileCommand detects the per-file patterns', () => {
  assert.equal(cc.isFileCommand('touch "!"'), true);
  assert.equal(cc.isFileCommand('sha256sum !&'), true);
  assert.equal(cc.isFileCommand('echo !@'), false);
});

test('isSiteCommand is a command that needs no selection', () => {
  assert.equal(cc.isSiteCommand('echo !@ !U'), true);
  assert.equal(cc.isSiteCommand('touch "!"'), false);
  assert.equal(cc.isSiteCommand('ls -la'), false);
});

test('isFileCommand sees the local-only !^! pattern', () => {
  assert.equal(cc.isFileCommand('notepad "!^!"', { local: true }), true);
});

// --------------------------------------------------------------- validation

test('mixing ! and !& is rejected, as WinSCP rejects it', () => {
  assert.throws(() => cc.validate('cp ! !&'), /cannot be combined/);
});

test('a command using only one of the two validates', () => {
  assert.equal(cc.validate('sha256sum !&'), true);
  assert.equal(cc.validate('touch "!"'), true);
  assert.equal(cc.validate('ls -la'), true);
});

test('validation ignores interactive patterns before checking file iteration', () => {
  assert.equal(cc.validate('grep "!?Text:?default!" !&'), true);
  assert.equal(cc.validate('echo !`date` !&'), true);
  assert.throws(() => cc.validate('echo !?Text?! ! !&'), /cannot be combined/);
});

test('an unterminated prompt pattern is an error, not a silent truncation', () => {
  assert.throws(() => cc.collectPrompts('echo !?Name?default'), /Unterminated/);
});

test('an unterminated embedded command is an error', () => {
  assert.throws(() => cc.collectExecs('echo !`hostname'), /Unterminated/);
});

// -------------------------------------------------------------- primitives

test('delimitStr escapes the right characters per quoting context', () => {
  assert.equal(cc.delimitStr('a$b', '\0'), 'a\\$b');
  assert.equal(cc.delimitStr('a\\b', '\0'), 'a\\\\b');
  assert.equal(cc.delimitStr('a"b', '"'), 'a\\"b');
  assert.equal(cc.delimitStr('a`b', '"'), 'a\\`b');
  assert.equal(cc.delimitStr('a$b', "'"), 'a$b');
  assert.equal(cc.delimitStr('-x', '\0'), './-x');
});

test('escape doubles every exclamation mark', () => {
  assert.equal(cc.escape('a!b!!c'), 'a!!b!!!!c');
});

test('fileListOf quotes each remote name and leaves local names alone', () => {
  assert.equal(cc.fileListOf(['a b.txt', 'c.txt']), '"a b.txt" "c.txt"');
  assert.equal(cc.fileListOf(['C:\\a b.txt'], { local: true }), 'C:\\a b.txt');
});

test('sessionUrl encodes a user name that needs it', () => {
  assert.equal(cc.sessionUrl({ protocol: 'sftp', hostName: 'h', portNumber: 22, userName: 'a@b' }),
    'sftp://a%40b@h/');
});

test('tokenize reports the position of every pattern', () => {
  const toks = cc.tokenize('cp ! !&');
  assert.deepEqual(toks.map((t) => [t.kind, t.text]), [
    ['text', 'cp '], ['pattern', '!'], ['text', ' '], ['pattern', '!&'],
  ]);
  assert.equal(toks[1].index, 3);
  assert.equal(toks[3].index, 5);
});

test('a missing session field expands to an empty string, not "undefined"', () => {
  const out = cc.expand('echo !U/!N', { protocol: 'sftp', hostName: 'h' }, CTX);
  assert.equal(out, 'echo /h');
});
