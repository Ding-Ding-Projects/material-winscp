# Notifications

## What it does

Anything that only **informs** appears as a non-blocking corner notification.
Anything that requires a **decision before continuing** is a modal dialog. That
line is the whole design, and it is not negotiable per-feature.

## The rule, concretely

| Kind | Surface |
| --- | --- |
| Transfer finished, queue drained, file saved, connection established | Corner toast, auto-dismissing |
| Progress | Corner toast with a progress indicator |
| An error the user does not have to answer right now (logging failed, one file in a batch failed) | Corner toast, **persistent** until dismissed |
| Overwrite prompt, host key changed, unsaved changes, destructive confirmation, credential or consent request | **Modal** |

Errors and warnings never auto-dismiss. Informational and success toasts do.

## Anatomy

A notification carries a title, a body, an optional icon, and optional actions or
links — Retry, Undo, Open, View details, Copy error. Toasts stack in a screen
corner without overlapping, oldest nearest the edge, and the stack is bounded
with an overflow indicator rather than growing without limit.

## The notification centre

Dismissed notifications remain reviewable. The centre is a tab, with:

- A **search bar** wired to the [regex builder](../search-and-regex/regex-builder.md).
- A **date filter** using the same advanced calendar as the
  [changelog viewer](../packaging-and-updates/changelog.md) — month and year
  jump, range selection, presets, and typed dates in both the locale format and
  plain ISO, reporting a partial entry inline without discarding it.
- A filter by kind (info, success, warning, error, progress) with counts beside
  each, so an empty category is visibly empty.
- Actions that are still valid remain available from the history; ones that have
  expired are shown disabled with the reason.

## Configuration

| Option | Default | Meaning |
| --- | --- | --- |
| Corner | bottom-right | Which corner toasts anchor to. |
| Auto-dismiss delay | 6 s | For informational and success toasts only. |
| Maximum visible | 4 | Beyond this, an overflow indicator. |
| Per-category enable | all on | Errors cannot be disabled. |
| Sound | off | Respects the app's quiet settings. |

Notification appearance is editable per element like everything else, through
["Edit appearance…"](appearance-editor.md).

## Failure modes

| Situation | What the user sees | Recoverable |
| --- | --- | --- |
| Many notifications at once (a batch failing file by file) | Coalesced into one with a count and a details action, rather than 400 toasts. | n/a |
| A notification appears while a modal is open | Toasts render above the scrim but do not take focus. The modal keeps focus, because it is a decision in progress. | n/a |
| The app is minimized | Notifications queue and are shown on restore; the centre has them regardless. Nothing important is lost to being minimized. | Yes |
| An action is invoked after it expires (Undo, hours later) | Disabled with the reason, not silently failing. | n/a |
| A very long message | Truncated with a details action. It never resizes the toast beyond the corner region or pushes content off-screen. | n/a |
| Screen reader active | Announced through a live region: `polite` for informational, `assertive` for errors. Never both, and never a duplicate announcement. | n/a |

## Security considerations

- **Notification text can contain paths, hostnames and error details.** They stay
  in the local UI and reach a log only when session logging is on. Copying an
  error copies exactly what is displayed — no hidden diagnostic payload.
- **Errors cannot be silenced.** A user can disable success and informational
  categories; a failed transfer or an authentication error always surfaces.
- **A notification never asks for a credential.** Anything requesting a secret is
  a modal with a proper focus trap, which is also what makes it distinguishable
  from something an unexpected toast could imitate.
- **Actions in the centre are re-validated when invoked**, not trusted from when
  the notification was created. A stale Retry cannot act on a session that is
  gone.

## Verification

- Category routing is tested: every message type is asserted to use the correct
  surface, and a modal used for a merely-informational message fails the test.
- Auto-dismiss timing is tested per category, asserting errors never auto-dismiss.
- Stacking, bounding and coalescing are tested with synthetic bursts.
- Live-region politeness is asserted per category, with no duplicate
  announcements.
- The centre's search, date filter and kind filter are tested for composition —
  they must compose rather than override one another — and for an honest
  no-match state.
- Focus behaviour with a modal open is tested directly.

## Suggested articles

- [The appearance editor](appearance-editor.md) — restyling notifications.
- [Accessibility](../accessibility-and-languages/accessibility.md) — live regions and focus rules.
- [The queue](../transfers-and-queue/queue.md) — the largest producer of notifications.
- [The changelog viewer](../packaging-and-updates/changelog.md) — the shared date-filter control.
