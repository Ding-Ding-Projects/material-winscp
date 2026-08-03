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
    // Read-only view of the silent updater, for a passive indicator only.
    updateState: () => call('app:updateState'),
    // User-initiated restart. Nothing calls this automatically.
    applyUpdateAndRestart: () => call('app:applyUpdateAndRestart'),

    customCommandPrompts: (command, options) => call('app:customCommandPrompts', command, options),
    customCommandPreview: (command, request) => call('app:customCommandPreview', command, request),
    runCustomCommand: (request) => call('app:runCustomCommand', request),
    cancelCustomCommand: (id) => call('app:cancelCustomCommand', id),

    maskMatches: (mask, name, options) => call('app:maskMatches', mask, name, options),
    maskValidate: (mask) => call('app:maskValidate', mask),
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
    /** Streams hits on `event:progress` with the returned correlation id. */
    find: (request) => call('fs:find', request),
    findCancel: (correlationId) => call('fs:findCancel', correlationId),

    localList: (path, options) => call('fs:localList', path, options),
    localStat: (path) => call('fs:localStat', path),
    localMkdir: (path) => call('fs:localMkdir', path),
    localRemove: (paths, options) => call('fs:localRemove', paths, options),
    localRename: (from, to) => call('fs:localRename', from, to),
    localDrives: () => call('fs:localDrives'),
  },

  // ------------------------------------------------------------ queue:*
  queue: {
    /** direction: 'upload' | 'download' | 'remote-copy' */
    add: (request) => call('queue:add', request),
    list: () => call('queue:list'),
    item: (id) => call('queue:item', id),
    /** Omit the id to pause or resume the whole queue. */
    pause: (id) => call('queue:pause', id),
    resume: (id) => call('queue:resume', id),
    cancel: (id) => call('queue:cancel', id),
    /** delta is -1 (up) or +1 (down). */
    move: (id, delta) => call('queue:move', id, delta),
    clear: () => call('queue:clear'),
    setEnabled: (on) => call('queue:setEnabled', on),
    setLimit: (n) => call('queue:setLimit', n),
    setSpeed: (id, bytesPerSecond) => call('queue:setSpeed', id, bytesPerSecond),
    answerQuery: (id, answer, options) => call('queue:answerQuery', id, answer, options),
    answerPrompt: (id, value) => call('queue:answerPrompt', id, value),
  },

  // ------------------------------------------------------------- sync:*
  sync: {
    /** Resolves to { token, items, counts }; pass the token back to apply(). */
    compare: (request) => call('sync:compare', request),
    /** { token, checked: boolean[], onlyChecked, performDeletions, copyParam } */
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
    fileChanged: (id) => call('editor:fileChanged', id),
    close: (id, options) => call('editor:close', id, options),
    list: () => call('editor:list'),
    orphans: () => call('editor:orphans'),
    discardOrphans: (paths) => call('editor:discardOrphans', paths),
  },

  // -------------------------------------------------------- messages:*
  //
  // WinSCP's own STRINGTABLE resources. A surface that needs one of WinSCP's
  // sentences asks for it by resource id rather than re-typing the English,
  // which is how the wording stays the wording the original ships.
  messages: {
    // `args` is a positional array or a named object for `%NAME%` resources.
    load: (id, args) => call('messages:load', id, args),
    meta: (id) => call('messages:meta', id),
    table: () => call('messages:table'),
    /** { language: 'en'|'yue'|'both', enLevel: 1..5, yueLevel: 1..5, args: [] } */
    voiced: (id, options) => call('messages:voiced', id, options),
    /** Split the `**` headline and the `$$` interactive prompt out of a message. */
    split: (text) => call('messages:split', text),
  },

  // ----------------------------------------------------------- panel:*
  //
  // The file-panel model: one comparator, one filter, one rename refusal and
  // one mask validator, shared with everything else that has to agree with the
  // panel about what it is showing.
  panel: {
    columns: (side) => call('panel:columns', side),
    sortAscendingByDefault: (side, key) => call('panel:sortAscendingByDefault', side, key),
    /** { side, sortStr, click } — click flips or starts at the column default. */
    sortState: (request) => call('panel:sortState', request),
    /** { side, entries, mask, showHiddenFiles, sortColumn, ascending } */
    buildView: (request) => call('panel:buildView', request),
    export: (request) => call('panel:export', request),
    validateRename: (request) => call('panel:validateRename', request),
    composeMask: (lines, directory) => call('panel:composeMask', lines, directory),
    validateMask: (mask, forceDirectoryMasks) => call('panel:validateMask', mask, forceDirectoryMasks),
    compare: (request) => call('panel:compare', request),
  },

  // ------------------------------------------------------------ path:*
  path: {
    segments: (path, side) => call('path:segments', path, side),
    complete: (typed, candidates) => call('path:complete', typed, candidates),
    completions: (typed, entries, options) => call('path:completions', typed, entries, options),
    /** direction: 'left' | 'right' | 'at' */
    word: (text, caret, direction) => call('path:word', text, caret, direction),
    saveToHistory: (list, value, options) => call('path:saveToHistory', list, value, options),
    minimize: (path, chars) => call('path:minimize', path, chars),
  },

  // -------------------------------------------------------- explorer:*
  //
  // The orchestration layer. The renderer pushes what its panels hold and asks
  // what a command may do; it does not decide for itself, because the two
  // answers used to disagree about which files a command applies to.
  explorer: {
    setPanels: (patch) => call('explorer:setPanels', patch),
    state: (command, context) => call('explorer:state', command, context),
    fileList: (side, options) => call('explorer:fileList', side, options),
    /** The full recycle-versus-delete path, with both confirmations. */
    delete: (side, files, alternative) => call('explorer:delete', side, files, alternative),
    deleteDecision: (side, files, alternative) => call('explorer:deleteDecision', side, files, alternative),
    fileOperation: (operation, side, options) => call('explorer:fileOperation', operation, side, options),
    presetAutoSelect: () => call('explorer:presetAutoSelect'),
    presetAutoSelectData: () => call('explorer:presetAutoSelectData'),
    queueOp: (operation, context) => call('explorer:queueOp', operation, context),
    defaultQueueOp: (item) => call('explorer:defaultQueueOp', item),
    doubleClick: (side, entry) => call('explorer:doubleClick', side, entry),
    canPaste: () => call('explorer:canPaste'),
    paste: (options) => call('explorer:paste', options),
    dropEffect: (spec) => call('explorer:dropEffect', spec),
    dropTarget: (spec) => call('explorer:dropTarget', spec),
    dragDrop: (spec) => call('explorer:dragDrop', spec),
    canCloseQueue: () => call('explorer:canCloseQueue'),
    closeQuery: (options) => call('explorer:closeQuery', options),
    closeTab: () => call('explorer:closeTab'),
    syncBrowse: (spec) => call('explorer:syncBrowse', spec),
    syncOptions: (params) => call('explorer:syncOptions', params),
    fullSyncOptions: () => call('explorer:fullSyncOptions'),
    customCommandState: (command, onFocused, listType) =>
      call('explorer:customCommandState', command, onFocused, listType),
    /** Settle a confirmation that arrived as an `event:prompt` of kind 'question'. */
    answer: (promptId, answer) => call('explorer:answer', promptId, answer),
  },

  // ------------------------------------------------------- interface:*
  interface: {
    shortcuts: (mode, options) => call('interface:shortcuts', mode, options),
    allowedAction: (mode, action, phase, state) => call('interface:allowedAction', mode, action, phase, state),
    commands: (mode) => call('interface:commands', mode),
    panels: (mode, options) => call('interface:panels', mode, options),
    bands: (mode) => call('interface:bands', mode),
    components: (mode) => call('interface:components', mode),
    statusBars: (mode) => call('interface:statusBars', mode),
    restoreParams: (mode, stored) => call('interface:restoreParams', mode, stored),
    storeParams: (mode, state) => call('interface:storeParams', mode, state),
    toolbarLayout: (text) => call('interface:toolbarLayout', text),
    formatToolbarLayout: (layout) => call('interface:formatToolbarLayout', layout),
    doubleClickAction: (mode, context) => call('interface:doubleClickAction', mode, context),
    workspaceCollect: (options) => call('interface:workspaceCollect', options),
    workspacePasswordDecision: (dataList, state) => call('interface:workspacePasswordDecision', dataList, state),
    workspaceList: (name) => call('interface:workspaceList', name),
    workspaceOpen: (name, options) => call('interface:workspaceOpen', name, options),
    syncBrowseLocal: (prev, next, remote) => call('interface:syncBrowseLocal', prev, next, remote),
    syncBrowseRemote: (prev, next, local) => call('interface:syncBrowseRemote', prev, next, local),
    tabHint: (mode, session, state) => call('interface:tabHint', mode, session, state),
  },

  // --------------------------------------------------------------- ui:*
  //
  // The message-dialog contract: which buttons a question offers, which is the
  // default, what Escape answers, and whether "never ask again" may appear.
  ui: {
    messageDialog: (spec) => call('ui:messageDialog', spec),
    resolveAnswer: (dialog, answer) => call('ui:resolveAnswer', dialog, answer),
    neverAskAgain: (dialog, checked, override) => call('ui:neverAskAgain', dialog, checked, override),
    mayOfferNeverAskAgain: (question) => call('ui:mayOfferNeverAskAgain', question),
    neverAskAgainSetting: (question) => call('ui:neverAskAgainSetting', question),
    answerList: (mask) => call('ui:answerList', mask),
    exceptionDialog: (spec) => call('ui:exceptionDialog', spec),
    timeoutCaption: (caption, seconds) => call('ui:timeoutCaption', caption, seconds),
    formCaption: (title) => call('ui:formCaption', title),
    mainFormCaption: (title) => call('ui:mainFormCaption', title),
    answer: (promptId, answer) => call('ui:answer', promptId, answer),
  },

  // -------------------------------------------------------- transfer:*
  //
  // The FOREGROUND transfer path — TTerminal::CopyToRemote / CopyToLocal. The
  // queue is the background one; both move their bytes through the same mover.
  transfer: {
    copyToRemote: (request) => call('transfer:copyToRemote', request),
    copyToLocal: (request) => call('transfer:copyToLocal', request),
    cancel: (sessionId) => call('transfer:cancel', sessionId),
    canParallel: (request) => call('transfer:canParallel', request),
    changeFileName: (copyParam, name, side, firstLevel) =>
      call('transfer:changeFileName', copyParam, name, side, firstLevel),
    allowResume: (copyParam, size, name) => call('transfer:allowResume', copyParam, size, name),
    useAsciiTransfer: (copyParam, name, side) => call('transfer:useAsciiTransfer', copyParam, name, side),
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
