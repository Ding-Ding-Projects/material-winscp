# Remote edit round trip

Opening a remote file through the Explorer downloads it to the editor manager's
temporary copy. The renderer reads that copy through `editor:read`; saving
writes the edited text through `editor:save`, which performs the conflict check
and upload. The explicit renderer upload action uses `editor:upload` and now
reaches the same `EditedFileUploaded` seam in `design/main/editors.js`, so it
also refreshes the remote stamp, invalidates the directory listing, and emits
the normal `uploaded` event.

If the remote file changed after opening, both routes refuse the upload with
`REMOTE_CHANGED` unless the user explicitly chooses the force-upload action.
If the session is disconnected, the temporary copy is retained and the
operation reports `NOT_CONNECTED`.

Verification: `node --test test/editors.test.js test/editor-dialog.test.js`.
