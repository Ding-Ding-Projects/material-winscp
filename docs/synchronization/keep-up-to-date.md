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

- **Native change bursts are debounced.** Editors write files in bursts —
  truncate, write, rename — and the watcher waits briefly before comparing.
  Adapters without a native watcher use the polling interval instead.
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
| Editor writes via a temporary file and rename | Native-event coalescing reduces duplicate comparisons; use a file mask when temporary names must never be considered. | Yes |
| A build tool rewrites thousands of files | The watcher suppresses a duplicate source path while its queue item is active or queued, but distinct paths can still add queue items. Narrow the mask for a large tree. | Yes |
| Connection drops | The watcher reports the comparison or queue error. It continues after recoverable errors when configured to continue; a native monitor error stops the watcher. A later poll or native event runs a full comparison. | Yes |
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
- The watcher does not add a hidden default mask. Add `.git/`, `.env`, `*.pem`,
  or other sensitive paths to the file mask before starting it.
- **The watcher survives the dialog closing**, so it must remain visible in the
  session tab. An invisible uploader is a security problem, not just a usability
  one.
- **Synchronized browsing leaks nothing**, but it does make it easy to act on the
  wrong panel. The panels' path captions stay distinct, and per-site colour
  tagging is the recommended guard for production sites.

## Verification

- Native-event debouncing is tested with three synthetic notifications and a
  single comparison.
- The initial-pass switch is tested to ensure `syncOnStart: false` waits for an
  event.
- In-flight cleanup is tested for synchronous queue errors and removed queue
  rows, so a failed or cancelled item can be reconsidered.
- The ordinary comparison tests cover mask exclusion, including recursive
  directories and target-only rows.
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
