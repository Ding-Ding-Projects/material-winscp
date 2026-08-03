// ui/dialogs/rights.js — the permission editor, and the base of the
// file-operation dialog family.
//
// Three things live here, in this order:
//
//  1. A port of TRights (core/RemoteFiles.cpp). Permissions are the C++ model
//     exactly — a `set` mask AND an `unset` mask — so every bit is yes, no or
//     UNDEFINED. A plain number cannot say "these twelve files disagree about
//     the group-write bit", and that is the whole reason the multi-selection
//     properties dialog works at all. The octal string, the `rwxr-sr-t` text
//     and the chmod mode string are all derived from that pair.
//
//  2. forms/Rights.dfm as a Material 3 frame: three group buttons that cycle,
//     nine tri-state checkboxes, the setuid/setgid/sticky trio, the octal
//     field, "add X to directories", and the whole right-click menu.
//
//  3. The small kit the sibling dialogs in this folder share. It lives here
//     because this module is the bottom of the folder's import graph — Rights
//     is a *frame* in WinSCP too, used by Properties and Create directory —
//     and copying a main-process wrapper into ten files is worse than one
//     clearly-labelled section in the file they all already import.

import {
  h, icon, uid, clear, appearanceTarget, announce, copyText, rovingFocus,
} from '../../dom.js';
import { t, has, bindRender, getLanguage, getFunnyLevel } from '../../i18n.js';
import { api } from '../../state.js';
import { resolveI18n } from '../../../winscp-i18n.js';
import { registerDialog, openDialog } from '../../app.js';
import { notify } from '../notifications.js';
import { registerContextMenu, SEPARATOR } from '../contextmenu.js';

/* ================================================================== */
/* 1. the TRights port                                                 */
/* ================================================================== */

/** rfSetUID … rfOtherExec, exactly as TRights::TFlag declares them. */
export const FLAG = {
  setUid: 0o4000, setGid: 0o2000, sticky: 0o1000,
  userRead: 0o400, userWrite: 0o200, userExec: 0o100,
  groupRead: 0o040, groupWrite: 0o020, groupExec: 0o010,
  otherRead: 0o004, otherWrite: 0o002, otherExec: 0o001,
};

/** rfNo … rfAllSpecials. */
export const RF = {
  no: 0o000, read: 0o444, write: 0o222, exec: 0o111,
  default: 0o644, all: 0o777, specials: 0o7000, allSpecials: 0o7777,
};

export const RIGHT_KEYS = [
  'setUid', 'setGid', 'sticky',
  'userRead', 'userWrite', 'userExec',
  'groupRead', 'groupWrite', 'groupExec',
  'otherRead', 'otherWrite', 'otherExec',
];

/** rgUser / rgGroup / rgOther, and the three rights each one owns. */
export const GROUPS = [
  { id: 'user', special: 'setUid', read: 'userRead', write: 'userWrite', exec: 'userExec' },
  { id: 'group', special: 'setGid', read: 'groupRead', write: 'groupWrite', exec: 'groupExec' },
  { id: 'other', special: 'sticky', read: 'otherRead', write: 'otherWrite', exec: 'otherExec' },
];

const BASIC = 'rwxrwxrwx';
const COMBINED = '--s--s--t';
const EXTENDED = '--S--S--T';
const UNDEF_SYMBOL = '$';
const UNSET_SYMBOL = '-';
// Win32-OpenSSH writes '*' where a permission does not apply on Windows.
const UNSET_SYMBOL_WIN = '*';

/** A malformed permission string or octal literal. Carries WinSCP's wording. */
export class RightsError extends Error {
  constructor(message) { super(message); this.name = 'RightsError'; }
}

/** Rights are plain data: { set, unset, raw? }. `raw` preserves an odd
 *  server-supplied text verbatim, exactly as TRights::FText does. */
export function fromNumber(n) {
  const set = Number(n) & RF.allSpecials;
  return { set, unset: RF.allSpecials & ~set };
}

/** Every bit undefined — TRights::AllUndef, the "leave as is" state. */
export function allUndef() { return { set: 0, unset: 0 }; }

export function isUndef(r) { return ((r.set | r.unset) & RF.allSpecials) !== RF.allSpecials; }
export function numberSet(r) { return r.set & RF.allSpecials; }
export function numberUnset(r) { return r.unset & RF.allSpecials; }

/** 'yes' | 'no' | 'undef' for one right. */
export function stateOf(r, key) {
  const flag = FLAG[key];
  if ((r.set & flag) !== 0) return 'yes';
  if ((r.unset & flag) !== 0) return 'no';
  return 'undef';
}

/** A copy of `r` with one right forced to a state. Never mutates the input. */
export function withState(r, key, state) {
  const flag = FLAG[key];
  let { set, unset } = r;
  if (state === 'yes') { set |= flag; unset &= ~flag; }
  else if (state === 'no') { set &= ~flag; unset |= flag; }
  else { set &= ~flag; unset &= ~flag; }
  return { set: set & RF.allSpecials, unset: unset & RF.allSpecials };
}

/** Four octal digits of the SET mask — TRights::GetOctal. */
export function octalOf(r) {
  const n = numberSet(r);
  return String((n >> 9) & 7) + String((n >> 6) & 7) + String((n >> 3) & 7) + String(n & 7);
}

/** TRights::SetOctal. Accepts three or four digits; throws WinSCP's message. */
export function fromOctal(value) {
  let v = String(value == null ? '' : value).trim();
  if (v.length === 3) v = `0${v}`;
  if (v.length !== 4 || !/^[0-7]{4}$/.test(v)) {
    throw new RightsError(`'${value}' is not valid permission in octal format.`);
  }
  return fromNumber(parseInt(v, 8));
}

/** The nine-character permission text — TRights::GetText. */
export function textOf(r) {
  if (r.raw) return r.raw;
  const out = new Array(9);
  let flag = 1;
  let extendedFlag = 0o1000;
  let extendedPos = true;
  let i = 9;
  while (i >= 1) {
    let symbol;
    if (extendedPos && (r.set & (flag | extendedFlag)) === (flag | extendedFlag)) {
      symbol = COMBINED[i - 1];
    } else if ((r.set & flag) !== 0) {
      symbol = BASIC[i - 1];
    } else if (extendedPos && (r.set & extendedFlag) !== 0) {
      symbol = EXTENDED[i - 1];
    } else if ((!extendedPos && (r.unset & flag) === flag)
      || (extendedPos && (r.unset & (flag | extendedFlag)) === (flag | extendedFlag))) {
      symbol = UNSET_SYMBOL;
    } else {
      symbol = UNDEF_SYMBOL;
    }
    out[i - 1] = symbol;
    flag <<= 1;
    i -= 1;
    extendedPos = (i % 3) === 0;
    if (extendedPos) extendedFlag <<= 1;
  }
  return out.join('');
}

/**
 * TRights::SetText. `allowUndef` mirrors the C++ property: without it a '$'
 * in the text is an error rather than an undefined bit.
 */
export function fromText(value, options = {}) {
  const v = String(value == null ? '' : value);
  if (v.length !== 9 || (!options.allowUndef && v.includes(UNDEF_SYMBOL)) || v.includes(' ')) {
    throw new RightsError(`Invalid rights description '${value}'`);
  }
  let set = 0;
  let unset = 0;
  let flag = 1;
  let extendedFlag = 0o1000;
  let keepText = false;
  for (let i = 9; i >= 1; i -= 1) {
    const c = v[i - 1];
    if (c === UNSET_SYMBOL || c === UNSET_SYMBOL_WIN) {
      unset |= (flag | extendedFlag);
    } else if (c === UNDEF_SYMBOL) {
      // deliberately nothing: the bit stays undefined
    } else if (c === COMBINED[i - 1]) {
      set |= (flag | extendedFlag);
    } else if (c === EXTENDED[i - 1]) {
      set |= extendedFlag;
      unset |= flag;
    } else {
      // Anything else is treated as "set", and the original text is kept so a
      // server that reports an exotic mode still displays what it said.
      if (c !== BASIC[i - 1]) keepText = true;
      set |= flag;
      if (i % 3 === 0) unset |= extendedFlag;
    }
    flag <<= 1;
    if (i % 3 === 1) extendedFlag <<= 1;
  }
  const out = { set: set & RF.allSpecials, unset: unset & RF.allSpecials };
  if (keepText) out.raw = v;
  return out;
}

/** True when `value` looks like something fromText/fromOctal can read. */
export function looksLikeRights(value) {
  const v = String(value == null ? '' : value).trim();
  // Keep the recognizer stricter than the parser so metadata guards cannot
  // admit a five-digit value and then throw while aggregating a selection.
  return /^0?[0-7]{3}$/.test(v) || /^[-rwxsStT$*]{9}$/.test(v);
}

/** Read either representation, so a paste of '644' or 'rw-r--r--' both work. */
export function parseRights(value, options = {}) {
  const v = String(value == null ? '' : value).trim();
  if (/^[0-7]{3,4}$/.test(v)) return fromOctal(v);
  return fromText(v, options);
}

/** TRights::GetModeStr — 'u+rwx,g-w', which is what an undefined mode needs. */
export function modeStrOf(r) {
  const parts = [];
  const groupLetters = 'ugo';
  GROUPS.forEach((g, index) => {
    let setStr = '';
    let unsetStr = '';
    [g.read, g.write, g.exec].forEach((key, mode) => {
      const symbol = BASIC[(index * 3) + mode];
      const state = stateOf(r, key);
      if (state === 'yes') setStr += symbol;
      else if (state === 'no') unsetStr += symbol;
    });
    const specialSymbol = COMBINED[(index * 3) + 2];
    const specialState = stateOf(r, g.special);
    if (specialState === 'yes') setStr += specialSymbol;
    else if (specialState === 'no') unsetStr += specialSymbol;
    if (setStr || unsetStr) {
      parts.push(groupLetters[index] + (setStr ? `+${setStr}` : '') + (unsetStr ? `-${unsetStr}` : ''));
    }
  });
  return parts.join(',');
}

/**
 * TRights::GetChmodStr. A directory gets a leading fifth zero because new
 * coreutils need it to clear setuid/setgid on a directory.
 */
export function chmodStrOf(r, isDirectory) {
  if (isUndef(r)) return modeStrOf(r);
  return isDirectory ? `0${octalOf(r)}` : octalOf(r);
}

/** TRights::AddExecute — the "+x" that keeps directories enterable. */
export function addExecute(r) {
  let out = { ...r };
  for (const g of GROUPS) {
    if (stateOf(out, g.read) === 'yes' || stateOf(out, g.write) === 'yes') {
      out = withState(out, g.exec, 'yes');
    }
  }
  delete out.raw;
  return out;
}

/**
 * TRights::operator&= — the multi-selection intersection. With undefined bits
 * allowed, a right the two sides disagree about becomes undefined; without,
 * it is a plain bitwise AND of the numbers.
 */
export function intersect(a, b, allowUndef = true) {
  if (!allowUndef) return fromNumber(numberSet(a) & numberSet(b));
  let out = { set: a.set, unset: a.unset };
  for (const key of RIGHT_KEYS) {
    if (stateOf(a, key) !== stateOf(b, key)) out = withState(out, key, 'undef');
  }
  return out;
}

/**
 * TRights::Combine — the other side's decided bits win, and the result is
 * fully decided (the C++ goes through Number, which rewrites both masks).
 * This is how a transfer's "preserve permissions" folds a preset over a file.
 */
export function combine(r, other) {
  return fromNumber((numberSet(r) | numberSet(other)) & ~numberUnset(other));
}

export function equals(a, b, allowUndef = true) {
  if (!allowUndef) return numberSet(a) === numberSet(b);
  return RIGHT_KEYS.every((key) => stateOf(a, key) === stateOf(b, key));
}

/**
 * TRightsFrame::CycleRights. Rights that already agree advance
 * yes -> no -> (undefined ->) yes; rights that disagree jump straight to yes.
 */
export function cycleGroup(r, groupId, allowUndef) {
  const g = GROUPS.find((x) => x.id === groupId);
  if (!g) return r;
  const keys = [g.read, g.write, g.exec];
  const states = keys.map((k) => stateOf(r, k));
  const same = states.every((s) => s === states[0]);
  let next;
  if (!same) next = 'yes';
  else if (states[0] === 'yes') next = 'no';
  else if (states[0] === 'no') next = allowUndef ? 'undef' : 'yes';
  else next = 'yes';
  let out = r;
  for (const k of keys) out = withState(out, k, next);
  return out;
}

/** True while "add X to directories" would still change something. */
export function addXEffective(r) {
  return (numberSet(r) & RF.exec) !== RF.exec;
}

/* ================================================================== */
/* 2. the shared kit                                                   */
/* ================================================================== */

function formatParams(str, params) {
  if (!params || !params.length) return str;
  return String(str).replace(/\{(\d+)\}/g, (m, i) => {
    const v = params[Number(i)];
    return v === undefined || v === null ? m : String(v);
  });
}

/**
 * A translator over a module's own dictionary.
 *
 * The shared dictionary in design/winscp-i18n.js is owned by the shell and
 * cannot grow a key per dialog control, so each dialog carries its own
 * `[en, yue]` (or five-level) entries and resolves them through the SAME
 * engine — the active language mode and both funny-level sliders apply
 * identically, and a key that already exists in the shared dictionary always
 * wins so nothing is said twice in two voices.
 */
export function makeTranslator(dict) {
  return function tx(key, ...params) {
    if (has(key)) return t(key, ...params);
    const entry = dict[key];
    if (!entry) return key;
    return formatParams(
      resolveI18n(entry, getLanguage(), getFunnyLevel('en'), getFunnyLevel('yue')),
      params,
    );
  };
}

/** A text element bound to a translator, re-rendered on any language change. */
export function txLabel(tx, key, opts = {}) {
  const el = h(opts.tag || 'span', opts.class ? { class: opts.class } : {});
  bindRender(el, () => {
    const params = typeof opts.params === 'function' ? opts.params() : (opts.params || []);
    const text = tx(key, ...params);
    el.textContent = text;
    if (opts.title) el.title = text;
  });
  return el;
}

/**
 * The main-process calls this family makes.
 *
 * Every one of them reports honestly when the bridge is missing (a plain
 * browser, or a build without the preload) instead of resolving to a fake
 * success — a dialog whose OK button silently does nothing is exactly what
 * docs/porting-mandate.md forbids.
 */
async function invoke(group, name, what, ...args) {
  const bridge = api.raw && api.raw[group];
  const fn = bridge && bridge[name];
  if (typeof fn !== 'function') {
    throw new Error(`${what} needs the ${group}.${name} bridge, which this build does not expose. Nothing was changed.`);
  }
  const res = await fn(...args);
  if (res && typeof res === 'object' && 'ok' in res) {
    if (res.ok) return res.value;
    const err = new Error((res.error && res.error.message) || `${what} failed.`);
    if (res.error && res.error.code) err.code = res.error.code;
    throw err;
  }
  return res;
}

export const ops = {
  /** False in degraded mode: the UI must say so rather than pretend. */
  get available() { return !api.degraded; },

  fs: {
    list: (id, path, options) => invoke('fs', 'list', 'Listing a directory', id, path, options),
    stat: (id, path) => invoke('fs', 'stat', 'Reading file properties', id, path),
    readlink: (id, path) => invoke('fs', 'readlink', 'Reading a link target', id, path),
    mkdir: (id, path) => invoke('fs', 'mkdir', 'Creating a directory', id, path),
    remove: (id, paths, options) => invoke('fs', 'remove', 'Removing a file', id, paths, options),
    rename: (id, from, to) => invoke('fs', 'rename', 'Renaming a file', id, from, to),
    symlink: (id, target, linkPath, hard) => invoke('fs', 'symlink', 'Creating a link', id, target, linkPath, hard),
    setRights: (id, paths, rights, options) => invoke('fs', 'setRights', 'Changing permissions', id, paths, rights, options),
    setOwner: (id, paths, owner, group, options) => invoke('fs', 'setOwner', 'Changing ownership', id, paths, owner, group, options),
    setTimes: (id, path, mtime, atime) => invoke('fs', 'setTimes', 'Changing the timestamp', id, path, mtime, atime),
    calculateSize: (id, dirs, correlationId) => invoke('fs', 'calculateSize', 'Calculating directory sizes', id, dirs, correlationId),
    checksum: (id, path, algorithm) => invoke('fs', 'checksum', 'Calculating a checksum', id, path, algorithm),
    readFile: (id, path, options) => invoke('fs', 'readFile', 'Reading a file', id, path, options),
    find: (request) => invoke('fs', 'find', 'Searching', request),
    findCancel: (correlationId) => invoke('fs', 'findCancel', 'Stopping the search', correlationId),
    localList: (path, options) => invoke('fs', 'localList', 'Listing a local directory', path, options),
    localStat: (path) => invoke('fs', 'localStat', 'Reading local file properties', path),
    localMkdir: (path) => invoke('fs', 'localMkdir', 'Creating a local directory', path),
  },

  session: {
    list: () => invoke('session', 'list', 'Listing the open sessions'),
    info: (id) => invoke('session', 'info', 'Reading session information', id),
  },

  queue: {
    add: (request) => invoke('queue', 'add', 'Queueing a transfer', request),
  },

  app: {
    maskValidate: (mask) => invoke('app', 'maskValidate', 'Validating a file mask', mask),
    maskMatches: (mask, name, options) => invoke('app', 'maskMatches', 'Testing a file mask', mask, name, options),
    pickPath: (options) => invoke('app', 'pickPath', 'Choosing a folder', options),
    showItemInFolder: (path) => invoke('app', 'showItemInFolder', 'Revealing a file', path),
  },

  /** Progress and streamed results (find, calculate size). Returns unsubscribe. */
  onProgress(fn) {
    const on = api.raw && api.raw.on;
    if (typeof on !== 'function') return () => {};
    try { return on('event:progress', fn) || (() => {}); } catch { return () => {}; }
  },
};

/**
 * Preferences these dialogs remember (the mask history, the bookmark lists,
 * the "same settings next time" boxes). Both directions go through the state
 * façade, so the degraded localStorage mode behaves the same as the real one.
 */
export async function readPref(dotted, fallback) {
  try {
    const doc = await api.configGet();
    const prefs = doc && doc.prefs && typeof doc.prefs === 'object' ? doc.prefs : doc;
    const value = String(dotted).split('.').reduce((o, k) => (o == null ? undefined : o[k]), prefs);
    return value === undefined ? fallback : value;
  } catch {
    return fallback;
  }
}

export async function writePrefs(patch, label) {
  try { await api.configSet(patch, label); return true; }
  catch (err) { notify.warning('Settings were not saved', err.message); return false; }
}

/** Push a value onto one of WinSCP's combo-box histories (config.history.<key>). */
export async function pushHistory(key, value) {
  if (!value) return;
  const bridge = api.raw && api.raw.config;
  if (bridge && typeof bridge.pushHistory === 'function') {
    try { await bridge.pushHistory(key, value); return; } catch { /* fall through */ }
  }
  const list = (await readPref(`history.${key}`, [])) || [];
  const next = [value, ...list.filter((v) => v !== value)].slice(0, 40);
  await writePrefs({ history: { [key]: next } }, `Remembered a recent ${key} entry`);
}

export async function readHistory(key) {
  const list = await readPref(`history.${key}`, []);
  return Array.isArray(list) ? list : [];
}

/** POSIX join for remote paths; the local side keeps its own separator. */
export function joinPath(dir, name, sep = '/') {
  const base = String(dir || '');
  if (!base) return name;
  const trimmed = base.length > 1 && (base.endsWith('/') || base.endsWith('\\')) ? base.slice(0, -1) : base;
  return `${trimmed}${trimmed.endsWith(':') ? '' : sep}${name}`;
}

/** The separator a path is written with, so local and remote both look right. */
export function separatorOf(path) {
  return /^[A-Za-z]:|\\/.test(String(path || '')) ? '\\' : '/';
}

export function parentOf(path) {
  const p = String(path || '');
  const sep = separatorOf(p);
  const i = p.lastIndexOf(sep);
  if (i < 0) return '';
  if (i === 0) return sep;
  return p.slice(0, i);
}

export function baseNameOf(path) {
  const p = String(path || '');
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i < 0 ? p : p.slice(i + 1);
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

/** FormatBytes: a short human form ('12.3 MB'). */
export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) { value /= 1024; unit += 1; }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${UNITS[unit]}`;
}

/** FormatBytes(fbNone): the exact byte count, digit-grouped. */
export function formatExactBytes(bytes) {
  const n = Number(bytes) || 0;
  return `${n.toLocaleString(getLanguage() === 'yue' ? 'zh-HK' : 'en-US')} B`;
}

export function formatTimestamp(ms) {
  const n = Number(ms) || 0;
  if (!n) return '';
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** A checkbox with its label, returning both the row and the input. */
export function checkRow(labelNode, checked, onChange, opts = {}) {
  const input = h('input', { type: 'checkbox' });
  input.checked = !!checked;
  if (opts.disabled) input.disabled = true;
  input.addEventListener('change', () => onChange(input.checked, input));
  const row = h('label', { class: 'check' }, input, h('span', {}, labelNode));
  if (opts.title) row.title = opts.title;
  return { element: row, input };
}

/**
 * A sheet strip — WinSCP's TPageControl, as real M3 tabs.
 * One tab stop with roving focus, correct roles, and `hidden` panels so a
 * hidden sheet is out of the accessibility tree as well as out of sight.
 */
export function createSheets(sheets, opts = {}) {
  const groupId = opts.id || uid('sheets');
  const tablist = h('div', {
    role: 'tablist', 'aria-label': opts.label || 'Sheets',
    style: {
      display: 'flex', gap: '4px', flexWrap: 'wrap',
      borderBottom: '1px solid var(--outline-var)',
      marginBottom: 'calc(10px * var(--den))',
    },
  });
  const body = h('div', { style: { minHeight: 0 } });
  const entries = [];
  let active = null;

  function select(id, { focus = false } = {}) {
    const target = entries.find((e) => e.id === id && !e.hidden) || entries.find((e) => !e.hidden);
    if (!target) return;
    active = target.id;
    for (const e of entries) {
      const on = e === target;
      e.tab.setAttribute('aria-selected', String(on));
      e.tab.tabIndex = on ? 0 : -1;
      e.tab.style.borderBottomColor = on ? 'var(--p)' : 'transparent';
      e.tab.style.color = on ? 'var(--p)' : 'var(--onsv)';
      e.tab.style.fontWeight = on ? '600' : '500';
      e.panel.hidden = !on;
    }
    if (focus) target.tab.focus();
    opts.onSelect?.(target.id);
  }

  for (const sheet of sheets) {
    const tabId = `${groupId}-tab-${sheet.id}`;
    const panelId = `${groupId}-panel-${sheet.id}`;
    const tab = h('button', {
      type: 'button', role: 'tab', id: tabId, 'aria-controls': panelId,
      'aria-selected': 'false', tabindex: '-1',
      style: {
        minHeight: 'calc(40px * var(--den))',
        padding: '0 calc(14px * var(--den))',
        borderBottom: '2px solid transparent',
        borderRadius: 'var(--shape-xs) var(--shape-xs) 0 0',
        color: 'var(--onsv)',
        fontSize: 'var(--type-label-lg)',
        fontWeight: '500',
        whiteSpace: 'nowrap',
      },
      onclick: () => select(sheet.id),
    }, sheet.label);
    appearanceTarget(tab, `dlg-sheet-${groupId}-${sheet.id}`, `Dialog sheet: ${sheet.id}`);
    const panel = h('div', {
      role: 'tabpanel', id: panelId, 'aria-labelledby': tabId, tabindex: '0',
      style: { outline: 'none' },
    }, sheet.content);
    panel.hidden = true;
    tablist.appendChild(tab);
    body.appendChild(panel);
    entries.push({ id: sheet.id, tab, panel, hidden: false });
  }

  rovingFocus(tablist, '[role="tab"]', { orientation: 'horizontal', onActivate: (el) => el.click() });
  const element = h('div', {}, tablist, body);
  select(opts.active || (entries[0] && entries[0].id));

  return {
    element,
    select,
    get active() { return active; },
    /** Hide a sheet whose subject does not apply (WinSCP's TabVisible). */
    setVisible(id, visible) {
      const e = entries.find((x) => x.id === id);
      if (!e) return;
      e.hidden = !visible;
      e.tab.hidden = !visible;
      if (!visible && active === id) select(null);
      else if (!visible) e.panel.hidden = true;
    },
    panelOf(id) { return (entries.find((x) => x.id === id) || {}).panel || null; },
    labelOf(id) { return (entries.find((x) => x.id === id) || {}).tab?.textContent || id; },
  };
}

/** A scrollable list box with keyboard selection — WinSCP's TListBox. */
export function createListBox(opts = {}) {
  const list = h('div', {
    role: 'listbox', tabindex: '0',
    'aria-label': opts.label || 'List',
    style: {
      border: '1px solid var(--outline-var)',
      borderRadius: 'var(--shape-sm)',
      background: 'var(--c-lowest)',
      minHeight: opts.minHeight || 'calc(160px * var(--uiscale))',
      maxHeight: opts.maxHeight || 'calc(300px * var(--uiscale))',
      overflow: 'auto',
      padding: '4px',
      display: 'flex',
      flexDirection: 'column',
      gap: '2px',
    },
  });
  let items = [];
  let index = -1;

  function paint() {
    clear(list);
    if (!items.length) {
      list.appendChild(h('div', { class: 'muted', style: { padding: 'calc(10px * var(--den))', fontSize: 'var(--type-body-sm)' } }, opts.emptyText || ''));
      list.removeAttribute('aria-activedescendant');
      return;
    }
    items.forEach((item, i) => {
      const id = `${list.id || (list.id = uid('lb'))}-o${i}`;
      const row = h('div', {
        role: 'option', id, 'aria-selected': String(i === index),
        style: {
          minHeight: 'calc(32px * var(--den))',
          padding: '0 calc(10px * var(--den))',
          display: 'flex', alignItems: 'center', gap: '8px',
          borderRadius: 'var(--shape-xs)',
          background: i === index ? 'var(--secc)' : 'transparent',
          color: i === index ? 'var(--onsecc)' : 'var(--onsfc)',
          fontSize: 'var(--type-body-sm)',
          cursor: 'default',
        },
        onclick: () => { select(i); },
        ondblclick: () => { select(i); opts.onActivate?.(items[i], i); },
      }, item.icon ? icon(item.icon, 16) : null,
      h('span', { class: 'ellipsis', title: item.title || item.label }, item.label),
      item.meta ? h('span', { class: 'muted mono', style: { fontSize: 'var(--type-label-sm)' } }, item.meta) : null);
      list.appendChild(row);
    });
    if (index >= 0) list.setAttribute('aria-activedescendant', `${list.id}-o${index}`);
  }

  function select(i) {
    index = i;
    paint();
    opts.onSelect?.(items[i] || null, i);
  }

  list.addEventListener('keydown', (e) => {
    if (!items.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); select(Math.min(items.length - 1, index + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); select(Math.max(0, index - 1)); }
    else if (e.key === 'Home') { e.preventDefault(); select(0); }
    else if (e.key === 'End') { e.preventDefault(); select(items.length - 1); }
    else if (e.key === 'Enter' && index >= 0) { e.preventDefault(); opts.onActivate?.(items[index], index); }
    else if (e.key === 'Delete' && index >= 0) { e.preventDefault(); opts.onDelete?.(items[index], index); }
  });

  return {
    element: list,
    get items() { return items; },
    get index() { return index; },
    set index(i) { index = i; paint(); },
    setItems(next, keepIndex = true) {
      items = next.slice();
      if (!keepIndex || index >= items.length) index = items.length ? Math.min(index, items.length - 1) : -1;
      paint();
    },
    select,
    get selected() { return items[index] || null; },
  };
}

/* ================================================================== */
/* 3. the rights frame                                                 */
/* ================================================================== */

const RIGHTS_STRINGS = {
  // The Cantonese never repeats the English verbatim: bilingual mode joins the
  // two with a middle dot, and "Set UID · Set UID" would be noise.
  rightsSetUid: ['Set UID', '設定 UID'],
  rightsSetGid: ['Set GID', '設定 GID'],
  rightsSticky: ['Sticky bit', '黏著位'],
  rightsAddX: ['Add X to directories', '目錄自動加 X'],
  rightsAddXHint: [
    'Directories need the execute bit to be entered at all, so this adds it to directories only.',
    '目錄冇 X 就入唔到，所以呢個淨係幫目錄加返 X。'],
  rightsOctalInvalid: ['{0} is not valid permission in octal format.', '{0} 唔係正確嘅八進位權限。'],
  rightsNoRights: ['No rights', '冇任何權限'],
  rightsDefault: ['Default rights (644)', '預設權限（644）'],
  rightsAll: ['All rights (777)', '全部權限（777）'],
  rightsLeaveAsIs: ['Leave as is', '維持原狀'],
  rightsCopyText: ['Copy as text', '複製做文字'],
  rightsCopyOctal: ['Copy as octal', '複製做八進位'],
  rightsPaste: ['Paste', '貼上'],
  rightsPasteFailed: ['The clipboard does not hold a permission value.', '剪貼簿入面唔係權限值。'],
  rightsUndefHint: ['A square in a box means the files disagree about that bit — leave it alone and it is not changed.', '格仔入面係方塊即係啲檔案唔一致——唔郁佢就唔會改。'],
  rightsGroupHint: ['Click to cycle every permission in this row.', '撳一下就一次過轉呢一行嘅權限。'],
  rightsApplyTitle: ['Set permissions', '設定權限'],
  rightsApplyBody: ['{0} will be set on "{1}".', '會將 {0} 套用喺「{1}」。'],
  rightsApplyBodyMany: ['{0} will be set on {1} item(s).', '會將 {0} 套用喺 {1} 個項目。'],
  rightsRecursive: ['Apply to all files and subdirectories', '套用埋所有子檔案同子目錄'],
  rightsNothing: ['Nothing was selected, so there are no permissions to change.', '冇揀嘢，所以冇權限要改。'],
  rightsUnsupported: ['{0} does not support changing permissions.', '{0} 唔支援改權限。'],
  rightsApplied: [[
    'Permissions of {0} item(s) set to {1}.',
    'Set permissions of {0} item(s) to {1}.',
    '{0} item(s) now wear {1}.',
    '{0} item(s) just got re-dressed in {1}.',
    'Wardrobe change complete! {0} item(s) now strutting around in a fabulous {1}!'], [
    '已將 {0} 個項目嘅權限設做 {1}。',
    '{0} 個項目權限改成 {1}。',
    '{0} 個項目而家著住 {1}。',
    '{0} 個項目啱啱換咗新衫 {1}。',
    '換衫大功告成！{0} 個項目而家著住靚爆嘅 {1} 行天橋！']],
  rightsFailed: ['Permissions were not changed: {0}', '改唔到權限：{0}'],
};

const tx = makeTranslator(RIGHTS_STRINGS);

const CHECK_LABEL = {
  read: () => t('rightsRead'),
  write: () => t('rightsWrite'),
  exec: () => t('rightsExec'),
};
const GROUP_LABEL = {
  user: () => t('ownerRow'),
  group: () => t('groupRow'),
  other: () => t('othersRow'),
};
const SPECIAL_LABEL = {
  setUid: () => tx('rightsSetUid'),
  setGid: () => tx('rightsSetGid'),
  sticky: () => tx('rightsSticky'),
};

/**
 * createRightsEditor(opts) -> handle
 *
 * opts:
 *   rights                 { set, unset } (default 0644)
 *   allowUndef             may a bit be undefined (a multi-file selection)
 *   allowAddXToDirectories show the "+x" option at all
 *   addXToDirectories      its initial state
 *   disabled               render read-only (the protocol has no chmod)
 *   onChange(rights, addX) fires on every edit
 */
export function createRightsEditor(opts = {}) {
  let rights = opts.rights ? { ...opts.rights } : fromNumber(RF.default);
  let allowUndef = !!opts.allowUndef;
  let allowAddX = opts.allowAddXToDirectories !== false;
  let addX = !!opts.addXToDirectories;
  let enabled = !opts.disabled;

  const checks = new Map();       // right key -> input
  const octalId = uid('octal');

  const octalInput = h('input', {
    type: 'text', class: 'field-input mono', id: octalId,
    inputmode: 'numeric', maxlength: '4', autocomplete: 'off', spellcheck: 'false',
    style: { width: '7ch', minWidth: '7ch', textAlign: 'center' },
  });
  const octalError = h('div', {
    role: 'alert',
    style: {
      display: 'none', fontSize: 'var(--type-label-sm)',
      color: 'var(--onerrc)', background: 'var(--errc)',
      borderRadius: 'var(--shape-xs)', padding: '4px 7px', marginTop: '4px',
      maxWidth: '46ch', lineHeight: '1.4',
    },
  });

  function makeCheck(key, labelOf) {
    const input = h('input', { type: 'checkbox' });
    // The accessible name follows the language mode, so a checkbox is never
    // left announcing English after the user switched to 粵語.
    bindRender(input, () => input.setAttribute('aria-label', `${labelOf()} — ${groupNameOf(key)}`));
    input.addEventListener('click', () => {
      // Deliberately NOT preventDefault(): cancelling a checkbox's click makes
      // the browser restore the previous checkedness *after* this listener has
      // run, which would silently undo the repaint below. The state is the
      // authority, so the repaint at the end simply overwrites whatever the
      // browser's own toggle did.
      if (!enabled) { paint(); return; }
      // VCL's AllowGrayed order: unchecked -> checked -> grayed -> unchecked.
      const state = stateOf(rights, key);
      const next = state === 'no' ? 'yes' : state === 'yes' ? (allowUndef ? 'undef' : 'no') : 'no';
      rights = withState(rights, key, next);
      delete rights.raw;
      paint();
      emit();
    });
    checks.set(key, input);
    return input;
  }

  function groupNameOf(key) {
    const g = GROUPS.find((x) => x.read === key || x.write === key || x.exec === key || x.special === key);
    return g ? GROUP_LABEL[g.id]() : '';
  }

  /**
   * One R/W/X cell. The letters are the .dfm's own captions — they are the
   * permission symbols, not English words, so they stay put in every language
   * — and the localized word is the title and the accessible name.
   */
  function cellFor(key, labelOf, letter) {
    const input = makeCheck(key, labelOf);
    const cell = h('label', { class: 'check', style: { gap: '5px', minHeight: 'calc(28px * var(--den))' } },
      input, h('span', { style: { fontSize: 'var(--type-label-md)', fontWeight: '600' } }, letter));
    bindRender(cell, () => { cell.title = labelOf(); });
    return cell;
  }

  const grid = h('div', {
    style: {
      display: 'grid',
      gridTemplateColumns: 'auto auto auto auto minmax(0, auto)',
      gap: 'calc(4px * var(--den)) calc(12px * var(--den))',
      alignItems: 'center',
    },
  });

  const groupButtons = [];
  for (const g of GROUPS) {
    const btn = h('button', {
      type: 'button',
      style: {
        justifySelf: 'start',
        minHeight: 'calc(30px * var(--den))',
        padding: '0 calc(10px * var(--den))',
        borderRadius: 'var(--shape-full)',
        border: '1px solid var(--outline-var)',
        color: 'var(--onsv)',
        fontSize: 'var(--type-label-md)',
        fontWeight: '600',
        whiteSpace: 'nowrap',
      },
      onclick: () => {
        if (!enabled) return;
        rights = cycleGroup(rights, g.id, allowUndef);
        delete rights.raw;
        paint();
        emit();
        announce(`${GROUP_LABEL[g.id]()}: ${describeGroup(g)}`);
      },
    });
    bindRender(btn, () => {
      btn.textContent = GROUP_LABEL[g.id]();
      btn.title = tx('rightsGroupHint');
      btn.setAttribute('aria-label', `${GROUP_LABEL[g.id]()} — ${tx('rightsGroupHint')}`);
    });
    appearanceTarget(btn, `rights-group-${g.id}`, `Permission row: ${g.id}`);
    groupButtons.push(btn);

    const readCell = cellFor(g.read, CHECK_LABEL.read, 'R');
    const writeCell = cellFor(g.write, CHECK_LABEL.write, 'W');
    const execCell = cellFor(g.exec, CHECK_LABEL.exec, 'X');
    const specialInput = makeCheck(g.special, SPECIAL_LABEL[g.special]);
    const specialCell = h('label', { class: 'check', style: { gap: '6px' } },
      specialInput,
      txLabel(tx, `rights${g.special[0].toUpperCase()}${g.special.slice(1)}`, { class: 'muted' }));

    grid.append(btn, readCell, writeCell, execCell, specialCell);
  }

  function describeGroup(g) {
    return [g.read, g.write, g.exec].map((k) => {
      const s = stateOf(rights, k);
      return s === 'yes' ? '1' : s === 'no' ? '0' : '?';
    }).join('');
  }

  const octalLabel = h('label', { class: 'field-label', for: octalId });
  bindRender(octalLabel, () => { octalLabel.textContent = t('rightsOctal'); });
  const modeStrEl = h('span', { class: 'muted mono', style: { fontSize: 'var(--type-label-sm)' } });
  const octalRow = h('div', { class: 'row', style: { gap: 'calc(8px * var(--den))' } },
    octalLabel, octalInput, modeStrEl);

  octalInput.addEventListener('input', () => {
    if (!enabled) return;
    const value = octalInput.value.trim();
    if (value.length < 3) { showOctalError(''); return; }
    try {
      rights = fromOctal(value);
      showOctalError('');
      // paint(), not just the checkboxes: the symbolic readout beside the field
      // is derived from the same state and would otherwise keep showing the
      // mode the dialog opened with while the user types a different one.
      // paintOctal() bails out while this input has focus, so the caret is safe.
      paint();
      emit();
    } catch (err) {
      showOctalError(err.message);
    }
  });
  octalInput.addEventListener('blur', () => {
    if (!enabled) return;
    const value = octalInput.value.trim();
    if (!value) { paintOctal(); showOctalError(''); return; }
    try {
      rights = fromOctal(value);
      showOctalError('');
      paint();
      emit();
    } catch (err) {
      showOctalError(err.message);
    }
  });

  function showOctalError(message) {
    octalError.textContent = message;
    octalError.style.display = message ? 'block' : 'none';
    octalInput.setAttribute('aria-invalid', String(!!message));
  }

  const addXCheck = checkRow(
    txLabel(tx, 'rightsAddX'),
    addX,
    (checked) => { addX = checked; emit(); },
    { title: tx('rightsAddXHint') },
  );

  const undefHint = h('div', {
    class: 'muted',
    style: { fontSize: 'var(--type-label-sm)', lineHeight: '1.4', maxWidth: '54ch' },
  });
  bindRender(undefHint, () => { undefHint.textContent = tx('rightsUndefHint'); });

  const root = h('div', {
    style: {
      display: 'flex', flexDirection: 'column',
      gap: 'calc(8px * var(--den))',
      padding: 'calc(10px * var(--den))',
      border: '1px solid var(--outline-var)',
      borderRadius: 'var(--shape-md)',
      background: 'var(--c-lowest)',
    },
  }, grid, octalRow, octalError, addXCheck.element, undefHint);
  appearanceTarget(root, 'rights-frame', 'Permission editor');

  registerContextMenu(root, () => {
    const undef = isUndef(rights);
    return [
      {
        label: tx('rightsNoRights'), icon: 'remove',
        checked: !undef && numberSet(rights) === RF.no,
        onSelect: () => setRights(fromNumber(RF.no), true),
      },
      {
        label: tx('rightsDefault'), icon: 'check',
        checked: !undef && numberSet(rights) === RF.default,
        onSelect: () => setRights(fromNumber(RF.default), true),
      },
      {
        label: tx('rightsAll'), icon: 'done_all',
        checked: !undef && numberSet(rights) === RF.all,
        onSelect: () => setRights(fromNumber(RF.all), true),
      },
      ...(allowUndef ? [{
        label: tx('rightsLeaveAsIs'), icon: 'pending',
        checked: numberSet(rights) === 0 && numberUnset(rights) === 0,
        onSelect: () => setRights(allUndef(), true),
      }] : []),
      SEPARATOR,
      {
        label: tx('rightsCopyText'), icon: 'content_copy', disabled: undef,
        onSelect: async () => {
          if (await copyText(textOf(rights))) notify.success(t('copiedClip'), textOf(rights));
        },
      },
      {
        label: tx('rightsCopyOctal'), icon: 'numbers', disabled: undef,
        onSelect: async () => {
          if (await copyText(octalOf(rights))) notify.success(t('copiedClip'), octalOf(rights));
        },
      },
      {
        label: tx('rightsPaste'), icon: 'content_copy',
        onSelect: async () => {
          let text = '';
          try { text = await navigator.clipboard.readText(); } catch { text = ''; }
          const value = String(text || '').trim();
          if (!looksLikeRights(value)) { notify.warning(tx('rightsPaste'), tx('rightsPasteFailed')); return; }
          try { setRights(parseRights(value, { allowUndef: true }), true); }
          catch (err) { notify.warning(tx('rightsPaste'), err.message); }
        },
      },
    ];
  });

  function paintChecks() {
    for (const [key, input] of checks) {
      const state = stateOf(rights, key);
      input.checked = state === 'yes';
      input.indeterminate = state === 'undef';
      input.disabled = !enabled;
    }
  }

  function paintOctal() {
    if (document.activeElement === octalInput) return;
    octalInput.value = isUndef(rights) ? '' : octalOf(rights);
    octalInput.disabled = !enabled;
  }

  function paintAddX() {
    addXCheck.element.hidden = !allowAddX;
    const effective = addXEffective(rights);
    addXCheck.input.disabled = !enabled || !effective;
    addXCheck.input.checked = addX;
    addXCheck.element.title = effective
      ? tx('rightsAddXHint')
      : `${tx('rightsAddXHint')} — ${t('rightsExec')}: already set for everyone.`;
  }

  function paint() {
    paintChecks();
    paintOctal();
    paintAddX();
    modeStrEl.textContent = isUndef(rights) ? modeStrOf(rights) : textOf(rights);
    undefHint.hidden = !allowUndef;
    for (const btn of groupButtons) btn.disabled = !enabled;
  }

  function emit() {
    opts.onChange?.(getRights(), addX);
  }

  function getRights() { return { ...rights }; }

  function setRights(next, fire = false) {
    rights = next ? { ...next } : allUndef();
    showOctalError('');
    paint();
    if (fire) emit();
  }

  paint();

  return {
    element: root,
    get rights() { return getRights(); },
    set rights(value) { setRights(value); },
    get addXToDirectories() { return addX && allowAddX && addXEffective(rights); },
    set addXToDirectories(value) { addX = !!value; paintAddX(); },
    get allowUndef() { return allowUndef; },
    set allowUndef(value) {
      allowUndef = !!value;
      // Dropping "undefined" must not leave a bit in limbo: an undefined bit
      // becomes unset, exactly as the properties dialog does.
      if (!allowUndef && isUndef(rights)) rights = fromNumber(numberSet(rights));
      paint();
    },
    set allowAddXToDirectories(value) { allowAddX = !!value; paintAddX(); },
    setEnabled(value) { enabled = !!value; paint(); },
    /** The frame's text, '(+x)' suffix included — TRightsFrame::GetText. */
    get text() {
      const base = isUndef(rights) ? modeStrOf(rights) : textOf(rights);
      return this.addXToDirectories ? `${base} (+x)` : base;
    },
    /** What fs:setRights wants: an octal mode, or a mode string when undefined. */
    chmodString(isDirectory) { return chmodStrOf(rights, isDirectory); },
    focus() { (groupButtons[0] || octalInput).focus(); },
    destroy() { root.remove(); },
  };
}

/* ================================================================== */
/* the standalone permission dialog                                    */
/* ================================================================== */

/**
 * The frame on its own, for a selection: the panel's "Permissions…" command.
 * Properties owns the full form; this is the fast path that changes one thing.
 *
 * props: { sessionId, files:[{name,path,type}], caps, directory, onApplied }
 */
registerDialog('rights', ({ props, close }) => {
  const files = Array.isArray(props.files) ? props.files : [];
  const caps = props.caps || {};
  const anyDirectories = files.some((f) => f.type === 'dir');
  const supported = caps.rights !== false;

  const first = files[0];
  const initial = first && first.rights && looksLikeRights(first.rights)
    ? parseRights(first.rights, { allowUndef: true })
    : fromNumber(RF.default);
  let rights = files.slice(1).reduce((acc, f) => (
    f.rights && looksLikeRights(f.rights) ? intersect(acc, parseRights(f.rights, { allowUndef: true }), true) : acc
  ), initial);
  let recursive = false;

  const editor = createRightsEditor({
    rights,
    allowUndef: files.length > 1,
    allowAddXToDirectories: anyDirectories,
    disabled: !supported,
    onChange: (next) => { rights = next; paintPreview(); },
  });

  const recursiveRow = checkRow(txLabel(tx, 'rightsRecursive'), false, (checked) => {
    recursive = checked;
    // Recursion is the one case where a single file may carry undefined bits,
    // because the bits it does not name are left alone in the subtree.
    editor.allowUndef = checked || files.length > 1;
  });
  recursiveRow.element.hidden = !anyDirectories || !supported;

  const preview = h('div', { class: 'mono muted', style: { fontSize: 'var(--type-label-md)' } });
  // The headline names the mode that OK would write, so it has to be rebuilt on
  // every edit — a sentence that still says "rw-r--r-- will be set" while the
  // editor holds 0700 is a statement of fact that has gone wrong.
  const headline = h('p', { class: 'prose' });
  function paintHeadline() {
    headline.textContent = files.length
      ? (files.length === 1
        ? tx('rightsApplyBody', editor.text, files[0].name)
        : tx('rightsApplyBodyMany', editor.text, files.length))
      : tx('rightsNothing');
  }
  bindRender(headline, paintHeadline);
  function paintPreview() {
    // With undefined bits the text IS the chmod argument, so printing both
    // would say the same thing twice.
    const mode = chmodStrOf(rights, anyDirectories);
    preview.textContent = editor.text === mode ? mode : `${editor.text}  ·  ${mode}`;
    paintHeadline();
  }
  paintPreview();

  const targets = files.map((f) => f.path || joinPath(props.directory || '', f.name)).filter(Boolean);

  const content = h('div', { class: 'stack' },
    headline,
    supported ? null : h('p', { class: 'prose' }, tx('rightsUnsupported', props.protocolName || 'This protocol')),
    editor.element,
    recursiveRow.element,
    preview);

  return {
    title: tx('rightsApplyTitle'),
    width: 560,
    content,
    actions: [
      { label: t('cancel'), kind: 'text' },
      {
        label: t('ok'), kind: 'filled', autofocus: true, disabled: !supported || !targets.length,
        onSelect: () => {
          const mode = editor.chmodString(anyDirectories);
          ops.fs.setRights(props.sessionId, targets, mode, {
            recursive,
            addXToDirectories: editor.addXToDirectories,
          }).then((count) => {
            notify.success(tx('rightsApplied', count ?? targets.length, editor.text));
            props.onApplied?.({ rights, mode, recursive, addXToDirectories: editor.addXToDirectories });
          }).catch((err) => {
            notify.error(tx('rightsApplyTitle'), tx('rightsFailed', err.message));
          });
          close();
        },
      },
    ],
  };
});

/** Open the standalone permission editor. */
export function openRightsDialog(props) { return openDialog('rights', props); }
