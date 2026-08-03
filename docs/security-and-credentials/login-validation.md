# Login validation

The Login form validates the destination before calling the session bridge.
The host name must be non-blank and the port must be an integer from 1 through
65535. Invalid host and port controls expose `aria-invalid`, and the form
announces the exact correction through the accessible notification surface.

This validation does not trust a typed host-key fingerprint. Host-key security
remains in the main session flow: a configured pin must match exactly, while an
unknown or changed key opens a decision dialog before credentials are used.

While a session-open request is pending, the Login action is disabled and a
second activation is ignored. This prevents rapid clicks or keyboard activation
from opening duplicate sessions or firing the successful-login callback twice;
the action becomes available again after the request settles, including errors.

The Login session-open boundary also accepts the IPC error envelope and the
legacy string form. Both retain the server or transport message when one is
present; malformed or empty errors fall back to `The session could not be
opened.` rather than displaying `[object Object]` or an empty notification.

Authentication prompts use the same delivery boundary: a credential answer is
not considered submitted until the session manager confirms it. A failed bridge
call leaves the prompt open for retry, while a prompt-cancelled event closes it
without sending a duplicate refusal; typed credential fields are cleared when
the prompt closes.

## Verification

`test/login-validation.test.js` covers missing hosts, trimmed valid hosts,
invalid port values, and both session-open error shapes. Host-key acceptance and
mismatch behaviour are covered by the session and security tests documented in
[Host keys](host-keys.md). It also covers the submit guard's pending and reset
states.
