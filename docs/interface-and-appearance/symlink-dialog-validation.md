# Symlink dialog name validation

The link dialog accepts a link name and a separate target. The name must be a
single safe file-name segment; blank names, `.` and `..`, path separators, and
control characters are rejected before the filesystem operation is attempted.
This prevents a typed path from escaping the directory selected for the dialog.

The target remains a path or other protocol-valid link target, because that is
what the link is meant to point at. The OK action stays disabled while the name
or target is invalid, and the same validation runs again when the action is
invoked.

The dialog remains available while the replace/create bridge call is pending;
it closes only after the bridge confirms success. A rejected replace or create
therefore leaves the inputs and actions available for a retry.

Verification: `node --test test/symlink-dialog.test.js`.
