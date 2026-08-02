# Security policy

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Use GitHub's private vulnerability reporting on this repository:
**Security → Report a vulnerability**. That creates a private advisory visible
only to the maintainers.

Please include:

- What the problem is and what an attacker could achieve with it.
- The exact version or commit.
- Reproduction steps, and a proof of concept if you have one.
- The protocol, server software and configuration involved, where relevant.

**Redact before you send.** Do not include real credentials, private keys,
hostnames you would rather not share, or a session log captured with
`logging.logSensitive` enabled — that log contains passwords and passphrases in
clear.

We will acknowledge the report, tell you what we found, and say plainly when we
cannot fix something. If a report describes intended behaviour rather than a
defect, we will explain why and — if the behaviour is surprising enough to have
been mistaken for a vulnerability — improve how it is documented.

## Supported versions

**No release has been published yet.** Once releases exist, the most recent
release is supported. Older builds are not patched.

## What this application is, in security terms

WinSCP Material is a **desktop client**. It:

- connects outward to servers the user chooses, over SFTP, SCP, FTP/FTPS, WebDAV
  and S3;
- stores connection data and credentials locally;
- runs commands the user configures, locally and remotely;
- exposes **no HTTP API, no server and no listening port of its own**.

There is no service to attack from the network. The interesting surfaces are the
protocol parsers, the credential store, the command-expansion layer and the
update mechanism.

## Design commitments

These are the properties the code is written to maintain. A report that one of
them is violated is a security report, not a feature request.

| Commitment | Detail |
| --- | --- |
| **A secret is protected or it is not stored** | OS keychain, or a scrypt-derived key from a master password, or the app asks every time. Never obfuscation presented as encryption. |
| **A changed host key or certificate always stops** | In every code path — interactive, reconnect, workspace restore, queued transfer. There is no setting to auto-accept one. |
| **Encryption is never silently downgraded** | An unencrypted protocol warns. Falling back from an encrypted one is offered, never performed automatically. |
| **Remote input never reaches a shell unquoted** | Every substituted filename goes through the quoting layer. Tested against an adversarial corpus. |
| **Remote paths cannot escape the target directory** | Listings are normalized and confined before being joined to a local path. |
| **Parsers are bounded** | Listing parsers, XML parsers and regex evaluation all have size and time bounds. Entity expansion is disabled. |
| **Logs redact at the point of writing** | Not by post-processing, so a crash mid-write cannot leave an unredacted fragment. `logSensitive` is off by default and warns when enabled. |
| **Version history mirrors ciphertext as ciphertext** | It never decrypts to snapshot, so it never creates a plaintext copy of a secret. |
| **Nothing installs itself** | There is no silent auto-update. |

## Known limitations, stated plainly

These are real and are not going to be fixed by a code change. They are listed
here so nobody has to discover them in an incident.

### Builds are not code-signed

Windows SmartScreen will warn on first run, and antivirus software may quarantine
the installer. **Download only from this project's own release page.** Signing
requires a certificate, which is credential material this repository cannot hold.

Consequence: Squirrel verifies the update package's checksum from its `RELEASES`
manifest, which protects against corruption. Without signing, it does not by
itself protect against a substituted package on a host that has already been
compromised.

### Trust on first use

The first connection to a host cannot be verified by the app — that is inherent
to the model, and the dialog says so. The only genuinely safe first connection is
one whose fingerprint you obtained another way. Pin `hostKey` for unattended
connections, because a prompt nobody sees is a prompt nobody answers.

### Master password recovery does not exist

Forget it and every stored secret is permanently unreadable. There is no
backdoor, no reset and no escrow, and adding one would mean the password is not
the only thing protecting the data.

### Memory access defeats everything

While the app is unlocked, the derived key and any in-use credential live in
process memory. Anything already running code as your user can read them. This
application does not claim protection against that.

### The console and custom commands execute what you tell them to

That is the feature. Filenames are quoted; the commands themselves are yours.
An imported site can carry `postLoginCommands`, and an imported extension carries
a command pattern — both are shown in full and require explicit confirmation
before anything runs.

### User data survives uninstall

Sites, settings and version history remain under the user data directory after
the app is removed. That is the right default, and worth knowing if the data is
sensitive.

## Out of scope

- Vulnerabilities in servers this client connects to.
- Vulnerabilities in upstream WinSCP itself — report those to
  [the WinSCP project](https://winscp.net/).
- Vulnerabilities in Electron, Node.js or Chromium — report those upstream. If
  one materially affects this app, tell us which version and we will bump it.
- "The installer is unsigned" and the other limitations listed above. They are
  documented, not undiscovered.
- Anything requiring an attacker who already has code execution as the user.
