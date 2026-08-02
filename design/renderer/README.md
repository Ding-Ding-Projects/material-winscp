# design/renderer — conventions

This is the contract for the Material 3 renderer. Read it before adding a
module here; it is what lets independently written UI modules fit together.
`docs/architecture.md` is still the authority on the process model and the
`window.api` bridge — this file only describes the renderer's own shape.

Everything is **native ES modules**. There is no bundler, no build step and no
transpile: `index.html` loads `./app.js` with `<script type="module">` and the
browser resolves the rest. Use relative specifiers with the `.js` extension.

**Nothing may reach the network.** No CDN fonts, scripts, stylesheets or
images, no `fetch`, no analytics. The CSP in `index.html` enforces it
(`connect-src 'none'`). Icons are local SVG geometry, fonts are the platform's
own, and images come from `design/assets` through main.

---

## Files

| File | Owns |
| --- | --- |
| `index.html` | the document, the CSP, the two stylesheets, the skip link |
| `app.js` | boot order, title bar, tab strip, status bar, **the registries** |
| `state.js` | the event bus, the store, the `window.api` façade, persistence |
| `theme.js` | M3 token engine (HCT tonal palettes), runtime theming |
| `i18n.js` | three language modes, two funny-level sliders, live binding |
| `dom.js` | `h()`, icons, anchored positioning, focus, live region, modal |
| `ui/tabs.js` | tab strip, groups, pinning, four searches, bulk close |
| `ui/searchbar.js` | **the** search bar every surface must use |
| `ui/regexbuilder.js` | the anchored regex builder + the shared match predicate |
| `ui/colorpicker.js` | infinite colour picker + colour translator |
| `ui/appearance.js` | per-element appearance editor |
| `ui/contextmenu.js` | the M3 menu system, menus and menu buttons |
| `ui/notifications.js` | corner toasts + notification centre |
| `ui/dimsum.js` | the startup surprise |
| `styles/tokens.css` | reset, token floor, type scale, density, motion, utilities |
| `styles/components.css` | component anatomy |

Modules still to be written by other agents: `ui/panels.js`, `ui/dialogs.js`,
`ui/preferences.js`, `ui/queue.js`, `ui/log.js`, `ui/changelog.js`,
`ui/history.js`. Everything they need is exported from `app.js`.

---

## Module pattern

A UI module is a plain ES module exporting **factory functions**, not classes
and not singletons. A factory takes an options object and returns a handle:

```js
export function createThing(opts = {}) {
  const root = h('div', { class: 'thing' });
  // …
  return {
    element: root,          // always: the module never appends itself
    destroy() { … },        // always: remove listeners, subscriptions, DOM
    // module-specific methods
  };
}
```

Rules:

* **The caller decides where the element goes.** A factory never appends to
  `document.body` — except floating surfaces, which go through `layer(kind)`.
* **Everything returns `destroy()`** and it must be idempotent.
* **Build DOM with `h()`**, never `innerHTML`. `h()` is safe by construction:
  it has no HTML-string path, so no module can accidentally inject markup from
  a file name, a host name or a server response.
* **`start*()` functions are idempotent** and called once by `app.js`
  (`startThemeEngine`, `startI18n`, `startNotifications`, `startAppearance`,
  `installContextMenus`).

---

## The event bus

`state.js` exports `bus` — `on(type, fn) -> off`, `once`, `emit(type, payload)`.
A thrown listener is logged and never breaks the emitter.

Events the shell emits (subscribe freely; do not re-emit them):

| Event | Payload |
| --- | --- |
| `shell:ready` | `{ strip }` — the app is interactive |
| `shell:viewRegistered` | view id |
| `config:loaded` | the merged store state |
| `config:document` | main's whole config document (`prefs`, `sites`, …) |
| `config:saved` / `config:saveFailed` / `config:loadFailed` | patch / `{ error }` |
| `state:changed` | `{ path, value, prev, meta }` |
| `theme:applied` | `{ theme, dark, scheme }` |
| `i18n:changed` | `{ language, funnyLevel }` |
| `tabs:opened` / `tabs:activated` / `tabs:closed` | `{ stripId, tab \| tabId }` |
| `tabs:groupCreated` | `{ stripId, group }` |
| `appearance:open` | `{ key, element, label }` — opens the editor |
| `appearance:applied` | `{ count }` |
| `notifications:changed` / `notifications:dismissed` | counts / `{ id, reason }` |
| `dimsum:shown` / `dimsum:skipped` | `{ dish }` / `{ reason }` |
| `menu:selected` | `{ id, label }` |

Namespace your own events `yourmodule:thing`.

---

## State

```js
import { store, persistCurrent, session } from './state.js';

store.get('theme.mode');                    // read at a dot path
store.set('theme.mode', 'dark');            // write; notifies matching subs
store.patch({ tabs: { … } });               // deep-merge at the root
store.batch(() => { … });                   // several writes, one notification
const off = store.subscribe('theme', fn);   // fires immediately by default
```

`store` holds **persisted user configuration only**. The persisted roots are
`theme`, `language`, `funnyLevel`, `disclosureAccepted`, `notifications`,
`tabs`, `search`, `dimSum`. Writing to the store does **not** save — call
`persistCurrent('theme')` after a write you want kept. Writes coalesce and go
to main as a `config:setPrefs` patch with a revision label naming the change.

Volatile state (a selection, a scroll position, an in-flight request) goes in
`session`, which has the same shape but never touches disk:

```js
session.set('strip', strip);
session.subscribe('strip', (strip) => …);
```

### `window.api`

Never call `window.api` directly. Use the `api` façade in `state.js`: it
unwraps main's `{ ok, value } | { ok, error }` envelope into a value-or-throw,
and it has a **degraded mode** — with no preload bridge (a plain browser, or
main not yet loaded) configuration falls back to `localStorage` and
`api.degraded` is `true`. The shell surfaces that as a "Local-only settings"
status chip rather than pretending the write landed. Add new capabilities as
methods on that façade so the degraded path stays in one place.

---

## Theme and tokens

`theme.js` derives the whole M3 scheme from one seed colour using **HCT**
(a real CAM16 implementation, not an HSL approximation) and writes it onto
`:root`. Consume tokens; never hard-code a colour.

```css
color: var(--md-sys-color-on-surface);   /* full role name */
color: var(--onsfc);                     /* the mockup's short alias — same value */
```

Both spellings exist for every role. Also available: the full tonal palettes
(`--md-ref-palette-primary-40`), elevation (`--e1`…`--e5`), shape
(`--shape-sm`…`--shape-full`), motion (`--motion-medium`, `--ease-emphasized`),
and the type scale (`--type-title-md`, `--type-label-sm`, …).

**Size everything against `--den` and `--uiscale`**, never in raw pixels:

```css
.thing { min-height: calc(36px * var(--den)); padding: 0 calc(12px * var(--den)); }
```

`--den` is the density scale (1 … 0.76 for density 0 … −3) and `--uiscale` is
the user's UI scale (1 / 1.25 / 1.5 / 2). A layout that ignores them breaks at
200%, and that is a shipping defect, not a polish item.

Runtime mutators: `theme.setMode/setSeed/setDensity/setScale/setFontFamily/
setFontSize/setFontWeight/setReduceMotion/setContrast/reset`. All apply live,
with no restart, and persist themselves.

---

## Language

```js
import { t, tPair, bindText, bindRender, label } from './i18n.js';

t('connEstablished', host)            // active mode, params substituted
tPair('connEstablished', host)        // { en, yue } regardless of mode
bindText(el, 'closeTab')              // re-renders on language/level change
bindText(el, 'closeTab', { attr: 'aria-label' })
bindRender(el, () => { … })           // re-render a whole subtree
```

* Strings come from `design/winscp-i18n.js`. **Do not add English literals to a
  module** when a key exists — check the dictionary first. A missing key
  renders as the key itself so the gap is visible rather than blank.
* The funny level changes **voice, never facts**. Parameters are substituted
  after resolution, so host names, paths, counts and versions are identical at
  level 1 and level 5.
* Bilingual mode: use `bindText` (which calls `bilingualNode`) rather than
  concatenating yourself. Short strings inline as `English · 粵語`; long ones
  become a prominent primary line plus a compact `.bi-secondary` line.
* Anything that ellipsises must carry the full text in `title`.

---

## Registering a view

```js
import { registerView } from '../app.js';

registerView({
  id: 'queue', labelKey: 'queueTitle', icon: 'playlist', order: 30,
  mount(container, ctx) { container.appendChild(buildQueue().element); },
  unmount(container) { … },
});
```

## Registering a dialog

Dialogs are for **decisions the user must make before continuing** —
confirmations, destructive gates, unsaved-changes prompts, credentials.
Anything that only informs is a toast (see below); a modal there is a defect.

```js
import { registerDialog, openDialog } from '../app.js';

registerDialog('overwrite', ({ props, close }) => ({
  title: t('overwriteTitle'),
  width: 520,
  content: h('p', {}, t('overwriteBody', props.name)),
  actions: [
    { label: t('cancel'), kind: 'text' },
    { label: t('overwrite'), kind: 'danger', autofocus: true,
      onSelect: () => props.onConfirm() },
  ],
}));

openDialog('overwrite', { name: 'index.html', onConfirm });
```

An action's `onSelect(close)` closes the dialog unless it returns `true`.
`ref(btn)` hands you the button so you can enable/disable it live (the bulk-close
preview does this). `openModal()` in `dom.js` is the primitive underneath —
`ui/dialogs.js` should build its higher-level dialogs on it so the scrim, focus
trap, Escape handling and focus restoration stay identical everywhere.

## Registering a status-bar item

```js
registerStatusItem({
  id: 'transfer', side: 'right', order: 20, label: 'Transfer status',
  render: () => h('span', { class: 'chip', title: full }, icon('swap_vert', 13), h('span', {}, short)),
});
refreshStatus();   // after external state changes
```

## Registering a command

```js
registerCommand({ id: 'queue.pauseAll', labelKey: 'suspendAll', icon: 'pending',
                  shortcut: 'Ctrl+P', run: () => … });
runCommand('queue.pauseAll');
```

## Registering a title-bar action

```js
registerTitlebarAction({ id: 'queue', icon: 'playlist', labelKey: 'queueTitle',
                         order: 20, onSelect: (btn) => openQueuePopover(btn) });
```

---

## Registering a search bar

**Every search surface in this app uses `createSearchBar`.** That is how the
"regex builder anchored beside every search bar" requirement is satisfied — do
not write your own field.

```js
import { createSearchBar, filterBy, noMatchMessage } from './searchbar.js';

const bar = createSearchBar({
  id: 'preferences-network',              // state persists under config search.<id>
  labelKey: 'prefsSearchPh',
  placeholderKey: 'prefsSearchPh',
  sampleProvider: () => rows.map(r => r.label).join('\n'),   // real data for the builder
  onChange: render,
});
container.appendChild(bar.element);

function render() {
  const list = bar.isActive
    ? filterBy(rows, bar.predicate, (r) => [r.label, r.description, String(r.value)])
    : rows;
  if (!list.length) showEmpty(noMatchMessage(bar.predicate, 'this page'));
}
```

* Plain text is the default; regex is an explicit opt-in via the `.*` chip.
* `bar.predicate` is `{ ok, error, mode, describe, test(value) }`. **Use it for
  both a filter and its inverse** — negate the one predicate rather than
  building a second, or flags, casing, Unicode and scope will drift apart.
* `id` must be stable and unique. Several bars on one surface each get their
  own state and their own anchored builder; never share one bar between fields.
* `persist: false` for throwaway surfaces (popovers, dialogs).
* Settings surfaces are **not exempt**: every preferences page, tab and
  properties panel needs its own bar over that page's own labels, descriptions
  and current values, and must say plainly when a match sits on another tab.

Evaluation is local and bounded: sample capped at 20 000 characters, matches
capped at 500, and the pattern runs in a Worker with a 400 ms budget that is
terminated and reported as a runaway pattern rather than hanging the window.

---

## Opting an element into the appearance editor

One call, at the point you create the element:

```js
import { appearanceTarget } from './dom.js';

appearanceTarget(el, 'queue-row', 'Queue row');
//                   ^ persistence key      ^ what the editor's header shows
```

That is all. Any element carrying `data-ap` automatically gets:

* **Edit appearance…** in its context menu (a global menu contributor adds it),
* the **Shift+right-click** shortcut that opens the editor directly,
* the keyboard equivalents — Shift+F10 / the Context-Menu key for the menu, and
  **Alt+Shift+E** to open the editor for the focused element.

Keys must be **stable across restarts** — they are the persistence key under
`theme.perElement`. Derive them from a durable id (`tab-${tab.key}`), never
from an array index or a generated `uid()`.

Overrides are compiled into one managed stylesheet targeting
`[data-ap="key"]` plus `:hover`, `:focus-visible` and `:active`, so your
component needs no per-instance style plumbing. Give the element a
`--ap-icon-size`-aware icon if it has one (SVG icons already follow it).

The editor never silently drops a value it cannot represent: an unsupported
property keeps its stored value and shows the reason. Follow that rule in any
control you add.

---

## Menus

```js
import { registerContextMenu, openMenu, attachMenuButton, SEPARATOR } from './contextmenu.js';

registerContextMenu(rowEl, (ctx) => [
  { labelKey: 'download', icon: 'download', shortcut: 'F5', onSelect: … },
  { labelKey: 'showHiddenFiles', checked: showHidden, onSelect: … },
  SEPARATOR,
  { labelKey: 'properties', icon: 'info', submenu: [ … ] },
]);

attachMenuButton(buttonEl, () => items, { placement: 'bottom-end' });
```

Providers are collected by walking up from the event target, so a child's menu
and its container's menu are concatenated. **If your container has a provider
and its children have their own, return `[]` from the container's provider
when the event came from a child** — otherwise the user sees every entry
twice. `ui/tabs.js` does this for the strip.

Item fields: `label` / `labelKey`, `icon`, `shortcut`, `checked` (+`radio`),
`disabled`, `danger`, `description`, `submenu`, `keepOpen`, `onSelect`.

---

## Notifications

```js
import { notify } from './notifications.js';

notify.success(title, body);
notify.error(title, body);                     // persists until dismissed
const h = notify.progress('Uploading…', name, { id: 'up-1', progress: 0.4 });
notify.show({ id: 'up-1', kind: 'progress', progress: 0.8 });   // same id updates in place
```

Corner toasts, bottom-right, stacking, screen-reader announced, timers paused
on hover and focus. Info/success/progress auto-dismiss; **warnings and errors
persist until dismissed**. Everything lands in the notification centre.
Never open a modal to tell the user something.

---

## Colours

```js
import { openColorPicker, colorSwatchButton, createColorPicker } from './colorpicker.js';

const swatch = colorSwatchButton({ value: '#0B57D0', label: t('siteColor'),
                                   onChange: (hex) => … });
```

`createColorPicker` returns an embeddable element; `openColorPicker` wraps it
in an anchored popover. It is continuous (2-D field + hue and alpha rails plus
numeric entry) — swatches and recents are conveniences layered on top, never a
replacement. `parseAnyColor(str)` reads every representation the translator
emits, back into `{ r, g, b, a, space, inGamut }`.

---

## Accessibility (blockers, not polish)

* Every interactive element is keyboard reachable with a visible focus ring
  (`:focus-visible` is styled globally — do not remove it).
* Composite widgets are **one** tab stop with `rovingFocus()` from `dom.js`.
* Correct roles, names and states. Popovers use `role="dialog"`
  `aria-modal="false"`; only real modals are `aria-modal="true"`.
* Announce state changes with `announce(msg, assertive)` — it never moves focus.
* Toggle visibility with the `hidden` attribute (it also removes the element
  from the accessibility tree). `tokens.css` makes `[hidden]` win over any
  `display` rule.
* Respect reduced motion: `store.get('theme.reduceMotion')` **or** the OS
  setting. `:root[data-rm="1"]` disables animation globally.
* Nothing may be clipped, truncated or overlapping at supported sizes. Validate
  narrow widths, 100/125/150/200% scale, and **bilingual mode**, where labels
  are longest. Where an ellipsis is unavoidable, put the full text in `title`.

---

## Verifying

```
node --check design/renderer/<file>.js     # syntax
npx electron .                             # the real app
```

There is no test runner for the renderer yet. `npm test` covers main-process
logic; renderer verification today is `node --check` plus driving the built
app. If you add renderer tests, put pure logic (colour maths, the match
predicate, tone derivation) in `test/` where it can run headless — those parts
are deliberately free of DOM dependencies.
