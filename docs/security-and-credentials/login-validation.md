# Login validation

The Login form validates the destination before calling the session bridge.
The host name must be non-blank and the port must be an integer from 1 through
65535. Invalid host and port controls expose `aria-invalid`, and the form
announces the exact correction through the accessible notification surface.

This validation does not trust a typed host-key fingerprint. Host-key security
remains in the main session flow: a configured pin must match exactly, while an
unknown or changed key opens a decision dialog before credentials are used.

## Verification

`test/login-validation.test.js` covers missing hosts, trimmed valid hosts, and
invalid port values. Host-key acceptance and mismatch behaviour are covered by
the session and security tests documented in [Host keys](host-keys.md).
