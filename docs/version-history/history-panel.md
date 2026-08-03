# The history panel

## What it does

Browses the history: every revision, what changed, a diff, and the actions to
label or restore it. It is a tab, so it can be left open beside the work.

**A history nobody can search is an archive nobody opens**, which is why the
filters below are a requirement rather than a refinement.

## The filters

### Date picker

The same advanced calendar control the
[changelog viewer](../packaging-and-updates/changelog.md) uses:

- Anchored calendar with **month and year jump**.
- **Range selection.**
- **Named presets** — today, last 7 days, last 30 days, this month, last month,
  this year, all.
- **Typed dates**, accepted in the locale's format *and* as plain ISO
  (`2026-08-02`).
- An invalid or partial entry is **reported inline without discarding what was
  typed**.
- Typing and the calendar stay in step; neither clears the other.

### Filter by action

The actions are **derived from the history itself**, not a hard-coded list that
drifts from what the app actually records: created, updated, deleted, restored,
undone, imported, settings changed — plus anything else the history contains.

- **Counts beside each action**, so an empty one is visibly empty rather than
  mysteriously absent.
- **More than one action at a time.**
- Composes with the date range and the text search; none of the three overrides
  another.

### Text search

The panel's own search bar, with the full
[regex builder](../search-and-regex/regex-builder.md) anchored beside it,
searching revision labels and the names of changed records. Plain text by
default, regex an explicit opt-in.

### Empty state

An honest no-match message **naming what was filtered out** — "no revisions
between 1 and 7 March with action Deleted matching 'prod'" — not a blank panel.

## What a row shows

Timestamp, action, the label ("Deleted the site Production web"), the records
affected, and an expander with the diff. Diffs of encrypted fields show that the
value changed, never the value.

## Actions

| Action | Notes |
| --- | --- |
| Restore | See [restore](restore.md). Writes a new revision. |
| Label | Attach a note to a revision. Labelling is itself a revision. |
| Compare | Diff any two revisions. |
| Export | The currently visible revisions as a UTF-8 JSON archive, including the active filter statement. |
| Apply retention | Prune revisions using the configured age/count limits. The operation reports how many were kept and removed. |

## Failure modes

| Situation | What the user sees | Recoverable |
| --- | --- | --- |
| Partial typed date (`2026-08`) | Reported inline; the text stays. No search runs against it. | Yes |
| A date outside the retained range | Allowed; results are empty and the panel states the oldest retained revision. | n/a |
| An action with zero matches under the current date range | Shown with a count of 0 rather than removed from the list, so the filter does not appear to change shape. | n/a |
| Thousands of revisions | Virtualized with exact counts. | n/a |
| A very large diff | Collapsed with an expander and a size note. | n/a |
| History disabled for a period | Shown as a labelled gap. | n/a |
| Filters combined to zero results | The honest no-match message naming all three filters. | Yes |
| Purge | Confirmed with the count and the fact that it is irreversible. It is the one operation here that removes data. | **No** |

## Security considerations

- **Diffs never reveal a secret.** Encrypted fields are shown as changed, with no
  value on either side.
- **Export contains the selected revisions**, including protected secrets in
  encrypted form. The dialog says so and records the visible filter statement.
- **Retention pruning is irreversible for the removed revisions**, so it is
  confirmed, counted, and clearly labelled as such.
- **Restoring a security-relevant setting is highlighted** in the preview rather
  than buried among cosmetic changes.
- **The panel is read-only against the repository** — it never rewrites history,
  and there is no path in the UI that could.

## Verification

- The date picker is tested for month/year jump, range selection, every preset,
  locale-format and ISO typed input, and for preserving partial input while
  reporting it.
- Action derivation is tested by seeding a history with each action type and
  asserting the filter list and counts match exactly — including zero-count
  actions remaining visible.
- Filter composition is tested for all combinations of date, action and text,
  asserting none overrides another.
- The empty state is asserted to name every active filter.
- The search field is covered by the shared search-surface tests.
- Secret redaction in diffs is asserted by scanning rendered output for known
  plaintext.
- Virtualization is tested with a synthetic 50,000-revision history.

## Suggested articles

- [Snapshots](snapshots.md) — what produces these rows.
- [Restore](restore.md) — the panel's most important action.
- [The changelog viewer](../packaging-and-updates/changelog.md) — the shared date picker.
- [The regex builder](../search-and-regex/regex-builder.md) — the builder on this search bar.
