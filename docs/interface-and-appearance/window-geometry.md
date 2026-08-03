# Window geometry and display fallbacks

`design/main/guitools.js` normalizes incomplete display metrics to finite
logical pixels and clamps restored rectangles to the current work area. It
enforces usable minimum dimensions when space permits and keeps a visible edge
on screen so a restored window remains discoverable and focusable.

The policy is platform-neutral and does not call Win32 APIs. Verification is in
`test/guitools.test.js` for invalid metrics, off-screen bounds, minimum sizing,
and undersized work areas.
## Impossible minimum sizes

The layout may report a minimum width or height larger than the current
monitor work area. `resizeForm` caps that minimum at the work-area dimensions,
so the dialog remains fully reachable instead of extending beyond the screen.
This is a fail-safe boundary; normal minimum constraints are still honored.
