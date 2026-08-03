# Credential storage

## What it does

`design/main/crypto.js` is the only place in the application that turns a secret
into bytes on disk, and the only place that turns them back. Everything else —
sites, workspaces, proxies, tunnels, S3 keys — goes through it.

Its contract is one sentence: **a secret is protected, or it is not stored.**

## How a secret is protected

In order of preference:

1. **The operating system keychain.** The secret is handed to the platform's
   credential store and only a handle is written to the configuration file. This
   is the default on a normal Windows profile.
2. **A master-password-derived key.** When a
   [master password](master-password.md) is set, secrets are encrypted with a key
   derived from it using scrypt, with a per-installation random salt and
   authenticated encryption.
3. **Not at all.** If neither is available — a stripped-down profile, a keychain
   the user declined, a portable installation with no master password — the
   secret is **not written**. The site keeps `savePassword` off and asks at
   connect time. The UI says which of the three applies.

There is no fourth option, and no override. Obfuscation that looks like
encryption is worse than plainly asking each time, because it makes the user
believe something false.

## What counts as a secret

| Field | Where it comes from |
| --- | --- |
| `password` | Site login |
| `passphrase` | SSH private key |
| `tunnelPassword`, `tunnelPassphrase` | Jump host |
| `proxyPassword` | Proxy authentication |
| `password` for S3 | Secret access key |
| `s3SessionToken` | Temporary credentials |
| `encryptKey` | At-rest file encryption |
| `masterPasswordVerifier` | Not a secret — a verifier, see below |

## Configuration

| Option | Default | Meaning |
| --- | --- | --- |
| `savePassword` (per site) | `false` | Whether to store this site's password at all. |
| `queue.rememberPassword` | `false` | Keep it **in memory** for the session, so queued work can reconnect. Not a disk setting. |
| `window.autoSaveWorkspacePasswords` | `false` | Include credentials when auto-saving a workspace. |
| `security.useMasterPassword` | `false` | See [master password](master-password.md). |

## Failure modes

| Situation | What the user sees | Recoverable |
| --- | --- | --- |
| Keychain unavailable | The save option explains that without a master password the secret will not be stored, and offers to set one. It does not silently fall back to storing it. | Yes |
| Protection fails while saving a credential | The mutation is rejected with a protection error; no site or partial credential is added, updated, or re-wrapped. | Yes — enable an available protection route and retry |
| Keychain entry deleted externally | The site's password is gone; connecting prompts. The stale handle is cleaned up rather than reported as corruption. | Yes |
| Config copied to another machine | Keychain-protected secrets do not travel — by design. Master-password-protected ones do, and need the master password. The import summary states how many secrets could not be carried. | Yes |
| Decryption fails (wrong key, damaged bytes) | Authenticated encryption makes this detectable. The app reports that the stored secret could not be read and prompts, rather than sending garbage as a password. | Yes |
| Protected envelope text is malformed (including whitespace, ignored characters, or missing padding) | The envelope is rejected before decryption; no repaired or partially decoded value is accepted. The app prompts again. | Yes |
| A secret is needed while the app is locked | One prompt for the master password, not one per secret. | Yes |
| Master password removed | Every secret is re-wrapped with the keychain if available. If that protection route is unavailable, the setting remains enabled and the operation reports failure rather than deleting credentials. | Yes |

## Security considerations

- **Nothing is obfuscated and called encrypted.** WinSCP's historical INI
  password scrambling is not reproduced. Imported scrambled passwords are
  unscrambled and immediately re-protected properly, or dropped.
- **Legacy scramble parsing is fail-closed and damage-tolerant.** The decoder
  checks every candidate length header against the complete blob, so a damaged
  padding byte that happens to become a digit cannot make the decoder stop at
  a false header or return a partial password.
- **Authenticated encryption everywhere.** A modified ciphertext fails to
  decrypt rather than decrypting to something else.
- **Envelope text is validated before decoding.** Invalid base64, padding, or
  non-text ciphertext is rejected before AES-GCM authentication; the caller
  receives an empty secret and prompts again rather than accepting a decoder's
  permissive normalization. UTF-8 decoding is fatal, so authenticated bytes
  that are not valid text are rejected rather than replaced with `�`.
- **Verifier records have an exact shape.** A master-password verifier with
  missing or trailing bytes is rejected before password verification; malformed
  security state never gets treated as a valid credential store.
- **AAD is bound to a stable identifier**, not to a row id or array index. A
  record that is deleted and restored from history keeps its identifier, so its
  secret still decrypts. Binding to an autoincrement id produces data that
  becomes permanently unreadable after a restore, in a way that looks exactly
  like corruption — this is the single subtlest bug in this area and it is
  guarded by a test.
- **Secrets are held in memory only as long as needed** and are not written to
  the session log at any log level. `logging.logSensitive` is about protocol
  traffic and still does not print the stored credential.
- **The app never displays a stored secret back to the user**, and there is no
  "show saved passwords" surface. Password managers exist for that.
- **Malformed protected envelopes are refused.** OS-keychain ciphertext must
  use canonical base64, and malformed external-password payloads are not
  converted into an empty credential. The connection falls back to an explicit
  prompt instead of silently trying damaged state.
- **In-memory (`rememberPassword`) and on-disk (`savePassword`) are different
  settings** with different consequences, and the UI does not blur them.
- **Exported configuration may contain protected secrets.** The export dialog
  states whether it does; an export with master-password-wrapped secrets is only
  as strong as that password.

## Verification

- Round-trip encryption and decryption are tested for every secret field.
- Tamper detection is tested by flipping bits in stored ciphertext and asserting
  a clean failure rather than a garbage plaintext.
- **The delete-and-restore AAD case has a dedicated test**: a record is deleted,
  restored from history under a new internal id, and its secret must still
  decrypt.
- The refusal path is tested: with no keychain and no master password, saving a
  password must write nothing and leave `savePassword` false.
- Log output is scanned in tests to assert no secret field value ever appears, at
  any log level.

## Suggested articles

- [Master password](master-password.md) — the second protection route, in detail.
- [Host keys](host-keys.md) — verifying the server before a credential is sent.
- [Session logging](logging.md) — what the logs do and do not contain.
- [Version history](../version-history/) — how snapshots keep ciphertext as ciphertext.
