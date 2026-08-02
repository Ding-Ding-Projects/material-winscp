# Tab groups

## What it does

Groups collect related tabs behind a named, coloured header that can be
collapsed. Four production sessions and their consoles become one "Production"
group that folds away when you are not using it.

## Behaviour

| Operation | Notes |
| --- | --- |
| Create | From selected tabs, or empty and populated later. |
| Name and rename | Names are the accessible label; they are never replaced by a colour or an icon. |
| Colour and icon | Chosen with the [infinite colour picker](../interface-and-appearance/colour-picker.md); the icon may be an emoji. |
| Reorder | Groups reorder among themselves; tabs reorder within a group. |
| Collapse and expand | Collapsed state persists. |
| Move tabs | Drag or keyboard, into, out of and between groups. |
| Pin a group | Where the layout supports it, a whole group pins; individual members can also pin. |
| Remove | Removing a group does not close its tabs — they return to the ungrouped strip. Deleting tabs and dissolving a group are different actions. |

An empty group is kept only if the user deliberately chose to keep it.
Otherwise removing the last tab removes the group, so the strip does not fill
with empty headers.

## Appearance

Group headers are full appearance targets. Right-click includes **Edit group
appearance…**; Shift+right-click opens the editor directly. Editable: all
installed-font typography, text and highlight colours, icon or emoji, badges,
foreground and background treatments, borders, shape, corner radius, spacing,
separators, and the expanded, collapsed, hover and focus states independently.

Decorations persist per group, reset per property or per group, and export with
the rest of the theme. **They never replace the accessible name or state**, and
the editor maintains the required contrast readout.

## Search

Two distinct searches, per the requirement:

- **Within a group** — each group has its own tab search field, scoped to its
  members, with its own anchored [regex builder](../search-and-regex/regex-builder.md).
- **Across groups** — the group-management surface has a separate search over
  group names and labels, with its own builder.

Neither shares state with the other, or with the strip search. See
[tab search](tab-search.md).

## Configuration

`PREF_DEFAULTS.tabs.groups` holds
`{id, name, color, collapsed, icon, members[], style{}}`, with `groupOrder`
recording their order. All of it persists across restarts.

## Failure modes

| Situation | What the user sees | Recoverable |
| --- | --- | --- |
| A search result is inside a collapsed group | Revealed **without destroying the collapsed preference** — the group re-collapses afterwards. A search must not silently rearrange the workspace. | n/a |
| Two groups with the same name | Allowed; they are distinguished by id, and the management surface shows enough context to tell them apart. | n/a |
| A group's last tab is closed | Group removed, unless it was deliberately kept. | Yes |
| A bulk operation spans groups | The preview states its scope — current group, selected groups, or all — and never crosses a boundary silently. | Yes |
| Persisted membership references a missing tab | Skipped; the group survives with its remaining members. | Yes |
| A collapsed group with a session needing attention | The header shows a badge and the notification still appears. Collapsing never hides an event. | n/a |
| Colour-only distinction | Groups always carry a name; colour is additional. High-contrast mode and colour-vision deficiency are both covered by that. | n/a |

## Security considerations

- **A collapsed group must not hide a prompt.** A host key change or an
  authentication prompt in a collapsed group surfaces as a badge and a
  notification. Hiding a security decision behind a fold would be a serious bug.
- **Group names can carry environment information** — "Production" is meaningful
  to a shoulder-surfer as well as to you.
- **Scope statements on bulk operations are a safety property.** "Close all tabs
  in this group" and "close all tabs" differ by a great deal, and the preview and
  count say which is about to happen.

## Verification

- Create, rename, colour, reorder, collapse, move-between and remove are tested
  for state and for persistence across a restart.
- Reveal-in-collapsed-group is tested to assert the collapsed preference is
  restored afterwards.
- The two searches are tested for independence — neither may affect the other's
  query, flags or mode.
- Group appearance round-trips through export and import.
- Accessible name and state are asserted to survive every decoration.
- Bulk-operation scope statements are tested for each of the three scopes.

## Suggested articles

- [The tab strip](tab-strip.md) — the surface groups live in.
- [Tab search](tab-search.md) — all four searches, and why they are separate.
- [Tab appearance](tab-appearance.md) — the per-element editor for headers and tabs.
- [Workspaces](../sessions-and-sites/workspaces.md) — restoring a whole group structure.
