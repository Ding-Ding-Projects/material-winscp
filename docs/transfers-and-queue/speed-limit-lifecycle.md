# Changing a transfer speed limit

`TransferQueue.setSpeedLimit(id, bytesPerSecond)` changes the limit for a
queued or active item. A value of `0` means unlimited. The change is applied
to the item's next write schedule immediately; it does not leave the transfer
waiting for token debt reserved under the old limit.

This matters when a user pauses throttling during a large copy. The queue
resets the item's virtual-time bucket at the preference change, then applies
the new rate to subsequent chunks. Already-written bytes are unchanged and
the transfer's progress remains resumable.

The public method also normalizes headless inputs at the queue boundary. A
numeric string such as `"2048"` becomes `2048`; malformed, negative, and
non-finite values become `0` (unlimited), and the normalized number is written
to both the item snapshot and its copy parameters.

Invalid or missing item IDs return `false` and do not alter another transfer.
The queue emits an `item-updated` event after a valid change so the queue panel
can reflect the new value.

Verification:

```text
node --test test/queue.test.js
```

The regression named `setSpeedLimit immediately replaces an active bucket
schedule` proves that removing a live limit does not wait on the old bucket's
future reservations.
