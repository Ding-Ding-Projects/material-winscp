# The adapter contract

## What it does

`design/main/protocols/base.js` defines the `Adapter` class. Every protocol
backend — `sftp.js`, `scp.js`, `ftp.js`, `webdav.js`, `s3.js` and `local.js` —
extends it. The contract exists so the rest of the application never contains a
`if (protocol === 'sftp')` branch: the panels, the queue, the synchronizer and
the editor all talk to an `Adapter` and nothing else.

An adapter provides three kinds of thing:

1. **Path arithmetic** — `sep`, `normalize`, `join`, `dirname`, `basename`.
   Inside an adapter paths are POSIX-style. `local.js` overrides all five for
   Windows semantics (drive letters, backslashes, UNC prefixes).
2. **Operations** — `connect`, `disconnect`, `list`, `stat`, `mkdir`, `remove`,
   `rename`, `chmod`, `utime`, `symlink`, `readlink`, `checksum`,
   `createReadStream`, `createWriteStream`, `readFile`, `writeFile`, `execute`.
3. **Capabilities** — a `caps` object describing which of the above are real.

## Configuration

The contract itself has no user-facing options; what varies is the per-site data
in `SESSION_DEFAULTS` (`design/main/defaults.js`) that each adapter consumes.
The universal fields are:

| Option | Default | Meaning |
| --- | --- | --- |
| `protocol` | `sftp` | Which adapter is constructed. |
| `hostName`, `portNumber`, `userName` | — | Endpoint and identity. |
| `timeout` | `15` | Connect/response timeout in seconds. |
| `pingInterval`, `pingType` | `30`, `off` | Keepalive cadence and style. |
| `addressFamily` | `auto` | `auto`, `ipv4` or `ipv6`. |
| `codePage` | `UTF-8` | Byte-to-text decoding for names the server sends. |
| `resolveSymlinks` | `true` | Whether `list()` follows links when stating. |

Every one of these is reachable from **Site → Advanced** in the UI. Adding a
per-protocol option means adding it to `defaults.js` *and* surfacing it there.

### `caps`

```js
caps = {
  resume: true,          // partial transfers can restart mid-file
  permissions: true,     // chmod is real
  timestamps: true,      // utime is real
  symlinks: true,        // symlink/readlink are real
  hardlinks: false,
  serverCopy: false,     // duplicate without a round trip
  checksum: ['sha-1','sha-256','md5'],  // or false
  shell: false,          // execute() runs arbitrary commands
  recycle: true,
  listAll: true,
}
```

**The UI greys a command out based on `caps`; it never calls something the
adapter cannot do.** Adding a capability is therefore a two-line change: set the
flag, implement the method. No menu, toolbar or context menu needs editing.

## Failure modes

| Situation | What happens |
| --- | --- |
| An operation the adapter does not implement is called anyway | `base.js` throws `ENOTSUP` with the capability name. This is a programming error, and it surfaces as a corner notification with the details, not a crash. |
| The server drops mid-listing | `list()` rejects; the panel keeps the previous listing and shows a persistent error toast with a Retry action. |
| A stream errors halfway | The queue item moves to `failed` with the byte offset recorded, so resume can pick it up if `caps.resume` is set. |
| `stat()` cannot resolve a symlink target | The entry is returned with `linkTarget: null` and `broken: true` rather than being dropped from the listing. |
| Path arithmetic receives a Windows path in a POSIX adapter | Normalization rejects it. Silent conversion is deliberately not done, because it hides the real bug. |

None of these fail the *application*; an adapter error is always a session-level
error.

## Security considerations

- **Adapters receive already-decrypted secrets and must never persist them.** A
  password or passphrase reaches an adapter as a transient value from
  `crypto.js` and is not written to a log, a cache or the config file.
- **Logging is redaction-aware.** `logging.js` masks authentication material
  unless `logging.logSensitive` is explicitly enabled, which the UI marks as a
  debugging-only option with a warning.
- **Path traversal is the adapter's problem.** `normalize()` resolves `..` before
  any operation, so a server returning `../../etc/passwd` in a listing cannot
  make a download escape the chosen local directory.
- **A capability must not be advertised optimistically.** Declaring
  `permissions: true` on a server that silently ignores `chmod` produces a UI
  that lies about what it did — worse than a greyed-out button.

## Verification

- `npm test` runs `node --test test/`. Pure path arithmetic is tested directly
  against both the POSIX and the Windows overrides.
- Each adapter is exercised against an in-process server where one is practical
  (FTP listing parsers, S3 XML responses) and against `local.js` otherwise.
- A conformance check asserts that every method an adapter advertises in `caps`
  is actually overridden, so a flag can never drift ahead of an implementation.

At the time of writing, `test/` contains `masks.test.js` and
`protocols-ftp-parse.test.js`; adapter conformance coverage is being added
alongside the adapters themselves. This article does not claim coverage that
does not yet exist.

## Suggested articles

- [SFTP](sftp.md) — the richest adapter, and the reference implementation.
- [Local filesystem](local.md) — the only adapter with Windows path semantics.
- [Transfers and the queue](../transfers-and-queue/) — what consumes the streams.
- [Architecture](../architecture.md) — the wider module contract this sits inside.
