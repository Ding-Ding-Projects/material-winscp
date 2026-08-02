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
| **SFTP protocol versions 4–6** | `sftpMaxVersion`, `sftpBugs.*` | ⬜ Not available | `ssh2`'s client hard-codes SFTP version 3. The version selector and the v4+ bug workarounds have no effect. Version 3 is what the overwhelming majority of servers negotiate anyway, but this is a genuine capability difference. |
| **SFTP hash extensions** (`check-file`, `md5-hash@openssh.com`) | checksum calculation | 🔁 Worked around | `ssh2` exposes no generic extended-request API. `checksum()` falls back to `sha256sum` / `md5sum` over `exec`, so the feature works — but it needs shell access, which SFTP-only accounts may not have. |
| **Request pipelining depth** | `sftpDownloadQueue`, `sftpUploadQueue` | ⬜ Not available | `ssh2` pipelines only inside `fastGet`/`fastPut`, which cannot resume or report progress. The streaming path issues one request at a time. Throughput on high-latency links is lower than WinSCP's. A warning is logged rather than pretending the setting applies. |
| **`ed448` host keys**, **RSA key exchange** | `hostKeyList`, `kexList` | ⬜ Not offered | Not in `ssh2`'s supported algorithm lists. Logged as not offered rather than silently dropped from the preference order. |
| **`des`, `blowfish`, `arcfour` ciphers** | `cipherList` | ➖ Deliberate | Unsupported by `ssh2`, and all three sit below the `WARN` marker in WinSCP's own defaults. Not a gap worth closing. |
| **`proxyMethod: 'system'`** | proxy settings | ⬜ Not available | No reliable cross-version way to read Windows system proxy configuration from Node. Throws a message naming the working alternatives instead of silently connecting direct — which would be a privacy failure, not a convenience. |

**Honoured despite the engine change:** `sftpMaxPacketSize` maps to the stream
high-water mark, which genuinely is the SFTP read packet size in this library;
`rekeyTime` and `rekeyData` are enforced by driving `Protocol.rekey()` on a
timer and on socket byte volume, because `ssh2` exposes no rekey configuration.

**What the end-to-end run could not reach, and why.**
`test/e2e-sftp.test.js` drives both adapters against a real `ssh2` server over a
real socket, and the "Request pipelining depth" row above is now *measured*
rather than asserted: the server records every READ offset, and a streamed
download produces one contiguous, strictly increasing sequence — exactly the
shape a one-request-at-a-time client makes.

Three client capabilities remain **unverified by any test**, and that is a
limitation of the test harness rather than a limitation the user meets:

| Untested path | Why the harness cannot reach it |
|---|---|
| `spaceInfo()` via `statvfs@openssh.com` | `ssh2`'s server-mode SFTP hard-codes its VERSION reply (`SERVER_VERSION_BUFFER` in `lib/protocol/SFTP.js`) with **no extension pairs**, so a test server physically cannot advertise an extension. The client refuses the request unless the server advertised it, so the code path cannot be entered against this server. The adapter reports `caps.spaceInfo === false` and `spaceInfo()` returns `null` — both asserted — but the branch that runs against a real OpenSSH server is exercised by nothing. |
| `hardlink()` via `hardlink@openssh.com` | Same cause. The refusal path is asserted; the success path is not. |
| `posix-rename@openssh.com` | Same cause. `serverInfo.posixRename` is always `false` here. |

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
