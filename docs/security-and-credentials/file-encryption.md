# At-rest file encryption

## What it does

Encrypts file *contents* on the client before upload, and decrypts them on
download. The server stores ciphertext and never sees plaintext — which is the
point when the storage is someone else's, an S3 bucket or a shared host.

This is WinSCP's file encryption feature, and it is entirely separate from the
transport encryption that SFTP, FTPS and HTTPS provide. Transport encryption
protects data in flight; this protects it at rest.

## Configuration

Per site, under **Site → Advanced → Encryption**.

| Option | Default | Meaning |
| --- | --- | --- |
| `encryptFiles` | `false` | Enable encryption for this site. |
| `encryptKey` | `''` | The key. Stored like any other secret — see [credential storage](credential-storage.md). |
| `encryptNewFiles` (transfer setting) | `true` | Whether a transfer encrypts files it uploads. |

## Behaviour worth knowing

- **Filenames are also protected**, so a directory listing does not reveal what
  is stored. That is why an encrypted directory looks like nonsense when viewed
  by any other client.
- **File sizes change.** Ciphertext carries a header and authentication tag, so
  the remote size never matches the local one. Size-based synchronization
  comparison is therefore unreliable on an encrypted site, and the comparison
  engine says so rather than reporting every file as different.
- **Resume works**, because the format is designed for it — but resuming an
  encrypted transfer with a *different* key produces a file that is
  unrecoverable, so the key is checked before resuming.
- **Encryption is per site, not per file.** Mixing encrypted and unencrypted
  files in one remote directory is possible and confusing; the panel marks
  encrypted entries.

## Failure modes

| Situation | What the user sees | Recoverable |
| --- | --- | --- |
| Key lost | The data is permanently unreadable. There is no recovery, and none is implied. | **No** |
| Wrong key for an existing directory | Filenames fail to decrypt and are shown in their raw form, flagged as undecryptable. They are not hidden — hiding them would look like data loss. | Yes, with the right key |
| `encryptFiles` enabled on a directory with existing plain files | New files are encrypted, old ones are not. The panel distinguishes them; nothing is converted in place, because a bulk in-place conversion that fails halfway is unrecoverable. | n/a |
| `encryptFiles` disabled with encrypted files present | Those files stop being readable through this site until it is re-enabled. The setting warns before turning it off. | Yes |
| Another client reads the directory | It sees ciphertext and encrypted names. Working as intended, and worth knowing before sharing a path with a colleague. | n/a |
| Size-based sync comparison | Always reports differences. The comparison engine detects an encrypted site and recommends timestamp comparison instead. | Yes |
| Interrupted upload | The partial ciphertext is not decryptable; resume completes it, and the authentication tag catches a corrupt result rather than producing a plausible bad file. | Yes |
| Very large file | Encryption is streamed, not buffered, so memory use is bounded regardless of file size. | n/a |

## Security considerations

- **The key is as valuable as the data.** It goes through the same protection as
  every other secret: keychain, or master-password-derived key, or not stored.
  Losing it loses the data, and the setup dialog says so before the option can be
  enabled.
- **This defends against the storage provider and anyone who steals the
  storage.** It does not defend against someone with access to *your* machine
  while the key is available.
- **Metadata still leaks.** File count, approximate sizes, modification times and
  directory structure remain visible to the server even when names are encrypted.
- **Authenticated encryption** means tampering is detected on download rather
  than producing corrupted output that looks valid.
- **Do not use this as a substitute for transport encryption.** With
  `encryptFiles` on and plain FTP, the file bodies are protected but the
  *password* still crosses the network in clear. The login screen's unencrypted
  warning is not suppressed by this feature.
- **Key rotation is not automatic.** Changing `encryptKey` does not re-encrypt
  existing files; it makes them unreadable until the old key is restored. The
  field warns on change.

## Verification

- Round-trip encryption and decryption are tested for content and for filenames,
  including names with non-ASCII characters and near the length limit.
- Tamper detection is tested by modifying ciphertext and asserting a clean
  failure.
- Streaming is tested with a file larger than available buffer memory to confirm
  bounded memory use.
- Resume with a mismatched key is tested to assert it is refused rather than
  producing a corrupt file.
- The synchronization engine's encrypted-site detection is tested to confirm it
  recommends timestamp comparison instead of reporting universal differences.

## Suggested articles

- [Credential storage](credential-storage.md) — where `encryptKey` lives.
- [S3](../protocols/s3.md) — the storage this matters most for.
- [Synchronize](../synchronization/synchronize.md) — why size comparison misleads here.
- [Resume](../transfers-and-queue/resume.md) — the key check before an encrypted resume.
