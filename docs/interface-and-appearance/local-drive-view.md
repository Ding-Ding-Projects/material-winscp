# Local drive tree

The Commander local panel's DriveView is a real, keyboard-navigable tree. It
lists the host's available drive roots, follows the panel when the address bar
changes, and reads directory children through the same local filesystem bridge
as the file list.

## Root and UNC behaviour

Windows drive roots (`C:\\`) and UNC server/share roots
(`\\\\server\\share`) are both tree roots. Moving to `..` from either root
does not manufacture an invalid parent such as `\\server`; the panel remains
at the root. A UNC path opened from the address bar gets a temporary tree root
when the operating system's drive enumeration does not list that share, so the
tree can expand and reveal the current directory instead of silently staying
on the drive list.

Long UNC spellings (`\\\\?\\UNC\\server\\share\\...`) and slash-separated
UNC input are normalized to the same canonical tree path.

Windows tree-cache and selection lookups are case-insensitive. A refresh that
changes only the casing of a directory name therefore updates the existing
node instead of creating a duplicate or losing the selected path.

## Accessibility and refresh

The tree exposes `role="tree"` and `role="treeitem"` semantics, visible focus,
Arrow/Home/End navigation, Enter/Space activation and F5 refresh. Refreshing a
UNC tree retains the current path and reconstructs its synthetic share root
before expanding the path again.

## Security and failure modes

The renderer does not enumerate the filesystem itself. It requests drive and
directory data through the preload bridge; errors remain in the tree status
area and do not turn a failed directory read into a guessed navigation.
Synthetic roots are only created for the current UNC path and are not a way to
bypass filesystem permissions.

## Verification

`test/driveview.test.js` covers drive-root boundaries, UNC parent handling,
long-path normalization and slash normalization. The full renderer smoke is
still environment-dependent for UNC shares: this repository does not assume a
particular network server or share exists on the test host.

The case-insensitive refresh/selection regression is covered by
`test/dirview.test.js`.

## Commander drag/drop selection

An internal Commander drag carries the absolute paths selected when the drag
starts. The drop handler resolves those paths against the source panel rather
than reading whatever selection happens to be visible when the pointer is
released. This prevents a selection change during a drag from transferring a
different file. Local Windows paths are matched with slash and case
normalization; remote paths remain case-sensitive.

The focused regression is in `test/scp-commander-parity.test.js`.
