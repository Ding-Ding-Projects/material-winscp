# Remote transfer dialog

The Duplicate and Move dialogs validate the source selection, target path and
the source session's explicit `copyRemote` capability before calling `queue:add`.
A generic `exec` capability is not sufficient: command execution does not prove
that the protocol implements server-side remote copy, and the IPC seam enforces
the same rule for renderer requests rather than relying on the dialog alone. A
multi-file selection
must use a filename mask such as `/dest/*.bak`; a single literal filename would
overwrite each previous source name in turn and is refused in the dialog.

Only the source session is offered as an enabled target. This port currently
implements server-side remote copy on that session; cross-session copying would
require a local temporary round trip that is not implemented, so other sessions
are visible but disabled rather than silently sending paths to the wrong server.

The dialog stays open while queue submission is pending and remains open when
IPC returns `{ ok: false, error }` or the bridge rejects. The error is reported
as a notification, the action becomes available again, and no success history is
written. Cancel is therefore always a local dialog action; it never claims to
cancel an already queued transfer. Overwrite prompts are owned by the queue's
normal transfer policy and are not bypassed by this dialog.

The target warning is a polite live status and is associated with the path field
for assistive technology. Focusable controls retain the standard dialog focus
order.

Verification: `node --test test/remotetransfer.test.js` covers empty selection,
blank target, missing session, unsupported capability, multi-file literal target,
and a valid masked target. The affirmative action returns the modal primitive's
explicit keep-open sentinel while `queue:add` is pending; it closes only after
success and remains available for retry after failure. The primitive does not
await an `async` action callback.
