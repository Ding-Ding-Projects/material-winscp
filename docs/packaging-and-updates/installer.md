# The Squirrel installer

## What it does

`WinSCP Material <version> Setup.exe` is a genuine Squirrel.Windows installer.
Running it installs the app per-user into `%LOCALAPPDATA%\WinSCPMaterial`,
creates shortcuts, and registers the app in Add/Remove Programs. There is no
elevation prompt, because there is no machine-wide install.

## The lifecycle

Squirrel launches the freshly installed executable with a command-line flag so
the app can service each step. `design/main/squirrel.js` handles them:

| Flag | What the app does |
| --- | --- |
| `--squirrel-install` | Creates Desktop and Start Menu shortcuts via `Update.exe --createShortcut`, then quits. |
| `--squirrel-updated` | The same, after an update — shortcuts are refreshed to point at the new version. |
| `--squirrel-uninstall` | Removes the shortcuts, then quits. |
| `--squirrel-obsolete` | The outgoing version is told to step aside before deletion. Quits immediately. |
| `--squirrel-firstrun` | **Not** an install step. The app really is starting for the first time and continues normally. |

`handleSquirrelEvent()` returns `true` for the first four, and `main.js` quits
without creating a window. Getting `--squirrel-firstrun` wrong is the classic
Squirrel bug: treat it as an install step and the app never opens after
installation.

`Update.exe` sits one level above the versioned application folder, which is why
`squirrel.js` resolves it as `dirname(process.execPath)/../Update.exe`.

## The layout on disk

```
%LOCALAPPDATA%\WinSCPMaterial\
  Update.exe                  the Squirrel updater
  app-0.1.0\                  the versioned application folder
    WinSCPMaterial.exe
  packages\                   downloaded nupkg files and RELEASES
```

An update installs a new `app-<version>` beside the old one and switches the
shortcuts; the previous version is removed after it acknowledges
`--squirrel-obsolete`. That is what makes a failed update recoverable rather than
fatal.

## Configuration

In `forge.config.js`, under the Squirrel maker:

| Option | Value | Why |
| --- | --- | --- |
| `name` | `winscp_material` | The NuGet package id. **No spaces** — Squirrel requires it. |
| `title` | `WinSCP Material` | What humans see. |
| `exe` | `WinSCPMaterial.exe` | Must match `packagerConfig.executableName`. |
| `setupExe` | `WinSCP Material <version> Setup.exe` | The installer's filename. |
| `authors`, `owners`, `description`, `copyright` | from `package.json` | Add/Remove Programs metadata. |
| `setupIcon` | `build/icon.ico` | Stamped into the installer. |
| `iconUrl` | not configured | `build/icon.ico` is an ignored local build product, so the installer does not advertise a raw URL that would 404 from a clean checkout. |
| `noMsi` | `true` | Squirrel's own Setup.exe is what users run. |
| `loadingGif` | *not set* | None is bundled; Squirrel shows its default install animation, which is correct behaviour rather than a missing asset. |

## Failure modes

| Situation | What the user sees | Recoverable |
| --- | --- | --- |
| SmartScreen warning on first run | "Windows protected your PC", because the build is unsigned. More info → Run anyway. The release notes say this in advance. | Yes |
| Antivirus quarantines the installer | Unsigned installers are heuristically suspicious. Nothing in the build can fix this short of signing. | Depends |
| `--squirrel-firstrun` mishandled | The app would install and never open. Guarded by `squirrel.js` returning `false` for that flag. | n/a |
| Shortcut creation fails | Installation completes; the app is reachable from `%LOCALAPPDATA%`. `Update.exe --createShortcut` can be re-run. | Yes |
| Update interrupted mid-download | The old version keeps running. Squirrel resumes or restarts the download next time. | Yes |
| Disk full during an update | The old version is retained; the update fails cleanly. | Yes |
| Uninstall with the app running | Squirrel asks it to exit. A running transfer prompts, exactly as closing normally would. | Yes |
| User data after uninstall | **Deliberately preserved** — sites, settings and version history stay under the user data directory. An uninstall is not a request to destroy someone's site inventory. | n/a |

## Security considerations

- **No code signing.** Anyone can produce a binary claiming to be this app, and
  Windows will warn about the genuine one too. Download only from the project's
  own release page; the release notes state this rather than hiding it.
- **Per-user install, no elevation.** The installer cannot modify machine-wide
  state, which limits what a compromised installer could do — and means an
  install never asks for administrator rights, so a prompt claiming to be this
  installer asking for them is a red flag.
- **`iconUrl` is fetched by Windows**, not by the app, and only for the
  Add/Remove Programs icon. It carries no user data.
- **Updates are verified by Squirrel's own checksum** in the `RELEASES` manifest.
  That protects against corruption; without signing it does not by itself protect
  against a substituted package on a compromised host.
- **User data survives uninstall**, which is the right default and is worth
  knowing if the data is sensitive — removing the app does not remove the
  history repository or the stored (encrypted) credentials.

Shortcut cleanup is guarded by the host platform: `removeShortcut()` is a
no-op off Windows. This prevents a Linux or macOS headless/uninstall path from
deriving a `.lnk` filename under the user's home directory and deleting a
regular file. Shortcut creation and removal therefore both require the
Windows shell integration surface.

## Verification

The installer was **built and inspected** — see [building](building.md) for the
exact artefact sizes and the `RELEASES` manifest contents. The executable's
version resource and stamped icon were confirmed.

A full install-run-update-uninstall cycle on a clean machine has **not** been
performed in this session, and this article does not claim it has.
[`HANDOFF.md`](../../HANDOFF.md) records that gap explicitly.

## Suggested articles

- [Building](building.md) — producing the installer.
- [Updates](updates.md) — the in-app half of the update flow.
- [CI](ci.md) — where release installers are built.
- [Releases](releases.md) — where they are published.
