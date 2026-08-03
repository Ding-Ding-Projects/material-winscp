# Watcher cancellation

The keep-up-to-date watcher invalidates an in-flight comparison when it is
stopped. Adapter listing is asynchronous, so a stop can happen while a
comparison is waiting on the local or remote server. The completed comparison
is discarded when its generation no longer matches the running watcher; it
cannot enqueue transfers after cancellation.

This is a cancellation boundary, not a rollback guarantee: work already
queued before `stopWatch` remains in the transfer queue and is governed by the
queue's own pause and cancellation controls. The regression is covered by the
in-flight comparison test in `test/sync.test.js`.
