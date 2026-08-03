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
    id: "3636cfb", kind: 'commit', ref: "3636cfb", oid: "3636cfbe55ce856b1853a3235088afd7bef86518", date: "2026-08-03",
    title: "Harden session, configuration, preferences, and dialogs",
    changes: [
      { category: "changed", text: "English: Make session trust, configuration persistence, history export, preference writes, and dialog actions fail closed and retry safely; document the behavior and lock it down with regressions. The code now keeps its promises instead of wandering off with half-saved settings." },
    ],
    changesYue: [
      { category: "changed", text: "廣東話：收實 session 信任、設定儲存、history export、偏好寫入同對話框操作；寫唔入就回復、驗證唔到就停手，仲補齊文件同回歸測試。啲 code 而家唔再食咗半碟設定就扮冇事，終於識得講聲『我寫唔到』。" },
    ],
  },
  {
    id: "64e0cc2", kind: 'commit', ref: "64e0cc2", oid: "64e0cc2ab87ac944266ca04bd9a970965c54a145", date: "2026-08-03",
    title: "Harden protocol queue and sync boundaries",
    refs: ["#2", "#3", "#4", "#5", "#14"],
    changes: [
      { category: "fixed", text: "English: Close proven SFTP, SCP, FTP, WebDAV, S3, queue, copy-parameter, and synchronization edge cases, and document the headless drop options; the transfer machinery now checks its shoelaces before sprinting.\\n\\nCantonese: 收口 SFTP、SCP、FTP、WebDAV、S3、queue、copy parameters 同 sync 嘅實證邊角 bug，仲補齊 headless drop options 文件；搬檔 machinery 而家跑之前會先綁好鞋帶。\\n\\nRefs #2, #3, #4, #5, #14" },
    ],
  },
  {
    id: "2e23e4f", kind: 'commit', ref: "2e23e4f", oid: "2e23e4f012dd393287115fcf45a43a0ce5d62a37", date: "2026-08-03",
    title: "Fail closed on credential and identity gaps",
    refs: ["#13"],
    changes: [
      { category: "security", text: "English: Refuse unprotected credential writes, require SHA-256 identities for trust prompts, and clear decrypted session secrets on permanent close; security code now shuts the door before the draught starts.\\n\\nCantonese: 無保護就唔寫 credential、trust prompt 一定要有 SHA-256 identity，永久 close 就清走解密 secret；security 門而家早閂，唔畀風入嚟開 party。\\n\\nRefs #13" },
    ],
  },
  {
    id: "c98cf01", kind: 'commit', ref: "c98cf01", oid: "c98cf01f05c2cf29f44f91d66338da2e29f3de7e", date: "2026-08-03",
    title: "Harden editor site and panel parity",
    refs: ["#9", "#11", "#12", "#13"],
    changes: [
      { category: "security", text: "English: Close the remaining editor, Advanced Site, Commander, and master-password edge cases; keep the UI honest when state is incomplete instead of letting the code perform interpretive dance.\\n\\nCantonese: 收口 editor、Advanced Site、Commander 同 master-password 嘅邊角位；資料未齊就老實停低，唔好再畀 code 跳 interpretive dance。\\n\\nRefs #9, #11, #12, #13" },
    ],
  },
  {
    id: "3e8e823", kind: 'commit', ref: "3e8e823", oid: "3e8e823ab914e2f36741f8660a490655bbd93147", date: "2026-08-03",
    title: "Harden packaging accessibility menus and history",
    refs: ["#15", "#16", "#20", "#23"],
    changes: [
      { category: "added", text: "English: Tighten Squirrel release gates and updater results, add shared language/regex/reduced-motion contracts, expose menu shortcuts accessibly, and audit unsaved-discard history before close. The parity buffet now checks the receipt before serving seconds." },
      { category: "changed", text: "廣東話: 收緊 Squirrel release gate 同 updater result，加強 language、regex、reduced motion contract，右鍵 menu 顯示 shortcuts，丟 unsaved document 之前寫低 history；parity buffet 而家先睇收據，唔係食完先搵單。Refs #15, #16, #20, #23." },
    ],
  },
  {
    id: "937ecb0", kind: 'commit', ref: "937ecb0", oid: "937ecb0c93cab3635ffcacd50a8059350f161547", date: "2026-08-03",
    title: "Expand CLI drag palette and overlay parity",
    refs: ["#14", "#17", "#18", "#19"],
    changes: [
      { category: "added", text: "English: Add script URL aliases and redacted file logging, harden Explorer clipboard and drag/drop boundaries, expose inline preference controls in the command palette, and give overlays explicit surfaces, scrolling and viewport-safe resizing. The UI goblins now have fewer transparent escape routes." },
      { category: "removed", text: "廣東話: 加強 script URL alias 同 redacted log，收緊 Explorer clipboard 同 drag/drop 邊界，command palette 可以 inline 改 preference，浮層亦有底色、捲軸同 viewport-safe resize；啲 UI 小妖怪而家少咗透明走佬位。Refs #14, #17, #18, #19." },
    ],
  },
  {
    id: "cd71f05", kind: 'commit', ref: "cd71f05", oid: "cd71f0574ddeda79aa579b1dea3b9bed3762fc29", date: "2026-08-03",
    title: "Harden protocol retries and sync boundaries",
    refs: ["#2", "#3", "#4", "#5"],
    changes: [
      { category: "changed", text: "English: Harden FTPS data-channel cleanup and certificate checks, reject unsafe SCP recursive names, preserve queue resume and overwrite decisions, and correct synchronization and checklist edge cases. The old edge-case gremlins have been put on a timeout." },
      { category: "fixed", text: "廣東話: 修好 FTPS data channel 清場同證書核對，拒絕 SCP 古怪路徑名，保留 queue resume 同 overwrite 問答，亦修正同步同 checklist 邊界位；啲舊 bug 而家俾人請咗飲茶再排隊。Refs #2, #3, #4, #5." },
    ],
  },
  {
    id: "438729b", kind: 'commit', ref: "438729b", oid: "438729bd895c8f77ad2f718848c8548eaeba720f", date: "2026-08-03",
    title: "Keep nested console discovery headless",
    changes: [
      { category: "added", text: "Make winscp-com and winscp run consume help/version flags after variadic command or parameter switches instead of forwarding them into the scripting prompt. Add process-level regressions and document the wrapper behavior.\\n\\n廣東話：help/version 而家唔會喺 command 參數堆入面迷路，CLI 唔使突然開 prompt 玩捉迷藏。" },
    ],
  },
  {
    id: "d788b02", kind: 'commit', ref: "d788b02", oid: "d788b02e45b8988f008ccfdb69fb4de040e2e790", date: "2026-08-03",
    title: "Harden drag CLI and trust boundaries",
    refs: ["#14", "#17"],
    changes: [
      { category: "added", text: "Add read-only drop simulation and capability discovery, and route panel drops through validated effect and target checks. Harden authentication retries, protected-envelope parsing, submenu focus restoration, disconnected-session action gating, and SFTP custom-subsystem handling with focused regressions and docs.\\n\\n廣東話：CLI 而家識驗 DROP、唔會亂咁搬屋；登入、右鍵選單同 SFTP 都收好門口，啲壞資料想扮無事都冇咁易。\\n\\nDocker SFTP/FTP smoke and the full test suite are green: 3,558 total, 3,557 passed, 0 failed, 1 skipped." },
      { category: "changed", text: "Refs #14\\nRefs #17" },
    ],
  },
  {
    id: "1bd52d3", kind: 'commit', ref: "1bd52d3", oid: "1bd52d34e0dcbbed8b9be56cd37b12d51e334088", date: "2026-08-03",
    title: "Document remaining protocol capability limits",
    changes: [
      { category: "changed", text: "The docs now stop promising proxy magic and filename wizardry—FTP/WebDAV 依家有幾多掂就講幾多，唔再靠想像力連線。" },
    ],
  },
  {
    id: "ad2fc20", kind: 'commit', ref: "ad2fc20", oid: "ad2fc204b75b8bc992fac6b52e3d43373f367504", date: "2026-08-03",
    title: "Align SiteAdvanced capability ledger and site identity",
    changes: [
      { category: "changed", text: "The advanced settings table now matches real adapters, and site IDs stay put—pipeline 唔再扮斷線，identity 亦唔俾亂咁改。" },
    ],
  },
  {
    id: "7ebde98", kind: 'commit', ref: "7ebde98", oid: "7ebde988231d0d213ce8bc3722a7f736b8a5015f", date: "2026-08-03",
    title: "Harden CLI configuration and foreground settings paths",
    changes: [
      { category: "changed", text: "CLI help, config shapes, terminal copies, editor snapshots, and preference fallbacks now fail closed—成班設定唔再扮冇事，亂值入嚟就老實講，copy 錯 contract 就即刻收工。" },
    ],
  },
  {
    id: "ca67b21", kind: 'commit', ref: "ca67b21", oid: "ca67b21ce328810d55a9528d29aa5ff8e80b09a6", date: "2026-08-03",
    title: "Document sorted checklist identity preservation",
    changes: [
      { category: "changed", text: "The checklist row keeps its true identity now—冇再俾排序扭到暈，揀邊行就改邊行。" },
    ],
  },
  {
    id: "fc7938a", kind: 'commit', ref: "fc7938a", oid: "fc7938a22aaaff7515fea5c8eb61c152487ab6c9", date: "2026-08-03",
    title: "Fix reconnect and sorted checklist identity",
    changes: [
      { category: "removed", text: "Reconnect now waits for teardown to finish, and checklist rows keep their choices when the UI sorts them. The files may move around, but their decisions no longer wander off for dim sum.\\n\\nReconnect 會等 teardown 完先再返嚟，checklist sort 完都會跟返原本檔案嘅選擇；row 可以周圍郁，但佢嘅 decision 唔會走失去飲茶。" },
    ],
  },
  {
    id: "485a1d0", kind: 'commit', ref: "485a1d0", oid: "485a1d0f33f3c350f235871e2a90428bc57fd043", date: "2026-08-03",
    title: "Harden SCP WebDAV and foreground queue paths",
    changes: [
      { category: "changed", text: "SCP now keeps the four-digit mode instead of trimming the interesting bits, WebDAV forgets stale verbs when a reconnect loses its Allow header, and the foreground mover finally reads its speed limit before racing off.\\n\\nSCP 唔再剪走 special mode bits，WebDAV reconnect 見唔到 Allow 就會收返過期 command，foreground mover 亦終於肯睇 speed limit 先起飛。條 code 唔再當設定係裝飾品。" },
    ],
  },
  {
    id: "0f499cf", kind: 'commit', ref: "0f499cf", oid: "0f499cf39f554aa5fc168a611645ae17d4d0b535", date: "2026-08-03",
    title: "Cover delayed passive FTPS transfers",
    changes: [
      { category: "security", text: "The FTP ordering switch now has a TLS witness too, so the data socket cannot claim plain-text innocence while secretly tripping over certificate handshakes.\\n\\nFTP ordering switch 而家連 TLS 都有見證：data socket 唔可以喺明文測試扮無辜，轉頭喺證書 handshake 度跣親。" },
    ],
  },
  {
    id: "4d78e05", kind: 'commit', ref: "4d78e05", oid: "4d78e0579940ac22959230651104c5844c9f5266", date: "2026-08-03",
    title: "Fix CLI edges and protocol transfer races",
    changes: [
      { category: "fixed", text: "The command line no longer packs the literal true into a suitcase and calls it a path; FTP now opens delayed passive data sockets in the order servers actually expect, S3 overlap rows are served once, and editor stat outages no longer impersonate deletions. Regex, modal focus, release copy, and verification docs are covered by tests.\\n\\n條 code 終於唔再將 true 當行李塞入路徑度扮檔案；FTP data socket 按伺服器真正食得落嘅次序開，S3 重疊 object 唔再食兩次，editor 斷線亦唔會扮刪檔。Regex、modal focus、release 文案同驗證文件都有測試睇住，冇位俾 bug 扮鬼。" },
    ],
  },
  {
    id: "2facf09", kind: 'commit', ref: "2facf09", oid: "2facf09d00d30f7875e8f59442067220b2cbeb46", date: "2026-08-03",
    title: "Close SFTP size preference and checklist gaps",
    changes: [
      { category: "added", text: "English: Handle refused SFTP statvfs probes, reject imprecise oversized byte counts, make session-tab truncation configurable, and add a non-destructive checklist Calculate command. The port now says 'not available' when the server means it, instead of doing interpretive dance with nonsense numbers." },
      { category: "changed", text: "廣東話：SFTP statvfs 被拒就誠實講 unavailable，超大 size 唔再食落啲失真數字，session tab truncation 真係有 preference，checklist 加咗唔會執行嘢嘅 Calculate。個 port 唔再拎 nonsense number 跳 interpretive dance。" },
    ],
  },
  {
    id: "a95dc72", kind: 'commit', ref: "a95dc72", oid: "a95dc7252f6a4fe12cd5ed88502ab4896b8cb16c", date: "2026-08-03",
    title: "Harden reconnect queue WebDAV and menu parity",
    changes: [
      { category: "changed", text: "English: Retire dead adapters before reconnect, recognize slash-marked WebDAV collections, canonicalize headless queue speed limits, and surface inherited action shortcuts in context menus. The UI now stops hiding the keyboard cheat sheet while the queue stops accepting speed limits from the numeric underworld." },
      { category: "changed", text: "廣東話：斷線重連前清走死 adapter、認出 WebDAV slash collection、整靚 headless queue speed limit，再喺 context menu 顯示 inherited shortcut。個 UI 唔再收埋快捷鍵小抄，queue 亦唔再收埋數字地獄嘅 speed limit。" },
    ],
  },
  {
    id: "e840449", kind: 'commit', ref: "e840449", oid: "e840449732524c5291c5eccef96e3c49b6505f9f", date: "2026-08-03",
    title: "Wire editor refresh, preference shortcut, and S3 listing guards",
    changes: [
      { category: "removed", text: "English: Refresh matching remote panels after editor uploads, make the opened-tabs shortcut preference live, and deduplicate overlapping S3 directory prefixes with focused documentation and tests. The Explorer no longer stares at yesterday's file size like a confused goldfish." },
      { category: "changed", text: "廣東話：editor upload 完之後更新返啱 session 個 remote panel，令 opened-tabs shortcut preference 真係生效，再去重 S3 重疊頁面嘅 folder prefix；Explorer 唔使再望住琴日個 file size 發呆，似條迷惘金魚。" },
    ],
  },
  {
    id: "5d0b038", kind: 'commit', ref: "5d0b038", oid: "5d0b038914aaa7d40038f7a1b6d39b99da4c618b", date: "2026-08-03",
    title: "Wire protocol edges and roadmap controls",
    changes: [
      { category: "changed", text: "English: Make FTP HOST mode, SFTP listing/checksum paths, SCP OpenSSL checksums, direction-aware synchronization watching, checklist sorting, and safe editor rollback real and tested. The code now trips over fewer of its own shoelaces." },
      { category: "changed", text: "廣東話：接通 FTP HOST、SFTP 清單同 checksum、SCP OpenSSL checksum、同步方向監察、清單排序，同埋 editor rollback；仲加埋拼錯 preference 個修正。啲 code 而家少啲自己踩自己條鞋帶。" },
    ],
  },
  {
    id: "fbb9bae", kind: 'commit', ref: "fbb9bae", oid: "fbb9bae2304f999e4f23fa4c7238c5e2898222ed", date: "2026-08-03",
    title: "Ignore expected handoff test artefact",
    changes: [
      { category: "changed", text: "English: Handoff checks now ignore the screenshot the boot test intentionally refreshes, so a clean tree is not reported dirty just because evidence had a photoshoot.\\n\\n廣東話: handoff check 而家識得忽略 boot test 有意更新嗰張 screenshot，唔會因為證據去影相就話乾淨個 tree 污糟邋遢。" },
    ],
  },
  {
    id: "68f8952", kind: 'commit', ref: "68f8952", oid: "68f8952a08319fd39757b1a45dbf0be952cd75bf", date: "2026-08-03",
    title: "Make handoff freshness self-checking",
    changes: [
      { category: "changed", text: "English: Handoff generation now walks past report-only commits, because a diary cannot tattoo its own future hash onto the page.\\n\\n廣東話: handoff 而家會跳過淨係改報告嘅 commit，唔會叫份日記預言自己個 hash；份 ledger 終於可以自己驗身。" },
    ],
  },
  {
    id: "aae7ad2", kind: 'commit', ref: "aae7ad2", oid: "aae7ad2dadf0895524748faeaf30d0a5e74e3a6a", date: "2026-08-03",
    title: "Fix Pages artifact selection",
    changes: [
      { category: "changed", text: "English: Pages now receives one run-scoped archive, so deploy-pages stops playing artifact roulette after retries.\\n\\n廣東話: 而家每次 run 都有自己條 artifact，deploy 唔使再喺三份同名包入面玩大抽獎，網站唔會無端端食檸檬。" },
    ],
  },
  {
    id: "dca4464", kind: 'commit', ref: "dca4464", oid: "dca44645e1ef335bc2c72843a25797ef50715497", date: "2026-08-03",
    title: "Harden reconnect, Explorer selection, and site builds",
    changes: [
      { category: "fixed", text: "English: Reconnect now refuses malformed retry budgets, Explorer drag/drop trusts the real selection model, and the static-site builder locks its shared output through build and verification. Windows can stop treating half-written pages like a surprise escape room. The site docs and regression tests record the new guarantees, and the proxy warning no longer repeats itself." },
    ],
    changesYue: [
      { category: "changed", text: "廣東話：重連遇到古怪 timeout 就收工，Explorer 拖放信返真正選取狀態，site builder 鎖實個 output 直到 build 同 verify 都完，Windows 唔使再玩『邊個刪走咗我個檔』密室逃脫。文件同測試一齊跟上，proxy 提示亦唔再唱 encore。" },
    ],
  },
  {
    id: "b59d321", kind: 'commit', ref: "b59d321", oid: "b59d321dc6cb31d2e86424e2b76ae32b34fb31a8", date: "2026-08-03",
    title: "Harden S3, SFTP, editor, and login flows",
    changes: [
      { category: "security", text: "English: Repeated S3 pages, shy SFTP metadata, editor cleanup races, and password buttons with stage fright now get deterministic boundaries." },
    ],
    changesYue: [
      { category: "changed", text: "廣東話：S3 重複頁、SFTP 謎之 metadata、editor 清理競賽同怕醜嘅 password 掣而家全部有清楚規矩，唔再靠估。" },
    ],
  },
  {
    id: "d2e0885", kind: 'commit', ref: "d2e0885", oid: "d2e0885a41c4c6c3bd87fe58f61264ab2a101a87", date: "2026-08-03",
    title: "Make create-directory test line-ending safe",
    changes: [
      { category: "changed", text: "English: The assertion now survives Windows checkout newlines instead of treating CRLF as a failed modal." },
      { category: "changed", text: "廣東話：Windows checkout 有 CRLF 都唔會再俾測試當成 modal 壞咗，條 assertion 終於識睇環境。" },
    ],
  },
  {
    id: "dbe8cc7", kind: 'commit', ref: "dbe8cc7", oid: "dbe8cc7a74ab0823af323052a18e89b5851e41f3", date: "2026-08-03",
    title: "Harden transfer, queue, and protocol edges",
    changes: [
      { category: "changed", text: "English: Partial files, haunted queue races, empty symlink destinations, typed INI ghosts, and oversized SCP listings have all been shown the exit." },
    ],
    changesYue: [
      { category: "changed", text: "廣東話：半截檔案、queue 競賽鬼、空 symlink 目標、打錯型嘅 INI 同爆大 SCP listing 而家全部有清楚出口，唔再扮正常。" },
    ],
  },
  {
    id: "b47e589", kind: 'commit', ref: "b47e589", oid: "b47e5891d250b780ba9350f1c8d08a3aceef61a4", date: "2026-08-03",
    title: "Harden protocol, sync, and panel boundaries",
    changes: [
      { category: "changed", text: "English: Unsafe offsets, oversized FTP numbers, eager directory pruning, and stale panel responses all tried to sneak past the boundary; the guards now make them queue politely." },
    ],
    changesYue: [
      { category: "changed", text: "廣東話：WebDAV 偏移量、FTP 大數、同步遮罩同舊 panel 回覆以前一齊扮冇事；而家個邊界有保安，唔畀佢哋亂咁入場。" },
    ],
  },
  {
    id: "8884879", kind: 'commit', ref: "8884879", oid: "88848797575cd5a7db695c91bceb009e44278725", date: "2026-08-03",
    title: "Expand explorer preferences and SFTP reachability",
    changes: [
      { category: "fixed", text: "English: Reach Explorer transfers, validate slider persistence, refuse unsupported SFTP checksum fallbacks, fix root paths, and keep folder creation open for retry. Another five parity gaps have been given actual doors instead of cardboard signs.\\n\\n粵語：Explorer transfer 真係行到、slider persistence 過 validation、SFTP 唔再亂 fallback、root path 唔再生雙斜線，create folder 失敗可以 retry。又五個 parity gap 有真門口，唔係紙牌扮入口。" },
    ],
  },
  {
    id: "da2d937", kind: 'commit', ref: "da2d937", oid: "da2d937156c78b341a8e1d843b5a0e1f2c1493c9", date: "2026-08-03",
    title: "Harden console drag queue and editor paths",
    changes: [
      { category: "removed", text: "English: Preserve binary stdin, reject Win32 trailing-name aliases, remove cancelled parallel targets, expose SiteAdvanced steppers, and make editor retries recover. The parity gremlins have lost another five ladders.\\n\\n粵語：Binary stdin 而家保留原 bytes，Win32 尾點尾空格 alias 直接拒絕，cancelled parallel target 會清走，SiteAdvanced stepper 見得人，editor retry 可以復活。Parity 小妖怪又少咗五條梯。" },
    ],
  },
  {
    id: "924064a", kind: 'commit', ref: "924064a", oid: "924064a4a5beefa2e0dee56fc44ba5887185f4af", date: "2026-08-03",
    title: "Harden S3 UI sync and config edges",
    changes: [
      { category: "changed", text: "English: Preserve malformed S3 entities, guard palette focus, serialize Login submits, atomically save host keys, and keep watcher windows attached during IPC. The edge-case buffet now has smaller plates.\\n\\n粵語：S3 壞 entity 唔再爆、palette focus 唔會追住死人 input、Login 唔重複開 session、host key 原子寫入，watcher IPC 未完之前個 window 唔會走佬。Edge-case buffet 而家啲碟細咗，冇咁易打翻。" },
    ],
  },
  {
    id: "8c87551", kind: 'commit', ref: "8c87551", oid: "8c8755121f7b5b2d84d358d0ac0191baffbeae41", date: "2026-08-03",
    title: "Harden editor security and session lifecycles",
    changes: [
      { category: "security", text: "English: Serialize editor closes, reject authenticated non-UTF-8 secrets, bracket IPv6 host keys, and refuse empty cache subtrees. The lifecycle gremlins have fewer trapdoors now.\\n\\n粵語：Editor close 而家排隊，壞 UTF-8 secret 唔准入場，IPv6 host key 加方括號，空 cache subtree 直接拒絕；啲 lifecycle 小妖怪少咗幾個地窖可以匿喇。" },
    ],
  },
  {
    id: "cd350d3", kind: 'commit', ref: "cd350d3", oid: "cd350d3982e02da391dd7699942c410674d0c8f8", date: "2026-08-03",
    title: "Harden protocol inputs and transfer settings",
    changes: [
      { category: "changed", text: "English: Reject unsafe SCP millisecond timestamps and SFTP stream offsets, normalize WebDAV timeouts, clamp untrusted FTP listing sizes, and refuse malformed CopyParams numerics. Remote servers and imported presets may be weird; the boundary now keeps the weirdness outside the transfer engine." },
      { category: "changed", text: "粵語：SCP 時間、SFTP offset、WebDAV timeout、FTP listing 同 CopyParams 數值而家先驗身再入場；遠端 server 幾古靈精怪都好，亂數唔可以入嚟搞亂個 transfer engine。" },
    ],
  },
  {
    id: "1c10a04", kind: 'commit', ref: "1c10a04", oid: "1c10a04933ce623c1f520f3b5b55917a918457be", date: "2026-08-03",
    title: "Harden async console sync and queue lifecycles",
    changes: [
      { category: "removed", text: "English: Stop late console failures from notifying released waits, remove externally stopped watchers from the synchronization registry, and await every asynchronous queue cancellation before reporting success. Ghost callbacks and phantom queue wins have been shown the exit." },
      { category: "changed", text: "粵語：Console 等候放手之後唔再畀幽靈 error 嚇人，sync watcher 停咗會清走自己，queue cancel 亦會等齊 IPC 先報喜；假勝利同殘影 callback 而家一齊收工。" },
    ],
  },
  {
    id: "f0b7bc1", kind: 'commit', ref: "f0b7bc1", oid: "f0b7bc1717e513c2d659d761380885c3836d94c2", date: "2026-08-03",
    title: "Harden CLI and session UI boundaries",
    changes: [
      { category: "changed", text: "English: Reject inert drag plans, fail closed on reconnect and numeric input, keep local and remote panels honest, scope checklist actions through descendants, repair WOW64 and remote-extension edge cases, and make Squirrel completion headless and once-only. The code was trying to look helpful while quietly doing nothing; now it says no thanks, mate." },
    ],
    changesYue: [
      { category: "changed", text: "粵語：拖放亂入嘅字眼、負數重連同亂碼數值而家唔再扮乖；本地面板、清單、Squirrel 同遠端副檔名各自守返條界線，個 code 終於識講『唔好亂嚟喎』。" },
    ],
  },
  {
    id: "44ab74d", kind: 'commit', ref: "44ab74d", oid: "44ab74dfe95a73a4eb115f1085058ccba4ec42ca", date: "2026-08-03",
    title: "Fix remote extension extraction",
    changes: [
      { category: "removed", text: "English: Keep RemoteFiles extension sorting focused on the basename; the path no longer photobombs the suffix." },
    ],
    changesYue: [
      { category: "changed", text: "粵語: RemoteFiles 而家只睇檔名尾巴，唔會畀上層路徑亂入，個 extension 終於唔再食錯位。" },
    ],
  },
  {
    id: "a281c72", kind: 'commit', ref: "a281c72", oid: "a281c72a0093def1bf5d55d5a77001aec9f20555", date: "2026-08-03",
    title: "Expand headless CLI and harden transfer boundaries",
    changes: [
      { category: "removed", text: "English: The CLI now parses and generates redacted session URLs, while drag/drop, SFTP, sync, queue, configuration, editor, terminal, palette, S3, and SCP paths reject malformed or unsafe state. The code had been doing tiny numeric gymnastics; this gives it fewer chances to juggle knives." },
    ],
    changesYue: [
      { category: "changed", text: "廣東話：CLI 而家識得安全解析同生成 session URL；拖放、傳輸、同步、設定、編輯器、終端機、指令面板同協定層都少啲歧路。啲細數字唔再玩雜技，免得 code 一邊搬檔案一邊踩香蕉皮。" },
    ],
  },
  {
    id: "2d7e22f", kind: 'commit', ref: "2d7e22f", oid: "2d7e22f52df4f8d39e29f7845f4175b5ef3d783a", date: "2026-08-03",
    title: "Reset command palette selection on search",
    changes: [
      { category: "changed", text: "English: Keep the keyboard target at the first fresh match, because stale indexes made the palette pick a surprise command after filtering." },
    ],
    changesYue: [
      { category: "changed", text: "廣東話: 搜尋一改就由第一個結果開始，唔好畀舊 index 帶個指令去食茶點。" },
    ],
  },
  {
    id: "22bc236", kind: 'commit', ref: "22bc236", oid: "22bc236a25f2313f91040c539cb57f3901d653bc", date: "2026-08-03",
    title: "Validate SCP time record fields",
    changes: [
      { category: "changed", text: "Reject unsafe timestamp fields before the wire parser nods along. 呢次 SCP 時間記錄唔再畀超大數字扮正常，免得協議食壞肚。" },
    ],
  },
  {
    id: "85b7e96", kind: 'commit', ref: "85b7e96", oid: "85b7e968fa1533109b9b0a099f2ceda11760a0f8", date: "2026-08-03",
    title: "Normalize S3 listing page sizes",
    changes: [
      { category: "changed", text: "English: Keep fractional max-keys values from bouncing off S3 like a confused dim sum order. The adapter now floors them and preserves a minimum page size before sending the request.\\n\\n廣東話: S3 唔食小數頁數，唔好叫個 API 食 2.9 份點心。依家落地取整，最少保留一份，等 listing 安全出街。" },
    ],
  },
  {
    id: "710f6b7", kind: 'commit', ref: "710f6b7", oid: "710f6b748e589bdea8263e52332832485d2739bd", date: "2026-08-03",
    title: "Validate synchronization clock options",
    changes: [
      { category: "changed", text: "Reject non-finite and negative clock settings before comparison so malformed timing cannot make the checklist hallucinate. The clock gremlin now gets bounced at the door; 時鐘妖怪唔可以亂咁改同步結果。" },
    ],
  },
  {
    id: "afbe57d", kind: 'commit', ref: "afbe57d", oid: "afbe57d891913aa7d1c1c9d7bcf929541213be4c", date: "2026-08-03",
    title: "Fix repeated CLI batches and drag-name collisions",
    changes: [
      { category: "changed", text: "Group repeated /command and /parameter values before the console parser so every batch command is consumed without an implicit session or prompt. Reject remote names that collide after Windows filename conversion instead of allowing a staged file to overwrite another." },
      { category: "changed", text: "English humour: The parser stops leaving later commands loitering in a fake prompt, and the drag folder stops playing filename musical chairs." },
    ],
    changesYue: [
      { category: "changed", text: "廣東話玩笑：命令唔再喺假 prompt 入面留低等人餵，拖放檔名撞車就即刻煞停，唔畀檔案玩消失魔術。" },
    ],
  },
  {
    id: "d008db8", kind: 'commit', ref: "d008db8", oid: "d008db882c5475cadc8d3ae7ac95eb052efb72fe", date: "2026-08-03",
    title: "Harden startup, security, protocol, and preference edges",
    changes: [
      { category: "security", text: "English: Missing INI files now explain themselves, portable imports find the file WinSCP actually writes, secrets refuse unsafe rewraps, FTP and WebDAV stop guessing, and numeric settings show what they really saved; the boundary guards have formed a small but determined queue." },
      { category: "security", text: "粵語：INI 唔見咗會自己講清楚、portable import 搵返 WinSCP 真係寫嗰份、secret rewrap fail closed、FTP/WebDAV 唔再靠估、numeric setting 顯示返真正存咗乜；啲邊界守衛排隊排得幾有紀律。" },
    ],
  },
  {
    id: "c68948c", kind: 'commit', ref: "c68948c", oid: "c68948c970400321de07c140af91d7249455c7aa", date: "2026-08-03",
    title: "Harden CLI, editor, queue, and protocol edges",
    changes: [
      { category: "changed", text: "English: Nested CLI help, BOM-less decoding, filtered editor ordering, CustomCommand prompts, queue event containment, S3 abort idempotence, and IPC capability gates now behave like grown-up boundary code; the sharp edges have been given tiny helmets." },
      { category: "changed", text: "粵語：CLI help、editor 編碼、filtered 排序、CustomCommand、queue、S3 cleanup 同 IPC capability gate 而家識得好好守邊界；啲尖角終於戴咗細細個安全帽。" },
    ],
  },
  {
    id: "c38476f", kind: 'commit', ref: "c38476f", oid: "c38476f35d1ea101a5a7137cbeeebb146aac1914", date: "2026-08-03",
    title: "Harden protocol edge cases and Docker smoke cleanup",
    changes: [
      { category: "changed", text: "English: WebDAV redirects, FTP commands, canonical paths, URLs, and dialogs now stop doing interpretive dance at their sharpest edges; the Docker smoke runner gives a stuck daemon a bounded timeout instead of waiting for it to write a memoir." },
    ],
    changesYue: [
      { category: "changed", text: "粵語：WebDAV、FTP、SFTP 同幾個對話框終於唔再喺邊界位跳舞；Docker 卡住時有時限，唔使等個 daemon 寫完自傳先收工。" },
    ],
  },
  {
    id: "0dcc3f4", kind: 'commit', ref: "0dcc3f4", oid: "0dcc3f41b1328058596dad3bc6c23099f1317ae1", date: "2026-08-03",
    title: "Harden preferences, actions, sync, dialogs, and packaging",
    changes: [
      { category: "changed", text: "The remaining slice now validates numeric preferences, removes an inert SiteAdvanced toggle, validates directory names, gates hidden-file state, reports case collisions, and rejects incomplete Squirrel artifacts in CI." },
      { category: "changed", text: "今輪補實 Preferences range、SiteAdvanced、Create Directory、hidden files、sync collision 同 Squirrel artifact gate；啲設定唔再有假掣，啲 package 唔再靠運氣出街。" },
    ],
  },
  {
    id: "e81083b", kind: 'commit', ref: "e81083b", oid: "e81083b8a200ada03fa467229bb7f2848f5c85b6", date: "2026-08-03",
    title: "Harden security, config, S3, queue, and session edges",
    changes: [
      { category: "changed", text: "The next roadmap wave fails closed on missing host fingerprints, preserves config on malformed JSON, explains unsupported S3 checksums, resets active throttle debt, shares concurrent disconnect teardown, and gives the calendar a real accessible name." },
      { category: "changed", text: "今輪修正 host fingerprint、JSON config、S3 checksum、queue throttle、session disconnect 同 calendar accessibility；啲 edge case 而家有真 contract，唔再靠估。" },
    ],
  },
  {
    id: "e91bd48", kind: 'commit', ref: "e91bd48", oid: "e91bd48fa962d535b43b6e5706ab890ffaf007db", date: "2026-08-03",
    title: "Fix CLI, drag-drop, menu, overlay, and history edges",
    changes: [
      { category: "changed", text: "The command line now forwards INI and raw settings, Explorer drops fail closed, menus show platform shortcuts and scroll safely, palette jumps focus their controls, and discard events report whether history recorded them." },
      { category: "removed", text: "CLI 而家識傳 INI 同 raw settings，Explorer drop 唔再亂跌落 current directory，menu 會顯示平台快捷鍵兼識捲，palette 直達真正 control，discard 就老實講有冇寫入 history；啲 edge case 終於唔使再扮魔術。" },
    ],
  },
  {
    id: "bcc1fd8", kind: 'commit', ref: "bcc1fd8", oid: "bcc1fd8a50bd2db15aad23b5601cab4cd31bc19a", date: "2026-08-03",
    title: "Fix workspace, search, session, and SFTP edge cases",
    changes: [
      { category: "changed", text: "The edge cases now follow the real capability and protocol contracts; the code can stop pretending every workspace member is a tab." },
    ],
    changesYue: [
      { category: "changed", text: "修正工作區、搜尋、工作階段同 SFTP 嘅邊角位；啲 bug 而家唔使再扮成主角搶戲。" },
    ],
  },
  {
    id: "69004b4", kind: 'commit', ref: "69004b4", oid: "69004b45a056a36bb9262415a72b7b9e3f75831a", date: "2026-08-03",
    title: "Expand headless CLI and close transfer edge cases",
    changes: [
      { category: "fixed", text: "The headless CLI now covers the practical console switches and deterministic drag/drop target simulation, while the application closes editor, checklist, DirView, FTP, SFTP, and existing-only synchronization gaps. Real protocol regressions, Docker policy probes, focused tests, and feature documentation accompany the fixes. The code previously treated a checklist policy like a suggestion box; now it reads the checkbox." },
      { category: "fixed", text: "CLI 而家支援實用 console switches，同埋 deterministic drag/drop target simulation；app 亦補返 editor、checklist、DirView、FTP、SFTP 同 existing-only synchronization 個窿。真 protocol regression、Docker policy probes、focused tests 同 feature docs 一齊落地。之前啲 code 當 checklist policy 係意見箱，而家終於識睇個 checkbox。" },
    ],
  },
  {
    id: "43eb4db", kind: 'commit', ref: "43eb4db", oid: "43eb4db6dba53da2e37aa50bf06966a53a4187b7", date: "2026-08-03",
    title: "Fix CLI staging and transfer lifecycle edges",
    changes: [
      { category: "added", text: "Reject empty drag-stage paths, persist protection for legacy JSON secrets, keep paused queue work out of idle, retire stale WebDAV agents on reconnect, refuse blank queue targets, and reject Windows device basenames in shell payloads. Add focused documentation and regressions. The edge-case cupboard is less haunted, and the queue now knows that paused is not done." },
      { category: "fixed", text: "拒絕空嘅 drag-stage path，舊 JSON secret 改完即刻保存保護，paused queue work 唔再扮 idle，WebDAV reconnect 會清走舊 agent，空 queue target 同 Windows device basename 一律拒絕。加埋文件同 regression；edge-case 雜物櫃少咗鬼，queue 終於明白 paused 唔係 done。" },
    ],
  },
  {
    id: "ad9936c", kind: 'commit', ref: "ad9936c", oid: "ad9936c45432426f3905d52ba298bcb2c12b9c47", date: "2026-08-03",
    title: "Harden FTP IPC accessibility and shortcut edges",
    changes: [
      { category: "added", text: "Reject CR/LF in FTP credentials, cancel IPC prompts when the renderer closes, normalize human shortcuts, cap impossible dialog minima, announce synchronize errors assertively, and lock the file-find regex builder during active searches. Add focused tests and docs. The protocol doors now check the luggage, and the UI stops asking a closed window for directions." },
    ],
    changesYue: [
      { category: "changed", text: "拒絕 FTP 認證資料入面嘅 CR/LF，renderer 關門就取消 IPC 問題，整靚人手 shortcut，限制唔可能嘅 dialog 最小尺寸，俾 synchronize 錯誤大聲通知，搜尋中就鎖住 regex builder。加埋測試同文件；協議門口終於識睇行李，個 UI 亦唔再問一扇已閂嘅門路向。" },
    ],
  },
  {
    id: "ae54b2a", kind: 'commit', ref: "ae54b2a", oid: "ae54b2a10ef9b397ef88f602fb968f2bcfa40d9b", date: "2026-08-03",
    title: "Harden drag shell terminal and protocol security",
    changes: [
      { category: "added", text: "Expose disabled preference state, capture drag-start panel paths, refuse unsafe staged names, release pending terminal prompts on cancel, reject invalid AssumeRole expiry, and require WebDAV challenges unless legacy auth is explicit. Add focused tests and documentation. The drag payload now knows where it started, and the protocols have stopped handing credentials to surprise guests.\\n\\n廣東話：drag payload 記住自己由邊度出發，WebDAV 唔再見人就派 credentials；Terminal、S3、panel 同 Preferences 都收好尾。" },
    ],
  },
  {
    id: "aa5ee78", kind: 'commit', ref: "aa5ee78", oid: "aa5ee78c22119ff7a0ba3ae75db9f3a1bb7ba010", date: "2026-08-03",
    title: "Harden queue sessions search panels and setup",
    changes: [
      { category: "added", text: "Include queue prompt state in once-done requests, fail closed on stale exec capabilities, tolerate watcher errors without items, short-circuit empty find limits, normalize Windows directory caches case-insensitively, and keep shortcut cleanup Windows-only. Add focused tests and indexed documentation. The queue now carries its paperwork, the search knows when zero means zero, and setup stops visiting the wrong operating system.\\n\\n廣東話：queue 帶齊文件、find 明白零就係零、setup 唔再去錯 OS 探親；panel 同 session 都有新路牌。" },
    ],
  },
  {
    id: "0e0969b", kind: 'commit', ref: "0e0969b", oid: "0e0969bbe0dd01226821c7463d197593ad763cba", date: "2026-08-03",
    title: "Fix Windows line-ending test extraction",
    changes: [
      { category: "fixed", text: "Make the location-profile source-extraction regression accept LF and CRLF endings so the Windows CI checkout tests the same behavior as the local checkout. The regex now reads the file instead of arguing with the newline fashion police.\\n\\n廣東話：location profile 個 regex 而家識睇 LF 同 CRLF，唔會再同換行符號鬥氣，Windows CI 可以正常開工。" },
    ],
  },
  {
    id: "7e93933", kind: 'commit', ref: "7e93933", oid: "7e9393357f94f5f34c7dd288a194c9b6cb219345", date: "2026-08-03",
    title: "Complete CLI parity and harden platform edges",
    changes: [
      { category: "added", text: "Preserve tab-containing command arguments, release runner state through optional log cleanup failures, make PATH lookup host-correct, restore companion preference keys, require explicit remote-copy capability, and make SFTP recursive removal lstat entries without attributes. Add focused tests and documentation. The CLI now keeps its tabs, the runner keeps its marbles, and SFTP stops wandering into symlinked gardens.\\n\\n廣東話：CLI 保住 tab、runner 收好自己啲 marble、SFTP 用 lstat 睇清楚條路，唔會再行入 symlink 花園打卡。" },
    ],
  },
  {
    id: "3ba2f1c", kind: 'commit', ref: "3ba2f1c", oid: "3ba2f1cee10f3e344c8b3311fb56fbe7fa205710", date: "2026-08-03",
    title: "Harden transfer console security and sync edges",
    changes: [
      { category: "added", text: "Close failed console channels, reject malformed AES verifiers, canonicalize relative symlink targets for cycle detection, stop cancelled transfers before byte movement, name SiteAdvanced order options for assistive technology, and explain a no-direction sync row honestly. Add focused tests and documentation. The edge cases now stop tripping over the same rake, which is frankly the rake's fault.\\n\\n廣東話：console channel、AES verifier、symlink、transfer、SiteAdvanced 同 sync 邊角位而家各自有路牌；個 rake 再伸腳都冇咁易中招。" },
    ],
  },
  {
    id: "a74836c", kind: 'commit', ref: "a74836c", oid: "a74836cd985151cfe71f4b3479dd3a0a589e7288", date: "2026-08-03",
    title: "Harden CLI drop classification and progress accessibility",
    changes: [
      { category: "added", text: "Reject missing-only drop classifications instead of handing an empty parcel to the transfer engine, and name progress bars with their visible labels for assistive technology. Add focused regressions and documentation. The CLI now refuses to serve imaginary files, and the progress bar finally knows who its label is.\\n\\n廣東話：空手 drop 唔再扮有貨，progress bar 亦終於認得自己個 label；兩邊都唔使再玩猜謎遊戲。" },
    ],
  },
  {
    id: "b03c84f", kind: 'commit', ref: "b03c84f", oid: "b03c84feea4cb89f7bfc211f63a4f1e8a61e7d9f", date: "2026-08-03",
    title: "Cancel pending queue prompts on removal",
    changes: [
      { category: "fixed", text: "Resolve a queued item's credential prompt when its row is removed, so the transfer and idle lifecycle cannot remain blocked on a response from a vanished UI. Add a focused regression test and document the cancellation behavior. The queue no longer waits for a ghost password prompt, laah." },
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
  border: 1px solid var(--outline-var);
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
  h('div', { class: 'dp-head' }, prevBtn, monthSel, yearSel,
    h('span', { class: 'spacer sr-only', id: titleId }, `${s('dpFrom')} / ${s('dpTo')}`), nextBtn),
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
