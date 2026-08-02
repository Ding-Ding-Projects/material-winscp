# Tabs and navigation

The application is browser-style tabs, not one long scrolling surface. Sessions,
the queue, the comparison checklist, the console, the notification centre, the
changelog and every settings surface are tabs in a persistent strip.

## Articles

| Article | Covers |
| --- | --- |
| [tab-strip.md](tab-strip.md) | Overflow, reordering, pinning and persistence. |
| [tab-groups.md](tab-groups.md) | Creating, naming, colouring, collapsing and moving between groups. |
| [tab-search.md](tab-search.md) | The four required tab-discovery searches, each with its own builder. |
| [bulk-close.md](bulk-close.md) | Close tabs containing / not containing text, with preview and pinned protection. |
| [tab-appearance.md](tab-appearance.md) | Per-tab and per-group appearance editing. |

## What persists

Tab order, pinned tabs and their order, groups, group order, group membership,
collapsed state, and per-tab and per-group appearance — all across restarts,
stored under `PREF_DEFAULTS.tabs`.

## Postman

Not applicable — this project exposes no HTTP API. See the
[documentation index](../README.md).

## Suggested articles

- [The appearance editor](../interface-and-appearance/appearance-editor.md) — the editor tabs and groups plug into.
- [Workspaces](../sessions-and-sites/workspaces.md) — saving a whole tab structure.
- [The regex builder](../search-and-regex/regex-builder.md) — attached to every tab search.
