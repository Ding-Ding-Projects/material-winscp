# Synchronization

Synchronization compares a local directory against a remote one and produces a
list of differences — then, only if the user agrees, acts on it. The comparison
engine lives in `design/main/sync.js` and is entirely separate from the acting:
you can generate a checklist and never transfer a thing.

## Articles

| Article | Covers |
| --- | --- |
| [synchronize.md](synchronize.md) | The one-shot synchronize operation: directions, modes and criteria. |
| [comparison-checklist.md](comparison-checklist.md) | The reviewable list of differences, and per-item overrides. |
| [keep-up-to-date.md](keep-up-to-date.md) | Continuous watching, and synchronized browsing. |

## The rule that shapes everything here

**Nothing is deleted or overwritten before the user has seen a list of what
would happen.** Synchronization is the feature most capable of destroying work
in this application, so the checklist is not an optional preview — it is the
operation, and transferring is what happens after it is accepted.

## Postman

Not applicable — this project exposes no HTTP API. See the
[documentation index](../README.md).

## Suggested articles

- [Transfers and the queue](../transfers-and-queue/) — where accepted checklist items go.
- [File masks](../editing-and-commands/file-masks.md) — the include/exclude language the comparison honours.
- [Version history](../version-history/) — what protects the *settings*, not the files, from a mistake here.
