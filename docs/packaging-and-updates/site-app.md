# The site's client application

`site/src/app.js`, `site/src/app.css` and `site/src/lib/` — the part of the
documentation site that runs in the visitor's browser.

For the builder that emits it, the base path and `--verify`, see
[the documentation site](site.md).

## Why this article exists at all

The repository's homepage field advertised a URL where **every path 404ed,
including the root**, and one of the four reasons was that this application had
never been written. `index.html` referenced `{{BASE}}app.css` and
`{{BASE}}app.js`; `git log --all --diff-filter=A` found no commit that had ever
added either. The page fetched two files that did not exist and rendered
nothing.

That is worth stating plainly in the documentation, because the shape of the
failure explains most of the decisions below: nothing here may depend on a step
that can be skipped, and every reference the browser will fetch has to be
something the build can *prove* is there.

## Shape

| File | |
| --- | --- |
| `app.js` | The entry module. Boots, wires the topbar, owns the router callback. |
| `app.css` | Material 3 tokens, reset, and every component. One file, no imports. |
| `lib/color.js` | Colour conversion, parsing, contrast, and the tonal palette the scheme is derived from. |
| `lib/regex.js` | The match predicate, bounded evaluation, and the guided-construction catalogue. |
| `lib/i18n.js` | The dictionary, three language modes, two funny-level sliders. |
| `lib/router.js` | Hash routing and the ambiguous-anchor resolution below. |
| `lib/store.js` | Persisted settings: normalisation, export/import, the change bus. |
| `lib/theme.js` | Turns settings into CSS custom properties on `:root`. |
| `lib/dom.js` | Element factory, popover anchoring, focus memory, announcements. |
| `lib/toast.js` | Non-blocking notifications, the notification centre, the one modal. |
| `lib/regexbuilder.js` | The anchored regex builder UI. |
| `lib/colorpicker.js` | The infinite colour picker and translator UI. |
| `lib/tabs.js` | The tab strip: overflow, pinning, reordering, bulk close. |
| `lib/settings.js` | The settings surface and its own search. |
| `lib/pages.js` | Home, category, article, search and 404 rendering. |
| `lib/dimsum.js` | The 10%-per-visit dim sum surprise. |

**Plain ES modules, loaded directly by the browser.** There is no bundler, no
transpiler and no build step beyond `site/build.js`, which copies `site/src/`
recursively and substitutes `{{BASE}}` in text files.

`app.js` is loaded with `type="module"` and imports `./lib/*.js` by relative
specifier, which resolves against the module's own URL — so `lib/` ships under
whatever prefix the deployment has without the build substituting anything into
an import. Only the three top-level references in `index.html` carry `{{BASE}}`,
and `--verify` checks exactly those.

`content.js` is a classic script and therefore runs first, defining
`window.SITE_DATA`. Module scripts are deferred, so the data is always populated
before `app.js` executes.

> [!IMPORTANT]
> **A module import is a subresource.** `--verify` scans `import … from '…'`,
> `import('…')` and `import '…'` in every emitted `.js`, resolves each specifier
> relative to its importer, and fails the build if the target was not emitted.
> Without that check a missing `lib/` file is invisible to a `src=`/`href=`/
> `url()` scan, and an unresolvable import fails the *whole* module graph — one
> absent file is a blank page, not a degraded one. This is the same class of bug
> that broke the site, one level down.

## Routing

Hash routing, not the History API, and for a concrete reason: Pages has no
rewrite rule, so `/material-winscp/protocols/sftp` is a request for a file that
does not exist and Pages answers 404. `#/protocols/sftp` is always a request for
`index.html`.

| Route | |
| --- | --- |
| `#/` | Landing page |
| `#/settings` | Settings |
| `#/search?q=…` | Search results |
| `#/<category>` | Category index |
| `#/<category>/<article>` | An article |

### The ambiguous-anchor problem

`site/build.js` turns a markdown link with a fragment — `sftp.md#known-hosts` —
into `#/protocols/sftp-known-hosts`. That is indistinguishable *by shape* from
an article whose slug contains a hyphen, and every slug here contains hyphens.

So resolution is a **lookup, not a parse**: match the longest known id, and treat
whatever remains as the in-page anchor.

- `#/protocols/sftp-extensions` → the article `sftp-extensions`, no anchor.
- `#/protocols/sftp-known-hosts` → the article `sftp`, anchor `known-hosts`.

`resolve()` therefore takes the content index; `parse()` alone decides nothing.

### The skip link is not a route

`href="#main"` is the correct markup for a skip link and, on a hash-routed page,
also a navigation to the route `/main`, which resolves to nothing and renders
the 404. The click is intercepted: focus moves to `<main>` (which carries
`tabindex="-1"` so it can receive it) and the hash is left alone. The `href`
stays because it is what makes the control a link at all.

## Search and the regex builder

Every search field owns its own builder, anchored beside it — the topbar search,
the settings search, the tab search, and both bulk-close fields. One shared
global dialog that silently applies to whichever field was touched last is
explicitly what this is not.

- **Plain text is the default.** `a.b` means a dot. Regex is an explicit opt-in.
- **Synchronisation is bidirectional.** Typing in the field updates the builder;
  building a pattern updates the field. Switching text → regex escapes the
  literal query so it keeps meaning the same thing.
- **One predicate for a filter and its inverse.** `makePredicate()` returns one
  object and `invert()` negates that same compiled test, so casing, Unicode and
  flags cannot drift between "containing" and "not containing".
- **Evaluation is bounded and local.** 20 000 characters of sample, 500 matches,
  a 400 ms wall clock. Nothing is transmitted; everything runs in the visitor's
  browser.

### Catastrophic patterns are refused, not run

JavaScript has no regex timeout, so the defence has to be to refuse the shape
before running it. Two are refused, and both are the classic exponential one:

1. a quantified group containing a quantifier — `(a+)+`, `(\w*)+`;
2. a quantified group containing an **alternation** — `(a|aa)*`. Missing this
   one is easy and expensive: `(a|aa)*b` against a run of `a`s hangs exactly as
   hard as `(a+)+$` and contains no nested quantifier at all.

This is a heuristic, not a decision procedure. `(?:ab|cd)+` is linear and is
refused anyway. A false refusal is a sentence the user can read; a false accept
is a frozen tab.

An empty query is refused rather than treated as "matches everything", and
inverting a refused predicate stays refused — otherwise "close tabs not
containing ⟨nothing⟩" closes every tab you have.

## Appearance

The whole Material 3 scheme is derived at runtime from one seed colour.

- **Light and dark both ship as a floor in `app.css`**, so the first paint is
  styled before any module runs and a module error leaves a readable page rather
  than unstyled text. `prefers-color-scheme` supplies the default;
  `:root[data-theme]` — which `theme.js` stamps — overrides it in both
  directions, so an explicit choice always wins.
- **The tonal palette is derived in OKLab, not HCT.** The desktop app uses
  CAM16/HCT (`design/renderer/theme.js`); reproducing it here would duplicate
  ~300 lines of colour appearance modelling in a repository that already has a
  copy, and the translator needs OKLCH anyway. Both produce valid Material 3
  tonal palettes; **they are not byte-identical**, so the same seed can land a
  shade away from what the app produces.
- Tones are anchored by converting each Material tone (a CIE L\* value) to the
  OKLab lightness of the grey with that L\*, so a "tone 90" container and a
  "tone 90" surface sit on the same perceptual rung.
- Out-of-gamut colours are **gamut-mapped by walking chroma down**, never
  clipped — clipping shifts the hue, which is what makes a generated dark theme
  look muddy.

### The colour picker

A continuous two-dimensional saturation/value field, a continuous hue rail, and
direct numeric entry. Swatches and recents sit on top of that; they do not
replace it.

The translator prints **Named, HEX, HEX8, RGB, RGBA, HSL, HSLA, HSV/HSB, HWB,
CIELAB, CIELCH, OKLab, OKLCH and CMYK**, and every string it prints is one
`parseAnyColor()` reads back as the same colour — that round trip is a test, not
a claim. Notations that cannot carry transparency are flagged rather than
silently dropping alpha.

## Languages and funny levels

Three modes (English, playful Hong Kong Cantonese, bilingual) and **two
independent sliders**, one per language, 1 (fully serious) to 5 (maximum
playfulness). Both persist.

The level changes **voice, never facts**. A test substitutes a byte-distinct
sentinel for every parameter of every leveled entry and asserts it survives —
same bytes, exactly once — at all five levels in both languages. A rewrite that
loses `{0}` from a warning still reads beautifully and has silently stopped
naming the thing the warning is about; no screenshot catches that.

## Tabs

Each category, article and the settings page is a tab, and the strip persists
per visitor.

- **Overflow is explicit.** Everything that does not fit moves into an overflow
  surface with a live count. Tabs are `flex: 0 0 auto` for a load-bearing
  reason: as shrinkable flex items they squeeze to a sliver of ellipsis instead
  of overflowing, so the strip always "fits", the measurement never has anything
  to move, and every tab is on screen with none of them readable.
- **The active tab is reserved first.** Filling left to right and letting the
  remainder overflow puts the page you are reading into a menu.
- **Measurement is synchronous**, not in `requestAnimationFrame`. rAF callbacks
  are not delivered while a page is not producing frames — a backgrounded tab, a
  hidden pane, a headless check — and a strip that computes its overflow only
  once a frame is painted ships every tab past the right edge in exactly the
  situations nobody is watching.
- **Pinning is first-class**: its own region, a compact label with the full name
  still exposed to assistive technology, excluded from bulk closes by default.
- Reorder by drag or <kbd>Ctrl</kbd>+<kbd>←</kbd>/<kbd>→</kbd>; pin with
  <kbd>Ctrl</kbd>+<kbd>P</kbd>. Every context-menu item shows its shortcut.

## Accessibility

- `tablist`/`tab` roles with roving `tabindex`, `aria-selected`, and live
  `aria-controls`; <kbd>←</kbd> <kbd>→</kbd> <kbd>Home</kbd> <kbd>End</kbd>
  <kbd>Enter</kbd> <kbd>Delete</kbd> all operate the strip.
- Focus is always visible: `:focus-visible` draws a 2 px outline, and no rule
  removes it without replacing it.
- Every popover traps <kbd>Tab</kbd> while open, closes on <kbd>Esc</kbd>, and
  **returns focus to whatever opened it**.
- Overlays paint their own surface, are bounded to the space available, and
  scroll inside that bound — a capped height with hidden overflow deletes the
  last items of a menu with no scrollbar to say anything is missing.
- Route changes are announced through a polite live region, because the URL and
  the content changed and nothing moved focus.
- `prefers-reduced-motion` is respected, and the in-app *Reduce motion* setting
  is additive to it, never an override.

## Failure modes

| Situation | What happens |
| --- | --- |
| `content.js` missing or did not execute | The page renders a plain explanation naming the file and the command that reports it, rather than a blank body. |
| A `lib/` module missing from the output | `--verify` fails the build and names the importer, so it never deploys. |
| `localStorage` refused (private mode) | Settings work for the session; a warning toast says they will not survive a reload, and the settings page says so too. |
| A stored profile from an older build | `normalize()` fills every missing key from the defaults and clamps every value, so `undefined` never reaches a CSS variable. |
| A tampered or foreign settings import | Rejected with the reason, or normalised on the way in. Never trusted as-is. |
| A pattern that would hang the page | Refused with an explanation before it runs. |
| No published release | **No download button at all**, plus a sentence saying the page will not guess a URL. |

## Security considerations

- **Everything is bundled locally.** No CDN script, stylesheet, font or image;
  no analytics; no tracking. `--verify` fails the build on a cross-origin
  `src`, `<link href>`, `url()`, `@import` or module import, so this is enforced
  rather than remembered.
- **Nothing leaves the browser.** Search queries, regex patterns, sample text
  and settings are evaluated and stored locally. There is no network call at
  runtime other than fetching the site's own files.
- **Article HTML is generated at build time from `docs/` in this repository**,
  not fetched or user-supplied, and is inserted with `innerHTML` on that basis.
  Text that comes from a visitor — a query, a pattern, a tab title — goes
  through `textContent`.
- **`window.__site` exposes the store, router and index for debugging** and
  nothing that would let another script drive the page.

## Verification

Verified locally at the time of writing, on Node 26.5.1 and on Node 22.23.2
(the version CI pins):

- `node site/build.js --verify` → **VERIFY OK**, 14 categories, 128 articles,
  6 bundled images, 27 files. Before this change the same command reported
  `app.js` and `app.css` missing and exited 1.
- `node --test test/site-app.test.js` — **36 tests, 36 passing.** With
  `site/src/lib/`, `app.js` and `app.css` moved aside, **0 pass and 36 fail**:
  they test code that did not previously exist.
- `node --test test/site-build.test.js` — **32 tests, 32 passing** (was 31).
  The five release-manifest tests and the two module-import tests all fail
  against the previous `site/build.js`.
- Driven in a real browser against `node site/build.js --serve`: every route
  renders, the regex builder reports live matches and capture groups and refuses
  `(a+)+$`, the colour picker parses `oklch(…)` and prints all 14 notations, the
  seed reaches `--p`, 20 tabs at 1280 px leave 6 visible and 14 in the overflow
  menu with the active tab always visible, the settings search teleports across
  tabs, and the dim sum card renders the correct dish with real alt text from a
  bundled image that fetches 200.

**Not verified:** the published site. See
[the documentation site](site.md#publishing) — the workflow has still never run,
and Pages is still not enabled on the repository.

## Suggested articles

- [The documentation site](site.md) — the builder, the base path, and what `--verify` proves.
- [Search and regex](../search-and-regex/) — the same builder, in the desktop app.
- [Language modes](../accessibility-and-languages/language-modes.md) — the dictionary format shared with the app.
- [The dim sum surprise](../accessibility-and-languages/dim-sum.md) — the catalog the site bundles.
- [Continuous integration](ci.md) — the other workflow, and the release loop this one avoids.
