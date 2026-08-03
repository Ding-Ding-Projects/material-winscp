# FTP and FTPS

## What it does

The FTP adapter (built on `basic-ftp`) speaks plain FTP and both flavours of
FTPS: **explicit** (`AUTH TLS` on port 21, the modern default) and **implicit**
(TLS from the first byte, historically port 990). It supports passive and active
data connections, `MLSD` structured listings with a fallback to `LIST` parsing,
`REST`-based resume, and the subset of permission and timestamp operations a
given server advertises.

Capabilities are resolved **after** connecting, from the server's `FEAT`
response — which is why the matrix marks permissions, timestamps and checksums
as "partial". The UI updates the greyed-out state once the feature list arrives.

## Configuration

Under **Site → Advanced → FTP** and **→ TLS/SSL**.

| Option | Default | Meaning |
| --- | --- | --- |
| `ftps` | `none` | `none`, `explicitTls`, or `implicit`. |
| `ftpPasvMode` | `true` | Passive mode. Turn it off only on networks where active works and passive does not. |
| `ftpForcePasvIp` | `auto` | `auto` uses basic-ftp's NAT-aware replacement for private PASV addresses; `on` always reuses the control connection's address; `off` honours the server's advertised address. |
| `ftpUseMlsd` | `auto` | Prefer `MLSD` (machine-readable) over `LIST` (human-readable, ambiguous). |
| `ftpAccount` | `''` | The `ACCT` value, for the rare servers that want one. |
| `ftpPingInterval` / `ftpPingType` | `30` / `dummy` | Keepalive on the control channel: `off`, `dummy` (`NOOP`), or `directory` (`PWD`). |
| `ftpTransferActiveImmediately` | `auto` | Send the transfer command before or after the data connection is accepted. |
| `ftpListAll` | `auto` | Try `LIST -a` to reveal dot-files, falling back if the server treats `-a` as a filename. |
| `ftpHost` | `auto` | Send `HOST` for virtual-host servers. |
| `ftpDupFF` / `ftpUndupFF` | `false` | Work around servers that mangle `0xFF` bytes in filenames. |
| `sslSessionReuse` | `true` | Reuse the control channel's TLS session on the data channel. Required by most modern servers; a few old ones break on it. |
| `tlsCertificateFile` | `''` | Client certificate for mutual TLS. |
| `minTlsVersion` / `maxTlsVersion` | `tls10` / `tls13` | Negotiated version window. |

## Failure modes

| Situation | What the user sees | Recoverable |
| --- | --- | --- |
| Passive mode returns an unroutable private address | Data connections time out. The error explicitly suggests `ftpForcePasvIp`. | Yes |
| A firewall blocks the data port range | Listing hangs then times out. Active mode or a server-side port range fixes it. | Yes |
| `sslSessionReuse` required but disabled | The server aborts the data connection with a TLS error. The message names the setting. | Yes |
| `sslSessionReuse` enabled but unsupported | Data connections fail on an old server; turn it off. | Yes |
| Certificate not trusted | A **blocking** dialog showing the subject, issuer, validity window and SHA-256 fingerprint. Trusting it stores the fingerprint alongside SSH host keys. | Yes |
| `LIST` output in an unrecognized format | The parser reports which lines it could not read and how many, rather than dropping them silently. Enabling `MLSD` is the real fix. | Usually |
| Non-UTF-8 filenames without `UTF8` in `FEAT` | Names decoded through the site's `codePage`. Mis-set, they appear as mojibake but remain openable. | Yes |
| Resume on a server without `REST` | `caps.resume` stays false; the queue restarts the file rather than offering a broken resume. | n/a |
| Resume offset is negative, fractional or non-finite | The transfer is rejected before `REST` is sent; offsets must be non-negative integer byte positions. | Yes — retry from a valid byte offset |
| Idle disconnect | Detected on the next command; auto-reconnect follows `security.sessionReopen*`. | Yes |
| Username, password or ACCT contains a line break | Login is rejected before any credential command is sent. FTP has no escaping for command record separators, so accepting one could send an unintended command. | Yes — correct the saved site value |
| A post-login command contains a line break | The command is rejected before it reaches the control connection. FTP has no escaping for command record separators, so accepting one could append an unintended command. | Yes — correct the saved command |
| A listing reports an unsafe or overflowing size | The entry is retained with size `0` (unknown) rather than propagating an inaccurate `Infinity` or rounded byte count into transfers and comparisons. | Yes — enable MLSD or fix the server listing |
| A `SIZE` reply is unsafe or overflowing | `stat()` retains the file with size `0` (unknown) rather than trusting an unsafe JavaScript number returned by the FTP library. | Yes — enable MLST or fix the server response |

The passive-host choice is applied when the FTP client is constructed, before
the first `PASV`/`EPSV` negotiation. In particular, `on` is not merely a UI
label: it sets basic-ftp's `allowSeparateTransferHost` to false, so a server
cannot redirect the data socket to a different host. `auto` remains the
default because basic-ftp already replaces a private PASV address when the
control connection is public.

## Security considerations

- **Plain FTP sends the password in clear text**, along with every byte of every
  file. When `ftps` is `none` the login screen shows an unmissable warning, and
  it is not dismissible-forever — this is not paranoia, it is the protocol.
- **`tryFtpWhenSshFails`** (in `security`, default `true`) will *offer* FTP after
  an SSH failure. It offers; it never silently downgrades an encrypted session
  to an unencrypted one.
- **Certificate trust is explicit and pinned by fingerprint.** A changed
  certificate re-prompts, exactly as a changed SSH host key does.
- **`minTlsVersion` defaults to `tls10`** for compatibility with older servers.
  Raising it to `tls12` is recommended wherever the server allows, and the option
  says so.
- **FTP has no integrity guarantee for the data channel** unless TLS covers it.
  A checksum comparison after transfer is the only way to be sure over plain FTP.
- The `0xFF` workarounds change bytes in filenames. They are `false` by default
  because a wrong guess corrupts names rather than displaying them oddly.

## Verification

- `test/protocols-ftp-parse.test.js` covers `LIST` parsing for Unix, Windows/IIS,
  NetWare, VMS and MLSD formats, including entries with spaces in filenames and
  ambiguous year/time columns.
- TLS option plumbing is unit-tested; live FTPS behaviour is checked manually
  against vsftpd and FileZilla Server.
- Passive-host policy plumbing is covered by
  `test/ftp-adapter-options.test.js`; the end-to-end suite exercises passive
  and active listing/download/upload/resume paths over real sockets.

Manual check: connect, open the session log at debug level 1, and confirm the
`FEAT` response matches the capabilities the UI has enabled.

## Suggested articles

- [The adapter contract](adapter-contract.md) — how post-connect capability resolution reaches the UI.
- [WebDAV](webdav.md) — the other TLS-over-HTTP client, with a similar trust store.
- [Certificates and trust](../security-and-credentials/host-keys.md) — where accepted fingerprints live.
- [Transfers and the queue](../transfers-and-queue/resume.md) — what `REST` support does and does not buy.
