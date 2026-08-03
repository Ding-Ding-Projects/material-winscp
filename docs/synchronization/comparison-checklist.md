# The comparison checklist

## What it does

The checklist is the output of a comparison and the input to a transfer. It
lists every difference the engine found, one row per file, with the action
proposed for it — and lets the user change or drop any of them before anything
happens.

It is a full tabbed surface, not a modal preview: it can be searched, sorted,
filtered and left open while you look at the panels behind it.

## The columns

| Column | Meaning |
| --- | --- |
| Action | Upload, download, delete local, delete remote, or skip. Editable per row. |
| Local file | Name, size, timestamp. Blank when the file exists only remotely. |
| Direction | An arrow that also encodes destructiveness in shape, not colour alone. |
| Remote file | The counterpart. |
| Reason | Why the row exists: newer, size differs, missing on one side, mask forced. |

Rows are grouped by displayed directory, and the group headers carry the
directory path — so a whole local or remote folder can be selected from its
row context menu without scrolling through unrelated directories.

## Configuration

| Control | Effect |
| --- | --- |
| Per-row action override | Change one file's fate without re-running the comparison. |
| Delete files / existing files only | These policies travel with the comparison request, so deletion rows are present when requested and new-file rows are excluded by the engine before the checklist opens. |
| Select/deselect all in group | Drop an entire class of change. The row context menu also checks or unticks every actionable row in that row's displayed directory; rows whose action is `Do nothing` remain unticked. |
| Invert selection | |
| Search | Filter rows by name or reason. Wired to the [regex builder](../search-and-regex/regex-builder.md) like every search bar here. |
| Sort | By any column; sorting never changes actions. |
| Save checklist | Export the list as text for review before committing. |

The checklist search bar is a full search surface: plain text by default, regex
as an explicit opt-in, with the builder anchored beside the field.

## Failure modes

| Situation | What the user sees | Recoverable |
| --- | --- | --- |
| Very large checklist (100,000+ rows) | The list virtualizes; group counts are computed up front so the destructive total is never hidden behind lazy loading. | n/a |
| A file changes on disk between comparison and execution | Detected at transfer time; the item fails with "changed since comparison" rather than acting on stale information. | Yes, re-compare |
| A row is overridden into an impossible action | Actions the protocol cannot perform are not offered for that row — the same `caps` rule as everywhere else. | n/a |
| Delete files is enabled | Remote-only/local-only target rows appear in the checklist with the engine's deletion policy, and the destructive confirmation repeats the count. | Yes, untick or cancel |
| Everything is skipped | The confirmation says "nothing to do" instead of running an empty transfer. | n/a |
| Comparison ran with a mask, then the mask is changed | The checklist does not silently update. It states the mask it was computed under, and offers Re-compare. | Yes |
| The session drops while the checklist is open | The list survives; executing it prompts to reconnect first. | Yes |

## Security considerations

- **Deletions are visually distinct by shape and label, not colour alone.** A
  user with a colour-vision deficiency, or in high-contrast mode, must be able to
  see which rows destroy data.
- **Counts appear twice** — in the group header and in the final confirmation —
  because a mis-set direction is the realistic disaster here and one glance
  should be enough to catch it.
- **The checklist is a snapshot.** Acting on a stale list is exactly how a
  synchronize deletes something recreated in the meantime, which is why the
  changed-since-comparison check fails rather than proceeds.
- **Exported checklists contain full paths**, which can be sensitive. The export
  goes where the user chooses, with no default to a shared location.
- **No content is read to build the list.** Names, sizes and times only.

## Verification

- Checklist construction is tested against the same synthetic trees as the
  comparison engine, asserting exact row counts per action.
- The renderer request boundary is tested to keep `deleteFiles` and
  `existingOnly` intact across `sync:compare`; the engine tests then assert the
  resulting deletion and new-file rows.
- Per-row override is tested for not disturbing other rows and for respecting
  protocol capabilities.
- Directory-scoped check and uncheck is tested for changing only the displayed
  directory, preserving each row's action, and never ticking `Do nothing`.
- Changed-since-comparison detection is tested by mutating a file between
  comparison and execution.
- The search field is covered by the shared search-surface tests: plain-text
  default, regex opt-in, bidirectional synchronization with the builder, and an
  honest no-match state.
- Virtualization is tested with a synthetic 200,000-row list, asserting group
  counts are exact rather than estimated.

## Suggested articles

- [Synchronize](synchronize.md) — what produces this list.
- [Keep remote directory up to date](keep-up-to-date.md) — the continuous mode, which shows a running checklist instead.
- [The regex builder](../search-and-regex/regex-builder.md) — the builder anchored to this search bar.
- [Tabs and navigation](../tabs-and-navigation/) — the checklist is a tab, with everything that implies.
