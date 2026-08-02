// console.test.js — the console front-end (`winscp.com`).
//
// The tests are weighted towards the things that make an unattended run behave
// or misbehave: what a prompt answers when nobody is there to answer it, what
// happens to a progress line when the output is a file instead of a terminal,
// what the exit code is for each kind of failure, and whether the bytes of a
// `/stdout=` transfer come out framed correctly. Every one of them drives the
// real ConsoleHost against a real ExternalConsole over a real CommChannel; the
// end-to-end cases drive the real scripting engine through both.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { Readable } = require('stream');

const C = require('../design/main/console');

const {
  PROTOCOL, EVENT, STDINOUT, FILE_TYPE, LIMITS, RESULT, MSG,
  ConsoleError, makeInstanceName, commObjectNames, formatProductVersion,
  splitCommandLine, deriveChildPath, findConsoleChild, quoteChildArgument,
  buildChildCommandLine, buildChildArgv, parseStdInOutMode, ByteSource,
  KeySource, decodeKeys, createCommStruct, fitString, CommChannel, ConsoleHost,
  fileTypeOf, ExternalConsole, trimNewLine, runConsoleHost, createConsolePair,
  runConsoleFrontEnd, installControlHandler,
} = C;

const { Options } = require('../design/main/script');

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Let real time pass between two steps of a test.
 *
 * Deliberately **not** `unref()`ed. A test that awaits an unref'd timer is
 * awaiting the one thing that cannot keep the process alive, so when the timer
 * is the only work left the loop drains and the awaited promise is simply
 * abandoned. Node 22's runner reports that honestly — `cancelledByParent:
 * Promise resolution is still pending but the event loop has already resolved`
 * — and cancels every remaining test in the file. Node 26 happens to keep a
 * ref'd handle alive for the run and papers over it, which is how a whole file
 * can look green on one major and lose half its tests on the one CI pins.
 */
function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** A write sink that records exactly the bytes it was given. */
class FakeStream {
  constructor(isTTY = false) {
    this.chunks = [];
    this.isTTY = isTTY;
    this.flushes = 0;
  }

  write(b) { this.chunks.push(Buffer.isBuffer(b) ? Buffer.from(b) : Buffer.from(String(b))); return true; }

  flush() { this.flushes++; }

  get buffer() { return Buffer.concat(this.chunks); }

  get text() { return this.buffer.toString('utf8'); }
}

function makeOptions(argv) {
  const o = new Options();
  for (const a of argv) o.add(a);
  return o;
}

/**
 * A matched host/client pair with everything injectable. `outputType` and
 * `inputType` are given explicitly because the whole point of the tests is to
 * exercise each of the three file types deliberately.
 */
function makePair(options = {}) {
  const stdout = options.stdout || new FakeStream(options.outputType === FILE_TYPE.CHAR);
  const stderr = options.stderr || new FakeStream();
  const host = new ConsoleHost({
    stdout,
    stderr,
    stdin: options.stdin === undefined ? '' : options.stdin,
    keys: options.keys || null,
    outputType: options.outputType === undefined ? FILE_TYPE.PIPE : options.outputType,
    inputType: options.inputType === undefined ? FILE_TYPE.PIPE : options.inputType,
    sleep: options.sleep,
  });
  const channel = new CommChannel({ instance: '_1_1' });
  host.attach(channel);
  const client = new ExternalConsole(channel, {
    noInteractiveInput: !!options.noInteractiveInput,
    stdOut: options.stdOut || STDINOUT.OFF,
    stdIn: options.stdIn || STDINOUT.OFF,
    sendTimeout: options.sendTimeout,
    logProtocol: options.logProtocol,
    now: options.now,
  });
  if (options.init !== false) client.init();
  return { stdout, stderr, host, channel, client };
}

// ---------------------------------------------------------------------------
// the protocol handshake
// ---------------------------------------------------------------------------

test('the protocol version constants match Console.h', () => {
  assert.strictEqual(PROTOCOL.CURRENT_VERSION, 0x000A);
  assert.strictEqual(PROTOCOL.CURRENT_VERSION_CONFIRMED, 0x010A);
});

test('a fresh comm struct starts at the unconfirmed version with no event', () => {
  const s = createCommStruct();
  assert.strictEqual(s.version, PROTOCOL.CURRENT_VERSION);
  assert.strictEqual(s.event, EVENT.NONE);
});

test('the client confirms the version on construction', () => {
  const channel = new CommChannel({ instance: '_1_1' });
  new ConsoleHost({ stdout: new FakeStream() }).attach(channel);
  // eslint-disable-next-line no-new
  new ExternalConsole(channel, {});
  assert.strictEqual(channel.struct.version, PROTOCOL.CURRENT_VERSION_CONFIRMED);
});

test('the client refuses a front-end speaking another version, naming it', () => {
  const channel = new CommChannel({ instance: '_1_1' });
  channel.struct.version = 0x0009;
  assert.throws(() => new ExternalConsole(channel, {}),
    (e) => e.message === MSG.EXTERNAL_CONSOLE_INCOMPATIBLE(9));
});

test('the front-end refuses an event whose version was never confirmed', () => {
  const host = new ConsoleHost({ stdout: new FakeStream(), outputType: FILE_TYPE.PIPE });
  const struct = createCommStruct();
  struct.event = EVENT.PRINT;
  assert.throws(() => host.processEvent(struct),
    (e) => e instanceof ConsoleError && e.message === MSG.INCOMPATIBLE_VERSION
      && e.result === RESULT.PROCESSING_ERROR);
});

test('the front-end refuses NONE and PROGRESS as unknown events', () => {
  const host = new ConsoleHost({ stdout: new FakeStream(), outputType: FILE_TYPE.PIPE });
  for (const event of [EVENT.NONE, EVENT.PROGRESS]) {
    const struct = createCommStruct();
    struct.version = PROTOCOL.CURRENT_VERSION_CONFIRMED;
    struct.event = event;
    assert.throws(() => host.processEvent(struct),
      (e) => e.message === MSG.UNKNOWN_EVENT && e.result === RESULT.PROCESSING_ERROR,
      `${event} must be refused`);
  }
});

test('PROGRESS never reaches the front-end because WantsProgress comes back false', () => {
  const { client } = makePair();
  assert.strictEqual(client.wantsProgress, false);
  assert.strictEqual(client.hasFlag('wantsProgress'), false);
});

test('a client that ignores the negotiation and sends PROGRESS anyway is refused', async () => {
  const { client } = makePair();
  await assert.rejects(() => client.progress({ fileName: 'a', side: 'remote' }),
    (e) => e.message === MSG.UNKNOWN_EVENT);
});

// ---------------------------------------------------------------------------
// instance naming
// ---------------------------------------------------------------------------

test('the instance name is _pid_random', () => {
  assert.strictEqual(makeInstanceName(4321, () => 7), '_4321_7');
});

test('a taken instance name is retried until a free one is found', () => {
  const tried = [];
  let n = 0;
  const name = makeInstanceName(10, () => { n += 1; return n; }, (candidate) => {
    tried.push(candidate);
    return n < 3;
  });
  assert.strictEqual(name, '_10_3');
  assert.deepStrictEqual(tried, [
    'WinSCPConsoleEventRequest_10_1',
    'WinSCPConsoleEventRequest_10_2',
    'WinSCPConsoleEventRequest_10_3',
  ]);
});

test('a permanently taken name gives up rather than spinning', () => {
  assert.throws(() => makeInstanceName(1, () => 1, () => true),
    (e) => e.message === MSG.UNIQUE_NAME && e.result === RESULT.GLOBAL_ERROR);
});

test('the four kernel object names carry the documented prefixes', () => {
  assert.deepStrictEqual(commObjectNames('_5_5'), {
    mapping: 'WinSCPConsoleMapping_5_5',
    request: 'WinSCPConsoleEventRequest_5_5',
    response: 'WinSCPConsoleEventResponse_5_5',
    cancel: 'WinSCPConsoleEventCancel_5_5',
    job: 'WinSCPConsoleJob_5_5',
  });
});

// ---------------------------------------------------------------------------
// the child command line
// ---------------------------------------------------------------------------

test('the product version is three components and refuses anything else', () => {
  assert.strictEqual(formatProductVersion('6.3.5'), '6.3.5');
  assert.strictEqual(formatProductVersion('0.1.0'), '0.1.0');
  assert.strictEqual(formatProductVersion('6.3.5.1234'), '6.3.5');
  for (const bad of ['', 'six', '6.3', undefined, '100.0.0', '1.200.0', '1.0.100']) {
    assert.throws(() => formatProductVersion(bad),
      (e) => e.message === MSG.PRODUCT_VERSION && e.result === RESULT.GLOBAL_ERROR,
      `${bad} must be refused`);
  }
});

test('the child path drops a -com suffix, case-insensitively', () => {
  assert.strictEqual(deriveChildPath('C:\\Program Files\\WinSCP\\winscp-com.exe'),
    'C:\\Program Files\\WinSCP\\winscp.exe');
  assert.strictEqual(deriveChildPath('C:\\bin\\WINSCP-COM.EXE'), 'C:\\bin\\WINSCP.exe');
  assert.strictEqual(deriveChildPath('winscp-com'), 'winscp.exe');
  assert.strictEqual(deriveChildPath('/opt/winscp/winscp-com'), '/opt/winscp/winscp.exe');
});

test('a name that merely ends in com keeps it', () => {
  assert.strictEqual(deriveChildPath('C:\\bin\\telecom.exe'), 'C:\\bin\\telecom.exe');
});

test('no executable name at all is refused rather than guessed', () => {
  assert.throws(() => deriveChildPath(''),
    (e) => e.message === MSG.MODULE_NAME && e.result === RESULT.GLOBAL_ERROR);
});

test('/consolechild= overrides the derived path and is matched on either mark', () => {
  assert.deepStrictEqual(findConsoleChild(['a.exe', '/consolechild=D:\\x.exe']),
    { childPath: 'D:\\x.exe', skipParam: 1 });
  assert.deepStrictEqual(findConsoleChild(['a.exe', '-CONSOLECHILD=D:\\x.exe']),
    { childPath: 'D:\\x.exe', skipParam: 1 });
});

test('a switch that only starts like consolechild is not one', () => {
  // The character after the name must be '=', so these are ordinary arguments
  // and must reach the child untouched.
  assert.deepStrictEqual(findConsoleChild(['a.exe', '/consolechildish=x']),
    { childPath: '', skipParam: -1 });
  assert.deepStrictEqual(findConsoleChild(['a.exe', '/consolechild']),
    { childPath: '', skipParam: -1 });
  assert.deepStrictEqual(findConsoleChild(['a.exe', 'consolechild=x']),
    { childPath: '', skipParam: -1 });
});

test('an argument is requoted with its inner quotes doubled', () => {
  assert.strictEqual(quoteChildArgument('plain'), '"plain"');
  assert.strictEqual(quoteChildArgument('he said "hi"'), '"he said ""hi"""');
  assert.strictEqual(quoteChildArgument(''), '""');
});

test('the child command line carries /console and /consoleinstance and every parameter', () => {
  const { childPath, parameters } = buildChildCommandLine(
    '"C:\\bin\\winscp-com.exe" /script=a.txt /parameter "he said ""hi"""',
    '_100_7', { productVersion: '6.3.5' });
  assert.strictEqual(childPath, 'C:\\bin\\winscp.exe');
  assert.strictEqual(parameters,
    '"C:\\bin\\winscp.exe" /console=6.3.5 /consoleinstance=_100_7 '
    + '"/script=a.txt" "/parameter" "he said ""hi""" ');
});

test('the consolechild switch is the one argument the child never sees', () => {
  const { childPath, parameters } = buildChildCommandLine(
    '"C:\\bin\\winscp-com.exe" -consolechild=D:\\alt.exe /command "exit"',
    '_9_1', { productVersion: '6.3.5' });
  assert.strictEqual(childPath, 'D:\\alt.exe');
  assert.ok(!parameters.includes('consolechild'), parameters);
  assert.ok(parameters.includes('"/command" "exit"'), parameters);
});

test('the argv form skips the same argument and no other', () => {
  assert.deepStrictEqual(
    buildChildArgv(['/script=a.txt', '/consolechild=D:\\w.exe', '/parameter', 'x'],
      '_1_2', { productVersion: '6.3.5' }),
    ['/console=6.3.5', '/consoleinstance=_1_2', '/script=a.txt', '/parameter', 'x']);
});

test('the argv form keeps argument zero when there is no consolechild switch', () => {
  // The C++ uses index 0 as its "not found" marker because index 0 is the
  // executable; an argv array has no executable, so the first real argument
  // must survive.
  assert.deepStrictEqual(
    buildChildArgv(['/script=a.txt', 'exit'], '_1_2', { productVersion: '6.3.5' }),
    ['/console=6.3.5', '/consoleinstance=_1_2', '/script=a.txt', 'exit']);
});

test('the command line is tokenized with the same rules as the script engine', () => {
  assert.deepStrictEqual(splitCommandLine('a "b c" d""e'), ['a', 'b c', 'd"e']);
  assert.deepStrictEqual(splitCommandLine('   '), []);
});

// ---------------------------------------------------------------------------
// /stdout= and /stdin=
// ---------------------------------------------------------------------------

test('/stdout with no value means binary, and chunked is accepted', () => {
  assert.strictEqual(parseStdInOutMode(makeOptions(['/stdout']), 'stdout', true), STDINOUT.BINARY);
  assert.strictEqual(parseStdInOutMode(makeOptions(['/stdout=binary']), 'stdout', true), STDINOUT.BINARY);
  assert.strictEqual(parseStdInOutMode(makeOptions(['/stdout=CHUNKED']), 'stdout', true), STDINOUT.CHUNKED);
  assert.strictEqual(parseStdInOutMode(makeOptions([]), 'stdout', true), STDINOUT.OFF);
});

test('/stdin=chunked is refused — there is no framing to parse on the way in', () => {
  assert.throws(() => parseStdInOutMode(makeOptions(['/stdin=chunked']), 'stdin', false),
    (e) => e.message === MSG.VALUE_UNKNOWN('chunked', 'stdin'));
});

test('an unknown stream mode is refused rather than treated as binary', () => {
  assert.throws(() => parseStdInOutMode(makeOptions(['/stdout=base64']), 'stdout', true),
    (e) => e.message === MSG.VALUE_UNKNOWN('base64', 'stdout'));
});

// ---------------------------------------------------------------------------
// printing to a terminal
// ---------------------------------------------------------------------------

test('on a console, a from-beginning print rewrites the line with a carriage return', () => {
  const { stdout, client } = makePair({ outputType: FILE_TYPE.CHAR });
  client.print('a 10%', true);
  client.print('a 90%', true);
  assert.strictEqual(stdout.text, '\ra 10%\ra 90%');
});

test('on a console, newlines are written as-is', () => {
  const { stdout, client } = makePair({ outputType: FILE_TYPE.CHAR });
  client.print('one\ntwo\n');
  assert.strictEqual(stdout.text, 'one\ntwo\n');
});

test('redirected output gets CRLF line endings', () => {
  const { stdout, client } = makePair({ outputType: FILE_TYPE.DISK });
  client.print('one\ntwo\n');
  assert.strictEqual(stdout.text, 'one\r\ntwo\r\n');
});

test('a redirected progress line is held, and only the last one is committed', () => {
  const { stdout, client } = makePair({ outputType: FILE_TYPE.DISK });
  client.print('10%', true);
  client.print('50%', true);
  client.print('90%', true);
  // Nothing has been written yet: there is no cursor to take a line back with,
  // so a redirected log records the final state, not every intermediate one.
  assert.strictEqual(stdout.text, '');
  client.print('done\n');
  assert.strictEqual(stdout.text, '90%done\r\n');
});

test('a from-beginning print that starts with a newline commits and re-holds', () => {
  const { stdout, client } = makePair({ outputType: FILE_TYPE.PIPE });
  client.print('10%', true);
  client.print('\nnext line', true);
  // The leading newline is the "the previous line is finished" signal: the held
  // line and the newline are written, and the remainder is held in turn.
  assert.strictEqual(stdout.text, '10%\r\n');
  client.print('');
  assert.strictEqual(stdout.text, '10%\r\nnext line');
});

test('the end-of-run empty print is what flushes the last held progress line', () => {
  const { stdout, host, client } = makePair({ outputType: FILE_TYPE.DISK });
  client.print('99%', true);
  assert.strictEqual(stdout.text, '');
  host.print(false, '');
  assert.strictEqual(stdout.text, '99%');
});

test('a redirected write is flushed, a console write is not', () => {
  const disk = makePair({ outputType: FILE_TYPE.DISK });
  disk.client.print('x\n');
  assert.ok(disk.stdout.flushes > 0);

  const char = makePair({ outputType: FILE_TYPE.CHAR });
  char.client.print('x\n');
  assert.strictEqual(char.stdout.flushes, 0);
});

test('a print longer than the message field is chunked, and only the first chunk rewrites', () => {
  const seen = [];
  const channel = new CommChannel({ instance: '_1_1' });
  channel.setHandler((s) => {
    seen.push({ message: s.print.message, fromBeginning: s.print.fromBeginning });
  });
  channel.struct.version = PROTOCOL.CURRENT_VERSION;
  const client = new ExternalConsole(channel, {});
  const text = 'x'.repeat(LIMITS.PRINT_MESSAGE * 2);
  client.print(text, true);

  assert.strictEqual(seen.length, 3);
  assert.strictEqual(seen[0].message.length, LIMITS.PRINT_MESSAGE - 1);
  assert.strictEqual(seen[0].fromBeginning, true);
  assert.strictEqual(seen[1].fromBeginning, false, 'a continuation must append, not rewrite');
  assert.strictEqual(seen[2].fromBeginning, false);
  assert.strictEqual(seen.map((s) => s.message).join(''), text);
});

test('an empty print still sends one event — that is how a bare newline gets across', () => {
  let events = 0;
  const channel = new CommChannel({ instance: '_1_1' });
  channel.setHandler(() => { events++; });
  const client = new ExternalConsole(channel, {});
  client.print('');
  assert.strictEqual(events, 1);
});

test('printLine appends the newline', () => {
  const { stdout, client } = makePair({ outputType: FILE_TYPE.CHAR });
  client.printLine('hello');
  assert.strictEqual(stdout.text, 'hello\n');
});

test('an error print goes to the same stream unless stdout carries data', () => {
  const plain = makePair({ outputType: FILE_TYPE.CHAR });
  plain.client.print('boom\n', false, true);
  assert.strictEqual(plain.stdout.text, 'boom\n');
  assert.strictEqual(plain.stderr.text, '');

  // With /stdout=binary the child asks for UseStdErr, so every message moves
  // off the stream the file data is on.
  const streamed = makePair({ outputType: FILE_TYPE.PIPE, stdOut: STDINOUT.BINARY });
  streamed.client.print('boom\n', false, true);
  assert.strictEqual(streamed.stdout.text, '');
  assert.strictEqual(streamed.stderr.text, 'boom\r\n');
});

// ---------------------------------------------------------------------------
// init negotiation
// ---------------------------------------------------------------------------

test('the client derives its flags from the file types the front-end reports', () => {
  const term = makePair({ outputType: FILE_TYPE.CHAR, inputType: FILE_TYPE.CHAR });
  assert.strictEqual(term.client.limitedOutput, true);
  assert.strictEqual(term.client.liveOutput, true);
  assert.strictEqual(term.client.interactive, true);
  assert.strictEqual(term.client.pipeOutput, false);

  const piped = makePair({ outputType: FILE_TYPE.PIPE, inputType: FILE_TYPE.PIPE });
  assert.strictEqual(piped.client.limitedOutput, false);
  assert.strictEqual(piped.client.liveOutput, false);
  assert.strictEqual(piped.client.interactive, false);
  assert.strictEqual(piped.client.pipeOutput, true);

  const toFile = makePair({ outputType: FILE_TYPE.DISK, inputType: FILE_TYPE.CHAR });
  assert.strictEqual(toFile.client.limitedOutput, false);
  assert.strictEqual(toFile.client.liveOutput, false);
  // Only the output was redirected — the keyboard is still there.
  assert.strictEqual(toFile.client.interactive, true);
});

test('the console flag names ConsoleRunner asks for are all answered', () => {
  const { client } = makePair({
    outputType: FILE_TYPE.CHAR,
    inputType: FILE_TYPE.CHAR,
    noInteractiveInput: true,
    stdOut: STDINOUT.CHUNKED,
    stdIn: STDINOUT.BINARY,
  });
  assert.strictEqual(client.hasFlag('limitedOutput'), true);
  assert.strictEqual(client.hasFlag('liveOutput'), true);
  assert.strictEqual(client.hasFlag('interactive'), true);
  assert.strictEqual(client.hasFlag('noInteractiveInput'), true);
  assert.strictEqual(client.hasFlag('commandLineOnly'), true);
  assert.strictEqual(client.hasFlag('stdOut'), true);
  assert.strictEqual(client.hasFlag('stdIn'), true);
  assert.strictEqual(client.hasFlag('nonsense'), false);
});

test('the front-end answers the init event with what it actually has', () => {
  const { channel, client } = makePair({ outputType: FILE_TYPE.DISK, inputType: FILE_TYPE.PIPE });
  void client;
  assert.strictEqual(channel.struct.init.outputType, FILE_TYPE.DISK);
  assert.strictEqual(channel.struct.init.inputType, FILE_TYPE.PIPE);
  assert.strictEqual(channel.struct.init.wantsProgress, false);
});

test('fileTypeOf recognizes a TTY and falls back to pipe for anything unrecognizable', () => {
  assert.strictEqual(fileTypeOf(null), FILE_TYPE.UNKNOWN);
  assert.strictEqual(fileTypeOf({ isTTY: true }), FILE_TYPE.CHAR);
  assert.strictEqual(fileTypeOf({ write() {} }), FILE_TYPE.PIPE);
});

// ---------------------------------------------------------------------------
// the title
// ---------------------------------------------------------------------------

test('the title is set on a console and never written into a redirected log', () => {
  const term = makePair({ outputType: FILE_TYPE.CHAR });
  term.client.setTitle('site - WinSCP');
  assert.ok(term.stdout.text.includes('\u001b]2;site - WinSCP\u0007'), term.stdout.text);
  assert.deepStrictEqual(term.host.titles, ['site - WinSCP']);

  const file = makePair({ outputType: FILE_TYPE.DISK });
  file.client.setTitle('site - WinSCP');
  assert.strictEqual(file.stdout.text, '');
  assert.deepStrictEqual(file.host.titles, ['site - WinSCP'], 'still recorded, just not written');
});

test('an over-long title is truncated rather than refused', () => {
  const { host, client } = makePair({ outputType: FILE_TYPE.CHAR });
  client.setTitle('t'.repeat(LIMITS.TITLE * 2));
  assert.strictEqual(host.titles[0].length, LIMITS.TITLE - 1);
});

test('the title is pushed once and restored at the end of the run', () => {
  const { stdout, host, client } = makePair({ outputType: FILE_TYPE.CHAR });
  client.setTitle('one');
  client.setTitle('two');
  assert.strictEqual(stdout.text.split('\u001b[22;2t').length - 1, 1, 'pushed exactly once');
  host.restoreTitle();
  assert.ok(stdout.text.endsWith('\u001b[23;2t'));
  host.restoreTitle();
  assert.strictEqual(stdout.text.split('\u001b[23;2t').length - 1, 1, 'restored exactly once');
});

// ---------------------------------------------------------------------------
// input — the prompt handling
// ---------------------------------------------------------------------------

test('redirected input reads a line, echoes it, and reports success', async () => {
  const { stdout, client } = makePair({
    outputType: FILE_TYPE.DISK, inputType: FILE_TYPE.PIPE, stdin: 'answer\nsecond\n',
  });
  assert.strictEqual(await client.input(true, 0), 'answer');
  // The echo is what makes a redirected transcript readable: it records what
  // the run was answered with.
  assert.strictEqual(stdout.text, 'answer\r\n');
  assert.strictEqual(await client.input(true, 0), 'second');
});

test('redirected input drops every carriage return, not only the trailing one', async () => {
  const { client } = makePair({
    inputType: FILE_TYPE.PIPE, stdin: 'a\rb\r\n',
  });
  assert.strictEqual(await client.input(true, 0), 'ab');
});

test('an empty redirected line is a real answer, not a failure', async () => {
  const { client } = makePair({ inputType: FILE_TYPE.PIPE, stdin: '\nx\n' });
  assert.strictEqual(await client.input(true, 0), '');
});

test('redirected input at end of file answers nothing at all', async () => {
  const { client } = makePair({ inputType: FILE_TYPE.PIPE, stdin: '' });
  // null is the abort signal: ConsoleRunner turns it into "no input available"
  // rather than an empty answer, which is what stops an unattended script from
  // confirming a destructive prompt by accident.
  assert.strictEqual(await client.input(true, 0), null);
});

test('redirected input without a trailing newline still returns the last line', async () => {
  const { client } = makePair({ inputType: FILE_TYPE.PIPE, stdin: 'tail' });
  assert.strictEqual(await client.input(true, 0), 'tail');
  assert.strictEqual(await client.input(true, 0), null);
});

test('redirected input decodes UTF-8', async () => {
  const { client } = makePair({ inputType: FILE_TYPE.PIPE, stdin: Buffer.from('蝦餃\n', 'utf8') });
  assert.strictEqual(await client.input(true, 0), '蝦餃');
});

test('a redirected line longer than the field is truncated, not overrun', async () => {
  const long = 'y'.repeat(LIMITS.INPUT_STR * 4);
  const { client } = makePair({ inputType: FILE_TYPE.PIPE, stdin: `${long}\n` });
  const value = await client.input(true, 0);
  assert.strictEqual(value.length, LIMITS.INPUT_STR - 1);
});

test('interactive input assembles keys into a line and echoes them', async () => {
  const keys = new KeySource(decodeKeys('yes\r'));
  const { stdout, client } = makePair({
    outputType: FILE_TYPE.CHAR, inputType: FILE_TYPE.CHAR, keys,
  });
  assert.strictEqual(await client.input(true, 0), 'yes');
  assert.strictEqual(stdout.text, 'yes\n');
});

test('a non-echoing prompt writes nothing but the closing newline', async () => {
  const keys = new KeySource(decodeKeys('hunter2\r'));
  const { stdout, client } = makePair({
    outputType: FILE_TYPE.CHAR, inputType: FILE_TYPE.CHAR, keys,
  });
  const answer = await client.input(false, 0);
  assert.strictEqual(answer, 'hunter2');
  assert.strictEqual(stdout.text, '\n', 'a password must never be echoed');
});

test('backspace removes a character and erases it on screen', async () => {
  const keys = new KeySource(decodeKeys('abc\u0008d\r'));
  const { stdout, client } = makePair({
    outputType: FILE_TYPE.CHAR, inputType: FILE_TYPE.CHAR, keys,
  });
  assert.strictEqual(await client.input(true, 0), 'abd');
  assert.ok(stdout.text.includes('\b \b'));
});

test('an empty interactive line is an answer; end of input is not', async () => {
  const empty = makePair({
    outputType: FILE_TYPE.CHAR,
    inputType: FILE_TYPE.CHAR,
    keys: new KeySource(decodeKeys('\r')),
  });
  assert.strictEqual(await empty.client.input(true, 0), '');

  const closed = makePair({
    outputType: FILE_TYPE.CHAR, inputType: FILE_TYPE.CHAR, keys: new KeySource(null),
  });
  assert.strictEqual(await closed.client.input(true, 0), null);
});

test('an interactive prompt with no keyboard at all fails rather than hangs', async () => {
  const { client } = makePair({ outputType: FILE_TYPE.CHAR, inputType: FILE_TYPE.CHAR });
  assert.strictEqual(await client.input(true, 0), null);
});

test('an idle interactive prompt times out and answers nothing', async () => {
  const keys = new KeySource([]);
  const { client } = makePair({
    outputType: FILE_TYPE.CHAR, inputType: FILE_TYPE.CHAR, keys,
  });
  assert.strictEqual(await client.input(true, 20), null);
});

test('typing resets the idle timer instead of cutting a slow answer short', async () => {
  const keys = new KeySource([]);
  const { client } = makePair({
    outputType: FILE_TYPE.CHAR, inputType: FILE_TYPE.CHAR, keys,
  });
  const pending = client.input(true, 60);
  // Each keystroke arrives inside the window, so the total time comfortably
  // exceeds the timeout without it ever firing.
  for (const ch of 'slow') {
    await sleep(30);
    keys.push(decodeKeys(ch)[0]);
  }
  await sleep(30);
  keys.push(decodeKeys('\r')[0]);
  assert.strictEqual(await pending, 'slow');
});

// ---------------------------------------------------------------------------
// the timers a prompt is waiting on must keep the process alive
//
// Every one of these three waits is the *only* thing that can answer the
// front-end, so each has to hold the event loop open until it fires. An
// `unref()` on any of them turns "wait, then take the timeout answer" into
// "exit while nobody is looking": Node ends the process the moment the loop has
// nothing ref'd left, the awaited promise is abandoned, and `winscp.com`
// vanishes mid-prompt with a success code and no message.
//
// They run in a child process on purpose. Inside `node --test` the runner's own
// handles can hold the loop open by accident, which is exactly how this shipped
// — the file was green on Node 26 and cancelled 61 tests on the Node 22 that CI
// pins. A bare child has nothing else on its loop, so it answers the real
// question: would the shipped binary still be alive to take this branch?
// ---------------------------------------------------------------------------

/**
 * Run `body` in a plain `node -e` child with the console module already
 * required as `C`, and return what it wrote to fd 1. `fs.writeSync` rather than
 * `process.stdout.write` because a pipe write queued at exit can be dropped,
 * and an empty result is the thing being asserted on.
 */
function runDetached(body) {
  const { spawnSync } = require('child_process');
  const modulePath = require.resolve('../design/main/console');
  const source = `const fs = require('fs');\nconst C = require(${JSON.stringify(modulePath)});\n${body}`;
  const child = spawnSync(process.execPath, ['-e', source], { encoding: 'utf8' });
  assert.strictEqual(child.status, 0, `child failed: ${child.stderr}`);
  return child.stdout;
}

test('an idle prompt outlives the drained event loop and still times out', () => {
  // No key will ever arrive, so readKey's own timer is all that is left.
  const out = runDetached(`
    const keys = new C.KeySource([]);
    keys.readKey(25).then((k) => fs.writeSync(1, 'readKey=' + String(k)));
  `);
  assert.strictEqual(out, 'readKey=null',
    'an unref\'d idle timer lets the process exit with the prompt unanswered');
});

test('a timeouting prompt on redirected input waits out its timer and answers', () => {
  // ProcessChoiceEvent's Sleep(Timer) branch: stdin is a file already read to
  // the end, so the sleep is the last thing on the loop.
  const out = runDetached(`
    const sink = { write() { return true; }, flush() {} };
    const host = new C.ConsoleHost({
      stdout: sink, stderr: sink, stdin: '',
      outputType: C.FILE_TYPE.PIPE, inputType: C.FILE_TYPE.PIPE,
    });
    const channel = new C.CommChannel({ instance: '_1_1' });
    host.attach(channel);
    const client = new C.ExternalConsole(channel, {});
    client.init();
    client.choice('YN', 3, 4, 0, 2, true, 40, 'Reconnect?')
      .then((r) => fs.writeSync(1, 'choice=' + r));
  `);
  assert.strictEqual(out, 'choice=2',
    'the timeout answer must be taken, not skipped by an early exit');
});

test('a front-end that never answers still reports the send timeout', () => {
  // The hung-front-end case is precisely the one with nothing else pending.
  const out = runDetached(`
    const channel = new C.CommChannel({ instance: '_1_1' });
    channel.setHandler(() => new Promise(() => {}));
    const client = new C.ExternalConsole(channel, { sendTimeout: 25 });
    client.input(true, 0).then(
      () => fs.writeSync(1, 'answered'),
      (e) => fs.writeSync(1, 'send=' + e.message));
  `);
  assert.strictEqual(out, `send=${MSG.CONSOLE_SEND_TIMEOUT}`,
    'a hung front-end must be reported, never turned into a silent exit');
});

test('the client trims the line terminator the console hands back', () => {
  assert.strictEqual(trimNewLine('value\r\n'), 'value');
  assert.strictEqual(trimNewLine('value\n'), 'value');
  assert.strictEqual(trimNewLine('value'), 'value');
});

// ---------------------------------------------------------------------------
// choice — what a prompt answers when nobody is there
// ---------------------------------------------------------------------------

test('with redirected input an ordinary prompt takes the abort answer, not a default', async () => {
  const { client } = makePair({ inputType: FILE_TYPE.PIPE });
  // Options "YNC", cancel 3, break 4, continue 0, timeouted 1, not timeouting.
  const result = await client.choice('YNC', 3, 4, 0, 1, false, 0, 'Overwrite?');
  assert.strictEqual(result, 4, 'an unanswerable prompt must abort, never say yes');
});

test('with redirected input a timeouting prompt waits out its timer and takes it', async () => {
  const slept = [];
  const { client } = makePair({
    inputType: FILE_TYPE.PIPE, sleep: (ms) => { slept.push(ms); return Promise.resolve(); },
  });
  const result = await client.choice('YN', 3, 4, 0, 2, true, 5000, 'Reconnect?');
  assert.strictEqual(result, 2);
  assert.deepStrictEqual(slept, [5000], 'the wait is real, so timing matches the on-screen run');
});

test('an interactive prompt answers on the matching key, one-based and case-insensitive', async () => {
  const keys = new KeySource(decodeKeys('n'));
  const { client } = makePair({ outputType: FILE_TYPE.CHAR, inputType: FILE_TYPE.CHAR, keys });
  assert.strictEqual(await client.choice('YNC', 3, 4, 0, 1, false, 0, ''), 2);
});

test('Escape takes the cancel answer', async () => {
  const keys = new KeySource([{ char: '', escape: true, ctrl: false, alt: false }]);
  const { client } = makePair({ outputType: FILE_TYPE.CHAR, inputType: FILE_TYPE.CHAR, keys });
  assert.strictEqual(await client.choice('YNC', 7, 4, 0, 1, false, 0, ''), 7);
});

test('a key held with Ctrl or Alt is not an answer', async () => {
  const keys = new KeySource([
    { char: 'Y', ctrl: true, alt: false },
    { char: 'y', ctrl: false, alt: false },
  ]);
  const { client } = makePair({ outputType: FILE_TYPE.CHAR, inputType: FILE_TYPE.CHAR, keys });
  assert.strictEqual(await client.choice('YN', 3, 4, 0, 1, false, 0, ''), 1);
});

test('a key that is not an option is ignored, not treated as a default', async () => {
  const keys = new KeySource(decodeKeys('qzc'));
  const { client } = makePair({ outputType: FILE_TYPE.CHAR, inputType: FILE_TYPE.CHAR, keys });
  assert.strictEqual(await client.choice('ABC', 9, 8, 0, 1, false, 0, ''), 3);
});

test('an interactive prompt with a timer times out to its timeout answer', async () => {
  const keys = new KeySource([]);
  const { client } = makePair({ outputType: FILE_TYPE.CHAR, inputType: FILE_TYPE.CHAR, keys });
  assert.strictEqual(await client.choice('YN', 3, 4, 0, 6, true, 120, ''), 6);
});

test('a closed keyboard takes the abort answer', async () => {
  const { client } = makePair({
    outputType: FILE_TYPE.CHAR, inputType: FILE_TYPE.CHAR, keys: new KeySource(null),
  });
  assert.strictEqual(await client.choice('YN', 3, 4, 0, 1, false, 0, ''), 4);
});

test('the choice result starts at break, so a silent front-end still aborts', async () => {
  const channel = new CommChannel({ instance: '_1_1' });
  channel.setHandler(() => { /* answers nothing at all */ });
  const client = new ExternalConsole(channel, {});
  assert.strictEqual(await client.choice('YN', 3, 4, 0, 1, false, 0, ''), 4);
});

test('an over-long choice message is truncated to the field', async () => {
  const channel = new CommChannel({ instance: '_1_1' });
  let seen = null;
  channel.setHandler((s) => { seen = s.choice; });
  const client = new ExternalConsole(channel, {});
  await client.choice('YN', 3, 4, 0, 1, false, 0, 'm'.repeat(LIMITS.CHOICE_MESSAGE * 2));
  assert.strictEqual(seen.message.length, LIMITS.CHOICE_MESSAGE - 1);
});

// ---------------------------------------------------------------------------
// cancellation
// ---------------------------------------------------------------------------

test('a pending abort is consumed, so one Ctrl+C cancels one operation', () => {
  const { channel, client } = makePair();
  assert.strictEqual(client.pendingAbort(), false);
  channel.cancel();
  assert.strictEqual(client.pendingAbort(), true);
  assert.strictEqual(client.pendingAbort(), false, 'a single interrupt must not poison the rest');
});

test('Ctrl+C cancels the operation and keeps the front-end alive', () => {
  const { host, channel } = makePair();
  let finalized = false;
  assert.strictEqual(host.handleControlEvent('SIGINT', () => { finalized = true; }), true);
  assert.strictEqual(channel.cancelSignalled, true);
  assert.strictEqual(finalized, false, 'Ctrl+C must not kill the child');
});

test('any other control event kills the child and lets the process go', () => {
  const { host, channel } = makePair();
  let finalized = false;
  assert.strictEqual(host.handleControlEvent('SIGHUP', () => { finalized = true; }), false);
  assert.strictEqual(channel.cancelSignalled, false);
  assert.strictEqual(finalized, true);
});

test('an interrupt during an interactive prompt discards the partial line', async () => {
  const keys = new KeySource([]);
  const { channel, client } = makePair({
    outputType: FILE_TYPE.CHAR, inputType: FILE_TYPE.CHAR, keys,
  });
  const pending = client.input(true, 0);
  for (const k of decodeKeys('half')) keys.push(k);
  await sleep(10);
  channel.cancel();
  keys.push(decodeKeys('\r')[0]);
  assert.strictEqual(await pending, null, 'a cancelled prompt answers nothing');
});

test('installControlHandler wires and unwires the interrupt', () => {
  const { EventEmitter } = require('events');
  const emitter = new EventEmitter();
  const { host, channel } = makePair();
  const uninstall = installControlHandler(host, { emitter });
  emitter.emit('SIGINT');
  assert.strictEqual(channel.cancelSignalled, true);
  uninstall();
  assert.strictEqual(emitter.listenerCount('SIGINT'), 0);
});

// ---------------------------------------------------------------------------
// transfer out
// ---------------------------------------------------------------------------

test('binary stdout writes the raw bytes, and to stdout even when messages went to stderr', () => {
  const { stdout, stderr, client } = makePair({
    outputType: FILE_TYPE.PIPE, stdOut: STDINOUT.BINARY,
  });
  client.transferOut(Buffer.from([0x00, 0xFF, 0x0A, 0x0D]));
  assert.deepStrictEqual([...stdout.buffer], [0x00, 0xFF, 0x0A, 0x0D],
    'file data must never be line-ending translated');
  assert.strictEqual(stderr.text, '');
});

test('chunked stdout frames every block with its hex length', () => {
  const { stdout, client } = makePair({ outputType: FILE_TYPE.PIPE, stdOut: STDINOUT.CHUNKED });
  client.transferOut(Buffer.from('hello'));
  assert.strictEqual(stdout.text, '5\r\nhello\r\n');
});

test('a zero-length chunked transfer is the end-of-stream marker', () => {
  const { stdout, client } = makePair({ outputType: FILE_TYPE.PIPE, stdOut: STDINOUT.CHUNKED });
  client.transferOut(Buffer.alloc(0));
  assert.strictEqual(stdout.text, '0\r\n\r\n');
});

test('a transfer larger than the data field is split into whole blocks', () => {
  const { stdout, client } = makePair({ outputType: FILE_TYPE.PIPE, stdOut: STDINOUT.BINARY });
  const data = Buffer.alloc(LIMITS.TRANSFER_DATA * 2 + 7, 0x41);
  client.transferOut(data);
  assert.strictEqual(stdout.buffer.length, data.length);
  assert.strictEqual(stdout.chunks.length, 3);
  assert.strictEqual(stdout.chunks[0].length, LIMITS.TRANSFER_DATA);
  assert.strictEqual(stdout.chunks[2].length, 7);
});

test('without /stdout the data is dropped rather than corrupting the messages', () => {
  const { stdout, client } = makePair({ outputType: FILE_TYPE.PIPE });
  client.transferOut(Buffer.from('data'));
  assert.strictEqual(stdout.text, '');
});

// ---------------------------------------------------------------------------
// transfer in
// ---------------------------------------------------------------------------

test('a full block is read exactly', async () => {
  const data = Buffer.alloc(LIMITS.TRANSFER_DATA, 0x42);
  const { client } = makePair({ stdin: data, stdIn: STDINOUT.BINARY, noInteractiveInput: true });
  const got = await client.transferInBlock(LIMITS.TRANSFER_DATA);
  assert.strictEqual(got.length, LIMITS.TRANSFER_DATA);
});

test('a short read reports the real length and ends the stream', async () => {
  const { client } = makePair({ stdin: Buffer.from('abc'), stdIn: STDINOUT.BINARY });
  const got = await client.transferInBlock(LIMITS.TRANSFER_DATA);
  assert.strictEqual(got.toString('utf8'), 'abc');
  const next = await client.transferInBlock(LIMITS.TRANSFER_DATA);
  assert.strictEqual(next.length, 0);
});

test('the whole of stdin is read across blocks', async () => {
  const data = Buffer.alloc(LIMITS.TRANSFER_DATA * 2 + 13, 0x43);
  const { client } = makePair({ stdin: data, stdIn: STDINOUT.BINARY });
  const got = await client.transferIn();
  assert.strictEqual(got.length, data.length);
  assert.ok(got.equals(data));
});

test('a stream read error fails the upload instead of truncating it', async () => {
  const failing = new Readable({ read() { this.destroy(new Error('device gone')); } });
  const source = new ByteSource(failing);
  await sleep(10);
  const host = new ConsoleHost({
    stdout: new FakeStream(), outputType: FILE_TYPE.PIPE, inputType: FILE_TYPE.PIPE, source,
  });
  const channel = new CommChannel({ instance: '_1_1' });
  host.attach(channel);
  const client = new ExternalConsole(channel, { stdIn: STDINOUT.BINARY });
  client.init();
  await assert.rejects(() => client.transferInBlock(16),
    (e) => e.message === MSG.STREAM_READ_ERROR);
});

// ---------------------------------------------------------------------------
// the byte source
// ---------------------------------------------------------------------------

test('the byte source hands back exactly what was asked for, and less only at the end', async () => {
  const s = new ByteSource(Buffer.from('abcdef'));
  assert.strictEqual((await s.read(2)).toString(), 'ab');
  assert.strictEqual((await s.read(10)).toString(), 'cdef');
  assert.strictEqual((await s.read(1)).length, 0);
});

test('the byte source waits for a stream instead of reporting a short read', async () => {
  const stream = new Readable({ read() {} });
  const s = new ByteSource(stream);
  const pending = s.read(6);
  stream.push('abc');
  await sleep(5);
  stream.push('def');
  assert.strictEqual((await pending).toString(), 'abcdef');
});

test('a stream error is reported separately from end of input', async () => {
  const stream = new Readable({ read() { this.destroy(new Error('nope')); } });
  const s = new ByteSource(stream);
  await s.read(1);
  assert.strictEqual(s.failed, true);
});

// ---------------------------------------------------------------------------
// key decoding
// ---------------------------------------------------------------------------

test('keys decode into characters, Enter, backspace, Escape and control keys', () => {
  assert.deepStrictEqual(decodeKeys('a'), [{ char: 'a', ctrl: false, alt: false }]);
  assert.strictEqual(decodeKeys('\r')[0].enter, true);
  assert.strictEqual(decodeKeys('\n')[0].enter, true);
  assert.strictEqual(decodeKeys('\u007f')[0].backspace, true);
  assert.strictEqual(decodeKeys('\u001b')[0].escape, true);
  const ctrl = decodeKeys('\u0003')[0];
  assert.strictEqual(ctrl.ctrl, true);
  assert.strictEqual(ctrl.char, 'C');
});

test('an escape sequence is swallowed rather than read as Escape then letters', () => {
  // An arrow key is ESC [ A. Treating that as "Escape" would cancel a prompt
  // the user only meant to navigate.
  assert.deepStrictEqual(decodeKeys('\u001b[A'), []);
  assert.deepStrictEqual(decodeKeys('\u001b[Ax'), [{ char: 'x', ctrl: false, alt: false }]);
});

// ---------------------------------------------------------------------------
// field limits
// ---------------------------------------------------------------------------

test('fitString leaves room for the terminator', () => {
  assert.strictEqual(fitString('abc', 10), 'abc');
  assert.strictEqual(fitString('abcdefghij', 5), 'abcd');
  assert.strictEqual(fitString(undefined, 5), '');
});

// ---------------------------------------------------------------------------
// the exit-code contract
// ---------------------------------------------------------------------------

test('the child exit code is what the front-end returns', async () => {
  const { host, channel } = makePair();
  assert.strictEqual(await runConsoleHost({ host, channel, child: async () => 0 }), RESULT.SUCCESS);
  const second = makePair();
  assert.strictEqual(
    await runConsoleHost({ host: second.host, channel: second.channel, child: async () => 1 }), 1);
});

test('a failure serving an event outranks whatever the child made of it', async () => {
  const { host, channel } = makePair();
  const code = await runConsoleHost({
    host,
    channel,
    child: async () => {
      const struct = channel.struct;
      struct.event = EVENT.PROGRESS;
      try { await channel.send(0); } catch { /* the child sees the failure too */ }
      return 0;
    },
  });
  assert.strictEqual(code, RESULT.PROCESSING_ERROR);
});

test('a child that throws is a processing error, and the message is printed', async () => {
  const { stdout, host, channel } = makePair({ outputType: FILE_TYPE.PIPE });
  const code = await runConsoleHost({
    host, channel, child: async () => { throw new Error('child blew up'); },
  });
  assert.strictEqual(code, RESULT.PROCESSING_ERROR);
  assert.ok(stdout.text.includes('child blew up'));
});

test('no child at all is an init error', async () => {
  const { host, channel } = makePair();
  assert.strictEqual(await runConsoleHost({ host, channel, child: null }), RESULT.INIT_ERROR);
});

test('a failure before the console objects exist is a global error', async () => {
  const { host, channel } = makePair();
  const code = await runConsoleHost({
    host,
    channel,
    initialize: () => { throw new ConsoleError('no objects', RESULT.GLOBAL_ERROR); },
    child: async () => 0,
  });
  assert.strictEqual(code, RESULT.GLOBAL_ERROR);
});

test('the held progress line is committed before the front-end exits', async () => {
  const { stdout, host, channel, client } = makePair({ outputType: FILE_TYPE.DISK });
  const code = await runConsoleHost({
    host, channel, child: async () => { client.print('88%', true); return 0; },
  });
  assert.strictEqual(code, 0);
  assert.strictEqual(stdout.text, '88%', 'a redirected log must not lose its last progress line');
});

test('finalize hooks run even on the success path', async () => {
  const { host, channel } = makePair();
  const ran = [];
  await runConsoleHost({
    host,
    channel,
    child: async () => 0,
    finalizeChild: () => ran.push('child'),
    finalize: () => ran.push('console'),
  });
  assert.deepStrictEqual(ran, ['child', 'console']);
  assert.strictEqual(channel.closed, true, 'the shared page is released on the way out');
});

// ---------------------------------------------------------------------------
// round-trip timing
// ---------------------------------------------------------------------------

test('the final log message reports the worst round trip, when protocol logging is on', async () => {
  let clock = 0;
  const { client } = makePair({ logProtocol: 1, now: () => { clock += 5; return clock; } });
  await client.input(true, 0);
  assert.match(client.finalLogMessage(), /^Max roundtrip: \d+$/);
});

test('a front-end that never answers produces the send-timeout message', async () => {
  const channel = new CommChannel({ instance: '_1_1' });
  channel.setHandler(() => new Promise(() => { /* never settles */ }));
  const client = new ExternalConsole(channel, { sendTimeout: 20 });
  client.pipeOutput = true;
  await assert.rejects(() => client.input(true, 0),
    (e) => e.message === `${MSG.CONSOLE_SEND_TIMEOUT} ${MSG.CONSOLE_SEND_PIPE}`);
});

test('an event the front-end answers asynchronously when it must not is reported', () => {
  const channel = new CommChannel({ instance: '_1_1' });
  channel.setHandler(() => Promise.resolve());
  const client = new ExternalConsole(channel, {});
  assert.throws(() => client.print('x'), /asynchronously/);
});

// ---------------------------------------------------------------------------
// the pair factory
// ---------------------------------------------------------------------------

test('createConsolePair produces a negotiated, ready pair', async () => {
  const stdout = new FakeStream();
  const pair = await createConsolePair({
    instance: '_2_2',
    hostOptions: { stdout, outputType: FILE_TYPE.CHAR, inputType: FILE_TYPE.CHAR },
  });
  assert.strictEqual(pair.instance, '_2_2');
  assert.strictEqual(pair.client.interactive, true);
  pair.client.printLine('ready');
  assert.strictEqual(stdout.text, 'ready\n');
});

// ---------------------------------------------------------------------------
// end to end, through the real scripting engine
// ---------------------------------------------------------------------------

function frontEndDeps(extra = {}) {
  return {
    stdout: new FakeStream(),
    stderr: new FakeStream(),
    outputType: FILE_TYPE.PIPE,
    inputType: FILE_TYPE.PIPE,
    stdin: '',
    productVersion: '6.3.5',
    installControlHandler: false,
    ...extra,
  };
}

test('a /command script runs through the console and exits 0', async () => {
  const deps = frontEndDeps();
  const code = await runConsoleFrontEnd(['/command', 'echo hello', 'exit'], deps);
  assert.strictEqual(code, RESULT.SUCCESS);
  assert.strictEqual(deps.stdout.text, 'hello\r\n');
});

test('/parameter values reach the script as %1%', async () => {
  const deps = frontEndDeps();
  const code = await runConsoleFrontEnd(
    ['/command', 'echo hello %1% and %2%', 'exit', '/parameter', 'world', 'moon'], deps);
  assert.strictEqual(code, RESULT.SUCCESS);
  assert.strictEqual(deps.stdout.text, 'hello world and moon\r\n');
});

test('a failing command makes the run exit 1 — the whole point of the contract', async () => {
  const deps = frontEndDeps();
  const code = await runConsoleFrontEnd(['/command', 'nosuchcommand', 'exit'], deps);
  assert.strictEqual(code, 1);
  assert.match(deps.stdout.text, /Unknown command 'nosuchcommand'/);
});

test('a command failing mid-script still exits 1 even when the rest succeeds', async () => {
  // `option batch continue` is the documented way to run every step; the exit
  // code must still say that something failed, or `if errorlevel 1` is useless.
  const deps = frontEndDeps();
  const code = await runConsoleFrontEnd(
    ['/command', 'option batch continue', 'nosuchcommand', 'echo done', 'exit'], deps);
  assert.strictEqual(code, 1);
  assert.match(deps.stdout.text, /done/);
});

test('with no script and no commands the front-end reads them from stdin', async () => {
  const deps = frontEndDeps({ stdin: 'echo piped\nexit\n' });
  const code = await runConsoleFrontEnd([], deps);
  assert.strictEqual(code, RESULT.SUCCESS);
  assert.match(deps.stdout.text, /piped/);
});

test('an empty stdin exits successfully rather than waiting for a prompt nobody will type', async () => {
  const deps = frontEndDeps({ stdin: '' });
  assert.strictEqual(await runConsoleFrontEnd([], deps), RESULT.SUCCESS);
});

test('a bad /stdout value stops the run before anything is transferred', async () => {
  const deps = frontEndDeps();
  const code = await runConsoleFrontEnd(['/stdout=base64', '/command', 'exit'], deps);
  assert.strictEqual(code, RESULT.PROCESSING_ERROR);
  assert.match(deps.stdout.text, /Unknown value 'base64' of option 'stdout'/);
});

test('an unusable product version stops the front-end with a global error', async () => {
  const deps = frontEndDeps({ productVersion: 'not-a-version' });
  const code = await runConsoleFrontEnd(['/command', 'exit'], deps);
  assert.strictEqual(code, RESULT.GLOBAL_ERROR);
  assert.match(deps.stdout.text, /Error retrieving product version/);
});

test('/stdin implies no interactive input, so a prompt cannot stall the run', async () => {
  const seen = [];
  await runConsoleFrontEnd(['/stdin', '/command', 'exit'], frontEndDeps({
    runChild: async (argv, childDeps) => {
      seen.push(childDeps.console.hasFlag('noInteractiveInput'),
        childDeps.console.hasFlag('stdIn'));
      return 0;
    },
  }));
  assert.deepStrictEqual(seen, [true, true]);
});

test('the child is handed /console, /consoleinstance and everything else it was given', async () => {
  let childArgv = null;
  await runConsoleFrontEnd(['/script=a.txt', '/parameter', 'x'], frontEndDeps({
    instance: '_77_7',
    runChild: async (argv) => { childArgv = argv; return 0; },
  }));
  assert.deepStrictEqual(childArgv,
    ['/console=6.3.5', '/consoleinstance=_77_7', '/script=a.txt', '/parameter', 'x']);
});

test('the progress line rewrites in place on a terminal and is committed once in a log', async () => {
  // The same script output, through the two output types, must differ in
  // exactly this way — it is the behaviour the whole FromBeginning mechanism
  // exists for.
  const term = makePair({ outputType: FILE_TYPE.CHAR });
  term.client.print('f.txt |  1 KB |  1.0 KB/s | binary |  10%', true);
  term.client.print('f.txt |  9 KB |  1.0 KB/s | binary |  90%', true);
  term.client.print('\n');
  assert.strictEqual(term.stdout.text.split('\r').length - 1, 2);

  const log = makePair({ outputType: FILE_TYPE.DISK });
  log.client.print('f.txt |  1 KB |  1.0 KB/s | binary |  10%', true);
  log.client.print('f.txt |  9 KB |  1.0 KB/s | binary |  90%', true);
  log.client.print('\n');
  assert.strictEqual(log.stdout.text, 'f.txt |  9 KB |  1.0 KB/s | binary |  90%\r\n');
});

// ---------------------------------------------------------------------------
// gaps found by adversarial verification
// ---------------------------------------------------------------------------

test('/stdin=chunked is refused by the front-end itself, not just by the parser', async () => {
  // The refusal is only worth having where a user can trip over it. The helper
  // was tested directly; this asserts the front-end actually passes
  // AllowChunked=false for stdin, so `winscp-com /stdin=chunked` stops instead
  // of uploading the caller's framing headers into the file.
  const deps = frontEndDeps();
  const code = await runConsoleFrontEnd(['/stdin=chunked', '/command', 'exit'], deps);
  assert.strictEqual(code, RESULT.PROCESSING_ERROR);
  assert.strictEqual(deps.stdout.text, MSG.VALUE_UNKNOWN('chunked', 'stdin'));
});

test('/stdout=chunked is still accepted — only the inbound direction is refused', async () => {
  const deps = frontEndDeps();
  const code = await runConsoleFrontEnd(['/stdout=chunked', '/command', 'exit'], deps);
  assert.strictEqual(code, RESULT.SUCCESS);
  // With a stdout stream in play, ordinary messages move to stderr so the data
  // stream stays clean, so the failure mode here is output on the wrong stream.
  assert.strictEqual(deps.stdout.text, '');
});

test('a Ctrl- or Alt-modified key is not an answer to a choice', async () => {
  // ProcessChoiceEvent checks dwControlKeyState for the four Ctrl/Alt bits
  // before accepting the character. Without that, Ctrl+Y in a terminal answers
  // "Yes" to an overwrite prompt the user never meant to answer.
  const keys = new KeySource([
    { char: 'Y', ctrl: true, alt: false },
    { char: 'Y', ctrl: false, alt: true },
    { char: 'N', ctrl: false, alt: false },
  ]);
  const { client } = makePair({ inputType: FILE_TYPE.CHAR, keys });
  const result = await client.choice('YN', -1, -1, 2, -2, false, 0, 'Overwrite?');
  assert.strictEqual(result, 2, 'the two modified Y presses were ignored; the plain N answered');
});

test('an unusable instance name ends the run with the global-error code, not a rejection', async () => {
  // wmain's outermost catch is RESULT_GLOBAL_ERROR. A rejected promise here
  // would give a shell nothing to test.
  const deps = frontEndDeps({ instanceExists: () => true, instance: undefined });
  const code = await runConsoleFrontEnd(['/command', 'exit'], deps);
  assert.strictEqual(code, RESULT.GLOBAL_ERROR);
  assert.strictEqual(deps.stdout.text, MSG.UNIQUE_NAME);
});

test('with no input dependency at all the front-end wires up the real stdin', async () => {
  // GetFileType(GetStdHandle(STD_INPUT_HANDLE)) is the first thing wmain does,
  // and everything about prompting hangs off the answer. A front-end that
  // sampled nothing reported FILE_TYPE_UNKNOWN — "interactive" with no keyboard
  // and no bytes — so a piped script ran nothing at all.
  const piped = Readable.from([Buffer.from('echo from stdin\nexit\n')]);
  const stdout = new FakeStream();
  const code = await runConsoleFrontEnd(['/console'], {
    stdout,
    stderr: new FakeStream(),
    outputType: FILE_TYPE.PIPE,
    productVersion: '6.3.5',
    installControlHandler: false,
    processStdin: piped,
  });
  assert.strictEqual(code, RESULT.SUCCESS);
  assert.ok(stdout.text.includes('from stdin'), stdout.text);
});

test('an explicit input dependency still wins over the real stdin', async () => {
  const deps = frontEndDeps({
    stdin: 'echo explicit\nexit\n',
    processStdin: Readable.from([Buffer.from('echo wrong\nexit\n')]),
  });
  const code = await runConsoleFrontEnd(['/console'], deps);
  assert.strictEqual(code, RESULT.SUCCESS);
  assert.ok(deps.stdout.text.includes('explicit'), deps.stdout.text);
  assert.ok(!deps.stdout.text.includes('wrong'), deps.stdout.text);
});
