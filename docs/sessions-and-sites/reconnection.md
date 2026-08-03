# Reconnection, keepalives and stall detection

## What it does

Connections drop. Laptops sleep, VPNs flap, NAT tables expire, servers restart.
Reconnection makes that an interruption rather than a loss: the session
re-establishes itself, the panels return to where they were, and queued
transfers resume.

## Configuration

Keepalives are per site; reconnection policy is global, under
`PREF_DEFAULTS.security`.

| Option | Default | Meaning |
| --- | --- | --- |
| `pingInterval` (per site) | `30` | Seconds between keepalives. |
| `pingType` (per site) | `off` | `off`, `null` (protocol-level no-op), `dummy` (a harmless command). |
| `ftpPingInterval`, `ftpPingType` | `30`, `dummy` | FTP's own control-channel keepalive. |
| `sessionReopenAuto` | `5000` | Milliseconds before an automatic reconnect after an unexpected drop. `0` disables it. |
| `sessionReopenBackground` | `2000` | The same, for a session with queued work — shorter, because something is waiting. |
| `sessionReopenTimeout` | `0` | Total milliseconds to keep trying. `0` = indefinitely. |
| `sessionReopenAutoStall` | `0` | Milliseconds of no progress before a transfer is treated as stalled. `0` = never. |
| `sessionReopenAutoIdle` | `true` | Reconnect an idle session when the user acts, rather than eagerly. |
| `timeoutOnStartup` | `false` | Apply the connect timeout to the very first connection too. |

## Behaviour worth knowing

- **Retries back off.** The interval grows on repeated failure, so a server that
  is down does not receive a connection attempt every two seconds for an hour.
- **Idle sessions reconnect lazily.** With `sessionReopenAutoIdle`, a session
  nobody is using does not reconnect until it is needed. This is the difference
  between a laptop waking to twelve reconnect attempts and waking to none.
- **Queued work reconnects eagerly**, on the shorter `sessionReopenBackground`.
  That is the interval the queue waits before touching the adapter again after a
  dropped transfer; the session's own reconnect timer runs in parallel on
  `sessionReopenAuto`.
- **`sessionReopenTimeout` bounds a running transfer as well as a session**, and
  it bounds both transfer paths identically — the foreground engine
  (`transfer:copyToRemote`) and the queue (`queue:add`). Two qualifications
  matter:
  - **`0` means indefinitely, and `0` is the default.** At the shipped setting
    nothing gives up on time, on either path. The budget is what the user opts
    into by setting "Keep reconnecting for".
  - **Only FTP and FTPS carry the budget at all.** Every other protocol
    reconnects without a ceiling, matching WinSCP, which sets the flag in its
    FTP back end's two transfer entry points and nowhere else. FTP is singled
    out because its second connection lets a stalled data transfer drag the
    control connection down, so it can fail-and-reconnect in a tight loop while
    moving nothing. A protocol adapter can opt in with
    `caps.limitTransferReconnects`.
  - **Bytes that actually moved restart the window.** A transfer making progress
    between drops is not the failure the ceiling exists to stop.
- **Stall detection is off by default.** A slow transfer and a dead one look
  identical from the outside; a badly-set stall timeout aborts genuinely slow
  transfers, which is worse than the problem.
- **Reconnection restores context**: the remote directory, the panel filter, sort
  order and selection. It does not silently re-run an operation that was in
  flight — that decision belongs to the queue.
- **Tunnelled sessions re-establish both hops** in order.

## Failure modes

| Situation | What the user sees | Recoverable |
| --- | --- | --- |
| Server is down | Retries with backoff until `sessionReopenTimeout`. The tab shows a reconnecting state with the next attempt time; the notification centre keeps the history. | Yes |
| Password needed and not remembered | Exactly one modal prompt, not one per retry. Cancelling stops the retry loop rather than looping on the prompt. | Yes |
| Host key changed after the drop | Reconnection **stops** and asks. It is never auto-accepted, because a key change during a drop is exactly the interesting case. | Yes |
| Reconnect succeeds but the directory is gone | The panel opens at the nearest existing ancestor and says so. | Yes |
| Transfer interrupted by the drop | The item fails with its byte offset kept and is retried after reconnect, resuming where the protocol allows. | Yes |
| Keepalive itself keeps the session alive but the server has forgotten it | Detected on the next real command. The reconnect is transparent. | Yes |
| `pingType: dummy` on a strict server | Some servers log or reject the no-op command. Switch to `null` or `off`. | Yes |
| Machine sleeps for hours | On wake, everything is stale. Idle sessions reconnect on use; sessions with queued work reconnect immediately. | Yes |
| Reconnect loop against an authentication failure | Auth failure is not a transient error: retries stop and the tab shows the failure with a manual Reconnect. | Yes |

## Security considerations

- **A host key or certificate change always stops reconnection.** Automatic
  re-verification would defeat the entire point of pinning, and a drop is a
  plausible cover for an interception attempt.
- **Unattended reconnection needs a stored credential**, which is a deliberate
  trade the user makes by saving a password — see
  [credential storage](../security-and-credentials/credential-storage.md).
- **Keepalives are traffic.** On a monitored link they reveal that a session is
  open even when idle. `pingType: off` is available for anyone who cares.
- **Retry loops are rate-limited and backed off**, so a misconfigured site cannot
  hammer a server into treating this client as an attacker.
- **Authentication failures never retry**, which prevents an accidental
  brute-force against an account with a lockout policy.

## Verification

- Backoff, the timeout ceiling and the difference between idle and busy
  reconnect delays are tested against a synthetic adapter that fails on demand.
- "One prompt, not one per retry" is tested directly, because it is the most
  irritating possible regression.
- Host-key-change-halts-reconnect is tested by changing the fingerprint between
  the drop and the retry.
- Auth-failure-does-not-retry is tested to assert exactly one attempt.
- Context restoration (directory, filter, sort, selection) is round-trip tested.

## Suggested articles

- [Tunnels and proxies](tunnels-and-proxies.md) — reconnecting a two-hop connection.
- [The queue](../transfers-and-queue/queue.md) — what happens to in-flight transfers.
- [Host key verification](../security-and-credentials/host-keys.md) — why a changed key stops everything.
- [Notifications](../interface-and-appearance/notifications.md) — how reconnection reports itself without a modal.
