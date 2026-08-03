# Usage counters and startup facts

## What it does

`design/main/usage.js` is the small local state store for the `core/Usage` and
`core/Global` roadmap slice. It records bounded counters and the ordered
milestones of the most recent startup:

- `increment(name, amount)` records a non-negative local count. Names are
  restricted identifiers, there are at most 64 counters, and each value
  saturates at 1,000,000,000.
- `beginStartup({ mode, firstRun })` starts a new sequence and records the
  launch mode (`gui`, `command-line`, `installer`, `update`, or `unknown`).
- `markStartup(step)` appends a unique bounded milestone. Repeating a milestone
  is an idempotent no-op, so retries do not manufacture a false sequence.
- `completeStartup()` and `failStartup()` record only the outcome. The store
  counts successful, failed, and interrupted launches without saving an error
  message or an exception object.

The store is a main-process primitive. A caller supplies the app-owned JSON
path, which keeps it usable in portable mode and straightforward to test. It
does not change the renderer or IPC surface by itself.

## Persistence and reset

Every mutation writes a complete document to a sibling `.tmp` file and then
renames that file over the destination. If the write fails, the in-memory
mutation is rolled back and the temporary file is removed on a best-effort
basis. JSON object keys are sorted and the newline/indentation are fixed, so
the same state produces byte-for-byte identical output.

`load()` reads only the supported schema and ignores malformed or unsupported
state, exposing a short `loadError` code rather than retaining arbitrary input.
`exportState()` returns a defensive object copy. `exportJSON()` returns the
stable serialized document. `reset()` clears all counters and startup facts and
persists the empty schema immediately; it is not an opt-out or a network
deletion request.

## Privacy and security

This is local accounting, not telemetry. The module has no HTTP, socket,
analytics, update, or crash-report dependency and sends no events. It accepts
only bounded identifier names, booleans, an allow-listed mode, ordered
milestone identifiers, and integer counters. It intentionally does not accept
paths, hostnames, usernames, credentials, exception text, command lines, or
arbitrary metadata. The persisted document contains no sensitive data by
construction.

The JSON file is written with restrictive permissions where the platform
honours them. Atomic replacement protects against a truncated document after
a process interruption; it is not a replacement for the app's credential
protection, which remains the responsibility of `crypto.js`.

## Failure modes

| Situation | Behaviour |
| --- | --- |
| The file is absent | The store starts with empty counters and no startup outcome. |
| The file is malformed or has an unsupported shape/version | The store uses empty state and exposes `loadError`; it does not import arbitrary fields. |
| A counter name/value is invalid | The mutation throws before persistence and leaves the state unchanged. |
| A bound is reached | New counter names or startup steps are rejected; counter values saturate at the documented maximum. |
| An atomic write fails | The live state rolls back and the caller receives the write error. |
| `completeStartup()` or `failStartup()` is called twice | The second call returns `false` and does not double-count. |

## Verification

Run the focused suite with:

```text
node --test test/usage.test.js
```

The tests cover deterministic reloads, validation and cardinality bounds,
startup ordering and duplicate suppression, interrupted/failed outcomes,
defensive exports, reset, corrupt input, privacy filtering, and rollback after
an atomic-write failure.

## Related articles

- [The interface and appearance index](README.md)
- [Notifications](notifications.md) — user-facing startup failures remain visible UI events, not hidden telemetry.
- [Credential storage](../security-and-credentials/credential-storage.md) — secrets use the separate protected store and never enter this document.
