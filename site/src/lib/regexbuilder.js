// lib/regexbuilder.js — the regex builder, anchored beside the field it
// belongs to.
//
// ANCHORED, NOT GLOBAL. Every search field on this site gets its own builder,
// bound to that field's query, pattern, flags and mode. One shared global
// dialog that silently applies to whichever field was touched last is the
// design this explicitly is not: with four search surfaces on one page, "which
// field does this pattern go to" must never be a question.
//
// SYNCHRONISATION IS BIDIRECTIONAL. Typing in the field updates the builder;
// building a pattern updates the field. Switching text → regex escapes the
// literal query so it still means the same thing; switching regex → text keeps
// the raw source visible rather than silently discarding what was typed.

import { h, clear, openPopover, copyText, downloadText, announce, uid } from './dom.js';
import { text as T } from './i18n.js';
import { notify } from './toast.js';
import {
  CONSTRUCTS, FLAGS, ENGINE_NAME, MAX_SAMPLE,
  escapeLiteral, evaluate, makePredicate,
} from './regex.js';

/**
 * Bind a search field to its own builder.
 *
 * `state` is the single source of truth for that field: { query, pattern,
 * flags, mode, sample }. The caller passes `onChange`, which is where the
 * actual search runs — the builder never performs the search itself, so a
 * field's semantics live with the field.
 */
export function attachRegexBuilder({ field, button, layer, store, state, onChange, sampleFor }) {
  let close = null;
  const opts = () => store.langOpts();

  const sync = () => {
    button.dataset.mode = state.mode;
    button.classList.toggle('rx-on', state.mode === 'regex');
    button.title = T('openRegexBuilder', opts());
    button.setAttribute('aria-label', `${T('openRegexBuilder', opts())} — ${state.mode === 'regex'
      ? T('searchRegex', opts()) : T('searchPlain', opts())}`);
  };

  field.addEventListener('input', () => {
    if (state.mode === 'regex') state.pattern = field.value;
    else state.query = field.value;
    onChange(state);
  });

  button.addEventListener('click', () => {
    if (close) { close(); close = null; return; }
    close = openBuilder();
  });
  sync();

  function openBuilder() {
    const panel = buildPanel();
    return openPopover({
      anchor: button,
      panel,
      layer,
      align: 'right',
      onClose: () => { close = null; field.focus(); },
    });
  }

  function buildPanel() {
    const id = uid('rb');
    const panel = h('div.popover.rb', { role: 'dialog', 'aria-label': T('regexBuilder', opts()) });

    /* ---- mode: plain text is the default, regex is an explicit opt-in ---- */
    const modeText = h('input', { type: 'radio', name: `${id}-mode`, id: `${id}-text`, checked: state.mode !== 'regex' });
    const modeRegex = h('input', { type: 'radio', name: `${id}-mode`, id: `${id}-regex`, checked: state.mode === 'regex' });
    modeText.addEventListener('change', () => setMode('text'));
    modeRegex.addEventListener('change', () => setMode('regex'));

    /* ---- the raw pattern editor ---- */
    const pattern = h('input.rb-pattern.mono', {
      type: 'text', id: `${id}-pattern`, spellcheck: 'false', autocomplete: 'off',
      value: state.pattern, 'aria-describedby': `${id}-engine`,
    });
    pattern.addEventListener('input', () => { state.pattern = pattern.value; if (state.mode === 'regex') field.value = pattern.value; run(); onChange(state); });

    /* ---- flags ----
     * Recomputed from EVERY box on every change, in FLAGS order, so the flag
     * string is a function of what is ticked rather than a running edit that
     * can accumulate a duplicate or lose its ordering. */
    const flagBoxes = FLAGS.map(({ flag, label }) => {
      const box = h('input', { type: 'checkbox', id: `${id}-f-${flag}`, checked: state.flags.includes(flag) });
      const l = store.get().lang === 'yue' ? label[1] : label[0];
      return { flag, el: box, node: h('label.rb-flag', { for: box.id, title: l }, box, h('code', { text: flag }), h('span.rb-flag-label', { text: l })) };
    });
    for (const f of flagBoxes) {
      f.el.addEventListener('change', () => {
        state.flags = flagBoxes.filter((b) => b.el.checked).map((b) => b.flag).join('');
        run();
        onChange(state);
      });
    }

    /* ---- guided construction ---- */
    const constructs = h('div.rb-constructs', null, CONSTRUCTS.map((g) => h('details.rb-group', null,
      h('summary', { text: store.get().lang === 'yue' ? g.group[1] : g.group[0] }),
      h('div.rb-items', null, g.items.map((item) => h('button.chip', {
        type: 'button',
        text: store.get().lang === 'yue' ? item.label[1] : item.label[0],
        onclick: () => insert(item),
      }))))));

    /* ---- sample text and live results ---- */
    const sample = h('textarea.rb-sample.mono', {
      id: `${id}-sample`, rows: '4', spellcheck: 'false',
      'aria-label': T('rbSample', opts()),
    });
    sample.value = state.sample || (sampleFor ? sampleFor() : '');
    sample.addEventListener('input', () => { state.sample = sample.value; run(); });

    const status = h('p.rb-status', { role: 'status', 'aria-live': 'polite' });
    const results = h('div.rb-results');

    panel.append(
      h('div.rb-head', null,
        h('h2.rb-title', { text: T('regexBuilder', opts()) }),
        h('div.rb-modes', { role: 'radiogroup', 'aria-label': T('search', opts()) },
          h('label.rb-mode', { for: modeText.id }, modeText, h('span', { text: T('searchPlain', opts()) })),
          h('label.rb-mode', { for: modeRegex.id }, modeRegex, h('span', { text: T('searchRegex', opts()) })))),
      h('label.rb-label', { for: pattern.id, text: T('rbPattern', opts()) }),
      pattern,
      h('p.rb-engine', { id: `${id}-engine`, text: T('rbEngine', opts(), [ENGINE_NAME]) }),
      h('fieldset.rb-flags', null, h('legend', { text: T('rbFlags', opts()) }), flagBoxes.map((f) => f.node)),
      constructs,
      h('label.rb-label', { for: sample.id, text: T('rbSample', opts()) }),
      sample,
      status,
      results,
      h('p.rb-privacy', { text: T('rbLocalOnly', opts()) }),
      h('div.rb-actions', null,
        h('button.btn.btn-text', { type: 'button', text: T('rbCopy', opts()), onclick: doCopy }),
        h('button.btn.btn-text', { type: 'button', text: T('rbExport', opts()), onclick: doExport }),
        h('button.btn.btn-filled', { type: 'button', text: T('rbApply', opts()), onclick: apply })));

    run();
    return panel;

    /* ------------------------------------------------------------ actions */

    function setMode(mode) {
      if (state.mode === mode) return;
      // text → regex escapes the literal, so the same query keeps meaning the
      // same thing. regex → text keeps the raw source in the field rather than
      // throwing away what the user built.
      if (mode === 'regex' && !state.pattern) state.pattern = escapeLiteral(state.query || '');
      if (mode === 'text' && !state.query) state.query = state.pattern || '';
      state.mode = mode;
      pattern.value = state.pattern;
      field.value = mode === 'regex' ? state.pattern : state.query;
      sync();
      run();
      onChange(state);
    }

    function insert(item) {
      let value = '';
      if (item.prompt) {
        // eslint-disable-next-line no-alert -- a one-field prompt inside an
        // already-anchored popover; a nested popover here would obscure the
        // pattern the user is looking at.
        value = window.prompt(store.get().lang === 'yue' ? item.label[1] : item.label[0]);
        if (value === null) return;
      }
      const start = pattern.selectionStart ?? pattern.value.length;
      const end = pattern.selectionEnd ?? start;
      const selected = pattern.value.slice(start, end);
      const fragment = item.build ? item.build(value, selected) : item.insert;
      const wrapped = item.wraps && selected && item.build ? item.build(value || selected, selected) : fragment;
      pattern.value = pattern.value.slice(0, start) + wrapped + pattern.value.slice(end);
      pattern.focus();
      pattern.setSelectionRange(start + wrapped.length, start + wrapped.length);
      state.pattern = pattern.value;
      if (state.mode !== 'regex') { modeRegex.checked = true; setMode('regex'); }
      else { field.value = pattern.value; run(); onChange(state); }
    }

    function run() {
      clear(results);
      // The preview shows what the builder WOULD apply. That is the pattern box
      // whenever it has anything in it — including while the field is still in
      // plain-text mode, because a user typing into the pattern editor is
      // building a pattern and expects to watch it match. Only when the pattern
      // box is empty does it fall back to the field's literal query, escaped so
      // the preview means what plain-text search means.
      const src = pattern.value || escapeLiteral(field.value || '');
      const r = evaluate(src, state.flags, sample.value);
      if (!r.ok) {
        status.textContent = r.runaway
          ? T('rbRefused', opts(), [r.error])
          : T('rbInvalid', opts(), [r.error]);
        status.dataset.kind = 'error';
        return;
      }
      if (r.empty) { status.textContent = ''; status.dataset.kind = ''; return; }
      status.dataset.kind = r.matches.length ? 'ok' : 'none';
      status.textContent = r.matches.length
        ? T('rbMatches', opts(), [r.matches.length]) + (r.truncated ? ` — ${T('rbTruncated', opts(), [r.matches.length])}` : '')
        : T('rbNoMatch', opts());
      if (r.sampleTruncated) {
        status.textContent += ` (sample capped at ${MAX_SAMPLE} characters)`;
      }
      results.append(h('ol.rb-matchlist', null, r.matches.slice(0, 40).map((m) => h('li', null,
        h('code.rb-match', { text: m.empty ? T('rbEmptyMatch', opts()) : m.text }),
        h('span.rb-at', { text: `@${m.index}` }),
        m.groups.length
          ? h('ul.rb-groups', null, m.groups.map((g) => h('li', null,
            h('span.rb-gn', { text: `$${g.n}` }),
            h('code', { text: g.text === null ? '(no match)' : g.text }))))
          : null,
        m.named && Object.keys(m.named).length
          ? h('ul.rb-groups', null, Object.entries(m.named).map(([n, v]) => h('li', null,
            h('span.rb-gn', { text: n }), h('code', { text: v ?? '(no match)' }))))
          : null))));
    }

    async function doCopy() {
      const r = await copyText(pattern.value);
      if (r.ok) notify.success(T('copied', opts()));
      else notify.error(T('copyFailed', opts(), [r.error]));
    }

    function doExport() {
      const src = pattern.value;
      const r = evaluate(src, state.flags, sample.value);
      downloadText('regex-pattern.json', JSON.stringify({
        engine: ENGINE_NAME,
        pattern: src,
        flags: state.flags,
        mode: state.mode,
        sample: sample.value,
        matches: r.ok ? r.matches.map((m) => ({ index: m.index, text: m.text, groups: m.groups })) : [],
        error: r.ok ? null : r.error,
        exported: new Date().toISOString(),
      }, null, 2));
      notify.success(T('exported', opts(), ['regex-pattern.json']));
    }

    function apply() {
      state.mode = 'regex';
      state.pattern = pattern.value;
      field.value = pattern.value;
      sync();
      onChange(state);
      announce(makePredicate(state).describe);
    }
  }

  return { sync, state };
}

/** A fresh, independent state object per field. Sharing one between two fields
 *  is the bug this function exists to make impossible to write by accident. */
export function newSearchState(initial = {}) {
  return { query: '', pattern: '', flags: 'gi', mode: 'text', sample: '', ...initial };
}
