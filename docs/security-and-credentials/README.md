# Security and credentials

Everything about proving who the server is, proving who you are, and keeping the
proof safe on disk.

## Articles

| Article | Covers |
| --- | --- |
| [host-keys.md](host-keys.md) | SSH host key and TLS certificate verification, and the trust store. |
| [credential-storage.md](credential-storage.md) | How a saved secret is protected — and when it is refused rather than stored. |
| [master-password.md](master-password.md) | The master password, its derivation, and what it does and does not cover. |
| [file-encryption.md](file-encryption.md) | At-rest encryption of transferred files. |
| [logging.md](logging.md) | Session logs, redaction, and what debug levels expose. |

## The three rules

1. **A secret is protected or it is not stored.** `design/main/crypto.js` wraps
   secrets with the OS keychain, or with a scrypt-derived key when a master
   password is set. If neither is available the secret is **not written** and the
   app asks each time. There is no "store it in plain text just this once".

2. **Trust decisions are explicit, pinned, and re-asked when they change.** Host
   keys and certificates are stored by fingerprint in `hostkeys.json`. A change
   stops the connection and asks — including, especially, during an automatic
   reconnect.

3. **Encryption is never silently downgraded.** Selecting an unencrypted
   protocol warns. Falling back from an encrypted protocol to an unencrypted one
   is offered, never performed automatically.

## Reporting a vulnerability

See [`SECURITY.md`](../../SECURITY.md) in the repository root.

## Postman

Not applicable — this project exposes no HTTP API. See the
[documentation index](../README.md).

## Suggested articles

- [Sessions and sites](../sessions-and-sites/) — where credentials are entered and stored.
- [Protocols](../protocols/) — the per-protocol security options.
- [Version history](../version-history/) — which snapshots encrypted data as ciphertext, never plaintext.
