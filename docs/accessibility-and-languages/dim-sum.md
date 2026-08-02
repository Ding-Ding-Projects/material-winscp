# The dim sum surprise

## What it does

At startup there is a **10% chance** of a small, non-blocking card appearing with
a randomly chosen dim sum dish — its name in both languages, and a photograph of
it. It is a small delight, not a feature anyone has to manage.

```
🥟  Shrimp dumpling · 蝦餃
```

## Behaviour

- **A fresh random draw per launch**, at exactly 10%. Never more frequent than
  stated, and never twice in one launch.
- **Non-blocking and auto-dismissing.** It never gates startup, never steals
  focus, and never delays the app becoming usable.
- **Never during a first run, an error path, an update, or any flow where the
  user is mid-task.** A surprise during a failed migration is not a delight.
- **The dish name is correct at every funny level and in every language mode.**
  The level styles the copy *around* the dish; the dish's own name is a fact.
- **Bundled local images only** — no network fetch, no third-party CDN, no
  tracking, no analytics.
- **Meaningful alt text naming the dish**, so screen-reader users get the same
  delight rather than "image".
- **Respects reduced motion** and any quiet or do-not-disturb setting: with
  reduced motion the card appears without animation, and it still auto-dismisses.

## No opt-out

There is deliberately **no setting to disable it**, and any stored preference
from an older profile that would have disabled it is migrated forward so those
profiles simply rejoin the draw.

What makes an un-optable surprise polite is everything above: it does not block,
does not steal focus, does not interrupt a task, and goes away by itself. A
feature that respected all of that and still needed an off switch would be a
feature that was doing one of those things wrong.

## The catalog

`design/winscp-data.js` holds the dish records — id, English name, Traditional
Chinese name, Jyutping, and the path to a bundled image under `design/assets/`.
`design/main/dimsum.js` reads it.

The catalog is built incrementally and reports its status. **Only dishes with a
real bundled image that decodes are eligible** — for the surprise, and for
[release code names](../packaging-and-updates/releases.md). A record whose image
is missing is skipped, never substituted and never generated.

`PREF_DEFAULTS.dimSum` keeps `lastShownLaunch` and `seen`, used to vary which
dish appears rather than to gate whether one does.

## Failure modes

| Situation | What the user sees | Recoverable |
| --- | --- | --- |
| A record's image is missing or does not decode | That dish is skipped. If none is eligible, nothing appears — silently, because a missing surprise is not an error worth telling anyone about. | n/a |
| Startup is slow | The draw happens after the app is usable, never before. It cannot delay startup even in principle. | n/a |
| A first run, an error path, or an update | Suppressed. Checked before the draw, so it does not even roll. | n/a |
| Reduced motion | No animation; the card still appears and still dismisses. | n/a |
| A screen reader | The alt text names the dish. Announcement is `polite`, so it never interrupts. | n/a |
| The user does not want it | There is no off switch. It is one small non-blocking card, one launch in ten. | n/a |

## Security considerations

- **Bundled assets only.** No network request, no CDN, no tracking pixel, no
  analytics event. The surprise cannot be used to report that the app started.
- **No image is ever generated, downloaded or substituted** to fill a gap in the
  catalog. Missing means skipped.
- **It cannot appear during an error path**, which is also a safety property: a
  cheerful card next to a failed migration would look like everything is fine.
- **It never takes focus**, so it cannot interpose itself between a user and a
  dialog they are answering — including a credential prompt.

## Verification

- The draw rate is tested statistically over many simulated launches, asserting
  approximately 10% and never twice in one launch.
- Suppression is tested for first run, error paths, update flows and mid-task
  states.
- Non-blocking behaviour is tested by asserting the app is interactive before the
  card can appear and that focus never moves to it.
- Every catalog record is asserted to have an image that exists and decodes;
  records that fail are asserted to be skipped rather than substituted.
- Alt text is asserted present and to name the dish.
- Reduced-motion behaviour is tested.
- Migration of a legacy disable preference is tested to rejoin the draw.

## Suggested articles

- [Language modes](language-modes.md) — the dish name in both languages.
- [Funny levels](funny-levels.md) — which styles the copy but never the dish name.
- [Releases](../packaging-and-updates/releases.md) — the same catalog supplies release code names.
- [Notifications](../interface-and-appearance/notifications.md) — the non-blocking surface rules.
