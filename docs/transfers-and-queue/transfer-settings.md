# Transfer settings and presets

## What it does

A transfer's behaviour is described by one object — `COPY_PARAM_DEFAULTS` in
`design/main/defaults.js`, WinSCP's `TCopyParamType`. It travels with each queue
item, can be edited before a transfer starts, and can be saved as a **named
preset** so a routine job is one click rather than eight checkboxes.

## Configuration

Under **Transfer settings** (in any transfer dialog) and
**Preferences → Transfer**.

The dialog resolves the site/default settings and any supplied preset into a
private draft. Editing that draft does not change preferences or the pending
transfer; **Cancel** discards it, while **OK/Save** validates it before handing
the complete snapshot to the caller. Invalid permission strings, speed limits,
resume thresholds, enum values, or replacement characters are rejected with an
accessible alert. This preserves inherited values while making the edit
transaction explicit and prevents a partial or malformed snapshot from being
queued.

### Mode and naming

| Option | Default | Meaning |
| --- | --- | --- |
| `transferMode` | `binary` | `text` converts line endings, `binary` never does, `automatic` decides per file using `asciiFileMask`. |
| `asciiFileMask` | a long list of source and markup extensions | Which files count as text in `automatic` mode. |
| `fileNameCase` | `noChange` | `upper`, `lower`, `firstUpper`. |
| `replaceInvalidChars` | `true` | Substitute characters Windows cannot store. |
| `invalidCharsReplacement` | `_` | What to substitute. |
| `removeBOM` | `false` | Strip a UTF-8 byte-order mark. |
| `removeCtrlZ` | `false` | Strip a trailing DOS EOF byte. |

### Metadata

| Option | Default | Meaning |
| --- | --- | --- |
| `preserveTime` | `true` | Copy the modification timestamp. |
| `preserveTimeDirs` | `false` | Also for directories — which requires setting them after their contents. |
| `preserveRights` | `false` | Apply `rights` to uploaded files. |
| `rights` | `rw-r--r--` | The permission string used when `preserveRights` is on. |
| `addXToDirectories` | `true` | Directories get `x` wherever `r` is set; without it, a directory you can read but not enter. |
| `preserveReadOnly` | `false` | Carry the read-only attribute across when enabled. |
| `ignorePermErrors` | `false` | Downgrade a failed `chmod` to a warning. |
| `clearArchive` | `false` | Clear the Windows archive bit after a successful upload. |

### Selection

| Option | Default | Meaning |
| --- | --- | --- |
| `includeFileMask` | `''` | The [file mask](../editing-and-commands/file-masks.md) filtering the transfer. |
| `newerOnly` | `false` | Skip files not newer than the target. |
| `excludeHiddenFiles` | `false` | Skip hidden files. |
| `excludeEmptyDirectories` | `false` | Do not create directories that end up empty. "Empty" is recursive and filter-aware: a directory holding only masked-out files, only hidden files while `excludeHiddenFiles` is on, or only other empty directories counts as empty too. A directory that cannot be listed counts as **not** empty, so an unreadable folder is still copied rather than silently dropped. |
| `followDirectorySymlinks` | `false` | Recurse into symlinked directories. Off by default — link loops are how a recursive copy never finishes. |

### Completion and pacing

| Option | Default | Meaning |
| --- | --- | --- |
| `cpsLimit` | `0` | Bytes per second, `0` = unlimited. See [speed limits](speed-limits.md). |
| `calculateSize` | `true` | Measure the total before starting, so progress is a percentage rather than a byte count. |
| `onceDoneOperation` | `none` | `disconnect`, `suspend`, `shutdown` when this transfer finishes. |
| `resumeSupport`, `resumeThreshold`, `partialFileExt`, `overwriteMode` | see [resume](resume.md) | |
| `encryptNewFiles` | `true` | Apply the site's at-rest encryption to newly uploaded files. |
| `saveTransferOptions` | `false` | Make the current settings the new default after this transfer. This is a one-shot command instruction: after saving, the checkbox is cleared in the stored defaults so later transfers do not keep rewriting their settings. |

## Presets

`copyParamList` holds named presets; `copyParamCurrent` names the active one.
A click or keyboard selection in the Preferences preset list writes that name
to `copyParamCurrent`, so the next transfer starts from the same preset after a
restart. If the active preset is deleted or renamed, the list and selection are
saved as one atomic preference update. The setting is cleared rather than
referring to a missing record; a failed store update also restores the
in-memory list cache.
A preset can carry an **auto-select rule** — a file mask plus a direction — so
choosing "Text files, upload" happens automatically for `*.php` uploads.
`copyParamAutoSelectNotice` (default `true`) makes the app say when a preset was
auto-selected, because a silently changed transfer mode is a very confusing bug
report.

Presets are ordinary user-managed records, so they are covered by
[version history](../version-history/): deleting one by mistake is undoable.

## Failure modes

| Situation | What the user sees | Recoverable |
| --- | --- | --- |
| `automatic` picks text mode for a binary file | The file is corrupted by line-ending conversion — the single most damaging misconfiguration here. Extensions not in `asciiFileMask` default to binary, and a mismatch between extension and content is reported when detected. | Yes, re-transfer in binary |
| A directly selected file does not match `includeFileMask` | It is omitted before the queue opens a destination. Directory children and directly selected files use the same mask predicate as the foreground transfer path. | Yes, remove or correct the mask |
| `preserveRights` on a protocol without permissions | The option is greyed out; `caps.permissions` decides. | n/a |
| `preserveTimeDirs` on a protocol that cannot set directory times | Silently skipped for directories, reported once per transfer rather than per directory. | n/a |
| `fileNameCase` collides two names | The second transfer hits the overwrite rule. The confirmation names the case change as the cause. | Yes |
| Symlink loop with `followDirectorySymlinks` on | Depth-bounded; the transfer stops and names the loop. | Yes |
| `onceDoneOperation: shutdown` and the transfer fails | The action does not run. | n/a |
| Cancellation arrives after overwrite planning but before the byte mover starts | The transfer exits as cancelled without opening a write or creating a target. | Yes, start it again |

## Security considerations

- **`preserveRights` with a permissive `rights` string can publish a file.**
  Uploading with `rw-rw-rw-` to a web root makes it world-writable. The rights
  editor shows the resulting octal and warns on world-writable combinations.
- **`addXToDirectories` is convenience, not policy** — it does exactly what it
  says and can widen directory access beyond what the user pictured.
- **`ignorePermErrors` hides a real failure.** A transfer that "succeeded" with
  wrong permissions is worse than one that failed. The option is off by default
  and the summary still counts the ignored errors.
- **`clearArchive` mutates local files.** It is a write to the source, which is
  surprising in a copy operation; the option says so.
- **`encryptNewFiles` inherits the site's key.** If no key is configured the
  option has no effect, and the UI does not imply otherwise — a false sense of
  encryption is worse than none.

## Verification

- `automatic` mode selection is tested across the default `asciiFileMask` and a
  corpus of extensions, including multi-dot names and extensionless files.
- Name-case transformation, invalid-character substitution and reserved-name
  handling are tested together, because they interact.
- Preset auto-selection is tested for direction, mask precedence and the notice.
- Permission-string parsing and octal rendering are tested against the full
  range, including the setuid/setgid/sticky bits.

## Suggested articles

- [The queue](queue.md) — where a settings snapshot is taken.
- [Resume](resume.md) — the four options this article deferred.
- [File masks](../editing-and-commands/file-masks.md) — the `includeFileMask` language.
- [At-rest encryption](../security-and-credentials/file-encryption.md) — what `encryptNewFiles` connects to.
