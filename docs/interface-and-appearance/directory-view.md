# Directory view operations

`design/main/dirview.js` exposes pure operation plans for the Unix and local
directory views. `changeDirectoryPlan()` classifies the parent, home and root
targets, clears the stale listing, and records the focused name to restore if
the terminal rejects the request. `reloadDirectoryPlan()` invalidates the
previous path while preserving focus and scroll position.

Drag starts use `dragFileList()` to capture absolute paths at drag-start time;
the parent row is never draggable. `dragSourceEffects()` and
`chooseDragEffect()` implement WinSCP's copy-by-default policy, with Shift
selecting move only when move is enabled. `dropOperation()` rejects empty or
targetless drops and returns the source and destination directories for the
file-operation layer.

These functions intentionally perform no filesystem or terminal work. The
caller executes the returned plan and reloads the old listing after a failed
directory change. Focused coverage is in `test/dirview.test.js`.
