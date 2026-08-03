# Session dialog lifecycle

`design/renderer/ui/dialogs/session.js` is the DOM-free safety seam for a
SessionDialog implementation. It validates remote ports and local directory
selection before opening, removes credential fields from retained renderer
state, and makes reconnect completion generation-bound.

Closing is idempotent. It invalidates an outstanding reconnect token, so a late
successful reply cannot reopen or mark a closed session connected. Reconnect
failures remain explicit disconnected states and are never silently swallowed.

Verification is in `test/session-dialog.test.js` (four focused tests). The
module does not log, serialize, or otherwise expose secret values.
