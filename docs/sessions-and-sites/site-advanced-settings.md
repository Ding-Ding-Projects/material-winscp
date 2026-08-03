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

Numeric editable combos such as the local tunnel port are normalized before
they enter site state: non-finite input becomes `0`, fractional input is
truncated, and ports are limited to `0`–`65535`.

Verification: `node --test test/sitedata.test.js`.
