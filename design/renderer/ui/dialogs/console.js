// ui/dialogs/console.js — the remote command console (Console.dfm).
//
// It runs commands on the session that is already connected: no second login,
// no second password. It is a modeless window (the frame comes from
// ui/dialogs/editor.js, so a console and an editor drag, resize, focus and
// close identically) because a console you cannot leave open beside your files
// is not a console.
//
// CAPABILITY GATING IS THE POINT, NOT A DETAIL. Only a protocol whose adapter
// reports `caps.exec` can run a command — SCP and SFTP over an SSH transport
// do; FTP, WebDAV and S3 do not, and never will. So `canOpenConsole()` is
// exported for menus to grey the command out, `openConsole()` refuses with the
// protocol named rather than opening a console that cannot execute anything,
// and if a reconnect lands on a protocol without the capability an open window
// disables its field and says why. An empty console that swallows commands is
// worse than an absent one.
//
// Output streams while a command runs: `session:exec` is a request/response
// channel, but the session log emits every line as it happens, so the window
// subscribes to `event:log` for this session and shows the traffic live.
// `event:console` carries custom-command output through the same view.
//
// Command history is per session and deliberately NOT persisted — people type
// passwords into terminals, and a history file is exactly where that would end
// up.

import {
  h, icon, clear, uid, appearanceTarget, announce, clamp, debounce, copyText, downloadText,
} from '../../dom.js';
import { t, bindRender, getLanguage, getFunnyLevel } from '../../i18n.js';
import { resolveI18n } from '../../../winscp-i18n.js';
import { api } from '../../state.js';
import { styleSheet } from '../../theme.js';
import { createSearchBar } from '../searchbar.js';
import { notify } from '../notifications.js';
import { registerContextMenu, SEPARATOR } from '../contextmenu.js';
import { openModelessWindow } from './editor.js';
import { registerCommand } from '../../app.js';

/* ------------------------------------------------------------------ */
/* module-local strings                                                */
/* ------------------------------------------------------------------ */

const STR = {
  csCommand: ['Enter command', '入指令'],
  csCurrentDir: ['Current directory', '而家嘅目錄'],
  csExecute: ['Execute', '執行'],
  csWarn: [
    'Do not execute commands that require user input or transfer data — this window is line-oriented and cannot answer a prompt or carry a file.',
    '唔好執行要你答嘢或者要傳檔案嘅指令——呢個視窗係逐行嘅，答唔到提示，亦都運唔到檔案。'],
  csNoExec: [
    '{0} cannot execute remote commands, so the console is not available on this session. Only a session over SSH (SFTP or SCP) can run one.',
    '{0} 執行唔到遠端指令，所以呢個工作階段冇終端機用。淨係行 SSH 嘅工作階段（SFTP 或者 SCP）先開到。'],
  csNoExecShort: ['Not available on {0}', '{0} 用唔到'],
  csNotConnected: [
    'The session is not connected, so nothing can be run. Reconnect and the console picks up where it left off — the scrollback is kept.',
    '工作階段未連線，行唔到嘢。駁返線之後終端機會接返落去——之前嘅輸出會留低。'],
  csRunning: ['Running…', '執行緊…'],
  csStopWaiting: ['Stop waiting', '唔等啦'],
  csStopHint: [
    'This releases the window so you can type again. The command itself keeps running on the server: the protocol’s exec channel offers no way to cancel it, and pretending otherwise would be a lie.',
    '呢個只係放返個視窗畀你再打字。個指令喺伺服器上面會繼續行落去：協定嘅 exec 通道根本冇得取消，扮到可以取消就係呃你。'],
  csStopped: [
    'Stopped waiting for “{0}”. It is still running on the server; its output will still appear here.',
    '唔等「{0}」喇。佢喺伺服器上面仲行緊，佢嘅輸出照樣會喺呢度出現。'],
  csExit: ['Exit code {0}', '結束代碼 {0}'],
  csExitOk: ['Finished', '做完'],
  csFailed: ['{0} failed: {1}', '{0} 失敗：{1}'],
  csSearchPh: ['Search the output', '搜尋輸出'],
  csShowing: ['{0} of {1} lines', '{1} 行入面顯示緊 {0} 行'],
  csNoMatch: ['No line of output matches {0}.', '冇一行輸出符合{0}。'],
  csEmpty: [
    'Nothing has been run yet. Type a command below and press Enter.',
    '仲未行過嘢。喺下面打個指令，撳 Enter。'],
  csClear: ['Clear the output', '清走輸出'],
  csCleared: ['The output was cleared.', '輸出清咗。'],
  csCopy: ['Copy what is shown', '複製顯示緊嘅內容'],
  csExport: ['Export what is shown', '匯出顯示緊嘅內容'],
  csCopied: ['{0} line(s) copied.', '複製咗 {0} 行。'],
  csCopyFailed: ['The clipboard refused the copy. Nothing was changed.', '剪貼簿唔肯收，冇嘢改動咗。'],
  csExported: ['Console output exported as {0}.', '終端機輸出匯出做 {0}。'],
  csAdjust: ['Fit the window to the output', '將視窗調到啱曬輸出'],
  csHistoryHint: [
    'Up and Down step through this session’s command history. It is kept in memory only and is never written to disk.',
    '上下鍵可以揭返呢個工作階段打過嘅指令。淨係擺喺記憶體度，唔會寫落磁碟。'],
  csTruncated: [
    'The oldest lines were dropped — this window keeps the most recent {0}.',
    '最舊嗰幾行掉咗——呢個視窗淨係留最近 {0} 行。'],
  csNoSession: ['No session is open, so there is nothing to run a command on.', '冇開任何工作階段，冇地方行指令。'],
  csNoBridge: [
    'The console runs in the application’s main process, which this window cannot reach right now.',
    '終端機喺程式嘅主行程度，呢個視窗而家去唔到嗰邊。'],
  csFullScreenProgram: [
    'That looks like a full-screen program ({0}). This console is line-oriented and cannot draw one — run it from a terminal instead.',
    '呢個似係全螢幕程式（{0}）。呢個終端機係逐行嘅，畫唔到佢——請用真終端機行。'],
};

function s(key, ...params) {
  const raw = resolveI18n(STR[key], getLanguage(), getFunnyLevel('en'), getFunnyLevel('yue'));
  const out = raw == null ? key : raw;
  return params.length
    ? String(out).replace(/\{(\d+)\}/g, (m, i) => (params[Number(i)] === undefined ? m : String(params[Number(i)])))
    : out;
}

/** Scrollback bound. A `yes` or a `tail -f` must not grow this window forever. */
export const MAX_CONSOLE_LINES = 2000;

/**
 * Programs that take over the screen. They are refused before they run, with
 * the reason — line-oriented output turns them into escape-sequence soup, and
 * a console that renders soup looks broken rather than unsuitable.
 */
const FULL_SCREEN_RE = /^\s*(?:sudo\s+)?(vi|vim|nvim|emacs|nano|pico|top|htop|less|more|man|mc|tmux|screen|watch|dialog|whiptail)(\s|$)/i;

/* ------------------------------------------------------------------ */
/* the main-process bridge                                             */
/* ------------------------------------------------------------------ */

async function callMain(path, ...args) {
  const raw = api.raw;
  if (!raw) { const e = new Error(s('csNoBridge')); e.code = 'NO_BRIDGE'; throw e; }
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

function onMainEvent(name, fn) {
  const raw = api.raw;
  if (!raw || typeof raw.on !== 'function') return () => {};
  try { return raw.on(name, fn) || (() => {}); }
  catch { return () => {}; }
}

/**
 * Whether a session can host a console at all. Menus call this to grey the
 * command out — the UI must never offer an action the protocol will refuse.
 */
export function canOpenConsole(info) {
  return !!(info && info.caps && info.caps.exec);
}

/* ------------------------------------------------------------------ */
/* styles                                                              */
/* ------------------------------------------------------------------ */

let stylesWritten = false;
function ensureStyles() {
  if (stylesWritten || typeof document === 'undefined') return;
  stylesWritten = true;
  styleSheet('console').set(`
.cs { display: flex; flex-direction: column; gap: calc(8px * var(--den)); flex: 1 1 auto; min-height: 0; }
.cs-dir { display: flex; align-items: center; gap: calc(6px * var(--den));
  font-size: var(--type-label-sm); color: var(--onsv); }
.cs-dir .mono { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cs-warn { display: flex; align-items: center; gap: calc(8px * var(--den));
  background: var(--c-low); border-radius: var(--shape-md); padding: calc(8px * var(--den));
  font-size: var(--type-body-sm); line-height: 1.5; }
.cs-warn.is-blocked { background: var(--errc); color: var(--onerrc); }
.cs-out { flex: 1 1 auto; min-height: calc(140px * var(--uiscale)); overflow: auto;
  background: var(--c-lowest); border: 1px solid var(--outline-var);
  border-radius: var(--shape-md); padding: calc(6px * var(--den)); }
.cs-line { font-family: var(--mono); font-size: var(--type-label-md); line-height: 1.5;
  white-space: pre-wrap; overflow-wrap: anywhere; padding: 0 calc(4px * var(--den)); }
.cs-line[data-stream="command"] { color: var(--p); font-weight: 700; }
.cs-line[data-stream="stderr"] { color: var(--err); }
.cs-line[data-stream="info"] { color: var(--onsv); }
.cs-line[data-stream="exit"] { color: var(--onsv); font-style: italic; }
.cs-row { display: flex; align-items: center; gap: calc(6px * var(--den)); flex-wrap: wrap; }
.cs-input { flex: 1 1 24ch; min-width: 14ch; font-family: var(--mono); }
.cs-count { font-size: var(--type-label-sm); color: var(--onsv); }
.cs-empty { padding: calc(18px * var(--den)); text-align: center; color: var(--onsv); line-height: 1.55; }
.cs-busy { display: inline-flex; align-items: center; gap: 6px; border-radius: var(--shape-full);
  padding: 0 calc(10px * var(--den)); min-height: calc(24px * var(--den));
  background: var(--terc); color: var(--onterc); font-size: var(--type-label-sm); font-weight: 600; }
`);
}

/* ------------------------------------------------------------------ */
/* the console                                                         */
/* ------------------------------------------------------------------ */

const openConsoles = new Map();          // session id -> handle

/**
 * createConsoleWindow(info) — `info` is the session:info record, so the caps
 * matrix, the protocol name and the connection state all come from the same
 * place main uses.
 */
export function createConsoleWindow(info) {
  ensureStyles();

  const sessionId = info.id;
  let caps = info.caps || {};
  let connected = !!info.connected;
  let protocolName = info.protocol || '';
  let cwd = info.remotePath || info.home || '/';
  let busy = null;                        // the command being waited on
  let truncated = false;
  let destroyed = false;

  const lines = [];                       // { at, stream, text }
  const history = [];                     // newest last; memory only, never saved
  let historyAt = -1;

  const out = h('div', { class: 'cs-out', role: 'log', tabindex: '0', 'aria-label': t('consoleTitle') });
  const count = h('span', { class: 'cs-count', role: 'status' });
  const dirEl = h('span', { class: 'mono' }, cwd);
  const warnEl = h('div', { class: 'cs-warn' }, icon('warning', 17), h('span', {}, s('csWarn')));
  const busyEl = h('span', { class: 'cs-busy', hidden: true },
    icon('pending', 14), h('span', {}, s('csRunning')));

  const inputId = uid('cs-input');
  const input = h('input', {
    type: 'text', class: 'field-input cs-input', id: inputId, autocomplete: 'off',
    spellcheck: 'false', placeholder: t('consolePh'), title: s('csHistoryHint'),
    'aria-label': s('csCommand'),
  });

  const runBtn = h('button', {
    type: 'button', class: 'btn-filled', onclick: () => run(input.value),
  }, s('csExecute'));

  const stopBtn = h('button', {
    type: 'button', class: 'btn-text', hidden: true, title: s('csStopHint'),
    onclick: () => stopWaiting(),
  }, icon('close', 16), s('csStopWaiting'));

  const search = createSearchBar({
    id: `console-${sessionId}`,
    persist: false,
    compact: true,
    labelKey: 'search',
    placeholder: s('csSearchPh'),
    appearanceKey: 'search-console',
    appearanceLabel: 'Console output search',
    sampleProvider: () => lines.slice(-400).map((l) => l.text).join('\n'),
    onChange: () => renderOut(),
  });

  const clearBtn = h('button', { type: 'button', class: 'btn-text', onclick: () => clearOut() },
    icon('delete', 16), s('csClear'));
  const copyBtn = h('button', { type: 'button', class: 'btn-text', onclick: () => copyShown() },
    icon('content_copy', 16), s('csCopy'));
  const exportBtn = h('button', { type: 'button', class: 'btn-text', onclick: () => exportShown() },
    icon('file_download', 16), s('csExport'));
  const adjustBtn = h('button', {
    type: 'button', class: 'icon-btn', title: s('csAdjust'), 'aria-label': s('csAdjust'),
    onclick: () => adjustWindow(),
  }, icon('unfold_more', 17));

  const body = h('div', { class: 'cs' },
    h('div', { class: 'cs-dir' }, icon('folder', 15), h('span', {}, `${s('csCurrentDir')}:`), dirEl),
    warnEl,
    h('div', { class: 'cs-row' }, search.element, count, h('span', { class: 'spacer' }), clearBtn, copyBtn, exportBtn),
    out,
    h('div', { class: 'cs-row' },
      h('label', { class: 'field-label', for: inputId }, s('csCommand')),
      input, runBtn, stopBtn, busyEl));
  appearanceTarget(body, 'console-body', 'Console');
  appearanceTarget(out, 'console-output', 'Console output');

  registerContextMenu(out, () => [
    { label: t('copyClip'), icon: 'content_copy', onSelect: () => copyShown() },
    { label: t('selectFiles'), icon: 'select_all', onSelect: () => selectAll() },
    SEPARATOR,
    { label: s('csAdjust'), icon: 'unfold_more', onSelect: () => adjustWindow() },
    { label: s('csClear'), icon: 'delete', danger: true, onSelect: () => clearOut() },
  ]);

  /* ---------------- output ---------------- */

  function push(stream, text) {
    for (const raw of String(text === undefined || text === null ? '' : text).split('\n')) {
      const line = raw.replace(/\r$/, '');
      if (line === '' && stream === 'stdout' && lines.length && lines[lines.length - 1].text === '') continue;
      lines.push({ at: Date.now(), stream, text: line });
    }
    if (lines.length > MAX_CONSOLE_LINES) {
      lines.splice(0, lines.length - MAX_CONSOLE_LINES);
      truncated = true;
    }
    renderSoon();
  }

  function visibleLines() {
    const predicate = search.predicate;
    if (!search.isActive || !predicate.ok) return lines;
    return lines.filter((l) => predicate.test(l.text));
  }

  function renderOut() {
    if (destroyed) return;
    const shown = visibleLines();
    count.textContent = s('csShowing', shown.length, lines.length);
    const atEnd = out.scrollHeight - out.scrollTop - out.clientHeight < 24;
    clear(out);

    if (!lines.length) {
      out.appendChild(h('div', { class: 'cs-empty' }, connected ? s('csEmpty') : s('csNotConnected')));
      return;
    }
    if (!shown.length) {
      out.appendChild(h('div', { class: 'cs-empty' }, s('csNoMatch', search.predicate.describe)));
      return;
    }
    if (truncated) out.appendChild(h('div', { class: 'cs-line', 'data-stream': 'info' }, s('csTruncated', MAX_CONSOLE_LINES)));
    const frag = document.createDocumentFragment();
    for (const l of shown) {
      frag.appendChild(h('div', { class: 'cs-line', 'data-stream': l.stream },
        l.stream === 'command' ? `$ ${l.text}` : l.text));
    }
    out.appendChild(frag);
    if (atEnd) out.scrollTop = out.scrollHeight;
  }

  const renderSoon = debounce(renderOut, 50);

  function selectAll() {
    const range = document.createRange();
    range.selectNodeContents(out);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function shownAsText() {
    return visibleLines()
      .map((l) => (l.stream === 'command' ? `$ ${l.text}` : l.text))
      .join('\r\n');
  }

  async function copyShown() {
    const shown = visibleLines();
    const ok = await copyText(shownAsText());
    if (ok) notify.success(t('consoleTitle'), s('csCopied', shown.length));
    else notify.error(t('consoleTitle'), s('csCopyFailed'));
  }

  function exportShown() {
    const name = `winscp-material-console-${new Date().toISOString().slice(0, 10)}.txt`;
    downloadText(name, shownAsText(), 'text/plain');
    notify.success(t('consoleTitle'), s('csExported', name));
  }

  function clearOut() {
    lines.length = 0;
    truncated = false;
    renderOut();
    announce(s('csCleared'));
  }

  function adjustWindow() {
    // Grow the window so the output that exists fits, capped by the viewport —
    // WinSCP's "Adjust Window" does exactly this.
    const el = win.element;
    const extra = out.scrollHeight - out.clientHeight;
    if (extra <= 0) return;
    const max = document.documentElement.clientHeight - el.offsetTop - 12;
    el.style.height = `${clamp(el.offsetHeight + extra + 8, 220, Math.max(220, max))}px`;
    requestAnimationFrame(() => { out.scrollTop = out.scrollHeight; });
  }

  /* ---------------- capability + connection state ---------------- */

  function applyState() {
    const runnable = canOpenConsole({ caps }) && connected;
    input.disabled = !runnable;
    runBtn.disabled = !runnable || !!busy;
    clear(warnEl);
    warnEl.classList.toggle('is-blocked', !runnable);
    if (!canOpenConsole({ caps })) {
      warnEl.appendChild(icon('error', 17));
      warnEl.appendChild(h('span', {}, s('csNoExec', protocolName)));
      input.title = s('csNoExecShort', protocolName);
    } else if (!connected) {
      warnEl.appendChild(icon('warning', 17));
      warnEl.appendChild(h('span', {}, s('csNotConnected')));
      input.title = s('csNotConnected');
    } else {
      warnEl.appendChild(icon('warning', 17));
      warnEl.appendChild(h('span', {}, s('csWarn')));
      input.title = s('csHistoryHint');
    }
    busyEl.hidden = !busy;
    stopBtn.hidden = !busy;
    dirEl.textContent = cwd;
    dirEl.title = cwd;
  }

  /* ---------------- running ---------------- */

  function stopWaiting() {
    if (!busy) return;
    const command = busy.command;
    busy = null;
    applyState();
    push('info', s('csStopped', command));
    notify.warning(t('consoleTitle'), s('csStopped', command));
  }

  async function run(raw) {
    const command = String(raw || '').trim();
    if (!command || busy) return;
    if (!canOpenConsole({ caps })) { notify.error(t('consoleTitle'), s('csNoExec', protocolName)); return; }
    if (!connected) { notify.error(t('consoleTitle'), s('csNotConnected')); return; }

    const fullScreen = FULL_SCREEN_RE.exec(command);
    if (fullScreen) {
      push('stderr', s('csFullScreenProgram', fullScreen[1]));
      notify.warning(t('consoleTitle'), s('csFullScreenProgram', fullScreen[1]));
      return;
    }

    history.push(command);
    historyAt = history.length;
    input.value = '';
    push('command', command);

    const token = { command };
    busy = token;
    applyState();

    try {
      const res = await callMain('session.exec', sessionId, command, {});
      if (busy !== token) return;          // the user stopped waiting for this one
      if (res && res.stdout) push('stdout', res.stdout);
      if (res && res.stderr) push('stderr', res.stderr);
      const code = res && (res.exitCode !== undefined ? res.exitCode : res.code);
      push('exit', code ? s('csExit', code) : s('csExitOk'));
      // A command that changes directory changes what the panels show; ask
      // main for the session's current path rather than guessing from the text.
      refreshCwd();
    } catch (err) {
      if (busy === token) push('stderr', s('csFailed', command, err.message));
      notify.error(t('consoleTitle'), s('csFailed', command, err.message));
    } finally {
      if (busy === token) { busy = null; applyState(); }
    }
  }

  async function refreshCwd() {
    try {
      const st = await callMain('session.getState', sessionId);
      if (st && st.remotePath) { cwd = st.remotePath; applyState(); }
    } catch { /* the label keeps the last path it knew, which is still true */ }
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); run(input.value); return; }
    if (e.key === 'ArrowUp') {
      if (!history.length) return;
      e.preventDefault();
      historyAt = clamp(historyAt - 1, 0, history.length - 1);
      input.value = history[historyAt];
      input.setSelectionRange(input.value.length, input.value.length);
    } else if (e.key === 'ArrowDown') {
      if (!history.length) return;
      e.preventDefault();
      historyAt += 1;
      if (historyAt >= history.length) { historyAt = history.length; input.value = ''; }
      else input.value = history[historyAt];
    }
  });

  /* ---------------- the window ---------------- */

  const win = openModelessWindow({
    title: t('consoleTitle'),
    subtitle: `${info.name || info.hostName || sessionId} — ${protocolName}`,
    icon: 'terminal',
    width: 820,
    height: 520,
    toolbar: adjustBtn,
    appearanceKey: 'console-window',
    appearanceLabel: 'Console window',
    content: body,
    onClose: () => {
      destroyed = true;
      offLog();
      offConsole();
      offSession();
      unbind();
      search.destroy();
      openConsoles.delete(sessionId);
    },
  });

  /* ---------------- live output ---------------- */

  const offLog = onMainEvent('event:log', (payload) => {
    if (!payload || payload.sessionId !== sessionId || !payload.line) return;
    // While a command is in flight the session log is the only live view of it,
    // so its sent/received lines are mirrored here as they arrive.
    if (!busy) return;
    const rec = payload.line;
    if (rec.kind === 'recv') push('stdout', rec.text);
    else if (rec.kind === 'error') push('stderr', rec.text);
  });

  const offConsole = onMainEvent('event:console', (payload) => {
    if (!payload) return;
    if (payload.text) push(payload.stream === 'stderr' ? 'stderr' : 'stdout', payload.text);
    if (payload.done) push('exit', payload.exitCode ? s('csExit', payload.exitCode) : s('csExitOk'));
  });

  const offSession = onMainEvent('event:session', (payload) => {
    if (!payload || payload.sessionId !== sessionId) return;
    if (payload.type === 'state' && payload.info) {
      caps = payload.info.caps || caps;
      connected = !!payload.info.connected;
      protocolName = payload.info.protocol || protocolName;
      if (payload.info.remotePath) cwd = payload.info.remotePath;
      applyState();
      renderOut();
    }
  });

  const unbind = bindRender(win.element, () => { applyState(); renderOut(); });

  applyState();
  renderOut();
  requestAnimationFrame(() => input.focus());

  const handle = {
    sessionId,
    element: win.element,
    window: win,
    run,
    get lines() { return visibleLines(); },
    focus: () => { win.focus(); input.focus(); },
    close: () => win.close('api'),
  };
  openConsoles.set(sessionId, handle);
  return handle;
}

/**
 * openConsole(sessionId)
 *
 * Refuses — with the protocol named — rather than opening a console on a
 * session that cannot execute anything.
 */
export async function openConsole(sessionId) {
  ensureStyles();
  let id = sessionId;
  try {
    if (!id) {
      const list = await callMain('session.list');
      const first = (Array.isArray(list) ? list : []).find((x) => canOpenConsole(x)) || (Array.isArray(list) ? list[0] : null);
      if (!first) { notify.error(t('consoleTitle'), s('csNoSession')); return null; }
      id = first.id;
    }
    if (openConsoles.has(id)) { const existing = openConsoles.get(id); existing.focus(); return existing; }
    const info = await callMain('session.info', id);
    if (!canOpenConsole(info)) {
      notify.error(t('consoleTitle'), s('csNoExec', (info && info.protocol) || ''));
      return null;
    }
    const state = await callMain('session.getState', id).catch(() => null);
    return createConsoleWindow({ ...info, remotePath: (state && state.remotePath) || info.remotePath });
  } catch (err) {
    notify.error(t('consoleTitle'), err.message);
    return null;
  }
}

export function listConsoleWindows() { return Array.from(openConsoles.values()); }

/* ------------------------------------------------------------------ */
/* registration                                                        */
/* ------------------------------------------------------------------ */

let installed = false;

export function registerConsoleDialog() {
  if (installed) return;
  installed = true;
  ensureStyles();

  registerCommand({
    id: 'session.console',
    labelKey: 'openTerminal',
    icon: 'terminal',
    shortcut: 'Ctrl+T',
    run: (sessionId) => openConsole(sessionId),
  });
}

if (typeof document !== 'undefined') {
  queueMicrotask(() => {
    try { registerConsoleDialog(); } catch (err) { console.error('[console] registration failed', err); }
  });
}
