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

Owner, group, timestamps, and recursive application follow the same rule:
invalid or unavailable metadata is not invented, and a failed write remains a
failed write with the backend message retained for the user.

## Accessibility

Permission checkboxes and group controls have translated accessible names;
undefined multi-selection bits expose the explanatory hint. The rights sheets
use the tablist/tab/tabpanel pattern and retain keyboard focus. Inline octal
validation marks the field invalid while preserving the typed value.

## Verification

`node --test test/dialogs-fileops.test.js` covers all 4096 permission modes,
symbolic/octal validation, tri-state intersection, and malformed metadata
handling. The full repository command is `npm test`.
