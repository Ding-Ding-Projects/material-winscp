# Packaging and updates

How WinSCP Material is built, installed, released and updated.

## Articles

| Article | Covers |
| --- | --- |
| [building.md](building.md) | Building locally, the toolchain, and the real artefacts `npm run make` produces. |
| [installer.md](installer.md) | The Squirrel.Windows installer and the install/update lifecycle. |
| [ci.md](ci.md) | The GitHub Actions workflow, its gating, and the token chain. |
| [site.md](site.md) | The documentation site: its base path, what `--verify` proves, and how Pages publishes it. |
| [releases.md](releases.md) | Release tagging, assets, and the dim sum code names. |
| [updates.md](updates.md) | In-app update checks and how a user is offered a new version. |
| [changelog.md](changelog.md) | The in-app changelog viewer, its filters and its export. |

## Quick facts

| | |
| --- | --- |
| Runtime | Electron 33 |
| Installer | Squirrel.Windows, via `@electron-forge/maker-squirrel` |
| Also produced | A portable `.zip` |
| Code signing | **None.** SmartScreen will warn on first run. |
| CI runner | GitHub-hosted `windows-latest` |
| Release cadence | One release per successful CI run, uniquely tagged |

## Postman

Not applicable — this project exposes no HTTP API. See the
[documentation index](../README.md).

## Suggested articles

- [The dim sum surprise](../accessibility-and-languages/dim-sum.md) — the catalog release code names come from.
- [Version history](../version-history/) — the *other* thing in this project backed by git.
