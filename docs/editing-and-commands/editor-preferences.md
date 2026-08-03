# Editor preferences

## What it does

Preferences ▸ Editors stores an ordered set of file-mask associations. Each
association chooses the internal editor, an external program, or the operating
system's associated application. Matching is first-match-wins, so moving a row
can change which editor opens a file. The page includes a live probe and a
regex-capable search bar.

## Configuration

The list is edited as `prefs.editor.list` by the editor preferences dialog and
is persisted through the normal configuration bridge. An external association
requires a program path; `.!`/`%1`/`"%1"` placeholders control the file argument.

## Failure modes

Invalid or missing entries normalize to the internal editor and `*.*`.
Removing the final catch-all is confirmed and leaves unmatched files using the
internal editor. When the list is filtered, keyboard reordering stays within
the visible rows so hidden associations cannot be moved accidentally.

The modeless editor serializes close attempts while an asynchronous unsaved-
changes decision is open. Repeated Escape presses or close requests cannot
open duplicate prompts or run cleanup twice.

## Security considerations

External command lines are configuration data and are passed to the existing
editor manager. This dialog does not execute them; execution remains subject
to the editor launch path and its argument handling.

## Verification

`node --test test/editor-dialog.test.js` checks filtered keyboard movement,
serialized modeless closing, and the editor's save guards. The full `npm test`
suite is the release gate.

Suggested articles: [Editors](editors.md), [File masks](file-masks.md), and
[Search and regex](../search-and-regex/).
