# Panels, layouts and file colours

## What it does

The file browser itself. Two layouts, as in WinSCP:

- **Commander** — local and remote side by side, the classic two-pane layout.
- **Explorer** — a single remote pane with a directory tree, closer to Windows
  Explorer.

`interface` (default `commander`) selects between them, live, without a restart.

On first launch the local side reads the actual local directory and the remote
side has no invented listing: without an attached session it shows a truthful
no-session message such as **This tab has no session open.** and a **New
connection** action. A remote directory becomes listable only after a real
session is attached; a mock server tree is never used as startup content.

## Configuration

### Layout

| Option | Default | Meaning |
| --- | --- | --- |
| `interface` | `commander` | `commander` or `explorer`. |
| `scpCommander.localPanelWidth` | `0.5` | Split position, as a fraction. |
| `scpCommander.swappedPanels` | `false` | Remote on the left. |
| `scpCommander.treeOnLeft` | `false` | Directory tree position. |
| `scpCommander.compareByTime` / `compareBySize` | `true` / `false` | Criteria for the panel comparison highlight. |
| `scpCommander.preserveLocalDirectory` | `false` | Keep the local directory when changing sessions. |
| `window.pathInCaption` | `short` | `full`, `short`, `none`. |

### Presentation

| Option | Default | Meaning |
| --- | --- | --- |
| `panel.viewStyle` | `report` | `icon`, `smallIcon`, `list`, `report`, `thumbnail`. |
| `panel.thumbnailSize` | `96` | |
| `panel.fullRowSelect` | `true` | |
| `panel.explorerStyleSelection` | `false` | |
| `panel.naturalOrderNumericalSorting` | `true` | `file2` before `file10`. |
| `panel.alwaysSortDirectoriesByName` | `false` | |
| `panel.incrementalSearch` | `typing` | `off`, `typing`, `ctrl`. |
| `panel.showFullPathOnAddressBar` | `false` | |
| `panel.hiddenAsNormal` | `false` | Show hidden files without the dimmed style. |
| `showHiddenFiles` | `false` | Show them at all. |
| `formatSizeBytes` | `short` | `none`, `kilo`, `short`. |
| `showInaccessibleDirectories` | `true` | List directories that cannot be entered. |

### Columns

Name, Size, Type, Changed, Rights, Owner, Group, Attr, Ext, Link target. Each can
be shown, hidden, reordered and resized; the layout is saved per panel and
restored with the [workspace](../sessions-and-sites/workspaces.md). Columns a
protocol cannot fill show an explicit blank, never a fabricated value.

### File colours

`fileColors` is a list of `{mask, color, dark}` rules. The first matching
[mask](../editing-and-commands/file-masks.md) colours the row — build output in
grey, secrets in red, whatever the user finds useful.

**These are data colours and are exempt from the Material theming rules**, in the
same way chart series are. They are chosen with the same
[colour picker](colour-picker.md), and each rule carries a separate colour for
light and dark so a rule stays legible in both.

### Filter and search

Each panel has a filter field with the
[regex builder](../search-and-regex/regex-builder.md) anchored beside it. An
active filter is stated in the panel status bar with its text, because a
forgotten filter looks exactly like missing files — the single most common
support question this feature generates.

### Action state and panel routing

The Commander-only **Local panel** and **Remote panel** entries in Options are
hidden when the tab is using Explorer. Their parent entries are panel-focus
actions, not preferences that can be applied to a one-panel interface, so they
never appear as clickable no-ops in the Explorer command palette.

The **Other directory** action is enabled only when both panels exist and both
ends are usable. In particular, the local action is disabled while the remote
session is disconnected; it must not navigate one side and imply that the
other side followed it. The action maps separators only after that state check.

The local **Root** action preserves UNC semantics: `\\server\\share\\folder`
goes to `\\server\\share`, while a drive path goes to its drive root. It never
falls back to the process root `\\` for a UNC path.

### Drag and drop

Commander and Explorer panel drops preserve the source paths captured when the
gesture starts, validate the private payload before using it, and route desktop
drops through the main Explorer policy. A disconnected session, missing target,
unavailable upload capability or self-drop is announced instead of disappearing
as a no-op. See [Drag and drop](../editing-and-commands/drag-drop.md) for the
move/copy preference and keyboard alternatives.

## Failure modes

| Situation | What the user sees | Recoverable |
| --- | --- | --- |
| A filter is active and the user forgets | The status bar states the filter and offers to clear it. It is not a subtle icon. | Yes |
| Directory with 100,000 entries | The list virtualizes; sorting and filtering stay responsive. Counts are exact, not sampled. | n/a |
| Column the protocol cannot fill | Blank. Not `0`, not `-`, not a guess. | n/a |
| Inaccessible directory | Listed and marked when `showInaccessibleDirectories` is on; entering it produces a clear permission error rather than an empty listing. | Yes |
| Thumbnail view on a remote directory of large images | Thumbnails are generated on demand with a size cap and can be cancelled. Browsing is never blocked on them. | Yes |
| A file colour rule with poor contrast | The rule editor shows the measured contrast for both light and dark. | Yes |
| Panel comparison with clock skew | Uses the same time correction as [synchronization](../synchronization/synchronize.md). | Yes |
| Extremely long filename | Truncated in the middle, so both the beginning and the extension stay visible, with the full name in the tooltip and the accessible name. | n/a |
| Overlapping directory loads | Only the newest requested path is applied; a slower response for an older path is discarded, preserving the current listing and selection. | Yes — navigate again or refresh. |
| Remote panel or drive tree without a session | Says that no session is open; it does not call the state an empty directory or recurse while trying to reveal a remote root. | Yes — open a real connection. |

## Security considerations

- **A hidden filter can hide a file you were about to delete.** Bulk operations
  state whether they apply to the filtered view or the whole directory, and the
  count in the confirmation matches what will actually happen.
- **File colours are advisory.** They do not restrict anything; they make the
  dangerous thing visible. Combined with per-site colour tags, they are the
  cheapest defence against acting on the wrong host.
- **Colour is never the only signal.** A rule adds colour to a row that is still
  identified by name and by its other columns.
- **Thumbnails download file content.** On a metered link that is real
  bandwidth; the view warns before generating thumbnails for a large directory.
- **`showInaccessibleDirectories` reveals structure** the user cannot enter. That
  is normally desirable, and it is an option for those who prefer not to see it.

## Verification

The live interface bridge passes each action's `{ name, tag }` descriptor and
runtime state (`currentSide`, `busy`, and `actionEnabled`) to the Commander or
Explorer policy. This keeps keyboard shortcuts and action visibility aligned
with the focused panel; a descriptor is never coerced to `"[object Object]"`.
The bridge contract is covered by the focused interface IPC tests.

- Virtualization is tested with a synthetic 200,000-entry listing, asserting
  exact counts.
- Natural-order sorting is tested against a corpus with embedded numbers,
  leading zeros and mixed case.
- Column visibility, order and width round-trip through workspace save/restore.
- File-colour rule matching is tested through the mask engine, including
  first-match-wins.
- Filter-active reporting is tested to assert the status bar states it and that
  bulk-operation counts match the intended scope.
- Middle-truncation is tested to assert the extension remains visible and the
  accessible name is the full one.
- Load-generation handling is tested to ensure an out-of-order directory
  response cannot replace a newer path or reset its selection.
- Commander/Explorer action-state tests cover hidden Commander panel headers,
  disconnected cross-panel navigation, and UNC-aware Root routing.
- The remote drive tree distinguishes no session from a connected empty
  directory and stops refreshing until a session exists.

## Suggested articles

- [File masks](../editing-and-commands/file-masks.md) — the language behind filters and colour rules.
- [Material Design 3](material-3.md) — and why data colours are exempt from it.
- [Workspaces](../sessions-and-sites/workspaces.md) — what persists a panel layout.
- [The regex builder](../search-and-regex/regex-builder.md) — the builder on each panel filter.
