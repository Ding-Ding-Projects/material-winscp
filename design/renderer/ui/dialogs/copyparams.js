// ui/dialogs/copyparams.js — transfer settings.
//
// Four WinSCP surfaces, one set of options:
//
//   CopyParams.dfm        the transfer-settings frame (33 interactive controls)
//   CopyParamCustom.dfm   that frame in its own dialog, for one operation
//   CopyParamPreset.dfm   the frame plus a name and an autoselection rule
//   Copy.dfm              the copy dialog: target, settings, background
//
// The option descriptors live in prefpages.js so the Preferences page, the
// preset editor and the copy dialog cannot drift apart, and so the preferences
// search finds "Preserve timestamp" wherever the user happens to be.
//
// What these settings actually do lives in design/main/queue.js: transferMode
// and asciiFileMask pick text or binary, fileNameCase and
// replaceInvalidChars/invalidCharsReplacement rewrite the target name,
// resumeSupport/resumeThreshold/partialFileExt drive the .filepart dance, and
// cpsLimit throttles. A copy dialog therefore hands its resolved copyParam
// straight to queue:add — nothing here is decorative.

import { h, icon, clear, uid, appearanceTarget, announce, openModal } from '../../dom.js';
import { api, bus } from '../../state.js';
import { t, getLanguage } from '../../i18n.js';
import { registerDialog, registerCommand } from '../../app.js';
import { createSearchBar, noMatchMessage } from '../searchbar.js';
import { notify } from '../notifications.js';
import {
  PAGES, COPY_PARAM_SECTIONS, flattenControls, renderControl, localized,
  describeValue, matchPreferences, searchFieldsFor, getAt,
} from './prefpages.js';
import { ensurePreferenceStyles, readPref, writePref, maskField } from './preferences.js';

/** A bilingual literal for the strings this module owns; the dictionary has
 * no key for them, and bilingual mode must still show both languages. */
const tx = (en, yueText) => localized({ en, yue: yueText });

/* ================================================================== */
/* pure helpers                                                        */
/* ================================================================== */

/** Every `copyParam.*` descriptor in the schema, including the Endurance page. */
export function copyParamControls() {
  return flattenControls(PAGES)
    .map((e) => e.control)
    .filter((c) => typeof c.key === 'string' && c.key.startsWith('copyParam.'));
}

/** The defaults for a whole TCopyParamType, derived from those descriptors. */
export function copyParamDefaults() {
  const out = {};
  for (const c of copyParamControls()) out[c.key.slice('copyParam.'.length)] = c.def;
  return out;
}

/** Short field name from a dotted schema key. */
const fieldOf = (key) => key.slice(key.indexOf('.') + 1);

/**
 * WinSCP's file-mask matching, reduced to what an autoselection rule needs:
 * a `;`-separated list of masks, `*` and `?` wildcards, case-insensitive, and
 * an empty mask matching everything. Kept pure so it is testable — the same
 * rule decides which preset a session gets, and getting it wrong silently
 * applies the wrong transfer mode.
 */
export function maskMatch(mask, value) {
  const list = String(mask ?? '').split(';').map((m) => m.trim()).filter(Boolean);
  if (!list.length) return true;
  const subject = String(value ?? '');
  return list.some((m) => maskToRegExp(m).test(subject));
}

function maskToRegExp(mask) {
  let out = '';
  for (const ch of mask) {
    if (ch === '*') out += '.*';
    else if (ch === '?') out += '.';
    else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`, 'i');
}

/**
 * Whether a preset's autoselection rule matches a session. Every populated
 * field of the rule must match; an empty field is not a constraint. A preset
 * with no rule never selects itself.
 */
export function presetMatches(preset, context = {}) {
  const rule = preset && preset.rule;
  if (!rule) return false;
  const fields = ['hostName', 'userName', 'remoteDirectory', 'localDirectory'];
  const populated = fields.filter((f) => String(rule[f] || '').trim());
  if (!populated.length) return false;
  return populated.every((f) => maskMatch(rule[f], context[f]));
}

/** The first preset whose rule matches, in list order — WinSCP's behaviour. */
export function selectPreset(presets, context) {
  return (presets || []).find((p) => presetMatches(p, context)) || null;
}

/**
 * The one-line summary WinSCP puts on CopyParamLabel. It names only what
 * differs from the defaults, so "Binary, exclude *.tmp" is legible at a glance
 * and an unmodified preset says so rather than listing thirty defaults.
 */
export function summariseCopyParam(copyParam, language = getLanguage()) {
  const defs = copyParamDefaults();
  const cp = { ...defs, ...(copyParam || {}) };
  const parts = [];
  const yue = language === 'yue';

  const controls = new Map(copyParamControls().map((c) => [fieldOf(c.key), c]));
  const describe = (field) => {
    const control = controls.get(field);
    return control ? describeValue(control, cp[field], language) : String(cp[field]);
  };

  if (cp.transferMode !== defs.transferMode) parts.push(describe('transferMode'));
  if (cp.fileNameCase !== defs.fileNameCase) parts.push(describe('fileNameCase'));
  if (cp.preserveTime !== defs.preserveTime) parts.push(cp.preserveTime ? (tx('preserve timestamp', '保留時間')) : (tx('no timestamp', '唔保留時間')));
  if (cp.preserveRights) parts.push(`${tx('permissions', '權限')} ${cp.rights}`);
  if (cp.includeFileMask) parts.push(`${tx('mask', '遮罩')} ${cp.includeFileMask}`);
  if (cp.newerOnly) parts.push(tx('new and updated only', '淨係新檔案'));
  if (cp.excludeHiddenFiles) parts.push(tx('no hidden files', '唔理隱藏檔'));
  if (cp.excludeEmptyDirectories) parts.push(tx('no empty directories', '唔理空目錄'));
  if (cp.cpsLimit) parts.push(`${Math.round(cp.cpsLimit / 1024)} KB/s`);
  if (cp.resumeSupport !== defs.resumeSupport) parts.push(`${tx('resume', '續傳')} ${cp.resumeSupport}`);
  if (cp.onceDoneOperation !== defs.onceDoneOperation) parts.push(describe('onceDoneOperation'));

  if (!parts.length) return tx('Default transfer settings', '預設傳輸設定');
  return parts.join(language === 'yue' ? '、' : ', ');
}

/** A stable id for a new preset or rule. */
function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/* ================================================================== */
/* the transfer-settings frame (CopyParams.dfm)                        */
/* ================================================================== */

/**
 * createCopyParamsFrame({ value, read, onChange, showSearch })
 *
 *   value       a TCopyParamType-shaped object (partial is fine)
 *   read(key)   optional: read a dotted `copyParam.x` key from somewhere else
 *               (the Preferences page reads main's live configuration)
 *   onChange    (dottedKey, value) on every edit
 *   showSearch  add the frame's own search bar (default: only when standalone)
 *
 * Returns { element, value, set, destroy }.
 */
export function createCopyParamsFrame(opts = {}) {
  ensurePreferenceStyles();
  const external = typeof opts.read === 'function';
  let draft = { ...copyParamDefaults(), ...(opts.value || {}) };

  const read = (key) => (external ? opts.read(key) : getAt({ copyParam: draft }, key));
  const grid = h('div', { class: 'cp-frame-grid' });
  const summary = h('p', { class: 'cp-summary' });
  const root = h('div', { class: 'cp-frame' });
  appearanceTarget(root, 'transfer-settings-frame', 'Transfer settings');

  const entries = COPY_PARAM_SECTIONS.flatMap((section) =>
    section.controls.map((control) => ({
      pageId: 'transfer', pageTitle: { en: 'Transfer', yue: '傳輸' },
      sectionId: section.id, sectionTitle: section.title, control,
    })));

  let bar = null;
  if (opts.showSearch ?? !external) {
    bar = createSearchBar({
      id: opts.searchId || 'transfer-settings',
      labelKey: 'prefsSearchPh',
      placeholder: tx('Search transfer settings', '搵傳輸設定'),
      persist: false,
      sampleProvider: () => entries.flatMap((e) => searchFieldsFor(e, read(e.control.key))).join('\n'),
      onChange: () => paint(),
    });
    root.appendChild(h('div', { class: 'prefs-page-search' }, bar.element));
  }
  root.append(grid, summary);

  const ctx = {
    language: getLanguage(),
    read,
    write: (control, value) => {
      draft = { ...draft, [fieldOf(control.key)]: value };
      opts.onChange?.(control.key, value);
      paint();
    },
    custom: {
      mask: (control, input) => maskField(input),
    },
  };

  function paint() {
    clear(grid);
    const active = bar && bar.isActive;
    const matched = active
      ? new Set(matchPreferences(entries, bar.predicate, read).map((e) => e.control))
      : null;
    let shown = 0;

    for (const section of COPY_PARAM_SECTIONS) {
      const visible = matched ? section.controls.filter((c) => matched.has(c)) : section.controls;
      if (!visible.length) continue;
      const group = h('div', { class: 'cp-frame-group' },
        h('h5', { class: 'cp-frame-group-title' }, localized(section.title)));
      appearanceTarget(group, `transfer-settings-${section.id}`, `Transfer settings: ${section.title.en}`);
      for (const control of visible) {
        group.appendChild(renderControl(control, { ...ctx, language: getLanguage() }));
        shown += 1;
      }
      grid.appendChild(group);
    }
    if (matched && !shown) {
      grid.appendChild(h('p', { class: 'prefs-empty' },
        noMatchMessage(bar.predicate, tx('the transfer settings', '傳輸設定'))));
    }
    summary.textContent = summariseCopyParam(external ? readAll() : draft);
  }

  function readAll() {
    const out = {};
    for (const c of copyParamControls()) out[fieldOf(c.key)] = read(c.key);
    return out;
  }

  paint();

  return {
    element: root,
    get value() { return external ? readAll() : { ...draft }; },
    set(next) { draft = { ...copyParamDefaults(), ...(next || {}) }; paint(); },
    destroy() { bar?.destroy(); root.remove(); },
  };
}

/* ================================================================== */
/* transfer settings for one operation (CopyParamCustom.dfm)           */
/* ================================================================== */

/**
 * openTransferSettings({ value, title, presets, onApply })
 *
 * A modal because it gates an operation the user has already started: the
 * copy does not proceed until these are settled. Presets are offered so the
 * dialog is not the only way to reach a saved configuration.
 */
export function openTransferSettings({ value, title, presets, onApply } = {}) {
  ensurePreferenceStyles();
  const frame = createCopyParamsFrame({ value: value || readPref('copyParam') || {}, showSearch: true, searchId: 'transfer-settings-dialog' });
  const list = presets || readPref('copyParamList') || [];

  const presetRow = h('div', { class: 'pref-list-tools' });
  for (const preset of list) {
    presetRow.appendChild(h('button', {
      type: 'button', class: 'prefs-elsewhere-chip',
      title: summariseCopyParam({ ...copyParamDefaults(), ...(preset.copyParam || {}) }),
      onclick: () => {
        frame.set({ ...copyParamDefaults(), ...(preset.copyParam || {}) });
        announce(`${t('transferSettingsShort')}: ${preset.name}`);
      },
    }, icon('layers', 14), preset.name));
  }

  return openModal({
    title: title || t('transferSettingsShort'),
    content: h('div', { class: 'stack dlg-widest' },
      list.length ? h('div', {},
        h('p', { class: 'prefs-result-where' }, t('presetsHint')), presetRow) : null,
      frame.element),
    onClose: () => frame.destroy(),
    actions: [
      { label: t('cancel'), kind: 'text' },
      { label: t('ok'), kind: 'filled', autofocus: true, onSelect: () => onApply?.(frame.value) },
    ],
  });
}

/* ================================================================== */
/* the preset editor (CopyParamPreset.dfm)                             */
/* ================================================================== */

/**
 * openCopyParamPreset({ preset, onSave })
 *
 * Description, the full settings frame, and the autoselection rule: four
 * masks that decide when this preset is chosen on its own. "Current" fills the
 * rule from the session in front of the user, exactly as WinSCP's button does.
 */
export function openCopyParamPreset({ preset, current, onSave } = {}) {
  ensurePreferenceStyles();
  const draft = {
    id: preset?.id || newId('preset'),
    name: preset?.name || '',
    autoSelect: preset?.autoSelect || '',
    rule: { hostName: '', userName: '', remoteDirectory: '', localDirectory: '', ...(preset?.rule || {}) },
    copyParam: { ...(preset?.copyParam || {}) },
  };

  const nameInput = h('input', {
    type: 'text', class: 'field-input', autocomplete: 'off',
    onchange: () => { draft.name = nameInput.value; },
  });
  nameInput.value = draft.name;

  const frame = createCopyParamsFrame({
    value: { ...copyParamDefaults(), ...draft.copyParam },
    showSearch: true,
    searchId: 'transfer-preset',
  });

  const hasRule = h('input', { type: 'checkbox', class: 'pref-check-input', id: uid('rule') });
  hasRule.checked = ['hostName', 'userName', 'remoteDirectory', 'localDirectory']
    .some((f) => String(draft.rule[f] || '').trim());

  const ruleFields = {};
  const ruleBox = h('div', { class: 'stack' });
  const RULES = [
    ['hostName', { en: 'Host name mask', yue: '主機名遮罩' }],
    ['userName', { en: 'User name mask', yue: '使用者名遮罩' }],
    ['remoteDirectory', { en: 'Remote directory mask', yue: '遠端目錄遮罩' }],
    ['localDirectory', { en: 'Local directory mask', yue: '本機目錄遮罩' }],
  ];
  for (const [field, label] of RULES) {
    const input = h('input', {
      type: 'text', class: 'field-input', autocomplete: 'off', spellcheck: 'false',
      placeholder: '*',
      onchange: () => { draft.rule[field] = input.value; },
    });
    input.value = draft.rule[field] || '';
    ruleFields[field] = input;
    ruleBox.appendChild(h('label', { class: 'field' }, h('span', { class: 'field-label' }, localized(label)), input));
  }
  const currentBtn = h('button', {
    type: 'button', class: 'btn-text',
    onclick: () => {
      const ctx = current || {};
      for (const [field] of RULES) {
        ruleFields[field].value = ctx[field] || '';
        draft.rule[field] = ctx[field] || '';
      }
      announce(tx('Filled from the current session.', '填咗而家嘅工作階段資料。'));
    },
  }, tx('Use the current session', '用而家嘅工作階段'));
  if (!current) { currentBtn.disabled = true; currentBtn.title = t('notConnected'); }
  ruleBox.appendChild(currentBtn);

  const syncRule = () => {
    ruleBox.hidden = !hasRule.checked;
    if (!hasRule.checked) for (const [field] of RULES) draft.rule[field] = '';
  };
  hasRule.addEventListener('change', syncRule);
  syncRule();

  const error = h('p', { class: 'pref-hint is-danger', hidden: true });

  return openModal({
    title: preset ? `${t('edit')} — ${preset.name}` : `${t('add')} — ${t('transferSettingsShort')}`,
    content: h('div', { class: 'stack dlg-widest' },
      h('label', { class: 'field' },
        h('span', { class: 'field-label' }, tx('Preset description', '預設組合描述')),
        nameInput),
      frame.element,
      h('section', { class: 'prefs-section' },
        h('h4', { class: 'prefs-section-title' }, tx('Autoselection rule', '自動揀選規則')),
        h('label', { class: 'pref-check', for: hasRule.id },
          hasRule, h('span', { class: 'pref-check-box' }),
          h('span', { class: 'pref-check-label' },
            tx('Select this preset automatically when', '夾到以下條件就自動揀呢個預設組合'))),
        ruleBox,
        h('p', { class: 'pref-hint' },
          tx('Every populated mask must match. An empty mask is not a constraint. Use * and ? as wildcards and ";" to separate alternatives.', '每個填咗嘅遮罩都要夾中先算。留空嘅遮罩唔算條件。用 * 同 ? 做萬用字元，用「;」分開幾個遮罩。'))),
      error),
    onClose: () => frame.destroy(),
    actions: [
      { label: t('cancel'), kind: 'text' },
      {
        label: t('save'), kind: 'filled', autofocus: true,
        onSelect: () => {
          draft.name = nameInput.value.trim();
          if (!draft.name) {
            error.textContent = tx('A preset needs a description before it can be saved.', '要有個名先儲存得。');
            error.hidden = false;
            return true;
          }
          draft.copyParam = frame.value;
          draft.autoSelect = hasRule.checked
            ? RULES.map(([f]) => draft.rule[f]).filter(Boolean).join(' ')
            : '';
          onSave?.(draft);
          return false;
        },
      },
    ],
  });
}

/* ================================================================== */
/* the preset list (Preferences ▸ Transfer ▸ Presets)                  */
/* ================================================================== */

export function createPresetList({ value = [], current, onChange } = {}) {
  ensurePreferenceStyles();
  let rows = (value || []).map((p) => ({ ...p }));
  let selected = rows.length ? 0 : -1;

  const listEl = h('div', { class: 'pref-list-rows', role: 'listbox', 'aria-label': 'Transfer settings presets' });
  const tools = h('div', { class: 'pref-list-tools' });
  const bar = createSearchBar({
    id: 'transfer-presets', labelKey: 'prefsSearchPh',
    placeholder: tx('Search presets', '搵預設組合'),
    persist: false, compact: true,
    sampleProvider: () => rows.map((r) => `${r.name}\n${summariseCopyParam(r.copyParam)}`).join('\n'),
    onChange: () => paint(),
  });
  const root = h('div', { class: 'pref-list' },
    h('div', { class: 'prefs-page-search' }, bar.element), listEl, tools);

  const emit = () => onChange?.(rows.map((p) => ({ ...p })));

  function visibleRows() {
    if (!bar.isActive) return rows.map((r, i) => ({ r, i }));
    const pred = bar.predicate;
    return rows.map((r, i) => ({ r, i }))
      .filter(({ r }) => pred.ok && [r.name, summariseCopyParam(r.copyParam), r.autoSelect || ''].some((f) => pred.test(f)));
  }

  function paint() {
    clear(listEl);
    const shown = visibleRows();
    if (!shown.length) {
      listEl.appendChild(h('p', { class: 'pref-list-empty' },
        bar.isActive
          ? noMatchMessage(bar.predicate, tx('the presets', '預設組合'))
          : (tx('No presets yet.', '未有預設組合。'))));
    }
    for (const { r, i } of shown) {
      const btn = h('button', {
        type: 'button', role: 'option', 'aria-selected': String(i === selected),
        class: `pref-list-row${i === selected ? ' is-selected' : ''}`,
        onclick: () => { selected = i; paint(); },
        ondblclick: () => edit(i),
      },
      icon(r.rule && Object.values(r.rule).some(Boolean) ? 'filter' : 'layers', 15),
      h('span', { class: 'pref-list-main' }, r.name || '(unnamed)'),
      h('span', { class: 'pref-list-meta', title: summariseCopyParam(r.copyParam) }, summariseCopyParam(r.copyParam)));
      listEl.appendChild(btn);
    }
    clear(tools);
    tools.append(
      h('button', { type: 'button', class: 'btn-tonal', onclick: () => edit(-1) }, t('add')),
      h('button', { type: 'button', class: 'btn-text', disabled: selected < 0, onclick: () => edit(selected) }, t('edit')),
      h('button', { type: 'button', class: 'btn-text', disabled: selected < 0, onclick: () => duplicate() }, t('duplicate')),
      h('button', { type: 'button', class: 'btn-text', disabled: selected <= 0, onclick: () => move(-1) }, t('up')),
      h('button', { type: 'button', class: 'btn-text', disabled: selected < 0 || selected >= rows.length - 1, onclick: () => move(1) }, t('down')),
      h('button', { type: 'button', class: 'btn-text', disabled: selected < 0, onclick: () => remove() }, t('remove')),
    );
  }

  function edit(index) {
    openCopyParamPreset({
      preset: index >= 0 ? rows[index] : null,
      current,
      onSave: (saved) => {
        if (index >= 0) rows[index] = saved;
        else { rows.push(saved); selected = rows.length - 1; }
        paint(); emit();
      },
    });
  }

  function duplicate() {
    if (selected < 0) return;
    const copy = { ...rows[selected], id: newId('preset'), name: `${rows[selected].name} (copy)` };
    rows.splice(selected + 1, 0, copy);
    selected += 1;
    paint(); emit();
  }

  function move(delta) {
    const to = selected + delta;
    if (to < 0 || to >= rows.length) return;
    const [row] = rows.splice(selected, 1);
    rows.splice(to, 0, row);
    selected = to;
    paint(); emit();
  }

  function remove() {
    if (selected < 0) return;
    const gone = rows[selected];
    openModal({
      title: t('remove'),
      width: 460,
      content: h('p', { class: 'prose' },
        tx(`Delete the preset "${gone.name}"? The change is recorded in the version history and can be undone.`, `刪走預設組合「${gone.name}」？呢個改動會記入版本紀錄，可以還原。`)),
      actions: [
        { label: t('cancel'), kind: 'text' },
        {
          label: t('remove'), kind: 'danger', autofocus: true,
          onSelect: () => {
            rows.splice(selected, 1);
            selected = Math.min(selected, rows.length - 1);
            paint(); emit();
          },
        },
      ],
    });
  }

  paint();
  return { element: root, get value() { return rows.map((p) => ({ ...p })); }, destroy() { bar.destroy(); root.remove(); } };
}

/* ================================================================== */
/* the copy dialog (Copy.dfm)                                          */
/* ================================================================== */

/**
 * openCopyDialog({ direction, files, target, session, onConfirm })
 *
 *   direction  'upload' | 'download' | 'remote-copy'
 *   files      the file names being transferred (for the caption and the count)
 *   target     the initial target directory
 *   session    { id, hostName, userName, remoteDirectory, localDirectory } —
 *              used for preset autoselection and for the history key
 *   queue      TCopyParamType::Queue as the command preset it: true (asOn),
 *              false (asOff) or undefined (asAuto — the stored default)
 *   onConfirm  ({ target, copyParam, queue }) — the caller performs the copy
 *
 * The dialog itself never transfers anything: it resolves what to transfer and
 * hands it back, so the same dialog serves upload, download and remote copy.
 */
export function openCopyDialog(props = {}) {
  ensurePreferenceStyles();
  const direction = props.direction || 'upload';
  const files = props.files || [];
  const historyKey = direction === 'download' ? 'LocalTarget' : 'RemoteTarget';

  let copyParam = { ...copyParamDefaults(), ...(readPref('copyParam') || {}), ...(props.copyParam || {}) };

  // Autoselection: the first preset whose rule matches this session wins, and
  // the user is told when that happens if the notice is switched on.
  const presets = readPref('copyParamList') || [];
  const auto = selectPreset(presets, props.session || {});
  if (auto) {
    copyParam = { ...copyParam, ...(auto.copyParam || {}) };
    if (readPref('copyParamAutoSelectNotice') !== false) {
      notify.info(t('transferSettingsShort'),
        tx(`The preset "${auto.name}" was selected automatically for this session.`, `自動揀咗「${auto.name}」呢個預設組合。`));
    }
  }

  const listId = uid('copy-history');
  const historyList = h('datalist', { id: listId });
  for (const entry of (readPref(`history.${historyKey}`) || []).slice(0, 40)) {
    historyList.appendChild(h('option', { value: String(entry) }));
  }

  const targetInput = h('input', {
    type: 'text', class: 'field-input', autocomplete: 'off', spellcheck: 'false', list: listId,
  });
  targetInput.value = props.target || '';

  const browse = h('button', {
    type: 'button', class: 'btn-text',
    onclick: async () => {
      const res = await api.raw?.app?.pickPath?.({ title: t('targetPath'), properties: ['openDirectory'], defaultPath: targetInput.value || undefined });
      const value = res && res.ok ? res.value : res;
      const picked = Array.isArray(value) ? value[0] : (value && (value.path || value.filePath)) || value;
      if (picked) targetInput.value = picked;
    },
  }, t('browse'));
  if (direction !== 'download' || !api.raw?.app?.pickPath) browse.disabled = true;

  const summary = h('span', { class: 'cp-summary' }, summariseCopyParam(copyParam));
  const settingsBtn = h('button', {
    type: 'button', class: 'btn-tonal',
    onclick: () => openTransferSettings({
      value: copyParam,
      presets,
      onApply: (next) => { copyParam = next; summary.textContent = summariseCopyParam(copyParam); },
    }),
  }, t('transferSettingsShort'));

  const queueCheck = h('input', { type: 'checkbox', class: 'pref-check-input', id: uid('copy-bg') });
  // CopyParamDialog renders this box out of TCopyParamType::Queue, and
  // ExecuteCopyOperationCommand has already preset that from the action's
  // cocQueue / cocNonQueue flag — so a *NonQueueAction must open with it
  // unticked rather than at the stored default, or the command that exists to
  // avoid the queue silently opts back into it. `undefined` is asAuto: keep
  // whatever the configuration says.
  queueCheck.checked = props.queue === undefined
    ? readPref('queue.enabledByDefault') !== false
    : !!props.queue;

  const neverAgain = h('input', { type: 'checkbox', class: 'pref-check-input', id: uid('copy-never') });

  const caption = direction === 'download'
    ? (tx(`Copy ${files.length} ${files.length === 1 ? 'item' : 'items'} to the local directory`, `下載 ${files.length} 個項目去本機目錄`))
    : (tx(`Copy ${files.length} ${files.length === 1 ? 'item' : 'items'} to the remote directory`, `上載 ${files.length} 個項目去遠端目錄`));

  return openModal({
    title: direction === 'download' ? t('downloadTitle', files.length) : t('uploadTitle', files.length),
    width: 620,
    content: h('div', { class: 'stack dlg-wide' },
      h('p', { class: 'prose' }, caption),
      h('label', { class: 'field' },
        h('span', { class: 'field-label' }, t('targetPath')),
        h('span', { class: 'pref-inline' }, targetInput, browse, historyList)),
      h('section', { class: 'prefs-section' },
        h('h4', { class: 'prefs-section-title' }, t('transferSettingsShort')),
        h('div', { class: 'pref-inline' }, summary, settingsBtn)),
      h('label', { class: 'pref-check', for: queueCheck.id },
        queueCheck, h('span', { class: 'pref-check-box' }),
        h('span', { class: 'pref-check-label' }, t('transferInBackground'))),
      h('label', { class: 'pref-check', for: neverAgain.id },
        neverAgain, h('span', { class: 'pref-check-box' }),
        h('span', { class: 'pref-check-label' },
          tx('Do not show this dialog again (re-enable it in Preferences → Environment → Confirmations)', '下次唔好再問我（可以喺「偏好設定 → 環境 → 確認」開返）')))),
    actions: [
      { label: t('cancel'), kind: 'text' },
      {
        label: t('ok'), kind: 'filled', autofocus: true,
        onSelect: async () => {
          const target = targetInput.value.trim();
          if (target) { try { await api.raw?.config?.pushHistory?.(historyKey, target); } catch { /* history is a convenience */ } }
          if (neverAgain.checked) {
            await writePref('confirmTransferring', false, 'Turned off the transfer confirmation from the copy dialog');
          }
          if (copyParam.saveTransferOptions) {
            await writePref('copyParam', copyParam, 'Remembered the transfer options from the copy dialog');
          }
          props.onConfirm?.({ target, copyParam, queue: queueCheck.checked, direction, files });
        },
      },
    ],
  });
}

/* ================================================================== */
/* registration                                                        */
/* ================================================================== */

let installed = false;

export function installCopyParams() {
  if (installed) return;
  installed = true;

  registerDialog('transferSettings', ({ props, close }) => {
    const frame = createCopyParamsFrame({
      value: props.value || readPref('copyParam') || {},
      showSearch: true, searchId: 'transfer-settings-registered',
    });
    return {
      title: props.title || t('transferSettingsShort'),
      content: frame.element,
      onClose: () => frame.destroy(),
      actions: [
        { label: t('cancel'), kind: 'text' },
        { label: t('ok'), kind: 'filled', autofocus: true, onSelect: () => { props.onApply?.(frame.value); close(); } },
      ],
    };
  });

  // The preset editor owns its own modal (it has to stay open while the
  // settings frame inside it is edited), so it is reached through a command
  // rather than registerDialog, which would stack a second empty modal.
  registerCommand({
    id: 'transfer.settings', labelKey: 'transferSettingsShort', icon: 'tune',
    run: (props) => openTransferSettings(props || {}),
  });
  registerCommand({
    id: 'transfer.preset', labelKey: 'pPresets', icon: 'layers',
    run: (props) => openCopyParamPreset(props || {}),
  });
  registerCommand({
    id: 'transfer.copyDialog', labelKey: 'copyToTitle', icon: 'content_copy',
    run: (props) => openCopyDialog(props || {}),
  });

  bus.emit('copyparams:installed', {});
}

if (typeof document !== 'undefined') installCopyParams();
