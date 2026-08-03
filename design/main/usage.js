// usage.js — local usage counters and startup facts.
//
// This is deliberately a small main-process store. It records only bounded,
// non-sensitive facts that can help explain how far startup got or how often
// a local feature was used. It never imports a network client and never sends
// anything anywhere. The caller supplies the file path so tests and portable
// mode do not need to know the app's data-root policy.
'use strict';

const fs = require('fs');
const path = require('path');

const VERSION = 1;
const MAX_COUNTERS = 64;
const MAX_COUNTER_VALUE = 1_000_000_000;
const MAX_NAME_LENGTH = 48;
const MAX_STARTUP_STEPS = 64;
const NAME_RE = /^[a-z][a-z0-9._-]{0,47}$/;
const STARTUP_MODES = Object.freeze(['gui', 'command-line', 'installer', 'update', 'unknown']);
const STARTUP_OUTCOMES = Object.freeze(['none', 'in-progress', 'completed', 'failed']);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/** Sort every object key while preserving array order for reproducible JSON. */
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
    return out;
  }
  return value;
}

function stableJSON(value) {
  return JSON.stringify(sortKeys(value), null, 2) + '\n';
}

function emptyState() {
  return {
    version: VERSION,
    counters: {},
    startup: {
      mode: 'unknown',
      firstRun: false,
      steps: [],
      outcome: 'none',
    },
  };
}

function fail(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validName(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_NAME_LENGTH || !NAME_RE.test(value)) {
    throw fail(`${label} must be a lowercase bounded identifier`, 'INVALID_NAME');
  }
  return value;
}

function validMode(value) {
  const mode = value === undefined || value === null ? 'unknown' : String(value);
  if (!STARTUP_MODES.includes(mode)) throw fail(`Unsupported startup mode: ${mode}`, 'INVALID_MODE');
  return mode;
}

function normalizeState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw fail('Usage state must be an object', 'INVALID_STATE');
  }
  if (raw.version !== undefined && raw.version !== VERSION) {
    throw fail(`Unsupported usage state version: ${raw.version}`, 'UNSUPPORTED_VERSION');
  }

  const counters = raw.counters === undefined ? {} : raw.counters;
  if (!counters || typeof counters !== 'object' || Array.isArray(counters)) {
    throw fail('Usage counters must be an object', 'INVALID_COUNTERS');
  }
  const names = Object.keys(counters).sort();
  if (names.length > MAX_COUNTERS) throw fail('Usage counter limit exceeded', 'COUNTER_LIMIT');
  const normalizedCounters = {};
  for (const name of names) {
    validName(name, 'Counter name');
    const value = counters[name];
    if (!Number.isSafeInteger(value) || value < 0 || value > MAX_COUNTER_VALUE) {
      throw fail(`Invalid value for usage counter ${name}`, 'INVALID_COUNTER');
    }
    normalizedCounters[name] = value;
  }

  const startup = raw.startup === undefined ? emptyState().startup : raw.startup;
  if (!startup || typeof startup !== 'object' || Array.isArray(startup)) {
    throw fail('Startup facts must be an object', 'INVALID_STARTUP');
  }
  const steps = startup.steps === undefined ? [] : startup.steps;
  if (!Array.isArray(steps) || steps.length > MAX_STARTUP_STEPS) {
    throw fail('Startup step limit exceeded', 'STARTUP_STEP_LIMIT');
  }
  const normalizedSteps = [];
  for (const step of steps) {
    validName(step, 'Startup step');
    if (!normalizedSteps.includes(step)) normalizedSteps.push(step);
  }
  const outcome = startup.outcome === undefined ? 'none' : String(startup.outcome);
  if (!STARTUP_OUTCOMES.includes(outcome)) throw fail('Invalid startup outcome', 'INVALID_OUTCOME');
  if (startup.firstRun !== undefined && typeof startup.firstRun !== 'boolean') {
    throw fail('Startup firstRun must be boolean', 'INVALID_STARTUP');
  }
  if (outcome === 'none' && normalizedSteps.length) {
    throw fail('Startup steps require an active or terminal startup', 'INVALID_STARTUP');
  }

  return {
    version: VERSION,
    counters: normalizedCounters,
    startup: {
      mode: validMode(startup.mode),
      firstRun: Boolean(startup.firstRun),
      steps: normalizedSteps,
      outcome,
    },
  };
}

class UsageStore {
  /**
   * @param {string} filePath local JSON file owned by the app
   * @param {{ fs?: object }} [options] injectable filesystem for tests
   */
  constructor(filePath, options) {
    if (typeof filePath !== 'string' || !filePath) throw new TypeError('A usage file path is required');
    this.filePath = filePath;
    this.fs = (options && options.fs) || fs;
    this.state = emptyState();
    this.loadError = null;
  }

  /** Load existing state; malformed state is ignored and replaced on next write. */
  load() {
    this.loadError = null;
    if (!this.fs.existsSync(this.filePath)) return this;
    try {
      const raw = JSON.parse(this.fs.readFileSync(this.filePath, 'utf8'));
      this.state = normalizeState(raw);
    } catch (error) {
      this.state = emptyState();
      this.loadError = error && error.code ? error.code : 'INVALID_FILE';
    }
    return this;
  }

  /** Return a defensive copy; mutating it never mutates the live store. */
  exportState() { return clone(sortKeys(this.state)); }

  /** Return the exact stable JSON representation that flush() writes. */
  exportJSON() { return stableJSON(this.state); }

  /** Atomically replace the file with the current, sanitized state. */
  flush() {
    const directory = path.dirname(this.filePath);
    const temporary = `${this.filePath}.tmp`;
    this.fs.mkdirSync(directory, { recursive: true });
    try {
      this.fs.writeFileSync(temporary, this.exportJSON(), { encoding: 'utf8', mode: 0o600 });
      this.fs.renameSync(temporary, this.filePath);
    } catch (error) {
      try { if (this.fs.existsSync(temporary)) this.fs.unlinkSync(temporary); } catch { /* best effort */ }
      throw error;
    }
    return this;
  }

  /** Apply one mutation and roll the in-memory state back when persistence fails. */
  _update(mutator) {
    const before = this.state;
    const next = clone(before);
    mutator(next);
    normalizeState(next);
    try {
      this.state = next;
      this.flush();
    } catch (error) {
      this.state = before;
      throw error;
    }
    return this.exportState();
  }

  counter(name) {
    validName(name, 'Counter name');
    return this.state.counters[name] || 0;
  }

  counters() { return clone(sortKeys(this.state.counters)); }

  /** Increment a local counter, saturating instead of overflowing. */
  increment(name, amount) {
    validName(name, 'Counter name');
    const step = amount === undefined ? 1 : amount;
    if (!Number.isSafeInteger(step) || step <= 0) throw fail('Counter increment must be a positive integer', 'INVALID_INCREMENT');
    if (!Object.prototype.hasOwnProperty.call(this.state.counters, name) && Object.keys(this.state.counters).length >= MAX_COUNTERS) {
      throw fail('Usage counter limit exceeded', 'COUNTER_LIMIT');
    }
    return this._update((next) => {
      const current = next.counters[name] || 0;
      next.counters[name] = Math.min(MAX_COUNTER_VALUE, current + step);
    }).counters[name];
  }

  beginStartup(options) {
    const o = options || {};
    const mode = validMode(o.mode);
    const firstRun = Boolean(o.firstRun);
    return this._update((next) => {
      if (next.startup.outcome === 'in-progress') {
        next.counters.interrupted_launches = Math.min(MAX_COUNTER_VALUE, (next.counters.interrupted_launches || 0) + 1);
      }
      if (!Object.prototype.hasOwnProperty.call(next.counters, 'launches') && Object.keys(next.counters).length >= MAX_COUNTERS) {
        throw fail('Usage counter limit exceeded', 'COUNTER_LIMIT');
      }
      next.counters.launches = Math.min(MAX_COUNTER_VALUE, (next.counters.launches || 0) + 1);
      next.startup = { mode, firstRun, steps: [], outcome: 'in-progress' };
    }).startup;
  }

  markStartup(step) {
    validName(step, 'Startup step');
    if (this.state.startup.outcome !== 'in-progress') return false;
    if (this.state.startup.steps.includes(step)) return false;
    if (this.state.startup.steps.length >= MAX_STARTUP_STEPS) throw fail('Startup step limit exceeded', 'STARTUP_STEP_LIMIT');
    this._update((next) => { next.startup.steps.push(step); });
    return true;
  }

  completeStartup() {
    if (this.state.startup.outcome !== 'in-progress') return false;
    this._update((next) => {
      next.startup.outcome = 'completed';
      next.counters.successful_launches = Math.min(MAX_COUNTER_VALUE, (next.counters.successful_launches || 0) + 1);
    });
    return true;
  }

  failStartup() {
    if (this.state.startup.outcome !== 'in-progress') return false;
    this._update((next) => {
      next.startup.outcome = 'failed';
      next.counters.failed_launches = Math.min(MAX_COUNTER_VALUE, (next.counters.failed_launches || 0) + 1);
    });
    return true;
  }

  /** Clear every counter and startup fact, then persist the empty state. */
  reset() {
    const before = this.state;
    this.state = emptyState();
    try {
      this.flush();
    } catch (error) {
      this.state = before;
      throw error;
    }
    return this.exportState();
  }
}

module.exports = {
  UsageStore,
  VERSION,
  MAX_COUNTERS,
  MAX_COUNTER_VALUE,
  MAX_STARTUP_STEPS,
  STARTUP_MODES,
  STARTUP_OUTCOMES,
  emptyState,
  normalizeState,
  stableJSON,
};
