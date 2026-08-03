# Auditable document discard

## What it does

Closing an unsaved remote edit records a `Discarded unsaved document` revision
before the editor close event completes. The revision carries only the editor
identifier, file name, session id and owned temporary/remote paths; the document
contents and credentials never enter the history record. The temporary copy is
kept and reported as an orphan so the user can recover it later.

## Configuration

The feature uses the existing local Git-backed version-history store and the
editor temporary-file policy. It does not add a switch that silently disables
the audit. History remains best effort: a history repository failure never
blocks the requested close.

## Failure modes

If the history write fails, the editor still closes, emits the orphan event and
keeps the temporary file. If the temporary file has already disappeared, the
history record still proves that the discard action occurred, but there is no
local content to recover.

## Security considerations

The audit record is metadata only. It excludes text, passwords, passphrases and
private-key material. Paths are retained because they identify the recovery
copy, and the history repository lives in the app-owned data root.

## Verification

`test/editors.test.js` asserts that the history snapshot happens before close,
contains the discard metadata, and still emits the orphan event. Run
`node --test test/editors.test.js test/history.test.js` when changing editor
close or history restore behavior.

## Suggested articles

- [History snapshots](snapshots.md) — append-only state and restore semantics.
- [Internal and external editors](../editing-and-commands/editors.md) — the
  editor lifecycle and orphan handling.
