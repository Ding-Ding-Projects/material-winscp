# The transfer queue

## What it does

`design/main/queue.js` owns every byte that moves. It runs a bounded number of
transfers in parallel, keeps each item's own settings, reports progress without
blocking anything, and survives individual failures without taking the batch
down with them.

An item passes through `queued → active → done | failed | cancelled`. Failed
items keep their byte offset so a retry can resume rather than restart, where
the protocol allows it.

## Configuration

Under **Preferences → Transfer → Background**, stored in `PREF_DEFAULTS.queue`.

| Option | Default | Meaning |
| --- | --- | --- |
| `transfersLimit` | `2` | Concurrent transfers. Raising it helps on high-latency links and hurts on saturated ones. |
| `enabledByDefault` | `true` | Whether new transfers start queued rather than waiting. |
| `parallelDuplicateTransfers` | `true` | Split one large file across several connections when the protocol supports it. |
| `individualTransfers` | `false` | Treat a folder as many items rather than one, so progress is per file. |
| `keepDoneItemsFor` | `15` | Seconds a completed item stays visible. `-1` keeps them forever, `0` removes them immediately. |
| `autoPopup` | `true` | Show the queue panel when work starts. |
| `view` | `show` | `show`, `hideWhenEmpty`, `hide`. |
| `toolbar`, `fileList` | `true`, `false` | Queue toolbar; per-item file list. |
| `rememberPassword` | `false` | Keep the session password in memory so a queued item can reconnect unattended. |
| `noConfirmations` | `true` | Queued items do not stop to ask about overwrites — they use the item's own rule. |
| `autoPopupPrompts` | `true` | Bring a genuinely blocking prompt to the front rather than leaving it buried. |
| `onceEmpty` | `none` | `none`, `disconnect`, `suspend`, `shutdown`, `idle` when the queue drains. |
| `disconnectOnceEmpty` | `false` | Shorthand for the `disconnect` action. |

## Behaviour worth knowing

- **Ordering is stable.** Items run in the order they were added; raising
  `transfersLimit` starts more of them, it does not reorder them. Items can be
  moved by hand, and a moved item keeps its settings.
- **Pause is real.** Pausing suspends the stream rather than buffering it, so a
  paused transfer stops consuming bandwidth immediately.
- **Cancellation is checked after throttling as well as before it.** If a
  cancellation arrives while a transfer is waiting for its speed-limit token,
  the delayed chunk is discarded before it reaches the destination. The same
  guard applies to the final text-conversion tail and parallel ranged writes.
- **Progress never blocks a reply.** Long work pushes to `event:progress` with a
  correlation id; the IPC call that started it returns straight away.
- **An item's settings are a snapshot.** See the note in the
  [category index](README.md) — this is intentional.
- **Empty-directory planning agrees across transfer paths.** With
  `excludeEmptyDirectories` enabled, queued local uploads descend into local
  directory symlinks the same way as the foreground engine. Remote-source
  plans still respect `followDirectorySymlinks`, so a remote symlink is not
  followed unless the user explicitly enables it. A symlink-only directory is
  therefore not created merely because the queue and engine took different
  routes to the same copy operation.
- **Failures are per item.** One unreadable file in a 4,000-file upload fails
  that file. `continueOnError` (in the environment preferences) controls whether
  the *foreground* progress dialog stops to ask.
- **Completed rows are swept, failed rows are not.** `keepDoneItemsFor` is read
  live, so changing it applies to the queue that is already running; each
  completed item gets its own expiry timer, so the last row of a batch
  disappears on time instead of waiting for the next transfer. An item that
  ERRORED is never swept — the user has to see a failure to retry it. This is
  `TTerminalQueue::ProcessEvent` (core/Queue.cpp:1018-1035).
- **The finish beep is measured over the batch.** `beepOnFinish` and
  `beepOnFinishAfter` (environment preferences, not queue ones) sound once when
  the queue drains, timed from the moment work arrived at an empty queue —
  WinSCP's `QueueOperationStart` / `OperationComplete` pair. The threshold is a
  minimum duration and is strictly "longer than", so `0` seconds means every
  batch that took a measurable moment. The queue owns no I/O: it emits `beep`
  and `design/main/ipc.js` calls `shell.beep()`.
- **A dropped connection is bounded by `security.sessionReopenTimeout`, not by a
  retry count.** The queue has no reconnect policy of its own: WinSCP's queue
  items reconnect through `TTerminal::CopyToRemote` like everything else, so a
  queued transfer gets the same budget as a foreground one. Three things follow,
  and all three are the preference behaving as documented rather than the queue
  being lax:
  - `sessionReopenTimeout: 0` — the default — means **indefinitely**.
  - Only FTP and FTPS have a budget at all; every other protocol reconnects
    without a ceiling, exactly as upstream. See
    [Reconnection](../sessions-and-sites/reconnection.md).
  - Bytes that actually moved between drops restart the window.

  `TransferQueue` still accepts a `maxReconnects` option as a hard count-based
  cap for an embedder that wants one. It defaults to `0` (off), because it has
  no counterpart in `Queue.cpp` and nothing in the app sets it.

## Failure modes

| Situation | What the user sees | Recoverable |
| --- | --- | --- |
| Session drops with items queued | Items pause and the session auto-reconnects per `security.sessionReopen*`; the queue waits `sessionReopenBackground` between its own attempts and gives up only when `sessionReopenTimeout` is exceeded (never, at the default of `0`). Without a remembered password, one modal prompt appears — once, not per item. | Yes |
| The session behind a queued item is closed while it is reconnecting | The item fails with the connection error rather than retrying into a session that no longer exists. Closing the session is this port's Abort answer to WinSCP's reconnect query. | n/a |
| Target file exists | Resolved by the item's own overwrite rule, decided when it was queued. Only a foreground transfer with `confirmOverwriting` stops to ask. | Yes |
| Local disk fills | Every active item fails with `ENOSPC`; resumable partials are kept. The queue does not keep retrying into a full disk. | Yes |
| An item is cancelled mid-write | Partial target removed, unless it is a `.filepart` being kept for resume. | n/a |
| `onceEmpty` is `shutdown` and a transfer fails | The action does **not** run. A failed queue never shuts the machine down. | n/a |
| Queue panel hidden while work runs | A corner notification still reports completion and failure, and the notification centre keeps the history. Work is never invisible. | n/a |
| App closed with items queued | A blocking confirmation lists what would be lost — this is a decision, so a modal is correct here. | Yes |

## Security considerations

- **`rememberPassword` keeps a credential in memory for the life of the app.**
  It is never written to disk by this option — that is what saving a site
  password does, through `crypto.js`. The distinction is stated in the UI.
- **`onceEmpty: shutdown` is a destructive action triggered by a background
  event.** It runs only on a fully successful queue, gives a cancellable
  countdown, and the countdown notification is not auto-dismissed.
- **Queue state is not persisted across restarts.** Doing so would mean writing
  the target paths — and potentially the credentials to reach them — to disk.
  Re-queuing after a crash is the safer trade, and the release notes say so.
- **Progress events carry paths.** They stay on the local IPC channel and never
  reach a log file unless session logging is enabled.

## Verification

- Queue mechanics — ordering, concurrency limits, pause/resume, per-item
  settings isolation, failure containment — are tested against the local adapter
  with synthetic delays, so no network is involved.
- `onceEmpty` action gating (that a failure suppresses it) has a direct test.
- The reconnect budget is covered at `sessionReopenTimeout: 0` (unlimited, the
  shipped default), at a non-zero value (the window expires and the item is
  reported), with bytes moving between drops (the window restarts), and for a
  protocol with no budget at all — plus an agreement test asserting the queue
  and the foreground engine reach the same verdict from the same adapter. The
  clock is injected, so no test waits for a timeout.
- That the *main process* answers the queue's `reconnect` event is tested
  separately, because a listener that neither retries nor fails leaves the item
  awaiting a promise nothing can settle: the queue skips its own unsupervised
  backoff the moment anything subscribes.
- Throughput and parallelism against real servers are checked manually; this
  article does not claim automated coverage for them.

## Suggested articles

- [Transfer settings](transfer-settings.md) — what an item's snapshot actually contains.
- [Resume](resume.md) — what happens to a failed item's byte offset.
- [Speed limits](speed-limits.md) — throttling without pausing.
- [Notifications](../interface-and-appearance/notifications.md) — why queue results are toasts, not dialogs.
