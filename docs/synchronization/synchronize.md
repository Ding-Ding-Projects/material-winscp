# Synchronize

## What it does

Compares a local directory tree against a remote one and brings them into
agreement, in a direction and under criteria the user chooses. It produces a
[comparison checklist](comparison-checklist.md) first; acting on it is a separate,
confirmed step.

## Configuration

The synchronize dialog carries these choices. They are remembered per site.

### Direction

| Direction | Effect |
| --- | --- |
| **Remote** | Make the remote match the local. Uploads, and (optionally) deletes remote files with no local counterpart. |
| **Local** | Make the local match the remote. The mirror image. |
| **Both** | Newer file wins in each direction. Never deletes — a delete in "both" mode is ambiguous by construction, and guessing would be destructive. |

### Mode

| Mode | Effect |
| --- | --- |
| **Synchronize files** | Transfer the differences. |
| **Mirror files** | Also remove files on the target that do not exist on the source. |
| **Synchronize timestamps only** | Touch matching files so their times agree, transferring nothing. |

### Comparison criteria

| Criterion | Meaning |
| --- | --- |
| **Modification time** | Default. Requires trustworthy clocks — see failure modes. |
| **File size** | Cheap and coarse: a same-size edit is invisible to it. |
| **Both** | Differ in either respect. |
| **Either / none** | For timestamp-only runs and forced transfers. |

### Options

| Option | Default | Meaning |
| --- | --- | --- |
| Preview changes | on | Show the checklist. Turning it off is possible and warned about. |
| Delete files | off | Enables the destructive half of Mirror. |
| Existing files only | off | Never create anything new; update files present on both sides, while an explicitly enabled delete policy may still remove an extra target file. |
| Selected files only | off | Restrict to the current panel selection. |
| Recurse subdirectories | on | |
| Use same options next time | off | |
| File mask | empty | An [include/exclude mask](../editing-and-commands/file-masks.md). |

Time tolerance comes from the site's `timeDifference` / `timeDifferenceAuto`, so
a server in another timezone does not make every file look changed.

## Failure modes

Invalid clock settings are refused before a comparison starts: `timeTolerance`
must be finite and non-negative milliseconds, while `timeDifference` must be a
finite number of seconds. This prevents a malformed configuration from making
all files appear newer, older, or unchanged.

| Situation | What the user sees | Recoverable |
| --- | --- | --- |
| Server clock skew | Everything appears newer on one side. `timeDifferenceAuto` measures the offset at connect; when it cannot, the checklist shows the raw times side by side so the pattern is obvious. | Yes |
| Filesystem timestamp granularity (FAT's 2 seconds, some servers' 1 minute) | Spurious differences. A tolerance is applied per protocol; below it, times are considered equal. | Yes |
| DST transition | A one-hour shift on the whole tree. `dSTMode` (`unix`, `keep`, `win`) selects the interpretation. | Yes |
| Mirror with delete, wrong direction | The checklist shows deletions in a distinct destructive style with a count, and the confirmation states the count again. Both are shown before anything happens. | **Only from a backup** |
| Case-insensitive comparison with different spelling | Names such as `File.txt` and `file.txt` are one pair by default; an update preserves the existing target spelling. Enable case-sensitive comparison to treat them as separate files. | Yes |
| Symlinks | Compared as links unless `followDirectorySymlinks` is on. A link and a real file with the same name are a conflict, not a match. | Yes |
| Connection lost mid-run | Completed items stand; the rest return to the checklist marked pending. No partial state is hidden. | Yes |
| Queue reports an error before an item exists | The watcher keeps running and surfaces the original connection/transport error; cleanup does not replace it with a secondary missing-item error. The visible error row is an assertive alert so assistive technology announces it immediately, while ordinary activity remains a polite status update. | Yes |
| Empty local directory, Mirror to remote with delete | Would delete everything remote. The confirmation states the count and the fact that the source is empty, in those words. | **Only from a backup** |

## Security considerations

- **This is the most destructive feature in the application.** The checklist is
  mandatory by default, deletions are visually distinct and counted twice, and
  turning the preview off produces an explicit warning that says what is being
  given up.
- **Deleted files may go to a recycle bin — or may not.** Local deletes honour
  `deleteToRecycleBin`; remote deletes honour the site's `deleteToRecycleBin` and
  `recycleBinPath`, and S3 has no recycle bin at all. The confirmation states
  which applies to the run about to happen.
- **A file mask restricts what is *transferred*, and also what is *considered*.**
  A mask that excludes a file also excludes it from deletion — a safety property
  worth relying on deliberately. During recursive comparison, ordinary file
  masks are evaluated relative to each comparison root and do not prune
  directories before their children are checked; explicit directory-only rules
  such as `node_modules/` still exclude that subtree.
- **Timestamp-only mode writes metadata to both sides.** It is not read-only,
  despite feeling like it.
- **Comparison reads names and metadata, never content**, unless a checksum
  criterion is explicitly chosen. Nothing is uploaded to compare.

## Verification

- The comparison engine is tested directly with synthetic trees covering: newer
  on each side, equal, size-only differences, time-only differences, missing on
  each side, case collisions, symlink/file conflicts and mask exclusion.
- Clock-offset and DST handling are tested with fixed synthetic offsets.
- Deletion gating is tested to assert that no delete is emitted unless both the
  Mirror mode and the delete option are set.
- Interruption is tested by failing the adapter mid-run and asserting that
  completed and pending items are reported accurately.
- Case-insensitive updates are tested to preserve the existing target spelling,
  rather than creating a second case-variant path.
- Keep-up-to-date queue cleanup is tested with an item-less queue error, proving
  a transport failure cannot crash the watcher while it removes in-flight state.
- A startup comparison that loses its connection is tested to report through the
  watcher error event after the caller subscribes, rather than crashing before
  the bridge can forward it.
- Watcher activity rows use polite live updates, while watcher errors use an
  assertive alert role so a failure is announced even when focus is elsewhere.

## Suggested articles

- [The comparison checklist](comparison-checklist.md) — the list this produces, and how to edit it.
- [Keep remote directory up to date](keep-up-to-date.md) — the continuous version.
- [File masks](../editing-and-commands/file-masks.md) — the exclusion language, and its safety role.
- [Transfers and the queue](../transfers-and-queue/) — what executes the accepted items.
