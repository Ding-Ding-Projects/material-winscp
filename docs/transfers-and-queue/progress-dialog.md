# Transfer progress dialog

The transfer progress surface is a floating, non-modal view. It can stay open
while the file panels remain usable, and Escape or the close button only hides
the view; it does not cancel work.

## State and cancellation

The cancel action is disabled while its asynchronous queue request is pending.
This prevents keyboard repeat or double-click input from submitting duplicate
cancellations. The dialog announces “Cancelling transfer…” in its live status
region, then closes only after the queue confirms cancellation. If the request
fails, the dialog remains open, announces the failure, and also records it as a
notification so the transfer is not mistaken for a successful cancellation.

Progress bars expose bounded percentage values, the throughput graph has an
accessible label, and long paths retain their full value in a tooltip while
remaining ellipsized in narrow layouts. A missing queue item is rendered as a
stable, actionable-free state rather than throwing or blocking the application.

## Verification

`node --check design/renderer/ui/dialogs/progress.js` verifies the module parses.
The full renderer and queue coverage is run with `npm test` (`node --test
test/`).
