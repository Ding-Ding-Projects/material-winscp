// app.js — the application shell and the registries other modules plug into.
//
// What this file owns:
//   * boot order (config -> theme -> i18n -> notifications -> menus ->
//     appearance -> shell -> tab strip -> dim sum)
//   * the custom Material title bar, including the real window controls
//   * the session tab strip and the content area other modules fill
//   * the status bar
//   * the registries: views, dialogs, status items, commands, title-bar actions
//
// Everything a later module needs is exported from here or from state.js; see
// design/renderer/README.md for the contract.

import {
  h, icon, clear, uid, appearanceTarget, announce, openModal, oneLine,
} from './dom.js';
import {
  store, bus, api, loadConfig, persistCurrent, session, LAUNCH_ID,
} from './state.js';
import { startThemeEngine, applyTheme, theme as themeApi, currentScheme } from './theme.js';
import {
  startI18n, t, bindText, bindRender, cycleLanguage, setLanguage, setFunnyLevel,
  getFunnyLevel, getLanguage, languageSummary, disclosureText, LANG_LABELS, FUNNY_LABELS,
} from './i18n.js';
import { installContextMenus, openMenu, attachMenuButton, registerContextMenu, SEPARATOR } from './ui/contextmenu.js';
import { startNotifications, notify, openNotificationCentre, subscribeNotifications } from './ui/notifications.js';
import { startAppearance, openAppearanceEditor, exportAppearance, importAppearance } from './ui/appearance.js';
import { createTabStrip, getStrip } from './ui/tabs.js';
import { maybeShowDimSum } from './ui/dimsum.js';
import { createSearchBar } from './ui/searchbar.js';
import { openColorPicker } from './ui/colorpicker.js';
import { appMark } from './ui/appmark.js';
import { VERSION, CODENAME, SEEDS } from '../winscp-data.js';

/* ================================================================== */
/* registries                                                          */
/* ================================================================== */

const views = new Map();
const dialogs = new Map();
const statusItems = new Map();
const commands = new Map();
const titlebarActions = [];

/**
 * registerView({ id, labelKey, icon, order, mount(container, ctx), unmount })
 * A view is a full-page surface reached from the tab strip or a command.
 * mount() is called with an empty container and must fill it.
 */
export function registerView(view) {
  if (!view?.id || typeof view.mount !== 'function') throw new Error('registerView needs { id, mount }');
  views.set(view.id, { order: 100, ...view });
  bus.emit('shell:viewRegistered', view.id);
  return () => views.delete(view.id);
}
export function listViews() { return Array.from(views.values()).sort((a, b) => a.order - b.order); }

/**
 * registerDialog(id, factory)
 * factory({ props, close }) returns { title, content, actions, width } or a
 * Node. openDialog(id, props) opens it as a real modal — reserved for
 * decisions; anything informational should be a toast instead.
 */
export function registerDialog(id, factory) {
  dialogs.set(id, factory);
  return () => dialogs.delete(id);
}
/** Every registered dialog id. The integration tests assert against this. */
export function listDialogs() { return Array.from(dialogs.keys()).sort(); }
export function hasDialog(id) { return dialogs.has(id); }
export function openDialog(id, props = {}) {
  const factory = dialogs.get(id);
  if (!factory) {
    notify.error('Dialog unavailable', `No dialog is registered under "${id}". Nothing was changed.`);
    return null;
  }
  let handle = null;
  const close = () => handle?.close();
  const spec = factory({ props, close });
  if (spec instanceof Node) handle = openModal({ title: props.title || '', content: spec });
  else handle = openModal(spec);
  return handle;
}

/**
 * registerStatusItem({ id, side:'left'|'right', order, render() => Node })
 * refreshStatus(id) re-renders one item; refreshStatus() re-renders all.
 */
export function registerStatusItem(item) {
  if (!item?.id || typeof item.render !== 'function') throw new Error('registerStatusItem needs { id, render }');
  statusItems.set(item.id, { side: 'left', order: 100, ...item });
  refreshStatus();
  return () => { statusItems.delete(item.id); refreshStatus(); };
}

/** registerCommand({ id, labelKey|label, icon, shortcut, run }) */
export function registerCommand(cmd) {
  if (!cmd?.id || typeof cmd.run !== 'function') throw new Error('registerCommand needs { id, run }');
  commands.set(cmd.id, cmd);
  return () => commands.delete(cmd.id);
}
export function runCommand(id, ...args) {
  const cmd = commands.get(id);
  if (!cmd) { notify.warning('Unknown command', `"${id}" is not registered.`); return null; }
  try { return cmd.run(...args); }
  catch (err) { notify.error('Command failed', `${cmd.label || id}: ${err.message}`); return null; }
}
export function listCommands() { return Array.from(commands.values()); }

/** Add a button to the title bar's right-hand cluster. */
export function registerTitlebarAction(spec) {
  const entry = { order: 100, ...spec };
  titlebarActions.push(entry);
  renderTitlebarActions();
  return () => {
    const i = titlebarActions.indexOf(entry);
    if (i >= 0) titlebarActions.splice(i, 1);
    renderTitlebarActions();
  };
}

/** How the tab strip fills a tab's panel. panels.js sets this. */
let panelRenderer = null;
export function setTabPanelRenderer(fn) {
  panelRenderer = fn;
  const strip = getStrip('main');
  if (strip) for (const tab of strip.tabs) { if (tab.panel) { clear(tab.panel); fn(tab, tab.panel); } }
}

/* ================================================================== */
/* shell DOM                                                           */
/* ================================================================== */

let els = {};

function buildTitleBar() {
  const brand = h('div', { class: 'tb-brand' },
    appMark('tb-logo'),
    h('div', { class: 'tb-titles' },
      h('span', { class: 'tb-title' }, t('appName')),
      h('span', { class: 'tb-version mono' }, VERSION)));
  appearanceTarget(brand, 'titlebar-brand', 'Title bar brand');

  const codename = h('span', {
    class: 'tb-codename',
    title: `${t('aboutCodename')}: ${CODENAME.en} · ${CODENAME.zh}`,
  }, `${CODENAME.en} · ${CODENAME.zh}`);
  appearanceTarget(codename, 'titlebar-codename', 'Release code name');

  const actionsEl = h('div', { class: 'tb-actions' });

  const notifBtn = h('button', {
    type: 'button', class: 'icon-btn tb-btn', 'aria-haspopup': 'dialog',
    onclick: () => openNotificationCentre(notifBtn),
  }, icon('notifications', 19), h('span', { class: 'tb-badge', hidden: true }));
  bindText(notifBtn, 'notifCenter', { attr: 'aria-label' });
  bindText(notifBtn, 'notifCenter', { attr: 'title' });
  appearanceTarget(notifBtn, 'titlebar-notifications', 'Notification button');
  subscribeNotifications(({ unread }) => {
    const badge = notifBtn.querySelector('.tb-badge');
    badge.hidden = unread === 0;
    badge.textContent = unread > 99 ? '99+' : String(unread);
    notifBtn.setAttribute('aria-label', unread ? `${t('notifCenter')} (${unread})` : t('notifCenter'));
  });

  const langBtn = h('button', { type: 'button', class: 'tb-chip' },
    icon('translate', 15), h('span', { class: 'tb-chip-label' }, LANG_LABELS[getLanguage()]));
  appearanceTarget(langBtn, 'titlebar-language', 'Language chip');
  attachMenuButton(langBtn, () => languageMenuItems(), { label: t('langMode'), placement: 'bottom-end' });
  bindRender(langBtn, () => {
    langBtn.querySelector('.tb-chip-label').textContent = LANG_LABELS[getLanguage()];
    langBtn.title = languageSummary();
    langBtn.setAttribute('aria-label', languageSummary());
  });

  const themeBtn = h('button', { type: 'button', class: 'icon-btn tb-btn' }, icon('contrast', 18));
  appearanceTarget(themeBtn, 'titlebar-theme', 'Theme button');
  bindText(themeBtn, 'themeMode', { attr: 'aria-label' });
  bindText(themeBtn, 'themeMode', { attr: 'title' });
  attachMenuButton(themeBtn, () => themeMenuItems(themeBtn), { label: t('themeMode'), placement: 'bottom-end' });

  const minBtn = h('button', { type: 'button', class: 'icon-btn win-btn', onclick: () => api.windowMinimize() }, icon('minimize', 17));
  const maxBtn = h('button', { type: 'button', class: 'icon-btn win-btn', onclick: () => api.windowMaximize() }, icon('maximize', 15));
  const closeBtn = h('button', { type: 'button', class: 'icon-btn win-btn is-close', onclick: () => api.windowClose() }, icon('close', 17));
  bindText(minBtn, 'minimize', { attr: 'aria-label' });
  bindText(minBtn, 'minimize', { attr: 'title' });
  bindText(closeBtn, 'closeWin', { attr: 'aria-label' });
  bindText(closeBtn, 'closeWin', { attr: 'title' });
  function syncMaxButton(maximized) {
    clear(maxBtn);
    maxBtn.appendChild(icon(maximized ? 'restore_window' : 'maximize', 15));
    const key = maximized ? 'restoreWin' : 'maximize';
    maxBtn.setAttribute('aria-label', t(key));
    maxBtn.title = t(key);
  }
  syncMaxButton(false);
  api.windowIsMaximized().then(syncMaxButton);
  api.onWindowState((s) => syncMaxButton(!!(s?.maximized ?? s)));

  const bar = h('div', { class: 'titlebar' },
    brand, codename,
    h('div', { class: 'tb-spacer' }),
    actionsEl, notifBtn, langBtn, themeBtn,
    h('div', { class: 'tb-divider' }),
    minBtn, maxBtn, closeBtn);
  appearanceTarget(bar, 'titlebar', 'Title bar');

  registerContextMenu(bar, () => [
    { labelKey: 'preferences', icon: 'settings', onSelect: () => runCommand('app.preferences') },
    { labelKey: 'aboutMenu', icon: 'info', onSelect: () => runCommand('app.about') },
  ]);

  els.titlebarActions = actionsEl;
  return bar;
}

function renderTitlebarActions() {
  if (!els.titlebarActions) return;
  clear(els.titlebarActions);
  for (const a of titlebarActions.slice().sort((x, y) => x.order - y.order)) {
    const label = a.label || t(a.labelKey || 'help');
    const btn = h('button', {
      type: 'button', class: a.showLabel ? 'tb-chip tb-action-label' : 'icon-btn tb-btn',
      'aria-label': label,
      title: label,
      onclick: () => a.onSelect?.(btn),
    }, icon(a.icon || 'more_vert', 18),
    a.showLabel ? h('span', { class: 'tb-action-text' }, label) : null);
    if (a.labelKey) {
      bindRender(btn, () => {
        const next = a.label || t(a.labelKey);
        btn.setAttribute('aria-label', next);
        btn.title = next;
        const text = btn.querySelector('.tb-action-text');
        if (text) text.textContent = next;
      });
    }
    appearanceTarget(btn, `titlebar-action-${a.id || uid('a')}`, a.label || a.id || 'Title bar action');
    els.titlebarActions.appendChild(btn);
  }
}

function languageMenuItems() {
  const lang = getLanguage();
  return [
    { labelKey: 'langEnglish', icon: 'language', checked: lang === 'en', radio: true, onSelect: () => setLanguage('en') },
    { labelKey: 'langCantonese', icon: 'language', checked: lang === 'yue', radio: true, onSelect: () => setLanguage('yue') },
    { labelKey: 'langBilingual', icon: 'language', checked: lang === 'both', radio: true, onSelect: () => setLanguage('both') },
    SEPARATOR,
    {
      labelKey: 'funnyEn', icon: 'sentiment',
      submenu: [1, 2, 3, 4, 5].map((n) => ({
        label: `${n} — ${FUNNY_LABELS.en[n - 1]}`,
        checked: getFunnyLevel('en') === n, radio: true,
        onSelect: () => setFunnyLevel('en', n),
      })),
    },
    {
      labelKey: 'funnyYue', icon: 'sentiment',
      submenu: [1, 2, 3, 4, 5].map((n) => ({
        label: `${n} — ${FUNNY_LABELS.yue[n - 1]}`,
        checked: getFunnyLevel('yue') === n, radio: true,
        onSelect: () => setFunnyLevel('yue', n),
      })),
    },
    SEPARATOR,
    { labelKey: 'funnyDisclose', icon: 'info', onSelect: showFunnyDisclosure },
  ];
}

function themeMenuItems(anchor) {
  const mode = store.get('theme.mode');
  const density = store.get('theme.density');
  const scale = store.get('theme.uiScale');
  return [
    { labelKey: 'themeLight', icon: 'light_mode', checked: mode === 'light', radio: true, onSelect: () => themeApi.setMode('light') },
    { labelKey: 'themeDark', icon: 'dark_mode', checked: mode === 'dark', radio: true, onSelect: () => themeApi.setMode('dark') },
    { labelKey: 'themeAuto', icon: 'contrast', checked: mode === 'system', radio: true, onSelect: () => themeApi.setMode('system') },
    SEPARATOR,
    {
      labelKey: 'seedColor', icon: 'palette',
      submenu: [
        ...SEEDS.map((s) => ({
          label: s.label, icon: 'palette',
          checked: String(store.get('theme.seed')).toLowerCase() === s.hex.toLowerCase(), radio: true,
          onSelect: () => themeApi.setSeed(s.hex),
        })),
        SEPARATOR,
        {
          labelKey: 'custom', icon: 'colorize',
          onSelect: () => openColorPicker({
            anchor, value: store.get('theme.seed'), alpha: false, title: t('seedColor'),
            onChange: (hex) => themeApi.setSeed(hex),
            onApply: (hex) => themeApi.setSeed(hex),
          }),
        },
      ],
    },
    {
      labelKey: 'density', icon: 'view_column',
      submenu: [
        { labelKey: 'densityComfy', checked: density === 0, radio: true, onSelect: () => themeApi.setDensity(0) },
        { labelKey: 'densityCompact', checked: density === -1, radio: true, onSelect: () => themeApi.setDensity(-1) },
        { labelKey: 'densityDense', checked: density === -2, radio: true, onSelect: () => themeApi.setDensity(-2) },
        { label: 'Densest (-3)', checked: density === -3, radio: true, onSelect: () => themeApi.setDensity(-3) },
      ],
    },
    {
      labelKey: 'fontScale', icon: 'format_size',
      submenu: [1, 1.25, 1.5, 2].map((s) => ({
        label: `${Math.round(s * 100)}%`, checked: Math.abs(scale - s) < 0.01, radio: true,
        onSelect: () => themeApi.setScale(s),
      })),
    },
    SEPARATOR,
    { labelKey: 'reducedMotion', icon: 'pending', checked: !!store.get('theme.reduceMotion'), onSelect: () => themeApi.setReduceMotion(!store.get('theme.reduceMotion')) },
    SEPARATOR,
    { labelKey: 'apExportTheme', icon: 'file_download', onSelect: exportAppearance },
    { labelKey: 'apImportTheme', icon: 'file_upload', onSelect: () => importAppearance() },
    { labelKey: 'apResetAll', icon: 'restart_alt', danger: true, onSelect: () => { themeApi.reset(); notify.info(t('apResetDone'), t('apResetAll')); } },
  ];
}

function showFunnyDisclosure() {
  openModal({
    title: t('funnyDisclose'),
    width: 560,
    content: h('div', { class: 'stack' },
      ...disclosureText().split('\n\n').map((p) => h('p', { class: 'prose' }, p)),
      h('div', { class: 'row' },
        h('label', { class: 'field inline' },
          h('span', { class: 'field-label' }, `${t('funnyEn')} — ${getFunnyLevel('en')}/5`),
          funnySlider('en')),
        h('label', { class: 'field inline' },
          h('span', { class: 'field-label' }, `${t('funnyYue')} — ${getFunnyLevel('yue')}/5`),
          funnySlider('yue')))),
    actions: [
      { label: t('reset'), kind: 'text', onSelect: () => { setFunnyLevel('en', 3); setFunnyLevel('yue', 3); } },
      {
        label: t('ok'), kind: 'filled', autofocus: true,
        onSelect: () => { store.set('disclosureAccepted', true); persistCurrent('disclosureAccepted'); },
      },
    ],
  });
}

/** Two independent sliders, one per language — exported for preferences.js. */
export function funnySlider(language) {
  const input = h('input', {
    type: 'range', min: '1', max: '5', step: '1', class: 'slider',
    'aria-label': language === 'yue' ? t('funnyYue') : t('funnyEn'),
  });
  input.value = String(getFunnyLevel(language));
  const out = h('output', { class: 'slider-value' });
  const paint = () => {
    const n = Number(input.value);
    out.textContent = `${n} — ${FUNNY_LABELS[language][n - 1]}`;
    input.setAttribute('aria-valuetext', out.textContent);
  };
  input.addEventListener('input', () => { setFunnyLevel(language, Number(input.value)); paint(); });
  paint();
  return h('span', { class: 'slider-wrap' }, input, out);
}

function buildStatusBar() {
  const left = h('div', { class: 'sb-left' });
  const right = h('div', { class: 'sb-right mono' });
  const bar = h('div', { class: 'statusbar', role: 'status' }, left, h('div', { class: 'tb-spacer' }), right);
  appearanceTarget(bar, 'statusbar', 'Status bar');
  els.statusLeft = left;
  els.statusRight = right;
  return bar;
}

function refreshStatus() {
  if (!els.statusLeft) return;
  clear(els.statusLeft);
  clear(els.statusRight);
  for (const item of Array.from(statusItems.values()).sort((a, b) => a.order - b.order)) {
    let node = null;
    try { node = item.render(); } catch (err) { console.error(`[status] ${item.id} failed`, err); }
    if (!node) continue;
    const wrap = h('span', { class: 'sb-item', 'data-status-id': item.id }, node);
    appearanceTarget(wrap, `status-${item.id}`, item.label || `Status: ${item.id}`);
    (item.side === 'right' ? els.statusRight : els.statusLeft).appendChild(wrap);
  }
}
export { refreshStatus };

/* ================================================================== */
/* boot                                                                */
/* ================================================================== */

let booted = false;

export async function boot() {
  if (booted) return;
  booted = true;
  let errorPath = false;

  try {
    await loadConfig();
  } catch (err) {
    errorPath = true;
    console.error('[boot] configuration could not be loaded', err);
  }

  startThemeEngine();
  startI18n();
  startNotifications();
  installContextMenus();
  startAppearance();

  const root = document.getElementById('app');
  clear(root);

  const titlebar = buildTitleBar();
  const stripHost = h('div', { class: 'stripbar' });
  const content = h('div', { class: 'content', id: 'content' });
  appearanceTarget(content, 'content-area', 'Content area');
  const statusbar = buildStatusBar();

  root.append(titlebar, stripHost, content, statusbar);
  renderTitlebarActions();

  /* ---- the session tab strip ---- */
  const strip = createTabStrip({
    id: 'main',
    windowId: t('appName'),
    container: stripHost,
    panelHost: content,
    onNewTab: () => {
      const n = strip.tabs.length + 1;
      strip.openTab({ title: `${t('newTab')} ${n}`, key: `tab-${n}-${LAUNCH_ID}` });
    },
    renderPanel: (tab, panel) => {
      if (panelRenderer) { panelRenderer(tab, panel); return; }
      renderPlaceholderPanel(tab, panel);
    },
  });
  session.set('strip', strip);

  // A first tab so the shell is never an empty window.
  strip.openTab({ title: t('localTab'), key: 'welcome', icon: 'computer' });

  /* ---- baseline status items ---- */
  registerStatusItem({
    id: 'connection', side: 'left', order: 10, label: 'Connection chip',
    // Where a chip has to ellipsise (bilingual mode makes labels long), the
    // full text is always on the title so nothing is truly lost.
    render: () => h('span', { class: 'chip', title: t('notConnected') },
      icon('shield_lock', 13), h('span', {}, t('notConnected'))),
  });
  registerStatusItem({
    id: 'language', side: 'left', order: 20, label: 'Language status',
    render: () => h('span', { class: 'chip is-quiet', title: languageSummary() },
      icon('translate', 13), h('span', {}, languageSummary())),
  });
  registerStatusItem({
    id: 'build', side: 'right', order: 10, label: 'Build status',
    render: () => h('span', {}, `${VERSION} · ${CODENAME.en}`),
  });
  if (api.degraded) {
    registerStatusItem({
      id: 'degraded', side: 'right', order: 5, label: 'Storage status',
      render: () => h('span', { class: 'chip is-warn', title: 'No preload bridge is present, so settings are kept in this window only.' },
        icon('warning', 13), h('span', {}, 'Local-only settings')),
    });
  }

  /* ---- baseline commands ---- */
  // ui/dialogs/about.js and ui/dialogs/preferences.js register the real
  // surfaces. The shell keeps its own entry so the command exists even in a
  // stripped build, and delegates the moment the full dialog is present —
  // which keeps one implementation per command whichever module loads first.
  registerCommand({
    id: 'app.about', labelKey: 'aboutMenu', icon: 'info',
    run: () => (dialogs.has('about') ? openDialog('about') : openAbout()),
  });
  registerCommand({
    id: 'app.preferences', labelKey: 'preferences', icon: 'settings', shortcut: 'Ctrl+,',
    run: () => {
      if (dialogs.has('preferences')) return openDialog('preferences');
      notify.info(t('preferences'), 'The preferences surface is not loaded in this build yet. Theme, language and appearance are available from the title bar in the meantime.');
      return null;
    },
  });
  registerCommand({ id: 'app.notifications', labelKey: 'notifCenter', icon: 'notifications', run: () => openNotificationCentre() });
  registerCommand({ id: 'app.language', labelKey: 'langMode', icon: 'translate', run: () => cycleLanguage() });
  registerCommand({ id: 'app.appearance', labelKey: 'apTitle', icon: 'palette', run: () => openAppearanceEditor({ key: 'titlebar', element: titlebar, label: 'Title bar' }) });

  installShortcuts();
  refreshStatus();
  bus.on('i18n:changed', refreshStatus);

  bus.emit('shell:ready', { strip });
  document.body.dataset.ready = '1';

  // The disclosure is shown once, before the funny level has ever been used
  // to style anything the user did not ask for.
  if (!store.get('disclosureAccepted')) {
    setTimeout(showFunnyDisclosure, 400);
  }

  // The dim sum draw runs AFTER the shell is interactive, so it can never
  // delay startup, and never on an error path or a first run.
  setTimeout(() => {
    maybeShowDimSum({ errorPath, firstRun: !store.get('disclosureAccepted') })
      .catch((err) => console.warn('[dimsum] skipped:', err?.message || err));
  }, 1200);
}

function renderPlaceholderPanel(tab, panel) {
  const search = createSearchBar({
    id: `panel-${tab.key || tab.id}`,
    labelKey: 'filterPh', placeholderKey: 'filterPh',
    appearanceKey: `search-panel-${tab.key || tab.id}`,
    appearanceLabel: 'Panel filter',
  });
  const card = h('div', { class: 'placeholder' },
    h('div', { class: 'placeholder-head' },
      icon(tab.icon || 'dns', 22),
      h('div', {},
        h('div', { class: 'placeholder-title' }, tab.title),
        h('div', { class: 'placeholder-sub' }, t('notConnected')))),
    h('div', { class: 'placeholder-search' }, search.element),
    h('p', { class: 'prose' }, t('tagline')),
    h('p', { class: 'prose muted' },
      'This panel is filled by the file-panel module. The shell has already wired its tab, its context menu, its appearance target and its search bar with the regex builder.'));
  appearanceTarget(card, `panel-placeholder-${tab.key || tab.id}`, `Panel: ${tab.title}`);
  panel.appendChild(card);
}

function openAbout() {
  const scheme = currentScheme();
  openModal({
    title: t('aboutMenu'),
    width: 520,
    content: h('div', { class: 'stack' },
      h('div', { class: 'about-head' },
        appMark('tb-logo is-big'),
        h('div', {},
          h('div', { class: 'about-name' }, t('appName')),
          h('div', { class: 'about-ver mono' }, `${t('aboutBuild')} ${VERSION}`),
          h('div', { class: 'about-code' }, `${t('aboutCodename')}: ${CODENAME.en} · ${CODENAME.zh}`))),
      h('img', { src: CODENAME.img, alt: `${CODENAME.en} (${CODENAME.zh})`, class: 'about-dish', width: 96, height: 96 }),
      h('p', { class: 'prose' }, t('aboutBody')),
      h('div', { class: 'about-grid mono' },
        h('span', {}, 'Theme'), h('span', {}, `${store.get('theme.mode')} · seed ${store.get('theme.seed')}`),
        h('span', {}, 'Surface'), h('span', {}, scheme?.surface || '—'),
        h('span', {}, 'Language'), h('span', {}, languageSummary()),
        h('span', {}, 'Launch'), h('span', {}, LAUNCH_ID))),
    actions: [{ label: t('close'), kind: 'filled', autofocus: true }],
  });
}

function installShortcuts() {
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      runCommand('session.siteManager');
    } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      runCommand('session.siteManager');
    } else if ((e.ctrlKey || e.metaKey) && e.key === ',') { e.preventDefault(); runCommand('app.preferences'); }
    else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'l') { e.preventDefault(); cycleLanguage(); }
    else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      const mode = store.get('theme.mode');
      themeApi.setMode(mode === 'dark' ? 'light' : 'dark');
      announce(`${t('themeMode')}: ${store.get('theme.mode')}`);
    } else if (e.key === 'F1') { e.preventDefault(); runCommand('app.about'); }
  });
}

/* ================================================================== */
/* start                                                               */
/* ================================================================== */

if (typeof document !== 'undefined') {
  // Why a macrotask rather than a straight call: index.js imports this module
  // first and the feature modules after it, and several of those register on a
  // microtask. Yielding once lets the whole module graph finish registering its
  // views, dialogs, commands and status items BEFORE the shell renders and
  // `shell:ready` fires, so nothing has to race the boot it depends on.
  const start = () => { setTimeout(() => { boot(); }, 0); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
}

// Re-exported so a later module only needs one import for the common surface.
export {
  h, icon, clear, uid, appearanceTarget, announce, openModal, oneLine,
  store, bus, api, session, persistCurrent,
  t, bindText, bindRender,
  notify, openMenu, registerContextMenu, SEPARATOR,
  createSearchBar, openColorPicker, openAppearanceEditor,
  getStrip, applyTheme, themeApi as theme,
};
