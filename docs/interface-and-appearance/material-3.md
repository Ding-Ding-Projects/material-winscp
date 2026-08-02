# Material Design 3

## What it does

Every surface uses M3 tokens rather than hard-coded values. A colour in the UI
is `--md-sys-color-surface-container-high`, not `#eef0f4`; a corner is
`--md-sys-shape-corner-large`, not `16px`. That is what makes runtime theming,
density and accent changes possible at all — a hard-coded value cannot be
re-themed.

## Configuration

Under **Preferences → Interface → Appearance**, stored in `PREF_DEFAULTS.theme`.

| Option | Default | Meaning |
| --- | --- | --- |
| `mode` | `light` | `light`, `dark`, `system`. |
| `seed` | `#0B57D0` | Seed colour. The full tonal palette is generated from it. |
| `density` | `0` | Material density scale, `0` to `-3`. Each step tightens component heights. |
| `uiScale` | `1` | Overall scale, independent of the OS display scale. |
| `fontFamily` | `Roboto` | UI font, chosen from installed plus bundled faces. |
| `fontSize` | `14` | Base size; the type scale is derived from it. |
| `fontWeight` | `400` | |
| `reduceMotion` | `false` | Honours the OS setting by default and can be forced on. |
| `perElement` | `{}` | Per-element overrides — see [the appearance editor](appearance-editor.md). |
| `presets` | `[]` | Named saved themes, exportable and importable. |

Every change applies to the **live UI**, not after a restart, and a preview
shows the effect before it is committed.

## The token system

| Token group | Examples |
| --- | --- |
| Colour | `primary`, `on-primary`, `primary-container`, `surface`, `surface-container-*`, `outline`, `error` |
| Typography | `display-*`, `headline-*`, `title-*`, `body-*`, `label-*` |
| Shape | `corner-none` … `corner-full` |
| Elevation | levels 0–5, as shadow plus surface tint |
| Motion | standard, emphasized and decelerate easing with matching durations |
| State | hover, focus, pressed and dragged layer opacities |

The palette is generated from `seed` at every tone step, so a custom accent
produces a complete, contrast-correct scheme rather than one recoloured button.

## CJK-safe font fallback

Bilingual mode means Latin and Traditional Chinese appear in the same label. A
font chain without a CJK fallback renders Chinese as boxes, so:

- Every font selection carries an explicit CJK fallback chain.
- The font picker renders each family's name **in its own face**, and marks
  which families cover CJK.
- Choosing a Latin-only font is allowed and warns that Chinese text will fall
  back — it does not silently substitute a different family.

## Failure modes

| Situation | What the user sees | Recoverable |
| --- | --- | --- |
| A seed colour producing poor contrast | The palette generator maintains contrast at every tone step, and the preview shows the measured ratio for key pairs. A seed that cannot work is reported, not silently adjusted. | Yes |
| `density: -3` with the longest bilingual strings | The tightest density with the longest labels is the worst case for clipping. Layouts are validated there specifically. | Yes |
| `uiScale` combined with a 200% OS scale | Compounds. The preview shows the effective size, and validation covers 100/125/150/200%. | Yes |
| A selected font is uninstalled | Falls back through the chain and says which font is actually in use, rather than silently rendering something else. | Yes |
| `mode: system` with the OS theme changing mid-session | Applied live. In-flight animations are not interrupted mid-way. | n/a |
| `reduceMotion` | Transitions become instant, not merely faster. A shortened animation still moves. | n/a |

## Security considerations

- Theming is presentation, with two exceptions worth naming:
  - **Contrast is an accessibility requirement, and a customization system can
    destroy it.** The editor measures and warns; it never silently clamps a
    user's choice, but it never lets them make one blind either.
  - **Colour must never be the only signal.** Destructive actions, error states
    and per-site danger tags carry an icon or a label as well, so a custom theme
    or a colour-vision deficiency cannot hide a warning.
- Imported theme presets are data, not code. They are validated against the token
  schema, and an unknown key is reported rather than applied.

## Verification

- Palette generation is tested against reference tonal values for several seeds.
- Contrast ratios for every foreground/background token pair are asserted at both
  modes, for the default seed and a sample of extreme ones.
- Layout is validated at 100/125/150/200% scale, at every density step, in all
  three language modes, with the longest string in each dictionary key.
- Live application is tested by changing each option and asserting the rendered
  computed style changes without a reload.
- Font fallback is tested by selecting a Latin-only family and asserting CJK text
  still renders and the warning appears.

## Suggested articles

- [The appearance editor](appearance-editor.md) — per-element overrides on top of this.
- [The colour picker](colour-picker.md) — how a seed or an override colour is chosen.
- [Accessibility](../accessibility-and-languages/accessibility.md) — the contrast and motion rules.
- [Language modes](../accessibility-and-languages/language-modes.md) — why CJK fallback is mandatory.
