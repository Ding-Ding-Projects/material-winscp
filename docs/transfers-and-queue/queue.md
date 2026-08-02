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
- **Progress never blocks a reply.** Long work pushes to `event:progress` with a
  correlation id; the IPC call that started it returns straight away.
- **An item's settings are a snapshot.** See the note in the
  [category index](README.md) — this is intentional.
- **Failures are per item.** One unreadable file in a 4,000-file upload fails
  that file. `continueOnError` (in the environment preferences) controls whether
  the *foreground* progress dialog stops to ask.

## Failure modes

| Situation | What the user sees | Recoverable |
| --- | --- | --- |
| Session drops with items queued | Items pause and the session auto-reconnects per `security.sessionReopen*`. Without a remembered password, one modal prompt appears — once, not per item. | Yes |
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
- Throughput and parallelism against real servers are checked manually; this
  article does not claim automated coverage for them.

## Suggested articles

- [Transfer settings](transfer-settings.md) — what an item's snapshot actually contains.
- [Resume](resume.md) — what happens to a failed item's byte offset.
- [Speed limits](speed-limits.md) — throttling without pausing.
- [Notifications](../interface-and-appearance/notifications.md) — why queue results are toasts, not dialogs.
