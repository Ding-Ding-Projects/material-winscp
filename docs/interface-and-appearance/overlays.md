# Overlay surfaces and viewport fitting

Floating menus, regex builders, colour pickers, the queue popover and
non-modal transfer windows are rendered in the renderer layers from
[`dom.js`](../../design/renderer/dom.js). Anchored surfaces use one positioning
contract: they paint their own Material surface, stay within the logical
viewport, flip when the opposite side has room, and scroll when their content
is taller than the available side space.

## The bounded fix

The shared `overlayLayout()` calculation uses the measured anchor and surface
boxes plus an 8px viewport inset. It no longer forces a 160px minimum height:
that minimum was larger than the real space in short windows and could make a
popover cover its anchor or paint outside the viewport. `anchorTo()` applies
the calculated cap before its final measurement and gives the anchored surface
an `overflow-y: auto` contract.

The queue popover has an additional flex constraint. Its root and body now use
`min-height: 0`; the root clips its chrome and the queue list owns scrolling.
This prevents the queue toolbar and empty/list state from pushing through the
surface at a short viewport.

Blocking dialogs use the same narrow-window discipline. The scrim gutter
shrinks from 24px to 8px as needed and scrolls if the viewport is shorter than
the dialog. The dialog is `box-sizing: border-box`, capped to the available
width and height, and clips its shell so `.modal-body` owns vertical scrolling;
the action row therefore remains reachable instead of being painted below the
window.

## Configuration and failure modes

There is no user setting for overlay placement. The surface follows the
control that opened it and is recalculated on resize, document scrolling,
anchor resize and surface resize. If there is only a few pixels of room, the
surface remains usable at that size and exposes a scrollbar; content is not
deleted to satisfy a visual cap. Coordinate menus receive the same positive
height guard for extremely small viewports.

Overlay backgrounds are provided by the `surface-1/2/3` tokens and each
floating root carries a surface class plus its border/elevation. Transparent
gradients inside the colour picker's alpha rail are intentional data
visualisation, not the panel background.

## Security and accessibility

Positioning is local DOM arithmetic. No overlay content or geometry is sent to
the network. The existing focus restoration, non-modal `aria-modal="false"`
contract, keyboard Escape handling and scrollable regions remain unchanged.

## Verification

- `test/overlay.test.js` checks bounded geometry, side flipping, tiny viewport
  dimensions, the modal narrow-window contract and the production
  surface/scroll contracts.
- `test/e2e-overlays.test.js` opens the real regex builder and queue popover in
  a 420×260 Electron window and checks their real rectangles, computed
  backgrounds and overflow behaviour.
- Syntax, `git diff --check`, the port matrix and the site build are run for
  this slice.

Remaining gaps are broader overlay inventory work: every legacy WinSCP dialog
still needs a dedicated visual capture at all display scales, and the smoke
does not claim that every possible localized string or user-authored appearance
override is visually perfect.

Suggested related articles: [Colour picker](colour-picker.md), [Regex builder](../search-and-regex/regex-builder.md), [Notifications](notifications.md), and [Accessibility](../accessibility-and-languages/accessibility.md).
