// masks.js — WinSCP file masks.
//
// This is a faithful port of core/FileMasks.cpp (TFileMasks). The syntax is
// small but has a lot of corners, and every one of them is load-bearing
// somewhere in the product: the transfer filter, the "text mode" file list,
// the file-colour rules, the synchronization filter and the find dialog all
// use the same string.
//
//   'a*.txt; b?.doc'          two include masks, ';' or ',' separated
//   'a*.txt | *.bak'          everything before '|' includes, after it excludes
//   '-*.bak'                  a leading '-' excludes that one mask
//   'logs/'                   trailing '/' makes it a DIRECTORY mask
//   'docs/*.txt'              a '/' inside makes it a PATH mask
//   '*.txt>1M<=10M'           size bounds ('>' lower, '<' upper, '=' inclusive)
//   '*.log>2019-01-01'        absolute time bound
//   '*.log>30D'               relative time bound: newer than 30 days
//
// Two behaviours surprise people often enough to call out here:
//
//  * '*.*' means EVERYTHING, including names with no dot at all. WinSCP treats
//    it (and '*' and '') as the "any" mask rather than translating it literally.
//    '*.' is the opposite special case: names with no extension.
//  * A directory is tested against the DIRECTORY mask list. When that list is
//    empty every directory implicitly matches, which is what lets a plain
//    '*.txt' filter still recurse into subdirectories instead of pruning them.
'use strict';

/** Delimiters, matching FileMasks.cpp. A doubled delimiter is a literal one. */
const MASK_DELIMITERS = ';,';
const INCLUDE_EXCLUDE_DELIMITER = '|';
const ALL_MASK_DELIMITERS = MASK_DELIMITERS + INCLUDE_EXCLUDE_DELIMITER;
const DIR_DELIMITERS = '/\\';
const BOUNDARY_DELIMITERS = '<>';

/** TryStrToSize accepts exactly these three units, each a further *1024. */
const SIZE_UNITS = { K: 1024, M: 1024 * 1024, G: 1024 * 1024 * 1024 };

/** TryRelativeStrToDateTime accepts exactly these; they may not overlap SIZE_UNITS. */
const TIME_UNITS = { S: 'second', N: 'minute', H: 'hour', D: 'day', Y: 'year' };

/**
 * A malformed mask. `start`/`length` locate the offending run inside the mask
 * string so the UI can underline it inline instead of just saying "bad mask".
 */
class MaskError extends Error {
  constructor(message, start, length) {
    super(message);
    this.name = 'MaskError';
    this.start = Math.max(0, start | 0);
    this.length = Math.max(0, length | 0);
  }
}

// ---------------------------------------------------------------------------
// string helpers
// ---------------------------------------------------------------------------

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function lastIndexOfAny(s, chars) {
  for (let i = s.length - 1; i >= 0; i--) if (chars.includes(s[i])) return i;
  return -1;
}

/** Port of CopyToChars(..., DoubleDelimiterEscapes = true). */
function copyToChars(str, from, chars) {
  let text = '';
  let p = from;
  for (; p < str.length; p++) {
    const c = str[p];
    if (chars.includes(c)) {
      // ';;' inside a mask is a literal ';' — that is how ComposeMaskStr
      // round-trips a name that genuinely contains a delimiter.
      if (p + 1 < str.length && str[p + 1] === c) { text += c; p++; continue; }
      break;
    }
    text += c;
  }
  return { text, delimiter: p < str.length ? str[p] : '', next: p + 1, start: from, end: p - 1 };
}

/** Port of TrimEx: trim, and move the reported error span with the trim. */
function trimEx(text, start, end) {
  const left = text.replace(/^\s+/, '');
  const nstart = start + (text.length - left.length);
  const trimmed = left.replace(/\s+$/, '');
  return { text: trimmed, start: nstart, end: end - (left.length - trimmed.length) };
}

function toUnixPath(p) { return p.replace(/\\/g, '/'); }

/** SimpleUnixExcludeTrailingBackslash: drop a trailing '/' but keep sole '/'. */
function stripTrailingSlash(p) {
  return (p.length > 1 && p.endsWith('/')) ? p.slice(0, -1) : p;
}

/** Directory part of a POSIX path, with no trailing slash ('' when there is none). */
function dirOf(p) {
  if (!p) return '';
  const u = toUnixPath(p);
  const i = u.lastIndexOf('/');
  if (i < 0) return '';
  if (i === 0) return '/';
  return u.slice(0, i);
}

function baseOf(p) {
  if (!p) return '';
  const u = toUnixPath(p);
  const i = u.lastIndexOf('/');
  return i < 0 ? u : u.slice(i + 1);
}

// ---------------------------------------------------------------------------
// mask -> regex (the Delphi Masks.TMask grammar)
// ---------------------------------------------------------------------------

/**
 * Translate one wildcard piece into an anchored RegExp.
 *
 * Grammar: '*' any run, '?' one character, '[abc]' / '[a-z]' a set,
 * '[!abc]' / '[^abc]' a negated set. Everything else is literal.
 *
 * Matching is case-insensitive by default because that is what Delphi's
 * Masks.TMask does and therefore what every WinSCP mask has always meant —
 * '*.TXT' and '*.txt' are the same filter. `caseSensitive` is offered for the
 * synchronizer, which can be told to treat names case-sensitively.
 */
function maskToRegex(piece, options) {
  const caseSensitive = !!(options && options.caseSensitive);
  const at = (options && options.offset) || 0;
  let out = '';
  let i = 0;
  while (i < piece.length) {
    const c = piece[i];
    if (c === '*') { out += '.*'; i++; continue; }
    if (c === '?') { out += '.'; i++; continue; }
    if (c === '[') {
      let j = i + 1;
      let negate = false;
      if (piece[j] === '!' || piece[j] === '^') { negate = true; j++; }
      let body = '';
      // A ']' immediately after '[' (or after the negation) is a literal ']'.
      if (piece[j] === ']') { body += '\\]'; j++; }
      let closed = false;
      while (j < piece.length) {
        if (piece[j] === ']') { closed = true; break; }
        if (piece[j + 1] === '-' && j + 2 < piece.length && piece[j + 2] !== ']') {
          body += `${escapeRe(piece[j])}-${escapeRe(piece[j + 2])}`;
          j += 3;
          continue;
        }
        body += escapeRe(piece[j]);
        j++;
      }
      if (!closed) {
        throw new MaskError(
          `Unterminated character set "[" in mask "${piece}" — add the closing "]".`,
          at + i, piece.length - i);
      }
      if (body === '') {
        throw new MaskError(
          `Empty character set "[]" in mask "${piece}".`, at + i, j - i + 1);
      }
      out += `[${negate ? '^' : ''}${body}]`;
      i = j + 1;
      continue;
    }
    out += escapeRe(c);
    i++;
  }
  return new RegExp(`^${out}$`, caseSensitive ? '' : 'i');
}

/** IsEffectiveFileNameMask: '', '*' and '*.*' all mean "everything". */
function isEffectiveFileNameMask(mask) {
  return mask !== '' && mask !== '*' && mask !== '*.*';
}

/** IsMask: does this string actually contain a wildcard? */
function isMask(str) {
  return typeof str === 'string' && lastIndexOfAny(str, '?*[') >= 0;
}

/**
 * CreateMaskMask. `effective` mirrors the C++ `Ex` flag: the file-name half of
 * a mask gets the "any"/"no extension" shortcuts, the directory half never does.
 */
function createMaskMask(maskStr, effective, caseSensitive, offset) {
  if (effective && !isEffectiveFileNameMask(maskStr)) {
    return { kind: 'any', re: null, src: maskStr };
  }
  const kind = (effective && maskStr === '*.') ? 'noext' : 'regular';
  return { kind, re: maskToRegex(maskStr, { caseSensitive, offset }), src: maskStr };
}

function matchesMaskMask(m, str) {
  if (!m || m.kind === 'any') return true;
  // '*.' means "no extension at all", which a literal translation would miss.
  if (m.kind === 'noext' && !str.includes('.')) return true;
  return m.re.test(str);
}

// ---------------------------------------------------------------------------
// size and time literals
// ---------------------------------------------------------------------------

/** Port of TryStrToSize: digits, then at most one of K / M / G. */
function tryStrToSize(str) {
  const m = /^(\d+)\s*([A-Za-z])?$/.exec(str.trim());
  if (!m) return null;
  let size = Number(m[1]);
  if (!Number.isSafeInteger(size)) return null;
  if (m[2]) {
    const unit = SIZE_UNITS[m[2].toUpperCase()];
    if (!unit) return null;
    size *= unit;
  }
  return size;
}

/** Is this a plain integer? WinSCP checks this FIRST, so '>2019' is 2019 bytes. */
function isPlainInteger(str) {
  return /^-?\d+$/.test(str.trim());
}

/**
 * Port of TryStrToDateTimeStandard — Delphi's TryStrToDateTime with
 * ShortDateFormat 'yyyy/mm/dd' and DateSeparator '-'. Values are LOCAL time,
 * because the timestamps they are compared against are local too.
 */
function tryStrToDateTime(str, now) {
  const s = str.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]),
      Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0), 0);
    if (Number.isNaN(d.getTime())) return null;
    // Reject impossible dates that Date silently rolls over (2019-02-31).
    if (d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) return null;
    return d.getTime();
  }
  m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (m) {
    const base = new Date(now);
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate(),
      Number(m[1]), Number(m[2]), Number(m[3] || 0), 0);
    if (Number.isNaN(d.getTime())) return null;
    return d.getTime();
  }
  return null;
}

/**
 * Port of TryRelativeStrToDateTime(Add = false): '<n><unit>' counted BACKWARDS
 * from now, so '>30D' reads "modified within the last 30 days". A trailing 'S'
 * ("start") truncates to the beginning of that unit, which is how 'today'
 * ('0DS') and 'yesterday' ('1DS') are expressed.
 *
 * Returns a descriptor rather than a timestamp: a parsed mask can outlive the
 * moment it was parsed (a saved transfer preset lives for years), and '30D'
 * must keep meaning "the last 30 days", not "the 30 days before the app
 * started". Resolution happens at match time.
 */
function tryRelativeTime(str) {
  let s = str.trim();
  if (/^today$/i.test(s)) s = '0DS';
  else if (/^yesterday$/i.test(s)) s = '1DS';

  const m = /^(\d+)\s*([A-Za-z]{1,2})$/.exec(s);
  if (!m) return null;
  let rest = m[2].toUpperCase();
  let start = false;
  if (rest.length === 2 && rest[1] === 'S') { start = true; rest = rest[0]; }
  if (rest.length !== 1) return null;
  const unit = TIME_UNITS[rest];
  if (!unit) return null;
  return { relative: true, number: -Number(m[1]), unit, start };
}

/** Resolve a relative descriptor against `now` (epoch ms). */
function resolveTime(bound, now) {
  if (!bound.relative) return bound.value;
  const d = new Date(now);
  switch (bound.unit) {
    case 'second': d.setSeconds(d.getSeconds() + bound.number); break;
    case 'minute': d.setMinutes(d.getMinutes() + bound.number); break;
    case 'hour': d.setHours(d.getHours() + bound.number); break;
    case 'day': d.setDate(d.getDate() + bound.number); break;
    case 'year': d.setFullYear(d.getFullYear() + bound.number); break;
    default: break;
  }
  if (bound.start) {
    switch (bound.unit) {
      case 'second': d.setMilliseconds(0); break;
      case 'minute': d.setSeconds(0, 0); break;
      case 'hour': d.setMinutes(0, 0, 0); break;
      case 'day': d.setHours(0, 0, 0, 0); break;
      case 'year': d.setMonth(0, 1); d.setHours(0, 0, 0, 0); break;
      default: break;
    }
  }
  return d.getTime();
}

// ---------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------

function emptyMask(userStr) {
  return {
    userStr,
    maskStr: userStr,
    directory: false,
    name: { kind: 'any', re: null, src: '' },
    dir: { kind: 'any', re: null, src: '' },
    dirRelative: null,      // set for './x' masks, resolved against a root
    highSize: null,         // {bound:'open'|'close', value}
    lowSize: null,
    highTime: null,         // {bound, value} or {bound, relative, number, unit, start}
    lowTime: null,
  };
}

/** Port of TFileMasks::CreateMask for a single already-split mask piece. */
function createMask(maskStr, maskStart, forceDirectoryMasks, caseSensitive, now) {
  const mask = emptyMask(maskStr);
  let directory = false;

  let nextDelimiter = '';
  let from = 0;
  while (from < maskStr.length) {
    const partDelimiter = nextDelimiter;
    const r = copyToChars(maskStr, from, BOUNDARY_DELIMITERS);
    nextDelimiter = r.delimiter;
    from = r.next;
    const t = trimEx(r.text, maskStart + r.start, maskStart + r.end);
    let partStr = t.text;
    const partStart = t.start;
    const partLen = Math.max(1, t.end - t.start + 1);

    if (partDelimiter !== '') {
      // '>' constrains the LOW end, '<' the HIGH end; a leading '=' includes
      // the boundary itself.
      const low = partDelimiter === '>';
      let bound = 'open';
      if (partStr.startsWith('=')) { bound = 'close'; partStr = partStr.slice(1); }

      let time = null;
      if (!isPlainInteger(partStr)) {
        const abs = tryStrToDateTime(partStr, now);
        if (abs !== null) time = { bound, relative: false, value: abs, src: partStr };
      }
      if (time === null) {
        const rel = tryRelativeTime(partStr);
        if (rel) time = { bound, ...rel, src: partStr };
      }

      if (time !== null) {
        const key = low ? 'lowTime' : 'highTime';
        if (mask[key] !== null || directory) {
          throw new MaskError(
            directory
              ? `A directory mask cannot carry a size or time condition ("${partDelimiter}${partStr}").`
              : `Duplicate ${low ? 'lower' : 'upper'} time bound "${partDelimiter}${partStr}".`,
            partStart - 1, partLen + 1);
        }
        mask[key] = time;
      } else {
        const key = low ? 'lowSize' : 'highSize';
        if (mask[key] !== null || directory) {
          throw new MaskError(
            directory
              ? `A directory mask cannot carry a size or time condition ("${partDelimiter}${partStr}").`
              : `Duplicate ${low ? 'lower' : 'upper'} size bound "${partDelimiter}${partStr}".`,
            partStart - 1, partLen + 1);
        }
        const size = tryStrToSize(partStr);
        if (size === null) {
          throw new MaskError(
            `"${partStr}" is not a size (digits optionally followed by K, M or G) `
            + 'nor a date (YYYY-MM-DD) nor a relative time (30D, 2H, today).',
            partStart, partLen);
        }
        mask[key] = { bound, value: size };
      }
    } else if (partStr !== '') {
      let d = lastIndexOfAny(partStr, DIR_DELIMITERS);
      directory = d >= 0 && d === partStr.length - 1;

      if (directory) {
        while (partStr.length && DIR_DELIMITERS.includes(partStr[partStr.length - 1])) {
          partStr = partStr.slice(0, -1);
        }
        d = lastIndexOfAny(partStr, DIR_DELIMITERS);
        if (forceDirectoryMasks === 0) directory = false;
      } else if (forceDirectoryMasks > 0) {
        directory = true;
      }

      if (d >= 0) {
        // A '/' anywhere makes this a path mask: the part before the last
        // delimiter is matched against the item's directory, the rest against
        // its name.
        let dirMaskStr = stripTrailingSlash(toUnixPath(partStr.slice(0, d + 1)));
        if (dirMaskStr === '.') {
          mask.dirRelative = '';
        } else if (dirMaskStr.startsWith('./')) {
          mask.dirRelative = dirMaskStr.slice(2);
        }
        mask.dir = createMaskMask(dirMaskStr, false, caseSensitive, partStart);
        mask.name = createMaskMask(partStr.slice(d + 1), true, caseSensitive, partStart + d + 1);
      } else {
        mask.name = createMaskMask(partStr, true, caseSensitive, partStart);
      }
    }
  }

  mask.directory = directory;
  return mask;
}

/**
 * Parse a WinSCP mask string.
 *
 * options:
 *   caseSensitive         match names case-sensitively (default false)
 *   forceDirectoryMasks   -1 auto (default), 0 never, 1 always — mirrors the
 *                         C++ constructor used by the mask-editing dialog
 *   root                  base directory for './' relative path masks
 *   now                   epoch ms used to anchor 'HH:MM' literals
 */
function parse(maskString, options) {
  const opts = options || {};
  const caseSensitive = !!opts.caseSensitive;
  const forceDirectoryMasks = opts.forceDirectoryMasks === undefined ? -1 : opts.forceDirectoryMasks;
  const now = opts.now === undefined ? Date.now() : opts.now;
  const str = maskString == null ? '' : String(maskString);

  const parsed = {
    str,
    caseSensitive,
    root: opts.root || '',
    fileInclude: [],
    fileExclude: [],
    dirInclude: [],
    dirExclude: [],
    anyRelative: false,
  };

  let from = 0;
  let include = true;
  while (from < str.length) {
    const r = copyToChars(str, from, ALL_MASK_DELIMITERS);
    const delimiter = r.delimiter;
    const nextFrom = r.next;
    const t = trimEx(r.text, r.start, r.end);
    let maskStr = t.text;
    let maskStart = t.start;
    let maskInclude = include;

    if (maskStr !== '') {
      // A leading '-' excludes just this one mask, wherever it sits. WinSCP's
      // own syntax only has the '|' section split; the dash is this port's
      // shorthand (a literal leading dash can still be written as '[-]').
      if (maskStr.length > 1 && maskStr[0] === '-') {
        maskInclude = false;
        maskStr = maskStr.slice(1);
        maskStart += 1;
      }
      const mask = createMask(maskStr, maskStart, forceDirectoryMasks, caseSensitive, now);
      if (mask.dirRelative !== null) parsed.anyRelative = true;
      const bucket = (mask.directory ? 'dir' : 'file') + (maskInclude ? 'Include' : 'Exclude');
      parsed[bucket].push(mask);
    }

    from = nextFrom;
    if (delimiter === INCLUDE_EXCLUDE_DELIMITER) {
      if (include) {
        include = false;
      } else {
        throw new MaskError(
          'The include/exclude separator "|" can only appear once. '
          + 'Everything after it is an exclude mask.',
          nextFrom - 1, Math.max(1, str.length - nextFrom + 1));
      }
    }
  }

  return parsed;
}

/**
 * Validate a mask string for the UI. Never throws.
 * Returns { ok: true } or { ok: false, error, start, length }.
 */
function validate(maskString, options) {
  try {
    parse(maskString, options);
    return { ok: true };
  } catch (e) {
    if (e instanceof MaskError) {
      return { ok: false, error: e.message, start: e.start, length: e.length };
    }
    return { ok: false, error: e.message, start: 0, length: (maskString || '').length };
  }
}

// ---------------------------------------------------------------------------
// matching
// ---------------------------------------------------------------------------

function checkSize(mask, size, hasSize) {
  if (mask.highSize) {
    if (!hasSize) return false;
    if (mask.highSize.bound === 'open' ? !(size < mask.highSize.value) : !(size <= mask.highSize.value)) return false;
  }
  if (mask.lowSize) {
    if (!hasSize) return false;
    if (mask.lowSize.bound === 'open' ? !(size > mask.lowSize.value) : !(size >= mask.lowSize.value)) return false;
  }
  return true;
}

function checkTime(mask, mtime, hasTime, now) {
  if (mask.highTime) {
    if (!hasTime) return false;
    const v = resolveTime(mask.highTime, now);
    if (mask.highTime.bound === 'open' ? !(mtime < v) : !(mtime <= v)) return false;
  }
  if (mask.lowTime) {
    if (!hasTime) return false;
    const v = resolveTime(mask.lowTime, now);
    if (mask.lowTime.bound === 'open' ? !(mtime > v) : !(mtime >= v)) return false;
  }
  return true;
}

/** Effective directory pattern for a mask, resolving './' against a root. */
function dirMatcher(mask, parsed, root) {
  if (mask.dirRelative === null) return mask.dir;
  const base = stripTrailingSlash(toUnixPath(root || parsed.root || ''));
  if (!base) return mask.dir;      // no root known — keep the literal '.' form
  const wanted = mask.dirRelative ? `${base}/${mask.dirRelative}` : base;
  if (!mask.relCache) mask.relCache = new Map();
  let m = mask.relCache.get(wanted);
  if (!m) {
    m = createMaskMask(wanted, false, parsed.caseSensitive, 0);
    mask.relCache.set(wanted, m);
  }
  return m;
}

/** Port of MatchesMasks, including the walk up the path for directories. */
function matchesList(name, path, isDir, size, mtime, hasParams, now, list, parsed, recurse, root) {
  for (const mask of list) {
    const dm = dirMatcher(mask, parsed, root);
    if (!matchesMaskMask(dm, path)) continue;
    if (!matchesMaskMask(mask.name, name)) continue;
    if (!checkSize(mask, size, hasParams)) continue;
    if (!checkTime(mask, mtime, hasParams, now)) continue;
    return true;
  }

  // A directory that does not match itself still matches if one of its
  // ancestors does — that is what makes 'excluded-dir/' prune a whole subtree.
  if (isDir && recurse && path && path !== '/') {
    const parentName = baseOf(path);
    const parentPath = dirOf(path);
    if (parentName) {
      return matchesList(parentName, parentPath, true, size, mtime, hasParams, now,
        list, parsed, recurse, root);
    }
  }
  return false;
}

/**
 * Match one item against a parsed mask.
 *
 * params: { isDir, size, mtime, path, root, now }
 *   `path`  full path of the item (its directory half is what a path mask
 *           tests); omit it for a plain name-only test.
 *   `size`  bytes, `mtime` epoch ms. When either is absent every size/time
 *           mask fails, exactly as the C++ does when Params is NULL.
 *
 * Returns { matched, implicit } where `implicit` means the item was only let
 * through because the relevant include list was empty (the caller uses this to
 * distinguish "explicitly wanted" from "not filtered out").
 */
function matchesEx(name, params, parsed) {
  const p = params || {};
  const isDir = !!p.isDir;
  const now = p.now === undefined ? Date.now() : p.now;
  const hasParams = p.size !== undefined || p.mtime !== undefined;
  const size = p.size === undefined ? 0 : p.size;
  const mtime = p.mtime === undefined ? 0 : p.mtime;
  const path = p.path ? stripTrailingSlash(dirOf(toUnixPath(p.path))) : '';
  const root = p.root;

  const inc = isDir ? parsed.dirInclude : parsed.fileInclude;
  const exc = isDir ? parsed.dirExclude : parsed.fileExclude;

  const implicitInclude = inc.length === 0;
  const explicitInclude = !implicitInclude
    && matchesList(name, path, isDir, size, mtime, hasParams, now, inc, parsed, true, root);
  const excluded = matchesList(name, path, isDir, size, mtime, hasParams, now, exc, parsed, false, root);

  const matched = (implicitInclude || explicitInclude) && !excluded;
  const implicit = matched && implicitInclude && !explicitInclude && exc.length === 0;
  return { matched, implicit };
}

/** matches(name, params, parsed) -> boolean */
function matches(name, params, parsed) {
  return matchesEx(name, params, parsed).matched;
}

/** True when the mask string filters nothing at all (the common fast path). */
function isEmpty(parsed) {
  return parsed.fileInclude.length === 0 && parsed.fileExclude.length === 0
    && parsed.dirInclude.length === 0 && parsed.dirExclude.length === 0;
}

/**
 * A reusable matcher: parses once, then answers many items. Every engine in
 * this app filters thousands of entries against the same string, so parsing
 * per entry would be the dominant cost.
 */
class FileMask {
  constructor(maskString, options) {
    this.parsed = parse(maskString, options);
    this.empty = isEmpty(this.parsed);
  }

  matches(name, params) {
    if (this.empty) return true;
    return matches(name, params, this.parsed);
  }

  matchesEx(name, params) {
    if (this.empty) return { matched: true, implicit: true };
    return matchesEx(name, params, this.parsed);
  }
}

module.exports = {
  MaskError,
  FileMask,
  parse,
  matches,
  matchesEx,
  maskToRegex,
  validate,
  isMask,
  isEmpty,
  isEffectiveFileNameMask,
  tryStrToSize,
  tryRelativeTime,
  tryStrToDateTime,
  resolveTime,
  dirOf,
  baseOf,
};
