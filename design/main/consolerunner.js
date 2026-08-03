// consolerunner.js — the thing that drives a script and decides the exit code.
//
// A port of `windows/ConsoleRunner.cpp` and the console abstractions in
// `console/Console.h`: the three console back-ends (own console, null console,
// and a capturing one that stands in for the external `winscp.com` pipe), the
// command loop, `%1%`/`%TIMESTAMP%` expansion, `/script=`, `/command`, stdin
// scripting, `/log` and `/xmllog`, and the exit-code contract.
//
// The exit-code contract is the part callers actually depend on and it is
// small: **0 when nothing failed, 1 when anything did.** "Anything" means a
// command reported an error (including a connection failure from `open`) or
// the run was aborted. It does not mean "the last command failed" — a script
// with `option batch continue` runs to the end and still exits 1 if any step
// along the way failed, which is what makes `if errorlevel 1` usable in a
// batch file.
'use strict';

const fs = require('fs');
const nodePath = require('path');

const {
  ManagementScript, Options, ScriptAbort, cutToken, syncOptionsFrom, MSG,
} = require('./script');
const { tryRelativeTime, resolveTime } = require('./masks');
const { SessionLog, xmlEscape } = require('./logging');

const RESULT_SUCCESS = 0;
const RESULT_ANY_ERROR = 1;

/** Parse `/loglevel` without accepting JavaScript-only numeric spellings. */
function parseLogLevel(value) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  if (text === '') return 0;

  // WinSCP also accepts the historical `*` sensitive-logging marker (and the
  // `*-` redaction marker). The port never enables sensitive output, but it
  // still validates and consumes the syntax instead of truncating it with
  // parseInt and silently changing an invalid value into level 0.
  const match = /^(-?\d+)(?:\*-?)?$/.exec(text);
  const level = match ? Number(match[1]) : NaN;
  if (!match || !Number.isSafeInteger(level) || level < -1) {
    throw new Error(`Unknown value '${value}' of option 'loglevel'.`);
  }
  return level;
}

/** Console capability flags — TConsoleFlag in console/Console.h. */
const CF = {
  INTERACTIVE: 'interactive',
  LIMITED_OUTPUT: 'limitedOutput',
  LIVE_OUTPUT: 'liveOutput',
  NO_INTERACTIVE_INPUT: 'noInteractiveInput',
  WANTS_PROGRESS: 'wantsProgress',
  STD_OUT: 'stdOut',
  STD_IN: 'stdIn',
};

const TIMESTAMP_VAR_NAME = 'TIMESTAMP';

// ---------------------------------------------------------------------------
// consoles
// ---------------------------------------------------------------------------

/**
 * The interface `TConsole` defines. Everything the runner prints, asks and
 * aborts on goes through one of these, so the same runner drives a terminal,
 * a pipe, and a test.
 */
class ConsoleBase {
  constructor(flags = {}) { this.flags = flags; }

  hasFlag(flag) { return !!this.flags[flag]; }

  print(/* text, fromBeginning, isError */) {}

  printLine(text = '', isError = false) { this.print(`${text}\n`, false, isError); }

  /** @returns {Promise<string|null>} null means "no more input" (EOF/abort). */
  async input(/* echo, timeoutMs */) { return null; }

  setTitle(/* title */) {}

  pendingAbort() { return false; }

  finalLogMessage() { return ''; }

  transferOut(/* buffer */) {}

  async transferIn() { return Buffer.alloc(0); }
}

/**
 * The real console: stdout/stderr for output, stdin for interactive commands.
 * `fromBeginning` rewrites the current line, which is how the progress line
 * updates in place — but only when the output is a TTY, because a redirected
 * stream cannot be rewritten and the carriage returns would be garbage in the
 * file.
 */
class StdConsole extends ConsoleBase {
  constructor(options = {}) {
    const out = options.stdout || process.stdout;
    const err = options.stderr || process.stderr;
    const live = options.liveOutput === undefined ? !!out.isTTY : !!options.liveOutput;
    super({
      [CF.INTERACTIVE]: options.interactive === undefined
        ? !!(options.stdin || process.stdin).isTTY : !!options.interactive,
      [CF.LIVE_OUTPUT]: live,
      [CF.LIMITED_OUTPUT]: live,
      [CF.NO_INTERACTIVE_INPUT]: !!options.noInteractiveInput,
      [CF.WANTS_PROGRESS]: !!options.wantsProgress,
      // The flag says "this stream carries transfer DATA"; the mode says how it
      // is framed. 'off' is a string and would be truthy, so the comparison is
      // explicit rather than a coercion.
      [CF.STD_OUT]: !!options.stdOut && options.stdOut !== 'off',
      [CF.STD_IN]: !!options.stdIn && options.stdIn !== 'off',
    });
    /**
     * The framing this console was asked for. `binary` writes the bytes
     * straight through, which is what this console does. `chunked` needs a
     * length prefix per block, and framing it is the console FRONT-END's job
     * (design/main/console.js, reached through bin/winscp-com.js) — asking for
     * it here is refused rather than silently downgraded, because a reader that
     * expects lengths and receives raw bytes cannot tell where a file ends.
     */
    this.stdOutMode = options.stdOut === undefined ? 'off' : String(options.stdOut);
    this.stdInMode = options.stdIn === undefined ? 'off' : String(options.stdIn);
    if (this.stdOutMode === 'chunked') {
      throw new Error(
        'Chunked /stdout framing needs the console front-end; run this through winscp-com rather than in-process.');
    }
    this.out = out;
    this.err = err;
    this.in = options.stdin || process.stdin;
    this._lineBuffer = '';
    this._lines = [];
    this._eof = false;
    this._waiters = [];
    this._reading = false;
    this._aborted = false;
  }

  print(text, fromBeginning = false, isError = false) {
    const stream = isError ? this.err : this.out;
    stream.write(fromBeginning && this.hasFlag(CF.LIVE_OUTPUT) ? `\r${text}` : text);
  }

  _startReading() {
    if (this._reading) return;
    this._reading = true;
    this.in.setEncoding('utf8');
    this.in.on('data', (chunk) => {
      this._lineBuffer += chunk;
      let i = this._lineBuffer.indexOf('\n');
      while (i >= 0) {
        this._lines.push(this._lineBuffer.slice(0, i).replace(/\r$/, ''));
        this._lineBuffer = this._lineBuffer.slice(i + 1);
        i = this._lineBuffer.indexOf('\n');
      }
      this._drain();
    });
    this.in.on('end', () => {
      if (this._lineBuffer !== '') { this._lines.push(this._lineBuffer); this._lineBuffer = ''; }
      this._eof = true;
      this._drain();
    });
    this.in.on('error', () => { this._eof = true; this._drain(); });
    if (typeof this.in.resume === 'function') this.in.resume();
  }

  _drain() {
    while (this._waiters.length && (this._lines.length || this._eof)) {
      const w = this._waiters.shift();
      w(this._lines.length ? this._lines.shift() : null);
    }
  }

  async input(echo = true, timeoutMs = 0) {
    void echo;
    if (this.hasFlag(CF.NO_INTERACTIVE_INPUT)) return null;
    this._startReading();
    if (this._lines.length) return this._lines.shift();
    if (this._eof) return null;
    return new Promise((resolve) => {
      let timer = null;
      const settle = (v) => { if (timer) clearTimeout(timer); resolve(v); };
      this._waiters.push(settle);
      if (timeoutMs > 0) {
        // NOT unref'd, for the same reason console.js's prompt timer is not:
        // this timer and an incoming line are the only two things that can
        // settle this promise. Unref'd, it does not hold the process open, so
        // when stdin is quiet the loop has nothing left to run and node exits
        // — code 0, no output, mid-prompt — instead of taking the timeout
        // branch and reporting it. `winscp.com` is this module, so that exit
        // is the shipped script host giving up silently on a timed prompt.
        timer = setTimeout(() => {
          const i = this._waiters.indexOf(settle);
          if (i >= 0) this._waiters.splice(i, 1);
          resolve(null);
        }, timeoutMs);
      }
    });
  }

  setTitle(title) {
    // The OSC 2 sequence is the portable equivalent of SetConsoleTitle; on a
    // non-TTY it would be noise in the redirected output, so it is skipped.
    if (this.hasFlag(CF.LIVE_OUTPUT)) this.out.write(`\u001b]2;${title}\u0007`);
  }

  pendingAbort() { return this._aborted; }

  abort() { this._aborted = true; }

  transferOut(buffer) { this.out.write(buffer); }

  async transferIn() {
    if (this.stdInMode === 'binary') {
      // Binary stdin is a byte stream, not a command stream. Do not route it
      // through the line reader: UTF-8 decoding and newline reconstruction
      // would corrupt arbitrary payload bytes and change their length.
      const chunks = [];
      for await (const chunk of this.in) chunks.push(Buffer.isBuffer(chunk)
        ? chunk : Buffer.from(chunk));
      return Buffer.concat(chunks);
    }
    this._startReading();
    const chunks = [];
    for (;;) {
      const line = await this.input(false, 0);
      if (line === null) break;
      chunks.push(Buffer.from(`${line}\n`, 'utf8'));
    }
    return Buffer.concat(chunks);
  }

  close() {
    if (this._reading && typeof this.in.pause === 'function') this.in.pause();
  }
}

/** TNullConsole: a script that should produce no output at all. */
class NullConsole extends ConsoleBase {
  constructor() { super({ [CF.NO_INTERACTIVE_INPUT]: true }); }
}

/**
 * A console that keeps everything it was given. This is the stand-in for the
 * external `winscp.com` console: the process on the other end of the pipe
 * collects output and feeds commands, which is exactly what this does in
 * memory. It is also what makes the whole runner testable headlessly.
 */
class BufferConsole extends ConsoleBase {
  constructor(options = {}) {
    super({
      [CF.INTERACTIVE]: !!options.interactive,
      [CF.LIVE_OUTPUT]: !!options.liveOutput,
      [CF.LIMITED_OUTPUT]: !!options.limitedOutput,
      [CF.NO_INTERACTIVE_INPUT]: options.input === undefined,
      [CF.WANTS_PROGRESS]: !!options.wantsProgress,
      [CF.STD_OUT]: !!options.stdOut && options.stdOut !== 'off',
      [CF.STD_IN]: !!options.stdIn && options.stdIn !== 'off',
    });
    this.stdOutMode = options.stdOut === undefined ? 'off' : String(options.stdOut);
    this.stdInMode = options.stdIn === undefined ? 'off' : String(options.stdIn);
    this.output = '';
    this.errors = '';
    this.lines = [];
    this.titles = [];
    this.transferred = [];
    this.stdinData = options.stdinData === undefined ? Buffer.alloc(0) : Buffer.from(options.stdinData);
    this._input = (options.input || []).slice();
    this._aborted = false;
  }

  print(text, fromBeginning = false, isError = false) {
    void fromBeginning;
    this.output += text;
    if (isError) this.errors += text;
    const parts = String(text).split('\n');
    for (let i = 0; i < parts.length - 1; i++) this.lines.push(parts[i]);
  }

  async input() {
    if (this.hasFlag(CF.NO_INTERACTIVE_INPUT)) return null;
    return this._input.length ? this._input.shift() : null;
  }

  setTitle(title) { this.titles.push(title); }

  pendingAbort() { return this._aborted; }

  abort() { this._aborted = true; }

  transferOut(buffer) { this.transferred.push(Buffer.from(buffer)); }

  async transferIn() { return this.stdinData; }

  finalLogMessage() { return ''; }
}

// ---------------------------------------------------------------------------
// script files
// ---------------------------------------------------------------------------

/**
 * LoadScriptFromFile. UTF-8 with or without a BOM, UTF-16 with a BOM; anything
 * else is reported as an encoding error rather than being silently mangled,
 * because a mangled script is a script that does the wrong thing to real files.
 */
function loadScriptFromFile(fileName, deps = {}) {
  const fsMod = deps.fs || fs;
  const buffer = fsMod.readFileSync(fileName);
  let text;
  if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xFE) {
    text = buffer.slice(2).toString('utf16le');
  } else if (buffer.length >= 2 && buffer[0] === 0xFE && buffer[1] === 0xFF) {
    const swapped = Buffer.from(buffer.slice(2));
    swapped.swap16();
    text = swapped.toString('utf16le');
  } else {
    const start = (buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) ? 3 : 0;
    const body = buffer.slice(start);
    text = body.toString('utf8');
    if (start === 0 && text.includes('�')) {
      const e = new Error(
        `The file '${fileName}' is not a valid UTF-8 text file. Save it as UTF-8 or UTF-16.`);
      e.code = 'TEXT_FILE_ENCODING';
      throw e;
    }
  }
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  // A trailing newline should not produce a trailing empty command.
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// ---------------------------------------------------------------------------
// %-expansion
// ---------------------------------------------------------------------------

/**
 * Delphi's FormatDateTime, restricted to the tokens WinSCP's own documentation
 * uses for `%TIMESTAMP%`. `nn` is minutes (`mm` is months) — the single most
 * common mistake when writing a WinSCP timestamp format, and getting it wrong
 * silently produces file names that sort wrong rather than failing.
 */
function formatDateTime(format, date) {
  const d = date instanceof Date ? date : new Date(date);
  const two = (n) => String(n).padStart(2, '0');
  const out = [];
  let i = 0;
  while (i < format.length) {
    const rest = format.slice(i);
    let m;
    if ((m = /^(yyyy|yy|mm|dd|hh|nn|ss|zzz)/.exec(rest))) {
      switch (m[1]) {
        case 'yyyy': out.push(String(d.getFullYear()).padStart(4, '0')); break;
        case 'yy': out.push(two(d.getFullYear() % 100)); break;
        case 'mm': out.push(two(d.getMonth() + 1)); break;
        case 'dd': out.push(two(d.getDate())); break;
        case 'hh': out.push(two(d.getHours())); break;
        case 'nn': out.push(two(d.getMinutes())); break;
        case 'ss': out.push(two(d.getSeconds())); break;
        case 'zzz': out.push(String(d.getMilliseconds()).padStart(3, '0')); break;
        default: break;
      }
      i += m[1].length;
      continue;
    }
    if (format[i] === '"' || format[i] === "'") {
      const quote = format[i];
      const end = format.indexOf(quote, i + 1);
      if (end < 0) { out.push(format.slice(i + 1)); i = format.length; continue; }
      out.push(format.slice(i + 1, end));
      i = end + 1;
      continue;
    }
    out.push(format[i]);
    i++;
  }
  return out.join('');
}

/** `%NAME%` → the environment variable, or left alone when it does not exist. */
function expandEnvironmentVariables(text, env = process.env) {
  return String(text).replace(/%([A-Za-z_][A-Za-z0-9_()]*)%/g, (whole, name) => {
    const upper = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
    return upper === undefined ? whole : String(env[upper]);
  });
}

function indexOfCaseInsensitive(haystack, needle, from) {
  return haystack.toUpperCase().indexOf(needle.toUpperCase(), from);
}

/** `1D`, `2H`, `today`, `yesterday`; `add` flips the sign. */
function relativeTime(spec, add, now) {
  const parsed = tryRelativeTime(spec);
  if (!parsed) return null;
  return resolveTime({ ...parsed, number: add ? -parsed.number : parsed.number }, now);
}

/**
 * ExpandCommand: `%1%`…`%9%` from `/parameter`, then `%TIMESTAMP%` and its
 * `%TIMESTAMP+1D#yyyymmdd%` relative/format form, then environment variables.
 *
 * An externally-set TIMESTAMP environment variable wins over the built-in one,
 * so a wrapper batch file can pin the timestamp across several WinSCP runs.
 */
function expandCommand(command, scriptParameters = [], options = {}) {
  const env = options.env || process.env;
  const now = options.now === undefined ? Date.now() : options.now;
  const externalTimestampVar = options.externalTimestampVar === undefined
    ? !!env[TIMESTAMP_VAR_NAME] : !!options.externalTimestampVar;

  let cmd = String(command);
  for (let i = 0; i < scriptParameters.length; i++) {
    cmd = cmd.split(`%${i + 1}%`).join(scriptParameters[i]);
  }

  if (!externalTimestampVar) {
    const plain = formatDateTime('yyyymmddhhnnss', now);
    const marker = `%${TIMESTAMP_VAR_NAME}%`;
    let at = indexOfCaseInsensitive(cmd, marker, 0);
    while (at >= 0) {
      cmd = cmd.slice(0, at) + plain + cmd.slice(at + marker.length);
      at = indexOfCaseInsensitive(cmd, marker, at + plain.length);
    }
  }

  let offset = 0;
  let p2;
  do {
    const p = indexOfCaseInsensitive(cmd, `%${TIMESTAMP_VAR_NAME}`, offset);
    if (p >= 0) {
      offset = p + 1 + TIMESTAMP_VAR_NAME.length;
      p2 = cmd.indexOf('%', offset);
      const p3 = cmd.indexOf('#', offset);
      if (p2 >= 0 && p3 >= 0 && p3 < p2
          && (p3 === offset || cmd[offset] === '+' || cmd[offset] === '-')) {
        let valid = true;
        let t = now;
        if (p3 > offset) {
          const add = cmd[offset] === '+';
          const resolved = relativeTime(cmd.slice(offset + 1, p3), add, now);
          valid = resolved !== null;
          if (valid) t = resolved;
        }
        if (valid) {
          const value = formatDateTime(cmd.slice(p3 + 1, p2), t);
          cmd = cmd.slice(0, p) + value + cmd.slice(p2 + 1);
          offset = p + value.length;
        } else {
          offset = p3 + 1;
        }
      }
    } else {
      p2 = -1;
    }
  } while (p2 >= 0);

  return expandEnvironmentVariables(cmd, env);
}

// ---------------------------------------------------------------------------
// the XML actions log
// ---------------------------------------------------------------------------

/**
 * The `/xmllog=` log.
 *
 * This is deliberately not `logging.js`'s ActionsLog: the scripting log has one
 * element the session log does not — `<group>`, which brackets everything one
 * script command did, including the `<failure>` that ended it. That bracketing
 * is the whole reason scripting users parse the XML rather than the text log,
 * and it belongs to the script engine that knows where a command starts.
 */
class ScriptXmlLog {
  constructor(fileName, options = {}) {
    this.fileName = fileName;
    this.required = !!options.required;
    this.fs = options.fs || fs;
    this._fd = null;
    this._groupOpen = false;
    this._broken = false;
    this._sessionName = options.sessionName || '';
    this._started = options.started || new Date();
  }

  _ensure() {
    if (this._broken) return false;
    if (this._fd !== null) return true;
    try {
      this.fs.mkdirSync(nodePath.dirname(nodePath.resolve(this.fileName)), { recursive: true });
      this._fd = this.fs.openSync(this.fileName, 'w');
      this._write('<?xml version="1.0" encoding="UTF-8"?>\n'
        + '<session xmlns="http://winscp.net/schema/session/1.0"'
        + ` name="${xmlEscape(this._sessionName)}"`
        + ` start="${new Date(this._started).toISOString()}">\n`);
      return true;
    } catch (e) {
      this._broken = true;
      this._fd = null;
      // With /xmllogrequired the run cannot continue: the caller asked for a
      // machine-readable record and would otherwise get a silent success.
      if (this.required) throw e;
      return false;
    }
  }

  _write(text) {
    if (this._fd === null) return;
    try { this.fs.writeSync(this._fd, Buffer.from(text, 'utf8')); } catch (e) {
      this._broken = true;
      try { this.fs.closeSync(this._fd); } catch { /* already gone */ }
      this._fd = null;
      if (this.required) throw e;
    }
  }

  beginGroup(name) {
    if (!this._ensure()) return;
    if (this._groupOpen) this.endGroup();
    this._write(`  <group name="${xmlEscape(name)}" start="${new Date().toISOString()}">\n`);
    this._groupOpen = true;
  }

  endGroup() {
    if (!this._groupOpen) return;
    this._write('  </group>\n');
    this._groupOpen = false;
  }

  record(type, fields, result) {
    if (!this._ensure()) return;
    const indent = this._groupOpen ? '    ' : '  ';
    const ok = !(result && result.ok === false);
    let body = `${indent}<${type} result="${ok ? 1 : 0}">\n`;
    for (const [k, v] of Object.entries(fields || {})) {
      if (v === undefined || v === null || v === '') continue;
      body += `${indent}  <${k} value="${xmlEscape(String(v))}" />\n`;
    }
    if (!ok) {
      body += `${indent}  <result success="false">\n`;
      body += `${indent}    <message>${xmlEscape(result.message || 'Failed')}</message>\n`;
      body += `${indent}  </result>\n`;
    }
    body += `${indent}</${type}>\n`;
    this._write(body);
  }

  addFailure(messages) {
    if (!this._ensure()) return;
    const indent = this._groupOpen ? '    ' : '  ';
    let body = `${indent}<failure>\n`;
    for (const m of [].concat(messages)) {
      body += `${indent}  <message>${xmlEscape(String(m))}</message>\n`;
    }
    body += `${indent}</failure>\n`;
    this._write(body);
  }

  close() {
    if (this._fd === null) return;
    this.endGroup();
    this._write('</session>\n');
    try { this.fs.closeSync(this._fd); } catch { /* already gone */ }
    this._fd = null;
  }
}

/**
 * `/log=FILE` is the text-log half of the console contract. The scripting
 * engine already emits one redacted record for every input, output and exit
 * status, so reuse SessionLog's timestamp/mark/redaction writer instead of
 * inventing a second log format for the headless process.
 */
function createScriptFileLog(fileName, level = 0) {
  if (!fileName) return null;
  return new SessionLog({
    getPrefs: () => ({
      enabled: true,
      level: Number.isFinite(level) ? level : 0,
      logToFile: true,
      logFileName: fileName,
      logFileAppend: true,
      logMaxSize: 0,
      logMaxCount: 0,
      logSensitive: false,
      logWindowLines: 2000,
      actionsLogging: false,
    }),
    session: {},
  });
}

// ---------------------------------------------------------------------------
// the runner
// ---------------------------------------------------------------------------

class ConsoleRunner {
  /**
   * @param {ConsoleBase} console
   * @param {object} deps  forwarded to ManagementScript, plus
   *   scriptFactory  (deps) => ManagementScript, to substitute one
   *   now            () => epoch ms, for deterministic %TIMESTAMP%
   *   env            environment for %VAR% expansion
   */
  constructor(consoleInstance, deps = {}) {
    this.console = consoleInstance;
    this.deps = deps;
    this.script = null;
    this.xmlLog = deps.xmlLog || null;
    this.lastProgressLen = 0;
    this.commandError = false;
    this.batchScript = false;
    this.aborted = false;
    this.env = deps.env || process.env;
    this.now = deps.now || (() => Date.now());
    this.externalTimestampVar = !!this.env[TIMESTAMP_VAR_NAME];
  }

  // ---- output ---------------------------------------------------------

  print(text, fromBeginning = false, isError = false) {
    if (this.lastProgressLen > 0) {
      this.console.print(`\n${text}`, fromBeginning, isError);
      this.lastProgressLen = 0;
    } else {
      this.console.print(text, fromBeginning, isError);
    }
  }

  printMessage(text, isError = false) {
    const line = removeEmptyLines(text);
    if (this.script) this.script.printLine(line, isError);
    else this.console.printLine(line, isError);
  }

  /**
   * The progress line is rewritten in place, and padded with backspaces when it
   * shrinks so a shorter line does not leave the tail of the previous one on
   * screen.
   */
  printProgress(first, text) {
    let s = text;
    if (first && this.lastProgressLen > 0) s = `\n${s}`;
    else if (s.length < this.lastProgressLen) {
      const padding = this.lastProgressLen - s.length;
      s += ' '.repeat(padding) + '\b'.repeat(padding);
    }
    this.console.print(s, true);
    this.lastProgressLen = text.length;
  }

  showException(error) {
    const message = error && error.message ? error.message : String(error);
    if (message) {
      this.commandError = true;
      this.printMessage(message, true);
    }
    if (this.xmlLog) this.xmlLog.addFailure(message);
  }

  notifyAbort() {
    // Only a *script* can be aborted this way; an interactive session just gets
    // its current command cancelled and keeps the prompt.
    if (!this.batchScript) return false;
    this.aborted = true;
    return true;
  }

  isAborted(allowCompleteAbort = true) {
    if (this.aborted) return true;
    if (!this.console.pendingAbort()) return false;
    this.printMessage(MSG.USER_TERMINATED, true);
    if (allowCompleteAbort && this.notifyAbort() && this.xmlLog) {
      this.xmlLog.addFailure(MSG.USER_TERMINATED);
    }
    return true;
  }

  failed(state) {
    if (this.script) this.script.log('info', 'Failed');
    state.anyError = true;
  }

  inputTimeout() {
    return this.script && this.script.batch !== 'off' ? 5 * 60 * 1000 : 0;
  }

  async doInput(echo, timeout, interactive) {
    if (interactive && this.console.hasFlag(CF.NO_INTERACTIVE_INPUT)) {
      this.notifyAbort();
      return null;
    }
    const value = await this.console.input(echo, timeout);
    if (value === null) this.notifyAbort();
    return value;
  }

  // ---- the run --------------------------------------------------------

  buildScript() {
    const consoleInstance = this.console;
    const deps = {
      ...this.deps,
      limitedOutput: consoleInstance.hasFlag(CF.LIMITED_OUTPUT),
      onPrint: (_script, text, isError) => this.print(text, false, isError),
      onPrintProgress: (_script, first, text) => this.printProgress(first, text),
      onInput: async (_script, prompt) => {
        this.print(prompt);
        const value = await this.doInput(true, this.inputTimeout(), true);
        if (value === null) throw new ScriptAbort('No input available.');
        return value;
      },
      onShowExtendedException: (_terminal, error) => this.showException(error),
      onQueryCancel: () => this.isAborted(),
      onSynchronizeStartStop: this.deps.onSynchronizeStartStop
        || ((script, local, remote, copyParam, params) =>
          this.keepUpToDate(script, local, remote, copyParam, params)),
    };
    if (consoleInstance.hasFlag(CF.STD_OUT)) {
      deps.onTransferOut = (_script, buffer) => consoleInstance.transferOut(buffer);
    }
    if (consoleInstance.hasFlag(CF.STD_IN)) {
      deps.onTransferIn = () => consoleInstance.transferIn();
    }
    const script = this.deps.scriptFactory
      ? this.deps.scriptFactory(deps) : new ManagementScript(deps);
    script.wantsProgress = consoleInstance.hasFlag(CF.WANTS_PROGRESS);
    return script;
  }

  /**
   * `keepuptodate`: watch and re-synchronize until the console is aborted.
   * WinSCP pumps its message loop here; we await the watcher instead.
   */
  async keepUpToDate(script, localDirectory, remoteDirectory, copyParam, synchronizeParams) {
    const syncModule = script.sync || require('./sync');
    const localAdapter = await script._requireLocalAdapter();
    const watcher = syncModule.startWatch(
      localAdapter, script.resolveLocalPath(localDirectory),
      script.terminal.adapter, script.terminal.absolute(remoteDirectory),
      script.queue,
      syncOptionsFrom('remote', synchronizeParams, copyParam));

    watcher.on('error', (e) => this.printMessage(e && e.message ? e.message : String(e), true));
    watcher.on('synchronized', (info) => {
      if (info && info.count) this.printMessage(`${info.count} change(s) reflected.`);
    });

    try {
      while (!this.isAborted(false)) {
        // Same rule: this tick is the only thing keeping `keepuptodate` alive
        // between filesystem events, so unref'ing it lets the command return
        // the moment the watcher happens to be idle — which is most of the
        // time, and is precisely when it is supposed to be waiting.
        await new Promise((resolve) => { setTimeout(resolve, 250); });
      }
    } finally {
      syncModule.stopWatch(watcher);
    }
  }

  /**
   * The command loop.
   *
   * @param {object} opts
   *   session           the URL or site name from the command line, if any
   *   options           an Options instance holding the command-line switches
   *   scriptCommands    the commands from /script= and /command
   *   scriptParameters  the values for %1%…%N%
   *   usageWarnings     print the "use open instead" style advisories
   * @returns {Promise<number>} the process exit code
   */
  async run(opts = {}) {
    const state = { anyError: false };
    const scriptCommands = opts.scriptCommands || [];
    const scriptParameters = opts.scriptParameters || [];
    const options = opts.options || new Options();
    const usageWarnings = opts.usageWarnings !== false;

    let exitCode;
    try {
      try {
        this.script = this.buildScript();
        this.script.usageWarnings = usageWarnings;

        this.updateTitle();

        // Everything up to the first hand-typed command is "batch": the session
        // opened from the command line and every line of the script file.
        this.batchScript = true;

        if (opts.session) {
          if (usageWarnings) this.printMessage(MSG.CMDLINE_SESSION);
          this.commandError = false;
          await this.script.connect(opts.session, options, false);
          if (this.commandError) this.failed(state);
        }

        this.script.groups = options.switchValueBool('xmlgroups', true, false);

        let scriptPos = 0;
        let result;
        do {
          this.updateTitle();

          let command;
          if (scriptPos < scriptCommands.length) {
            result = true;
            command = scriptCommands[scriptPos];
            scriptPos++;
          } else {
            if (this.batchScript) {
              this.batchScript = false;
              this.script.startInteractive();
            }
            this.print('winscp> ');
            command = await this.doInput(true, 0, false);
            result = command !== null;
          }

          if (result) {
            this.commandError = false;
            const expanded = expandCommand(command, scriptParameters, {
              env: this.env,
              now: this.now(),
              externalTimestampVar: this.externalTimestampVar,
            });

            if (this.script.groups && this.xmlLog) {
              // The script logger masks credentials in `open` commands. Use
              // that same boundary for XML group names; otherwise /xmlgroups
              // would write the raw expanded command (including a URL
              // password or -password= value) even when console output and
              // the session log were redacted.
              const commandToken = cutToken(expanded);
              const safeCommand = commandToken.ok && this.script.getLogCmd
                ? this.script.getLogCmd(expanded, commandToken.token, commandToken.rest)
                : expanded;
              this.xmlLog.beginGroup(safeCommand);
            }
            try {
              await this.script.command(expanded);
            } finally {
              if (this.script.groups && this.xmlLog) this.xmlLog.endGroup();
            }

            if (this.commandError) {
              this.failed(state);
              // `batch abort` is the whole reason scripts are usable
              // unattended: the first failure stops the rest from running
              // against a state nobody checked.
              if (this.script.batch === 'abort') result = false;
            }
          }
        } while (result && this.script.continue && !this.isAborted());
      } catch (e) {
        if (e instanceof ScriptAbort) this.aborted = true;
        this.failed(state);
        this.showException(e);
      }

      if (this.lastProgressLen > 0) {
        this.console.print('\n');
        this.lastProgressLen = 0;
      }

      exitCode = (state.anyError || this.aborted) ? RESULT_ANY_ERROR : RESULT_SUCCESS;

      if (this.script) {
        const message = `Exit code: ${exitCode}`;
        this.script.log('info', message);
        if (this.deps.logProtocol >= 1) {
          this.console.print(`${message}\n`);
          const final = this.console.finalLogMessage();
          if (final) {
            this.script.log('info', final);
            this.console.print(`${final}\n`);
          }
        }
      }
    } finally {
      if (this.script) {
        try { await this.script.closeAll(); } catch { /* exiting anyway */ }
      }
      // Cleanup must not turn a completed command into an unhandled rejection.
      // A broken optional log is already represented by its own failure state;
      // the runner still has to release its script reference even if closing
      // that log throws (for example, after a late filesystem error).
      try { if (this.xmlLog) this.xmlLog.close(); } catch { /* exiting anyway */ }
      this.script = null;
    }

    return exitCode;
  }

  updateTitle() {
    const name = this.script && this.script.terminal ? this.script.terminal.name : '';
    this.console.setTitle(name ? `${name} - WinSCP Material` : 'WinSCP Material');
  }
}

/** RemoveEmptyLines: an exception message often arrives with blank separators. */
function removeEmptyLines(text) {
  return String(text === undefined || text === null ? '' : text)
    .split('\n').filter((l) => l.trim() !== '').join('\n');
}

// ---------------------------------------------------------------------------
// the command-line entry point — `Console(cmScripting)`
// ---------------------------------------------------------------------------

/**
 * Build the runner from a command line and run it.
 *
 * Supports the scripting switches WinSCP documents:
 *   /console /script=FILE /command "cmd" "cmd" … /parameter // %1 %2 …
 *   /log=FILE /loglevel=N /xmllog=FILE /xmllogrequired /xmlgroups[=on|off]
 *   /stdout[=binary|chunked] /stdin[=binary] /nointeractiveinput /unsafe
 *
 * Command sources compose exactly as in the C++: `/script=` lines come first,
 * then every `/command` argument, and only if BOTH are absent does the runner
 * fall back to reading commands from stdin. That order matters — a script file
 * plus a trailing `/command exit` is a documented idiom.
 *
 * @returns {Promise<number>} the exit code (0 success, 1 any error)
 */
async function runConsole(argv = [], deps = {}) {
  const params = new Options();
  for (const a of argv) params.add(a);

  const fsMod = deps.fs || fs;
  const safe = !params.findSwitch('unsafe');

  const scriptCommands = [];
  const scriptParameters = [];
  let loadError = null;

  if (safe) {
    const scriptFile = params.locateSwitch('script');
    if (scriptFile.found && scriptFile.value !== '') {
      try {
        for (const line of loadScriptFromFile(scriptFile.value, { fs: fsMod })) {
          scriptCommands.push(line);
        }
      } catch (e) {
        loadError = e;
      }
    }
    const commands = params.findAllSwitchParams('command');
    if (commands) for (const c of commands) scriptCommands.push(c);
    const parameters = params.findAllSwitchParams('parameter');
    if (parameters) for (const p of parameters) scriptParameters.push(p);
  }

  // /stdout and /stdin are not booleans: `=binary` and `=chunked` are different
  // framings, and `/stdin=chunked` is REFUSED (there is no way to frame input
  // the far side has not sent yet). Reducing them to "present or not" silently
  // downgraded chunked output to binary, and a reader could then not tell where
  // one file ended and the next began. design/main/console.js owns the parse,
  // including that refusal, so it is used here rather than re-derived.
  const { parseStdInOutMode, STDINOUT } = require('./console');
  let stdOutMode;
  let stdInMode;
  try {
    stdOutMode = parseStdInOutMode(params, 'stdout', true);
    stdInMode = parseStdInOutMode(params, 'stdin', false);
  } catch (error) {
    // Keep the in-process runner's contract identical to winscp.com's outer
    // catch: malformed stream switches are a process failure, not a rejected
    // promise that callers cannot use as an exit code. The front-end catches
    // this too, but runConsole is also a public project-owned entry point.
    const message = error && error.message ? error.message : String(error);
    const output = deps.stderr || deps.stdout;
    if (output && typeof output.write === 'function') output.write(`${message}\n`);
    return RESULT_ANY_ERROR;
  }
  const noInteractiveInput = params.findSwitch('nointeractiveinput') || stdInMode !== STDINOUT.OFF;

  const logLevel = params.locateSwitch('loglevel');
  let logLevelValue;
  try {
    logLevelValue = logLevel.found ? parseLogLevel(logLevel.value) : 0;
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    const output = deps.stderr || deps.stdout;
    if (output && typeof output.write === 'function') output.write(`${message}\n`);
    return RESULT_ANY_ERROR;
  }

  let consoleInstance = deps.console;
  if (!consoleInstance) {
    if (params.findSwitch('console') || process.stdout.isTTY) {
      consoleInstance = new StdConsole({
        stdout: deps.stdout,
        stderr: deps.stderr,
        stdin: deps.stdin,
        noInteractiveInput,
        stdOut: stdOutMode,
        stdIn: stdInMode,
        wantsProgress: params.findSwitch('wantsprogress'),
      });
    } else {
      consoleInstance = new NullConsole();
    }
  }

  let xmlLog = deps.xmlLog || null;
  if (!xmlLog && safe) {
    const xml = params.locateSwitch('xmllog');
    if (xml.found && xml.value !== '') {
      xmlLog = new ScriptXmlLog(xml.value, {
        required: params.findSwitch('xmllogrequired'),
        fs: fsMod,
      });
    }
  }

  const logSwitch = params.locateSwitch('log');
  const scriptFileLog = safe && logSwitch.found && logSwitch.value !== ''
    ? createScriptFileLog(logSwitch.value, logLevelValue) : null;
  const scriptLog = deps.log;
  const log = scriptLog || scriptFileLog
    ? (kind, text, terminal) => {
      if (scriptLog) scriptLog(kind, text, terminal);
      if (scriptFileLog) scriptFileLog.add(kind, text);
    }
    : null;
  const runnerDeps = {
    ...deps,
    env: deps.env || process.env,
    xmlLog,
    ...(log ? { log } : {}),
    logProtocol: logLevelValue,
    logFile: safe && logSwitch.found ? logSwitch.value : '',
  };

  // The bare parameter is the session to open, exactly as `winscp.com sftp://…`.
  const session = params.paramCount >= 1 ? params.param(1) : '';

  const runner = new ConsoleRunner(consoleInstance, runnerDeps);

  try {
    if (loadError) {
      runner.showException(loadError);
      if (xmlLog) xmlLog.close();
      return RESULT_ANY_ERROR;
    }

    if (session && params.paramCount > 1) {
      runner.printMessage(MSG.CMDLINE_PARAMETERS);
    }

    // No /script and no /command: commands come from stdin. This is what makes
    // `echo ls | winscp.com /console` work, and it is why an empty stdin exits
    // successfully rather than dropping into an unattended prompt forever.
    const usageWarnings = scriptCommands.length > 0 || !consoleInstance.hasFlag(CF.INTERACTIVE);

    return await runner.run({
      session,
      options: params,
      scriptCommands,
      scriptParameters,
      usageWarnings,
    });
  } finally {
    if (scriptFileLog) scriptFileLog.close();
  }
}

/** Split a `/command`-style argument list the way the tokenizer would. */
function splitCommandArgument(text) {
  const out = [];
  let rest = text;
  for (;;) {
    const t = cutToken(rest);
    if (!t.ok) break;
    out.push(t.token);
    rest = t.rest;
  }
  return out;
}

module.exports = {
  ConsoleRunner,
  ConsoleBase,
  StdConsole,
  NullConsole,
  BufferConsole,
  ScriptXmlLog,
  runConsole,
  loadScriptFromFile,
  expandCommand,
  expandEnvironmentVariables,
  formatDateTime,
  relativeTime,
  splitCommandArgument,
  removeEmptyLines,
  parseLogLevel,
  RESULT_SUCCESS,
  RESULT_ANY_ERROR,
  CF,
};
