# Editors

## What it does

Opens a remote file for editing without an explicit download-edit-upload cycle:
the file is fetched to a temporary location, opened in an editor, watched, and
uploaded back each time it is saved.

Two kinds of editor are supported. The **internal editor** is built in — a text
editor with find and replace, encoding control and word wrap. An **external
editor** is any program on the machine, launched with the temporary path.

## Configuration

Under **Preferences → Editors**, stored in `PREF_DEFAULTS.editor`.

| Option | Default | Meaning |
| --- | --- | --- |
| `list` | `[{mask:'*.*', type:'internal'}]` | Ordered associations. First matching [mask](file-masks.md) wins. |
| `fontName`, `fontSize`, `fontCharset`, `fontStyle` | Consolas 11 | Internal editor font. |
| `autoFont` | `true` | Pick a font suited to the file's content. |
| `wordWrap` | `false` | |
| `tabSize` | `8` | |
| `encoding` | `auto` | `auto`, `utf8`, `utf8bom`, `utf16le`, `utf16be`, `ansi`. A forced BOM-capable encoding strips a BOM only when one is present; BOM-less files keep their first character. |
| `warnOnEncodingFallback` | `true` | Say when the chosen encoding could not represent the content. |
| `maxEditors` | `500` | Concurrent open editors. |
| `singleEditor` | `true` | Reuse one internal editor window with tabs. |
| `sDIShellEditor`, `sDIExternal` | `false` | Treat an external editor as single-document, so its exit means the edit finished. |
| `earlyClose` | `2` | Seconds within which an external editor exiting is treated as "it handed off to another instance" rather than "editing finished". |
| `keepTemporaryFiles` | `false` | Keep temporaries for debugging. Warns when on. |
| `warnOrphans` | `true` | Warn about temporary files left from a previous run. |
| `findText`, `replaceText`, `findMatchCase`, `findByMask`, `findWholeWord`, `findDown` | — | Remembered find state. |

The internal editor's find bar carries the
[regex builder](../search-and-regex/regex-builder.md) like every other search
surface — `findByMask` additionally allows a [file mask](file-masks.md) as the
search term.

The editor also provides selection-aware cut, copy, paste, delete, select-all,
undo and redo actions from its context menu and keyboard shortcuts. Paste reads
text through the application clipboard bridge, with the browser clipboard as a
fallback; read-only viewer windows disable mutating actions. Copy requires an
actual selection, so it never unexpectedly copies an entire file.

The menu commands remain keyboard-reachable while focus is in the document:
`Ctrl+S`/`Cmd+S` saves, `Ctrl+F`/`Cmd+F` focuses the find bar, `Ctrl+G`/`Cmd+G`
focuses Go to line, and `F3`/`Shift+F3` finds the next/previous match. These
handlers prevent the browser's document actions and call the same functions as
the visible controls, so a read-only viewer still refuses Save visibly and
without changing the text.

Undo and redo are available from the editor toolbar and context menu. `Ctrl+Z`/
`Cmd+Z` undoes the latest text change, `Ctrl+Y`/`Cmd+Y` redoes it, and
`Ctrl+Shift+Z`/`Cmd+Shift+Z` is an alternate redo shortcut. Each action is
disabled when its local history stack is empty or when the window is read-only;
reload and encoding changes start a fresh history for the newly loaded text.

## Behaviour worth knowing

### Ordering associations

The association list is first-match-wins, so its order is persisted as part of
`editor.list`. In Preferences → Editors, focus an association and use Up/Down
(or Left/Right) to move it one position; Home and End move it to the beginning
or end. The selected row remains selected, the list announces its new position,
and the change is saved through the normal Preferences save path. This is also
available through the visible Up and Down buttons for pointer users.

- **Temporary files live under the app's own data tree** (`paths.js`), never in
  the user's folders and never in a location another user can read.
- **Upload-on-save is watched, not polled.** Saving triggers an upload through
  the ordinary queue, so transfer settings and speed limits apply.
- **Editor integrations use the same IPC seam.** A native or renderer editor
  can call `editor:fileChanged` after writing the owned temporary file; the main
  process applies the same metadata check and conflict event as `fs.watch`.
- **`earlyClose` exists because of how modern editors launch.** Many exit
  immediately after handing the file to an already-running instance; treating
  that as "editing finished" would upload an unedited file and close the session
  too early.
- **Remote changes are detected.** Before uploading, the remote file's timestamp
  and size (and ETag for WebDAV) are compared with what was downloaded. A change
  means a conflict prompt, not a silent overwrite.
- **Saves are serialized and snapshot-based.** If Save is pressed again while an
  upload is pending, the second request joins the first instead of uploading a
  duplicate. Edits made while that upload is pending remain marked unsaved, so
  they cannot be mistaken for the text that was uploaded.
- **Watcher notifications are serialized too.** Windows can report one save as
  several overlapping filesystem events. The editor queues those callbacks per
  document, then rechecks the temporary file before each upload so the newest
  edit is not lost or uploaded out of order.

## Failure modes

| Situation | What the user sees | Recoverable |
| --- | --- | --- |
| External editor not found at its configured path | Named error, and the association is not silently reassigned. | Yes |
| External editor name cannot be resolved from `PATH` | Empty `PATH` entries are ignored; resolution fails closed rather than probing the filesystem root. | Yes |
| File changed on the server while being edited | A modal conflict prompt: upload anyway, download theirs, or save locally. This is a decision, so it is modal. | Yes |
| Editor exits before saving | Nothing is uploaded. The temporary is kept briefly so an accidental close is recoverable. | Yes |
| Encoding cannot represent an edited character | With `warnOnEncodingFallback`, a warning naming the character and offering UTF-8. Without it, the substitution is still recorded in the session log. | Yes |
| Binary file opened in the internal editor | Detected and refused with an explanation, rather than displaying and re-saving mangled bytes. | Yes |
| Very large file | Above a threshold the internal editor declines and suggests downloading; it does not attempt to load it entirely into memory. | Yes |
| Session lost while editing | The temporary survives. Reconnecting offers to upload it. | Yes |
| Watcher upload fails temporarily | The edit remains dirty; a later `editor:fileChanged` notification retries the same bytes even if the file was not modified again. | Yes |
| Orphaned temporaries from a crash | With `warnOrphans`, a startup notification listing them with an option to recover or discard. | Yes |
| `maxEditors` reached | Refused with a count, rather than opening an editor that cannot be tracked. | Yes |

## Security considerations

- **The temporary file is plaintext on local disk** for the duration of the
  edit, even when the site uses [at-rest encryption](../security-and-credentials/file-encryption.md).
  This is unavoidable — an editor needs plaintext — and it is stated where the
  feature is configured.
- **Temporaries are cleaned up on exit** per `temporaryDirectoryCleanup`.
  `keepTemporaryFiles` leaves sensitive content on disk and warns that it does.
- **An external editor receives a path and runs with the user's privileges.**
  Associating an editor is trusting it; the association editor shows the full
  command line before it is saved.
- **Filenames are quoted when passed to an external editor**, so a remote file
  named with shell metacharacters cannot become a command.
- **Conflict detection is best-effort** — it relies on the metadata the protocol
  provides. Where none is available the prompt says the check could not be made,
  rather than implying it passed.
- **The temporary directory layout can leak structure.** `temporaryDirectoryAppendPath`
  and `temporaryDirectoryAppendSession` mirror remote paths locally, which is
  convenient and mildly revealing; `temporaryDirectoryDeterministic` makes the
  names predictable, which is worse and off by default.

If an external editor cannot be started, the launch is rolled back as one
operation: its watcher and registry entry are removed and the downloaded
temporary is deleted. This prevents a broken association from leaving a
plaintext orphan that looks like an active edit. The failure is still returned
to the caller with the executable error so the association can be corrected.

## Verification

- Association matching is tested against the mask engine, including ordering and
  first-match-wins.
- The download-edit-upload cycle is tested against the local adapter with
  simulated saves, asserting one upload per save.
- Conflict detection is tested by mutating the remote file between download and
  save.
- `earlyClose` is tested with a synthetic editor that exits immediately.
- Encoding round trips are tested for UTF-8 with and without BOM, and for the
  ANSI fallback path including the warning. Forced UTF-8/UTF-16 encodings are
  also tested against BOM-less files so selecting an encoding cannot discard
  their leading bytes.
- Orphan recovery is tested by leaving temporaries behind and restarting.
- A failed external launch is tested for registry, watcher and temporary-file
  cleanup.
- Renderer save lifecycle invariants are tested for serialization, snapshot
  ownership, and release of the in-flight guard after failure.
- Renderer editor action wiring is tested for clipboard operations, read-only
  guards, and undo/redo exposure.
- Overlapping `editor:fileChanged` callbacks are tested to ensure uploads run in
  order and the final temporary-file contents reach the remote file.

## Suggested articles

- [File masks](file-masks.md) — the association language.
- [Custom commands](custom-commands.md) — the other way to act on a selected file.
- [At-rest encryption](../security-and-credentials/file-encryption.md) — why editing means plaintext locally.
- [The regex builder](../search-and-regex/regex-builder.md) — the find bar's builder.
