# Snapshots

## What it does

`design/main/history.js` commits a snapshot of user-managed state into an
isolated git repository (via `isomorphic-git`) kept at `paths.history()` —
beside the app's own data, never inside a folder the user owns.

Every mutation is *offered* to history. History never gates the mutation.

## What is snapshotted

| Record | Examples of a revision |
| --- | --- |
| Sites | "Created the site Production web", "Changed the port on Staging DB" |
| Site folders | "Deleted the folder Customers (7 sites)" |
| Workspaces | "Renamed the workspace Morning to Daily" |
| Transfer presets | "Deleted the preset Overnight bulk" |
| Custom commands and extensions | "Imported the extension Checksum all" |
| Themes and appearance presets | "Reset the appearance of the queue tab" |
| File-colour rules | "Added a colour rule for *.pem" |
| Host key trust decisions | "Accepted a changed host key for db.internal" |
| **Settings** | "Turned on Keep remote directory up to date warnings" |

Settings belong in the same snapshot as the records they configure. Restoring a
site without the configuration it ran under produces a subtly wrong state, which
is worse than offering no undo at all.

## Configuration

Under **Preferences → History**, stored in `PREF_DEFAULTS.versionHistory`.

| Option | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch. |
| `retentionDays` | `365` | Prune revisions older than this. |
| `maxRevisions` | `5000` | Prune beyond this count. |
| `snapshotSettings` | `true` | Include settings changes. |
| `snapshotSites` | `true` | Include site and folder changes. |

Export is available as a UTF-8 JSON archive. It contains the selected revision
metadata and complete snapshot states, including protected secret envelopes;
the history panel records the active filter statement in the exported file.

## Behaviour worth knowing

- **The repository is local and is never pushed** unless the user explicitly
  opts in. It is an undo mechanism, not a sync mechanism.
- **Revisions are labelled by what changed**, not that something did. "Deleted
  the GitHub account", never "Updated". A label that says nothing makes the panel
  a wall of identical rows.
- **An unchanged state records nothing.** Saving a dialog without altering
  anything produces no revision, so the panel stays a list of real events.
- **Snapshots preserve whatever encryption the live data uses.** Ciphertext stays
  ciphertext — the history is never more sensitive than the store it mirrors, and
  never contains a plaintext secret that the configuration file does not.
- **Writes are batched within a short window**, so dragging a slider produces one
  revision rather than forty.

## Failure modes

| Situation | What the user sees | Recoverable |
| --- | --- | --- |
| History write fails (disk full, permissions) | Logged and reported once as a corner notification. **The user's operation still succeeds.** | Yes |
| The repository is corrupt | The history operation fails softly and reports the error; the damaged repository is not silently replaced. | Partially |
| Pruning by retention or count | Old revisions removed. The panel states the oldest retained revision so the horizon is visible rather than mysterious. | n/a |
| A very large configuration | Snapshots are of a JSON tree, so storage is small and git deduplicates. `maxRevisions` bounds the worst case. | n/a |
| History disabled and re-enabled | The gap is visible in the panel, labelled as a period when history was off. Not silently interpolated. | n/a |
| Two mutations in the same instant | Serialized; each gets its own revision with its own label. | n/a |
| The app is killed mid-write | git's own write discipline plus the app's atomic staging means the last revision either exists or does not. | Yes |

## Security considerations

- **The history mirrors the store, including its ciphertext and host-key trust
  records.** It never decrypts to snapshot, so it never creates a plaintext
  copy of a secret.
- **It lives in the app's data directory** with the user's permissions, not in a
  user folder and not in a location another account can read.
- **Deleting a record does not remove it from history** — that is the entire
  point, and it means a deleted credential's *ciphertext* remains in history
  until pruned. Anyone whose threat model requires true erasure should prune,
  and the panel offers a purge for exactly that.
- **Never pushed anywhere.** The repository has no remote configured, and adding
  one requires explicit user action.
- **Export is a JSON archive containing the selected revisions.** The export
  dialog states that it includes protected secrets in their encrypted form.

## Verification

- Every mutation type is asserted to produce exactly one revision with a label
  naming what changed.
- No-op saves are asserted to produce zero revisions.
- Batching is tested with a rapid burst of changes.
- Failure containment is tested by making the history path unwritable and
  asserting the user's operation still succeeds.
- Ciphertext preservation is asserted by scanning committed content for known
  plaintext secrets — a test that must find nothing.
- Pruning is tested for both retention and count, and for reporting the horizon.
- The repository is asserted never to be created inside a user directory.

## Suggested articles

- [Restore](restore.md) — and the AAD trap that makes a naive restore unrecoverable.
- [The history panel](history-panel.md) — browsing, diffing and filtering.
- [Credential storage](../security-and-credentials/credential-storage.md) — the encryption this mirrors.
- [The site manager](../sessions-and-sites/site-manager.md) — the records most often snapshotted.
