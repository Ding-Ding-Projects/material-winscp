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

## Targets and safety

- A drop onto the queue is forced into the background and uses the configured
  default download directory.
- The queue drop is refused when that directory is missing or contains only
  whitespace. An empty target must not be passed to a file operation because
  it could otherwise resolve relative to the app's process working directory.
- A drop with no known Explorer, fake-file, external-extension, or queue target
  is refused and reported as target unknown.
- A remote-panel drop onto free space is refused; a target directory is
  required. Ctrl requests copy, while a move is used only when the session
  advertises remote move support.
- Refused, cancelled, and unknown effects never become uploads. Ambiguous
  drag-out results prefer copy unless the Windows effect explicitly contains
  move, protecting the remote source from accidental deletion.

## Accessibility and feedback

Drop refusal is a state decision, not a silent no-op: callers should expose the
returned refusal reason through the app's non-blocking notification surface.
Keyboard users can use the equivalent copy/move commands and queue controls;
drag/drop is never the only route to a transfer.

## Failure modes

Missing targets, empty queue destinations, unavailable capabilities and
ambiguous effects are refused before a transfer begins. The refusal reason is
recoverable by choosing a valid target or using the equivalent command.

## Security considerations

Unknown effects never become uploads, and local staging paths are validated
before they reach the shell. A drag gesture cannot bypass read-only or
protocol-capability checks.

## Verification

The focused regression coverage is in `test/explorershell.test.js`. It verifies
that a valid queue target is accepted and forced into the queue, while empty,
whitespace-only, missing, and null targets are refused before any transfer can
start. Run `npm test` to execute the complete test suite.

## Suggested articles

- [Headless CLI](cli.md)
- [Windows shell integration](shell-integration.md)
- [Transfers and the queue](../transfers-and-queue/queue.md)
