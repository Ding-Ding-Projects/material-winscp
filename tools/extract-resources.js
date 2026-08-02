// extract-resources.js — build the message table from WinSCP's own string tables.
//
// Every sentence WinSCP shows a user — every error, every confirmation, every
// caption, every refusal — lives in source/resource/*.rc as a Win32
// STRINGTABLE, with the numeric identifiers in the matching *.h. That is the
// actual wording of the application, so the port generates its message table
// from it rather than inventing English next to a C++ file that already had
// the sentence written.
//
// Nine units feed this extractor, which is the whole of source/resource/:
//
//   TextsCore1.rc  TextsCore2.rc  TextsWin1.rc  TextsFileZilla.rc  Propagation.rc
//   TextsCore.h    TextsWin.h     TextsFileZilla.h        (the numeric ids)
//   HelpCore.h     HelpWin.h                              (the help keywords)
//
// Run: node tools/extract-resources.js
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'vendor', 'winscp', 'source', 'resource');
const OUT = path.join(__dirname, '..', 'design', 'renderer', 'messages.json');

/** The .rc files that carry STRINGTABLEs, in the order WinSCP links them. */
const RC_FILES = [
  'TextsCore1.rc',
  'TextsCore2.rc',
  'TextsWin1.rc',
  'TextsFileZilla.rc',
  'Propagation.rc',
];

/** Headers mapping a symbolic id to the numeric resource id LoadStr() takes. */
const ID_HEADERS = ['TextsCore.h', 'TextsWin.h', 'TextsFileZilla.h'];

/** Headers mapping a symbolic id to an online documentation topic. */
const HELP_HEADERS = ['HelpCore.h', 'HelpWin.h'];

/* ------------------------------------------------------------------ */
/* preprocessing                                                       */
/* ------------------------------------------------------------------ */

/**
 * Drop `#if 0 … #endif` regions. TextsFileZilla.h keeps FileZilla's original
 * MFC identifiers inside such blocks; treating them as live would map WinSCP
 * ids onto numbers the resource compiler never emitted.
 *
 * Nesting is tracked, and `#else` inside a disabled block re-enables it the way
 * the C preprocessor does, so a `#if 0 … #else … #endif` pair keeps its second
 * half.
 */
function stripDisabledRegions(text) {
  const lines = text.split(/\r?\n/);
  const kept = [];
  // Each frame is { taken } — whether the branch currently open is compiled.
  const stack = [];
  const live = () => stack.every((f) => f.taken);

  for (const line of lines) {
    const directive = /^\s*#\s*(if|ifdef|ifndef|elif|else|endif)\b(.*)$/.exec(line);
    if (directive) {
      const [, kind, rest] = directive;
      if (kind === 'if' || kind === 'ifdef' || kind === 'ifndef') {
        // Only a literal `#if 0` is treated as dead; everything else is live,
        // because we are reading declarations, not compiling a program.
        stack.push({ taken: !(kind === 'if' && /^\s*0\s*$/.test(rest)) });
      } else if (kind === 'else' || kind === 'elif') {
        if (stack.length) stack[stack.length - 1].taken = !stack[stack.length - 1].taken;
      } else if (kind === 'endif') {
        stack.pop();
      }
      kept.push('');                       // keep line numbers stable for errors
      continue;
    }
    kept.push(live() ? line : '');
  }
  return kept.join('\n');
}

/* ------------------------------------------------------------------ */
/* headers                                                             */
/* ------------------------------------------------------------------ */

/**
 * `#define NAME value`, where value is a number, another NAME (HelpCore.h
 * aliases several topics onto one another), or a quoted string.
 */
function parseDefines(text) {
  const out = new Map();
  for (const line of stripDisabledRegions(text).split('\n')) {
    const m = /^\s*#\s*define\s+([A-Za-z_]\w*)\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const [, name, raw] = m;
    // A trailing comment is not part of the value.
    const value = raw.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '').trim();
    if (!value) continue;
    out.set(name, value);
  }
  return out;
}

/** Resolve `#define A B` chains down to the literal they eventually name. */
function resolveDefine(defines, name, seen = new Set()) {
  if (seen.has(name)) return null;         // a cycle is a broken header, not a value
  seen.add(name);
  const raw = defines.get(name);
  if (raw === undefined) return null;
  if (/^"/.test(raw)) return { kind: 'string', value: decodeCString(raw.slice(1, -1)) };
  if (/^-?\d+$/.test(raw)) return { kind: 'number', value: Number(raw) };
  if (/^0x[0-9a-fA-F]+$/.test(raw)) return { kind: 'number', value: Number(raw) };
  if (/^[A-Za-z_]\w*$/.test(raw)) return resolveDefine(defines, raw, seen);
  return null;
}

/* ------------------------------------------------------------------ */
/* the .rc tokenizer                                                   */
/* ------------------------------------------------------------------ */

/**
 * Decode the escapes a Win32 resource string may contain. `\n` is by far the
 * most common (WinSCP builds multi-paragraph messages with it), `\"` appears
 * wherever a message quotes a server name, and `\\` in the proxy-command hint.
 */
function decodeCString(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw[i];
    if (c !== '\\') {
      // RC also accepts a doubled quote as one literal quote.
      if (c === '"' && raw[i + 1] === '"') { out += '"'; i += 1; continue; }
      out += c;
      continue;
    }
    const n = raw[i + 1];
    i += 1;
    switch (n) {
      case 'n': out += '\n'; break;
      case 'r': out += '\r'; break;
      case 't': out += '\t'; break;
      case 'a': out += '\x07'; break;
      case 'b': out += '\b'; break;
      case 'f': out += '\f'; break;
      case 'v': out += '\v'; break;
      case '\\': out += '\\'; break;
      case '"': out += '"'; break;
      case "'": out += "'"; break;
      case '?': out += '?'; break;
      case 'x': {
        const hex = /^[0-9a-fA-F]{1,4}/.exec(raw.slice(i + 1));
        if (hex) { out += String.fromCharCode(parseInt(hex[0], 16)); i += hex[0].length; }
        else out += 'x';
        break;
      }
      default: {
        const oct = /^[0-7]{1,3}/.exec(raw.slice(i));
        if (oct) { out += String.fromCharCode(parseInt(oct[0], 8)); i += oct[0].length - 1; }
        else out += n === undefined ? '\\' : n;
      }
    }
  }
  return out;
}

/**
 * Tokenize a resource script. Comments must be skipped by the tokenizer rather
 * than by a line-level regex: TextsCore1.rc stores documentation URLs, and
 * `https://winscp.net/` looks exactly like a `//` comment to anything that does
 * not know it is inside a string literal.
 */
function tokenize(text) {
  const tokens = [];
  let i = 0;
  const n = text.length;

  while (i < n) {
    const c = text[i];

    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { i += 1; continue; }

    if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (c === '#') {                       // a surviving directive (#include, #define)
      while (i < n && text[i] !== '\n') {
        if (text[i] === '\\' && text[i + 1] === '\n') i += 1;  // line continuation
        i += 1;
      }
      continue;
    }

    if (c === '"') {
      let raw = '';
      i += 1;
      while (i < n) {
        if (text[i] === '\\') { raw += text[i] + (text[i + 1] ?? ''); i += 2; continue; }
        if (text[i] === '"') {
          if (text[i + 1] === '"') { raw += '""'; i += 2; continue; }  // escaped quote
          break;
        }
        raw += text[i];
        i += 1;
      }
      i += 1;                              // the closing quote
      tokens.push({ type: 'string', value: decodeCString(raw) });
      continue;
    }

    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_]/.test(text[j])) j += 1;
      tokens.push({ type: 'ident', value: text.slice(i, j) });
      i = j;
      continue;
    }

    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < n && /[0-9a-fA-FxX]/.test(text[j])) j += 1;
      tokens.push({ type: 'number', value: text.slice(i, j) });
      i = j;
      continue;
    }

    tokens.push({ type: 'punct', value: c });
    i += 1;
  }
  return tokens;
}

/**
 * Walk the tokens and pull every STRINGTABLE entry out. An entry is
 * `ID , "text"` where the text may be several adjacent literals — TextsCore2.rc
 * writes every scripting help topic as one literal per displayed line.
 */
function parseRc(text, file) {
  const tokens = tokenize(stripDisabledRegions(text));
  const entries = [];
  let inTable = false;
  let pendingTable = false;
  let depth = 0;

  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];

    if (t.type === 'ident' && t.value === 'STRINGTABLE') { pendingTable = true; continue; }
    if (t.type === 'ident' && t.value === 'BEGIN') {
      depth += 1;
      if (pendingTable) { inTable = true; pendingTable = false; }
      continue;
    }
    if (t.type === 'ident' && t.value === 'END') {
      depth -= 1;
      if (depth <= 0) { inTable = false; depth = Math.max(0, depth); }
      continue;
    }
    // STRINGTABLE may carry attributes (DISCARDABLE, LANGUAGE …) before BEGIN.
    if (pendingTable) continue;
    if (!inTable) continue;

    if (t.type !== 'ident' && t.type !== 'number') continue;
    const next = tokens[i + 1];
    if (!next || next.type !== 'punct' || next.value !== ',') continue;

    let j = i + 2;
    const parts = [];
    while (j < tokens.length && tokens[j].type === 'string') { parts.push(tokens[j].value); j += 1; }
    if (!parts.length) continue;           // not a string entry after all

    entries.push({ name: t.value, text: parts.join(''), file });
    i = j - 1;
  }
  return entries;
}

/* ------------------------------------------------------------------ */
/* the parameter shape of a message                                    */
/* ------------------------------------------------------------------ */

/**
 * The conversions WinSCP's texts actually use. Deliberately narrow: Delphi's
 * Format also accepts `%p` and `%m`, but accepting them here would read the
 * documentation line "%port expands to port number" as a parameter slot.
 */
const CONVERSIONS = {
  s: 'string', d: 'integer', i: 'integer', u: 'unsigned',
  x: 'hex', X: 'hex', o: 'octal',
  e: 'float', E: 'float', f: 'float', g: 'float', G: 'float',
  c: 'char',
};

const POSITIONAL = /^%(?:(\d+):)?([-+ #0]*)(\d+|\*)?(?:\.(\d+|\*))?([a-zA-Z])/;
const NAMED = /^%([A-Z][A-Z0-9_]*)%/;

/**
 * Describe every substitution slot in a message, in the order it appears.
 *
 * Three shapes exist in WinSCP's resources and all three are real:
 *   `%%`          a literal percent sign (…(%%PATH%%)… renders as (%PATH%))
 *   `%NAME%`      replaced by name with ReplaceStr, e.g. NET_TRANSL_TIMEOUT2
 *   `%s` / `%d`   Delphi Format, optionally with an explicit `%0:d` index
 */
function analyseParams(text) {
  const params = [];
  let auto = 0;                            // Delphi's implicit argument cursor

  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '%') continue;
    const rest = text.slice(i);

    if (rest.startsWith('%%')) { i += 1; continue; }

    const named = NAMED.exec(rest);
    if (named) {
      params.push({ kind: 'named', name: named[1], token: named[0] });
      i += named[0].length - 1;
      continue;
    }

    const pos = POSITIONAL.exec(rest);
    if (pos && CONVERSIONS[pos[5]]) {
      const explicit = pos[1] === undefined ? null : Number(pos[1]);
      const index = explicit === null ? auto : explicit;
      auto = index + 1;
      params.push({
        kind: CONVERSIONS[pos[5]],
        token: pos[0],
        index,
        explicit: explicit !== null,
        conversion: pos[5],
        width: pos[3] ? Number(pos[3]) : null,
        precision: pos[4] ? Number(pos[4]) : null,
      });
      i += pos[0].length - 1;
    }
  }
  return params;
}

/**
 * Messages whose percent signs are documentation, not substitution slots.
 * LOGIN_PROXY_COMMAND_PATTERNS_HINT lists the patterns a proxy command may use
 * ("%user expands to proxy username"), and WinSCP reads it with LoadStr, never
 * Format — so "%u" there is four literal characters, not an unsigned argument.
 * Verified against windows/WinConfiguration.cpp and forms/Login.cpp.
 */
const LITERAL_PERCENT_IDS = new Set(['LOGIN_PROXY_COMMAND_PATTERNS_HINT']);

/**
 * The one place this extractor deliberately does not reproduce WinSCP.
 *
 * WinSCP asks its users for money — a donation form gates automatic updates,
 * and a Microsoft Store link carries a campaign id. This port does not ship
 * promotional asks (Ding-Ding-Projects/material-winscp#22), and test/no-nags.js
 * states the hard form of that rule: the donation URL must not exist anywhere
 * in the shipping app. design/renderer/messages.json is in the shipping app, so
 * these strings are withheld from it rather than carried as inert data that
 * somebody re-surfaces later.
 *
 * They are named here, with the reason, so the ledger records a decision and
 * not an oversight — the same treatment DonatePageAction gets in the command
 * registry, where it stays registered but permanently hidden. The reason text
 * never repeats the string or the URL being excluded.
 */
const POLICY_EXCLUDED = new Map([
  ['DONATE_URL', 'a donation link — the port ships no promotional asks (#22)'],
  ['UPDATES_DONATE_HTML', 'asks for a donation to unlock automatic updates (#22)'],
  ['UPDATE_MISSING_ADDRESS2', 'directs the user to a donation form (#22)'],
  ['UPDATE_TOO_LOW', 'tells the user their donation was too small (#22)'],
  ['STORE_URL', 'a store purchase link carrying a campaign id (#22)'],
  ['STORE_GET_IMG_URL', 'the store purchase badge image (#22)'],
  ['STORE_BUYING', 'asks the user to buy the application (#22)'],
]);

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

/**
 * True when vendor/winscp is checked out far enough to rebuild the table.
 *
 * .github/workflows/ci.yml checks out with `submodules: false` — the vendored
 * WinSCP tree is the porting reference, not a build input, and it is large. So
 * "the source is absent" is a routine, expected state on the machine that runs
 * the suite, and callers need to be able to ask about it rather than discover
 * it by dying.
 */
function sourceAvailable() {
  return [...RC_FILES, ...ID_HEADERS, ...HELP_HEADERS]
    .every((f) => fs.existsSync(path.join(SRC, f)));
}

/**
 * Reads one unit of source/resource.
 *
 * This used to call process.exit(1) when the submodule was absent, which is
 * defensible in a command-line tool and catastrophic in a library: build() is
 * called from test/messages.test.js, and process.exit takes the whole test
 * process down mid-report. `node --test` then has nothing to attribute the
 * death to, so it synthesises a file-level failure at messages.test.js:1:1
 * reading only "test failed" — every assertion that had already passed is lost
 * with the process, and the one line saying which file was missing is on
 * stderr, where the TAP reader shows it as an unrelated comment above the
 * failure. A whole afternoon can go into deciding whether that file-level
 * entry is real, which is exactly what a dead process buys you.
 *
 * It throws now. The caller that genuinely is a command line — main() below —
 * turns it back into the same message and the same exit code.
 */
function readSource(file) {
  const full = path.join(SRC, file);
  if (!fs.existsSync(full)) {
    const err = new Error('WinSCP source not found at ' + full + '\nRun: git submodule update --init');
    err.code = 'ENOVENDOR';
    err.path = full;
    throw err;
  }
  return fs.readFileSync(full, 'utf8');
}

function build() {
  const defines = new Map();
  for (const header of ID_HEADERS) {
    for (const [k, v] of parseDefines(readSource(header))) if (!defines.has(k)) defines.set(k, v);
  }

  const helpDefines = new Map();
  for (const header of HELP_HEADERS) {
    for (const [k, v] of parseDefines(readSource(header))) if (!helpDefines.has(k)) helpDefines.set(k, v);
  }

  const help = {};
  for (const name of helpDefines.keys()) {
    const resolved = resolveDefine(helpDefines, name);
    if (resolved && resolved.kind === 'string') help[name] = resolved.value;
  }

  const messages = {};
  const duplicates = [];
  const unresolved = [];
  const perFile = {};
  const excluded = {};

  for (const file of RC_FILES) {
    const entries = parseRc(readSource(file), file);
    perFile[file] = 0;

    for (const entry of entries) {
      if (POLICY_EXCLUDED.has(entry.name)) {
        excluded[entry.name] = POLICY_EXCLUDED.get(entry.name);
        continue;
      }
      perFile[file] += 1;

      if (Object.prototype.hasOwnProperty.call(messages, entry.name)) {
        duplicates.push(`${entry.name} (${messages[entry.name].file} and ${file})`);
        continue;
      }

      const resolved = /^\d/.test(entry.name)
        ? { kind: 'number', value: Number(entry.name) }
        : resolveDefine(defines, entry.name);
      if (!resolved || resolved.kind !== 'number') unresolved.push(`${entry.name} (${file})`);

      const params = LITERAL_PERCENT_IDS.has(entry.name) ? [] : analyseParams(entry.text);
      const segments = entry.text.split('|').length;

      const record = {
        id: resolved && resolved.kind === 'number' ? resolved.value : null,
        file,
        text: entry.text,
        params,
      };
      // Only carry the derived flags that are actually true, so the table stays
      // readable and a reviewer can see at a glance which messages are special.
      const positional = params.filter((p) => p.kind !== 'named');
      if (positional.length) record.arity = 1 + Math.max(...positional.map((p) => p.index));
      if (segments > 1) record.segments = segments;
      if (entry.text.startsWith('**') && entry.text.indexOf('**', 2) > 0) record.mainInstruction = true;
      if (entry.text.includes('\n')) record.multiline = true;
      if (LITERAL_PERCENT_IDS.has(entry.name)) record.literalPercent = true;

      messages[entry.name] = record;
    }
  }

  return { messages, help, perFile, duplicates, unresolved, excluded };
}

function main() {
  const { messages, help, perFile, duplicates, unresolved, excluded } = build();
  const names = Object.keys(messages);

  const withParams = names.filter((n) => messages[n].params.length);
  const withNamed = names.filter((n) => messages[n].params.some((p) => p.kind === 'named'));
  const withParts = names.filter((n) => messages[n].segments);
  const mainInstruction = names.filter((n) => messages[n].mainInstruction);

  const payload = {
    $generated: 'tools/extract-resources.js — do not edit by hand, re-run the extractor.',
    $source: 'vendor/winscp/source/resource',
    units: [...RC_FILES, ...ID_HEADERS, ...HELP_HEADERS],
    // WinSCP marks the highlighted first line of a message dialog by wrapping it
    // in MAIN_MSG_TAG, and an interactive tail in INTERACTIVE_MSG_TAG. Both are
    // themselves resource strings, so they are repeated here for any consumer
    // that needs them before the table is loaded.
    tags: {
      mainInstruction: messages.MAIN_MSG_TAG ? messages.MAIN_MSG_TAG.text : '**',
      interactive: messages.INTERACTIVE_MSG_TAG ? messages.INTERACTIVE_MSG_TAG.text : '$$',
    },
    // Named, with the reason, and without the text: the ledger must record a
    // decision rather than an oversight, and the reason must not smuggle the
    // very string it explains withholding.
    excludedByPolicy: excluded,
    counts: {
      messages: names.length,
      excludedByPolicy: Object.keys(excluded).length,
      withParameters: withParams.length,
      withNamedParameters: withNamed.length,
      multiPart: withParts.length,
      mainInstruction: mainInstruction.length,
      helpKeywords: Object.keys(help).length,
      perFile,
    },
    help,
    messages,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 1) + '\n', 'utf8');

  console.log(`Wrote ${OUT}`);
  console.log(`  messages:        ${names.length}`);
  for (const [file, count] of Object.entries(perFile)) console.log(`    ${file.padEnd(20)} ${count}`);
  console.log(`  with parameters: ${withParams.length}`);
  console.log(`  named (%NAME%):  ${withNamed.length}`);
  console.log(`  multi-part (|):  ${withParts.length}`);
  console.log(`  main instruction:${mainInstruction.length}`);
  console.log(`  help keywords:   ${Object.keys(help).length}`);
  console.log(`  withheld (#22):  ${Object.keys(excluded).length} — ${Object.keys(excluded).join(', ')}`);
  if (duplicates.length) console.log(`  DUPLICATE ids:   ${duplicates.join(', ')}`);
  if (unresolved.length) {
    console.log(`  no numeric id:   ${unresolved.length}`);
    console.log('    ' + unresolved.slice(0, 20).join(', ') + (unresolved.length > 20 ? ' …' : ''));
  }
}

// The exit code and the message a missing submodule produced before readSource
// started throwing, restored at the boundary where exiting is the right thing:
// this is a command line, and it has nobody to hand an exception to.
if (require.main === module) {
  try {
    main();
  } catch (e) {
    if (e && e.code === 'ENOVENDOR') {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }
}

module.exports = {
  build, parseRc, parseDefines, resolveDefine, decodeCString, tokenize,
  analyseParams, stripDisabledRegions, readSource, sourceAvailable,
  RC_FILES, ID_HEADERS, HELP_HEADERS, SRC,
  LITERAL_PERCENT_IDS, POLICY_EXCLUDED,
};
