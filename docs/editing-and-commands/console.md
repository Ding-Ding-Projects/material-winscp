# The console

## What it does

Opens a terminal against the remote host on the session that is already
connected — no second login, no second password. It is a tab like any other, so
it participates in the tab strip, searches, grouping and appearance editing.

The console requires `caps.shell`, which only [SCP](../protocols/scp.md)
provides. On SFTP, FTP, WebDAV and S3 the command is greyed out with a tooltip
naming the reason.

## Configuration

| Option | Default | Meaning |
| --- | --- | --- |
| `postLoginCommands` (per site) | `[]` | Commands run once when the shell opens. |
| `shell` (per site) | `''` | Which shell to invoke. |
| `returnVar` (per site) | `''` | Variable holding the last exit code. |
| `confirmCommandSession` | `true` | Confirm before opening a shell session. |
| `clearAliases`, `unsetNationalVars` | `true` | Normalize the environment so output stays parseable. |

The console's own scrollback has a search bar with the
[regex builder](../search-and-regex/regex-builder.md), and its appearance —
font, size, colours, spacing — is editable through the per-element
["Edit appearance…"](../interface-and-appearance/appearance-editor.md) path like
any other surface.

Live console events are matched to the owning session before they enter the
scrollback. This keeps two open consoles isolated even when the main process
publishes events for both sessions.

## Failure modes

| Situation | What the user sees | Recoverable |
| --- | --- | --- |
| Protocol has no shell | The command is disabled with a tooltip explaining why. It never opens an empty console. | n/a |
| Command produces unbounded output (`yes`, `tail -f`) | Scrollback is bounded; the interrupt control terminates it. | Yes |
| Full-screen program (`vim`, `top`) | Terminal emulation is line-oriented. Such programs are detected and reported as unsupported rather than rendering as escape-sequence soup. | Yes — use a terminal |
| A command changes the working directory | Reflected in the panel when `autoReadDirectoryAfterOp` is on. Otherwise the panel says it may be stale. | Yes |
| Non-POSIX login shell | The console opens and everything behaves oddly. The `shell` option is the fix, and the error names the shell the server reported. | Yes |
| Session drops with the console open | The console shows the disconnection and offers reconnect. Scrollback is preserved. | Yes |
| A command waits for input the user did not expect | It is interactive — that is what this surface is for. Interrupt is always available. | Yes |
| Console startup fails while creating its communication session | Startup reports the global initialization error and closes the session-owned channel, so a retry cannot reuse a half-open console. | Yes — retry after correcting the startup failure |

## Security considerations

- **The console has the user's full remote privileges.** Everything typed runs
  as the logged-in user, and the app applies no filtering to it — filtering a
  terminal would be both futile and misleading.
- **`postLoginCommands` run automatically on every connect.** They come from the
  site record, so an imported site can carry commands. Import shows them
  explicitly and requires confirmation.
- **Console output goes to the session log** when logging is enabled, which can
  capture whatever a command prints — including a secret the user pasted.
  `logSensitive` does not gate this, because the console cannot know what is
  sensitive. The log's export warning covers it.
- **Nothing typed here is stored as a credential.** Command history is per
  session and not persisted, precisely because people type passwords into
  terminals.
- **Interrupt actually interrupts.** A runaway command must be stoppable without
  killing the session, or users will kill the session — and lose their queue.

## Verification

- Capability gating is tested to assert the console is unavailable without
  `caps.shell`.
- Session identity filtering is tested for matching, mismatched and malformed
  live console events.
- Output bounding and interrupt are tested against a synthetic never-ending
  command.
- Full-screen program detection is tested with recorded escape sequences.
- Non-persistence of command history is tested by asserting nothing reaches the
  configuration file.
- Environment normalization (`clearAliases`, `unsetNationalVars`) is tested by
  inspecting the commands issued at shell open.
- Startup cleanup is tested by forcing initialization to fail and asserting the
  session-owned communication channel is closed before the global error returns.

## Suggested articles

- [SCP](../protocols/scp.md) — the only protocol that can open a console.
- [Custom commands](custom-commands.md) — for non-interactive commands with quoting.
- [Session logging](../security-and-credentials/logging.md) — what console output ends up in.
- [Tabs and navigation](../tabs-and-navigation/) — the console is a tab, with all that implies.
