// lib/settings.js — the settings surface.
//
// Every control here carries its own search bar wired to the full regex
// builder, because a settings page a reader has to scan by eye is a settings
// page where a known setting is still hard to find. The search reports plainly
// when a match sits on a tab that is not showing, rather than returning nothing
// and letting the reader conclude the setting does not exist.
//
// Every control also carries a per-control reset, and the page carries a global
// one, plus export and import as a file so a customised appearance survives a
// new browser.

import { h, clear, downloadText, pickFile, flashTarget } from './dom.js';
import { text as T } from './i18n.js';
import { notify, renderNotificationCentre } from './toast.js';
import { makePredicate } from './regex.js';
import { attachRegexBuilder, newSearchState } from './regexbuilder.js';
import { DEFAULTS, FONT_STACKS, makeExport, parseExport } from './store.js';
import { colorSwatchButton } from './colorpicker.js';
import { LANGS } from './i18n.js';
import { scheme } from './theme.js';

const TABS = [
  { id: 'appearance', label: ['Appearance', '外觀'] },
  { id: 'language', label: ['Language', '語言'] },
  { id: 'reading', label: ['Reading', '閱讀'] },
  { id: 'data', label: ['Data', '資料'] },
  { id: 'notices', label: ['Notifications', '通知'] },
];

export function renderSettings(host, ctx) {
  const { store, layer, data } = ctx;
  const opts = () => store.langOpts();
  const s = () => store.get();
  let activeTab = ctx.settingsTab || 'appearance';

  /* --------------------------------------------------- the settings search */

  const state = newSearchState();
  const searchField = h('input.field', {
    type: 'search', id: 'settings-search', autocomplete: 'off',
    placeholder: T('searchSettings', opts()), 'aria-label': T('searchSettings', opts()),
  });
  const rxButton = h('button.rx-button', {
    type: 'button', 'aria-expanded': 'false', text: '.*', title: T('openRegexBuilder', opts()),
  });
  const searchStatus = h('p.settings-hits', { role: 'status', 'aria-live': 'polite' });

  const panels = h('div.settings-panels');
  const tablist = h('div.settings-tabs', { role: 'tablist', 'aria-label': T('settings', opts()) });

  host.append(h('section.settings', null,
    h('h1', { text: T('settings', opts()) }),
    h('div.search-field.search-field-wide', null,
      h('span.search-icon', { 'aria-hidden': 'true', text: '🔍' }), searchField, rxButton),
    searchStatus,
    tablist,
    panels,
    h('p.muted', { text: store.persistenceBroken
      ? 'This browser refused to store settings, so changes will not survive a reload.'
      : T('settingsSaved', opts()) })));

  /* ------------------------------------------------------------ the rows */

  /** Every row registers itself so the search can find it, say which tab it is
   *  on, and teleport the reader to the exact control. */
  const rows = [];
  const subscriptions = [];
  const row = (tab, key, labelKey, control, { help, resettable = true, terms = [] } = {}) => {
    // A STABLE id, not a fresh uid. draw() rebuilds every panel, so a
    // generated id changes on each pass — and the one moment the search needs
    // to find a row by id is immediately after a redraw, when it has switched
    // tabs to reach it. With a fresh uid that lookup always misses and the
    // reader lands on the right tab with nothing highlighted.
    const id = `set-${tab}-${labelKey}`;
    const el = h('div.setting', { id, 'data-tab': tab },
      h('div.setting-text', null,
        // A composite control (a slider and its readout) is a <div>, which is
        // not labelable — it publishes the id of the real input in `data-for`
        // so the label still points at something a screen reader can name.
        h('label.setting-label', { for: control.dataset?.for || control.id || undefined, text: T(labelKey, opts()) }),
        help ? h('p.setting-help.muted', { text: help }) : null),
      h('div.setting-control', null, control,
        resettable && key ? h('button.btn.btn-text.setting-reset', {
          type: 'button', text: T('resetThis', opts()),
          onclick: () => { store.reset(key); notify.info(`${T(labelKey, opts())} → ${JSON.stringify(DEFAULTS[key])}`); draw(); },
        }) : null));
    // `terms` is written as a plain string at most call sites, and spreading a
    // string spreads it into CHARACTERS — the search corpus becomes "c a n t
    // o n e s e" and every multi-letter query silently matches nothing. Coerce
    // to an array first.
    const extra = Array.isArray(terms) ? terms : [String(terms || '')];
    rows.push({ tab, el, id, terms: [T(labelKey, opts()), labelKey, key || '', help || '', ...extra].join(' ') });
    return el;
  };

  function appearancePanel() {
    const panel = h('div.settings-panel', { role: 'tabpanel', 'data-tab': 'appearance' });

    const themeSel = h('select.field', { id: 'set-theme' },
      [['system', 'themeSystem'], ['light', 'themeLight'], ['dark', 'themeDark']]
        .map(([v, k]) => h('option', { value: v, text: T(k, opts()), selected: s().theme === v })));
    themeSel.addEventListener('change', () => store.set({ theme: themeSel.value }));
    panel.append(row('appearance', 'theme', 'theme', themeSel, { terms: 'light dark system colour scheme' }));

    const sc = scheme() || {};
    const seed = colorSwatchButton({
      value: s().seed, label: T('accent', opts()), store, layer,
      contrastAgainst: sc.onPrimary || '#ffffff',
      onChange: (hex) => store.set({ seed: hex }),
    });
    panel.append(row('appearance', 'seed', 'accent', seed, {
      help: 'The whole Material 3 scheme is derived from this one colour.',
      terms: 'colour color accent seed palette hex rgb hsl oklch translator',
    }));

    panel.append(row('appearance', 'contrastBoost', 'contrastBoost',
      slider('set-contrast', 0, 1, 0.1, s().contrastBoost, (v) => store.set({ contrastBoost: v })),
      { help: 'Pushes every foreground colour further from its background.', terms: 'accessibility wcag aa contrast' }));

    panel.append(row('appearance', 'density', 'density',
      slider('set-density', -3, 0, 1, s().density, (v) => store.set({ density: v })),
      { terms: 'compact comfortable spacing' }));

    const fam = h('select.field', { id: 'set-font' }, Object.entries(FONT_STACKS)
      .map(([k, f]) => h('option', { value: k, text: f.label, selected: s().fontFamily === k, style: { fontFamily: f.stack } })));
    fam.addEventListener('change', () => store.set({ fontFamily: fam.value }));
    panel.append(row('appearance', 'fontFamily', 'fontFamily', fam, { terms: 'typeface typography font family' }));

    panel.append(row('appearance', 'fontSize', 'fontSize',
      slider('set-size', 12, 24, 1, s().fontSize, (v) => store.set({ fontSize: v }), (v) => `${v}px`),
      { terms: 'typography text size zoom' }));
    panel.append(row('appearance', 'fontWeight', 'fontWeight',
      slider('set-weight', 300, 700, 100, s().fontWeight, (v) => store.set({ fontWeight: v })),
      { terms: 'typography bold light' }));

    const rm = toggle('set-rm', s().reduceMotion, (v) => store.set({ reduceMotion: v }));
    panel.append(row('appearance', 'reduceMotion', 'reduceMotion', rm, {
      help: 'In addition to your system’s reduced-motion preference, which is always respected.',
      terms: 'animation motion accessibility vestibular',
    }));
    return panel;
  }

  function languagePanel() {
    const panel = h('div.settings-panel', { role: 'tabpanel', 'data-tab': 'language' });
    const mode = h('select.field', { id: 'set-lang' },
      LANGS.map((v) => h('option', {
        value: v, selected: s().lang === v,
        text: T(v === 'en' ? 'langEnglish' : v === 'yue' ? 'langCantonese' : 'langBoth', opts()),
      })));
    mode.addEventListener('change', () => store.set({ lang: mode.value }));
    panel.append(row('language', 'lang', 'langMode', mode, { terms: 'english cantonese bilingual 粵語 語言' }));

    panel.append(row('language', 'funnyEn', 'funnyEn',
      slider('set-funny-en', 1, 5, 1, s().funnyEn, (v) => store.set({ funnyEn: v }), levelLabel),
      { help: T('funnyNote', opts()), terms: 'humour humor playful serious tone voice' }));
    panel.append(row('language', 'funnyYue', 'funnyYue',
      slider('set-funny-yue', 1, 5, 1, s().funnyYue, (v) => store.set({ funnyYue: v }), levelLabel),
      { help: T('funnyNote', opts()), terms: 'humour humor playful serious tone voice 粵語' }));

    // A live preview, because a slider whose effect you cannot see is a slider
    // nobody moves.
    const preview = h('blockquote.funny-preview');
    const drawPreview = () => {
      clear(preview);
      preview.append(h('p', { text: T('heroTitle', opts()) }), h('p', { text: T('copied', opts()) }));
    };
    drawPreview();
    // draw() rebuilds every panel, so the previous preview's subscription must
    // go with it. An accumulating subscriber list keeps writing into detached
    // nodes and is the classic reason a page gets slower the longer it is open.
    subscriptions.push(store.subscribe(drawPreview));
    panel.append(h('div.setting', { 'data-tab': 'language' },
      h('div.setting-text', null, h('p.setting-label', { text: 'Preview' })), preview));
    return panel;
  }

  function readingPanel() {
    const panel = h('div.settings-panel', { role: 'tabpanel', 'data-tab': 'reading' });
    panel.append(h('p.prose.muted', { text:
      'This site is navigated with browser-style tabs. Pinned tabs stay visible when the strip overflows, '
      + 'ordinary tabs move into the overflow surface rather than being clipped, and the whole strip is '
      + 'restored on your next visit.' }));
    const clearTabs = h('button.btn.btn-text', {
      type: 'button', id: 'set-cleartabs', text: 'Close every tab except Home',
      onclick: () => { store.set({ tabs: null }); window.location.reload(); },
    });
    panel.append(row('reading', 'tabs', 'tabs', clearTabs, { resettable: false, terms: 'tab strip pinned overflow reset' }));
    return panel;
  }

  function dataPanel() {
    const panel = h('div.settings-panel', { role: 'tabpanel', 'data-tab': 'data' });
    const exportBtn = h('button.btn.btn-text', {
      type: 'button', id: 'set-export', text: T('exportSettings', opts()),
      onclick: () => {
        const name = 'winscp-material-site-settings.json';
        downloadText(name, makeExport(s(), { site: data.repository }));
        notify.success(T('exported', opts(), [name]));
      },
    });
    const importBtn = h('button.btn.btn-text', {
      type: 'button', id: 'set-import', text: T('importSettings', opts()),
      onclick: async () => {
        const file = await pickFile();
        if (!file) return;
        const r = parseExport(file.text);
        if (!r.ok) { notify.error(T('importFailed', opts(), [r.error]), file.name); return; }
        store.replace(r.settings);
        notify.success(T('imported', opts(), [file.name]));
        draw();
      },
    });
    const resetAll = h('button.btn.btn-danger', {
      type: 'button', id: 'set-resetall', text: T('resetAll', opts()),
      onclick: () => { store.reset(); notify.info(T('resetAll', opts())); draw(); },
    });
    panel.append(
      row('data', null, 'exportSettings', exportBtn, { resettable: false, terms: 'backup json file save' }),
      row('data', null, 'importSettings', importBtn, { resettable: false, terms: 'restore json file load' }),
      row('data', null, 'resetAll', resetAll, { resettable: false, terms: 'default factory clear' }),
      h('p.muted.prose', { text: 'Settings live in this browser only. Nothing is sent anywhere, and this site '
        + 'loads no analytics, no third-party script and no remote font.' }));
    return panel;
  }

  function noticesPanel() {
    const panel = h('div.settings-panel', { role: 'tabpanel', 'data-tab': 'notices' });
    const centre = h('div.notice-centre');
    renderNotificationCentre(centre);
    panel.append(h('h2', { text: T('notifications', opts()) }), centre);
    return panel;
  }

  /* --------------------------------------------------------------- helpers */

  function slider(id, min, max, step, value, onChange, fmt = String) {
    const out = h('output.slider-out', { text: fmt(value) });
    const input = h('input.slider', {
      type: 'range', id, min: String(min), max: String(max), step: String(step), value: String(value),
    });
    input.addEventListener('input', () => { out.textContent = fmt(Number(input.value)); onChange(Number(input.value)); });
    const wrap = h('div.slider-wrap', { dataset: { for: id } }, input, out);
    return wrap;
  }

  function toggle(id, value, onChange) {
    const input = h('input.switch', { type: 'checkbox', id, checked: value || undefined });
    input.addEventListener('change', () => onChange(input.checked));
    return input;
  }

  const levelLabel = (v) => (v === 1 ? T('funny1', opts()) : v === 5 ? T('funny5', opts()) : String(v));

  /* --------------------------------------------------------------- drawing */

  function draw() {
    rows.length = 0;
    while (subscriptions.length) subscriptions.pop()();
    clear(tablist);
    clear(panels);
    for (const t of TABS) {
      const btn = h('button.settings-tab', {
        type: 'button', role: 'tab', 'data-tab': t.id,
        'aria-selected': activeTab === t.id ? 'true' : 'false',
        tabindex: activeTab === t.id ? '0' : '-1',
        text: s().lang === 'yue' ? t.label[1] : t.label[0],
        onclick: () => { activeTab = t.id; draw(); },
      });
      tablist.append(btn);
    }
    const built = {
      appearance: appearancePanel, language: languagePanel,
      reading: readingPanel, data: dataPanel, notices: noticesPanel,
    };
    for (const t of TABS) {
      const p = built[t.id]();
      p.hidden = t.id !== activeTab;
      panels.append(p);
    }
    runSearch();
  }

  /** Filter the visible tab, and SAY when a match is on another one. */
  function runSearch() {
    const pred = makePredicate(state.mode === 'regex'
      ? { pattern: state.pattern, flags: state.flags, mode: 'regex' }
      : { query: searchField.value, mode: 'text' });
    if (!pred.ok) {
      for (const r of rows) r.el.hidden = false;
      searchStatus.textContent = pred.empty ? '' : (pred.error || '');
      searchStatus.dataset.kind = pred.empty ? '' : 'error';
      return;
    }
    const hits = rows.filter((r) => pred.test(r.terms));
    for (const r of rows) r.el.hidden = !pred.test(r.terms);
    const elsewhere = hits.filter((r) => r.tab !== activeTab);
    const here = hits.length - elsewhere.length;
    searchStatus.dataset.kind = hits.length ? 'ok' : 'none';
    if (!hits.length) { searchStatus.textContent = T('noSettingMatch', opts()); return; }
    const byTab = [...new Set(elsewhere.map((r) => r.tab))]
      .map((id) => TABS.find((t) => t.id === id))
      .map((t) => (s().lang === 'yue' ? t.label[1] : t.label[0]));
    searchStatus.textContent = `${here} here`
      + (byTab.length ? ` · ${T('settingOnTab', opts(), [byTab.join(', ')])}` : '');
    if (!here && elsewhere.length) {
      // The only match is on a tab that is not showing: go there rather than
      // presenting an empty page and letting the reader conclude it is missing.
      activeTab = elsewhere[0].tab;
      draw();
      const target = document.getElementById(elsewhere[0].id);
      if (target) flashTarget(target);
    }
  }

  searchField.addEventListener('input', () => { state.query = searchField.value; runSearch(); });
  attachRegexBuilder({
    field: searchField, button: rxButton, layer, store, state,
    onChange: runSearch,
    sampleFor: () => rows.map((r) => r.terms).join('\n'),
  });

  draw();
  return { focusSetting(id) { const el = document.getElementById(id); if (el) flashTarget(el); } };
}
