# The changelog viewer

## What it does

An in-app viewer covering **every** released version, not just the newest.
Reachable from Help / About. A link to release notes on a website does not
satisfy this — the changelog is in the app.

Each entry carries its version, its release date, its
[dim sum code name](releases.md) with the bundled photo, and its changes grouped
by category (added, changed, fixed, security, breaking, removed).

## The date filter

An advanced calendar picker — the same control the
[history panel](../version-history/history-panel.md) uses:

- **Month and year jump.**
- **Range selection.**
- **Presets** — last 30 days, last 6 months, this year, all.
- **Typed dates**, accepted in the locale's format *and* as plain ISO
  (`2026-08-02`).
- An invalid or partial entry is **reported inline without discarding what was
  typed**. Typing and the calendar stay in step.

## The search

The changelog text is searchable, with the full
[regex builder](../search-and-regex/regex-builder.md) anchored beside the field.
Plain-text search is the default; regex is an explicit opt-in; query, pattern,
flags, validation and mode synchronize bidirectionally.

**Search and the date filter compose** rather than override one another, and the
empty result is an honest no-match message naming both filters.

## Export and copy

- **Copy** the current selection or the filtered view to the clipboard.
- **Export** to Markdown or plain text.

Both honour the active filter and search, so the export matches what is on
screen, and **the exported file states the range** — a changelog extract with no
stated range is a document nobody can trust later.

## Language and tone

The viewer obeys the three
[language modes](../accessibility-and-languages/language-modes.md) and both
[funny-level sliders](../accessibility-and-languages/funny-levels.md), which
style **every** entry including security fixes and breaking changes.

The same voice-not-facts rule applies: **version numbers, dates and what actually
changed stay exact and unambiguous however playfully they are narrated.** A
breaking change at level 5 is still unmistakably a breaking change.

## Honesty

**Entries are never invented.** No fabricated dates, no imagined fixes to fill a
gap in the list. A version with no recorded changes says exactly that. A
changelog that pads itself is worse than a short one, because it makes every
other entry untrustworthy.

## Failure modes

| Situation | What the user sees | Recoverable |
| --- | --- | --- |
| Partial typed date (`2026-08`) | Reported inline; the typed text stays; no filter applied. | Yes |
| A date range with no releases | Honest no-match naming the range. | n/a |
| Invalid regex | Reported inline, typed text kept, no search run. | Yes |
| No releases yet | The viewer says so plainly and offers the development history where one exists. It does not invent a 1.0. | n/a |
| A version with no recorded changes | Listed with "no recorded changes", not omitted — an omitted version looks like a gap in the record. | n/a |
| A code name with no bundled image | The entry shows the code name without a photo rather than a broken image. | n/a |
| Export with an active filter | The file states the range and the search that produced it. | n/a |
| Very long changelog | Virtualized; counts are exact. | n/a |

## Security considerations

- **Security fixes are styled by the funny level like everything else**, and like
  everything else they keep every fact: what was vulnerable, what was fixed, and
  what a user should do. A joke never replaces the advisory.
- **The changelog is local data**, shipped with the app. Viewing it makes no
  network request and reports nothing about what was read.
- **Export contains only changelog text**, no system or configuration
  information.

## Verification

- The date picker is tested for month/year jump, range selection, every preset,
  locale-format and ISO typed input, and for preserving partial input while
  reporting it.
- Filter composition is tested: date and search must compose, never override.
- Export is tested to match the filtered view exactly and to state its range.
- Every entry is asserted to render in all three language modes at all five funny
  levels with its version, date and category intact.
- The empty and no-releases states are tested to be honest rather than blank.

**No release has been published yet**, so the viewer currently has no released
versions to show. That is the honest state, and the viewer says so rather than
displaying a placeholder.

## Suggested articles

- [Releases](releases.md) — what produces changelog entries.
- [The history panel](../version-history/history-panel.md) — the shared date picker.
- [Funny levels](../accessibility-and-languages/funny-levels.md) — voice, never facts.
- [The regex builder](../search-and-regex/regex-builder.md) — the builder on this search bar.
