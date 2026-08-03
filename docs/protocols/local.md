# The local filesystem backend

## What it does

`design/main/protocols/local.js` implements the same adapter contract against
the local machine. It exists so that the left-hand panel, the synchronizer, the
queue and the editor all use exactly one code path — "local" is a protocol like
any other, not a special case threaded through the application.

It is also the reference implementation used by tests: anything that can be
tested against a real filesystem is tested against this adapter rather than a
mock.

## Configuration

The local backend has no site options of its own. What affects it lives in the
application preferences (`PREF_DEFAULTS` in `design/main/defaults.js`):

| Option | Default | Meaning |
| --- | --- | --- |
| `showHiddenFiles` | `false` | Whether hidden and system files appear. |
| `panel.naturalOrderNumericalSorting` | `true` | `file2` sorts before `file10`. |
| `deleteToRecycleBin` | `true` | Local deletes go to the Recycle Bin. |
| `integration.localIconsFromExplorer` | `true` | Use Explorer's registered file-type icons. |
| `panel.viewStyle` | `report` | Icon, small icon, list, report or thumbnail. |
| `temporaryDirectory*` | see `paths.js` | Where downloaded-for-editing files land. |

## Windows path semantics

This is the one adapter that overrides all five path functions, and the reason
the rest of the codebase can assume POSIX:

- `sep` is `\`.
- `normalize` resolves `.`/`..`, collapses repeated separators, preserves drive
  letters and the `\\?\` and `\\server\share` prefixes, and refuses to normalize
  away a UNC root.
- `join`, `dirname`, `basename` follow Windows rules, including `C:` (the
  drive's current directory) being different from `C:\`.
- Case is preserved but comparison is case-insensitive, matching NTFS.

Three Windows behaviours that regularly surprise cross-platform code, and how
they are handled:

1. **Reserved device names** — `CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`,
   `LPT1`–`LPT9`, with or without an extension. Downloading a remote file called
   `nul.txt` cannot create that name. It is renamed via
   `invalidCharsReplacement` and the change is reported, not silent.
2. **Invalid characters** — `< > : " | ? *` and control bytes are legal on POSIX
   servers and illegal here. `replaceInvalidChars` (default `true`) substitutes
   them; disabling it makes the transfer fail loudly instead, including names
   with a trailing dot or space and reserved device names such as `CON.txt`.
3. **Trailing dots and spaces** — legal remotely, silently stripped by Windows.
   The adapter detects the mismatch after writing and reports it rather than
   leaving the user with a file whose name is not what they asked for.

## Failure modes

| Situation | What the user sees | Recoverable |
| --- | --- | --- |
| Path exceeds `MAX_PATH` (260) | The adapter uses the `\\?\` extended-length prefix internally, so ordinary deep paths work. If the long-path opt-in is unavailable, the failure names the path and its length. | Usually |
| File locked by another process | `EBUSY`/`EPERM`. The message names the operation; where the OS supplies it, the locking process is named too. | Yes |
| Insufficient permissions | `EACCES`, reported as a persistent toast with the full path. Elevation is never attempted silently. | Yes |
| Disk full mid-write | Partial file removed unless it is a resumable `.filepart`, in which case it is kept for resume. The error states which happened. | Yes |
| Recycle Bin unavailable (network drive, disabled) | Falls back to a permanent delete **only after** a confirmation that says so explicitly. | Yes |
| Removable media disappears mid-transfer | Queue item fails; the panel keeps its listing and shows a reconnect-style error. | Yes |
| Case-only rename (`readme.md` → `README.md`) | Handled through a two-step rename, because NTFS treats it as the same name. | Yes |

## Security considerations

- **The local adapter has the user's full authority.** Nothing here elevates,
  and nothing writes outside the target directory the user chose: every remote
  name is normalized and confined before it is joined to a local path, so a
  server sending `../../Windows/System32/x.dll` in a listing cannot escape.
- **Temporary files for editing** live under the app's own data tree (see
  `paths.js`), not in the user's folders. `temporaryDirectoryCleanup` removes
  them on exit; `keepTemporaryFiles` preserves them for debugging and warns that
  it is doing so.
- **The version-history repository is never created inside a user folder.** It
  lives beside the app's data — a `.git` appearing inside someone's documents
  would be both surprising and destructive.
- **Recycle Bin is not deletion.** A file "deleted" with `deleteToRecycleBin` is
  still readable by anyone with access to the profile. For sensitive material the
  confirmation offers a permanent delete.
- **Reparse points and junctions are not followed when deleting a tree.** A
  junction is removed as a link, never recursed into — the classic way a
  recursive delete escapes its directory.

## Verification

- Path normalization is unit-tested for drive-relative paths, UNC paths,
  extended-length prefixes, mixed separators and `..` escaping attempts.
- Reserved-name and invalid-character substitution is tested against the full
  reserved list with and without extensions.
- Confinement is tested with hostile remote filenames (`..`, absolute paths,
  drive letters, and encoded traversal).
- Because this adapter is the test substrate for the queue and the synchronizer,
  it also gets exercised indirectly by every test in those areas.

## Suggested articles

- [The adapter contract](adapter-contract.md) — the interface this implements, and the POSIX assumption it exists to preserve.
- [Synchronization](../synchronization/) — where local and remote listings meet.
- [Version history](../version-history/) — why the history repository lives where it does.
- [Editors](../editing-and-commands/editors.md) — what the temporary directory is for.
