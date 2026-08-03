# Master-password rewrap failure handling

## What it does

Changing, enabling, or removing the master password re-wraps every stored
credential in one in-memory pass before the configuration is saved. If any
non-empty protected value cannot be decrypted, the operation refuses to
continue instead of treating the missing plaintext as an empty credential.

## Configuration

The behaviour applies automatically to the master-password actions described
in [master-password.md](master-password.md). It adds no setting and exposes no
secret or diagnostic value.

## Failure modes

An invalid envelope, unavailable keychain entry, locked master key, or wrong
master password makes the affected value unreadable. The rewrap returns a
failure and leaves the existing sites and security settings unchanged. The
user can repair or remove the affected credential explicitly and retry.

## Security considerations

An unreadable credential must not be silently converted to `''`: that would
look like a successful password change while permanently deleting data. The
guard runs before either rewrap path mutates security state or schedules a
configuration save.

## Verification

`test/security.test.js` supplies a malformed protected password and verifies
that both enabling and disabling the master password return `false` without
changing the stored envelope or configuration state.

## Suggested articles

- [Master password](master-password.md) — the complete setting and lifecycle.
- [Credential storage](credential-storage.md) — protection and refusal rules.
- [Host keys](host-keys.md) — the separate server-trust store.
