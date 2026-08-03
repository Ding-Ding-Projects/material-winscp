# Building

## What it does

`forge.config.js` drives Electron Forge. Two commands matter:

```sh
npm run package   # produce the unpacked app in out/
npm run make      # produce the installer and the zip in out/make/
```

## Requirements

| | |
| --- | --- |
| OS | Windows (the Squirrel maker requires a Windows toolchain) |
| Node | **22 LTS.** See the pin note below. |
| Electron | 33, installed as a devDependency |

### The Node version pin, and why it exists

CI pins Node 22, and local builds should match. On Node 26 the packaging chain
stalls silently: `@electron/packager` extracts the Electron zip with
`extract-zip` → `yauzl` 2.x → `fd-slicer`, and on that Node version
`openReadStream` never delivers data. The process exits **cleanly with status 0**
after extracting one file, and no `out/` directory is produced.

That failure mode is worth naming precisely, because "exit 0 and no output" reads
as a configuration mistake rather than an environment one. It is not a
`forge.config.js` problem, and changing the config does not help.

## What `npm run make` produces

Verified locally on Windows 11 with Node 22.20.0 and Electron 33.4.11:

| Artefact | Path under `out/make/` | Size |
| --- | --- | --- |
| **Installer** | `squirrel.windows/x64/WinSCP Material 0.1.0 Setup.exe` | 130,696,704 bytes (124.6 MB) |
| Update package | `squirrel.windows/x64/winscp_material-0.1.0-full.nupkg` | 129,278,416 bytes (123.3 MB) |
| Update manifest | `squirrel.windows/x64/RELEASES` | 86 bytes |
| Portable archive | `zip/win32/x64/WinSCP Material-win32-x64-0.1.0.zip` | 132,236,644 bytes (126.1 MB) |

The unpacked application lands in `out/WinSCP Material-win32-x64/`, with
`WinSCPMaterial.exe` as the entry point. Its version resource carries the
product name, company, version and copyright from `package.json`, and the icon
is stamped in.

## Configuration

`forge.config.js` sets:

| Setting | Value |
| --- | --- |
| `packagerConfig.name` | `WinSCP Material` |
| `packagerConfig.executableName` | `WinSCPMaterial` — no space, so paths and shortcuts stay simple |
| `packagerConfig.icon` | `build/icon` (`.ico` appended by the packager) |
| `packagerConfig.ignore` | Excludes `.git`, `.github`, `.claude` linked worktrees, `vendor`, `test`, `docs`, `site`, `out`, uploads and screenshots |
| `makers[0]` | `@electron-forge/maker-squirrel` — see [installer](installer.md) |
| `makers[1]` | `@electron-forge/maker-zip` |
| `publishers` | **Empty, deliberately.** [CI](ci.md) publishes with the `gh` CLI so the notes can carry the dim sum code name and photo. |

## The icon

`build/icon.ico` is produced by `node build/make-icon.js`, which decodes a
**repository-tracked** catalog image (`design/assets/dim-0001-har-gow.png`), box-
samples it to 16/24/32/48/64/128/256 px, rounds the corners and writes a
multi-size `.ico`.

Nothing is generated, downloaded or fetched — the script only re-encodes an
image that is already in the repository, and it is deterministic: the same
tracked input always yields the same icon.

## Failure modes

| Situation | What happens |
| --- | --- |
| `design/main/main.js` missing | Packaging fails with "The main entry point to your app was not found". The path comes from `package.json`'s `main`. |
| `build/icon.ico` missing | `forge.config.js` warns and builds **without** a custom icon rather than failing. Run `node build/make-icon.js` to restore it. |
| Node 26 (or another affected version) | Silent stall during Electron extraction, exit 0, no `out/`. Use Node 22. |
| Building on a non-Windows host | The Squirrel maker is platform-restricted to `win32`; the zip maker still runs. |
| Antivirus scanning `out/` | Can slow the build considerably or lock a file mid-write. Excluding the build directory is the usual fix. |
| Disk space | The unpacked app plus the nupkg plus the zip is roughly 500 MB per build. |

## Security considerations

- **Builds are not code-signed.** Windows SmartScreen will warn on first run, and
  the release notes say so. Signing needs a certificate, which is credential
  material and is not something this repository can hold.
- **`packagerConfig.ignore` keeps the porting reference, the tests, the docs and
  the site out of the shipped app**, which reduces both size and the amount of
  material distributed with the binary. It also excludes `.claude/worktrees/`:
  linked-agent checkouts are local development state and can otherwise recurse
  into a previous `out/` tree, turning a 130 MB app into a multi-gigabyte asar.
- **`prune: true`** means devDependencies are not shipped.
- **No absolute local toolchain path is committed**, and no installed dependency
  is committed. `out/` and `node_modules/` are ignored.

## Verification

`npm run make` was run and the artefacts above were inspected: sizes recorded,
the `RELEASES` manifest checked for the correct SHA1 and byte count, the
executable's version resource read, and the icon confirmed to extract from the
built `.exe`.

The installer has **not** been run to completion on a clean machine in this
session, so this article does not claim a verified end-to-end install. See
[`HANDOFF.md`](../../HANDOFF.md) for exactly what was and was not verified.

## Suggested articles

- [The installer](installer.md) — what the Setup.exe does when run.
- [CI](ci.md) — the same build on a hosted runner.
- [Releases](releases.md) — where the artefacts go.
- [The dim sum surprise](../accessibility-and-languages/dim-sum.md) — the catalog the icon came from.
