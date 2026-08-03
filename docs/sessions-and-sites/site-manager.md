# The site manager

## What it does

Stores connections. Each site holds everything in `SESSION_DEFAULTS`
(`design/main/defaults.js`) — protocol, endpoint, identity, every advanced
option — plus presentation: a name, a folder, a colour tag and a note.

The site list is searchable, foldered, importable and exportable, and every
change to it is recorded in version history.

## Configuration

### Identity and presentation

| Field | Default | Meaning |
| --- | --- | --- |
| `name` | `''` | Display name. Blank means the site is shown as `user@host`. |
| `folder` | `''` | Folder path; `''` is the root. Folders nest. |
| `color` | `''` | Colour tag, applied to the session tab and the panel caption. |
| `note` | `''` | Free text. The place to record who owns the server. |

**Colour tags are a safety feature.** Tagging production red and staging green
is the cheapest available defence against running a Mirror-with-delete against
the wrong host, and the tag follows the session into its tab and panel caption.

### Credentials

| Field | Default | Meaning |
| --- | --- | --- |
| `userName` | `''` | |
| `password` | `''` | Stored encrypted or not at all — see [credential storage](../security-and-credentials/credential-storage.md). |
| `savePassword` | `false` | Whether to store it. |
| `anonymous` | `false` | FTP anonymous login. |
| `publicKeyFile`, `passphrase` | `''` | SSH key and its passphrase. |

### Operations

| Operation | Notes |
| --- | --- |
| New / Edit / Duplicate / Rename / Delete | A saved site opens as a read-only view first; Edit in Manage or the dialog action row unlocks its fields. Deletion asks once and is undoable from history. |
| Clone to new site | Copies everything except the name. |
| Set defaults | Makes this site's advanced options the default for new sites. |
| New folder | Folders are ordinary records; moving a site between them is a drag or a keyboard move. |
| Import sites | From WinSCP INI and from this app's JSON export. |
| Import/Restore configuration, Export/Backup configuration | Whole-configuration round trip. |
| Generate session URL/code | See below. |
| Paste session URL | Fills a new site from a URL. |
| Edit raw settings | A key/value editor for anything without a dedicated control. |

### Session URLs

`Generate session URL/code` produces a shareable description of a connection:

```
sftp://user@example.com:2222/srv/www/
```

**Passwords are never included by default.** The generator shows exactly what
will be produced before it is copied, and including a credential is a separate,
explicitly-labelled choice — because the overwhelmingly common use of this
button is pasting into a chat window.

### Search

The site list has a search bar with the [regex builder](../search-and-regex/regex-builder.md)
anchored beside it, searching names, hosts, usernames, folders and notes. Plain
text is the default; regex is an explicit opt-in.

## Failure modes

| Situation | What the user sees | Recoverable |
| --- | --- | --- |
| Two sites with the same name in one folder | Refused, naming the existing site. Names are unique per folder, not globally. | Yes |
| Import contains a site that already exists | A per-site choice: skip, replace, or keep both with a suffix. Never a silent replace. | Yes |
| Import from a WinSCP INI with registry-stored passwords | The site imports without the password, and the summary says how many credentials could not be carried over. It does not pretend they came across. | Yes |
| Config file corrupted or truncated | Atomic writes make this unlikely. If it happens, the app starts with defaults, keeps the damaged file next to the good path, and says where it is. Nothing is overwritten. | Usually |
| A site references a key file that has moved | Connection fails naming the missing path. The site is not modified. | Yes |
| Deleting a folder containing sites | The confirmation counts the sites, and history records the whole subtree so one undo restores it. | Yes |
| Export written to a shared location | Not prevented — but the export dialog states whether the file contains credentials. | n/a |

## Security considerations

- **A saved password is encrypted or absent.** `crypto.js` wraps it with the OS
  keychain, or with a scrypt key derived from the master password. If neither is
  available the password is **not stored** rather than stored unprotected — the
  site simply asks each time.
- **Export can contain secrets. Import can carry them in.** The export dialog
  says which, and offers to exclude credentials. An exported file with
  credentials is as sensitive as the passwords in it.
- **Session URLs are for sharing and therefore default to safe.** No password
  unless explicitly added, and the preview shows the exact string first.
- **Notes are plain text and are not encrypted.** The field's help says so, so
  nobody stores a password there believing otherwise.
- **`setDefaults` propagates security-relevant options** — cipher order, host key
  policy — to every future site. The confirmation lists what is changing.
- **Colour tags are advisory**, not enforcement. They do not restrict any
  operation; they make the wrong one visible.

## Verification

- Round-tripping the whole configuration through export and import is tested for
  fidelity, including nested folders and every advanced option.
- WinSCP INI import is tested against real exported INI files covering all five
  protocols.
- Session URL generation and parsing are tested for escaping of usernames,
  passwords, ports, IPv6 literals and paths with spaces — and for the default
  omission of credentials.
- Name-uniqueness and folder-move semantics are tested directly.
- Every mutation is asserted to produce exactly one history revision, with a
  label naming what changed.

## Suggested articles

- [Workspaces](workspaces.md) — restoring several of these at once.
- [Credential storage](../security-and-credentials/credential-storage.md) — where a saved password actually goes.
- [Version history](../version-history/) — the undo behind every edit here.
- [The regex builder](../search-and-regex/regex-builder.md) — the builder on the site search bar.
