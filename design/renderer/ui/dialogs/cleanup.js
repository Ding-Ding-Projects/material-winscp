// ui/dialogs/cleanup.js — "Clean up application data" (Cleanup.dfm).
//
// Cleanup.dfm is a checked list view, an OK and a Close. The list is what
// matters: each row is a class of data the application stores, and ticking it
// means "remove this". This port keeps that shape and adds the two things a
// destructive list has to have to be safe:
//
//   * A REAL COUNT ON EVERY ROW, read from the store before the dialog opens.
//     A row that would remove nothing is shown with a zero and disabled, so
//     the user is never asked to confirm the deletion of nothing, and never
//     wonders whether a row did anything.
//   * ONLY ROWS THAT ACTUALLY DO SOMETHING. Every entry below is wired to real
//     IPC that really removes that data. Nothing is listed because WinSCP lists
//     it; a row with no working implementation would be worse than an absent
//     one, because the user would believe their data was gone.
//
// The removal is confirmed — it is a decision, so it is a modal — and the
// confirmation says what will go, how many of each, and that everything except
// the temporary files is recoverable from the version history, because config
// mutations snapshot themselves. That is a fact about this application, not
// reassurance: the history panel can restore the revision from before the
// cleanup.

import {
  h, icon, clear, uid, appearanceTarget, announce, openModal,
} from '../../dom.js';
import { t, tIn, bindRender, getLanguage, getFunnyLevel } from '../../i18n.js';
import { resolveI18n } from '../../../winscp-i18n.js';
import { api, store, persistCurrent } from '../../state.js';
import { styleSheet } from '../../theme.js';
import { createSearchBar, filterBy, noMatchMessage } from '../searchbar.js';
import { notify } from '../notifications.js';
import { openHistoryPanel } from '../historypanel.js';
import { registerDialog, registerCommand, openDialog } from '../../app.js';

/* ------------------------------------------------------------------ */
/* module-local strings                                                */
/* ------------------------------------------------------------------ */

const STR = {
  cuSearchPh: ['Search these options', '搜尋呢啲選項'],
  cuNothing: ['nothing to remove', '冇嘢好清'],
  cuItems: ['{0} item(s)', '{0} 項'],
  cuBytes: ['{0} bytes', '{0} bytes'],
  cuSelectAll: ['Select everything', '全部揀'],
  cuSelectNone: ['Select nothing', '全部唔揀'],
  cuConfirmTitle: ['Remove the selected data', '刪走揀咗嘅資料'],
  cuConfirmBody: [
    'This removes the following, permanently:',
    '以下嘅嘢會被永久刪走：'],
  cuUndoNote: [
    'Everything except the temporary files is part of the configuration, and the configuration snapshots itself on every change — so the revision from just before this cleanup stays in the version history and can be restored. The temporary files are deleted from disk and are not recoverable.',
    '除咗暫存檔之外，其他全部都係設定嘅一部分，而設定每次改動都會自己影一次相——所以清理之前嗰個版本會留喺版本歷史度，隨時還原到。暫存檔就係由磁碟度真係刪走，救唔返。'],
  cuConfirmBtn: ['Remove them', '刪走佢哋'],
  cuNoneChosen: ['Nothing is ticked, so there is nothing to remove.', '一樣都冇剔，冇嘢好刪。'],
  cuDone: ['Cleaned: {0}.', '清咗：{0}。'],
  cuPartial: ['{0} was not removed: {1}', '{0} 刪唔到：{1}'],
  cuOpenHistory: ['Open the version history', '開版本歷史'],
  cuNoBridge: [
    'Application data lives in the main process, which this window cannot reach right now — only the appearance overrides kept in this window can be cleared.',
    '程式資料喺主行程度，呢個視窗而家去唔到嗰邊——淨係清到留喺呢個視窗嘅外觀覆寫。'],
  cuSites: ['Sites and workspaces', '站點同工作區'],
  cuSitesD: [
    'Saved sites, the folders they are filed under, and saved workspaces.',
    '儲低嘅站點、佢哋擺喺邊個資料夾，同埋儲低嘅工作區。'],
  cuHostKeys: ['Cached host keys', '快取主機密鑰'],
  cuHostKeysD: [
    'The server fingerprints this machine has accepted. Removing them means every server is verified from scratch on the next connection.',
    '呢部機接受過嘅伺服器指紋。刪咗之後，下次連線每個伺服器都要由頭驗過。'],
  cuHistories: ['Recent-entry histories', '最近輸入記錄'],
  cuHistoriesD: [
    'The paths, masks and commands remembered in the drop-down lists.',
    '下拉清單記住嘅路徑、遮罩同指令。'],
  cuBookmarks: ['Bookmarks', '書籤'],
  cuBookmarksD: ['Saved local and remote locations.', '儲低嘅本機同遠端位置。'],
  cuAppearance: ['Appearance overrides and themes', '外觀覆寫同主題'],
  cuAppearanceD: [
    'Per-element appearance edits and saved presets. The theme, density and font settings themselves are kept.',
    '逐個元素改過嘅外觀同儲低嘅預設。主題、密度同字型設定本身會留低。'],
  cuSearches: ['Saved searches', '儲低嘅搜尋'],
  cuSearchesD: [
    'The query, pattern, flags and mode remembered for each search bar.',
    '每個搜尋欄記住嘅字串、樣式、旗標同模式。'],
  cuTemp: ['Temporary files from editing', '編輯遺留嘅暫存檔'],
  cuTempD: [
    'Files downloaded for editing and left behind. Each one may be the only copy of an edit that was never uploaded.',
    '為咗編輯而下載、之後留低咗嘅檔案。每一個都可能係某次未上載成功嘅改動嘅唯一副本。'],
};

function substitute(text, params) {
  return params.length
    ? String(text).replace(/\{(\d+)\}/g, (m, i) => (params[Number(i)] === undefined ? m : String(params[Number(i)])))
    : String(text);
}

function strIn(language, key, ...params) {
  const entry = STR[key];
  if (!entry) return substitute(tIn(language, key), params);
  const raw = resolveI18n(entry, language, getFunnyLevel('en'), getFunnyLevel('yue'));
  return substitute(raw == null ? key : raw, params);
}

function s(key, ...params) {
  const mode = getLanguage();
  if (mode !== 'both') return strIn(mode, key, ...params);
  const en = strIn('en', key, ...params);
  const yue = strIn('yue', key, ...params);
  return en === yue ? en : `${en} · ${yue}`;
}

/** See the note on `compose` in ui/changelog.js — one language at a time. */
function compose(build) {
  const mode = getLanguage();
  const make = (language) => build((key, ...params) => strIn(language, key, ...params), language);
  if (mode !== 'both') return make(mode);
  const en = make('en');
  const yue = make('yue');
  return en === yue ? en : `${en} · ${yue}`;
}

/* ------------------------------------------------------------------ */
/* the main-process bridge                                             */
/* ------------------------------------------------------------------ */

async function callMain(path, ...args) {
  const raw = api.raw;
  if (!raw) { const e = new Error(s('cuNoBridge')); e.code = 'NO_BRIDGE'; throw e; }
  let owner = null;
  let fn = raw;
  for (const seg of path.split('.')) { owner = fn; fn = fn == null ? undefined : fn[seg]; }
  if (typeof fn !== 'function') { const e = new Error(`The application bridge has no ${path}().`); e.code = 'NO_BRIDGE'; throw e; }
  const res = await fn.apply(owner, args);
  if (res && typeof res === 'object' && 'ok' in res) {
    if (res.ok) return res.value;
    const err = new Error((res.error && res.error.message) || 'The call failed.');
    if (res.error && res.error.code) err.code = res.error.code;
    throw err;
  }
  return res;
}

/* ------------------------------------------------------------------ */
/* the rows                                                            */
/* ------------------------------------------------------------------ */

/**
 * Each row: how to count it, and how to remove it. `count(ctx)` reads the
 * store; `remove(ctx)` performs the deletion and returns how many went. Both
 * are real — there is no row here whose remove() is a no-op.
 */
export const CLEANUP_ROWS = [
  {
    id: 'sites',
    labelKey: 'cuSites',
    descKey: 'cuSitesD',
    icon: 'dns',
    count: (ctx) => (ctx.sites || []).length + (ctx.folders || []).length + (ctx.workspaces || []).length,
    detail: (ctx, L = s) => L('cuItems', (ctx.sites || []).length + (ctx.folders || []).length + (ctx.workspaces || []).length),
    async remove(ctx) {
      let n = 0;
      for (const site of ctx.sites || []) { await callMain('config.removeSite', site.id); n += 1; }
      for (const w of ctx.workspaces || []) { await callMain('config.removeWorkspace', w.name); n += 1; }
      for (const f of ctx.folders || []) { await callMain('config.removeFolder', f, false); n += 1; }
      return n;
    },
  },
  {
    id: 'hostKeys',
    labelKey: 'cuHostKeys',
    descKey: 'cuHostKeysD',
    icon: 'key',
    count: (ctx) => Object.keys(ctx.hostKeys || {}).length,
    detail: (ctx, L = s) => L('cuItems', Object.keys(ctx.hostKeys || {}).length),
    async remove(ctx) {
      let n = 0;
      for (const hostPort of Object.keys(ctx.hostKeys || {})) { await callMain('config.forgetHostKey', hostPort); n += 1; }
      return n;
    },
  },
  {
    id: 'histories',
    labelKey: 'cuHistories',
    descKey: 'cuHistoriesD',
    icon: 'history',
    count: (ctx) => Object.keys((ctx.prefs && ctx.prefs.history) || {}).length,
    detail: (ctx, L = s) => L('cuItems', Object.keys((ctx.prefs && ctx.prefs.history) || {}).length),
    async remove() {
      await callMain('config.clearHistory', undefined);
      return 1;
    },
  },
  {
    id: 'bookmarks',
    labelKey: 'cuBookmarks',
    descKey: 'cuBookmarksD',
    icon: 'bookmark',
    count: (ctx) => {
      const b = (ctx.prefs && ctx.prefs.bookmarks) || {};
      return Object.values(b).reduce((sum, entry) => sum
        + ((entry && entry.local) || []).length + ((entry && entry.remote) || []).length, 0);
    },
    detail(ctx, L = s) { return L('cuItems', this.count(ctx)); },
    async remove(ctx) {
      const b = (ctx.prefs && ctx.prefs.bookmarks) || {};
      let n = 0;
      for (const [key, entry] of Object.entries(b)) {
        for (const side of ['local', 'remote']) {
          for (const item of (entry && entry[side]) || []) {
            await callMain('config.removeBookmark', key, side, item.path || item);
            n += 1;
          }
        }
      }
      return n;
    },
  },
  {
    id: 'appearance',
    labelKey: 'cuAppearance',
    descKey: 'cuAppearanceD',
    icon: 'palette',
    // This one lives in the renderer's own store, so it works with or without
    // the main-process bridge.
    count: () => Object.keys(store.get('theme.perElement') || {}).length + (store.get('theme.presets') || []).length,
    detail(ctx, L = s) { return L('cuItems', this.count(ctx)); },
    async remove() {
      const n = Object.keys(store.get('theme.perElement') || {}).length + (store.get('theme.presets') || []).length;
      store.batch(() => {
        store.set('theme.perElement', {});
        store.set('theme.presets', []);
      });
      persistCurrent('theme');
      return n;
    },
  },
  {
    id: 'searches',
    labelKey: 'cuSearches',
    descKey: 'cuSearchesD',
    icon: 'search',
    count: () => Object.keys(store.get('search') || {}).length,
    detail(ctx, L = s) { return L('cuItems', this.count(ctx)); },
    async remove() {
      const n = Object.keys(store.get('search') || {}).length;
      store.set('search', {});
      persistCurrent('search');
      return n;
    },
  },
  {
    id: 'temp',
    labelKey: 'cuTemp',
    descKey: 'cuTempD',
    icon: 'delete',
    danger: true,
    count: (ctx) => (ctx.orphans || []).length,
    detail: (ctx, L = s) => {
      const list = ctx.orphans || [];
      const bytes = list.reduce((sum, o) => sum + (o.size || 0), 0);
      return `${L('cuItems', list.length)} · ${L('cuBytes', bytes)}`;
    },
    async remove(ctx) {
      const paths = (ctx.orphans || []).map((o) => o.path);
      if (!paths.length) return 0;
      return callMain('editor.discardOrphans', paths);
    },
  },
];

/* ------------------------------------------------------------------ */
/* styles                                                              */
/* ------------------------------------------------------------------ */

let stylesWritten = false;
function ensureStyles() {
  if (stylesWritten || typeof document === 'undefined') return;
  stylesWritten = true;
  styleSheet('cleanup').set(`
.cu { display: flex; flex-direction: column; gap: calc(10px * var(--den)); }
.cu-tools { display: flex; align-items: center; gap: calc(6px * var(--den)); flex-wrap: wrap; }
.cu-list { display: flex; flex-direction: column; gap: calc(6px * var(--den));
  max-height: min(52vh, calc(430px * var(--uiscale))); overflow: auto; }
.cu-row { display: flex; align-items: flex-start; gap: calc(10px * var(--den));
  background: var(--c-low); border-radius: var(--shape-md); padding: calc(10px * var(--den)); }
.cu-row.is-empty { opacity: .6; }
.cu-row input[type="checkbox"] { margin-top: calc(3px * var(--den)); }
.cu-main { flex: 1 1 auto; min-width: 0; }
.cu-label { font-size: var(--type-body-md); font-weight: 600; display: flex;
  align-items: center; gap: 6px; }
.cu-desc { font-size: var(--type-label-md); color: var(--onsv); line-height: 1.45;
  margin-top: 2px; }
.cu-count { font-size: var(--type-label-sm); font-weight: 700; white-space: nowrap;
  border-radius: var(--shape-full); padding: 0 calc(9px * var(--den));
  min-height: calc(22px * var(--den)); display: inline-flex; align-items: center;
  background: var(--secc); color: var(--onsecc); }
.cu-count.is-zero { background: transparent; color: var(--onsv); font-weight: 400; }
.cu-count.is-danger { background: var(--errc); color: var(--onerrc); }
.cu-empty { padding: calc(16px * var(--den)); text-align: center; color: var(--onsv); }
.cu-summary { margin: 0; padding-left: calc(18px * var(--den)); line-height: 1.5; }
`);
}

/* ------------------------------------------------------------------ */
/* the dialog body                                                     */
/* ------------------------------------------------------------------ */

/** createCleanupBody() -> { element, destroy(), run() } */
export function createCleanupBody(opts = {}) {
  ensureStyles();

  let ctx = { sites: [], folders: [], workspaces: [], hostKeys: {}, prefs: {}, orphans: [] };
  let loadError = null;
  const chosen = new Set();
  const listEl = h('div', { class: 'cu-list' });

  const search = createSearchBar({
    id: 'cleanup',
    persist: false,
    labelKey: 'search',
    placeholder: s('cuSearchPh'),
    appearanceKey: 'search-cleanup',
    appearanceLabel: 'Clean-up search',
    sampleProvider: () => CLEANUP_ROWS.map((r) => `${s(r.labelKey)}\n${s(r.descKey)}`).join('\n'),
    onChange: render,
  });

  const root = h('div', { class: 'cu' },
    h('p', { class: 'prose' }, t('cleanupBody')),
    search.element,
    h('div', { class: 'cu-tools' },
      h('button', {
        type: 'button', class: 'btn-text',
        onclick: () => { for (const r of CLEANUP_ROWS) if (r.count(ctx) > 0) chosen.add(r.id); render(); },
      }, s('cuSelectAll')),
      h('button', {
        type: 'button', class: 'btn-text',
        onclick: () => { chosen.clear(); render(); },
      }, s('cuSelectNone'))),
    listEl);
  appearanceTarget(root, 'cleanup-dialog', 'Clean-up dialog');

  function renderRow(row) {
    const n = row.count(ctx);
    const boxId = uid('cu-box');
    const box = h('input', {
      type: 'checkbox', id: boxId,
      onchange: () => { if (box.checked) chosen.add(row.id); else chosen.delete(row.id); },
    });
    box.checked = chosen.has(row.id);
    box.disabled = n === 0;
    const el = h('div', { class: `cu-row${n === 0 ? ' is-empty' : ''}` },
      box,
      h('div', { class: 'cu-main' },
        h('label', { class: 'cu-label', for: boxId }, icon(row.icon, 16), h('span', {}, s(row.labelKey))),
        h('div', { class: 'cu-desc' }, s(row.descKey))),
      h('span', {
        class: `cu-count${n === 0 ? ' is-zero' : ''}${n > 0 && row.danger ? ' is-danger' : ''}`,
      }, n === 0 ? s('cuNothing') : row.detail(ctx)));
    appearanceTarget(el, `cleanup-row-${row.id}`, `Clean-up: ${row.id}`);
    return el;
  }

  function render() {
    clear(listEl);
    if (loadError) listEl.appendChild(h('div', { class: 'cu-empty' }, loadError));
    const rows = search.isActive
      ? filterBy(CLEANUP_ROWS, search.predicate, (r) => [s(r.labelKey), s(r.descKey)])
      : CLEANUP_ROWS;
    if (!rows.length) {
      listEl.appendChild(h('div', { class: 'cu-empty' }, noMatchMessage(search.predicate, t('cleanupTitle'))));
      return;
    }
    for (const row of rows) listEl.appendChild(renderRow(row));
  }

  async function load() {
    try {
      const [doc, hostKeys, orphans] = await Promise.all([
        api.configGet(),
        callMain('config.hostKeys').catch(() => ({})),
        callMain('editor.orphans').catch(() => []),
      ]);
      ctx = {
        sites: (doc && doc.sites) || [],
        folders: (doc && doc.folders) || [],
        workspaces: (doc && doc.workspaces) || [],
        prefs: (doc && doc.prefs) || {},
        hostKeys: hostKeys || {},
        orphans: Array.isArray(orphans) ? orphans : [],
      };
      loadError = null;
    } catch (err) {
      loadError = err.message;
    }
    render();
  }

  /** The confirmation. Names every class and its exact count before anything
   *  is touched — a destructive list the user cannot audit is not a list. */
  function confirm() {
    const rows = CLEANUP_ROWS.filter((r) => chosen.has(r.id) && r.count(ctx) > 0);
    if (!rows.length) { notify.info(t('cleanupTitle'), s('cuNoneChosen')); return; }
    openModal({
      title: s('cuConfirmTitle'),
      width: 560,
      content: h('div', { class: 'stack' },
        h('p', { class: 'prose' }, s('cuConfirmBody')),
        h('ul', { class: 'cu-summary' },
          ...rows.map((r) => h('li', {}, compose((L) => `${L(r.labelKey)} — ${r.detail(ctx, L)}`)))),
        h('p', { class: 'prose' }, s('cuUndoNote'))),
      actions: [
        { label: t('cancel'), kind: 'text' },
        { label: s('cuConfirmBtn'), kind: 'danger', onSelect: () => runRemoval(rows) },
      ],
    });
  }

  async function runRemoval(rows) {
    const done = [];
    for (const row of rows) {
      try {
        const n = await row.remove(ctx);
        done.push({ key: row.labelKey, n });
      } catch (err) {
        // Composed per language: the row's name is itself translated, and
        // nesting it in a translated template interleaves the two.
        notify.error(t('cleanupTitle'), compose((L) => L('cuPartial', L(row.labelKey), err.message)));
      }
    }
    chosen.clear();
    await load();
    if (done.length) {
      const summary = compose((L) => L('cuDone', done.map((d) => `${L(d.key)} (${d.n})`).join(', ')));
      notify.success(t('cleanupTitle'), summary, {
        actions: [{ label: s('cuOpenHistory'), onSelect: () => openHistoryPanel() }],
      });
      announce(summary);
    }
    opts.onDone?.(done);
  }

  const unbind = bindRender(root, render);
  load();

  return {
    element: root,
    confirm,
    get chosen() { return [...chosen]; },
    refresh: load,
    destroy() { unbind(); search.destroy(); root.remove(); },
  };
}

/* ------------------------------------------------------------------ */
/* registration                                                        */
/* ------------------------------------------------------------------ */

let installed = false;

export function registerCleanupDialog() {
  if (installed) return;
  installed = true;
  ensureStyles();

  registerDialog('cleanup', () => {
    const body = createCleanupBody();
    return {
      title: t('cleanupTitle'),
      width: 660,
      content: body.element,
      onClose: () => body.destroy(),
      actions: [
        { label: t('close'), kind: 'text' },
        // OK in Cleanup.dfm performs the removal; here it opens the
        // confirmation first and keeps this dialog open behind it, so a
        // mistaken tick is still recoverable at the last step.
        { label: t('ok'), kind: 'filled', autofocus: true, onSelect: () => { body.confirm(); return true; } },
      ],
    };
  });

  registerCommand({
    id: 'app.cleanup', labelKey: 'cleanUp', icon: 'delete',
    run: () => openDialog('cleanup'),
  });
}

export function openCleanup() {
  registerCleanupDialog();
  return openDialog('cleanup');
}

if (typeof document !== 'undefined') {
  queueMicrotask(() => {
    try { registerCleanupDialog(); } catch (err) { console.error('[cleanup] registration failed', err); }
  });
}
