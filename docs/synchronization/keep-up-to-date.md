# Keep remote directory up to date, and synchronized browsing

## What they do

Two continuous features, often confused, doing different things.

**Keep remote directory up to date** watches a local directory and uploads
changes as they happen. It is a one-way, continuous synchronize: save a file in
your editor and it appears on the server a moment later.

**Synchronized browsing** links the two panels' navigation. Entering
`src/components` locally also enters `src/components` remotely. It moves *you*,
never your files.

## Configuration

### Keep up to date

| Control | Default | Meaning |
| --- | --- | --- |
| Local directory | current | What is watched. |
| Remote directory | current | Where changes go. |
| Recurse subdirectories | on | Watch the whole tree. |
| Delete remote files | **off** | Mirror deletions upward. Off by default, and deliberately so. |
| Existing files only | off | Never create new remote files. |
| Synchronize on start | on | Do a full comparison first, so the two sides begin in agreement. |
| Continue on error | off | Keep watching after a failed upload. |
| File mask | empty | Excluded files are ignored entirely, including their deletions. |

### Synchronized browsing

| Option | Default | Meaning |
| --- | --- | --- |
| `synchronizeBrowsing` (per site) | `false` | Enable for this site. |
| Behaviour on missing counterpart | ask | The target directory may not exist on the other side. |

## Behaviour worth knowing

- **The watcher is debounced.** Editors write files in bursts — truncate, write,
  rename — and uploading each step would send garbage. Changes settle for a short
  interval before being queued.
- **Uploads go through the ordinary queue**, so speed limits, transfer settings
  and the queue panel all apply.
- **A running watcher is always visible.** The session tab shows a watching
  indicator, and stopping it takes one click. A background process that silently
  writes to a server must never be invisible.
- **Synchronized browsing does not create directories.** When the counterpart is
  missing it asks; it does not quietly make one.

## Failure modes

| Situation | What the user sees | Recoverable |
| --- | --- | --- |
| Editor writes via a temporary file and rename | Debouncing plus mask exclusion handle the common patterns (`*.tmp`, `*~`, `.#*`). A stray temporary that slips through is uploaded and then deleted, which is noise rather than damage. | Yes |
| A build tool rewrites thousands of files | The queue fills. The watcher applies backpressure rather than queueing unboundedly, and says so. | Yes |
| Connection drops | Watching pauses, changes accumulate as pending, and a reconnect runs a full comparison so nothing missed while offline is lost. | Yes |
| Delete-remote enabled and a local directory is moved | Reads as delete-then-create: the remote copy is removed and re-uploaded. Costly, and briefly missing on the server. | Yes |
| Delete-remote enabled and local files are lost | The loss propagates. This is why it is off by default and why enabling it warns explicitly. | **Only from a backup** |
| Watch limit exceeded (very large tree) | The OS caps watches. The error names the limit and suggests narrowing the directory or the mask, rather than silently watching part of the tree. | Yes |
| Synchronized browsing into a missing remote directory | A prompt: create it, browse anyway, or cancel. | Yes |
| Clock skew | Only matters for the initial comparison; the watcher reacts to events, not times. | n/a |

## Security considerations

- **This uploads without asking, continuously.** That is the feature, and it is
  also the risk: a secrets file written into a watched directory is on the server
  before anyone reads the filename. Mask exclusions (`.env`, `*.pem`, `.git/`)
  are the defence, and the start dialog suggests them.
- **Delete-remote is destruction driven by local events.** Off by default, warned
  when enabled, and never enabled by a preset.
- **`.git/` is excluded by default** — uploading a repository's object store is
  slow, usually unwanted, and can publish history that was never meant to leave
  the machine.
- **The watcher survives the dialog closing**, so it must remain visible in the
  session tab. An invisible uploader is a security problem, not just a usability
  one.
- **Synchronized browsing leaks nothing**, but it does make it easy to act on the
  wrong panel. The panels' path captions stay distinct, and per-site colour
  tagging is the recommended guard for production sites.

## Verification

- Debouncing is tested with a synthetic write burst matching common editor
  save patterns, asserting exactly one upload results.
- Backpressure is tested by generating changes faster than the queue drains.
- Reconnect-triggers-full-comparison is tested by dropping the adapter and
  restoring it.
- Mask exclusion is tested to confirm an excluded file's *deletion* is also
  ignored — the safety property that makes masks trustworthy.
- Synchronized browsing is tested for path mapping, including the case where
  only one side has the directory.

## Suggested articles

- [Synchronize](synchronize.md) — the one-shot operation, and the comparison that starts a watch.
- [The comparison checklist](comparison-checklist.md) — what the initial comparison produces.
- [File masks](../editing-and-commands/file-masks.md) — the exclusion language that keeps secrets out of a watch.
- [The queue](../transfers-and-queue/queue.md) — where watched changes are executed.

The Keep up to date window exposes the watcher lifecycle as accessible state:
starting and stopping disable the command and announce the pending operation,
so a slow IPC reply cannot be started twice or mistaken for a completed watch.
Once the watcher is active, its `changes` events update the activity log and the
transfer queue; stopping clears that state only after the stop request succeeds.
