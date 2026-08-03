# Search surfaces

## What this is

The complete list of search bars in the application. Every one of them has its
own anchored [regex builder](regex-builder.md), keeps plain text as the default,
and never shares state with another field.

## Collection searches

| Surface | Searches |
| --- | --- |
| Site manager | Site names, hosts, usernames, folders, notes |
| Workspace list | Workspace names and their member sites |
| Panel filter (one per panel) | Entries in the current directory |
| File search results | Names and paths of found files |
| Queue | Queued item source and target paths |
| Comparison checklist | Row names and the reason for each row |
| Notification centre | Notification titles and bodies |
| Version history panel | Revision labels and changed record names |
| Changelog viewer | Every released version's entry text |
| Console scrollback | Command and output text |
| Internal editor find bar | Document text (also accepts a file mask) |
| Custom command list | Descriptions and command patterns |
| Extension list | Names, descriptions and declared requirements |
| Transfer preset list | Preset names and their auto-select masks |
| Font picker | Font family names |
| Tab strip | Tabs in the current strip |
| Within each group | That group's members |
| Group management | Group names and labels |
| Master tab search | Every tab in every window, workspace, strip and group |

## Settings searches — the part usually missed

> Every settings, preferences, properties or adjustment surface carries its own
> search bar wired to the same builder.

No surface is exempt for being small, nested or "obviously scannable". A user who
knows a setting's name should be able to type it anywhere settings live and land
on it.

| Surface | Searches |
| --- | --- |
| Preferences (global) | Option labels, descriptions and **current values**, across every tab |
| Each Preferences tab | The same, scoped to that tab |
| Site → Advanced, and every page within it | Per-site option labels, descriptions and values |
| File properties / permissions | Field labels and values |
| The appearance editor | Property names, descriptions and current values |
| Theme preset manager | Preset names and their contents |
| Colour picker palettes | Saved palette and swatch names |
| Transfer settings dialog | Option labels and values |
| Logging settings | Option labels and values |
| Session information | Reported capabilities and server strings |

**A match on a different tab is stated, not hidden.** Searching the Interface tab
for "cipher" reports that the match is under Site → Advanced → SSH and offers to
navigate there — landing the user on an empty result while the setting exists two
tabs away is the failure this rule exists to prevent.

## Common behaviour

- Plain text by default; regex an explicit opt-in.
- Query, pattern, flags, validation and mode synchronize bidirectionally with
  that field's builder.
- Progressive disclosure at constrained widths — the builder collapses to a
  button, never disappears.
- An honest no-match message naming what was searched.
- Full keyboard operation with visible focus, an accessible name for the field,
  and a result count announced to assistive technology.
- The search landmark, regex affordance, mode hint and no-match message follow
  the active language mode and both funny-level sliders; switching language
  while a builder is open updates its copy without discarding the pattern.
- Results identify enough context to act on them.
- All three language modes, with the builder's own controls localized.

## Failure modes

| Situation | What the user sees | Recoverable |
| --- | --- | --- |
| A settings match on another tab | Reported with its location and a navigation action. | n/a |
| Two search fields on one surface | Fully independent. Tested. | n/a |
| A very narrow window | The builder collapses to an affordance; it is never removed. | n/a |
| Searching current *values* | Supported — "8080" finds the port field. Values that are secrets are **not** searchable and not displayed. | n/a |
| Invalid pattern | Reported inline, typed text kept, no search run. | Yes |
| A surface with thousands of options | Matching is incremental and bounded. | n/a |

## Security considerations

- **Secret values are never searchable and never rendered.** Searching settings
  matches labels, descriptions and non-secret values; a stored password is
  excluded from both the index and the display, because a searchable secret is a
  disclosed secret.
- **Evaluation is local and bounded** on every surface — patterns and sample text
  are not transmitted or persisted.
- **Search does not rearrange the workspace.** Revealing a result inside a
  collapsed group or a folded settings section restores that state afterwards.

## Verification

- Every surface in the tables above is asserted to expose a search field with an
  anchored builder — the list is the test fixture, so adding a surface without a
  search bar fails the suite.
- Independence is tested for every surface carrying more than one field.
- Settings search is tested to match labels, descriptions and values, to exclude
  secrets, and to report cross-tab matches with a working navigation action.
- Plain-text default and explicit regex opt-in are tested per surface.
- Keyboard operation and accessible naming are tested per surface.

## Suggested articles

- [The regex builder](regex-builder.md) — what every one of these is wired to.
- [File search](file-search.md) — the most demanding consumer.
- [Tab search](../tabs-and-navigation/tab-search.md) — the four independent tab searches.
- [The appearance editor](../interface-and-appearance/appearance-editor.md) — a settings surface with its own search.
