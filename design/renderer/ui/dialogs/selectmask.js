// ui/dialogs/selectmask.js — forms/SelectMask.dfm (TSelectMaskDialog).
//
// One form, four jobs, exactly as the .dfm and TSelectMaskDialog::Init do:
//
//   select      "Select files…"     — mask + "apply to directories"
//   deselect    "Unselect files…"   — the same, inverted by the caller
//   filter      "Filter…"           — mask only, plus Clear
//   fileColor   "File colors…"      — mask + a colour, with the live preview
//                                     labels the original shows
//
// The mask field is validated as it is typed by the same grammar the engine
// uses (editmask.js), the "Edit…" button opens the full four-memo editor, and
// the preview lists exactly which of the panel's own names the mask picks up —
// so "why did that not get selected?" is answerable before pressing OK, not
// after.

import { h, uid, clear, appearanceTarget, debounce, announce } from '../../dom.js';
import { t, bindRender } from '../../i18n.js';
import { registerDialog, openDialog } from '../../app.js';
import { notify } from '../notifications.js';
import { createSearchBar, filterBy, noMatchMessage } from '../searchbar.js';
import { colorSwatchButton } from '../colorpicker.js';
import { makeTranslator, txLabel, ops, checkRow, readHistory, pushHistory, readPref, writePrefs, formatBytes } from './rights.js';
import { validateMask, maskHints, openEditMask } from './editmask.js';

const STRINGS = {
  smSelectCaption: ['Select', '揀'],
  smDeselectCaption: ['Deselect', '唔揀'],
  smFilterCaption: ['Filter', '篩選'],
  smColorCaption: ['File colour', '檔案顏色'],
  smMask: ['File mask', '檔案遮罩'],
  smApplyDirs: ['Apply to directories', '套用埋目錄'],
  smEdit: ['Edit…', '編輯…'],
  smClear: ['Clear', '清空'],
  smColor: ['Colour', '顏色'],
  smPreview: ['{0} of {1} name(s) match', '{1} 個名入面有 {0} 個符合'],
  smPreviewSearch: ['Search the preview', '搵預覽入面嘅嘢'],
  smPreviewEmpty: ['No panel names are available to preview.', '而家冇面板檔名可以預覽。'],
  smEmptyMask: ['An empty mask matches everything.', '空遮罩即係乜都符合。'],
  smMaskRequired: ['A colour rule needs a mask.', '顏色規則要有個遮罩先得。'],
  smInvalid: ['Problem at character {0}: {1}', '第 {0} 個字元有問題：{1}'],
  smSelected: ['{0} item(s) selected by "{1}".', '「{1}」揀咗 {0} 個項目。'],
  smUnselected: ['{0} item(s) unselected by "{1}".', '「{1}」唔揀咗 {0} 個項目。'],
  // Used when the preview did not cover the whole panel (it is capped) or the
  // mask engine could not answer for every name: a count would be a guess, and
  // a guessed number is worse than no number.
  smSelectedNoCount: ['Selection applied with "{0}".', '用「{0}」揀咗嘢。'],
  smUnselectedNoCount: ['Deselection applied with "{0}".', '用「{0}」唔揀咗嘢。'],
  smFiltered: ['Filter set to "{0}".', '篩選設做「{0}」。'],
  smFilterCleared: ['Filter cleared.', '篩選清咗。'],
  smColorSet: ['Files matching "{0}" are now coloured.', '符合「{0}」嘅檔案而家有色。'],
  smUnavailable: [
    'Matching is evaluated by the application’s mask engine, which this window cannot reach right now.',
    '配對係由程式嘅遮罩引擎計，而家呢個視窗接觸唔到佢。'],
};

const tx = makeTranslator(STRINGS);

const MODE_TITLE = {
  select: 'smSelectCaption',
  deselect: 'smDeselectCaption',
  filter: 'smFilterCaption',
  fileColor: 'smColorCaption',
};

const HISTORY_KEY = 'selectMask';

/**
 * props:
 *   mode          'select' | 'deselect' | 'filter' | 'fileColor'
 *   mask          initial mask
 *   directories   initial "apply to directories"
 *   color         initial colour (fileColor mode)
 *   names         [{ name, type, size }] from the panel, for the live preview
 *   onApply({ mask, directories, color })
 */
registerDialog('selectmask', ({ props, close }) => {
  const mode = MODE_TITLE[props.mode] ? props.mode : 'select';
  const showDirectories = mode === 'select' || mode === 'deselect';
  const showClear = mode === 'filter';
  const showColor = mode === 'fileColor';

  const maskId = uid('mask');
  const maskInput = h('input', {
    type: 'text', class: 'field-input mono', id: maskId, autocomplete: 'off', spellcheck: 'false',
    list: `${maskId}-history`,
    style: { flex: '1 1 auto', minWidth: 0 },
  });
  maskInput.value = props.mask || '';
  const historyList = h('datalist', { id: `${maskId}-history` });

  const maskLabel = h('label', { class: 'field-label', for: maskId, style: { width: 'calc(12ch * var(--uiscale))' } });
  bindRender(maskLabel, () => { maskLabel.textContent = tx('smMask'); });

  const editButton = h('button', {
    type: 'button', class: 'btn-text',
    onclick: () => openEditMask({
      mask: maskInput.value,
      sampleNames: (props.names || []).map((n) => (typeof n === 'string' ? n : n.name)),
      onApply: (mask) => { maskInput.value = mask; update(); },
    }),
  });
  bindRender(editButton, () => { editButton.textContent = tx('smEdit'); });

  const clearButton = h('button', {
    type: 'button', class: 'btn-text',
    onclick: () => { maskInput.value = ''; update(); maskInput.focus(); },
  });
  bindRender(clearButton, () => { clearButton.textContent = tx('smClear'); });
  clearButton.hidden = !showClear;

  const applyDirs = checkRow(txLabel(tx, 'smApplyDirs'), props.directories !== false, () => update());
  applyDirs.element.hidden = !showDirectories;

  let color = props.color || '#0B57D0';
  const colorButton = colorSwatchButton({
    value: color,
    label: tx('smColor'),
    alpha: false,
    onChange: (hex) => { color = hex; paintColorPreview(); },
  });
  const colorRow = h('div', { class: 'row' }, h('span', { class: 'field-label' }, tx('smColor')), colorButton.element);
  colorRow.hidden = !showColor;

  // The original previews the colour on real-looking rows: three names and
  // three sizes, in the chosen colour, so contrast is judged before saving.
  const colorPreview = h('div', {
    style: {
      display: 'grid', gridTemplateColumns: '1fr auto', gap: '2px calc(16px * var(--den))',
      padding: 'calc(8px * var(--den)) calc(10px * var(--den))',
      border: '1px solid var(--outline-var)', borderRadius: 'var(--shape-sm)',
      background: 'var(--c-lowest)', fontSize: 'var(--type-body-sm)',
    },
  });
  colorPreview.hidden = !showColor;

  function paintColorPreview() {
    clear(colorPreview);
    const rows = [['about.html', 10723], ['photo01.png', 25835], ['archive.zip', 276445]];
    for (const [name, size] of rows) {
      colorPreview.append(
        h('span', { class: 'ellipsis', style: { color } }, name),
        h('span', { class: 'mono', style: { color } }, formatBytes(size)),
      );
    }
  }
  paintColorPreview();

  const status = h('div', {
    role: 'status',
    style: { fontSize: 'var(--type-label-md)', lineHeight: '1.45', borderRadius: 'var(--shape-sm)', padding: '6px 8px' },
  });

  const hints = h('div', { class: 'muted', style: { fontSize: 'var(--type-label-sm)', lineHeight: '1.5' } });
  bindRender(hints, () => {
    clear(hints);
    for (const hint of maskHints()) hints.appendChild(h('div', {}, hint));
  });

  /* ---- live preview over the panel's own names ---- */

  const entries = (props.names || []).map((n) => (typeof n === 'string'
    ? { name: n, type: 'file', size: 0 }
    : { name: n.name, type: n.type || 'file', size: n.size || 0 }));

  const previewSearch = createSearchBar({
    id: 'selectmask-preview',
    persist: false,
    compact: true,
    labelKey: 'search',
    placeholder: tx('smPreviewSearch'),
    sampleProvider: () => entries.map((e) => e.name).join('\n'),
    onChange: () => paintPreview(),
  });

  const previewList = h('div', {
    style: {
      display: 'flex', flexWrap: 'wrap', gap: '4px',
      maxHeight: 'calc(150px * var(--uiscale))', overflow: 'auto',
      minHeight: 'calc(30px * var(--den))', padding: '2px',
    },
  });
  const previewCount = h('div', { class: 'muted', style: { fontSize: 'var(--type-label-sm)' } });
  let matched = new Map();

  function paintPreview() {
    clear(previewList);
    const visible = previewSearch.isActive
      ? filterBy(entries, previewSearch.predicate, (e) => e.name)
      : entries;
    if (selectMaskPreviewEmptyState(entries) === 'empty') {
      previewList.appendChild(h('span', { class: 'muted', role: 'status', style: { fontSize: 'var(--type-label-sm)' } },
        tx('smPreviewEmpty')));
    } else if (!visible.length) {
      previewList.appendChild(h('span', { class: 'muted', style: { fontSize: 'var(--type-label-sm)' } },
        previewSearch.isActive ? noMatchMessage(previewSearch.predicate, tx('smPreview', 0, entries.length)) : ''));
    } else {
      for (const entry of visible) {
        const state = matched.has(entry.name) ? matched.get(entry.name) : null;
        previewList.appendChild(h('span', {
          class: 'chip',
          title: state === null ? tx('smUnavailable') : entry.name,
          style: {
            background: state ? 'var(--secc)' : 'transparent',
            color: state ? 'var(--onsecc)' : 'var(--onsv)',
            border: state ? 'none' : '1px solid var(--outline-var)',
          },
        }, h('span', {}, entry.name)));
      }
    }
    // "0 of 8 match" would be a lie when the engine could not be asked at all.
    const answers = Array.from(matched.values());
    const known = answers.filter((v) => v !== null);
    if (!entries.length) previewCount.textContent = '';
    else if (!known.length && answers.length) previewCount.textContent = tx('smUnavailable');
    else previewCount.textContent = tx('smPreview', known.filter(Boolean).length, entries.length);
  }

  const evaluate = debounce(async () => {
    const mask = maskInput.value.trim();
    if (!validateMask(mask).ok) { matched = new Map(); paintPreview(); return; }
    const next = new Map();
    for (const entry of entries.slice(0, 200)) {
      if (entry.type === 'dir' && showDirectories && !applyDirs.input.checked) { next.set(entry.name, false); continue; }
      try {
        next.set(entry.name, !!await ops.app.maskMatches(mask, entry.name, {
          isDir: entry.type === 'dir', size: entry.size,
        }));
      } catch {
        next.set(entry.name, null);
      }
    }
    matched = next;
    paintPreview();
  }, 220);

  let okButton = null;

  function update() {
    const mask = maskInput.value.trim();
    const verdict = validateMask(mask);
    if (!mask) {
      status.textContent = showColor ? tx('smMaskRequired') : tx('smEmptyMask');
      status.style.background = showColor ? 'var(--terc)' : 'transparent';
      status.style.color = showColor ? 'var(--onterc)' : 'var(--onsv)';
    } else if (verdict.ok) {
      status.textContent = '';
      status.style.background = 'transparent';
    } else {
      status.textContent = tx('smInvalid', verdict.start + 1, verdict.error);
      status.style.background = 'var(--errc)';
      status.style.color = 'var(--onerrc)';
    }
    if (okButton) okButton.disabled = !verdict.ok || (showColor && !mask);
    evaluate();
  }

  maskInput.addEventListener('input', update);
  maskInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && okButton && !okButton.disabled) { e.preventDefault(); okButton.click(); }
  });

  const content = h('div', { class: 'stack' },
    h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, maskLabel, maskInput, editButton, clearButton),
    historyList,
    status,
    applyDirs.element,
    colorRow,
    colorPreview,
    entries.length ? h('div', { class: 'field' },
      h('div', { class: 'row' }, previewSearch.element, previewCount),
      previewList) : null,
    hints);
  appearanceTarget(content, 'selectmask-dialog', 'Select by mask dialog');

  // Restore what the user last used, exactly as WinConfiguration->SelectMask does.
  readHistory(HISTORY_KEY).then((list) => {
    historyList.replaceChildren(...list.map((value) => h('option', { value })));
  });
  if (!props.mask && (mode === 'select' || mode === 'deselect')) {
    readPref('selectMask', '').then((saved) => {
      if (saved && !maskInput.value) { maskInput.value = saved; update(); }
    });
    readPref('selectDirectories', true).then((saved) => { applyDirs.input.checked = saved !== false; });
  }
  update();

  async function apply() {
    const mask = maskInput.value.trim();
    const directories = applyDirs.input.checked;
    if (mask) await pushHistory(HISTORY_KEY, mask);
    if (mode === 'select' || mode === 'deselect') {
      await writePrefs({ selectMask: mask, selectDirectories: directories }, 'Remembered the selection mask');
    }
    const result = { mask, directories, color: showColor ? color : undefined };
    props.onApply?.(result);
    // The preview is capped at 200 names and can still be in flight, so its
    // tally is the real answer only when it covered every name and the engine
    // answered for all of them. Otherwise say what was applied, without a
    // number — a guessed count is worse than no count.
    const answers = Array.from(matched.values());
    const exact = entries.length > 0
      && matched.size === entries.length
      && answers.every((v) => typeof v === 'boolean');
    const count = answers.filter(Boolean).length;
    const shown = mask || '*';
    if (mode === 'select') {
      const msg = exact ? tx('smSelected', count, shown) : tx('smSelectedNoCount', shown);
      notify.success(msg); announce(msg);
    } else if (mode === 'deselect') {
      notify.success(exact ? tx('smUnselected', count, shown) : tx('smUnselectedNoCount', shown));
    }
    else if (mode === 'filter') notify.info(mask ? tx('smFiltered', mask) : tx('smFilterCleared'));
    else notify.success(tx('smColorSet', mask));
  }

  return {
    title: tx(MODE_TITLE[mode]),
    width: 620,
    content,
    actions: [
      { label: t('cancel'), kind: 'text' },
      {
        label: t('ok'), kind: 'filled', autofocus: true,
        ref: (btn) => { okButton = btn; update(); },
        onSelect: () => { apply(); close(); },
      },
    ],
  };
});

/** Open the select/deselect/filter/file-colour mask dialog. */
export function selectMaskPreviewEmptyState(names) {
  return Array.isArray(names) && names.length === 0 ? 'empty' : 'populated';
}

export function openSelectMask(props) { return openDialog('selectmask', props); }
