# Context-menu shortcuts

Every context-menu item that has a keyboard shortcut displays it at the right
edge of the item. The shared renderer in
`design/renderer/ui/contextmenu.js` is the single normalization path for both
action-backed descriptors and hand-written providers.

## What is shown

The action registry remains authoritative for the shortcut that actually runs.
When a descriptor supplies an `action`, `actionId`, or `command` but no literal
shortcut, the menu resolves that action through `ui/commands.js`. A literal
`shortcut` is accepted for a local operation such as an editor command, but it
uses the same formatter. This prevents a context menu from silently drifting
away from the keyboard handler.

Focused row actions are resolved with the same side-aware action registry. If a
focused handler has no duplicated accelerator, the menu checks only its exact
registered counterpart (for example,
`CurrentCopyToClipboardFocusedAction2` → `CurrentCopyToClipboardAction2`). It
does not infer a shortcut from the label or borrow one from the opposite panel.
This keeps a right-click on the local panel and one on the remote panel tied to
the action that actually owns the shortcut.

The display formatter canonicalizes WinSCP names before rendering:

| Registry value | Windows/Linux display | macOS display |
| --- | --- | --- |
| `Alt+Left` | `Alt` + `←` | `⌥` + `←` |
| `Ctrl+Num +` | `Ctrl` + `Num+` | `⌃` + `Num+` |
| `Ctrl+Enter` | `Ctrl` + `↵` | `⌃` + `↵` |
| `Meta+S` | `Win` + `S` (Windows), `Super` + `S` (Linux) | `⌘` + `S` |

The visible glyphs are accompanied by `aria-keyshortcuts` using canonical key
names, and the `<kbd>` group has an accessible label. This means a screen
reader gets `Alt+ArrowLeft` while a sighted Windows user sees `Alt+←`.

## Layout and state

Shortcut content is a non-shrinking right-hand column. The label region may
ellipsis when space is tight, and the menu width is capped to the viewport so
long English/Cantonese or bilingual labels cannot push the shortcut off-screen.
Submenu arrows, disabled state, checked/radio state, and the menu roles remain
owned by the existing renderer; shortcut normalization only adds metadata.

## Verification

Run the focused regression suite:

```text
node --test test/contextmenu.test.js
```

It audits the real file/panel context providers, both declarative menu trees,
all direct shortcut literals in registered provider modules, action fallback,
special keys, accessibility metadata, and the narrow-layout contract.

This repository has no HTTP API, so no API collection applies to this feature.
