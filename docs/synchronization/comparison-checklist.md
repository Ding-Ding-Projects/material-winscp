# The comparison checklist

## What it does

The checklist is the output of a comparison and the input to a transfer. It
lists every difference the engine found, one row per file, with the action
proposed for it — and lets the user change or drop any of them before anything
happens.

It is a modal review surface. It can be searched, grouped, sorted and copied
before the user confirms the action; closing it leaves the comparison unapplied.

## The columns

| Column | Meaning |
| --- | --- |
| File | The available local or remote name. Hovering the name exposes both full paths. |
| Reason | Why the row exists: newer, size differs, missing on one side, or a directory/type condition. |
| Size | The source size for a transfer, or the target size for a deletion. Directories show an em dash. |
| Action | Upload, download, delete local, delete remote, or do nothing. Editable when the row has the required source/target. |

Rows are grouped by displayed directory, and the group headers carry the
directory path — so a whole local or remote folder can be selected from its
row context menu without scrolling through unrelated directories.

## Configuration

| Control | Effect |
| --- | --- |
| Per-row action override | Change one file's fate without re-running the comparison. |
| Timestamp-only row | Keep its proposed upload/download direction to change metadata only, or choose Do nothing. Reversing it is disabled because the direct override path transfers bytes. |
| Delete files / existing files only | These policies travel with the comparison request. Deletion rows are present when requested; `Existing files only` suppresses new transfers but does not suppress deleting an extra target file. |
| Select/deselect all in group | Drop an entire class of change. The row context menu checks or unticks every actionable row in the selected directory and its descendants; similarly named sibling directories are excluded. Rows whose action is `Do nothing` remain unticked. |
| Check/uncheck all | The toolbar and its context menu tick every actionable row or clear every row. `Do nothing` rows remain unticked. Keyboard users can use <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>A</kbd> to check all and <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>Shift</kbd>+<kbd>A</kbd> to uncheck all. Shortcuts do not intercept typing in controls. |
| Invert selection | Flip checked/unticked state for every actionable row. Rows whose action is `Do nothing` remain unticked, so inversion cannot create a ticked no-op. |
| Search | Filter rows by local/remote path, name, or action through the shared search surface. Plain text is the default; regex is explicit. |
| Sort | Cycle through name, action, and directory; sorting is presentation-only and stable, so selection and action overrides stay attached to the same file. |
| Calculate | Recompute the checked outcome on demand and announce the resulting transfers and deletions; it does not execute anything. |
| Copy checklist | Copy tab-separated checked state, action, both paths, and reason to the clipboard. |

The checklist search bar is a full search surface: plain text by default, regex
as an explicit opt-in, with the builder anchored beside the field.

## Failure modes

| Situation | What the user sees | Recoverable |
| --- | --- | --- |
| Very large checklist | The dialog renders the rows it receives; it is not virtualized, so very large comparisons can be expensive to display. | Yes, narrow the mask or scope |
| A file changes on disk between comparison and execution | The comparison is a snapshot, but there is no changed-since-comparison guard in this surface; re-run the comparison when the list may be stale. | Yes, re-compare |
| A row is overridden into an impossible action | The renderer gates missing sources, missing deletion targets, type mismatches, and timestamp-only reversals. Protocol capability failures still return from the engine when the action is applied. | Yes, choose another action or re-compare |
| Delete files is enabled | Remote-only/local-only target rows appear in the checklist with the engine's deletion policy, and the destructive confirmation repeats the count. | Yes, untick or cancel |
| Everything is skipped | The confirmation says "nothing to do" instead of running an empty transfer. | n/a |
| Comparison ran with a mask, then the mask is changed | The checklist remains the snapshot produced by the original request; changing dialog settings requires a new comparison. | Yes |
| The session drops while the checklist is open | The list survives; executing it prompts to reconnect first. | Yes |

## Security considerations

- **Deletions are visually distinct by shape and label, not colour alone.** A
  user with a colour-vision deficiency, or in high-contrast mode, must be able to
  see which rows destroy data.
- **The checklist is a snapshot.** It keeps the engine's original paths and
  actions; re-compare before applying if the files or options may have changed.
- **Copied checklists contain full paths**, which can be sensitive. Clipboard
  contents stay under the user's control and are not written to a file by this
  dialog.
- **No content is read to build the list.** Names, sizes and times only.

## Verification

- Checklist construction is tested against the same synthetic trees as the
  comparison engine, asserting exact row counts per action.
- The renderer request boundary is tested to keep `deleteFiles` and
  `existingOnly` intact across `sync:compare`; the engine tests then assert the
  resulting deletion and new-file rows.
- Per-row override is tested for not disturbing other rows and refusing
  timestamp-only reversals.
- Reverse on a `Do nothing` row is tested to remain gated with the correct
  no-direction reason.
- Calculate is tested to count only checked rows, report transfer bytes and
  deletion totals, and leave the checklist rows unchanged. The toolbar command
  is informational only; applying still requires the separate Synchronize
  action and deletion confirmation.
- Sorting before changing a selection or per-row action is tested to preserve
  row identity when the checklist sends its decisions back to the comparison
  engine, including stable descending ties and a root-directory scope.
- Directory-scoped check and uncheck is tested for changing only the displayed
  directory subtree, preserving each row's action, excluding similarly named
  siblings, and never ticking `Do nothing`. The context-menu availability check
  uses that same subtree boundary, so a parent directory with only descendant
  rows still offers the action.
- The remote deletion size and the comparison request's hidden-file policy are
  covered by the renderer transfer-dialog tests.
- The engine tests cover timestamp-only application, case-preserving targets,
  option validation, watcher startup, native-event coalescing, queue-error
  races, and removal of queued items.

## Suggested articles

- [Synchronize](synchronize.md) — what produces this list.
- [Keep remote directory up to date](keep-up-to-date.md) — the continuous mode.
- [The regex builder](../search-and-regex/regex-builder.md) — the builder anchored to this search bar.
- [Tabs and navigation](../tabs-and-navigation/) — the checklist is a tab, with everything that implies.
