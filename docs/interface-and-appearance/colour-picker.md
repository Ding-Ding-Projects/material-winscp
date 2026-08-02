# The infinite colour picker and colour translator

## What it does

Every colour control in the application is the same picker: a **continuous**
spectrum, never a fixed swatch grid. Swatches, recent colours, eyedroppers and
palettes exist — layered on top of the continuous field as conveniences, not as
replacements for it.

Beside the picker is a **translator** that converts the current colour between
formats, both ways.

## The picker

| Part | Behaviour |
| --- | --- |
| Two-dimensional field | Saturation × lightness, with a separate hue control. Continuous, keyboard-operable with arrow keys and larger steps with modifiers. |
| Alpha | A separate channel with a checkerboard preview, preserved through every conversion. |
| Numeric entry | Direct entry in any supported format. Typing and the field stay in step; neither clears the other. |
| Swatches | Theme palette, recent colours, and user-saved palettes. |
| Eyedropper | Samples from anywhere in the app's own window. |
| Contrast readout | Live ratio against the relevant foreground or background, with the WCAG level met. |

## The translator

Converts bidirectionally among: named CSS colours (when the value has one),
HEX and HEX8, RGB and RGBA, HSL and HSLA, HSV/HSB, HWB, CIELAB and LCH, OKLab
and OKLCH, and CMYK.

- **Alpha is preserved** across every conversion that can carry it, and the
  formats that cannot are marked so the loss is visible rather than silent.
- **The active colour space and gamut are identified**, so it is clear whether a
  value is sRGB or wider.
- **Clipping is warned about before it happens.** An OKLCH colour outside sRGB is
  flagged with what it will become, rather than being quietly clamped.
- **Any representation can be copied** with one action.

## Configuration

The picker has no settings of its own — it is a control. What it edits is
everything: theme seed, per-element overrides, tab and group colours, site colour
tags, and file colouring rules.

The picker's **own dialog is themeable** through the same
[appearance editor](appearance-editor.md), which is the test of whether a
theming system is real.

## Failure modes

| Situation | What the user sees | Recoverable |
| --- | --- | --- |
| Invalid text typed into numeric entry | Reported inline with the position. **What was typed is kept**, not cleared — clearing a partly-typed value is the most infuriating possible behaviour in a colour field. | Yes |
| Partial input (`#3f`) | Treated as incomplete, not invalid. No error until it is committed. | Yes |
| A colour outside sRGB | Warned with the clipped result shown beside the requested one. | Yes |
| CMYK conversion | Device-dependent without a colour profile. The translator says so rather than implying a precise printing result. | n/a |
| Poor contrast chosen | The readout shows the failing ratio and level. Not blocked — some colours are decorative — but never invisible. | Yes |
| Eyedropper outside the app window | Not supported; the control says so instead of returning a wrong colour. | n/a |
| Very fast dragging in the field | Updates are throttled to a frame; the value is exact on release. | n/a |

## Security considerations

- The picker is presentation, with the same two caveats as everywhere else:
  **contrast can be destroyed by a customization system**, and **colour must
  never be the only signal** for a destructive or error state.
- Saved palettes are local data with no remote reference, validated on import.
- The eyedropper is deliberately scoped to the app's own window. Sampling
  arbitrary screen pixels is a screen-capture capability, and a colour picker is
  not a good reason to ask for one.

## Verification

- Conversion is tested for round-trip accuracy across all supported formats,
  including alpha preservation and the formats that drop it.
- Conversions are checked against reference values for CIELAB, LCH, OKLab and
  OKLCH, because these are easy to implement subtly wrongly.
- Gamut detection and clip warning are tested with out-of-sRGB inputs.
- Invalid and partial input are tested to assert the typed text survives.
- Keyboard operation of the two-dimensional field is tested for reachability,
  step size and announced values.
- Contrast computation is tested against known WCAG pairs.

## Suggested articles

- [The appearance editor](appearance-editor.md) — where the picker is used most.
- [Material Design 3](material-3.md) — the seed colour and the palette generated from it.
- [Accessibility](../accessibility-and-languages/accessibility.md) — contrast and the not-colour-alone rule.
- [Panels](panels.md) — file colouring rules, which are data colours and exempt from theming.
