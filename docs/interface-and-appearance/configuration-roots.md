# Configuration and extension roots

WinConfiguration resolves its application and user-data roots before looking
for `.WinSCPextension` files. Relative roots are anchored to the current
process directory, and Windows-style `%NAME%` environment references are
expanded case-insensitively. This keeps portable launches and tests aligned
with the path used to identify an extension.

The common extension directory is `<app root>/Extensions`; user extensions are
in `<user-data root>/Extensions`. Missing or unreadable directories are treated
as empty, so a filesystem problem cannot prevent the application from starting.

`configurationRoots()` makes the portable decision explicit: an existing
`winscp.ini` beside the application selects portable mode unless the launcher
passes `portable: false`; callers can also force portable mode for embedded
launchers and tests. `WinConfiguration` exposes the resolved `appRoot`,
`userDataRoot` and `portableMode` values, plus `flush()` and `reload()` so an
external import can be persisted and then re-read without stale cached models.
Flush remains atomic through `Config`.

## Verification

`test/winconfig.test.js` verifies environment-variable and relative-root
resolution, extension ID matching, automatic and explicit portable-mode
selection, persistence round-tripping, and the existing non-fatal
missing-directory behaviour.
