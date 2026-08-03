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
  {
    id: "ac29837", kind: 'commit', ref: "ac29837", oid: "ac2983762dde67e310b6148fb0f85e04bbeb742a", date: "2026-08-03",
    title: "Assign IDs during configuration import",
    changes: [
      { category: "fixed", text: "Legacy JSON sites without identifiers now receive generated IDs during load and import, so they remain addressable by update, move, and delete operations. Add regression coverage and document the compatibility behavior." },
      { category: "changed", text: "The importer used to show these sites with no name tag for the toolbox; now every one gets a proper label, 勁過冇牌茶餐廳。" },
    ],
  },
  {
    id: "2960899", kind: 'commit', ref: "2960899", oid: "296089966e9cb0f6031395d3f5ae64e221633b7b", date: "2026-08-03",
    title: "Fix case-insensitive workspace reconnect links",
    changes: [
      { category: "fixed", text: "Keep workspace-link reconnect lookup consistent with case-insensitive stored-site names, and reject mixed-case cycles safely. Add focused regression coverage and document the persistence edge case." },
    ],
    changesYue: [
      { category: "changed", text: "Workspace links 而家唔會因為大小楷玩失蹤；混合大小楷嘅循環都會安全收工，唔再喺重連迷宮入面兜圈。" },
    ],
  },
  {
    id: "bf98db8", kind: 'commit', ref: "bf98db8", oid: "bf98db81d3b7a508d6677d2a3b4758eb013ebe13", date: "2026-08-03",
    title: "Refuse invalid Explorer drop effects",
    changes: [
      { category: "added", text: "Reject NONE, cancel, and unknown shell effects before transfer dispatch so a refused drag can never become an upload. Add focused coverage and document the direct-integration boundary. The drop handler now reads the sign instead of inventing a copy, 唔好亂咁將拒絕變成上載。" },
    ],
  },
  {
    id: "ceff51c", kind: 'commit', ref: "ceff51c", oid: "ceff51c1f58ad12998de05a6fec6c9a6b368c3b4", date: "2026-08-03",
    title: "Refresh editor-wave handoff metadata",
    changes: [
      { category: "changed", text: "English: Record the verified 3,320/3,321 test result, unchanged 59.0% logic coverage, 114 remaining units, and the current editor/config checkpoint. The handoff keeps the breadcrumbs numbered." },
      { category: "changed", text: "廣東話：記低已驗證嘅 3,320/3,321 測試、仍然 59.0% logic coverage、剩低 114 個 units 同今次 editor/config checkpoint。交更紙幫啲麵包屑編埋號。" },
    ],
  },
  {
    id: "9e8c679", kind: 'commit', ref: "9e8c679", oid: "9e8c67979b5abe25dd0351119997358915522934", date: "2026-08-03",
    title: "Refresh in-app changelog for editor and lifecycle hardening",
    changes: [
      { category: "changed", text: "English: Record the editor, terminal, SCP, configuration, and transfer-settings lifecycle wave in the in-app history. The diary now includes the breadcrumbs used to escape the maze." },
      { category: "changed", text: "廣東話：將 editor、terminal、SCP、configuration 同 transfer-settings lifecycle wave 寫入 app history，日記而家都有記低逃出迷宮嗰啲麵包屑。" },
    ],
  },
  {
    id: "abe24d9", kind: 'commit', ref: "abe24d9", oid: "abe24d943e60264d6c1983705b4b84efbe389c0f", date: "2026-08-03",
    title: "Harden editor, terminal, SCP, and configuration lifecycles",
    changes: [
      { category: "added", text: "English: Add editor keyboard commands, propagate nested cancellation, keep WinConfiguration preset selections valid, add SCP checksum fallbacks, make CopyParams remembering one-shot, and support keyboard editor-list reordering. Add focused tests and documentation. The lifecycle machinery now exits the maze with its breadcrumbs intact." },
      { category: "changed", text: "廣東話：補返 editor keyboard commands、nested cancellation、WinConfiguration preset selection、SCP checksum fallback、CopyParams one-shot remember，同 EditorPreferences 鍵盤排序。加 tests 同 docs，lifecycle machinery 終於帶住麵包屑行出迷宮。" },
    ],
  },
  {
    id: "2494d85", kind: 'commit', ref: "2494d85", oid: "2494d8531fe0c7ebea3c3ad40a59417adcb8dbfb", date: "2026-08-03",
    title: "Refresh roadmap-slice handoff metadata",
    changes: [
      { category: "changed", text: "English: Record the verified 3,314/3,315 test result, unchanged 59.0% logic coverage, 114 remaining units, and the current high-weight checkpoint. The handoff is still a map, but the path has fewer potholes." },
      { category: "changed", text: "廣東話：記低已驗證嘅 3,314/3,315 測試、仍然 59.0% logic coverage、剩低 114 個 units 同今次 high-weight checkpoint。交更紙仲係地圖，不過條路少咗幾個窿。" },
    ],
  },
  {
    id: "dfd9fe4", kind: 'commit', ref: "dfd9fe4", oid: "dfd9fe4e9f6c9ff88e7d07bb24e10c0183bbfc9a", date: "2026-08-03",
    title: "Refresh in-app changelog for high-weight roadmap slices",
    changes: [
      { category: "security", text: "English: Record the Login, command, security, LocationProfiles, WebDAV, and S3 wave in the in-app history. The diary now contains fewer dragons hiding behind unchecked controls." },
      { category: "security", text: "廣東話：將 Login、command、security、LocationProfiles、WebDAV 同 S3 呢輪寫入 app history，少啲火龍可以躲喺未驗證嘅掣後面。" },
    ],
  },
  {
    id: "10f6d8a", kind: 'commit', ref: "10f6d8a", oid: "10f6d8a63c0cbd41640b27c372518e0add29c6f8", date: "2026-08-03",
    title: "Harden Login, commands, site security, and S3 WebDAV",
    changes: [
      { category: "added", text: "English: Open nested Login folders in tree order, reopen the queue surface, validate SiteAdvanced encryption keys, cap WebDAV buffered responses, reject incomplete AssumeRole credentials, and add accessible LocationProfiles duplication. Add focused tests and documentation. The protocol edges now bring a clipboard, a seatbelt, and a very strict bouncer." },
      { category: "security", text: "廣東話：Login folder 會按 tree order 開 nested sites、queue surface 會重開、SiteAdvanced encryption key 會驗、WebDAV response 有上限、AssumeRole 唔完整就拒絕，同 LocationProfiles 有 accessible duplicate。加 tests 同 docs，protocol edges 而家有 clipboard、安全帶，同一個好嚴嘅門口保安。" },
    ],
  },
  {
    id: "046c0df", kind: 'commit', ref: "046c0df", oid: "046c0df3a34b70af5933c58f0d8d5cd949c74722", date: "2026-08-03",
    title: "Refresh session-wave handoff metadata",
    changes: [
      { category: "changed", text: "English: Record the verified 3,305/3,306 test result, unchanged 59.0% logic coverage, 114 remaining units, and the current session/surface checkpoint. The handoff keeps the expedition log factual while the trail continues." },
      { category: "changed", text: "廣東話：記低已驗證嘅 3,305/3,306 測試、仍然 59.0% logic coverage、剩低 114 個 units 同今次 session/surface checkpoint。交更紙繼續講真話，隊伍照行。" },
    ],
  },
  {
    id: "6ae0377", kind: 'commit', ref: "6ae0377", oid: "6ae0377e85f37f32c774a2b29eab0e5f726458d9", date: "2026-08-03",
    title: "Refresh in-app changelog for session and surface hardening",
    changes: [
      { category: "changed", text: "English: Record the session, panel, search, bookmark, tooling, and About surface wave in the in-app history. The diary now remembers the buttons that finally learned to speak." },
      { category: "changed", text: "廣東話：將 session、panel、search、bookmark、tooling 同 About surface 呢輪寫入 app history，日記終於記得啲掣學識開口講嘢。" },
    ],
  },
  {
    id: "f61f353", kind: 'commit', ref: "f61f353", oid: "f61f353115f24bedc01661f5412845578aa409d3", date: "2026-08-03",
    title: "Harden session, panel, search, bookmark, and About surfaces",
    changes: [
      { category: "added", text: "English: Expose panel tree visibility, fail closed on empty PATH components, publish live certificate facts safely, add bookmark shortcut enumeration, make FileFind export keyboard reachable, and add About detail copying. Add focused tests and documentation. The small surfaces have stopped hiding useful facts behind one very shy button." },
      { category: "changed", text: "廣東話：補返 panel tree visibility、empty PATH fail-closed、live certificate facts 安全輸出、bookmark shortcut enumeration、FileFind 鍵盤 export，同 About copy details。加 tests 同 docs，細細粒 surface 終於唔再將有用資料收埋喺一粒怕醜掣後面。" },
    ],
  },
  {
    id: "19b22bb", kind: 'commit', ref: "19b22bb", oid: "19b22bb97e47c63a88ee32a53bca3e955f00be6a", date: "2026-08-03",
    title: "Refresh preference-wave handoff metadata",
    changes: [
      { category: "added", text: "English: Record the verified 3,299/3,300 test result, unchanged 59.0% logic coverage, 114 remaining units, and the changelog test correction. The handoff now carries the empty-history edge case without losing the plot." },
      { category: "changed", text: "廣東話：記低已驗證嘅 3,299/3,300 測試、仍然 59.0% logic coverage、剩低 114 個 units，同 changelog test 修正。交更紙帶埋 empty-history edge case，唔會失劇情。" },
    ],
  },
  {
    id: "058e002", kind: 'commit', ref: "058e002", oid: "058e0025ede3ac0461cece1a537b0dc42d8f2951", date: "2026-08-03",
    title: "Refresh changelog and stabilize empty-history coverage",
    changes: [
      { category: "changed", text: "English: Record the preference and protocol wave in the in-app history, and keep the no-recorded-changes test valid when body-less commits roll outside the rolling development window. The changelog now reads the calendar instead of demanding a ghost commit." },
      { category: "changed", text: "廣東話：將 preference 同 protocol wave 寫入 app history，亦令 no-recorded-changes test 唔會因為冇 body 嘅舊 commit 滑出 rolling window 就發脾氣。changelog 而家睇日曆，唔使搵鬼影 commit。" },
    ],
  },
  {
    id: "bf1d6de", kind: 'commit', ref: "bf1d6de", oid: "bf1d6deb9c59d4a601dd80928b89b3d7fe8699df", date: "2026-08-03",
    title: "Harden preferences, SFTP, queue, sync, and import dialogs",
    changes: [
      { category: "added", text: "English: Wire saved transfer options, preserve special SFTP types, append retries behind waiting work, harden keep-up-to-date UI transitions, gate property tags truthfully, and show secret-free known-host algorithms. Add focused tests and documentation. The queue now respects the line, and the dialogs stop pretending every shiny control has a backend." },
      { category: "changed", text: "廣東話：補返 saved transfer options、保留 SFTP special types、retry 排隊唔插隊、keep-up-to-date UI transition、Properties tag capability，同 known-host algorithm 安全預覽。加 tests 同 docs，啲 dialog 終於唔再扮每粒閃閃掣都有 backend，queue 亦識排隊守規矩。" },
    ],
  },
  {
    id: "d5f0b8d", kind: 'commit', ref: "d5f0b8d", oid: "d5f0b8dc6bf1beaa993127636c84a4f280ee7962", date: "2026-08-03",
    title: "Refresh protocol-hardening handoff metadata",
    changes: [
      { category: "changed", text: "English: Record the verified 3,293/3,294 test result, unchanged 59.0% logic coverage, 114 remaining units, and the current protocol/surface checkpoint. The handoff reports the treasure map, not a treasure-shaped sticker." },
      { category: "changed", text: "廣東話：記低已驗證嘅 3,293/3,294 測試、仍然 59.0% logic coverage、剩低 114 個 units 同今次 protocol/surface checkpoint。交更紙畫地圖，唔貼張金色貼紙扮掘到寶。" },
    ],
  },
  {
    id: "e3bec36", kind: 'commit', ref: "e3bec36", oid: "e3bec36f8b04ced8fa1e9e4894d8133f069cb1ed", date: "2026-08-03",
    title: "Refresh in-app changelog for protocol and surface hardening",
    changes: [
      { category: "changed", text: "English: Record the configuration, console, SCP, progress, custom-command, and directory-view hardening wave in the in-app release history. The diary now has fewer mysterious footnotes." },
      { category: "changed", text: "廣東話：將 configuration、console、SCP、progress、custom-command 同 dirview hardening 寫入 app changelog，日記少咗啲神秘腳註，唔使靠估。" },
    ],
  },
  {
    id: "7592b4c", kind: 'commit', ref: "7592b4c", oid: "7592b4ca950d1cebf62a8f680d9fd6f74cded36b", date: "2026-08-03",
    title: "Harden configuration, console, SCP, and progress surfaces",
    changes: [
      { category: "added", text: "English: Roll back failed configuration imports, drain SCP startup output, scope console events by session, validate optional custom-command prompts, announce terminal progress states, and expose directory execution decisions. Add focused tests and documentation. The boundaries now check their passports before crossing, which is excellent news for the tiny state machines." },
      { category: "changed", text: "廣東話：設定匯入失敗會 rollback、SCP 會食走 startup banner、console event 按 session 分流、custom command optional prompt 會驗、progress terminal state 會講清楚，同 dirview 有 ExecuteFile decision。加 tests 同 docs，啲 boundaries 終於識查 passport，細細粒 state machines 安心晒。" },
    ],
  },
  {
    id: "9430464", kind: 'commit', ref: "9430464", oid: "9430464453b81f19bef3640a476797d6ab83bc72", date: "2026-08-03",
    title: "Refresh lifecycle-hardening handoff metadata",
    changes: [
      { category: "changed", text: "English: Record the verified 3,285/3,286 test result, unchanged 59.0% logic coverage, 114 remaining units, and this lifecycle checkpoint. The map stays honest while the expedition keeps moving." },
      { category: "changed", text: "廣東話：記低已驗證嘅 3,285/3,286 測試、仍然 59.0% logic coverage、剩低 114 個 units 同今次 lifecycle checkpoint。張地圖照講真話，隊伍繼續行。" },
    ],
  },
  {
    id: "ec10eab", kind: 'commit', ref: "ec10eab", oid: "ec10eab31515c37c8e2d67000a83b5435f9ed0f2", date: "2026-08-03",
    title: "Refresh in-app changelog for lifecycle hardening",
    changes: [
      { category: "fixed", text: "English: Record the editor, session, sync, authentication, preset, and workspace lifecycle fixes in the in-app release history. The diary now remembers who cleaned up after the last scene." },
      { category: "fixed", text: "廣東話：將 editor、session、sync、authentication、preset 同 workspace lifecycle fixes 寫入 app changelog，日記終於記得邊個執返最後一幕啲道具。" },
    ],
  },
  {
    id: "c95cd9d", kind: 'commit', ref: "c95cd9d", oid: "c95cd9d45a09042bd3528e38457f5b1464a2c68b", date: "2026-08-03",
    title: "Harden editor, session, sync, auth, and workspace lifecycles",
    changes: [
      { category: "added", text: "English: Roll back failed external editor launches, preserve stored-site URL parameters, cancel invalid watchers safely, persist copy presets, expose a secret-free authentication log, and enforce the last local browser floor. Add focused tests and documentation. The lifecycle code now cleans up after its own plot twists instead of leaving props on stage." },
      { category: "security", text: "廣東話：失敗 external editor launch 會 rollback、stored-site URL 唔再食錯 remote path、壞 watcher 會安全停、copy preset 會記住、authentication log 唔掂 secrets，同埋最後一個 local browser 唔畀亂關。加埋 tests 同 docs，lifecycle code 終於識得收拾道具，唔使劇完仲留低一地 props。" },
    ],
  },
  {
    id: "f114157", kind: 'commit', ref: "f114157", oid: "f1141574877ebfe57b8b83b93a928285dd3fb4fd", date: "2026-08-03",
    title: "Refresh boundary-hardening handoff metadata",
    changes: [
      { category: "changed", text: "English: Record the verified 3,279/3,280 test result, unchanged 59.0% logic coverage, 114 remaining units, and the current pushed-wave checkpoint. The handoff keeps the archaeology map honest, even when the treasure is still buried." },
    ],
    changesYue: [
      { category: "changed", text: "廣東話：記低已驗證嘅 3,279/3,280 測試、仍然 59.0% logic coverage、剩低 114 個 units 同今次 checkpoint。張交更紙繼續講真話，寶藏未掘到就唔扮有金光。" },
    ],
  },
  {
    id: "d85b97c", kind: 'commit', ref: "d85b97c", oid: "d85b97ce2fd3b23c84a71a5619b5ee2f462eb1f3", date: "2026-08-03",
    title: "Refresh in-app changelog for boundary hardening",
    changes: [
      { category: "changed", text: "English: Record the terminal, protocol, checklist, and WinApi hardening wave in the in-app release history. The changelog remains the app's small diary, now with fewer plot holes." },
      { category: "changed", text: "廣東話：記低 terminal、protocol、checklist 同 WinApi hardening 呢輪改動，app 嘅細本日記少咗幾個劇情漏洞，讀者唔使估邊個角色突然消失。" },
    ],
  },
  {
    id: "6aee465", kind: 'commit', ref: "6aee465", oid: "6aee4650e0482aad834b4eed080021fbd75b6d86", date: "2026-08-03",
    title: "Harden terminal, protocol, checklist, and WinApi boundaries",
    changes: [
      { category: "added", text: "English: Make batch remote copies transactional, expose RemoteFiles aliases, preserve S3 deletion errors except concurrent 404s, add WebDAV legacy-auth warnings, invert checklist selections accessibly, and provide injected clipboard text handling. Add focused regressions and documentation. The edge cases now wear tiny safety helmets instead of sprinting into traffic." },
      { category: "fixed", text: "廣東話：令批次 remote copy 有 transaction、補返 RemoteFiles aliases、S3 只吞 concurrent 404、WebDAV legacy auth 顯示保安警告、checklist 有 accessibility 反選，同 WinApi 有 injected clipboard text。加埋 regression tests 同文件，啲 edge cases 終於戴返迷你安全帽，唔再衝出馬路。" },
    ],
  },
  {
    id: "c46bd62", kind: 'commit', ref: "c46bd62", oid: "c46bd621848ca83a381cc9e0a72300877ffcbce3", date: "2026-08-03",
    title: "Refresh unit-porting handoff metadata",
    changes: [
      { category: "changed", text: "English: Record the verified 3,271/3,272 test result, 59.0% logic coverage, 114 remaining units, and the current porting checkpoint. The handoff now tells the truth before the next code archaeology expedition." },
      { category: "changed", text: "廣東話：記低已驗證嘅 3,271/3,272 測試、59.0% logic coverage、剩低 114 個 units 同今次 porting checkpoint，交更紙講真話，下一輪考古少啲撞牆。" },
    ],
  },
  {
    id: "6e6f5e3", kind: 'commit', ref: "6e6f5e3", oid: "6e6f5e38610a1ce31ba5a2e5bf2ecbd1c227c9fb", date: "2026-08-03",
    title: "Refresh in-app changelog for unit-porting wave",
    changes: [
      { category: "changed", text: "English: Record the Explorer, editor, preferences, queue, SFTP, and WinConfiguration slice in the in-app release history. The changelog keeps the code's diary so future archaeology needs fewer tiny shovels." },
      { category: "changed", text: "廣東話：將 Explorer、editor、preferences、queue、SFTP 同 WinConfiguration 呢輪改動寫入 app 內置 changelog，等將來考古唔使拎住迷你鏟周圍掘。" },
    ],
  },
  {
    id: "3e1d057", kind: 'commit', ref: "3e1d057", oid: "3e1d057e89a65af7802474eb3ad072dca92f1704", date: "2026-08-03",
    title: "Port Explorer, editor, preferences, queue, SFTP, and WinConfiguration slices",
    changes: [
      { category: "fixed", text: "English: Port local/remote property dispatch, editor clipboard actions, live tab preferences, retry-attempt state, safe SFTP STAT fallback, and portable configuration roots. Add focused regression coverage and documentation. The code now knows which side of the pane it is on, so it can stop playing hide-and-seek with its own settings." },
    ],
    changesYue: [
      { category: "changed", text: "廣東話：補返本地／遠端屬性分流、編輯器剪貼簿操作、即時 tab 偏好、retry attempt 狀態、安全 SFTP STAT 後備，同 portable 設定根目錄，連埋測試同文件一齊上。啲 code 終於分得清左右邊，唔使再同自己啲設定玩捉迷藏。" },
    ],
  },
  {
    id: "48b7a5f", kind: 'commit', ref: "48b7a5f", oid: "48b7a5f83daef650ecbfb405fa90792ab28c3f7f", date: "2026-08-03",
    title: "Refresh dialog protocol handoff metadata",
    changes: [
      { category: "fixed", text: "The handoff now records the 3,262-pass regression run, Docker smoke, the 8557de4 and b01e17a milestones, and the honest 59.0% coverage with 114 units outstanding. The project is moving; the coverage number is not wearing a disguise.\\n\\nHandoff 而家記低 3,262 pass regression、Docker smoke、8557de4 同 b01e17a milestone，仲有老實嘅 59.0% coverage 同 114 個未完成 unit。個 project 有郁，coverage number 就冇戴假鬍鬚扮 100%。" },
    ],
  },
  {
    id: "b01e17a", kind: 'commit', ref: "b01e17a", oid: "b01e17a36f464e9a9e7c19dff7befd80182e896c", date: "2026-08-03",
    title: "Refresh in-app changelog for dialog protocol fixes",
    changes: [
      { category: "fixed", text: "The in-app history now records the verified 8557de4 RemoteTransfer, Progress, CustomCommand, FileFind, Session, and S3 cancellation fixes with full links and bilingual copy. The changelog now has a cancel button for its own memory.\\n\\nApp 入面嘅歷史而家記低已驗證嘅 8557de4 RemoteTransfer、Progress、CustomCommand、FileFind、Session 同 S3 cancellation 修正，連埋完整 link 同雙語 copy；changelog 自己都有粒 cancel button，唔怕失憶。" },
    ],
  },
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
