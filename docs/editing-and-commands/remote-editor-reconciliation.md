# Remote editor reconciliation

When a remote file is saved, the editor manager remains responsible for the
timestamp check and upload. `ExplorerShell.handleEditorEvent()` handles the
visible follow-up: it refreshes the remote panel for a matching `uploaded` or
remote `saved` event, including the edited path as refresh context.

Events for local-only editors, other sessions, and unrelated editor states are
ignored. If the panel refresh operation is not wired, the hook reports that
fact without turning a successful editor save into a failure.

Verification: `node --test test/explorershell.test.js` covers the matching
remote upload, local save, and other-session cases.
