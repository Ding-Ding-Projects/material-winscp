# Create Directory validation

The Create Directory dialog accepts exactly one safe directory-name segment.
Blank input, `.` and `..`, path separators, and control characters are refused
before the local or remote `mkdir` operation is called. This keeps the dialog's
target inside the directory selected by the caller and avoids silently creating
or selecting the current or parent directory.

Verification: `node --test test/createdirectory.test.js`.
