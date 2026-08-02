// ui/changelog.js — the in-app changelog viewer, and the advanced date filter
// that this module and ui/historypanel.js share.
//
// Two things live here:
//
//   1. THE DATE FILTER. An anchored calendar with month/year jump, range
//      selection and named presets, paired with two typed fields that accept
//      the locale's own format *and* plain ISO. A partial or invalid entry is
//      reported inline and the user's text is kept exactly as typed — the one
//      behaviour that separates a date picker people trust from one they fight.
//      `ui/historypanel.js` imports `createDateRangeFilter` from here so the
//      two surfaces are literally the same control rather than two that look
//      alike and drift apart.
//
//   2. THE CHANGELOG VIEWER. Every recorded version, filtered by date AND by
//      search — the two COMPOSE, so narrowing by date never throws the search
//      away and vice versa. Copy and export honour whatever is on screen and
//      the exported file states its range, because a changelog extract with no
//      stated range is a document nobody can check later.
//
// HONESTY. The content below is not written to fill a page. No release has been
// published for this project yet, so `CHANGELOG.releases` is empty and the
// viewer says so instead of inventing a 1.0. What it can show truthfully is the
// build it is running in, and the development history recorded in the
// repository — each entry carrying the commit that produced it, so every line
// is checkable against `git show`.

import {
  h, icon, clear, uid, appearanceTarget, announce, layer, anchorTo, focusMemory,
  copyText, downloadText, on,
} from '../dom.js';
import { t, tIn, bindRender, getLanguage, getFunnyLevel } from '../i18n.js';
import { resolveI18n } from '../../winscp-i18n.js';
import { api } from '../state.js';
import { styleSheet } from '../theme.js';
import { createSearchBar } from './searchbar.js';
import { notify } from './notifications.js';
import { VERSION, CODENAME } from '../../winscp-data.js';
import { registerDialog, registerCommand, openDialog } from '../app.js';

/* ================================================================== */
/* module-local strings                                                */
/* ================================================================== */
// design/winscp-i18n.js is another module's file, so strings this viewer needs
// and the shared dictionary does not have are declared here in the same shape
// and resolved through the same engine: three language modes, both funny
// levels, and facts (versions, dates, counts) identical at every level.

const STR = {
  clTitle: ['Changelog', '更新記錄'],
  clSearchPh: ['Search the changelog', '搜尋更新記錄'],
  clNoReleases: [
    'No release has been published for this project yet, so there are no released versions to list. The build you are running and the development history recorded in the repository are shown below.',
    '呢個專案未出過正式版本，所以冇已發布版本可以列。下面顯示緊你而家跑緊嘅 build，同埋 repository 入面記低咗嘅開發歷史。'],
  clCurrentBuild: ['This build (not yet released)', '呢個 build（仲未發布）'],
  clDevHistory: ['Development history', '開發歷史'],
  clDevNote: [
    'Recorded from the repository’s own commits up to {0}. Each entry names the commit it came from.',
    '由 repository 自己嘅 commit 記低，去到 {0} 為止。每條都寫明出自邊個 commit。'],
  clNoChanges: ['No recorded changes.', '冇記低任何變更。'],
  clNoMatch: [
    'Nothing in the changelog matches {0}.',
    '更新記錄入面冇嘢符合{0}。'],
  clFilterDate: ['date range {0}', '日期範圍 {0}'],
  clFilterSearch: ['the search {0}', '搜尋 {0}'],
  clAnd: [' and ', '同埋'],
  clShowing: ['{0} of {1} entries', '{1} 條入面顯示緊 {0} 條'],
  clCopy: ['Copy what is shown', '複製顯示緊嘅內容'],
  clExportMd: ['Export as Markdown', '匯出做 Markdown'],
  clCopied: ['Changelog copied — {0} entries, {1}.', '更新記錄複製咗——{0} 條，{1}。'],
  clExported: ['Changelog exported as {0}.', '更新記錄匯出做 {0}。'],
  clCopyFailed: ['The clipboard refused the copy. Nothing was changed.', '剪貼簿唔肯收，冇嘢改動咗。'],
  clCodeName: ['Release code name', '版本代號'],
  clUnreleased: ['Unreleased', '未發布'],
  clCommit: ['Commit', '提交'],
  clOpenCommit: ['Open this commit', '開呢個 commit'],
  clOpenFailed: ['{0} could not be opened.', '開唔到 {0}。'],
  clNoCommit: [
    'No commit is recorded for this entry.',
    '呢一條冇記低係邊個 commit。'],
  clIssues: ['Issues', '議題'],

  dpFrom: ['From', '由'],
  dpTo: ['To', '至'],
  dpOpenCalendar: ['Open the calendar', '開日曆'],
  dpPresets: ['Presets', '預設範圍'],
  dpClear: ['Clear the dates', '清走日期'],
  dpMonth: ['Month', '月'],
  dpYear: ['Year', '年'],
  dpPrevMonth: ['Previous month', '上個月'],
  dpNextMonth: ['Next month', '下個月'],
  dpToday: ['Today', '今日'],
  dpPartial: [
    'Incomplete date — {0}. Nothing has been filtered by it and your text has been kept.',
    '日期未打完——{0}。冇用佢篩過嘢，你打嘅字照留低。'],
  dpInvalid: [
    'That is not a date — {0}. Nothing has been filtered by it and your text has been kept.',
    '呢個唔係日期——{0}。冇用佢篩過嘢，你打嘅字照留低。'],
  dpWantYMD: ['a year, a month and a day are all needed', '要有年、月、日先得'],
  dpBadMonth: ['month {0} does not exist', '冇第 {0} 個月'],
  dpBadDay: ['{0} has no day {1}', '{0} 冇 {1} 號'],
  dpNotNumbers: ['it is not made of numbers', '入面唔係數字'],
  dpHint: ['Type {0} or 2026-08-02', '可以打 {0} 或者 2026-08-02'],
  dpRangeAll: ['all dates', '所有日期'],
  dpRangeFrom: ['{0} onwards', '由 {0} 開始'],
  dpRangeTo: ['up to {0}', '直到 {0}'],
  dpRangeBoth: ['{0} to {1}', '{0} 至 {1}'],
  dpSelected: ['Selected {0}', '揀咗 {0}'],

  pAll: ['All dates', '所有日期'],
  pToday: ['Today', '今日'],
  p7: ['Last 7 days', '最近 7 日'],
  p30: ['Last 30 days', '最近 30 日'],
  pThisMonth: ['This month', '今個月'],
  pLastMonth: ['Last month', '上個月'],
  p6m: ['Last 6 months', '最近 6 個月'],
  pThisYear: ['This year', '今年'],
};

function substitute(text, params) {
  return params.length
    ? String(text).replace(/\{(\d+)\}/g, (m, i) => (params[Number(i)] === undefined ? m : String(params[Number(i)])))
    : String(text);
}

/** One specific language, ignoring the active mode. The building block. */
function strIn(language, key, ...params) {
  const entry = STR[key];
  if (!entry) return substitute(tIn(language, key), params);
  const raw = resolveI18n(entry, language, getFunnyLevel('en'), getFunnyLevel('yue'));
  return substitute(raw == null ? key : raw, params);
}

/** Resolve a module-local string in the active mode, then substitute {0}, {1}. */
export function s(key, ...params) {
  const mode = getLanguage();
  if (mode !== 'both') return strIn(mode, key, ...params);
  const en = strIn('en', key, ...params);
  const yue = strIn('yue', key, ...params);
  return en === yue ? en : `${en} · ${yue}`;
}

/**
 * Build a sentence out of SEVERAL strings without the two languages ending up
 * interleaved.
 *
 * Substituting an already-bilingual fragment into an already-bilingual
 * template produces "A · 甲 and · 同埋 B · 乙" — each half half-translated and
 * neither readable. So `compose` runs the whole build once per language and
 * joins only at the very end. `build` receives a resolver that looks in this
 * module's strings first and falls back to the shared dictionary, so a
 * composed sentence can mix both sources.
 */
export function compose(build) {
  const mode = getLanguage();
  const make = (language) => build((key, ...params) => strIn(language, key, ...params), language);
  if (mode !== 'both') return make(mode);
  const en = make('en');
  const yue = make('yue');
  return en === yue ? en : `${en} · ${yue}`;
}

/* ================================================================== */
/* the recorded changelog                                              */
/* ================================================================== */

/**
 * The build this binary is. Not a release — it is stated as unreleased, and it
 * exists here so the code-name rendering path is exercised by real data rather
 * than waiting for a release that has not happened.
 */
export const CURRENT_BUILD = {
  id: 'build-current',
  kind: 'build',
  version: VERSION,
  released: false,
  date: null,
  codeName: { en: CODENAME.en, zh: CODENAME.zh, id: CODENAME.id, file: CODENAME.img.split('/').pop() },
  changes: [],
};

/**
 * The development history, transcribed from this repository's own commits.
 * Every `ref` is a real abbreviated object name and every `date` is that
 * commit's author date; the bullets restate what the commit message itself
 * records. Nothing here is a summary somebody imagined afterwards.
 */
export const DEVELOPMENT = [
  {
    id: "4b9022f", kind: 'commit', ref: "4b9022f", oid: "4b9022fe4665dda5264d8e8ad7a5636038efa9e8", date: "2026-08-02",
    title: "Prove the installer end to end, and generate the changelog from real commits",
    refs: ["#21", "#22", "#14"],
    changes: [
      { category: "removed", text: "The installer is no longer a claim. Built (126 MB Setup.exe), RUN, and the result verified: %LOCALAPPDATA%\\winscp_material with Update.exe, app-0.1.0 and the packages folder Squirrel keeps its .nupkg in. Then the INSTALLED binary was launched and captured — design/screenshots/installed-app-01.png shows the same working Commander as a dev run. Build -> install -> run, all three observed rather than inferred." },
      { category: "changed", text: "The changelog is now generated from `git log` by tools/changelog.js, because a hand-maintained one had already drifted seven commits behind inside a day, and the shared instructions require it current in every project-changing task. Every entry carries the FULL object name, verified with `git cat-file` before it is written — a wrong sha is worse than none, since it sends a reader somewhere confidently irrelevant. Bilingual commit bodies are split so the Cantonese half is real copy from the commit rather than a machine translation: 14 of 17 entries carry it." },
      { category: "changed", text: "Two of my own tests were wrong, in opposite directions." },
      { category: "fixed", text: "The generator invented a bullet reading \"No detail was recorded in the commit message\" — which broke the test proving the viewer renders \"No recorded changes\", because no entry was empty any more. Two components explaining the same absence is how they eventually disagree, so the generator now emits an empty list and the viewer keeps the sentence." },
      { category: "removed", text: "Then no-nags.test.js failed on design/renderer/ui/changelog.js:277 — the changelog entry describing no-nags.test.js. The word \"donation\" near the word \"startup\", in a bullet quoting the commit that REMOVED the donation prompt. Perfectly circular: the test caught the project being honest about the thing the test exists to enforce. The prose heuristics now skip the historical record, and a dedicated check strips every string literal from changelog.js and asserts its CODE contains no promotional identifier — history may say \"donation\", the module may not do anything about it." },
    ],
    changesYue: [
      { category: "changed", text: "安裝檔唔再係「我話佢得」:真係 build 咗、真係行過、真係裝到,連裝完之後個 exe 都開返出嚟影咗相。build → 裝 → 行,三步都親眼睇過。" },
      { category: "changed", text: "更新日誌而家由 git log 生成,因為人手維護嗰個一日之內已經落後咗七個 commit。 每個 sha 寫入之前都用 git cat-file 驗過:錯嘅 sha 衰過冇,因為佢會好自信咁 send 個讀者去一個完全唔關事嘅地方。" },
      { category: "changed", text: "我自己兩個測試都寫錯咗,仲要係相反方向。其中一個仲要幾好笑:no-nags 測試 捉到咗嗰句 changelog,而嗰句 changelog 講嘅正正就係 no-nags 測試本身。" },
      { category: "changed", text: "1,830 tests, 1,829 pass, 0 fail." },
      { category: "changed", text: "Refs #21 #22 #14" },
    ],
  },
  {
    id: "7756e63", kind: 'commit', ref: "7756e63", oid: "7756e633dcd22d947f81494a149932533c84f731", date: "2026-08-02",
    title: "Reconcile 24,361 lines the ledger was counting as never written",
    changes: [
      { category: "security", text: "Seven verify passes and three reconcile passes died on a session limit, and the reconcile pass is the one that updates the ledger. So fourteen modules totalling 24,361 lines — terminal, common, remotefiles, script, winconfig, guitools, sessiondata, security, filebuffer, filesystems, options, setup, consolerunner, shellintegration — sat on disk, imported, tested and passing, while port-coverage.md counted every one of them as NOT STARTED." },
      { category: "changed", text: "That is the ledger working exactly as designed. An unmapped unit counts as zero, which is the right default: it fails toward under-reporting rather than toward flattering itself. But it means the 43.5% I reported was wrong in the honest direction, and the real figure after mapping what genuinely exists is 52.3%." },
      { category: "added", text: "Every entry added here carries the implementer's own estimate, deliberately conservative, and says so in its note: \"Adversarial verification did not run (the verify agent hit the session limit), so this progress is the implementer's own assessment.\" A number nobody checked should say that it is a number nobody checked." },
      { category: "changed", text: "core/Terminal stays at 0.45 rather than moving up, because the half that is missing is the transfer machinery — CopyToRemote, Source, Sink, the parallel operation, and the overwrite decision — which is the half that can lose data." },
      { category: "changed", text: "七個驗證同三個 reconcile pass 撞咗 session 上限死咗,而 reconcile 正正就係負責" },
    ],
    changesYue: [
      { category: "changed", text: "更新進度表嗰個。所以十四個模組、24,361 行 code,已經喺度、已經 import、測試又 全部過,但係進度表當佢哋一行都未寫過。" },
      { category: "changed", text: "呢個其實係設計成咁:冇對應嘅一律當零分,寧願報少唔好報多。不過即係話我之前講 嗰個 43.5% 係報少咗,對返實際有嘅嘢應該係 52.3%。" },
      { category: "changed", text: "新加嘅每一項都寫明「冇經過對抗式驗證,呢個分數係寫嗰個人自己畀嘅」。冇人查過 嘅數字,就應該講明冇人查過。" },
      { category: "changed", text: "core/Terminal 照留 0.45,因為未搬嗰半係傳輸同覆寫決策 —— 即係會整爛人哋檔案 嗰半。" },
      { category: "changed", text: "Logic coverage 43.5% -> 52.3%. 1,829 tests pass, 0 fail." },
    ],
  },
  {
    id: "a5d3386", kind: 'commit', ref: "a5d3386", oid: "a5d3386d84d92ab4b110f418cc69e8b275464c9d", date: "2026-08-02",
    title: "The panels are real: 1,829 tests, 301 actions wired, 43.5% of the logic ported",
    refs: ["#2", "#3", "#4", "#6", "#10"],
    changes: [
      { category: "changed", text: "Three workflows landed at once. The screenshot is the point: design/screenshots/app-panels-01.png shows a working Commander — two panes, a real directory listing with sizes and timestamps, eight menus, the toolbars, the transfer-preset picker, per-panel filters with their regex builders, and an honest \"this tab has no session open\" where a session is not open." },
      { category: "fixed", text: "The single worst defect was not in any of it. NOTHING IMPORTED ui/panels.js: 43 of the renderer's 58 modules — the panels, all 301 commands, the queue, the log, every one of 28 dialogs — were unreachable from the running app. The code worked; a user simply could not get to it, which by our own mandate means none of it was ported. A renderer entry point now lists every module, and a module missing from it is dead code by construction rather than by accident." },
      { category: "changed", text: "Real servers found what unit tests could not. setTimes() was called positionally by ipc.js and as an object by the queue and the synchronizer, and all three adapters took only one of the two shapes:" },
      { category: "changed", text: "sftp threw \"Cannot parse time: NaN\" — every SFTP transfer with preserveTime on, which is the default, failed outright scp stamped the literal string \"NaNNaNNaN\" through `touch -t` local passed an Invalid Date to fs.utimes, which ACCEPTED it, wrote a nonsense timestamp and reported success — so a synchronized tree could never converge. Every comparison saw the same files as different, forever, and nothing ever said so." },
      { category: "fixed", text: "ftp had the mirror-image bug and is fixed here. All four now share one normalizeTimes() that takes both shapes and refuses genuine garbage loudly." },
      { category: "fixed", text: "Also fixed: SFTP streams had no owner-side error listener, so reading a file in the editor and then pressing Disconnect took the whole main process down with an unhandled 'error'." },
      { category: "changed", text: "One test was asserting the wrong thing. `mv a.txt b.txt one.txt` warns and then fails on the collision; the test expected it to succeed. It now asserts the warning, the failure, AND that a.txt moved while b.txt stayed put — because \"which files actually moved\" is the only part of that story a user cares about." },
    ],
    changesYue: [
      { category: "changed", text: "三個 workflow 一齊落地。最緊要係嗰張圖:真係兩版嘅檔案總管,真實目錄、真實大細、 真實時間。" },
      { category: "changed", text: "不過最大嗰個 bug 唔喺呢度:冇任何檔案 import 過 ui/panels.js,即係 58 個模組 入面有 43 個喺行緊嘅 app 度根本掂唔到。段 code 冇問題,但係用家去唔到,咁按我哋 自己嘅規矩就當冇搬過。" },
      { category: "changed", text: "真伺服器揾到單元測試揾唔到嘅嘢:setTimes 有兩種呼叫寫法,三個 adapter 各自淨係 食一種。最陰濕嗰個係 local:fs.utimes 收咗個 Invalid Date 又唔嘈,寫咗個廢時間 落去仲話成功,結果同步樹永遠對唔齊,而且永遠唔會有人話你知。" },
      { category: "changed", text: "1,830 tests · 1,829 pass · 0 fail. Logic coverage 19.1% -> 43.5%." },
      { category: "changed", text: "Refs #2 #3 #4 #6 #10" },
    ],
  },
  {
    id: "216ce9d", kind: 'commit', ref: "216ce9d", oid: "216ce9d20eb28d09a580a41b9e34d35eab63a0f9", date: "2026-08-02",
    title: "Stop quoting a coverage number that 108,113 lines of hex were inflating",
    changes: [
      { category: "changed", text: "The largest \"unported units\" in the ledger turned out not to be code. Animations144.dfm is 18,155 lines, of which 15,747 are pure hex, sitting behind a 14-line .cpp. It is a bitmap icon sheet. So are Animations96/120/192 and Glyphs/120/144/192 — eight units, ~98,000 lines, four DPI variants of the same artwork, because a raster icon set needs one sheet per display scale." },
      { category: "changed", text: "A vector icon set needs none, so these are correctly `replaced`: Material Symbols carry the iconography and the action-to-icon mapping lives in commands.js. Transcribing 1990s toolbar bitmaps into a Material 3 app would be the wrong thing done thoroughly." },
      { category: "changed", text: "But marking them replaced moved the headline from 9.1% to 39.5% without a single behaviour being ported, and a number that can jump 30 points on a reclassification is not a number worth reporting." },
      { category: "changed", text: "So the ledger now computes both, and says which to quote:" },
      { category: "changed", text: "LOGIC coverage: 19.1% of 209,889 lines that are actually code raw coverage: 39.5% includes 108,113 lines of embedded hex — distorted" },
      { category: "changed", text: "19.1% is the honest figure. Every future report uses it." },
    ],
    changesYue: [
      { category: "changed", text: "進度表入面最大嗰幾個「未搬」單元,原來根本唔係 code。Animations144.dfm 成 18,155 行,其中 15,747 行係純 hex,後面得 14 行 .cpp——即係一張圖示點陣圖。同款嘅仲有 七個,加埋差唔多 98,000 行,四個 DPI 各一份,因為點陣圖每個縮放都要另一張。" },
      { category: "changed", text: "用向量圖示就一張都唔使,所以呢八個標 `replaced` 係啱嘅。但係咁一標,個數字由 9.1% 跳到 39.5%,一個 behaviour 都未搬過。一個改個分類就跳三十點嘅數字,唔值得 攞出嚟講。" },
      { category: "changed", text: "所以而家計兩個數,仲要寫明邊個先算數:19.1%。以後都用呢個。" },
    ],
  },
  {
    id: "e7dd988", kind: 'commit', ref: "e7dd988", oid: "e7dd988479db0f3f1280ee92eb3d998e0265af50", date: "2026-08-02",
    title: "Update silently like Chrome, and fix two reasons it never could have",
    refs: ["#14"],
    changes: [
      { category: "added", text: "The app now checks quietly, downloads in the background, and is simply newer next time it starts. No prompt, no changelog modal, no restart nag. Squirrel stages the new version beside the running one and swaps at exit." },
      { category: "changed", text: "Two defects would have made that silently do nothing forever:" },
      { category: "added", text: "EVERY RELEASE SHIPPED VERSION 0.1.0. CI read the version out of package.json and never bumped it, so every .nupkg was 0.1.0. Squirrel compared new against old, found them equal, and correctly concluded there was nothing to install. Nine releases, zero possible updates. The build now sets 0.1.<run_number> before packaging, so the version genuinely increases." },
      { category: "changed", text: "THE TAG WAS A PRERELEASE. `v0.1.0-build.7` is not a build of 0.1.0 in semver's eyes — it sorts BEFORE it. Update feeds skip prereleases outright. Tags are now plain `v0.1.<run>`, and the release is marked --latest, because a release that is published but not latest is a release nobody receives." },
      { category: "changed", text: "Both would have presented as \"updates are working, there is just nothing newer\", which is indistinguishable from working right up until a release goes out and nobody gets it. autoupdate.js therefore refuses to fail quietly: an unpackaged build reports `unsupported` rather than sitting silently idle." },
      { category: "changed", text: "A failed update check is the updater's problem, not the user's — it goes to the log and the next check retries. The only thing surfaced is a passive line on a surface the user opened themselves: \"0.1.7 applies the next time you start\"." },
    ],
    changesYue: [
      { category: "changed", text: "而家好似 Chrome 咁靜靜雞更新:自己 check、自己 download、下次開就已經係新版。 唔會彈窗、唔會叫你 restart。" },
      { category: "changed", text: "但係有兩個窿,唔補嘅話佢會永遠靜靜雞乜都唔做:" },
      { category: "changed", text: "每個 release 都係 0.1.0。CI 由 package.json 讀個版本又唔加,所以每個 nupkg 都係同一個版本號。Squirrel 一比,一樣,咁就話冇嘢更新囉——完全正確。 出咗九個 release,一次都更新唔到。" },
      { category: "changed", text: "個 tag `v0.1.0-build.7` 喺 semver 眼中係「預覽版」,排喺 0.1.0 之前, 更新來源根本會跳過佢。" },
      { category: "changed", text: "兩個問題睇落都係「更新正常,只係冇新版啫」,直到真係出版嗰日先發現冇人收到。" },
      { category: "changed", text: "657 tests, 656 pass, 0 fail." },
      { category: "changed", text: "Refs #14" },
    ],
  },
  {
    id: "5a46937", kind: 'commit', ref: "5a46937", oid: "5a46937bc7424e4a75434be96d2d697a8b1ad18c", date: "2026-08-02",
    title: "Delete the Donate action outright, and make the no-nag rule enforceable",
    refs: ["#22"],
    changes: [
      { category: "added", text: "WinSCP ships a Donate action and shows donation prompts. This port removes it. Not hidden behind a setting, not \"only on the tenth launch\" — gone. The URL no longer appears anywhere in the shipping app, because a link that is merely hidden today is a link somebody re-surfaces tomorrow." },
      { category: "fixed", text: "The action stays REGISTERED, though, as visible:false + a reason. That is deliberate: the coverage ledger should record a decision, not an oversight. An action that silently vanishes from a 301-item list is indistinguishable from one nobody got round to, and six months later somebody \"fixes\" it." },
      { category: "changed", text: "WinSCP is excellent software by other people. The About dialog credits them and links to the project — that is the right place for it, at a moment the user chose." },
      { category: "changed", text: "test/no-nags.test.js keeps it that way by reading the source rather than trusting anyone's memory:" },
      { category: "changed", text: "no promotional term may appear on a line that also raises a toast, dialog, alert or timer;" },
      { category: "changed", text: "nothing promotional may sit within twelve lines of a startup or interval hook;" },
      { category: "changed", text: "the donation URL must not exist in design/main, design/preload or design/renderer at all;" },
      { category: "changed", text: "and there must be NO preference key for switching nagging off — such a setting is not compliance, it is an admission that the app nags by default, and the correct number of them is zero." },
    ],
    changesYue: [
      { category: "changed", text: "WinSCP 有個「捐款」掣,仲會自己彈出嚟。呢個 port 直接刪咗佢——唔係收埋,唔係 擺個掣畀你熄,係冇咗。個網址喺成個 app 入面都搵唔到,因為淨係收埋嘅嘢,聽日 就會有人攞返出嚟。" },
      { category: "changed", text: "不過個 action 就照留低,標住「唔顯示 + 原因」。咁做係想份進度表記住呢個係一個 決定,唔係漏咗。喺 301 個項目入面靜靜雞消失咗,同冇人做過根本分唔出。" },
      { category: "changed", text: "WinSCP 係人哋嘅好嘢,About 度會 credit 佢哋同放個link——嗰度先啱,嗰陣係你 自己想睇先撳。" },
      { category: "changed", text: "650 tests, 649 pass, 0 fail." },
      { category: "changed", text: "Refs #22" },
    ],
  },
  {
    id: "21e40bf", kind: 'commit', ref: "21e40bf", oid: "21e40bfc45d596af892256df00089eee83af957e", date: "2026-08-02",
    title: "Report the project's real size, and take on six rules that landed mid-build",
    refs: ["#18", "#23", "#19", "#20", "#21", "#22"],
    changes: [
      { category: "changed", text: "The shared instructions moved while this was being built, so the work moves too." },
      { category: "changed", text: "README now states how much code this actually is, measured rather than claimed:" },
      { category: "changed", text: "Hand-written 153 files 45,146 lines 40,125 non-blank Generated 5 files 49,595 lines (extracted from WinSCP's own .dfm/NonVisual sources) Total 94,741 lines" },
      { category: "fixed", text: "Broken down by part, both total and non-blank, with the exclusions stated out loud instead of applied quietly: vendor/winscp is 421,584 lines of somebody else's C++ and folding it in would inflate this project roughly tenfold. Generated files are reported on their own row because a person did not type them. tools/count-lines.js produces the figure from `git ls-files` and records the commit it was taken at, so refreshing it is one command rather than a manual recount nobody remembers to do." },
      { category: "added", text: "Six new requirements are now tracked as issues #18-#23:" },
      { category: "changed", text: "Command palette reaching every command AND every setting, with live controls in the rows and a jump to where the setting actually lives." },
      { category: "changed", text: "Overlays paint their own surface and scroll when they do not fit — a capped overlay with hidden overflow silently deletes its last items, and the user gets no scrollbar to tell them anything is missing." },
      { category: "changed", text: "Context menus display their shortcuts. 79 of the 301 actions have one; a shortcut hidden in the menu is a shortcut nobody learns." },
      { category: "changed", text: "Changelog entries link to their commit, validated to exist before shipping — a wrong SHA is worse than none, because it sends the reader somewhere confidently irrelevant." },
      { category: "changed", text: "No promotional nags. WinSCP has DonatePageAction and shows donation prompts; a user-initiated link to upstream stays, every unsolicited prompt does not. Documented as a deliberate divergence so it reads as a decision, not a miss." },
      { category: "changed", text: "Truthful empty states, and discarding unsaved work recorded in history before the close completes." },
    ],
    changesYue: [
      { category: "changed", text: "份規矩喺做緊嘢嗰陣改咗,所以份工都要跟住改。" },
      { category: "changed", text: "README 而家老實講返呢個 project 有幾大:自己寫嘅 45,146 行、機器由 WinSCP 原始 定義抽出嚟嘅 49,595 行分開報。剔走咗嘅嘢寫明:vendor/winscp 嗰 421,584 行係 人哋嘅 C++,計埋落去會發水發大十倍。" },
      { category: "changed", text: "六條新規矩開咗 issue #18-#23,其中一條係「唔好扭錢」:WinSCP 本身有捐錢提示, 用家自己撳去捐冇問題,但係自動彈出嚟嗰啲一律唔搬,亦都唔會加個掣扮畀你熄。" },
      { category: "changed", text: "Refs #18 #19 #20 #21 #22 #23" },
    ],
  },
  {
    id: "6105f2b", kind: 'commit', ref: "6105f2b", oid: "6105f2b547fdc85e30429bd4452c6cde8c8caed3", date: "2026-08-02",
    title: "Close the CI loop: a release tag was retriggering the build that made it",
    refs: ["#14"],
    changes: [
      { category: "changed", text: "The workflow header confidently stated that nothing pushes a commit back, so a release \"can never retrigger the workflow\". Both halves were true. The conclusion was not." },
      { category: "changed", text: "Publishing a release CREATES A TAG, and a bare `on: push` fires for tag pushes as well as branch pushes. So every release triggered a build, which published a release, which triggered a build. Four commits produced nine releases before the run list made it obvious." },
      { category: "changed", text: "`tags-ignore: ['**']` is what actually closes it. Not pushing a commit was never sufficient, and the comment saying otherwise was the reason nobody looked." },
      { category: "changed", text: "The releases themselves are real and stay: build 5 carries a 124.76 MB Setup.exe, the .nupkg, the RELEASES manifest, a genuine dim sum photograph from the bundled catalog, and its code name — non-draft, uniquely tagged, nothing recycled." },
      { category: "changed", text: "CI 自己餵自己:出 release 會開 tag,開 tag 又算 push,於是又觸發多一次 build, 再出多一個 release。四個 commit 出咗九個 release 先發現。" },
    ],
    changesYue: [
      { category: "changed", text: "個 workflow 開頭仲寫到好肯定:「呢度唔會 push commit 返入嚟,所以唔會自己觸發 自己。」兩句都啱,個結論錯。真正塞得住個窿嘅係 tags-ignore。" },
      { category: "changed", text: "啲 release 本身係真嘅,照留低:124.76 MB 安裝檔、nupkg、更新清單、真嘅點心相 同代號,全部齊。" },
      { category: "changed", text: "Refs #14" },
    ],
  },
  {
    id: "c07dc48", kind: 'commit', ref: "c07dc48", oid: "c07dc487482a7b7b0469b68a3ce0fd2008b8754f", date: "2026-08-02",
    title: "Ship a real Squirrel installer: 124.86 MB Setup.exe, plus CI, docs and the site",
    refs: ["#14"],
    changes: [
      { category: "added", text: "`npm run make` now produces genuine artifacts:" },
      { category: "changed", text: "WinSCP Material 0.1.0 Setup.exe 124.86 MB PE32 GUI executable winscp_material-0.1.0-full.nupkg 123.51 MB RELEASES SHA1 + size, as Squirrel expects" },
      { category: "fixed", text: "Getting there meant fixing two packaging dependencies that Node 26 broke, and one of them was lying about it:" },
      { category: "changed", text: "extract-zip 2.0.1 unpacks exactly ONE entry, then the promise never settles and the process exits 0. No error, no rejection, no stack — just success with nothing to show for it. This is the same fault that stopped electron's own postinstall (node_modules/electron/dist had to be unpacked by hand before the app would run at all) and it is why `make` sat at \"Finalizing package\" and then cheerfully reported success while leaving no out/ directory. A build that claims success and produces no installer is worse than one that fails." },
      { category: "removed", text: "cross-zip calls fs.rmdir(path, {recursive:true}), which Node 26 removed outright. That one at least had the decency to throw." },
      { category: "fixed", text: "tools/fix-node26-deps.js patches both, verifies the fix by actually unpacking the Electron zip (21 entries, 2.0 s, where the original hung forever), and refuses to silently \"succeed\" if upstream source has moved under it. It touches node_modules only, which is not committed — CI runs on a Node where both packages behave." },
      { category: "security", text: "Also landing: Electron Forge config, the CI workflow, README and AGENTS with a sanitized mirror of the shared instructions, LICENSE/CONTRIBUTING/SECURITY/ CODE_OF_CONDUCT, categorized docs, and the Material 3 landing site." },
    ],
    changesYue: [
      { category: "changed", text: "安裝檔真係整到嘢出嚟啦:124.86 MB 嘅 Setup.exe。" },
      { category: "changed", text: "要搞掂佢先要修兩個畀 Node 26 整死嘅打包 library,其中一個仲要係講大話嗰隻:" },
      { category: "changed", text: "extract-zip 解壓解到第一個檔案就死,個 promise 永遠唔會有結果,程式就咁 exit 0 收工。冇錯誤、冇例外、乜都冇,淨係話「成功」但係乜都冇整到。 整咗嘢話失敗好過乜都冇整而話成功。" },
      { category: "changed", text: "cross-zip 用咗 Node 26 已經刪咗嘅 API,呢個至少識彈錯誤出嚟。" },
      { category: "changed", text: "tools/fix-node26-deps.js 兩個都補埋,仲會真係解一次 Electron 個 zip 嚟驗證 (21 個檔案、2 秒,原本個版本係永遠等)。上游改咗源碼嘅話佢會嘈,唔會扮補到。" },
      { category: "changed", text: "257 tests pass, 0 fail." },
      { category: "changed", text: "Refs #14" },
    ],
  },
  {
    id: "0809178", kind: 'commit', ref: "0809178", oid: "0809178a0d75e4b6ce65dbef8f0bef075b8c5c81", date: "2026-08-02",
    title: "The app boots: main process, 130 IPC channels, and a Material 3 shell on screen",
    refs: ["#6", "#12", "#13", "#15"],
    changes: [
      { category: "changed", text: "First real launch, captured from the running window rather than described: design/screenshots/app-boot-01.png. Custom title bar, tab strip, status bar, the language chip, both funny-level indicators, the search bar with its regex builder, and the release code name \"Classic Har Gow · 蝦餃\" — all rendered by the actual app, not the mockup." },
      { category: "changed", text: "Main process: 130 IPC channels across app/config/session/fs/queue/sync/editor/ history, every handler returning {ok,value} or {ok,error} and never throwing across the bridge. Preload exposes no generic invoke and no Node primitives." },
      { category: "changed", text: "Host key and certificate verification always ask the renderer and await the answer. There is no auto-accept path, and a prompt that times out resolves to CANCEL rather than to yes — a verification prompt that defaults to \"sure\" on silence is not a verification prompt." },
      { category: "fixed", text: "Two launches in a row appeared to exit instantly with no output, which looked like a crash and was in fact the single-instance lock doing precisely its job: the first instance was still alive and holding it. The bug was in the diagnosis, not the code." },
      { category: "changed", text: "app 真係開到,而且影咗相為證,唔係吹水:design/screenshots/app-boot-01.png。" },
    ],
    changesYue: [
      { category: "changed", text: "標題列、分頁、狀態列、語言 chip、兩條搞笑程度指示、搜尋列連 regex builder, 仲有版本代號「Classic Har Gow · 蝦餃」,全部係真 app 畫出嚟,唔係個 mockup。" },
      { category: "changed", text: "Host key 驗證一定要問過你先算數,冇「自動接受」呢條路;等到超時就當你話唔得, 唔會當你默認 OK ——會自動講「好呀」嘅驗證,根本唔算驗證。" },
      { category: "changed", text: "連續兩次開機好似即刻死咗又冇任何訊息,睇落似 crash,其實係單一實例鎖正正常常 咁做緊嘢:第一個實例仲喺度揸住個鎖。錯嘅係我個判斷,唔係段 code。" },
      { category: "changed", text: "Refs #6 #12 #13 #15" },
    ],
  },
  {
    id: "d45724d", kind: 'commit', ref: "d45724d", oid: "d45724d3e488dc18e043cd72b6ed253c0a226bb2", date: "2026-08-02",
    title: "Ledger the ssh2-vs-PuTTY gaps, cover find.js, wire the parallel-transfer prefs",
    refs: ["#2", "#3", "#4", "#5"],
    changes: [
      { category: "changed", text: "The SFTP work turned up seven capabilities PuTTY has and ssh2 does not. The mandate is explicit that replacing a vendored engine is a port of that layer, not permission to skip it, so docs/protocol-gaps.md now counts them in the open rather than letting them dissolve into \"SFTP: done\":" },
      { category: "changed", text: "GSSAPI/Kerberos has no ssh2 mechanism at all — flags accepted, warning logged, single-sign-on genuinely does not work." },
      { category: "fixed", text: "ssh2's client hard-codes SFTP version 3, so the version selector and every v4+ bug workaround are inert." },
      { category: "changed", text: "Request pipelining is confined to fastGet/fastPut, which cannot resume or report progress, so sftpDownloadQueue/sftpUploadQueue do nothing on the streaming path. Throughput on high-latency links is lower than WinSCP's." },
      { category: "changed", text: "Each row says what the USER cannot do, not which function is missing from which library, and no unit may be marked done while it still has an open row." },
      { category: "added", text: "find.js shipped without a test file in its author's ownership list, which is a polite way of saying untested. Now 17 tests, including the one that matters: a 3-byte-chunk reader proving a match spanning a read boundary is still found. An oversized file is asserted never to be OPENED, not merely to report nothing." },
      { category: "added", text: "Also added queue.parallelTransfers and parallelTransferThreshold to defaults — the queue was reading prefs that did not exist and defaulting defensively, so the feature worked but no user could ever reach it." },
      { category: "changed", text: "258 tests, 257 pass, 0 fail. Coverage 7.9% -> 9.1%." },
    ],
    changesYue: [
      { category: "changed", text: "SFTP 嗰邊揾到七樣 PuTTY 有、ssh2 冇嘅嘢。規矩寫明:換引擎係搬呢層,唔係 可以唔做呢層。所以開咗 docs/protocol-gaps.md 逐條列明,每條都寫住「你用唔到 咩」,唔係寫「邊個 library 少咗個 function」。仲有,有未清嘅缺口就唔准標 done。" },
      { category: "changed", text: "find.js 交嚟嗰陣冇測試 —— 講白啲即係冇試過。而家 17 條,最重要嗰條係用 3 個 byte 一嚿咁讀,證明就算個關鍵字畀讀取邊界劈開兩橛都揾得返。" },
      { category: "changed", text: "Refs #2 #3 #4 #5" },
    ],
  },
  {
    id: "74a00c4", kind: 'commit', ref: "74a00c4", oid: "74a00c41f974d6516dc15130f4ef694008636e5a", date: "2026-08-02",
    title: "FTP, WebDAV and S3 land for real: 240 tests green, coverage 7.1% -> 9.6%",
    refs: ["#3"],
    changes: [
      { category: "changed", text: "Three protocols, three things a library would not do for us:" },
      { category: "changed", text: "FTP active mode (PORT/EPRT) written by hand, because basic-ftp is passive-only and wants a live data socket BEFORE the command goes out — which is exactly backwards when the server is the one dialling. Also RFC 4217's rule that we stay the TLS client on a connection the server opened." },
      { category: "changed", text: "A LIST parser that auto-detects MLSD, unix, DOS/IIS and VMS, handles wrapped VMS records and block-to-byte sizes, rolls back year-less unix dates, and refuses to be fooled by a user whose name is literally \"jan\"." },
      { category: "changed", text: "WebDAV on node:http rather than fetch, because fetch cannot carry a client certificate or a TLS floor without reaching into undici internals. Namespace resolution means D:, d:, a: and a defaulted xmlns are all the same element." },
      { category: "changed", text: "S3 signs itself: SigV4 by hand with node:crypto, no AWS SDK. Every published AWS vector reproduces exactly — signing-key derivation, get-vanilla, and all four S3 documentation examples — and the canonical request and string-to-sign are asserted too, not just the final signature, so a passing test means the maths is right rather than that two wrongs cancelled." },
      { category: "security", text: "Certificate verification prompts BEFORE any credential is sent, and a refusal closes the connection. Multipart upload aborts on failure, including the delightful case of CompleteMultipartUpload failing inside an HTTP 200." },
    ],
    changesYue: [
      { category: "changed", text: "三條協定,三樣書館唔肯幫你做嘅嘢:" },
      { category: "changed", text: "FTP 主動模式自己寫,因為 basic-ftp 淨係識被動模式。" },
      { category: "changed", text: "LIST parser 認得四種格式,連個用戶真係叫「jan」都呃佢唔到。" },
      { category: "changed", text: "WebDAV 用 node:http 唔用 fetch,因為 fetch 帶唔到客戶端憑證。" },
      { category: "changed", text: "S3 自己簽名,冇用 AWS SDK,每個官方測試向量都對得返足。憑證驗證係喺送任何 密碼之前問你,你話唔得就即刻收線。" },
      { category: "changed", text: "240 條測試過,0 條肥佬。進度 7.1% -> 9.6%。" },
      { category: "changed", text: "Refs #3" },
    ],
  },
  {
    id: "bf47b59", kind: 'commit', ref: "bf47b59", oid: "bf47b59f196654b4b97d9a35fab75dfda3050583", date: "2026-08-02",
    title: "Six protocol and engine modules land; coverage 3.2% -> 7.1%, 88 tests green",
    refs: ["#2", "#3", "#4", "#5", "#6", "#11"],
    changes: [
      { category: "changed", text: "Real backends, not scaffolding:" },
      { category: "changed", text: "SFTP and SCP over ssh2, sharing one transport — authentication, tunnels, proxies, listing, and transfers that resume from an offset instead of starting the 4GB file again." },
      { category: "changed", text: "FTP/FTPS with MLSD plus a LIST parser that survives unix, DOS/IIS and VMS listing dialects, because every FTP server is confident its format is the obvious one." },
      { category: "changed", text: "WebDAV written by hand against fetch: PROPFIND parsing across server namespace dialects, and Digest auth verified against the RFC 7616 worked examples rather than against hope." },
      { category: "changed", text: "Transfer queue, synchronization, file masks, recursive find, session management, IPC, logging, editors, custom commands and Git-backed history." },
      { category: "fixed", text: "`npm test` was quietly broken: `node --test test/` made Node 26 go looking for a MODULE called \"test\", find nothing, and fail before running a single assertion. A glob later, 89 tests run and 88 pass with 0 failures." },
      { category: "added", text: "Coverage moves 3.2% -> 7.1% (core 8.8% -> 27.0%). Everything new is logged as `partial`, not `done`, because none of it has met a real server yet." },
    ],
    changesYue: [
      { category: "changed", text: "六個協定同引擎模組落地,係真嘢唔係假布景:" },
      { category: "changed", text: "SFTP/SCP 共用一條 SSH 通道,斷咗可以由中間接返落去,唔使成個 4GB 檔案由頭嚟過。" },
      { category: "changed", text: "FTP 個 LIST parser 食得起 unix、DOS/IIS、VMS 三種格式 —— 每個 FTP 伺服器 都覺得自己嗰隻先係正常嗰隻。" },
      { category: "changed", text: "WebDAV 自己手寫,Digest 認證用 RFC 7616 官方例子驗過先算數。" },
      { category: "changed", text: "`npm test`原來一直壞咗:`node --test test/` 令 Node 去搵一個叫「test」嘅模組, 搵唔到,連一條測試都未跑就仆街。改個 glob 之後,89 條跑,88 條過,0 條肥佬。" },
      { category: "changed", text: "進度由 3.2% 升到 7.1%。全部標 `partial` 唔標 `done`,因為未見過真伺服器。" },
      { category: "changed", text: "Refs #2 #3 #4 #5 #6 #11" },
    ],
  },
  {
    id: "ecd9d02", kind: 'commit', ref: "ecd9d02", oid: "ecd9d02fc55ed6d2a8f7a67099df961e51060e0a", date: "2026-08-02",
    title: "Extract the spec from WinSCP itself: 301 actions, 48 dialogs, 2,982 controls",
    refs: ["#2", "#3", "#4", "#5", "#6", "#7", "#8", "#9", "#10", "#11", "#12", "#13", "#14", "#15", "#16", "#17"],
    changes: [
      { category: "added", text: "Porting 50 dialogs from memory is how you ship 47 of them and never notice the other three, so the port now works from an inventory extracted straight out of the original rather than from anybody's recollection." },
      { category: "changed", text: "tools/extract-forms.js parses all 144,000 lines of .dfm form definitions into a control tree: 48 dialogs, 2,982 controls, 1,059 of which must actually DO something. Preferences alone is 293 interactive controls across 9 pages; Advanced Site Settings is 247 across 18." },
      { category: "changed", text: "First pass at that parser confidently reported Preferences as a two-control dialog. Turns out a .dfm holds several top-level objects — the form, plus its popup menus and image lists — and the parser was keeping only the last one it saw. It now collects every root, which is how 1,294 controls became 2,982." },
      { category: "changed", text: "tools/port-matrix.js grades the whole port against WinSCP's own tree, and tools/post-progress.js publishes that percentage to the rolling Discussion. The publisher takes no percentage argument on purpose: the only number it can post is the one the ledger computed." },
      { category: "changed", text: "tools/roadmap-issues.js mirrors the roadmap into 16 tracking issues." },
    ],
    changesYue: [
      { category: "changed", text: "唔靠記憶,直接由原版度抽出份規格出嚟:" },
      { category: "changed", text: "由 144,000 行 .dfm 抽出 48 個對話框、2,982 個控制項,其中 1,059 個要真係做到嘢。" },
      { category: "changed", text: "第一版 parser 好自信咁話畀我聽 Preferences 得兩個控制項。原來一個 .dfm 入面 有幾個頂層物件,佢淨係記住最後嗰個。改完之後由 1,294 變 2,982 個。" },
      { category: "changed", text: "進度數字只可以由 ledger 計出嚟,post 嘅工具連手動打百分比嘅位都冇留 —— 想吹水都冇得吹。" },
      { category: "changed", text: "路線圖開咗 16 個 issue 跟進。" },
      { category: "changed", text: "Refs #2 #3 #4 #5 #6 #7 #8 #9 #10 #11 #12 #13 #14 #15 #16 #17" },
    ],
  },
  {
    id: "3869beb", kind: 'commit', ref: "3869beb", oid: "3869bebf8f0d7724f980ab842e0b6dcdf576bfe4", date: "2026-08-01",
    title: "Lay the foundation: adapter contract, config store, and an honest coverage ledger",
    changes: [
      { category: "changed", text: "Everything a 318,000-line port needs before the first real byte moves:" },
      { category: "changed", text: "Adapter contract (design/main/protocols/base.js) — one interface the panels, the queue and the synchronizer talk to, with a `caps` matrix so the UI greys out what a protocol genuinely cannot do instead of offering a command that is guaranteed to fail. Adding a protocol now touches exactly zero UI files." },
      { category: "changed", text: "Configuration store — every WinSCP option declared in one place, atomic writes (temp + rename), and revisions offered to version history on mutation." },
      { category: "security", text: "Credential protection — OS keychain by default, scrypt-wrapped under a master password when one is set. If neither is available the secret is NOT written, because a password stored in clear is not storage, it is a leak with extra steps." },
      { category: "changed", text: "Action registry — all 301 of WinSCP's commands extracted straight from its own NonVisual.dfm with captions, hints and 79 keyboard shortcuts. Transcribing 301 menu entries by hand is how you end up with 297." },
      { category: "changed", text: "Coverage ledger — tools/port-matrix.js, deliberately hostile to wishful thinking: an unmapped unit counts as not started, and a mapping pointing at a file that does not exist counts as zero rather than as progress. Opening score: an extremely honest 3.2%." },
    ],
    changesYue: [
      { category: "changed", text: "打好個地基先，318,000 行嘅嘢唔係靠信心撐起嘅：" },
      { category: "changed", text: "一個 adapter 合約管晒所有協定，`caps` 講明邊樣真係做到——做唔到嘅指令直接熄 咗佢，唔會畀你撳完先發現係假嘅。" },
      { category: "changed", text: "設定全部集中一處，寫檔用 temp + rename，死機都唔會寫爛半截。" },
      { category: "changed", text: "密碼用系統鎖匙圈鎖住，有 master password 就再加一層 scrypt。兩樣都冇？ 咁就唔存，總好過寫明文出去當自己好安全。" },
      { category: "changed", text: "301 個指令直接由 WinSCP 自己份 NonVisual.dfm 抽出嚟，連 79 個快捷鍵都齊。 用手抄 301 條？抄到最後實得 297 條。" },
      { category: "changed", text: "進度表寫到絕情：冇對應嘅當冇做，對應嘅檔案唔存在嘅當零分。開波 3.2%， 唔靚仔但係真。" },
    ],
  },
  {
    id: "0170862", kind: 'commit', ref: "0170862", oid: "01708626b50ac291989b659345cbe5486c33de69", date: "2026-08-01",
    title: "Auto commit 2026-08-02 03:33:47.357Z",
    changes: [
      { category: "changed", text: "13 files changed" },
      { category: "changed", text: "design/.thumbnail" },
      { category: "changed", text: "design/assets/dim-0001-har-gow.png" },
      { category: "changed", text: "design/assets/dim-0011-siu-mai.png" },
      { category: "changed", text: "design/assets/dim-0051-char-siu-bao.png" },
      { category: "changed", text: "design/assets/dim-0058-custard-bao.png" },
      { category: "changed", text: "design/assets/dim-0081-radish-cake.png" },
      { category: "changed", text: "design/assets/dim-0139-egg-tarts.png" },
      { category: "changed", text: "design/screenshots/hosttest.png" },
      { category: "changed", text: "design/support.js" },
      { category: "changed", text: "design/uploads/pasted-1785637681938-0.png" },
      { category: "changed", text: "…and 3 more" },
    ],
  },
  {
    id: "6f4b7d9", kind: 'commit', ref: "6f4b7d9", oid: "6f4b7d9330a28af715522a5a4605339799837cd5", date: "2026-08-01",
    title: "Add WinSCP submodule under vendor/winscp",
    changes: [
      { category: "added", text: "Add WinSCP repository as a git submodule at vendor/winscp. Creates .gitmodules with path vendor/winscp and URL https://github.com/winscp/winscp, and registers the submodule at commit 648b6c0a97a9b3b8c89680127ea3567972bd96ef to vendor the WinSCP sources." },
    ],
  },
  {
    id: "cef414f", kind: 'commit', ref: "cef414f", oid: "cef414f5a56a1aa7d70caca2296dabf7f4c90cb4", date: "2026-08-01",
    title: "Initial commit",
    changes: [
    ],
  },
];

/**
 * The whole recorded changelog. `releases` is empty and that is the truthful
 * state — see docs/packaging-and-updates/changelog.md. When a release is
 * published its entry takes the same shape as CURRENT_BUILD, with `released`
 * true and a real `date`, and every filter, search and export below applies to
 * it with no further change.
 */
export const CHANGELOG = {
  releases: [],
  currentBuild: CURRENT_BUILD,
  development: DEVELOPMENT,
  developmentUpTo: DEVELOPMENT[0] ? DEVELOPMENT[0].ref : '',
};

/**
 * Where this project's commits live. A changelog entry that says what changed
 * but not where is unverifiable, so every entry carrying an `oid` renders a
 * link resolved against this. A WRONG sha is worse than none — it sends the
 * reader somewhere confidently irrelevant — which is why
 * test/changelog.test.js resolves every one of them against the repository and
 * fails the build rather than shipping a dead link.
 */
export const COMMIT_BASE = 'https://github.com/Ding-Ding-Projects/material-winscp/commit/';

/** The forge URL for an entry's commit, or '' when it has no recorded sha. */
export function commitUrl(entry) {
  return entry && entry.oid ? `${COMMIT_BASE}${entry.oid}` : '';
}

/** One flat, filterable list: releases first, then this build, then commits. */
export function changelogEntries() {
  const rows = [];
  for (const r of CHANGELOG.releases) rows.push({ ...r, kind: r.kind || 'release' });
  rows.push(CHANGELOG.currentBuild);
  for (const d of CHANGELOG.development) rows.push(d);
  return rows.map((e) => ({ ...e, time: e.date ? isoToMs(e.date) : null }));
}

/** Everything an entry can be matched against, as one array of strings. */
export function entryText(entry) {
  const out = [entry.version || '', entry.title || '', entry.ref || '', entry.oid || '', entry.date || ''];
  for (const c of entry.changes || []) { out.push(c.category || ''); out.push(c.text || ''); }
  for (const r of entry.refs || []) out.push(r);
  if (entry.codeName) { out.push(entry.codeName.en || ''); out.push(entry.codeName.zh || ''); }
  return out.filter(Boolean);
}

/* ================================================================== */
/* dates — pure, DOM-free, and therefore covered by test/changelog.test.js */
/* ================================================================== */

const DAY_MS = 86400000;

/** Local midnight of the day `d` falls in. */
export function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
}
/** The last millisecond of that local day, so a `to` bound includes the day. */
export function endOfDay(d) {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x.getTime();
}

/** `2026-08-02` for a Date or epoch ms, in LOCAL time (ranges are local days). */
export function isoDate(value) {
  if (value === null || value === undefined) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** `2026-08-02` -> local midnight ms. Returns null for anything else. */
export function isoToMs(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text || '').trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

/**
 * The order and separator the given locale writes a numeric date in, read from
 * Intl rather than guessed. Falls back to ISO order when Intl is unavailable,
 * which is the one order that is never ambiguous.
 */
export function localeDateOrder(locale) {
  try {
    const parts = new Intl.DateTimeFormat(locale || undefined, {
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date(2026, 7, 2));
    const order = parts.filter((p) => p.type === 'year' || p.type === 'month' || p.type === 'day').map((p) => p.type);
    const sep = (parts.find((p) => p.type === 'literal' && /\S/.test(p.value)) || { value: '/' }).value.trim() || '/';
    if (order.length === 3) return { order, separator: sep };
  } catch { /* an exotic locale is not a reason to refuse dates */ }
  return { order: ['year', 'month', 'day'], separator: '-' };
}

/** The locale's own numeric spelling of a date, used to fill the typed field. */
export function formatDateInput(value, locale) {
  const d = value instanceof Date ? value : new Date(value);
  if (!value && value !== 0) return '';
  if (Number.isNaN(d.getTime())) return '';
  const { order, separator } = localeDateOrder(locale);
  const p2 = (n) => String(n).padStart(2, '0');
  const bit = { year: String(d.getFullYear()), month: p2(d.getMonth() + 1), day: p2(d.getDate()) };
  return order.map((k) => bit[k]).join(separator);
}

/** A worked example of the locale's format, for the field's hint. */
export function localeDateExample(locale) {
  return formatDateInput(new Date(2026, 7, 2), locale);
}

/**
 * The locale's format as a pattern — `dd/mm/yyyy`, `mm/dd/yyyy`, `yyyy-mm-dd`.
 * This, not a worked example, is what goes in the placeholder: a real-looking
 * date sitting in an empty field reads as an applied filter, and a user who
 * believes a date is set cannot tell why nothing is being filtered.
 */
export function localeDatePattern(locale) {
  const { order, separator } = localeDateOrder(locale);
  const bit = { year: 'yyyy', month: 'mm', day: 'dd' };
  return order.map((k) => bit[k]).join(separator);
}

function realDate(year, month, day) {
  if (!(month >= 1 && month <= 12)) return { bad: 'month', value: month };
  const d = new Date(year, month - 1, day);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) {
    return { bad: 'day', value: day };
  }
  return { date: d };
}

/**
 * Read a typed date.
 *
 * Accepts the locale's own numeric format AND plain ISO (`2026-08-02`), which
 * is why the ISO branch is tried first: a year-first string is unambiguous in
 * every locale, so it can never be mistaken for a d/m/y that happens to parse.
 *
 * The returned object always carries `text` exactly as it was passed in. A
 * caller must never write `result.text` back into the field from a partial or
 * invalid parse — the whole point is that the user keeps typing.
 *
 * status: 'empty' | 'ok' | 'partial' | 'invalid'
 *
 * `message` is the reason in the active language mode; `messageKey` and
 * `messageParams` are the same reason unresolved, so a caller composing a
 * longer sentence can render it one language at a time instead of nesting a
 * bilingual fragment inside a bilingual template.
 */
export function parseDateInput(text, opts = {}) {
  const original = text === null || text === undefined ? '' : String(text);
  const raw = original.trim();
  const problem = (status, key, ...params) => ({
    text: original, date: null, ms: null, status,
    messageKey: key, messageParams: params, message: s(key, ...params),
  });
  const base = { text: original, date: null, ms: null, message: '', messageKey: '', messageParams: [] };

  if (!raw) return { ...base, status: 'empty' };

  // ISO and ISO-shaped (year first). Unambiguous, so it wins everywhere.
  const isoFull = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(raw);
  if (isoFull) {
    const r = realDate(Number(isoFull[1]), Number(isoFull[2]), Number(isoFull[3]));
    if (r.date) return { ...base, status: 'ok', date: r.date, ms: r.date.getTime() };
    return r.bad === 'month'
      ? problem('invalid', 'dpBadMonth', r.value)
      : problem('invalid', 'dpBadDay', `${isoFull[1]}-${isoFull[2]}`, r.value);
  }
  if (/^\d{4}$/.test(raw) || /^\d{4}[-/.]\d{0,2}[-/.]?$/.test(raw)) {
    return problem('partial', 'dpWantYMD');
  }

  const { order } = localeDateOrder(opts.locale);
  const bits = raw.split(/[^\d]+/).filter((x) => x !== '');
  if (!bits.length || !/^[\d\s./-]+$/.test(raw)) return problem('invalid', 'dpNotNumbers');
  if (bits.length < 3) return problem('partial', 'dpWantYMD');
  if (bits.length > 3) return problem('invalid', 'dpNotNumbers');

  const got = {};
  order.forEach((key, i) => { got[key] = Number(bits[i]); });
  let year = got.year;
  if (String(bits[order.indexOf('year')]).length <= 2) {
    // A two-digit year is read the way every spreadsheet reads it, and the
    // field shows the four-digit result so the guess is visible rather than
    // silent.
    year = year >= 70 ? 1900 + year : 2000 + year;
  }
  const r = realDate(year, got.month, got.day);
  if (r.date) return { ...base, status: 'ok', date: r.date, ms: r.date.getTime() };
  return r.bad === 'month'
    ? problem('invalid', 'dpBadMonth', r.value)
    : problem('invalid', 'dpBadDay', `${year}-${String(got.month).padStart(2, '0')}`, r.value);
}

/** Named presets. `resolve(now)` returns local-day bounds, or null for "all". */
export const DATE_PRESETS = [
  { id: 'all', labelKey: 'pAll', resolve: () => ({ from: null, to: null }) },
  { id: 'today', labelKey: 'pToday', resolve: (n) => ({ from: startOfDay(n), to: endOfDay(n) }) },
  { id: 'last7', labelKey: 'p7', resolve: (n) => ({ from: startOfDay(n - 6 * DAY_MS), to: endOfDay(n) }) },
  { id: 'last30', labelKey: 'p30', resolve: (n) => ({ from: startOfDay(n - 29 * DAY_MS), to: endOfDay(n) }) },
  {
    id: 'thisMonth',
    labelKey: 'pThisMonth',
    resolve: (n) => {
      const d = new Date(n);
      return { from: startOfDay(new Date(d.getFullYear(), d.getMonth(), 1)), to: endOfDay(n) };
    },
  },
  {
    id: 'lastMonth',
    labelKey: 'pLastMonth',
    resolve: (n) => {
      const d = new Date(n);
      const first = new Date(d.getFullYear(), d.getMonth() - 1, 1);
      const last = new Date(d.getFullYear(), d.getMonth(), 0);
      return { from: startOfDay(first), to: endOfDay(last) };
    },
  },
  {
    id: 'last6m',
    labelKey: 'p6m',
    resolve: (n) => {
      const d = new Date(n);
      return { from: startOfDay(new Date(d.getFullYear(), d.getMonth() - 6, d.getDate())), to: endOfDay(n) };
    },
  },
  {
    id: 'thisYear',
    labelKey: 'pThisYear',
    resolve: (n) => ({ from: startOfDay(new Date(new Date(n).getFullYear(), 0, 1)), to: endOfDay(n) }),
  },
];

export function resolvePreset(id, now = Date.now()) {
  const p = DATE_PRESETS.find((x) => x.id === id);
  return p ? { ...p.resolve(now), presetId: id } : { from: null, to: null, presetId: null };
}

/**
 * Normalize a range: bounds snapped to whole local days, and swapped when the
 * user entered them the wrong way round rather than silently matching nothing.
 */
export function normalizeRange(range) {
  let from = range && range.from != null ? Number(range.from) : null;
  let to = range && range.to != null ? Number(range.to) : null;
  if (from != null && Number.isNaN(from)) from = null;
  if (to != null && Number.isNaN(to)) to = null;
  if (from != null && to != null && from > to) { const x = from; from = to; to = x; }
  return {
    from: from == null ? null : startOfDay(from),
    to: to == null ? null : endOfDay(to),
    presetId: (range && range.presetId) || null,
    swapped: !!(range && range.from != null && range.to != null && Number(range.from) > Number(range.to)),
  };
}

/** Is `ms` inside the range? An open bound never excludes, and neither does a
 *  row with no date of its own — it is reported as undated, not as excluded. */
export function rangeContains(range, ms) {
  if (!range || (range.from == null && range.to == null)) return true;
  if (ms == null) return false;
  if (range.from != null && ms < range.from) return false;
  if (range.to != null && ms > range.to) return false;
  return true;
}

export function rangeIsOpen(range) {
  return !range || (range.from == null && range.to == null);
}

/**
 * "all dates" / "2026-08-01 onwards" / "up to 2026-08-02" / "A to B".
 * `L` is the single-language resolver `compose()` hands out; without it the
 * active mode is used, which is right for a standalone label.
 */
export function describeRange(range, L = s) {
  if (rangeIsOpen(range)) return L('dpRangeAll');
  if (range.from != null && range.to != null) return L('dpRangeBoth', isoDate(range.from), isoDate(range.to));
  if (range.from != null) return L('dpRangeFrom', isoDate(range.from));
  return L('dpRangeTo', isoDate(range.to));
}

/* ================================================================== */
/* composing filters                                                   */
/* ================================================================== */

/**
 * Apply every active filter in turn, so the result is the INTERSECTION of all
 * of them. This is the whole "compose, never override" rule in one function:
 * each filter narrows what the previous one left, and no filter can ever put
 * back a row another one removed. Both the changelog viewer and the history
 * panel run their date, action and text filters through this, which is why
 * they cannot drift apart.
 *
 * filters: [{ id, label, active, test(item) }]
 * returns { rows, total, applied: [{ id, label, before, after, removed }] }
 */
export function composeFilters(items, filters) {
  const list = Array.isArray(items) ? items.slice() : [];
  const applied = [];
  let rows = list;
  for (const f of filters || []) {
    if (!f || f.active === false || typeof f.test !== 'function') continue;
    const before = rows.length;
    rows = rows.filter((item) => {
      try { return !!f.test(item); } catch { return false; }
    });
    applied.push({ id: f.id, label: f.label || f.id, before, after: rows.length, removed: before - rows.length });
  }
  return { rows, total: list.length, applied };
}

/**
 * Join the names of the active filters into one clause. `L` is the resolver
 * from `compose()`, so the joiner comes from the same language as the parts.
 */
export function noMatchSentence(parts, scope, L = s) {
  const named = parts.filter(Boolean);
  if (!named.length) return scope;
  return named.join(L('clAnd'));
}

/* ================================================================== */
/* export                                                              */
/* ================================================================== */

/**
 * The statement that goes at the top of every export and copy. An extract with
 * no stated range is a document nobody can trust later, so this is not
 * optional decoration — it is what makes the file checkable.
 */
export function exportRangeStatement(opts = {}) {
  const range = normalizeRange(opts.range || {});
  const lines = [];
  lines.push(`Source: ${opts.scope || 'WinSCP Material — changelog'}`);
  if (rangeIsOpen(range)) lines.push('Range: all dates');
  else if (range.from != null && range.to != null) lines.push(`Range: ${isoDate(range.from)} to ${isoDate(range.to)}`);
  else if (range.from != null) lines.push(`Range: from ${isoDate(range.from)} onwards`);
  else lines.push(`Range: up to ${isoDate(range.to)}`);
  if (range.presetId && range.presetId !== 'all') lines.push(`Preset: ${range.presetId}`);
  lines.push(`Search: ${opts.search ? opts.search : 'none'}`);
  if (opts.actions && opts.actions.length) lines.push(`Actions: ${opts.actions.join(', ')}`);
  lines.push(`Entries: ${Number(opts.shown || 0)} of ${Number(opts.total || 0)}`);
  lines.push(`Generated: ${new Date(opts.generatedAt || Date.now()).toISOString()}`);
  return lines.join('\n');
}

/** Markdown for whatever is on screen, headed by the range statement. */
export function entriesToMarkdown(entries, statement, title) {
  const out = [`# ${title || 'WinSCP Material — changelog'}`, ''];
  out.push('```');
  out.push(statement);
  out.push('```');
  out.push('');
  if (!entries.length) {
    out.push('_Nothing matched the filter above._');
    return out.join('\n');
  }
  for (const e of entries) {
    const head = e.version
      ? `## ${e.version}${e.released ? '' : ' (unreleased)'}${e.date ? ` — ${e.date}` : ''}`
      : `## ${e.title}`;
    out.push(head);
    if (e.version && e.title) out.push(`_${e.title}_`);
    if (e.codeName) out.push(`Release code name: ${e.codeName.en}${e.codeName.zh ? ` · ${e.codeName.zh}` : ''}`);
    // The sha stays in the exported TEXT, so a copied changelog is still
    // traceable once it has left the app.
    if (e.ref) {
      const url = commitUrl(e);
      out.push(`Commit \`${e.oid || e.ref}\`${e.date ? ` — ${e.date}` : ''}${url ? ` — ${url}` : ''}`);
    }
    out.push('');
    if (!(e.changes || []).length) {
      out.push('_No recorded changes._');
    } else {
      const groups = new Map();
      for (const c of e.changes) {
        const k = c.category || 'changed';
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(c.text);
      }
      for (const [cat, texts] of groups) {
        out.push(`### ${cat.charAt(0).toUpperCase()}${cat.slice(1)}`);
        for (const x of texts) out.push(`- ${x}`);
        out.push('');
      }
    }
    if ((e.refs || []).length) out.push(`Issues: ${e.refs.join(', ')}`);
    out.push('');
  }
  return out.join('\n');
}

/* ================================================================== */
/* styles                                                              */
/* ================================================================== */

let stylesWritten = false;
function ensureStyles() {
  if (stylesWritten || typeof document === 'undefined') return;
  stylesWritten = true;
  styleSheet('changelog').set(`
.dp { display: flex; align-items: flex-start; gap: calc(8px * var(--den)); flex-wrap: wrap; }
.dp-field { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.dp-field > .field-label { font-size: var(--type-label-sm); color: var(--onsv); }
.dp-input { width: calc(13ch * var(--uiscale)); min-width: calc(11ch * var(--uiscale)); }
.dp-input::placeholder { color: var(--onsv); opacity: .6; font-style: italic; }
.dp-msg { font-size: var(--type-label-sm); color: var(--onerrc); background: var(--errc);
  border-radius: var(--shape-xs); padding: calc(3px * var(--den)) calc(7px * var(--den));
  max-width: 46ch; line-height: 1.35; }
.dp-tools { display: flex; align-items: center; gap: 4px; padding-top: calc(18px * var(--den)); }
.dp-summary { font-size: var(--type-label-sm); color: var(--onsv); align-self: center;
  padding-top: calc(18px * var(--den)); }
.dp-pop { position: fixed; z-index: 1; width: max-content; max-width: min(94vw, calc(420px * var(--uiscale)));
  background: var(--c-high); color: var(--onsfc); border-radius: var(--shape-lg);
  box-shadow: var(--e3); padding: calc(12px * var(--den)); display: flex; flex-direction: column;
  gap: calc(10px * var(--den)); overflow: auto; }
.dp-head { display: flex; align-items: center; gap: calc(6px * var(--den)); }
.dp-head select { min-height: calc(32px * var(--den)); border: 1px solid var(--outline);
  border-radius: var(--shape-xs); background: var(--c-lowest); color: var(--onsfc); padding: 0 4px; }
.dp-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; }
/* The rows exist for the accessibility tree: role="grid" may only contain
   role="row", and a row may only contain header/gridcell. display:contents
   keeps the ARIA structure without adding a box, so the seven-column grid
   above lays the cells out exactly as it did before. */
.dp-row { display: contents; }
.dp-wd { text-align: center; font-size: var(--type-label-sm); color: var(--onsv); padding: 2px 0; }
.dp-day { min-height: calc(32px * var(--den)); min-width: calc(32px * var(--den));
  border-radius: var(--shape-sm); font-size: var(--type-label-md); color: var(--onsfc);
  display: flex; align-items: center; justify-content: center; }
.dp-day:hover { background: color-mix(in srgb, var(--p) 14%, transparent); }
.dp-day.is-out { color: color-mix(in srgb, var(--onsv) 55%, transparent); }
.dp-day.is-in { background: var(--secc); color: var(--onsecc); border-radius: 0; }
.dp-day.is-edge { background: var(--p); color: var(--onp); font-weight: 700; }
.dp-day.is-today { outline: 1px solid var(--outline); outline-offset: -2px; }
.dp-presets { display: flex; flex-wrap: wrap; gap: 4px; }
.dp-preset { min-height: calc(28px * var(--den)); padding: 0 calc(10px * var(--den));
  border-radius: var(--shape-full); background: var(--c-lowest); color: var(--onsfc);
  border: 1px solid var(--outline-var); font-size: var(--type-label-sm); }
.dp-preset.is-on { background: var(--pc); color: var(--onpc); border-color: transparent; font-weight: 600; }
.dp-foot { display: flex; align-items: center; gap: 6px; }

.cl { display: flex; flex-direction: column; gap: calc(10px * var(--den)); min-height: 0; }
.cl-tools { display: flex; flex-direction: column; gap: calc(8px * var(--den)); }
.cl-actions { display: flex; align-items: center; gap: calc(6px * var(--den)); flex-wrap: wrap; }
.cl-count { font-size: var(--type-label-md); color: var(--onsv); }
.cl-note { font-size: var(--type-body-sm); color: var(--onsv); line-height: 1.5;
  background: var(--c-low); border-radius: var(--shape-md); padding: calc(10px * var(--den)); }
.cl-list { display: flex; flex-direction: column; gap: calc(10px * var(--den));
  overflow: auto; min-height: 0; padding-right: 2px; }
.cl-entry { background: var(--c-low); border-radius: var(--shape-md);
  padding: calc(12px * var(--den)); display: flex; flex-direction: column; gap: calc(8px * var(--den)); }
.cl-entry-head { display: flex; align-items: baseline; gap: calc(8px * var(--den)); flex-wrap: wrap; }
.cl-ver { font-size: var(--type-title-md); font-weight: 700; }
.cl-date { font-size: var(--type-label-md); color: var(--onsv); }
.cl-commit { display: inline-flex; align-items: center; gap: 4px; color: var(--p);
  font-size: var(--type-label-md); font-weight: 600; border-radius: var(--shape-xs);
  padding: 1px calc(5px * var(--den)); }
.cl-commit:hover { background: color-mix(in srgb, var(--p) 12%, transparent); }
.cl-badge { display: inline-flex; align-items: center; gap: 4px; border-radius: var(--shape-full);
  padding: 0 calc(8px * var(--den)); min-height: calc(20px * var(--den));
  font-size: var(--type-label-sm); font-weight: 600; background: var(--terc); color: var(--onterc); }
.cl-title { font-size: var(--type-body-md); line-height: 1.45; }
.cl-code { display: flex; align-items: center; gap: calc(10px * var(--den)); }
.cl-code img { width: calc(56px * var(--uiscale)); height: calc(56px * var(--uiscale));
  border-radius: var(--shape-md); object-fit: cover; }
.cl-code-name { font-size: var(--type-label-md); }
.cl-cat { margin-top: calc(4px * var(--den)); }
.cl-cat-name { font-size: var(--type-label-sm); font-weight: 700; letter-spacing: .04em;
  text-transform: uppercase; color: var(--onsv); }
.cl-items { margin: calc(4px * var(--den)) 0 0 0; padding-left: calc(18px * var(--den));
  display: flex; flex-direction: column; gap: calc(4px * var(--den)); }
.cl-items li { line-height: 1.5; }
.cl-meta { display: flex; gap: calc(10px * var(--den)); flex-wrap: wrap;
  font-size: var(--type-label-sm); color: var(--onsv); }
.cl-empty { padding: calc(20px * var(--den)); text-align: center; color: var(--onsv);
  line-height: 1.55; background: var(--c-low); border-radius: var(--shape-md); }
`);
}

/* ================================================================== */
/* the calendar                                                        */
/* ================================================================== */

function weekdayNames(locale) {
  const fmt = new Intl.DateTimeFormat(locale || undefined, { weekday: 'short' });
  // 2026-08-02 is a Sunday, which makes index 0 = Sunday without hard-coding
  // any name; the first-day-of-week below rotates it for the locale.
  const base = new Date(2026, 7, 2);
  const out = [];
  for (let i = 0; i < 7; i += 1) out.push(fmt.format(new Date(base.getFullYear(), base.getMonth(), base.getDate() + i)));
  return out;
}

function firstDayOfWeek(locale) {
  try {
    const l = new Intl.Locale(locale || navigator.language || 'en');
    const info = typeof l.getWeekInfo === 'function' ? l.getWeekInfo() : l.weekInfo;
    if (info && info.firstDay) return info.firstDay % 7;   // Intl: 1=Mon … 7=Sun
  } catch { /* fall through to Sunday, the widest default */ }
  return 0;
}

function monthNames(locale) {
  const fmt = new Intl.DateTimeFormat(locale || undefined, { month: 'long' });
  const out = [];
  for (let m = 0; m < 12; m += 1) out.push(fmt.format(new Date(2026, m, 1)));
  return out;
}

/**
 * The anchored calendar. It edits a RANGE: the first pick sets the start, the
 * second sets the end (swapped if it lands earlier), and a third starts again.
 * Arrow keys move a day, PageUp/PageDown a month, Shift+PageUp/PageDown a year.
 */
function openCalendar(opts) {
  ensureStyles();
  const locale = opts.locale;
  const restore = focusMemory();
  let range = normalizeRange(opts.range || {});
  let view = new Date(range.from != null ? range.from : Date.now());
  view = new Date(view.getFullYear(), view.getMonth(), 1);
  let pendingFrom = null;                       // set by the first click
  let focusMs = range.from != null ? range.from : startOfDay(Date.now());

  const titleId = uid('dp-title');
  const grid = h('div', { class: 'dp-grid', role: 'grid', 'aria-labelledby': titleId });
  const monthSel = h('select', { 'aria-label': s('dpMonth') });
  const yearSel = h('select', { 'aria-label': s('dpYear') });
  const presetsRow = h('div', { class: 'dp-presets', role: 'group', 'aria-label': s('dpPresets') });

  const prevBtn = h('button', {
    type: 'button', class: 'icon-btn', title: s('dpPrevMonth'), 'aria-label': s('dpPrevMonth'),
    onclick: () => { view = new Date(view.getFullYear(), view.getMonth() - 1, 1); paint(); },
  }, icon('chevron_left', 18));
  const nextBtn = h('button', {
    type: 'button', class: 'icon-btn', title: s('dpNextMonth'), 'aria-label': s('dpNextMonth'),
    onclick: () => { view = new Date(view.getFullYear(), view.getMonth() + 1, 1); paint(); },
  }, icon('chevron_right', 18));

  const pop = h('div', {
    class: 'dp-pop surface-3', role: 'dialog', 'aria-modal': 'false',
    'aria-label': `${s('dpFrom')} / ${s('dpTo')}`, tabindex: '-1',
  },
  h('div', { class: 'dp-head' }, prevBtn, monthSel, yearSel, h('span', { class: 'spacer', id: titleId }), nextBtn),
  grid,
  presetsRow,
  h('div', { class: 'dp-foot' },
    h('button', {
      type: 'button', class: 'btn-text',
      onclick: () => { view = new Date(); view.setDate(1); focusMs = startOfDay(Date.now()); paint(); },
    }, s('dpToday')),
    h('span', { class: 'spacer' }),
    h('button', {
      type: 'button', class: 'btn-text',
      onclick: () => { range = normalizeRange({}); pendingFrom = null; emit(); paint(); },
    }, s('dpClear')),
    h('button', { type: 'button', class: 'btn-filled', onclick: () => close() }, t('close'))));

  const years = [];
  {
    const nowY = new Date().getFullYear();
    for (let y = nowY - 30; y <= nowY + 5; y += 1) years.push(y);
  }
  for (const y of years) yearSel.appendChild(h('option', { value: String(y) }, String(y)));
  monthNames(locale).forEach((name, i) => monthSel.appendChild(h('option', { value: String(i) }, name)));
  monthSel.addEventListener('change', () => { view = new Date(view.getFullYear(), Number(monthSel.value), 1); paint(); });
  yearSel.addEventListener('change', () => { view = new Date(Number(yearSel.value), view.getMonth(), 1); paint(); });

  for (const p of DATE_PRESETS) {
    const btn = h('button', {
      type: 'button', class: 'dp-preset', 'data-preset': p.id,
      onclick: () => {
        range = normalizeRange({ ...p.resolve(Date.now()), presetId: p.id });
        pendingFrom = null;
        if (range.from != null) { view = new Date(range.from); view.setDate(1); focusMs = range.from; }
        emit();
        paint();
      },
    }, s(p.labelKey));
    presetsRow.appendChild(btn);
  }

  function emit() { opts.onChange?.(range); }

  function pick(ms) {
    if (pendingFrom == null) {
      pendingFrom = ms;
      range = normalizeRange({ from: ms, to: ms });
    } else {
      range = normalizeRange({ from: pendingFrom, to: ms });
      pendingFrom = null;
    }
    focusMs = ms;
    emit();
    paint();
    announce(s('dpSelected', describeRange(range)));
  }

  function paint() {
    monthSel.value = String(view.getMonth());
    if (!years.includes(view.getFullYear())) {
      // A typed year outside the list must still be selectable rather than
      // snapping the calendar somewhere the user did not ask for.
      yearSel.appendChild(h('option', { value: String(view.getFullYear()) }, String(view.getFullYear())));
      years.push(view.getFullYear());
    }
    yearSel.value = String(view.getFullYear());

    clear(grid);
    const fdow = firstDayOfWeek(locale);
    const names = weekdayNames(locale);
    const headRow = h('div', { class: 'dp-row', role: 'row' });
    for (let i = 0; i < 7; i += 1) {
      headRow.appendChild(h('div', { class: 'dp-wd', role: 'columnheader' }, names[(fdow + i) % 7]));
    }
    grid.appendChild(headRow);
    const first = new Date(view.getFullYear(), view.getMonth(), 1);
    const lead = (first.getDay() - fdow + 7) % 7;
    const start = new Date(view.getFullYear(), view.getMonth(), 1 - lead);
    const todayMs = startOfDay(Date.now());
    const fmtFull = new Intl.DateTimeFormat(locale || undefined, { dateStyle: 'full' });

    let weekRow = null;
    for (let i = 0; i < 42; i += 1) {
      if (i % 7 === 0) { weekRow = h('div', { class: 'dp-row', role: 'row' }); grid.appendChild(weekRow); }
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      const ms = startOfDay(d);
      const out = d.getMonth() !== view.getMonth();
      const inRange = range.from != null && range.to != null && ms >= range.from && ms <= range.to;
      const edge = (range.from != null && ms === startOfDay(range.from)) || (range.to != null && ms === startOfDay(range.to));
      const cls = ['dp-day'];
      if (out) cls.push('is-out');
      if (inRange && !edge) cls.push('is-in');
      if (edge) cls.push('is-edge');
      if (ms === todayMs) cls.push('is-today');
      const cell = h('button', {
        type: 'button', class: cls.join(' '), role: 'gridcell',
        'aria-label': fmtFull.format(d),
        'aria-selected': String(!!(inRange || edge)),
        'aria-current': ms === todayMs ? 'date' : null,
        tabindex: ms === startOfDay(focusMs) ? '0' : '-1',
        'data-ms': String(ms),
        onclick: () => pick(ms),
      }, String(d.getDate()));
      weekRow.appendChild(cell);
    }
    for (const b of presetsRow.children) b.classList.toggle('is-on', b.dataset.preset === range.presetId);
    if (!grid.querySelector('[tabindex="0"]')) {
      const firstIn = grid.querySelector('.dp-day:not(.is-out)');
      if (firstIn) firstIn.tabIndex = 0;
    }
  }

  function moveFocus(deltaDays, deltaMonths, deltaYears) {
    const d = new Date(focusMs);
    const next = new Date(
      d.getFullYear() + (deltaYears || 0),
      d.getMonth() + (deltaMonths || 0),
      d.getDate() + (deltaDays || 0),
    );
    focusMs = startOfDay(next);
    view = new Date(next.getFullYear(), next.getMonth(), 1);
    paint();
    const cell = grid.querySelector(`[data-ms="${focusMs}"]`);
    if (cell) cell.focus();
  }

  grid.addEventListener('keydown', (e) => {
    const map = {
      ArrowRight: () => moveFocus(1), ArrowLeft: () => moveFocus(-1),
      ArrowDown: () => moveFocus(7), ArrowUp: () => moveFocus(-7),
      Home: () => moveFocus(-(new Date(focusMs).getDay())),
      End: () => moveFocus(6 - new Date(focusMs).getDay()),
      PageUp: () => (e.shiftKey ? moveFocus(0, 0, -1) : moveFocus(0, -1)),
      PageDown: () => (e.shiftKey ? moveFocus(0, 0, 1) : moveFocus(0, 1)),
    };
    if (map[e.key]) { e.preventDefault(); map[e.key](); return; }
    if (e.key === 'Enter' || e.key === ' ') {
      const cell = e.target.closest('[data-ms]');
      if (cell) { e.preventDefault(); pick(Number(cell.dataset.ms)); }
    }
  });

  layer('popover').appendChild(pop);
  const anchor = anchorTo(pop, opts.anchor, { placement: 'bottom-start', onDetach: () => close() });
  paint();
  requestAnimationFrame(() => { (grid.querySelector('[tabindex="0"]') || pop).focus(); });

  const offDown = on(document, 'pointerdown', (e) => {
    if (!pop.contains(e.target) && e.target !== opts.anchor && !opts.anchor.contains(e.target)) close();
  }, true);
  const offKey = on(document, 'keydown', (e) => {
    if (e.key === 'Escape' && pop.contains(document.activeElement)) { e.stopPropagation(); close(); }
  }, true);

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    offDown();
    offKey();
    anchor.dispose();
    pop.remove();
    opts.onClose?.();
    restore();
  }

  return {
    close,
    setRange(next) { range = normalizeRange(next || {}); pendingFrom = null; if (range.from != null) { view = new Date(range.from); view.setDate(1); focusMs = range.from; } paint(); },
    get element() { return pop; },
  };
}

/* ================================================================== */
/* the date-range filter control                                       */
/* ================================================================== */

/**
 * createDateRangeFilter({ id, locale, value, onChange, presets })
 *
 * Two typed fields plus the anchored calendar and the named presets. The rules
 * that matter:
 *
 *   * a partial or invalid entry is reported INLINE and the typed text is left
 *     alone — the bound is simply not applied, so the user is never filtered by
 *     half a date and never has their keystrokes eaten;
 *   * typing a complete date moves the calendar to it, and picking in the
 *     calendar rewrites the fields in the locale's format. Neither clears the
 *     other.
 */
export function createDateRangeFilter(opts = {}) {
  ensureStyles();
  const locale = opts.locale || (typeof navigator !== 'undefined' ? navigator.language : 'en');
  const id = opts.id || uid('dp');
  const subscribers = new Set();

  let range = normalizeRange(opts.value || {});
  let fromState = { text: range.from == null ? '' : formatDateInput(range.from, locale), status: range.from == null ? 'empty' : 'ok' };
  let toState = { text: range.to == null ? '' : formatDateInput(range.to, locale), status: range.to == null ? 'empty' : 'ok' };
  let calendar = null;

  const fromId = uid('dp-from');
  const toId = uid('dp-to');
  const msgId = uid('dp-msg');

  const fromInput = h('input', {
    type: 'text', id: fromId, class: 'field-input dp-input', autocomplete: 'off', spellcheck: 'false',
    inputmode: 'numeric', 'aria-describedby': msgId,
  });
  const toInput = h('input', {
    type: 'text', id: toId, class: 'field-input dp-input', autocomplete: 'off', spellcheck: 'false',
    inputmode: 'numeric', 'aria-describedby': msgId,
  });
  fromInput.value = fromState.text;
  toInput.value = toState.text;

  const msg = h('div', { class: 'dp-msg', id: msgId, role: 'status', hidden: true });
  const summary = h('span', { class: 'dp-summary' });

  const calBtn = h('button', {
    type: 'button', class: 'icon-btn', 'aria-haspopup': 'dialog',
    title: s('dpOpenCalendar'), 'aria-label': s('dpOpenCalendar'),
    onclick: () => toggleCalendar(),
  }, icon('history', 18));

  const clearBtn = h('button', {
    type: 'button', class: 'icon-btn', title: s('dpClear'), 'aria-label': s('dpClear'),
    onclick: () => { setRange({ from: null, to: null, presetId: 'all' }); fromInput.focus(); },
  }, icon('close', 16));

  const root = h('div', { class: 'dp', 'data-date-filter': id },
    h('div', { class: 'dp-field' },
      h('label', { class: 'field-label', for: fromId }, s('dpFrom')),
      fromInput),
    h('div', { class: 'dp-field' },
      h('label', { class: 'field-label', for: toId }, s('dpTo')),
      toInput),
    h('div', { class: 'dp-tools' }, calBtn, clearBtn),
    summary,
    h('div', { class: 'dp-field', style: { flex: '1 1 100%' } }, msg));

  appearanceTarget(root, opts.appearanceKey || `date-filter-${id}`, opts.appearanceLabel || 'Date filter');

  function activeRange() {
    // A bound that did not parse is simply absent. It is never guessed at, and
    // the message beside the field says so.
    return normalizeRange({
      from: fromState.status === 'ok' ? fromState.ms : null,
      to: toState.status === 'ok' ? toState.ms : null,
      presetId: range.presetId,
    });
  }

  function paintMessage() {
    const problems = [];
    for (const [state, labelKey] of [[fromState, 'dpFrom'], [toState, 'dpTo']]) {
      if (state.status !== 'partial' && state.status !== 'invalid') continue;
      // Composed one language at a time: the reason is itself a translated
      // string, and nesting it inside a translated template would produce a
      // sentence that is half English and half Cantonese twice over.
      problems.push(compose((L) => {
        const why = L(state.messageKey, ...(state.messageParams || []));
        return `${L(labelKey)}: ${L(state.status === 'partial' ? 'dpPartial' : 'dpInvalid', why)}`;
      }));
    }
    msg.hidden = problems.length === 0;
    clear(msg);
    for (const p of problems) msg.appendChild(h('div', {}, p));
    fromInput.setAttribute('aria-invalid', String(fromState.status === 'invalid' || fromState.status === 'partial'));
    toInput.setAttribute('aria-invalid', String(toState.status === 'invalid' || toState.status === 'partial'));
    const hint = s('dpHint', localeDateExample(locale));
    fromInput.title = hint;
    toInput.title = hint;
    fromInput.placeholder = localeDatePattern(locale);
    toInput.placeholder = localeDatePattern(locale);
    summary.textContent = describeRange(activeRange());
  }

  function notifyChange() {
    range = activeRange();
    paintMessage();
    calendar?.setRange(range);
    const snapshot = { range, valid: fromState.status !== 'invalid' && toState.status !== 'invalid' && fromState.status !== 'partial' && toState.status !== 'partial', fromState, toState };
    for (const fn of Array.from(subscribers)) {
      try { fn(snapshot); } catch (err) { console.error('[datefilter] subscriber failed', err); }
    }
    opts.onChange?.(snapshot);
  }

  function readField(which) {
    const input = which === 'from' ? fromInput : toInput;
    const parsed = parseDateInput(input.value, { locale });
    const state = { ...parsed };
    if (which === 'from') fromState = state; else toState = state;
    range = { ...range, presetId: null };
    notifyChange();
  }

  fromInput.addEventListener('input', () => readField('from'));
  toInput.addEventListener('input', () => readField('to'));

  // Blur is where a complete date gets tidied into the locale's spelling. It
  // never touches a partial or invalid entry, so nothing the user typed is
  // taken away while they are still typing it.
  const tidy = (which) => {
    const state = which === 'from' ? fromState : toState;
    const input = which === 'from' ? fromInput : toInput;
    if (state.status === 'ok') input.value = formatDateInput(state.date, locale);
  };
  fromInput.addEventListener('blur', () => tidy('from'));
  toInput.addEventListener('blur', () => tidy('to'));
  for (const input of [fromInput, toInput]) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); input.focus(); }
    });
  }

  function toggleCalendar() {
    if (calendar) { calendar.close(); return; }
    calendar = openCalendar({
      anchor: calBtn,
      locale,
      range: activeRange(),
      onChange: (next) => setRange(next, { fromCalendar: true }),
      onClose: () => { calendar = null; },
    });
  }

  function setRange(next, o = {}) {
    const norm = normalizeRange(next || {});
    fromState = norm.from == null
      ? { text: '', status: 'empty', date: null, ms: null, message: '' }
      : { text: formatDateInput(norm.from, locale), status: 'ok', date: new Date(norm.from), ms: norm.from, message: '' };
    toState = norm.to == null
      ? { text: '', status: 'empty', date: null, ms: null, message: '' }
      : { text: formatDateInput(norm.to, locale), status: 'ok', date: new Date(norm.to), ms: norm.to, message: '' };
    fromInput.value = fromState.text;
    toInput.value = toState.text;
    range = { ...norm };
    paintMessage();
    if (!o.fromCalendar) calendar?.setRange(range);
    const snapshot = { range: activeRange(), valid: true, fromState, toState };
    for (const fn of Array.from(subscribers)) {
      try { fn(snapshot); } catch (err) { console.error('[datefilter] subscriber failed', err); }
    }
    opts.onChange?.(snapshot);
  }

  paintMessage();

  return {
    element: root,
    get range() { return activeRange(); },
    get valid() { return fromState.status !== 'invalid' && toState.status !== 'invalid' && fromState.status !== 'partial' && toState.status !== 'partial'; },
    get state() { return { fromState, toState }; },
    setRange,
    clear() { setRange({ from: null, to: null, presetId: 'all' }); },
    focus() { fromInput.focus(); fromInput.select(); },
    subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); },
    destroy() {
      calendar?.close();
      subscribers.clear();
      root.remove();
    },
  };
}

/* ================================================================== */
/* the viewer                                                          */
/* ================================================================== */

const CATEGORY_ORDER = ['breaking', 'security', 'added', 'changed', 'fixed', 'removed'];

function categoryLabel(cat) {
  const c = String(cat || 'changed');
  return c.charAt(0).toUpperCase() + c.slice(1);
}

/** Resolve the bundled photo for a code name, or null when there is none. */
async function codeNamePhoto(codeName) {
  if (!codeName || typeof window === 'undefined' || !window.api?.app?.codeName) return null;
  try {
    const res = await window.api.app.codeName([]);
    const value = res && res.ok ? res.value : null;
    // Only ever show the picture that actually belongs to THIS code name;
    // a photo of a different dish beside the name is worse than no photo.
    if (value && value.dataUri && codeName.file && value.file === codeName.file) return value.dataUri;
  } catch { /* no bridge, or the catalog has no image for it yet */ }
  return null;
}

/**
 * createChangelogViewer() -> { element, destroy() }
 *
 * The date filter and the search compose: `composeFilters` runs both in turn,
 * so neither can widen what the other narrowed.
 */
export function createChangelogViewer(opts = {}) {
  ensureStyles();
  const entries = changelogEntries();
  const locale = opts.locale || (typeof navigator !== 'undefined' ? navigator.language : 'en');

  const list = h('div', { class: 'cl-list' });
  const count = h('span', { class: 'cl-count', role: 'status' });

  const search = createSearchBar({
    id: opts.searchId || 'changelog',
    persist: opts.persist !== false,
    labelKey: 'search',
    placeholder: s('clSearchPh'),
    appearanceKey: 'search-changelog',
    appearanceLabel: 'Changelog search',
    sampleProvider: () => entries.flatMap(entryText).join('\n'),
    onChange: render,
  });

  const dates = createDateRangeFilter({
    id: 'changelog-dates',
    locale,
    appearanceKey: 'date-filter-changelog',
    appearanceLabel: 'Changelog date filter',
    onChange: render,
  });

  const copyBtn = h('button', {
    type: 'button', class: 'btn-text',
    onclick: async () => {
      const shown = currentRows();
      const md = entriesToMarkdown(shown, statement(shown), s('clTitle'));
      const ok = await copyText(md);
      if (ok) notify.success(s('clTitle'), s('clCopied', shown.length, describeRange(dates.range)));
      else notify.error(s('clTitle'), s('clCopyFailed'));
    },
  }, icon('content_copy', 16), s('clCopy'));

  const exportBtn = h('button', {
    type: 'button', class: 'btn-text',
    onclick: () => {
      const shown = currentRows();
      const md = entriesToMarkdown(shown, statement(shown), s('clTitle'));
      const name = `winscp-material-changelog-${isoDate(Date.now())}.md`;
      downloadText(name, md, 'text/markdown');
      notify.success(s('clTitle'), s('clExported', name));
    },
  }, icon('file_download', 16), s('clExportMd'));

  const root = h('div', { class: 'cl' },
    h('div', { class: 'cl-tools' },
      search.element,
      dates.element,
      h('div', { class: 'cl-actions' }, count, h('span', { class: 'spacer' }), copyBtn, exportBtn)),
    list);
  appearanceTarget(root, 'changelog', 'Changelog viewer');

  function statement(shown) {
    return exportRangeStatement({
      scope: 'WinSCP Material — changelog',
      range: dates.range,
      search: search.isActive ? search.predicate.describe : '',
      shown: shown.length,
      total: entries.length,
    });
  }

  function currentRows() {
    const predicate = search.predicate;
    const { rows } = composeFilters(entries, [
      {
        id: 'date',
        label: describeRange(dates.range),
        active: !rangeIsOpen(dates.range),
        test: (e) => rangeContains(dates.range, e.time),
      },
      {
        id: 'search',
        label: predicate.describe,
        active: search.isActive && predicate.ok,
        test: (e) => entryText(e).some((v) => predicate.test(v)),
      },
    ]);
    return rows;
  }

  function renderEntry(entry) {
    const head = h('div', { class: 'cl-entry-head' });
    if (entry.version) {
      head.appendChild(h('span', { class: 'cl-ver mono' }, entry.version));
      if (!entry.released) head.appendChild(h('span', { class: 'cl-badge' }, icon('pending', 12), s('clUnreleased')));
    }
    if (entry.date) head.appendChild(h('span', { class: 'cl-date mono' }, entry.date));
    if (entry.ref) {
      const url = commitUrl(entry);
      head.appendChild(url
        ? h('button', {
          type: 'button', class: 'cl-commit mono',
          title: `${s('clOpenCommit')} — ${url}`,
          'aria-label': `${s('clOpenCommit')} ${entry.ref}`,
          onclick: async () => {
            const ok = await api.openExternal(url);
            if (ok === false) {
              const copied = await copyText(url);
              notify.warning(s('clTitle'), `${s('clOpenFailed', url)}${copied ? ` ${t('copiedClip')}` : ''}`);
            }
          },
        }, icon('open_in_new', 13), `${s('clCommit')} ${entry.ref}`)
        // No recorded sha: say so rather than offering a link that guesses at
        // a neighbouring commit.
        : h('span', { class: 'cl-date mono', title: s('clNoCommit') }, `${s('clCommit')} ${entry.ref}`));
    }

    const card = h('div', { class: 'cl-entry' }, head);
    appearanceTarget(card, `changelog-entry-${entry.id}`, `Changelog entry ${entry.version || entry.ref || entry.id}`);

    if (entry.title) card.appendChild(h('div', { class: 'cl-title' }, entry.title));

    if (entry.codeName) {
      const nameText = entry.codeName.zh ? `${entry.codeName.en} · ${entry.codeName.zh}` : entry.codeName.en;
      const wrap = h('div', { class: 'cl-code' },
        h('div', { class: 'cl-code-name' },
          h('div', { class: 'cl-cat-name' }, s('clCodeName')),
          h('div', {}, nameText)));
      card.appendChild(wrap);
      codeNamePhoto(entry.codeName).then((src) => {
        if (!src || !wrap.isConnected) return;
        const img = h('img', {
          src, width: 56, height: 56,
          alt: entry.codeName.zh ? `${entry.codeName.en} (${entry.codeName.zh})` : entry.codeName.en,
        });
        img.addEventListener('error', () => img.remove());
        wrap.insertBefore(img, wrap.firstChild);
      });
    }

    if (!(entry.changes || []).length) {
      card.appendChild(h('div', { class: 'muted' }, s('clNoChanges')));
    } else {
      const groups = new Map();
      for (const c of entry.changes) {
        const k = c.category || 'changed';
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(c.text);
      }
      const ordered = [...groups.keys()].sort((a, b) => {
        const ia = CATEGORY_ORDER.indexOf(a), ib = CATEGORY_ORDER.indexOf(b);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      });
      for (const cat of ordered) {
        const block = h('div', { class: 'cl-cat' },
          h('div', { class: 'cl-cat-name' }, categoryLabel(cat)),
          h('ul', { class: 'cl-items' }, ...groups.get(cat).map((x) => h('li', {}, x))));
        card.appendChild(block);
      }
    }

    const meta = h('div', { class: 'cl-meta' });
    if ((entry.refs || []).length) meta.appendChild(h('span', {}, `${s('clIssues')}: ${entry.refs.join(', ')}`));
    if (meta.childNodes.length) card.appendChild(meta);
    return card;
  }

  function render() {
    const rows = currentRows();
    clear(list);
    count.textContent = s('clShowing', rows.length, entries.length);

    if (!CHANGELOG.releases.length) {
      list.appendChild(h('div', { class: 'cl-note' }, s('clNoReleases')));
    }

    if (!rows.length) {
      const sentence = compose((L) => {
        const parts = [];
        if (!rangeIsOpen(dates.range)) parts.push(L('clFilterDate', describeRange(dates.range, L)));
        if (search.isActive) parts.push(L('clFilterSearch', search.predicate.describe));
        return L('clNoMatch', noMatchSentence(parts, describeRange(dates.range, L), L));
      });
      list.appendChild(h('div', { class: 'cl-empty' }, sentence));
      return;
    }

    let sawDev = false;
    for (const entry of rows) {
      if (entry.kind === 'build') {
        list.appendChild(h('div', { class: 'cl-cat-name' }, s('clCurrentBuild')));
      } else if (entry.kind === 'commit' && !sawDev) {
        sawDev = true;
        list.appendChild(h('div', { class: 'cl-cat-name' }, s('clDevHistory')));
        list.appendChild(h('div', { class: 'cl-note' }, s('clDevNote', CHANGELOG.developmentUpTo)));
      }
      list.appendChild(renderEntry(entry));
    }
  }

  const unbind = bindRender(root, render);

  return {
    element: root,
    search,
    dates,
    get rows() { return currentRows(); },
    destroy() {
      unbind();
      search.destroy();
      dates.destroy();
      root.remove();
    },
  };
}

/* ================================================================== */
/* registration                                                        */
/* ================================================================== */

let installed = false;

/** Idempotent. Registers the `changelog` dialog and the `app.changelog` command. */
export function registerChangelog() {
  if (installed) return;
  installed = true;
  ensureStyles();

  registerDialog('changelog', () => {
    const viewer = createChangelogViewer();
    return {
      title: s('clTitle'),
      width: 860,
      content: viewer.element,
      onClose: () => viewer.destroy(),
      actions: [{ label: t('close'), kind: 'filled', autofocus: true }],
    };
  });

  registerCommand({
    id: 'app.changelog',
    label: s('clTitle'),
    icon: 'receipt_long',
    run: () => openDialog('changelog'),
  });
}

/** Open the viewer. Used by About and by the Help menu. */
export function openChangelog() {
  registerChangelog();
  return openDialog('changelog');
}

if (typeof document !== 'undefined') {
  // Deferred by a microtask so a bare `import './changelog.js'` is enough to
  // wire the viewer up, without touching app.js's registries while its own
  // module body may still be evaluating.
  queueMicrotask(() => {
    try { registerChangelog(); } catch (err) { console.error('[changelog] registration failed', err); }
  });
}
