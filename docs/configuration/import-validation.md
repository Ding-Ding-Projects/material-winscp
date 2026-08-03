# Configuration import validation

Configuration backups are validated before they can replace live sites or
preferences. JSON backups must contain valid JSON and a top-level object; a
malformed file produces a configuration-specific error and leaves the current
configuration untouched. WinSCP `.ini` files continue through the separate
site-only importer, which validates that at least one stored session exists.

The JSON parser error is retained as `error.cause` for diagnostics, while the
user-facing message identifies the selected file as invalid configuration data.
Import does not partially apply a malformed file, and no secret is included in
the error text beyond the parser's local syntax detail.

Focused verification:

```powershell
node --test test/config-ini.test.js
```
