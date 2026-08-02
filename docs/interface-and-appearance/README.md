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
| [notifications.md](notifications.md) | Corner toasts, the notification centre, and when a modal is correct. |
| [panels.md](panels.md) | Commander and Explorer layouts, columns, view styles and file colours. |

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
