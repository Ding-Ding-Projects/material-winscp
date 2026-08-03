// ui/driveview.js — the local drive tree and the remote directory tree.
//
// WinSCP's TDriveView (local) and TUnixDriveView (remote) are one control with
// two data sources, and so is this: a lazily expanded `role="tree"` whose roots
// are the machine's drives on the local side and `/` on the remote side. The
// panel beside it drives the selection, and selecting a node navigates the
// panel — which is what makes "synchronized browsing" work: both trees follow
// their own panel, and the workspace keeps the two panels in step.
//
// Directories are read through the same fs bridge the panel uses, so a tree
// node and a panel row can never disagree about what is on the server.

import { h, icon, uid, appearanceTarget, announce, oneLine } from '../dom.js';
import { t } from '../i18n.js';
import { bus } from '../state.js';
import { registerContextMenu, SEPARATOR } from './contextmenu.js';
import { backend, runAction, actionLabel, readPref } from './commands.js';
import { naturalCompare } from './panelcolumns.js';

/* ------------------------------------------------------------------ */
/* path helpers                                                        */
/* ------------------------------------------------------------------ */

function sepFor(side) { return side === 'local' ? '\\' : '/'; }

function normalizeLocal(p) {
  let s = String(p || '').replace(/\//g, '\\');
  // Win32's long-path spellings are aliases, not additional tree roots. Keep
  // one canonical shape so an address-bar navigation can reveal the same UNC
  // share as a path returned by fs.localDrives/localList.
  if (/^\\\\[?.]\\UNC\\/i.test(s)) s = s.replace(/^\\\\[?.]\\UNC\\/i, '\\\\');
  else if (/^\\\\[?.]\\[A-Za-z]:/.test(s)) s = s.replace(/^\\\\[?.]\\/i, '');
  return s.replace(/\\+$/, (m, i) => (i <= 2 ? m : '')) || '';
}

/** The UNC server/share (or server) that owns a local tree path. */
function uncRootOf(p) {
  const s = normalizeLocal(p).replace(/\\+$/, '');
  const m = s.match(/^\\\\([^\\]+)(?:\\([^\\]+))?/);
  if (!m) return null;
  return `\\\\${m[1]}${m[2] ? `\\${m[2]}` : ''}`;
}

function parentOf(side, p) {
  if (side === 'local') {
    const s = normalizeLocal(p);
    if (/^[a-zA-Z]:\\?$/.test(s)) return null;
    const uncRoot = uncRootOf(s);
    if (uncRoot) {
      // A server/share is a root in the local tree. Returning `\\server`
      // here makes `..` leave a valid share and produces a path the shell may
      // not be able to enumerate.
      if (s.toLowerCase() === uncRoot.toLowerCase()) return null;
      const i = s.lastIndexOf('\\');
      return i <= uncRoot.length ? uncRoot : s.slice(0, i);
    }
    const i = s.lastIndexOf('\\');
    if (i < 0) return null;
    return i <= 2 ? s.slice(0, i + 1) : s.slice(0, i);
  }
  const s = String(p || '/').replace(/\/+$/, '') || '/';
  if (s === '/' || s === '') return null;
  const i = s.lastIndexOf('/');
  return i <= 0 ? '/' : s.slice(0, i);
}

function joinPath(side, dir, name) {
  if (side === 'local') {
    const base = normalizeLocal(dir);
    return /[\\]$/.test(base) ? `${base}${name}` : `${base}\\${name}`;
  }
  const base = String(dir || '/').replace(/\/+$/, '');
  return `${base}/${name}`;
}

/** The path segments from a root down to `path`, used to reveal a node. */
function chainTo(side, path) {
  const out = [];
  let cur = side === 'local' ? normalizeLocal(path) : String(path || '/');
  while (cur) {
    out.unshift(cur);
    const up = parentOf(side, cur);
    if (!up || up === cur) break;
    cur = up;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* the tree                                                            */
/* ------------------------------------------------------------------ */

/**
 * createDriveView({ side, sessionId(), hostName(), onNavigate(path), initialPath })
 *
 * Returns { element, setPath, refresh, focus, destroy, setSessionId }.
 * The caller owns placement and width; the panel owns navigation.
 */
export function createDriveView(opts = {}) {
  const side = opts.side === 'local' ? 'local' : 'remote';
  const treeId = uid('tree');
  const nodes = new Map();            // path -> { path, name, el, childrenEl, expanded, loaded, level }
  let currentPath = opts.initialPath || (side === 'local' ? '' : '/');
  let focusPath = null;
  let destroyed = false;

  const root = h('div', {
    class: `dv dv-${side}`, role: 'tree', id: treeId, tabindex: '0',
    'aria-label': side === 'local' ? t('localPanel') : t('remotePanel'),
  });
  appearanceTarget(root, `drive-tree-${side}`, `${side === 'local' ? 'Local drive' : 'Remote directory'} tree`);

  const status = h('div', { class: 'dv-status muted', role: 'status' });
  const wrap = h('div', { class: 'dv-wrap' }, root, status);

  function sessionId() {
    return typeof opts.sessionId === 'function' ? opts.sessionId() : opts.sessionId || null;
  }

  /** The host the remote tree is reading from, for the status line. */
  function hostName() {
    return (typeof opts.hostName === 'function' ? opts.hostName() : opts.hostName) || '';
  }

  /* ---- data ---- */

  async function listChildren(path) {
    const showHidden = readPref('showHiddenFiles', false) === true;
    if (side === 'local') {
      if (!path) {
        const drives = await backend.fs('localDrives');
        return drives.map((d) => ({ name: d.label || d.path, path: d.path, drive: true }));
      }
      const res = await backend.fs('localList', path, {});
      return (res.entries || [])
        .filter((e) => e.type === 'dir' && e.name !== '..' && (showHidden || !e.hidden))
        .sort((a, b) => naturalCompare(a.name, b.name))
        .map((e) => ({ name: e.name, path: joinPath(side, path, e.name) }));
    }
    const id = sessionId();
    if (!id) return [];
    const res = await backend.fs('list', id, path || '/', {});
    const entries = (res && res.entries) || res || [];
    return entries
      .filter((e) => (e.type === 'dir' || (e.isSymlink && e.type !== 'file')) && e.name !== '..' && e.name !== '.' && (showHidden || !e.hidden))
      .sort((a, b) => naturalCompare(a.name, b.name))
      .map((e) => ({ name: e.name, path: joinPath(side, path || '/', e.name), link: !!e.isSymlink }));
  }

  /* ---- rendering ---- */

  function makeNode(item, level) {
    const nodeId = uid('tnode');
    const childrenEl = h('div', { role: 'group', class: 'dv-children', hidden: true });
    const twisty = h('button', {
      type: 'button', class: 'dv-twisty icon-btn', tabindex: '-1',
      'aria-hidden': 'true',
      onclick: (e) => { e.stopPropagation(); toggle(item.path); },
    }, icon('chevron_right', 14));
    const labelEl = h('span', { class: 'dv-label ellipsis', title: item.path }, item.name);
    const row = h('div', {
      class: 'dv-row', role: 'treeitem', id: nodeId, tabindex: '-1',
      'aria-expanded': 'false', 'aria-level': String(level + 1),
      'data-path': item.path,
      style: { paddingInlineStart: `calc(${level} * 14px * var(--den, 1))` },
    }, twisty, icon(item.drive ? 'computer' : item.link ? 'open_in_new' : 'folder', 15), labelEl);

    row.addEventListener('click', () => { select(item.path, { navigate: true }); });
    row.addEventListener('dblclick', () => { toggle(item.path); });
    row.addEventListener('focus', () => { focusPath = item.path; });

    const el = h('div', { class: 'dv-node' }, row, childrenEl);
    const node = { ...item, el, row, childrenEl, twisty, expanded: false, loaded: false, level };
    nodes.set(item.path, node);
    return node;
  }

  async function loadInto(node, container) {
    try {
      // 'connecting' carries a {0} for the host; a bare call put a literal
      // "{0}" in the tree's status line. A local tree never dials anything.
      status.textContent = side === 'local' ? '' : t('connecting', hostName() || t('remotePanel'));
      const items = await listChildren(node ? node.path : '');
      status.textContent = '';
      while (container.firstChild) container.removeChild(container.firstChild);
      if (!items.length) {
        container.appendChild(h('div', { class: 'dv-empty muted' }, t('emptyDir')));
        return;
      }
      for (const it of items) container.appendChild(makeNode(it, node ? node.level + 1 : 0).el);
    } catch (err) {
      status.textContent = err.message;
      while (container.firstChild) container.removeChild(container.firstChild);
      container.appendChild(h('div', { class: 'dv-empty' }, oneLine(err.message, 90)));
    }
  }

  async function expand(path) {
    const node = nodes.get(path);
    if (!node || node.expanded) return;
    node.expanded = true;
    node.row.setAttribute('aria-expanded', 'true');
    node.el.classList.add('is-open');
    node.childrenEl.hidden = false;
    if (!node.loaded) {
      node.loaded = true;
      await loadInto(node, node.childrenEl);
    }
  }

  function collapse(path) {
    const node = nodes.get(path);
    if (!node || !node.expanded) return;
    node.expanded = false;
    node.row.setAttribute('aria-expanded', 'false');
    node.el.classList.remove('is-open');
    node.childrenEl.hidden = true;
  }

  function toggle(path) {
    const node = nodes.get(path);
    if (!node) return;
    if (node.expanded) collapse(path); else expand(path);
  }

  function markSelected(path) {
    for (const node of nodes.values()) {
      const on = node.path === path;
      node.row.classList.toggle('is-current', on);
      node.row.setAttribute('aria-selected', String(on));
      if (on) root.setAttribute('aria-activedescendant', node.row.id);
    }
  }

  function select(path, { navigate = false, reveal = true } = {}) {
    currentPath = path;
    markSelected(path);
    if (reveal) nodes.get(path)?.row.scrollIntoView({ block: 'nearest' });
    if (navigate) opts.onNavigate?.(path);
  }

  /**
   * Reveal a path, expanding every ancestor. This is how the tree follows the
   * panel — including a path the tree has never loaded before.
   */
  async function setPath(path, { navigate = false } = {}) {
    if (destroyed) return;
    const target = side === 'local' ? normalizeLocal(path) : String(path || '/');
    if (!target) return;
    const chain = chainTo(side, target);
    for (const step of chain) {
      if (!nodes.has(step)) {
        // The ancestor is not rendered yet: expand its parent and try again.
        const up = parentOf(side, step);
        if (up && nodes.has(up)) await expand(up);
        else if (!up) await refresh();
      }
      if (nodes.has(step) && step !== target) await expand(step);
    }
    if (nodes.has(target)) select(target, { navigate });
    else currentPath = target;
  }

  async function refresh() {
    nodes.clear();
    await loadInto(null, root);
    // The OS drive list is necessarily finite and often omits a UNC share.
    // If the panel is already inside one, add a temporary root so setPath can
    // expand it and keep the tree synchronized with the address bar.
    if (side === 'local') {
      const uncRoot = uncRootOf(currentPath);
      if (uncRoot && !nodes.has(uncRoot)) {
        root.appendChild(makeNode({ name: uncRoot, path: uncRoot, drive: true }, 0).el);
      }
    }
    if (currentPath) await setPath(currentPath);
  }

  /* ---- keyboard: one tab stop, arrow keys inside ---- */

  function visibleRows() {
    return Array.from(root.querySelectorAll('.dv-row')).filter((r) => r.offsetParent !== null || r.getClientRects().length);
  }

  root.addEventListener('keydown', async (e) => {
    const rows = visibleRows();
    if (!rows.length) return;
    const cur = rows.findIndex((r) => r.dataset.path === (focusPath || currentPath));
    const at = cur < 0 ? 0 : cur;
    if (e.key === 'ArrowDown') { e.preventDefault(); rows[Math.min(at + 1, rows.length - 1)].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); rows[Math.max(at - 1, 0)].focus(); }
    else if (e.key === 'Home') { e.preventDefault(); rows[0].focus(); }
    else if (e.key === 'End') { e.preventDefault(); rows[rows.length - 1].focus(); }
    else if (e.key === 'ArrowRight') {
      e.preventDefault();
      const p = rows[at].dataset.path;
      const node = nodes.get(p);
      if (node && !node.expanded) await expand(p);
      else { const next = rows[at + 1]; if (next) next.focus(); }
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      const p = rows[at].dataset.path;
      const node = nodes.get(p);
      if (node && node.expanded) collapse(p);
      else {
        const up = parentOf(side, p);
        const upRow = up && rows.find((r) => r.dataset.path === up);
        if (upRow) upRow.focus();
      }
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      select(rows[at].dataset.path, { navigate: true });
    } else if (e.key === 'F5') {
      e.preventDefault();
      const node = nodes.get(rows[at].dataset.path);
      if (node) { node.loaded = false; if (node.expanded) { collapse(node.path); await expand(node.path); } }
    }
  });

  root.addEventListener('focus', () => {
    if (!root.querySelector('.dv-row:focus')) {
      const row = root.querySelector('.dv-row.is-current') || root.querySelector('.dv-row');
      row?.focus();
    }
  });

  /* ---- context menu: the same commands the menu bar uses ---- */

  const REFRESH = side === 'local' ? 'LocalRefreshAction' : 'RemoteRefreshAction';
  const NEWDIR = side === 'local' ? 'LocalCreateDirAction3' : 'RemoteCreateDirAction3';
  const TREE = side === 'local' ? 'LocalTreeAction' : 'RemoteTreeAction';

  registerContextMenu(wrap, (ctx) => {
    const row = ctx.target?.closest?.('.dv-row');
    const path = row ? row.dataset.path : currentPath;
    return [
      { label: t('goTo'), icon: 'chevron_right', onSelect: () => select(path, { navigate: true }) },
      { label: actionLabel(REFRESH), icon: 'refresh', onSelect: () => { const n = nodes.get(path); if (n) { n.loaded = false; collapse(path); expand(path); } runAction(REFRESH, { side }); } },
      SEPARATOR,
      { label: actionLabel(NEWDIR), icon: 'folder', onSelect: () => runAction(NEWDIR, { side }) },
      { label: t('copyPathClip'), icon: 'content_copy', onSelect: () => navigator.clipboard?.writeText?.(path).catch(() => {}) },
      SEPARATOR,
      { label: actionLabel(TREE), icon: 'group_work', checked: true, onSelect: () => runAction(TREE, { side }) },
    ];
  });

  const offHidden = bus.on('prefs:changed', (e) => {
    if (e && e.path === 'showHiddenFiles') refresh();
  });

  refresh();

  return {
    element: wrap,
    side,
    get path() { return currentPath; },
    setPath,
    refresh,
    focus() { root.focus(); },
    setSessionId(id) { opts.sessionId = () => id; refresh(); },
    announcePath() { announce(`${side === 'local' ? t('localPanel') : t('remotePanel')}: ${currentPath}`); },
    destroy() {
      destroyed = true;
      offHidden();
      nodes.clear();
      wrap.remove();
    },
  };
}

/* ------------------------------------------------------------------ */
/* synchronized browsing                                               */
/* ------------------------------------------------------------------ */

/**
 * WinSCP's "Synchronize Browsing": entering a directory on one side enters the
 * same-named directory on the other. It works on the *relative* move rather
 * than the absolute path, so two trees with different roots stay in step, and
 * it refuses (loudly) when the other side has no matching directory rather
 * than silently going somewhere else.
 */
export function createBrowsingSync(opts = {}) {
  let enabled = false;
  let anchors = null;         // { local, remote } — the paths where sync started
  let applying = false;

  function normalize(side, p) { return side === 'local' ? normalizeLocal(p) : String(p || '/').replace(/\/+$/, '') || '/'; }

  function relative(side, from, to) {
    const a = normalize(side, from);
    const b = normalize(side, to);
    if (!a || !b) return null;
    if (b.toLowerCase() === a.toLowerCase()) return [];
    const sep = side === 'local' ? /\\+/ : /\/+/;
    const ap = a.split(sep).filter(Boolean);
    const bp = b.split(sep).filter(Boolean);
    // Only a move *inside* the anchor can be mirrored; anything else would be
    // guesswork, and guessing is how a user ends up deleting the wrong tree.
    if (bp.length < ap.length) {
      const up = ap.length - bp.length;
      for (let i = 0; i < bp.length; i += 1) if (bp[i].toLowerCase() !== ap[i].toLowerCase()) return null;
      return { up };
    }
    for (let i = 0; i < ap.length; i += 1) if (bp[i].toLowerCase() !== ap[i].toLowerCase()) return null;
    return { down: bp.slice(ap.length) };
  }

  return {
    get enabled() { return enabled; },
    /** Turn sync on, anchoring both panels at their current directories. */
    enable(localPath, remotePath) {
      enabled = true;
      anchors = { local: normalize('local', localPath), remote: normalize('remote', remotePath) };
      return anchors;
    },
    disable() { enabled = false; anchors = null; },
    /** The other side's path for a move on `side`, or null when it cannot follow. */
    mirror(side, newPath) {
      if (!enabled || !anchors || applying) return null;
      const rel = relative(side, anchors[side], newPath);
      if (!rel) return null;
      const otherSide = side === 'local' ? 'remote' : 'local';
      let target = anchors[otherSide];
      if (rel.up) {
        for (let i = 0; i < rel.up; i += 1) {
          const up = parentOf(otherSide, target);
          if (!up) return null;
          target = up;
        }
      } else if (rel.down) {
        for (const seg of rel.down) target = joinPath(otherSide, target, seg);
      }
      return target;
    },
    /** Guard so applying the mirror does not mirror back and loop forever. */
    apply(fn) {
      applying = true;
      try { return fn(); } finally { applying = false; }
    },
    reanchor(localPath, remotePath) {
      if (!enabled) return;
      anchors = { local: normalize('local', localPath), remote: normalize('remote', remotePath) };
    },
  };
}

export { parentOf as driveParentOf, joinPath as driveJoinPath, normalizeLocal, uncRootOf };
