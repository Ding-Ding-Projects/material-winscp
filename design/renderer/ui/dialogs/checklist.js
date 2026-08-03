// ui/dialogs/checklist.js — the Synchronization Checklist
// (SynchronizeChecklist.dfm, core/RemoteFiles.h TSynchronizeChecklist).
//
// This is the dialog that stops somebody destroying a directory. Everything in
// it is arranged around one question — WHAT WILL HAPPEN IF I PRESS OK — and
// that question is answered in words, above the list, before the button can be
// reached. Clarity here is a correctness requirement, not a design preference.
//
// Three parts, in order of importance:
//
//   1. `summarizeChecklist` / `describeChecklist` — the plain statement of
//      consequence, derived from the same items the apply path reads, so the
//      sentence and the action cannot disagree.
//   2. the override rules — which actions a given comparison row may be changed
//      to, and why not. A row whose two sides are a file and a directory, or a
//      row in timestamp mode, genuinely has fewer legal answers, and offering
//      one that the engine would refuse is how a user learns to distrust a
//      dialog.
//   3. the apply path. design/main/sync.js's `apply()` reads `item.action` from
//      the checklist IT holds, and sync:apply only carries the ticked flags
//      back, so an OVERRIDDEN row cannot be expressed through that call. Those
//      rows are therefore excluded from the flags and performed here through
//      the same primitives sync.js would have used — queue:add for a transfer,
//      fs:remove / fs:localRemove for a deletion. See `partitionForApply`.

import {
  h, icon, clear, uid, appearanceTarget, openModal, announce, copyText,
} from '../../dom.js';
import { t, bindText } from '../../i18n.js';
import { notify } from '../notifications.js';
import { createSearchBar, filterBy, noMatchMessage } from '../searchbar.js';
import { registerContextMenu, SEPARATOR } from '../contextmenu.js';
import { defineStrings, injectTransferStyles, formatBytes, bridge, queueModel } from '../queue.js';
import { messageDialog } from './messagedlg.js';

defineStrings({
  txClTitle: ['Synchronization checklist', '同步清單'],
  txClWhatHappens: ['What will happen when you press {0}', '撳「{0}」之後會發生咩事'],
  txClNothing: ['Nothing is ticked, so nothing will happen.', '一個都冇剔，所以乜都唔會做。'],
  txClEmptySourceDelete: ['The source has no visible files under the current filter. Confirming will delete the selected target files.', '來源喺目前篩選之下冇可見檔案。確認後會刪除已選嘅目標檔案。'],
  txClUploads: ['{0} item(s) will be uploaded to the remote side ({1}).', '{0} 個項目會上載去遠端（{1}）。'],
  txClDownloads: ['{0} item(s) will be downloaded to the local side ({1}).', '{0} 個項目會下載落本機（{1}）。'],
  txClTimestamps: ['{0} item(s) will have only their modification time changed. No file contents are transferred.', '{0} 個項目淨係改修改時間，唔會傳輸內容。'],
  txClDeleteLocal: ['{0} item(s) will be DELETED from the local side.', '{0} 個項目會喺本機度被刪除。'],
  txClDeleteRemote: ['{0} item(s) will be DELETED from the remote side.', '{0} 個項目會喺遠端度被刪除。'],
  txClDeleteWarn: [[
    'Deletions happen immediately and cannot be undone from this dialog.',
    'Deletions happen immediately and there is no undo here.',
    'Deletions land instantly, and this dialog has no undo button hiding anywhere.',
    'Deletions go through the moment you confirm, and nothing in this dialog can bring them back.',
    'Deletions go through the very second you confirm, and no amount of staring at this dialog afterwards will bring them back.'], [
    '刪除會即刻執行，喺呢個對話框度冇得復原。',
    '刪除即刻做，呢度冇得 undo。',
    '刪除即刻生效，呢個對話框冇匿埋任何復原掣。',
    '你一確認刪除就即刻執行，呢個對話框冇任何嘢救得返。',
    '你一確認，刪除即刻執行，之後對住呢個對話框望到眼突都救唔返。']],
  txClNothingSelected: ['Nothing to synchronize: the two directories already match.', '冇嘢要同步：兩邊目錄已經一樣。'],
  txClCheckAll: ['Tick everything', '全部剔'],
  txClUncheckAll: ['Untick everything', '全部唔剔'],
  txClCheckDirectory: ['Tick every actionable item in this directory', '呢個目錄入面可以做嘅全部剔'],
  txClUncheckDirectory: ['Untick every item in this directory', '呢個目錄入面全部唔剔'],
  txClReverse: ['Reverse the direction', '調轉方向'],
  txClInvert: ['Invert the selection', '反轉選取'],
  txClGroup: ['Group by directory', '按目錄分組'],
  txClSort: ['Sort checklist', '排序清單'],
  txClCalculate: ['Calculate selected actions', '計算已選動作'],
  txClSearchPh: ['Search the checklist', '搵清單'],
  txClScope: ['this checklist', '呢張清單'],
  txClApply: ['Synchronize', '開始同步'],
  txClActionOf: ['Action for {0}', '{0} 嘅動作'],
  txClActUpload: ['Upload', '上載'],
  txClActDownload: ['Download', '下載'],
  txClActDeleteLocal: ['Delete locally', '刪本機'],
  txClActDeleteRemote: ['Delete on the server', '刪遠端'],
  txClActNothing: ['Do nothing', '唔做嘢'],
  txClReasonNewOnLocal: ['Only on the local side', '淨係本機有'],
  txClReasonNewOnRemote: ['Only on the remote side', '淨係遠端有'],
  txClReasonLocalNewer: ['The local file is newer', '本機檔案新啲'],
  txClReasonRemoteNewer: ['The remote file is newer', '遠端檔案新啲'],
  txClReasonSizeDiffers: ['The two files are different sizes', '兩個檔案大細唔同'],
  txClReasonNotOnLocal: ['Missing on the local side', '本機冇'],
  txClReasonNotOnRemote: ['Missing on the remote side', '遠端冇'],
  txClReasonTypeMismatch: ['One side is a directory and the other is a file', '一邊係目錄另一邊係檔案'],
  txClReasonIdentical: ['The two sides already match', '兩邊已經一樣'],
  txClReasonDirectory: ['Directory', '目錄'],
  txClNoUpload: ['There is nothing on the local side to upload.', '本機冇嘢可以上載。'],
  txClNoDownload: ['There is nothing on the remote side to download.', '遠端冇嘢可以下載。'],
  txClNoDeleteLocal: ['There is nothing on the local side to delete.', '本機冇嘢可以刪。'],
  txClNoDeleteRemote: ['There is nothing on the remote side to delete.', '遠端冇嘢可以刪。'],
  txClNoDeleteTimestamp: ['Timestamp mode never deletes anything.', '時間戳模式永遠唔會刪嘢。'],
  txClNoTimestampReverse: ['A timestamp-only row can keep its proposed direction or be skipped; reversing it would transfer file contents.', '淨係改時間戳嘅一行可以照原定方向做，或者跳過；調轉方向會變成傳輸檔案內容。'],
  txClNoTypeMismatch: ['A directory on one side and a file on the other is never resolved automatically. Fix it by hand.', '一邊目錄一邊檔案，永遠唔會自動處理，要自己手動搞掂。'],
  txClNoReverse: ['This row cannot be reversed: {0}', '呢一行調轉唔到：{0}'],
  txClNoReverseNothing: ['A row set to Do nothing has no direction to reverse.', '設定咗唔做嘢嘅一行冇方向可以調轉。'],
  txClConfirmTitle: ['Confirm the synchronization', '確認同步'],
  txClApplied: ['{0} transfer(s) queued, {1} deletion(s) performed.', '排咗 {0} 單傳輸，刪咗 {1} 個項目。'],
  txClApplyFailed: ['{0} item(s) could not be applied.', '{0} 個項目做唔到。'],
  txClExpired: ['That comparison is no longer available. Run the comparison again.', '嗰個比較結果已經冇咗，要再比較過。'],
  txClNoBridge: ['The synchronization engine is not reachable from this window, so nothing can be applied.', '呢個視窗連唔到同步引擎，所以乜都做唔到。'],
  txClCopyList: ['Copy the checklist', '複製清單'],
  txClOnlyChecked: ['Only ticked items are acted on.', '淨係處理剔咗嘅項目。'],
  txClOverridden: ['{0} row(s) had their action changed by hand and are applied directly.', '{0} 行俾人手改咗動作，會直接執行。'],
});

/* ================================================================== */
/* pure rules                                                          */
/* ================================================================== */

/** The five actions design/main/sync.js recognises. */
export const CHECKLIST_ACTIONS = ['upload', 'download', 'deleteLocal', 'deleteRemote', 'nothing'];

const ACTION_LABEL_KEYS = {
  upload: 'txClActUpload',
  download: 'txClActDownload',
  deleteLocal: 'txClActDeleteLocal',
  deleteRemote: 'txClActDeleteRemote',
  nothing: 'txClActNothing',
};

const REASON_KEYS = {
  'new-on-local': 'txClReasonNewOnLocal',
  'new-on-remote': 'txClReasonNewOnRemote',
  'local-newer': 'txClReasonLocalNewer',
  'remote-newer': 'txClReasonRemoteNewer',
  'size-differs': 'txClReasonSizeDiffers',
  'not-on-local': 'txClReasonNotOnLocal',
  'not-on-remote': 'txClReasonNotOnRemote',
  'type-mismatch': 'txClReasonTypeMismatch',
  identical: 'txClReasonIdentical',
  directory: 'txClReasonDirectory',
};

export function actionLabelKey(action) { return ACTION_LABEL_KEYS[action] || 'txClActNothing'; }
export function reasonLabelKey(reason) { return REASON_KEYS[reason] || 'txClReasonIdentical'; }

/**
 * canOverride(item, action) -> { ok, reasonKey }
 *
 * The rules, and why each one exists:
 *   * 'nothing' is always legal — a user may always decline a row.
 *   * a transfer needs a source: upload needs the local file to exist, download
 *     needs the remote one. sync.js's apply() would otherwise queue a read of a
 *     path that is not there.
 *   * a deletion needs a target on the side being deleted from.
 *   * timestamp mode never deletes. design/main/sync.js refuses `deleteFiles`
 *     in that mode outright, so offering a delete here would be a promise the
 *     engine breaks.
 *   * a type mismatch (directory on one side, file on the other) is reported
 *     and never resolved automatically, in the C++ as here.
 */
export function canOverride(item, action) {
  if (!CHECKLIST_ACTIONS.includes(action)) return { ok: false, reasonKey: 'txClActNothing' };
  if (action === 'nothing') return { ok: true, reasonKey: '' };
  if (item?.reason === 'type-mismatch') return { ok: false, reasonKey: 'txClNoTypeMismatch' };

  const localExists = !!item?.local?.exists;
  const remoteExists = !!item?.remote?.exists;

  // sync.js applies timestamp-only rows with setTimes(), while this renderer's
  // direct override path only has byte-transfer primitives. Refuse a reversal
  // instead of silently turning a metadata-only choice into a file transfer.
  if (item?.timestampOnly && (action === 'upload' || action === 'download')
      && action !== item.action) {
    return { ok: false, reasonKey: 'txClNoTimestampReverse' };
  }

  if (action === 'upload') {
    return localExists ? { ok: true, reasonKey: '' } : { ok: false, reasonKey: 'txClNoUpload' };
  }
  if (action === 'download') {
    return remoteExists ? { ok: true, reasonKey: '' } : { ok: false, reasonKey: 'txClNoDownload' };
  }
  if (item?.timestampOnly) return { ok: false, reasonKey: 'txClNoDeleteTimestamp' };
  if (action === 'deleteLocal') {
    return localExists ? { ok: true, reasonKey: '' } : { ok: false, reasonKey: 'txClNoDeleteLocal' };
  }
  return remoteExists ? { ok: true, reasonKey: '' } : { ok: false, reasonKey: 'txClNoDeleteRemote' };
}

/** Every action this row may legally be set to, in menu order. */
export function allowedActions(item) {
  return CHECKLIST_ACTIONS.filter((a) => canOverride(item, a).ok);
}

/**
 * A NEW item with the action applied. Choosing a real action ticks the row and
 * choosing "do nothing" unticks it, because a ticked row that does nothing is
 * exactly the ambiguity this dialog exists to remove.
 */
export function overrideAction(item, action) {
  const check = canOverride(item, action);
  if (!check.ok) return { ok: false, reasonKey: check.reasonKey, item };
  return {
    ok: true,
    reasonKey: '',
    item: { ...item, action, checked: action !== 'nothing' },
  };
}

/** Tick or untick without changing the action. */
export function setChecked(item, checked) { return { ...item, checked: !!checked }; }

export function checkAll(items) {
  return (items || []).map((item) => item.action === 'nothing' ? setChecked(item, false) : setChecked(item, true));
}

export function uncheckAll(items) {
  return (items || []).map((item) => setChecked(item, false));
}

/** Invert selection without making a row that does nothing actionable. */
export function invertChecked(items) {
  return (items || []).map((item) => item.action === 'nothing'
    ? setChecked(item, false)
    : setChecked(item, !item.checked));
}

/** Match a directory and its descendants, like WinSCP's directory action. */
export function isInDirectory(directory, candidate) {
  const boundary = (value) => {
    const raw = String(value || '');
    const trimmed = raw.replace(/[\\/]+$/, '');
    return trimmed || (/^[\\/]+$/.test(raw) ? raw[0] : '');
  };
  const scope = boundary(directory);
  const path = boundary(candidate);
  if (!scope || !path) return scope === path;
  if (scope === path) return true;
  if (scope === '/' || scope === '\\') return path.startsWith(scope);
  return path.startsWith(`${scope}/`) || path.startsWith(`${scope}\\`);
}

/**
 * Apply the checklist's directory scope to selection without changing any
 * proposed actions. `nothing` rows have no checkbox in the UI, so a scoped
 * check must leave them unticked just like the global Check All action.
 */
export function setCheckedInDirectory(items, directory, checked) {
  return (items || []).map((item) => {
    if (!isInDirectory(directory, rowDirectory(item))) return item;
    if (checked && item.action === 'nothing') return item;
    return setChecked(item, checked);
  });
}

/** Rows covered by a directory action, including all descendants. */
export function itemsInDirectory(items, directory) {
  return (items || []).filter((item) => isInDirectory(directory, rowDirectory(item)));
}

/**
 * WinSCP's "Reverse": upload <-> download, deleteLocal <-> deleteRemote.
 * A row that cannot legally hold the mirrored action is refused with its reason
 * rather than silently left alone.
 */
export function reverseAction(item) {
  const mirror = {
    upload: 'download', download: 'upload',
    deleteLocal: 'deleteRemote', deleteRemote: 'deleteLocal',
  }[item?.action];
  if (!mirror) {
    const reasonKey = item?.action === 'nothing' ? 'txClNoReverseNothing' : 'txClNoTypeMismatch';
    return { ok: false, reasonKey, item };
  }
  return overrideAction(item, mirror);
}

/**
 * What the current selection will do. `onlyChecked` false counts every row,
 * which is what the "act on everything" path needs.
 */
export function summarizeChecklist(items, options = {}) {
  const onlyChecked = options.onlyChecked !== false;
  const counts = { upload: 0, download: 0, deleteLocal: 0, deleteRemote: 0, nothing: 0, timestamp: 0 };
  const bytes = { upload: 0, download: 0 };
  let acted = 0;
  for (const item of items || []) {
    if (onlyChecked && !item.checked) continue;
    if (item.action === 'nothing') { counts.nothing += 1; continue; }
    acted += 1;
    if (item.timestampOnly && (item.action === 'upload' || item.action === 'download')) {
      counts.timestamp += 1;
      continue;
    }
    counts[item.action] = (counts[item.action] || 0) + 1;
    if (item.action === 'upload') bytes.upload += Number(item.local?.size) || 0;
    if (item.action === 'download') bytes.download += Number(item.remote?.size) || 0;
  }
  const summary = {
    counts,
    bytes,
    acted,
    deletions: counts.deleteLocal + counts.deleteRemote,
    total: (items || []).length,
  };
  if (options.sourceEmpty && summary.deletions > 0) summary.emptySource = true;
  return summary;
}

/**
 * Stable identity for a comparison row. Sorting changes presentation order,
 * while the main-process checklist remains in comparison order, so paths are
 * the only safe way to match the two copies back up.
 */
function rowIdentity(item) {
  return [
    item?.local?.path || '',
    item?.remote?.path || '',
    item?.local?.directory || '',
    item?.remote?.directory || '',
    item?.local?.name || '',
    item?.remote?.name || '',
  ].join('\u0000');
}

/** Recalculate the checked outcome without changing rows or touching a bridge. */
export function calculateChecklist(items) {
  return summarizeChecklist(items, { onlyChecked: true });
}

/**
 * The consequence, as i18n keys plus parameters. Returned rather than rendered
 * so a test can assert exactly which sentences a selection produces.
 */
export function describeChecklist(summary) {
  const lines = [];
  if (!summary.acted) return [{ key: 'txClNothing', params: [] }];
  const c = summary.counts;
  if (c.upload) lines.push({ key: 'txClUploads', params: [c.upload, formatBytes(summary.bytes.upload)] });
  if (c.download) lines.push({ key: 'txClDownloads', params: [c.download, formatBytes(summary.bytes.download)] });
  if (c.timestamp) lines.push({ key: 'txClTimestamps', params: [c.timestamp] });
  if (c.deleteLocal) lines.push({ key: 'txClDeleteLocal', params: [c.deleteLocal] });
  if (c.deleteRemote) lines.push({ key: 'txClDeleteRemote', params: [c.deleteRemote] });
  if (summary.deletions) lines.push({ key: 'txClDeleteWarn', params: [] });
  if (summary.emptySource) lines.push({ key: 'txClEmptySourceDelete', params: [] });
  return lines;
}

/**
 * Split the current rows into "the engine can do these" and "we must do these
 * ourselves".
 *
 * sync:apply carries only a boolean per row and design/main/sync.js then reads
 * the action from ITS copy of the checklist, so a row whose action the user
 * changed cannot be expressed through that call. Those rows are excluded from
 * the flags and returned as `overrides` for the direct path.
 */
export function partitionForApply(originalItems, currentItems) {
  const currentByIdentity = new Map();
  for (const [index, item] of (currentItems || []).entries()) {
    const key = rowIdentity(item);
    const matches = currentByIdentity.get(key) || [];
    matches.push({ index, item });
    currentByIdentity.set(key, matches);
  }

  const checked = [];
  const overrides = [];
  for (let i = 0; i < originalItems.length; i += 1) {
    const before = originalItems[i];
    const matches = currentByIdentity.get(rowIdentity(before)) || [];
    const match = matches.shift();
    const now = match?.item || currentItems[i] || before;
    const changed = now.action !== before.action;
    checked.push(!!now.checked && !changed && now.action !== 'nothing');
    if (now.checked && changed && now.action !== 'nothing') overrides.push({ index: i, item: now });
  }
  return { checked, overrides };
}

/** The directory a row belongs to, used for the grouped view. */
export function rowDirectory(item) {
  return item?.local?.directory || item?.remote?.directory || '';
}

/** Size shown in the checklist: use the side that supplies or loses the row. */
export function rowSize(item) {
  if (item?.isDirectory) return null;
  if (item?.action === 'download' || item?.action === 'deleteRemote') return item?.remote?.size;
  return item?.local?.size;
}

/** Rows grouped by directory, insertion-ordered. */
export function groupByDirectory(items) {
  const map = new Map();
  for (const item of items || []) {
    const key = rowDirectory(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

/** Stable sort for the checklist toolbar. Sorting only changes presentation. */
export function sortChecklistItems(items, field = 'name', direction = 'asc') {
  const sign = direction === 'desc' ? -1 : 1;
  const value = (item) => {
    if (field === 'action') return actionLabelKey(item?.action);
    if (field === 'directory') return rowDirectory(item);
    return item?.local?.name || item?.remote?.name || item?.local?.path || item?.remote?.path || '';
  };
  return (items || []).map((item, index) => ({ item, index, value: String(value(item)).toLocaleLowerCase() }))
    .sort((a, b) => (a.value.localeCompare(b.value) * sign || a.index - b.index))
    .map(({ item }) => item);
}

/* ================================================================== */
/* the dialog                                                          */
/* ================================================================== */

/**
 * openChecklistDialog(result) -> modal handle
 *
 * result: { token, items, counts, sessionId, localPath, remotePath, options,
 *           copyParam, onApplied }
 */
export function openChecklistDialog(result = {}) {
  injectTransferStyles();
  injectChecklistStyles();

  const original = (result.items || []).map((i) => ({ ...i }));
  let rows = original.map((i) => ({ ...i }));
  let grouped = true;
  let sortField = 'name';
  let sortDirection = 'asc';

  const listEl = h('div', { class: 'tx-cl-list', role: 'group', 'aria-label': t('txClTitle') });
  const summaryEl = h('div', { class: 'tx-cl-summary', role: 'status', 'aria-live': 'polite' });
  let applyBtn = null;

  const search = createSearchBar({
    id: 'sync-checklist',
    labelKey: 'txClSearchPh',
    placeholderKey: 'txClSearchPh',
    compact: true,
    persist: false,
    appearanceKey: 'search-sync-checklist',
    appearanceLabel: 'Checklist search',
    sampleProvider: () => rows.map((r) => `${r.local?.path || ''} ${r.remote?.path || ''}`).join('\n'),
    onChange: render,
  });

  function visibleRows() {
    return search.isActive
      ? filterBy(rows, search.predicate, (r) => [
        r.local?.path || '', r.remote?.path || '', r.local?.name || r.remote?.name || '', t(actionLabelKey(r.action)),
      ])
      : rows;
  }

  function setRow(index, next) {
    rows = rows.map((r, i) => (i === index ? next : r));
    render();
  }

  /**
   * render() rebuilds the whole list, so without this every tick of a checkbox
   * and every change of a row's action would drop focus to the document body.
   * On Windows an arrow key on a closed <select> fires `change` per keystroke,
   * so a keyboard user would lose the control after one press and never reach
   * the second option — on the dialog that gates irreversible deletions.
   */
  function focusFingerprint() {
    const el = document.activeElement;
    if (!el || !listEl.contains(el)) return null;
    const row = el.closest('.tx-cl-row');
    if (!row) return null;
    return {
      index: row.getAttribute('data-row-index'),
      part: el.classList.contains('tx-cl-action') ? 'action'
        : (el.tagName === 'INPUT' ? 'check' : 'row'),
      caret: typeof el.selectionStart === 'number' ? el.selectionStart : null,
    };
  }

  function restoreFocus(fp) {
    if (!fp) return;
    let row = null;
    for (const candidate of listEl.querySelectorAll('.tx-cl-row')) {
      if (candidate.getAttribute('data-row-index') === fp.index) { row = candidate; break; }
    }
    if (!row) return;
    const target = fp.part === 'action' ? row.querySelector('.tx-cl-action')
      : fp.part === 'check' ? row.querySelector('input[type="checkbox"]')
        : row;
    const el = target || row;
    try { el.focus({ preventScroll: true }); } catch { el.focus(); }
  }

  function applyToAll(fn) {
    rows = rows.map((r) => fn(r) || r);
    render();
  }

  function sortRows() {
    const fields = ['name', 'action', 'directory'];
    const current = fields.indexOf(sortField) * 2 + (sortDirection === 'desc' ? 1 : 0);
    const next = (current + 1) % (fields.length * 2);
    sortField = fields[Math.floor(next / 2)];
    sortDirection = next % 2 ? 'desc' : 'asc';
    rows = sortChecklistItems(rows, sortField, sortDirection);
    render();
  }

  function invertSelection() {
    rows = invertChecked(rows);
    render();
  }

  function checkEverything() { rows = checkAll(rows); render(); }
  function uncheckEverything() { rows = uncheckAll(rows); render(); }

  function applyToDirectory(directory, checked) {
    rows = setCheckedInDirectory(rows, directory, checked);
    render();
  }

  function directoryItems(directory) {
    return itemsInDirectory(rows, directory);
  }

  function rowElement(item) {
    const index = rows.indexOf(item);
    const cbId = uid('tx-cl-cb');
    const name = item.local?.name || item.remote?.name || item.local?.path || item.remote?.path || '';
    const size = rowSize(item);
    const directory = rowDirectory(item);

    const checkbox = h('input', {
      type: 'checkbox', id: cbId,
      onchange: () => setRow(index, setChecked(item, checkbox.checked)),
    });
    checkbox.checked = !!item.checked;
    checkbox.disabled = item.action === 'nothing';

    const select = h('select', {
      class: 'tx-cl-action',
      'aria-label': t('txClActionOf', name),
      title: `${t('txClActionOf', name)}: ${t(actionLabelKey(item.action))}`,
      onchange: () => {
        const res = overrideAction(item, select.value);
        if (!res.ok) {
          // Explain the refusal and put the control back, rather than leaving a
          // select showing something the engine will not do.
          notify.warning(t('syncAction'), t(res.reasonKey));
          select.value = item.action;
          return;
        }
        setRow(index, res.item);
        announce(`${name}: ${t(actionLabelKey(res.item.action))}`);
      },
    });
    for (const action of CHECKLIST_ACTIONS) {
      const allowed = canOverride(item, action);
      const opt = h('option', { value: action }, t(actionLabelKey(action)));
      if (!allowed.ok) { opt.disabled = true; opt.title = t(allowed.reasonKey); }
      select.appendChild(opt);
    }
    select.value = item.action;

    const isDelete = item.action === 'deleteLocal' || item.action === 'deleteRemote';
    const row = h('div', {
      class: `tx-cl-row${isDelete && item.checked ? ' is-delete' : ''}${item.action === 'nothing' ? ' is-nothing' : ''}`,
      // The index survives a rebuild, which is what restoreFocus() matches on.
      'data-row-index': String(index),
      role: 'group',
      'aria-label': name,
    },
    h('label', { class: 'check', for: cbId }, checkbox, h('span', { class: 'sr-only' }, name)),
    h('span', { class: 'tx-cl-icon' }, icon(item.isDirectory ? 'folder' : 'description', 16)),
    h('div', { class: 'tx-cl-name' },
      h('div', { class: 'ellipsis', title: `${item.local?.path || '—'}\n${item.remote?.path || '—'}` }, name),
      h('div', { class: 'tx-cl-reason' }, t(reasonLabelKey(item.reason)))),
    h('span', { class: 'tx-cl-size' }, item.isDirectory ? '—' : formatBytes(size || 0)),
    select);

    appearanceTarget(row, 'checklist-row', 'Checklist row');
    registerContextMenu(row, (ctx) => (ctx?.target?.closest('select') ? [] : [
      ...allowedActions(item).map((a) => ({
        label: t(actionLabelKey(a)),
        checked: item.action === a,
        radio: true,
        onSelect: () => { const r = overrideAction(item, a); if (r.ok) setRow(index, r.item); },
      })),
      SEPARATOR,
      {
        labelKey: 'txClReverse',
        icon: 'swap_horiz',
        onSelect: () => {
          const r = reverseAction(item);
          if (r.ok) setRow(index, r.item);
          else notify.warning(t('txClReverse'), t('txClNoReverse', t(r.reasonKey)));
        },
      },
      SEPARATOR,
      {
        labelKey: 'txClCheckDirectory',
        icon: 'done_all',
        disabled: !directoryItems(directory).some((r) => r.action !== 'nothing')
          || directoryItems(directory).filter((r) => r.action !== 'nothing').every((r) => r.checked),
        onSelect: () => applyToDirectory(directory, true),
      },
      {
        labelKey: 'txClUncheckDirectory',
        icon: 'remove_done',
        disabled: !directoryItems(directory).some((r) => r.checked),
        onSelect: () => applyToDirectory(directory, false),
      },
      SEPARATOR,
      {
        labelKey: 'copyPathClip',
        icon: 'content_copy',
        onSelect: () => copyText(`${item.local?.path || ''}\n${item.remote?.path || ''}`)
          .then((ok) => ok && notify.success(t('pathCopied'), name)),
      },
    ]));
    return row;
  }

  function render() {
    const keep = focusFingerprint();
    clear(listEl);
    const visible = visibleRows();
    if (!visible.length) {
      listEl.appendChild(h('p', { class: 'tx-cl-empty' }, rows.length
        ? noMatchMessage(search.predicate, t('txClScope'))
        : t('txClNothingSelected')));
    } else if (grouped) {
      for (const [dir, group] of groupByDirectory(visible)) {
        listEl.appendChild(h('div', { class: 'tx-cl-group', title: dir }, dir || '/'));
        for (const item of group) listEl.appendChild(rowElement(item));
      }
    } else {
      for (const item of visible) listEl.appendChild(rowElement(item));
    }
    restoreFocus(keep);
    paintSummary();
  }

  function paintSummary() {
    const summary = calculateChecklist(rows);
    clear(summaryEl);
    summaryEl.classList.toggle('has-deletions', summary.deletions > 0);
    summaryEl.appendChild(h('h3', {},
      icon(summary.deletions ? 'warning' : 'info', 17),
      h('span', {}, t('txClWhatHappens', t('txClApply')))));
    const lines = describeChecklist(summary);
    summaryEl.appendChild(h('ul', {}, ...lines.map((l) => h('li', {}, t(l.key, ...l.params)))));
    const { overrides } = partitionForApply(original, rows);
    if (overrides.length) summaryEl.appendChild(h('p', { class: 'tx-cl-note' }, t('txClOverridden', overrides.length)));
    if (applyBtn) {
      applyBtn.disabled = summary.acted === 0;
      applyBtn.textContent = summary.deletions ? `${t('txClApply')} · ${t('delete_')} ${summary.deletions}` : t('txClApply');
    }
  }

  function calculateSelection() {
    const summary = calculateChecklist(rows);
    const lines = describeChecklist(summary).map((line) => t(line.key, ...line.params));
    announce(lines.join(' '));
    notify.info(t('txClCalculate'), lines.join(' '));
  }

  const toolbar = h('div', { class: 'tx-cl-toolbar' },
    toolButton('select_all', 'txClCheckAll', checkEverything),
    toolButton('remove', 'txClUncheckAll', uncheckEverything),
    toolButton('flip', 'txClInvert', invertSelection),
    toolButton('swap_horiz', 'txClReverse', () => applyToAll((r) => { const x = reverseAction(r); return x.ok ? x.item : r; })),
    toolButton('sort', 'txClSort', sortRows),
    toolButton('functions', 'txClCalculate', calculateSelection),
    groupToggle(),
    toolButton('content_copy', 'txClCopyList', copyChecklist),
    h('span', { class: 'spacer' }),
    h('div', { class: 'tx-q-searchwrap' }, search.element));

  registerContextMenu(toolbar, () => [
    { labelKey: 'txClCheckAll', icon: 'select_all', onSelect: checkEverything },
    { labelKey: 'txClUncheckAll', icon: 'remove', onSelect: uncheckEverything },
  ]);

  function onChecklistKeydown(event) {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    if (event.target?.matches?.('input, textarea, select, [contenteditable="true"]')) return;
    if (event.key.toLowerCase() === 'a' && event.shiftKey) {
      event.preventDefault();
      uncheckEverything();
    } else if (event.key.toLowerCase() === 'a') {
      event.preventDefault();
      checkEverything();
    }
  }
  toolbar.addEventListener('keydown', onChecklistKeydown);

  function groupToggle() {
    const btn = h('button', {
      type: 'button', class: 'tx-q-once', 'aria-pressed': 'true',
      onclick: () => { grouped = !grouped; btn.setAttribute('aria-pressed', String(grouped)); btn.classList.toggle('is-on', grouped); render(); },
    }, icon('topic', 15), h('span', {}, t('txClGroup')));
    bindText(btn, 'txClGroup', { attr: 'aria-label' });
    btn.classList.add('is-on');
    appearanceTarget(btn, 'checklist-group-toggle', 'Group checklist by directory');
    return btn;
  }

  function copyChecklist() {
    const text = rows.map((r) => [
      r.checked ? '[x]' : '[ ]',
      r.action,
      r.local?.path || '',
      r.remote?.path || '',
      r.reason,
    ].join('\t')).join('\n');
    copyText(text).then((ok) => ok && notify.success(t('copiedClip'), t('txClTitle')));
  }

  const body = h('div', { class: 'stack' },
    summaryEl,
    h('p', { class: 'muted', style: { fontSize: 'var(--type-label-md)' } }, t('txClOnlyChecked')),
    toolbar,
    listEl);

  const handle = openModal({
    title: t('txClTitle'),
    width: 900,
    dismissOnScrim: false,
    content: body,
    onClose: () => {
      toolbar.removeEventListener('keydown', onChecklistKeydown);
      search.destroy();
    },
    actions: [
      { label: t('cancel'), kind: 'text' },
      {
        label: t('txClApply'),
        kind: 'filled',
        autofocus: true,
        ref: (btn) => { applyBtn = btn; },
        onSelect: (close) => { confirmAndApply(close); return true; },
      },
    ],
  });

  function confirmAndApply(close) {
    const summary = summarizeChecklist(rows, {
      onlyChecked: true,
      sourceEmpty: result.safety?.sourceEmpty,
    });
    if (!summary.acted) { notify.info(t('txClTitle'), t('txClNothing')); return; }
    const lines = describeChecklist(summary).map((l) => t(l.key, ...l.params)).join('\n');
    if (!summary.deletions) { close(); apply(); return; }
    // A deletion is the one outcome that needs a second, explicit yes.
    messageDialog({
      title: t('txClConfirmTitle'),
      kind: 'warning',
      message: lines,
      buttons: 'yesNo',
      danger: true,
      defaultAnswer: 'no',
    }).then((r) => { if (r.answer === 'yes') { close(); apply(); } });
  }

  async function apply() {
    const b = bridge();
    if (!b?.sync?.apply) { notify.error(t('txClTitle'), t('txClNoBridge')); return; }
    const { checked, overrides } = partitionForApply(original, rows);
    let queued = 0;
    let deleted = 0;
    const failures = [];

    try {
      const res = unwrapSync(await b.sync.apply({
        token: result.token,
        checked,
        onlyChecked: true,
        performDeletions: true,
        copyParam: result.copyParam || undefined,
      }));
      queued += (res?.items || []).length;
      deleted += (res?.deletions || []).length;
      for (const e of res?.errors || []) failures.push(e);
    } catch (err) {
      notify.error(t('txClTitle'), /no longer available/i.test(err.message) ? t('txClExpired') : err.message);
      return;
    }

    for (const { item } of overrides) {
      try {
        const done = await applyOverride(item, result);
        if (done === 'queued') queued += 1;
        else if (done === 'deleted') deleted += 1;
      } catch (err) {
        failures.push({ item, error: err.message });
      }
    }

    queueModel.refresh();
    if (failures.length) notify.warning(t('txClTitle'), `${t('txClApplied', queued, deleted)} ${t('txClApplyFailed', failures.length)}`);
    else notify.success(t('txClTitle'), t('txClApplied', queued, deleted));
    result.onApplied?.({ queued, deleted, failures });
  }

  render();
  return handle;
}

/**
 * Perform one hand-overridden row with the primitives design/main/sync.js would
 * have used. Returns 'queued' or 'deleted'.
 */
async function applyOverride(item, context) {
  const b = bridge();
  const sessionId = context.sessionId;
  if (item.action === 'upload' || item.action === 'download') {
    if (item.timestampOnly) throw new Error(t('txClNoTimestampReverse'));
    if (!b?.queue?.add) throw new Error(t('txClNoBridge'));
    const upload = item.action === 'upload';
    unwrapSync(await b.queue.add({
      sessionId,
      direction: upload ? 'upload' : 'download',
      files: [upload ? item.local.path : item.remote.path],
      target: upload ? item.remote.directory || context.remotePath : item.local.directory || context.localPath,
      copyParam: context.copyParam || undefined,
    }));
    return 'queued';
  }
  if (item.action === 'deleteLocal') {
    if (!b?.fs?.localRemove) throw new Error(t('txClNoBridge'));
    unwrapSync(await b.fs.localRemove([item.local.path], { recursive: !!item.isDirectory }));
    return 'deleted';
  }
  if (item.action === 'deleteRemote') {
    if (!b?.fs?.remove) throw new Error(t('txClNoBridge'));
    unwrapSync(await b.fs.remove(sessionId, [item.remote.path], { recursive: !!item.isDirectory }));
    return 'deleted';
  }
  return 'skipped';
}

function unwrapSync(res) {
  if (res == null) return null;
  if (typeof res === 'object' && 'ok' in res) {
    if (res.ok) return res.value;
    throw new Error((res.error && res.error.message) || 'The synchronization engine refused the call.');
  }
  return res;
}

function toolButton(glyph, labelKey, onSelect) {
  const btn = h('button', { type: 'button', class: 'btn-text', onclick: onSelect },
    icon(glyph, 16), h('span', {}));
  bindText(btn.lastChild, labelKey);
  bindText(btn, labelKey, { attr: 'title' });
  bindText(btn, labelKey, { attr: 'aria-label' });
  appearanceTarget(btn, `checklist-tool-${labelKey}`, `Checklist toolbar: ${labelKey}`);
  return btn;
}

// Deliberately NOT in the shell's dialog registry: openDialog() always builds
// the modal itself from the returned spec, and this dialog has to own its modal
// so the apply path can gate a second confirmation before closing. Callers use
// openChecklistDialog() — ui/dialogs/synchronize.js is the only one today.

const CHECKLIST_CSS = `
.tx-cl-summary h3 { display: flex; align-items: center; gap: 8px; }
.tx-cl-note { font-size: var(--type-label-md); opacity: .9; }
.tx-cl-icon { flex: 0 0 auto; color: var(--onsv); }
.tx-cl-row .check { flex: 0 0 auto; min-height: 0; }
.tx-cl-row select:focus-visible { outline-offset: 1px; }
`;

let injected = false;
function injectChecklistStyles() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const el = document.createElement('style');
  el.id = 'sheet-transfer-checklist';
  el.textContent = CHECKLIST_CSS;
  document.head.appendChild(el);
}
