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

Native change sources may also report an invalid monitor with an `Error`
callback. The watcher closes that source and stops before emitting the error,
so callbacks already queued by the operating system cannot start a new
comparison after the monitor has failed. This mirrors WinSCP's
`SynchronizeInvalid` path and is covered by the invalid native change-source
test in `test/sync.test.js`.

The keep-up-to-date window also keeps its close action disabled while start or
stop IPC is pending. Escape follows the same rule. This prevents the renderer
from detaching before a late start reply can be paired with its watcher, which
would otherwise leave a running watcher with no visible stop control.
