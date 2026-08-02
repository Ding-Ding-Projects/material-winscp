# Resume, partial files and overwrite modes

## What it does

Resume restarts an interrupted transfer from the byte where it stopped instead
of from zero. It is implemented by writing to a temporary name
(`<file>.filepart` by default) and renaming on success, so a target file is
either complete or absent — never a truncated file that looks finished.

Resume is only possible where the protocol supports a byte offset. SFTP, FTP
(via `REST`) and the local backend can; SCP, WebDAV and S3 cannot, and their
`caps.resume` is false, so the UI does not offer it.

## Configuration

In **Transfer settings**, stored in `COPY_PARAM_DEFAULTS`.

| Option | Default | Meaning |
| --- | --- | --- |
| `resumeSupport` | `smart` | `on` always uses a partial file, `off` never does, `smart` uses one for files at or above `resumeThreshold`. |
| `resumeThreshold` | `102400` (100 KB) | The `smart` cut-off. Below it, the rename overhead outweighs the benefit. |
| `partialFileExt` | `.filepart` | Extension for in-progress files. |
| `overwriteMode` | `overwrite` | `overwrite`, `resume`, or `append`. |
| `confirmResume` (preference) | `true` | Ask before continuing into an existing partial file. |

`overwriteMode` decides what happens when the **target already exists**:

- `overwrite` — replace it from the beginning.
- `resume` — treat the existing bytes as a prefix and continue after them.
- `append` — add to the end without assuming it is the same file. Useful for
  logs, dangerous for anything else.

## Behaviour worth knowing

- **Resume trusts size, not content.** Continuing after byte *N* assumes the
  first *N* bytes are the same file. If the source changed since the interrupted
  attempt, the result is a mixture of two files that is valid at neither. This is
  why `confirmResume` exists and defaults to on.
- **A `.filepart` is a promise, not a file.** It is deliberately not renamed
  until the transfer completes, so a crashed transfer leaves an obviously
  incomplete artefact rather than a plausible-looking broken one.
- **Timestamps are applied after the rename**, so a resumed file gets the
  source's timestamp, not the time of the last chunk.
- **Cancelling keeps the partial** when resume is possible and removes it when it
  is not — an unresumable partial is only litter.

## Failure modes

| Situation | What the user sees | Recoverable |
| --- | --- | --- |
| A `.filepart` exists from an earlier run | With `confirmResume`, a modal offering Resume / Restart / Cancel, showing both sizes and the partial's age. This is a decision, so the modal is correct. | Yes |
| Source changed since the partial was written | Not detectable by size alone. When the protocol supplies a checksum the mismatch is caught and reported; otherwise the confirmation warns. Restart is the safe answer. | Yes, by restarting |
| Partial is larger than the source | Treated as corrupt: resume is refused and restart is offered. | Yes |
| Server does not honour `REST` despite advertising it | The first resumed chunk lands at the wrong offset; the size check after transfer catches it and the item fails rather than reporting success. | Yes |
| `append` used on a non-log file | The file is silently valid and semantically wrong — nothing can detect this. The mode is documented as intentional-use-only and is not offered by default. | Only by re-transferring |
| Disk fills while writing a `.filepart` | Partial kept, item failed with `ENOSPC`, resume available once space is freed. | Yes |
| Two transfers target the same file | The second is refused while the first holds the `.filepart`, naming the conflicting item. | Yes |
| `partialFileExt` matches a real file pattern on the server | A user file called `x.filepart` could be mistaken for a partial. Only partials this app created in this session are adopted; a stranger's `.filepart` is treated as an ordinary file. | n/a |

## Security considerations

- **Partial files inherit the target's permissions, not a temporary default.**
  Writing a `.filepart` world-readable and tightening it at rename would leave a
  window where the content is exposed.
- **A stale partial is a data remnant.** A cancelled sensitive download leaves
  readable bytes on disk. The cancel confirmation offers to delete it, and
  cleanup on exit follows `temporaryDirectoryCleanup`.
- **Resume across a changed source can silently produce a Frankenstein file.**
  Where integrity matters, verify with a checksum after transfer; the risk is
  stated in the confirmation rather than buried here.
- **`append` never truncates**, so it cannot be used to destroy data — but it can
  be used to grow a file without limit. Quota errors are surfaced immediately.

## Verification

- Offset arithmetic, threshold selection and the three overwrite modes are
  tested against the local adapter with deliberately interrupted streams.
- Size-mismatch detection after a dishonest `REST` is tested with a synthetic
  server that ignores the offset.
- Partial adoption is tested to confirm a `.filepart` not created by the current
  session is treated as an ordinary file.
- Rename-on-success atomicity is tested by killing the write mid-stream and
  asserting the target does not exist.

## Suggested articles

- [Transfer settings](transfer-settings.md) — the rest of the options an item carries.
- [The queue](queue.md) — where a failed item's offset is kept.
- [SFTP](../protocols/sftp.md) and [FTP](../protocols/ftp.md) — the two protocols that can actually resume.
- [Synchronization](../synchronization/) — which uses the same overwrite machinery.
