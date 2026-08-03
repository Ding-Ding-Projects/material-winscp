# Drag and drop

## What it does

Drag/drop is handled by the Explorer orchestration layer and the Windows shell
integration. The renderer supplies an event's effect and target information;
the main process decides whether the operation is safe before starting a
transfer.

## Configuration

The queue drop uses the configured default download directory. Other targets
come from the active Explorer, fake-file, or external-extension handshake;
there is no hidden fallback directory.

Desktop drops onto the remote panel go through the same main-process drag/drop
operation as panel-to-panel drops. That keeps transfer confirmation, queue
selection, move semantics and protocol capability checks in one place; the
renderer does not silently turn a requested move into an unconditional queue
copy.

In-app panel drops also negotiate through `explorer:dropEffect` immediately
before choosing the renderer action. The target session is selected first, and
a refused or unavailable negotiation stops the drop instead of letting the
renderer’s optimistic drag-over preview start a move.

## Targets and safety

- A drop onto the queue is forced into the background and uses the configured
  default download directory.
- The queue drop is refused when that directory is missing or contains only
  whitespace. An empty target must not be passed to a file operation because
  it could otherwise resolve relative to the app's process working directory.
- A drop with no known Explorer, fake-file, external-extension, or queue target
  is refused and reported as target unknown.
- Whitespace-only fake-file and external-extension handshake targets are also
  refused as target unknown; they must not become the current working directory.
- A remote-panel drop onto free space is refused; a target directory is
  required. Ctrl requests copy, while a move is used only when the session
  advertises remote move support.
- `dDAllowMove` enables move effects, and `dDAllowMoveInit` starts an allowed
  drag as move by default; Ctrl requests a copy. With move disabled, a MOVE
  effect is safely downgraded to copy.
- Refused, cancelled, and unknown effects never become uploads. Ambiguous
  drag-out results prefer copy unless the Windows effect explicitly contains
  move, protecting the remote source from accidental deletion.
- Combined or unknown final effects are refused; only an exact COPY or MOVE
  effect can select a remote operation.
- Malformed in-app payloads, missing source panels, missing targets,
  disconnected sessions and explicit protocol refusals are reported before any
  transfer begins.
- In-app payload paths must be non-empty strings with no NUL, duplicate paths,
  or unknown effect values. Desktop-drop paths are re-validated at the main
  IPC boundary as absolute local paths; malformed `allowMove` and `dragDrop`
  flags are refused instead of being coerced into a potentially destructive
  move.
- Queue, fake-file, and external-extension drop targets must be absolute local
  paths. Relative targets are refused before they can resolve against the
  application process directory.

Clipboard paste uses the same ExplorerShell decision path. Windows Explorer's
`FileNameW`/`FileName` clipboard formats are decoded into absolute paths before
they can become an upload. Relative, NUL-containing, or malformed clipboard
entries are ignored, and multiline text is not treated as one directory path.
Pasting a session URL opens the Login surface rather than queuing the URL as a
file.

## Accessibility and feedback

Drop refusal is a state decision, not a silent no-op: callers should expose the
returned refusal reason through the app's non-blocking notification surface.
Keyboard users can use the equivalent copy/move commands and queue controls;
drag/drop is never the only route to a transfer.

## Failure modes

Missing targets, empty queue destinations, unavailable capabilities, malformed
payloads and ambiguous effects are refused before a transfer begins. The
refusal reason is recoverable by choosing a valid target, reconnecting, or
using the equivalent command.

## Security considerations

Unknown effects never become uploads, and local staging paths are validated
before they reach the shell. A drag gesture cannot bypass read-only or
protocol-capability checks.
Remote names are also checked after Windows-invalid-character replacement. If
two names would become the same case-insensitive local name, staging refuses
the whole drag instead of letting one file overwrite the other.

## Verification

The focused regression coverage is in `test/scp-commander-parity.test.js`,
`test/explorershell.test.js`, `test/shellintegration.test.js`,
`test/commands.test.js`, and the real-bridge checks in
`test/e2e-reconcile.test.js`. It verifies payload validation, clipboard file
decoding, paste routing, move/copy effects, disconnected-session and capability
refusals, and the shared target policy.
Run `npm test` to execute the complete test suite.

## Suggested articles

- [Headless CLI](cli.md)
- [Windows shell integration](shell-integration.md)
- [Transfers and the queue](../transfers-and-queue/queue.md)

## Deterministic target simulation

winscp drop target uses the same `resolveDropTarget` policy as `explorer:dropTarget`. Supply `--queue --default-download-target PATH`, `--fake-file-target PATH`, or `--external-drop-directory PATH`; omitted or blank targets exercise refusal without starting Electron or Explorer.
