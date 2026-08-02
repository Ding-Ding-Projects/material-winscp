// preload.js — the ONLY bridge between the renderer and the main process.
//
// The renderer runs with contextIsolation, sandbox and no Node integration, so
// this file is the whole attack surface. Two decisions follow from that, and
// they are not negotiable:
//
//   * NO GENERIC PASSTHROUGH. There is no `invoke(channel, ...)` exposed. Every
//     capability is a named function on a named namespace, so the set of things
//     the renderer can ask for is exactly the list below and is auditable by
//     reading this file. A generic passthrough would make every future IPC
//     handler — including ones added by someone who never read this comment —
//     reachable from any script that runs in the page.
//
//   * NO NODE PRIMITIVES. No `require`, no `process`, no `Buffer`, no path
//     helpers, no file handles. The renderer receives plain JSON.
//
// Every call resolves to the main process's envelope: { ok: true, value } or
// { ok: false, error: { message, code, detail } }. Nothing here throws, so a
// caller can always branch on `ok` instead of wrapping in try/catch.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

/**
 * Wrap invoke so a dead channel or a crashed handler still produces the
 * envelope rather than an unhandled rejection in the renderer.
 */
function call(channel, ...args) {
  return ipcRenderer.invoke(channel, ...args).then(
    (r) => (r && typeof r === 'object' && 'ok' in r
      ? r
      : { ok: false, error: { message: `The handler for ${channel} returned an unexpected reply.`, code: 'BAD_REPLY' } }),
    (e) => ({ ok: false, error: { message: e && e.message ? e.message : String(e), code: 'IPC_FAILED' } }),
  );
}

/**
 * Events the main process may push. An allowlist, for the same reason the
 * invoke surface is: `on()` must not become a way to listen to an internal
 * Electron channel.
 */
const EVENTS = [
  'event:progress',    // long-running work, carrying a correlation id
  'event:notify',      // corner toasts (informational, success, error)
  'event:prompt',      // a session needs an answer before it can continue
  'event:prompt-cancelled',
  'event:session',     // state, banner, error
  'event:queue',
  'event:sync',
  'event:editor',
  'event:console',     // custom-command output
  'event:log',         // a session log line
  'event:config',      // the store changed underneath the UI
  'event:command',     // a menu item or a second launch's command line
  'event:dimsum',      // the startup surprise
];

const listeners = new Map();

function on(event, handler) {
  if (!EVENTS.includes(event)) {
    throw new Error(`Unknown event "${event}". Known events: ${EVENTS.join(', ')}`);
  }
  if (typeof handler !== 'function') throw new Error('The handler must be a function.');
  // The Electron event object is never forwarded: it carries `sender`, which is
  // a live handle into the main process.
  const wrapped = (_event, payload) => { handler(payload); };
  ipcRenderer.on(event, wrapped);
  const key = {};
  listeners.set(key, { event, wrapped });
  return () => {
    const entry = listeners.get(key);
    if (!entry) return;
    ipcRenderer.removeListener(entry.event, entry.wrapped);
    listeners.delete(key);
  };
}

const api = {
  /** The event surface. `on` returns its own unsubscribe function. */
  events: EVENTS.slice(),
  on,
  off(unsubscribe) { if (typeof unsubscribe === 'function') unsubscribe(); },

  // -------------------------------------------------------------- app:*
  app: {
    info: () => call('app:info'),
    quit: () => call('app:quit'),
    /** 'minimize' | 'maximize' | 'unmaximize' | 'toggle-maximize' | 'close' | 'fullscreen' */
    window: (action) => call('app:window', action),
    windowState: () => call('app:windowState'),
    openExternal: (url) => call('app:openExternal', url),
    showItemInFolder: (path) => call('app:showItemInFolder', path),
    clipboardWrite: (text) => call('app:clipboardWrite', text),
    clipboardRead: () => call('app:clipboardRead'),
    pickPath: (options) => call('app:pickPath', options),

    dimsum: (options) => call('app:dimsum', options),
    dimsumSeen: (id) => call('app:dimsumSeen', id),
    codeName: (used) => call('app:codeName', used),
    catalog: () => call('app:catalog'),

    checkUpdates: (options) => call('app:checkUpdates', options),
    lastUpdateResult: () => call('app:lastUpdateResult'),

    customCommandPrompts: (command, options) => call('app:customCommandPrompts', command, options),
    customCommandPreview: (command, request) => call('app:customCommandPreview', command, request),
    runCustomCommand: (request) => call('app:runCustomCommand', request),
    cancelCustomCommand: (id) => call('app:cancelCustomCommand', id),

    maskMatches: (mask, name, options) => call('app:maskMatches', mask, name, options),
  },

  // ----------------------------------------------------------- config:*
  config: {
    get: () => call('config:get'),
    getPref: (dotted) => call('config:getPref', dotted),
    setPref: (dotted, value, label) => call('config:setPref', dotted, value, label),
    setPrefs: (patch, label) => call('config:setPrefs', patch, label),
    flush: () => call('config:flush'),

    sites: () => call('config:sites'),
    site: (id) => call('config:site', id),
    addSite: (site) => call('config:siteAdd', site),
    updateSite: (id, patch) => call('config:siteUpdate', id, patch),
    removeSite: (id) => call('config:siteRemove', id),
    duplicateSite: (id, name) => call('config:siteDuplicate', id, name),
    moveSite: (id, folder) => call('config:siteMove', id, folder),

    addFolder: (path) => call('config:folderAdd', path),
    renameFolder: (from, to) => call('config:folderRename', from, to),
    removeFolder: (path, deleteSites) => call('config:folderRemove', path, deleteSites),

    workspaces: () => call('config:workspaces'),
    saveWorkspace: (name, sessions) => call('config:workspaceSave', name, sessions),
    removeWorkspace: (name) => call('config:workspaceRemove', name),

    bookmarks: (key) => call('config:bookmarks', key),
    addBookmark: (key, side, value, name) => call('config:bookmarkAdd', key, side, value, name),
    removeBookmark: (key, side, value) => call('config:bookmarkRemove', key, side, value),

    pushHistory: (key, value) => call('config:historyPush', key, value),
    clearHistory: (key) => call('config:historyClear', key),

    hostKeys: () => call('config:hostKeys'),
    forgetHostKey: (hostPort) => call('config:forgetHostKey', hostPort),

    // The master password crosses this bridge in one direction only; nothing
    // ever comes back but a boolean.
    enableMasterPassword: (password) => call('config:masterEnable', password),
    changeMasterPassword: (oldPassword, newPassword) => call('config:masterChange', oldPassword, newPassword),
    disableMasterPassword: (password) => call('config:masterDisable', password),
    unlock: (password) => call('config:unlock', password),
    needsUnlock: () => call('config:needsUnlock'),

    export: (file) => call('config:export', file),
    import: (file, label) => call('config:import', file, label),
  },

  // ---------------------------------------------------------- session:*
  session: {
    open: (request) => call('session:open', request),
    list: () => call('session:list'),
    info: (id) => call('session:info', id),
    close: (id) => call('session:close', id),
    disconnect: (id) => call('session:disconnect', id),
    reconnect: (id) => call('session:reconnect', id),

    /** Answer an `event:prompt`. Host keys and certificates require
     *  { accept: true } explicitly; anything else is a refusal. */
    answerPrompt: (sessionId, promptId, answer) => call('session:answerPrompt', sessionId, promptId, answer),

    setState: (id, patch) => call('session:setState', id, patch),
    getState: (id) => call('session:getState', id),

    url: (id, flags) => call('session:url', id, flags),
    code: (id, kind, flags) => call('session:code', id, kind, flags),
    fsInfo: (id, path) => call('session:fsInfo', id, path),
    changePassword: (id, oldPassword, newPassword) => call('session:changePassword', id, oldPassword, newPassword),
    exec: (id, command, options) => call('session:exec', id, command, options),

    log: (id, since) => call('session:log', id, since),
    logClear: (id) => call('session:logClear', id),
    logText: (id) => call('session:logText', id),

    clearCache: (id, path) => call('session:clearCache', id, path),
    cacheInfo: (id) => call('session:cacheInfo', id),
  },

  // --------------------------------------------------------------- fs:*
  fs: {
    list: (sessionId, path, options) => call('fs:list', sessionId, path, options),
    stat: (sessionId, path) => call('fs:stat', sessionId, path),
    realpath: (sessionId, path) => call('fs:realpath', sessionId, path),
    readlink: (sessionId, path) => call('fs:readlink', sessionId, path),
    mkdir: (sessionId, path) => call('fs:mkdir', sessionId, path),
    remove: (sessionId, paths, options) => call('fs:remove', sessionId, paths, options),
    rename: (sessionId, from, to) => call('fs:rename', sessionId, from, to),
    symlink: (sessionId, target, linkPath, hard) => call('fs:symlink', sessionId, target, linkPath, hard),
    setRights: (sessionId, paths, rights, options) => call('fs:setRights', sessionId, paths, rights, options),
    setOwner: (sessionId, paths, owner, group, options) => call('fs:setOwner', sessionId, paths, owner, group, options),
    setTimes: (sessionId, path, mtime, atime) => call('fs:setTimes', sessionId, path, mtime, atime),
    /** Small files only — base64 in, base64 out. Anything large is a transfer. */
    readFile: (sessionId, path, options) => call('fs:readFile', sessionId, path, options),
    writeFile: (sessionId, path, base64) => call('fs:writeFile', sessionId, path, base64),
    calculateSize: (sessionId, dirs, correlationId) => call('fs:calculateSize', sessionId, dirs, correlationId),
    checksum: (sessionId, path, algorithm) => call('fs:checksum', sessionId, path, algorithm),
    spaceInfo: (sessionId, path) => call('fs:spaceInfo', sessionId, path),
    find: (request) => call('fs:find', request),

    localList: (path, options) => call('fs:localList', path, options),
    localStat: (path) => call('fs:localStat', path),
    localMkdir: (path) => call('fs:localMkdir', path),
    localRemove: (paths, options) => call('fs:localRemove', paths, options),
    localRename: (from, to) => call('fs:localRename', from, to),
    localDrives: () => call('fs:localDrives'),
  },

  // ------------------------------------------------------------ queue:*
  queue: {
    add: (request) => call('queue:add', request),
    list: () => call('queue:list'),
    pause: (id) => call('queue:pause', id),
    resume: (id) => call('queue:resume', id),
    cancel: (id) => call('queue:cancel', id),
    move: (id, delta) => call('queue:move', id, delta),
    clear: (which) => call('queue:clear', which),
    setLimit: (n) => call('queue:setLimit', n),
    setSpeed: (id, bytesPerSecond) => call('queue:setSpeed', id, bytesPerSecond),
    retry: (id) => call('queue:retry', id),
    answer: (id, answer) => call('queue:answer', id, answer),
  },

  // ------------------------------------------------------------- sync:*
  sync: {
    compare: (request) => call('sync:compare', request),
    apply: (request) => call('sync:apply', request),
    keepUpToDate: (request) => call('sync:keepUpToDate', request),
    stop: (id) => call('sync:stop', id),
  },

  // ----------------------------------------------------------- editor:*
  editor: {
    open: (request) => call('editor:open', request),
    read: (id) => call('editor:read', id),
    setEncoding: (id, encoding) => call('editor:setEncoding', id, encoding),
    save: (id, text, options) => call('editor:save', id, text, options),
    upload: (id, options) => call('editor:upload', id, options),
    close: (id, options) => call('editor:close', id, options),
    list: () => call('editor:list'),
    orphans: () => call('editor:orphans'),
    discardOrphans: (paths) => call('editor:discardOrphans', paths),
  },

  // ---------------------------------------------------------- history:*
  history: {
    list: (options) => call('history:list', options),
    actions: () => call('history:actions'),
    read: (revision) => call('history:read', revision),
    diff: (a, b) => call('history:diff', a, b),
    snapshot: (label) => call('history:snapshot', label),
    /** Append-only: this writes a NEW revision holding the old state. */
    restore: (revision, label) => call('history:restore', revision, label),
    prune: () => call('history:prune'),
    export: (file) => call('history:export', file),
  },
};

contextBridge.exposeInMainWorld('api', api);
