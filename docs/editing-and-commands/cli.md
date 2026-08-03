# Headless CLI

## What it does

`winscp` is the installable, headless command-line entry point. It exposes the
same console scripting engine as `winscp-com` and adds deterministic commands
for exercising drag and drop without opening Electron, Explorer, or a terminal
window created by the app.

```text
winscp run /script=deploy.txt
winscp script deploy.txt --parameter production --command "exit"
winscp command "open sftp://host/" "put report.txt" "exit"
winscp drag plan --source remote --result invalid --last-effect move
winscp drop classify report.txt folder --allow-move=false
winscp drop target --queue --default-download-target C:\\Downloads
winscp drag stage report.txt --temp-root C:\\Temp
winscp drag extension-status
winscp url parse sftp://alice:secret@example.com:2222/home/report.txt --want-file
winscp url generate --protocol sftp --host example.com --username alice --specific
```

The `script` and `command` forms forward the console runner's practical
headless switches as well as commands and parameters. Repeated `--command` and
`--parameter` options are grouped into one contiguous `/command` or
`/parameter` run before the existing console engine sees them; this preserves
all values instead of accidentally leaving later values for an interactive
prompt:
`--log FILE`, `--loglevel N`, `--xmllog FILE`, `--xmllogrequired`,
`--xmlgroups[=on|off]`, `--stdout[=binary|chunked]`, `--stdin[=binary]`,
`--ini PATH`, `--rawsettings NAME=VALUE`, `--nointeractiveinput`, and
`--unsafe`. They are translated to their WinSCP
slash-switch equivalents before the existing console engine runs. For exact
WinSCP command-line compatibility, pass those slash switches directly to
`winscp run` or invoke `winscp-com`.

The URL utilities use the same session-data parser and generator as the app.
`url parse` returns the protocol, host, port, user, directory and optional file
name as JSON; it always prints the masked URL and a `hasPassword` boolean, never
the password itself. `url generate` creates a credential-free URL from a
protocol, host, optional port and user. `--specific` selects WinSCP's
`winscp-<scheme>://` handler form. Both commands are local-only and do not open
Electron, connect to a server, or read a stored session.

The simulation commands print JSON. `drag plan` applies the same safe
copy-versus-move rules as the application. `drop classify` uses the real local
filesystem to separate files, directories and paths that disappeared before
the drop was handled. `drag stage` exercises the temporary-folder drag-out
branch, including invalid-name replacement, the shell payload shape and
cleanup. `--move` records the requested move but preserves the fixture because
this command only stages bytes; it never performs the destructive source
deletion. It does not pretend to deliver a GUI drop; use a console script or
the app for a real transfer.

`drop target` exercises the same Explorer target-resolution policy used by the
`explorer:dropTarget` IPC handler. Supply `--queue --default-download-target
PATH`, `--fake-file-target PATH`, or `--external-drop-directory PATH`. It
returns the target, queue-forcing decision, and refusal counter as JSON without
starting Electron, Explorer, or a network connection.

Help is available at every level: `winscp drag --help`, `winscp drop --help`,
`winscp drag plan --help`, and `winscp url --help` all return the same command
reference with exit code `0`, without starting the console runner or a GUI.
The same is true for the console forms: `winscp run --help`,
`winscp script --help`, and `winscp command --help`. `--version` is likewise
handled by `run`, `script`, and `command` before the scripting engine starts.
Help may follow a nested simulation option, for example
`winscp url parse sftp://host/ --help`.

Explorer drag payloads fail closed when a preserved remote name contains `/`,
`\\`, `.` or `..`, or ends in a dot or space. Windows trims those suffixes when
resolving a name, so accepting them could make two staged entries alias or turn
`CON ` into the reserved `CON` device. These names are rejected even when
invalid-character replacement is disabled.

The application-side drop executor has the same safety boundary: only an
explicit `COPY` or `MOVE` effect is actionable. `NONE`, cancel, and unknown
shell effects are refused and cannot be interpreted as a copy. This matters
for direct integrations because the normal Windows `DDEnd` path resolves an
invalid result before dispatch, while an embedder may call the orchestration
method directly.

The direct `winscp run` form accepts every switch understood by the existing
console runner, including `/script`, `/command`, `/parameter`, `/log`,
`/loglevel`, `/xmllog`, `/ini`, `/rawsettings`, `/xmllogrequired`, `/xmlgroups`, `/stdout`, `/stdin`,
`/nointeractiveinput` and `/unsafe`.
`winscp-com` remains available for scripts that explicitly require that
legacy executable name. It also supports `winscp-com --help` and
`winscp-com --version` without starting the console runner.

## Configuration

There is no stored preference. The command line is the configuration boundary:

| Option | Meaning |
| --- | --- |
| `--source remote\|local` | Origin for `drag plan`; defaults to remote. |
| `--destination remote\|local` | Drop destination; inferred from origin when omitted. |
| `--result` and `--last-effect` | Shell result and OS effect used by the decision model. |
| `--allow-move=false` | Downgrade an incoming MOVE to COPY. |
| `--read-only`, `--no-upload`, `--no-mkdir` | Model remote capability refusals. |
| `--queue` | Mark the planned operation as background work. |
| `--file PATH` | Repeatable path input for `drop classify` or `drag stage`. |
| `--windows-build N` | Override the Windows build used by extension-status output. |
| `--protocol SCHEME` | URL scheme for `url generate`: `scp`, `sftp`, `ftp`, `ftps`, `ftpes`, `dav`, `davs`, `s3`, or `s3plain`. |
| `--host HOST`, `--port N`, `--username USER` | Connection fields for `url generate`; no password option is provided. |
| `--want-file` | Ask `url parse` to split the final path component into `session.fileName`. |

All simulation output is structured JSON so a CI job or another process can
assert the decision without scraping prose. `drag stage` removes its temporary
directory in a `finally` path even when staging fails; its output labels the
deleted path `stagingDirectoryBeforeCleanup` so callers do not treat it as
usable.

JSON is compact by default for pipes and scripts. Pass `--pretty` to any
simulation command for indented JSON intended for a terminal. `--json` remains
accepted as an explicit synonym for the default machine-readable format.

## Failure modes

| Situation | What the user sees | Recoverable |
| --- | --- | --- |
| No subcommand or `--help` | The complete command reference is printed. | Yes |
| Unknown drag/drop option or effect | A concise error and exit code `2`; no transfer starts. | Yes — correct the option |
| A positional argument is supplied to `drag plan` | A concise error and exit code `2`; the inert argument is not reported as a successful plan. | Yes — use a named option |
| Invalid Windows path/build or local-to-local plan | A concise input error and exit code `2`; no transfer starts. | Yes — correct the input |
| A classified path is gone | It appears in `classification.missing`; the command still reports the other paths. If every path is gone, `accepted.ok` is `false` and no operation is planned. | Yes — restore or remove the path |
| A value-taking option has no value | The command returns exit code `2` with an input error naming the option; it never treats the boolean word `true` as a path, host, target, or other value. | Yes — provide the option's value |
| Read-only or incapable remote target | `accepted.ok` is `false` with the specific reason. | Yes — choose a writable target |
| Stage source cannot be read | The command fails and removes its staging directory. | Yes — fix the path or permissions |
| Different remote names sanitize to the same Windows name | The command fails with a collision error before staging; it never overwrites one item with another. | Yes — choose a transfer naming rule or drag the items separately |
| An empty stage path is supplied | The command fails with an input error; it never resolves the empty value to the current directory. | Yes — provide a file or directory path |
| A console script fails | The existing console engine returns its normal non-zero script result. | Yes — inspect its log/XML output |
| A URL is malformed or has no host | `url parse` returns exit code `2` without opening a session. | Yes — provide a supported session URL |

## Security considerations

- `winscp run`, `script` and `command` have the remote privileges of the
  supplied session. They intentionally do not filter shell commands.
- Command-line arguments can be recorded by shell history and process
  inspection. Do not place passwords or private keys in them; use the existing
  session and secret-input paths.
- Drag simulation is local-only and does not connect to a server. It reads only
  paths explicitly supplied by the caller and cleans the temporary staging
  directory after `drag stage`.
- `--unsafe` is passed only through the established console runner when the
  caller uses `winscp run`; the drag/drop commands never enable it or execute a
  script.

## Verification

- `test/cli.test.js` covers help/version, console-argument translation, drag
  decisions, missing option values, real-path classification, temporary staging
  and cleanup.
- The `winscp-com --help` and `winscp-com --version` wrapper paths are covered
  with process-level smoke tests; neither starts the console runner.
- `node --check bin/winscp.js` checks the executable syntax.
- `node bin/winscp.js drag plan --source remote --result invalid --last-effect move`
  is a smoke check for the safe MOVE branch.
- `node bin/winscp.js url parse sftp://alice:secret@example.com/home/a.txt --want-file`
  is a smoke check for the redacted URL parser; its output must not contain
  `secret`.
- `node bin/winscp.js url generate --protocol sftp --host example.com --username alice`
  is a smoke check for credential-free URL generation.
- `npm run smoke:docker` exercises the real SFTP and FTP transfer engine with
  throwaway local Docker servers; it is separate from this local-only CLI
  simulation.

## Suggested articles

- [Command-line parsing](command-line.md) — startup switch semantics.
- [The console](console.md) — interactive and scripted remote commands.
- [Script runner](script-runner.md) — batch behaviour and XML output.
- [Synchronization Docker smoke](../synchronization/docker-diff-smoke.md) —
  real-protocol headless verification.
