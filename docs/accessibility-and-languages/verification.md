# Verification

How the accessibility and language requirements are actually checked, what a
machine proves on every run, and what still needs a person in front of a screen.

The requirements themselves live in
[accessibility.md](accessibility.md), [language-modes.md](language-modes.md) and
[funny-levels.md](funny-levels.md). This article is only about evidence.

## The short version

| Requirement | Verified by |
| --- | --- |
| Every key has a Cantonese counterpart | Automatic — `test/i18n.test.js` |
| The funny level changes voice, never facts | Automatic — `test/i18n.test.js` |
| The two sliders are independent | Automatic — `test/i18n.test.js` |
| Generated themes meet WCAG AA in light and dark | Automatic — `test/theme.test.js` |
| High contrast actually raises separation | Automatic — `test/theme.test.js` |
| Fonts always fall back to a CJK-safe family | Automatic — `test/theme.test.js` |
| Bulk close and its inverse use one predicate | Automatic — `test/tabs-logic.test.js` |
| Pinned tabs are protected from bulk closes | Automatic — `test/tabs-logic.test.js` |
| Tab roles, roving focus, pinned accessible name | Automatic (source contract) — `test/tabs-logic.test.js` |
| A runaway regex is stopped, not waited for | Automatic — `test/renderer-logic.test.js` |
| Shared search/regex controls stay localized and stateful while open | Automatic (source contract) — `test/issue16-contract.test.js` |
| OS reduced-motion mode disables animation and smooth preference scrolling | Automatic (source contract) — `test/issue16-contract.test.js` |
| Alpha survives the colour translator | Automatic — `test/renderer-logic.test.js` |
| Visible focus, focus order, focus return | **Human pass** |
| Screen-reader names, states and announcements | **Human pass** |
| No clipping at 100 / 125 / 150 / 200 % scale | **Human pass** |
| Bilingual mode at the narrowest supported width | **Human pass** |
| Reduced motion is instant, not merely faster | **Human pass** |

## Running the automatic checks

```
npm test                              # the whole suite, main process and renderer
node --test test/i18n.test.js         # one file
node --check design/renderer/i18n.js  # syntax only
```

The renderer's pure logic is deliberately free of DOM dependencies — colour
maths, string resolution, the match predicate, the colour translator — so all of
it runs headlessly under `node --test` with no browser, no bundler and no
stubbed `document`.

## What the language tests actually prove

The rule is easy to state and easy to break: **the funny level changes voice,
never facts**. A level-5 rewrite that reads beautifully and quietly drops `{1}`
from a delete confirmation stops telling the user which files are about to be
destroyed, and nothing about the screenshot looks wrong.

`test/i18n.test.js` substitutes a byte-distinct sentinel for every parameter of
every leveled entry — a host name, a CJK file name, a large byte count, a path
with spaces and Greek — then renders that entry at all five levels in both
languages and asserts each sentinel appears the **same number of times, as the
same bytes**, at every level. A dropped, translated, truncated, reordered or
duplicated parameter fails the run.

Around it:

- **Parameter sets match across levels and across languages.** If the English
  level 3 takes `{0}` and `{1}`, so do English levels 1–5 and all five Cantonese
  levels. A Cantonese rewrite that loses a parameter the English keeps is the
  same defect seen from the other side.
- **No placeholder survives rendering.** A `{0}` visible in the interface means a
  caller forgot a parameter, and that is asserted rather than eyeballed.
- **The voice really does change.** Every leveled entry must produce a different
  string at level 1 and level 5, in both languages, with at least three distinct
  voices across the five. A slider that does nothing is as much a defect as one
  that changes the wrong thing.
- **Plain entries are level-invariant.** A key with no leveled copy renders
  identically at all five levels, so a slider never introduces variation the
  dictionary does not contain.
- **The sliders are independent.** In bilingual mode the English half follows the
  English slider and the Cantonese half follows the Cantonese one; both halves
  still state the host name.
- **Every key renders non-empty** in all three modes at all five levels — 698
  keys × 3 modes × 5 levels on every run.
- **Substitution is literal.** A file named `$& $1 $$` is inserted verbatim; a
  missing parameter leaves its placeholder visible rather than rendering a
  sentence with a hole in it; `0` is a value, not an absence.
- **The disclosure is honest.** `disclosureText()` and the `funnyDisclose` key
  must both name errors and warnings explicitly, in both languages.

## What the theme tests actually prove

The scheme is derived from one seed through CAM16, not HSL. That distinction is
invisible in a screenshot and decisive in a contrast audit, so it is asserted
numerically:

- **CAM16 round-trips exactly.** Every in-gamut sRGB colour with tone 5–95 and
  chroma ≥ 1 survives `hex → HCT → hex` byte for byte.
- **Tone is CIE L\*.** `lstarFromY(yFromLstar(t))` returns `t` to within 1e-9,
  and L\* 50 is 18.42 % relative luminance — the single number that rules HSL
  out as a source of tones.
- **Generated colours land on the tone they were asked for**, within a quarter of
  an L\* step, across the whole M3 tone ladder and eight hues.
- **The gamut solver degrades chroma, never hue or tone.** Asking for chroma 200
  returns the most chromatic in-gamut colour at that hue and tone: the tone holds
  to 0.25 L\*, the hue to 4.5°, and the delivered chroma never falls as the
  request rises.
- **A palette holds its seed hue** across every tone, for twelve seeds spanning
  the hue circle plus the achromatic extremes.
- **Fifteen foreground/background pairs clear WCAG AA (4.5:1)** for twelve seeds
  in both light and dark — including the "on" role against every surface
  container it is actually painted on. `onSurface` on `surface` additionally
  clears AAA (7:1) in both modes.
- **Medium and high contrast raise real separation**, monotonically, for surface,
  surface-variant and outline text.
- **Every font stack ends in a CJK-safe fallback** and contains no `url()`,
  `@import` or `http` — bilingual mode must never tofu, and nothing may reach the
  network.

## What the tab tests actually prove

`ui/tabs.js` builds its DOM eagerly and exports no pure model, so it is covered
two ways and both must hold:

1. **A reference model** implementing the strip's rules — pinned region first,
   groups in group order, then ungrouped; pinning clears group membership;
   removing a group keeps its tabs; collapse hides without unlinking — exercised
   against the **real** predicate from `ui/regexbuilder.js` and the **real**
   filter from `ui/searchbar.js`.
2. **Source-contract assertions** that read `ui/tabs.js` and check the shipped
   code still expresses those rules at the exact lines that matter. Each names
   the rule it guards, so a deliberate change updates it knowingly.

The assertion this file exists for:

> "Close tabs containing text" and "Close tabs NOT containing text" must negate
> **one** predicate.

Two separately built matchers drift on flags, casing, Unicode and scope, and the
two menu entries then disagree about the same tab. The tests prove the two
directions **partition** the strip exactly — union is the whole pool, intersection
is empty, order preserved — for plain text, mixed case, Han script, `/…/gi` and
`\p{Script=Han}/gu`; and the source contract pins the single
`containing ? predicate.test(…) : !predicate.test(…)` expression and the single
`bar.predicate` read that produce it.

Also covered: pinned tabs excluded by default and the exclusion *reported*, the
empty-query and invalid-pattern refusals, unsaved-work protection surviving a
bulk close, all four searches listing the right rows with their own predicates,
a result inside a collapsed group being findable without discarding the collapsed
preference, `role="tablist"/"tab"/"tabpanel"` with live `aria-controls`, roving
focus over the strip, the full accessible name on an icon-only pinned tab, the
overflow surface that keeps tabs from being silently clipped, the container
context-menu guard that stops every entry appearing twice, and the absence of
`innerHTML`.

## What the shared-machinery tests actually prove

`test/renderer-logic.test.js` covers what every search surface and colour control
sits on:

- **The match predicate.** Plain text is a locale-aware case-insensitive
  substring match — Greek, Cyrillic, accented Latin and astral-plane characters
  included — and metacharacters are haystack, not syntax. Regex mode strips the
  `g` flag, so ten calls to `test()` give ten identical answers; a sticky
  `lastIndex` is precisely how the two bulk-close directions would disagree.
- **Failure is safe.** An invalid pattern reports its error, never throws, and
  matches nothing; `filterBy` returns an empty list for it rather than silently
  returning everything. An empty query returns everything rather than nothing.
- **Bounded evaluation.** The sample is capped at 20 000 characters, matches at
  500 with the truncation reported, zero-width patterns advance instead of
  looping, and a starved budget stops early and *says so* through `timedOut`
  rather than presenting a short list as the whole answer.
- **A runaway pattern is terminated, not waited for.** The canonical shapes
  (`(a+)+`, `(a|a)*`, `(?:\d+)+$` …) are flagged by `backtrackingRisk` before
  they can run, and the test proves `(a+)+b` genuinely does not finish inside the
  400 ms budget by running it in a terminable worker and killing it — the same
  strategy the app uses, so the warning is demonstrably not theatre.
- **The colour translator round-trips.** All twelve representations
  (Named, HEX, HEX8, RGB, HSL, HSV/HSB, HWB, CIELAB, LCH, OKLab, OKLCH, CMYK)
  parse back to the same colour within 2/255 per channel, alpha preserved exactly
  by every notation that can express it and to within 1/255 by HEX8. A colour
  outside sRGB is flagged `inGamut: false` **before** it is clipped.

## The human pass

None of the above replaces looking at the running application. Build it and drive
it — `npx electron .` from the repository root — and check the following. These
are completion blockers, not polish.

### Keyboard and focus

- Every command reachable without a pointer, including **Edit appearance…**
  (context menu, <kbd>Shift</kbd>+<kbd>F10</kbd>, and
  <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd>).
- Focus order follows visual order; focus is visible at every step, including
  over elements carrying appearance overrides.
- Composite widgets are one tab stop: the tab strip, the panels, the colour
  picker's field and rails.
- Modals trap focus and return it to the invoking element; anchored popovers do
  not trap but still return.
- <kbd>Esc</kbd> closes the innermost thing first.

### Screen readers

- Every control announces a name that does not depend on colour, icon or
  position; state is spoken, not implied — selected, expanded, pinned, busy,
  disabled, invalid.
- A pinned, icon-only tab announces its full title.
- State changes announce through the live region without moving focus: mode
  switches, bulk-close counts, runaway-pattern warnings, notifications.
- A collapsed group announces its collapsed state and its tab count.

### Scale and layout

- 100 %, 125 %, 150 % and 200 % display scale, at each of the four density
  settings, at the narrowest supported window width.
- Nothing clipped, truncated or overlapping. Where an ellipsis is unavoidable,
  the full text is in `title`.
- **Bilingual mode is the worst case** and must be checked at every scale: it
  carries the longest strings in the product, and the level-5 Cantonese copy is
  longer still. Set both sliders to 5, switch to bilingual, and walk the
  destructive dialogs, the queue, the preferences pages and the tab strip.

### Motion and sound

- With reduced motion on — forced, and inherited from the OS — transitions are
  **instant**, not merely shortened.
- Nothing auto-plays, auto-scrolls or flashes.

### Colour

- The live contrast readout in the colour picker and the appearance editor
  agrees with a third-party contrast checker on a handful of samples.
- A per-element appearance override that breaks contrast is reported to the user
  rather than silently accepted — the automatic tests cover the *generated*
  scheme, not what a user can then override it to.

## Known gaps

Stated plainly, because a verification article that only lists successes is not
evidence of anything.

- **`ui/tabs.js` has no pure export.** The tab model is covered by a reference
  model plus source-contract assertions, not by driving `createTabStrip()`. Drag
  reordering, the overflow measurement, the anchored popovers and focus
  restoration are only verified by using the application.
- **The regex Worker path cannot run under Node**, which has no global `Worker`.
  `evaluate()` is tested on its inline path, and the Worker termination strategy
  is proven separately with a `node:worker_threads` worker. The two are not the
  same code path.
- **The inline evaluation fallback only checks its deadline between matches.**
  A pattern that backtracks catastrophically inside a single `exec()` is not
  interrupted by it — the Worker's `terminate()` is what protects the running
  application, and `backtrackingRisk()` is what warns beforehand. The module
  header describes the inline path as refusing known-hazardous shapes; it does
  not currently do that.
- **`parseAnyColor()` accepts a truncated functional notation.** `rgb(` returns
  `NaN` channels instead of `null`. Every well-formed notation the translator
  emits is covered and returns whole channels in range.
- **`hsv()` and `cmyk()` carry no alpha**, and neither does six-digit hex. The
  translator lists HEX8 and RGB beside them, which do. The test asserts that set
  of three exactly, so a fourth notation cannot start dropping alpha unnoticed.
- **The `tips` dictionary entry is a six-item list stored in the leveled shape.**
  `t('tips')` therefore returns whichever tip matches the current funny level,
  and the sixth is unreachable through that path. It is not yet consumed by any
  surface; the tests treat it as a paired list and assert both languages stay the
  same length.
- **Nothing here checks a real screen reader.** Roles and names are asserted from
  source; how NVDA, Narrator or VoiceOver actually reads a surface is a human
  pass.

## Suggested articles

- [Accessibility](accessibility.md) — the requirements this article verifies.
- [Funny levels](funny-levels.md) — what the sliders change and what they never
  change.
- [Language modes](language-modes.md) — the dictionary and the three modes.
- [Tabs and navigation](../tabs-and-navigation/README.md) — the bulk-close rules
  the tab tests guard.
- [Search and regex](../search-and-regex/README.md) — the shared predicate and
  the evaluation bounds.
