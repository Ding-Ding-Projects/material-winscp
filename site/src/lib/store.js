// lib/store.js — persisted per-visitor settings.
//
// One object, one storage key, one change event. Components read `store.get()`
// and subscribe; nothing else reads localStorage, so there is exactly one place
// where a stored value can be wrong.
//
// MIGRATION IS NOT OPTIONAL. A stored profile from an older visit is missing
// keys a newer build reads, and `undefined` propagating into a CSS variable
// produces a page that renders as unstyled text. `normalize()` therefore fills
// every gap from DEFAULTS and clamps every value into its real range on the way
// in, so a hand-edited or truncated export cannot brick the site.
//
// The storage backend is injectable so this whole module is testable without a
// browser: pass a Map-backed shim and the behaviour is identical.

export const DEFAULTS = {
  theme: 'system',                  // system | light | dark
  seed: '#0b57d0',                  // the accent the whole M3 scheme derives from
  contrastBoost: 0,                 // 0 … 1
  density: 0,                       // 0 … -3, Material's density scale
  fontFamily: 'system',             // a key into FONT_STACKS
  fontSize: 16,                     // px
  fontWeight: 400,
  reduceMotion: false,              // in addition to prefers-reduced-motion
  lang: 'en',                       // en | yue | both
  funnyEn: 3,                       // 1 … 5, independent per language
  funnyYue: 3,
  tabs: null,                       // set by tabs.js; see normalizeTabs()
  overrides: {},                    // per-element appearance overrides
};

/** Bundled locally, every one of them. No webfont is fetched: each entry is a
 *  stack of faces the visitor's own system already has, with a CJK face named
 *  explicitly so bilingual mode never falls back to a box glyph. */
export const FONT_STACKS = {
  system: { label: 'System UI', stack: "system-ui, 'Segoe UI', 'Microsoft JhengHei', 'Noto Sans HK', sans-serif" },
  sans: { label: 'Grotesque sans', stack: "'Segoe UI', Roboto, 'Helvetica Neue', 'Microsoft JhengHei', Arial, sans-serif" },
  serif: { label: 'Serif', stack: "Georgia, 'Times New Roman', 'Noto Serif HK', 'Microsoft JhengHei', serif" },
  mono: { label: 'Monospace', stack: "'Cascadia Mono', Consolas, 'Roboto Mono', 'Courier New', monospace" },
  rounded: { label: 'Rounded', stack: "'Segoe UI Variable Display', 'Nunito', 'Quicksand', 'Microsoft JhengHei', system-ui, sans-serif" },
};

const RANGES = {
  contrastBoost: [0, 1],
  density: [-3, 0],
  fontSize: [12, 24],
  fontWeight: [300, 700],
  funnyEn: [1, 5],
  funnyYue: [1, 5],
};
const ENUMS = {
  theme: ['system', 'light', 'dark'],
  lang: ['en', 'yue', 'both'],
  fontFamily: Object.keys(FONT_STACKS),
};

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Fill, clamp and reject. Anything unrecognised falls back to its default
 *  rather than reaching the DOM — the value came from a file a human edited. */
export function normalize(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    if (!(key in src)) continue;
    let v = src[key];
    if (key === 'overrides') { out.overrides = v && typeof v === 'object' ? { ...v } : {}; continue; }
    if (key === 'tabs') { out.tabs = v && typeof v === 'object' ? v : null; continue; }
    if (key === 'seed') { out.seed = /^#[0-9a-fA-F]{6}$/.test(String(v)) ? String(v).toLowerCase() : DEFAULTS.seed; continue; }
    if (key in ENUMS) { out[key] = ENUMS[key].includes(v) ? v : DEFAULTS[key]; continue; }
    if (key in RANGES) {
      const n = Number(v);
      out[key] = Number.isFinite(n) ? clamp(n, RANGES[key][0], RANGES[key][1]) : DEFAULTS[key];
      continue;
    }
    if (typeof DEFAULTS[key] === 'boolean') { out[key] = Boolean(v); continue; }
    out[key] = v;
  }
  return out;
}

export const STORAGE_KEY = 'winscp-material-site/v1';
export const EXPORT_KIND = 'winscp-material-site-settings';

/** Parse an exported settings file. Returns `{ ok, settings }` or
 *  `{ ok:false, error }` — never throws, because this is fed a file the user
 *  chose and "that is not a settings export" is a sentence, not a stack trace. */
export function parseExport(text) {
  let json;
  try { json = JSON.parse(String(text)); }
  catch (err) { return { ok: false, error: `not valid JSON (${err.message})` }; }
  if (!json || typeof json !== 'object') return { ok: false, error: 'not an object' };
  if (json.kind !== EXPORT_KIND) return { ok: false, error: `kind is ${JSON.stringify(json.kind ?? null)}` };
  return { ok: true, settings: normalize(json.settings) };
}

export function makeExport(settings, meta = {}) {
  return JSON.stringify({
    kind: EXPORT_KIND,
    version: 1,
    exported: new Date().toISOString(),
    site: meta.site || null,
    settings: normalize(settings),
  }, null, 2);
}

/**
 * The store. `backend` is anything with getItem/setItem — real localStorage in
 * a browser, a Map shim in a test, and `null` when storage is unavailable
 * (private mode throws on write, and a settings page that throws on every
 * keystroke is worse than one that simply does not persist).
 */
export function createStore(backend) {
  let state = DEFAULTS;
  const listeners = new Set();
  let broken = false;

  try {
    const raw = backend && backend.getItem(STORAGE_KEY);
    state = normalize(raw ? JSON.parse(raw) : {});
  } catch {
    state = { ...DEFAULTS };
    broken = true;
  }

  const persist = () => {
    if (!backend) return;
    try { backend.setItem(STORAGE_KEY, JSON.stringify(state)); }
    catch { broken = true; }
  };

  const emit = (changed) => { for (const fn of listeners) fn(state, changed); };

  return {
    get() { return state; },
    /** Storage refused us — the settings page says so instead of pretending. */
    get persistenceBroken() { return broken; },
    set(patch) {
      const next = normalize({ ...state, ...patch });
      const changed = Object.keys(patch).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(state[k]));
      if (!changed.length) return changed;
      state = next;
      persist();
      emit(changed);
      return changed;
    },
    reset(key) {
      if (key === undefined) { state = { ...DEFAULTS }; persist(); emit(Object.keys(DEFAULTS)); return; }
      this.set({ [key]: DEFAULTS[key] });
    },
    replace(settings) {
      state = normalize(settings);
      persist();
      emit(Object.keys(DEFAULTS));
    },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** The language options every leveled string needs, in one object. */
    langOpts() {
      return { lang: state.lang, funnyEn: state.funnyEn, funnyYue: state.funnyYue };
    },
  };
}

/** A storage shim, so tests (and a browser with storage disabled) behave the
 *  same as one with it. */
export function memoryBackend(initial = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}
