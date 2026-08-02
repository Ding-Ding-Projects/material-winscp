// ui/dialogs/editmask.js — forms/EditMask.dfm (TEditMaskDialog).
//
// The four memos WinSCP has (include/exclude files, include/exclude
// directories), the "All (do not recurse)" shortcut, the live composed mask,
// and the hints. Everything is driven by the same grammar the engine uses.
//
// Why the grammar is ported here rather than called over IPC: the renderer
// needs to say *why* a mask is malformed while the user is still typing, and
// where — an underline under the offending run, not a shrug after OK. The port
// is validation-only (design/main/masks.js remains the one matcher, and the
// dialog asks it over IPC to decide what actually matches), and
// test/dialogs-fileops.test.js asserts message-for-message and
// position-for-position agreement with it, so the two cannot drift.

import { h, uid, clear, appearanceTarget, debounce } from '../../dom.js';
import { t, bindRender } from '../../i18n.js';
import { registerDialog, openDialog } from '../../app.js';
import { notify } from '../notifications.js';
import { createSearchBar, filterBy, noMatchMessage } from '../searchbar.js';
import { makeTranslator, txLabel, ops, checkRow } from './rights.js';

/* ================================================================== */
/* the grammar, validation half                                        */
/* ================================================================== */

const MASK_DELIMITERS = ';,';
const INCLUDE_EXCLUDE_DELIMITER = '|';
const ALL_MASK_DELIMITERS = MASK_DELIMITERS + INCLUDE_EXCLUDE_DELIMITER;
const DIR_DELIMITERS = '/\\';
const BOUNDARY_DELIMITERS = '<>';
const JOIN = '; ';

const SIZE_UNITS = { K: 1024, M: 1024 * 1024, G: 1024 * 1024 * 1024 };
const TIME_UNITS = { S: 'second', N: 'minute', H: 'hour', D: 'day', Y: 'year' };

/** Mirrors masks.js's MaskError: the message plus where in the string it is. */
export class MaskError extends Error {
  constructor(message, start, length) {
    super(message);
    this.name = 'MaskError';
    this.start = Math.max(0, start | 0);
    this.length = Math.max(0, length | 0);
  }
}

function lastIndexOfAny(s, chars) {
  for (let i = s.length - 1; i >= 0; i -= 1) if (chars.includes(s[i])) return i;
  return -1;
}

/** CopyToChars with DoubleDelimiterEscapes: ';;' is a literal ';'. */
function copyToChars(str, from, chars) {
  let text = '';
  let p = from;
  for (; p < str.length; p += 1) {
    const c = str[p];
    if (chars.includes(c)) {
      if (p + 1 < str.length && str[p + 1] === c) { text += c; p += 1; continue; }
      break;
    }
    text += c;
  }
  return { text, delimiter: p < str.length ? str[p] : '', next: p + 1, start: from, end: p - 1 };
}

function trimEx(text, start, end) {
  const left = text.replace(/^\s+/, '');
  const nstart = start + (text.length - left.length);
  const trimmed = left.replace(/\s+$/, '');
  return { text: trimmed, start: nstart, end: end - (left.length - trimmed.length) };
}

function toUnixPath(p) { return p.replace(/\\/g, '/'); }
function stripTrailingSlash(p) { return (p.length > 1 && p.endsWith('/')) ? p.slice(0, -1) : p; }

/**
 * The wildcard grammar's only structural errors: an unterminated or empty
 * character set. Word for word and position for position with masks.js's
 * maskToRegex, which is what the cross-check test pins down.
 */
function checkWildcard(piece, offset) {
  let i = 0;
  while (i < piece.length) {
    const c = piece[i];
    if (c === '*' || c === '?') { i += 1; continue; }
    if (c === '[') {
      let j = i + 1;
      if (piece[j] === '!' || piece[j] === '^') j += 1;
      let body = '';
      if (piece[j] === ']') { body += ']'; j += 1; }
      let closed = false;
      while (j < piece.length) {
        if (piece[j] === ']') { closed = true; break; }
        if (piece[j + 1] === '-' && j + 2 < piece.length && piece[j + 2] !== ']') { body += '-'; j += 3; continue; }
        body += piece[j];
        j += 1;
      }
      if (!closed) {
        throw new MaskError(
          `Unterminated character set "[" in mask "${piece}" — add the closing "]".`,
          offset + i, piece.length - i);
      }
      if (body === '') {
        throw new MaskError(`Empty character set "[]" in mask "${piece}".`, offset + i, j - i + 1);
      }
      i = j + 1;
      continue;
    }
    i += 1;
  }
}

function isEffectiveFileNameMask(mask) { return mask !== '' && mask !== '*' && mask !== '*.*'; }

function checkMaskMask(maskStr, effective, offset) {
  if (effective && !isEffectiveFileNameMask(maskStr)) return;
  checkWildcard(maskStr, offset);
}

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

function isPlainInteger(str) { return /^-?\d+$/.test(str.trim()); }

function tryStrToDateTime(str, now) {
  const s = str.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]),
      Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0), 0);
    if (Number.isNaN(d.getTime())) return null;
    if (d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) return null;
    return d.getTime();
  }
  m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (m) {
    const base = new Date(now);
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate(),
      Number(m[1]), Number(m[2]), Number(m[3] || 0), 0);
    return Number.isNaN(d.getTime()) ? null : d.getTime();
  }
  return null;
}

function tryRelativeTime(str) {
  let s = str.trim();
  if (/^today$/i.test(s)) s = '0DS';
  else if (/^yesterday$/i.test(s)) s = '1DS';
  const m = /^(\d+)\s*([A-Za-z]{1,2})$/.exec(s);
  if (!m) return null;
  let rest = m[2].toUpperCase();
  if (rest.length === 2 && rest[1] === 'S') rest = rest[0];
  if (rest.length !== 1) return null;
  return TIME_UNITS[rest] ? { unit: TIME_UNITS[rest] } : null;
}

/** One mask piece: the name/path half plus any size and time bounds. */
function checkMask(maskStr, maskStart, now) {
  let directory = false;
  const seen = { lowTime: false, highTime: false, lowSize: false, highSize: false };

  let nextDelimiter = '';
  let from = 0;
  while (from < maskStr.length) {
    const partDelimiter = nextDelimiter;
    const r = copyToChars(maskStr, from, BOUNDARY_DELIMITERS);
    nextDelimiter = r.delimiter;
    from = r.next;
    const trimmed = trimEx(r.text, maskStart + r.start, maskStart + r.end);
    let partStr = trimmed.text;
    const partStart = trimmed.start;
    const partLen = Math.max(1, trimmed.end - trimmed.start + 1);

    if (partDelimiter !== '') {
      const low = partDelimiter === '>';
      if (partStr.startsWith('=')) partStr = partStr.slice(1);

      let isTime = false;
      if (!isPlainInteger(partStr) && tryStrToDateTime(partStr, now) !== null) isTime = true;
      if (!isTime && tryRelativeTime(partStr)) isTime = true;

      if (isTime) {
        const key = low ? 'lowTime' : 'highTime';
        if (seen[key] || directory) {
          throw new MaskError(
            directory
              ? `A directory mask cannot carry a size or time condition ("${partDelimiter}${partStr}").`
              : `Duplicate ${low ? 'lower' : 'upper'} time bound "${partDelimiter}${partStr}".`,
            partStart - 1, partLen + 1);
        }
        seen[key] = true;
      } else {
        const key = low ? 'lowSize' : 'highSize';
        if (seen[key] || directory) {
          throw new MaskError(
            directory
              ? `A directory mask cannot carry a size or time condition ("${partDelimiter}${partStr}").`
              : `Duplicate ${low ? 'lower' : 'upper'} size bound "${partDelimiter}${partStr}".`,
            partStart - 1, partLen + 1);
        }
        if (tryStrToSize(partStr) === null) {
          throw new MaskError(
            `"${partStr}" is not a size (digits optionally followed by K, M or G) `
            + 'nor a date (YYYY-MM-DD) nor a relative time (30D, 2H, today).',
            partStart, partLen);
        }
        seen[key] = true;
      }
    } else if (partStr !== '') {
      let d = lastIndexOfAny(partStr, DIR_DELIMITERS);
      directory = d >= 0 && d === partStr.length - 1;
      if (directory) {
        while (partStr.length && DIR_DELIMITERS.includes(partStr[partStr.length - 1])) {
          partStr = partStr.slice(0, -1);
        }
        d = lastIndexOfAny(partStr, DIR_DELIMITERS);
      }
      if (d >= 0) {
        const dirMaskStr = stripTrailingSlash(toUnixPath(partStr.slice(0, d + 1)));
        checkMaskMask(dirMaskStr, false, partStart);
        checkMaskMask(partStr.slice(d + 1), true, partStart + d + 1);
      } else {
        checkMaskMask(partStr, true, partStart);
      }
    }
  }
  return directory;
}

/**
 * Walk a whole mask string. Returns the four buckets of user strings — which
 * is exactly what the four memos hold — and throws MaskError on the first
 * problem, with the offending run located.
 */
export function parseMaskString(maskString, options = {}) {
  const str = maskString == null ? '' : String(maskString);
  const now = options.now === undefined ? Date.now() : options.now;
  const out = { fileInclude: [], fileExclude: [], dirInclude: [], dirExclude: [] };

  let from = 0;
  let include = true;
  while (from < str.length) {
    const r = copyToChars(str, from, ALL_MASK_DELIMITERS);
    const delimiter = r.delimiter;
    const nextFrom = r.next;
    const trimmed = trimEx(r.text, r.start, r.end);
    let maskStr = trimmed.text;
    let maskStart = trimmed.start;
    let maskInclude = include;

    if (maskStr !== '') {
      if (maskStr.length > 1 && maskStr[0] === '-') {
        maskInclude = false;
        maskStr = maskStr.slice(1);
        maskStart += 1;
      }
      const directory = checkMask(maskStr, maskStart, now);
      out[(directory ? 'dir' : 'file') + (maskInclude ? 'Include' : 'Exclude')].push(maskStr);
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
  return out;
}

/**
 * Validate for the UI. Never throws.
 * { ok: true, buckets } or { ok: false, error, start, length }.
 */
export function validateMask(maskString, options = {}) {
  try {
    return { ok: true, buckets: parseMaskString(maskString, options) };
  } catch (e) {
    if (e instanceof MaskError) return { ok: false, error: e.message, start: e.start, length: e.length };
    return { ok: false, error: e.message, start: 0, length: (maskString || '').length };
  }
}

/** MakeDirectoryMask: a directory mask always ends in a slash. */
function makeDirectoryMask(str) {
  if (!str) return str;
  if (DIR_DELIMITERS.includes(str[str.length - 1])) return str;
  const d = lastIndexOfAny(str, DIR_DELIMITERS);
  const delimiter = d > 0 ? str[d] : '/';
  return str + delimiter;
}

/** Double every delimiter inside one authored mask, so it survives joining. */
function escapeDelimiters(str) {
  let out = '';
  for (const c of str) out += ALL_MASK_DELIMITERS.includes(c) ? c + c : c;
  return out;
}

function composeOne(lines, directory) {
  const parts = [];
  for (const raw of lines) {
    let str = String(raw || '').trim();
    if (!str) continue;
    str = escapeDelimiters(str);
    if (directory) str = makeDirectoryMask(str);
    else while (str.length && DIR_DELIMITERS.includes(str[str.length - 1])) str = str.slice(0, -1);
    parts.push(str);
  }
  return parts.join(JOIN);
}

/** TFileMasks::ComposeMaskStr — the four lists back into one mask string. */
export function composeMaskStr(includeFiles, excludeFiles, includeDirs, excludeDirs) {
  const include = [composeOne(includeFiles || [], false), composeOne(includeDirs || [], true)]
    .filter(Boolean).join(JOIN);
  const exclude = [composeOne(excludeFiles || [], false), composeOne(excludeDirs || [], true)]
    .filter(Boolean).join(JOIN);
  if (!exclude) return include;
  return include ? `${include} ${INCLUDE_EXCLUDE_DELIMITER} ${exclude}` : `${INCLUDE_EXCLUDE_DELIMITER} ${exclude}`;
}

/* ================================================================== */
/* the dialog                                                          */
/* ================================================================== */

const STRINGS = {
  emTitle: ['Edit file mask', '編輯檔案遮罩'],
  emFilesGroup: ['File masks', '檔案遮罩'],
  emDirsGroup: ['Directory masks', '目錄遮罩'],
  emIncludeFiles: ['Include files', '包含檔案'],
  emExcludeFiles: ['Exclude files', '排除檔案'],
  emIncludeDirs: ['Include directories', '包含目錄'],
  emExcludeDirs: ['Exclude directories', '排除目錄'],
  emAllNoRecurse: ['All (do not recurse)', '全部（唔遞迴）'],
  emMask: ['Mask', '遮罩'],
  emOnePerLine: ['One mask per line.', '一行一個遮罩。'],
  emHintWildcards: [
    '* matches any number of characters. ? matches exactly one character. [abc] matches one character from the set. [a-z] matches one from the range. Example: *.html; photo??.png',
    '* 代表任何數量嘅字元；? 代表啱啱一個字元；[abc] 代表集合入面一個字元；[a-z] 代表範圍入面一個。例：*.html; photo??.png'],
  emHintSizeTime: [
    '>size matches a file larger than size, <size smaller. >yyyy-mm-dd matches a file modified after the date, < before it. Example: *.zip>1G; <2012-01-21',
    '>大小 = 大過個大小；<大小 = 細過。>yyyy-mm-dd = 呢個日期之後改過；< 就係之前。例：*.zip>1G; <2012-01-21'],
  emHintCombining: [
    'Masks are separated by a semicolon or a comma. Put exclude masks after a pipe.',
    '遮罩用分號或者逗號分開。排除嘅遮罩擺喺直線之後。'],
  emHintPath: [
    'A mask can be extended with a path mask. Example: */public_html/*.html',
    '遮罩可以加上路徑遮罩。例：*/public_html/*.html'],
  emHintDirectory: ['A mask ending with a slash selects directories.', '以斜線結尾嘅遮罩揀目錄。'],
  emSample: ['Test against these names', '用呢啲名試下'],
  emSampleSearch: ['Search the test names', '搵測試用嘅名'],
  emMatches: ['matches', '符合'],
  emNoMatch: ['no match', '唔符合'],
  emTestUnavailable: [
    'Matching is evaluated by the application’s mask engine, which this window cannot reach right now — the syntax check above still applies.',
    '配對係由程式嘅遮罩引擎計，而家呢個視窗接觸唔到佢——上面嘅語法檢查照計。'],
  emInvalidAt: ['Problem at character {0}: {1}', '第 {0} 個字元有問題：{1}'],
  emValid: ['The mask is valid.', '遮罩正確。'],
  emEmpty: ['An empty mask matches everything.', '空遮罩即係乜都符合。'],
  emClear: ['Clear', '清空'],
};

const tx = makeTranslator(STRINGS);

/** The hint block WinSCP shows under the mask fields. */
export function maskHints() {
  return [
    tx('emHintWildcards'), tx('emHintSizeTime'), tx('emHintCombining'),
    tx('emHintPath'), tx('emHintDirectory'),
  ];
}

function memo(labelKey, rows = 4) {
  const id = uid('memo');
  const area = h('textarea', {
    class: 'field-input', id, rows: String(rows), spellcheck: 'false',
    style: { width: '100%', minHeight: `calc(${rows * 22}px * var(--den))`, fontFamily: 'var(--mono)' },
  });
  const label = h('label', { class: 'field-label', for: id });
  bindRender(label, () => { label.textContent = tx(labelKey); });
  const wrap = h('div', { class: 'field', style: { minWidth: 0 } }, label, area);
  return { element: wrap, area };
}

/**
 * props:
 *   mask            the mask string being edited
 *   sampleNames     real names from the panel, so the test list is not invented
 *   onApply(mask)   called with the composed mask when OK is pressed
 */
registerDialog('editmask', ({ props, close }) => {
  const includeFiles = memo('emIncludeFiles');
  const excludeFiles = memo('emExcludeFiles');
  const includeDirs = memo('emIncludeDirs');
  const excludeDirs = memo('emExcludeDirs');
  let changingExcludeAll = false;

  const initial = validateMask(props.mask || '');
  if (initial.ok) {
    includeFiles.area.value = initial.buckets.fileInclude.join('\n');
    excludeFiles.area.value = initial.buckets.fileExclude.join('\n');
    includeDirs.area.value = initial.buckets.dirInclude.join('\n');
    excludeDirs.area.value = initial.buckets.dirExclude.join('\n');
  } else {
    // A mask that does not parse is still the user's text: it goes in the
    // include box unchanged rather than being silently dropped.
    includeFiles.area.value = String(props.mask || '');
  }

  let excludeAllMemory = '';
  const excludeAll = checkRow(txLabel(tx, 'emAllNoRecurse'), false, (checked) => {
    if (changingExcludeAll) return;
    changingExcludeAll = true;
    if (checked) {
      excludeAllMemory = excludeDirs.area.value;
      excludeDirs.area.value = '*';
    } else {
      excludeDirs.area.value = excludeAllMemory;
    }
    changingExcludeAll = false;
    update();
  });

  const composed = h('output', {
    class: 'mono',
    style: {
      display: 'block', minHeight: 'calc(44px * var(--den))',
      padding: 'calc(8px * var(--den)) calc(10px * var(--den))',
      border: '1px solid var(--outline-var)', borderRadius: 'var(--shape-sm)',
      background: 'var(--c-lowest)', color: 'var(--onsfc)',
      fontSize: 'var(--type-body-sm)', wordBreak: 'break-all', lineHeight: '1.5',
    },
  });

  const status = h('div', {
    role: 'status',
    style: {
      fontSize: 'var(--type-label-md)', lineHeight: '1.45',
      borderRadius: 'var(--shape-sm)', padding: '7px 9px',
    },
  });

  const hints = h('div', { class: 'muted', style: { fontSize: 'var(--type-label-sm)', lineHeight: '1.5' } });
  bindRender(hints, () => {
    clear(hints);
    for (const hint of maskHints()) hints.appendChild(h('div', {}, hint));
  });

  /* ---- the live test list ---- */

  const sampleNames = Array.isArray(props.sampleNames) ? props.sampleNames.slice(0, 400) : [];
  const sampleArea = h('textarea', {
    class: 'field-input', rows: '3', spellcheck: 'false',
    style: { width: '100%', fontFamily: 'var(--mono)' },
    'aria-label': tx('emSample'),
  });
  sampleArea.value = sampleNames.join('\n');

  const sampleSearch = createSearchBar({
    id: 'editmask-sample',
    persist: false,
    compact: true,
    labelKey: 'search',
    placeholder: tx('emSampleSearch'),
    sampleProvider: () => sampleArea.value,
    onChange: () => paintMatches(),
  });

  const matchList = h('div', {
    style: {
      display: 'flex', flexWrap: 'wrap', gap: '4px',
      maxHeight: 'calc(140px * var(--uiscale))', overflow: 'auto',
      padding: '4px', minHeight: 'calc(34px * var(--den))',
    },
  });

  let matchState = new Map();      // name -> boolean | null (unknown)

  function currentNames() {
    return sampleArea.value.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 400);
  }

  function paintMatches() {
    clear(matchList);
    const names = sampleSearch.isActive
      ? filterBy(currentNames(), sampleSearch.predicate, (n) => n)
      : currentNames();
    if (!names.length) {
      matchList.appendChild(h('span', { class: 'muted', style: { fontSize: 'var(--type-label-sm)' } },
        sampleSearch.isActive ? noMatchMessage(sampleSearch.predicate, tx('emSample')) : ''));
      return;
    }
    for (const name of names) {
      const state = matchState.has(name) ? matchState.get(name) : null;
      const chip = h('span', {
        class: 'chip',
        title: state === null ? tx('emTestUnavailable') : `${name} — ${state ? tx('emMatches') : tx('emNoMatch')}`,
        style: {
          background: state === null ? 'var(--sv)' : state ? 'var(--secc)' : 'transparent',
          color: state === null ? 'var(--onsv)' : state ? 'var(--onsecc)' : 'var(--onsv)',
          border: state ? 'none' : '1px solid var(--outline-var)',
          opacity: state === false ? '0.7' : '1',
        },
      }, h('span', {}, name));
      matchList.appendChild(chip);
    }
  }

  const evaluate = debounce(async () => {
    const mask = compose();
    const names = currentNames();
    if (!validateMask(mask).ok || !names.length) { matchState = new Map(); paintMatches(); return; }
    const next = new Map();
    for (const name of names.slice(0, 120)) {
      try {
        const isDir = name.endsWith('/');
        const matched = await ops.app.maskMatches(mask, isDir ? name.slice(0, -1) : name, { isDir });
        next.set(name, !!matched);
      } catch {
        next.set(name, null);
      }
    }
    matchState = next;
    paintMatches();
  }, 260);

  /* ---- composition and validation ---- */

  function lines(area) { return area.value.split('\n').map((s) => s.trim()).filter(Boolean); }

  function compose() {
    return composeMaskStr(
      lines(includeFiles.area), lines(excludeFiles.area),
      lines(includeDirs.area), lines(excludeDirs.area),
    );
  }

  function update() {
    const mask = compose();
    const verdict = validateMask(mask);
    composed.textContent = mask || '';
    if (!mask) {
      status.textContent = tx('emEmpty');
      status.style.background = 'transparent';
      status.style.color = 'var(--onsv)';
    } else if (verdict.ok) {
      status.textContent = tx('emValid');
      status.style.background = 'var(--secc)';
      status.style.color = 'var(--onsecc)';
    } else {
      // The offending run is located, so "why" is answerable, not a guess.
      status.textContent = tx('emInvalidAt', verdict.start + 1, verdict.error);
      status.style.background = 'var(--errc)';
      status.style.color = 'var(--onerrc)';
    }
    if (okButton) okButton.disabled = !verdict.ok;
    // ExcludeDirectoryMasksMemoChange: '*' and '*/' mean "do not recurse".
    if (!changingExcludeAll) {
      changingExcludeAll = true;
      const value = excludeDirs.area.value.trim();
      excludeAll.input.checked = value === '*' || value === '*/';
      changingExcludeAll = false;
    }
    evaluate();
    return { mask, verdict };
  }

  for (const box of [includeFiles, excludeFiles, includeDirs, excludeDirs]) {
    box.area.addEventListener('input', update);
  }
  sampleArea.addEventListener('input', () => { paintMatches(); evaluate(); });

  const clearButton = h('button', {
    type: 'button', class: 'btn-text',
    onclick: () => {
      for (const box of [includeFiles, excludeFiles, includeDirs, excludeDirs]) box.area.value = '';
      excludeAll.input.checked = false;
      update();
    },
  });
  bindRender(clearButton, () => { clearButton.textContent = tx('emClear'); });

  function group(titleKey, ...children) {
    const legend = h('legend', { class: 'field-label' });
    bindRender(legend, () => { legend.textContent = tx(titleKey); });
    return h('fieldset', {
      style: {
        border: '1px solid var(--outline-var)', borderRadius: 'var(--shape-md)',
        padding: 'calc(10px * var(--den))', margin: 0, minWidth: 0,
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(220px, 100%), 1fr))',
        gap: 'calc(10px * var(--den))',
      },
    }, legend, ...children);
  }

  const content = h('div', { class: 'stack' },
    group('emFilesGroup', includeFiles.element, excludeFiles.element),
    group('emDirsGroup', includeDirs.element, excludeDirs.element, excludeAll.element),
    h('div', { class: 'field' },
      h('span', { class: 'field-label' }, tx('emMask')),
      composed,
      status),
    h('div', { class: 'field' },
      h('span', { class: 'field-label' }, tx('emSample')),
      sampleArea,
      h('div', { class: 'row' }, sampleSearch.element),
      matchList),
    hints,
    h('div', { class: 'row' }, clearButton));
  appearanceTarget(content, 'editmask-dialog', 'File mask editor');

  let okButton = null;
  update();

  return {
    title: tx('emTitle'),
    width: 720,
    content,
    actions: [
      { label: t('cancel'), kind: 'text' },
      {
        label: t('ok'), kind: 'filled', autofocus: true,
        ref: (btn) => { okButton = btn; },
        onSelect: () => {
          const { mask, verdict } = update();
          if (!verdict.ok) { notify.warning(tx('emTitle'), verdict.error); return true; }
          props.onApply?.(mask);
          close();
        },
      },
    ],
  };
});

/** Open the mask editor. */
export function openEditMask(props) { return openDialog('editmask', props); }
