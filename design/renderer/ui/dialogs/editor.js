// ui/dialogs/editor.js — the internal editor.
//
// WinSCP's Editor.dfm is a document WINDOW, not a modal: you keep editing while
// the rest of the application stays usable. That is reproduced here with a
// modeless surface (`openModelessWindow` below, which ui/dialogs/console.js
// reuses) rather than a scrim that blocks the app to show a text box. The only
// modals this file opens are genuine decisions — the unsaved-changes prompt and
// the remote-file-changed conflict.
//
// The round trip is main's (design/main/editors.js): the file was downloaded to
// a temporary path we own, saving writes that path and uploads it, and the
// remote file is re-stat'ed first. THE CONFLICT IS NOT AN ERROR TO SWALLOW —
// silently overwriting a colleague's edit is the one failure mode of this
// feature that destroys work, so `REMOTE_CHANGED` becomes a prompt with three
// things the user can actually do, each of which really happens.
//
// Ported from Editor.dfm: Save, Save all, Reload, Cut/Copy/Paste/Delete/Select
// all, Undo/Redo, Find, Replace, Find next, Go to line, the Encoding submenu
// (default and UTF-8, extended here to every encoding editors.js can decode),
// the status bar's line counter, and the editor popup menu.

import {
  h, icon, clear, uid, appearanceTarget, announce, openModal, layer, focusMemory,
  trapFocus, clamp, debounce, copyText, oneLine, on,
} from '../../dom.js';
import { t, bindRender, getLanguage, getFunnyLevel } from '../../i18n.js';
import { resolveI18n } from '../../../winscp-i18n.js';
import { api, bus } from '../../state.js';
import { styleSheet } from '../../theme.js';
import { createSearchBar } from '../searchbar.js';
import { compile, escapeLiteral } from '../regexbuilder.js';
import { notify } from '../notifications.js';
import { registerContextMenu, SEPARATOR, attachMenuButton } from '../contextmenu.js';
import { registerDialog, registerCommand, openDialog } from '../../app.js';

/* ------------------------------------------------------------------ */
/* module-local strings                                                */
/* ------------------------------------------------------------------ */

const STR = {
  edFindPh: ['Find in this file', '喺呢個檔案入面搵'],
  edMatchCase: ['Match case', '分大細楷'],
  edWholeWord: ['Whole word', '成個字'],
  edFindPrev: ['Find previous', '搵上一個'],
  edReplace: ['Replace', '取代'],
  edNoMatchHere: ['No match', '搵唔到'],
  edMatchOf: ['{0} of {1}', '第 {0} 個，共 {1} 個'],
  edGoTo: ['Go to line', '跳去行'],
  edGoToOutOf: ['This file has {0} line(s).', '呢個檔案有 {0} 行。'],
  edTabSize: ['Tab size', 'Tab 闊度'],
  edTabInserts: ['Tab inserts a tab character', 'Tab 會打一個 tab'],
  edTabMoves: ['Tab moves to the next control', 'Tab 會跳去下一個控制項'],
  edTabToggleHint: [
    'Ctrl+M switches between Tab inserting a tab and Tab moving to the next control, so the editor never traps keyboard focus.',
    'Ctrl+M 可以喺「Tab 打 tab」同「Tab 跳去下一個控制項」之間切換，等鍵盤焦點唔會困死喺編輯器度。'],
  edReload: ['Reload from the temporary copy', '由暫存副本重新載入'],
  edReloadWarn: [
    'Reloading reads the temporary file again and throws away the edits in this window. That cannot be undone from here.',
    '重新載入會再讀一次暫存檔，而家呢個視窗入面嘅改動會冇咗，喺呢度復原唔到。'],
  edSaved: ['{0} saved and uploaded — {1} bytes.', '{0} 儲咗又上載咗——{1} bytes。'],
  edSavedLocal: ['{0} saved to the local file.', '{0} 儲咗落本機檔案。'],
  edSaveFailed: ['{0} was not saved: {1}', '{0} 儲唔到：{1}'],
  edNothingToSave: ['Nothing has changed since the last save.', '上次儲存之後乜都冇改過。'],
  edOpening: ['Opening {0}…', '開緊 {0}…'],
  edOpenFailed: ['{0} could not be opened: {1}', '開唔到 {0}：{1}'],
  edTooBig: [
    '{0} is {1} bytes. The internal editor refuses anything over {2} bytes rather than pulling it all into memory — download it instead.',
    '{0} 有 {1} bytes。內建編輯器唔會開超過 {2} bytes 嘅檔案，唔會硬食落記憶體——請下載佢。'],
  edEncoding: ['Encoding', '編碼'],
  edEncodingDetected: ['detected', '自動偵測'],
  edEncodingWarn: [
    'Changing the encoding re-reads the file from the temporary copy, so the edits in this window would be lost. Save first, or discard them deliberately.',
    '改編碼會由暫存副本重新讀取，呢個視窗入面嘅改動會冇咗。請先儲存，或者刻意放棄佢哋。'],
  edEncodingChanged: ['Re-read as {0}.', '用 {0} 重新讀咗。'],
  edConflictTitle: ['The remote file changed', '遠端檔案變咗'],
  edConflictBody: [
    '{0} on the server is not the copy this editor downloaded, so somebody else has written to it.\n\nWhen it was opened: {1} bytes, {2}.\nOn the server now: {3} bytes, {4}.\n\nYour text is already written to the temporary file, so nothing is lost whichever you choose.',
    '伺服器上面嘅 {0} 已經唔係呢個編輯器下載嗰份，即係有第二個人寫咗佢。\n\n開嗰陣：{1} bytes，{2}。\n伺服器而家：{3} bytes，{4}。\n\n你打嘅字已經寫咗落暫存檔，所以無論你揀邊個都唔會冇咗。'],
  edConflictForce: ['Upload mine anyway', '照樣上載我嗰份'],
  edConflictShowTemp: ['Show my copy on disk', '喺磁碟度顯示我嗰份'],
  edConflictFetch: ['Save the server’s copy…', '儲存伺服器嗰份…'],
  edConflictFetched: ['The server’s copy of {0} was saved as {1}.', '伺服器嗰份 {0} 儲咗做 {1}。'],
  edForced: ['{0} uploaded over the server’s newer copy — {1} bytes.', '{0} 已經蓋過伺服器較新嗰份上載咗——{1} bytes。'],
  edRemoteMissing: [
    '{0} is no longer on the server. Saving will create it again.',
    '{0} 已經唔喺伺服器度。儲存會重新建立佢。'],
  edOrphan: [
    'The edit to {0} was not uploaded. The temporary file has been kept at {1}.',
    '{0} 嘅改動冇上載到。暫存檔留咗喺 {1}。'],
  edBinary: [
    '{0} contains bytes that are not text. The internal editor will not open it, because displaying and re-saving it would mangle the file.',
    '{0} 入面有啲唔係文字嘅位元組。內建編輯器唔會開佢，因為顯示完再儲存會整壞個檔案。'],
  edReadOnly: ['Read-only', '唯讀'],
  edDirty: ['Unsaved', '未儲存'],
  edBytes: ['{0} bytes', '{0} bytes'],
  edLines: ['{0} lines', '{0} 行'],
  edWordWrap: ['Word wrap', '自動換行'],
  edClose: ['Close the editor', '閂編輯器'],
  edNoBridge: [
    'Editing runs in the application’s main process, which this window cannot reach right now.',
    '編輯功能喺程式嘅主行程度，呢個視窗而家去唔到嗰邊。'],
  edOrphansTitle: ['Temporary files from editing', '編輯遺留嘅暫存檔'],
  edOrphansBody: [
    'These files were downloaded for editing and never cleaned up — usually because the application stopped before an upload finished. Each one may be the only copy of an edit.',
    '呢啲檔案係為咗編輯而下載，之後冇清走——通常係因為上載未完程式就停咗。每一個都可能係某次改動嘅唯一副本。'],
  edOrphansNone: ['No temporary files are left over.', '冇遺留任何暫存檔。'],
  edOrphansDiscard: ['Discard the selected', '刪走揀咗嗰啲'],
  edOrphansShow: ['Show in folder', '喺資料夾度顯示'],
  edOrphansDiscarded: ['{0} temporary file(s) removed.', '刪咗 {0} 個暫存檔。'],
  edReplacedNone: ['Nothing matched, so nothing was replaced.', '冇嘢符合，所以冇取代過。'],
  edCut: ['Cut', '剪下'], edPaste: ['Paste', '貼上'], edUndo: ['Undo', '撤銷'],
  edRedo: ['Redo', '重做'], edSelectAll: ['Select all', '全選'],
  edDeleteSelection: ['Delete selection', '刪除選取內容'],
  edClipboardEmpty: ['The clipboard has no text to paste.', '剪貼簿冇文字可以貼。'],
};

function strIn(language, key, ...params) {
  const raw = resolveI18n(STR[key], language, getFunnyLevel('en'), getFunnyLevel('yue'));
  const out = raw == null ? key : raw;
  return params.length
    ? String(out).replace(/\{(\d+)\}/g, (m, i) => (params[Number(i)] === undefined ? m : String(params[Number(i)])))
    : String(out);
}

function s(key, ...params) {
  const mode = getLanguage();
  if (mode !== 'both') return strIn(mode, key, ...params);
  const en = strIn('en', key, ...params);
  const yue = strIn('yue', key, ...params);
  return en === yue ? en : `${en} · ${yue}`;
}

/**
 * The paragraphs of a multi-paragraph string, one language at a time.
 *
 * Resolving first and splitting afterwards is what produces
 * "…whichever you choose. · 伺服器上面嘅…": bilingual mode joins the WHOLE
 * English text to the WHOLE Cantonese text, so the split fuses the last English
 * paragraph to the first Cantonese one and orphans the rest. Splitting per
 * language and pairing by index keeps each paragraph a paragraph. Same rule as
 * `compose` in ui/changelog.js, applied to block text.
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

/** What editors.js can decode. `auto` re-detects from the bytes. */
const ENCODINGS = [
  { id: 'auto', label: 'Auto-detect' },
  { id: 'utf8', label: 'UTF-8' },
  { id: 'utf8bom', label: 'UTF-8 with BOM' },
  { id: 'utf16le', label: 'UTF-16 LE' },
  { id: 'utf16be', label: 'UTF-16 BE' },
  { id: 'ansi', label: 'ANSI (Windows-1252)' },
];

/** Above this the internal editor declines rather than loading it all. */
export const MAX_EDIT_BYTES = 8 * 1024 * 1024;

/* ------------------------------------------------------------------ */
/* the main-process bridge                                             */
/* ------------------------------------------------------------------ */

async function callMain(path, ...args) {
  const raw = api.raw;
  if (!raw) { const e = new Error(s('edNoBridge')); e.code = 'NO_BRIDGE'; throw e; }
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

function onMainEvent(name, fn) {
  const raw = api.raw;
  if (!raw || typeof raw.on !== 'function') return () => {};
  try { return raw.on(name, fn) || (() => {}); }
  catch { return () => {}; }
}

/** Offer arbitrary bytes as a download without touching the network. */
function downloadBase64(filename, base64, mime = 'application/octet-stream') {
  const bin = atob(String(base64 || ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const a = h('a', { href: url, download: filename, style: { display: 'none' } });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 1000);
}

/* ================================================================== */
/* the modeless window frame                                           */
/* ================================================================== */
// Exported because ui/dialogs/console.js is the same kind of surface: a real
// window you keep working in, not a modal that stops the application. Keeping
// one implementation means the drag, the resize, the focus restoration and the
// Escape handling behave identically in both.

let windowSeq = 0;

/**
 * openModelessWindow({ title, subtitle, icon, content, toolbar, footer,
 *                      width, height, appearanceKey, onClose, canClose })
 *
 * role="dialog" with aria-modal="false" and NO scrim: everything behind stays
 * reachable with the mouse and the keyboard. `canClose()` may return a promise
 * resolving false to keep the window open (the unsaved-changes prompt).
 */
export function openModelessWindow(opts = {}) {
  ensureStyles();
  const restore = focusMemory();
  const titleId = uid('mw-title');
  const index = windowSeq += 1;

  const titleEl = h('span', { class: 'mw-title', id: titleId }, opts.title || '');
  const subEl = h('span', { class: 'mw-sub' }, opts.subtitle || '');
  const toolsEl = h('div', { class: 'mw-tools' });
  const bodyEl = h('div', { class: 'mw-body' }, opts.content || null);
  const footEl = h('div', { class: 'mw-foot' }, opts.footer || null);

  const closeBtn = h('button', {
    type: 'button', class: 'icon-btn', title: opts.closeLabel || t('close'),
    'aria-label': opts.closeLabel || t('close'),
    onclick: () => close('button'),
  }, icon('close', 17));

  const header = h('div', { class: 'mw-head' },
    icon(opts.icon || 'edit', 17),
    h('div', { class: 'mw-titles' }, titleEl, subEl),
    h('span', { class: 'spacer' }),
    toolsEl, closeBtn);

  const grip = h('div', { class: 'mw-grip', 'aria-hidden': 'true' });

  const win = h('div', {
    class: 'mw surface-3', role: 'dialog', 'aria-modal': 'false',
    'aria-labelledby': titleId, tabindex: '-1',
  }, header, bodyEl, footEl, grip);
  appearanceTarget(win, opts.appearanceKey || 'modeless-window', opts.appearanceLabel || 'Editor window');

  if (opts.toolbar) toolsEl.appendChild(opts.toolbar);

  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const w = Math.min(opts.width || 880, vw - 40);
  const hgt = Math.min(opts.height || 560, vh - 60);
  // Each new window steps down and right so several editors do not stack
  // exactly on top of one another and become impossible to tell apart.
  const step = ((index - 1) % 6) * 26;
  let x = clamp(Math.round((vw - w) / 2) + step, 8, Math.max(8, vw - w - 8));
  let y = clamp(Math.round((vh - hgt) / 2) - 20 + step, 8, Math.max(8, vh - hgt - 8));
  Object.assign(win.style, { width: `${w}px`, height: `${hgt}px`, left: `${x}px`, top: `${y}px` });

  /* ---- drag by the header ---- */
  header.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button, input, select, a')) return;
    e.preventDefault();
    const startX = e.clientX, startY = e.clientY;
    const ox = win.offsetLeft, oy = win.offsetTop;
    header.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const maxX = document.documentElement.clientWidth - win.offsetWidth - 4;
      const maxY = document.documentElement.clientHeight - win.offsetHeight - 4;
      x = clamp(ox + ev.clientX - startX, 4, Math.max(4, maxX));
      y = clamp(oy + ev.clientY - startY, 4, Math.max(4, maxY));
      win.style.left = `${x}px`;
      win.style.top = `${y}px`;
    };
    const up = () => {
      header.removeEventListener('pointermove', move);
      header.removeEventListener('pointerup', up);
      try { header.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    };
    header.addEventListener('pointermove', move);
    header.addEventListener('pointerup', up);
  });

  /* ---- resize from the corner ---- */
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const startX = e.clientX, startY = e.clientY;
    const ow = win.offsetWidth, oh = win.offsetHeight;
    grip.setPointerCapture(e.pointerId);
    const move = (ev) => {
      win.style.width = `${Math.max(320, ow + ev.clientX - startX)}px`;
      win.style.height = `${Math.max(220, oh + ev.clientY - startY)}px`;
    };
    const up = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      try { grip.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
  });

  // Keyboard move/resize, because a window only a mouse can move is a window
  // some users cannot move.
  header.tabIndex = 0;
  header.setAttribute('role', 'toolbar');
  header.setAttribute('aria-label', `${opts.title || ''} — window`);
  header.addEventListener('keydown', (e) => {
    if (e.target !== header) return;
    const stepPx = e.shiftKey ? 32 : 8;
    const grow = e.ctrlKey || e.metaKey;
    const map = {
      ArrowLeft: () => (grow ? win.style.width = `${Math.max(320, win.offsetWidth - stepPx)}px` : win.style.left = `${x = Math.max(4, x - stepPx)}px`),
      ArrowRight: () => (grow ? win.style.width = `${win.offsetWidth + stepPx}px` : win.style.left = `${x = x + stepPx}px`),
      ArrowUp: () => (grow ? win.style.height = `${Math.max(220, win.offsetHeight - stepPx)}px` : win.style.top = `${y = Math.max(4, y - stepPx)}px`),
      ArrowDown: () => (grow ? win.style.height = `${win.offsetHeight + stepPx}px` : win.style.top = `${y = y + stepPx}px`),
    };
    if (map[e.key]) { e.preventDefault(); map[e.key](); }
  });

  layer('popover').appendChild(win);
  // Tab stays inside the window while it has focus, but Escape and clicking
  // anywhere else leave it — it is modeless, so nothing is trapped against the
  // user's will.
  const untrap = trapFocus(win);
  const offKey = on(win, 'keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close('escape'); }
  });

  win.addEventListener('pointerdown', () => {
    // Clicking a window brings it to the front of the popover layer.
    const host = layer('popover');
    if (host.lastChild !== win) host.appendChild(win);
  });

  let closed = false;
  async function close(reason) {
    if (closed) return true;
    if (typeof opts.canClose === 'function') {
      const okToClose = await opts.canClose(reason);
      if (okToClose === false) return false;
    }
    closed = true;
    untrap();
    offKey();
    win.remove();
    opts.onClose?.(reason);
    restore();
    return true;
  }

  requestAnimationFrame(() => {
    const first = win.querySelector('textarea, input, select, button');
    (first || win).focus();
  });

  return {
    element: win,
    body: bodyEl,
    footer: footEl,
    tools: toolsEl,
    close,
    setTitle(text) { titleEl.textContent = text; },
    setSubtitle(text) { subEl.textContent = text; },
    focus() { win.focus(); },
  };
}

/* ================================================================== */
/* styles                                                              */
/* ================================================================== */

let stylesWritten = false;
function ensureStyles() {
  if (stylesWritten || typeof document === 'undefined') return;
  stylesWritten = true;
  styleSheet('editor').set(`
.mw { position: fixed; display: flex; flex-direction: column; min-width: calc(320px * var(--uiscale));
  border-radius: var(--shape-lg); background: var(--c-high); color: var(--onsfc);
  box-shadow: var(--e4); overflow: hidden; }
.mw-head { display: flex; align-items: center; gap: calc(8px * var(--den));
  padding: calc(6px * var(--den)) calc(8px * var(--den));
  background: var(--c); border-bottom: 1px solid var(--outline-var); cursor: move; touch-action: none; }
.mw-titles { display: flex; flex-direction: column; min-width: 0; }
.mw-title { font-size: var(--type-label-lg); font-weight: 700; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }
.mw-sub { font-size: var(--type-label-sm); color: var(--onsv); overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }
.mw-tools { display: flex; align-items: center; gap: 2px; }
.mw-body { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column;
  padding: calc(8px * var(--den)); gap: calc(8px * var(--den)); overflow: hidden; }
.mw-foot { border-top: 1px solid var(--outline-var); background: var(--c);
  padding: calc(4px * var(--den)) calc(10px * var(--den)); }
.mw-foot:empty { display: none; }
.mw-grip { position: absolute; right: 0; bottom: 0; width: 18px; height: 18px;
  cursor: nwse-resize; touch-action: none;
  background: linear-gradient(135deg, transparent 50%, var(--outline) 50%, var(--outline) 60%,
    transparent 60%, transparent 72%, var(--outline) 72%, var(--outline) 82%, transparent 82%); }

.ed-bar { display: flex; align-items: center; gap: calc(6px * var(--den)); flex-wrap: wrap; }
.ed-find { display: flex; align-items: center; gap: calc(6px * var(--den)); flex-wrap: wrap;
  background: var(--c-low); border-radius: var(--shape-md); padding: calc(6px * var(--den)); }
.ed-find .sb { flex: 1 1 22ch; min-width: 16ch; }
.ed-rep { flex: 1 1 18ch; min-width: 12ch; }
.ed-hits { font-size: var(--type-label-sm); color: var(--onsv); min-width: 9ch;
  font-variant-numeric: tabular-nums; }
.ed-wrap { flex: 1 1 auto; min-height: 0; display: flex;
  border: 1px solid var(--outline-var); border-radius: var(--shape-md);
  background: var(--c-lowest); overflow: hidden; }
.ed-gutter { flex: 0 0 auto; padding: calc(6px * var(--den)) calc(6px * var(--den));
  text-align: right; color: var(--onsv); background: var(--c-low);
  font-family: var(--mono); font-size: var(--type-label-md); line-height: 1.5;
  overflow: hidden; user-select: none; white-space: pre; }
.ed-text { flex: 1 1 auto; min-width: 0; border: 0; outline: none; resize: none;
  padding: calc(6px * var(--den)) calc(8px * var(--den));
  background: transparent; color: var(--onsfc);
  font-family: var(--mono); font-size: var(--type-label-md); line-height: 1.5;
  white-space: pre-wrap; overflow-wrap: anywhere; }
.ed-text.is-nowrap { white-space: pre; overflow-wrap: normal; overflow-x: auto; }
.ed-text:focus-visible { outline: 2px solid var(--p); outline-offset: -2px; }
.ed-status { display: flex; align-items: center; gap: calc(10px * var(--den)); flex-wrap: wrap;
  font-size: var(--type-label-sm); color: var(--onsv); }
.ed-status .mono { font-variant-numeric: tabular-nums; }
.ed-flag { display: inline-flex; align-items: center; gap: 4px; border-radius: var(--shape-full);
  padding: 0 calc(8px * var(--den)); min-height: calc(20px * var(--den)); font-weight: 600; }
.ed-flag.is-dirty { background: var(--terc); color: var(--onterc); }
.ed-flag.is-ro { background: var(--secc); color: var(--onsecc); }
.ed-num { width: calc(8ch * var(--uiscale)); }
.ed-select { min-height: calc(32px * var(--den)); border: 1px solid var(--outline);
  border-radius: var(--shape-xs); background: var(--c-lowest); color: var(--onsfc); padding: 0 4px; }
.ed-orphans { display: flex; flex-direction: column; gap: calc(6px * var(--den));
  max-height: calc(320px * var(--uiscale)); overflow: auto; }
.ed-orphan { display: flex; align-items: center; gap: calc(8px * var(--den));
  background: var(--c-low); border-radius: var(--shape-sm); padding: calc(6px * var(--den)); }
.ed-orphan-path { flex: 1 1 auto; min-width: 0; font-family: var(--mono);
  font-size: var(--type-label-sm); overflow-wrap: anywhere; }
`);
}

/* ================================================================== */
/* helpers                                                             */
/* ================================================================== */

function lineColOf(text, index) {
  const before = text.slice(0, index);
  const line = before.split('\n').length;
  const col = index - (before.lastIndexOf('\n') + 1) + 1;
  return { line, col };
}

function offsetOfLine(text, line) {
  const lines = text.split('\n');
  const n = clamp(line, 1, lines.length);
  let offset = 0;
  for (let i = 0; i < n - 1; i += 1) offset += lines[i].length + 1;
  return { offset, end: offset + lines[n - 1].length, count: lines.length };
}

/** Text that is not text: a NUL byte survives decoding and marks a binary. */
export function looksBinary(text) {
  return /\u0000/.test(String(text || ''));
}

/* ================================================================== */
/* the editor                                                          */
/* ================================================================== */

const openEditors = new Map();          // editor id -> handle
const pendingEditorWindows = new Map(); // editor id -> Promise<handle|null>

/**
 * createEditorWindow(record, initial) — the surface for one already-open
 * editor record from main. `openEditor()` below is what callers use; this is
 * separated so a panel can host the same surface if it ever wants to.
 */
export function createEditorWindow(record, initial, opts = {}) {
  ensureStyles();

  const state = {
    id: record.id,
    record: { ...record },
    text: initial.text,
    saved: initial.text,
    encoding: initial.encoding,
    encodingDetected: initial.encodingDetected,
    bytes: initial.bytes,
    readOnly: !!opts.readOnly,
    wordWrap: opts.wordWrap !== false,
    tabSize: Number(opts.tabSize) || 8,
    tabInserts: true,
    matchCase: !!opts.findMatchCase,
    wholeWord: !!opts.findWholeWord,
  };
  const history = { undo: [], redo: [] };
  let undoBtn = null;
  let redoBtn = null;

  /* ---------------- text area + gutter ---------------- */

  const textarea = h('textarea', {
    class: 'ed-text', spellcheck: 'false', wrap: 'off',
    'aria-label': record.fileName,
    'aria-multiline': 'true',
    'aria-describedby': '',
  });
  textarea.value = state.text;
  textarea.readOnly = state.readOnly;
  textarea.style.tabSize = String(state.tabSize);

  const gutter = h('div', { class: 'ed-gutter', 'aria-hidden': 'true' });
  const wrapEl = h('div', { class: 'ed-wrap' }, gutter, textarea);
  appearanceTarget(textarea, 'editor-text', 'Editor text');
  appearanceTarget(gutter, 'editor-gutter', 'Editor line numbers');

  function paintGutter() {
    const count = state.text.split('\n').length;
    const digits = String(count).length;
    const out = [];
    for (let i = 1; i <= count; i += 1) out.push(String(i).padStart(digits, ' '));
    gutter.textContent = out.join('\n');
    gutter.scrollTop = textarea.scrollTop;
  }
  textarea.addEventListener('scroll', () => { gutter.scrollTop = textarea.scrollTop; });

  /* ---------------- find and replace ---------------- */

  const hits = h('span', { class: 'ed-hits', role: 'status' });
  const replaceInput = h('input', {
    type: 'text', class: 'field-input ed-rep', autocomplete: 'off', spellcheck: 'false',
    'aria-label': t('replaceWith'), placeholder: t('replaceWith'),
  });
  replaceInput.value = opts.replaceText || '';

  const matchCaseBox = h('input', { type: 'checkbox', onchange: () => { state.matchCase = matchCaseBox.checked; refreshHits(); } });
  matchCaseBox.checked = state.matchCase;
  const wholeWordBox = h('input', { type: 'checkbox', onchange: () => { state.wholeWord = wholeWordBox.checked; refreshHits(); } });
  wholeWordBox.checked = state.wholeWord;

  const find = createSearchBar({
    id: 'editor-find',
    persist: true,
    compact: true,
    labelKey: 'findReplace',
    placeholder: s('edFindPh'),
    appearanceKey: 'search-editor-find',
    appearanceLabel: 'Editor find bar',
    value: opts.findText || '',
    sampleProvider: () => state.text.slice(0, 20000),
    onChange: () => refreshHits(),
    onSubmit: () => findNext(1),
  });

  /**
   * ONE regular expression drives find, find-previous, replace and replace-all,
   * built from the search bar's own state. Plain mode escapes the literal (and
   * adds the word boundaries and the case flag); regex mode uses the pattern
   * and flags the builder produced. Nothing else in this file constructs a
   * matcher, so the four operations can never disagree about what matched.
   */
  function findRegex() {
    const st = find.state;
    let source = '';
    let flags = 'g';
    if (st.mode === 'regex') {
      if (!st.pattern) return null;
      source = st.pattern;
      flags += st.flags.replace(/g/g, '');
    } else {
      if (!st.query) return null;
      source = escapeLiteral(st.query);
      if (state.wholeWord) source = `\\b${source}\\b`;
      if (!state.matchCase) flags += 'i';
    }
    const c = compile(source, flags);
    return c.ok ? c.regex : null;
  }

  function allMatches() {
    const re = findRegex();
    if (!re) return [];
    const out = [];
    re.lastIndex = 0;
    let m = re.exec(state.text);
    let guard = 0;
    while (m && guard < 100000) {
      out.push({ start: m.index, end: m.index + (m[0].length || 0) });
      if (m[0].length === 0) re.lastIndex += 1;      // a zero-width match must not loop
      m = re.exec(state.text);
      guard += 1;
    }
    return out;
  }

  function refreshHits() {
    const list = allMatches();
    if (!list.length) {
      hits.textContent = find.isActive ? s('edNoMatchHere') : '';
      return;
    }
    const caret = textarea.selectionStart;
    const at = list.findIndex((x) => x.start >= caret);
    hits.textContent = s('edMatchOf', (at < 0 ? list.length : at + 1), list.length);
  }

  function select(match) {
    textarea.focus();
    textarea.setSelectionRange(match.start, match.end);
    // Bring the match into view: the caret alone does not scroll a textarea
    // that is already scrolled elsewhere.
    const { line } = lineColOf(state.text, match.start);
    const lineHeight = textarea.scrollHeight / Math.max(1, state.text.split('\n').length);
    textarea.scrollTop = Math.max(0, (line - 3) * lineHeight);
    gutter.scrollTop = textarea.scrollTop;
    updateStatus();
    refreshHits();
  }

  function findNext(direction) {
    const list = allMatches();
    if (!list.length) { announce(s('edNoMatchHere')); hits.textContent = s('edNoMatchHere'); return; }
    const caret = direction > 0 ? textarea.selectionEnd : textarea.selectionStart;
    let target;
    if (direction > 0) target = list.find((x) => x.start >= caret) || list[0];
    else {
      const before = list.filter((x) => x.end <= caret);
      target = before.length ? before[before.length - 1] : list[list.length - 1];
    }
    select(target);
  }

  function replaceOne() {
    if (state.readOnly) return;
    const list = allMatches();
    if (!list.length) { notify.info(t('findReplace'), s('edReplacedNone')); return; }
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const current = list.find((x) => x.start === start && x.end === end);
    const target = current || list.find((x) => x.start >= start) || list[0];
    const next = state.text.slice(0, target.start) + replaceInput.value + state.text.slice(target.end);
    setText(next, target.start + replaceInput.value.length);
    refreshHits();
  }

  function replaceAll() {
    if (state.readOnly) return;
    const re = findRegex();
    if (!re) return;
    let n = 0;
    re.lastIndex = 0;
    const next = state.text.replace(re, () => { n += 1; return replaceInput.value; });
    if (!n) { notify.info(t('findReplace'), s('edReplacedNone')); return; }
    setText(next, textarea.selectionStart);
    notify.success(t('findReplace'), t('replacedN', n));
    announce(t('replacedN', n));
    rememberFindState();
  }

  const rememberFindState = debounce(() => {
    // WinSCP remembers the last find and replace; so does this, through the
    // same preferences editors.js reads.
    const st = find.state;
    callMain('config.setPrefs', {
      editor: {
        findText: st.mode === 'regex' ? st.pattern : st.query,
        replaceText: replaceInput.value,
        findMatchCase: state.matchCase,
        findWholeWord: state.wholeWord,
      },
    }, 'Changed the editor find settings').catch(() => { /* remembering is a convenience, never a failure */ });
  }, 800);

  const replaceBtn = h('button', {
    type: 'button', class: 'btn-text', onclick: () => { replaceOne(); rememberFindState(); },
  }, s('edReplace'));
  const replaceAllBtn = h('button', {
    type: 'button', class: 'btn-text', onclick: () => replaceAll(),
  }, t('replaceAllBtn'));

  const findBar = h('div', { class: 'ed-find' },
    find.element,
    h('button', {
      type: 'button', class: 'icon-btn', title: t('findNext'), 'aria-label': t('findNext'),
      onclick: () => findNext(1),
    }, icon('arrow_downward', 17)),
    h('button', {
      type: 'button', class: 'icon-btn', title: s('edFindPrev'), 'aria-label': s('edFindPrev'),
      onclick: () => findNext(-1),
    }, icon('arrow_upward', 17)),
    hits,
    replaceInput,
    replaceBtn,
    replaceAllBtn,
    h('label', { class: 'check' }, matchCaseBox, h('span', {}, s('edMatchCase'))),
    h('label', { class: 'check' }, wholeWordBox, h('span', {}, s('edWholeWord'))));
  replaceInput.addEventListener('input', rememberFindState);
  // A viewer cannot rewrite the file, so the controls that would rewrite it say
  // so instead of accepting a click and doing nothing. replaceOne/replaceAll
  // still refuse on their own — this is what the user can SEE.
  if (state.readOnly) {
    replaceInput.readOnly = true;
    replaceInput.title = s('edReadOnly');
    replaceBtn.disabled = true;
    replaceAllBtn.disabled = true;
    replaceBtn.title = s('edReadOnly');
    replaceAllBtn.title = s('edReadOnly');
  }

  /* ---------------- go to line, encoding, wrap, tab size ---------------- */

  const goToInput = h('input', {
    type: 'number', min: '1', class: 'field-input ed-num', 'aria-label': s('edGoTo'),
  });
  function goToLine() {
    const { offset, end, count } = offsetOfLine(state.text, Number(goToInput.value) || 1);
    if (Number(goToInput.value) > count) notify.info(s('edGoTo'), s('edGoToOutOf', count));
    textarea.focus();
    textarea.setSelectionRange(offset, end);
    const lineHeight = textarea.scrollHeight / Math.max(1, count);
    textarea.scrollTop = Math.max(0, (Number(goToInput.value) - 3) * lineHeight);
    gutter.scrollTop = textarea.scrollTop;
    updateStatus();
  }
  goToInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); goToLine(); } });

  const encodingSel = h('select', { class: 'ed-select', 'aria-label': s('edEncoding') });
  for (const e of ENCODINGS) encodingSel.appendChild(h('option', { value: e.id }, e.label));
  encodingSel.value = state.encoding;
  encodingSel.addEventListener('change', () => changeEncoding(encodingSel.value));

  const wrapBox = h('input', {
    type: 'checkbox',
    onchange: () => {
      state.wordWrap = wrapBox.checked;
      textarea.classList.toggle('is-nowrap', !state.wordWrap);
      callMain('config.setPref', 'editor.wordWrap', state.wordWrap, 'Changed setting editor.wordWrap')
        .catch(() => { /* the window still honours it for this session */ });
    },
  });
  wrapBox.checked = state.wordWrap;
  textarea.classList.toggle('is-nowrap', !state.wordWrap);

  const tabSizeInput = h('input', {
    type: 'number', min: '1', max: '16', class: 'field-input ed-num', 'aria-label': s('edTabSize'),
  });
  tabSizeInput.value = String(state.tabSize);
  tabSizeInput.addEventListener('change', () => {
    state.tabSize = clamp(Number(tabSizeInput.value) || 8, 1, 16);
    tabSizeInput.value = String(state.tabSize);
    textarea.style.tabSize = String(state.tabSize);
    callMain('config.setPref', 'editor.tabSize', state.tabSize, 'Changed setting editor.tabSize')
      .catch(() => { /* applied to this window regardless */ });
  });

  /* ---------------- status ---------------- */

  const posEl = h('span', { class: 'mono' });
  const sizeEl = h('span', { class: 'mono' });
  const encEl = h('span', {});
  const flagEl = h('span', {});
  const tabModeEl = h('span', { class: 'muted' });
  const statusEl = h('div', { class: 'ed-status', role: 'status' },
    posEl, sizeEl, encEl, flagEl, h('span', { class: 'spacer' }), tabModeEl);
  appearanceTarget(statusEl, 'editor-status', 'Editor status bar');

  function updateStatus() {
    const { line, col } = lineColOf(state.text, textarea.selectionStart);
    posEl.textContent = t('lineCol', line, col);
    sizeEl.textContent = `${s('edBytes', new TextEncoder().encode(state.text).length)} · ${s('edLines', state.text.split('\n').length)}`;
    encEl.textContent = `${s('edEncoding')}: ${(ENCODINGS.find((e) => e.id === state.encoding) || { label: state.encoding }).label}`
      + (state.encodingDetected ? ` (${s('edEncodingDetected')})` : '');
    clear(flagEl);
    if (state.readOnly) flagEl.appendChild(h('span', { class: 'ed-flag is-ro' }, s('edReadOnly')));
    else if (isDirty()) flagEl.appendChild(h('span', { class: 'ed-flag is-dirty' }, s('edDirty')));
    tabModeEl.textContent = state.tabInserts ? s('edTabInserts') : s('edTabMoves');
    tabModeEl.title = s('edTabToggleHint');
    win.setSubtitle(`${record.remotePath || record.localPath}${isDirty() ? ' •' : ''}`);
    if (undoBtn) {
      undoBtn.disabled = state.readOnly || history.undo.length === 0;
      redoBtn.disabled = state.readOnly || history.redo.length === 0;
      undoBtn.title = undoBtn.disabled && state.readOnly ? s('edReadOnly') : `${s('edUndo')} (Ctrl+Z)`;
      redoBtn.title = redoBtn.disabled && state.readOnly ? s('edReadOnly') : `${s('edRedo')} (Ctrl+Y)`;
    }
  }

  function isDirty() { return state.text !== state.saved; }

  function setText(next, caret, trackHistory = true) {
    if (next === state.text) return;
    if (trackHistory) {
      history.undo.push({ text: state.text, caret: textarea.selectionStart });
      history.redo.length = 0;
    }
    state.text = next;
    textarea.value = next;
    if (caret != null) textarea.setSelectionRange(caret, caret);
    paintGutter();
    updateStatus();
  }

  function undo() {
    if (state.readOnly || !history.undo.length) return false;
    history.redo.push({ text: state.text, caret: textarea.selectionStart });
    const previous = history.undo.pop();
    setText(previous.text, previous.caret, false);
    refreshHits();
    return true;
  }

  function redo() {
    if (state.readOnly || !history.redo.length) return false;
    history.undo.push({ text: state.text, caret: textarea.selectionStart });
    const next = history.redo.pop();
    setText(next.text, next.caret, false);
    refreshHits();
    return true;
  }

  function selectedText() { return state.text.slice(textarea.selectionStart, textarea.selectionEnd); }
  async function copySelection() {
    const text = selectedText();
    if (!text) return false;
    return copyText(text);
  }
  async function cutSelection() {
    if (state.readOnly) return false;
    const start = textarea.selectionStart, end = textarea.selectionEnd;
    if (start === end || !await copySelection()) return false;
    setText(`${state.text.slice(0, start)}${state.text.slice(end)}`, start);
    return true;
  }
  async function pasteClipboard() {
    if (state.readOnly) return false;
    let text = '';
    try { text = String(await callMain('app.clipboardRead') || ''); }
    catch { try { text = String(await navigator.clipboard.readText() || ''); } catch { text = ''; } }
    if (!text) { notify.info(s('edPaste'), s('edClipboardEmpty')); return false; }
    const start = textarea.selectionStart, end = textarea.selectionEnd;
    setText(`${state.text.slice(0, start)}${text}${state.text.slice(end)}`, start + text.length);
    return true;
  }
  function deleteSelection() {
    if (state.readOnly) return false;
    const start = textarea.selectionStart, end = textarea.selectionEnd;
    if (start === end) return false;
    setText(`${state.text.slice(0, start)}${state.text.slice(end)}`, start);
    return true;
  }

  const onEdit = debounce(() => { paintGutter(); updateStatus(); refreshHits(); }, 40);
  textarea.addEventListener('input', () => {
    if (textarea.value !== state.text) {
      history.undo.push({ text: state.text, caret: textarea.selectionStart });
      history.redo.length = 0;
      state.text = textarea.value;
    }
    onEdit();
  });
  for (const evt of ['click', 'keyup', 'select']) {
    textarea.addEventListener(evt, () => { updateStatus(); refreshHits(); });
  }

  textarea.addEventListener('keydown', (e) => {
    const key = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && key === 's') {
      e.preventDefault();
      save(false);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && key === 'z') {
      e.preventDefault();
      e.shiftKey ? redo() : undo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && key === 'y') {
      e.preventDefault();
      redo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && key === 'g') {
      e.preventDefault();
      goToInput.focus();
      goToInput.select();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && key === 'f') {
      e.preventDefault();
      find.focus();
      return;
    }
    if (e.key === 'F3' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      findNext(e.shiftKey ? -1 : 1);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && key === 'm') {
      e.preventDefault();
      state.tabInserts = !state.tabInserts;
      updateStatus();
      announce(state.tabInserts ? s('edTabInserts') : s('edTabMoves'));
      return;
    }
    if (e.key === 'Tab' && state.tabInserts && !state.readOnly) {
      e.preventDefault();
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const next = `${state.text.slice(0, start)}\t${state.text.slice(end)}`;
      setText(next, start + 1);
    }
  });

  /* ---------------- saving ---------------- */

  let savePromise = null;

  async function save(force) {
    if (state.readOnly) return false;
    if (!isDirty() && !force) { notify.info(t('editorTitle'), s('edNothingToSave')); return false; }
    if (savePromise) return savePromise;
    const snapshot = state.text;
    savePromise = (async () => {
      try {
        const res = await callMain('editor.save', state.id, snapshot, { force: !!force });
        // Text changed while the upload was in flight is still unsaved. Only
        // advance the clean marker when the response belongs to current text.
        if (state.text === snapshot) state.saved = snapshot;
        updateStatus();
        if (res && res.local) notify.success(t('editorTitle'), s('edSavedLocal', record.fileName));
        else if (force) notify.warning(t('editorTitle'), s('edForced', record.fileName, (res && res.bytes) || 0));
        else notify.success(t('editorTitle'), s('edSaved', record.fileName, (res && res.bytes) || 0));
        return true;
      } catch (err) {
        if (err.code === 'REMOTE_CHANGED') { conflict(err.detail); return false; }
        notify.error(t('editorTitle'), s('edSaveFailed', record.fileName, err.message));
        return false;
      } finally {
        savePromise = null;
      }
    })();
    return savePromise;
  }

  /**
   * The remote file moved under us. Every button here does something real:
   * force the upload, reveal the temporary file that already holds the text,
   * or fetch the server's copy so the user has both. Nothing is decided for
   * them, and nothing is lost whichever they pick.
   */
  function conflict(detail) {
    const was = (detail && detail.was) || {};
    const now = (detail && detail.now) || {};
    const stamp = (ms) => (ms ? new Date(Number(ms)).toLocaleString() : '—');
    openModal({
      title: s('edConflictTitle'),
      width: 600,
      content: h('div', { class: 'stack' },
        ...paragraphs('edConflictBody', record.remotePath, was.size ?? '—', stamp(was.mtime), now.size ?? '—', stamp(now.mtime))
          .map((p) => h('p', { class: 'prose', style: { whiteSpace: 'pre-wrap' } }, p))),
      actions: [
        { label: t('cancel'), kind: 'text' },
        {
          label: s('edConflictShowTemp'),
          kind: 'text',
          onSelect: () => { callMain('app.showItemInFolder', record.localPath).catch((e) => notify.error(t('editorTitle'), e.message)); return true; },
        },
        {
          label: s('edConflictFetch'),
          kind: 'text',
          onSelect: async () => {
            try {
              const res = await callMain('fs.readFile', record.sessionId, record.remotePath, {});
              const b64 = typeof res === 'string' ? res : (res && (res.base64 || res.data || res.content));
              if (!b64) throw new Error('The server returned no content for that path.');
              const name = `${record.fileName}.server`;
              downloadBase64(name, b64, 'text/plain');
              notify.success(t('editorTitle'), s('edConflictFetched', record.fileName, name));
            } catch (e) {
              notify.error(t('editorTitle'), e.message);
            }
          },
        },
        { label: s('edConflictForce'), kind: 'danger', onSelect: () => { save(true); } },
      ],
    });
  }

  async function changeEncoding(next) {
    if (isDirty()) {
      encodingSel.value = state.encoding;
      openModal({
        title: s('edEncoding'),
        width: 520,
        content: h('p', { class: 'prose' }, s('edEncodingWarn')),
        actions: [
          { label: t('cancel'), kind: 'text' },
          { label: t('save'), kind: 'filled', onSelect: async () => { if (await save(false)) applyEncoding(next); } },
          { label: t('discard'), kind: 'danger', onSelect: () => applyEncoding(next) },
        ],
      });
      return;
    }
    applyEncoding(next);
  }

  async function applyEncoding(next) {
    try {
      const res = await callMain('editor.setEncoding', state.id, next);
      state.encoding = res.encoding;
      state.encodingDetected = res.encodingDetected;
      state.saved = res.text;
      encodingSel.value = state.encoding;
      history.undo.length = 0;
      history.redo.length = 0;
      setText(res.text, 0, false);
      notify.info(s('edEncoding'), s('edEncodingChanged', (ENCODINGS.find((e) => e.id === state.encoding) || { label: state.encoding }).label));
    } catch (err) {
      encodingSel.value = state.encoding;
      notify.error(s('edEncoding'), err.message);
    }
  }

  function reload() {
    openModal({
      title: s('edReload'),
      width: 520,
      content: h('p', { class: 'prose' }, s('edReloadWarn')),
      actions: [
        { label: t('cancel'), kind: 'text' },
        {
          label: s('edReload'),
          kind: 'danger',
          onSelect: async () => {
            try {
              const res = await callMain('editor.read', state.id);
              state.saved = res.text;
              state.encoding = res.encoding;
              encodingSel.value = state.encoding;
              history.undo.length = 0;
              history.redo.length = 0;
              setText(res.text, 0, false);
            } catch (err) { notify.error(t('editorTitle'), err.message); }
          },
        },
      ],
    });
  }

  /* ---------------- the window ---------------- */

  const saveBtn = h('button', {
    type: 'button', class: 'icon-btn', title: `${t('saveFile')} (Ctrl+S)`, 'aria-label': t('saveFile'),
    onclick: () => save(false),
  }, icon('download', 17));
  // The viewer opens the same window with readOnly set; save() refuses, so the
  // button must refuse visibly rather than looking live and doing nothing.
  if (state.readOnly) { saveBtn.disabled = true; saveBtn.title = s('edReadOnly'); }

  const toolbar = h('div', { class: 'ed-bar' },
    saveBtn,
    undoBtn = h('button', {
      type: 'button', class: 'icon-btn', 'aria-label': s('edUndo'),
      onclick: () => { textarea.focus(); undo(); },
    }, icon('undo', 17)),
    redoBtn = h('button', {
      type: 'button', class: 'icon-btn', 'aria-label': s('edRedo'),
      onclick: () => { textarea.focus(); redo(); },
    }, icon('redo', 17)),
    h('button', {
      type: 'button', class: 'icon-btn', title: s('edReload'), 'aria-label': s('edReload'),
      onclick: () => reload(),
    }, icon('refresh', 17)));

  const optionsBtn = h('button', {
    type: 'button', class: 'icon-btn', title: t('preferences'), 'aria-label': t('preferences'),
  }, icon('tune', 17));
  attachMenuButton(optionsBtn, () => [
    { label: s('edWordWrap'), checked: state.wordWrap, onSelect: () => { wrapBox.checked = !wrapBox.checked; wrapBox.dispatchEvent(new Event('change')); } },
    { label: s('edTabInserts'), checked: state.tabInserts, description: s('edTabToggleHint'), onSelect: () => { state.tabInserts = !state.tabInserts; updateStatus(); } },
    SEPARATOR,
    ...ENCODINGS.map((e) => ({
      label: e.label, radio: true, checked: state.encoding === e.id,
      onSelect: () => changeEncoding(e.id),
    })),
  ], { placement: 'bottom-end', label: t('preferences') });
  toolbar.appendChild(optionsBtn);

  const optionsRow = h('div', { class: 'ed-bar' },
    h('label', { class: 'check' }, wrapBox, h('span', {}, s('edWordWrap'))),
    h('label', { class: 'field inline' }, h('span', { class: 'field-label' }, s('edTabSize')), tabSizeInput),
    // The field carries the visible label; the button beside it is icon-only
    // with the same accessible name, so the words are not printed twice.
    h('label', { class: 'field inline' }, h('span', { class: 'field-label' }, s('edGoTo')), goToInput),
    h('button', {
      type: 'button', class: 'icon-btn', onclick: goToLine,
      title: `${t('goToLine')} (Ctrl+G)`, 'aria-label': t('goToLine'),
    }, icon('chevron_right', 18)),
    h('span', { class: 'spacer' }),
    h('label', { class: 'field inline' }, h('span', { class: 'field-label' }, s('edEncoding')), encodingSel));

  const win = openModelessWindow({
    title: `${record.fileName}${state.readOnly ? ` — ${t('viewerTitle')}` : ''}`,
    subtitle: record.remotePath || record.localPath,
    icon: state.readOnly ? 'visibility' : 'edit',
    width: 900,
    height: 600,
    toolbar,
    appearanceKey: 'editor-window',
    appearanceLabel: 'Editor window',
    content: h('div', { class: 'stack', style: { flex: '1 1 auto', minHeight: 0 } },
      optionsRow, findBar, wrapEl),
    footer: statusEl,
    canClose: () => confirmClose(),
    onClose: () => {
      offEditor();
      unbind();
      find.destroy();
      openEditors.delete(state.id);
      callMain('editor.close', state.id, {}).catch(() => { /* main reports an orphan if the edit never landed */ });
    },
  });

  registerContextMenu(textarea, () => [
    { label: t('findNext'), icon: 'search', shortcut: 'F3', onSelect: () => findNext(1) },
    { label: s('edFindPrev'), icon: 'search', shortcut: 'Shift+F3', onSelect: () => findNext(-1) },
    { label: t('goToLine'), icon: 'numbers', shortcut: 'Ctrl+G', onSelect: () => goToInput.focus() },
    SEPARATOR,
    { label: t('saveFile'), icon: 'download', shortcut: 'Ctrl+S', disabled: state.readOnly, onSelect: () => save(false) },
    { label: s('edReload'), icon: 'refresh', onSelect: () => reload() },
    SEPARATOR,
    { label: t('copyClip'), icon: 'content_copy', onSelect: () => copySelection() },
    { label: s('edCut'), icon: 'content_cut', disabled: state.readOnly, onSelect: () => cutSelection() },
    { label: s('edPaste'), icon: 'content_paste', disabled: state.readOnly, onSelect: () => pasteClipboard() },
    { label: s('edDeleteSelection'), icon: 'backspace', disabled: state.readOnly, onSelect: () => deleteSelection() },
    SEPARATOR,
    { label: s('edSelectAll'), icon: 'select_all', onSelect: () => { textarea.focus(); textarea.select(); updateStatus(); refreshHits(); } },
    { label: s('edUndo'), icon: 'undo', shortcut: 'Ctrl+Z', disabled: state.readOnly || !history.undo.length, onSelect: () => { textarea.focus(); undo(); } },
    { label: s('edRedo'), icon: 'redo', shortcut: 'Ctrl+Y', disabled: state.readOnly || !history.redo.length, onSelect: () => { textarea.focus(); redo(); } },
  ]);

  function confirmClose() {
    if (!isDirty() || state.readOnly) return true;
    return new Promise((resolve) => {
      openModal({
        title: t('unsavedChanges'),
        width: 520,
        content: h('p', { class: 'prose' }, t('unsavedBody', record.fileName)),
        onClose: (reason) => { if (reason === 'scrim' || reason === 'escape') resolve(false); },
        actions: [
          { label: t('cancel'), kind: 'text', onSelect: () => resolve(false) },
          { label: t('discard'), kind: 'danger', onSelect: () => { state.saved = state.text; resolve(true); } },
          {
            label: t('saveAndClose'),
            kind: 'filled',
            autofocus: true,
            onSelect: async () => { resolve(await save(false)); },
          },
        ],
      });
    });
  }

  /* ---------------- events from main ---------------- */

  const offEditor = onMainEvent('event:editor', (e) => {
    if (!e || e.id !== state.id) return;
    if (e.type === 'remote-changed') conflict(e);
    else if (e.type === 'remote-missing') notify.warning(t('editorTitle'), s('edRemoteMissing', record.remotePath));
    else if (e.type === 'uploaded') { state.saved = state.text; updateStatus(); }
    else if (e.type === 'orphan') notify.warning(t('editorTitle'), s('edOrphan', record.fileName, e.localPath));
    else if (e.type === 'error') notify.error(t('editorTitle'), e.message);
    else if (e.type === 'focus') win.focus();
  });

  const onKey = (e) => {
    if (!win.element.contains(document.activeElement)) return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key.toLowerCase() === 's') { e.preventDefault(); save(false); }
    else if (ctrl && e.key.toLowerCase() === 'x') { e.preventDefault(); cutSelection(); }
    else if (ctrl && e.key.toLowerCase() === 'c') { e.preventDefault(); copySelection(); }
    else if (ctrl && e.key.toLowerCase() === 'v') { e.preventDefault(); pasteClipboard(); }
    else if (ctrl && e.key.toLowerCase() === 'a') { e.preventDefault(); textarea.select(); updateStatus(); refreshHits(); }
    else if (ctrl && e.key.toLowerCase() === 'f') { e.preventDefault(); find.focus(); }
    else if (ctrl && e.key.toLowerCase() === 'g') { e.preventDefault(); goToInput.focus(); goToInput.select(); }
    else if (e.key === 'F3') { e.preventDefault(); findNext(e.shiftKey ? -1 : 1); }
  };
  const offKey = on(win.element, 'keydown', onKey);

  const unbind = bindRender(win.element, () => { updateStatus(); });

  paintGutter();
  updateStatus();
  refreshHits();

  const handle = {
    id: state.id,
    element: win.element,
    window: win,
    get text() { return state.text; },
    get dirty() { return isDirty(); },
    save,
    focus: () => win.focus(),
    close: () => win.close('api'),
    destroy: () => { offKey(); win.close('api'); },
  };
  openEditors.set(state.id, handle);
  return handle;
}

/* ================================================================== */
/* opening                                                             */
/* ================================================================== */

/**
 * Materialise a record that the command layer has already opened through the
 * main-process editor manager. `commands.js` deliberately owns the panel-side
 * ExecuteFile decision and emits `editor:opened`; opening the record here keeps
 * that path from downloading the same remote file a second time.
 */
async function openExistingEditor(record, options = {}) {
  if (!record || !record.id) throw new Error('The editor manager returned no editor id.');
  if (record.type === 'external') return null;
  const existing = openEditors.get(record.id);
  if (existing) { existing.focus(); return existing; }
  const pending = pendingEditorWindows.get(record.id);
  if (pending) return pending;

  const promise = (async () => {
    const initial = await callMain('editor.read', record.id);
    if (initial.bytes > MAX_EDIT_BYTES) {
      await callMain('editor.close', record.id, {}).catch(() => {});
      notify.error(t('editorTitle'), s('edTooBig', record.fileName, initial.bytes, MAX_EDIT_BYTES));
      return null;
    }
    if (looksBinary(initial.text)) {
      await callMain('editor.close', record.id, {}).catch(() => {});
      notify.error(t('editorTitle'), t('binaryFile', record.fileName));
      return null;
    }

    let prefs = {};
    try {
      const doc = await api.configGet();
      prefs = ((doc && doc.prefs ? doc.prefs : doc) || {}).editor || {};
    } catch { /* the window's own defaults stand */ }

    return createEditorWindow(record, initial, {
      readOnly: !!options.readOnly,
      wordWrap: prefs.wordWrap !== false,
      tabSize: prefs.tabSize,
      findText: prefs.findText,
      replaceText: prefs.replaceText,
      findMatchCase: prefs.findMatchCase,
      findWholeWord: prefs.findWholeWord,
    });
  })();
  pendingEditorWindows.set(record.id, promise);
  try { return await promise; }
  finally { if (pendingEditorWindows.get(record.id) === promise) pendingEditorWindows.delete(record.id); }
}

/**
 * openEditor({ sessionId, remotePath }) or openEditor({ localPath })
 *
 * Refuses a binary and refuses something too large to hold in memory, both
 * with the reason and both closing the record it opened rather than leaving a
 * temporary file behind for an editor that never appeared.
 */
export async function openEditor(request = {}) {
  ensureStyles();
  const name = request.remotePath || request.localPath || '';
  let record = null;
  try {
    record = await callMain('editor.open', { ...request, mode: 'internal' });
    return await openExistingEditor(record, request);
  } catch (err) {
    if (record) await callMain('editor.close', record.id, {}).catch(() => {});
    notify.error(t('editorTitle'), s('edOpenFailed', name, err.message));
    return null;
  }
}

/**
 * The panel command path has already made the main-process decision and emits
 * this record on the renderer bus. This listener is the missing ExecuteFile
 * hand-off: external editors stay external, while internal/local records get
 * the same modeless window as the explicit editor command.
 */
bus.on('editor:opened', (record) => {
  if (!record || record.type === 'external') return;
  openExistingEditor(record).catch((err) => {
    // A bus-originated open has no caller waiting to perform the normal
    // cleanup, so do not strand its temp file when materialisation fails.
    callMain('editor.close', record.id, {}).catch(() => {});
    notify.error(t('editorTitle'), s('edOpenFailed', record.fileName || record.remotePath || record.localPath || '', err.message));
  });
});

/** Every open editor window, for a "save all" across them. */
export function listEditorWindows() { return Array.from(openEditors.values()); }

export async function saveAllEditors() {
  const dirty = listEditorWindows().filter((e) => e.dirty);
  if (!dirty.length) { notify.info(t('editorTitle'), s('edNothingToSave')); return 0; }
  let n = 0;
  for (const e of dirty) { if (await e.save(false)) n += 1; }
  return n;
}

/* ================================================================== */
/* orphaned temporary files                                            */
/* ================================================================== */

function orphansDialog() {
  const listEl = h('div', { class: 'ed-orphans' }, h('div', { class: 'muted' }, t('refresh')));
  const boxes = new Map();

  async function load() {
    clear(listEl);
    let items = [];
    try { items = await callMain('editor.orphans'); }
    catch (err) { listEl.appendChild(h('div', { class: 'prose' }, err.message)); return; }
    if (!items.length) { listEl.appendChild(h('div', { class: 'prose muted' }, s('edOrphansNone'))); return; }
    for (const item of items) {
      const box = h('input', { type: 'checkbox' });
      boxes.set(item.path, box);
      listEl.appendChild(h('div', { class: 'ed-orphan' },
        box,
        h('div', { class: 'ed-orphan-path', title: item.path }, oneLine(item.path, 90)),
        h('span', { class: 'muted mono' }, s('edBytes', item.size)),
        h('span', { class: 'muted mono' }, new Date(item.mtime).toLocaleString()),
        h('button', {
          type: 'button', class: 'btn-text',
          onclick: () => callMain('app.showItemInFolder', item.path).catch((e) => notify.error(t('editorTitle'), e.message)),
        }, s('edOrphansShow'))));
    }
  }
  load();

  return {
    title: s('edOrphansTitle'),
    width: 680,
    content: h('div', { class: 'stack' }, h('p', { class: 'prose' }, s('edOrphansBody')), listEl),
    actions: [
      { label: t('close'), kind: 'text' },
      {
        label: s('edOrphansDiscard'),
        kind: 'danger',
        onSelect: async () => {
          const chosen = [...boxes.entries()].filter(([, b]) => b.checked).map(([p]) => p);
          if (!chosen.length) { notify.info(s('edOrphansTitle'), t('nothingSelected')); return; }
          try {
            const n = await callMain('editor.discardOrphans', chosen);
            notify.success(s('edOrphansTitle'), s('edOrphansDiscarded', n));
          } catch (err) { notify.error(s('edOrphansTitle'), err.message); }
        },
      },
    ],
  };
}

/* ================================================================== */
/* registration                                                        */
/* ================================================================== */

let installed = false;

export function registerEditorDialog() {
  if (installed) return;
  installed = true;
  ensureStyles();

  registerDialog('editorOrphans', () => orphansDialog());

  registerCommand({
    id: 'editor.open', labelKey: 'editorTitle', icon: 'edit',
    run: (request) => openEditor(request || {}),
  });
  registerCommand({
    id: 'editor.view', labelKey: 'viewerTitle', icon: 'visibility',
    run: (request) => openEditor({ ...(request || {}), readOnly: true }),
  });
  registerCommand({
    id: 'editor.saveAll', labelKey: 'saveAllFiles', icon: 'download',
    run: () => saveAllEditors(),
  });
  registerCommand({
    id: 'editor.orphans', label: s('edOrphansTitle'), icon: 'delete',
    run: () => openDialog('editorOrphans'),
  });
}

if (typeof document !== 'undefined') {
  queueMicrotask(() => {
    try { registerEditorDialog(); } catch (err) { console.error('[editor] registration failed', err); }
  });
}
