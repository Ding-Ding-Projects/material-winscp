// queue.js — the transfer queue.
//
// A port of core/Queue.cpp (TTerminalQueue / TQueueItem) onto the Adapter
// contract, so one engine drives uploads, downloads and remote-to-remote
// copies over every protocol.
//
// The queue is deliberately headless: it owns no windows and does no I/O of
// its own, it only pumps items and emits events. That is what makes it
// testable — `test/queue.test.js` runs a real transfer between two in-memory
// adapters, throttle and all.
//
// The parts that look fussy are the parts that bite in production:
//
//  * Resume writes to `<name>.filepart` and renames on success, so an aborted
//    transfer never leaves a truncated file that looks complete.
//  * A dropped connection does NOT restart the item. The partial file and the
//    entry index survive, a 'reconnect' event asks the session manager to
//    re-establish the link, and the item picks up where it stopped.
//  * The speed limit is a virtual-time token bucket rather than a sleep after
//    every chunk, because the latter drifts badly once several chunks are in
//    flight for one file.
//  * Text mode converts across chunk boundaries. A '\r' that lands as the last
//    byte of a chunk is held back until the next one arrives, otherwise every
//    64KB boundary in a CRLF file corrupts one line ending.
'use strict';

const { EventEmitter } = require('events');
const { finished } = require('stream/promises');

const { FileMask } = require('./masks');
const { COPY_PARAM_DEFAULTS, PREF_DEFAULTS } = require('./defaults');
// The overwrite decision (ConfirmFileOverwrite / EffectiveBatchOverwrite) and
// the robust retry substrate live in transfer.js, the port of Terminal.cpp's
// transfer half. The queue moves the bytes; that module decides what happens
// to a file that is already there.
const T = require('./transfer');

const STATES = ['queued', 'active', 'paused', 'done', 'error', 'query', 'prompt'];

/** Characters Windows refuses in a file name, replaced on the way down. */
const LOCAL_INVALID_CHARS = '/\\:*?"<>|';

/** Answers the UI may give to an overwrite query. */
const OVERWRITE_ANSWERS = ['overwrite', 'resume', 'append', 'skip', 'rename',
  'overwrite-all', 'skip-all', 'newer-only'];

const BOM = Buffer.from([0xEF, 0xBB, 0xBF]);
const CTRL_Z = 0x1A;

let idCounter = 0;
function newId() {
  idCounter += 1;
  return `q${Date.now().toString(36)}${idCounter.toString(36)}`;
}

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * A connection failure rather than a file-level failure. Only these are worth
 * reconnecting for; a "permission denied" would just fail again.
 */
const CONNECTION_ERROR_CODES = new Set([
  'ECONNRESET', 'ECONNABORTED', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT',
  'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'ENOTCONN', 'ESOCKETTIMEDOUT',
]);

function isConnectionError(err) {
  if (!err) return false;
  if (err.connectionLost === true) return true;
  if (CONNECTION_ERROR_CODES.has(err.code)) return true;
  return /connection (lost|closed|reset|refused)|not connected|socket hang up/i.test(err.message || '');
}

// ---------------------------------------------------------------------------
// small primitives
// ---------------------------------------------------------------------------

/**
 * Virtual-time token bucket. `take(n)` reserves the transmission slot for n
 * bytes and resolves when that slot arrives, so several concurrent chunk
 * writers of one file share a single limit exactly instead of each sleeping
 * for its own deficit.
 */
class Throttle {
  constructor(rate) {
    this.rate = rate > 0 ? rate : 0;
    this.available = Date.now();
  }

  setRate(rate) {
    this.rate = rate > 0 ? rate : 0;
    if (!this.rate) this.available = Date.now();
  }

  async take(n) {
    if (!this.rate || n <= 0) return;
    const now = Date.now();
    if (this.available < now) this.available = now;
    this.available += (n / this.rate) * 1000;
    const wait = this.available - Date.now();
    if (wait > 0) await sleep(wait);
  }
}

/** A latch the transfer loop waits on while the item (or the queue) is paused. */
class Gate {
  constructor(open = true) {
    this._open = open;
    this._waiters = [];
  }

  get isOpen() { return this._open; }

  open() {
    this._open = true;
    const w = this._waiters;
    this._waiters = [];
    for (const resolve of w) resolve();
  }

  close() { this._open = false; }

  async wait() {
    if (this._open) return;
    await new Promise((resolve) => { this._waiters.push(resolve); });
  }
}

/**
 * LF <-> CRLF conversion plus the two WinSCP text-mode scrubbers.
 * Stateful on purpose: chunk boundaries must not change the result.
 */
class TextConverter {
  constructor(targetEol, { removeBOM = false, removeCtrlZ = false } = {}) {
    this.crlf = targetEol === 'crlf';
    this.removeBOM = removeBOM;
    this.removeCtrlZ = removeCtrlZ;
    this.first = true;
    this.pendingCR = false;   // a trailing '\r' whose partner may be next chunk
    this.pendingZ = false;    // a trailing 0x1A that may be the very last byte
  }

  convert(chunk) {
    let buf = chunk;
    if (this.pendingZ) { buf = Buffer.concat([Buffer.from([CTRL_Z]), buf]); this.pendingZ = false; }
    if (this.pendingCR) { buf = Buffer.concat([Buffer.from([0x0D]), buf]); this.pendingCR = false; }

    if (this.first) {
      this.first = false;
      if (this.removeBOM && buf.length >= 3 && buf.subarray(0, 3).equals(BOM)) buf = buf.subarray(3);
    }

    // Hold back a trailing CR: we cannot tell yet whether it is a lone CR or
    // the first half of a CRLF that straddles the chunk boundary.
    if (buf.length && buf[buf.length - 1] === 0x0D) {
      this.pendingCR = true;
      buf = buf.subarray(0, buf.length - 1);
    }
    // Same for a trailing Ctrl+Z, which only gets dropped if it ends the file.
    if (this.removeCtrlZ && buf.length && buf[buf.length - 1] === CTRL_Z) {
      this.pendingZ = true;
      buf = buf.subarray(0, buf.length - 1);
    }

    return this._translate(buf);
  }

  flush() {
    const tail = [];
    if (this.pendingCR) tail.push(0x0D);
    // A trailing Ctrl+Z at the true end of the file is what removeCtrlZ drops.
    if (this.pendingZ && !this.removeCtrlZ) tail.push(CTRL_Z);
    this.pendingCR = false;
    this.pendingZ = false;
    return tail.length ? this._translate(Buffer.from(tail)) : Buffer.alloc(0);
  }

  _translate(buf) {
    if (!buf.length) return buf;
    // Normalize to LF (drop the CR of every CRLF), then expand back to CRLF if
    // that is what the target wants. Worst case one extra byte per input byte.
    const out = Buffer.allocUnsafe(buf.length * 2);
    let n = 0;
    for (let i = 0; i < buf.length; i++) {
      const b = buf[i];
      if (b === 0x0D && buf[i + 1] === 0x0A) continue;       // CR of a CRLF
      if (b === 0x0A && this.crlf) { out[n++] = 0x0D; out[n++] = 0x0A; continue; }
      out[n++] = b;
    }
    return out.subarray(0, n);
  }
}

/** Writes to a stream with backpressure and surfaces a stream error promptly. */
class StreamWriter {
  constructor(ws) {
    this.ws = ws;
    this.error = null;
    this._onError = (e) => { this.error = e; };
    ws.on('error', this._onError);
  }

  async write(chunk) {
    if (this.error) throw this.error;
    if (!chunk.length) return;
    if (!this.ws.write(chunk)) {
      await new Promise((resolve, reject) => {
        const onDrain = () => { cleanup(); resolve(); };
        const onError = (e) => { cleanup(); reject(e); };
        const cleanup = () => {
          this.ws.removeListener('drain', onDrain);
          this.ws.removeListener('error', onError);
        };
        this.ws.on('drain', onDrain);
        this.ws.on('error', onError);
      });
    }
    if (this.error) throw this.error;
  }

  async end() {
    this.ws.end();
    await finished(this.ws);
    this.ws.removeListener('error', this._onError);
    if (this.error) throw this.error;
  }

  destroy() {
    this.ws.removeListener('error', this._onError);
    try { this.ws.destroy(); } catch { /* already gone */ }
  }
}

// ---------------------------------------------------------------------------
// copy-param helpers (ports of TCopyParamType)
// ---------------------------------------------------------------------------

/** ValidLocalFileName: the target is a Windows file system, so scrub the name. */
function validLocalFileName(name, replacement) {
  const rep = replacement || '_';
  let out = '';
  for (const ch of name) {
    const code = ch.codePointAt(0);
    out += (LOCAL_INVALID_CHARS.includes(ch) || code < 32) ? rep : ch;
  }
  // Windows silently strips a trailing dot or space, which would make the
  // round trip lossy; replace them instead so the name stays distinguishable.
  out = out.replace(/[. ]+$/, (m) => rep.repeat(m.length));
  return out === '' ? rep : out;
}

/** ChangeFileName: case conversion, then invalid-character replacement. */
function changeFileName(name, copyParam, toLocal) {
  let out = name;
  switch (copyParam.fileNameCase) {
    case 'upper': out = out.toUpperCase(); break;
    case 'lower': out = out.toLowerCase(); break;
    case 'firstUpper': out = out.slice(0, 1).toUpperCase() + out.slice(1).toLowerCase(); break;
    default: break;
  }
  if (toLocal && copyParam.replaceInvalidChars) {
    out = validLocalFileName(out, copyParam.invalidCharsReplacement);
  }
  return out;
}

/** AllowResume: 'on' always, 'off' never, 'smart' above the threshold. */
function allowResume(copyParam, size, fileName) {
  if ((fileName || '').length + (copyParam.partialFileExt || '').length > 255) return false;
  switch (copyParam.resumeSupport) {
    case 'on': return true;
    case 'off': return false;
    case 'smart': return size >= copyParam.resumeThreshold;
    default: return false;
  }
}

/** UseAsciiTransfer: 'automatic' consults the asciiFileMask. */
function useTextMode(copyParam, name, params, asciiMask) {
  switch (copyParam.transferMode) {
    case 'text': return true;
    case 'binary': return false;
    case 'automatic': return asciiMask.matches(name, params);
    default: return false;
  }
}

// ---------------------------------------------------------------------------
// the queue
// ---------------------------------------------------------------------------

class TransferQueue extends EventEmitter {
  /**
   * options:
   *   prefs           the application preferences (defaults.js shape)
   *   progressMs      minimum interval between 'progress' events (default 250)
   *   maxReconnects   reconnect attempts per item before it errors (default 5)
   */
  constructor(options = {}) {
    super();
    this.prefs = options.prefs || PREF_DEFAULTS;
    const qp = { ...PREF_DEFAULTS.queue, ...(this.prefs.queue || {}) };
    this.queuePrefs = qp;

    this.items = [];
    this.enabled = qp.enabledByDefault !== false;
    this.paused = false;
    this.transfersLimit = qp.transfersLimit || 2;
    this.onceDone = qp.onceEmpty || 'none';
    this.progressMs = options.progressMs === undefined ? 250 : options.progressMs;
    this.maxReconnects = options.maxReconnects === undefined ? 5 : options.maxReconnects;

    this._active = new Set();
    this._globalGate = new Gate(true);
    this._idleWaiters = [];
    this._pumping = false;
    this._wasIdle = true;
  }

  // ---- item management -------------------------------------------------

  /**
   * Queue one transfer.
   *
   * spec:
   *   side           'upload' | 'download' | 'remote-copy'
   *   source         full path on the source adapter
   *   target         full path on the target adapter, or a directory when
   *                  `targetIsDir` is true / `target` ends with a separator
   *   sourceAdapter  Adapter to read from
   *   targetAdapter  Adapter to write to
   *   copyParam      partial TCopyParamType, merged over COPY_PARAM_DEFAULTS
   *   session        opaque handle passed back on 'reconnect'
   */
  add(spec) {
    const copyParam = { ...COPY_PARAM_DEFAULTS, ...(spec.copyParam || {}) };
    const item = {
      id: spec.id || newId(),
      side: spec.side || 'upload',
      source: spec.source,
      target: spec.target,
      targetIsDir: spec.targetIsDir === undefined
        ? /[/\\]$/.test(String(spec.target || '')) : !!spec.targetIsDir,
      sourceAdapter: spec.sourceAdapter,
      targetAdapter: spec.targetAdapter,
      session: spec.session || null,
      copyParam,
      cpsLimit: copyParam.cpsLimit || 0,
      state: 'queued',
      error: null,
      addedAt: Date.now(),
      startedAt: 0,
      finishedAt: 0,
      progress: {
        bytes: 0, total: 0, cps: 0, eta: null,
        filesDone: 0, filesTotal: 0, currentFile: '',
      },
      // internal
      _gate: new Gate(true),
      _throttle: new Throttle(copyParam.cpsLimit || 0),
      _plan: null,
      _entryIndex: 0,
      _reconnects: 0,
      _pendingQuery: null,
      _pendingPrompt: null,
      // "Yes to all" / "Skip all" / "only newer" now live in the transfer
      // engine's progress object (TFileOperationProgressType::BatchOverwrite),
      // built on first use by _overwriteEngine.
      _overwriteEngine: null,
      _overwriteProgress: null,
      _pendingRename: '',
      _pendingAppendOrResume: null,
      _currentEntry: null,
      _currentTargetPath: '',
      _currentExisting: null,
      _cancelled: false,
      _cpsWindow: [],
      _lastProgressAt: 0,
      _bytesDone: 0,
      skipped: [],
    };
    this._wasIdle = false;
    this.items.push(item);
    this.emit('item-added', this.view(item));
    this._pump();
    return item;
  }

  /** A plain, event-safe snapshot (the internals never cross the IPC bridge). */
  view(item) {
    return {
      id: item.id,
      side: item.side,
      source: item.source,
      target: item.target,
      state: item.state,
      copyParam: item.copyParam,
      cpsLimit: item.cpsLimit,
      error: item.error ? (item.error.message || String(item.error)) : null,
      addedAt: item.addedAt,
      startedAt: item.startedAt,
      finishedAt: item.finishedAt,
      progress: { ...item.progress },
      skipped: item.skipped.slice(),
    };
  }

  get(id) { return this.items.find((i) => i.id === id) || null; }

  list() { return this.items.map((i) => this.view(i)); }

  /** Move an item one place towards the front of the queue. */
  moveUp(id) { return this._move(id, -1); }

  /** Move an item one place towards the back of the queue. */
  moveDown(id) { return this._move(id, +1); }

  _move(id, delta) {
    const i = this.items.findIndex((x) => x.id === id);
    if (i < 0) return false;
    const j = i + delta;
    if (j < 0 || j >= this.items.length) return false;
    const [it] = this.items.splice(i, 1);
    this.items.splice(j, 0, it);
    this.emit('item-updated', this.view(it));
    return true;
  }

  /** Remove an item, cancelling it first if it is running. */
  remove(id) {
    const item = this.get(id);
    if (!item) return false;
    item._cancelled = true;
    item._gate.open();                 // let a paused loop notice the cancel
    if (item._pendingQuery) this.answerQuery(id, 'skip');
    const i = this.items.indexOf(item);
    this.items.splice(i, 1);
    this.emit('item-updated', { ...this.view(item), state: 'removed' });
    this._pump();
    return true;
  }

  /** "Delete all done" — clears finished items out of the list. */
  removeDone() {
    const gone = this.items.filter((i) => i.state === 'done');
    this.items = this.items.filter((i) => i.state !== 'done');
    for (const it of gone) this.emit('item-updated', { ...this.view(it), state: 'removed' });
    return gone.length;
  }

  // ---- flow control ----------------------------------------------------

  /** Enable or disable the whole queue (WinSCP's queue on/off toggle). */
  setEnabled(on) {
    this.enabled = !!on;
    if (this.enabled) this._pump();
    this.emit('queue-updated', { enabled: this.enabled, paused: this.paused });
  }

  /** Global pause. Running items stop between chunks and keep their position. */
  pauseAll() {
    this.paused = true;
    this._globalGate.close();
    for (const it of this.items) {
      if (it.state === 'active') this._setState(it, 'paused');
    }
    this.emit('queue-updated', { enabled: this.enabled, paused: true });
  }

  resumeAll() {
    this.paused = false;
    this._globalGate.open();
    for (const it of this.items) {
      if (it.state === 'paused' && it._gate.isOpen) this._setState(it, 'active');
    }
    this.emit('queue-updated', { enabled: this.enabled, paused: false });
    this._pump();
  }

  pauseItem(id) {
    const item = this.get(id);
    if (!item) return false;
    item._gate.close();
    if (item.state === 'active' || item.state === 'queued') this._setState(item, 'paused');
    return true;
  }

  resumeItem(id) {
    const item = this.get(id);
    if (!item) return false;
    item._gate.open();
    if (item.state === 'paused') {
      this._setState(item, this._active.has(item) ? 'active' : 'queued');
    }
    this._pump();
    return true;
  }

  /** Per-item speed limit in bytes/s; 0 removes it. Takes effect immediately. */
  setSpeedLimit(id, cps) {
    const item = this.get(id);
    if (!item) return false;
    item.cpsLimit = cps > 0 ? cps : 0;
    item._throttle.setRate(item.cpsLimit);
    this.emit('item-updated', this.view(item));
    return true;
  }

  setTransfersLimit(n) {
    this.transfersLimit = Math.max(1, n | 0);
    this._pump();
  }

  /** Resolves once nothing is running and nothing is waiting to run. */
  idle() {
    if (this._isIdle()) return Promise.resolve();
    return new Promise((resolve) => { this._idleWaiters.push(resolve); });
  }

  _isIdle() {
    if (this._active.size) return false;
    return !this.items.some((i) => i.state === 'queued');
  }

  // ---- query / prompt --------------------------------------------------

  /**
   * Answer an overwrite query. `answer` is one of OVERWRITE_ANSWERS; 'rename'
   * additionally takes { newName }.
   */
  answerQuery(id, answer, options = {}) {
    const item = this.get(id);
    if (!item || !item._pendingQuery) return false;
    if (!OVERWRITE_ANSWERS.includes(answer)) {
      throw new Error(`Unknown overwrite answer "${answer}". Expected one of ${OVERWRITE_ANSWERS.join(', ')}.`);
    }
    const pending = item._pendingQuery;
    item._pendingQuery = null;
    pending.resolve({ answer, ...options });
    return true;
  }

  /** Answer a credential/keyboard-interactive prompt raised during a transfer. */
  answerPrompt(id, value) {
    const item = this.get(id);
    if (!item || !item._pendingPrompt) return false;
    const pending = item._pendingPrompt;
    item._pendingPrompt = null;
    pending.resolve(value);
    return true;
  }

  _query(item, query) {
    return new Promise((resolve) => {
      item._pendingQuery = { query, resolve };
      const previous = item.state;
      this._setState(item, 'query');
      const respond = (answer, options) => {
        if (item._pendingQuery && item._pendingQuery.resolve === resolve) {
          item._pendingQuery = null;
          this._setState(item, previous === 'query' ? 'active' : previous);
          resolve({ answer, ...(options || {}) });
        }
      };
      this.emit('query', { item: this.view(item), query, respond });
    }).then((result) => {
      if (item.state === 'query') this._setState(item, 'active');
      return result;
    });
  }

  _prompt(item, prompt) {
    return new Promise((resolve) => {
      item._pendingPrompt = { prompt, resolve };
      this._setState(item, 'prompt');
      const respond = (value) => {
        if (item._pendingPrompt && item._pendingPrompt.resolve === resolve) {
          item._pendingPrompt = null;
          resolve(value);
        }
      };
      this.emit('prompt', { item: this.view(item), prompt, respond });
    }).then((value) => {
      if (item.state === 'prompt') this._setState(item, 'active');
      return value;
    });
  }

  // ---- the pump --------------------------------------------------------

  _setState(item, state) {
    if (!STATES.includes(state)) throw new Error(`Unknown queue item state "${state}"`);
    if (item.state === state) return;
    item.state = state;
    // A session transfer borrows the byte mover without ever being queued (see
    // `moveBytes`). Announcing its state would add a row to the queue panel for
    // an item `queue:list` does not contain, which the panel could then never
    // pause, cancel or remove.
    if (!this.items.includes(item)) return;
    this.emit('item-updated', this.view(item));
  }

  _pump() {
    if (this._pumping) return;
    this._pumping = true;
    try {
      while (this.enabled && !this.paused && this._active.size < this.transfersLimit) {
        const next = this.items.find((i) => i.state === 'queued' && i._gate.isOpen && !i._cancelled);
        if (!next) break;
        this._active.add(next);
        // Deliberately not awaited: several items run in parallel, bounded by
        // transfersLimit. Every failure path inside _run resolves the promise.
        this._run(next).finally(() => {
          this._active.delete(next);
          this._pump();
          this._checkIdle();
        });
      }
    } finally {
      this._pumping = false;
    }
    this._checkIdle();
  }

  _checkIdle() {
    if (!this._isIdle()) { this._wasIdle = false; return; }
    const waiters = this._idleWaiters;
    this._idleWaiters = [];
    for (const w of waiters) w();
    // Only announce the edge: the pump calls this after every item, and a
    // "queue is empty, now shut the machine down" event must fire once.
    if (!this._wasIdle) {
      this._wasIdle = true;
      this.emit('idle', { onceDone: this._onceDoneAction() });
    }
  }

  /**
   * "Once done" — the action to take when the queue drains. An item that asked
   * for something specific wins over the global preference, matching WinSCP's
   * per-transfer "on completion" combo.
   */
  _onceDoneAction() {
    for (const it of this.items) {
      const a = it.copyParam.onceDoneOperation;
      if (a && a !== 'none') return a;
    }
    return this.onceDone || 'none';
  }

  // ---- running one item ------------------------------------------------

  async _run(item) {
    item.startedAt = item.startedAt || Date.now();
    for (;;) {
      try {
        this._setState(item, 'active');
        await this._runOnce(item);
        if (item._cancelled) return;
        item.finishedAt = Date.now();
        this._setState(item, 'done');
        this.emit('item-done', this.view(item));
        return;
      } catch (err) {
        if (item._cancelled) return;
        if (isConnectionError(err) && item._reconnects < this.maxReconnects) {
          item._reconnects += 1;
          this._setState(item, 'queued');
          const ok = await this._askReconnect(item, err);
          if (ok) continue;          // partial file + entry index are intact
        }
        item.error = err;
        item.finishedAt = Date.now();
        this._setState(item, 'error');
        this.emit('item-error', { item: this.view(item), error: err });
        return;
      }
    }
  }

  /**
   * Ask the session manager to re-establish the connection. The listener calls
   * `retry()` once the adapter is usable again (or `fail()` to give up); with
   * no listener we simply back off and try again, because a transient network
   * blip does not need a supervisor.
   */
  _askReconnect(item, error) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (ok) => { if (!settled) { settled = true; resolve(ok); } };
      const listeners = this.listenerCount('reconnect');
      this.emit('reconnect', {
        item: this.view(item),
        session: item.session,
        error,
        attempt: item._reconnects,
        retry: () => done(true),
        fail: () => done(false),
      });
      if (!listeners) {
        const backoff = Math.min(30000, 500 * (2 ** (item._reconnects - 1)));
        setTimeout(() => done(true), backoff);
      }
    });
  }

  async _runOnce(item) {
    const src = item.sourceAdapter;
    const dst = item.targetAdapter;
    if (!src || !dst) throw new Error('A queue item needs both a source and a target adapter.');

    const onPrompt = (prompt, respond) => {
      this._prompt(item, prompt).then((v) => { if (respond) respond(v); }).catch(() => {});
    };
    if (typeof src.on === 'function') src.on('prompt', onPrompt);
    if (typeof dst.on === 'function' && dst !== src) dst.on('prompt', onPrompt);

    try {
      if (!item._plan) {
        item._plan = await this._buildPlan(item);
        item.progress.total = item._plan.bytes;
        item.progress.filesTotal = item._plan.files;
        this.emit('item-updated', this.view(item));
      }
      const entries = item._plan.entries;
      while (item._entryIndex < entries.length) {
        if (item._cancelled) return;
        await this._waitRunnable(item);
        if (item._cancelled) return;
        const entry = entries[item._entryIndex];
        // Reset the byte counter to the "all previous entries done" mark, so a
        // retried entry re-counts its own bytes instead of adding to them.
        item.progress.bytes = item._bytesDone;
        if (entry.kind === 'dir') {
          await this._makeDirectory(item, entry);
        } else {
          await this._transferFile(item, entry);
          item._bytesDone += entry.size;
          item.progress.bytes = item._bytesDone;
        }
        item._entryIndex += 1;
      }
    } finally {
      if (typeof src.removeListener === 'function') src.removeListener('prompt', onPrompt);
      if (typeof dst.removeListener === 'function' && dst !== src) dst.removeListener('prompt', onPrompt);
    }
  }

  /** Block while either the item or the whole queue is paused. */
  async _waitRunnable(item) {
    while (!item._cancelled && (!item._gate.isOpen || !this._globalGate.isOpen)) {
      if (item.state === 'active') this._setState(item, 'paused');
      // Wait on whichever gate is actually shut; racing both would leave a
      // dangling waiter parked on the one that never opens.
      if (!item._gate.isOpen) await item._gate.wait();
      else await this._globalGate.wait();
    }
    if (!item._cancelled && item.state === 'paused') this._setState(item, 'active');
  }

  // ---- planning --------------------------------------------------------

  /**
   * Walk the source and produce the ordered entry list.
   *
   * Ordering rule: a directory entry always precedes everything inside it, and
   * inside one directory the plain files come before the subdirectories. That
   * keeps the target tree valid at every point (you never write into a
   * directory that does not exist yet) and makes progress move steadily rather
   * than stalling while the deepest branch is walked.
   */
  async _buildPlan(item) {
    const src = item.sourceAdapter;
    const dst = item.targetAdapter;
    const cp = item.copyParam;
    const toLocal = item.side === 'download';
    const mask = new FileMask(cp.includeFileMask, { root: item.source });

    const entries = [];
    let bytes = 0;
    let files = 0;

    const rootStat = await src.stat(item.source);
    const rootIsDir = rootStat.type === 'dir';
    const targetPath = item.targetIsDir
      ? dst.join(item.target, changeFileName(src.basename(item.source), cp, toLocal))
      : item.target;

    const walk = async (srcPath, dstPath, info) => {
      if (info.isDir) {
        entries.push({
          kind: 'dir', srcPath, dstPath, mtime: info.mtime || 0, rights: info.rights || '',
        });
        const listing = await src.list(srcPath);
        const kids = listing.filter((e) => e.name !== '.' && e.name !== '..');
        // files first, then directories — see the ordering rule above
        kids.sort((a, b) => {
          const ad = a.type === 'dir' ? 1 : 0;
          const bd = b.type === 'dir' ? 1 : 0;
          if (ad !== bd) return ad - bd;
          return a.name.localeCompare(b.name);
        });
        for (const e of kids) {
          if (cp.excludeHiddenFiles && e.hidden) continue;
          const childSrc = src.join(srcPath, e.name);
          let isDir = e.type === 'dir';
          if (e.isSymlink && isDir && !cp.followDirectorySymlinks) continue;
          if (e.type === 'link' && cp.followDirectorySymlinks) {
            try {
              const st = await src.stat(childSrc);
              isDir = st.type === 'dir';
            } catch { isDir = false; }
          }
          if (!mask.matches(e.name, {
            isDir, size: e.size, mtime: e.mtime, path: childSrc, root: item.source,
          })) continue;
          const childDst = dst.join(dstPath, changeFileName(e.name, cp, toLocal));
          await walk(childSrc, childDst, {
            isDir, size: e.size, mtime: e.mtime, rights: e.rights, readOnly: e.readOnly,
          });
        }
      } else {
        entries.push({
          kind: 'file',
          srcPath,
          dstPath,
          size: info.size || 0,
          mtime: info.mtime || 0,
          rights: info.rights || '',
          readOnly: !!info.readOnly,
        });
        files += 1;
        bytes += info.size || 0;
      }
    };

    await walk(item.source, targetPath, {
      isDir: rootIsDir,
      size: rootStat.size,
      mtime: rootStat.mtime,
      rights: rootStat.rights,
    });

    if (cp.excludeEmptyDirectories) {
      // Drop directory entries that ended up with nothing under them. The root
      // entry stays only if the whole transfer has at least one file in it.
      //
      // The separator comes from the TARGET adapter, not from a literal '/'.
      // Every dstPath in the plan was built by `dst.join`, and the target of a
      // DOWNLOAD is protocols/local.js, whose `sep` is '\' on Windows. Testing
      // against '/' there made the predicate false for every directory —
      // including ones packed with files — so every kind:'dir' entry was
      // pruned. `_run` only mkdirs from kind:'dir' entries and LocalAdapter's
      // createWriteStream does not create parents, so the whole download then
      // died on the first file with ENOENT. Uploads never noticed because a
      // remote adapter really is '/'-separated.
      //
      // The trailing separator is what keeps '/a/b' from swallowing '/a/bc';
      // a dstPath that already ends in one (a drive or share root) must not
      // grow a second, which would match nothing at all.
      const sep = dst.sep || '/';
      const pruned = entries.filter((e) => {
        if (e.kind !== 'dir') return true;
        const prefix = e.dstPath.endsWith(sep) ? e.dstPath : e.dstPath + sep;
        return entries.some((o) => o.kind === 'file' && o.dstPath.startsWith(prefix));
      });
      return { entries: pruned, bytes, files };
    }

    return { entries, bytes, files };
  }

  // ---- directories -----------------------------------------------------

  async _makeDirectory(item, entry) {
    const dst = item.targetAdapter;
    const cp = item.copyParam;
    try {
      await dst.mkdir(entry.dstPath);
    } catch (err) {
      // Already there is fine; anything else is real.
      if (!/exist/i.test(err.message || '') && err.code !== 'EEXIST') {
        let exists = false;
        try { exists = (await dst.stat(entry.dstPath)).type === 'dir'; } catch { exists = false; }
        if (!exists) throw err;
      }
    }
    if (cp.preserveRights && dst.caps.rights) {
      let rights = cp.rights;
      if (cp.addXToDirectories) rights = addExecute(rights);
      await this._tolerate(cp, () => dst.setRights(entry.dstPath, rights));
    }
    if (cp.preserveTimeDirs && cp.preserveTime && dst.caps.timestamp && entry.mtime) {
      await this._tolerate(cp, () => dst.setTimes(entry.dstPath, { mtime: entry.mtime, atime: entry.mtime }));
    }
  }

  async _tolerate(cp, fn) {
    try { await fn(); } catch (err) { if (!cp.ignorePermErrors) throw err; }
  }

  // ---- files -----------------------------------------------------------

  async _transferFile(item, entry) {
    const src = item.sourceAdapter;
    const dst = item.targetAdapter;
    const cp = item.copyParam;
    const toLocal = item.side === 'download';

    item.progress.currentFile = entry.srcPath;
    this._emitProgress(item, true);

    let targetPath = entry.dstPath;
    let existing = await statOrNull(dst, targetPath);

    // The transfer MODE is decided before the overwrite question, exactly as
    // Terminal.cpp does it (SelectSourceTransferMode runs before
    // FFileSystem->Source). The order is load-bearing rather than tidy: whether
    // Append may be offered at all depends on whether this file is going over
    // in text mode, because appending to a file whose line endings the far side
    // is rewriting writes at an offset that means something different on each
    // side. Deciding the mode afterwards meant the question was always asked as
    // if the transfer were binary.
    const text = useTextMode(cp, src.basename(entry.srcPath), {
      isDir: false, size: entry.size, mtime: entry.mtime, path: entry.srcPath,
    }, this._asciiMask(cp));

    let mode = 'overwrite';                       // overwrite | resume | append
    if (existing && existing.type !== 'dir') {
      const decision = await this._decideOverwrite(item, entry, targetPath, existing, text);
      if (decision.skip) { this._skip(item, entry, targetPath); return; }
      mode = decision.mode;
      if (decision.targetPath !== targetPath) {
        targetPath = decision.targetPath;
        existing = await statOrNull(dst, targetPath);
      }
    }

    // "Preserve overwritten remote files to recycle bin" — TSFTPFileSystem's
    // SFTPOpenRemote recycle (SftpFileSystem.cpp:5226-5270), which has to
    // happen HERE, before anything below can touch the target. Every route out
    // of this method destroys the existing file: the server-side copy just
    // below overwrites it, the partial-file path removes it outright before
    // renaming, and a plain write truncates it. WinSCP gets the ordering for
    // free by opening with SSH_FXF_EXCL and recycling from the failure; with
    // no exclusive-create to lean on, the port has to do it deliberately.
    //
    // Nulling `existing` afterwards is load-bearing rather than tidiness. The
    // file is gone from this name, so `_copyBytes` must not try to remove it
    // and `copyRemote` must not be told to expect it — both would fail on a
    // path that no longer exists. Only `overwrite` qualifies (WinSCP tests
    // `OverwriteMode == omOverwrite` at 5133): append and resume extend the
    // file that is already there, so nothing is being overwritten.
    let recycledRights;
    if (existing && existing.type !== 'dir' && mode === 'overwrite') {
      const r = await T.recycleOverwritten(dst, targetPath, existing,
        (item.session && item.session.data) || {},
        (msg) => this.emit('log', { id: item.id, text: msg }));
      if (r.recycled) { recycledRights = r.rights; existing = null; }
    }

    // A server-side copy never leaves the server. When both ends are the same
    // adapter and it advertises copy-file/copy-data (SFTP's copy-file and
    // copy-data extensions), duplicating a 40 GB file costs one request instead
    // of 80 GB across the wire in both directions. It is only ever taken for a
    // plain overwrite: append and resume are byte-offset operations the
    // extension does not express.
    if (item.side === 'remote-copy' && mode === 'overwrite' && !text
        && src === dst && dst.caps && dst.caps.copyRemote && typeof dst.copyRemote === 'function') {
      await dst.copyRemote(entry.srcPath, targetPath, { overwrite: !!existing });
      if (recycledRights && !cp.preserveRights && dst.caps.rights) {
        await this._tolerate(cp, () => dst.setRights(targetPath, recycledRights));
      }
      item.progress.bytes = item._bytesDone + entry.size;
      item.progress.filesDone += 1;
      this._emitProgress(item, true);
      return entry.size;
    }

    const written = await this._copyBytes(item, entry, targetPath, mode, existing, text);

    // Preserve metadata once the bytes are all there.
    if (cp.preserveTime && dst.caps.timestamp && entry.mtime) {
      await this._tolerate(cp, () => dst.setTimes(targetPath, { mtime: entry.mtime, atime: entry.mtime }));
    }
    if (cp.preserveRights && dst.caps.rights) {
      await this._tolerate(cp, () => dst.setRights(targetPath, entry.rights || cp.rights));
    } else if (recycledRights && dst.caps.rights) {
      // PreserveExistingRights (SftpFileSystem.cpp:4804, 4818-4827). The old
      // file kept its permissions on the way into the bin; the replacement
      // standing in its place gets them back, so turning the safety net on
      // does not quietly re-mode every file it protects.
      await this._tolerate(cp, () => dst.setRights(targetPath, recycledRights));
    }
    if (toLocal && cp.preserveReadOnly && entry.readOnly && dst.caps.rights) {
      await this._tolerate(cp, () => dst.setRights(targetPath, 'r--r--r--'));
    }

    item.progress.filesDone += 1;
    this._emitProgress(item, true);
    return written;
  }

  /**
   * The overwrite decision, delegated to `transfer.js`.
   *
   * That module is the port of TTerminal::ConfirmFileOverwrite and
   * EffectiveBatchOverwrite — batch mode versus the per-file question versus
   * resume versus newer-only, in WinSCP's own order. The queue used to carry a
   * simplified copy of those rules; it now asks the same code the session path
   * asks, so the two can no longer drift apart on the one decision that
   * destroys data when it is wrong.
   *
   * What stays here is the queue's own surface: the 'query' event, its answer
   * vocabulary, and the fact that a cancelled query skips the file rather than
   * killing the item.
   */
  async _decideOverwrite(item, entry, targetPath, existing, text) {
    const dst = item.targetAdapter;
    const cp = item.copyParam;
    const engine = this._overwriteEngine(item);
    const progress = item._overwriteProgress;
    // SFTPConfirmOverwrite reads AsciiTransfer off the progress object to
    // decide whether Append may be offered; claiming binary here offered Append
    // for a text-mode transfer, which corrupts the tail of the target.
    progress.asciiTransfer = !!text;
    progress.localSize = entry.size;
    progress.transferSize = entry.size;
    // The engine asks its host a question; the host builds the queue's own
    // 'query' event from these, which is how the renderer keeps seeing the
    // shape it already knows.
    item._currentEntry = entry;
    item._currentTargetPath = targetPath;
    item._currentExisting = existing;

    // cpNoConfirmation is how "confirmations are off for this queue" reaches
    // the decision; the global preference is read by the engine itself.
    let params = 0;
    if (this.queuePrefs.noConfirmations) params |= T.COPY_FLAGS.noConfirmation;
    if (cp.overwriteMode === 'append') params |= T.COPY_FLAGS.append;
    if (cp.overwriteMode === 'resume') params |= T.COPY_FLAGS.resume;

    const fileParams = new T.OverwriteFileParams({
      sourceSize: entry.size,
      sourceTimestamp: entry.mtime,
      sourcePrecision: entry.modificationFmt,
      destSize: existing.size,
      destTimestamp: existing.mtime,
      destPrecision: existing.modificationFmt,
    });

    item._pendingRename = '';
    item._pendingAppendOrResume = null;
    try {
      const result = await engine.confirmOverwrite(
        entry.srcPath, dst.basename(targetPath), cp, params, progress, fileParams, {
          // SFTPConfirmOverwrite's CanAppend: never for an encrypted session,
          // never in text mode, and never on a protocol that cannot write at an
          // offset. Passing `true` unconditionally offered Append where WinSCP
          // withholds it, and every one of those three cases loses data.
          canAppend: T.canAppendTo(engine, dst, progress),
          side: item.side === 'download' ? 'local' : 'remote',
          resolveAppendOrResume: () => item._pendingAppendOrResume,
        });
      const name = result.targetFileName;
      return {
        skip: false,
        mode: result.mode,
        targetPath: name === dst.basename(targetPath)
          ? targetPath : dst.join(dst.dirname(targetPath), name),
      };
    } catch (e) {
      // ESkipFile — the user said no to this one file.
      if (e && e.skipFile === true) return { skip: true, mode: 'overwrite', targetPath };
      // EAbort — cancel, which for a queue item means stop the item.
      if (e && e.aborted === true) { item._cancelled = true; return { skip: true, mode: 'overwrite', targetPath }; }
      throw e;
    }
  }

  /**
   * The per-item bridge into `transfer.js`. It is per item, not per queue,
   * because "Yes to all" belongs to one queued transfer — answering it for a
   * folder upload must not silently answer it for an unrelated item queued
   * behind it.
   */
  _overwriteEngine(item) {
    if (item._overwriteEngine) return item._overwriteEngine;
    const queue = this;
    const host = new T.StandaloneHost({
      adapter: item.targetAdapter,
      prefs: this.prefs,
      sessionData: (item.session && item.session.data) || {},
      setPref: (key, value) => { queue.prefs[key] = value; },
      logEvent: (text) => queue.emit('log', { id: item.id, text }),
      promptName: async () => item._pendingRename,
      queryUser: (q) => queue._askOverwrite(item, q),
    });
    item._overwriteProgress = new T.SimpleProgress(item.side === 'download' ? 'remote' : 'local');
    item._overwriteEngine = new T.TransferEngine(host);
    return item._overwriteEngine;
  }

  /**
   * Translate between the engine's WinSCP vocabulary and the queue's own,
   * which the renderer already speaks. The mapping is the one WinSCP's dialog
   * uses: "Yes to newer" is `all`, "Rename" is `ignore`, "Append" is `retry`.
   */
  async _askOverwrite(item, query) {
    const dst = item.targetAdapter;
    const entry = item._currentEntry || {};
    const reply = await this._query(item, {
      kind: 'overwrite',
      file: item._currentTargetPath || '',
      message: query.message,
      details: query.moreMessages || [],
      source: { path: entry.srcPath, size: entry.size, mtime: entry.mtime },
      target: {
        path: item._currentTargetPath || '',
        size: (item._currentExisting || {}).size,
        mtime: (item._currentExisting || {}).mtime,
      },
      canResume: allowResume(item.copyParam, entry.size,
        dst.basename(item._currentTargetPath || '')),
      // The dialog must offer exactly the buttons the decision layer will
      // accept; showing Append and then refusing it is worse than not showing
      // it, because the user believes they chose something.
      canAppend: T.canAppendTo(item._overwriteEngine, dst, item._overwriteProgress),
    });
    item._pendingAppendOrResume = null;
    switch (reply.answer) {
      case 'overwrite': return 'yes';
      case 'skip': return 'no';
      case 'overwrite-all': return 'yesToAll';
      case 'skip-all': return 'noToAll';
      case 'newer-only': return 'all';
      case 'rename':
        if (!reply.newName) throw new Error('The "rename" answer needs a newName.');
        item._pendingRename = reply.newName;
        return 'ignore';
      case 'resume': item._pendingAppendOrResume = 'resume'; return 'retry';
      case 'append': item._pendingAppendOrResume = 'append'; return 'retry';
      default: return 'cancel';
    }
  }

  _skip(item, entry, targetPath) {
    item.skipped.push(targetPath);
    item.progress.filesDone += 1;
    // A skipped file still counts towards the total, otherwise the bar never
    // reaches the end when half the files were left alone.
    item.progress.bytes = item._bytesDone + entry.size;
    this._emitProgress(item, true);
  }

  _asciiMask(cp) {
    if (!this._asciiCache || this._asciiCacheStr !== cp.asciiFileMask) {
      this._asciiCacheStr = cp.asciiFileMask;
      this._asciiCache = new FileMask(cp.asciiFileMask);
    }
    return this._asciiCache;
  }

  /**
   * Move the bytes. Returns the number written in this pass.
   *
   * Layout of the decision:
   *   append   -> open the existing target at its end, read the whole source
   *   resume   -> open the existing target at its end, read the source from
   *               the same offset (the target IS the partial file)
   *   overwrite with resume support -> write to '<target>.filepart', continuing
   *               an existing part if one is there, then rename over the target
   *   overwrite without resume support -> straight truncating write
   */
  async _copyBytes(item, entry, targetPath, mode, existing, text) {
    const src = item.sourceAdapter;
    const dst = item.targetAdapter;
    const cp = item.copyParam;

    const canRange = !!(src.caps && src.caps.resume) && !!(dst.caps && dst.caps.resume);
    let writePath = targetPath;
    let startAt = 0;
    let readFrom = 0;
    let usingPartial = false;

    if (mode === 'append' && existing) {
      startAt = existing.size;
      readFrom = 0;
    } else if (mode === 'resume' && existing) {
      startAt = existing.size;
      readFrom = existing.size;
      if (readFrom >= entry.size) return 0;      // already complete
    } else if (allowResume(cp, entry.size, dst.basename(targetPath)) && canRange && !text) {
      // Text mode cannot resume: the byte offsets on the two sides differ once
      // line endings are rewritten, so a restart would splice mid-line.
      //
      // Everything the EXISTING target can say about it is asked once, of the
      // same function `transfer.js`'s source() asks (SftpFileSystem.cpp:4674-
      // 4700). Both end at the `remove` + `rename` below, and this is the route
      // a click in the UI actually takes, so a disagreement between them is a
      // guard the session path enforces and the product does not — which is
      // exactly what happened to symlinks: source() had refused them since it
      // was written, and the queue replaced them anyway.
      //
      // A refusal is logged, not swallowed. Dropping to a plain truncating
      // write costs the user their resume, and an upload that stops resuming
      // for no stated reason looks like a slow server rather than a decision.
      const refusal = T.resumeRefusalReason(existing, dst.userName);
      if (refusal) {
        this.emit('log', { id: item.id, text: refusal });
      } else {
        usingPartial = true;
        writePath = targetPath + cp.partialFileExt;
        const part = await statOrNull(dst, writePath);
        if (part && part.size > 0 && part.size < entry.size) {
          startAt = part.size;
          readFrom = part.size;
        } else if (part && part.size >= entry.size) {
          startAt = 0;
          readFrom = 0;                          // stale part, start over
        }
      }
    }

    const parallel = this._parallelChunks(item, entry, { text, canRange, mode, readFrom });
    let written;
    if (parallel > 1) {
      written = await this._copyChunked(item, entry, writePath, parallel);
    } else {
      written = await this._copyStream(item, entry, writePath, startAt, readFrom, text);
    }

    if (usingPartial) {
      // Rename over the real name only now that the content is complete.
      if (existing) await this._tolerate(cp, () => dst.remove(targetPath));
      await dst.rename(writePath, targetPath);
    }
    return written;
  }

  /**
   * How many connections to split a single file across.
   *
   * WinSCP calls this "use multiple connections for a single transfer". It
   * needs ranged reads on the source and positioned writes on the target
   * (SFTP and HTTP Range / FTP REST give both), and it is pointless for text
   * mode or for a file smaller than the threshold.
   */
  _parallelChunks(item, entry, ctx) {
    const cp = item.copyParam;
    const qp = this.queuePrefs;
    const want = cp.parallelTransfers !== undefined ? cp.parallelTransfers
      : (qp.parallelTransfers !== undefined ? qp.parallelTransfers : 1);
    if (!want || want < 2) return 1;
    if (ctx.text || !ctx.canRange) return 1;
    if (ctx.mode !== 'overwrite' || ctx.readFrom > 0) return 1;
    const threshold = cp.parallelTransferThreshold !== undefined ? cp.parallelTransferThreshold
      : (qp.parallelTransferThreshold !== undefined ? qp.parallelTransferThreshold : 10 * 1024 * 1024);
    if (entry.size < threshold) return 1;
    // Never open more connections than there are threshold-sized pieces.
    return Math.min(want, Math.max(2, Math.ceil(entry.size / threshold)));
  }

  /**
   * THE byte mover, as `design/main/transfer.js` uses it.
   *
   * transfer.js is the port of Terminal.cpp's transfer half: it decides what
   * happens to a file that is already there, where to start reading, where to
   * start writing and what to do afterwards — and it opens no stream itself.
   * This method is the other half of that bargain. Both the queue's own
   * `queue:add` path and the session path (`terminal.copyToRemote` /
   * `copyToLocal`, reached over `transfer:*`) therefore move bytes through the
   * same throttle, the same pause gate, the same text converter and the same
   * cancellation, which is what stops the two halves drifting apart.
   *
   * The plan's shape is documented on `AdapterFileSystem` in transfer.js.
   * `readTo` is inclusive; ignoring it makes every part of a split download
   * read to end-of-file.
   *
   * @returns {Promise<number>} bytes read from the source in this pass.
   */
  async moveBytes(plan) {
    const p = plan || {};
    if (!p.sourceAdapter || !p.targetAdapter) {
      throw new Error('A transfer plan needs a source adapter and a target adapter.');
    }
    // A plan may arrive from a session transfer that has no queue item behind
    // it. Everything the streaming loop reads off an item is supplied here, so
    // one implementation serves both callers rather than two that agree today.
    const item = p.item || {
      id: `engine-${newId()}`,
      side: p.side === 'remote' ? 'download' : 'upload',
      source: p.sourcePath,
      target: p.finalPath || p.targetPath,
      state: 'active',
      addedAt: Date.now(),
      startedAt: Date.now(),
      finishedAt: 0,
      skipped: [],
      cpsLimit: 0,
      error: null,
      sourceAdapter: p.sourceAdapter,
      targetAdapter: p.targetAdapter,
      copyParam: p.copyParam || { ...COPY_PARAM_DEFAULTS },
      session: p.session || null,
      progress: { bytes: 0, total: Number(p.size) || 0, filesDone: 0, files: 1, cps: 0, eta: null, currentFile: p.sourcePath },
      _bytesDone: 0,
      _cancelled: false,
      _gate: new Gate(true),
      _throttle: new Throttle(0),
      _cpsWindow: [],
      _lastProgressAt: 0,
    };

    const entry = { srcPath: p.sourcePath, dstPath: p.targetPath, size: Number(p.size) || 0 };
    const before = item.progress.bytes;
    const written = await this._copyStream(
      item, entry, p.targetPath,
      Number(p.writeAt) || 0, Number(p.readFrom) || 0, !!p.text, p.readTo,
      { append: !!p.append, onBytes: typeof p.onBytes === 'function' ? p.onBytes : null });
    // The engine's own progress object is fed through onBytes as the bytes
    // land; this is the return value it accounts the pass with.
    if (typeof p.onBytes !== 'function' && item.progress.bytes < before) item.progress.bytes = before;
    return written;
  }

  /** Single-stream copy with throttling, pause checks and text conversion. */
  async _copyStream(item, entry, writePath, startAt, readFrom, text, readTo, opts) {
    const src = item.sourceAdapter;
    const dst = item.targetAdapter;
    const cp = item.copyParam;

    // `readTo` is inclusive and is what stops ONE PART of a split file where
    // the next part begins. Without it every part reads to end-of-file and the
    // merged download is a multiple of the file's true length.
    const range = {};
    if (readFrom > 0) range.start = readFrom;
    if (readTo !== undefined && readTo !== null && readTo >= 0) range.end = readTo;
    const o = opts || {};
    // A plan may append into an EMPTY file, where `startAt` is 0 and yet the
    // file must not be truncated. The queue's own path has no such case, so it
    // derives the flag from the offset; a supplied plan says so outright.
    const append = o.append === undefined ? startAt > 0 : !!o.append;
    const rs = await src.createReadStream(entry.srcPath, range);
    const ws = await dst.createWriteStream(writePath, {
      size: entry.size,
      start: startAt,
      append,
      flags: append || startAt > 0 ? 'r+' : 'w',
    });
    const writer = new StreamWriter(ws);
    const conv = text
      ? new TextConverter(this._targetEol(item), { removeBOM: cp.removeBOM, removeCtrlZ: cp.removeCtrlZ })
      : null;

    // Bytes already on the target from a previous attempt still count as done.
    item.progress.bytes = item._bytesDone + readFrom;
    let written = 0;
    try {
      for await (const chunk of rs) {
        if (item._cancelled) throw new TransferCancelled();
        await this._waitRunnable(item);
        if (item._cancelled) throw new TransferCancelled();
        await item._throttle.take(chunk.length);
        const out = conv ? conv.convert(chunk) : chunk;
        if (out.length) await writer.write(out);
        written += chunk.length;
        item.progress.bytes += chunk.length;
        if (o.onBytes) o.onBytes(chunk.length);
        this._recordCps(item, chunk.length);
        this._emitProgress(item, false);
      }
      if (conv) {
        const tail = conv.flush();
        if (tail.length) await writer.write(tail);
      }
      await writer.end();
    } catch (err) {
      writer.destroy();
      if (typeof rs.destroy === 'function') rs.destroy();
      throw err;
    }
    return written;
  }

  /**
   * Split one file across several concurrent ranged streams. Each chunk writes
   * at its own offset, so the pieces land in the right place regardless of the
   * order they complete in.
   */
  async _copyChunked(item, entry, writePath, chunks) {
    const src = item.sourceAdapter;
    const dst = item.targetAdapter;
    const size = entry.size;
    const per = Math.ceil(size / chunks);

    const ranges = [];
    for (let start = 0; start < size; start += per) {
      ranges.push({ start, end: Math.min(size, start + per) - 1 });
    }

    // Make sure the file exists at full length before the writers seek into it.
    const seed = await dst.createWriteStream(writePath, { size, start: 0, flags: 'w' });
    await new StreamWriter(seed).end();

    item.progress.bytes = item._bytesDone;
    let written = 0;
    await Promise.all(ranges.map(async (range) => {
      const rs = await src.createReadStream(entry.srcPath, { start: range.start, end: range.end });
      const ws = await dst.createWriteStream(writePath, {
        size, start: range.start, append: false, flags: 'r+',
      });
      const writer = new StreamWriter(ws);
      try {
        for await (const chunk of rs) {
          if (item._cancelled) throw new TransferCancelled();
          await this._waitRunnable(item);
          await item._throttle.take(chunk.length);
          await writer.write(chunk);
          written += chunk.length;
          item.progress.bytes += chunk.length;
          this._recordCps(item, chunk.length);
          this._emitProgress(item, false);
        }
        await writer.end();
      } catch (err) {
        writer.destroy();
        if (typeof rs.destroy === 'function') rs.destroy();
        throw err;
      }
    }));
    return written;
  }

  /** The line ending the target side wants. */
  _targetEol(item) {
    if (item.side === 'download') return 'crlf';          // local side is Windows
    const eol = item.session && item.session.eolType;
    return eol === 'crlf' ? 'crlf' : 'lf';
  }

  // ---- progress --------------------------------------------------------

  _recordCps(item, bytes) {
    const now = Date.now();
    item._cpsWindow.push([now, bytes]);
    const cutoff = now - 5000;
    while (item._cpsWindow.length && item._cpsWindow[0][0] < cutoff) item._cpsWindow.shift();
    const total = item._cpsWindow.reduce((a, e) => a + e[1], 0);
    const span = Math.max(1, now - item._cpsWindow[0][0]) / 1000;
    item.progress.cps = Math.round(total / span);
    const left = item.progress.total - item.progress.bytes;
    item.progress.eta = item.progress.cps > 0 && left > 0
      ? Math.round(left / item.progress.cps) : null;
  }

  _emitProgress(item, force) {
    const now = Date.now();
    if (!force && now - item._lastProgressAt < this.progressMs) return;
    item._lastProgressAt = now;
    this.emit('progress', { id: item.id, progress: { ...item.progress }, state: item.state });
  }
}

/** Thrown internally when an item is removed mid-transfer. */
class TransferCancelled extends Error {
  constructor() { super('Transfer cancelled'); this.name = 'TransferCancelled'; }
}

async function statOrNull(adapter, p) {
  try { return await adapter.stat(p); } catch { return null; }
}

/** Add the execute bit wherever read is set — TRights::AddExecute. */
function addExecute(rights) {
  const r = (rights || 'rw-r--r--').split('');
  for (const i of [2, 5, 8]) {
    if (r[i - 2] === 'r' || r[i - 1] === 'w') r[i] = 'x';
  }
  return r.join('');
}

module.exports = {
  TransferQueue,
  Throttle,
  TextConverter,
  Gate,
  STATES,
  OVERWRITE_ANSWERS,
  validLocalFileName,
  changeFileName,
  allowResume,
  useTextMode,
  isConnectionError,
};
