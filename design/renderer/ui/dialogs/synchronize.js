// ui/dialogs/synchronize.js — Synchronize (FullSynchronize.dfm) and
// Keep remote directory up to date (Synchronize.dfm).
//
// Two dialogs, one options model, because they configure the same comparison in
// design/main/sync.js and a user who learns one has learned the other.
//
// Two things here are worth reading before changing anything:
//
//   * `syncCombinationError` mirrors design/main/sync.js `validateOptions`.
//     WinSCP greys these combinations out and sync.js throws on them; the
//     dialog refuses them in words BEFORE the call, so the user is told which
//     two settings disagree instead of being handed an exception.
//
//   * `applySelectionPolicy`. The comparison request carries `deleteFiles` and
//     `existingOnly` through the real IPC boundary, so sync.js can include the
//     right rows and apply the same checked policy. The renderer repeats that
//     policy after the bridge for selected-only runs; nothing is deleted without
//     a tick the user can see.

import {
  h, icon, clear, uid, appearanceTarget, openModal, layer, focusMemory, oneLine,
} from '../../dom.js';
import { bus, session } from '../../state.js';
import { t, bindText } from '../../i18n.js';
import { notify } from '../notifications.js';
import { registerCommand } from '../../app.js';
import {
  defineStrings, injectTransferStyles, bridge, transferPref, setTransferPref,
  loadTransferPrefs, queueModel, onMainEvent,
} from '../queue.js';
import { openChecklistDialog, summarizeChecklist, describeChecklist } from './checklist.js';
// The capability cache the server-information window fills. Importing it here
// is what keeps "this option is greyed out" and "this protocol cannot do that"
// reading from ONE object rather than two opinions.
import { capabilitiesOf, fetchFileSystemInfo } from './fileysteminfo.js';

defineStrings({
  txSyTitle: ['Synchronize directories', '同步目錄'],
  txSyLocal: ['Local directory', '本機目錄'],
  txSyRemote: ['Remote directory', '遠端目錄'],
  txSyDirection: ['Direction', '方向'],
  txSyDirBoth: ['Both — whichever side is newer wins', '雙向——邊邊新啲邊邊贏'],
  txSyDirRemote: ['Remote — make the server match the local side', '遠端——令伺服器跟返本機'],
  txSyDirLocal: ['Local — make the local side match the server', '本機——令本機跟返伺服器'],
  txSyMode: ['Mode', '模式'],
  txSyModeSync: ['Synchronize files', '同步檔案'],
  txSyModeMirror: ['Mirror files — the source always wins', '鏡像——來源永遠贏'],
  txSyModeTimestamp: ['Synchronize timestamps only', '淨係同步時間戳'],
  txSyCriteria: ['Comparison criteria', '比較準則'],
  txSyByTime: ['Modification time', '修改時間'],
  txSyBySize: ['File size', '檔案大細'],
  txSyByChecksum: ['Checksum', '檢查碼'],
  txSyChecksumUnsupported: ['The comparison engine compares modification time and size. Checksum comparison is not implemented, so this criterion cannot be chosen.', '比較引擎淨係比修改時間同大細。檢查碼比較未實作，所以揀唔到。'],
  txSyNoTimestamps: [
    '{0} does not let this application set a file’s modification time, so there is nothing for a timestamp synchronization to write.',
    '{0} 唔畀呢個程式改檔案嘅修改時間，所以時間戳同步冇嘢可以寫。'],
  txSyNoPreserveTime: [
    '{0} does not let this application set a file’s modification time. The transfer engine skips the call on this protocol, so ticking it would change nothing.',
    '{0} 唔畀呢個程式改檔案嘅修改時間。 傳輸引擎喺呢個協定會跳過嗰步，所以剔咗都冇分別。'],
  txSyCaseSensitive: ['Case sensitive file names', '檔案名分大細楷'],
  txSyOptions: ['Synchronize options', '同步選項'],
  txSyDelete: ['Delete files that exist only on the target side', '刪除淨係目標側有嘅檔案'],
  txSyExistingOnly: ['Existing files only — never create a new one', '淨係現有檔案——唔會新開檔案'],
  txSyRecursive: ['Include subdirectories', '包埋子目錄'],
  txSyPreview: ['Show the checklist before anything happens', '做嘢之前先睇清單'],
  txSyPreviewForced: ['A synchronization that deletes always shows the checklist first.', '會刪嘢嘅同步一定會先俾你睇清單。'],
  txSySelectedOnly: ['Selected files only', '淨係揀咗嘅檔案'],
  txSyNoSelection: ['Nothing is selected in a file panel, so this option has nothing to narrow.', '面板度冇揀任何嘢，所以呢個選項冇嘢好縮窄。'],
  txSyMask: ['File mask', '檔案遮罩'],
  txSyMaskHint: ['Example: *.txt; *.js  —  a leading - excludes', '例如：*.txt; *.js —— 用 - 開頭就係排除'],
  txSyTransfer: ['Transfer settings', '傳輸設定'],
  txSySameNextTime: ['Use the same options next time', '下次用返同一組設定'],
  txSyCompare: ['Compare', '比較'],
  txSyComparing: ['Comparing {0} with {1}…', '比較緊 {0} 同 {1}…'],
  txSyCompared: ['{0} difference(s) found.', '搵到 {0} 個唔同嘅地方。'],
  txSyNoSession: ['No connected session, so there is no remote side to synchronize with.', '冇連線中嘅工作階段，所以冇遠端可以同步。'],
  txSyNoBridge: ['The synchronization engine is not reachable from this window.', '呢個視窗連唔到同步引擎。'],
  txSyRefusedTitle: ['These two settings disagree', '呢兩個設定互相打交'],
  txSyRefuseTimestampDelete: ['Timestamp mode never deletes anything, so "delete files" cannot be combined with it.', '時間戳模式永遠唔刪嘢，所以唔可以同「刪除檔案」一齊用。'],
  txSyRefuseTimestampCriteria: ['Timestamp mode compares timestamps, so comparing by size alone (or by nothing) leaves it nothing to work with. Tick modification time.', '時間戳模式係比時間戳，淨係比大細（或者乜都唔比）就冇嘢可以比。剔返修改時間。'],
  txSyRefuseBothSize: ['With direction "both" and a size-based criterion there is no way to tell which side should win. Pick a direction, or compare by time.', '方向揀「雙向」又用大細嚟比，根本分唔出邊邊應該贏。揀返一個方向，或者用時間比。'],
  txSyRefuseNoCriteria: ['With no comparison criterion nothing would ever be considered different. Tick modification time or file size.', '一個比較準則都冇，咁就永遠唔會覺得有嘢唔同。剔返修改時間或者檔案大細。'],
  txSyBrowse: ['Choose a local directory', '揀個本機目錄'],
  txSyIncludeHidden: ['Include hidden files', '包埋隱藏檔'],
  txSyApplied: ['{0} transfer(s) queued.', '排咗 {0} 單傳輸。'],
  txSyQueuedNew: ['Queued {0}', '排咗 {0}'],

  txKutdTitleFull: ['Keep the remote directory up to date', '遠端目錄保持最新'],
  txKutdExplain: ['The local directory is watched. Every change found there is uploaded to the remote directory as it happens.', '會監察本機目錄。一發現有變就即刻上載去遠端目錄。'],
  txKutdSyncOnStart: ['Synchronize once when watching starts', '開始監察嗰陣先同步一次'],
  txKutdContinueOnError: ['Continue after an error', '出錯都繼續'],
  txKutdStart: ['Start watching', '開始監察'],
  txKutdStop: ['Stop watching', '停止監察'],
  txKutdStarting: ['Starting watcher…', '開始緊監察…'],
  txKutdStopping: ['Stopping watcher…', '停止緊監察…'],
  txKutdRunning: ['Watching {0}. Changes upload automatically.', '監察緊 {0}。有變就自動上載。'],
  txKutdStopped: ['Stopped watching {0}.', '停咗監察 {0}。'],
  txKutdLog: ['Activity', '活動紀錄'],
  txKutdLogEmpty: ['Nothing has changed since watching started.', '開始監察之後未有嘢變過。'],
  txKutdChange: ['{0} transfer(s) queued, {1} deletion(s).', '排咗 {0} 單傳輸、{1} 個刪除。'],
  txKutdError: ['Watch error: {0}', '監察出錯：{0}'],
  txKutdAlready: ['A watcher is already running for {0}.', '{0} 已經有緊監察緊。'],
});

/* ================================================================== */
/* the options model                                                   */
/* ================================================================== */

export const SYNC_DEFAULTS = {
  direction: 'both',        // both | remote | local
  mode: 'synchronize',      // synchronize | mirror | timestamp
  byTime: true,
  bySize: false,
  caseSensitive: false,
  recursive: true,
  deleteFiles: false,
  existingOnly: false,
  preview: true,
  selectedOnly: false,
  continueOnError: false,
  fileMask: '',
  transferMode: 'binary',   // text | binary | automatic
  preserveTime: true,
  excludeHidden: false,
  syncOnStart: true,
};

/** The two checkboxes collapse into sync.js's single `criteria` value. */
export function criteriaOf(options) {
  if (options.byTime && options.bySize) return 'either';
  if (options.byTime) return 'time';
  if (options.bySize) return 'size';
  return 'none';
}

/**
 * The refusals design/main/sync.js `validateOptions` raises, as an i18n key.
 * Empty string means the combination is legal.
 */
export function syncCombinationError(options) {
  const criteria = criteriaOf(options);
  const timestamp = options.mode === 'timestamp';
  const notByTime = criteria === 'size' || criteria === 'none';
  const bySize = criteria === 'size' || criteria === 'either';

  // Order matters: the most specific and most actionable refusal wins, so a
  // user is told the one thing to change rather than the most general symptom.
  if (timestamp && options.deleteFiles) return 'txSyRefuseTimestampDelete';
  if (criteria === 'none') return 'txSyRefuseNoCriteria';
  if (timestamp && notByTime) return 'txSyRefuseTimestampCriteria';
  if (options.direction === 'both' && (notByTime || bySize)) return 'txSyRefuseBothSize';
  return '';
}

/** The `sync:compare` request body for a set of dialog options. */
export function compareRequest(options, context) {
  return {
    sessionId: context.sessionId,
    localPath: context.localPath,
    remotePath: context.remotePath,
    direction: options.direction,
    mode: options.mode,
    criteria: criteriaOf(options),
    recursive: !!options.recursive,
    deleteFiles: !!options.deleteFiles,
    existingOnly: !!options.existingOnly,
    caseSensitive: !!options.caseSensitive,
    fileMask: options.fileMask || undefined,
    transferMode: options.transferMode,
    copyParam: {
      transferMode: options.transferMode,
      preserveTime: !!options.preserveTime,
      excludeHiddenFiles: !!options.excludeHidden,
    },
  };
}

/**
 * The tick policy sync.js applies when it is given `deleteFiles` and
 * `existingOnly` — reproduced here for the renderer's selected-only filter.
 * Returns NEW items; the comparison itself is never altered, only which rows
 * arrive at the checklist already ticked.
 */
export function applySelectionPolicy(items, options = {}) {
  const deleteFiles = !!options.deleteFiles;
  const existingOnly = !!options.existingOnly;
  const selection = Array.isArray(options.selection) && options.selection.length
    ? new Set(options.selection.map(String))
    : null;
  return (items || []).map((item) => {
    let checked = item.checked;
    const isDelete = item.action === 'deleteLocal' || item.action === 'deleteRemote';
    const isNew = item.reason === 'new-on-local' || item.reason === 'new-on-remote';
    if (isDelete) checked = deleteFiles && (!item.isDirectory || options.recursive !== false);
    else if (isNew && existingOnly) checked = false;
    if (checked && selection) {
      const names = [item.local?.path, item.remote?.path, item.local?.name, item.remote?.name].filter(Boolean).map(String);
      checked = names.some((n) => selection.has(n));
    }
    if (item.action === 'nothing') checked = false;
    return checked === item.checked ? item : { ...item, checked };
  });
}

/* ================================================================== */
/* shared UI pieces                                                    */
/* ================================================================== */

function group(titleKey, ...children) {
  const el = h('section', { class: 'tx-sy-group' }, h('h3', {}, t(titleKey)), ...children);
  appearanceTarget(el, `sync-group-${titleKey}`, `Synchronize group: ${titleKey}`);
  return el;
}

function radio(name, value, labelKey, current, onChange, opts = {}) {
  const id = uid('tx-sy-r');
  const input = h('input', { type: 'radio', name, id, value, onchange: () => onChange(value) });
  input.checked = current === value && !opts.disabled;
  if (opts.disabled) input.disabled = true;
  const label = h('label', { class: 'check', for: id }, input, h('span', {}));
  bindText(label.lastChild, labelKey);
  if (!opts.disabled) return label;
  // A refused option keeps its place and says why, rather than disappearing —
  // "where did Synchronize timestamps go?" is a worse question than "why is it
  // greyed out?", and the answer to the second is right underneath it.
  return h('div', { class: 'stack', style: { gap: '2px' } }, label,
    h('p', { class: 'tx-sy-note' }, t(opts.reasonKey, ...(opts.reasonArgs || []))));
}

function check(labelKey, checked, onChange, opts = {}) {
  const id = uid('tx-sy-c');
  const input = h('input', { type: 'checkbox', id, onchange: () => onChange(input.checked) });
  input.checked = !!checked;
  // A disabled control still tells the truth about the state it reports: when a
  // caller passes `checked` for a disabled box (Preview with deletions on), the
  // box stays ticked, because that IS what will happen.
  if (opts.disabled) { input.disabled = true; input.checked = !!checked; }
  const label = h('label', { class: 'check', for: id }, input, h('span', {}));
  bindText(label.lastChild, labelKey);
  const wrap = h('div', { class: 'stack', style: { gap: '2px' } }, label,
    opts.disabled && opts.reasonKey
      ? h('p', { class: 'tx-sy-note' }, t(opts.reasonKey, ...(opts.reasonArgs || []))) : null);
  return { element: wrap, input };
}

function pathField(labelKey, value, onChange, onBrowse) {
  const id = uid('tx-sy-p');
  const input = h('input', {
    type: 'text', class: 'field-input', id, spellcheck: 'false', autocomplete: 'off',
    oninput: () => onChange(input.value),
  });
  input.value = value || '';
  const row = h('div', { class: 'row' }, input,
    onBrowse
      ? h('button', {
        type: 'button',
        class: 'btn-text',
        // Named for the field it belongs to: with two path fields side by side,
        // three buttons all reading "Browse…" tell a screen reader nothing.
        'aria-label': `${t('browse')} — ${t(labelKey)}`,
        title: `${t('browse')} — ${t(labelKey)}`,
        onclick: () => onBrowse(input),
      }, t('browse'))
      : null);
  const label = h('span', { class: 'field-label' });
  bindText(label, labelKey);
  return { element: h('label', { class: 'field', for: id }, label, row), input };
}

/** The session this dialog acts on, resolved honestly rather than guessed. */
async function resolveContext(props = {}) {
  const b = bridge();
  const ctx = {
    sessionId: props.sessionId || session.get('activeSessionId') || null,
    localPath: props.localPath || '',
    remotePath: props.remotePath || '',
    selection: props.selection || null,
  };
  if (!b?.session?.list) return ctx;
  try {
    const list = unwrapSync(await b.session.list()) || [];
    const chosen = list.find((s) => s.id === ctx.sessionId)
      || list.find((s) => s.state === 'connected' || s.connected)
      || null;
    if (!chosen) return ctx;
    ctx.sessionId = chosen.id;
    const state = chosen.state && typeof chosen.state === 'object' ? chosen.state : null;
    ctx.localPath = ctx.localPath || state?.localPath || chosen.localPath || '';
    ctx.remotePath = ctx.remotePath || state?.remotePath || chosen.remotePath || '';
  } catch { /* the honest empty context is handled by the caller */ }
  return ctx;
}

function unwrapSync(res) {
  if (res == null) return null;
  if (typeof res === 'object' && 'ok' in res) {
    if (res.ok) return res.value;
    throw new Error((res.error && res.error.message) || 'The call was refused.');
  }
  return res;
}

async function browseLocal(input, onChange) {
  const b = bridge();
  if (!b?.app?.pickPath) { notify.warning(t('txSyBrowse'), t('txSyNoBridge')); return; }
  try {
    const picked = unwrapSync(await b.app.pickPath({ properties: ['openDirectory'], title: t('txSyBrowse') }));
    const path = Array.isArray(picked) ? picked[0] : (picked?.path || picked);
    if (path) { input.value = path; onChange(path); }
  } catch (err) { notify.error(t('txSyBrowse'), err.message); }
}

/* ================================================================== */
/* the Synchronize dialog                                              */
/* ================================================================== */

export function openSynchronizeDialog(props = {}) {
  injectTransferStyles();
  injectSyncStyles();

  const options = { ...SYNC_DEFAULTS, ...(transferPref('synchronize', null) || {}), ...(props.options || {}) };
  let context = { sessionId: props.sessionId || null, localPath: props.localPath || '', remotePath: props.remotePath || '', selection: props.selection || null };
  let saveNextTime = !!transferPref('synchronize.remember', false);
  let refusalEl = null;
  let okButton = null;

  const localField = pathField('txSyLocal', context.localPath, (v) => { context.localPath = v; }, (input) => browseLocal(input, (v) => { context.localPath = v; }));
  const remoteField = pathField('txSyRemote', context.remotePath, (v) => { context.remotePath = v; });

  const body = h('div', { class: 'stack' });
  const grid = h('div', { class: 'tx-sy-grid' });

  function rebuild() {
    clear(grid);

    grid.appendChild(group('txSyDirection',
      radio('tx-sy-dir', 'both', 'txSyDirBoth', options.direction, setDirection),
      radio('tx-sy-dir', 'remote', 'txSyDirRemote', options.direction, setDirection),
      radio('tx-sy-dir', 'local', 'txSyDirLocal', options.direction, setDirection)));

    // design/main/queue.js only calls setTimes() when the destination adapter
    // reports caps.timestamp, and s3/webdav/plain-FTP report false. A timestamp
    // synchronization there would compare, decide, and write nothing.
    const canTimestamp = timestampCapable();
    grid.appendChild(group('txSyMode',
      radio('tx-sy-mode', 'synchronize', 'txSyModeSync', options.mode, setMode),
      radio('tx-sy-mode', 'mirror', 'txSyModeMirror', options.mode, setMode),
      radio('tx-sy-mode', 'timestamp', 'txSyModeTimestamp', options.mode, setMode,
        canTimestamp ? {} : { disabled: true, reasonKey: 'txSyNoTimestamps', reasonArgs: [protocolLabel()] })));

    grid.appendChild(group('txSyCriteria',
      check('txSyByTime', options.byTime, (v) => { options.byTime = v; refresh(); }).element,
      check('txSyBySize', options.bySize, (v) => { options.bySize = v; refresh(); }).element,
      check('txSyByChecksum', false, () => {}, { disabled: true, reasonKey: 'txSyChecksumUnsupported' }).element,
      check('txSyCaseSensitive', options.caseSensitive, (v) => { options.caseSensitive = v; refresh(); }).element));

    grid.appendChild(group('txSyOptions',
      check('txSyDelete', options.deleteFiles, (v) => { options.deleteFiles = v; refresh(); }).element,
      check('txSyExistingOnly', options.existingOnly, (v) => { options.existingOnly = v; refresh(); }).element,
      check('txSyRecursive', options.recursive, (v) => { options.recursive = v; refresh(); }).element,
      // With deletions on, the checklist is not optional — start() forces it.
      // The box therefore shows ticked AND disabled rather than ticked-but-not-
      // in-the-model, which is a control that does not round-trip.
      check('txSyPreview', options.deleteFiles ? true : options.preview,
        (v) => { options.preview = v; rebuild(); },
        options.deleteFiles ? { disabled: true, reasonKey: 'txSyPreviewForced' } : {}).element,

      check('txSySelectedOnly', options.selectedOnly, (v) => { options.selectedOnly = v; refresh(); }, {
        disabled: !context.selection || !context.selection.length,
        reasonKey: 'txSyNoSelection',
      }).element));

    const maskField = pathField('txSyMask', options.fileMask, (v) => { options.fileMask = v; refresh(); });
    grid.appendChild(group('txSyTransfer',
      maskField.element,
      h('p', { class: 'tx-sy-note' }, t('txSyMaskHint')),
      h('div', { class: 'row' },
        ...['binary', 'text', 'automatic'].map((m) => radio('tx-sy-tm', m,
          m === 'binary' ? 'modeBinary' : m === 'text' ? 'modeText' : 'modeAuto',
          options.transferMode, (v) => { options.transferMode = v; refresh(); }))),
      check('preserveTimestamp', options.preserveTime && canTimestamp, (v) => { options.preserveTime = v; refresh(); },
        canTimestamp ? {} : { disabled: true, reasonKey: 'txSyNoPreserveTime', reasonArgs: [protocolLabel()] }).element,
      check('txSyIncludeHidden', !options.excludeHidden, (v) => { options.excludeHidden = !v; refresh(); }).element));

    refresh();
  }

  /**
   * The destination adapter's own capability object, read once through
   * fileysteminfo.js's cache — the same object the server-information window
   * shows, so the greyed-out control and the capability list can never disagree.
   */
  function destinationCaps() {
    return (context.sessionId && capabilitiesOf(context.sessionId)) || null;
  }
  function timestampCapable() {
    const caps = destinationCaps();
    // With no session yet the option stays available: refusing it before we
    // know would be guessing, and the dialog rebuilds when the caps arrive.
    return !caps || caps.timestamp !== false;
  }
  function protocolLabel() {
    const caps = destinationCaps();
    return (caps && caps.protocolName) || (context.protocolName || t('remotePanel'));
  }

  function setDirection(value) { options.direction = value; refresh(); }
  function setMode(value) {
    options.mode = value;
    // Timestamp mode cannot delete; clear it rather than letting the user save
    // a combination the engine will refuse.
    if (value === 'timestamp') options.deleteFiles = false;
    rebuild();
  }

  function refresh() {
    const errorKey = syncCombinationError(options);
    if (refusalEl) {
      refusalEl.hidden = !errorKey;
      clear(refusalEl);
      if (errorKey) {
        refusalEl.append(icon('warning', 16), h('span', {}, `${t('txSyRefusedTitle')}: ${t(errorKey)}`));
      }
    }
    if (okButton) okButton.disabled = !!errorKey;
  }

  refusalEl = h('p', { class: 'tx-sy-refuse', role: 'alert', hidden: true });

  const rememberRow = check('txSySameNextTime', saveNextTime, (v) => { saveNextTime = v; });

  body.append(
    h('div', { class: 'tx-sy-grid' }, localField.element, remoteField.element),
    grid,
    rememberRow.element,
    refusalEl);

  const handle = openModal({
    title: t('txSyTitle'),
    width: 880,
    dismissOnScrim: false,
    content: body,
    actions: [
      { label: t('cancel'), kind: 'text' },
      {
        label: t('txSyCompare'),
        kind: 'filled',
        autofocus: true,
        ref: (btn) => { okButton = btn; },
        onSelect: (close) => { start(close); return true; },
      },
    ],
  });

  // Fill the paths from the live session once it is known, without blocking the
  // dialog from opening.
  loadTransferPrefs().then(() => resolveContext(props)).then((ctx) => {
    context = { ...ctx, localPath: context.localPath || ctx.localPath, remotePath: context.remotePath || ctx.remotePath };
    localField.input.value = context.localPath || '';
    remoteField.input.value = context.remotePath || '';
    rebuild();
  });

  rebuild();

  // Fetch the destination's capabilities so the timestamp controls settle into
  // their real state; until it arrives they stay available rather than being
  // refused on a guess.
  if (context.sessionId && !capabilitiesOf(context.sessionId)) {
    fetchFileSystemInfo(context.sessionId).then(() => rebuild()).catch(() => { /* stays optimistic */ });
  }

  async function start(close) {
    const errorKey = syncCombinationError(options);
    if (errorKey) { notify.warning(t('txSyRefusedTitle'), t(errorKey)); return; }
    const b = bridge();
    if (!b?.sync?.compare) { notify.error(t('txSyTitle'), t('txSyNoBridge')); return; }
    if (!context.sessionId) { notify.warning(t('txSyTitle'), t('txSyNoSession')); return; }

    if (saveNextTime) {
      await setTransferPref('synchronize', { ...options }, 'Saved the synchronize options');
      await setTransferPref('synchronize.remember', true, 'Saved the synchronize options');
    }

    const progress = notify.progress(t('txSyTitle'),
      t('txSyComparing', oneLine(context.localPath, 60), oneLine(context.remotePath, 60)),
      { progress: true });
    try {
      const result = unwrapSync(await b.sync.compare(compareRequest(options, context)));
      progress.dismiss();
      const items = applySelectionPolicy(result.items || [], {
        deleteFiles: options.deleteFiles,
        existingOnly: options.existingOnly,
        recursive: options.recursive,
        selection: options.selectedOnly ? context.selection : null,
      });
      close();
      if (!items.length) { notify.info(t('txSyTitle'), t('syncNoDiff')); return; }
      notify.success(t('txSyTitle'), t('txSyCompared', items.length));

      const summary = summarizeChecklist(items, { onlyChecked: true });
      // "Preview changes" genuinely decides whether the checklist is shown, and
      // a synchronization that would delete always shows it whatever the box says.
      if (!options.preview && summary.deletions === 0) {
        await applyWithoutReview(b, result.token, items, summary);
        return;
      }
      openChecklistDialog({
        token: result.token,
        items,
        counts: result.counts,
        sessionId: context.sessionId,
        localPath: context.localPath,
        remotePath: context.remotePath,
        copyParam: compareRequest(options, context).copyParam,
        onApplied: () => queueModel.refresh(),
      });
    } catch (err) {
      progress.dismiss();
      notify.error(t('txSyTitle'), err.message);
    }
  }

  /** No deletions and no preview asked for: queue the transfers straight away. */
  async function applyWithoutReview(b, token, items, summary) {
    try {
      const res = unwrapSync(await b.sync.apply({
        token,
        checked: items.map((i) => !!i.checked && i.action !== 'nothing'),
        onlyChecked: true,
        performDeletions: false,
      }));
      queueModel.refresh();
      const queued = (res?.items || []).length;
      const lines = describeChecklist(summary).map((l) => t(l.key, ...l.params)).join(' ');
      notify.success(t('txSyTitle'), `${t('txSyApplied', queued)} ${lines}`);
    } catch (err) {
      notify.error(t('txSyTitle'), err.message);
    }
  }

  return handle;
}

/* ================================================================== */
/* Keep remote directory up to date                                    */
/* ================================================================== */

const watchers = new Map();     // watcher id -> { localPath, remotePath }
let kutdWindow = null;

/** Pure presentation state for the asynchronous start/stop seam. */
export function watcherUiState(watcherId, pendingAction = null) {
  if (pendingAction === 'start') return { action: 'start', busy: true, labelKey: 'txKutdStarting' };
  if (pendingAction === 'stop') return { action: 'stop', busy: true, labelKey: 'txKutdStopping' };
  return watcherId
    ? { action: 'stop', busy: false, labelKey: 'txKutdStop' }
    : { action: 'start', busy: false, labelKey: 'txKutdStart' };
}

/**
 * Errors must interrupt the watcher's otherwise polite activity stream. A
 * transport failure is actionable even when the window is not focused, so its
 * log row is an assertive alert rather than another low-priority log entry.
 */
export function watcherLogState(kind = 'activity') {
  return kind === 'error'
    ? { role: 'alert', 'aria-live': 'assertive' }
    : { role: 'status', 'aria-live': 'polite' };
}

export function openKeepUpToDateDialog(props = {}) {
  injectTransferStyles();
  injectSyncStyles();
  if (kutdWindow) { kutdWindow.focus(); return kutdWindow; }

  const options = { ...SYNC_DEFAULTS, direction: 'remote', ...(transferPref('keepUpToDate', null) || {}), ...(props.options || {}) };
  let context = { sessionId: props.sessionId || null, localPath: props.localPath || '', remotePath: props.remotePath || '' };
  let watcherId = null;
  let pendingAction = null;

  const restoreFocus = focusMemory();
  const titleId = uid('tx-kutd-title');
  const logEl = h('div', { class: 'tx-sy-log', role: 'log', 'aria-live': 'polite' });
  const statusEl = h('p', { class: 'tx-sy-note', role: 'status' });

  const localField = pathField('txSyLocal', context.localPath, (v) => { context.localPath = v; }, (input) => browseLocal(input, (v) => { context.localPath = v; }));
  const remoteField = pathField('txSyRemote', context.remotePath, (v) => { context.remotePath = v; });

  const startBtn = h('button', { type: 'button', class: 'btn-filled', onclick: () => toggle() });
  const closeBtn = h('button', { type: 'button', class: 'icon-btn', onclick: () => close() }, icon('close', 18));
  bindText(closeBtn, 'close', { attr: 'aria-label' });
  bindText(closeBtn, 'close', { attr: 'title' });

  const optionsBox = group('txSyOptions',
    check('txSyDelete', options.deleteFiles, (v) => { options.deleteFiles = v; }).element,
    check('txSyExistingOnly', options.existingOnly, (v) => { options.existingOnly = v; }).element,
    check('txSyRecursive', options.recursive, (v) => { options.recursive = v; }).element,
    check('txKutdSyncOnStart', options.syncOnStart, (v) => { options.syncOnStart = v; }).element,
    check('txKutdContinueOnError', options.continueOnError, (v) => { options.continueOnError = v; }).element);

  const root = h('div', {
    class: 'tx-pg-window surface-3', role: 'dialog', 'aria-modal': 'false',
    'aria-labelledby': titleId, tabindex: '-1',
  },
  h('header', { class: 'nc-head' },
    icon('sync_alt', 18),
    h('span', { class: 'nc-head-title', id: titleId }, t('txKutdTitleFull')),
    closeBtn),
  h('div', { class: 'tx-pg' },
    h('p', { class: 'prose' }, t('txKutdExplain')),
    h('div', { class: 'tx-sy-grid' }, localField.element, remoteField.element),
    optionsBox,
    statusEl,
    h('div', { class: 'stack', style: { gap: '4px' } },
      h('span', { class: 'tx-pg-stat-label' }, t('txKutdLog')),
      logEl)),
  h('div', { class: 'tx-q-toolbar' }, startBtn));
  appearanceTarget(root, 'kutd-window', 'Keep remote directory up to date');

  layer('popover').appendChild(root);
  root.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });

  function log(text, kind = 'activity') {
    const live = watcherLogState(kind);
    const line = h('div', { class: 'tx-sy-log-line' },
      h('span', { class: 'tx-sy-log-time' }, new Date().toLocaleTimeString()),
      h('span', { class: 'ellipsis', title: text }, text));
    line.setAttribute('role', live.role);
    line.setAttribute('aria-live', live['aria-live']);
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
    if (logEl.childElementCount > 500) logEl.removeChild(logEl.firstChild);
  }

  function paint() {
    const state = watcherUiState(watcherId, pendingAction);
    clear(startBtn);
    startBtn.append(icon(state.action === 'stop' ? 'close' : 'sync_alt', 16), h('span', {}, t(state.labelKey)));
    startBtn.disabled = state.busy;
    startBtn.setAttribute('aria-busy', state.busy ? 'true' : 'false');
    statusEl.textContent = state.busy
      ? t(state.labelKey)
      : watcherId ? t('txKutdRunning', context.localPath) : t('txKutdExplain');
    statusEl.setAttribute('aria-busy', state.busy ? 'true' : 'false');
    for (const el of root.querySelectorAll('input')) el.disabled = !!watcherId;
    if (!logEl.childElementCount) log(t('txKutdLogEmpty'));
  }

  async function toggle() {
    if (pendingAction) return;
    const b = bridge();
    if (watcherId) { await stopWatcher(); return; }
    if (!b?.sync?.keepUpToDate) { notify.error(t('txKutdTitleFull'), t('txSyNoBridge')); return; }
    if (!context.sessionId) { notify.warning(t('txKutdTitleFull'), t('txSyNoSession')); return; }
    const errorKey = syncCombinationError(options);
    if (errorKey) { notify.warning(t('txSyRefusedTitle'), t(errorKey)); return; }
    pendingAction = 'start';
    paint();
    try {
      const res = unwrapSync(await b.sync.keepUpToDate({
        ...compareRequest(options, context),
        direction: 'remote',
      }));
      watcherId = res?.id || null;
      if (watcherId) watchers.set(watcherId, { localPath: context.localPath, remotePath: context.remotePath });
      await setTransferPref('keepUpToDate', { ...options }, 'Saved the keep-up-to-date options');
      log(t('txKutdRunning', context.localPath));
      notify.success(t('txKutdTitleFull'), t('txKutdRunning', context.localPath));
    } catch (err) {
      notify.error(t('txKutdTitleFull'), err.message);
    } finally {
      pendingAction = null;
      paint();
    }
  }

  async function stopWatcher() {
    if (!watcherId || pendingAction) return;
    const id = watcherId;
    pendingAction = 'stop';
    paint();
    try {
      unwrapSync(await bridge().sync.stop(id));
      log(t('txKutdStopped', context.localPath));
      notify.info(t('txKutdTitleFull'), t('txKutdStopped', context.localPath));
      if (watcherId === id) watcherId = null;
      watchers.delete(id);
    } catch (err) {
      notify.error(t('txKutdTitleFull'), err.message);
    } finally {
      pendingAction = null;
      paint();
    }
  }

  const offSync = bus.on('sync:event', (payload) => {
    if (!watcherId || payload?.id !== watcherId) return;
    if (payload.type === 'error') { log(t('txKutdError', payload.payload?.message || payload.payload || ''), 'error'); return; }
    if (payload.type === 'change' || payload.type === 'changes') {
      const items = payload.payload?.items?.length || 0;
      const deletions = payload.payload?.deletions?.length || 0;
      log(t('txKutdChange', items, deletions));
      queueModel.refresh();
      return;
    }
    if (payload.type === 'stopped') { log(t('txKutdStopped', context.localPath)); watcherId = null; paint(); }
  });

  // design/main/sync.js's Watcher emits 'changes'/'tick' while design/main/ipc.js
  // forwards 'change'/'synchronized', so a change event does not currently reach
  // the renderer. The queue does, so the log reports what was actually enqueued
  // rather than staying blank while files fly past.
  const known = new Set(queueModel.snapshot.items.map((i) => i.id));
  const offQueue = queueModel.subscribe((snap) => {
    if (!watcherId) { for (const i of snap.items) known.add(i.id); return; }
    for (const item of snap.items) {
      if (known.has(item.id)) continue;
      known.add(item.id);
      log(t('txSyQueuedNew', oneLine(item.source, 90)));
    }
  });

  function close() {
    offSync();
    offQueue();
    root.remove();
    kutdWindow = null;
    restoreFocus();
    if (watcherId) {
      // Closing the window must not silently abandon a running watcher.
      notify.info(t('txKutdTitleFull'), t('txKutdRunning', context.localPath));
    }
  }

  resolveContext(props).then((ctx) => {
    context = { ...ctx, localPath: context.localPath || ctx.localPath, remotePath: context.remotePath || ctx.remotePath };
    localField.input.value = context.localPath || '';
    remoteField.input.value = context.remotePath || '';
    paint();
  });

  kutdWindow = { element: root, close, focus: () => root.focus() };
  paint();
  requestAnimationFrame(() => root.focus());
  return kutdWindow;
}

/* ================================================================== */
/* wiring                                                              */
/* ================================================================== */

// `event:sync` is the watcher's own channel; it is republished on the bus so
// several surfaces (this window, a future log panel) can follow it.
onMainEvent('event:sync', (payload) => bus.emit('sync:event', payload));

// Neither dialog is in the shell's dialog registry: openDialog() builds the
// modal from the spec it is handed, and both of these own their own surface —
// Synchronize gates a comparison before it closes, and Keep-up-to-date is a
// non-modal window because watching must not block the panels. They are reached
// through the commands below, or by calling the exported functions.

registerCommand({
  id: 'sync.synchronize', labelKey: 'synchronizeMenu', icon: 'sync_alt',
  run: (props) => openSynchronizeDialog(props || {}),
});
registerCommand({
  id: 'sync.keepUpToDate', labelKey: 'keepUpToDate', icon: 'refresh',
  run: (props) => openKeepUpToDateDialog(props || {}),
});

const SYNC_CSS = `
.tx-sy-group .check { min-height: calc(30px * var(--den)); align-items: flex-start; }
.tx-sy-group .check input { margin-top: calc(5px * var(--den)); }
.tx-sy-group .check span { line-height: 1.4; }
.tx-sy-refuse { display: flex; align-items: flex-start; gap: 8px; }
`;

let injected = false;
function injectSyncStyles() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const el = document.createElement('style');
  el.id = 'sheet-transfer-sync';
  el.textContent = SYNC_CSS;
  document.head.appendChild(el);
}
