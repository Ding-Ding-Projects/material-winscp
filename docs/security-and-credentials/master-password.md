# Master password

## What it does

Sets one password that protects every stored secret. It is the alternative to
the OS keychain, and the only way to have stored credentials on a machine where
the keychain is unavailable — a portable installation, a locked-down profile, or
a configuration meant to move between machines.

## How it works

- The password is never stored. A **verifier**
  (`security.masterPasswordVerifier`) is derived from it and kept, so a wrong
  password can be rejected without the real one being on disk.
- The encryption key is derived with **scrypt**, using a per-installation random
  salt and deliberately expensive parameters — the cost is the point: it makes
  guessing slow.
- Secrets are then sealed with authenticated encryption, so a modified
  ciphertext fails cleanly instead of decrypting to something wrong.
- The in-memory derived key is explicitly zeroized when the session is locked or
  replaced. Verifier salts and AES-GCM envelopes are validated before use, so a
  damaged or hand-edited verifier fails closed instead of reaching a lower-level
  crypto error.

## Configuration

| Option | Default | Meaning |
| --- | --- | --- |
| `security.useMasterPassword` | `false` | Whether one is set. |
| `security.masterPasswordVerifier` | `''` | The derived verifier. Not the password, and not reversible into it. |

Under **Preferences → Security**:

- **Set master password** — prompts twice, then re-wraps every existing secret.
- **Change master password** — asks for the current one, then re-wraps everything
  under the new one.
- **Remove master password** — re-wraps secrets with the keychain if available,
  or **deletes** them if not. The confirmation states which will happen and how
  many secrets are affected.
- **Lock now** — discards the in-memory key immediately.

## Behaviour worth knowing

- **It is asked for once per run**, the first time a secret is needed, and the
  derived key is held in memory until the app exits or is locked.
- **Changing it re-wraps every secret in one atomic operation.** A partial
  re-wrap would leave secrets readable under neither password; the write follows
  the same temp-then-rename discipline as the configuration file.
- **It protects stored secrets, and nothing else.** Site names, hostnames,
  usernames, paths, notes and settings remain readable in the configuration
  file. This is stated in the setting, because "master password" sounds like it
  encrypts everything.
- **There is no recovery.** No backdoor, no reset, no hint, no escrow.

## Failure modes

| Situation | What the user sees | Recoverable |
| --- | --- | --- |
| Wrong password entered | Rejected by the verifier, with a deliberate delay to slow guessing. Nothing is decrypted, and no partial information is revealed. | Yes |
| Password forgotten | Every stored secret is permanently unreadable. The app offers to clear them so the sites remain usable with re-entered credentials. It cannot recover them, and does not pretend it might. | **No** |
| Prompt cancelled | Sites needing a stored secret prompt individually instead. The app stays usable. | Yes |
| Set while the keychain is also available | Master password takes precedence; keychain entries are removed after successful re-wrapping, not before. | Yes |
| Removed with no keychain available | Secrets are deleted, because keeping them would mean storing them unprotected. The confirmation says this in those words. | Yes, by re-entering |
| Config moved to another machine | Secrets travel and open with the same master password. This is the main reason to use one. | n/a |
| Interrupted re-wrap (crash, power loss) | The atomic write means either the old or the new state survives, never a mixture. | Yes |

## Security considerations

- **The verifier reveals nothing about the password** — not its length, not its
  content. It cannot be used to check guesses faster than deriving the key.
- **scrypt parameters are chosen for cost, not speed**, and unlocking taking a
  noticeable moment is intended behaviour, not a performance bug.
- **The derived key lives in memory while unlocked.** Anything that can read this
  process's memory can read it. Lock when stepping away; the app does not claim
  protection against an attacker who is already running code as you. Locking
  zeroizes the key buffer before releasing it; this reduces residual exposure but
  is not a substitute for OS process isolation.
- **No recovery mechanism exists**, and adding one would mean the password is not
  the only thing protecting the data.
- **Not a full-disk or full-config encryption.** The setting says what it covers
  so nobody assumes their site inventory is hidden.
- **The app never reveals a stored secret**, including under a correct master
  password. There is no "reveal saved passwords" surface anywhere.

## Verification

- Derivation is tested for determinism given the same password and salt, and for
  producing a different key per installation salt.
- Session lock/re-unlock, failed unlock preservation, malformed verifier
  rejection (including truncated and trailing bytes), and truncated AES-GCM
  envelope rejection are tested directly.
- The verifier is tested to reject wrong passwords and to leak nothing usable.
- Re-wrapping is tested across a full configuration, asserting every secret
  decrypts afterwards and none is left under the old key.
- Atomicity is tested by interrupting the re-wrap and asserting the file is
  either wholly old or wholly new.
- The removal path is tested for both branches: keychain available (re-wrapped)
  and unavailable (deleted, with the count reported).

## Suggested articles

- [Credential storage](credential-storage.md) — the layer this plugs into.
- [The site manager](../sessions-and-sites/site-manager.md) — where secrets are entered and exported.
- [Version history](../version-history/) — snapshots hold ciphertext, so history is never more sensitive than the store.
