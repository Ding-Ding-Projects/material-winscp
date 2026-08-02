# Updates

## What it does

`design/main/updates.js` checks whether a newer version exists and offers it.
The download and swap are performed by Squirrel's `Update.exe` — see
[the installer](installer.md) for the on-disk mechanics.

## Configuration

Under **Preferences → Updates**, stored in `PREF_DEFAULTS.updates`.

| Option | Default | Meaning |
| --- | --- | --- |
| `period` | `604800` (7 days) | Seconds between automatic checks. `0` = never. |
| `lastCheck` | `0` | Timestamp of the last check. |
| `showOnStartup` | `true` | Show the result if an update was found. |
| `betaVersions` | `auto` | `auto`, `on`, `off`. |
| `connectionType` | `auto` | Direct, or through the configured proxy. |
| `authenticationEmail` | `''` | Optional, for a build channel that requires it. |
| `results` | `null` | The last check's result. |
| `shownResults` | `false` | Whether it has been shown. |

**Check for updates** in the Tools menu runs a check on demand regardless of the
period.

## Behaviour

- **Checks are never blocking.** They run in the background; a result arrives as
  a [corner notification](../interface-and-appearance/notifications.md) with a
  details action, never as a modal that interrupts work.
- **Nothing installs itself.** An available update is offered. The user decides
  when to apply it, and applying it restarts the app.
- **The offer includes the version, the release date and the dim sum code name**,
  with a link to the full release notes and to the in-app
  [changelog](changelog.md).
- **A failed check is not an error worth interrupting anyone about.** It is
  recorded and retried at the next period; only an explicit manual check reports
  failure prominently.

## Failure modes

| Situation | What the user sees | Recoverable |
| --- | --- | --- |
| No network | Automatic check fails silently and retries later. A manual check reports it. | Yes |
| Behind a proxy | `connectionType: auto` uses the system proxy. Explicit configuration is available. | Yes |
| Update download interrupted | Squirrel resumes or restarts next time. The running version is untouched. | Yes |
| Disk full during an update | The update fails cleanly and the current version keeps running. | Yes |
| The app is updated while transfers are queued | Applying an update requires a restart, and the restart prompt reports queued work first. The queue is not persisted, so this matters. | Yes |
| A newer version exists but is a beta and `betaVersions` is `off` | Not offered. The check reports "up to date", which is accurate for the chosen channel. | n/a |
| The update fails to apply | Squirrel retains the previous `app-<version>` folder, so the old version still runs. | Yes |

## Security considerations

- **Update packages are unsigned.** Squirrel verifies the checksum in the
  `RELEASES` manifest, which protects against corruption. It does not, by itself,
  protect against a substituted package on a host that has already been
  compromised — this is stated rather than glossed.
- **Updates are fetched over HTTPS** from the project's own release host.
- **The check sends the current version and platform.** Nothing else — no site
  inventory, no usernames, no paths. `authenticationEmail` is only sent when the
  user has set it for a channel that requires it, and it is optional.
- **Nothing is installed without consent.** There is no silent auto-update.
- **A restart to apply an update can lose queued transfers**, since the queue is
  deliberately not persisted (see [the queue](../transfers-and-queue/queue.md)).
  The restart prompt says so.

## Verification

- Period logic, `lastCheck` handling and the manual-check override are unit
  tested with a synthetic clock.
- Channel filtering (`betaVersions`) is tested against a synthetic release list.
- Failure containment is tested by making the check fail and asserting no modal
  appears and no operation is disturbed.
- The restart prompt is tested to report queued work.

The full check-download-apply cycle depends on a published release, and **none
exists yet**. This article does not claim that cycle has been exercised.

## Suggested articles

- [The installer](installer.md) — the Squirrel mechanics behind an update.
- [Releases](releases.md) — what an update points at.
- [The changelog viewer](changelog.md) — what the offer links to.
- [The queue](../transfers-and-queue/queue.md) — why a restart prompt mentions it.
