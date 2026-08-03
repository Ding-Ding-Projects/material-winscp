# WebDAV and WebDAVS

## What it does

The WebDAV adapter speaks HTTP `PROPFIND`, `GET`, `PUT`, `MKCOL`, `DELETE`,
`MOVE` and `COPY` against a WebDAV server. `COPY` gives it server-side copy — one
of the few protocols here that can duplicate a large file without moving the
bytes through the client.

It has no POSIX permission model, so `chmod` is not offered; the capability flag
is false and the menu entry is greyed out rather than failing.

> [!NOTE]
> WebDAV runs *over* HTTP, but it is an outbound client for someone else's
> server. This project publishes no HTTP API, so there is no Postman collection
> for it — see the [category index](README.md).

## Configuration

Under **Site → Advanced → WebDAV**.

| Option | Default | Meaning |
| --- | --- | --- |
| `webDavLiberalEscaping` | `false` | Percent-encode a wider set of characters in paths, for servers that reject the conservative encoding. |
| `webDavAuthLegacy` | `false` | Send Basic credentials pre-emptively instead of waiting for a `401` challenge. Needed by a few servers; it leaks the credential to any server that asks. |
| `ftps` (shared field) | — | `implicit` selects HTTPS; `none` selects plain HTTP. |
| `tlsCertificateFile` | `''` | Client certificate for mutual TLS. |
| `minTlsVersion` / `maxTlsVersion` | `tls10` / `tls13` | Negotiated version window. |
| `proxyMethod` and friends | `none` | HTTP proxying uses the same per-site proxy block as every other protocol. |

The remote path is the URL path. A site whose `hostName` is
`dav.example.com` and whose `remoteDirectory` is `/team/docs` addresses
`https://dav.example.com/team/docs`.

## Failure modes

| Situation | What the user sees | Recoverable |
| --- | --- | --- |
| Server returns HTML for `PROPFIND` (a login page, a proxy interstitial) | The listing fails with "the server did not return WebDAV XML", quoting the first line of what it did return. Guessing is deliberately not attempted. | Yes |
| `401` on every request with `webDavAuthLegacy` off | Some servers never issue a challenge. Turning the option on fixes it — with the caveat below. | Yes |
| Paths containing `+`, `#`, `%` or non-ASCII | Servers disagree about encoding. `webDavLiberalEscaping` widens the escaping set. | Usually |
| `MOVE`/`COPY` across a quota boundary | The server's `507` is surfaced verbatim, including its message. | Depends on the server |
| Locking (`LOCK`/`UNLOCK`) | Not implemented. Concurrent edits are last-write-wins, and the editor warns when a file's ETag changed under it. | Partially |
| No resume support | `caps.resume` is false; interrupted uploads restart. Range `GET` is not used for resumed downloads because servers report support inconsistently. | n/a |
| Certificate untrusted | The same blocking trust dialog as FTPS, with the same fingerprint pinning. | Yes |

## Security considerations

- **`webDavAuthLegacy` sends your password before the server proves it wants
  it.** Over plain HTTP that hands the credential to anything on the path; over
  HTTPS to any server presenting a trusted certificate for that host. The option
  is off by default and its UI states the trade-off.
- **Plain HTTP WebDAV is as exposed as plain FTP.** Selecting `none` for
  encryption raises the same non-dismissible warning.
- **Redirects are not followed blindly.** A cross-origin redirect drops
  credentials and the session's keep-alive agent, even when the user permits
  following it. A redirect from HTTPS to HTTP is refused outright.
- **The XML parser does not expand declarations** — DTDs and external entity
  declarations are ignored. A hard byte cap for non-streaming response bodies
  remains a follow-up gap before hostile, very large `PROPFIND` output is fully
  bounded against denial of service.
- **ETags are the only concurrency signal available.** The editor compares them
  before writing back; when the server does not send one, the editor says the
  file could not be checked rather than implying it was.

## Verification

- `PROPFIND` response parsing is unit-tested against responses from Nextcloud,
  SabreDAV, IIS and Apache `mod_dav`, including namespace-prefixed and
  namespace-defaulted XML.
- Escaping is tested for both the conservative and liberal sets across a
  filename corpus containing spaces, `+`, `#`, `%`, `&` and CJK characters.
- Digest authentication covers MD5, SHA-256 and SHA-512/256; the last uses the
  standardized SHA-512/256 function (not a truncated SHA-512 digest), as
  required by RFC 7616.
- Redirect refusal has direct tests; declaration handling is covered by the
  parser fixtures, while the non-streaming response byte cap remains untested
  and unimplemented.
- Cross-origin redirect handling is exercised with two local HTTP servers: the
  original request is authenticated, while the redirected request carries no
  `Authorization` header.

Manual check: connect over HTTPS, open the session log, and confirm the
`PROPFIND` for the root directory returns `207 Multi-Status` with a `D:multistatus`
body.

## Suggested articles

- [S3](s3.md) — the other HTTP-based backend, with a different security model entirely.
- [FTP and FTPS](ftp.md) — shares the certificate trust store and TLS options.
- [Editors](../editing-and-commands/editors.md) — why ETags matter when editing remote files.
- [The adapter contract](adapter-contract.md) — why `chmod` is greyed out rather than failing.
