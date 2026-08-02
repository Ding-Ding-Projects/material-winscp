// ui/regexbuilder.js — the full regex builder, anchored beside its search bar.
//
// This is a popover attached to the field the user is already typing in, not a
// global dialog: it opens next to the search bar, tracks it, and returns focus
// to it on close.
//
// Engine dialect is stated in the UI and is the truth: JavaScript `RegExp`
// (ECMAScript). Flags come from RB_FLAGS and constructs from REGEX_CONSTRUCTS
// in design/winscp-data.js — this module does not invent its own list.
//
// Evaluation is local and bounded:
//   * the sample is capped at MAX_SAMPLE characters
//   * matches are capped at MAX_MATCHES
//   * evaluation runs in a Worker with a hard time budget, and a runaway
//     pattern is TERMINATED and reported as catastrophic backtracking rather
//     than hanging the window. Where Workers are unavailable the inline path
//     checks a deadline between matches and refuses patterns whose structure
//     is a known backtracking hazard.
//
// Public API
//   openRegexBuilder({ anchor, pattern, flags, sample, onChange, onApply, … })
//   evaluate(pattern, flags, sample)   -> Promise<result>
//   escapeLiteral(text)                -> pattern-safe literal
//   compile(pattern, flags)            -> { ok, error, regex }

import { REGEX_CONSTRUCTS, RB_FLAGS } from '../../winscp-data.js';
import { h, icon, layer, anchorTo, trapFocus, focusMemory, announce, copyText, downloadText, uid, clamp } from '../dom.js';
import { t } from '../i18n.js';
import { appearanceTarget } from '../dom.js';

export const MAX_SAMPLE = 20000;
export const MAX_MATCHES = 500;
export const TIME_BUDGET_MS = 400;
export const ENGINE_NAME = 'JavaScript RegExp (ECMAScript)';

/* ------------------------------------------------------------------ */
/* pattern helpers                                                     */
/* ------------------------------------------------------------------ */

/** Escape `text` so it matches itself literally. */
export function escapeLiteral(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\/\-]/g, '\\$&');
}

/** Compile without throwing. */
export function compile(pattern, flags) {
  try {
    return { ok: true, regex: new RegExp(pattern, flags), error: null };
  } catch (err) {
    return { ok: false, regex: null, error: err && err.message ? err.message : String(err) };
  }
}

/**
 * Static hazard check for catastrophic backtracking. Detects nested
 * quantifiers over a group that can match the empty string — (a+)+, (a|a)*,
 * (\s*\w*)+ and friends — which is where exponential blow-up comes from.
 * It is a warning, not a veto: the time budget is the actual protection.
 */
/** Why a search refuses a runaway pattern. Named so tests can assert on it. */
export const RUNAWAY_REFUSAL = 'nested quantifier — this shape can take exponential time on the wrong input, '
  + 'so a search will not run it. Try the builder preview, which evaluates it in a Worker it can stop, '
  + 'or rewrite the pattern without a quantifier inside a quantified group.';

export function backtrackingRisk(pattern) {
  const p = String(pattern);
  const risky = [
    /\([^()]*[+*][^()]*\)\s*[+*]/,          // (a+)+ / (a*)*
    /\([^()]*\|[^()]*\)\s*[+*]\s*[+*]?/,    // (a|b)* with an alternation of equals
    /\(\?:[^()]*[+*][^()]*\)\s*[+*]/,       // non-capturing variant
    /\[[^\]]*\][+*]\s*\[[^\]]*\][+*]\s*[+*]/,
  ];
  return risky.some((re) => re.test(p));
}

/* ------------------------------------------------------------------ */
/* evaluation                                                          */
/* ------------------------------------------------------------------ */

const WORKER_SOURCE = `
self.onmessage = function (e) {
  var d = e.data, out = [], truncated = false;
  try {
    var flags = d.flags.indexOf('g') === -1 ? d.flags + 'g' : d.flags;
    var re = new RegExp(d.pattern, flags);
    var m, guard = 0;
    while ((m = re.exec(d.sample)) !== null) {
      guard += 1;
      if (guard > d.maxMatches) { truncated = true; break; }
      var groups = [];
      for (var i = 1; i < m.length; i++) groups.push({ index: i, value: m[i] === undefined ? null : m[i] });
      var named = [];
      if (m.groups) for (var k in m.groups) named.push({ name: k, value: m.groups[k] === undefined ? null : m.groups[k] });
      out.push({ start: m.index, end: m.index + m[0].length, value: m[0], groups: groups, named: named });
      if (m[0].length === 0) re.lastIndex += 1;      // zero-width: always advance
      if (d.flags.indexOf('g') === -1) break;
    }
    self.postMessage({ ok: true, matches: out, truncated: truncated });
  } catch (err) {
    self.postMessage({ ok: false, error: String(err && err.message ? err.message : err) });
  }
};
`;

let workerUrl = null;
function makeWorker() {
  if (typeof Worker !== 'function' || typeof Blob !== 'function' || typeof URL?.createObjectURL !== 'function') return null;
  try {
    if (!workerUrl) workerUrl = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }));
    return new Worker(workerUrl);
  } catch { return null; }
}

function evaluateInline(pattern, flags, sample, deadline) {
  const globalFlags = flags.includes('g') ? flags : `${flags}g`;
  const { ok, regex, error } = compile(pattern, globalFlags);
  if (!ok) return { ok: false, error };
  // The deadline below is only checked BETWEEN matches, so a pattern that blows
  // up inside one exec() would still hang this path. With no Worker to
  // terminate, the only safe answer is not to start — which is what the module
  // header has always claimed this path does.
  if (backtrackingRisk(pattern)) {
    return { ok: true, matches: [], truncated: false, timedOut: true, backtracking: true, error: null };
  }
  const matches = [];
  let truncated = false, timedOut = false, m;
  while ((m = regex.exec(sample)) !== null) {
    if (matches.length >= MAX_MATCHES) { truncated = true; break; }
    if (performance.now() > deadline) { timedOut = true; break; }
    const groups = [];
    for (let i = 1; i < m.length; i += 1) groups.push({ index: i, value: m[i] === undefined ? null : m[i] });
    const named = [];
    if (m.groups) for (const k of Object.keys(m.groups)) named.push({ name: k, value: m.groups[k] ?? null });
    matches.push({ start: m.index, end: m.index + m[0].length, value: m[0], groups, named });
    if (m[0].length === 0) regex.lastIndex += 1;
    if (!flags.includes('g')) break;
  }
  return { ok: true, matches, truncated, timedOut };
}

/**
 * Evaluate `pattern` against `sample`, locally and within a time budget.
 * Resolves { ok, error, matches, truncated, timedOut, elapsedMs, engine }.
 * A pattern that exceeds the budget resolves with timedOut:true — it never
 * blocks the UI thread past the budget when Workers are available.
 */
export function evaluate(pattern, flags, sample, opts = {}) {
  const budget = opts.budgetMs || TIME_BUDGET_MS;
  const text = String(sample ?? '').slice(0, opts.maxSample || MAX_SAMPLE);
  const started = performance.now();
  const syntax = compile(pattern, flags);
  if (!syntax.ok) {
    return Promise.resolve({ ok: false, error: syntax.error, matches: [], truncated: false, timedOut: false, elapsedMs: 0, engine: ENGINE_NAME });
  }
  if (!pattern) {
    return Promise.resolve({ ok: true, matches: [], truncated: false, timedOut: false, elapsedMs: 0, engine: ENGINE_NAME });
  }

  const worker = opts.inline ? null : makeWorker();
  if (!worker) {
    const res = evaluateInline(pattern, flags, text, started + budget);
    return Promise.resolve({ ...res, matches: res.matches || [], elapsedMs: performance.now() - started, engine: ENGINE_NAME, inline: true });
  }

  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      worker.terminate();                        // the runaway pattern dies here
      resolve({
        ok: true, matches: [], truncated: false, timedOut: true,
        elapsedMs: performance.now() - started, engine: ENGINE_NAME,
      });
    }, budget);
    worker.onmessage = (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      const d = e.data || {};
      resolve({
        ok: d.ok !== false, error: d.error || null, matches: d.matches || [],
        truncated: !!d.truncated, timedOut: false,
        elapsedMs: performance.now() - started, engine: ENGINE_NAME,
      });
    };
    worker.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      const res = evaluateInline(pattern, flags, text, performance.now() + budget);
      resolve({ ...res, matches: res.matches || [], elapsedMs: performance.now() - started, engine: ENGINE_NAME, inline: true });
    };
    worker.postMessage({ pattern, flags, sample: text, maxMatches: MAX_MATCHES });
  });
}

/* ------------------------------------------------------------------ */
/* the popover                                                         */
/* ------------------------------------------------------------------ */

const openBuilders = new Set();

/** Close every open builder (used when a dialog or menu takes over). */
export function closeAllRegexBuilders() { for (const b of Array.from(openBuilders)) b.close(); }

const DEFAULT_SAMPLE = [
  'q1-report.md',
  'server-backup-2026-07.tar.gz',
  '/var/www/html/index.html',
  'access.log',
  'holiday-001.jpg',
  'deploy.sh',
].join('\n');

/**
 * Open the builder anchored to `opts.anchor`.
 *
 * opts:
 *   anchor      (required) the element the popover attaches to — normally the
 *               .* button inside the search bar
 *   pattern     initial pattern            flags   initial flag string
 *   sample      initial sample text        title   heading override
 *   onChange({ pattern, flags, valid, error })   fires on every edit
 *   onApply({ pattern, flags })                  fires on Apply / Enter
 *   onClose()
 *
 * Returns { close, element, setPattern, setFlags }.
 */
export function openRegexBuilder(opts = {}) {
  if (!opts.anchor) throw new Error('openRegexBuilder needs an anchor element');
  closeAllRegexBuilders();

  const restoreFocus = focusMemory();
  const ids = {
    root: uid('rb'), pattern: uid('rb-pat'), sample: uid('rb-sample'),
    status: uid('rb-status'), matches: uid('rb-matches'),
  };

  let pattern = opts.pattern || '';
  let flags = opts.flags || 'g';
  let sample = opts.sample != null ? opts.sample : DEFAULT_SAMPLE;
  let lastResult = null;
  let evalToken = 0;

  /* ---------- structure ---------- */

  const patternInput = h('input', {
    type: 'text', id: ids.pattern, class: 'rb-pattern mono', spellcheck: 'false',
    autocomplete: 'off', autocapitalize: 'off',
    'aria-describedby': ids.status, 'aria-label': 'Regular expression pattern',
    placeholder: '\\.(jpe?g|png)$',
  });
  patternInput.value = pattern;

  const statusEl = h('div', { id: ids.status, class: 'rb-status', role: 'status', 'aria-live': 'polite' });
  const flagsRow = h('div', { class: 'rb-flags', role: 'group', 'aria-label': 'Flags' });
  const constructsEl = h('div', { class: 'rb-constructs', role: 'group', 'aria-label': 'Insert a construct' });
  const sampleInput = h('textarea', {
    id: ids.sample, class: 'rb-sample mono', spellcheck: 'false', rows: 5,
    'aria-label': 'Sample text', placeholder: 'Paste sample text to test against',
  });
  sampleInput.value = sample;
  const previewEl = h('div', { class: 'rb-preview mono', 'aria-label': 'Live matches', tabindex: '0' });
  const groupsEl = h('div', { id: ids.matches, class: 'rb-groups' });

  const flagButtons = new Map();
  for (const { f, d } of RB_FLAGS) {
    const b = h('button', {
      type: 'button', class: 'rb-flag', 'data-flag': f, title: `${f} — ${d}`,
      'aria-pressed': String(flags.includes(f)),
      onclick: () => toggleFlag(f),
    }, h('span', { class: 'mono' }, f));
    flagButtons.set(f, b);
    flagsRow.appendChild(b);
  }

  const CATEGORY_OF = (c) => {
    if (/^Text|Any character|Digit|Non-digit|Word character|Whitespace|Unicode/.test(c.l)) return 'Literals';
    if (/class|Range/i.test(c.l)) return 'Character classes';
    if (/Start of line|End of line|boundary/i.test(c.l)) return 'Anchors';
    if (/group|capturing/i.test(c.l)) return 'Groups';
    if (/Alternation/i.test(c.l)) return 'Alternation';
    if (/look/i.test(c.l)) return 'Lookaround';
    return 'Quantifiers';
  };
  const grouped = new Map();
  for (const c of REGEX_CONSTRUCTS) {
    const cat = CATEGORY_OF(c);
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat).push(c);
  }
  for (const [cat, list] of grouped) {
    constructsEl.appendChild(h('div', { class: 'rb-cat' }, cat));
    const row = h('div', { class: 'rb-cat-row' });
    for (const c of list) {
      row.appendChild(h('button', {
        type: 'button', class: 'rb-chip', title: `${c.l} — ${c.d}`,
        onclick: () => insertConstruct(c),
      }, c.l));
    }
    constructsEl.appendChild(row);
  }

  const copyBtn = h('button', { type: 'button', class: 'btn-text', onclick: onCopy },
    icon('content_copy', 16), t('rbCopy'));
  const exportBtn = h('button', { type: 'button', class: 'btn-text', onclick: onExport },
    icon('file_download', 16), t('export_'));
  const clearBtn = h('button', { type: 'button', class: 'btn-text', onclick: () => { setPattern(''); } },
    icon('restart_alt', 16), t('reset'));
  const applyBtn = h('button', { type: 'button', class: 'btn-filled', onclick: apply }, t('rbUse'));
  const closeBtn = h('button', {
    type: 'button', class: 'icon-btn', 'aria-label': t('close'), title: t('close'), onclick: () => close(),
  }, icon('close', 18));

  const root = h('div', {
    id: ids.root, class: 'rb-popover surface-3', role: 'dialog', 'aria-modal': 'false',
    'aria-label': opts.title || t('rbTitle'), tabindex: '-1',
  },
  h('header', { class: 'rb-head' },
    icon('code', 18),
    h('div', { class: 'rb-title' },
      h('div', { class: 'rb-title-main' }, opts.title || t('rbTitle')),
      h('div', { class: 'rb-engine' }, t('rbEngine'))),
    closeBtn),
  h('div', { class: 'rb-body' },
    h('label', { class: 'rb-label', for: ids.pattern }, t('rbPattern')),
    h('div', { class: 'rb-pattern-row' },
      h('span', { class: 'rb-slash mono', 'aria-hidden': 'true' }, '/'),
      patternInput,
      h('span', { class: 'rb-slash mono', 'aria-hidden': 'true' }, '/'),
      h('span', { class: 'rb-flagview mono', 'aria-hidden': 'true' })),
    statusEl,
    h('div', { class: 'rb-section-title' }, t('rbFlags')),
    flagsRow,
    h('div', { class: 'rb-section-title' }, t('rbInsert')),
    constructsEl,
    h('label', { class: 'rb-label', for: ids.sample }, t('rbSample')),
    sampleInput,
    h('div', { class: 'rb-section-title' }, t('rbMatches')),
    previewEl,
    groupsEl),
  h('footer', { class: 'rb-foot' }, clearBtn, copyBtn, exportBtn, h('div', { class: 'spacer' }), applyBtn));

  appearanceTarget(root, 'regex-builder', 'Regex builder');
  const flagView = root.querySelector('.rb-flagview');

  layer('popover').appendChild(root);
  const anchoring = anchorTo(root, opts.anchor, { placement: opts.placement || 'bottom-start', gap: 8, onDetach: () => close() });
  const untrap = trapFocus(root);

  /* ---------- behaviour ---------- */

  function toggleFlag(f) {
    flags = flags.includes(f) ? flags.split('').filter((c) => c !== f).join('') : flags + f;
    flagButtons.get(f)?.setAttribute('aria-pressed', String(flags.includes(f)));
    schedule();
  }

  function insertAtCursor(text, selectOffset) {
    const start = patternInput.selectionStart ?? patternInput.value.length;
    const end = patternInput.selectionEnd ?? start;
    const selected = patternInput.value.slice(start, end);
    const before = patternInput.value.slice(0, start);
    const after = patternInput.value.slice(end);
    const insert = selected && text.includes('()') ? text.replace('()', `(${selected})`) : text;
    patternInput.value = before + insert + after;
    const caret = before.length + (selectOffset != null ? selectOffset : insert.length);
    patternInput.focus();
    patternInput.setSelectionRange(caret, caret);
    pattern = patternInput.value;
    schedule();
  }

  function insertConstruct(c) {
    if (c.prompt) {
      // "Text (escaped)" — take the current selection, or ask for the literal.
      const start = patternInput.selectionStart ?? 0, end = patternInput.selectionEnd ?? 0;
      const selected = patternInput.value.slice(start, end);
      const literal = selected || window.prompt('Literal text to match (it will be escaped):', '');
      if (literal == null) return;
      const escaped = escapeLiteral(literal);
      if (selected) {
        patternInput.value = patternInput.value.slice(0, start) + escaped + patternInput.value.slice(end);
        pattern = patternInput.value;
        patternInput.focus();
        patternInput.setSelectionRange(start + escaped.length, start + escaped.length);
        schedule();
      } else insertAtCursor(escaped);
      return;
    }
    const raw = c.raw || c.ins;
    // Place the caret inside a group rather than after it.
    const inner = raw.indexOf(')') > 0 ? raw.indexOf(')') : null;
    insertAtCursor(raw, inner);
  }

  function currentValidity() {
    const c = compile(patternInput.value, flags);
    return c;
  }

  function renderStatus(result) {
    statusEl.textContent = '';
    statusEl.classList.remove('is-error', 'is-warn', 'is-ok');
    const c = currentValidity();
    if (!patternInput.value) {
      statusEl.classList.add('is-ok');
      statusEl.append(icon('info', 14), h('span', {}, 'Empty pattern — everything matches. Type or use Build below.'));
      return;
    }
    if (!c.ok) {
      statusEl.classList.add('is-error');
      statusEl.append(icon('error', 14), h('span', {}, `Invalid pattern: ${c.error}`));
      return;
    }
    if (result?.timedOut) {
      statusEl.classList.add('is-error');
      statusEl.append(icon('warning', 14), h('span', {},
        `Runaway pattern — evaluation was stopped after ${TIME_BUDGET_MS} ms. This pattern backtracks catastrophically on this sample; simplify a nested quantifier such as (a+)+ before using it.`));
      return;
    }
    if (backtrackingRisk(patternInput.value)) {
      statusEl.classList.add('is-warn');
      statusEl.append(icon('warning', 14), h('span', {},
        'Valid, but this shape (a quantifier applied to a group that already repeats) can backtrack catastrophically on longer input.'));
      return;
    }
    statusEl.classList.add('is-ok');
    const n = result ? result.matches.length : 0;
    const capped = result?.truncated ? ` (first ${MAX_MATCHES} shown)` : '';
    statusEl.append(icon('check_circle', 14), h('span', {},
      `Valid. ${n} ${n === 1 ? 'match' : 'matches'}${capped} in ${result ? Math.round(result.elapsedMs) : 0} ms.`));
  }

  function renderPreview(result) {
    previewEl.textContent = '';
    groupsEl.textContent = '';
    const text = sampleInput.value.slice(0, MAX_SAMPLE);
    if (!result || !result.ok || !result.matches.length) {
      previewEl.appendChild(h('span', { class: 'rb-plain' }, text || '(no sample text)'));
      if (result && result.ok && patternInput.value && !result.timedOut) {
        groupsEl.appendChild(h('div', { class: 'rb-nomatch' }, t('rbNoMatch')));
      }
      return;
    }
    let cursor = 0;
    result.matches.forEach((m, i) => {
      if (m.start > cursor) previewEl.appendChild(h('span', { class: 'rb-plain' }, text.slice(cursor, m.start)));
      const cls = m.end === m.start ? 'rb-hit rb-zero' : 'rb-hit';
      previewEl.appendChild(h('mark', { class: cls, 'data-m': String(i), title: `Match ${i + 1}` },
        m.end === m.start ? '​' : text.slice(m.start, m.end)));
      cursor = Math.max(cursor, m.end);
    });
    if (cursor < text.length) previewEl.appendChild(h('span', { class: 'rb-plain' }, text.slice(cursor)));

    const withGroups = result.matches.filter((m) => m.groups.length || m.named.length);
    if (withGroups.length) {
      groupsEl.appendChild(h('div', { class: 'rb-groups-title' }, t('rbGroups')));
      withGroups.slice(0, 20).forEach((m, i) => {
        const row = h('div', { class: 'rb-group-row' }, h('span', { class: 'rb-group-idx' }, `#${i + 1}`));
        m.groups.forEach((g) => {
          row.appendChild(h('span', { class: 'rb-group' },
            h('span', { class: 'rb-group-name' }, String(g.index)),
            h('span', { class: 'rb-group-val mono' }, g.value === null ? '(unmatched)' : g.value || '(empty)')));
        });
        m.named.forEach((g) => {
          row.appendChild(h('span', { class: 'rb-group is-named' },
            h('span', { class: 'rb-group-name' }, g.name),
            h('span', { class: 'rb-group-val mono' }, g.value === null ? '(unmatched)' : g.value || '(empty)')));
        });
        groupsEl.appendChild(row);
      });
      if (withGroups.length > 20) groupsEl.appendChild(h('div', { class: 'rb-nomatch' }, `…and ${withGroups.length - 20} more.`));
    }
  }

  let scheduleTimer = 0;
  function schedule() {
    pattern = patternInput.value;
    sample = sampleInput.value;
    flagView.textContent = flags;
    const c = currentValidity();
    opts.onChange?.({ pattern, flags, valid: c.ok, error: c.error });
    clearTimeout(scheduleTimer);
    scheduleTimer = setTimeout(run, 130);
    renderStatus(lastResult && c.ok ? null : lastResult);
  }

  async function run() {
    const token = ++evalToken;
    const result = await evaluate(patternInput.value, flags, sampleInput.value);
    if (token !== evalToken || !root.isConnected) return;
    lastResult = result;
    renderStatus(result);
    renderPreview(result);
    if (result.timedOut) announce('Runaway regular expression stopped. Simplify the pattern.', true);
  }

  async function onCopy() {
    const ok = await copyText(`/${patternInput.value}/${flags}`);
    announce(ok ? 'Pattern copied to the clipboard.' : 'Copy failed.');
  }

  function onExport() {
    const payload = {
      engine: ENGINE_NAME,
      pattern: patternInput.value,
      flags,
      sample: sampleInput.value.slice(0, MAX_SAMPLE),
      matches: (lastResult?.matches || []).map((m) => ({ start: m.start, end: m.end, value: m.value, groups: m.groups, named: m.named })),
      exportedAt: new Date().toISOString(),
    };
    downloadText('regex-pattern.json', JSON.stringify(payload, null, 2));
    announce('Pattern exported.');
  }

  function apply() {
    const c = currentValidity();
    if (!c.ok) { announce(`Cannot apply: ${c.error}`, true); patternInput.focus(); return; }
    opts.onApply?.({ pattern: patternInput.value, flags });
    close();
  }

  function setPattern(next) { patternInput.value = next ?? ''; schedule(); }
  function setFlags(next) {
    flags = next || '';
    for (const [f, b] of flagButtons) b.setAttribute('aria-pressed', String(flags.includes(f)));
    schedule();
  }
  function setSample(next) { sampleInput.value = next ?? ''; schedule(); }

  patternInput.addEventListener('input', schedule);
  sampleInput.addEventListener('input', schedule);
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    else if (e.key === 'Enter' && e.target === patternInput) { e.preventDefault(); apply(); }
  });

  function onDocPointer(e) {
    if (root.contains(e.target) || opts.anchor.contains(e.target)) return;
    close();
  }
  setTimeout(() => document.addEventListener('pointerdown', onDocPointer, true), 0);

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    openBuilders.delete(handle);
    document.removeEventListener('pointerdown', onDocPointer, true);
    clearTimeout(scheduleTimer);
    evalToken += 1;
    untrap();
    anchoring.dispose();
    root.remove();
    opts.onClose?.();
    restoreFocus();
  }

  const handle = { close, element: root, setPattern, setFlags, setSample, get pattern() { return patternInput.value; }, get flags() { return flags; } };
  openBuilders.add(handle);

  flagView.textContent = flags;
  patternInput.focus();
  patternInput.select();
  schedule();
  return handle;
}

/* ------------------------------------------------------------------ */
/* matcher shared with search bars                                     */
/* ------------------------------------------------------------------ */

/**
 * Build a predicate for a query. This is THE match predicate — the bulk-close
 * actions and their inverse both call it, so flags, casing, Unicode handling
 * and scope can never drift between "containing" and "not containing".
 *
 * mode: 'text' (default, case-insensitive substring) or 'regex'.
 * Returns { ok, error, test(value) }.
 */
export function makePredicate({ query = '', pattern = '', flags = '', mode = 'text' } = {}) {
  if (mode === 'regex') {
    const f = flags.replace(/g/g, '');            // a shared regex must not carry lastIndex
    const c = compile(pattern, f);
    if (!c.ok) return { ok: false, error: c.error, test: () => false };
    // A predicate runs SYNCHRONOUSLY, once per field per item, on the UI
    // thread — there is no Worker to terminate and no deadline to check, so a
    // catastrophically backtracking pattern here is an unkillable hang, not a
    // slow search. evaluate() has the Worker; the search path does not, so a
    // pattern of a known runaway shape is refused with the reason rather than
    // run. The builder's preview still evaluates it safely, which is where a
    // user can see what it does before asking a search to use it.
    if (backtrackingRisk(pattern)) {
      return { ok: false, error: RUNAWAY_REFUSAL, mode: 'regex', describe: `/${pattern}/${f}`, test: () => false };
    }
    return { ok: true, error: null, mode: 'regex', describe: `/${pattern}/${f}`, test: (v) => c.regex.test(String(v ?? '')) };
  }
  const needle = String(query || '').toLocaleLowerCase();
  return {
    ok: true, error: null, mode: 'text', describe: `contains "${query}"`,
    test: (v) => String(v ?? '').toLocaleLowerCase().includes(needle),
  };
}

export { clamp };
