// consumer-scan.js — "does anything actually READ this preference?"
//
// test/preferences.test.js holds design/renderer/ui/dialogs/prefpages.js's
// PENDING_KEYS — the options the dialog tells the user nothing acts on — to
// exactly the set of options nothing reads. That assertion is only worth as
// much as this scan, and the scan has been wrong twice in the same direction:
// it counted a mention that was not a read, so a dead option looked honoured
// and its row stopped warning anybody.
//
//   1. It walked `test/` as well as `design/`. test/preferences.test.js is the
//      file that asserts every one of these keys by name — `mustCover` lists
//      them, `controlEnabled` exercises them — so the guard was reading its own
//      subject matter back as proof. Eight options (beepOnFinish,
//      beepOnFinishAfter, refreshRemotePanelInterval, queue.keepDoneItemsFor,
//      window.minimizeToTray, dDFakeFile, dDDrives and
//      integration.dragExtEnabled) were stored, rendered and read by nothing,
//      and the guard was green. A test EXERCISES a consumer; it never IS one,
//      so the corpus is production code only.
//   2. It matched inside comments. `editor.warnOrphans`,
//      `security.sessionReopenBackground` and `security.sessionReopenAutoStall`
//      were each named in one doc comment and nowhere else —
//      editors.js:589 and session.js:532-537 describe them as if they were
//      honoured, while _scheduleReconnect reads only sessionReopenAuto and
//      sessionReopenTimeout. A comment is a promise, not a read.
//
// So a consumer here means: production code under design/, outside the
// preferences surface itself, that names the key in CODE — comments stripped,
// and a mention inside a prose string (a changelog entry, a label, a log line)
// discounted the same way a comment is. `readPref('showHiddenFiles')` still
// counts, because a string that is exactly the key is how a consumer names one.
//
// The opposite error is the expensive one. A consumer that reads the key in a
// shape this scan cannot see gets called an orphan, the honest-looking fix is
// to declare it pending, and the dialog then tells the user a working option
// does nothing. The leaf rule is therefore deliberately permissive INSIDE code:
// any word-boundary occurrence counts, so destructuring, `o.leaf`,
// `this.prefs().leaf`, `{ leaf }` across lines and `LEAF_MAP = { leaf: … }` are
// all consumers without the scan having to parse JavaScript.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

/**
 * Files that DECLARE, RENDER or PERSIST an option rather than act on it. A
 * mention from one of these proves nothing: they are the preferences surface
 * and the store behind it, which is exactly what the guard is asking about.
 */
const SURFACE = new Set([
  'prefpages.js', 'preferences.js', 'copyparams.js', 'editorpreferences.js',
  'customcommand.js', 'defaults.js',
]);

/** The shipped application. Not `test/`, and not `tools/` or `build/`. */
function productionRoots(repo) {
  return [path.join(repo, 'design')];
}

/** Every production .js file the scan reads, absolute paths. */
function productionFiles(repo, roots = productionRoots(repo)) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.js') && !SURFACE.has(entry.name)) out.push(p);
    }
  };
  roots.forEach(walk);
  return out;
}

/**
 * A `/` that begins a regular expression rather than a division. Decided from
 * the last significant thing already emitted, which is the standard heuristic:
 * after a value (identifier, number, `)`, `]`) a slash divides; after an
 * operator, a punctuator or one of the keywords that can be followed by an
 * expression it opens a pattern.
 *
 * This matters more than it looks. A class like `/['"]/` carries a lone quote,
 * and a scanner that reads it as the start of a string swallows everything up
 * to the next quote — hundreds of lines of real code, with every preference
 * read inside them. That is precisely how an earlier draft of this scan lost
 * `editor.singleEditor` (editors.js:218), `editor.maxEditors` (editors.js:227),
 * `logging.logFileAppend` (logging.js:249) and
 * `integration.externalSessionInExistingInstance` (setup.js:1052) — four
 * options that are read, and were about to be reported as read by nothing.
 */
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'case',
  'do', 'else', 'yield', 'await', 'new', 'delete', 'void', 'throw']);
const WORD = /[A-Za-z0-9_$]/;
function slashStartsRegex(code) {
  let i = code.length - 1;
  while (i >= 0 && /\s/.test(code[i])) i -= 1;
  if (i < 0) return true;                       // start of file
  const last = code[i];
  if (last === ')' || last === ']') return false;             // (a + b) / c
  if (!WORD.test(last)) return true;            // = ( , : [ ! & | ? { } ; + - * % ^ ~ < >
  let j = i;
  while (j >= 0 && WORD.test(code[j])) j -= 1;
  return REGEX_KEYWORDS.has(code.slice(j + 1, i + 1));        // `return /x/` but not `n / 2`
}

/**
 * Split a source file into the code a consumer could be hiding in and the
 * string literals it contains.
 *
 * This is a scanner, not a parser: it tracks the six states that matter —
 * code, line comment, block comment, quoted string, template literal and
 * regular expression — and throws the comments away. A regex body is handed
 * back as code, so a key named inside one still counts; that errs towards
 * "honoured", which is the safe direction for a construct nobody writes a
 * preference key into.
 *
 * Returns { code, literals } — `code` with every comment and string body
 * replaced by a space so nothing accidentally joins two identifiers, and
 * `literals` the exact contents of every string and template.
 */
function splitSource(src) {
  let code = '';
  const literals = [];
  let i = 0;
  let mode = 'code';
  let quote = '';
  let buf = '';
  let inClass = false;               // inside a regex [...] character class
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (mode === 'code') {
      if (c === '/' && d === '*') { mode = 'block'; i += 2; code += ' '; continue; }
      if (c === '/' && d === '/') { mode = 'line'; i += 2; continue; }
      if (c === '/' && slashStartsRegex(code)) {
        mode = 'regex'; inClass = false; i += 1; code += ' '; continue;
      }
      if (c === '"' || c === "'" || c === '`') { mode = 'string'; quote = c; buf = ''; i += 1; code += ' '; continue; }
      code += c; i += 1; continue;
    }
    if (mode === 'regex') {
      if (c === '\\') { code += ' '; i += 2; continue; }
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) { mode = 'code'; i += 1; code += ' '; continue; }
      else if (c === '\n') { mode = 'code'; code += '\n'; i += 1; continue; }  // unterminated: it was division after all
      code += c; i += 1; continue;
    }
    if (mode === 'block') {
      if (c === '*' && d === '/') { mode = 'code'; i += 2; continue; }
      i += 1; continue;
    }
    if (mode === 'line') {
      if (c === '\n') { mode = 'code'; code += '\n'; }
      i += 1; continue;
    }
    // mode === 'string'
    if (c === '\\') { buf += src[i + 1] || ''; i += 2; continue; }
    if (c === quote) { mode = 'code'; literals.push(buf); i += 1; code += ' '; continue; }
    // A template's ${…} is code, and a consumer really does write
    // `${prefs.queue.view}` inside one, so the substitution is handed back to
    // the code side while the surrounding prose stays a literal.
    if (quote === '`' && c === '$' && d === '{') {
      let depth = 1; i += 2; code += ' ';
      while (i < src.length && depth > 0) {
        if (src[i] === '{') depth += 1;
        else if (src[i] === '}') depth -= 1;
        if (depth > 0) code += src[i];
        i += 1;
      }
      code += ' ';
      continue;
    }
    buf += c; i += 1;
  }
  return { code, literals };
}

const escapeRe = (s) => Array.from(s)
  .map((ch) => (/[A-Za-z0-9_]/.test(ch) ? ch : `\\${ch}`)).join('');

/**
 * Read every production file once. Returns [{ file, code, literals }] where
 * `file` is repo-relative, so a failure can name where a consumer was found.
 */
function readCorpus(repo, files = productionFiles(repo)) {
  return files.map((f) => {
    const { code, literals } = splitSource(fs.readFileSync(f, 'utf8'));
    return { file: path.relative(repo, f).replace(/\\/g, '/'), code, literals };
  });
}

/**
 * Every corpus file that reads `key` ('queue.keepDoneItemsFor'). A consumer
 * almost never writes the dotted path — it holds the sub-object and reads
 * `qp.keepDoneItemsFor` — so the leaf is what is looked for, at a word
 * boundary that deliberately does NOT exclude a preceding dot.
 */
function consumersOf(key, corpus) {
  const leaf = String(key).split('.').pop();
  const inCode = new RegExp(`(^|[^A-Za-z0-9_])${escapeRe(leaf)}($|[^A-Za-z0-9_])`);
  return corpus
    .filter((f) => inCode.test(f.code)
      || f.literals.some((s) => s === key || s === leaf))
    .map((f) => f.file);
}

/** The keys with no consumer at all, sorted. */
function orphanKeys(keys, corpus) {
  return keys.filter((k) => consumersOf(k, corpus).length === 0).sort();
}

module.exports = {
  SURFACE, productionRoots, productionFiles, readCorpus, splitSource,
  consumersOf, orphanKeys,
};
