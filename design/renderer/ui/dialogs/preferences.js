// ui/dialogs/preferences.js — the Preferences dialog.
//
// WinSCP's Preferences.dfm is 318 controls across a navigation tree; this is
// that dialog, rebuilt from the schema in prefpages.js so the pages, the
// search index and the transfer-settings frame all read from one declaration.
//
// Two decisions are worth stating up front, because they differ from the
// original and the difference is deliberate:
//
//   * Changes apply IMMEDIATELY, not on OK. A theme, a density or a funny
//     level that only takes effect after a modal is dismissed cannot be
//     previewed, and a preference that is buffered is a preference that can be
//     lost. The Cancel affordance is not dropped, though: the dialog snapshots
//     every value it can change when it opens, and "Revert changes" puts every
//     one of them back — including the ones already written to disk.
//
//   * Writes go through config:setPref (one dotted key at a time) rather than
//     config:setPrefs (a patch). setPref mutates the live preferences object in
//     place, so a running queue or session sees the new value without being
//     rebuilt, and every write carries its own revision label naming what
//     changed rather than that something did.
//
// Everything here is reachable by keyboard, every row is an appearance target,
// and the two search bars (all pages / this page) are the shared
// createSearchBar with its anchored regex builder — never a hand-rolled field.

import { h, icon, clear, appearanceTarget, announce, openModal, anchorTo, layer, focusMemory, rovingFocus, copyText, isReducedMotion } from '../../dom.js';
import { store, bus, api, persistCurrent, session } from '../../state.js';
import { t, getLanguage, bindRender, disclosureText, setLanguage, setFunnyLevel } from '../../i18n.js';
import { theme as themeApi, styleSheet } from '../../theme.js';
import { createSearchBar, noMatchMessage } from '../searchbar.js';
import { colorSwatchButton } from '../colorpicker.js';
import { registerContextMenu, SEPARATOR, closeAllMenus } from '../contextmenu.js';
import { notify } from '../notifications.js';
import { registerDialog, registerCommand, funnySlider } from '../../app.js';
import {
  PAGES, orderedPages, pageById, flattenControls, renderControl, localized,
  describeValue, matchPreferences, matchesByPage, getAt, searchFieldsFor, isPending,
  normalizeNumberInput,
} from './prefpages.js';
import { createCopyParamsFrame, createPresetList, openCopyParamPreset } from './copyparams.js';
import { createEditorList } from './editorpreferences.js';
import { createCommandList } from './customcommand.js';

/** A bilingual literal for the strings this module owns; the dictionary has
 * no key for them, and bilingual mode must still show both languages. */
const tx = (en, yueText) => localized({ en, yue: yueText });

/* ================================================================== */
/* the preferences value store                                         */
/* ================================================================== */
//
// Main owns the durable configuration; the renderer's own `store` owns the
// handful of paths that must repaint the live UI (theme, language, funny
// levels, toasts, tabs). `prefs` below is the single reader/writer that knows
// which is which, so no page has to remember.

const RENDERER_LIVE = new Set([
  'theme.mode', 'theme.seed', 'theme.density', 'theme.uiScale', 'theme.fontFamily',
  'theme.fontSize', 'theme.fontWeight', 'theme.reduceMotion',
  'language', 'funnyLevel.en', 'funnyLevel.yue',
  'notifications.durationSec', 'notifications.position', 'notifications.centreLimit',
]);

/**
 * How a live path reaches the running UI. Every entry here does real work: the
 * theme engine repaints, i18n re-renders every bound node, the toast stack
 * moves corner, the queue's limit changes without a restart.
 */
const LIVE_APPLY = {
  'theme.mode': (v) => themeApi.setMode(v),
  'theme.seed': (v) => themeApi.setSeed(v),
  'theme.density': (v) => themeApi.setDensity(v),
  'theme.uiScale': (v) => themeApi.setScale(v),
  'theme.fontFamily': (v) => themeApi.setFontFamily(v),
  'theme.fontSize': (v) => themeApi.setFontSize(v),
  'theme.fontWeight': (v) => themeApi.setFontWeight(v),
  'theme.reduceMotion': (v) => themeApi.setReduceMotion(v),
  language: (v) => setLanguage(v),
  'funnyLevel.en': (v) => setFunnyLevel('en', v),
  'funnyLevel.yue': (v) => setFunnyLevel('yue', v),
  'notifications.durationSec': (v) => { store.set('notifications.durationSec', v); persistCurrent('notifications'); },
  'notifications.position': (v) => { store.set('notifications.position', v); persistCurrent('notifications'); },
  'notifications.centreLimit': (v) => { store.set('notifications.centreLimit', v); persistCurrent('notifications'); },
};

/**
 * Keys whose behaviour is owned by a running main-process object that snapshots
 * its settings at construction. Writing the preference is not enough for those,
 * so the live object is told as well.
 */
const LIVE_MAIN = {
  'queue.transfersLimit': async (v) => { await api.raw?.queue?.setLimit?.(v); },
  'queue.enabledByDefault': async (v) => { await api.raw?.queue?.setEnabled?.(v); },
};

const prefs = {
  values: {},          // main's `prefs` object, cached
  loaded: false,
  _subs: new Set(),

  async load(force = false) {
    if (this.loaded && !force) return this.values;
    try {
      const doc = await api.configGet();
      this.values = (doc && doc.prefs && typeof doc.prefs === 'object') ? doc.prefs : (doc || {});
      this.loaded = true;
      this._notify('load');
    } catch (err) {
      // A failed read must not leave the dialog showing invented values.
      this.values = this.values || {};
      throw err;
    }
    return this.values;
  },

  /** Adopt a document main pushed at us (an import, a history restore). */
  adopt(doc) {
    const next = (doc && doc.prefs && typeof doc.prefs === 'object') ? doc.prefs : null;
    if (!next) return;
    this.values = next;
    this.loaded = true;
    this._notify('external');
  },

  /**
   * A key absent from the stored configuration is at its default — that is
   * true of a partially written config file and of the degraded localStorage
   * path alike. Falling through to the schema's declared default is what keeps
   * "Deleting of files (recommended)" showing as ON before anything has been
   * written, rather than showing every confirmation as switched off.
   */
  get(key) {
    if (RENDERER_LIVE.has(key)) {
      const v = store.get(key);
      if (v !== undefined) return v;
    }
    const stored = getAt(this.values, key);
    return stored === undefined ? schemaDefault(key) : stored;
  },

  /**
   * Commit one option. `label` becomes the version-history revision label, so
   * the history panel reads "Changed the maximum simultaneous transfers"
   * rather than "Updated settings".
   */
  async set(key, value, label) {
    const before = this.values;
    const hadValue = getAt(before, key) !== undefined;
    const previous = getAt(before, key);
    // Keep the local cache in step immediately: the dialog re-renders from it
    // and must never show a stale value while the write is in flight.
    this.values = assignPath(this.values, key, value);
    this._notify();

    try {
      if (RENDERER_LIVE.has(key) && LIVE_APPLY[key]) {
        // These paths persist themselves through state.js's own writer.
        LIVE_APPLY[key](value);
      } else {
        const a = api.raw;
        if (a?.config?.setPref) {
          const res = await a.config.setPref(key, value, label);
          if (res && res.ok === false) throw new Error(res.error?.message || `Could not write ${key}`);
        } else {
          // Degraded mode (no preload bridge): the façade's localStorage path.
          await api.configSet(pathPatch(key, value), label);
        }
      }
    } catch (err) {
      // A rejected write must not leave a value that never reached durable
      // storage in the live cache. Restore the exact shape that was there,
      // including the absent-key case, then repaint subscribers before the
      // caller reports the failure.
      this.values = hadValue ? assignPath(before, key, previous) : deletePath(before, key);
      if (RENDERER_LIVE.has(key) && LIVE_APPLY[key]) {
        try { LIVE_APPLY[key](this.get(key)); } catch { /* best-effort repaint */ }
      }
      this._notify('rollback');
      throw err;
    }
    if (LIVE_MAIN[key]) { try { await LIVE_MAIN[key](value); } catch { /* the stored value still stands */ } }
    bus.emit('prefs:changed', { key, value });
  },

  subscribe(fn) { this._subs.add(fn); return () => this._subs.delete(fn); },
  _notify(source) {
    for (const fn of Array.from(this._subs)) {
      try { fn(this.values, source); } catch (err) { console.error('[preferences] subscriber failed', err); }
    }
  },
};

/**
 * Keys that must NEVER be written as a plain preference, because the value is
 * only half of the state it describes.
 *
 * `security.masterPasswordVerifier` carries the scrypt salt that every stored
 * site password was wrapped with; `security.useMasterPassword` is what tells
 * the application to ask for that password at all. Config.enableMasterPassword
 * and Config.disableMasterPassword change them TOGETHER with a re-encryption
 * pass over every stored secret. Writing either one on its own — which is what
 * a snapshot restore or a page reset would do — leaves the secrets wrapped
 * under a key whose salt has just been erased, and no correct password can
 * recover them afterwards. They are reachable only through the password flow.
 */
const MASTER_PASSWORD_KEYS = new Set(['security.useMasterPassword', 'security.masterPasswordVerifier']);

/** Declared defaults, keyed by dot path — built once from the schema. */
let defaultMap = null;
function schemaDefault(key) {
  if (!defaultMap) {
    defaultMap = new Map();
    for (const { control } of flattenControls(PAGES)) {
      if (!('def' in control)) continue;
      defaultMap.set(control.key, control.def);
      for (const also of control.alsoKeys || []) if (!defaultMap.has(also)) defaultMap.set(also, control.def);
    }
  }
  return defaultMap.get(key);
}

function assignPath(obj, dotted, value) {
  const segs = String(dotted).split('.');
  const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
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

function deletePath(obj, dotted) {
  const segs = String(dotted).split('.');
  const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const out = isPlain(obj) ? { ...obj } : {};
  let cur = out;
  for (let i = 0; i < segs.length - 1; i += 1) {
    const s = segs[i];
    cur[s] = isPlain(cur[s]) ? { ...cur[s] } : {};
    cur = cur[s];
  }
  delete cur[segs[segs.length - 1]];
  return out;
}

function pathPatch(dotted, value) { return assignPath({}, dotted, value); }

bus.on('config:document', (doc) => prefs.adopt(doc));

/** Read access for the other dialogs in this folder. */
export function readPref(key) { return prefs.get(key); }
export async function writePref(key, value, label) { return prefs.set(key, value, label); }
export function subscribePrefs(fn) { return prefs.subscribe(fn); }
export async function loadPrefs(force) { return prefs.load(force); }

/* ================================================================== */
/* styles                                                              */
/* ================================================================== */
//
// Injected rather than added to components.css because this module owns them.
// Everything is sized against --den and --uiscale so the dialog holds at 200%.

let stylesInstalled = false;
export function ensurePreferenceStyles() {
  if (stylesInstalled) return;
  stylesInstalled = true;
  styleSheet('preferences').set(`
/* openModal() sizes with max-width, but .modal already declares
   width: min(560px, 100%) — so a max-width alone never widens a dialog. These
   rules key off a class on the content instead, which is the only way to make
   a settings-sized dialog without editing the shared stylesheet. */
.modal:has(.prefs) { width: min(1080px, 100%); max-width: none; padding: 0; gap: 0; }
.modal:has(.dlg-wide) { width: min(760px, 100%); max-width: none; }
.modal:has(.dlg-widest) { width: min(980px, 100%); max-width: none; }
.modal:has(.prefs) .modal-title { padding: calc(18px * var(--den)) calc(22px * var(--den)) 0; }
.modal:has(.prefs) .modal-body { padding: 0; }
.modal:has(.prefs) .modal-actions { padding: calc(12px * var(--den)) calc(22px * var(--den)) calc(16px * var(--den)); }

/* Fractional columns with a ZERO minimum. A fixed minimum cannot work here:
   the shared search bar carries min-width: 180px * --uiscale, so at 200% scale
   in a narrow window the nav column would be smaller than its own search field
   and the field would spill across the page header. */
.prefs { display: grid; grid-template-columns: minmax(0, 0.34fr) minmax(0, 1fr); min-height: 0;
         height: min(66vh, calc(680px * var(--uiscale))); }
.prefs-nav { display: flex; flex-direction: column; min-height: 0; min-width: 0; overflow: hidden;
             border-right: 1px solid var(--outline-var); background: var(--c-low); }
.prefs-nav-search .sb, .prefs-page-search .sb, .pref-list .sb { min-width: 0; }
.prefs-nav-search { padding: calc(10px * var(--den)) calc(10px * var(--den)) calc(6px * var(--den)); }
.prefs-tree { flex: 1 1 auto; overflow-y: auto; padding: 0 calc(6px * var(--den)) calc(10px * var(--den)); }
.prefs-nav-item { display: flex; align-items: center; gap: calc(8px * var(--den)); width: 100%;
                  min-height: calc(36px * var(--den)); padding: 0 calc(10px * var(--den));
                  border-radius: var(--shape-full); background: none; border: none; color: var(--onsfc);
                  font-size: var(--type-label-md); text-align: start; cursor: pointer; }
.prefs-nav-item:hover { background: color-mix(in srgb, var(--onsfc) 8%, transparent); }
.prefs-nav-item.is-active { background: var(--secc); color: var(--onsecc); font-weight: 600; }
.prefs-nav-item[data-depth="1"] { padding-inline-start: calc(28px * var(--den)); }
.prefs-nav-item[data-depth="2"] { padding-inline-start: calc(44px * var(--den)); }
.prefs-nav-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.prefs-nav-count { flex: 0 0 auto; font-size: var(--type-label-sm); font-family: var(--mono);
                   background: var(--pc); color: var(--onpc); border-radius: var(--shape-full); padding: 1px 7px; }

.prefs-main { min-width: 0; min-height: 0; overflow-y: auto; padding: calc(14px * var(--den)) calc(20px * var(--den)) calc(24px * var(--den)); }
.prefs-page-head { display: flex; align-items: flex-start; gap: calc(10px * var(--den)); margin-bottom: calc(8px * var(--den)); flex-wrap: wrap; }
.prefs-page-title { font-size: var(--type-title-lg); font-weight: 400; flex: 1 1 auto; min-width: 0; }
.prefs-crumb { font-size: var(--type-label-sm); color: var(--onsv); }
.prefs-page-desc { font-size: var(--type-body-sm); color: var(--onsv); line-height: 1.55; margin-bottom: calc(10px * var(--den)); max-width: 74ch; }
.prefs-page-search { margin-bottom: calc(12px * var(--den)); display: flex; }

.prefs-section { border: 1px solid var(--outline-var); border-radius: var(--shape-lg);
                 padding: calc(12px * var(--den)) calc(14px * var(--den)); margin-bottom: calc(12px * var(--den));
                 background: var(--c-lowest); }
.prefs-section-title { font-size: var(--type-label-sm); text-transform: uppercase; letter-spacing: .05em;
                       font-weight: 700; color: var(--onsv); margin-bottom: calc(8px * var(--den)); }
.prefs-section-desc { font-size: var(--type-label-md); color: var(--onsv); line-height: 1.5;
                      margin-bottom: calc(10px * var(--den)); max-width: 74ch; }
.prefs-section-actions { display: flex; gap: calc(8px * var(--den)); flex-wrap: wrap; margin-top: calc(10px * var(--den)); }

.pref-row { display: flex; flex-direction: column; gap: 4px; padding: calc(6px * var(--den)) 0; min-width: 0; }
.pref-row.is-disabled { opacity: .5; }
.pref-row.is-hit { background: color-mix(in srgb, var(--terc) 60%, transparent); border-radius: var(--shape-sm);
                   padding-inline: calc(6px * var(--den)); }
.pref-label { font-size: var(--type-body-sm); color: var(--onsfc); }
.pref-hint { font-size: var(--type-label-sm); color: var(--onsv); line-height: 1.45; margin: 0; max-width: 74ch; }
.pref-hint.is-restart { color: var(--onterc); background: var(--terc); border-radius: var(--shape-xs); padding: 4px 7px; display: inline-block; }
/* An option that persists but changes nothing yet says so on its own row. */
.pref-hint.is-pending { color: var(--onterc); background: var(--terc); border-radius: var(--shape-xs); padding: 4px 7px; display: inline-block; }
.pref-hint.is-invalid { color: var(--onerrc); background: var(--errc); border-radius: var(--shape-xs); padding: 4px 7px; display: inline-block; }
.pref-hint.is-danger { color: var(--onerrc); background: var(--errc); border-radius: var(--shape-xs); padding: 4px 7px; display: inline-block; }
.pref-hint.is-unsupported { color: var(--onterc); background: var(--terc); border-radius: var(--shape-xs); padding: 6px 8px; }
.pref-inline { display: inline-flex; align-items: center; gap: calc(8px * var(--den)); flex-wrap: wrap; min-width: 0; }
.pref-unit { font-size: var(--type-label-md); color: var(--onsv); }
.pref-unit.is-bad { color: var(--onerrc); background: var(--errc); border-radius: var(--shape-xs); padding: 2px 6px; }
.pref-number { width: calc(10ch + 2em); }
.pref-text { width: min(100%, 52ch); }
.pref-select { width: min(100%, 40ch); }
.pref-browse { flex: 0 0 auto; }

.pref-check { display: inline-flex; align-items: flex-start; gap: calc(10px * var(--den));
              min-height: calc(30px * var(--den)); cursor: pointer; }
.pref-check-input { position: absolute; opacity: 0; width: 1px; height: 1px; }
.pref-check-box { flex: 0 0 auto; width: calc(18px * var(--den)); height: calc(18px * var(--den));
                  margin-top: calc(2px * var(--den)); border: 2px solid var(--onsv);
                  border-radius: var(--shape-xs); position: relative; transition: background var(--motion-short) var(--ease-standard); }
.pref-check-input:checked + .pref-check-box { background: var(--p); border-color: var(--p); }
.pref-check-input:checked + .pref-check-box::after {
  content: ''; position: absolute; inset: 0; margin: auto;
  width: calc(5px * var(--den)); height: calc(9px * var(--den));
  border: solid var(--onp); border-width: 0 2px 2px 0; transform: translateY(-1px) rotate(45deg); }
.pref-check-input:focus-visible + .pref-check-box { outline: 2px solid var(--p); outline-offset: 2px; }
.pref-check-input:disabled + .pref-check-box { opacity: .4; }
.pref-check-label { font-size: var(--type-body-sm); line-height: 1.4; }

.pref-fieldset { display: flex; flex-direction: column; gap: 4px; }
.pref-radios { display: flex; flex-direction: column; gap: 2px; }
.pref-radio { display: inline-flex; align-items: flex-start; gap: calc(10px * var(--den));
              min-height: calc(30px * var(--den)); cursor: pointer; }
.pref-radio.is-disabled { cursor: default; opacity: .55; }
.pref-radio-input { position: absolute; opacity: 0; width: 1px; height: 1px; }
.pref-radio-dot { flex: 0 0 auto; width: calc(18px * var(--den)); height: calc(18px * var(--den));
                  margin-top: calc(2px * var(--den)); border: 2px solid var(--onsv); border-radius: var(--shape-full);
                  position: relative; }
.pref-radio-input:checked + .pref-radio-dot { border-color: var(--p); }
.pref-radio-input:checked + .pref-radio-dot::after {
  content: ''; position: absolute; inset: 0; margin: auto;
  width: calc(9px * var(--den)); height: calc(9px * var(--den)); border-radius: var(--shape-full); background: var(--p); }
.pref-radio-input:focus-visible + .pref-radio-dot { outline: 2px solid var(--p); outline-offset: 2px; }
.pref-radio-label { font-size: var(--type-body-sm); line-height: 1.4; }

.prefs-results { display: flex; flex-direction: column; gap: calc(4px * var(--den)); }
.prefs-result { display: flex; align-items: flex-start; gap: calc(10px * var(--den)); width: 100%;
                text-align: start; border: 1px solid var(--outline-var); border-radius: var(--shape-md);
                background: var(--c-lowest); color: var(--onsfc); padding: calc(9px * var(--den)) calc(12px * var(--den)); cursor: pointer; }
.prefs-result:hover { background: color-mix(in srgb, var(--onsfc) 7%, var(--c-lowest)); }
.prefs-result-main { flex: 1 1 auto; min-width: 0; }
.prefs-result-label { font-size: var(--type-body-sm); }
.prefs-result-where { font-size: var(--type-label-sm); color: var(--onsv); }
.prefs-result-value { flex: 0 0 auto; font-size: var(--type-label-md); font-family: var(--mono); color: var(--onsv); max-width: 24ch;
                      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.prefs-empty { font-size: var(--type-body-sm); color: var(--onsv); line-height: 1.55; padding: calc(12px * var(--den)) 0; }
.prefs-elsewhere { display: flex; flex-wrap: wrap; gap: 6px; margin-top: calc(8px * var(--den)); }
.prefs-elsewhere-chip { display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--outline);
                        border-radius: var(--shape-full); padding: calc(4px * var(--den)) calc(11px * var(--den));
                        background: none; color: var(--onsfc); font-size: var(--type-label-md); cursor: pointer; }
.prefs-elsewhere-chip:hover { background: var(--secc); color: var(--onsecc); }

.pref-list { display: flex; flex-direction: column; gap: 2px; }
.pref-list-rows { border: 1px solid var(--outline-var); border-radius: var(--shape-sm);
                  max-height: calc(280px * var(--uiscale)); overflow-y: auto; }
.pref-list-row { display: flex; align-items: center; gap: calc(10px * var(--den)); width: 100%;
                 min-height: calc(36px * var(--den)); padding: 0 calc(10px * var(--den));
                 background: none; border: none; color: var(--onsfc); text-align: start; cursor: pointer;
                 font-size: var(--type-body-sm); }
.pref-list-row:hover { background: color-mix(in srgb, var(--onsfc) 7%, transparent); }
.pref-list-row.is-selected { background: var(--secc); color: var(--onsecc); }
.pref-list-main { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pref-list-meta { flex: 0 0 auto; font-size: var(--type-label-sm); color: var(--onsv); font-family: var(--mono);
                  max-width: 30ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pref-list-row.is-selected .pref-list-meta { color: inherit; }
.pref-list-empty { padding: calc(14px * var(--den)); font-size: var(--type-label-md); color: var(--onsv); text-align: center; }
.pref-list-tools { display: flex; gap: 6px; flex-wrap: wrap; margin-top: calc(8px * var(--den)); }
.pref-swatch-dot { width: calc(16px * var(--den)); height: calc(16px * var(--den)); border-radius: var(--shape-xs);
                   border: 1px solid var(--outline); flex: 0 0 auto; }

.pref-font { display: inline-flex; align-items: center; gap: 8px; }
.pref-font-btn { min-height: calc(36px * var(--den)); padding: 0 calc(14px * var(--den)); border-radius: var(--shape-sm);
                 border: 1px solid var(--outline); background: var(--c-lowest); color: var(--onsfc); cursor: pointer;
                 max-width: 32ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pref-fontpop { width: min(360px, calc(100vw - 24px)); max-height: min(460px, calc(100vh - 80px)); display: flex; flex-direction: column; }
.pref-fontpop-search { padding: calc(10px * var(--den)) calc(12px * var(--den)); }
.pref-fontpop-list { flex: 1 1 auto; overflow-y: auto; padding: 0 calc(8px * var(--den)) calc(10px * var(--den)); }
.pref-fontpop-item { display: block; width: 100%; text-align: start; border: none; background: none; color: var(--onsfc);
                     min-height: calc(38px * var(--den)); padding: calc(4px * var(--den)) calc(10px * var(--den));
                     border-radius: var(--shape-sm); cursor: pointer; font-size: var(--type-body-md); }
.pref-fontpop-item:hover, .pref-fontpop-item.is-active { background: var(--secc); color: var(--onsecc); }

.cp-frame { display: flex; flex-direction: column; gap: calc(10px * var(--den)); }
.cp-frame-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(280px, 100%), 1fr));
                 gap: calc(10px * var(--den)); align-items: start; }
.cp-frame-group { border: 1px solid var(--outline-var); border-radius: var(--shape-md);
                  padding: calc(10px * var(--den)) calc(12px * var(--den)); background: var(--c-low); }
.cp-frame-group-title { font-size: var(--type-label-sm); text-transform: uppercase; letter-spacing: .05em;
                        font-weight: 700; color: var(--onsv); margin-bottom: calc(6px * var(--den)); }
.cp-summary { font-size: var(--type-label-md); color: var(--onsv); line-height: 1.5; }

.cc-patterns { display: grid; grid-template-columns: max-content 1fr; gap: 4px calc(12px * var(--den));
               font-size: var(--type-label-md); max-height: calc(220px * var(--uiscale)); overflow-y: auto;
               border: 1px solid var(--outline-var); border-radius: var(--shape-sm); padding: calc(10px * var(--den)); }
.cc-pattern-key { font-family: var(--mono); color: var(--p); font-weight: 700; }
.cc-pattern-desc { color: var(--onsv); line-height: 1.45; }
.cc-preview { font-family: var(--mono); font-size: var(--type-label-md); background: var(--c-lowest);
              border: 1px solid var(--outline-var); border-radius: var(--shape-sm);
              padding: calc(8px * var(--den)); word-break: break-all; line-height: 1.5; }
.cc-preview.is-error { border-color: var(--err); color: var(--onerrc); background: var(--errc); }

@media (max-width: 760px) {
  .prefs { grid-template-columns: 1fr; height: auto; max-height: 70vh; overflow-y: auto; }
  .prefs-nav { border-right: none; border-bottom: 1px solid var(--outline-var); max-height: 40vh; }
  .cp-frame-grid { grid-template-columns: 1fr; }
}
`);
}

/* ================================================================== */
/* custom control renderers                                            */
/* ================================================================== */

/** Bundled families are listed first so the picker is useful with no host fonts. */
const BUNDLED_FAMILIES = [
  'system-ui', 'Roboto', 'Segoe UI', 'Inter', 'Arial', 'Helvetica', 'Georgia',
  'Times New Roman', 'Verdana', 'Tahoma', 'Noto Sans', 'Noto Sans HK',
  'Microsoft JhengHei', 'PingFang HK', 'Consolas', 'Cascadia Code', 'Cascadia Mono',
  'Courier New', 'Menlo', 'Monaco', 'DejaVu Sans Mono', 'Fira Code', 'JetBrains Mono',
];
const MONO_HINTS = /mono|consol|courier|code|menlo|monaco|typewriter|terminal/i;

let hostFonts = null;
async function fontFamilies() {
  if (hostFonts) return hostFonts;
  let listed = [];
  try { listed = await api.listFonts(); } catch { listed = []; }
  hostFonts = Array.from(new Set([...BUNDLED_FAMILIES, ...listed])).sort((a, b) => a.localeCompare(b));
  return hostFonts;
}

/**
 * A searchable font list with a live preview of every family in its own face.
 * Anchored to the button that opened it, keyboard operable, and it returns
 * focus to that button on close.
 */
function openFontPicker({ anchor, value, monospace, onChange }) {
  const restore = focusMemory();
  const listEl = h('div', { class: 'pref-fontpop-list', role: 'listbox' });
  const bar = createSearchBar({
    id: `preferences-font-${monospace ? 'mono' : 'ui'}`,
    labelKey: 'apSearchPh', placeholderKey: 'apSearchPh',
    persist: false, compact: true,
    sampleProvider: () => (hostFonts || BUNDLED_FAMILIES).join('\n'),
    onChange: () => paint(),
  });
  const pop = h('div', {
    class: 'pref-fontpop surface-3 rb-popover', role: 'dialog', 'aria-modal': 'false',
    'aria-label': monospace ? 'Editor font' : 'UI font',
  },
  h('div', { class: 'pref-fontpop-search' }, bar.element), listEl);

  let families = hostFonts || BUNDLED_FAMILIES;
  function paint() {
    clear(listEl);
    const pred = bar.predicate;
    const shown = families
      .filter((f) => (!monospace || MONO_HINTS.test(f) || BUNDLED_FAMILIES.includes(f)))
      .filter((f) => (bar.isActive ? pred.ok && pred.test(f) : true));
    if (!shown.length) {
      listEl.appendChild(h('p', { class: 'pref-list-empty' }, noMatchMessage(pred, 'the installed fonts')));
      return;
    }
    for (const family of shown) {
      const btn = h('button', {
        type: 'button', class: `pref-fontpop-item${family === value ? ' is-active' : ''}`,
        role: 'option', 'aria-selected': String(family === value),
        style: { fontFamily: `"${family}", system-ui` },
        onclick: () => { onChange(family); close(); },
      }, family);
      listEl.appendChild(btn);
    }
  }

  fontFamilies().then((f) => { families = f; paint(); });
  paint();

  const host = layer('popover');
  host.appendChild(pop);
  const pos = anchorTo(pop, anchor, { placement: 'bottom-start', onDetach: () => close() });
  const roving = rovingFocus(listEl, '.pref-fontpop-item', { orientation: 'vertical' });

  function onDocDown(e) { if (!pop.contains(e.target) && e.target !== anchor) close(); }
  function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } }
  setTimeout(() => document.addEventListener('pointerdown', onDocDown, true), 0);
  pop.addEventListener('keydown', onKey);

  function close() {
    document.removeEventListener('pointerdown', onDocDown, true);
    roving.dispose();
    pos.dispose();
    bar.destroy();
    pop.remove();
    restore();
  }
  requestAnimationFrame(() => bar.focus());
  return { close };
}

/**
 * A file-mask field with live validation by design/main/masks.js — the same
 * parser the transfer engine uses, so "valid" here means the transfer will
 * accept it. Without the application shell there is no parser to ask, and the
 * field says exactly that rather than calling an unchecked mask valid.
 */
export function maskField(input) {
  const status = h('span', { class: 'pref-unit' });
  const validate = async () => {
    const value = input.value.trim();
    if (!value) { status.textContent = ''; status.classList.remove('is-bad'); return; }
    const validator = api.raw?.app?.maskValidate;
    if (typeof validator !== 'function') {
      status.textContent = tx('(not checked in this window)', '（呢個視窗檢查唔到遮罩）');
      status.classList.remove('is-bad');
      return;
    }
    try {
      const res = await validator(value);
      const detail = res && res.ok ? res.value : null;
      const message = res && res.ok === false
        ? (res.error?.message || 'Invalid mask')
        : (detail && detail.valid === false ? (detail.error || 'Invalid mask') : null);
      status.textContent = message || (tx('Valid mask', '遮罩正確'));
      status.classList.toggle('is-bad', !!message);
    } catch (err) {
      status.textContent = err?.message || (tx('Could not be checked', '檢查唔到'));
      status.classList.add('is-bad');
    }
  };
  input.addEventListener('change', validate);
  input.addEventListener('input', validate);
  validate();
  return h('span', { class: 'pref-inline' }, input, status);
}

/** Return the next visible page index for the Preferences tree keyboard model. */
export function preferenceTreeIndex(key, index, count) {
  if (!Number.isInteger(count) || count < 1) return -1;
  const current = Math.min(Math.max(Number.isInteger(index) ? index : 0, 0), count - 1);
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  if (key === 'ArrowDown') return (current + 1) % count;
  if (key === 'ArrowUp') return (current - 1 + count) % count;
  return current;
}

/** Keep matching child pages reachable in the tree by retaining their parents. */
export function preferenceNavigationPages(pages, matches = null) {
  const ordered = orderedPages(pages);
  if (!matches) return ordered;
  const included = new Set(matches.map((match) => match.pageId));
  const byId = new Map(pages.map((page) => [page.id, page]));
  for (const id of Array.from(included)) {
    let page = byId.get(id);
    while (page?.parent) {
      included.add(page.parent);
      page = byId.get(page.parent);
    }
  }
  return ordered.filter((page) => included.has(page.id));
}

/* ================================================================== */
/* the dialog                                                          */
/* ================================================================== */

let openHandle = null;

/**
 * Build the whole preferences surface. Returns { element, destroy, snapshot }.
 * The caller (a modal, or a future settings tab) decides where it lives.
 */
function cloneValue(v) { try { return structuredClone(v); } catch { return v === undefined ? v : JSON.parse(JSON.stringify(v)); } }

/**
 * Capture every persisted path represented by a control. Some controls expose
 * one UI value but write an `alsoKeys` companion as well; omitting that
 * companion makes Revert changes restore the screen while leaving the stored
 * configuration split-brained.
 */
export function snapshotPreferenceValues(entries, read = (key) => prefs.get(key)) {
  const snap = {};
  for (const entry of entries) {
    const control = entry.control || entry;
    if (control.virtual && control.type === 'custom') continue;
    for (const key of [control.key, ...(control.alsoKeys || [])]) {
      if (!key || MASTER_PASSWORD_KEYS.has(key) || Object.hasOwn(snap, key)) continue;
      snap[key] = cloneValue(read(key));
    }
  }
  return snap;
}

/** Focus the concrete editor after a command-palette jump, not only its row. */
export function focusPreferenceControl(row) {
  if (!row) return null;
  const control = row.querySelector?.('input,select,textarea,button,[tabindex]:not([tabindex="-1"])') || row;
  control.focus?.({ preventScroll: true });
  return control;
}

export function createPreferences(opts = {}) {
  ensurePreferenceStyles();

  const entries = flattenControls(PAGES);
  const pages = orderedPages(PAGES);
  let currentPageId = opts.pageId && pageById(opts.pageId) ? opts.pageId : pages[0].id;
  let pageBar = null;
  let hitKey = opts.controlKey && entries.some((e) => e.pageId === currentPageId && e.control.key === opts.controlKey)
    ? opts.controlKey : null;         // the row to flash after navigating from a result

  const navList = h('div', { class: 'prefs-tree', role: 'tree', 'aria-label': localized(tx('Preference pages', '偏好設定頁')) });
  const mainEl = h('main', { class: 'prefs-main', tabindex: '-1' });

  navList.addEventListener('keydown', (event) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = Array.from(navList.querySelectorAll('[role="treeitem"]'));
    if (!items.length) return;
    const index = Math.max(0, items.indexOf(document.activeElement));
    const next = preferenceTreeIndex(event.key, index, items.length);
    if (next < 0) return;
    event.preventDefault();
    items[next].focus();
    items[next].click();
  });

  const allBar = createSearchBar({
    id: 'preferences-all',
    labelKey: 'prefsSearchPh', placeholderKey: 'prefsSearchPh',
    appearanceKey: 'preferences-search-all', appearanceLabel: 'Preferences search',
    sampleProvider: () => entries.flatMap((e) => searchFieldsFor(e, prefs.get(e.control.key))).join('\n'),
    onChange: () => { renderNav(); renderMain(); },
  });

  const nav = h('nav', { class: 'prefs-nav', 'aria-label': localized(tx('Preferences navigation', '偏好設定導覽')) },
    h('div', { class: 'prefs-nav-search' }, allBar.element),
    navList);
  appearanceTarget(nav, 'preferences-nav', 'Preferences navigation');

  const root = h('div', { class: 'prefs' }, nav, mainEl);
  appearanceTarget(root, 'preferences', 'Preferences dialog');

  /* ---------------- search ---------------- */

  function globalMatches() {
    if (!allBar.isActive) return null;
    return matchPreferences(entries, allBar.predicate, (k) => prefs.get(k));
  }

  /* ---------------- navigation ---------------- */

  function renderNav() {
    clear(navList);
    const matches = globalMatches();
    const counts = new Map();
    if (matches) for (const m of matches) counts.set(m.pageId, (counts.get(m.pageId) || 0) + 1);
    const visiblePages = preferenceNavigationPages(pages, matches);
    const focusPageId = visiblePages.some((page) => page.id === currentPageId)
      ? currentPageId : visiblePages[0]?.id;
    nav.setAttribute('aria-label', localized(tx('Preferences navigation', '偏好設定導覽')));
    navList.setAttribute('aria-label', localized(tx('Preference pages', '偏好設定頁')));

    for (const page of visiblePages) {
      const hasChildren = pages.some((candidate) => candidate.parent === page.id);
      const btn = h('button', {
        type: 'button', role: 'treeitem',
        class: `prefs-nav-item${page.id === currentPageId ? ' is-active' : ''}`,
        'aria-selected': String(page.id === currentPageId),
        'aria-current': page.id === currentPageId ? 'page' : null,
        'aria-expanded': hasChildren ? 'true' : null,
        'aria-level': String(page.depth + 1),
        tabindex: page.id === focusPageId ? '0' : '-1',
        dataset: { depth: String(page.depth), pageId: page.id },
        onclick: () => { if (allBar.isActive) allBar.clear(); goTo(page.id); },
      },
      icon(page.icon || 'tune', 16),
      h('span', { class: 'prefs-nav-label' }, pageTitle(page)),
      counts.has(page.id) ? h('span', { class: 'prefs-nav-count' }, String(counts.get(page.id))) : null);
      btn.title = pageTitle(page);
      appearanceTarget(btn, `preferences-nav-${page.id}`, `Preferences page: ${page.title.en}`);
      navList.appendChild(btn);
    }
    if (matches && !navList.childElementCount) {
      navList.appendChild(h('p', { class: 'prefs-empty' }, noMatchMessage(allBar.predicate, 'any preferences page')));
    }
  }

  function pageTitle(page) {
    return localized(page.title);
  }

  function goTo(pageId, key) {
    currentPageId = pageId;
    hitKey = key || null;
    renderNav();
    renderMain();
    mainEl.focus();
    const page = pageById(pageId);
    announce(`${localized(page.title)} — ${t('preferences')}`);
  }

  /* ---------------- the content pane ---------------- */

  function renderMain() {
    clear(mainEl);
    if (pageBar) { pageBar.destroy(); pageBar = null; }

    const matches = globalMatches();
    if (matches) { renderResults(matches); return; }
    renderPage(pageById(currentPageId));
  }

  function renderResults(matches) {
    const byPage = matchesByPage(matches);
    mainEl.appendChild(h('div', { class: 'prefs-page-head' },
      h('h3', { class: 'prefs-page-title' },
        tx(`Search results — ${matches.length} ${matches.length === 1 ? 'option' : 'options'}`, `搜尋結果：${matches.length} 項`))));

    if (!matches.length) {
      mainEl.appendChild(h('p', { class: 'prefs-empty' }, noMatchMessage(allBar.predicate, 'the preferences')));
      return;
    }

    mainEl.appendChild(h('p', { class: 'prefs-page-desc' },
      tx(`Found across ${byPage.length} ${byPage.length === 1 ? 'page' : 'pages'}. Selecting a result opens that page and highlights the option.`, `喺 ${byPage.length} 版搵到。撳一下就會跳去嗰版，同埋標示出嚟。`)));

    const list = h('div', { class: 'prefs-results' });
    for (const m of matches) {
      const value = prefs.get(m.control.key);
      const where = t('prefFoundOn', localized(m.pageTitle));
      const btn = h('button', {
        type: 'button', class: 'prefs-result',
        onclick: () => { allBar.clear(); goTo(m.pageId, m.control.key); },
      },
      icon(pageById(m.pageId)?.icon || 'tune', 16),
      h('span', { class: 'prefs-result-main' },
        h('span', { class: 'prefs-result-label' }, localized(m.control.label)),
        h('br'),
        h('span', { class: 'prefs-result-where' }, `${where} › ${localized(m.sectionTitle)}`)),
      h('span', { class: 'prefs-result-value', title: describeValue(m.control, value) },
        describeValue(m.control, value)));
      list.appendChild(btn);
    }
    mainEl.appendChild(list);
  }

  function renderPage(page) {
    if (!page) return;
    const parent = page.parent ? pageById(page.parent) : null;
    const head = h('div', { class: 'prefs-page-head' },
      h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
        parent ? h('div', { class: 'prefs-crumb' }, `${localized(parent.title)} ›`) : null,
        h('h3', { class: 'prefs-page-title' }, localized(page.title))),
      h('button', {
        type: 'button', class: 'btn-text',
        onclick: () => resetPage(page),
      }, tx('Reset this page', '重設呢頁')));
    mainEl.appendChild(head);

    if (page.description) {
      mainEl.appendChild(h('p', { class: 'prefs-page-desc' }, localized(page.description)));
    }

    // Every settings surface carries its own search bar — this one filters the
    // page in front of the user and says plainly when the match is elsewhere.
    pageBar = createSearchBar({
      id: `preferences-page-${page.id}`,
      labelKey: 'prefsSearchPh',
      placeholder: tx(`Search ${localized(page.title)}`, `搵「${localized(page.title)}」入面嘅設定`),
      appearanceKey: `preferences-search-${page.id}`, appearanceLabel: `Search: ${page.title.en}`,
      persist: false,
      sampleProvider: () => entries.filter((e) => e.pageId === page.id)
        .flatMap((e) => searchFieldsFor(e, prefs.get(e.control.key))).join('\n'),
      onChange: () => paintPage(page),
    });
    mainEl.appendChild(h('div', { class: 'prefs-page-search' }, pageBar.element));

    const body = h('div', { class: 'prefs-page-body' });
    mainEl.appendChild(body);
    paintPage(page, body);
  }

  function paintPage(page, bodyEl) {
    const body = bodyEl || mainEl.querySelector('.prefs-page-body');
    if (!body) return;
    clear(body);

    const pageEntries = entries.filter((e) => e.pageId === page.id);
    const active = pageBar && pageBar.isActive;
    const pred = pageBar ? pageBar.predicate : null;
    const matched = active
      ? new Set(matchPreferences(pageEntries, pred, (k) => prefs.get(k)).map((e) => e.control))
      : null;

    let shown = 0;
    for (const section of page.sections || []) {
      const controls = (section.controls || []).filter((c) => !c.virtual || section.custom);
      const visible = matched ? controls.filter((c) => matched.has(c)) : controls;
      const sectionMatches = matched ? visible.length > 0 : true;
      if (matched && !sectionMatches && !(section.custom && visible.length)) continue;

      const card = h('section', { class: 'prefs-section' },
        h('h4', { class: 'prefs-section-title' }, localized(section.title)));
      appearanceTarget(card, `preferences-section-${page.id}-${section.id}`, `Preferences section: ${section.title.en}`);
      if (section.description && !matched) {
        card.appendChild(h('p', { class: 'prefs-section-desc' }, localized(section.description)));
      }

      if (section.custom) {
        card.appendChild(renderCustomSection(section, page));
        shown += visible.length;
      } else {
        for (const control of visible) {
          card.appendChild(buildRow(control, page));
          shown += 1;
        }
      }

      if (section.actions && !matched) {
        const tools = h('div', { class: 'prefs-section-actions' });
        for (const a of section.actions) {
          const btn = h('button', {
            type: 'button', class: a.danger ? 'btn-text' : 'btn-tonal',
            onclick: () => runSectionAction(a, page),
          }, localized(a.label));
          if (a.hint) btn.title = localized(a.hint);
          tools.appendChild(btn);
        }
        card.appendChild(tools);
      }
      body.appendChild(card);
    }

    if (matched && shown === 0) {
      body.appendChild(h('p', { class: 'prefs-empty' }, noMatchMessage(pred, localized(page.title))));
      const elsewhere = matchesByPage(matchPreferences(entries, pred, (k) => prefs.get(k)))
        .filter((p) => p.pageId !== page.id);
      if (elsewhere.length) {
        body.appendChild(h('p', { class: 'prefs-empty' },
          tx(`${elsewhere.reduce((n, p) => n + p.count, 0)} matching options are on other pages:`, `不過喺第啲頁搵到 ${elsewhere.reduce((n, p) => n + p.count, 0)} 項：`)));
        const chips = h('div', { class: 'prefs-elsewhere' });
        for (const p of elsewhere) {
          chips.appendChild(h('button', {
            type: 'button', class: 'prefs-elsewhere-chip',
            onclick: () => { const q = pageBar.state; goTo(p.pageId); if (pageBar) pageBar.setQuery(q.query); },
          }, icon(pageById(p.pageId)?.icon || 'tune', 14), `${localized(p.title)} · ${p.count}`));
        }
        body.appendChild(chips);
      }
    }

    if (hitKey) {
      const row = body.querySelector(`[data-pref-key="${cssEscape(hitKey)}"]`);
      if (row) {
        row.classList.add('is-hit');
        row.scrollIntoView({ block: 'center', behavior: isReducedMotion() ? 'auto' : 'smooth' });
        requestAnimationFrame(() => focusPreferenceControl(row));
        setTimeout(() => row.classList.remove('is-hit'), 2600);
      }
      hitKey = null;
    }
  }

  function cssEscape(s) {
    return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&');
  }

  /* ---------------- rows ---------------- */

  function buildRow(control, page) {
    const row = renderControl(control, controlCtx(page));
    registerContextMenu(row, () => [
      {
        label: tx('Reset to default', '重設做預設值'),
        icon: 'restart_alt',
        disabled: JSON.stringify(prefs.get(control.key)) === JSON.stringify(control.def),
        onSelect: () => commit(control, control.def, page, true),
      },
      {
        label: tx('Copy the setting key', '複製設定鍵名'),
        icon: 'content_copy',
        onSelect: async () => {
          const ok = await copyText(control.key);
          if (ok) notify.success(t('copiedClip'), control.key);
          else notify.error(t('copiedClip'), `The clipboard refused "${control.key}".`);
        },
      },
      SEPARATOR,
      {
        label: tx('Find this option in the search', '喺搜尋度睇呢個設定'),
        icon: 'search',
        onSelect: () => { allBar.setQuery(control.label.en); allBar.focus(); },
      },
    ]);
    return row;
  }

  function controlCtx(page) {
    return {
      language: getLanguage(),
      read: (key) => prefs.get(key),
      write: (control, value) => commit(control, value, page),
      pickPath: (control, current) => pickPathFor(control, current),
      runAction: (control) => runControlAction(control, page),
      custom: {
        color: (control, value, done) => {
          const readout = h('span', { class: 'ap-colorval mono' }, String(value || control.def));
          const swatch = colorSwatchButton({
            value: value || control.def,
            label: localized(control.label),
            alpha: false,
            onChange: (hex) => { readout.textContent = hex; done(hex); },
          });
          return h('span', { class: 'ap-colorwrap' }, swatch.element, readout);
        },
        font: (control, value, done) => {
          const btn = h('button', {
            type: 'button', class: 'pref-font-btn',
            style: { fontFamily: `"${value}", system-ui` },
            onclick: () => openFontPicker({
              anchor: btn, value, monospace: !!control.monospace,
              onChange: (family) => { done(family); },
            }),
          }, value || control.def);
          btn.setAttribute('aria-label', `${localized(control.label)}: ${value || control.def}`);
          return h('span', { class: 'pref-font' }, btn);
        },
        mask: (control, input) => maskField(input),
        copyParams: () => null,          // handled by renderCustomSection
        editors: (control, value, done) => createEditorList({ value: value || [], onChange: done }).element,
        commands: (control, value, done) => createCommandList({ value: value || [], onChange: done }).element,
        presets: (control, value, done) => createPresetList({ value: value || [], onChange: done }).element,
        fileColors: (control, value, done) => createFileColorList({ value: value || [], onChange: done }).element,
      },
    };
  }

  function renderCustomSection(section, page) {
    if (section.custom === 'copyParams') {
      const frame = createCopyParamsFrame({
        value: prefs.get('copyParam') || {},
        onChange: (key, value) => {
          const control = section.controls.find((c) => c.key === key);
          commit(control || { key, def: value, label: { en: key, yue: key } }, value, page);
        },
        read: (key) => prefs.get(key),
      });
      return frame.element;
    }
    const control = (section.controls || [])[0];
    if (!control) return h('div');
    return renderControl(control, controlCtx(page));
  }

  /* ---------------- writing ---------------- */

  /**
   * Commit one control. The master-password checkbox is not a plain write —
   * turning it on has to collect a password and re-encrypt the stored ones —
   * so it is intercepted here rather than writing a boolean that changes
   * nothing.
   */
  async function commit(control, value, page, repaint) {
    // The DOM disables pending controls too, but keep the write seam honest if
    // a synthetic event or a future custom renderer reaches this function.
    // A pending control itself is read-only. Revert/reset is still allowed to
    // remove an imported value, because that is a configuration operation and
    // does not pretend to enable the unavailable capability.
    if (isPending(control.key) && !repaint) return false;
    if (control.actionId === 'masterPassword') { masterPasswordToggle(control, page, !!value); return; }
    return writeControl(control, value, page, repaint);
  }

  async function writeControl(control, value, page, repaint) {
    // Number inputs normalize themselves on change, but range sliders commit
    // on every input event. Keep this seam authoritative so every numeric
    // control, including a synthetic/programmatic slider event, persists only
    // a finite value inside the schema's UI range.
    if (control.type === 'number' || control.type === 'slider') {
      value = normalizeNumberInput(control, value).stored;
    }
    const label = revisionLabel(control, value);
    try {
      await prefs.set(control.key, value, label);
      for (const also of control.alsoKeys || []) await prefs.set(also, value, label);
    } catch (err) {
      // NOT t('settingsSaved') — that string reads "Preferences applied." and
      // titling a failure with it tells the user the opposite of what happened.
      notify.error(tx('The setting could not be saved', '呢個設定儲存唔到'),
        `${localized(control.label)}: ${err.message}`);
      paintPage(page);
      return;
    }
    // Dependencies (a checkbox that enables a field) must repaint; a plain
    // write must not steal focus from the control the user is still using.
    const affectsOthers = entries.some((e) => dependsOnKey(e.control, control.key));
    if (repaint || affectsOthers) paintPage(page);
    if (repaint) announce(`${localized(control.label)}: ${describeValue(control, value)}`);
  }

  function dependsOnKey(control, key) {
    const dep = control.dependsOn;
    if (!dep) return false;
    if (typeof dep === 'string') return dep === key;
    if (typeof dep === 'object') return dep.key === key;
    return false;
  }

  /** A revision label naming the option and its new value, never a secret. */
  function revisionLabel(control, value) {
    if (control.secret) return `Changed ${control.label.en}`;
    return `Changed ${control.label.en} to ${describeValue(control, value, 'en')}`;
  }

  /* ---------------- actions ---------------- */

  async function pickPathFor(control, current) {
    const a = api.raw;
    if (!a?.app?.pickPath) {
      notify.warning(localized(control.label),
        tx('A file picker needs the application shell; type the path instead.',
          '要有應用程式外殼先開到檔案揀選器，請直接打路徑。'));
      return null;
    }
    const wantsDirectory = /directory|folder|seed|temporary/i.test(control.key)
      && !/File(Name)?$/i.test(control.key);
    const res = await a.app.pickPath({
      title: localized(control.label),
      defaultPath: current || undefined,
      properties: wantsDirectory ? ['openDirectory'] : ['openFile'],
    });
    if (res && res.ok === false) { notify.error(localized(control.label), res.error?.message || tx('The picker was refused.', '揀選器俾人拒絕咗。')); return null; }
    const value = res && res.ok ? res.value : res;
    if (!value) return null;
    return Array.isArray(value) ? value[0] : (value.path || value.filePath || value);
  }

  function runControlAction(control, page) {
    switch (control.actionId) {
      case 'showDisclosure': return showDisclosure(page);
      case 'changeMasterPassword': return changeMasterPassword(page);
      case 'checkUpdates': return checkUpdatesNow();
      default:
        notify.warning(localized(control.label), `No action is wired to "${control.actionId}".`);
        return null;
    }
  }

  function runSectionAction(a, page) {
    switch (a.id) {
      case 'exportConfig': return exportConfiguration();
      case 'importConfig': return importConfiguration();
      case 'resetPage': return resetPage(page);
      default: return null;
    }
  }

  function showDisclosure() {
    openModal({
      title: t('funnyDisclose'),
      width: 560,
      content: h('div', { class: 'stack' },
        ...disclosureText().split('\n\n').map((p) => h('p', { class: 'prose' }, p)),
        h('div', { class: 'row' },
          h('label', { class: 'field inline' }, h('span', { class: 'field-label' }, t('funnyEn')), funnySlider('en')),
          h('label', { class: 'field inline' }, h('span', { class: 'field-label' }, t('funnyYue')), funnySlider('yue')))),
      actions: [{
        label: t('ok'), kind: 'filled', autofocus: true,
        onSelect: () => { store.set('disclosureAccepted', true); persistCurrent('disclosureAccepted'); },
      }],
    });
  }

  /**
   * The master password flow. Secrets are typed into password fields, handed
   * straight to main and never stored, logged or echoed anywhere.
   */
  function masterPasswordToggle(control, page, wantOn) {
    const a = api.raw;
    if (!a?.config?.enableMasterPassword) {
      notify.error(t('masterPassword'), tx('The configuration bridge is not available in this window.', '呢個視窗接唔到設定橋接。'));
      paintPage(page);
      return;
    }
    if (wantOn) {
      passwordPrompt({
        title: t('masterPassword'),
        body: t('masterPasswordOn'),
        fields: ['new', 'confirm'],
        onSubmit: async ({ next }) => {
          const res = await a.config.enableMasterPassword(next);
          if (res && res.ok === false) throw new Error(res.error?.message || tx('The master password could not be set.', '設唔到主密碼。'));
          await prefs.load(true);
          notify.success(t('masterPassword'), t('settingsSaved'));
          paintPage(page);
        },
        onCancel: () => paintPage(page),
      });
    } else {
      passwordPrompt({
        title: t('masterPassword'),
        body: tx('Enter the current master password to turn it off. Stored passwords are re-protected with this computer’s own key.', '要輸入而家嘅主密碼先可以停用。停用之後，存低嘅密碼會改返用呢部電腦嘅保護。'),
        fields: ['current'],
        onSubmit: async ({ current }) => {
          const res = await a.config.disableMasterPassword(current);
          if (res && res.ok === false) throw new Error(res.error?.message || t('wrongPassword'));
          if (res && res.ok && res.value === false) throw new Error(t('wrongPassword'));
          await prefs.load(true);
          notify.success(t('masterPassword'), t('settingsSaved'));
          paintPage(page);
        },
        onCancel: () => paintPage(page),
      });
    }
  }

  function changeMasterPassword(page) {
    const a = api.raw;
    if (!a?.config?.changeMasterPassword) {
      notify.error(t('masterPassword'), tx('The configuration bridge is not available in this window.', '呢個視窗接唔到設定橋接。'));
      return;
    }
    passwordPrompt({
      title: t('changePwTitle'),
      fields: ['current', 'new', 'confirm'],
      onSubmit: async ({ current, next }) => {
        const res = await a.config.changeMasterPassword(current, next);
        if (res && res.ok === false) throw new Error(res.error?.message || t('wrongPassword'));
        if (res && res.ok && res.value === false) throw new Error(t('wrongPassword'));
        notify.success(t('masterPassword'), t('settingsSaved'));
        paintPage(page);
      },
    });
  }

  async function checkUpdatesNow() {
    const a = api.raw;
    if (!a?.app?.checkUpdates) { notify.warning(t('checkUpdates'), tx('Update checks need the application shell.', '要有應用程式外殼先檢查到更新。')); return; }
    const res = await a.app.checkUpdates({ force: true });
    if (res && res.ok === false) { notify.error(t('checkUpdates'), res.error?.message || tx('The check failed.', '檢查失敗。')); return; }
    const value = res && res.ok ? res.value : res;
    await prefs.load(true);
    if (value && value.newer && value.version) {
      notify.info(t('checkUpdates'), `${value.version} is available.`, {
        actions: value.url ? [{ label: t('docs'), onSelect: () => api.openExternal(value.url) }] : [],
      });
    } else {
      notify.success(t('checkUpdates'), t('updatesLatest', (value && value.current) || ''));
    }
    paintPage(pageById(currentPageId));
  }

  async function exportConfiguration() {
    const a = api.raw;
    if (!a?.config?.export || !a?.app?.pickPath) { notify.warning(t('exportCfg'), tx('Exporting needs the application shell.', '要有應用程式外殼先匯出到。')); return; }
    const picked = await a.app.pickPath({ title: t('exportCfg'), properties: ['save'], defaultPath: 'winscp-material-config.json' });
    const file = picked && picked.ok ? picked.value : picked;
    const target = Array.isArray(file) ? file[0] : (file && (file.path || file.filePath)) || file;
    if (!target) return;
    const res = await a.config.export(target);
    if (res && res.ok === false) { notify.error(t('exportCfg'), res.error?.message || tx('The export failed.', '匯出失敗。')); return; }
    notify.success(t('cfgExported'), String(target));
  }

  async function importConfiguration() {
    const a = api.raw;
    if (!a?.config?.import || !a?.app?.pickPath) { notify.warning(t('importCfg'), tx('Importing needs the application shell.', '要有應用程式外殼先匯入到。')); return; }
    const picked = await a.app.pickPath({ title: t('importCfg'), properties: ['openFile'] });
    const file = picked && picked.ok ? picked.value : picked;
    const target = Array.isArray(file) ? file[0] : (file && (file.path || file.filePath)) || file;
    if (!target) return;
    openModal({
      title: t('importCfg'),
      width: 520,
      content: h('p', { class: 'prose' },
        tx(`The settings in "${target}" will be merged into this configuration. The current state is recorded as a revision first, so this can be undone from the version history.`, `會合併「${target}」入面嘅設定。而家嘅設定會先記低做一個版本，所以之後可以喺版本紀錄度還原。`)),
      actions: [
        { label: t('cancel') || 'Cancel', kind: 'text' },
        {
          label: t('importCfg'), kind: 'filled', autofocus: true,
          onSelect: async () => {
            const res = await a.config.import(target, `Imported the configuration from ${target}`);
            if (res && res.ok === false) { notify.error(t('importCfg'), res.error?.message || tx('The import failed.', '匯入失敗。')); return; }
            await prefs.load(true);
            renderMain();
            notify.success(t('cfgImported'), String(target));
          },
        },
      ],
    });
  }

  function resetPage(page) {
    const pageEntries = entries.filter((e) => e.pageId === page.id
      && e.control.type !== 'action' && e.control.type !== 'custom'
      && !MASTER_PASSWORD_KEYS.has(e.control.key));
    const changed = pageEntries.filter((e) => JSON.stringify(prefs.get(e.control.key)) !== JSON.stringify(e.control.def));
    const masterHeld = page.sections?.some((s) => (s.controls || [])
      .some((c) => MASTER_PASSWORD_KEYS.has(c.key))) && prefs.get('security.useMasterPassword');
    if (!changed.length) {
      notify.info(localized(page.title), masterHeld
        ? tx('Every option on this page that a reset can touch is already at its default. The master password is turned off through its own checkbox, so that the stored passwords are re-encrypted rather than orphaned.',
          '呢頁凡係重設得嘅選項都已經係預設值。主密碼要用佢自己嗰個剔格熄，咁存低嘅密碼先會重新加密，唔會變成解唔開。')
        : tx('Every option on this page is already at its default.', '呢頁全部都係預設值。'));
      return;
    }
    openModal({
      title: `${t('reset') || 'Reset'} — ${localized(page.title)}`,
      width: 520,
      content: h('div', { class: 'stack' },
        h('p', { class: 'prose' },
          tx(`${changed.length} ${changed.length === 1 ? 'option' : 'options'} on this page will go back to their default. The change is recorded in the version history and can be undone.`, `會將呢 ${changed.length} 個選項改返做預設值。呢個改動會記入版本紀錄，可以還原。`)),
        h('ul', { class: 'prose' }, ...changed.slice(0, 12).map((e) => h('li', {},
          `${localized(e.control.label)} — ${describeValue(e.control, prefs.get(e.control.key))} → ${describeValue(e.control, e.control.def)}`))),
        changed.length > 12 ? h('p', { class: 'prefs-empty' }, `… and ${changed.length - 12} more.`) : null),
      actions: [
        { label: t('cancel') || 'Cancel', kind: 'text' },
        {
          label: t('reset') || 'Reset', kind: 'danger', autofocus: true,
          onSelect: async () => {
            for (const e of changed) {
              try { await prefs.set(e.control.key, e.control.def, `Reset ${e.control.label.en} to its default`); }
              catch (err) { notify.error(localized(e.control.label), err.message); }
            }
            paintPage(page);
            notify.success(localized(page.title), t('settingsSaved'));
          },
        },
      ],
    });
  }

  /* ---------------- snapshot / revert ---------------- */

  function snapshot() {
    return snapshotPreferenceValues(entries, (key) => prefs.get(key));
  }

  async function revert(snap) {
    let n = 0;
    for (const [key, value] of Object.entries(snap)) {
      if (MASTER_PASSWORD_KEYS.has(key)) continue;
      if (JSON.stringify(prefs.get(key)) === JSON.stringify(value)) continue;
      try { await prefs.set(key, value, 'Reverted the preferences changes made in this dialog'); n += 1; }
      catch (err) { console.warn('[preferences] revert failed for', key, err); }
    }
    renderMain();
    return n;
  }

/* ---------------- boot ---------------- */

  // bindRender paints once immediately and again on every language / funny-level
  // change, so the whole dialog follows the mode without being reopened.
  const offLang = bindRender(root, () => { renderNav(); renderMain(); });
  // A configuration document that arrives after the dialog opened — the first
  // read, an import, a history restore — must reach it rather than leaving it
  // showing what it guessed. A write made HERE repaints through commit()
  // instead, so typing into a field is never interrupted.
  const offPrefs = prefs.subscribe((_values, source) => {
    if (source === 'load' || source === 'external') renderMain();
    renderNav();
  });

  return {
    element: root,
    snapshot,
    revert,
    goTo,
    focusSearch: () => allBar.focus(),
    destroy() {
      offPrefs();
      offLang();
      allBar.destroy();
      pageBar?.destroy();
      closeAllMenus();
      root.remove();
    },
  };
}

/* ================================================================== */
/* file colours (small enough to live here)                            */
/* ================================================================== */

/**
 * WinSCP's FileColors list: a file mask plus the colour files matching it are
 * drawn in. The first matching rule wins, so order is editable.
 */
export function createFileColorList({ value = [], onChange }) {
  let rows = value.map((r) => ({ ...r }));
  let selected = rows.length ? 0 : -1;
  const listEl = h('div', { class: 'pref-list-rows', role: 'listbox', 'aria-label': localized(tx('File colour rules', '檔案顏色規則')) });
  const tools = h('div', { class: 'pref-list-tools' });
  const root = h('div', { class: 'pref-list' }, listEl, tools);

  const emit = () => onChange?.(rows.map((r) => ({ ...r })));

  function paint() {
    clear(listEl);
    if (!rows.length) {
      listEl.appendChild(h('p', { class: 'pref-list-empty' },
        tx('No rules yet. Add one to colour files by mask.', '未有規則。撳「新增」加一條。')));
    }
    rows.forEach((r, i) => {
      const btn = h('button', {
        type: 'button', role: 'option', 'aria-selected': String(i === selected),
        class: `pref-list-row${i === selected ? ' is-selected' : ''}`,
        onclick: () => { selected = i; paint(); },
        ondblclick: () => edit(i),
      },
      h('span', { class: 'pref-swatch-dot', style: { background: r.color || '#888' } }),
      h('span', { class: 'pref-list-main' }, r.mask || '*'),
      h('span', { class: 'pref-list-meta' }, `${r.color || ''}${r.dark ? ` / ${r.dark}` : ''}`));
      listEl.appendChild(btn);
    });
    clear(tools);
    tools.append(
      h('button', { type: 'button', class: 'btn-tonal', onclick: () => edit(-1) }, t('add') || 'Add…'),
      h('button', { type: 'button', class: 'btn-text', disabled: selected < 0, onclick: () => edit(selected) }, 'Edit…'),
      h('button', { type: 'button', class: 'btn-text', disabled: selected <= 0, onclick: () => move(-1) }, '↑'),
      h('button', { type: 'button', class: 'btn-text', disabled: selected < 0 || selected >= rows.length - 1, onclick: () => move(1) }, '↓'),
      h('button', { type: 'button', class: 'btn-text', disabled: selected < 0, onclick: () => remove() }, t('remove') || 'Remove'),
    );
  }

  function move(delta) {
    const to = selected + delta;
    if (to < 0 || to >= rows.length) return;
    const [row] = rows.splice(selected, 1);
    rows.splice(to, 0, row);
    selected = to;
    paint(); emit();
  }

  function remove() {
    if (selected < 0) return;
    rows.splice(selected, 1);
    selected = Math.min(selected, rows.length - 1);
    paint(); emit();
  }

  function edit(index) {
    const existing = index >= 0 ? rows[index] : { mask: '*.log', color: '#B3261E', dark: '' };
    let draft = { ...existing };
    const maskInput = h('input', { type: 'text', class: 'field-input pref-text', value: draft.mask, onchange: () => { draft.mask = maskInput.value; } });
    maskInput.value = draft.mask || '';
    const lightSwatch = colorSwatchButton({ value: draft.color || '#B3261E', label: `${t('colorMask')} — ${t('themeLight')}`, alpha: false, onChange: (hex) => { draft.color = hex; } });
    const darkSwatch = colorSwatchButton({ value: draft.dark || draft.color || '#F2B8B5', label: `${t('colorMask')} — ${t('themeDark')}`, alpha: false, onChange: (hex) => { draft.dark = hex; } });
    openModal({
      title: t('colorMask'),
      width: 480,
      content: h('div', { class: 'stack' },
        h('p', { class: 'prose' }, t('fileColorsHint')),
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, t('colorMask')), maskInput),
        h('div', { class: 'row' },
          h('label', { class: 'field inline' }, h('span', { class: 'field-label' }, t('themeLight')), lightSwatch.element),
          h('label', { class: 'field inline' }, h('span', { class: 'field-label' }, t('themeDark')), darkSwatch.element))),
      actions: [
        { label: t('cancel') || 'Cancel', kind: 'text' },
        {
          label: t('ok'), kind: 'filled', autofocus: true,
          onSelect: () => {
            draft.mask = maskInput.value.trim() || '*';
            if (index >= 0) rows[index] = draft; else { rows.push(draft); selected = rows.length - 1; }
            paint(); emit();
          },
        },
      ],
    });
  }

  paint();
  return { element: root, destroy() { root.remove(); }, get value() { return rows.map((r) => ({ ...r })); } };
}

/* ================================================================== */
/* the password prompt                                                 */
/* ================================================================== */

/**
 * Collects one to three passwords in a real modal — this is a credential step,
 * which is exactly what a blocking dialog is for. Values live in the input
 * elements and the submit closure only; nothing is stored, echoed or logged,
 * and the fields are cleared before the dialog is torn down.
 */
export function passwordPrompt({ title, body, fields = ['new', 'confirm'], onSubmit, onCancel }) {
  const inputs = {};
  const mk = (name, labelText) => {
    const input = h('input', {
      type: 'password', class: 'field-input', autocomplete: 'new-password', spellcheck: 'false',
    });
    inputs[name] = input;
    return h('label', { class: 'field' }, h('span', { class: 'field-label' }, labelText), input);
  };
  const error = h('p', { class: 'pref-hint is-danger', hidden: true });

  const rows = [];
  if (fields.includes('current')) rows.push(mk('current', t('password')));
  if (fields.includes('new')) rows.push(mk('next', t('masterPassword')));
  if (fields.includes('confirm')) rows.push(mk('confirm', t('confirmPw')));

  let handled = false;
  const handle = openModal({
    title,
    width: 460,
    content: h('div', { class: 'stack' },
      body ? h('p', { class: 'prose' }, body) : null,
      ...rows,
      error),
    onClose: (reason) => {
      for (const input of Object.values(inputs)) input.value = '';
      if (!handled && reason !== 'submitted') onCancel?.();
    },
    actions: [
      { label: t('cancel') || 'Cancel', kind: 'text' },
      {
        label: t('ok'), kind: 'filled', autofocus: false,
        onSelect: (close) => {
          const current = inputs.current ? inputs.current.value : '';
          const next = inputs.next ? inputs.next.value : '';
          const confirm = inputs.confirm ? inputs.confirm.value : '';
          if (fields.includes('new')) {
            if (!next) { showError(t('password')); return true; }
            if (fields.includes('confirm') && next !== confirm) { showError(t('pwMismatch')); return true; }
          }
          if (fields.includes('current') && !current) { showError(t('password')); return true; }
          handled = true;
          Promise.resolve(onSubmit({ current, next }))
            .then(() => { for (const i of Object.values(inputs)) i.value = ''; close('submitted'); })
            .catch((err) => { handled = false; showError(err.message || String(err)); });
          return true;                       // stay open until the write lands
        },
      },
    ],
  });

  function showError(message) {
    error.textContent = message;
    error.hidden = false;
  }
  return handle;
}

/* ================================================================== */
/* registration                                                        */
/* ================================================================== */

/**
 * The dictionary entry is a MENU label, so it ends in an ellipsis meaning
 * "this opens something". As the title of the thing it opened, that ellipsis
 * is a promise of a further step that does not exist.
 */
function preferencesTitle() {
  // In bilingual mode the string is "Preferences… · 偏好設定", so the ellipsis
  // is in the middle rather than at the end.
  return t('preferences').replace(/(\.{3}|…)(?=\s|$)/g, '').trim();
}

/**
 * Open Preferences as a modal. `pageId` jumps straight to a page, which is how
 * "Configure…" entries elsewhere in the app reach their own settings.
 */
export function openPreferences(props = {}) {
  if (openHandle) {
    if (props.pageId) openHandle.surface.goTo(props.pageId, props.controlKey);
    return openHandle.modal;
  }
  ensurePreferenceStyles();
  const surface = createPreferences(props);
  const before = surface.snapshot();

  const modal = openModal({
    title: preferencesTitle(),
    content: surface.element,
    dismissOnScrim: false,
    onClose: () => { surface.destroy(); openHandle = null; },
    actions: [
      {
        label: tx('Revert changes', '還原今次嘅改動'),
        kind: 'text',
        onSelect: async () => {
          const n = await surface.revert(before);
          if (n) notify.success(t('settingsSaved'),
            tx(`${n} ${n === 1 ? 'option was' : 'options were'} put back.`, `還原咗 ${n} 個選項。`));
          else notify.info(t('preferences'), tx('Nothing was changed in this session.', '冇嘢要還原。'));
          return true;                        // keep the dialog open
        },
      },
      { label: t('close'), kind: 'filled', autofocus: true },
    ],
  });
  openHandle = { modal, surface };
  return modal;
}

let installed = false;

/** Idempotent; app.js (or a dialogs barrel) calls this once. */
export function installPreferences() {
  if (installed) return;
  installed = true;
  ensurePreferenceStyles();

  registerDialog('preferences', ({ props, close }) => {
    const surface = createPreferences(props || {});
    const before = surface.snapshot();
    return {
      title: preferencesTitle(),
      content: surface.element,
      dismissOnScrim: false,
      onClose: () => surface.destroy(),
      actions: [
        {
          label: tx('Revert changes', '還原今次嘅改動'),
          kind: 'text',
          onSelect: async () => {
            const n = await surface.revert(before);
            notify.info(t('preferences'), n
              ? (tx(`${n} ${n === 1 ? 'option was' : 'options were'} put back.`, `還原咗 ${n} 個選項。`))
              : (tx('Nothing was changed in this session.', '冇嘢要還原。')));
            return true;
          },
        },
        { label: t('close'), kind: 'filled', autofocus: true, onSelect: () => close() },
      ],
    };
  });

  registerCommand({
    id: 'app.preferences.page', label: 'Open a preferences page', icon: 'settings',
    run: (pageId) => openPreferences({ pageId }),
  });
  registerCommand({
    id: 'app.preferences.setting', label: 'Open a preference setting', icon: 'settings',
    run: (target) => openPreferences({ pageId: target?.pageId, controlKey: target?.key }),
  });
  registerCommand({
    id: 'app.preferences.transfer', labelKey: 'transferSettingsShort', icon: 'swap_vert',
    run: () => openPreferences({ pageId: 'transfer' }),
  });
  registerCommand({
    id: 'app.preferences.commands', labelKey: 'customizeCmds', icon: 'code',
    run: () => openPreferences({ pageId: 'commands' }),
  });
  registerCommand({
    id: 'app.preferences.editors', labelKey: 'pEditor', icon: 'edit',
    run: () => openPreferences({ pageId: 'editors' }),
  });
  registerCommand({
    id: 'app.preferences.appearance', labelKey: 'pAppearance', icon: 'palette',
    run: () => openPreferences({ pageId: 'appearance' }),
  });

  // Warm the cache so the first open paints real values rather than defaults.
  prefs.load().catch((err) => {
    notify.warning(t('preferences'), `The stored preferences could not be read: ${err.message}`);
  });

  session.set('preferencesInstalled', true);
  bus.emit('preferences:installed', { pages: PAGES.length });
}

// Self-installing: importing this module is enough to make Preferences work,
// whether app.js imports it directly or a dialogs barrel pulls the folder in.
// Guarded the same way app.js guards its own boot, so the schema and the pure
// helpers can be imported headless by the test suite.
if (typeof document !== 'undefined') installPreferences();

export { PAGES, openCopyParamPreset };
