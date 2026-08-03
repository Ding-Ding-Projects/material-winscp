## What it does

The remote-panel drag-out path uses a private temporary directory. Files are
downloaded there before Electron hands their paths to Windows Explorer; the
staging directory is removed after the shell has had time to copy the files.

## Configuration

The staging root and invalid-character replacement follow the active transfer
settings and operating-system temporary directory. There is no network fetch
or hidden shared staging location.

Each staged name is checked before it is joined to that directory. Separators,
`.` and `..`, and Windows device basenames (`CON`, `PRN`, `AUX`, `NUL`, `COM1`
through `COM9`, and `LPT1` through `LPT9`, including names with extensions) are
refused. This validation also applies when invalid-character replacement is
disabled: preserving a remote name must not turn a shell payload into a device
path or an unreliable Windows file operation.

The drag source requires real staged files and a non-empty drag icon. If a file
is missing, staging fails, or the platform cannot provide the shell surface,
the operation reports an error instead of offering a guessed path.

## Failure modes

Traversal-like names, device names, missing files, failed staging and an
unavailable shell surface are refused before an unsafe payload is offered.
The caller can retry with a valid name or use the in-app transfer commands.

## Security considerations

Staged paths remain under a private temporary directory and are validated
before joining. Device names and separators are rejected even when preserving
remote names was explicitly requested; the shell payload never becomes a
path traversal or device operation.

Regression coverage is in `test/shellintegration.test.js`, including preserved
device names and traversal-like separators. Run `npm test` to verify the full
suite.

## Suggested articles

- [Drag and drop](drag-drop.md)
- [Headless CLI](cli.md)
