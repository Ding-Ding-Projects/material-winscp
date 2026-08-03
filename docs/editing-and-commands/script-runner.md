# Script runner

## What it does

`design/main/script.js` executes WinSCP-style commands and
`design/main/consolerunner.js` drives them from `/script=FILE`, `/command`, or
standard input. A script starts in batch mode with confirmations disabled. Its
exit code is `0` only when every command succeeds; any command failure,
unanswered batch input, or user abort returns `1`.

`option batch continue` lets later commands run after a failure, but it does
not turn that failure into success. The final status remains `1`, so a calling
batch file can safely use the process exit code.

## Command sources

When present, `/script=FILE` commands run first and `/command` arguments follow.
If neither switch is present, commands are read from standard input. Script
files may be UTF-8 or BOM-marked UTF-16; invalid text is rejected rather than
silently reinterpreted. Repeated `/command` and `/parameter` switches are
consumed in their original order, so later groups remain batch input rather
than becoming a fake session URL or an interactive prompt. `/parameter` values expand as `%1%` through `%9%`, and
timestamp/environment expansion happens immediately before execution.
Generated command arguments are quoted when they contain either a space or a
tab, matching the tokenizer's separators; this keeps paths and names with
tabs intact when a CLI command is parsed again.

## Session URLs and open switches

`open` accepts the ordinary `sftp://`, `scp://`, `ftp://`, `ftps://`,
`ftpes://`, `dav://`, `davs://`, `http://`, `https://`, `s3://`,
`s3plain://` and `ssh://` forms, plus registered-handler forms such as
`winscp-sftp://` and `winscp://sftp://...`. URL decoding follows WinSCP's
rules, including `+` as a space in URL components, IPv6 bracket validation and
the valid TCP port range. The open switches apply to the parsed session;
`-clientcert` maps to the TLS client-certificate file and each
`-rawsettings NAME=VALUE` entry is applied to the session settings.

When a stored site is expanded into the warning's explicit `open` command, its
default port is shown for compatibility. The shared URL generator used by the
CLI and app continues to omit default ports in ordinary generated URLs.

## Secure output

`open` commands are redacted at the logging boundary: URL passwords and
password-bearing switches become `***`. That redaction is also used for
`/xmllog /xmlgroups` group names. The XML log therefore records which command
ran without persisting a login password. Remote command output is still
opaque user data and may contain secrets typed or printed by the remote shell;
do not share a script transcript or XML log without reviewing it.

## Failure modes and verification

| Situation | Result |
| --- | --- |
| Script file is missing or invalid text | The error is printed and the runner returns `1`. |
| A command fails in batch-abort mode | Later script lines are skipped and the runner returns `1`. |
| A command fails in batch-continue mode | Later lines run, but the runner still returns `1`. |
| `/xmllog` is requested with `/xmlgroups` | Each group name is XML-escaped and command credentials are redacted. |
| `/stdin` or `/stdout` has an unknown mode | The in-process runner prints the parser error and returns `1`, matching the console front end's process boundary. |
| `/stdin=binary` | Transfer input is consumed as raw bytes; it is not UTF-8 decoded or split and reassembled by lines. |
| `/log=FILE` is supplied | The console writes the script transcript through the existing session logger, including timestamps and `***` redaction for credentials; the file is closed before the runner returns. |
| A numeric switch value is malformed (`-speed=64oops`, `-resumesupport=64oops`, `-timeout=30oops`, `/loglevel=2oops`) | The runner reports the invalid value and the option name, then returns `1` before starting the transfer, session, or command list. Decimal integers only are accepted; `/loglevel` also accepts WinSCP's historical `*` marker while this port still redacts secrets. |
| A session selector is malformed (`session 1oops`) | The selector is rejected instead of being truncated to session `1`. |
| Repeated `/command` or `/parameter` switches are supplied | Every group is consumed in order; no implicit session or prompt is created. |
| No script and no standard input | The non-interactive runner exits `0` without hanging. |

Focused coverage lives in `test/script.test.js`, including the `/script` and
`/command` composition, exit-code contract, and credential-free XML group
regression.
