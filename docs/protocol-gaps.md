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

## FTP (`basic-ftp` vs FileZilla)

| Gap | WinSCP option affected | Status | Consequence today |
|---|---|---|---|
| **Active mode** | `ftpPasvMode` | ✅ Closed | `basic-ftp` is passive-only; `PORT`/`EPRT` is implemented directly against the control connection, including RFC 4217's rule that we remain the TLS client on a connection the server opened. |
| **Multi-byte code pages** | `codePage` | 🚧 Partial | Encodings outside Node's built-in set fall back to `latin1`, which preserves bytes rather than mangling names. A real Big5/GB18030 filename needs an encoding table. |
| `ftpTransferActiveImmediately`, `ftpHost`, `ftpDupFF`, `ftpUndupFF` | as named | ⬜ Not wired | Session-level options not yet threaded through to the adapter. |

## Local filesystem

| Gap | Status | Consequence today |
|---|---|---|
| **Hidden / system attributes** | 🔁 Worked around | No Node API exposes `FILE_ATTRIBUTE_HIDDEN`. Attributes come from one `attrib /D` invocation per directory, degrading to `fs.Stats` if that fails. |
| **Recycle bin outside Electron** | ➖ By design | `shell.trashItem` needs the Electron runtime. Outside it, a recycle-bin delete **throws rather than deleting permanently** unless the caller explicitly opts into a permanent fallback — silently bypassing the recycle bin is how people lose files. |

## How to use this page

- A new gap goes here the moment it is discovered, with its consequence stated
  in terms of what the user cannot do — not in terms of which library lacks
  which function.
- Closing a gap means deleting its row and saying so in the commit.
- Do not mark a unit `done` in `tools/port-map.json` while it has an open ⬜ row
  here. That is precisely the "quietly narrowed scope" the mandate forbids.
