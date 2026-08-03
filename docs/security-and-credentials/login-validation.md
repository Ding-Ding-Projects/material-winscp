# Login validation

The Login form validates the destination before calling the session bridge.
The host name must be non-blank and the port must be an integer from 1 through
65535. Invalid host and port controls expose `aria-invalid`, and the form
announces the exact correction through the accessible notification surface.

This validation does not trust a typed host-key fingerprint. Host-key security
remains in the main session flow: a configured pin must match exactly, while an
unknown or changed key opens a decision dialog before credentials are used.

The Login session-open boundary also accepts the IPC error envelope and the
legacy string form. Both retain the server or transport message when one is
present; malformed or empty errors fall back to `The session could not be
opened.` rather than displaying `[object Object]` or an empty notification.

## Verification

`test/login-validation.test.js` covers missing hosts, trimmed valid hosts,
invalid port values, and both session-open error shapes. Host-key acceptance and
mismatch behaviour are covered by the session and security tests documented in
[Host keys](host-keys.md).
