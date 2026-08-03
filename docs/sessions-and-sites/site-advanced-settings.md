# Advanced site settings

`design/renderer/ui/dialogs/siteadvanced.js` stores the per-site options that
are not part of the main connection form. Its 18 pages keep protocol-specific
settings visible, disable options that do not apply, and preserve known
capability gaps instead of silently discarding a user's value.

## Time zone offset validation

The split hours/minutes editor stores one fractional-hour value. Values are
normalized on commit: hours are limited to `-24` through `24`, minutes to
`-59` through `59`, and an edge-hour value (`24` or `-24`) always has zero
minutes. Therefore the largest accepted offsets are exactly `+24:00` and
`-24:00`; entries such as `24:59` cannot be persisted. When hours are non-zero,
minutes follow the hour's sign so the displayed and stored offset agree.

Secrets remain protected: untouched stored secrets are omitted from the patch,
and enabling file encryption requires either a new key or the protected-key
sentinel.

The panel edits an isolated deep copy of the site. This matters for nested
workaround objects such as `sshBugs` and `sftpBugs`: cancelling Advanced does
not leak a change into the login form or the stored site, while accepting it
returns the complete edited copy for persistence.

Numeric editable combos such as the local tunnel port are normalized before
they enter site state: non-finite input becomes `0`, fractional input is
truncated, and ports are limited to `0`–`65535`.

Numeric fields also expose named increment/decrement buttons. They remain in the
keyboard tab order and are not hidden from assistive technology, so users can
make the same bounded adjustment without relying on a pointer.

The FTP page's `HOST` selector now reaches the FTP adapter, which sends the
server-selection command when the site asks for it. The SFTP page's listing
pipelining depth also now feeds the directory-entry metadata walker, so the
queue setting affects the number of simultaneous `lstat`/`readlink` lookups
during a listing and recursive delete. SFTP download/upload queue depths also
control the bounded READ/WRITE windows used by streaming transfers, and
`ftpTransferActiveImmediately` controls passive transfer ordering.

Protocol boundaries are explicit. The proxy page is enabled only for SSH
sessions because the current port wires that transport only; the source
address and SSH buffer controls are likewise disabled for adapters that do not
consume them. S3 uses its adapter TLS defaults, so configurable TLS controls
are disabled there. Stored-but-not-wired options such as VMS revision
filtering, WebDAV cross-host redirects, loopback proxy bypass, and protocol
feature overrides remain visible with a capability note instead of pretending
to work.

Verification: `node --test test/sitedata.test.js`.
