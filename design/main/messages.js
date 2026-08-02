// messages.js — WinSCP's own wording, resolved by resource id.
//
// WinSCP never writes a user-visible sentence in code. It writes an identifier,
// and the sentence lives in source/resource/*.rc. `LoadStr(CONNECTION_FAILED)`
// and `FMTLOAD(CHANGE_DIR_ERROR, (Path))` are how the whole program speaks.
// This module is that mechanism: `tools/extract-resources.js` lifts all 1,427
// strings into design/renderer/messages.json, and everything here resolves and
// formats them, so a ported module states an error in WinSCP's words instead of
// inventing its own next to a C++ file that already had the sentence written.
//
// What is ported, and from where:
//
//   LoadStr / FmtLoadStr    core/Global.h, core/Common.cpp   loadStr / fmtLoad
//   LoadStrPart             core/Common.cpp:2663             loadStrPart
//   Delphi Format           the '%s'/'%d'/'%0:d' grammar     format
//   MainInstructions        core/Common.cpp:356              mainInstructions
//   ExtractMainInstructions core/Common.cpp:387              extractMainInstructions
//   RemoveMainInstructionsTag core/Common.cpp:425            removeMainInstructionsTag
//   UnformatMessage         core/Common.cpp:434              unformatMessage
//
// A note on refusals: WinSCP's Format raises EConvertError when a message is
// given fewer arguments than it has slots, and that is deliberately preserved
// here. Rendering "Error changing directory to '%s'." to a user — a sentence
// with a hole where the directory should be — is worse than a crash in a
// developer's test run, because the user cannot tell which directory failed.
'use strict';

const fs = require('fs');
const path = require('path');

/* ------------------------------------------------------------------ */
/* the table                                                           */
/* ------------------------------------------------------------------ */

const TABLE_PATH = path.join(__dirname, '..', 'renderer', 'messages.json');

const TABLE = JSON.parse(fs.readFileSync(TABLE_PATH, 'utf8'));

/** id -> { id, file, text, params, arity?, segments?, mainInstruction? } */
const MESSAGES = TABLE.messages;

/** HELP_* -> the winscp.net documentation topic, from HelpCore.h / HelpWin.h. */
const HELP = TABLE.help;

/**
 * Resource ids the extractor deliberately withholds, and why. WinSCP asks its
 * users for donations and store purchases; this port ships no promotional asks
 * (Ding-Ding-Projects/material-winscp#22), so those strings are not in the
 * table at all. Naming them here turns a future `loadStr('DONATE_URL')` into an
 * answer instead of a mystery about a broken extractor.
 */
const EXCLUDED_BY_POLICY = TABLE.excludedByPolicy || {};

/**
 * WinSCP wraps the highlighted first line of a message box in MAIN_MSG_TAG and
 * an interactive tail in INTERACTIVE_MSG_TAG. Both are themselves resource
 * strings ("**" and "$$"), read here from the table so a translation that
 * changed them would change these too.
 */
const MAIN_MSG_TAG = MESSAGES.MAIN_MSG_TAG ? MESSAGES.MAIN_MSG_TAG.text : '**';
const INTERACTIVE_MSG_TAG = MESSAGES.INTERACTIVE_MSG_TAG ? MESSAGES.INTERACTIVE_MSG_TAG.text : '$$';

/** Numeric resource id -> symbolic id, for reading a WinSCP log or INI back. */
const BY_NUMBER = new Map();
for (const [name, record] of Object.entries(MESSAGES)) {
  if (typeof record.id === 'number' && !BY_NUMBER.has(record.id)) BY_NUMBER.set(record.id, name);
}

function has(id) { return Object.prototype.hasOwnProperty.call(MESSAGES, id); }

function ids() { return Object.keys(MESSAGES); }

function meta(id) {
  if (!has(id)) {
    if (Object.prototype.hasOwnProperty.call(EXCLUDED_BY_POLICY, id)) {
      throw new Error(`messages: "${id}" is deliberately not carried — ${EXCLUDED_BY_POLICY[id]}`);
    }
    throw new Error(`messages: no such resource id "${id}"`);
  }
  return MESSAGES[id];
}

/** The reason a withheld id is withheld, or null when it is not withheld. */
function exclusionReason(id) {
  return Object.prototype.hasOwnProperty.call(EXCLUDED_BY_POLICY, id) ? EXCLUDED_BY_POLICY[id] : null;
}

/** The symbolic id behind a numeric one, or null. */
function nameOfNumber(number) { return BY_NUMBER.get(number) || null; }

/** The parameter shape a message takes, in the order the slots appear. */
function paramsOf(id) { return meta(id).params.map((p) => ({ ...p })); }

/** How many positional arguments the message needs (0 when it takes none). */
function arityOf(id) { return meta(id).arity || 0; }

/** The winscp.net documentation topic for a HELP_* keyword, or null. */
function helpKeyword(name) {
  return Object.prototype.hasOwnProperty.call(HELP, name) ? HELP[name] : null;
}

/* ------------------------------------------------------------------ */
/* Delphi Format                                                       */
/* ------------------------------------------------------------------ */

const NAMED_RE = /^%([A-Z][A-Z0-9_]*)%/;
const POSITIONAL_RE = /^%(?:(\d+):)?([-+ #0]*)(\d+|\*)?(?:\.(\d+|\*))?([a-zA-Z])/;
const NUMERIC_CONVERSIONS = 'diouxX';
const FLOAT_CONVERSIONS = 'eEfgG';
const KNOWN_CONVERSIONS = NUMERIC_CONVERSIONS + FLOAT_CONVERSIONS + 'sc';

function pad(text, width, flags) {
  if (!width || text.length >= width) return text;
  const fill = ' '.repeat(width - text.length);
  return flags.includes('-') ? text + fill : fill + text;
}

/** Delphi treats precision on an integer as a minimum digit count. */
function padDigits(digits, precision) {
  if (precision === null || digits.length >= precision) return digits;
  return '0'.repeat(precision - digits.length) + digits;
}

function renderInteger(value, conversion, precision, flags) {
  const number = typeof value === 'bigint' ? value : Math.trunc(Number(value));
  if (typeof number === 'number' && !Number.isFinite(number)) {
    throw new TypeError(`messages: %${conversion} was given a non-numeric value ${JSON.stringify(value)}`);
  }
  const negative = number < 0;
  const magnitude = negative ? -number : number;
  let digits;
  if (conversion === 'x') digits = magnitude.toString(16);
  else if (conversion === 'X') digits = magnitude.toString(16).toUpperCase();
  else if (conversion === 'o') digits = magnitude.toString(8);
  else digits = magnitude.toString(10);
  digits = padDigits(digits, precision);
  let sign = negative ? '-' : '';
  if (!negative && (conversion === 'd' || conversion === 'i')) {
    if (flags.includes('+')) sign = '+';
    else if (flags.includes(' ')) sign = ' ';
  }
  return sign + digits;
}

function renderFloat(value, conversion, precision) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new TypeError(`messages: %${conversion} was given a non-numeric value ${JSON.stringify(value)}`);
  }
  const digits = precision === null ? 6 : precision;
  if (conversion === 'e' || conversion === 'E') {
    const text = number.toExponential(digits);
    return conversion === 'E' ? text.toUpperCase() : text;
  }
  if (conversion === 'g' || conversion === 'G') {
    // Delphi's %g drops trailing zeros; toPrecision(0) is invalid, so a zero
    // precision means "shortest useful", which is what String() already gives.
    const text = digits === 0 ? String(number) : Number(number.toPrecision(digits)).toString();
    return conversion === 'G' ? text.toUpperCase() : text;
  }
  return number.toFixed(digits);
}

/**
 * Format one message the way Delphi's Format does, over the subset WinSCP's
 * resources actually use.
 *
 * Three substitution shapes exist and all three are real:
 *   `%%`      a literal percent — "(%%PATH%%)" renders as "(%PATH%)"
 *   `%NAME%`  replaced by name, the way core/SecureShell.cpp does with ReplaceStr
 *   `%s` etc  positional, with Delphi's optional explicit index as in "%0:d"
 *
 * A named slot with no supplied value is left standing, because WinSCP leaves
 * it standing too: PATH_ENV_TOO_LONG says "Cannot add new path to %PATH%" and
 * "%PATH%" there is the name of the environment variable, not a parameter.
 * A *positional* slot with no argument throws — see the note at the top.
 *
 * @param {string} template   the message text
 * @param {Array}  [args]     positional arguments
 * @param {Object} [named]    values for `%NAME%` slots
 * @param {string} [id]       resource id, used only to make an error readable
 */
function format(template, args = [], named = null, id = null) {
  const where = id ? `${id}: ` : '';
  const text = String(template);
  let out = '';
  let auto = 0;
  let i = 0;

  const take = (index) => {
    if (index >= args.length) {
      throw new RangeError(
        `messages: ${where}the message needs at least ${index + 1} parameter(s) but ${args.length} were given`);
    }
    return args[index];
  };

  while (i < text.length) {
    const c = text[i];
    if (c !== '%') { out += c; i += 1; continue; }

    if (text.startsWith('%%', i)) { out += '%'; i += 2; continue; }

    const rest = text.slice(i);

    const namedMatch = NAMED_RE.exec(rest);
    if (namedMatch) {
      const key = namedMatch[1];
      if (named && Object.prototype.hasOwnProperty.call(named, key)) out += String(named[key]);
      else out += namedMatch[0];           // WinSCP leaves an unsupplied name alone
      i += namedMatch[0].length;
      continue;
    }

    const pos = POSITIONAL_RE.exec(rest);
    if (!pos || !KNOWN_CONVERSIONS.includes(pos[5])) { out += c; i += 1; continue; }

    const [token, explicitIndex, flags, widthSpec, precisionSpec, conversion] = pos;
    let width = null;
    let precision = null;
    if (widthSpec === '*') width = Math.trunc(Number(take(auto++)));
    else if (widthSpec !== undefined) width = Number(widthSpec);
    if (precisionSpec === '*') precision = Math.trunc(Number(take(auto++)));
    else if (precisionSpec !== undefined) precision = Number(precisionSpec);

    const index = explicitIndex === undefined ? auto : Number(explicitIndex);
    auto = index + 1;
    const value = take(index);

    let rendered;
    if (conversion === 's') {
      rendered = value === null || value === undefined ? '' : String(value);
      // In Delphi, precision on %s truncates. No resource string uses it, but
      // honouring it costs one line and silently ignoring it would not be a port.
      if (precision !== null) rendered = rendered.slice(0, precision);
    } else if (conversion === 'c') {
      rendered = typeof value === 'number' ? String.fromCharCode(value) : String(value).charAt(0);
    } else if (FLOAT_CONVERSIONS.includes(conversion)) {
      rendered = renderFloat(value, conversion, precision);
    } else {
      rendered = renderInteger(value, conversion, precision, flags);
      if (flags.includes('0') && !flags.includes('-') && width && rendered.length < width) {
        const sign = /^[-+ ]/.test(rendered) ? rendered[0] : '';
        const body = sign ? rendered.slice(1) : rendered;
        rendered = sign + '0'.repeat(width - rendered.length) + body;
      }
    }

    out += pad(rendered, width, flags);
    i += token.length;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* LoadStr / FmtLoadStr / LoadStrPart                                  */
/* ------------------------------------------------------------------ */

/** WinSCP's LoadStr: the message exactly as the resource holds it. */
function loadStr(id) { return meta(id).text; }

/** True when the single argument is a plain object of named values. */
function isNamedBag(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/**
 * WinSCP's FMTLOAD: load and format in one step.
 * Positional: `fmtLoad('CHANGE_DIR_ERROR', '/srv')`
 * Named:      `fmtLoad('NET_TRANSL_TIMEOUT2', { HOST: 'example.com' })`
 */
function fmtLoad(id, ...args) {
  const text = loadStr(id);
  if (args.length === 1 && isNamedBag(args[0])) return format(text, [], args[0], id);
  return format(text, args, null, id);
}

/**
 * WinSCP's LoadStrPart: several related strings share one resource entry,
 * separated by '|', and the caller asks for the 1-based Nth. Ported from
 * core/Common.cpp:2663 including its CutToChar behaviour — a part beyond the
 * end is the empty string, not an error, because CutToChar empties the buffer
 * and every further cut returns "".
 */
function loadStrPart(id, part) {
  let rest = loadStr(id);
  let result = '';
  let remaining = part;
  while (remaining > 0) {
    const at = rest.indexOf('|');
    if (at >= 0) { result = rest.slice(0, at); rest = rest.slice(at + 1); }
    else { result = rest; rest = ''; }
    remaining -= 1;
  }
  return result;
}

/** LoadStrPart followed by Format, which is how CopyParam.cpp builds its summary. */
function fmtLoadPart(id, part, ...args) {
  const text = loadStrPart(id, part);
  if (args.length === 1 && isNamedBag(args[0])) return format(text, [], args[0], id);
  return format(text, args, null, id);
}

/** How many '|'-separated parts a message has. */
function partCount(id) { return loadStr(id).split('|').length; }

/**
 * The convenience the ported modules use: arguments format, no arguments
 * load verbatim. Without the split, a caption containing a literal '%' (the
 * proxy-command pattern hint) could not be read at all.
 */
function message(id, ...args) {
  return args.length ? fmtLoad(id, ...args) : loadStr(id);
}

/* ------------------------------------------------------------------ */
/* main instructions (core/Common.cpp)                                 */
/* ------------------------------------------------------------------ */

/** Wrap a sentence so a message box renders it as the highlighted first line. */
function mainInstructions(text) { return MAIN_MSG_TAG + text + MAIN_MSG_TAG; }

function hasParagraphs(text) { return String(text).includes('\n\n'); }

/**
 * Highlight only the first paragraph. WinSCP calls this a workaround and says
 * so in a comment — the highlighting ought to be part of the localized string.
 * The behaviour is preserved anyway, including the single-paragraph fallback.
 */
function mainInstructionsFirstParagraph(text) {
  const s = String(text);
  const at = s.indexOf('\n\n');
  if (at < 0) return mainInstructions(s);
  return mainInstructions(s.slice(0, at)) + s.slice(at);
}

/**
 * Split a tagged message into its highlighted instruction and the rest.
 * Returns `{ found, main, rest }`; when no tag is present `main` is '' and
 * `rest` is the message unchanged, matching the C++ out-parameter contract.
 */
function extractMainInstructions(text) {
  const s = String(text);
  const tag = MAIN_MSG_TAG;
  if (!s.startsWith(tag)) return { found: false, main: '', rest: s };
  const end = s.indexOf(tag, tag.length);
  if (end < 0) return { found: false, main: '', rest: s };
  return { found: true, main: s.slice(tag.length, end), rest: s.slice(end + tag.length) };
}

/** Drop the tags but keep the text, for a log line or a plain-text export. */
function removeMainInstructionsTag(text) {
  const { found, main, rest } = extractMainInstructions(text);
  return found ? main + rest : String(text);
}

/**
 * Port of FindInteractiveMsgStart: the interactive tail is delimited by a pair
 * of INTERACTIVE_MSG_TAG markers at the very end of the message, and the search
 * walks backwards from the end to find the opening one. Returns a 0-based index
 * or -1 (the C++ is 1-based and returns 0 for "not found").
 */
function findInteractiveMsgStart(text) {
  const s = String(text);
  const tag = INTERACTIVE_MSG_TAG;
  if (!s.endsWith(tag) || s.length < 2 * tag.length) return -1;
  for (let at = s.length - 2 * tag.length; at >= 0; at -= 1) {
    if (s.startsWith(tag, at)) return at;
  }
  return -1;
}

/**
 * Port of UnformatMessage: strip the highlight tags and drop the interactive
 * tail, giving the plain sentence that belongs in a log or an exception text.
 */
function unformatMessage(text) {
  let s = removeMainInstructionsTag(text);
  const at = findInteractiveMsgStart(s);
  if (at >= 0) s = s.slice(0, at);
  return s;
}

/**
 * Port of RemoveInteractiveMsgTag (core/Common.cpp:445). Unlike unformatMessage
 * this KEEPS the interactive tail and only drops the two markers around it,
 * which is what forms/MessageDlg.cpp:1050 does before laying the body out: the
 * dialog shows "Press 'Delete' to overwrite the file" to the user, it is only
 * the log and the exception text that must not carry it.
 */
function removeInteractiveMsgTag(text) {
  let s = String(text);
  const at = findInteractiveMsgStart(s);
  if (at < 0) return s;
  const tag = INTERACTIVE_MSG_TAG;
  s = s.slice(0, at) + s.slice(at + tag.length);
  return s.slice(0, s.length - tag.length);
}

/** The interactive tail on its own — the part a console session must not print. */
function extractInteractiveMessage(text) {
  const s = String(text);
  const at = findInteractiveMsgStart(s);
  if (at < 0) return '';
  return s.slice(at + INTERACTIVE_MSG_TAG.length, s.length - INTERACTIVE_MSG_TAG.length);
}

/* ------------------------------------------------------------------ */
/* voice: the bilingual layer                                          */
/* ------------------------------------------------------------------ */

/**
 * The resource English is the base. `design/winscp-i18n.js` supplies the
 * Cantonese and the five funny levels, so where a resource message and a
 * dictionary entry are the same message, this table names the pair and the
 * message gains a second language and a slider.
 *
 * The rule for adding a row: the two must state the *same facts* and take the
 * *same number of parameters*. test/messages.test.js enforces both, so a row
 * that maps a one-parameter error onto a two-parameter confirmation fails the
 * suite rather than quietly dropping a filename from a delete prompt.
 *
 * A resource message with no row here still renders — in WinSCP's own English,
 * identically at every level and in every language mode. That is a real gap and
 * it is stated plainly rather than papered over: 1,427 messages exist and this
 * table covers a small fraction of them.
 */
const I18N_KEYS = {
  // Buttons and generic captions
  YES_STR: 'yes',
  NO_STR: 'no',
  ALL_BUTTON: 'all',
  CLOSE_BUTTON: 'close',
  SKIP_BUTTON: 'skip_',
  SKIP_ALL_BUTTON: 'skipAll',
  RESUME_BUTTON: 'resume',
  ADD_KEY_BUTTON: 'add',
  SITE_RAW_ADD: 'add',
  OPEN_BUTTON: 'loginOpen',
  URL_LINK_OPEN: 'loginOpen',
  UPDATE_URL_BUTTON: 'goTo',
  YES_TO_NEWER_BUTTON: 'newerOnlyBtn',
  EXTENSION_OPTIONS_BROWSE: 'browse',
  SSH_HOST_CA_BROWSE: 'browse',
  EDIT_COPY: 'copy_',
  EDIT_SELECT_ALL: 'selectAll',
  SEARCH_EDIT: 'search',
  EDITOR_NEW: 'newBtn',
  AUTO_SWITCH_ON: 'on',
  AUTO_SWITCH_OFF: 'off',
  SHORTCUT_NONE: 'none',
  SFTP_SERVER_MESSAGE_UNSUPPORTED: 'none',
  SAVE_SESSION_ROOT_FOLDER2: 'none',
  COPY_PARAM_DEFAULT: 'default_',
  COLOR_TRUE_DEFAULT_CAPTION: 'default_',
  COPY_PARAM_CUSTOM: 'custom',
  SSH_HOST_CA_NAME: 'name',

  // Passwords and keys
  PASSWORD_TITLE: 'password',
  PASSWORD_PROMPT: 'password',
  PASSPHRASE_TITLE: 'keyPassphrase',
  NEW_PASSWORD_TITLE: 'newPw',
  NEW_PASSWORD_NEW_PROMPT: 'newPw',
  NEW_PASSWORD_CURRENT_PROMPT: 'currentPw',
  NEW_PASSWORD_CONFIRM_PROMPT: 'confirmPw',
  MASTER_PASSWORD_CAPTION: 'masterPassword',
  CONSOLE_MASTER_PASSWORD_PROMPT: 'masterPassword',
  SAVE_SESSION_PASSWORD_RECOMMENDED: 'savePassword',

  // Connecting
  IDS_STATUSMSG_CONNECTING: 'connecting',
  STATUS_LOOKUPHOST: 'searchingHost',
  STATUS_AUTHENTICATE: 'authenticating',
  HOSTKEY_UNKNOWN: 'hostKeyBody',
  HOSTKEY_ONCE_BUTTON: 'trustOnce',

  // Transfers
  COPY_COPY_TOLOCAL: 'download',
  COPY_COPY_TOLOCAL_CAPTION: 'download',
  COPY_COPY_TOREMOTE: 'upload',
  COPY_COPY_TOREMOTE_CAPTION: 'upload',
  COPY_MOVE_TOLOCAL_CAPTION: 'downloadDelete',
  COPY_MOVE_TOREMOTE_CAPTION: 'uploadDelete',
  COPY_LOCAL_COPY_CAPTION: 'copy_',
  COPY_LOCAL_MOVE_CAPTION: 'move_',
  COPY_MOVE_CAPTION: 'move_',
  REMOTE_MOVE_TITLE: 'move_',
  REMOTE_COPY_TITLE: 'duplicateTitle',
  COPY_PARAM_PRESET_ASCII: 'modeText',
  COPY_PARAM_PRESET_BINARY: 'modeBinary',
  COPY_PARAM_PRESET_HEADER: 'pPresets',
  COPY_PARAM_NEWER_ONLY: 'newerOnly',
  COPY_INFO_TIMESTAMP: 'preserveTimestamp',
  FILE_OVERWRITE: 'overwriteBody',
  BALLOON_QUEUE_EMPTY: 'queueEmpty',
  QUEUE_CAPTION: 'queueMenu',
  COMPARE_NO_DIFFERENCES: 'syncNoDiff',
  SYNCHRONIZE_TITLE: 'kutdTitle',
  SYNCHRONIZE_CHECKLIST_CAPTION: 'syncChecklistTitle',

  // Panels, files and properties
  LOCAL_MENU_CAPTION: 'mLocal',
  REMOTE_MENU_CAPTION: 'mRemote',
  BATCH_SET_CHANGED: 'colChanged',
  FILE_INFO_HIDDEN2: 'hiddenCount',
  PROPERTIES_FILE_CAPTION: 'propsTitle',
  RENAME_BUTTON: 'newName',
  RENAME_PROMPT2: 'newName',
  NEW_FOLDER: 'newFolder',
  MOVE_BOOKMARK_PROMPT: 'dirName',
  LOGIN_NEW_SESSION_FOLDER_PROMPT: 'dirName',
  SFTP_OVERWRITE_DELETE_BUTTON: 'delete_',
  FILTER_MASK_CAPTION: 'filterMenu',
  USAGE_FILTER: 'filterMenu',
  USAGE_COPY: 'copyClip',
  FIND_FILE_START: 'findStart',
  FIND_FILE_STOP: 'findStop',

  // Sites, sessions and dialogs
  LOGIN_LOGIN: 'loginTitle',
  LOGIN_OPEN: 'loginOpen',
  LOGIN_NEW_SITE_NODE: 'newSite',
  SAVE_SESSION_CAPTION: 'saveSessionSite',
  SAVE_SESSION_PROMPT: 'siteName',
  SAVE_SESSION_FOLDER: 'siteFolder',
  CLEANUP_SESSIONS: 'sites',
  IMPORT_CAPTION: 'importTitle',
  RENAME_TAB_TITLE: 'renameTab',
  GENERATE_URL_FILE_TITLE: 'genUrl',
  GENERATE_URL_SESSION_TITLE: 'genUrlSite',
  GENERATE_URL_URL: 'urlTab',
  GENERATE_URL_SCRIPT: 'scriptTab',
  CHECK_FOR_UPDATES_TITLE: 'checkUpdates',
  VERSION_BUILD: 'aboutBuild',

  // Editor, commands and server info
  EDITOR_CAPTION: 'editorTitle',
  EDITOR_AD_HOC: 'editorTitle',
  EDITOR_GO_TO_LINE: 'goToLine',
  INTERNAL_EDITOR_NAME: 'pEditorInternal',
  CUSTOM_COMMAND_AD_HOC: 'customCmdTitle',
  COMMAND_LINE_LABEL: 'cmdPattern',
  FSINFO_COMPRESSION: 'srvCompression',
  FSINFO_FS_PROTOCOL: 'srvProtocol',
  FSINFO_REMOTE_SYSTEM: 'srvRemoteSystem',
  FSINFO_CRYPTOGRAPHIC_PROTOCOL: 'srvCipher',
};

/** Lazily loaded so the table works with no renderer present at all. */
let dictionary = null;
let dictionaryTried = false;

/**
 * design/winscp-i18n.js is an ES module and this is CommonJS. Node 22.12
 * resolves `require()` of ESM on its own, so this works in the test suite and
 * in any tool run against the repository's own Node — but it does NOT work in
 * the shipped application. Electron 33 embeds Node 20.18, and worse, the file
 * carries a `.js` extension under a package.json with no `"type": "module"`,
 * so Node classifies it as CommonJS and reports `Unexpected token 'export'`
 * for both `require()` AND `import()`. The renderer is unaffected: the browser
 * decides a module is a module from the `<script type="module">` graph, not
 * from an extension.
 *
 * Failing here is survivable — messages fall back to WinSCP's own English —
 * but it fails SILENTLY and identically to "the dictionary has no entry", so a
 * shipped build renders every level the same while the tests see five. That is
 * exactly the class of defect the tests exist to prevent, so `loadVoices()`
 * below closes it rather than leaving the fallback to hide it.
 */
function voices() {
  if (!dictionaryTried) {
    dictionaryTried = true;
    try {
      // eslint-disable-next-line global-require
      const mod = require('../winscp-i18n.js');
      dictionary = mod && mod.I18N ? mod.I18N : null;
    } catch {
      dictionary = null;
    }
  }
  return dictionary;
}

/**
 * The dictionary, loaded in a way that works on every Node this application
 * runs on. Await it once at startup; `voices()` serves it synchronously after.
 *
 * The fallback imports the module's own source through a `data:` URL, which
 * the ESM loader accepts on every supported version and which is classified as
 * a module by the URL's MIME type rather than by a package.json two directories
 * away. The dictionary is self-contained — it imports nothing — so evaluating
 * it out of its directory changes nothing about what it produces.
 */
async function loadVoices() {
  if (voices()) return dictionary;
  try {
    // eslint-disable-next-line global-require
    const fs = require('fs');
    // eslint-disable-next-line global-require
    const path = require('path');
    const source = fs.readFileSync(path.join(__dirname, '..', 'winscp-i18n.js'), 'utf8');
    const mod = await import(`data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`);
    dictionary = mod && mod.I18N ? mod.I18N : null;
  } catch {
    dictionary = null;
  }
  dictionaryTried = true;
  return dictionary;
}

/** Inject the dictionary explicitly (a renderer that already imported it). */
function registerVoices(dict) {
  dictionary = dict && dict.I18N ? dict.I18N : dict;
  dictionaryTried = true;
}

const LANG_MODES = ['en', 'yue', 'both'];

/**
 * Levels clamp into 1..5 and a value that is not a number falls back to 3.
 * Note that `Number(level) || 3` would be wrong: level 0 is a number the caller
 * meant, and it must clamp up to 1 rather than jump to the middle of the range.
 */
function clampLevel(level) {
  const n = Number(level);
  if (!Number.isFinite(n)) return 3;
  return Math.min(5, Math.max(1, Math.round(n)));
}

/** Pick one of an entry's five voices; a plain entry has the same voice at all. */
function pickVoice(value, level) {
  if (!Array.isArray(value)) return value;
  return value[Math.min(value.length - 1, clampLevel(level) - 1)];
}

/**
 * Substitute `{0}`-style slots, the shape the dictionary uses. The replacement
 * is literal: a file called `$& $1` must be inserted exactly, not re-expanded
 * by the substitution itself.
 */
function fillBraces(template, args) {
  return String(template).replace(/\{(\d+)\}/g, (whole, digits) => {
    const index = Number(digits);
    return index < args.length ? String(args[index]) : whole;
  });
}

/**
 * Render a resource message in the active language mode and funny levels.
 *
 * Where I18N_KEYS names a dictionary entry, the entry supplies the Cantonese
 * and the five voices, and the parameters are substituted into whichever voice
 * was chosen — so the wording changes and the facts do not. Where it does not,
 * both halves are WinSCP's own English, which makes bilingual mode render it
 * once rather than twice.
 *
 * @param {string} id
 * @param {{language?: string, enLevel?: number, yueLevel?: number}} [options]
 * @param {...*} args
 */
function voiced(id, options, ...args) {
  const opts = options || {};
  const language = LANG_MODES.includes(opts.language) ? opts.language : 'en';
  const base = message(id, ...args);

  const key = I18N_KEYS[id];
  const dict = key ? voices() : null;
  const entry = dict && Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : null;

  let en = base;
  let yue = base;
  if (entry) {
    en = fillBraces(pickVoice(entry[0], opts.enLevel), args);
    yue = fillBraces(pickVoice(entry[1], opts.yueLevel), args);
  }

  if (language === 'en') return en;
  if (language === 'yue') return yue;
  return en === yue ? en : `${en} · ${yue}`;
}

/** Both halves at once, for a surface that lays the two languages out itself. */
function voicedPair(id, options, ...args) {
  const opts = options || {};
  return {
    en: voiced(id, { ...opts, language: 'en' }, ...args),
    yue: voiced(id, { ...opts, language: 'yue' }, ...args),
  };
}

/** True when the message has a Cantonese counterpart and a five-level voice. */
function isVoiced(id) {
  const key = I18N_KEYS[id];
  if (!key) return false;
  const dict = voices();
  return Boolean(dict && Object.prototype.hasOwnProperty.call(dict, key));
}

module.exports = {
  MESSAGES, HELP, TABLE, TABLE_PATH, EXCLUDED_BY_POLICY,
  MAIN_MSG_TAG, INTERACTIVE_MSG_TAG, I18N_KEYS, LANG_MODES,
  has, ids, meta, nameOfNumber, paramsOf, arityOf, helpKeyword, exclusionReason,
  format, loadStr, fmtLoad, loadStrPart, fmtLoadPart, partCount, message,
  mainInstructions, mainInstructionsFirstParagraph, hasParagraphs,
  extractMainInstructions, removeMainInstructionsTag, unformatMessage,
  findInteractiveMsgStart, extractInteractiveMessage, removeInteractiveMsgTag,
  voiced, voicedPair, isVoiced, registerVoices, loadVoices,
};
