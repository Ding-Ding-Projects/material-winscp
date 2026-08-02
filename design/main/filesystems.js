// filesystems.js — WinSCP's file-system capability model (core/FileSystems.cpp,
// core/SessionInfo.h's TFSCapability, and each TCustomFileSystem::IsCapable).
//
// WHY THIS FILE EXISTS AT ALL
// ---------------------------
// WinSCP asks one question of every backend — `IsCapable(fcSomething)` — and the
// whole UI hangs off the answer: menu items grey out, the queue refuses to
// parallelise, the synchronizer skips a criterion. This port answers the same
// questions, but it must answer them from the SAME facts the adapters already
// publish in `caps`, otherwise the two drift and the UI starts offering
// commands the adapter cannot perform.
//
// So this module holds NO second opinion about what a protocol can do. Every
// capability is DERIVED from the adapter handed in: its `caps` matrix, its
// methods, and (for the handful of facts that are properties of the wire
// protocol rather than of a capability flag) a small trait table that can only
// ever *qualify* a cap, never grant one. Flip a cap on an adapter and the
// derived matrix follows; there is no list here to forget to update.
//
// WINSCP_REFERENCE is the exception, and it is deliberately not our opinion: it
// records what the ORIGINAL answers, so `divergence()` can report where this
// port is behind (a gap for docs/protocol-gaps.md) or ahead of it.
'use strict';

// ---------------------------------------------------------------------------
// The capability enum, in TFSCapability declaration order.
// ---------------------------------------------------------------------------

/**
 * Each entry: the name WinSCP uses, what it gates in the UI, and how this port
 * derives it. `derive` receives (caps, adapter, traits) and returns a boolean.
 * `reads` names the caps keys the derivation consults — the test suite uses it
 * to prove the derivation really is a function of `caps` and not a constant.
 */
const CAPABILITY_LIST = [
  {
    name: 'fcUserGroupListing',
    doc: 'The server can enumerate users and groups, so owner/group can be picked from a list.',
    reads: ['owner'],
    derive: (caps) => !!caps.owner,
  },
  {
    name: 'fcModeChanging',
    doc: 'Permissions of an existing file can be changed (chmod).',
    reads: ['rights'],
    derive: (caps) => !!caps.rights,
  },
  {
    name: 'fcAclChangingFiles',
    doc: 'Access control lists (not unix mode bits) can be edited per file.',
    reads: ['acl'],
    derive: (caps) => caps.acl === true,
  },
  {
    name: 'fcGroupChanging',
    doc: 'The owning group of an existing file can be changed.',
    reads: ['owner'],
    derive: (caps) => !!caps.owner,
  },
  {
    name: 'fcOwnerChanging',
    doc: 'The owner of an existing file can be changed.',
    reads: ['owner'],
    derive: (caps) => !!caps.owner,
  },
  {
    name: 'fcGroupOwnerChangingByID',
    doc: 'Owner/group are addressed by numeric id rather than by name, so the '
      + 'properties dialog must offer ids.',
    reads: ['owner'],
    derive: (caps, adapter, traits) => !!caps.owner && traits.ownerIdentifier === 'numeric',
  },
  {
    name: 'fcAnyCommand',
    doc: 'An arbitrary command can be sent over the session itself.',
    reads: ['exec'],
    derive: (caps, adapter, traits) => !!caps.exec && traits.execShell !== 'secondary',
  },
  {
    name: 'fcHardLink',
    doc: 'Hard links can be created.',
    reads: ['hardlink'],
    derive: (caps) => !!caps.hardlink,
  },
  {
    name: 'fcSymbolicLink',
    doc: 'Symbolic links can be created.',
    reads: ['symlink'],
    derive: (caps) => !!caps.symlink,
  },
  {
    name: 'fcResolveSymlink',
    doc: 'A double-click on a file opens it rather than trying to enter it as a '
      + 'directory. Every WinSCP backend answers true — WebDAV and S3 answer '
      + 'true precisely because they never report a symlink, and answering '
      + 'false there would break double-click. There is nothing to derive.',
    reads: [],
    derive: () => true,
  },
  {
    name: 'fcTextMode',
    doc: 'Transfers can convert line endings client-side.',
    reads: [],
    derive: (caps, adapter, traits) => traits.textMode !== 'none',
  },
  {
    name: 'fcNativeTextMode',
    doc: 'The protocol itself carries a text mode, so no client-side conversion '
      + 'is needed (SFTP 4+).',
    reads: [],
    derive: (caps, adapter, traits) => traits.textMode === 'native',
  },
  {
    name: 'fcRename',
    doc: 'A file can be renamed in place.',
    reads: ['rename'],
    derive: (caps) => !!caps.rename,
  },
  {
    name: 'fcNewerOnlyUpload',
    doc: 'Remote timestamps are trustworthy enough to upload only newer files.',
    reads: ['timestamp'],
    derive: (caps) => !!caps.timestamp,
  },
  {
    name: 'fcRemoteCopy',
    doc: 'The server can duplicate a file without a round trip.',
    reads: ['copyRemote'],
    derive: (caps) => !!caps.copyRemote,
  },
  {
    name: 'fcTimestampChanging',
    doc: 'The modification time of an existing file can be set.',
    reads: ['timestamp'],
    derive: (caps, adapter) => !!caps.timestamp && typeof adapter.setTimes === 'function',
  },
  {
    name: 'fcRemoteMove',
    doc: 'A file can be moved within the server without transferring it. A '
      + 'protocol with no rename verb still qualifies when it can copy '
      + 'server-side and delete — that is exactly how S3 moves an object, and '
      + 'the user experience is a move either way.',
    reads: ['move', 'nativeMove', 'copyRemote'],
    derive: (caps) => !!caps.move && (!!caps.nativeMove || !!caps.copyRemote),
  },
  {
    name: 'fcLoadingAdditionalProperties',
    doc: 'Properties beyond the listing (tags, ACLs, checksums) can be fetched '
      + 'for a selected file.',
    reads: ['extraProperties'],
    derive: (caps) => caps.extraProperties === true,
  },
  {
    name: 'fcCheckingSpaceAvailable',
    doc: 'Free space on the remote volume can be queried.',
    reads: ['spaceInfo'],
    derive: (caps) => !!caps.spaceInfo,
  },
  {
    name: 'fcIgnorePermErrors',
    doc: 'A failed permission change during a transfer can be ignored instead of '
      + 'failing the transfer — only meaningful where permissions exist and are '
      + 'set as a separate step after the data.',
    reads: ['rights'],
    derive: (caps, adapter, traits) => !!caps.rights && traits.permissionsAreASeparateStep === true,
  },
  {
    name: 'fcCalculatingChecksum',
    doc: 'The server can compute a checksum of a remote file.',
    reads: ['checksum'],
    derive: (caps) => !!caps.checksum,
  },
  {
    name: 'fcModeChangingUpload',
    doc: 'Permissions can be applied to a file as part of uploading it.',
    reads: ['rights'],
    derive: (caps, adapter, traits) => !!caps.rights && traits.permissionsOnUpload !== false,
  },
  {
    name: 'fcPreservingTimestampUpload',
    doc: 'The local modification time can be preserved on upload.',
    reads: ['timestamp'],
    derive: (caps) => !!caps.timestamp,
  },
  {
    name: 'fcShellAnyCommand',
    doc: 'Commands run in a real shell (so pipes and redirection work), not as '
      + 'bare protocol verbs.',
    reads: ['exec'],
    derive: (caps, adapter, traits) => !!caps.exec && traits.execShell === 'primary',
  },
  {
    name: 'fcSecondaryShell',
    doc: 'Commands run in a shell opened alongside the file-transfer channel, so '
      + '"Open Terminal" needs a second channel rather than the session itself.',
    reads: ['exec'],
    derive: (caps, adapter, traits) => !!caps.exec && traits.execShell === 'secondary',
  },
  {
    name: 'fcRemoveCtrlZUpload',
    doc: 'A trailing Ctrl+Z can be stripped while uploading in text mode.',
    reads: [],
    derive: (caps, adapter, traits) => traits.textMode === 'client'
      && traits.uploadFilters !== false
      && traits.stripsCtrlZOnUpload !== false,
  },
  {
    name: 'fcRemoveBOMUpload',
    doc: 'A byte order mark can be stripped while uploading in text mode.',
    reads: [],
    derive: (caps, adapter, traits) => traits.textMode !== 'none' && traits.uploadFilters !== false,
  },
  {
    name: 'fcMoveToQueue',
    doc: 'A transfer already running in the foreground can be handed to the '
      + 'queue. It needs a second connection for the same session, not a resume '
      + 'capability — WinSCP allows it for WebDAV, which cannot resume at all.',
    reads: [],
    derive: (caps, adapter, traits) => traits.restartableTransfers === true,
  },
  {
    name: 'fcLocking',
    doc: 'Files can be locked and unlocked on the server.',
    reads: ['locking'],
    derive: (caps) => caps.locking === true,
  },
  {
    name: 'fcPreservingTimestampDirs',
    doc: 'A directory\'s timestamp can be preserved, not just a file\'s.',
    reads: ['timestamp'],
    derive: (caps, adapter, traits) => !!caps.timestamp && traits.directoryTimestamps === true,
  },
  {
    name: 'fcResumeSupport',
    doc: 'An interrupted transfer can continue from the byte it stopped at.',
    reads: ['resume'],
    derive: (caps) => !!caps.resume,
  },
  {
    name: 'fcChangePassword',
    doc: 'The account password can be changed from inside the session.',
    reads: ['changePassword'],
    derive: (caps) => caps.changePassword === true,
  },
  {
    name: 'fcSkipTransfer',
    doc: 'One file can be skipped without aborting the whole operation.',
    reads: [],
    derive: (caps, adapter, traits) => traits.restartableTransfers === true,
  },
  {
    name: 'fcParallelTransfers',
    doc: 'Several files can be transferred at once on separate connections.',
    reads: [],
    derive: (caps, adapter, traits) => traits.restartableTransfers === true,
  },
  {
    name: 'fcParallelFileTransfers',
    doc: 'A single file can be split across several connections.',
    reads: ['resume'],
    derive: (caps, adapter, traits) => !!caps.resume && traits.rangedWrites === true,
  },
  {
    name: 'fcBackgroundTransfers',
    doc: 'Transfers can run in the background queue at all. WinSCP answers this '
      + 'one in TTerminal, not in the file system: it is false only while '
      + 'file encryption is on, because an encrypted transfer cannot be split '
      + 'across sessions.',
    reads: [],
    derive: (caps, adapter) => !adapter.encryptingFiles,
  },
  {
    name: 'fcTransferOut',
    doc: 'A download can be streamed to a caller-supplied sink instead of a file.',
    reads: [],
    derive: (caps, adapter) => typeof adapter.createReadStream === 'function'
      && adapter.createReadStream !== BASE_READ_STREAM,
  },
  {
    name: 'fcTransferIn',
    doc: 'An upload can be streamed from a caller-supplied source instead of a file.',
    reads: [],
    derive: (caps, adapter) => typeof adapter.createWriteStream === 'function'
      && adapter.createWriteStream !== BASE_WRITE_STREAM,
  },
  {
    name: 'fcMoveOverExistingFile',
    doc: 'A rename/move onto an existing name replaces it rather than failing.',
    reads: ['move', 'nativeMove'],
    derive: (caps, adapter, traits) => !!caps.move && traits.overwriteOnMove === true,
  },
  {
    name: 'fcTags',
    doc: 'Objects carry user-defined key/value tags.',
    reads: ['tags'],
    derive: (caps) => caps.tags === true,
  },
];

const CAPABILITIES = CAPABILITY_LIST.map((c) => c.name);
const CAPABILITY_BY_NAME = new Map(CAPABILITY_LIST.map((c) => [c.name, c]));

// The base-class stubs. An adapter that has not overridden them cannot stream,
// so fcTransferOut/fcTransferIn must answer false for it — comparing against
// the prototype method is how we tell "implemented" from "inherited throw".
let BASE_READ_STREAM = null;
let BASE_WRITE_STREAM = null;
try {
  // Loaded lazily and defensively: filesystems.js is also used by tools that do
  // not want the whole protocol tree pulled in.
  const base = require('./protocols/base');
  BASE_READ_STREAM = base.Adapter.prototype.createReadStream;
  BASE_WRITE_STREAM = base.Adapter.prototype.createWriteStream;
} catch {
  /* base.js unavailable — every adapter then counts as implementing streaming,
     which is the safe direction: we do not silently disable transfers. */
}

// ---------------------------------------------------------------------------
// Protocol traits
// ---------------------------------------------------------------------------

// Facts about a wire protocol that have no expression in `caps` because they
// are not switches a user or a server can turn on. They only ever QUALIFY a
// capability that a cap has already granted — read the derivations above and
// note that every trait sits behind a `caps.*` test wherever a cap exists for
// the thing. Nothing here can make a capability true that `caps` says is false.
const TRAIT_DEFAULTS = {
  // 'numeric' | 'name' | null — how the protocol names an owner/group.
  ownerIdentifier: null,
  // 'primary' (the session IS a shell) | 'secondary' (exec opens another
  // channel) | 'protocol' (verbs, not a shell) | null.
  execShell: null,
  // 'native' (the protocol has a text mode) | 'client' (we convert) | 'none'.
  textMode: 'none',
  // Uploads pass through a byte filter that can strip Ctrl+Z / BOM.
  uploadFilters: true,
  // The client sees the raw bytes on the way up and can drop a trailing DOS
  // end-of-file marker. False where the SERVER performs the text conversion, so
  // there is no client-side stream to filter.
  stripsCtrlZOnUpload: true,
  // Permissions are applied as a distinct request after the data, so a refusal
  // there can be tolerated separately from the transfer itself.
  permissionsAreASeparateStep: false,
  // Permissions can be carried by the upload itself.
  permissionsOnUpload: true,
  // Directory timestamps are settable, not just file timestamps.
  directoryTimestamps: false,
  // The protocol can restart/duplicate a transfer, which is what makes
  // queueing, skipping and running several transfers at once meaningful.
  restartableTransfers: false,
  // A write can target an arbitrary byte offset, so one file can be split
  // across connections.
  rangedWrites: false,
  // Rename/move over an existing name replaces rather than fails.
  overwriteOnMove: false,
};

const PROTOCOL_TRAITS = {
  sftp: {
    ownerIdentifier: 'numeric',       // SSH_FXP_ATTRS carries uid/gid as numbers
    execShell: 'secondary',           // "Open Terminal" opens a second channel
    textMode: 'client',
    permissionsAreASeparateStep: true,
    directoryTimestamps: true,
    restartableTransfers: true,
    rangedWrites: true,
    overwriteOnMove: false,           // SSH_FXP_RENAME fails on an existing name
  },
  scp: {
    ownerIdentifier: 'name',          // chown/chgrp take names
    execShell: 'primary',             // the session is a shell
    textMode: 'client',
    permissionsOnUpload: true,
    overwriteOnMove: true,            // `mv` replaces
  },
  ftp: {
    execShell: 'protocol',            // raw FTP verbs, not a shell
    textMode: 'client',
    stripsCtrlZOnUpload: false,       // TYPE A conversion happens on the server
    permissionsOnUpload: false,       // SITE CHMOD is a separate command only
    restartableTransfers: true,
    overwriteOnMove: true,
  },
  webdav: {
    textMode: 'none',
    restartableTransfers: true,
    overwriteOnMove: true,            // MOVE with Overwrite: T
  },
  s3: {
    textMode: 'none',
    restartableTransfers: true,
    overwriteOnMove: true,            // PUT replaces unconditionally
  },
  local: {
    ownerIdentifier: 'numeric',
    textMode: 'client',
    permissionsAreASeparateStep: true,
    directoryTimestamps: true,
    restartableTransfers: true,
    rangedWrites: true,
    overwriteOnMove: true,
  },
};

/** Map an adapter to its protocol id. Falls back to the adapter's own hint. */
function protocolIdOf(adapter) {
  if (!adapter) return '';
  if (adapter.protocolId) return String(adapter.protocolId);
  const name = String(adapter.protocolName || '').toLowerCase();
  if (name.startsWith('sftp')) return 'sftp';
  if (name.startsWith('scp')) return 'scp';
  if (name.startsWith('ftp')) return 'ftp';   // covers FTPS
  if (name.startsWith('webdav')) return 'webdav';
  if (name.includes('s3')) return 's3';
  if (name.startsWith('local')) return 'local';
  return name;
}

function traitsOf(adapter) {
  const id = protocolIdOf(adapter);
  // An adapter may override a trait itself; that is the only way to introduce a
  // new protocol without touching this file.
  return { ...TRAIT_DEFAULTS, ...(PROTOCOL_TRAITS[id] || {}), ...(adapter && adapter.traits) };
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

/** True if `adapter` supports the WinSCP capability `name`. */
function isCapable(adapter, name) {
  const entry = CAPABILITY_BY_NAME.get(name);
  if (!entry) throw new Error(`Unknown file-system capability: ${name}`);
  if (!adapter) return false;
  const caps = adapter.caps || {};
  return !!entry.derive(caps, adapter, traitsOf(adapter));
}

/** The whole matrix for one adapter, in TFSCapability order. */
function capabilities(adapter) {
  const out = {};
  const caps = (adapter && adapter.caps) || {};
  const traits = traitsOf(adapter);
  for (const entry of CAPABILITY_LIST) {
    out[entry.name] = adapter ? !!entry.derive(caps, adapter, traits) : false;
  }
  return out;
}

/**
 * The capability list WinSCP writes into its File System Information dialog:
 * one line per capability with a yes/no. Returned as data so the renderer can
 * localize the labels.
 */
function describe(adapter) {
  const matrix = capabilities(adapter);
  return CAPABILITY_LIST.map((c) => ({
    name: c.name,
    supported: matrix[c.name],
    doc: c.doc,
  }));
}

// ---------------------------------------------------------------------------
// What the original answers — for gap reporting only
// ---------------------------------------------------------------------------

// 'depends' means the C++ answer is conditional on the server, its version or a
// negotiated extension (e.g. SFTP fcRename is `FVersion >= 2`). A conditional
// entry can never be a divergence: either answer is one WinSCP itself gives.
const D = 'depends';

const WINSCP_REFERENCE = {
  // TSFTPFileSystem::IsCapable
  sftp: {
    fcUserGroupListing: D,            // SFTP_EXT_OWNER_GROUP
    fcModeChanging: true,
    fcAclChangingFiles: false,        // "pending implementation" in the original
    fcGroupChanging: true,
    fcOwnerChanging: true,
    fcGroupOwnerChangingByID: true,   // version <= 3
    fcAnyCommand: false,
    fcHardLink: D,                    // version >= 6 or hardlink@openssh.com
    fcSymbolicLink: true,
    fcResolveSymlink: true,
    fcTextMode: D,
    fcNativeTextMode: D,              // version >= 4
    fcRename: true,
    fcNewerOnlyUpload: true,
    fcRemoteCopy: D,                  // copy-file / copy-data extension
    fcTimestampChanging: true,
    fcRemoteMove: true,
    fcLoadingAdditionalProperties: D,
    fcCheckingSpaceAvailable: D,      // space-available / statvfs@openssh.com
    fcIgnorePermErrors: true,
    fcCalculatingChecksum: D,         // check-file extension
    fcModeChangingUpload: true,
    fcPreservingTimestampUpload: true,
    fcShellAnyCommand: false,
    fcSecondaryShell: true,
    fcRemoveCtrlZUpload: true,
    fcRemoveBOMUpload: true,
    fcMoveToQueue: true,
    fcLocking: false,
    fcPreservingTimestampDirs: true,
    fcResumeSupport: true,
    fcChangePassword: D,
    fcSkipTransfer: true,
    fcParallelTransfers: true,
    fcParallelFileTransfers: true,
    fcBackgroundTransfers: true,
    fcTransferOut: true,
    fcTransferIn: true,
    fcMoveOverExistingFile: false,
    fcTags: false,
  },
  // TSCPFileSystem::IsCapable
  scp: {
    fcUserGroupListing: true,
    fcModeChanging: true,
    fcAclChangingFiles: false,
    fcGroupChanging: true,
    fcOwnerChanging: true,
    fcGroupOwnerChangingByID: false,  // by name
    fcAnyCommand: true,
    fcHardLink: true,
    fcSymbolicLink: true,
    fcResolveSymlink: true,
    fcTextMode: D,                    // session EOL differs from local EOL
    fcNativeTextMode: false,
    fcRename: true,
    fcNewerOnlyUpload: false,
    fcRemoteCopy: true,
    fcTimestampChanging: false,
    fcRemoteMove: true,
    fcLoadingAdditionalProperties: false,
    fcCheckingSpaceAvailable: false,
    fcIgnorePermErrors: false,
    fcCalculatingChecksum: true,
    fcModeChangingUpload: true,
    fcPreservingTimestampUpload: true,
    fcShellAnyCommand: true,
    fcSecondaryShell: false,          // has fcShellAnyCommand
    fcRemoveCtrlZUpload: true,
    fcRemoveBOMUpload: true,
    fcMoveToQueue: false,
    fcLocking: false,
    fcPreservingTimestampDirs: false,
    fcResumeSupport: false,
    fcChangePassword: D,
    fcSkipTransfer: false,
    fcParallelTransfers: false,       // does not implement cpNoRecurse
    fcParallelFileTransfers: false,
    fcBackgroundTransfers: true,
    fcTransferOut: false,
    fcTransferIn: false,
    fcMoveOverExistingFile: true,
    fcTags: false,
  },
  // TFTPFileSystem::IsCapable
  ftp: {
    fcUserGroupListing: false,
    fcModeChanging: true,             // but not fcModeChangingUpload
    fcAclChangingFiles: false,
    fcGroupChanging: false,
    fcOwnerChanging: false,
    fcGroupOwnerChangingByID: false,
    fcAnyCommand: true,               // but not fcShellAnyCommand
    fcHardLink: false,
    fcSymbolicLink: D,                // SITE SYMLINK
    fcResolveSymlink: true,           // sic
    fcTextMode: true,
    fcNativeTextMode: false,
    fcRename: true,
    fcNewerOnlyUpload: true,
    fcRemoteCopy: D,                  // SITE COPY
    fcTimestampChanging: false,
    fcRemoteMove: true,
    fcLoadingAdditionalProperties: false,
    fcCheckingSpaceAvailable: D,      // AVBL / XQUOTA
    fcIgnorePermErrors: false,
    fcCalculatingChecksum: D,         // XCRC / XMD5 / XSHA / HASH
    fcModeChangingUpload: false,
    fcPreservingTimestampUpload: D,   // MFMT
    fcShellAnyCommand: false,
    fcSecondaryShell: false,
    fcRemoveCtrlZUpload: false,
    fcRemoveBOMUpload: true,
    fcMoveToQueue: true,
    fcLocking: false,
    fcPreservingTimestampDirs: false,
    fcResumeSupport: false,
    fcChangePassword: false,
    fcSkipTransfer: true,
    fcParallelTransfers: true,
    fcParallelFileTransfers: false,
    fcBackgroundTransfers: true,
    fcTransferOut: true,
    fcTransferIn: true,
    fcMoveOverExistingFile: D,        // false against IIS
    fcTags: false,
  },
  // TWebDAVFileSystem::IsCapable
  webdav: {
    fcUserGroupListing: false,
    fcModeChanging: false,
    fcAclChangingFiles: false,
    fcGroupChanging: false,
    fcOwnerChanging: false,
    fcGroupOwnerChangingByID: false,
    fcAnyCommand: false,
    fcHardLink: false,
    fcSymbolicLink: false,
    fcResolveSymlink: true,           // so double-click opens, never enters
    fcTextMode: false,
    fcNativeTextMode: false,
    fcRename: true,
    fcNewerOnlyUpload: false,
    fcRemoteCopy: true,
    fcTimestampChanging: false,
    fcRemoteMove: true,
    fcLoadingAdditionalProperties: false,
    fcCheckingSpaceAvailable: true,
    fcIgnorePermErrors: false,
    fcCalculatingChecksum: false,
    fcModeChangingUpload: false,
    fcPreservingTimestampUpload: true,
    fcShellAnyCommand: false,
    fcSecondaryShell: false,
    fcRemoveCtrlZUpload: false,
    fcRemoveBOMUpload: false,
    fcMoveToQueue: true,
    fcLocking: D,                     // DAV class 2
    fcPreservingTimestampDirs: false,
    fcResumeSupport: false,
    fcChangePassword: false,
    fcSkipTransfer: true,
    fcParallelTransfers: true,
    fcParallelFileTransfers: false,
    fcBackgroundTransfers: true,
    fcTransferOut: false,
    fcTransferIn: false,
    fcMoveOverExistingFile: true,
    fcTags: false,
  },
  // TS3FileSystem::IsCapable
  s3: {
    fcUserGroupListing: false,
    fcModeChanging: false,
    fcAclChangingFiles: true,
    fcGroupChanging: false,
    fcOwnerChanging: false,
    fcGroupOwnerChangingByID: false,
    fcAnyCommand: false,
    fcHardLink: false,
    fcSymbolicLink: false,
    fcResolveSymlink: true,
    fcTextMode: false,
    fcNativeTextMode: false,
    fcRename: true,
    fcNewerOnlyUpload: false,
    fcRemoteCopy: true,
    fcTimestampChanging: false,
    fcRemoteMove: true,
    fcLoadingAdditionalProperties: true,
    fcCheckingSpaceAvailable: false,
    fcIgnorePermErrors: false,
    fcCalculatingChecksum: false,
    fcModeChangingUpload: false,
    fcPreservingTimestampUpload: false,
    fcShellAnyCommand: false,
    fcSecondaryShell: false,
    fcRemoveCtrlZUpload: false,
    fcRemoveBOMUpload: false,
    fcMoveToQueue: true,
    fcLocking: false,
    fcPreservingTimestampDirs: false,
    fcResumeSupport: false,
    fcChangePassword: false,
    fcSkipTransfer: true,
    fcParallelTransfers: true,
    fcParallelFileTransfers: false,
    fcBackgroundTransfers: true,
    fcTransferOut: false,
    fcTransferIn: false,
    fcMoveOverExistingFile: true,
    fcTags: true,
  },
};

/**
 * Where this port's derived answer differs from the original's.
 *
 * kind: 'gap'   WinSCP can, we cannot — belongs in docs/protocol-gaps.md.
 *       'extra' we can, WinSCP cannot — usually a replacement engine doing more
 *               than the original (SCP `touch` for timestamps, say).
 *
 * A 'depends' reference entry never produces a row: both answers are answers
 * WinSCP itself gives depending on the server.
 */
function divergence(adapter) {
  const id = protocolIdOf(adapter);
  const reference = WINSCP_REFERENCE[id];
  if (!reference) return [];
  const mine = capabilities(adapter);
  const rows = [];
  for (const entry of CAPABILITY_LIST) {
    const theirs = reference[entry.name];
    if (theirs === D || theirs === undefined) continue;
    if (theirs === mine[entry.name]) continue;
    rows.push({
      protocol: id,
      capability: entry.name,
      winscp: theirs,
      ours: mine[entry.name],
      kind: theirs ? 'gap' : 'extra',
      doc: entry.doc,
    });
  }
  return rows;
}

/**
 * Self-check for the model itself, so a half-edited table fails a test rather
 * than silently greying a menu out. Throws with everything that is wrong.
 */
function assertModelComplete() {
  const problems = [];
  const seen = new Set();
  for (const entry of CAPABILITY_LIST) {
    if (seen.has(entry.name)) problems.push(`duplicate capability ${entry.name}`);
    seen.add(entry.name);
    if (typeof entry.derive !== 'function') problems.push(`${entry.name} has no derivation`);
    if (!entry.doc) problems.push(`${entry.name} has no documentation`);
    if (!Array.isArray(entry.reads)) problems.push(`${entry.name} does not declare what it reads`);
  }
  for (const [protocol, table] of Object.entries(WINSCP_REFERENCE)) {
    for (const name of CAPABILITIES) {
      if (!(name in table)) problems.push(`${protocol} reference is missing ${name}`);
    }
    for (const name of Object.keys(table)) {
      if (!seen.has(name)) problems.push(`${protocol} reference names unknown ${name}`);
    }
  }
  // A trait must never share a name with a cap: that is exactly how the two
  // lists would start to disagree.
  for (const trait of Object.keys(TRAIT_DEFAULTS)) {
    for (const entry of CAPABILITY_LIST) {
      if (entry.reads.includes(trait)) {
        problems.push(`trait ${trait} shadows a caps key read by ${entry.name}`);
      }
    }
  }
  if (problems.length) throw new Error(`Capability model is inconsistent:\n  ${problems.join('\n  ')}`);
  return true;
}

module.exports = {
  CAPABILITIES,
  CAPABILITY_LIST,
  PROTOCOL_TRAITS,
  TRAIT_DEFAULTS,
  WINSCP_REFERENCE,
  DEPENDS: D,
  isCapable,
  capabilities,
  describe,
  divergence,
  protocolIdOf,
  traitsOf,
  assertModelComplete,
};
