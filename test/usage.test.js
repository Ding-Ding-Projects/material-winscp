'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  UsageStore,
  MAX_COUNTERS,
  MAX_COUNTER_VALUE,
  MAX_STARTUP_STEPS,
} = require('../design/main/usage');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wscp-usage-'));
  const file = path.join(dir, 'nested', 'usage.json');
  return { dir, file };
}

function cleanup(dir) { fs.rmSync(dir, { recursive: true, force: true }); }

test('counters are local, bounded, saturating, and deterministic', () => {
  const { dir, file } = fixture();
  try {
    const store = new UsageStore(file);
    assert.equal(store.increment('opened'), 1);
    assert.equal(store.increment('opened', 2), 3);
    assert.equal(store.increment('saturated', MAX_COUNTER_VALUE + 10), MAX_COUNTER_VALUE);
    assert.deepEqual(store.counters(), { opened: 3, saturated: MAX_COUNTER_VALUE });

    const first = fs.readFileSync(file, 'utf8');
    const reloaded = new UsageStore(file).load();
    assert.deepEqual(reloaded.counters(), { opened: 3, saturated: MAX_COUNTER_VALUE });
    assert.equal(reloaded.exportJSON(), first);
  } finally { cleanup(dir); }
});

test('counter names, values, and cardinality are rejected before persistence', () => {
  const { dir, file } = fixture();
  try {
    const store = new UsageStore(file);
    assert.throws(() => store.increment('Password'), /lowercase bounded/);
    assert.throws(() => store.increment('not a counter'), /lowercase bounded/);
    assert.throws(() => store.increment('ok', 0), /positive integer/);
    assert.throws(() => store.increment('ok', -1), /positive integer/);
    for (let i = 0; i < MAX_COUNTERS; i++) store.increment(`c${String(i).padStart(2, '0')}`);
    assert.throws(() => store.increment('one-too-many'), /limit exceeded/);
    assert.equal(fs.existsSync(file), true);
  } finally { cleanup(dir); }
});

test('startup facts keep an ordered, duplicate-free sequence and outcome counters', () => {
  const { dir, file } = fixture();
  try {
    const store = new UsageStore(file);
    assert.deepEqual(store.beginStartup({ mode: 'gui', firstRun: true }), {
      mode: 'gui', firstRun: true, steps: [], outcome: 'in-progress',
    });
    assert.equal(store.markStartup('config'), true);
    assert.equal(store.markStartup('window'), true);
    assert.equal(store.markStartup('window'), false);
    assert.equal(store.completeStartup(), true);
    assert.equal(store.completeStartup(), false);
    assert.deepEqual(store.exportState().startup, {
      mode: 'gui', firstRun: true, steps: ['config', 'window'], outcome: 'completed',
    });
    assert.equal(store.counter('launches'), 1);
    assert.equal(store.counter('successful_launches'), 1);
    assert.equal(store.counter('failed_launches'), 0);
  } finally { cleanup(dir); }
});

test('an interrupted startup is counted without retaining arbitrary failure text', () => {
  const { dir, file } = fixture();
  try {
    const store = new UsageStore(file);
    store.beginStartup({ mode: 'command-line' });
    store.markStartup('config');
    store.beginStartup({ mode: 'update' });
    store.failStartup();
    assert.deepEqual(store.exportState().startup, {
      mode: 'update', firstRun: false, steps: [], outcome: 'failed',
    });
    assert.equal(store.counter('launches'), 2);
    assert.equal(store.counter('interrupted_launches'), 1);
    assert.equal(store.counter('failed_launches'), 1);
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /password|token|secret|errorMessage/i);
  } finally { cleanup(dir); }
});

test('export is defensive and reset clears the persisted state', () => {
  const { dir, file } = fixture();
  try {
    const store = new UsageStore(file);
    store.increment('opened');
    const exported = store.exportState();
    exported.counters.opened = 999;
    exported.startup.steps.push('injected');
    assert.equal(store.counter('opened'), 1);
    assert.deepEqual(store.reset(), {
      version: 1,
      counters: {},
      startup: { mode: 'unknown', firstRun: false, steps: [], outcome: 'none' },
    });
    assert.deepEqual(new UsageStore(file).load().exportState(), {
      version: 1,
      counters: {},
      startup: { mode: 'unknown', firstRun: false, steps: [], outcome: 'none' },
    });
  } finally { cleanup(dir); }
});

test('a failed atomic write rolls memory back and leaves no temporary file', () => {
  const { dir, file } = fixture();
  try {
    const realFs = fs;
    const failingFs = {
      ...realFs,
      writeFileSync() { throw new Error('disk full'); },
    };
    const store = new UsageStore(file, { fs: failingFs });
    assert.throws(() => store.increment('opened'), /disk full/);
    assert.equal(store.counter('opened'), 0);
    assert.equal(fs.existsSync(`${file}.tmp`), false);
  } finally { cleanup(dir); }
});

test('reset also rolls memory back when its atomic write fails', () => {
  const { dir, file } = fixture();
  try {
    const store = new UsageStore(file);
    store.increment('opened');
    store.fs = { ...fs, writeFileSync() { throw new Error('disk full'); } };
    assert.throws(() => store.reset(), /disk full/);
    assert.equal(store.counter('opened'), 1);
  } finally { cleanup(dir); }
});

test('malformed or legacy state is sanitized without importing arbitrary fields', () => {
  const { dir, file } = fixture();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      counters: { opened: 4 },
      startup: { mode: 'gui', firstRun: false, steps: ['config'], outcome: 'completed' },
      password: 'must not survive',
      hostName: 'must not survive',
    }));
    const store = new UsageStore(file).load();
    assert.deepEqual(store.exportState(), {
      version: 1,
      counters: { opened: 4 },
      startup: { mode: 'gui', firstRun: false, steps: ['config'], outcome: 'completed' },
    });

    fs.writeFileSync(file, '{not json');
    const corrupt = new UsageStore(file).load();
    assert.equal(corrupt.loadError, 'INVALID_FILE');
    assert.deepEqual(corrupt.counters(), {});

    fs.writeFileSync(file, JSON.stringify({ version: 1, startup: { firstRun: 'yes' } }));
    const unsafe = new UsageStore(file).load();
    assert.equal(unsafe.loadError, 'INVALID_STARTUP');
    assert.deepEqual(unsafe.counters(), {});
  } finally { cleanup(dir); }
});

test('startup sequences and state limits remain bounded', () => {
  const { dir, file } = fixture();
  try {
    const store = new UsageStore(file);
    store.beginStartup({ mode: 'gui' });
    for (let i = 0; i < MAX_STARTUP_STEPS; i++) store.markStartup(`step${String(i).padStart(2, '0')}`);
    assert.equal(store.exportState().startup.steps.length, MAX_STARTUP_STEPS);
    assert.throws(() => store.markStartup('overflow'), /limit exceeded/);
  } finally { cleanup(dir); }
});
