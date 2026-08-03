# File search

## What it does

`design/main/find.js` searches a directory tree — local or remote — for files
matching a name pattern, with optional size and date criteria. Results appear in
their own tab, from which files can be opened, edited, downloaded, deleted or
revealed in the panel.

## Configuration

| Field | Meaning |
| --- | --- |
| Search for | A [file mask](../editing-and-commands/file-masks.md), or a regex when the builder is engaged. |
| Look in | The starting directory, local or remote. |
| Search subdirectories | Recursive. On by default. |
| Case sensitive | Off by default, matching the mask language. |
| Include hidden | Off by default. |
| Size | `>`/`<`/range, with `K`/`M`/`G` suffixes. |
| Modified | An absolute date range or a relative window. |
| Follow symbolic links | Off by default — link loops are how a recursive search never finishes. |
| Maximum results | Bounded, with the bound stated. |

The file-mask field carries the [regex builder](regex-builder.md) anchored beside
it, alongside the dedicated mask editor. Plain text and mask syntax are the
defaults; regex is an explicit opt-in, and applying a builder pattern writes it
back to the mask field so the next search uses exactly what was shown.

## Behaviour worth knowing

- **Results stream in.** The list fills as the walk proceeds; there is no wait
  for the whole tree. The count updates live and is marked as still running.
- **Empty results are truthful.** If candidate files are still being read back
  for content verification, the list says that checking is in progress instead
  of briefly claiming that no files exist. Closing or starting another search
  invalidates those late callbacks.
- **The search is cancellable at any point**, and cancelling keeps the results
  found so far.
- **Results can be exported without the pointer.** Focus the results list and press
  `Ctrl+C` (or `Cmd+C` on macOS) to copy the currently filtered result paths;
  the same operation is also available from the context menu.
- **It uses the ordinary adapter listing path**, so it obeys the protocol's
  capabilities, the site's timeouts and any active session limits.
- **It searches names, not contents.** Content search would mean downloading
  every file, which is a very different and much more expensive feature; the
  dialog says so rather than leaving people to discover it.

## Failure modes

| Situation | What the user sees | Recoverable |
| --- | --- | --- |
| A directory cannot be read | Skipped and counted. The summary reports how many were inaccessible, so an incomplete search is never presented as complete. | Yes |
| Symlink loop | Bounded by depth and by an inode/path set. With following off, links are simply not entered. | n/a |
| A very large tree | Streaming plus the result bound keeps it usable. The bound is stated when reached, not silently applied. | Yes |
| Session drops mid-search | Search stops, partial results are kept and clearly marked partial. | Yes |
| Invalid pattern | Reported inline, typed text kept, no search started. | Yes |
| Catastrophic backtracking on a regex search | Time-bounded per entry; the search aborts and reports the pattern as too expensive. | Yes |
| Clock skew on date criteria | Uses the same time correction as [synchronization](../synchronization/synchronize.md). | Yes |
| Acting on a result whose file has been deleted | The operation fails naming the file; the result is marked stale rather than silently disappearing. | n/a |
| Thousands of results | Virtualized, with exact counts. | n/a |

## Security considerations

- **A recursive search is many operations against someone else's server.** It is
  rate-aware, cancellable, and bounded, so it cannot become an accidental denial
  of service against a host you were only browsing.
- **Result paths are as sensitive as the tree.** They stay in the local UI and
  are not logged unless session logging is on; exporting the result list warns
  that it contains full paths.
- **Inaccessible directories are counted, not hidden.** A search that quietly
  skipped what it could not read would report "no matches" for a file that exists
  — a genuinely dangerous kind of wrong answer.
- **Symlink following is off by default**, which is both a loop defence and a
  scope defence: a link out of the search root would otherwise take the search
  somewhere the user did not ask about.
- **Pattern evaluation is bounded**, exactly as in the builder.

## Verification

- Recursive walking is tested against synthetic trees including deep nesting,
  symlink loops, unreadable directories and very wide directories.
- Streaming and cancellation are tested, asserting partial results are retained
  and marked partial.
- Mask and regex modes are tested for equivalent results where the patterns are
  equivalent, and for the mask-to-regex conversion shown on switching.
- Size and date criteria are tested at their boundaries, with and without clock
  correction.
- The inaccessible-directory count is asserted to be exact.
- Result actions are tested against stale entries.

## Suggested articles

- [The regex builder](regex-builder.md) — the builder on this search field.
- [File masks](../editing-and-commands/file-masks.md) — the default pattern language here.
- [Panels](../interface-and-appearance/panels.md) — where a result is revealed.
- [Search surfaces](search-surfaces.md) — the full list of fields with a builder.
