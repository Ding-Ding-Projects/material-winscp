# Configuration migration

The main-process store keeps the current configuration in
`winscp-material.json`. A portable `WinSCP.ini` beside the app data is imported
once when the JSON store does not exist. Both paths write atomically.

## What it does

The loader imports portable WinSCP INI data when no JSON store exists, and
normalizes legacy JSON before the application exposes its sites. Site IDs and
protected secret storage are part of that normalization.

## Configuration

The current JSON store lives at the application data path. A portable
`WinSCP.ini` beside the app is read only as an import source when that JSON
store does not yet exist; the source INI is not rewritten.

## Legacy JSON

When loading older JSON, missing site IDs are generated and clear-text secret
fields are protected before the site is usable. If either migration is needed,
the normalized configuration is immediately written back. This means a legacy
password is not left clear on disk while waiting for the next user action.

Already protected `mp:` and `os:` values are preserved. A failed migration
write leaves the existing file in place and emits a configuration error; the
loader continues with the normalized in-memory state.

Site mutations also fail closed for malformed non-string secret values from
IPC or imported payloads: the value is discarded rather than causing a raw
`startsWith` error or being written as a credential.

## Failure modes

Malformed JSON is preserved as a timestamped `.corrupt-*` copy and the loader
reports an error instead of silently pretending the user's sites loaded.
If an atomic migration write fails, the in-memory normalized data remains
usable for the current run, while the error is emitted for the next repair.

## Security considerations

Plain-text passwords and other secret-bearing fields are never left in the
rewritten JSON. Do not put credentials in issue reports, logs or command-line
arguments; use the application's protected input paths.

## Verification

Focused coverage is in [`test/config-ini.test.js`](../../test/config-ini.test.js):

```text
node --test test/config-ini.test.js
```

The regression test verifies that loading a legacy clear-text password both
protects it in memory and persists the protected value and generated site ID.
It also verifies that add and update operations discard non-string password
values safely.

## Suggested articles

- [Sites and workspaces](../sessions-and-sites/)
- [Security and credentials](../security-and-credentials/)
