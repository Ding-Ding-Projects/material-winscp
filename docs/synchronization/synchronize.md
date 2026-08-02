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
| Existing files only | off | Never create anything new; only update what both sides have. |
| Selected files only | off | Restrict to the current panel selection. |
| Recurse subdirectories | on | |
| Use same options next time | off | |
| File mask | empty | An [include/exclude mask](../editing-and-commands/file-masks.md). |

Time tolerance comes from the site's `timeDifference` / `timeDifferenceAuto`, so
a server in another timezone does not make every file look changed.

## Failure modes

| Situation | What the user sees | Recoverable |
| --- | --- | --- |
| Server clock skew | Everything appears newer on one side. `timeDifferenceAuto` measures the offset at connect; when it cannot, the checklist shows the raw times side by side so the pattern is obvious. | Yes |
| Filesystem timestamp granularity (FAT's 2 seconds, some servers' 1 minute) | Spurious differences. A tolerance is applied per protocol; below it, times are considered equal. | Yes |
| DST transition | A one-hour shift on the whole tree. `dSTMode` (`unix`, `keep`, `win`) selects the interpretation. | Yes |
| Mirror with delete, wrong direction | The checklist shows deletions in a distinct destructive style with a count, and the confirmation states the count again. Both are shown before anything happens. | **Only from a backup** |
| Case-insensitive local vs case-sensitive remote | `File.txt` and `file.txt` cannot coexist locally. The pair is reported as a conflict and skipped, never silently merged. | Yes |
| Symlinks | Compared as links unless `followDirectorySymlinks` is on. A link and a real file with the same name are a conflict, not a match. | Yes |
| Connection lost mid-run | Completed items stand; the rest return to the checklist marked pending. No partial state is hidden. | Yes |
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
  worth relying on deliberately.
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

## Suggested articles

- [The comparison checklist](comparison-checklist.md) — the list this produces, and how to edit it.
- [Keep remote directory up to date](keep-up-to-date.md) — the continuous version.
- [File masks](../editing-and-commands/file-masks.md) — the exclusion language, and its safety role.
- [Transfers and the queue](../transfers-and-queue/) — what executes the accepted items.
