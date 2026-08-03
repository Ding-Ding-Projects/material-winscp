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
    id: "e91bd48", kind: 'commit', ref: "e91bd48", oid: "e91bd48fa962d535b43b6e5706ab890ffaf007db", date: "2026-08-03",
    title: "Fix CLI, drag-drop, menu, overlay, and history edges",
    changes: [
      { category: "changed", text: "The command line now forwards INI and raw settings, Explorer drops fail closed, menus show platform shortcuts and scroll safely, palette jumps focus their controls, and discard events report whether history recorded them." },
      { category: "removed", text: "CLI 而家識傳 INI 同 raw settings，Explorer drop 唔再亂跌落 current directory，menu 會顯示平台快捷鍵兼識捲，palette 直達真正 control，discard 就老實講有冇寫入 history；啲 edge case 終於唔使再扮魔術。" },
    ],
  },
  {
    id: "7c9fe53", kind: 'commit', ref: "7c9fe53", oid: "7c9fe530a33c48df4cc53fd0e619cfe44f0825da", date: "2026-08-03",
    title: "Record the verified pushed head in handoff",
    changes: [
      { category: "changed", text: "HANDOFF.md now records that origin/main is in sync at d85484b instead of carrying a stale pre-push pointer." },
      { category: "changed", text: "HANDOFF.md 而家記低 origin/main 已經同 d85484b 對齊，唔再揸住推送前嗰條舊 pointer 扮新鮮。" },
    ],
  },
  {
    id: "d85484b", kind: 'commit', ref: "d85484b", oid: "d85484bdab0ee10acfda9bd5ea996f900624f14a", date: "2026-08-03",
    title: "Refresh handoff for the second verified wave",
    changes: [
      { category: "changed", text: "HANDOFF.md now records the 3,377-test baseline, the changelog commit, and the current honest roadmap state." },
      { category: "changed", text: "HANDOFF.md 而家記低 3377 個測試、changelog commit，同埋老實嘅 roadmap 現況；唔會扮 100% 收工。" },
    ],
  },
  {
    id: "88d55a8", kind: 'commit', ref: "88d55a8", oid: "88d55a8aa469f759fe295aa1da38361b9aafd7c1", date: "2026-08-03",
    title: "Update the in-app changelog",
    changes: [
      { category: "fixed", text: "The history now records the verified second wave, with the oldest entries rotated only by the generator's fixed window." },
    ],
    changesYue: [
      { category: "changed", text: "App 入面嘅 changelog 而家記低已驗證嘅第二波；最舊嗰啲係跟 generator 固定窗口自然輪出，唔係 code 偷走咗。" },
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
    id: "09b1239", kind: 'commit', ref: "09b1239", oid: "09b12394a44c05e615a47f855fac8869b90ea073", date: "2026-08-03",
    title: "Refresh handoff for the verified CLI wave",
    changes: [
      { category: "fixed", text: "Refresh HANDOFF.md against the post-fix commit and the verified 3,371/3,372 test result. The ledger now points at the actual current tree instead of last week's archaeological layer." },
    ],
    changesYue: [
      { category: "changed", text: "Handoff.md 而家對準修正後 commit，同埋已驗證嘅 3371/3372 測試結果。個 ledger 終於指向現況，唔再挖緊上星期嘅考古層。" },
    ],
  },
  {
    id: "33d884f", kind: 'commit', ref: "33d884f", oid: "33d884f0f21f345d5a6b1ecd0aebad1d8e34ffef", date: "2026-08-03",
    title: "Record the expanded CLI and protocol fixes",
    changes: [
      { category: "removed", text: "The in-app history now names the verified headless CLI, drag/drop target, checklist, DirView, synchronization, FTP, SFTP, and editor work. The changelog has receipts now, so the code cannot sneak out wearing a fake moustache." },
      { category: "removed", text: "App 入面嘅 history 而家記低已驗證嘅 headless CLI、drag/drop target、checklist、DirView、同步、FTP、SFTP 同 editor 修正。changelog 有齊收據，啲 code 唔可以再戴假鬍鬚扮冇做過嘢。" },
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
    id: "35f0fd5", kind: 'commit', ref: "35f0fd5", oid: "35f0fd5923de44f177167f3cffad45db18a6d5bf", date: "2026-08-03",
    title: "Update handoff for verified lifecycle fixes",
    changes: [
      { category: "changed", text: "Refresh handoff facts for the latest verified test count, coverage, issue count, and artifact count while keeping the handwritten notes intact. The project ledger now knows the queue stopped pretending to be idle." },
      { category: "changed", text: "更新 handoff 入面最新已驗證嘅測試、coverage、issue 同 artifact 數字，保留手寫 notes。個 project ledger 而家知道 queue 唔可以再扮 idle。" },
    ],
  },
  {
    id: "4f16742", kind: 'commit', ref: "4f16742", oid: "4f16742194ff12a22d940705182bdf4bcad73931", date: "2026-08-03",
    title: "Refresh changelog for transfer edge fixes",
    changes: [
      { category: "changed", text: "Record the verified CLI, queue, protocol, configuration, and shell-hardening commit in the in-app history. The changelog now has another receipt, and the gremlins have fewer hiding places." },
      { category: "changed", text: "更新 app changelog，記低已驗證嘅 CLI、queue、協議、設定同 shell hardening commit。今次多張收據，啲小妖怪少幾個匿身位。" },
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
    id: "c02a2a9", kind: 'commit', ref: "c02a2a9", oid: "c02a2a94328ad5fdc71fbb3aab3ed060f87881bf", date: "2026-08-03",
    title: "Update handoff with verified wave status",
    changes: [
      { category: "changed", text: "Refresh the handoff with the generated coverage, test, issue, and artifact facts while preserving the human notes. The dashboard now reports the weather instead of doing interpretive dance." },
      { category: "changed", text: "更新 handoff 入面已驗證嘅 coverage、測試、issue 同 artifact 數字，同時保留手寫 notes。個 dashboard 而家報天氣，唔再跳解讀舞。" },
    ],
  },
  {
    id: "41e2d4c", kind: 'commit', ref: "41e2d4c", oid: "41e2d4c1e7813046ff5ce2c416dd2659331ab4b3", date: "2026-08-03",
    title: "Refresh changelog for accessibility hardening",
    changes: [
      { category: "changed", text: "Record the latest verified implementation commit in the in-app history. The changelog now has receipts instead of vibes, and the protocol gremlins get a dated cameo." },
    ],
    changesYue: [
      { category: "changed", text: "更新 app 入面嘅 changelog，記低最新已驗證嘅實作 commit。今次唔靠氣氛，靠收據；協議小妖怪都有日期出場。" },
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
    id: "3d3efee", kind: 'commit', ref: "3d3efee", oid: "3d3efeed190a89bcd87399bb109dd50bd0d561db", date: "2026-08-03",
    title: "Refresh handoff for protocol and drag wave",
    changes: [
      { category: "added", text: "Update the factual handoff with 59.0% logic coverage, 114 outstanding units, 3347 passing tests plus one skip, the 22-issue scan and the fifth-wave protocol and drag hardening. The signposts are honest, even when the road keeps making new ones.\\n\\n廣東話：handoff 繼續報真數，路牌愈插愈多，但冇一塊係紙紮終點。" },
    ],
  },
  {
    id: "1c63540", kind: 'commit', ref: "1c63540", oid: "1c63540d91544fc704bde4112dfdb180b990576c", date: "2026-08-03",
    title: "Refresh changelog for drag and protocol hardening",
    changes: [
      { category: "fixed", text: "Record the Preferences, Commander drag, shell staging, Terminal, S3 and WebDAV fixes with verified commit links. The changelog now notes that credentials and drag paths both deserve a passport check.\\n\\n廣東話：更新日誌記低 credentials 同 drag path 都要過關，唔係見門就入。" },
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
    id: "599ae98", kind: 'commit', ref: "599ae98", oid: "599ae984e0d4cb3fc164b7440bb15434c8fc0dbd", date: "2026-08-03",
    title: "Refresh handoff for queue and panel wave",
    changes: [
      { category: "fixed", text: "Update the factual handoff with 59.0% logic coverage, 114 outstanding units, 3342 passing tests plus one skip, the 22-issue scan and the fourth-wave queue/session/search/panel/setup fixes. Another pothole is flagged; the cardboard finish line is still unemployed.\\n\\n廣東話：handoff 報清楚多咗幾個測試同新修正，終點紙牌繼續失業，因為條路仲未行完。" },
    ],
  },
  {
    id: "b80efd9", kind: 'commit', ref: "b80efd9", oid: "b80efd97f9f8d89ba30a2a670246ee9368171296", date: "2026-08-03",
    title: "Refresh changelog for queue and platform fixes",
    changes: [
      { category: "changed", text: "Record the queue, session, search, panel, synchronize and setup hardening from the fourth wave with verified commit links. The changelog now documents that zero-result searches and non-Windows shortcuts both mean exactly what they say.\\n\\n廣東話：更新日誌講清楚零結果就係零，非 Windows shortcut 就唔做，唔會畀讀者玩文字魔術。" },
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
    id: "a9b9fb3", kind: 'commit', ref: "a9b9fb3", oid: "a9b9fb3a6976bc07c513281809fd248f1e0d3b42", date: "2026-08-03",
    title: "Refresh handoff for Windows CI correction",
    changes: [
      { category: "fixed", text: "Record the verified Windows newline correction, 3337-test local gate, 59.0% logic coverage, 114 outstanding units and 22 open issues. The handoff now includes the exact fix for the one remote red light instead of hiding it under the carpet.\\n\\n廣東話：handoff 寫清楚今次點樣熄咗嗰盞紅燈，唔會掃埋張地氈下面扮冇事。" },
    ],
  },
  {
    id: "a3d6bc5", kind: 'commit', ref: "a3d6bc5", oid: "a3d6bc513e21efe4741a11e54f81c62a47016632", date: "2026-08-03",
    title: "Record Windows CI newline fix",
    changes: [
      { category: "added", text: "Add the location-profile CRLF-safe test correction to the in-app changelog with its verified commit link. The build diary now notes that Windows newline fashion was the culprit, not the profile logic.\\n\\n廣東話：changelog 記低今次係 Windows CRLF 搞事，唔係 profile logic；換行符號都有自己嘅戲份。" },
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
    id: "2fabb27", kind: 'commit', ref: "2fabb27", oid: "2fabb27c86183c360d5b0c6b49496e1a96a4f630", date: "2026-08-03",
    title: "Refresh handoff for CLI parity wave",
    changes: [
      { category: "fixed", text: "Update the handoff with 59.0% logic coverage, 114 outstanding units, 3337 total tests with one skip, the 22-issue scan, and the verified third-wave CLI and platform fixes. The road map gains another honest signpost, not a cardboard finish line.\\n\\n廣東話：roadmap 再加一塊真路牌，唔會整張紙牌寫住『終點』就當到站。" },
    ],
  },
  {
    id: "128d764", kind: 'commit', ref: "128d764", oid: "128d76451b7f5fec254d0c611fa1e83af64b54c6", date: "2026-08-03",
    title: "Refresh changelog for CLI parity hardening",
    changes: [
      { category: "fixed", text: "Record the third-wave CLI, runner, Preferences, remote-transfer, PATH and SFTP fixes with verified commit links. The changelog now knows the command line can carry a tab without dropping its luggage.\\n\\n廣東話：更新日誌記低 CLI 帶住 tab 都唔會甩喼，runner 同 SFTP 嘅新本領都有 receipts。" },
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
    id: "4355fa1", kind: 'commit', ref: "4355fa1", oid: "4355fa1dc4ce6453f3acacd67295d0df25362cae", date: "2026-08-03",
    title: "Refresh handoff for transfer and security wave",
    changes: [
      { category: "fixed", text: "Update the factual handoff with 59.0% logic coverage, 114 outstanding units, 3331 total tests with one skip, the 22-issue scan and the newly pushed transfer, console, sync and security fixes. The map now marks another stretch of potholes with little flags.\\n\\n廣東話：handoff 再插多幾支小旗，邊度有坑、邊度已經填好，大家揸車唔使靠手感。" },
    ],
  },
  {
    id: "e1df1cc", kind: 'commit', ref: "e1df1cc", oid: "e1df1cc72a128ec6da8667560d8105a2ae22d9d8", date: "2026-08-03",
    title: "Refresh changelog for transfer and security hardening",
    changes: [
      { category: "fixed", text: "Record the transfer, console, remote-file, sync, SiteAdvanced and security edge fixes with verified commit links. The changelog now has receipts for the rakes it removed.\\n\\n廣東話：更新日誌留低晒 receipts，邊支 rake 被收起都睇得返，唔使靠估。" },
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
    id: "33184f0", kind: 'commit', ref: "33184f0", oid: "33184f08ad23cee0b6680c41124d12730a1d8e71", date: "2026-08-03",
    title: "Refresh handoff for CLI and lifecycle wave",
    changes: [
      { category: "fixed", text: "Update the factual handoff with the latest test count, 59.0% logic coverage, 114 outstanding units, open issue scan, and pushed CLI/lifecycle fixes. The handoff reports the map honestly, including the bits where the road is still under construction.\\n\\n廣東話：handoff 清楚報路況，邊段已鋪好、邊段仲係地盤，一樣講真話，唔會用油漆遮住坑洞。" },
    ],
  },
  {
    id: "14afd31", kind: 'commit', ref: "14afd31", oid: "14afd3181ff78de8d76c583d0404f7d513ba0b97", date: "2026-08-03",
    title: "Refresh changelog for CLI and accessibility fixes",
    changes: [
      { category: "removed", text: "Record the pushed CLI drop-classification and progress accessibility changes in the in-app changelog with verified commit links. The changelog now keeps the receipts instead of waving from the balcony.\\n\\n廣東話：changelog 加齊 receipts，唔再淨係喺露台揮手話『有更新㗎喇』。" },
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
