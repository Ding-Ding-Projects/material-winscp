# SCP

## What it does

SCP transfers files by driving a remote **shell** — it runs `scp -f` / `scp -t`
on the far side and parses the output of `ls -la` to build directory listings.
That makes it the only adapter with `caps.shell = true`: the same session can run
arbitrary commands, which is what powers the Console and custom commands on
remote files.

It is also the most fragile protocol, and deliberately not the default. Prefer
[SFTP](sftp.md) unless the server genuinely has no SFTP subsystem.

## Configuration

Under **Site → Advanced → SCP/Shell**.

| Option | Default | Meaning |
| --- | --- | --- |
| `shell` | `''` (server default) | Shell to invoke. Set it when the login shell is not POSIX-compatible. |
| `returnVar` | `''` | Variable holding the last exit code (`?` on most shells, `status` on csh). |
| `listingCommand` | `ls -la` | The command whose output becomes a directory listing. |
| `lookupUserGroups` | `auto` | Resolve numeric uid/gid to names with `groups`/`id`. |
| `eolType` | `lf` | Line ending assumed for text-mode transfers. |
| `clearAliases` | `true` | `unalias -a` before running anything, so an aliased `ls` cannot corrupt parsing. |
| `unsetNationalVars` | `true` | Clear `LANG`/`LC_*` so month names and separators stay parseable. |
| `ignoreLsWarnings` | `true` | Tolerate `ls` writing warnings to stderr. |
| `scp1Compatibility` | `false` | Use the older SCP1 wire behaviour. |
| `timeDifference` / `timeDifferenceAuto` | `0` / `true` | Correct for a server clock in another zone. |
| `sCPLsFullTime` | `auto` | Use `ls --full-time` for unambiguous timestamps when available. |
| `notUtf` | `auto` | Treat filenames as non-UTF-8. |
| `postLoginCommands` | `[]` | Commands run once after the shell opens. |

## Failure modes

| Situation | What the user sees | Recoverable |
| --- | --- | --- |
| The login shell prints a banner or MOTD | Listing parsing fails on the first attempt; the adapter retries after consuming the banner and reports what it discarded. | Usually |
| A non-POSIX login shell (fish, csh, a restricted shell) | Connection succeeds, every command fails. The error names the shell reported by the server and points at the `shell` option. | Yes, by setting `shell` |
| `ls` is aliased with colour | Escape sequences corrupt listing parsing. `clearAliases` prevents this and is on by default. | Yes |
| Locale gives non-English month names | Dates parse wrongly or not at all. `unsetNationalVars` prevents this. | Yes |
| Filenames containing newlines | Cannot be represented in `ls` output. Such entries are reported as unparseable rather than silently mangled or merged. | No — use SFTP |
| Server clock is in another timezone | Timestamps look shifted; `timeDifferenceAuto` measures and corrects it. | Yes |
| Transfer interrupted | SCP has no resume. The queue item fails with the whole file to redo — `caps.resume` is `false`, so the UI never offers Resume. | Partially |

## Security considerations

- **This adapter runs shell commands on the remote host by design.** Everything
  in `postLoginCommands` and every custom command executes with the user's full
  remote privileges. Custom commands are expanded through `customcmd.js`, which
  quotes substituted filenames — but a command the user writes is still a command
  the user is responsible for.
- **Filename injection is the classic SCP risk.** A file named
  `; rm -rf ~` must never reach a shell unquoted. All substitution goes through
  the quoting layer, and any code path that builds a remote command by string
  concatenation is a bug to be fixed, not a style preference.
- **Listing parsing is a parser fed by a remote party.** It is bounded (line
  length, entry count) so a hostile `ls` cannot exhaust memory.
- **`ignoreLsWarnings` hides stderr.** Useful, but it can also hide a genuine
  permission problem; the session log still records the discarded text.
- SCP inherits the SSH transport's security wholesale — cipher lists, host key
  verification and agent forwarding behave exactly as in [SFTP](sftp.md).

## Verification

- Listing parsers are unit-tested against recorded `ls -la` output from GNU
  coreutils, BusyBox, macOS/BSD and Solaris, including the `--full-time` form.
- Quoting of filenames containing spaces, quotes, `$`, backticks and semicolons
  is tested directly against the expansion layer.
- Timezone correction is tested with synthetic clock offsets.

Manual check: connect over SCP, open **Commands → Console**, run `echo $0`, and
confirm the reported shell matches the `shell` option in effect.

## Suggested articles

- [SFTP](sftp.md) — same transport, a real file protocol; prefer it.
- [The adapter contract](adapter-contract.md) — why `caps.resume = false` greys out Resume.
- [Custom commands](../editing-and-commands/custom-commands.md) — what `caps.shell` unlocks, and how arguments are quoted.
- [Security and credentials](../security-and-credentials/) — the SSH trust store shared with SFTP.
