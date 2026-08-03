# Command-line parsing

## What it does

The Electron entry point accepts WinSCP-style switches from both startup and a
second launch handed to the existing instance. `design/main/progparams.js`
adapts the production boundary to the shared `design/main/options.js` model,
which mirrors `core/Option.cpp` and `windows/ProgParams.cpp`.

Switches may start with `/` or `-`, take a value with `=` or `:`, and stop
being recognised after a bare `//` or `--`. A path such as `/home/martin` is a
parameter, not a switch. The reference array-value form is also preserved:
`/rawsettings[2]` has switch value `2`.

## Configuration

There is no preference for command-line parsing. The supported startup fields
are selected in `design/main/main.js`: `/ini`, `/log`, `/loglevel`, `/xmllog`,
`/console`, `/script`, `/command`, `/privatekey`, `/hostkey`, `/passive`,
`/timeout`, `/newinstance`, session operations and help. The parser is also
used when Electron delivers a URL or a command line from a second instance.

Repeated switches follow WinSCP's first-match rule: the first occurrence is the
one consumed by the dispatcher. This matters for `/ini` and logging, where a
later token must not silently change which file the launch uses.

## Failure modes

| Situation | What the user sees | Recoverable |
| --- | --- | --- |
| A path begins with `/` | It remains a positional parameter and is not rejected as an unknown switch. | Yes |
| A second copy supplies the same switch twice | The first value is retained, matching WinSCP's `FindSwitch`. | Yes — relaunch with one value |
| `//` or `--` precedes a filename beginning with `-` | Everything after the marker is passed as a parameter. | Yes |
| An unsupported maintenance switch is supplied | It remains unused by the GUI dispatcher; the unsupported operation is not claimed as implemented. | Yes — use a supported entry point |
| `/ini` names a missing file | The current port still falls back to the configured root rather than showing WinSCP's dedicated warning. | Yes — correct the path |

## Security considerations

- Command-line values can contain usernames, host keys, file paths and other
  sensitive data. The main process redacts URL passwords before broadcasting a
  parsed command to the renderer.
- `/log` and `/xmllog` are explicit user choices and may write session details
  to a path supplied on the command line. Do not put credentials in those
  paths or in shell history.
- The parser only classifies tokens; it does not execute an unknown switch or
  elevate a process. Unsupported maintenance actions remain a documented gap.

## Verification

- `test/sessiondata.test.js` covers the shared `Options` tokenizer, switch
  delimiters, end-of-switch marker, parameter consumption and boolean values.
- `test/progparams.test.js` covers the production startup adapter, duplicate
  first-match behaviour, bracketed values, both switch marks and path safety.
- `node --check design/main/options.js`, `node --check design/main/progparams.js`
  and `node --check design/main/main.js` are the syntax checks for this slice.

## Suggested articles

- [Custom commands](custom-commands.md) — quoting and command construction.
- [The console](console.md) — scripting and console entry points.
- [Site manager](../sessions-and-sites/site-manager.md) — stored sessions and
  the URL half of a launch command.
