// ui/commands.js — the command layer.
//
// Every one of the 301 actions extracted from WinSCP's NonVisual.dfm resolves
// to exactly one handler here. Menus, toolbars, context menus, keyboard
// shortcuts and the panels all go through this registry, so there is one
// implementation per action and no surface can drift from another.
//
// Why this module has no DOM at import time
// -----------------------------------------
// It imports only actions.js, i18n.js, state.js, dom.js and notifications.js —
// all of which are safe to load in Node — so test/commands.test.js can import
// it headless and assert that every action is bound. Anything that needs a
// live panel, tab strip or toolbar comes in through installCommands(services);
// a command whose service is missing reports that plainly instead of pretending
// it ran.
//
// Contract
// --------
//   installCommands(services)    wire the live UI in (idempotent, additive)
//   getCommand(name)             the descriptor for a WinSCP action name
//   commandState(name, over)     { enabled, visible, checked, reason }
//   runAction(name, over)        resolve the side, build the context, run it
//   commandCoverage()            the honest ledger: bound / unavailable / missing
//   shortcutConflicts()          shortcuts claimed by more than one same-side action
//   registerActionDialog(n, fn)  let ui/dialogs.js take over an action's dialog
//
// Side resolution
// ---------------
// WinSCP names carry the side: Local* acts on the local panel, Remote* on the
// remote one, Current* on whichever panel has focus, and a plain action follows
// the focused panel too. *Focused* variants act on the item under the cursor
// rather than the selection — the difference matters when a user right-clicks a
// row without selecting it.

import { ACTIONS, ACTIONS_BY_NAME } from '../actions.js';
import { t, defineStrings } from '../i18n.js';
import { bus, api, session as appSession, store } from '../state.js';
import { h, icon, openModal, copyText, announce, oneLine, downloadText } from '../dom.js';
import { notify } from './notifications.js';

/* ================================================================== */
/* strings this module owns                                            */
/* ================================================================== */

// design/winscp-i18n.js carries the shared dictionary; the sentences below are
// this module's own, so they get all three language modes rather than staying
// English wherever the user set the language. Keys carry a `cm` prefix so two
// modules cannot collide, and every fact in them is a parameter — a path, a
// count, a protocol name — so no level of either slider can move it.
defineStrings({
  cmNoTarget: [
    'There is no target directory for this transfer. Open the other panel on the directory you want first.',
    '呢個傳輸冇目標目錄。 先喺另一邊面板揀定你要嘅目錄。',
  ],
  cmNeedSession: [
    'A transfer needs a connected session. Open a site first.',
    '要傳輸就要有連住嘅工作階段。 先開個站台啦。',
  ],
  cmQueued: ['{0} item(s) → {1}', '{0} 個項目 → {1}'],
  // The foreground path's own three sentences. It is a different operation from
  // a queued one — it finishes before the command returns — so it says so
  // rather than borrowing the queue's wording and reading as a queued item that
  // never appears in the queue.
  cmTransferring: ['{0} item(s) → {1}', '{0} 個項目 → {1}'],
  cmTransferred: ['{0} item(s) transferred to {1}.', '傳咗 {0} 個項目去 {1}。'],
  cmTransferIncomplete: [
    'The transfer did not finish: it was cancelled, or an error was not recovered from. Check what actually arrived at {0} before deleting anything.',
    '個傳輸未做完： 唔係俾人取消咗，就係有錯冇補救到。 刪任何嘢之前，請先去 {0} 睇實際到咗啲乜。',
  ],
  cmSelectedCount: ['{0} item(s) selected.', '揀咗 {0} 個項目。'],
  cmUnselectedCount: ['{0} item(s) unselected.', '取消揀咗 {0} 個項目。'],
  cmLocalCalc: [
    'Local directory sizes are calculated by the panel as it walks the tree.',
    '本機目錄大細係面板行完成棵樹先計得出。',
  ],
  cmDirCount: ['{0} directory/directories', '{0} 個目錄'],
  cmNameCount: ['{0} name(s)', '{0} 個名'],
  cmClipboardRefused: ['The clipboard refused the write.', '剪貼簿唔畀寫入。'],
  cmNoCommandLine: [
    'The command line is not shown. Turn it on from View → Command Line first.',
    '而家冇顯示指令列。 先由「檢視 → 指令列」開返佢。',
  ],
  cmClipboardEmpty: ['The clipboard has no text to paste.', '剪貼簿冇文字可以貼。'],
  cmClipboardNoFiles: ['The clipboard has no file list.', '剪貼簿冇檔案清單。'],
  cmNotAPublicKey: [
    'That file does not look like an OpenSSH public key (it must start with ssh-rsa, ssh-ed25519 or similar).',
    '嗰個檔案唔似 OpenSSH 公鑰（要以 ssh-rsa、ssh-ed25519 之類開頭）。',
  ],
  cmKeyAlreadyThere: ['That key is already installed.', '嗰條鎖匙已經裝咗。'],
  cmNoQueuePanel: [
    'The queue panel is not shown. Turn it on from View → Queue.',
    '而家冇顯示佇列面板。 由「檢視 → 佇列」開返佢。',
  ],
  cmNoPanelYet: ['There is no file panel in this tab yet.', '呢個分頁重未有檔案面板。'],
  cmNotApplicable: ['This command does not apply here right now.', '呢個指令而家喺呢度用唔到。'],
  cmNoRights: ['{0} does not expose file permissions.', '{0} 冇提供檔案權限。'],
  cmNoOwner: ['{0} does not expose file ownership.', '{0} 冇提供檔案擁有者。'],
  cmNoSymlink: ['{0} does not support links.', '{0} 唔支援連結。'],
});

/* ================================================================== */
/* services                                                            */
/* ================================================================== */

/**
 * Everything the command layer needs from the rest of the UI. panels.js fills
 * `workspace`, app.js's registries arrive through `registerShellCommand`, and
 * toolbars/statusbar/tabs register themselves as they are built. A command
 * whose service is absent reports the absence rather than failing silently.
 */
export const services = {
  workspace: null,          // panels.js — the two-pane / single-pane host
  strip: null,              // ui/tabs.js — the session tab strip
  toolbars: null,           // ui/toolbars.js — band visibility and options
  statusbar: null,          // ui/statusbar.js
  queuePanel: null,         // ui/queue.js, when it lands
  openDialog: null,         // app.js registerDialog/openDialog surface
  registerShellCommand: null,
  prefs: null,              // preference reader/writer (panels.js supplies one)
};

let installed = false;

// Electron's native menu emits these command ids over event:command. Route
// the complete Session menu into the same action registry as the Material
// menus and toolbars so its accelerators cannot become a second, inert UI.
const MAIN_SESSION_ACTIONS = Object.freeze({
  'session.new': 'SiteManagerAction',
  'session.sites': 'SiteManagerAction',
  'session.newTab': 'NewTabAction',
  'session.duplicate': 'DuplicateTabAction',
  'session.close': 'CloseTabAction',
  'session.saveSite': 'SaveCurrentSessionAction2',
  'session.generateUrl': 'SessionGenerateUrlAction2',
  'session.saveWorkspace': 'SaveWorkspaceAction',
  'session.openWorkspace': 'WorkspacesAction',
  'session.reconnect': 'ReconnectSessionAction',
  'session.disconnect': 'DisconnectSessionAction',
  'session.fsInfo': 'FileSystemInfoAction',
  'session.changePassword': 'ChangePasswordAction',
  'options.preferences': 'PreferencesAction',
});

function installMainCommandHandler() {
  return backend.on('event:command', (payload) => {
    if (!payload || payload.type !== 'menu') return;
    const action = MAIN_SESSION_ACTIONS[payload.command];
    if (action) runAction(action);
  });
}

/**
 * Wire the live UI into the command layer. Safe to call more than once and
 * from more than one module — later calls merge, they do not replace.
 */
export function installCommands(patch = {}) {
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined && v !== null) services[k] = v;
  }
  if (!installed) {
    installed = true;
    reportShortcutConflicts();
    if (typeof window !== 'undefined') {
      installShortcutHandler();
      installMainCommandHandler();
    }
  }
  publishToShell();
  return services;
}

/** ui/dialogs.js calls this to take over an action's dialog. */
const dialogOverrides = new Map();
export function registerActionDialog(actionName, opener) {
  if (typeof opener !== 'function') throw new Error('registerActionDialog needs a function');
  dialogOverrides.set(actionName, opener);
  return () => dialogOverrides.delete(actionName);
}

/* ================================================================== */
/* the bridge to main                                                  */
/* ================================================================== */

/**
 * Access to the preload bridge, in one place. `api.raw` is state.js's own
 * escape hatch; going through it here keeps the "no preload" path — a plain
 * browser preview — reporting one honest message instead of throwing in a
 * dozen call sites.
 */
export const backend = {
  get present() { return !!api.raw; },
  get reason() {
    return 'This window has no connection to the application process, so file operations are not available here.';
  },
  ns(name) {
    const raw = api.raw;
    if (!raw || !raw[name]) throw new Error(backend.reason);
    return raw[name];
  },
  async call(nsName, fn, ...args) {
    const ns = backend.ns(nsName);
    if (typeof ns[fn] !== 'function') throw new Error(`The application process does not expose ${nsName}.${fn}().`);
    const res = await ns[fn](...args);
    return unwrap(res);
  },
  fs(fn, ...a) { return backend.call('fs', fn, ...a); },
  /** design/main/explorershell.js — the orchestration decisions. */
  explorer(fn, ...a) { return backend.call('explorer', fn, ...a); },
  session(fn, ...a) { return backend.call('session', fn, ...a); },
  queue(fn, ...a) { return backend.call('queue', fn, ...a); },
  /**
   * design/main/transfer.js — the FOREGROUND path, TTerminal::CopyToRemote and
   * CopyToLocal. `queue` above is the background one; the difference a user can
   * see is that a call through here does not come back until every byte has
   * moved, which is exactly what WinSCP's *NonQueueAction commands do.
   */
  transfer(fn, ...a) { return backend.call('transfer', fn, ...a); },
  sync(fn, ...a) { return backend.call('sync', fn, ...a); },
  editor(fn, ...a) { return backend.call('editor', fn, ...a); },
  config(fn, ...a) { return backend.call('config', fn, ...a); },
  app(fn, ...a) { return backend.call('app', fn, ...a); },
  /** Subscribe to a main-process event; returns unsubscribe. */
  on(event, handler) {
    const raw = api.raw;
    if (!raw || typeof raw.on !== 'function') return () => {};
    try { return raw.on(event, handler) || (() => {}); }
    catch { return () => {}; }
  },
};

/**
 * A managed stylesheet for one module. Every panel-layer module ships its own
 * component CSS this way because styles/components.css is another agent's
 * file; `style-src 'unsafe-inline'` in index.html is what permits it, and the
 * id keeps a second import from adding a second copy.
 */
export function ensureStyle(id, css) {
  if (typeof document === 'undefined') return null;
  let el = document.getElementById(id);
  if (el) return el;
  el = document.createElement('style');
  el.id = id;
  el.textContent = css;
  document.head.appendChild(el);
  return el;
}

function unwrap(res) {
  if (res == null) return null;
  if (typeof res === 'object' && 'ok' in res) {
    if (res.ok) return res.value;
    const e = res.error;
    const err = new Error((e && e.message) || String(e) || 'The operation failed.');
    if (e && e.code) err.code = e.code;
    throw err;
  }
  return res;
}

/* ================================================================== */
/* small real modals                                                   */
/* ================================================================== */
// These are the command layer's own dialogs. They are deliberately modest —
// one decision each — and every one of them actually performs the operation.
// ui/dialogs.js can replace any of them through registerActionDialog() without
// this file changing, so there is still one implementation per action.

/** A text prompt. Resolves to the string, or null when cancelled. */
export function promptText(opts = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const input = h('input', {
      type: opts.password ? 'password' : 'text', class: 'field-input',
      value: opts.value || '', spellcheck: 'false', autocomplete: 'off',
      placeholder: opts.placeholder || '',
    });
    const extra = opts.extra || null;
    const modal = openModal({
      title: opts.title || t('ok'),
      width: opts.width || 520,
      content: h('div', { class: 'stack' },
        opts.body ? h('p', { class: 'prose' }, opts.body) : null,
        h('label', { class: 'field' },
          h('span', { class: 'field-label' }, opts.label || t('name')),
          input),
        extra),
      actions: [
        { label: t('cancel'), kind: 'text', onSelect: () => finish(null) },
        {
          label: opts.confirmLabel || t('ok'),
          kind: opts.danger ? 'danger' : 'filled',
          onSelect: () => finish(input.value),
        },
      ],
      onClose: () => finish(null),
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(input.value); modal.close('enter'); }
    });
    requestAnimationFrame(() => { input.focus(); input.select(); });
  });
}

/** A yes/no decision. Modal on purpose: the user must choose to continue. */
export function confirm(opts = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    openModal({
      title: opts.title || t('ok'),
      width: opts.width || 480,
      content: h('div', { class: 'stack' },
        h('p', { class: 'prose' }, opts.body || ''),
        opts.detail ? h('p', { class: 'prose muted' }, opts.detail) : null,
        opts.extra || null),
      actions: [
        { label: opts.cancelLabel || t('cancel'), kind: 'text', onSelect: () => finish(false) },
        {
          label: opts.confirmLabel || t('ok'),
          kind: opts.danger ? 'danger' : 'filled', autofocus: true,
          onSelect: () => finish(true),
        },
      ],
      onClose: () => finish(false),
    });
  });
}

/** A read-only text surface with copy/export — used for URLs, info and logs. */
export function showText(opts = {}) {
  const area = h('textarea', {
    class: 'field-input mono', readonly: true, rows: String(opts.rows || 10),
    spellcheck: 'false', 'aria-label': opts.title || t('copyClip'),
    style: { width: '100%', resize: 'vertical' },
  });
  area.value = String(opts.text ?? '');
  return openModal({
    title: opts.title || '',
    width: opts.width || 640,
    content: h('div', { class: 'stack' },
      opts.body ? h('p', { class: 'prose' }, opts.body) : null, area),
    actions: [
      {
        label: t('copyClip'), kind: 'text',
        onSelect: () => { copyText(area.value).then((ok) => { if (ok) notify.success(t('copiedClip'), oneLine(area.value, 80)); }); return true; },
      },
      opts.fileName ? {
        label: t('export_'), kind: 'text',
        onSelect: () => { downloadText(opts.fileName, area.value, 'text/plain'); return true; },
      } : null,
      { label: t('close'), kind: 'filled', autofocus: true },
    ].filter(Boolean),
  });
}

/** A single-choice list. Resolves to the chosen item's value, or null. */
export function chooseFrom(opts = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const items = opts.items || [];
    const list = h('div', { class: 'stack', role: 'listbox', 'aria-label': opts.title || '' });
    let current = items.length ? items[0].value : null;
    const rows = items.map((it) => {
      const row = h('button', {
        type: 'button', class: 'btn-text', role: 'option',
        style: { justifyContent: 'flex-start', width: '100%' },
        'aria-selected': String(it.value === current),
        onclick: () => { finish(it.value); modal.close('choice'); },
      }, it.icon ? icon(it.icon, 16) : null, h('span', {}, it.label),
      it.detail ? h('span', { class: 'muted' }, it.detail) : null);
      list.appendChild(row);
      return row;
    });
    const modal = openModal({
      title: opts.title || '',
      width: opts.width || 520,
      content: h('div', { class: 'stack' },
        opts.body ? h('p', { class: 'prose' }, opts.body) : null,
        items.length ? list : h('p', { class: 'prose muted' }, opts.empty || t('noMatches'))),
      actions: [{ label: t('cancel'), kind: 'text', onSelect: () => finish(null) }],
      onClose: () => finish(null),
    });
    requestAnimationFrame(() => rows[0]?.focus());
  });
}

/* ================================================================== */
/* context                                                             */
/* ================================================================== */

const LOCAL_CAPS = {
  rights: false, owner: false, symlink: true, hardlink: false, exec: false,
  resume: true, timestamp: true, recycleBin: true, checksum: false, find: true,
  rename: true, move: true, copyRemote: true, calculateSize: true,
  nativeMove: true, hiddenFiles: true, spaceInfo: false,
};

/** The side a command acts on, given its WinSCP name and the caller's context. */
export function resolveSide(cmd, over = {}) {
  if (over.side === 'local' || over.side === 'remote') return over.side;
  if (cmd && (cmd.side === 'local' || cmd.side === 'remote')) return cmd.side;
  const ws = services.workspace;
  if (ws && typeof ws.activeSide === 'function') return ws.activeSide();
  return 'remote';
}

/**
 * Build the invocation context. Everything a handler needs is on it, already
 * resolved, so no handler repeats the "which panel is this?" question.
 */
export function makeContext(cmd, over = {}) {
  const ws = services.workspace;
  const side = resolveSide(cmd, over);
  const panel = over.panel || (ws && typeof ws.panel === 'function' ? ws.panel(side) : null);
  const other = over.other || (ws && typeof ws.other === 'function' ? ws.other(side) : null);
  const isLocal = side === 'local';
  const info = panel && typeof panel.sessionInfo === 'function' ? panel.sessionInfo() : null;
  const caps = isLocal ? LOCAL_CAPS : (info && info.caps) || null;
  const focused = cmd && cmd.focused
    ? (over.entry || (panel && panel.focusedEntry ? panel.focusedEntry() : null))
    : null;
  const selection = cmd && cmd.focused
    ? (focused ? [focused] : [])
    : (over.selection || (panel && panel.selection ? panel.selection() : []));
  return {
    ...over,
    action: cmd ? cmd.action : null,
    name: cmd ? cmd.name : over.name,
    side,
    isLocal,
    panel,
    other,
    workspace: ws,
    strip: services.strip || appSession.get('strip') || null,
    sessionInfo: info,
    sessionId: info ? info.id : null,
    connected: isLocal ? true : !!(info && info.connected),
    caps,
    selection,
    focused,
  };
}

/* ---- reusable predicates ---- */

const havePanel = (c) => !!c.panel;
const haveSel = (c) => !!c.panel && c.selection.length > 0;
const haveFocus = (c) => !!c.panel && !!(c.focused || (c.panel.focusedEntry && c.panel.focusedEntry()));
const online = (c) => c.isLocal || c.connected;
const cap = (name) => (c) => !!(c.caps && c.caps[name]);
const bothPanels = (c) => !!c.panel && !!c.other;
// CustomScpExplorer has one remote panel by design. Its transfer dialog asks
// for the local destination, so remote downloads do not need Commander’s
// second panel in order to be a real, reachable operation.
const transferPanels = (c) => bothPanels(c)
  || (c.side === 'remote' && services.workspace?.interfaceMode?.() === 'explorer');

function selPaths(ctx) {
  const p = ctx.panel;
  if (!p) return [];
  return ctx.selection.filter((e) => e && e.name !== '..').map((e) => p.pathOf(e));
}

function selNames(ctx) {
  return ctx.selection.filter((e) => e && e.name !== '..').map((e) => e.name);
}

/* ================================================================== */
/* shared operations                                                   */
/* ================================================================== */

function fail(err, what) {
  const msg = err && err.message ? err.message : String(err);
  notify.error(what || t('featureSim'), msg);
  return null;
}

/** Refresh a panel and, when the operation crossed panels, the other one too. */
function afterWrite(ctx, alsoOther) {
  ctx.panel?.refresh(true);
  if (alsoOther) ctx.other?.refresh(true);
}

/** The transfer target for a side: the *other* panel's current directory. */
function transferTarget(ctx) {
  return ctx.other ? ctx.other.path() : '';
}

/**
 * cpDelete, from main/transfer.js's COPY_FLAGS. The queue has no move flag and
 * deletes the source from out here once its item reports `done`; the foreground
 * engine does it itself, inside TTerminal::UpdateSource, so it takes the flag.
 */
const CP_DELETE = 0x01;

/**
 * Transfer. `direction` is upload (local -> remote), download (remote -> local)
 * or remote-copy (server side). `move` deletes each source once it has
 * genuinely finished — WinSCP's "and Delete" commands.
 *
 * `queue` is TTransferOperationParam::Queue — 'auto', 'on' or 'off'. WinSCP
 * branches on the final CopyParam.Queue in ExecuteCopyMoveFileOperation
 * (CustomScpExplorer.cpp:1337): true adds a queue item, false calls
 * TTerminal::CopyToRemote right there and blocks until it is done. 'off' is
 * therefore not a variation on queueing, it is the other path entirely — and it
 * is what the four *NonQueueAction commands exist to reach.
 */
export async function queueTransfer(ctx, {
  direction, move = false, background = false, queue = 'auto', target, copyParam, files,
}) {
  const list = files || selPaths(ctx);
  if (!list.length) { notify.warning(t('nothingSelected'), t('selectFiles')); return null; }
  const dest = target || transferTarget(ctx);
  if (!dest) {
    notify.error(t('transferSettingsShort'), t('cmNoTarget'));
    return null;
  }
  const sessionId = ctx.sessionId;
  if (!sessionId) {
    notify.error(t('notConnected'), t('cmNeedSession'));
    return null;
  }
  // The named transfer preset the panel's dropdown writes is applied here, so
  // choosing one genuinely changes what is transferred rather than only being
  // remembered. The dialog's own fields still win — they are what the user just
  // typed — and anything neither of them sets falls through to main's defaults.
  const effective = { ...currentCopyParam(), ...(copyParam || {}) };
  if (queue === 'off') {
    return foregroundTransfer(ctx, { sessionId, direction, move, target: dest, copyParam: effective, files: list });
  }
  try {
    const added = await backend.queue('add', {
      sessionId, direction, files: list, target: dest,
      copyParam: Object.keys(effective).length ? effective : undefined,
    });
    if (!background) await backend.queue('setEnabled', true).catch(() => {});
    notify.info(t('queueTitle'), t('cmQueued', added.length, oneLine(dest, 60)));
    if (move) watchAndDelete(ctx, added, direction);
    afterWrite(ctx, true);
    return added;
  } catch (err) { return fail(err, t('transferSettingsShort')); }
}

/**
 * TTerminal::CopyToRemote / CopyToLocal — the foreground transfer.
 *
 * WinSCP reaches it from NonVisual.cpp:566 (LocalCopyNonQueueAction) through
 * ExecuteCopyOperationCommand(..., cocNonQueue), which sets Param.Queue = asOff
 * so ExecuteCopyMoveFileOperation calls Terminal->CopyToRemote directly
 * (CustomScpExplorer.cpp:2858) instead of building a queue item. Everything in
 * this port already existed for it — the channel, the preload namespace, the
 * engine with the queue attached as its byte mover — and nothing in the
 * renderer ever called it, which made all four NonQueue actions duplicates of
 * the queued ones.
 *
 * Two things differ from the queued path, and both follow from the call not
 * returning until the last byte has moved:
 *
 *   * `move` is passed as cpDelete rather than watched for out here. The engine
 *     deletes each source itself once the file is genuinely up, so running
 *     watchAndDelete over this as well would put two deleters on one path.
 *   * the progress has to be shown, or a large transfer is a window that looks
 *     frozen. main/ipc.js pushes the operation progress on `event:progress`;
 *     this is the surface it lands on.
 */
async function foregroundTransfer(ctx, { sessionId, direction, move, target, copyParam, files }) {
  const title = direction === 'upload' ? t('uploadTitle') : t('downloadTitle');
  const toast = notify.progress(title, t('cmTransferring', files.length, oneLine(target, 60)), { progress: true });
  const off = backend.on('event:progress', (p) => {
    if (!p || p.kind !== 'operation' || p.sessionId !== sessionId || !p.progress) return;
    // totalSize is only known once the engine has calculated it, and it never
    // is for a transfer that did not need the figure. An indeterminate bar is
    // the honest rendering of "moving, total unknown" — a fabricated
    // percentage would be worse than no percentage.
    const total = Number(p.progress.totalSize) || 0;
    const done = Number(p.progress.totalTransferred) || 0;
    toast.update({
      body: oneLine(p.progress.fileName || target, 60),
      progress: total > 0 ? Math.min(1, done / total) : true,
    });
  });
  try {
    const res = await backend.transfer(direction === 'upload' ? 'copyToRemote' : 'copyToLocal', {
      sessionId, files, target,
      copyParam: Object.keys(copyParam).length ? copyParam : undefined,
      params: move ? CP_DELETE : 0,
    });
    // TTerminal::CopyToRemote returns a BOOLEAN, and main/ipc.js forwards it as
    // `completed`: false means cancelled, or an error that was never recovered
    // from. Reporting that as a success is the one lie that loses a file
    // quietly, so it gets its own warning naming where to go and look.
    if (res && res.completed === false) notify.warning(title, t('cmTransferIncomplete', oneLine(target, 60)));
    else notify.success(title, t('cmTransferred', files.length, oneLine(target, 60)));
    afterWrite(ctx, true);
    return res;
  } catch (err) {
    return fail(err, t('transferSettingsShort'));
  } finally {
    off();
    toast.dismiss();
  }
}

/**
 * The transfer options a transfer starts from: whatever was last saved, with
 * the preset named by `copyParamCurrent` layered over it. WinSCP's preset
 * dropdown works exactly this way — picking a preset does not merely record a
 * name, it changes the options the next copy runs with.
 */
function currentCopyParam() {
  const stored = readPref('copyParam', null) || {};
  const name = readPref('copyParamCurrent', '');
  if (!name) return { ...stored };
  const list = readPref('copyParamList', null) || [];
  const preset = list.find((p) => p && p.name === name);
  return preset ? { ...stored, ...(preset.copyParam || {}) } : { ...stored };
}

/**
 * "Upload and Delete" / "Download and Delete". The queue has no move flag, so
 * the source is deleted only after its own item reports `done` — a failed or
 * cancelled transfer never loses the original.
 */
function watchAndDelete(ctx, added, direction) {
  const pending = new Map(added.map((it) => [it.id, it.source]));
  if (!pending.size) return;
  const off = backend.on('event:queue', async (payload) => {
    const item = payload && payload.item;
    if (!item || !pending.has(item.id)) return;
    if (item.state === 'done') {
      const source = pending.get(item.id);
      pending.delete(item.id);
      try {
        if (direction === 'upload') await backend.fs('localRemove', [source], { toRecycleBin: false });
        else await backend.fs('remove', ctx.sessionId, [source], { recursive: true });
      } catch (err) {
        notify.error(t('delete_'), `${oneLine(source, 60)}: ${err.message}`);
      }
      afterWrite(ctx, true);
    } else if (item.state === 'error' || item.state === 'cancelled') {
      pending.delete(item.id);
      notify.warning(t('delete_'), `${oneLine(item.source, 60)} was not transferred, so it was kept.`);
    }
    if (!pending.size) off();
  });
}

/**
 * The recycle-versus-delete decision, taken by design/main/explorershell.js.
 *
 * Three things it knows that a locally-computed version did not:
 *
 *   * a remote delete recycles because the SITE says so and has a recycle-bin
 *     path, not because the protocol happens to have a `recycleBin` capability;
 *   * a file that is ALREADY in the recycle bin is deleted rather than moved
 *     into it a second time;
 *   * recycling and deleting have SEPARATE confirmation preferences
 *     (`confirmRecycling` and `confirmDeleting`), so turning one off does not
 *     turn the other off.
 *
 * If the decision cannot be reached — a browser preview with no bridge — the
 * local rules are used and the user is told nothing was skipped. Falling back
 * is safe here because the fallback is strictly more cautious: it confirms.
 */
async function deleteDecisionFor(ctx, paths, alternative) {
  const prefs = readPrefs();
  const fallback = () => {
    const binDefault = ctx.isLocal
      ? prefs.deleteToRecycleBin !== false
      : !!(ctx.sessionInfo && ctx.caps && ctx.caps.recycleBin);
    return {
      recycle: alternative ? !binDefault : binDefault,
      needConfirmation: prefs.confirmDeleting !== false,
      query: '',
    };
  };
  if (!backend.present) return fallback();
  try {
    await backend.explorer('setPanels', {
      currentSide: ctx.isLocal ? 'local' : 'remote',
      sessionId: ctx.sessionId || null,
    });
    return await backend.explorer('deleteDecision', ctx.isLocal ? 'local' : 'remote', paths, alternative);
  } catch {
    return fallback();
  }
}

/** Delete the selection, with WinSCP's confirmation and recycle-bin rules. */
async function deleteSelection(ctx, { alternative = false } = {}) {
  const paths = selPaths(ctx);
  if (!paths.length) { notify.warning(t('nothingSelected'), t('selectFiles')); return; }
  // "Alternative delete" is WinSCP's Shift+Delete: the opposite of whatever the
  // recycle-bin setting says, so the user can force either behaviour.
  const decision = await deleteDecisionFor(ctx, paths, alternative);
  const toRecycleBin = !!decision.recycle;
  const label = paths.length === 1 ? oneLine(paths[0], 70) : `${paths.length} items`;
  if (decision.needConfirmation !== false) {
    const ok = await confirm({
      title: t('deleteTitle'),
      // The main process composes WinSCP's own sentence, which distinguishes
      // "Delete" from "Move to recycle bin"; the local one is the fallback.
      body: decision.query || t('deleteBody', label),
      detail: toRecycleBin ? t('deleteToBin') : 'This cannot be undone.',
      confirmLabel: t('delete_'), danger: true,
    });
    if (!ok) return;
  }
  try {
    const res = ctx.isLocal
      ? await backend.fs('localRemove', paths, { toRecycleBin })
      : await backend.fs('remove', ctx.sessionId, paths, { recursive: true, toRecycleBin });
    const removed = (res && res.removed) || [];
    const failed = (res && res.failed) || [];
    if (removed.length) notify.success(t('deletedMsg', String(removed.length)), '');
    for (const f of failed) notify.error(t('delete_'), `${oneLine(f.path, 60)}: ${f.message}`);
    afterWrite(ctx);
  } catch (err) { fail(err, t('delete_')); }
}

/** Rename in place when the panel can, otherwise a prompt that really renames. */
async function renameSelection(ctx) {
  const entry = ctx.focused || ctx.selection[0] || (ctx.panel && ctx.panel.focusedEntry && ctx.panel.focusedEntry());
  if (!entry || entry.name === '..') { notify.warning(t('nothingSelected'), t('renameTitle')); return; }
  if (ctx.panel && typeof ctx.panel.beginRename === 'function' && ctx.panel.beginRename(entry)) return;
  const next = await promptText({ title: t('renameTitle'), label: t('newName'), value: entry.name });
  if (next === null || next === entry.name || !next.trim()) return;
  await performRename(ctx, entry, next.trim());
}

export async function performRename(ctx, entry, nextName) {
  const from = ctx.panel.pathOf(entry);
  const to = ctx.panel.pathOf({ ...entry, name: nextName });
  try {
    if (ctx.isLocal) await backend.fs('localRename', from, to);
    else await backend.fs('rename', ctx.sessionId, from, to);
    notify.success(t('renamedMsg', nextName), '');
    afterWrite(ctx);
  } catch (err) { fail(err, t('renameTitle')); }
}

async function createDirectory(ctx) {
  const override = dialogOverrides.get(ctx.name);
  if (override) return override(ctx);
  const name = await promptText({ title: t('createDirTitle'), label: t('dirName'), value: '' });
  if (!name || !name.trim()) return;
  const target = joinPath(ctx, ctx.panel.path(), name.trim());
  try {
    if (ctx.isLocal) await backend.fs('localMkdir', target);
    else await backend.fs('mkdir', ctx.sessionId, target);
    notify.success(t('createdMsg', name.trim()), '');
    afterWrite(ctx);
    ctx.panel.revealName(name.trim());
  } catch (err) { fail(err, t('createDirTitle')); }
}

async function createFile(ctx) {
  const name = await promptText({ title: t('createFileTitle'), label: t('fileName'), value: '' });
  if (!name || !name.trim()) return;
  const target = joinPath(ctx, ctx.panel.path(), name.trim());
  try {
    if (ctx.isLocal) {
      // An empty local file is written through the editor bridge, which is the
      // only local write the preload surface exposes.
      const opened = await backend.editor('open', { localPath: target, mode: 'internal' });
      await backend.editor('save', opened.id, '', {});
      await backend.editor('close', opened.id, { discard: false });
    } else {
      await backend.fs('writeFile', ctx.sessionId, target, '');
    }
    notify.success(t('createdMsg', name.trim()), '');
    afterWrite(ctx);
    ctx.panel.revealName(name.trim());
  } catch (err) { fail(err, t('createFileTitle')); }
}

async function createLink(ctx) {
  const override = dialogOverrides.get(ctx.name);
  if (override) return override(ctx);
  if (!ctx.caps || !ctx.caps.symlink) {
    notify.warning(t('newLink'), t('cmNoSymlink', ctx.isLocal ? 'This platform' : (ctx.sessionInfo?.protocol || 'This protocol').toUpperCase()));
    return;
  }
  const focused = ctx.focused || ctx.selection[0];
  const nameField = h('input', { type: 'text', class: 'field-input', value: focused ? focused.name : '' });
  const hardBox = h('input', { type: 'checkbox', class: 'check' });
  const target = await promptText({
    title: t('symlinkTitle'),
    label: t('linkPointTo'),
    value: focused ? focused.name : '',
    extra: h('div', { class: 'stack' },
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, t('name')), nameField),
      ctx.caps.hardlink
        ? h('label', { class: 'field inline' }, hardBox, h('span', { class: 'field-label' }, t('hardLink')))
        : null),
  });
  if (target === null || !target.trim()) return;
  const linkPath = joinPath(ctx, ctx.panel.path(), (nameField.value || target).trim());
  try {
    await backend.fs('symlink', ctx.sessionId, target.trim(), linkPath, hardBox.checked);
    notify.success(t('createdMsg', linkPath), '');
    afterWrite(ctx);
  } catch (err) { fail(err, t('symlinkTitle')); }
}

function joinPath(ctx, dir, name) {
  const sep = ctx.isLocal ? '\\' : '/';
  const base = String(dir || '').replace(/[\\/]+$/, '');
  return `${base}${sep}${name}`;
}

/** Selection sizes, with WinSCP's "calculate directory sizes" semantics. */
async function calculateSizes(ctx) {
  const dirs = ctx.selection.filter((e) => e.type === 'dir' && e.name !== '..');
  if (!dirs.length) { notify.info(t('calcSize'), t('nothingSelected')); return; }
  if (ctx.isLocal) {
    notify.info(t('calcSize'), t('cmLocalCalc'));
    ctx.panel.calculateSizes(dirs);
    return;
  }
  try {
    const paths = dirs.map((e) => ctx.panel.pathOf(e));
    const res = await backend.fs('calculateSize', ctx.sessionId, paths, `calc-${Date.now().toString(36)}`);
    ctx.panel.applySizes(res);
    notify.success(t('calcSize'), t('cmDirCount', dirs.length));
  } catch (err) { fail(err, t('calcSize')); }
}

/** Copy the selection's names — optionally with full paths — to the clipboard. */
async function copyList(ctx, withPaths) {
  const list = withPaths ? selPaths(ctx) : selNames(ctx);
  if (!list.length) { notify.warning(t('nothingSelected'), ''); return; }
  const text = list.join('\r\n');
  if (await copyText(text)) notify.success(t('copiedClip'), t('cmNameCount', list.length));
  else notify.error(t('copiedClip'), t('cmClipboardRefused'));
}

/** Read the clipboard through main, so it works with no document focus. */
async function readClipboard() {
  try { return String(await backend.app('clipboardRead') || ''); }
  catch { return ''; }
}

/* ---- preferences ---------------------------------------------------- */
// The renderer store persists only the shell's own roots, so panel and window
// preferences are read from and written to main's configuration document.

let prefCache = {};
bus.on('config:document', (doc) => { if (doc && doc.prefs) prefCache = doc.prefs; });

export function readPrefs() {
  if (services.prefs && typeof services.prefs.all === 'function') return services.prefs.all();
  return prefCache || {};
}

export function readPref(dotted, fallback) {
  const parts = String(dotted).split('.');
  let cur = readPrefs();
  for (const p of parts) {
    if (cur == null) return fallback;
    cur = cur[p];
  }
  return cur === undefined ? fallback : cur;
}

/** Write a preference and keep the local cache in step immediately. */
export async function writePref(dotted, value, label) {
  const parts = String(dotted).split('.');
  const patch = {};
  let cur = patch;
  for (let i = 0; i < parts.length - 1; i += 1) { cur[parts[i]] = {}; cur = cur[parts[i]]; }
  cur[parts[parts.length - 1]] = value;
  // Optimistic local update: the UI must reflect a toggle before the round trip.
  let node = prefCache;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (!node[parts[i]] || typeof node[parts[i]] !== 'object') node[parts[i]] = {};
    node = node[parts[i]];
  }
  node[parts[parts.length - 1]] = value;
  bus.emit('prefs:changed', { path: dotted, value });
  try { await api.configSet(patch, label || `Changed ${dotted}`); }
  catch (err) { notify.error(t('settingsSaved'), err.message); }
  return value;
}

export function togglePref(dotted, label) {
  return writePref(dotted, !readPref(dotted, false), label);
}

/* ================================================================== */
/* handler groups                                                      */
/* ================================================================== */

const DEFS = Object.create(null);

/** Register one action's descriptor. */
function def(name, spec) {
  if (!ACTIONS_BY_NAME[name]) throw new Error(`commands.js: "${name}" is not a WinSCP action`);
  if (DEFS[name]) throw new Error(`commands.js: "${name}" is defined twice`);
  if (typeof spec.run !== 'function') {
    if (!spec.unavailable) throw new Error(`commands.js: "${name}" has neither run() nor an unavailable reason`);
    // A declared-unavailable action still gets a handler: running it says why,
    // every time. A descriptor with no run() would be a silent no-op waiting
    // to happen the day someone calls it past the state check.
    spec.run = (ctx) => {
      const reason = typeof spec.unavailable === 'function' ? spec.unavailable(ctx) : spec.unavailable;
      notify.warning(actionLabel(name), reason);
      return null;
    };
    spec.enabled = spec.enabled || (() => false);
  }
  DEFS[name] = spec;
}

/** Register the same descriptor under several names (Local/Remote/Current). */
function defEach(names, factory) {
  for (const name of names) def(name, factory(name));
}

/* ---------------- columns ---------------- */

const COLUMN_ACTIONS = {
  ShowHideRemoteNameColumnAction2: ['remote', 'name'],
  ShowHideRemoteExtColumnAction2: ['remote', 'ext'],
  ShowHideRemoteSizeColumnAction2: ['remote', 'size'],
  ShowHideRemoteChangedColumnAction3: ['remote', 'changed'],
  ShowHideRemoteRightsColumnAction2: ['remote', 'rights'],
  ShowHideRemoteOwnerColumnAction2: ['remote', 'owner'],
  ShowHideRemoteGroupColumnAction2: ['remote', 'group'],
  ShowHideRemoteLinkTargetColumnAction2: ['remote', 'linkTarget'],
  ShowHideRemoteTypeColumnAction2: ['remote', 'type'],
  ShowHideLocalNameColumnAction2: ['local', 'name'],
  ShowHideLocalExtColumnAction2: ['local', 'ext'],
  ShowHideLocalTypeColumnAction2: ['local', 'type'],
  ShowHideLocalSizeColumnAction2: ['local', 'size'],
  ShowHideLocalChangedColumnAction3: ['local', 'changed'],
  ShowHideLocalAttrColumnAction2: ['local', 'attr'],
};

for (const [name, [side, key]] of Object.entries(COLUMN_ACTIONS)) {
  def(name, {
    side,
    kind: 'toggle',
    enabled: havePanel,
    checked: (c) => !!(c.panel && c.panel.columns.isVisible(key)),
    run: (c) => c.panel.columns.toggle(key),
  });
}

def('AutoSizeRemoteColumnsAction', { side: 'remote', enabled: havePanel, run: (c) => c.panel.columns.autoSize() });
def('AutoSizeLocalColumnsAction', { side: 'local', enabled: havePanel, run: (c) => c.panel.columns.autoSize() });
def('ResetLayoutRemoteColumnsAction', { side: 'remote', enabled: havePanel, run: (c) => c.panel.columns.resetLayout() });
def('ResetLayoutLocalColumnsAction', { side: 'local', enabled: havePanel, run: (c) => c.panel.columns.resetLayout() });
def('HideColumnAction', {
  // Only meaningful from a column header's own menu, which supplies ctx.column.
  enabled: (c) => !!(c.panel && c.column && c.panel.columns.canHide(c.column)),
  visible: (c) => !!c.column,
  run: (c) => c.panel.columns.setVisible(c.column, false),
});

/* ---------------- sorting ---------------- */

const SORT_KEYS = {
  Name: 'name', Ext: 'ext', Size: 'size', Type: 'type', Changed: 'changed',
  Attr: 'attr', Rights: 'rights', Owner: 'owner', Group: 'group',
};

const SORT_ACTIONS = [
  ['LocalSortByNameAction2', 'local', 'Name'], ['LocalSortByExtAction2', 'local', 'Ext'],
  ['LocalSortBySizeAction2', 'local', 'Size'], ['LocalSortByAttrAction2', 'local', 'Attr'],
  ['LocalSortByTypeAction2', 'local', 'Type'], ['LocalSortByChangedAction3', 'local', 'Changed'],
  ['RemoteSortByNameAction2', 'remote', 'Name'], ['RemoteSortByExtAction2', 'remote', 'Ext'],
  ['RemoteSortBySizeAction2', 'remote', 'Size'], ['RemoteSortByRightsAction2', 'remote', 'Rights'],
  ['RemoteSortByChangedAction3', 'remote', 'Changed'], ['RemoteSortByOwnerAction2', 'remote', 'Owner'],
  ['RemoteSortByGroupAction2', 'remote', 'Group'], ['RemoteSortByTypeAction2', 'remote', 'Type'],
  ['CurrentSortByNameAction', 'current', 'Name'], ['CurrentSortByExtAction', 'current', 'Ext'],
  ['CurrentSortBySizeAction', 'current', 'Size'], ['CurrentSortByTypeAction2', 'current', 'Type'],
  ['CurrentSortByRightsAction', 'current', 'Rights'], ['CurrentSortByChangedAction2', 'current', 'Changed'],
  ['CurrentSortByOwnerAction', 'current', 'Owner'], ['CurrentSortByGroupAction', 'current', 'Group'],
];

for (const [name, side, which] of SORT_ACTIONS) {
  const key = SORT_KEYS[which];
  def(name, {
    side,
    kind: 'radio',
    // A column the panel does not carry (owner on a local panel) is hidden
    // rather than offered and refused.
    visible: (c) => !c.panel || c.panel.columns.has(key),
    enabled: (c) => !!c.panel && c.panel.columns.has(key),
    checked: (c) => !!c.panel && c.panel.sortState().key === key,
    run: (c) => c.panel.sortBy(key),
  });
}

defEach(['LocalSortAscendingAction2', 'RemoteSortAscendingAction2', 'CurrentSortAscendingAction'], (name) => ({
  side: name.startsWith('Local') ? 'local' : name.startsWith('Remote') ? 'remote' : 'current',
  kind: 'toggle',
  enabled: havePanel,
  checked: (c) => !!c.panel && c.panel.sortState().ascending,
  run: (c) => c.panel.setSortAscending(!c.panel.sortState().ascending),
}));

def('SortColumnAscendingAction', {
  kind: 'radio',
  visible: (c) => !!c.column,
  enabled: (c) => !!(c.panel && c.column),
  checked: (c) => !!c.panel && c.panel.sortState().key === c.column && c.panel.sortState().ascending,
  run: (c) => { c.panel.sortBy(c.column, true); },
});
def('SortColumnDescendingAction', {
  kind: 'radio',
  visible: (c) => !!c.column,
  enabled: (c) => !!(c.panel && c.column),
  checked: (c) => !!c.panel && c.panel.sortState().key === c.column && !c.panel.sortState().ascending,
  run: (c) => { c.panel.sortBy(c.column, false); },
});

/* ---------------- view style ---------------- */

const STYLE_ACTIONS = [
  ['RemoteIconAction', 'remote', 'icon'], ['RemoteSmallIconAction', 'remote', 'smallIcon'],
  ['RemoteListAction', 'remote', 'list'], ['RemoteReportAction', 'remote', 'report'],
  ['RemoteThumbnailAction', 'remote', 'thumbnail'],
  ['LocalReportAction', 'local', 'report'], ['LocalThumbnailAction', 'local', 'thumbnail'],
];
for (const [name, side, style] of STYLE_ACTIONS) {
  def(name, {
    side, kind: 'radio',
    enabled: havePanel,
    checked: (c) => !!c.panel && c.panel.viewStyle() === style,
    run: (c) => c.panel.setViewStyle(style),
  });
}
def('RemoteCycleStyleAction', { side: 'remote', enabled: havePanel, run: (c) => c.panel.cycleViewStyle() });

/* ---------------- selection ---------------- */

def('SelectOneAction', {
  enabled: haveFocus,
  run: (c) => c.panel.toggleFocusedSelection(),
});

async function maskSelect(ctx, select) {
  const override = dialogOverrides.get(ctx.name);
  if (override) return override(ctx, { select });
  const title = select ? t('selectFiles') : t('unselectFiles');
  const dirBox = h('input', { type: 'checkbox', class: 'check' });
  dirBox.checked = true;
  const mask = await promptText({
    title,
    label: t('colorMask'),
    value: ctx.panel.lastSelectMask || '*.*',
    body: t('fileColorsHint'),
    extra: h('label', { class: 'field inline' }, dirBox, h('span', { class: 'field-label' }, t('applyToDirs'))),
  });
  if (mask === null || !mask.trim()) return;
  ctx.panel.lastSelectMask = mask.trim();
  const n = await ctx.panel.selectByMask(mask.trim(), select, { includeDirs: dirBox.checked });
  announce(t(select ? 'cmSelectedCount' : 'cmUnselectedCount', n));
}

defEach(['SelectAction', 'LocalSelectAction2', 'RemoteSelectAction2'], (name) => ({
  side: name.startsWith('Local') ? 'local' : name.startsWith('Remote') ? 'remote' : 'current',
  enabled: havePanel,
  run: (c) => maskSelect(c, true),
}));
defEach(['UnselectAction', 'LocalUnselectAction2', 'RemoteUnselectAction2'], (name) => ({
  side: name.startsWith('Local') ? 'local' : name.startsWith('Remote') ? 'remote' : 'current',
  enabled: havePanel,
  run: (c) => maskSelect(c, false),
}));
defEach(['SelectAllAction', 'LocalSelectAllAction2', 'RemoteSelectAllAction2'], (name) => ({
  side: name.startsWith('Local') ? 'local' : name.startsWith('Remote') ? 'remote' : 'current',
  enabled: havePanel,
  run: (c) => c.panel.selectAll(),
}));
def('InvertSelectionAction', { enabled: havePanel, run: (c) => c.panel.invertSelection() });
def('ClearSelectionAction', { enabled: havePanel, run: (c) => c.panel.clearSelection() });
def('RestoreSelectionAction', {
  enabled: (c) => !!c.panel && c.panel.canRestoreSelection(),
  run: (c) => c.panel.restoreSelection(),
});
def('SelectSameExtAction', { enabled: haveFocus, run: (c) => c.panel.selectSameExtension(true) });
def('UnselectSameExtAction', { enabled: haveFocus, run: (c) => c.panel.selectSameExtension(false) });

/* ---------------- directory navigation ---------------- */

const NAV = [
  ['LocalBackAction', 'local', 'back'], ['RemoteBackAction', 'remote', 'back'],
  ['LocalForwardAction', 'local', 'forward'], ['RemoteForwardAction', 'remote', 'forward'],
  ['LocalParentDirAction', 'local', 'parent'], ['RemoteParentDirAction', 'remote', 'parent'],
  ['LocalRootDirAction', 'local', 'root'], ['RemoteRootDirAction', 'remote', 'root'],
  ['LocalHomeDirAction', 'local', 'home'], ['RemoteHomeDirAction', 'remote', 'home'],
];
for (const [name, side, what] of NAV) {
  def(name, {
    side,
    enabled: (c) => {
      if (!c.panel || !online(c)) return false;
      if (what === 'back') return c.panel.canGoBack();
      if (what === 'forward') return c.panel.canGoForward();
      if (what === 'parent') return !c.panel.isRoot();
      return true;
    },
    run: (c) => {
      if (what === 'back') return c.panel.goBack();
      if (what === 'forward') return c.panel.goForward();
      if (what === 'parent') return c.panel.goParent();
      if (what === 'root') return c.panel.goRoot();
      return c.panel.goHome();
    },
  });
}

defEach(['LocalRefreshAction', 'RemoteRefreshAction'], (name) => ({
  side: name.startsWith('Local') ? 'local' : 'remote',
  enabled: (c) => !!c.panel && online(c),
  run: (c) => c.panel.refresh(true),
}));

defEach(['LocalOtherDirAction', 'RemoteOtherDirAction'], (name) => ({
  side: name.startsWith('Local') ? 'local' : 'remote',
  // Only meaningful when the other panel is on the same kind of filesystem;
  // WinSCP maps the path across, so a remote path may be opened locally.
  enabled: (c) => bothPanels(c) && online(c),
  run: (c) => c.panel.navigate(mapAcross(c.other.path(), c.isLocal)),
}));

/** Map a path from one panel's separator convention to the other's. */
function mapAcross(p, toLocal) {
  const s = String(p || '');
  return toLocal ? s.replace(/\//g, '\\') : s.replace(/\\/g, '/');
}

defEach(['LocalOpenDirAction', 'RemoteOpenDirAction'], (name) => ({
  side: name.startsWith('Local') ? 'local' : 'remote',
  enabled: (c) => !!c.panel && online(c),
  run: (c) => openDirectoryDialog(c),
}));

async function openDirectoryDialog(ctx) {
  const override = dialogOverrides.get(ctx.name);
  if (override) return override(ctx);
  const key = ctx.isLocal ? 'local' : 'remote';
  let bookmarks = [];
  try { bookmarks = (await backend.config('bookmarks', 'default'))?.[key] || []; } catch { /* none yet */ }
  const history = ctx.panel.history();
  const items = [
    ...bookmarks.map((b) => ({ value: b.value || b, label: b.name || b.value || b, icon: 'bookmark' })),
    ...history.filter((p) => !bookmarks.some((b) => (b.value || b) === p))
      .map((p) => ({ value: p, label: p, icon: 'history' })),
  ];
  const field = h('input', { type: 'text', class: 'field-input', value: ctx.panel.path(), spellcheck: 'false' });
  let chosen = null;
  const list = h('div', { class: 'stack' }, ...items.slice(0, 40).map((it) => h('button', {
    type: 'button', class: 'btn-text', style: { justifyContent: 'flex-start' },
    onclick: () => { field.value = it.value; field.focus(); },
  }, icon(it.icon, 15), h('span', { class: 'ellipsis', title: it.label }, it.label))));
  await new Promise((resolve) => {
    openModal({
      title: t('openDirBookmark'),
      width: 560,
      content: h('div', { class: 'stack' },
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, t('location')), field),
        items.length ? h('div', { class: 'stack' }, h('span', { class: 'field-label' }, t('addBookmark')), list) : null),
      actions: [
        { label: t('cancel'), kind: 'text' },
        { label: t('goTo'), kind: 'filled', autofocus: true, onSelect: () => { chosen = field.value; } },
      ],
      onClose: () => resolve(),
    });
  });
  if (chosen && chosen.trim()) ctx.panel.navigate(chosen.trim());
}

defEach(['LocalAddBookmarkAction2', 'RemoteAddBookmarkAction2'], (name) => ({
  side: name.startsWith('Local') ? 'local' : 'remote',
  enabled: (c) => !!c.panel && online(c),
  run: async (c) => {
    const p = c.panel.path();
    try {
      await backend.config('addBookmark', 'default', c.isLocal ? 'local' : 'remote', p, p);
      notify.success(t('bookmarkAdded'), oneLine(p, 70));
    } catch (err) { fail(err, t('addBookmark')); }
  },
}));

defEach(['LocalPathToClipboardAction2', 'RemotePathToClipboardAction2'], (name) => ({
  side: name.startsWith('Local') ? 'local' : 'remote',
  enabled: havePanel,
  run: async (c) => {
    const p = c.panel.path();
    if (await copyText(p)) notify.success(t('pathCopied'), oneLine(p, 70));
  },
}));

def('LocalChangePathAction2', {
  side: 'local',
  enabled: havePanel,
  run: async (c) => {
    let drives = [];
    try { drives = await backend.fs('localDrives'); } catch (err) { return fail(err, t('changeDrive')); }
    const choice = await chooseFrom({
      title: t('changeDrive'),
      items: drives.map((d) => ({ value: d.path, label: d.label || d.path, icon: 'computer' })),
      empty: t('emptyDir'),
    });
    if (choice) c.panel.navigate(choice);
    return null;
  },
});

def('RemoteChangePathAction2', {
  side: 'remote',
  enabled: (c) => !!c.panel && online(c),
  run: async (c) => {
    const p = await promptText({ title: t('goTo'), label: t('location'), value: c.panel.path() });
    if (p && p.trim()) c.panel.navigate(p.trim());
  },
});

def('GoToAddressAction', {
  enabled: havePanel,
  run: (c) => c.panel.focusAddress(),
});

def('IncrementalSearchStartAction', {
  enabled: havePanel,
  run: (c) => c.panel.startIncrementalSearch(),
});

defEach(['LocalFilterAction', 'RemoteFilterAction'], (name) => ({
  side: name.startsWith('Local') ? 'local' : 'remote',
  enabled: havePanel,
  checked: (c) => !!(c.panel && c.panel.filter()),
  run: async (c) => {
    const mask = await promptText({
      title: t('filterMenu'), label: t('filterPh'), value: c.panel.filter() || '',
      body: t('fileColorsHint'),
    });
    if (mask === null) return;
    c.panel.setFilter(mask.trim());
  },
}));

def('LocalExploreDirectoryAction', {
  side: 'local',
  enabled: havePanel,
  run: async (c) => {
    try { await backend.app('showItemInFolder', c.panel.path()); }
    catch (err) { fail(err, t('explore')); }
  },
});

def('RemoteExploreDirectoryAction', {
  side: 'remote',
  // WinSCP opens a remote directory in Windows Explorer through its shell
  // namespace extension (dragext/). This port has no shell extension, so the
  // command is declared unavailable rather than opening the wrong thing.
  unavailable: 'Opening a remote directory in Windows Explorer needs WinSCP\'s shell namespace extension, which this port does not install. Use the local panel\'s Explore Directory, or download the files first.',
});

def('RemoteFindFilesAction2', {
  side: 'remote',
  enabled: (c) => !!c.panel && online(c),
  run: (c) => runFindFiles(c),
});

/** A real recursive search over fs:find, streamed through event:progress. */
async function runFindFiles(ctx) {
  const override = dialogOverrides.get(ctx.name);
  if (override) return override(ctx);
  const maskField = h('input', { type: 'text', class: 'field-input', value: '*.*', spellcheck: 'false' });
  const textField = h('input', { type: 'text', class: 'field-input', spellcheck: 'false' });
  const whereField = h('input', { type: 'text', class: 'field-input', value: ctx.panel.path(), spellcheck: 'false' });
  const recurseBox = h('input', { type: 'checkbox', class: 'check' });
  recurseBox.checked = true;
  const results = h('div', { class: 'stack', role: 'listbox', 'aria-label': t('findResults'), style: { maxHeight: '220px', overflow: 'auto' } });
  const status = h('p', { class: 'prose muted' }, '');
  let cid = null;
  let off = null;
  let found = 0;

  const stop = () => {
    if (cid) { backend.fs('findCancel', cid).catch(() => {}); cid = null; }
    if (off) { off(); off = null; }
  };

  const start = async () => {
    stop();
    while (results.firstChild) results.removeChild(results.firstChild);
    found = 0;
    status.textContent = t('findStart');
    cid = `find-${Date.now().toString(36)}`;
    off = backend.on('event:progress', (p) => {
      if (!p || p.correlationId !== cid) return;
      if (p.kind === 'find-hit' && p.hit) {
        found += 1;
        const hit = p.hit;
        results.appendChild(h('button', {
          type: 'button', class: 'btn-text', role: 'option',
          style: { justifyContent: 'flex-start', width: '100%' },
          onclick: () => {
            const dir = String(hit.path).replace(/\/[^/]*$/, '') || '/';
            ctx.panel.navigate(dir);
            ctx.panel.revealName(hit.name);
            modal.close('goto');
          },
        }, icon(hit.type === 'dir' ? 'folder' : 'description', 15),
        h('span', { class: 'ellipsis', title: hit.path }, hit.path)));
        status.textContent = `${found} ${t('findResults')}`;
      } else if (p.kind === 'find-done') {
        status.textContent = found ? `${found} ${t('findResults')}` : t('findNoResults');
        stop();
      }
    });
    try {
      await backend.fs('find', {
        sessionId: ctx.sessionId, root: whereField.value, mask: maskField.value || undefined,
        text: textField.value || undefined, recursive: recurseBox.checked, correlationId: cid,
      });
    } catch (err) { status.textContent = err.message; stop(); }
  };

  const modal = openModal({
    title: t('findTitle'),
    width: 680,
    content: h('div', { class: 'stack' },
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, t('findMask')), maskField),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, t('findReplace')), textField),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, t('findWhere')), whereField),
      h('label', { class: 'field inline' }, recurseBox, h('span', { class: 'field-label' }, t('recursive'))),
      status, results),
    actions: [
      { label: t('findStop'), kind: 'text', onSelect: () => { stop(); status.textContent = t('findStop'); return true; } },
      { label: t('findStart'), kind: 'filled', autofocus: true, onSelect: () => { start(); return true; } },
      { label: t('close'), kind: 'text' },
    ],
    onClose: stop,
  });
  return modal;
}

/* ---------------- transfers ---------------- */

/**
 * The transfer commands, and the one field that distinguishes them.
 *
 * `queue` is TTransferOperationParam::Queue, which
 * TCustomScpExplorerForm::ExecuteCopyOperationCommand sets from the cocQueue /
 * cocNonQueue flag the action carries (CustomScpExplorer.cpp:3177-3184):
 *
 *   'on'    cocQueue    — asOn,   CopyParam.Queue = true  -> a queue item
 *   'off'   cocNonQueue — asOff,  CopyParam.Queue = false -> TTerminal::CopyToRemote
 *   'auto'  neither     — asAuto, keep whatever the configuration says
 *
 * Without it the four *NonQueueAction commands were byte-identical to the plain
 * Copy ones and queued like everything else, which made "non-queue" a name with
 * no behaviour behind it. It only PRESETS the dialog's background checkbox —
 * WinSCP branches on the FINAL CopyParam.Queue after the dialog closes — so a
 * user who ticks "transfer in background" on a NonQueue command still queues.
 */
const TRANSFERS = [
  // [name, side, direction, move, background, queue]
  ['RemoteCopyAction', 'remote', 'download', false, false, 'auto'],
  ['RemoteCopyNonQueueAction', 'remote', 'download', false, false, 'off'],
  ['RemoteCopyQueueAction', 'remote', 'download', false, true, 'on'],
  ['RemoteMoveAction', 'remote', 'download', true, false, 'auto'],
  ['RemoteCopyFocusedAction', 'remote', 'download', false, false, 'auto'],
  ['RemoteCopyFocusedNonQueueAction', 'remote', 'download', false, false, 'off'],
  ['RemoteCopyFocusedQueueAction', 'remote', 'download', false, true, 'on'],
  ['RemoteMoveFocusedAction', 'remote', 'download', true, false, 'auto'],
  ['LocalCopyAction', 'local', 'upload', false, false, 'auto'],
  ['LocalCopyNonQueueAction', 'local', 'upload', false, false, 'off'],
  ['LocalCopyQueueAction', 'local', 'upload', false, true, 'on'],
  ['LocalMoveAction', 'local', 'upload', true, false, 'auto'],
  ['LocalCopyFocusedAction', 'local', 'upload', false, false, 'auto'],
  ['LocalCopyFocusedNonQueueAction', 'local', 'upload', false, false, 'off'],
  ['LocalCopyFocusedQueueAction', 'local', 'upload', false, true, 'on'],
  ['LocalMoveFocusedAction', 'local', 'upload', true, false, 'auto'],
];

/** The queue mode a transfer command runs with, by WinSCP action name. */
export function transferQueueMode(name) {
  const row = TRANSFERS.find((r) => r[0] === name);
  return row ? row[5] : undefined;
}

for (const [name, side, direction, move, background, queue] of TRANSFERS) {
  def(name, {
    side,
    enabled: (c) => haveSel(c) && transferPanels(c) && !!c.sessionId,
    run: (c) => transferWithOptions(c, { direction, move, background, queue }),
  });
}

/**
 * WinSCP always shows the transfer dialog before a copy (unless the user turned
 * the confirmation off), so the target, the preset and the background choice
 * are all decided before anything moves.
 */
async function transferWithOptions(ctx, opts) {
  const override = dialogOverrides.get(ctx.name);
  if (override) return override(ctx, opts);
  const targetField = h('input', {
    type: 'text', class: 'field-input', spellcheck: 'false',
    value: transferTarget(ctx),
  });
  const bgBox = h('input', { type: 'checkbox', class: 'check' });
  bgBox.checked = !!opts.background;
  const modeSel = h('select', { class: 'field-input' },
    h('option', { value: 'automatic' }, t('modeAuto')),
    h('option', { value: 'binary' }, t('modeBinary')),
    h('option', { value: 'text' }, t('modeText')));
  modeSel.value = readPref('copyParam.transferMode', 'automatic');
  const preserveBox = h('input', { type: 'checkbox', class: 'check' });
  preserveBox.checked = readPref('copyParam.preserveTime', true) !== false;
  const newerBox = h('input', { type: 'checkbox', class: 'check' });
  const excludeField = h('input', { type: 'text', class: 'field-input', spellcheck: 'false', value: '' });
  const speedField = h('input', { type: 'number', class: 'field-input', min: '0', step: '1', value: '0' });

  const names = selNames(ctx);
  const title = opts.direction === 'upload'
    ? (opts.move ? t('uploadDelete') : t('uploadTitle'))
    : (opts.move ? t('downloadDelete') : t('downloadTitle'));

  const go = await new Promise((resolve) => {
    let answered = false;
    openModal({
      title,
      width: 640,
      content: h('div', { class: 'stack' },
        h('p', { class: 'prose' }, names.length === 1
          ? oneLine(names[0], 80)
          : `${names.length} ${t('syncFiles')}`),
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, t('destLbl')), targetField),
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, t('transferMode')), modeSel),
        h('label', { class: 'field inline' }, preserveBox, h('span', { class: 'field-label' }, t('preserveTimestamp'))),
        h('label', { class: 'field inline' }, newerBox, h('span', { class: 'field-label' }, t('newerOnly'))),
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, t('excludeMask')), excludeField),
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, `${t('speedLimit')} (B/s, 0 = ${t('none')})`), speedField),
        h('label', { class: 'field inline' }, bgBox, h('span', { class: 'field-label' }, t('transferInBackground')))),
      actions: [
        { label: t('cancel'), kind: 'text', onSelect: () => { answered = true; resolve(false); } },
        {
          label: opts.direction === 'upload' ? t('upload') : t('download'),
          kind: 'filled', autofocus: true,
          onSelect: () => { answered = true; resolve(true); },
        },
      ],
      onClose: () => { if (!answered) resolve(false); },
    });
  });
  if (!go) return null;

  // WinSCP has one mask with an include clause and, after '|', an exclude
  // clause — there is no separate "exclude" field in TCopyParamType, and
  // main/queue.js only ever reads includeFileMask. Writing the exclusion
  // anywhere else would leave the field looking wired while transferring
  // everything the user asked to skip.
  const exclude = excludeField.value.trim();
  const copyParam = {
    transferMode: modeSel.value,
    preserveTime: preserveBox.checked,
    newerOnly: newerBox.checked,
    includeFileMask: exclude ? `| ${exclude}` : '',
    cpsLimit: Number(speedField.value) || 0,
  };
  // Param.Queue only presets the checkbox. ExecuteCopyMoveFileOperation reads
  // CopyParam.Queue AFTER the dialog closes, so ticking "transfer in
  // background" on a NonQueue command genuinely queues it — the user's last
  // word wins over the command's preset, exactly as it does in WinSCP.
  const queue = bgBox.checked ? 'on' : (opts.queue || 'auto');
  return queueTransfer(ctx, {
    direction: opts.direction, move: opts.move, background: bgBox.checked, queue,
    target: targetField.value, copyParam,
  });
}

/* ---- same-side copy / move (Copy…, Move…, Duplicate…) ---- */

const SAMESIDE = [
  ['LocalLocalCopyAction', 'local', 'copy', false],
  ['LocalLocalMoveAction', 'local', 'move', false],
  ['LocalLocalCopyFocusedAction', 'local', 'copy', true],
  ['LocalLocalMoveFocusedAction', 'local', 'move', true],
  ['LocalOtherCopyAction', 'local', 'copy', false],
  ['LocalOtherMoveAction', 'local', 'move', false],
  ['RemoteCopyToAction', 'remote', 'copy', false],
  ['RemoteMoveToAction', 'remote', 'move', false],
  ['RemoteCopyToFocusedAction', 'remote', 'copy', true],
  ['RemoteMoveToFocusedAction', 'remote', 'move', true],
];

for (const [name, side, mode] of SAMESIDE) {
  def(name, {
    side,
    enabled: (c) => haveSel(c) && (mode === 'move' ? capOrLocal(c, 'move') : capOrLocal(c, 'copyRemote')),
    run: (c) => sameSideOperation(c, mode),
  });
}

function capOrLocal(c, name) {
  if (c.isLocal) return true;
  return !!(c.caps && c.caps[name]);
}

/**
 * WinSCP's Duplicate…/Move To… on the remote side, and Copy…/Move… on the
 * local side: a target path on the SAME filesystem. A move is a rename; a copy
 * on the remote side is a server-side copy queued through the queue.
 */
async function sameSideOperation(ctx, mode) {
  const override = dialogOverrides.get(ctx.name);
  if (override) return override(ctx, { mode });
  const entries = ctx.selection.filter((e) => e.name !== '..');
  if (!entries.length) return null;
  const suggestion = entries.length === 1
    ? joinPath(ctx, ctx.panel.path(), entries[0].name)
    : `${String(ctx.panel.path()).replace(/[\\/]+$/, '')}${ctx.isLocal ? '\\' : '/'}`;
  const target = await promptText({
    title: mode === 'move' ? t('moveToTitle') : t('copyToTitle'),
    label: t('targetPath'),
    value: suggestion,
    confirmLabel: mode === 'move' ? t('move_') : t('copy_'),
  });
  if (target === null || !target.trim()) return null;
  const dest = target.trim();
  try {
    if (mode === 'move') {
      for (const e of entries) {
        const from = ctx.panel.pathOf(e);
        const to = entries.length === 1 && !/[\\/]$/.test(dest)
          ? dest
          : `${dest.replace(/[\\/]+$/, '')}${ctx.isLocal ? '\\' : '/'}${e.name}`;
        if (ctx.isLocal) await backend.fs('localRename', from, to);
        else await backend.fs('rename', ctx.sessionId, from, to);
      }
      notify.success(t('renamedMsg', `${entries.length}`), dest);
      afterWrite(ctx, true);
      return true;
    }
    if (ctx.isLocal) {
      // A local-to-local copy runs through the queue's local adapter on both
      // ends, which is exactly how the local "Copy…" behaves in WinSCP.
      return await queueTransfer(ctx, {
        direction: 'upload', target: dest, files: entries.map((e) => ctx.panel.pathOf(e)),
      });
    }
    return await queueTransfer(ctx, {
      direction: 'remote-copy', target: dest, files: entries.map((e) => ctx.panel.pathOf(e)),
    });
  } catch (err) { return fail(err, mode === 'move' ? t('moveToTitle') : t('copyToTitle')); }
}

/* ---------------- file operations ---------------- */

defEach(['LocalRenameAction2', 'RemoteRenameAction2', 'CurrentRenameAction'], (name) => ({
  side: name.startsWith('Local') ? 'local' : name.startsWith('Remote') ? 'remote' : 'current',
  enabled: (c) => haveFocus(c) && capOrLocal(c, 'rename'),
  run: renameSelection,
}));

defEach(['LocalDeleteAction2', 'RemoteDeleteAction2', 'CurrentDeleteAction'], (name) => ({
  side: name.startsWith('Local') ? 'local' : name.startsWith('Remote') ? 'remote' : 'current',
  enabled: haveSel,
  run: (c) => deleteSelection(c),
}));
def('CurrentDeleteFocusedAction', { side: 'current', focusedOnly: true, enabled: haveFocus, run: (c) => deleteSelection(c) });
def('CurrentDeleteAlternativeAction', {
  side: 'current', enabled: haveSel, run: (c) => deleteSelection(c, { alternative: true }),
});

defEach(['LocalCreateDirAction3', 'RemoteCreateDirAction3', 'CurrentCreateDirAction', 'NewDirAction'], (name) => ({
  side: name.startsWith('Local') ? 'local' : name.startsWith('Remote') ? 'remote' : 'current',
  enabled: (c) => !!c.panel && online(c),
  run: createDirectory,
}));

defEach(['LocalNewFileAction', 'RemoteNewFileAction', 'NewFileAction'], (name) => ({
  side: name.startsWith('Local') ? 'local' : name.startsWith('Remote') ? 'remote' : 'current',
  enabled: (c) => !!c.panel && online(c),
  run: createFile,
}));

defEach(['LocalAddEditLinkAction3', 'RemoteAddEditLinkAction3', 'NewLinkAction',
  'CurrentAddEditLinkAction', 'CurrentAddEditLinkContextAction'], (name) => ({
  side: name.startsWith('Local') ? 'local' : name.startsWith('Remote') ? 'remote' : 'current',
  enabled: (c) => !!c.panel && online(c) && !!(c.caps && c.caps.symlink),
  run: createLink,
}));

defEach(['LocalPropertiesAction2', 'RemotePropertiesAction2', 'CurrentPropertiesAction'], (name) => ({
  side: name.startsWith('Local') ? 'local' : name.startsWith('Remote') ? 'remote' : 'current',
  enabled: haveSel,
  run: (c) => showProperties(c),
}));
def('CurrentPropertiesFocusedAction', { side: 'current', enabled: haveFocus, run: (c) => showProperties(c) });

/** Properties, including a working permissions editor where the protocol has one. */
async function showProperties(ctx) {
  const override = dialogOverrides.get(ctx.name);
  if (override) return override(ctx);
  const entries = ctx.selection.filter((e) => e.name !== '..');
  if (!entries.length) return null;
  const one = entries.length === 1 ? entries[0] : null;
  const totalSize = entries.reduce((n, e) => n + (e.size || 0), 0);
  const canRights = !!(ctx.caps && ctx.caps.rights);
  const canOwner = !!(ctx.caps && ctx.caps.owner);

  const rightsField = h('input', {
    type: 'text', class: 'field-input mono', spellcheck: 'false',
    value: one ? (one.rights || '') : '',
    placeholder: 'rwxr-xr-x',
  });
  const octalOut = h('span', { class: 'mono muted' }, one ? rightsToOctal(one.rights) : '');
  rightsField.addEventListener('input', () => { octalOut.textContent = rightsToOctal(rightsField.value); });
  const recurseBox = h('input', { type: 'checkbox', class: 'check' });
  const ownerField = h('input', { type: 'text', class: 'field-input', value: one ? (one.owner || '') : '' });
  const groupField = h('input', { type: 'text', class: 'field-input', value: one ? (one.group || '') : '' });

  const rows = [
    [t('name'), one ? one.name : `${entries.length} ${t('syncFiles')}`],
    [t('location'), ctx.panel.path()],
    [t('sizeLbl'), formatBytes(totalSize)],
    one ? [t('colChanged'), one.mtime ? new Date(one.mtime).toLocaleString() : '—'] : null,
    one && one.linkTarget ? [t('linksTo'), one.linkTarget] : null,
  ].filter(Boolean);

  let apply = false;
  await new Promise((resolve) => {
    openModal({
      title: t('propsTitle'),
      width: 560,
      content: h('div', { class: 'stack' },
        h('div', { class: 'about-grid mono' }, ...rows.flatMap(([k, v]) => [h('span', {}, k), h('span', { class: 'ellipsis', title: String(v) }, String(v))])),
        canRights ? h('div', { class: 'stack' },
          h('label', { class: 'field' },
            h('span', { class: 'field-label' }, t('colRights')),
            rightsField),
          h('div', { class: 'row' }, h('span', { class: 'field-label' }, t('rightsOctal')), octalOut),
          h('label', { class: 'field inline' }, recurseBox, h('span', { class: 'field-label' }, t('recurse')))) : null,
        canOwner ? h('div', { class: 'stack' },
          h('label', { class: 'field' }, h('span', { class: 'field-label' }, t('ownerRow')), ownerField),
          h('label', { class: 'field' }, h('span', { class: 'field-label' }, t('groupRow')), groupField)) : null,
        !canRights && !canOwner
          ? h('p', { class: 'prose muted' }, `${(ctx.sessionInfo?.protocol || 'This filesystem').toUpperCase()} does not expose permissions or ownership, so those fields are not shown.`)
          : null),
      actions: [
        { label: t('close'), kind: 'text' },
        (canRights || canOwner)
          ? { label: t('apply'), kind: 'filled', onSelect: () => { apply = true; } }
          : null,
      ].filter(Boolean),
      onClose: () => resolve(),
    });
  });
  if (!apply) return null;
  const paths = entries.map((e) => ctx.panel.pathOf(e));
  try {
    if (canRights && rightsField.value.trim()) {
      await backend.fs('setRights', ctx.sessionId, paths, rightsField.value.trim(), { recursive: recurseBox.checked });
      notify.success(t('permsChanged'), rightsField.value.trim());
    }
    if (canOwner && (ownerField.value || groupField.value)) {
      await backend.fs('setOwner', ctx.sessionId, paths, ownerField.value || undefined, groupField.value || undefined, { recursive: recurseBox.checked });
    }
    afterWrite(ctx);
  } catch (err) { fail(err, t('propsTitle')); }
  return null;
}

function rightsToOctal(rights) {
  const s = String(rights || '');
  if (s.length < 9) return '';
  let out = '';
  for (let i = 0; i < 9; i += 3) {
    out += String((s[i] !== '-' ? 4 : 0) + (s[i + 1] !== '-' ? 2 : 0) + (s[i + 2] !== '-' ? 1 : 0));
  }
  return out;
}

export function formatBytes(n, mode) {
  const bytes = Number(n) || 0;
  const style = mode || readPref('formatSizeBytes', 'short');
  if (style === 'none') return bytes.toLocaleString();
  if (style === 'kilo') return `${Math.ceil(bytes / 1024).toLocaleString()} KB`;
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let v = bytes; let u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u += 1; }
  return `${u === 0 ? v.toLocaleString() : v.toFixed(v < 10 ? 1 : 0)} ${units[u]}`;
}

/* ---- editing / opening ---- */

async function openEntry(ctx, mode) {
  const entry = ctx.focused || ctx.selection[0];
  if (!entry) { notify.warning(t('nothingSelected'), ''); return; }
  if (entry.type === 'dir') { ctx.panel.navigate(ctx.panel.pathOf(entry)); return; }
  const path = ctx.panel.pathOf(entry);
  try {
    const req = ctx.isLocal
      ? { localPath: path, mode: mode || 'auto' }
      : { sessionId: ctx.sessionId, remotePath: path, mode: mode || 'auto' };
    const opened = await backend.editor('open', req);
    bus.emit('editor:opened', opened);
    notify.info(t('editorTitle'), oneLine(entry.name, 60));
  } catch (err) { fail(err, t('editorTitle')); }
}

async function openEntryWith(ctx) {
  const entry = ctx.focused || ctx.selection[0];
  if (!entry) { notify.warning(t('nothingSelected'), ''); return; }
  const list = readPref('editor.list', []) || [];
  const items = [
    { value: 'internal', label: t('editorTitle'), icon: 'edit' },
    ...list.filter((e) => e.type === 'external' && e.external)
      .map((e) => ({ value: e.external, label: e.external, icon: 'open_in_new' })),
    { value: '@browse', label: t('browse'), icon: 'folder_open' },
  ];
  let choice = await chooseFrom({ title: t('editWith'), items });
  if (!choice) return;
  if (choice === '@browse') {
    try {
      const picked = await backend.app('pickPath', { title: t('editWith') });
      const file = Array.isArray(picked) ? picked[0] : picked;
      if (!file) return;
      choice = file;
    } catch (err) { fail(err, t('editWith')); return; }
  }
  const path = ctx.panel.pathOf(entry);
  try {
    const req = ctx.isLocal
      ? { localPath: path, mode: choice === 'internal' ? 'internal' : 'external', external: choice === 'internal' ? undefined : choice }
      : { sessionId: ctx.sessionId, remotePath: path, mode: choice === 'internal' ? 'internal' : 'external', external: choice === 'internal' ? undefined : choice };
    const opened = await backend.editor('open', req);
    bus.emit('editor:opened', opened);
  } catch (err) { fail(err, t('editWith')); }
}

defEach(['LocalEditAction2', 'RemoteEditAction2', 'CurrentEditAction'], (name) => ({
  side: name.startsWith('Local') ? 'local' : name.startsWith('Remote') ? 'remote' : 'current',
  enabled: (c) => haveFocus(c) && (c.focused || c.panel.focusedEntry())?.type !== 'dir',
  run: (c) => openEntry(c, 'auto'),
}));
def('CurrentEditFocusedAction', { side: 'current', enabled: haveFocus, run: (c) => openEntry(c, 'auto') });
def('CurrentEditInternalAction', { side: 'current', enabled: haveFocus, run: (c) => openEntry(c, 'internal') });
def('CurrentEditInternalFocusedAction', { side: 'current', enabled: haveFocus, run: (c) => openEntry(c, 'internal') });
def('CurrentEditWithAction', { side: 'current', enabled: haveFocus, run: openEntryWith });
def('CurrentEditWithFocusedAction', { side: 'current', enabled: haveFocus, run: openEntryWith });
def('CurrentOpenAction', {
  side: 'current',
  enabled: haveFocus,
  run: async (c) => {
    const entry = c.focused || c.panel.focusedEntry();
    if (!entry) return;
    if (entry.type === 'dir') { c.panel.navigate(c.panel.pathOf(entry)); return; }
    if (c.isLocal) {
      try { await backend.app('showItemInFolder', c.panel.pathOf(entry)); return; }
      catch (err) { fail(err, t('view_')); return; }
    }
    openEntry(c, 'auto');
  },
});

def('CurrentSystemMenuFocusedAction', {
  side: 'current',
  enabled: (c) => haveFocus(c) && c.isLocal,
  // The Windows shell context menu belongs to the shell extension; what this
  // port can honestly do is reveal the item in the OS file manager.
  run: async (c) => {
    const entry = c.focused || c.panel.focusedEntry();
    try { await backend.app('showItemInFolder', c.panel.pathOf(entry)); }
    catch (err) { fail(err, t('explore')); }
  },
});

/* ---- clipboard / file lists ---- */

defEach(['CurrentCopyToClipboardAction2', 'CurrentCopyToClipboardFocusedAction2'], () => ({
  side: 'current',
  enabled: haveSel,
  run: (c) => copyList(c, true),
}));
def('FileListToClipboardAction', { enabled: haveSel, run: (c) => copyList(c, false) });
def('FullFileListToClipboardAction', { enabled: haveSel, run: (c) => copyList(c, true) });
def('FileListToCommandLineAction', {
  enabled: haveSel,
  run: (c) => {
    const text = selNames(c).map((n) => (/\s/.test(n) ? `"${n}"` : n)).join(' ');
    if (services.workspace?.insertIntoCommandLine) { services.workspace.insertIntoCommandLine(text); return true; }
    notify.warning(t('insertToCmdLine'), t('cmNoCommandLine'));
    return false;
  },
});
def('PasteAction3', {
  enabled: (c) => !!c.panel && online(c),
  run: async (c) => {
    const text = await readClipboard();
    if (!text.trim()) { notify.info(t('pasteClip'), t('cmClipboardEmpty')); return; }
    const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    // A single path that names a directory is a navigation; a list of paths is
    // a transfer request — exactly WinSCP's Paste behaviour.
    if (lines.length === 1 && /^[a-zA-Z]:[\\/]|^[\\/]/.test(lines[0])) {
      c.panel.navigate(lines[0]);
      return;
    }
    await queueTransfer(c, {
      direction: c.isLocal ? 'download' : 'upload',
      files: lines, target: c.panel.path(),
    });
  },
});
def('FileListFromClipboardAction', {
  enabled: (c) => !!c.panel && online(c),
  run: async (c) => {
    const text = await readClipboard();
    const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!lines.length) { notify.info(t('transferClip'), t('cmClipboardNoFiles')); return; }
    await queueTransfer(c, {
      direction: c.isLocal ? 'download' : 'upload',
      files: lines, target: c.panel.path(),
    });
  },
});

def('FileGenerateUrlAction2', {
  enabled: haveSel,
  run: async (c) => {
    if (!c.sessionId) { notify.warning(t('genUrl'), t('notConnected')); return; }
    try {
      const base = await backend.session('url', c.sessionId, { includePassword: false });
      const urls = selPaths(c).map((p) => `${String(base).replace(/\/+$/, '')}${p.startsWith('/') ? '' : '/'}${p}`);
      showText({ title: t('genUrlTitle'), text: urls.join('\n'), fileName: 'file-urls.txt' });
    } catch (err) { fail(err, t('genUrl')); }
  },
});

def('LockAction', {
  enabled: haveSel,
  // WinSCP's file locking is a WebDAV/SharePoint feature exposed through the
  // adapter. No adapter in this port implements it yet, so it is declared.
  unavailable: 'File locking is a WebDAV capability that none of this port\'s adapters implements yet, so nothing would be locked on the server.',
});
def('UnlockAction', {
  enabled: haveSel,
  unavailable: 'File unlocking is a WebDAV capability that none of this port\'s adapters implements yet, so nothing would be unlocked on the server.',
});

defEach(['CalculateDirectorySizesAction', 'LocalCalculateDirectorySizesAction', 'RemoteCalculateDirectorySizesAction'], (name) => ({
  side: name.startsWith('Local') ? 'local' : name.startsWith('Remote') ? 'remote' : 'current',
  enabled: (c) => haveSel(c) && c.selection.some((e) => e.type === 'dir'),
  run: calculateSizes,
}));

/* ---------------- commands menu ---------------- */

def('CompareDirectoriesAction2', {
  enabled: bothPanels,
  run: (c) => {
    const byTime = readPref('scpCommander.compareByTime', true) !== false;
    const bySize = readPref('scpCommander.compareBySize', false) === true;
    const mine = c.panel.entries();
    const theirs = new Map(c.other.entries().map((e) => [e.name.toLowerCase(), e]));
    const differing = [];
    for (const e of mine) {
      if (e.name === '..' || e.type === 'dir') continue;
      const o = theirs.get(e.name.toLowerCase());
      if (!o) { differing.push(e); continue; }
      const sizeDiff = bySize && (o.size || 0) !== (e.size || 0);
      // A two-second tolerance: FAT stores even seconds, so an exact compare
      // marks every file as different after a round trip.
      const timeDiff = byTime && Math.abs((o.mtime || 0) - (e.mtime || 0)) > 2000 && (e.mtime || 0) > (o.mtime || 0);
      if (sizeDiff || timeDiff || (!bySize && !byTime && false)) differing.push(e);
    }
    c.panel.setSelection(differing);
    notify.info(t('compareResult'), `${differing.length} ${differing.length === 1 ? 'file' : 'files'}`);
  },
});

def('SynchronizeAction', {
  enabled: (c) => bothPanels(c) && !!c.sessionId,
  run: (c) => keepUpToDate(c),
});

async function keepUpToDate(ctx) {
  const override = dialogOverrides.get(ctx.name);
  if (override) return override(ctx);
  const localPath = ctx.isLocal ? ctx.panel.path() : ctx.other?.path();
  const remotePath = ctx.isLocal ? ctx.other?.path() : ctx.panel.path();
  const deleteBox = h('input', { type: 'checkbox', class: 'check' });
  const ok = await confirm({
    title: t('kutdTitle'),
    body: t('kutdBody'),
    detail: `${localPath}  →  ${remotePath}`,
    confirmLabel: t('kutdStart'),
    extra: h('label', { class: 'field inline' }, deleteBox, h('span', { class: 'field-label' }, t('syncDeleteFiles'))),
  });
  if (!ok) return;
  try {
    const started = await backend.sync('keepUpToDate', {
      sessionId: ctx.sessionId, localPath, remotePath,
      performDeletions: deleteBox.checked,
    });
    notify.success(t('kutdActive'), `${oneLine(localPath, 40)} → ${oneLine(remotePath, 40)}`, {
      actions: [{ label: t('kutdStop'), onSelect: () => backend.sync('stop', started && started.id).catch(() => {}) }],
    });
  } catch (err) { fail(err, t('kutdTitle')); }
}

def('FullSynchronizeAction2', {
  enabled: (c) => bothPanels(c) && !!c.sessionId,
  run: (c) => fullSynchronize(c),
});

async function fullSynchronize(ctx) {
  const override = dialogOverrides.get('FullSynchronizeAction2');
  if (override) return override(ctx);
  const localPath = ctx.isLocal ? ctx.panel.path() : ctx.other?.path();
  const remotePath = ctx.isLocal ? ctx.other?.path() : ctx.panel.path();
  const dirSel = h('select', { class: 'field-input' },
    h('option', { value: 'remote' }, t('syncRemoteArrow')),
    h('option', { value: 'local' }, t('syncLocalArrow')),
    h('option', { value: 'both' }, t('syncBoth')));
  const modeSel = h('select', { class: 'field-input' },
    h('option', { value: 'sync' }, t('syncFiles')),
    h('option', { value: 'mirror' }, t('syncMirror')),
    h('option', { value: 'timestamps' }, t('syncTimestamps')));
  const critSel = h('select', { class: 'field-input' },
    h('option', { value: 'time' }, t('syncByTime')),
    h('option', { value: 'size' }, t('syncBySize')),
    h('option', { value: 'either' }, t('syncCriteria')));
  const delBox = h('input', { type: 'checkbox', class: 'check' });
  const existingBox = h('input', { type: 'checkbox', class: 'check' });

  let go = false;
  await new Promise((resolve) => {
    openModal({
      title: t('syncTitle'),
      width: 620,
      content: h('div', { class: 'stack' },
        h('p', { class: 'prose mono' }, `${localPath}\n${remotePath}`),
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, t('syncDirection')), dirSel),
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, t('syncMode')), modeSel),
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, t('syncCriteria')), critSel),
        h('label', { class: 'field inline' }, delBox, h('span', { class: 'field-label' }, t('syncDeleteFiles'))),
        h('label', { class: 'field inline' }, existingBox, h('span', { class: 'field-label' }, t('syncExisting')))),
      actions: [
        { label: t('cancel'), kind: 'text' },
        { label: t('syncPreview'), kind: 'filled', autofocus: true, onSelect: () => { go = true; } },
      ],
      onClose: () => resolve(),
    });
  });
  if (!go) return null;

  let compared;
  try {
    compared = await backend.sync('compare', {
      sessionId: ctx.sessionId, localPath, remotePath,
      direction: dirSel.value, mode: modeSel.value, criteria: critSel.value,
      performDeletions: delBox.checked, existingOnly: existingBox.checked,
    });
  } catch (err) { return fail(err, t('syncTitle')); }

  const items = (compared && compared.items) || [];
  if (!items.length) { notify.info(t('syncChecklistTitle'), t('syncNoDiff')); return null; }

  const checked = items.map(() => true);
  const list = h('div', { class: 'stack', style: { maxHeight: '300px', overflow: 'auto' } });
  items.forEach((it, i) => {
    const box = h('input', { type: 'checkbox', class: 'check' });
    box.checked = true;
    box.addEventListener('change', () => { checked[i] = box.checked; });
    list.appendChild(h('label', { class: 'field inline' }, box,
      h('span', { class: 'ellipsis mono', title: `${it.action}: ${it.path || it.name}` },
        `${it.action}  ${it.path || it.name}`)));
  });

  let apply = false;
  await new Promise((resolve) => {
    openModal({
      title: t('syncChecklistTitle'),
      width: 720,
      content: h('div', { class: 'stack' },
        h('p', { class: 'prose' }, `${items.length} ${t('syncAction')}`), list),
      actions: [
        { label: t('cancel'), kind: 'text' },
        { label: t('apply'), kind: 'filled', autofocus: true, onSelect: () => { apply = true; } },
      ],
      onClose: () => resolve(),
    });
  });
  if (!apply) return null;
  try {
    await backend.sync('apply', {
      token: compared.token, checked, onlyChecked: true,
      performDeletions: delBox.checked,
    });
    notify.success(t('syncApplied'), `${checked.filter(Boolean).length} ${t('syncAction')}`);
    afterWrite(ctx, true);
  } catch (err) { fail(err, t('syncTitle')); }
  return null;
}

def('SynchronizeBrowsingAction2', {
  kind: 'toggle',
  enabled: bothPanels,
  checked: () => !!(services.workspace && services.workspace.synchronizedBrowsing()),
  run: () => {
    const ws = services.workspace;
    if (!ws) return false;
    const next = !ws.synchronizedBrowsing();
    ws.setSynchronizedBrowsing(next);
    announce(`${t('synchronizeBrowsing')}: ${next ? t('on') : t('off')}`);
    return next;
  },
});

def('ConsoleAction', {
  enabled: (c) => !!c.sessionId && !!(c.caps && c.caps.exec),
  run: (c) => openConsole(c),
});

/** A real remote console: every line is executed through session:exec. */
async function openConsole(ctx) {
  const override = dialogOverrides.get(ctx.name);
  if (override) return override(ctx);
  const out = h('pre', {
    class: 'mono', tabindex: '0', 'aria-label': t('consoleTitle'),
    style: { maxHeight: '320px', overflow: 'auto', margin: 0, whiteSpace: 'pre-wrap' },
  });
  const input = h('input', { type: 'text', class: 'field-input mono', spellcheck: 'false', autocomplete: 'off' });
  const dirBox = h('input', { type: 'checkbox', class: 'check' });
  dirBox.checked = true;
  const append = (text) => { out.appendChild(document.createTextNode(`${text}\n`)); out.scrollTop = out.scrollHeight; };
  input.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const line = input.value;
    if (!line.trim()) return;
    input.value = '';
    append(`$ ${line}`);
    try {
      const res = await backend.session('exec', ctx.sessionId, line, {
        cwd: dirBox.checked ? ctx.panel?.path() : undefined,
      });
      if (res && res.output) append(res.output);
      if (res && res.exitCode) append(`(exit ${res.exitCode})`);
      ctx.panel?.refresh(true);
    } catch (err) { append(`! ${err.message}`); }
  });
  openModal({
    title: t('consoleTitle'),
    width: 720,
    content: h('div', { class: 'stack' },
      out,
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, t('consolePh')), input),
      h('label', { class: 'field inline' }, dirBox, h('span', { class: 'field-label' }, t('preserveDirChanges')))),
    actions: [{ label: t('close'), kind: 'filled' }],
  });
  requestAnimationFrame(() => input.focus());
}

def('PuttyAction', {
  enabled: (c) => !!c.sessionInfo,
  run: async (c) => {
    const puttyPath = readPref('integration.puttyPath', '%PROGRAMFILES%\\PuTTY\\putty.exe');
    const info = c.sessionInfo;
    if (!info) { notify.warning(t('openPutty'), t('notConnected')); return; }
    // The local-command runner is the same one custom commands use, so PuTTY is
    // launched with exactly the quoting rules the rest of the app applies.
    const line = `"${puttyPath}" -${info.protocol === 'ftp' ? 'telnet' : 'ssh'} ${info.userName ? `${info.userName}@` : ''}${info.hostName}${info.portNumber ? ` -P ${info.portNumber}` : ''}`;
    try {
      await backend.app('runCustomCommand', { command: line, local: true, sessionId: c.sessionId, showResults: false });
      notify.success(t('openPutty'), oneLine(info.hostName, 50));
    } catch (err) { fail(err, t('openPutty')); }
  },
});

def('ClearCachesAction', {
  enabled: (c) => !!c.sessionId,
  run: async (c) => {
    try { await backend.session('clearCache', c.sessionId); notify.success(t('cacheCleared'), ''); c.panel?.refresh(true); }
    catch (err) { fail(err, t('clearCaches')); }
  },
});

def('FileSystemInfoAction', {
  enabled: (c) => !!c.sessionId,
  run: async (c) => {
    try {
      const info = await backend.session('fsInfo', c.sessionId, c.panel?.path());
      const lines = Object.entries(flatten(info)).map(([k, v]) => `${k.padEnd(28)} ${v}`);
      showText({ title: t('srvInfoTitle'), text: lines.join('\n'), fileName: 'server-info.txt', rows: 16 });
    } catch (err) { fail(err, t('serverInfo')); }
  },
});

function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  return out;
}

def('CloseApplicationAction2', {
  run: async () => {
    // WinSCP gates this on ConfirmClosingSession — "Closing sessions when
    // exiting the application" in Preferences. There is no `confirmExit` key
    // in defaults.js, so reading one meant the checkbox could never turn the
    // prompt off.
    if (readPref('confirmClosingSession', true) !== false) {
      const ok = await confirm({ title: t('quitTitle'), body: t('quitBody'), confirmLabel: t('quit'), danger: true });
      if (!ok) return;
    }
    try { await backend.app('quit'); } catch { api.windowClose(); }
  },
});

/* ---- custom commands ---- */

function customCommandList(kind) {
  const all = readPref('customCommands', []) || [];
  return all.filter((c) => {
    const isFile = /![&!]?[\s\S]*/.test(c.command || '') && /!/.test(c.command || '');
    return kind === 'file' ? isFile : !isFile;
  });
}

async function runCustomCommand(ctx, cmd) {
  try {
    const meta = await backend.app('customCommandPrompts', cmd.command, { local: !!cmd.local });
    const answers = {};
    for (const p of meta.prompts || []) {
      const value = await promptText({ title: cmd.name || t('customCmdTitle'), label: p.prompt || p.text || t('value') });
      if (value === null) return null;
      answers[p.id ?? p.index ?? p.prompt] = value;
    }
    const files = selPaths(ctx);
    const res = await backend.app('runCustomCommand', {
      command: cmd.command, local: !!cmd.local, sessionId: ctx.sessionId,
      files, cwd: ctx.isLocal ? ctx.panel?.path() : undefined,
      localPath: ctx.isLocal ? ctx.panel?.path() : ctx.other?.path(),
      remotePath: ctx.isLocal ? ctx.other?.path() : ctx.panel?.path(),
      answers, showResults: !!cmd.showResults, copyResults: !!cmd.copyResults,
    });
    if (res && res.showResults) showText({ title: cmd.name || t('customCmdTitle'), text: res.output || '', rows: 14 });
    else notify.success(cmd.name || t('customCmdTitle'), oneLine(res && res.command, 70));
    ctx.panel?.refresh(true);
    return res;
  } catch (err) { return fail(err, t('customCmdTitle')); }
}

/** Menu items for the custom-command submenus; menus.js renders these. */
export function customCommandItems(ctx, kind) {
  const list = customCommandList(kind);
  if (!list.length) return [{ label: t('cmdCustomHint'), disabled: true }];
  return list.map((cmd) => ({
    label: cmd.name || cmd.command,
    icon: 'terminal',
    description: cmd.command,
    onSelect: () => runCustomCommand(ctx, cmd),
  }));
}

def('CustomCommandsFileAction', {
  enabled: haveSel,
  submenu: (c) => customCommandItems(c, 'file'),
  run: async (c) => {
    const list = customCommandList('file');
    const pick = await chooseFrom({
      title: t('fileCustomCmds'),
      items: list.map((x) => ({ value: x.name || x.command, label: x.name || x.command, detail: x.command })),
      empty: t('cmdCustomHint'),
    });
    const cmd = list.find((x) => (x.name || x.command) === pick);
    if (cmd) await runCustomCommand(c, cmd);
  },
});

def('CustomCommandsNonFileAction', {
  submenu: (c) => customCommandItems(c, 'static'),
  run: async (c) => {
    const list = customCommandList('static');
    const pick = await chooseFrom({
      title: t('staticCustomCmds'),
      items: list.map((x) => ({ value: x.name || x.command, label: x.name || x.command, detail: x.command })),
      empty: t('cmdCustomHint'),
    });
    const cmd = list.find((x) => (x.name || x.command) === pick);
    if (cmd) await runCustomCommand(c, cmd);
  },
});

async function enterCustomCommand(ctx) {
  const localBox = h('input', { type: 'checkbox', class: 'check' });
  const showBox = h('input', { type: 'checkbox', class: 'check' });
  showBox.checked = true;
  const line = await promptText({
    title: t('customCmdTitle'),
    label: t('cmdPattern'),
    body: t('cmdCustomHint'),
    extra: h('div', { class: 'stack' },
      h('label', { class: 'field inline' }, localBox, h('span', { class: 'field-label' }, t('pLocal'))),
      h('label', { class: 'field inline' }, showBox, h('span', { class: 'field-label' }, t('preview')))),
  });
  if (line === null || !line.trim()) return;
  await runCustomCommand(ctx, { command: line.trim(), local: localBox.checked, showResults: showBox.checked });
}

def('CustomCommandsEnterAction', { enabled: (c) => !!c.panel, run: enterCustomCommand });
def('CustomCommandsEnterFocusedAction', { enabled: (c) => !!c.panel, run: enterCustomCommand });

let lastCustomCommand = null;
defEach(['CustomCommandsLastAction', 'CustomCommandsLastFocusedAction'], () => ({
  enabled: () => !!lastCustomCommand,
  run: (c) => (lastCustomCommand ? runCustomCommand(c, lastCustomCommand) : notify.info(t('customCmdTitle'), 'No custom command has been run yet in this session.')),
}));

def('CustomCommandsCustomizeAction', {
  run: () => openPreferencesPage('pCustomCommands'),
});

def('EditorListCustomizeAction', {
  run: () => openPreferencesPage('pEditor'),
});

def('PresetsPreferencesAction', { run: () => openPreferencesPage('pPresets') });
def('QueuePreferencesAction', { run: () => openPreferencesPage('pBackground') });
def('UpdatesPreferencesAction', { run: () => openPreferencesPage('pUpdates') });
def('FileColorsPreferencesAction', { run: () => openPreferencesPage('pFileColors') });
def('PreferencesAction', { run: () => openPreferencesPage('pEnvironment') });

function openPreferencesPage(page) {
  if (services.openDialog) {
    const handle = services.openDialog('preferences', { page });
    if (handle) return handle;
  }
  bus.emit('preferences:open', { page });
  notify.info(t('preferences'), `The preferences surface is not loaded in this build. Theme, language and appearance are on the title bar; ${page} settings live in the preferences module.`);
  return null;
}

/* ---------------- session ---------------- */

def('SiteManagerAction', { run: (c) => siteList(c, t('siteManager')) });
def('SavedSessionsAction2', {
  submenu: () => sitesSubmenu(),
  run: (c) => siteList(c, t('sites')),
});

/** ui/dialogs/login.js takes both of these over with the real Login.dfm. */
function siteList(ctx, title) {
  const override = dialogOverrides.get(ctx.name);
  if (override) return override(ctx);
  return openSiteList(title);
}

async function loadSites() {
  try { return await backend.config('sites') || []; }
  catch { return []; }
}

function sitesSubmenu() {
  // Menus are built synchronously, so the list is served from the document the
  // shell already published and refreshed in the background.
  const sites = (prefCache && prefCache.__sites) || [];
  if (!sites.length) return [{ label: t('emptySites'), disabled: true }];
  return sites.slice(0, 60).map((s) => ({
    label: s.name || s.hostName, icon: 'dns',
    onSelect: () => openSite(s.id),
  }));
}

bus.on('config:document', (doc) => {
  if (doc && Array.isArray(doc.sites)) prefCache.__sites = doc.sites;
});

async function openSiteList(title) {
  const sites = await loadSites();
  const pick = await chooseFrom({
    title,
    items: sites.map((s) => ({
      value: s.id, label: s.name || s.hostName, icon: 'dns',
      detail: `${(s.protocol || '').toUpperCase()} ${s.hostName || ''}`,
    })),
    empty: t('emptySites'),
  });
  if (pick) await openSite(pick);
}

async function openSite(siteId) {
  try {
    const info = await backend.session('open', { siteId, connect: true });
    bus.emit('session:opened', info);
    notify.success(t('connEstablished', info.hostName || info.name || ''), '');
    services.workspace?.attachSession(info);
  } catch (err) { fail(err, t('loginTitle')); }
}

def('DisconnectSessionAction', {
  enabled: (c) => !!c.sessionId,
  run: async (c) => {
    if (readPref('confirmClosingSession', true) !== false) {
      const ok = await confirm({ title: t('disconnect'), body: t('disconnectedMsg', c.sessionInfo?.hostName || ''), confirmLabel: t('disconnect'), danger: true });
      if (!ok) return;
    }
    try { await backend.session('disconnect', c.sessionId); notify.info(t('disconnect'), c.sessionInfo?.hostName || ''); }
    catch (err) { fail(err, t('disconnect')); }
  },
});

def('ReconnectSessionAction', {
  enabled: (c) => !!c.sessionId,
  run: async (c) => {
    try { const info = await backend.session('reconnect', c.sessionId); notify.success(t('connEstablished', info?.hostName || ''), ''); c.panel?.refresh(true); }
    catch (err) { fail(err, t('reconnect')); }
  },
});

def('SaveCurrentSessionAction2', {
  enabled: (c) => !!c.sessionInfo,
  run: async (c) => {
    const name = await promptText({ title: t('saveSessionSite'), label: t('siteName'), value: c.sessionInfo?.name || c.sessionInfo?.hostName || '' });
    if (!name || !name.trim()) return;
    try {
      await backend.config('addSite', { ...siteFromInfo(c.sessionInfo), name: name.trim() });
      notify.success(t('siteSaved'), name.trim());
    } catch (err) { fail(err, t('saveSessionSite')); }
  },
});

function siteFromInfo(info) {
  if (!info) return {};
  return {
    protocol: info.protocol, hostName: info.hostName,
    portNumber: info.portNumber, userName: info.userName,
    remoteDirectory: info.remotePath, localDirectory: info.localPath,
    color: info.color || '',
  };
}

def('SessionGenerateUrlAction2', {
  enabled: (c) => !!c.sessionId,
  run: async (c) => {
    const override = dialogOverrides.get(c.name);
    if (override) return override(c);
    const includeBox = h('input', { type: 'checkbox', class: 'check' });
    const area = h('textarea', { class: 'field-input mono', rows: '6', readonly: true, style: { width: '100%' } });
    const kindSel = h('select', { class: 'field-input' },
      h('option', { value: 'url' }, t('urlTab')),
      h('option', { value: 'script' }, t('scriptTab')),
      h('option', { value: 'net' }, t('netTab')));
    const refresh = async () => {
      try {
        area.value = kindSel.value === 'url'
          ? await backend.session('url', c.sessionId, { includePassword: includeBox.checked })
          : await backend.session('code', c.sessionId, kindSel.value, { includePassword: includeBox.checked });
      } catch (err) { area.value = err.message; }
    };
    kindSel.addEventListener('change', refresh);
    includeBox.addEventListener('change', refresh);
    await refresh();
    openModal({
      title: t('genUrlTitle'),
      width: 660,
      content: h('div', { class: 'stack' },
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, t('name')), kindSel),
        h('label', { class: 'field inline' }, includeBox, h('span', { class: 'field-label' }, t('includePass'))),
        area),
      actions: [
        { label: t('copyClip'), kind: 'text', onSelect: () => { copyText(area.value).then(() => notify.success(t('urlCopied'), '')); return true; } },
        { label: t('close'), kind: 'filled', autofocus: true },
      ],
    });
  },
});

def('ChangePasswordAction', {
  enabled: (c) => !!c.sessionId && c.sessionInfo?.protocol === 'ftp',
  run: async (c) => {
    const oldField = h('input', { type: 'password', class: 'field-input', autocomplete: 'current-password' });
    const newField = h('input', { type: 'password', class: 'field-input', autocomplete: 'new-password' });
    const confirmField = h('input', { type: 'password', class: 'field-input', autocomplete: 'new-password' });
    let go = false;
    await new Promise((resolve) => {
      openModal({
        title: t('changePwTitle'),
        width: 480,
        content: h('div', { class: 'stack' },
          h('label', { class: 'field' }, h('span', { class: 'field-label' }, t('currentPw')), oldField),
          h('label', { class: 'field' }, h('span', { class: 'field-label' }, t('newPw')), newField),
          h('label', { class: 'field' }, h('span', { class: 'field-label' }, t('confirmPw')), confirmField)),
        actions: [
          { label: t('cancel'), kind: 'text' },
          { label: t('ok'), kind: 'filled', autofocus: true, onSelect: () => { go = true; } },
        ],
        onClose: () => resolve(),
      });
    });
    if (!go) return;
    if (newField.value !== confirmField.value) { notify.error(t('changePwTitle'), t('pwMismatch')); return; }
    try {
      await backend.session('changePassword', c.sessionId, oldField.value, newField.value);
      notify.success(t('pwChanged'), '');
    } catch (err) { fail(err, t('changePwTitle')); }
    finally { oldField.value = ''; newField.value = ''; confirmField.value = ''; }
  },
});

def('PrivateKeyUploadAction', {
  enabled: (c) => !!c.sessionId && (c.sessionInfo?.protocol === 'sftp' || c.sessionInfo?.protocol === 'scp'),
  run: async (c) => {
    let picked;
    try { picked = await backend.app('pickPath', { title: t('installKeyTitle') }); }
    catch (err) { return fail(err, t('installKeyTitle')); }
    const file = Array.isArray(picked) ? picked[0] : picked;
    if (!file) return null;
    let keyText = '';
    try {
      const opened = await backend.editor('open', { localPath: file, mode: 'internal' });
      const read = await backend.editor('read', opened.id);
      keyText = String((read && read.text) || '').trim();
      await backend.editor('close', opened.id, { discard: true });
    } catch (err) { return fail(err, t('installKeyTitle')); }
    if (!/^(ssh-|ecdsa-|sk-)/.test(keyText)) {
      notify.error(t('installKeyTitle'), t('cmNotAPublicKey'));
      return null;
    }
    const ok = await confirm({
      title: t('installKeyTitle'), body: t('installKeyBody'),
      detail: `${oneLine(keyText, 60)} → ~/.ssh/authorized_keys`, confirmLabel: t('ok'),
    });
    if (!ok) return null;
    try {
      const home = c.sessionInfo?.home || '.';
      const target = `${String(home).replace(/\/+$/, '')}/.ssh/authorized_keys`;
      let existing = '';
      try {
        const cur = await backend.fs('readFile', c.sessionId, target, {});
        existing = decodeBase64(cur && (cur.base64 || cur));
      } catch { /* the file may not exist yet, which is fine */ }
      if (existing.includes(keyText)) { notify.info(t('installKeyTitle'), t('cmKeyAlreadyThere')); return null; }
      const next = `${existing.replace(/\s*$/, '')}\n${keyText}\n`.replace(/^\n/, '');
      try { await backend.fs('mkdir', c.sessionId, `${String(home).replace(/\/+$/, '')}/.ssh`); } catch { /* exists */ }
      await backend.fs('writeFile', c.sessionId, target, encodeBase64(next));
      if (c.caps && c.caps.rights) {
        await backend.fs('setRights', c.sessionId, [target], 'rw-------', {}).catch(() => {});
      }
      notify.success(t('keyInstalled'), target);
    } catch (err) { fail(err, t('installKeyTitle')); }
    return null;
  },
});

function decodeBase64(b64) {
  if (!b64) return '';
  try { return decodeURIComponent(escape(atob(String(b64)))); } catch { return atob(String(b64)); }
}
function encodeBase64(text) {
  try { return btoa(unescape(encodeURIComponent(text))); } catch { return btoa(text); }
}

/* ---------------- tabs ---------------- */

function strip(ctx) { return ctx.strip || services.strip || appSession.get('strip'); }

def('NewTabAction', {
  submenu: () => [
    { labelKey: 'remoteTab', icon: 'dns', onSelect: () => runAction('NewRemoteTabAction') },
    { labelKey: 'localTab', icon: 'computer', onSelect: () => runAction('NewLocalTabAction') },
    { separator: true },
    {
      labelKey: 'default_', icon: 'star',
      checked: readPref('window.defaultToNewRemoteTab', true) !== false,
      onSelect: () => runAction('DefaultToNewRemoteTabAction'),
    },
  ],
  run: (c) => (readPref('window.defaultToNewRemoteTab', true) !== false
    ? runAction('NewRemoteTabAction', c)
    : runAction('NewLocalTabAction', c)),
});

def('NewRemoteTabAction', {
  enabled: (c) => !!strip(c),
  run: (c) => {
    const s = strip(c);
    if (!s) return null;
    return s.openTab({ title: t('remoteTab'), icon: 'dns', key: `remote-${Date.now().toString(36)}`, data: { kind: 'remote' } });
  },
});
def('NewLocalTabAction', {
  enabled: (c) => !!strip(c),
  run: (c) => {
    const s = strip(c);
    if (!s) return null;
    return s.openTab({ title: t('localTab'), icon: 'computer', key: `local-${Date.now().toString(36)}`, data: { kind: 'local' } });
  },
});
def('DefaultToNewRemoteTabAction', {
  kind: 'toggle',
  checked: () => readPref('window.defaultToNewRemoteTab', true) !== false,
  run: () => togglePref('window.defaultToNewRemoteTab', 'Changed the default new-tab kind'),
});
def('CloseTabAction', {
  enabled: (c) => !!strip(c) && !!strip(c).activeId,
  run: (c) => { const s = strip(c); return s ? s.closeTab(s.activeId) : null; },
});
def('DuplicateTabAction', {
  enabled: (c) => !!strip(c) && !!strip(c).activeId,
  run: (c) => {
    const s = strip(c);
    const tab = s && s.getTab(s.activeId);
    if (!tab) return null;
    return s.openTab({ ...tab, id: undefined, key: undefined, panel: undefined, title: `${tab.title} (2)` });
  },
});
def('RenameTabAction', {
  enabled: (c) => !!strip(c) && !!strip(c).activeId,
  run: async (c) => {
    const s = strip(c);
    const tab = s && s.getTab(s.activeId);
    if (!tab) return;
    const name = await promptText({ title: t('renameTab'), label: t('name'), value: tab.title });
    if (name && name.trim()) s.renameTab(tab.id, name.trim());
  },
});
def('OpenedTabsAction', {
  submenu: (c) => {
    const s = strip(c);
    if (!s) return [{ label: t('noTabsMatched'), disabled: true }];
    return s.tabs.map((tab) => ({
      label: tab.title, icon: tab.icon || 'dns',
      checked: tab.id === s.activeId, radio: true,
      onSelect: () => s.activateTab(tab.id),
    }));
  },
  run: (c) => { const s = strip(c); return s ? s.openMasterSearch() : null; },
});
def('WorkspacesAction', {
  submenu: () => {
    const list = (prefCache && prefCache.__workspaces) || [];
    if (!list.length) return [{ label: t('workspaces'), disabled: true }];
    return list.map((w) => ({ label: w.name, icon: 'layers', onSelect: () => restoreWorkspace(w.name) }));
  },
  run: async () => {
    let list = [];
    try { list = await backend.config('workspaces') || []; } catch { /* none */ }
    const pick = await chooseFrom({
      title: t('workspaces'),
      items: list.map((w) => ({ value: w.name, label: w.name, icon: 'layers' })),
      empty: t('workspaces'),
    });
    if (pick) restoreWorkspace(pick);
  },
});

async function restoreWorkspace(name) {
  try {
    const list = await backend.config('workspaces') || [];
    const ws = list.find((w) => w.name === name);
    if (!ws) { notify.warning(t('workspaces'), `No workspace named ${name}.`); return; }
    for (const s of ws.sessions || []) {
      if (s.siteId) await openSite(s.siteId);
    }
    notify.success(t('workspaceSaved'), name);
  } catch (err) { fail(err, t('workspaces')); }
}

def('SaveWorkspaceAction', {
  run: async (c) => {
    const name = await promptText({ title: t('saveWorkspace'), label: t('name'), value: '' });
    if (!name || !name.trim()) return;
    const s = strip(c);
    const sessions = (s ? s.tabs : []).map((tab) => ({
      title: tab.title, siteId: tab.data && tab.data.siteId,
      localPath: tab.data && tab.data.localPath, remotePath: tab.data && tab.data.remotePath,
    }));
    try {
      await backend.config('saveWorkspace', name.trim(), sessions);
      notify.success(t('workspaceSaved'), name.trim());
    } catch (err) { fail(err, t('saveWorkspace')); }
  },
});

def('ColorMenuAction2', {
  enabled: (c) => !!strip(c) && !!strip(c).activeId,
  run: (c) => {
    const s = strip(c);
    const tab = s && s.getTab(s.activeId);
    if (!tab) return null;
    bus.emit('appearance:open', {
      key: `tab-${tab.key}`,
      element: s.element.querySelector(`[data-tab-id="${tab.id}"]`) || s.element,
      label: `${t('tabColor')}: ${tab.title}`,
    });
    return true;
  },
});

/* ---------------- queue ---------------- */

function queueSelection(ctx) {
  return (ctx.queueItem || (services.queuePanel && services.queuePanel.selected())) || null;
}

const QUEUE_ITEM_ACTIONS = [
  ['QueueItemExecuteAction', (id) => backend.queue('move', id, -1000)],
  ['QueueItemPauseAction', (id) => backend.queue('pause', id)],
  ['QueueItemResumeAction', (id) => backend.queue('resume', id)],
  ['QueueItemDeleteAction', (id) => backend.queue('cancel', id)],
  ['QueueItemUpAction', (id) => backend.queue('move', id, -1)],
  ['QueueItemDownAction', (id) => backend.queue('move', id, 1)],
];
for (const [name, fn] of QUEUE_ITEM_ACTIONS) {
  def(name, {
    enabled: (c) => !!queueSelection(c),
    run: async (c) => {
      const item = queueSelection(c);
      if (!item) return null;
      try { return await fn(item.id); }
      catch (err) { return fail(err, t('queueTitle')); }
    },
  });
}

def('QueueItemQueryAction', {
  enabled: (c) => !!queueSelection(c) && !!queueSelection(c).query,
  run: (c) => { bus.emit('queue:showQuery', queueSelection(c)); return true; },
});
def('QueueItemErrorAction', {
  enabled: (c) => !!queueSelection(c) && !!queueSelection(c).error,
  run: (c) => {
    const item = queueSelection(c);
    showText({ title: t('queueTitle'), text: item.error || '', rows: 8 });
  },
});
def('QueueItemPromptAction', {
  enabled: (c) => !!queueSelection(c) && !!queueSelection(c).prompt,
  run: (c) => { bus.emit('queue:showPrompt', queueSelection(c)); return true; },
});
def('QueueItemSpeedAction', {
  enabled: (c) => !!queueSelection(c),
  run: async (c) => {
    const item = queueSelection(c);
    const v = await promptText({ title: t('speed'), label: `${t('speedLimit')} (B/s, 0 = ${t('none')})`, value: String(item.cpsLimit || 0) });
    if (v === null) return;
    try { await backend.queue('setSpeed', item.id, Number(v) || 0); }
    catch (err) { fail(err, t('speed')); }
  },
});
def('QueueGoToAction', {
  run: () => { bus.emit('queue:focus', {}); return services.queuePanel ? services.queuePanel.focus() : notify.info(t('queueTitle'), t('cmNoQueuePanel')); },
});
def('QueuePauseAllAction', { run: () => backend.queue('pause').catch((e) => fail(e, t('suspendAll'))) });
def('QueueResumeAllAction', { run: () => backend.queue('resume').catch((e) => fail(e, t('resumeAll'))) });
def('QueueDeleteAllAction', {
  run: async () => {
    const ok = await confirm({ title: t('cancelAll'), body: t('cancelAll'), confirmLabel: t('cancelAll'), danger: true });
    if (ok) backend.queue('clear').catch((e) => fail(e, t('cancelAll')));
  },
});
def('QueueDeleteAllDoneAction', {
  run: async () => {
    try {
      const list = await backend.queue('list');
      const done = list.filter((i) => i.state === 'done');
      for (const i of done) await backend.queue('cancel', i.id);
      notify.success(t('deleteCompleted'), `${done.length}`);
    } catch (err) { fail(err, t('deleteCompleted')); }
  },
});
def('QueueEnableAction', {
  kind: 'toggle',
  checked: () => readPref('queue.enabledByDefault', true) !== false,
  run: async () => {
    const next = !(readPref('queue.enabledByDefault', true) !== false);
    await writePref('queue.enabledByDefault', next, 'Changed queue processing');
    try { await backend.queue('setEnabled', next); } catch (err) { fail(err, t('processQueue')); }
    return next;
  },
});

const QUEUE_VIEW = [
  ['QueueShowAction', 'show'], ['QueueHideWhenEmptyAction', 'hideWhenEmpty'], ['QueueHideAction', 'hide'],
];
for (const [name, value] of QUEUE_VIEW) {
  def(name, {
    kind: 'radio',
    checked: () => readPref('queue.view', 'show') === value,
    run: () => {
      const saved = writePref('queue.view', value, 'Changed the queue visibility');
      // QueueShowAction is also the command behind the View menu. Persisting
      // the preference alone leaves an already-running window closed; the
      // queue surface owns the existing queue:open event and can reopen it
      // without creating a second queue or bypassing its controller.
      if (value === 'show') saved.then(() => bus.emit('queue:open', {}));
      return saved;
    },
  });
}
def('QueueToggleShowAction', {
  kind: 'toggle',
  checked: () => readPref('queue.view', 'show') !== 'hide',
  submenu: () => [
    { labelKey: 'queueShow', radio: true, checked: readPref('queue.view', 'show') === 'show', onSelect: () => runAction('QueueShowAction') },
    { labelKey: 'queueHideEmpty', radio: true, checked: readPref('queue.view', 'show') === 'hideWhenEmpty', onSelect: () => runAction('QueueHideWhenEmptyAction') },
    { labelKey: 'queueHide', radio: true, checked: readPref('queue.view', 'show') === 'hide', onSelect: () => runAction('QueueHideAction') },
  ],
  run: () => writePref('queue.view', readPref('queue.view', 'show') === 'hide' ? 'show' : 'hide', 'Changed the queue visibility'),
});
def('QueueToolbarAction', {
  kind: 'toggle',
  checked: () => readPref('queue.toolbar', true) !== false,
  run: () => togglePref('queue.toolbar', 'Changed the queue toolbar'),
});
def('QueueFileListAction', {
  kind: 'toggle',
  checked: () => readPref('queue.fileList', false) === true,
  run: () => togglePref('queue.fileList', 'Changed the queue file list'),
});
// WinSCP's queue is a column list view, so it has a column layout to reset.
// This port's queue (ui/queue.js) renders each transfer as a card with no
// resizable columns at all, so there is no layout for this command to restore.
// It stays registered and says so, rather than raising a success toast for
// work that never happened.
def('QueueResetLayoutColumnsAction', {
  unavailable: 'The queue in this port shows each transfer as a card rather than '
    + 'a column list, so it has no column widths or order to reset. Column layout '
    + 'for the file panels is under Reset Columns on each panel header.',
});

const ONCE_EMPTY = [
  ['QueueIdleOnceEmptyAction', 'none'], ['QueueDisconnectOnceEmptyAction2', 'disconnect'],
  ['QueueSuspendOnceEmptyAction2', 'suspend'], ['QueueShutDownOnceEmptyAction2', 'shutdown'],
];
for (const [name, value] of ONCE_EMPTY) {
  def(name, {
    kind: 'radio',
    checked: () => (readPref('queue.onceEmpty', 'none') || 'none') === value,
    run: () => writePref('queue.onceEmpty', value, 'Changed what happens when the queue empties'),
  });
}
def('QueueCycleOnceEmptyAction', {
  submenu: () => ONCE_EMPTY.map(([n, v]) => ({
    label: t(v === 'none' ? 'stayIdle' : v === 'disconnect' ? 'disconnect' : v === 'suspend' ? 'queueOnceEmpty' : 'shutDownDone'),
    radio: true, checked: (readPref('queue.onceEmpty', 'none') || 'none') === v,
    onSelect: () => runAction(n),
  })),
  run: () => {
    const order = ONCE_EMPTY.map(([, v]) => v);
    const cur = order.indexOf(readPref('queue.onceEmpty', 'none') || 'none');
    return writePref('queue.onceEmpty', order[(cur + 1) % order.length], 'Changed what happens when the queue empties');
  },
});

/* ---------------- view / bands / toggles ---------------- */

const BANDS = [
  ['ExplorerAddressBandAction', 'explorer', 'address'],
  ['ExplorerMenuBandAction', 'explorer', 'menu'],
  ['ExplorerToolbarBandAction', 'explorer', 'buttons'],
  ['ExplorerSelectionBandAction', 'explorer', 'selection'],
  ['ExplorerSessionBandAction2', 'explorer', 'session'],
  ['ExplorerPreferencesBandAction', 'explorer', 'preferences'],
  ['ExplorerSortBandAction', 'explorer', 'sort'],
  ['ExplorerUpdatesBandAction', 'explorer', 'updates'],
  ['ExplorerTransferBandAction', 'explorer', 'transfer'],
  ['ExplorerCustomCommandsBandAction', 'explorer', 'customCommands'],
  ['CommanderMenuBandAction', 'commander', 'menu'],
  ['CommanderSessionBandAction2', 'commander', 'session'],
  ['CommanderPreferencesBandAction', 'commander', 'preferences'],
  ['CommanderSortBandAction', 'commander', 'sort'],
  ['CommanderUpdatesBandAction', 'commander', 'updates'],
  ['CommanderTransferBandAction', 'commander', 'transfer'],
  ['CommanderCommandsBandAction', 'commander', 'commands'],
  ['CommanderCustomCommandsBandAction', 'commander', 'customCommands'],
  ['CommanderLocalHistoryBandAction2', 'commander', 'localHistory'],
  ['CommanderLocalNavigationBandAction2', 'commander', 'localNavigation'],
  ['CommanderLocalFileBandAction2', 'commander', 'localFile'],
  ['CommanderLocalSelectionBandAction2', 'commander', 'localSelection'],
  ['CommanderRemoteHistoryBandAction2', 'commander', 'remoteHistory'],
  ['CommanderRemoteNavigationBandAction2', 'commander', 'remoteNavigation'],
  ['CommanderRemoteFileBandAction2', 'commander', 'remoteFile'],
  ['CommanderRemoteSelectionBandAction2', 'commander', 'remoteSelection'],
  ['CustomCommandsBandAction', 'both', 'customCommands'],
  ['ToolBar2Action', 'both', 'hotkeys'],
];
for (const [name, iface, band] of BANDS) {
  def(name, {
    kind: 'toggle',
    visible: () => iface === 'both' || !services.workspace || services.workspace.interfaceMode() === iface,
    checked: () => !!(services.toolbars && services.toolbars.isBandVisible(band)),
    enabled: () => !!services.toolbars,
    run: () => services.toolbars.toggleBand(band),
  });
}

def('LockToolbarsAction', {
  kind: 'toggle',
  checked: () => readPref('window.lockToolbars', false) === true,
  run: () => togglePref('window.lockToolbars', 'Changed the toolbar lock'),
});
def('SelectiveToolbarTextAction', {
  kind: 'toggle',
  checked: () => readPref('window.selectiveToolbarText', true) !== false,
  run: () => togglePref('window.selectiveToolbarText', 'Changed the toolbar text labels'),
});
def('ToolbarIconSizeAction', {
  submenu: () => ['normal', 'large', 'veryLarge'].map((v, i) => ({
    label: t(['iconsNormal', 'iconsLarge', 'iconsVeryLarge'][i]),
    radio: true, checked: readPref('window.toolbarIconSize', 'normal') === v,
    onSelect: () => writePref('window.toolbarIconSize', v, 'Changed the toolbar icon size'),
  })),
  run: () => {
    const order = ['normal', 'large', 'veryLarge'];
    const cur = order.indexOf(readPref('window.toolbarIconSize', 'normal'));
    return writePref('window.toolbarIconSize', order[(cur + 1) % order.length], 'Changed the toolbar icon size');
  },
});
for (const [name, value] of [['ToolbarIconSizeNormalAction', 'normal'], ['ToolbarIconSizeLargeAction', 'large'], ['ToolbarIconSizeVeryLargeAction', 'veryLarge']]) {
  def(name, {
    kind: 'radio',
    checked: () => readPref('window.toolbarIconSize', 'normal') === value,
    run: () => writePref('window.toolbarIconSize', value, 'Changed the toolbar icon size'),
  });
}
def('CustomizeToolbarAction', {
  enabled: () => !!services.toolbars,
  run: () => services.toolbars.openCustomizer(),
});

def('StatusBarAction', {
  kind: 'toggle',
  checked: () => readPref('scpCommander.statusBar', true) !== false,
  run: () => togglePref('scpCommander.statusBar', 'Changed the status bar'),
});
def('LocalStatusBarAction2', {
  side: 'local', kind: 'toggle',
  checked: () => readPref('scpCommander.localPanel.statusBar', true) !== false,
  run: () => togglePref('scpCommander.localPanel.statusBar', 'Changed the local status bar'),
});
def('RemoteStatusBarAction2', {
  side: 'remote', kind: 'toggle',
  checked: () => readPref('scpCommander.remotePanel.statusBar', true) !== false,
  run: () => togglePref('scpCommander.remotePanel.statusBar', 'Changed the remote status bar'),
});
def('SessionsTabsAction2', {
  kind: 'toggle',
  checked: () => readPref('window.sessionTabs', true) !== false,
  run: () => togglePref('window.sessionTabs', 'Changed the session tab strip'),
});
def('CommandLinePanelAction', {
  kind: 'toggle',
  enabled: () => !!services.workspace,
  checked: () => !!(services.workspace && services.workspace.commandLineVisible()),
  run: () => services.workspace.setCommandLineVisible(!services.workspace.commandLineVisible()),
});
def('GoToCommandLineAction', {
  enabled: () => !!services.workspace,
  run: () => {
    const ws = services.workspace;
    if (!ws.commandLineVisible()) ws.setCommandLineVisible(true);
    return ws.focusCommandLine();
  },
});
def('GoToTreeAction', {
  enabled: (c) => !!c.panel,
  run: (c) => {
    if (!c.panel.treeVisible()) c.panel.setTreeVisible(true);
    return c.panel.focusTree();
  },
});
defEach(['LocalTreeAction', 'RemoteTreeAction'], (name) => ({
  side: name.startsWith('Local') ? 'local' : 'remote',
  kind: 'toggle',
  enabled: havePanel,
  checked: (c) => !!c.panel && c.panel.treeVisible(),
  run: (c) => c.panel.setTreeVisible(!c.panel.treeVisible()),
}));

def('ShowHiddenFilesAction', {
  kind: 'toggle',
  // Without a workspace there are no panels to repaint, so changing the
  // preference would be a successful-looking no-op in previews/headless UI.
  enabled: () => !!services.workspace,
  checked: () => readPref('showHiddenFiles', false) === true,
  run: async () => {
    const next = await togglePref('showHiddenFiles', 'Changed hidden-file visibility');
    services.workspace?.eachPanel((p) => p.setShowHidden(next));
    return next;
  },
});
def('AutoReadDirectoryAfterOpAction', {
  kind: 'toggle',
  checked: () => readPref('autoReadDirectoryAfterOp', true) !== false,
  run: () => togglePref('autoReadDirectoryAfterOp', 'Changed automatic directory reload'),
});
for (const [name, value] of [['FormatSizeBytesNoneAction', 'none'], ['FormatSizeBytesKilobytesAction', 'kilo'], ['FormatSizeBytesShortAction', 'short']]) {
  def(name, {
    kind: 'radio',
    checked: () => readPref('formatSizeBytes', 'short') === value,
    run: async () => {
      await writePref('formatSizeBytes', value, 'Changed the size format');
      services.workspace?.eachPanel((p) => p.repaint());
    },
  });
}
def('CommanderLocalPanelAction', {
  submenu: () => [], // menus.js supplies the panel submenu; this is its header
  enabled: () => !!services.workspace,
  run: () => services.workspace.setActiveSide('local'),
});
def('CommanderRemotePanelAction', {
  submenu: () => [],
  enabled: () => !!services.workspace,
  run: () => services.workspace.setActiveSide('remote'),
});

/* ---------------- help ---------------- */

const LINKS = {
  HomepageAction: 'https://winscp.net/',
  HistoryPageAction: 'https://winscp.net/eng/docs/history',
  ForumPageAction: 'https://winscp.net/forum/',
  DownloadPageAction: 'https://winscp.net/eng/download.php',
  TableOfContentsAction: 'https://winscp.net/eng/docs/start',
};
for (const [name, url] of Object.entries(LINKS)) {
  def(name, { run: () => api.openExternal(url) });
}

// WinSCP's Donate action is deliberately NOT ported. It is registered so the
// coverage ledger records a decision rather than an oversight, and hidden so no
// menu, toolbar, command palette or search result can surface it.
//
// This is one of the few places the port knowingly diverges from the original.
// Asking a user for money is an annoyance, and the shared instructions forbid
// unsolicited promotional prompts outright — including behind a "don't show
// again" switch, which is just an admission that the app nags by default.
// WinSCP is excellent software by other people; the About dialog credits them
// and links to the project. That is the right place for it.
def('DonatePageAction', {
  visible: () => false,
  enabled: () => false,
  unavailable: 'This port does not ask for donations. WinSCP itself is credited '
    + 'and linked from the About dialog — support the original project there.',
});
def('AboutAction', {
  run: () => {
    if (services.openDialog) { const hnd = services.openDialog('about'); if (hnd) return hnd; }
    bus.emit('app:about', {});
    return true;
  },
});
def('CheckForUpdatesAction', {
  run: async () => {
    try {
      const res = await backend.app('checkUpdates', { force: true });
      if (res && res.newVersion) notify.info(t('updatesLatest'), String(res.version || res.newVersion));
      else notify.success(t('checkUpdates'), t('updatesLatest'));
    } catch (err) { fail(err, t('checkUpdates')); }
  },
});
def('TipsAction', {
  run: () => {
    const tips = t('tips');
    showText({ title: t('tipTitle'), text: tips, rows: 10 });
  },
});

/* ================================================================== */
/* build the registry                                                  */
/* ================================================================== */

const registry = new Map();

const I18N_KEYS = {
  RemoteCopyAction: 'downloadDots', RemoteCopyNonQueueAction: 'downloadDots',
  RemoteCopyQueueAction: 'downloadBg', RemoteMoveAction: 'downloadDelete',
  RemoteCopyFocusedAction: 'downloadDots', RemoteCopyFocusedNonQueueAction: 'downloadDots',
  RemoteCopyFocusedQueueAction: 'downloadBg', RemoteMoveFocusedAction: 'downloadDelete',
  LocalCopyAction: 'uploadDots', LocalCopyNonQueueAction: 'uploadDots',
  LocalCopyQueueAction: 'uploadBg', LocalMoveAction: 'uploadDelete',
  LocalCopyFocusedAction: 'uploadDots', LocalCopyFocusedNonQueueAction: 'uploadDots',
  LocalCopyFocusedQueueAction: 'uploadBg', LocalMoveFocusedAction: 'uploadDelete',
  LocalLocalCopyAction: 'copyDots', LocalLocalMoveAction: 'moveDots',
  LocalLocalCopyFocusedAction: 'copyDots', LocalLocalMoveFocusedAction: 'moveDots',
  LocalOtherCopyAction: 'copyDots', LocalOtherMoveAction: 'moveDots',
  RemoteCopyToAction: 'copyDots', RemoteMoveToAction: 'moveTo',
  RemoteCopyToFocusedAction: 'copyDots', RemoteMoveToFocusedAction: 'moveTo',
  LocalRenameAction2: 'rename', RemoteRenameAction2: 'rename', CurrentRenameAction: 'rename',
  LocalDeleteAction2: 'delete_', RemoteDeleteAction2: 'delete_', CurrentDeleteAction: 'delete_',
  CurrentDeleteFocusedAction: 'delete_', CurrentDeleteAlternativeAction: 'delete_',
  LocalEditAction2: 'edit', RemoteEditAction2: 'edit', CurrentEditAction: 'edit',
  CurrentEditFocusedAction: 'edit', CurrentEditWithAction: 'editWith', CurrentEditWithFocusedAction: 'editWith',
  LocalPropertiesAction2: 'properties', RemotePropertiesAction2: 'properties',
  CurrentPropertiesAction: 'properties', CurrentPropertiesFocusedAction: 'properties',
  LocalCreateDirAction3: 'newDirectory', RemoteCreateDirAction3: 'newDirectory',
  CurrentCreateDirAction: 'createDirTitle', NewDirAction: 'newDirectory',
  LocalNewFileAction: 'newFile', RemoteNewFileAction: 'newFile', NewFileAction: 'newFile',
  NewLinkAction: 'newLink', RemoteAddEditLinkAction3: 'newLink', LocalAddEditLinkAction3: 'newShortcut',
  CurrentAddEditLinkAction: 'editLink', CurrentAddEditLinkContextAction: 'editLink',
  LocalBackAction: 'back', RemoteBackAction: 'back', LocalForwardAction: 'forward', RemoteForwardAction: 'forward',
  LocalParentDirAction: 'parentDir', RemoteParentDirAction: 'parentDir',
  LocalRootDirAction: 'rootDir', RemoteRootDirAction: 'rootDir',
  LocalHomeDirAction: 'homeDir', RemoteHomeDirAction: 'homeDir',
  LocalRefreshAction: 'refresh', RemoteRefreshAction: 'refresh',
  LocalOpenDirAction: 'openDirBookmark', RemoteOpenDirAction: 'openDirBookmark',
  LocalAddBookmarkAction2: 'addBookmark', RemoteAddBookmarkAction2: 'addBookmark',
  LocalChangePathAction2: 'changeDrive', LocalPathToClipboardAction2: 'copyPathClip',
  RemotePathToClipboardAction2: 'copyPathClip', LocalFilterAction: 'filterMenu', RemoteFilterAction: 'filterMenu',
  LocalExploreDirectoryAction: 'explore', RemoteExploreDirectoryAction: 'explore',
  RemoteFindFilesAction2: 'findFiles',
  SelectAction: 'selectFiles', LocalSelectAction2: 'selectFiles', RemoteSelectAction2: 'selectFiles',
  UnselectAction: 'unselectFiles', LocalUnselectAction2: 'unselectFiles', RemoteUnselectAction2: 'unselectFiles',
  SelectAllAction: 'selectAll', LocalSelectAllAction2: 'selectAll', RemoteSelectAllAction2: 'selectAll',
  InvertSelectionAction: 'invertSel', ClearSelectionAction: 'clearSel', RestoreSelectionAction: 'restoreSel',
  SelectSameExtAction: 'selectSameExt', UnselectSameExtAction: 'unselectSameExt',
  LocalSortByNameAction2: 'byName', RemoteSortByNameAction2: 'byName', CurrentSortByNameAction: 'byName',
  LocalSortByExtAction2: 'byExt', RemoteSortByExtAction2: 'byExt', CurrentSortByExtAction: 'byExt',
  LocalSortBySizeAction2: 'bySize', RemoteSortBySizeAction2: 'bySize', CurrentSortBySizeAction: 'bySize',
  LocalSortByTypeAction2: 'byType', RemoteSortByTypeAction2: 'byType', CurrentSortByTypeAction2: 'byType',
  LocalSortByChangedAction3: 'byChanged', RemoteSortByChangedAction3: 'byChanged', CurrentSortByChangedAction2: 'byChanged',
  LocalSortByAttrAction2: 'colAttr', RemoteSortByRightsAction2: 'byRights', CurrentSortByRightsAction: 'byRights',
  RemoteSortByOwnerAction2: 'byOwner', CurrentSortByOwnerAction: 'byOwner',
  RemoteSortByGroupAction2: 'byGroup', CurrentSortByGroupAction: 'byGroup',
  LocalSortAscendingAction2: 'ascending', RemoteSortAscendingAction2: 'ascending', CurrentSortAscendingAction: 'ascending',
  SortColumnAscendingAction: 'sortAsc', SortColumnDescendingAction: 'sortDesc',
  ShowHideRemoteNameColumnAction2: 'colName', ShowHideLocalNameColumnAction2: 'colName',
  ShowHideRemoteSizeColumnAction2: 'colSize', ShowHideLocalSizeColumnAction2: 'colSize',
  ShowHideRemoteTypeColumnAction2: 'colType', ShowHideLocalTypeColumnAction2: 'colType',
  ShowHideRemoteChangedColumnAction3: 'colChanged', ShowHideLocalChangedColumnAction3: 'colChanged',
  ShowHideRemoteRightsColumnAction2: 'colRights', ShowHideLocalAttrColumnAction2: 'colAttr',
  ShowHideRemoteOwnerColumnAction2: 'colOwner', ShowHideRemoteGroupColumnAction2: 'colGroup',
  ShowHideRemoteLinkTargetColumnAction2: 'colLinkTarget',
  ShowHideRemoteExtColumnAction2: 'colExt', ShowHideLocalExtColumnAction2: 'colExt',
  RemoteReportAction: 'details', LocalReportAction: 'details',
  RemoteThumbnailAction: 'thumbnails', LocalThumbnailAction: 'thumbnails',
  RemoteCycleStyleAction: 'view_',
  CompareDirectoriesAction2: 'compareDirs', SynchronizeAction: 'keepUpToDate',
  FullSynchronizeAction2: 'synchronizeMenu', SynchronizeBrowsingAction2: 'synchronizeBrowsing',
  ConsoleAction: 'openTerminal', PuttyAction: 'openPutty', ClearCachesAction: 'clearCaches',
  FileSystemInfoAction: 'serverInfo', CloseApplicationAction2: 'quit',
  CustomCommandsFileAction: 'fileCustomCmds', CustomCommandsNonFileAction: 'staticCustomCmds',
  CustomCommandsCustomizeAction: 'customizeCmds',
  FileListToCommandLineAction: 'insertToCmdLine', FileListToClipboardAction: 'copyListClip',
  FullFileListToClipboardAction: 'copyListPathsClip', PasteAction3: 'pasteClip',
  FileListFromClipboardAction: 'transferClip', FileGenerateUrlAction2: 'genUrl',
  CurrentCopyToClipboardAction2: 'copyClip', CurrentCopyToClipboardFocusedAction2: 'copyClip',
  LockAction: 'lockTab', UnlockAction: 'unlockTab',
  CalculateDirectorySizesAction: 'calcSize', LocalCalculateDirectorySizesAction: 'calcSize',
  RemoteCalculateDirectorySizesAction: 'calcSize',
  SiteManagerAction: 'newConnection', SavedSessionsAction2: 'sites',
  DisconnectSessionAction: 'disconnect', ReconnectSessionAction: 'reconnect',
  SaveCurrentSessionAction2: 'saveSessionSite', SessionGenerateUrlAction2: 'genUrlSite',
  ChangePasswordAction: 'changePassword', PrivateKeyUploadAction: 'installKey',
  NewTabAction: 'newTab', NewLocalTabAction: 'localTab', NewRemoteTabAction: 'remoteTab',
  CloseTabAction: 'closeTab', DuplicateTabAction: 'duplicateTab', RenameTabAction: 'renameTab',
  OpenedTabsAction: 'openedTabs', WorkspacesAction: 'workspaces', SaveWorkspaceAction: 'saveWorkspace',
  ColorMenuAction2: 'tabColor',
  QueueItemPauseAction: 'suspend', QueueItemResumeAction: 'resume',
  QueuePauseAllAction: 'suspendAll', QueueResumeAllAction: 'resumeAll',
  QueueDeleteAllAction: 'cancelAll', QueueDeleteAllDoneAction: 'deleteCompleted',
  QueueEnableAction: 'processQueue', QueueToggleShowAction: 'queueMenu',
  QueueShowAction: 'queueShow', QueueHideWhenEmptyAction: 'queueHideEmpty', QueueHideAction: 'queueHide',
  QueueCycleOnceEmptyAction: 'queueOnceEmpty', QueueIdleOnceEmptyAction: 'stayIdle',
  QueueDisconnectOnceEmptyAction2: 'disconnect', QueueShutDownOnceEmptyAction2: 'shutDownDone',
  QueueItemSpeedAction: 'speed',
  LockToolbarsAction: 'lockToolbars', SelectiveToolbarTextAction: 'selectiveLabels',
  ToolbarIconSizeAction: 'iconsSize', ToolbarIconSizeNormalAction: 'iconsNormal',
  ToolbarIconSizeLargeAction: 'iconsLarge', ToolbarIconSizeVeryLargeAction: 'iconsVeryLarge',
  StatusBarAction: 'statusBarMenu', LocalStatusBarAction2: 'statusBarMenu', RemoteStatusBarAction2: 'statusBarMenu',
  CommandLinePanelAction: 'commandLineMenu', GoToCommandLineAction: 'goToCmdLine',
  GoToTreeAction: 'goToTree', LocalTreeAction: 'treeToggle', RemoteTreeAction: 'treeToggle',
  ShowHiddenFilesAction: 'showHiddenFiles', AutoReadDirectoryAfterOpAction: 'autoReload',
  FormatSizeBytesNoneAction: 'bytes_', FormatSizeBytesKilobytesAction: 'kilobytes', FormatSizeBytesShortAction: 'shortFmt',
  FileColorsPreferencesAction: 'fileColorsMenu', PreferencesAction: 'preferences',
  CommanderLocalPanelAction: 'localPanel', CommanderRemotePanelAction: 'remotePanel',
  AboutAction: 'aboutMenu', HomepageAction: 'homepage', HistoryPageAction: 'versionHistory',
  ForumPageAction: 'supportForum', CheckForUpdatesAction: 'checkUpdates',
  TableOfContentsAction: 'docs', TipsAction: 'showTips',
  CurrentOpenAction: 'view_', CurrentEditInternalAction: 'editorTitle', CurrentEditInternalFocusedAction: 'editorTitle',
  SelectOneAction: 'selectFiles',
};

/**
 * The glyph for an action. Returning null matters: WinSCP shows no icon beside
 * most menu items, and a generic chevron there reads as "this opens a submenu"
 * when it does not. Toolbars substitute a neutral glyph because a button with
 * no icon has nothing to click.
 */
function iconFor(name, action) {
  if (/CopyQueue|CopyNonQueue|CopyAction|CopyFocused/.test(name)) return name.startsWith('Local') ? 'upload' : 'download';
  if (/Move/.test(name)) return name.startsWith('Local') ? 'upload' : 'download';
  if (/Delete/.test(name)) return 'delete';
  if (/Refresh/.test(name)) return 'refresh';
  if (/Rename/.test(name)) return 'edit';
  if (/Edit/.test(name)) return 'edit';
  if (/Properties/.test(name)) return 'info';
  if (/CreateDir|NewDir/.test(name)) return 'folder';
  if (/NewFile/.test(name)) return 'description';
  if (/Link/.test(name)) return 'open_in_new';
  if (/Parent/.test(name)) return 'arrow_upward';
  if (/Back/.test(name)) return 'chevron_left';
  if (/Forward/.test(name)) return 'chevron_right';
  if (/Root|Home/.test(name)) return 'folder_open';
  if (/Bookmark/.test(name)) return 'bookmark';
  if (/Filter/.test(name)) return 'filter';
  if (/Find/.test(name)) return 'search';
  if (/Select|Unselect|Invert/.test(name)) return 'select_all';
  if (/Sort/.test(name)) return 'unfold_more';
  if (/Column/.test(name)) return 'view_column';
  if (/Queue/.test(name)) return 'playlist';
  if (/Console|Putty/.test(name)) return 'terminal';
  if (/Synchronize|Compare/.test(name)) return 'sync_alt';
  if (/Tab/.test(name)) return 'topic';
  if (/Session|Site/.test(name)) return 'dns';
  if (/Preferences|Customize/.test(name)) return 'settings';
  if (/Clipboard|Paste/.test(name)) return 'content_copy';
  if (/Tree/.test(name)) return 'group_work';
  if (/Thumbnail/.test(name)) return 'wysiwyg';
  if (/Report|List|Icon/.test(name)) return 'view_column';
  if (/About|Homepage|Forum|Donate|Download|Contents|Tips|History/.test(name)) return 'help';
  if (/Update/.test(name)) return 'restart_alt';
  if (/Calculate/.test(name)) return 'numbers';
  if (/ChangePath|OtherDir|GoToAddress/.test(name)) return 'folder_open';
  if (/Lock|Unlock/.test(name)) return 'key';
  if (/StatusBar|CommandLine/.test(name)) return 'wysiwyg';
  if (/Hidden/.test(name)) return 'visibility';
  if (/Color/.test(name)) return 'palette';
  if (/Workspace/.test(name)) return 'layers';
  if (/Quit|CloseApplication/.test(name)) return 'close';
  if (action && action.opensDialog) return 'tune';
  return null;
}

/** The user-facing label: an i18n key where one exists, the WinSCP caption otherwise. */
export function actionLabel(name) {
  const key = I18N_KEYS[name];
  if (key) return t(key);
  const a = ACTIONS_BY_NAME[name];
  // A caption that is just the action's own identifier is WinSCP's placeholder
  // for a programmatic action; show the hint instead of the class name.
  if (a && a.caption && a.caption !== name) return a.caption;
  return (a && (a.hint || a.description)) || name;
}

export function actionLabelKey(name) { return I18N_KEYS[name] || null; }

function buildRegistry() {
  for (const action of ACTIONS) {
    const spec = DEFS[action.name] || null;
    const glyph = iconFor(action.name, action);
    const cmd = {
      name: action.name,
      id: `winscp.${action.name}`,
      action,
      category: action.category,
      side: (spec && spec.side) || action.side,
      focused: action.focused,
      shortcut: action.shortcut || '',
      kind: (spec && spec.kind) || 'command',
      // `hasIcon` is what menus consult; `icon` is always renderable so a
      // toolbar button is never an empty rectangle.
      hasIcon: !!glyph,
      icon: glyph || 'label',
      opensDialog: action.opensDialog,
      hint: action.hint || action.description || '',
      helpKeyword: action.helpKeyword || '',
      submenu: spec && spec.submenu ? spec.submenu : null,
      _spec: spec,
    };
    if (!spec) {
      // Never reachable: the guard below turns a gap into a loud failure at
      // import time rather than a menu entry that quietly does nothing.
      throw new Error(`commands.js has no handler for "${action.name}" (${action.category})`);
    }
    cmd.unavailableReason = typeof spec.unavailable === 'function' ? spec.unavailable : (spec.unavailable || null);
    registry.set(action.name, cmd);
  }
  return registry;
}

buildRegistry();

/* ================================================================== */
/* running                                                             */
/* ================================================================== */

export function getCommand(name) { return registry.get(name) || null; }
export function listActionCommands() { return Array.from(registry.values()); }
export function commandsByCategory(category) {
  return listActionCommands().filter((c) => c.category === category);
}

function unavailableReason(cmd, ctx) {
  const r = cmd.unavailableReason;
  if (!r) return null;
  return typeof r === 'function' ? r(ctx) : r;
}

/** enabled / visible / checked / reason for one action, in one call. */
export function commandState(name, over = {}) {
  const cmd = registry.get(name);
  if (!cmd) return { exists: false, enabled: false, visible: false, checked: undefined, reason: `"${name}" is not a WinSCP action.` };
  const ctx = makeContext(cmd, over);
  const reason = unavailableReason(cmd, ctx);
  const spec = cmd._spec;
  let visible = true;
  let enabled = true;
  let checked;
  try { visible = spec.visible ? !!spec.visible(ctx) : true; } catch { visible = true; }
  try { enabled = reason ? false : (spec.enabled ? !!spec.enabled(ctx) : true); } catch { enabled = false; }
  try { checked = spec.checked ? !!spec.checked(ctx) : undefined; } catch { checked = undefined; }
  if (!backend.present && spec.needsBridge !== false && NEEDS_BRIDGE.has(cmd.category)) {
    return { exists: true, enabled: false, visible, checked, reason: backend.reason, ctx };
  }
  return { exists: true, enabled, visible, checked, reason, ctx };
}

/** Categories whose commands genuinely cannot work without the main process. */
const NEEDS_BRIDGE = new Set([
  'Local Directory', 'Remote Directory', 'Local Selected Operation', 'Local Focused Operation',
  'Remote Selected Operation', 'Remote Focused Operation', 'Selected Operation', 'Focused Operation',
  'Queue', 'Session',
]);

/** Run an action. Returns whatever the handler returns, or null when refused. */
export function runAction(name, over = {}) {
  const cmd = registry.get(name);
  if (!cmd) { notify.warning('Unknown command', `"${name}" is not a WinSCP action.`); return null; }
  const state = commandState(name, over);
  if (state.reason) {
    // Explicitly unavailable: say why, every time, rather than doing nothing.
    notify.warning(actionLabel(name), state.reason);
    return null;
  }
  if (!state.enabled) {
    notify.info(actionLabel(name), disabledExplanation(cmd, state.ctx));
    return null;
  }
  try {
    const result = cmd._spec.run(state.ctx);
    if (result && typeof result.then === 'function') {
      return result.catch((err) => fail(err, actionLabel(name)));
    }
    return result;
  } catch (err) { return fail(err, actionLabel(name)); }
}

/** Why a command is greyed out, in words the user can act on. */
function disabledExplanation(cmd, ctx) {
  if (!ctx.panel) return t('cmNoPanelYet');
  if (!ctx.isLocal && !ctx.connected) return t('notConnected');
  if (cmd.focused && !ctx.focused) return t('nothingSelected');
  if (!ctx.selection.length && /Selected Operation|Selection/.test(cmd.category)) return t('nothingSelected');
  if (ctx.caps) {
    const protocol = (ctx.sessionInfo && ctx.sessionInfo.protocol) || 'this filesystem';
    if (/Rights|Permission/.test(cmd.name) && !ctx.caps.rights) return t('cmNoRights', protocol.toUpperCase());
    if (/Owner|Group/.test(cmd.name) && !ctx.caps.owner) return t('cmNoOwner', protocol.toUpperCase());
    if (/Link/.test(cmd.name) && !ctx.caps.symlink) return t('cmNoSymlink', protocol.toUpperCase());
  }
  return t('cmNotApplicable');
}

/* ================================================================== */
/* keyboard shortcuts                                                  */
/* ================================================================== */

/** Normalise "Ctrl+Num +" / "Shift+Alt+Enter" to a comparable canonical form. */
export function normalizeShortcut(shortcut) {
  let s = String(shortcut || '').trim();
  if (!s) return '';
  const mods = { ctrl: false, shift: false, alt: false, meta: false };
  for (;;) {
    const m = s.match(/^(Ctrl|Shift|Alt|Meta|Cmd)\s*\+\s*/i);
    if (!m) break;
    const k = m[1].toLowerCase();
    mods[k === 'cmd' ? 'meta' : k] = true;
    s = s.slice(m[0].length);
  }
  const key = canonicalKey(s.trim());
  return `${mods.ctrl ? 'Ctrl+' : ''}${mods.alt ? 'Alt+' : ''}${mods.shift ? 'Shift+' : ''}${mods.meta ? 'Meta+' : ''}${key}`;
}

function canonicalKey(raw) {
  const s = String(raw).trim();
  const num = s.match(/^Num\s*([+\-*/])$/i);
  if (num) return `Num${num[1]}`;
  const map = {
    esc: 'Escape', escape: 'Escape', del: 'Delete', ins: 'Insert', enter: 'Enter',
    return: 'Enter', space: 'Space', backspace: 'Backspace', tab: 'Tab',
    left: 'ArrowLeft', right: 'ArrowRight', up: 'ArrowUp', down: 'ArrowDown',
    pgup: 'PageUp', pgdn: 'PageDown', home: 'Home', end: 'End',
  };
  const low = s.toLowerCase();
  if (map[low]) return map[low];
  if (/^f\d{1,2}$/i.test(s)) return s.toUpperCase();
  if (s.length === 1) return s.toUpperCase();
  return s;
}

/** The canonical shortcut a keyboard event represents. */
export function eventShortcut(e) {
  let key;
  switch (e.code) {
    case 'NumpadAdd': key = 'Num+'; break;
    case 'NumpadSubtract': key = 'Num-'; break;
    case 'NumpadMultiply': key = 'Num*'; break;
    case 'NumpadDivide': key = 'Num/'; break;
    default: key = canonicalKey(e.key === ' ' ? 'Space' : e.key);
  }
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return '';
  return `${e.ctrlKey ? 'Ctrl+' : ''}${e.altKey ? 'Alt+' : ''}${e.shiftKey ? 'Shift+' : ''}${e.metaKey ? 'Meta+' : ''}${key}`;
}

/** shortcut -> [action names], built once from actions.js. */
export const SHORTCUTS = (() => {
  const map = new Map();
  for (const a of ACTIONS) {
    if (!a.shortcut) continue;
    const key = normalizeShortcut(a.shortcut);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(a.name);
  }
  return map;
})();

/**
 * A conflict is two actions claiming one shortcut that cannot be told apart by
 * the focused panel — Local/Remote/Current pairs are resolvable and are not
 * reported. Anything left is a genuine ambiguity and is logged at startup.
 */
export function shortcutConflicts() {
  const out = [];
  for (const [key, names] of SHORTCUTS) {
    if (names.length < 2) continue;
    const bySide = new Map();
    for (const n of names) {
      const cmd = registry.get(n);
      const side = cmd ? cmd.side : 'both';
      // A *Focused* variant is reached from a context menu, never the keyboard.
      if (cmd && cmd.focused) continue;
      if (!bySide.has(side)) bySide.set(side, []);
      bySide.get(side).push(n);
    }
    for (const [side, list] of bySide) {
      if (list.length > 1) out.push({ shortcut: key, side, actions: list.slice() });
    }
  }
  return out;
}

function reportShortcutConflicts() {
  const conflicts = shortcutConflicts();
  if (!conflicts.length) return;
  for (const c of conflicts) {
    console.warn(`[commands] ${c.shortcut} is claimed by ${c.actions.length} ${c.side} actions: ${c.actions.join(', ')}. The first enabled one wins.`);
  }
}

/** Pick the action a shortcut should run, given the focused panel. */
export function resolveShortcut(key, over = {}) {
  // Callers include the command palette, native-menu bridge and tests; some
  // provide the human spelling (for example `ctrl + f3`) rather than the
  // event spelling. Normalize at this boundary so shortcut metadata does not
  // silently become unreachable outside the DOM keydown handler.
  const names = SHORTCUTS.get(normalizeShortcut(key));
  if (!names || !names.length) return null;
  const ws = services.workspace;
  const activeSide = over.side || (ws && ws.activeSide ? ws.activeSide() : 'remote');
  const ranked = names
    .map((n) => registry.get(n))
    .filter(Boolean)
    // Focused variants belong to context menus; the keyboard uses the selection.
    .filter((c) => !c.focused)
    .sort((a, b) => rank(a) - rank(b));
  function rank(cmd) {
    if (cmd.side === activeSide) return 0;
    if (cmd.side === 'current') return 1;
    if (cmd.side === 'both') return 2;
    return 3;
  }
  for (const cmd of ranked) {
    const st = commandState(cmd.name, over);
    if (st.visible && st.enabled) return cmd.name;
  }
  return ranked.length ? ranked[0].name : null;
}

let shortcutsInstalled = false;
function installShortcutHandler() {
  if (shortcutsInstalled) return;
  shortcutsInstalled = true;
  window.addEventListener('keydown', (e) => {
    // A text field owns its own keys; only the panel's own incremental search
    // opts back in, and it does that from the panel, not from here.
    const el = e.target;
    if (el && el.closest && el.closest('input,textarea,select,[contenteditable="true"]')) {
      const combo = eventShortcut(e);
      if (!/^(Ctrl|Alt|Meta)/.test(combo)) return;
    }
    if (document.querySelector('.modal-scrim')) return;   // a modal owns the keyboard
    const key = eventShortcut(e);
    if (!key || !SHORTCUTS.has(key)) return;
    const name = resolveShortcut(key);
    if (!name) return;
    const state = commandState(name);
    if (!state.visible) return;
    e.preventDefault();
    e.stopPropagation();
    runAction(name);
  }, true);
}

/* ================================================================== */
/* shell publication and the coverage ledger                           */
/* ================================================================== */

let published = false;
function publishToShell() {
  if (published || typeof services.registerShellCommand !== 'function') return;
  published = true;
  for (const cmd of registry.values()) {
    services.registerShellCommand({
      id: cmd.id,
      label: actionLabel(cmd.name),
      labelKey: actionLabelKey(cmd.name) || undefined,
      icon: cmd.icon,
      shortcut: cmd.shortcut,
      run: (over) => runAction(cmd.name, over || {}),
    });
  }
}

/**
 * The honest ledger. `bound` is every action with a real handler, `declared`
 * is every action registered as explicitly unavailable with a reason, and
 * `missing` must always be empty — buildRegistry() throws otherwise.
 */
export function commandCoverage() {
  const declared = [];
  const missing = [];
  const byCategory = {};
  for (const a of ACTIONS) {
    const cmd = registry.get(a.name);
    if (!cmd) { missing.push(a.name); continue; }
    byCategory[a.category] = byCategory[a.category] || { total: 0, declared: 0 };
    byCategory[a.category].total += 1;
    if (cmd.unavailableReason) {
      byCategory[a.category].declared += 1;
      declared.push({
        name: a.name,
        category: a.category,
        reason: typeof cmd.unavailableReason === 'function' ? cmd.unavailableReason({}) : cmd.unavailableReason,
      });
    }
  }
  return {
    total: ACTIONS.length,
    registered: registry.size,
    bound: registry.size - declared.length,
    declared,
    missing,
    byCategory,
    shortcuts: SHORTCUTS.size,
    shortcutActions: ACTIONS.filter((a) => a.shortcut).length,
    conflicts: shortcutConflicts(),
  };
}

/** A readable report, used by the docs and by anyone auditing the port. */
export function coverageReport() {
  const c = commandCoverage();
  const lines = [
    `Actions: ${c.total}  bound: ${c.bound}  declared unavailable: ${c.declared.length}  missing: ${c.missing.length}`,
    `Shortcuts: ${c.shortcutActions} actions over ${c.shortcuts} distinct combinations, ${c.conflicts.length} unresolved conflicts`,
    '',
  ];
  for (const [cat, v] of Object.entries(c.byCategory).sort()) {
    lines.push(`${cat.padEnd(28)} ${String(v.total - v.declared).padStart(3)}/${String(v.total).padStart(3)}`);
  }
  if (c.declared.length) {
    lines.push('', 'Declared unavailable:');
    for (const d of c.declared) lines.push(`  ${d.name} — ${d.reason}`);
  }
  if (c.conflicts.length) {
    lines.push('', 'Shortcut conflicts:');
    for (const k of c.conflicts) lines.push(`  ${k.shortcut} (${k.side}): ${k.actions.join(', ')}`);
  }
  return lines.join('\n');
}

export { registry as commandRegistry };
