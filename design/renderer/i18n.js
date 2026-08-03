// i18n.js — three language modes and two independent funny-level sliders.
//
// The dictionary itself is design/winscp-i18n.js (EN + playful HK Cantonese,
// five levels where copy is voiced). This module does not restate any of it;
// it resolves, formats and binds it to the live UI.
//
//   t('connEstablished', host)        -> the string in the active mode
//   tPair('connEstablished', host)    -> { en, yue } for bilingual layout
//   bindText(el, key, ...params)      -> re-renders that element on change
//   subscribe(fn)                     -> called on any language/level change
//
// Bilingual mode never crowds the interface: t() returns "English · 粵語" for
// short strings, and bilingualNode() renders a prominent primary label with a
// compact secondary line for anything long enough to wrap.
//
// The funny level changes VOICE, never FACTS. Parameters ({0}, {1}) are
// substituted after resolution, so host names, paths, counts and version
// numbers are identical at level 1 and level 5.

import { I18N, resolveI18n } from '../winscp-i18n.js';
import { store, persistCurrent, bus } from './state.js';

export { I18N };

export const LANG_MODES = ['en', 'yue', 'both'];
export const LANG_LABELS = { en: 'English', yue: '粵語', both: 'EN · 粵' };

/** Level names, used by the preferences sliders' value labels. */
export const FUNNY_LABELS = {
  en: ['Fully serious', 'Plain', 'Balanced', 'Playful', 'Maximum playfulness'],
  yue: ['正經到底', '樸實', '啱啱好', '搞笑', '玩到盡'],
};

/* ------------------------------------------------------------------ */
/* resolution                                                          */
/* ------------------------------------------------------------------ */

function lang() { return store.get('language') || 'en'; }
function levelEn() { return clampLevel(store.get('funnyLevel.en')); }
function levelYue() { return clampLevel(store.get('funnyLevel.yue')); }
function clampLevel(v) { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(5, Math.max(1, n)) : 3; }

function format(str, params) {
  if (!params || !params.length) return str;
  return String(str).replace(/\{(\d+)\}/g, (m, i) => {
    const v = params[Number(i)];
    return v === undefined || v === null ? m : String(v);
  });
}

/**
 * The active-mode string for `key`. An unknown key returns the key itself
 * rather than an empty string, so a missing entry is visible in the UI and in
 * a screenshot instead of silently rendering blank.
 */
export function t(key, ...params) {
  const entry = I18N[key];
  if (!entry) return key;
  const resolved = resolveI18n(entry, lang(), levelEn(), levelYue());
  return format(resolved, params);
}

/** Both languages regardless of mode — for bilingual layout and for alt text. */
export function tPair(key, ...params) {
  const entry = I18N[key];
  if (!entry) return { en: key, yue: key };
  return {
    en: format(resolveI18n(entry, 'en', levelEn(), levelYue()), params),
    yue: format(resolveI18n(entry, 'yue', levelEn(), levelYue()), params),
  };
}

/** One specific language, ignoring the active mode (used by the narrator). */
export function tIn(language, key, ...params) {
  const entry = I18N[key];
  if (!entry) return key;
  return format(resolveI18n(entry, language, levelEn(), levelYue()), params);
}

/** True when the key exists — lets a module fall back to its own literal. */
export function has(key) { return Object.prototype.hasOwnProperty.call(I18N, key); }

/**
 * Contribute keys a module owns. design/winscp-i18n.js carries the shell's
 * dictionary; a feature module that ships hundreds of strings of its own adds
 * them here at import time rather than growing that file, and gets the same
 * resolution — three language modes, and both funny levels where the entry is
 * written as `[[en1..en5], [yue1..yue5]]`.
 *
 * An existing key is never overwritten: the shared dictionary stays the one
 * source of truth for anything two modules both render.
 */
export function defineStrings(dict) {
  let added = 0;
  for (const [key, entry] of Object.entries(dict)) {
    if (Object.prototype.hasOwnProperty.call(I18N, key)) continue;
    I18N[key] = entry;
    added += 1;
  }
  return added;
}

/**
 * Give an existing entry a voice.
 *
 * The funny level is advertised — in `disclosureText()` and in the settings
 * menu — as applying to EVERY category of message including errors, warnings
 * and destructive prompts. That promise was untrue: the shared dictionary
 * shipped its error strings as plain `[en, yue]` pairs, which resolveI18n reads
 * identically at level 1 and level 5. This is where those entries are given
 * their five levels, without editing the dictionary file itself.
 *
 * The rule the levels obey is the one the whole feature rests on: **voice
 * changes, facts do not**. Every level of every entry below carries exactly the
 * same `{0}`/`{1}` placeholders as the plain entry it replaces, so the file
 * name, the count, the pattern and the reason are byte-identical at level 1 and
 * level 5 — test/i18n.test.js proves that with byte-distinct sentinels.
 */
export function levelStrings(dict) {
  let upgraded = 0;
  for (const [key, entry] of Object.entries(dict)) {
    if (!Array.isArray(entry) || !Array.isArray(entry[0]) || !Array.isArray(entry[1])) {
      throw new Error(`levelStrings("${key}") needs [[en1..en5],[yue1..yue5]]`);
    }
    if (entry[0].length !== 5 || entry[1].length !== 5) {
      throw new Error(`levelStrings("${key}") needs exactly five levels in each language`);
    }
    I18N[key] = entry;
    upgraded += 1;
  }
  return upgraded;
}

/*
 * The error, warning and destructive-prompt entries the disclosure names. These
 * are exactly the category the shared instructions refuse to exempt, and the
 * category a reader is most likely to check.
 */
levelStrings({
  wrongPassword: [[
    'Access denied: the password was not accepted. Try again.',
    'Access denied — wrong password. Try again.',
    'Access denied — that password was not the one. Try again.',
    'Access denied. The password did not land; give it another go.',
    'Access denied! The server looked at that password and said no. One more try?'], [
    '拒絕存取：密碼唔獲接受，請再試。',
    '拒絕存取——密碼唔啱，再試過。',
    '拒絕存取——嗰個密碼唔係嗰個喎，再試過。',
    '拒絕存取。 密碼唔中，再嚟過啦。',
    '拒絕存取！ 伺服器望咗個密碼一眼，耍手擰頭。 再試多次？']],
  invalidPattern: [[
    'The pattern is not valid: {0}',
    'Invalid pattern: {0}',
    'That pattern will not compile: {0}',
    'The pattern did not survive being read: {0}',
    'The pattern fell over on its way in: {0}'], [
    '表達式唔合法：{0}',
    '表達式唔啱：{0}',
    '個表達式砌唔起：{0}',
    '個表達式讀到一半就散咗：{0}',
    '個表達式行到入嚟就仆咗街：{0}']],
  unsavedTabWarn: [[
    '{0} tab(s) contain unsaved work and were not closed.',
    '{0} tab(s) have work in progress and were kept open.',
    '{0} tab(s) still had work on the go, so they stayed.',
    '{0} tab(s) were mid-sentence, so they are still here.',
    '{0} tab(s) dug their heels in — unsaved work — and are still open.'], [
    '{0} 個分頁有未儲存嘅工作，冇閂。',
    '{0} 個分頁做緊嘢，照留返。',
    '{0} 個分頁重做緊嘢，所以留低咗。',
    '{0} 個分頁講到一半，唔捨得閂。',
    '{0} 個分頁死拉唔走——有嘢未存——照樣開住。']],
  unsavedBody: [[
    '"{0}" has unsaved changes. Save them before closing?',
    '"{0}" has unsaved changes. Save before closing?',
    '"{0}" has changes you have not saved. Save before closing?',
    '"{0}" is holding changes that only exist here. Save before closing?',
    '"{0}" has unsaved changes, and closing is where they go to vanish. Save first?'], [
    '「{0}」有未儲存嘅變更。 閂之前儲存唔儲存？',
    '「{0}」有未儲存嘅變更。閂之前要唔要儲存？',
    '「{0}」有啲改動你重未存。 閂之前存唔存？',
    '「{0}」啲改動而家淨係喺呢度存在。 閂之前存唔存？',
    '「{0}」有嘢未存，一閂就冇咗。 存返佢先？']],
  cpGamutWarn: [[
    'Outside sRGB: the value will be clipped when applied.',
    'Outside sRGB — value will clip when applied.',
    'Outside sRGB — this will be clipped on the way to the screen.',
    'Outside sRGB. The screen cannot show it, so it will be clipped.',
    'Outside sRGB — a lovely colour your monitor has never met. It will be clipped.'], [
    '超出 sRGB：套用嗰陣個值會俾裁剪。',
    '超出 sRGB——套用時會被裁剪。',
    '超出 sRGB——去到螢幕嗰陣會俾裁走。',
    '超出 sRGB。 螢幕顯示唔到，所以會俾裁剪。',
    '超出 sRGB——好靚嘅顏色，但你部螢幕未見過。 會俾裁剪。']],
  notConnected: [[
    'This tab is not connected.',
    'This tab is not connected.',
    'This tab has no session open.',
    'This tab is not connected to anything yet.',
    'This tab is not connected to anything at all, yet.'], [
    '呢個分頁未連線。',
    '呢個分頁未連線。',
    '呢個分頁未開任何工作階段。',
    '呢個分頁重未連到去邊度。',
    '呢個分頁而家邊度都未連到。']],
  siteDeleted: [[
    'Site "{0}" was deleted.',
    'Site "{0}" deleted.',
    'Site "{0}" is gone.',
    'Site "{0}" has been deleted.',
    'Site "{0}" has left the building.'], [
    '站點「{0}」已刪除。',
    '站點「{0}」刪咗。',
    '站點「{0}」冇咗。',
    '站點「{0}」已經刪除咗。',
    '站點「{0}」執包袱走人喇。']],
});

/* Shared search and regex-builder copy belongs in the common dictionary so
 * every search surface follows the same language and funny-level contract. */
defineStrings({
  searchPlainHint: ['Plain text search. Press the .* button for regular expressions.', '純文字搜尋。撳 .* 按鈕用正規表達式。'],
  searchRegexHint: ['Regular expression mode, JavaScript RegExp, flags {0}.', '正規表達式模式，JavaScript RegExp，旗標 {0}。'],
  rbPatternAria: ['Regular expression pattern', '正規表達式模式'],
  rbFlagsAria: ['Flags', '旗標'], rbConstructsAria: ['Insert a construct', '插入構件'],
  rbSampleAria: ['Sample text', '樣本文字'], rbSamplePlaceholder: ['Paste sample text to test against', '貼上要測試嘅樣本文字'],
  rbLiveMatches: ['Live matches', '即時配對'], rbNoSample: ['(no sample text)', '（冇樣本文字）'],
  rbUnmatched: ['(unmatched)', '（未配對）'], rbEmpty: ['(empty)', '（空白）'],
  rbMatchTitle: ['Match {0}', '配對 {0}'], rbMoreGroups: ['…and {0} more.', '……仲有 {0} 個。'], rbFirstShown: ['first {0} shown', '頭 {0} 個顯示'],
  rbLiteralPrompt: ['Literal text to match (it will be escaped):', '要配對嘅文字（會自動跳脫）：'],
  rbMatchOne: ['match', '個配對'], rbMatchMany: ['matches', '個配對'],
  rbCopyFailed: ['Copy failed.', '複製失敗。'],
  rbRunawayShort: ['Runaway regular expression stopped. Simplify the pattern.', '失控嘅正規表達式已停止。請簡化表達式。'],
  rbCatLiterals: ['Literals', '文字常值'], rbCatClasses: ['Character classes', '字元類別'],
  rbCatAnchors: ['Anchors', '錨點'], rbCatGroups: ['Groups', '群組'],
  rbCatAlternation: ['Alternation', '交替'], rbCatLookaround: ['Lookaround', '前後查找'],
  rbCatQuantifiers: ['Quantifiers', '量詞'],
  rbConstructText: ['Text (escaped)', '文字（自動跳脫）'], rbConstructAny: ['Any character', '任何字元'],
  rbConstructDigit: ['Digit', '數字'], rbConstructNonDigit: ['Non-digit', '非數字'],
  rbConstructWord: ['Word character', '文字字元'], rbConstructWhitespace: ['Whitespace', '空白字元'],
  rbConstructClass: ['Character class', '字元類別'], rbConstructNegatedClass: ['Negated class', '反向字元類別'],
  rbConstructRange: ['Range', '範圍'], rbConstructStart: ['Start of line', '行首'], rbConstructEnd: ['End of line', '行尾'],
  rbConstructBoundary: ['Word boundary', '文字邊界'], rbConstructGroup: ['Group', '群組'],
  rbConstructNamedGroup: ['Named group', '命名群組'], rbConstructNonCapturing: ['Non-capturing', '唔擷取'],
  rbConstructAlternation: ['Alternation', '交替'], rbConstructZeroOrMore: ['0 or more', '零次或以上'],
  rbConstructOneOrMore: ['1 or more', '一次或以上'], rbConstructOptional: ['Optional', '可選'],
  rbConstructExactly: ['Exactly n', '剛好 n 次'], rbConstructBetween: ['Between n,m', 'n 至 m 次'],
  rbConstructLazy: ['Lazy', '懶惰配對'], rbConstructLookahead: ['Lookahead', '向前查找'],
  rbConstructNegLookahead: ['Neg. lookahead', '反向向前查找'], rbConstructLookbehind: ['Lookbehind', '向後查找'],
  rbConstructUnicode: ['Unicode letter', 'Unicode 字母'],
  rbDescText: ['Literal text, special characters escaped', '文字常值，特殊字元會自動跳脫'],
  rbDescAny: ['Matches any single character except newline', '配對除換行外嘅任何單一字元'],
  rbDescDigit: ['0-9', '數字 0-9'], rbDescNonDigit: ['Anything but 0-9', '除 0-9 之外嘅任何字元'],
  rbDescWord: ['Letter, digit or underscore', '字母、數字或者底線'], rbDescWhitespace: ['Space, tab, newline', '空格、Tab、換行'],
  rbDescClass: ['Any one of the listed characters', '列出字元其中一個'], rbDescNegatedClass: ['Any character NOT listed', '未列出嘅任何字元'],
  rbDescRange: ['Any character in the range', '範圍內任何字元'], rbDescStart: ['Anchor: start', '錨點：開頭'], rbDescEnd: ['Anchor: end', '錨點：結尾'],
  rbDescBoundary: ['Between word and non-word', '文字同非文字之間'], rbDescGroup: ['Capture group', '擷取群組'],
  rbDescNamedGroup: ['Capture group with a name', '有名稱嘅擷取群組'], rbDescNonCapturing: ['Group without capturing', '唔擷取嘅群組'],
  rbDescAlternation: ['Either the left or the right side', '左邊或者右邊其中一邊'], rbDescZeroOrMore: ['Quantifier', '量詞'],
  rbDescOneOrMore: ['Quantifier', '量詞'], rbDescOptional: ['0 or 1', '0 或 1 次'], rbDescExactly: ['Quantifier {n}', '量詞 {n}'],
  rbDescBetween: ['Quantifier {n,m}', '量詞 {n,m}'], rbDescLazy: ['Match as little as possible', '盡量配對最少'],
  rbDescLookahead: ['Followed by, without consuming', '後面跟住，但唔消耗文字'], rbDescNegLookahead: ['NOT followed by', '後面唔可以跟住'],
  rbDescLookbehind: ['Preceded by', '前面跟住'], rbDescUnicode: ['Any letter (needs u flag)', '任何字母（需要 u 旗標）'],
  rbFlagGlobal: ['global — all matches', '全域——配對全部'], rbFlagIgnoreCase: ['ignore case', '忽略大小寫'],
  rbFlagMultiline: ['multiline ^ $', '多行 ^ $'], rbFlagDotAll: ['dot matches newline', '點號配對換行'],
  rbFlagUnicode: ['unicode', 'Unicode'], rbFlagSticky: ['sticky', '黏性'],
});

export const RB_CONSTRUCT_KEYS = Object.freeze({
  'Text (escaped)': 'rbConstructText', 'Any character': 'rbConstructAny', Digit: 'rbConstructDigit',
  'Non-digit': 'rbConstructNonDigit', 'Word character': 'rbConstructWord', Whitespace: 'rbConstructWhitespace',
  'Character class': 'rbConstructClass', 'Negated class': 'rbConstructNegatedClass', Range: 'rbConstructRange',
  'Start of line': 'rbConstructStart', 'End of line': 'rbConstructEnd', 'Word boundary': 'rbConstructBoundary',
  Group: 'rbConstructGroup', 'Named group': 'rbConstructNamedGroup', 'Non-capturing': 'rbConstructNonCapturing',
  Alternation: 'rbConstructAlternation', '0 or more': 'rbConstructZeroOrMore', '1 or more': 'rbConstructOneOrMore',
  Optional: 'rbConstructOptional', 'Exactly n': 'rbConstructExactly', 'Between n,m': 'rbConstructBetween',
  Lazy: 'rbConstructLazy', Lookahead: 'rbConstructLookahead', 'Neg. lookahead': 'rbConstructNegLookahead',
  Lookbehind: 'rbConstructLookbehind', 'Unicode letter': 'rbConstructUnicode',
});
export const RB_CONSTRUCT_DESCRIPTION_KEYS = Object.freeze({
  'Text (escaped)': 'rbDescText', 'Any character': 'rbDescAny', Digit: 'rbDescDigit', 'Non-digit': 'rbDescNonDigit',
  'Word character': 'rbDescWord', Whitespace: 'rbDescWhitespace', 'Character class': 'rbDescClass',
  'Negated class': 'rbDescNegatedClass', Range: 'rbDescRange', 'Start of line': 'rbDescStart', 'End of line': 'rbDescEnd',
  'Word boundary': 'rbDescBoundary', Group: 'rbDescGroup', 'Named group': 'rbDescNamedGroup', 'Non-capturing': 'rbDescNonCapturing',
  Alternation: 'rbDescAlternation', '0 or more': 'rbDescZeroOrMore', '1 or more': 'rbDescOneOrMore', Optional: 'rbDescOptional',
  'Exactly n': 'rbDescExactly', 'Between n,m': 'rbDescBetween', Lazy: 'rbDescLazy', Lookahead: 'rbDescLookahead',
  'Neg. lookahead': 'rbDescNegLookahead', Lookbehind: 'rbDescLookbehind', 'Unicode letter': 'rbDescUnicode',
});
export const RB_FLAG_KEYS = Object.freeze({ g: 'rbFlagGlobal', i: 'rbFlagIgnoreCase', m: 'rbFlagMultiline', s: 'rbFlagDotAll', u: 'rbFlagUnicode', y: 'rbFlagSticky' });
export const RB_CATEGORY_KEYS = Object.freeze({
  Literals: 'rbCatLiterals', 'Character classes': 'rbCatClasses', Anchors: 'rbCatAnchors', Groups: 'rbCatGroups',
  Alternation: 'rbCatAlternation', Lookaround: 'rbCatLookaround', Quantifiers: 'rbCatQuantifiers',
});

levelStrings({
  searchPlainModeOn: [['Plain text search mode on.', 'Plain text mode on.', 'Plain text search is on.', 'The search is sticking with plain text.', 'Plain text is steering this search now!'], ['純文字搜尋模式開咗。', '純文字模式開咗。', '而家用緊純文字搜尋。', '個搜尋決定返用純文字。', '呢個搜尋而家由純文字揸車！']],
  searchRegexModeOn: [['Regular expression mode on.', 'Regex mode on.', 'Regular expressions are on.', 'The search is ready for regex gymnastics.', 'Regex has entered the search arena!'], ['正規表達式模式開咗。', 'Regex 模式開咗。', '而家用緊正規表達式。', '個搜尋準備好做 regex 體操。', 'Regex 入咗搜尋競技場！']],
  searchNoMatch: [['Nothing in {0} matches {1}.', 'No match in {0}: {1}.', 'Nothing in {0} matches {1}.', 'Nothing in {0} can dodge {1}.', 'Nothing in {0} survived the search net for {1}.'], ['{0} 入面冇嘢配對到 {1}。', '{0} 入面搵唔到 {1}：冇配對。', '{0} 入面冇嘢配對到 {1}。', '{0} 入面冇嘢走得甩 {1}。', '{0} 入面冇一樣嘢避得過 {1} 個搜尋網。']],
  rbEmptyPattern: [['Empty pattern — everything matches. Type or use Build below.', 'Empty pattern — everything matches.', 'The pattern is empty, so everything matches. Type or use Build below.', 'No pattern yet — the whole sample gets a friendly hello.', 'An empty pattern! Every sample character gets invited to the party.'], ['表達式係空嘅——全部都會配對。打字或者用下面嘅建構器。', '表達式空咗——全部配對。', '表達式冇內容，所以全部都配對。打字或者用下面嘅建構器。', '重未有表達式——成份樣本都收到友善招呼。', '空表達式！樣本每個字元都收到派對邀請。']],
  rbRunaway: [['Runaway pattern — evaluation was stopped after {0} ms. Simplify the pattern.', 'Pattern evaluation stopped after {0} ms; simplify it.', 'This pattern was stopped after {0} ms because it backtracks too much.', 'The pattern took a detour after {0} ms. Simplify its nested quantifiers.', 'The regex sprinted into the bushes after {0} ms; simplify the nested quantifiers.'], ['失控表達式——{0} 毫秒後停止測試。請簡化表達式。', '表達式測試喺 {0} 毫秒後停止；請簡化佢。', '呢個表達式回溯太多，所以 {0} 毫秒後停止。', '個表達式喺 {0} 毫秒後行咗遠路。請簡化入面嘅量詞。', '個 regex 喺 {0} 毫秒後衝入草叢；請簡化入面嘅量詞。']],
  rbRisk: [['Valid, but this shape can backtrack catastrophically on longer input.', 'Valid, but this shape may backtrack heavily on longer input.', 'Valid, though this shape can do a lot of backtracking on longer input.', 'Valid, but the nested quantifiers may send it on a long backtracking hike.', 'Valid, but this pattern has a talent for getting lost in backtracking.'], ['表達式正確，但輸入較長時呢個形狀可能會災難式回溯。', '表達式正確，但輸入較長時呢個形狀可能大量回溯。', '表達式正確，不過輸入較長時呢個形狀可能做好多回溯。', '表達式正確，但入面嘅量詞可能帶佢行一轉漫長回溯山路。', '表達式正確，但呢個模式好有天份喺回溯入面迷路。']],
  rbValid: [['Valid. {0} {1} in {2} ms.', 'Valid: {0} {1}, {2} ms.', 'Valid. {0} {1} found in {2} ms.', 'Valid — {0} {1} arrived in {2} ms.', 'Valid! {0} {1} crossed the finish line in {2} ms.'], ['正確。{0} {1}，用咗 {2} 毫秒。', '正確：{0} {1}，{2} 毫秒。', '正確。搵到 {0} {1}，用咗 {2} 毫秒。', '正確——{0} {1} 用 {2} 毫秒到埗。', '正確！{0} {1} 用 {2} 毫秒衝過終點。']],
  rbCopyAnnounce: [['Pattern copied to the clipboard.', 'Pattern copied.', 'The pattern is on the clipboard.', 'Pattern copied — the clipboard has adopted it.', 'Pattern copied! The clipboard is now wearing regex.'], ['表達式已複製到剪貼簿。', '表達式複製咗。', '表達式已經喺剪貼簿。', '表達式複製咗——剪貼簿收養咗佢。', '表達式複製成功！剪貼簿而家著住 regex。']],
  rbExportAnnounce: [['Pattern exported.', 'Pattern exported.', 'The pattern was exported.', 'Pattern has left the builder in an export file.', 'Pattern exported! It is off on a file-shaped adventure.'], ['表達式已匯出。', '表達式匯出咗。', '表達式已經匯出。', '表達式離開建構器，入咗匯出檔案。', '表達式匯出成功！而家展開檔案形狀嘅冒險。']],
  rbApplyInvalid: [['Cannot apply: {0}', 'Cannot apply: {0}', 'The pattern cannot be applied: {0}', 'The pattern tripped at the apply gate: {0}', 'Apply declined — the regex fell over first: {0}'], ['未能套用：{0}', '套用唔到：{0}', '呢個表達式未能套用：{0}', '個表達式喺套用閘口跣低咗：{0}', '拒絕套用——regex 自己先仆低咗：{0}']],
});

/** Every key, for the changelog/settings search surfaces to index. */
export function keys() { return Object.keys(I18N); }

/* ------------------------------------------------------------------ */
/* bilingual rendering                                                 */
/* ------------------------------------------------------------------ */

const CROWD_LIMIT = 28;   // characters — above this, stack instead of inlining

/**
 * Render `key` for a label position. In bilingual mode short strings inline
 * with a middle dot; long ones become a prominent primary line plus a compact
 * secondary line, so a 5-level Cantonese sentence never overflows a control.
 *
 * Returns a DocumentFragment so callers can drop it straight into a button.
 */
export function bilingualNode(key, ...params) {
  const mode = lang();
  const frag = document.createDocumentFragment();
  if (mode !== 'both') {
    frag.appendChild(document.createTextNode(t(key, ...params)));
    return frag;
  }
  const { en, yue } = tPair(key, ...params);
  if (en === yue) { frag.appendChild(document.createTextNode(en)); return frag; }
  if (en.length + yue.length <= CROWD_LIMIT) {
    frag.appendChild(document.createTextNode(`${en} · ${yue}`));
    return frag;
  }
  const primary = document.createElement('span');
  primary.className = 'bi-primary';
  primary.textContent = en;
  const secondary = document.createElement('span');
  secondary.className = 'bi-secondary';
  secondary.lang = 'yue-Hant-HK';
  secondary.textContent = yue;
  frag.appendChild(primary);
  frag.appendChild(secondary);
  return frag;
}

/** The same decision, as a boolean, for callers laying out their own nodes. */
export function bilingualStacks(key, ...params) {
  if (lang() !== 'both') return false;
  const { en, yue } = tPair(key, ...params);
  return en !== yue && en.length + yue.length > CROWD_LIMIT;
}

/* ------------------------------------------------------------------ */
/* live binding                                                        */
/* ------------------------------------------------------------------ */

const bindings = new Set();

function refreshAll() {
  for (const b of Array.from(bindings)) {
    if (!b.el.isConnected) { bindings.delete(b); continue; }
    try { b.render(); } catch (err) { console.error('[i18n] binding failed', err); }
  }
  bus.emit('i18n:changed', { language: lang(), funnyLevel: { en: levelEn(), yue: levelYue() } });
}

/**
 * Bind an element's text to a key. The element re-renders whenever the
 * language mode or either funny level changes — no page reload, no re-mount.
 *
 * opts.attr writes to an attribute instead ('title', 'aria-label', 'placeholder').
 * opts.params may be a function so parameters can be recomputed on each render.
 */
export function bindText(el, key, opts = {}) {
  const render = () => {
    const params = typeof opts.params === 'function' ? opts.params() : (opts.params || []);
    if (opts.attr) { el.setAttribute(opts.attr, t(key, ...params)); return; }
    while (el.firstChild) el.removeChild(el.firstChild);
    el.appendChild(opts.bilingualBlock === false
      ? document.createTextNode(t(key, ...params))
      : bilingualNode(key, ...params));
  };
  const binding = { el, key, render };
  bindings.add(binding);
  render();
  return () => bindings.delete(binding);
}

/** Bind arbitrary rendering (a whole subtree) to language changes. */
export function bindRender(el, render) {
  const binding = { el, key: null, render };
  bindings.add(binding);
  render();
  return () => bindings.delete(binding);
}

/** A <span> already bound to a key. The most common call in the app. */
export function label(key, opts = {}) {
  const el = document.createElement(opts.tag || 'span');
  if (opts.class) el.className = opts.class;
  bindText(el, key, opts);
  return el;
}

const subscribers = new Set();
/** subscribe(fn) — fn() runs on every language/level change. */
export function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

function notify() {
  refreshAll();
  for (const fn of Array.from(subscribers)) {
    try { fn({ language: lang(), funnyLevel: { en: levelEn(), yue: levelYue() } }); }
    catch (err) { console.error('[i18n] subscriber failed', err); }
  }
  document.documentElement.lang = lang() === 'yue' ? 'yue-Hant-HK' : lang() === 'both' ? 'en' : 'en';
  document.documentElement.dataset.lang = lang();
}

/* ------------------------------------------------------------------ */
/* mutators                                                            */
/* ------------------------------------------------------------------ */

export function setLanguage(mode) {
  if (!LANG_MODES.includes(mode)) return;
  store.set('language', mode);
  persistCurrent('language');
}

export function cycleLanguage() {
  const i = LANG_MODES.indexOf(lang());
  setLanguage(LANG_MODES[(i + 1) % LANG_MODES.length]);
}

/** Independent per-language slider, 1 (fully serious) … 5 (maximum play). */
export function setFunnyLevel(language, level) {
  if (language !== 'en' && language !== 'yue') return;
  store.set(`funnyLevel.${language}`, clampLevel(level));
  persistCurrent('funnyLevel');
}

export function getFunnyLevel(language) { return language === 'yue' ? levelYue() : levelEn(); }
export function getLanguage() { return lang(); }

/**
 * The honest disclosure the user is shown before opting in: the funny level
 * styles EVERY category of message, including errors and warnings. Facts are
 * never removed — only the voice around them changes.
 */
export function disclosureText() {
  // The count is read from the dictionary rather than written down, so this
  // sentence cannot drift away from the truth the way a hard-coded claim would.
  const voiced = Object.keys(I18N).filter((k) => Array.isArray(I18N[k][0])).length;
  const en = 'The funny level changes the WORDING of messages, never what they say. '
    + 'No category is exempt: errors, warnings and destructive-action prompts are styled like everything else. '
    + `${voiced} of this build's messages are written with five voices and change as you move the slider; `
    + 'the rest are single-voiced and read the same at every level — a label, a menu entry or a column heading has one right wording. '
    + 'What a message states never changes: the file, the account, the action and whether it can be undone are always in plain words. '
    + 'You can change or reset both sliders at any time in Preferences → Languages.';
  const yue = '好笑程度改嘅係語氣，唔會改內容。'
    + '冇任何一類豁免：錯誤、警告同埋唔可以復原嘅操作提示，一律照樣有語氣。'
    + `呢個版本入面有 ${voiced} 句訊息寫咗五個語氣，會跟住拉桿變；`
    + '其餘嘅得一個講法，每一級都一樣——標籤、選單項目、欄名，本來就得一個啱嘅寫法。'
    + '訊息講嘅嘢永遠唔會變——邊個檔案、邊個帳戶、做乜嘢、可唔可以還原，一律照直講。'
    + '你隨時可以喺「偏好設定 → 語言」度改返或者重設兩條拉桿。';
  const mode = lang();
  if (mode === 'en') return en;
  if (mode === 'yue') return yue;
  return `${en}\n\n${yue}`;
}

/* ------------------------------------------------------------------ */
/* engine                                                             */
/* ------------------------------------------------------------------ */

let started = false;

export function startI18n() {
  if (started) return;
  started = true;
  store.subscribe('language', notify, { immediate: false });
  store.subscribe('funnyLevel', notify, { immediate: false });
  notify();
}

/**
 * A plain-language description of the active mode, for the title-bar chip's
 * tooltip. Names the mode and both levels so the state is never a mystery.
 */
export function languageSummary() {
  const modeName = { en: 'English', yue: '粵語 (Cantonese)', both: 'Bilingual · 雙語' }[lang()];
  return `${modeName} — EN funny level ${levelEn()}/5, 粵語 ${levelYue()}/5`;
}
