// ui/dialogs/editorpreferences.js — the editor list and its entry editor.
//
// EditorPreferences.dfm, plus the list it belongs to on the Preferences ▸
// Editors page. WinSCP keeps an ORDERED list of editors, each with a file
// mask; the first entry whose mask matches the file is the one that opens it,
// which is why the list can be reordered and why the order is the whole point
// rather than a nicety.
//
// The list edited here is prefs.editor.list, and design/main/editors.js is what
// reads it: EditorManager.editorFor(name) walks the list in order and returns
// the first match, so adding "*.png → external, mspaint.exe" at the top of the
// list genuinely changes what happens when a .png is opened.
//
// An entry:
//   { mask, type: 'internal' | 'external' | 'open',
//     external, externalParams, sDIExternal }
//
//   internal  the built-in editor
//   external  a named program; `external` is its command line
//   open      whatever the operating system associates with the extension

import { h, icon, clear, uid, appearanceTarget, announce, openModal } from '../../dom.js';
import { api } from '../../state.js';
import { t, getLanguage } from '../../i18n.js';
import { registerCommand } from '../../app.js';
import { createSearchBar, noMatchMessage } from '../searchbar.js';
import { notify } from '../notifications.js';
import { ensurePreferenceStyles } from './preferences.js';

/* ================================================================== */
/* pure helpers                                                        */
/* ================================================================== */

/** The editor types, in the order EditorPreferences.dfm offers them. */
export const EDITOR_TYPES = [
  { value: 'internal', label: { en: 'Internal editor', yue: '內置編輯器' } },
  { value: 'external', label: { en: 'External editor', yue: '外部編輯器' } },
  { value: 'open', label: { en: 'The associated application', yue: '系統關聯嘅程式' } },
];

const localized = (pair) => {
  const lang = getLanguage();
  if (!pair) return '';
  if (lang === 'yue') return pair.yue || pair.en;
  if (lang === 'both' && pair.yue && pair.yue !== pair.en) return `${pair.en} · ${pair.yue}`;
  return pair.en;
};

/** A bilingual literal for the strings this module owns; the dictionary has
 * no key for them, and bilingual mode must still show both languages. */
const tx = (en, yueText) => localized({ en, yue: yueText });

/** A normalised entry — an unknown type falls back to the internal editor. */
export function normaliseEditor(entry) {
  const e = entry || {};
  const type = EDITOR_TYPES.some((x) => x.value === e.type) ? e.type : 'internal';
  return {
    mask: typeof e.mask === 'string' && e.mask ? e.mask : '*.*',
    type,
    external: typeof e.external === 'string' ? e.external : '',
    externalParams: e.externalParams !== false,
    sDIExternal: !!e.sDIExternal,
  };
}

/**
 * How an entry reads in the list. The mask is the identity of the row and the
 * program is what actually happens, so both are shown rather than a type name
 * on its own.
 */
export function describeEditor(entry) {
  const e = normaliseEditor(entry);
  const type = EDITOR_TYPES.find((x) => x.value === e.type);
  if (e.type === 'external') return e.external || localized({ en: '(no program set)', yue: '（未揀程式）' });
  return localized(type.label);
}

/**
 * Which entry opens a file, using WinSCP's rule: first match wins, and a list
 * with no match falls back to the internal editor. Pure, so the same function
 * powers the "which editor opens this?" preview in the dialog and can be tested.
 */
export function editorFor(name, list) {
  const entries = (list || []).map(normaliseEditor);
  for (const e of entries) {
    if (matchesMask(e.mask, name)) return e;
  }
  return normaliseEditor({ mask: '*.*', type: 'internal' });
}

/** `;`-separated masks with * and ? wildcards, case-insensitive. */
export function matchesMask(mask, name) {
  const list = String(mask ?? '').split(';').map((m) => m.trim()).filter(Boolean);
  if (!list.length) return true;
  const subject = String(name ?? '');
  return list.some((m) => {
    let out = '';
    for (const ch of m) {
      if (ch === '*') out += '.*';
      else if (ch === '?') out += '.';
      else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp(`^${out}$`, 'i').test(subject);
  });
}

/* ================================================================== */
/* the entry editor (EditorPreferences.dfm)                            */
/* ================================================================== */

/**
 * openEditorPreferences({ entry, onSave })
 *
 * A modal, because it gates the list edit the user started. Everything the
 * original dialog offers is here: the three editor kinds, the external
 * program with a Browse button, whether the external editor gets its own
 * process per file, the "force text transfer mode" flag, and the mask.
 */
export function openEditorPreferences({ entry, onSave, title } = {}) {
  ensurePreferenceStyles();
  const draft = normaliseEditor(entry);

  const radioName = uid('editor-type');
  const typeInputs = {};
  const typeBox = h('div', { class: 'pref-radios', role: 'radiogroup', 'aria-label': tx('Editor', '編輯器') });
  for (const type of EDITOR_TYPES) {
    const rid = uid('editor-opt');
    const input = h('input', {
      type: 'radio', name: radioName, id: rid, class: 'pref-radio-input',
      onchange: () => { if (input.checked) { draft.type = type.value; sync(); } },
    });
    input.checked = draft.type === type.value;
    typeInputs[type.value] = input;
    typeBox.appendChild(h('label', { class: 'pref-radio', for: rid },
      input, h('span', { class: 'pref-radio-dot' }),
      h('span', { class: 'pref-radio-label' }, localized(type.label))));
  }

  const programInput = h('input', {
    type: 'text', class: 'field-input pref-text', autocomplete: 'off', spellcheck: 'false',
    placeholder: 'notepad.exe "!.!"',
    onchange: () => { draft.external = programInput.value; },
  });
  programInput.value = draft.external;

  const browse = h('button', {
    type: 'button', class: 'btn-text',
    onclick: async () => {
      const res = await api.raw?.app?.pickPath?.({
        title: tx('Choose an external editor', '揀外部編輯器'),
        properties: ['openFile'],
        defaultPath: draft.external || undefined,
      });
      const value = res && res.ok ? res.value : res;
      const picked = Array.isArray(value) ? value[0] : (value && (value.path || value.filePath)) || value;
      if (picked) { programInput.value = picked; draft.external = picked; }
    },
  }, t('browse'));
  if (!api.raw?.app?.pickPath) { browse.disabled = true; browse.title = 'A file picker needs the application shell.'; }

  const defaultBtn = h('button', {
    type: 'button', class: 'btn-text',
    onclick: () => {
      draft.type = 'open';
      typeInputs.open.checked = true;
      sync();
      announce(tx('Set to the associated application.', '改咗做系統關聯嘅程式。'));
    },
  }, tx('Use the default system editor', '用系統預設編輯器'));

  const paramsCheck = mkCheck(
    { en: 'Pass the file name to the program', yue: '將檔名傳俾個程式' },
    draft.externalParams,
    (v) => { draft.externalParams = v; },
    { en: 'Off, the program is started with no arguments — for editors that pick the file up another way.', yue: '熄咗就唔傳任何參數，啱啲用第二種方法攞檔案嘅編輯器。' });

  const sdiCheck = mkCheck(
    { en: 'The external editor opens each file in its own process', yue: '外部編輯器每個檔案開一個獨立程序' },
    draft.sDIExternal,
    (v) => { draft.sDIExternal = v; },
    { en: 'On, the application waits for that process to exit before uploading the file.', yue: '開咗嘅話，程式會等嗰個程序結束先上載檔案。' });

  const maskInput = h('input', {
    type: 'text', class: 'field-input pref-text', autocomplete: 'off', spellcheck: 'false',
    placeholder: '*.txt; *.log',
    onchange: () => { draft.mask = maskInput.value; testMask(); },
  });
  maskInput.value = draft.mask;

  const testInput = h('input', {
    type: 'text', class: 'field-input pref-text', autocomplete: 'off', spellcheck: 'false',
    placeholder: 'readme.txt',
    oninput: () => testMask(),
  });
  const testResult = h('p', { class: 'pref-hint' });

  function testMask() {
    const name = testInput.value.trim();
    if (!name) { testResult.textContent = ''; return; }
    const hit = matchesMask(maskInput.value, name);
    testResult.textContent = hit
      ? (tx(`"${name}" matches this mask.`, `「${name}」夾中呢個遮罩。`))
      : (tx(`"${name}" does not match.`, `「${name}」夾唔中。`));
  }

  const error = h('p', { class: 'pref-hint is-danger', hidden: true });

  const programRow = h('div', { class: 'pref-row' },
    h('label', { class: 'pref-label' }, tx('Program', '程式')),
    h('span', { class: 'pref-inline' }, programInput, browse, defaultBtn),
    h('p', { class: 'pref-hint' },
      tx('Custom-command patterns are expanded: ! is the file and !\\ is its local directory.', '可以用自訂指令樣式：! 係檔案，!. 係本機路徑。')));

  function sync() {
    const external = draft.type === 'external';
    programRow.hidden = !external;
    paramsCheck.row.hidden = !external;
    sdiCheck.row.hidden = !external;
  }
  sync();

  return openModal({
    title: title || (entry ? `${t('edit')} — ${draft.mask}` : `${t('add')} — ${t('pEditor')}`),
    width: 620,
    content: h('div', { class: 'stack' },
      h('section', { class: 'prefs-section' },
        h('h4', { class: 'prefs-section-title' }, tx('Editor', '編輯器')),
        typeBox, programRow, paramsCheck.row, sdiCheck.row),
      h('section', { class: 'prefs-section' },
        h('h4', { class: 'prefs-section-title' }, tx('Editor autoselection', '編輯器自動揀選')),
        h('label', { class: 'field' },
          h('span', { class: 'field-label' }, tx('Use this editor for the following files', '呢個編輯器用嚟開以下檔案')),
          maskInput),
        h('p', { class: 'pref-hint' },
          tx('Use * and ? as wildcards and ";" to separate several masks.', '用 * 同 ? 做萬用字元，用「;」分開幾個遮罩。')),
        h('label', { class: 'field' },
          h('span', { class: 'field-label' }, tx('Try a file name', '試吓一個檔名')),
          testInput),
        testResult),
      error),
    actions: [
      { label: t('cancel'), kind: 'text' },
      {
        label: t('save'), kind: 'filled', autofocus: true,
        onSelect: () => {
          draft.mask = maskInput.value.trim() || '*.*';
          draft.external = programInput.value.trim();
          if (draft.type === 'external' && !draft.external) {
            error.textContent = tx('An external editor needs a program before it can be saved.', '外部編輯器要填程式路徑先儲存得。');
            error.hidden = false;
            return true;
          }
          onSave?.(normaliseEditor(draft));
          return false;
        },
      },
    ],
  });

  function mkCheck(label, initial, onToggle, hint) {
    const id = uid('editor-check');
    const input = h('input', { type: 'checkbox', class: 'pref-check-input', id, onchange: () => onToggle(input.checked) });
    input.checked = !!initial;
    const row = h('div', { class: 'pref-row' },
      h('label', { class: 'pref-check', for: id },
        input, h('span', { class: 'pref-check-box' }),
        h('span', { class: 'pref-check-label' }, localized(label))),
      hint ? h('p', { class: 'pref-hint' }, localized(hint)) : null);
    return { row, input };
  }
}

/* ================================================================== */
/* the editor list (Preferences ▸ Editors)                             */
/* ================================================================== */

/**
 * createEditorList({ value, onChange }) — the ordered list with add, edit,
 * remove and reorder, its own search bar (with the regex builder) and a live
 * "which editor opens this file?" probe that runs the real selection rule.
 */
export function createEditorList({ value = [], onChange } = {}) {
  ensurePreferenceStyles();
  let rows = (value || []).map(normaliseEditor);
  let selected = rows.length ? 0 : -1;

  const listEl = h('div', { class: 'pref-list-rows', role: 'listbox', 'aria-label': 'Editors' });
  const tools = h('div', { class: 'pref-list-tools' });

  const bar = createSearchBar({
    id: 'preferences-editors', labelKey: 'prefsSearchPh',
    placeholder: 'Search editors',
    persist: false, compact: true,
    sampleProvider: () => rows.map((r) => `${r.mask}\t${describeEditor(r)}`).join('\n'),
    onChange: () => paint(),
  });

  const probeInput = h('input', {
    type: 'text', class: 'field-input pref-text', placeholder: 'index.html',
    autocomplete: 'off', spellcheck: 'false', oninput: () => probe(),
  });
  const probeResult = h('p', { class: 'pref-hint' });

  const root = h('div', { class: 'pref-list' },
    h('div', { class: 'prefs-page-search' }, bar.element),
    listEl, tools,
    h('label', { class: 'field', style: { marginTop: '10px' } },
      h('span', { class: 'field-label' }, tx('Which editor opens this file?', '試吓邊個編輯器會開呢個檔案')),
      probeInput),
    probeResult);
  appearanceTarget(root, 'preferences-editor-list', 'Editor list');

  const emit = () => onChange?.(rows.map((r) => ({ ...r })));

  function probe() {
    const name = probeInput.value.trim();
    if (!name) { probeResult.textContent = ''; return; }
    const hit = editorFor(name, rows);
    const index = rows.findIndex((r) => r === hit);
    probeResult.textContent = index >= 0
      ? (tx(`Entry ${index + 1} (${hit.mask}) — ${describeEditor(hit)}`, `第 ${index + 1} 行（${hit.mask}）—— ${describeEditor(hit)}`))
      : (tx('No entry matches; the internal editor is used.', '冇規則夾中，會用內置編輯器。'));
  }

  function visible() {
    if (!bar.isActive) return rows.map((r, i) => ({ r, i }));
    const pred = bar.predicate;
    return rows.map((r, i) => ({ r, i }))
      .filter(({ r }) => pred.ok && [r.mask, describeEditor(r), r.external, r.type].some((f) => pred.test(f || '')));
  }

  function paint() {
    clear(listEl);
    const shown = visible();
    if (!shown.length) {
      listEl.appendChild(h('p', { class: 'pref-list-empty' },
        bar.isActive
          ? noMatchMessage(bar.predicate, tx('the editor list', '編輯器清單'))
          : (tx('No editors listed; every file opens in the internal editor.', '未有編輯器，會用內置編輯器開所有檔案。'))));
    }
    for (const { r, i } of shown) {
      const btn = h('button', {
        type: 'button', role: 'option', 'aria-selected': String(i === selected),
        class: `pref-list-row${i === selected ? ' is-selected' : ''}`,
        onclick: () => { selected = i; paint(); },
        ondblclick: () => edit(i),
      },
      icon(r.type === 'internal' ? 'description' : r.type === 'open' ? 'open_in_new' : 'terminal', 15),
      h('span', { class: 'pref-list-main mono' }, r.mask),
      h('span', { class: 'pref-list-meta', title: describeEditor(r) }, describeEditor(r)));
      listEl.appendChild(btn);
    }
    clear(tools);
    tools.append(
      h('button', { type: 'button', class: 'btn-tonal', onclick: () => edit(-1) }, t('add')),
      h('button', { type: 'button', class: 'btn-text', disabled: selected < 0, onclick: () => edit(selected) }, t('edit')),
      h('button', { type: 'button', class: 'btn-text', disabled: selected <= 0, onclick: () => move(-1) }, t('up')),
      h('button', { type: 'button', class: 'btn-text', disabled: selected < 0 || selected >= rows.length - 1, onclick: () => move(1) }, t('down')),
      h('button', { type: 'button', class: 'btn-text', disabled: selected < 0, onclick: () => remove() }, t('remove')),
    );
    probe();
  }

  function edit(index) {
    openEditorPreferences({
      entry: index >= 0 ? rows[index] : { mask: '*.txt', type: 'internal' },
      onSave: (saved) => {
        if (index >= 0) rows[index] = saved;
        else { rows.push(saved); selected = rows.length - 1; }
        paint(); emit();
      },
    });
  }

  function move(delta) {
    const to = selected + delta;
    if (to < 0 || to >= rows.length) return;
    const [row] = rows.splice(selected, 1);
    rows.splice(to, 0, row);
    selected = to;
    paint(); emit();
    announce(tx(`Moved to position ${to + 1}.`, `移咗去第 ${to + 1} 行。`));
  }

  function remove() {
    if (selected < 0) return;
    const gone = rows[selected];
    // Removing the last catch-all leaves files with no editor at all, which is
    // a decision rather than a slip — so it is confirmed, and said plainly.
    const isLastCatchAll = rows.filter((r) => r.mask === '*.*' || r.mask === '*').length === 1
      && (gone.mask === '*.*' || gone.mask === '*');
    openModal({
      title: t('remove'),
      width: 480,
      content: h('div', { class: 'stack' },
        h('p', { class: 'prose' },
          tx(`Remove "${gone.mask}" (${describeEditor(gone)})?`, `刪走「${gone.mask}」（${describeEditor(gone)}）？`)),
        isLastCatchAll ? h('p', { class: 'pref-hint is-danger' },
          tx('This is the last rule that matches every file. Without it, files that match nothing else open in the internal editor.', '呢個係最後一條夾中所有檔案嘅規則。刪咗之後，冇規則夾中嘅檔案會用內置編輯器。')) : null),
      actions: [
        { label: t('cancel'), kind: 'text' },
        {
          label: t('remove'), kind: 'danger', autofocus: true,
          onSelect: () => {
            rows.splice(selected, 1);
            selected = Math.min(selected, rows.length - 1);
            paint(); emit();
            notify.success(t('pEditor'), tx(`Removed "${gone.mask}".`, `刪走咗「${gone.mask}」。`));
          },
        },
      ],
    });
  }

  paint();
  return {
    element: root,
    get value() { return rows.map((r) => ({ ...r })); },
    destroy() { bar.destroy(); root.remove(); },
  };
}

/* ================================================================== */
/* registration                                                        */
/* ================================================================== */

let installed = false;

export function installEditorPreferences() {
  if (installed) return;
  installed = true;
  registerCommand({
    id: 'editors.editEntry', labelKey: 'pEditor', icon: 'edit',
    run: (props) => openEditorPreferences(props || {}),
  });
}

if (typeof document !== 'undefined') installEditorPreferences();
