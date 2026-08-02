# The four tab-discovery searches

## What they are

Four distinct searches. Each has its own anchored full
[regex builder](../search-and-regex/regex-builder.md), and **none of them shares
hidden state with another**. That last point is the requirement that makes them
four features rather than one used four ways: a search that quietly applies the
pattern you last typed somewhere else is worse than no search.

| # | Search | Scope |
| --- | --- | --- |
| 1 | **Current strip** | Tabs in the strip you are looking at. |
| 2 | **Within a group** | One group's members. Every group has its own field. |
| 3 | **Groups by name** | Group names and labels, in the group-management surface. |
| 4 | **Master search** | Every open tab across every window, workspace, strip and group the app owns. |

## Behaviour common to all four

- **Plain text is the default.** Regex is an explicit opt-in per field.
- **Query, pattern, flags, validation and mode synchronize bidirectionally**
  with that field's builder — edit the raw pattern and the builder follows, and
  the reverse.
- **Results identify their context**: window or workspace, strip, group, pinned
  state and the visible tab label. A result you cannot locate is not a result.
- **Keyboard activation** with an accessible return path: activating a result
  moves focus to that tab; Escape returns focus to the field.
- **Revealing a result inside a collapsed group does not destroy the collapsed
  preference** — the group re-collapses after.
- **The permitted tab-management actions are available from results** — pin,
  unpin, move to group, close — **without losing the active query**.
- **The empty state is an honest no-match message** naming what was searched and
  what was filtered out. Never a blank panel.

## What is searched

The tab's **visible label or title**. Not page contents, not hidden data, not
the remote directory listing behind the tab. A tab search that silently searched
a session's file listings would be both surprising and slow.

For results, the context fields (group name, workspace name) are also matched
where the search's scope includes them — the master search matches on context so
"production" finds tabs in the Production group.

## Failure modes

| Situation | What the user sees | Recoverable |
| --- | --- | --- |
| Invalid regex | Reported inline with the position. **What was typed is kept.** No search runs against a broken pattern. | Yes |
| Empty query | No filtering; the full list. Not an error. | n/a |
| Pattern matching nothing | The honest no-match message naming the scope. | n/a |
| A very large tab count in the master search | Matching is bounded and incremental; the field stays responsive. | n/a |
| Catastrophic backtracking pattern | Evaluation is time-bounded, aborted and reported as too expensive — with the pattern preserved so it can be fixed. | Yes |
| Result activated after its tab closed | Reported as gone and removed from the results, not silently failing. | n/a |
| Two searches open at once | Independent. Verified by test, because shared state is the natural way to implement this and the wrong way. | n/a |
| Screen reader on the results list | Result count is announced on change; each result's context is part of its accessible name. | n/a |

## Security considerations

- **Evaluation is local and bounded.** Patterns and sample text are never
  transmitted or persisted beyond the field's own session state. Pattern length
  and evaluation time are capped, which is the defence against regex denial of
  service.
- **Tab labels can contain hostnames and paths.** A search *result list* can
  therefore expose more at a glance than the strip does; it is a local UI surface
  and is not logged.
- **Actions from results are re-validated when invoked**, so a stale result
  cannot close the wrong tab after the arrangement changed.
- **No search reaches into a session's data.** The scope is labels, and that is a
  privacy property as much as a performance one.

## Verification

- Each of the four searches is tested for scope: results from outside its scope
  must not appear.
- **Independence is tested explicitly** — setting a pattern, flags or mode in one
  field must leave the other three untouched.
- Bidirectional synchronization with the builder is tested in both directions.
- Result context (window, strip, group, pinned state) is asserted present.
- Reveal-in-collapsed-group is tested to restore the collapsed state.
- Actions from results are tested for preserving the active query.
- Invalid, partial, Unicode, multiline, zero-width and adversarial patterns are
  tested against the real engine, along with the time bound.
- Keyboard activation and Escape-returns-focus are tested.

## Suggested articles

- [The regex builder](../search-and-regex/regex-builder.md) — the builder anchored to all four.
- [Tab groups](tab-groups.md) — searches 2 and 3 live here.
- [Bulk close](bulk-close.md) — which uses the same match predicate.
- [The tab strip](tab-strip.md) — overflow, where search matters most.
