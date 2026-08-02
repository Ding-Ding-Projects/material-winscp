// defaults.js — the complete default configuration, mirroring WinSCP's
// Configuration/WinConfiguration/GUIConfiguration option set.
// Every option here is reachable from the Preferences UI.
'use strict';

/** Default per-site session data (WinSCP TSessionData). */
const SESSION_DEFAULTS = {
  name: '',
  folder: '',            // site folder path, '' = root
  protocol: 'sftp',      // sftp | scp | ftp | webdav | s3
  hostName: '',
  portNumber: 22,
  userName: '',
  password: '',          // stored encrypted; never written in clear
  savePassword: false,
  anonymous: false,
  color: '',             // per-site colour tag
  note: '',

  // --- SSH ---
  compression: false,
  sshProt: 2,
  cipherList: ['aes', 'chacha20', '3des', 'WARN', 'des', 'blowfish', 'arcfour'],
  kexList: ['ecdh', 'dh-gex-sha1', 'dh-group18-sha512', 'dh-group17-sha512',
    'dh-group16-sha512', 'dh-group15-sha512', 'dh-group14-sha1', 'rsa', 'WARN', 'dh-group1-sha1'],
  hostKeyList: ['ed448', 'ed25519', 'ecdsa', 'rsa', 'dsa', 'WARN'],
  gssLibList: ['gssapi32', 'sspi', 'custom'],
  rekeyTime: 60,
  rekeyData: '1G',
  sshNoUserAuth: false,
  tryAgent: true,
  agentFwd: false,
  authKI: true,
  authKIPassword: true,
  authGSSAPI: false,
  authGSSAPIKEX: false,
  gssapiFwdTGT: false,
  publicKeyFile: '',
  detachedCertificate: '',
  passphrase: '',
  puttyProtocol: '',

  // --- SFTP ---
  sftpServer: '',
  sftpMaxVersion: 6,
  sftpMinPacketSize: 0,
  sftpMaxPacketSize: 0,
  sftpDownloadQueue: 32,
  sftpUploadQueue: 32,
  sftpListingQueue: 2,
  sftpRealPath: 'auto',        // auto | on | off (canonicalize paths)
  usePosixRename: false,
  sftpBugs: {                  // auto | on | off
    symlink: 'auto', signedTS: 'auto',
  },

  // --- SCP / shell ---
  shell: '',
  returnVar: '',
  lookupUserGroups: 'auto',
  eolType: 'lf',               // lf | crlf
  clearAliases: true,
  unsetNationalVars: true,
  listingCommand: 'ls -la',
  ignoreLsWarnings: true,
  scp1Compatibility: false,
  timeDifference: 0,
  timeDifferenceAuto: true,
  sCPLsFullTime: 'auto',
  notUtf: 'auto',

  // --- FTP ---
  ftpPasvMode: true,
  ftps: 'none',                // none | implicit | explicitTls
  ftpForcePasvIp: 'auto',
  ftpUseMlsd: 'auto',
  ftpAccount: '',
  ftpPingInterval: 30,
  ftpPingType: 'dummy',        // off | dummy | directory
  ftpTransferActiveImmediately: 'auto',
  ftpListAll: 'auto',
  ftpHost: 'auto',
  ftpDupFF: false,
  ftpUndupFF: false,
  sslSessionReuse: true,
  tlsCertificateFile: '',
  minTlsVersion: 'tls10',
  maxTlsVersion: 'tls13',

  // --- WebDAV ---
  webDavLiberalEscaping: false,
  webDavAuthLegacy: false,

  // --- S3 ---
  s3DefaultRegion: '',
  s3SessionToken: '',
  s3RoleArn: '',
  s3Profile: '',
  s3UrlStyle: 'virtualhost',   // virtualhost | path
  s3MaxKeys: 'auto',
  s3CredentialsEnv: false,
  s3RequesterPays: false,
  s3StorageClass: '',

  // --- Connection ---
  timeout: 15,
  pingInterval: 30,
  pingType: 'off',             // off | null | dummy
  addressFamily: 'auto',       // auto | ipv4 | ipv6
  codePage: 'UTF-8',
  sendBuf: 262144,
  sourceAddress: '',
  protocolFeatures: '',

  // --- Proxy ---
  proxyMethod: 'none',         // none | socks4 | socks5 | http | telnet | cmd | system
  proxyHost: '',
  proxyPort: 0,
  proxyUsername: '',
  proxyPassword: '',
  proxyTelnetCommand: 'connect %host %port\\n',
  proxyLocalCommand: '',
  proxyDNS: 'auto',
  proxyLocalhost: false,

  // --- Tunnel ---
  tunnel: false,
  tunnelHostName: '',
  tunnelPortNumber: 22,
  tunnelUserName: '',
  tunnelPassword: '',
  tunnelPublicKeyFile: '',
  tunnelPassphrase: '',
  tunnelLocalPortNumber: 0,    // 0 = autoselect
  tunnelHostKey: '',

  // --- Directories ---
  localDirectory: '',
  remoteDirectory: '',
  updateDirectories: true,     // remember last used directory
  cacheDirectories: true,
  cacheDirectoryChanges: true,
  preserveDirectoryChanges: true,
  resolveSymlinks: true,
  followDirectorySymlinks: false,
  synchronizeBrowsing: false,

  // --- Environment ---
  dSTMode: 'unix',             // unix | keep | win
  trimVMSVersions: false,
  vMSAllRevisions: false,
  utf: 'auto',

  // --- Recycle bin ---
  deleteToRecycleBin: false,
  overwrittenToRecycleBin: false,
  recycleBinPath: '/tmp',

  // --- Encryption (at-rest, WinSCP file encryption) ---
  encryptFiles: false,
  encryptKey: '',

  // --- Shell / post-login ---
  postLoginCommands: [],

  // --- Host key ---
  hostKey: '',
  fingerprintScan: true,
};

/** Default transfer settings (WinSCP TCopyParamType). */
const COPY_PARAM_DEFAULTS = {
  // TCopyParamType::Default sets TransferMode = tmBinary (CopyParam.cpp:38).
  // The difference is not cosmetic: in automatic mode every *.txt, *.xml, *.ini
  // and *.sh goes over in text mode, which rewrites its line endings and — via
  // SFTPConfirmOverwrite's CanAppend — withdraws the Append button and refuses
  // to resume. Shipping "automatic" as the default therefore silently changed
  // both the bytes on the wire and the answers the overwrite dialog offered.
  transferMode: 'binary',          // text | binary | automatic
  asciiFileMask: '*.*htm; *.*html; *.txt; *.php*; *.c; *.cpp; *.h; *.pas; *.bas; *.tex; *.pl; *.js; .htaccess; *.xtml; *.css; *.cfg; *.ini; *.sh; *.xml',
  fileNameCase: 'noChange',        // noChange | upper | lower | firstUpper
  preserveTime: true,
  preserveTimeDirs: false,
  preserveRights: false,
  rights: 'rw-r--r--',
  addXToDirectories: true,
  ignorePermErrors: false,
  // CopyParam.cpp:29 — PreserveReadOnly = false. Defaulting it on made every
  // downloaded file read-only, which WinSCP does not do and which a user then
  // has to undo by hand before they can edit what they just fetched.
  preserveReadOnly: false,
  replaceInvalidChars: true,
  invalidCharsReplacement: '_',
  calculateSize: true,
  clearArchive: false,
  removeCtrlZ: false,
  removeBOM: false,
  cpsLimit: 0,                     // bytes/s, 0 = unlimited
  newerOnly: false,
  includeFileMask: '',
  excludeHiddenFiles: false,
  excludeEmptyDirectories: false,
  onceDoneOperation: 'none',       // none | disconnect | suspend | shutdown
  resumeSupport: 'smart',          // on | off | smart
  resumeThreshold: 102400,
  partialFileExt: '.filepart',
  overwriteMode: 'overwrite',      // overwrite | resume | append
  followDirectorySymlinks: false,
  encryptNewFiles: true,
  saveTransferOptions: false,
};

/** Default application preferences (WinSCP TWinConfiguration/TGUIConfiguration). */
const PREF_DEFAULTS = {
  // ---------- Environment ----------
  interface: 'commander',          // commander | explorer
  showHiddenFiles: false,
  formatSizeBytes: 'short',        // none | kilo | short
  showInaccessibleDirectories: true,
  confirmOverwriting: true,
  confirmResume: true,
  confirmDeleting: true,
  confirmRecycling: true,
  confirmClosingSession: true,
  confirmExitOnCompletion: true,
  confirmTransferring: true,
  confirmCommandSession: true,
  continueOnError: false,
  beepOnFinishAfter: 0,            // seconds; 0 = never
  beepOnFinish: false,
  copyOnDoubleClick: false,
  copyOnDoubleClickConfirmation: true,
  doubleClickAction: 'edit',       // open | edit | copy
  autoReadDirectoryAfterOp: true,
  refreshRemotePanelInterval: 0,   // seconds; 0 = off
  deleteToRecycleBin: true,
  dDTransferConfirmation: true,
  dDAllowMove: false,
  dDAllowMoveInit: false,
  dDWarnLackOfTempSpace: true,
  dDWarnLackOfTempSpaceRatio: 1.2,
  dDFakeFile: true,
  dDDrives: '',
  temporaryDirectoryAppendSession: false,
  temporaryDirectoryAppendPath: true,
  temporaryDirectoryDeterministic: false,
  temporaryDirectoryCleanup: true,
  confirmTemporaryDirectoryCleanup: true,
  defaultDirIsHome: true,
  timeoutOnStartup: false,

  // ---------- Panels ----------
  panel: {
    doubleClickAction: 'edit',
    fullRowSelect: true,
    explorerStyleSelection: false,
    naturalOrderNumericalSorting: true,
    alwaysSortDirectoriesByName: false,
    incrementalSearch: 'typing',   // off | typing | ctrl
    showFullPathOnAddressBar: false,
    hiddenAsNormal: false,
    viewStyle: 'report',           // icon | smallIcon | list | report | thumbnail
    thumbnailSize: 96,
  },

  // ---------- Editors ----------
  editor: {
    fontName: 'Consolas',
    fontSize: 11,
    fontCharset: 1,
    fontStyle: 0,
    wordWrap: false,
    findText: '',
    replaceText: '',
    findMatchCase: false,
    findByMask: false,
    findWholeWord: false,
    findDown: true,
    tabSize: 8,
    maxEditors: 500,
    earlyClose: 2,
    sDIShellEditor: false,
    autoFont: true,
    singleEditor: true,
    disableSmoothScroll: false,
    keepTemporaryFiles: false,
    encoding: 'auto',              // auto | utf8 | utf8bom | ansi
    warnOnEncodingFallback: true,
    warnOrphans: true,
    list: [
      { mask: '*.*', type: 'internal', external: '', externalParams: true, sDIExternal: false },
    ],
  },

  // ---------- Interface ----------
  theme: {
    mode: 'light',                 // light | dark | system
    seed: '#0B57D0',
    density: 0,                    // -3 .. 0 (Material density scale)
    uiScale: 1,
    fontFamily: 'Roboto',
    fontSize: 14,
    fontWeight: 400,
    reduceMotion: false,
    perElement: {},                // element-key -> style overrides
    presets: [],
  },
  language: 'en',                  // en | yue | both
  funnyLevel: { en: 3, yue: 3 },
  disclosureAccepted: false,
  narrator: {
    enabled: false,
    language: 'en',                // en | yue | both
    voiceEn: '',
    voiceYue: '',
    rate: 1,
    pitch: 1,
    volume: 0.9,
    cooldownMs: 8000,
    categories: { transfer: true, error: true, connection: true, queue: true },
  },

  // ---------- Windows / layout ----------
  scpExplorer: { windowParams: '', dirViewParams: '', toolbarsLayout: '', statusBar: true, lastLocalTargetDirectory: '' },
  scpCommander: {
    windowParams: '', localPanelWidth: 0.5, toolbarsLayout: '', statusBar: true,
    currentPanel: 'left', compareByTime: true, compareBySize: false,
    swappedPanels: false, treeOnLeft: false, explorerKeyboardShortcuts: false,
    preserveLocalDirectory: false,
    localPanel: { dirViewParams: '', statusBar: true, driveView: false, driveViewWidth: 180, lastPath: '' },
    remotePanel: { dirViewParams: '', statusBar: true, driveView: false, driveViewWidth: 180, lastPath: '' },
  },

  // ---------- Queue ----------
  queue: {
    transfersLimit: 2,
    // "Use multiple connections for single transfer" — how many ranged chunks
    // one large file is split across. Only used when the protocol can resume
    // from an offset; 1 disables it.
    parallelTransfers: 1,
    // Below this size, splitting a file costs more in round trips than it
    // saves in throughput.
    parallelTransferThreshold: 10 * 1024 * 1024,
    keepDoneItemsFor: 15,          // seconds; -1 = forever, 0 = never
    autoPopup: true,
    rememberPassword: false,
    view: 'show',                  // show | hideWhenEmpty | hide
    toolbar: true,
    fileList: false,
    enabledByDefault: true,
    parallelDuplicateTransfers: true,
    individualTransfers: false,
    disconnectOnceEmpty: false,
    onceEmpty: 'none',             // none | disconnect | suspend | shutdown | idle
    noConfirmations: true,
    autoPopupPrompts: true,
  },

  // ---------- Logging ----------
  logging: {
    enabled: false,
    level: 0,                      // 0 normal, 1 debug1, 2 debug2
    logToFile: false,
    logFileName: '%TEMP%\\!S.log',
    logFileAppend: true,
    logMaxSize: 0,                 // bytes; 0 = unlimited
    logMaxCount: 0,
    logSensitive: false,
    logProtocol: 0,
    logWindowLines: 800,
    actionsLogging: false,
    actionsLogFileName: '%TEMP%\\!S.xml',
    logWindowComplete: false,
  },

  // ---------- Security / storage ----------
  security: {
    useMasterPassword: false,
    masterPasswordVerifier: '',
    storage: 'ini',                // ini | registry (ini only on this port)
    randomSeedFile: '',
    sessionReopenAuto: 5000,
    sessionReopenBackground: 2000,
    sessionReopenTimeout: 0,
    sessionReopenAutoStall: 0,
    sessionReopenAutoIdle: true,
    tryFtpWhenSshFails: true,
  },

  // ---------- Updates ----------
  updates: {
    period: 7 * 86400,             // seconds; 0 = never
    lastCheck: 0,
    showOnStartup: true,
    betaVersions: 'auto',          // auto | on | off
    connectionType: 'auto',
    authenticationEmail: '',
    results: null,
    shownResults: false,
  },

  // ---------- Integration ----------
  integration: {
    addSearchPath: false,
    desktopIcon: false,
    quickLaunchIcon: false,
    explorerUploadShortcut: false,
    dragExtEnabled: false,
    externalSessionInExistingInstance: true,
    useSharedBookmarks: false,
    puttyPath: '%PROGRAMFILES%\\PuTTY\\putty.exe',
    puttyPassword: false,
    autoOpenInPutty: false,
    telnetForFtpInPutty: true,
    puttygenPath: '%PROGRAMFILES%\\PuTTY\\puttygen.exe',
    pageantPath: '%PROGRAMFILES%\\PuTTY\\pageant.exe',
    checksumAlg: 'sha-1',
    localIconsFromExplorer: true,
  },

  // ---------- Window behaviour ----------
  window: {
    minimizeToTray: false,
    autoSaveWorkspace: false,
    autoSaveWorkspacePasswords: false,
    autoWorkspace: '',
    pathInCaption: 'short',        // full | short | none
    sessionTabCaptionTruncation: true,
    keepOpenWhenNoSession: true,
    lockToolbars: false,
    selectiveToolbarText: true,
    largeToolbarIcons: false,
    toolbarIconSize: 'normal',     // normal | large | veryLarge
    showTips: true,
    tipsSeen: '',
    tipsShown: 0,
    fullRowSelect: true,
    sessionTabs: true,
    openedTabsShortcut: true,
  },

  // ---------- Tabs (this port's tabbed navigation) ----------
  tabs: {
    order: [],
    pinned: [],
    groups: [],                    // {id,name,color,collapsed,icon,members[],style{}}
    groupOrder: [],
    truncateTitles: true,
    appearance: {},                // per-tab style overrides
  },

  // ---------- Transfer presets ----------
  copyParam: { ...COPY_PARAM_DEFAULTS },
  copyParamList: [],               // named presets, filled by config.js
  copyParamCurrent: '',
  copyParamAutoSelectNotice: true,

  // ---------- Custom commands ----------
  customCommands: [],              // filled by config.js
  extensions: [],

  // ---------- Bookmarks / history ----------
  bookmarks: {},                   // key -> {local:[], remote:[], shortCuts:{}}
  history: {},                     // combo-box histories
  locationProfiles: [],
  maxHistoryEntries: 40,

  // ---------- File colours ----------
  fileColors: [],                  // [{mask, color, dark}]

  // ---------- Version history (this port) ----------
  versionHistory: {
    enabled: true,
    retentionDays: 365,
    maxRevisions: 5000,
    snapshotSettings: true,
    snapshotSites: true,
  },

  // ---------- Dim sum surprise ----------
  dimSum: { lastShownLaunch: 0, seen: [] },
};

module.exports = { SESSION_DEFAULTS, COPY_PARAM_DEFAULTS, PREF_DEFAULTS };
