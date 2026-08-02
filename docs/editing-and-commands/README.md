# Editing and commands

Working *on* files rather than moving them: opening a remote file in an editor,
running a command against a selection, and the mask language that decides which
files any of it applies to.

## Articles

| Article | Covers |
| --- | --- |
| [editors.md](editors.md) | The internal editor, external editors, and the download-edit-upload cycle. |
| [custom-commands.md](custom-commands.md) | Command patterns, argument expansion, quoting and extensions. |
| [file-masks.md](file-masks.md) | The WinSCP mask language — wildcards, exclusion, size and time filters. |
| [console.md](console.md) | The remote terminal, and which protocols can offer one. |

## Postman

Not applicable — this project exposes no HTTP API. See the
[documentation index](../README.md).

## Suggested articles

- [Protocols](../protocols/) — `caps.shell` decides what this category can offer.
- [Transfers and the queue](../transfers-and-queue/) — masks are shared with transfer settings.
- [Search and regex](../search-and-regex/) — masks convert to regex for the builder.
