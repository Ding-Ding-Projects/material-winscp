# SCP

## What it does

SCP transfers files by driving a remote **shell** — it runs `scp -f` / `scp -t`
on the far side and parses the output of `ls -la` to build directory listings.
That makes it an adapter with `caps.exec = true`: the same session can run
arbitrary commands, which is what powers the Console and custom commands on
remote files.

It is also the most fragile protocol, and deliberately not the default. Prefer
[SFTP](sftp.md) unless the server genuinely has no SFTP subsystem.

## Configuration

Under **Site → Advanced → SCP/Shell**.

| Option | Default | Meaning |
| --- | --- | --- |
| `shell` | `''` (server default) | Shell to invoke. Set it when the login shell is not POSIX-compatible. |
| `returnVar` | `''` | Variable holding the last exit code (`$?`/`?` on most shells, `status` on csh). The adapter accepts either `$?` or `?` and quotes the marker safely. |
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

On connect, the adapter first runs a harmless `:` command and discards any
output it receives. This mirrors WinSCP's startup conversation and keeps a
login banner or MOTD from being mistaken for the output of the initial `pwd`
or `uname` probes. The discarded byte count is retained in the debug session
log; a non-zero status is a classified startup protocol error.

Remote duplicate actions use the same `copyRemote` adapter capability as the
Commander queue. When the user chooses overwrite, the adapter removes only the
resolved destination path and then runs `cp -a`; otherwise it leaves the
destination untouched so the server's existing-target failure is preserved.
This keeps the action's target exact even when the destination already names a
directory. The path is always shell-quoted, and the removal is never performed
for a non-overwrite duplicate.

Checksum requests use the matching `md5sum`, `sha1sum`, `sha256sum`, or
`sha512sum` command. On systems without a GNU-style SHA utility, SHA-1,
SHA-256, and SHA-512 retry with `shasum -a N`; this is limited to shell exit
codes 126/127, so real checksum failures remain visible.

## Failure modes

| Situation | What the user sees | Recoverable |
| --- | --- | --- |
| The login shell prints a banner or MOTD | Listing parsing fails on the first attempt; the adapter retries after consuming the banner and reports what it discarded. | Usually |
| A non-POSIX login shell (fish, csh, a restricted shell) | Connection succeeds, every command fails. The error names the shell reported by the server and points at the `shell` option. | Yes, by setting `shell` |
| `ls` is aliased with colour | Escape sequences corrupt listing parsing. `clearAliases` prevents this and is on by default. | Yes |
| Locale gives non-English month names | Dates parse wrongly or not at all. `unsetNationalVars` prevents this. | Yes |
| Filenames containing newlines | Cannot be represented in `ls` output. Such entries are reported as unparseable rather than silently mangled or merged. | No — use SFTP |
| Server clock is in another timezone | Timestamps look shifted; `timeDifferenceAuto` measures and corrects it. | Yes |
| Server sends an epoch timestamp whose millisecond conversion exceeds JavaScript's safe-integer range | The SCP record is rejected with a protocol error rather than producing a rounded timestamp. | No — retry with a supported server timestamp |
| Transfer interrupted | SCP has no resume. The queue item fails with the whole file to redo — `caps.resume` is `false`, so the UI never offers Resume. | Partially |
| A malformed or truncated SCP stream | The operation fails with a protocol error; a recursive download is never reported complete merely because its SSH channel closed. | No — retry the transfer |
| The declared upload size is wrong | The upload fails validation before it can send an overlong payload, or after an incomplete payload, and the queue receives a bounded error. | Yes, retry with the real size |

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
- **Wire parsing is a parser fed by a remote party.** SCP control records are
  capped at 64 KiB and all numeric file/time fields must be safe integers, so a
  hostile peer cannot turn a header into an unbounded allocation or smuggle a
  malformed timestamp record through the transfer handshake.
- **Shell failures cross the adapter boundary as classified errors.** Remote
  permission failures are `permission`/`EACCES`; malformed SCP records and
  command failures are `protocol`/`EPROTO`; invalid local transfer arguments
  are `validation`/`INVALID_INPUT`.
- **`ignoreLsWarnings` hides stderr.** Useful, but it can also hide a genuine
  permission problem; the session log still records the discarded text.
- SCP inherits the SSH transport's security wholesale — cipher lists, host key
  verification and agent forwarding behave exactly as in [SFTP](sftp.md).

## Verification

- Listing parsers are unit-tested against recorded `ls -la` output from GNU
  coreutils, BusyBox, macOS/BSD and Solaris, including the `--full-time` form.
- Quoting of filenames containing spaces, quotes, `$`, backticks and semicolons
  is tested directly against the expansion layer; a stored `$?` return variable
  is checked for the exact one-dollar shell expansion.
- Upload headers, byte counts, progress, malformed records, control-line limits,
  recursive truncation, permissions and error categories are covered by
  focused contract tests and the real SSH/SCP suite in `test/e2e-sftp.test.js`.
- Timezone correction is tested with synthetic clock offsets.
- Commander remote-copy command construction is tested for explicit overwrite
  and default no-overwrite behavior in `test/scp-commander-parity.test.js`.
- SHA checksum fallback to `shasum -a N` is tested with an in-process shell
  stub.

Manual check: connect over SCP, open **Commands → Console**, run `echo $0`, and
confirm the reported shell matches the `shell` option in effect.

## Suggested articles

- [SFTP](sftp.md) — same transport, a real file protocol; prefer it.
- [The adapter contract](adapter-contract.md) — why `caps.resume = false` greys out Resume.
- [Custom commands](../editing-and-commands/custom-commands.md) — what
  `caps.exec` unlocks, and how arguments are quoted.
- [Security and credentials](../security-and-credentials/) — the SSH trust store shared with SFTP.
