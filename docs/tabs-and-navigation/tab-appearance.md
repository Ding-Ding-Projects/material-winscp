# Tab and group appearance

## What it does

Tabs and group headers are full appearance targets, with the same depth as any
other element — which is the point of the rule that no element is exempt.

## How it opens

| Route | On a tab | On a group header |
| --- | --- | --- |
| Right-click | The complete tab-management menu, **plus** an **Edit tab appearance…** entry | The group menu, plus **Edit group appearance…** |
| Shift + right-click | Opens the editor directly | Opens the editor directly |
| Keyboard | A named command with a shortcut | The same |

**Normal right-click keeps tab management.** Losing close, pin, duplicate and
move-to-group in exchange for a styling menu would be a bad trade, so the
appearance entry is added rather than substituted. Where the platform cannot
distinguish Shift+right-click, the context-menu entry and the keyboard path
remain mandatory.

The editor is the non-modal anchored popover described in
[the appearance editor](../interface-and-appearance/appearance-editor.md): it
tracks the tab while open, survives the strip scrolling, handles viewport-edge
collision without detaching, and returns focus to the tab on close.

## What can be styled

Every installed font with full Word-depth typography, the
[infinite colour picker and translator](../interface-and-appearance/colour-picker.md)
for every colour, size, shape, corner radius, spacing, icon or emoji, badges,
separators, and each state independently — normal, hover, focus, pressed,
selected, dragged, and for groups, expanded and collapsed.

## Inheritance and persistence

- A tab can inherit from the strip, and a member from its group, **explicitly**.
  The editor shows which values are inherited and which are overridden.
- Settings persist per tab and per group across restarts, in
  `PREF_DEFAULTS.tabs.appearance` and each group's `style`.
- Reset works per property, per tab or group, and globally.
- Everything exports and imports with the rest of the theme, so a customized
  arrangement survives a reinstall and can be shared.

## Failure modes

| Situation | What the user sees | Recoverable |
| --- | --- | --- |
| An override makes a tab unreadable | The live contrast readout warns. Not blocked, never blind. | Yes |
| A tab is closed with the editor open | The editor closes and focus returns somewhere sensible. | n/a |
| An override on a tab that no longer exists | Kept as an orphan and cleaned up on demand, so reopening the same session restores its styling. Dropping it eagerly loses work for no benefit. | Yes |
| A property the platform cannot render | Shown disabled with the reason, and **the saved value is preserved**. | n/a |
| A decoration would replace the accessible name | Not possible. Icons, badges and colours are additive to the name, never a substitute. | n/a |
| Group styling versus member styling | Member overrides win over inherited group values; the editor shows which is in effect. | n/a |
| Import from a newer version | Unknown keys listed and kept, not dropped. | Yes |

## Security considerations

- **A theme cannot hide state.** Pinned, active, unsaved-changes and
  attention-needed indicators survive any styling, and the accessible name and
  state are never replaced by decoration.
- **Contrast is measured and warned about**, because a customization system is
  the easiest way to break accessibility by accident.
- **Theme files are data**, validated against the schema, with no remote
  references and nothing evaluated.
- **Colour is never the only signal** for a tab's state.

## Verification

- Every tab and group type is asserted to expose all three routes: context menu,
  Shift+right-click and keyboard command.
- Normal right-click is asserted to retain the full management menu.
- Anchor tracking is tested against strip scrolling, window resize and edge
  collision.
- Focus return is tested for Escape, click-away and anchor destruction.
- Persistence and export/import round trips are tested, including orphan
  retention.
- Accessible name and state are asserted to survive every decoration, in all
  three language modes.
- Inheritance precedence is tested for group-to-member and strip-to-tab.

## Suggested articles

- [The appearance editor](../interface-and-appearance/appearance-editor.md) — the shared editor and its rules.
- [Tab groups](tab-groups.md) — group headers as targets.
- [The colour picker](../interface-and-appearance/colour-picker.md) — every colour field here.
- [Accessibility](../accessibility-and-languages/accessibility.md) — what styling must never break.
