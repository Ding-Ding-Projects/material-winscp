# Releases and dim sum code names

## What a release contains

Every successful [CI](ci.md) run publishes exactly one **non-draft** GitHub
Release carrying:

| Asset | What it is |
| --- | --- |
| `WinSCP Material <version> Setup.exe` | **The genuine installer built by that run.** |
| `winscp_material-<version>-full.nupkg` | The Squirrel update package. |
| `RELEASES` | The Squirrel update manifest. |
| `WinSCP Material-win32-x64-<version>.zip` | The portable archive. |
| `dim-sum-<dish-id>.png` | A real dim sum photograph from the bundled catalog. |
| `codename.json` | The machine-readable code-name assignment. |

A release with no installer, or with an installer that was not built by that
run, is not a release. The workflow fails rather than publishing one.

## The tag

`v<version>-build.<run_number>`. Monotonic, never recycled, never overwritten.

## The dim sum code name

Every build carries a code name — the dish's English and Traditional Chinese
names together, exactly as the catalog records them:

> **Classic Har Gow · 蝦餃**

It is a **label beside the version, never a replacement for it**. The version
number stays the thing a user and a machine identify a build by, and the release
notes say so explicitly.

### Only dishes with a verified image are eligible

The catalog is built incrementally and reports `catalogStatus: "in-progress"`.
`build/pick-codename.js` **decodes** each candidate's PNG before offering it; a
record whose image is missing or corrupt is skipped, never guessed at and never
substituted. Choosing a name whose photograph does not exist would produce a
release whose code name renders as a broken image — worse than having no code
name at all.

### Used once, never recycled

A dish is used once per project. The mapping is **deterministic** rather than
recorded by a bot, because CI must not push a commit back to this repository
(that would retrigger itself — see [CI](ci.md)).

`build/release-codenames.json` holds a fixed sequence. Release number *N* takes
entry *N*, counting only dishes whose image decodes. Anyone can recompute any
build's name:

```sh
node build/pick-codename.js --index 7
```

The assignment is additionally recorded in three places a reader can check
without trusting CI: the release notes, the `codename.json` release asset, and
the workflow run summary.

### When the sequence runs out

The release **ships with its version alone**, and the notes say so plainly. A
release is never blocked, delayed or renamed because the catalog is exhausted —
and no dish is reused, because two builds sharing a code name defeats the one
job a code name has.

Verified locally: with six eligible dishes, `--index 7` reports

> release 7 is past the end of the verified sequence (6 dishes). A dish is used
> once and never recycled, so this release ships with its version alone.

and still attaches a photograph, labelled as a photo rather than a code name.

## Where the code name appears

- The release notes.
- The [changelog viewer](changelog.md) entry.
- The landing page's release section.
- The app's About surface.

Always with the catalog's own bundled photo — never a food photo fetched from a
CDN, never an invented dish. The dish's name stays factual at every
[funny level](../accessibility-and-languages/funny-levels.md) and in every
language mode, and its alt text names the dish so the code name reaches
screen-reader users too.

## Failure modes

| Situation | What happens |
| --- | --- |
| No eligible dish | Release ships with its version alone; a warning is logged. |
| The staged photo copy fails to decode | The run fails rather than attaching a corrupt image. The copy is verified, not just the source. |
| A tag already exists | Cannot happen — `run_number` is monotonic. If it somehow did, `gh release create` fails visibly rather than overwriting. |
| The release notes reference a missing asset | `release-notes.js` only lists assets whose files exist at compose time. |
| Catalog grows later | New dishes extend the sequence. Already-assigned numbers keep their dishes, because the order is append-only. |

## Security considerations

- **Releases are unsigned.** The notes state this and warn about SmartScreen.
  Downloading from anywhere other than the project's own release page is the real
  risk.
- **The photo is a byte-for-byte copy of a tracked repository asset.** Nothing is
  generated, downloaded or substituted at publish time, so a release asset cannot
  become a vector for content nobody reviewed.
- **`codename.json` contains no secret** — dish ids, names, paths and sizes.
- **The token is never printed** by any step that composes or publishes a release.

## Verification

Verified locally with real output: the code-name resolver decodes all six catalog
images at `1254x1254`, assigns `Classic Har Gow · 蝦餃` to release 1, and reports
exhaustion correctly at release 7. `build/release-notes.js` composes complete
notes from a real 124.6 MB `Setup.exe` and a real catalog photo.

**No release has been published yet.** No claim is made that a release exists or
that CI is green.

## Suggested articles

- [CI](ci.md) — what publishes a release.
- [Building](building.md) — the artefacts a release carries.
- [The changelog viewer](changelog.md) — where code names appear in-app.
- [The dim sum surprise](../accessibility-and-languages/dim-sum.md) — the same catalog, the other feature.
