# Custom-command validation

The CustomCommand editor and the main process use the same WinSCP validation
contract. Validation is deliberately two-stage: interactive prompt patterns
(`!?prompt?default!` or `!?prompt!`) and embedded command patterns
(`!`command``) are consumed first; file patterns are then checked for an
invalid mixture of a single-file `!` and whole-selection `!&` pattern.

This matters because punctuation inside an interactive pattern is not a file
selection. For example, `grep "!?Text:?default!" !&` is valid and runs once for
the whole selection. `echo !?Text?! ! !&` is invalid because it contains a
real single-file `!` as well as `!&`.

Unterminated prompts and embedded commands remain errors. The dialog reports
the error before saving, and `app:runCustomCommand` repeats the check before
expansion and execution. Preview requests invalidate older generations even
when the newly typed command is empty or invalid, so late output cannot replace
the current validation state.

## Verification

The focused regression test is `test/customcmd.test.js`, which covers valid
prompt and embedded-command patterns alongside the genuine `!`/`!&` conflict.
