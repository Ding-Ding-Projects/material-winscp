# Sessions and sites

A **site** is saved connection data. A **session** is a live connection made
from one. A **workspace** is a set of sessions restored together. This category
covers all three, plus the machinery that gets you connected: session URLs,
tunnels, proxies and automatic reconnection.

## Articles

| Article | Covers |
| --- | --- |
| [site-manager.md](site-manager.md) | Sites, folders, colour tags, import/export and the session URL format. |
| [import-sessions.md](import-sessions.md) | Bounded PuTTY/KiTTY, FileZilla, OpenSSH, WinSCP INI and known_hosts imports, including UTF-8 session-name compatibility. |
| [bookmarks.md](bookmarks.md) | Ordered shared and per-site local/remote location profiles, duplicate policies and safe JSON persistence. |
| [session-info.md](session-info.md) | Secret-free protocol, endpoint, display and live-session information snapshots. |
| [session-dialog.md](session-dialog.md) | Bounded endpoint validation, secret-free dialog state, and stale-reconnect-safe close lifecycle. |
| [site-advanced-settings.md](site-advanced-settings.md) | Per-site advanced settings, capability-gap handling, secret-safe persistence, and timezone offset validation. |
| [terminal-lifecycle.md](terminal-lifecycle.md) | Foreground operation ownership, cancellation, reconnect backoff/budgets, prompt refusal, and directory-cache invalidation. |
| [named-objects.md](named-objects.md) | Bounded names for sessions, queue items, operations and UI bridges, with weak or explicit ownership and identifier-only export. |
| [workspaces.md](workspaces.md) | Saving and restoring sets of sessions, and the auto-workspace. |
| [tunnels-and-proxies.md](tunnels-and-proxies.md) | SSH tunnels, every proxy method, and how they compose. |
| [reconnection.md](reconnection.md) | Automatic reconnect, stall detection and idle handling. |

## Where the data lives

One JSON file, written atomically (temp file, then rename), at
`winscp-material.json` under the app's data directory — `paths.js` is the single
place that decides where that is. An INI export exists for WinSCP
interoperability, and neither format ever contains a secret in clear.

Sites, folders and workspaces are user-managed records, so every create, edit
and delete is offered to [version history](../version-history/). Deleting a site
by mistake is undoable, and so is the undo.

## Postman

Not applicable — this project exposes no HTTP API. See the
[documentation index](../README.md).

## Suggested articles

- [Security and credentials](../security-and-credentials/) — what happens to a saved password.
- [Protocols](../protocols/) — the per-protocol half of a site's configuration.
- [Version history](../version-history/) — the undo behind every site edit.
