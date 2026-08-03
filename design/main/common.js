// common.js — the utility layer core/Common.cpp provides to the rest of WinSCP.
//
// This is a faithful port of vendor/winscp/source/core/Common.cpp. Almost none
// of it is interesting on its own; all of it is load-bearing, because the
// listing parser, the command expander, the queue, the synchronizer and the
// session log all lean on these exact behaviours — including the odd ones that
// only exist because a real server or a real Windows shell forced them.
//
// Three conversion rules run through the whole file:
//
//  * Delphi strings are 1-based and its `SubString(Start, Len)` clamps rather
//    than throwing. Every index here is 0-based; where the original arithmetic
//    is load-bearing (CopyToChars returns an index the caller subtracts 2 from)
//    the comment says so.
//  * C++ passes strings by reference and mutates them. JavaScript cannot, so a
//    routine that consumed part of its input returns `{ ...; rest }` and the
//    caller rebinds. `cutToChar` and `cutToken` are the two that matter.
//  * VCL formatting is locale-driven. Where WinSCP's output is genuinely fixed
//    (the `ls`-style modification string, the octal permissions, the ISO
//    timestamp) it is reproduced exactly; where it followed the user's Windows
//    locale the separator is a parameter with the invariant default, so the
//    result is deterministic and the UI can localize it.
'use strict';

// ---------------------------------------------------------------------------
// constants (Common.cpp top-of-file)
// ---------------------------------------------------------------------------

const ANY_MASK = '*.*';
const ENG_SHORT_MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>';
const TOKEN_PREFIX = '%';
/** Sentinels for ValidLocalFileName's replacement argument (wchar_t(false/true)). */
const NO_REPLACEMENT = '\u0000';
const TOKEN_REPLACEMENT = '\u0001';
const LOCAL_INVALID_CHARS = '/\\:*?"<>|';
const PASSWORD_MASK = '***';
const ELLIPSIS = '...';
const TITLE_SEPARATOR = ' \u2013 '; // En-dash, as in the window title
const HOST_KEY_DELIMITER = ';';
const PARENT_DIRECTORY = '..';
const THIS_DIRECTORY = '.';
const NORMALIZED_FINGERPRINT_SEPARATOR = '-';
const HTTP_PROTOCOL = 'http';
const HTTPS_PROTOCOL = 'https';
const PROTOCOL_SEPARATOR = '://';
/** The tags WinSCP wraps around the "main instruction" of a message box. */
const MAIN_MSG_TAG = '**';
const INTERACTIVE_MSG_TAG = '$$';
const SHELL_COMMAND_FILENAME_PATTERN = '!.!';

/** LoadStrPart(TIME_RELATIVE, n) — 1-based, exactly as the resource splits it. */
const TIME_RELATIVE_PARTS = [
  'just now', 'today', 'yesterday', 'tomorrow',
  'one second ago', '%d seconds ago',
  'one minute ago', '%d minutes ago',
  'one hour ago', '%d hours ago',
  'one day ago', '%d days ago',
  'one week ago', '%d weeks ago',
  'one month ago', '%d months ago',
  'one year ago', '%d years ago',
];

// ---------------------------------------------------------------------------
// character classes
// ---------------------------------------------------------------------------

/** ASCII only, deliberately: WinSCP uses these to decide protocol syntax. */
function isLowerCaseLetter(ch) { return ch >= 'a' && ch <= 'z'; }
function isUpperCaseLetter(ch) { return ch >= 'A' && ch <= 'Z'; }
function isLetter(ch) { return isLowerCaseLetter(ch) || isUpperCaseLetter(ch); }
function isDigit(ch) { return ch >= '0' && ch <= '9'; }
function isHex(ch) {
  return isDigit(ch) || (ch >= 'A' && ch <= 'F') || (ch >= 'a' && ch <= 'f');
}
function isWideChar(ch) { return ch.charCodeAt(0) >= 0x80; }

// ---------------------------------------------------------------------------
// small string helpers
// ---------------------------------------------------------------------------

function replaceChar(str, a, b) {
  return String(str).split(a).join(b);
}

function deleteChar(str, c) {
  return String(str).split(c).join('');
}

/**
 * MakeValidFileName — for names WinSCP itself invents (a log file named after
 * a session). Much more aggressive than ValidLocalFileName: it also flattens
 * spaces and brackets, because these names end up in command lines.
 */
function makeValidFileName(fileName) {
  const illegal = ':;,=+<>|"[] \\/?*';
  let out = String(fileName);
  for (const ch of illegal) out = replaceChar(out, ch, '-');
  return out;
}

function defaultStr(str, fallback) {
  return str ? str : fallback;
}

/**
 * CutToChar: take everything before `ch`, and report the remainder. When the
 * character is absent the whole string is the token and nothing remains — that
 * is what lets callers loop `while (rest)` over a delimited list.
 */
function cutToChar(str, ch, trim) {
  let s = String(str);
  const p = s.indexOf(ch);
  let result;
  if (p >= 0) {
    result = s.slice(0, p);
    s = s.slice(p + 1);
  } else {
    result = s;
    s = '';
  }
  if (trim) {
    result = trimRight(result);
    s = trimLeft(s);
  }
  return { token: result, rest: s };
}

function trimLeft(s) { return String(s).replace(/^[\s\u0000]+/, ''); }
function trimRight(s) { return String(s).replace(/[\s\u0000]+$/, ''); }
function trimBoth(s) { return trimRight(trimLeft(s)); }

/**
 * CopyToChars. `from` is a 0-based start index; the returned `from` is the
 * index just past the delimiter, so a caller can walk a string in a loop. When
 * the end is reached it still points one past the end, "as if there were the
 * delimiter", which is what the original comment promises.
 *
 * `doubleDelimiterEscapes` makes ';;' mean a literal ';' — the escape the mask
 * editor round-trips names through.
 */
function copyToChars(str, from, chars, trim, doubleDelimiterEscapes) {
  const s = String(str);
  let result = '';
  let p = from;
  for (; p < s.length; p++) {
    if (chars.indexOf(s[p]) >= 0) {
      if (doubleDelimiterEscapes && p + 1 < s.length &&
          chars.indexOf(s[p + 1]) >= 0 && s[p + 1] === s[p]) {
        result += s[p];
        p++;
      } else {
        break;
      }
    } else {
      result += s[p];
    }
  }
  const delimiter = p < s.length ? s[p] : '';
  let next = p + 1;
  if (trim) {
    result = trimRight(result);
    while (next < s.length && s[next] === ' ') next++;
  }
  return { text: result, from: next, delimiter };
}

function copyToChar(str, ch, trim) {
  return copyToChars(str, 0, ch, trim, false).text;
}

/**
 * RemoveSuffix. With `removeNumbersAfterSuffix` the trailing digits go too —
 * that is how 'report.filepart2' is recognised as a partial of 'report'.
 */
function removeSuffix(str, suffix, removeNumbersAfterSuffix) {
  const s = String(str);
  let buf = s;
  if (removeNumbersAfterSuffix) {
    while (buf.length > 0 && isDigit(buf[buf.length - 1])) buf = buf.slice(0, -1);
  }
  if (suffix.length > 0 && buf.endsWith(suffix)) {
    return s.slice(0, buf.length - suffix.length);
  }
  return s;
}

/**
 * DelimitStr — escape a string for a POSIX shell inside the given quote.
 * A leading '-' gets './' in front so the shell cannot read the name as a
 * switch, which is the whole reason this exists rather than a plain quote.
 */
function delimitStr(str, quote) {
  const q = quote === undefined ? '"' : quote;
  let specialChars = '';
  if (q !== "'") {
    specialChars = '$\\';
    if (q === '"') specialChars += '`"';
  }
  let result = '';
  for (const ch of String(str)) {
    if (specialChars.indexOf(ch) >= 0) result += '\\';
    result += ch;
  }
  if (result.startsWith('-')) result = './' + result;
  return result;
}

function shellQuoteStr(str) {
  return '"' + delimitStr(str, '"') + '"';
}

/** MidStr keeps the original 1-based start, because callers pass 1-based positions. */
function midStr(text, start) {
  return String(text).slice(Math.max(0, start - 1));
}

function stripPathQuotes(path) {
  const p = String(path);
  if (p.length >= 2 && p[0] === '"' && p[p.length - 1] === '"') return p.slice(1, -1);
  return p;
}

/** Quotes only when there is a space — an unconditional quote breaks some shells. */
function addQuotes(str) {
  const s = String(str);
  return s.indexOf(' ') >= 0 ? '"' + s + '"' : s;
}

function addPathQuotes(path) {
  return addQuotes(stripPathQuotes(path));
}

/**
 * IsNumber, ported including its off-by-one: the loop stops before the LAST
 * character, so '12a' is reported as a number and 'a12' is not. It is used to
 * spot the trailing counter of '.filepart3', where the final character is
 * always a digit anyway — but the behaviour is visible, so it is preserved.
 */
function isNumber(str) {
  const s = String(str);
  let result = s.length > 0;
  for (let i = 0; i < s.length - 1 && result; i++) {
    if (!isDigit(s[i])) result = false;
  }
  return result;
}

/** Drops trailing '.0' components while at least two dots remain. 1.2.0 -> 1.2 */
function trimVersion(version) {
  let v = String(version);
  while (v.indexOf('.') !== v.lastIndexOf('.') && v.slice(-2) === '.0') {
    v = v.slice(0, -2);
  }
  return v;
}

function formatVersion(major, minor, release) {
  return trimVersion(`${major}.${minor}.${release}`);
}

/** Doubles quotes, so the value survives being re-parsed as a command line. */
function escapeParam(param) {
  return String(param).split('"').join('""');
}

/**
 * EscapePuttyCommandParam. PuTTY's own command line splitter needs a backslash
 * before a quote, and before every backslash in a run that PRECEDES a quote —
 * a run not followed by a quote is literal and must be left alone.
 */
function escapePuttyCommandParam(param) {
  const a = Array.from(String(param));
  let space = false;
  for (let i = 0; i < a.length; i++) {
    const ch = a[i];
    if (ch === '"') {
      a.splice(i, 0, '\\');
      i++;
    } else if (ch === ' ') {
      space = true;
    } else if (ch === '\\') {
      let i2 = i;
      while (i2 < a.length && a[i2] === '\\') i2++;
      if (i2 < a.length && a[i2] === '"') {
        while (a[i] === '\\') {
          a.splice(i, 0, '\\');
          i += 2;
        }
        i--;
      }
    }
  }
  let result = a.join('');
  if (space) result = '"' + result + '"';
  return result;
}

function escapeHotkey(caption) {
  return String(caption).split('&').join('&&');
}

/** Removes a trailing '...' (and the space before it) from a menu caption. */
function stripEllipsis(s) {
  let result = String(s);
  if (result.slice(result.length - ELLIPSIS.length) === ELLIPSIS) {
    result = trimRight(result.slice(0, result.length - ELLIPSIS.length));
  }
  return result;
}

/**
 * Windows device names. A file called 'con.txt' cannot be created, so a
 * download of a remote 'con.txt' has to be renamed — see validLocalFileName.
 */
function isReservedName(fileName) {
  let name = String(fileName);
  const p = name.indexOf('.');
  const len = p >= 0 ? p : name.length;
  if (len === 3 || len === 4) {
    if (p >= 0) name = name.slice(0, p);
    const reserved = [
      'CON', 'PRN', 'AUX', 'NUL',
      'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
      'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
    ];
    for (const r of reserved) if (name.toUpperCase() === r) return true;
  }
  return false;
}

function byteToHex(b, upperCase) {
  const digits = upperCase === false ? '0123456789abcdef' : '0123456789ABCDEF';
  return digits[(b & 0xf0) >> 4] + digits[b & 0x0f];
}

function bytesToHex(bytes, upperCase, separator) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  let result = '';
  for (let i = 0; i < buf.length; i++) {
    result += byteToHex(buf[i], upperCase);
    if (separator && i < buf.length - 1) result += separator;
  }
  return result;
}

/** Big-endian on purpose: BytesToHex would give the opposite for a wchar_t. */
function charToHex(ch, upperCase) {
  const code = String(ch).charCodeAt(0);
  return byteToHex(code >> 8, upperCase) + byteToHex(code & 0xff, upperCase);
}

/** Returns an empty Buffer for odd length or a non-hex digit, as the original does. */
function hexToBytes(hex) {
  const s = String(hex);
  const digits = '0123456789ABCDEF';
  if (s.length % 2 !== 0) return Buffer.alloc(0);
  const out = [];
  for (let i = 0; i < s.length; i += 2) {
    const p1 = digits.indexOf(s[i].toUpperCase());
    const p2 = digits.indexOf(s[i + 1].toUpperCase());
    if (p1 < 0 || p2 < 0) return Buffer.alloc(0);
    out.push(p1 * 16 + p2);
  }
  return Buffer.from(out);
}

/** A non-hex digit yields 0 rather than throwing — callers treat 0 as "absent". */
function hexToByte(hex) {
  const s = String(hex);
  const digits = '0123456789ABCDEF';
  const p1 = digits.indexOf((s[0] || '').toUpperCase());
  const p2 = digits.indexOf((s[1] || '').toUpperCase());
  return (p1 < 0 || p2 < 0) ? 0 : (p1 << 4) + p2;
}

/**
 * DisplayableStr — how the session log renders a protocol blob. Printable
 * ASCII becomes a C-escaped quoted string; anything else becomes 0x-hex, so a
 * binary packet never corrupts the log.
 */
function displayableStr(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  let displayable = true;
  for (let i = 0; i < buf.length && displayable; i++) {
    const b = buf[i];
    if ((b < 0x20 || b >= 0x80) &&
        b !== 0x0a && b !== 0x0d && b !== 0x09 && b !== 0x08) {
      displayable = false;
    }
  }
  if (!displayable) return '0x' + bytesToHex(buf);
  let result = '"';
  for (let i = 0; i < buf.length; i++) {
    switch (buf[i]) {
      case 0x0a: result += '\\n'; break;
      case 0x0d: result += '\\r'; break;
      case 0x09: result += '\\t'; break;
      case 0x08: result += '\\b'; break;
      case 0x5c: result += '\\\\'; break;
      case 0x22: result += '\\"'; break;
      default: result += String.fromCharCode(buf[i]); break;
    }
  }
  return result + '"';
}

// ---------------------------------------------------------------------------
// local file names
// ---------------------------------------------------------------------------

/**
 * ValidLocalFileName — make a remote name storable on Windows.
 *
 * Three modes, exactly as the original:
 *  * a replacement character (default '_') substitutes each invalid character;
 *  * TOKEN_REPLACEMENT encodes it as '%XX', which is reversible — this is what
 *    the "replace invalid characters" transfer setting uses, and why a name
 *    that already contains a valid '%XX' token is left alone;
 *  * NO_REPLACEMENT refuses instead, throwing for any name Windows cannot
 *    store faithfully.
 *
 * Two Windows-isms are handled after the substitution: a trailing space or dot
 * would be silently trimmed by the file system, so it is encoded; and a
 * reserved device name gets '%00' inserted so 'con.txt' survives as 'con%00.txt'.
 */
function validLocalFileName(fileName, invalidCharsReplacement, tokenizibleChars, localInvalidChars) {
  let name = String(fileName);
  const replacement = invalidCharsReplacement === undefined ? '_' : invalidCharsReplacement;
  const tokenizible = tokenizibleChars === undefined ? '' : tokenizibleChars;
  const invalid = localInvalidChars === undefined ? LOCAL_INVALID_CHARS : localInvalidChars;

  if (replacement === NO_REPLACEMENT) {
    const last = name[name.length - 1];
    if ([...name].some((ch) => invalid.indexOf(ch) >= 0 || ch.charCodeAt(0) < 32) ||
        last === ' ' || last === '.' || isReservedName(name)) {
      throw new Error(`"${fileName}" is not valid filename.`);
    }
    return name;
  }

  const tokenReplacement = replacement === TOKEN_REPLACEMENT;
  const chars = tokenReplacement ? tokenizible : invalid;

  const replaceAt = (index) => {
    if (tokenReplacement) {
      // No Unicode escape form exists, so a wide character cannot be tokenized.
      if (name.charCodeAt(index) > 0xff) {
        throw new Error(`Cannot encode character in "${fileName}".`);
      }
      name = name.slice(0, index) + TOKEN_PREFIX +
        byteToHex(name.charCodeAt(index)) + name.slice(index + 1);
      return index + 3;
    }
    name = name.slice(0, index) + replacement + name.slice(index + 1);
    return index + 1;
  };

  let i = 0;
  while (i < name.length) {
    if (chars.indexOf(name[i]) < 0) { i++; continue; }
    if (tokenReplacement && name[i] === TOKEN_PREFIX) {
      // Already-encoded token: leave it, otherwise encoding is not idempotent.
      const decoded = name.length - i > 2
        ? String.fromCharCode(hexToByte(name.substr(i + 1, 2))) : '\u0000';
      if (name.length - (i + 1) <= 1 || decoded === '\u0000' || tokenizible.indexOf(decoded) < 0) {
        i++;
        continue;
      }
    }
    i = replaceAt(i);
  }

  if (name.length > 0) {
    const last = name[name.length - 1];
    if (last === ' ' || last === '.') replaceAt(name.length - 1);
  }

  if (isReservedName(name)) {
    const p = name.indexOf('.');
    const at = p >= 0 ? p : name.length;
    name = name.slice(0, at) + '%00' + name.slice(at);
  }

  return name;
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

/**
 * SplitCommand. A quoted program keeps its spaces; an unquoted one ends at the
 * first space. An opening quote with no closing quote is an error rather than
 * a guess, because guessing would run the wrong executable.
 */
function splitCommand(command) {
  let cmd = trimBoth(command);
  let program = '';
  let params = '';
  let dir = '';
  if (cmd.length > 0 && cmd[0] === '"') {
    cmd = cmd.slice(1);
    const p = cmd.indexOf('"');
    if (p >= 0) {
      program = trimBoth(cmd.slice(0, p));
      params = trimBoth(cmd.slice(p + 1));
    } else {
      throw new Error(`Invalid command '"${cmd}'.`);
    }
  } else {
    const p = cmd.indexOf(' ');
    if (p >= 0) {
      program = trimBoth(cmd.slice(0, p + 1));
      params = trimBoth(cmd.slice(p + 1));
    } else {
      program = cmd;
    }
  }
  const b = Math.max(program.lastIndexOf('\\'), program.lastIndexOf('/'));
  if (b >= 0) dir = trimBoth(program.slice(0, b + 1));
  return { program, params, dir };
}

function extractProgram(command) {
  return splitCommand(command).program;
}

function extractProgramName(command) {
  let name = extractFileName(extractProgram(command));
  const dot = name.lastIndexOf('.');
  if (dot >= 0) name = name.slice(0, dot);
  return name;
}

function formatCommand(program, params) {
  let p = trimBoth(program);
  let a = trimBoth(params);
  if (a) a = ' ' + a;
  return addQuotes(p) + a;
}

/** Makes sure an "open with" command actually mentions the file. */
function reformatFileNameCommand(command) {
  if (!command) return String(command || '');
  const { program, params } = splitCommand(command);
  let p = params;
  if (p.indexOf(SHELL_COMMAND_FILENAME_PATTERN) < 0) {
    p = p + (p ? ' ' : '') + SHELL_COMMAND_FILENAME_PATTERN;
  }
  return formatCommand(program, p);
}

function expandFileNameCommand(command, fileName) {
  return String(command).split(SHELL_COMMAND_FILENAME_PATTERN).join(addPathQuotes(fileName));
}

/**
 * CutToken — PuTTY's sftp_getcmd() rules, used by the scripting command line.
 * Leading whitespace is skipped, a quote toggles quoting, and a doubled quote
 * is a literal one. `escapeQuotesInQuotesOnly` (cutTokenEx) makes a bare `""`
 * mean the empty string instead of a quote character, which is what a script
 * needs to pass an explicitly empty argument.
 */
function doCutToken(str, escapeQuotesInQuotesOnly) {
  const s = String(str);
  let token = '';
  let index = 0;
  while (index < s.length && (s[index] === ' ' || s[index] === '\t')) index++;

  if (index >= s.length) {
    return { ok: false, token: '', rest: '', rawToken: '', separator: '' };
  }

  let quoting = false;
  const start = index;
  while (index < s.length) {
    if (!quoting && (s[index] === ' ' || s[index] === '\t')) break;
    if (s[index] === '"' && index + 1 < s.length && s[index + 1] === '"' &&
        (!escapeQuotesInQuotesOnly || quoting)) {
      index += 2;
      token += '"';
    } else if (s[index] === '"') {
      index++;
      quoting = !quoting;
    } else {
      token += s[index];
      index++;
    }
  }

  const rawToken = s.slice(0, index);
  let separator = '';
  if (index < s.length) {
    separator = s[index];
    index++;
  }
  void start;
  return { ok: true, token, rest: s.slice(index), rawToken, separator };
}

function cutToken(str) { return doCutToken(str, false); }
function cutTokenEx(str) { return doCutToken(str, true); }

/** Splits an entire command line into tokens using cutToken repeatedly. */
function splitTokens(str, ex) {
  const out = [];
  let rest = String(str);
  for (;;) {
    const r = ex ? cutTokenEx(rest) : cutToken(rest);
    if (!r.ok) break;
    out.push(r.token);
    rest = r.rest;
  }
  return out;
}

/**
 * AddToList — append with a delimiter, but only when the list does not already
 * end with one, and never for an empty value. Returns the new list.
 */
function addToList(list, value, delimiter) {
  let result = String(list || '');
  const v = String(value == null ? '' : value);
  const d = String(delimiter);
  if (v) {
    if (result && (result.length < d.length || result.slice(result.length - d.length) !== d)) {
      result += d;
    }
    result += v;
  }
  return result;
}

function addToShellFileListCommandLine(list, value) {
  return addToList(list, shellQuoteStr(value), ' ');
}

/**
 * CutFeature — the FTP FEAT parser's tokenizer: comma separated, but a value
 * may be quoted, and a quoted value may itself contain commas.
 */
function cutFeature(buf) {
  let b = String(buf);
  let result;
  if (b.slice(0, 1) === '"') {
    b = b.slice(1);
    const p = b.indexOf('",');
    if (p < 0) {
      result = b;
      b = '';
      // The closing quote should be there, but a server that omits it is not
      // worth failing over.
      if (result.slice(-1) === '"') result = result.slice(0, -1);
    } else {
      result = b.slice(0, p);
      b = b.slice(p + 2);
    }
    b = trimLeft(b);
    return { feature: result, rest: b };
  }
  const cut = cutToChar(b, ',', true);
  return { feature: cut.token, rest: cut.rest };
}

/**
 * ProcessFeatures — apply a user's feature override to a server's FEAT list.
 * A leading '*' replaces the list wholesale; otherwise '-x' removes and '+x'
 * (or a bare name) adds.
 */
function processFeatures(features, featuresOverride) {
  const result = [];
  let override = String(featuresOverride || '');
  if (override.slice(0, 1) === '*') {
    override = override.slice(1);
    while (override) {
      const c = cutFeature(override);
      override = c.rest;
      result.push(c.feature);
    }
    return result;
  }
  const deleteFeatures = new Set();
  const addFeatures = [];
  while (override) {
    const c = cutFeature(override);
    override = c.rest;
    let feature = c.feature;
    if (feature.slice(0, 1) === '-') {
      deleteFeatures.add(feature.slice(1).toLowerCase());
    } else {
      if (feature.slice(0, 1) === '+') feature = feature.slice(1);
      addFeatures.push(feature);
    }
  }
  for (const feature of features || []) {
    // The delete list is a case-insensitive sorted list in the original.
    if (!deleteFeatures.has(String(feature).toLowerCase())) result.push(feature);
  }
  return result.concat(addFeatures);
}

// ---------------------------------------------------------------------------
// comparison
// ---------------------------------------------------------------------------

/** AnsiCompareText: case-insensitive, with a case-sensitive tie-break. */
function compareText(s1, s2) {
  const a = String(s1).toLowerCase();
  const b = String(s2).toLowerCase();
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function compareNumber(v1, v2) {
  if (v1 < v2) return -1;
  if (v1 === v2) return 0;
  return 1;
}

/** StrCmpLogicalW: digit runs compare numerically, so 'f2' sorts before 'f10'. */
function naturalCompare(s1, s2) {
  const a = String(s1);
  const b = String(s2);
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const da = isDigit(a[i]);
    const db = isDigit(b[j]);
    if (da && db) {
      let ia = i;
      let jb = j;
      while (ia < a.length && isDigit(a[ia])) ia++;
      while (jb < b.length && isDigit(b[jb])) jb++;
      const na = a.slice(i, ia).replace(/^0+(?=\d)/, '');
      const nb = b.slice(j, jb).replace(/^0+(?=\d)/, '');
      if (na.length !== nb.length) return na.length < nb.length ? -1 : 1;
      if (na !== nb) return na < nb ? -1 : 1;
      i = ia;
      j = jb;
      continue;
    }
    const ca = a[i].toLowerCase();
    const cb = b[j].toLowerCase();
    if (ca !== cb) return ca < cb ? -1 : 1;
    i++;
    j++;
  }
  if (i < a.length) return 1;
  if (j < b.length) return -1;
  return 0;
}

/**
 * CompareLogicalText. The case-sensitive tie-break is not cosmetic: without it
 * the list view's sort is unstable between two names differing only in case.
 */
function compareLogicalText(s1, s2, naturalOrderNumericalSorting) {
  let result = naturalOrderNumericalSorting ? naturalCompare(s1, s2) : compareText(s1, s2);
  if (result === 0) {
    const a = String(s1);
    const b = String(s2);
    result = a < b ? -1 : (a > b ? 1 : 0);
  }
  return result;
}

/** An all-lowercase needle searches case-insensitively; any capital makes it exact. */
function containsTextSemiCaseSensitive(text, subText) {
  const t = String(text);
  const s = String(subText);
  if (s.toLowerCase() === s) return t.toLowerCase().indexOf(s.toLowerCase()) >= 0;
  return t.indexOf(s) >= 0;
}

/** Identifiers compare ignoring case and dashes: 'diffie-hellman' == 'DiffieHellman'. */
function sameIdent(ident1, ident2) {
  return String(ident1).split('-').join('').toLowerCase() ===
    String(ident2).split('-').join('').toLowerCase();
}

function findIdent(ident, idents) {
  for (const candidate of idents || []) {
    if (sameIdent(ident, candidate)) return candidate;
  }
  return ident;
}

// ---------------------------------------------------------------------------
// message composition
// ---------------------------------------------------------------------------

function mainInstructions(s) {
  return MAIN_MSG_TAG + s + MAIN_MSG_TAG;
}

function hasParagraphs(s) {
  return String(s).indexOf('\n\n') >= 0;
}

/** Highlights the first paragraph only — the rest stays body text. */
function mainInstructionsFirstParagraph(s) {
  const str = String(s);
  const pos = str.indexOf('\n\n');
  if (pos < 0) return mainInstructions(str);
  return mainInstructions(str.slice(0, pos)) + str.slice(pos);
}

/** Returns { found, mainInstructions, rest }; `rest` has the tagged part removed. */
function extractMainInstructions(s) {
  const str = String(s);
  if (str.startsWith(MAIN_MSG_TAG)) {
    const tail = str.slice(MAIN_MSG_TAG.length);
    const endTagPos = tail.indexOf(MAIN_MSG_TAG);
    if (endTagPos >= 0) {
      return {
        found: true,
        mainInstructions: tail.slice(0, endTagPos),
        rest: str.slice(endTagPos + 2 * MAIN_MSG_TAG.length),
      };
    }
  }
  return { found: false, mainInstructions: '', rest: str };
}

function removeMainInstructionsTag(s) {
  const r = extractMainInstructions(s);
  return r.found ? r.mainInstructions + r.rest : r.rest;
}

/** Position of the opening interactive tag, or -1. */
function findInteractiveMsgStart(s) {
  const str = String(s);
  if (str.endsWith(INTERACTIVE_MSG_TAG) && str.length >= 2 * INTERACTIVE_MSG_TAG.length) {
    let result = str.length - 2 * INTERACTIVE_MSG_TAG.length;
    while (result >= 0 && str.substr(result, INTERACTIVE_MSG_TAG.length) !== INTERACTIVE_MSG_TAG) {
      result--;
    }
    return result;
  }
  return -1;
}

/** Everything the user should see, with the markup and the interactive part gone. */
function unformatMessage(s) {
  let str = removeMainInstructionsTag(s);
  const start = findInteractiveMsgStart(str);
  if (start >= 0) str = str.slice(0, start);
  return str;
}

/** Keeps the interactive text but drops the tags around it. */
function removeInteractiveMsgTag(s) {
  let str = String(s);
  const start = findInteractiveMsgStart(str);
  if (start >= 0) {
    str = str.slice(0, start) + str.slice(start + INTERACTIVE_MSG_TAG.length);
    str = str.slice(0, str.length - INTERACTIVE_MSG_TAG.length);
  }
  return str;
}

function removeEmptyLines(s) {
  return trimRight(s).split('\n\n').join('\n').split('\n \n').join('\n');
}

/** How an exception is written into the session log: "(class) message". */
function exceptionLogString(e) {
  if (!e) return '';
  const name = e.name || 'Exception';
  let msg = `(${name}) ${e.message || ''}`;
  if (Array.isArray(e.moreMessages) && e.moreMessages.length > 0) {
    msg += '\n' + e.moreMessages.join('\n').split('\r').join('');
  }
  return msg;
}

// ---------------------------------------------------------------------------
// paths (Windows shapes; the unix ones live in remotefiles.js)
// ---------------------------------------------------------------------------

function includeTrailingBackslash(path) {
  const p = String(path);
  if (p === '' || p.endsWith('\\') || p.endsWith('/')) return p;
  return p + '\\';
}

function excludeTrailingBackslash(path) {
  const p = String(path);
  if (p.length > 0 && (p.endsWith('\\') || p.endsWith('/'))) return p.slice(0, -1);
  return p;
}

function lastPathDelimiter(path) {
  const p = String(path);
  return Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
}

function extractFilePath(path) {
  const p = String(path);
  const i = lastPathDelimiter(p);
  if (i >= 0) return p.slice(0, i + 1);
  // A bare drive reference ("C:") is its own path.
  if (p.length >= 2 && p[1] === ':') return p.slice(0, 2);
  return '';
}

function extractFileName(path) {
  const p = String(path);
  const i = lastPathDelimiter(p);
  if (i >= 0) return p.slice(i + 1);
  if (p.length >= 2 && p[1] === ':') return p.slice(2);
  return p;
}

function extractFileDir(path) {
  const dir = extractFilePath(path);
  if (dir.length > 1 && !(dir.length === 3 && dir[1] === ':')) return excludeTrailingBackslash(dir);
  return dir;
}

function extractFileDrive(path) {
  const p = String(path);
  if (p.length >= 2 && p[1] === ':') return p.slice(0, 2);
  if (p.length >= 2 && (p[0] === '\\' || p[0] === '/') && (p[1] === '\\' || p[1] === '/')) {
    // \\server\share
    let i = 2;
    let slashes = 0;
    for (; i < p.length; i++) {
      if (p[i] === '\\' || p[i] === '/') {
        slashes++;
        if (slashes === 2) break;
      }
    }
    return p.slice(0, i);
  }
  return '';
}

function extractFileExt(path) {
  const name = extractFileName(path);
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i) : '';
}

function changeFileExt(path, ext) {
  const p = String(path);
  const name = extractFileName(p);
  const i = name.lastIndexOf('.');
  if (i <= 0) return p + ext;
  return p.slice(0, p.length - (name.length - i)) + ext;
}

function extractFileBaseName(path) {
  return changeFileExt(extractFileName(path), '');
}

/** '.' and '..' are directory entries, not files — every walker checks this. */
function isRealFile(fileName) {
  return fileName !== THIS_DIRECTORY && fileName !== PARENT_DIRECTORY;
}

function samePaths(path1, path2) {
  return includeTrailingBackslash(path1).toLowerCase() ===
    includeTrailingBackslash(path2).toLowerCase();
}

/** 'C:' + 'foo' must be 'C:\foo', never the drive-relative 'C:foo'. */
function combinePaths(path1, path2) {
  let p1 = String(path1);
  const p2 = String(path2);
  if (p1.endsWith(':')) p1 = includeTrailingBackslash(p1);
  if (!p1) return p2;
  if (!p2) return p1;
  if (/^[a-zA-Z]:[\\/]/.test(p2) || p2.startsWith('\\') || p2.startsWith('/')) return p2;
  return includeTrailingBackslash(p1) + p2;
}

function getNormalizedPath(path) {
  return fromUnixPath(excludeTrailingBackslash(path));
}

function fromUnixPath(path) {
  return String(path).split('/').join('\\');
}

function toUnixPath(path) {
  return String(path).split('\\').join('/');
}

// ---------------------------------------------------------------------------
// sizes and numbers
// ---------------------------------------------------------------------------

/**
 * WinSCP's own Round(), not Delphi's: the tie test is a strict '>', so an exact
 * half falls to the FLOOR — 2.5 gives 2 and -2.5 gives -3, where Math.round
 * would give 3 and -2. Callers that convert a byte count depend on the
 * difference.
 */
function round(number) {
  const floor = Math.floor(number);
  const ceil = Math.ceil(number);
  return (number - floor) > (ceil - number) ? ceil : floor;
}

/**
 * TryStrToSize — '5', '5K', '5 M', '5g'. Each unit is a further *1024, and the
 * unit letters deliberately avoid S/N/H/D/Y so a mask bound is never ambiguous
 * between a size and a relative time.
 */
function tryStrToSize(sizeStr) {
  let s = String(sizeStr);
  let index = 0;
  while (index < s.length && isDigit(s[index])) index++;
  if (index === 0) return { ok: false, size: 0 };
  let size = Number(s.slice(0, index));
  // WinSCP parses the numeric part as Int64.  Do not let JavaScript accept
  // rounded values beyond its exact integer range; they would no longer
  // describe the byte count the user entered.
  if (!Number.isSafeInteger(size)) return { ok: false, size: 0 };
  s = trimBoth(s.slice(index));
  if (s) {
    if (s.length !== 1) return { ok: false, size: 0 };
    switch (s.toUpperCase()) {
      case 'G': size *= 1024; // falls through
      case 'M': size *= 1024; // falls through
      case 'K': size *= 1024; break;
      default: return { ok: false, size: 0 };
    }
  }
  if (!Number.isSafeInteger(size)) return { ok: false, size: 0 };
  return { ok: true, size };
}

/** The inverse: the largest whole unit that loses nothing. 1048576 -> '1M'. */
function sizeToStr(size) {
  let n = size;
  if (n <= 0 || (n % 1024) !== 0) return String(n);
  n /= 1024;
  if ((n % 1024) !== 0) return String(n) + 'K';
  n /= 1024;
  if ((n % 1024) !== 0) return String(n) + 'M';
  n /= 1024;
  return String(n) + 'G';
}

/**
 * FormatNumber — FormatFloat('#,##0'). Delphi takes the group separator from
 * the user's locale; the default here is the invariant ',' so output is
 * deterministic, and the UI passes the localized one.
 */
function formatNumber(number, thousandSeparator) {
  const sep = thousandSeparator === undefined ? ',' : thousandSeparator;
  const n = Math.trunc(Number(number) || 0);
  const negative = n < 0;
  const digits = String(Math.abs(n));
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += sep;
    out += digits[i];
  }
  return (negative ? '-' : '') + out;
}

/** FormatSize is FormatNumber — WinSCP shows exact bytes, grouped, not '1.2 MB'. */
function formatSize(size, thousandSeparator) {
  return formatNumber(size, thousandSeparator);
}

// ---------------------------------------------------------------------------
// time
// ---------------------------------------------------------------------------

const DST_MODE = { WIN: 'win', UNIX: 'unix', KEEP: 'keep' };
const DST_MODE_NAMES = ['Win', 'Unix', 'Keep'];

/** Accepts the stored integer (0/1/2) as well as the name. */
function normalizeDstMode(mode) {
  if (mode === 0 || mode === '0' || mode === DST_MODE.WIN) return DST_MODE.WIN;
  if (mode === 2 || mode === '2' || mode === DST_MODE.KEEP) return DST_MODE.KEEP;
  return DST_MODE.UNIX;
}

const MINS_PER_DAY = 1440;
const SECS_PER_DAY = 86400;
const MSECS_PER_DAY = 86400000;

/**
 * The Windows TIME_ZONE_INFORMATION WinSCP reads, derived from the platform's
 * own rules instead of the registry. Signs follow Microsoft: Bias is the
 * number of minutes to ADD to local time to get UTC, so GMT+1 has Bias -60 and
 * a one-hour summer time has DaylightBias -60 on top of it.
 *
 * A year of 0 means "current", as in GetDateTimeParams(0).
 */
const yearlyParamsCache = new Map();

function timeZoneParams(year) {
  const key = year || 0;
  if (yearlyParamsCache.has(key)) return yearlyParamsCache.get(key);

  const y = key === 0 ? new Date().getFullYear() : key;
  // Sampling January and July finds both offsets in either hemisphere; the
  // larger offset (further west of UTC) is standard time by definition.
  const janOffset = new Date(y, 0, 1, 12).getTimezoneOffset();
  const julOffset = new Date(y, 6, 1, 12).getTimezoneOffset();
  const baseDifferenceMinutes = Math.max(janOffset, julOffset);
  const daylightOffsetMinutes = Math.min(janOffset, julOffset);
  const hasDST = janOffset !== julOffset;

  const params = {
    year: y,
    hasDST,
    baseDifferenceMinutes,
    standardDifferenceMinutes: 0,
    daylightDifferenceMinutes: daylightOffsetMinutes - baseDifferenceMinutes,
    // "Summer DST" means the daylight period starts after the standard one in
    // the calendar year — northern hemisphere. It changes which comparison
    // decides whether a date is inside DST.
    summerDST: hasDST && janOffset > julOffset,
    currentDaylightDifferenceSec: 0,
    currentDifferenceSec: 0,
    baseDifferenceSec: baseDifferenceMinutes * 60,
    standardDifferenceSec: 0,
    daylightDifferenceSec: (daylightOffsetMinutes - baseDifferenceMinutes) * 60,
    standardName: '',
    daylightName: '',
  };
  if (key === 0) {
    const nowOffset = new Date().getTimezoneOffset();
    params.currentDaylightDifferenceSec = (nowOffset - baseDifferenceMinutes) * 60;
    params.currentDifferenceSec = nowOffset * 60;
  } else {
    params.currentDifferenceSec = baseDifferenceMinutes * 60;
  }
  yearlyParamsCache.set(key, params);
  return params;
}

/** Test seam: the parameters are cached per year, exactly as the original caches them. */
function clearTimeZoneParamsCache() { yearlyParamsCache.clear(); }

/**
 * IsDateInDST. WinSCP reconstructs the transition dates from the registry's
 * SYSTEMTIME margins; here the platform already knows them, so the question
 * "is this instant offset from standard time" answers it directly and stays
 * correct for zones whose rules changed between years.
 */
function isDateInDST(ms) {
  const d = new Date(ms);
  const params = timeZoneParams(d.getFullYear());
  if (!params.hasDST) return false;
  return d.getTimezoneOffset() !== params.baseDifferenceMinutes;
}

/** The DST bias in minutes for that instant: 0 outside DST, typically -60 inside. */
function dstDifferenceMinutesForTime(ms) {
  const params = timeZoneParams(new Date(ms).getFullYear());
  return isDateInDST(ms) ? params.daylightDifferenceMinutes : params.standardDifferenceMinutes;
}

/**
 * UnixToDateTime. Times are epoch milliseconds here rather than a local
 * wall-clock double, so `unix` (WinSCP's default) is the identity: the
 * instant already renders as the right local time.
 *
 * `win` reproduces the Windows behaviour of interpreting the stamp against the
 * CURRENT bias — during summer time the displayed clock is one hour off, which
 * is exactly the discrepancy the "consider DST" session option exists to
 * explain.
 */
function unixToDateTime(seconds, dstMode) {
  const ms = seconds * 1000;
  if (normalizeDstMode(dstMode) === DST_MODE.WIN) {
    return ms + dstDifferenceMinutesForTime(ms) * 60000;
  }
  return ms;
}

/** The inverse of unixToDateTime. */
function dateTimeToUnix(ms, dstMode) {
  if (normalizeDstMode(dstMode) === DST_MODE.WIN) {
    return Math.round((ms - dstDifferenceMinutesForTime(ms) * 60000) / 1000);
  }
  return Math.round(ms / 1000);
}

/**
 * AdjustDateTimeFromUnix — applied to a timestamp already parsed as a local
 * wall clock (an `ls` listing line). Only `win` shifts it.
 */
function adjustDateTimeFromUnix(ms, dstMode) {
  if (normalizeDstMode(dstMode) === DST_MODE.WIN) {
    return ms + dstDifferenceMinutesForTime(ms) * 60000;
  }
  return ms;
}

/** ConvertTimestampToUnix for a stamp that arrived as a local wall clock. */
function convertTimestampToUnix(ms, dstMode) {
  return dateTimeToUnix(ms, dstMode);
}

/**
 * ConvertTimestampToUTC/FromUTC shift a wall clock between the local zone and
 * UTC. With epoch milliseconds the instant is already absolute, so these
 * return the UTC/local wall clock as milliseconds for callers that need the
 * fields (the XML log, the ISO timestamp).
 */
function convertTimestampToUTC(ms) {
  return ms + (dstDifferenceMinutesForTime(ms) + timeZoneParams(new Date(ms).getFullYear()).baseDifferenceMinutes) * 60000;
}

function convertTimestampFromUTC(ms) {
  return ms - (dstDifferenceMinutesForTime(ms) + timeZoneParams(new Date(ms).getFullYear()).baseDifferenceMinutes) * 60000;
}

/**
 * FixedLenDateTimeFormat — doubles single-letter placeholders so every field
 * is fixed width ('d/m/yy' -> 'dd/mm/yy'). Quoted literals are left alone, and
 * the am/pm markers are skipped rather than doubled.
 */
function fixedLenDateTimeFormat(format) {
  let result = String(format);
  let asIs = false;
  let index = 0;
  while (index < result.length) {
    const f = result[index];
    if (f === "'" || f === '"') {
      asIs = !asIs;
      index++;
    } else if (!asIs && (f === 'a' || f === 'A')) {
      if (result.substr(index, 5).toLowerCase() === 'am/pm') index += 5;
      else if (result.substr(index, 3).toLowerCase() === 'a/p') index += 3;
      else if (result.substr(index, 4).toLowerCase() === 'ampm') index += 4;
      else index++;
    } else {
      if (!asIs && 'dDeEmMhHnNsS'.indexOf(f) >= 0 &&
          (index === result.length - 1 || result[index + 1] !== f)) {
        result = result.slice(0, index) + f + result.slice(index);
      }
      while (index < result.length && f === result[index]) index++;
    }
  }
  return result;
}

/**
 * FormatTimeZone — the log's "GMT+2" style. The sign is inverted because the
 * input is a Windows bias (minutes to add to reach UTC), not an offset.
 */
function formatTimeZone(sec) {
  const hours = Math.trunc(sec / 3600);
  const minutes = Math.trunc(sec / 60) % 60;
  const seconds = Math.trunc(sec) % 60;
  const pad = (n) => String(Math.abs(n)).padStart(2, '0');
  let str;
  if (seconds === 0 && minutes === 0) str = String(-hours);
  else if (seconds === 0) str = `${-hours}:${pad(minutes)}`;
  else str = `${-hours}:${pad(minutes)}:${pad(seconds)}`;
  return (sec <= 0 ? '+' : '') + str;
}

function getTimeZoneLogString() {
  const p = timeZoneParams(0);
  let result = `Current: GMT${formatTimeZone(p.currentDifferenceSec)}`;
  if (!p.hasDST) {
    result += ', No DST';
  } else {
    result +=
      `, Standard: GMT${formatTimeZone(p.baseDifferenceSec + p.standardDifferenceSec)}` +
      `, DST: GMT${formatTimeZone(p.baseDifferenceSec + p.daylightDifferenceSec)}`;
  }
  return result;
}

/** yyyy-mm-ddThh:nn:ss.zzzZ — the exact shape the XML log and the ledger use. */
function standardTimestamp(ms) {
  return new Date(ms === undefined ? Date.now() : ms).toISOString().replace(/\.(\d{3})Z$/, '.$1Z');
}

function standardDatestamp(ms) {
  return standardTimestamp(ms).slice(0, 10);
}

const TWO_SECONDS_MS = 2000;

/**
 * CompareFileTime with FAT's two-second precision. A local file stored on FAT
 * has second granularity and a remote one may have milliseconds, so 12:00:00.000
 * and 12:00:01.999 must compare equal or every synchronization would re-copy
 * everything.
 */
function compareFileTime(t1, t2) {
  if (t1 === t2) return 0;
  if (t1 < t2 && (t2 - t1) >= TWO_SECONDS_MS) return -1;
  if (t1 > t2 && (t1 - t2) >= TWO_SECONDS_MS) return 1;
  return 0;
}

/** These three are for spans, not instants — they take milliseconds. */
function timeToMSec(ms) { return round(ms); }
function timeToSeconds(ms) { return Math.trunc(timeToMSec(ms) / 1000); }
function timeToMinutes(ms) { return Math.trunc(timeToSeconds(ms) / 60); }

function tensOfSecondBetween(nowMs, thenMs) {
  return Math.trunc(Math.abs(nowMs - thenMs) / 100);
}

/**
 * FormatDateTimeSpan — 'h:mm:ss' below four days, '%d days' above, which is
 * what the queue's "time left" column shows.
 */
function formatDateTimeSpan(ms, timeSeparator) {
  const sep = timeSeparator === undefined ? ':' : timeSeparator;
  if (!(ms >= 0)) return '';
  const days = Math.trunc(ms / MSECS_PER_DAY);
  if (Math.abs(days) >= 4) return `${days} days`;
  const rest = ms - days * MSECS_PER_DAY;
  const hour = Math.trunc(rest / 3600000);
  const min = Math.trunc(rest / 60000) % 60;
  const sec = Math.trunc(rest / 1000) % 60;
  const totalHours = hour + days * 24;
  const pad = (n) => String(n).padStart(2, '0');
  return `${totalHours}${sep}${pad(min)}${sep}${pad(sec)}`;
}

// Delphi's DateUtils uses approximate lengths for the calendar units, so
// "1 month ago" is 30.4375 days rather than a calendar month. Reproduced so
// the boundaries land where WinSCP's do.
const APPROX_DAYS_PER_YEAR = 365.25;
const APPROX_DAYS_PER_MONTH = 30.4375;

function daysBetween(a, b) { return Math.trunc(Math.abs(a - b) / MSECS_PER_DAY); }
function yearsBetween(a, b) { return Math.trunc(Math.abs(a - b) / MSECS_PER_DAY / APPROX_DAYS_PER_YEAR); }
function monthsBetween(a, b) { return Math.trunc(Math.abs(a - b) / MSECS_PER_DAY / APPROX_DAYS_PER_MONTH); }
function hoursBetween(a, b) { return Math.trunc(Math.abs(a - b) / 3600000); }
function minutesBetween(a, b) { return Math.trunc(Math.abs(a - b) / 60000); }
function secondsBetween(a, b) { return Math.trunc(Math.abs(a - b) / 1000); }
function milliSecondsBetween(a, b) { return Math.trunc(Math.abs(a - b)); }

function isSameDay(aMs, bMs) {
  const a = new Date(aMs);
  const b = new Date(bMs);
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
}

/**
 * FormatRelativeTime — "3 minutes ago". `dateOnly` first tries the friendlier
 * "today"/"yesterday", which is what the site list's last-used column shows.
 */
function formatRelativeTime(nowMs, thenMs, dateOnly) {
  let result = '';
  if (dateOnly) {
    if (isSameDay(thenMs, nowMs - MSECS_PER_DAY)) result = TIME_RELATIVE_PARTS[2];
    else if (isSameDay(thenMs, nowMs)) result = TIME_RELATIVE_PARTS[1];
  }
  if (result) return result;

  let part;
  let num = yearsBetween(nowMs, thenMs);
  if (num > 1) part = 18;
  else if (num === 1) part = 17;
  else {
    num = monthsBetween(nowMs, thenMs);
    if (num > 1) part = 16;
    else if (num === 1) part = 15;
    else {
      num = daysBetween(nowMs, thenMs);
      if (num > 1) part = 12;
      else if (num === 1) part = 11;
      else {
        num = hoursBetween(nowMs, thenMs);
        if (num > 1) part = 10;
        else if (num === 1) part = 9;
        else {
          num = minutesBetween(nowMs, thenMs);
          if (num > 1) part = 8;
          else if (num === 1) part = 7;
          else {
            num = secondsBetween(nowMs, thenMs);
            if (num > 1) part = 6;
            else if (num === 1) part = 5;
            else part = 1;
          }
        }
      }
    }
  }
  return TIME_RELATIVE_PARTS[part - 1].replace('%d', String(Math.abs(num)));
}

/**
 * TryRelativeStrToDateTime — '30D', '2H', '1YS' and the words 'today' and
 * 'yesterday'. A trailing 'S' means "start of": '1DS' is midnight yesterday,
 * not this time yesterday. The unit letters deliberately avoid K/M/G so a mask
 * bound is never ambiguous with a size.
 */
function tryRelativeStrToDateTime(str, add, nowMs) {
  let s = trimBoth(str);
  if (s.toLowerCase() === 'today') s = '0DS';
  else if (s.toLowerCase() === 'yesterday') s = '1DS';

  let index = 0;
  while (index < s.length && isDigit(s[index])) index++;
  const numberStr = s.slice(0, index);
  if (numberStr === '') return { ok: false, dateTime: 0 };
  let number = Number(numberStr);
  if (!Number.isFinite(number)) return { ok: false, dateTime: 0 };
  if (!add) number = -number;

  s = trimBoth(s.slice(index)).toUpperCase();
  const start = s.length === 2 && s[1] === 'S';
  if (start) s = s.slice(0, -1);

  const base = nowMs === undefined ? Date.now() : nowMs;
  const d = new Date(base);
  switch (s) {
    case 'S':
      d.setSeconds(d.getSeconds() + number);
      if (start) d.setMilliseconds(0);
      break;
    case 'N':
      d.setMinutes(d.getMinutes() + number);
      if (start) { d.setSeconds(0, 0); }
      break;
    case 'H':
      d.setHours(d.getHours() + number);
      if (start) { d.setMinutes(0, 0, 0); }
      break;
    case 'D':
      d.setDate(d.getDate() + number);
      if (start) { d.setHours(0, 0, 0, 0); }
      break;
    case 'Y':
      d.setFullYear(d.getFullYear() + number);
      if (start) { d.setMonth(0, 1); d.setHours(0, 0, 0, 0); }
      break;
    default:
      return { ok: false, dateTime: 0 };
  }
  return { ok: true, dateTime: d.getTime() };
}

/** The scripting language's fixed timestamp form: yyyy-mm-dd hh:nn:ss. */
function tryStrToDateTimeStandard(s) {
  const m = /^\s*(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*$/
    .exec(String(s));
  if (!m) return { ok: false, value: 0 };
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return { ok: false, value: 0 };
  const hour = Number(m[4] || 0);
  const min = Number(m[5] || 0);
  const sec = Number(m[6] || 0);
  if (hour > 23 || min > 59 || sec > 59) return { ok: false, value: 0 };
  const d = new Date(year, month - 1, day, hour, min, sec, 0);
  if (d.getMonth() !== month - 1 || d.getDate() !== day) return { ok: false, value: 0 };
  return { ok: true, value: d.getTime() };
}

/** 1-based month number, 0 when the name is not one of the English abbreviations. */
function parseShortEngMonthName(monthStr) {
  const s = String(monthStr).toLowerCase();
  for (let i = 0; i < ENG_SHORT_MONTH_NAMES.length; i++) {
    if (ENG_SHORT_MONTH_NAMES[i].toLowerCase() === s) return i + 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// url helpers
// ---------------------------------------------------------------------------

/** '+' is a space and '%XX' runs decode as UTF-8, so a multi-byte name survives. */
function decodeUrlChars(s) {
  let str = String(s);
  let i = 0;
  while (i < str.length) {
    if (str[i] === '+') {
      str = str.slice(0, i) + ' ' + str.slice(i + 1);
    } else if (str[i] === '%') {
      let hex = '';
      while (i + 2 < str.length && str[i] === '%' && isHex(str[i + 1]) && isHex(str[i + 2])) {
        hex += str.substr(i + 1, 2);
        str = str.slice(0, i) + str.slice(i + 3);
      }
      if (hex) {
        const chars = hexToBytes(hex).toString('utf8');
        str = str.slice(0, i) + chars + str.slice(i);
        i += chars.length - 1;
      }
    }
    i++;
  }
  return str;
}

function doEncodeUrl(s, doNotEncode) {
  let out = '';
  for (const ch of String(s)) {
    if (isLetter(ch) || isDigit(ch) ||
        ch === '_' || ch === '-' || ch === '.' || ch === '*' ||
        doNotEncode.indexOf(ch) >= 0) {
      out += ch;
    } else {
      for (const b of Buffer.from(ch, 'utf8')) out += '%' + byteToHex(b);
    }
  }
  return out;
}

function encodeUrlString(s) { return doEncodeUrl(s, ''); }
function encodeUrlPath(s) { return doEncodeUrl(s, '/'); }

/** Appends parameters before the '#fragment', which must stay last. */
function appendUrlParams(url, params) {
  if (!params) return String(url);
  const cut = cutToChar(url, '#', false);
  let result = cut.token;
  result += result.indexOf('?') < 0 ? '?' : '&';
  result += params;
  return addToList(result, cut.rest, '#');
}

function extractFileNameFromUrl(url) {
  let result = String(url);
  const p = result.indexOf('?');
  if (p >= 0) result = result.slice(0, p);
  const i = result.lastIndexOf('/');
  if (i >= 0) result = result.slice(i + 1);
  return result;
}

function isDomainOrSubdomain(fullDomain, domain) {
  const f = String(fullDomain).toLowerCase();
  const d = String(domain).toLowerCase();
  return f === d || f.endsWith('.' + d);
}

function isHttpUrl(s) {
  return String(s).toLowerCase().startsWith(HTTP_PROTOCOL + PROTOCOL_SEPARATOR);
}

function isHttpOrHttpsUrl(s) {
  return isHttpUrl(s) ||
    String(s).toLowerCase().startsWith(HTTPS_PROTOCOL + PROTOCOL_SEPARATOR);
}

function changeUrlProtocol(s, protocol) {
  const str = String(s);
  const p = str.indexOf(PROTOCOL_SEPARATOR);
  const rest = p >= 0 ? str.slice(p + PROTOCOL_SEPARATOR.length) : str;
  return protocol + PROTOCOL_SEPARATOR + rest;
}

// ---------------------------------------------------------------------------
// base64 / checksums
// ---------------------------------------------------------------------------

function encodeStrToBase64(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), 'binary');
  return buf.toString('base64');
}

function decodeBase64ToStr(str) {
  return Buffer.from(String(str), 'base64');
}

/** RFC 4648 §5 alphabet, padding removed — how a fingerprint becomes a URL. */
function base64ToUrlSafe(s) {
  let result = String(s);
  while (result.endsWith('=')) result = result.slice(0, -1);
  return replaceChar(replaceChar(result, '+', '-'), '/', '_');
}

function md5ToUrlSafe(s) {
  return replaceChar(String(s), ':', NORMALIZED_FINGERPRINT_SEPARATOR);
}

/**
 * SameChecksum. Base64 checksums compare case-SENSITIVELY (the alphabet uses
 * both cases for different values); hex ones do not. Getting this backwards
 * would silently accept a wrong file.
 */
function sameChecksum(checksum1, checksum2, base64) {
  if (base64) return base64ToUrlSafe(checksum1) === base64ToUrlSafe(checksum2);
  return md5ToUrlSafe(checksum1).toLowerCase() === md5ToUrlSafe(checksum2).toLowerCase();
}

/** The 27-dash rule the session log prints between sections. */
function getDividerLine() {
  return '-'.repeat(27);
}

module.exports = {
  // constants
  ANY_MASK, ENG_SHORT_MONTH_NAMES, BOM, XML_DECLARATION, TOKEN_PREFIX,
  NO_REPLACEMENT, TOKEN_REPLACEMENT, LOCAL_INVALID_CHARS, PASSWORD_MASK,
  ELLIPSIS, TITLE_SEPARATOR, HOST_KEY_DELIMITER, PARENT_DIRECTORY,
  THIS_DIRECTORY, NORMALIZED_FINGERPRINT_SEPARATOR, HTTP_PROTOCOL,
  HTTPS_PROTOCOL, PROTOCOL_SEPARATOR, MAIN_MSG_TAG, INTERACTIVE_MSG_TAG,
  SHELL_COMMAND_FILENAME_PATTERN, TIME_RELATIVE_PARTS, DST_MODE, DST_MODE_NAMES,
  // characters
  isLowerCaseLetter, isUpperCaseLetter, isLetter, isDigit, isHex, isWideChar,
  // strings
  replaceChar, deleteChar, makeValidFileName, defaultStr, cutToChar,
  copyToChar, copyToChars, removeSuffix, delimitStr, shellQuoteStr, midStr,
  stripPathQuotes, addQuotes, addPathQuotes, isNumber, trimVersion,
  formatVersion, escapeParam, escapePuttyCommandParam, escapeHotkey,
  stripEllipsis, isReservedName, validLocalFileName, trimLeft, trimRight,
  trimBoth, removeEmptyLines,
  // hex / binary
  byteToHex, bytesToHex, charToHex, hexToBytes, hexToByte, displayableStr,
  // commands
  splitCommand, extractProgram, extractProgramName, formatCommand,
  reformatFileNameCommand, expandFileNameCommand, cutToken, cutTokenEx,
  splitTokens, addToList, addToShellFileListCommandLine, cutFeature,
  processFeatures,
  // comparison
  compareText, compareNumber, naturalCompare, compareLogicalText,
  containsTextSemiCaseSensitive, sameIdent, findIdent,
  // messages
  mainInstructions, hasParagraphs, mainInstructionsFirstParagraph,
  extractMainInstructions, removeMainInstructionsTag, unformatMessage,
  removeInteractiveMsgTag, exceptionLogString, getDividerLine,
  // paths
  includeTrailingBackslash, excludeTrailingBackslash, extractFilePath,
  extractFileName, extractFileDir, extractFileDrive, extractFileExt,
  changeFileExt, extractFileBaseName, isRealFile, samePaths, combinePaths,
  getNormalizedPath, fromUnixPath, toUnixPath,
  // sizes
  round, tryStrToSize, sizeToStr, formatNumber, formatSize,
  // time
  normalizeDstMode, timeZoneParams, clearTimeZoneParamsCache, isDateInDST,
  dstDifferenceMinutesForTime, unixToDateTime, dateTimeToUnix,
  adjustDateTimeFromUnix, convertTimestampToUnix, convertTimestampToUTC,
  convertTimestampFromUTC, fixedLenDateTimeFormat, formatTimeZone,
  getTimeZoneLogString, standardTimestamp, standardDatestamp, compareFileTime,
  timeToMSec, timeToSeconds, timeToMinutes, tensOfSecondBetween,
  formatDateTimeSpan, formatRelativeTime, tryRelativeStrToDateTime,
  tryStrToDateTimeStandard, parseShortEngMonthName, isSameDay,
  daysBetween, yearsBetween, monthsBetween, hoursBetween, minutesBetween,
  secondsBetween, milliSecondsBetween,
  // urls
  decodeUrlChars, encodeUrlString, encodeUrlPath, appendUrlParams,
  extractFileNameFromUrl, isDomainOrSubdomain, isHttpUrl, isHttpOrHttpsUrl,
  changeUrlProtocol,
  // base64
  encodeStrToBase64, decodeBase64ToStr, base64ToUrlSafe, md5ToUrlSafe,
  sameChecksum,
  // constants used by remotefiles.js
  MINS_PER_DAY, SECS_PER_DAY, MSECS_PER_DAY,
};
