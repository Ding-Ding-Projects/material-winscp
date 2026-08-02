// ui/dialogs/sitetree.js — the stored-site model and the site tree widget.
//
// Two halves live here, and the split is deliberate:
//
//   1. THE MODEL (top of the file) is pure and DOM-free: protocol/port rules,
//      the per-protocol field-visibility rules from Login.cpp's UpdateControls,
//      WinSCP's three site-search match modes, and the folder/workspace tree
//      builder. test/sitedata.test.js imports exactly this half and runs it in
//      plain Node with no DOM shim, which is only possible because nothing up
//      here touches `document`.
//
//   2. THE WIDGET (bottom) is the tree the Login dialog puts on its left: New
//      Site, nested folders, sites and workspaces, with drag reordering, drag
//      between folders, the full WinSCP context menus, and the incremental
//      search the three match modes drive.
//
// Everything else in this directory builds on the model here, so this module
// imports none of them — the dependency graph is a tree, not a cycle.
//
// Reference: vendor/winscp/source/forms/Login.{dfm,cpp} (SessionTree,
// SearchSite, UpdateControls) and vendor/winscp/source/core/SessionData.cpp.

import {
  h, icon, clear, uid, appearanceTarget, announce, oneLine, rovingFocus,
} from '../../dom.js';
import { t, bindText } from '../../i18n.js';
import { api, bus } from '../../state.js';
import { styleSheet } from '../../theme.js';
import { registerContextMenu, SEPARATOR } from '../contextmenu.js';
import { notify } from '../notifications.js';

/* ================================================================== */
/* session data model                                                  */
/* ================================================================== */

/**
 * The renderer's mirror of design/main/defaults.js SESSION_DEFAULTS.
 *
 * main's copy is CommonJS and cannot be imported by an ES module in the
 * renderer, so it is restated here. Keys marked "(port key)" have no
 * counterpart in main's SESSION_DEFAULTS yet: WinSCP has the control, this
 * port has no option declared for it. They round-trip safely because
 * ipc.js validateSite() passes unknown keys through and config.js deep-merges
 * them onto the stored site, so the user's value is kept rather than dropped —
 * which is the one thing the appearance/settings rules forbid.
 */
export const SESSION_DEFAULTS = Object.freeze({
  id: '',
  name: '',
  folder: '',
  protocol: 'sftp',
  hostName: '',
  portNumber: 22,
  userName: '',
  password: '',
  savePassword: false,
  anonymous: false,
  color: '',
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
  puttySettings: '',              // (port key) PuttySettingsEdit
  ssh2DES: false,                 // (port key) Ssh2LegacyDESCheck
  sshBugs: {                      // (port key) BugsSheet — auto | on | off
    hmac2: 'auto', deriveKey2: 'auto', rsaPad2: 'auto', pkSessID2: 'auto',
    rekey2: 'auto', maxPkt2: 'auto', ignore2: 'auto', winadj: 'auto',
  },

  // --- SFTP ---
  sftpServer: '',
  sftpMaxVersion: 6,
  sftpMinPacketSize: 0,
  sftpMaxPacketSize: 0,
  sftpDownloadQueue: 32,
  sftpUploadQueue: 32,
  sftpListingQueue: 2,
  sftpRealPath: 'auto',
  usePosixRename: false,
  allowScpFallback: true,         // (port key) AllowScpFallbackCheck
  sftpBugs: { symlink: 'auto', signedTS: 'auto' },

  // --- SCP / shell ---
  shell: '',
  returnVar: '',
  lookupUserGroups: 'auto',
  eolType: 'lf',
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
  ftps: 'none',
  ftpForcePasvIp: 'auto',
  ftpUseMlsd: 'auto',
  ftpAccount: '',
  ftpPingInterval: 30,
  ftpPingType: 'dummy',
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
  webDavCrossDomainRedirects: false,   // (port key) WebDavCrossDomainRedirectsCheck

  // --- S3 ---
  s3DefaultRegion: '',
  s3SessionToken: '',
  s3RoleArn: '',
  s3Profile: '',
  s3UrlStyle: 'virtualhost',
  s3MaxKeys: 'auto',
  s3CredentialsEnv: false,
  s3RequesterPays: false,
  s3StorageClass: '',

  // --- Connection ---
  timeout: 15,
  pingInterval: 30,
  pingType: 'off',
  addressFamily: 'auto',
  codePage: 'UTF-8',
  sendBuf: 262144,
  sourceAddress: '',
  protocolFeatures: '',

  // --- Proxy ---
  proxyMethod: 'none',
  proxyHost: '',
  proxyPort: 0,
  proxyUsername: '',
  proxyPassword: '',
  proxyTelnetCommand: 'connect %host %port\\n',
  proxyLocalCommand: '',
  proxyDNS: 'auto',
  proxyLocalhost: false,
  ftpProxyLogonType: 0,           // (port key) FtpProxyMethodCombo's SITE/USER forms

  // --- Tunnel ---
  tunnel: false,
  tunnelHostName: '',
  tunnelPortNumber: 22,
  tunnelUserName: '',
  tunnelPassword: '',
  tunnelPublicKeyFile: '',
  tunnelPassphrase: '',
  tunnelLocalPortNumber: 0,
  tunnelHostKey: '',

  // --- Directories ---
  localDirectory: '',
  remoteDirectory: '',
  updateDirectories: true,
  cacheDirectories: true,
  cacheDirectoryChanges: true,
  preserveDirectoryChanges: true,
  resolveSymlinks: true,
  followDirectorySymlinks: false,
  synchronizeBrowsing: false,

  // --- Environment ---
  dSTMode: 'unix',
  trimVMSVersions: false,
  vMSAllRevisions: false,
  utf: 'auto',

  // --- Recycle bin ---
  deleteToRecycleBin: false,
  overwrittenToRecycleBin: false,
  recycleBinPath: '/tmp',

  // --- Encryption at rest ---
  encryptFiles: false,
  encryptKey: '',

  // --- Shell / post-login ---
  postLoginCommands: [],

  // --- Host key ---
  hostKey: '',
  fingerprintScan: true,

  // --- Transfer settings rule (port keys) ---
  // CopyParamRuleAction on the Login dialog: which named transfer preset this
  // site selects by default, and the optional file mask that narrows the rule.
  copyParamRule: '',
  copyParamRuleMask: '',
});

/**
 * Fields main replaces with the sentinel '__stored__' in config:sites, so the
 * renderer learns *that* a secret exists and never *what* it is. Writing the
 * sentinel back would overwrite the real secret with that literal string, so
 * every save path strips it.
 */
export const SECRET_FIELDS = Object.freeze([
  'password', 'passphrase', 'proxyPassword', 'tunnelPassword',
  'tunnelPassphrase', 'encryptKey', 's3SessionToken',
]);

export const SECRET_SENTINEL = '__stored__';

/** WinSCP's anonymous-FTP credentials (core/SessionData.cpp). */
export const ANONYMOUS_USER = 'anonymous';
export const ANONYMOUS_PASSWORD = 'anonymous@example.com';

/**
 * The file protocols, in TransferProtocolCombo's order, with the URL scheme
 * WinSCP writes for each encryption state and the port it defaults to.
 * `family` drives which proxy combo and which advanced pages apply.
 */
export const PROTOCOLS = Object.freeze([
  { id: 'sftp', label: 'SFTP', family: 'ssh', encryption: null, defaultPort: 22, schemes: { none: 'sftp' } },
  { id: 'scp', label: 'SCP', family: 'ssh', encryption: null, defaultPort: 22, schemes: { none: 'scp' } },
  {
    id: 'ftp', label: 'FTP', family: 'ftp', defaultPort: 21,
    encryption: [
      { id: 'none', label: 'No encryption', port: 21, scheme: 'ftp' },
      { id: 'implicit', label: 'TLS/SSL Implicit encryption', port: 990, scheme: 'ftps' },
      { id: 'explicitTls', label: 'TLS/SSL Explicit encryption', port: 21, scheme: 'ftpes' },
    ],
  },
  {
    id: 'webdav', label: 'WebDAV', family: 'neon', defaultPort: 80,
    encryption: [
      { id: 'none', label: 'No encryption', port: 80, scheme: 'dav' },
      { id: 'implicit', label: 'TLS/SSL Implicit encryption', port: 443, scheme: 'davs' },
    ],
  },
  {
    id: 's3', label: 'Amazon S3', family: 'neon', defaultPort: 443,
    encryption: [
      { id: 'none', label: 'No encryption', port: 80, scheme: 's3plain' },
      { id: 'implicit', label: 'TLS/SSL Implicit encryption', port: 443, scheme: 's3' },
    ],
  },
]);

const PROTOCOL_BY_ID = new Map(PROTOCOLS.map((p) => [p.id, p]));

export function protocolInfo(id) {
  return PROTOCOL_BY_ID.get(String(id || '').toLowerCase()) || PROTOCOL_BY_ID.get('sftp');
}

/** The encryption choices a protocol offers, or [] when it offers none. */
export function encryptionOptions(protocol) {
  return protocolInfo(protocol).encryption || [];
}

/**
 * The port a site would use if the user has not overridden it. This is the one
 * function the port box, the URL builder and the "is this the default port?"
 * test all go through, so they can never disagree.
 */
export function defaultPortFor(protocol, ftps = 'none') {
  const info = protocolInfo(protocol);
  if (!info.encryption) return info.defaultPort;
  const enc = info.encryption.find((e) => e.id === ftps);
  return enc ? enc.port : info.defaultPort;
}

/** The URL scheme WinSCP writes for this protocol + encryption combination. */
export function schemeFor(protocol, ftps = 'none') {
  const info = protocolInfo(protocol);
  if (!info.encryption) return info.schemes.none;
  const enc = info.encryption.find((e) => e.id === ftps);
  return enc ? enc.scheme : info.encryption[0].scheme;
}

/** True when the site's port is whatever its protocol would pick anyway. */
export function isDefaultPort(site) {
  const d = defaultPortFor(site.protocol, site.ftps);
  return !site.portNumber || Number(site.portNumber) === d;
}

/**
 * Login.cpp UpdateControls(), transcribed. Which session-form controls are
 * visible, which are enabled, and what the two credential labels say — all of
 * it derived from the protocol and the S3/SSH flags rather than from a pile of
 * ad-hoc `if`s at each call site.
 *
 * `editable` is WinSCP's IsEditable(): false while a stored site is being
 * viewed rather than edited, which turns the combos into read-only views.
 */
export function fieldVisibility(site = {}, { editable = true } = {}) {
  const protocol = String(site.protocol || 'sftp').toLowerCase();
  const info = protocolInfo(protocol);
  const ssh = info.family === 'ssh';
  const ftp = protocol === 'ftp';
  const webdav = protocol === 'webdav';
  const s3 = protocol === 's3';

  const s3CredentialsEnv = s3 && !!site.s3CredentialsEnv;
  // SSH "bypass authentication entirely" and S3 environment credentials both
  // mean there is nothing for the user to type — the fields stay visible and
  // keep their value, they are simply not accepting input.
  const noAuth = editable && ((ssh && !!site.sshNoUserAuth) || s3CredentialsEnv);

  return {
    protocol,
    family: info.family,
    ssh,
    ftp,
    webdav,
    s3,
    transferProtocolCombo: editable,
    transferProtocolView: !editable,
    ftpsCombo: editable && ftp,
    ftpsLabel: ftp,
    webDavsCombo: editable && (webdav || s3),
    webDavsLabel: webdav || s3,
    encryptionView: !editable && (ftp || webdav || s3),
    basicSshPanel: ssh,
    basicFtpPanel: ftp && editable,
    basicS3Panel: s3 && editable,
    anonymousCheck: ftp && editable,
    hostNameReadOnly: !editable,
    portNumberReadOnly: !editable,
    userNameEnabled: !noAuth,
    passwordEnabled: !noAuth,
    s3ProfileEnabled: s3CredentialsEnv,
    // S3 renames both credential fields; WinSCP loads S3_ACCESS_KEY_ID_PROMPT
    // and S3_SECRET_ACCESS_KEY_PROMPT for exactly this case.
    userNameLabel: s3 ? 'Access key ID' : null,
    passwordLabel: s3 ? 'Secret access key' : null,
  };
}

/** True when the credentials are WinSCP's anonymous-FTP pair. */
export function isAnonymous(site = {}) {
  return String(site.userName || '').toLowerCase() === ANONYMOUS_USER
    && String(site.password || '').toLowerCase() === ANONYMOUS_PASSWORD;
}

/** A brand-new, unsaved site — the "New Site" node's backing data. */
export function newSiteData(overrides = {}) {
  return { ...structuredCloneish(SESSION_DEFAULTS), id: '', name: '', ...overrides };
}

function structuredCloneish(value) {
  try { return structuredClone(value); } catch { return JSON.parse(JSON.stringify(value)); }
}

/**
 * Fill in whatever the caller left out and repair the port when it still holds
 * the previous protocol's default, which is what makes switching SFTP -> FTP
 * land on 21 instead of a stale 22.
 */
export function normalizeSite(site = {}, previous = null) {
  const out = { ...structuredCloneish(SESSION_DEFAULTS), ...site };
  out.protocol = protocolInfo(out.protocol).id;
  if (!encryptionOptions(out.protocol).some((e) => e.id === out.ftps)) {
    out.ftps = out.protocol === 's3' ? 'implicit' : 'none';
  }
  const prevDefault = previous
    ? defaultPortFor(previous.protocol, previous.ftps)
    : null;
  const port = Number(out.portNumber);
  if (!Number.isFinite(port) || port <= 0 || (prevDefault !== null && port === prevDefault)) {
    out.portNumber = defaultPortFor(out.protocol, out.ftps);
  }
  return out;
}

/** What a site is called in the tree: its name, or user@host as a fallback. */
export function siteLabel(site = {}) {
  if (site.name) return site.name;
  const host = site.hostName || '';
  return site.userName ? `${site.userName}@${host}` : host || t('newSite');
}

/** The one-line summary under a site row and in its tooltip. */
export function siteSummary(site = {}) {
  const info = protocolInfo(site.protocol);
  const parts = [info.label];
  if (site.hostName) {
    parts.push(isDefaultPort(site) ? site.hostName : `${site.hostName}:${site.portNumber}`);
  }
  if (site.userName) parts.push(site.userName);
  return parts.join(' · ');
}

/* ------------------------------------------------------------------ */
/* site search — WinSCP's three match modes                            */
/* ------------------------------------------------------------------ */

/**
 * The three modes SearchSiteNameStartOnlyAction / SearchSiteNameAction /
 * SearchSiteAction select between, with the ids used in config and in menus.
 */
export const SITE_SEARCH_MODES = Object.freeze([
  { id: 'nameStartOnly', label: 'Beginning of site name only' },
  { id: 'name', label: 'Any part of site name' },
  { id: 'all', label: 'All major site fields' },
]);

export const DEFAULT_SITE_SEARCH_MODE = 'name';

/**
 * ContainsTextSemiCaseSensitive (core/Common.cpp): an all-lowercase needle
 * matches case-insensitively, anything with a capital in it matches exactly.
 * That is what lets a user type "prod" to find "Production" and "DB" to find
 * only "DB-01" rather than every "db" as well.
 */
export function containsTextSemiCaseSensitive(text, sub) {
  const needle = String(sub ?? '');
  if (!needle) return true;
  const hay = String(text ?? '');
  return needle.toLowerCase() === needle
    ? hay.toLowerCase().includes(needle.toLowerCase())
    : hay.includes(needle);
}

/**
 * Does one tree node match? `all` widens the search past the visible label to
 * the host name, the user name and the note — but only for site nodes, exactly
 * as SearchSite() does.
 */
export function siteNodeMatches(node, text, mode = DEFAULT_SITE_SEARCH_MODE) {
  if (!node) return false;
  const needle = String(text ?? '');
  if (!needle) return false;
  const label = String(node.label ?? '');
  switch (mode) {
    case 'nameStartOnly':
      return containsTextSemiCaseSensitive(label.slice(0, needle.length), needle);
    case 'all': {
      if (containsTextSemiCaseSensitive(label, needle)) return true;
      if (node.kind !== 'site' || !node.site) return false;
      const d = node.site;
      return containsTextSemiCaseSensitive(d.hostName, needle)
        || containsTextSemiCaseSensitive(d.userName, needle)
        || containsTextSemiCaseSensitive(d.note, needle);
    }
    case 'name':
    default:
      return containsTextSemiCaseSensitive(label, needle);
  }
}

/** Depth-first order — the order the tree is drawn in, and searched in. */
export function flattenTree(nodes, out = []) {
  for (const node of nodes || []) {
    out.push(node);
    if (node.children && node.children.length) flattenTree(node.children, out);
  }
  return out;
}

/**
 * SearchSite(): walk from the current node, wrapping once, and return the
 * first node that matches. `allowExpanding` false skips nodes buried inside a
 * collapsed folder, which is how WinSCP's incremental search refuses to jump
 * somewhere the user cannot see.
 */
export function searchSiteNodes(nodes, text, mode = DEFAULT_SITE_SEARCH_MODE, opts = {}) {
  const { fromId = null, skipCurrent = false, reverse = false, allowExpanding = true } = opts;
  const flat = flattenTree(nodes);
  if (!flat.length || !String(text ?? '')) return null;

  const startIndex = fromId ? flat.findIndex((n) => n.id === fromId) : 0;
  const current = startIndex >= 0 ? startIndex : 0;
  const step = reverse ? -1 : 1;
  const total = flat.length;

  let index = current;
  if (skipCurrent) index = (index + step + total) % total;

  for (let visited = 0; visited < total; visited += 1) {
    const node = flat[index];
    if (node && (allowExpanding || isReachable(node))) {
      if (siteNodeMatches(node, text, mode)) return node;
    }
    index = (index + step + total) % total;
    if (index === current && visited > 0) break;
  }
  return null;
}

/** Eligible only when every ancestor folder is expanded (SearchSite's loop). */
function isReachable(node) {
  let parent = node.parent;
  while (parent) {
    if (parent.kind !== 'folder' || !parent.expanded) return false;
    parent = parent.parent;
  }
  return true;
}

/**
 * Every node that matches, in tree order. The tree's filter view uses this
 * while the incremental search uses searchSiteNodes(); they share one
 * predicate so the two can never disagree about what "matches" means.
 */
export function filterSiteNodes(nodes, text, mode = DEFAULT_SITE_SEARCH_MODE) {
  if (!String(text ?? '')) return flattenTree(nodes);
  return flattenTree(nodes).filter((n) => siteNodeMatches(n, text, mode));
}

/* ------------------------------------------------------------------ */
/* tree construction                                                   */
/* ------------------------------------------------------------------ */

/**
 * buildSiteTree({ sites, folders, workspaces, expanded }) -> node[]
 *
 * The node shape the widget and the search share:
 *   { id, kind:'newSite'|'folder'|'site'|'workspace', label, path,
 *     site?, workspace?, children[], parent, expanded, level }
 *
 * Folders are stored as '/'-separated paths on the site (WinSCP's own model),
 * so an intermediate folder that holds only other folders still has to exist
 * as a node. Any folder path implied by a site is materialised even when it is
 * missing from the folders list, so a site can never become unreachable.
 */
export function buildSiteTree({ sites = [], folders = [], workspaces = [], expanded = null, includeNewSite = true } = {}) {
  const isExpanded = (path) => (expanded ? expanded.has(path) : true);
  const roots = [];
  const folderNodes = new Map();     // path -> node

  function ensureFolder(path) {
    if (!path) return null;
    if (folderNodes.has(path)) return folderNodes.get(path);
    const segments = path.split('/').filter(Boolean);
    const name = segments[segments.length - 1] || path;
    const parentPath = segments.slice(0, -1).join('/');
    const parent = parentPath ? ensureFolder(parentPath) : null;
    const node = {
      id: `folder:${path}`,
      kind: 'folder',
      label: name,
      path,
      children: [],
      parent,
      expanded: isExpanded(path),
      level: segments.length - 1,
    };
    folderNodes.set(path, node);
    (parent ? parent.children : roots).push(node);
    return node;
  }

  if (includeNewSite) {
    roots.push({
      id: 'new-site', kind: 'newSite', label: t('newSite'), path: '',
      children: [], parent: null, expanded: false, level: 0,
    });
  }

  for (const path of folders) ensureFolder(String(path || '').replace(/^\/+|\/+$/g, ''));

  for (const site of sites) {
    const folderPath = String(site.folder || '').replace(/^\/+|\/+$/g, '');
    const parent = folderPath ? ensureFolder(folderPath) : null;
    const node = {
      id: `site:${site.id || siteLabel(site)}`,
      kind: 'site',
      label: siteLabel(site),
      path: folderPath,
      site,
      children: [],
      parent,
      expanded: false,
      level: parent ? parent.level + 1 : 0,
    };
    (parent ? parent.children : roots).push(node);
  }

  if (workspaces.length) {
    for (const ws of workspaces) {
      roots.push({
        id: `workspace:${ws.name || ws}`,
        kind: 'workspace',
        label: ws.name || String(ws),
        path: '',
        workspace: ws,
        children: [],
        parent: null,
        expanded: false,
        level: 0,
      });
    }
  }

  sortNodes(roots);
  for (const node of folderNodes.values()) sortNodes(node.children);
  return roots;
}

/** New Site first, then folders, then sites, then workspaces — each by name. */
function sortNodes(list) {
  const rank = { newSite: 0, folder: 1, site: 2, workspace: 3 };
  list.sort((a, b) => (rank[a.kind] - rank[b.kind])
    || a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' }));
  return list;
}

/** Every distinct folder path, including the intermediate ones. */
export function folderPathsOf(sites = [], folders = []) {
  const set = new Set();
  const add = (p) => {
    const clean = String(p || '').replace(/^\/+|\/+$/g, '');
    if (!clean) return;
    const segments = clean.split('/').filter(Boolean);
    for (let i = 1; i <= segments.length; i += 1) set.add(segments.slice(0, i).join('/'));
  };
  folders.forEach(add);
  sites.forEach((s) => add(s.folder));
  return Array.from(set).sort();
}

/* ================================================================== */
/* the stored-site store                                               */
/* ================================================================== */
//
// state.js owns the `api` façade and is another agent's file, so the site
// capabilities are wrapped here instead of added there. `api.raw` is the
// façade's own documented escape hatch; this module never reaches for
// window.api itself, and it keeps the degraded (no-preload) path in one place
// exactly the way state.js does for preferences.

const LS_SITES_KEY = 'winscp-material.renderer.sites';

function localSites() {
  try { return JSON.parse(localStorage.getItem(LS_SITES_KEY) || '{"sites":[],"folders":[],"workspaces":[]}'); }
  catch { return { sites: [], folders: [], workspaces: [] }; }
}
function writeLocalSites(doc) {
  try { localStorage.setItem(LS_SITES_KEY, JSON.stringify(doc)); return true; } catch { return false; }
}

function unwrap(res) {
  if (res == null) return null;
  if (typeof res === 'object' && 'ok' in res) {
    if (res.ok) return res.value;
    const e = res.error;
    const err = new Error((e && e.message) || String(e) || 'The request failed.');
    if (e && e.code) err.code = e.code;
    throw err;
  }
  return res;
}

/** Strip the '__stored__' sentinel and any secret the user did not retype. */
export function stripSecrets(patch, { keep = [] } = {}) {
  const out = { ...patch };
  for (const f of SECRET_FIELDS) {
    if (keep.includes(f)) continue;
    if (out[f] === SECRET_SENTINEL || out[f] === undefined) delete out[f];
  }
  return out;
}

export const siteStore = {
  get degraded() { return !api.raw?.config?.sites; },

  async load() {
    const cfg = api.raw?.config;
    if (cfg?.sites) {
      const [sites, workspaces, doc] = await Promise.all([
        cfg.sites().then(unwrap),
        cfg.workspaces().then(unwrap).catch(() => []),
        cfg.get().then(unwrap).catch(() => null),
      ]);
      return {
        sites: sites || [],
        folders: (doc && doc.folders) || [],
        workspaces: workspaces || [],
      };
    }
    return localSites();
  },

  async addSite(site) {
    const cfg = api.raw?.config;
    if (cfg?.addSite) return unwrap(await cfg.addSite(site));
    const doc = localSites();
    const added = { ...site, id: site.id || uid('site') };
    doc.sites.push(added);
    writeLocalSites(doc);
    return added;
  },

  async updateSite(id, patch) {
    const cfg = api.raw?.config;
    if (cfg?.updateSite) return unwrap(await cfg.updateSite(id, patch));
    const doc = localSites();
    const i = doc.sites.findIndex((s) => s.id === id);
    if (i < 0) throw new Error('No such site.');
    doc.sites[i] = { ...doc.sites[i], ...patch };
    writeLocalSites(doc);
    return doc.sites[i];
  },

  async removeSite(id) {
    const cfg = api.raw?.config;
    if (cfg?.removeSite) return unwrap(await cfg.removeSite(id));
    const doc = localSites();
    doc.sites = doc.sites.filter((s) => s.id !== id);
    writeLocalSites(doc);
    return true;
  },

  async duplicateSite(id, name) {
    const cfg = api.raw?.config;
    if (cfg?.duplicateSite) return unwrap(await cfg.duplicateSite(id, name));
    const doc = localSites();
    const src = doc.sites.find((s) => s.id === id);
    if (!src) throw new Error('No such site.');
    const copy = { ...src, id: uid('site'), name: name || `${src.name} (copy)` };
    doc.sites.push(copy);
    writeLocalSites(doc);
    return copy;
  },

  async moveSite(id, folder) {
    const cfg = api.raw?.config;
    if (cfg?.moveSite) return unwrap(await cfg.moveSite(id, folder || ''));
    return this.updateSite(id, { folder: folder || '' });
  },

  async addFolder(path) {
    const cfg = api.raw?.config;
    if (cfg?.addFolder) return unwrap(await cfg.addFolder(path));
    const doc = localSites();
    if (!doc.folders.includes(path)) doc.folders.push(path);
    writeLocalSites(doc);
    return true;
  },

  async renameFolder(from, to) {
    const cfg = api.raw?.config;
    if (cfg?.renameFolder) return unwrap(await cfg.renameFolder(from, to));
    const doc = localSites();
    doc.folders = doc.folders.map((f) => (f === from ? to : f.startsWith(`${from}/`) ? to + f.slice(from.length) : f));
    doc.sites = doc.sites.map((s) => (s.folder === from || String(s.folder || '').startsWith(`${from}/`)
      ? { ...s, folder: to + String(s.folder).slice(from.length) } : s));
    writeLocalSites(doc);
    return true;
  },

  async removeFolder(path, deleteSites) {
    const cfg = api.raw?.config;
    if (cfg?.removeFolder) return unwrap(await cfg.removeFolder(path, !!deleteSites));
    const doc = localSites();
    doc.folders = doc.folders.filter((f) => f !== path && !f.startsWith(`${path}/`));
    doc.sites = deleteSites
      ? doc.sites.filter((s) => s.folder !== path && !String(s.folder || '').startsWith(`${path}/`))
      : doc.sites.map((s) => (s.folder === path ? { ...s, folder: '' } : s));
    writeLocalSites(doc);
    return true;
  },

  async saveWorkspace(name, sessions) {
    const cfg = api.raw?.config;
    if (cfg?.saveWorkspace) return unwrap(await cfg.saveWorkspace(name, sessions));
    const doc = localSites();
    doc.workspaces = [...doc.workspaces.filter((w) => (w.name || w) !== name), { name, sessions: sessions || [] }];
    writeLocalSites(doc);
    return true;
  },

  async removeWorkspace(name) {
    const cfg = api.raw?.config;
    if (cfg?.removeWorkspace) return unwrap(await cfg.removeWorkspace(name));
    const doc = localSites();
    doc.workspaces = doc.workspaces.filter((w) => (w.name || w) !== name);
    writeLocalSites(doc);
    return true;
  },
};

/* ================================================================== */
/* shared stylesheet                                                   */
/* ================================================================== */
//
// One managed sheet for every session dialog. index.html's CSP allows
// 'unsafe-inline' style precisely so runtime sheets like this one and the
// appearance editor's can exist; nothing here loads from the network.
// Every measurement is against --den and --uiscale so the dialogs hold at
// 100/125/150/200% and in bilingual mode, where labels are longest.

let stylesInstalled = false;

export function installSessionDialogStyles() {
  if (stylesInstalled) return;
  stylesInstalled = true;
  styleSheet('session-dialogs').set(`
/* components.css sizes every modal at min(560px, 100%), which is right for a
   confirmation and far too narrow for a two-column session dialog. These rules
   widen only the modals that actually contain one of ours, so the shared
   stylesheet stays untouched and every other dialog keeps its size. */
.modal:has(.sd-wide-sm) { width: min(680px, 100%); }
.modal:has(.sd-wide-md) { width: min(860px, 100%); }
.modal:has(.sd-wide-lg) { width: min(1100px, 100%); height: min(880px, calc(100vh - 48px)); }
.modal-body:has(> .sd-wide) { overflow-x: hidden; }
/* The two-column dialogs manage their own scrolling so their action buttons
   stay pinned; a Login button that scrolls off the bottom is a defect, not a
   layout choice. */
.modal-body:has(> .sd-wide-lg) { display: flex; overflow: hidden; }
.sd-wide-lg { flex: 1 1 auto; min-height: 0; }

.sd-split { display: flex; gap: calc(14px * var(--den)); min-height: 0; align-items: stretch; min-width: 0; }
.sd-left { display: flex; flex-direction: column; gap: calc(8px * var(--den));
  width: calc(280px * var(--uiscale)); flex: 0 1 auto; min-width: calc(200px * var(--uiscale)); }
.sd-right { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: calc(10px * var(--den)); }
@media (max-width: 900px) { .sd-split { flex-direction: column; } .sd-left { width: auto; } }

.sd-group { border: 1px solid var(--outline-var); border-radius: var(--shape-md);
  padding: calc(12px * var(--den)); display: flex; flex-direction: column; gap: calc(10px * var(--den)); min-width: 0; }
.sd-group[hidden] { display: none !important; }
.sd-group > legend, .sd-group-title { font-size: var(--type-label-md); font-weight: 600;
  color: var(--onsv); padding: 0 4px; }
.sd-group.is-disabled { opacity: .55; }
/* A capped label column: max-content would let one long caption ("End-of-line
   characters (if not indicated by server):") push the whole grid wider than
   its dialog, which is exactly the silent clipping the rules forbid. Capping it
   makes the label wrap instead. */
.sd-grid { display: grid; grid-template-columns: minmax(9ch, 24ch) minmax(0, 1fr);
  gap: calc(8px * var(--den)) calc(12px * var(--den)); align-items: center; min-width: 0; }
@media (max-width: 620px) { .sd-grid { grid-template-columns: minmax(0, 1fr); } }
.sd-grid > .sd-label { justify-self: start; }
.sd-full { grid-column: 1 / -1; }
.sd-label { font-size: var(--type-label-md); color: var(--onsv); line-height: 1.3; }
.sd-label.is-disabled { opacity: .5; }
.sd-row { display: flex; align-items: center; gap: calc(8px * var(--den)); flex-wrap: wrap; min-width: 0; }
.sd-row.is-tight { gap: calc(4px * var(--den)); flex-wrap: nowrap; }
.sd-hint { font-size: var(--type-label-sm); color: var(--onsv); line-height: 1.4; }
.sd-note { display: flex; gap: 8px; align-items: flex-start; padding: calc(9px * var(--den));
  border-radius: var(--shape-sm); background: var(--terc); color: var(--onterc);
  font-size: var(--type-label-sm); line-height: 1.45; }
.sd-note.is-warn { background: var(--errc); color: var(--onerrc); }
.sd-note svg { margin-top: 1px; }

.sd-input { min-height: var(--control-h); padding: 0 calc(12px * var(--den));
  border: 1px solid var(--outline); border-radius: var(--shape-xs);
  background: var(--c-lowest); color: var(--onsfc); min-width: 0; width: 100%; }
.sd-input:focus-visible { border-color: var(--p); outline-offset: 0; }
.sd-input:disabled { opacity: .5; background: var(--c-low); cursor: default; }
.sd-input[readonly] { background: var(--c-low); }
textarea.sd-input { padding: calc(8px * var(--den)) calc(12px * var(--den)); resize: vertical;
  min-height: calc(72px * var(--den)); line-height: 1.5; }
select.sd-input { appearance: auto; }
.sd-num { width: calc(94px * var(--uiscale)); flex: 0 0 auto; text-align: right; }
.sd-stepper { display: inline-flex; flex-direction: column; gap: 1px; flex: 0 0 auto; }
.sd-stepper button { width: calc(24px * var(--den)); height: calc(19px * var(--den));
  border: 1px solid var(--outline); background: var(--c-low); color: var(--onsv);
  display: flex; align-items: center; justify-content: center; }
.sd-stepper button:first-child { border-radius: var(--shape-xs) var(--shape-xs) 0 0; }
.sd-stepper button:last-child { border-radius: 0 0 var(--shape-xs) var(--shape-xs); }
.sd-stepper button:hover { background: var(--c-high); }
.sd-stepper button:disabled { opacity: .38; cursor: default; }

.sd-check { display: flex; align-items: flex-start; gap: calc(9px * var(--den));
  min-height: calc(30px * var(--den)); cursor: pointer; line-height: 1.35; padding: 2px 0; }
.sd-check input { margin-top: calc(3px * var(--uiscale)); flex: 0 0 auto; }
.sd-check.is-disabled { opacity: .5; cursor: default; }
.sd-check-text { min-width: 0; }

.sd-radios { display: flex; flex-direction: column; gap: 2px; }
.sd-radios.is-inline { flex-direction: row; flex-wrap: wrap; gap: calc(14px * var(--den)); }

.sd-btnrow { display: flex; align-items: center; gap: calc(8px * var(--den)); flex-wrap: wrap; }
.sd-btnrow .spacer { flex: 1 1 auto; }

/* ---- site tree ---- */
/* The tree's own wrapper, NOT .sd-left: a host dialog puts this inside its own
   .sd-left, and two nested columns both sized "shrink to fit" is what stops the
   tree growing into the space the dialog has. */
.st-wrap { display: flex; flex-direction: column; gap: calc(8px * var(--den));
  flex: 1 1 auto; min-height: calc(180px * var(--uiscale)); min-width: 0; }
.st { flex: 1 1 auto; min-height: calc(160px * var(--uiscale)); overflow: auto;
  border: 1px solid var(--outline-var); border-radius: var(--shape-md);
  background: var(--c-lowest); padding: calc(4px * var(--den)); }
.st-row { display: flex; align-items: center; gap: calc(6px * var(--den));
  min-height: calc(32px * var(--den)); padding: 0 calc(6px * var(--den));
  border-radius: var(--shape-sm); cursor: default; user-select: none; min-width: 0; }
.st-row:hover { background: color-mix(in srgb, var(--onsfc) 7%, transparent); }
.st-row.is-selected { background: var(--secc); color: var(--onsecc); }
.st-row.is-match { outline: 1px dashed var(--p); outline-offset: -2px; }
.st-row.is-dragover-into { background: var(--pc); color: var(--onpc); }
.st-row.is-dragover-before { box-shadow: inset 0 2px 0 var(--p); }
.st-row.is-dragover-after { box-shadow: inset 0 -2px 0 var(--p); }
.st-twisty { width: calc(20px * var(--den)); height: calc(20px * var(--den)); flex: 0 0 auto;
  display: flex; align-items: center; justify-content: center; border-radius: var(--shape-full); color: var(--onsv); }
.st-twisty:hover { background: color-mix(in srgb, var(--onsfc) 12%, transparent); }
.st-twisty.is-blank { visibility: hidden; }
.st-icon { flex: 0 0 auto; color: var(--onsv); display: flex; }
.st-row.is-selected .st-icon { color: inherit; }
.st-text { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
.st-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--type-body-sm); }
.st-sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: var(--type-label-sm); color: var(--onsv); }
.st-row.is-selected .st-sub { color: inherit; opacity: .85; }
.st-dot { width: 8px; height: 8px; border-radius: var(--shape-full); flex: 0 0 auto; }
.st-empty { padding: calc(16px * var(--den)); color: var(--onsv); font-size: var(--type-body-sm); line-height: 1.5; }
.st-inc { display: flex; align-items: center; gap: 6px; padding: calc(6px * var(--den)) calc(10px * var(--den));
  border-radius: var(--shape-sm); background: var(--pc); color: var(--onpc); font-size: var(--type-label-sm); }
.st-inc.is-nomatch { background: var(--errc); color: var(--onerrc); }
.st-rename { min-height: calc(26px * var(--den)); padding: 0 6px; border: 1px solid var(--p);
  border-radius: var(--shape-xs); background: var(--c-lowest); color: var(--onsfc); flex: 1 1 auto; min-width: 0; }

/* ---- advanced dialog ---- */
.sa-nav { width: calc(216px * var(--uiscale)); flex: 0 0 auto; overflow: auto;
  border: 1px solid var(--outline-var); border-radius: var(--shape-md);
  background: var(--c-lowest); padding: calc(4px * var(--den)); }
@media (max-width: 900px) { .sa-nav { width: auto; max-height: calc(150px * var(--uiscale)); } }
.sa-nav-item { display: flex; align-items: center; gap: calc(8px * var(--den));
  min-height: calc(32px * var(--den)); padding: 0 calc(8px * var(--den));
  border-radius: var(--shape-sm); width: 100%; text-align: left; color: var(--onsfc);
  font-size: var(--type-body-sm); }
.sa-nav-item:hover { background: color-mix(in srgb, var(--onsfc) 8%, transparent); }
.sa-nav-item[aria-selected="true"] { background: var(--secc); color: var(--onsecc); font-weight: 600; }
.sa-nav-item.is-off { opacity: .55; }
.sa-nav-item .sa-nav-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sa-nav-count { font-size: var(--type-label-sm); background: var(--pc); color: var(--onpc);
  border-radius: var(--shape-full); padding: 0 6px; flex: 0 0 auto; }
.sa-page { flex: 1 1 auto; min-width: 0; overflow: auto; display: flex; flex-direction: column;
  gap: calc(12px * var(--den)); padding-right: 4px; }
.sa-page-head { display: flex; align-items: center; gap: calc(10px * var(--den)); flex-wrap: wrap; }
.sa-page-title { font-size: var(--type-title-md); font-weight: 500; flex: 0 0 auto; }
.sa-order { display: flex; gap: calc(8px * var(--den)); align-items: stretch; }
.sa-orderlist { flex: 1 1 auto; min-width: 0; min-height: calc(170px * var(--uiscale));
  max-height: calc(260px * var(--uiscale)); overflow: auto;
  border: 1px solid var(--outline); border-radius: var(--shape-xs); background: var(--c-lowest); }
.sa-orderitem { display: flex; align-items: center; gap: 8px; min-height: calc(28px * var(--den));
  padding: 0 calc(9px * var(--den)); font-size: var(--type-body-sm); cursor: default; }
.sa-orderitem[aria-selected="true"] { background: var(--secc); color: var(--onsecc); }
.sa-orderitem.is-warn { color: var(--err); font-weight: 600; font-family: var(--mono); font-size: var(--type-label-sm); }
.sa-orderitem.is-below { opacity: .72; }
.sa-orderitem.is-gap { text-decoration: line-through; }
.sa-orderbtns { display: flex; flex-direction: column; gap: 6px; flex: 0 0 auto; justify-content: flex-start; }
.sa-hit { padding: calc(8px * var(--den)); border-radius: var(--shape-sm);
  background: var(--c); font-size: var(--type-label-sm); line-height: 1.5; }
.sa-hit button { color: var(--p); font-weight: 600; text-decoration: underline; }

/* ---- generate URL / import ---- */
.gu-tabs, .sd-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--outline-var); flex-wrap: wrap; }
.gu-tab { min-height: calc(36px * var(--den)); padding: 0 calc(14px * var(--den));
  border-radius: var(--shape-sm) var(--shape-sm) 0 0; color: var(--onsv);
  font-size: var(--type-label-lg); font-weight: 600; border-bottom: 2px solid transparent; }
.gu-tab[aria-selected="true"] { color: var(--p); border-bottom-color: var(--p); background: color-mix(in srgb, var(--p) 8%, transparent); }
.gu-result { font-family: var(--mono); font-size: var(--type-label-md); line-height: 1.5;
  white-space: pre; overflow: auto; min-height: calc(150px * var(--uiscale));
  max-height: calc(320px * var(--uiscale)); padding: calc(10px * var(--den));
  border: 1px solid var(--outline-var); border-radius: var(--shape-sm);
  background: var(--c-lowest); color: var(--onsfc); width: 100%; }
.gu-opts { display: grid; grid-template-columns: repeat(auto-fit, minmax(20ch, 1fr)); gap: 2px calc(12px * var(--den)); }

.im-list { min-height: calc(200px * var(--uiscale)); max-height: calc(320px * var(--uiscale));
  overflow: auto; border: 1px solid var(--outline-var); border-radius: var(--shape-sm);
  background: var(--c-lowest); }
.im-item { display: flex; align-items: center; gap: calc(9px * var(--den));
  min-height: calc(34px * var(--den)); padding: 0 calc(10px * var(--den)); cursor: pointer; }
.im-item:hover { background: color-mix(in srgb, var(--onsfc) 7%, transparent); }
.im-item + .im-item { border-top: 1px solid var(--outline-var); }
.im-item-main { flex: 1 1 auto; min-width: 0; }
.im-item-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--type-body-sm); }
.im-item-sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: var(--type-label-sm); color: var(--onsv); }

/* ---- login ---- */
.lg-form { display: flex; flex-direction: column; gap: calc(10px * var(--den));
  min-width: 0; flex: 1 1 auto; min-height: 0; overflow-y: auto; padding-right: 4px; }
.lg-buttons { flex: 0 0 auto; padding-top: calc(4px * var(--den));
  border-top: 1px solid var(--outline-var); }
.lg-colorswatch { width: calc(26px * var(--den)); height: calc(26px * var(--den));
  border-radius: var(--shape-full); border: 1px solid var(--outline); flex: 0 0 auto; }
.lg-secret { display: flex; align-items: center; gap: 4px; min-width: 0; }
.lg-secret .sd-input { flex: 1 1 auto; }
`);
}

/* ================================================================== */
/* the tree widget                                                     */
/* ================================================================== */

const KIND_ICON = { newSite: 'add', folder: 'folder', site: 'dns', workspace: 'group_work' };

/**
 * createSiteTree(opts) -> handle
 *
 * opts:
 *   onSelect(node)         selection changed
 *   onActivate(node)       double click / Enter — the Login dialog logs in
 *   onChanged()            the underlying sites changed and were re-read
 *   contextItems(node)     extra context-menu entries from the host dialog
 *   searchMode             'nameStartOnly' | 'name' | 'all'
 *
 * handle: element, refresh(), select(id), selected, nodes, data,
 *         incrementalSearch(char), resetIncrementalSearch(), setSearchMode(m),
 *         setFilter(text), destroy()
 */
export function createSiteTree(opts = {}) {
  installSessionDialogStyles();

  const state = {
    sites: [],
    folders: [],
    workspaces: [],
    expanded: new Set(),
    nodes: [],
    selectedId: 'new-site',
    searchMode: opts.searchMode || DEFAULT_SITE_SEARCH_MODE,
    incremental: '',
    incrementalFailed: false,
    filter: '',
    renamingId: null,
  };

  const listEl = h('div', {
    class: 'st', role: 'tree', tabindex: '0',
    'aria-label': t('sites'),
  });
  const incrementalEl = h('div', { class: 'st-inc', hidden: true, role: 'status' });
  const root = h('div', { class: 'st-wrap' }, listEl, incrementalEl);
  appearanceTarget(listEl, 'site-tree', 'Site tree');

  /* ---------------- data ---------------- */

  async function refresh({ silent = false } = {}) {
    try {
      const doc = await siteStore.load();
      state.sites = doc.sites || [];
      state.folders = folderPathsOf(state.sites, doc.folders || []);
      state.workspaces = doc.workspaces || [];
    } catch (err) {
      // Reading the site list is informational, never a decision: a toast, not
      // a modal, and the tree keeps whatever it already had.
      notify.error('Sites could not be read', err.message || String(err));
    }
    rebuild();
    if (!silent) opts.onChanged?.(state);
  }

  function rebuild() {
    state.nodes = buildSiteTree({
      sites: state.sites,
      folders: state.folders,
      workspaces: state.workspaces,
      expanded: state.expanded,
    });
    render();
  }

  function allNodes() { return flattenTree(state.nodes); }
  function nodeById(id) { return allNodes().find((n) => n.id === id) || null; }

  /** Nodes actually drawn: a collapsed folder hides its subtree. */
  function visibleNodes() {
    const out = [];
    const walk = (list) => {
      for (const node of list) {
        out.push(node);
        if (node.kind === 'folder' && node.expanded) walk(node.children);
      }
    };
    walk(state.nodes);
    if (!state.filter) return out;
    const matched = new Set(filterSiteNodes(state.nodes, state.filter, state.searchMode).map((n) => n.id));
    // A matching descendant keeps its ancestors on screen; otherwise a hit
    // inside a folder would be invisible and the filter would look broken.
    const keep = new Set();
    for (const node of allNodes()) {
      if (!matched.has(node.id)) continue;
      keep.add(node.id);
      let p = node.parent;
      while (p) { keep.add(p.id); p = p.parent; }
    }
    const expandForFilter = (list) => {
      for (const node of list) {
        if (node.kind === 'folder' && keep.has(node.id)) node.expanded = true;
        expandForFilter(node.children);
      }
    };
    expandForFilter(state.nodes);
    const withFilter = [];
    const walk2 = (list) => {
      for (const node of list) {
        if (!keep.has(node.id)) continue;
        withFilter.push(node);
        if (node.kind === 'folder' && node.expanded) walk2(node.children);
      }
    };
    walk2(state.nodes);
    return withFilter;
  }

  /* ---------------- rendering ---------------- */

  let rowsById = new Map();

  function render() {
    const visible = visibleNodes();
    clear(listEl);
    rowsById = new Map();

    if (!visible.length) {
      listEl.appendChild(h('p', { class: 'st-empty prose' },
        state.filter ? `Nothing in the site list matches "${state.filter}".` : t('emptySites')));
      paintIncremental();
      return;
    }

    for (const node of visible) listEl.appendChild(buildRow(node));
    syncSelection();
    paintIncremental();
  }

  function buildRow(node) {
    const selected = node.id === state.selectedId;
    const row = h('div', {
      class: `st-row${selected ? ' is-selected' : ''}`,
      role: 'treeitem',
      tabindex: selected ? '0' : '-1',
      'aria-level': String(node.level + 1),
      'aria-selected': String(selected),
      'data-node-id': node.id,
      style: { paddingLeft: `calc(${6 + node.level * 14}px * var(--den))` },
      draggable: node.kind === 'site' || node.kind === 'folder',
    });

    if (node.kind === 'folder') {
      row.setAttribute('aria-expanded', String(!!node.expanded));
      const twisty = h('button', {
        type: 'button', class: 'st-twisty', tabindex: '-1',
        'aria-label': node.expanded ? `Collapse ${node.label}` : `Expand ${node.label}`,
        onclick: (e) => { e.stopPropagation(); toggleFolder(node); },
      }, icon(node.expanded ? 'expand_more' : 'chevron_right', 16));
      row.appendChild(twisty);
    } else {
      row.appendChild(h('span', { class: 'st-twisty is-blank' }));
    }

    row.appendChild(h('span', { class: 'st-icon' },
      icon(node.kind === 'folder' && node.expanded ? 'folder_open' : KIND_ICON[node.kind] || 'dns', 17)));

    if (state.renamingId === node.id) {
      row.appendChild(buildRenameField(node));
      return row;
    }

    const text = h('div', { class: 'st-text' },
      h('span', { class: 'st-name', title: node.label }, node.label));
    if (node.kind === 'site') {
      const summary = siteSummary(node.site);
      text.appendChild(h('span', { class: 'st-sub', title: summary }, summary));
    } else if (node.kind === 'workspace') {
      const count = Array.isArray(node.workspace?.sessions) ? node.workspace.sessions.length : 0;
      text.appendChild(h('span', { class: 'st-sub' }, `${t('workspaces')} · ${count}`));
    } else if (node.kind === 'folder') {
      const n = node.children.filter((c) => c.kind === 'site').length;
      text.appendChild(h('span', { class: 'st-sub' }, `${n} ${n === 1 ? 'site' : 'sites'}`));
    }
    row.appendChild(text);

    if (node.kind === 'site' && node.site?.color) {
      row.appendChild(h('span', {
        class: 'st-dot', style: { background: node.site.color },
        title: `${t('siteColor')}: ${node.site.color}`,
      }));
    }

    row.addEventListener('click', () => select(node.id));
    row.addEventListener('dblclick', () => {
      if (node.kind === 'folder') toggleFolder(node);
      else opts.onActivate?.(node);
    });

    installDrag(row, node);
    rowsById.set(node.id, row);
    // A durable key: the site id or the folder path, never the row index, so
    // an appearance override survives adding a site above it.
    appearanceTarget(row, `site-tree-row-${node.kind}`, `Site tree ${node.kind} row`);
    return row;
  }

  function buildRenameField(node) {
    const input = h('input', {
      type: 'text', class: 'st-rename', value: node.label,
      'aria-label': `${t('rename')}: ${node.label}`,
      onkeydown: (e) => {
        if (e.key === 'Enter') { e.preventDefault(); commitRename(node, input.value); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); state.renamingId = null; render(); }
      },
      onblur: () => { if (state.renamingId === node.id) commitRename(node, input.value); },
    });
    requestAnimationFrame(() => { input.focus(); input.select(); });
    return input;
  }

  async function commitRename(node, value) {
    const name = String(value || '').trim();
    state.renamingId = null;
    if (!name || name === node.label) { render(); return; }
    try {
      if (node.kind === 'site') await siteStore.updateSite(node.site.id, { name });
      else if (node.kind === 'folder') {
        const parent = node.path.split('/').slice(0, -1).join('/');
        await siteStore.renameFolder(node.path, parent ? `${parent}/${name}` : name);
      } else if (node.kind === 'workspace') {
        await siteStore.saveWorkspace(name, node.workspace.sessions);
        await siteStore.removeWorkspace(node.workspace.name);
      }
      notify.success(t('rename'), `Renamed to "${name}".`);
      await refresh();
    } catch (err) {
      notify.error(t('rename'), err.message || String(err));
      render();
    }
  }

  function syncSelection() {
    for (const [id, row] of rowsById) {
      const on = id === state.selectedId;
      row.classList.toggle('is-selected', on);
      row.setAttribute('aria-selected', String(on));
      row.tabIndex = on ? 0 : -1;
    }
  }

  function paintIncremental() {
    const searching = !!state.incremental;
    incrementalEl.hidden = !searching;
    if (!searching) return;
    clear(incrementalEl);
    incrementalEl.classList.toggle('is-nomatch', state.incrementalFailed);
    incrementalEl.appendChild(icon(state.incrementalFailed ? 'error' : 'search', 14));
    const modeLabel = SITE_SEARCH_MODES.find((m) => m.id === state.searchMode)?.label || state.searchMode;
    incrementalEl.appendChild(h('span', { class: 'ellipsis', title: `${modeLabel}: ${state.incremental}` },
      state.incrementalFailed
        ? `No match for "${state.incremental}" — ${modeLabel.toLowerCase()}`
        : `${state.incremental} — ${modeLabel.toLowerCase()}`));
  }

  /* ---------------- selection & navigation ---------------- */

  function select(id, { notifyHost = true } = {}) {
    if (!nodeById(id)) return;
    state.selectedId = id;
    syncSelection();
    if (notifyHost) opts.onSelect?.(nodeById(id));
  }

  function focusRow(id) {
    const row = rowsById.get(id);
    if (row) { row.focus(); row.scrollIntoView({ block: 'nearest' }); }
  }

  function toggleFolder(node, force) {
    const next = force === undefined ? !node.expanded : force;
    if (next) state.expanded.add(node.path); else state.expanded.delete(node.path);
    node.expanded = next;
    render();
    focusRow(state.selectedId);
    announce(`${node.label} ${next ? 'expanded' : 'collapsed'}`);
  }

  listEl.addEventListener('keydown', (e) => {
    if (state.renamingId) return;
    const visible = visibleNodes();
    const index = visible.findIndex((n) => n.id === state.selectedId);
    const node = visible[index];

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = visible[Math.min(visible.length - 1, index + 1)];
      if (next) { select(next.id); focusRow(next.id); }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = visible[Math.max(0, index - 1)];
      if (prev) { select(prev.id); focusRow(prev.id); }
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      if (node?.kind === 'folder' && !node.expanded) toggleFolder(node, true);
      else if (node?.kind === 'folder' && node.children.length) {
        select(node.children[0].id); focusRow(node.children[0].id);
      }
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (node?.kind === 'folder' && node.expanded) toggleFolder(node, false);
      else if (node?.parent) { select(node.parent.id); focusRow(node.parent.id); }
    } else if (e.key === 'Home') {
      e.preventDefault();
      if (visible[0]) { select(visible[0].id); focusRow(visible[0].id); }
    } else if (e.key === 'End') {
      e.preventDefault();
      const last = visible[visible.length - 1];
      if (last) { select(last.id); focusRow(last.id); }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (node) opts.onActivate?.(node);
    } else if (e.key === 'F2') {
      e.preventDefault();
      if (node && node.kind !== 'newSite') beginRename(node.id);
    } else if (e.key === 'Escape' && state.incremental) {
      e.preventDefault();
      e.stopPropagation();
      resetIncrementalSearch();
    } else if (e.key === 'Backspace' && state.incremental) {
      e.preventDefault();
      incrementalSearch(null, { backspace: true });
    } else if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      // Type-to-find, exactly as the original: the first keystroke starts a
      // search, each further one narrows it, and F3 repeats it.
      e.preventDefault();
      incrementalSearch(e.key);
    } else if (e.key === 'F3') {
      e.preventDefault();
      incrementalSearch(null, { repeat: true, reverse: e.shiftKey });
    }
  });

  /* ---------------- incremental search ---------------- */

  function incrementalSearch(char, { repeat = false, backspace = false, reverse = false } = {}) {
    if (backspace) state.incremental = state.incremental.slice(0, -1);
    else if (char !== null && char !== undefined) state.incremental += char;
    if (!state.incremental) { resetIncrementalSearch(); return; }

    const found = searchSiteNodes(state.nodes, state.incremental, state.searchMode, {
      fromId: state.selectedId,
      skipCurrent: repeat,
      reverse,
      allowExpanding: true,
    });
    state.incrementalFailed = !found;
    if (found) {
      // Reveal a hit inside a collapsed folder without destroying the user's
      // other collapsed folders.
      let p = found.parent;
      while (p) { state.expanded.add(p.path); p = p.parent; }
      rebuild();
      select(found.id);
      focusRow(found.id);
      announce(`${found.label}`);
    } else {
      paintIncremental();
      announce(`No site matches ${state.incremental}`, true);
    }
    paintIncremental();
  }

  function resetIncrementalSearch() {
    state.incremental = '';
    state.incrementalFailed = false;
    paintIncremental();
  }

  listEl.addEventListener('blur', resetIncrementalSearch);

  /* ---------------- drag and drop ---------------- */

  let dragNode = null;

  function installDrag(row, node) {
    if (node.kind === 'newSite' || node.kind === 'workspace') return;

    row.addEventListener('dragstart', (e) => {
      dragNode = node;
      e.dataTransfer.effectAllowed = 'move';
      // A plain-text payload so a drop outside the tree is inert rather than
      // pasting an internal identifier somewhere unexpected.
      e.dataTransfer.setData('text/plain', node.label);
    });
    row.addEventListener('dragend', () => {
      dragNode = null;
      for (const r of rowsById.values()) clearDropClasses(r);
    });
    row.addEventListener('dragover', (e) => {
      if (!dragNode || dragNode === node) return;
      if (isAncestorOf(dragNode, node)) return;      // never drop a folder into itself
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      clearDropClasses(row);
      row.classList.add(dropZone(e, row, node));
    });
    row.addEventListener('dragleave', () => clearDropClasses(row));
    row.addEventListener('drop', async (e) => {
      if (!dragNode || dragNode === node) return;
      e.preventDefault();
      const zone = dropZone(e, row, node);
      clearDropClasses(row);
      const moving = dragNode;
      dragNode = null;
      await performDrop(moving, node, zone);
    });
  }

  function dropZone(e, row, node) {
    const r = row.getBoundingClientRect();
    const y = e.clientY - r.top;
    if (node.kind === 'folder' && y > r.height * 0.25 && y < r.height * 0.75) return 'is-dragover-into';
    return y < r.height / 2 ? 'is-dragover-before' : 'is-dragover-after';
  }

  function clearDropClasses(row) {
    row.classList.remove('is-dragover-into', 'is-dragover-before', 'is-dragover-after');
  }

  function isAncestorOf(maybeAncestor, node) {
    let p = node;
    while (p) { if (p === maybeAncestor) return true; p = p.parent; }
    return false;
  }

  async function performDrop(moving, target, zone) {
    const targetFolder = zone === 'is-dragover-into'
      ? target.path
      : (target.parent ? target.parent.path : '');
    try {
      if (moving.kind === 'site') {
        if (String(moving.site.folder || '') === String(targetFolder || '')) {
          // Same folder: this is a reorder. The tree sorts by name, so the
          // honest thing is to say so rather than silently doing nothing.
          notify.info(t('sites'), 'Sites inside a folder are listed by name, so this drop changed nothing. Rename a site to change its position, or drop it on a folder to move it.');
          return;
        }
        await siteStore.moveSite(moving.site.id, targetFolder);
        notify.success(t('sites'), `Moved "${moving.label}" to ${targetFolder || 'the top level'}.`);
      } else if (moving.kind === 'folder') {
        const name = moving.path.split('/').pop();
        const to = targetFolder ? `${targetFolder}/${name}` : name;
        if (to === moving.path) return;
        await siteStore.renameFolder(moving.path, to);
        notify.success(t('siteFolder'), `Moved "${name}" to ${targetFolder || 'the top level'}.`);
      }
      await refresh();
    } catch (err) {
      notify.error('Move failed', err.message || String(err));
    }
  }

  /* ---------------- context menu ---------------- */

  registerContextMenu(listEl, (ctx) => {
    const row = ctx.target?.closest?.('.st-row');
    const node = row ? nodeById(row.dataset.nodeId) : null;
    if (node) select(node.id);
    const extra = opts.contextItems ? opts.contextItems(node) : [];
    return [...baseContextItems(node), ...(extra.length ? [SEPARATOR, ...extra] : [])];
  });

  function baseContextItems(node) {
    const searchSub = {
      label: t('searchSites'), icon: 'search',
      submenu: SITE_SEARCH_MODES.map((m) => ({
        label: m.label, checked: state.searchMode === m.id, radio: true,
        onSelect: () => setSearchMode(m.id),
      })),
    };
    if (!node) {
      return [
        { label: t('newFolder'), icon: 'folder', onSelect: () => promptNewFolder('') },
        SEPARATOR, searchSub,
      ];
    }
    if (node.kind === 'newSite') {
      return [
        { label: t('loginBtn'), icon: 'shield_lock', onSelect: () => opts.onActivate?.(node) },
        SEPARATOR,
        { label: t('newFolder'), icon: 'folder', onSelect: () => promptNewFolder('') },
        SEPARATOR, searchSub,
      ];
    }
    if (node.kind === 'folder') {
      return [
        { label: t('loginBtn'), icon: 'shield_lock', disabled: !node.children.some((c) => c.kind === 'site'), onSelect: () => opts.onActivate?.(node) },
        SEPARATOR,
        { label: t('rename'), icon: 'edit', shortcut: 'F2', onSelect: () => beginRename(node.id) },
        { label: t('delete_'), icon: 'delete', danger: true, onSelect: () => confirmDeleteFolder(node) },
        SEPARATOR,
        { label: t('newFolder'), icon: 'folder', onSelect: () => promptNewFolder(node.path) },
        SEPARATOR, searchSub,
      ];
    }
    if (node.kind === 'workspace') {
      return [
        { label: t('loginBtn'), icon: 'shield_lock', onSelect: () => opts.onActivate?.(node) },
        SEPARATOR,
        { label: t('rename'), icon: 'edit', shortcut: 'F2', onSelect: () => beginRename(node.id) },
        { label: t('delete_'), icon: 'delete', danger: true, onSelect: () => removeWorkspace(node) },
        SEPARATOR, searchSub,
      ];
    }
    return [
      { label: t('loginBtn'), icon: 'shield_lock', onSelect: () => opts.onActivate?.(node) },
      SEPARATOR,
      { label: t('rename'), icon: 'edit', shortcut: 'F2', onSelect: () => beginRename(node.id) },
      { label: t('duplicate'), icon: 'content_copy', onSelect: () => duplicateSite(node) },
      { label: t('delete_'), icon: 'delete', danger: true, onSelect: () => confirmDeleteSite(node) },
      SEPARATOR,
      { label: t('newFolder'), icon: 'folder', onSelect: () => promptNewFolder(node.path) },
      SEPARATOR, searchSub,
    ];
  }

  function beginRename(id) {
    state.renamingId = id;
    render();
  }

  async function duplicateSite(node) {
    try {
      const copy = await siteStore.duplicateSite(node.site.id, `${node.label} (copy)`);
      await refresh();
      if (copy?.id) select(`site:${copy.id}`);
      notify.success(t('duplicate'), `Created "${copy?.name || node.label}".`);
    } catch (err) {
      notify.error(t('duplicate'), err.message || String(err));
    }
  }

  /* These three are genuine decisions with an irreversible outcome, so they
     are the one place in this module that opens a modal. */
  function confirmDeleteSite(node) {
    opts.confirm?.({
      title: t('deleteTitle'),
      body: `Delete the site "${node.label}"? Its stored password is deleted with it. This cannot be undone from here, but the version history keeps a snapshot you can restore.`,
      danger: true,
      confirmLabel: t('delete_'),
      onConfirm: async () => {
        try {
          await siteStore.removeSite(node.site.id);
          notify.success(t('siteDeleted'), node.label);
          state.selectedId = 'new-site';
          await refresh();
        } catch (err) { notify.error(t('delete_'), err.message || String(err)); }
      },
    });
  }

  function confirmDeleteFolder(node) {
    const count = flattenTree([node]).filter((n) => n.kind === 'site').length;
    opts.confirm?.({
      title: t('deleteTitle'),
      body: count
        ? `Delete the folder "${node.label}" and the ${count} ${count === 1 ? 'site' : 'sites'} inside it? Choosing Move out keeps the sites and removes only the folder.`
        : `Delete the empty folder "${node.label}"?`,
      danger: true,
      confirmLabel: count ? 'Delete folder and sites' : t('delete_'),
      extraLabel: count ? 'Move out, delete folder' : null,
      onExtra: async () => {
        try {
          await siteStore.removeFolder(node.path, false);
          notify.success(t('siteFolder'), `Removed "${node.label}"; its sites moved to the top level.`);
          await refresh();
        } catch (err) { notify.error(t('delete_'), err.message || String(err)); }
      },
      onConfirm: async () => {
        try {
          await siteStore.removeFolder(node.path, true);
          notify.success(t('siteFolder'), `Deleted "${node.label}" and ${count} ${count === 1 ? 'site' : 'sites'}.`);
          await refresh();
        } catch (err) { notify.error(t('delete_'), err.message || String(err)); }
      },
    });
  }

  function removeWorkspace(node) {
    opts.confirm?.({
      title: t('deleteTitle'),
      body: `Delete the workspace "${node.label}"? The sites it references are not deleted.`,
      danger: true,
      confirmLabel: t('delete_'),
      onConfirm: async () => {
        try {
          await siteStore.removeWorkspace(node.workspace.name || node.label);
          notify.success(t('workspaces'), `Deleted "${node.label}".`);
          await refresh();
        } catch (err) { notify.error(t('delete_'), err.message || String(err)); }
      },
    });
  }

  function promptNewFolder(parentPath) {
    opts.prompt?.({
      title: t('newFolder'),
      label: t('name'),
      value: '',
      onSubmit: async (name) => {
        const clean = String(name || '').trim().replace(/\//g, '-');
        if (!clean) return;
        const path = parentPath ? `${parentPath}/${clean}` : clean;
        try {
          await siteStore.addFolder(path);
          state.expanded.add(path);
          notify.success(t('newFolder'), path);
          await refresh();
          select(`folder:${path}`);
        } catch (err) { notify.error(t('newFolder'), err.message || String(err)); }
      },
    });
  }

  /* ---------------- public surface ---------------- */

  function setSearchMode(mode) {
    if (!SITE_SEARCH_MODES.some((m) => m.id === mode)) return;
    state.searchMode = mode;
    opts.onSearchModeChanged?.(mode);
    if (state.filter) render();
    paintIncremental();
  }

  function setFilter(text) {
    state.filter = String(text || '');
    render();
  }

  const offSites = bus.on('sites:changed', () => { refresh({ silent: true }); });

  refresh({ silent: true });

  return {
    element: root,
    listElement: listEl,
    get nodes() { return state.nodes; },
    get data() { return { sites: state.sites, folders: state.folders, workspaces: state.workspaces }; },
    get selected() { return nodeById(state.selectedId); },
    get searchMode() { return state.searchMode; },
    refresh,
    select,
    focusSelected: () => focusRow(state.selectedId),
    beginRename,
    promptNewFolder,
    setSearchMode,
    setFilter,
    incrementalSearch,
    resetIncrementalSearch,
    destroy() {
      offSites();
      root.remove();
    },
  };
}

/** Sites/folders changed somewhere else in the app; every tree re-reads. */
export function notifySitesChanged() { bus.emit('sites:changed', null); }

export { oneLine, bindText };
