# Accessibility

## The standing rule

Accessibility defects are **completion blockers, not polish**. A clipped label, a
control that cannot be reached by keyboard, a missing accessible name or an
insufficient contrast ratio is a bug that stops a change from being finished — in
the same way a failing test does.

## What is guaranteed

### Keyboard

- Every command is reachable without a pointer, including
  ["Edit appearance…"](../interface-and-appearance/appearance-editor.md), which
  has a named keyboard command precisely because Shift+right-click is not
  available to everyone.
- Focus order follows the visual order.
- Focus is **visible** at all times, with an indicator that survives every
  appearance override.
- Tab strips use roving focus: one tab stop for the strip, arrows to move within
  it.
- Modals trap focus and return it to the invoking element on close. Non-modal
  anchored editors do not trap, but do return focus.
- Escape closes anything closable, at the innermost level first.

### Roles, names and states

- Correct platform semantics: `tablist` / `tab` / `tabpanel` with live
  `aria-controls`, `dialog` for modals, `status` and `alert` live regions for
  notifications, `tree` for directory trees, `grid` for panels.
- Every control has an accessible name that is **not** derived from colour, icon
  or position alone.
- State is exposed, not implied: selected, expanded, pinned, busy, disabled,
  invalid.
- **A decoration can never replace a name or a state.** Tab and group appearance
  overrides are additive.

### Contrast and colour

- All text and meaningful non-text content meets the required contrast ratio in
  both light and dark modes, at the default theme.
- The [appearance editor](../interface-and-appearance/appearance-editor.md) and
  the [colour picker](../interface-and-appearance/colour-picker.md) show a live
  contrast readout, so a user customizing the theme is warned rather than left to
  discover it.
- **Colour is never the only signal.** Destructive rows in the
  [comparison checklist](../synchronization/comparison-checklist.md), error
  states, per-site danger tags and file-colour rules all carry an icon, a label
  or a shape as well.

### Motion

- `reduceMotion` follows the OS setting by default and can be forced on.
- With it on, transitions become **instant**, not merely faster — a shortened
  animation still moves.
- Nothing auto-plays, auto-scrolls or flashes. The
  [dim sum surprise](dim-sum.md) respects reduced motion like everything else.

### Size and layout

- Controls are sized to their design spec and consistent with their siblings;
  click and touch targets meet the minimum.
- **No clipping, truncation, overlap or off-screen content** at any supported
  window size, display scale (100/125/150/200%), density step or language mode.
- The worst case — bilingual mode, the longest string, the tightest density, the
  narrowest width, 200% scale — is validated explicitly, because that is where
  defects actually appear.

### Screen readers and the narrator

- Notifications are announced through live regions: `polite` for informational,
  `assertive` for errors, never both and never duplicated.
- The [narrator](narrator.md) yields to or ducks under an active screen reader.
  Two voices talking over each other is worse than one.

## Failure modes

| Situation | What happens |
| --- | --- |
| A new control ships without an accessible name | The accessibility test suite fails. It is not a warning. |
| An appearance override removes the focus indicator | Not possible — the indicator is composed over the override and is not an editable property. |
| An override destroys contrast | Warned live with the measured ratio. Not blocked, because some elements are decorative — but never invisible. |
| A long bilingual label would clip | Truncated with the full text in the tooltip and the accessible name. |
| A modal opens while a toast is announcing | The modal takes focus; the toast finishes its announcement. Neither interrupts the other mid-sentence. |
| A collapsed tab group contains a prompt | Surfaced as a badge and a notification. A fold never hides a decision. |

## Security considerations

- **Accessibility and security overlap at every warning.** A destructive
  confirmation that a screen-reader user cannot hear the count of, or that a
  colour-blind user cannot distinguish from an informational message, is a
  security failure as much as an accessibility one.
- **Focus trapping in credential dialogs** is what keeps a password from being
  typed into whatever is behind them.
- **The narrator never speaks a credential**, and never reads a field marked as
  secret.

## Verification

- Automated checks over every rendered surface: accessible name present, role
  correct, state exposed, contrast measured, focus indicator present.
- Keyboard reachability is tested per surface by walking the focus order and
  asserting every command is reachable.
- Layout validation runs at 100/125/150/200% scale, at every density, in all
  three language modes, with the longest string per key.
- Live-region politeness is asserted per notification category.
- Reduced motion is tested to make transitions instant rather than fast.
- Manual screen-reader passes complement the automated checks; automated
  accessibility testing catches structure, not comprehensibility, and this
  article does not claim otherwise.

## Suggested articles

- [Language modes](language-modes.md) — bilingual mode, the hardest layout case.
- [The narrator](narrator.md) — coexisting with assistive technology.
- [The appearance editor](../interface-and-appearance/appearance-editor.md) — what customization must never break.
- [Notifications](../interface-and-appearance/notifications.md) — live regions and focus.
