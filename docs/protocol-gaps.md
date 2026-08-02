# Known protocol gaps

WinSCP vendors PuTTY (82,710 lines) and FileZilla (19,447 lines) rather than
authoring them, so this port supplies that layer with `ssh2` and `basic-ftp`.
[`docs/porting-mandate.md`](porting-mandate.md) is explicit that this is a port
of that layer, **not** a licence to skip it: any capability the original engine
exposes that the replacement does not is a **real gap** and belongs here.

This page exists so those gaps are counted rather than quietly absorbed. Nothing
on it is "won't fix" — each entry is either work to do or a decision to justify.

Last reviewed against `ssh2` 1.17.0 and `basic-ftp` 5.3.1.

## SSH / SFTP (`ssh2` vs PuTTY)

| Gap | WinSCP option affected | Status | Consequence today |
|---|---|---|---|
| **GSSAPI / Kerberos** authentication and key exchange | `authGSSAPI`, `authGSSAPIKEX`, `gssapiFwdTGT`, `gssLibList` | ⬜ Not available | `ssh2` implements no GSSAPI mechanism. The flags are accepted, a warning is logged, and the remaining authentication methods are tried. Single-sign-on against a Kerberos realm does not work. |
| **SFTP protocol versions 4–6** | `sftpMaxVersion` | ⬜ Not available | `ssh2`'s client hard-codes `SSH_FXP_INIT` at version 3 and parses only the version 3 attribute block, so raising the number would make it misread every reply. `sftpMaxVersion` therefore selects nothing. What *is* ported (`design/main/protocols/sftp-extensions.js`) is everything that decision feeds: the version ceiling WinSCP would ask for per server, the `supported`/`supported2` capability structures, the version-dependent capability answers, and the version-dependent workarounds. They are exercised by tests but a real server will never drive them, because it will never be offered a version above 3. The user's practical loss is SFTP 6's `SSH_FXP_LINK` (hard links without the OpenSSH extension), the `SSH_FXP_RENAME` overwrite flag, and named owner/group attributes. |
| **Request pipelining depth** | `sftpDownloadQueue`, `sftpUploadQueue` | ⬜ Not available | `ssh2` pipelines only inside `fastGet`/`fastPut`, which cannot resume or report progress. The streaming path issues one request at a time. Throughput on high-latency links is lower than WinSCP's. A warning is logged rather than pretending the setting applies. |
| **`ed448` host keys**, **RSA key exchange** | `hostKeyList`, `kexList` | ⬜ Not offered | Not in `ssh2`'s supported algorithm lists. Logged as not offered rather than silently dropped from the preference order. |
| **`des`, `blowfish`, `arcfour` ciphers** | `cipherList` | ➖ Deliberate | Unsupported by `ssh2`, and all three sit below the `WARN` marker in WinSCP's own defaults. Not a gap worth closing. |
| **`proxyMethod: 'system'`** | proxy settings | ⬜ Not available | No reliable cross-version way to read Windows system proxy configuration from Node. Throws a message naming the working alternatives instead of silently connecting direct — which would be a privacy failure, not a convenience. |

**Honoured despite the engine change:** `sftpMaxPacketSize` maps to the stream
high-water mark, which genuinely is the SFTP read packet size in this library;
`rekeyTime` and `rekeyData` are enforced by driving `Protocol.rekey()` on a
timer and on socket byte volume, because `ssh2` exposes no rekey configuration.
When the site leaves `sftpMaxPacketSize` at zero the server's own ceiling is
used instead — `limits@openssh.com` when offered, otherwise OpenSSH's 256 kB
sftp-server limit or Momentum's 32 kB — because a packet above it is dropped and
the transfer then stalls with nothing in the log to explain it. SFTP 3
timestamps are read **signed**, so a file dated before 1970 reports its real
date instead of a day in 2106.
The host-key preference order is PuTTY's, not a flat list: certificates first
when a CA is configured, then algorithms we already hold a key for, then
everything else — so a server offering several key types does not make the user
verify a second fingerprint for a host they already trust. `sftpBugs.symlink`
and `sftpBugs.signedTS` are honoured, and the symlink argument order is decided
from WinSCP's server list rather than `ssh2`'s narrower one (`ssh2` reverses for
OpenSSH and dropbear; WinSCP also reverses for Sun SSH and ProFTPD, and stops
reversing for ProFTPD 1.x at SFTP 6).

**What the end-to-end run could not reach, and why.**
`test/e2e-sftp.test.js` drives both adapters against a real `ssh2` server over a
real socket, and the "Request pipelining depth" row above is now *measured*
rather than asserted: the server records every READ offset, and a streamed
download produces one contiguous, strictly increasing sequence — exactly the
shape a one-request-at-a-time client makes.

**Closed: the SFTP extension layer.** Three rows used to sit here saying that
`statvfs@openssh.com`, `hardlink@openssh.com` and `posix-rename@openssh.com`
could not be *tested*, because `ssh2`'s server-mode SFTP hard-codes its VERSION
reply (`SERVER_VERSION_BUFFER` in `lib/protocol/SFTP.js`) with no extension
pairs, and a fourth said the hash extensions could not be *implemented*, because
`ssh2` exposes no generic extended-request API.

Both are now false. `design/main/protocols/sftp-extensions.js` builds
`SSH_FXP_EXTENDED` packets itself and writes them through the SFTP channel with
the same SSH window accounting `ssh2` performs, and observes the raw
`SSH_FXP_EXTENDED_REPLY` bodies that `ssh2` parses only for the three replies it
knows and discards for everything else. `test/sftp-extensions.test.js` drives
all of it against a **real SFTP server over a real socket** — one written by
hand, because a server that can advertise an extension is exactly what `ssh2`'s
server mode cannot be. Working end to end: `statvfs@openssh.com`,
`space-available` (including ProFTPD's 16-bit allocation-unit field and the
field being absent entirely), `hardlink@openssh.com`, `posix-rename@openssh.com`,
`fsync@openssh.com`, `limits@openssh.com`, `copy-file`, `copy-data`,
`check-file` / `check-file-name` (whole-file and blocked), `md5-hash`,
`owner-group-query@generic-extensions`, and `vendor-id`.

`checksum()` therefore no longer needs shell access when the server offers a
hash extension: `check-file` is tried first, then `md5-hash`, and only then
`sha256sum` over `exec`. An SFTP-only account on a server offering neither now
gets a refusal that names the reason instead of a shell error.

The raw path is **guarded, not assumed**: it reaches into `ssh2` internals
(`SFTP.prototype.push`, the channel's outgoing window, the request table). If
any of those move in a future `ssh2`, `SftpExtensions.available` becomes false,
every raw request refuses with a plain message, and the typed `ext_openssh_*`
methods `ssh2` does expose keep working. It fails closed rather than corrupting
the channel.

| Still unverified against a real server | Why |
|---|---|
| `expand-path@openssh.com`, `home-directory` | Implemented, and refused correctly when the server did not announce them, but no test drives their success path — they have no consumer in the adapter yet, so a test would assert only the module. |
| `lsetstat@openssh.com` reaching a user | The request is implemented and covered end to end, but `setTimes()` and `setRights()` still use plain `SETSTAT`, which **follows a symbolic link**. Preserving a link's own timestamp therefore rewrites its target's instead. Routing those two through `lsetstat` when the path is a link, and only then, is adapter work that has to land with a test for the follow-vs-not-follow difference. |
| `copyRemote()` reaching a user | The adapter method is implemented and covered, but `queue.js` still performs a remote copy by streaming the file down and back up; nothing calls `copyRemote()`. Until `queue.js` routes `side === 'remote-copy'` through it, `caps.copyRemote` only gates the command rather than changing how it runs. |
| `security.tryFtpWhenSshFails` | `shouldSuggestFtp()` honours it and `SshTransport.ftpSuggestion()` passes the adapter's option bag, but `session.js` does not yet put the preference into that bag, so the option currently always reads as its default. |

Also outside the run: proxies (HTTP / SOCKS4 / SOCKS5 / telnet / local command),
SSH tunnelling, the SSH agent path (deliberately disabled so the suite never
touches a developer's real Pageant), rekeying under load, and `_copyChunked`
parallel transfers (whose 10 MB threshold would make the suite slow; the ranged
reads underneath it are covered by the resume tests).

## FTP (`basic-ftp` vs FileZilla)

| Gap | WinSCP option affected | Status | Consequence today |
|---|---|---|---|
| **Active mode** | `ftpPasvMode` | ✅ Closed | `basic-ftp` is passive-only; `PORT`/`EPRT` is implemented directly against the control connection, including RFC 4217's rule that we remain the TLS client on a connection the server opened. Verified end to end against a real server in `test/e2e-ftp.test.js` — listing, download, resumed download and upload, over plain FTP and over FTPS. |
| **A resumed upload uses `APPE` in passive mode and `REST` + `STOR` in active mode** | resume support on upload | 🔁 Worked around | `basic-ftp` exposes no start offset for an upload, so the passive path can only append; the hand-written active path sends the offset properly because it owns the control dialogue. Appending gives the identical result whenever the partial file on the server is exactly as long as the client thinks it is, which is the case the queue creates — but the two paths fail differently, and that difference is invisible to the user. A server that implements `REST STREAM` while refusing `APPE` cannot resume a passive upload at all (the transfer restarts from zero rather than failing), and a server whose `REST` + `STOR` truncates instead of overwriting in place would corrupt an active one. Both are exercised end to end in `test/e2e-ftp.test.js`. |
| **Multi-byte code pages** | `codePage` | 🚧 Partial | Encodings outside Node's built-in set fall back to `latin1`, which preserves bytes rather than mangling names. A real Big5/GB18030 filename needs an encoding table. |
| `ftpTransferActiveImmediately`, `ftpHost`, `ftpDupFF`, `ftpUndupFF` | as named | ⬜ Not wired | Session-level options not yet threaded through to the adapter. |

**Closed by the end-to-end run**, and listed here so nobody re-opens them from
the commit history alone: the generic `HASH` command (draft-bryan-ftpext-hash)
is implemented alongside the `X<hash>` verbs, so `caps.checksum` now means
"`checksum()` will work" rather than "the server mentioned hashing"; and
`basic-ftp`'s protocol dialogue is routed into the session log, which is the
log `logging.js` already had a `PASS` redaction rule waiting for.

**Three FTP branches that the first end-to-end pass reported as covered were
not**, and are now: `caps.checksum` was never observed being *false* on a
server that advertises `HASH` with algorithms we cannot compute; the quoting of
a checksum path containing a space was unobservable because `ftp-srv` strips
every `"` from a command line before a handler sees it; and `MLSD`'s
`type=cdir`/`type=pdir` entries were being dropped by their literal `.` / `..`
names rather than by their type, because the test server was the only one in
the world that names them that way. The harness now models the real servers
(`test/helpers/ftp-server.js`), and each of the three fails if the adapter's
handling is reverted.

## WebDAV (written directly against RFC 4918)

WebDAV is not a vendored engine, so there is nothing to be behind — but the
protocol itself cannot do things the panels offer for SFTP, and those limits
are what a user actually meets. Every row here was established by running the
adapter against a real server (`test/e2e-webdav.test.js`).

| Gap | WinSCP option affected | Status | Consequence today |
|---|---|---|---|
| **Resuming a transfer** | `resumeSupport`, `parallelTransfers` | ➖ Matches the original | A `PUT` replaces the whole resource; RFC 4918 defines no way to write at an offset, and no server implements one portably. WinSCP answers `false` to `fcResumeSupport` and `fcParallelFileTransfers` for WebDAV for the same reason, so `caps.resume` is `false` here too. An interrupted transfer restarts from the beginning, and "use multiple connections for one transfer" is unavailable. `createWriteStream` **refuses** a positioned write rather than uploading a file's tail over the whole file. |
| **Ranged downloads are available but unused** | — | 🔁 Worked around | `GET` with `Range` genuinely works when the server advertises `Accept-Ranges`, and the adapter tracks that in `rangeReads`. The transfer queue cannot use it because `caps.resume` is one flag covering both ranged reads and positioned writes; splitting it in `base.js` would let WebDAV downloads resume, which is *more* than WinSCP does. Recorded so the option is not lost. |
| **A body whose length changes in flight, over 8 MiB** | `transferMode: text` | 🚧 Partial | Text mode rewrites line endings, so the byte count the queue announces from the source file is not the byte count that goes on the wire. Bodies up to 8 MiB are buffered and sent with a **measured** `Content-Length`; beyond that the announced length is enforced, and a text-mode upload of a larger file fails with a clear message instead of leaving the server waiting for bytes that never arrive. Binary transfers of any size are unaffected. |
| **Setting a modification time** | `preserveTime` | ➖ By design | `getlastmodified` is a live property in RFC 4918; a client cannot set it. `caps.timestamp` is `false`, so the queue never tries. |
| **Permissions and ownership** | `preserveRights` | ➖ By design | WebDAV has no portable permission model. |
| **Server-side COPY and MOVE on a reduced endpoint** | rename, duplicate | ➖ By design | `caps.copyRemote`, `caps.nativeMove`, `caps.rename` and `caps.move` are taken from the `Allow` header the server answers `OPTIONS` with, not assumed. An endpoint that does not advertise `COPY`/`MOVE` (SharePoint read-only shares, several object-store gateways) has those capabilities withdrawn instead of being offered a rename that would `405`. Covered by `test/e2e-webdav.test.js`. |

## S3 (written directly against the REST API)

Established by running the adapter against a real S3-compatible server that
verifies the SigV4 signature of every request (`test/e2e-s3.test.js`).

| Gap | WinSCP option affected | Status | Consequence today |
|---|---|---|---|
| **Resuming a transfer** | `resumeSupport`, `parallelTransfers` | ➖ Matches the original | Every `PutObject` replaces the whole object, and a multipart part cannot be appended to. WinSCP answers `false` to `fcResumeSupport` and `fcParallelFileTransfers` for S3, and `caps.resume` is `false` here for the same reason. An interrupted upload restarts; a large one still goes out as a real multipart upload, and a failed part triggers `AbortMultipartUpload` so no orphan parts are billed. |
| **Plain-HTTP endpoints depend on the shared `ftps` field** | Encryption | 🚧 Partial | WinSCP gives S3 its own `Ftps` default (implicit TLS) and derives the port from it. Our `SESSION_DEFAULTS` carries one `ftps: 'none'` for every protocol, so the adapter treats a site as plaintext only when it says `ftps: 'none'` **and** is not on port 443 — otherwise an S3 site left at its defaults would silently drop to HTTP. Closing this properly means a per-protocol default in `defaults.js` plus the Encryption control on the S3 site page. |
| **Setting a modification time** | `preserveTime` | ➖ By design | `Last-Modified` is assigned by S3. |
| **Checksums for multipart objects** | `checksum` | ➖ By design | The ETag of a multipart object is `<md5-of-part-md5s>-<count>`, which is not an MD5 of the content. It is refused rather than presented as one. |
| **HTTPS endpoints addressed by IP literal** | Host name | ➖ Resolved | TLS forbids an IP address in the ServerName extension and Node throws `ERR_INVALID_ARG_VALUE` *synchronously* rather than dropping it, so an adapter that always sets `servername` cannot reach an HTTPS endpoint addressed by address rather than name at all. SNI is now omitted for an IPv4/IPv6 literal. `test/e2e-s3.test.js` proves it end to end without needing a certificate, because the failure it guards against happens before the socket opens. |
| **Certificate verification, pinning and client certificates** | host key / certificate prompts | ⬜ Not exercised | The TLS paths in `_verifyCertificate` and `_pinCheck` are implemented but not covered end to end: doing so needs a self-signed CA fixture and a `certVerifier` callback, which is separate work. The plain-HTTP paths above are fully covered. |

## Local filesystem

| Gap | Status | Consequence today |
|---|---|---|
| **Hidden / system attributes** | 🔁 Worked around | No Node API exposes `FILE_ATTRIBUTE_HIDDEN`. Attributes come from one `attrib /D` invocation per directory, degrading to `fs.Stats` if that fails. |
| **Recycle bin outside Electron** | ➖ By design | `shell.trashItem` needs the Electron runtime. Outside it, a recycle-bin delete **throws rather than deleting permanently** unless the caller explicitly opts into a permanent fallback — silently bypassing the recycle bin is how people lose files. |
| **Clearing the archive attribute after an upload** | ⬜ Not available | WinSCP's "set archive bit / clear the archive attribute" (`TCopyParamType::ClearArchive`) calls `FileSetAttr` on the uploaded local file so an incremental-backup workflow can tell what has already been sent. No Node API writes `FILE_ATTRIBUTE_ARCHIVE`, and the local adapter's `setRights` only models the POSIX bits. The option is accepted, the transfer is unaffected, and `design/main/transfer.js` **logs that it could not clear the attribute** for each file rather than silently pretending it did. The user's consequence: a backup script keyed on the archive bit will keep re-selecting files this application has already uploaded. |

**A note on the transfer engine.** `design/main/transfer.js` is the port of
Terminal.cpp's transfer half — CopyToRemote/CopyToLocal, Source/Sink, the
robust reconnect loops, TParallelOperation and the overwrite decision. It
deliberately moves no bytes: `queue.js` owns the streams, the throttle and the
text conversion, and supplies the byte mover the engine hands its resolved plan
to. Anything on this page about a protocol's resume, ranged-read or positioned-
write support therefore constrains the engine too — `caps.resume` is what
decides whether a `.filepart` upload, an Append button or a split-one-file
transfer is offered at all.

## Windows shell integration (`dragext/`, `windows/Setup.cpp`)

WinSCP is an unelevated-or-elevated desktop application with a native COM shell
extension and an Inno Setup installer that can write machine-wide keys. This
port is a per-user Squirrel application with no native modules. Everything below
is stated as what the **user** cannot do, and each row names the code path in
`design/main/shellintegration.js` or `design/main/setup.js` that replaces it.

| Gap | WinSCP feature affected | Status | Consequence today |
|---|---|---|---|
| **The drag-and-drop shell extension** | `DDFakeFile`, "default drag & drop mode" | ⬜ Not available | WinSCP's `dragext/` is an in-process COM `ICopyHook` that Explorer loads into **its own** address space. It lets WinSCP drag a hidden empty `scpNNNNN` directory, learn the real drop destination from Explorer, refuse the shell copy, and download **straight into the folder the user dropped on**. Electron can load no such extension. Dragging out therefore always uses WinSCP's *other* branch — the temporary folder — so a dragged file is downloaded to `%TEMP%\scpNNNNN` and copied out from there by Windows. The user sees: the file lands where they dropped it, but it costs disk space in `%TEMP%` first, and the "default (extension) drag & drop mode" option in Preferences has nothing to switch to. |
| **The download happens when the drag starts, not when it is dropped** | drag out of the remote panel | 🚧 Partial | `webContents.startDrag` requires the files to exist before the drag begins, whereas WinSCP downloads on drop. A drag the user starts and then abandons still transfers the file; `DragOut.abort()` deletes the staged copy immediately, so nothing is left behind, but the bytes were moved. There is no Electron API that defers the data until the drop. |
| **Dropping on a non-filesystem target** | drag out to Zip folders, FTP folders, virtual shell locations | ⬜ Not available | With the extension, WinSCP could serve any shell target. The staged-file route can only be copied out by targets Windows itself can copy a real file to. `targetUnknownMessage()` says exactly this instead of failing silently. |
| **`%PATH%` is per-user, not machine-wide** | "Add installation directory to search path" | 🚧 Partial | WinSCP's installer writes `HKLM\SYSTEM\…\Session Manager\Environment` when it runs elevated. A Squirrel install is never elevated, so `addSearchPath()` writes `HKCU\Environment`. The user gets `winscp` on their own `%PATH%`; another user on the same machine, and a service account, does not. |
| **The new `%PATH%` needs a new shell** | as above | 🚧 Partial | `path_reg_propagate` broadcasts `WM_SETTINGCHANGE` so already-running shells pick the change up. Electron cannot broadcast a window message. `addSearchPath()` returns `requiresNewShell: true` and the UI must say so; a shell that was already open keeps the old `%PATH%`. |
| **Protocol handlers are registered per user** | "Register to handle URL addresses" | 🚧 Partial | WinSCP tries `HKLM` first and falls back to `HKCU`. This port only ever writes `HKCU\Software\Classes`, which is the fallback branch. URLs open for the installing user; another user on the machine keeps whatever handler they had. |
| **8.3 short-path matching in `%PATH%`** | add/remove search path | 🚧 Partial | `find_reg_str` compares `GetShortPathName` results, so `C:\Progra~1\WinSCP` matches `C:\Program Files\WinSCP`. Node exposes no such API; `findPathEntry` compares normalized long paths case-insensitively. A `%PATH%` that literally contains an 8.3 form of our directory is not recognised, so "add to search path" would add a second, long-form entry. |
| **Importing host keys into PuTTY, and `-load <stored session>`** | "Open in PuTTY" | ⬜ Not available | WinSCP exports the site into `HKCU\Software\SimonTatham\PuTTY\Sessions` and imports its known host keys, so PuTTY opens with the same settings and does not re-ask about the host key. This port does not write another application's registry. `openSessionInPutty()` implements WinSCP's **UWP branch** instead — the whole session on the command line — which is the code path WinSCP itself ships for exactly this restriction. The user will be asked to confirm the host key by PuTTY the first time, and PuTTY-only settings (terminal, appearance, tunnels) are not carried across. |
| **The shell is not told the associations changed** | "Register to handle URL addresses" | 🚧 Partial | `NotifyChangedAssociations()` (Setup.cpp:665) calls `SHChangeNotify(SHCNE_ASSOCCHANGED)` so Explorer, the Start menu and every open shell window pick the new handler up at once. There is no Electron or `reg.exe` route to that notification. The registry entries are correct immediately, but a shell window that was already open may keep opening `sftp:` links with whatever handled them before until the user signs out and back in. |
| **`Software\Classes\<proto>` is removed on uninstall, not left behind** | uninstall | ➖ Deliberate difference | `UnregisterForProtocols` passes `UnregisterProtocol = false` for the unprefixed protocols, so WinSCP strips its own `DefaultIcon`/`command` but leaves the bare `sftp`/`ftp`/… key with its four declaration values. This port removes the key too, once `DeleteKeyIfEmpty` proves nothing else lives in it. The user is left with a cleaner registry; nothing they can do differs. Both refusals that matter — a handler another application now owns, and a key holding a foreign value — are kept. |
| **`-pwfile` needs PuTTY's file version** | "Open in PuTTY" with the password | 🔁 Worked around | `GetFileVersion` has no Node equivalent, and without a version the `auto` setting falls back to `-pw`, i.e. the password on a command line every process can read. `fileVersion()` shells out to PowerShell for the same `FileVersionInfo`; where that is blocked the fallback is WinSCP's own conservative branch, so the user gets `-pw` and should set "use password file" to *on* by hand. |
| **The Windows 7 jump-list `PKEY_Title` property** | jump list | ➖ Matches the original | `app.setJumpList()` sets the title itself, so the property WinSCP has to attach by hand is not needed. Removed items reported by Windows are still honoured. |
| **`AnyOtherInstanceOfSelf` needs `tasklist`** | installer's "close the running copy" check | 🔁 Worked around | No Node API enumerates processes. `anyOtherInstanceOfSelf()` shells out to `tasklist`; on a machine where that is blocked it answers `false`, i.e. it under-reports rather than blocking an install. |
| **COM registration inspection (`/ComRegistration`)** | the .NET assembly's COM registration | ➖ Not applicable | `Setup.cpp:2466-2937` inspects and unregisters the `WinSCP.` COM classes that back the .NET assembly. This port ships no COM server and no .NET assembly, so there is nothing to inspect. Nothing is lost for a user of this application. |

## How to use this page

- A new gap goes here the moment it is discovered, with its consequence stated
  in terms of what the user cannot do — not in terms of which library lacks
  which function.
- Closing a gap means deleting its row and saying so in the commit.
- Do not mark a unit `done` in `tools/port-map.json` while it has an open ⬜ row
  here. That is precisely the "quietly narrowed scope" the mandate forbids.
