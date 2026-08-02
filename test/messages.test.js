// messages.test.js — WinSCP's string tables, and the rule that a voice may not
// eat a fact.
//
// Two things are being defended here.
//
// The first is the extraction. 1,427 sentences live in five .rc files whose
// syntax is nearly, but not quite, C: a URL inside a string literal looks like
// a `//` comment, TextsFileZilla.h hides FileZilla's original identifiers
// inside `#if 0`, and TextsCore2.rc writes each scripting help topic as one
// string literal per displayed line. A parser that gets any of those wrong
// produces a table that looks fine until a user meets the one broken message.
//
// The second is the substitution. WinSCP states facts through parameters —
// which directory failed, which file will be overwritten, how many seconds are
// left — and the bilingual layer rewrites the sentence around them five times
// per language. The central test below drives a byte-distinct sentinel through
// every voiced message at every level in both languages and asserts the
// sentinel survives unchanged, exactly as test/i18n.test.js does for the
// dictionary. A level-5 rewrite that reads beautifully and quietly drops the
// filename from an overwrite prompt fails here rather than in front of a user.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const M = require('../design/main/messages.js');
const extractor = require('../tools/extract-resources.js');

const TABLE = require('../design/renderer/messages.json');

// Two of the tests below re-run the extractor over vendor/winscp and compare
// the result with the committed table. That submodule is the porting
// reference, not a build input, and .github/workflows/ci.yml checks out with
// `submodules: false` — so on the machine that actually runs this suite the
// .rc files are usually absent, and these two tests have nothing to read.
//
// They say so, out loud, instead of failing: node reports them as skipped with
// the reason attached, which is a state a reader can act on. Everything else in
// this file reads design/renderer/messages.json, which is committed, so the
// other 43 tests run everywhere.
const NO_VENDOR = extractor.sourceAvailable() ? false
  : 'vendor/winscp is not checked out (CI uses submodules: false) — '
    + 'run `git submodule update --init` to check the committed table against the vendored source';

let dictModule = null;
async function dict() {
  if (!dictModule) dictModule = await import('../design/winscp-i18n.js');
  return dictModule;
}

const LEVELS = [1, 2, 3, 4, 5];

/**
 * Byte-distinct sentinels, none a substring of another, each mixing scripts,
 * punctuation and digits so a voice that lower-cases, transliterates or
 * truncates a parameter is caught as well as one that drops it.
 */
const SENTINEL = [
  'A7Ω-srv-01.example.com',
  'B9Δ-«Q1 報表 v2».tar.gz',
  'C3Ξ-42949672960',
  'D5Ψ-/var/log/α β',
];

function countOf(haystack, needle) {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) { n += 1; i = haystack.indexOf(needle, i + needle.length); }
  return n;
}

/* ================================================================== */
/* the extractor                                                       */
/* ================================================================== */

test('the extractor decodes the escapes a resource string may carry', () => {
  const { decodeCString } = extractor;
  assert.strictEqual(decodeCString('a\\nb'), 'a\nb');
  assert.strictEqual(decodeCString('say \\"hi\\"'), 'say "hi"');
  assert.strictEqual(decodeCString('back\\\\slash'), 'back\\slash');
  assert.strictEqual(decodeCString('tab\\there'), 'tab\there');
  assert.strictEqual(decodeCString('\\x41\\x42'), 'AB');
  assert.strictEqual(decodeCString('\\101'), 'A');           // octal, as RC allows
  assert.strictEqual(decodeCString('a""b'), 'a"b');          // RC's doubled quote
  assert.strictEqual(decodeCString('plain'), 'plain');
});

test('a URL inside a string is not mistaken for a comment', () => {
  // TextsCore1.rc stores https:// links. A line-level comment stripper would
  // truncate every one of them to "https:".
  const entries = extractor.parseRc(
    'STRINGTABLE\nBEGIN\n  A_URL, "https://winscp.net/eng/docs" // real comment\n  B, "x"\nEND\n', 'test.rc');
  assert.deepStrictEqual(entries.map((e) => [e.name, e.text]),
    [['A_URL', 'https://winscp.net/eng/docs'], ['B', 'x']]);

  assert.strictEqual(M.loadStr('HOMEPAGE_URL'), 'https://winscp.net/');
  assert.strictEqual(M.loadStr('FORUM_URL'), 'https://winscp.net/forum/');
  assert.ok(M.loadStr('PUTTY_URL').startsWith('https://www.chiark.greenend.org.uk/'));
});

test('adjacent string literals concatenate into one message', () => {
  const entries = extractor.parseRc(
    'STRINGTABLE\nBEGIN\n  HELP_X,\n    "line one\\n"\n    "line two\\n"\nEND\n', 'test.rc');
  assert.deepStrictEqual(entries, [{ name: 'HELP_X', text: 'line one\nline two\n', file: 'test.rc' }]);

  // The real thing: every scripting help topic is written this way.
  const exitHelp = M.loadStr('SCRIPT_EXIT_HELP');
  assert.match(exitHelp, /^exit\n/);
  assert.match(exitHelp, /alias:\n {2}bye\n$/);
  assert.strictEqual(exitHelp.split('\n').length, 5);
});

test('a #if 0 region is not read as live declarations', () => {
  const kept = extractor.stripDisabledRegions('#if 0\n#define DEAD 1\n#endif\n#define LIVE 2\n');
  const defines = extractor.parseDefines(kept);
  assert.strictEqual(defines.has('DEAD'), false);
  assert.strictEqual(defines.get('LIVE'), '2');

  // …and #else inside a dead branch re-enables it, as the preprocessor does.
  const both = extractor.parseDefines(extractor.stripDisabledRegions('#if 0\n#define A 1\n#else\n#define B 2\n#endif\n'));
  assert.strictEqual(both.has('A'), false);
  assert.strictEqual(both.get('B'), '2');
});

test('#define chains resolve to the literal they name', () => {
  const defines = extractor.parseDefines(
    '#define ONE "resume"\n#define TWO ONE\n#define THREE TWO\n#define N 42\n#define LOOP LOOP\n');
  assert.deepStrictEqual(extractor.resolveDefine(defines, 'THREE'), { kind: 'string', value: 'resume' });
  assert.deepStrictEqual(extractor.resolveDefine(defines, 'N'), { kind: 'number', value: 42 });
  assert.strictEqual(extractor.resolveDefine(defines, 'LOOP'), null);
  assert.strictEqual(extractor.resolveDefine(defines, 'ABSENT'), null);
});

test('the parameter shape of a message is read from its text', () => {
  const shape = (s) => extractor.analyseParams(s).map((p) => p.token + ':' + p.kind + (p.index === undefined ? '' : '#' + p.index));

  assert.deepStrictEqual(shape("Command '%s' failed with return code %d."),
    ['%s:string#0', '%d:integer#1']);
  // %% is a literal percent, not a slot — "(%%PATH%%)" renders as "(%PATH%)".
  assert.deepStrictEqual(shape('search path (%%PATH%%)'), []);
  assert.deepStrictEqual(shape('Error adding path \'%s\' to (%%PATH%%).'), ['%s:string#0']);
  // Delphi's explicit index re-reads an earlier argument.
  assert.deepStrictEqual(shape('for %d seconds. Wait another %0:d seconds?'),
    ['%d:integer#0', '%0:d:integer#0']);
  assert.deepStrictEqual(shape('Character: %d (0x%.2x)'), ['%d:integer#0', '%.2x:hex#1']);
  assert.deepStrictEqual(shape('Connection to "%HOST%" timed out.'), ['%HOST%:named']);
  // %p and %m are valid Delphi conversions but never appear in these texts, and
  // accepting them would read "%port expands to…" as a parameter slot.
  assert.deepStrictEqual(shape('%port expands to port number'), []);
});

test('a missing vendored unit is thrown, not exited — a library may not kill its caller', () => {
  // The regression this pins is a diagnostic one, and it cost a whole
  // investigation. readSource() used to call process.exit(1) when
  // vendor/winscp was absent, which is the ordinary state in CI
  // (.github/workflows/ci.yml checks out with `submodules: false`). build() is
  // called from a test in this very file, so process.exit took the test
  // process down mid-run: `node --test` had no test to blame, so it reported
  // the *file* as failed at messages.test.js:1:1 with the text "test failed",
  // and every assertion that had already passed vanished with the process —
  // the whole file reports as `# tests 1  # fail 1`. From the outside that is
  // indistinguishable from a sibling file poisoning this one, which is exactly
  // the wrong tree to go barking up.
  //
  // Throwing keeps the failure attached to the call that caused it. The file
  // name is in the message so the reader is told which unit is missing, and
  // the remedy is in there too.
  //
  // Without the fix this assertion does not fail — the process dies inside it
  // and the whole file reports as one file-level failure with no output.
  assert.throws(() => extractor.readSource('NoSuchUnit.h'), (e) => {
    assert.strictEqual(e.code, 'ENOVENDOR');
    assert.match(e.message, /NoSuchUnit\.h/);
    assert.match(e.message, /git submodule update --init/);
    return true;
  });

  // …and the answer to "can I rebuild the table here?" is available without
  // provoking that throw, which is what lets the two tests below stand down
  // cleanly rather than exploding.
  assert.strictEqual(typeof extractor.sourceAvailable(), 'boolean');
});

test('the committed table is what the extractor produces from the vendored source', { skip: NO_VENDOR }, () => {
  // A stale messages.json is the failure nobody notices: the application keeps
  // working while it quotes a wording WinSCP no longer ships.
  const built = extractor.build();
  assert.strictEqual(Object.keys(built.messages).length, Object.keys(TABLE.messages).length);
  assert.deepStrictEqual(built.messages, TABLE.messages);
  assert.deepStrictEqual(built.help, TABLE.help);
  assert.deepStrictEqual(built.excluded, TABLE.excludedByPolicy);
  assert.deepStrictEqual(built.duplicates, [], 'two resource files define the same id');
});

test('the promotional strings are withheld, named and unreachable', () => {
  // Ding-Ding-Projects/material-winscp#22: this port ships no donation or
  // store-purchase asks, and test/no-nags.test.js states the hard form — the
  // donation URL must not exist anywhere in the shipping app. messages.json
  // is in the shipping app, so it must not carry them as inert data either.
  const WITHHELD = ['DONATE_URL', 'UPDATES_DONATE_HTML', 'UPDATE_MISSING_ADDRESS2',
    'UPDATE_TOO_LOW', 'STORE_URL', 'STORE_GET_IMG_URL', 'STORE_BUYING'];
  assert.deepStrictEqual(Object.keys(M.EXCLUDED_BY_POLICY).sort(), [...WITHHELD].sort());

  for (const id of WITHHELD) {
    assert.strictEqual(M.has(id), false, `${id} is still in the table`);
    // …but a decision, not an oversight: the refusal explains itself.
    assert.throws(() => M.loadStr(id), /deliberately not carried/);
    assert.match(M.exclusionReason(id), /#22/);
  }
  assert.strictEqual(M.exclusionReason('CONNECTION_FAILED'), null);

  const raw = fs.readFileSync(
    path.join(__dirname, '..', 'design', 'renderer', 'messages.json'), 'utf8');
  assert.doesNotMatch(raw, /winscp\.net\/eng\/donate/, 'the donation URL is in the shipped table');
  assert.doesNotMatch(raw, /microsoft\.com\/store/, 'the store purchase link is in the shipped table');
  // The reason text must not smuggle back the string it explains withholding.
  for (const reason of Object.values(M.EXCLUDED_BY_POLICY)) {
    assert.doesNotMatch(reason, /https?:\/\//);
  }

  // test/no-nags.test.js scans .js/.mjs/.html/.css and would not see a .json,
  // so the rule is enforced here for the one shipped data file this unit adds:
  // no MESSAGE may carry a promotional ask, whatever its wording. The withheld
  // ids' reasons are exempt for the same circular cause the changelog is —
  // saying "a donation link was removed" is the record of the removal.
  const PROMO = /\b(donate|donation|sponsor|sponsorship|patreon|ko-?fi|buy\s?me\s?a\s?coffee|paypal|upgrade\s+to\s+pro|subscribe|subscription|rate\s+(us|this\s+app)|leave\s+a\s+review|star\s+us\s+on)\b/i;
  const nagging = M.ids().filter((id) => PROMO.test(M.loadStr(id)));
  assert.deepStrictEqual(nagging, [], 'a promotional ask survived into the shipped message table');
});

// Only the directory listing needs the submodule, so it is the only part that
// stands down without it — the arithmetic below is over the committed table and
// keeps running everywhere.
test('the extractor reads every unit that exists under source/resource', { skip: NO_VENDOR }, () => {
  const dir = path.join(__dirname, '..', 'vendor', 'winscp', 'source', 'resource');
  const onDisk = fs.readdirSync(dir).filter((f) => f.endsWith('.rc') || f.endsWith('.h'));
  // Nine units, ten files: TextsFileZilla.rc and TextsFileZilla.h share a stem.
  assert.deepStrictEqual(onDisk.sort(), [...extractor.RC_FILES, ...extractor.ID_HEADERS, ...extractor.HELP_HEADERS].sort());
});

test('every unit under source/resource contributes to the table', () => {
  for (const file of extractor.RC_FILES) {
    assert.ok(TABLE.counts.perFile[file] > 0, `${file} contributed no messages`);
  }
  assert.strictEqual(
    Object.values(TABLE.counts.perFile).reduce((a, b) => a + b, 0),
    Object.keys(TABLE.messages).length);
  assert.strictEqual(
    Object.keys(TABLE.messages).length + Object.keys(TABLE.excludedByPolicy).length,
    1427, 'the resource files hold 1,427 strings; the table must account for all of them');
});

/* ================================================================== */
/* the table                                                           */
/* ================================================================== */

test('the whole of WinSCP\'s wording is present and non-empty', () => {
  const names = M.ids();
  // 1,427 strings in the resource files, 7 withheld by the no-nags policy.
  assert.strictEqual(names.length, 1420, `expected 1,420 messages, found ${names.length}`);

  for (const name of names) {
    const record = M.meta(name);
    assert.strictEqual(typeof record.text, 'string', `${name} has no text`);
    assert.ok(Array.isArray(record.params), `${name} has no parameter shape`);
    assert.ok(record.file, `${name} does not say which file it came from`);
    // Four translator-metadata slots are deliberately blank in the English
    // resource; every other message says something.
    if (!['TRANSLATOR_INFO2', 'BIDI_MODE', 'FLIP_CHILDREN', 'TRANSLATOR_URL'].includes(name)) {
      assert.ok(record.text.length > 0, `${name} is empty`);
    }
  }
});

test('a symbolic id resolves to the numeric id WinSCP compiled', () => {
  assert.strictEqual(M.meta('CONNECTION_FAILED').id, 102);
  assert.strictEqual(M.meta('COMMAND_FAILED2').id, 106);
  assert.strictEqual(M.meta('MAIN_MSG_TAG').id, 631);
  assert.strictEqual(M.meta('IDS_ERRORMSG_NAMEINUSE').id, 2132);
  assert.strictEqual(M.nameOfNumber(102), 'CONNECTION_FAILED');
  assert.strictEqual(M.nameOfNumber(999999), null);

  // Propagation.rc is website and store copy; it is not compiled into the
  // binary and its ids have no #define anywhere. Recorded as null, not faked.
  const noNumber = M.ids().filter((n) => M.meta(n).id === null);
  assert.strictEqual(noNumber.length, 80);        // 81 entries, less STORE_BUYING
  assert.ok(noNumber.every((n) => M.meta(n).file === 'Propagation.rc'));
});

test('the message-box tags come from the resources, not from a constant', () => {
  assert.strictEqual(M.MAIN_MSG_TAG, '**');
  assert.strictEqual(M.INTERACTIVE_MSG_TAG, '$$');
  assert.strictEqual(M.MAIN_MSG_TAG, M.loadStr('MAIN_MSG_TAG'));
  assert.strictEqual(M.INTERACTIVE_MSG_TAG, M.loadStr('INTERACTIVE_MSG_TAG'));
  assert.strictEqual(TABLE.tags.mainInstruction, '**');
});

test('help keywords resolve, including the aliased ones', () => {
  assert.strictEqual(M.helpKeyword('HELP_UNKNOWN_KEY'), 'message_host_key');
  assert.strictEqual(M.helpKeyword('HELP_APPEND_OR_RESUME'), 'resume#manual');
  // #define HELP_PARTIAL_BIGGER_THAN_SOURCE HELP_RESUME_TRANSFER
  assert.strictEqual(M.helpKeyword('HELP_PARTIAL_BIGGER_THAN_SOURCE'), 'resume');
  assert.strictEqual(M.helpKeyword('HELP_SESSION_SAVE_OVERWRITE'), 'ui_login_save');
  assert.strictEqual(M.helpKeyword('HELP_NOT_A_TOPIC'), null);
  assert.ok(Object.keys(M.HELP).length >= 100, 'the help keyword table is suspiciously small');
});

test('a message keeps the exact wording WinSCP ships', () => {
  // Spot checks across all five resource files, byte for byte.
  assert.strictEqual(M.loadStr('CONNECTION_FAILED'), 'Connection failed.');
  assert.strictEqual(M.loadStr('KEY_NOT_VERIFIED'), "Host key wasn't verified!");
  assert.strictEqual(M.loadStr('SFTP_STATUS_PERMISSION_DENIED'), 'Permission denied.');
  assert.strictEqual(M.loadStr('CREATE_LOCAL_DIR_ERROR'), "Can't create folder '%s'.");
  assert.strictEqual(M.loadStr('IDS_ERRORMSG_CANTRESOLVEHOST2'), 'Can\'t resolve hostname "%s".');
  assert.strictEqual(M.loadStr('KEYWORD_SFTP_CLIENT'), 'sftp client');
  assert.strictEqual(M.loadStr('CUSTOM_COMMAND_AD_HOC_NAME'), 'Ad Hoc');
});

/* ================================================================== */
/* formatting                                                          */
/* ================================================================== */

test('positional parameters substitute the way Delphi Format does', () => {
  assert.strictEqual(M.fmtLoad('CHANGE_DIR_ERROR', '/srv/www'),
    "Error changing directory to '/srv/www'.");
  assert.strictEqual(M.fmtLoad('COMMAND_FAILED2', 'ls -la', 127),
    "Command 'ls -la'\nfailed with return code 127 and the following error message.");
  assert.strictEqual(M.fmtLoad('SFTP_VERSION_NOT_SUPPORTED', 6, 0, 5),
    'Version of SFTP server (6) is not supported. Supported versions are 0 to 5.');
  assert.strictEqual(M.fmtLoad('RENAME_FILE_ERROR', 'a.txt', 'b.txt'),
    "Error renaming file 'a.txt' to 'b.txt'.");
});

test('an explicit index re-reads the same argument', () => {
  // CONFIRM_PROLONG_TIMEOUT3 asks about one interval and states it twice.
  assert.strictEqual(M.fmtLoad('CONFIRM_PROLONG_TIMEOUT3', 15),
    'Host is not communicating for 15 seconds.\n\nWait for another 15 seconds?');
  assert.strictEqual(M.arityOf('CONFIRM_PROLONG_TIMEOUT3'), 1);
  assert.strictEqual(M.format('%1:s then %0:s then %s', ['a', 'b']), 'b then a then b');
});

test('%% is a literal percent, not a parameter', () => {
  assert.strictEqual(M.fmtLoad('ADD_PATH_ERROR', 'C:\\App'),
    "Error adding path 'C:\\App' to search path (%PATH%).");
  assert.strictEqual(M.arityOf('ADD_PATH_ERROR'), 1);
  assert.strictEqual(M.format('100%% done'), '100% done');
});

test('a named slot is replaced by name and left alone when unsupplied', () => {
  assert.strictEqual(M.fmtLoad('NET_TRANSL_TIMEOUT2', { HOST: 'sftp.example.com' }),
    'Network error: Connection to "sftp.example.com" timed out.');
  assert.strictEqual(M.fmtLoad('NET_TRANSL_HOST_NOT_EXIST2', { HOST: '中文.example' }),
    'Host "中文.example" does not exist.');

  // PATH_ENV_TOO_LONG names the Windows environment variable; "%PATH%" there is
  // the variable's name, and WinSCP prints it verbatim.
  assert.strictEqual(M.message('PATH_ENV_TOO_LONG'),
    'Cannot add new path to %PATH%, %PATH% is already too long.');
  assert.strictEqual(M.fmtLoad('PATH_ENV_TOO_LONG', {}),
    'Cannot add new path to %PATH%, %PATH% is already too long.');
});

test('numeric conversions honour width, precision and padding', () => {
  assert.strictEqual(M.fmtLoad('EDITOR_CHARACTER_STATUS2', 233, 233), 'Character: 233 (0xe9)');
  assert.strictEqual(M.fmtLoad('EDITOR_CHARACTER_STATUS2', 9, 9), 'Character: 9 (0x09)');
  assert.strictEqual(M.format('%.4d', [7]), '0007');
  assert.strictEqual(M.format('%6d|', [42]), '    42|');
  assert.strictEqual(M.format('%-6d|', [42]), '42    |');
  assert.strictEqual(M.format('%06d', [-42]), '-00042');
  assert.strictEqual(M.format('%X', [255]), 'FF');
  assert.strictEqual(M.format('%.2f', [1.5]), '1.50');
  assert.strictEqual(M.format('%s', [0]), '0');            // zero is a value
  assert.strictEqual(M.format('%s', ['']), '');
  // Delphi's precision on %s truncates rather than padding. No shipped resource
  // uses it, but a caller formatting an ad-hoc template still gets it right.
  assert.strictEqual(M.format('%.3s', ['abcdef']), 'abc');
  assert.strictEqual(M.format('%6.3s|', ['abcdef']), '   abc|');
  assert.strictEqual(M.format('%-6.3s|', ['abcdef']), 'abc   |');
  // Width and precision taken from the argument list, in the order Delphi reads
  // them: width first, then precision, then the value itself.
  assert.strictEqual(M.format('%*.*f', [8, 2, 3.14159]), '    3.14');
});

test('a message with too few parameters is refused, not rendered with a hole', () => {
  // Delphi raises EConvertError here, and so does this: a user shown
  // "Error changing directory to '%s'." cannot tell which directory failed.
  assert.throws(() => M.fmtLoad('CHANGE_DIR_ERROR'), /needs at least 1 parameter/);
  assert.throws(() => M.fmtLoad('COMMAND_FAILED2', 'ls'), /needs at least 2 parameter/);
  assert.throws(() => M.fmtLoad('SFTP_VERSION_NOT_SUPPORTED', 6, 0), RangeError);
  assert.throws(() => M.format('%d', ['not a number']), TypeError);
});

test('an unknown id is refused rather than rendering as itself', () => {
  assert.throws(() => M.loadStr('NO_SUCH_MESSAGE'), /no such resource id/);
  assert.throws(() => M.meta('NO_SUCH_MESSAGE'), /no such resource id/);
  assert.strictEqual(M.has('NO_SUCH_MESSAGE'), false);
  assert.strictEqual(M.has('CONNECTION_FAILED'), true);
  // Prototype keys are not messages.
  assert.strictEqual(M.has('constructor'), false);
  assert.strictEqual(M.has('toString'), false);
});

test('a parameter is inserted verbatim, replacement patterns and all', () => {
  const nasty = "$& $1 $$ %s {0} \\";
  assert.strictEqual(M.fmtLoad('CHANGE_DIR_ERROR', nasty), `Error changing directory to '${nasty}'.`);
  assert.strictEqual(countOf(M.fmtLoad('CHANGE_DIR_ERROR', nasty), '%s'), 1);
});

test('message() loads verbatim without arguments and formats with them', () => {
  // The proxy-command hint documents "%user expands to proxy username"; running
  // it through Format would consume the "%u" as an unsigned argument.
  const hint = M.message('LOGIN_PROXY_COMMAND_PATTERNS_HINT');
  assert.match(hint, /%user expands to proxy username/);
  assert.match(hint, /%% for percent sign/);
  assert.deepStrictEqual(M.paramsOf('LOGIN_PROXY_COMMAND_PATTERNS_HINT'), []);
  assert.strictEqual(M.meta('LOGIN_PROXY_COMMAND_PATTERNS_HINT').literalPercent, true);

  assert.strictEqual(M.message('CONNECTION_FAILED'), 'Connection failed.');
  assert.strictEqual(M.message('CHANGE_DIR_ERROR', '/x'), "Error changing directory to '/x'.");
});

/* ================================================================== */
/* LoadStrPart                                                         */
/* ================================================================== */

test('LoadStrPart cuts a multi-part message the way CutToChar does', () => {
  assert.strictEqual(M.loadStrPart('TIME_RELATIVE', 1), 'just now');
  assert.strictEqual(M.loadStrPart('TIME_RELATIVE', 3), 'yesterday');
  assert.strictEqual(M.loadStrPart('TIME_RELATIVE', 6), '%d seconds ago');
  assert.strictEqual(M.fmtLoadPart('TIME_RELATIVE', 6, 42), '42 seconds ago');
  assert.strictEqual(M.partCount('TIME_RELATIVE'), 18);

  // Past the end CutToChar empties the buffer and every further cut returns "".
  assert.strictEqual(M.loadStrPart('TIME_RELATIVE', 19), '');
  assert.strictEqual(M.loadStrPart('TIME_RELATIVE', 99), '');
  // Part 0 never enters the loop, so the result is the empty initial value.
  assert.strictEqual(M.loadStrPart('TIME_RELATIVE', 0), '');
});

test('CopyParam builds its summary out of one resource entry', () => {
  // core/CopyParam.cpp:149 — FORMAT(LoadStrPart(COPY_INFO_TRANSFER_TYPE2, 1),
  //                                 (LoadStrPart(COPY_INFO_TRANSFER_TYPE2, Ident)))
  assert.strictEqual(M.loadStrPart('COPY_INFO_TRANSFER_TYPE2', 1), 'Transfer type: %s');
  assert.strictEqual(M.loadStrPart('COPY_INFO_TRANSFER_TYPE2', 2), 'Binary');
  assert.strictEqual(
    M.fmtLoadPart('COPY_INFO_TRANSFER_TYPE2', 1, M.loadStrPart('COPY_INFO_TRANSFER_TYPE2', 2)),
    'Transfer type: Binary');
  // "Filename modification: %s|No change|Upper case|Lower case|…" — part 1 is
  // the frame, so the cases start at part 2 and CopyParam.cpp:183 offsets by 2.
  assert.strictEqual(M.loadStrPart('COPY_INFO_FILENAME', 2), 'No change');
  assert.strictEqual(M.loadStrPart('COPY_INFO_FILENAME', 3), 'Upper case');
  assert.strictEqual(M.loadStrPart('COPY_INFO_FILENAME', 6), 'Lower case 8.3');
});

/* ================================================================== */
/* main instructions                                                   */
/* ================================================================== */

test('the highlighted first line is extracted and removed', () => {
  const raw = M.loadStr('LOCAL_FILE_OVERWRITE2');
  assert.strictEqual(M.meta('LOCAL_FILE_OVERWRITE2').mainInstruction, true);

  const split = M.extractMainInstructions(raw);
  assert.strictEqual(split.found, true);
  assert.strictEqual(split.main, "Overwrite local file '%s'?");
  assert.ok(split.rest.startsWith('\n\nDestination directory already contains'));
  assert.ok(!split.rest.includes(M.MAIN_MSG_TAG));

  assert.strictEqual(M.removeMainInstructionsTag(raw), split.main + split.rest);
  assert.strictEqual(M.removeMainInstructionsTag('no tags here'), 'no tags here');
  assert.deepStrictEqual(M.extractMainInstructions('no tags here'),
    { found: false, main: '', rest: 'no tags here' });
  // An opening tag with no closing tag is not a main instruction.
  assert.strictEqual(M.extractMainInstructions('**dangling').found, false);
});

test('mainInstructions wraps and mainInstructionsFirstParagraph splits', () => {
  assert.strictEqual(M.mainInstructions('Boom.'), '**Boom.**');
  assert.strictEqual(M.hasParagraphs('a\n\nb'), true);
  assert.strictEqual(M.hasParagraphs('a\nb'), false);

  assert.strictEqual(M.mainInstructionsFirstParagraph('Headline.\n\nDetail.'),
    '**Headline.**\n\nDetail.');
  // The single-paragraph fallback WinSCP keeps behind a DebugAlwaysTrue.
  assert.strictEqual(M.mainInstructionsFirstParagraph('Only one.'), '**Only one.**');

  const round = M.mainInstructions(M.loadStr('CONNECTION_FAILED'));
  assert.strictEqual(M.removeMainInstructionsTag(round), 'Connection failed.');
});

test('the interactive tail is found and stripped', () => {
  const raw = M.loadStr('SFTP_OVERWRITE_FILE_ERROR2');
  assert.ok(raw.includes(M.INTERACTIVE_MSG_TAG));
  assert.strictEqual(M.unformatMessage(raw), "Cannot overwrite remote file '%s'.");
  assert.match(M.extractInteractiveMessage(raw), /^\n \nPress 'Delete'/);

  assert.strictEqual(M.findInteractiveMsgStart('plain'), -1);
  assert.strictEqual(M.extractInteractiveMessage('plain'), '');
  assert.strictEqual(M.unformatMessage('plain'), 'plain');
  // Both treatments compose: highlight stripped and tail dropped.
  assert.strictEqual(M.unformatMessage('**Head**body$$tail$$'), 'Headbody');
});

test('the interactive tag search walks backwards from the end, as the C++ does', () => {
  // core/Common.cpp:410 starts at Length - 2*TagLength + 1 and DECREMENTS. With
  // three markers a forward scan finds the first and cuts the message in the
  // wrong place; the backwards scan finds the one that opens the actual tail.
  assert.strictEqual(M.findInteractiveMsgStart('a$$b$$c$$'), 4);
  assert.strictEqual(M.unformatMessage('a$$b$$c$$'), 'a$$b');
  assert.strictEqual(M.extractInteractiveMessage('a$$b$$c$$'), 'c');

  // The tail must END the message. A tag in the middle is ordinary text — the
  // C++ guards on EndsStr before it ever starts scanning.
  assert.strictEqual(M.findInteractiveMsgStart('$$tail$$ and more'), -1);
  assert.strictEqual(M.unformatMessage('$$tail$$ and more'), '$$tail$$ and more');
  // …and a lone marker is too short to be a pair.
  assert.strictEqual(M.findInteractiveMsgStart('$$'), -1);
  assert.strictEqual(M.findInteractiveMsgStart('x$$'), -1);
});

test('removeInteractiveMsgTag keeps the tail and drops only the markers', () => {
  // core/Common.cpp:445, used by forms/MessageDlg.cpp:1050 — the dialog shows
  // the interactive sentence to the user, it is the log that must not carry it.
  assert.strictEqual(M.removeInteractiveMsgTag('body$$tail$$'), 'bodytail');
  assert.strictEqual(M.removeInteractiveMsgTag('a$$b$$c$$'), 'a$$bc');
  assert.strictEqual(M.removeInteractiveMsgTag('plain'), 'plain');
  assert.strictEqual(M.removeInteractiveMsgTag('$$tail$$ and more'), '$$tail$$ and more');

  const raw = M.loadStr('SFTP_OVERWRITE_FILE_ERROR2');
  const kept = M.removeInteractiveMsgTag(raw);
  assert.ok(!kept.includes(M.INTERACTIVE_MSG_TAG), 'a marker survived');
  assert.ok(kept.includes("Press 'Delete'"), 'the interactive sentence was thrown away');
  // The two are opposites: unformatMessage drops what this one keeps.
  assert.ok(!M.unformatMessage(raw).includes("Press 'Delete'"));
});

test('a highlight tag only counts when it opens the message', () => {
  // C++ guards on StartsStr before looking for the closing tag; without that a
  // '**' in the middle of a sentence would be read as a closing marker and the
  // first two characters of the message would be eaten as the instruction.
  assert.strictEqual(M.extractMainInstructions('x**a**b').found, false);
  assert.strictEqual(M.removeMainInstructionsTag('x**a**b'), 'x**a**b');
  assert.strictEqual(M.unformatMessage('x**a**b'), 'x**a**b');
});

test('every tagged message in the table survives being unformatted', () => {
  let tagged = 0;
  for (const name of M.ids()) {
    // The two tags are themselves resource strings; they are the delimiters,
    // not messages that carry them.
    if (name === 'MAIN_MSG_TAG' || name === 'INTERACTIVE_MSG_TAG') continue;
    const raw = M.loadStr(name);
    if (!raw.startsWith(M.MAIN_MSG_TAG) && !raw.endsWith(M.INTERACTIVE_MSG_TAG)) continue;
    tagged += 1;
    const plain = M.unformatMessage(raw);
    assert.ok(plain.length > 0, `${name} unformatted to nothing`);
    assert.ok(!plain.startsWith(M.MAIN_MSG_TAG), `${name} kept its highlight tag`);
    assert.ok(!plain.endsWith(M.INTERACTIVE_MSG_TAG), `${name} kept its interactive tag`);
  }
  assert.ok(tagged >= 45, `only ${tagged} tagged messages were exercised`);
});

/* ================================================================== */
/* the bilingual layer                                                 */
/* ================================================================== */

test('every voiced mapping names a real dictionary entry with the same parameters', async () => {
  const { I18N } = await dict();
  const slots = (s) => [...String(s).matchAll(/\{(\d+)\}/g)].map((m) => Number(m[1]));

  const pairs = Object.entries(M.I18N_KEYS);
  assert.ok(pairs.length >= 90, `only ${pairs.length} resource messages carry a second language`);

  for (const [id, key] of pairs) {
    assert.ok(M.has(id), `I18N_KEYS names resource id "${id}", which does not exist`);
    assert.ok(Object.prototype.hasOwnProperty.call(I18N, key),
      `${id} maps to dictionary key "${key}", which does not exist`);

    const entry = I18N[key];
    const en = Array.isArray(entry[0]) ? entry[0][0] : entry[0];
    const keyArity = slots(en).length ? Math.max(...slots(en)) + 1 : 0;
    assert.strictEqual(keyArity, M.arityOf(id),
      `${id} takes ${M.arityOf(id)} parameter(s) but "${key}" takes ${keyArity} — a voice would drop a fact`);

    // Named slots have no {n} counterpart, so a mapped message must not use one.
    assert.ok(!M.paramsOf(id).some((p) => p.kind === 'named'),
      `${id} uses a %NAME% slot the dictionary cannot express`);
  }
});

/**
 * Mapped ids whose English voice is NOT the resource's own wording once the
 * accelerator ampersands are removed. Most are cosmetic — WinSCP writes "..."
 * and the dictionary writes "…", or WinSCP title-cases a caption the dictionary
 * writes in sentence case. Two are not cosmetic and are recorded here as known
 * defects rather than hidden by a loose assertion:
 *
 *   COMPARE_NO_DIFFERENCES  "No differences found." states what the COMPARISON
 *       found; "Directories are already in sync." states something about the
 *       DIRECTORIES. forms/CustomScpExplorer.cpp:6790 raises it after a compare
 *       scoped by the copy parameters' include/exclude masks, so under a mask
 *       the resource sentence is true and the voiced one is false.
 *   USAGE_FILTER / FILTER_MASK_CAPTION  a field label ("&Filter:") and a dialog
 *       caption ("Filter") both map onto a menu command ("Filter…"). Three UI
 *       roles collapse into one string, and the label loses its colon.
 *
 * The list is pinned so a NEW lossy row fails this test. It is a ledger, not a
 * blessing: shrinking it is the fix.
 */
const VOICE_DIVERGES = [
  'BALLOON_QUEUE_EMPTY', 'CHECK_FOR_UPDATES_TITLE', 'COMPARE_NO_DIFFERENCES',
  'CONSOLE_MASTER_PASSWORD_PROMPT', 'COPY_MOVE_TOLOCAL_CAPTION', 'COPY_MOVE_TOREMOTE_CAPTION',
  'COPY_PARAM_CUSTOM', 'CUSTOM_COMMAND_AD_HOC', 'EDIT_SELECT_ALL', 'EXTENSION_OPTIONS_BROWSE',
  'FILTER_MASK_CAPTION', 'GENERATE_URL_FILE_TITLE', 'GENERATE_URL_SESSION_TITLE',
  'HOSTKEY_ONCE_BUTTON', 'LOGIN_NEW_SESSION_FOLDER_PROMPT', 'MOVE_BOOKMARK_PROMPT',
  'NEW_FOLDER', 'NEW_PASSWORD_CONFIRM_PROMPT', 'NEW_PASSWORD_CURRENT_PROMPT',
  'NEW_PASSWORD_NEW_PROMPT', 'PASSWORD_PROMPT', 'RENAME_PROMPT2', 'SAVE_SESSION_CAPTION',
  'SAVE_SESSION_FOLDER', 'SAVE_SESSION_PROMPT', 'SAVE_SESSION_ROOT_FOLDER2', 'SITE_RAW_ADD',
  'SSH_HOST_CA_BROWSE', 'SSH_HOST_CA_NAME', 'STATUS_AUTHENTICATE', 'STATUS_LOOKUPHOST',
  'UPDATE_URL_BUTTON', 'USAGE_COPY', 'USAGE_FILTER',
];

test('a voiced caption is ledgered when it stops being WinSCP\'s own wording', () => {
  // Vcl.Menus StripHotkey: '&' marks the accelerator and disappears, '&&' is a
  // literal ampersand. Compare on the stripped form, because losing the marker
  // is expected — losing the SENTENCE is not.
  const strip = (s) => String(s).replace(/&(.?)/g, (whole, next) => (next === '&' ? '&' : next));

  const diverging = Object.keys(M.I18N_KEYS)
    .filter((id) => !M.arityOf(id))
    .filter((id) => strip(M.loadStr(id)) !== M.voiced(id, { language: 'en', enLevel: 1 }))
    .sort();

  assert.deepStrictEqual(diverging, [...VOICE_DIVERGES].sort(),
    'a mapped message\'s English voice drifted from the resource wording — add it to ' +
    'VOICE_DIVERGES with a reason, or fix the mapping so the voice keeps WinSCP\'s sentence');

  // Whatever the voice does to the wording, the accelerator is gone from every
  // one of them. A consumer that needs the access key must read loadStr(), not
  // voiced() — this is asserted so the constraint is stated, not assumed.
  for (const id of Object.keys(M.I18N_KEYS)) {
    if (!M.loadStr(id).includes('&')) continue;
    assert.ok(!M.voiced(id, { language: 'en', enLevel: 1 }).includes('&'),
      `${id}: voiced() unexpectedly kept an ampersand`);
  }
});

test('substituted facts are byte-identical at every funny level, in both languages', async () => {
  await dict();
  let covered = 0;
  let assertions = 0;

  for (const id of Object.keys(M.I18N_KEYS)) {
    const arity = M.arityOf(id);
    if (!arity) continue;
    covered += 1;
    const args = [];
    for (let i = 0; i < arity; i += 1) args.push(SENTINEL[i % SENTINEL.length]);

    for (const language of ['en', 'yue']) {
      const counts = new Map(args.map((_, i) => [i, null]));
      for (const level of LEVELS) {
        const rendered = M.voiced(id, { language, enLevel: level, yueLevel: level }, ...args);

        assert.ok(!/\{\d+\}/.test(rendered),
          `${id} (${language}, level ${level}): an unsubstituted {n} survived — "${rendered}"`);
        assert.ok(!/%(?:\d+:)?[-+ #0]*\d*(?:\.\d+)?[sdux]/.test(rendered),
          `${id} (${language}, level ${level}): an unsubstituted %s survived — "${rendered}"`);

        args.forEach((sentinel, i) => {
          const n = countOf(rendered, sentinel);
          assert.ok(n >= 1,
            `${id} (${language}, level ${level}): parameter ${i} is missing from "${rendered}"`);
          const seen = counts.get(i);
          if (seen === null) counts.set(i, n);
          else {
            assert.strictEqual(n, seen,
              `${id} (${language}): parameter ${i} appears ${n} times at level ${level} but ${seen} at level 1 — the level changed a fact`);
          }
          assertions += 1;
        });
      }
    }
  }

  assert.ok(covered >= 3, `only ${covered} voiced messages carry parameters`);
  assert.ok(assertions >= 30, `only ${assertions} fact assertions ran`);
});

test('a voiced message really does change voice between level 1 and level 5', async () => {
  const { I18N } = await dict();
  const leveled = Object.entries(M.I18N_KEYS).filter(([, key]) => Array.isArray(I18N[key][0]));
  assert.ok(leveled.length >= 4, `only ${leveled.length} mapped messages have five voices`);

  for (const [id, key] of leveled) {
    const args = [];
    for (let i = 0; i < M.arityOf(id); i += 1) args.push(SENTINEL[i]);
    for (const language of ['en', 'yue']) {
      const serious = M.voiced(id, { language, enLevel: 1, yueLevel: 1 }, ...args);
      const playful = M.voiced(id, { language, enLevel: 5, yueLevel: 5 }, ...args);
      assert.notStrictEqual(serious, playful,
        `${id}/${key} (${language}): the slider does nothing here`);
      for (const arg of args) {
        assert.strictEqual(countOf(serious, arg), countOf(playful, arg),
          `${id} (${language}) moved a fact between levels`);
      }
    }
    assert.strictEqual(M.isVoiced(id), true);
  }
});

test('the two sliders are independent and bilingual mode joins both halves', () => {
  const host = SENTINEL[0];
  const seriousEn = M.voiced('IDS_STATUSMSG_CONNECTING', { language: 'en', enLevel: 1, yueLevel: 5 }, host);
  const playfulYue = M.voiced('IDS_STATUSMSG_CONNECTING', { language: 'yue', enLevel: 1, yueLevel: 5 }, host);
  const both = M.voiced('IDS_STATUSMSG_CONNECTING', { language: 'both', enLevel: 1, yueLevel: 5 }, host);

  assert.strictEqual(both, `${seriousEn} · ${playfulYue}`);
  assert.strictEqual(countOf(both, host), 2, 'bilingual mode should state the host in each half');
  assert.notStrictEqual(seriousEn, playfulYue);
  assert.match(playfulYue, /[㐀-鿿]/);
  assert.doesNotMatch(seriousEn, /[㐀-鿿]/);

  const pair = M.voicedPair('IDS_STATUSMSG_CONNECTING', { enLevel: 1, yueLevel: 5 }, host);
  assert.strictEqual(pair.en, seriousEn);
  assert.strictEqual(pair.yue, playfulYue);
});

test('funny levels clamp instead of blanking the message', () => {
  const host = 'srv';
  const atOne = M.voiced('IDS_STATUSMSG_CONNECTING', { language: 'en', enLevel: 1 }, host);
  const atFive = M.voiced('IDS_STATUSMSG_CONNECTING', { language: 'en', enLevel: 5 }, host);

  for (const [input, expected] of [[0, atOne], [-9, atOne], [6, atFive], [999, atFive], [NaN, null]]) {
    const rendered = M.voiced('IDS_STATUSMSG_CONNECTING', { language: 'en', enLevel: input }, host);
    assert.ok(rendered.includes(host), `level ${input} lost the host name`);
    if (expected) assert.strictEqual(rendered, expected, `level ${input} did not clamp`);
  }
  // An unknown mode falls back to a real language rather than rendering nothing.
  const unknown = M.voiced('IDS_STATUSMSG_CONNECTING', { language: 'klingon' }, host);
  assert.ok(unknown.length > 0 && unknown.includes(host));
});

test('an unmapped message keeps WinSCP\'s English in every mode and level', () => {
  // This is the honest majority: 1,427 messages exist and most have no
  // Cantonese counterpart yet. They must still render, identically, everywhere.
  const id = 'SKIP_STARTUP_MESSAGE_ERROR';
  assert.strictEqual(M.isVoiced(id), false);
  const base = M.loadStr(id);

  for (const language of ['en', 'yue', 'both']) {
    for (const level of LEVELS) {
      assert.strictEqual(M.voiced(id, { language, enLevel: level, yueLevel: level }), base);
    }
  }
  // Bilingual mode does not print the same English twice.
  assert.strictEqual(countOf(M.voiced(id, { language: 'both' }), 'Error skipping startup message.'), 1);

  // …and its parameters still substitute.
  assert.strictEqual(
    M.voiced('CHANGE_DIR_ERROR', { language: 'both', enLevel: 5, yueLevel: 5 }, '/srv/α'),
    "Error changing directory to '/srv/α'.");
});

/**
 * Arguments of the right shape for a message's declared slots, together with
 * the text each one must leave behind.
 *
 * A numeric conversion given a string is a refusal rather than a rendering, so
 * numeric slots get numbers — each distinct, so a lost one is still visible.
 * `%.2x` does not print its argument in decimal, so the expected text is what
 * that one slot formats to on its own; the arithmetic of each conversion is
 * checked directly in "numeric conversions honour width, precision and
 * padding", and what is being asserted here is that the slot was filled at all.
 */
function probeFor(id) {
  const record = M.meta(id);
  const args = [];
  for (let i = 0; i < (record.arity || 0); i += 1) args.push(SENTINEL[i % SENTINEL.length]);
  for (const p of record.params) {
    if (p.kind === 'named' || p.index === undefined || p.kind === 'string') continue;
    args[p.index] = 4200 + p.index;
  }
  const expected = [];
  for (const p of record.params) {
    if (p.kind === 'named' || p.index === undefined) continue;
    expected.push(M.format(p.token.replace(/^%\d+:/, '%'), [args[p.index]]));
  }
  return { args, expected: [...new Set(expected)] };
}

test('every message renders non-empty in every mode at every level', () => {
  for (const id of M.ids()) {
    if (['TRANSLATOR_INFO2', 'BIDI_MODE', 'FLIP_CHILDREN', 'TRANSLATOR_URL'].includes(id)) continue;
    if (M.meta(id).literalPercent) continue;             // read with LoadStr, never formatted
    const { args, expected } = probeFor(id);
    for (const language of ['en', 'yue', 'both']) {
      for (const level of LEVELS) {
        const rendered = M.voiced(id, { language, enLevel: level, yueLevel: level }, ...args);
        assert.strictEqual(typeof rendered, 'string', `${id} (${language}) is not a string`);
        assert.ok(rendered.length > 0, `${id} (${language}) rendered empty`);
        for (const text of expected) {
          assert.ok(rendered.includes(text),
            `${id} (${language}/${level}) lost the parameter ${JSON.stringify(text)}`);
        }
      }
    }
  }
});

test('the dictionary can be supplied explicitly instead of resolved', () => {
  const before = M.voiced('YES_STR', { language: 'yue' });
  M.registerVoices({ I18N: { yes: ['Aye', '好呀'] } });
  assert.strictEqual(M.voiced('YES_STR', { language: 'yue' }), '好呀');
  assert.strictEqual(M.voiced('YES_STR', { language: 'en' }), 'Aye');
  // A message with no entry in the injected dictionary falls back to English.
  assert.strictEqual(M.voiced('NO_STR', { language: 'yue' }), M.loadStr('NO_STR'));

  M.registerVoices(null);
  assert.strictEqual(M.voiced('YES_STR', { language: 'yue' }), M.loadStr('YES_STR'));

  // Restore the real dictionary for any test that runs after this one.
  M.registerVoices(require('../design/winscp-i18n.js'));
  assert.strictEqual(M.voiced('YES_STR', { language: 'yue' }), before);
});

/* ================================================================== */
/* what the resources say about the port                               */
/* ================================================================== */

test('the messages the ported modules need are all present', () => {
  // Every id a ported module reaches for must exist, so a wiring pass cannot
  // silently reintroduce hand-written English by typing an id that is not there.
  const NEEDED = [
    'CONNECTION_FAILED', 'LOST_CONNECTION', 'USER_TERMINATED', 'AUTHENTICATION_FAILED',
    'CHANGE_DIR_ERROR', 'LIST_DIR_ERROR', 'CREATE_DIR_ERROR', 'DELETE_FILE_ERROR',
    'RENAME_FILE_ERROR', 'READ_ERROR', 'WRITE_ERROR', 'OPENFILE_ERROR', 'FILE_NOT_EXISTS',
    'SFTP_STATUS_NO_SUCH_FILE', 'SFTP_STATUS_PERMISSION_DENIED', 'SFTP_STATUS_FAILURE',
    'SFTP_STATUS_OP_UNSUPPORTED', 'SFTP_ERROR_FORMAT3', 'SFTP_INITIALIZE_ERROR',
    'SCP_INVALID_CONTROL_RECORD', 'SCP_ILLEGAL_FILE_DESCRIPTOR',
    'NET_TRANSL_REFUSED2', 'NET_TRANSL_TIMEOUT2', 'NET_TRANSL_NO_ROUTE2',
    'CORE_ERROR_STRINGS', 'MAIN_MSG_TAG', 'INTERACTIVE_MSG_TAG',
    'FILE_OVERWRITE', 'DIRECTORY_OVERWRITE', 'READ_ONLY_OVERWRITE',
    'CONFIRM_DELETE_FILE', 'CONFIRM_DELETE_FILES', 'CONFIRM_DELETE_SESSION',
    'RESUME_TRANSFER2', 'PARTIAL_BIGGER_THAN_SOURCE', 'MULTI_FILES_TO_ONE',
    'CREATE_LOCAL_DIR_ERROR', 'EDITOR_ERROR', 'TOO_MANY_EDITORS',
    'CUSTOM_COMMAND_INVALID', 'CUSTOM_COMMAND_DUPLICATE', 'COPY_PARAM_DUPLICATE',
    'SCRIPT_COMMAND_UNKNOWN', 'SCRIPT_MISSING_PARAMS', 'SCRIPT_TOO_MANY_PARAMS',
    'SCRIPT_OPTION_UNKNOWN', 'SCRIPT_VALUE_UNKNOWN', 'SCRIPT_UNKNOWN_SWITCH',
    'TIME_RELATIVE', 'COPY_INFO_TRANSFER_TYPE2', 'COPY_INFO_FILENAME',
    'IDS_ERRORMSG_TIMEOUT', 'IDS_ERRORMSG_CANTRESOLVEHOST2', 'IDS_STATUSMSG_CONNECTING',
  ];
  const missing = NEEDED.filter((id) => !M.has(id));
  assert.deepStrictEqual(missing, [], 'the port depends on resource ids that were not extracted');
});

test('every message with parameters declares an arity that formatting satisfies', () => {
  // The whole table, driven end to end: if a parameter shape is wrong, feeding
  // it exactly `arity` arguments either throws or leaves a slot behind.
  let formatted = 0;
  for (const id of M.ids()) {
    const record = M.meta(id);
    if (!record.params.length) continue;
    if (record.literalPercent) continue;

    const { args, expected } = probeFor(id);
    const namedValues = {};
    for (const p of record.params) if (p.kind === 'named') namedValues[p.name] = `NAMED-${p.name}`;

    const rendered = M.format(record.text, args, namedValues, id);
    formatted += 1;

    for (const text of expected) {
      assert.ok(rendered.includes(text), `${id} dropped ${JSON.stringify(text)}: "${rendered}"`);
    }
    for (const p of record.params) {
      if (p.kind !== 'named') continue;
      assert.ok(rendered.includes(`NAMED-${p.name}`), `${id} left %${p.name}% unfilled: "${rendered}"`);
      assert.ok(!rendered.includes(p.token), `${id} kept the literal ${p.token}: "${rendered}"`);
    }
    // Every declared positional token is consumed, so none survives verbatim
    // unless a substituted value happened to contain one.
    assert.notStrictEqual(rendered, record.text, `${id} formatted to its own template`);
  }
  assert.ok(formatted >= 400, `only ${formatted} parameterized messages were exercised`);
});
