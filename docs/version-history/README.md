# Version history

Every user-managed record this application owns is snapshotted into a local
git repository, so any create, edit or delete can be undone — and the undo can
itself be undone.

## Articles

| Article | Covers |
| --- | --- |
| [snapshots.md](snapshots.md) | What is snapshotted, when, and how the repository is laid out. |
| [restore.md](restore.md) | Restoring, the append-only rule, and the AAD trap that makes naive restores unrecoverable. |
| [history-panel.md](history-panel.md) | Browsing, diffing, labelling, and the date and action filters. |
| [document-discard.md](document-discard.md) | The auditable history action and recovery copy for discarded unsaved edits. |

## The four rules

1. **Everything the user manages is covered** — sites, folders, workspaces,
   transfer presets, custom commands, extensions, themes, file-colour rules,
   host-key trust decisions, **and settings**. A history that covers documents
   but loses a mistakenly deleted account has satisfied the letter of the rule
   and none of its point.
2. **History is append-only.** Restoring an old revision writes a *new* revision.
   Nothing is ever rewritten or discarded, so experimenting is safe.
3. **It lives beside the app's data, never inside a user folder.** A `.git`
   appearing inside someone's Documents would be both surprising and dangerous.
4. **A failed history write never fails the operation the user asked for.** It is
   logged and the work proceeds.

## Postman

Not applicable — this project exposes no HTTP API. See the
[documentation index](../README.md).

## Suggested articles

- [The site manager](../sessions-and-sites/site-manager.md) — the most-edited records.
- [Credential storage](../security-and-credentials/credential-storage.md) — why snapshots hold ciphertext.
- [Search and regex](../search-and-regex/) — the history panel's own search bar.
