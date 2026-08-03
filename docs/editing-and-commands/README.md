# Editing and commands

Working *on* files rather than moving them: opening a remote file in an editor,
running a command against a selection, and the mask language that decides which
files any of it applies to.

## Articles

| Article | Covers |
| --- | --- |
| [editors.md](editors.md) | The internal editor, external editors, and the download-edit-upload cycle. |
| [editor-preferences.md](editor-preferences.md) | Ordered editor associations, first-match selection, validation, and filtered keyboard reordering. |
| [remote-edit-round-trip.md](remote-edit-round-trip.md) | The renderer-to-IPC-to-main upload seam and its conflict/error behaviour. |
| [custom-commands.md](custom-commands.md) | Command patterns, argument expansion, quoting and extensions. |
| [custom-command-validation.md](custom-command-validation.md) | The shared UI/main validation contract for interactive and file patterns. |
| [file-masks.md](file-masks.md) | The WinSCP mask language — wildcards, exclusion, size and time filters. |
| [console.md](console.md) | The remote terminal, and which protocols can offer one. |
| [script-runner.md](script-runner.md) | Batch scripting, `/script` and `/command` execution, exit status, and secure XML output. |
| [command-line.md](command-line.md) | The `/` and `-` switch parser shared by startup and second-instance launches. |
| [cli.md](cli.md) | The headless `winscp` entry point, console-compatible commands, and drag/drop simulation. |
| [file-find.md](file-find.md) | Streaming file search, cancellation, masks and zero-result limits. |
| [command-palette.md](command-palette.md) | The persisted keyboard palette: every registered command, Preferences destinations, regex search and exact setting teleport. |
| [explorer-properties-dispatch.md](explorer-properties-dispatch.md) | Explorer-side dispatch and capability context for local and remote file properties. |
| [explorer-transfers.md](explorer-transfers.md) | Remote copy and move reachability in the single-panel Explorer interface. |
| [drag-drop.md](drag-drop.md) | Safe drag/drop effects, Explorer targets, queue drops and refusal conditions. |
| [generate-url-ipv6-escaping.md](generate-url-ipv6-escaping.md) | URI-safe escaping and round-tripping for scoped IPv6 hosts. |

## Postman

Not applicable — this project exposes no HTTP API. See the
[documentation index](../README.md).

## Suggested articles

- [Protocols](../protocols/) — `caps.exec` decides whether remote command
  execution is available; the console uses the same capability.
- [Transfers and the queue](../transfers-and-queue/) — masks are shared with transfer settings.
- [Search and regex](../search-and-regex/) — masks convert to regex for the builder.
