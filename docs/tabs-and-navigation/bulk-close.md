# Bulk close: containing / not containing text

## What it does

Two actions on every tab strip and every searchable tab list:

- **Close tabs containing text**
- **Close tabs not containing text**

The user enters text; tabs whose **visible label or title** matches are closed —
or, for the inverse, those that do not. Page contents and hidden data are never
inspected.

## The predicate is shared, deliberately

The inverse action negates **the exact same match predicate**. Flags, casing,
Unicode handling and scope cannot drift between the two, because there is only
one predicate and one negation of it. Two separately implemented matchers would
diverge, and the day they diverge is the day someone closes the wrong forty tabs.

Plain-text matching is the default. An adjacent affordance opens the full
anchored [regex builder](../search-and-regex/regex-builder.md) and applies its
synchronized pattern, flags, validation and mode to that same action. Regex use
is optional for the user; **builder availability is mandatory for both actions**.

## The safety rules

1. **Never runs on an empty query or an invalid pattern.** Both are refused with
   a reason. An empty query would close everything, or nothing, depending on
   which action — neither is a thing anyone meant.
2. **A reviewable preview before anything closes**, showing the match mode
   (plain or regex, with the flags), the affected-tab count, and the list itself.
3. **Pinned tabs are excluded by default.** Including them is an explicit choice
   that previews the protected tabs first.
4. **Each tab's existing unsaved-work protection still applies.** A tab with
   unsaved changes prompts, or is excluded and reported — never closed silently
   because it was part of a batch.
5. **Scope is stated.** Current group, selected groups, or all groups — never a
   silent crossing of a group boundary.
6. **Blocking confirmation only when a decision is genuinely required**, which
   for a destructive bulk action it is.
7. **Excluded and failed tabs are reported, not pretended closed.** The result
   says how many closed, how many were protected, and how many failed with why.

## Configuration

No persistent settings. The action's mode, pattern and flags belong to the
invocation, not to a stored preference — so a regex used once does not become an
invisible default next time.

## Failure modes

| Situation | What the user sees | Recoverable |
| --- | --- | --- |
| Empty query | Refused with a reason. Nothing closes. | n/a |
| Invalid regex | Refused, position reported, typed text kept. | Yes |
| Query matching every tab | Allowed — sometimes intended. The preview count makes it obvious first. | Yes |
| Query matching nothing | "0 tabs match"; nothing to confirm. | n/a |
| A tab with unsaved work in the set | Prompted individually, or excluded and reported. | Yes |
| A tab refuses to close (a transfer mid-flight) | Reported as not closed with the reason. | Yes |
| Pinned tabs would match | Excluded, with a count so the exclusion is visible. Including them previews them separately. | n/a |
| Case expectations | Plain-text matching is case-insensitive by default; the flag is shown in the preview and toggleable in the builder. | n/a |
| Unicode normalization differences | Matching normalizes both sides, so a composed and a decomposed accented label match. Tested. | n/a |
| Catastrophic backtracking pattern | Time-bounded, aborted, reported. Nothing closes. | Yes |

## Security considerations

- **This is a destructive bulk action driven by a pattern**, which makes the
  preview the actual safety mechanism rather than a nicety. It is not skippable.
- **Pinned protection is the second mechanism**, and the reason pinning is worth
  doing at all for important sessions.
- **Only labels are inspected.** Matching against session contents would be a
  privacy surprise and would make the action unpredictably slow.
- **Evaluation is local and bounded**, exactly as for the tab searches.
- **The result is honest.** Reporting "48 tabs closed" when 6 were protected and
  2 failed would leave a user believing their workspace is in a state it is not.

## Verification

- The inverse action is tested to be an exact negation of the forward one over a
  corpus of labels, in both plain and regex modes, with every flag combination.
- Empty-query and invalid-pattern refusal are tested for both actions.
- Preview counts are asserted to equal the number actually closed, in the absence
  of protections.
- Pinned exclusion is tested by default and with explicit inclusion.
- Unsaved-work protection is tested with a tab that prompts and one that refuses.
- Scope statements are tested for current group, selected groups and all groups.
- Unicode normalization and case-flag behaviour are tested directly.
- Localization of every control and message is tested in all three language modes.

## Suggested articles

- [Tab search](tab-search.md) — the same predicate, without the destruction.
- [The tab strip](tab-strip.md) — pinning, and why it protects.
- [The regex builder](../search-and-regex/regex-builder.md) — the builder both actions must offer.
- [Notifications](../interface-and-appearance/notifications.md) — how the honest result is reported.
