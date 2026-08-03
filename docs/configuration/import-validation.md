# Configuration import validation

Configuration backups are validated before they can replace live sites or
preferences. JSON backups must contain valid JSON and a top-level object; a
malformed file produces a configuration-specific error and leaves the current
configuration untouched. WinSCP `.ini` files continue through the separate
site-only importer, which validates that at least one stored session exists.

The JSON parser error is retained as `error.cause` for diagnostics, while the
user-facing message identifies the selected file as invalid configuration data.
Import does not partially apply a malformed file, and no secret is included in
the error text beyond the parser's local syntax detail.

The JSON store also validates collection shapes. A startup file with malformed
folders, workspaces, or individual site records drops only those unusable
records, rewrites the normalized collections, and keeps valid sites manageable.
An explicit JSON import is stricter: a malformed field or record is rejected
transactionally so the live configuration remains unchanged. Workspace session
lists are normalized to records, and invalid direct mutation inputs are refused
before they can poison the store.

Site IDs are durable identities: malformed or colliding IDs receive a fresh ID
when a site is loaded or added, and an update cannot reassign an existing ID.
Host-key trust state is part of the JSON backup and is validated as an object;
INI import remains site-only and does not replace it.

Focused verification:

```powershell
node --test test/config-ini.test.js
```

WinSCP INI export refuses duplicate session names, including case variants,
instead of silently replacing one section with another. INI import accepts the
usual case-insensitive `Sessions\` section spelling and rejects duplicate names
before changing the site list.
