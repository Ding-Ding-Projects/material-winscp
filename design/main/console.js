// console.js — the console front-end. A port of `console/Console.h` and
// `console/Main.cpp`, i.e. the `winscp.com` executable itself.
//
// WinSCP ships two binaries that together make it scriptable. `winscp.exe` is
// a GUI subsystem program: Windows gives it no console, so it cannot print to
// the terminal a user launched it from, and it cannot be waited on by `cmd`.
// `winscp.com` is a console subsystem program that does nothing but own the
// terminal on `winscp.exe`'s behalf. It launches `winscp.exe` as a child,
// hands it the name of a shared-memory block, and then spends its whole life
// in one loop: wait for the child to ask for something, do it against the real
// terminal, and hand the answer back.
//
// Everything in this file is that front-end:
//
//   * the wire protocol — `TConsoleCommStruct`, its version handshake, its
//     eight event types and the fixed field sizes that make Print chunk at
//     10,239 characters and TransferOut chunk at 20,480 bytes;
//   * the terminal rendering — including the reason a progress line can be
//     rewritten in place on a console but must be *buffered and committed* when
//     the output is redirected to a file or a pipe;
//   * prompt handling in non-interactive mode — what `Input` and `Choice`
//     answer when stdin is a file or a pipe and nobody is there to type;
//   * the exit-code contract — 1/2/3/4 for the front-end's own failures, and
//     the child's own exit code when the child got far enough to have one;
//   * the child command line — `/consolechild=`, the `-com` suffix rule, the
//     quote doubling, and the `/parameter` values that survive it.
//
// What is deliberately NOT here: the child side of the conversation is
// `ExternalConsole` below, and what the child *does* with the console — the
// command loop, the script commands, the exit-code accumulation — is
// `consolerunner.js` and `script.js`. This module is the terminal, not the
// program that talks to it.
//
// On the transport: the original uses a named file mapping plus three named
// events plus a job object, because the two halves are separate Win32
// processes. Here both halves live in one Node process, so `CommChannel`
// stands in for the shared page: the *same object* is handed to the host,
// mutated in place, and read back by the client, which is exactly the
// aliasing behaviour the C++ relies on for every response field. The named
// objects are still constructed (`commObjectNames`) because the names are part
// of the documented protocol and a future out-of-process transport must use
// them.
'use strict';

const fs = require('fs');
const nodePath = require('path');

const { cutToken, Options } = require('./script');

// ---------------------------------------------------------------------------
// the protocol — console/Console.h
// ---------------------------------------------------------------------------

/** Base names of the four kernel objects an instance owns. */
const OBJECT_PREFIX = {
  MAPPING: 'WinSCPConsoleMapping',
  EVENT_REQUEST: 'WinSCPConsoleEventRequest',
  EVENT_RESPONSE: 'WinSCPConsoleEventResponse',
  EVENT_CANCEL: 'WinSCPConsoleEventCancel',
  JOB: 'WinSCPConsoleJob',
};

const PROTOCOL = {
  /** TConsoleCommStruct::CurrentVersion. */
  CURRENT_VERSION: 0x000A,
  /**
   * CurrentVersionConfirmed. The handshake is one-directional and deliberately
   * cheap: the front-end writes CurrentVersion into the struct before starting
   * the child, the child checks it and writes back CurrentVersionConfirmed.
   * From then on the front-end refuses any event whose version is not the
   * confirmed one, which catches a mismatched pair of binaries on the first
   * event rather than after a transfer has half happened.
   */
  CURRENT_VERSION_CONFIRMED: 0x010A,
};

/** TConsoleCommStruct::Event. */
const EVENT = {
  NONE: 'none',
  PRINT: 'print',
  INPUT: 'input',
  CHOICE: 'choice',
  TITLE: 'title',
  INIT: 'init',
  PROGRESS: 'progress',
  TRANSFEROUT: 'transferout',
  TRANSFERIN: 'transferin',
};

/** TConsoleCommStruct::TInitEvent::STDINOUT. */
const STDINOUT = { OFF: 'off', BINARY: 'binary', CHUNKED: 'chunked' };

/**
 * Win32 GetFileType results. These are not decoration: three separate
 * behaviours hang off them (in-place progress rewriting, prompt answering, and
 * the UTF-8 code page decision), so the port keeps the same three-way
 * distinction rather than collapsing it to "is a TTY".
 */
const FILE_TYPE = { UNKNOWN: 0, DISK: 1, CHAR: 2, PIPE: 3 };

/**
 * The fixed array sizes in TConsoleCommStruct. They are the reason the client
 * chunks: a 30 KB print becomes three PRINT events, and a 1 MB upload becomes
 * fifty-one TRANSFEROUT events. A port that used unbounded strings would work
 * until it met a receiver that did not, so the limits are kept.
 */
const LIMITS = {
  PRINT_MESSAGE: 10240,
  INPUT_STR: 10240,
  CHOICE_OPTIONS: 64,
  CHOICE_MESSAGE: 5120,
  TITLE: 10240,
  PROGRESS_FILENAME: 1024,
  PROGRESS_DIRECTORY: 1024,
  TRANSFER_DATA: 20480,
};

/** wmain's return values. */
const RESULT = {
  SUCCESS: 0,
  GLOBAL_ERROR: 1,
  INIT_ERROR: 2,
  PROCESSING_ERROR: 3,
  UNKNOWN_ERROR: 4,
};

const CONSOLE_CHILD_PARAM = 'consolechild';
const MAX_ATTEMPTS = 10;

/** The messages the two halves report, verbatim from WinSCP's resources. */
const MSG = {
  MAPPING_OPEN: 'Cannot open mapping object.',
  UNIQUE_NAME: 'Cannot find unique name for event object.',
  REQUEST_EVENT: 'Cannot create request event object.',
  RESPONSE_EVENT: 'Cannot create response event object.',
  CANCEL_EVENT: 'Cannot create cancel event object.',
  MAPPING_CREATE: 'Cannot create mapping object.',
  JOB_CREATE: 'Cannot create job object.',
  MODULE_NAME: 'Error retrieving executable name.',
  PRODUCT_VERSION: 'Error retrieving product version.',
  INCOMPATIBLE_VERSION: 'Incompatible console protocol version',
  UNKNOWN_EVENT: 'Unknown event',
  WAIT_ERROR: 'Error waiting for communication from child process.',
  CANNOT_START: (path) => `Cannot start WinSCP application "${path}".`,
  // TextsWin1.rc
  EXTERNAL_CONSOLE_INIT_ERROR: 'Cannot initialize external console.',
  CONSOLE_COMM_ERROR:
    'Cannot open mapping object to start communication with external console.',
  CONSOLE_SEND_TIMEOUT: 'Timeout waiting for external console to complete the command.',
  EXTERNAL_CONSOLE_INCOMPATIBLE: (v) =>
    `Incompatible external console protocol version ${v}.`,
  CONSOLE_SEND_PIPE:
    'External console output is redirected to a pipe. Make sure the pipe is being read from.',
  // TextsCore1.rc
  STREAM_READ_ERROR: 'Error reading input stream.',
  // ConsoleRunner.cpp abuses SCRIPT_VALUE_UNKNOWN for /stdout=/stdin= values.
  VALUE_UNKNOWN: (value, sw) => `Unknown value '${value}' of option '${sw}'.`,
};

/** An error that carries the wmain exit code it should produce. */
class ConsoleError extends Error {
  constructor(message, result = RESULT.PROCESSING_ERROR) {
    super(message);
    this.name = 'ConsoleError';
    this.result = result;
  }
}

// ---------------------------------------------------------------------------
// instance naming
// ---------------------------------------------------------------------------

/**
 * InitializeConsole's name search. The instance name is `_<pid>_<n>` with a
 * random n, retried until the request event name is unused — two `winscp.com`
 * processes started in the same millisecond by the same shell would otherwise
 * collide and each would drive the other's child.
 *
 * @param {number} pid
 * @param {(max:number)=>number} random  stands for Borland's `random(1000)`
 * @param {(name:string)=>boolean} exists  "is this event name already taken"
 */
function makeInstanceName(pid, random = (max) => Math.floor(Math.random() * max),
  exists = () => false) {
  let attempts = 0;
  for (;;) {
    if (attempts > MAX_ATTEMPTS) throw new ConsoleError(MSG.UNIQUE_NAME, RESULT.GLOBAL_ERROR);
    const instance = `_${pid}_${random(1000)}`;
    if (!exists(`${OBJECT_PREFIX.EVENT_REQUEST}${instance}`)) return instance;
    attempts++;
  }
}

/** The four kernel object names an instance owns. */
function commObjectNames(instance) {
  return {
    mapping: `${OBJECT_PREFIX.MAPPING}${instance}`,
    request: `${OBJECT_PREFIX.EVENT_REQUEST}${instance}`,
    response: `${OBJECT_PREFIX.EVENT_RESPONSE}${instance}`,
    cancel: `${OBJECT_PREFIX.EVENT_CANCEL}${instance}`,
    job: `${OBJECT_PREFIX.JOB}${instance}`,
  };
}

// ---------------------------------------------------------------------------
// the child command line — InitializeChild
// ---------------------------------------------------------------------------

/**
 * GetProductVersion. The original reads its own VERSIONINFO and refuses to
 * start when the product version is not three plausible components, because
 * `/console=` is how the child learns which front-end it is talking to and a
 * garbled value there is worse than not starting.
 *
 * The C++ bound on the major component is 1..99. That bound cannot be ported
 * literally: this application's own version is 0.x, so a literal port would
 * refuse to start against itself, and a refusal that fires on the correct input
 * is not a refusal worth having. The check that matters — three numeric
 * components, none of them absurd — is kept.
 */
function formatProductVersion(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version === undefined ? '' : version));
  if (!m) throw new ConsoleError(MSG.PRODUCT_VERSION, RESULT.GLOBAL_ERROR);
  const [major, minor, build] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (major > 99 || minor > 99 || build > 99) {
    throw new ConsoleError(MSG.PRODUCT_VERSION, RESULT.GLOBAL_ERROR);
  }
  return `${major}.${minor}.${build}`;
}

/** Split a command line the way the front-end's own copy of CutToken does. */
function splitCommandLine(commandLine) {
  const out = [];
  let rest = commandLine === undefined || commandLine === null ? '' : String(commandLine);
  for (;;) {
    const t = cutToken(rest);
    if (!t.ok) break;
    out.push(t.token);
    rest = t.rest;
  }
  return out;
}

/**
 * Derive the child executable from the front-end's own name: same directory,
 * same base name with any `-com` suffix removed, `.exe` extension. That suffix
 * rule is what lets a renamed pair (`mytool-com.exe` + `mytool.exe`) keep
 * working, and it is case-insensitive because Windows file names are.
 */
function deriveChildPath(moduleFileName) {
  const name = String(moduleFileName === undefined ? '' : moduleFileName);
  if (name === '') throw new ConsoleError(MSG.MODULE_NAME, RESULT.GLOBAL_ERROR);
  const lastDelimiter = Math.max(name.lastIndexOf('\\'), name.lastIndexOf('/'));
  const dir = lastDelimiter >= 0 ? name.slice(0, lastDelimiter + 1) : '';
  const appFileName = lastDelimiter >= 0 ? name.slice(lastDelimiter + 1) : name;

  const extensionStart = appFileName.lastIndexOf('.');
  let baseNameLen = extensionStart >= 0 ? extensionStart : appFileName.length;

  const comSuffix = '-com';
  if (baseNameLen >= comSuffix.length
      && appFileName.slice(baseNameLen - comSuffix.length, baseNameLen).toLowerCase() === comSuffix) {
    baseNameLen -= comSuffix.length;
  }

  return `${dir}${appFileName.slice(0, baseNameLen)}.exe`;
}

/**
 * Find an explicit `/consolechild=PATH` (or `-consolechild=PATH`) override and
 * the index of the token carrying it, so the child never sees the switch that
 * chose it. Matching is prefix-based on the switch name exactly as in the C++:
 * the character after the name must be `=`, so `/consolechildish=x` is not a
 * match and is forwarded untouched.
 *
 * `skipParam` is -1 when there is no such switch. The C++ can use 0 as its
 * "none" value because index 0 is always the executable and its forwarding loop
 * starts at 1; an argv array has no executable in it, so 0 is a real argument
 * here and a distinct sentinel is required.
 */
function findConsoleChild(tokens) {
  let childPath = '';
  let skipParam = -1;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.length === 0) continue;
    if (!'-/'.includes(token[0])) continue;
    const name = token.slice(1, 1 + CONSOLE_CHILD_PARAM.length);
    if (name.toLowerCase() !== CONSOLE_CHILD_PARAM) continue;
    if (token[1 + CONSOLE_CHILD_PARAM.length] !== '=') continue;
    skipParam = i;
    childPath = token.slice(1 + CONSOLE_CHILD_PARAM.length + 1);
  }
  return { childPath, skipParam };
}

/** Requote one already-tokenized argument: wrap in quotes, double any inside. */
function quoteChildArgument(token) {
  return `"${String(token).split('"').join('""')}"`;
}

/**
 * InitializeChild's parameter rebuilding.
 *
 * Every argument the user typed is passed through — including every
 * `/parameter` value, which is why `%1%` expansion in the script still sees
 * what the shell was given. The two switches the front-end adds are
 * `/console=<product version>` and `/consoleinstance=<name>`; the only thing
 * removed is the `/consolechild=` token, because forwarding it would make the
 * child try to re-launch itself.
 *
 * Note the re-quoting: the tokens have already been through CutToken, which
 * *consumed* the user's quoting, so each one is wrapped again and any embedded
 * quote is doubled. `a"b` therefore leaves as `"a""b"` and arrives as `a"b`.
 */
function buildChildCommandLine(commandLine, instanceName, options = {}) {
  const tokens = splitCommandLine(commandLine);
  const { childPath: explicitPath, skipParam } = findConsoleChild(tokens);
  const childPath = explicitPath !== ''
    ? explicitPath
    : deriveChildPath(options.moduleFileName !== undefined ? options.moduleFileName : tokens[0]);
  const version = formatProductVersion(options.productVersion);

  let parameters = `"${childPath}" /console=${version} /consoleinstance=${instanceName} `;
  for (let i = 1; i < tokens.length; i++) {
    if (i === skipParam) continue;
    parameters += `${quoteChildArgument(tokens[i])} `;
  }
  return { childPath, parameters };
}

/**
 * The same rebuilding as an argv array, which is what an in-process child
 * needs. Kept beside `buildChildCommandLine` so the two cannot drift: a bug in
 * one that the other does not have would be invisible until someone shipped
 * the out-of-process transport.
 */
function buildChildArgv(argv, instanceName, options = {}) {
  const tokens = [].concat(argv || []).map((a) => String(a));
  const { skipParam } = findConsoleChild(tokens);
  const version = formatProductVersion(options.productVersion);
  const out = [`/console=${version}`, `/consoleinstance=${instanceName}`];
  for (let i = 0; i < tokens.length; i++) {
    if (i === skipParam) continue;
    out.push(tokens[i]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// /stdout= and /stdin= — ParseStdInOutMode in ConsoleRunner.cpp
// ---------------------------------------------------------------------------

/**
 * `/stdout` and `/stdout=binary` mean the same thing; `/stdout=chunked` adds
 * HTTP-style length framing so a caller can tell one file from the next in a
 * single stream. `/stdin=chunked` is refused — there is no framing to parse on
 * the way in, and silently treating it as binary would hand the server a file
 * containing the caller's framing headers.
 */
function parseStdInOutMode(options, name, allowChunked) {
  const found = options && typeof options.locateSwitch === 'function'
    ? options.locateSwitch(name) : { found: false, value: '' };
  if (!found.found) return STDINOUT.OFF;
  const value = String(found.value === undefined ? '' : found.value);
  if (value === '' || value.toLowerCase() === STDINOUT.BINARY) return STDINOUT.BINARY;
  if (value.toLowerCase() === STDINOUT.CHUNKED && allowChunked) return STDINOUT.CHUNKED;
  throw new ConsoleError(MSG.VALUE_UNKNOWN(value, name), RESULT.PROCESSING_ERROR);
}

// ---------------------------------------------------------------------------
// byte and key sources — what the front-end reads the terminal through
// ---------------------------------------------------------------------------

/**
 * A pushback byte reader. The front-end reads stdin one byte at a time when it
 * is a file or a pipe (`ReadFile(ConsoleInput, &Ch, 1, ...)`), so the port
 * needs a source that can hand back exactly N bytes and can report EOF and a
 * read error separately — `TransferIn` distinguishes them, and treating an
 * error as EOF would silently upload a truncated file.
 */
class ByteSource {
  constructor(input) {
    this._pending = Buffer.alloc(0);
    this._ended = false;
    this._failed = false;
    this._waiters = [];

    if (input === undefined || input === null) {
      this._ended = true;
    } else if (Buffer.isBuffer(input) || typeof input === 'string') {
      this._pending = Buffer.isBuffer(input) ? Buffer.from(input) : Buffer.from(input, 'utf8');
      this._ended = true;
    } else {
      this._attach(input);
    }
  }

  _attach(stream) {
    stream.on('data', (chunk) => {
      this._pending = Buffer.concat([
        this._pending, Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8')]);
      this._wake();
    });
    stream.on('end', () => { this._ended = true; this._wake(); });
    stream.on('error', () => { this._failed = true; this._ended = true; this._wake(); });
    if (typeof stream.resume === 'function') stream.resume();
  }

  get failed() { return this._failed; }

  get ended() { return this._ended && this._pending.length === 0; }

  _wake() {
    const waiters = this._waiters;
    this._waiters = [];
    for (const w of waiters) w();
  }

  _more() {
    if (this._ended) return Promise.resolve();
    return new Promise((resolve) => { this._waiters.push(resolve); });
  }

  /** Up to `n` bytes; shorter only at EOF. */
  async read(n) {
    while (this._pending.length < n && !this._ended) await this._more();
    const take = Math.min(n, this._pending.length);
    const out = this._pending.subarray(0, take);
    this._pending = this._pending.subarray(take);
    return Buffer.from(out);
  }

  /**
   * ProcessInputEvent's redirected-input branch: bytes up to but not including
   * the next `\n`, with **every** `\r` dropped (not just the trailing one —
   * the C++ filter is `if (Ch != '\r')`), stopping at `maxBytes`.
   *
   * `ok` is the C++ `Result` before the byte count is considered: it is false
   * only when the very first read failed or hit EOF with nothing buffered.
   */
  async readLine(maxBytes) {
    const bytes = [];
    let ok = false;
    for (;;) {
      if (bytes.length >= maxBytes) break;
      const chunk = await this.read(1);
      if (chunk.length === 0) break;
      ok = true;
      const ch = chunk[0];
      if (ch === 0x0A) break;
      if (ch !== 0x0D) bytes.push(ch);
    }
    return { data: Buffer.from(bytes), ok };
  }
}

/**
 * A key source. The front-end's `Choice` reads raw console input records so it
 * can answer on a single keypress without Enter, and its `Input` runs a timer
 * thread that resets on *any* key so an idle prompt times out but a slow typist
 * does not. Both need keys, not lines.
 *
 * A key is `{ char, ctrl, alt, escape, enter, backspace }`. `readKey` resolves
 * `null` on timeout and `undefined` at end of input, which the callers treat
 * differently: a timeout takes the timeout branch, EOF aborts.
 */
class KeySource {
  constructor(keys = []) {
    this._keys = Array.isArray(keys) ? keys.slice() : [];
    // `null` is "there is no keyboard": every read reports end of input, which
    // is what makes a prompt abort instead of hanging.
    this._ended = keys === null;
    this._waiters = [];
  }

  push(key) { this._keys.push(key); this._wake(); }

  end() { this._ended = true; this._wake(); }

  _wake() {
    const waiters = this._waiters;
    this._waiters = [];
    for (const w of waiters) w();
  }

  async readKey(timeoutMs = 0) {
    for (;;) {
      if (this._keys.length) return this._keys.shift();
      if (this._ended) return undefined;
      let timer = null;
      let waiter = null;
      const woken = await new Promise((resolve) => {
        waiter = () => resolve(true);
        this._waiters.push(waiter);
        // The C++ Input() timer runs on its own thread, and a thread the
        // process is waiting on keeps the process alive. So must this timer:
        // it is the *only* other thing that can settle this promise, a
        // keypress being the one alternative. An unref'd timer here lets the
        // loop drain while the front-end still owes ProcessInputEvent an
        // answer, and `winscp.com` exits silently mid-prompt instead of
        // taking the timeout branch and reporting it.
        if (timeoutMs > 0) timer = setTimeout(() => resolve(false), timeoutMs);
      });
      // Whichever side won, release the other. The timer would otherwise hold
      // the process open for the rest of a long prompt interval after the key
      // that answered it, and the waiter would pile up once per slice on the
      // 50 ms poll Choice runs while a prompt sits untouched.
      if (timer !== null) clearTimeout(timer);
      if (!woken) {
        const stale = this._waiters.indexOf(waiter);
        if (stale >= 0) this._waiters.splice(stale, 1);
        return null;
      }
    }
  }
}

/** Decode one chunk of raw TTY bytes into key records. */
function decodeKeys(chunk) {
  const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
  const keys = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const code = text.charCodeAt(i);
    if (code === 27) {
      // A lone ESC is the cancel key; ESC followed by anything is an escape
      // sequence (arrow keys and the like), which Choice ignores.
      if (i + 1 < text.length) {
        while (i + 1 < text.length && !/[A-Za-z~]/.test(text[i + 1])) i++;
        i++;
        continue;
      }
      keys.push({ char: '', escape: true, ctrl: false, alt: false });
      continue;
    }
    if (code === 13 || code === 10) {
      keys.push({ char: '\r', enter: true, ctrl: false, alt: false });
      continue;
    }
    if (code === 8 || code === 127) {
      keys.push({ char: '\b', backspace: true, ctrl: false, alt: false });
      continue;
    }
    if (code < 32) {
      // Control characters: Ctrl+A is 1. Ctrl+C (3) is what the Win32 build
      // gets through its console control handler instead.
      keys.push({ char: String.fromCharCode(code + 64), ctrl: true, alt: false });
      continue;
    }
    keys.push({ char: c, ctrl: false, alt: false });
  }
  return keys;
}

/** A KeySource over a raw-mode TTY. */
class TtyKeySource extends KeySource {
  constructor(stream) {
    super([]);
    this.stream = stream;
    this._raw = false;
    if (stream) {
      stream.on('data', (chunk) => { for (const k of decodeKeys(chunk)) this.push(k); });
      stream.on('end', () => this.end());
      stream.on('error', () => this.end());
    }
  }

  setRawMode(raw) {
    if (!this.stream || typeof this.stream.setRawMode !== 'function') return;
    if (this._raw === raw) return;
    this.stream.setRawMode(raw);
    this._raw = raw;
    if (raw && typeof this.stream.resume === 'function') this.stream.resume();
  }
}

// ---------------------------------------------------------------------------
// the shared struct
// ---------------------------------------------------------------------------

/** A fresh comm struct, as InitializeConsole leaves it before the child starts. */
function createCommStruct() {
  return {
    size: 0,
    version: PROTOCOL.CURRENT_VERSION,
    event: EVENT.NONE,
    print: { message: '', fromBeginning: false, error: false },
    input: { echo: true, result: false, str: '', timer: 0 },
    choice: {
      options: '', cancel: 0, break: 0, result: 0, timeouted: 0, timer: 0,
      timeouting: false, continue: 0, message: '',
    },
    title: { title: '' },
    init: {
      inputType: FILE_TYPE.UNKNOWN,
      outputType: FILE_TYPE.UNKNOWN,
      wantsProgress: false,
      useStdErr: false,
      outputFormat: STDINOUT.OFF,
      inputFormat: STDINOUT.OFF,
    },
    progress: {
      operation: 'copy', side: 'local', fileName: '', directory: '',
      overallProgress: 0, fileProgress: 0, cps: 0, cancel: false,
    },
    transfer: { data: Buffer.alloc(0), len: 0, error: false },
  };
}

/** Truncate to a fixed wchar_t array, leaving room for the NUL. */
function fitString(value, size) {
  const s = value === undefined || value === null ? '' : String(value);
  return s.length > size - 1 ? s.slice(0, size - 1) : s;
}

/**
 * The rendezvous. `send` is the client's `SetEvent(Request); WaitForSingleObject
 * (Response, Timeout)` and the handler is the front-end's `ProcessEvent`.
 *
 * The cancel flag is an auto-reset event in the original, and that matters:
 * `PendingAbort` *consumes* it, so a single Ctrl+C aborts one operation rather
 * than poisoning every subsequent one.
 */
class CommChannel {
  constructor(options = {}) {
    this.struct = createCommStruct();
    this.instance = options.instance || '';
    this.names = commObjectNames(this.instance);
    this._cancel = false;
    this._handler = null;
    this._closed = false;
    /**
     * The first failure the front-end hit while serving an event. In Win32 that
     * failure breaks the front-end's loop, which sets RESULT_PROCESSING_ERROR
     * and terminates the child outright; here the failure is handed back to the
     * caller of `send` (which unwinds the child the same way) and remembered, so
     * `runConsoleHost` can still report the front-end's own exit code rather
     * than the child's.
     */
    this.hostError = null;
  }

  setHandler(handler) { this._handler = handler; }

  /** SetEvent(CancelEvent) — from the Ctrl+C / Ctrl+Break handler. */
  cancel() { this._cancel = true; }

  /** WaitForSingleObject(CancelEvent, 0) on an auto-reset event. */
  consumeCancel() {
    const was = this._cancel;
    this._cancel = false;
    return was;
  }

  get cancelSignalled() { return this._cancel; }

  get closed() { return this._closed; }

  close() { this._closed = true; }

  /**
   * The synchronous half of the rendezvous, for the events the front-end serves
   * without yielding. It is what makes `Print` behave like the blocking call it
   * is in the original; a handler that answers with a promise is a programming
   * error and says so rather than returning a half-filled struct.
   */
  sendSync() {
    if (this._closed || !this._handler) throw new Error(MSG.CONSOLE_COMM_ERROR);
    let answer;
    try {
      answer = this._handler(this.struct);
    } catch (e) {
      if (this.hostError === null) this.hostError = e;
      throw e;
    }
    if (answer && typeof answer.then === 'function') {
      const e = new Error(`${MSG.CONSOLE_COMM_ERROR} (${this.struct.event} answered asynchronously)`);
      if (this.hostError === null) this.hostError = e;
      throw e;
    }
    return this.struct;
  }

  /**
   * @param {number} timeoutMs 0 or Infinity means INFINITE.
   * @returns {Promise<object>} the struct, mutated in place by the handler.
   */
  async send(timeoutMs = 0) {
    if (this._closed || !this._handler) throw new Error(MSG.CONSOLE_COMM_ERROR);
    const work = Promise.resolve().then(() => this._handler(this.struct)).catch((e) => {
      if (this.hostError === null) this.hostError = e;
      throw e;
    });
    if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
      let timer = null;
      const timeout = new Promise((_resolve, reject) => {
        // WaitForSingleObject(RequestEvent, Timeout): the wait itself is what
        // keeps the process alive until either the front-end answers or the
        // timeout expires. A hung front-end is exactly the case where nothing
        // else is on the loop, so an unref'd timer would turn "Timeout waiting
        // for external console" into a silent exit — the one outcome that
        // leaves the caller with no idea the command never completed. The
        // `finally` below clears it the moment the answer arrives.
        timer = setTimeout(() => reject(new Error('__console_send_timeout__')), timeoutMs);
      });
      try {
        await Promise.race([work, timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    } else {
      await work;
    }
    return this.struct;
  }
}

// ---------------------------------------------------------------------------
// the front-end — console/Main.cpp
// ---------------------------------------------------------------------------

/**
 * The console host: one `ProcessEvent` per request, against a real terminal.
 *
 * @param {object} options
 *   stdout, stderr   objects with `write(Buffer)`; defaults to process streams
 *   stdin            a stream, Buffer or string for the redirected-input path
 *   keys             a KeySource for the interactive path
 *   outputType       FILE_TYPE.*; derived from the stream when omitted
 *   inputType        FILE_TYPE.*; derived from the stream when omitted
 *   sleep            (ms) => Promise, injected so Choice's timeout is testable
 */
class ConsoleHost {
  constructor(options = {}) {
    this.standardOutput = options.stdout === undefined ? process.stdout : options.stdout;
    this.errorOutput = options.stderr === undefined ? process.stderr : options.stderr;
    this.output = this.standardOutput;

    this.inputType = options.inputType === undefined
      ? fileTypeOf(options.stdinStream || options.stdin) : options.inputType;
    // Until INIT arrives the front-end has not decided which stream it prints
    // to, so the output type is only sampled there. Before that it is unknown,
    // exactly as the static in the C++ starts at FILE_TYPE_UNKNOWN.
    this.outputType = options.outputType === undefined ? FILE_TYPE.UNKNOWN : options.outputType;
    this._explicitOutputType = options.outputType !== undefined;

    this.outputFormat = STDINOUT.OFF;
    this.inputFormat = STDINOUT.OFF;

    this.source = options.source
      || new ByteSource(options.stdinStream || options.stdin || null);
    this.keys = options.keys || null;

    // Sleep(Timer) in ProcessChoiceEvent. The redirected-input branch that
    // uses it has *nothing* else pending — stdin is a file that has already
    // been read to the end — so the timer must be a real one. Unref'd, a
    // timeouting prompt on `winscp.com < script.txt` would end the process
    // during the wait instead of waking up and taking the timeout answer.
    this.sleep = options.sleep || ((ms) => new Promise((resolve) => { setTimeout(resolve, ms); }));

    this.channel = null;
    // LastFromBeginning: the progress line the front-end has been handed but
    // not yet written, because the output is a file or a pipe and there is no
    // way to take a line back once it is written.
    this._lastFromBeginning = '';
    this._titlePushed = false;
    this.titles = [];
  }

  attach(channel) {
    this.channel = channel;
    channel.setHandler((struct) => this.processEvent(struct));
    return channel;
  }

  get redirected() {
    return this.outputType === FILE_TYPE.DISK || this.outputType === FILE_TYPE.PIPE;
  }

  get inputRedirected() {
    return this.inputType === FILE_TYPE.DISK || this.inputType === FILE_TYPE.PIPE;
  }

  // ---- writing ----------------------------------------------------------

  _write(buffer, stream) {
    const target = stream || this.output;
    if (!target || typeof target.write !== 'function') return;
    target.write(Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer), 'utf8'));
  }

  /**
   * The redirected-output writer: UTF-8 bytes with every `\n` turned into
   * `\r\n`, because a redirected WinSCP log is expected to open correctly in
   * Notepad. The conversion is unconditional, matching the C++ `memmove` loop —
   * an already-CRLF input therefore gains a second CR. WinSCP never sends one,
   * and "fixing" it here would make the two implementations disagree.
   */
  _printRaw(message) {
    this._write(Buffer.from(String(message).split('\n').join('\r\n'), 'utf8'));
  }

  /**
   * Print(FromBeginning, Message) — the whole reason progress rendering works
   * in both a terminal and a redirect.
   *
   * On a console, `fromBeginning` is a carriage return: the next write lands on
   * top of the previous line, which is how the transfer percentage counts up in
   * place. On a file or a pipe there is no cursor to move, so a `fromBeginning`
   * line is *held*: it is written only when a normal line arrives after it, and
   * every held line before that is dropped. The redirected log therefore
   * records the last state of each progress line and not five thousand of them.
   */
  print(fromBeginning, message) {
    const text = message === undefined || message === null ? '' : String(message);
    if (this.redirected) {
      if (fromBeginning && text[0] !== '\n') {
        this._lastFromBeginning = text;
        return;
      }
      if (this._lastFromBeginning !== '') {
        this._printRaw(this._lastFromBeginning);
        this._lastFromBeginning = '';
      }
      if (fromBeginning && text[0] === '\n') {
        this._printRaw('\n');
        this._lastFromBeginning = text.slice(1);
      } else {
        this._printRaw(text);
      }
      this.flush();
      return;
    }
    if (fromBeginning) this._write(Buffer.from('\r', 'utf8'));
    this._write(Buffer.from(text, 'utf8'));
  }

  /** fflush(stdout), which the original only does for a file or a pipe. */
  flush() {
    if (!this.redirected) return;
    const target = this.output;
    if (target && typeof target.flush === 'function') target.flush();
  }

  /**
   * PrintException. Note it goes to the *current* output with no newline and no
   * CRLF translation: at the point this runs the front-end may not have
   * negotiated anything yet, so it uses the narrowest possible path.
   */
  printException(error) {
    const message = error && error.message ? error.message : String(error);
    if (this.output) this._write(Buffer.from(message, 'utf8'));
  }

  // ---- the events -------------------------------------------------------

  processPrintEvent(event) {
    this.print(event.fromBeginning, event.message);
  }

  /**
   * ProcessInputEvent.
   *
   * Redirected input is the unattended case and it is the important one: the
   * front-end reads a line, **echoes it back to the output** followed by a
   * newline (so the transcript shows what was answered), and reports success
   * when anything at all was read. At end of input it reports failure, which is
   * what turns "the script asked a question nobody can answer" into an abort
   * rather than an infinite wait.
   */
  async processInputEvent(event) {
    if (this.inputRedirected) {
      const { data, ok } = await this.source.readLine(LIMITS.INPUT_STR * 3 - 1);
      const str = fitString(data.toString('utf8'), LIMITS.INPUT_STR);
      event.str = str;

      this.print(false, str);
      this.print(false, '\n');

      event.result = ok || data.length > 0;
      return;
    }

    // Interactive: read a line of keys. The timer is *idle* based — any key
    // restarts it — so a prompt left alone times out but a slow answer does
    // not, and a cancel (Ctrl+C, handled by the control handler) discards the
    // line rather than submitting a partial one.
    if (!this.keys) {
      event.str = '';
      event.result = false;
      return;
    }
    if (typeof this.keys.setRawMode === 'function') this.keys.setRawMode(true);
    let line = '';
    let cancelled = false;
    let timedOut = false;
    let eof = false;
    try {
      for (;;) {
        const key = await this.keys.readKey(event.timer > 0 ? event.timer : 0);
        if (key === null) { timedOut = true; break; }
        if (key === undefined) { eof = true; break; }
        if (key.enter) break;
        if (key.ctrl && key.char === 'C') { this.cancelInput(); cancelled = true; break; }
        if (key.backspace) {
          if (line.length > 0) {
            line = line.slice(0, -1);
            if (event.echo) this._write(Buffer.from('\b \b', 'utf8'));
          }
          continue;
        }
        if (key.escape || key.ctrl) continue;
        if (line.length >= LIMITS.INPUT_STR - 1) continue;
        line += key.char;
        if (event.echo) this._write(Buffer.from(key.char, 'utf8'));
      }
    } finally {
      if (typeof this.keys.setRawMode === 'function') this.keys.setRawMode(false);
    }

    const pendingCancel = this.channel ? this.channel.consumeCancel() : false;
    // The C++ writes this newline only for a cancel or a non-echoing prompt,
    // because the Win32 console echoes the Enter key itself. Reading keys in
    // raw mode means nothing echoes anything, so the port writes it for the
    // ordinary case too — otherwise the answer and the next line of output run
    // together on one line.
    if (pendingCancel || cancelled || !event.echo) {
      this._write(Buffer.from('\n', 'utf8'));
      this.flush();
    } else {
      this._write(Buffer.from('\n', 'utf8'));
    }

    event.str = line;
    // An *empty* answer is still an answer: ReadConsole returns the line
    // terminator, so a bare Enter is a successful read of "". Only a cancel, a
    // timeout or end of input make the read fail, and only those three abort
    // the script rather than answering it.
    event.result = !(pendingCancel || cancelled || timedOut || eof);
  }

  /**
   * ProcessChoiceEvent — the prompt handling that decides what an unattended
   * run does when WinSCP asks a question.
   *
   * With redirected input there is nobody to answer, and the two answers are
   * deliberately different:
   *   * a *timeouting* prompt (one WinSCP would have auto-answered after N
   *     seconds anyway) waits out its timer and takes the timeout answer, so a
   *     script behaves the same way it would have on screen;
   *   * every other prompt takes the **break** answer — the abort — rather than
   *     a default. That is the refusal that keeps `winscp.com < script.txt`
   *     from silently overwriting a file because nobody said no.
   *
   * Note the C++ comment: input can still be a character device when only the
   * *output* was redirected, so this branch keys off the input type alone.
   */
  async processChoiceEvent(event) {
    if (this.inputRedirected) {
      if (event.timeouting) {
        await this.sleep(event.timer);
        event.result = event.timeouted;
      } else {
        event.result = event.break;
      }
      return;
    }

    event.result = 0;
    if (!this.keys) { event.result = event.break; return; }
    if (typeof this.keys.setRawMode === 'function') this.keys.setRawMode(true);
    const slice = 50;
    let remaining = event.timer;
    try {
      do {
        const key = await this.keys.readKey(slice);
        if (key === undefined) { event.result = event.break; break; }
        if (key !== null) {
          if (this.channel && this.channel.consumeCancel()) {
            event.result = event.break;
          } else if (key.escape) {
            event.result = event.cancel;
          } else if (!key.ctrl && !key.alt && key.char) {
            // CharUpperBuff: the options are matched case-insensitively, and
            // the *position* in the option string is the answer, one-based.
            const index = String(event.options).indexOf(key.char.toUpperCase());
            if (index >= 0) event.result = index + 1;
          }
        }

        if (event.result === 0 && event.timer > 0) {
          if (remaining > slice) remaining -= slice;
          else event.result = event.timeouted;
        }
      } while (event.result === 0);
    } finally {
      if (typeof this.keys.setRawMode === 'function') this.keys.setRawMode(false);
    }
  }

  /**
   * SetConsoleTitle. There is no Win32 console here, so the port emits the
   * OSC 2 sequence every terminal emulator understands, and only when the
   * output is a character device — writing it into a redirected log would put
   * escape bytes in a file somebody greps.
   */
  processTitleEvent(event) {
    const title = fitString(event.title, LIMITS.TITLE);
    this.titles.push(title);
    if (this.outputType !== FILE_TYPE.CHAR) return;
    if (!this._titlePushed) {
      // xterm's title stack, standing in for the GetConsoleTitle/SetConsoleTitle
      // save-and-restore pair the original does around the whole run.
      this._write(Buffer.from('[22;2t', 'utf8'), this.standardOutput);
      this._titlePushed = true;
    }
    this._write(Buffer.from(`]2;${title}`, 'utf8'), this.standardOutput);
  }

  restoreTitle() {
    if (!this._titlePushed) return;
    this._write(Buffer.from('[23;2t', 'utf8'), this.standardOutput);
    this._titlePushed = false;
  }

  /**
   * ProcessInitEvent — the one negotiation in the protocol.
   *
   * The child says what it wants (`/stdout=`, `/stdin=`, and whether ordinary
   * output should move to stderr so the data stream on stdout stays clean); the
   * front-end answers with what it actually has (the two file types), and every
   * behavioural decision on both sides is derived from that answer.
   *
   * `WantsProgress` is answered **false** unconditionally. `winscp.com` renders
   * progress by printing a line, not by consuming PROGRESS events — which is
   * why PROGRESS is one of the two events it refuses outright.
   */
  processInitEvent(event) {
    if (event.useStdErr) this.output = this.errorOutput;

    this.outputFormat = event.outputFormat;
    this.inputFormat = event.inputFormat;

    if (!this._explicitOutputType) this.outputType = fileTypeOf(this.output);

    event.inputType = this.inputType;
    event.outputType = this.outputType;
    // "default anyway" in the C++, and load-bearing: the client copies this
    // back into its own flag.
    event.wantsProgress = false;
  }

  /**
   * TRANSFEROUT: the bytes of a download, on their way to stdout.
   *
   * `chunked` writes each block with an HTTP-style hex length so a caller
   * reading a single stream can tell where one file ends. A zero-length chunk
   * is the terminator, and the client sends exactly one of those at the end of
   * every transfer.
   */
  processTransferOutEvent(event) {
    const data = Buffer.isBuffer(event.data) ? event.data.subarray(0, event.len) : Buffer.alloc(0);
    if (this.outputFormat === STDINOUT.BINARY) {
      this._write(data, this.standardOutput);
    } else if (this.outputFormat === STDINOUT.CHUNKED) {
      this._write(Buffer.from(`${event.len.toString(16)}\r\n`, 'utf8'), this.standardOutput);
      this._write(data, this.standardOutput);
      this._write(Buffer.from('\r\n', 'utf8'), this.standardOutput);
    }
    // STDINOUT.OFF: the child asked for no stream, so the bytes are dropped
    // rather than corrupting the message output. This is the C++ behaviour.
  }

  /**
   * TRANSFERIN: bytes for an upload, read from stdin.
   *
   * A short read is *not* an error — it is the end of the file, and the length
   * is reported back so the client stops. A stream error is a different
   * outcome: it sets `error`, and the client turns that into a failed upload
   * rather than a successful upload of a truncated file.
   */
  async processTransferInEvent(event) {
    const want = event.len;
    const data = await this.source.read(want);
    if (data.length !== want) {
      if (this.source.failed) {
        event.error = true;
      } else {
        event.len = data.length;
      }
    }
    event.data = data;
  }

  /**
   * ProcessEvent. Two refusals live here and both are deliberate: an
   * unconfirmed protocol version means the two binaries do not match, and
   * NONE/PROGRESS are events this front-end does not implement. Answering them
   * with a shrug would leave the child waiting for a response it can never use.
   */
  /**
   * Deliberately not `async`. PRINT, TITLE, INIT and TRANSFEROUT complete
   * without ever yielding, and the client relies on that: `Print` is a blocking
   * call in the original, and its callers — `ConsoleRunner.print`, the progress
   * line, `TransferOut` — do not wait for it. Wrapping those in a promise would
   * let a script finish and its output arrive afterwards, which is exactly the
   * bug where a redirected log comes out empty.
   *
   * Two refusals live here and both are deliberate: an unconfirmed protocol
   * version means the two binaries do not match, and NONE/PROGRESS are events
   * this front-end does not implement. Answering them with a shrug would leave
   * the child waiting for a response it can never use.
   */
  processEvent(struct) {
    if (struct.version !== PROTOCOL.CURRENT_VERSION_CONFIRMED) {
      throw new ConsoleError(MSG.INCOMPATIBLE_VERSION, RESULT.PROCESSING_ERROR);
    }

    switch (struct.event) {
      case EVENT.PRINT: this.processPrintEvent(struct.print); return undefined;
      case EVENT.TITLE: this.processTitleEvent(struct.title); return undefined;
      case EVENT.INIT: this.processInitEvent(struct.init); return undefined;
      case EVENT.TRANSFEROUT: this.processTransferOutEvent(struct.transfer); return undefined;
      case EVENT.INPUT: return this.processInputEvent(struct.input);
      case EVENT.CHOICE: return this.processChoiceEvent(struct.choice);
      case EVENT.TRANSFERIN: return this.processTransferInEvent(struct.transfer);
      case EVENT.NONE:
      case EVENT.PROGRESS:
      default:
        throw new ConsoleError(MSG.UNKNOWN_EVENT, RESULT.PROCESSING_ERROR);
    }
  }

  // ---- the control handler ---------------------------------------------

  /** CancelInput: SetEvent(CancelEvent). */
  cancelInput() {
    if (this.channel) this.channel.cancel();
  }

  /**
   * HandlerRoutine. Ctrl+C and Ctrl+Break cancel the current operation and the
   * front-end keeps running — that is what lets `keepuptodate` be stopped
   * without losing the session log. Any other control event (close, logoff,
   * shutdown) kills the child and lets the default handler take the process
   * down, because there is no time to unwind.
   */
  handleControlEvent(type, finalizeChild) {
    if (type === 'SIGINT' || type === 'SIGBREAK') {
      this.cancelInput();
      return true;
    }
    if (typeof finalizeChild === 'function') finalizeChild();
    return false;
  }
}

/**
 * GetFileType. Node exposes `isTTY` for the character-device case; for the
 * other two the file descriptor's own stat tells a regular file from a pipe,
 * and that distinction matters — see `print`.
 */
function fileTypeOf(stream) {
  if (!stream) return FILE_TYPE.UNKNOWN;
  if (stream.isTTY) return FILE_TYPE.CHAR;
  if (typeof stream.fd === 'number') {
    try {
      const st = fs.fstatSync(stream.fd);
      if (st.isFile()) return FILE_TYPE.DISK;
      if (st.isFIFO() || st.isSocket()) return FILE_TYPE.PIPE;
      if (st.isCharacterDevice()) return FILE_TYPE.CHAR;
    } catch { /* fall through to UNKNOWN */ }
  }
  // A test double or an in-memory buffer: treat it as a pipe, which is the
  // conservative choice (no cursor movement, flushed writes).
  return FILE_TYPE.PIPE;
}

// ---------------------------------------------------------------------------
// the child side — TExternalConsole in windows/ConsoleRunner.cpp
// ---------------------------------------------------------------------------

/**
 * The console object the scripting engine actually holds.
 *
 * It implements the same surface as `consolerunner.js`'s `ConsoleBase`, so
 * `ConsoleRunner` drives it without knowing whether it is talking to a terminal
 * directly or to a front-end across a channel. Everything it does is: fill the
 * shared struct, send, read the answer back.
 */
class ExternalConsole {
  constructor(channel, options = {}) {
    this.channel = channel;
    this.noInteractiveInput = !!options.noInteractiveInput;
    this.stdOut = options.stdOut || STDINOUT.OFF;
    this.stdIn = options.stdIn || STDINOUT.OFF;
    this.sendTimeout = options.sendTimeout === undefined ? 0 : options.sendTimeout;

    this.limitedOutput = false;
    this.liveOutput = false;
    this.pipeOutput = false;
    this.interactive = false;
    this.wantsProgress = false;
    this.maxSend = 0;
    this.logProtocol = options.logProtocol || 0;
    this.now = options.now || (() => Date.now());

    // FTP calls TransferOut/In from another thread, so the original guards the
    // struct with a critical section. Node has no preemption, so the only
    // hazard left is two *awaiting* operations interleaving on the shared
    // struct: the asynchronous events therefore go through one chain, and the
    // synchronous ones (print, title, transfer out) need no guard at all —
    // which is what lets them stay synchronous, as their callers require.
    this._lock = Promise.resolve();

    const version = channel.struct.version;
    if (version !== PROTOCOL.CURRENT_VERSION) {
      throw new Error(MSG.EXTERNAL_CONSOLE_INCOMPATIBLE(version));
    }
    channel.struct.version = PROTOCOL.CURRENT_VERSION_CONFIRMED;
  }

  /** Serialize access to the one shared struct. */
  _guard(fn) {
    const run = this._lock.then(fn, fn);
    this._lock = run.then(() => undefined, () => undefined);
    return run;
  }

  /** SendEvent for an event the front-end answers without yielding. */
  _sendSync() {
    const start = this.logProtocol >= 1 ? this.now() : 0;
    const struct = this.channel.sendSync();
    if (this.logProtocol >= 1) this.maxSend = Math.max(this.now() - start, this.maxSend);
    return struct;
  }

  /** SendEvent: request, wait for response, and time the round trip. */
  async _send() {
    const start = this.logProtocol >= 1 ? this.now() : 0;
    try {
      await this.channel.send(this.sendTimeout);
    } catch (e) {
      if (e && e.message === '__console_send_timeout__') {
        let message = MSG.CONSOLE_SEND_TIMEOUT;
        if (this.pipeOutput) message = `${message} ${MSG.CONSOLE_SEND_PIPE}`;
        throw new Error(message);
      }
      throw e;
    }
    if (this.logProtocol >= 1) {
      this.maxSend = Math.max(this.now() - start, this.maxSend);
    }
    return this.channel.struct;
  }

  /**
   * Init. The flags derived here decide everything downstream: whether the
   * progress line may be rewritten, whether file names get shortened to fit,
   * and whether the script may prompt at all.
   */
  init() {
    const s = this.channel.struct;
    s.event = EVENT.INIT;
    s.init.wantsProgress = false;
    // Ordinary output moves to stderr whenever stdout is carrying file data,
    // so a caller piping a download does not get log lines mixed into it.
    s.init.useStdErr = this.stdOut !== STDINOUT.OFF;
    s.init.outputFormat = this.stdOut;
    s.init.inputFormat = this.stdIn;
    this._sendSync();

    this.limitedOutput = s.init.outputType === FILE_TYPE.CHAR;
    this.liveOutput = s.init.outputType !== FILE_TYPE.DISK
      && s.init.outputType !== FILE_TYPE.PIPE;
    // WinSCP writes `!= FILE_TYPE_PIPE` here, which is plainly inverted: the
    // flag exists only to add "make sure the pipe is being read from" to a
    // send-timeout message, and that hint is useful precisely when the output
    // IS a pipe. The intent is ported; the typo is not, because porting it
    // would attach the hint to every case except the one it describes.
    this.pipeOutput = s.init.outputType === FILE_TYPE.PIPE;
    this.interactive = s.init.inputType !== FILE_TYPE.DISK
      && s.init.inputType !== FILE_TYPE.PIPE;
    this.wantsProgress = s.init.wantsProgress;
    return this;
  }

  hasFlag(flag) {
    switch (flag) {
      case 'limitedOutput': return this.limitedOutput;
      case 'liveOutput': return this.liveOutput;
      case 'noInteractiveInput': return this.noInteractiveInput;
      case 'interactive': return this.interactive;
      // cfCommandLineOnly is always true for an external console: there is no
      // GUI behind it that could offer a dialog instead.
      case 'commandLineOnly': return true;
      case 'wantsProgress': return this.wantsProgress;
      case 'stdOut': return this.stdOut !== STDINOUT.OFF;
      case 'stdIn': return this.stdIn !== STDINOUT.OFF;
      default: return false;
    }
  }

  /**
   * Print, chunked to the struct's message field. An empty string still sends
   * one event — that is how a bare newline and the end-of-run progress flush
   * get across.
   */
  print(text, fromBeginning = false, isError = false) {
    let rest = text === undefined || text === null ? '' : String(text);
    let first = fromBeginning;
    const max = LIMITS.PRINT_MESSAGE - 1;
    do {
      const s = this.channel.struct;
      s.event = EVENT.PRINT;
      s.print.message = rest.slice(0, max);
      s.print.fromBeginning = first;
      s.print.error = !!isError;
      rest = rest.slice(max);
      // A continuation must append, never overwrite the piece before it.
      first = false;
      this._sendSync();
    } while (rest !== '');
  }

  printLine(text = '', isError = false) {
    return this.print(`${text}\n`, false, isError);
  }

  /**
   * Input. `null` means "no answer available" — end of input, a cancel, or a
   * timeout — and every caller treats that as an abort rather than as an empty
   * answer, which is what stops an unattended script from confirming things by
   * accident.
   */
  async input(echo = true, timeoutMs = 0) {
    return this._guard(async () => {
      const s = this.channel.struct;
      s.event = EVENT.INPUT;
      s.input.echo = !!echo;
      s.input.result = false;
      s.input.str = '';
      s.input.timer = timeoutMs > 0 ? timeoutMs : 0;
      await this._send();
      if (!s.input.result) return null;
      return trimNewLine(s.input.str);
    });
  }

  /**
   * Choice. The struct's `result` is pre-set to `break`, so a front-end that
   * answers nothing at all still produces the abort answer rather than zero,
   * which is not a valid option index.
   */
  async choice(options, cancel, brk, cont, timeouted, timeouting, timer, message = '') {
    return this._guard(async () => {
      const s = this.channel.struct;
      s.event = EVENT.CHOICE;
      s.choice.options = fitString(options, LIMITS.CHOICE_OPTIONS);
      s.choice.cancel = cancel;
      s.choice.break = brk;
      s.choice.result = brk;
      s.choice.continue = cont;
      s.choice.timeouted = timeouted;
      s.choice.timer = timer;
      s.choice.timeouting = !!timeouting;
      s.choice.message = fitString(message, LIMITS.CHOICE_MESSAGE);
      await this._send();
      return s.choice.result;
    });
  }

  setTitle(title) {
    const s = this.channel.struct;
    s.event = EVENT.TITLE;
    s.title.title = fitString(title, LIMITS.TITLE);
    this._sendSync();
  }

  /** PendingAbort — consuming, because the cancel event is auto-reset. */
  pendingAbort() { return this.channel.consumeCancel(); }

  finalLogMessage() { return `Max roundtrip: ${this.maxSend}`; }

  /**
   * Progress. `winscp.com` refuses this event, and it never arrives there
   * because `WantsProgress` comes back false — the guard is the same one the
   * C++ relies on. A host that does want structured progress (the .NET
   * assembly's) answers true and receives these.
   */
  async progress(progress) {
    return this._guard(async () => {
      const s = this.channel.struct;
      s.event = EVENT.PROGRESS;
      s.progress.operation = 'copy';
      s.progress.side = progress.side === 'remote' ? 'remote' : 'local';
      s.progress.fileName = fitString(progress.fileName, LIMITS.PROGRESS_FILENAME);
      s.progress.directory = fitString(progress.directory, LIMITS.PROGRESS_DIRECTORY);
      s.progress.overallProgress = progress.overallProgress || 0;
      s.progress.fileProgress = progress.fileProgress || 0;
      s.progress.cps = progress.cps || 0;
      s.progress.cancel = !!progress.cancel;
      await this._send();
      return s.progress.cancel;
    });
  }

  /**
   * TransferOut, chunked at the struct's data size. A zero-length call still
   * sends one event, which is the end-of-stream marker in chunked mode.
   */
  transferOut(buffer) {
    const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
    let offset = 0;
    do {
      const s = this.channel.struct;
      const blockLen = Math.min(data.length - offset, LIMITS.TRANSFER_DATA);
      s.event = EVENT.TRANSFEROUT;
      s.transfer.data = Buffer.from(data.subarray(offset, offset + blockLen));
      s.transfer.len = blockLen;
      s.transfer.error = false;
      offset += blockLen;
      this._sendSync();
    } while (offset < data.length);
  }

  /**
   * TransferIn for one buffer's worth. The loop stops on the first short read,
   * which is how end-of-file is detected; a stream error is raised instead,
   * because uploading a truncated file silently is the worst outcome available.
   */
  async transferInBlock(len) {
    return this._guard(async () => {
      const want = len === undefined ? LIMITS.TRANSFER_DATA : len;
      const chunks = [];
      let offset = 0;
      let result = 0;
      while (result === offset && offset < want) {
        const s = this.channel.struct;
        const blockLen = Math.min(want - offset, LIMITS.TRANSFER_DATA);
        s.event = EVENT.TRANSFERIN;
        s.transfer.len = blockLen;
        s.transfer.error = false;
        s.transfer.data = Buffer.alloc(0);
        await this._send();
        if (s.transfer.error) throw new Error(MSG.STREAM_READ_ERROR);
        result += s.transfer.len;
        chunks.push(Buffer.from(
          Buffer.isBuffer(s.transfer.data) ? s.transfer.data.subarray(0, s.transfer.len)
            : Buffer.alloc(0)));
        offset += blockLen;
      }
      return Buffer.concat(chunks);
    });
  }

  /**
   * The whole of stdin, which is what `put` from a stream needs: block after
   * block until one comes back short.
   */
  async transferIn() {
    const chunks = [];
    for (;;) {
      const block = await this.transferInBlock(LIMITS.TRANSFER_DATA);
      if (block.length === 0) break;
      chunks.push(block);
      if (block.length < LIMITS.TRANSFER_DATA) break;
    }
    return Buffer.concat(chunks);
  }
}

/** TrimNewLine: the console hands back the line terminator it read. */
function trimNewLine(str) {
  return String(str === undefined || str === null ? '' : str).replace(/\r?\n$/, '');
}

// ---------------------------------------------------------------------------
// wmain
// ---------------------------------------------------------------------------

/**
 * The front-end's main loop and its exit-code contract.
 *
 * The four non-zero results are the front-end's *own* failures and they are
 * distinct on purpose, because they tell a caller where to look:
 *
 *   1 GLOBAL_ERROR      failed before the console objects existed
 *   2 INIT_ERROR        failed while starting the child
 *   3 PROCESSING_ERROR  an event could not be served (version mismatch,
 *                       unknown event, a broken output stream)
 *   4 UNKNOWN_ERROR     nothing set a result at all — the loop never ran
 *
 * When the child runs to completion its own exit code wins, and that is the
 * code scripts actually test: 0 when nothing failed, 1 when anything did.
 * These four never collide with it except at 1, where "the front-end broke" and
 * "the script reported an error" are both failures anyway.
 *
 * @param {object} options
 *   host      a ConsoleHost
 *   channel   a CommChannel already attached to the host
 *   child     () => Promise<number>, the thing that speaks the protocol
 *   initialize/finalize hooks, for the object lifetime
 */
async function runConsoleHost(options = {}) {
  const host = options.host;
  const channel = options.channel;
  const child = options.child;
  let result = RESULT.UNKNOWN_ERROR;

  try {
    if (typeof options.initialize === 'function') options.initialize();

    try {
      if (typeof child !== 'function') {
        throw new ConsoleError(MSG.CANNOT_START(options.childPath || ''), RESULT.INIT_ERROR);
      }

      let childResult;
      let childError = null;
      try {
        childResult = await child();
      } catch (e) {
        childError = e;
      }

      // A failure serving an event outranks whatever the child made of it. In
      // Win32 the child is not even alive to have an opinion — the front-end
      // terminates it — so the front-end's own code is what the caller sees.
      const hostError = channel ? channel.hostError : null;
      if (hostError) {
        host.printException(hostError);
        result = hostError instanceof ConsoleError && hostError.result !== undefined
          ? hostError.result : RESULT.PROCESSING_ERROR;
      } else if (childError) {
        host.printException(childError);
        result = childError instanceof ConsoleError && childError.result !== undefined
          ? childError.result : RESULT.PROCESSING_ERROR;
      } else {
        // "flush pending progress message": with a redirected output the last
        // progress line is still being held, and this empty non-fromBeginning
        // print is what commits it. Without it a redirected log loses its final
        // progress line every single run.
        host.print(false, '');
        result = typeof childResult === 'number' ? childResult : RESULT.SUCCESS;
      }

      if (typeof options.finalizeChild === 'function') options.finalizeChild();
      host.restoreTitle();
    } catch (e) {
      host.printException(e);
      result = e instanceof ConsoleError && e.result === RESULT.GLOBAL_ERROR
        ? RESULT.GLOBAL_ERROR : RESULT.INIT_ERROR;
    }

    if (typeof options.finalize === 'function') options.finalize();
    if (channel) channel.close();
  } catch (e) {
    host.printException(e);
    result = RESULT.GLOBAL_ERROR;
  }

  return result;
}

/**
 * Build a matched front-end/child pair over one channel. This is what
 * `InitializeConsole` + `InitializeChild` produce, minus the process boundary.
 */
async function createConsolePair(options = {}) {
  const instance = options.instance
    || makeInstanceName(options.pid === undefined ? process.pid : options.pid,
      options.random, options.instanceExists);
  const channel = new CommChannel({ instance });
  const host = options.host || new ConsoleHost(options.hostOptions || {});
  host.attach(channel);
  const client = new ExternalConsole(channel, options.clientOptions || {});
  client.init();
  return { instance, channel, host, client };
}

/**
 * The whole front-end: parse the switches that belong to it, stand up the
 * terminal side, hand the child a console, and return the exit code.
 *
 * This is the seam between this file and the scripting engine. `runConsole` in
 * `consolerunner.js` is the child: it is handed an `ExternalConsole` in place
 * of the terminal it would otherwise open for itself, and it neither knows nor
 * cares that every print it makes is crossing a channel.
 *
 * @param {string[]} argv  the front-end's own arguments (no executable)
 * @param {object} deps
 *   runChild(argv, { console }) => Promise<number>, defaults to consolerunner
 *   stdout/stderr/stdin, keys, productVersion, and the ConsoleHost overrides
 */
async function runConsoleFrontEnd(argv = [], deps = {}) {
  const params = new Options();
  for (const a of argv) params.add(a);

  // wmain samples `GetFileType(GetStdHandle(STD_INPUT_HANDLE))` before it does
  // anything else, and everything about prompting hangs off the answer. Nothing
  // here can sample a handle the caller never named, so when no input dependency
  // was supplied at all the real process stdin is wired up the same way the
  // original wires the real handle: a character device becomes a key source (the
  // interactive branch reads keys, not lines), and a file or a pipe becomes the
  // byte source the redirected branch reads a line at a time.
  //
  // Without this a front-end started for real reported FILE_TYPE_UNKNOWN, which
  // reads as "interactive" while having no keyboard and no bytes — so
  // `winscp-com /console < script.txt` saw end of input immediately and ran
  // nothing at all.
  const stdinDeps = {
    stdin: deps.stdin, stdinStream: deps.stdinStream, source: deps.source,
    keys: deps.keys, inputType: deps.inputType,
  };
  const wireProcessStdin = deps.host === undefined
    && Object.keys(stdinDeps).every((k) => stdinDeps[k] === undefined);
  if (wireProcessStdin) {
    const processStdin = deps.processStdin || process.stdin;
    stdinDeps.inputType = fileTypeOf(processStdin);
    if (stdinDeps.inputType === FILE_TYPE.CHAR) stdinDeps.keys = new TtyKeySource(processStdin);
    else stdinDeps.stdinStream = processStdin;
  }

  const host = deps.host || new ConsoleHost({
    stdout: deps.stdout,
    stderr: deps.stderr,
    stdin: stdinDeps.stdin,
    stdinStream: stdinDeps.stdinStream,
    keys: stdinDeps.keys,
    inputType: stdinDeps.inputType,
    outputType: deps.outputType,
    source: stdinDeps.source,
    sleep: deps.sleep,
  });

  let stdOut;
  let stdIn;
  try {
    stdOut = parseStdInOutMode(params, 'stdout', true);
    stdIn = parseStdInOutMode(params, 'stdin', false);
  } catch (e) {
    // A bad /stdout= value is fatal before anything has been printed, and it is
    // reported the same way any other front-end failure is.
    host.printException(e);
    return RESULT.PROCESSING_ERROR;
  }

  const noInteractiveInput = params.findSwitch('nointeractiveinput') || stdIn !== STDINOUT.OFF;

  // InitializeConsole and GetProductVersion both run inside wmain's outermost
  // try, whose catch is RESULT_GLOBAL_ERROR — "the front-end failed before the
  // console objects existed". Letting either of them throw out of this function
  // instead would give the caller a rejected promise where the original gives it
  // exit code 1, and a shell cannot test a rejected promise.
  let instance;
  let childArgv;
  try {
    instance = deps.instance
      || makeInstanceName(deps.pid === undefined ? process.pid : deps.pid,
        deps.random, deps.instanceExists);
    const productVersion = deps.productVersion || readProductVersion(deps);
    childArgv = buildChildArgv(argv, instance, { productVersion });
  } catch (e) {
    host.printException(e);
    return RESULT.GLOBAL_ERROR;
  }

  const channel = new CommChannel({ instance });
  host.attach(channel);

  const uninstallControl = deps.installControlHandler === false
    ? () => {} : installControlHandler(host, { emitter: deps.signalEmitter });

  return runConsoleHost({
    host,
    channel,
    childPath: deps.childPath || '',
    finalize: () => { uninstallControl(); if (deps.onFinalize) deps.onFinalize(); },
    child: async () => {
      const client = new ExternalConsole(channel, {
        noInteractiveInput,
        stdOut,
        stdIn,
        sendTimeout: deps.sendTimeout,
        logProtocol: deps.logProtocol,
        now: deps.now,
      });
      client.init();
      const runChild = deps.runChild
        || ((args, childDeps) => require('./consolerunner').runConsole(args, childDeps));
      return runChild(childArgv, { ...(deps.childDeps || {}), console: client });
    },
  });
}

/**
 * SetConsoleCtrlHandler. Ctrl+C must not kill the front-end — it has to reach
 * the child as a cancel so the session log is closed and the exit code is
 * reported. Node's default SIGINT handler terminates the process, so the
 * handler has to be installed for that to work at all.
 *
 * @returns {() => void} the uninstall, which the caller must run: leaving a
 *   SIGINT listener behind makes the next Ctrl+C do nothing.
 */
function installControlHandler(host, options = {}) {
  const emitter = options.emitter || process;
  const handlers = [];
  for (const signal of ['SIGINT', 'SIGBREAK']) {
    const handler = () => host.handleControlEvent(signal, options.finalizeChild);
    try {
      emitter.on(signal, handler);
      handlers.push([signal, handler]);
    } catch { /* the platform does not have this signal */ }
  }
  return () => {
    for (const [signal, handler] of handlers) {
      try { emitter.removeListener(signal, handler); } catch { /* already gone */ }
    }
  };
}

/** The product version stamped into `/console=`. */
function readProductVersion(deps = {}) {
  if (deps.productVersion) return deps.productVersion;
  try {
    const pkg = JSON.parse(fs.readFileSync(
      nodePath.join(__dirname, '..', '..', 'package.json'), 'utf8'));
    return pkg.version;
  } catch {
    throw new ConsoleError(MSG.PRODUCT_VERSION, RESULT.GLOBAL_ERROR);
  }
}

module.exports = {
  OBJECT_PREFIX,
  PROTOCOL,
  EVENT,
  STDINOUT,
  FILE_TYPE,
  LIMITS,
  RESULT,
  MSG,
  CONSOLE_CHILD_PARAM,
  ConsoleError,
  makeInstanceName,
  commObjectNames,
  formatProductVersion,
  splitCommandLine,
  deriveChildPath,
  findConsoleChild,
  quoteChildArgument,
  buildChildCommandLine,
  buildChildArgv,
  parseStdInOutMode,
  ByteSource,
  KeySource,
  TtyKeySource,
  decodeKeys,
  createCommStruct,
  fitString,
  CommChannel,
  ConsoleHost,
  fileTypeOf,
  ExternalConsole,
  trimNewLine,
  runConsoleHost,
  createConsolePair,
  runConsoleFrontEnd,
  installControlHandler,
  readProductVersion,
};
