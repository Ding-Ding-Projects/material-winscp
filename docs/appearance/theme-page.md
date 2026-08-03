# ThemePageControl

`design/renderer/ui/theme-page.js` provides a renderer-safe, mountable page
controller for the application's global appearance mode. It is a controller
over the existing renderer `theme` state, not a second colour engine.

## Behaviour

The mode selection contains exactly four supported values:

| Value | Behaviour |
| --- | --- |
| `light` | Uses the light Material colour scheme. |
| `dark` | Uses the dark Material colour scheme. |
| `system` | Follows the operating system colour preference. |
| `high-contrast` | Enables the highest supported Material role separation (`contrast: 1`). |

`setMode(value)` validates before writing. Unsupported values such as `auto`,
`highContrast` or `sepia` throw a `RangeError`, leave the store unchanged and
do not invoke persistence. The complete theme object is persisted after a
valid change, so existing seed, density, typography and per-element overrides
are retained.

Selecting high contrast is a mode rather than a separate checkbox. It sets the
existing Material contrast level to `1`; returning to light, dark or system
restores standard contrast separation (`0`) so the normal modes do not retain a
surprising high-contrast override.

## Keyboard and accessibility

The mounted page renders a labelled radio group. Each option is a real radio
input with a visible focus indicator and an accessible description. Native
radio semantics handle Tab and assistive technology; the controller also
handles `ArrowLeft`, `ArrowRight`, `ArrowUp`, `ArrowDown`, `Home` and `End` so
selection can be changed without a pointer. The current choice remains
announced through the radio state and a polite status message.

Labels are resolved through the renderer i18n layer, so English, playful
Hong Kong-style Cantonese and bilingual modes are honoured. The facts in the
mode labels and descriptions do not change with the funny-level sliders.

## Reduced motion

`theme.reduceMotion` is a persisted boolean. `setReducedMotion(value)` rejects
non-boolean values instead of coercing strings or numbers. Effective reduced
motion is true when either that preference is enabled or
`prefers-reduced-motion: reduce` matches. The page exposes the effective state
as `data-reduced-motion="1"`/`"0"`, reports it in a polite status region and
disables its own transitions when active. The global theme engine continues to
apply the same preference to the rest of the renderer.

The operating-system media query is observed while the page is mounted and is
removed by `dispose()`. Mounting does not block startup, and disposing the page
removes its subscription and DOM node.

## Verification

The headless contract is covered by:

```text
node --test test/theme-page.test.js
node --check design/renderer/ui/theme-page.js
```

The tests cover the exact mode set, invalid-value rejection before writes,
complete-state persistence, high-contrast mapping, reduced-motion precedence
and keyboard navigation order. The module does not read Node APIs or touch
the filesystem; callers provide a DOM container through `mountThemePage()`.
