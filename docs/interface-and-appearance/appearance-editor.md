# The appearance editor

## What it does

Lets the user restyle **any rendered element** — a toolbar button, a column
header, a tab, a group header, a menu item, a dialog, a notification, and the
appearance editor's own chrome. No element is exempt.

## How it opens

| Route | Behaviour |
| --- | --- |
| Right-click → **Edit appearance…** | On every element. On a tab, the entry is **Edit tab appearance…** and the rest of the tab-management menu is untouched. On a group header, **Edit group appearance…**. |
| **Shift + right-click** | Opens the editor directly, skipping the menu. |
| Keyboard | A named command with a shortcut, reachable without a pointer. The keyboard path is mandatory, not a convenience. |

The editor is a **non-modal anchored popover** beside the element being edited.
It tracks its anchor while open, handles viewport-edge collision without
detaching, and returns focus to the originating element on close.

## What can be edited

### Typography — to a word-processor standard

Family (searchable, every installed and bundled face previewed in its own
typeface, with CJK coverage marked), size (stepped and free entry), variable-font
axes where the face exposes them, weight, bold, italic and oblique, underline
style and colour, single and double strikethrough, overline, capitalization and
small caps, superscript and subscript, text colour, highlight, outline, shadow,
glow where supported, character spacing, word spacing, line height, baseline
offset, text direction and alignment.

### Everything else

Foreground and background (solid or gradient), border colour, width and style,
corner radius per corner, padding and margin, icon or emoji, badges, elevation,
and the hover, focus, pressed, selected, disabled and dragged states — each
independently.

### Unsupported properties stay visible

A property the platform cannot honour is shown **disabled with an explanation**,
not hidden. A saved value for it is preserved, not dropped: if the platform gains
support, or the theme moves to a machine that has it, the value is still there.
**Never let a customization surface silently discard a value it cannot
represent.**

## Configuration

| Where | What |
| --- | --- |
| `theme.perElement` | Element key → overrides. |
| `theme.presets` | Named saved themes. |
| Export / import | A theme file, so a customized appearance survives a reinstall and can be shared. |
| Reset | Per property, per element, and globally. Each is a separate control. |
| Inheritance | An element can inherit from its parent explicitly; the editor shows which values are inherited and which are overridden. |

The editor has its **own search bar** with the
[regex builder](../search-and-regex/regex-builder.md), searching property names,
descriptions and current values — the same rule that applies to every settings
surface.

## Failure modes

| Situation | What the user sees | Recoverable |
| --- | --- | --- |
| An override destroys contrast | The measured ratio is shown live with a warning. The choice is not blocked — but it is not made blindly either. | Yes |
| A preset from a newer version with unknown keys | Applied where understood, unknown keys listed and **kept**, not dropped. | Yes |
| A preset with an invalid value | That property is rejected with a named reason; the rest applies. | Yes |
| The anchor element scrolls away | The popover follows, or closes cleanly at the edge. It never floats detached over unrelated content. | n/a |
| The anchor is destroyed (its tab closes) | The editor closes and focus returns somewhere sensible, not to nothing. | n/a |
| Overrides on hundreds of elements | Stored as a flat map and applied as CSS custom properties on the elements concerned; cost is proportional to overrides, not to elements. | n/a |
| Global reset | Confirmed, counting the overrides and presets affected. Presets are not deleted by a global reset — they are named saves, and destroying them would be a surprise. | Yes |

## Security considerations

- **A theme file is data, and is validated as data.** It is parsed against the
  token schema; no value from it is evaluated, and no font, image or style is
  fetched from a URL.
- **Imported themes cannot reference remote resources.** Everything is local, so
  a shared theme cannot be used to phone home.
- **Contrast and non-colour signalling are protected.** An override cannot remove
  the icon or label that distinguishes a destructive action; only its styling.
- **Preserving a value the platform cannot render** is a data-integrity property:
  discarding it loses user work silently, which is the worst kind of loss.

## Verification

- Every element type is asserted to expose the context-menu entry, the
  Shift+right-click route and the keyboard command.
- Anchor tracking is tested for scroll, resize and viewport-edge collision.
- Focus return is tested for close by Escape, by click-away and by anchor
  destruction.
- Round-tripping a preset through export and import is tested for fidelity,
  including unknown-key preservation.
- Per-property, per-element and global reset are tested to affect exactly their
  scope and nothing else.
- The editor's own surface is asserted to be themeable by the same system — a
  theming feature that cannot theme its own dialog is incomplete.
- Contrast measurement is tested against known pairs.

## Suggested articles

- [The colour picker](colour-picker.md) — the control behind every colour field here.
- [Material Design 3](material-3.md) — the tokens an override sits on top of.
- [Tabs and navigation](../tabs-and-navigation/tab-appearance.md) — tabs and groups as appearance targets.
- [Accessibility](../accessibility-and-languages/accessibility.md) — the guarantees an override must not break.
