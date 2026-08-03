# Command palette

## What it is

The command palette is the keyboard route to the renderer shell. Press
`Ctrl+Shift+P`, choose the magnifying-glass action in the title bar, or invoke
`app.commandPalette` from another registered command. It snapshots the live
shell registry when opened, so commands added by dialogs, the queue, panels or
the WinSCP action layer appear in the same list.

The palette also indexes every page and control declared in the Preferences
schema, every Advanced Site Settings page/control, and every appearance-editor
property in each editor state. A page row opens that page; a setting row opens
the exact page, focuses the concrete editor inside the row, and flashes the
exact control briefly. Advanced Site Settings destinations focus their exact
control, while appearance destinations open the editor at the requested state
and property. Safe
primitive settings (`check`, `text`, `path`, `number`, `select` and `slider`) also
render their live control inline. Those controls use the same schema renderer,
range normalization, mask validation and configuration writer as Preferences;
secret, dangerous, unavailable and multi-step controls remain destination-only.

## Search and selection

- Plain text is the default.
- The `.*` control opens the full anchored JavaScript `RegExp` builder for this
  palette only. Query, pattern, flags and mode persist under
  `search.command-palette`.
- Search fields include command labels, registered IDs, categories, shortcuts,
  setting labels, page/section names and non-secret setting values.
- Master-password and other secret values are not rendered or indexed.
- Arrow keys move the visible option, `Home`/`End` jump to its boundaries,
  `Enter` runs it, and `Escape` closes the surface and restores focus. While
  focus is inside an inline editor, its native keys remain its own; Escape from
  a non-empty palette query clears the query before the palette closes.
- Enter commits a focused text, path or number control before leaving the row;
  closing while one is dirty commits it too, matching Preferences' immediate
  write behaviour. A successful write restores the edited control and caret
  after the live palette inventory refreshes.
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
configuration writer. Both views are keyboard reachable, keep focus within the
surface, expose a labelled result list and live result count, keep visible
focus, and clamp their layout for narrow windows and high display scale.

## Honest boundary

Inline editing is deliberately limited to schema controls whose existing
renderer can be mounted safely in a compact row. Pending capabilities, secret,
dangerous values, master-password flows and custom editors remain destination-only: their
row is labelled unavailable or protected and opens the exact Preferences control,
where the canonical explanation and multi-step validation live. The extra
destination inventory is navigation metadata only; it does not duplicate or
mutate either settings implementation.

Closing a palette flushes its current query, regex pattern, flags and mode before
the search field is detached, so a quick open–type–close cycle does not discard
the user's search.

## Verification

- `test/commandpalette.test.js` checks that the inventory retains every
  registered command, includes Preferences, Advanced Site Settings and
  appearance-property destinations, identifies safe inline controls and
  excludes secret values; it also covers keyboard ownership boundaries and
  exact destination arguments.
- `test/e2e-app.test.js` exercises the real Electron shortcut, search field,
  regex-builder affordance, size persistence and exact Preferences landing.
- `node site/build.js --verify` confirms this article and its index entry are
  rendered by the documentation site.
