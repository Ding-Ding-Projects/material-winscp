# Panel keyboard selection

The Commander and Explorer file panels use one selection model for pointer and
keyboard commands. `Insert` toggles the focused file and advances to the next
row when one exists. At the end of a directory it stays on the last row and
toggles that row; it never wraps or toggles a neighbouring file.

## Behaviour

- `Insert` is available from the focused, keyboard-reachable file grid.
- The parent entry (`..`) is never selected.
- The last row is a real boundary: focus remains there and the row itself is
  the one whose selection changes.
- The selected row exposes `aria-selected`, while the focused row remains
  keyboard-visible through the grid's active descendant/focus styling.

## Failure mode and security

Before this fix, the renderer advanced focus first and then inferred the old
row from the new focus. Because focus clamps at the end of a listing, pressing
`Insert` on the last row selected the preceding file. That could make a later
delete, copy, or transfer act on a file the user did not mark. The fix captures
the focused index before moving and does not advance when already at the end.

## Verification

`test/e2e-panel-keyboard.test.js` boots the real Electron app, navigates the
real local Commander panel to a temporary directory, sends `End` and `Insert`
through the actual grid listener, and asserts the focused and selected DOM
rows. The test also exercises the last-row boundary where the defect occurred.

## Suggested articles

- [Panels](panels.md) — layouts, filtering, columns, and file colours.
- [Accessibility and languages](../accessibility-and-languages/) — keyboard and
  screen-reader rules shared by every surface.
- [The regex builder](../search-and-regex/regex-builder.md) — the builder
  attached to the panel filter.
