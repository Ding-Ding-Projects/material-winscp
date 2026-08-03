# Bookmarks and location profiles

## What it does

Bookmarks are named local/remote directory pairs. A bookmark can contain only
one side when that is useful for a local or remote path menu, or both sides for
a location profile that restores the two-panel view together. Bookmarks are
grouped into optional folders (`node`), retain the order chosen by the user,
and can carry one keyboard shortcut from `1` through `65535` (`0` means no
shortcut).

The model lives in `design/main/bookmarks.js`. It has two scopes:

| Scope | Key | Purpose |
| --- | --- | --- |
| Shared | `_!_shared` | Available for every session. |
| Site | WinSCP `SessionKey` | A list for one `user@host[:port]`; the port is present only when it is not that protocol's default. |

The site key deliberately comes from `sessiondata.sessionKey`, not from the
whole saved session. Passwords, passphrases, host keys and advanced options
never become bookmark identity or bookmark data.

## Configuration and ordering

`BookmarkList` is an ordered collection. `add`, `insert`, `move`, `moveTo`,
`update`, `rename` and `remove` are the mutation operations; `findByName` and
`findByShortcut` are the lookup operations. `shortcuts()` returns the occupied
non-zero shortcuts in the current bookmark order, matching WinSCP's
`TBookmarkList::ShortCuts` behavior. Folder/name identity is
case-insensitive, matching WinSCP. A folder name uses `/` between segments;
bookmark names cannot contain either path separator, a control character or a
numeric-only name.

The default duplicate policy is **reject**. Callers that are importing or
merging data can choose `skip`, `replace` or `rename` explicitly. Replacement
keeps the existing position; renaming adds ` (2)`, ` (3)`, and so on until the
name is unique. Non-zero keyboard shortcuts are unique within a list.

Persistence uses a versioned, secret-free JSON object:

```json
{
  "schema": "material-winscp.bookmarks",
  "version": 1,
  "lists": {
    "_!_shared": {
      "version": 1,
      "bookmarks": [
        { "name": "Release", "local": "C:\\release", "remote": "/srv/release", "node": "Production", "shortcut": 0 }
      ],
      "openedNodes": ["Production"]
    }
  }
}
```

`serialize()` emits only the allow-listed fields, in a deterministic scope
order. `Bookmarks.fromJSON()` and `BookmarkList.fromJSON()` reject malformed
JSON, unknown schema versions, invalid paths, duplicate identities and
duplicate shortcuts by default. The legacy top-level `bookmarks` array is
accepted as the shared list so a caller can migrate an earlier flat export.

## Failure modes

| Situation | Result | Recovery |
| --- | --- | --- |
| Empty, numeric-only or path-like bookmark name | Validation error with `INVALID_BOOKMARK_NAME`. | Choose a descriptive name and try again. |
| Folder contains `..`, an empty segment or a backslash | Validation error with `INVALID_BOOKMARK_FOLDER`. | Use a normalized `/`-separated folder path. |
| Same name and folder already exists | `DUPLICATE_BOOKMARK`; no mutation occurs. | Reject, skip, replace or rename explicitly at the import boundary. |
| Shortcut is already used in the list | `DUPLICATE_BOOKMARK_SHORTCUT`; no mutation occurs. | Pick another shortcut or clear it with `0`. |
| Stored JSON is truncated, tampered with or from a newer version | `BookmarkSerializationError`; no partial list is returned. | Keep the last good configuration and migrate with code that understands the newer schema. |
| A session has no explicit port | The site scope uses the protocol's default-port rule from `SessionKey`. | The same session key is produced again when the session reconnects. |

## Security considerations

- A bookmark stores paths and labels, not credentials.
- Site scope uses `user@host[:port]` only. It does not use a URL, password,
  passphrase, host key, token or serialized `SESSION_DEFAULTS` object.
- JSON parsing is allow-listed: unknown bookmark properties are ignored when a
  record is loaded and are never emitted again.
- Control characters and path traversal segments are refused before they reach
  the configuration file or a menu label.
- The bookmark model is in-memory and persistence-safe; the configuration
  owner remains responsible for atomic file writes and for offering each
  mutation to version history, just as it does for sites and workspaces.

## Verification

Run the focused suite with:

```text
node --test test/bookmarks.test.js
```

The tests cover validation, case-insensitive identity, insertion and move
ordering, duplicate policies, shortcut conflicts, immutable updates, opened
folder state, deterministic round trips, malformed/versioned data, legacy
loading, per-session scope derivation and the absence of secrets from output.

## Location-profile duplication

The Location Profiles dialog can duplicate the selected profile with the
`Duplicate` button or <kbd>Ctrl+D</kbd> (<kbd>Cmd+D</kbd> on macOS). The copy
stays in the same one-level folder, is inserted immediately after the source,
and receives a collision-free ` (copy)` name with a numeric suffix when needed.
Shortcuts are intentionally cleared so duplication cannot steal an existing
shortcut. The operation is persisted through the same profile preference and
history path as the other profile mutations.

## Suggested articles

- [The site manager](site-manager.md) — saved connection identity and folders.
- [Session information](session-info.md) — the secret-free live session snapshot.
- [Workspaces](workspaces.md) — restoring several sessions and their paths.
- [The regex builder](../search-and-regex/regex-builder.md) — searching a site or bookmark list safely.
