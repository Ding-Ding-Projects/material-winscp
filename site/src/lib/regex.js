// lib/regex.js — the engine behind every search bar on the site.
//
// THE ONE PREDICATE. `makePredicate()` returns a single object that a filter
// and its inverse both use. That is not tidiness: the moment "contains" and
// "does not contain" compile their own regexes, their flags, casing and
// Unicode handling drift, and a user gets two filters that disagree about the
// same string. One predicate cannot disagree with itself.
//
// PLAIN TEXT IS THE DEFAULT. `mode: 'text'` is a case-insensitive substring
// test. Regex is opt-in, per the project rule — a user who types `a.b` into a
// search box means a dot, not "any character".
//
// EVALUATION IS BOUNDED. A pattern like /(a+)+$/ against a wall of a's runs for
// longer than the heat death of the tab. JavaScript has no regex timeout, so
// the defence is twofold: refuse the shapes that cause it before running, and
// cap sample size, match count and wall-clock while running. Everything is
// evaluated locally in the visitor's browser; no pattern and no sample text
// ever leaves the page.

/** The real engine, named honestly. The builder tells the user this rather
 *  than letting them assume PCRE and wonder where their lookbehind went. */
export const ENGINE_NAME = 'JavaScript RegExp (ECMAScript, as implemented by this browser)';
export const MAX_SAMPLE = 20000;
export const MAX_MATCHES = 500;
export const TIME_BUDGET_MS = 400;

/** Escape a literal so it matches itself. Used by guided construction and by
 *  the text→regex handoff, so switching a query into the builder keeps meaning
 *  the same thing. */
export function escapeLiteral(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
}

export const FLAGS = [
  { flag: 'g', label: ['Global — every match', '全域——搵晒所有'] },
  { flag: 'i', label: ['Ignore case', '唔理大細楷'] },
  { flag: 'm', label: ['Multiline — ^ and $ per line', '多行——^ 同 $ 逐行計'] },
  { flag: 's', label: ['Dot matches newline', '. 都食換行'] },
  { flag: 'u', label: ['Unicode', 'Unicode'] },
  { flag: 'y', label: ['Sticky — match at lastIndex only', '黐住——淨係喺 lastIndex 度夾'] },
];

/** Guided construction. Each entry inserts a fragment; `wraps` means it wraps
 *  the current selection instead of being dropped at the caret. */
export const CONSTRUCTS = [
  {
    group: ['Literals', '字面'],
    items: [
      { id: 'literal', label: ['Literal text…', '字面文字…'], prompt: true, build: (v) => escapeLiteral(v) },
      { id: 'any', label: ['Any character', '任何字元'], insert: '.' },
      { id: 'tab', label: ['Tab', 'Tab'], insert: '\\t' },
      { id: 'newline', label: ['Newline', '換行'], insert: '\\n' },
    ],
  },
  {
    group: ['Character classes', '字元類'],
    items: [
      { id: 'digit', label: ['Digit', '數字'], insert: '\\d' },
      { id: 'notdigit', label: ['Not a digit', '唔係數字'], insert: '\\D' },
      { id: 'word', label: ['Word character', '字詞字元'], insert: '\\w' },
      { id: 'space', label: ['Whitespace', '空白'], insert: '\\s' },
      { id: 'set', label: ['One of…', '其中一個…'], prompt: true, build: (v) => `[${v.replace(/[\]\\^-]/g, '\\$&')}]` },
      { id: 'notset', label: ['None of…', '一個都唔要…'], prompt: true, build: (v) => `[^${v.replace(/[\]\\^-]/g, '\\$&')}]` },
      { id: 'range', label: ['a-z', 'a-z'], insert: '[a-z]' },
    ],
  },
  {
    group: ['Anchors', '錨點'],
    items: [
      { id: 'start', label: ['Start of line', '行頭'], insert: '^' },
      { id: 'end', label: ['End of line', '行尾'], insert: '$' },
      { id: 'wordb', label: ['Word boundary', '字詞邊界'], insert: '\\b' },
      { id: 'nwordb', label: ['Not a word boundary', '唔係字詞邊界'], insert: '\\B' },
    ],
  },
  {
    group: ['Groups', '群組'],
    items: [
      { id: 'group', label: ['Capture group', '擷取群組'], wraps: true, build: (v) => `(${v || ''})` },
      { id: 'ngroup', label: ['Non-capturing group', '唔擷取群組'], wraps: true, build: (v) => `(?:${v || ''})` },
      { id: 'named', label: ['Named group…', '有名群組…'], prompt: true, wraps: true, build: (v, sel) => `(?<${v.replace(/\W/g, '')}>${sel || ''})` },
      { id: 'ahead', label: ['Followed by', '之後係'], wraps: true, build: (v) => `(?=${v || ''})` },
      { id: 'nahead', label: ['Not followed by', '之後唔係'], wraps: true, build: (v) => `(?!${v || ''})` },
      { id: 'behind', label: ['Preceded by', '之前係'], wraps: true, build: (v) => `(?<=${v || ''})` },
    ],
  },
  {
    group: ['Alternation', '選擇'],
    items: [
      { id: 'or', label: ['Either / or', '或者'], insert: '|' },
      { id: 'oneof', label: ['One of these words…', '呢啲字其中一個…'], prompt: true,
        build: (v) => `(?:${v.split(/[,\s]+/).filter(Boolean).map(escapeLiteral).join('|')})` },
    ],
  },
  {
    group: ['Quantifiers', '數量'],
    items: [
      { id: 'opt', label: ['Optional (0 or 1)', '可有可無 (0 或 1)'], insert: '?' },
      { id: 'star', label: ['0 or more', '0 個或以上'], insert: '*' },
      { id: 'plus', label: ['1 or more', '1 個或以上'], insert: '+' },
      { id: 'lazy', label: ['Lazy (as few as possible)', '懶惰（越少越好）'], insert: '?' },
      { id: 'exactly', label: ['Exactly n…', '啱啱 n 個…'], prompt: true, build: (v) => `{${parseInt(v, 10) || 1}}` },
      { id: 'between', label: ['Between n and m…', 'n 到 m 個…'], prompt: true,
        build: (v) => { const [a, b] = String(v).split(/\D+/).filter(Boolean); return `{${a || 0},${b || ''}}`; } },
    ],
  },
];

/** Compile without throwing. `{ ok, re }` or `{ ok:false, error }`. */
export function compile(pattern, flags) {
  try {
    return { ok: true, re: new RegExp(pattern, flags) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export const RUNAWAY_REFUSAL =
  'nested quantifier — this shape can take exponential time on the wrong input, '
  + 'so it is refused rather than left to hang the page.';

/**
 * Refuse catastrophic backtracking BEFORE running it.
 *
 * Two shapes are refused, and both are the classic exponential one:
 *
 *   1. a quantified group containing a quantifier — (a+)+, (\w*)+, (x{2})+ —
 *      where the engine can split the same input between the inner and outer
 *      repetitions in exponentially many ways;
 *   2. a quantified group containing an ALTERNATION — (a|aa)*, (\w|\w\w)+ —
 *      where two branches can match overlapping input, giving the engine the
 *      same exponential choice by a different route. Missing this one is easy
 *      and expensive: (a|aa)*b against a run of a's hangs just as hard as
 *      (a+)+$ does, and contains no nested quantifier at all.
 *
 * This is a heuristic, not a decision procedure. It refuses patterns that would
 * in fact have been fine — (?:ab|cd)+ is linear and is refused anyway — and
 * that trade is deliberate: a false refusal is a sentence the user can read and
 * work around, a false accept is a frozen tab with no way back. The single
 * exception is a group whose branches are all one character wide ((a|b)+),
 * which cannot overlap and is common enough that refusing it would be noise.
 */
export function backtrackingRisk(pattern) {
  const src = String(pattern);
  const stack = [];
  const top = () => stack[stack.length - 1];

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { i++; continue; }
    if (c === '[') {
      // A character class is opaque: |, + and * inside it are literals.
      while (i < src.length && src[i] !== ']') { if (src[i] === '\\') i++; i++; }
      if (top()) top().branch += 2;                 // treat a class as "wide enough"
      continue;
    }
    if (c === '(') { stack.push({ inner: false, alt: false, wide: false, branch: 0 }); continue; }
    if (c === ')') {
      const g = stack.pop();
      if (!g) continue;
      if (g.branch > 1) g.wide = true;
      const next = src[i + 1];
      const quantified = next === '+' || next === '*' || (next === '{' && /^\{\d/.test(src.slice(i + 1)));
      if (quantified && (g.inner || (g.alt && g.wide))) return RUNAWAY_REFUSAL;
      // A quantified group is itself a quantifier as far as its parent is
      // concerned, which is what makes ((a+)+)+ and ((a|aa)*)* caught too.
      if (top() && quantified) top().inner = true;
      continue;
    }
    if (!top()) continue;
    if (c === '|') { top().alt = true; if (top().branch > 1) top().wide = true; top().branch = 0; continue; }
    if (c === '+' || c === '*' || (c === '{' && /^\{\d/.test(src.slice(i)))) { top().inner = true; continue; }
    if (c === '?') continue;                         // laziness/optionality is not width
    top().branch++;
  }
  return null;
}

/**
 * Run a pattern over sample text under a wall-clock budget.
 *
 * Zero-width matches are the trap here: a pattern of `a` followed by a star,
 * run globally over "bbb", matches empty at every position and — without the
 * lastIndex nudge below — at the SAME position forever. Reporting the empty
 * match honestly (and moving on) is what lets the builder show a user why
 * their pattern "matches everything".
 */
export function evaluate(pattern, flags, sample, opts = {}) {
  const maxMatches = opts.maxMatches ?? MAX_MATCHES;
  const budget = opts.timeBudget ?? TIME_BUDGET_MS;
  const now = opts.now || (() => Date.now());

  if (!pattern) return { ok: true, matches: [], truncated: false, empty: true };

  const risk = backtrackingRisk(pattern);
  if (risk) return { ok: false, runaway: true, error: risk, matches: [] };

  const text = String(sample ?? '').slice(0, MAX_SAMPLE);
  const c = compile(pattern, flags.includes('g') ? flags : `${flags}g`);
  if (!c.ok) return { ok: false, error: c.error, matches: [] };

  const re = c.re;
  const matches = [];
  const started = now();
  let truncated = false;
  let timedOut = false;
  let m;

  re.lastIndex = 0;
  while ((m = re.exec(text)) !== null) {
    matches.push({
      index: m.index,
      text: m[0],
      empty: m[0].length === 0,
      groups: m.slice(1).map((g, i) => ({ n: i + 1, text: g === undefined ? null : g })),
      named: m.groups ? { ...m.groups } : null,
    });
    if (m[0] === '') re.lastIndex++;          // never spin on a zero-width match
    if (matches.length >= maxMatches) { truncated = true; break; }
    if (now() - started > budget) { timedOut = true; truncated = true; break; }
    if (!re.global) break;
  }

  return {
    ok: true,
    matches,
    truncated,
    timedOut,
    sampleTruncated: String(sample ?? '').length > MAX_SAMPLE,
    ms: now() - started,
  };
}

/**
 * THE match predicate — one object for a filter and its inverse.
 *
 * `describe` exists so a UI can state what will happen in words before it
 * happens ("contains \"report\"", "matches /^q[1-4]/i"), which is what makes a
 * bulk action reviewable instead of a leap of faith.
 */
export function makePredicate({ query = '', pattern = '', flags = '', mode = 'text' } = {}) {
  if (mode === 'regex') {
    const src = pattern || query;
    if (!src) return { ok: false, mode, empty: true, describe: 'no pattern', test: () => false };
    const risk = backtrackingRisk(src);
    if (risk) return { ok: false, mode, error: risk, runaway: true, describe: 'refused pattern', test: () => false };
    // The predicate never uses /g: a sticky lastIndex makes .test() alternate
    // true/false on the same string, which is the single most confusing bug a
    // search box can have.
    const c = compile(src, flags.replace(/[gy]/g, ''));
    if (!c.ok) return { ok: false, mode, error: c.error, describe: 'invalid pattern', test: () => false };
    return {
      ok: true, mode, source: src, flags,
      describe: `matches /${src}/${flags.replace(/[gy]/g, '')}`,
      // The negated wording is carried, not assembled. Prefixing "does not " to
      // an already-conjugated verb produces "does not matches" / "does not
      // contains", which appears in a destructive confirmation dialog — the one
      // place the copy has to read like a sentence somebody wrote on purpose.
      describeNot: `does not match /${src}/${flags.replace(/[gy]/g, '')}`,
      test: (s) => c.re.test(String(s ?? '')),
    };
  }

  const needle = String(query ?? '');
  if (!needle) return { ok: false, mode: 'text', empty: true, describe: 'no text', test: () => false };
  const lower = needle.toLowerCase();
  return {
    ok: true, mode: 'text', source: needle,
    describe: `contains "${needle}"`,
    describeNot: `does not contain "${needle}"`,
    test: (s) => String(s ?? '').toLowerCase().includes(lower),
  };
}

/** The inverse of a predicate, built from the SAME object so the two cannot
 *  drift. An unusable predicate stays unusable inverted — refusing to run is
 *  not the same as "matches nothing", and inverting it would close every tab. */
export function invert(pred) {
  if (!pred.ok) return pred;
  return {
    ...pred,
    describe: pred.describeNot,
    describeNot: pred.describe,
    inverted: true,
    test: (s) => !pred.test(s),
  };
}
