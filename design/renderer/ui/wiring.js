// ui/wiring.js — the integration seam between the command layer and the dialogs.
//
// Seven workstreams landed concurrently. Two of them ended up owning the same
// ground: ui/commands.js binds all 301 actions and ships its own plain modal
// for the dialog-heavy ones, while ui/dialogs/*.js carries the forms.json-
// complete port of those same forms. Both are real; only one may be reachable,
// otherwise a user gets whichever the load order happened to pick.
//
// This module is where that is decided, in one place, explicitly: for every
// action that has a full dialog, `registerActionDialog` points the action at it
// and the inline fallback in commands.js becomes what it should have been all
// along — the surface a stripped build falls back to.
//
// Nothing here implements behaviour. It translates the command layer's context
// (`ctx`: the focused panel, the selection, the session and its caps) into the
// props each dialog documents, and hands the dialog's result back to the panel
// so the list refreshes. If a dialog is added later, one line here is what
// makes it the one the user reaches.

import { registerActionDialog, services, queueTransfer, readPref } from './commands.js';
import { bus, session as appSession } from '../state.js';
import { notify } from './notifications.js';
import { t, defineStrings } from '../i18n.js';

/* The dialog modules. Importing them is what registers their dialog ids with
 * the shell; the named imports are the openers this file routes actions to. */
import { openProperties } from './dialogs/properties.js';
import { openCreateDirectory } from './dialogs/createdirectory.js';
import { openSymlinkDialog } from './dialogs/symlink.js';
import { openSelectMask } from './dialogs/selectmask.js';
import { openDirectoryDialog, describeShortcut } from './dialogs/opendirectory.js';
import { openRemoteTransfer } from './dialogs/remotetransfer.js';
import { openFileFind } from './dialogs/filefind.js';
import { openLogin } from './dialogs/login.js';
import { openGenerateUrl } from './dialogs/generateurl.js';
import { openConsole } from './dialogs/console.js';
import { openSynchronizeDialog, openKeepUpToDateDialog } from './dialogs/synchronize.js';
import { openCopyDialog } from './dialogs/copyparams.js';
import { readProfiles } from './dialogs/locationprofiles.js';
import './dialogs/editmask.js';
import './dialogs/importsessions.js';
import './dialogs/siteadvanced.js';

defineStrings({
  wrShortcutNoPanel: [
    'That shortcut has a destination, but there is no file panel open to take it there.',
    '嗰個快速鍵有目的地，但係而家冇開住檔案面板可以帶你去。',
  ],
  wrProfileApplied: ['Location profile "{0}" applied.', '位置組合「{0}」用咗。'],
});

/* ================================================================== */
/* context -> props                                                    */
/* ================================================================== */

/** Every entry a dialog is handed carries its full path, so it never guesses. */
function entriesOf(ctx) {
  const panel = ctx.panel;
  return ctx.selection
    .filter((e) => e && e.name !== '..')
    .map((e) => ({ ...e, path: panel && panel.pathOf ? panel.pathOf(e) : e.path }));
}

function baseProps(ctx) {
  return {
    sessionId: ctx.sessionId,
    side: ctx.side,
    directory: ctx.panel ? ctx.panel.path() : '',
    caps: ctx.caps,
    protocolName: (ctx.sessionInfo && ctx.sessionInfo.protocol
      ? String(ctx.sessionInfo.protocol).toUpperCase()
      : (ctx.isLocal ? 'Local' : '')),
  };
}

/** Refresh the panel the command acted on, once the dialog reports it changed something. */
function refresh(ctx) {
  ctx.panel?.refresh(true);
}

/* ================================================================== */
/* the routing table                                                   */
/* ================================================================== */

const PROPERTIES = [
  'LocalPropertiesAction2', 'RemotePropertiesAction2',
  'CurrentPropertiesAction', 'CurrentPropertiesFocusedAction',
];
const CREATE_DIR = ['LocalCreateDirAction3', 'RemoteCreateDirAction3', 'CurrentCreateDirAction', 'NewDirAction'];
const LINK = ['LocalAddEditLinkAction3', 'RemoteAddEditLinkAction3', 'NewLinkAction',
  'CurrentAddEditLinkAction', 'CurrentAddEditLinkContextAction'];
const SELECT = ['SelectAction', 'LocalSelectAction2', 'RemoteSelectAction2'];
const UNSELECT = ['UnselectAction', 'LocalUnselectAction2', 'RemoteUnselectAction2'];
const OPEN_DIR = ['LocalOpenDirAction', 'RemoteOpenDirAction'];
const DUPLICATE = ['RemoteCopyToAction', 'RemoteMoveToAction',
  'RemoteCopyToFocusedAction', 'RemoteMoveToFocusedAction'];
const SITE_MANAGER = ['SiteManagerAction', 'SavedSessionsAction2'];

let installed = false;

export function installWiring() {
  if (installed) return;
  installed = true;

  /* ---- Properties (forms/Properties.dfm, 40 controls) ---- */
  for (const name of PROPERTIES) {
    registerActionDialog(name, (ctx) => {
      const files = entriesOf(ctx);
      if (!files.length) { notify.warning(t('nothingSelected'), t('selectFiles')); return null; }
      return openProperties({
        ...baseProps(ctx),
        files,
        onApplied: () => refresh(ctx),
      });
    });
  }

  /* ---- Create directory (forms/CreateDirectory.dfm) ---- */
  for (const name of CREATE_DIR) {
    registerActionDialog(name, (ctx) => openCreateDirectory({
      ...baseProps(ctx),
      onCreated: (path) => {
        refresh(ctx);
        const leaf = String(path).split(/[\\/]/).filter(Boolean).pop();
        if (leaf) ctx.panel?.revealName(leaf);
      },
    }));
  }

  /* ---- Link (forms/Symlink.dfm) ---- */
  for (const name of LINK) {
    registerActionDialog(name, (ctx) => {
      const focused = ctx.focused || ctx.selection.find((e) => e && e.name !== '..') || null;
      const editing = !!(focused && focused.type === 'link');
      return openSymlinkDialog({
        ...baseProps(ctx),
        name: focused ? focused.name : '',
        pointTo: editing ? (focused.linkTarget || '') : '',
        edit: editing,
        symbolic: true,
        onDone: () => refresh(ctx),
      });
    });
  }

  /* ---- Select / Unselect by mask (forms/SelectMask.dfm) ---- */
  for (const name of SELECT) {
    registerActionDialog(name, (ctx) => maskDialog(ctx, true));
  }
  for (const name of UNSELECT) {
    registerActionDialog(name, (ctx) => maskDialog(ctx, false));
  }
  function maskDialog(ctx, select) {
    const panel = ctx.panel;
    return openSelectMask({
      mode: select ? 'select' : 'deselect',
      mask: panel?.lastSelectMask || '',
      names: (panel?.entries?.() || []).filter((e) => e.name !== '..'),
      onApply: async ({ mask, directories }) => {
        if (!panel) return;
        panel.lastSelectMask = mask;
        const n = await panel.selectByMask(mask, select, { includeDirs: directories !== false });
        notify.info(select ? t('selectFiles') : t('unselectFiles'),
          t(select ? 'cmSelectedCount' : 'cmUnselectedCount', n));
      },
    });
  }

  /* ---- Open directory / Bookmarks (forms/OpenDirectory.dfm) ---- */
  for (const name of OPEN_DIR) {
    registerActionDialog(name, (ctx) => {
      const info = ctx.sessionInfo;
      return openDirectoryDialog({
        side: ctx.side,
        current: ctx.panel ? ctx.panel.path() : '',
        directories: ctx.panel ? ctx.panel.history() : [],
        localDirectory: ctx.isLocal ? ctx.panel?.path() : ctx.other?.path() || '',
        remoteDirectory: ctx.isLocal ? ctx.other?.path() || '' : ctx.panel?.path(),
        sessionId: ctx.sessionId,
        sessionKey: info ? (info.siteId || info.hostName || info.id) : '',
        sessionName: info ? (info.name || info.hostName || '') : '',
        onOpen: (path) => ctx.panel?.navigate(path),
      });
    });
  }

  /* ---- Duplicate / Move To on the remote side (forms/RemoteTransfer.dfm) ---- */
  for (const name of DUPLICATE) {
    registerActionDialog(name, (ctx, opts = {}) => {
      const files = entriesOf(ctx);
      if (!files.length) { notify.warning(t('nothingSelected'), t('selectFiles')); return null; }
      return openRemoteTransfer({
        ...baseProps(ctx),
        files,
        move: opts.mode === 'move',
        sessions: listSessions(ctx),
        onQueued: () => refresh(ctx),
      });
    });
  }

  /* ---- Find files (forms/FileFind.dfm) ---- */
  registerActionDialog('RemoteFindFilesAction2', (ctx) => {
    const info = ctx.sessionInfo;
    return openFileFind({
      sessionId: ctx.sessionId,
      sessionName: info ? (info.name || info.hostName || '') : '',
      side: ctx.side,
      directory: ctx.panel ? ctx.panel.path() : '',
      localDirectory: ctx.isLocal ? ctx.panel?.path() : ctx.other?.path() || '',
      onFocusFile: (path) => {
        const leaf = String(path).split('/').filter(Boolean).pop();
        const dir = String(path).slice(0, String(path).length - (leaf ? leaf.length + 1 : 0)) || '/';
        ctx.panel?.navigate(dir);
        if (leaf) setTimeout(() => ctx.panel?.revealName(leaf), 120);
      },
      onDeleted: () => refresh(ctx),
    });
  });

  /* ---- Site manager (forms/Login.dfm) ---- */
  for (const name of SITE_MANAGER) {
    registerActionDialog(name, (ctx) => openLogin({ workspace: ctx.workspace }));
  }

  /* ---- Generate session URL (forms/GenerateUrl.dfm) ---- */
  registerActionDialog('SessionGenerateUrlAction2', (ctx) => {
    const info = ctx.sessionInfo;
    if (!info) { notify.warning(t('genUrl'), t('notConnected')); return null; }
    return openGenerateUrl({
      protocol: info.protocol,
      hostName: info.hostName,
      portNumber: info.portNumber,
      userName: info.userName,
      remoteDirectory: info.remotePath,
      localDirectory: info.localPath,
      name: info.name || info.hostName,
    }, { sessionId: info.id });
  });

  /* ---- Console (forms/Console.dfm) ---- */
  registerActionDialog('ConsoleAction', (ctx) => openConsole(ctx.sessionId));

  /* ---- Synchronize (forms/FullSynchronize.dfm, Synchronize.dfm) ---- */
  registerActionDialog('FullSynchronizeAction2', (ctx) => openSynchronizeDialog(syncProps(ctx)));
  registerActionDialog('SynchronizeAction', (ctx) => openKeepUpToDateDialog(syncProps(ctx)));

  /* ---- Transfer (forms/CopyParams.dfm + the copy dialog) ---- */
  installTransferDialogs();

  installBookmarkShortcuts();

  bus.emit('wiring:ready', {});
}

/* ================================================================== */
/* bookmark and location-profile shortcuts                             */
/* ================================================================== */

/**
 * Both the bookmark dialog and the location-profile dialog let a user assign a
 * keyboard shortcut, store it, and show it back — and until this existed
 * nothing in the application read either store, so the toast that says
 * "Ctrl+1 now opens …" was describing a behaviour that did not happen.
 *
 * One document-level handler serves both, because both are stored as a combo
 * string produced by the SAME describeShortcut() the capture dialog uses — so
 * what is matched here is byte-for-byte what the user was shown.
 *
 * It defers to the command layer: a combo already claimed by one of WinSCP's
 * own 79 shortcuts is left alone, so a bookmark can never shadow Delete or F5.
 */
function installBookmarkShortcuts() {
  if (typeof document === 'undefined') return;
  document.addEventListener('keydown', async (e) => {
    if (e.defaultPrevented) return;
    // Never steal a keystroke from a field the user is typing into.
    const el = e.target;
    if (el && (el.isContentEditable
      || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName || ''))) return;
    const combo = describeShortcut(e);
    if (!combo || !/(Ctrl|Alt)\+/.test(combo)) return;

    const hit = await lookupShortcut(combo);
    if (!hit) return;
    e.preventDefault();
    applyShortcut(hit);
  });
}

async function lookupShortcut(combo) {
  const ws = services.workspace;
  const info = ws && typeof ws.sessionInfo === 'function' ? ws.sessionInfo() : null;
  const sessionKey = info ? (info.siteId || info.hostName || info.id) : '';

  // Bookmarks first: they are per side and the more specific of the two.
  try {
    const all = (await readAllBookmarks()) || {};
    for (const [key, value] of Object.entries(all)) {
      const path = value && value.shortCuts && value.shortCuts[combo];
      if (path) return { kind: 'bookmark', path, key };
    }
  } catch { /* an unreadable store simply has no shortcuts */ }

  try {
    const { shared, site } = await readProfiles(sessionKey);
    for (const profile of [...site, ...shared]) {
      if (profile.shortCut === combo) return { kind: 'profile', profile };
    }
  } catch { /* same */ }
  return null;
}

async function readAllBookmarks() {
  const raw = services.prefs && typeof services.prefs.get === 'function'
    ? services.prefs.get('bookmarks')
    : null;
  if (raw) return raw;
  const cfg = await (await import('../state.js')).api.raw?.config?.get?.();
  const prefs = (cfg && (cfg.value?.prefs || cfg.prefs)) || {};
  return prefs.bookmarks || {};
}

function applyShortcut(hit) {
  const ws = services.workspace;
  if (!ws) { notify.warning(t('openDirBookmark'), t('wrShortcutNoPanel')); return; }
  if (hit.kind === 'bookmark') {
    const side = typeof ws.activeSide === 'function' ? ws.activeSide() : 'remote';
    const panel = ws.panel(side);
    if (!panel) { notify.warning(t('openDirBookmark'), t('wrShortcutNoPanel')); return; }
    panel.navigate(hit.path);
    return;
  }
  const { profile } = hit;
  if (profile.local) ws.panel('local')?.navigate(profile.local);
  if (profile.remote) ws.panel('remote')?.navigate(profile.remote);
  notify.info(t('useLocationProfiles'), t('wrProfileApplied', profile.name));
}

function syncProps(ctx) {
  const localPanel = ctx.isLocal ? ctx.panel : ctx.other;
  const remotePanel = ctx.isLocal ? ctx.other : ctx.panel;
  return {
    sessionId: ctx.sessionId,
    localPath: localPanel ? localPanel.path() : '',
    remotePath: remotePanel ? remotePanel.path() : '',
    // "Selected files only" is honoured only when there really is a selection
    // to honour; passing an empty list would silently synchronise nothing.
    selection: ctx.selection.length
      ? ctx.selection.filter((e) => e.name !== '..').map((e) => e.name)
      : null,
  };
}

/** Sessions the duplicate dialog can target: every open tab that has one. */
function listSessions(ctx) {
  const strip = ctx.strip || services.strip || appSession.get('strip');
  const out = [];
  const seen = new Set();
  for (const tab of (strip && strip.tabs) || []) {
    const info = tab.data && tab.data.sessionInfo;
    if (!info || !info.id || seen.has(info.id)) continue;
    seen.add(info.id);
    out.push({ id: info.id, name: info.name || info.hostName || info.id, caps: info.caps, protocol: info.protocol });
  }
  if (!out.length && ctx.sessionInfo) {
    out.push({
      id: ctx.sessionInfo.id,
      name: ctx.sessionInfo.name || ctx.sessionInfo.hostName || ctx.sessionInfo.id,
      caps: ctx.caps,
      protocol: ctx.sessionInfo.protocol,
    });
  }
  return out;
}

/* ================================================================== */
/* transfers                                                           */
/* ================================================================== */

/**
 * The copy dialog owns the transfer options — including the named preset — so
 * routing the transfer actions through it is what finally makes the panel's
 * preset dropdown mean something: whatever `copyParamCurrent` names is the
 * preset the dialog starts from, and its copyParam is what reaches queue:add.
 */
function installTransferDialogs() {
  // The exact action list ui/commands.js binds to its own inline transfer form.
  const TRANSFERS = [
    ['RemoteCopyAction', 'download', false, false],
    ['RemoteCopyNonQueueAction', 'download', false, false],
    ['RemoteCopyQueueAction', 'download', false, true],
    ['RemoteMoveAction', 'download', true, false],
    ['RemoteCopyFocusedAction', 'download', false, false],
    ['RemoteCopyFocusedNonQueueAction', 'download', false, false],
    ['RemoteCopyFocusedQueueAction', 'download', false, true],
    ['RemoteMoveFocusedAction', 'download', true, false],
    ['LocalCopyAction', 'upload', false, false],
    ['LocalCopyNonQueueAction', 'upload', false, false],
    ['LocalCopyQueueAction', 'upload', false, true],
    ['LocalMoveAction', 'upload', true, false],
    ['LocalCopyFocusedAction', 'upload', false, false],
    ['LocalCopyFocusedNonQueueAction', 'upload', false, false],
    ['LocalCopyFocusedQueueAction', 'upload', false, true],
    ['LocalMoveFocusedAction', 'upload', true, false],
  ];
  for (const [name] of TRANSFERS) {
    registerActionDialog(name, (ctx, opts = {}) => {
      const files = entriesOf(ctx);
      if (!files.length) { notify.warning(t('nothingSelected'), t('selectFiles')); return null; }
      const info = ctx.sessionInfo || {};
      const direction = opts.direction || (ctx.isLocal ? 'upload' : 'download');
      // TTransferOperationParam::Queue, carried here from the command's own
      // cocQueue / cocNonQueue flag. This override is what actually runs in the
      // application — ui/commands.js's inline form only serves a context with no
      // dialogs registered — so dropping it here is what kept all four
      // *NonQueueAction commands queueing like the plain Copy ones.
      const queueMode = opts.queue || 'auto';
      // WinSCP's "Confirm transfers" — and the copy dialog's own "do not show
      // this again", which writes it. Honouring it here is what makes that
      // checkbox mean something: with it off the transfer simply starts, on the
      // options the preset and the last save resolved to.
      if (readPref('confirmTransferring', true) === false) {
        return queueTransfer(ctx, {
          direction,
          move: !!opts.move,
          background: readPref('queue.enabledByDefault', true) !== false,
          queue: queueMode,
          target: ctx.other ? ctx.other.path() : '',
          files: files.map((f) => f.path),
        });
      }
      return openCopyDialog({
        direction,
        files: files.map((f) => f.name),
        target: ctx.other ? ctx.other.path() : '',
        // asOff unticks the background box, asOn ticks it, asAuto leaves it at
        // the stored default — CopyParamDialog renders that checkbox straight
        // out of CopyParam.Queue, which ExecuteCopyOperationCommand has already
        // preset from the action.
        queue: queueMode === 'auto' ? undefined : queueMode === 'on',
        session: {
          id: ctx.sessionId,
          hostName: info.hostName,
          userName: info.userName,
          remoteDirectory: info.remotePath,
          localDirectory: info.localPath,
        },
        // The dialog resolves the options; the command layer still performs the
        // transfer, so there is exactly one code path that talks to queue:add.
        onConfirm: ({ target, copyParam, queue }) => queueTransfer(ctx, {
          direction,
          move: !!opts.move,
          background: queue !== false,
          // Ticking the box overrides the command's asOff preset, because
          // ExecuteCopyMoveFileOperation reads the FINAL CopyParam.Queue rather
          // than the preset. The reverse is deliberately NOT taken: unticking
          // it on a command that never asked for asOff keeps the queue, so this
          // change moves the four NonQueue commands onto the foreground path
          // and leaves every other transfer on the one it already used.
          queue: (queueMode === 'off' && queue === false) ? 'off' : 'auto',
          target,
          copyParam,
          files: files.map((f) => f.path),
        }),
      });
    });
  }
}

if (typeof document !== 'undefined') {
  queueMicrotask(() => {
    try { installWiring(); } catch (err) { console.error('[wiring] failed', err); }
  });
}
