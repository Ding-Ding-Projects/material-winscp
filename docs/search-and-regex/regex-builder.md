# The regex builder

## What it does

A guided pattern builder plus a raw editor, with live matching against sample
text. It is not a link to an external regex site and not a reduced "regex on/off"
toggle — it is a full construction surface, and it is available from every search
bar in the application.

## Where it appears

**Anchored directly beside its search bar.** The affordance is a button in or
next to the field, opening an anchored popover or inline panel that stays
visually attached to that specific field. It is not a separate page, not a global
dialog detached from the field, and not another tab.

A modal or full-screen builder is a fallback for genuinely constrained widths
only — and even then, closing it returns focus to the originating field.

**When several search bars share a surface, each gets its own builder**, bound to
that field's query, pattern, flags and mode. There is never one shared builder
that silently applies to whichever field was touched last.

## Guided construction

| Element | Offered as |
| --- | --- |
| Literals | Text, with automatic escaping of metacharacters |
| Character classes | Presets (digit, word, whitespace, any) and custom sets and ranges, with negation |
| Anchors | Start, end, word boundary, non-boundary |
| Groups | Capturing, non-capturing, named, lookahead and lookbehind |
| Alternation | Two or more branches |
| Quantifiers | `?`, `*`, `+`, `{n}`, `{n,}`, `{n,m}`, each with a greedy/lazy choice |
| Backreferences | To numbered and named groups |

Each added element appears in a list that can be reordered, edited and removed —
and the raw pattern updates as it changes. Editing the raw pattern updates the
element list where the pattern can be represented; where it cannot, the builder
says so and keeps the raw pattern authoritative rather than rewriting what the
user typed.

## The engine, stated plainly

| Property | Value |
| --- | --- |
| Engine | **ECMAScript regular expressions (JavaScript `RegExp`)**, as implemented by the V8 engine inside Electron |
| Flags | `g` global, `i` ignore case, `m` multiline, `s` dot-all, `u` unicode, `y` sticky |
| Escaping | Backslash escaping; `\d \w \s \b` and their negations; `\p{...}` Unicode property escapes require the `u` flag |
| Not supported | Possessive quantifiers, atomic groups, recursion, conditionals — these are PCRE features and are absent here. The builder does not offer them, so a pattern built here always runs. |

This is stated in the builder's own UI, not only in this document, because a
pattern written for PCRE and pasted here is the most common source of confusion.

## Live feedback

- **Sample text** — editable, and pre-filled from the search's own domain (the
  visible tab labels, the current directory listing, the settings labels on the
  surface).
- **Live matches**, highlighted in the sample, with a count.
- **Capture groups** listed per match, by number and by name.
- **Syntax feedback** inline, with the position of the problem.
- **Copy and export** the pattern, with or without delimiters and flags.

## Failure modes

| Situation | What the user sees | Recoverable |
| --- | --- | --- |
| Invalid pattern | The engine's message plus the position, inline. **What was typed is kept.** The search does not run. | Yes |
| Partial pattern while typing | Treated as incomplete, not invalid. No error flashing on every keystroke. | n/a |
| Zero-width match (`(?:)`, `\b`) | Handled safely: the matcher advances, so a global search cannot loop forever. Zero-width matches are shown as position markers. | n/a |
| Catastrophic backtracking (`(a+)+$`) | Evaluation is **time-bounded**. It aborts and reports the pattern as too expensive, keeping it so it can be fixed. | Yes |
| Very large sample text | Bounded; the excess is not evaluated and the bound is stated. | n/a |
| Very long pattern | Bounded, with the limit stated. | n/a |
| `\p{...}` without the `u` flag | The engine's own error. The builder offers to add the flag. | Yes |
| A PCRE-only construct pasted in | The engine rejects it; the message names it as unsupported here rather than showing a raw syntax error. | Yes |
| Pattern producing no matches | An honest "no matches" with the flags in effect, so a missing `i` is visible. | n/a |
| Sticky search reused across fields | The `y` flag starts at index zero for each field; a previous field's match cannot leak its `lastIndex` into the next one. | n/a |

## Security considerations

- **Evaluation is local.** Patterns and sample text are never transmitted and
  never persisted beyond the field's own state. Nothing is sent anywhere for
  "explanation" or completion.
- **Regex denial of service is the real risk here**, and it is handled by
  bounding evaluation time, pattern length and sample size rather than by
  attempting to detect dangerous patterns statically — which cannot be done
  reliably.
- **Escaping in guided mode is automatic**, so a literal typed into the builder
  cannot accidentally become a metacharacter.
- **Patterns from an imported preset are data**, not code, and are validated
  before use.
- **Plain text remains the default everywhere.** A user who never opens the
  builder is never exposed to regex semantics, and a search that silently
  interpreted `.` as "any character" would be a bug.

## Verification

- Guided-to-raw and raw-to-guided synchronization is tested in both directions,
  including patterns the builder cannot represent.
- Valid, invalid, no-match, Unicode, multiline, zero-width, capture-group and
  adversarial patterns are all tested against the real engine.
- The time bound is tested with known catastrophic patterns.
- Plain-text-versus-regex behaviour is tested per surface: the same query string
  must produce different results in the two modes, and the mode must never change
  by itself.
- **The builder is exercised from every search surface** listed in
  [search surfaces](search-surfaces.md), not only from one.
- Anchoring, edge collision and focus return are tested.
- Localization of every builder control is tested in all three language modes.

## Suggested articles

- [Search surfaces](search-surfaces.md) — every field this is attached to.
- [File masks](../editing-and-commands/file-masks.md) — the simpler language, and its conversion to regex.
- [File search](file-search.md) — the largest consumer of built patterns.
- [Tab search](../tabs-and-navigation/tab-search.md) — four independent builders on one surface.
