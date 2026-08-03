# Preferences numeric editor validation

Numeric Preferences editors commit the value after applying the control's
declared range and scale. The visible field is normalized to that same UI value
on blur/change, so an out-of-range or non-numeric entry cannot remain displayed
after a different value has been persisted.

This is renderer-side validation only: it does not change defaults or rewrite
imported configuration. A malformed imported number is shown as the declared
default with an invalid-value note until the user replaces it. Newly typed
invalid numeric input falls back to the control's minimum (or its declared
default when conversion requires it), then follows the normal
`config:setPref` persistence path.

Verification:

```text
node --test test/preferences.test.js
```
