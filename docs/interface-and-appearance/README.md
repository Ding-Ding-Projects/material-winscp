# Interface and appearance

The whole interface is Material Design 3 — tokens, typography, shape, elevation
and motion. No legacy chrome survives anywhere. Data-encoding colours (chart
series, status swatches, file-colour rules) are exempt, because those are data
rather than decoration.

## Articles

| Article | Covers |
| --- | --- |
| [material-3.md](material-3.md) | The token system, themes, density and the live preview. |
| [appearance-editor.md](appearance-editor.md) | Per-element "Edit appearance…", Word-depth typography, presets and reset. |
| [colour-picker.md](colour-picker.md) | The infinite colour picker and the colour translator. |
| [overlays.md](overlays.md) | Shared anchored positioning, painted surfaces and viewport scrolling. |
| [notifications.md](notifications.md) | Corner toasts, persisted notification history, the notification centre, and when a modal is correct. |
| [panels.md](panels.md) | Commander and Explorer layouts, columns, view styles and file colours. |
| [panel-keyboard-selection.md](panel-keyboard-selection.md) | Keyboard focus, Insert selection, parent-entry protection, and the last-row boundary. |
| [error-contract.md](error-contract.md) | Classified failures, safe causes, retry/skip/abort decisions and IPC-safe facts. |
| [message-resources.md](message-resources.md) | Extracted WinSCP wording, positional and named formatting through IPC, and argument safety. |
| [usage-and-startup.md](usage-and-startup.md) | Bounded local usage counters, startup milestones, persistence, reset and privacy boundaries. |
| [preferences.md](preferences.md) | The preference schema, production-consumer audit, live writes, and honest unavailable rows. |
| [configuration-import-export.md](configuration-import-export.md) | Atomic JSON backups, production-reachable WinSCP INI import/export, hierarchy mapping, and credential handling. |
| [configuration-roots.md](configuration-roots.md) | Portable and environment-resolved WinConfiguration extension roots. |
| [winapi-boundary.md](winapi-boundary.md) | Cross-platform path, display, keyboard, shell, and unsupported-operation boundaries. |
| [local-drive-view.md](local-drive-view.md) | Commander local drive roots, UNC share reveal, keyboard navigation and refresh behaviour. |
| [window-geometry.md](window-geometry.md) | Safe display metrics, minimum sizing and reachable restored window bounds. |
| [properties-rights.md](properties-rights.md) | Defensive permission metadata parsing, editing failure semantics and accessibility. |
| [symlink-dialog-validation.md](symlink-dialog-validation.md) | Safe link-name validation and target/path separation. |

## The two rules that decide everything here

1. **Every rendered element is customizable**, and the editor for it opens
   anchored beside that element. A global theme alone does not satisfy this; nor
   does an editor that cannot theme its own dialog.
2. **Anything that only informs is a corner notification.** Modals are reserved
   for decisions the user must make before continuing — overwrite prompts, host
   key changes, destructive confirmations.

## Postman

Not applicable — this project exposes no HTTP API. See the
[documentation index](../README.md).

## Suggested articles

- [Tabs and navigation](../tabs-and-navigation/) — tabs are appearance targets too.
- [Accessibility and languages](../accessibility-and-languages/) — the constraints every surface here obeys.
- [Search and regex](../search-and-regex/) — every settings surface carries a search bar.
