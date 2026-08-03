'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { TransferQueue } = require('../design/main/queue');
const {
  QueueController,
  QueueControllerError,
} = require('../design/main/queue-controller');

function item(id, state, extra = {}) {
  return {
    id, state, source: `/source/${id}`, target: `/target/${id}`,
    copyParam: { onceDoneOperation: 'none' },
    progress: { bytes: 0, total: 10 }, skipped: [], ...extra,
  };
}

class FakeQueue extends EventEmitter {
  constructor(items = []) {
    super();
    this.items = items;
    this.enabled = true;
    this.paused = false;
    this.transfersLimit = 2;
    this.onceDone = 'none';
  }

  list() { return this.items.map((entry) => ({ ...entry, copyParam: { ...entry.copyParam }, progress: { ...entry.progress } })); }
  _item(id) { return this.items.find((entry) => entry.id === id); }
  _changed(type = 'item-updated') { this.emit(type); }
  pauseAll() { this.paused = true; for (const it of this.items) if (it.state === 'active') it.state = 'paused'; this._changed('queue-updated'); }
  resumeAll() { this.paused = false; for (const it of this.items) if (it.state === 'paused') it.state = 'active'; this._changed('queue-updated'); }
  setEnabled(value) { this.enabled = value; this._changed('queue-updated'); }
  pauseItem(id) { const it = this._item(id); if (!it || !['queued', 'active'].includes(it.state)) return false; it._pausedFromActive = it.state === 'active'; it.state = 'paused'; this._changed(); return true; }
  resumeItem(id) { const it = this._item(id); if (!it || it.state !== 'paused') return false; it.state = it._pausedFromActive ? 'active' : 'queued'; it._pausedFromActive = false; this._changed(); return true; }
  moveUp(id) { const i = this.items.findIndex((it) => it.id === id); if (i <= 0) return false; [this.items[i - 1], this.items[i]] = [this.items[i], this.items[i - 1]]; this._changed(); return true; }
  moveDown(id) { const i = this.items.findIndex((it) => it.id === id); if (i < 0 || i === this.items.length - 1) return false; [this.items[i], this.items[i + 1]] = [this.items[i + 1], this.items[i]]; this._changed(); return true; }
  remove(id) { const i = this.items.findIndex((it) => it.id === id); if (i < 0) return false; this.items.splice(i, 1); this._changed(); return true; }
  removeDone() { const old = this.items.length; this.items = this.items.filter((it) => it.state !== 'done'); this._changed(); return old - this.items.length; }
  retry(id) { const it = this._item(id); if (!it || it.state !== 'error') return false; it.state = 'queued'; it.error = null; this._changed(); return true; }
  setOnceDone(value) { this.onceDone = value; this._changed('queue-updated'); return value; }
  setItemOnceDone(id, value) { const it = this._item(id); if (!it) return false; it.copyParam.onceDoneOperation = value; this._changed(); return value; }
}

test('controller exposes accessible global and per-item action state', () => {
  const queue = new FakeQueue([item('a', 'queued'), item('b', 'error'), item('c', 'done')]);
  const controller = new QueueController(queue);

  const global = controller.globalActions();
  assert.equal(global.find((a) => a.action === 'pause-all').enabled, true);
  assert.equal(global.find((a) => a.action === 'cancel-all').enabled, true);
  assert.equal(global.find((a) => a.action === 'clear-done').enabled, true);
  assert.equal(global.find((a) => a.action === 'set-once-done').choices.length, 5);

  const failed = controller.itemActions('b');
  assert.equal(failed.find((a) => a.action === 'retry-item').enabled, true);
  assert.equal(failed.find((a) => a.action === 'pause-item').enabled, false);
  assert.equal(failed.find((a) => a.action === 'pause-item').ariaLabel, 'Pause this transfer');
  assert.match(failed.find((a) => a.action === 'pause-item').bilingualLabel, /\/ /);

  const first = controller.itemActions('a');
  assert.equal(first.find((a) => a.action === 'move-up').enabled, false);
  assert.equal(first.find((a) => a.action === 'move-up').disabledReason, 'This transfer is already first.');
  controller.close();
});

test('dispatch reconciles pause, resume, reorder, cancel, retry and once-done operations', async () => {
  const queue = new FakeQueue([item('a', 'active'), item('b', 'queued'), item('c', 'error'), item('d', 'done')]);
  const controller = new QueueController(queue);
  const changes = [];
  controller.on('changed', (event) => changes.push(event.reason));

  let snapshot = await controller.dispatch('pause-all');
  assert.equal(snapshot.queue.paused, true);
  assert.equal(snapshot.items.find((it) => it.id === 'a').state, 'paused');

  snapshot = await controller.dispatch('resume-all');
  assert.equal(snapshot.queue.paused, false);
  assert.equal(snapshot.items.find((it) => it.id === 'a').state, 'active');

  await controller.dispatch('move-down', 'a');
  assert.deepEqual(controller.snapshot.items.map((it) => it.id), ['b', 'a', 'c', 'd']);
  await controller.dispatch('move-up', 'a');
  assert.deepEqual(controller.snapshot.items.map((it) => it.id), ['a', 'b', 'c', 'd']);

  await controller.dispatch('pause-item', 'a');
  assert.equal(controller.item('a').state, 'paused');
  await controller.dispatch('resume-item', 'a');
  assert.equal(controller.item('a').state, 'active');

  await controller.dispatch('retry-item', 'c');
  assert.equal(controller.item('c').state, 'queued');
  await controller.dispatch('cancel-item', 'c');
  assert.equal(controller.item('c'), null);

  await controller.dispatch('set-once-done', undefined, 'disconnect');
  assert.equal(controller.snapshot.queue.onceDone, 'disconnect');
  await controller.dispatch('set-item-once-done', 'a', 'shutdown');
  assert.equal(controller.item('a').copyParam.onceDoneOperation, 'shutdown');
  assert.ok(changes.length >= 8);
  controller.close();
});

test('controller rejects disabled, invalid and unavailable commands instead of claiming success', async () => {
  const queue = new FakeQueue([item('a', 'queued'), item('b', 'error')]);
  const controller = new QueueController(queue);

  await assert.rejects(() => controller.dispatch('move-up', 'a'), (error) => {
    assert.ok(error instanceof QueueControllerError);
    assert.equal(error.code, 'ACTION_DISABLED');
    return true;
  });
  await assert.rejects(() => controller.dispatch('set-once-done', undefined, 'explode'), { code: 'INVALID_ONCE_DONE' });

  const unavailable = new FakeQueue([item('a', 'error')]);
  unavailable.retry = undefined;
  const unavailableController = new QueueController(unavailable);
  await assert.rejects(() => unavailableController.dispatch('retry-item', 'a'), { code: 'ACTION_UNAVAILABLE' });
  assert.equal(unavailableController.item('a').state, 'error');
  controller.close();
  unavailableController.close();
});

test('controller awaits asynchronous bulk cancellation results', async () => {
  const queue = new FakeQueue([item('a', 'active')]);
  queue.remove = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    return false;
  };
  const controller = new QueueController(queue);

  await assert.rejects(() => controller.dispatch('cancel-all'), { code: 'ACTION_FAILED' });
  controller.close();
});

test('controller rejects a stale clear-done no-op instead of claiming success', async () => {
  const queue = new FakeQueue([item('a', 'done')]);
  queue.removeDone = () => 0;
  const controller = new QueueController(queue);

  await assert.rejects(() => controller.dispatch('clear-done'), { code: 'ACTION_FAILED' });
  controller.close();
});

test('controller serializes concurrent pause commands', async () => {
  const queue = new FakeQueue([item('a', 'active')]);
  let pauseCalls = 0;
  queue.pauseItem = async (id) => {
    pauseCalls += 1;
    await new Promise((resolve) => setImmediate(resolve));
    return FakeQueue.prototype.pauseItem.call(queue, id);
  };
  const controller = new QueueController(queue);

  const first = controller.dispatch('pause-item', 'a');
  const second = controller.dispatch('pause-item', 'a');
  await first;
  await assert.rejects(second, { code: 'UNKNOWN_ACTION' });
  assert.equal(pauseCalls, 1);
  assert.equal(controller.item('a').state, 'paused');
  controller.close();
});

test('queue event reconciliation contains IPC failures without an error listener', () => {
  const queue = new FakeQueue([item('a', 'queued')]);
  const controller = new QueueController(queue);
  queue.list = () => { throw new Error('stale queue snapshot'); };
  assert.doesNotThrow(() => queue.emit('item-updated'));
  controller.close();
});

test('queue event reconciliation reports IPC failures to an error listener', () => {
  const queue = new FakeQueue([item('a', 'queued')]);
  const controller = new QueueController(queue);
  const errors = [];
  controller.on('error', (error) => errors.push(error));
  queue.list = () => { throw new Error('stale queue snapshot'); };
  queue.emit('item-updated');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, 'stale queue snapshot');
  controller.close();
});

test('idle once-done is reported as a request, not a fake completed power action', () => {
  const queue = new FakeQueue();
  const controller = new QueueController(queue);
  const requests = [];
  controller.on('once-done-requested', (request) => requests.push(request));

  queue.emit('idle', { onceDone: 'shutdown' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].action, 'shutdown');
  assert.equal(controller.snapshot.lastOnceDone.action, 'shutdown');
  controller.close();
});

test('idle once-done prompt snapshot includes the recorded request', () => {
  const queue = new FakeQueue();
  const controller = new QueueController(queue);
  let request;
  controller.on('once-done-requested', (value) => { request = value; });

  queue.emit('idle', { onceDone: 'disconnect' });

  assert.equal(request.action, 'disconnect');
  assert.equal(request.snapshot.lastOnceDone.action, 'disconnect');
  assert.equal(request.snapshot.lastOnceDone.requestedAt, controller.snapshot.lastOnceDone.requestedAt);
  controller.close();
});

test('TransferQueue retry requeues only failed work and leaves a second failure visible', async () => {
  const queue = new TransferQueue({ progressMs: 0, prefs: { queue: { keepDoneItemsFor: -1 } } });
  queue.add({ id: 'broken', source: '/missing', target: '/missing' });
  await queue.idle();
  assert.equal(queue.get('broken').state, 'error');
  assert.equal(queue.retry('broken'), true);
  // retry() puts the item back through the normal pump; with an available
  // slot it can truthfully be active before retry() returns.
  assert.ok(['queued', 'active'].includes(queue.get('broken').state));
  await queue.idle();
  assert.equal(queue.get('broken').state, 'error');
  assert.equal(queue.retry('broken'), true);
  assert.equal(queue.retry('broken'), false, 'a queued retry is not duplicated');
});
