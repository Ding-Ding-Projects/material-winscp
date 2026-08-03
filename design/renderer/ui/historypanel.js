// ui/historypanel.js — the version-history panel over design/main/history.js.
//
// The history is a git repository beside the app's own data, holding one JSON
// document per revision. This panel is its reading room: browse, filter, diff,
// label and restore.
//
// Two properties of the store show through everywhere in here:
//
//   * HISTORY IS APPEND-ONLY. Restoring writes a NEW revision holding the old
//     state; the revision that was current a second ago is still in the log.
//     So an undo can be undone, and that undo undone in turn — which is what
//     makes a history panel safe to experiment in. The restore confirmation
//     says this in plain words rather than implying something was rewound.
//   * A HISTORY NOBODY CAN SEARCH IS AN ARCHIVE NOBODY OPENS. The date range,
//     the action filter and the text search all COMPOSE through the same
//     `composeFilters` the changelog uses; none of the three overrides another,
//     and the empty state names all of them.
//
// The actions in the filter are derived from the history itself (main's
// history:actions counts what is actually recorded), never from a hard-coded
// list that drifts away from what the app writes.

import {
  h, icon, clear, uid, appearanceTarget, announce, openModal, oneLine, copyText,
} from '../dom.js';
import { t, tIn, bindRender, getLanguage, getFunnyLevel } from '../i18n.js';
import { resolveI18n } from '../../winscp-i18n.js';
import { api, bus } from '../state.js';
import { styleSheet } from '../theme.js';
import { createSearchBar } from './searchbar.js';
import { notify } from './notifications.js';
import { registerContextMenu, SEPARATOR } from './contextmenu.js';
import {
  createDateRangeFilter, composeFilters, describeRange, rangeIsOpen, rangeContains,
  exportRangeStatement, isoDate, noMatchSentence,
} from './changelog.js';
import { registerDialog, registerCommand, openDialog } from '../app.js';

/* ------------------------------------------------------------------ */
/* module-local strings                                                */
/* ------------------------------------------------------------------ */

const STR = {
  hpTitle: ['Version history', '版本歷史'],
  hpSearchPh: ['Search revisions', '搜尋版本'],
  hpActions: ['Action', '動作'],
  hpAllActions: ['All actions', '所有動作'],
  hpRefresh: ['Refresh', '重新讀取'],
  hpExport: ['Export the history…', '匯出歷史…'],
  hpPrune: ['Apply retention…', '套用保留期…'],
  hpShowing: ['{0} of {1} revisions', '{1} 個版本入面顯示緊 {0} 個'],
  hpEmpty: [
    'Nothing in the history matches {0}.',
    '歷史入面冇嘢符合{0}。'],
  hpNoHistory: [
    'No revisions have been recorded yet. A revision appears here the first time a site, a setting or a workspace changes, or an unsaved document is discarded.',
    '暫時未錄到任何版本。第一次改站點、設定、工作區，或者捨棄未儲存文件嗰陣就會有嘢喺度出現。'],
  hpUnavailable: [
    'The version history is not reachable: {0}',
    '讀唔到版本歷史：{0}'],
  hpFilterDate: ['date range {0}', '日期範圍 {0}'],
  hpFilterAction: ['action {0}', '動作 {0}'],
  hpFilterSearch: ['the search {0}', '搜尋 {0}'],
  hpAnd: [' and ', '同埋'],
  hpDiff: ['Changes', '變更'],
  hpDiffLoad: ['Reading the difference…', '讀緊差異…'],
  hpDiffNone: ['This revision changed nothing that is recorded here.', '呢個版本冇改到呢度記低嘅任何嘢。'],
  hpDiffFirst: ['The first revision — everything in it is new.', '第一個版本——入面全部都係新嘅。'],
  hpAdded: ['Added', '新增'],
  hpRemoved: ['Removed', '移除'],
  hpChanged: ['Changed', '改咗'],
  hpSecretHidden: ['(changed — the value is protected and is not shown)', '（改咗——個值受保護，唔會顯示）'],
  hpRestore: ['Restore…', '還原…'],
  hpRestoreTitle: ['Restore revision {0}', '還原版本 {0}'],
  hpRestoreBody: [
    'This brings back the state recorded in revision {0} from {1}.\n\nNothing is rewound: the state you have right now is kept as its own revision, and restoring writes a NEW revision on top. You can undo this restore, and undo that undo, from this same panel.',
    '呢個會拎返版本 {0}（{1}）入面記低嘅狀態返嚟。\n\n冇任何嘢會被倒帶：你而家嘅狀態會照樣留低做一個版本，還原只係喺上面再寫一個新版本。你之後可以喺呢度撤銷呢次還原，仲可以撤銷嗰次撤銷。'],
  hpRestoreBtn: ['Restore', '還原'],
  hpRestored: ['Restored revision {0}. It was written as a new revision, so it can be undone.', '還原咗版本 {0}。佢係以新版本寫入，所以可以撤銷。'],
  hpRestoreFailed: ['The restore did not happen: {0}', '還原冇做到：{0}'],
  hpLabel: ['Label…', '加標籤…'],
  hpLabelTitle: ['Label revision {0}', '幫版本 {0} 加標籤'],
  hpLabelBody: [
    'A note attached to this revision so you can find it later. Labelling is itself a change, so it is recorded as its own revision.',
    '幫呢個版本寫個備註，方便日後搵返。加標籤本身都算一次改動，所以會自己記低做一個版本。'],
  hpLabelPh: ['e.g. before the migration', '例如：搬遷之前'],
  hpLabelSaved: ['Label saved for revision {0}.', '版本 {0} 嘅標籤儲咗。'],
  hpLabelFailed: ['The label was not saved: {0}', '標籤儲唔到：{0}'],
  hpCopyOid: ['Copy the revision id', '複製版本編號'],
  hpCopied: ['Revision {0} copied.', '版本 {0} 複製咗。'],
  hpExportTitle: ['Export the version history', '匯出版本歷史'],
  hpExportBody: [
    'The export contains every revision, including protected secrets in the encrypted form they are stored in. Keep the file where you would keep the configuration itself.',
    '匯出檔會包含每一個版本，連受保護嘅秘密都會以加密形式喺入面。呢個檔要好似設定檔咁樣收好。'],
  hpExported: ['History exported to {0}.', '歷史匯出咗去 {0}。'],
  hpExportFailed: ['The export did not happen: {0}', '匯出冇做到：{0}'],
  hpPruneTitle: ['Apply the retention policy', '套用保留期'],
  hpPruneBody: [
    'Revisions older than the configured retention window, and anything beyond the configured maximum, are removed permanently. The oldest revision that is kept still holds the FULL state, so restoring stays possible — what is lost is the intermediate steps.\n\nThis is the one action in this panel that removes data, and it cannot be undone.',
    '過咗保留期，或者超出咗上限嘅版本會被永久刪走。留低嘅最舊嗰個版本仍然有完整狀態，所以照樣還原到——冇咗嘅係中間嗰啲步驟。\n\n呢個係呢版入面唯一會刪嘢嘅動作，做完唔可以復原。'],
  hpPruneBtn: ['Remove them', '刪走佢哋'],
  hpPruned: ['{0} revision(s) removed, {1} kept.', '刪咗 {0} 個版本，留低 {1} 個。'],
  hpPruneNone: ['Nothing aged out — no revision was removed.', '冇版本過期——一個都冇刪。'],
  hpNoBridge: [
    'The version history lives in the application’s main process, which this window cannot reach right now.',
    '版本歷史喺程式嘅主行程度，呢個視窗而家去唔到嗰邊。'],
  actCreated: ['Created', '新增'],
  actUpdated: ['Updated', '更新'],
  actDeleted: ['Deleted', '刪除'],
  actRestored: ['Restored', '還原'],
  actUndone: ['Undone', '撤銷'],
  actImported: ['Imported', '匯入'],
  actDiscarded: ['Discarded', '捨棄'],
  actSettings: ['Settings changed', '改設定'],
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

/**
 * Build a sentence from several strings without interleaving the languages —
 * see the note on `compose` in ui/changelog.js. Used for the empty state,
 * which names three filters and would otherwise read as alternating halves.
 */
function compose(build) {
  const mode = getLanguage();
  const make = (language) => build((key, ...params) => strIn(language, key, ...params), language);
  if (mode !== 'both') return make(mode);
  const en = make('en');
  const yue = make('yue');
  return en === yue ? en : `${en} · ${yue}`;
}

/**
 * The paragraphs of a multi-paragraph string, one language at a time — the same
 * rule as `compose`, applied to block text. Resolving first and splitting after
 * joins the WHOLE English text to the WHOLE Cantonese one, so the split fuses
 * the last English paragraph to the first Cantonese one and orphans the rest.
 */
function paragraphs(key, ...params) {
  const mode = getLanguage();
  const split = (language) => strIn(language, key, ...params).split('\n\n');
  if (mode !== 'both') return split(mode);
  const en = split('en');
  const yue = split('yue');
  const out = [];
  for (let i = 0; i < Math.max(en.length, yue.length); i += 1) {
    const a = en[i] || '';
    const b = yue[i] || '';
    out.push(a && b && a !== b ? `${a} · ${b}` : (a || b));
  }
  return out;
}

/** Every action main derives, named. An action it invents later still shows —
 *  the list is built from the data and this only supplies a nicer label. */
const ACTION_LABELS = {
  created: 'actCreated', updated: 'actUpdated', deleted: 'actDeleted',
  restored: 'actRestored', undone: 'actUndone', imported: 'actImported',
  discarded: 'actDiscarded',
  settings: 'actSettings',
};
export function actionLabel(action, L = s) {
  const key = ACTION_LABELS[action];
  return key ? L(key) : String(action);
}

/* ------------------------------------------------------------------ */
/* the main-process bridge                                             */
/* ------------------------------------------------------------------ */
// state.js owns the `api` façade and does not carry the history capabilities
// yet. Rather than reach for window.api (which no module may do), this goes
// through the façade's own `raw` handle and unwraps main's { ok, value }
// envelope in one place, so the no-bridge path is handled once.

async function callMain(path, ...args) {
  const raw = api.raw;
  if (!raw) { const e = new Error(s('hpNoBridge')); e.code = 'NO_BRIDGE'; throw e; }
  let owner = null;
  let fn = raw;
  for (const seg of path.split('.')) { owner = fn; fn = fn == null ? undefined : fn[seg]; }
  if (typeof fn !== 'function') { const e = new Error(`The application bridge has no ${path}().`); e.code = 'NO_BRIDGE'; throw e; }
  const res = await fn.apply(owner, args);
  if (res && typeof res === 'object' && 'ok' in res) {
    if (res.ok) return res.value;
    const err = new Error((res.error && res.error.message) || 'The call failed.');
    if (res.error && res.error.code) err.code = res.error.code;
    if (res.error && res.error.detail) err.detail = res.error.detail;
    throw err;
  }
  return res;
}

/* ------------------------------------------------------------------ */
/* secrets in diffs                                                    */
/* ------------------------------------------------------------------ */

/** Paths whose value is a credential, however it is spelled in the document. */
const SECRET_PATH_RE = /(^|\.)(password|passphrase|secret|token|credential|apikey|api_key|privatekey|private_key|tunnelpassword|proxypassword|encryptkey|sessionkey)(\.|$)/i;

/**
 * A diff line must show THAT a value changed and never WHAT it changed to when
 * the value is a credential. The store keeps those fields encrypted, so the
 * ciphertext would be harmless — but a diff that prints ciphertext teaches the
 * reader that this panel prints secrets, and the next field might not be
 * encrypted.
 */
export function isSecretPath(path) { return SECRET_PATH_RE.test(String(path || '')); }

/**
 * The path is not always the leaf. `history.diff` walks to scalars, so its
 * paths reach `sites.0.password` and the check above catches them — but the
 * FIRST revision has no predecessor to diff against, so its rows carry whole
 * subtrees under a top-level path (`sites`) that is not itself secret. Printing
 * that subtree raw would put every stored credential on screen, which is the
 * one thing this panel promises not to do. So a value that is rendered whole is
 * scrubbed by key name before it is ever turned into text.
 */
function scrubSecrets(value) {
  if (Array.isArray(value)) return value.map(scrubSecrets);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = isSecretPath(k) ? s('hpSecretHidden') : scrubSecrets(v);
    return out;
  }
  return value;
}

export function renderDiffValue(path, value) {
  if (isSecretPath(path)) return s('hpSecretHidden');
  if (value === undefined) return '—';
  if (value === null) return 'null';
  if (typeof value === 'string') return value.length > 200 ? `${value.slice(0, 199)}…` : value;
  if (typeof value === 'object') {
    const json = JSON.stringify(scrubSecrets(value));
    return json.length > 200 ? `${json.slice(0, 199)}…` : json;
  }
  return String(value);
}

/* ------------------------------------------------------------------ */
/* styles                                                              */
/* ------------------------------------------------------------------ */

let stylesWritten = false;
function ensureStyles() {
  if (stylesWritten || typeof document === 'undefined') return;
  stylesWritten = true;
  styleSheet('historypanel').set(`
.hp { display: flex; flex-direction: column; gap: calc(10px * var(--den)); min-height: 0; }
.hp-tools { display: flex; flex-direction: column; gap: calc(8px * var(--den)); }
.hp-actionbar { display: flex; align-items: center; gap: calc(6px * var(--den)); flex-wrap: wrap; }
.hp-actions { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.hp-act { display: inline-flex; align-items: center; gap: 5px; min-height: calc(28px * var(--den));
  padding: 0 calc(10px * var(--den)); border-radius: var(--shape-full);
  border: 1px solid var(--outline-var); background: var(--c-lowest); color: var(--onsfc);
  font-size: var(--type-label-sm); }
.hp-act.is-on { background: var(--secc); color: var(--onsecc); border-color: transparent; font-weight: 600; }
.hp-act:disabled { opacity: .45; cursor: default; }
.hp-act-count { font-variant-numeric: tabular-nums; opacity: .8; }
.hp-count { font-size: var(--type-label-md); color: var(--onsv); }
.hp-list { display: flex; flex-direction: column; gap: calc(6px * var(--den));
  overflow: auto; min-height: 0; padding-right: 2px; }
.hp-row { background: var(--c-low); border-radius: var(--shape-md); padding: calc(9px * var(--den));
  display: flex; flex-direction: column; gap: calc(6px * var(--den)); }
.hp-row-main { display: flex; align-items: center; gap: calc(8px * var(--den)); flex-wrap: wrap; }
.hp-time { font-size: var(--type-label-sm); color: var(--onsv); font-variant-numeric: tabular-nums; }
.hp-action { display: inline-flex; align-items: center; min-height: calc(20px * var(--den));
  padding: 0 calc(8px * var(--den)); border-radius: var(--shape-full);
  background: var(--terc); color: var(--onterc); font-size: var(--type-label-sm); font-weight: 600; }
.hp-label { flex: 1 1 18ch; min-width: 0; line-height: 1.4; }
.hp-note { font-size: var(--type-label-sm); color: var(--onpc); background: var(--pc);
  border-radius: var(--shape-xs); padding: 1px calc(7px * var(--den)); }
.hp-oid { font-size: var(--type-label-sm); color: var(--onsv); }
.hp-row-tools { display: flex; align-items: center; gap: 2px; margin-left: auto; }
.hp-diff { border-top: 1px solid var(--outline-var); padding-top: calc(6px * var(--den));
  display: flex; flex-direction: column; gap: 3px; max-height: calc(320px * var(--uiscale)); overflow: auto; }
.hp-diff-row { display: grid; grid-template-columns: calc(10ch * var(--uiscale)) 1fr; gap: calc(8px * var(--den));
  font-size: var(--type-label-sm); line-height: 1.45; }
.hp-diff-kind { font-weight: 700; color: var(--onsv); }
.hp-diff-path { word-break: break-word; }
.hp-diff-val { color: var(--onsv); word-break: break-word; }
.hp-empty { padding: calc(20px * var(--den)); text-align: center; color: var(--onsv);
  line-height: 1.55; background: var(--c-low); border-radius: var(--shape-md); }
.hp-error { background: var(--errc); color: var(--onerrc); }
`);
}

/* ------------------------------------------------------------------ */
/* the panel                                                           */
/* ------------------------------------------------------------------ */

function fmtTime(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * createHistoryPanel() -> { element, destroy(), refresh() }
 *
 * The three filters are handed to `composeFilters` in one array, which is what
 * guarantees they intersect. Adding a fourth is one more entry in that array,
 * and it cannot accidentally become an override.
 */
export function createHistoryPanel(opts = {}) {
  ensureStyles();

  let rows = [];                 // every revision, newest first
  let derivedActions = [];       // [{ action, count }] as main recorded them
  const selectedActions = new Set();
  const expanded = new Set();
  const diffCache = new Map();
  let labels = {};               // oid -> user note, from prefs.versionHistory.labels
  let loadError = null;
  let destroyed = false;

  const list = h('div', { class: 'hp-list' });
  const count = h('span', { class: 'hp-count', role: 'status' });
  const actionsRow = h('div', { class: 'hp-actions', role: 'group', 'aria-label': s('hpActions') });

  const search = createSearchBar({
    id: opts.searchId || 'history-panel',
    persist: opts.persist !== false,
    labelKey: 'search',
    placeholder: s('hpSearchPh'),
    appearanceKey: 'search-history',
    appearanceLabel: 'History search',
    sampleProvider: () => rows.map((r) => `${r.label} ${r.action} ${r.short}`).join('\n'),
    onChange: render,
  });

  const dates = createDateRangeFilter({
    id: 'history-dates',
    appearanceKey: 'date-filter-history',
    appearanceLabel: 'History date filter',
    onChange: render,
  });

  const refreshBtn = h('button', {
    type: 'button', class: 'btn-text', onclick: () => refresh(),
  }, icon('refresh', 16), s('hpRefresh'));

  const exportBtn = h('button', {
    type: 'button', class: 'btn-text', onclick: () => exportHistory(),
  }, icon('file_download', 16), s('hpExport'));

  const pruneBtn = h('button', {
    type: 'button', class: 'btn-text', onclick: () => confirmPrune(),
  }, icon('delete', 16), s('hpPrune'));

  const root = h('div', { class: 'hp' },
    h('div', { class: 'hp-tools' },
      search.element,
      dates.element,
      actionsRow,
      h('div', { class: 'hp-actionbar' }, count, h('span', { class: 'spacer' }), refreshBtn, exportBtn, pruneBtn)),
    list);
  appearanceTarget(root, 'history-panel', 'Version history panel');

  /* ---------------- filtering ---------------- */

  function textOf(row) {
    return [row.label, row.action, row.short, labels[row.oid] || '', fmtTime(row.time)];
  }

  function filters() {
    const predicate = search.predicate;
    return [
      {
        id: 'date',
        label: describeRange(dates.range),
        active: !rangeIsOpen(dates.range),
        test: (r) => rangeContains(dates.range, r.time),
      },
      {
        id: 'action',
        label: [...selectedActions].join(', '),
        active: selectedActions.size > 0,
        test: (r) => selectedActions.has(r.action),
      },
      {
        id: 'search',
        label: predicate.describe,
        active: search.isActive && predicate.ok,
        test: (r) => textOf(r).some((v) => predicate.test(v)),
      },
    ];
  }

  /** Counts for the action chips under the OTHER two filters, so an action
   *  with nothing left in range shows 0 rather than vanishing and making the
   *  filter appear to change shape. */
  function actionCounts() {
    const others = filters().filter((f) => f.id !== 'action');
    const { rows: visible } = composeFilters(rows, others);
    const counts = new Map();
    for (const a of derivedActions) counts.set(a.action, 0);
    for (const r of visible) counts.set(r.action, (counts.get(r.action) || 0) + 1);
    return counts;
  }

  function currentRows() {
    return composeFilters(rows, filters()).rows;
  }

  /* ---------------- rendering ---------------- */

  function renderActionChips() {
    const counts = actionCounts();
    clear(actionsRow);
    const known = derivedActions.length ? derivedActions.map((a) => a.action) : [...counts.keys()];
    if (!known.length) return;
    for (const action of known) {
      const on = selectedActions.has(action);
      const btn = h('button', {
        type: 'button',
        class: `hp-act${on ? ' is-on' : ''}`,
        'aria-pressed': String(on),
        onclick: () => {
          if (selectedActions.has(action)) selectedActions.delete(action);
          else selectedActions.add(action);
          render();
        },
      }, h('span', {}, actionLabel(action)), h('span', { class: 'hp-act-count' }, String(counts.get(action) || 0)));
      appearanceTarget(btn, `history-action-${action}`, `History action filter: ${action}`);
      actionsRow.appendChild(btn);
    }
    if (selectedActions.size) {
      actionsRow.appendChild(h('button', {
        type: 'button', class: 'hp-act',
        onclick: () => { selectedActions.clear(); render(); },
      }, s('hpAllActions')));
    }
  }

  function renderDiff(row, index, host) {
    const cached = diffCache.get(row.oid);
    clear(host);
    if (cached === undefined) {
      host.appendChild(h('div', { class: 'muted' }, s('hpDiffLoad')));
      const previous = rows[index + 1];
      const request = previous
        ? callMain('history.diff', previous.oid, row.oid)
        : callMain('history.read', row.oid).then((state) => ({
          added: Object.keys(state || {}).map((k) => ({ path: k, to: state[k] })),
          removed: [], changed: [], count: Object.keys(state || {}).length, first: true,
        }));
      request.then((d) => {
        diffCache.set(row.oid, d);
        if (host.isConnected) renderDiff(row, index, host);
      }).catch((err) => {
        diffCache.set(row.oid, { error: err.message });
        if (host.isConnected) renderDiff(row, index, host);
      });
      return;
    }
    if (cached.error) {
      host.appendChild(h('div', { class: 'hp-empty hp-error' }, cached.error));
      return;
    }
    if (cached.first) host.appendChild(h('div', { class: 'muted' }, s('hpDiffFirst')));
    const groups = [
      ['hpAdded', cached.added || [], (x) => renderDiffValue(x.path, x.to)],
      ['hpRemoved', cached.removed || [], (x) => renderDiffValue(x.path, x.from)],
      ['hpChanged', cached.changed || [], (x) => `${renderDiffValue(x.path, x.from)} → ${renderDiffValue(x.path, x.to)}`],
    ];
    let any = false;
    for (const [labelKey, items, value] of groups) {
      for (const item of items) {
        any = true;
        host.appendChild(h('div', { class: 'hp-diff-row' },
          h('span', { class: 'hp-diff-kind' }, s(labelKey)),
          h('span', {},
            h('span', { class: 'hp-diff-path mono' }, item.path),
            h('span', { class: 'hp-diff-val' }, ` — ${value(item)}`))));
      }
    }
    if (!any) host.appendChild(h('div', { class: 'muted' }, s('hpDiffNone')));
  }

  function renderRow(row, index) {
    const note = labels[row.oid];
    const diffHost = h('div', { class: 'hp-diff', hidden: !expanded.has(row.oid) });
    const diffId = uid('hp-diff');
    diffHost.id = diffId;

    const toggle = h('button', {
      type: 'button', class: 'icon-btn',
      'aria-expanded': String(expanded.has(row.oid)),
      'aria-controls': diffId,
      title: s('hpDiff'), 'aria-label': `${s('hpDiff')} — ${row.label}`,
      onclick: () => {
        if (expanded.has(row.oid)) expanded.delete(row.oid); else expanded.add(row.oid);
        render();
      },
    }, icon(expanded.has(row.oid) ? 'expand_less' : 'expand_more', 18));

    const restoreBtn = h('button', {
      type: 'button', class: 'btn-text', onclick: () => confirmRestore(row),
    }, icon('restart_alt', 16), s('hpRestore'));

    const labelBtn = h('button', {
      type: 'button', class: 'icon-btn', title: s('hpLabel'), 'aria-label': `${s('hpLabel')} ${row.short}`,
      onclick: () => promptLabel(row),
    }, icon('label', 17));

    const card = h('div', { class: 'hp-row' },
      h('div', { class: 'hp-row-main' },
        toggle,
        h('span', { class: 'hp-time mono' }, fmtTime(row.time)),
        h('span', { class: 'hp-action' }, actionLabel(row.action)),
        h('span', { class: 'hp-label', title: row.label }, row.label),
        note ? h('span', { class: 'hp-note', title: note }, oneLine(note, 40)) : null,
        h('span', { class: 'hp-oid mono' }, row.short),
        h('span', { class: 'hp-row-tools' }, labelBtn, restoreBtn)),
      diffHost);
    appearanceTarget(card, 'history-row', 'History revision row');

    // The row is the only provider on this subtree — its buttons register none
    // of their own — so there is nothing to suppress here and every entry
    // appears exactly once.
    registerContextMenu(card, () => [
      { label: s('hpDiff'), icon: 'vertical_split', onSelect: () => { expanded.add(row.oid); render(); } },
      { label: s('hpLabel'), icon: 'label', onSelect: () => promptLabel(row) },
      { label: s('hpRestore'), icon: 'restart_alt', onSelect: () => confirmRestore(row) },
      SEPARATOR,
      {
        label: s('hpCopyOid'),
        icon: 'content_copy',
        onSelect: async () => {
          const ok = await copyText(row.oid);
          if (ok) notify.success(s('hpTitle'), s('hpCopied', row.short));
          else notify.error(s('hpTitle'), 'The clipboard refused the copy.');
        },
      },
    ]);

    if (expanded.has(row.oid)) renderDiff(row, index, diffHost);
    return card;
  }

  function render() {
    if (destroyed) return;
    renderActionChips();
    const visible = currentRows();
    count.textContent = s('hpShowing', visible.length, rows.length);
    clear(list);

    if (loadError) {
      list.appendChild(h('div', { class: 'hp-empty hp-error' }, s('hpUnavailable', loadError)));
      return;
    }
    if (!rows.length) {
      list.appendChild(h('div', { class: 'hp-empty' }, s('hpNoHistory')));
      return;
    }
    if (!visible.length) {
      const sentence = compose((L) => {
        const parts = [];
        if (!rangeIsOpen(dates.range)) parts.push(L('hpFilterDate', describeRange(dates.range, L)));
        if (selectedActions.size) parts.push(L('hpFilterAction', [...selectedActions].map((a) => actionLabel(a, L)).join(', ')));
        if (search.isActive) parts.push(L('hpFilterSearch', search.predicate.describe));
        return L('hpEmpty', noMatchSentence(parts, describeRange(dates.range, L), L));
      });
      list.appendChild(h('div', { class: 'hp-empty' }, sentence));
      return;
    }
    const indexOf = new Map(rows.map((r, i) => [r.oid, i]));
    for (const row of visible) list.appendChild(renderRow(row, indexOf.get(row.oid)));
  }

  /* ---------------- data ---------------- */

  async function loadLabels() {
    try {
      const doc = await api.configGet();
      const prefs = doc && doc.prefs ? doc.prefs : doc;
      labels = (prefs && prefs.versionHistory && prefs.versionHistory.labels) || {};
    } catch { labels = {}; }
  }

  async function refresh() {
    try {
      loadError = null;
      const [list_, actions_] = await Promise.all([
        callMain('history.list', {}),
        callMain('history.actions').catch(() => []),
      ]);
      rows = Array.isArray(list_) ? list_ : [];
      derivedActions = Array.isArray(actions_) ? actions_ : [];
      diffCache.clear();
      await loadLabels();
    } catch (err) {
      loadError = err.message;
      rows = [];
      derivedActions = [];
    }
    render();
  }

  /* ---------------- operations ---------------- */

  function confirmRestore(row) {
    openModal({
      title: s('hpRestoreTitle', row.short),
      width: 560,
      content: h('div', { class: 'stack' },
        ...paragraphs('hpRestoreBody', row.short, fmtTime(row.time)).map((p) => h('p', { class: 'prose' }, p)),
        h('p', { class: 'prose muted' }, row.label)),
      actions: [
        { label: t('cancel'), kind: 'text' },
        {
          label: s('hpRestoreBtn'),
          kind: 'filled',
          autofocus: true,
          onSelect: async () => {
            try {
              await callMain('history.restore', row.oid, `Restored revision ${row.short} — ${row.label}`);
              notify.success(s('hpTitle'), s('hpRestored', row.short));
              announce(s('hpRestored', row.short));
              await refresh();
            } catch (err) {
              notify.error(s('hpTitle'), s('hpRestoreFailed', err.message));
            }
          },
        },
      ],
    });
  }

  function promptLabel(row) {
    const inputId = uid('hp-label');
    const input = h('input', { type: 'text', class: 'field-input', id: inputId, autocomplete: 'off' });
    input.value = labels[row.oid] || '';
    openModal({
      title: s('hpLabelTitle', row.short),
      width: 520,
      content: h('div', { class: 'stack' },
        h('p', { class: 'prose' }, s('hpLabelBody')),
        h('label', { class: 'field', for: inputId },
          h('span', { class: 'field-label' }, s('hpLabel')),
          input)),
      actions: [
        { label: t('cancel'), kind: 'text' },
        {
          label: t('save'),
          kind: 'filled',
          onSelect: async () => {
            const next = { ...labels };
            const text = input.value.trim();
            if (text) next[row.oid] = text; else delete next[row.oid];
            try {
              await callMain('config.setPref', 'versionHistory.labels', next,
                text ? `Labelled revision ${row.short}` : `Removed the label on revision ${row.short}`);
              labels = next;
              notify.success(s('hpTitle'), s('hpLabelSaved', row.short));
              await refresh();
            } catch (err) {
              notify.error(s('hpTitle'), s('hpLabelFailed', err.message));
            }
          },
        },
      ],
    });
    requestAnimationFrame(() => { input.focus(); input.select(); });
  }

  async function exportHistory() {
    const visible = currentRows();
    const statement = exportRangeStatement({
      scope: 'WinSCP Material — version history',
      range: dates.range,
      search: search.isActive ? search.predicate.describe : '',
      actions: [...selectedActions],
      shown: visible.length,
      total: rows.length,
    });
    openModal({
      title: s('hpExportTitle'),
      width: 560,
      content: h('div', { class: 'stack' },
        h('p', { class: 'prose' }, s('hpExportBody')),
        h('pre', { class: 'mono', style: { whiteSpace: 'pre-wrap', margin: 0 } }, statement)),
      actions: [
        { label: t('cancel'), kind: 'text' },
        {
          label: t('export_'),
          kind: 'filled',
          autofocus: true,
          onSelect: async () => {
            try {
              const picked = await callMain('app.pickPath', {
                save: true,
                title: s('hpExportTitle'),
                defaultPath: `winscp-material-history-${isoDate(Date.now())}.json`,
              });
              const file = Array.isArray(picked) ? picked[0] : picked;
              if (!file) return;
              const written = await callMain('history.export', file, {
                oids: visible.map((row) => row.oid),
                statement,
              });
              notify.success(s('hpTitle'), s('hpExported', written || file));
            } catch (err) {
              notify.error(s('hpTitle'), s('hpExportFailed', err.message));
            }
          },
        },
      ],
    });
  }

  function confirmPrune() {
    openModal({
      title: s('hpPruneTitle'),
      width: 560,
      content: h('div', { class: 'stack' },
        ...paragraphs('hpPruneBody').map((p) => h('p', { class: 'prose' }, p))),
      actions: [
        { label: t('cancel'), kind: 'text' },
        {
          label: s('hpPruneBtn'),
          kind: 'danger',
          onSelect: async () => {
            try {
              const res = await callMain('history.prune');
              if (res && res.pruned) notify.warning(s('hpTitle'), s('hpPruned', res.pruned, res.kept));
              else notify.info(s('hpTitle'), s('hpPruneNone'));
              await refresh();
            } catch (err) {
              notify.error(s('hpTitle'), err.message);
            }
          },
        },
      ],
    });
  }

  const unbind = bindRender(root, render);
  // A revision written anywhere else in the app (a save, an import, a restore)
  // is a row this panel should already be showing.
  const offConfig = bus.on('config:document', () => { refresh(); });
  refresh();

  return {
    element: root,
    refresh,
    get rows() { return currentRows(); },
    destroy() {
      destroyed = true;
      unbind();
      offConfig();
      search.destroy();
      dates.destroy();
      root.remove();
    },
  };
}

/* ------------------------------------------------------------------ */
/* registration                                                        */
/* ------------------------------------------------------------------ */

let installed = false;

export function registerHistoryPanel() {
  if (installed) return;
  installed = true;
  ensureStyles();

  registerDialog('versionHistory', () => {
    const panel = createHistoryPanel();
    return {
      title: s('hpTitle'),
      width: 900,
      content: panel.element,
      onClose: () => panel.destroy(),
      actions: [{ label: t('close'), kind: 'filled', autofocus: true }],
    };
  });

  registerCommand({
    id: 'app.versionHistory',
    labelKey: 'versionHistory',
    icon: 'history',
    run: () => openDialog('versionHistory'),
  });
}

export function openHistoryPanel() {
  registerHistoryPanel();
  return openDialog('versionHistory');
}

if (typeof document !== 'undefined') {
  queueMicrotask(() => {
    try { registerHistoryPanel(); } catch (err) { console.error('[historypanel] registration failed', err); }
  });
}
