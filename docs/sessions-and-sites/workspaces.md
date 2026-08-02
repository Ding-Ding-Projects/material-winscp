# Workspaces

## What it does

A workspace is a saved set of open sessions with their directories, panel
layout, tab order, tab groups and pinned state. Opening one restores the whole
arrangement instead of five sites one at a time.

## Configuration

Stored under `PREF_DEFAULTS.window`, plus the workspace records themselves.

| Option | Default | Meaning |
| --- | --- | --- |
| `autoSaveWorkspace` | `false` | Save the current arrangement automatically on exit. |
| `autoSaveWorkspacePasswords` | `false` | Include session passwords so restoring reconnects unattended. |
| `autoWorkspace` | `''` | Which workspace the automatic save writes to. |

A workspace records, per session: the site it came from, the local and remote
directories, panel widths, sort order, the active filter, and the session's
place in the [tab structure](../tabs-and-navigation/) — order, pinned state,
group membership and whether that group was collapsed.

Workspaces appear beside sites in the site manager, with their own search. They
are ordinary user-managed records, so creating, renaming and deleting one is
covered by [version history](../version-history/).

## Failure modes

| Situation | What the user sees | Recoverable |
| --- | --- | --- |
| A site in the workspace has been deleted | That session is skipped; the summary names it. The rest still opens. | Yes |
| A remote directory no longer exists | The session opens at the server's default directory and says why it did not land where expected. | Yes |
| A local directory no longer exists (an unmounted drive) | The panel opens at the nearest existing ancestor, with a note. | Yes |
| Several sessions need passwords and none are saved | Prompts appear one at a time, in tab order, each naming its site. They are not stacked. | Yes |
| Restoring while sessions are already open | A choice: add to the current window, or replace. Replacing is confirmed and reports how many sessions would close. | Yes |
| A connection fails during restore | Its tab opens disconnected with a Reconnect action, rather than being dropped. Partial restore is visible, not silent. | Yes |
| Auto-save on a crash | Nothing is saved — auto-save runs on clean exit. The tab structure itself is persisted separately and does survive. | Partially |

## Security considerations

- **`autoSaveWorkspacePasswords` writes credentials to disk on every exit.** It
  is off by default. When enabled, the same protection as any saved password
  applies: OS keychain or master-password-derived key, or not stored at all. The
  option's help states that it means unattended reconnection to every site in the
  workspace.
- **A workspace is a map of your infrastructure.** Names, hosts, usernames and
  paths in one record. Exports of it are as sensitive as the site export.
- **Restoring connects to everything at once.** For a workspace containing
  production sites that is a lot of simultaneous authentication; the colour tags
  from the site manager carry through to the restored tabs so it stays obvious
  what is open.
- **A workspace does not store file contents**, only locations.

## Verification

- Save/restore round trips are tested for directories, panel geometry, tab
  order, pinned state, group membership and collapsed state.
- Missing-site and missing-directory handling are tested by deleting each
  between save and restore.
- Password inclusion is tested to confirm that with the option off, no credential
  appears anywhere in the stored record.
- Restore-with-failures is tested to assert failed sessions produce disconnected
  tabs rather than being dropped.

## Suggested articles

- [The site manager](site-manager.md) — where workspaces live alongside sites.
- [Tabs and navigation](../tabs-and-navigation/) — the structure a workspace preserves.
- [Reconnection](reconnection.md) — what happens after a restored session drops.
- [Version history](../version-history/) — undoing a deleted workspace.
