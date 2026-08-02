// main.js — application lifecycle.
//
// Order matters here more than anywhere else in the app:
//
//   1. Squirrel events FIRST. During an install or an update, Windows launches
//      the exe purely to create or remove shortcuts. Doing anything else at
//      that point — reading config, opening a window, touching the log — is
//      visible to the user as a flash of an app that should not have appeared,
//      and can leave the installer waiting on a process that will not exit.
//
//   2. The single-instance lock SECOND. WinSCP opens a session URL by launching
//      itself again and handing the command line to the running copy, so the
//      second process must find the lock before it builds anything.
//
//   3. Everything else.
'use strict';

// ---- 1. Squirrel ---------------------------------------------------------
const { handleSquirrelEvent } = require('./squirrel');
if (handleSquirrelEvent()) {
  // squirrel.js already called app.quit(); return before anything else runs.
  return;
}

const { app, BrowserWindow, Menu, shell, dialog, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');

const P = require('./paths');
const { Config } = require('./config');
const { Ipc } = require('./ipc');
const dimsum = require('./dimsum');

const IS_WIN = process.platform === 'win32';
const DEV = process.argv.includes('--dev') || !!process.env.WINSCP_MATERIAL_DEV;

/** Everything the app keeps alive for its whole run. */
const state = {
  config: null,
  ipc: null,
  window: null,
  /** Command lines waiting for the window to be ready to receive them. */
  queuedCommands: [],
  shuttingDown: false,
  placementTimer: null,
};

// =============================================== 2. single instance lock

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // A second launch has nothing to do itself: Electron has already handed our
  // command line to the running copy through 'second-instance'.
  app.quit();
} else {
  app.on('second-instance', (_event, argv, workingDirectory) => {
    const parsed = parseCommandLine(argv.slice(1), workingDirectory);
    deliverCommand(parsed);
    focusWindow();
  });
  start();
}

// ====================================================== command line

/**
 * WinSCP's switch syntax (vendor/winscp/source/core/Option.cpp):
 *   * switches begin with `/` or `-`;
 *   * a value is attached with `=` or `:`;
 *   * a switch name is letters and `?` only, which is what stops `/home/martin`
 *     from being read as a switch;
 *   * a bare `//` or `--` means "no more switches".
 */
function parseSwitches(argv) {
  const switches = new Map();
  const params = [];
  let noMore = false;

  for (const raw of argv) {
    const value = String(raw);
    if (!noMore && value.length === 2 && value[0] === value[1] && '/-'.includes(value[0])) { noMore = true; continue; }

    let isSwitch = false;
    let i = 1;
    let delimiter = '';
    if (!noMore && value.length >= 2 && '/-'.includes(value[0])) {
      isSwitch = true;
      const mark = value[0];
      for (; i < value.length; i++) {
        const c = value[i];
        if (c === '=' || c === ':') { delimiter = c; break; }
        // `--long-switch` is allowed; `/home/martin` is not a switch.
        if (c === '?' || /[A-Za-z]/.test(c) || (c === '-' && mark === '-' && value[1] === '-')) continue;
        isSwitch = false;
        break;
      }
    }

    if (isSwitch) {
      const name = value.slice(1, i).toLowerCase();
      const val = delimiter ? value.slice(i + 1) : '';
      switches.set(name, { value: val, valueSet: i < value.length });
    } else {
      params.push(value);
    }
  }
  return { switches, params };
}

/** `sftp://user:pass@host:22/path`, `winscp://…`, `s3://…`, `ftps://…`. */
function parseSessionUrl(url) {
  const m = /^(winscp-)?([a-z0-9+.-]+):\/\/(.*)$/i.exec(String(url).trim());
  if (!m) return null;
  let scheme = m[2].toLowerCase();
  const winscpSpecific = !!m[1] || scheme === 'winscp';
  if (scheme === 'winscp') {
    // `winscp://sftp://user@host/` and `winscp://user@host/` both occur.
    const inner = parseSessionUrl(m[3]);
    if (inner) return { ...inner, winscpSpecific: true };
    scheme = 'sftp';
  }

  const known = { sftp: 'sftp', scp: 'scp', ftp: 'ftp', ftps: 'ftp', ftpes: 'ftp', http: 'webdav', https: 'webdav', dav: 'webdav', davs: 'webdav', webdav: 'webdav', s3: 's3' };
  if (!known[scheme]) return null;

  const rest = m[3];
  const data = {
    protocol: known[scheme],
    ftps: scheme === 'ftps' ? 'implicit' : (scheme === 'ftpes' ? 'explicitTls' : (scheme === 'davs' || scheme === 'https' ? 'implicit' : 'none')),
    winscpSpecific,
  };

  const at = rest.lastIndexOf('@', rest.indexOf('/') < 0 ? rest.length : indexOfAuthorityEnd(rest));
  let authority = rest;
  let remotePath = '';
  if (at >= 0) {
    const credentials = rest.slice(0, at);
    authority = rest.slice(at + 1);
    // Everything after the first `;` in the credentials is a raw setting.
    const [userPart, ...settingParts] = credentials.split(';');
    const colon = userPart.indexOf(':');
    data.userName = decodeURIComponent(colon < 0 ? userPart : userPart.slice(0, colon));
    if (colon >= 0) data.password = decodeURIComponent(userPart.slice(colon + 1));
    for (const s of settingParts) {
      const eq = s.indexOf('=');
      if (eq < 0) continue;
      const k = decodeURIComponent(s.slice(0, eq)).toLowerCase();
      const v = decodeURIComponent(s.slice(eq + 1));
      if (k === 'fingerprint') data.hostKey = v;
      else (data.rawSettings || (data.rawSettings = {}))[k] = v;
    }
  }

  const slash = authority.indexOf('/');
  if (slash >= 0) { remotePath = authority.slice(slash); authority = authority.slice(0, slash); }

  if (authority.startsWith('[')) {
    const close = authority.indexOf(']');
    data.hostName = authority.slice(1, close);
    const after = authority.slice(close + 1);
    if (after.startsWith(':')) data.portNumber = Number(after.slice(1)) || 0;
  } else {
    const colon = authority.lastIndexOf(':');
    if (colon >= 0) {
      data.hostName = decodeURIComponent(authority.slice(0, colon));
      data.portNumber = Number(authority.slice(colon + 1)) || 0;
    } else {
      data.hostName = decodeURIComponent(authority);
    }
  }

  if (remotePath && remotePath !== '/') {
    data.remoteDirectory = decodeURI(remotePath);
  }
  return data;
}

function indexOfAuthorityEnd(rest) {
  const i = rest.indexOf('/');
  return i < 0 ? rest.length : i;
}

/**
 * The whole command line. Handles the switches WinSCP documents for the GUI:
 *   /console, /script=FILE, /command "…", /log=FILE, /loglevel=N, /ini=FILE,
 *   /rawconfig, /privatekey=FILE, /hostkey=…, /passive, /timeout=N,
 *   /newinstance, /sessionname=…, /upload, /synchronize, /keepuptodate,
 *   /refresh, /browse, /edit, /defaults, /help
 */
function parseCommandLine(argv, cwd) {
  const { switches, params } = parseSwitches(argv || []);
  const get = (name) => (switches.has(name) ? switches.get(name).value : undefined);
  const has = (name) => switches.has(name);

  const out = {
    cwd: cwd || process.cwd(),
    help: has('help') || has('?'),
    console: has('console'),
    script: get('script'),
    command: get('command'),
    log: get('log'),
    logLevel: has('loglevel') ? Number(get('loglevel')) : undefined,
    xmlLog: get('xmllog'),
    ini: get('ini'),
    rawConfig: has('rawconfig'),
    newInstance: has('newinstance'),
    sessionName: get('sessionname'),
    privateKey: get('privatekey'),
    hostKey: get('hostkey'),
    passive: has('passive'),
    timeout: has('timeout') ? Number(get('timeout')) : undefined,
    defaults: has('defaults'),
    edit: has('edit') ? get('edit') : undefined,
    browse: has('browse') || has('explore') ? (get('browse') || get('explore')) : undefined,
    upload: has('upload'),
    synchronize: has('synchronize') ? get('synchronize') : undefined,
    keepUpToDate: has('keepuptodate') ? get('keepuptodate') : undefined,
    refresh: has('refresh'),
    url: null,
    siteName: '',
    files: [],
    raw: argv || [],
  };

  for (const p of params) {
    const url = parseSessionUrl(p);
    if (url && !out.url) { out.url = url; continue; }
    // A bare parameter that is not a URL is either a stored site name or, when
    // /upload was given, a file to send.
    if (out.upload || out.url) out.files.push(path.resolve(out.cwd, p));
    else if (!out.siteName) out.siteName = p;
    else out.files.push(path.resolve(out.cwd, p));
  }

  // Switches that modify the parsed session.
  if (out.url) {
    if (out.privateKey) out.url.publicKeyFile = out.privateKey;
    if (out.hostKey) out.url.hostKey = out.hostKey;
    if (out.passive) out.url.ftpPasvMode = true;
    if (out.timeout) out.url.timeout = out.timeout;
    if (out.sessionName) out.url.name = out.sessionName;
  }
  return out;
}

/** Hand a parsed command line to the renderer, or hold it until there is one. */
function deliverCommand(parsed) {
  if (!parsed) return;
  // The password from a URL is a secret from the moment it is parsed: it is
  // never written to the log and never echoed into the window title.
  const safe = { ...parsed };
  if (safe.url && safe.url.password) safe.url = { ...safe.url, password: '', hasPassword: true };

  if (state.window && !state.window.isDestroyed() && state.window.webContents && !state.window.webContents.isLoading()) {
    state.window.webContents.send('event:command', { command: parsed.command ? '(command)' : undefined, ...safe });
    // The real session data (password included) goes over the session channel
    // when the renderer asks to open it, not through the broadcast above.
    if (parsed.url && parsed.url.password) state.pendingSecret = parsed.url.password;
  } else {
    state.queuedCommands.push(parsed);
  }
}

function flushQueuedCommands() {
  const pending = state.queuedCommands.splice(0);
  for (const c of pending) deliverCommand(c);
}

// ====================================================== window placement

/**
 * Remembered placement lives in prefs.scpCommander.windowParams (WinSCP's own
 * home for it), stored as `x;y;width;height;maximized`. A window restored onto
 * a monitor that is no longer attached is unreachable, so the saved rectangle
 * is only used when it still intersects a display.
 */
function loadPlacement() {
  const raw = (state.config && state.config.getPref('scpCommander.windowParams')) || '';
  const parts = String(raw).split(';');
  if (parts.length < 4) return null;
  const [x, y, width, height, maximized] = parts.map((v) => Number(v));
  if (![x, y, width, height].every((n) => Number.isFinite(n))) return null;
  if (width < 400 || height < 300) return null;
  return { x, y, width, height, maximized: maximized === 1 };
}

function placementIsVisible(p) {
  const { screen } = require('electron');
  return screen.getAllDisplays().some((d) => {
    const b = d.workArea;
    return p.x < b.x + b.width && p.x + p.width > b.x && p.y < b.y + b.height && p.y + p.height > b.y;
  });
}

function savePlacement() {
  if (!state.window || state.window.isDestroyed() || !state.config) return;
  const w = state.window;
  // getNormalBounds is the un-maximized rectangle, which is what should be
  // restored when the user un-maximizes later.
  const b = w.getNormalBounds ? w.getNormalBounds() : w.getBounds();
  const value = [b.x, b.y, b.width, b.height, w.isMaximized() ? 1 : 0].join(';');
  state.config.setPref('scpCommander.windowParams', value, 'Remembered the window placement');
}

function schedulePlacementSave() {
  if (state.placementTimer) clearTimeout(state.placementTimer);
  state.placementTimer = setTimeout(() => { state.placementTimer = null; savePlacement(); }, 500);
}

// ============================================================ the window

function createWindow() {
  const saved = loadPlacement();
  const useSaved = saved && placementIsVisible(saved);

  const win = new BrowserWindow({
    width: useSaved ? saved.width : 1280,
    height: useSaved ? saved.height : 820,
    x: useSaved ? saved.x : undefined,
    y: useSaved ? saved.y : undefined,
    minWidth: 720,
    minHeight: 480,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#101418' : '#FDFCFF',
    // A Material 3 title bar is drawn by the renderer, so the OS frame goes.
    frame: false,
    titleBarStyle: IS_WIN ? 'hidden' : 'hiddenInset',
    // Keep the system buttons on platforms that draw them into the client area
    // (macOS), so the traffic lights still work while the strip is ours.
    trafficLightPosition: { x: 12, y: 14 },
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webviewTag: false,
      spellcheck: false,
      // The renderer only ever loads its own files.
      webSecurity: true,
    },
  });

  win.once('ready-to-show', () => {
    if (useSaved && saved.maximized) win.maximize();
    win.show();
  });

  win.on('resize', schedulePlacementSave);
  win.on('move', schedulePlacementSave);
  win.on('maximize', () => { schedulePlacementSave(); win.webContents.send('event:command', { type: 'window-state', maximized: true }); });
  win.on('unmaximize', () => { schedulePlacementSave(); win.webContents.send('event:command', { type: 'window-state', maximized: false }); });
  win.on('enter-full-screen', () => win.webContents.send('event:command', { type: 'window-state', fullScreen: true }));
  win.on('leave-full-screen', () => win.webContents.send('event:command', { type: 'window-state', fullScreen: false }));

  win.on('close', () => { savePlacement(); });
  win.on('closed', () => { state.window = null; });

  // Nothing in this app opens a second window, and a remote page must never be
  // able to make one.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); }
  });

  win.webContents.on('did-finish-load', () => {
    flushQueuedCommands();
    maybeShowDimSum();
  });

  const index = path.join(__dirname, '..', 'renderer', 'index.html');
  if (fs.existsSync(index)) {
    win.loadFile(index);
  } else {
    // The renderer is written by another part of the port. Say so plainly
    // rather than showing a blank window nobody can diagnose.
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
      '<meta charset="utf-8"><body style="font:14px system-ui;padding:2rem">' +
      '<h1>Renderer not built</h1><p>design/renderer/index.html is missing.</p></body>'));
  }

  if (DEV) win.webContents.openDevTools({ mode: 'detach' });
  return win;
}

function focusWindow() {
  if (!state.window || state.window.isDestroyed()) { state.window = createWindow(); return; }
  if (state.window.isMinimized()) state.window.restore();
  state.window.show();
  state.window.focus();
}

// ============================================================ dim sum

/**
 * A 10% chance per launch, decided once, in the main process, so the renderer
 * cannot re-roll it. Never during a first run and never on an error path —
 * both of those are moments where the user is being asked something.
 */
function maybeShowDimSum() {
  if (state.dimSumDrawn) return;
  state.dimSumDrawn = true;
  const firstRun = !state.config || !fs.existsSync(P.config());
  if (firstRun) return;
  if (!dimsum.shouldSurprise(0.1)) return;
  const seen = (state.config.prefs.dimSum && state.config.prefs.dimSum.seen) || [];
  const dish = dimsum.pick(seen);
  if (!dish) return;                       // no bundled image: no surprise, no error
  const payload = { ...dish, dataUri: dimsum.dataUri(dish.id) };
  if (!payload.dataUri) return;            // only ever an image that really exists
  if (state.window && !state.window.isDestroyed()) state.window.webContents.send('event:dimsum', payload);
}

// ============================================================== the menu

/** Mirrors WinSCP's menu bar. Accelerators match the original where it has one. */
function buildMenu() {
  const send = (command, arg) => () => {
    if (state.window && !state.window.isDestroyed()) {
      state.window.webContents.send('event:command', { type: 'menu', command, arg });
    }
  };

  const template = [
    {
      label: '&Local',
      submenu: [
        { label: 'Open…', accelerator: 'Ctrl+O', click: send('local.open') },
        { label: 'Go To…', accelerator: 'Ctrl+G', click: send('local.goto') },
        { label: 'Open Directory/Bookmark…', accelerator: 'Ctrl+D', click: send('local.bookmarks') },
        { type: 'separator' },
        { label: 'Synchronise Browsing', type: 'checkbox', click: send('local.syncBrowsing') },
        { type: 'separator' },
        { label: 'Open in Explorer', click: send('local.openInExplorer') },
        { label: 'Open in External Editor…', click: send('local.externalEditor') },
        { type: 'separator' },
        { label: 'Close Session', accelerator: 'Ctrl+W', click: send('session.close') },
        { label: 'Exit', accelerator: IS_WIN ? 'Alt+F4' : 'Cmd+Q', role: 'quit' },
      ],
    },
    {
      label: '&Mark',
      submenu: [
        { label: 'Select…', accelerator: 'Num+', click: send('mark.select') },
        { label: 'Unselect…', accelerator: 'Num-', click: send('mark.unselect') },
        { label: 'Select All', accelerator: 'Ctrl+A', click: send('mark.selectAll') },
        { label: 'Invert Selection', accelerator: 'Num*', click: send('mark.invert') },
        { type: 'separator' },
        { label: 'Copy File Names to Clipboard', accelerator: 'Ctrl+Alt+C', click: send('mark.copyNames') },
        { label: 'Copy Paths to Clipboard', click: send('mark.copyPaths') },
      ],
    },
    {
      label: '&Files',
      submenu: [
        { label: 'Copy…', accelerator: 'F5', click: send('files.copy') },
        { label: 'Move…', accelerator: 'F6', click: send('files.move') },
        { label: 'Duplicate…', accelerator: 'Shift+F5', click: send('files.duplicate') },
        { type: 'separator' },
        { label: 'Edit', accelerator: 'F4', click: send('files.edit') },
        { label: 'Edit With…', accelerator: 'Shift+F4', click: send('files.editWith') },
        { label: 'Open', click: send('files.open') },
        { type: 'separator' },
        { label: 'Create Directory…', accelerator: 'F7', click: send('files.mkdir') },
        { label: 'Create File…', accelerator: 'Shift+F7', click: send('files.touch') },
        { label: 'Create Link…', click: send('files.symlink') },
        { type: 'separator' },
        { label: 'Rename', accelerator: 'F2', click: send('files.rename') },
        { label: 'Delete', accelerator: 'F8', click: send('files.delete') },
        { type: 'separator' },
        { label: 'Properties', accelerator: 'F9', click: send('files.properties') },
        { label: 'Custom Commands', submenu: [{ label: 'Configure…', click: send('files.customCommands') }] },
        { label: 'File Names', submenu: [
          { label: 'Calculate Directory Sizes', click: send('files.calculateSizes') },
          { label: 'Calculate Checksum…', click: send('files.checksum') },
        ] },
      ],
    },
    {
      label: '&Commands',
      submenu: [
        { label: 'Synchronise…', accelerator: 'Ctrl+S', click: send('commands.synchronize') },
        { label: 'Keep Remote Directory up to Date…', accelerator: 'Ctrl+U', click: send('commands.keepUpToDate') },
        { label: 'Compare Directories', accelerator: 'Ctrl+C', click: send('commands.compare') },
        { type: 'separator' },
        { label: 'Open Terminal…', accelerator: 'Ctrl+T', click: send('commands.terminal') },
        { label: 'Open in PuTTY', accelerator: 'Ctrl+P', click: send('commands.putty') },
        { type: 'separator' },
        { label: 'File Search…', accelerator: 'Ctrl+F', click: send('commands.find') },
        { label: 'Regex Builder…', accelerator: 'Ctrl+Shift+R', click: send('commands.regexBuilder') },
        { type: 'separator' },
        { label: 'Clear Caches', click: send('commands.clearCaches') },
      ],
    },
    {
      label: '&Session',
      submenu: [
        { label: 'New Session…', accelerator: 'Ctrl+N', click: send('session.new') },
        { label: 'New Tab', accelerator: 'Ctrl+Shift+T', click: send('session.newTab') },
        { label: 'Duplicate Session', click: send('session.duplicate') },
        { type: 'separator' },
        { label: 'Sites', submenu: [
          { label: 'Site Manager…', accelerator: 'Ctrl+Shift+S', click: send('session.sites') },
          { label: 'Save Session as Site…', click: send('session.saveSite') },
          { label: 'Generate Session URL/Code…', click: send('session.generateUrl') },
        ] },
        { label: 'Workspaces', submenu: [
          { label: 'Save Workspace…', click: send('session.saveWorkspace') },
          { label: 'Open Workspace…', click: send('session.openWorkspace') },
        ] },
        { type: 'separator' },
        { label: 'Reconnect Session', accelerator: 'Ctrl+R', click: send('session.reconnect') },
        { label: 'Disconnect Session', click: send('session.disconnect') },
        { label: 'Server/Protocol Information…', click: send('session.fsInfo') },
        { label: 'Change Password…', click: send('session.changePassword') },
      ],
    },
    {
      label: '&Options',
      submenu: [
        { label: 'Preferences…', accelerator: 'Ctrl+,', click: send('options.preferences') },
        { label: 'Appearance…', click: send('options.appearance') },
        { label: 'Language', submenu: [
          { label: 'English', type: 'radio', click: send('options.language', 'en') },
          { label: '廣東話', type: 'radio', click: send('options.language', 'yue') },
          { label: 'Bilingual / 雙語', type: 'radio', click: send('options.language', 'both') },
        ] },
        { type: 'separator' },
        { label: 'Commander', type: 'radio', click: send('options.interface', 'commander') },
        { label: 'Explorer', type: 'radio', click: send('options.interface', 'explorer') },
        { type: 'separator' },
        { label: 'Show Hidden Files', type: 'checkbox', accelerator: 'Ctrl+Alt+H', click: send('options.showHidden') },
        { label: 'Session Log', click: send('options.log') },
        { label: 'Version History…', click: send('options.history') },
      ],
    },
    {
      label: '&Help',
      submenu: [
        { label: 'Documentation', click: send('help.docs') },
        { label: 'Changelog…', click: send('help.changelog') },
        { label: 'Check for Updates…', click: send('help.checkUpdates') },
        { type: 'separator' },
        ...(DEV ? [{ label: 'Toggle Developer Tools', role: 'toggleDevTools' }, { type: 'separator' }] : []),
        { label: 'About WinSCP Material', click: send('help.about') },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ============================================================= lifecycle

function start() {
  // A single instance is what makes `winscp://` open a tab instead of a
  // second copy of the app.
  app.setAppUserModelId('net.winscp.material');

  app.on('open-url', (event, url) => {          // macOS delivers URLs this way
    event.preventDefault();
    deliverCommand(parseCommandLine([url], process.cwd()));
    focusWindow();
  });

  app.whenReady().then(() => {
    const early = parseCommandLine(process.argv.slice(1), process.cwd());

    // `/ini=FILE` redirects the whole data tree, exactly as WinSCP's does, so
    // portable installs and tests keep their configuration together.
    if (early.ini && early.ini.toLowerCase() !== 'nul') {
      const target = path.resolve(early.ini);
      P.setRoot(fs.existsSync(target) && fs.statSync(target).isDirectory() ? target : path.dirname(target));
    }

    state.config = new Config().load();
    state.config.appVersion = app.getVersion();
    state.config.on('error', (e) => {
      // A configuration problem is worth a real dialog: it is a decision (the
      // user's sites may need restoring), not an informational toast.
      dialog.showErrorBox('WinSCP Material', e.message);
    });

    // `/log=FILE` and `/loglevel=N` turn logging on for this run only.
    if (early.log) {
      state.config.setPrefs({ logging: { enabled: true, logToFile: true, logFileName: early.log } });
    }
    if (Number.isFinite(early.logLevel)) {
      state.config.setPrefs({ logging: { enabled: true, level: Math.max(0, Math.min(2, early.logLevel)) } });
    }
    if (early.xmlLog) {
      state.config.setPrefs({ logging: { actionsLogging: true, actionsLogFileName: early.xmlLog } });
    }

    state.ipc = new Ipc({
      config: state.config,
      getWindow: () => state.window,
      version: app.getVersion(),
    });
    state.ipc.registerAll();

    // `winscp://` (and the protocol names) belong to this app. Registering is
    // idempotent, and failing is not fatal — it only means URLs will not route.
    registerProtocols();

    buildMenu();
    state.window = createWindow();

    // The console and scripting entry points are not GUI sessions: hand them
    // to the renderer, which owns the console panel.
    if (early.console || early.script || early.command) {
      state.queuedCommands.push({ ...early, consoleMode: true });
    } else if (early.url || early.siteName || early.files.length) {
      state.queuedCommands.push(early);
    }

    // Never on the critical path: the check waits until the window is usable.
    state.ipc.updates.scheduleStartupCheck();

    // Retention runs once per launch, in the background, and its failure is
    // never the user's problem.
    state.ipc.history.prune().catch(() => undefined);

    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) state.window = createWindow(); });
  });

  app.on('window-all-closed', () => {
    // On Windows and Linux the app is its window; on macOS it is not.
    if (process.platform !== 'darwin') app.quit();
  });

  // ---- graceful shutdown -------------------------------------------
  app.on('before-quit', (event) => {
    if (state.shuttingDown) return;
    state.shuttingDown = true;
    event.preventDefault();
    shutdown().finally(() => app.exit(0));
  });

  process.on('uncaughtException', (e) => {
    // Never die silently: an unhandled exception in the main process would
    // otherwise leave the window frozen with no explanation.
    try { dialog.showErrorBox('WinSCP Material', `An unexpected error occurred:\n\n${e && e.stack ? e.stack : e}`); } catch { /* no UI yet */ }
  });
}

/** Flush config, stop the queue, close editors and sessions — in that order. */
async function shutdown() {
  const withTimeout = (p, ms) => Promise.race([
    Promise.resolve(p).catch(() => undefined),
    new Promise((r) => setTimeout(r, ms)),
  ]);

  try { savePlacement(); } catch { /* the window may already be gone */ }
  if (state.placementTimer) { clearTimeout(state.placementTimer); state.placementTimer = null; }

  if (state.ipc) {
    state.ipc.updates.stop();
    // Editors first: a pending edit is the only thing here that is the user's
    // unsaved work, and uploading it needs a session that is still open.
    await withTimeout(state.ipc.editors.closeAll(), 8000);
    if (state.ipc._queue) {
      const q = state.ipc._queue;
      for (const m of ['stop', 'pause', 'shutdown', 'close']) {
        if (typeof q[m] === 'function') { await withTimeout(q[m](), 4000); break; }
      }
    }
    await withTimeout(state.ipc.sessions.closeAll(), 8000);
    state.ipc.dispose();
  }

  if (state.config) {
    try { state.config.flush(); } catch { /* a failed final save is reported at next load */ }
  }
}

/** `winscp://`, plus the protocol schemes WinSCP claims. */
function registerProtocols() {
  const schemes = ['winscp', 'sftp', 'scp', 'ftp', 'ftps', 'ftpes', 's3'];
  for (const s of schemes) {
    try {
      if (DEV && process.defaultApp && process.argv.length >= 2) {
        // In development the executable is Electron itself, so the registration
        // has to name the app's entry point too or Windows launches a bare
        // Electron with no application.
        app.setAsDefaultProtocolClient(s, process.execPath, [path.resolve(process.argv[1])]);
      } else {
        app.setAsDefaultProtocolClient(s);
      }
    } catch { /* registration is a nicety, not a requirement to run */ }
  }
}

module.exports = { parseCommandLine, parseSessionUrl, parseSwitches };
