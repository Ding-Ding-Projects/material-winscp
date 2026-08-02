# The overwrite decision

When a transfer arrives at a name that already exists, something has to decide
what happens to the bytes that are already there. That decision is the one
place in a file-transfer application where a wrong answer is unrecoverable: a
skipped file can be transferred again, but an overwritten one is gone.

WinSCP answers it with three functions in `core/Terminal.cpp` —
`EffectiveBatchOverwrite`, `ConfirmFileOverwrite` and `CheckRemoteFile` — plus a
per-protocol wrapper around them. All of it is ported into
`design/main/transfer.js`, and **both** paths that transfer files (the session
path in `terminal.js` and the queue in `queue.js`) call that one copy. They used
to disagree; they cannot now.

## The precedence ladder

`EffectiveBatchOverwrite` is a five-rung ladder. Each rung beats everything
below it, and reaching a rung means the question is answered without the user
seeing anything.

| # | Condition | Result |
| --- | --- | --- |
| 1 | The caller asked to resume (`cpResume`), or this exact file is the one being resumed | **Resume** |
| 2 | The caller asked to append (`cpAppend`) | **Append** |
| 3 | "Transfer only new and updated files" is on, and the target side reports a timestamp worth comparing | **Only if newer** |
| 4 | The caller asked for no confirmation, or *Confirm overwriting* is off in Preferences | **Overwrite everything** |
| 5 | Otherwise | Whatever the user last answered "to all" with — or *ask* |

Three details are load-bearing:

- **Rung 3 beats rung 4.** Turning confirmations off does not turn "only newer"
  into "overwrite everything". An unattended queue with *only newer* set still
  compares timestamps.
- **Rung 1 is conditional on the pass.** The decision is computed twice. The
  first ("special") pass has resume on the table; if the resulting mode is not
  applicable to this file — an "only newer" decision with no file information,
  or a resume where the target is not shorter than the source — the decision is
  recomputed with resume, alternate-resume and only-newer stripped out. That
  second pass is what stops a stale "resume all" from silently skipping a file
  it cannot resume.
- **A part of a split file is never resumed.** When one file is being carried by
  several connections, each part has a deliberate offset; treating that as a
  resume would splice the file into itself.

## Comparing timestamps

"Only if newer" compares the source and target modification times *after
reducing both to the coarser of the two precisions*, then with a two-second
tolerance.

Both halves matter. A server that reports `Jul 14 09:31` has told you nothing
about seconds, so comparing a local file's `09:31:42` against it second by
second decides "newer" every single time and re-copies the whole tree on every
run. And a FAT-formatted volume stores times to two seconds, which is why
`12:00:00.000` and `12:00:01.900` have to compare equal.

`docs/protocols/` records which protocols can be trusted here. SFTP and FTP
report a real modification time. S3 and WebDAV assign `Last-Modified`
themselves — it is the *upload* time, so an uploaded object always looks older
than the file that produced it — and SCP only ever sees an `ls` line. For those
three, **"only newer" is not offered on upload**, exactly as WinSCP does not
offer it, because an option that silently uploads everything or nothing is
worse than an absent one.

## What the dialog offers

| Button | Means | Effect |
| --- | --- | --- |
| Yes | Overwrite this file | |
| No | Leave this file alone | The transfer continues with the next file |
| Yes to all | Overwrite everything | Sets the batch mode for the rest of the operation |
| No to all | Overwrite nothing | As above |
| Yes to newer | Only where the source is newer | Sets the "only newer" batch mode |
| Rename | Write under a different name | Prompts; **cancelling the prompt cancels the operation** rather than falling back to overwriting |
| Append | Add the source to the end of the target | Only where the protocol can write at an offset |
| Cancel | Stop the whole operation | |

Two refusals are worth stating explicitly, because a port that "simplified"
them would lose data:

- **A dismissed prompt is never read as yes.** Every path that cannot get an
  answer resolves to the safest one available.
- **A cancel raised by one connection silences the question on the others.**
  During a parallel transfer, once the user has said stop, no other connection
  puts the same dialog on screen.

### Append versus resume

Picking *Append* when the target is **shorter** than the source is ambiguous: it
could mean "add the whole source to the end" or "this is an interrupted
transfer, continue it". WinSCP asks a second question, and so does this port —
unless the surface that asked the first question already offered Append and
Resume as separate buttons, which the transfer queue's own dialog does. In that
case the answer is already known and asking again would be a question with a
foregone conclusion.

Where the target is **not** shorter there is nothing to resume, so *Append* is
the only thing the button can mean and no second question is asked.

## Resuming a partial file

A resumable transfer writes to `<name>.filepart` and renames it over the real
name only when every byte has landed, so an interrupted transfer never leaves a
truncated file that looks complete. See [resume.md](resume.md).

When a `.filepart` from an earlier attempt is found:

- If it is **shorter** than the file being sent, the user is asked whether to
  resume it (unless *Confirm resume* is off, or the caller already said to
  resume).
- If it is **longer**, it is not a partial copy of this file at all — it is
  something else's. The user gets a warning, the leftover is deleted, and the
  transfer starts from the beginning. Splicing onto it would produce a file
  that is corrupt in a way nothing would detect.

## Retrying after a lost connection

`SourceRobust` and `SinkRobust` retry **one file** after a reconnect rather than
restarting the operation. Three rules keep that safe:

1. **A failure that did not kill the session is never retried.** If the session
   is still open, the error was not a connection problem — "permission denied"
   would fail identically forever. The log says
   `Session is open, will not retry transfer` and the file is reported as
   failed.
2. **The retry does not re-ask questions the user already answered.** The
   second attempt runs with confirmations suppressed and auto-resume on, and
   the "this directory is brand new" flag cleared — after a reconnect the
   directory is no longer new and may well hold a partial file we wrote.
3. **A download is not repeated when only the source delete failed.** For a
   *move*, if the connection dies while deleting the remote original, the
   download is not retried: the remote file may already be gone, and
   re-downloading would overwrite the only copy that now exists with nothing.

The per-file byte counters are rolled back before each retry, so a file
attempted three times contributes its own size once rather than three times.

## Verification

`test/transfer.test.js` asserts each rung of the ladder, both passes of the
recompute, every dialog answer, the timestamp-precision rule, the
append-versus-resume follow-up, the partial-bigger-than-source refusal and all
three robustness rules — against in-memory adapters, headlessly.
`test/queue.test.js` proves the queue's own surface still behaves identically
now that it delegates the decision.

## Suggested articles

- [resume.md](resume.md) — `.filepart` files, the resume threshold, and what
  each protocol can actually do.
- [transfer-settings.md](transfer-settings.md) — where *Confirm overwriting*,
  *Confirm resume* and *only newer* are set.
- [queue.md](queue.md) — how a queued item reaches this decision, and what
  parallel transfers change about it.
- [../protocol-gaps.md](../protocol-gaps.md) — the capability differences that
  decide whether Append, resume and split transfers are offered at all.
