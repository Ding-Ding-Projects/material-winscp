// lib/i18n.js — three language modes, two independent funny-level sliders.
//
// Dictionary shape, identical to design/winscp-i18n.js so the site and the app
// speak the same format:
//
//   plain    key: ['English', '粵語']
//   leveled  key: [[e1,e2,e3,e4,e5], [y1,y2,y3,y4,y5]]      1 = serious … 5 = maximum
//
// THE RULE THE WHOLE THING STANDS ON: the level changes VOICE, never FACTS.
// A level-5 rewrite that drops "{0}" from a warning still reads beautifully
// and has silently stopped telling the reader which thing is about to change.
// So every leveled entry carries the same parameters at every level, and
// test/site-app.test.js substitutes a byte-distinct sentinel for each one and
// asserts it survives at all five levels in both languages. If a future
// rewrite loses a parameter, that test fails long before a screenshot would.
//
// Nothing here touches the DOM, so the whole resolution path runs headlessly.

export const LANGS = ['en', 'yue', 'both'];
export const LEVELS = [1, 2, 3, 4, 5];

export const DICT = {
  /* -------------------------------------------------------------- chrome */
  siteTitle: ['Documentation', '文件'],
  home: ['Home', '主頁'],
  settings: ['Settings', '設定'],
  search: ['Search', '搜尋'],
  searchDocs: ['Search the documentation', '搵文件'],
  categories: ['Categories', '分類'],
  articles: ['Articles', '文章'],
  article: ['Article', '文章'],
  onThisPage: ['On this page', '呢版有'],
  suggested: ['Suggested articles', '推薦文章'],
  backHome: ['Back to home', '返主頁'],
  repository: ['Repository', '程式碼倉'],
  toggleTheme: ['Toggle light and dark', '切換淺色深色'],
  openSettings: ['Settings', '設定'],
  skipToContent: ['Skip to content', '跳去內容'],
  notFound: [[
    'That page is not in this site.',
    'There is no such page on this site.',
    'No such page here — check the address, or search for it below.',
    'That address does not lead anywhere on this site. The search box below will find the article if it exists.',
    'Nothing at that address! Not a page, not a paragraph, not a crumb. Have a poke at the search box below — the article may be hiding under a slightly different name.'], [
    '呢版喺呢個網站度搵唔到。',
    '呢個網站冇呢一版。',
    '呢度冇呢版——check 下個地址，或者用下面搜尋。',
    '嗰個地址喺呢個網站度去唔到任何地方。下面個搜尋框可以幫你搵返篇文（如果佢真係存在）。',
    '嗰個地址乜都冇！一版都冇、一段都冇、連渣都冇。試下用下面個搜尋框啦——篇文可能改咗個名喺度匿埋。']],
  words: ['{0} words', '{0} 個字'],
  readingTime: ['about {0} min', '大約 {0} 分鐘'],
  built: ['Built {0}', '{0} 整'],
  versionLine: ['Version {0} ({1})', '版本 {0}（{1}）'],

  /* ------------------------------------------------------------- landing */
  heroTitle: [[
    'Every WinSCP feature. Material Design 3.',
    'Every WinSCP feature, in Material Design 3.',
    'All of WinSCP — rebuilt in Material Design 3.',
    'The whole of WinSCP, restyled head to toe in Material Design 3.',
    'Every last WinSCP feature, lovingly steamed and served in a Material Design 3 bamboo basket.'], [
    'WinSCP 全部功能。Material Design 3。',
    'WinSCP 每個功能，都用 Material Design 3 重做。',
    '成個 WinSCP，用 Material Design 3 重新起過。',
    'WinSCP 由頭到腳換晒 Material Design 3 新裝。',
    'WinSCP 每一個功能，落足心機蒸熟，用 Material Design 3 竹蒸籠原籠奉上。']],
  heroBlurb: [[
    'SFTP, SCP, FTP/FTPS, WebDAV and S3 file transfer for Windows.',
    'SFTP, SCP, FTP/FTPS, WebDAV and S3 file transfer for Windows.',
    'SFTP, SCP, FTP/FTPS, WebDAV and S3 — your files, moved properly.',
    'SFTP, SCP, FTP/FTPS, WebDAV and S3: five ways to get a file where it belongs.',
    'SFTP, SCP, FTP/FTPS, WebDAV and S3 — five different ways to fling a file across the internet and have it land right side up.'], [
    'Windows 上嘅 SFTP、SCP、FTP/FTPS、WebDAV 同 S3 檔案傳輸。',
    'Windows 上嘅 SFTP、SCP、FTP/FTPS、WebDAV 同 S3 檔案傳輸。',
    'SFTP、SCP、FTP/FTPS、WebDAV 同 S3——你啲檔案，穩陣咁搬。',
    'SFTP、SCP、FTP/FTPS、WebDAV 同 S3：五種方法送檔案返屋企。',
    'SFTP、SCP、FTP/FTPS、WebDAV 同 S3——五種方法將檔案掟過互聯網，仲要包保跌落地都係正面向上。']],
  browseDocs: ['Browse the documentation', '睇文件'],
  downloadFor: ['Download for {0}', '下載 {0} 版'],
  downloadVersion: ['Version {0} · {1}', '版本 {0} · {1}'],
  downloadNone: [[
    'This page has no verified installer to offer yet.',
    'This page has no verified installer available yet.',
    'No verified installer to hand out here yet — the page only links assets it can check.',
    'This page has no verified installer to point at yet; it will not invent a download link.',
    'The pantry has no installer this page can verify yet — it refuses to cook up a download link from guesswork.'], [
    '呢版暫時冇可以核實嘅安裝檔。',
    '呢版暫時冇核實得到嘅安裝檔。',
    '呢版暫時冇核實得到嘅安裝檔派——淨係連返查證得到嘅檔案。',
    '呢版暫時冇可以核實嘅安裝檔，所以唔會亂作下載連結。',
    '櫃桶暫時冇呢版查證得到嘅安裝檔——唔會靠估煮個下載連結出嚟。']],
  downloadNoneWhy: ['This page only links a release asset it can verify, so no button is shown rather than a guessed URL.',
    '呢版淨係連得到核實得到嘅發佈檔案，所以寧願唔顯示個掣，都唔會亂估個網址。'],
  featureCount: ['{0} articles across {1} categories', '{1} 個分類，{0} 篇文章'],

  /* -------------------------------------------------------------- search */
  searchPlain: ['Plain text', '純文字'],
  searchRegex: ['Regular expression', '正規表達式'],
  regexBuilder: ['Regex builder', 'Regex 建構器'],
  openRegexBuilder: ['Open the regex builder', '開 regex 建構器'],
  rbPattern: ['Pattern', '式樣'],
  rbFlags: ['Flags', '旗標'],
  rbSample: ['Sample text', '樣本文字'],
  rbMatches: ['{0} matches', '{0} 個結果'],
  rbNoMatch: ['No match in the sample text.', '樣本文字入面夾唔到。'],
  rbInvalid: ['Invalid pattern: {0}', '式樣唔啱：{0}'],
  rbRefused: ['Refused: {0}', '拒絕執行：{0}'],
  rbEngine: ['Engine: {0}', '引擎：{0}'],
  rbCopy: ['Copy pattern', '複製式樣'],
  rbExport: ['Export', '匯出'],
  rbApply: ['Use this pattern', '用呢個式樣'],
  rbInsert: ['Insert', '插入'],
  rbEmptyMatch: ['(empty match)', '（空白結果）'],
  rbTruncated: ['Stopped after {0} matches.', '夾到 {0} 個之後就停。'],
  rbLocalOnly: ['Everything is evaluated in this browser. No pattern or sample text is sent anywhere.',
    '全部喺呢個瀏覽器度計。式樣同樣本文字唔會送去任何地方。'],
  searchResults: ['{0} results for {1}', '{1} 有 {0} 個結果'],
  searchNothing: [[
    'Nothing matched {0}.',
    'No article matched {0}.',
    'Not a single article matched {0}.',
    'Searched every article and came back empty-handed for {0}.',
    'Turned the whole site upside down, shook it, and not one crumb matched {0}.'], [
    '{0} 搵唔到嘢。',
    '冇文章夾到 {0}。',
    '一篇文章都夾唔到 {0}。',
    '成個站搵勻晒，{0} 都係空手而回。',
    '成個網站揦起嚟倒轉狂搖，一粒屑都夾唔到 {0}。']],

  /* ---------------------------------------------------------------- tabs */
  tabs: ['Tabs', '分頁'],
  pin: ['Pin', '釘住'],
  unpin: ['Unpin', '解除釘住'],
  closeTab: ['Close tab', '閂分頁'],
  closeOthers: ['Close other tabs', '閂其他分頁'],
  closeRight: ['Close tabs to the right', '閂右邊嘅分頁'],
  moveLeft: ['Move left', '向左移'],
  moveRight: ['Move right', '向右移'],
  tabsMore: ['{0} more', '仲有 {0} 個'],
  tabsOverflow: ['Tabs that do not fit', '擺唔落嘅分頁'],
  searchTabs: ['Search tabs', '搵分頁'],
  closeContaining: ['Close tabs containing text…', '閂含有文字嘅分頁…'],
  closeNotContaining: ['Close tabs not containing text…', '閂唔含有文字嘅分頁…'],
  willClose: ['{0} of {1} tabs will close: {2}', '{1} 個分頁入面會閂 {0} 個：{2}'],
  // Worded so it reads correctly at any count. "{0} pinned tabs are excluded"
  // says "1 pinned tabs" the moment exactly one is pinned, and a plural rule
  // here would have to be written twice and kept in step in two languages.
  pinnedExcluded: ['Pinned tabs excluded: {0}.', '唔計嘅釘住分頁：{0} 個。'],
  includePinned: ['Include pinned tabs', '連釘住嘅都閂'],
  nothingToClose: [[
    'Nothing matches, so nothing will close.',
    'Nothing matches — no tab will close.',
    'No tab matches that, so nothing is going anywhere.',
    'Not one tab matches, so this will close precisely nothing.',
    'Zero tabs matched, so this button is about to do a magnificent amount of absolutely nothing.'], [
    '冇嘢夾到，所以唔會閂到嘢。',
    '冇嘢夾到——一個分頁都唔會閂。',
    '冇分頁夾到，所以邊個都唔使走。',
    '一個分頁都夾唔到，即係話咩都唔會閂。',
    '零個分頁夾到，撳落去即將會非常隆重咁乜都唔做。']],
  emptyQueryRefused: [[
    'An empty query would close everything, so it is refused.',
    'An empty query would close every tab, so it is refused.',
    'Nothing typed means everything matches — refused, for obvious reasons.',
    'An empty query matches every tab you have open, so this refuses to run rather than closing the lot.',
    'Type nothing and EVERYTHING matches — which would shut every tab you own. Politely, firmly: no.'], [
    '空白查詢會閂晒所有嘢，所以唔畀。',
    '空白查詢會閂晒每個分頁，所以唔畀。',
    '乜都唔打即係全部夾到——理由好明顯，唔畀。',
    '空白查詢會夾到你開住嘅每個分頁，所以寧願唔行，都唔會一次過閂晒。',
    '乜都唔打即係全部夾中——嗰陣你所有分頁都會 gone。好聲好氣但企硬：唔得。']],

  /* ------------------------------------------------------------ settings */
  appearance: ['Appearance', '外觀'],
  language: ['Language', '語言'],
  theme: ['Theme', '主題'],
  themeSystem: ['Follow the system', '跟系統'],
  themeLight: ['Light', '淺色'],
  themeDark: ['Dark', '深色'],
  accent: ['Accent colour', '主色'],
  density: ['Density', '密度'],
  fontFamily: ['Font family', '字體'],
  fontSize: ['Font size', '字級'],
  fontWeight: ['Font weight', '字重'],
  contrastBoost: ['Extra contrast', '加強對比'],
  reduceMotion: ['Reduce motion', '減少動態效果'],
  langMode: ['Language mode', '語言模式'],
  langEnglish: ['English', 'English'],
  langCantonese: ['粵語 (Cantonese)', '粵語'],
  langBoth: ['Bilingual', '雙語'],
  funnyEn: ['Funny level — English', '搞笑程度——英文'],
  funnyYue: ['Funny level — 粵語', '搞笑程度——粵語'],
  funnyNote: ['The level styles every message on this site, errors and warnings included. It changes voice, never facts.',
    '呢個程度會影響呢個網站所有訊息，連錯誤同警告都係。佢淨係改語氣，唔會改事實。'],
  funny1: ['1 — fully serious', '1——完全認真'],
  funny5: ['5 — maximum playfulness', '5——玩到盡'],
  resetThis: ['Reset this', '重設呢項'],
  resetAll: ['Reset everything', '全部重設'],
  exportSettings: ['Export settings…', '匯出設定…'],
  importSettings: ['Import settings…', '匯入設定…'],
  settingsSaved: ['Settings are stored in this browser only.', '設定淨係存喺呢個瀏覽器。'],
  colourTranslator: ['Colour translator', '顏色翻譯'],
  contrastAgainst: ['Contrast against {0}: {1}:1', '同 {0} 對比：{1}:1'],
  passesAA: ['passes AA', '過到 AA'],
  failsAA: ['fails AA', '過唔到 AA'],
  outOfGamut: ['Outside the sRGB gamut — the shown colour is the nearest one this screen can display.',
    '超出 sRGB 色域——顯示嘅係呢個螢幕最接近嗰隻。'],
  alphaDropped: ['{0} cannot carry transparency; the alpha value is kept but not written into this text.',
    '{0} 載唔到透明度；數值會保留，但唔會寫入呢段文字。'],
  searchSettings: ['Search settings', '搵設定'],
  settingOnTab: ['This setting is on the {0} tab.', '呢個設定喺「{0}」嗰版。'],
  noSettingMatch: ['No setting matches on any tab.', '所有分頁都冇設定夾到。'],

  /* --------------------------------------------------------- notifications */
  copied: [[
    'Copied.', 'Copied to the clipboard.', 'Copied — it is on your clipboard.',
    'Snaffled onto your clipboard.', 'Yoink! Straight onto your clipboard it goes.'], [
    '複製咗。', '已經複製到剪貼簿。', '複製咗喇——喺你剪貼簿度。',
    '順手抄咗落你剪貼簿。', '咻——一嘢彈咗入你剪貼簿度！']],
  copyFailed: ['Could not copy: {0}', '複製唔到：{0}'],
  exported: ['Exported {0}.', '匯出咗 {0}。'],
  imported: ['Imported settings from {0}.', '由 {0} 匯入咗設定。'],
  importFailed: ['That file is not a settings export: {0}', '嗰個檔案唔係設定匯出檔：{0}'],
  dismiss: ['Dismiss', '閂咗佢'],
  notifications: ['Notifications', '通知'],

  /* -------------------------------------------------------------- dim sum */
  dimsumIntro: [[
    'Today’s dim sum', 'Today’s dim sum', 'A little dim sum for you',
    'The trolley came round — dim sum!', 'DING DING! The dim sum trolley just rolled right up to your table!'], [
    '今日點心', '今日點心', '請你食件點心',
    '點心車經過——有嘢食！', '叮叮！點心車推到埋你張枱喇！']],
  dimsumAlt: ['A photograph of {0} ({1})', '{0}（{1}）嘅相'],
};

const FALLBACK = ['(missing copy)', '（未有文字）'];

/** Pick one language's string for a key at a level. */
function pick(entry, langIndex, level) {
  const side = entry[langIndex];
  if (Array.isArray(side)) return side[Math.min(Math.max(level, 1), 5) - 1] ?? side[0];
  return side;
}

/** {0}/{1} substitution. Parameters are inserted verbatim, at every level —
 *  that is what "voice, never facts" means in code. */
export function format(text, params) {
  if (!params || !params.length) return text;
  return String(text).replace(/\{(\d+)\}/g, (m, i) => (params[i] === undefined ? m : String(params[i])));
}

/**
 * Resolve a key into { en, yue } for the current settings.
 *
 * Both sides are always resolved even in a single-language mode, because
 * bilingual mode is the same call with both halves rendered, and an accessible
 * label frequently wants the English name of a control whose visible label is
 * Cantonese.
 */
export function resolve(key, opts = {}, params = []) {
  const entry = DICT[key] || FALLBACK;
  const en = format(pick(entry, 0, opts.funnyEn ?? 3), params);
  const yue = format(pick(entry, 1, opts.funnyYue ?? 3), params);
  return { en, yue, leveled: Array.isArray(entry[0]) };
}

/** The single visible string for a mode. Bilingual joins with a separator only
 *  where one line is required; the UI usually renders the two halves as two
 *  elements instead, so a long Cantonese line cannot crowd its English. */
export function text(key, opts = {}, params = []) {
  const r = resolve(key, opts, params);
  const mode = opts.lang || 'en';
  if (mode === 'yue') return r.yue;
  if (mode === 'both') return `${r.en} · ${r.yue}`;
  return r.en;
}

/** Every key whose copy is leveled, for the settings preview and for tests. */
export function leveledKeys() {
  return Object.keys(DICT).filter((k) => Array.isArray(DICT[k][0]));
}

/** The parameter placeholders a key uses, e.g. ['{0}','{1}']. Used by the test
 *  that proves no level drops one. */
export function paramsOf(entry) {
  const seen = new Set();
  const scan = (s) => { for (const m of String(s).matchAll(/\{\d+\}/g)) seen.add(m[0]); };
  for (const side of entry) {
    if (Array.isArray(side)) side.forEach(scan);
    else scan(side);
  }
  return [...seen].sort();
}
