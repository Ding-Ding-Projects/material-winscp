# Queue controller

`design/main/queue-controller.js` is the headless controller contract for a
queue window. `TransferQueue` remains the authority for byte movement; the
controller presents only actions that the current model state permits and
re-reads the model after every command. A renderer or IPC adapter can therefore
bind buttons to `action`, `label`, `ariaLabel`, and `disabledReason` without
inventing a second queue state.

## Actions

The global action list includes pause/resume all, start/stop processing, cancel
all active work, remove completed rows, and the once-empty choice. Each item
gets pause/resume, move earlier/later, cancel, retry when failed, and its own
post-transfer choice. Actions expose English and Hong Kong Cantonese labels,
an unambiguous English ARIA name, and a disabled reason when the model says the
operation is not applicable.

`retry-item` is deliberately restricted to `error` items. The queue keeps the
existing plan, entry index, and partial target so the transfer engine can resume
the failed entry where the protocol and copy settings allow it. A completed or
active item cannot be duplicated by pressing retry.

## State and failure behaviour

`QueueController.snapshot` contains the queue state, item views, a monotonic
revision, and the last once-done request. The controller listens to queue
updates and emits `changed` after reconciling from `queue.list()`, rather than
trusting a stale event payload. `dispatch()` waits for the real queue method,
rejects a false or zero result or missing method, then reconciles again. It
never emits a success result for a no-op or an unavailable command; the zero
case matters for `clear-done`, whose queue method returns the number removed.

Commands are serialized in submission order. This matters for IPC clients that
can deliver two clicks before the first queue operation completes: the second
command validates against the reconciled model produced by the first, instead
of invoking a stale action against the same item. A rejected command does not
poison the sequence, so later commands remain available.

Queue events are a failure boundary too. If reconciliation cannot read a queue
snapshot, the controller reports the error to an attached `error` listener; if
there is no diagnostic listener, it contains the failure rather than allowing
Node's special unhandled-`error` event to terminate the IPC host.

When the queue emits `idle` with a non-`none` action, the controller emits
`once-done-requested`. That event records what the queue requested; it does not
claim that disconnect, suspend, or shutdown has happened. The host that owns
those capabilities must perform and report that operation separately.
The emitted request snapshot already contains the matching `lastOnceDone`
record, so a prompt renderer can show the current request without racing a
later controller update.

## Configuration choices

The global choices are `none`, `disconnect`, `suspend`, `shutdown`, and `idle`.
Per-item choices are `none`, `disconnect`, `suspend`, and `shutdown`, matching
the copy parameter accepted by the transfer engine. `TransferQueue` exposes
validated `setOnceDone()` and `setItemOnceDone()` seams so callers cannot write
an unrecognised action into live queue state.

## Verification

Focused coverage is in `test/queue-controller.test.js`:

```text
node --test test/queue-controller.test.js
node --check design/main/queue-controller.js
node --check design/main/queue.js
```

The event-boundary regression tests cover both IPC-safe containment and
diagnostic delivery when an `error` listener is present.
The focused pause regression also verifies that concurrent commands call the
queue only once and reject the stale second command after reconciliation.

The queue controller is not an HTTP API. Postman artefacts are not applicable;
the feature is exercised through the local model and its event contract.
