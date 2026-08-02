// ui/dialogs/customcommand.js — the custom command editor.
//
// CustomCommand.dfm, plus the ordered list it belongs to on the Preferences ▸
// Commands page. A custom command is a command line with WinSCP's `!` patterns
// in it, run either on this computer (local) or on the server through a shell
// session (remote).
//
// The expansion itself is NOT reimplemented here — design/main/customcmd.js is
// a faithful port of TCustomCommand / TFileCustomCommand / TLocalCustomCommand,
// and this dialog calls it through app:customCommandPreview so the preview a
// user sees is produced by the same code that will run the command. The
// pattern reference below is the documentation of that port, not a second
// implementation of it.
//
// One rule is load-bearing: a preview NEVER resolves !P. The main process
// blanks the password before expanding for a preview, and this dialog says so
// rather than quietly showing a different string from the one that will run.
//
// A command:
//   { id, name, command, shortcut,
//     params: { remote, applyToDirectories, recursive, showResults,
//               copyResults, useRemoteFiles } }

import { h, icon, clear, uid, appearanceTarget, announce, openModal, copyText } from '../../dom.js';
import { api } from '../../state.js';
import { t, getLanguage } from '../../i18n.js';
import { registerCommand } from '../../app.js';
import { createSearchBar, noMatchMessage } from '../searchbar.js';
import { notify } from '../notifications.js';
import { ensurePreferenceStyles } from './preferences.js';

/* ================================================================== */
/* the pattern reference                                               */
/* ================================================================== */
//
// Every pattern design/main/customcmd.js implements, with the behaviour that
// makes it different from naive substitution. Keeping this beside the editor
// is the difference between a command a user can write and one they copy from
// a forum and hope about.

export const COMMAND_PATTERNS = [
  { p: '!', scope: 'both', en: 'The selected file name, quoted for the shell it runs in.', yue: '揀咗嗰個檔案名，會照佢跑嘅 shell 加引號。' },
  { p: '!!', scope: 'both', en: 'A literal exclamation mark.', yue: '一個真正嘅感嘆號。' },
  { p: '!&', scope: 'both', en: 'Every selected file, already quoted — never quoted a second time. Cannot be combined with a bare "!".', yue: '全部揀咗嘅檔案，已經加咗引號，唔會再加多次。唔可以同單獨嘅「!」一齊用。' },
  { p: '!/', scope: 'both', en: 'The remote directory, always with a trailing slash.', yue: '遠端目錄，尾必定有一條斜線。' },
  { p: '!\\', scope: 'local', en: 'The local directory, WITHOUT its trailing separator.', yue: '本機目錄，尾冇分隔符。' },
  { p: '!^!', scope: 'local', en: 'The downloaded copy of the file on this computer.', yue: '檔案喺呢部電腦嘅下載複本。' },
  { p: '!@', scope: 'both', en: 'The host name of the session.', yue: '工作階段嘅主機名。' },
  { p: '!U', scope: 'both', en: 'The user name.', yue: '使用者名。' },
  { p: '!P', scope: 'both', en: 'The password. Never shown in a preview and redacted from the log.', yue: '密碼。預覽唔會顯示，記錄亦都會遮蓋。', secret: true },
  { p: '!#', scope: 'both', en: 'The port number.', yue: '埠號。' },
  { p: '!K', scope: 'both', en: 'The private key file.', yue: '私鑰檔案。' },
  { p: '!N', scope: 'both', en: 'The session (site) name.', yue: '工作階段（站點）名。' },
  { p: '!S', scope: 'both', en: 'The session URL, without the password.', yue: '工作階段 URL，唔包密碼。' },
  { p: '!E', scope: 'both', en: 'The session URL INCLUDING the password.', yue: '工作階段 URL，包埋密碼。', secret: true },
  { p: '!?prompt?default!', scope: 'both', en: 'Ask before running. The answer is escaped, so a "!" typed into the prompt stays a literal.', yue: '跑之前問一問你。答案會轉義，所以你打嘅「!」會保持係一個普通字元。' },
  { p: '!`command`', scope: 'both', en: 'Run this command first and substitute its output.', yue: '先跑呢個指令，再將佢嘅輸出代入。' },
];

const localized = (pair) => {
  const lang = getLanguage();
  if (lang === 'yue') return pair.yue || pair.en;
  if (lang === 'both' && pair.yue && pair.yue !== pair.en) return `${pair.en} · ${pair.yue}`;
  return pair.en;
};

/** A bilingual literal for the strings this module owns; the dictionary has
 * no key for them, and bilingual mode must still show both languages. */
const tx = (en, yueText) => localized({ en, yue: yueText });

/* ================================================================== */
/* pure helpers                                                        */
/* ================================================================== */

const DEFAULT_PARAMS = {
  remote: true,
  applyToDirectories: false,
  recursive: false,
  showResults: false,
  copyResults: false,
  useRemoteFiles: false,
};

export function normaliseCommand(entry) {
  const e = entry || {};
  return {
    id: e.id || `cc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name: typeof e.name === 'string' ? e.name : '',
    command: typeof e.command === 'string' ? e.command : '',
    shortcut: typeof e.shortcut === 'string' ? e.shortcut : '',
    params: { ...DEFAULT_PARAMS, ...(e.params || {}) },
  };
}

/** Letter patterns the file pass measures as two characters. */
const TWO_CHAR = new Set(['s', 'e', '@', 'u', 'p', 'k', '#', '/', '&', 'n']);

/** TFileCustomCommand::PatternLen — 1, 2 or 3, per the file (not token) rule. */
function filePatternLen(cmd, index, local) {
  const next = index + 1 < cmd.length ? cmd[index + 1] : '\0';
  if (local) {
    if (next === '\\') return 2;
    if (next === '^') return 3;              // `!^!`
  }
  return TWO_CHAR.has(next.toLowerCase()) ? 2 : 1;
}

/**
 * The same rule main enforces, reported early so the editor can refuse a
 * command before it is saved: TFileCustomCommand::ValidatePattern forbids
 * combining the file-list pattern `!&` with a single-file pattern.
 *
 * Two WinSCP behaviours are reproduced deliberately rather than "corrected":
 *
 *   * `!!` is measured with the FILE rule, so a literal exclamation mark also
 *     counts as a single-file pattern and does collide with `!&`;
 *   * the INTERACTIVE patterns are consumed first, exactly as WinSCP runs
 *     TInteractiveCustomCommand::Complete before validating the result.
 *     Measuring `!?prompt?!` with the file rule makes it look like a bare `!`,
 *     which then collides with `!&` and rejects perfectly good commands —
 *     including two of this application's own shipped defaults.
 *
 * The scan is a single pass over the raw string so every reported position is
 * a position in the command the user actually typed.
 */
export function validateCommand(command, options = {}) {
  const cmd = String(command || '');
  const local = !!options.local;
  let fileList = -1;
  let single = -1;
  let i = 0;

  while (i < cmd.length) {
    if (cmd[i] !== '!') {
      const next = cmd.indexOf('!', i);
      i = next < 0 ? cmd.length : next;
      continue;
    }
    const c = i + 1 < cmd.length ? cmd[i + 1] : '\0';

    if (c === '?') {                                  // !?prompt?default!
      const firstQ = cmd.indexOf('?', i + 2);
      const end = firstQ < 0 ? -1 : cmd.indexOf('!', firstQ + 1);
      if (end < 0) return { ok: false, error: `Unterminated prompt pattern at position ${i + 1} — "!?" needs a matching "?…!".` };
      i = end + 1;
      continue;
    }
    if (c === '`') {                                  // !`command`
      const end = cmd.indexOf('`', i + 2);
      if (end < 0) return { ok: false, error: `Unterminated command pattern at position ${i + 1} — "!\`" needs a matching backtick.` };
      i = end + 1;
      continue;
    }

    const patternLen = filePatternLen(cmd, i, local);
    const tokenLen = c === '\0' ? 1 : c === '!' ? 2 : patternLen;
    if (c === '&') fileList = i + 1;
    else if (patternLen === 1) single = i + 1;
    i += tokenLen;
  }

  if (fileList > 0 && single > 0) {
    return {
      ok: false,
      error: `The file pattern at position ${single} cannot be combined with the file-list pattern at position ${fileList}.`,
    };
  }
  return { ok: true, error: null };
}

/** Which patterns a command actually uses — drives the reference highlighting. */
export function patternsUsed(command, options = {}) {
  const cmd = String(command || '');
  const local = !!options.local;
  const used = new Set();
  for (const entry of COMMAND_PATTERNS) {
    if (entry.scope === 'local' && !local) continue;
    if (entry.p === '!?prompt?default!') { if (/!\?[^?]*\?[^!]*!/.test(cmd)) used.add(entry.p); continue; }
    if (entry.p === '!`command`') { if (/!`[^`]*`/.test(cmd)) used.add(entry.p); continue; }
    if (entry.p === '!!') { if (cmd.includes('!!')) used.add(entry.p); continue; }
    if (entry.p === '!') continue;                   // decided below
    const re = new RegExp(`!${entry.p.slice(1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
    if (re.test(cmd)) used.add(entry.p);
  }
  // A bare "!" is anything that is not one of the longer forms.
  const stripped = cmd.replace(/!!/g, '').replace(/!\?[^?]*\?[^!]*!/g, '').replace(/!`[^`]*`/g, '')
    .replace(/![se@upkn#/&]/gi, '').replace(/!\^!/g, '').replace(/!\\/g, '');
  if (stripped.includes('!')) used.add('!');
  return used;
}

/** A short, factual description of what a saved command will do. */
export function describeCommand(entry) {
  const c = normaliseCommand(entry);
  const bits = [c.params.remote ? (tx('remote', '遠端')) : (tx('local', '本機'))];
  if (c.params.applyToDirectories) bits.push(tx('directories too', '包目錄'));
  if (c.params.recursive) bits.push(tx('recursive', '遞迴'));
  if (c.params.showResults) bits.push(tx('show output', '顯示輸出'));
  if (c.params.copyResults) bits.push(tx('copy output', '複製輸出'));
  if (!c.params.remote && c.params.useRemoteFiles) bits.push(tx('downloads the remote files', '先下載遠端檔案'));
  return `${c.command} — ${bits.join(', ')}`;
}

/* ================================================================== */
/* the pattern reference block                                         */
/* ================================================================== */

function patternReference({ local, command, onInsert }) {
  const grid = h('div', { class: 'cc-patterns', role: 'list' });
  const paint = () => {
    clear(grid);
    const used = patternsUsed(command(), { local: local() });
    for (const entry of COMMAND_PATTERNS) {
      if (entry.scope === 'local' && !local()) continue;
      const key = h('button', {
        type: 'button', class: 'cc-pattern-key', role: 'listitem',
        style: { border: 'none', background: 'none', cursor: 'pointer', textAlign: 'start', padding: 0 },
        title: tx('Insert into the command', '撳一下就插入去指令度'),
        onclick: () => onInsert(entry.p === '!?prompt?default!' ? '!?Value:?default!' : entry.p === '!`command`' ? '!`date`' : entry.p),
      }, entry.p);
      if (used.has(entry.p)) key.style.textDecoration = 'underline';
      grid.append(key, h('span', { class: 'cc-pattern-desc' },
        localized(entry),
        entry.secret ? ` ${tx('(secret)', '（機密）')}` : ''));
    }
  };
  paint();
  return { element: grid, refresh: paint };
}

/* ================================================================== */
/* the editor (CustomCommand.dfm)                                      */
/* ================================================================== */

/**
 * openCustomCommand({ entry, sessionId, onSave })
 *
 * The full dialog: description, command line, keyboard shortcut, local vs
 * remote, and the four behaviour flags — with a live preview produced by the
 * real expansion in main and a validation message that is the real rule.
 */
export function openCustomCommand({ entry, sessionId, onSave, title } = {}) {
  ensurePreferenceStyles();
  const draft = normaliseCommand(entry);

  const nameInput = h('input', {
    type: 'text', class: 'field-input', autocomplete: 'off',
    onchange: () => { draft.name = nameInput.value; },
  });
  nameInput.value = draft.name;

  const cmdInput = h('input', {
    type: 'text', class: 'field-input pref-text mono', autocomplete: 'off', spellcheck: 'false',
    placeholder: 'grep "!?&Text to find:?!" !&',
    oninput: () => { draft.command = cmdInput.value; refresh(); },
  });
  cmdInput.value = draft.command;

  const shortcutSelect = h('select', {
    class: 'field-input pref-select',
    onchange: () => { draft.shortcut = shortcutSelect.value; },
  });
  shortcutSelect.appendChild(h('option', { value: '' }, tx('(none)', '（冇）')));
  for (const key of ['F2', 'F3', 'F4', 'F7', 'F8', 'F9', 'F11', 'F12']) {
    for (const mod of ['Ctrl+', 'Ctrl+Shift+', 'Shift+']) {
      shortcutSelect.appendChild(h('option', { value: mod + key }, mod + key));
    }
  }
  shortcutSelect.value = draft.shortcut || '';

  const radioName = uid('cc-side');
  const remoteRadio = mkRadio(radioName, { en: 'Remote command', yue: '遠端指令' }, draft.params.remote,
    () => { draft.params.remote = true; refresh(); });
  const localRadio = mkRadio(radioName, { en: 'Local command', yue: '本機指令' }, !draft.params.remote,
    () => { draft.params.remote = false; refresh(); });

  const dirsCheck = mkCheck({ en: 'Apply to directories', yue: '對目錄都做' }, draft.params.applyToDirectories,
    (v) => { draft.params.applyToDirectories = v; });
  const recursiveCheck = mkCheck({ en: 'Execute recursively', yue: '遞迴執行' }, draft.params.recursive,
    (v) => { draft.params.recursive = v; },
    { en: 'The command runs once for every file below a selected directory rather than once for the directory.', yue: '揀咗目錄嘅話，會對入面每個檔案各跑一次，唔係對住個目錄跑一次。' });
  const showCheck = mkCheck({ en: 'Show the output in the console', yue: '喺主控台顯示輸出' }, draft.params.showResults,
    (v) => { draft.params.showResults = v; });
  const copyCheck = mkCheck({ en: 'Copy the output to the clipboard', yue: '將輸出複製去剪貼簿' }, draft.params.copyResults,
    (v) => { draft.params.copyResults = v; });
  const remoteFilesCheck = mkCheck({ en: 'Use the remote files (download them first)', yue: '用遠端檔案（先下載落嚟）' },
    draft.params.useRemoteFiles, (v) => { draft.params.useRemoteFiles = v; },
    { en: 'A local command works on this computer, so the selected remote files are downloaded to the temporary directory first and !^! is their local path.', yue: '本機指令喺呢部電腦跑，所以會先將揀咗嘅遠端檔案下載去臨時目錄，!^! 就係佢哋嘅本機路徑。' });

  const preview = h('div', { class: 'cc-preview' });
  const validation = h('p', { class: 'pref-hint' });
  const secretNote = h('p', { class: 'pref-hint', hidden: true });

  const reference = patternReference({
    local: () => !draft.params.remote,
    command: () => draft.command,
    onInsert: (pattern) => {
      const start = cmdInput.selectionStart ?? cmdInput.value.length;
      const end = cmdInput.selectionEnd ?? start;
      cmdInput.value = cmdInput.value.slice(0, start) + pattern + cmdInput.value.slice(end);
      draft.command = cmdInput.value;
      cmdInput.focus();
      cmdInput.setSelectionRange(start + pattern.length, start + pattern.length);
      refresh();
    },
  });

  let previewSeq = 0;
  async function refresh() {
    remoteFilesCheck.row.hidden = draft.params.remote;
    reference.refresh();

    const local = !draft.params.remote;
    const result = validateCommand(draft.command, { local });
    validation.textContent = result.ok
      ? (tx('The command patterns are valid.', '指令樣式冇問題。'))
      : result.error;
    validation.className = result.ok ? 'pref-hint' : 'pref-hint is-danger';

    const used = patternsUsed(draft.command, { local });
    const hasSecret = used.has('!P') || used.has('!E');
    secretNote.hidden = !hasSecret;
    secretNote.className = 'pref-hint is-danger';
    secretNote.textContent = tx('This command carries the password. The preview never expands !P or !E and the log redacts them, but the password does appear on the command line when it runs.', '呢個指令會帶密碼落去。預覽唔會展開 !P／!E，記錄亦都會遮蓋，但係跑嘅時候密碼真係會出現喺命令列度。');

    if (!result.ok || !draft.command.trim()) { preview.textContent = ''; preview.className = 'cc-preview'; return; }
    const seq = ++previewSeq;
    try {
      const res = await api.raw?.app?.customCommandPreview?.(draft.command, {
        sessionId,
        local,
        fileName: 'report.txt',
        files: ['report.txt', 'notes.md'],
        remotePath: '/var/www',
        localPath: 'C:\\Users\\you\\Downloads',
        localFileName: 'C:\\Temp\\report.txt',
      });
      if (seq !== previewSeq) return;
      if (!res) { preview.textContent = tx('(a preview needs the application shell)', '（要有應用程式外殼先預覽到）'); return; }
      if (res.ok === false) {
        preview.className = 'cc-preview is-error';
        preview.textContent = res.error?.message || 'The command could not be expanded.';
        return;
      }
      preview.className = 'cc-preview';
      preview.textContent = res.ok ? res.value : String(res);
    } catch (err) {
      if (seq !== previewSeq) return;
      preview.className = 'cc-preview is-error';
      preview.textContent = err.message || String(err);
    }
  }

  const error = h('p', { class: 'pref-hint is-danger', hidden: true });
  refresh();

  return openModal({
    title: title || (entry ? `${t('edit')} — ${draft.name || draft.command}` : `${t('add')} — ${t('customCmdTitle')}`),
    width: 720,
    content: h('div', { class: 'stack' },
      h('label', { class: 'field' },
        h('span', { class: 'field-label' }, tx('Description', '描述')), nameInput),
      h('label', { class: 'field' },
        h('span', { class: 'field-label' }, tx('Custom command', '自訂指令')), cmdInput),
      h('label', { class: 'field' },
        h('span', { class: 'field-label' }, tx('Keyboard shortcut', '鍵盤捷徑')), shortcutSelect),
      h('section', { class: 'prefs-section' },
        h('h4', { class: 'prefs-section-title' }, tx('Where it runs', '喺邊度跑')),
        h('div', { class: 'pref-radios' }, remoteRadio.row, localRadio.row),
        remoteFilesCheck.row),
      h('section', { class: 'prefs-section' },
        h('h4', { class: 'prefs-section-title' }, tx('Behaviour', '行為')),
        dirsCheck.row, recursiveCheck.row, showCheck.row, copyCheck.row),
      h('section', { class: 'prefs-section' },
        h('h4', { class: 'prefs-section-title' }, tx('Preview', '預覽')),
        preview, validation, secretNote,
        h('p', { class: 'pref-hint' },
          tx('The preview uses a sample file (report.txt) and sample directories. It is expanded by the main process — the same code that runs the command.', '預覽用一個示範檔案（report.txt）同示範目錄，展開由主程序做，同真正跑嗰陣係同一段程式碼。'))),
      h('section', { class: 'prefs-section' },
        h('h4', { class: 'prefs-section-title' }, tx('Pattern reference', '樣式參考')),
        h('p', { class: 'pref-hint' },
          tx('Select a pattern to insert it. Patterns the command already uses are underlined.', '撳任何一個樣式就會插入去指令度。指令用緊嘅樣式會加底線。')),
        reference.element),
      error),
    actions: [
      {
        label: tx('Copy the command', '複製指令'), kind: 'text',
        onSelect: async () => {
          const ok = await copyText(draft.command);
          if (ok) notify.success(t('copiedClip'), draft.command);
          return true;
        },
      },
      { label: t('cancel'), kind: 'text' },
      {
        label: t('save'), kind: 'filled', autofocus: true,
        onSelect: () => {
          draft.name = nameInput.value.trim();
          draft.command = cmdInput.value.trim();
          draft.shortcut = shortcutSelect.value;
          if (!draft.name) {
            error.textContent = tx('A custom command needs a description before it can be saved.', '要有個描述先儲存得。');
            error.hidden = false;
            return true;
          }
          if (!draft.command) {
            error.textContent = tx('A custom command needs a command line before it can be saved.', '要有指令內容先儲存得。');
            error.hidden = false;
            return true;
          }
          const result = validateCommand(draft.command, { local: !draft.params.remote });
          if (!result.ok) { error.textContent = result.error; error.hidden = false; return true; }
          onSave?.(normaliseCommand(draft));
          return false;
        },
      },
    ],
  });

  function mkCheck(label, initial, onToggle, hint) {
    const id = uid('cc-check');
    const input = h('input', { type: 'checkbox', class: 'pref-check-input', id, onchange: () => onToggle(input.checked) });
    input.checked = !!initial;
    const row = h('div', { class: 'pref-row' },
      h('label', { class: 'pref-check', for: id },
        input, h('span', { class: 'pref-check-box' }),
        h('span', { class: 'pref-check-label' }, localized(label))),
      hint ? h('p', { class: 'pref-hint' }, localized(hint)) : null);
    return { row, input };
  }

  function mkRadio(name, label, initial, onPick) {
    const id = uid('cc-radio');
    const input = h('input', {
      type: 'radio', name, id, class: 'pref-radio-input',
      onchange: () => { if (input.checked) onPick(); },
    });
    input.checked = !!initial;
    const row = h('label', { class: 'pref-radio', for: id },
      input, h('span', { class: 'pref-radio-dot' }),
      h('span', { class: 'pref-radio-label' }, localized(label)));
    return { row, input };
  }
}

/* ================================================================== */
/* the command list (Preferences ▸ Commands)                           */
/* ================================================================== */

export function createCommandList({ value = [], sessionId, onChange } = {}) {
  ensurePreferenceStyles();
  let rows = (value || []).map(normaliseCommand);
  let selected = rows.length ? 0 : -1;

  const listEl = h('div', { class: 'pref-list-rows', role: 'listbox', 'aria-label': 'Custom commands' });
  const tools = h('div', { class: 'pref-list-tools' });

  const bar = createSearchBar({
    id: 'preferences-commands', labelKey: 'prefsSearchPh',
    placeholder: 'Search custom commands',
    persist: false, compact: true,
    sampleProvider: () => rows.map((r) => `${r.name}\t${r.command}`).join('\n'),
    onChange: () => paint(),
  });

  const root = h('div', { class: 'pref-list' },
    h('div', { class: 'prefs-page-search' }, bar.element), listEl, tools);
  appearanceTarget(root, 'preferences-command-list', 'Custom command list');

  const emit = () => onChange?.(rows.map((r) => ({ ...r, params: { ...r.params } })));

  function visible() {
    if (!bar.isActive) return rows.map((r, i) => ({ r, i }));
    const pred = bar.predicate;
    return rows.map((r, i) => ({ r, i }))
      .filter(({ r }) => pred.ok && [r.name, r.command, r.shortcut, describeCommand(r)].some((f) => pred.test(f || '')));
  }

  function paint() {
    clear(listEl);
    const shown = visible();
    if (!shown.length) {
      listEl.appendChild(h('p', { class: 'pref-list-empty' },
        bar.isActive
          ? noMatchMessage(bar.predicate, tx('the custom commands', '自訂指令'))
          : (tx('No custom commands yet.', '未有自訂指令。'))));
    }
    for (const { r, i } of shown) {
      const invalid = !validateCommand(r.command, { local: !r.params.remote }).ok;
      const btn = h('button', {
        type: 'button', role: 'option', 'aria-selected': String(i === selected),
        class: `pref-list-row${i === selected ? ' is-selected' : ''}`,
        onclick: () => { selected = i; paint(); },
        ondblclick: () => edit(i),
      },
      icon(invalid ? 'warning' : r.params.remote ? 'dns' : 'computer', 15),
      h('span', { class: 'pref-list-main' }, r.name || '(unnamed)'),
      r.shortcut ? h('span', { class: 'pref-list-meta' }, r.shortcut) : null,
      h('span', { class: 'pref-list-meta mono', title: r.command }, r.command));
      if (invalid) btn.title = validateCommand(r.command, { local: !r.params.remote }).error;
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
    openCustomCommand({
      entry: index >= 0 ? rows[index] : null,
      sessionId,
      onSave: (saved) => {
        if (index >= 0) rows[index] = saved;
        else { rows.push(saved); selected = rows.length - 1; }
        paint(); emit();
      },
    });
  }

  function duplicate() {
    if (selected < 0) return;
    const copy = normaliseCommand({ ...rows[selected], id: undefined, name: `${rows[selected].name} (copy)` });
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
    announce(tx(`Moved to position ${to + 1}.`, `移咗去第 ${to + 1} 行。`));
  }

  function remove() {
    if (selected < 0) return;
    const gone = rows[selected];
    openModal({
      title: t('remove'),
      width: 480,
      content: h('p', { class: 'prose' },
        tx(`Delete the custom command "${gone.name}"? The change is recorded in the version history and can be undone.`, `刪走自訂指令「${gone.name}」？呢個改動會記入版本紀錄，可以還原。`)),
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
  return {
    element: root,
    get value() { return rows.map((r) => ({ ...r, params: { ...r.params } })); },
    destroy() { bar.destroy(); root.remove(); },
  };
}

/* ================================================================== */
/* registration                                                        */
/* ================================================================== */

let installed = false;

export function installCustomCommand() {
  if (installed) return;
  installed = true;
  registerCommand({
    id: 'commands.edit', labelKey: 'customCmdTitle', icon: 'code',
    run: (props) => openCustomCommand(props || {}),
  });
}

if (typeof document !== 'undefined') installCustomCommand();
