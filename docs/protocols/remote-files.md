# Remote file model

`design/main/remotefiles.js` is the shared model behind remote listings,
properties, synchronization rows and protocol-specific directory views. It is
not a second protocol adapter: adapters supply listing data, and this model
keeps the display and safety rules consistent.

## Listing contract

Every row preserves the server's file type, name, size, modification precision,
owner, group and permission text. A directory's reported allocation is kept for
the raw listing, but its public `size` is zero: recursive size is unknown until
the transfer or panel walk calculates `calculatedSize`. A file list's
`totalSize` therefore counts regular files and does not mistake directory
metadata or the `..` navigation row for payload bytes. Empty directories are
represented by no content rows; a visible `..` row is navigation, not content.
Rows with no file name are rejected as malformed, and duplicate names are
rejected so an ambiguous path is never exposed as a selectable transfer target.
Symlink rows must contain a non-empty target after ` -> `; a dangling listing
row with an empty target is rejected rather than exposed as a link to nowhere.
Remote rows also expose the WinSCP-compatible `isSymlink` and `partial` aliases
used by the directory view; both are derived from the canonical `isSymLink`
and `.filepart` state, including numbered and case-insensitive suffixes.

Permission columns support full POSIX modes, setuid/setgid/sticky bits,
Windows OpenSSH's `*` unset marker and partially-known selections. Owner and
group tokens retain either a display name or a numeric id, and mixed selections
invalidate only the field that actually disagrees. Unknown permission data is
shown as supplied rather than rewritten into a guessed mode.

## Paths and names

Remote paths use `/`, including VMS-style names and FTP-on-Windows paths such
as `C:/incoming/report.txt`. `C:/` is absolute and remains a drive root when
trailing separators are normalized. Relative paths collapse `.` and `..` at
the server root. Common-path extraction uses a remote file's full path rather
than its basename, including selections cloned from a listing.

VMS revision suffixes such as `REPORT.TXT;3` are retained unless the session's
trim option is enabled. Single-character VMS names such as `A;1` are valid
revisions too. The FTP parser separately converts VMS allocation blocks to
bytes and treats `.DIR` records as directories.

## Symlink and refresh safety

When symlink resolution is enabled, a resolver must return a `TRemoteFile`.
Refusals, exceptions, malformed results and cycles leave the link unresolved
and mark it broken; they do not turn an invalid object into a navigable file.
Resolution is disabled by the session when the protocol cannot safely follow a
link. Cycle detection compares canonical targets: relative targets are resolved
against the link's containing directory, so alternate spellings such as
`../shared` and `/home/shared` cannot evade the loop guard. A link to a
directory is a directory only after a real target row has been resolved.

Refreshing a directory detaches every old row and forgets its cached parent
entry. This prevents a removed row from continuing to manufacture a full path
through a stale directory object, and prevents a hidden `..` row from leaking
into the next listing.

## Directory-entry execution

The production-loaded directory-view model exposes the `ExecuteFile` decision
as `resolveExecuteFile(item, { action })`. A directory (including the synthetic
parent row) resolves to `changeDir` only when the configured action is
`changeDir`; files resolve to `open` so an enter action cannot accidentally
navigate through a regular file. A missing item resolves to `noop`. The model
returns the original entry for the caller to focus before it opens the item.

## Failure modes and security

- A malformed or refused listing line raises `ListLineError`; it is never
  guessed into a file that could be transferred accidentally.
- Unknown permissions do not grant ownership or access. The directory view
  stays conservative when it cannot establish that the logged-in user may
  enter a directory.
- Symlink resolution is bounded by cycle detection and reports broken links;
  it never follows an untrusted resolver object.
- File names and link targets remain server data. They are not interpreted as
  shell commands by this model.

## Verification

`test/remotefiles.test.js` covers Unix and drive-qualified path forms, common
paths from local and cloned remote selections, Unix listing dialects,
permissions and owner/group metadata, VMS revision names, symlink refusal,
canonical relative/absolute cycle handling, recursive-size sentinels,
empty-directory parent semantics,
and refresh detachment. Run:

```text
node --test --test-timeout=120000 test/remotefiles.test.js
```
