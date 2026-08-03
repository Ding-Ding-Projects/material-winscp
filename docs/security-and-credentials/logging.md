# Session logging

## What it does

`design/main/logging.js` records what a session did. Two independent logs:

- **The session log** — a human-readable transcript at one of three levels.
- **The actions log** — a machine-readable XML record of operations performed,
  for scripting and audit.

Logging is the first thing anyone asks for in a bug report and the last thing
anyone thinks about before pasting one into a public issue, which is why
redaction is a design property here rather than an option.

While an authentication prompt is open, its read-only **Authentication log**
shows the current session log and receives new session-log lines live. The
renderer only displays records returned by the main-process session-log API; it
does not collect, print, persist, or send credential field values. The main
process remains responsible for redaction before a line reaches this view.

## Configuration

Under **Preferences → Logging**, stored in `PREF_DEFAULTS.logging`.

| Option | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Master switch. |
| `level` | `0` | `0` normal, `1` debug1, `2` debug2. |
| `logToFile` | `false` | Write to a file as well as the window. |
| `logFileName` | `%TEMP%\!S.log` | Path pattern. `!S` expands to the session name. |
| `logFileAppend` | `true` | Append rather than overwrite. |
| `logMaxSize` | `0` | Rotate above this many bytes. `0` = unlimited. |
| `logMaxCount` | `0` | How many rotated files to keep. `0` = unlimited. |
| `logSensitive` | `false` | Include authentication material. See below. |
| `logProtocol` | `0` | Protocol-level verbosity. |
| `logWindowLines` | `800` | Scrollback in the log window. |
| `logWindowComplete` | `false` | Keep everything in the window rather than trimming. |
| `actionsLogging` | `false` | Enable the XML actions log. |
| `actionsLogFileName` | `%TEMP%\!S.xml` | Its path pattern. |

## What each level contains

| Level | Contains |
| --- | --- |
| **0 — normal** | Connection lifecycle, commands issued, file operations, errors. No packet contents. |
| **1 — debug1** | Adds protocol messages: SFTP packet types, FTP commands and responses, HTTP request lines. Bodies are summarized, not dumped. |
| **2 — debug2** | Adds packet payloads and internal state. Large, and the level where a filename or a header can appear in full. |

At every level, authentication material is replaced with a redaction marker
unless `logSensitive` is on. The marker is visible, so a reader can tell
something was removed rather than wondering whether it was ever sent.

## Failure modes

| Situation | What the user sees | Recoverable |
| --- | --- | --- |
| Log path not writable | A corner notification once, naming the path. Logging is disabled for the session; the session itself continues. A logging failure must never fail the work. | Yes |
| Disk fills from an unbounded debug2 log | Set `logMaxSize`. Without a limit the app warns once the log passes a large threshold rather than silently filling the disk. | Yes |
| `%TEMP%` expands unexpectedly | The resolved absolute path is shown next to the pattern in the settings, so what will be written is visible before it is. | Yes |
| Two sessions with the same name | `!S` collides; a discriminator is appended rather than interleaving two sessions in one file. | Yes |
| Log window at 800 lines during a large transfer | Trimmed from the top. `logWindowComplete` keeps everything at the cost of memory. | n/a |
| Actions XML truncated by a crash | Well-formedness is repaired on next open by closing dangling elements, and the repair is noted in the file. | Usually |

## Security considerations

- **`logSensitive` is off by default and produces a warning when enabled.** With
  it on, the log can contain passwords, key passphrases, session tokens and
  authentication exchanges. Such a log is exactly as sensitive as the credentials
  in it and should be treated as a secret, not as a diagnostic.
- **Registered live secrets remain redacted even when `logSensitive` is on.**
  Adapters register credentials they hold so an exact value cannot leak through
  a verbose protocol line; the setting only relaxes heuristic redaction.
- **Redaction is applied at the point of writing**, not by post-processing, so a
  crash mid-write cannot leave an unredacted fragment.
- **Even redacted logs contain hostnames, usernames, paths and filenames.** For
  many people that is sensitive. The share/export action says so.
- **Log files are written with the user's permissions**, and `%TEMP%` is
  per-user on Windows — but a temporary directory is still a poor place for a
  sensitive log. The settings suggest a deliberate location when `logSensitive`
  is on.
- **Rotation deletes old logs.** With `logMaxCount` set, evidence of an earlier
  problem may be gone; the setting says so.
- **The actions log is designed to be parsed** and therefore escapes filenames
  properly — a filename containing XML syntax cannot corrupt the document or
  inject elements into it.
- **Logging never blocks the session.** A failure to log is reported and
  discarded; it does not fail a transfer.

## Verification

- Redaction is tested by driving authentication exchanges for every protocol and
  asserting no credential appears at any level with `logSensitive` off.
- Rotation is tested for size threshold, count limit and correct ordering.
- Path pattern expansion is tested for `!S`, environment variables and collision
  discrimination.
- Actions XML escaping is tested with filenames containing `<`, `>`, `&`, quotes
  and control characters, asserting the document stays well-formed.
- Failure containment is tested by making the log path unwritable mid-session and
  asserting the transfer still completes.

## Suggested articles

- [Credential storage](credential-storage.md) — what redaction is protecting.
- [SFTP](../protocols/sftp.md) and [FTP](../protocols/ftp.md) — reading protocol-level logs.
- [Notifications](../interface-and-appearance/notifications.md) — how a logging failure reports itself.
