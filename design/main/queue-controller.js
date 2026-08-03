// queue-controller.js — the command and reconciliation surface for the queue.
//
// TransferQueue owns byte movement. This controller owns the decisions a queue
// window can present: which actions are available, which item state is current,
// and whether an operation really succeeded. Keeping that boundary headless
// makes the same contract usable by Electron IPC and by focused node:test
// coverage without pretending that a click succeeded before the model changed.
'use strict';

const { EventEmitter } = require('events');

const LIVE_STATES = new Set(['queued', 'active', 'paused', 'query', 'prompt']);
const ONCE_DONE_ACTIONS = Object.freeze([
  { value: 'none', label: 'Stay idle', cantoneseLabel: '乜都唔做' },
  { value: 'disconnect', label: 'Disconnect the session', cantoneseLabel: '斷開連線' },
  { value: 'suspend', label: 'Suspend the computer', cantoneseLabel: '令電腦瞓覺' },
  { value: 'shutdown', label: 'Shut down the computer', cantoneseLabel: '熄電腦' },
  { value: 'idle', label: 'Remain idle', cantoneseLabel: '保持閒置' },
]);
const ITEM_ONCE_DONE_ACTIONS = Object.freeze(ONCE_DONE_ACTIONS.filter((choice) => choice.value !== 'idle'));

const LABELS = Object.freeze({
  pauseAll: ['Pause all transfers', '全部暫停傳輸'],
  resumeAll: ['Resume all transfers', '全部繼續傳輸'],
  processQueue: ['Process queued transfers', '處理排緊隊嘅傳輸'],
  stopQueue: ['Stop starting queued transfers', '停止開始排緊隊嘅傳輸'],
  cancelAll: ['Cancel all active transfers', '取消全部進行中嘅傳輸'],
  clearDone: ['Remove completed transfers', '移除已完成嘅傳輸'],
  pauseItem: ['Pause this transfer', '暫停呢單傳輸'],
  resumeItem: ['Resume this transfer', '繼續呢單傳輸'],
  moveUp: ['Move transfer earlier', '將傳輸調前'],
  moveDown: ['Move transfer later', '將傳輸調後'],
  cancelItem: ['Cancel this transfer', '取消呢單傳輸'],
  retryItem: ['Retry this failed transfer', '重試呢單失敗傳輸'],
  setOnceDone: ['Choose what happens when the queue is empty', '揀佇列清空之後做乜'],
  setItemOnceDone: ['Choose what happens after this transfer', '揀呢單傳輸完成之後做乜'],
});

function cloneItem(item) {
  if (!item || typeof item !== 'object') return item;
  return {
    ...item,
    copyParam: item.copyParam && { ...item.copyParam },
    progress: item.progress && { ...item.progress },
    skipped: Array.isArray(item.skipped) ? item.skipped.slice() : item.skipped,
  };
}

function cloneSnapshot(snapshot) {
  return {
    version: snapshot.version,
    queue: { ...snapshot.queue },
    items: snapshot.items.map(cloneItem),
    lastOnceDone: snapshot.lastOnceDone ? { ...snapshot.lastOnceDone } : null,
  };
}

function labels(key) {
  const [label, cantoneseLabel] = LABELS[key];
  return {
    label,
    cantoneseLabel,
    bilingualLabel: `${label} / ${cantoneseLabel}`,
    // The English name remains the stable spoken name for assistive tech; the
    // bilingual label is available to a renderer that follows the language
    // mode setting without making the control's purpose ambiguous.
    ariaLabel: label,
  };
}

function choice(value, choices) {
  return choices.find((item) => item.value === value) || null;
}

class QueueControllerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'QueueControllerError';
    this.code = code;
  }
}

class QueueController extends EventEmitter {
  /**
   * @param {object} queue TransferQueue or its deliberately small testable
   *   equivalent. It must provide list() and the methods used by dispatch().
   */
  constructor(queue) {
    super();
    if (!queue || typeof queue.list !== 'function') {
      throw new TypeError('QueueController needs a queue model with list().');
    }
    this.queue = queue;
    this._version = 0;
    this._closed = false;
    this._dispatchTail = Promise.resolve();
    this._listeners = [];
    this._snapshot = {
      version: 0,
      queue: { enabled: true, paused: false, transfersLimit: 1, onceDone: 'none' },
      items: [],
      lastOnceDone: null,
    };
    this._listen();
    this.reconcile({ emit: false, reason: 'initial' });
  }

  static get onceDoneChoices() { return ONCE_DONE_ACTIONS.map((item) => ({ ...item })); }
  static get itemOnceDoneChoices() { return ITEM_ONCE_DONE_ACTIONS.map((item) => ({ ...item })); }

  get snapshot() { return cloneSnapshot(this._snapshot); }

  close() {
    if (this._closed) return;
    this._closed = true;
    for (const [event, listener] of this._listeners) this.queue.removeListener?.(event, listener);
    this._listeners = [];
  }

  _listen() {
    if (typeof this.queue.on !== 'function') return;
    for (const event of ['item-added', 'item-updated', 'item-done', 'item-error', 'queue-updated', 'progress']) {
      const listener = () => {
        try { this.reconcile({ reason: event }); }
        catch (error) {
          // An unhandled EventEmitter error terminates Node. Queue events can
          // arrive from IPC, so a stale snapshot must stay a contained failure.
          if (this.listenerCount('error') > 0) this.emit('error', error);
        }
      };
      this.queue.on(event, listener);
      this._listeners.push([event, listener]);
    }
    const idle = (payload) => {
      const action = payload && payload.onceDone;
      this.reconcile({ reason: 'idle' });
      if (action && action !== 'none') {
        this._snapshot.lastOnceDone = { action, requestedAt: Date.now() };
        // Record the prompt before taking its snapshot. Consumers use this
        // immutable request to render/confirm the host-owned operation; a
        // stale snapshot makes the prompt look as if no request was made.
        const request = { action, snapshot: this.snapshot };
        this.emit('once-done-requested', request);
      }
    };
    this.queue.on('idle', idle);
    this._listeners.push(['idle', idle]);
  }

  /** Read the model after every event or command; the model remains authoritative. */
  reconcile({ emit = true, reason = 'reconcile' } = {}) {
    if (this._closed) return this.snapshot;
    const items = this.queue.list();
    if (!Array.isArray(items)) throw new QueueControllerError('INVALID_QUEUE_STATE', 'The queue returned a non-array item list.');
    this._version += 1;
    this._snapshot = {
      version: this._version,
      queue: {
        enabled: this.queue.enabled !== false,
        paused: this.queue.paused === true,
        transfersLimit: Number.isFinite(Number(this.queue.transfersLimit))
          ? Number(this.queue.transfersLimit) : 1,
        onceDone: this.queue.onceDone || 'none',
      },
      items: items.map(cloneItem),
      lastOnceDone: this._snapshot.lastOnceDone,
    };
    const current = this.snapshot;
    if (emit) this.emit('changed', { reason, snapshot: current });
    return current;
  }

  item(id) {
    return this._snapshot.items.find((item) => item.id === id) || null;
  }

  globalActions() {
    const live = this._snapshot.items.filter((item) => LIVE_STATES.has(item.state));
    const done = this._snapshot.items.filter((item) => item.state === 'done');
    const paused = this._snapshot.queue.paused;
    const enabled = this._snapshot.queue.enabled;
    return [
      this._action(paused ? 'resume-all' : 'pause-all', paused ? 'resumeAll' : 'pauseAll', !live.length, paused ? 'No transfer is paused.' : 'There are no active transfers.'),
      this._action(enabled ? 'stop-queue' : 'process-queue', enabled ? 'stopQueue' : 'processQueue', false),
      this._action('cancel-all', 'cancelAll', !live.length, 'There are no active transfers to cancel.'),
      this._action('clear-done', 'clearDone', !done.length, 'There are no completed transfers to remove.'),
      { action: 'set-once-done', ...labels('setOnceDone'), enabled: true, choices: QueueController.onceDoneChoices },
    ];
  }

  itemActions(id) {
    const item = this.item(id);
    if (!item) return [];
    const index = this._snapshot.items.findIndex((entry) => entry.id === id);
    const live = LIVE_STATES.has(item.state);
    const paused = item.state === 'paused';
    const actions = [
      this._action(paused ? 'resume-item' : 'pause-item', paused ? 'resumeItem' : 'pauseItem', !live, 'This transfer is not running.'),
      this._action('move-up', 'moveUp', !live || index <= 0, index <= 0 ? 'This transfer is already first.' : 'This transfer is not movable.'),
      this._action('move-down', 'moveDown', !live || index < 0 || index >= this._snapshot.items.length - 1, index >= this._snapshot.items.length - 1 ? 'This transfer is already last.' : 'This transfer is not movable.'),
      this._action('cancel-item', 'cancelItem', !live, 'Only active or waiting transfers can be cancelled.'),
      this._action('retry-item', 'retryItem', item.state !== 'error', 'Only failed transfers can be retried.'),
      { action: 'set-item-once-done', ...labels('setItemOnceDone'), enabled: true, choices: QueueController.itemOnceDoneChoices },
    ];
    return actions;
  }

  actions(id) { return id === undefined || id === null ? this.globalActions() : this.itemActions(id); }

  _action(action, key, disabled, reason) {
    return { action, ...labels(key), enabled: !disabled, ...(disabled && reason ? { disabledReason: reason } : {}) };
  }

  _assertAction(id, action) {
    const available = this.actions(id).find((entry) => entry.action === action);
    if (!available) throw new QueueControllerError('UNKNOWN_ACTION', `Unknown queue action "${action}".`);
    if (!available.enabled) throw new QueueControllerError('ACTION_DISABLED', available.disabledReason || `Queue action "${action}" is unavailable.`);
    return available;
  }

  async _invoke(action, fn) {
    if (typeof fn !== 'function') throw new QueueControllerError('ACTION_UNAVAILABLE', `The queue cannot perform "${action}".`);
    const result = await fn();
    if (result === false) throw new QueueControllerError('ACTION_FAILED', `The queue rejected "${action}".`);
    return this.reconcile({ reason: action });
  }

  _method(name, action) {
    if (typeof this.queue[name] !== 'function') {
      throw new QueueControllerError('ACTION_UNAVAILABLE', `The queue cannot perform "${action || name}".`);
    }
    return (...args) => this.queue[name](...args);
  }

  dispatch(action, id, value) {
    const run = this._dispatchTail.then(() => this._dispatch(action, id, value));
    // A rejected command must not poison later commands in the sequence.
    this._dispatchTail = run.catch(() => undefined);
    return run;
  }

  async _dispatch(action, id, value) {
    if (typeof action !== 'string' || !action) throw new QueueControllerError('INVALID_ACTION', 'A queue action is required.');
    if (id !== undefined && id !== null) this._assertAction(id, action);
    else if (action !== 'pause-all' && action !== 'resume-all' && action !== 'process-queue'
      && action !== 'stop-queue' && action !== 'cancel-all' && action !== 'clear-done'
      && action !== 'set-once-done') this._assertAction(id, action);

    switch (action) {
      case 'pause-all': return this._invoke(action, this._method('pauseAll', action));
      case 'resume-all': return this._invoke(action, this._method('resumeAll', action));
      case 'process-queue': return this._invoke(action, this._method('setEnabled', action).bind(null, true));
      case 'stop-queue': return this._invoke(action, this._method('setEnabled', action).bind(null, false));
      case 'cancel-all': {
        const items = this._snapshot.items.filter((item) => LIVE_STATES.has(item.state));
        return this._invoke(action, async () => {
          for (const item of items) {
            // IPC adapters may expose remove() as async. Await it before
            // deciding whether the bulk cancellation really succeeded.
            const result = await this._method('remove', action)(item.id);
            if (result === false) throw new QueueControllerError('ACTION_FAILED', `The queue rejected cancelling "${item.id}".`);
          }
        });
      }
      case 'clear-done': return this._invoke(action, this._method('removeDone', action));
      case 'pause-item': return this._invoke(action, this._method('pauseItem', action).bind(null, id));
      case 'resume-item': return this._invoke(action, this._method('resumeItem', action).bind(null, id));
      case 'move-up': return this._invoke(action, this._method('moveUp', action).bind(null, id));
      case 'move-down': return this._invoke(action, this._method('moveDown', action).bind(null, id));
      case 'cancel-item': return this._invoke(action, this._method('remove', action).bind(null, id));
      case 'retry-item': return this._invoke(action, this._method('retry', action).bind(null, id));
      case 'set-once-done': return this._setOnceDone(value);
      case 'set-item-once-done': return this._setItemOnceDone(id, value);
      default: throw new QueueControllerError('UNKNOWN_ACTION', `Unknown queue action "${action}".`);
    }
  }

  async _setOnceDone(value) {
    if (!choice(value, ONCE_DONE_ACTIONS)) throw new QueueControllerError('INVALID_ONCE_DONE', `Unknown once-done action "${value}".`);
    return this._invoke('set-once-done', this._method('setOnceDone', 'set-once-done').bind(null, value));
  }

  async _setItemOnceDone(id, value) {
    if (!choice(value, ITEM_ONCE_DONE_ACTIONS)) throw new QueueControllerError('INVALID_ONCE_DONE', `Unknown item once-done action "${value}".`);
    this._assertAction(id, 'set-item-once-done');
    return this._invoke('set-item-once-done', this._method('setItemOnceDone', 'set-item-once-done').bind(null, id, value));
  }
}

module.exports = {
  QueueController,
  QueueControllerError,
  LIVE_STATES,
  ONCE_DONE_ACTIONS,
  ITEM_ONCE_DONE_ACTIONS,
};
