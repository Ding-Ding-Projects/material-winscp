// ui/dialogs/filefind.js — forms/FileFind.dfm (TFileFindDialog).
//
// The Find window, driving design/main/find.js over fs:find. Three things
// about it are deliberate:
//
//  1. **It is not modal.** WinSCP's Find is a Show() window, not ShowModal():
//     you find a file, focus it in the panel, and keep searching. A modal here
//     would make "double-click to reveal in the panel" impossible, so this is
//     a floating window (role=dialog, aria-modal=false) with Escape to close
//     and focus restored on the way out — the shell's modal primitive is for
//     decisions, and a search is not one.
//
//  2. **Results stream.** Each hit is appended the moment main emits it, in
//     the order the walk produced, and the status line names the directory
//     being walked. A search over a slow server shows its first hit
//     immediately.
//
//  3. **Stop really stops.** The button calls fs:findCancel, which aborts the
//     generator inside main; it does not merely stop rendering. Closing the
//     window cancels too, so a forgotten search cannot keep a session busy.
//
// Two mismatches in the current fs:find bridge are compensated for here rather
// than papered over — see startSearch(): main forwards `text`, `recursive` and
// `maxResults` to find.js, which reads `grep`, `maxDepth` and `limit`, so a
// content search would come back unfiltered and a limit would be ignored. Each
// hit is therefore verified in this window before it is shown, and the limit is
// enforced by cancelling. Both are documented in the report for that build.

import {
  h, icon, uid, clear, appearanceTarget, announce, layer, focusMemory, copyText, oneLine,
} from '../../dom.js';
import { t, bindRender } from '../../i18n.js';
import { registerCommand, openModal } from '../../app.js';
import { notify } from '../notifications.js';
import { createSearchBar, filterBy, noMatchMessage } from '../searchbar.js';
import { openRegexBuilder } from '../regexbuilder.js';
import { registerContextMenu, SEPARATOR } from '../contextmenu.js';
import {
  makeTranslator, txLabel, ops, checkRow, readHistory, pushHistory,
  formatBytes, formatTimestamp, parentOf, baseNameOf,
} from './rights.js';
import { validateMask, maskHints, openEditMask } from './editmask.js';

const STRINGS = {
  ffTitle: ['Find', '搵嘢'],
  ffFinding: ['Finding…', '搵緊…'],
  ffFilter: ['Filter', '篩選'],
  ffSearchIn: ['Search in', '搜尋位置'],
  ffMask: ['File mask', '檔案遮罩'],
  ffEdit: ['Edit…', '編輯…'],
  ffContaining: ['Containing text', '包含文字'],
  ffCaseSensitive: ['Case sensitive', '分大細楷'],
  ffRegex: ['Regular expression', '正規表達式'],
  ffRecursive: ['Search subdirectories', '搵埋下面嘅目錄'],
  ffLimit: ['Stop after', '搵到幾多就停'],
  ffStart: ['Start', '開始'],
  ffStop: ['Stop', '停'],
  ffDone: ['Done.', '搞掂。'],
  ffAborted: ['Aborted.', '停咗。'],
  ffInDirectory: ['Searching in {0}', '搵緊 {0}'],
  ffFound: ['{0} file(s) found.', '搵到 {0} 個檔案。'],
  ffNone: ['No files found.', '搵唔到檔案。'],
  ffChecking: ['Checking remaining candidates…', '仲喺度確認剩低嘅候選檔案…'],
  ffResults: ['Results', '結果'],
  ffResultsSearch: ['Search the results', '搵結果'],
  ffColName: ['Name', '名'],
  ffColDirectory: ['Directory', '目錄'],
  ffColSize: ['Size', '大小'],
  ffColChanged: ['Changed', '修改時間'],
  ffFocus: ['Focus', '跳過去'],
  ffDownload: ['Download…', '下載…'],
  ffEdit2: ['Edit', '編輯'],
  ffDelete: ['Delete', '刪除'],
  ffSelectAll: ['Select all', '全揀'],
  ffCopyResults: ['Copy results', '複製結果'],
  ffCopied: ['{0} result(s) copied.', '複製咗 {0} 個結果。'],
  ffDeleteTitle: ['Delete found files', '刪除搵到嘅檔案'],
  ffDeleteBody: ['Delete {0} found item(s)? This cannot be undone.', '刪除搵到嘅 {0} 個項目？呢個動作冇得復原。'],
  ffDeleted: ['{0} item(s) deleted.', '刪咗 {0} 個項目。'],
  ffError: ['{0} could not be read: {1}', '{0} 讀唔到：{1}'],
  ffContentNeedsSession: [
    'Searching inside files runs through a session’s file system; this panel has none open, so only the mask is used.',
    '搵檔案內容要經工作階段嘅檔案系統，呢個面板未開，所以淨係用遮罩搵。'],
  ffContentVerified: [
    'Content matches are confirmed in this window by reading each candidate, so a file bigger than {0} is reported as unverified rather than guessed at.',
    '內容配對係喺呢個視窗度逐個檔案讀返嚟確認，所以大過 {0} 嘅檔案會標做未確認，唔會靠估。'],
  ffUnverified: ['not verified', '未確認'],
  ffInvalidMask: ['Problem at character {0}: {1}', '第 {0} 個字元有問題：{1}'],
  ffInvalidRegex: ['Invalid regular expression: {0}', '正規表達式唔啱：{0}'],
  ffNoRoot: ['Type a directory to search in.', '要打個搵嘅目錄。'],
  ffIdle: ['Press Start to search. Results appear here as they are found.', '撳「開始」搵嘢。搵到嘅會即刻喺呢度出現。'],
  ffClose: ['Close', '閂'],
  ffMatchedLine: ['line {0}', '第 {0} 行'],
};

const tx = makeTranslator(STRINGS);

/** Files larger than this are not read back for content verification. */
const VERIFY_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_LIMIT = 2000;

let openWindow = null;

/**
 * openFileFind(props) -> handle
 *
 * props:
 *   sessionId, sessionName, side, directory, localDirectory
 *   onFocusFile(path)   reveal a hit in the panel (the "Focus" action)
 *   onDownload(paths)   optional; falls back to the transfer queue
 *   onEdit(path)        optional
 *   onDeleted(paths)    called after a successful delete
 */
export function openFileFind(props = {}) {
  // One Find window, like the original's single static instance.
  if (openWindow) { openWindow.focus(); openWindow.reconfigure(props); return openWindow; }

  const restoreFocus = focusMemory();
  const titleId = uid('ff-title');
  const hasSession = !!props.sessionId;

  let state = 'init';            // init | finding | aborting | done | aborted
  let correlationId = null;
  let offProgress = null;
  let results = [];
  let selection = new Set();
  let matcher = null;            // { re } while a content search is running
  let pending = 0;               // verifications still in flight
  let searchGeneration = 0;

  /* ---------------- the filter group ---------------- */

  const rootId = uid('ff-root');
  const maskId = uid('ff-mask');
  const textId = uid('ff-text');

  const rootInput = h('input', {
    type: 'text', class: 'field-input', id: rootId, autocomplete: 'off', spellcheck: 'false',
    list: `${rootId}-history`, style: { flex: '1 1 auto', minWidth: 0 },
    oninput: () => updateControls(),
  });
  rootInput.value = props.directory || '';
  const rootHistory = h('datalist', { id: `${rootId}-history` });

  const maskInput = h('input', {
    type: 'text', class: 'field-input mono', id: maskId, autocomplete: 'off', spellcheck: 'false',
    list: `${maskId}-history`, style: { flex: '1 1 auto', minWidth: 0 },
    oninput: () => updateControls(),
  });
  const maskHistory = h('datalist', { id: `${maskId}-history` });

  const textInput = h('input', {
    type: 'text', class: 'field-input', id: textId, autocomplete: 'off',
    style: { flex: '1 1 auto', minWidth: 0 },
    oninput: () => updateControls(),
  });
  textInput.disabled = !hasSession;

  const caseCheck = checkRow(txLabel(tx, 'ffCaseSensitive'), false, () => updateControls());
  const regexCheck = checkRow(txLabel(tx, 'ffRegex'), false, () => updateControls());
  const recursiveCheck = checkRow(txLabel(tx, 'ffRecursive'), true, () => updateControls());

  const limitId = uid('ff-limit');
  const limitInput = h('input', {
    type: 'number', class: 'field-input', min: '1', max: '200000', id: limitId,
    style: { width: '10ch' }, 'aria-label': tx('ffLimit'),
  });
  limitInput.value = String(DEFAULT_LIMIT);

  const editMaskButton = h('button', {
    type: 'button', class: 'btn-text',
    onclick: () => openEditMask({
      mask: maskInput.value,
      sampleNames: results.map((r) => r.name),
      onApply: (mask) => { maskInput.value = mask; updateControls(); },
    }),
  });
  bindRender(editMaskButton, () => { editMaskButton.textContent = tx('ffEdit'); });
  const regexMaskButton = h('button', {
    type: 'button', class: 'icon-btn', 'aria-label': tx('ffRegex'), title: tx('ffRegex'),
    onclick: () => openRegexBuilder({
      anchor: regexMaskButton, pattern: maskInput.value,
      sample: results.map((r) => r.name).join('\n'), title: tx('ffMask'),
      onApply: ({ pattern }) => { maskInput.value = pattern; updateControls(); maskInput.focus(); },
    }),
  }, icon('code', 18));

  function labelledRow(labelKey, control, ...trailing) {
    const label = h('label', { class: 'field-label', for: control.id, style: { width: 'calc(14ch * var(--uiscale))' } });
    bindRender(label, () => { label.textContent = tx(labelKey); });
    return h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, label, control, ...trailing);
  }

  const maskStatus = h('div', {
    role: 'status',
    style: { fontSize: 'var(--type-label-sm)', color: 'var(--onerrc)', lineHeight: '1.4' },
  });
  maskStatus.hidden = true;

  const contentNote = h('div', { class: 'muted', style: { fontSize: 'var(--type-label-sm)', lineHeight: '1.45' } });
  bindRender(contentNote, () => {
    contentNote.textContent = hasSession
      ? tx('ffContentVerified', formatBytes(VERIFY_MAX_BYTES))
      : tx('ffContentNeedsSession');
  });

  const filterGroup = h('fieldset', {
    style: {
      border: '1px solid var(--outline-var)', borderRadius: 'var(--shape-md)',
      padding: 'calc(10px * var(--den))', margin: 0, minWidth: 0,
      display: 'flex', flexDirection: 'column', gap: 'calc(8px * var(--den))',
    },
  },
  h('legend', { class: 'field-label' }, tx('ffFilter')),
  labelledRow('ffSearchIn', rootInput),
  rootHistory,
  labelledRow('ffMask', maskInput, regexMaskButton, editMaskButton),
  maskHistory,
  maskStatus,
  labelledRow('ffContaining', textInput),
  h('div', { class: 'row' }, caseCheck.element, regexCheck.element, recursiveCheck.element,
    h('label', { class: 'field-label', for: limitId }, tx('ffLimit')), limitInput),
  contentNote);

  /* ---------------- results ---------------- */

  const resultSearch = createSearchBar({
    id: 'filefind-results',
    persist: false,
    compact: true,
    labelKey: 'search',
    placeholder: tx('ffResultsSearch'),
    sampleProvider: () => results.map((r) => r.path).join('\n'),
    onChange: () => paintResults(),
  });

  const listId = uid('ff-list');
  const resultList = h('div', {
    role: 'listbox', tabindex: '0', 'aria-multiselectable': 'true',
    id: listId, 'aria-label': tx('ffResults'),
    style: {
      flex: '1 1 auto', minHeight: 'calc(180px * var(--uiscale))',
      overflow: 'auto', border: '1px solid var(--outline-var)',
      borderRadius: 'var(--shape-sm)', background: 'var(--c-lowest)', padding: '4px',
      display: 'flex', flexDirection: 'column', gap: '1px',
    },
  });

  const statusLine = h('div', {
    role: 'status',
    style: {
      minHeight: 'calc(22px * var(--den))', fontSize: 'var(--type-label-md)',
      color: 'var(--onsv)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    },
  });

  let focusedIndex = -1;

  function visibleResults() {
    if (!resultSearch.isActive) return results;
    return filterBy(results, resultSearch.predicate, (r) => [r.name, r.directory, r.path]);
  }

  function paintResults() {
    const items = visibleResults();
    clear(resultList);
    resultList.removeAttribute('aria-activedescendant');
    if (!items.length) {
      resultList.appendChild(h('div', {
        class: 'muted',
        style: { padding: 'calc(12px * var(--den))', fontSize: 'var(--type-body-sm)' },
      }, resultSearch.isActive
        ? noMatchMessage(resultSearch.predicate, tx('ffResults'))
        : pending > 0 ? tx('ffChecking')
        : (state === 'done' || state === 'aborted' ? tx('ffNone') : tx('ffIdle'))));
      return;
    }
    items.forEach((hit, index) => {
      const selected = selection.has(hit.path);
      const row = h('div', {
        role: 'option', 'aria-selected': String(selected), tabindex: '-1',
        // The listbox is one tab stop with roving focus in state rather than in
        // the DOM, so the focused row has to be named through
        // aria-activedescendant or a screen reader announces nothing as the
        // arrows move.
        id: `${listId}-o${index}`,
        'data-index': String(index),
        style: {
          display: 'flex', alignItems: 'center', gap: 'calc(10px * var(--den))',
          minHeight: 'calc(30px * var(--den))', padding: '0 calc(8px * var(--den))',
          borderRadius: 'var(--shape-xs)',
          background: selected ? 'var(--secc)' : (index === focusedIndex ? 'var(--c)' : 'transparent'),
          color: selected ? 'var(--onsecc)' : 'var(--onsfc)',
          fontSize: 'var(--type-body-sm)', cursor: 'default',
        },
        onclick: (e) => {
          focusedIndex = index;
          if (e.ctrlKey || e.metaKey) { if (selected) selection.delete(hit.path); else selection.add(hit.path); }
          else { selection = new Set([hit.path]); }
          paintResults();
          updateControls();
        },
        ondblclick: () => focusFile(hit),
      },
      icon(hit.type === 'dir' ? 'folder' : 'description', 15),
      h('span', { class: 'ellipsis', style: { flex: '0 1 22ch' }, title: hit.name }, hit.name),
      h('span', { class: 'ellipsis muted', style: { flex: '1 1 auto' }, title: hit.directory }, hit.directory),
      hit.matchLine ? h('span', {
        class: 'chip', title: hit.matchText || '',
        style: { flex: '0 0 auto', background: 'var(--terc)', color: 'var(--onterc)' },
      }, h('span', {}, tx('ffMatchedLine', hit.matchLine))) : null,
      hit.unverified ? h('span', { class: 'chip is-warn' }, h('span', {}, tx('ffUnverified'))) : null,
      h('span', { class: 'mono muted', style: { flex: '0 0 auto', fontSize: 'var(--type-label-sm)' } },
        hit.type === 'dir' ? '' : formatBytes(hit.size)),
      h('span', { class: 'mono muted', style: { flex: '0 0 auto', fontSize: 'var(--type-label-sm)' } },
        formatTimestamp(hit.mtime)));
      resultList.appendChild(row);
    });
    if (focusedIndex >= 0 && focusedIndex < items.length) {
      resultList.setAttribute('aria-activedescendant', `${listId}-o${focusedIndex}`);
    }
  }

  resultList.addEventListener('keydown', (e) => {
    const items = visibleResults();
    if (!items.length) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      copyResults();
      return;
    }
    const moveTo = (index) => {
      focusedIndex = Math.max(0, Math.min(items.length - 1, index));
      // Ctrl+arrow moves without disturbing a multi-file selection.
      if (!e.ctrlKey && !e.metaKey) selection = new Set([items[focusedIndex].path]);
    };
    if (e.key === 'ArrowDown') { e.preventDefault(); moveTo(focusedIndex + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveTo(focusedIndex - 1); }
    else if (e.key === 'Home') { e.preventDefault(); moveTo(0); }
    else if (e.key === 'End') { e.preventDefault(); moveTo(items.length - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); if (items[focusedIndex]) focusFile(items[focusedIndex]); return; }
    else if (e.key === ' ') {
      e.preventDefault();
      const hit = items[focusedIndex];
      if (hit) { if (selection.has(hit.path)) selection.delete(hit.path); else selection.add(hit.path); }
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      selection = new Set(items.map((r) => r.path));
    } else return;
    paintResults();
    updateControls();
    const row = resultList.querySelector(`[data-index="${focusedIndex}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  });

  registerContextMenu(resultList, () => {
    const hit = selectedHits()[0];
    return [
      { label: tx('ffFocus'), icon: 'open_in_new', disabled: !hit, onSelect: () => hit && focusFile(hit) },
      { label: tx('ffEdit2'), icon: 'edit', disabled: !hit || !props.onEdit, onSelect: () => hit && props.onEdit(hit.path) },
      { label: tx('ffDownload'), icon: 'download', disabled: !selectedHits().length, onSelect: () => downloadSelected() },
      SEPARATOR,
      { label: tx('ffDelete'), icon: 'delete', danger: true, disabled: !selectedHits().length, onSelect: () => deleteSelected() },
      SEPARATOR,
      { label: tx('ffSelectAll'), icon: 'select_all', onSelect: () => { selection = new Set(visibleResults().map((r) => r.path)); paintResults(); updateControls(); } },
      { label: tx('ffCopyResults'), icon: 'content_copy', disabled: !results.length, onSelect: () => copyResults() },
    ];
  });

  /* ---------------- actions ---------------- */

  function selectedHits() { return results.filter((r) => selection.has(r.path)); }

  function focusFile(hit) {
    if (!hit) return;
    if (typeof props.onFocusFile === 'function') {
      props.onFocusFile(hit.path, hit);
      announce(`${tx('ffFocus')}: ${hit.path}`);
    } else {
      notify.info(tx('ffFocus'), hit.path);
    }
  }

  async function downloadSelected() {
    const hits = selectedHits();
    if (!hits.length) return;
    if (typeof props.onDownload === 'function') { props.onDownload(hits.map((x) => x.path)); return; }
    if (!props.localDirectory || !props.sessionId) {
      notify.warning(tx('ffDownload'), t('notConnected'));
      return;
    }
    try {
      await ops.queue.add({
        sessionId: props.sessionId,
        direction: 'download',
        files: hits.map((x) => x.path),
        target: props.localDirectory,
      });
      notify.success(t('queueTitle'), t('transferDone', hits.length, props.localDirectory));
    } catch (err) {
      notify.error(tx('ffDownload'), err.message);
    }
  }

  function deleteSelected() {
    const hits = selectedHits();
    if (!hits.length) return;
    // A deletion is a decision, so this one really is a modal.
    openModal({
      title: tx('ffDeleteTitle'),
      content: h('div', { class: 'stack' },
        h('p', { class: 'prose' }, tx('ffDeleteBody', hits.length)),
        h('div', {
          class: 'mono',
          style: { maxHeight: 'calc(160px * var(--uiscale))', overflow: 'auto', fontSize: 'var(--type-label-sm)' },
        }, ...hits.slice(0, 50).map((x) => h('div', { class: 'ellipsis', title: x.path }, x.path)))),
      actions: [
        { label: t('cancel'), kind: 'text' },
        {
          label: t('delete_'), kind: 'danger',
          onSelect: async () => {
            try {
              const res = await ops.fs.remove(props.sessionId, hits.map((x) => x.path), { recursive: true });
              const removed = (res && res.removed) || [];
              results = results.filter((r) => !removed.includes(r.path));
              for (const p of removed) selection.delete(p);
              paintResults();
              updateControls();
              notify.success(tx('ffDeleted', removed.length));
              props.onDeleted?.(removed);
              if (res && res.failed && res.failed.length) {
                notify.error(tx('ffDeleteTitle'), res.failed.map((f) => `${f.path}: ${f.message}`).join('\n'));
              }
            } catch (err) {
              notify.error(tx('ffDeleteTitle'), err.message);
            }
          },
        },
      ],
    });
  }

  async function copyResults() {
    const lines = visibleResults().map((r) => r.path);
    if (!lines.length) return;
    if (await copyText(lines.join('\n'))) notify.success(tx('ffCopied', lines.length));
  }

  /* ---------------- the search itself ---------------- */

  function buildMatcher() {
    const text = textInput.value;
    if (!text || !hasSession) return null;
    const source = regexCheck.input.checked ? text : text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    try {
      return { re: new RegExp(source, caseCheck.input.checked ? '' : 'i') };
    } catch (err) {
      notify.warning(tx('ffTitle'), tx('ffInvalidRegex', err.message));
      return null;
    }
  }

  /**
   * Confirm a hit really contains the text, and remember which line.
   * The bridge cannot pass find.js its `grep` option today, so a content
   * search that trusted main would return every mask match. Reading the
   * candidate back is slower but truthful, and a file too large to read is
   * marked unverified instead of being claimed as a match.
   */
  async function verifyContent(hit) {
    if (!matcher || hit.type === 'dir') return true;
    if (hit.size > VERIFY_MAX_BYTES) { hit.unverified = true; return true; }
    try {
      const file = await ops.fs.readFile(props.sessionId, hit.path, { maxBytes: VERIFY_MAX_BYTES });
      const bytes = atob(file.base64 || '');
      // The payload is base64 of the raw bytes; decode as UTF-8 so a match on
      // a non-ASCII string is found rather than missed.
      const text = new TextDecoder('utf-8', { fatal: false })
        .decode(Uint8Array.from(bytes, (c) => c.charCodeAt(0)));
      // A NUL byte means binary, and find.js skips those too rather than
      // hunting for a string that could not be there.
      if (text.includes('\u0000')) return false;
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        if (matcher.re.test(lines[i])) {
          hit.matchLine = i + 1;
          hit.matchText = oneLine(lines[i], 200);
          return true;
        }
      }
      return false;
    } catch (err) {
      hit.unverified = true;
      hit.error = err.message;
      return true;
    }
  }

  function acceptHit(raw, generation = searchGeneration) {
    if (generation !== searchGeneration || (state !== 'finding' && state !== 'aborting')) return;
    if (!raw) return;
    const path = raw.path || '';
    if (!path) return;
    const limit = Math.max(1, Number(limitInput.value) || DEFAULT_LIMIT);
    const root = rootInput.value.trim();
    const directory = parentOf(path) || root;

    // fs:find ignores `recursive`, so a non-recursive search is honoured here.
    if (!recursiveCheck.input.checked && directory !== root.replace(/\/+$/, '') && directory !== root) return;

    const hit = {
      path,
      name: raw.name || baseNameOf(path),
      directory,
      type: raw.type || 'file',
      size: Number(raw.size) || 0,
      mtime: Number(raw.mtime) || 0,
      matchLine: raw.matches && raw.matches.length ? raw.matches[0].lineNumber : 0,
      matchText: raw.matches && raw.matches.length ? oneLine(raw.matches[0].line, 200) : '',
      unverified: false,
    };

    if (!matcher || hit.matchLine) {
      addHit(hit, limit);
      return;
    }
    pending += 1;
    const generationAtStart = searchGeneration;
    verifyContent(hit).then((ok) => {
      pending -= 1;
      if (generationAtStart !== searchGeneration) return;
      if (ok) addHit(hit, limit);
      else updateStatus();
    });
  }

  function addHit(hit, limit) {
    results.push(hit);
    paintResults();
    updateStatus();
    if (results.length >= limit && state === 'finding') stopSearch();
  }

  async function startSearch() {
    const root = rootInput.value.trim();
    if (!root) { notify.warning(tx('ffTitle'), tx('ffNoRoot')); return; }
    const mask = maskInput.value.trim();
    const verdict = validateMask(mask);
    if (!verdict.ok) {
      maskStatus.hidden = false;
      maskStatus.textContent = tx('ffInvalidMask', verdict.start + 1, verdict.error);
      return;
    }
    maskStatus.hidden = true;

    matcher = buildMatcher();
    if (textInput.value && hasSession && !matcher) return;   // an invalid pattern was reported

    searchGeneration += 1;
    results = [];
    selection = new Set();
    focusedIndex = -1;
    pending = 0;
    paintResults();

    state = 'finding';
    updateControls();

    const cid = uid('find');
    correlationId = cid;
    offProgress = ops.onProgress((payload) => {
      if (!payload || payload.correlationId !== cid || payload.kind !== 'find') return;
      if (payload.hit) { acceptHit(payload.hit, searchGeneration); updateStatus(payload.hit.path); return; }
      if (payload.error) {
        notify.warning(tx('ffTitle'), tx('ffError', payload.at || root, payload.error));
        return;
      }
      if (payload.done) {
        state = payload.cancelled ? 'aborted' : 'done';
        detach();
        updateControls();
        updateStatus();
      }
    });

    try {
      await ops.fs.find({
        correlationId: cid,
        sessionId: props.sessionId || undefined,
        root,
        mask,
        text: textInput.value || undefined,
        regex: regexCheck.input.checked,
        caseSensitive: caseCheck.input.checked,
        recursive: recursiveCheck.input.checked,
        maxResults: Math.max(1, Number(limitInput.value) || DEFAULT_LIMIT),
      });
      await pushHistory('remoteDirectory', root);
      if (mask) await pushHistory('selectMask', mask);
    } catch (err) {
      state = 'aborted';
      detach();
      updateControls();
      notify.error(tx('ffTitle'), err.message);
    }
  }

  function detach() {
    if (offProgress) { offProgress(); offProgress = null; }
    correlationId = null;
  }

  async function stopSearch() {
    if (state !== 'finding') return;
    state = 'aborting';
    updateControls();
    const cid = correlationId;
    try { if (cid) await ops.fs.findCancel(cid); }
    catch { /* the search may already have finished on its own */ }
    // 'done' arrives from main with cancelled:true; if the bridge is gone,
    // settle the state here so the button never sticks on "Stop".
    setTimeout(() => {
      if (state === 'aborting') { state = 'aborted'; detach(); updateControls(); updateStatus(); }
    }, 1200);
  }

  const startStop = h('button', { type: 'button', class: 'btn-filled', onclick: () => (state === 'finding' || state === 'aborting' ? stopSearch() : startSearch()) });

  function updateStatus(currentPath) {
    if (state === 'finding' || state === 'aborting') {
      const where = currentPath ? parentOf(currentPath) : '';
      statusLine.textContent = where
        ? `${tx('ffInDirectory', where)} — ${tx('ffFound', results.length)}`
        : tx('ffFound', results.length);
    } else if (state === 'done') {
      statusLine.textContent = `${tx('ffDone')} ${tx('ffFound', results.length)}`;
    } else if (state === 'aborted') {
      statusLine.textContent = `${tx('ffAborted')} ${tx('ffFound', results.length)}`;
    } else {
      statusLine.textContent = '';
    }
    if (pending > 0) statusLine.textContent += ` (+${pending})`;
  }

  function updateControls() {
    const finding = state === 'finding' || state === 'aborting';
    startStop.textContent = finding ? tx('ffStop') : tx('ffStart');
    startStop.disabled = !finding && !rootInput.value.trim();
    for (const el of [rootInput, maskInput, textInput, limitInput, editMaskButton,
      caseCheck.input, regexCheck.input, recursiveCheck.input]) {
      el.disabled = finding || (el === textInput && !hasSession);
    }
    windowEl.dataset.state = state;
    titleEl.textContent = `${finding ? tx('ffFinding') : tx('ffTitle')}${props.sessionName ? ` — ${props.sessionName}` : ''}`;
  }

  /* ---------------- the window ---------------- */

  const titleEl = h('h2', {
    id: titleId, class: 'modal-title',
    style: { fontSize: 'var(--type-title-md)', flex: '1 1 auto', minWidth: 0, cursor: 'move' },
  });

  const closeBtn = h('button', {
    type: 'button', class: 'icon-btn', 'aria-label': tx('ffClose'), title: tx('ffClose'),
    onclick: () => close(),
  }, icon('close', 18));

  const header = h('div', {
    style: {
      display: 'flex', alignItems: 'center', gap: 'calc(8px * var(--den))',
      borderBottom: '1px solid var(--outline-var)',
      padding: 'calc(10px * var(--den)) calc(14px * var(--den))',
    },
  }, icon('search', 18), titleEl, closeBtn);

  const hints = h('div', { class: 'muted', style: { fontSize: 'var(--type-label-sm)', lineHeight: '1.5' } });
  bindRender(hints, () => {
    clear(hints);
    for (const hint of maskHints()) hints.appendChild(h('div', {}, hint));
  });

  const body = h('div', {
    style: {
      display: 'flex', flexDirection: 'column', gap: 'calc(10px * var(--den))',
      padding: 'calc(12px * var(--den)) calc(14px * var(--den))',
      overflow: 'auto', flex: '1 1 auto', minHeight: 0,
    },
  },
  filterGroup,
  h('div', { class: 'row' }, startStop, resultSearch.element),
  resultList,
  statusLine,
  hints);

  const windowEl = h('div', {
    role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': titleId,
    class: 'surface-3',
    style: {
      // Centred with a transform so the window can never hang off the bottom
      // at 150% or 200% UI scale, where its content is much taller. The first
      // drag replaces this with explicit coordinates.
      position: 'fixed',
      left: '50%',
      top: '50%',
      transform: 'translate(-50%, -50%)',
      width: 'min(760px, calc(100vw - 32px))',
      maxHeight: 'calc(100vh - 32px)',
      display: 'flex', flexDirection: 'column',
      borderRadius: 'var(--shape-xl)',
      border: '1px solid var(--outline-var)',
      overflow: 'hidden',
    },
  }, header, body);
  appearanceTarget(windowEl, 'filefind-window', 'Find window');

  // Dragging by the header, clamped so the window can never be lost off screen.
  titleEl.addEventListener('pointerdown', (e) => {
    const rect = windowEl.getBoundingClientRect();
    const dx = e.clientX - rect.left;
    const dy = e.clientY - rect.top;
    // Swap the centring transform for real coordinates on the first drag, or
    // the window would jump by half its size.
    windowEl.style.transform = 'none';
    windowEl.style.left = `${rect.left}px`;
    windowEl.style.top = `${rect.top}px`;
    const move = (ev) => {
      const left = Math.max(0, Math.min(window.innerWidth - 80, ev.clientX - dx));
      const top = Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - dy));
      windowEl.style.left = `${left}px`;
      windowEl.style.top = `${top}px`;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  function onKey(e) {
    if (e.key === 'Escape' && windowEl.contains(document.activeElement)) { e.stopPropagation(); close(); }
  }
  windowEl.addEventListener('keydown', onKey);

  function close() {
    if (state === 'finding' || state === 'aborting') stopSearch();
    searchGeneration += 1;
    state = 'aborted';
    detach();
    resultSearch.destroy();
    windowEl.remove();
    openWindow = null;
    restoreFocus();
  }

  layer('dialog').appendChild(windowEl);

  readHistory('remoteDirectory').then((list) => {
    rootHistory.replaceChildren(...list.map((value) => h('option', { value })));
  });
  readHistory('selectMask').then((list) => {
    maskHistory.replaceChildren(...list.map((value) => h('option', { value })));
  });

  updateControls();
  updateStatus();
  paintResults();
  setTimeout(() => rootInput.focus(), 0);

  openWindow = {
    element: windowEl,
    focus() { rootInput.focus(); },
    close,
    /** A second "Find files…" retargets the open window, as WinSCP's Init does. */
    reconfigure(next) {
      Object.assign(props, next || {});
      if (next && next.directory) rootInput.value = next.directory;
      updateControls();
    },
    get results() { return results.slice(); },
  };
  return openWindow;
}

/** The command the menus and the panel toolbar reach this by. */
registerCommand({
  id: 'files.find',
  labelKey: 'findFiles',
  icon: 'search',
  shortcut: 'Ctrl+Alt+F',
  run: (props) => openFileFind(props || {}),
});

/** Close the Find window if one is open (session teardown calls this). */
export function closeFileFind() { openWindow?.close(); }
