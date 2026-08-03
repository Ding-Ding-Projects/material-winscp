# PuTTY interoperability metadata

`design/main/putty.js` is the small safety boundary used when the app needs to
understand PuTTY-style key and session metadata. It is intentionally not a
private-key loader. The SSH implementation remains responsible for decrypting
or using a key; this module only answers safe questions before that handoff.

## Behaviour

The helper accepts PuTTY `.ppk` text or bytes and validates the complete,
bounded metadata envelope:

- PPK version 2 or 3, a supported public-key algorithm, `none` or
  `aes256-cbc` encryption, bounded comments, public/private line counts, valid
  base64 bodies, and a version-appropriate hexadecimal `Private-MAC`. Encrypted
  v3 files also carry a bounded Argon2 metadata block, which is validated but
  never executed here.
- It returns counts and flags for private material, but never returns public or
  private body bytes. A comment is metadata and is returned for the site UI; it
  must not be copied into logs or diagnostics.
- PuTTY session settings can be supplied as newline-delimited `Name=Value`
  records or as a registry-style object. The result is a safe projection of
  host, port, protocol, algorithm lists, key paths, proxy settings, and
  connection booleans.

`normalizePuttyPath()` accepts a path, including a quoted Windows path or a
`%VARIABLE%` placeholder. It normalizes separators and `.`/`..` segments, but
rejects command-line fragments, shell metacharacters, control characters, and
unmatched environment markers. Algorithm normalizers accept only the
allowlisted PuTTY/WinSCP dialect and map known aliases to canonical names.

## Configuration and failure modes

All parsing functions return `{ ok: true, value }` or the generic
`{ ok: false, error: "Invalid PuTTY metadata." }`. A malformed header, duplicate
field, unsupported algorithm, invalid port, invalid path, oversized input, or
trailing data is rejected as a whole; callers must not use a partial result.
Unreadable files are rejected in the same way by `readPuttyKeyMetadata()`.
The parser is bounded to 1 MiB of input and 4,096 body lines so an imported
file cannot make the UI process an unbounded payload.

Unknown configuration keys are listed by name in `ignoredKeys` without their
values. Passwords, passphrases, private-key blobs, and other secret-looking
fields are omitted and listed only by key name in `redactedKeys`. Error results
never include the offending line, path, value, or secret.

The external PuTTY launcher uses the same metadata boundary as a preflight for
existing `.ppk` paths, refusing to spawn on malformed input while leaving
missing or non-PPK paths to the child process. See
[PuTTY private-key preflight](putty-key-preflight.md) for that production seam.

This is metadata validation, not trust validation. Host-key fingerprints still
need the host-key policy and an explicit user decision. A valid PPK envelope
does not prove that its owner or destination is trustworthy.

## Security considerations

PuTTY `.ppk` files can contain encrypted or unencrypted private material. Do
not log their contents, passphrases, comments without considering their
origin, or the returned key paths. Do not pass a passphrase through a command
line. The helper deliberately never opens a private key for use, never
decrypts it, and never returns body data. The caller must hand off only the
validated path and metadata to the credential-protection and SSH layers.

## Verification

Focused coverage lives in [`test/putty.test.js`](../../test/putty.test.js):

```text
node --test test/putty.test.js
```

The tests cover valid PPK v2/v3 metadata, encrypted-state reporting, malformed
and reordered headers, bounded file reads, path and algorithm normalization,
safe config projection, secret redaction, duplicate fields, and generic
failure results.

## Suggested articles

- [Host keys](host-keys.md) — verify the server separately from key-file metadata.
- [Credential storage](credential-storage.md) — how secrets are protected at rest.
- [Master password](master-password.md) — the fallback protection boundary.
