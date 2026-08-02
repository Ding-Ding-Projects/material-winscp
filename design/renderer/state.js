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
    const e = res.error;
    const err = new Error((e && e.message) || String(e) || 'IPC call failed');
    if (e && e.code) err.code = e.code;
    if (e && e.detail) err.detail = e.detail;
    throw err;
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

  /** The whole configuration document (prefs + sites + workspaces). */
  async configGet() {
    const a = this.raw;
    if (a?.config?.get) return unwrap(await a.config.get());
    return localConfigRead();
  },

  /**
   * Write a preferences patch. `label` becomes the version-history revision
   * label, so history entries name what changed rather than that something did.
   */
  async configSet(patch, label) {
    const a = this.raw;
    if (a?.config?.setPrefs) return unwrap(await a.config.setPrefs(patch, label || describePatch(patch)));
    const merged = deepMerge(localConfigRead(), patch);
    localConfigWrite(merged);
    return merged;
  },

  onConfigChanged(fn) {
    const a = this.raw;
    if (typeof a?.on === 'function') {
      try { return a.on('event:config', fn) || (() => {}); }
      catch { /* the event is allowlisted in preload; ignore if it is not */ }
    }
    return () => {};
  },

  windowMinimize() { return this.raw?.app?.window?.('minimize'); },
  windowMaximize() { return this.raw?.app?.window?.('toggle-maximize'); },
  windowClose() { return this.raw?.app?.window?.('close'); },

  async windowIsMaximized() {
    try {
      const a = this.raw;
      if (a?.app?.windowState) return !!(unwrap(await a.app.windowState())?.maximized);
    } catch { /* window state is cosmetic; never fail the shell over it */ }
    return false;
  },

  /**
   * Window state is polled rather than pushed — preload's event allowlist has
   * no window channel — so the title bar's maximise glyph stays truthful
   * without inventing an event that does not exist.
   */
  onWindowState(fn) {
    if (!hasBridge()) return () => {};
    let last = null;
    const tick = async () => {
      const maximized = await this.windowIsMaximized();
      if (maximized !== last) { last = maximized; fn({ maximized }); }
    };
    const timer = setInterval(tick, 700);
    window.addEventListener('resize', tick);
    tick();
    return () => { clearInterval(timer); window.removeEventListener('resize', tick); };
  },

  async appInfo() {
    try {
      const a = this.raw;
      if (a?.app?.info) return unwrap(await a.app.info());
    } catch { /* the shell has its own defaults */ }
    return null;
  },

  /**
   * Fonts installed on the host. The preload surface has no font enumeration,
   * so the appearance editor's family list is the bundled set plus whatever
   * the platform's local font access exposes — never a network lookup.
   */
  async listFonts() {
    try {
      if (typeof queryLocalFonts === 'function') {
        const fonts = await queryLocalFonts();
        return Array.from(new Set(fonts.map((f) => f.family))).sort();
      }
    } catch { /* permission denied or unsupported: the bundled list stands */ }
    return [];
  },

  /** A dim sum dish for the startup surprise: { id, en, zh, jy, img, dataUri }. */
  async dimSumRandom() {
    try {
      const a = this.raw;
      if (a?.app?.dimsum) {
        const dish = unwrap(await a.app.dimsum());
        if (dish) {
          // main returns a data: URI so the image never touches the network.
          return { ...dish, img: dish.dataUri || dish.img };
        }
      }
    } catch { /* the bundled catalog is the fallback */ }
    return null;
  },

  /** Tell main this dish was shown, so the next draws prefer a fresh one. */
  async dimSumSeen(dishId) {
    try { await this.raw?.app?.dimsumSeen?.(dishId); } catch { /* not fatal */ }
  },

  /** Whether this launch is a first run (the dim sum surprise must not fire). */
  async isFirstRun() {
    try {
      const info = await this.appInfo();
      if (info && typeof info.firstRun === 'boolean') return info.firstRun;
    } catch { /* the caller also checks its own config */ }
    return false;
  },

  /** Record a user-visible mutation for the git-backed version history. */
  async historyRecord(label) {
    try {
      const a = this.raw;
      if (a?.history?.snapshot) return unwrap(await a.history.snapshot(label));
    } catch (err) {
      // A history write must never fail the operation the user asked for.
      console.warn('[history] snapshot failed:', err?.message || err);
    }
    return null;
  },

  /** Open an external link through main; the renderer never navigates itself. */
  async openExternal(url) {
    try {
      const a = this.raw;
      if (a?.app?.openExternal) return unwrap(await a.app.openExternal(url));
    } catch (err) { console.warn('[app] openExternal refused:', err?.message || err); }
    return false;
  },
};

/** A readable revision label for a config patch: "Changed theme, language". */
function describePatch(patch) {
  const keys = Object.keys(patch || {});
  if (!keys.length) return 'Changed a setting';
  const names = {
    theme: 'the appearance settings', language: 'the language mode',
    funnyLevel: 'the funny level', notifications: 'the notification settings',
    tabs: 'the tab layout', search: 'a saved search', dimSum: 'the dim sum state',
    disclosureAccepted: 'the funny-level disclosure',
  };
  return `Changed ${keys.map((k) => names[k] || k).join(', ')}`;
}

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
/**
 * main's config:get returns { prefs, sites, folders, workspaces, needsUnlock }
 * while config:setPrefs takes a patch relative to `prefs`. The renderer's own
 * paths are all preferences, so both directions are rooted at prefs here and
 * a bare document (degraded mode) still works.
 */
function prefsOf(doc) {
  if (!doc || typeof doc !== 'object') return null;
  return doc.prefs && typeof doc.prefs === 'object' ? doc.prefs : doc;
}

function pickOwned(prefs) {
  const picked = {};
  for (const p of PERSISTED_PATHS) {
    const v = getPath(prefs, p);
    if (v !== undefined) Object.assign(picked, setPath({}, p, v));
  }
  return picked;
}

export async function loadConfig() {
  let incoming = null;
  try { incoming = await api.configGet(); }
  catch (err) { bus.emit('config:loadFailed', { error: err?.message || String(err) }); }

  const prefs = prefsOf(incoming);
  if (prefs) {
    const picked = pickOwned(prefs);
    if (Object.keys(picked).length) store.patch(picked, { source: 'load' });
    // The rest of the document is other modules' business; publish it once so
    // sites/workspaces panels can read it without a second round trip.
    if (incoming && incoming.prefs) bus.emit('config:document', incoming);
  }

  // Main pushes changes made elsewhere (a preferences write, an import).
  api.onConfigChanged((changed) => {
    const next = prefsOf(changed);
    if (!next) return;
    const picked = pickOwned(next);
    if (Object.keys(picked).length) store.patch(picked, { source: 'external' });
    bus.emit('config:document', changed);
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
