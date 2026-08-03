## What it does

The remote-panel drag-out path uses a private temporary directory. Files are
downloaded there before Electron hands their paths to Windows Explorer; the
staging directory is removed after the shell has had time to copy the files.

## Configuration

The staging root and invalid-character replacement follow the active transfer
settings and operating-system temporary directory. There is no network fetch
or hidden shared staging location.

When files are copied in Windows Explorer, the main process reads the shell's
`FileNameW`/`FileName` clipboard format and decodes its NUL-separated paths.
Only absolute, NUL-free paths reach the ExplorerShell paste plan. The renderer
uses that plan for `PasteAction3`, so a session URL is offered to the Login
surface and is never mistaken for an upload filename.

Each staged name is checked before it is joined to that directory. Separators,
`.` and `..`, and Windows device basenames (`CON`, `PRN`, `AUX`, `NUL`, `COM1`
through `COM9`, and `LPT1` through `LPT9`, including names with extensions) are
refused. This validation also applies when invalid-character replacement is
disabled: preserving a remote name must not turn a shell payload into a device
path or an unreliable Windows file operation.

The drag source requires real staged files and a non-empty drag icon. If a file
is missing, staging fails, the transfer explicitly reports cancellation or
incompletion, or the platform cannot provide the shell surface, the operation
reports an error instead of offering a guessed or partial path.

Internal remote drops back onto the directory currently shown in the panel are
also refused as self-drops. A child directory remains a valid target.

## Failure modes

Traversal-like names, device names, missing files, incomplete staging,
self-drops and an unavailable shell surface are refused before an unsafe or
partial payload is offered. Incoming `LINK` and other unknown effects are
refused; a `MOVE` is downgraded to a safe `copy` only when move is disabled.
Malformed desktop paths and non-boolean move controls are rejected at IPC;
multiline clipboard text is not accepted as one path.
The caller can retry with a valid name or use the in-app transfer commands.

## Security considerations

Staged paths remain under a private temporary directory and are validated
before joining. Device names and separators are rejected even when preserving
remote names was explicitly requested; the shell payload never becomes a
path traversal or device operation. A self-drop is rejected before it can be
mistaken for a move onto the source directory.

Regression coverage is in `test/shellintegration.test.js`,
`test/explorershell.test.js`, `test/commands.test.js`, and
`test/e2e-reconcile.test.js`, including clipboard decoding, paste routing,
preserved device names, traversal-like separators, and the real IPC boundary.
Run the focused suites for this slice before the full project suite.

## Suggested articles

- [Drag and drop](drag-drop.md)
- [Headless CLI](cli.md)
