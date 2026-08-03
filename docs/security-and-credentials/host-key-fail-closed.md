# Host-key verification fails closed

The host-key dialog must never approve a connection when the server's
presented SHA-256 fingerprint is absent or only whitespace. Showing a dash is
useful as a diagnostic, but it is not an identity that a user can verify.

`design/renderer/ui/dialogs/authenticate.js` trims the presented fingerprint
once and uses that value for both display and the acceptance guard. If it is
empty, the accept action reports rejection and does not call the session
answer bridge. The session therefore remains unapproved and the user must
retry with a complete verification result.

This is deliberately narrower than trusting a typed fingerprint: the dialog
still displays the value supplied by the session manager and the existing
changed-key confirmation remains mandatory. A missing value is an incomplete
security decision, not an “unknown but probably fine” state.

The main-process verifier applies the same boundary before opening the prompt
for a host key or certificate. An accepted identity is remembered only when
the stored fingerprint is non-empty, so an empty record cannot make a later
connection appear trusted. Permanent session close also clears the decrypted
credential fields retained by the live session object.

Verification: `node --test test/authenticate.test.js test/session-manager.test.js`.
