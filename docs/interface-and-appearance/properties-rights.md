# Properties and rights dialogs

The Properties and Rights dialogs treat file metadata defensively. Permission
values are accepted as three-digit octal, four-digit octal with a leading
zero, or a nine-character symbolic mode. A value that does not match one of
those forms is reported as unknown metadata; it must not make a multi-selection
properties view fail to open.

## Editing and failure semantics

Rights edits preserve tri-state bits for multi-selection: a disagreement is
shown as undefined and is left unchanged unless the user explicitly chooses a
state. The dialog sends either an octal mode or a partial symbolic mode to the
filesystem bridge. Bridge failures are surfaced as an error notification and
the dialog does not claim that permissions changed. Unsupported capabilities
are presented as unavailable rather than invoking an absent adapter method.

The Value (tags) sheet follows the same rule. It is rendered as an editable
surface only when the caller provides `caps.tags === true`, an array of current
tags, and an `onApplyTags(tags)` write callback. Tag metadata without that
complete seam remains hidden rather than exposing an OK action that cannot
persist the change.

Directory-size calculation is offered only when the selection contains a real
directory and the session capability does not explicitly set
`calculateSize: false`. If capability information is still being loaded, the
dialog may provisionally show the control and rebuild it when session info
arrives. A backend that reports the capability as unsupported therefore never
receives an accidental size request from this surface.

Owner, group, timestamps, and recursive application follow the same rule:
invalid or unavailable metadata is not invented, and a failed write remains a
failed write with the backend message retained for the user.

## Accessibility

Permission checkboxes and group controls have translated accessible names;
undefined multi-selection bits expose the explanatory hint. The rights sheets
use the tablist/tab/tabpanel pattern and retain keyboard focus. Inline octal
validation marks the field invalid while preserving the typed value.

The OK action waits for every requested metadata write and closes only after
success. A bridge failure or a no-op leaves Properties open. Tag editing keeps
its prompt open for a blank or duplicate key, and capability discovery retains
owner/group text typed before those fields are rebuilt. Local recursive size
calculation reports an unreadable directory and returns to the unknown-size
state instead of presenting an incomplete total as complete.

## Verification

`node --test test/dialogs-fileops.test.js` covers all 4096 permission modes,
symbolic/octal validation, tri-state intersection, and malformed metadata
handling, plus capability gating for directory-size calculation. The full
repository command is `npm test`.
