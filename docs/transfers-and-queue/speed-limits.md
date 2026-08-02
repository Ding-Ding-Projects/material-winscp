# Speed limits

## What it does

A speed limit caps how fast a transfer consumes bandwidth, so a large upload
does not make a video call unusable. The limit is enforced by pacing reads from
the source stream — the transfer *asks for less data*, rather than downloading at
full speed and discarding. That distinction matters: pacing at the source means
the sender slows down too.

Limits exist at two levels: per transfer (`cpsLimit` in the transfer settings)
and per queue item, adjustable while the item is running.

## Configuration

| Option | Default | Meaning |
| --- | --- | --- |
| `cpsLimit` | `0` | Bytes per second for this transfer. `0` = unlimited. |

The UI presents it in KB/s (`speedLimit` in the dictionary), with a
free-entry field and a set of common values. The queue's per-item control offers
the same limits without disturbing the preset the item was created from.

Because the limit lives in the transfer settings, it can be part of a
[named preset](transfer-settings.md#presets) — "Overnight bulk upload" at
2 MB/s, "Working hours" at 200 KB/s.

## Behaviour worth knowing

- **The limit is per transfer, not per queue.** Two concurrent items at 500 KB/s
  each use 1 MB/s. Lower `transfersLimit` as well if a total ceiling is wanted;
  the queue panel shows the aggregate rate so the arithmetic is visible.
- **Pacing is measured over a rolling window**, not per chunk, so a limit does
  not turn into a stutter on a bursty link.
- **Changing a running item's limit takes effect on the next window**, within
  about a second. It does not restart the transfer.
- **Directory listings and metadata operations are not throttled.** Only file
  content is. Throttling listings would make browsing feel broken for no
  bandwidth benefit.
- **A limit larger than the link is a no-op**, not an error. The displayed rate
  simply never reaches it.

## Failure modes

| Situation | What the user sees | Recoverable |
| --- | --- | --- |
| A limit far below the protocol's chunk size | Progress becomes very coarse — one chunk may take many seconds. The field warns below a workable floor rather than accepting a limit that looks frozen. | Yes |
| Server-side or ISP throttling | The achieved rate sits below the configured limit. The queue shows achieved rate next to the limit so the two are distinguishable. | n/a |
| Limit set while a chunk is in flight | That chunk completes at the old rate. Expected, and not worth aborting a chunk over. | n/a |
| Very high limit on a slow disk | The bottleneck moves to local I/O. The rate display is the source of truth; no error is raised because nothing is wrong. | n/a |
| Keepalives during a heavily throttled transfer | Unaffected — they are not file content, so a slow transfer does not drop its session. | n/a |

## Security considerations

- Throttling is a **performance control, not a security control**. It does not
  obscure that a transfer is happening, and it does not defend against anything.
- **It does change timing.** On a link where an observer can see traffic volume,
  a constant-rate transfer is arguably more distinguishable than a bursty one.
  This is a theoretical consideration for a file transfer client, mentioned for
  completeness rather than as advice.
- **A limit does not reduce what is transferred.** Sensitive data at 10 KB/s is
  as exposed as at 10 MB/s; encryption is what protects it.

## Verification

- Pacing is tested against the local adapter over a synthetic clock: a 1 MB
  transfer at 100 KB/s must take approximately 10 seconds of virtual time, with
  the achieved rate staying inside a tolerance band.
- Mid-transfer limit changes are tested for effect within one window and for not
  restarting the stream.
- The "listings are never throttled" rule has a direct test, because it is the
  kind of thing an innocent refactor breaks.

Manual check: start a large download at 200 KB/s and watch the queue's achieved
rate settle near the limit within a couple of seconds without visible stalling.

## Suggested articles

- [The queue](queue.md) — concurrency, and why limits multiply across items.
- [Transfer settings](transfer-settings.md) — where `cpsLimit` lives and how presets carry it.
- [Resume](resume.md) — interacts with throttling on long transfers.
