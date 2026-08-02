// state.js — the renderer's single source of truth.
//
// Three things live here and nothing else does:
//   1. `bus`   — the application event bus (pub/sub, no DOM involved)
//   2. `store` — observable configuration + session state with path selectors
//   3. `api`   — a thin façade over window.api (the preload contextBridge)
//
// Other modules never read window.api directly; they go through `api` so the
// degraded mode below (no preload yet) behaves identically everywhere.

/* ------------------------------------------------------------------ */
/* event bus                                                           */
/* ------------------------------------------------------------------ */

function createBus() {
  const map = new Map();
  return {
    /** on('tabs:changed', fn) -> off() */
    on(type, fn) {
      if (!map.has(type)) map.set(type, new Set());
      map.get(type).add(fn);
      return () => map.get(type)?.delete(fn);
    },
    once(type, fn) {
      const off = this.on(type, (...a) => { off(); fn(...a); });
      return off;
    },
    emit(type, payload) {
      const set = map.get(type);
      if (set) for (const fn of Array.from(set)) {
        try { fn(payload, type); } catch (err) { console.error(`[bus] ${type} listener failed`, err); }
      }
      const all = map.get('*');
      if (all) for (const fn of Array.from(all)) {
        try { fn(payload, type); } catch (err) { console.error('[bus] * listener failed', err); }
      }
    },
    types() { return Array.from(map.keys()); },
  };
}

export const bus = createBus();

/* ------------------------------------------------------------------ */
/* window.api façade                                                   */
/* ------------------------------------------------------------------ */
// The preload surface is documented in docs/architecture.md: every IPC handler
// resolves { ok:true, value } or { ok:false, error } and never throws across
// the bridge. unwrap() turns that into a value-or-throw for our own code.

function unwrap(res) {
  if (res == null) return null;
  if (typeof res === 'object' && 'ok' in res) {
    if (res.ok) return res.value;
    throw new Error(res.error || 'IPC call failed');
  }
  return res;                                   // handler returned a bare value
}

const LS_KEY = 'winscp-material.renderer.config';

/** True when the preload bridge is present. */
export function hasBridge() { return typeof window !== 'undefined' && !!window.api; }

/**
 * Degraded mode: with no preload bridge (a plain browser, or main.js not yet
 * loaded) configuration is kept in localStorage so the UI is still fully
 * usable and every control still does what it says. `api.degraded` is true so
 * the shell can tell the user their settings are not reaching the app's own
 * config file. This is a fallback, never a pretend-success.
 */
function localConfigRead() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch { return {}; }
}
function localConfigWrite(obj) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(obj)); return true; } catch { return false; }
}

export const api = {
  get degraded() { return !hasBridge(); },
  get raw() { return typeof window !== 'undefined' ? window.api : undefined; },

  async configGet() {
    const a = this.raw;
    if (a?.config?.get) return unwrap(await a.config.get());
    if (a?.invoke) return unwrap(await a.invoke('config:get'));
    return localConfigRead();
  },
  async configSet(patch) {
    const a = this.raw;
    if (a?.config?.set) return unwrap(await a.config.set(patch));
    if (a?.invoke) return unwrap(await a.invoke('config:set', patch));
    const merged = deepMerge(localConfigRead(), patch);
    localConfigWrite(merged);
    return merged;
  },
  onConfigChanged(fn) {
    const a = this.raw;
    if (a?.config?.onChanged) return a.config.onChanged(fn) || (() => {});
    if (a?.on) return a.on('config:changed', fn) || (() => {});
    return () => {};
  },

  windowMinimize() { const a = this.raw; return a?.app?.minimize?.() ?? a?.invoke?.('app:minimize'); },
  windowMaximize() { const a = this.raw; return a?.app?.maximize?.() ?? a?.invoke?.('app:maximize'); },
  windowClose()    { const a = this.raw; return a?.app?.close?.()    ?? a?.invoke?.('app:close'); },
  async windowIsMaximized() {
    const a = this.raw;
    try {
      if (a?.app?.isMaximized) return !!unwrap(await a.app.isMaximized());
      if (a?.invoke) return !!unwrap(await a.invoke('app:isMaximized'));
    } catch { /* window state is cosmetic; never fail the shell over it */ }
    return false;
  },
  onWindowState(fn) {
    const a = this.raw;
    if (a?.app?.onWindowState) return a.app.onWindowState(fn) || (() => {});
    if (a?.on) return a.on('app:windowState', fn) || (() => {});
    return () => {};
  },

  async appInfo() {
    const a = this.raw;
    try {
      if (a?.app?.info) return unwrap(await a.app.info());
      if (a?.invoke) return unwrap(await a.invoke('app:info'));
    } catch { /* fall through */ }
    return null;
  },

  /** Fonts installed on the host, for the appearance editor's family list. */
  async listFonts() {
    const a = this.raw;
    try {
      if (a?.app?.fonts) return unwrap(await a.app.fonts()) || [];
      if (a?.fonts?.list) return unwrap(await a.fonts.list()) || [];
      if (a?.invoke) return unwrap(await a.invoke('app:fonts')) || [];
    } catch { /* the bundled list is always available as a floor */ }
    return [];
  },

  /** A dim sum dish for the startup surprise: { id, en, zh, jy, img }. */
  async dimSumRandom() {
    const a = this.raw;
    try {
      if (a?.dimsum?.random) return unwrap(await a.dimsum.random());
      if (a?.invoke) return unwrap(await a.invoke('app:dimsum'));
    } catch { /* the bundled catalog is the fallback */ }
    return null;
  },

  /** Whether this launch is a first run (the dim sum surprise must not fire). */
  async isFirstRun() {
    const a = this.raw;
    try {
      if (a?.app?.isFirstRun) return !!unwrap(await a.app.isFirstRun());
      if (a?.invoke) return !!unwrap(await a.invoke('app:isFirstRun'));
    } catch { /* assume not, the caller also checks its own config */ }
    return false;
  },

  /** Record a user-visible mutation for the git-backed version history. */
  async historyRecord(label, payload) {
    const a = this.raw;
    try {
      if (a?.history?.record) return unwrap(await a.history.record(label, payload));
      if (a?.invoke) return unwrap(await a.invoke('history:record', { label, payload }));
    } catch (err) {
      // A history write must never fail the operation the user asked for.
      console.warn('[history] snapshot failed:', err?.message || err);
    }
    return null;
  },
};

/* ------------------------------------------------------------------ */
/* deep helpers                                                        */
/* ------------------------------------------------------------------ */

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function deepMerge(base, patch) {
  if (!isPlain(patch)) return patch === undefined ? base : patch;
  const out = isPlain(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = isPlain(v) && isPlain(out[k]) ? deepMerge(out[k], v) : Array.isArray(v) ? v.slice() : v;
  }
  return out;
}

export function getPath(obj, path) {
  if (!path) return obj;
  let cur = obj;
  for (const seg of String(path).split('.')) {
    if (cur == null) return undefined;
    cur = cur[seg];
  }
  return cur;
}

export function setPath(obj, path, value) {
  const segs = String(path).split('.');
  const out = isPlain(obj) ? { ...obj } : {};
  let cur = out;
  for (let i = 0; i < segs.length - 1; i += 1) {
    const s = segs[i];
    cur[s] = isPlain(cur[s]) ? { ...cur[s] } : {};
    cur = cur[s];
  }
  cur[segs[segs.length - 1]] = value;
  return out;
}

export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a == null || b == null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (typeof a !== 'object') return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual(a[k], b[k]));
}

/* ------------------------------------------------------------------ */
/* the store                                                           */
/* ------------------------------------------------------------------ */

/**
 * Renderer-side defaults. These mirror design/main/defaults.js for the keys the
 * UI owns; main's config is authoritative and merges over the top on load.
 */
export const RENDERER_DEFAULTS = {
  theme: {
    mode: 'system',            // light | dark | system
    seed: '#0B57D0',
    contrast: 0,               // 0 standard | 0.5 medium | 1 high
    density: 0,                // 0 .. -3 (Material density scale)
    uiScale: 1,                // 1 = 100%, also 1.25 / 1.5 / 2
    fontFamily: 'system-ui',
    fontSize: 14,
    fontWeight: 400,
    reduceMotion: false,
    perElement: {},            // appearance-key -> style overrides
    presets: [],               // named, exportable appearance presets
  },
  language: 'en',              // en | yue | both
  funnyLevel: { en: 3, yue: 3 },
  disclosureAccepted: false,
  notifications: { durationSec: 6, position: 'bottom-right', centreLimit: 200 },
  tabs: { order: [], pinned: [], groups: [], groupOrder: [], collapsed: [], appearance: {} },
  search: {},                  // search-bar id -> { query, pattern, flags, mode }
  dimSum: { lastLaunchId: '', seen: [] },
};

function createStore(initial) {
  let state = initial;
  const subs = new Set();          // {path, fn, last}
  let batching = 0;
  let dirty = false;

  function notify() {
    if (batching > 0) { dirty = true; return; }
    for (const s of Array.from(subs)) {
      const next = getPath(state, s.path);
      if (s.path && deepEqual(next, s.last)) continue;
      s.last = next;
      try { s.fn(next, state); } catch (err) { console.error(`[store] subscriber for "${s.path}" failed`, err); }
    }
  }

  return {
    get state() { return state; },
    get(path) { return getPath(state, path); },

    /** Replace a value at a dot path. Emits to matching subscribers only. */
    set(path, value, meta = {}) {
      const prev = getPath(state, path);
      if (deepEqual(prev, value)) return state;
      state = setPath(state, path, value);
      notify();
      bus.emit('state:changed', { path, value, prev, meta });
      return state;
    },

    /** Deep-merge a patch object into the root. */
    patch(patchObj, meta = {}) {
      const next = deepMerge(state, patchObj);
      if (deepEqual(next, state)) return state;
      state = next;
      notify();
      bus.emit('state:changed', { path: '', value: state, meta });
      return state;
    },

    /** Several writes, one notification. */
    batch(fn) {
      batching += 1;
      try { fn(); } finally {
        batching -= 1;
        if (batching === 0 && dirty) { dirty = false; notify(); }
      }
    },

    /**
     * subscribe('theme.mode', fn) — fires immediately with the current value
     * unless { immediate:false }. Returns unsubscribe.
     */
    subscribe(path, fn, opts = {}) {
      const entry = { path, fn, last: getPath(state, path) };
      subs.add(entry);
      if (opts.immediate !== false) { try { fn(entry.last, state); } catch (err) { console.error(err); } }
      return () => subs.delete(entry);
    },
  };
}

export const store = createStore(structuredCloneSafe(RENDERER_DEFAULTS));

function structuredCloneSafe(v) {
  try { return structuredClone(v); } catch { return JSON.parse(JSON.stringify(v)); }
}

/* ------------------------------------------------------------------ */
/* persistence                                                         */
/* ------------------------------------------------------------------ */

const PERSISTED_PATHS = ['theme', 'language', 'funnyLevel', 'disclosureAccepted', 'notifications', 'tabs', 'search', 'dimSum'];

let saveTimer = 0;
let pendingPatch = {};
let savingDisabled = false;

/** Queue a persisted write; several calls in a frame coalesce into one. */
export function persist(patchObj) {
  pendingPatch = deepMerge(pendingPatch, patchObj);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushPersist, 250);
}

export async function flushPersist() {
  clearTimeout(saveTimer);
  const patchObj = pendingPatch;
  pendingPatch = {};
  if (!Object.keys(patchObj).length || savingDisabled) return;
  try {
    await api.configSet(patchObj);
    bus.emit('config:saved', patchObj);
  } catch (err) {
    bus.emit('config:saveFailed', { error: err?.message || String(err), patch: patchObj });
  }
}

/** Persist whatever the store currently holds for the owned paths. */
export function persistCurrent(...paths) {
  const list = paths.length ? paths : PERSISTED_PATHS;
  const patchObj = {};
  for (const p of list) {
    const v = store.get(p);
    if (v !== undefined) Object.assign(patchObj, setPath({}, p, v));
  }
  persist(patchObj);
}

/**
 * Load configuration from main (or localStorage in degraded mode) and merge it
 * over the renderer defaults. Resolves to the merged state.
 */
export async function loadConfig() {
  let incoming = null;
  try { incoming = await api.configGet(); }
  catch (err) { bus.emit('config:loadFailed', { error: err?.message || String(err) }); }
  if (incoming && typeof incoming === 'object') {
    const picked = {};
    for (const p of PERSISTED_PATHS) {
      const v = getPath(incoming, p);
      if (v !== undefined) Object.assign(picked, setPath({}, p, v));
    }
    store.patch(picked, { source: 'load' });
  }
  // Main may push changes made elsewhere (a preferences write, an import).
  api.onConfigChanged((changed) => {
    if (!changed || typeof changed !== 'object') return;
    const picked = {};
    for (const p of PERSISTED_PATHS) {
      const v = getPath(changed, p);
      if (v !== undefined) Object.assign(picked, setPath({}, p, v));
    }
    if (Object.keys(picked).length) store.patch(picked, { source: 'external' });
  });
  bus.emit('config:loaded', store.state);
  return store.state;
}

/** Stop writing config — used by the tests/preview path, never in the app. */
export function setPersistenceEnabled(enabled) { savingDisabled = !enabled; }

/* ------------------------------------------------------------------ */
/* session-scoped (non-persisted) state                                */
/* ------------------------------------------------------------------ */

const ephemeral = new Map();

/** Volatile state other modules can share without polluting the config. */
export const session = {
  get(key, fallback) { return ephemeral.has(key) ? ephemeral.get(key) : fallback; },
  set(key, value) {
    const prev = ephemeral.get(key);
    if (deepEqual(prev, value)) return value;
    ephemeral.set(key, value);
    bus.emit(`session:${key}`, value);
    bus.emit('session:changed', { key, value, prev });
    return value;
  },
  subscribe(key, fn, opts = {}) {
    if (opts.immediate !== false) { try { fn(ephemeral.get(key)); } catch (err) { console.error(err); } }
    return bus.on(`session:${key}`, fn);
  },
  delete(key) { ephemeral.delete(key); bus.emit(`session:${key}`, undefined); },
};

/** A per-launch identifier — used by the dim sum draw to fire at most once. */
export const LAUNCH_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
