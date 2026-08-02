// i18n.js — three language modes and two independent funny-level sliders.
//
// The dictionary itself is design/winscp-i18n.js (EN + playful HK Cantonese,
// five levels where copy is voiced). This module does not restate any of it;
// it resolves, formats and binds it to the live UI.
//
//   t('connEstablished', host)        -> the string in the active mode
//   tPair('connEstablished', host)    -> { en, yue } for bilingual layout
//   bindText(el, key, ...params)      -> re-renders that element on change
//   subscribe(fn)                     -> called on any language/level change
//
// Bilingual mode never crowds the interface: t() returns "English · 粵語" for
// short strings, and bilingualNode() renders a prominent primary label with a
// compact secondary line for anything long enough to wrap.
//
// The funny level changes VOICE, never FACTS. Parameters ({0}, {1}) are
// substituted after resolution, so host names, paths, counts and version
// numbers are identical at level 1 and level 5.

import { I18N, resolveI18n } from '../winscp-i18n.js';
import { store, persistCurrent, bus } from './state.js';

export { I18N };

export const LANG_MODES = ['en', 'yue', 'both'];
export const LANG_LABELS = { en: 'English', yue: '粵語', both: 'EN · 粵' };

/** Level names, used by the preferences sliders' value labels. */
export const FUNNY_LABELS = {
  en: ['Fully serious', 'Plain', 'Balanced', 'Playful', 'Maximum playfulness'],
  yue: ['正經到底', '樸實', '啱啱好', '搞笑', '玩到盡'],
};

/* ------------------------------------------------------------------ */
/* resolution                                                          */
/* ------------------------------------------------------------------ */

function lang() { return store.get('language') || 'en'; }
function levelEn() { return clampLevel(store.get('funnyLevel.en')); }
function levelYue() { return clampLevel(store.get('funnyLevel.yue')); }
function clampLevel(v) { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(5, Math.max(1, n)) : 3; }

function format(str, params) {
  if (!params || !params.length) return str;
  return String(str).replace(/\{(\d+)\}/g, (m, i) => {
    const v = params[Number(i)];
    return v === undefined || v === null ? m : String(v);
  });
}

/**
 * The active-mode string for `key`. An unknown key returns the key itself
 * rather than an empty string, so a missing entry is visible in the UI and in
 * a screenshot instead of silently rendering blank.
 */
export function t(key, ...params) {
  const entry = I18N[key];
  if (!entry) return key;
  const resolved = resolveI18n(entry, lang(), levelEn(), levelYue());
  return format(resolved, params);
}

/** Both languages regardless of mode — for bilingual layout and for alt text. */
export function tPair(key, ...params) {
  const entry = I18N[key];
  if (!entry) return { en: key, yue: key };
  return {
    en: format(resolveI18n(entry, 'en', levelEn(), levelYue()), params),
    yue: format(resolveI18n(entry, 'yue', levelEn(), levelYue()), params),
  };
}

/** One specific language, ignoring the active mode (used by the narrator). */
export function tIn(language, key, ...params) {
  const entry = I18N[key];
  if (!entry) return key;
  return format(resolveI18n(entry, language, levelEn(), levelYue()), params);
}

/** True when the key exists — lets a module fall back to its own literal. */
export function has(key) { return Object.prototype.hasOwnProperty.call(I18N, key); }

/** Every key, for the changelog/settings search surfaces to index. */
export function keys() { return Object.keys(I18N); }

/* ------------------------------------------------------------------ */
/* bilingual rendering                                                 */
/* ------------------------------------------------------------------ */

const CROWD_LIMIT = 28;   // characters — above this, stack instead of inlining

/**
 * Render `key` for a label position. In bilingual mode short strings inline
 * with a middle dot; long ones become a prominent primary line plus a compact
 * secondary line, so a 5-level Cantonese sentence never overflows a control.
 *
 * Returns a DocumentFragment so callers can drop it straight into a button.
 */
export function bilingualNode(key, ...params) {
  const mode = lang();
  const frag = document.createDocumentFragment();
  if (mode !== 'both') {
    frag.appendChild(document.createTextNode(t(key, ...params)));
    return frag;
  }
  const { en, yue } = tPair(key, ...params);
  if (en === yue) { frag.appendChild(document.createTextNode(en)); return frag; }
  if (en.length + yue.length <= CROWD_LIMIT) {
    frag.appendChild(document.createTextNode(`${en} · ${yue}`));
    return frag;
  }
  const primary = document.createElement('span');
  primary.className = 'bi-primary';
  primary.textContent = en;
  const secondary = document.createElement('span');
  secondary.className = 'bi-secondary';
  secondary.lang = 'yue-Hant-HK';
  secondary.textContent = yue;
  frag.appendChild(primary);
  frag.appendChild(secondary);
  return frag;
}

/** The same decision, as a boolean, for callers laying out their own nodes. */
export function bilingualStacks(key, ...params) {
  if (lang() !== 'both') return false;
  const { en, yue } = tPair(key, ...params);
  return en !== yue && en.length + yue.length > CROWD_LIMIT;
}

/* ------------------------------------------------------------------ */
/* live binding                                                        */
/* ------------------------------------------------------------------ */

const bindings = new Set();

function refreshAll() {
  for (const b of Array.from(bindings)) {
    if (!b.el.isConnected) { bindings.delete(b); continue; }
    try { b.render(); } catch (err) { console.error('[i18n] binding failed', err); }
  }
  bus.emit('i18n:changed', { language: lang(), funnyLevel: { en: levelEn(), yue: levelYue() } });
}

/**
 * Bind an element's text to a key. The element re-renders whenever the
 * language mode or either funny level changes — no page reload, no re-mount.
 *
 * opts.attr writes to an attribute instead ('title', 'aria-label', 'placeholder').
 * opts.params may be a function so parameters can be recomputed on each render.
 */
export function bindText(el, key, opts = {}) {
  const render = () => {
    const params = typeof opts.params === 'function' ? opts.params() : (opts.params || []);
    if (opts.attr) { el.setAttribute(opts.attr, t(key, ...params)); return; }
    while (el.firstChild) el.removeChild(el.firstChild);
    el.appendChild(opts.bilingualBlock === false
      ? document.createTextNode(t(key, ...params))
      : bilingualNode(key, ...params));
  };
  const binding = { el, key, render };
  bindings.add(binding);
  render();
  return () => bindings.delete(binding);
}

/** Bind arbitrary rendering (a whole subtree) to language changes. */
export function bindRender(el, render) {
  const binding = { el, key: null, render };
  bindings.add(binding);
  render();
  return () => bindings.delete(binding);
}

/** A <span> already bound to a key. The most common call in the app. */
export function label(key, opts = {}) {
  const el = document.createElement(opts.tag || 'span');
  if (opts.class) el.className = opts.class;
  bindText(el, key, opts);
  return el;
}

const subscribers = new Set();
/** subscribe(fn) — fn() runs on every language/level change. */
export function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

function notify() {
  refreshAll();
  for (const fn of Array.from(subscribers)) {
    try { fn({ language: lang(), funnyLevel: { en: levelEn(), yue: levelYue() } }); }
    catch (err) { console.error('[i18n] subscriber failed', err); }
  }
  document.documentElement.lang = lang() === 'yue' ? 'yue-Hant-HK' : lang() === 'both' ? 'en' : 'en';
  document.documentElement.dataset.lang = lang();
}

/* ------------------------------------------------------------------ */
/* mutators                                                            */
/* ------------------------------------------------------------------ */

export function setLanguage(mode) {
  if (!LANG_MODES.includes(mode)) return;
  store.set('language', mode);
  persistCurrent('language');
}

export function cycleLanguage() {
  const i = LANG_MODES.indexOf(lang());
  setLanguage(LANG_MODES[(i + 1) % LANG_MODES.length]);
}

/** Independent per-language slider, 1 (fully serious) … 5 (maximum play). */
export function setFunnyLevel(language, level) {
  if (language !== 'en' && language !== 'yue') return;
  store.set(`funnyLevel.${language}`, clampLevel(level));
  persistCurrent('funnyLevel');
}

export function getFunnyLevel(language) { return language === 'yue' ? levelYue() : levelEn(); }
export function getLanguage() { return lang(); }

/**
 * The honest disclosure the user is shown before opting in: the funny level
 * styles EVERY category of message, including errors and warnings. Facts are
 * never removed — only the voice around them changes.
 */
export function disclosureText() {
  const en = 'The funny level changes the wording of every message in the app, including errors, warnings and destructive-action prompts. '
    + 'What a message says never changes — the file, the account, the action and whether it can be undone are always stated plainly. '
    + 'You can change or reset both sliders at any time in Preferences → Languages.';
  const yue = '好笑程度會改變 app 入面每一句說話嘅語氣，包括錯誤、警告同埋唔可以復原嘅操作提示。'
    + '講嘅事實永遠唔會變——邊個檔案、邊個帳戶、做乜嘢、可唔可以還原，一律照直講。'
    + '你隨時可以喺「偏好設定 → 語言」度改返或者重設兩條拉桿。';
  const mode = lang();
  if (mode === 'en') return en;
  if (mode === 'yue') return yue;
  return `${en}\n\n${yue}`;
}

/* ------------------------------------------------------------------ */
/* engine                                                             */
/* ------------------------------------------------------------------ */

let started = false;

export function startI18n() {
  if (started) return;
  started = true;
  store.subscribe('language', notify, { immediate: false });
  store.subscribe('funnyLevel', notify, { immediate: false });
  notify();
}

/**
 * A plain-language description of the active mode, for the title-bar chip's
 * tooltip. Names the mode and both levels so the state is never a mystery.
 */
export function languageSummary() {
  const modeName = { en: 'English', yue: '粵語 (Cantonese)', both: 'Bilingual · 雙語' }[lang()];
  return `${modeName} — EN funny level ${levelEn()}/5, 粵語 ${levelYue()}/5`;
}
