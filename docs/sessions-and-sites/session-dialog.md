# Session dialog lifecycle

`design/renderer/ui/dialogs/session.js` is the DOM-free safety seam for a
SessionDialog implementation. It validates remote ports and local directory
selection before opening, removes credential fields from retained renderer
state, and makes reconnect completion generation-bound.

Closing is idempotent. It invalidates an outstanding reconnect token, so a late
successful reply cannot reopen or mark a closed session connected. Reconnect
failures remain explicit disconnected states and are never silently swallowed.

The SiteAdvanced encryption control is persisted with the site and is guarded at
save time: enabling file encryption requires a non-empty new key or an existing
protected-key sentinel. The dialog never displays a stored key, and reports the
missing-key condition through an accessible alert instead of saving a setting
that cannot encrypt files.

Verification is in `test/sitedata.test.js` (encryption-key validation).

Advanced algorithm preference lists are accessible listboxes. Their selected
entry is exposed through `aria-activedescendant`, and every rendered option has
the stable DOM id required by that relationship, so keyboard and screen-reader
users do not lose the active item when the list is repainted after a move.

Verification is in `test/sitedata.test.js` (order-list active-descendant target).

Verification is in `test/session-dialog.test.js` (four focused tests). The
module does not log, serialize, or otherwise expose secret values.

Session URLs also preserve the `;save` session parameter when they address a
stored site. For example, `work/prod/var/log/;save=1` sets `saveOnly` without
treating the parameter as part of the remote path.

Verification is in `test/sessiondata.test.js` (stored-site `;save=1` handling).
