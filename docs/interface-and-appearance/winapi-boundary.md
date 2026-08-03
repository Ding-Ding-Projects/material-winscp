# WinApi boundary

`design/main/winapi.js` is the small platform boundary for behaviour that was
historically scattered across WinSCP's `windows/WinApi` unit. The name is a
porting label, not a promise that every host has a Win32 implementation.

## What it provides

- Windows drive and UNC-share normalization, including slash conversion and
  long-path prefixes (`\\?\C:\...` and `\\?\UNC\...`). POSIX hosts keep POSIX
  separators and report drive normalization as unsupported.
- Logical viewport and display-scale metrics. Electron bounds are logical
  pixels; `physicalViewport` is derived only when a display scale is known.
- Keyboard notation for Windows/Linux (`Ctrl+Shift+P`) and macOS (`⌘⇧P`),
  while keeping the underlying modifier names (`Control`, `Meta`, `Alt`, and
  `Shift`) explicit.
- Shell capability checks and safe `openFile`, `revealFile`, and
  scheme-restricted `openExternal` operations. Electron's non-empty
  `shell.openPath` error is returned as a failure rather than being treated as
  success.
- Injected Unicode clipboard text copying through `copyText`. The operation
  requires an explicit `clipboard.writeText` adapter on every platform; a
  missing adapter returns `UNSUPPORTED_PLATFORM` or `UNSUPPORTED_OPERATION`
  and never claims that text was copied.
- An injected Windows-only backend through `callWindows`. On every non-Windows
  platform it is ignored without probing or enumerating it, and calls return a
  structured `UNSUPPORTED_PLATFORM` result. On Windows, only non-empty string
  names of own callable backend properties are reachable; inherited properties
  such as `constructor` are rejected as `UNSUPPORTED_OPERATION`.

## Integration and failure behaviour

Create the boundary in the main process with `createWinApi({ shell, clipboard,
screen, windows })`. The renderer must continue to use the existing preload/API
surface; it must not receive Node, Electron, or a native backend. A native
adapter can be supplied for Windows-only metrics or APIs, but it must be
injected only by a Windows main-process path.

Operations return `{ ok: true, ... }` or `{ ok: false, code, operation,
message, platform }`. Invalid paths are rejected before shell calls. Missing
shell methods return `UNSUPPORTED_OPERATION` on Windows and
`UNSUPPORTED_PLATFORM` elsewhere. No unsupported result claims that a file was
opened, revealed, or that a Windows API succeeded.

## Security and portability notes

The boundary does not execute a command shell, expand environment variables,
or accept arbitrary external URL schemes. Only `http:`, `https:`, and `mailto:`
are eligible for external opening. Native errors are truncated before they
leave the boundary. Windows device-specific behaviour remains behind the
injected backend, so a Linux or macOS test cannot accidentally exercise a
Windows-only call.

## Verification

```text
node --test test/winapi.test.js
node --check design/main/winapi.js
git diff --check
```

The focused suite covers drive/UNC/long-path normalization, POSIX behaviour,
invalid input, display metrics, platform keyboard notation, shell capability
checks, non-Windows backend isolation, native failure results, and URL scheme
filtering.
