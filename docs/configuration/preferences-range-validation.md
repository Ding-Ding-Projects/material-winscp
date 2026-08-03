# Preferences numeric-range validation

Numeric Preferences controls declare the range that the renderer exposes to the
user. Schema validation now rejects a non-finite or reversed `min`/`max` range,
and also rejects a numeric default outside that range. This prevents a newly
added control from opening with a value the input cannot represent.

The validation is structural and runs before the Preferences surface is
rendered. It does not rewrite imported settings; runtime edits still use the
control's declared range and the existing configuration persistence path.

Verification:

```text
node --test test/preferences.test.js
```
