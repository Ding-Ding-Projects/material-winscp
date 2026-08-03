# Explorer properties dispatch

The Explorer shell now preserves the `CustomScpExplorer` properties split. A
local or local-local panel dispatches to `setLocalProperties`; a remote panel
dispatches to the protocol properties path with a capability-derived context.

Remote context includes mode, ACL, owner, group, ID and tag support, checksum
availability, and bounded owner/group suggestions. The first 100 directory
entries are considered, with selected entries added when they fall outside
that window, matching the upstream form's safeguard while keeping the selected
files editable. The adapter remains responsible for applying the resulting
change and the renderer remains responsible for presenting the dialog.

## Failure modes and security

No capability is enabled by this layer; it only reports capabilities already
declared by the active session. Missing operation handlers fail through the
existing `NotSupportedError` path. No credentials or file contents are copied
into the context.

## Verification

`test/explorershell.test.js` covers local dispatch and remote capability/token
context, including a selected entry beyond the 100-entry suggestion bound.
