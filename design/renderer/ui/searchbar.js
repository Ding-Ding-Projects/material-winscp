// ui/searchbar.js — the search bar every search surface in the app uses.
//
// One component, one behaviour, everywhere: panels, preferences, the changelog
// viewer, the history panel, the notification centre and all four tab
// searches. Plain text is the default; regex is an explicit opt-in; the full
// regex builder is anchored to THIS field (the .* button beside it) and never
// to a distant global dialog.
//
// Query, pattern, flags, validation and mode synchronise bidirectionally:
//   * typing in text mode updates the query and the derived predicate
//   * typing in regex mode updates the pattern, and the open builder follows
//   * editing in the builder updates the field
//   * toggling the mode carries the value across (text -> regex escapes the
//     literal so the same rows still match; regex -> text keeps the last plain
//     query rather than pasting a pattern into a plain-text field)
//
// Other agents: call createSearchBar({ id, ... }) and read `handle.predicate`.
// Never write your own field — the regex builder requirement is satisfied by
// using this one.

import { h, icon, uid, appearanceTarget, debounce, announce } from '../dom.js';
import { t, bindText } from '../i18n.js';
import { store, persistCurrent } from '../state.js';
import { openRegexBuilder, makePredicate, compile, escapeLiteral } from './regexbuilder.js';

const registry = new Map();

/** Every live search bar, keyed by id. Used for diagnostics and deep links. */
export function getSearchBar(id) { return registry.get(id); }
export function listSearchBars() { return Array.from(registry.values()); }

function persisted(id) {
  if (!id) return null;
  const all = store.get('search') || {};
  return all[id] || null;
}

/**
 * createSearchBar(opts) -> handle
 *
 * opts:
 *   id            stable key; state persists under config search.<id>
 *   labelKey      i18n key for the accessible name (default 'search')
 *   placeholderKey / placeholder
 *   value         initial plain-text query
 *   pattern/flags/mode  initial regex state ('text' | 'regex')
 *   sample        sample text handed to the builder (defaults to the corpus
 *                 supplied by sampleProvider, so testing is against real data)
 *   sampleProvider  () => string, called when the builder opens
 *   onChange(state)   fires on every edit, debounced
 *   onSubmit(state)   fires on Enter
 *   compact       narrow layout for toolbars and popovers
 *   persist       default true; false for throwaway surfaces
 *
 * handle:
 *   element, focus(), destroy()
 *   state -> { query, pattern, flags, mode, valid, error }
 *   predicate -> { ok, error, test(value), describe }
 *   setQuery(s), setMode('text'|'regex'), setPattern(p, flags), clear()
 *   subscribe(fn)
 */
export function createSearchBar(opts = {}) {
  const id = opts.id || uid('search');
  const saved = opts.persist === false ? null : persisted(id);

  const state = {
    query: opts.value ?? saved?.query ?? '',
    pattern: opts.pattern ?? saved?.pattern ?? '',
    flags: opts.flags ?? saved?.flags ?? 'i',
    mode: opts.mode ?? saved?.mode ?? 'text',
    valid: true,
    error: null,
  };

  const inputId = uid('sb-input');
  const hintId = uid('sb-hint');
  const subscribers = new Set();
  let builder = null;

  const input = h('input', {
    type: 'text', id: inputId, class: 'sb-input', autocomplete: 'off',
    spellcheck: 'false', 'aria-describedby': hintId,
  });
  const modeChip = h('button', {
    type: 'button', class: 'sb-mode', 'aria-pressed': 'false',
    onclick: () => setMode(state.mode === 'regex' ? 'text' : 'regex'),
  }, h('span', { class: 'mono' }, '.*'));

  const builderBtn = h('button', {
    type: 'button', class: 'sb-rb icon-btn',
    onclick: (e) => { e.stopPropagation(); toggleBuilder(); },
  }, icon('manage_search', 18));

  const clearBtn = h('button', {
    type: 'button', class: 'sb-clear icon-btn', hidden: true,
    onclick: () => { clear(); input.focus(); },
  }, icon('close', 16));

  const hint = h('span', { id: hintId, class: 'sb-hint sr-only' });

  const root = h('div', {
    class: `sb${opts.compact ? ' is-compact' : ''}`, role: 'search',
    'data-search-id': id,
  },
  icon('search', 18, { weight: 1.7 }),
  input, hint, clearBtn, modeChip, builderBtn);

  appearanceTarget(root, opts.appearanceKey || `search-${id}`, opts.appearanceLabel || 'Search bar');

  // Accessible name + placeholder stay bound so they follow the language mode.
  bindText(input, opts.labelKey || 'search', { attr: 'aria-label' });
  if (opts.placeholder) input.placeholder = opts.placeholder;
  else bindText(input, opts.placeholderKey || 'search', { attr: 'placeholder' });
  bindText(modeChip, 'rbTitle', { attr: 'title' });
  bindText(builderBtn, 'rbTitle', { attr: 'aria-label' });
  bindText(builderBtn, 'rbTitle', { attr: 'title' });
  bindText(clearBtn, 'reset', { attr: 'aria-label' });

  /* ---------------- state plumbing ---------------- */

  function currentPredicate() {
    return makePredicate({ query: state.query, pattern: state.pattern, flags: state.flags, mode: state.mode });
  }

  function validate() {
    if (state.mode !== 'regex') { state.valid = true; state.error = null; return; }
    const c = compile(state.pattern, state.flags.replace(/g/g, ''));
    state.valid = c.ok;
    state.error = c.error;
  }

  function paint() {
    validate();
    input.value = state.mode === 'regex' ? state.pattern : state.query;
    modeChip.setAttribute('aria-pressed', String(state.mode === 'regex'));
    modeChip.classList.toggle('is-on', state.mode === 'regex');
    root.classList.toggle('is-invalid', !state.valid);
    root.classList.toggle('has-value', !!input.value);
    clearBtn.hidden = !input.value;
    input.setAttribute('aria-invalid', String(!state.valid));
    hint.textContent = state.mode === 'regex'
      ? (state.valid
        ? `Regular expression mode, JavaScript RegExp, flags ${state.flags || 'none'}.`
        : `Invalid regular expression: ${state.error}`)
      : 'Plain text search. Press the .* button for regular expressions.';
    root.title = state.mode === 'regex' && !state.valid ? `Invalid pattern: ${state.error}` : '';
  }

  const notify = () => {
    const snapshot = { ...state, predicate: currentPredicate() };
    for (const fn of Array.from(subscribers)) {
      try { fn(snapshot); } catch (err) { console.error('[searchbar] subscriber failed', err); }
    }
    opts.onChange?.(snapshot);
  };

  const savePersist = debounce(() => {
    if (opts.persist === false) return;
    const all = { ...(store.get('search') || {}) };
    all[id] = { query: state.query, pattern: state.pattern, flags: state.flags, mode: state.mode };
    store.set('search', all);
    persistCurrent('search');
  }, 500);

  const emit = debounce(() => { notify(); savePersist(); }, opts.debounceMs ?? 120);

  function onInput() {
    if (state.mode === 'regex') state.pattern = input.value;
    else state.query = input.value;
    paint();
    builder?.setPattern?.(state.mode === 'regex' ? state.pattern : builder.pattern);
    emit();
  }

  input.addEventListener('input', onInput);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      emit.flush();
      opts.onSubmit?.({ ...state, predicate: currentPredicate() });
    } else if (e.key === 'Escape' && input.value) {
      e.preventDefault();
      e.stopPropagation();
      clear();
    }
  });

  /* ---------------- mode + builder ---------------- */

  function setMode(next) {
    if (next === state.mode) return;
    if (next === 'regex') {
      // Carry the plain query across as an escaped literal so the same rows
      // keep matching the moment regex is switched on.
      if (!state.pattern && state.query) state.pattern = escapeLiteral(state.query);
      state.mode = 'regex';
    } else {
      state.mode = 'text';
    }
    paint();
    announce(state.mode === 'regex'
      ? 'Regular expression mode on.'
      : 'Plain text search mode on.');
    builder?.setPattern?.(state.pattern);
    emit.flush();
    notify();
    savePersist();
  }

  function toggleBuilder() {
    if (builder) { builder.close(); return; }
    if (state.mode !== 'regex' && !state.pattern && state.query) state.pattern = escapeLiteral(state.query);
    const sample = typeof opts.sampleProvider === 'function'
      ? String(opts.sampleProvider() ?? '')
      : (opts.sample ?? '');
    builder = openRegexBuilder({
      anchor: builderBtn,
      pattern: state.pattern,
      flags: state.flags,
      sample: sample || undefined,
      title: opts.builderTitle,
      onChange: ({ pattern, flags, valid, error }) => {
        state.pattern = pattern;
        state.flags = flags;
        state.valid = valid;
        state.error = error;
        if (state.mode === 'regex') input.value = pattern;
        paint();
        emit();
      },
      onApply: ({ pattern, flags }) => {
        state.pattern = pattern;
        state.flags = flags;
        if (state.mode !== 'regex') setMode('regex');
        else { paint(); emit.flush(); notify(); savePersist(); }
        input.focus();
      },
      onClose: () => { builder = null; },
    });
  }

  function setQuery(value) {
    state.query = String(value ?? '');
    if (state.mode !== 'regex') input.value = state.query;
    paint();
    emit.flush();
    notify();
    savePersist();
  }

  function setPattern(pattern, flags) {
    state.pattern = String(pattern ?? '');
    if (flags != null) state.flags = String(flags);
    if (state.mode === 'regex') input.value = state.pattern;
    builder?.setPattern?.(state.pattern);
    if (flags != null) builder?.setFlags?.(state.flags);
    paint();
    emit.flush();
    notify();
    savePersist();
  }

  function clear() {
    state.query = '';
    state.pattern = '';
    input.value = '';
    paint();
    emit.flush();
    notify();
    savePersist();
  }

  function destroy() {
    builder?.close();
    subscribers.clear();
    registry.delete(id);
    root.remove();
  }

  const handle = {
    id,
    element: root,
    input,
    get state() { return { ...state }; },
    get predicate() { return currentPredicate(); },
    get isActive() { return state.mode === 'regex' ? !!state.pattern : !!state.query; },
    focus() { input.focus(); input.select(); },
    setQuery, setPattern, setMode, clear, destroy,
    openBuilder: toggleBuilder,
    subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); },
  };

  registry.set(id, handle);
  paint();
  return handle;
}

/**
 * Filter helper: apply a search bar's predicate to a list, matching against
 * whatever `fields(item)` returns (a string or an array of strings).
 * Everything in the app filters through this, so an empty query always means
 * "no filtering" rather than "match nothing".
 */
export function filterBy(items, predicate, fields) {
  if (!predicate || !predicate.ok) return [];
  const active = predicate.mode === 'regex' ? predicate.describe !== '//' : true;
  return items.filter((item) => {
    const vals = fields ? fields(item) : [String(item)];
    const list = Array.isArray(vals) ? vals : [vals];
    return list.some((v) => predicate.test(v));
  });
  void active;
}

/** An honest empty-state message naming what was filtered out. */
export function noMatchMessage(predicate, scopeLabel) {
  const what = predicate?.mode === 'regex' ? `pattern ${predicate.describe}` : predicate?.describe || 'that search';
  return `Nothing in ${scopeLabel} matches ${what}.`;
}
