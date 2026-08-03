# Named-object registry

`design/main/named-objects.js` is the lifecycle boundary for in-process objects
that need a stable name while a session, queue item, operation or renderer
bridge is alive. It is intentionally a registry of references, not a second
data store.

## Behaviour

- The supported kinds are `session`, `queue-item`, `operation` and `ui-bridge`.
- Names are bounded identifiers. Names are unique across all kinds in one
  registry. A collision either fails with `NAME_COLLISION` or receives the
  lowest available `-2`, `-3`, … suffix.
- Names omitted by callers are deterministic per kind (`session-1`, then
  `session-2`, for example). The registry has a configurable entry limit and
  rejects new entries before exceeding it.
- `register()` returns a lease. Calling `lease.dispose()` removes the entry;
  disposal is idempotent and subsequent lookup returns `undefined`.
- `ownership: 'explicit'` (the default) means the lease or
  `disposeOwner(owner)` is the lifecycle authority. The registry does not keep
  a strong reference to the owner.
- `ownership: 'weak'` requires an object owner. Owner collection removes its
  weakly owned entries when the runtime reports it. Weak ownership also makes
  the value weak by default; pass `weak: false` when the owner should govern a
  strongly held value. `sweep()` and ordinary lookup remove dead weak values
  without depending on garbage-collection timing.
- `find()` returns live values in lexical name order. Kind and owner filters are
  available, so callers do not depend on insertion order.

## Serialization and security

`identifiers()` and `serialize()` expose only `{ name, kind }`, sorted by name.
They never include object values, owners, credentials, paths, timestamps or
arbitrary metadata. The output is suitable for diagnostics and restoring a
list of identifiers, but it is not a persistence format for the objects
themselves. Values must be recovered through an in-memory lookup while their
leases remain valid.

The registry is bounded and accepts identifier-shaped names only. It does not
evaluate names, invoke values, retain owner objects, or write to disk.

## Verification

Run the focused contract tests:

```text
node --test test/named-objects.test.js
```

The tests cover all four kinds, deterministic generated names and lookup,
collision policies, bounded capacity, weak and explicit ownership, disposal,
stale-reference removal, and identifier-only serialization.

This project has no HTTP API, so no API collection applies to this feature.
