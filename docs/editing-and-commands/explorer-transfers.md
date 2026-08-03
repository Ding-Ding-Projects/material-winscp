# Explorer-mode remote transfers

CustomScpExplorer shows one remote file panel, unlike Commander’s local/remote
pair. The remote copy and move actions therefore remain reachable in Explorer
mode even though no second panel is present.

Selecting `Copy`, `Copy in background`, or `Move` opens the normal transfer
dialog. Because Explorer has no local panel whose directory can be used as a
default, the destination field must be supplied by the user before the
operation starts. The transfer still goes through the renderer bridge and the
main-process transfer or queue path; no guessed local path is used.

## Verification

`test/commands.test.js` verifies that `RemoteCopyAction` and `RemoteMoveAction`
are enabled with a connected Explorer-mode context containing a selection and
no second panel. Commander mode continues to require both panels.
