# Terminal and session lifecycle

`SessionManager` owns live session identity; one `Terminal` is attached to each
session and owns its operation progress, directory caches and retry decisions.
The IPC layer addresses sessions by their runtime id and creates/reuses that
same Terminal, so a command for one tab cannot borrow another tab's cache or
operation state.

## Operation ownership and cancellation

An operation starts with one `OperationProgress` and ends in `operationStop`,
including when a callback throws. `done` is set only at stop, and the stop path
is idempotent so a cleanup race cannot emit a second completion. Cancellation is
monotonic: a later file-level cancellation cannot downgrade a full-operation or
remote-abort cancellation. The progress snapshot sent over IPC includes both
`inProgress` and `done`. The foreground transfer namespace also exposes
`transfer.cancel(sessionId)`; it raises the active session's cancellation state
and returns false when no operation is running. Background queue cancellation
remains separate and uses the queue item id.

Prompts are refusal-safe. A dismissed or malformed answer chooses the safest
available answer; an empty answer set becomes cancellation. Security prompts
that are refused or cancelled never schedule an automatic reconnect.
Cancellation also wins if it arrives while the reconnect decision is displayed:
the pending operation returns without starting another reconnect attempt.

## Reconnect policy

Unexpected drops use `security.sessionReopenAuto` as the base delay and a
bounded exponential backoff (`base`, `2×base`, …, capped at 60 seconds). A
single timer may be pending for a session. `security.sessionReopenTimeout` is a
total elapsed budget: an attempt is not scheduled at or beyond the deadline, nor
when its next backoff would cross it. A successful connection resets both the
attempt count and the budget window. Deliberate disconnects and stale adapter
events never reopen a session.

The foreground Terminal retry path reconnects through `Session.reconnect()` and
preserves the operation's directory position while disabling an automatic panel
read during the retry. Concurrent `connect()` calls share one in-flight promise;
disconnecting invalidates that generation, cleans the adapter, and prevents a
late result from changing the current session state.

## Directory-cache invalidation

The session listing cache returns copies, and Terminal invalidation clears the
affected directory, its parent and (for recursive changes) descendants. The
Terminal cache and the session panel cache are cleared together. A cleared or
invalidated current listing has timestamp `0`, so an explicit refresh performs
a new read instead of presenting stale entries.

Directory-change cache keys use a delimiter boundary. Clearing `/a` does not
clear `/ab`, and clearing target `/var/data` does not clear `/var/database`.

After a foreground file operation, `Terminal.reactOnCommand()` schedules a
current-directory reread when automatic post-operation reads are enabled. Both
`copyToRemote` and `copyToLocal` are treated as file-modifying commands, so a
download cannot leave the panel showing the pre-operation listing. Inside a
transaction the reread is deferred and coalesced with other file operations.

## Multi-session ownership

`SessionManager.setActive()` ignores an unknown id instead of falling back to a
different session. When the active session closes, ownership is cleared and the
next surviving session is announced. `closeOnFailure` disconnects and cleans a
failed session before removing it, including any reconnect timer.

## Verification

- `node --test test/terminal.test.js test/session-manager.test.js`
- `node --check design/main/terminal.js`
- `node --check design/main/session.js`
- `git diff --check`

The focused regressions cover operation teardown and snapshots, cancellation,
retry reconnects, exact budget boundaries, prompt refusal, stale adapter close
events, cache isolation/invalidation, and active-session ownership.
