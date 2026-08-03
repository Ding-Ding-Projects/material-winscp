// setup.js — Windows integration: installation-time behaviour, shortcuts, the
// URL-protocol registration, the search path, the jump list, temporary-folder
// cleanup, single-instance handling and the PuTTY tool launchers.
//
// Ported from:
//   vendor/winscp/source/windows/Setup.cpp    (search path, protocol registry,
//                                              jump list, temp cleanup, URLs)
//   vendor/winscp/source/windows/Tools.cpp    (shortcut creation)
//   vendor/winscp/source/windows/GUITools.cpp (PuTTY/Pageant/PuTTYgen launch)
//   vendor/winscp/source/windows/WinMain.cpp  (maintenance switches, the
//                                              send-to-another-instance decision)
//   vendor/winscp/deployment/winscpsetup.iss  (what the installer itself does)
//
// WHY the shape is different from the original in two places:
//
//   * WinSCP writes the search path and the protocol handlers to HKLM first and
//     falls back to HKCU when that fails, because its installer can run
//     elevated. A Squirrel app installs per-user into %LOCALAPPDATA% and is
//     never elevated, so every write here goes to HKCU. The *fallback branch*
//     of the original is therefore the whole implementation, not a degraded
//     one — see docs/protocol-gaps.md for what that costs.
//
//   * Every registry read/write goes through `reg.exe` rather than a native
//     binding. It keeps the module loadable (and testable) on a machine with no
//     compiler and no Windows, which is what lets the operation-building half
//     below be tested as pure data on any platform.
//
// Nothing here ever logs a password: the PuTTY launcher builds its argument
// vector with the secret in it and hands that straight to spawn().
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const cp = require('child_process');
const net = require('net');
const putty = require('./putty');

let electron = null;
try { electron = require('electron'); } catch { /* headless tests + tooling */ }

const IS_WIN = process.platform === 'win32';

/** `TProgramParams::FormatSwitch` — every switch is `/Name`. */
function formatSwitch(name) { return `/${name}`; }

// WinInterface.h / core/Interface.h.
const SWITCHES = {
  upload: 'Upload',
  uploadIfAny: 'UploadIfAny',
  jumpList: 'JumpList',
  desktop: 'Desktop',
  sendToHook: 'SendToHook',
  unsafe: 'Unsafe',
  newInstance: 'NewInstance',
  refresh: 'refresh',
  ini: 'ini',
};

// core/SessionData.cpp — the protocol names, verbatim.
const PROTO = {
  sftp: 'sftp',
  scp: 'scp',
  ftp: 'ftp',
  ftps: 'ftps',
  ftpes: 'ftpes',
  dav: 'dav',
  davs: 'davs',
  s3: 's3',
  ssh: 'ssh',
  http: 'http',
  https: 'https',
};
const WINSCP_PROTOCOL_PREFIX = 'winscp-';

/** Setup.cpp: `static const UnicodeString GenericUrlHandler(L"WinSCP.Url")`. */
const GENERIC_URL_HANDLER = 'WinSCP.Url';
const SOFTWARE_CLASSES = 'Software\\Classes\\';

class SetupError extends Error {
  constructor(message, code, detail) {
    super(message);
    this.name = 'SetupError';
    this.code = code || 'SETUP';
    if (detail) this.detail = detail;
  }
}

// ===========================================================================
// Search path — add_path_reg / remove_path_reg (Setup.cpp:146-266)
// ===========================================================================

// Setup.cpp:29. "when the PATH registry key is over aprox 2048 characters,
// PATH as well as WINDIR variables are actually not set, breaking the system".
const MAX_PATH_LEN = 2000;

/** Setup.cpp:62 — an unquoted copy of `str`, or `str` when it is not quoted. */
function unquote(str) {
  const s = String(str);
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  return s;
}

/**
 * Setup.cpp:82 `find_reg_str`. Finds `what` among the `;`-separated entries of
 * `str` and reports where it starts and where the next entry starts.
 *
 * The original also compares the 8.3 short forms via GetShortPathName, so
 * `C:\Progra~1\WinSCP` matches `C:\Program Files\WinSCP`. Node has no such API;
 * a case-insensitive comparison of the normalized long paths is used instead,
 * which catches every case the short-path comparison was there for except a
 * literal 8.3 name already present in %PATH%. That residue is recorded as a gap
 * rather than pretended away.
 */
function findPathEntry(pathValue, what) {
  const value = String(pathValue);
  const target = normalizeForCompare(unquote(what));
  let start = 0;
  while (start <= value.length) {
    let end = value.indexOf(';', start);
    if (end < 0) end = value.length;
    const token = value.slice(start, end);
    // wcstok collapses runs of the delimiter, so empty entries are skipped.
    if (token.length > 0 && normalizeForCompare(unquote(token)) === target) {
      // `next` is where wcstok's following token starts, so a run of `;` is
      // consumed with the entry rather than left behind as an empty one.
      let next = end;
      while (next < value.length && value[next] === ';') next++;
      return { start, end, next };
    }
    if (end >= value.length) break;
    start = end + 1;
  }
  return null;
}

function normalizeForCompare(p) {
  let s = String(p).trim();
  // A trailing separator is not part of the identity of a directory.
  while (s.length > 3 && (s.endsWith('\\') || s.endsWith('/'))) s = s.slice(0, -1);
  return s.replace(/\//g, '\\').toLowerCase();
}

/**
 * add_path_reg's string half. Returns the new value, whether anything changed,
 * and — faithfully to the original — a refusal when the result would exceed
 * MAX_PATH_LEN. WinSCP reports PATH_ENV_TOO_LONG and adds nothing at all; it
 * does not truncate.
 */
function addToPath(pathValue, entry) {
  const value = String(pathValue == null ? '' : pathValue);
  if (findPathEntry(value, entry)) {
    return { value, changed: false, alreadyPresent: true };
  }
  const next = value === '' ? String(entry) : `${value};${entry}`;
  if (next.length >= MAX_PATH_LEN) {
    return {
      value,
      changed: false,
      error: 'Cannot add new path to %PATH%, %PATH% is already too long.',
    };
  }
  return { value: next, changed: true };
}

/**
 * remove_path_reg's string half. WinSCP splices the entry out and then drops a
 * single trailing `;` if one is left behind — reproduced exactly, including the
 * fact that it leaves an interior empty entry alone.
 */
function removeFromPath(pathValue, entry) {
  const value = String(pathValue == null ? '' : pathValue);
  const found = findPathEntry(value, entry);
  if (!found) return { value, changed: false };
  let out = value.slice(0, found.start) + value.slice(found.next);
  if (out.endsWith(';')) out = out.slice(0, -1);
  return { value: out, changed: true };
}

// ===========================================================================
// Registry access through reg.exe
// ===========================================================================

// reg.exe accepts the abbreviation on its command line but always prints the
// long form back — `reg query HKCU\Software` lists `HKEY_CURRENT_USER\Software\…`.
// Reading subkeys means accepting both, or the subkey scan silently finds
// nothing and every "this key still has children" refusal below evaporates.
const REG_ROOTS = {
  HKCU: ['HKCU', 'HKEY_CURRENT_USER'],
  HKLM: ['HKLM', 'HKEY_LOCAL_MACHINE'],
  HKCR: ['HKCR', 'HKEY_CLASSES_ROOT'],
  HKU: ['HKU', 'HKEY_USERS'],
  HKCC: ['HKCC', 'HKEY_CURRENT_CONFIG'],
};

function rootPrefixes(root) {
  return REG_ROOTS[root] || [String(root)];
}

/**
 * A registry operation, kept as plain data so the whole registration plan can
 * be built and asserted without touching a real registry.
 *
 *   { op: 'add',    key, name?, type?, value? }
 *   { op: 'delete', key, name? }
 */
function regArgs(operation) {
  const o = operation;
  const key = `${o.root || 'HKCU'}\\${o.key}`;
  // `/ve` addresses the key's default value; `/v NAME` a named one.
  const valueSelector = o.name === undefined ? [] : (o.name === '' ? ['/ve'] : ['/v', o.name]);
  switch (o.op) {
    case 'add':
      return ['add', key, ...valueSelector, '/t', o.type || 'REG_SZ',
        '/d', o.value === undefined ? '' : String(o.value), '/f'];
    case 'delete':
      return ['delete', key, ...valueSelector, '/f'];
    case 'query':
      return ['query', key, ...valueSelector];
    default:
      throw new SetupError(`Unknown registry operation ${o.op}`, 'REG_OP');
  }
}

/** Default runner. Injectable so tests never touch a real registry. */
function defaultRegRunner(args) {
  const r = cp.spawnSync('reg', args, { windowsHide: true, encoding: 'utf8' });
  if (r.error) return { status: -1, stdout: '', stderr: r.error.message };
  return { status: r.status === null ? -1 : r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

class Registry {
  constructor(opts) {
    const o = opts || {};
    this.run = o.run || defaultRegRunner;
    this.root = o.root || 'HKCU';
    /** Every operation actually attempted, in order — used by tests and logs. */
    this.performed = [];
  }

  _exec(operation) {
    const op = { root: this.root, ...operation };
    const args = regArgs(op);
    const result = this.run(args, op);
    this.performed.push({ ...op, args, status: result.status });
    return result;
  }

  add(key, name, value, type) {
    const r = this._exec({ op: 'add', key, name, value, type });
    if (r.status !== 0) throw new SetupError(`Cannot write registry key ${this.root}\\${key}`, 'REG_WRITE', r.stderr);
    return true;
  }

  /** Deleting something that is not there is not an error — the original's
   *  uninstall path runs unconditionally and must not fail on a clean machine. */
  delete(key, name) {
    const r = this._exec({ op: 'delete', key, name });
    return r.status === 0;
  }

  /** Returns the value string, or undefined when the key/value is absent. */
  read(key, name) {
    const r = this._exec({ op: 'query', key, name });
    if (r.status !== 0) return undefined;
    return parseRegQueryValue(r.stdout, name);
  }

  exists(key) {
    return this._exec({ op: 'query', key }).status === 0;
  }

  /** Value names directly under `key`, `''` for the default value. */
  valueNames(key) {
    const r = this._exec({ op: 'query', key });
    if (r.status !== 0) return [];
    return parseRegQueryNames(r.stdout);
  }

  subKeys(key) {
    const r = this._exec({ op: 'query', key });
    if (r.status !== 0) return [];
    const prefixes = rootPrefixes(this.root).map((p) => `${p}\\${key}\\`.toLowerCase());
    const out = [];
    for (const raw of r.stdout.split(/\r?\n/)) {
      const line = raw.trim();
      const lower = line.toLowerCase();
      const prefix = prefixes.find((p) => lower.startsWith(p));
      if (!prefix) continue;
      const child = line.slice(prefix.length);
      // `reg query` lists the whole immediate-child level, one per line; a name
      // with a backslash in it would be a grandchild from a recursive listing.
      if (child && !child.includes('\\')) out.push(child);
    }
    return out;
  }

  /**
   * Setup.cpp:293 `DeleteKeyIfEmpty`, recursion included. A key is removed only
   * once every one of its subkeys has been removed, and only when it carries no
   * values another application could own. This is the refusal that stops an
   * uninstall from taking someone else's `ftp:` handler with it.
   */
  deleteKeyIfEmpty(key, allowRootValues) {
    if (!this.exists(key)) return { deleted: false, reason: 'absent' };
    if (!canDeleteKey(this.valueNames(key), !!allowRootValues)) {
      return { deleted: false, reason: 'has-foreign-values' };
    }
    for (const child of this.subKeys(key)) {
      this.deleteKeyIfEmpty(`${key}\\${child}`, false);
    }
    // Still non-empty means a subkey refused; the delete will fail and that is
    // the correct outcome, not something to force.
    if (this.subKeys(key).length > 0) return { deleted: false, reason: 'has-subkeys' };
    return { deleted: this.delete(key), reason: 'empty' };
  }
}

/** `reg query` prints `    Name    REG_SZ    value`; `(Default)` for `''`. */
function parseRegQueryValue(stdout, name) {
  const want = (name === '' || name === undefined) ? '(default)' : String(name).toLowerCase();
  for (const line of String(stdout).split(/\r?\n/)) {
    const m = /^\s{4,}(\(Default\)|\S.*?)\s{2,}(REG_[A-Z_]+)\s{2,}([\s\S]*)$/.exec(line);
    if (!m) continue;
    if (m[1].toLowerCase() === want) return m[3];
  }
  return undefined;
}

function parseRegQueryNames(stdout) {
  const out = [];
  for (const line of String(stdout).split(/\r?\n/)) {
    const m = /^\s{4,}(\(Default\)|\S.*?)\s{2,}(REG_[A-Z_]+)\s{2,}([\s\S]*)$/.exec(line);
    if (!m) continue;
    out.push(m[1] === '(Default)' ? '' : m[1]);
  }
  return out;
}

// ===========================================================================
// Protocol / URL handler registration (Setup.cpp:286-709)
// ===========================================================================

/**
 * Setup.cpp:293 `DeleteKeyIfEmpty`. A key may be removed when it carries no
 * values at all, or — at the root of a protocol key, where `allowRootValues` is
 * set — only the four values the registration itself wrote. Anything else means
 * another application owns the key and WinSCP leaves it alone.
 */
function canDeleteKey(valueNames, allowRootValues) {
  const names = valueNames || [];
  if (names.length === 0) return true;
  if (!allowRootValues) return false;
  const allowed = new Set(['', 'URL Protocol', 'EditFlags', 'BrowserFlags']);
  return names.every((n) => allowed.has(n));
}

/** Setup.cpp:347 — the default description when none is given. */
function protocolUrlDescription(protocol) { return `URL: ${protocol} Protocol`; }

/**
 * The operations that register one protocol as a URL handler, exactly as
 * `RegisterProtocol` + `RegisterAsUrlHandler` write them (Setup.cpp:341-418).
 *
 * `EditFlags = 2` is FTA_OpenIsSafe and `BrowserFlags = 8` is
 * "do not confirm opening"; both are carried over verbatim because dropping
 * them changes how the shell prompts.
 */
function protocolOperations(protocol, exePath, options) {
  const o = options || {};
  const description = o.description || protocolUrlDescription(protocol);
  const key = SOFTWARE_CLASSES + protocol;
  const ops = [
    { op: 'add', key, name: '', value: description },
    { op: 'add', key, name: 'URL Protocol', value: '' },
    { op: 'add', key, name: 'EditFlags', type: 'REG_DWORD', value: '0x2' },
    { op: 'add', key, name: 'BrowserFlags', type: 'REG_DWORD', value: '0x8' },
    { op: 'add', key: `${key}\\DefaultIcon`, name: '', value: `"${exePath}",0` },
  ];
  if (o.command !== false) {
    ops.push({
      op: 'add',
      key: `${key}\\shell\\open\\command`,
      name: '',
      // Setup.cpp:410 — `"exe" /Unsafe "%1"`. The /Unsafe switch is what makes
      // the receiving instance refuse the switches an attacker could smuggle
      // through a URL; dropping it would turn a link into a command line.
      value: `"${exePath}" ${formatSwitch(SWITCHES.unsafe)} "%1"`,
    });
  }
  return ops;
}

/** The protocols registered under the `winscp-` prefix (Setup.cpp:493-500, 677-684). */
function prefixedProtocols() {
  return [
    PROTO.sftp, PROTO.scp, PROTO.dav, PROTO.davs, PROTO.s3,   // non-browser
    PROTO.ftp, PROTO.ftps, PROTO.ftpes, PROTO.http, PROTO.https, PROTO.ssh,
  ].map((p) => WINSCP_PROTOCOL_PREFIX + p.toUpperCase());
}

/** The protocols offered to Windows' Default Programs (Setup.cpp:607-624). */
function defaultProgramProtocols() {
  // http is deliberately absent: "it's unlikely that anyone would like to
  // change http handler to non-browser application".
  return [PROTO.ftp, PROTO.ftps, PROTO.ftpes, PROTO.sftp, PROTO.scp, PROTO.ssh, PROTO.dav, PROTO.davs, PROTO.s3];
}

/**
 * The complete registration plan, as data. Building it separately from running
 * it is what makes "does this port write the same keys WinSCP writes?" a
 * question a test can answer.
 */
function registrationPlan(exePath, options) {
  const o = options || {};
  const appName = o.appName || 'WinSCP Material';
  const companyKey = o.companyKey || 'Software\\Martin Prikryl';
  const capabilitiesKey = `${companyKey}\\WinSCPCapabilities`;
  const description = o.applicationDescription || DEFAULT_APP_DESCRIPTION;

  const ops = [];

  // The generic handler every UrlAssociation points at (Setup.cpp:610).
  ops.push(...protocolOperations(GENERIC_URL_HANDLER, exePath, { description: 'WinSCP URL' }));

  for (const protocol of defaultProgramProtocols()) {
    // Prior to Windows 8 the legacy handler is what makes us the default; on
    // Windows 8+ the capabilities record does. Both are written, as the
    // original does (Setup.cpp:513-561).
    ops.push(...protocolOperations(protocol, exePath));
    ops.push({ op: 'add', key: capabilitiesKey, name: 'ApplicationDescription', value: description });
    ops.push({ op: 'add', key: `${capabilitiesKey}\\UrlAssociations`, name: protocol, value: GENERIC_URL_HANDLER });
  }
  ops.push({ op: 'add', key: 'Software\\RegisteredApplications', name: appName, value: capabilitiesKey });

  for (const protocol of prefixedProtocols()) {
    ops.push(...protocolOperations(protocol, exePath));
  }

  return ops;
}

const DEFAULT_APP_DESCRIPTION =
  'WinSCP Material is a free SFTP, SCP, FTP/FTPS, WebDAV and S3 client for Windows — ' +
  'a file manager with a Material Design 3 interface.';

/** Every protocol key the registration owns, in the order it is unwound. */
function allRegisteredProtocols() {
  return [...defaultProgramProtocols(), ...prefixedProtocols(), GENERIC_URL_HANDLER];
}

// ===========================================================================
// The public installation-time API
// ===========================================================================

class WindowsIntegration {
  /**
   * @param {object} opts
   *   exePath   - the executable a shortcut or a handler should launch
   *   appName   - the name used in RegisteredApplications and shortcut files
   *   registry  - an injected Registry (tests)
   *   iniParam  - the /ini= switch to bake into every shortcut, if any
   */
  constructor(opts) {
    const o = opts || {};
    this.exePath = o.exePath || (electron && electron.app ? electron.app.getPath('exe') : process.execPath);
    this.appName = o.appName || 'WinSCP Material';
    this.companyKey = o.companyKey || 'Software\\WinSCP Material';
    this.iniParam = o.iniParam || '';
    this.registry = o.registry || new Registry({ root: 'HKCU', run: o.regRun });
    this.env = o.env || process.env;
    this.spawn = o.spawn || cp.spawn;
    this.spawnSync = o.spawnSync || cp.spawnSync;
    this.log = o.log || (() => undefined);
  }

  // ---- search path ------------------------------------------------------

  /**
   * WinSCP writes HKLM\SYSTEM\…\Session Manager\Environment (machine-wide).
   * A per-user install cannot; HKCU\Environment is the per-user equivalent and
   * is what the user's own shells inherit. The broadcast that follows is the
   * WM_SETTINGCHANGE of `path_reg_propagate` — Electron cannot send it, so a
   * new shell is required, which is stated rather than hidden.
   */
  addSearchPath(dir) {
    const target = dir || path.dirname(this.exePath);
    const current = this.registry.read('Environment', 'Path') || '';
    const next = addToPath(current, target);
    if (next.error) throw new SetupError(`Error adding path '${target}' to search path (%PATH%).`, 'PATH_TOO_LONG', next.error);
    if (!next.changed) return { changed: false, alreadyPresent: !!next.alreadyPresent };
    this.registry.add('Environment', 'Path', next.value, 'REG_EXPAND_SZ');
    this.log(`New search path written: ${next.value}`);
    return { changed: true, value: next.value, requiresNewShell: true };
  }

  /**
   * The original swallows every error here, because the uninstaller calls it
   * unconditionally — including on machines where AddSearchPath was never run.
   * Same contract: report, never throw.
   */
  removeSearchPath(dir) {
    const target = dir || path.dirname(this.exePath);
    try {
      const current = this.registry.read('Environment', 'Path') || '';
      const next = removeFromPath(current, target);
      if (!next.changed) return { changed: false };
      this.registry.add('Environment', 'Path', next.value, 'REG_EXPAND_SZ');
      return { changed: true, value: next.value };
    } catch (e) {
      return { changed: false, error: e.message };
    }
  }

  // ---- protocols --------------------------------------------------------

  registerForDefaultProtocols() {
    const plan = registrationPlan(this.exePath, { appName: this.appName, companyKey: this.companyKey });
    const failed = [];
    for (const op of plan) {
      try { this.registry.add(op.key, op.name, op.value, op.type); } catch (e) { failed.push({ op, error: e.message }); }
    }
    if (failed.length === plan.length) {
      throw new SetupError('Cannot register application to handle URL addresses.', 'REGISTER_URL', failed[0] && failed[0].error);
    }
    return { written: plan.length - failed.length, failed };
  }

  /**
   * Setup.cpp's unregistration refuses to delete a protocol key that another
   * application has since claimed: it checks that the DefaultIcon/command still
   * names our executable, and only removes a key that `DeleteKeyIfEmpty` finds
   * empty. Both refusals are kept — an uninstall that strips someone else's
   * `ftp:` handler is worse than one that leaves a stale key.
   */
  unregisterForProtocols() {
    const removed = [];
    const kept = [];
    const exeBase = path.basename(this.exePath, path.extname(this.exePath)).toLowerCase();

    const ownsValue = (value) => !!value && String(value).toLowerCase().includes(exeBase);

    for (const protocol of allRegisteredProtocols()) {
      const base = SOFTWARE_CLASSES + protocol;
      const iconKey = `${base}\\DefaultIcon`;
      const shellKey = `${base}\\shell`;

      const icon = this.registry.read(iconKey, '');
      if (icon !== undefined && ownsValue(icon)) {
        this.registry.delete(iconKey, '');
        this.registry.deleteKeyIfEmpty(iconKey, false);
      }

      const command = this.registry.read(`${shellKey}\\open\\command`, '');
      if (command !== undefined && ownsValue(command)) {
        this.registry.delete(`${shellKey}\\open\\command`, '');
        this.registry.deleteKeyIfEmpty(shellKey, false);
      }

      // The protocol key itself may keep the four values we wrote; anything
      // else means another application adopted it and it stays.
      const r = this.registry.deleteKeyIfEmpty(base, true);
      if (r.deleted) removed.push(base); else kept.push(base);
    }

    const capabilitiesKey = `${this.companyKey}\\WinSCPCapabilities`;
    for (const protocol of defaultProgramProtocols()) {
      this.registry.delete(`${capabilitiesKey}\\UrlAssociations`, protocol);
    }
    this.registry.deleteKeyIfEmpty(`${capabilitiesKey}\\UrlAssociations`, false);
    this.registry.delete(capabilitiesKey, 'ApplicationDescription');
    this.registry.deleteKeyIfEmpty(capabilitiesKey, false);
    // Setup.cpp:595 — the application is only unregistered once its capabilities
    // key is genuinely gone.
    if (!this.registry.exists(capabilitiesKey)) {
      this.registry.delete('Software\\RegisteredApplications', this.appName);
    }

    return { removed, kept };
  }

  /**
   * LaunchAdvancedAssociationUI (Setup.cpp:711). Windows 10+ has no COM UI for
   * this any more: the documented route is to register, then open the Settings
   * page and let the user confirm. That is exactly what the original does on
   * Win10, so this is the whole behaviour, not a substitute for it.
   */
  launchAdvancedAssociationUI() {
    this.registerForDefaultProtocols();
    if (electron && electron.shell) electron.shell.openExternal('ms-settings:defaultapps');
    return { opened: 'ms-settings:defaultapps' };
  }

  // ---- shortcuts --------------------------------------------------------

  /**
   * CreateAppDesktopShortCut (Tools.cpp:596): the /ini switch is prepended to
   * whatever the caller asked for, so a shortcut made by a portable install
   * keeps pointing at that install's configuration.
   */
  appShortcutParams(extra) {
    const parts = [];
    if (this.iniParam) parts.push(`${formatSwitch(SWITCHES.ini)}="${this.iniParam}"`);
    if (extra) parts.push(extra);
    return parts.join(' ');
  }

  /**
   * Writes a .lnk. Electron's shell.writeShortcutLink is the only shortcut API
   * available without a native module; it covers every field WinSCP sets
   * (target, arguments, description, icon) except the PKEY_Title property the
   * original attaches for jump-list links — the jump list is built through
   * app.setJumpList() here instead, which sets the title itself.
   */
  createShortcut(spec) {
    if (!IS_WIN) throw new SetupError('Shortcuts are a Windows feature.', 'NOT_WINDOWS');
    if (!electron || !electron.shell || !electron.shell.writeShortcutLink) {
      throw new SetupError('Cannot create shortcut.', 'CREATE_SHORTCUT');
    }
    const folder = this.specialFolder(spec.folder || 'desktop');
    const file = path.join(folder, `${validLocalFileName(spec.name)}.lnk`);
    const ok = electron.shell.writeShortcutLink(file, 'create', {
      target: spec.target || this.exePath,
      args: spec.args || '',
      description: spec.description || '',
      icon: spec.icon || this.exePath,
      iconIndex: spec.iconIndex === undefined ? 0 : spec.iconIndex,
      cwd: spec.cwd || path.dirname(this.exePath),
    });
    if (!ok) throw new SetupError('Cannot create shortcut.', 'CREATE_SHORTCUT', file);
    return file;
  }

  removeShortcut(spec) {
    const folder = this.specialFolder(spec.folder || 'desktop');
    const file = path.join(folder, `${validLocalFileName(spec.name)}.lnk`);
    try { fs.unlinkSync(file); return true; } catch { return false; }
  }

  /** The CSIDL values Setup.cpp/Preferences.cpp use, by name. */
  specialFolder(kind) {
    const home = this.env.USERPROFILE || os.homedir();
    const appData = this.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    switch (kind) {
      case 'desktop': return electronPath('desktop') || path.join(home, 'Desktop');
      case 'startMenu': return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
      case 'sendTo': return path.join(appData, 'Microsoft', 'Windows', 'SendTo');
      case 'quickLaunch': return path.join(appData, 'Microsoft', 'Internet Explorer', 'Quick Launch');
      case 'commonDesktop':
        // CSIDL_COMMON_DESKTOPDIRECTORY. A per-user install cannot write here;
        // the caller is told so rather than silently writing to its own desktop.
        return path.join(this.env.PUBLIC || 'C:\\Users\\Public', 'Desktop');
      default: throw new SetupError(`Unknown shortcut folder '${kind}'.`, 'FOLDER');
    }
  }

  /** Preferences.cpp:1633 — "%s (for upload)", pointed at /upload. */
  createSendToUploadShortcut() {
    return this.createShortcut({
      name: sendToHookName(this.appName),
      args: this.appShortcutParams(formatSwitch(SWITCHES.upload)),
      description: `Upload files with ${this.appName}`,
      folder: 'sendTo',
    });
  }

  /** Login.cpp:1830 — a per-site Send To entry, "%s (upload using %s)". */
  createSessionSendToShortcut(session) {
    const s = session || {};
    return this.createShortcut({
      name: sessionSendToHookName(s.localName || s.name, this.appName),
      args: this.appShortcutParams(
        `"${encodeURIComponent(s.name || '')}" ${formatSwitch(SWITCHES.sendToHook)} ${formatSwitch(SWITCHES.upload)}`),
      description: shortcutInfoTip(s),
      folder: 'sendTo',
    });
  }

  /** CreateDesktopSessionShortCut (Tools.cpp:606). */
  createSessionShortcut(session, opts) {
    const s = session || {};
    const o = opts || {};
    const name = o.name || validLocalFileName(s.localName || lastSegment(s.name || ''));
    const additional = o.additionalParams ? ` ${o.additionalParams}` : '';
    return this.createShortcut({
      name,
      args: this.appShortcutParams(`"${encodeURIComponent(s.name || '')}"${additional}`),
      description: shortcutInfoTip(s),
      folder: o.folder || 'desktop',
    });
  }

  createDesktopShortcut(opts) {
    const o = opts || {};
    return this.createShortcut({
      name: this.appName,
      args: this.appShortcutParams(''),
      description: `${this.appName} — SFTP, FTP, WebDAV and S3 client`,
      folder: o.allUsers ? 'commonDesktop' : 'desktop',
    });
  }

  createStartMenuShortcut() {
    return this.createShortcut({
      name: this.appName,
      args: this.appShortcutParams(''),
      description: `${this.appName} — SFTP, FTP, WebDAV and S3 client`,
      folder: 'startMenu',
    });
  }

  /**
   * Applies the four integration preferences in one pass, creating what is on
   * and removing what is off, so the Preferences page can just hand over its
   * current state. Each failure is reported, none aborts the others.
   */
  applyIntegrationPrefs(prefs) {
    const p = prefs || {};
    const results = {};
    const apply = (key, wanted, make, unmake) => {
      try { results[key] = wanted ? { on: true, at: make() } : { on: false, removed: unmake() }; }
      catch (e) { results[key] = { error: e.message }; }
    };
    apply('desktopIcon', !!p.desktopIcon,
      () => this.createDesktopShortcut(),
      () => this.removeShortcut({ name: this.appName, folder: 'desktop' }));
    apply('explorerUploadShortcut', !!p.explorerUploadShortcut,
      () => this.createSendToUploadShortcut(),
      () => this.removeShortcut({ name: sendToHookName(this.appName), folder: 'sendTo' }));
    apply('quickLaunchIcon', !!p.quickLaunchIcon,
      () => this.createShortcut({ name: this.appName, args: this.appShortcutParams(''), folder: 'quickLaunch' }),
      () => this.removeShortcut({ name: this.appName, folder: 'quickLaunch' }));
    apply('addSearchPath', !!p.addSearchPath,
      () => this.addSearchPath(),
      () => this.removeSearchPath());
    return results;
  }

  // ---- uninstall --------------------------------------------------------

  /**
   * WinMain.cpp's /UninstallCleanup. The original refuses to run when the
   * uninstaller signalled a silent uninstall (the WinSCPSilentUninstall mutex),
   * because the cleanup asks the user questions. `silent` carries that same
   * refusal: nothing is deleted and nothing is asked.
   */
  uninstallCleanup(opts) {
    const o = opts || {};
    if (o.silent) return { skipped: 'silent' };
    const result = { protocols: null, searchPath: null };
    try { result.protocols = this.unregisterForProtocols(); } catch (e) { result.protocols = { error: e.message }; }
    result.searchPath = this.removeSearchPath();
    for (const name of [this.appName, sendToHookName(this.appName)]) {
      for (const folder of ['desktop', 'sendTo', 'startMenu', 'quickLaunch']) {
        try { this.removeShortcut({ name, folder }); } catch { /* nothing there */ }
      }
    }
    return result;
  }
}

function electronPath(name) {
  try { return electron && electron.app ? electron.app.getPath(name) : null; } catch { return null; }
}

/** core/Common.cpp:689 `ValidLocalFileName` — `/\:*?"<>|` become `_`. */
const LOCAL_INVALID_CHARS = '/\\:*?"<>|';
function validLocalFileName(name) {
  let out = '';
  for (const ch of String(name)) {
    out += (LOCAL_INVALID_CHARS.includes(ch) || ch.codePointAt(0) < 32) ? '_' : ch;
  }
  return out === '' ? '_' : out;
}

/** SHORTCUT_INFO_TIP / _FOLDER / _WORKSPACE (TextsWin1.rc:177, 248, 249). */
function shortcutInfoTip(session) {
  const s = session || {};
  if (s.isFolder) return `Opens site folder '${s.name}'`;
  if (s.isWorkspace) return `Opens workspace '${s.name}'`;
  const info = s.infoTip || sessionInfoTip(s);
  return `Opens site '${s.name}'\n${info}`;
}

/** A compact stand-in for TSessionData::InfoTip: never includes the password. */
function sessionInfoTip(session) {
  const s = session || {};
  const parts = [];
  if (s.userName) parts.push(`User name: ${s.userName}`);
  if (s.hostName) parts.push(`Host name: ${s.hostName}${s.portNumber ? ` (port ${s.portNumber})` : ''}`);
  if (s.remoteDirectory) parts.push(`Remote directory: ${s.remoteDirectory}`);
  if (s.protocol) parts.push(`Protocol: ${String(s.protocol).toUpperCase()}`);
  return parts.join('\n');
}

function sendToHookName(appName) { return `${appName} (for upload)`; }
function sessionSendToHookName(sessionName, appName) { return `${sessionName} (upload using ${appName})`; }
function lastSegment(name) { const i = String(name).lastIndexOf('/'); return i < 0 ? String(name) : String(name).slice(i + 1); }

// ===========================================================================
// Temporary folder cleanup (Setup.cpp:732, WinConfiguration.cpp:2601-2675)
// ===========================================================================

/**
 * UniqTempDir (GUITools.cpp:903): `<base>\scp` + minutes + milliseconds, so
 * `…\scp07123\`. The mask form is `scp?????`, which is what the cleanup scan
 * matches. The original loops until the name is free; so does this.
 */
function uniqTempDir(baseDir, identity, opts) {
  const o = opts || {};
  const id = identity || 'scp';
  const exists = o.exists || ((p) => fs.existsSync(p));
  const now = o.now || (() => new Date());
  for (let attempt = 0; attempt < 1000; attempt++) {
    const d = now();
    // The original spins on the clock until the name is free; nudging the
    // millisecond field keeps every candidate inside the `scp?????` mask that
    // the cleanup scan matches.
    const ms = (d.getMilliseconds() + attempt) % 1000;
    const stamp = String(d.getMinutes()).padStart(2, '0') + String(ms).padStart(3, '0');
    const dir = path.join(baseDir, id + stamp);
    if (!exists(dir)) return dir;
  }
  throw new SetupError('Cannot create temporary directory.', 'TEMP_DIR');
}

/** The `scp?????` mask, as a predicate. */
function isTemporaryFolderName(name, identity) {
  const id = identity || 'scp';
  const s = String(name);
  return s.length === id.length + 5 && s.slice(0, id.length).toLowerCase() === id.toLowerCase()
    && /^[^\\/]{5}$/.test(s.slice(id.length));
}

/** DoFindTemporaryFolders: directories only, matching the mask. */
function findTemporaryFolders(baseDir, opts) {
  const o = opts || {};
  const readdir = o.readdir || ((d) => fs.readdirSync(d, { withFileTypes: true }));
  let entries;
  try { entries = readdir(baseDir); } catch { return []; }
  return entries
    .filter((e) => (typeof e.isDirectory === 'function' ? e.isDirectory() : true))
    .map((e) => (e.name === undefined ? String(e) : e.name))
    .filter((n) => isTemporaryFolderName(n, o.identity))
    .map((n) => path.join(baseDir, n));
}

/**
 * CleanupTemporaryFolders. Every folder is attempted; the ones that could not
 * be removed are collected and reported together, exactly as CLEANUP_TEMP_ERROR
 * does — "if you have some files stored in them still opened, close them and
 * try again" only makes sense if the user is told *which* folders.
 */
function cleanupTemporaryFolders(folders, opts) {
  const o = opts || {};
  const remove = o.remove || ((p) => { fs.rmSync(p, { recursive: true, force: true }); });
  const failed = [];
  for (const folder of folders || []) {
    try {
      remove(folder);
      if (!o.remove && fs.existsSync(folder)) failed.push(folder);
    } catch { failed.push(folder); }
  }
  if (failed.length > 0) {
    throw new SetupError(
      'Some of the temporary folders have not been deleted. If you have some files stored in them ' +
      'still opened, close them and try again.',
      'CLEANUP_TEMP', failed);
  }
  return { deleted: (folders || []).length };
}

/**
 * TemporaryDirectoryCleanup (Setup.cpp:732). The confirmation is a real
 * decision — the folders may hold files the user edited — so it stays a modal
 * question with WinSCP's three answers: Yes (delete), No (leave), Open (show
 * them in Explorer and leave), plus "never ask again".
 *
 * `ask` is injected; it receives the folder list and returns
 * 'yes' | 'no' | 'open' | 'never'.
 */
async function temporaryDirectoryCleanup(baseDir, opts) {
  const o = opts || {};
  const folders = findTemporaryFolders(baseDir, o);
  if (folders.length === 0) return { folders: [], deleted: 0 };

  let answer = 'yes';
  if (o.confirm !== false && typeof o.ask === 'function') {
    answer = await o.ask({
      message:
        `**Do you want to delete past temporary folders?**\n\n${o.appName || 'WinSCP Material'} has found ` +
        `${folders.length} temporary folders, which it has probably created in past. These folders may ` +
        'contain files previously edited or downloaded.\n\nYou may also open the folders to review their ' +
        'content and to delete them yourself.',
      folders,
    });
  }

  if (answer === 'open') {
    if (electron && electron.shell) for (const f of folders) electron.shell.openPath(f);
    return { folders, deleted: 0, opened: true };
  }
  if (answer === 'never') {
    if (typeof o.setConfirm === 'function') o.setConfirm(false);
    answer = 'yes';
  }
  if (answer !== 'yes') return { folders, deleted: 0 };

  // Setup.cpp:770 wraps CleanupTemporaryFolders in a try/catch that calls
  // ShowExtendedException: a folder Explorer still holds open must be reported,
  // not allowed to abort the startup this runs during.
  try {
    cleanupTemporaryFolders(folders, o);
  } catch (e) {
    if (typeof o.onError === 'function') o.onError(e);
    return { folders, deleted: 0, error: e.message, failed: e.detail || [] };
  }
  return { folders, deleted: folders.length };
}

// ===========================================================================
// Jump list (Setup.cpp:1874-1959)
// ===========================================================================

/**
 * UpdateJumpList. WinSCP builds two categories — recent workspaces and recent
 * sites — and honours the items Windows reports as user-removed by dropping
 * them from the stored list too, which is why `removed` is both an input and
 * reflected in the result.
 *
 * The site entries carry /UploadIfAny so that dropping files on a jump-list
 * entry uploads them; the workspace entries do not.
 */
function buildJumpList(sessionNames, workspaceNames, opts) {
  const o = opts || {};
  const exePath = o.exePath || process.execPath;
  const removed = new Set((o.removed || []).map((s) => String(s).toLowerCase()));
  const iniParam = o.iniParam ? `${formatSwitch(SWITCHES.ini)}="${o.iniParam}" ` : '';

  const item = (name, extraSwitch) => ({
    type: 'task',
    title: name,
    description: `Opens '${name}'`,
    program: exePath,
    args: `${iniParam}"${encodeURIComponent(name)}"${extraSwitch ? ` ${extraSwitch}` : ''} ${formatSwitch(SWITCHES.jumpList)}`,
    iconPath: exePath,
    iconIndex: 0,
  });

  const keep = (names) => (names || []).filter((n) => !removed.has(String(n).toLowerCase()));

  const categories = [];
  const workspaces = keep(workspaceNames);
  if (workspaces.length > 0) {
    categories.push({ type: 'custom', name: 'Recent Workspaces', items: workspaces.map((n) => item(n, '')) });
  }
  const sessions = keep(sessionNames);
  if (sessions.length > 0) {
    categories.push({
      type: 'custom',
      name: 'Recent Sites',
      items: sessions.map((n) => item(n, formatSwitch(SWITCHES.uploadIfAny))),
    });
  }
  return { categories, keptSessions: sessions, keptWorkspaces: workspaces };
}

/**
 * SetupInitialize (Setup.cpp:1858): the jump list is refreshed at startup, and
 * a failure there is reported but never stops the application.
 */
function updateJumpList(sessionNames, workspaceNames, opts) {
  const o = opts || {};
  const built = buildJumpList(sessionNames, workspaceNames, o);
  const app = o.app || (electron && electron.app);
  if (!app || !app.setJumpList) return { ...built, applied: false };
  try {
    const removedItems = (app.getJumpListSettings && app.getJumpListSettings().removedItems) || [];
    if (removedItems.length > 0) {
      // AddJumpListCategory drops a removed entry from the category it is about
      // to append — it does not append it and then remember. Windows refuses an
      // AppendCategory that re-adds an item the user removed, so applying the
      // *unfiltered* list would lose the whole jump list.
      const removed = removedItems.map((i) => i.title || i.description || '');
      const filtered = buildJumpList(sessionNames, workspaceNames, { ...o, removed });
      return { ...filtered, applied: applyJumpList(app, filtered) };
    }
    return { ...built, applied: applyJumpList(app, built) };
  } catch (e) {
    return { ...built, applied: false, error: e.message };
  }
}

function applyJumpList(app, built) {
  try { app.setJumpList(built.categories.length ? built.categories : null); return true; }
  catch { return false; }
}

// ===========================================================================
// Instance handling (Setup.cpp:1961, WinMain.cpp:710-765, 1152-1209)
// ===========================================================================

/**
 * AnyOtherInstanceOfSelf (Setup.cpp:1961). WinSCP walks the process list
 * looking for another process with the same executable base name; the installer
 * asks it "is a copy running?". `tasklist` is the shell-level equivalent and is
 * the only route available without a native module.
 */
function anyOtherInstanceOfSelf(opts) {
  const o = opts || {};
  if (!IS_WIN) return false;
  const exeBase = path.basename(o.exePath || process.execPath).toLowerCase();
  const run = o.run || (() => cp.spawnSync('tasklist', ['/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }));
  const r = run();
  if (!r || r.status !== 0 || !r.stdout) return false;
  const self = o.pid || process.pid;
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = /^"([^"]*)","(\d+)"/.exec(line.trim());
    if (!m) continue;
    if (m[1].toLowerCase() === exeBase && Number(m[2]) !== self) return true;
  }
  return false;
}

/**
 * WinMain.cpp:1157. Whether this launch should hand its command line to a
 * running instance instead of opening a window of its own.
 *
 * Every clause is the original's:
 *   - only when there is no /upload, /synchronize, /keepuptodate or /edit;
 *   - the ExternalSessionInExistingInstance preference, INVERTED by holding
 *     Shift (UseAlternativeFunction → OpenInNewWindow);
 *   - never with /newinstance;
 *   - never with /rawconfig, because parsing a URL after it does not work and
 *     "it is not clear what it should do anyway";
 *   - never when the URL names a file to download, because the download belongs
 *     to this process.
 *
 * A folder or workspace name is NOT a refusal: WinMain.cpp:1168 uses it only to
 * decide whether the URL is worth parsing for a download file (a folder name is
 * not a URL), and a workspace opened from the jump list is exactly the case the
 * existing instance should take over.
 */
function shouldSendToAnotherInstance(parsed, opts) {
  const p = parsed || {};
  const o = opts || {};
  const paramCommand = !!(p.upload || p.synchronize !== undefined || p.keepUpToDate !== undefined
    || p.edit !== undefined || p.refresh);
  if (paramCommand) return false;
  if (p.newInstance) return false;
  if (p.rawConfig) return false;

  const preferExisting = o.externalSessionInExistingInstance !== false;
  const openInNewWindow = !!o.shiftHeld;
  if (preferExisting === openInNewWindow) return false;

  if (!p.url && !p.siteName) return false;
  // A URL naming a file is a download request, which this process performs.
  // The original only looks for one when the name is not a folder/workspace.
  if (!o.isFolderOrWorkspace && p.url && p.url.downloadFile) return false;
  return true;
}

/** WinMain.cpp:1191 — which usage counter a launch is attributed to. */
function commandCounterName(parsed) {
  const p = parsed || {};
  if (p.jumpList) return 'CommandLineJumpList';
  if (p.desktop) return 'CommandLineDesktop';
  if (p.sendToHook) return 'CommandLineSendToHook';
  return 'CommandLineSession2';
}

/**
 * AddStartupSequence (WinMain.cpp). WinSCP records single letters as startup
 * passes each stage so a crash report says how far the launch got. Kept because
 * it is genuinely how a hang during startup gets diagnosed.
 */
class StartupSequence {
  constructor() { this.value = ''; this.times = []; this.start = Date.now(); }
  add(letter) { this.value += letter; this.times.push({ letter, at: Date.now() - this.start }); return this.value; }
  toString() { return this.value; }
}

// ===========================================================================
// Command splitting and PuTTY (Common.cpp:750-892, GUITools.cpp:406-619)
// ===========================================================================

/**
 * SplitCommand (Common.cpp:750). A quoted program keeps its spaces; an unquoted
 * one ends at the first space. A missing closing quote is an error, not a
 * best-effort guess — the original throws INVALID_SHELL_COMMAND.
 */
function splitCommand(command) {
  let s = String(command == null ? '' : command).trim();
  let program = '';
  let params = '';
  if (s.startsWith('"')) {
    s = s.slice(1);
    const q = s.indexOf('"');
    if (q < 0) throw new SetupError(`Invalid shell command '"${s}'.`, 'INVALID_SHELL_COMMAND');
    program = s.slice(0, q).trim();
    params = s.slice(q + 1).trim();
  } else {
    const sp = s.indexOf(' ');
    if (sp >= 0) { program = s.slice(0, sp).trim(); params = s.slice(sp + 1).trim(); }
    else program = s;
  }
  const b = Math.max(program.lastIndexOf('\\'), program.lastIndexOf('/'));
  const dir = b >= 0 ? program.slice(0, b + 1).trim() : '';
  return { program, params, dir };
}

/** FormatCommand (Common.cpp:812) — the inverse, always quoting the program. */
function formatCommand(program, params) {
  const p = String(program || '').trim();
  const a = String(params || '').trim();
  const quoted = p.startsWith('"') && p.endsWith('"') ? p : `"${p}"`;
  return a ? `${quoted} ${a}` : quoted;
}

/** ExpandEnvironmentVariables — `%NAME%`, left alone when undefined. */
function expandEnvironmentVariables(str, env) {
  const e = env || process.env;
  return String(str == null ? '' : str).replace(/%([^%]+)%/g, (whole, name) => {
    const key = Object.keys(e).find((k) => k.toLowerCase() === String(name).toLowerCase());
    return key === undefined ? whole : String(e[key]);
  });
}

/**
 * EscapePuttyCommandParam (Common.cpp:850). Backslashes are doubled only when
 * they precede a quote; a bare `\` is left alone (which is why a Windows path
 * survives). The whole value is quoted only when it contains a space.
 */
function escapePuttyCommandParam(param) {
  const src = String(param == null ? '' : param);
  let out = '';
  let space = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"') { out += '\\"'; continue; }
    if (c === ' ') { space = true; out += c; continue; }
    if (c === '\\') {
      let j = i;
      while (j < src.length && src[j] === '\\') j++;
      const run = j - i;
      if (j < src.length && src[j] === '"') {
        out += '\\'.repeat(run * 2);   // doubled, the quote itself is escaped next
        i = j - 1;
        continue;
      }
      out += '\\'.repeat(run);
      i = j - 1;
      continue;
    }
    out += c;
  }
  return space ? `"${out}"` : out;
}

/**
 * Splits a parameter *string* (as it is stored in the PuTTY-path preference)
 * back into argv elements. WinSCP never needs this — it passes the string on
 * verbatim — but spawn() takes an argv, so the quoting the user typed has to be
 * understood rather than split on whitespace, or `-i "C:\my key.ppk"` arrives
 * at PuTTY as three broken arguments.
 */
function splitParams(params) {
  const s = String(params == null ? '' : params);
  const out = [];
  let current = '';
  let inQuotes = false;
  let has = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') { inQuotes = !inQuotes; has = true; continue; }
    if (!inQuotes && /\s/.test(c)) {
      if (has) { out.push(current); current = ''; has = false; }
      continue;
    }
    current += c;
    has = true;
  }
  if (has) out.push(current);
  return out;
}

/**
 * FindTool (GUITools.cpp:679). Beside the executable, then in a `PuTTY`
 * subfolder, then on %PATH%. Returns null rather than throwing so the caller
 * can produce the right message for the tool it wanted.
 */
function findTool(name, opts) {
  const o = opts || {};
  const exists = o.exists || ((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
  const appDir = o.appDir || path.dirname(o.exePath || process.execPath);
  const candidates = [path.join(appDir, name), path.join(appDir, 'PuTTY', name)];
  for (const c of candidates) if (exists(c)) return c;

  const env = o.env || process.env;
  const pathVar = env.PATH || env.Path || '';
  for (const dir of String(pathVar).split(path.delimiter)) {
    if (!dir) continue;
    const c = path.join(dir, name);
    if (exists(c)) return c;
  }
  // The conventional install location, which is also the default preference.
  const fallback = expandEnvironmentVariables(`%PROGRAMFILES%\\PuTTY\\${name}`, env);
  if (exists(fallback)) return fallback;
  return null;
}

/**
 * GetFileVersion(Program) — the file version of an executable, as `major.minor`.
 *
 * WinSCP reads it through the Win32 version resource; Node exposes no such API,
 * so this asks PowerShell for the same `FileVersionInfo`. It matters more than
 * it looks: without a version the `asAuto` branch below falls back to `-pw`,
 * which puts the user's password in a command line every process on the machine
 * can read. Returns null when it cannot be determined, and the caller then
 * makes exactly the conservative choice WinSCP makes.
 */
function fileVersion(programPath, opts) {
  const o = opts || {};
  if (!IS_WIN) return null;
  const run = o.runVersion || ((p) => cp.spawnSync('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    `(Get-Item -LiteralPath ${JSON.stringify(p)}).VersionInfo.FileVersion`,
  ], { encoding: 'utf8', windowsHide: true, timeout: 10000 }));
  let r;
  try { r = run(programPath); } catch { return null; }
  if (!r || r.status !== 0 || !r.stdout) return null;
  const m = /(\d+)\.(\d+)/.exec(String(r.stdout).trim());
  return m ? `${m[1]}.${m[2]}` : null;
}

/** GUITools.cpp:572 — should `-pwfile` be used instead of `-pw`? */
function usePuttyPwFile(setting, programPath, opts) {
  const o = opts || {};
  if (setting === 'on') return true;
  if (setting === 'off') return false;
  // asAuto: only for a genuine putty.exe of version 0.77 or newer, because
  // -pwfile does not exist before that and older builds would show the switch
  // to the server as a hostname.
  if (path.basename(String(programPath || '')).toLowerCase() !== 'putty.exe') return false;
  // The original reads the version itself; falling back to `-pw` merely because
  // nobody handed one in would put the password on the command line by default.
  const version = o.version === undefined ? fileVersion(programPath, o) : o.version;
  if (!version) return false;
  const [major, minor] = String(version).split('.').map((n) => parseInt(n, 10) || 0);
  return (major * 1000 + minor) >= (0 * 1000 + 77);
}

/**
 * OpenSessionInPutty's argument construction (GUITools.cpp:428-613).
 *
 * WinSCP has two branches. The non-UWP one exports the session into PuTTY's own
 * registry store and passes `-load <name>`; the UWP one — where writing another
 * application's registry is not permitted — builds the whole session on the
 * command line. This port implements the *command-line* branch, because it does
 * not write PuTTY's registry either (see docs/protocol-gaps.md), and it is the
 * branch WinSCP itself ships for exactly that situation.
 *
 * Returns the argv, plus the password decision, so a caller can log the argv
 * without the secret in it.
 *
 * WHY nothing here is quoted or escaped: WinSCP builds one command-line
 * *string* and hands it to ShellExecuteEx, which is why the original wraps the
 * key file in quotes and runs the host name through EscapePuttyCommandParam.
 * This returns an **argv**, which spawn() quotes itself — adding those quotes
 * here would put literal `"` characters inside the argument, and PuTTY would
 * look for a key file whose name starts with a quote. The escaping belongs to
 * whoever renders an argv back into a command line, not to the argv.
 */
function puttyArgs(session, opts) {
  const s = session || {};
  const o = opts || {};
  const args = [];

  const isFtp = s.protocol === 'ftp';
  const telnet = isFtp && o.telnetForFtpInPutty !== false;
  // PuTTY does not allow -pw for telnet, so the password is dropped, not
  // silently passed on a switch PuTTY will reject.
  let password = o.puttyPassword ? (s.passphrase || s.password || '') : '';
  if (telnet) { args.push('-telnet'); password = ''; }

  if (s.hostName) args.push(String(s.hostName));
  if (s.userName) { args.push('-l', String(s.userName)); }
  if (!isFtp && s.portNumber && Number(s.portNumber) !== 22) args.push('-P', String(s.portNumber));

  if (!telnet) {
    const keyFile = s.publicKeyFile || s.privateKeyFile || '';
    if (keyFile) args.push('-i', expandEnvironmentVariables(keyFile, o.env));
    args.push(s.tryAgent === false ? '-noagent' : '-agent');
    if (s.tryAgent !== false) args.push(s.agentFwd ? '-A' : '-a');
    if (s.compression) args.push('-C');
    args.push('-2');
    if (s.logicalHostName) args.push('-loghost', String(s.logicalHostName));
  }

  if (s.addressFamily === 'ipv4') args.push('-4');
  else if (s.addressFamily === 'ipv6') args.push('-6');

  return { args, password, telnet };
}

/**
 * Validate a local PuTTY key before launching the external client. This is a
 * metadata-only preflight: the key bytes and passphrase stay out of this
 * module, and OpenSSH/other key formats remain PuTTY's responsibility. A
 * missing path is also left to PuTTY, because relative paths are resolved by
 * the child process from its own working directory.
 */
function preflightPuttyKey(session, program, env) {
  const s = session || {};
  const configured = s.publicKeyFile || s.privateKeyFile || '';
  if (!configured || !/\.ppk$/iu.test(String(configured))) return;
  const expanded = expandEnvironmentVariables(String(configured), env);
  const candidate = path.isAbsolute(expanded)
    ? expanded
    : path.resolve(path.dirname(program), expanded);
  if (!fs.existsSync(candidate)) return;
  const metadata = putty.readPuttyKeyMetadata(candidate);
  if (!metadata.ok) {
    throw new SetupError('The PuTTY private key file could not be validated.', 'INVALID_KEY');
  }
}

/**
 * TPuttyPasswordThread (GUITools.cpp:302-404). WinSCP hands PuTTY a named pipe
 * rather than putting the password on the command line, where every other
 * process on the machine can read it out of the process list. Node's net server
 * creates the same kind of pipe, so this is the real mechanism, not a stand-in.
 *
 * The pipe is single-use and single-instance, closes as soon as the password
 * has been written, and gives up after the original's one-minute timeout.
 */
let pipeCounter = 0;
function servePuttyPassword(password, opts) {
  const o = opts || {};
  pipeCounter += 1;
  const hex = (n, w) => (n >>> 0).toString(16).padStart(w, '0');
  const name = o.pipeName || `\\\\.\\pipe\\WinSCPMaterialPuTTYPassword.${hex(process.pid, 8)}.${hex(pipeCounter, 8)}.${hex(Math.floor(Math.random() * 0x10000), 4)}`;
  const timeout = o.timeout === undefined ? 60000 : o.timeout;

  return new Promise((resolve, reject) => {
    const server = net.createServer({ allowHalfOpen: true }, (socket) => {
      socket.on('error', () => undefined);       // PuTTY closing early is normal
      socket.end(Buffer.from(String(password), 'binary'), () => { close(); });
    });
    let timer = null;
    const close = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      try { server.close(); } catch { /* already closing */ }
    };
    server.on('error', (e) => { close(); reject(new SetupError(`Cannot create password pipe: ${e.message}`, 'PIPE')); });
    server.listen(name, () => {
      timer = setTimeout(close, timeout);
      if (timer.unref) timer.unref();
      resolve({ pipeName: name, close });
    });
  });
}

/**
 * OpenSessionInPutty. Resolves the program, builds the arguments, decides how
 * the password travels, and starts PuTTY in its own directory — the original
 * does that last part deliberately, "to allow relative paths in private key".
 */
async function openSessionInPutty(session, opts) {
  const o = opts || {};
  const configured = o.puttyPath || '%PROGRAMFILES%\\PuTTY\\putty.exe';
  const split = splitCommand(configured);
  const program = expandEnvironmentVariables(split.program, o.env);
  const extraParams = expandEnvironmentVariables(split.params, o.env);

  const resolved = findTool(path.basename(program), { ...o, appDir: path.dirname(program) })
    || (o.exists ? (o.exists(program) ? program : null) : (fs.existsSync(program) ? program : null));
  if (!resolved) throw new SetupError(`File '${program}' does not exist.`, 'FILE_NOT_FOUND', program);

  preflightPuttyKey(session, resolved, o.env);
  const built = puttyArgs(session, o);
  const args = [...built.args];

  let pipe = null;
  if (built.password) {
    if (usePuttyPwFile(o.usePuttyPwFile || 'auto', resolved, { ...o, version: o.puttyVersion })) {
      pipe = await servePuttyPassword(built.password, o);
      args.push('-pwfile', pipe.pipeName);
    } else {
      args.push('-pw', built.password);
    }
  }
  if (extraParams) args.push(...splitParams(extraParams));

  const spawn = o.spawn || cp.spawn;
  const child = spawn(resolved, args, { cwd: path.dirname(resolved), detached: true, stdio: 'ignore', windowsHide: false });
  if (child && child.unref) child.unref();

  // The argv that is safe to log: the password never appears in it.
  const loggable = args.map((a) => (a === built.password ? '***' : a));
  return { program: resolved, args: loggable, usedPasswordPipe: !!pipe, pipeName: pipe ? pipe.pipeName : null };
}

/** ExecuteTool (GUITools.cpp:699) — Pageant and PuTTYgen have no arguments. */
function executeTool(name, opts) {
  const o = opts || {};
  const configured = o.path ? expandEnvironmentVariables(splitCommand(o.path).program, o.env) : null;
  const resolved = (configured && (o.exists ? o.exists(configured) : fs.existsSync(configured)))
    ? configured
    : findTool(name, o);
  if (!resolved) throw new SetupError(`Cannot execute '${name}'.`, 'EXECUTE_APP');
  const spawn = o.spawn || cp.spawn;
  const child = spawn(resolved, [], { cwd: path.dirname(resolved), detached: true, stdio: 'ignore' });
  if (child && child.unref) child.unref();
  return resolved;
}

const openPageant = (opts) => executeTool('pageant.exe', opts);
const openPuttygen = (opts) => executeTool('puttygen.exe', opts);

// ===========================================================================
// URLs (Setup.cpp:783-832)
// ===========================================================================

function versionStrFromCompoundVersion(version) {
  const v = Number(version) || 0;
  const major = Math.floor(v / (10000 * 100 * 100));
  const minor = Math.floor((v % (10000 * 100 * 100)) / (10000 * 100));
  const release = Math.floor((v % (10000 * 100)) / 10000);
  return release > 0 ? `${major}.${minor}.${release}` : `${major}.${minor}`;
}

function appendUrlParams(url, params) {
  if (!params) return String(url);
  return String(url) + (String(url).includes('?') ? '&' : '?') + params;
}

/** CampaignUrl — identifies which build sent the user to the site. */
function campaignUrl(url, opts) {
  const o = opts || {};
  const version = o.version || versionStrFromCompoundVersion(o.compoundVersion || 0);
  const medium = o.medium || 'app';
  return appendUrlParams(url, `utm_source=winscp&utm_medium=${medium}&utm_campaign=${encodeURIComponent(version)}`);
}

/** ProgramUrl — version, locale and install kind, for the update check. */
function programUrl(url, opts) {
  const o = opts || {};
  let params = `v=${encodeURIComponent(o.version || '0.0.0.0')}` +
    `&lang=${encodeURIComponent(o.locale || '0409')}` +
    `&isinstalled=${o.installed ? 1 : 0}`;
  if (o.unofficial) params += '&unofficial=1';
  return appendUrlParams(url, params);
}

// ===========================================================================
// Maintenance switches (WinMain.cpp:997-1087)
// ===========================================================================

/**
 * The switches the installer and uninstaller pass. WinSCP guards each of them
 * with CheckSafe(), which refuses when the command line arrived from a URL
 * (`/Unsafe`) — a web page must never be able to rewrite the registry or the
 * search path. That refusal is kept exactly.
 *
 * Returns { handled, task, result } and never opens a window: every one of
 * these is a task the process exists solely to perform.
 */
function maintenanceTask(switches, opts) {
  const o = opts || {};
  const has = (name) => {
    if (!switches) return false;
    if (switches instanceof Map) return switches.has(name.toLowerCase());
    if (switches instanceof Set) return switches.has(name.toLowerCase());
    return Object.prototype.hasOwnProperty.call(switches, name.toLowerCase());
  };
  const unsafe = has(SWITCHES.unsafe.toLowerCase());
  const integration = o.integration || new WindowsIntegration(o);

  // Every branch of WinMain.cpp:997-1087 ends in Configuration->DontSave(): a
  // process started by the installer to flip a registry key must not rewrite
  // the user's configuration on its way out. There is no global configuration
  // object to poke here, so the decision is reported and the caller honours it.
  const guarded = (task, run) => {
    if (unsafe) {
      return { handled: true, task, refused: 'unsafe', result: null, dontSave: true };
    }
    try { return { handled: true, task, result: run(), dontSave: true }; }
    catch (e) { return { handled: true, task, error: e.message, dontSave: true }; }
  };

  if (has('uninstallcleanup')) return guarded('uninstallCleanup', () => integration.uninstallCleanup(o));
  if (has('registerfordefaultprotocols') || has('registerasurlhandler')) {
    // RegisterAsUrlHandler is the pre-5.x name, still accepted.
    return guarded('registerForDefaultProtocols', () => integration.registerForDefaultProtocols());
  }
  if (has('unregisterforprotocols')) return guarded('unregisterForProtocols', () => integration.unregisterForProtocols());
  if (has('addsearchpath')) return guarded('addSearchPath', () => integration.addSearchPath());
  if (has('removesearchpath')) return guarded('removeSearchPath', () => integration.removeSearchPath());
  if (has('maintenancetask')) return { handled: true, task: 'noop', result: null, dontSave: true };
  return { handled: false };
}

module.exports = {
  // search path
  MAX_PATH_LEN, unquote, findPathEntry, addToPath, removeFromPath,
  // registry
  Registry, regArgs, parseRegQueryValue, parseRegQueryNames, canDeleteKey,
  // protocols
  PROTO, WINSCP_PROTOCOL_PREFIX, GENERIC_URL_HANDLER,
  protocolUrlDescription, protocolOperations, prefixedProtocols, defaultProgramProtocols,
  allRegisteredProtocols, registrationPlan,
  // shortcuts / integration
  WindowsIntegration, validLocalFileName, shortcutInfoTip, sessionInfoTip,
  sendToHookName, sessionSendToHookName,
  // temp folders
  uniqTempDir, isTemporaryFolderName, findTemporaryFolders, cleanupTemporaryFolders, temporaryDirectoryCleanup,
  // jump list
  buildJumpList, updateJumpList,
  // instances / startup
  anyOtherInstanceOfSelf, shouldSendToAnotherInstance, commandCounterName, StartupSequence,
  // commands / PuTTY
  splitCommand, splitParams, formatCommand, expandEnvironmentVariables, escapePuttyCommandParam,
  findTool, fileVersion, usePuttyPwFile, puttyArgs, servePuttyPassword, openSessionInPutty,
  executeTool, openPageant, openPuttygen,
  // urls
  versionStrFromCompoundVersion, appendUrlParams, campaignUrl, programUrl,
  // maintenance
  maintenanceTask, formatSwitch, SWITCHES, SetupError,
};
