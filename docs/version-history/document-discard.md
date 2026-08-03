# Auditable document discard

## What it does

Closing an unsaved remote edit records a `Discarded unsaved document` revision
before the editor close event completes. The renderer sends its latest buffer to
the main process as part of the deliberate discard; the main process writes that
buffer to the owned temporary file, records the append-only revision, and only
then reports the orphan. The revision carries only the editor identifier, file
name, session id and owned temporary/remote paths; document contents and
credentials never enter the history record. The temporary copy is kept so the
discard can be recovered from the orphan surface.

## Configuration

The feature uses the existing local Git-backed version-history store and the
editor temporary-file policy. It does not add a switch that silently disables
the audit. History remains best effort: a history repository failure never
blocks the requested close.

## Failure modes

If the history write fails, the editor still closes, emits the orphan event and
keeps the temporary file. That event explicitly reports `discardAudit.status:
not-recorded` (and the failure reason), so the UI or another consumer cannot
mistake a close for a durable audit. A successful write reports `recorded` and
the history action is categorized as `discarded`. If writing the latest buffer
fails, the close still completes and `recoveryAvailable` is false; the audit is
not overstated.

## Security considerations

The audit record is metadata only. It excludes text, passwords, passphrases and
private-key material. Paths are retained because they identify the recovery
copy, and the history repository lives in the app-owned data root.

## Verification

`test/editors.test.js` asserts that the renderer buffer is written before the
history snapshot and close return, contains the discard metadata, emits the
audit status, and still closes when the history write fails. The renderer
close contract is covered by `test/editor-dialog.test.js`; action filtering is
covered by `test/history.test.js`. Run
`node --test test/editors.test.js test/editor-dialog.test.js test/history.test.js`
when changing editor close or history restore behavior.

## Suggested articles

- [History snapshots](snapshots.md) — append-only state and restore semantics.
- [Internal and external editors](../editing-and-commands/editors.md) — the
  editor lifecycle and orphan handling.
