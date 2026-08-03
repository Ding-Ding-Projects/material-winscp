// customcmd.js — WinSCP custom commands.
//
// The expansion is a faithful port of TCustomCommand / TFileCustomCommand /
// TLocalCustomCommand / TInteractiveCustomCommand from
// vendor/winscp/source/core/FileMasks.cpp and
// vendor/winscp/source/windows/GUITools.cpp. It matters that it is faithful:
// people paste custom commands from the WinSCP forum and expect them to behave
// the same way, quoting included.
//
// The expansion is a PURE function of (command, data, answers). Nothing in the
// expansion path touches the filesystem, the network or a prompt, which is what
// makes it testable — see test/customcmd.test.js. Execution is a separate,
// clearly marked half of this file.
//
// WinSCP runs the expansion in two passes:
//   1. the interactive pass resolves `!?prompt?default!` and `` !`command` ``
//      and ESCAPES what it substitutes (a `!` typed by the user must not turn
//      into a pattern in pass two);
//   2. the file pass resolves everything else and unescapes `!!` to `!`.
//
// Patterns (the file pass), from TFileCustomCommand::PatternReplacement:
//   !     the file           !!  a literal `!`
//   !&    all selected files (already quoted, never re-quoted)
//   !/    the remote path, with a trailing `/`
//   !@    host            !U user      !P password (never logged)
//   !#    port            !K  private key file
//   !N    session name    !S  session URL   !E session URL including password
// and, for LOCAL commands only (TLocalCustomCommand):
//   !\    the local path, WITHOUT its trailing separator
//   !^!   the local (downloaded) file name
//
// Case: every letter pattern is matched case-insensitively, exactly as
// SameText() does in the original. `!@`, `!/`, `!&`, `!\` and `!^!` are
// punctuation and have no case.
'use strict';
const cp = require('child_process');
const { EventEmitter } = require('events');

/** Marks a run of ordinary text in the token stream. */
const TEXT = 'text';
const LITERAL = 'literal';      // `!!`
const PATTERN = 'pattern';
const PROMPT = 'prompt';        // `!?...!`
const EXEC = 'exec';            // `` !`...` ``

const QUOTES = '"\'';

/** Two-character letter patterns handled by the file pass. */
const TWO_CHAR = new Set(['s', 'e', '@', 'u', 'p', 'k', '#', '/', '&', 'n']);

class CustomCommandError extends Error {
  constructor(message, code) { super(message); this.name = 'CustomCommandError'; this.code = code || 'CUSTOM_COMMAND'; }
}

// ---------------------------------------------------------------- escaping

/** TCustomCommand::Escape — a `!` in a substituted value must not re-parse. */
function escape(s) { return String(s).replace(/!/g, '!!'); }

/**
 * DelimitStr from vendor/winscp/source/core/Common.cpp.
 *
 * Escapes the characters that would be special inside the quoting context the
 * pattern was written in, then guards a leading `-` with `./` so a file called
 * `-rf` cannot be read by the remote shell as a switch. That last touch is the
 * reason this is ported rather than replaced with a generic shell-quoter.
 */
function delimitStr(str, quote) {
  let special = '';
  if (quote !== "'") {
    special = '$\\';
    if (quote === '"') special += '`"';
  }
  let out = '';
  for (const ch of String(str)) {
    if (special.includes(ch)) out += '\\';
    out += ch;
  }
  if (out.startsWith('-')) out = './' + out;
  return out;
}

// ------------------------------------------------------------- tokenizing

/**
 * TCustomCommand::GetToken. Returns the length of the token starting at
 * `index` and the pattern character that identifies it.
 *
 * `patternLen` is the layer-specific rule (interactive / file / local).
 */
function getToken(command, index, patternLen) {
  if (command[index] === '!') {
    const cmd = index + 1 < command.length ? command[index + 1] : '\0';
    let len;
    if (cmd === '\0') len = 1;              // a trailing bare `!` is the file
    else if (cmd === '!') len = 2;          // the literal escape
    else len = patternLen(command, index);

    if (len <= 0) throw new CustomCommandError(`Unknown pattern "!${cmd}" at position ${index + 1}`, 'UNKNOWN_PATTERN');
    if (command.length - index < len) {
      throw new CustomCommandError(`Unterminated pattern "!${cmd}" at position ${index + 1}`, 'UNTERMINATED_PATTERN');
    }
    return { len, cmd };
  }
  const next = command.indexOf('!', index);
  return { len: next < 0 ? command.length - index : next - index, cmd: TEXT };
}

/** Pattern lengths for the file/local pass (TFileCustomCommand::PatternLen). */
function filePatternLen(local) {
  return function patternLen(command, index) {
    const next = index + 1 < command.length ? command[index + 1] : '\0';
    if (local) {
      if (next === '\\') return 2;
      if (next === '^') return 3;           // `!^!`
    }
    return TWO_CHAR.has(next.toLowerCase()) ? 2 : 1;
  };
}

/** Pattern lengths for the interactive pass (TInteractiveCustomCommand). */
function interactivePatternLen(local) {
  const child = filePatternLen(local);
  return function patternLen(command, index) {
    const next = index + 1 < command.length ? command[index + 1] : '\0';
    if (next === '?') {
      const end = command.indexOf('!', index + 1);
      if (end < 0) throw new CustomCommandError(`Unterminated prompt pattern at position ${index + 1}`, 'UNTERMINATED_PATTERN');
      return end - index + 1;
    }
    if (next === '`') {
      const end = command.indexOf('`', index + 2);
      if (end < 0) throw new CustomCommandError(`Unterminated command pattern at position ${index + 1}`, 'UNTERMINATED_PATTERN');
      return end - index + 1;
    }
    return child(command, index);
  };
}

/**
 * Split a command into tokens. Exported because the editor UI highlights the
 * patterns and the validator reports their positions.
 */
function tokenize(command, options) {
  const o = options || {};
  const patternLen = o.interactive === false ? filePatternLen(!!o.local) : interactivePatternLen(!!o.local);
  const cmd = String(command || '');
  const tokens = [];
  let i = 0;
  let patternIndex = 0;
  while (i < cmd.length) {
    const { len, cmd: pc } = getToken(cmd, i, patternLen);
    const text = cmd.slice(i, i + len);
    if (pc === TEXT) tokens.push({ kind: TEXT, text, index: i });
    else if (pc === '!') tokens.push({ kind: LITERAL, text, index: i });
    else {
      let kind = PATTERN;
      if (o.interactive !== false && text.length >= 3 && text[1] === '?') kind = PROMPT;
      else if (o.interactive !== false && text.length >= 3 && text[1] === '`') kind = EXEC;
      tokens.push({ kind, text, index: i, patternIndex: patternIndex++, quote: quoteAround(cmd, i, len) });
    }
    i += len;
  }
  return tokens;
}

/** A pattern wrapped in a matching pair of quotes inherits that quoting. */
function quoteAround(command, index, len) {
  if (index > 0 && index + len < command.length) {
    const before = command[index - 1];
    const after = command[index + len];
    if (QUOTES.includes(before) && QUOTES.includes(after) && before === after) return before;
  }
  return '\0';
}

/**
 * TInteractiveCustomCommand::ParsePromptPattern.
 * `!?Prompt?default!` — and a `\` immediately before the `?` separator means
 * "do not quote the answer".
 */
function parsePromptPattern(pattern) {
  // pattern is `!?....!`; the body is everything between index 2 and the last `!`.
  const body = pattern.slice(2, pattern.length - 1);
  const pos = body.indexOf('?');
  if (pos < 0) return { prompt: body, default: '', delimit: true };
  let promptEnd = pos;
  let delimit = true;
  if (pos >= 1 && body[pos - 1] === '\\') { delimit = false; promptEnd = pos - 1; }
  return { prompt: body.slice(0, promptEnd), default: body.slice(pos + 1), delimit };
}

/** Every interactive prompt in a command, in the order the UI must ask them. */
function collectPrompts(command, options) {
  const out = [];
  for (const t of tokenize(command, options)) {
    if (t.kind !== PROMPT) continue;
    const p = parsePromptPattern(t.text);
    out.push({ patternIndex: t.patternIndex, prompt: p.prompt, default: p.default, delimit: p.delimit, pattern: t.text });
  }
  return out;
}

/** Every `` !`command` `` in a command, so the caller can run them first. */
function collectExecs(command, options) {
  const out = [];
  for (const t of tokenize(command, options)) {
    if (t.kind !== EXEC) continue;
    out.push({ patternIndex: t.patternIndex, command: t.text.slice(2, t.text.length - 1), pattern: t.text });
  }
  return out;
}

// ------------------------------------------------------------- completion

/**
 * TCustomCommand::Complete, generic over the layer's replacement rules.
 * `replace(patternIndex, pattern)` returns { value, delimit } or null to leave
 * the pattern untouched for a later pass.
 */
function complete(command, { patternLen, replace, delimitReplacement, lastPass }) {
  const cmd = String(command || '');
  let result = '';
  let i = 0;
  let patternIndex = 0;
  while (i < cmd.length) {
    const { len, cmd: pc } = getToken(cmd, i, patternLen);
    const text = cmd.slice(i, i + len);

    if (pc === TEXT) {
      result += text;
    } else if (pc === '!') {
      // `!!` only collapses on the final pass; an earlier pass keeps it intact
      // so the next parser still sees an escape rather than a live pattern.
      result += lastPass ? '!' : text;
    } else {
      const quote = quoteAround(cmd, i, len);
      const r = replace(patternIndex, text);
      if (r) {
        let value = r.value === undefined || r.value === null ? '' : String(r.value);
        if (!lastPass) value = escape(value);
        if (r.delimit !== false) value = delimitReplacement(value, quote);
        result += value;
      } else {
        result += text;
      }
      patternIndex++;
    }
    i += len;
  }
  return result;
}

// ------------------------------------------------------- the two rule sets

function defaultPort(protocol) {
  switch (String(protocol || '').toLowerCase()) {
    case 'sftp': case 'scp': return 22;
    case 'ftp': return 21;
    case 'webdav': return 80;
    case 's3': return 443;
    default: return 0;
  }
}

/**
 * TSessionData::GenerateSessionUrl. `withPassword` is the `!E` form; the
 * password is only ever included when the caller explicitly asks for it.
 */
function sessionUrl(data, withPassword) {
  const d = data || {};
  const proto = String(d.protocol || 'sftp').toLowerCase();
  let url = `${proto}://`;
  if (d.userName) {
    url += encodeURIComponent(d.userName);
    if (withPassword && d.password) url += ':' + encodeURIComponent(d.password);
    url += '@';
  }
  const host = String(d.hostName || '');
  url += host.includes(':') ? `[${host}]` : encodeURIComponent(host);
  const port = Number(d.portNumber || 0);
  if (port && port !== defaultPort(proto)) url += ':' + port;
  url += '/';
  return url;
}

/** A remote path always ends in `/` so `!/name` composes (UnixIncludeTrailingBackslash). */
function withTrailingSlash(p) {
  const s = String(p || '/');
  return s.endsWith('/') ? s : s + '/';
}

/** A local path never ends in `\` — a trailing backslash escapes the closing
 *  quote in PowerShell, which is exactly the bug WinSCP works around here. */
function withoutTrailingSep(p) {
  let s = String(p || '');
  while (s.length > 1 && (s.endsWith('\\') || s.endsWith('/'))) s = s.slice(0, -1);
  return s;
}

/**
 * The file/local pass replacement table.
 * `data` is the session data, `ctx` the per-invocation file context.
 */
function fileReplacement(data, ctx, local) {
  return function replace(_index, pattern) {
    const p = pattern.toLowerCase();
    switch (p) {
      case '!s': return { value: sessionUrl(data, false) };
      case '!e': return { value: sessionUrl(data, true) };
      case '!u': return { value: data.userName || '' };
      case '!p': return { value: data.password || '' };
      case '!#': return { value: String(data.portNumber || defaultPort(data.protocol) || '') };
      case '!k': return { value: data.publicKeyFile || '' };
      case '!n': return { value: data.name || data.sessionName || data.hostName || '' };
      default: break;
    }
    // These are punctuation: compare exactly, never case-folded.
    if (pattern === '!@') return { value: data.hostName || '' };
    if (pattern === '!/') return { value: withTrailingSlash(ctx.remotePath) };
    if (pattern === '!&') return { value: ctx.fileList || '', delimit: false }; // already quoted
    if (local && pattern === '!\\') return { value: withoutTrailingSep(ctx.localPath) };
    if (local && pattern === '!^!') return { value: ctx.localFileName || '' };
    // Anything left is the one-character `!` — the file itself.
    return { value: ctx.fileName || '' };
  };
}

/**
 * The whole expansion, both passes, exactly as
 * TCustomScpExplorerForm does it:
 *
 *   Local.Complete(Interactive.Complete(command, false), true)
 *
 * @param {string} command
 * @param {object} data     session data: protocol, hostName, portNumber,
 *                          userName, password, publicKeyFile, name
 * @param {object} [ctx]    fileName, fileList, remotePath, localPath,
 *                          localFileName
 * @param {object} [opts]   { local, answers, execResults }
 *                          `answers` and `execResults` are keyed by the
 *                          pattern's index within the command (see
 *                          collectPrompts / collectExecs), or by the prompt
 *                          text as a convenience.
 * @returns {string}
 */
function expand(command, data, ctx, opts) {
  const d = data || {};
  const c = ctx || {};
  const o = opts || {};
  const local = !!o.local;
  const answers = o.answers || {};
  const execResults = o.execResults || {};

  // ---- pass 1: interactive. Escapes what it substitutes; keeps `!!` intact.
  const pass1 = complete(command, {
    patternLen: interactivePatternLen(local),
    lastPass: false,
    // The interactive layer is a separate object from the local one in WinSCP
    // (GUITools.cpp builds TWinInteractiveCustomCommand around
    // TLocalCustomCommand), so it keeps TCustomCommand's own delimiting even
    // for a local command. Prompt answers are user text and do get quoted;
    // it is only the file-pattern pass below that a local command exempts.
    delimitReplacement: delimitStr,
    replace(index, pattern) {
      if (pattern.length >= 3 && pattern[1] === '?') {
        const parsed = parsePromptPattern(pattern);
        const given = pick(answers, index, parsed.prompt);
        return { value: given === undefined ? parsed.default : given, delimit: parsed.delimit };
      }
      if (pattern.length >= 3 && pattern[1] === '`') {
        const inner = pattern.slice(2, pattern.length - 1);
        const given = pick(execResults, index, inner);
        // Never quoted: the point of `!`cmd`` is to splice raw output in.
        return { value: given === undefined ? '' : given, delimit: false };
      }
      return null;   // not ours — pass two will handle it
    },
  });

  // ---- pass 2: the file/local patterns, and `!!` finally collapses.
  return complete(pass1, {
    patternLen: filePatternLen(local),
    lastPass: true,
    delimitReplacement: local ? (v) => v : delimitStr,
    replace: fileReplacement(d, c, local),
  });
}

function pick(map, index, key) {
  if (map && Object.prototype.hasOwnProperty.call(map, index)) return map[index];
  if (map && key !== undefined && Object.prototype.hasOwnProperty.call(map, key)) return map[key];
  return undefined;
}

// -------------------------------------------------------------- predicates

/**
 * TCustomCommand::FindPattern, character for character:
 *   '\0' — is there any pattern at all
 *   '!'  — is there a single-character pattern (the file)
 *   else — is there a pattern with this letter
 */
function findPattern(command, patternCmd, options) {
  const cmd = String(command || '');
  const o = options || {};
  const patternLen = o.interactive === false ? filePatternLen(!!o.local) : interactivePatternLen(!!o.local);
  let i = 0;
  while (i < cmd.length) {
    const { len, cmd: pc } = getToken(cmd, i, patternLen);
    if (pc !== TEXT) {
      if (patternCmd === '\0') return true;
      if (patternCmd === '!') { if (len === 1) return true; }
      else if (pc.toLowerCase() === patternCmd.toLowerCase()) return true;
    }
    i += len;
  }
  return false;
}

function hasPatterns(command, options) { return findPattern(command, '\0', options); }
/** Uses `!&`, so it runs ONCE for the whole selection. */
function isFileListCommand(command, options) { return findPattern(command, '&', options); }
/** Uses `!` or `!&`, so it needs files at all. */
function isFileCommand(command, options) {
  return findPattern(command, '!', options) || findPattern(command, '&', options) ||
    (options && options.local ? findPattern(command, '^', options) : false);
}
/** Uses only session-level patterns, so it can run with nothing selected. */
function isSiteCommand(command, options) {
  return hasPatterns(command, options) && !isFileCommand(command, options);
}

/**
 * TFileCustomCommand::Validate — mixing `!` and `!&` in one command is an
 * error, because the two imply different iteration (once per file vs once for
 * the lot) and WinSCP will not guess which the user meant.
 */
function validate(command, options) {
  const cmd = String(command || '');
  const local = !!(options && options.local);
  const patternLen = filePatternLen(local);
  let fileList = -1;
  let single = -1;
  let i = 0;
  while (i < cmd.length) {
    const { len, cmd: pc } = getToken(cmd, i, patternLen);
    // Interactive patterns are consumed before TFileCustomCommand validates
    // file iteration.  Counting their punctuation as a bare file pattern
    // would reject valid commands such as `!?label?! !&`.
    if (cmd[i] === '!' && cmd[i + 1] === '?') {
      const end = cmd.indexOf('!', i + 2);
      if (end >= 0) { i = end + 1; continue; }
    }
    if (cmd[i] === '!' && cmd[i + 1] === '`') {
      const end = cmd.indexOf('`', i + 2);
      if (end >= 0) { i = end + 1; continue; }
    }
    // Ported verbatim from TFileCustomCommand::ValidatePattern, which measures
    // the token with the FILE rule — so `!!` also counts as single-file here.
    // That is a WinSCP quirk, but a command that behaves differently from the
    // original is worse than one that rejects the same input the original does.
    if (pc === '&') fileList = i + 1;
    else if (pc !== TEXT && patternLen(cmd, i) === 1) single = i + 1;
    i += len;
  }
  if (fileList > 0 && single > 0) {
    throw new CustomCommandError(
      `The file pattern at position ${single} cannot be combined with the file-list pattern at position ${fileList}.`,
      'FILELIST_CONFLICT');
  }
  return true;
}

/** Quote a name for the `!&` list, using the same rules as a single `!`. */
function fileListOf(names, options) {
  const local = !!(options && options.local);
  return (names || []).map((n) => (local ? n : `"${delimitStr(n, '"')}"`)).join(' ');
}

// ================================================================ execution

/**
 * Runs an expanded command and streams its output.
 *
 * Remote commands go through the adapter's exec(); local ones through a child
 * process. Both stream to `onOutput` so the console panel updates while the
 * command is still running, and both collect the output so "show results" and
 * "copy results to clipboard" have something to show and copy.
 */
class CustomCommandRunner extends EventEmitter {
  /**
   * @param {object} deps
   * @param {(text:string)=>void} [deps.onOutput]
   * @param {object} [deps.log]   a logging.js SessionLog
   */
  constructor(deps) {
    super();
    this.deps = deps || {};
    this.running = new Map();
    this._seq = 0;
  }

  _id() { return `cc-${Date.now().toString(36)}-${(++this._seq).toString(36)}`; }

  _emit(id, stream, text) {
    if (!text) return;
    this.emit('output', { id, stream, text });
    if (this.deps.onOutput) this.deps.onOutput({ id, stream, text });
  }

  /**
   * Execute over the session adapter. The adapter must declare `caps.exec`;
   * a protocol that cannot run commands says so rather than failing at the
   * call site.
   */
  async runRemote(session, commandLine, options) {
    const o = options || {};
    const adapter = session && session.adapter;
    if (!adapter) throw new CustomCommandError('The session is not connected.', 'NOT_CONNECTED');
    if (!adapter.caps || !adapter.caps.exec) {
      throw new CustomCommandError(`${adapter.protocolName} cannot execute remote commands.`, 'NOT_SUPPORTED');
    }
    const id = o.id || this._id();
    const chunks = [];
    const collect = (stream) => (text) => { chunks.push(text); this._emit(id, stream, text); };

    this.running.set(id, { kind: 'remote', commandLine, startedAt: Date.now() });
    this.emit('started', { id, kind: 'remote', command: redactForLog(commandLine, o.secrets) });
    try {
      const res = await adapter.exec(commandLine, {
        cwd: o.cwd,
        onStdout: collect('stdout'),
        onStderr: collect('stderr'),
        signal: o.signal,
      });
      // An adapter may return the whole output instead of streaming it.
      if (res && typeof res.stdout === 'string' && !chunks.length) collect('stdout')(res.stdout);
      if (res && typeof res.stderr === 'string') collect('stderr')(res.stderr);
      const out = { id, exitCode: res && res.exitCode !== undefined ? res.exitCode : 0, output: chunks.join('') };
      this.emit('finished', out);
      return out;
    } finally {
      this.running.delete(id);
    }
  }

  /**
   * Execute locally. `shell: true` because custom commands are written as
   * shell one-liners with pipes and redirection — that is the documented
   * contract of the feature, and the expansion above already quoted every
   * substituted value for exactly this reason.
   */
  runLocal(commandLine, options) {
    const o = options || {};
    const id = o.id || this._id();
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = cp.spawn(commandLine, {
          cwd: o.cwd || undefined,
          shell: true,
          windowsHide: true,
          env: { ...process.env, ...(o.env || {}) },
        });
      } catch (e) {
        reject(new CustomCommandError(`The command could not be started: ${e.message}`, 'SPAWN_FAILED'));
        return;
      }

      const chunks = [];
      this.running.set(id, { kind: 'local', commandLine, startedAt: Date.now(), child });
      this.emit('started', { id, kind: 'local', command: redactForLog(commandLine, o.secrets) });

      const onData = (stream) => (buf) => {
        const text = buf.toString('utf8');
        chunks.push(text);
        this._emit(id, stream, text);
      };
      child.stdout.on('data', onData('stdout'));
      child.stderr.on('data', onData('stderr'));

      if (o.signal) {
        const abort = () => { try { child.kill(); } catch { /* already gone */ } };
        if (o.signal.aborted) abort(); else o.signal.addEventListener('abort', abort, { once: true });
      }

      child.on('error', (e) => {
        this.running.delete(id);
        reject(new CustomCommandError(`The command failed to run: ${e.message}`, 'SPAWN_FAILED'));
      });
      child.on('close', (code) => {
        this.running.delete(id);
        const out = { id, exitCode: code === null ? -1 : code, output: chunks.join('') };
        this.emit('finished', out);
        resolve(out);
      });
    });
  }

  /** Stop a running command. */
  cancel(id) {
    const r = this.running.get(id);
    if (!r) return false;
    if (r.child) { try { r.child.kill(); } catch { /* already gone */ } }
    return true;
  }

  list() {
    return [...this.running.entries()].map(([id, r]) => ({ id, kind: r.kind, startedAt: r.startedAt }));
  }
}

/**
 * A command line is only ever logged through this. `!P` expands to the real
 * password, and a custom command that touches it must not leave it in the
 * session log or the console history.
 */
function redactForLog(commandLine, secrets) {
  let s = String(commandLine || '');
  for (const secret of secrets || []) {
    if (!secret || String(secret).length < 1) continue;
    s = s.split(String(secret)).join('***');
  }
  return s;
}

module.exports = {
  // pure expansion — the testable core
  expand, tokenize, complete, collectPrompts, collectExecs, parsePromptPattern,
  delimitStr, escape, sessionUrl, fileListOf,
  hasPatterns, isFileCommand, isFileListCommand, isSiteCommand, findPattern, validate,
  // execution
  CustomCommandRunner, redactForLog, CustomCommandError,
  TEXT, LITERAL, PATTERN, PROMPT, EXEC,
};
