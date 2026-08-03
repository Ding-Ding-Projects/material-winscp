// ui/dialogs/progress.js — the transfer progress window (Progress.dfm).
//
// Per-file and total progress, elapsed / remaining time, throughput with a
// rolling graph, the speed limit, the "once finished" action and the path that
// sends the transfer to the background.
//
// It is deliberately NOT a modal. WinSCP's progress window blocks its own
// window; this one only informs, and the shell's rule is that a modal is
// reserved for a decision the user must make before continuing. So it is a
// floating, non-modal surface (`aria-modal="false"`) that can be left open
// while the panels are used, closed with Escape, and reopened from the queue.
// The one genuinely blocking moment inside a transfer — "the target file
// exists" — is a real modal, and it lives in ui/queue.js.

import { h, icon, clear, uid, appearanceTarget, announce, layer, focusMemory, svg, openModal } from '../../dom.js';
import { bus } from '../../state.js';
import { t, bindText } from '../../i18n.js';
import { notify } from '../notifications.js';
import { attachMenuButton } from '../contextmenu.js';
import { registerCommand } from '../../app.js';
import {
  defineStrings, injectTransferStyles, queueModel, formatBytes, formatSpeed, formatClock,
  formatEta, etaSeconds, progressFraction, formatPercent, sparklinePath, throughputPeak,
  throughputAverage, formatSpeedLimit, parseSpeedLimit, SPEED_PRESETS, transferPref,
  setTransferPref, THROUGHPUT_WINDOW_MS, pathCell,
} from '../queue.js';

defineStrings({
  txPgTitle: ['Transfer progress', '傳輸進度'],
  txPgTotal: ['Total progress', '總進度'],
  txPgFile: ['Current file', '而家嘅檔案'],
  txPgStart: ['Start time', '開始時間'],
  txPgElapsed: ['Time elapsed', '用咗幾耐'],
  txPgTransferred: ['Bytes transferred', '已傳輸'],
  txPgFiles: ['Files done', '完成檔案'],
  txPgThroughput: ['Throughput, last {0} seconds', '吞吐量，最近 {0} 秒'],
  txPgPeak: ['Peak {0}', '最高 {0}'],
  txPgAverage: ['Average {0}', '平均 {0}'],
  txPgNoThroughput: ['No throughput has been measured yet.', '仲未量到吞吐量。'],
  txPgBackground: ['Proceed in background', '擺去背景繼續'],
  txPgBackgroundDone: [[
    'The transfer keeps running in the queue. Open the queue to watch or control it.',
    'It keeps running in the queue — open the queue to watch or control it.',
    'Still running in the queue. Pop the queue open whenever you want to peek.',
    'Off it goes to the queue, still running. Open the queue whenever you want to look in on it.',
    'Off it toddles into the queue, still hard at work. Open the queue any time you fancy checking in on the little worker.'], [
    '傳輸會喺佇列度繼續行。想睇住或者控制佢就開返個佇列。',
    '照喺佇列度行緊——想睇或者控制就開個佇列。',
    '仲喺佇列度行緊。想望下就開個佇列。',
    '佢自己去咗佇列度繼續搏殺。想睇下佢幾時都可以開個佇列。',
    '佢一嘟一嘟咁行咗入佇列繼續開工。你幾時想探下呢個小工人就開個佇列啦。']],
  txPgSkipFile: ['Skip this file', '跳過呢個檔案'],
  txPgSkipUnavailable: ['A file can only be skipped while the transfer is asking what to do about it. This transfer is not waiting for an answer.', '淨係當傳輸問緊你點處理個檔案嗰陣先可以跳過。呢單傳輸而家冇等緊你答。'],
  txPgOnceFinished: ['Once finished', '完成之後'],
  txPgNoItem: ['That transfer is no longer in the queue.', '嗰單傳輸已經唔喺佇列度。'],
  txPgNothingRunning: ['Nothing is being transferred right now.', '而家冇嘢傳緊。'],
  txPgSpeedLimit: ['Speed limit', '速度上限'],
  txPgCancelled: ['Cancelled "{0}".', '取消咗「{0}」。'],
  txPgCancelling: ['Cancelling transfer…', '取消緊傳輸⋯'],
  txPgFinished: ['Transfer finished.', '傳輸完成。'],
  txPgFinishedWithErrors: ['Transfer finished with errors.', '傳輸完成，但有錯誤。'],
  txPgActionFailed: ['Could not update the transfer: {0}', '更新傳輸失敗：{0}'],
});

/** One window per item; asking twice focuses the one that is already open. */
const openWindows = new Map();

/**
 * openProgressDialog({ id }) -> handle | null
 *
 * With no id it follows the first item that is actually moving, which is what
 * "show me the transfer" means when it is invoked from a toolbar rather than
 * from a specific queue row.
 */
export function openProgressDialog({ id } = {}) {
  injectTransferStyles();
  injectProgressStyles();

  let itemId = id || firstRunningId();
  if (!itemId) { notify.info(t('txPgTitle'), t('txPgNothingRunning')); return null; }
  const existing = openWindows.get(itemId);
  if (existing) { existing.focus(); return existing; }

  const restoreFocus = focusMemory();
  const titleId = uid('tx-pg-title');

  const sourceLine = statLine('sourceLbl');
  const targetLine = statLine('destLbl');
  const currentLine = statLine('txPgFile');
  const status = h('p', { class: 'tx-pg-status', role: 'status', 'aria-live': 'polite', hidden: true });

  const totalBar = progressBar(false);
  const fileBar = progressBar(true);

  const stats = {
    start: statCard('txPgStart'),
    elapsed: statCard('txPgElapsed'),
    left: statCard('timeLeft'),
    speed: statCard('speed'),
    bytes: statCard('txPgTransferred'),
    files: statCard('txPgFiles'),
  };
  const statsGrid = h('div', { class: 'tx-pg-grid' }, ...Object.values(stats).map((s) => s.element));

  const graphPath = svg('path', {
    fill: 'none', stroke: 'currentColor', 'stroke-width': '2',
    'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'vector-effect': 'non-scaling-stroke',
  });
  const graphSvg = svg('svg', {
    viewBox: '0 0 240 60', preserveAspectRatio: 'none', role: 'img',
    'aria-label': t('txPgThroughput', THROUGHPUT_WINDOW_MS / 1000),
  }, graphPath);
  // `hidden` is an HTMLElement property; assigning it to an SVGElement makes an
  // expando that changes nothing, so the SVG lives in a plain div that can be
  // hidden properly. Without this the empty graph reserves 72px of blank box.
  const graphBox = h('div', { class: 'tx-pg-graph-box' }, graphSvg);
  const graphEmpty = h('p', { class: 'tx-pg-graph-empty' }, t('txPgNoThroughput'));
  const graphCaption = h('div', { class: 'tx-pg-caption mono' });
  const graph = h('div', { class: 'tx-pg-graph' },
    h('div', { class: 'tx-pg-stat-label' }, t('txPgThroughput', THROUGHPUT_WINDOW_MS / 1000)),
    graphBox, graphEmpty, graphCaption);
  appearanceTarget(graph, 'progress-throughput', 'Throughput graph');

  /* ---- toolbar ---- */

  const pauseBtn = toolButton('pending', 'suspend', () => run(() => (currentItem()?.state === 'paused'
    ? queueModel.resumeItem(itemId) : queueModel.pauseItem(itemId))));
  const skipBtn = toolButton('chevron_right', 'txPgSkipFile', () => skipCurrentFile());
  const backgroundBtn = toolButton('playlist', 'txPgBackground', () => {
    notify.info(t('txPgBackground'), t('txPgBackgroundDone'), {
      actions: [{ label: t('queueShow'), onSelect: () => bus.emit('queue:open', {}) }],
    });
    close();
  });
  const cancelBtn = toolButton('close', 'txCancelItem', () => {
    if (actionBusy) return;
    actionBusy = true;
    setStatus(t('txPgCancelling'));
    paint();
    run(async () => {
      const item = currentItem();
      await queueModel.cancel(itemId);
      notify.info(t('queueTitle'), t('txPgCancelled', item ? item.source : itemId));
      close();
    });
  });

  const speedBtn = h('button', { type: 'button', class: 'tx-q-once' });
  bindText(speedBtn, 'txPgSpeedLimit', { attr: 'aria-label' });
  attachMenuButton(speedBtn, () => SPEED_PRESETS.map((bps) => ({
    label: bps ? formatSpeedLimit(bps) : t('txUnlimited'),
    checked: (currentItem()?.cpsLimit || 0) === bps,
    radio: true,
    onSelect: () => run(() => queueModel.setSpeed(itemId, bps)),
  })).concat([
    { separator: true },
    { labelKey: 'custom', icon: 'tune', onSelect: () => promptSpeedLimit() },
  ]), { placement: 'top-start' });

  const onceBtn = h('button', { type: 'button', class: 'tx-q-once' });
  bindText(onceBtn, 'txPgOnceFinished', { attr: 'aria-label' });
  attachMenuButton(onceBtn, () => [
    { labelKey: 'txOnceEmptyNone', checked: onceValue() === 'none', radio: true, onSelect: () => setOnce('none') },
    { labelKey: 'txOnceEmptyDisconnect', checked: onceValue() === 'disconnect', radio: true, onSelect: () => setOnce('disconnect') },
    { labelKey: 'txOnceEmptySuspend', disabled: true, description: t('txPowerUnsupported'), onSelect: () => {} },
    { labelKey: 'txOnceEmptyShutdown', disabled: true, description: t('txPowerUnsupported'), onSelect: () => {} },
  ], { placement: 'top-start' });

  const toolbar = h('div', { class: 'tx-q-toolbar', role: 'toolbar', 'aria-label': t('txPgTitle') },
    pauseBtn, skipBtn, cancelBtn, h('span', { class: 'tx-q-sep' }),
    speedBtn, onceBtn, h('span', { class: 'spacer' }), backgroundBtn);

  const closeBtn = h('button', { type: 'button', class: 'icon-btn', onclick: () => close() }, icon('close', 18));
  bindText(closeBtn, 'close', { attr: 'aria-label' });
  bindText(closeBtn, 'close', { attr: 'title' });

  const root = h('div', {
    class: 'tx-pg-window surface-3', role: 'dialog', 'aria-modal': 'false',
    'aria-labelledby': titleId, tabindex: '-1',
  },
  h('header', { class: 'nc-head' },
    icon('swap_vert', 18),
    h('span', { class: 'nc-head-title', id: titleId }, t('txPgTitle')),
    closeBtn),
  h('div', { class: 'tx-pg' },
    sourceLine.element, targetLine.element, currentLine.element, status,
    labelled('txPgTotal', totalBar.element),
    labelled('txPgFile', fileBar.element),
    statsGrid,
    graph),
  toolbar);
  appearanceTarget(root, 'progress-window', 'Transfer progress window');

  layer('popover').appendChild(root);

  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
  });

  const startedAt = Date.now();
  let disposed = false;
  let actionBusy = false;
  let lastPaintState = null;

  function setStatus(message, error = false) {
    status.textContent = message || '';
    status.hidden = !message;
    status.setAttribute('aria-live', error ? 'assertive' : 'polite');
  }

  function currentItem() { return queueModel.item(itemId); }

  function paint() {
    if (disposed) return;
    const item = currentItem();
    paintToolbar(item);
    if (!item) {
      lastPaintState = null;
      sourceLine.set(t('txPgNoItem'), false);
      targetLine.set('—', false);
      currentLine.set('—', false);
      for (const s of Object.values(stats)) s.set('—');
      totalBar.set(0);
      fileBar.set(0);
      graphBox.hidden = true;
      graphEmpty.hidden = false;
      graphCaption.textContent = '';
      if (!actionBusy) setStatus('');
      return;
    }
    if (lastPaintState !== item.state) {
      if (item.state === 'done') setStatus(t('txPgFinished'));
      else if (item.state === 'error') setStatus(t('txPgFinishedWithErrors'), true);
      else if (!actionBusy) setStatus('');
      lastPaintState = item.state;
    }
    const p = item.progress || {};
    sourceLine.set(item.source || '—');
    targetLine.set(item.target || '—');
    currentLine.set(p.currentFile || '—');

    const total = progressFraction(p.bytes, p.total);
    totalBar.set(total);
    // Per-file progress: the engine reports whole files done plus the bytes of
    // the file in flight, so the file bar is the remainder inside the step.
    const perFile = p.filesTotal > 0 ? 1 / p.filesTotal : 0;
    const doneShare = p.filesTotal > 0 ? (p.filesDone || 0) / p.filesTotal : 0;
    fileBar.set(perFile > 0 ? Math.min(1, Math.max(0, (total - doneShare) / perFile)) : total);

    const eta = Number.isFinite(p.eta) ? p.eta : etaSeconds(p.total, p.bytes, p.cps);
    const elapsed = Math.round(((item.finishedAt || Date.now()) - (item.startedAt || startedAt)) / 1000);
    stats.start.set(new Date(item.startedAt || startedAt).toLocaleTimeString());
    stats.elapsed.set(formatClock(elapsed));
    stats.left.set(formatEta(eta));
    stats.speed.set(formatSpeed(p.cps || 0));
    stats.bytes.set(`${formatBytes(p.bytes || 0)} / ${formatBytes(p.total || 0)}`);
    stats.files.set(`${p.filesDone || 0} / ${p.filesTotal || 0}`);

    const series = queueModel.throughputFor(itemId);
    const values = series.map((s) => s.cps);
    const path = sparklinePath(values, 240, 60);
    graphPath.setAttribute('d', path);
    graphBox.hidden = !path;
    graphEmpty.hidden = !!path;
    graphCaption.textContent = path
      ? `${t('txPgPeak', formatSpeed(throughputPeak(series)))} · ${t('txPgAverage', formatSpeed(throughputAverage(series)))}`
      : '';
  }

  /** Painted for every state, including "no item": a blank button has no name. */
  function paintToolbar(item) {
    const paused = item?.state === 'paused';
    clear(pauseBtn);
    pauseBtn.append(icon(paused ? 'sync_alt' : 'pending', 18));
    pauseBtn.setAttribute('aria-label', t(paused ? 'resume' : 'suspend'));
    pauseBtn.title = pauseBtn.getAttribute('aria-label');
    pauseBtn.disabled = !item;

    const canSkip = item?.state === 'query';
    const terminal = item?.state === 'done' || item?.state === 'error' || item?.state === 'cancelled';
    skipBtn.disabled = !canSkip;
    skipBtn.title = canSkip ? t('txPgSkipFile') : t('txPgSkipUnavailable');
    cancelBtn.disabled = !item || terminal;
    cancelBtn.disabled = cancelBtn.disabled || actionBusy;
    speedBtn.disabled = !item || terminal;
    pauseBtn.disabled = !item || terminal;
    backgroundBtn.disabled = !item || terminal;

    const limit = item?.cpsLimit || 0;
    clear(speedBtn);
    speedBtn.append(icon('tune', 15),
      h('span', {}, `${t('txPgSpeedLimit')}: ${limit ? formatSpeedLimit(limit) : t('txUnlimited')}`));
    speedBtn.title = speedBtn.textContent;

    clear(onceBtn);
    onceBtn.append(icon('playlist', 15), h('span', {}, `${t('txPgOnceFinished')}: ${t(onceLabelKey())}`));
    onceBtn.title = onceBtn.textContent;
  }

  function onceValue() { return transferPref('queue.onceEmpty', 'none') || 'none'; }
  function onceLabelKey() {
    return onceValue() === 'disconnect' ? 'txOnceEmptyDisconnect' : 'txOnceEmptyNone';
  }
  function setOnce(value) {
    setTransferPref('queue.onceEmpty', value, 'Changed the once-finished action').then(paint);
    paint();
  }

  function run(fn) {
    Promise.resolve().then(fn).then(() => {
      actionBusy = false;
      paint();
    }).catch((err) => {
      actionBusy = false;
      const message = err?.message || String(err || 'Unknown error');
      setStatus(t('txPgActionFailed', message), true);
      notify.error(t('txPgTitle'), message);
      paint();
    });
  }

  function skipCurrentFile() {
    const item = currentItem();
    if (!item || item.state !== 'query') {
      // Never offer a button that would do nothing: say why it cannot act.
      notify.warning(t('txPgSkipFile'), t('txPgSkipUnavailable'));
      return;
    }
    run(async () => {
      await queueModel.answerQuery(itemId, 'skip');
      announce(t('txPgSkipFile'));
    });
  }

  function promptSpeedLimit() {
    // Entering a number IS a decision the transfer waits on, so this one is a
    // real modal — unlike the progress window around it.
    const input = h('input', { type: 'text', class: 'field-input', spellcheck: 'false', id: uid('tx-pg-speed') });
    const item = currentItem();
    input.value = item?.cpsLimit ? String(Math.round(item.cpsLimit / 1024)) : '';
    const err = h('p', { class: 'tx-ov-error', hidden: true, role: 'alert' });
    openModal({
      title: t('txPgSpeedLimit'),
      width: 420,
      content: h('div', { class: 'stack' },
        h('label', { class: 'field', for: input.id },
          h('span', { class: 'field-label' }, t('speedLimit')), input),
        err),
      actions: [
        { label: t('cancel'), kind: 'text' },
        {
          label: t('apply'),
          kind: 'filled',
          autofocus: true,
          onSelect: (closeModal) => {
            const bps = parseSpeedLimit(input.value);
            if (bps === null) { err.hidden = false; err.textContent = t('invalidPattern', input.value); return true; }
            run(() => queueModel.setSpeed(itemId, bps));
            closeModal();
            return true;
          },
        },
      ],
    });
  }

  const unsubscribe = queueModel.subscribe(() => {
    // Following the running item keeps the window useful when the queue moves
    // on: without it the window would sit on a finished transfer for ever.
    if (!queueModel.item(itemId) && !id) {
      const next = firstRunningId();
      if (next) itemId = next;
    }
    paint();
  });

  const ticker = setInterval(paint, 500);

  function close() {
    if (disposed) return;
    disposed = true;
    clearInterval(ticker);
    unsubscribe();
    root.remove();
    // The key the window was REGISTERED under, not whatever item it drifted to
    // while following the queue — deleting the wrong one leaves the original id
    // mapped to a destroyed handle, and openProgressDialog() for that item then
    // focuses a detached element and appears to do nothing at all.
    openWindows.delete(registeredId);
    restoreFocus();
  }

  const handle = { element: root, close, focus: () => root.focus(), get itemId() { return itemId; } };
  const registeredId = itemId;
  openWindows.set(registeredId, handle);
  paint();
  requestAnimationFrame(() => root.focus());
  return handle;
}

function firstRunningId() {
  const items = queueModel.snapshot.items;
  const running = items.find((i) => i.state === 'active' || i.state === 'query' || i.state === 'prompt');
  return (running || items.find((i) => i.state !== 'done' && i.state !== 'error') || items[0] || {}).id || null;
}

/* ------------------------------------------------------------------ */
/* small pieces                                                        */
/* ------------------------------------------------------------------ */

function statLine(labelKey) {
  const value = h('span', { class: 'tx-pg-line-value' });
  const label = h('span', {});
  bindText(label, labelKey);
  const element = h('div', { class: 'tx-pg-line' }, label, value);
  return {
    element,
    /** `path` renders through pathCell so the file name survives the ellipsis. */
    set(text, isPath = true) {
      clear(value);
      value.title = String(text ?? '');
      if (isPath && /[/\\]/.test(String(text ?? ''))) value.appendChild(pathCell(text));
      else value.textContent = String(text ?? '');
    },
  };
}

function statCard(labelKey) {
  const value = h('div', { class: 'tx-pg-stat-value' }, '—');
  const label = h('div', { class: 'tx-pg-stat-label' });
  bindText(label, labelKey);
  const element = h('div', { class: 'tx-pg-stat' }, label, value);
  appearanceTarget(element, `progress-stat-${labelKey}`, `Progress statistic: ${labelKey}`);
  return { element, set(text) { value.textContent = text; } };
}

function progressBar(isFile) {
  const fill = h('div', { class: 'tx-pg-bar-fill' });
  const element = h('div', {
    class: `tx-pg-bar${isFile ? ' is-file' : ''}`, role: 'progressbar',
    'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0',
  }, fill);
  return {
    element,
    set(fraction) {
      const pct = Math.round(Math.min(1, Math.max(0, fraction || 0)) * 100);
      fill.style.width = `${pct}%`;
      element.setAttribute('aria-valuenow', String(pct));
      element.setAttribute('aria-valuetext', formatPercent(fraction || 0));
    },
  };
}

function labelled(labelKey, node) {
  const label = h('span', { class: 'tx-pg-stat-label', id: uid('tx-pg-label') });
  bindText(label, labelKey);
  node.setAttribute('aria-labelledby', label.id);
  return h('div', { class: 'stack', style: { gap: '4px' } }, label, node);
}

function toolButton(glyph, labelKey, onSelect) {
  const btn = h('button', { type: 'button', class: 'icon-btn tx-q-tool', onclick: onSelect }, icon(glyph, 18));
  bindText(btn, labelKey, { attr: 'aria-label' });
  bindText(btn, labelKey, { attr: 'title' });
  appearanceTarget(btn, `progress-tool-${labelKey}`, `Progress toolbar: ${labelKey}`);
  return btn;
}

/* ------------------------------------------------------------------ */
/* wiring                                                              */
/* ------------------------------------------------------------------ */

bus.on('queue:openProgress', (payload) => openProgressDialog(payload || {}));

registerCommand({
  id: 'queue.progress',
  labelKey: 'txPgTitle',
  icon: 'wysiwyg',
  run: (payload) => openProgressDialog(payload || {}),
});

/**
 * The window chrome (`.tx-pg-window`) lives in ui/queue.js's shared sheet
 * because the keep-up-to-date window uses the same shell. Only the throughput
 * graph's own rules are here.
 */
const PROGRESS_CSS = `
.tx-pg-graph { color: var(--p); }
.tx-pg-graph .tx-pg-stat-label { color: var(--onsv); }
.tx-pg-line-value { display: flex; min-width: 0; flex: 1 1 auto; }
`;

let extraInjected = false;
function injectProgressStyles() {
  if (extraInjected || typeof document === 'undefined') return;
  extraInjected = true;
  const el = document.createElement('style');
  el.id = 'sheet-transfer-progress';
  el.textContent = PROGRESS_CSS;
  document.head.appendChild(el);
}
