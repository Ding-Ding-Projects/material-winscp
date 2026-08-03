# SFTP

## What it does

SFTP is the default protocol and the most complete adapter. It runs over an SSH
transport (`ssh2`) and currently negotiates the SFTP v3 wire dialect. The stored
v4–v6 preference is retained for compatibility, but this build does not yet
provide a version-capable SFTP engine; see the limitation in the configuration
table below. Remote shell execution is a separate optional SSH channel and may
be unavailable for SFTP-only accounts — for the shell-first protocol, see
[SCP](scp.md).

Concretely it provides: directory listing with full POSIX metadata, streaming
upload and download with resume, `chmod`, `utime`, symbolic and hard links when
the server advertises a supported route, server-side copy where the server
implements it, remote checksums, and bounded request pipelining that makes
resumable SFTP fast over long
links without allowing a large hand-edited queue value to grow memory without
limit.

Checksum fallback is exact: shell execution is used only for MD5, SHA-1,
SHA-256, and SHA-512. If an extension cannot compute another requested
algorithm, the adapter refuses it instead of returning a digest from a
different algorithm. Extension-provided private algorithms remain available
when the server implements them, and the older OpenSSH `md5-hash` extension
still keeps checksum mode enabled even when no broader hash extension is
advertised.

## Configuration

All of these live in `SESSION_DEFAULTS` (`design/main/defaults.js`) and surface
under **Site → Advanced → SSH** and **→ SFTP**.

### SSH transport

| Option | Default | Meaning |
| --- | --- | --- |
| `sshProt` | `2` | SSH protocol version. |
| `cipherList` | aes, chacha20, 3des, **WARN**, des, blowfish, arcfour | Preference order. Anything after `WARN` prompts before use. |
| `kexList` | ecdh, dh-gex-sha1, dh-group18/17/16/15-sha512, dh-group14-sha1, rsa, **WARN**, dh-group1-sha1 | Key-exchange preference order. |
| `hostKeyList` | ed448, ed25519, ecdsa, rsa, dsa, **WARN** | Host-key algorithm preference. |
| `compression` | `false` | zlib on the transport. Helps on slow links, costs CPU. |
| `rekeyTime` / `rekeyData` | `60` min / `1G` | Rekey cadence. |
| `tryAgent` | `true` | Use Pageant/an SSH agent if one is running. |
| `agentFwd` | `false` | Forward the agent to the server. Off by default — see below. |
| `authKI`, `authKIPassword` | `true` | Keyboard-interactive authentication. |
| `authGSSAPI`, `authGSSAPIKEX`, `gssapiFwdTGT` | `false` | Kerberos/GSSAPI. |
| `publicKeyFile`, `passphrase` | `''` | Private key and its passphrase. |
| `sshNoUserAuth` | `false` | Skip the authentication phase entirely (rare servers). |
| `sendBuf` | `262144` | SSH parser stream buffer in bytes. Larger values can reduce backpressure on high-throughput links; invalid or non-positive values use ssh2's default. |

### SFTP layer

| Option | Default | Meaning |
| --- | --- | --- |
| `sftpMaxVersion` | `6` | Stored for session compatibility, but not effective in this build: `ssh2` sends and parses SFTP version 3 only. Versions 4–6, including native v6 hard links, are a documented gap. |
| `sftpMinPacketSize` | `0` | Stored for compatibility, but not consumed by the reachable adapter. It does not change transfer requests. |
| `sftpMaxPacketSize` | `0` (auto) | Sets the stream read/write chunk high-water mark; zero uses the server/engine ceiling when one is known. |
| `sftpDownloadQueue` / `sftpUploadQueue` | `32` | Outstanding READ/WRITE requests in flight. Raising this helps on high-latency links; lowering it helps on servers with small buffers. The adapter clamps each direction to 256 requests. |
| `sftpListingQueue` | `2` | Parallel listing requests. |
| `sftpRealPath` | `auto` | Whether to canonicalize paths with `SSH_FXP_REALPATH`. |
| `usePosixRename` | `false` | Use the `posix-rename@openssh.com` extension so rename can overwrite atomically. |
| `sftpBugs.symlink` | `auto` | Work around servers that reverse `SSH_FXP_SYMLINK`'s arguments. |
| `sftpBugs.signedTS` | `auto` | Work around servers sending signed timestamps. |
| `sftpServer` | `''` | Not available in this build. A non-empty custom subsystem command is rejected before SSH opens; the adapter cannot safely replace `ssh2`'s literal `sftp` request. |

Stream `start` and `end` offsets are validated before opening a remote handle.
They must be non-negative safe integers; negative, fractional, and infinite
values fail immediately instead of being silently treated as zero or omitted.

`auto` for any bug workaround means: detect from the server's version banner and
behaviour, and only then apply it.

## Failure modes

| Situation | What the user sees | Recoverable |
| --- | --- | --- |
| Host key does not match the cached one | A **blocking** dialog — this is a decision the user must make before continuing, so it is deliberately modal. It shows both fingerprints and refuses to default to "accept". | Yes, by re-verifying out of band |
| Authentication fails | A persistent error toast naming the method that failed (password, key, keyboard-interactive) and, when the server said so, why. Passwords are never echoed. | Yes |
| An explicit cipher, KEX or host-key list has no usable algorithm in this build | The connection stops before the SSH handshake with a non-retriable policy error; the adapter never falls back to `ssh2` defaults. | No, until the site policy is changed |
| Key file needs a passphrase | A modal prompt. If the master password is set, an accepted passphrase can be saved encrypted. | Yes |
| A custom `sftpServer` command is configured | The connection is refused before the SSH transport opens, because this build cannot request that command and must not silently run the default `sftp` subsystem instead. | Yes, by clearing the custom command |
| `sftpMaxVersion` is lowered | No SFTP version negotiation change occurs in this build: `ssh2` still sends and parses version 3. Versions 4–6 remain unavailable and the stored value does not narrow the live capability set. | No, until a version-capable SFTP engine is integrated |
| Server ignores `chmod` | The operation is reported as failed rather than assumed to have worked. `ignorePermErrors` in the transfer settings can downgrade it to a warning for bulk transfers. | Yes |
| Transfer interrupted | The queue item records the byte offset and moves to `failed`. Resume restarts from that offset if `resumeSupport` permits and preserves existing remote permissions unless an explicit mode is supplied. | Yes |
| SSH handshake, host-key or authentication failure | Any partially opened SSH socket, channel, or tunnel listener is closed before the classified error is returned. The transport remains retryable unless the classification says otherwise. | Yes, when the classification is retriable |
| Server rejects `SSH_FXP_LSTAT` | A read-only `stat()` probe retries with `STAT` only when the detected workaround applies. Symlink identity is not guessed, and the followed result keeps its `file`, `dir`, or `special` type; mutating operations continue to require `LSTAT`. | Yes for ordinary files/directories |
| Directory entries omit SFTP attributes | The listing performs an `LSTAT` for that entry so size, times, ownership, permissions, and symlink identity are not fabricated from zero values. If the probe fails, the partial directory row is retained. | Yes, when the server permits `LSTAT` |
| Server returns a special file or navigation/path-like directory name | `stat()` preserves the `special` type, and recursive listing/removal rejects unsafe names instead of following a server-supplied path. | No — use a trustworthy server |
| Server offers only `md5-hash` | The checksum action stays enabled and the adapter uses the extension for MD5 instead of hiding the feature behind shell access. | Yes |
| Free-space extension reports zero bytes available to this user | The reported free space remains zero; physical free space is not substituted for a quota-limited result. | Yes, when the quota changes |
| Rekey during a large transfer | Handled by the transport; the transfer pauses for a few hundred milliseconds. No user action. | n/a |
| `sftpDownloadQueue` or `sftpUploadQueue` too high for the server | Stalls or resets. Lower it to 8 or 16. Values above 256 are clamped and logged; the server may still need a smaller value. | Yes |

## Security considerations

- **Cipher and KEX ordering matters.** Everything listed *after* the `WARN`
  marker is considered weak. Selecting one produces an explicit warning naming
  the algorithm; the marker is not decorative and must not be reordered casually.
- **Explicit algorithm policy fails closed.** If a configured cipher, KEX or
  host-key list resolves to no algorithm implemented by this build, the adapter
  closes the socket before the SSH identification exchange and reports a
  non-retriable policy error. It never silently replaces the site policy with
  `ssh2`'s defaults.
- **Agent forwarding is off by default**, and correctly so: a forwarded agent
  lets anyone with root on the remote host use your keys for as long as you are
  connected. The option's UI states this.
- **Host key verification is mandatory** and never silently skipped. Trust
  decisions are stored in `hostkeys.json` (see `paths.js`) with the algorithm and
  fingerprint, so a changed key is detected rather than absorbed.
- **Passphrases and passwords are held in memory only** for the life of the
  session unless the user asks to save them, in which case `crypto.js` wraps
  them with the OS keychain or a master-password-derived key. If neither is
  available the secret is **not stored** rather than stored unprotected.
- **Debug logging can capture sensitive material.** `logging.logSensitive` is
  off by default; turning it on shows a warning that the resulting log is as
  sensitive as the credential itself.

## Verification

- Path arithmetic, mask matching and listing normalization are unit-tested.
- Bug-workaround detection is tested against recorded server banners.
- Live-server behaviour (resume, bounded request pipelining, rekey and
  permission handling) is exercised against the in-process SSH server over a
  real TCP socket. The streaming tests verify ordered bytes and the first four
  offsets in each configured request window.
- Explicit unusable cipher, KEX and host-key policies are verified against a
  TCP listener: each fails before any SSH bytes or authentication can occur,
  and its error is classified as non-retriable.
- The FTPShell `LSTAT` compatibility path is unit-tested for its supported
  status code, its normalized directory result, and its refusal to downgrade
  unrelated errors.
- Recursive removal lstat-probes directory entries whose server omitted
  attributes. This preserves directory removal while treating symlinked
  directories as links, so a cleanup cannot follow a link outside its target
  tree.
- Directory listing is also tested with omitted entry attributes; it
  `lstat`-probes the child and reports its actual size, timestamps, ownership,
  permissions, and type instead of silently presenting a zero-metadata file.
- Special-file `stat()` results stay `special`, recursive removal ignores the
  protocol's `.`/`..` navigation records, and server-supplied path separators
  are rejected before a child path is constructed.
- A zero `space-available` user quota stays zero rather than falling back to
  the filesystem-wide free-space value.
- The `ssh2` decoded-extension fallback is not trusted for binary values after
  UTF-8 replacement has destroyed their bytes.
- Capacity probing tolerates servers that advertise `statvfs@openssh.com` but
  refuse the request for the current account or filesystem; it reports space
  information as unavailable rather than failing the surrounding operation.
- Resumed uploads are verified against the in-process SFTP server for both the
  wire offset and permission preservation. Reopening an existing file does not
  apply the default upload mode; an explicit `mode` remains available when
  metadata should change.
- A configured custom `sftpServer` command is verified to fail before an SSH
  transport is created, rather than silently opening the default subsystem.
- The session-setting audit records the current limitations: `ssh2` hard-codes
  SFTP version 3, and the adapter consumes `sftpMaxPacketSize` but not
  `sftpMinPacketSize`.

To check a real connection by hand: connect, run **Commands → Server/protocol
information**, and confirm the negotiated SFTP version and extension list match
what the greyed-out state of the menus implies.

## Suggested articles

- [The adapter contract](adapter-contract.md) — where `caps` comes from.
- [SCP](scp.md) — the same SSH transport, a very different file layer.
- [Host key verification](../security-and-credentials/host-keys.md) — the trust store behind the modal.
- [Transfers and the queue](../transfers-and-queue/) — resume, parallelism and speed limits.
