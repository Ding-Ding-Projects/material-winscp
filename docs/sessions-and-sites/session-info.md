# Session information

## What it does

`design/main/sessioninfo.js` is the JavaScript port of the reusable information
models in `core/SessionInfo.h/.cpp`: `SessionInfo` describes a configured or
live connection, while `FileSystemInfo` describes the negotiated protocol,
server and capabilities. It is a snapshot seam between `sessiondata.js`,
`defaults.js`, `config.js` and a live `Session`.

The model covers the identity a current tab needs without copying the whole
site record:

- protocol id, base protocol, secure protocol name and security protocol;
- host, effective port, user, endpoint and stable session key;
- site/session display name, folder, colour, note and local/remote paths;
- lifecycle status, connection state, login/open timestamps, server facts and
  adapter capabilities; and
- the negotiated ciphers, compression, SSH, host-key and certificate fields
  represented by upstream `TSessionInfo`.

## Configuration

The source of truth remains `SESSION_DEFAULTS` and `sessiondata.js`. Use
`SessionInfo.fromSessionData(data)` for resolved data, `SessionInfo.fromConfig`
for a `Config`-shaped store, or `SessionInfo.fromSession(liveSession)` for the
existing `Session` object. The last form reads the existing `state` and
adapter; it does not add an IPC channel or change the renderer bridge.

When a live adapter reports a peer certificate in `serverInfo.certificate`, the
snapshot copies only its public certificate identity (fingerprints and sanitized
metadata). This keeps the negotiated certificate visible to diagnostics through
the existing `Session.info()` path without exposing client credentials or key
material.

`FileSystemInfo` accepts the existing `Session.fileSystemInfo()` result and
keeps protocol, server and capability fields in the same snapshot family.

## Stable serialization

`serialize()` returns canonical JSON. The version is currently `1`; nested
objects are key-sorted so adapter insertion order cannot produce noisy
snapshots. `fromJSON()` rejects malformed or unsupported versions rather than
silently guessing a schema.

Passwords, passphrases, tokens, private keys and credential-shaped fields are
omitted recursively. This is intentional: a session information snapshot is
safe for tabs, diagnostics and future IPC, while the resolved session record
may still contain secrets in memory for the adapter.

## Failure modes

| Situation | Behaviour |
| --- | --- |
| Missing port | Uses `sessiondata.defaultPort` for the selected protocol and FTPS mode. |
| IPv6 host | Brackets the host in the display endpoint, e.g. `[2001:db8::7]:2222`. |
| Unknown protocol | Preserves its id and uses an uppercase fallback identity; it does not pretend it is SFTP. |
| Missing config site | `fromConfig` returns `null`; it never creates a phantom session. |
| Invalid serialized data | `fromJSON` throws a descriptive error and does not return partial state. |
| Secret-shaped server metadata | It is omitted from the snapshot. |

## Security considerations

The model deliberately does not serialize the session-data option set. In
particular, credentials are not needed for display and never cross this
boundary. Certificate and host-key fingerprints are connection facts, not
credentials, and remain available for diagnostics; arbitrary server metadata
is recursively filtered for credential-shaped keys.

## Verification

`test/sessioninfo.test.js` covers all configured protocols, secure variants,
protocol-aware default ports, IPv6 display, default and explicit names, live
session snapshots, config lookup, secret omission, canonical round trips,
version rejection and the `FileSystemInfo` capability model.

## Suggested articles

- [Site manager](site-manager.md) — where session data is stored and edited.
- [Adapter contract](../protocols/adapter-contract.md) — the protocol backend
  facts surfaced by `FileSystemInfo`.
- [Credential storage](../security-and-credentials/credential-storage.md) —
  why resolved secrets never belong in a session-information snapshot.
