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
    id: "8557de4", kind: 'commit', ref: "8557de4", oid: "8557de45e9b970c304ec15acdec7815d67c7cb77", date: "2026-08-03",
    title: "Harden dialogs, file search, and S3 cancellation",
    changes: [
      { category: "security", text: "RemoteTransfer now validates before queue submission, Progress reports cancellation failures accessibly, CustomCommand protects shortcuts, FileFind ignores stale verification and exposes the regex builder, Session keeps secret-free lifecycle state, and S3 aborts HTTP and multipart work. The tests and docs keep every boundary honest, so cancellation can stop the job without stopping the explanation.\\n\\nRemoteTransfer 會先 validation 先入 queue，Progress 會清楚報 cancel failure，CustomCommand 守住 shortcut，FileFind 唔收 stale verification 又有 regex builder，Session 只留安全 lifecycle state，S3 會 abort HTTP 同 multipart。測試文件講清楚每個 boundary，cancel 可以停 job，但唔會停埋解釋。" },
    ],
  },
  {
    id: "6881f62", kind: 'commit', ref: "6881f62", oid: "6881f6217366b6f1bcc18b89381a09b6bcb0c902", date: "2026-08-03",
    title: "Refresh dialog wave handoff metadata",
    changes: [
      { category: "fixed", text: "The handoff now records the 3,245-pass regression run, Docker smoke, the 71db2c6 and fa7b4ce milestones, and the honest 59.0% coverage with 114 units outstanding. It is a handoff, not an incantation for pretending the roadmap is finished.\\n\\nHandoff 而家記低 3,245 pass regression、Docker smoke、71db2c6 同 fa7b4ce milestone，仲有老實嘅 59.0% coverage 同 114 個未完成 unit。佢係交接文件，唔係用嚟施法扮 roadmap 已經完工。" },
    ],
  },
  {
    id: "fa7b4ce", kind: 'commit', ref: "fa7b4ce", oid: "fa7b4cef76501ad0078dae951f2f69e080d8c346", date: "2026-08-03",
    title: "Refresh in-app changelog for dialog fixes",
    changes: [
      { category: "fixed", text: "The in-app history now records the verified 71db2c6 overlay, editor, host-key, CopyParams, rights, and SiteTree fixes with complete links and bilingual copy. The changelog now knows which button escaped.\\n\\nApp 入面嘅歷史而家記低已驗證嘅 71db2c6 overlay、editor、host-key、CopyParams、rights 同 SiteTree 修正，連埋完整 link 同雙語 copy；changelog 而家知道邊粒 button 走失咗。" },
    ],
  },
  {
    id: "71db2c6", kind: 'commit', ref: "71db2c6", oid: "71db2c6a28e762c6519f134b572160abc9818d88", date: "2026-08-03",
    title: "Harden dialogs, overlays, and site navigation",
    changes: [
      { category: "changed", text: "Dialogs now keep failed host-key answers open for retry, editor saves serialize immutable snapshots, CopyParams rejects unsafe values, rights validation refuses malformed modes, SiteTree persists only safe navigation state, and narrow modals scroll without hiding actions. Focused tests and docs follow each boundary, so the UI can stop playing hide-and-seek with the buttons.\\n\\nDialog 而家遇到 host-key delivery fail 會留低畀人 retry，editor save 用 immutable snapshot 排隊，CopyParams 唔收危險值，rights 唔收古怪 mode，SiteTree 只記安全 navigation state，窄 modal 會 scroll 但唔會藏起 actions。測試文件跟齊，等 UI 唔好再同啲 button 玩捉迷藏。" },
    ],
  },
  {
    id: "461e050", kind: 'commit', ref: "461e050", oid: "461e050e2b93d9052dd77c7c33042d7212012dcc", date: "2026-08-03",
    title: "Refresh geometry wave handoff metadata",
    changes: [
      { category: "fixed", text: "The handoff now records the 3,235-pass regression run, Docker smoke, the c274856 and 5652951 milestones, and the honest 59.0% coverage with 114 units outstanding. It reports the project, not a fairy tale about the project.\\n\\nHandoff 而家記低 3,235 pass regression、Docker smoke、c274856 同 5652951 milestone，仲有老實嘅 59.0% coverage 同 114 個未完成 unit。佢報告緊個 project，唔係 project 嘅童話故事。" },
    ],
  },
  {
    id: "5652951", kind: 'commit', ref: "5652951", oid: "56529510cafa7fa1d605d1b9970785e1db8ec8e4", date: "2026-08-03",
    title: "Refresh in-app changelog for CLI geometry fixes",
    changes: [
      { category: "changed", text: "The in-app history now includes the verified c274856 CLI output, configuration-root, geometry, queue, reconnect, and SCP changes with complete links and bilingual copy. The changelog now has enough breadcrumbs to find the window edge.\\n\\nApp 入面嘅歷史而家收錄已驗證嘅 c274856 CLI output、configuration root、geometry、queue、reconnect 同 SCP 修正，連埋完整 link 同雙語 copy；changelog 而家有足夠麵包屑搵返個 window edge。" },
    ],
  },
  {
    id: "c274856", kind: 'commit', ref: "c274856", oid: "c274856d2332c201b2f48b4fe4bb2f535747da9f", date: "2026-08-03",
    title: "Harden CLI output, geometry, queue, and SCP",
    changes: [
      { category: "removed", text: "Headless drag/drop JSON is compact unless --pretty is requested, extension roots resolve environment and relative paths, window bounds keep a visible edge, reconnect prompts coalesce, parallel queue failures abort siblings, and SCP overwrite removes only the exact destination before copying. Tests and docs make the behavior auditable, so the code can stop losing the plot in six different file formats.\\n\\nHeadless drag/drop JSON 預設 compact，想靚啲先用 --pretty；extension root 識環境同 relative path，window bounds 留返 visible edge，reconnect prompt 合併，queue 平行失敗會收掣，SCP overwrite 只刪 exact destination 先 copy。測試文件都對齊，等 code 唔好喺六種 file format 入面一齊迷路。" },
    ],
  },
  {
    id: "8d3a02e", kind: 'commit', ref: "8d3a02e", oid: "8d3a02ef5f1f74e0a237f8979eac0ade2065550b", date: "2026-08-03",
    title: "Refresh CLI boundary handoff metadata",
    changes: [
      { category: "fixed", text: "The handoff now records the 3,227-pass regression run, Docker smoke, the 1e1c543 and 2a2d946 milestones, and the honest 59.0% coverage with 114 units outstanding. The successor gets the real state, not a motivational poster.\\n\\nHandoff 而家記低 3,227 pass regression、Docker smoke、1e1c543 同 2a2d946 milestone，仲有老實嘅 59.0% coverage 同 114 個未完成 unit。交接畀 successor 嘅係真 state，唔係勵志海報。" },
    ],
  },
  {
    id: "2a2d946", kind: 'commit', ref: "2a2d946", oid: "2a2d946a3bca56fc46d931fa63eee5e42ba9d078", date: "2026-08-03",
    title: "Refresh in-app changelog for CLI boundary work",
    changes: [
      { category: "changed", text: "The in-app history now includes the verified 1e1c543 headless CLI, console, SFTP cleanup, RemoteFiles, reconnect, and Preferences changes with full links and bilingual copy. The changelog now knows the command line has entered the room.\\n\\nApp 入面嘅歷史而家收錄已驗證嘅 1e1c543 headless CLI、console、SFTP cleanup、RemoteFiles、reconnect 同 Preferences 修正，連埋完整 link 同雙語 copy；changelog 終於知道 command line 入咗場。" },
    ],
  },
  {
    id: "1e1c543", kind: 'commit', ref: "1e1c543", oid: "1e1c54392fd27c023399c85434ddbc32f7edc7c2", date: "2026-08-03",
    title: "Expand headless CLI and harden lifecycle boundaries",
    changes: [
      { category: "added", text: "The winscp-com wrapper now supports help and version without launching the console, ConsoleRunner turns invalid stream modes into exit code 1, reconnect cancellation wins over retries, failed SFTP handshakes clean up every socket, remote-file lists reject malformed duplicates, and Preferences gains keyboard tree navigation. Tests and docs follow each boundary, so the CLI can do its job without summoning a window-shaped ghost.\\n\\n而家 winscp-com 有 help 同 version，唔會偷開 console；ConsoleRunner 遇到壞 stream mode 會回 exit code 1，cancel 會贏過 reconnect，SFTP handshake 爆咗會清晒 socket，remote file list 唔收壞 duplicate，Preferences tree 又識用鍵盤行。測試文件一齊跟，CLI 做嘢唔使召喚視窗鬼魂。" },
    ],
  },
  {
    id: "6942a18", kind: 'commit', ref: "6942a18", oid: "6942a18028d57fe11b3537e93d77758005f7887c", date: "2026-08-03",
    title: "Refresh interaction wave handoff metadata",
    changes: [
      { category: "fixed", text: "The handoff now records the 3,220-pass regression run, Docker evidence, the 9412e5b and d443d90 milestones, and the honest 59.0% coverage with 114 units outstanding. The paperwork is following the code at a brisk walk.\\n\\nHandoff 而家記低 3,220 pass regression、Docker evidence、9412e5b 同 d443d90 milestone，仲有老實嘅 59.0% coverage 同 114 個未完成 unit。文件用快步追住 code，冇再迷路。" },
    ],
  },
  {
    id: "d443d90", kind: 'commit', ref: "d443d90", oid: "d443d9078e5acdab1d72d5772653ca5a44658cd0", date: "2026-08-03",
    title: "Refresh in-app changelog for interaction fixes",
    changes: [
      { category: "fixed", text: "The in-app history now records the verified 9412e5b interaction, queue, checklist, malformed-row, and WebDAV fixes with real links and bilingual copy. The changelog remembers the plot, even when the plot involves a 405 response.\\n\\nApp 入面嘅歷史而家記低已驗證嘅 9412e5b interaction、queue、checklist、壞 row 同 WebDAV 修正，連埋真 link 同雙語 copy；就算劇情係 405 response，changelog 都冇失憶。" },
    ],
  },
  {
    id: "9412e5b", kind: 'commit', ref: "9412e5b", oid: "9412e5b1ee72923e8d529f4dab43c42490ddb288", date: "2026-08-03",
    title: "Fix palette, shortcuts, queue, checklist, and WebDAV",
    changes: [
      { category: "fixed", text: "Command-palette destinations stay keyboard-reachable, context menus borrow only exact shortcuts, directory checklist selection includes descendants, queue cancellation stops delayed writes, malformed panel rows become honest diagnostics, and WebDAV MKCOL verifies a 405 resource is really a directory. Regression tests, localized copy, docs, and a genuine Electron smoke capture keep the edges from doing improv comedy.\\n\\nCommand palette 仍然畀鍵盤行到，context menu 只借 exact shortcut，checklist 包埋子目錄，queue cancel 唔再偷偷寫 delayed chunk，panel 壞 row 會老實報告，WebDAV 遇到 405 會驗清楚係咪真係 directory。測試、翻譯、文件同真實 Electron capture 一齊補齊，等啲邊界唔好再即興加戲。" },
    ],
  },
  {
    id: "f8d2a55", kind: 'commit', ref: "f8d2a55", oid: "f8d2a55b6c839cf5811877a90e0700615d938eb8", date: "2026-08-03",
    title: "Refresh hardening handoff metadata",
    changes: [
      { category: "changed", text: "The handoff now records the 7d90403 and 92a9211 milestones, the verified 3,213-pass suite, and the honest 59.0% coverage with 114 units still outstanding. The paperwork has finally caught up with the code instead of chasing it down the corridor.\\n\\nHandoff 而家記低 7d90403 同 92a9211、已驗證嘅 3,213 pass 測試，同埋老實嘅 59.0% coverage 及 114 個未完成 unit。文件終於追返上 code，唔使再喺走廊追住份紙跑。" },
    ],
  },
  {
    id: "92a9211", kind: 'commit', ref: "92a9211", oid: "92a921191ee5b397d7fcd9026b3d66c9714dc032", date: "2026-08-03",
    title: "Refresh in-app changelog for hardening wave",
    changes: [
      { category: "fixed", text: "The in-app history now includes the verified 7d90403 configuration, crypto, mask, storage, and WinAPI fixes with full commit links and bilingual copy. The changelog no longer forgets the latest plot twist.\\n\\nApp 入面嘅歷史而家收錄已驗證嘅 7d90403 設定、crypto、mask、storage 同 WinAPI 修正，連埋完整 commit link 同雙語 copy；changelog 唔再漏咗最新一幕。" },
    ],
  },
  {
    id: "7d90403", kind: 'commit', ref: "7d90403", oid: "7d9040307ce9bcbe971ab34f9aea4ac3e325f697", date: "2026-08-03",
    title: "Harden config, masks, crypto, storage, and WinAPI",
    changes: [
      { category: "fixed", text: "Configuration imports now re-protect clear-text secrets, crypto rejects malformed base64 envelopes, editor masks follow WinSCP wildcard rules, storage normalizes duplicate keys, and WinAPI dispatch accepts only safe own methods. Regression tests and focused documentation cover each boundary so the code stops improvising at the edges instead of making the edges do stand-up comedy.\\n\\n設定匯入會重新保護明文秘密，crypto 會拒絕古怪 base64，editor mask 跟足 WinSCP 萬用字元，storage 會整理重複 key，WinAPI 只准安全嘅 own method。測試同文件一齊補齊，等啲邊界位唔好再自己加戲。" },
    ],
  },
  {
    id: "2eb26e3", kind: 'commit', ref: "2eb26e3", oid: "2eb26e3320bd65c64dea1997cbc52d147fc3def2", date: "2026-08-03",
    title: "Fix protocol, session, UI, and changelog gaps",
    changes: [
      { category: "security", text: "English: Tighten the seams where the port was confidently pretending: stale FTP resumes, EOF reads, secret loading, login validation, panel reachability, editor IPC, and current changelog links now have real guards and tests.\\n\\nCantonese: 執返啲 port 扮緊冇事嘅位：FTP resume 唔再留垃圾尾、EOF 唔再扮 network error、secret 唔亂出、login 同 panel 真係有門，editor IPC 同 changelog 亦有憑有據。" },
    ],
  },
  {
    id: "0c43eb7", kind: 'commit', ref: "0c43eb7", oid: "0c43eb78968f9afb9e40afcd0115b21a33b874db", date: "2026-08-03",
    title: "Refresh final handoff metadata",
    changes: [
      { category: "changed", text: "English: Record the pushed tip, synchronized remote, and fresh genuine Electron boot capture so the handoff stops wearing yesterday's nametag.\\n\\nCantonese: 更新已推送嘅 commit、同步遠端同真實 Electron 啟動畫面，等 handoff 唔使再戴住尋日張名牌。" },
    ],
  },
  {
    id: "e9d01ca", kind: 'commit', ref: "e9d01ca", oid: "e9d01cad8792af6cebf6db7256c30197ca265a21", date: "2026-08-03",
    title: "Refresh handoff after CLI smoke",
    changes: [
      { category: "changed", text: "English: Record the final test count, coverage ledger, Docker evidence, and the exact headless CLI commit so the handoff does not bluff about the remaining roadmap.\\n\\nCantonese: Handoff 更新到真數，3197 個測試同 Docker 兩路證據逐樣寫低；未完成嘅 114 個單位繼續企喺度，唔會畀百分比化妝。" },
    ],
  },
  {
    id: "755036b", kind: 'commit', ref: "755036b", oid: "755036b95e3e666acb6688da9aff03a48866325f", date: "2026-08-03",
    title: "Add headless CLI and Docker diff smoke",
    changes: [
      { category: "added", text: "English: Add the full console-compatible winscp entry point, deterministic drag/drop simulation commands, real SFTP/FTP Docker verification, and a structured-clone-safe sync.apply response. Validate bad CLI input before it can turn into a confident wrong plan, and keep Docker credentials out of process arguments.\\n\\nCantonese: 個 CLI 終於識做嘢，拖放唔再靠估，兩部 Docker server 幫手照妖；sync.apply 唔再攞住活生生嘅 queue 過 Electron 關口，密碼亦唔再喺 command line 周街派街坊。" },
    ],
  },
  {
    id: "4e4d883", kind: 'commit', ref: "4e4d883", oid: "4e4d883ac5e509e850d67c4db522c5deb253e8a1", date: "2026-08-03",
    title: "Record final pushed security handoff",
    changes: [
      { category: "fixed", text: "English: The generated handoff and the fresh real Electron capture now describe the verified security tip together, so the paperwork no longer trails the bug fix like a confused queue item.\\n\\nCantonese: Generated handoff 同新鮮真實 Electron 截圖而家一齊講緊已驗證嘅 security tip，文件唔再似迷路 queue item 咁追唔上修正。" },
    ],
  },
  {
    id: "cbfeeb1", kind: 'commit', ref: "cbfeeb1", oid: "cbfeeb1fa38134e5adfc0b1b6303de3e74910d13", date: "2026-08-03",
    title: "Refresh handoff after security fix",
    changes: [
      { category: "fixed", text: "English: The handoff now names the security-parser fix and its green 3,190-test evidence, so the status page has stopped hiding behind yesterday's screenshot.\\n\\nCantonese: Handoff 而家寫埋 security parser 修正同綠燈 3,190 測試證據，唔再躲喺尋日張截圖後面扮冇事。" },
    ],
  },
  {
    id: "5d7648a", kind: 'commit', ref: "5d7648a", oid: "5d7648ac63e649934bc32a71293ba74b0dd05f69", date: "2026-08-03",
    title: "Validate damaged scrambled password headers",
    changes: [
      { category: "fixed", text: "English: A flipped padding byte could cosplay as a length header and make the decoder give up early. Validate every candidate against the full blob, preserve the self-synchronizing format, and document the fail-closed behavior; the security regression and real smoke capture are included.\\n\\nCantonese: Padding byte 一反轉就扮 length header，decoder 即刻提早收工。依家逐個 candidate 對完整 blob 驗身，保留 self-synchronizing 格式，寫低 fail-closed 規則，security regression 同真實 smoke 截圖一併入貨。" },
    ],
  },
  {
    id: "9cf2684", kind: 'commit', ref: "9cf2684", oid: "9cf2684dc25ae5f0bbd9baf40943b1390587eef7", date: "2026-08-03",
    title: "Refresh final handoff and smoke evidence",
    changes: [
      { category: "changed", text: "English: The final handoff and its real Electron capture now travel together, because a report that describes a screenshot left behind is just a detective novel with the last page missing.\\n\\nCantonese: 最後份 handoff 同真實 Electron 截圖一齊出發，唔好留低一份講緊失蹤證據嘅偵探小說但冇最後一頁。" },
    ],
  },
  {
    id: "cfc9631", kind: 'commit', ref: "cfc9631", oid: "cfc9631155f11a7b19660d5003b566d7a3983c48", date: "2026-08-03",
    title: "Refresh handoff after smoke evidence",
    changes: [
      { category: "changed", text: "English: The handoff now points at the smoke-evidence commit and records the green local suite, so its progress meter is less fictional than a queue with no items.\\n\\nCantonese: Handoff 而家指住 smoke evidence 個 commit，同埋記低本地綠燈測試，個進度表唔再似一條冇貨嘅 queue 咁虛構。" },
    ],
  },
  {
    id: "ecd6ef0", kind: 'commit', ref: "ecd6ef0", oid: "ecd6ef0b228a4004440688a1d2245417b64a041d", date: "2026-08-03",
    title: "Refresh genuine Electron smoke capture",
    changes: [
      { category: "changed", text: "English: The smoke test left behind a real renderer capture, so keep the evidence instead of letting the screenshot vanish into the test runner's snack drawer.\\n\\nCantonese: Smoke test 留低咗真實 renderer 截圖，留返份證據，唔好畀佢跌入 test runner 個點心櫃消失。" },
    ],
  },
  {
    id: "e1909fd", kind: 'commit', ref: "e1909fd", oid: "e1909fd3d5c31fd908010fb882900f2c93c2b177", date: "2026-08-03",
    title: "Normalize Windows coverage checks and target panel fixtures",
    changes: [
      { category: "added", text: "English: The coverage checker no longer treats CRLF as a hostile new dialect, and the keyboard smoke stops mistaking the checkout for its temp folder. Normalize report newlines and wait for the actual fixture filename before testing End and Insert.\\n\\nCantonese: Coverage checker 而家唔會當 CRLF 係另一種外星文法，keyboard smoke 亦唔會將 checkout 誤認做 temp folder。統一換行，再等真係見到 fixture 個檔名先測 End 同 Insert。" },
    ],
  },
  {
    id: "4b86bb2", kind: 'commit', ref: "4b86bb2", oid: "4b86bb2d11c279d410d2bc6c310833e561d8d4a6", date: "2026-08-03",
    title: "Refresh handoff after CI stabilization",
    changes: [
      { category: "changed", text: "English: The handoff now reports the real 3,190-test result instead of leaving the project wearing an old status badge like a wet paper crown.\\n\\nCantonese: Handoff 而家講真實 3,190 個測試結果，唔再戴住舊 status badge 當紙皇冠咁扮完成。" },
    ],
  },
  {
    id: "4378808", kind: 'commit', ref: "4378808", oid: "43788087cf4e1716d90b5470dcb5f5a967cc82da", date: "2026-08-03",
    title: "Fix CI coverage checkout and anchored smoke races",
    changes: [
      { category: "changed", text: "English: The queue popover was still wearing the progress window's centring hat, while CI's coverage test was counting an empty upstream cupboard. Give the anchored selector enough specificity to stay inside the viewport, wait for the real keyboard focus before issuing Insert, and check out the read-only WinSCP reference submodule so the ledger cannot quietly inspect zero units.\\n\\nCantonese: Queue popover 仲戴住 progress window 嗰頂置中帽，CI coverage 仲對住個空櫃數零件。加返夠力嘅 selector、等真實 focus 落定先撳 Insert，再 checkout 只讀 WinSCP reference submodule，等 coverage 唔會扮冇嘢做。" },
    ],
  },
  {
    id: "50233a0", kind: 'commit', ref: "50233a0", oid: "50233a09522f551ed1c7c4e43f47af8cf0c8c63c", date: "2026-08-03",
    title: "Refresh real Electron smoke capture",
    changes: [
      { category: "changed", text: "The smoke harness captured the current boot surface after the final renderer changes, so the tracked evidence now matches the tested application instead of an older frame." },
    ],
    changesYue: [
      { category: "changed", text: "最後一次 smoke test 影到最新 boot surface，張相而家同真正測過嘅 app 對得上，唔再拎舊畫面扮新鮮。" },
    ],
  },
  {
    id: "5d0e67a", kind: 'commit', ref: "5d0e67a", oid: "5d0e67adabb98848965d704ca15f8fdace22d48d", date: "2026-08-03",
    title: "Port core session, protocol, UI, and transfer seams",
    changes: [
      { category: "changed", text: "The port now wires the remaining session, protocol, preference, panel, synchronization, notification, resource, and foreground-transfer seams through production contracts, with focused regressions, real Electron/SFTP smoke coverage, categorized docs, and regenerated handoff ledgers. The code's old loose ends were less connected than a dim sum steamer with the lid missing; they now at least arrive on the same queue, with cancellation and cache races called out honestly." },
      { category: "changed", text: "今次補返 session、protocol、preference、panel、同步、notification、resource 同 foreground transfer 嘅真實接駁，仲加埋測試、Electron/SFTP smoke、分類文件同 handoff ledger。之前啲 code seam 鬆過茶樓蒸籠個冚，而家起碼同一條 queue 入場，cancel 同 cache race 都有實話實說。" },
    ],
  },
  {
    id: "20c2b38", kind: 'commit', ref: "20c2b38", oid: "20c2b38499ab8e35bb00ad6966b6a89f40af3bda", date: "2026-08-02",
    title: "Refresh the post-packaging handoff",
    refs: ["#15", "#26", "#27", "#28"],
    changes: [
      { category: "changed", text: "English: The handoff now records the green 3,021-test suite, the measured Squirrel artifacts, the 31 MB app archive, and the one harness-owned screenshot still rewritten by smoke tests. The report has receipts instead of vibes." },
      { category: "changed", text: "Cantonese: Handoff 而家有齊 3,021 個測試、Squirrel artifact、31 MB app archive，同埋個 smoke harness 會自己改寫嘅 screenshot；今次有單有據，唔靠感覺吹水。" },
      { category: "changed", text: "Verification: node tools/handoff.js; node site/build.js --verify; 67 site tests passed." },
      { category: "changed", text: "Refs #15 #26 #27 #28" },
    ],
  },
  {
    id: "8935691", kind: 'commit', ref: "8935691", oid: "89356917eefcbca33b61617d909d383f0416dd7b", date: "2026-08-02",
    title: "Record the packaging guard in the changelog",
    refs: ["#15"],
    changes: [
      { category: "changed", text: "English: The changelog now tells the truth about the packaging guard and its measured artifacts, so the app does not pretend the multi-gigabyte asar was a feature." },
      { category: "changed", text: "Cantonese: Changelog 而家老實交代個 packaging guard 同實測 artifact，唔會再將幾 GB 嘅 app.asar 當成「豪華版」功能。" },
      { category: "changed", text: "Verification: node --test test/changelog.test.js test/packaging.test.js (44 passed)." },
      { category: "changed", text: "Refs #15" },
    ],
  },
  {
    id: "12dd655", kind: 'commit', ref: "12dd655", oid: "12dd6555a08866e5a7f73919a8b8a7650fc23ff3", date: "2026-08-02",
    title: "Exclude agent worktrees from Electron packages",
    refs: ["#15"],
    changes: [
      { category: "fixed", text: "English: The packager was swallowing linked-agent worktrees and even yesterday's output, turning a tidy Windows app into a multi-gigabyte asar. Ignore the local checkout maze and pin the guard with a regression test." },
    ],
    changesYue: [
      { category: "changed", text: "Cantonese: 打包器之前食晒 agent worktree，同埋連舊 out 都一齊吞，個 app.asar 大到似要搬屋。依家封鎖本地迷宮，仲用測試睇實佢唔好再食錯嘢。" },
      { category: "changed", text: "Verification: node --test test/packaging.test.js; npm run package; npm run make; RELEASES SHA-1 and byte count match the NuGet; portable zip has 73 entries and no .claude or out content." },
      { category: "changed", text: "Refs #15" },
    ],
  },
  {
    id: "5788976", kind: 'commit', ref: "5788976", oid: "578897671b21203d48593cf554699660b3bbb945", date: "2026-08-02",
    title: "Record the final smoke-tested handoff",
    refs: ["#26", "#27", "#28"],
    changes: [
      { category: "fixed", text: "Refresh the generated handoff after the Windows dirty-path fix. It now records 3019 tests with 3018 passing, one skip, zero failures, the current commit, and exactly one remaining tracked e2e screenshot capture.\\n\\nRefs #26 #27 #28" },
      { category: "changed", text: "Windows dirty path 修好之後再 refresh handoff，而家寫實 3019 條測試、3018 過、1 skip、0 衰，commit 同埋仲剩低嗰一張 tracked e2e screenshot 都講清楚。\\n\\nRefs #26 #27 #28" },
    ],
  },
  {
    id: "c212107", kind: 'commit', ref: "c212107", oid: "c2121077afc156012137b95180f54c0213b92601", date: "2026-08-02",
    title: "Use the set size for the handoff count",
    refs: ["#26", "#27", "#28"],
    changes: [
      { category: "changed", text: "The name-list rewrite deduplicates dirty paths in a Set, so the report must read size rather than the old array length. Keep the smoke test honest: undefined is not a count, it is the tool shrugging at its own arithmetic.\\n\\nRefs #26 #27 #28" },
      { category: "changed", text: "name-list rewrite 用 Set 去重，所以 handoff 要讀 size，唔可以仲用舊 array length。smoke test 個數字要講人話：undefined 唔係 count，係個工具對住自己份 arithmetic 聳吓膊頭。\\n\\nRefs #26 #27 #28" },
    ],
  },
  {
    id: "883b33f", kind: 'commit', ref: "883b33f", oid: "883b33f10adeb369fe7e8f310fa9d69a9fb0d0ae", date: "2026-08-02",
    title: "Count handoff dirt from Git name lists",
    refs: ["#26", "#27", "#28"],
    changes: [
      { category: "removed", text: "Use git diff, cached diff, and untracked name lists instead of guessing where a Windows porcelain status line starts. The report no longer loses the H from HANDOFF.md when that file is staged, so its smoke-test state can converge honestly.\\n\\nRefs #26 #27 #28" },
      { category: "changed", text: "唔再估 Windows porcelain status 行由邊格開始，改用 git 嘅 unstaged、staged 同 untracked name list。HANDOFF.md 就算 staged 都唔會畀 parser 食咗個 H，smoke test 個狀態終於可以老實收斂。\\n\\nRefs #26 #27 #28" },
    ],
  },
  {
    id: "225b7ae", kind: 'commit', ref: "225b7ae", oid: "225b7ae08d0d29a2fa222e70156218eea5812600", date: "2026-08-02",
    title: "Trim Windows status paths before counting handoff dirt",
    refs: ["#26", "#27", "#28"],
    changes: [
      { category: "changed", text: "Git status lines carry CRLF on this host, so the generated handoff failed to recognise its own HANDOFF.md path and counted it as user work. Trim the parsed path before excluding generated outputs, keeping the report honest on Windows too.\\n\\nRefs #26 #27 #28" },
      { category: "changed", text: "Windows 個 git status 行帶 CRLF，之前 handoff parser 認唔到自己個 HANDOFF.md，於是無端端當佢係 user work。解析完 trim 返條 path，再排除 generated output，Windows 個報告都講返真話。\\n\\nRefs #26 #27 #28" },
    ],
  },
  {
    id: "cb56f8a", kind: 'commit', ref: "cb56f8a", oid: "cb56f8a1cbe7f126a27e27fe108a0477f4488129", date: "2026-08-02",
    title: "Keep generated handoff state self-consistent",
    refs: ["#26", "#27", "#28"],
    changes: [
      { category: "changed", text: "The handoff generator now excludes HANDOFF.md and ROADMAP.md from its own dirty count. Without that guard, the report counted the files it had just rewritten and became stale the moment its generated output was committed.\\n\\nRefs #26 #27 #28" },
      { category: "changed", text: "handoff generator 而家唔再將自己重寫緊嘅 HANDOFF.md 同 ROADMAP.md 計入 dirty count。之前份報告一寫完就算兩份文件未 commit，commit 完又即刻講錯；而家個數字終於同佢留下嘅狀態對得返。\\n\\nRefs #26 #27 #28" },
    ],
  },
  {
    id: "5853825", kind: 'commit', ref: "5853825", oid: "58538258002af6485c21e9568ccaf014bffa8073", date: "2026-08-02",
    title: "Refresh the verified handoff and roadmap",
    refs: ["#26", "#27", "#28"],
    changes: [
      { category: "fixed", text: "Regenerate the successor record from the current ledger, the real 3019-test run, the current commit history, and the live issue list. The handoff now reports the actual 3018 passing tests and carries the three current bug reports instead of the closed issue that had overstayed its welcome.\\n\\nRefs #26 #27 #28" },
      { category: "fixed", text: "用最新 ledger、真實 3019 條測試、commit 歷史同 live issue list 重生 handoff 同 roadmap。現時份 handoff 寫實 3018 條過，三單未完 bug 亦有列返，之前已關嗰單唔再霸住個位扮長住客。\\n\\nRefs #26 #27 #28" },
    ],
  },
  {
    id: "c0cf846", kind: 'commit', ref: "c0cf846", oid: "c0cf8466701d333209530d27b282015d30e57180", date: "2026-08-02",
    title: "Document queued symlink planning in the changelog",
    refs: ["#26"],
    changes: [
      { category: "fixed", text: "The in-app changelog now links the queue fix to commit 640d1f4, so the shipped explanation and the code share one exact breadcrumb. A changelog entry without a real commit is just a rumour wearing a bullet point.\\n\\nRefs #26" },
      { category: "changed", text: "內置更新記錄而家連返 640d1f4，queue 修正同說明有同一條真 breadcrumb。冇真 commit 嘅 changelog 條目，只係一粒著住 bullet point 外套嘅傳聞。\\n\\nRefs #26" },
    ],
  },
  {
    id: "640d1f4", kind: 'commit', ref: "640d1f4", oid: "640d1f4f795d987b98fb1dadf610ca93b0ddf50c", date: "2026-08-02",
    title: "Align queued local symlink planning with foreground transfers",
    refs: ["#26"],
    changes: [
      { category: "fixed", text: "Queued local-upload planning now follows the same directory-symlink rule as the foreground engine, while remote-source plans keep the explicit followDirectorySymlinks guard. The old queue had two opinions about one folder; this makes the folder stop asking which route it took. Regression coverage proves the symlink content arrives and the empty-directory plan stays honest.\\n\\nRefs #26" },
    ],
    changesYue: [
      { category: "changed", text: "佇列上載本機資料夾而家同前景引擎一樣，會落入本機 directory symlink；remote source 就繼續要明確開 followDirectorySymlinks 先跟。之前同一個 folder 走兩條路有兩套意見，搞到個資料夾都唔知自己應該係邊個。測試釘實檔案真係到，空目錄計劃亦唔再扮嘢。\\n\\nRefs #26" },
    ],
  },
  {
    id: "328be29", kind: 'commit', ref: "328be29", oid: "328be291df179949d48d32d986e51ac0c747b7c0", date: "2026-08-02",
    title: "Record funny-level disclosure capture",
    changes: [
      { category: "fixed", text: "Capture the real desktop disclosure that explains funny levels style every message while facts stay fixed, with both independent language sliders visible. The screenshot is evidence, not UI wallpaper: the code has to do the talking while this file keeps the receipt." },
    ],
    changesYue: [
      { category: "changed", text: "呢張係真 desktop 影相，講清楚 funny level 只改語氣，兩條語言 slider 都真係見到。唔係攞張 wallpaper 嚟扮功能，個 code 要做嘢，張相就負責留底。" },
    ],
  },
  {
    id: "8f3b126", kind: 'commit', ref: "8f3b126", oid: "8f3b126a0224e87bdbd98667c20d198e5ab189b4", date: "2026-08-02",
    title: "Fix what the verifiers caught: a lost \"on completion\" action, and two false claims",
    refs: ["#28"],
    changes: [
      { category: "changed", text: "Three defects, all found by the wave's own adversarial verifiers rather than by the agents that wrote the code. Two of the three branches were refuted on this basis; both verifiers said the remedy was a corrective commit rather than discarding the work, and they were right." },
      { category: "fixed", text: "1. A REAL REGRESSION. With \"Keep completed items for\" set to \"Do not keep them\" — a real user choice — the sweep runs synchronously the moment an item finishes, so by the time the queue went idle the item asking to disconnect was no longer in `items` and _onceDoneAction found nothing. The user picked \"on completion: disconnect\", the transfer completed, and the app stayed connected: a per-item choice silently cancelled by an unrelated DISPLAY preference, with no error anywhere. The request is now taken when the item finishes rather than read back off a list a sweep is allowed to empty, and cleared after the idle announcement so it cannot answer for the next batch. Both halves are tested and both fail without the fix." },
      { category: "fixed", text: "2. A CITATION THAT SAID THE OPPOSITE. ipc.js credited the immediate sweep to TTerminalQueue::SetKeepDoneItemsFor (Queue.cpp:1126). That function assigns the field under a guard and stops — it is conspicuously the ONLY setter in that block that does not call TriggerEvent(), which SetTransfersLimit and SetEnabled both do. The cited lines are evidence against the claim. The behaviour is defensible and stays, now labelled a deliberate divergence with the reason, because a divergence nobody wrote down becomes a bug report." },
      { category: "changed", text: "3. A NUMBER I GOT WRONG AND THEN PROPAGATED. \"Fifteen of the sixteen transfer commands\" was mine — I put it in issue #28 and in the brief, and it reached code, a test and docs/protocol-gaps.md. It is TWELVE. The TRANSFERS table has 16 rows and FOUR carry `queue: 'off'`. The doc sentence even contradicted itself, saying \"the sixteenth\" and then \"the four\". Counted, not recalled." },
      { category: "security", text: "Also: security.sessionReopenBackground left PENDING_KEYS. Two changes from the same wave, one declaring the key dead and the other giving it a consumer, merged with no textual conflict — and the guard caught it, which is the entire point of the guard. The test now asserts the read rather than deleting the case, so removing that supervisor fails loudly instead of the option quietly going back to doing nothing while its row says it works." },
      { category: "changed", text: "3018 tests, 3017 pass, 0 fail — Node 26 and the Node 22 CI pins." },
    ],
    changesYue: [
      { category: "changed", text: "三個問題，全部係嗰一浪自己嘅反駁員執到，唔係寫嘅人自己發現。兩條 branch 因此被 推翻，而兩個反駁員都話應該補一個更正 commit 而唔係掉咗佢 —— 佢哋啱。" },
      { category: "changed", text: "**一個真 bug**：「完成項目唔保留」係一個真嘅選項，開咗之後個清掃即刻行，於是隊列 閒置嗰陣，嗰個叫緊「做完就斷線」嘅項目已經唔喺 `items` 度。用戶揀咗斷線、傳輸完成 咗、然後個 app 照樣連住 —— 一個逐項嘅選擇，被一個純粹係**顯示**用嘅設定靜靜雞取消 咗，仲要一聲都唔出。" },
      { category: "changed", text: "**一句引錯嘅出處**：我哋話個即時清掃係照 `SetKeepDoneItemsFor` 做，但嗰個函數乜都 冇掃，而且係嗰段入面**唯一一個唔叫 TriggerEvent() 嘅 setter** —— 引嚟證明自己嘅嗰 幾行，正正就係反證。行為本身合理，留低，但而家寫明係「特登唔跟原著」同原因。" },
      { category: "changed", text: "**一個我自己數錯、仲傳咗開去嘅數字**：「十六個入面十五個」係我喺 issue #28 同份 指示入面寫嘅，然後入咗 code、測試同文件。**實際係十二個。** 份文件仲自己前後矛盾, 一時話「第十六個」一時話「嗰四個」。數過，唔靠記。" },
    ],
  },
  {
    id: "618ad8d", kind: 'commit', ref: "618ad8d", oid: "618ad8dafb0d48e61cfbd92089166ed90bff168e", date: "2026-08-02",
    title: "Merge branch 'worktree-wf_1e396398-c91-3'",
    changes: [
      { category: "changed", text: "# Conflicts: # design/main/ipc.js # docs/protocol-gaps.md # docs/transfers-and-queue/queue.md" },
    ],
  },
  {
    id: "b675271", kind: 'commit', ref: "b675271", oid: "b67527187de45e0f31c983d57bfc358e1cdcfb74", date: "2026-08-02",
    title: "Merge branch 'worktree-wf_1e396398-c91-2'",
    changes: [
    ],
  },
  {
    id: "56e44da", kind: 'commit', ref: "56e44da", oid: "56e44daec7677862ca6df3bd53be4b1be746a035", date: "2026-08-02",
    title: "Stop the pending-options guard proving its own subject matter consumed",
    changes: [
      { category: "changed", text: "The guard in test/preferences.test.js holds PENDING_KEYS — the options whose rows tell the user \"nothing in this build acts on it yet\" — to exactly the set of options nothing reads. It passed, and it passed for the wrong reason: the scan walked test/ as well as design/, and test/preferences.test.js is the file that asserts every one of those keys by name. The guard was reading its own homework back as proof, so eight options were stored, rendered like working settings, read by absolutely nothing, and warned nobody: beepOnFinish, beepOnFinishAfter, refreshRemotePanelInterval, queue.keepDoneItemsFor, window.minimizeToTray, dDFakeFile, dDDrives, integration.dragExtEnabled." },
      { category: "fixed", text: "Dropping test/ from the walk is the obvious fix and only half of one. Stripping comments too turned up three more: editors.js:589 names editor.warnOrphans in the doc comment above findOrphans() and then never asks it anything, and session.js:532-537 documents four sessionReopen* settings above _scheduleReconnect, which reads two of them. A comment is a promise, not a read." },
      { category: "fixed", text: "The scan now lives in test/helpers/consumer-scan.js and means what it says: a consumer is production code under design/, outside the preferences surface, that READS the key — comments discounted, prose inside a string discounted, tests never. It is a scanner rather than a parser, and it has to handle regular expressions: an earlier draft read the lone quote in /['\"]/ as the start of a string, swallowed every line up to the next quote, and was about to report editor.singleEditor, editor.maxEditors, logging.logFileAppend and integration.externalSessionInExistingInstance as dead. That direction is the expensive one — a consumer the scan cannot see gets called an orphan, and the honest-looking fix is to declare a working option pending, which is precisely the lie the guard exists to stop." },
      { category: "changed", text: "Three of the eleven are now implemented rather than declared:" },
      { category: "changed", text: "queue.keepDoneItemsFor — TTerminalQueue::ProcessEvent's sweep (core/Queue.cpp:1018-1035). 0 drops a completed item at once, <0 keeps it forever, N keeps it N seconds; read live from queuePrefs so a preference change lands on the queue that is already running, with a per-item timer so the last row of a batch expires on time instead of waiting for the next transfer. An item that ERRORED is never swept." },
      { category: "changed", text: "beepOnFinish / beepOnFinishAfter — OperationComplete (CustomScpExplorer.cpp:1695), which for the queue is called on qeEmpty with QueueOperationStart (:8201), so the batch is timed end to end from the moment work arrived at an empty queue. queue.js emits 'beep' because it owns no I/O; ipc.js calls shell.beep()." },
      { category: "changed", text: "The other eight are declared in PENDING_KEYS with a note saying why, which stops the app lying today. defaults.js also claimed beepOnFinishAfter was \"0 = never\"; it is a minimum duration and 0 means no minimum. Nothing read the value, so nothing had ever contradicted the comment." },
      { category: "added", text: "Tests: test/preferences.test.js 54 pass / 0 fail, up from 46 — eight new, for the guard's own failure mode, the two lies it used to swallow and the scan's rules. test/queue.test.js 51 pass / 0 fail, up from 44. With queue.js reverted, queue.test.js is 44 pass / 7 fail and preferences.test.js 52 pass / 2 fail. With PENDING_KEYS reverted, the new guard fails naming exactly the eight undeclared dead options. test/winconfig.test.js 118 pass, unchanged." },
    ],
    changesYue: [
      { category: "changed", text: "--- 粵語 ---" },
      { category: "changed", text: "個守衛自己考自己，仲畀自己滿分" },
      { category: "changed", text: "test/preferences.test.js 個守衛本來要捉「儲得到但冇人理」嘅設定，點知佢連 test/ 都掃埋 —— 而 test/preferences.test.js 正正就係逐個 key 叫晒名嗰份卷。即係攞自己份 答案當證據，於是八個設定：beepOnFinish、beepOnFinishAfter、 refreshRemotePanelInterval、queue.keepDoneItemsFor、window.minimizeToTray、 dDFakeFile、dDDrives、integration.dragExtEnabled，畫到似模似樣，撳落去乜都冇， 仲一句都冇提醒用家。" },
      { category: "changed", text: "淨係唔掃 test/ 都仲未夠。連註解都撇甩之後，再捉多三個：editors.js:589 喺 findOrphans() 上面寫住 editor.warnOrphans，寫完就冇再問過佢；session.js:532-537 列咗四個 sessionReopen*，_scheduleReconnect 只讀兩個。註解係承諾，唔係讀取。" },
      { category: "changed", text: "而家個掃描搬咗去 test/helpers/consumer-scan.js，講到明：consumer 即係 design/ 入面、喺偏好設定介面以外、真係讀嗰個 key 嘅正式碼 —— 註解唔算，字串入面嘅描述唔算， 測試永遠唔算。佢仲要識睇 regex：舊版本見到 /['\"]/ 嗰個單引號就當開字串，一啖吞埋 後面成堆碼，差啲就話 editor.singleEditor、editor.maxEditors、logging.logFileAppend 同 integration.externalSessionInExistingInstance 四個「冇人理」。呢個方向先至最惡： 掃唔到就當死症，跟住順手落 PENDING_KEYS，正正就係個守衛本來要阻止嗰個謊。" },
      { category: "changed", text: "十一個入面有三個真係接好咗線：queue.keepDoneItemsFor 照 core/Queue.cpp:1018-1035 掃走做完嘅項目（0 即刻走、-1 永遠留、N 秒後走；改設定即刻生效，做壞咗嗰啲永遠唔掃）； beepOnFinish 同 beepOnFinishAfter 照 CustomScpExplorer.cpp:1695／:8201，由「空佇列 收到工作」計到「佇列做完」先響一聲，queue.js 出 'beep'，ipc.js 叫 shell.beep()。" },
      { category: "changed", text: "其餘八個老老實實入咗 PENDING_KEYS，每個都寫低點解，至少今日唔會再呃人。順手改返 defaults.js 一句寫錯咗嘅註解：beepOnFinishAfter 唔係「0 = 永遠唔響」，係「最短時間， 0 即係冇下限」—— 之前冇人讀過個值，所以都冇人拆穿佢。" },
    ],
  },
  {
    id: "148b6cc", kind: 'commit', ref: "148b6cc", oid: "148b6cccb0b79e51736f46b083654cbb4f2157fb", date: "2026-08-02",
    title: "Let the queue read \"Keep reconnecting for\", instead of counting to five",
    changes: [
      { category: "added", text: "The queue capped reconnects at a hard-coded 5 (queue.js:319) and never once read security.sessionReopenTimeout, so setting \"Keep reconnecting for\" to twenty minutes bought a queued transfer five attempts. Fifteen of the sixteen transfer commands go through commands.js:529 `backend.queue('add')`; the sixteenth, `queue: 'off'`, goes to the foreground engine and honoured the preference correctly. The setting therefore worked on the one path almost nobody takes, which is the most expensive kind of working." },
      { category: "changed", text: "WinSCP has no queue retry policy to disagree with. TUploadQueueItem:: DoTransferExecute calls TTerminal::CopyToRemote (Queue.cpp:2324), so a queued transfer walks into the same TRobustOperationLoop as a foreground one, and Queue.cpp holds no retry counter anywhere. The 5 was invented here." },
      { category: "changed", text: "So the queue now uses the SAME mechanism rather than a tidier second one: `continueReopen` is lifted out of Terminal into a module function that Terminal.continueReopen also delegates to, and `limitsTransferReconnects` is lifted out of TransferEngine the same way. The queue stamps FStart per item, takes a tfUseFileTransferAny holder from that shared test, and raises it from _recordCps exactly where DoProgress raises FFileTransferAny (Terminal.cpp:2277)" },
      { category: "changed", text: "the queue's only \"a byte actually landed\" seam. maxReconnects survives as an opt-in count for an embedder and defaults to off." },
      { category: "fixed", text: "THE PART THAT LOOKS LIKE THE FIX DOING NOTHING. sessionReopenTimeout ships as 0 (defaults.js:384) and ContinueReopen returns true unconditionally at zero (Terminal.cpp:2461-2463), so at the shipped default this changes no timing at all - it removes a ceiling rather than adding one. And only FTP and FTPS carry a budget in the first place. Both facts have their own tests, because a fix verified only against a non-zero value on an FTP adapter has been verified nowhere most people live. docs/protocol-gaps.md stated the FTP budget without the zero qualifier and now states it." },
      { category: "removed", text: "Reachability came along, because without it none of the above ever runs. ipc.js:343 forwarded `reconnect` through the blanket event loop, which put the live retry/fail callbacks into a structured clone - webContents.send throws on a function and emit swallows that as an undeliverable push - while listenerCount('reconnect') being non-zero switched off queue.js's own unsupervised backoff. The two together meant the blanket forwarder took the decision and then failed to make it: the FIRST dropped connection parked a queued transfer for the life of the process, holding a transfersLimit slot with it. There is now a real supervisor that waits sessionReopenBackground - a preference the docs have promised since they were written and nothing read - then retries, or fails when the session has been closed out from under the item. Five reconnects was never the ceiling users were hitting; zero was." },
    ],
    changesYue: [
      { category: "changed", text: "一句話：個 queue 死牛一邊頸，斷線就數到五，然後收工。你喺設定入面寫「重連二十分鐘」， 佢由頭到尾冇 read 過嗰個 preference。十六個傳送指令有十五個行呢條路，剩返嗰個唔經 queue 嘅反而做得啱晒，堪稱最貴嘅一種「正常」。" },
      { category: "changed", text: "原裝 WinSCP 其實冇呢舊嘢：queue item 一樣係叫 TTerminal::CopyToRemote，行返同一個 loop，Queue.cpp 由頭揾到尾都冇一個重試計數器。嗰個 5 係我哋自己諗出嚟嘅。" },
      { category: "changed", text: "所以今次唔另起爐灶：ContinueReopen 同 limitsTransferReconnects 都抽咗做共用 function， 前台引擎同 queue 一齊叫同一個，唔會再出現「呢邊聽你講，嗰邊當你冇講過」。" },
      { category: "changed", text: "最搞笑嗰橛：sessionReopenTimeout 出廠係 0，而 0 即係「試到天荒地老」。所以喺預設設定 之下，呢個修改一秒都冇改到 —— 佢係拆咗個上限，唔係加咗個上限。零同非零兩邊都寫咗 測試，因為淨係試非零嗰邊，等於試咗一個冇乜人用嘅設定。" },
      { category: "changed", text: "順手救返個更大鑊嘅：ipc.js 之前將 reconnect 同其他 event 一齊掟去 renderer，個 payload 入面有 function，webContents.send 一 clone 就仆街，而 queue 一見到有人聽就唔行自己嗰個 backoff —— 即係有人舉手答問題，舉完手唔出聲。結果第一次斷線，件嘢就企喺度企一世，仲 佔住個傳送位。而家真係有人答佢喇。用家撞到嘅從來唔係「試咗五次」，係「一次都未試完」。" },
      { category: "changed", text: "Tests: test/queue.test.js 44 -> 52 (all 8 new cases fail against the unmodified source: 44 pass / 8 fail), test/terminal.test.js 100 -> 101 (the new case fails without the change). Also green and unchanged: test/transfer.test.js 88, test/sync.test.js 20, test/script.test.js 194, test/dialogs-transfer.test.js 83, on Node 26.5.1 and on CI's Node 22.23.2. The two ipc cases fail by HANGING for two seconds against the old wiring, which is the production symptom exactly. No test asserts the `_reopenStart === null` guard in _run; it is defensive against a zero-based injected clock and against a _pump re-entry, and neither is reachable from a test today." },
      { category: "changed", text: "Not done here: the in-app changelog. It is generated from git log by tools/changelog.js and cannot contain the commit that has not been made yet; it was already stale at a700402 before this change. HANDOFF.md likewise needs the full `npm test` run this worktree deliberately does not do." },
    ],
  },
  {
    id: "f5c7ba9", kind: 'commit', ref: "f5c7ba9", oid: "f5c7ba9a32316fa948d50517ff60a1507020fa6d", date: "2026-08-02",
    title: "Stop the emptiness check walking through symlinks the copy then refuses",
    refs: ["#26"],
    changes: [
      { category: "changed", text: "Issue #26, all three defects, verified against the tree and vendor/ first." },
      { category: "fixed", text: "1. transfer.js isEmptyDirectory recursed on child.type === 'dir' with no CanRecurseToDirectory guard, so it counted the files under a symlinked directory it was never going to follow. WinSCP gates the descent (Terminal.cpp:4727) and counts an unfollowable directory in Stats->Directories only, so `Stats.Files == 0` survives and the parent is empty. Ours said \"not empty\", the copy dutifully mkdir'd the parent, and then sink refused the very same symlink - leaving on disk exactly the empty directory the option exists to prevent. SFTP makes this ordinary rather than exotic: protocols/sftp.js:1311 resolves an S_IFLNK to type:'dir' while keeping isSymlink, so every session with resolveSymlinks on can hit it. The guard is remote-only, because DirectorySource (Terminal.cpp:7852) and directorySource here both walk into any local directory, symlink or not, and a predicate that disagreed with the copy it is predicting would be a different bug wearing the same hat." },
      { category: "changed", text: "2. terminal.js allowRemoteFileTransfer was two thirds of DoAllowRemoteFileTransfer: it had the mask and the .filepart rules and not the cpNoEmptyDirectories clause (Terminal.cpp:5806). A remote count therefore reported directories the copy would then refuse. Bytes never diverged - a directory contributes none - so it hid in stats.directories and in the collected file list a transfer is driven from, while calculateLocalFilesSize honoured the clause and the two sides of one option disagreed with each other. Ported IsEmptyRemoteDirectory as the original builds it: the ordinary size walk with csStopOnFirstFile, excludeEmptyDirectories cleared on the inner copy param (\":6438, to avoid endless recursion\"), and the answer read off Stats.Files. The predicate is async now and calculateFileSize awaits it." },
      { category: "removed", text: "One thing deliberately not copied: the original returns `Params.Result && (Stats.Files == 0)` and Params.Result is untouched by a listing that failed under csIgnoreErrors, so an unreadable directory comes back \"empty\" and is dropped along with everything under it. We also require the listing to have succeeded - the value DoCalculateDirectorySize returns and the original computes and discards (:4785/:4810). Agreeing with the copy is the whole job." },
      { category: "changed", text: "3. queue.js _buildPlan is a second collector and it was one filter apart: IsEmptyLocalDirectory hard-codes DisallowTemporaryTransferFiles=true for its child predicate (:6199), so a local directory of nothing but report.filepart is empty; the queue kept it. It now ignores leftovers when the source is local, drops the files under a directory it prunes (only kind:'dir' entries are mkdir'd, so an orphan is an ENOENT), and recounts files/bytes from the plan that will actually run. The remote asymmetry is preserved: :6441 passes the caller's flag through and the copy path never sets it, so a remote directory of leftovers is genuinely not empty." },
      { category: "removed", text: "Recursion bound: MAX_EMPTY_DIRECTORY_DEPTH = 128, in isEmptyDirectory only. The remote side no longer needs it once CanRecurseToDirectory is in, but the local side is unguarded by design and a POSIX /a/link -> /a yields /a/link/link/link/... forever. calculateFileSize already had its guard at terminal.js:2733, so isEmptyRemoteDirectory did not get a second one. The answer at the bound is the conservative one an unreadable directory already gets: not empty." },
      { category: "added", text: "Tests, each proven by reverting the source hunk and leaving the tests: test/transfer.test.js 92 pass / 0 fail (90/2 without the transfer.js hunk; the parent directory was created as '/l/d/linky', and the cyclic listing answered \"empty\" after 1001 listings) test/terminal.test.js 105 pass / 0 fail (100/5 without the terminal.js hunk; directories 3 vs 2, 5 vs 2, 4 vs 2, and isEmptyRemoteDirectory absent) test/queue.test.js 47 pass / 0 fail (46/1 without the queue.js hunk; '/r/tree/leftovers' and '/r/tree/numbered' survived the prune) Three of the new cases are controls that pass either way and are labelled as such in the file: followDirectorySymlinks putting the link back in scope, the local upload still descending into a directory symlink, and a .filepart beside a real file still going up." },
      { category: "changed", text: "docs/protocol-gaps.md: the Partial row now describes the depth bound, the unreadable-directory divergence, and the one gap left standing - queue.js:810 skips a symlinked directory on both sides, so a queued upload of a local directory symlink is skipped where the engine uploads it." },
      { category: "changed", text: "---" },
    ],
    changesYue: [
      { category: "changed", text: "唔好再跟住條 symlink 行落去，行完個 copy 又話唔要" },
      { category: "changed", text: "同一個掣三宗罪，睇過 vendor/ 先落手：" },
      { category: "changed", text: "一、isEmptyDirectory 見到 type 係 'dir' 就衝入去，冇問過 CanRecurseToDirectory。條 symlink 指去嘅目錄入面有檔案，佢就當個阿爸「唔 空」，個 copy 乖乖 mkdir 咗個阿爸出嚟，跟住 sink 一睇：symlink 喎，唔跟。硬係 整咗個空目錄出嚟 —— 而「唔理空目錄」呢個掣，存在嘅意義就係唔好整呢啲嘢。 WinSCP 見到跟唔到嘅目錄，淨係 Directories++，Files 一個都唔加，所以佢話「空」。 本地嗰邊照舊唔加閘，因為 directorySource 真係會行入去；個預言同個現實要講同一 句話。" },
      { category: "changed", text: "二、allowRemoteFileTransfer 得三分之二 —— mask 同 .filepart 有，空目錄嗰句冇。 所以「計大細」數到嘅目錄，個 copy 跟住就唔要。Bytes 冇錯（目錄本身零 byte）， 錯喺目錄數同埋成個 transfer 靠嚟行嘅檔案清單；而本地嗰邊一直做啱，同一個掣兩 邊講唔同嘢。而家照 WinSCP 寫法搬過嚟。得一樣故意唔照抄：原著開唔到個目錄都當 「空」，連入面啲嘢一齊唔要；我哋要求真係 list 得成先算數。" },
      { category: "changed", text: "三、queue.js 係第二個收集器，差咗一個篩：本地目錄入面淨係得 report.filepart， WinSCP 當空，佢當有嘢。而家補返，連帶被剪走嘅目錄底下啲檔案一齊剪（唔剪就 mkdir 唔到，ENOENT 等緊你），數目同 bytes 都重新數過。遠端嗰邊唔郁 —— 原著本 身就係唔對稱。" },
      { category: "changed", text: "遞歸上限 128 層，淨係加喺 isEmptyDirectory。遠端有咗 symlink 嗰道閘就唔驚，但 本地係特登唔加閘嘅，`/a/link -> /a` 可以行到天光。行到上限就答「唔空」，同開唔 到個目錄一樣咁保守。" },
      { category: "changed", text: "測試：transfer 92 全過（唔改 source 就 90/2）、terminal 105 全過（100/5）、 queue 47 全過（46/1）。有三個係對照組，兩邊都過，已經喺檔案入面寫明。" },
    ],
  },
  {
    id: "a700402", kind: 'commit', ref: "a700402", oid: "a700402a82eb0ed49aa7f5e73a304ab602be8450", date: "2026-08-02",
    title: "Make starting a site a labelled button, not just the first row of a list",
    changes: [
      { category: "added", text: "WinSCP puts New Site at the top of the site tree and offers no button. This port copied that faithfully, and faithful turned out not to mean findable: the row carries no affordance saying it is the way to begin, so once a few sites are saved the list reads as *saved sites* and the one row that is really a command looks like an entry nobody has filled in yet." },
      { category: "added", text: "The row is untouched. This adds a second, labelled way to reach it, next to Manage and Tools — which is what the tree's own `add` icon has been promising all along." },
      { category: "added", text: "It also resets. select() re-runs onSelect even when the node is already current, so clicking New Site while a half-filled new site is on screen starts over — the same thing Manage ▸ Reset does, one click closer." },
      { category: "added", text: "Verified against the running app rather than by reading: with a saved site loaded the host field reads `probe.example`, and after clicking the button it is empty and the tree selection has moved to New Site. The e2e test asserts exactly that, and asserts the CLEARING rather than only the selection — a button that moved the highlight without clearing the form would look right and quietly start the user from someone else's settings." },
      { category: "added", text: "Fails without the change: \"the site manager must expose New Site as a button, not only as a tree row\". e2e-app 37/37, full suite 2980 tests / 2979 pass / 0 fail on Node 26." },
      { category: "changed", text: "The screenshot is the real dialog, captured through the project's own harness running on an off-screen desktop, so nothing appeared on anyone's screen." },
    ],
    changesYue: [
      { category: "changed", text: "WinSCP 本身就係將「New Site」擺喺個站點樹最頂，冇掣。呢個 port 照抄咗，但係「忠於 原著」唔等於「搵得到」：嗰行completely冇任何跡象話畀你聽佢係開始嘅地方，所以你一 儲咗幾個站點之後，成個 list 睇落就係「已儲存嘅站點」，而唯一一行其實係指令嘅，就 好似一個未填完嘅項目咁。" },
      { category: "changed", text: "嗰行冇郁過。呢個係第二條有名有姓嘅路，擺喺 Manage 同 Tools 隔籬 —— 其實個樹自己 嗰個 `add` 圖示一路都係咁承諾緊。" },
      { category: "changed", text: "順便仲識 reset：喺已經揀咗 New Site 嘅時候再撳，會重新開過。" },
      { category: "changed", text: "係對住真嘅 app 驗嘅，唔係睇 code 估：載入咗一個已儲存站點之後 host 係 `probe.example`, 撳完個掣就變空，而且個樹跳咗去 New Site。個測試特登 assert 埋「會清空」而唔淨係 assert「揀咗邊行」—— 一個郁咗高亮但冇清空表單嘅掣，睇落一模一樣，但會靜靜雞用返 上一個站點嘅設定開始。" },
    ],
  },
  {
    id: "a1eb363", kind: 'commit', ref: "a1eb363", oid: "a1eb363c4b8472398ff7d2af87ccb8e8fcb63385", date: "2026-08-02",
    title: "The site is live: production renders, and the download button is a real installer",
    refs: ["#29"],
    changes: [
      { category: "removed", text: "#29 said the repository advertised a URL where every path 404s. It no longer does. This is the capture of https://ding-ding-projects.github.io/material-winscp/ itself — production, not a local server — taken through the same headless harness at the same 1400x1000 as the \"before\"." },
      { category: "changed", text: "The Pages workflow ran for the first time and went green, and configure-pages enabled Pages on its own, which was the one step nobody could verify in advance." },
      { category: "changed", text: "/ 200 /content.js 200 /app.js 200 /lib/router.js 200 /app.css 200 /404.html 200" },
      { category: "changed", text: "The download button is the part worth checking rather than admiring. The rule is that it must carry an immutable release asset URL from a verified manifest, or not exist. The local build showed the second half working — no manifest, no button, and a sentence saying so. Production shows the first:" },
      { category: "changed", text: "https://github.com/.../releases/download/v0.1.465/WinSCP.Material.0.1.465.Setup.exe ranged fetch HTTP 206 first two bytes MZ — a real Windows executable Content-Length 130,823,168 bytes = 124.8 MB" },
      { category: "changed", text: "which is exactly what the button says: \"Version 0.1.465 · 124.8 MB\". Not a guessed URL, not a link to a tag page, not a number typed next to a link that points somewhere else." },
    ],
    changesYue: [
      { category: "changed", text: "#29 個原文係話「個 repo 賣廣告嗰條網址，每一頁都係 404」。而家唔係喇。呢張相影嘅 係**線上真嘅網站**，唔係本機 server，同「之前」嗰張用返一模一樣嘅方法同尺寸。" },
      { category: "changed", text: "Pages workflow 第一次行就綠，而且 configure-pages 自己開咗 Pages —— 呢一步之前 係冇人驗證得到嘅。" },
      { category: "changed", text: "個下載掣先係要查嘅嘢，唔係影完就算。規矩係：要用可驗證嘅 release asset 真 URL, 唔係就唔好出個掣。本機 build 示範咗後半（冇 manifest 就冇掣，仲寫明點解）；線上 示範咗前半 —— 抓真嗰個檔案返嚟，206、MZ 開頭、130,823,168 bytes，即係 124.8 MB, 同個掣上面寫嘅一個字都唔差。" },
    ],
  },
  {
    id: "867c17c", kind: 'commit', ref: "867c17c", oid: "867c17c1aaabd4f9656d22d81b2459ed20056926", date: "2026-08-02",
    title: "Capture the site rendering for the first time, and record what is still not done",
    refs: ["#29"],
    changes: [
      { category: "changed", text: "The \"after\" half of #29, taken through the same headless harness at the same 1400x1000 as the \"before\", so the pair is comparable rather than merely adjacent." },
      { category: "added", text: "Home renders 58 articles across 12 category cards in Material Design 3. Settings renders five sub-tabs with theme, accent, contrast, density, three font controls and a per-row \"Reset this\". Opening Settings adds a second tab to the strip, which is how you can tell the tab strip is real and not a picture of one." },
      { category: "changed", text: "Verified here rather than taken on trust — the wave's two adversarial verifiers never ran, so this stands in for them:" },
      { category: "changed", text: "node site/build.js --verify VERIFY OK, 27 files, exit 0 test/site-build.test.js + test/site-app.test.js 67/67 independent grep of the built output for remote subresources none" },
      { category: "changed", text: "The 36 app tests are not decoration either: catastrophic regex shapes refused before they run, zero-width matches advancing instead of spinning, every colour notation reading back as the same colour, real WCAG contrast, the two funny levels proven independent, and the dim sum draw pinned to its advertised chance." },
      { category: "changed", text: "Two things the screenshots show that are correct rather than missing:" },
      { category: "changed", text: "No installer button. The page links only a release asset it can verify, and there is no release manifest yet, so it says so instead of guessing a URL." },
      { category: "changed", text: "\"Settings are stored in this browser only\" — said out loud rather than implied." },
      { category: "changed", text: "STILL NOT DONE, and none of it is bundled into a claim that it is: Pages is not enabled, pages.yml has never run, and the site is therefore still 404 in production. The infra agent flagged that `configure-pages` may lack the scope to enable Pages on its own. #29 stays open until a deploy is green." },
    ],
    changesYue: [
      { category: "changed", text: "呢個係 #29 嘅「之後」，用返同一套 headless 工具、同一個 1400x1000 影，所以兩張先 至叫得上係一對可以比較嘅圖。" },
      { category: "changed", text: "首頁出到 58 篇文、12 張分類卡，正正經經嘅 Material 3。設定頁有五個子分頁、主題、 主色、對比、密度、三個字體控制，逐行仲有「Reset this」。㩒入設定會喺分頁列多開一 個分頁 —— 咁你就知嗰條分頁列係真嘅，唔係影出嚟嘅。" },
      { category: "changed", text: "因為嗰浪兩個反駁員一個都冇跑到（撞正 session limit），所以呢度係我自己驗： `--verify` 綠、67/67 測試過、獨立 grep 過 build 出嚟嘅嘢冇任何遠端資源。" },
      { category: "changed", text: "有兩樣嘢張相「冇」，但係啱嘅：冇安裝檔掣（因為未有可驗證嘅 release，佢寧願講明都 唔會作條 URL 出嚟）；同埋佢自己講明「設定淨係存喺你部瀏覽器」。" },
      { category: "changed", text: "**未搞掂嘅照講**：Pages 未開、`pages.yml` 一次都未行過，所以線上仲係 404。#29 唔會 喺呢度收，要等真係部署到綠先算。" },
    ],
  },
  {
    id: "8132450", kind: 'commit', ref: "8132450", oid: "8132450d0d9edbd4294bac86166b2d8d5841af55", date: "2026-08-02",
    title: "Merge branch 'worktree-wf_7340eadd-163-2'",
    changes: [
    ],
  },
  {
    id: "b9061ef", kind: 'commit', ref: "b9061ef", oid: "b9061efbfc953a552c9274be79c5b03f72a6da01", date: "2026-08-02",
    title: "Restore connection creation and introduce a proper app mark",
    changes: [
      { category: "added", text: "The app now recovers from malformed configuration, exposes New connection through every desktop route, refreshes saved sites, attaches successful sessions, and lets password authentication proceed when Pageant is absent. The old identity crisis is also over: one vector mark now drives the title bar, About view, BrowserWindow, and deterministic Windows icon." },
    ],
    changesYue: [
      { category: "changed", text: "壞設定檔而家識得留低備份再安全起身；新增連線亦唔再玩捉迷藏，儲存站點、接上工作階段同冇開 Pageant 嘅密碼登入全部行得通。個 app 終於唔使再四圍借樣：同一個向量標誌包辦標題列、About、視窗同 Windows 圖示。" },
    ],
  },
  {
    id: "ef5f10f", kind: 'commit', ref: "ef5f10f", oid: "ef5f10f2d9ff746d41a40e0686cc6cbe6bf05868", date: "2026-08-02",
    title: "Write the site's client application, which had never existed",
    changes: [
      { category: "added", text: "index.html referenced app.css and app.js; `git log --all --diff-filter=A` found no commit that had ever added either. So the documentation site fetched two 404s and rendered an empty <main> — one of the four reasons every path under the repository's advertised homepage came back empty, the root included. The stylesheet the page needed to look like anything, and the script that turns 58 generated articles into a site, were simply not in the tree." },
      { category: "changed", text: "They are now: site/src/app.css, site/src/app.js and fourteen modules under site/src/lib/. Plain ES modules, loaded straight by the browser, no bundler and no build step beyond site/build.js. `node site/build.js --verify` goes from \"2 problems\" to VERIFY OK: 12 categories, 58 articles, 6 bundled images, 27 files, exit 0." },
      { category: "fixed", text: "What it does, and the bug each part exists to avoid:" },
      { category: "changed", text: "HASH ROUTER, not the History API, because Pages has no rewrite rule and /material-winscp/protocols/sftp is a request for a file that does not exist. Article ids and in-page anchors are ambiguous by shape — the builder emits #/cat/article-anchor and every slug has hyphens — so resolution is a lookup for the longest known id, not a parse." },
      { category: "changed", text: "THE SKIP LINK IS NOT A ROUTE. href=\"#main\" is correct markup and also, on a hash-routed page, a navigation to \"/main\" that renders the 404. Intercepted." },
      { category: "changed", text: "SEARCH with a regex builder ANCHORED BESIDE EVERY FIELD, never one global dialog applying to whichever field was touched last. Plain text is the default, regex is opt-in, and the two directions stay in sync. One predicate object serves a filter and its inverse, so \"containing\" and \"not containing\" cannot drift apart on casing or flags." },
      { category: "changed", text: "CATASTROPHIC PATTERNS REFUSED BEFORE THEY RUN, including (a|aa)*b — which hangs exactly as hard as (a+)+$ and contains no nested quantifier at all. JavaScript has no regex timeout, so refusing the shape is the only defence." },
      { category: "added", text: "MATERIAL 3 derived at runtime from one seed, light and dark, both shipped as a floor in CSS so the first paint is styled before any module runs. Tonal palettes in OKLab rather than a second copy of the app's CAM16 — said out loud in the docs, because the same seed lands a shade away from the desktop app's." },
      { category: "changed", text: "AN INFINITE COLOUR PICKER, continuous field plus numeric entry, translating across fourteen notations. Every string it prints reads back as the same colour; that round trip is a test, not a promise." },
      { category: "changed", text: "TABS with a real overflow surface. `flex: 0 0 auto` is load-bearing: as shrinkable flex items tabs squeeze to a sliver of ellipsis instead of overflowing, so the strip always \"fits\", the measurement has nothing to move, and every tab is on screen with none of them readable. Measured synchronously, because requestAnimationFrame does not fire in a page that is not painting — which is precisely when nobody is watching." },
      { category: "changed", text: "THE INSTALLER BUTTON POINTS AT A PROVEN URL OR DOES NOT EXIST. site/build.js reads an optional release manifest (generated by pages.yml with `gh release view`, git-ignored, never committed) and drops any asset whose URL is not the immutable /releases/download/<tag>/ form. No manifest, no button, and a sentence saying the page will not guess. Exercised against the real v0.1.464 release: it rendered the actual Setup.exe URL at 125.9 MB." },
      { category: "changed", text: "THREE LANGUAGE MODES AND TWO FUNNY SLIDERS, and the dim sum surprise at its advertised 10%, from the bundled catalog, with alt text that names the dish." },
      { category: "fixed", text: "The verifier learned one thing too: a module import is a subresource. `import … from './lib/pages.js'` is a fetch that appears in no src=, href= or url(), and one missing lib/ file fails the whole module graph — a blank page, not a degraded one. That is the original bug one level down, so it is now a build failure with the importer named." },
      { category: "fixed", text: "Four bugs the browser found, fixed rather than documented: the settings search spread its terms string into individual characters, so every multi-letter query matched nothing; Ctrl+Arrow reordering was swallowed by the plain-Arrow case in the same switch, advertising a shortcut that did nothing; the bulk-close field sat off-screen where nobody could type into it; and the inverse of \"contains X\" read \"does not contains X\" in a destructive confirmation." },
      { category: "fixed", text: "Tests: test/site-app.test.js, 36 tests, all passing on Node 26.5.1 and Node 22.23.2. With site/src/lib/, app.js and app.css moved aside, 0 pass and 36 fail. test/site-build.test.js goes 22 to 31; the five release-manifest tests and the two module-import tests fail against the previous builder. One test there asserted the repository must STAY broken (--verify exits 1 because app.js is absent) — rewritten to assert the same property against a tree where the file is deliberately removed, plus a new test that the real repository verifies clean." },
      { category: "changed", text: "Not done, and worth someone's time: no screenshots (the browser pane would not composite), the Pages workflow has still never run, Pages is still not enabled, tab groups are not implemented, and there is no command palette. HANDOFF.md was not regenerated because `node tools/handoff.js` runs the whole suite." },
      { category: "changed", text: "---" },
    ],
    changesYue: [
      { category: "changed", text: "粵語版：呢個網站個 client app 由頭到尾冇存在過" },
      { category: "changed", text: "index.html 一直叫緊 app.css 同 app.js，但 `git log --all --diff-filter=A` 話你知， 呢兩個檔案由開天闢地到而家都未 commit 過。即係話個文件網站每次開，都係老老實實 去攞兩個 404 返嚟，然後畀你睇個空白 <main>。難怪 repo 個 homepage 寫住個網址， 入面每一條路徑都係 404，連個 root 都唔例外。" },
      { category: "changed", text: "而家寫咗喇：app.css、app.js 加 lib/ 入面十四個 module，純 ES module，瀏覽器直接 load，除咗 site/build.js 之外冇第二個 build step。`node site/build.js --verify` 由「2 problems」變成 VERIFY OK——12 個分類、58 篇文章、6 張本地點心相、27 個檔案， exit 0。" },
      { category: "changed", text: "每一忽都係為咗擋一個實會中招嘅 bug：" },
      { category: "changed", text: "用 HASH ROUTER 唔用 History API，因為 Pages 冇 rewrite， /material-winscp/protocols/sftp 對佢嚟講就係一個唔存在嘅檔案。文章 id 同錨點 生得一模一樣（builder 出 #/cat/article-anchor，而每個 slug 都有橫線），所以要 「查最長嗰個 id」，唔可以靠 parse。" },
      { category: "changed", text: "SKIP LINK 唔係一條 route。href=\"#main\" 係標準寫法，但喺 hash router 上面就係 navigate 去「/main」，直接彈 404 出嚟。攔咗佢。" },
      { category: "changed", text: "每個搜尋框都有自己貼身嘅 REGEX 建構器，唔係一個全域 dialog 亂咁套落最後撳過 嗰個框。純文字做預設，regex 要自己開，兩邊即時同步。一個 predicate 物件同時 服務「有」同「冇」兩個動作，咁大細楷同 flag 就永遠拗唔到頸。" },
      { category: "changed", text: "會爆嘅式樣行之前就拒絕，包括 (a|aa)*b——佢同 (a+)+$ 一樣咁掛得起成個 tab，但 入面連一個巢狀量詞都冇。JavaScript 冇 regex timeout，唔擋 shape 就冇得擋。" },
      { category: "changed", text: "MATERIAL 3 由一隻種子色即時推出成套配色，深淺色都喺 CSS 度打底，所以未 load 完 module 個頁面都已經有樣。色階用 OKLab 而唔係抄多份 app 嗰套 CAM16——文件寫 明咗，因為同一隻種子色會同桌面版爭少少。" },
      { category: "changed", text: "無限色彩選擇器：連續色域加數值輸入，十四種寫法互譯。佢寫出嚟嘅每一串字， 自己都讀得返同一隻色——呢個係測試，唔係口噏噏。" },
      { category: "changed", text: "分頁有真正嘅 overflow。`flex: 0 0 auto` 唔係裝飾：如果可以縮，啲分頁會縮到淨返 三點省略號，個 strip 就永遠「啱曬位」，量度嗰段永遠冇嘢要搬，結果全部分頁都喺 screen 度但一個都睇唔到個名。量度改成同步做，因為個頁面唔畫 frame 嗰陣 requestAnimationFrame 根本唔會 call——而嗰陣正正就係冇人望住嘅時候。" },
      { category: "changed", text: "安裝檔個掣要有真憑實據先出現：builder 讀一個可有可無嘅 release manifest （pages.yml 用 `gh release view` 生成、gitignore、永遠唔 commit），凡係唔係 /releases/download/<tag>/ 呢個不可變格式嘅 asset 一律唔要。冇 manifest 就冇掣， 仲要寫明「呢版唔會靠估」。實測過真 v0.1.464：出到真正個 Setup.exe 網址， 125.9 MB。" },
      { category: "changed", text: "三種語言模式、兩支搞笑滑桿，仲有 10% 機會出現嘅點心驚喜，用本地相，alt text 叫得出隻點心個名。" },
      { category: "changed", text: "Verifier 都學咗一嘢：module import 都係 subresource。`import … from './lib/pages.js'` 係瀏覽器真係會去攞嘅嘢，但佢唔會出現喺 src=、href= 或者 url() 入面，而少一個 lib/ 檔案就成個 module graph 死埋——白畫面，唔係「差少少」。即係 同一個 bug 低一層，所以而家會 build fail 兼指名道姓話你聽邊個 import。" },
      { category: "changed", text: "用瀏覽器捉返嚟即場修好嘅四個 bug：設定搜尋將搜尋詞成串字串攤成一個一個字母， 搞到打多過一個字母就乜都搵唔到；Ctrl+方向鍵重新排序畀同一個 switch 入面嘅普通 方向鍵食咗，即係 menu 寫住個快捷鍵但撳極都冇反應；批次關閉個輸入框擺咗喺畫面 外面，冇人打得到字入去；仲有「contains X」倒轉之後變咗「does not contains X」， 而佢係出現喺一個刪嘢確認框度。" },
      { category: "changed", text: "測試：test/site-app.test.js 36 個全過，Node 26.5.1 同 Node 22.23.2 都過。 將 site/src/lib/、app.js、app.css 搬走之後：0 過 36 敗。 test/site-build.test.js 由 22 變 31，五個 release manifest 測試同兩個 module import 測試喺舊 builder 上面全敗。嗰度本來有個測試堅持「呢個 repo 一定要壞」 （--verify 一定要 exit 1，因為 app.js 唔喺度）——改成喺一棵刻意抽走檔案嘅樹上面 驗同一件事，再加一個新測試驗真 repo 而家 verify 得乾乾淨淨。" },
      { category: "changed", text: "未做嘅，唔呃你：冇 screenshot（個 browser pane 唔肯 composite）、Pages workflow 到而家一次都未行過、Pages 都仲未開、分頁群組未做、command palette 未做。 HANDOFF.md 冇重新生成，因為 `node tools/handoff.js` 要行成個測試套。" },
    ],
  },
  {
    id: "ccefc76", kind: 'commit', ref: "ccefc76", oid: "ccefc7678dcb9f105b85a249b585066640102526", date: "2026-08-02",
    title: "Refresh the counts this repository states about itself, and stop typing them into prose",
    changes: [
      { category: "changed", text: "The line counter now measures authorship, so the two places that quote its numbers had to be brought in line — and one of them was quoting a figure from nine commits ago." },
      { category: "added", text: "README: the size table said \"measured at 74a92c6\" and had drifted by roughly 4,400 lines. Regenerated from `--markdown` rather than retyped, so it cannot drift by transcription, and it now carries the authorship rows. It also says plainly what it is: a convenience copy, refreshed to match a published release, while the release notes are the record." },
      { category: "changed", text: "docs/tooling.md: two file counts sat in the prose — \"the project (280 files)\" and \"everything the repository tracks (304 files)\". Both were already wrong, by one and by three, because commits landed after they were typed. That file opens by saying a number a person types is a number that quietly stops being true, and then demonstrated it four paragraphs later. The counts are gone; the names of the rows stay, and the tool prints the figures." },
      { category: "changed", text: "The numbers, for the record: 281 files and 242,770 lines in the project, 307 and 250,006 tracked in total. Of the lines still here, 242,765 were written by an agent and 5 by a person — `.gitattributes` and `.gitmodules`, which is exactly what you would expect and is stated without spin in either direction. Attributed total equals counted total, on purpose; if they ever differ the split is withheld rather than published." },
      { category: "changed", text: "60/60 across count-lines, autoupdate and changelog." },
    ],
    changesYue: [
      { category: "changed", text: "個計數器而家識數邊個寫嘅，所以兩個引用佢數字嘅地方都要跟返 —— 其中一個仲要係喺 九個 commit 之前嘅數。" },
      { category: "changed", text: "README 嗰個表寫住「喺 74a92c6 量度」，已經差咗成四千幾行。而家直接由 `--markdown` 生返出嚟，唔靠人手抄，順便加埋作者歸屬。仲寫明咗佢自己係乜：一份方便睇嘅副本， 以已發佈嘅 release 為準 —— 真正嘅紀錄喺 release notes 度。" },
      { category: "changed", text: "`docs/tooling.md` 就更抵笑：入面寫死咗兩個檔案數目，兩個都已經唔啱（一個差一， 一個差三），因為之後又 commit 咗嘢。而嗰份文件開頭第一段就係話「人手打嘅數字， 遲早會靜靜雞變咗唔啱」—— 然後隔咗四段就親自示範咗一次。" },
      { category: "changed", text: "數字放喺呢度作實：專案 281 個檔案、242,770 行；連埋所有 tracked 係 307 同 250,006。 仲喺度嘅行入面，242,765 行係 agent 寫，5 行係人寫（`.gitattributes` 同 `.gitmodules`）。 就係咁，唔往自己面上貼金，亦都唔使唱衰自己。" },
    ],
  },
  {
    id: "bfe5315", kind: 'commit', ref: "bfe5315", oid: "bfe5315278c67c24372a2f4d740e7b8c1ea7bb7b", date: "2026-08-02",
    title: "Count the lines in CI, and name who wrote each one that survived",
    changes: [
      { category: "added", text: "Every release is supposed to state the project's line count, and CI is supposed to be what counts it. Neither half was true: tools/count-lines.js knew how big the project was but had no idea who wrote it, and .github/workflows/ci.yml never ran it at all, so v0.1.459 shipped release notes with no count anywhere in them." },
      { category: "added", text: "Authorship is now attributed PER SURVIVING LINE with `git blame`, never by summing added lines out of `git log`. Churn is not authorship — a line written on Monday and deleted on Tuesday belongs to nobody, and a log-based tally hands the credit to whoever rewrote a file most often. A commit counts as agent-written under exactly two rules, both printed beside the numbers so the split can be re-derived by anyone who doubts it: the author is an automation identity, or the message carries a `Co-Authored-By:` trailer naming an agent. Lines not yet committed get their own row instead of being quietly filed under whoever last touched the file." },
      { category: "changed", text: "Two ways the counter could have lied confidently, both now refused rather than guessed through:" },
      { category: "fixed", text: "A SHALLOW CLONE. `git blame` does not fail on one. It exits 0 and credits every line of every file to the single grafted boundary commit, which on this repository prints a tidy and entirely fictional 100%. The counter detects it, prints no split, and says how to fix it." },
      { category: "removed", text: "ITS OWN ARITHMETIC. The size table counts bytes; the authorship table counts what blame accounted for. Two numbers in one table that disagree destroy the credibility of both, so the split is withheld and the process exits non-zero — which fails the release step instead of publishing it. They currently agree exactly, and only because both drop the empty string after a file's trailing newline, which is the classic way this goes wrong." },
      { category: "changed", text: "The table now also shows the excluded rows in the same table as the totals they are held out of, so \"the project\" (280 files) and \"everything the repository tracks\" (304 files) are two visible numbers rather than one number with a silent asterisk." },
      { category: "changed", text: "CI runs the committed script over the tagged commit, before `npm version` dirties package.json, and build/release-notes.js embeds the result under \"How much code this is\" with the command a reader can reproduce it with. The existing release body is untouched otherwise; a missing measurement says so plainly rather than dropping the section, because an absent section looks exactly like a release that never had one." },
      { category: "changed", text: "Performance: 280 files, ~1.6-2.4s at concurrency 8, against 7.7s serially — one `git blame --porcelain` per file through a small pool, because on Windows the process spawn costs more than the blame does. --porcelain rather than --line-porcelain: the latter repeats the full author header for every line, which on a 49,000-line generated file is ten times the output for information already known from its first occurrence." },
      { category: "fixed", text: "Tests: test/count-lines.test.js, 9 tests, 0 passing before this change and 9 after, on both Node 26 and CI's Node 22. They cover the arithmetic identity (and its per-column form, so a bug that moves lines between scopes cannot cancel out), the trailing-newline rule, a content line that looks like a blame header, both agent rules plus a human co-author that must not be swept into the agent column, the shallow-clone refusal, the markdown rows and both totals summing to their own total, and the CI wiring end to end." },
    ],
    changesYue: [
      { category: "changed", text: "點解要改：條數係要「數」出嚟嘅，唔係打字打出嚟嘅。以前 count-lines.js 淨係識講呢個 project 有幾大，完全唔識講邊個寫，而 CI 更加索性冇 run 過佢， 所以 v0.1.459 個 release notes 一個數字都冇。而家用 `git blame` 逐條「仲喺度」 嘅 line 去計 — 寫咗又刪咗嘅唔算數，唔可以邊個改得最多就當邊個寫。" },
      { category: "changed", text: "兩個扮到好似好準嘅大話，而家一律唔講好過亂噏：shallow clone 嘅時候 blame 唔會炒，佢會笑笑口話你聽成個 repo 都係最尾嗰個 commit 寫嘅，靚仔 100%, 假到冇朋友 — 所以偵測到就唔出數，仲要話你知點救。第二個係佢自己同自己 對唔上數：一張表入面兩個數唔夾,兩個都信唔過,所以寧願唔出,而且直接 exit 1 拉 CI 落水。而家啱啱好對得住,全靠兩邊都記得唔好將檔案尾嗰個換行當一行。" },
      { category: "changed", text: "依家 CI 會喺打 tag 嗰個 commit 度行埋支script,再由 release notes 貼入去, 連點樣自己再行一次都寫埋。280 個檔案 8 條線行 1.6 秒,自己一條線行要 7.7 秒 — Windows 開 process 比 blame 本身仲貴,呢個先係樽頸。" },
    ],
  },
  {
    id: "e701a33", kind: 'commit', ref: "e701a33", oid: "e701a33e8775b7ef3659ed1e6d30cc4c0948c671", date: "2026-08-02",
    title: "Merge branch 'worktree-wf_7340eadd-163-1' into worktree-wf_7340eadd-163-2",
    changes: [
    ],
  },
  {
    id: "eb0939b", kind: 'commit', ref: "eb0939b", oid: "eb0939b316d5a228b57ea28eb33bec5966aa0c3e", date: "2026-08-02",
    title: "Stop --verify exploding on the missing file it exists to report, and publish the site",
    changes: [
      { category: "fixed", text: "site/build.js --verify read app.js and app.css unconditionally and died ENOENT twelve lines before reaching its own \"referenced file is missing from the output\" check. Two files that were never committed made the one report that would have named them crash instead — and since an uncaught exception also exits 1, from the outside it looked exactly like a check doing its job. The site's homepage field has advertised a URL where every path 404s ever since." },
      { category: "changed", text: "verify() now collects and returns every finding instead of throwing at the first one; reportVerify() prints them together and main sets the exit code. Nothing in it reads a file it has not agreed to survive missing. Today it says, in words:" },
      { category: "changed", text: "VERIFY FAILED ✖ referenced file is missing from the output: /material-winscp/app.js ✖ referenced file is missing from the output: /material-winscp/app.css" },
      { category: "changed", text: "app.js and app.css are deliberately still absent. That output is the check working, and it is the next change's finish line." },
      { category: "changed", text: "What it now checks, all of it against the emitted bytes rather than config.json, because a config that merely SAYS the right base is exactly how a site deploys green and 404s on every asset:" },
      { category: "changed", text: "index.html exists and references app.css, app.js and content.js with the prefix;" },
      { category: "changed", text: "no root-absolute URL anywhere in the emitted HTML, CSS or JS lacks that prefix — src, <link href> and url(), the three things a browser fetches;" },
      { category: "changed", text: "every referenced local file really exists, checked against the file listing so it stays case-sensitive on Windows the way Pages is in production;" },
      { category: "changed", text: "no {{PLACEHOLDER}} survived the copy;" },
      { category: "changed", text: "nothing fetches another host;" },
      { category: "changed", text: "content.js parses and was generated for the same base as the markup." },
      { category: "changed", text: "An <a href> is deliberately not a subresource, and content.js is exempt from the two text-shaped heuristics: it is generated prose, and an article documenting this builder is allowed to quote \"{{BASE}}\" without failing the build. It is not exempt from the precise scan, so an <img src> pointing at a CDN still fails." },
      { category: "changed", text: "The copy loop walks subdirectories. It used to `continue` on any directory, which meant the client app had to be three files at the top of site/src/ forever: split it into modules and the build stayed green while shipping none of them. A skipped directory reports nothing at all." },
      { category: "added", text: ".github/workflows/pages.yml is new, and ci.yml is untouched. Build, verify, run the builder's tests, then actions/deploy-pages — gated by `needs`, so a failing verify uploads nothing. ubuntu-latest and no npm ci, because the builder needs node:fs and node:path and nothing else. The base path comes from configure-pages' own output rather than a guess, and an empty value falls back to site/config.json. Branch filter AND tags-ignore: publishing must never retrigger a build, and this repository has already turned four commits into nine releases by learning that the hard way." },
      { category: "added", text: "Also adds site/README.md, which README.md has been linking to for some time without it existing, and docs/packaging-and-updates/site.md." },
      { category: "fixed", text: "Tests: test/site-build.test.js, 22 tests. 22 pass with this change; 21 of the 22 fail without it. The one that passes either way is the regression guard asserting the real emitted index.html carries the prefix — named here as a guard, not as evidence. The three CLI tests fail on the old builder for behavioural reasons rather than a missing export: \"VERIFY FAILED\" never appears, a source subdirectory never reaches the output, and a complete site with a module in a subdirectory cannot verify green. Verified on Node 26.5.1 and on Node 22.23.2, the version CI pins." },
      { category: "changed", text: "---" },
    ],
    changesYue: [
      { category: "changed", text: "驗證器本來就係為咗嗌「app.js 唔見咗」而寫嘅,結果佢見唔到 app.js 就即刻 ENOENT 爆炸,爆得仲要早過自己嗰句報告成十二行。兩個從來未 commit 過嘅檔案, 成功令到唯一會篤穿佢哋嘅檢查死喺半路;因為未捕捉嘅例外都係 exit 1,喺出面睇 仲以為佢好落力咁做緊嘢。個 homepage 就係咁樣掛住一條每頁都 404 嘅網址。" },
      { category: "changed", text: "而家 verify() 唔再喺第一個問題度死,佢會將所有問題收晒返嚟一次過報,然後先 exit 1。全部檢查都係讀真正 emit 出嚟嘅 bytes,唔係讀 config.json —— 因為 config 講得啱唔代表 emit 出嚟啱,而「build 綠、deploy 綠、每一頁 404」正正就 係咁嚟。少咗個 /material-winscp/ 前綴,成個站就喺網域根目錄度撈嘢食,梗係 撈唔到啦。" },
      { category: "changed", text: "複製迴圈依家識入資料夾。以前見到資料夾就 continue,即係話個 app 一世都只可以 係 site/src/ 頂層嗰三個檔案:一拆 module,build 照樣綠,但係一個 module 都冇 上到船。靜靜雞唔複製,係唔會出聲㗎。" },
      { category: "changed", text: "app.js 同 app.css 依然故意冇喺度。上面嗰兩行 ✖ 就係檢查做緊嘢嘅證據,亦係 下一步嘅終點線。" },
      { category: "changed", text: "新加 pages.yml 負責 build、verify、跑測試,然後先 deploy;ci.yml 一隻字都冇 郁。branch filter 同 tags-ignore 兩樣都留低 —— 出 release 會開 tag,開 tag 又 觸發 build,呢個 repo 已經用四個 commit 生出九個 release 示範過一次,唔使再 示範。" },
      { category: "changed", text: "測試 22 個,有呢個改動 22 個全綠;冇呢個改動 21 個爆。剩返嗰個係防倒退嘅哨兵, 唔算證據,照直講。Node 26.5.1 同 CI 綁定嘅 Node 22.23.2 都跑過。" },
    ],
  },
  {
    id: "6e63642", kind: 'commit', ref: "6e63642", oid: "6e636428026c2d689037901fd4989aa090953db4", date: "2026-08-02",
    title: "Capture what the documentation site actually renders today: nothing",
    refs: ["#29"],
    changes: [
      { category: "changed", text: "Evidence for #29, taken from the real built output rather than described. The site was built, served over HTTP, and rendered in Edge on an off-screen Windows desktop through the low-level computer-use server — headless, so nothing touched the visible desktop." },
      { category: "changed", text: "What the capture shows, and it is worse than \"unstyled\":" },
      { category: "changed", text: "default serif type and blue underlined links — app.css 404s, so there is no Material Design 3 anywhere, only the browser's own stylesheet" },
      { category: "changed", text: "the entire body below the nav is BLANK. 56 articles are generated correctly from docs/ into content.js, and not one of them renders, because app.js 404s and nothing is left to put them on the page" },
      { category: "changed", text: "the skeleton is all there — skip link, title, search field, a few unlabelled buttons, four nav links — which is exactly why this went unnoticed: it looks like a page that is loading rather than a page that cannot load" },
      { category: "changed", text: "Confirmed over HTTP against the built output, so this is not a path-resolution artefact of opening a file directly:" },
      { category: "changed", text: "/material-winscp/ 200 /material-winscp/content.js 200 /material-winscp/app.js 404 /material-winscp/app.css 404" },
      { category: "fixed", text: "This is the \"before\" half. The \"after\" belongs on the fix, from the same harness at the same size, so the pair is comparable rather than merely adjacent." },
    ],
    changesYue: [
      { category: "changed", text: "呢個係 #29 嘅證據，唔係用嘴講，係真係 build 完、serve 出嚟、再喺一個離屏桌面度用 Edge 開嚟影 —— 全程 headless，冇掂過你個熒幕。" },
      { category: "changed", text: "影出嚟仲慘過「冇 CSS」：字體係瀏覽器預設嘅襯線體、連結係藍色底線，因為 app.css 404；而導覽列以下**成版白晒** —— 56 篇文由 docs/ 生成得好地地，一篇都出唔到，因為 app.js 都係 404，冇人負責放佢哋上去。" },
      { category: "changed", text: "最陰險係個骨架仲喺度（跳過連結、標題、搜尋框、幾個掣、四條連結），所以睇落似「載 緊」多過似「載唔到」—— 呢個就係佢可以一直冇人發現嘅原因。" },
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
