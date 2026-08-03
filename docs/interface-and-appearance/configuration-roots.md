# Configuration and extension roots

WinConfiguration resolves its application and user-data roots before looking
for `.WinSCPextension` files. Relative roots are anchored to the current
process directory, and Windows-style `%NAME%` environment references are
expanded case-insensitively. This keeps portable launches and tests aligned
with the path used to identify an extension.

The common extension directory is `<app root>/Extensions`; user extensions are
in `<user-data root>/Extensions`. Missing or unreadable directories are treated
as empty, so a filesystem problem cannot prevent the application from starting.

## Verification

`test/winconfig.test.js` verifies environment-variable and relative-root
resolution, extension ID matching, and the existing non-fatal missing-directory
behaviour.
