# The tab strip

## What it does

A persistent strip of tabs. Every content surface in the application is one, so
navigation replaces scrolling: you go to the queue, you do not scroll to it.

## Behaviour

### Overflow

When tabs exceed the available width they are **never silently clipped**. An
overflow control appears, listing the tabs that do not fit — with their full
names, their group, and their pinned state. The list is searchable
([see tab search](tab-search.md)). Pinned tabs stay visible when ordinary tabs
overflow.

### Reordering

Drag, or move with the keyboard. A tab dragged into a group joins it; dragged
out, it leaves. Order is saved immediately, so a crash does not lose an
arrangement.

### Pinning

Pinning is first-class, not a nicety.

- Pin and unpin from the tab context menu, from a keyboard command, and from the
  searchable tab list.
- Pinned tabs occupy a **stable dedicated region** at the start of the strip and
  can be reordered within it.
- They **remain visible when ordinary tabs overflow**.
- In compact or icon-only form they retain an accessible full name, so a screen
  reader user is not left with "tab, button".
- They are **excluded by default** from close-others, close-to-the-right and
  [text-based bulk closes](bulk-close.md). Including them is an explicit choice
  that previews exactly which protected tabs would close.

### Persistence

`PREF_DEFAULTS.tabs` stores `order`, `pinned`, `groups`, `groupOrder`,
`truncateTitles` and `appearance`. All of it survives a restart.

## Configuration

| Option | Default | Meaning |
| --- | --- | --- |
| `tabs.order` | `[]` | Tab order. |
| `tabs.pinned` | `[]` | Pinned tabs, in their own order. |
| `tabs.truncateTitles` | `true` | Truncate long titles in the strip. |
| `window.sessionTabs` | `true` | Sessions appear as tabs. |
| `window.sessionTabCaptionTruncation` | `true` | Truncate session captions specifically. |
| `window.openedTabsShortcut` | `true` | Keyboard shortcut for the tab list. |

## Failure modes

| Situation | What the user sees | Recoverable |
| --- | --- | --- |
| More tabs than fit | The overflow surface. Tabs are never invisible with no way to reach them. | n/a |
| Very long bilingual titles | Middle truncation keeps both the start and the distinguishing end visible; the full title is the tooltip and the accessible name. Bilingual mode is the worst case and is validated at narrow widths. | n/a |
| More pinned tabs than fit | Pinned tabs get their own overflow rather than pushing ordinary tabs out entirely. | n/a |
| Persisted state references a tab that no longer exists | Skipped on restore; the rest of the arrangement is preserved. | Yes |
| Closing a tab with unsaved work | The tab's own protection applies — an editor with unsaved changes prompts. Bulk operations respect this per tab. | Yes |
| Reordering during a drag that is cancelled | Returns to the original position; nothing is saved mid-drag. | Yes |
| Display scale changed at 200% | Validated: tabs neither clip nor overlap, and the overflow threshold recomputes. | n/a |

## Security considerations

- **Pinned exclusion is a safety property**, not a preference. A bulk close that
  silently took pinned tabs would destroy exactly the sessions a user marked as
  important. Including them is opt-in, previewed and counted.
- **Tab titles can contain hostnames and paths.** In a screen-shared window the
  strip is the most visible surface in the app; `pathInCaption: none` and title
  truncation limit that.
- **Per-site colour tags carry into tabs**, which is the cheapest defence against
  acting on a production session by mistake.

## Verification

- Overflow is tested by narrowing the strip and asserting no tab becomes
  unreachable.
- Pinned visibility under overflow is tested directly.
- Persistence round trips are tested for order, pinned order, groups, group
  order, membership and collapsed state.
- Missing-tab restore is tested by removing an entry between save and restore.
- Keyboard operation — roving focus, `tablist`/`tab`/`tabpanel` roles, live
  `aria-controls` — is tested on the strip.
- Layout is validated at 100/125/150/200% scale and in all three language modes
  with the longest titles.

## Suggested articles

- [Tab groups](tab-groups.md) — organizing a large strip.
- [Tab search](tab-search.md) — finding a tab in the overflow.
- [Bulk close](bulk-close.md) — and the pinned-protection rule.
- [Tab appearance](tab-appearance.md) — restyling individual tabs.
