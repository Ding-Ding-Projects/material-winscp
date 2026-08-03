# Preferences: consumer audit and unavailable capabilities

## Keyboard navigation

The page tree is fully keyboard reachable. With focus on a page, `Arrow Up` and
`Arrow Down` move between visible pages (wrapping at either end); `Home` and
`End` jump to the first and last visible page. The selected page is exposed to
assistive technology with `aria-current="page"` as well as the tree selection
state. Filtering changes the visible set, so keyboard movement always stays
inside the current search results.

The Preferences dialog is generated from [`prefpages.js`](../../design/renderer/ui/dialogs/prefpages.js): 206 declared controls cover 207 persisted paths, including the compatibility companion for double-click behaviour, and every control points at a real path in [`defaults.js`](../../design/main/defaults.js). A normal edit goes through the real preload bridge:

```text
Preferences control
  -> renderer prefs.set()
  -> config:setPref
  -> Config.setPref() and atomic persistence
  -> pref-changed / event:config
  -> live renderer or main-process consumer
```

When a control is disabled because its prerequisite is off, the preference row
also exposes `aria-disabled="true"`, not just the native input. This keeps
composite editors and screen-reader navigation honest about the same
dependency state that the visual row shows.

The renderer smoke test opens the actual dialog, checks both search bars and
their regex-builder buttons, changes `queue.noConfirmations` and
`refreshRemotePanelInterval`, and proves the already-running queue changes its
prompt behaviour. It also proves that an unavailable setting cannot be edited
through a synthetic change event.

Revert captures every persisted path behind a control, including companion
`alsoKeys`. This matters for controls with one visible value that writes more
than one configuration key: reverting restores the visible setting and its
companion together, rather than leaving the stored configuration inconsistent.

Failed writes are transactional from the dialog’s point of view. The cached
value is restored when `config:setPref` rejects, including when the original
key was absent, so the screen never claims a value was saved when durable
configuration refused it.

The all-pages search keeps matching descendants reachable by retaining their
parent pages in the navigation tree. Selecting one of those pages exits the
results view and opens the page. Tree parents expose their expanded state and
the navigation uses a roving tab stop for keyboard and screen-reader users.

## Consumer ledger

The consumer guard is production-only: it scans `design/` outside the
Preferences surface, strips comments and strings, and compares every control
with `PENDING_KEYS`. A control with a real consumer must not appear in the
pending list; a control without one must appear there.

### Wired settings from the issue audit

| Preference | Live consumer | Behaviour verified |
| --- | --- | --- |
| `beepOnFinish` | `design/main/queue.js` → `beep`; `design/main/ipc.js` → `shell.beep()` | Queue completion decides whether to emit the beep event. |
| `beepOnFinishAfter` | `design/main/queue.js` → `_beepIfDue()` | The configured minimum duration is compared with the whole queue batch. |
| `dDAllowMove` | `design/renderer/ui/panels.js` → panel drag/drop | Move effects are offered only when this persisted preference is enabled; otherwise the drop remains a copy. |
| `dDAllowMoveInit` | `design/renderer/ui/panels.js` → panel drag/drop | Starts an allowed drag as move by default; Ctrl still requests a copy. |
| `queue.keepDoneItemsFor` | `design/main/queue.js` → `pruneDoneItems()` | Completed rows are swept according to `0`, positive seconds, or `-1`. |
| `tabs.truncateTitles` | `design/renderer/ui/tabs.js` → tab strip class and `components.css` | Tab labels use ellipsis by default and retain their full text when truncation is disabled; changes apply live. |
| `showInaccessibleDirectories` | `design/main/dirview.js`, `design/main/guitools.js`, `design/main/ipc.js` | The file lists and traversal code now read the correctly spelled key, so inaccessible directories obey the toggle. |
| `refreshRemotePanelInterval` | `design/renderer/ui/panels.js` | Refreshes the attached remote panel at the configured interval; `0` disables it. |
| `window.openedTabsShortcut` | `design/renderer/ui/commands.js` → `OpenedTabsAction` | `Ctrl+Shift+Tab` opens the all-tabs search when enabled; disabling the preference removes the command from shortcut execution while leaving the tabs action available through menus. |
| `window.sessionTabCaptionTruncation` | `design/renderer/ui/tabs.js` | Disables session-tab title truncation when false; `tabs.truncateTitles` remains an additional global gate. |

The real-Electron regression changes another live queue preference through the
Preferences surface: `queue.noConfirmations` is persisted by `config:setPref`
and changes overwrite prompting without restarting the queue.

### Stored but unavailable in this build

These values are retained for imported configurations and reset/history
visibility, but no production module reads them. Their controls are rendered
read-only, carry `data-pref-status="unavailable"` and `aria-disabled="true"`,
and show the same English/Cantonese explanation. They are not presented as
successful settings.

| Preference | Consumer |
| --- | --- |
| `copyParam.saveTransferOptions` | None |
| `dDDrives` | None |
| `dDFakeFile` | None |
| `editor.autoFont` | None |
| `editor.disableSmoothScroll` | None |
| `editor.fontCharset` | None |
| `editor.fontName` | None |
| `editor.sDIShellEditor` | None |
| `editor.warnOnEncodingFallback` | None |
| `editor.warnOrphans` | None |
| `integration.autoOpenInPutty` | None |
| `integration.dragExtEnabled` | None |
| `integration.localIconsFromExplorer` | None |
| `logging.logWindowComplete` | None |
| `panel.showFullPathOnAddressBar` | None |
| `queue.disconnectOnceEmpty` | None |
| `queue.individualTransfers` | None |
| `queue.parallelDuplicateTransfers` | None |
| `security.randomSeedFile` | None |
| `security.sessionReopenAutoStall` | None |
| `timeoutOnStartup` | None |
| `updates.authenticationEmail` | None |
| `versionHistory.snapshotSettings` | None |
| `versionHistory.snapshotSites` | None |
| `window.largeToolbarIcons` | None |
| `window.minimizeToTray` | None |

`refreshRemotePanelInterval`, `window.openedTabsShortcut`, and
`window.sessionTabCaptionTruncation` are wired settings, so they belong in the
consumer ledger above rather than in this unavailable table. The audit test
keeps this distinction tied to production reads; a stored value is not called
ported merely because the Preferences page can save it.

## Verification

- `node --test test/preferences.test.js` checks schema/default parity, the
  production consumer set, bilingual pending copy, search, regex mode and
  transfer-setting coverage.
- `node --test test/e2e-app.test.js` drives the real Electron renderer and main
  process, including persistence and live queue prompting.
- `npm test` is the required full regression suite before integration.

Numeric controls have one persistence validation seam. Number fields normalize
on change and sliders commit on every input, but both paths pass through the
Preferences writer, which rejects non-finite values and clamps the UI value to
the declared range before writing the stored (scaled, when applicable) value.
An imported numeric value outside that range is shown as the declared default
with an explicit invalid-value note until the user chooses a replacement; it is
not silently rewritten on load. Boolean, enum, text and list controls apply the
same honest-fallback rule to malformed imported values, so a string such as
`"false"` cannot render as an enabled checkbox.

Text constraints are enforced at the same seam. Schema `pattern` and
`maxLength` rules are applied both when an imported value is displayed and when
the user changes a field; invalid edits are marked `aria-invalid` and are not
written. This includes transfer permissions and temporary-file extensions.

## Security and accessibility

Pending values are not secrets and remain subject to the normal atomic config
write and history rules. The unavailable note is attached to the control via
`aria-describedby`; disabling the native input prevents keyboard and pointer
activation while preserving the imported value. Preferences search remains
plain-text-first and every search bar retains its anchored full regex builder.

Suggested related articles: [Search and regex](../search-and-regex/),
[Accessibility and languages](../accessibility-and-languages/), and
[Version history](../version-history/).
