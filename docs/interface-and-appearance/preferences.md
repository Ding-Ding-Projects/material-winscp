# Preferences: consumer audit and unavailable capabilities

## Keyboard navigation

The page tree is fully keyboard reachable. With focus on a page, `Arrow Up` and
`Arrow Down` move between visible pages (wrapping at either end); `Home` and
`End` jump to the first and last visible page. The selected page is exposed to
assistive technology with `aria-current="page"` as well as the tree selection
state. Filtering changes the visible set, so keyboard movement always stays
inside the current search results.

The Preferences dialog is generated from [`prefpages.js`](../../design/renderer/ui/dialogs/prefpages.js), and every control points at a real path in [`defaults.js`](../../design/main/defaults.js). A normal edit goes through the real preload bridge:

```text
Preferences control
  -> renderer prefs.set()
  -> config:setPref
  -> Config.setPref() and atomic persistence
  -> pref-changed / event:config
  -> live renderer or main-process consumer
```

The renderer smoke test opens the actual dialog, checks both search bars and
their regex-builder buttons, changes `queue.noConfirmations` and
`refreshRemotePanelInterval`, and proves the already-running queue changes its
prompt behaviour. It also proves that an unavailable setting cannot be edited
through a synthetic change event.

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
| `queue.keepDoneItemsFor` | `design/main/queue.js` → `pruneDoneItems()` | Completed rows are swept according to `0`, positive seconds, or `-1`. |
| `tabs.truncateTitles` | `design/renderer/ui/tabs.js` → tab strip class and `components.css` | Tab labels use ellipsis by default and retain their full text when truncation is disabled; changes apply live. |

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
| `dDAllowMove` | None |
| `dDAllowMoveInit` | None |
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
| `refreshRemotePanelInterval` | `design/renderer/ui/panels.js` — refreshes the attached remote panel at the configured interval; `0` disables it. |
| `security.randomSeedFile` | None |
| `security.sessionReopenAutoStall` | None |
| `showInaccessibleDirectories` | None |
| `timeoutOnStartup` | None |
| `updates.authenticationEmail` | None |
| `versionHistory.snapshotSettings` | None |
| `versionHistory.snapshotSites` | None |
| `window.largeToolbarIcons` | None |
| `window.minimizeToTray` | None |
| `window.openedTabsShortcut` | None |
| `window.sessionTabCaptionTruncation` | None |

## Verification

- `node --test test/preferences.test.js` checks schema/default parity, the
  production consumer set, bilingual pending copy, search, regex mode and
  transfer-setting coverage.
- `node --test test/e2e-app.test.js` drives the real Electron renderer and main
  process, including persistence and live queue prompting.
- `npm test` is the required full regression suite before integration.

## Security and accessibility

Pending values are not secrets and remain subject to the normal atomic config
write and history rules. The unavailable note is attached to the control via
`aria-describedby`; disabling the native input prevents keyboard and pointer
activation while preserving the imported value. Preferences search remains
plain-text-first and every search bar retains its anchored full regex builder.

Suggested related articles: [Search and regex](../search-and-regex/),
[Accessibility and languages](../accessibility-and-languages/), and
[Version history](../version-history/).
