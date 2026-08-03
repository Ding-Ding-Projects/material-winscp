# Remote editor reconciliation

When a remote file is saved, the editor manager remains responsible for the
timestamp check and upload. `ExplorerShell.handleEditorEvent()` handles the
visible follow-up: it refreshes the remote panel for a matching `uploaded` or
remote `saved` event, including the edited path as refresh context.

Events for local-only editors, other sessions, and unrelated editor states are
ignored. If the panel refresh operation is not wired, the hook reports that
fact without turning a successful editor save into a failure.

Before an upload, the manager re-checks the remote timestamp and size, plus a
strong ETag when WebDAV or S3 supplies one. A mismatch emits
`remote-changed`, including when the size and coarse timestamp are unchanged. A
missing-file response may recreate the file and emits `remote-missing`; other
`stat()` failures (for example a timeout or authentication error) abort the
upload and keep the edited temporary copy dirty. Failed checks and writes clear
the temporary-file retry stamp, so a later `editor:fileChanged` notification
retries the same bytes instead of being discarded as unchanged.

Verification: `node --test test/explorershell.test.js` covers the matching
remote upload, local save, and other-session cases.

The stat-failure guard is covered by `node --test test/editors.test.js`.
