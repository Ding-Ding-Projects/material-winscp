// ui/queue.js — the transfer queue panel and the shared transfer vocabulary.
//
// This module is the hub of the transfer surface. It owns three things:
//
//   1. the pure transfer arithmetic — byte/speed/clock formatting, ETA, the
//      throughput series and the OVERWRITE DECISION MATRIX. All of it is free
//      of DOM and of window.api so `test/dialogs-transfer.test.js` can run it
//      headlessly, and so the sentence the UI shows the user ("what will
//      happen") is produced by the same code that decides what happens.
//   2. the live queue model, which mirrors design/main/queue.js across the
//      preload bridge and answers its overwrite queries.
//   3. the queue panel itself — toolbar, list, per-item controls, reordering,
//      speed limits, the file list and the "once empty" action.
//
// Importing this module registers the whole transfer surface (the queue view,
// its commands, its status chip and the six dialogs under ui/dialogs/), so an
// application entry point only needs `import './ui/queue.js'`.
//
// A note on the import cycle: the dialogs import the pure helpers from here and
// this module imports the dialogs so one import wires everything. That cycle is
// safe because neither side CALLS the other at module-evaluation time — every
// use is inside a function body, and function declarations are hoisted through
// an ES module cycle. Do not move a top-level `const` from here into a dialog's
// module-eval path or the cycle stops being benign.

import {
  h, icon, clear, uid, appearanceTarget, announce, openModal, rovingFocus, copyText,
  layer, anchorTo, focusMemory,
} from '../dom.js';
import { bus, api, session } from '../state.js';
import { t, bindText, bindRender, defineStrings } from '../i18n.js';
import { styleSheet } from '../theme.js';
import { notify } from './notifications.js';
import { createSearchBar, filterBy, noMatchMessage } from './searchbar.js';
import { registerContextMenu, attachMenuButton, SEPARATOR } from './contextmenu.js';
import {
  registerView, registerCommand, registerStatusItem, registerTitlebarAction, refreshStatus,
} from '../app.js';

// Imported for their registration side effects; see the cycle note above.
import './dialogs/progress.js';
import './dialogs/synchronize.js';
import './dialogs/checklist.js';
import { openAuthenticationDialog } from './dialogs/authenticate.js';
import './dialogs/messagedlg.js';
import './dialogs/fileysteminfo.js';

/* ================================================================== */
/* strings                                                             */
/* ================================================================== */

/**
 * Merge extra dictionary entries without ever overwriting one that already
 * exists. design/winscp-i18n.js stays the canonical dictionary; this is how a
 * module that owns a surface the dictionary has no words for still gets all
 * three language modes and both funny-level sliders instead of hard-coding an
 * English literal. Keys carry a `tx` prefix so two modules cannot collide.
 */
export { defineStrings };

defineStrings({
  // ---- queue states and columns ----
  txStateQueued: ['Queued', '排緊隊'],
  txStateActive: ['Transferring', '傳緊'],
  txStatePaused: ['Suspended', '暫停咗'],
  txStateDone: ['Completed', '完成'],
  txStateError: ['Failed', '失敗'],
  txStateQuery: ['Waiting for your answer', '等緊你答'],
  txStatePrompt: ['Waiting for credentials', '等緊憑證'],
  txSideUpload: ['Upload', '上載'],
  txSideDownload: ['Download', '下載'],
  txSideRemoteCopy: ['Copy on the server', '喺伺服器度複製'],
  txColOperation: ['Operation', '操作'],
  txColSource: ['Source', '來源'],
  txColTarget: ['Destination', '目的地'],
  txColProgress: ['Progress', '進度'],
  txColTransferred: ['Transferred', '已傳輸'],
  txColSpeed: ['Speed', '速度'],
  txColTimeLeft: ['Time left', '剩餘時間'],
  txColFiles: ['Files', '檔案'],

  // ---- queue actions ----
  txMoveUp: ['Move up (process earlier)', '調上（早啲做）'],
  txMoveDown: ['Move down (process later)', '調落（遲啲做）'],
  txExecuteNow: ['Execute now', '即刻做'],
  txShowQuery: ['Show the pending query', '睇下佢問緊乜'],
  txShowError: ['Show the error', '睇錯誤'],
  txCancelItem: ['Cancel this transfer', '取消呢單傳輸'],
  txSpeedLimitFor: ['Speed limit for this transfer', '呢單傳輸嘅速度上限'],
  txUnlimited: ['Unlimited', '冇上限'],
  txQueueLimit: ['Maximum simultaneous transfers', '同時最多幾多單傳輸'],
  txFileList: ['File list', '檔案清單'],
  txQueueToolbarOpt: ['Queue toolbar', '佇列工具列'],
  txOnceEmptyNone: ['Stay idle', '乜都唔做'],
  txOnceEmptyDisconnect: ['Disconnect the session', '斷開連線'],
  txOnceEmptySuspend: ['Sleep the computer', '電腦瞓覺'],
  txOnceEmptyShutdown: ['Shut down the computer', '熄電腦'],
  txPowerUnsupported: ['This build has no privileged power-management path, so it cannot sleep or shut the machine down. "Stay idle" and "Disconnect the session" both work.', '呢個版本冇權限做電源管理，所以瞓機同熄機都做唔到。「乜都唔做」同「斷開連線」就一定得。'],
  txQueueSearchPh: ['Search the queue', '搵佇列'],
  txQueueScope: ['the transfer queue', '傳輸佇列'],
  txQueueUnavailable: [[
    'The transfer engine is not reachable from this window, so the queue cannot be shown or controlled.',
    'The transfer engine is not reachable from this window; the queue cannot be shown or controlled.',
    'No line to the transfer engine from this window — the queue cannot be shown or controlled.',
    'This window cannot reach the transfer engine, so the queue is neither visible nor controllable from here.',
    'This window and the transfer engine are not on speaking terms, so the queue is neither visible nor controllable from here.'], [
    '呢個視窗連唔到傳輸引擎，所以睇唔到又控制唔到個佇列。',
    '呢個視窗連唔到傳輸引擎，佇列睇唔到又控制唔到。',
    '呢個視窗同傳輸引擎斷咗線——佇列睇唔到又控制唔到。',
    '呢個視窗接觸唔到傳輸引擎，所以佇列喺呢度睇唔到又郁唔到。',
    '呢個視窗同傳輸引擎而家唔傾偈，所以佇列喺呢度睇唔到又郁唔到。']],
  txQueueSummary: ['{0} transferring · {1} queued · {2} done · {3} failed', '{0} 個傳緊 · {1} 個排緊隊 · {2} 個完成 · {3} 個失敗'],
  txSkippedN: ['{0} file(s) skipped', '跳咗 {0} 個檔案'],
  txCurrentFile: ['Current file', '而家嘅檔案'],
  txQueueCancelAllTitle: ['Cancel every queued transfer', '取消晒所有排隊傳輸'],
  txQueueCancelAllBody: [[
    '{0} transfer(s) will be cancelled. Files that were only partly written are left as they are.',
    'Cancelling {0} transfer(s). Partly written files are left as they are.',
    '{0} transfer(s) get the chop. Half-written files stay exactly as they are.',
    '{0} transfer(s) are about to stop mid-stride, and any half-written file stays half-written.',
    '{0} transfer(s) are about to be yanked off the conveyor belt — and every half-written file stays exactly that half-written.'], [
    '會取消 {0} 單傳輸。寫咗一半嘅檔案會照留喺度。',
    '取消緊 {0} 單傳輸。寫咗一半嘅檔案照留。',
    '{0} 單傳輸即刻斬。寫咗一半嘅檔案原封不動咁留低。',
    '{0} 單傳輸就快中途停低，寫咗一半嘅檔案就咁一半咁留住。',
    '{0} 單傳輸就快俾人由輸送帶度扯落嚟——寫咗一半嘅檔案就永遠停喺一半嗰度。']],
  txQueueCleared: ['{0} completed transfer(s) removed from the list.', '由清單度移走咗 {0} 單已完成傳輸。'],
  txQueueNoneDone: ['Nothing in the queue has finished yet, so there is nothing to clear.', '佇列度未有嘢做完，所以冇嘢好清。'],
  txQueueEnabled: ['The queue processes transfers.', '佇列會處理傳輸。'],
  txQueueDisabled: ['The queue is holding every transfer.', '佇列而家扣住所有傳輸。'],
  txDisconnectedOnEmpty: ['The queue emptied, so {0} session(s) were disconnected as configured.', '佇列清空咗，所以照設定斷開咗 {0} 個連線。'],

  // ---- overwrite query ----
  txOvSource: ['Source file', '來源檔案'],
  txOvTarget: ['Target file — it already exists', '目標檔案——已經喺度'],
  txOvNewer: ['The source is newer', '來源新啲'],
  txOvOlder: ['The source is older', '來源舊啲'],
  txOvSameTime: ['Both files have the same modification time', '兩個檔案嘅修改時間一樣'],
  txOvUnknownTime: ['One of the two files has no modification time', '有一個檔案冇修改時間'],
  txOvSizeBigger: ['The source is larger', '來源大啲'],
  txOvSizeSmaller: ['The source is smaller', '來源細啲'],
  txOvSizeSame: ['Both files are the same size', '兩個檔案一樣大'],
  txOvChoose: ['Choose what happens to this file', '揀呢個檔案點處理'],
  txOvOverwriteDesc: ['Replace the target with the source. The target file as it is now is lost.', '用來源蓋過目標。目標檔案而家嘅內容會冇咗。'],
  txOvResumeDesc: ['Continue the target from where it stops and read the source from the same offset.', '喺目標停低嗰個位繼續，來源都由同一個位開始讀。'],
  txOvAppendDesc: ['Add the whole source onto the end of the target. The target keeps everything it has.', '將成個來源接喺目標後面。目標原本嘅嘢全部保留。'],
  txOvSkipDesc: ['Leave the target alone and move on to the next file.', '唔郁目標，直接跳去下一個檔案。'],
  txOvRenameDesc: ['Write the source under a different name, so both files survive.', '用另一個名寫入來源，兩個檔案都留得住。'],
  txOvOverwriteAllDesc: ['Replace this file and every remaining file in this transfer, without asking again.', '呢個同埋呢單傳輸剩低嘅檔案全部蓋過，唔會再問。'],
  txOvSkipAllDesc: ['Leave this file and every remaining existing file in this transfer alone.', '呢個同埋呢單傳輸剩低已存在嘅檔案全部唔郁。'],
  txOvNewerOnlyDesc: ['From now on transfer a file only when the source is more than 2 seconds newer than the target.', '由而家開始，淨係當來源比目標新超過 2 秒先傳。'],
  txOvNewName: ['New file name', '新檔案名'],
  txOvRenameApply: ['Write under this name', '用呢個名寫入'],
  txOvDisabledResume: ['One of the two ends cannot restart a transfer from an offset, so resuming is not possible here.', '兩邊有一邊唔支援由中途續傳，所以呢度續傳唔到。'],
  txOvDisabledAppend: ['This transfer cannot append to the target.', '呢單傳輸唔可以接落目標後面。'],
  txOvDisabledNewer: ['One of the two files has no modification time, so "newer only" has nothing to compare.', '有一個檔案冇修改時間，所以「淨新版」冇嘢好比。'],
  txOvWillTransfer: ['"{0}" will be written to {1}.', '「{0}」會寫入 {1}。'],
  txOvWillSkip: ['"{0}" will be left exactly as it is.', '「{0}」會原封不動咁留低。'],
  txOvWillSkipNotNewer: ['"{0}" will be left alone because the source is not newer than it.', '「{0}」會留低，因為來源冇佢新。'],
  txOvWillRename: ['The source will be written as "{0}" beside the existing file.', '來源會用「{0}」呢個名寫喺原本個檔案隔籬。'],
  txOvStickyAll: ['This answer also applies to every remaining file in this transfer.', '呢個答案會同時套用落呢單傳輸剩低嘅所有檔案。'],
  txOvRenameNeedsName: ['Enter a new file name first.', '要先入個新檔名。'],
  txOvRenameSameName: ['That is the name that already exists. Pick a different one.', '呢個就係已經存在嗰個名，揀第個啦。'],
  txOvRenameBadChars: ['A file name cannot contain any of {0}.', '檔案名唔可以有 {0} 呢啲字。'],
  txOvAnswered: ['Answered "{0}" for {1}.', '幫 {1} 答咗「{0}」。'],
  txOvUnknownAnswer: ['"{0}" is not an answer this transfer understands.', '「{0}」唔係呢單傳輸識得嘅答案。'],
});

/* ================================================================== */
/* pure arithmetic — no DOM, no bridge, no i18n                        */
/* ================================================================== */

const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];

/** Group thousands without Intl, so a formatted size never depends on locale. */
export function groupDigits(n) {
  const s = String(Math.trunc(Math.abs(n)));
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ' ';
    out += s[i];
  }
  return (n < 0 ? '-' : '') + out;
}

/**
 * formatBytes(1536) -> '1.50 KiB'.
 * style: 'short' (default, scaled unit) | 'bytes' | 'kilo', mirroring WinSCP's
 * "Show file sizes in" preference (formatSizeBytes).
 */
export function formatBytes(bytes, style = 'short') {
  const n = Number(bytes);
  if (!Number.isFinite(n)) return '—';
  if (style === 'bytes') return `${groupDigits(n)} B`;
  if (style === 'kilo') return `${groupDigits(Math.round(n / 1024))} KiB`;
  let v = Math.abs(n);
  let i = 0;
  while (v >= 1024 && i < UNITS.length - 1) { v /= 1024; i += 1; }
  const digits = i === 0 ? 0 : v >= 100 ? 0 : v >= 10 ? 1 : 2;
  return `${n < 0 ? '-' : ''}${v.toFixed(digits)} ${UNITS[i]}`;
}

/** Bytes per second, formatted the way the queue's Speed column shows it. */
export function formatSpeed(bytesPerSecond) {
  const n = Number(bytesPerSecond);
  if (!Number.isFinite(n) || n <= 0) return '0 B/s';
  return `${formatBytes(n)}/s`;
}

/**
 * Seconds as WinSCP's HH:MM:SS (D.HH:MM:SS past a day). An unknown duration is
 * '--:--:--' rather than '00:00:00', because "unknown" and "none left" are
 * genuinely different states and a user reads the second one as "finishing now".
 */
export function formatClock(seconds) {
  // null is "not known yet" and must not fall through Number(null) === 0 into
  // an answer that reads as "finishing right now".
  if (seconds === null || seconds === undefined || seconds === '') return '--:--:--';
  const n = Number(seconds);
  if (!Number.isFinite(n) || n < 0) return '--:--:--';
  const s = Math.floor(n);
  const days = Math.floor(s / 86400);
  const pad = (v) => String(v).padStart(2, '0');
  const body = `${pad(Math.floor((s % 86400) / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
  return days ? `${days}.${body}` : body;
}

/**
 * Seconds remaining, or null when it cannot be known yet.
 *
 * Returns 0 only once a KNOWN total has been reached — a real answer, "no time
 * left". A total of zero means the engine has not finished planning the
 * transfer, and reporting that as 00:00:00 would tell a user a queued item is
 * about to finish; it is null, which renders as --:--:--.
 */
export function etaSeconds(totalBytes, doneBytes, bytesPerSecond) {
  const total = Number(totalBytes);
  const done = Number(doneBytes);
  const cps = Number(bytesPerSecond);
  if (!Number.isFinite(total) || !Number.isFinite(done) || total <= 0) return null;
  const left = total - done;
  if (left <= 0) return 0;
  if (!Number.isFinite(cps) || cps <= 0) return null;
  return Math.round(left / cps);
}

/** formatEta(null) -> '--:--:--'; formatEta(90) -> '00:01:30'. */
export function formatEta(seconds) { return formatClock(seconds); }

/** 0..1 from bytes, clamped, and 0 rather than NaN when the total is unknown. */
export function progressFraction(doneBytes, totalBytes) {
  const total = Number(totalBytes);
  const done = Number(doneBytes);
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(done)) return 0;
  return Math.min(1, Math.max(0, done / total));
}

export function formatPercent(fraction) {
  const f = Number(fraction);
  if (!Number.isFinite(f)) return '0%';
  return `${Math.round(Math.min(1, Math.max(0, f)) * 100)}%`;
}

/* ---- throughput series (the progress dialog's graph) ---- */

export const THROUGHPUT_WINDOW_MS = 60000;

/**
 * Append a sample and drop everything older than the window. Pure: it returns a
 * new array rather than mutating, so a caller can keep a snapshot for a redraw
 * while the next sample arrives.
 */
export function pushThroughput(series, cps, nowMs, windowMs = THROUGHPUT_WINDOW_MS) {
  const list = Array.isArray(series) ? series : [];
  const at = Number(nowMs);
  const value = Number(cps);
  const next = list.concat([{ at, cps: Number.isFinite(value) && value > 0 ? value : 0 }]);
  const cutoff = at - windowMs;
  return next.filter((s) => s.at >= cutoff);
}

/** Peak of a throughput series, or 0 for an empty one. */
export function throughputPeak(series) {
  let peak = 0;
  for (const s of series || []) if (Number.isFinite(s.cps) && s.cps > peak) peak = s.cps;
  return peak;
}

/** Mean of a throughput series, 0 for an empty one. */
export function throughputAverage(series) {
  const list = (series || []).filter((s) => Number.isFinite(s.cps));
  if (!list.length) return 0;
  return list.reduce((a, s) => a + s.cps, 0) / list.length;
}

const r2 = (v) => Math.round(v * 100) / 100;

/**
 * An SVG path for a sparkline of `values` inside width x height. Deterministic
 * to two decimals so it can be asserted in a test, and empty for no data rather
 * than a path that draws a misleading flat line at zero.
 */
export function sparklinePath(values, width, height, max) {
  const list = (values || []).map(Number).filter((v) => Number.isFinite(v));
  if (!list.length) return '';
  const peak = Math.max(Number(max) || 0, ...list, 1);
  const stepX = list.length > 1 ? width / (list.length - 1) : 0;
  return list
    .map((v, i) => `${i ? 'L' : 'M'}${r2(i * stepX)},${r2(height - (v / peak) * height)}`)
    .join(' ');
}

/* ================================================================== */
/* the overwrite decision matrix                                       */
/* ================================================================== */

/** The eight answers design/main/queue.js accepts. Order is the dialog order. */
export const OVERWRITE_ANSWERS = [
  'overwrite', 'resume', 'append', 'skip', 'rename', 'overwrite-all', 'skip-all', 'newer-only',
];

/**
 * The queue treats a source as "newer" only when it is more than this far ahead
 * of the target — the FAT-precision window WinSCP uses, and the exact constant
 * design/main/queue.js compares against (`mtime <= existing.mtime + 1999`).
 * Duplicated here deliberately: it is what makes the dialog's promise and the
 * engine's behaviour the same statement rather than two that drift apart.
 */
export const NEWER_TOLERANCE_MS = 1999;

/** Characters a file name may never contain. The Windows set applies locally. */
export const PATH_SEPARATORS = '/\\';
export const LOCAL_INVALID_CHARS = '/\\:*?"<>|';

/**
 * true / false / null when one of the two timestamps is missing.
 * Null is a real answer: "newer only" cannot be decided without both.
 */
export function sourceIsNewer(sourceMtime, targetMtime) {
  const s = Number(sourceMtime) || 0;
  const d = Number(targetMtime) || 0;
  if (!s || !d) return null;
  return s > d + NEWER_TOLERANCE_MS;
}

/**
 * Which of the eight answers this query actually allows, and why not.
 * Returns [{ answer, enabled, reasonKey }] — machine-readable so the caller
 * translates, and so a test can assert the matrix without a language mode.
 */
export function overwriteOptions(query = {}) {
  const src = query.source || {};
  const dst = query.target || {};
  const timesKnown = !!(Number(src.mtime) && Number(dst.mtime));
  return OVERWRITE_ANSWERS.map((answer) => {
    if (answer === 'resume' && !query.canResume) {
      return { answer, enabled: false, reasonKey: 'txOvDisabledResume' };
    }
    if (answer === 'append' && query.canAppend === false) {
      return { answer, enabled: false, reasonKey: 'txOvDisabledAppend' };
    }
    if (answer === 'newer-only' && !timesKnown) {
      return { answer, enabled: false, reasonKey: 'txOvDisabledNewer' };
    }
    return { answer, enabled: true, reasonKey: '' };
  });
}

/** Validate a proposed replacement name for the 'rename' answer. */
export function validateOverwriteName(query = {}, newName) {
  const name = String(newName ?? '').trim();
  if (!name) return { ok: false, errorKey: 'txOvRenameNeedsName', params: [] };
  const existing = basenameOf(query.target?.path || query.file || '');
  if (name === existing) return { ok: false, errorKey: 'txOvRenameSameName', params: [] };
  const forbidden = query.toLocal ? LOCAL_INVALID_CHARS : PATH_SEPARATORS;
  for (const ch of name) {
    if (forbidden.includes(ch) || ch.codePointAt(0) < 32) {
      return { ok: false, errorKey: 'txOvRenameBadChars', params: [forbidden.split('').join(' ')] };
    }
  }
  return { ok: true, name };
}

/** The last path segment, for either separator. */
export function basenameOf(p) {
  const s = String(p ?? '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i < 0 ? s : s.slice(i + 1);
}

/**
 * A path rendered so the FILE NAME is never what gets ellipsised.
 *
 * A transfer UI truncating "…/Temp/claude/C--Users-…" tells the user nothing;
 * the last segment is the part they are looking for. The directory shrinks
 * twenty times faster than the name, and the full path is on the title, so
 * nothing is actually lost.
 */
export function pathCell(fullPath, extraClass = '') {
  const p = String(fullPath ?? '');
  const base = basenameOf(p);
  const dir = base && p.endsWith(base) ? p.slice(0, p.length - base.length) : '';
  return h('span', { class: `tx-path ${extraClass}`.trim(), title: p || '—' },
    dir ? h('span', { class: 'tx-path-dir' }, dir) : null,
    h('span', { class: 'tx-path-base' }, base || p || '—'));
}

/** Everything before the last path segment, keeping the original separator. */
export function dirnameOf(p) {
  const s = String(p ?? '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  if (i < 0) return '';
  return i === 0 ? s.slice(0, 1) : s.slice(0, i);
}

/**
 * What an answer actually does — the single source of truth for both the
 * sentence the dialog shows and the arguments it sends to queue:answerQuery.
 *
 * Returns:
 *   { valid, errorKey, errorParams,
 *     action: 'transfer' | 'skip',
 *     mode:   'overwrite' | 'resume' | 'append' | null,
 *     sticky: null | 'overwrite-all' | 'skip-all' | 'newer-only',
 *     targetPath, newName }
 *
 * Every branch mirrors design/main/queue.js `_transferFile`. When that switch
 * changes, this must change with it or the dialog starts lying.
 */
export function overwriteOutcome(query = {}, answer, options = {}) {
  const src = query.source || {};
  const dst = query.target || {};
  const targetPath = dst.path || query.file || '';
  const invalid = (errorKey, params = []) => ({
    valid: false, errorKey, errorParams: params,
    action: null, mode: null, sticky: null, targetPath, newName: null,
  });

  if (!OVERWRITE_ANSWERS.includes(answer)) return invalid('txOvUnknownAnswer', [String(answer)]);

  const allowed = overwriteOptions(query).find((o) => o.answer === answer);
  if (allowed && !allowed.enabled) return invalid(allowed.reasonKey);

  const ok = (patch) => ({
    valid: true, errorKey: '', errorParams: [],
    action: 'transfer', mode: 'overwrite', sticky: null, targetPath, newName: null, ...patch,
  });

  switch (answer) {
    case 'skip':
      return ok({ action: 'skip', mode: null });
    case 'skip-all':
      return ok({ action: 'skip', mode: null, sticky: 'skip-all' });
    case 'overwrite-all':
      return ok({ sticky: 'overwrite-all' });
    case 'newer-only': {
      const newer = sourceIsNewer(src.mtime, dst.mtime);
      // main sets _newerOnly and then applies it to THIS file too.
      return ok({ action: newer ? 'transfer' : 'skip', mode: newer ? 'overwrite' : null, sticky: 'newer-only' });
    }
    case 'resume':
      return ok({ mode: 'resume' });
    case 'append':
      return ok({ mode: 'append' });
    case 'rename': {
      const check = validateOverwriteName(query, options.newName);
      if (!check.ok) return invalid(check.errorKey, check.params);
      const dir = dirnameOf(targetPath);
      const sep = targetPath.includes('\\') && !targetPath.includes('/') ? '\\' : '/';
      const joined = dir ? `${dir === sep ? '' : dir}${sep}${check.name}` : check.name;
      return ok({ targetPath: joined, newName: check.name });
    }
    default:
      return ok();
  }
}

/**
 * The sentence the dialog puts under the buttons: an i18n key plus parameters,
 * derived from the outcome above so it can never describe something else.
 */
export function describeOverwriteOutcome(query = {}, answer, options = {}) {
  const outcome = overwriteOutcome(query, answer, options);
  if (!outcome.valid) return { key: outcome.errorKey, params: outcome.errorParams, outcome };
  const name = basenameOf(outcome.targetPath);
  if (answer === 'rename') return { key: 'txOvWillRename', params: [outcome.newName], outcome };
  if (outcome.action === 'skip') {
    return {
      key: answer === 'newer-only' ? 'txOvWillSkipNotNewer' : 'txOvWillSkip',
      params: [name],
      outcome,
    };
  }
  return { key: 'txOvWillTransfer', params: [basenameOf(query.source?.path || ''), name], outcome };
}

/** How the two files compare, as keys the dialog turns into a plain sentence. */
export function compareOverwriteFiles(query = {}) {
  const src = query.source || {};
  const dst = query.target || {};
  const newer = sourceIsNewer(src.mtime, dst.mtime);
  const sSize = Number(src.size) || 0;
  const dSize = Number(dst.size) || 0;
  let timeKey = 'txOvUnknownTime';
  if (newer === true) timeKey = 'txOvNewer';
  else if (newer === false) {
    timeKey = Math.abs((Number(src.mtime) || 0) - (Number(dst.mtime) || 0)) <= NEWER_TOLERANCE_MS
      ? 'txOvSameTime' : 'txOvOlder';
  }
  const sizeKey = sSize === dSize ? 'txOvSizeSame' : sSize > dSize ? 'txOvSizeBigger' : 'txOvSizeSmaller';
  return { timeKey, sizeKey, sourceIsNewer: newer };
}

/* ---- speed limits ---- */

/** WinSCP's speed combo, in bytes per second. 0 is "unlimited". */
export const SPEED_PRESETS = [0, 8192, 16384, 32768, 65536, 131072, 262144, 524288, 1048576, 2097152];

/** Parse "512", "512 KB/s", "1.5 MiB/s" into bytes/s; null when unparseable. */
export function parseSpeedLimit(text) {
  const s = String(text ?? '').trim().toLowerCase();
  if (!s) return 0;
  const m = /^([0-9]+(?:[.,][0-9]+)?)\s*(b|k|kb|kib|m|mb|mib|g|gb|gib)?(\/s)?$/.exec(s);
  if (!m) return null;
  const value = Number(m[1].replace(',', '.'));
  if (!Number.isFinite(value) || value < 0) return null;
  const unit = m[2] || 'k';                 // a bare number is KB/s, as in WinSCP
  const factor = unit === 'b' ? 1
    : unit.startsWith('k') ? 1024
      : unit.startsWith('m') ? 1024 * 1024
        : 1024 * 1024 * 1024;
  return Math.round(value * factor);
}

/** The label for a speed limit; 0 is the "unlimited" key, not "0 B/s". */
export function formatSpeedLimit(bytesPerSecond) {
  const n = Number(bytesPerSecond);
  if (!Number.isFinite(n) || n <= 0) return null;      // caller renders txUnlimited
  return `${formatBytes(n)}/s`;
}

/* ================================================================== */
/* the bridge to main                                                  */
/* ================================================================== */
//
// state.js's `api` façade is the right home for these, but it is owned by
// another module and several agents are editing this tree at once. This is the
// same contract in one place: unwrap main's envelope into value-or-throw, and
// report "unavailable" honestly instead of pretending a call landed.

function unwrap(res) {
  if (res == null) return null;
  if (typeof res === 'object' && 'ok' in res) {
    if (res.ok) return res.value;
    const e = res.error;
    const err = new Error((e && e.message) || String(e) || 'The transfer engine refused the call.');
    if (e && e.code) err.code = e.code;
    throw err;
  }
  return res;
}

/** The raw preload bridge, or null when this window has none. */
export function bridge() {
  return typeof window !== 'undefined' && window.api ? window.api : null;
}

/** True when the transfer engine cannot be reached from this window. */
export function transferEngineAvailable() { return !!bridge()?.queue; }

async function callQueue(method, ...args) {
  const b = bridge();
  if (!b?.queue?.[method]) {
    const err = new Error(t('txQueueUnavailable'));
    err.code = 'NO_BRIDGE';
    throw err;
  }
  return unwrap(await b.queue[method](...args));
}

/** Subscribe to a main-process event, tolerating a window with no bridge. */
export function onMainEvent(event, handler) {
  const b = bridge();
  if (typeof b?.on !== 'function') return () => {};
  try { return b.on(event, handler) || (() => {}); } catch { return () => {}; }
}

/* ---- application preferences the transfer surface reads and writes ---- */
//
// These are REAL preferences in design/main/defaults.js (`queue.*`,
// `copyParam.*`, `confirmOverwriting`), not a private renderer store: changing
// `queue.transfersLimit` here also calls queue:setLimit, so the setting changes
// behaviour rather than only persisting. With no bridge the value is kept in
// the session mirror and the UI says so instead of pretending it was written.

let prefsDoc = null;
let prefsLoaded = false;

function getDotted(obj, dotted) {
  let cur = obj;
  for (const seg of String(dotted).split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[seg];
  }
  return cur;
}

function setDotted(obj, dotted, value) {
  if (!obj || typeof obj !== 'object') return;
  const segs = String(dotted).split('.');
  let cur = obj;
  for (let i = 0; i < segs.length - 1; i += 1) {
    if (typeof cur[segs[i]] !== 'object' || cur[segs[i]] === null) cur[segs[i]] = {};
    cur = cur[segs[i]];
  }
  cur[segs[segs.length - 1]] = value;
}

bus.on('config:document', (doc) => { prefsDoc = (doc && doc.prefs) || doc || null; prefsLoaded = true; });

/** Load the preference document once, for a module that starts after boot. */
export async function loadTransferPrefs() {
  if (prefsLoaded) return prefsDoc;
  prefsLoaded = true;
  try {
    const doc = await api.configGet();
    prefsDoc = (doc && doc.prefs) || doc || null;
  } catch { prefsDoc = null; }
  return prefsDoc;
}

/** Read a dotted preference, falling back to the session mirror then a default. */
export function transferPref(dotted, fallback) {
  const fromDoc = getDotted(prefsDoc, dotted);
  if (fromDoc !== undefined) return fromDoc;
  const local = session.get(`pref:${dotted}`);
  return local === undefined ? fallback : local;
}

/** Write a dotted preference. Resolves false when it was kept locally only. */
export async function setTransferPref(dotted, value, label) {
  session.set(`pref:${dotted}`, value);
  setDotted(prefsDoc, dotted, value);
  const b = bridge();
  if (!b?.config?.setPref) return false;
  try {
    unwrap(await b.config.setPref(dotted, value, label || `Changed ${dotted}`));
    return true;
  } catch (err) {
    notify.error(t('preferences'), err.message);
    return false;
  }
}

/* ================================================================== */
/* the live queue model                                               */
/* ================================================================== */

const REST_STATES = new Set(['done', 'error']);

/**
 * A mirror of the main-process queue.
 *
 * It refreshes from `queue:list` rather than trusting the event stream alone,
 * because ipc.js forwards only some of the queue's events: `item-added`,
 * `item-done`, `item-error`, `idle` and `reconnect` arrive, while an ordinary
 * state change does not. Polling while anything is unfinished is what keeps the
 * panel truthful; the events make it prompt.
 */
function createQueueModel() {
  const items = new Map();                 // id -> view
  const subscribers = new Set();
  const throughput = new Map();            // id -> series, for the progress graph
  let queueState = { enabled: true, paused: false };
  let timer = 0;
  let started = false;
  let lastError = null;

  function snapshot() {
    return {
      items: Array.from(items.values()),
      queue: { ...queueState },
      available: transferEngineAvailable(),
      error: lastError,
    };
  }

  function emit() {
    const snap = snapshot();
    for (const fn of Array.from(subscribers)) {
      try { fn(snap); } catch (err) { console.error('[queue] subscriber failed', err); }
    }
    bus.emit('queue:changed', snap);
  }

  function busy() {
    for (const it of items.values()) if (!REST_STATES.has(it.state)) return true;
    return false;
  }

  async function refresh() {
    if (!transferEngineAvailable()) { lastError = null; emit(); return; }
    try {
      const list = await callQueue('list');
      const seen = new Set();
      for (const view of list || []) {
        seen.add(view.id);
        const prev = items.get(view.id);
        items.set(view.id, prev ? { ...prev, ...view } : view);
      }
      for (const id of Array.from(items.keys())) if (!seen.has(id)) { items.delete(id); throughput.delete(id); }
      lastError = null;
    } catch (err) {
      lastError = err.message;
    }
    emit();
  }

  function schedule() {
    clearTimeout(timer);
    if (!subscribers.size) return;
    // A short beat while work is in flight; a lazy one when the list is at rest,
    // so an item added from a menu still shows up without a busy poll loop.
    timer = setTimeout(() => { refresh().finally(schedule); }, busy() ? 700 : 3000);
  }

  function applyProgress(payload) {
    const p = payload?.item || payload;
    if (!p?.id) return;
    const prev = items.get(p.id);
    if (!prev) { refresh(); return; }
    const merged = { ...prev, progress: { ...prev.progress, ...(p.progress || {}) } };
    if (p.state) merged.state = p.state;
    items.set(p.id, merged);
    const cps = Number(merged.progress?.cps) || 0;
    throughput.set(p.id, pushThroughput(throughput.get(p.id) || [], cps, Date.now()));
    emit();
  }

  function start() {
    if (started) return;
    started = true;
    onMainEvent('event:queue', (payload) => {
      if (payload?.type === 'idle') handleIdle(payload);
      // WinSCP's queue.autoPopup: the progress window comes up by itself when
      // an item starts moving, so a transfer the user started is visible
      // without hunting for it. Off by default, exactly as WinSCP ships it.
      if (payload?.type === 'item-added' && transferPref('queue.autoPopup', false)) {
        const id = payload.item && payload.item.id;
        if (id) bus.emit('queue:openProgress', { id });
      }
      refresh();
    });
    onMainEvent('event:progress', (payload) => {
      if (payload?.kind === 'transfer') applyProgress(payload);
    });
    onMainEvent('event:prompt', (payload) => {
      const q = normalizeQueueQuery(payload);
      if (q) { pendingQueries.set(q.itemId, q.query); openOverwriteDialog(q); return; }
      const p = normalizeQueuePrompt(payload);
      if (p) {
        pendingPrompts.set(p.itemId, p.prompt);
        // queue.autoPopupPrompts: bring the progress window forward alongside
        // the credential prompt, so the answer is given in the context of the
        // transfer that asked for it.
        if (transferPref('queue.autoPopupPrompts', false)) bus.emit('queue:openProgress', { id: p.itemId });
        openQueueCredentialPrompt(p);
      }
    });
    refresh();
  }

  return {
    start,
    get snapshot() { return snapshot(); },
    get available() { return transferEngineAvailable(); },
    item(id) { return items.get(id) || null; },
    throughputFor(id) { return (throughput.get(id) || []).slice(); },
    counts() {
      const c = { active: 0, queued: 0, paused: 0, done: 0, error: 0, waiting: 0, total: items.size };
      for (const it of items.values()) {
        if (it.state === 'query' || it.state === 'prompt') c.waiting += 1;
        else if (c[it.state] !== undefined) c[it.state] += 1;
      }
      return c;
    },
    refresh,
    subscribe(fn) {
      subscribers.add(fn);
      start();
      try { fn(snapshot()); } catch (err) { console.error(err); }
      schedule();
      return () => { subscribers.delete(fn); if (!subscribers.size) clearTimeout(timer); };
    },
    setQueueState(patch) { queueState = { ...queueState, ...patch }; emit(); },

    // ---- commands, each one a real call into the engine ----
    async pauseItem(id) { await callQueue('pause', id); await refresh(); },
    async resumeItem(id) { await callQueue('resume', id); await refresh(); },
    async pauseAll() { await callQueue('pause'); queueState = { ...queueState, paused: true }; await refresh(); },
    async resumeAll() { await callQueue('resume'); queueState = { ...queueState, paused: false }; await refresh(); },
    async cancel(id) { await callQueue('cancel', id); await refresh(); },
    async move(id, delta) { await callQueue('move', id, delta); await refresh(); },
    async clearDone() { const n = await callQueue('clear'); await refresh(); return n; },
    async setEnabled(on) { await callQueue('setEnabled', !!on); queueState = { ...queueState, enabled: !!on }; await refresh(); },
    async setLimit(n) { await callQueue('setLimit', n); await refresh(); },
    async setSpeed(id, bps) { await callQueue('setSpeed', id, bps); await refresh(); },
    async answerQuery(id, answer, options) { await callQueue('answerQuery', id, answer, options); await refresh(); },
    async answerPrompt(id, value) { await callQueue('answerPrompt', id, value); await refresh(); },
    async add(request) { const added = await callQueue('add', request); await refresh(); return added; },
  };
}

export const queueModel = createQueueModel();

/**
 * Pull the item id and the overwrite query out of an `event:prompt` payload.
 *
 * design/main/ipc.js forwards the queue's query with
 * `q.on('query', (id, query) => …)` while design/main/queue.js emits ONE
 * argument (`{ item, query, respond }`), so on the wire `promptId` is that
 * whole object and `payload.query` is undefined. Both shapes are read here: the
 * one the code intends and the one it currently produces. Returns null for any
 * prompt that is not a queue overwrite query.
 */
export function normalizeQueueQuery(payload) {
  if (!payload) return null;
  const direct = payload.payload?.query;
  const bundled = payload.promptId && typeof payload.promptId === 'object' ? payload.promptId : null;
  const query = direct || bundled?.query || null;
  if (!query || query.kind !== 'overwrite') return null;
  const itemId = bundled?.item?.id
    || (typeof payload.promptId === 'string' ? payload.promptId : null)
    || payload.payload?.item?.id
    || null;
  if (!itemId) return null;
  return { itemId, query };
}

/**
 * The same normalisation for a CREDENTIAL the queue asked for mid-transfer
 * (design/main/queue.js `_prompt`). ipc.js forwards it as
 * `{ promptId, kind: 'password', payload: { source: 'queue', prompt } }` with
 * the same single-argument mismatch, so both shapes are read here too.
 */
export function normalizeQueuePrompt(payload) {
  if (!payload) return null;
  const bundled = payload.promptId && typeof payload.promptId === 'object' ? payload.promptId : null;
  const isQueue = payload.payload?.source === 'queue' || !!bundled?.prompt;
  if (!isQueue) return null;
  const prompt = payload.payload?.prompt || bundled?.prompt || null;
  if (!prompt) return null;
  const itemId = bundled?.item?.id
    || (typeof payload.promptId === 'string' ? payload.promptId : null)
    || payload.payload?.item?.id
    || null;
  if (!itemId) return null;
  return { itemId, prompt };
}

/** Queries and prompts still waiting, so "Show query" can reopen them. */
const pendingQueries = new Map();
const pendingPrompts = new Map();

export function pendingQueryFor(itemId) { return pendingQueries.get(itemId) || null; }
export function pendingPromptFor(itemId) { return pendingPrompts.get(itemId) || null; }

/* ================================================================== */
/* the overwrite modal — a genuine decision, so a genuine modal        */
/* ================================================================== */

const openOverwrites = new Set();

/**
 * "The target file exists" — the one place in the transfer surface that is
 * allowed to block, because the user must choose before the byte stream can
 * continue. Everything else in this module is a toast.
 */
export function openOverwriteDialog({ itemId, query, onAnswer } = {}) {
  if (!query) return null;
  const dedupe = `${itemId}:${query.file || query.target?.path || ''}`;
  if (openOverwrites.has(dedupe)) return null;
  openOverwrites.add(dedupe);
  injectTransferStyles();

  const options = overwriteOptions(query);
  const comparison = compareOverwriteFiles(query);
  let renaming = false;
  let handle = null;

  const outcomeLine = h('p', { class: 'tx-ov-outcome', role: 'status', 'aria-live': 'polite' });
  const renameError = h('p', { class: 'tx-ov-error', role: 'alert', hidden: true });
  const renameInput = h('input', {
    type: 'text', class: 'field-input', id: uid('tx-ov-name'), spellcheck: 'false', autocomplete: 'off',
    oninput: () => paintRename(),
  });
  renameInput.value = basenameOf(query.target?.path || query.file || '');

  const renameRow = h('div', { class: 'tx-ov-rename', hidden: true },
    h('label', { class: 'field' },
      h('span', { class: 'field-label' }, t('txOvNewName')),
      renameInput),
    h('button', {
      type: 'button', class: 'btn-filled',
      onclick: () => answer('rename', { newName: renameInput.value.trim() }),
    }, t('txOvRenameApply')));
  renameInput.setAttribute('aria-describedby', renameError.id || (renameError.id = uid('tx-ov-err')));

  function paintRename() {
    const d = describeOverwriteOutcome(query, 'rename', { newName: renameInput.value.trim() });
    const bad = !d.outcome.valid;
    renameError.hidden = !bad;
    renameError.textContent = bad ? t(d.key, ...(d.params || [])) : '';
    renameInput.setAttribute('aria-invalid', String(bad));
    outcomeLine.textContent = bad ? '' : t(d.key, ...(d.params || []));
  }

  function answer(name, opts) {
    const outcome = overwriteOutcome(query, name, opts);
    if (!outcome.valid) {
      // Never send an answer the engine would reject; say what is wrong instead.
      renameError.hidden = false;
      renameError.textContent = t(outcome.errorKey, ...(outcome.errorParams || []));
      return;
    }
    const payload = name === 'rename' ? { newName: outcome.newName } : undefined;
    const deliver = onAnswer
      ? Promise.resolve(onAnswer(name, payload, outcome))
      : queueModel.answerQuery(itemId, name, payload);
    pendingQueries.delete(itemId);
    Promise.resolve(deliver)
      .then(() => {
        announce(t('txOvAnswered', t(answerLabelKey(name)), basenameOf(outcome.targetPath)));
      })
      .catch((err) => notify.error(t('overwriteTitle'), err.message));
    handle?.close();
  }

  const choices = h('div', { class: 'tx-ov-choices', role: 'group', 'aria-label': t('txOvChoose') });
  for (const opt of options) {
    const desc = t(descKeyFor(opt.answer));
    const btn = h('button', {
      type: 'button',
      class: `tx-ov-choice${opt.answer === 'overwrite' ? ' is-primary' : ''}${opt.answer.endsWith('-all') || opt.answer === 'newer-only' ? ' is-sticky' : ''}`,
      onclick: () => {
        if (opt.answer === 'rename') { renaming = true; renameRow.hidden = false; renameInput.focus(); renameInput.select(); paintRename(); return; }
        answer(opt.answer);
      },
      onmouseenter: () => previewOutcome(opt.answer),
      onfocus: () => previewOutcome(opt.answer),
    },
    h('span', { class: 'tx-ov-choice-title' }, t(answerLabelKey(opt.answer))),
    h('span', { class: 'tx-ov-choice-desc' }, opt.enabled ? desc : t(opt.reasonKey)));
    if (!opt.enabled) { btn.disabled = true; btn.title = t(opt.reasonKey); }
    appearanceTarget(btn, `tx-overwrite-${opt.answer}`, `Overwrite answer: ${opt.answer}`);
    choices.appendChild(btn);
  }
  rovingFocus(choices, '.tx-ov-choice', { orientation: 'both' });

  function previewOutcome(name) {
    if (name === 'rename') { paintRename(); return; }
    const d = describeOverwriteOutcome(query, name);
    const sticky = d.outcome.valid && d.outcome.sticky ? ` ${t('txOvStickyAll')}` : '';
    outcomeLine.textContent = `${t(d.key, ...(d.params || []))}${sticky}`;
  }
  previewOutcome('overwrite');

  // The statement of consequence sits directly under the heading, ABOVE the
  // eight buttons, so it is on screen while a choice is being considered rather
  // than below a grid the user has to scroll past.
  const body = h('div', { class: 'tx-ov stack' },
    fileFacts(t('txOvSource'), query.source || {}, 'upload'),
    fileFacts(t('txOvTarget'), query.target || { path: query.file }, 'dns'),
    h('p', { class: 'tx-ov-compare' },
      icon('info', 15),
      h('span', {}, `${t(comparison.timeKey)}. ${t(comparison.sizeKey)}.`)),
    h('h3', { class: 'tx-ov-heading' }, t('txOvChoose')),
    outcomeLine,
    choices,
    renameRow,
    renameError);

  handle = openModal({
    title: t('overwriteTitle'),
    width: 640,
    dismissOnScrim: false,
    content: body,
    onClose: () => { openOverwrites.delete(dedupe); void renaming; },
    actions: [
      { label: t('skip_'), kind: 'text', onSelect: () => { answer('skip'); return true; } },
    ],
  });
  return handle;
}

/**
 * A credential the QUEUE asked for while a transfer was running — a passphrase
 * for a key it had to reload, a password after a reconnect. It uses the same
 * authentication dialog as a session prompt, but the answer goes back through
 * queue:answerPrompt rather than session:answerPrompt, which is why the dialog
 * takes an `onAnswer` override.
 */
export function openQueueCredentialPrompt({ itemId, prompt }) {
  return openAuthenticationDialog({
    promptId: `queue:${itemId}`,
    kind: prompt?.kind && prompt.kind !== 'password' ? prompt.kind : 'password',
    payload: {
      name: prompt?.name || '',
      instructions: prompt?.instructions || '',
      prompts: prompt?.prompts || [{ text: prompt?.text || 'Password:', echo: false }],
      userName: prompt?.userName || '',
      hostPort: prompt?.hostPort || '',
      canRemember: false,
    },
    onAnswer: async (answer) => {
      pendingPrompts.delete(itemId);
      // A refusal is a refusal: an empty string is what the engine reads as
      // "the user declined", and nothing is invented on their behalf.
      await queueModel.answerPrompt(itemId, answer?.results?.[0] ?? '');
    },
  });
}

function answerLabelKey(answer) {
  switch (answer) {
    case 'overwrite': return 'overwrite';
    case 'overwrite-all': return 'overwriteAll';
    case 'skip': return 'skip_';
    case 'skip-all': return 'skipAll';
    case 'newer-only': return 'newerOnlyBtn';
    case 'resume': return 'resume';
    case 'append': return 'txAppendBtn';
    case 'rename': return 'rename';
    default: return answer;
  }
}
defineStrings({ txAppendBtn: ['Append', '接落後面'] });

function descKeyFor(answer) {
  return {
    overwrite: 'txOvOverwriteDesc',
    resume: 'txOvResumeDesc',
    append: 'txOvAppendDesc',
    skip: 'txOvSkipDesc',
    rename: 'txOvRenameDesc',
    'overwrite-all': 'txOvOverwriteAllDesc',
    'skip-all': 'txOvSkipAllDesc',
    'newer-only': 'txOvNewerOnlyDesc',
  }[answer] || 'txOvOverwriteDesc';
}

/** Both files' facts, side by side: path, size and modification time. */
function fileFacts(title, file, glyph) {
  const when = Number(file?.mtime) ? new Date(Number(file.mtime)).toLocaleString() : '—';
  return h('div', { class: 'tx-ov-file' },
    h('div', { class: 'tx-ov-file-head' }, icon(glyph, 16), h('span', {}, title)),
    h('div', { class: 'tx-ov-file-path mono', title: file?.path || '' }, file?.path || '—'),
    h('div', { class: 'tx-ov-file-meta' },
      h('span', {}, `${t('colSize')}: ${formatBytes(file?.size || 0)}`),
      h('span', {}, `${t('colChanged')}: ${when}`)));
}

/* ================================================================== */
/* the queue panel                                                     */
/* ================================================================== */

const ONCE_EMPTY = [
  { value: 'none', labelKey: 'txOnceEmptyNone', supported: true },
  { value: 'disconnect', labelKey: 'txOnceEmptyDisconnect', supported: true },
  { value: 'suspend', labelKey: 'txOnceEmptySuspend', supported: false },
  { value: 'shutdown', labelKey: 'txOnceEmptyShutdown', supported: false },
];

function stateKey(state) {
  return {
    queued: 'txStateQueued', active: 'txStateActive', paused: 'txStatePaused',
    done: 'txStateDone', error: 'txStateError', query: 'txStateQuery', prompt: 'txStatePrompt',
  }[state] || 'txStateQueued';
}

function stateIcon(state) {
  return {
    queued: 'pending', active: 'swap_vert', paused: 'pending', done: 'check_circle',
    error: 'error', query: 'help', prompt: 'key',
  }[state] || 'pending';
}

function sideKey(side) {
  return side === 'download' ? 'txSideDownload' : side === 'remote-copy' ? 'txSideRemoteCopy' : 'txSideUpload';
}

/**
 * createQueuePanel() -> { element, destroy }
 *
 * The panel is the same component whether it is docked in a view or floated in
 * a popover, so there is exactly one implementation of "what the queue looks
 * like" to keep correct.
 */
export function createQueuePanel(opts = {}) {
  injectTransferStyles();

  const listEl = h('div', { class: 'tx-q-list', role: 'list' });
  // One tab stop for the whole list, arrows to move between transfers, and
  // Right/Left to step into and out of a row's own buttons.
  const rowRoving = rovingFocus(listEl, '.tx-q-row', { orientation: 'vertical', loop: false });
  const emptyEl = h('div', { class: 'tx-q-empty' });
  const summaryEl = h('span', { class: 'tx-q-summary mono' });
  let showFileList = !!transferPref('queue.fileList', false);
  let snapshot = queueModel.snapshot;
  let selectedId = null;

  // The preference document may not have reached this window yet; when it does,
  // the toolbar re-reads it rather than staying on the defaults it started with.
  loadTransferPrefs().then(() => {
    showFileList = !!transferPref('queue.fileList', false);
    limitInput.value = String(transferPref('queue.transfersLimit', 2));
    render();
  });

  const search = createSearchBar({
    id: 'transfer-queue',
    labelKey: 'txQueueSearchPh',
    placeholderKey: 'txQueueSearchPh',
    compact: true,
    appearanceKey: 'search-transfer-queue',
    appearanceLabel: 'Transfer queue search',
    sampleProvider: () => snapshot.items.map((i) => `${i.source}\n${i.target}`).join('\n'),
    onChange: render,
  });

  /* ---- toolbar ---- */

  const toolbarButton = (glyph, labelKey, onSelect, extra = {}) => {
    const btn = h('button', { type: 'button', class: 'icon-btn tx-q-tool', onclick: onSelect, ...extra }, icon(glyph, 18));
    bindText(btn, labelKey, { attr: 'aria-label' });
    bindText(btn, labelKey, { attr: 'title' });
    appearanceTarget(btn, `queue-tool-${labelKey}`, `Queue toolbar: ${labelKey}`);
    return btn;
  };

  const guard = (fn) => () => {
    Promise.resolve()
      .then(fn)
      .catch((err) => notify.error(t('queueTitle'), err.message));
  };

  const processBtn = h('button', { type: 'button', class: 'tx-q-toggle', onclick: guard(toggleProcessing) });
  appearanceTarget(processBtn, 'queue-process-toggle', 'Process queue toggle');

  const limitInput = h('input', {
    type: 'number', min: '1', max: '32', step: '1', class: 'field-input tx-q-limit',
    id: uid('tx-q-limit'),
    onchange: guard(async () => {
      const n = Math.max(1, Math.min(32, Number(limitInput.value) || 1));
      limitInput.value = String(n);
      // The engine takes it now; the preference keeps it for the next launch.
      await queueModel.setLimit(n);
      await setTransferPref('queue.transfersLimit', n, 'Changed the simultaneous transfer limit');
    }),
  });
  limitInput.value = String(transferPref('queue.transfersLimit', 2));
  const limitLabel = h('label', { class: 'field inline tx-q-limitwrap', for: limitInput.id },
    h('span', { class: 'field-label' }, t('txQueueLimit')), limitInput);
  bindRender(limitLabel, () => { limitLabel.firstChild.textContent = t('txQueueLimit'); });

  const onceEmptyBtn = h('button', { type: 'button', class: 'tx-q-once' });
  appearanceTarget(onceEmptyBtn, 'queue-once-empty', 'Queue once-empty action');
  attachMenuButton(onceEmptyBtn, () => ONCE_EMPTY.map((o) => ({
    label: t(o.labelKey),
    checked: onceEmptyValue() === o.value,
    radio: true,
    disabled: !o.supported,
    description: o.supported ? '' : t('txPowerUnsupported'),
    onSelect: () => setOnceEmpty(o.value),
  })), { placement: 'bottom-start' });

  const toolbar = h('div', { class: 'tx-q-toolbar', role: 'toolbar', 'aria-label': t('queueTitle') },
    processBtn,
    toolbarButton('pending', 'suspendAll', guard(() => queueModel.pauseAll())),
    toolbarButton('sync_alt', 'resumeAll', guard(() => queueModel.resumeAll())),
    toolbarButton('delete', 'cancelAll', () => confirmCancelAll()),
    toolbarButton('done_all', 'deleteCompleted', guard(clearCompleted)),
    h('span', { class: 'tx-q-sep' }),
    onceEmptyBtn,
    limitLabel,
    h('span', { class: 'spacer' }),
    summaryEl,
    h('div', { class: 'tx-q-searchwrap' }, search.element));
  appearanceTarget(toolbar, 'queue-toolbar', 'Queue toolbar');

  const root = h('div', { class: 'tx-q' }, toolbar, listEl, emptyEl);
  appearanceTarget(root, 'queue-panel', 'Transfer queue panel');

  /* ---- commands the toolbar and the menu share ---- */

  function onceEmptyValue() { return transferPref('queue.onceEmpty', 'none') || 'none'; }

  function setOnceEmpty(value) {
    const entry = ONCE_EMPTY.find((o) => o.value === value);
    if (!entry || !entry.supported) {
      // Refusing beats storing a setting that would silently do nothing.
      notify.warning(t('queueOnceEmpty'), t('txPowerUnsupported'));
      return;
    }
    setTransferPref('queue.onceEmpty', value, 'Changed the once-empty queue action').then(paintToolbar);
    paintToolbar();
  }

  async function toggleProcessing() {
    const enabled = !snapshot.queue.enabled;
    await queueModel.setEnabled(enabled);
    notify.info(t('processQueue'), enabled ? t('txQueueEnabled') : t('txQueueDisabled'));
  }

  async function clearCompleted() {
    const n = await queueModel.clearDone();
    if (n) notify.success(t('deleteCompleted'), t('txQueueCleared', n));
    else notify.info(t('deleteCompleted'), t('txQueueNoneDone'));
  }

  function confirmCancelAll() {
    const live = snapshot.items.filter((i) => !REST_STATES.has(i.state));
    if (!live.length) { notify.info(t('cancelAll'), t('queueEmpty')); return; }
    openModal({
      title: t('txQueueCancelAllTitle'),
      width: 480,
      content: h('p', { class: 'prose' }, t('txQueueCancelAllBody', live.length)),
      actions: [
        { label: t('cancel'), kind: 'text' },
        {
          label: t('cancelAll'),
          kind: 'danger',
          autofocus: true,
          onSelect: () => {
            Promise.all(live.map((i) => queueModel.cancel(i.id)))
              .then(() => notify.success(t('cancelAll'), t('txQueueCancelAllBody', live.length)))
              .catch((err) => notify.error(t('cancelAll'), err.message));
          },
        },
      ],
    });
  }

  /* ---- rendering ---- */

  function paintToolbar() {
    const enabled = snapshot.queue.enabled !== false;
    clear(processBtn);
    processBtn.append(icon(enabled ? 'check_circle' : 'pending', 16), h('span', {}, t('processQueue')));
    processBtn.setAttribute('aria-pressed', String(enabled));
    processBtn.classList.toggle('is-on', enabled);
    processBtn.title = enabled ? t('txQueueEnabled') : t('txQueueDisabled');

    const once = ONCE_EMPTY.find((o) => o.value === onceEmptyValue()) || ONCE_EMPTY[0];
    clear(onceEmptyBtn);
    onceEmptyBtn.append(icon('playlist', 15), h('span', {}, `${t('queueOnceEmpty')}: ${t(once.labelKey)}`));
    onceEmptyBtn.title = `${t('queueOnceEmpty')}: ${t(once.labelKey)}`;

    const c = queueModel.counts();
    const text = t('txQueueSummary', c.active, c.queued + c.paused, c.done, c.error);
    summaryEl.textContent = text;
    summaryEl.title = text;
  }

  function itemRow(item) {
    const p = item.progress || {};
    const fraction = progressFraction(p.bytes, p.total);
    const eta = Number.isFinite(p.eta) ? p.eta : etaSeconds(p.total, p.bytes, p.cps);

    const bar = h('div', {
      class: 'tx-q-bar', role: 'progressbar',
      'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(fraction * 100)),
      'aria-label': `${t('progress')} ${formatPercent(fraction)}`,
    }, h('div', { class: 'tx-q-bar-fill', style: { width: `${(fraction * 100).toFixed(1)}%` } }));

    const row = h('div', {
      class: `tx-q-row is-${item.state}${selectedId === item.id ? ' is-selected' : ''}`,
      role: 'listitem',
      tabindex: '-1',
      'data-queue-id': item.id,
      onclick: () => { selectedId = item.id; render(); },
      ondblclick: () => bus.emit('queue:openProgress', { id: item.id }),
      onkeydown: (e) => onRowKey(e, item),
    },
    h('span', { class: 'tx-q-state', title: t(stateKey(item.state)) },
      icon(stateIcon(item.state), 17),
      h('span', { class: 'sr-only' }, t(stateKey(item.state)))),
    h('div', { class: 'tx-q-main' },
      // Source and target each get a full row. Sharing one line squeezes both
      // into a few characters, and a transfer row whose two paths are both
      // truncated tells the user nothing about what is moving where.
      h('div', { class: 'tx-q-paths' },
        h('span', { class: 'tx-q-op' }, t(sideKey(item.side))),
        pathCell(item.source, 'tx-q-path')),
      h('div', { class: 'tx-q-paths' },
        h('span', { class: 'tx-q-arrow' }, icon('chevron_right', 14)),
        pathCell(item.target, 'tx-q-path')),
      bar,
      h('div', { class: 'tx-q-meta mono' },
        h('span', {}, `${formatBytes(p.bytes || 0)} / ${formatBytes(p.total || 0)}`),
        h('span', {}, formatPercent(fraction)),
        h('span', {}, formatSpeed(p.cps || 0)),
        h('span', { title: t('timeLeft') }, formatEta(eta)),
        h('span', {}, `${p.filesDone || 0}/${p.filesTotal || 0} ${t('txColFiles')}`),
        item.cpsLimit ? h('span', { class: 'tx-q-limited', title: t('txSpeedLimitFor') }, `≤ ${formatSpeedLimit(item.cpsLimit)}`) : null),
      showFileList ? fileListFor(item) : null,
      item.error ? h('p', { class: 'tx-q-error' }, icon('error', 14), h('span', {}, item.error)) : null),
    h('div', { class: 'tx-q-actions' },
      rowButton('arrow_upward', 'txMoveUp', () => queueModel.move(item.id, -1)),
      rowButton('arrow_downward', 'txMoveDown', () => queueModel.move(item.id, 1)),
      item.state === 'paused'
        ? rowButton('sync_alt', 'resume', () => queueModel.resumeItem(item.id))
        : rowButton('pending', 'suspend', () => queueModel.pauseItem(item.id)),
      rowButton('close', 'txCancelItem', () => queueModel.cancel(item.id))));

    appearanceTarget(row, 'queue-row', 'Queue row');
    registerContextMenu(row, (ctx) => (ctx?.target && ctx.target.closest('.tx-q-actions') ? [] : rowMenu(item)));
    return row;
  }

  function rowButton(glyph, labelKey, run) {
    const btn = h('button', {
      // The key is what lets render() put focus back on the SAME button after a
      // rebuild. Without it a progress event twice a second would throw the
      // keyboard user out of the row they are operating.
      type: 'button', class: 'icon-btn tx-q-rowbtn', 'data-row-action': labelKey, tabindex: '-1',
      onclick: (e) => { e.stopPropagation(); Promise.resolve().then(run).catch((err) => notify.error(t('queueTitle'), err.message)); },
    }, icon(glyph, 16));
    bindText(btn, labelKey, { attr: 'aria-label' });
    bindText(btn, labelKey, { attr: 'title' });
    return btn;
  }

  function fileListFor(item) {
    const p = item.progress || {};
    const skipped = item.skipped || [];
    return h('div', { class: 'tx-q-files' },
      p.currentFile
        ? h('div', { class: 'tx-q-file mono ellipsis', title: p.currentFile }, `${t('txCurrentFile')}: ${p.currentFile}`)
        : null,
      skipped.length
        ? h('details', { class: 'tx-q-skipped' },
          h('summary', {}, t('txSkippedN', skipped.length)),
          h('ul', {}, ...skipped.slice(0, 200).map((s) => h('li', { class: 'mono ellipsis', title: s }, s))))
        : null);
  }

  function rowMenu(item) {
    return [
      { labelKey: item.state === 'paused' ? 'resume' : 'suspend', icon: item.state === 'paused' ? 'sync_alt' : 'pending', onSelect: () => (item.state === 'paused' ? queueModel.resumeItem(item.id) : queueModel.pauseItem(item.id)) },
      { labelKey: 'txExecuteNow', icon: 'arrow_upward', disabled: item.state === 'done', onSelect: () => executeNow(item) },
      SEPARATOR,
      { labelKey: 'txMoveUp', icon: 'arrow_upward', onSelect: () => queueModel.move(item.id, -1) },
      { labelKey: 'txMoveDown', icon: 'arrow_downward', onSelect: () => queueModel.move(item.id, 1) },
      SEPARATOR,
      { labelKey: 'txSpeedLimitFor', icon: 'tune', onSelect: () => openSpeedLimit(item) },
      { labelKey: 'progress', icon: 'wysiwyg', onSelect: () => bus.emit('queue:openProgress', { id: item.id }) },
      item.state === 'error'
        ? { labelKey: 'txShowError', icon: 'error', danger: true, onSelect: () => notify.error(t('txShowError'), item.error || '') }
        : null,
      SEPARATOR,
      { labelKey: 'copyPathClip', icon: 'content_copy', onSelect: () => copyText(`${item.source} -> ${item.target}`).then((ok) => ok && notify.success(t('copiedClip'), item.source)) },
      { labelKey: 'txCancelItem', icon: 'close', danger: true, onSelect: () => queueModel.cancel(item.id) },
    ].filter(Boolean);
  }

  async function executeNow(item) {
    // "Execute now" = put it at the front and make sure nothing is holding it.
    const list = snapshot.items;
    const index = list.findIndex((i) => i.id === item.id);
    for (let k = index; k > 0; k -= 1) await queueModel.move(item.id, -1);
    await queueModel.resumeItem(item.id);
  }

  function openSpeedLimit(item) {
    const input = h('input', { type: 'text', class: 'field-input', id: uid('tx-speed'), spellcheck: 'false' });
    input.value = item.cpsLimit ? String(Math.round(item.cpsLimit / 1024)) : '';
    const err = h('p', { class: 'tx-ov-error', role: 'alert', hidden: true });
    const presets = h('div', { class: 'row' }, ...SPEED_PRESETS.map((bps) => h('button', {
      type: 'button', class: 'rb-chip',
      onclick: () => { input.value = bps ? String(Math.round(bps / 1024)) : ''; err.hidden = true; },
    }, bps ? formatSpeedLimit(bps) : t('txUnlimited'))));
    openModal({
      title: t('txSpeedLimitFor'),
      width: 460,
      content: h('div', { class: 'stack' },
        h('label', { class: 'field', for: input.id },
          h('span', { class: 'field-label' }, t('speedLimit')), input),
        presets, err),
      actions: [
        { label: t('cancel'), kind: 'text' },
        {
          label: t('apply'),
          kind: 'filled',
          autofocus: true,
          onSelect: (close) => {
            const bps = parseSpeedLimit(input.value);
            if (bps === null) { err.hidden = false; err.textContent = t('invalidPattern', input.value); return true; }
            queueModel.setSpeed(item.id, bps)
              .then(() => notify.success(t('txSpeedLimitFor'), bps ? formatSpeedLimit(bps) : t('txUnlimited')))
              .catch((e) => notify.error(t('txSpeedLimitFor'), e.message));
            close();
            return true;
          },
        },
      ],
    });
  }

  function onRowKey(e, item) {
    // Alt+Arrow reorders. It stops here rather than bubbling, because the
    // roving-focus handler on the list also reads ArrowUp/ArrowDown and would
    // otherwise move the focus at the same time as the item.
    if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); queueModel.move(item.id, -1); }
    else if (e.altKey && e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); queueModel.move(item.id, 1); }
    else if (e.key === 'Delete') { e.preventDefault(); queueModel.cancel(item.id); }
    else if (e.key === 'Enter') { e.preventDefault(); bus.emit('queue:openProgress', { id: item.id }); }
    else if (e.key === 'ArrowRight' && e.target === e.currentTarget) {
      // Right steps into the row's own buttons; Left steps back out. Standard
      // grid behaviour, and the only way to reach pause/cancel without a mouse.
      const first = e.currentTarget.querySelector('.tx-q-rowbtn');
      if (first) { e.preventDefault(); e.stopPropagation(); first.focus(); }
    } else if (e.key === 'ArrowLeft' && e.target !== e.currentTarget) {
      e.preventDefault(); e.stopPropagation(); e.currentTarget.focus();
    }
  }

  function render() {
    const keep = focusFingerprint();
    paintToolbar();
    clear(listEl);
    clear(emptyEl);

    if (!snapshot.available) {
      emptyEl.appendChild(h('p', { class: 'prose' }, t('txQueueUnavailable')));
      return;
    }
    if (snapshot.error) {
      emptyEl.appendChild(h('p', { class: 'tx-q-error' }, icon('error', 15), h('span', {}, snapshot.error)));
    }

    const rows = search.isActive
      ? filterBy(snapshot.items, search.predicate, (i) => [i.source, i.target, t(stateKey(i.state)), t(sideKey(i.side))])
      : snapshot.items;

    if (!rows.length) {
      emptyEl.appendChild(h('p', { class: 'tx-q-empty-line' }, search.isActive
        ? noMatchMessage(search.predicate, t('txQueueScope'))
        : t('queueEmpty')));
      return;
    }
    for (const item of rows) listEl.appendChild(itemRow(item));
    restoreFocus(keep);
    rowRoving.sync(listEl.querySelector('.tx-q-row[tabindex="0"]') || listEl.querySelector('.tx-q-row'));
  }

  /**
   * The model emits on every progress event — twice a second while anything is
   * moving — and render() rebuilds every row. Without this the keyboard focus
   * would land on <body> each time, which is exactly when the per-item pause,
   * resume and cancel buttons matter most.
   */
  function focusFingerprint() {
    const el = document.activeElement;
    if (!el || !listEl.contains(el)) return null;
    const row = el.closest('.tx-q-row');
    if (!row) return null;
    return { id: row.getAttribute('data-queue-id'), action: el.getAttribute('data-row-action') };
  }

  function restoreFocus(fp) {
    if (!fp || !fp.id) return;
    let row = null;
    for (const candidate of listEl.querySelectorAll('.tx-q-row')) {
      if (candidate.getAttribute('data-queue-id') === fp.id) { row = candidate; break; }
    }
    if (!row) return;
    let target = row;
    if (fp.action) {
      for (const btn of row.querySelectorAll('.tx-q-rowbtn')) {
        if (btn.getAttribute('data-row-action') === fp.action) { target = btn; break; }
      }
    }
    row.tabIndex = 0;
    try { target.focus({ preventScroll: true }); } catch { target.focus(); }
  }

  const unsubscribe = queueModel.subscribe((snap) => {
    const wasBusy = snapshot.items.some((i) => !REST_STATES.has(i.state));
    snapshot = snap;
    render();
    if (wasBusy && !snap.items.some((i) => !REST_STATES.has(i.state)) && snap.items.length) {
      onQueueDrained();
    }
  });

  function onQueueDrained() {
    notify.success(t('queueTitle'), t('queueDone'));
    if (onceEmptyValue() === 'disconnect') disconnectAllSessions();
  }

  registerContextMenu(root, (ctx) => (ctx?.target && ctx.target.closest('.tx-q-row') ? [] : [
    { labelKey: 'processQueue', icon: 'check_circle', checked: snapshot.queue.enabled !== false, onSelect: guard(toggleProcessing) },
    SEPARATOR,
    { labelKey: 'suspendAll', icon: 'pending', onSelect: guard(() => queueModel.pauseAll()) },
    { labelKey: 'resumeAll', icon: 'sync_alt', onSelect: guard(() => queueModel.resumeAll()) },
    { labelKey: 'deleteCompleted', icon: 'done_all', onSelect: guard(clearCompleted) },
    { labelKey: 'cancelAll', icon: 'delete', danger: true, onSelect: confirmCancelAll },
    SEPARATOR,
    {
      labelKey: 'txFileList',
      icon: 'receipt_long',
      checked: showFileList,
      onSelect: () => {
        showFileList = !showFileList;
        setTransferPref('queue.fileList', showFileList, 'Toggled the queue file list');
        render();
      },
    },
  ]));

  render();

  void opts;
  const handle = {
    element: root,
    refresh: () => queueModel.refresh(),
    /**
     * Put the keyboard in the list. ui/commands.js's QueueGoToAction calls this
     * on the published handle, so leaving it off turns "Go To" into a
     * TypeError toast rather than a jump to the queue.
     */
    focus() {
      const target = (selectedId && listEl.querySelector(`[data-queue-id="${CSS.escape(String(selectedId))}"]`))
        || listEl.querySelector('.tx-q-row')
        || root.querySelector('button, input, [tabindex="0"]');
      if (!target) return false;
      target.tabIndex = target.tabIndex < 0 ? 0 : target.tabIndex;
      target.focus();
      return true;
    },
    select(id) { selectedId = id; render(); },
    /** The row the command layer acts on. `null` when nothing is selected. */
    selected() {
      const item = snapshot.items.find((i) => i.id === selectedId) || null;
      if (!item) return null;
      return { ...item, query: pendingQueryFor(item.id), prompt: pendingPromptFor(item.id) };
    },
    destroy() {
      unsubscribe();
      search.destroy();
      root.remove();
      if (livePanel === handle) livePanel = null;
    },
  };
  livePanel = handle;
  publishQueuePanel(handle);
  return handle;
}

/**
 * The most recently created panel, so the command layer (ui/commands.js) and
 * the "Show query" action have something to act on. Registration is optional
 * and failure-tolerant: this module must work in a window that never loads the
 * command layer at all.
 */
let livePanel = null;
export function currentQueuePanel() { return livePanel; }

function publishQueuePanel(panel) {
  session.set('queuePanel', panel);
  import('./commands.js')
    .then((mod) => mod.installCommands?.({ queuePanel: panel }))
    .catch(() => { /* the command layer is optional in this window */ });
}

/** Disconnect every connected session — the honest half of "once empty". */
async function disconnectAllSessions() {
  const b = bridge();
  if (!b?.session?.list) return;
  try {
    const sessions = unwrap(await b.session.list()) || [];
    let n = 0;
    for (const s of sessions) {
      if (s.state === 'connected' || s.connected) { await b.session.disconnect(s.id); n += 1; }
    }
    if (n) notify.info(t('queueOnceEmpty'), t('txDisconnectedOnEmpty', n));
  } catch (err) {
    notify.error(t('queueOnceEmpty'), err.message);
  }
}

/* ================================================================== */
/* styles — one managed sheet for the whole transfer surface           */
/* ================================================================== */

let stylesInjected = false;

/**
 * The shell's components.css is owned by the shell. Everything this module and
 * the six transfer dialogs draw lives in one managed sheet injected on first
 * use, so nothing is loaded for a window that never opens a transfer surface.
 */
export function injectTransferStyles() {
  if (stylesInjected || typeof document === 'undefined') return;
  stylesInjected = true;
  styleSheet('transfer').set(TRANSFER_CSS);
}

const TRANSFER_CSS = `
/* ---- a path whose file name never gets truncated ---- */
.tx-path { display: inline-flex; align-items: baseline; min-width: 0; max-width: 100%; }
.tx-path-dir { flex: 0 20 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--onsv); }
.tx-path-base { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }

/* ---- queue panel ---- */
.tx-q { display: flex; flex-direction: column; min-height: 0; min-width: 0; height: 100%; gap: 0; overflow-x: hidden; }
.tx-q-modalwrap { min-width: 0; }
.tx-q-toolbar {
  display: flex; align-items: center; gap: calc(6px * var(--den)); flex-wrap: wrap;
  padding: calc(8px * var(--den)) calc(12px * var(--den));
  border-bottom: 1px solid var(--outline-var);
  background: var(--c-low);
}
.tx-q-sep { width: 1px; height: calc(20px * var(--den)); background: var(--outline-var); }
.tx-q-toggle, .tx-q-once {
  display: inline-flex; align-items: center; gap: 6px;
  min-height: calc(30px * var(--den)); padding: 0 calc(12px * var(--den));
  border-radius: var(--shape-full); border: 1px solid var(--outline-var);
  color: var(--onsv); font-size: var(--type-label-md); font-weight: 600;
  max-width: 34ch; overflow: hidden;
}
.tx-q-toggle.is-on { background: var(--secc); color: var(--onsecc); border-color: var(--sec); }
.tx-q-toggle > span, .tx-q-once > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tx-q-limitwrap { flex: 0 0 auto; }
.tx-q-limit { width: 7ch; min-height: calc(30px * var(--den)); }
/* Wraps rather than overflowing: in bilingual mode this line is twice as long
   as it is in either single language, and a horizontal scrollbar on a toolbar
   is a clipping defect, not a layout. */
.tx-q-summary { font-size: var(--type-label-sm); color: var(--onsv); min-width: 0; flex: 1 1 100%; line-height: 1.45; }
.tx-q-searchwrap { display: flex; min-width: 0; flex: 1 1 220px; }
/* The queue popover reuses the floating-window chrome but is ANCHORED, so it
   must drop the centring transform and the bottom pinning that the progress
   window relies on — leaving them in place moved it half its own width to the
   left of wherever anchorTo() had just put it. */
.tx-q-popover { position: fixed; left: auto; bottom: auto; transform: none;
  width: min(860px, calc(100vw - 32px)); max-height: min(70vh, 720px);
  display: flex; flex-direction: column; }
.tx-q-popbody { flex: 1 1 auto; display: flex; min-height: calc(240px * var(--uiscale)); overflow: auto; }
.tx-q-list { flex: 1 1 auto; overflow-y: auto; overflow-x: hidden; min-height: 0; min-width: 0; padding: calc(6px * var(--den)); display: flex; flex-direction: column; gap: calc(4px * var(--den)); }
.tx-q-empty { padding: calc(16px * var(--den)); color: var(--onsv); font-size: var(--type-body-sm); }
.tx-q-empty-line { line-height: 1.5; }
.tx-q-row {
  display: flex; align-items: flex-start; gap: calc(10px * var(--den));
  padding: calc(8px * var(--den)) calc(10px * var(--den));
  border-radius: var(--shape-md); border: 1px solid transparent;
  background: var(--c-lowest); color: var(--onsfc);
}
.tx-q-row:hover { background: var(--c-low); }
.tx-q-row.is-selected { border-color: var(--p); background: var(--pc); color: var(--onpc); }
.tx-q-row.is-error { border-color: var(--err); }
.tx-q-row.is-query, .tx-q-row.is-prompt { border-color: var(--ter); }
.tx-q-row.is-done .tx-q-bar-fill { background: var(--sec); }
.tx-q-state { flex: 0 0 auto; padding-top: 2px; color: var(--onsv); }
.tx-q-row.is-error .tx-q-state { color: var(--err); }
.tx-q-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.tx-q-paths { display: flex; align-items: baseline; gap: 6px; min-width: 0; flex-wrap: nowrap; }
.tx-q-op { font-size: var(--type-label-sm); font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--onsv); flex: 0 0 auto; }
.tx-q-arrow { flex: 0 0 auto; color: var(--onsv); align-self: center; }
.tx-q-path { font-size: var(--type-body-sm); flex: 1 1 0; min-width: 6ch; }
.tx-q-bar { height: calc(6px * var(--den)); border-radius: var(--shape-full); background: color-mix(in srgb, var(--onsfc) 14%, transparent); overflow: hidden; }
.tx-q-bar-fill { height: 100%; background: var(--p); border-radius: inherit; transition: width var(--motion-medium) var(--ease-standard); }
.tx-q-meta { display: flex; gap: calc(10px * var(--den)); flex-wrap: wrap; font-size: var(--type-label-sm); color: var(--onsv); }
.tx-q-limited { color: var(--onterc); background: var(--terc); border-radius: var(--shape-xs); padding: 0 5px; }
.tx-q-files { display: flex; flex-direction: column; gap: 2px; font-size: var(--type-label-sm); color: var(--onsv); }
.tx-q-file { max-width: 100%; }
.tx-q-skipped ul { margin: 4px 0 0 14px; display: flex; flex-direction: column; gap: 2px; }
.tx-q-error { display: flex; align-items: flex-start; gap: 6px; color: var(--onerrc); background: var(--errc); border-radius: var(--shape-sm); padding: 6px 8px; font-size: var(--type-label-md); line-height: 1.45; }
.tx-q-actions { display: flex; gap: 2px; flex: 0 0 auto; flex-wrap: wrap; justify-content: flex-end; }
.tx-q-rowbtn { width: calc(28px * var(--den)); height: calc(28px * var(--den)); min-width: 26px; min-height: 26px; }

/* ---- overwrite modal ---- */
.tx-ov-file { border: 1px solid var(--outline-var); border-radius: var(--shape-md); padding: calc(9px * var(--den)) calc(11px * var(--den)); display: flex; flex-direction: column; gap: 3px; }
.tx-ov-file-head { display: flex; align-items: center; gap: 6px; font-size: var(--type-label-md); font-weight: 700; color: var(--onsv); }
.tx-ov-file-path { font-size: var(--type-body-sm); word-break: break-all; }
.tx-ov-file-meta { display: flex; gap: calc(14px * var(--den)); flex-wrap: wrap; font-size: var(--type-label-md); color: var(--onsv); }
.tx-ov-compare { display: flex; align-items: flex-start; gap: 6px; font-size: var(--type-label-md); background: var(--secc); color: var(--onsecc); border-radius: var(--shape-sm); padding: 7px 9px; line-height: 1.45; }
.tx-ov-heading { font-size: var(--type-label-lg); font-weight: 700; color: var(--onsv); margin-top: 2px; }
.tx-ov-choices { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: calc(6px * var(--den)); }
.tx-ov-choice {
  display: flex; flex-direction: column; align-items: flex-start; gap: 2px;
  padding: calc(9px * var(--den)) calc(11px * var(--den));
  border: 1px solid var(--outline-var); border-radius: var(--shape-md);
  background: var(--c-lowest); color: var(--onsfc); text-align: left; min-height: calc(56px * var(--den));
}
.tx-ov-choice:hover:not(:disabled) { border-color: var(--p); background: var(--pc); color: var(--onpc); }
.tx-ov-choice:disabled { opacity: .55; cursor: default; }
.tx-ov-choice.is-primary { border-color: var(--p); }
.tx-ov-choice.is-sticky { border-style: dashed; }
.tx-ov-choice-title { font-size: var(--type-label-lg); font-weight: 700; }
.tx-ov-choice-desc { font-size: var(--type-label-md); opacity: .9; line-height: 1.4; text-wrap: pretty; }
.tx-ov-rename { display: flex; align-items: flex-end; gap: 8px; flex-wrap: wrap; }
.tx-ov-rename .field { flex: 1 1 220px; }
.tx-ov-outcome { font-size: var(--type-body-sm); line-height: 1.5; background: var(--terc); color: var(--onterc); border-radius: var(--shape-sm); padding: 8px 10px; min-height: 2.6em; }
.tx-ov-error { font-size: var(--type-label-md); color: var(--onerrc); background: var(--errc); border-radius: var(--shape-sm); padding: 7px 9px; line-height: 1.45; }

/* ---- floating, non-modal transfer windows (progress, keep-up-to-date) ---- */
.tx-pg-window {
  position: fixed;
  left: 50%; bottom: calc(24px * var(--den));
  transform: translateX(-50%);
  width: min(680px, calc(100vw - 32px));
  max-height: calc(100vh - 96px);
  display: flex; flex-direction: column;
  border-radius: var(--shape-xl);
  border: 1px solid var(--outline-var);
  overflow: hidden;
  animation: m3-fade-up var(--motion-medium) var(--ease-emphasized);
}
.tx-pg-window .tx-pg { flex: 1 1 auto; overflow: auto; min-height: 0; padding: calc(14px * var(--den)); }
.tx-pg-window .tx-q-toolbar { border-top: 1px solid var(--outline-var); border-bottom: none; }

/* ---- progress dialog ---- */
.tx-pg { display: flex; flex-direction: column; gap: calc(12px * var(--den)); }
.tx-pg-line { display: flex; gap: 8px; align-items: baseline; min-width: 0; }
.tx-pg-line > span:first-child { flex: 0 0 auto; width: 12ch; font-size: var(--type-label-md); color: var(--onsv); }
.tx-pg-line > span:last-child { flex: 1 1 auto; min-width: 0; font-size: var(--type-body-sm); }
.tx-pg-bar { height: calc(10px * var(--den)); border-radius: var(--shape-full); background: color-mix(in srgb, var(--onsfc) 14%, transparent); overflow: hidden; }
.tx-pg-bar-fill { height: 100%; background: var(--p); border-radius: inherit; transition: width var(--motion-medium) var(--ease-standard); }
.tx-pg-bar.is-file .tx-pg-bar-fill { background: var(--ter); }
.tx-pg-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: calc(8px * var(--den)); }
.tx-pg-stat { border: 1px solid var(--outline-var); border-radius: var(--shape-md); padding: calc(8px * var(--den)) calc(10px * var(--den)); }
.tx-pg-stat-label { font-size: var(--type-label-sm); color: var(--onsv); text-transform: uppercase; letter-spacing: .04em; }
.tx-pg-stat-value { font-size: var(--type-title-md); font-family: var(--mono); }
.tx-pg-graph { border: 1px solid var(--outline-var); border-radius: var(--shape-md); padding: calc(8px * var(--den)); }
.tx-pg-graph svg { display: block; width: 100%; height: calc(72px * var(--uiscale)); }
.tx-pg-graph-empty { font-size: var(--type-label-md); color: var(--onsv); }
.tx-pg-caption { font-size: var(--type-label-sm); color: var(--onsv); display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap; }

/* ---- synchronize + checklist ---- */
.tx-sy-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: calc(10px * var(--den)); }
.tx-sy-group { border: 1px solid var(--outline-var); border-radius: var(--shape-md); padding: calc(10px * var(--den)); display: flex; flex-direction: column; gap: calc(6px * var(--den)); min-width: 0; }
.tx-sy-group > h3 { font-size: var(--type-label-sm); text-transform: uppercase; letter-spacing: .04em; color: var(--onsv); font-weight: 700; }
.tx-sy-note { font-size: var(--type-label-md); color: var(--onterc); background: var(--terc); border-radius: var(--shape-sm); padding: 6px 8px; line-height: 1.45; }
.tx-sy-refuse { font-size: var(--type-body-sm); color: var(--onerrc); background: var(--errc); border-radius: var(--shape-sm); padding: 8px 10px; line-height: 1.5; }
.tx-sy-log { max-height: calc(180px * var(--uiscale)); overflow: auto; border: 1px solid var(--outline-var); border-radius: var(--shape-sm); padding: 6px; display: flex; flex-direction: column; gap: 2px; font-size: var(--type-label-md); }
.tx-sy-log-line { display: flex; gap: 8px; }
.tx-sy-log-time { color: var(--onsv); font-family: var(--mono); flex: 0 0 auto; }

.tx-cl-summary { border-radius: var(--shape-md); padding: calc(10px * var(--den)) calc(12px * var(--den)); background: var(--secc); color: var(--onsecc); display: flex; flex-direction: column; gap: 4px; }
.tx-cl-summary.has-deletions { background: var(--errc); color: var(--onerrc); }
.tx-cl-summary h3 { font-size: var(--type-label-lg); font-weight: 700; }
.tx-cl-summary ul { margin-left: 18px; display: flex; flex-direction: column; gap: 2px; }
.tx-cl-summary li { font-size: var(--type-body-sm); line-height: 1.5; }
.tx-cl-toolbar { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.tx-cl-list { max-height: calc(340px * var(--uiscale)); overflow: auto; border: 1px solid var(--outline-var); border-radius: var(--shape-md); }
.tx-cl-group { position: sticky; top: 0; background: var(--c-low); padding: calc(5px * var(--den)) calc(10px * var(--den)); font-size: var(--type-label-sm); font-weight: 700; color: var(--onsv); border-bottom: 1px solid var(--outline-var); z-index: 1; }
.tx-cl-row { display: flex; align-items: center; gap: calc(8px * var(--den)); padding: calc(5px * var(--den)) calc(10px * var(--den)); border-bottom: 1px solid var(--outline-var); }
.tx-cl-row:last-child { border-bottom: none; }
.tx-cl-row.is-delete { background: color-mix(in srgb, var(--errc) 45%, transparent); }
.tx-cl-row.is-nothing { opacity: .72; }
.tx-cl-name { flex: 1 1 auto; min-width: 6ch; font-size: var(--type-body-sm); }
.tx-cl-reason { font-size: var(--type-label-sm); color: var(--onsv); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tx-cl-size { font-size: var(--type-label-sm); color: var(--onsv); font-family: var(--mono); flex: 0 0 auto; }
/* No max-width: a native select clips its own selected text rather than
   ellipsising it, so capping the width would hide which action a row will take
   — the one thing this dialog exists to state. */
.tx-cl-action { min-height: calc(30px * var(--den)); border: 1px solid var(--outline); border-radius: var(--shape-xs); background: var(--c-lowest); color: var(--onsfc); flex: 0 0 auto; }
.tx-cl-empty { padding: calc(16px * var(--den)); color: var(--onsv); font-size: var(--type-body-sm); text-align: center; }

/* ---- authentication ---- */
.tx-au-fingerprint {
  font-family: var(--mono); font-size: var(--type-title-md); line-height: 1.5;
  word-break: break-all; padding: calc(10px * var(--den)); border-radius: var(--shape-md);
  background: var(--c-lowest); border: 2px solid var(--outline);
}
.tx-au-banner-changed { border: 3px solid var(--err); background: var(--errc); color: var(--onerrc); border-radius: var(--shape-md); padding: calc(12px * var(--den)); display: flex; flex-direction: column; gap: 6px; }
.tx-au-banner-changed h3 { font-size: var(--type-title-md); font-weight: 700; letter-spacing: .02em; display: flex; align-items: center; gap: 8px; }
.tx-au-banner-new { border: 1px solid var(--outline-var); background: var(--terc); color: var(--onterc); border-radius: var(--shape-md); padding: calc(10px * var(--den)); display: flex; flex-direction: column; gap: 6px; }
.tx-au-banner-new h3 { font-size: var(--type-title-md); font-weight: 600; display: flex; align-items: center; gap: 8px; }
.tx-au-changed .tx-au-fingerprint { border-color: var(--err); }
.tx-au-expected .tx-au-fingerprint { border-color: var(--outline-var); text-decoration: line-through; opacity: .8; }
.tx-au-kv { display: grid; grid-template-columns: minmax(9ch, auto) 1fr; gap: 4px 12px; font-size: var(--type-label-md); }
.tx-au-kv > span:nth-child(odd) { color: var(--onsv); font-weight: 700; }
.tx-au-kv > span:nth-child(even) { word-break: break-all; }
.tx-au-prompt { display: flex; flex-direction: column; gap: 4px; }
.tx-au-instructions { font-size: var(--type-body-sm); line-height: 1.5; white-space: pre-wrap; background: var(--c-low); border-radius: var(--shape-sm); padding: 8px 10px; }
.tx-au-errors { display: flex; flex-direction: column; gap: 3px; margin-left: 18px; }
.tx-au-errors li { font-size: var(--type-body-sm); line-height: 1.45; }

/* ---- message dialog ---- */
.tx-md { display: flex; gap: calc(12px * var(--den)); align-items: flex-start; }
.tx-md-icon { flex: 0 0 auto; padding-top: 2px; }
.tx-md-icon.is-error { color: var(--err); }
.tx-md-icon.is-warning { color: var(--onterc); }
.tx-md-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: calc(8px * var(--den)); }
.tx-md-text { font-size: var(--type-body-md); line-height: 1.55; white-space: pre-wrap; word-break: break-word; }
.tx-md-detail { font-family: var(--mono); font-size: var(--type-label-md); white-space: pre-wrap; word-break: break-word; background: var(--c-lowest); border: 1px solid var(--outline-var); border-radius: var(--shape-sm); padding: 8px 10px; max-height: 240px; overflow: auto; }

/* ---- file system info ---- */
.tx-fsi-tabs { display: flex; gap: 4px; flex-wrap: wrap; border-bottom: 1px solid var(--outline-var); padding-bottom: 6px; }
.tx-fsi-tab { min-height: calc(32px * var(--den)); padding: 0 calc(14px * var(--den)); border-radius: var(--shape-full); color: var(--onsv); font-size: var(--type-label-md); font-weight: 600; }
.tx-fsi-tab[aria-selected="true"] { background: var(--secc); color: var(--onsecc); }
.tx-fsi-table { display: grid; grid-template-columns: minmax(14ch, auto) 1fr; gap: 3px 14px; font-size: var(--type-body-sm); }
.tx-fsi-table > span:nth-child(odd) { color: var(--onsv); font-weight: 600; }
.tx-fsi-table > span:nth-child(even) { word-break: break-word; }
.tx-fsi-caps { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: calc(4px * var(--den)); }
.tx-fsi-cap { display: flex; align-items: center; gap: 7px; padding: calc(5px * var(--den)) calc(8px * var(--den)); border-radius: var(--shape-sm); font-size: var(--type-body-sm); }
.tx-fsi-cap.is-on { background: color-mix(in srgb, var(--secc) 70%, transparent); color: var(--onsecc); }
.tx-fsi-cap.is-off { color: var(--onsv); }
.tx-fsi-cap-name { flex: 1 1 auto; min-width: 0; }

@media (max-width: 720px) {
  .tx-q-meta { gap: 8px; }
  .tx-q-path { max-width: 26ch; }
  .tx-ov-choices { grid-template-columns: 1fr; }
  .tx-pg-line > span:first-child { width: 9ch; }
  .tx-pg-window { width: calc(100vw - 16px); }
}
`;

/* ================================================================== */
/* registration                                                        */
/* ================================================================== */

let queueView = null;

/** Idempotent: safe to call from an entry point and from a test. */
export function startQueueUi() {
  if (queueView) return;

  queueView = registerView({
    id: 'queue',
    labelKey: 'queueTitle',
    icon: 'playlist',
    order: 30,
    mount(container) {
      const panel = createQueuePanel();
      container.appendChild(panel.element);
      container._queuePanel = panel;
    },
    unmount(container) {
      container._queuePanel?.destroy();
      container._queuePanel = null;
    },
  });

  registerCommand({ id: 'queue.show', labelKey: 'queueShow', icon: 'playlist', shortcut: 'Ctrl+Q', run: () => openQueuePopover() });
  registerCommand({ id: 'queue.processQueue', labelKey: 'processQueue', icon: 'check_circle', shortcut: 'Ctrl+Shift+Q', run: () => queueModel.setEnabled(queueModel.snapshot.queue.enabled === false) });
  registerCommand({ id: 'queue.pauseAll', labelKey: 'suspendAll', icon: 'pending', run: () => queueModel.pauseAll() });
  registerCommand({ id: 'queue.resumeAll', labelKey: 'resumeAll', icon: 'sync_alt', run: () => queueModel.resumeAll() });
  registerCommand({ id: 'queue.deleteCompleted', labelKey: 'deleteCompleted', icon: 'done_all', run: () => queueModel.clearDone() });
  registerCommand({
    id: 'queue.cancelAll',
    labelKey: 'cancelAll',
    icon: 'delete',
    run: () => Promise.all(queueModel.snapshot.items.filter((i) => !REST_STATES.has(i.state)).map((i) => queueModel.cancel(i.id))),
  });

  registerStatusItem({
    id: 'queue',
    side: 'left',
    order: 30,
    label: 'Transfer queue status',
    render: () => {
      const c = queueModel.counts();
      const text = c.total
        ? t('txQueueSummary', c.active, c.queued + c.paused, c.done, c.error)
        : t('queueEmpty');
      return h('span', { class: `chip${c.error ? ' is-warn' : ' is-quiet'}`, title: text },
        icon('playlist', 13), h('span', {}, text));
    },
  });

  registerTitlebarAction({
    id: 'queue',
    icon: 'playlist',
    labelKey: 'queueTitle',
    order: 20,
    onSelect: (btn) => openQueuePopover(btn),
  });

  bus.on('queue:changed', () => refreshStatus());

  // The command layer (ui/commands.js) raises these for its Queue actions; they
  // reopen the surface that is genuinely waiting rather than a fresh one.
  bus.on('queue:open', () => openQueuePopover());
  bus.on('queue:showQuery', (item) => {
    const id = item?.id || item;
    const query = pendingQueryFor(id);
    if (query) { openOverwriteDialog({ itemId: id, query }); return; }
    // The engine's own state is the authority on whether a transfer is waiting.
    // Saying "it is not waiting" while queue:list reports `query` would be a
    // false statement about the one thing the user came here to check.
    reportMissingWait(id, 'query');
  });
  bus.on('queue:showPrompt', (item) => {
    const id = item?.id || item;
    const prompt = pendingPromptFor(id);
    if (prompt) { openQueueCredentialPrompt({ itemId: id, prompt }); return; }
    reportMissingWait(id, 'prompt');
  });

  queueModel.start();
}

defineStrings({
  txNoPendingQuery: ['That transfer is not waiting for an answer.', '嗰單傳輸而家冇等緊你答。'],
  txNoPendingPrompt: ['That transfer is not waiting for a credential.', '嗰單傳輸而家冇等緊憑證。'],
  txWaitLost: ['That transfer IS waiting — the engine reports it as "{0}" — but the question itself never reached this window, so it cannot be answered here. The transfer will stay stopped until it is cancelled.', '嗰單傳輸真係等緊——引擎報住係「{0}」——但係條問題根本冇送到嚟呢個視窗，所以喺呢度答唔到。除非取消，否則佢會一直停喺度。'],
});

/**
 * "Show the query" with nothing captured. Two genuinely different situations —
 * the transfer is not waiting at all, or it is waiting and the question was
 * lost on the way here — and reporting the second as the first tells the user
 * a stopped transfer is fine. design/main/ipc.js forwards the queue's `query`
 * and `prompt` events with the emitter's `respond` FUNCTION still in the
 * payload, which webContents.send cannot structured-clone, so today the second
 * case is the one that actually happens.
 */
function reportMissingWait(id, kind) {
  const item = queueModel.item(id);
  const waiting = item && (item.state === 'query' || item.state === 'prompt');
  if (waiting) {
    notify.warning(t('queueTitle'), t('txWaitLost', t(stateKey(item.state))));
    return;
  }
  notify.info(t('queueTitle'), t(kind === 'query' ? 'txNoPendingQuery' : 'txNoPendingPrompt'));
}

let popover = null;

/**
 * The queue as a floating surface, for the title-bar button.
 *
 * It is deliberately NOT a modal. Watching a transfer is the one thing a user
 * does while continuing to work: a scrim over the panels would make the queue
 * unusable for its own purpose. So this is an anchored, non-modal popover —
 * `aria-modal="false"`, Escape closes, focus returns to the button — the same
 * shape progress.js and fileysteminfo.js use.
 */
export function openQueuePopover(anchorEl) {
  // A surface whose element is gone was torn down without its close running;
  // treating it as open would make the button a dead toggle.
  if (popover && !popover.element?.isConnected) popover = null;
  if (popover) { popover.close(); return null; }
  injectTransferStyles();

  const panel = createQueuePanel();
  const titleId = uid('tx-qp-title');
  const restoreFocus = focusMemory();

  const closeBtn = h('button', { type: 'button', class: 'icon-btn', onclick: () => close() }, icon('close', 18));
  bindText(closeBtn, 'close', { attr: 'aria-label' });
  bindText(closeBtn, 'close', { attr: 'title' });

  const root = h('div', {
    class: 'tx-pg-window tx-q-popover surface-3', role: 'dialog', 'aria-modal': 'false',
    'aria-labelledby': titleId, tabindex: '-1',
  },
  h('header', { class: 'nc-head' },
    icon('swap_vert', 18),
    h('span', { class: 'nc-head-title', id: titleId }, t('queueTitle')),
    closeBtn),
  h('div', { class: 'tx-q-popbody' }, panel.element));
  appearanceTarget(root, 'queue-popover', 'Queue popover');
  layer('popover').appendChild(root);

  const anchored = anchorEl
    ? anchorTo(root, anchorEl, { placement: 'bottom-end', gap: 8, onDetach: () => close() })
    : null;
  if (!anchored) {
    root.style.position = 'fixed';
    root.style.right = 'calc(16px * var(--uiscale))';
    root.style.top = 'calc(56px * var(--uiscale))';
  }

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    anchored?.dispose?.();
    panel.destroy();
    root.remove();
    popover = null;
    restoreFocus();
  }

  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
  });
  root.focus({ preventScroll: true });

  const handle = { element: root, close, focus: () => root.focus() };
  popover = handle;
  return handle;
}

// Registration happens on import so a single `import './ui/queue.js'` from the
// application entry point wires the whole transfer surface.
startQueueUi();

// Kept on `session` so any module can reach the live model without importing
// this file and re-triggering the dialog registrations.
session.set('queueModel', queueModel);
