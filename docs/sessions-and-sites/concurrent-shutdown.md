# Concurrent session shutdown

`Session.disconnect()` is the single shutdown gate for an adapter and the
Terminal that owns it. If a user close, a reconnect command, and a transport
failure cleanup arrive together, the calls share one in-flight shutdown
promise. The adapter is disconnected once, listeners and directory caches are
removed once, and the session reaches `closed` after that teardown completes.

This matters because adapter disconnect methods are not generally idempotent:
running two of them at once can race socket cleanup and emit a late `close`
event while a new connection is being prepared. The gate does not change the
meaning of `keepOpen`; it only serializes the teardown. A later call, after the
first shutdown has finished, may perform a new shutdown if the session has
been connected again.

## Verification

The regression test `concurrent disconnects share one adapter teardown` holds
the adapter teardown open, starts two disconnect calls, and verifies that both
callers receive the same promise while the adapter is asked to disconnect only
once.
