# Protocols

Every transfer backend in WinSCP Material implements the same adapter contract,
defined in `design/main/protocols/base.js`. The UI never asks a backend to do
something it has not declared it can do: each adapter publishes a `caps` object,
and commands the protocol cannot support are greyed out rather than failing at
run time.

> [!IMPORTANT]
> **Postman collections are not applicable to this category, or anywhere else in
> this project.** WinSCP Material is a desktop client for SFTP, SCP, FTP/FTPS,
> WebDAV and S3. It exposes no HTTP API of its own, hosts no server and offers
> no REST endpoint, so there is nothing a Postman collection could exercise.
> WebDAV and S3 are carried over HTTP, but they are *outbound* protocol clients
> talking to third-party servers, not an API this project publishes. No Postman
> artefacts are invented to satisfy a checklist.

## Articles

| Article | Covers |
| --- | --- |
| [adapter-contract.md](adapter-contract.md) | The interface every backend implements, and how `caps` drives the UI. |
| [remote-files.md](remote-files.md) | Shared remote listing rows, POSIX/VMS path rules, metadata, symlink refusal, and directory-size semantics. |
| [sftp.md](sftp.md) | SFTP over SSH — versions 3–6, packet sizing, queueing, server bugs. |
| [scp.md](scp.md) | SCP and the shell session it depends on. |
| [ftp.md](ftp.md) | FTP, FTPS (explicit and implicit), passive-host policy, active mode, MLSD, TLS session reuse, resume and encoding/error behaviour. |
| [webdav.md](webdav.md) | WebDAV and WebDAVS, XML listings, escaping, redirect origin isolation, and legacy authentication. |
| [s3.md](s3.md) | Amazon S3 and S3-compatible endpoints, URL styles, pagination, multipart copy, and storage classes. |
| [s3-multipart-abort.md](s3-multipart-abort.md) | Idempotent cleanup of failed, cancelled and incomplete multipart uploads. |
| [local.md](local.md) | The local filesystem backend and Windows path handling. |

## Capability matrix

The flags below are what `caps` advertises. A blank cell means the UI disables
the corresponding command for that protocol.

| Capability | SFTP | SCP | FTP/FTPS | WebDAV | S3 | Local |
| --- | :-: | :-: | :-: | :-: | :-: | :-: |
| Directory listing | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Upload / download streaming | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Resume partial transfers | ✅ | | ✅ | | | ✅ |
| Rename / move | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Set POSIX permissions | ✅ | ✅ | partial | | | |
| Set timestamps | ✅ | ✅ | partial | | | ✅ |
| Symbolic links | ✅ | ✅ | | | | ✅ |
| Hard links | ✅ | | | | | ✅ |
| Server-side copy | ✅ | ✅ | | ✅ | ✅ | |
| Checksums | ✅ | ✅ | partial | | ✅ | ✅ |
| Arbitrary shell commands | | ✅ | | | | |
| Recycle bin | ✅ | ✅ | ✅ | ✅ | | ✅ |

"partial" means the capability depends on what the specific server advertises,
so it is resolved after connecting rather than assumed.

## Cross-cutting behaviour

- **Paths are POSIX inside an adapter**, always — with `local.js` overriding
  `sep`, `normalize`, `join`, `dirname` and `basename` for Windows. Anything
  that builds a path by string concatenation is a bug.
- **Listings are uniform.** `list()` builds every row through `entry()`, so
  every column the UI renders exists for every protocol even when the server
  cannot supply it. A missing value is explicitly absent, never a guessed one.
- **Streaming is the transfer path.** `createReadStream` / `createWriteStream`
  carry files; `readFile` / `writeFile` exist for the editor and small files.
- **Timeouts and keepalives** are per-site (`timeout`, `pingInterval`,
  `pingType`) and apply the same way across protocols.

## Suggested articles

- [Transfers and the queue](../transfers-and-queue/) — what happens to a stream once a protocol hands it over.
- [Security and credentials](../security-and-credentials/) — host keys, certificates and how secrets reach an adapter.
- [Sessions and sites](../sessions-and-sites/) — where per-protocol options are configured and stored.
