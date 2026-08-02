# Architecture — WinSCP Material

This is the contract every module in this repository is written against. Read it
before adding code; it is what keeps independently written modules fitting
together.

## Layout

```
design/                     the application (features are ported INTO this folder)
  main/                     Electron main process (Node, CommonJS)
    main.js                 app lifecycle, windows, Squirrel events, app menu
    squirrel.js             Squirrel.Windows install/update lifecycle
    paths.js                every on-disk location the app owns
    defaults.js             complete default configuration (sites + preferences)
    config.js               configuration store (atomic writes, revisions)
    crypto.js               credential protection + master password
    ipc.js                  the single IPC surface exposed to the renderer
    session.js              a connected session: adapter + state + log
    queue.js                transfer queue (parallel, pausable, throttled)
    sync.js                 synchronize + comparison checklist engine
    masks.js                WinSCP file-mask matching
    find.js                 recursive file search
    editors.js              internal/external editor manager
    customcmd.js            custom command expansion and execution
    logging.js              session log (normal/debug1/debug2) + actions XML
    history.js              git-backed version history (isomorphic-git)
    updates.js              update checks
    dimsum.js               dim sum catalog access
    protocols/
      base.js               THE adapter contract — read this first
      local.js  sftp.js  scp.js  ftp.js  webdav.js  s3.js
  preload/preload.js        contextBridge surface (no Node in the renderer)
  renderer/                 the Material 3 UI (ES modules, no bundler)
    index.html  app.js  state.js  i18n.js  theme.js
    ui/*.js                 components, panels, dialogs
  winscp-i18n.js            bilingual dictionary (EN + HK Cantonese, 5 levels)
  winscp-data.js            catalog/colour/mask helpers shared with the mockup
  WinSCP Material 3.dc.html the original Material 3 design mockup (reference)
docs/                       categorized feature documentation
site/                       Material 3 landing page + documentation site
```

## Process model

- `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`.
- The renderer never touches Node. Everything goes through `window.api`,
  defined in `design/preload/preload.js`.
- IPC channel names are namespaced: `session:*`, `fs:*`, `queue:*`, `config:*`,
  `sync:*`, `editor:*`, `history:*`, `app:*`.
- Every IPC handler returns `{ ok: true, value }` or `{ ok: false, error }`.
  Handlers never throw across the bridge.
- Long-running work pushes progress on `event:progress` with a correlation id;
  it never blocks the reply.

## The adapter contract

`design/main/protocols/base.js` defines `Adapter`. Every protocol backend
extends it. Key points:

- Paths inside an adapter are always POSIX-style, except `local.js`, which
  overrides `sep`, `normalize`, `join`, `dirname` and `basename` for Windows.
- `list()` returns objects built with `entry()` so every column the UI renders
  exists for every protocol.
- `caps` declares what the protocol supports. **The UI greys a command out
  based on `caps`; it never calls something the adapter cannot do.** Adding a
  capability means setting the flag and implementing the method — nothing else.
- Streaming (`createReadStream` / `createWriteStream`) is the transfer path.
  `readFile` / `writeFile` are conveniences for the editor and small files.

## Configuration

- One JSON file, written atomically (temp + rename).
- `defaults.js` is the single source of truth for what an option is and what it
  defaults to. Adding a preference means adding it there **and** surfacing it in
  the Preferences UI — an option with no UI is not shipped.
- Secrets never reach disk in clear. `crypto.js` wraps them with the OS
  keychain, or with a scrypt key derived from the master password when one is
  set. If neither is available, the secret is **not stored** rather than stored
  unprotected.

## Version history

- Every mutation of user-managed state (sites, folders, workspaces, settings)
  is offered to `history.js`, which commits a snapshot into a git repository
  kept beside the app's own data — never a `.git` inside a user folder.
- History is **append-only**: restoring an old revision writes a *new* revision,
  so an undo can itself be undone.
- A history write that fails must never fail the operation the user asked for.
- Revision labels name what changed ("Deleted the site X"), not that something
  changed.

## UI rules (these are shipping requirements, not polish)

- **Material Design 3** throughout — tokens, typography, shape, elevation,
  motion. No legacy chrome. Data-encoding colours are exempt.
- **Language modes**: English, playful Hong Kong Cantonese, and bilingual.
  Plus two independent funny-level sliders (1–5), one per language, wired to
  real rendered copy. The level changes voice, never facts.
- **Tabs**: browser-style, with overflow, reordering, pinning, grouping, and
  all four tab-discovery searches (strip, within group, groups by name, and a
  master search across every tab).
- **Search bars**: every one of them — including every settings surface — has
  the full regex builder anchored beside it. Plain text is the default; regex
  is an explicit opt-in.
- **Appearance**: every rendered element exposes "Edit appearance…" from its
  context menu, opening a non-modal editor anchored to that element, with
  Word-depth typography and an infinite colour picker + colour translator.
- **Notifications**: informational/success/progress and non-decision errors are
  corner toasts, never modal. Modals are reserved for decisions the user must
  make before continuing. A notification centre keeps the history.
- **Accessibility**: keyboard reachable, visible focus, correct roles/names/
  states, contrast, reduced-motion respected. Defects here are blockers.
- **Dim sum surprise**: a 10% chance per launch, non-blocking, auto-dismissing,
  never during first run or an error path, bundled local images only, and no
  opt-out setting.

## Testing

`npm test` runs `node --test test/`. Protocol adapters are tested against
in-process servers where practical and against the local backend otherwise;
pure logic (masks, sync comparison, colour maths, mask→regex, path handling) is
tested directly.
