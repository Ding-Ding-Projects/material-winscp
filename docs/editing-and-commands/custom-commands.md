# Custom commands and extensions

## What it does

A custom command runs a command against the selected files — remotely on the
server, or locally with the files downloaded first. `design/main/customcmd.js`
expands a pattern into a real command line, quoting every substituted value.

An **extension** is a packaged custom command with a description, options and a
declared protocol requirement, so a useful command can be shared rather than
retyped.

## Configuration

Under **Preferences → Commands**. Each command has:

| Field | Meaning |
| --- | --- |
| Description | The menu label. |
| Command | The pattern, with the placeholders below. |
| Applies to | Local files, remote files, or both. |
| Mask | A [file mask](file-masks.md) restricting which files it appears for. |
| Options | Apply to directories; recurse; prompt for parameters; show results; copy results to clipboard. |
| Keyboard shortcut | Optional. |

The editor accepts only its displayed `Ctrl+`, `Ctrl+Shift+` and `Shift+` function
key combinations. A shortcut is unique within the custom-command list; editing a
command keeps its own shortcut available, while trying to reuse another command's
shortcut is rejected. Older imported values that are no longer supported remain
visible in the editor so they can be cleared rather than silently changing.

### Placeholders

| Placeholder | Expands to |
| --- | --- |
| `!` | The selected file's name. |
| `!/` | Its remote directory. |
| `!\` | Its local directory. |
| `!@` | The session hostname. |
| `!U` | The username. |
| `!S` | The session name. |
| `!P` | The port. |
| `!?prompt?!` or `!?prompt!` | A value asked for at run time; the `?default` part is optional. |
| `!&` | The whole selection, one command for all files rather than one per file. |
| `!!` | A literal `!`. |

Every expansion **except** `!?…?!` is quoted for the target shell. A prompted
value is quoted too — a user typing a semicolon into a prompt must not be able to
chain a command, even by accident.

## Failure modes

| Situation | What the user sees | Recoverable |
| --- | --- | --- |
| Command needs a remote shell on a protocol without one | The command is greyed out. `caps.exec` decides; SCP always supports it, SFTP depends on the connected server/account, and FTP, WebDAV and S3 do not expose it. | n/a |
| Non-zero exit | The exit code and captured output are shown. Success is not assumed from the command having run. | Yes |
| Command produces a great deal of output | Captured up to a bound and marked as truncated, rather than consuming memory. | Yes |
| Command waits for input | Detected by a timeout; the command is terminated and reported as needing input. Interactive commands belong in the [console](console.md). | Yes |
| `!&` with a very large selection | The command line can exceed the OS limit. It is batched, and the batching is reported so the user knows the command ran more than once. | Yes |
| A filename containing quotes, spaces, `$`, backticks or `;` | Quoted correctly. This is tested adversarially. | n/a |
| Local command with the file not yet downloaded | Downloaded to a temporary first, and uploaded back afterwards if it changed — the same cycle as [editors](editors.md). | Yes |
| An imported extension requiring a protocol the site does not use | Not offered, with the requirement stated in the extension list. | n/a |

External application lookup follows the host platform. Windows uses semicolon-
separated `PATH` entries and backslash joining; Linux and other Unix-like hosts
use colon-separated entries and slash joining. A bare executable name is looked
up in `PATH`, while a name containing a directory is treated as an explicit path.
An empty `PATH` entry is covered by the current-directory probe and is not turned
into a root-relative path.

## Security considerations

- **This feature executes commands. That is its purpose and its risk.**
  A custom command runs with the user's local privileges, or the user's full
  remote privileges over a shell session.
- **Filename quoting is the critical control.** A remote file named
  `; rm -rf ~` is attacker-controlled input reaching a shell. Every substitution
  is quoted for the target shell; any code path building a command by
  concatenation is a bug. This is tested with a hostile filename corpus.
- **Prompted values are quoted too**, so a prompt cannot be used to inject.
- **Imported extensions are code from elsewhere.** Importing shows the full
  command pattern and requires explicit confirmation. An extension is never
  installed silently, never auto-runs on import, and never runs on a schedule.
- **`!` placeholders can leak into a command's own logging.** A command that
  echoes its arguments into a shared log publishes paths and hostnames; the
  description field is the place to note that.
- **There is no elevation path.** No custom command runs elevated, and none can
  request it.

## Verification

- Expansion is tested for every placeholder, including `!!` and nested prompts.
- **Quoting is tested against an adversarial filename corpus** — spaces, single
  and double quotes, backslashes, `$`, backticks, `;`, `&&`, newlines and
  non-ASCII — asserting the shell receives exactly one argument each time.
- `!&` batching is tested against the command-line length limit.
- Capability gating is tested to assert remote commands are unavailable on
  protocols without `caps.exec`.
- Output capture bounds and the input-wait timeout have direct tests.

## Suggested articles

- [The console](console.md) — for commands that need interaction.
- [File masks](file-masks.md) — restricting where a command appears.
- [Editors](editors.md) — the same download-edit-upload cycle for local commands.
- [SCP](../protocols/scp.md) — the protocol that makes remote commands possible.
