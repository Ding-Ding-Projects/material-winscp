// winapi.js — the narrow platform boundary used by cross-platform UI code.
//
// The name follows WinSCP's WinApi roadmap unit, but this module deliberately
// does not pretend every host is Windows. Pure path, keyboard, and metric
// helpers work for any supported desktop platform. OS calls are injected by
// the main process, and the Windows-only backend is never even inspected on a
// non-Windows platform.
'use strict';

const nodePath = require('node:path');

const MAX_PATH_LENGTH = 32768;
const SUPPORTED_PLATFORMS = Object.freeze(['win32', 'darwin', 'linux', 'freebsd', 'openbsd', 'sunos', 'aix']);
const UNSUPPORTED_PLATFORM = 'UNSUPPORTED_PLATFORM';
const UNSUPPORTED_OPERATION = 'UNSUPPORTED_OPERATION';

function platformName(value) {
  return value === undefined || value === null || value === '' ? process.platform : String(value);
}

function isWindows(platform) { return platformName(platform) === 'win32'; }

function failure(code, operation, message, extra) {
  return {
    ok: false,
    code,
    operation,
    message,
    ...(extra || {}),
  };
}

function unsupported(operation, platform, reason) {
  return failure(
    platform === 'win32' ? UNSUPPORTED_OPERATION : UNSUPPORTED_PLATFORM,
    operation,
    reason || `${operation} is not available on ${platform}`,
    { platform },
  );
}

function validPath(value) {
  if (typeof value !== 'string') return failure('INVALID_INPUT', 'path', 'Path must be a string');
  if (value.length === 0) return failure('INVALID_INPUT', 'path', 'Path must not be empty');
  if (value.length > MAX_PATH_LENGTH) return failure('INVALID_INPUT', 'path', 'Path is too long');
  if (value.includes('\0')) return failure('INVALID_INPUT', 'path', 'Path contains a NUL character');
  return { ok: true, value };
}

function stripWindowsLongPrefix(value) {
  let input = value;
  // These prefixes describe the Win32 spelling of the same path. Removing
  // them keeps comparisons stable while retaining UNC and drive semantics.
  if (/^\\\\\?\\UNC\\/i.test(input)) input = `\\\\${input.slice(8)}`;
  else if (/^\\\\\?\\/i.test(input)) input = input.slice(4);
  return input;
}

function normalizeWindowsPath(value) {
  const checked = validPath(value);
  if (!checked.ok) throw Object.assign(new TypeError(checked.message), { code: checked.code });
  let input = stripWindowsLongPrefix(checked.value).replaceAll('/', '\\');
  // A bare drive is the drive root in the app's local-panel model. Node's
  // path.win32.normalize intentionally preserves drive-relative "C:" paths,
  // which is correct for Node but surprising for a file browser.
  if (/^[A-Za-z]:$/.test(input)) input += '\\';
  let normalized = nodePath.win32.normalize(input);
  if (normalized === '.') return '';
  // Keep a UNC share root stable with the local adapter: the root is the
  // server/share pair itself, not a second spelling with a trailing slash.
  if (/^\\\\[^\\]+\\[^\\]+\\$/.test(normalized)) normalized = normalized.slice(0, -1);
  return normalized.replace(/^([a-z]):/, (_, drive) => `${drive.toUpperCase()}:`);
}

function normalizePosixPath(value) {
  const checked = validPath(value);
  if (!checked.ok) throw Object.assign(new TypeError(checked.message), { code: checked.code });
  const normalized = nodePath.posix.normalize(checked.value);
  return normalized === '.' ? '' : normalized;
}

/** Normalize with the host's spelling rules, or with an explicit test target. */
function normalizePath(value, options) {
  const platform = platformName(options && options.platform);
  return isWindows(platform) ? normalizeWindowsPath(value) : normalizePosixPath(value);
}

/**
 * Return drive/share-root facts without treating a POSIX path as a drive.
 * This is intentionally a result object so callers can surface an honest
 * unsupported state instead of converting "/" into a fake "C:\\".
 */
function normalizeDrive(value, options) {
  const platform = platformName(options && options.platform);
  if (!isWindows(platform)) return unsupported('drive-normalization', platform, 'Drive letters are a Windows-only concept');
  let normalized;
  try { normalized = normalizeWindowsPath(value); }
  catch (error) { return failure(error.code || 'INVALID_INPUT', 'drive-normalization', error.message, { platform }); }

  const drive = /^([A-Z]):\\(?:.*)?$/.exec(normalized);
  if (drive) {
    const root = `${drive[1]}:\\`;
    return { ok: true, kind: 'drive', drive: drive[1], root, path: normalized, isRoot: normalized === root };
  }
  const unc = /^(\\\\[^\\]+\\[^\\]+)(?:\\.*)?$/.exec(normalized);
  if (unc) {
    const root = unc[1];
    return { ok: true, kind: 'unc', drive: null, root, path: normalized, isRoot: normalized === root };
  }
  return failure('NOT_A_DRIVE', 'drive-normalization', 'Path is not a Windows drive or UNC share', { platform, path: normalized });
}

function finite(value, fallback, minimum) {
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum ? number : fallback;
}

function rectangle(value) {
  if (!value || typeof value !== 'object') return null;
  const width = finite(value.width, -1, 0);
  const height = finite(value.height, -1, 0);
  if (width < 0 || height < 0) return null;
  return {
    x: finite(value.x, 0, -Infinity),
    y: finite(value.y, 0, -Infinity),
    width,
    height,
  };
}

function readBounds(windowLike) {
  if (!windowLike) return null;
  for (const method of ['getContentBounds', 'getBounds']) {
    if (typeof windowLike[method] !== 'function') continue;
    try {
      const bounds = rectangle(windowLike[method]());
      if (bounds) return bounds;
    } catch { /* a closing window is allowed to disappear between reads */ }
  }
  return null;
}

/**
 * Read display metrics from injected Electron-like objects. Electron bounds
 * are already logical pixels; physicalViewport is derived only for callers
 * that need to compare against a native display.
 */
function displayMetrics(options) {
  const o = options || {};
  let bounds = rectangle(o.bounds) || readBounds(o.window);
  let display = o.display || null;
  if (!display && o.screen && bounds) {
    try {
      if (typeof o.screen.getDisplayMatching === 'function') display = o.screen.getDisplayMatching(bounds);
    } catch { /* metrics remain useful without display enumeration */ }
  }
  const scaleFactor = finite(o.scaleFactor ?? (display && display.scaleFactor), 1, 0.01);
  const viewport = rectangle(o.viewport) || bounds || { x: 0, y: 0, width: 0, height: 0 };
  const workArea = rectangle(o.workArea) || rectangle(display && display.workArea) || null;
  return {
    scaleFactor,
    bounds,
    workArea,
    viewport,
    physicalViewport: {
      width: Math.round(viewport.width * scaleFactor),
      height: Math.round(viewport.height * scaleFactor),
    },
    displayId: display && (display.id ?? null),
  };
}

const MODIFIER_ALIASES = new Map([
  ['cmd', 'Meta'], ['command', 'Meta'], ['⌘', 'Meta'], ['meta', 'Meta'],
  ['ctrl', 'Control'], ['control', 'Control'], ['⌃', 'Control'],
  ['alt', 'Alt'], ['option', 'Alt'], ['⌥', 'Alt'],
  ['shift', 'Shift'], ['⇧', 'Shift'],
]);

function keyboardNotation(platform) {
  const name = platformName(platform);
  const mac = name === 'darwin';
  return {
    platform: name,
    primaryModifier: mac ? 'Meta' : 'Control',
    primaryLabel: mac ? '⌘' : 'Ctrl',
    controlLabel: mac ? '⌃' : 'Ctrl',
    altLabel: mac ? '⌥' : 'Alt',
    shiftLabel: mac ? '⇧' : 'Shift',
    metaLabel: mac ? '⌘' : 'Win',
    separator: mac ? '' : '+',
  };
}

function shortcutParts(shortcut) {
  const parts = Array.isArray(shortcut) ? shortcut : String(shortcut || '').split('+');
  return parts.map((part) => String(part).trim()).filter(Boolean).map((part) => {
    const modifier = MODIFIER_ALIASES.get(part.toLowerCase());
    if (modifier) return modifier;
    return part.length === 1 ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1);
  });
}

function formatShortcut(shortcut, options) {
  const notation = keyboardNotation(options && options.platform);
  const parts = shortcutParts(shortcut);
  if (notation.platform === 'darwin') {
    return parts.map((part) => ({ Meta: '⌘', Control: '⌃', Alt: '⌥', Shift: '⇧' }[part] || part)).join('');
  }
  const labels = { Meta: notation.metaLabel, Control: notation.controlLabel, Alt: notation.altLabel, Shift: notation.shiftLabel };
  return parts.map((part) => labels[part] || part).join(notation.separator);
}

function shellCapabilities(shell, platform) {
  return {
    openPath: !!shell && typeof shell.openPath === 'function',
    showItemInFolder: !!shell && typeof shell.showItemInFolder === 'function',
    openExternal: !!shell && typeof shell.openExternal === 'function',
    platform,
  };
}

function safePathForOperation(value, platform, operation) {
  try { return { ok: true, path: normalizePath(value, { platform }) }; }
  catch (error) { return failure(error.code || 'INVALID_INPUT', operation, error.message, { platform }); }
}

function allowedExternalUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PATH_LENGTH) return false;
  try { return ['http:', 'https:', 'mailto:'].includes(new URL(value).protocol); }
  catch { return false; }
}

function nativeFailure(operation, platform, error) {
  const message = error && error.message ? String(error.message).slice(0, 512) : `${operation} failed`;
  return failure('OPERATION_FAILED', operation, message, { platform });
}

/**
 * Construct the boundary. `shell` and `windows` are injected to keep the
 * module headless-testable and to make native calls auditable at one seam.
 */
function createWinApi(options) {
  const o = options || {};
  const platform = platformName(o.platform);
  const shell = o.shell || null;
  // Do not read, bind, or probe a Windows backend on another platform.
  const windows = platform === 'win32' ? (o.windows || null) : null;

  const api = {
    platform,
    isWindows: platform === 'win32',
    normalizePath(value) { return normalizePath(value, { platform }); },
    normalizeDrive(value) { return normalizeDrive(value, { platform }); },
    displayMetrics(metrics) { return displayMetrics(metrics); },
    keyboardNotation() { return keyboardNotation(platform); },
    formatShortcut(shortcut) { return formatShortcut(shortcut, { platform }); },
    capabilities() {
      return {
        platform,
        isWindows: platform === 'win32',
        shell: shellCapabilities(shell, platform),
        windowsBackend: {
          available: platform === 'win32' && !!windows,
          operations: platform === 'win32' && windows ? Object.keys(windows).filter((key) => typeof windows[key] === 'function').sort() : [],
        },
      };
    },
    checkOpenFile(value) {
      const checked = safePathForOperation(value, platform, 'openPath');
      if (!checked.ok) return checked;
      if (!shell || typeof shell.openPath !== 'function') {
        return unsupported('openPath', platform, 'The desktop shell cannot open files in this process');
      }
      return { ok: true, operation: 'openPath', platform, path: checked.path };
    },
    async openFile(value) {
      const checked = api.checkOpenFile(value);
      if (!checked.ok) return checked;
      try {
        const result = await shell.openPath(checked.path);
        // Electron resolves with an error string; an empty/undefined result is
        // success. Never turn a non-empty native error into a fake success.
        if (typeof result === 'string' && result.length) return failure('SHELL_ERROR', 'openPath', result.slice(0, 512), { platform, path: checked.path });
        return { ok: true, operation: 'openPath', platform, path: checked.path };
      } catch (error) { return nativeFailure('openPath', platform, error); }
    },
    checkRevealFile(value) {
      const checked = safePathForOperation(value, platform, 'showItemInFolder');
      if (!checked.ok) return checked;
      if (!shell || typeof shell.showItemInFolder !== 'function') {
        return unsupported('showItemInFolder', platform, 'The desktop shell cannot reveal files in this process');
      }
      return { ok: true, operation: 'showItemInFolder', platform, path: checked.path };
    },
    revealFile(value) {
      const checked = api.checkRevealFile(value);
      if (!checked.ok) return checked;
      try {
        shell.showItemInFolder(checked.path);
        return { ok: true, operation: 'showItemInFolder', platform, path: checked.path };
      } catch (error) { return nativeFailure('showItemInFolder', platform, error); }
    },
    async openExternal(value) {
      if (!allowedExternalUrl(value)) return failure('INVALID_INPUT', 'openExternal', 'Only http, https, and mailto URLs may be opened', { platform });
      if (!shell || typeof shell.openExternal !== 'function') return unsupported('openExternal', platform, 'The desktop shell cannot open external URLs in this process');
      try {
        await shell.openExternal(value);
        return { ok: true, operation: 'openExternal', platform };
      } catch (error) { return nativeFailure('openExternal', platform, error); }
    },
    async callWindows(operation, ...args) {
      if (platform !== 'win32') return unsupported(`win32:${operation}`, platform, 'Windows-only operation was requested on a non-Windows platform');
      if (typeof operation !== 'string' || operation.length === 0) {
        return failure('INVALID_INPUT', 'win32', 'Windows operation must be a non-empty string', { platform });
      }
      // Match capabilities(): injected adapters expose only their own methods.
      // This prevents prototype properties (for example constructor) becoming
      // accidental native call routes.
      if (!windows || !Object.prototype.hasOwnProperty.call(windows, operation) || typeof windows[operation] !== 'function') {
        return unsupported(`win32:${operation}`, platform, 'No Windows backend implements this operation');
      }
      try {
        const value = await windows[operation](...args);
        if (value && typeof value === 'object' && value.ok === false) return value;
        return { ok: true, operation: `win32:${operation}`, platform, value };
      } catch (error) { return nativeFailure(`win32:${operation}`, platform, error); }
    },
  };
  return Object.freeze(api);
}

module.exports = {
  MAX_PATH_LENGTH,
  SUPPORTED_PLATFORMS,
  UNSUPPORTED_PLATFORM,
  UNSUPPORTED_OPERATION,
  createWinApi,
  displayMetrics,
  formatShortcut,
  isWindows,
  keyboardNotation,
  normalizeDrive,
  normalizePath,
  unsupported,
};
