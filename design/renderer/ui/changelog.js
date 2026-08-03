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
    id: "12dd655", kind: 'commit', ref: "12dd655", oid: "12dd6555a08866e5a7f73919a8b8a7650fc23ff3", date: "2026-08-02",
    title: "Exclude agent worktrees from Electron packages",
    changes: [
      { category: "fixed", text: "Electron Forge now excludes linked-agent worktrees from the packaged application. Without that guard, a local worktree could contain an earlier out/ tree and recursively inflate app.asar from a normal desktop bundle into a multi-gigabyte archive." },
      { category: "fixed", text: "Added a packaging regression test and verified the real Windows makers: a 31,407,852-byte app.asar, 130,832,896-byte Setup.exe, matching Squirrel manifest, and 133,137,285-byte portable zip." },
    ],
    changesYue: [
      { category: "fixed", text: "Electron Forge 而家唔會再打包 linked-agent worktree。之前個 worktree 入面有舊 out/，結果 app.asar 由正常 desktop bundle 脹到幾 GB，成隻 app 好似食完自助餐咁。" },
      { category: "fixed", text: "加咗 packaging 回歸測試，亦真係跑過 Windows makers：31,407,852 bytes 嘅 app.asar、130,832,896 bytes Setup.exe、同 RELEASES 對得上嘅 Squirrel package，同 133,137,285 bytes portable zip。" },
    ],
  },
  {
    id: "640d1f4", kind: 'commit', ref: "640d1f4", oid: "640d1f4f795d987b98fb1dadf610ca93b0ddf50c", date: "2026-08-02",
    title: "Align queued local symlink planning with foreground transfers",
    changes: [
      { category: "fixed", text: "Queued local uploads now descend into local directory symlinks under excludeEmptyDirectories just as the foreground engine does. Remote-source plans still require followDirectorySymlinks, so a remote link is not followed by accident." },
      { category: "fixed", text: "Added a regression test that proves the symlink's file arrives and that the queued directory plan contains the expected directories rather than pruning the tree." },
    ],
    changesYue: [
      { category: "fixed", text: "佇列上載本機資料夾而家同前景引擎一樣，開住 excludeEmptyDirectories 都會落入本機 directory symlink；remote source 就繼續要明確開 followDirectorySymlinks，唔會自己走捷徑。" },
      { category: "fixed", text: "加咗回歸測試，證明 symlink 入面嘅檔案真係到，同埋個 queue plan 冇再將成棵樹當空目錄斬走。" },
    ],
  },
  {
    id: "c6cbbc5", kind: 'commit', ref: "c6cbbc5", oid: "c6cbbc520d8983b18a83bc8ebef9c1c6cced7f65", date: "2026-08-02",
    title: "Stop one test permanently forbidding the only fix for another",
    changes: [
      { category: "fixed", text: "Two fixes from the same wave landed with a deadlock between them, spotted by the completeness critic rather than by either author — each was correct alone." },
      { category: "fixed", text: "The shallow-clone fix added `submodules: false` count === checkout count, to stop someone paying for full history by quietly pulling 300k lines of vendored C++ into every run. Reasonable. But the extractor fix skips two tests when vendor/ is absent (NO_VENDOR), and checking the submodule out in the test job is the only way to un-skip them — which an assertion demanding `false` forbids outright. A test that permanently prevents the only fix for another test is worse than no test, and nothing about either commit made that visible." },
      { category: "changed", text: "The guard now asserts the value is DECLARED rather than that it is false. The accident worth catching was always an omitted key, where a default nobody read decides whether 300k lines enter the run; flipping one to true is a deliberate, reviewable trade — slower runs against real coverage of the extractor — and belongs to whoever makes it." },
      { category: "changed", text: "Not weakened: removing one declaration still turns it red, now naming which checkout (\"2 checkouts, 1 declared\"). 42/42." },
    ],
    changesYue: [
      { category: "changed", text: "同一浪入面兩個修改各自啱，夾埋就打結 —— 而且係「查漏」嗰個 agent 執到，兩個作者 都冇為意。" },
      { category: "changed", text: "一個要求「每個 checkout 都必須 submodules: false」，另一個因為冇 vendor/ 而 skip 咗 兩個測試 —— 而唯一解得到嗰個 skip 嘅方法，就係喺 CI 度 checkout 個 submodule，正正 被前者禁死。一個測試永久封住另一個測試唯一嘅出路，仲衰過冇測試。" },
      { category: "changed", text: "而家改成「一定要寫明」，唔係「一定要係 false」。本來要防嘅係「唔記得寫」—— 咁就變成 由一個冇人睇過嘅預設值話事。想改成 true 係一個要負責任嘅取捨（跑得慢啲，換真實嘅 覆蓋率），呢個決定應該係改嗰個人做，唔係由一句 assert 幫佢做咗。" },
    ],
  },
  {
    id: "49dab33", kind: 'commit', ref: "49dab33", oid: "49dab338d1a3664e5adea5f0e8701df753de03bb", date: "2026-08-02",
    title: "Record a handoff that finally has real test numbers in it",
    changes: [
      { category: "changed", text: "The Tests row has said \"not run in this regeneration\" for four commits, because tools/handoff.js runs the suite itself and had no --test-timeout — so the only way to make it finish was --skip-tests, and the document whose whole premise is that it \"cannot flatter the state of the work\" quietly left its most important row blank." },
      { category: "fixed", text: "It now reads: 2903 run, 2902 pass, 0 fail, 1 skipped. Verified across four consecutive full runs on Node 26 and one on the Node 22 that CI pins, after the flaky ssh2 key generation was fixed — the number is stable, not a lucky sample." },
      { category: "fixed", text: "The hand-written sections were empty and now carry what a successor actually needs: run fix-node26-deps.js AFTER npm install and never before; check both Node majors because three defects this session lived on only one of them, in both directions; and the two release-loop decisions that belong to the maintainer rather than to whoever picks this up next." },
      { category: "changed", text: "The roadmap gets the lesson rather than the numbers: reachability is the bar. The transfer engine had channels, a byte mover and passing tests, and no renderer code called any of it — done from every angle except a user's. A setting that is stored, mapped and rendered is not a setting that works, and eight more are still in that state with no row warning anyone." },
    ],
    changesYue: [
      { category: "changed", text: "份 handoff 一連四個 commit 都寫住「今次冇跑測試」，因為佢自己跑測試但冇 timeout, 唯一跑得完嘅方法就係 --skip-tests —— 一份成篇強調自己「唔識講大話」嘅文件，最緊要 嗰行係空白嘅。" },
      { category: "changed", text: "而家有真數：2903 跑，2902 過，0 衰。而且係修好 ssh2 嗰個唔穩定嘅 key 之後，連跑 四次 Node 26 加一次 Node 22 都一樣，唔係撞彩。" },
      { category: "changed", text: "Roadmap 記低嘅唔係數字，係教訓：**能唔能夠行到先係標準**。個 transfer engine 有 channel、有 byte mover、測試全過，但 renderer 由頭到尾冇叫過 —— 除咗用戶之外，喺 邊個角度睇都似做完咗。" },
    ],
  },
  {
    id: "6050d27", kind: 'commit', ref: "6050d27", oid: "6050d278e30c49b916e605ffa8cbcc671a4f650e", date: "2026-08-02",
    title: "Stop ssh2 handing us a key its own parser rejects, roughly once in 350",
    changes: [
      { category: "changed", text: "The SFTP end-to-end file failed intermittently with" },
      { category: "changed", text: "TypeError: parsedHostKey.getPublicSSH is not a function" },
      { category: "fixed", text: "taking 9 tests down and cancelling 43 more. It passed 3/3 when run alone, which is the worst possible shape for a flake: every red full run looked like a real regression in whatever had just changed." },
      { category: "changed", text: "It is neither. ssh2's own generator and its own parser disagree — utils.parseKey(utils.generateKeyPairSync('ed25519').private) returns `Error: Malformed OpenSSH private key` instead of a key. Measured on ssh2 1.17.0:" },
      { category: "changed", text: "3 / 1000 pairs (0.3%)" },
      { category: "fixed", text: "Small enough to look like nothing, except the suite generates six ed25519 pairs per run, so about one full run in fifty died — and `getPublicSSH is not a function` reads like a broken helper rather than a bad key, which is where the time goes." },
      { category: "fixed", text: "Every generation now goes through one validating helper that regenerates until the key round-trips. Bounded at 8 attempts: an unbounded retry against a genuinely broken generator is a hang rather than a failure, and this suite has already lost an afternoon to one of those. A passphrase-protected pair checks its public half, since the private one cannot be parsed without the passphrase." },
      { category: "changed", text: "before: 3 / 1000 unparsable after: 0 / 2000" },
      { category: "changed", text: "Correcting the previous commit's evidence while I am here: \"2903 pass, 0 fail on both runtimes\" was true of the runs quoted and did not mention that a repeat run went red. The suite was flaky then and is not now; the number was right and the confidence was not." },
    ],
    changesYue: [
      { category: "changed", text: "ssh2 自己生嘅 key，自己個 parser 唔認得 —— 大約 350 次一次。一次得 0.3%，睇落當 冇嘢，但成套跑會生六條，即係大約五十次全跑就有一次爆。最陰功係佢單獨跑三次都 乜事都冇：即係每次紅都好似你啱啱改壞咗嘢咁，其實同你完全冇關。" },
      { category: "changed", text: "而家全部經一個會驗返轉頭嘅產生器，唔啱就重生，最多試八次 —— 唔封頂嘅重試遇著真 係壞咗嘅產生器就唔係「衰咗」，係「吊死」，而呢套嘢今日已經俾人吊過一次。" },
      { category: "changed", text: "順便更正上一個 commit：嗰句「兩個 runtime 都 2902 過 0 衰」係真嘅，但冇講跟住再 跑一次就紅咗。個數字冇錯，個信心錯咗。" },
    ],
  },
  {
    id: "90759dc", kind: 'commit', ref: "90759dc", oid: "90759dc54376f8c97569b4f9f7ed07e24bb28971", date: "2026-08-02",
    title: "Stop winscp.com exiting mid-prompt, and stop the preferences guard lying in reverse",
    changes: [
      { category: "changed", text: "Two defects the wave's completeness critic found in what the wave itself had just landed. Both were verified by reproduction, not by reading." },
      { category: "added", text: "THE SHIPPED CONSOLE HOST STILL EXITED SILENTLY. Fixing the unref'd prompt timer in design/main/console.js left the identical shape one file over, in consolerunner.js — which IS the process winscp.com runs (console.js:1668 spawns runConsole from here). So the version a user actually meets still had it. Worse than its sibling: that one only misbehaved on the Node CI pins, while this reproduced on EVERY runtime, because StdConsole.input's timer is the last ref'd handle rather than merely a fragile one." },
      { category: "changed", text: "before: EXIT settled=false after 0 ms, code 0 (both Node 22 and 26) after: RESOLVED null after 305 ms" },
      { category: "changed", text: "A script host that vanishes at code 0 with a prompt unanswered is worse than one that crashes: the caller sees success. keepuptodate had the same unref on the only tick keeping it alive between filesystem events, so it ended the command whenever nothing happened to be changing — the state it exists to sit in." },
      { category: "changed", text: "THE PENDING-OPTIONS GUARD WAS LYING IN THE OTHER DIRECTION. Its scan required the leaf NOT be preceded by a dot, and a consumer almost never writes the dotted path — it holds the sub-object and reads cp.excludeEmptyDirectories, p.showOnStartup, this.prefs().maxEditors. All three were invisible to it, so the dialog told users that \"Exclude empty directories\", \"Show update information on startup\" and \"Maximum editors\" do nothing, while all three were honoured. A guard built to stop the app lying about its own settings had been producing that exact lie, inverted, and its test passed the whole time." },
      { category: "fixed", text: "Removing the option's key from PENDING_KEYS was also required by this wave: the empty-directories fix gave it a second consumer, which turned the guard red — the one thing that would have stopped the merge from going green." },
      { category: "fixed", text: "2903 tests, 2902 pass, 0 fail, 1 skipped — on Node 26 AND on the Node 22 CI pins. Both new console tests fail without the fix; e2e-sftp verified stable 3/3 alone." },
    ],
    changesYue: [
      { category: "changed", text: "兩個都係「查漏」agent 喺呢一浪自己啱啱落嘅嘢入面執返出嚟嘅，而且係試出嚟唔係睇出嚟。" },
      { category: "changed", text: "**個真正會出街嘅 console host 仲係會靜靜雞死。** console.js 修好咗，隔籬 consolerunner.js 一模一樣嘅寫法冇人郁 —— 而嗰個先係 winscp.com 真正行嘅程序。仲 衰過隔籬嗰個：隔籬淨係喺 CI 嗰個 Node 版本先中，呢個**每個版本都中**。一個 code 0 就消失、提示都未答嘅腳本主機，衰過直接 crash —— 起碼 crash 會話你知。" },
      { category: "changed", text: "**個「未接線設定」守門員反方向講大話。** 佢要求個名前面唔可以有點，但實際讀嘅人 邊會寫成條路徑，梗係 `cp.xxx`、`p.xxx` 咁攞。結果三個真係有人用嘅設定被當成冇人 理，個對話框就同用戶講「呢個掣暫時冇用」—— 一個專登用嚟防止 app 講大話嘅機制， 自己反過來講咗同一個大話，而且個測試一路都係綠嘅。" },
      { category: "changed", text: "2903 個測試，2902 過，0 衰 —— Node 26 同 CI 用嗰個 Node 22 都一樣。" },
    ],
  },
  {
    id: "3b3b14c", kind: 'commit', ref: "3b3b14c", oid: "3b3b14c7a03907ffd9f6eef165c45666acfc3531", date: "2026-08-02",
    title: "Prune empty directories with the target adapter's separator, and teach the engine the rule at all",
    changes: [
      { category: "changed", text: "`excludeEmptyDirectories` had two independent defects, one of which destroyed whole downloads on Windows." },
      { category: "changed", text: "**The queue destroyed the download it was pruning.** queue.js `_buildPlan` kept a directory entry only if some file's `dstPath` started with `dir + '/'`. Every `dstPath` in a plan is built by the TARGET adapter's `join`, and the target of a download is `protocols/local.js`, whose separator is `\\` on Windows. So the test was false for every directory in the plan — not just the empty ones, the ones packed with files too — and every `kind:'dir'` entry was pruned. `_run` only `mkdir`s from `kind:'dir'` entries and no adapter's `createWriteStream` creates parents, so the first file then died with `ENOENT` and the whole item failed. Uploads never noticed, because a remote adapter genuinely is '/'-separated. The prefix now comes from `dst.sep`, which every adapter already publishes (base.js:74, local.js:239), with the trailing separator kept so `/a/b` still does not swallow `/a/bc` and a path already ending in one does not grow a second." },
      { category: "added", text: "**The engine ignored the option entirely.** transfer.js mentioned `excludeEmptyDirectories` in exactly one place — `allowAnyTransfer`, the \"is any filtering switched on at all?\" gate — so turning it on made the engine take the slow filtered path and then apply no filter. `doAllowFileTransfer` now ends with the `IsEmptyDirectory` clause the original has (Terminal.cpp:5791/5806), backed by a new `isEmptyDirectory()`: recursive, so a directory of empty directories is empty; filter-aware, so a directory of masked-out or hidden files is empty; `csStopOnFirstFile`, so a directory whose first entry is a file costs one listing; and answering \"not empty\" when the listing fails, because dropping a directory nobody could read is worse than creating one nobody wanted. The predicate is async now, so `allowLocalFileTransfer`, `sink` and `calculateLocalFilesSize` await it — which is also what keeps the local size total agreeing with what the copy will actually do." },
      { category: "changed", text: "The `.filepart` asymmetry between the two sides is WinSCP's, not a slip: IsEmptyLocalDirectory hard-codes the temporary-file rule on (6199) and IsEmptyRemoteDirectory passes the caller's flag through (6441). Copied as is, with the line numbers, rather than quietly tidied into something that would skip a directory the original uploads." },
      { category: "fixed", text: "Tests: the download case is the one that matters, because an upload-only test would have passed against the queue bug all day. queue.test.js grows a backslash-separated in-memory adapter so that case stays alive on a POSIX dev box, where a real LocalAdapter reports '/' and the bug cannot appear at all. docs/protocol-gaps.md said the option \"does nothing\", which stopped being true when the queue implemented it and never mentioned that the implementation ate Windows downloads; it now records what is actually true, including the one part still missing (the remote size calculation)." },
    ],
    changesYue: [
      { category: "changed", text: "一個 `/` 引發嘅血案。個 queue 淨低空目錄嘅時候，硬係用 `/` 去比對路徑 —— 但 下載嘅目的地係 Windows 本機，人哋分隔符係 `\\`，於是「呢個目錄有冇檔案？」永遠 答「冇」，連塞爆檔案嗰啲都照斬。斬晒之後冇人開資料夾，第一個檔案即刻 ENOENT 仆街，成單嘢玩完。而家改成問目的地 adapter 自己個 `sep`，佢一路都識答，只係 之前冇人問過佢。" },
      { category: "changed", text: "引擎嗰邊更加離譜：`excludeEmptyDirectories` 全個 transfer.js 只出現喺 `allowAnyTransfer` 入面 —— 即係「有冇開過濾器呀？」嗰道閘。你一開佢，引擎就 好勤力咁行慢路，然後乜都唔篩。而家補返 WinSCP 原本嗰個 IsEmptyDirectory： 會遞歸（空目錄裝住空目錄，一樣係空）、識睇 mask 同隱藏檔、見到第一個檔案就 收手、開唔到就當「唔空」—— 寧願多開個冇人要嘅資料夾，都好過靜靜雞漏低成個 目錄。" },
      { category: "changed", text: "測試特登由下載入手：淨測上載嘅話，個 bug 可以繼續瞓大覺。" },
    ],
  },
  {
    id: "8e75cb2", kind: 'commit', ref: "8e75cb2", oid: "8e75cb216a77e6f97c4e8a9da85879c3256029f4", date: "2026-08-02",
    title: "Impose the FTP reconnect budget tfUseFileTransferAny was always meant to set",
    changes: [
      { category: "changed", text: "TRANSFER_FLAGS.useFileTransferAny was declared, read in two places, and ORed in by absolutely nobody. The upload flag producer returned preCreateDir or 0, both download call sites passed a literal 0, so `trackTransfer` was false for every transfer ever made and the reset branch in RobustLoop was dead code reachable only by reading it." },
      { category: "removed", text: "The consequence was the opposite of what the gap list claimed. Read TRobustOperationLoop::TryReopen (Terminal.cpp:538-559) with the braces in view: the progress-based reset AND the ContinueReopen(FStart) call that IS the budget both sit inside `if (FAnyTransfer != NULL)`. Clearing the flag does not tighten the ceiling, it removes the ceiling. So this port was strictly more permissive than WinSCP: an FTP transfer that dropped every ten seconds without moving a single byte would reconnect politely, forever, like a dog that has decided the closed door is a negotiation. WinSCP gives up after SessionReopenTimeout and says so out loud. docs/protocol-gaps.md:229 asserted the reverse and has been corrected rather than quietly deleted." },
      { category: "added", text: "transferFlags() and a new downloadFlags() now set the bit for FTP and FTPS only - FtpFileSystem.cpp:1585 and :1682, the FTP back end's two transfer entry points and nothing else, which is why SFTP keeps retrying indefinitely upstream and keeps doing so here. caps.limitTransferReconnects overrides the protocol test. RobustLoop's third argument is now a holder object rather than a boolean, because the C++ takes a `bool *` and WHICH bool it points at is the entire design: null for no budget, the terminal for a budget the progress callback can reset, a throwaway object for a budget nothing can reset." },
      { category: "changed", text: "Two fidelity defects fell out while wiring it. customReadDirectory was pointing its loop at the terminal-wide flag, so a directory that could not be listed got a fresh retry window every time some unrelated download managed a chunk - WinSCP uses a function-local that nothing ever sets (Terminal.cpp:3760), which is how \"we limit it unconditionally\" was meant to read. And the reset arm never set FPrevAnyTransfer (Terminal.cpp:546), so a loop that watched bytes go by would cheerfully report to the enclosing scope that nothing had happened. RobustLoop also stamped its start from Date.now() while ContinueReopen compared against the terminal's injectable clock; harmless in production where they are the same function, fatal to anyone trying to test a timeout without waiting for one." },
      { category: "changed", text: "一句話：TRANSFER_FLAGS.useFileTransferAny 呢個旗，聲明咗、讀咗兩次、就係冇人" },
    ],
    changesYue: [
      { category: "changed", text: "set 過。個 reset 分支等咗成世，等到自己變成註解。" },
      { category: "changed", text: "更搞笑係方向搞錯咗。C++ 入面「重試預算」同「重設預算」兩隻手都喺同一個 `if (FAnyTransfer != NULL)` 裏面，即係唔 set 旗唔係扣預算，係根本冇預算。所以 我哋以前係比 WinSCP 更加癡情：FTP 一路斷線一路零 byte，佢照樣重連到天光，重連 到你老咗，重連到隻 socket 都覺得尷尬。原裝 WinSCP 過咗 SessionReopenTimeout 就講一聲「唔試喇」然後收工。文件仲要寫反轉咗，一併改返。" },
      { category: "changed", text: "另外執埋兩單。列目錄嗰個 loop 之前掛住成個 terminal 嘅旗，即係隔籬有人下載到 幾個 byte，呢邊讀唔到嘅資料夾就當自己有得再嚟一鑊 —— WinSCP 用嘅係一個永遠冇 人 set 嘅 local 變數，咁先叫「無條件設上限」。仲有 reset 嗰陣冇寫返 FPrevAnyTransfer，搞到明明見住啲 byte 飛過，出返去就話「乜都冇發生過」。順手 令個 loop 同 ContinueReopen 睇返同一個鐘，唔係一個睇 Date.now() 一個睇注入嘅 時鐘，否則寫個逾時測試就要真係等足五秒。" },
      { category: "changed", text: "Tests: test/terminal.test.js 96 -> 100, test/transfer.test.js 77 -> 80. Six of the seven new cases fail against the unmodified source; the seventh (\"a robust loop with no flag has no reconnect budget at all\") passes either way and is named here as the inert guard it is - it exists so a future change that hands every protocol a budget cannot land quietly." },
    ],
  },
  {
    id: "bc6fbed", kind: 'commit', ref: "bc6fbed", oid: "bc6fbed98d6b6378fb2bcaa9af08cadfe8119b92", date: "2026-08-02",
    title: "Stop the queue's resume from deleting the symlink it was told to upload over",
    changes: [
      { category: "changed", text: "TSFTPFileSystem::Source refuses the resumable route for an existing target of two kinds (SftpFileSystem.cpp:4674-4700): a symbolic link, and a file owned by another user. Neither survives being recreated, and resuming does not overwrite in place — it fills `<name>.filepart`, removes the target and renames the part onto the name." },
      { category: "removed", text: "transfer.js's source() enforced both arms. queue.js's `_copyBytes` performs the same delete-and-rename and carried only the ownership half, so uploading over a symbolic link through the queue — the route a click in the UI actually takes — removed the link, dropped an ordinary file where it had been, and left whatever it pointed at untouched. The bytes landed at the right path and read back correctly, which is precisely why nobody noticed the link was gone. The ownership guard next door had the opposite problem: it worked, silently, so a transfer that stopped resuming looked like a slow server rather than a decision." },
      { category: "changed", text: "Both copies of the rule now live in one place, transfer.js's `resumeRefusalReason`, which answers with WinSCP's own log line or '' — the reason being the useful part. WinSCP's middle arm, DoesFileLookLikeSymLink, is deliberately left out and the omission is documented on the function: it guesses \"0777 and under 100 bytes\" because SFTP-3's attribute block will not say whether a file is a link, and protocols/sftp.js:1325-1327 lstats and reads the type straight out of the mode bits. Guessing on top of a fact only costs real tiny files their resume, and its `FVersion < 4` gate means nothing in a function that also serves FTP, WebDAV and S3." },
      { category: "fixed", text: "The uid-is-not-a-name gate stays exactly where it was and is now pinned from both sides, because getting it wrong is worse than the bug: ssh2 asks for SFTP-3, sftp.js hands over String(uid), and reading \"1000\" as a person called 1000 would switch resumable uploads off on every SFTP server on earth." },
      { category: "added", text: "test/queue.test.js 39 pass 2 fail -> 41 pass 0 fail; the two new gates are the symlink refusal and the ownership refusal's missing log line. test/transfer.js 77 -> 78 pass, the new one covering the symlink arm that this commit moved into shared code and that no test had ever asserted." },
    ],
    changesYue: [
      { category: "changed", text: "—— 廣東話版 ——" },
      { category: "changed", text: "「見到 symlink 都照劈」——隊列版上載嘅真實死法" },
      { category: "changed", text: "WinSCP 好耐之前就寫低：目標係 symlink，或者係人哋嘅檔案，就唔好 resume，因為 resume 唔係原地覆寫，係寫 .filepart、remove、rename 一條龍,直情連檔案都重新開過。" },
      { category: "changed", text: "transfer.js 兩樣都識驚。但 queue.js 個 `_copyBytes` 只係抄咗「人哋嘅檔案」嗰半， 撞正 symlink 照劈 —— 條捷徑冇咗，變成一個普通檔案，佢本來指住嗰份嘢一條毛都冇 郁。最陰功係 bytes 真係落咗正確位置，讀返出嚟仲要係啱嘅，所以完全睇唔出條 link 已經升天。隔籬個 owner 守衛就啱啱相反：佢做緊嘢，但一聲都唔出，用家只會以為部 server 今日食咗懶惰藥。" },
      { category: "changed", text: "而家兩邊共用同一個 `resumeRefusalReason`，唔准 resume 就照 WinSCP 原文寫落 log， 唔准都要講聲點解。至於 WinSCP 中間嗰條 DoesFileLookLikeSymLink（0777 又細過 100 bytes 就當你係 symlink），我哋唔抄，而且喺 function 上面寫明點解唔抄：人哋要靠估 係因為 SFTP-3 死都唔肯講；我哋 protocols/sftp.js 一個 lstat 就睇到 mode bits。 明明知道答案仲要摸估，最後淨係累到啲真係細過 100 bytes 嘅檔案冇得 resume。" },
      { category: "changed", text: "至於「uid 唔係人名」嗰道閘，原封不動，仲要兩邊都加測試釘實佢：ssh2 講 SFTP-3， sftp.js 交出嚟嘅係 String(uid)，如果當「1000」係一個叫 1000 嘅人，全世界 SFTP server 嘅 resume 就一齊收工 —— 嗰個先真係大鑊過原本個 bug。" },
    ],
  },
  {
    id: "1c7bbce", kind: 'commit', ref: "1c7bbce", oid: "1c7bbce075e1350011e59224d0ba308609adfa5f", date: "2026-08-02",
    title: "Give CI's checkouts full history so changelog shas can resolve",
    changes: [
      { category: "changed", text: "test/changelog.test.js resolves every changelog entry's commit against the repository with `git cat-file`, and it failed on CI while passing on every developer's machine — the worst shape a failure can take, because the machine whose output anyone actually reads was the only one disagreeing." },
      { category: "changed", text: "Cause: actions/checkout defaults to `fetch-depth: 1`. Both jobs in ci.yml (lines 59-64 and 84-87) took that default, so CI cloned exactly the commit that triggered the run and nothing before it. All nineteen referenced shas reach further back than that, so the very first one lost the argument and the suite went red. Reproduced exactly: a `git clone --depth=1` of this repository fails with the identical message, byte for byte, while a full clone passes 41/41. The existing skip guard cannot help and should not — it fires only when the tree is not a git checkout at all, and a shallow clone very much is one." },
      { category: "fixed", text: "Fix: `fetch-depth: 0` on both checkouts. Zero rather than a fixed number on purpose — the changelog reaches one commit further back with every entry added, so any finite depth works right up until the day it silently does not. It does not drag in vendor/winscp: fetch-depth and submodules are independent inputs and `submodules: false` still stands, so full history costs 2 MB here (22 MB against 20 MB shallow), not 300k lines of borrowed C++." },
      { category: "fixed", text: "The release job gets it too, and that half is deliberate rather than copy-paste. Nothing it runs today reads history — make-icon.js, pick-codename.js and release-notes.js do not spawn git once between them. But release notes are meant to report per-line authorship, and `git blame` on a shallow clone does not have the decency to fail: it exits 0 and cheerfully credits every line of every file to the one grafted boundary commit. README.md blames to three commits with history and to exactly one without, with a smile and a zero exit code. Better to fix the checkout before the counter arrives than to publish a confidently wrong number to a page nobody re-runs." },
      { category: "fixed", text: "The obvious wrong fix was skipping the sha check when the clone is shallow, which would make the one assertion guarding against dead changelog links permanently green in the only place it ever runs. So a guard keeps the YAML honest instead: it counts checkouts against fetch-depth lines, so a third job added later without history fails loudly, and it rejects a fixed depth by name." },
    ],
    changesYue: [
      { category: "changed", text: "--- 廣東話 ---" },
      { category: "changed", text: "CI 一路紅，個個機都綠。原來 actions/checkout 唔講就預設 `fetch-depth: 1` — 淨係 clone 咗觸發嗰個 commit，之前嘅歷史一律當冇。changelog 十九個 sha 全部 喺更早嘅位，`git cat-file` 梗係搵唔到，第一個就仆街。" },
      { category: "changed", text: "改 `fetch-depth: 0`。唔寫死數字，因為 changelog 每加一條就伸長少少，寫 50 今日夠用，聽日就靜靜雞唔夠 —— 呢種先至最恐怖。順帶一提，`submodules: false` 照舊，vendor/winscp 嗰三十萬行 C++ 唔會跟埋入嚟，多咗歷史都係貴 2MB 咋。" },
      { category: "changed", text: "release job 都一齊改。今日佢真係一次 git 都冇 call 過，但 release notes 遲早要用 `git blame` 數邊行邊個寫。而 `git blame` 喺 shallow clone 唔會報錯, 佢會笑住 exit 0，然後話你知全世界每一行都係同一個 commit 寫嘅 —— README.md 有歷史數到三個 commit，冇歷史就淨返一個，數字錯得好有自信。" },
      { category: "changed", text: "最誘人嗰個錯誤修法係：見到 shallow 就 skip 個 sha 檢查。咁做等於叫唯一會跑 呢個 test 嘅機器永遠開綠燈,個 test 就變咗擺設。所以寧願補返歷史，再加個 guard 守住段 YAML：數 checkout 對唔對得上 fetch-depth，將來多開一個 job 唔記得寫就 即刻嘈,寫死數字都照踢。" },
    ],
  },
  {
    id: "334c993", kind: 'commit', ref: "334c993", oid: "334c99359968cdb4e487d3d8accf995ff43b2338", date: "2026-08-02",
    title: "Stop the resource extractor exiting the test process that called it",
    changes: [
      { category: "changed", text: "CI reported test/messages.test.js as a file-level failure at messages.test.js:1:1 with no detail beyond \"test failed\", and the suspicion was that a sibling file had poisoned it. It had not. The failure is real, deterministic, and reproduces with messages.test.js as the ONLY file in the run — no console.test.js anywhere near it." },
      { category: "changed", text: "tools/extract-resources.js readSource() called process.exit(1) when vendor/winscp was missing. That is fine in a command line and fatal in a library: test/messages.test.js calls build(), .github/workflows/ci.yml checks out with `submodules: false`, and so the extractor shot the test runner halfway through reporting. node --test had no test left to blame, so it invented a file-level entry, and every assertion that had already passed died with the process — 45 tests collapse to `# tests 1 # fail 1`. The one line naming the missing file went to stderr, where the TAP reader renders it as a comment that looks like it belongs to something else entirely." },
      { category: "changed", text: "readSource() now throws an ENOVENDOR error carrying the path and the remedy; the `require.main === module` boundary catches it and reproduces the old message and the old exit code exactly, because there exiting IS the right answer. The two tests that genuinely need the submodule declare `{ skip }` with the reason, so CI prints why it stood down instead of dying, and the directory-listing assertion was split out of the table arithmetic so the arithmetic keeps running everywhere." },
      { category: "fixed", text: "Measured on Node 22.23.2 with vendor absent, which is CI's condition: before # tests 1 # pass 0 # fail 1 after # tests 45 # pass 43 # fail 0 # skipped 2 With vendor present: 45 pass on both Node 22.23.2 and Node 26.5.1. The new test fails without the fix in the loudest way available — the process dies inside assert.throws and the file reports `# tests 1 # fail 1`, the exact signature CI was showing." },
      { category: "changed", text: "While in there: node --test gives every test FILE its own process (proven with a pid probe on both runtimes) and runs them concurrently, so cross-file process-state interference is not possible in this suite at all. The two channels that ARE shared are the filesystem and the port space, and both are already clean: every scratch directory is mkdtemp, every server is listen(0), and test/helpers/ftp-server.js even replaces ftp-srv's passive-port walker for exactly that reason." },
      { category: "changed", text: "---" },
    ],
    changesYue: [
      { category: "changed", text: "個 library 開槍打死咗叫佢嘅測試程序，仲要死得無聲無息" },
      { category: "changed", text: "CI 話 test/messages.test.js 喺第一行就爆咗，成份報告得「test failed」四個字， 大家仲以為係隔籬個檔案累佢。冤枉。佢自己一個行都一樣爆，關人哋乜事。" },
      { category: "changed", text: "tools/extract-resources.js 嘅 readSource() 見唔到 vendor/winscp 就直接 process.exit(1)。做命令行冇問題，做 library 就係謀殺：測試檔案叫 build()， CI 又 `submodules: false`，於是個 extractor 喺測試機報緊成績嗰陣一槍拉埋佢。 node --test 搵唔到兇手，唯有寫一句「呢個檔案死咗」交數，45 個測試齊齊陪葬， 淨返 `# tests 1 # fail 1`。真正嗰句「邊個檔案唔見咗」就飄咗去 stderr， 喺 TAP 度睇落似係隔籬張單嘅註腳。" },
      { category: "changed", text: "而家 readSource() 掟 ENOVENDOR，錯誤訊息連路徑同解決方法一齊帶走； 真係命令行嗰個入口先接住佢，原汁原味吐返舊嗰句同舊嗰個 exit code—— 喺嗰度死係啱嘅。兩個真係要 submodule 嘅測試改成 `{ skip }` 兼寫明原因， CI 而家識講「我點解唔行」；順手將讀資料夾嗰句同數數目嗰啲拆開， 數數目嗰啲邊部機都照行。" },
      { category: "changed", text: "Node 22.23.2、冇 vendor（即係 CI 嗰個世界）： 改之前 # tests 1 # pass 0 # fail 1 改之後 # tests 45 # pass 43 # fail 0 # skipped 2 有 vendor 嘅話：Node 22.23.2 同 Node 26.5.1 都係 45 全中。 新測試冇改動一定死，死法同 CI 一模一樣——喺 assert.throws 入面成個 process 冇咗，個檔案報 `# tests 1 # fail 1`。" },
      { category: "changed", text: "順帶查埋：node --test 每個測試檔案都自己一個 process（用 pid 探針喺兩個 runtime 都證實過），仲要一齊跑，所以呢個 suite 根本冇可能靠 process 狀態 互相干擾。真係共用嘅得檔案系統同 port，兩樣都已經好乾淨：所有臨時資料夾 都係 mkdtemp，所有 server 都 listen(0)，test/helpers/ftp-server.js 連 ftp-srv 自己嗰個 passive port 掃描器都換咗，理由一模一樣。" },
    ],
  },
  {
    id: "168fac5", kind: 'commit', ref: "168fac5", oid: "168fac564745760ba407686a7eb31ee4e212bca6", date: "2026-08-02",
    title: "Keep the prompt timers ref'd, so a waiting prompt cannot quietly exit instead",
    changes: [
      { category: "changed", text: "Three timers in the console front-end were `unref()`ed: the idle timer in `KeySource.readKey` (Input()'s timer thread), the `Sleep(Timer)` a timeouting Choice does on redirected input, and the send watchdog in `CommChannel.send`. Each is the *only* other thing that can settle the promise its caller is awaiting — the alternative being a keypress that, by the definition of a timeout, is not coming. Unref'ing a timer tells Node \"do not stay alive for this\", so the front-end sat there owing ProcessInputEvent an answer while the event loop drained out from under it, and the process left. Not hung, not failed — gone, status 0, nothing on stderr. `winscp.com` got as far as \"wait five seconds, then take the timeout answer\" and took the fifth second off permanently." },
      { category: "changed", text: "They are real timers now, and each is cleared the moment the other side wins, which is the job unref had been press-ganged into doing: readKey never cleared its timer after the key that answered it, so a ref'd 60-second prompt timer would have held the process open for 59 seconds after the user pressed Enter. The timed-out waiter is spliced out too — Choice polls readKey every 50 ms while a prompt sits untouched, and the old code pushed a closure per poll and never took one back." },
      { category: "added", text: "The same anti-pattern appears five times in the test file, which is why nobody noticed. Its `await new Promise(r => setTimeout(r, 30).unref())` sleeps are the same unresolvable wait, so on Node 22 the runner did exactly what it should: `cancelledByParent: Promise resolution is still pending but the event loop has already resolved`, and everything after the first offender was cancelled with it. Node 26 keeps a ref'd handle alive for the run and papers the whole thing over. So the file read 118/118 on Node 26 and 57 pass / 61 cancelled on the Node 22 that CI pins: a suite reporting zero failures while quietly declining to sit half the exam." },
      { category: "changed", text: "Counts, per runtime:" },
      { category: "changed", text: "Node 22.23.2 before 118 tests, 57 pass, 0 fail, 61 cancelled Node 22.23.2 after 121 tests, 121 pass, 0 fail, 0 cancelled Node 26.5.1 before 118 tests, 118 pass, 0 fail, 0 cancelled Node 26.5.1 after 121 tests, 121 pass, 0 fail, 0 cancelled" },
      { category: "changed", text: "The product half alone takes Node 22 from 57 to 73 passing; the harness half carries the rest. test/script.test.js, the other consumer of this module, is 192/192 on both." },
      { category: "fixed", text: "Three new tests guard the product fix on *both* majors, because a regression test that only fires on one of them is precisely how this shipped. They run the real module in a bare `node -e` child where nothing else is on the loop, which is the honest question anyway: would the shipped binary still be alive to take this branch? All three fail on Node 26 with the module reverted and pass with it." },
      { category: "changed", text: "三個計時器俾人 `unref()` 咗:等鍵盤嗰個、redirected input 度 Choice 瞓嗰陣、" },
    ],
    changesYue: [
      { category: "changed", text: "同埋等 front-end 覆機嗰個看門狗。`unref()` 即係同 Node 講「唔使為咗我留低」, 於是個 prompt 一路等緊人答,event loop 喺佢腳下面收晒工,成個 process 就咁走咗。 唔係卡死,唔係報錯,係唔見咗,仲要 exit code 0,乜都冇出。明明講到明「等五秒 然後自動答」,點知第五秒佢自己請咗假。" },
      { category: "changed", text: "而家係真計時器,而且邊邊贏都即刻 clear 返另一邊 —— 呢樣先係 unref 想做但做錯咗 嘅嘢:以前答完個掣都唔 clear,所以一個 60 秒 timeout 嘅 prompt,user 撳完 Enter 之後個 process 仲要企多 59 秒。timeout 咗嗰個 waiter 都撠返出嚟:Choice 每 50 毫秒 poll 一次,舊 code 一 poll 就塞個 closure 入去,從來冇攞返。" },
      { category: "changed", text: "測試檔一樣衰同一味,五次,亦即係點解冇人發現。Node 22 老老實實話你聽「個 promise 仲未有結果,但 event loop 已經完咗」,跟住成堆測試全部 cancel;Node 26 自己留住 個 handle,幫佢冚咗。同一個檔案:Node 26 118/118 全綠,CI 揀嗰個 Node 22 得 57 條 真係考過 —— 零個 fail,一半冇入過試場。" },
      { category: "changed", text: "新加三條測試喺兩個版本都守得住,喺乾淨嘅 child process 度跑真 module:個 binary 到時仲活唔活得到嚟答呢一句?呢條先係真問題。" },
    ],
  },
  {
    id: "00d661d", kind: 'commit', ref: "00d661d", oid: "00d661dd697eae9b5d837d84e175d9e502411ac4", date: "2026-08-02",
    title: "Refresh the sanitized instruction mirror, which had drifted fourteen sections behind",
    changes: [
      { category: "changed", text: "Every project keeps a sanitized copy of the shared agent instructions in README.md and AGENTS.md so anyone working here sees the rules without access to the canonical repository. The copy had gone stale: fourteen sections existed upstream and in neither mirror." },
      { category: "changed", text: "Missing entirely: the scoping rule that every instruction applies to every surface individually; destructive-action super confirmation; the release line-count contract and its \"agents never count lines by hand\" corollary; export-everything; bulk actions; the command palette; overlays painting their own surface; context menus showing their shortcuts; long operations reporting progress where they were started; recovering from a failed operation; provider-authored text being rendered rather than printed; publishing to a forge; collapsible filters; delegated task sessions; and the scope rule that says a project-local file may narrow these but may not silently disable them." },
      { category: "changed", text: "That last omission is the one that stings. A mirror missing the rule about what to do when local instructions conflict is a mirror that quietly answers the question by being incomplete." },
      { category: "changed", text: "Verified: all eighteen checked sections now present, and a grep for the private working vocabulary across both files returns nothing — that vocabulary is conversation-only and never belongs in a public repository, which is exactly the kind of thing a mechanical mirror leaks. AGENTS.md 847 -> 1163 lines, README.md +117." },
      { category: "changed", text: "Also ignoring .claude/worktrees/. Parallel agents each get a linked worktree there, and committing one would commit a second copy of the entire tree." },
    ],
    changesYue: [
      { category: "changed", text: "份「淨化版」指示鏡像落後咗十四節。最核心嗰條 —— 「本地指示可以更嚴，但唔可以靜 雞雞廢咗全域規則，撞到就要停低講」—— 竟然係冇抄到嗰批入面。一份連「撞規矩點算」 都冇抄到嘅鏡像，其實已經用「唔齊」變相答咗你。" },
      { category: "changed", text: "順手 grep 過兩個檔案，確認冇漏任何私人用語出去 —— 嗰啲字係傾偈先用，永遠唔應該 出現喺公開 repo，而機械式抄鏡像正正就係會漏呢啲嘢。仲有 .claude/worktrees/ 要 ignore，唔係就會 commit 多一份成個 tree。" },
    ],
  },
  {
    id: "80e7814", kind: 'commit', ref: "80e7814", oid: "80e781447b762009faeafb2fedac4e386cd8c179", date: "2026-08-02",
    title: "Reach the foreground transfer engine from the UI, and honour the recycle bin on overwrite",
    changes: [
      { category: "changed", text: "Two gaps closed, both verified against the real SFTP harness." },
      { category: "added", text: "REACHABILITY. Commit 41becd9 said the transfer engine was unreachable because \"no ipc.js channel exists (grep: zero hits)\" and the byte mover was never supplied. Both halves were false when written: the channels landed in 74a92c6, the commit immediately before, and ipc.js:623 has always passed copyBytes. What was actually missing sat one hop further out — nothing in the RENDERER ever called them. All sixteen transfer actions ended at queue:add, including the four *CopyNonQueueAction entries, which in WinSCP are precisely the foreground CopyToRemote path (NonVisual.cpp:566 -> CustomScpExplorer.cpp:3181 Param.Queue = asOff -> :1337 -> :2858)." },
      { category: "added", text: "The TRANSFERS table now carries WinSCP's asAuto/asOn/asOff, and queueTransfer branches to the engine on 'off'. Threading that through commands.js alone would have changed nothing a user can see: wiring.js:387 registers a dialog override for all sixteen actions, and THAT is what runs in the app — the unit test would have passed while the product ignored it." },
      { category: "changed", text: "Two defects found on the way. ipc.js emitted the live OperationProgress, whose callbacks are own function properties, so webContents.send's structured clone refused the payload and emit() swallowed the DataCloneError by design: the foreground path reported nothing at all while it ran. It sends snapshot() now. And transfer:canParallel could only ever answer false, because ipc.js called a predicate whose first term is !!parallelOperation with two arguments." },
      { category: "changed", text: "RECYCLE BIN. OverwrittenToRecycleBin was stored, mapped and displayed, and honoured by nothing: recycleFile() had exactly one caller, in deleteFile. A user who ticked the safety net for overwritten remote files did not get it, and the file was simply gone — the worst kind of missing feature, invisible until it matters." },
      { category: "added", text: "The gate is protocolName === 'SFTP', not caps.recycleBin, which no adapter sets true; gating on the capability would have built something that could never fire. The subtler trap was the probe: the plan recycled when destFileExists, but that was only computed inside checkRemoteFile(), which returns false whenever confirmations are off — the queue's own default. The feature would have shipped and never once run. WinSCP warns about exactly this at SftpFileSystem.cpp:5129 (\"we need to find out that they exist first... even if overwrite confirmation is disabled\"), which is why its EXCL flag is OR'd with the setting rather than gated on confirmation. Both overwrite paths now probe when confirming OR preserving, and restore the recycled file's permissions onto the replacement." },
      { category: "added", text: "Honest limits, not absorbed: a symlink is trusted from the adapter's stat rather than resolved via ReadSymlink; the resume-branch recycle surfaces a failure instead of offering WinSCP's retry/skip/abort; and four of the ten new queue tests are negative gates that pass either way by construction." },
      { category: "changed", text: "443 unit + 82 e2e pass, 0 fail. Each behavioural test was proved to fail without its change." },
    ],
    changesYue: [
      { category: "changed", text: "兩條罅一次補晒，兩邊都喺真 SFTP 上試過。" },
      { category: "changed", text: "**接得通**：41becd9 話個引擎接唔到，話 ipc 冇 channel、又冇 byte mover。兩樣講嗰陣 都已經唔啱 —— channel 前一個 commit 就加咗，byte mover 一直都有畀。真正甩嗰橛喺 更出面：**個 renderer 由頭到尾冇叫過**。十六個動作全部行去 queue:add。仲有，淨係 改 commands.js 係一啲用都冇 —— `wiring.js` 個 override 先係真正行嗰個，測試會過, 但個 app 照樣唔理你。順手執到兩件：進度物件過唔到 structured clone，錯又俾人靜靜 吞咗，所以前景傳輸行緊嗰陣乜都唔出聲；`canParallel` 就永遠答 false。" },
      { category: "changed", text: "**回收桶**：個設定存得、對得、畫得出，但冇人理。剔咗個安全網嘅人根本冇安全網, 檔案就咁冇咗 —— 最衰嗰種，唔出事你唔會知。閘要用 protocolName 而唔係 caps （冇 adapter 開過），仲有個更陰嘅陷阱：本來只喺開咗確認先去 stat，而 queue 預設 係唔確認 —— 即係出咗街都永遠唔會行過一次。WinSCP 自己份 source 都特登寫低咗呢點。" },
      { category: "changed", text: "冇扮嘢嘅限制：symlink 信 adapter 講，冇自己解;續傳嗰邊失敗係照拋唔係畀你揀重試; 十個新 queue 測試入面有四個係死閘，改唔改都過。" },
    ],
  },
  {
    id: "eb9c43e", kind: 'commit', ref: "eb9c43e", oid: "eb9c43e7996c63102757e3d3a2648a97df1b8257", date: "2026-08-02",
    title: "Time-limit the handoff's own test run, so it stops recommending --skip-tests",
    changes: [
      { category: "changed", text: "tools/handoff.js runs the suite itself to fill in the Tests row, and did it with no --test-timeout. So the same hang that stalls CI also freezes handoff generation — and the obvious way out is --skip-tests, after which the file cheerfully reports \"Tests | not run in this regeneration\"." },
      { category: "changed", text: "That is exactly what the last handoff said. A document whose whole purpose is that it \"cannot flatter the state of the work\" ended up with its most important row blank, because the only way to make it finish was to stop asking." },
      { category: "changed", text: "Same 120s as package.json, for the same reason." },
      { category: "changed", text: "handoff.js 自己會跑測試去填嗰行「Tests」，但一直冇 --test-timeout。所以吊死 CI" },
    ],
    changesYue: [
      { category: "changed", text: "嗰個問題，一樣會吊死份 handoff —— 而最順手嘅出路就係 --skip-tests，跟住份文件就 好開心咁寫住「今次冇跑測試」。" },
      { category: "changed", text: "上一份 handoff 寫嘅就係咁。一份成篇強調「唔識講大話」嘅文件，最緊要嗰行係空白嘅, 因為唯一令佢跑得完嘅方法，就係唔好問。" },
    ],
  },
  {
    id: "c027fc6", kind: 'commit', ref: "c027fc6", oid: "c027fc64ace7fdeffa9c4235ce456914a8bfc857", date: "2026-08-02",
    title: "Give the test suite a timeout, so a hung test is a red build and not a lost hour",
    changes: [
      { category: "changed", text: "`npm test` IS the CI test job, and node --test has no default per-test timeout. One test that never settles therefore hangs the runner until GitHub's six-hour ceiling kills it — and because concurrency.group is keyed on the ref with cancel-in-progress false, that run also blocks every later push to main behind it. Both halves happened today: a main run sat in \"Test (windows-latest)\" for over an hour while every other run of the day finished in three to six minutes, and the next push queued behind it and never started." },
      { category: "changed", text: "A hang is the worst thing a suite can do, because it produces no output at all. A failure names a test. A hang leaves nothing to grep and looks, from outside, exactly like slow." },
      { category: "changed", text: "120s per test against a suite that runs in ~14s is slack, not a constraint. The guard test asserts the flag is present and non-zero; removing it from package.json turns that test red with the reason spelled out." },
      { category: "changed", text: "`npm test` 就係 CI 個 test job，而 node --test 預設冇 per-test timeout。一個唔識 停嘅測試就吊住成個 runner，直到 GitHub 六個鐘上限先斬 —— 加上 concurrency 係跟" },
    ],
    changesYue: [
      { category: "changed", text: "ref 而且唔 cancel-in-progress，仲要順手擋住之後所有 push。今日兩樣都發生咗：一個 main run 喺 \"Test (windows-latest)\" 坐咗成粒鐘，而全日其他 run 三到六分鐘就完, 跟住嗰個 push 排喺後面永遠冇開過。" },
      { category: "changed", text: "吊死係測試最衰嘅結局，因為佢乜都唔出。衰咗起碼講到邊個測試；吊死連 grep 都冇得 grep，喺出面睇落同「行得慢」一模一樣。" },
      { category: "changed", text: "成套跑 14 秒，畀 120 秒一個測試係鬆到冇朋友。守門測試會查住個 flag 仲喺唔喺度。" },
    ],
  },
  {
    id: "f38f073", kind: 'commit', ref: "f38f073", oid: "f38f073f9cddfcec5045c36c1a337c0730453aa4", date: "2026-08-02",
    title: "Guard the one line that stops a release from building itself",
    changes: [
      { category: "fixed", text: "Publishing a release creates a tag, a bare `on: push` fires for tag pushes, and so every release triggered a build that published a release. ci.yml has carried a comment about this since the first outbreak — nine releases from four commits — but nothing enforced the fix. It recurred today and produced over 200 releases, rebuilding the same commit under a new number each lap." },
      { category: "changed", text: "The loop is invisible from a green build, which is what makes it worth a test: every individual run SUCCEEDS. Nothing is red, nothing throws, and the only symptom is a release list growing on its own." },
      { category: "fixed", text: "`tags-ignore: ['**']` is the entire fix and it is one line in a YAML block that a reformat could quietly drop. This asserts it is present, that it excludes every tag rather than a subset, and that no `tags:` allow-list reopens the same loop spelled the other way round." },
      { category: "changed", text: "Proved it fails for the right reason: removing the two lines from ci.yml turns this test red with \"on.push must carry tags-ignore\", and ci.yml was restored byte-identical afterwards. 8/8." },
      { category: "changed", text: "出 release 會開 tag，`on: push` 見到 tag 又行一次，行完又出 release —— 自己生" },
    ],
    changesYue: [
      { category: "changed", text: "自己。ci.yml 早就寫低咗呢件事（上次四個 commit 出咗九個 release），但冇人守住。 今日又發作，出咗二百幾個，同一個 commit 一圈換一個號碼咁重複起。" },
      { category: "changed", text: "最陰險係：睇 build 係綠嘅。每一次 run 都成功，冇嘢紅冇嘢拋，唯一症狀就係個 release list 自己識生。所以先要落個測試守住。" },
      { category: "changed", text: "`tags-ignore: ['**']` 就係全部答案，得一行，reformat 一下就冇咗。試過剷咗佢, 個測試即刻紅，剷完再原封不動放返。8/8。" },
    ],
  },
  {
    id: "2b21dc3", kind: 'commit', ref: "2b21dc3", oid: "2b21dc3779210c27be6d613054c425c4cb94c0ec", date: "2026-08-02",
    title: "Re-unpack Electron after patching extract-zip, since npm broke it before we could",
    changes: [
      { category: "fixed", text: "npm runs Electron's postinstall DURING `npm install`, when extract-zip is still the broken upstream copy. So the binary gets unpacked with the exact bug this tool exists to fix, and patching afterwards does nothing about the damage: dist/ is left holding one file — LICENSES.chromium.html, whichever entry the zip listed first — and no path.txt. The tool's own header has admitted since it was written that Electron \"had to be unpacked by hand\", and then never did it." },
      { category: "changed", text: "Nothing reports this, and the symptom is three layers from the cause: require('electron') throws \"failed to install correctly\"; every e2e test fails blaming its own assertion; and `npm test` HANGS, so there is no summary at all. A test run that never finishes is a worse diagnostic than one that fails, and this is what a fresh clone on Node 26 gets." },
      { category: "changed", text: "The tool now checks path.txt against the binary it names — a pointer to a file that is not there being precisely what a half-finished unpack leaves — and re-runs Electron's own install.js when it leads nowhere. Same cached zip, so no download. --check reports it and exits non-zero." },
      { category: "fixed", text: "Verified by reproducing the broken state exactly (one entry, no path.txt): --check exits 1 and names it, the repair restores 19 entries and electron.exe, and test/e2e-app.test.js goes from a hung runner to 36/36 in 14s. The screenshot is that run's real captured window, not a redraw." },
      { category: "fixed", text: "npm 裝 electron 嗰陣，extract-zip 仲未補，所以個 binary 就係用緊呢個 bug 解壓 —— 補完先都冇用，dist/ 淨返一個 LICENSES.chromium.html，path.txt 都冇。呢個工具嘅" },
    ],
    changesYue: [
      { category: "changed", text: "註解一早寫住「要手動解壓」，然後一直冇做。" },
      { category: "changed", text: "最陰功係三層之後先見到：require('electron') 話裝錯；e2e 全部紅，每個都賴自己; `npm test` 直情吊死，連個總結都冇。跑到永遠唔完，仲衰過跑到衰。" },
      { category: "changed", text: "而家會查 path.txt 指住嗰個檔案係咪真係喺度，唔喺就再行一次 electron 自己嘅 install.js，讀返同一個 cache，唔使再載。試過整返個爛狀態出嚟：--check 出 1, 修完 19 個檔案連 electron.exe，e2e-app 由吊死變 36/36，14 秒搞掂。" },
    ],
  },
  {
    id: "fbdf960", kind: 'commit', ref: "fbdf960", oid: "fbdf9609263d4c5e70bcebb4077cbc04a7c40ea7", date: "2026-08-02",
    title: "Record the winscp-com bin entry the lockfile never picked up",
    changes: [
      { category: "changed", text: "package.json has declared a `bin` for winscp-com since the console work landed, but package-lock.json's root package entry never carried it. npm install put it there on its own, which is the lockfile agreeing with reality rather than churn worth reverting." },
      { category: "changed", text: "Small, but the lockfile is what a clean CI checkout installs from, so a root entry that disagrees with package.json is a disagreement that travels." },
      { category: "changed", text: "package.json 一早寫咗 winscp-com 呢個 bin，個 lockfile 就一直當睇唔到。npm install" },
    ],
    changesYue: [
      { category: "changed", text: "自己補返，唔係亂改，係對返數。細嘢，不過 CI 就係照住個 lockfile 裝，唔對數就跟住 一齊走。" },
    ],
  },
  {
    id: "761f109", kind: 'commit', ref: "761f109", oid: "761f109af79829c7ac70200df160fe0bb7563a77", date: "2026-08-02",
    title: "Strip the carriage return before the comment, or the comment fails the build",
    changes: [
      { category: "changed", text: "test/autoupdate.test.js reads ci.yml and strips comments before asserting that the release command carries no --prerelease and no --draft. The stripper was `l.replace(/(^|\\s)#.*$/, '')`, and `.` does not match a carriage return. Against a CRLF checkout the `.*$` can never reach `$`, the match fails outright, and every comment survives untouched. The assertion then trips on ci.yml:230 — the comment explaining why --prerelease is deliberately absent." },
      { category: "changed", text: "The test's own comment already says the first version of it \"failed on the comment that explains why --prerelease is absent, which is a fine reason to write a comment and a terrible reason to fail a build.\" It then went and failed on that exact comment a second time. Twice defeated by its own documentation is enough; the \\r now goes first." },
      { category: "changed", text: "Windows-only, which is why nobody saw it: CI checks out LF and stayed green the whole time. test/autoupdate.test.js is 7/7." },
    ],
    changesYue: [
      { category: "changed", text: "一個 `\\r` 就搞到成個測試死。`.` 食唔到 carriage return，CRLF 之下啲註解剷唔走, 跟住就撞正嗰句解釋「點解冇 --prerelease」嘅註解 —— 個測試自己都寫住「上次都係 衰喺呢句度」，然後又衰多次。同一句註解陰你兩次，夠喇。CI 行 Linux 所以一路綠, 淨係喺 Windows 先見到。而家先剷 \\r，7/7 全綠。" },
    ],
  },
  {
    id: "41becd9", kind: 'commit', ref: "41becd9", oid: "41becd96235a5b44f67660413aa3eb70a830e908", date: "2026-08-02",
    title: "Record what the transfer verifier actually found: 0.30, and not reachable",
    changes: [
      { category: "changed", text: "The eight-stream workflow finished. Its adversarial verifier rated the transfer half at 0.30 with reachable=false, and the ledger now says so rather than crediting 2,930 written lines as ported." },
      { category: "changed", text: "Roughly 2,000 of those lines are an island. Only the overwrite decision is live, through queue.js. copyToRemote/copyToLocal, source/sink, directorySource, sourceRobust/sinkRobust, ParallelOperation and AdapterFileSystem are reachable only via terminal.copyToRemote — for which no ipc.js channel exists (grep: zero hits) and whose only caller in the tree is explorershell.js, which nothing but its own test requires. And TransferEngine needs an injected byte mover that the one production construction does not pass, so those paths would throw even if a channel existed. Written, tested, unreachable: by the mandate, not ported." },
      { category: "security", text: "The verifier's blocker had already been closed by the reconcile pass, and it was worth closing. queue.js passed `canAppend: true` unconditionally and forced `asciiTransfer = false`, so on the ONE path a user can actually reach, Append was still offered for an encrypted session and for a text-mode transfer — the two cases where appending produces a corrupt file. Both call sites now ask canAppendTo(), and the text flag is computed from the real transfer mode." },
      { category: "changed", text: "Left open, and written down rather than absorbed:" },
      { category: "changed", text: "OverwrittenToRecycleBin is never honoured. The setting exists in defaults, in sessiondata, in the Advanced dialog, and terminal.js already has a working recycleFile() — but no transfer path calls it. A user who deliberately turned on the safety net for overwritten remote files does not get it, and the overwritten file is simply gone. That is the worst kind of missing feature: one whose absence is invisible until it matters." },
      { category: "changed", text: "A resumable upload does not refuse a target owned by another user, so resuming can silently change a file's ownership." },
      { category: "changed", text: "tfUseFileTransferAny is never set, so the retry-budget reset is dead code and a long FTP transfer gives up sooner than WinSCP's would." },
      { category: "changed", text: "excludeEmptyDirectories is accepted by the transfer filter and does nothing." },
      { category: "changed", text: "Coverage 53.2% -> 55.3%, and the transfer unit is deliberately NOT among what moved it." },
    ],
    changesYue: [
      { category: "changed", text: "驗證員畀 transfer 嗰半 0.30 分,仲話「用家根本掂唔到」。進度表照寫,唔會因為 寫咗 2,930 行就當搬咗。" },
      { category: "changed", text: "寫咗、測試過、但係去唔到,按規矩就係未搬。" },
    ],
  },
  {
    id: "74a92c6", kind: 'commit', ref: "74a92c6", oid: "74a92c6a6d10dfc335bbc45dfd0da2967f41c9bf", date: "2026-08-02",
    title: "Land the remaining workflow output; ledger at 53.2%, tests currently unverified",
    changes: [
      { category: "changed", text: "Wrapping up an interrupted session. Everything on disk is committed rather than left to rot in a working tree: the transfer decision layer, the resource string extractor, the directory-view and path-edit models, the explorer shell, the two interface modes, the console front-end, the SFTP extension layer, and their tests and docs." },
      { category: "changed", text: "Two real defaults were wrong, and both were found by reading WinSCP's own CopyParam.cpp rather than by a test:" },
      { category: "fixed", text: "transferMode shipped as \"automatic\" where WinSCP's TCopyParamType::Default is BINARY. That is not cosmetic. In automatic mode every *.txt, *.xml, *.ini and *.sh crosses in text mode, which rewrites its line endings — and because SFTPConfirmOverwrite's CanAppend is false for a text transfer, it also withdrew the Append button and refused to resume. One wrong default silently changed both the bytes on the wire and the answers the overwrite dialog was allowed to offer." },
      { category: "added", text: "preserveReadOnly shipped as true where WinSCP has false, so every downloaded file arrived read-only and had to be unlocked by hand before it could be edited." },
      { category: "fixed", text: "HONEST STATUS: `npm test` did not complete inside a ten-minute budget on this run. The suite was 2,809 passing and 0 failing two commits ago, and the newest files have not been through a full green run since. A test file that hangs has already happened once here — sftp-extensions held the event loop open while every assertion passed — so the likeliest cause is another un-drained handle, not a broken assertion. It is UNVERIFIED either way, and is recorded as unverified in HANDOFF.md rather than assumed green." },
    ],
    changesYue: [
      { category: "changed", text: "執手尾:所有喺硬碟度嘅嘢都 commit 咗,唔會爛喺個 working tree 入面。" },
      { category: "changed", text: "兩個預設值本身就錯,兩個都係揭返 WinSCP 自己份 CopyParam.cpp 先揾到:傳輸模式 本應係 binary 而唔係 automatic —— 錯咗會令 *.txt *.xml *.sh 全部用文字模式過 去,改埋你啲換行符,仲會令「續傳」個掣消失;另一個令每個下載返嚟嘅檔案都變唯讀。" },
      { category: "changed", text: "老實講:今次 `npm test` 十分鐘都未跑完。兩個 commit 之前係 2,809 過、0 肥佬, 但係最新啲檔案未經過一次完整綠燈。呢度之前已經發生過一次「測試全過但係唔肯收工」 嘅情況,所以最有可能又係有 handle 冇收乾淨。總之未驗證就係未驗證,HANDOFF.md 照實寫住未驗證,唔會當佢綠燈。" },
    ],
  },
  {
    id: "aae58d9", kind: 'commit', ref: "aae58d9", oid: "aae58d925dbac87c537d267bbf69f662789c39a5", date: "2026-08-02",
    title: "Generate HANDOFF and ROADMAP, and unstick a test file that hung the suite",
    changes: [
      { category: "changed", text: "HANDOFF.md and ROADMAP.md did not exist. They do now, and they are generated by tools/handoff.js from the coverage ledger, a real test run, the git log, the open issues and the built installer artifacts. Nothing in the generated sections is typed by a person, so the handoff cannot flatter the work: it reports the uncommitted-change count, whether HEAD matches the remote, and the twenty largest unported units in order. Prose between the hand-written markers survives regeneration, because judgement does not come out of a tool." },
      { category: "fixed", text: "While generating it, the tool sat there. test/sftp-extensions.test.js was hanging: every one of its assertions passed, the file never exited, and `node --test` waits for the event loop to drain. A green suite that never returns looks like broken CI infrastructure rather than a bug in a test, which is the most expensive way for this to be discovered. It now carries a leak guard that names whatever is still holding the loop open instead of hanging on it — and the file went from >180 s to 0.955 s." },
      { category: "changed", text: "Two smaller things the same investigation turned up:" },
      { category: "changed", text: "handoff.js originally shelled out to `npm test`. On Windows npm is a shell shim, so that needed shell:true — a command-injection foot-gun the runtime now warns about — and returned nothing anyway. It runs the test runner directly, and if it cannot read the output it says \"could not be read\" rather than printing blanks where numbers go." },
      { category: "changed", text: "PENDING_KEYS, the list of preferences that persist but are read by nothing, had 45 entries and reality had 29. Sixteen options gained a real consumer and none lost one. That test fails in both directions on purpose: an option that quietly stops being honoured fails, and so does one still telling the user on its own row that nothing reads it after the wiring landed." },
      { category: "changed", text: "Also wired bin/winscp-com.js into package.json. Its author could not declare it — package.json is not theirs — so the console front-end was complete, tested, and impossible to run." },
    ],
    changesYue: [
      { category: "changed", text: "HANDOFF.md 同 ROADMAP.md 之前根本冇。而家有,而且係由工具讀返真實數據生成:進度 表、真嘅測試結果、git log、開住嘅 issue、同埋整咗出嚟嘅安裝檔。冇一個數字係人手 打上去,所以佢想吹都吹唔到。" },
      { category: "changed", text: "生成嗰陣個工具喺度停咗。原來 sftp-extensions 個測試檔:每條測試都過,但係成個 process 唔肯收工。全綠但係永遠唔返嘅測試,睇落好似 CI 壞咗,而唔似有 bug —— 呢個係最貴嘅發現方式。由 180 秒以上變成 0.955 秒。" },
      { category: "changed", text: "2,810 tests, 2,809 pass, 0 fail — twice in a row, checked for flakiness." },
    ],
  },
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
