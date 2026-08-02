// ui/log.js — the session log panel.
//
// design/main/logging.js keeps a ring buffer per session (prefs.logging
// .logWindowLines lines) and pushes every new line as `event:log`. This panel
// is that ring made readable: a level filter built from the kinds actually
// present, the app's standard search bar with its regex builder, and copy and
// export that carry exactly what is on screen.
//
// Three things it is careful about:
//
//   * REDACTION HAPPENS BEFORE THE LINE ARRIVES. logging.js scrubs passwords,
//     tokens and key material on the way into the ring, so this panel never
//     sees a secret it could leak. It still says plainly, on every export, that
//     a log can contain whatever a command printed — because console output is
//     logged verbatim and the app cannot know what a user pasted into a shell.
//   * LOGGING OFF IS A STATE, NOT AN ERROR. When prefs.logging.enabled is
//     false the panel says so and offers the switch, rather than showing an
//     empty list that looks like a broken feature.
//   * THE RING IS BOUNDED. New lines arrive by event; the panel trims to the
//     same window main uses, so a long transfer cannot grow this window without
//     limit.

import {
  h, icon, clear, uid, appearanceTarget, announce, openModal, copyText, downloadText, debounce,
} from '../dom.js';
import { t, tIn, bindRender, getLanguage, getFunnyLevel } from '../i18n.js';
import { resolveI18n } from '../../winscp-i18n.js';
import { api, bus, session as sessionState } from '../state.js';
import { styleSheet } from '../theme.js';
import { createSearchBar } from './searchbar.js';
import { notify } from './notifications.js';
import { registerContextMenu, SEPARATOR } from './contextmenu.js';
import { exportRangeStatement, isoDate } from './changelog.js';
import { registerDialog, registerCommand, openDialog } from '../app.js';

/* ------------------------------------------------------------------ */
/* module-local strings                                                */
/* ------------------------------------------------------------------ */

const STR = {
  lgTitle: ['Session log', '工作階段記錄'],
  lgSearchPh: ['Search the log', '搜尋記錄'],
  lgSession: ['Session', '工作階段'],
  lgNoSessions: [
    'No session is open, so there is no log to show. Open a session and its log appears here as it happens.',
    '冇開任何工作階段，所以冇記錄可以睇。開個工作階段，佢嘅記錄就會即時喺度出現。'],
  lgDisabled: [
    'Session logging is switched off, so nothing is being recorded. Turning it on starts recording from the next line — it cannot recover what happened before.',
    '記錄功能閂咗，所以而家乜都冇錄到。開返佢係由下一行開始錄——之前發生咗嘅嘢係揾唔返嘅。'],
  lgEnable: ['Switch logging on', '開返記錄'],
  lgLevel: ['Level', '等級'],
  lgLevelSaved: ['Logging level set to {0}.', '記錄等級設做{0}。'],
  lgEnabled: ['Session logging is on. Recording starts from the next line.', '記錄已開。由下一行開始錄。'],
  lgKinds: ['Kinds', '種類'],
  lgAllKinds: ['All kinds', '所有種類'],
  lgShowing: ['{0} of {1} lines', '{1} 行入面顯示緊 {0} 行'],
  lgEmptyRing: [
    'The log is empty for this session. Lines appear here as the session works.',
    '呢個工作階段嘅記錄係空嘅。工作階段做嘢嗰陣就會有行數出現。'],
  lgNoMatch: ['No line matches {0}.', '冇一行符合{0}。'],
  lgFilterKind: ['kinds {0}', '種類 {0}'],
  lgFilterSearch: ['the search {0}', '搜尋 {0}'],
  lgAnd: [' and ', '同埋'],
  lgAutoScroll: ['Follow new lines', '跟住新行'],
  lgClear: ['Clear the window', '清走呢個視窗'],
  lgClearHint: [
    'This clears the in-memory window only. A log file, if one is being written, is untouched.',
    '呢個淨係清走記憶體入面嗰個視窗。如果有寫緊記錄檔，嗰個唔會郁到。'],
  lgCleared: ['The log window was cleared.', '記錄視窗清咗。'],
  lgCopy: ['Copy what is shown', '複製顯示緊嘅內容'],
  lgExport: ['Export what is shown', '匯出顯示緊嘅內容'],
  lgCopied: ['{0} line(s) copied.', '複製咗 {0} 行。'],
  lgCopyFailed: ['The clipboard refused the copy. Nothing was changed.', '剪貼簿唔肯收，冇嘢改動咗。'],
  lgExportTitle: ['Export the session log', '匯出工作階段記錄'],
  lgExportWarn: [
    'A session log records what the session did — and anything a remote command printed, which the app cannot inspect. Read the file before attaching it to a bug report or a forum post.',
    '記錄檔會寫低工作階段做過乜，仲有遠端指令印過乜——嗰啲嘢 app 睇唔明都分唔到。貼上論壇或者報 bug 之前，自己睇一次先。'],
  lgFile: ['Writing to {0}', '寫緊去 {0}'],
  lgNoBridge: [
    'The session log lives in the application’s main process, which this window cannot reach right now.',
    '工作階段記錄喺程式嘅主行程度，呢個視窗而家去唔到嗰邊。'],
  lgUnavailable: ['The log could not be read: {0}', '讀唔到記錄：{0}'],
  kError: ['Errors', '錯誤'],
  kInfo: ['Info', '資訊'],
  kSend: ['Sent', '送出'],
  kRecv: ['Received', '收到'],
  kDebug: ['Debug 1', '除錯 1'],
  kDebug2: ['Debug 2', '除錯 2'],
};

function substitute(text, params) {
  return params.length
    ? String(text).replace(/\{(\d+)\}/g, (m, i) => (params[Number(i)] === undefined ? m : String(params[Number(i)])))
    : String(text);
}

/** One language, looking in this module's strings then the shared dictionary. */
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

/** See the note on `compose` in ui/changelog.js — one language at a time. */
function compose(build) {
  const mode = getLanguage();
  const make = (language) => build((key, ...params) => strIn(language, key, ...params), language);
  if (mode !== 'both') return make(mode);
  const en = make('en');
  const yue = make('yue');
  return en === yue ? en : `${en} · ${yue}`;
}

/** The kinds logging.js writes, with the mark it puts at the head of a line. */
export const LOG_KINDS = [
  { id: 'error', mark: '!', labelKey: 'kError', minLevel: 0 },
  { id: 'info', mark: '.', labelKey: 'kInfo', minLevel: 0 },
  { id: 'send', mark: '>', labelKey: 'kSend', minLevel: 0 },
  { id: 'recv', mark: '<', labelKey: 'kRecv', minLevel: 0 },
  { id: 'debug', mark: '*', labelKey: 'kDebug', minLevel: 1 },
  { id: 'debug2', mark: '*', labelKey: 'kDebug2', minLevel: 2 },
];

const LEVEL_NAMES = ['logNormal', 'logDebug1', 'logDebug2'];

function kindLabel(kind, L = s) {
  const k = LOG_KINDS.find((x) => x.id === kind);
  return k ? L(k.labelKey) : String(kind);
}

/* ------------------------------------------------------------------ */
/* the main-process bridge                                             */
/* ------------------------------------------------------------------ */
// The `api` façade in state.js does not carry the session capabilities yet;
// this goes through its own `raw` handle rather than reaching for window.api,
// and unwraps main's { ok, value } envelope in one place.

async function callMain(path, ...args) {
  const raw = api.raw;
  if (!raw) { const e = new Error(s('lgNoBridge')); e.code = 'NO_BRIDGE'; throw e; }
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

/** Subscribe to a main-process event through the preload allowlist. */
function onMainEvent(name, fn) {
  const raw = api.raw;
  if (!raw || typeof raw.on !== 'function') return () => {};
  try { return raw.on(name, fn) || (() => {}); }
  catch { return () => {}; }
}

/* ------------------------------------------------------------------ */
/* formatting                                                          */
/* ------------------------------------------------------------------ */

function pad(n, w = 2) { return String(n).padStart(w, '0'); }

/** The same stamp logging.js writes to the file, so a copied line matches it. */
export function formatLogLine(rec) {
  const d = new Date(rec.at);
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  return `${rec.mark} ${stamp} ${rec.text}`;
}

/* ------------------------------------------------------------------ */
/* styles                                                              */
/* ------------------------------------------------------------------ */

let stylesWritten = false;
function ensureStyles() {
  if (stylesWritten || typeof document === 'undefined') return;
  stylesWritten = true;
  styleSheet('logpanel').set(`
.lg { display: flex; flex-direction: column; gap: calc(8px * var(--den)); min-height: 0; }
.lg-tools { display: flex; flex-direction: column; gap: calc(8px * var(--den)); }
.lg-row { display: flex; align-items: center; gap: calc(8px * var(--den)); flex-wrap: wrap; }
.lg-kinds { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.lg-kind { display: inline-flex; align-items: center; gap: 5px; min-height: calc(28px * var(--den));
  padding: 0 calc(10px * var(--den)); border-radius: var(--shape-full);
  border: 1px solid var(--outline-var); background: var(--c-lowest); color: var(--onsfc);
  font-size: var(--type-label-sm); }
.lg-kind.is-on { background: var(--secc); color: var(--onsecc); border-color: transparent; font-weight: 600; }
.lg-kind:disabled { opacity: .45; cursor: default; }
.lg-kind-count { font-variant-numeric: tabular-nums; opacity: .8; }
.lg-count { font-size: var(--type-label-md); color: var(--onsv); }
.lg-select { min-height: var(--control-h); border: 1px solid var(--outline);
  border-radius: var(--shape-xs); background: var(--c-lowest); color: var(--onsfc);
  padding: 0 calc(8px * var(--den)); max-width: 34ch; }
.lg-view { background: var(--c-lowest); border: 1px solid var(--outline-var);
  border-radius: var(--shape-md); overflow: auto; min-height: calc(180px * var(--uiscale));
  padding: calc(6px * var(--den)); }
.lg-line { display: grid; grid-template-columns: calc(2ch * var(--uiscale)) auto 1fr;
  gap: calc(8px * var(--den)); font-family: var(--mono); font-size: var(--type-label-md);
  line-height: 1.45; padding: 1px calc(4px * var(--den)); border-radius: var(--shape-xs);
  white-space: pre-wrap; word-break: break-word; }
.lg-line:hover { background: color-mix(in srgb, var(--onsfc) 6%, transparent); }
.lg-mark { font-weight: 700; text-align: center; }
.lg-at { color: var(--onsv); font-variant-numeric: tabular-nums; }
.lg-line[data-kind="error"] { background: color-mix(in srgb, var(--err) 12%, transparent); }
.lg-line[data-kind="error"] .lg-mark { color: var(--err); }
.lg-line[data-kind="send"] .lg-mark { color: var(--p); }
.lg-line[data-kind="recv"] .lg-mark { color: var(--ter); }
.lg-line[data-kind="debug"] .lg-text,
.lg-line[data-kind="debug2"] .lg-text { color: var(--onsv); }
.lg-empty { padding: calc(18px * var(--den)); text-align: center; color: var(--onsv); line-height: 1.55; }
.lg-notice { background: var(--c-low); border-radius: var(--shape-md); padding: calc(10px * var(--den));
  display: flex; align-items: center; gap: calc(10px * var(--den)); flex-wrap: wrap;
  font-size: var(--type-body-sm); line-height: 1.5; }
.lg-notice.is-warn { background: var(--errc); color: var(--onerrc); }
.lg-file { font-size: var(--type-label-sm); color: var(--onsv); }
`);
}

/* ------------------------------------------------------------------ */
/* the panel                                                           */
/* ------------------------------------------------------------------ */

/**
 * createLogPanel({ sessionId }) -> { element, destroy(), refresh() }
 *
 * `sessionId` is optional: with none, the panel offers whatever sessions are
 * open and follows the one the user picks.
 */
export function createLogPanel(opts = {}) {
  ensureStyles();

  let sessions = [];
  let sessionId = opts.sessionId || '';
  let lines = [];
  let lastSeq = 0;
  let fileName = '';
  let windowLines = 800;
  let logging = { enabled: false, level: 0 };
  let loadError = null;
  let follow = true;
  let destroyed = false;
  const excludedKinds = new Set();

  const view = h('div', { class: 'lg-view', role: 'log', tabindex: '0', 'aria-label': s('lgTitle') });
  const count = h('span', { class: 'lg-count', role: 'status' });
  const kindsRow = h('div', { class: 'lg-kinds', role: 'group', 'aria-label': s('lgKinds') });
  const noticeHost = h('div', {});
  const fileNote = h('div', { class: 'lg-file' });

  const sessionSelId = uid('lg-session');
  const sessionSel = h('select', {
    class: 'lg-select', id: sessionSelId,
    onchange: () => { setSession(sessionSel.value); },
  });

  const levelSelId = uid('lg-level');
  const levelSel = h('select', {
    class: 'lg-select', id: levelSelId,
    onchange: async () => {
      const level = Number(levelSel.value);
      try {
        await callMain('config.setPref', 'logging.level', level, `Changed setting logging.level to ${level}`);
        logging.level = level;
        notify.success(s('lgTitle'), compose((L) => L('lgLevelSaved', L(LEVEL_NAMES[level] || 'logNormal'))));
      } catch (err) {
        notify.error(s('lgTitle'), err.message);
        levelSel.value = String(logging.level);
      }
    },
  });
  for (let i = 0; i < 3; i += 1) levelSel.appendChild(h('option', { value: String(i) }, t(LEVEL_NAMES[i])));

  const followBox = h('input', {
    type: 'checkbox', onchange: () => { follow = followBox.checked; if (follow) scrollToEnd(); },
  });
  followBox.checked = true;

  const search = createSearchBar({
    id: opts.searchId || 'session-log',
    persist: opts.persist !== false,
    labelKey: 'search',
    placeholder: s('lgSearchPh'),
    appearanceKey: 'search-log',
    appearanceLabel: 'Session log search',
    sampleProvider: () => lines.slice(-400).map((r) => r.text).join('\n'),
    onChange: render,
  });

  const clearBtn = h('button', {
    type: 'button', class: 'btn-text', title: s('lgClearHint'),
    onclick: () => clearWindow(),
  }, icon('delete', 16), s('lgClear'));

  const copyBtn = h('button', {
    type: 'button', class: 'btn-text', onclick: () => copyShown(),
  }, icon('content_copy', 16), s('lgCopy'));

  const exportBtn = h('button', {
    type: 'button', class: 'btn-text', onclick: () => confirmExport(),
  }, icon('file_download', 16), s('lgExport'));

  const root = h('div', { class: 'lg' },
    h('div', { class: 'lg-tools' },
      h('div', { class: 'lg-row' },
        h('label', { class: 'field-label', for: sessionSelId }, s('lgSession')),
        sessionSel,
        h('label', { class: 'field-label', for: levelSelId }, s('lgLevel')),
        levelSel,
        h('label', { class: 'check' }, followBox, h('span', {}, s('lgAutoScroll')))),
      noticeHost,
      search.element,
      kindsRow,
      h('div', { class: 'lg-row' }, count, h('span', { class: 'spacer' }), clearBtn, copyBtn, exportBtn),
      fileNote),
    view);
  appearanceTarget(root, 'log-panel', 'Session log panel');
  appearanceTarget(view, 'log-view', 'Session log lines');

  registerContextMenu(view, () => [
    { label: s('lgCopy'), icon: 'content_copy', onSelect: () => copyShown() },
    { label: s('lgExport'), icon: 'file_download', onSelect: () => confirmExport() },
    SEPARATOR,
    { label: s('lgClear'), icon: 'delete', danger: true, onSelect: () => clearWindow() },
  ]);

  /* ---------------- filtering ---------------- */

  function kindCounts() {
    const predicate = search.predicate;
    const active = search.isActive && predicate.ok;
    const counts = new Map();
    for (const k of LOG_KINDS) counts.set(k.id, 0);
    for (const r of lines) {
      if (active && !predicate.test(r.text)) continue;
      counts.set(r.kind, (counts.get(r.kind) || 0) + 1);
    }
    return counts;
  }

  function visibleLines() {
    const predicate = search.predicate;
    const active = search.isActive && predicate.ok;
    return lines.filter((r) => {
      if (excludedKinds.has(r.kind)) return false;
      if (active && !predicate.test(r.text)) return false;
      return true;
    });
  }

  /* ---------------- rendering ---------------- */

  function renderKinds() {
    const counts = kindCounts();
    clear(kindsRow);
    for (const k of LOG_KINDS) {
      // A kind above the configured level is never written, so it is shown
      // disabled with the reason rather than silently offering a filter that
      // can only ever match nothing.
      const unreachable = k.minLevel > logging.level;
      const on = !excludedKinds.has(k.id);
      const btn = h('button', {
        type: 'button',
        class: `lg-kind${on ? ' is-on' : ''}`,
        'aria-pressed': String(on),
        disabled: unreachable && counts.get(k.id) === 0,
        title: unreachable
          // A kind above the level is never written, so the tooltip names the
          // level that would produce it rather than leaving a dead filter.
          ? compose((L) => `${L(k.labelKey)} — ${L('logLevel')} ${logging.level}: ${L(LEVEL_NAMES[k.minLevel])}`)
          : s(k.labelKey),
        onclick: () => {
          if (excludedKinds.has(k.id)) excludedKinds.delete(k.id); else excludedKinds.add(k.id);
          render();
        },
      },
      h('span', { class: 'mono' }, k.mark),
      h('span', {}, s(k.labelKey)),
      h('span', { class: 'lg-kind-count' }, String(counts.get(k.id) || 0)));
      appearanceTarget(btn, `log-kind-${k.id}`, `Log filter: ${k.id}`);
      kindsRow.appendChild(btn);
    }
    if (excludedKinds.size) {
      kindsRow.appendChild(h('button', {
        type: 'button', class: 'lg-kind',
        onclick: () => { excludedKinds.clear(); render(); },
      }, s('lgAllKinds')));
    }
  }

  function renderNotice() {
    clear(noticeHost);
    if (loadError) {
      noticeHost.appendChild(h('div', { class: 'lg-notice is-warn' }, icon('error', 18), h('span', {}, s('lgUnavailable', loadError))));
      return;
    }
    if (!sessions.length) {
      noticeHost.appendChild(h('div', { class: 'lg-notice' }, icon('info', 18), h('span', {}, s('lgNoSessions'))));
      return;
    }
    if (!logging.enabled) {
      noticeHost.appendChild(h('div', { class: 'lg-notice is-warn' },
        icon('warning', 18),
        h('span', {}, s('lgDisabled')),
        h('button', {
          type: 'button', class: 'btn-tonal',
          onclick: async () => {
            try {
              await callMain('config.setPref', 'logging.enabled', true, 'Switched session logging on');
              logging.enabled = true;
              notify.success(s('lgTitle'), s('lgEnabled'));
              renderNotice();
            } catch (err) { notify.error(s('lgTitle'), err.message); }
          },
        }, s('lgEnable'))));
    }
  }

  function scrollToEnd() {
    view.scrollTop = view.scrollHeight;
  }

  function render() {
    if (destroyed) return;
    renderKinds();
    renderNotice();
    const shown = visibleLines();
    count.textContent = s('lgShowing', shown.length, lines.length);
    fileNote.textContent = fileName ? s('lgFile', fileName) : '';

    const atEnd = view.scrollHeight - view.scrollTop - view.clientHeight < 24;
    clear(view);

    if (!lines.length) {
      // With no session open the notice above already says why there is
      // nothing here; repeating it inside the view says it twice and answers
      // nothing the reader did not already know.
      if (sessions.length) view.appendChild(h('div', { class: 'lg-empty' }, s('lgEmptyRing')));
      return;
    }
    if (!shown.length) {
      const sentence = compose((L) => {
        const parts = [];
        if (excludedKinds.size) {
          const kept = LOG_KINDS.filter((k) => !excludedKinds.has(k.id)).map((k) => L(k.labelKey));
          parts.push(L('lgFilterKind', kept.length ? kept.join(', ') : L('none')));
        }
        if (search.isActive) parts.push(L('lgFilterSearch', search.predicate.describe));
        return L('lgNoMatch', parts.join(L('lgAnd')) || L('none'));
      });
      view.appendChild(h('div', { class: 'lg-empty' }, sentence));
      return;
    }

    const frag = document.createDocumentFragment();
    for (const r of shown) {
      const d = new Date(r.at);
      frag.appendChild(h('div', { class: 'lg-line', 'data-kind': r.kind },
        // The mark is a single glyph, so the kind it stands for is on the
        // title where a hover or a screen reader can reach it.
        h('span', { class: 'lg-mark', title: kindLabel(r.kind) }, r.mark),
        h('span', { class: 'lg-at' }, `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`),
        h('span', { class: 'lg-text' }, r.text)));
    }
    view.appendChild(frag);
    if (follow || atEnd) scrollToEnd();
  }

  const renderSoon = debounce(render, 60);

  /* ---------------- data ---------------- */

  function trim() {
    const max = Math.max(50, windowLines);
    if (lines.length > max) lines.splice(0, lines.length - max);
  }

  async function loadPrefs() {
    try {
      const doc = await api.configGet();
      const prefs = (doc && doc.prefs ? doc.prefs : doc) || {};
      const lg = prefs.logging || {};
      logging = { enabled: !!lg.enabled, level: Number(lg.level) || 0 };
      windowLines = Number(lg.logWindowLines) || 800;
      levelSel.value = String(logging.level);
    } catch { /* the panel's defaults stand; the notice says what it knows */ }
  }

  function renderSessionOptions() {
    clear(sessionSel);
    for (const info of sessions) {
      const label = `${info.name || info.hostName || info.id}${info.connected ? '' : ' — ' + t('notConnected')}`;
      sessionSel.appendChild(h('option', { value: info.id }, label));
    }
    if (!sessions.length) sessionSel.appendChild(h('option', { value: '' }, t('none')));
    sessionSel.value = sessionId;
    sessionSel.disabled = sessions.length <= 1;
  }

  async function loadLines(reset) {
    if (!sessionId) { lines = []; lastSeq = 0; fileName = ''; render(); return; }
    try {
      const res = await callMain('session.log', sessionId, reset ? 0 : lastSeq);
      const incoming = (res && res.lines) || [];
      fileName = (res && res.fileName) || '';
      if (reset) { lines = incoming.slice(); }
      else for (const rec of incoming) lines.push(rec);
      for (const rec of incoming) if (rec.seq > lastSeq) lastSeq = rec.seq;
      trim();
      loadError = null;
    } catch (err) {
      loadError = err.message;
    }
    render();
  }

  async function setSession(id) {
    sessionId = id || '';
    lastSeq = 0;
    lines = [];
    sessionState.set('logPanelSession', sessionId);
    await loadLines(true);
  }

  async function refresh() {
    try {
      const list = await callMain('session.list');
      sessions = Array.isArray(list) ? list : [];
      loadError = null;
    } catch (err) {
      sessions = [];
      loadError = err.message;
    }
    if (!sessions.some((x) => x.id === sessionId)) sessionId = sessions[0] ? sessions[0].id : '';
    renderSessionOptions();
    await loadPrefs();
    await loadLines(true);
  }

  /* ---------------- operations ---------------- */

  async function clearWindow() {
    try {
      if (sessionId) await callMain('session.logClear', sessionId);
      lines = [];
      lastSeq = 0;
      render();
      notify.info(s('lgTitle'), compose((L) => `${L('lgCleared')} ${L('lgClearHint')}`));
      announce(s('lgCleared'));
    } catch (err) {
      notify.error(s('lgTitle'), err.message);
    }
  }

  function statementFor(shown) {
    const info = sessions.find((x) => x.id === sessionId);
    return exportRangeStatement({
      scope: `WinSCP Material — session log${info ? ` (${info.name || info.hostName})` : ''}`,
      range: shown.length ? { from: shown[0].at, to: shown[shown.length - 1].at } : {},
      search: search.isActive ? search.predicate.describe : '',
      actions: LOG_KINDS.filter((k) => !excludedKinds.has(k.id)).map((k) => k.id),
      shown: shown.length,
      total: lines.length,
    });
  }

  function shownAsText(shown) {
    return [
      statementFor(shown).split('\n').map((l) => `# ${l}`).join('\n'),
      '',
      ...shown.map(formatLogLine),
    ].join('\r\n');
  }

  async function copyShown() {
    const shown = visibleLines();
    const ok = await copyText(shownAsText(shown));
    if (ok) notify.success(s('lgTitle'), s('lgCopied', shown.length));
    else notify.error(s('lgTitle'), s('lgCopyFailed'));
  }

  function confirmExport() {
    const shown = visibleLines();
    openModal({
      title: s('lgExportTitle'),
      width: 600,
      content: h('div', { class: 'stack' },
        h('p', { class: 'prose' }, s('lgExportWarn')),
        h('pre', { class: 'mono', style: { whiteSpace: 'pre-wrap', margin: 0 } }, statementFor(shown))),
      actions: [
        { label: t('cancel'), kind: 'text' },
        {
          label: t('export_'),
          kind: 'filled',
          autofocus: true,
          onSelect: () => {
            const name = `winscp-material-session-${isoDate(Date.now())}.log`;
            downloadText(name, shownAsText(shown), 'text/plain');
            notify.success(s('lgTitle'), t('logExported'));
          },
        },
      ],
    });
  }

  /* ---------------- wiring ---------------- */

  const offLog = onMainEvent('event:log', (payload) => {
    if (!payload || payload.sessionId !== sessionId || !payload.line) return;
    lines.push(payload.line);
    if (payload.line.seq > lastSeq) lastSeq = payload.line.seq;
    trim();
    renderSoon();
  });
  const offSession = onMainEvent('event:session', () => { refresh(); });
  const offConfig = bus.on('config:document', () => { loadPrefs().then(render); });

  const unbind = bindRender(root, render);
  refresh();

  return {
    element: root,
    refresh,
    setSession,
    get lines() { return visibleLines(); },
    destroy() {
      destroyed = true;
      offLog();
      offSession();
      offConfig();
      unbind();
      search.destroy();
      root.remove();
    },
  };
}

/* ------------------------------------------------------------------ */
/* registration                                                        */
/* ------------------------------------------------------------------ */

let installed = false;

export function registerLogPanel() {
  if (installed) return;
  installed = true;
  ensureStyles();

  registerDialog('sessionLog', ({ props }) => {
    const panel = createLogPanel({ sessionId: props && props.sessionId });
    return {
      title: s('lgTitle'),
      width: 900,
      content: panel.element,
      onClose: () => panel.destroy(),
      actions: [{ label: t('close'), kind: 'filled', autofocus: true }],
    };
  });

  registerCommand({
    id: 'session.log',
    labelKey: 'logWindow',
    icon: 'receipt_long',
    run: (sessionId) => openDialog('sessionLog', { sessionId }),
  });
}

export function openLogPanel(sessionId) {
  registerLogPanel();
  return openDialog('sessionLog', { sessionId });
}

if (typeof document !== 'undefined') {
  queueMicrotask(() => {
    try { registerLogPanel(); } catch (err) { console.error('[log] registration failed', err); }
  });
}
