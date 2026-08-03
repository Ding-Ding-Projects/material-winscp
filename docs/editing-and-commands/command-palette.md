# Command palette

## What it is

The command palette is the keyboard route to the renderer shell. Press
`Ctrl+Shift+P`, choose the magnifying-glass action in the title bar, or invoke
`app.commandPalette` from another registered command. It snapshots the live
shell registry when opened, so commands added by dialogs, the queue, panels or
the WinSCP action layer appear in the same list.

The palette also indexes every page and control declared in the Preferences
schema. A page row opens that page; a setting row opens the exact page, focuses
the concrete editor inside the row, and flashes the exact control briefly. It does not maintain a second preference
value and it never writes a setting itself — the real Preferences control owns
validation, persistence, unavailable-state handling and version-history labels.

## Search and selection

- Plain text is the default.
- The `.*` control opens the full anchored JavaScript `RegExp` builder for this
  palette only. Query, pattern, flags and mode persist under
  `search.command-palette`.
- Search fields include command labels, registered IDs, categories, shortcuts,
  setting labels, page/section names and non-secret setting values.
- Master-password and other secret values are not rendered or indexed.
- Arrow keys move the visible option, `Home`/`End` jump to its boundaries,
  `Enter` runs it, and `Escape` closes the surface and restores focus.
- If the palette closes before its initial focus runs, that deferred focus is
  canceled and never targets the detached search field.
- Changing the query resets the active option to the first matching result, so
  an index from the previous result set cannot select an unexpected command.
- Shortcut metadata is normalized at the command boundary, so stored spellings
  such as `Ctrl + F3` and `Cmd+Shift+L` resolve the same way as live keyboard
  events. This keeps native-menu and palette actions from becoming inert when
  their display formatting includes spaces or uses `Cmd`.

## Size and accessibility

The default is a bounded card. The size control switches to a full-window view,
and the choice persists as `commandPalette.size` through the renderer's normal
configuration writer. Both views are keyboard reachable, expose a labelled
listbox and live result count, keep visible focus, and clamp their layout for
narrow windows and high display scale.

## Honest boundary

The palette currently provides destination rows for settings rather than
duplicating every switch, text field, select and stepper inline. That is
intentional: duplicating controls would create a second validation and
persistence path. Inline live controls, site-properties destinations and
appearance-editor property destinations remain roadmap work; the exact
Preferences teleport is the shipped seam that keeps those gaps discoverable.
Even a preference that is unavailable in this build remains a keyboard-
reachable destination: its row is labelled unavailable and opens the exact
Preferences control, where the canonical explanation and disabled state live.

## Verification

- `test/commandpalette.test.js` checks that the inventory retains every
  registered command, includes the Preferences page/control destinations and
  excludes secret values.
- `test/e2e-app.test.js` exercises the real Electron shortcut, search field,
  regex-builder affordance, size persistence and exact Preferences landing.
- `node site/build.js --verify` confirms this article and its index entry are
  rendered by the documentation site.
