# Auditable document discard and recovery

## What it does

Closing an unsaved edit records a `Discarded unsaved document` revision before
the editor close event completes. The renderer sends its latest buffer to the
main process. Remote edits keep their owned temporary copy; local edits write a
new, exclusive recovery copy instead of overwriting the original local file.
The revision stores the exact encoded bytes as Base64, plus editor metadata.

In **Version history**, choose **Restore** on a document-discard revision and
confirm. The app creates a separate, uniquely named local recovery file under
its temporary directory and opens supported text in the internal editor. It never writes
to historical local or remote paths, reconnects a session, uploads, or rolls
back unrelated current settings. Cancel/Escape before confirmation does nothing.
Repeated restores create separate copies; an in-flight UI restore rejects
repeat activation.

The recovery is recorded as a **new** revision containing the document bytes and
the current protected application configuration. Existing revisions remain in
the log. Restoring this recovery revision makes another independent copy; it
does not erase a previous copy or edits made to it. Ordinary configuration
revisions retain their existing application-state restore behavior.

## Configuration and retention

This uses the existing local Git-backed history and editor temporary-file
surfaces. No new preference is added. Recovery files remain accessible through
the temporary-file/orphan dialog after their editor closes; they are not a
permanent saved document. Save or copy important recovered work to your chosen
location before deleting temporary files. History retention/pruning can remove
old document revisions independently of temporary-copy cleanup.

Recovery accepts empty and binary documents without re-encoding their bytes.
The internal text editor rejects binary documents and files above its 8 MiB
open limit, reports an editor-open error and closes its editor record. The
recovered file remains available through the temporary-file/orphan dialog;
recovery does not promise every byte sequence can be edited as text. Supported
text is interpreted using the recorded encoding. A restore payload is
bounded to the maximum encoded size of the existing IPC editor-text limit
(four bytes per allowed character plus a BOM). Larger historical documents stay
in history but report a size-limit error instead of allocating unbounded memory.

## Failure modes

- A discard history-write failure never blocks the requested close. The orphan
  event and notification distinguish a recorded audit from an unavailable one.
- If writing the latest buffer fails, `recoveryAvailable` is false. The original
  local file is not overwritten and stale content is not advertised as recovery.
- A missing or malformed byte payload, including older metadata-only revisions,
  fails restore explicitly. Historical paths are never used as a fallback.
- A recovery-file write or main-process editor registration failure does not
  append a restored revision. A later renderer refusal leaves the successful
  recovery audit intact.
  Failed recovery-file preparation removes only the new owned recovery directory.
- If the copy is usable but its history write fails, recovery still succeeds and
  a persistent error notification explicitly says the new revision was not
  recorded. The response has `auditRecorded: false` and `newRevision: null`.
- Removing selected temporary copies refreshes the orphan dialog immediately.

## Security considerations

This is **not metadata-only** history. Base64 is not encryption: document contents
can include sensitive information, and local history/export must be treated with
the same care as the source documents. The existing credential store remains
protected: recovery neither decrypts configuration credentials nor sends them in
its IPC response or editor-open notification. The current protected configuration
is retained as-is in the new revision.

Recovery uses an exclusive file in a fresh app-owned directory, a sanitized
Windows-compatible prefixed filename, and restrictive file permissions where
supported. Historical filenames, paths and session IDs cannot choose a write
location or trigger a remote connection. History remains local; no publication
or automatic network transfer is part of recovery.

## Verification

`test/document-restore-ipc.test.js` exercises the **registered shipping IPC
handlers**, real Config/EditorManager and on-disk Git history with only Electron's
transport/window shell substituted. It covers exact CRLF/Unicode and binary/empty
bytes, original-file preservation, deleted temporary copies, append-only history,
repeat/concurrent restore, current settings and credential protection, malformed
and oversized payloads, hostile paths, write/open/audit failures, and invalid
labels. It also executes the production modal callbacks headlessly for Cancel,
Escape, repeat activation, editor handoff and partial-success notification.

Run `node --test test/document-restore-ipc.test.js test/editors.test.js
 test/editor-dialog.test.js test/history.test.js test/history-panel.test.js`.
These tests do not establish Windows GUI, layout, installer, or screenshot
acceptance; those require a real built application on the target platform.

## Suggested articles

- [History snapshots](snapshots.md) — append-only state and retention.
- [Internal and external editors](../editing-and-commands/editors.md) — editing
  and temporary-copy handling.
