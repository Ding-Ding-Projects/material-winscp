// guitools.js — the non-visual half of WinSCP's Windows tool belt and of its
// directory-view components.
//
// Sources ported here:
//   windows/GUITools.cpp            find-a-tool, shell execution, temp dirs,
//                                   tab alignment, incremental-search state
//   core/Common.cpp                 command splitting/quoting, file-name
//                                   validation, environment expansion
//   forms/CustomScpExplorer.cpp     incremental search over a panel, temporary
//                                   directory policy for remote files
//   components/UnixDirView.cpp      remote sort comparator, filtering, counts
//   components/UnixDriveView.cpp    remote directory tree
//   components/DirView.cpp          local last-path-per-drive memory
//   packages/filemng/DirViewInt.pas local sort comparator
//   packages/filemng/CustomDirView.pas       path history, select-by-filter
//   packages/filemng/*ColProperties.pas      column definitions
//   packages/my/NortonLikeListView.pas       the selection model
//   packages/my/HistoryComboBox.cpp          history-combo behaviour
//   forms/EditMask.cpp + windows/Tools.cpp   mask-edit compose/validate
//
// Everything in here is pure logic: no DOM, no Electron, no VCL. The renderer
// owns the view; this module owns what the view is a view OF. Where WinSCP's
// behaviour is expressed through a Win32 API with no meaning here (window
// handles, ShellExecuteEx verbs, DC text measurement) the INTENT is
// implemented and the substitution is called out in a comment.
'use strict';

const fs = require('fs');
const nodePath = require('path');
const childProcess = require('child_process');

// ---------------------------------------------------------------------------
// Errors — WinSCP raises specific messages, and the UI shows them verbatim
// ---------------------------------------------------------------------------

class ShellCommandError extends Error {
  constructor(message, command) {
    super(message);
    this.name = 'ShellCommandError';
    this.command = command;
  }
}

class ExecuteAppError extends Error {
  constructor(program, cause) {
    super(`Error executing "${program}".`);
    this.name = 'ExecuteAppError';
    this.program = program;
    if (cause) this.cause = cause;
  }
}

class FileNotFoundError extends Error {
  constructor(fileName) {
    super(`File "${fileName}" was not found.`);
    this.name = 'FileNotFoundError';
    this.fileName = fileName;
  }
}

class CreateTempDirError extends Error {
  constructor(dir, cause) {
    super(`Cannot create temporary directory "${dir}".`);
    this.name = 'CreateTempDirError';
    this.dir = dir;
    if (cause) this.cause = cause;
  }
}

class InvalidFileNameError extends Error {
  constructor(fileName) {
    super(`"${fileName}" is not a valid file name.`);
    this.name = 'InvalidFileNameError';
    this.fileName = fileName;
  }
}

// ---------------------------------------------------------------------------
// Small string/path helpers with Delphi's exact edge behaviour
// ---------------------------------------------------------------------------

const WIN_SEP = '\\';

/** Delphi's IncludeTrailingBackslash: '' becomes '\', which callers rely on. */
function includeTrailingBackslash(p) {
  const s = p == null ? '' : String(p);
  if (s.endsWith('\\') || s.endsWith('/')) return s;
  return s + WIN_SEP;
}

function excludeTrailingBackslash(p) {
  let s = p == null ? '' : String(p);
  while (s.length > 1 && (s.endsWith('\\') || s.endsWith('/'))) s = s.slice(0, -1);
  if (s === '\\' || s === '/') return s;
  return s;
}

function unixIncludeTrailingBackslash(p) {
  const s = p == null ? '' : String(p);
  return s.endsWith('/') ? s : s + '/';
}

function unixExcludeTrailingBackslash(p) {
  let s = p == null ? '' : String(p);
  while (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

function fromUnixPath(p) { return String(p == null ? '' : p).replace(/\//g, '\\'); }
function toUnixPath(p) { return String(p == null ? '' : p).replace(/\\/g, '/'); }

function unixExtractFileName(p) {
  const s = unixExcludeTrailingBackslash(String(p == null ? '' : p));
  const i = s.lastIndexOf('/');
  return i < 0 ? s : s.slice(i + 1);
}

function unixExtractFileDir(p) {
  const s = unixExcludeTrailingBackslash(String(p == null ? '' : p));
  const i = s.lastIndexOf('/');
  if (i < 0) return '';
  return i === 0 ? '/' : s.slice(0, i);
}

function isUnixRootPath(p) {
  const s = String(p == null ? '' : p);
  return s === '' || s === '/';
}

/**
 * UnixExtractFileExt — WinSCP's, dot included, and note that it returns the
 * WHOLE name for a dot-file: '.bashrc' has its last dot at position 1, which
 * is > 0, so the "extension" is '.bashrc'. Sorting by extension in WinSCP
 * really does group dot-files with themselves; do not "fix" this.
 */
function unixExtractFileExt(p) {
  const name = unixExtractFileName(p);
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i) : '';
}

function extractFileName(p) {
  const s = String(p == null ? '' : p);
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  return i < 0 ? s : s.slice(i + 1);
}

function extractFilePath(p) {
  const s = String(p == null ? '' : p);
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  return i < 0 ? '' : s.slice(0, i + 1);
}

function sameText(a, b) {
  return String(a == null ? '' : a).toLowerCase() === String(b == null ? '' : b).toLowerCase();
}

function replaceChar(s, from, to) {
  return String(s == null ? '' : s).split(from).join(to);
}

/** AddToList: join with a separator, skipping empty pieces. */
function addToList(list, item, separator) {
  if (!item) return list || '';
  if (!list) return item;
  return list + separator + item;
}

// ---------------------------------------------------------------------------
// Environment expansion
// ---------------------------------------------------------------------------

/**
 * ExpandEnvironmentStrings: %NAME% is replaced by its value; an unknown name is
 * left exactly as written (Windows does not blank it, and blanking it would
 * silently turn "%EDITOR%\x.exe" into "\x.exe").
 */
function expandEnvironmentVariables(str, env) {
  const source = env || process.env;
  const s = str == null ? '' : String(str);
  return s.replace(/%([^%]*)%/g, (whole, name) => {
    if (name === '') return whole;           // "%%" is not a variable
    // Windows environment lookup is case-insensitive.
    const key = Object.keys(source).find((k) => k.toLowerCase() === name.toLowerCase());
    return key === undefined ? whole : String(source[key]);
  });
}

// ---------------------------------------------------------------------------
// Command splitting, quoting and formatting (core/Common.cpp)
// ---------------------------------------------------------------------------

function addQuotes(str) {
  const s = str == null ? '' : String(str);
  return s.includes(' ') ? `"${s}"` : s;
}

function stripPathQuotes(p) {
  const s = p == null ? '' : String(p);
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  return s;
}

function addPathQuotes(p) {
  return addQuotes(stripPathQuotes(p));
}

/**
 * SplitCommand. A quoted program name runs to the next quote; an unquoted one
 * runs to the first space. An opening quote with no closing quote is a hard
 * error — WinSCP refuses the command rather than guessing where it ends, and so
 * do we.
 */
function splitCommand(command) {
  let cmd = String(command == null ? '' : command).trim();
  let program = '';
  let params = '';
  let dir = '';

  if (cmd !== '' && cmd[0] === '"') {
    cmd = cmd.slice(1);
    const p = cmd.indexOf('"');
    if (p >= 0) {
      program = cmd.slice(0, p).trim();
      params = cmd.slice(p + 1).trim();
    } else {
      throw new ShellCommandError(`"${cmd}" is not a valid command.`, `"${cmd}"`);
    }
  } else {
    const p = cmd.indexOf(' ');
    if (p >= 0) {
      program = cmd.slice(0, p + 1).trim();
      params = cmd.slice(p + 1).trim();
    } else {
      program = cmd;
    }
  }

  const b = Math.max(program.lastIndexOf('\\'), program.lastIndexOf('/'));
  if (b >= 0) dir = program.slice(0, b + 1).trim();

  return { program, params, dir };
}

function extractProgram(command) {
  return splitCommand(command).program;
}

function extractProgramName(command) {
  let name = extractFileName(extractProgram(command));
  const dot = name.lastIndexOf('.');
  if (dot > 0) name = name.slice(0, dot);
  else if (dot === 0) name = '';
  return name;
}

function formatCommand(program, params) {
  let prog = String(program == null ? '' : program).trim();
  let pars = String(params == null ? '' : params).trim();
  if (pars !== '') pars = ' ' + pars;
  prog = addQuotes(prog);
  return prog + pars;
}

/** The pattern WinSCP substitutes a file name for in an "open with" command. */
const SHELL_COMMAND_FILE_NAME_PATTERN = '!.!';

/**
 * ReformatFileNameCommand: make sure the command actually mentions the file.
 * A command the user typed as just "notepad" becomes `notepad !.!`, otherwise
 * "Open with" would launch the editor with no document — which looks like the
 * feature is broken rather than misconfigured.
 */
function reformatFileNameCommand(command) {
  const cmd = String(command == null ? '' : command);
  if (cmd === '') return '';
  const { program, params } = splitCommand(cmd);
  let pars = params;
  if (!pars.includes(SHELL_COMMAND_FILE_NAME_PATTERN)) {
    pars = pars + (pars === '' ? '' : ' ') + SHELL_COMMAND_FILE_NAME_PATTERN;
  }
  return formatCommand(program, pars);
}

function expandFileNameCommand(command, fileName) {
  return String(command == null ? '' : command)
    .split(SHELL_COMMAND_FILE_NAME_PATTERN)
    .join(addPathQuotes(fileName));
}

/** EscapeParam — doubles quotes so the value survives WinSCP's own RTF logs. */
function escapeParam(param) {
  return String(param == null ? '' : param).split('"').join('""');
}

/**
 * EscapePuttyCommandParam. Backslashes are only doubled when they precede a
 * quote (the CommandLineToArgvW rule), a quote is backslash-escaped, and the
 * whole parameter is quoted only if it contains a space.
 */
function escapePuttyCommandParam(param) {
  let s = String(param == null ? '' : param);
  let space = false;

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') {
      s = s.slice(0, i) + '\\' + s.slice(i);
      i++;
    } else if (c === ' ') {
      space = true;
    } else if (c === '\\') {
      let i2 = i;
      while (i2 < s.length && s[i2] === '\\') i2++;
      if (i2 < s.length && s[i2] === '"') {
        while (s[i] === '\\') {
          s = s.slice(0, i) + '\\' + s.slice(i);
          i += 2;
        }
        i--;
      }
    }
  }

  if (space) s = `"${s}"`;
  return s;
}

/**
 * The Windows CommandLineToArgvW quoting rules, used when we build an argument
 * vector ourselves rather than handing a raw parameter string to the shell.
 * WinSCP hands ShellExecuteEx a raw string; Node wants either an argv or a
 * verbatim line, so this is the substitution for that Win32 detail.
 */
function quoteWindowsArg(arg) {
  const s = String(arg == null ? '' : arg);
  if (s !== '' && !/[\s"]/.test(s)) return s;
  let out = '"';
  let backslashes = 0;
  for (const c of s) {
    if (c === '\\') {
      backslashes++;
      continue;
    }
    if (c === '"') {
      out += '\\'.repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    out += '\\'.repeat(backslashes) + c;
    backslashes = 0;
  }
  out += '\\'.repeat(backslashes * 2) + '"';
  return out;
}

function buildWindowsCommandLine(program, args) {
  const parts = [quoteWindowsArg(program)];
  for (const a of args || []) parts.push(quoteWindowsArg(a));
  return parts.join(' ');
}

/**
 * Split a raw Windows parameter string back into an argv, applying
 * CommandLineToArgvW's backslash/quote rules. Needed because Node's spawn wants
 * an array while every WinSCP setting stores one string.
 */
function parseWindowsCommandLine(line) {
  const s = String(line == null ? '' : line);
  const args = [];
  let current = '';
  let inQuotes = false;
  let started = false;
  let backslashes = 0;

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { backslashes++; started = true; continue; }

    if (c === '"') {
      // 2n backslashes then a quote: n literal backslashes, quote toggles.
      // 2n+1 backslashes then a quote: n literal backslashes, literal quote.
      const bs = backslashes;
      backslashes = 0;
      current += '\\'.repeat(Math.floor(bs / 2));
      if (bs % 2 === 1) current += '"';
      else inQuotes = !inQuotes;
      started = true;
      continue;
    }

    current += '\\'.repeat(backslashes);
    backslashes = 0;
    if (!inQuotes && (c === ' ' || c === '\t')) {
      if (started) { args.push(current); current = ''; started = false; }
      continue;
    }
    current += c;
    started = true;
  }

  current += '\\'.repeat(backslashes);
  if (started) args.push(current);
  return args;
}

// ---------------------------------------------------------------------------
// File-name validation (core/Common.cpp)
// ---------------------------------------------------------------------------

const LOCAL_INVALID_CHARS = '/\\:*?"<>|';
const TOKEN_PREFIX = '%';
const TOKENIZIBLE_CHARS = LOCAL_INVALID_CHARS + TOKEN_PREFIX;

/** MakeValidFileName — the aggressive one, used for session names on disk. */
function makeValidFileName(fileName) {
  let s = String(fileName == null ? '' : fileName);
  const illegal = ':;,=+<>|"[] \\/?*';
  for (const c of illegal) s = replaceChar(s, c, '-');
  return s;
}

const RESERVED_NAMES = [
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
];

function isReservedName(fileName) {
  const s = String(fileName == null ? '' : fileName);
  const p = s.indexOf('.');
  const len = p >= 0 ? p : s.length;
  if (len !== 3 && len !== 4) return false;
  const stem = p >= 0 ? s.slice(0, p) : s;
  return RESERVED_NAMES.some((r) => sameText(stem, r));
}

function byteToHex(code) {
  return code.toString(16).toUpperCase().padStart(2, '0');
}

function hexToByte(hex) {
  if (!/^[0-9A-Fa-f]{2}$/.test(hex)) return 0;
  return parseInt(hex, 16);
}

/**
 * ValidLocalFileName. Three modes, exactly as the original:
 *
 *   replacement === '%'   token mode: each offending character becomes %XX, and
 *                         an existing %XX that would decode to an offending
 *                         character is left alone so the encoding round-trips.
 *   replacement === null  no replacement: a name containing a path separator is
 *                         REFUSED rather than silently mangled.
 *   any other character   that character replaces each offending one.
 *
 * Trailing spaces and dots are encoded too, because Windows silently trims them
 * and a file named "x " would otherwise become "x" and collide.
 */
function validLocalFileName(fileName, options) {
  const opts = options || {};
  const replacement = 'replacement' in opts ? opts.replacement : TOKEN_PREFIX;
  const invalidChars = opts.invalidChars || LOCAL_INVALID_CHARS;
  const tokenizibleChars = opts.tokenizibleChars || TOKENIZIBLE_CHARS;
  let s = String(fileName == null ? '' : fileName);

  if (replacement === null || replacement === undefined) {
    if (/[\\/]/.test(s)) throw new InvalidFileNameError(s);
    return s;
  }

  const tokenMode = replacement === TOKEN_PREFIX;
  const chars = tokenMode ? tokenizibleChars : invalidChars;

  const replaceAt = (str, index) => {
    if (tokenMode) {
      const code = str.charCodeAt(index);
      // Token encoding is a single byte; a non-Latin-1 character has no
      // encoding, and silently dropping it would rename the file.
      if (code > 0xFF) throw new InvalidFileNameError(str);
      return { text: str.slice(0, index) + TOKEN_PREFIX + byteToHex(code) + str.slice(index + 1), next: index + 3 };
    }
    return { text: str.slice(0, index) + replacement + str.slice(index + 1), next: index + 1 };
  };

  let i = 0;
  while (i < s.length) {
    if (!chars.includes(s[i])) { i++; continue; }
    if (tokenMode && s[i] === TOKEN_PREFIX) {
      const rest = s.length - (i + 1);
      const decoded = rest >= 2 ? String.fromCharCode(hexToByte(s.substr(i + 1, 2))) : '\0';
      if (rest < 2 || decoded === '\0' || !tokenizibleChars.includes(decoded)) {
        i++;                       // already-encoded or harmless '%': leave it
        continue;
      }
    }
    const r = replaceAt(s, i);
    s = r.text;
    i = r.next;
  }

  if (s !== '') {
    const last = s[s.length - 1];
    if (last === ' ' || last === '.') s = replaceAt(s, s.length - 1).text;
  }

  if (isReservedName(s)) {
    const p = s.indexOf('.');
    const at = p >= 0 ? p : s.length;
    s = s.slice(0, at) + '%00' + s.slice(at);
  }

  return s;
}

/** TCopyParamType::ValidLocalPath — each segment validated, '\' preserved. */
function validLocalPath(path, options) {
  let rest = String(path == null ? '' : path);
  let result = '';
  while (rest !== '') {
    const p = rest.indexOf('\\');
    const segment = p < 0 ? rest : rest.slice(0, p);
    rest = p < 0 ? '' : rest.slice(p + 1);
    if (result !== '') result += '\\';
    result += validLocalFileName(segment, options);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Finding a tool on disk (GUITools.cpp FindFile / FindTool)
// ---------------------------------------------------------------------------

function defaultFileExists(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/**
 * FindFile. Three attempts, in the original's order:
 *   1. the path as given;
 *   2. the 64-bit twin of a 32-bit Program Files path — WOW64 redirection means
 *      a stored "C:\Program Files (x86)\..." can be the wrong half of a pair;
 *   3. a bare name is looked up along PATH.
 * Returns { found, path } instead of mutating its argument.
 */
function findFile(path, options) {
  const opts = options || {};
  const env = opts.env || process.env;
  const exists = opts.exists || defaultFileExists;
  let p = String(path == null ? '' : path);

  if (exists(p)) return { found: true, path: p };

  const programFiles32 = env.ProgramFiles ? includeTrailingBackslash(env.ProgramFiles) : '';
  const programFiles64 = env.ProgramW6432 ? includeTrailingBackslash(env.ProgramW6432) : '';
  if (programFiles32 && programFiles64
      && sameText(p.slice(0, programFiles32.length), programFiles32)) {
    const path64 = programFiles64 + p.slice(programFiles32.length);
    if (exists(path64)) return { found: true, path: path64 };
  }

  // Only a bare file name is searched along PATH; a relative path with a
  // directory in it is not, exactly as the original.
  if (sameText(extractFileName(p), p)) {
    const paths = env.PATH || env.Path || '';
    if (paths) {
      for (const part of String(paths).split(';')) {
        // Not normalizing: PATH is not under our control and an invalid entry
        // must not throw, it must just fail to match.
        const candidate = includeTrailingBackslash(part) + p;
        if (exists(candidate)) return { found: true, path: candidate };
      }
    }
  }

  return { found: false, path: p };
}

/**
 * FindTool: beside the application, then in its bundled tools folder, then on
 * PATH. `subFolder` is 'PuTTY' in the original; kept configurable because this
 * port bundles its own helpers elsewhere.
 */
function findTool(name, options) {
  const opts = options || {};
  const exists = opts.exists || defaultFileExists;
  const appPath = includeTrailingBackslash(opts.appDir || nodePath.dirname(process.execPath));
  const subFolder = opts.subFolder === undefined ? 'PuTTY' : opts.subFolder;

  let path = appPath + name;
  if (exists(path)) return { found: true, path };

  if (subFolder) {
    path = appPath + subFolder + WIN_SEP + name;
    if (exists(path)) return { found: true, path };
  }

  return findFile(name, opts);
}

// ---------------------------------------------------------------------------
// "Open in external application"
// ---------------------------------------------------------------------------

/**
 * Resolve a stored "open with" command against a file.
 *
 * The order matters and is the original's (CustomScpExplorer.cpp):
 *   reformat the whole command so it mentions the file at all
 *   -> split it into program and parameters
 *   -> substitute '!.!' in the PARAMETERS only
 *   -> expand environment variables in the PROGRAM only.
 *
 * That asymmetry is deliberate in WinSCP: a '%' in a file name must survive
 * into the parameters untouched, and a '%ProgramFiles%' in the program must
 * not. Do not "tidy" it into expanding both.
 */
function resolveExternalApplication(command, fileName, options) {
  const opts = options || {};
  const reformatted = reformatFileNameCommand(command);
  const split = splitCommand(reformatted);
  const params = fileName === undefined || fileName === null
    ? split.params
    : expandFileNameCommand(split.params, fileName);
  const program = expandEnvironmentVariables(split.program, opts.env);
  const located = findFile(program, opts);
  return {
    program: located.path,
    params,
    dir: split.dir,
    found: located.found,
    commandLine: formatCommand(located.path, params),
  };
}

/** Everything the caller needs to hand to spawn(), computed but not executed. */
function buildSpawn(program, params, options) {
  const opts = options || {};
  const isWindows = opts.platform === undefined ? process.platform === 'win32' : opts.platform === 'win32';
  const args = params ? parseWindowsCommandLine(params) : [];
  const spawnOptions = {
    // WinSCP starts a tool in its own directory so that relative paths inside
    // the tool's own configuration (PuTTY private keys, for one) resolve.
    cwd: opts.changeWorkingDirectory ? (extractFilePath(program) || undefined) : opts.cwd,
    detached: opts.detached !== false,
    stdio: opts.stdio || 'ignore',
    env: opts.env,
    windowsHide: false,
  };
  if (isWindows) {
    // Preserve the user's own quoting exactly: they typed a command line, not
    // an argument vector, and re-quoting it would change what the tool sees.
    spawnOptions.windowsVerbatimArguments = true;
    // ...but argv[0] is ours, not theirs, and it MUST be quoted. Node prepends
    // `file` to the verbatim command line unquoted unless argv0 says otherwise,
    // so a tool under "C:\Program Files\..." would be handed
    //   C:\Program Files\x\np.exe -flag
    // and every tool that re-parses GetCommandLine() (CommandLineToArgvW does)
    // would read its own path as two arguments and open "Files\x\np.exe".
    // ShellExecuteEx never had this problem because lpFile and lpParameters are
    // separate; here the quoting is ours to supply, exactly as FormatCommand does.
    spawnOptions.argv0 = addQuotes(program);
    return { file: program, args: params ? [params] : [], options: spawnOptions, commandLine: formatCommand(program, params) };
  }
  return { file: program, args, options: spawnOptions, commandLine: formatCommand(program, params) };
}

/**
 * CopyCommandToClipboard: holding Ctrl while invoking a command copies it
 * instead of running it. It is a real WinSCP feature, not a debugging aid, and
 * the caller must be told which of the two happened.
 */
function shouldCopyCommandInsteadOfExecuting(state) {
  const s = state || {};
  return !s.disabled && !!s.alternativeFunction && !!s.ctrlPressed;
}

/**
 * DoExecuteShell. Returns { copied: true, command } when the Ctrl rule fired,
 * otherwise { copied: false, child }. Never throws for a missing program —
 * that is executeShellChecked's job, so callers that want the softer contract
 * can have it.
 */
function executeShell(program, params, options) {
  const opts = options || {};
  const plan = buildSpawn(program, params, opts);
  if (shouldCopyCommandInsteadOfExecuting(opts)) {
    if (opts.copyToClipboard) opts.copyToClipboard(plan.commandLine);
    return { copied: true, command: plan.commandLine, child: null };
  }
  const spawn = opts.spawn || childProcess.spawn;
  const child = spawn(plan.file, plan.args, plan.options);
  return { copied: false, command: plan.commandLine, child };
}

/**
 * ExecuteShellChecked. WinSCP turns a failed ShellExecuteEx into one specific
 * message naming the program; spawn reports the same failure asynchronously, so
 * an `exists` probe is offered for the common "the program is not there" case
 * and any synchronous failure is wrapped the same way.
 */
function executeShellChecked(program, params, options) {
  const opts = options || {};
  if (opts.exists && !opts.exists(program)) throw new ExecuteAppError(program);
  try {
    return executeShell(program, params, opts);
  } catch (e) {
    throw new ExecuteAppError(program, e);
  }
}

/** ExecuteShellCheckedAndWait — resolves with the process exit code. */
function executeShellCheckedAndWait(command, options) {
  const { program, params } = splitCommand(command);
  const result = executeShellChecked(program, params, { stdio: 'ignore', detached: false, ...(options || {}) });
  if (result.copied || !result.child) return Promise.resolve(0);
  return new Promise((resolve, reject) => {
    result.child.on('error', (e) => reject(new ExecuteAppError(program, e)));
    result.child.on('exit', (code) => resolve(code === null ? 0 : code));
  });
}

// ---------------------------------------------------------------------------
// Temporary directories (GUITools.cpp UniqTempDir, WinConfiguration,
// CustomScpExplorer::TemporaryDirectoryForRemoteFiles)
// ---------------------------------------------------------------------------

function systemTemporaryDirectory() {
  return includeTrailingBackslash(require('os').tmpdir());
}

function expandedTemporaryDirectory(config, options) {
  const opts = options || {};
  const configured = (config && config.ddTemporaryDirectory) || '';
  const expanded = expandEnvironmentVariables(configured, opts.env);
  if (!expanded) return opts.systemTemp || systemTemporaryDirectory();
  return nodePath.resolve(expanded);
}

/**
 * UniqTempDir. Two shapes:
 *   mask=false  a real directory name: base + identity + 'mmSSS' + '\', retried
 *               until the name is free (the millisecond makes it unique).
 *   mask=true   the wildcard that finds every such directory again, which is
 *               how "Clean up temporary folders" locates them. The five '?'
 *               are exactly the five digits the non-mask form produces — change
 *               one and the cleanup silently stops finding anything.
 */
function uniqTempDir(baseDir, identity, mask, options) {
  const opts = options || {};
  if (!baseDir) throw new Error('uniqTempDir needs a base directory');
  const id = identity === undefined ? 'scp' : identity;
  const base = includeTrailingBackslash(baseDir);

  if (mask) return base + id + '?????';

  const exists = opts.directoryExists || ((p) => {
    try { return fs.statSync(p).isDirectory(); } catch { return false; }
  });
  const now = opts.now || (() => new Date());
  const attempts = opts.maxAttempts === undefined ? 5000 : opts.maxAttempts;

  for (let i = 0; i < attempts; i++) {
    const d = now();
    const stamp = String(d.getMinutes()).padStart(2, '0') + String(d.getMilliseconds()).padStart(3, '0');
    const dir = includeTrailingBackslash(base + id + stamp);
    if (!exists(dir)) return dir;
  }
  throw new CreateTempDirError(base + id);
}

function temporaryDir(config, mask, options) {
  return uniqTempDir(expandedTemporaryDirectory(config, options), 'scp', mask, options);
}

/**
 * TemporaryDirectoryForRemoteFiles.
 *
 * `simple` is what drag-and-drop and "edit one file" pass: it forces a fresh
 * throwaway directory and skips both the session and path suffixes, because
 * those exist to make a *browsable* temporary tree, not a scratch file.
 *
 * The deterministic option is the interesting one: it drops the unique
 * component entirely so the same remote path always lands on the same local
 * path. That makes external editors reopen the same document, but it also
 * means there is no root directory to delete afterwards — hence rootDir is ''
 * in that case, and the caller must not try to clean it up.
 */
function temporaryDirectoryForRemoteFiles(remoteDirectory, config, options) {
  const opts = options || {};
  const cfg = config || {};
  const simple = !!opts.simple;
  let rootDir;
  let result;

  if (!cfg.temporaryDirectoryDeterministic || simple) {
    rootDir = includeTrailingBackslash(temporaryDir(cfg, false, opts));
    result = rootDir;
  } else {
    rootDir = '';
    result = includeTrailingBackslash(expandedTemporaryDirectory(cfg, opts));
  }

  if (cfg.temporaryDirectoryAppendSession && !simple) {
    result = includeTrailingBackslash(result + makeValidFileName(opts.sessionName || ''));
  }

  if (cfg.temporaryDirectoryAppendPath && !simple) {
    let remote = String(remoteDirectory == null ? '' : remoteDirectory);
    if (remote.startsWith('/')) remote = remote.slice(1);
    result = includeTrailingBackslash(result + validLocalPath(fromUnixPath(remote), opts.fileNameOptions));
  }

  const mkdir = opts.mkdir || ((p) => fs.mkdirSync(p, { recursive: true }));
  try {
    mkdir(result);
  } catch (e) {
    throw new CreateTempDirError(result, e);
  }

  return { dir: result, rootDir };
}

// ---------------------------------------------------------------------------
// ApplyTabs (GUITools.cpp) — column alignment inside a plain-text hint
// ---------------------------------------------------------------------------

function isEligibleForApplyingTabs(line) {
  const s = String(line == null ? '' : line);
  const tabPos = s.indexOf('\t');
  if (tabPos < 0) return null;
  let remaining = s.slice(tabPos + 1);
  // WORKAROUND from the original: some translations pad with runs of tabs.
  while (remaining.startsWith('\t')) remaining = remaining.slice(1);
  if (remaining.includes('\t')) return null;   // one tab per line only
  // Previously translations padded with spaces before the tab; trim that and
  // guarantee at least two spaces of separation.
  const start = s.slice(0, tabPos).replace(/\s+$/, '') + '  ';
  return { tabPos, start, remaining };
}

function applyTabs(text, padding, calculateWidth) {
  const pad = padding === undefined ? ' ' : padding;
  const width = calculateWidth || ((s) => s.length);
  const lines = String(text == null ? '' : text).split(/\r\n|\n|\r/);

  let maxWidth = -1;
  for (const line of lines) {
    const e = isEligibleForApplyingTabs(line);
    if (e) maxWidth = Math.max(maxWidth, width(e.start));
  }
  if (maxWidth < 0) return String(text == null ? '' : text);

  const out = lines.map((line) => {
    const e = isEligibleForApplyingTabs(line);
    if (!e) return line;
    let start = e.start;
    let iterations = 0;
    let w;
    while ((w = width(start)) < maxWidth) {
      const wider = width(start + pad);
      // Stop before overshooting further than the current shortfall.
      if (wider > maxWidth && (wider - maxWidth) > (maxWidth - w)) break;
      start += pad;
      iterations++;
      if (iterations > 100) break;   // a zero-width pad would loop forever
    }
    return start + e.remaining;
  });

  return out.join('\n').replace(/\s+$/, '');
}

// ---------------------------------------------------------------------------
// Text comparison used by every sort (core/Common.cpp CompareLogicalText)
// ---------------------------------------------------------------------------

function isDigit(c) { return c >= '0' && c <= '9'; }

/**
 * StrCmpLogicalW's rule: runs of digits compare by value, everything else
 * compares case-insensitively. Where two numeric runs have the same value the
 * one written with more leading zeros sorts first, which is what the Win32
 * function does and what makes "file01" precede "file1".
 *
 * This is a reimplementation, not a binding: shlwapi is not available here.
 * The ordering it produces is deterministic and stable, which is what the
 * panel needs; it is not byte-identical to Windows for exotic collation.
 */
function strCmpLogical(a, b) {
  const s1 = String(a == null ? '' : a);
  const s2 = String(b == null ? '' : b);
  let i = 0;
  let j = 0;
  while (i < s1.length && j < s2.length) {
    if (isDigit(s1[i]) && isDigit(s2[j])) {
      const start1 = i;
      const start2 = j;
      while (i < s1.length && isDigit(s1[i])) i++;
      while (j < s2.length && isDigit(s2[j])) j++;
      const run1 = s1.slice(start1, i);
      const run2 = s2.slice(start2, j);
      const t1 = run1.replace(/^0+(?=\d)/, '');
      const t2 = run2.replace(/^0+(?=\d)/, '');
      if (t1.length !== t2.length) return t1.length < t2.length ? -1 : 1;
      if (t1 !== t2) return t1 < t2 ? -1 : 1;
      if (run1.length !== run2.length) return run1.length > run2.length ? -1 : 1;
      continue;
    }
    const c1 = s1[i].toLowerCase();
    const c2 = s2[j].toLowerCase();
    if (c1 !== c2) return c1 < c2 ? -1 : 1;
    i++;
    j++;
  }
  if (i < s1.length) return 1;
  if (j < s2.length) return -1;
  return 0;
}

function compareTextCaseInsensitive(a, b) {
  const s1 = String(a == null ? '' : a).toLowerCase();
  const s2 = String(b == null ? '' : b).toLowerCase();
  if (s1 < s2) return -1;
  if (s1 > s2) return 1;
  return 0;
}

function compareOrdinal(a, b) {
  const s1 = String(a == null ? '' : a);
  const s2 = String(b == null ? '' : b);
  if (s1 < s2) return -1;
  if (s1 > s2) return 1;
  return 0;
}

/** CompareLogicalText: case-insensitive first, ordinal only to break a tie. */
function compareLogicalText(a, b, naturalOrderNumericalSorting) {
  let result = naturalOrderNumericalSorting
    ? strCmpLogical(a, b)
    : compareTextCaseInsensitive(a, b);
  if (result === 0) result = compareOrdinal(a, b);
  return result;
}

/**
 * ContainsTextSemiCaseSensitive: an all-lowercase needle matches
 * case-insensitively, a needle with any capital matches case-sensitively. It is
 * how incremental search lets you narrow a result by shifting a letter.
 */
function containsTextSemiCaseSensitive(text, subText) {
  const t = String(text == null ? '' : text);
  const s = String(subText == null ? '' : subText);
  if (s.toLowerCase() === s) return t.toLowerCase().includes(s.toLowerCase());
  return t.includes(s);
}

// ---------------------------------------------------------------------------
// Column definitions (DirViewColProperties.pas / UnixDirViewColProperties.pas)
// ---------------------------------------------------------------------------

// Widths are the original's design-time pixel values at 96 DPI. They are kept
// because they encode the intended proportions; the renderer scales them.
const REMOTE_COLUMNS = [
  { id: 'name', caption: 'Name', width: 150, alignment: 'left', visible: true },
  { id: 'size', caption: 'Size', width: 80, alignment: 'right', visible: true },
  { id: 'changed', caption: 'Date modified', width: 130, alignment: 'left', visible: true },
  { id: 'rights', caption: 'Rights', width: 100, alignment: 'left', visible: true },
  { id: 'owner', caption: 'Owner', width: 130, alignment: 'left', visible: true },
  { id: 'group', caption: 'Group', width: 130, alignment: 'left', visible: true },
  { id: 'ext', caption: 'Ext', width: 0, alignment: 'left', visible: false },
  { id: 'linkTarget', caption: 'Link target', width: 150, alignment: 'left', visible: false },
  { id: 'type', caption: 'Type', width: 125, alignment: 'left', visible: false },
];

const LOCAL_COLUMNS = [
  { id: 'name', caption: 'Name', width: 150, alignment: 'left', visible: true },
  { id: 'size', caption: 'Size', width: 80, alignment: 'right', visible: true },
  { id: 'type', caption: 'Type', width: 125, alignment: 'left', visible: true },
  { id: 'changed', caption: 'Date modified', width: 130, alignment: 'left', visible: true },
  { id: 'attr', caption: 'Attr', width: 45, alignment: 'left', visible: true },
  { id: 'ext', caption: 'Ext', width: 20, alignment: 'left', visible: false },
];

function defaultColumns(side) {
  const source = side === 'local' ? LOCAL_COLUMNS : REMOTE_COLUMNS;
  return source.map((c) => ({ ...c }));
}

// ---------------------------------------------------------------------------
// The item model — normalizing an adapter entry into what the comparators want
// ---------------------------------------------------------------------------

/**
 * Bridge from protocols/base.js `entry()` to the fields WinSCP's comparators
 * read. Anything already carrying the WinSCP-shaped field keeps it, so a caller
 * with richer data (a calculated directory size, a resolved type name) is not
 * forced to hide it.
 */
function fileFields(item) {
  const it = item || {};
  const name = it.name === undefined ? '' : String(it.name);
  const isParentDirectory = it.isParentDirectory !== undefined
    ? !!it.isParentDirectory
    : name === '..';
  const isDirectory = it.isDirectory !== undefined
    ? !!it.isDirectory
    : (it.type === 'dir' || isParentDirectory);
  const calculatedSize = it.calculatedSize === undefined ? -1 : it.calculatedSize;
  return {
    name,
    isDirectory,
    isParentDirectory,
    size: it.size || 0,
    calculatedSize,
    mtime: it.mtime || 0,
    rights: it.rights || '',
    owner: it.owner || '',
    group: it.group || '',
    linkTarget: it.linkTarget || '',
    typeName: it.typeName || '',
    extension: it.extension !== undefined ? it.extension : unixExtractFileExt(name),
    attr: it.attr === undefined ? 0 : it.attr,
    // IsUnixHiddenFile is IsRealFile() AND a leading dot: '.' and '..' are NOT
    // hidden files. Getting this wrong hides the way out of a directory the
    // moment the user turns hidden files off.
    hidden: isRealFile(name) && (it.hidden !== undefined ? !!it.hidden : name.startsWith('.')),
    inaccessible: !!it.inaccessible,
  };
}

/**
 * The remote panel's size column. WinSCP prefers a calculated (recursively
 * summed) size when one exists — that is how "Calculate directory sizes" makes
 * directories sortable — and falls back to the reported size otherwise.
 */
function remoteItemSize(f) {
  return f.calculatedSize >= 0 ? f.calculatedSize : f.size;
}

/**
 * The local panel's size column, and it is NOT the same rule: locally the
 * reported size wins and the calculated one is only a fallback, because a local
 * file always has a real size while a local directory reports zero. Two panels,
 * two rules — this asymmetry is in the original and is load-bearing.
 */
function localItemSize(f) {
  // DirViewInt.pas stores Size = -1 for a directory (see AddItem: "if not
  // IsDirectory then Size := SizeFromSRec else Size := -1"), which is what
  // makes GetItemFileSize fall through to CalculatedSize. Our adapters report
  // whatever stat() gave — 0 on NTFS, the allocation size elsewhere — so the
  // directory case has to be spelled out or a directory would sort by its
  // meaningless on-disk size instead of its calculated one.
  const size = f.isDirectory ? -1 : f.size;
  if (size >= 0) return size;
  return f.calculatedSize >= 0 ? f.calculatedSize : 0;
}

// ---------------------------------------------------------------------------
// Sort comparators (UnixDirView.cpp CompareFile / DirViewInt.pas CompareFile)
// ---------------------------------------------------------------------------

const DEFAULT_SORT_OPTIONS = {
  sortColumn: 'name',
  ascending: true,
  alwaysSortDirectoriesByName: false,
  naturalOrderNumericalSorting: true,
};

function compareNumber(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * The remote comparator.
 *
 * Grouping first: '..' always at the top, then directories, then files — and
 * that grouping is NEVER reversed by a descending sort. Descending a listing
 * that puts files above '..' would be unusable, so WinSCP applies the sign only
 * once the two items are in the same group.
 */
function makeRemoteComparator(options) {
  const o = { ...DEFAULT_SORT_OPTIONS, ...(options || {}) };
  const natural = o.naturalOrderNumericalSorting;

  return (a, b) => {
    const f1 = fileFields(a);
    const f2 = fileFields(b);

    if (f1.isParentDirectory && !f2.isParentDirectory) return -1;
    if (!f1.isParentDirectory && f2.isParentDirectory) return 1;
    if (f1.isDirectory && !f2.isDirectory) return -1;
    if (!f1.isDirectory && f2.isDirectory) return 1;

    let result = 0;
    if (!(f1.isDirectory && o.alwaysSortDirectoriesByName)) {
      switch (o.sortColumn) {
        case 'name':
          break;                                       // fall through to name
        case 'size':
          result = compareNumber(remoteItemSize(f1), remoteItemSize(f2));
          break;
        case 'changed':
          result = compareNumber(f1.mtime, f2.mtime);
          break;
        case 'rights':
          result = compareTextCaseInsensitive(f1.rights, f2.rights);
          break;
        case 'owner':
          result = compareTextCaseInsensitive(f1.owner, f2.owner);
          break;
        case 'group':
          result = compareTextCaseInsensitive(f1.group, f2.group);
          break;
        case 'ext':
          // Directories have no meaningful extension, so they fall back to name.
          if (!f1.isDirectory) result = compareLogicalText(f1.extension, f2.extension, natural);
          break;
        case 'linkTarget':
          result = compareLogicalText(f1.linkTarget, f2.linkTarget, natural);
          break;
        case 'type':
          result = compareLogicalText(f1.typeName, f2.typeName, natural);
          if (result === 0 && !f1.isDirectory) {
            result = compareLogicalText(f1.extension, f2.extension, natural);
          }
          break;
        default:
          break;
      }
    }

    if (result === 0) result = compareLogicalText(f1.name, f2.name, natural);
    return o.ascending ? result : -result;
  };
}

/** The local comparator. Same grouping rule; different columns and size rule. */
function makeLocalComparator(options) {
  const o = { ...DEFAULT_SORT_OPTIONS, ...(options || {}) };
  const natural = o.naturalOrderNumericalSorting;

  return (a, b) => {
    const f1 = fileFields(a);
    const f2 = fileFields(b);

    if (f1.isParentDirectory && !f2.isParentDirectory) return -1;
    if (!f1.isParentDirectory && f2.isParentDirectory) return 1;
    if (f1.isDirectory !== f2.isDirectory) return f1.isDirectory ? -1 : 1;

    let result = 0;
    if (!(f1.isDirectory && o.alwaysSortDirectoriesByName)) {
      switch (o.sortColumn) {
        case 'name':
          break;
        case 'size':
          result = compareNumber(localItemSize(f1), localItemSize(f2));
          break;
        case 'type':
          // The shell type name, then the extension, then the name — so two
          // "Text Document"s still order sensibly among themselves.
          result = compareLogicalText(
            f1.isDirectory ? `${f1.typeName} ${f1.name}` : `${f1.typeName} ${f1.extension} ${f1.name}`,
            f2.isDirectory ? `${f2.typeName} ${f2.name}` : `${f2.typeName} ${f2.extension} ${f2.name}`,
            natural);
          break;
        case 'changed':
          result = compareNumber(f1.mtime, f2.mtime);
          break;
        case 'attr':
          result = compareNumber(f1.attr, f2.attr);
          break;
        case 'ext':
          if (!f1.isDirectory) {
            result = compareLogicalText(
              `${f1.extension} ${f1.name}`, `${f2.extension} ${f2.name}`, natural);
          }
          break;
        default:
          break;
      }
    }

    if (result === 0) result = compareLogicalText(f1.name, f2.name, natural);
    return o.ascending ? result : -result;
  };
}

function sortItems(items, options) {
  const side = (options && options.side) === 'local' ? 'local' : 'remote';
  const comparator = side === 'local' ? makeLocalComparator(options) : makeRemoteComparator(options);
  return items.slice().sort(comparator);
}

// ---------------------------------------------------------------------------
// Loading and filtering a listing (UnixDirView::LoadFiles)
// ---------------------------------------------------------------------------

function isRealFile(name) {
  return name !== '.' && name !== '..';
}

/**
 * LoadFiles. Three exclusive outcomes per entry, in the original's order:
 * hidden (counted separately so the status bar can say "3 hidden"), filtered
 * out by the panel mask, or visible. '.' and '..' are never mask-filtered —
 * hiding the way out of a directory is not a filter, it is a trap.
 */
function loadFiles(files, options) {
  const o = options || {};
  const showHiddenFiles = o.showHiddenFiles !== false;
  const showInaccesibleDirectories = o.showInaccesibleDirectories !== false;
  const matchesMask = o.matchesMask;      // (file) => boolean, from masks.js
  const hasMask = !!o.mask && !!matchesMask;

  const items = [];
  let hiddenCount = 0;
  let filteredCount = 0;
  let filesSize = 0;
  let hasParentDir = false;

  for (const raw of files || []) {
    const f = fileFields(raw);
    if ((!showHiddenFiles && f.hidden)
        || (!showInaccesibleDirectories && f.inaccessible && f.isDirectory)) {
      hiddenCount++;
      continue;
    }
    if (hasMask && isRealFile(f.name) && !matchesMask(raw, f)) {
      filteredCount++;
      continue;
    }
    items.push(raw);
    filesSize += f.size;
    if (f.isParentDirectory) hasParentDir = true;
  }

  return { items, hiddenCount, filteredCount, filesSize, hasParentDir };
}

/**
 * ItemMatchesFilter — the predicate behind "Select files matching…". A
 * directory matches when the filter says directories count, even though the
 * mask itself was written for files.
 */
function itemMatchesFilter(item, filter, matchesMask) {
  const f = fileFields(item);
  if (!filter || !filter.masks) return true;
  if (matchesMask(item, f, f.isDirectory)) return true;
  if (f.isDirectory && filter.directories && matchesMask(item, f, false)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// The selection model (NortonLikeListView.pas)
// ---------------------------------------------------------------------------

const SELECT_MODE = { ALL: 'all', NONE: 'none', INVERT: 'invert' };
const NORTON_LIKE = { ON: 'on', OFF: 'off', KEYBOARD: 'keyboard' };

/**
 * The panel's selection.
 *
 * The one rule that surprises everybody: in Norton-like mode a panel with
 * nothing selected still has a "marked" file — the focused one. Commands act on
 * the marked set, so pressing Delete with no selection deletes the focused
 * file, exactly as in every orthodox file manager. Turn Norton-like off and the
 * marked set is the selection and nothing else.
 */
class SelectionModel {
  constructor(options) {
    const o = options || {};
    this.count = o.count || 0;
    this.nortonLike = o.nortonLike || NORTON_LIKE.ON;
    this.selected = new Set();
    this.focusedIndex = o.focusedIndex === undefined ? -1 : o.focusedIndex;
    // WinSCP keeps first/last as an optimization AND as state: they go to -1
    // when they can no longer be trusted (after a reorder) rather than being
    // recomputed, so a caller must never assume they are exact.
    this.firstSelected = -1;
    this.lastSelected = -1;
    // Selecting "implicitly" is what a plain click does in keyboard mode: the
    // selection follows the cursor and is discarded the moment the user makes a
    // real one.
    this.anyAndAllSelectedImplicitly = false;
    // TCustomDirView::CanChangeSelection — a REFUSAL, not a hint. The parent
    // directory can never enter the selection, which is why "select all" +
    // Delete cannot ask the server to delete '..'. NortonLikeListView routes
    // every state change through ExCanChange, so nothing can bypass it; the
    // same is true here.
    this.parentDirectoryIndex = o.parentDirectoryIndex === undefined ? -1 : o.parentDirectoryIndex;
    this.loading = !!o.loading;
    this.canChangeSelectionHook = o.canChangeSelection || null;
  }

  /** ExCanChange's gate. Returns false for anything that must not be selected. */
  canChangeSelection(index, select) {
    if (this.loading) return false;
    if (index === this.parentDirectoryIndex) return false;
    if (this.canChangeSelectionHook) return !!this.canChangeSelectionHook(index, select);
    return true;
  }

  get selCount() { return this.selected.size; }

  /** MarkedCount: the selection, or the focused item when Norton-like. */
  get markedCount() {
    if (this.selCount > 0 || this.nortonLike === NORTON_LIKE.OFF) return this.selCount;
    return this.focusedIndex >= 0 ? 1 : 0;
  }

  /** MarkedFile: the first selected item, else the focused one. */
  get markedIndex() {
    if (this.selCount > 0) {
      const sorted = [...this.selected].sort((a, b) => a - b);
      return sorted[0];
    }
    if (this.focusedIndex >= 0 && this.nortonLike !== NORTON_LIKE.OFF) return this.focusedIndex;
    return -1;
  }

  markedIndexes() {
    if (this.selCount > 0 || this.nortonLike === NORTON_LIKE.OFF) {
      return [...this.selected].sort((a, b) => a - b);
    }
    return this.focusedIndex >= 0 ? [this.focusedIndex] : [];
  }

  isSelected(index) { return this.selected.has(index); }

  setSelected(index, select, implicit) {
    if (index < 0 || index >= this.count) return false;
    const was = this.selected.has(index);
    if (was === !!select) return false;
    if (!this.canChangeSelection(index, !!select)) return false;
    if (select) {
      this.selected.add(index);
      if (implicit && this.selected.size === 1) this.anyAndAllSelectedImplicitly = true;
      else if (!implicit) this.anyAndAllSelectedImplicitly = false;
      if (this.selected.size === 1) {
        this.firstSelected = index;
        this.lastSelected = index;
      } else {
        if (this.firstSelected >= 0 && index < this.firstSelected) this.firstSelected = index;
        if (this.lastSelected >= 0 && index > this.lastSelected) this.lastSelected = index;
      }
    } else {
      this.selected.delete(index);
      if (this.selected.size === 0 || !implicit) this.anyAndAllSelectedImplicitly = false;
      if (this.firstSelected === index) {
        this.firstSelected = this.selected.size === 1 ? this.lastSelected : -1;
      }
      if (this.lastSelected === index) {
        this.lastSelected = this.selected.size === 1 ? this.firstSelected : -1;
      }
    }
    return true;
  }

  selectAll(mode, excludeIndex) {
    for (let i = 0; i < this.count; i++) {
      if (i === excludeIndex) continue;
      let next;
      if (mode === SELECT_MODE.ALL) next = true;
      else if (mode === SELECT_MODE.NONE) next = false;
      else if (mode === SELECT_MODE.INVERT) next = !this.selected.has(i);
      else next = false;
      this.setSelected(i, next);
    }
  }

  /** Insert: toggle the focused item and step down, the orthodox gesture. */
  selectCurrentItem(focusNext) {
    const index = this.focusedIndex >= 0 ? this.focusedIndex : 0;
    if (this.count === 0) return -1;
    this.setSelected(index, !this.selected.has(index));
    if (focusNext && index + 1 < this.count) this.focusedIndex = index + 1;
    return index;
  }

  /** Select or unselect everything matching a filter, without touching the rest. */
  selectFiles(items, predicate, select) {
    let changed = 0;
    for (let i = 0; i < this.count && i < items.length; i++) {
      if (this.selected.has(i) === !!select) continue;
      if (predicate(items[i], i)) {
        this.setSelected(i, select);
        changed++;
      }
    }
    return changed;
  }

  /**
   * ClosestUnselected: where the focus should land once the selection is
   * deleted. Search forward first, then backward; return null when everything
   * is selected, because there is nowhere sensible to go.
   */
  closestUnselected(index) {
    if (index === null || index === undefined || index < 0) return index;
    const shouldMove = this.selected.has(index)
      || (this.nortonLike !== NORTON_LIKE.OFF && this.selCount === 0);
    if (!shouldMove) return index;

    let i = index + 1;
    while (i < this.count && this.selected.has(i)) i++;
    if (i >= this.count || this.selected.has(i)) {
      i = index - 1;
      while (i >= 0 && this.selected.has(i)) i--;
    }
    if (i >= 0 && i < this.count && !this.selected.has(i)) return i;
    return null;
  }

  /** An item was removed; indexes above it shift down. */
  deleteItem(index) {
    const next = new Set();
    for (const i of this.selected) {
      if (i === index) continue;
      next.add(i > index ? i - 1 : i);
    }
    this.selected = next;
    if (this.lastSelected >= 0 && index <= this.lastSelected) this.lastSelected--;
    if (this.firstSelected >= 0 && index <= this.firstSelected) this.firstSelected--;
    this.count = Math.max(0, this.count - 1);
    if (this.parentDirectoryIndex > index) this.parentDirectoryIndex--;
    else if (this.parentDirectoryIndex === index) this.parentDirectoryIndex = -1;
    if (this.focusedIndex > index) this.focusedIndex--;
    if (this.focusedIndex >= this.count) this.focusedIndex = this.count - 1;
    if (this.selected.size === 0) { this.firstSelected = -1; this.lastSelected = -1; }
  }

  clear(count) {
    this.selected.clear();
    this.firstSelected = -1;
    this.lastSelected = -1;
    this.anyAndAllSelectedImplicitly = false;
    if (count !== undefined) this.count = count;
    this.focusedIndex = -1;
  }

  /** After a sort the cached endpoints mean nothing; say so rather than lie. */
  itemsReordered() {
    this.firstSelected = -1;
    this.lastSelected = -1;
  }
}

// ---------------------------------------------------------------------------
// Incremental search (GUITools.cpp + CustomScpExplorer.cpp)
// ---------------------------------------------------------------------------

const PANEL_SEARCH = { NAME_START_ONLY: 'nameStartOnly', NAME: 'name', ALL: 'all' };

class IncrementalSearchState {
  constructor() { this.reset(); }

  reset() {
    this.searching = false;
    this.text = '';
    this.haveNext = false;
  }
}

function formatIncrementalSearchStatus(state, strings) {
  const s = strings || {};
  const searchFormat = s.search || 'Search: %s';
  const typeHint = s.type || '(type to search)';
  const next = s.next || '(Ctrl+Enter for next)';
  const shown = state.text ? state.text : typeHint;
  let result = searchFormat.replace('%s', shown);
  if (state.haveNext && state.text) result += ' ' + next;
  return result;
}

function nextSearchIndex(index, count, reverse) {
  if (!reverse) {
    const i = index + 1;
    return i >= count ? 0 : i;
  }
  const i = index - 1;
  return i < 0 ? count - 1 : i;
}

/**
 * SearchFile: wrap around from the focused item until we come back to it. In
 * 'all' mode only VISIBLE columns are searched, because searching a column the
 * user cannot see produces a match they cannot explain.
 */
function searchFile(items, text, options) {
  const o = options || {};
  const count = items.length;
  if (count === 0) return -1;

  const mode = o.mode || PANEL_SEARCH.NAME_START_ONLY;
  const nameOf = o.nameOf || ((item) => fileFields(item).name);
  const columnText = o.columnText || ((item) => fileFields(item).name);
  const columns = o.columns || [];
  const reverse = !!o.reverse;

  const currentIndex = o.focusedIndex >= 0 && o.focusedIndex < count ? o.focusedIndex : 0;
  let index = currentIndex;
  if (o.skipCurrent) index = nextSearchIndex(index, count, reverse);

  for (;;) {
    const item = items[index];
    let matches = false;
    if (mode === PANEL_SEARCH.NAME_START_ONLY) {
      matches = containsTextSemiCaseSensitive(String(nameOf(item)).slice(0, text.length), text);
    } else if (mode === PANEL_SEARCH.NAME) {
      matches = containsTextSemiCaseSensitive(nameOf(item), text);
    } else {
      const colCount = columns.length || 1;
      for (let c = 0; c < colCount && !matches; c++) {
        const visible = columns.length ? columns[c].visible !== false : true;
        if (visible) matches = containsTextSemiCaseSensitive(columnText(item, c), text);
      }
    }

    if (matches) return index;

    index = nextSearchIndex(index, count, reverse);
    if (index === currentIndex) return -1;
  }
}

/**
 * IncrementalSearch. Returns { found, index, state }. When nothing matches the
 * state is left ALONE — WinSCP beeps and keeps the previous match, so a typo
 * does not throw away the search you had.
 */
function incrementalSearch(items, text, state, options) {
  const o = options || {};
  const index = searchFile(items, text, { ...o, skipCurrent: !!o.skipCurrent });
  if (index < 0) return { found: false, index: -1, state };

  const nextIndex = searchFile(items, text, { ...o, focusedIndex: index, skipCurrent: true });
  state.searching = true;
  state.text = text;
  state.haveNext = nextIndex >= 0 && nextIndex !== index;
  return { found: true, index, state };
}

// ---------------------------------------------------------------------------
// Path history (CustomDirView.pas)
// ---------------------------------------------------------------------------

const DEFAULT_HISTORY_COUNT = 200;

/**
 * Back/forward for one panel.
 *
 * The model is a single list with a cursor: `backCount` entries behind the
 * current path, the rest ahead. Navigating somewhere new truncates the forward
 * half, which is what a browser does and what users expect.
 */
class PathHistory {
  constructor(options) {
    const o = options || {};
    this.paths = [];
    this.backCount = 0;
    this.maxHistoryCount = o.maxHistoryCount || DEFAULT_HISTORY_COUNT;
    this.currentPath = o.path || '';
    this.dontRecord = false;
  }

  get forwardCount() { return this.paths.length - this.backCount; }

  /** HistoryPath[Index]: 0 is now, negative is back, positive is forward. */
  historyPath(index) {
    if (index === 0) return this.currentPath;
    if (index < 0) return this.paths[index + this.backCount];
    return this.paths[index + this.backCount - 1];
  }

  limitHistorySize() {
    while (this.paths.length > this.maxHistoryCount) {
      if (this.backCount > 0) {
        this.paths.shift();
        this.backCount--;
      } else {
        this.paths.pop();
      }
    }
  }

  setMaxHistoryCount(value) {
    if (this.maxHistoryCount !== value) {
      this.maxHistoryCount = value;
      this.limitHistorySize();
    }
  }

  /** The panel arrived somewhere. Records the path we left, not the one we reached. */
  pathChanged(newPath) {
    if (!this.dontRecord && this.currentPath !== '' && this.currentPath !== newPath) {
      this.paths.length = this.backCount;      // drop the forward half
      this.paths.push(this.currentPath);
      this.backCount++;
      this.limitHistorySize();
    }
    this.currentPath = newPath;
  }

  /**
   * Go back (negative) or forward (positive). The path we are leaving takes the
   * place of the one we go to, so the history stays the same length and the
   * move is itself undoable.
   */
  go(index) {
    if (index === 0) return this.currentPath;
    const target = this.historyPath(index);
    if (target === undefined) return null;
    const prevPath = this.currentPath;

    this.dontRecord = true;
    try {
      this.currentPath = target;
    } finally {
      this.dontRecord = false;
    }

    this.paths.splice(this.backCount, 0, prevPath);
    this.paths.splice(index + this.backCount, 1);
    this.backCount += index;
    this.limitHistorySize();
    return target;
  }

  canGoBack() { return this.backCount >= 1; }
  canGoForward() { return this.forwardCount >= 1; }
}

// ---------------------------------------------------------------------------
// History combo (packages/my/HistoryComboBox.cpp)
// ---------------------------------------------------------------------------

const DEFAULT_MAX_HISTORY_SIZE = 30;
const DEFAULT_HISTORY_DROPDOWN_COUNT = 16;
const HISTORY_SAVE_ON = { EXIT: 'exit', DROPDOWN: 'dropDown' };

/**
 * SaveToHistory: newest first, duplicates removed (all of them, not just the
 * first), list trimmed to size. An empty value is not recorded but still
 * triggers the trim, which is how lowering the limit takes effect immediately.
 */
function saveToHistory(list, text, maxHistorySize) {
  const max = maxHistorySize === undefined ? DEFAULT_MAX_HISTORY_SIZE : maxHistorySize;
  const out = Array.isArray(list) ? list.slice() : [];
  const t = text == null ? '' : String(text);
  if (t !== '') {
    for (let i = out.length - 1; i >= 0; i--) if (out[i] === t) out.splice(i, 1);
    out.unshift(t);
  }
  while (out.length > max) out.pop();
  return out;
}

/**
 * The behaviour of a path/mask/command combo box, minus the widget.
 *
 * saveOn decides WHEN a typed value joins the history: on leaving the field, on
 * opening the drop-down, or both (WinSCP's default). Ctrl+Delete with the list
 * open clears it — a real shortcut users rely on to purge a mistyped host.
 */
class HistoryCombo {
  constructor(options) {
    const o = options || {};
    this.items = Array.isArray(o.items) ? o.items.slice() : [];
    this.text = o.text || '';
    this.maxHistorySize = o.maxHistorySize === undefined ? DEFAULT_MAX_HISTORY_SIZE : o.maxHistorySize;
    this.dropDownCount = o.dropDownCount || DEFAULT_HISTORY_DROPDOWN_COUNT;
    this.saveOn = new Set(o.saveOn || [HISTORY_SAVE_ON.EXIT, HISTORY_SAVE_ON.DROPDOWN]);
    this.historyKey = o.historyKey || '';
  }

  setMaxHistorySize(value) {
    this.maxHistorySize = value;
    while (this.items.length > this.maxHistorySize) this.items.pop();
  }

  addToHistory() {
    if (this.text === '') return false;
    this.items = saveToHistory(this.items, this.text, this.maxHistorySize);
    return true;
  }

  exit() {
    if (this.saveOn.has(HISTORY_SAVE_ON.EXIT)) return this.addToHistory();
    return false;
  }

  dropDown() {
    if (this.saveOn.has(HISTORY_SAVE_ON.DROPDOWN)) return this.addToHistory();
    return false;
  }

  /** Arrow keys record the typed value first, so it is not lost by browsing. */
  arrowKey() {
    if (this.saveOn.has(HISTORY_SAVE_ON.DROPDOWN) && !this.items.includes(this.text)) {
      return this.addToHistory();
    }
    return false;
  }

  clearHistory() {
    if (this.saveOn.size === 0) return false;
    this.items = [];
    return true;
  }
}

// ---------------------------------------------------------------------------
// Mask editing (forms/EditMask.cpp + windows/Tools.cpp ValidateMaskEdit)
// ---------------------------------------------------------------------------

const FILE_MASK_DELIMITERS = ';,';
const INCLUDE_EXCLUDE_DELIMITER = '|';
const ALL_FILE_MASK_DELIMITERS = FILE_MASK_DELIMITERS + INCLUDE_EXCLUDE_DELIMITER;
const DIRECTORY_MASK_DELIMITERS = '\\/';
const FILE_MASKS_DELIMITER_STR = '; ';

/**
 * MakeDirectoryMask: a directory mask must end in a separator. If the mask
 * already contains one, reuse THAT flavour so a Windows-style mask stays
 * Windows-style; otherwise use '/'.
 */
function makeDirectoryMask(str) {
  let s = String(str == null ? '' : str);
  if (s === '') return s;
  const last = s[s.length - 1];
  if (DIRECTORY_MASK_DELIMITERS.includes(last)) return s;
  let delimiter = '/';
  for (let i = s.length - 1; i >= 0; i--) {
    if (DIRECTORY_MASK_DELIMITERS.includes(s[i])) { delimiter = s[i]; break; }
  }
  s += delimiter;
  return s;
}

/**
 * ComposeMaskStr for one list of lines.
 *
 * Every delimiter character inside a line is DOUBLED, which is how the mask
 * syntax escapes a literal ';' or '|' in a file name. Then the line is turned
 * into a directory mask (trailing separator added) or de-directorified.
 *
 * The subtlety worth keeping: validation runs against the version WITHOUT the
 * trailing separator. Adding the separator would move a size or time condition
 * behind it and silently disable that condition's validation.
 */
function composeMaskStr(lines, directory) {
  let result = '';
  let resultNoDirMask = '';

  for (const line of lines || []) {
    let str = String(line == null ? '' : line).trim();
    if (str === '') continue;

    let escaped = '';
    for (const ch of str) {
      escaped += ALL_FILE_MASK_DELIMITERS.includes(ch) ? ch + ch : ch;
    }
    str = escaped;

    let strNoDirMask;
    if (directory) {
      strNoDirMask = str;
      str = makeDirectoryMask(str);
    } else {
      while (str.length && DIRECTORY_MASK_DELIMITERS.includes(str[str.length - 1])) {
        str = str.slice(0, -1);
      }
      strNoDirMask = str;
    }

    result = addToList(result, str, FILE_MASKS_DELIMITER_STR);
    resultNoDirMask = addToList(resultNoDirMask, strNoDirMask, FILE_MASKS_DELIMITER_STR);
  }

  return { masks: result, masksForValidation: resultNoDirMask };
}

/** The four-memo form of the mask dialog composed into one mask string. */
function composeMaskStrAll(includeFiles, excludeFiles, includeDirectories, excludeDirectories) {
  const incF = composeMaskStr(includeFiles, false);
  const incD = composeMaskStr(includeDirectories, true);
  const excF = composeMaskStr(excludeFiles, false);
  const excD = composeMaskStr(excludeDirectories, true);

  const includeMasks = addToList(incF.masks, incD.masks, FILE_MASKS_DELIMITER_STR);
  const excludeMasks = addToList(excF.masks, excD.masks, FILE_MASKS_DELIMITER_STR);

  let result = includeMasks;
  if (excludeMasks !== '') {
    if (result !== '') result += ' ';
    result += INCLUDE_EXCLUDE_DELIMITER + ' ' + excludeMasks;
  }

  return {
    masks: result,
    validation: [
      { lines: includeFiles, directory: false, masks: incF.masksForValidation },
      { lines: excludeFiles, directory: false, masks: excF.masksForValidation },
      { lines: includeDirectories, directory: true, masks: incD.masksForValidation },
      { lines: excludeDirectories, directory: true, masks: excD.masksForValidation },
    ],
  };
}

/**
 * Split a mask string back into the dialog's four lists — the inverse of
 * composeMaskStrAll, so opening the editor on an existing mask shows what the
 * user actually typed rather than a normalized rewrite.
 */
function decomposeMaskStr(maskString, parse) {
  const parsed = parse(maskString);
  const userStrings = (list) => list.map((m) => m.userStr);
  return {
    includeFiles: userStrings(parsed.fileInclude),
    excludeFiles: userStrings(parsed.fileExclude),
    includeDirectories: userStrings(parsed.dirInclude),
    excludeDirectories: userStrings(parsed.dirExclude),
  };
}

/**
 * ValidateMaskEdit. Returns { ok } or { ok:false, error, start, length } so the
 * caller can put the caret on the offending character, which is exactly what
 * WinSCP does with E.ErrorStart / E.ErrorLen.
 *
 * `validate` is masks.js's validate(); passing it in keeps this module free of
 * a hard dependency on the mask engine and lets tests drive both halves.
 */
function validateMaskEdit(maskString, validate, options) {
  const o = options || {};
  const forceDirectoryMasks = o.directory === undefined ? -1 : (o.directory ? 1 : 0);
  return validate(maskString, { forceDirectoryMasks });
}

/** Validate every memo of the four-memo dialog and report the first failure. */
function validateMaskEditAll(composed, validate) {
  for (const part of composed.validation) {
    if (part.masks === '') continue;
    const result = validateMaskEdit(part.masks, validate, { directory: part.directory });
    if (!result.ok) return { ...result, directory: part.directory };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// The remote directory tree (components/UnixDriveView.cpp)
// ---------------------------------------------------------------------------

/**
 * The tree beside the remote panel.
 *
 * Children are kept sorted so lookups can binary-search exactly as the original
 * does, and the comparator used for the search is the SAME one used for the
 * sort — a mismatch there produces a tree where a directory exists but cannot
 * be found, which is the worst kind of bug to chase.
 */
class DirectoryTree {
  constructor(options) {
    const o = options || {};
    this.rootName = o.rootName || '/';
    this.showHiddenDirs = !!o.showHiddenDirs;
    this.showInaccesibleDirectories = o.showInaccesibleDirectories !== false;
    this.compareText = o.compareText || ((a, b) => compareTextCaseInsensitive(a, b));
    this.root = this._makeNode(null, '/', this.rootName, null);
    // Nodes we wanted to delete but could not, because the selection sits
    // inside them. WinSCP keeps them and retries; dropping them would leave
    // the tree showing a directory the server no longer has.
    this.pendingDelete = [];
    this.selectedPath = null;
  }

  _makeNode(parent, path, name, file) {
    return { parent, path, name, file, fileList: null, children: [] };
  }

  nodePath(node) { return node.path; }

  /**
   * FindNodeToPath: descend by binary search. Returns null when the path is not
   * in the tree — that is not an error, it means "not loaded yet".
   */
  findNodeToPath(path) {
    if (isUnixRootPath(path)) return this.root;
    const p = unixExcludeTrailingBackslash(path);
    const parent = this.findNodeToPath(unixExtractFileDir(p));
    if (!parent || parent.children.length === 0) return null;

    const dirName = unixExtractFileName(p);
    let start = 0;
    let end = parent.children.length - 1;
    for (;;) {
      const index = Math.floor((start + end) / 2);
      const c = this.compareText(dirName, parent.children[index].name);
      if (c === 0) return parent.children[index];
      if (c < 0) {
        if (index === start) return null;
        end = index - 1;
      } else {
        if (index === end) return null;
        start = index + 1;
      }
    }
  }

  /** FindPathNode: the deepest ancestor that IS in the tree. Never null. */
  findPathNode(path) {
    let p = path;
    for (;;) {
      const node = this.findNodeToPath(p);
      if (node) return node;
      if (isUnixRootPath(p)) return this.root;
      p = unixExtractFileDir(unixExcludeTrailingBackslash(p));
    }
  }

  _sortChildren(node) {
    node.children.sort((a, b) => this.compareText(a.name, b.name));
  }

  /** LoadPathEasy: attach one node, parents first. */
  loadPathEasy(parent, path, file) {
    const name = isUnixRootPath(path) ? this.rootName : unixExtractFileName(path);
    const node = this._makeNode(parent, unixExcludeTrailingBackslash(path) || '/', name, file || null);
    if (parent) {
      parent.children.push(node);
      this._sortChildren(parent);
    }
    return node;
  }

  /** LoadPath: make sure every node along `path` exists, creating what is missing. */
  loadPath(path) {
    let p = path || '/';
    if (isUnixRootPath(p)) return this.root;
    p = unixExcludeTrailingBackslash(p);

    const existing = this.findNodeToPath(p);
    if (existing) return existing;

    const parentPath = unixExtractFileDir(p);
    const parent = this.loadPath(parentPath);

    let file = null;
    if (parent && parent.fileList) {
      file = parent.fileList.find((f) => fileFields(f).name === unixExtractFileName(p)) || null;
    }
    return this.loadPathEasy(parent, p, file);
  }

  /**
   * UpdatePath: reconcile a node's children with a fresh listing. Directories
   * that vanished are removed (or queued when the selection is inside them),
   * new ones are added, and hidden/inaccessible ones obey the two switches.
   */
  updatePath(node, files, options) {
    const o = options || {};
    node.fileList = files || node.fileList;
    if (!node.fileList) return;

    const byName = new Map();
    for (const child of node.children) {
      child.file = null;
      byName.set(child.name, child);
    }

    for (const raw of node.fileList) {
      const f = fileFields(raw);
      if (!f.isDirectory || !isRealFile(f.name)) continue;
      if (!this.showHiddenDirs && f.hidden) continue;
      if (!this.showInaccesibleDirectories && f.inaccessible) continue;

      const existing = byName.get(f.name);
      if (existing) {
        existing.file = raw;
        if (o.recurse) this.updatePath(existing, null, o);
      } else {
        const childPath = unixIncludeTrailingBackslash(node.path) + f.name;
        this.loadPathEasy(node, childPath, raw);
      }
    }

    // Only nodes that existed BEFORE this listing and got no matching file are
    // stale. Nodes created a moment ago already carry their file, and testing
    // identity (not just the name) keeps a freshly created node from being
    // mistaken for the one it replaced.
    for (const child of [...node.children]) {
      if (child.file === null && byName.get(child.name) === child) this.tryDelete(child, true);
    }

    this._sortChildren(node);
  }

  /**
   * NodeTryDelete: refuse while the selection is inside the node, and remember
   * to retry. Deleting the node the user is standing on would move them
   * somewhere they did not ask to go.
   */
  tryDelete(node, rememberIfFails) {
    const blocked = this.selectedPath !== null && (
      this.selectedPath === node.path
      || this.selectedPath.startsWith(unixIncludeTrailingBackslash(node.path)));
    if (!blocked) {
      this.remove(node);
      return true;
    }
    if (rememberIfFails && !this.pendingDelete.includes(node)) this.pendingDelete.push(node);
    return false;
  }

  remove(node) {
    if (!node.parent) return false;
    const i = node.parent.children.indexOf(node);
    if (i < 0) return false;
    node.parent.children.splice(i, 1);
    return true;
  }

  /** CheckPendingDeletes: retry what the selection was blocking. */
  checkPendingDeletes() {
    const remaining = [];
    for (const node of this.pendingDelete) {
      if (!this.tryDelete(node, false)) remaining.push(node);
    }
    this.pendingDelete = remaining;
    return this.pendingDelete.length;
  }

  /** Every node from the root down to `path`, for rendering the expansion. */
  pathTo(path) {
    const node = this.findNodeToPath(path);
    if (!node) return [];
    const chain = [];
    for (let n = node; n; n = n.parent) chain.unshift(n);
    return chain;
  }
}

// ---------------------------------------------------------------------------
// Per-drive last path (components/DirView.cpp)
// ---------------------------------------------------------------------------

/**
 * TDirView::FLastPaths — typing "D:" goes back to where you were on D:, not to
 * D:\. If the remembered path has since disappeared, fall back to the drive
 * root rather than failing.
 */
class LastPathsPerDrive {
  constructor(options) {
    const o = options || {};
    this.paths = new Map();
    this.directoryExists = o.directoryExists || ((p) => {
      try { return fs.statSync(p).isDirectory(); } catch { return false; }
    });
  }

  static driveKeyOf(path) {
    const p = String(path == null ? '' : path);
    if (/^[A-Za-z]:/.test(p)) return p[0].toUpperCase();
    if (p.startsWith('\\\\')) {
      // A UNC share is keyed by \\server\share, so two shares on one server
      // remember separate paths. TDriveInfo::GetDriveKey lower-cases the UNC
      // form (and only that form), so \\Server\Share and \\server\share are the
      // same drive and must not remember two different last paths.
      const m = /^(\\\\[^\\]+\\[^\\]+)/.exec(p);
      return (m ? m[1] : p).toLowerCase();
    }
    return p;
  }

  static isRealDrive(key) { return /^[A-Za-z]$/.test(key); }

  pathChanged(path) {
    const expanded = nodePath.resolve(path);
    this.paths.set(LastPathsPerDrive.driveKeyOf(expanded), expanded);
  }

  tryGetLastPath(drive) {
    const key = LastPathsPerDrive.driveKeyOf(drive);
    if (!this.paths.has(key)) return { found: false, path: null };
    let path = this.paths.get(key);
    if (!this.directoryExists(path)) {
      path = LastPathsPerDrive.isRealDrive(key) ? `${key}:` : key;
    }
    return { found: true, path };
  }
}

module.exports = {
  // errors
  ShellCommandError,
  ExecuteAppError,
  FileNotFoundError,
  CreateTempDirError,
  InvalidFileNameError,

  // path/string helpers
  includeTrailingBackslash,
  excludeTrailingBackslash,
  unixIncludeTrailingBackslash,
  unixExcludeTrailingBackslash,
  unixExtractFileName,
  unixExtractFileDir,
  unixExtractFileExt,
  isUnixRootPath,
  extractFileName,
  extractFilePath,
  fromUnixPath,
  toUnixPath,
  addToList,
  sameText,

  // commands
  expandEnvironmentVariables,
  addQuotes,
  addPathQuotes,
  stripPathQuotes,
  splitCommand,
  extractProgram,
  extractProgramName,
  formatCommand,
  reformatFileNameCommand,
  expandFileNameCommand,
  escapeParam,
  escapePuttyCommandParam,
  quoteWindowsArg,
  buildWindowsCommandLine,
  parseWindowsCommandLine,
  SHELL_COMMAND_FILE_NAME_PATTERN,

  // file names
  LOCAL_INVALID_CHARS,
  TOKENIZIBLE_CHARS,
  makeValidFileName,
  isReservedName,
  validLocalFileName,
  validLocalPath,

  // finding and running tools
  findFile,
  findTool,
  resolveExternalApplication,
  buildSpawn,
  shouldCopyCommandInsteadOfExecuting,
  executeShell,
  executeShellChecked,
  executeShellCheckedAndWait,

  // temporary files
  systemTemporaryDirectory,
  expandedTemporaryDirectory,
  uniqTempDir,
  temporaryDir,
  temporaryDirectoryForRemoteFiles,

  // text layout
  isEligibleForApplyingTabs,
  applyTabs,

  // comparison
  strCmpLogical,
  compareLogicalText,
  compareTextCaseInsensitive,
  compareOrdinal,
  containsTextSemiCaseSensitive,

  // directory view model
  REMOTE_COLUMNS,
  LOCAL_COLUMNS,
  defaultColumns,
  fileFields,
  remoteItemSize,
  localItemSize,
  makeRemoteComparator,
  makeLocalComparator,
  sortItems,
  loadFiles,
  isRealFile,
  itemMatchesFilter,
  DEFAULT_SORT_OPTIONS,

  // selection
  SELECT_MODE,
  NORTON_LIKE,
  SelectionModel,

  // incremental search
  PANEL_SEARCH,
  IncrementalSearchState,
  formatIncrementalSearchStatus,
  searchFile,
  incrementalSearch,

  // history
  DEFAULT_HISTORY_COUNT,
  DEFAULT_MAX_HISTORY_SIZE,
  HISTORY_SAVE_ON,
  PathHistory,
  HistoryCombo,
  saveToHistory,

  // masks
  makeDirectoryMask,
  composeMaskStr,
  composeMaskStrAll,
  decomposeMaskStr,
  validateMaskEdit,
  validateMaskEditAll,

  // trees and drives
  DirectoryTree,
  LastPathsPerDrive,
};
