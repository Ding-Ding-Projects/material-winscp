// ui/panels.js — the file panel, and the two interfaces built out of it.
//
// This is WinSCP's TDirView / TUnixDirView plus the two shells around it:
// Commander (two panes, local on the left, remote on the right) and Explorer
// (one remote pane). Everything the original panel does is here:
//
//   * five view styles — large icons, small icons, list, details, thumbnails
//   * Norton-style and Explorer-style selection, full-row select, restore
//   * incremental search, file-mask filters, hidden files, file colours
//   * in-place rename, drag and drop between panels and with the OS
//   * an address bar with history and bookmarks, and a directory tree
//   * a virtualized list, so a 100 000-entry directory scrolls at full speed
//
// The panel owns *presentation and selection*. Every operation — transfer,
// delete, rename, sort, column visibility — is a commands.js action, so the
// keyboard, the menus, the toolbars and the context menus all reach the same
// single implementation.

import {
  h, icon, uid, clear, appearanceTarget, announce, debounce, throttleRaf,
  oneLine, rovingFocus, openModal,
} from '../dom.js';
import { t } from '../i18n.js';
import { bus, session as appSession, api } from '../state.js';
import { registerContextMenu, SEPARATOR } from './contextmenu.js';
import { notify } from './notifications.js';
import { createSearchBar, filterBy, noMatchMessage } from './searchbar.js';
import {
  backend, installCommands, runAction, commandState, actionLabel, readPref,
  writePref, formatBytes, performRename, promptText, confirm, ensureStyle, services,
} from './commands.js';
import {
  createColumnModel, createColumnHeader, cellText, extensionOf, typeOf,
  makeMeasurer, naturalCompare,
} from './panelcolumns.js';
import { createDriveView, createBrowsingSync, driveJoinPath, driveParentOf, normalizeLocal } from './driveview.js';
import { createToolbars } from './toolbars.js';
import { createMenuBar, fileContextItems, panelContextItems, installMenuMnemonics } from './menus.js';
import { createPanelStatusBar, installSessionStatus } from './statusbar.js';

/* ================================================================== */
/* styles                                                              */
/* ================================================================== */

const CSS = `
.fp{display:flex;flex-direction:column;min-width:0;min-height:0;flex:1 1 0;
  background:var(--md-sys-color-surface,var(--sfc,#fff));position:relative}
.fp.is-active{outline:2px solid var(--md-sys-color-primary,var(--pri,#0B57D0));outline-offset:-2px;border-radius:var(--shape-sm,8px)}
.fp-title{display:flex;align-items:center;gap:calc(6px*var(--den,1));min-height:calc(26px*var(--den,1));
  padding:0 calc(8px*var(--den,1));font-size:var(--type-label-md,.8125rem);font-weight:600;
  color:var(--md-sys-color-on-surface-variant,var(--onsfcv,#49454F));overflow:hidden}
.fp-title-path{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.fp-addr{display:flex;align-items:center;gap:calc(4px*var(--den,1));flex:1 1 auto;min-width:calc(100px*var(--den,1))}
.fp-addr input{flex:1 1 auto;min-width:0;font:inherit;font-size:var(--type-body-sm,.8125rem);
  background:var(--md-sys-color-surface-container-highest,rgba(0,0,0,.05));
  color:var(--md-sys-color-on-surface,var(--onsfc,#1D1B20));
  border:1px solid var(--md-sys-color-outline-variant,var(--outv,rgba(0,0,0,.12)));
  border-radius:var(--shape-xs,6px);min-height:calc(26px*var(--den,1));padding:0 calc(8px*var(--den,1))}
.fp-addr input:focus-visible{outline:2px solid var(--md-sys-color-primary,var(--pri,#0B57D0));outline-offset:-1px}
.fp-body{display:flex;flex:1 1 0;min-height:0;min-width:0}
.fp-tree{flex:0 0 auto;overflow:auto;border-inline-end:1px solid var(--md-sys-color-outline-variant,var(--outv,rgba(0,0,0,.12)))}
.fp-tree[hidden]{display:none}
.fp-splitter{flex:0 0 calc(5px*var(--den,1));cursor:col-resize;background:transparent}
.fp-splitter:hover,.fp-splitter:focus-visible{background:var(--md-sys-color-primary,var(--pri,#0B57D0))}
.fp-main{display:flex;flex-direction:column;flex:1 1 0;min-width:0;min-height:0}
.fp-head{display:flex;align-items:stretch;min-height:calc(26px*var(--den,1));
  border-bottom:1px solid var(--md-sys-color-outline-variant,var(--outv,rgba(0,0,0,.12)));
  background:var(--md-sys-color-surface-container-low,transparent);overflow:hidden;flex:0 0 auto}
.fp-h{display:flex;align-items:center;gap:calc(3px*var(--den,1));position:relative;flex:0 0 auto;
  padding:0 calc(7px*var(--den,1));font-size:var(--type-label-sm,.75rem);font-weight:600;cursor:pointer;
  color:var(--md-sys-color-on-surface-variant,var(--onsfcv,#49454F));user-select:none;overflow:hidden}
.fp-h:hover{background:var(--md-sys-color-surface-container-high,rgba(0,0,0,.05))}
.fp-h.is-sorted{color:var(--md-sys-color-primary,var(--pri,#0B57D0))}
.fp-h.is-droptarget{box-shadow:inset 2px 0 0 var(--md-sys-color-primary,var(--pri,#0B57D0))}
.fp-h-label{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fp-h-grip{position:absolute;inset-inline-end:0;top:0;bottom:0;width:calc(6px*var(--den,1));cursor:col-resize}
.fp-h-grip:hover{background:var(--md-sys-color-primary,var(--pri,#0B57D0))}
.fp-view{position:relative;flex:1 1 0;min-height:0;overflow:auto;outline:none;contain:strict}
.fp-sizer{position:relative;width:100%}
.fp-layer{position:absolute;inset-inline:0;top:0;will-change:transform}
.fp-row{display:flex;align-items:center;gap:calc(6px*var(--den,1));padding-inline:calc(6px*var(--den,1));
  white-space:nowrap;cursor:default;box-sizing:border-box;font-size:var(--type-body-sm,.8125rem);
  color:var(--md-sys-color-on-surface,var(--onsfc,#1D1B20))}
.fp-row:hover{background:var(--md-sys-color-surface-container-high,rgba(0,0,0,.045))}
.fp-row.is-sel{background:var(--md-sys-color-secondary-container,rgba(11,87,208,.16))}
.fp-row.is-focus{outline:1px dashed var(--md-sys-color-primary,var(--pri,#0B57D0));outline-offset:-1px}
.fp-row.is-cut{opacity:.55}
.fp-row.is-hidden-file{opacity:.62}
.fp-c{flex:0 0 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fp-c-name{display:flex;align-items:center;gap:calc(6px*var(--den,1))}
.fp-c-name .mi{flex:0 0 auto;color:var(--md-sys-color-primary,var(--pri,#0B57D0))}
.fp-row[data-type="file"] .fp-c-name .mi{color:var(--md-sys-color-on-surface-variant,var(--onsfcv,#49454F))}
.fp-rename{font:inherit;font-size:inherit;min-width:calc(80px*var(--den,1));flex:1 1 auto;
  border:1px solid var(--md-sys-color-primary,var(--pri,#0B57D0));border-radius:var(--shape-xs,4px);
  background:var(--md-sys-color-surface,var(--sfc,#fff));color:inherit;padding:0 calc(4px*var(--den,1))}
.fp-tile{display:flex;flex-direction:column;align-items:center;justify-content:flex-start;gap:calc(4px*var(--den,1));
  padding:calc(6px*var(--den,1));border-radius:var(--shape-sm,8px);text-align:center;overflow:hidden;box-sizing:border-box}
.fp-tile .fp-tile-name{width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-size:var(--type-label-sm,.75rem)}
.fp-tile.is-sel{background:var(--md-sys-color-secondary-container,rgba(11,87,208,.16))}
.fp-tile.is-focus{outline:1px dashed var(--md-sys-color-primary,var(--pri,#0B57D0));outline-offset:-1px}
.fp-tile-thumb{display:flex;align-items:center;justify-content:center;background:var(--md-sys-color-surface-container-high,rgba(0,0,0,.05));
  border-radius:var(--shape-xs,6px);overflow:hidden}
.fp-tile-thumb img{max-width:100%;max-height:100%;object-fit:contain}
.fp-empty{padding:calc(18px*var(--den,1));color:var(--md-sys-color-on-surface-variant,var(--onsfcv,#49454F));
  font-size:var(--type-body-sm,.8125rem)}
.fp-drop{position:absolute;inset:0;pointer-events:none;border:2px dashed var(--md-sys-color-primary,var(--pri,#0B57D0));
  border-radius:var(--shape-sm,8px);background:color-mix(in srgb,var(--md-sys-color-primary,#0B57D0) 8%,transparent);display:none}
.fp.is-dropping .fp-drop{display:block}
.fp-search{display:flex;align-items:center;gap:calc(4px*var(--den,1));padding:calc(2px*var(--den,1)) calc(6px*var(--den,1))}
.fp-search .sb{flex:1 1 auto}
.dv-wrap{display:flex;flex-direction:column;min-width:0;height:100%}
.dv{flex:1 1 auto;overflow:auto;padding:calc(2px*var(--den,1));min-width:calc(120px*var(--den,1))}
.dv-row{display:flex;align-items:center;gap:calc(4px*var(--den,1));min-height:calc(24px*var(--den,1));
  padding-inline-end:calc(6px*var(--den,1));border-radius:var(--shape-xs,4px);cursor:default;
  font-size:var(--type-body-sm,.8125rem);white-space:nowrap}
.dv-row:hover{background:var(--md-sys-color-surface-container-high,rgba(0,0,0,.05))}
.dv-row.is-current{background:var(--md-sys-color-secondary-container,rgba(11,87,208,.16));
  color:var(--md-sys-color-on-secondary-container,var(--onsec,#0B57D0))}
.dv-label{overflow:hidden;text-overflow:ellipsis}
.dv-twisty{min-width:calc(18px*var(--den,1));height:calc(18px*var(--den,1));padding:0;border:0;background:transparent;
  color:inherit;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;
  transition:transform var(--motion-short,.15s) var(--ease-standard,ease)}
.dv-node.is-open>.dv-row>.dv-twisty{transform:rotate(90deg)}
.dv-status,.dv-empty{padding:calc(4px*var(--den,1)) calc(8px*var(--den,1));font-size:var(--type-label-sm,.75rem)}
.wsp{display:flex;flex-direction:column;height:100%;min-height:0}
.wsp-panels{display:flex;flex:1 1 0;min-height:0;min-width:0}
.wsp-split{flex:0 0 calc(6px*var(--den,1));cursor:col-resize;background:var(--md-sys-color-outline-variant,var(--outv,rgba(0,0,0,.12)))}
.wsp-split:hover,.wsp-split:focus-visible{background:var(--md-sys-color-primary,var(--pri,#0B57D0));outline:none}
.wsp-cmdline{display:flex;align-items:center;gap:calc(6px*var(--den,1));padding:calc(4px*var(--den,1)) calc(8px*var(--den,1));
  border-top:1px solid var(--md-sys-color-outline-variant,var(--outv,rgba(0,0,0,.12)))}
.wsp-cmdline[hidden]{display:none}
.wsp-cmdline input{flex:1 1 auto;font:inherit;font-family:var(--mono,ui-monospace,monospace);
  background:var(--md-sys-color-surface-container-highest,rgba(0,0,0,.05));color:inherit;
  border:1px solid var(--md-sys-color-outline-variant,var(--outv,rgba(0,0,0,.12)));
  border-radius:var(--shape-xs,6px);min-height:calc(28px*var(--den,1));padding:0 calc(8px*var(--den,1))}
@media (max-width:900px){.wsp-panels{flex-direction:column}.wsp-split{flex-basis:calc(6px*var(--den,1));cursor:row-resize}}
`;

/* ================================================================== */
/* file masks — the panel-local fast path                              */
/* ================================================================== */
// design/main/masks.js is the authority on WinSCP's mask grammar and every
// server-side operation goes through it. The panel needs the same answer for
// up to 100 000 rows on every keystroke, and 100 000 IPC round trips is not an
// option, so the same rules are evaluated here: name and path wildcards,
// character classes, directory masks, include|exclude, and the size/time
// bounds ('>1M', '<=10M', '>2019-01-01', '>30D') with WinSCP's own precedence —
// a bare integer is a SIZE, not a year.

function splitTop(str, delims) {
  const out = [];
  let cur = '';
  let bracket = 0;
  for (const ch of String(str)) {
    if (ch === '[') bracket += 1;
    else if (ch === ']') bracket = Math.max(0, bracket - 1);
    if (bracket === 0 && delims.includes(ch)) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter((s) => s.length);
}

function maskToRegex(pattern) {
  let rx = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*') { rx += '.*'; i += 1; continue; }
    if (c === '?') { rx += '.'; i += 1; continue; }
    if (c === '[') {
      let j = i + 1;
      let cls = '';
      let negate = false;
      if (pattern[j] === '!' || pattern[j] === '^') { negate = true; j += 1; }
      while (j < pattern.length && pattern[j] !== ']') {
        cls += pattern[j].replace(/[\\^\]]/g, '\\$&');
        j += 1;
      }
      rx += `[${negate ? '^' : ''}${cls}]`;
      i = j + 1;
      continue;
    }
    rx += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    i += 1;
  }
  return rx;
}

const SIZE_RE = /^(\d+)\s*([KMG])?$/i;
const DATE_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
const REL_RE = /^(\d+)\s*([YMDHNS])$/i;

function parseBound(text) {
  const s = String(text).trim();
  const size = s.match(SIZE_RE);
  // WinSCP tries a plain integer as a SIZE first, so '>2019' is 2019 bytes.
  if (size) {
    const unit = { K: 1024, M: 1024 * 1024, G: 1024 * 1024 * 1024 }[(size[2] || '').toUpperCase()] || 1;
    return { kind: 'size', value: Number(size[1]) * unit };
  }
  const date = s.match(DATE_RE);
  if (date) {
    return {
      kind: 'time',
      value: new Date(Number(date[1]), Number(date[2]) - 1, Number(date[3]),
        Number(date[4] || 0), Number(date[5] || 0), Number(date[6] || 0)).getTime(),
    };
  }
  if (/^today$/i.test(s)) {
    const d = new Date(); d.setHours(0, 0, 0, 0);
    return { kind: 'time', value: d.getTime() };
  }
  const rel = s.match(REL_RE);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2].toUpperCase();
    const ms = { Y: 31557600000, M: 2629800000, D: 86400000, H: 3600000, N: 60000, S: 1000 }[unit] || 86400000;
    return { kind: 'time', relative: true, ms: n * ms };
  }
  return null;
}

function parseOneMask(raw) {
  let s = String(raw).trim();
  const entry = { lowSize: null, highSize: null, lowTime: null, highTime: null, directory: false, isPath: false };
  // Pull the trailing size/time bounds off, right to left, outside brackets.
  for (;;) {
    let cut = -1;
    let bracket = 0;
    for (let i = s.length - 1; i >= 0; i -= 1) {
      const ch = s[i];
      if (ch === ']') bracket += 1;
      else if (ch === '[') bracket = Math.max(0, bracket - 1);
      else if (bracket === 0 && (ch === '<' || ch === '>')) { cut = i; break; }
    }
    if (cut < 0) break;
    const op = s[cut];
    let rest = s.slice(cut + 1);
    let inclusive = false;
    if (rest.startsWith('=')) { inclusive = true; rest = rest.slice(1); }
    const bound = parseBound(rest);
    s = s.slice(0, cut);
    if (!bound) continue;                    // not a bound: treat as literal text
    const slot = bound.kind === 'size'
      ? (op === '>' ? 'lowSize' : 'highSize')
      : (op === '>' ? 'lowTime' : 'highTime');
    entry[slot] = { ...bound, inclusive };
  }
  s = s.trim();
  if (/[\\/]$/.test(s)) { entry.directory = true; s = s.replace(/[\\/]+$/, ''); }
  entry.isPath = /[\\/]/.test(s);
  const normalized = entry.isPath ? s.replace(/\\/g, '/') : s;
  if (normalized === '*.*' || normalized === '*') entry.rx = /^.*$/i;
  else if (/\*\.$/.test(normalized)) entry.rx = new RegExp(`^${maskToRegex(normalized.slice(0, -2))}[^.]*$`, 'i');
  else entry.rx = new RegExp(`^${maskToRegex(normalized)}$`, 'i');
  return entry;
}

function checkBounds(entry, item, now) {
  const size = item.type === 'dir' ? 0 : (item.size || 0);
  const mtime = item.mtime || 0;
  const timeValue = (b) => (b.relative ? now - b.ms : b.value);
  if (entry.lowSize && !(entry.lowSize.inclusive ? size >= entry.lowSize.value : size > entry.lowSize.value)) return false;
  if (entry.highSize && !(entry.highSize.inclusive ? size <= entry.highSize.value : size < entry.highSize.value)) return false;
  if (entry.lowTime && !(entry.lowTime.inclusive ? mtime >= timeValue(entry.lowTime) : mtime > timeValue(entry.lowTime))) return false;
  if (entry.highTime && !(entry.highTime.inclusive ? mtime <= timeValue(entry.highTime) : mtime < timeValue(entry.highTime))) return false;
  return true;
}

/**
 * compileMask('*.txt; *.log | *.tmp') -> (entry, fullPath) => boolean.
 * An empty mask matches everything, which is what "no filter" means.
 */
export function compileMask(maskStr) {
  const str = String(maskStr || '').trim();
  if (!str) return () => true;
  const [includeStr, excludeStr] = str.split('|');
  const include = splitTop(includeStr || '', ';,').map(parseOneMask);
  const exclude = splitTop(excludeStr || '', ';,').map(parseOneMask);

  function matchList(list, item, fullPath, now) {
    for (const e of list) {
      if (e.directory && item.type !== 'dir') continue;
      const subject = e.isPath ? String(fullPath || item.name).replace(/\\/g, '/') : item.name;
      if (!e.rx.test(subject)) continue;
      if (!checkBounds(e, item, now)) continue;
      return true;
    }
    return false;
  }

  return function matches(item, fullPath) {
    const now = Date.now();
    if (exclude.length && matchList(exclude, item, fullPath, now)) return false;
    if (!include.length) return true;
    return matchList(include, item, fullPath, now);
  };
}

/** The compiled colour rules from prefs.fileColors, rebuilt when they change. */
let colorRules = null;
function fileColorRules() {
  if (colorRules) return colorRules;
  const list = readPref('fileColors', []) || [];
  colorRules = list
    .filter((r) => r && r.mask && r.color)
    .map((r) => ({ match: compileMask(r.mask), color: r.color, dark: r.dark || r.color }));
  return colorRules;
}
bus.on('prefs:changed', (e) => { if (!e || e.path === 'fileColors') colorRules = null; });

function colorFor(entry, fullPath, dark) {
  for (const rule of fileColorRules()) {
    if (rule.match(entry, fullPath)) return dark ? rule.dark : rule.color;
  }
  return null;
}

/* ================================================================== */
/* view styles                                                         */
/* ================================================================== */

const VIEW_STYLES = ['icon', 'smallIcon', 'list', 'report', 'thumbnail'];

function metricsFor(style, den, thumbSize) {
  switch (style) {
    case 'icon': return { grid: true, tileW: 108 * den, tileH: 92 * den, iconPx: 34 };
    case 'smallIcon': return { grid: true, tileW: 190 * den, tileH: 24 * den, iconPx: 16, inline: true };
    case 'list': return { grid: true, tileW: 150 * den, tileH: 22 * den, iconPx: 15, inline: true };
    case 'thumbnail': return { grid: true, tileW: (thumbSize + 22) * den, tileH: (thumbSize + 34) * den, iconPx: 30, thumb: thumbSize };
    default: return { grid: false, rowH: 26 * den, iconPx: 16 };
  }
}

function iconForEntry(entry) {
  if (entry.name === '..') return 'arrow_upward';
  if (entry.type === 'dir') return 'folder';
  if (entry.isSymlink || entry.type === 'link') return 'open_in_new';
  const ext = extensionOf(entry.name).toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico'].includes(ext)) return 'visibility';
  if (['zip', 'gz', 'tar', 'bz2', 'xz', '7z', 'rar'].includes(ext)) return 'layers';
  if (['exe', 'msi', 'dll', 'bat', 'cmd', 'sh', 'ps1'].includes(ext)) return 'terminal';
  if (['js', 'ts', 'json', 'css', 'html', 'xml', 'c', 'h', 'cpp', 'py', 'rb', 'go', 'rs', 'java', 'cs', 'php'].includes(ext)) return 'code';
  if (['key', 'pem', 'crt', 'pub'].includes(ext)) return 'key';
  return 'description';
}

/* ================================================================== */
/* the panel                                                           */
/* ================================================================== */

let panelSeq = 0;

/**
 * createFilePanel({ side, workspace, interfaceMode })
 *
 * Returns the handle commands.js, the toolbars, the status bar and the
 * workspace all talk to. Nothing outside this module touches its internals.
 */
export function createFilePanel(opts = {}) {
  ensureStyle('winscp-panels', CSS);
  const side = opts.side === 'local' ? 'local' : 'remote';
  const isLocal = side === 'local';
  const panelId = opts.id || `${side}-${(panelSeq += 1)}`;
  const workspace = opts.workspace || null;
  const interfaceMode = opts.interfaceMode || 'commander';

  /* ---- state ---- */
  let rawEntries = [];
  let view = [];
  let path = '';
  let selected = new Set();
  let lastSelected = new Set();
  let focusIndex = 0;
  let anchorIndex = 0;
  let loading = false;
  let loadError = null;
  let viewStyle = readPref('panel.viewStyle', 'report');
  let filterMask = '';
  let showHidden = readPref('showHiddenFiles', false) === true;
  let treeShown = readPref(isLocal ? 'scpCommander.localPanel.driveView' : 'scpCommander.remotePanel.driveView', false) === true;
  let renaming = null;
  const history = [];
  let historyIndex = -1;
  let hiddenCount = 0;
  let filteredCount = 0;
  const searchState = { active: false, text: '', matched: true, timer: 0 };
  const sizeCache = new Map();

  const columns = createColumnModel({ side, interfaceMode });

  /* ---- DOM ---- */
  const viewportId = uid('fpview');
  const titlePath = h('span', { class: 'fp-title-path' });
  const addrInput = h('input', {
    type: 'text', spellcheck: 'false', autocomplete: 'off',
    'aria-label': isLocal ? t('localPanel') : t('remotePanel'),
  });
  const addrBar = h('div', { class: 'fp-addr' }, addrInput);
  const title = h('div', { class: 'fp-title' },
    icon(isLocal ? 'computer' : 'dns', 15), titlePath);
  appearanceTarget(title, `panel-title-${side}`, `${isLocal ? 'Local' : 'Remote'} panel title`);

  const layer = h('div', { class: 'fp-layer' });
  const sizer = h('div', { class: 'fp-sizer' }, layer);
  const viewport = h('div', {
    class: 'fp-view', id: viewportId, tabindex: '0', role: 'grid',
    'aria-label': isLocal ? t('localPanel') : t('remotePanel'),
    'aria-rowcount': '0',
  }, sizer);
  const emptyNote = h('div', { class: 'fp-empty', hidden: true });
  const dropHint = h('div', { class: 'fp-drop' });

  const header = createColumnHeader(columns, {
    panel: null,        // filled in below once the handle exists
    measure: makeMeasurer(() => view, () => getComputedStyle(viewport).font),
    onSort: () => { applyView(); render(); },
  });

  const treeHost = h('div', { class: 'fp-tree', hidden: !treeShown });
  const splitter = h('div', {
    class: 'fp-splitter', role: 'separator', tabindex: '0',
    'aria-orientation': 'vertical', 'aria-label': t('treeToggle'), hidden: !treeShown,
  });

  const searchBar = createSearchBar({
    id: `panel-${side}-${interfaceMode}`,
    labelKey: 'filterPh', placeholderKey: 'filterPh',
    appearanceKey: `panel-search-${side}`,
    appearanceLabel: `${isLocal ? 'Local' : 'Remote'} panel search`,
    compact: true,
    sampleProvider: () => rawEntries.slice(0, 400).map((e) => e.name).join('\n'),
    onChange: () => { applyView(); render(); },
  });
  const searchRow = h('div', { class: 'fp-search' }, searchBar.element);

  const main = h('div', { class: 'fp-main' },
    searchRow, header.element,
    h('div', { style: { position: 'relative', flex: '1 1 0', minHeight: '0', display: 'flex', flexDirection: 'column' } },
      viewport, emptyNote));
  const body = h('div', { class: 'fp-body' }, treeHost, splitter, main);
  const root = h('div', { class: `fp fp-${side}`, 'data-side': side }, title, body, dropHint);
  appearanceTarget(root, `panel-${side}`, `${isLocal ? 'Local' : 'Remote'} file panel`);

  /* ---- session ---- */
  function sessionInfo() {
    return workspace && typeof workspace.sessionInfo === 'function' ? workspace.sessionInfo() : null;
  }
  function sessionId() { const i = sessionInfo(); return i ? i.id : null; }

  /* ---- the tree ---- */
  let tree = null;
  function ensureTree() {
    if (tree || !treeShown) return;
    tree = createDriveView({
      side,
      sessionId,
      initialPath: path,
      onNavigate: (p) => navigate(p),
    });
    treeHost.appendChild(tree.element);
    treeHost.style.width = `${readPref(isLocal ? 'scpCommander.localPanel.driveViewWidth' : 'scpCommander.remotePanel.driveViewWidth', 180)}px`;
  }

  /* ---- loading ---- */

  function defaultPath() {
    if (isLocal) return readPref('scpCommander.localPanel.lastPath', '') || '';
    const info = sessionInfo();
    return (info && (info.remotePath || info.home)) || '/';
  }

  async function load(target, { pushHistory = true, force = false } = {}) {
    const want = target === undefined || target === null ? path : target;
    loading = true;
    loadError = null;
    render();
    try {
      let entries;
      if (isLocal) {
        const res = await backend.fs('localList', want || homeGuess(), { includeParent: true });
        path = res.path;
        entries = res.entries || [];
      } else {
        const id = sessionId();
        if (!id) throw new Error(t('notConnected'));
        const res = await backend.fs('list', id, want || '/', { refresh: force });
        entries = Array.isArray(res) ? res : (res.entries || []);
        path = String(want || '/');
        if (path !== '/' && !entries.some((e) => e.name === '..')) {
          entries = [{ name: '..', type: 'dir', size: 0, mtime: 0, rights: '', owner: '', group: '', linkTarget: '', isSymlink: false, hidden: false }, ...entries];
        }
      }
      rawEntries = entries;
      // A directory's calculated size survives a refresh of the same directory.
      // The cache key joins the path and the name with NUL, which is the one
      // byte a path on any of these filesystems can never contain.
      for (const e of rawEntries) {
        const cached = sizeCache.get(`${path}\u0000${e.name}`);
        if (cached != null) e.calculatedSize = cached;
      }
      loadError = null;
      if (pushHistory) pushHistoryEntry(path);
      addrInput.value = path;
      titlePath.textContent = path;
      titlePath.title = path;
      addrInput.disabled = false;
      selected = new Set();
      focusIndex = 0;
      anchorIndex = 0;
      applyView();
      render();
      bus.emit('panel:pathChanged', { side, path, panel: handle });
      bus.emit('panel:entriesChanged', { side, count: view.length });
      if (tree) tree.setPath(path);
      // Persist where the panel was, so the next launch reopens it.
      writePref(
        isLocal ? 'scpCommander.localPanel.lastPath' : 'scpCommander.remotePanel.lastPath',
        path, `Changed the ${side} panel directory`,
      );
    } catch (err) {
      loadError = err.message || String(err);
      rawEntries = [];
      // The header must never go blank: a panel with no title looks broken,
      // where "Not connected" is a state the user can act on.
      titlePath.textContent = path || loadError;
      titlePath.title = titlePath.textContent;
      addrInput.disabled = !path;
      applyView();
      render();
      notify.error(isLocal ? t('localPanel') : t('remotePanel'), loadError);
    } finally {
      loading = false;
      render();
    }
  }

  function homeGuess() {
    // With no remembered path the local panel opens where the app was started,
    // which main resolves for us; '.' is that, expressed portably.
    return '.';
  }

  function pushHistoryEntry(p) {
    if (history[historyIndex] === p) return;
    history.splice(historyIndex + 1);
    history.push(p);
    if (history.length > 60) history.shift();
    historyIndex = history.length - 1;
  }

  /* ---- filtering, sorting ---- */

  function applyView() {
    const maskFn = compileMask(filterMask);
    const predicate = searchBar.isActive ? searchBar.predicate : null;
    hiddenCount = 0;
    filteredCount = 0;
    const out = [];
    for (const e of rawEntries) {
      if (e.name === '..') { out.push(e); continue; }
      if (!showHidden && e.hidden) { hiddenCount += 1; continue; }
      if (filterMask && !maskFn(e, pathOf(e))) { filteredCount += 1; continue; }
      if (predicate && !predicate.test(e.name)) { filteredCount += 1; continue; }
      out.push(e);
    }
    out.sort(columns.comparator());
    view = out;
    viewport.setAttribute('aria-rowcount', String(view.length));
  }

  /* ---- virtualization ---- */

  let renderScheduled = false;
  const scheduleRender = throttleRaf(() => { renderScheduled = false; render(); });

  function den() { return Number(getComputedStyle(document.documentElement).getPropertyValue('--den')) || 1; }

  function metrics() {
    return metricsFor(viewStyle, den(), readPref('panel.thumbnailSize', 96));
  }

  function perRow(m) {
    if (!m.grid) return 1;
    const w = viewport.clientWidth || 600;
    return Math.max(1, Math.floor(w / m.tileW));
  }

  function render() {
    const m = metrics();
    const cols = perRow(m);
    const rowH = m.grid ? m.tileH : m.rowH;
    const rows = Math.ceil(view.length / cols);
    sizer.style.height = `${rows * rowH}px`;

    emptyNote.hidden = !(view.length === 0);
    if (view.length === 0) {
      clear(emptyNote);
      emptyNote.appendChild(h('span', {},
        loading ? t('connecting')
          : loadError ? loadError
            : (filterMask || searchBar.isActive)
              ? noMatchMessage(searchBar.predicate, isLocal ? t('localPanel') : t('remotePanel'))
              : t('emptyDir')));
      if (!loading && !loadError && hiddenCount) {
        emptyNote.appendChild(h('div', { class: 'muted' }, t('hiddenCount', String(hiddenCount))));
      }
    }

    const scrollTop = viewport.scrollTop;
    const viewH = viewport.clientHeight || 400;
    const first = Math.max(0, Math.floor(scrollTop / rowH) - 3);
    const last = Math.min(rows, Math.ceil((scrollTop + viewH) / rowH) + 3);
    layer.style.transform = `translateY(${first * rowH}px)`;

    clear(layer);
    const dark = document.documentElement.dataset.theme === 'dark';
    for (let r = first; r < last; r += 1) {
      if (m.grid) {
        const rowEl = h('div', { style: { display: 'flex', height: `${rowH}px` } });
        for (let c = 0; c < cols; c += 1) {
          const i = r * cols + c;
          if (i >= view.length) break;
          rowEl.appendChild(buildTile(view[i], i, m, dark));
        }
        layer.appendChild(rowEl);
      } else {
        const i = r;
        if (i >= view.length) break;
        layer.appendChild(buildRow(view[i], i, m, dark, rowH));
      }
    }
  }

  viewport.addEventListener('scroll', () => { if (!renderScheduled) { renderScheduled = true; scheduleRender(); } });
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => render()).observe(viewport);

  /* ---- row and tile building ---- */

  function rowCommon(el, entry, index, dark) {
    const full = pathOf(entry);
    const colour = colorFor(entry, full, dark);
    if (colour) el.style.color = colour;
    if (selected.has(entry.name)) el.classList.add('is-sel');
    if (index === focusIndex) el.classList.add('is-focus');
    if (entry.hidden && showHidden && readPref('panel.hiddenAsNormal', false) !== true) el.classList.add('is-hidden-file');
    el.dataset.index = String(index);
    el.dataset.name = entry.name;
    el.dataset.type = entry.type;
    el.draggable = entry.name !== '..';
    el.addEventListener('pointerdown', (e) => onRowPointer(e, index));
    el.addEventListener('dblclick', () => activate(index));
    el.addEventListener('dragstart', (e) => onDragStart(e, entry, index));
    return el;
  }

  function buildRow(entry, index, m, dark, rowH) {
    const cells = [];
    for (const col of columns.visible) {
      if (col.key === 'name') {
        const nameCell = h('div', {
          class: 'fp-c fp-c-name', style: { width: `${col.width}px`, textAlign: col.align },
          title: entry.name,
        }, icon(iconForEntry(entry), m.iconPx),
        renaming && renaming.name === entry.name
          ? renaming.input
          : h('span', { class: 'ellipsis' }, entry.name));
        cells.push(nameCell);
      } else {
        const text = cellText(entry, col.key);
        cells.push(h('div', {
          class: 'fp-c', style: { width: `${col.width}px`, textAlign: col.align },
          title: text || null,
        }, text));
      }
    }
    const el = h('div', {
      class: 'fp-row', role: 'row', 'aria-rowindex': String(index + 1),
      'aria-selected': String(selected.has(entry.name)),
      style: { height: `${rowH}px` },
    }, ...cells);
    if (readPref('panel.fullRowSelect', true) === false) el.style.width = 'max-content';
    return rowCommon(el, entry, index, dark);
  }

  function buildTile(entry, index, m, dark) {
    const thumb = m.thumb
      ? h('div', {
        class: 'fp-tile-thumb',
        style: { width: `${m.thumb}px`, height: `${m.thumb}px` },
      }, icon(iconForEntry(entry), Math.round(m.thumb / 2.4)))
      : icon(iconForEntry(entry), m.iconPx);
    const el = h('div', {
      class: 'fp-tile', role: 'row', 'aria-rowindex': String(index + 1),
      'aria-selected': String(selected.has(entry.name)),
      style: {
        width: `${m.tileW}px`, height: `${m.tileH}px`,
        flexDirection: m.inline ? 'row' : 'column',
        alignItems: 'center', justifyContent: m.inline ? 'flex-start' : 'flex-start',
      },
      title: `${entry.name}${entry.type === 'dir' ? '' : ` — ${formatBytes(entry.size || 0)}`}`,
    }, thumb,
    renaming && renaming.name === entry.name
      ? renaming.input
      : h('span', { class: 'fp-tile-name' }, entry.name));
    return rowCommon(el, entry, index, dark);
  }

  /* ---- selection ---- */

  function explorerStyle() { return readPref('panel.explorerStyleSelection', false) === true; }

  function setFocus(index, { extend = false, toggle = false } = {}) {
    if (!view.length) return;
    const next = Math.max(0, Math.min(view.length - 1, index));
    if (extend) {
      const from = Math.min(anchorIndex, next);
      const to = Math.max(anchorIndex, next);
      selected = new Set();
      for (let i = from; i <= to; i += 1) if (view[i].name !== '..') selected.add(view[i].name);
    } else if (toggle) {
      const name = view[next].name;
      if (name !== '..') { if (selected.has(name)) selected.delete(name); else selected.add(name); }
      anchorIndex = next;
    } else {
      anchorIndex = next;
      if (explorerStyle()) {
        selected = new Set(view[next].name === '..' ? [] : [view[next].name]);
      }
    }
    focusIndex = next;
    render();
    scrollIntoView(next);
    emitSelection();
  }

  function scrollIntoView(index) {
    const m = metrics();
    const cols = perRow(m);
    const rowH = m.grid ? m.tileH : m.rowH;
    const row = Math.floor(index / cols);
    const top = row * rowH;
    if (top < viewport.scrollTop) viewport.scrollTop = top;
    else if (top + rowH > viewport.scrollTop + viewport.clientHeight) viewport.scrollTop = top + rowH - viewport.clientHeight;
  }

  function emitSelection() {
    bus.emit('panel:selectionChanged', { side, count: selected.size, panel: handle });
  }

  function onRowPointer(e, index) {
    setActive();
    if (e.button === 2) {
      // Right-click focuses the row without destroying an existing selection —
      // the *Focused* commands act on it, exactly as WinSCP does.
      if (!selected.has(view[index].name)) focusIndex = index;
      render();
      return;
    }
    if (e.shiftKey) setFocus(index, { extend: true });
    else if (e.ctrlKey || e.metaKey) setFocus(index, { toggle: true });
    else setFocus(index);
  }

  function activate(index) {
    const entry = view[index];
    if (!entry) return;
    if (entry.type === 'dir') {
      navigate(entry.name === '..' ? parentPath() : pathOf(entry));
      return;
    }
    const action = readPref('panel.doubleClickAction', readPref('doubleClickAction', 'edit'));
    if (action === 'copy') runAction(isLocal ? 'LocalCopyFocusedAction' : 'RemoteCopyFocusedAction', { side, panel: handle, entry });
    else if (action === 'open') runAction('CurrentOpenAction', { side, panel: handle, entry });
    else runAction('CurrentEditFocusedAction', { side, panel: handle, entry });
  }

  /* ---- keyboard ---- */

  viewport.addEventListener('keydown', (e) => {
    const m = metrics();
    const cols = perRow(m);
    const pageRows = Math.max(1, Math.floor(viewport.clientHeight / (m.grid ? m.tileH : m.rowH)) - 1);
    const extend = e.shiftKey;
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); setFocus(focusIndex + cols, { extend }); return;
      case 'ArrowUp': e.preventDefault(); setFocus(focusIndex - cols, { extend }); return;
      case 'ArrowRight': if (cols > 1) { e.preventDefault(); setFocus(focusIndex + 1, { extend }); return; } break;
      case 'ArrowLeft': if (cols > 1) { e.preventDefault(); setFocus(focusIndex - 1, { extend }); return; } break;
      case 'PageDown': e.preventDefault(); setFocus(focusIndex + pageRows * cols, { extend }); return;
      case 'PageUp': e.preventDefault(); setFocus(focusIndex - pageRows * cols, { extend }); return;
      case 'Home': e.preventDefault(); setFocus(0, { extend }); return;
      case 'End': e.preventDefault(); setFocus(view.length - 1, { extend }); return;
      case 'Enter': e.preventDefault(); activate(focusIndex); return;
      case 'Insert': e.preventDefault(); setFocus(focusIndex + 1, { toggle: false }); toggleFocusedSelection(focusIndex - 1); return;
      case ' ':
        if (!searchState.active) { e.preventDefault(); toggleFocusedSelection(); return; }
        break;
      case 'F2': e.preventDefault(); runAction('CurrentRenameAction', { side, panel: handle }); return;
      case 'Escape':
        if (searchState.active) { e.preventDefault(); endIncrementalSearch(); return; }
        break;
      default: break;
    }
    // Incremental search: WinSCP's three modes — off, start on any letter, or
    // Ctrl+F only. A modified key is never swallowed here.
    const mode = readPref('panel.incrementalSearch', 'typing');
    if (mode !== 'off' && !e.ctrlKey && !e.altKey && !e.metaKey && e.key.length === 1) {
      if (mode === 'typing' || searchState.active) { e.preventDefault(); typeIncremental(e.key); }
    } else if (e.key === 'Backspace' && searchState.active) {
      e.preventDefault();
      searchState.text = searchState.text.slice(0, -1);
      runIncremental();
    }
  });

  viewport.addEventListener('focus', () => setActive());

  /* ---- incremental search ---- */

  function typeIncremental(ch) {
    searchState.active = true;
    searchState.text += ch;
    runIncremental();
  }

  function runIncremental() {
    const needle = searchState.text.toLowerCase();
    if (!needle) { endIncrementalSearch(); return; }
    let found = -1;
    for (let i = 0; i < view.length; i += 1) {
      const j = (focusIndex + i) % view.length;
      if (view[j].name.toLowerCase().startsWith(needle)) { found = j; break; }
    }
    searchState.matched = found >= 0;
    if (found >= 0) { focusIndex = found; render(); scrollIntoView(found); }
    bus.emit('panel:searchChanged', { side, ...searchState });
    clearTimeout(searchState.timer);
    // WinSCP drops the incremental search after a pause, so the next keystroke
    // starts a fresh one instead of extending a forgotten prefix.
    searchState.timer = setTimeout(endIncrementalSearch, 2500);
  }

  function endIncrementalSearch() {
    clearTimeout(searchState.timer);
    searchState.active = false;
    searchState.text = '';
    searchState.matched = true;
    bus.emit('panel:searchChanged', { side, ...searchState });
  }

  /* ---- rename in place ---- */

  function beginRename(entry) {
    if (!entry || entry.name === '..') return false;
    const input = h('input', {
      class: 'fp-rename', type: 'text', value: entry.name, spellcheck: 'false',
      'aria-label': t('newName'),
    });
    renaming = { name: entry.name, input, entry };
    render();
    requestAnimationFrame(() => {
      input.focus();
      const dot = entry.type === 'dir' ? -1 : entry.name.lastIndexOf('.');
      input.setSelectionRange(0, dot > 0 ? dot : entry.name.length);
    });
    const finish = async (commit) => {
      const next = input.value.trim();
      renaming = null;
      render();
      viewport.focus();
      if (commit && next && next !== entry.name) {
        await performRename({ side, isLocal, panel: handle, sessionId: sessionId() }, entry, next);
        revealName(next);
      }
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => { if (renaming) finish(true); });
    return true;
  }

  /* ---- drag and drop ---- */

  function onDragStart(e, entry, index) {
    if (!selected.has(entry.name)) { setFocus(index); selected = new Set([entry.name]); render(); }
    const paths = selectionPaths();
    const payload = JSON.stringify({ side, sessionId: sessionId(), paths, panelId });
    try {
      e.dataTransfer.setData('application/x-winscp-files', payload);
      // Plain text and a URI list are what a foreign application will accept.
      // Electron does not expose webContents.startDrag through this preload, so
      // a true OS file drag is not possible here — text is what does work, and
      // the panel says so rather than pretending the drop moved a file.
      e.dataTransfer.setData('text/plain', paths.join('\n'));
      if (isLocal) e.dataTransfer.setData('text/uri-list', paths.map((p) => `file:///${String(p).replace(/\\/g, '/')}`).join('\r\n'));
    } catch { /* some hosts refuse extra types */ }
    e.dataTransfer.effectAllowed = 'copyMove';
  }

  root.addEventListener('dragover', (e) => {
    const types = Array.from(e.dataTransfer.types || []);
    if (!types.includes('application/x-winscp-files') && !types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = e.shiftKey ? 'move' : 'copy';
    root.classList.add('is-dropping');
  });
  root.addEventListener('dragleave', (e) => { if (e.target === root) root.classList.remove('is-dropping'); });
  root.addEventListener('drop', async (e) => {
    root.classList.remove('is-dropping');
    const raw = e.dataTransfer.getData('application/x-winscp-files');
    if (raw) {
      e.preventDefault();
      let data;
      try { data = JSON.parse(raw); } catch { return; }
      if (data.panelId === panelId) return;                 // dropped on itself
      await acceptPanelDrop(data, e.shiftKey);
      return;
    }
    if (e.dataTransfer.files && e.dataTransfer.files.length) {
      e.preventDefault();
      await acceptOsDrop(Array.from(e.dataTransfer.files));
    }
  });

  async function acceptPanelDrop(data, move) {
    const ctx = { side, panel: handle, other: workspace ? workspace.other(side) : null };
    if (data.side === side) {
      notify.info(t('transferSettingsShort'), 'Both panels are on the same side, so there is nothing to transfer.');
      return;
    }
    const direction = isLocal ? 'download' : 'upload';
    const action = direction === 'download'
      ? (move ? 'RemoteMoveAction' : 'RemoteCopyAction')
      : (move ? 'LocalMoveAction' : 'LocalCopyAction');
    // The drop targets THIS panel's directory, so the command runs against the
    // source panel with an explicit target.
    const sourcePanel = workspace ? workspace.panel(data.side) : null;
    if (!sourcePanel) return;
    if (readPref('dDTransferConfirmation', true) !== false) {
      const ok = await confirm({
        title: move ? t('moveDots') : (direction === 'download' ? t('downloadTitle') : t('uploadTitle')),
        body: `${data.paths.length} ${data.paths.length === 1 ? 'item' : 'items'} → ${path}`,
        confirmLabel: move ? t('move_') : t('copy_'),
        danger: move,
      });
      if (!ok) return;
    }
    runAction(action, { side: data.side, panel: sourcePanel, other: handle, selection: sourcePanel.selection() });
    void ctx;
  }

  async function acceptOsDrop(files) {
    const paths = files.map((f) => f.path).filter(Boolean);
    if (!paths.length) {
      // Electron 32 removed File.path, so a drop from the desktop carries no
      // usable path. Saying so and offering the picker is honest; silently
      // doing nothing is not.
      notify.warning(t('dragDropDownloads'), 'This build cannot read a file path from a desktop drag. Choosing the files instead uploads exactly the same thing.', {
        actions: [{
          label: t('browse'),
          onSelect: async () => {
            try {
              const picked = await backend.app('pickPath', { multiple: true, title: t('uploadTitle') });
              const list = Array.isArray(picked) ? picked : (picked ? [picked] : []);
              if (list.length) await queueDroppedFiles(list);
            } catch (err) { notify.error(t('uploadTitle'), err.message); }
          },
        }],
      });
      return;
    }
    await queueDroppedFiles(paths);
  }

  async function queueDroppedFiles(paths) {
    const id = sessionId();
    if (isLocal) {
      notify.info(t('uploadTitle'), 'Drop files on the remote panel to upload them.');
      return;
    }
    if (!id) { notify.warning(t('notConnected'), ''); return; }
    try {
      await backend.queue('add', { sessionId: id, direction: 'upload', files: paths, target: path });
      notify.success(t('uploadTitle'), `${paths.length} ${paths.length === 1 ? 'item' : 'items'} → ${oneLine(path, 50)}`);
      refresh(true);
    } catch (err) { notify.error(t('uploadTitle'), err.message); }
  }

  /* ---- context menus ---- */

  registerContextMenu(viewport, (ctx) => {
    const row = ctx.target?.closest?.('.fp-row,.fp-tile');
    const over = { side, panel: handle, other: workspace ? workspace.other(side) : null };
    if (row) {
      const index = Number(row.dataset.index);
      const entry = view[index];
      if (entry && !selected.has(entry.name)) { focusIndex = index; render(); }
      return fileContextItems({ ...over, entry });
    }
    return panelContextItems(over);
  });

  /* ---- address bar ---- */

  addrInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); navigate(addrInput.value.trim()); }
    else if (e.key === 'Escape') { e.preventDefault(); addrInput.value = path; viewport.focus(); }
    else if (e.key === 'ArrowDown' && history.length) {
      e.preventDefault();
      import('./contextmenu.js').then(({ openMenu }) => {
        openMenu({
          anchor: addrInput, placement: 'bottom-start', label: t('goTo'),
          items: history.slice().reverse().slice(0, 20).map((p) => ({
            label: p, icon: 'history', onSelect: () => navigate(p),
          })),
        });
      });
    }
  });
  addrInput.addEventListener('focus', () => addrInput.select());

  /* ---- splitter ---- */

  let splitDrag = null;
  splitter.addEventListener('pointerdown', (e) => {
    splitDrag = { x: e.clientX, w: treeHost.getBoundingClientRect().width };
    splitter.setPointerCapture(e.pointerId);
  });
  splitter.addEventListener('pointermove', (e) => {
    if (!splitDrag) return;
    const next = Math.max(120, Math.min(520, splitDrag.w + (e.clientX - splitDrag.x)));
    treeHost.style.width = `${next}px`;
  });
  splitter.addEventListener('pointerup', () => {
    if (!splitDrag) return;
    splitDrag = null;
    writePref(
      isLocal ? 'scpCommander.localPanel.driveViewWidth' : 'scpCommander.remotePanel.driveViewWidth',
      Math.round(treeHost.getBoundingClientRect().width), 'Changed the tree width',
    );
  });
  splitter.addEventListener('keydown', (e) => {
    const w = treeHost.getBoundingClientRect().width;
    if (e.key === 'ArrowLeft') { e.preventDefault(); treeHost.style.width = `${Math.max(120, w - 16)}px`; }
    else if (e.key === 'ArrowRight') { e.preventDefault(); treeHost.style.width = `${Math.min(520, w + 16)}px`; }
  });

  /* ---- helpers used by the handle ---- */

  function parentPath() {
    return driveParentOf(side, path) || path;
  }

  function pathOf(entry) {
    if (!entry) return path;
    if (entry.name === '..') return parentPath();
    return driveJoinPath(side, path, entry.name);
  }

  function selectionPaths() {
    return selectionEntries().map(pathOf);
  }

  function selectionEntries() {
    if (selected.size) return view.filter((e) => selected.has(e.name));
    const f = view[focusIndex];
    return f && f.name !== '..' ? [f] : [];
  }

  function toggleFocusedSelection(index) {
    const i = index === undefined ? focusIndex : index;
    const entry = view[i];
    if (!entry || entry.name === '..') return false;
    if (selected.has(entry.name)) selected.delete(entry.name); else selected.add(entry.name);
    render();
    emitSelection();
    return true;
  }

  function rememberSelection() { lastSelected = new Set(selected); }

  function setActive() {
    if (workspace && workspace.activeSide() !== side) workspace.setActiveSide(side);
    root.classList.add('is-active');
    if (workspace) {
      const other = workspace.other(side);
      if (other && other.element) other.element.classList.remove('is-active');
    }
  }

  function navigate(target) {
    if (!target) return;
    const before = path;
    load(target).then(() => {
      if (workspace && typeof workspace.mirrorNavigation === 'function' && path !== before) {
        workspace.mirrorNavigation(side, path);
      }
    });
  }

  function refresh(force) { return load(path, { pushHistory: false, force: !!force }); }

  function revealName(name) {
    const i = view.findIndex((e) => e.name === name);
    if (i < 0) return false;
    focusIndex = i;
    selected = new Set([name]);
    render();
    scrollIntoView(i);
    emitSelection();
    return true;
  }

  /* ---- the handle ---- */

  const handle = {
    id: panelId,
    side,
    isLocal,
    element: root,
    // The address bar is built here but hosted by the path toolbar band, which
    // is where WinSCP puts it. The band asks for this node rather than querying
    // the panel's DOM, so it exists before the band is first rendered.
    addressElement: addrBar,
    columns,
    searchBar,

    path: () => path,
    pathOf,
    parentPath,
    entries: () => view,
    allEntries: () => rawEntries,
    isRoot: () => !driveParentOf(side, path),

    sessionInfo,
    caps: () => (sessionInfo() ? sessionInfo().caps : null),

    /* selection */
    selection: selectionEntries,
    selectedEntries: () => view.filter((e) => selected.has(e.name)),
    focusedEntry: () => view[focusIndex] || null,
    hasSelection: () => selected.size > 0 || !!(view[focusIndex] && view[focusIndex].name !== '..'),
    setSelection(entries) {
      rememberSelection();
      selected = new Set(entries.map((e) => (typeof e === 'string' ? e : e.name)).filter((n) => n !== '..'));
      render(); emitSelection();
    },
    selectAll() {
      rememberSelection();
      selected = new Set(view.filter((e) => e.name !== '..').map((e) => e.name));
      render(); emitSelection();
      announce(`${selected.size} ${t('selectAll')}`);
    },
    clearSelection() { rememberSelection(); selected = new Set(); render(); emitSelection(); },
    invertSelection() {
      rememberSelection();
      const next = new Set();
      for (const e of view) if (e.name !== '..' && !selected.has(e.name)) next.add(e.name);
      selected = next; render(); emitSelection();
    },
    canRestoreSelection: () => lastSelected.size > 0,
    restoreSelection() {
      const current = new Set(selected);
      selected = new Set(lastSelected);
      lastSelected = current;
      render(); emitSelection();
    },
    toggleFocusedSelection,
    async selectByMask(mask, on, o = {}) {
      rememberSelection();
      const match = compileMask(mask);
      let n = 0;
      for (const e of view) {
        if (e.name === '..') continue;
        if (e.type === 'dir' && o.includeDirs === false) continue;
        if (!match(e, pathOf(e))) continue;
        if (on) { if (!selected.has(e.name)) { selected.add(e.name); n += 1; } }
        else if (selected.delete(e.name)) n += 1;
      }
      render(); emitSelection();
      return n;
    },
    selectSameExtension(on) {
      const f = view[focusIndex];
      if (!f) return 0;
      const ext = extensionOf(f.name).toLowerCase();
      rememberSelection();
      let n = 0;
      for (const e of view) {
        if (e.name === '..' || e.type === 'dir') continue;
        if (extensionOf(e.name).toLowerCase() !== ext) continue;
        if (on) { if (!selected.has(e.name)) { selected.add(e.name); n += 1; } }
        else if (selected.delete(e.name)) n += 1;
      }
      render(); emitSelection();
      announce(`${n} ${on ? t('selectSameExt') : t('unselectSameExt')}`);
      return n;
    },

    /* navigation */
    navigate,
    refresh,
    goParent() { if (driveParentOf(side, path)) navigate(parentPath()); },
    goRoot() { navigate(isLocal ? (path.match(/^[a-zA-Z]:/) ? `${path.slice(0, 2)}\\` : '\\') : '/'); },
    goHome() {
      const info = sessionInfo();
      navigate(isLocal ? (readPref('scpCommander.localPanel.lastPath', '') || '.') : ((info && info.home) || '/'));
    },
    canGoBack: () => historyIndex > 0,
    canGoForward: () => historyIndex < history.length - 1,
    goBack() { if (historyIndex > 0) { historyIndex -= 1; load(history[historyIndex], { pushHistory: false }); } },
    goForward() { if (historyIndex < history.length - 1) { historyIndex += 1; load(history[historyIndex], { pushHistory: false }); } },
    history: () => history.slice(),
    revealName,
    focus() { viewport.focus(); },
    focusAddress() { addrInput.focus(); addrInput.select(); },
    startIncrementalSearch() { searchState.active = true; searchState.text = ''; viewport.focus(); bus.emit('panel:searchChanged', { side, ...searchState }); },
    incrementalSearch: () => ({ ...searchState }),

    /* presentation */
    viewStyle: () => viewStyle,
    setViewStyle(style) {
      if (!VIEW_STYLES.includes(style)) return false;
      viewStyle = style;
      writePref('panel.viewStyle', style, 'Changed the panel view style');
      header.element.hidden = style !== 'report';
      render();
      announce(`${t('view_')}: ${style}`);
      return true;
    },
    cycleViewStyle() {
      const i = VIEW_STYLES.indexOf(viewStyle);
      return handle.setViewStyle(VIEW_STYLES[(i + 1) % VIEW_STYLES.length]);
    },
    sortState: () => columns.sort,
    sortBy(key, ascending) { columns.setSort(key, ascending); applyView(); render(); },
    setSortAscending(asc) { columns.setAscending(asc); applyView(); render(); },
    showHidden: () => showHidden,
    setShowHidden(on) { showHidden = !!on; applyView(); render(); bus.emit('panel:entriesChanged', { side, count: view.length }); },
    filter: () => filterMask,
    setFilter(mask) {
      filterMask = String(mask || '');
      applyView(); render();
      bus.emit('panel:entriesChanged', { side, count: view.length });
      announce(filterMask ? `${t('filterActive')}: ${filterMask}` : t('reset'));
    },
    treeVisible: () => treeShown,
    setTreeVisible(on) {
      treeShown = !!on;
      treeHost.hidden = !treeShown;
      splitter.hidden = !treeShown;
      if (treeShown) { ensureTree(); tree?.setPath(path); }
      writePref(
        isLocal ? 'scpCommander.localPanel.driveView' : 'scpCommander.remotePanel.driveView',
        treeShown, `Changed the ${side} tree`,
      );
    },
    focusTree() { ensureTree(); tree?.focus(); },
    repaint() { applyView(); render(); },

    /* operations the commands need */
    beginRename,
    counts() {
      let size = 0;
      let selectedSize = 0;
      for (const e of view) {
        if (e.name === '..') continue;
        const s = e.type === 'dir' ? (e.calculatedSize || 0) : (e.size || 0);
        size += s;
        if (selected.has(e.name)) selectedSize += s;
      }
      return {
        files: view.filter((e) => e.name !== '..').length,
        size,
        selected: selected.size,
        selectedSize,
        hidden: hiddenCount,
        filtered: filteredCount,
      };
    },
    applySizes(result) {
      const list = Array.isArray(result) ? result : (result && result.sizes) || [];
      for (const item of list) {
        const name = String(item.path || '').split(/[\\/]/).pop();
        const entry = rawEntries.find((e) => e.name === name);
        if (entry) { entry.calculatedSize = item.size; sizeCache.set(`${path}\u0000${name}`, item.size); }
      }
      applyView(); render();
    },
    /** Local directory sizes: walked here, because main has no local walker. */
    async calculateSizes(dirs) {
      for (const dir of dirs) {
        const full = pathOf(dir);
        let total = 0;
        const stack = [full];
        let guard = 0;
        while (stack.length && guard < 20000) {
          guard += 1;
          const cur = stack.pop();
          try {
            const res = await backend.fs('localList', cur, {});
            for (const e of res.entries || []) {
              if (e.type === 'dir') stack.push(driveJoinPath('local', cur, e.name));
              else total += e.size || 0;
            }
          } catch { /* an unreadable directory contributes nothing */ }
        }
        dir.calculatedSize = total;
        sizeCache.set(`${path}\u0000${dir.name}`, total);
      }
      applyView(); render();
    },

    setActive,
    setInactive() { root.classList.remove('is-active'); },
    destroy() {
      header.destroy();
      searchBar.destroy();
      tree?.destroy();
      root.remove();
    },
  };

  header.element.hidden = viewStyle !== 'report';
  if (treeShown) ensureTree();
  load(defaultPath(), { pushHistory: true });

  const offPrefs = bus.on('prefs:changed', (e) => {
    if (!e) return;
    if (e.path === 'showHiddenFiles') { showHidden = e.value === true; applyView(); render(); }
    if (e.path === 'formatSizeBytes' || e.path === 'panel.fullRowSelect') render();
  });
  const baseDestroy = handle.destroy;
  handle.destroy = () => { offPrefs(); baseDestroy(); };

  return handle;
}

/* ================================================================== */
/* the workspace: Commander and Explorer                               */
/* ================================================================== */

/**
 * createWorkspace({ tab }) — the two-pane Commander or the single-pane
 * Explorer, with the menu bar, the toolbars, the command line and the two
 * status bars. One workspace lives in one tab.
 */
export function createWorkspace(opts = {}) {
  ensureStyle('winscp-panels', CSS);
  const tab = opts.tab || null;
  let mode = readPref('interface', 'commander');
  let activeSide = mode === 'explorer' ? 'remote' : 'local';
  let sessionInfoValue = (tab && tab.data && tab.data.sessionInfo) || null;
  const browsingSync = createBrowsingSync();

  const root = h('div', { class: 'wsp' });
  const topDock = h('div', {});
  const panelsHost = h('div', { class: 'wsp-panels' });
  const cmdInput = h('input', { type: 'text', spellcheck: 'false', 'aria-label': t('cmdLinePh'), placeholder: t('cmdLinePh') });
  const cmdPrompt = h('span', { class: 'mono' }, '$');
  const cmdLine = h('div', { class: 'wsp-cmdline', hidden: true }, cmdPrompt, cmdInput);
  root.append(topDock, panelsHost, cmdLine);
  appearanceTarget(root, 'workspace', 'File workspace');

  let panels = {};
  let statusBars = {};
  let docks = [];
  let menuBar = null;
  let toolbars = null;
  let splitDrag = null;

  const workspace = {
    element: root,
    /** The live menu bar, so Alt+letter can open a real menu. */
    get menuBar() { return menuBar; },
    interfaceMode: () => mode,
    setInterfaceMode(next) {
      if (next !== 'commander' && next !== 'explorer') return;
      if (next === mode) return;
      mode = next;
      writePref('interface', next, 'Changed the interface style');
      rebuild();
      bus.emit('panel:interfaceChanged', { mode });
    },
    activeSide: () => activeSide,
    setActiveSide(side) {
      if (mode === 'explorer') return;
      if (side !== 'local' && side !== 'remote') return;
      activeSide = side;
      for (const [s, p] of Object.entries(panels)) {
        if (s === side) p.element.classList.add('is-active'); else p.element.classList.remove('is-active');
      }
      bus.emit('panel:activeSideChanged', { side });
    },
    panel: (side) => panels[side] || null,
    other: (side) => panels[side === 'local' ? 'remote' : 'local'] || null,
    eachPanel(fn) { for (const p of Object.values(panels)) fn(p); },
    sessionInfo: () => sessionInfoValue,
    attachSession(info) {
      sessionInfoValue = info;
      if (tab) {
        tab.data = { ...(tab.data || {}), sessionInfo: info, siteId: info.siteId };
        const strip = appSession.get('strip');
        strip?.renameTab(tab.id, info.name || info.hostName || t('remoteTab'));
      }
      panels.remote?.navigate(info.remotePath || info.home || '/');
      bus.emit('panel:pathChanged', { side: 'remote' });
    },

    synchronizedBrowsing: () => browsingSync.enabled,
    setSynchronizedBrowsing(on) {
      if (on) {
        if (!panels.local || !panels.remote) {
          notify.warning(t('synchronizeBrowsing'), 'Synchronized browsing needs both panels, so it is only available in the Commander interface.');
          return false;
        }
        browsingSync.enable(panels.local.path(), panels.remote.path());
        notify.info(t('synchronizeBrowsing'), `${panels.local.path()} ↔ ${panels.remote.path()}`);
      } else {
        browsingSync.disable();
      }
      return browsingSync.enabled;
    },
    /** Called by a panel after it navigates; moves the other panel in step. */
    mirrorNavigation(side, newPath) {
      if (!browsingSync.enabled) return;
      const target = browsingSync.mirror(side, newPath);
      const other = workspace.other(side);
      if (!target || !other) {
        if (browsingSync.enabled) {
          notify.warning(t('synchronizeBrowsing'), `The other panel has no matching directory for ${oneLine(newPath, 50)}, so it stayed where it was.`);
        }
        return;
      }
      browsingSync.apply(() => other.navigate(target));
      browsingSync.reanchor(
        side === 'local' ? newPath : target,
        side === 'local' ? target : newPath,
      );
    },

    commandLineVisible: () => !cmdLine.hidden,
    setCommandLineVisible(on) {
      cmdLine.hidden = !on;
      writePref('scpCommander.commandLine', !!on, 'Changed the command line');
      if (on) cmdInput.focus();
      return !cmdLine.hidden;
    },
    focusCommandLine() { cmdLine.hidden = false; cmdInput.focus(); return true; },
    insertIntoCommandLine(text) {
      cmdLine.hidden = false;
      const at = cmdInput.selectionStart ?? cmdInput.value.length;
      cmdInput.value = `${cmdInput.value.slice(0, at)}${text}${cmdInput.value.slice(at)}`;
      cmdInput.focus();
      return true;
    },
    destroy() {
      menuBar?.destroy();
      toolbars?.destroy();
      Object.values(statusBars).forEach((s) => s.destroy());
      Object.values(panels).forEach((p) => p.destroy());
      root.remove();
    },
  };

  /* ---- the command line ---- */
  const cmdHistory = [];
  let cmdHistoryAt = -1;
  cmdInput.addEventListener('keydown', async (e) => {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (cmdHistory.length) { cmdHistoryAt = Math.max(0, cmdHistoryAt - 1); cmdInput.value = cmdHistory[cmdHistoryAt]; }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (cmdHistory.length) { cmdHistoryAt = Math.min(cmdHistory.length, cmdHistoryAt + 1); cmdInput.value = cmdHistory[cmdHistoryAt] || ''; }
      return;
    }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const line = cmdInput.value.trim();
    if (!line) return;
    cmdHistory.push(line);
    cmdHistoryAt = cmdHistory.length;
    cmdInput.value = '';
    const info = workspace.sessionInfo();
    const panel = workspace.panel(activeSide);
    try {
      if (activeSide === 'local' || !info) {
        const res = await backend.app('runCustomCommand', { command: line, local: true, cwd: panel?.path() });
        notify.info(t('cmdLinePh'), oneLine(res && res.output, 200) || `${t('ok')} (${line})`);
      } else {
        const res = await backend.session('exec', info.id, line, { cwd: panel?.path() });
        notify.info(t('cmdLinePh'), oneLine(res && res.output, 200) || `${t('ok')} (${line})`);
      }
      panel?.refresh(true);
    } catch (err) { notify.error(t('cmdLinePh'), err.message); }
  });

  /* ---- build ---- */

  function panelWidget(side) {
    return () => {
      const p = panels[side];
      return (p && p.addressElement) || h('span');
    };
  }

  function transferPresetWidget() {
    const sel = h('select', {
      class: 'field-input', 'aria-label': t('transferSettingsShort'),
      style: { minWidth: '140px' },
      onchange: () => writePref('copyParamCurrent', sel.value, 'Changed the transfer preset'),
    });
    const rebuildOptions = () => {
      clear(sel);
      sel.appendChild(h('option', { value: '' }, t('default_')));
      for (const preset of readPref('copyParamList', []) || []) {
        sel.appendChild(h('option', { value: preset.name }, preset.name));
      }
      sel.value = readPref('copyParamCurrent', '') || '';
    };
    rebuildOptions();
    bus.on('prefs:changed', (e) => { if (!e || /copyParam/.test(e.path)) rebuildOptions(); });
    return sel;
  }

  function rebuild() {
    Object.values(statusBars).forEach((s) => s.destroy());
    Object.values(panels).forEach((p) => p.destroy());
    menuBar?.destroy();
    toolbars?.destroy();
    panels = {};
    statusBars = {};
    const columnsBySide = {};
    clear(panelsHost);
    clear(topDock);

    toolbars = createToolbars({ workspace });
    menuBar = createMenuBar({
      interfaceMode: () => mode,
      ctxFor: () => ({ side: activeSide, panel: panels[activeSide], other: workspace.other(activeSide) }),
    });

    const sides = mode === 'explorer' ? ['remote'] : ['local', 'remote'];
    sides.forEach((side, i) => {
      if (i > 0) {
        const split = h('div', {
          class: 'wsp-split', role: 'separator', tabindex: '0',
          'aria-orientation': 'vertical', 'aria-label': t('swapPanels'),
        });
        split.addEventListener('pointerdown', (e) => {
          splitDrag = { x: e.clientX, w: panels.local.element.getBoundingClientRect().width };
          split.setPointerCapture(e.pointerId);
        });
        split.addEventListener('pointermove', (e) => {
          if (!splitDrag) return;
          const total = panelsHost.getBoundingClientRect().width || 1;
          const next = Math.max(160, Math.min(total - 160, splitDrag.w + (e.clientX - splitDrag.x)));
          panels.local.element.style.flex = `0 0 ${next}px`;
          panels.remote.element.style.flex = '1 1 0';
        });
        split.addEventListener('pointerup', () => {
          if (!splitDrag) return;
          splitDrag = null;
          const total = panelsHost.getBoundingClientRect().width || 1;
          writePref('scpCommander.localPanelWidth',
            panels.local.element.getBoundingClientRect().width / total, 'Changed the panel split');
        });
        split.addEventListener('keydown', (e) => {
          const cur = panels.local.element.getBoundingClientRect().width;
          if (e.key === 'ArrowLeft') { e.preventDefault(); panels.local.element.style.flex = `0 0 ${cur - 20}px`; }
          else if (e.key === 'ArrowRight') { e.preventDefault(); panels.local.element.style.flex = `0 0 ${cur + 20}px`; }
        });
        panelsHost.appendChild(split);
      }

      const panel = createFilePanel({ side, workspace, interfaceMode: mode });
      panels[side] = panel;

      const column = h('div', {
        class: 'fp-column',
        style: { display: 'flex', flexDirection: 'column', minWidth: '0', minHeight: '0', flex: '1 1 0' },
      });
      column.appendChild(panel.element);
      const status = createPanelStatusBar(panel);
      statusBars[side] = status;
      column.appendChild(status.element);
      panelsHost.appendChild(column);
      columnsBySide[side] = column;
    });

    // The docks are built AFTER the panels, because a path band hosts its
    // panel's address bar and must be able to ask for it on its first render.
    if (mode === 'commander') {
      for (const side of sides) {
        const dock = toolbars.createDock({
          id: side, side, label: `${side} toolbars`,
          widgets: { path: panelWidget(side) },
          ctxFor: () => ({ side, panel: panels[side], other: workspace.other(side) }),
        });
        if (side === 'local') localDock = dock; else remoteDock = dock;
        columnsBySide[side].prepend(dock.element);
      }
    }

    mainDock = toolbars.createDock({
      id: 'main',
      label: t('toolbars'),
      menuFactory: () => menuBar.element,
      widgets: {
        transferPreset: transferPresetWidget,
        path: mode === 'explorer' ? panelWidget('remote') : () => h('span'),
      },
      ctxFor: () => ({ side: activeSide, panel: panels[activeSide], other: workspace.other(activeSide) }),
    });
    topDock.appendChild(mainDock.element);

    if (mode === 'commander' && panels.local) {
      const saved = Number(readPref('scpCommander.localPanelWidth', 0.5)) || 0.5;
      panels.local.element.parentElement.style.flex = `0 0 ${Math.round(saved * 100)}%`;
      panels.remote.element.parentElement.style.flex = '1 1 0';
    }

    workspace.setActiveSide(mode === 'explorer' ? 'remote' : activeSide);
    cmdLine.hidden = readPref('scpCommander.commandLine', false) !== true;

    installCommands({ workspace, toolbars, strip: appSession.get('strip') });
  }

  rebuild();
  // Alt+L, Alt+R, Alt+F … open the menu they open in WinSCP. The disposer is
  // held by the workspace so a rebuilt or closed tab does not leave a listener
  // driving a menu bar that no longer exists.
  const disposeMnemonics = installMenuMnemonics(
    { open: (id) => menuBar && menuBar.open(id) },
    () => mode,
  );
  const workspaceDestroy = workspace.destroy;
  workspace.destroy = () => { disposeMnemonics(); workspaceDestroy(); };
  return workspace;
}

/* ================================================================== */
/* installation                                                        */
/* ================================================================== */

let installedShell = false;
const workspaces = new Map();       // tab key -> workspace

/**
 * Wire the panel layer into the shell. Called on import; it waits for
 * `shell:ready` so app.js's registries exist, and is safe to call twice.
 */
export async function installPanels() {
  if (installedShell) return;
  installedShell = true;
  ensureStyle('winscp-panels', CSS);

  const app = await import('../app.js');

  installCommands({
    registerShellCommand: app.registerCommand,
    openDialog: app.openDialog,
    strip: app.getStrip('main'),
    prefs: null,
  });

  app.setTabPanelRenderer((tab, panel) => {
    let ws = workspaces.get(tab.key);
    if (ws && !ws.element.isConnected) { ws.destroy(); ws = null; }
    if (!ws) {
      ws = createWorkspace({ tab });
      workspaces.set(tab.key, ws);
    }
    panel.appendChild(ws.element);
    installCommands({ workspace: ws, strip: app.getStrip('main') });
    appSession.set('workspace', ws);
  });

  // The active workspace follows the active tab, so a command always acts on
  // the panels the user is looking at.
  bus.on('tabs:activated', ({ tab }) => {
    const ws = workspaces.get(tab.key);
    if (ws) { installCommands({ workspace: ws }); appSession.set('workspace', ws); }
  });
  bus.on('tabs:closed', ({ tabId }) => {
    for (const [key, ws] of workspaces) {
      if (ws.element.closest(`[id="tabpanel-${tabId}"]`)) { ws.destroy(); workspaces.delete(key); }
    }
  });

  // The status items read the workspace through the session store, so they
  // follow the active tab rather than binding to whichever tab opened first.
  installSessionStatus({
    workspace: { panel: (side) => appSession.get('workspace')?.panel(side) || null },
    registerStatusItem: app.registerStatusItem,
    refreshStatus: app.refreshStatus,
  });
}

if (typeof document !== 'undefined') {
  if (appSession.get('strip')) installPanels();
  else bus.once('shell:ready', () => { installPanels(); });
}

export { VIEW_STYLES, services as commandServices };
