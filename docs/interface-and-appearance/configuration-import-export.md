# Configuration import and export

The live configuration bridge supports two file formats:

| Extension | Format | Scope |
| --- | --- | --- |
| `.json` | WinSCP Material backup | Preferences, sites, folders and workspaces. Stored credentials remain protected ciphertext. |
| `.ini` | WinSCP-compatible session store | Sites and their folder hierarchy. Application preferences and workspaces remain unchanged. |

Both formats are reached through the existing Login and Preferences tools:
the selected path is passed over `config:export` or `config:import`, and the
main-process `Config` store chooses the serializer from the path and content.
The INI path is therefore production-reachable; it is not only a parser used by
the import dialog.

## WinSCP INI interoperability

Sessions are written under `[Sessions\\<folder>/<name>]`, using WinSCP's
defaults-vs-explicit option rules and its percent/BOM escaping. Import accepts
the same sections, reconstructs nested folders, and encrypts a portable
`PasswordPlain` value before placing it in the app store. A `[Sessions\\Default
Settings]` block is understood by the core serializer, but this application has
no separate per-site default-settings object, so it is not applied to the JSON
preferences.

Blank or malformed numeric values are treated as absent during import and keep
the supplied WinSCP factory default; in particular, an empty floating-point
value is never coerced to zero by JavaScript's numeric conversion.

The session serializer also enforces the textual INI boundary for raw string
options: programmatic import maps are normalized to strings before assignment,
so a typed value cannot turn a command or other raw setting into a number or
boolean in the session model.

The import replaces the stored site and folder collections, matching the
session-store meaning of a WinSCP configuration import. It does not replace
application preferences or workspaces because those have no lossless WinSCP
INI representation. Empty folders that contain no site are not representable
in WinSCP's session sections and are not recreated.

## Security boundary

INI is a portable interchange format, not a safe place for this application's
encrypted values. Exports omit password, passphrase, proxy, tunnel, file-key
and S3-token fields entirely. An encrypted `Password=` from another Windows
profile is rejected as a credential rather than imported as gibberish. Only an
explicit `PasswordPlain=` can be imported, and it is immediately re-protected
by `crypto.js`; when no OS or master-password protection is available it is
discarded rather than written in clear.

## Verification

- `test/config-ini.test.js` covers folder-aware export, secret omission,
  plaintext-password protection, machine-ciphertext rejection, and automatic
  migration from `winscp-material.ini` beside app data.
- `test/sessiondata.test.js` covers the lower-level INI option and hierarchy
  serializer, including default-vs-explicit values and typed raw-string input.
- The JSON path remains covered by the existing configuration and Electron
  import/export flows.

The store remains one atomic JSON file for normal operation. An INI discovered
beside app data is imported once at startup and then migrated into that JSON
store, so a crash cannot leave a half-written configuration.

Malformed persisted collection types are normalized at startup: valid site
records survive, unusable folder/workspace entries are removed, and the cleaned
collections are rewritten. Explicit JSON imports reject malformed collection
fields transactionally. INI export also refuses duplicate session names (case
insensitive) because the WinSCP section format cannot represent both without
silently losing one.

JSON backups are treated as untrusted input at the same boundary: loading an
older backup or importing a backup re-normalizes every session secret. Tagged
`mp:` and `os:` ciphertext is retained, while clear-text values are immediately
protected when platform protection is available and otherwise discarded. This
prevents a hand-edited or legacy backup from turning the durable store into a
clear-text credential file.

Legacy or hand-edited JSON sites that omit an `id` receive a generated site ID
during load/import. This matters because the ID is the address used by update,
move, and delete operations; without it a site could be displayed but not
managed.

## Import failure behavior

An import is transactional in the running GUI: JSON imports restore preferences,
sites, folders and workspaces if the durable write fails; INI imports restore
sites and folders. The failure is then returned to the caller, and no
`changed`/`sites-changed` event or history revision is emitted for the rejected
import. This keeps a failed disk operation from leaving the visible session
manager out of sync with the stored configuration.
