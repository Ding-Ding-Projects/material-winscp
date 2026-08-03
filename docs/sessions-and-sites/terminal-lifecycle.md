# Terminal and session lifecycle

`SessionManager` owns live session identity; one `Terminal` is attached to each
session and owns its operation progress, directory caches and retry decisions.
When shutdown closes the last sessions, it publishes one final empty active
ownership state after per-session teardown, so a renderer cannot retain a dead
tab as the selected session.
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

When Terminal has nested progress scopes, foreground cancellation propagates
from the inner scope to every still-running enclosing scope. This mirrors
WinSCP's parent progress chain and prevents an inner transfer helper from
unwinding while the outer batch continues with later files. The scopes are
still stopped individually, so each emits its own single completion snapshot.

Session shutdown owns that foreground operation too: `Session.disconnect()`
asks the attached Terminal to cancel before it tears down the adapter. This
prevents a close or reconnect from leaving progress running against a dead
connection or leaving an operation-owned prompt unresolved. The cancellation
is best-effort and does not change the adapter cleanup result.

Prompts are refusal-safe. A dismissed or malformed answer chooses the safest
available answer; an empty answer set becomes cancellation. Security prompts
that are refused or cancelled never schedule an automatic reconnect.
Cancellation also wins if it arrives while the reconnect decision is displayed:
the pending operation returns without starting another reconnect attempt.
Concurrent fatal unwind paths share one reconnect decision per error object, so
cleanup cannot open duplicate prompts or let nested callers choose different
actions for the same dropped connection.

If an operation is waiting on a renderer confirmation, `cancelOperation()` also
settles that operation-owned prompt with the safe cancellation answer. A lost
or closed prompt therefore cannot leave the operation awaiting forever; the
original renderer promise is ignored after the operation has unwound.

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

Reconnect temporarily suspends transaction reads, but restores the suspension
state that existed before the retry. A configured `hostKey` is a hard identity
pin: a presented mismatch fails before the known-host store or approval prompt,
so it cannot be silently rescued by another trust record. If prompt delivery
fails because the renderer bridge is gone, the prompt is cancelled and removed
from the pending set.

The foreground retry budget treats a missing, blank, or zero
`sessionReopenTimeout` as unlimited. An explicitly negative, non-finite, or
otherwise malformed value fails closed and stops retrying.

Remote command execution fails closed at the session boundary. The adapter must
both advertise `caps.exec` and provide an `exec()` function; if either is
missing, `Session.exec()` returns the standard `NOT_SUPPORTED` error instead of
invoking an absent method. This protects reconnecting sessions from stale or
partially initialized capability metadata.

`homeDirectory()` records the directory actually returned by the adapter's
home-directory change, after removing its trailing slash. This matters for
servers that canonicalize a home alias or symlink: panel state and subsequent
relative paths must follow the server's landing directory, not the requested
alias. Adapters that do not return a landing path continue to use their home
path as the fallback.

## Directory-cache invalidation

The session listing cache returns copies, and Terminal invalidation clears the
affected directory, its parent and (for recursive changes) descendants. The
Terminal cache and the session panel cache are cleared together. A cleared or
invalidated current listing has timestamp `0`, so an explicit refresh performs
a new read instead of presenting stale entries.

Directory-change cache keys use a delimiter boundary. Clearing `/a` does not
clear `/ab`, and clearing target `/var/data` does not clear `/var/database`.
The root path remains exactly `/` when a trailing slash is added, so root
subtree invalidation and root-relative path joins do not acquire a doubled
separator.
An empty path is treated as invalid rather than as a subtree prefix, so a
malformed invalidation cannot clear every cached directory.

After a foreground file operation, `Terminal.reactOnCommand()` schedules a
current-directory reread when automatic post-operation reads are enabled. Both
`copyToRemote` and `copyToLocal` are treated as file-modifying commands, so a
download cannot leave the panel showing the pre-operation listing. Inside a
transaction the reread is deferred and coalesced with other file operations.
The server-side batch `copyFiles` path uses the same transaction boundary as
`moveFiles`: its target directory is invalidated after the batch, and the
current listing is reread once when the batch closes rather than once per file.
The single-file and batch duplicate paths call the adapter's `copyRemote()` contract
— the same method used by the protocol implementations — and preserve a declined
overwrite as `false` without pretending that a file changed or forcing a reread.
The renderer's queued remote-copy dialog currently uses `queue:add` directly;
these Terminal methods remain the foreground/core seam and are covered independently.

## Multi-session ownership

`SessionManager.setActive()` ignores an unknown id instead of falling back to a
different session. When the active session closes, ownership is cleared and the
next surviving session is announced. `closeOnFailure` disconnects and cleans a
failed session before removing it, including any reconnect timer.

Host-port identity is unambiguous for IPv6 sessions: an IPv6 literal is
bracketed before it is combined with its port (for example,
`[2001:db8::1]:2222`). The same key format is used for known host-key lookups,
so a trusted key cannot be lost behind the colons in the address.

## Verification

- `node --test test/terminal.test.js test/session-manager.test.js test/sessioninfo.test.js test/authenticate.test.js`
- `node --check design/main/terminal.js`
- `node --check design/main/session.js`
- `git diff --check`

The focused regressions cover operation teardown and snapshots, cancellation,
retry reconnects, exact budget boundaries, prompt refusal, stale adapter close
events, cache isolation/invalidation, and active-session ownership.
