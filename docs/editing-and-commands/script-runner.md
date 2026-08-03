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
silently reinterpreted. `/parameter` values expand as `%1%` through `%9%`, and
timestamp/environment expansion happens immediately before execution.
Generated command arguments are quoted when they contain either a space or a
tab, matching the tokenizer's separators; this keeps paths and names with
tabs intact when a CLI command is parsed again.

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
| No script and no standard input | The non-interactive runner exits `0` without hanging. |

Focused coverage lives in `test/script.test.js`, including the `/script` and
`/command` composition, exit-code contract, and credential-free XML group
regression.
