# Cleanup confirmation dialog

Cleanup is a destructive action over several independently removable data
classes. The confirmation lists each selected class and its current count
before any removal begins.

The confirmation modal stays open while removals run. Successful or partially
successful work closes the modal after reloading counts and reports failures.
If every selected class fails, it remains available for retry.

Verification is in `test/remaining-dialogs.test.js`:

```text
node --test test/remaining-dialogs.test.js
```
