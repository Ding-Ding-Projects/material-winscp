// ui/dialogs/prefpages.js — the Preferences schema and its generic renderer.
//
// Every option WinSCP exposes on its Preferences dialog is declared here once,
// as data. Two things consume that declaration and neither restates it:
//
//   * preferences.js renders the pages, the navigation tree and the search;
//   * copyparams.js renders the transfer-settings frame from the same
//     descriptors, so the Copy dialog and the Preferences page cannot drift.
//
// A descriptor names the dot path of a REAL key in design/main/defaults.js and
// carries that key's real default. test/preferences.test.js checks both against
// defaults.js and fails on a key that does not exist or a default that has
// drifted — a control that writes somewhere nothing reads is exactly the kind
// of "ported" that this repository's mandate refuses.
//
// This module deliberately has no side effects and touches the DOM only inside
// renderControl(), so the schema, the search predicate and the validator all
// run headless in the test suite.
//
// Reference: vendor/winscp/source/forms/Preferences.{dfm,cpp} and the extracted
// control inventory in design/renderer/forms.json (48 dialogs, 2 982 controls).

import { h, uid, appearanceTarget } from '../../dom.js';
import { getLanguage } from '../../i18n.js';

/* ================================================================== */
/* schema helpers                                                      */
/* ================================================================== */

/** A bilingual string. The funny level styles prose, never a control's name. */
const L = (en, yue) => ({ en, yue });

/** One entry of a select/radio list. */
const opt = (value, en, yue, extra) => ({ value, label: L(en, yue), ...extra });

const check = (key, def, en, yue, extra) => ({ key, def, type: 'check', label: L(en, yue), ...extra });
const number = (key, def, en, yue, extra) => ({ key, def, type: 'number', label: L(en, yue), ...extra });
const text = (key, def, en, yue, extra) => ({ key, def, type: 'text', label: L(en, yue), ...extra });
const path = (key, def, en, yue, extra) => ({ key, def, type: 'path', label: L(en, yue), ...extra });
const select = (key, def, en, yue, options, extra) => ({ key, def, type: 'select', label: L(en, yue), options, ...extra });
const radio = (key, def, en, yue, options, extra) => ({ key, def, type: 'radio', label: L(en, yue), options, ...extra });
const slider = (key, def, en, yue, extra) => ({ key, def, type: 'slider', label: L(en, yue), ...extra });
const action = (key, def, en, yue, extra) => ({ key, def, type: 'action', label: L(en, yue), ...extra });
const custom = (key, def, en, yue, kind, extra) => ({ key, def, type: 'custom', custom: kind, label: L(en, yue), ...extra });

/** Byte sizes offered wherever WinSCP offers 1M/10M/100M/1G. */
const SIZE_OPTIONS = (zeroEn, zeroYue) => [
  opt(0, zeroEn, zeroYue),
  opt(1048576, '1 MB', '1 MB'),
  opt(10485760, '10 MB', '10 MB'),
  opt(104857600, '100 MB', '100 MB'),
  opt(1073741824, '1 GB', '1 GB'),
];

/* ================================================================== */
/* transfer settings (TCopyParamType) — shared with copyparams.js      */
/* ================================================================== */
//
// These are the controls of CopyParams.dfm. They are declared here rather than
// in copyparams.js because the Preferences search must find "Preserve
// timestamp" whether the user is looking at the Transfer page or not, and
// because the Copy dialog and the Preferences page must offer exactly the same
// options with exactly the same defaults.
//
// Resume lives on the Endurance page, exactly as it does in WinSCP: it is a
// property of the transfer engine rather than of a preset.

export const COPY_PARAM_SECTIONS = [
  {
    id: 'cp-mode',
    title: L('Transfer mode', '傳輸模式'),
    controls: [
      radio('copyParam.transferMode', 'binary', 'Transfer mode', '傳輸模式', [
        opt('text', 'Text (plain text, HTML, scripts…)', '文字（純文字、HTML、腳本…）'),
        opt('binary', 'Binary (archives, documents…)', '二進位（壓縮檔、文件…）'),
        opt('automatic', 'Automatic (by file mask)', '自動（睇檔案遮罩）'),
      ]),
      text('copyParam.asciiFileMask',
        '*.*htm; *.*html; *.txt; *.php*; *.c; *.cpp; *.h; *.pas; *.bas; *.tex; *.pl; *.js; .htaccess; *.xtml; *.css; *.cfg; *.ini; *.sh; *.xml',
        'Transfer these files in text mode', '呢啲檔案用文字模式傳',
        {
          mask: true,
          dependsOn: { key: 'copyParam.transferMode', equals: 'automatic' },
          hint: L('A file-mask list. Everything else is transferred verbatim.',
            '檔案遮罩清單，其他檔案照原樣傳。'),
        }),
    ],
  },
  {
    id: 'cp-common',
    title: L('Common options', '共通選項'),
    controls: [
      check('copyParam.preserveTime', true, 'Preserve timestamp', '保留時間戳記'),
      check('copyParam.preserveTimeDirs', false, 'Including directories', '連目錄都保留',
        { dependsOn: 'copyParam.preserveTime' }),
      check('copyParam.calculateSize', true, 'Calculate total size before transferring', '傳之前先計總大小'),
      number('copyParam.cpsLimit', 0, 'Speed limit', '速度上限',
        {
          min: 0, max: 1048576, step: 1, scale: 1024, unit: L('KB/s', 'KB/秒'),
          hint: L('0 is unlimited.', '0 即係唔限速。'),
        }),
      check('copyParam.followDirectorySymlinks', false, 'Follow directory symbolic links', '跟住目錄符號連結行'),
    ],
  },
  {
    id: 'cp-download',
    title: L('Download options', '下載選項'),
    controls: [
      check('copyParam.preserveReadOnly', false, 'Preserve read-only attribute', '保留唯讀屬性'),
    ],
  },
  {
    id: 'cp-upload',
    title: L('Upload options', '上載選項'),
    controls: [
      check('copyParam.preserveRights', false, 'Set permissions', '設定權限'),
      text('copyParam.rights', 'rw-r--r--', 'Permissions', '權限',
        { dependsOn: 'copyParam.preserveRights', pattern: '^[-r][-w][-xsS][-r][-w][-xsS][-r][-w][-xtT]$', placeholder: 'rw-r--r--' }),
      check('copyParam.addXToDirectories', true, 'Add execute permission to directories', '目錄自動加執行權限',
        { dependsOn: 'copyParam.preserveRights' }),
      check('copyParam.ignorePermErrors', false, 'Ignore permission errors', '唔理權限錯誤'),
      check('copyParam.clearArchive', false, 'Clear the archive attribute after transfer', '傳完清走封存屬性'),
      check('copyParam.removeBOM', false, 'Remove the byte-order mark', '移除 BOM 位元組順序標記'),
      check('copyParam.removeCtrlZ', false, 'Remove Ctrl+Z end-of-file marks', '移除 Ctrl+Z 檔尾標記'),
      check('copyParam.encryptNewFiles', true, 'Encrypt new files', '新檔案加密',
        { hint: L('Only when the site has file encryption configured.', '淨係喺站點設定咗檔案加密先有效。') }),
    ],
  },
  {
    id: 'cp-filename',
    title: L('Filename modification', '檔名處理'),
    controls: [
      radio('copyParam.fileNameCase', 'noChange', 'Filename case', '檔名大細楷', [
        opt('noChange', 'No change', '唔改'),
        opt('upper', 'Upper case', '全大楷'),
        opt('lower', 'Lower case', '全細楷'),
        opt('firstUpper', 'First letter upper case', '第一個字母大楷'),
      ]),
      check('copyParam.replaceInvalidChars', true, 'Replace characters the target cannot store', '目標存唔到嘅字元照換'),
      text('copyParam.invalidCharsReplacement', '_', 'Replacement character', '替代字元',
        { dependsOn: 'copyParam.replaceInvalidChars', maxLength: 1, size: 3 }),
    ],
  },
  {
    id: 'cp-other',
    title: L('Other', '其他'),
    controls: [
      text('copyParam.includeFileMask', '', 'File mask', '檔案遮罩',
        {
          mask: true,
          hint: L('Include masks first, then "|", then exclude masks — *.txt | *.bak',
            '先寫要包括嘅遮罩，跟住「|」，再寫要排除嘅——*.txt | *.bak'),
        }),
      check('copyParam.newerOnly', false, 'New and updated files only', '淨係傳新同更新咗嘅檔案'),
      check('copyParam.excludeHiddenFiles', false, 'Exclude hidden files', '唔理隱藏檔'),
      check('copyParam.excludeEmptyDirectories', false, 'Exclude empty directories', '唔理空目錄'),
      select('copyParam.overwriteMode', 'overwrite', 'When a target file exists', '目標檔案已經存在嗰陣', [
        opt('overwrite', 'Overwrite it', '覆寫佢'),
        opt('resume', 'Resume the transfer', '續傳'),
        opt('append', 'Append to it', '接落去尾'),
      ]),
      select('copyParam.onceDoneOperation', 'none', 'When the transfer finishes', '傳完之後', [
        opt('none', 'Do nothing', '咩都唔做'),
        opt('disconnect', 'Disconnect the session', '中斷連線'),
        opt('suspend', 'Suspend the computer', '電腦休眠'),
        opt('shutdown', 'Shut the computer down', '關機'),
      ]),
      check('copyParam.saveTransferOptions', false, 'Remember these options for the next transfer', '記住呢啲設定俾下次用'),
    ],
  },
];

/** Every transfer-settings control, flat. */
export const COPY_PARAM_CONTROLS = COPY_PARAM_SECTIONS.flatMap((s) => s.controls);

/* ================================================================== */
/* the pages                                                           */
/* ================================================================== */

export const PAGES = [
  /* ---------------------------------------------------------- Environment */
  {
    id: 'environment',
    icon: 'settings',
    titleKey: 'pEnvironment',
    title: L('Environment', '環境'),
    sections: [
      {
        id: 'confirmations',
        title: L('Confirmations', '確認'),
        description: L('Ask before these operations. A confirmation you switch off never comes back on its own.',
          '做呢啲操作之前問一問你。你熄咗嘅確認唔會自己彈返出嚟。'),
        controls: [
          check('confirmOverwriting', true, 'Overwriting of files', '覆寫檔案'),
          check('confirmDeleting', true, 'Deleting of files (recommended)', '刪除檔案（建議開住）'),
          check('confirmRecycling', true, 'Moving files to the recycle bin', '掉檔案入資源回收筒'),
          check('confirmClosingSession', true, 'Closing sessions when exiting the application', '離開程式時關閉工作階段'),
          check('confirmExitOnCompletion', true, 'Exiting the application on operation completion', '操作完成後離開程式'),
          check('confirmTransferring', true, 'Transferring of files', '傳輸檔案'),
          check('confirmResume', true, 'Transfer resuming', '續傳'),
          check('confirmCommandSession', true, 'Opening a separate shell session', '開多個 shell 工作階段'),
          check('dDTransferConfirmation', true, 'Drag & drop operations and paste to other applications', '拖放同貼去第二個程式'),
          check('confirmTemporaryDirectoryCleanup', true, 'Cleaning up temporary directories', '清理臨時目錄'),
          check('continueOnError', false, 'Continue on error instead of asking (advanced users)', '出錯照做落去，唔問（進階用家）'),
        ],
      },
      {
        id: 'notifications-env',
        title: L('Notifications', '通知'),
        controls: [
          check('beepOnFinish', false, 'Beep when work finishes, if it lasted longer than', '做完嘢響一聲（前提係做咗超過）'),
          number('beepOnFinishAfter', 0, 'Minimum duration', '最短時間',
            { min: 0, max: 3600, unit: L('seconds', '秒'), dependsOn: 'beepOnFinish' }),
        ],
      },
      {
        id: 'startup',
        title: L('Startup and defaults', '啟動同預設值'),
        controls: [
          check('defaultDirIsHome', true, 'Start in the home directory', '開頭去 home 目錄',
            { hint: L('Off starts in the server root instead.', '熄咗就由伺服器根目錄開始。') }),
          check('timeoutOnStartup', false, 'Time out the connection attempt made at startup', '啟動時嘅連線試到夠鐘就停'),
          number('maxHistoryEntries', 40, 'Remembered entries per history list', '每個歷史清單記幾多項',
            { min: 0, max: 500 }),
        ],
      },
    ],
  },

  /* ------------------------------------------------ Environment ▸ Interface */
  {
    id: 'interface',
    parent: 'environment',
    icon: 'wysiwyg',
    titleKey: 'pInterface',
    title: L('Interface', '介面'),
    sections: [
      {
        id: 'interface-style',
        title: L('User interface', '使用者介面'),
        controls: [
          radio('interface', 'commander', 'User interface style', '介面風格', [
            opt('commander', 'Commander — two panels, keyboard-centric', 'Commander——雙面板，鍵盤為主'),
            opt('explorer', 'Explorer — the remote panel only', 'Explorer——淨係遠端面板'),
          ], { restart: true }),
          check('window.sessionTabs', true, 'Show the session tab strip', '顯示工作階段分頁列'),
          check('tabs.truncateTitles', true, 'Truncate tab titles when they do not fit', '分頁標題唔夠位就截短'),
          check('window.openedTabsShortcut', true, 'Keyboard shortcut for the opened-tabs list', '「已開分頁」清單有鍵盤捷徑'),
          check('window.showTips', true, 'Show tips on startup', '啟動時顯示貼士'),
        ],
      },
      {
        id: 'toolbars',
        title: L('Toolbars', '工具列'),
        controls: [
          check('window.lockToolbars', false, 'Lock toolbar positions', '鎖住工具列位置'),
          check('window.selectiveToolbarText', true, 'Show text beside the important buttons', '重要按鈕旁邊顯示文字'),
          check('window.largeToolbarIcons', false, 'Large toolbar icons', '大工具列圖示'),
          select('window.toolbarIconSize', 'normal', 'Toolbar icon size', '工具列圖示大細', [
            opt('normal', 'Normal', '正常'),
            opt('large', 'Large', '大'),
            opt('veryLarge', 'Very large', '好大'),
          ]),
        ],
      },
      {
        id: 'lists',
        title: L('Lists', '清單'),
        controls: [
        ],
      },
    ],
  },

  /* --------------------------------------------------- Environment ▸ Window */
  {
    id: 'window',
    parent: 'environment',
    icon: 'maximize',
    titleKey: 'pWindow',
    title: L('Window', '視窗'),
    sections: [
      {
        id: 'caption',
        title: L('Path in the window title', '視窗標題入面嘅路徑'),
        controls: [
          radio('window.pathInCaption', 'short', 'Path in the window title', '視窗標題入面嘅路徑', [
            opt('full', 'Show the full path', '顯示完整路徑'),
            opt('short', 'Show a short path', '顯示短路徑'),
            opt('none', 'Do not show a path', '唔顯示路徑'),
          ]),
          check('window.sessionTabCaptionTruncation', true, 'Truncate session tab captions when they do not fit', '工作階段分頁標題唔夠位就截短'),
        ],
      },
      {
        id: 'window-misc',
        title: L('Miscellaneous', '雜項'),
        controls: [
          check('window.minimizeToTray', false, 'Minimise to the notification area', '縮到通知區域'),
          check('window.keepOpenWhenNoSession', true, 'Keep the window open when the last session closes', '最後一個工作階段閂咗都唔關窗'),
          check('integration.externalSessionInExistingInstance', true,
            'Open externally started sessions in the existing window', '由外面開嘅工作階段用返現有視窗'),
        ],
      },
      {
        id: 'workspaces',
        title: L('Workspaces', '工作區'),
        controls: [
          check('window.autoSaveWorkspace', false, 'Save the workspace automatically on exit', '離開時自動儲存工作區'),
          check('window.autoSaveWorkspacePasswords', false, 'Save passwords with it (not recommended)', '連密碼一齊儲存（唔建議）',
            {
              dependsOn: 'window.autoSaveWorkspace', danger: true,
              hint: L('Stored passwords are only as safe as this computer is.',
                '存低嘅密碼有幾安全，全睇呢部電腦有幾安全。'),
            }),
          text('window.autoWorkspace', '', 'Default workspace name', '預設工作區名',
            { dependsOn: 'window.autoSaveWorkspace', placeholder: 'Workspace' }),
        ],
      },
    ],
  },

  /* ------------------------------------------------ Environment ▸ Commander */
  {
    id: 'commander',
    parent: 'environment',
    icon: 'vertical_split',
    titleKey: 'pCommander',
    title: L('Commander', 'Commander'),
    description: L('These options apply to the Commander interface only.', '呢頁淨係影響 Commander 介面。'),
    sections: [
      {
        id: 'commander-panels',
        title: L('Panels', '面板'),
        controls: [
          check('scpCommander.swappedPanels', false, 'Swap the panels (local on the right)', '兩邊面板對調（本機喺右邊）'),
          check('scpCommander.treeOnLeft', false, 'Show the directory tree left of the file list', '目錄樹擺喺檔案清單左邊'),
          select('scpCommander.currentPanel', 'left', 'Panel focused at startup', '啟動時聚焦邊邊', [
            opt('left', 'Left panel', '左面板'),
            opt('right', 'Right panel', '右面板'),
          ]),
          number('scpCommander.localPanelWidth', 0.5, 'Local panel width', '本機面板闊度',
            { min: 10, max: 90, step: 1, scale: 0.01, unit: L('% of the window', '% 視窗闊度') }),
          check('panel.explorerStyleSelection', false, 'Explorer-style selection', 'Explorer 式揀選',
            { hint: L('Click selects instead of Norton-style Insert/Space selection.', '撳一下就揀，唔使用 Norton 式 Insert／空白鍵。') }),
          check('scpCommander.explorerKeyboardShortcuts', false, 'Explorer-style keyboard shortcuts', 'Explorer 式鍵盤捷徑'),
        ],
      },
      {
        id: 'commander-drives',
        title: L('Drive bars', '磁碟列'),
        controls: [
          check('scpCommander.localPanel.driveView', false, 'Show the drive tree in the local panel', '本機面板顯示磁碟樹'),
          number('scpCommander.localPanel.driveViewWidth', 180, 'Local drive tree width', '本機磁碟樹闊度',
            { min: 80, max: 600, unit: L('px', '像素'), dependsOn: 'scpCommander.localPanel.driveView' }),
          check('scpCommander.remotePanel.driveView', false, 'Show the directory tree in the remote panel', '遠端面板顯示目錄樹'),
          number('scpCommander.remotePanel.driveViewWidth', 180, 'Remote tree width', '遠端目錄樹闊度',
            { min: 80, max: 600, unit: L('px', '像素'), dependsOn: 'scpCommander.remotePanel.driveView' }),
        ],
      },
      {
        id: 'commander-status',
        title: L('Status bars', '狀態列'),
        controls: [
          check('scpCommander.statusBar', true, 'Show the window status bar', '顯示視窗狀態列'),
          check('scpCommander.localPanel.statusBar', true, 'Show the local panel status bar', '顯示本機面板狀態列'),
          check('scpCommander.remotePanel.statusBar', true, 'Show the remote panel status bar', '顯示遠端面板狀態列'),
        ],
      },
      {
        id: 'commander-compare',
        title: L('Compare directory criteria', '比較目錄嘅準則'),
        controls: [
          check('scpCommander.compareByTime', true, 'Compare by timestamp', '比時間戳記'),
          check('scpCommander.compareBySize', false, 'Compare by size', '比大細'),
        ],
      },
      {
        id: 'commander-misc',
        title: L('Miscellaneous', '雜項'),
        controls: [
          check('scpCommander.preserveLocalDirectory', false,
            'Keep the local panel where it is when switching sessions', '轉工作階段唔郁本機面板'),
          check('integration.useSharedBookmarks', false,
            'Share bookmarks between the local and remote panels', '本機同遠端面板共用書籤'),
        ],
      },
    ],
  },

  /* ------------------------------------------------- Environment ▸ Explorer */
  {
    id: 'explorer',
    parent: 'environment',
    icon: 'folder_open',
    titleKey: 'pExplorer',
    title: L('Explorer', 'Explorer'),
    description: L('These options apply to the Explorer interface only.', '呢頁淨係影響 Explorer 介面。'),
    sections: [
      {
        id: 'explorer-view',
        title: L('View', '檢視'),
        controls: [
          check('panel.showFullPathOnAddressBar', false, 'Show the full path on the address bar', '網址列顯示完整路徑'),
          check('scpExplorer.statusBar', true, 'Show the status bar', '顯示狀態列'),
        ],
      },
    ],
  },

  /* ------------------------------------------------ Environment ▸ Languages */
  {
    id: 'languages',
    parent: 'environment',
    icon: 'translate',
    titleKey: 'pLanguages',
    title: L('Languages', '語言'),
    sections: [
      {
        id: 'language-mode',
        title: L('Language mode', '語言模式'),
        controls: [
          radio('language', 'en', 'Language', '語言', [
            opt('en', 'English', '英文'),
            opt('yue', '廣東話 (playful Hong Kong Cantonese)', '廣東話（港式活潑）'),
            opt('both', 'Bilingual · 雙語', '雙語 Bilingual'),
          ], { live: true }),
        ],
      },
      {
        id: 'funny-level',
        title: L('Funny level', '搞笑程度'),
        description: L('Two independent sliders. The level changes the voice of every message — including errors, warnings and destructive prompts — and never the facts: the file, the host, the byte count and whether something can be undone read the same at level 1 and level 5.',
          '兩條各自獨立嘅拉桿。程度只係改語氣，連錯誤、警告同刪除提示都包；事實永遠唔變——邊個檔案、邊部主機、幾多 bytes、還唔還原到，一級同五級都係同一句。'),
        controls: [
          slider('funnyLevel.en', 3, 'English funny level', '英文搞笑程度', { min: 1, max: 5, step: 1, live: true }),
          slider('funnyLevel.yue', 3, 'Cantonese funny level', '廣東話搞笑程度', { min: 1, max: 5, step: 1, live: true }),
          action('disclosureAccepted', false, 'Show the funny-level disclosure again', '再睇一次搞笑程度嘅說明',
            { actionId: 'showDisclosure', buttonLabel: L('Show disclosure', '睇說明') }),
        ],
      },
    ],
  },

  /* ----------------------------------------------- Environment ▸ Appearance */
  {
    id: 'appearance',
    parent: 'environment',
    icon: 'palette',
    titleKey: 'pAppearance',
    title: L('Appearance', '外觀'),
    description: L('Every change applies live. Individual elements are edited from their own right-click menu — Edit appearance… — or with Alt+Shift+E on the focused element.',
      '改咗即刻見效。個別元素喺佢自己嘅右鍵選單「編輯外觀…」度改，或者聚焦之後撳 Alt+Shift+E。'),
    sections: [
      {
        id: 'theme',
        title: L('Theme', '主題'),
        controls: [
          radio('theme.mode', 'light', 'Theme', '主題', [
            opt('light', 'Light', '淺色'),
            opt('dark', 'Dark', '深色'),
            opt('system', 'Follow the system', '跟系統'),
          ], { live: true }),
          { key: 'theme.seed', def: '#0B57D0', type: 'color', label: L('Seed colour', '主色種子'), live: true },
        ],
      },
      {
        id: 'layout',
        title: L('Layout', '版面'),
        controls: [
          select('theme.density', 0, 'Density', '密度', [
            opt(0, 'Comfortable', '舒適'),
            opt(-1, 'Compact', '緊湊'),
            opt(-2, 'Dense', '超緊湊'),
            opt(-3, 'Densest', '極緊湊'),
          ], { live: true }),
          select('theme.uiScale', 1, 'UI scale', '介面縮放', [
            opt(1, '100%', '100%'),
            opt(1.25, '125%', '125%'),
            opt(1.5, '150%', '150%'),
            opt(2, '200%', '200%'),
          ], { live: true }),
        ],
      },
      {
        id: 'typography',
        title: L('Typography', '文字'),
        controls: [
          { key: 'theme.fontFamily', def: 'Roboto', type: 'font', label: L('UI font', '介面字體'), live: true },
          number('theme.fontSize', 14, 'UI font size', '介面字體大細',
            { min: 10, max: 28, unit: L('px', '像素'), live: true }),
          select('theme.fontWeight', 400, 'UI font weight', '介面字重', [
            opt(300, 'Light (300)', '幼 (300)'),
            opt(400, 'Regular (400)', '正常 (400)'),
            opt(500, 'Medium (500)', '中 (500)'),
            opt(600, 'Semi-bold (600)', '半粗 (600)'),
            opt(700, 'Bold (700)', '粗 (700)'),
          ], { live: true }),
        ],
      },
      {
        id: 'motion',
        title: L('Motion', '動態'),
        controls: [
          check('theme.reduceMotion', false, 'Reduce motion', '減少動態效果',
            { live: true, hint: L('The operating system setting is honoured as well, whichever is on.', '系統嗰個設定都會照跟，兩者其中一個開咗就算。') }),
        ],
      },
    ],
  },

  /* -------------------------------------------- Environment ▸ Notifications */
  {
    id: 'notifications',
    parent: 'environment',
    icon: 'notifications',
    titleKey: 'pNotifications',
    title: L('Notifications', '通知'),
    description: L('Informational messages appear as corner toasts. Warnings and errors stay until you dismiss them, whatever the duration says.',
      '一般訊息用角落嘅提示卡。警告同錯誤會一直留住，直到你自己閂佢，唔理下面設幾多秒。'),
    sections: [
      {
        id: 'toasts',
        title: L('Toasts', '提示卡'),
        controls: [
          number('notifications.durationSec', 6, 'Auto-dismiss after', '幾耐之後自動閂',
            { store: 'renderer', min: 2, max: 60, unit: L('seconds', '秒'), live: true }),
          select('notifications.position', 'bottom-right', 'Corner', '喺邊個角', [
            opt('bottom-right', 'Bottom right', '右下'),
            opt('bottom-left', 'Bottom left', '左下'),
          ], { store: 'renderer', live: true }),
          number('notifications.centreLimit', 200, 'Notifications kept in the history', '通知紀錄留幾多條',
            { store: 'renderer', min: 10, max: 2000, live: true }),
        ],
      },
    ],
  },

  /* --------------------------------------------------------------- Panels */
  {
    id: 'panels',
    icon: 'view_column',
    titleKey: 'pPanels',
    title: L('Panels', '面板'),
    sections: [
      {
        id: 'panels-common',
        title: L('Common', '共通'),
        controls: [
          check('showHiddenFiles', false, 'Show hidden files', '顯示隱藏檔'),
          check('panel.hiddenAsNormal', false, 'Show hidden files like any other file', '隱藏檔照普通檔案咁顯示',
            { dependsOn: 'showHiddenFiles', hint: L('Off dims them instead.', '熄咗就淡色顯示。') }),
          select('formatSizeBytes', 'short', 'Show file sizes in', '檔案大細顯示做', [
            opt('none', 'Bytes', 'Bytes'),
            opt('kilo', 'Kilobytes', 'Kilobytes'),
            opt('short', 'Short format (KB, MB, GB)', '簡短格式（KB、MB、GB）'),
          ]),
          select('panel.incrementalSearch', 'typing', 'Incremental search', '漸進式搜尋', [
            opt('off', 'Off', '熄'),
            opt('typing', 'Start when you type', '打字就開始'),
            opt('ctrl', 'Start with Ctrl+letter', '撳 Ctrl+字母先開始'),
          ]),
          check('panel.naturalOrderNumericalSorting', true, 'Natural order numerical sorting', '數字用自然順序排'),
          check('panel.alwaysSortDirectoriesByName', false, 'Always sort directories by name', '目錄永遠照名排'),
          // One control, one key. There used to be a second row on the
          // Interface page writing window.fullRowSelect, which nothing reads,
          // and this one fanned out into it — so the two rows could disagree
          // and only one of them ever changed anything. The panel key is the
          // one ui/panels.js honours, so it is the one the user sees.
          check('panel.fullRowSelect', true, 'Full row select', '成行揀選'),
          select('panel.viewStyle', 'report', 'View style', '檢視方式', [
            opt('icon', 'Icons', '大圖示'),
            opt('smallIcon', 'Small icons', '細圖示'),
            opt('list', 'List', '清單'),
            opt('report', 'Details', '詳細資料'),
            opt('thumbnail', 'Thumbnails', '縮圖'),
          ]),
          number('panel.thumbnailSize', 96, 'Thumbnail size', '縮圖大細',
            { min: 32, max: 256, unit: L('px', '像素'), dependsOn: { key: 'panel.viewStyle', equals: 'thumbnail' } }),
        ],
      },
      {
        id: 'double-click',
        title: L('Double-click', '雙擊'),
        controls: [
          select('doubleClickAction', 'edit', 'Operation to perform on double-click', '雙擊做乜', [
            opt('open', 'Open', '開啟'),
            opt('edit', 'Edit', '編輯'),
            opt('copy', 'Copy (transfer)', '複製（傳輸）'),
          ], { alsoKeys: ['panel.doubleClickAction'] }),
          check('copyOnDoubleClick', false, 'Copy on double-click even when another action is set', '就算設咗第二個動作，雙擊都照複製'),
          check('copyOnDoubleClickConfirmation', true, 'Confirm the copy on double-click', '雙擊複製要確認',
            { dependsOn: 'copyOnDoubleClick' }),
        ],
      },
    ],
  },

  /* ------------------------------------------------------- Panels ▸ Remote */
  {
    id: 'panels-remote',
    parent: 'panels',
    icon: 'cloud',
    titleKey: 'pRemote',
    title: L('Remote', '遠端'),
    sections: [
      {
        id: 'remote-panel',
        title: L('Remote panel', '遠端面板'),
        controls: [
          check('showInaccessibleDirectories', true, 'Show inaccessible directories', '顯示入唔到嘅目錄'),
          check('autoReadDirectoryAfterOp', true, 'Refresh the directory automatically after an operation', '做完操作自動重新讀目錄'),
          number('refreshRemotePanelInterval', 0, 'Refresh the remote panel every', '每隔幾耐重新整理遠端面板',
            { min: 0, max: 3600, unit: L('seconds', '秒'), hint: L('0 turns the timer off.', '0 即係唔用計時器。') }),
        ],
      },
    ],
  },

  /* -------------------------------------------------------- Panels ▸ Local */
  {
    id: 'panels-local',
    parent: 'panels',
    icon: 'computer',
    titleKey: 'pLocal',
    title: L('Local', '本機'),
    sections: [
      {
        id: 'local-panel',
        title: L('Local panel', '本機面板'),
        controls: [
          check('deleteToRecycleBin', true, 'Delete local files to the recycle bin', '本機檔案刪除去資源回收筒'),
          check('integration.localIconsFromExplorer', true, 'Use the shell’s own file icons', '用系統自己嘅檔案圖示'),
        ],
      },
    ],
  },

  /* -------------------------------------------------- Panels ▸ File colours */
  {
    id: 'file-colors',
    parent: 'panels',
    icon: 'palette',
    titleKey: 'pFileColors',
    title: L('File colours', '檔案顏色'),
    sections: [
      {
        id: 'file-colors-list',
        title: L('File colours', '檔案顏色'),
        description: L('Files whose name matches a mask are drawn in that colour. The first matching rule wins, so order matters.',
          '檔名夾到遮罩嘅檔案會用嗰隻色。夾到嘅第一條規則贏，所以次序好緊要。'),
        controls: [
          custom('fileColors', [], 'File colour rules', '檔案顏色規則', 'fileColors'),
        ],
      },
    ],
  },

  /* -------------------------------------------------------------- Editors */
  {
    id: 'editors',
    icon: 'edit',
    titleKey: 'pEditor',
    title: L('Editors', '編輯器'),
    sections: [
      {
        id: 'editor-list',
        title: L('Editor autoselection', '編輯器自動揀選'),
        description: L('The first editor whose mask matches the file is used. Order matters.',
          '第一個遮罩夾到嘅編輯器就係用嗰個，所以次序好緊要。'),
        controls: [
          custom('editor.list', [{ mask: '*.*', type: 'internal', external: '', externalParams: true, sDIExternal: false }],
            'Editors', '編輯器', 'editors'),
        ],
      },
      {
        id: 'editing-options',
        title: L('Editing options', '編輯選項'),
        controls: [
          check('editor.singleEditor', true, 'Reuse one window for every edited file', '所有編輯緊嘅檔案共用一個視窗'),
          number('editor.maxEditors', 500, 'Maximum files open at once', '最多同時開幾多個檔案',
            { min: 1, max: 5000 }),
          number('editor.earlyClose', 2, 'Close an external editor that exits within', '外部編輯器幾秒內退出就當佢閂咗',
            {
              min: 0, max: 60, unit: L('seconds', '秒'),
              hint: L('An editor that hands the file to an already-running instance exits at once; this is how that is detected.',
                '有啲編輯器會將檔案交俾已經開住嘅程序然後即刻退出，呢個設定就係用嚟認出呢種情況。'),
            }),
          check('editor.sDIShellEditor', false, 'The associated application opens each file in its own process', '關聯程式每個檔案開一個獨立程序'),
          check('editor.keepTemporaryFiles', false, 'Keep the temporary copy after the editor closes', '編輯器閂咗都留住臨時複本'),
          check('editor.warnOrphans', true, 'Warn about temporary files left over from a previous run', '上次剩低嘅臨時檔案要提我'),
          check('editor.warnOnEncodingFallback', true, 'Warn when the encoding has to be guessed', '要靠估編碼嗰陣提我'),
          select('editor.encoding', 'auto', 'Default encoding', '預設編碼', [
            opt('auto', 'Detect automatically', '自動偵測'),
            opt('utf8', 'UTF-8', 'UTF-8'),
            opt('utf8bom', 'UTF-8 with BOM', 'UTF-8（有 BOM）'),
            opt('ansi', 'System ANSI code page', '系統 ANSI 代碼頁'),
          ]),
        ],
      },
    ],
  },

  /* ---------------------------------------------- Editors ▸ Internal editor */
  {
    id: 'editor-internal',
    parent: 'editors',
    icon: 'description',
    titleKey: 'pEditorInternal',
    title: L('Internal editor', '內置編輯器'),
    sections: [
      {
        id: 'internal-display',
        title: L('Display', '顯示'),
        controls: [
          check('editor.wordWrap', false, 'Wrap long lines', '長行自動換行'),
          number('editor.tabSize', 8, 'Tabulator size', 'Tab 闊度', { min: 1, max: 32 }),
        ],
      },
      {
        id: 'internal-font',
        title: L('Font', '字體'),
        controls: [
          { key: 'editor.fontName', def: 'Consolas', type: 'font', label: L('Editor font', '編輯器字體'), monospace: true },
          number('editor.fontSize', 11, 'Editor font size', '編輯器字體大細', { min: 6, max: 48, unit: L('pt', 'pt') }),
          select('editor.fontStyle', 0, 'Editor font style', '編輯器字型樣式', [
            opt(0, 'Regular', '正常'),
            opt(1, 'Bold', '粗體'),
            opt(2, 'Italic', '斜體'),
            opt(3, 'Bold italic', '粗斜體'),
          ]),
          number('editor.fontCharset', 1, 'Font character set', '字體字元集',
            {
              min: 0, max: 255,
              hint: L('1 is the default character set. 136 is Traditional Chinese (Big5).',
                '1 係預設字元集，136 係繁體中文（Big5）。'),
            }),
          check('editor.autoFont', true, 'Pick a font that can show the file’s characters', '自動揀個顯示到檔案文字嘅字體'),
        ],
      },
      {
        id: 'internal-behaviour',
        title: L('Behaviour', '行為'),
        controls: [
          check('editor.disableSmoothScroll', false, 'Disable smooth scrolling', '關閉平滑捲動'),
        ],
      },
    ],
  },

  /* ------------------------------------------------------------- Transfer */
  {
    id: 'transfer',
    icon: 'swap_vert',
    titleKey: 'pTransfer',
    title: L('Transfer', '傳輸'),
    description: L('The default transfer settings. A site, a preset or a single copy operation can override any of them.',
      '呢啲係預設傳輸設定。站點、預設組合，或者單次複製都可以蓋過任何一項。'),
    sections: [
      {
        id: 'transfer-frame',
        title: L('Default transfer settings', '預設傳輸設定'),
        custom: 'copyParams',
        // The frame renders these; they are declared so the search finds them.
        controls: COPY_PARAM_CONTROLS.map((c) => ({ ...c, virtual: true })),
      },
      {
        id: 'transfer-presets-notice',
        title: L('Presets', '預設組合'),
        controls: [
          check('copyParamAutoSelectNotice', true,
            'Announce when a transfer preset is selected automatically', '自動揀咗傳輸預設組合就話我知'),
        ],
      },
    ],
  },

  /* --------------------------------------------------- Transfer ▸ Presets */
  {
    id: 'presets',
    parent: 'transfer',
    icon: 'layers',
    titleKey: 'pPresets',
    title: L('Presets', '預設組合'),
    sections: [
      {
        id: 'preset-list',
        title: L('Transfer settings presets', '傳輸設定預設組合'),
        description: L('Presets appear in the copy dialog and in the transfer settings menu. A preset with an autoselection rule is chosen on its own when the rule matches the session.',
          '預設組合會喺複製對話框同傳輸設定選單度出現。有自動揀選規則嘅，夾到工作階段就會自己揀。'),
        controls: [
          custom('copyParamList', [], 'Presets', '預設組合', 'presets'),
        ],
      },
    ],
  },

  /* ------------------------------------------------- Transfer ▸ Endurance */
  {
    id: 'endurance',
    parent: 'transfer',
    icon: 'restart_alt',
    titleKey: 'pEndurance',
    title: L('Endurance', '耐力'),
    sections: [
      {
        id: 'resume',
        title: L('Transfer resume and temporary filenames', '續傳同臨時檔名'),
        controls: [
          radio('copyParam.resumeSupport', 'smart', 'Enable transfer resume for', '對邊啲檔案啟用續傳', [
            opt('on', 'All files', '所有檔案'),
            opt('smart', 'Files above the threshold below', '大過下面門檻嘅檔案'),
            opt('off', 'Disable', '停用'),
          ]),
          number('copyParam.resumeThreshold', 102400, 'Threshold', '門檻',
            {
              min: 0, max: 1073741824, scale: 1024, unit: L('KB', 'KB'),
              dependsOn: { key: 'copyParam.resumeSupport', equals: 'smart' },
            }),
          text('copyParam.partialFileExt', '.filepart', 'Temporary filename extension', '臨時檔名副檔名',
            { placeholder: '.filepart' }),
        ],
      },
      {
        id: 'reconnect',
        title: L('Automatic reconnect', '自動重連'),
        controls: [
          number('security.sessionReopenAuto', 5000, 'Reconnect a broken foreground session after', '前景工作階段斷咗，幾耐之後重連',
            { min: 0, max: 600, scale: 1000, unit: L('seconds', '秒'), hint: L('0 never reconnects.', '0 即係唔重連。') }),
          number('security.sessionReopenBackground', 2000, 'Reconnect a background transfer after', '背景傳輸斷咗，幾耐之後重連',
            { min: 0, max: 600, scale: 1000, unit: L('seconds', '秒') }),
          number('security.sessionReopenTimeout', 0, 'Keep reconnecting for', '重連試幾耐',
            { min: 0, max: 86400, scale: 1000, unit: L('seconds', '秒'), hint: L('0 keeps trying indefinitely.', '0 即係一直試落去。') }),
          number('security.sessionReopenAutoStall', 0, 'Treat a session with no data as broken after', '幾耐冇資料就當條線斷咗',
            { min: 0, max: 3600, scale: 1000, unit: L('seconds', '秒'), hint: L('0 never treats a stall as a break.', '0 即係停咗都唔當佢斷。') }),
          check('security.sessionReopenAutoIdle', true, 'Reconnect an idle session too', '閒置嘅工作階段都重連'),
        ],
      },
    ],
  },

  /* ------------------------------------------------ Transfer ▸ Background */
  {
    id: 'background',
    parent: 'transfer',
    icon: 'playlist',
    titleKey: 'pBackground',
    title: L('Background', '背景'),
    sections: [
      {
        id: 'queue-behaviour',
        title: L('Background transfers', '背景傳輸'),
        controls: [
          check('queue.enabledByDefault', true, 'Process the queue by default', '預設就處理佇列'),
          check('queue.autoPopup', true, 'Show the queue automatically when work starts', '開始做嘢就自動彈佇列出嚟'),
          check('queue.autoPopupPrompts', true, 'Bring background prompts forward when idle', '得閒嘅時候將背景提問彈到前面'),
          check('queue.noConfirmations', true, 'No confirmations for background transfers', '背景傳輸唔使確認'),
          number('queue.transfersLimit', 2, 'Maximum simultaneous transfers', '同時最多傳幾多個',
            { min: 1, max: 32, live: true }),
          number('queue.parallelTransfers', 1, 'Connections used for one large file', '一個大檔案用幾多條連線',
            { min: 1, max: 16, hint: L('1 disables splitting. Only protocols that can resume from an offset are split.', '1 即係唔分割。淨係支援由指定位置續傳嘅協定先分割。') }),
          select('queue.parallelTransferThreshold', 10485760, 'Split files larger than', '大過幾多就分割',
            SIZE_OPTIONS('Never split', '永遠唔分割'),
            { dependsOn: { key: 'queue.parallelTransfers', greaterThan: 1 } }),
          check('queue.parallelDuplicateTransfers', true, 'Allow the same file in several queue items', '同一個檔案容許出現喺幾個佇列項目'),
          check('queue.individualTransfers', false, 'Queue each file as its own item', '每個檔案獨立做一個佇列項目'),
          check('queue.rememberPassword', false, 'Remember the password for queue reconnects', '記住密碼俾佇列重連用',
            { danger: true, hint: L('The password stays in memory for as long as the application runs.', '密碼會一路留喺記憶體，直到程式關閉。') }),
        ],
      },
      {
        id: 'queue-list',
        title: L('Queue list', '佇列清單'),
        controls: [
          radio('queue.view', 'show', 'Queue list', '佇列清單', [
            opt('show', 'Always show', '一直顯示'),
            opt('hideWhenEmpty', 'Hide when empty', '空嘅時候收埋'),
            opt('hide', 'Always hide', '一直收埋'),
          ]),
          check('queue.toolbar', true, 'Show the queue toolbar', '顯示佇列工具列'),
          check('queue.fileList', false, 'Show the file list of each queue item', '顯示每個佇列項目嘅檔案清單'),
          select('queue.keepDoneItemsFor', 15, 'Keep completed items for', '完成咗嘅項目留幾耐', [
            opt(0, 'Do not keep them', '唔留'),
            opt(15, '15 seconds', '15 秒'),
            opt(60, '1 minute', '1 分鐘'),
            opt(900, '15 minutes', '15 分鐘'),
            opt(3600, '1 hour', '1 個鐘'),
            opt(-1, 'Forever', '永遠留住'),
          ]),
        ],
      },
      {
        id: 'queue-once-empty',
        title: L('When the queue empties', '佇列做完之後'),
        controls: [
          select('queue.onceEmpty', 'none', 'When the queue empties', '佇列做完之後', [
            opt('none', 'Do nothing', '咩都唔做'),
            opt('disconnect', 'Disconnect', '中斷連線'),
            opt('idle', 'Stay connected but idle', '保持連線但閒置'),
            opt('suspend', 'Suspend the computer', '電腦休眠'),
            opt('shutdown', 'Shut the computer down', '關機'),
          ]),
          check('queue.disconnectOnceEmpty', false, 'Disconnect as soon as the queue is empty', '佇列一空就中斷連線'),
        ],
      },
    ],
  },

  /* ------------------------------------------------ Transfer ▸ Drag & drop */
  {
    id: 'dragdrop',
    parent: 'transfer',
    icon: 'drag_indicator',
    titleKey: 'pDragDrop',
    title: L('Drag & drop', '拖放'),
    sections: [
      {
        id: 'dd-downloads',
        title: L('Drag & drop downloads', '拖放下載'),
        controls: [
          radio('dDFakeFile', true, 'How the drop target is determined', '點樣搵出放低嘅目標', [
            opt(true, 'Drag a fake file and download to where it lands', '拖一個假檔案，落到邊就下載去邊'),
            opt(false, 'Download to a temporary folder first', '先下載去臨時資料夾'),
          ]),
          check('dDWarnLackOfTempSpace', true, 'Warn when the temporary drive is short of space', '臨時磁碟唔夠位就警告'),
          number('dDWarnLackOfTempSpaceRatio', 1.2, 'Warn below this multiple of the transfer size', '低過傳輸大細嘅幾多倍就警告',
            { min: 1, max: 10, step: 0.1, dependsOn: 'dDWarnLackOfTempSpace' }),
          check('dDAllowMove', false, 'Allow drag & drop to move files instead of copying', '拖放可以移動檔案，唔淨係複製'),
          check('dDAllowMoveInit', false, 'Start a drag as a move by default', '開始拖嗰陣預設就當移動',
            { dependsOn: 'dDAllowMove' }),
          text('dDDrives', '', 'Network drives files may be dropped on', '可以放檔案落去嘅網絡磁碟',
            { placeholder: 'Z: Y:', hint: L('Space-separated drive letters. Empty allows every drive.', '用空格分開嘅磁碟機代號。留空即係所有磁碟都得。') }),
        ],
      },
    ],
  },

  /* -------------------------------------------------------------- Network */
  {
    id: 'network',
    icon: 'lan',
    titleKey: 'pNetwork',
    title: L('Network', '網絡'),
    sections: [
      {
        id: 'connections',
        title: L('Connections', '連線'),
        controls: [
          check('security.tryFtpWhenSshFails', true,
            'Knock on the FTP port when an SFTP connection is refused', 'SFTP 俾人拒絕嗰陣，試吓 FTP 埠'),
        ],
      },
    ],
  },

  /* --------------------------------------------------- Network ▸ Security */
  {
    id: 'security',
    parent: 'network',
    icon: 'shield_lock',
    titleKey: 'pSecurity',
    title: L('Security', '安全'),
    sections: [
      {
        id: 'master-password',
        title: L('Master password', '主密碼'),
        description: L('A master password re-encrypts every stored site password. Without it, stored passwords are protected by this account on this computer only.',
          '主密碼會將所有存低嘅站點密碼重新加密。冇主密碼嘅話，密碼淨係靠呢部電腦呢個帳戶保護。'),
        controls: [
          check('security.useMasterPassword', false, 'Use a master password', '用主密碼', { actionId: 'masterPassword' }),
          action('security.masterPasswordVerifier', '', 'Change the master password', '更改主密碼',
            {
              actionId: 'changeMasterPassword', dependsOn: 'security.useMasterPassword',
              buttonLabel: L('Change master password…', '更改主密碼…'), secret: true,
            }),
        ],
      },
    ],
  },

  /* --------------------------------------------- Integration ▸ Applications */
  {
    id: 'integration-apps',
    icon: 'terminal',
    titleKey: 'pApplications',
    title: L('Applications', '應用程式'),
    sections: [
      {
        id: 'external-apps',
        title: L('External applications', '外部程式'),
        controls: [
          path('integration.puttyPath', '%PROGRAMFILES%\\PuTTY\\putty.exe', 'PuTTY / terminal client path', 'PuTTY／終端機路徑',
            { hint: L('Environment variables and the custom-command patterns !@ !U !# are expanded.', '會展開環境變數同自訂指令樣式 !@ !U !#。') }),
          path('integration.puttygenPath', '%PROGRAMFILES%\\PuTTY\\puttygen.exe', 'PuTTYgen path', 'PuTTYgen 路徑'),
          path('integration.pageantPath', '%PROGRAMFILES%\\PuTTY\\pageant.exe', 'Pageant path', 'Pageant 路徑'),
          check('integration.puttyPassword', false, 'Pass the session password to PuTTY', '將工作階段密碼交俾 PuTTY',
            { danger: true, hint: L('The password appears on PuTTY’s command line while it starts.', 'PuTTY 起動嗰陣，密碼會出現喺佢嘅命令列度。') }),
          check('integration.autoOpenInPutty', false, 'Open new sessions in PuTTY automatically', '新工作階段自動喺 PuTTY 度開'),
          check('integration.telnetForFtpInPutty', true, 'Open FTP sessions in PuTTY as Telnet', 'FTP 工作階段喺 PuTTY 用 Telnet 開'),
        ],
      },
      {
        id: 'checksums',
        title: L('Checksums', '總和檢查碼'),
        controls: [
          select('integration.checksumAlg', 'sha-1', 'Default checksum algorithm', '預設總和檢查碼演算法', [
            opt('md5', 'MD5', 'MD5'),
            opt('sha-1', 'SHA-1', 'SHA-1'),
            opt('sha-256', 'SHA-256', 'SHA-256'),
            opt('sha-512', 'SHA-512', 'SHA-512'),
            opt('crc32', 'CRC32', 'CRC32'),
          ]),
        ],
      },
    ],
  },

  /* -------------------------------------------- Integration ▸ Windows shell */
  {
    id: 'integration-shell',
    parent: 'integration-apps',
    icon: 'computer',
    titleKey: 'pIntegration',
    title: L('Windows shell', 'Windows 外殼'),
    sections: [
      {
        id: 'shell-icons',
        title: L('Shortcuts and shell integration', '捷徑同外殼整合'),
        controls: [
          check('integration.desktopIcon', false, 'Desktop shortcut', '桌面捷徑'),
          check('integration.quickLaunchIcon', false, 'Quick Launch shortcut', '快速啟動捷徑'),
          check('integration.explorerUploadShortcut', false, 'Upload shortcut in the Explorer "Send to" menu', 'Explorer「傳送到」選單有上載捷徑'),
          check('integration.addSearchPath', false, 'Add the application to the search path', '將程式加入搜尋路徑'),
          check('integration.dragExtEnabled', false, 'Shell drag & drop extension', '外殼拖放擴充功能',
            { hint: L('The extension is what lets a drop target be resolved without a temporary folder.', '有咗呢個擴充功能，先可以唔使臨時資料夾就知道放低咗喺邊。') }),
        ],
      },
    ],
  },

  /* ------------------------------------------------ Integration ▸ Commands */
  {
    id: 'commands',
    parent: 'integration-apps',
    icon: 'code',
    titleKey: 'pCustomCommands',
    title: L('Commands', '自訂指令'),
    sections: [
      {
        id: 'custom-commands',
        title: L('Custom commands', '自訂指令'),
        description: L('Custom commands run against the selected files. Local commands run on this computer; remote commands run on the server through a shell session.',
          '自訂指令會對住揀咗嘅檔案跑。本機指令喺呢部電腦跑，遠端指令用 shell 工作階段喺伺服器跑。'),
        controls: [
          custom('customCommands', [], 'Custom commands', '自訂指令', 'commands'),
        ],
      },
    ],
  },

  /* -------------------------------------------------------------- Storage */
  {
    id: 'storage',
    icon: 'database',
    titleKey: 'pStorage',
    title: L('Storage', '儲存'),
    sections: [
      {
        id: 'config-storage',
        title: L('Configuration storage', '設定儲存位置'),
        // A section action is a whole-document operation rather than an
        // option, so it deliberately has no preference key of its own.
        actions: [
          {
            id: 'exportConfig',
            label: L('Export the configuration…', '匯出設定…'),
            hint: L('Writes every setting, site and preset to a JSON file. Stored passwords are exported in their encrypted form.',
              '將所有設定、站點同預設組合寫入一個 JSON 檔。存低嘅密碼會以加密形式匯出。'),
          },
          {
            id: 'importConfig',
            label: L('Import a configuration…', '匯入設定…'),
            hint: L('Merges a previously exported file. The current configuration is recorded as a revision first, so this can be undone.',
              '合併之前匯出嘅檔案。而家嘅設定會先記低做一個版本，所以可以還原。'),
          },
          {
            id: 'resetPage',
            label: L('Reset every option on this page', '重設呢頁所有選項'),
            danger: true,
          },
        ],
        controls: [
          radio('security.storage', 'ini', 'Configuration storage', '設定儲存位置', [
            opt('ini', 'A configuration file beside the application data', '放喺程式資料旁邊嘅設定檔'),
            opt('registry', 'Windows registry', 'Windows 登錄檔', {
              disabled: true,
              disabledReason: L('This port stores its configuration as a file. The registry option is kept so an imported WinSCP configuration is not silently rewritten.',
                '呢個移植版用檔案存設定。登錄檔呢個選項留住，係為咗唔好靜雞雞改咗由 WinSCP 匯入嘅設定。'),
            }),
          ]),
        ],
      },
      {
        id: 'temp-dir',
        title: L('Temporary directory', '臨時目錄'),
        description: L('Edited and dragged files are downloaded here first.', '編輯同拖放嘅檔案會先下載落呢度。'),
        controls: [
          check('temporaryDirectoryCleanup', true, 'Clean up obsolete temporary directories at startup', '啟動時清走冇用嘅臨時目錄'),
          check('temporaryDirectoryAppendSession', false, 'Append the session name to the temporary path', '臨時路徑後面加工作階段名'),
          check('temporaryDirectoryAppendPath', true, 'Append the remote path to the temporary path', '臨時路徑後面加遠端路徑'),
          check('temporaryDirectoryDeterministic', false, 'Use a deterministic temporary path per file', '每個檔案用固定推算得出嘅臨時路徑',
            { hint: L('The same remote file always lands on the same local path — an external editor then reopens the file it already had.', '同一個遠端檔案永遠落到同一個本機路徑，外部編輯器就會開返佢本來嗰個檔案。') }),
        ],
      },
      {
        id: 'other-storage',
        title: L('Other', '其他'),
        controls: [
          path('security.randomSeedFile', '', 'Random seed file', '亂數種子檔案',
            { hint: L('Left empty, the platform’s own cryptographic random source is used.', '留空就用平台自己嘅密碼學亂數來源。') }),
        ],
      },
    ],
  },

  /* --------------------------------------------- Storage ▸ Version history */
  {
    id: 'version-history',
    parent: 'storage',
    icon: 'history',
    title: L('Version history', '版本紀錄'),
    description: L('Every change to a site, a preset, a command or a setting is recorded in a local Git repository beside the application data — never inside your own folders, and never pushed anywhere. Restoring writes a new revision, so an undo can itself be undone.',
      '每次改站點、預設組合、指令或者設定，都會記錄喺程式資料旁邊嘅本機 Git 倉庫——唔會放喺你自己啲資料夾入面，亦都唔會 push 去任何地方。還原都係新增一個版本，所以還原都可以還原返。'),
    sections: [
      {
        id: 'history-settings',
        title: L('Version history', '版本紀錄'),
        controls: [
          check('versionHistory.enabled', true, 'Record a revision for every change', '每次改動都記一個版本'),
          number('versionHistory.retentionDays', 365, 'Keep revisions for', '版本留幾耐',
            { min: 1, max: 10000, unit: L('days', '日'), dependsOn: 'versionHistory.enabled' }),
          number('versionHistory.maxRevisions', 5000, 'Maximum revisions kept', '最多留幾多個版本',
            { min: 10, max: 100000, dependsOn: 'versionHistory.enabled' }),
          check('versionHistory.snapshotSettings', true, 'Include the settings in each revision', '每個版本包埋設定',
            { dependsOn: 'versionHistory.enabled' }),
          check('versionHistory.snapshotSites', true, 'Include the sites in each revision', '每個版本包埋站點',
            { dependsOn: 'versionHistory.enabled' }),
        ],
      },
    ],
  },

  /* -------------------------------------------------------------- Logging */
  {
    id: 'logging',
    icon: 'receipt_long',
    titleKey: 'pLogging',
    title: L('Logging', '記錄'),
    sections: [
      {
        id: 'session-log',
        title: L('Session log', '工作階段記錄'),
        controls: [
          check('logging.enabled', false, 'Enable session logging', '啟用工作階段記錄'),
          select('logging.level', 0, 'Logging level', '記錄等級', [
            opt(0, 'Normal', '正常'),
            opt(1, 'Debug 1', '除錯 1'),
            opt(2, 'Debug 2', '除錯 2'),
          ], { dependsOn: 'logging.enabled' }),
          select('logging.logProtocol', 0, 'Protocol detail', '協定細節', [
            opt(0, 'Reduced', '精簡'),
            opt(1, 'Normal', '正常'),
            opt(2, 'Debug 1', '除錯 1'),
            opt(3, 'Debug 2', '除錯 2'),
          ], { dependsOn: 'logging.enabled' }),
          check('logging.logSensitive', false, 'Log passwords and other sensitive information', '記低密碼同其他敏感資料',
            {
              danger: true, dependsOn: 'logging.enabled',
              hint: L('Off, credentials are replaced with *** before anything is written. On, the log file contains them in clear.',
                '熄咗嘅時候，寫入之前會將認證資料換成 ***；開咗就會原原本本寫落記錄檔。'),
            }),
        ],
      },
      {
        id: 'log-file',
        title: L('Log file', '記錄檔'),
        controls: [
          check('logging.logToFile', false, 'Write the session log to a file', '將工作階段記錄寫落檔案',
            { dependsOn: 'logging.enabled' }),
          path('logging.logFileName', '%TEMP%\\!S.log', 'Log path', '記錄檔路徑',
            {
              dependsOn: 'logging.logToFile',
              hint: L('!S is the session name, !Y !M !D the date, !T the time, !P the process id, !@ the host.',
                '!S 係工作階段名，!Y !M !D 係日期，!T 係時間，!P 係程序編號，!@ 係主機。'),
            }),
          radio('logging.logFileAppend', true, 'When the log file already exists', '記錄檔已經有嘅時候', [
            opt(true, 'Append to it', '接落去'),
            opt(false, 'Overwrite it', '覆寫佢'),
          ], { dependsOn: 'logging.logToFile' }),
          select('logging.logMaxSize', 0, 'Rotate the log after it reaches', '記錄檔幾大就轉新檔',
            SIZE_OPTIONS('Never rotate', '永遠唔轉'),
            { dependsOn: 'logging.logToFile' }),
          number('logging.logMaxCount', 0, 'Rotated log files kept', '轉咗嘅記錄檔留幾多份',
            { min: 0, max: 1000, dependsOn: 'logging.logToFile', hint: L('0 keeps every rotated file.', '0 即係全部都留住。') }),
        ],
      },
      {
        id: 'log-window',
        title: L('Log window', '記錄視窗'),
        controls: [
          number('logging.logWindowLines', 800, 'Lines kept in the log window', '記錄視窗留幾多行',
            { min: 50, max: 100000 }),
          check('logging.logWindowComplete', false, 'Keep every line rather than the most recent ones', '全部行都留住，唔淨係留最新嗰啲'),
        ],
      },
      {
        id: 'xml-log',
        title: L('XML log', 'XML 記錄'),
        description: L('The machine-readable log of every action taken, for scripting and auditing.',
          '機器讀得明嘅操作記錄，寫腳本同稽核用。'),
        controls: [
          check('logging.actionsLogging', false, 'Enable XML logging to a file', '啟用寫落檔案嘅 XML 記錄'),
          path('logging.actionsLogFileName', '%TEMP%\\!S.xml', 'XML log path', 'XML 記錄檔路徑',
            { dependsOn: 'logging.actionsLogging' }),
        ],
      },
    ],
  },

  /* -------------------------------------------------------------- Updates */
  {
    id: 'updates',
    icon: 'refresh',
    titleKey: 'pUpdates',
    title: L('Updates', '更新'),
    sections: [
      {
        id: 'auto-updates',
        title: L('Automatic updates', '自動更新'),
        controls: [
          select('updates.period', 604800, 'Check for updates', '幾時檢查更新', [
            opt(0, 'Never', '永不'),
            opt(86400, 'Daily', '每日'),
            opt(604800, 'Weekly', '每星期'),
            opt(2592000, 'Monthly', '每月'),
          ]),
          check('updates.showOnStartup', true, 'Show update information on startup', '啟動時顯示更新資訊'),
          select('updates.betaVersions', 'auto', 'Include beta versions', '包唔包 beta 版', [
            opt('auto', 'Only when running a beta', '而家用緊 beta 先包'),
            opt('on', 'Always', '一律包'),
            opt('off', 'Never', '一律唔包'),
          ]),
          text('updates.authenticationEmail', '', 'Email address authorised for updates', '有權攞更新嘅電郵地址',
            { inputType: 'email', placeholder: 'you@example.com' }),
        ],
      },
      {
        id: 'updates-connection',
        title: L('Connection', '連線'),
        controls: [
          select('updates.connectionType', 'auto', 'How the update check connects', '更新檢查點樣連線', [
            opt('auto', 'Detect the proxy settings automatically', '自動偵測代理設定'),
            opt('direct', 'No proxy', '唔用代理'),
            opt('proxy', 'Use the system proxy', '用系統代理'),
          ]),
          action('updates.lastCheck', 0, 'Check for updates now', '而家就檢查更新',
            { actionId: 'checkUpdates', buttonLabel: L('Check now', '而家檢查') }),
        ],
      },
    ],
  },
];

/* ================================================================== */
/* pure helpers                                                        */
/* ================================================================== */

/** Read a dot path out of a plain object. */
export function getAt(obj, dotted) {
  if (!dotted) return obj;
  let cur = obj;
  for (const seg of String(dotted).split('.')) {
    if (cur == null) return undefined;
    cur = cur[seg];
  }
  return cur;
}

/** Write a dot path, returning a NEW object; the input is never mutated. */
export function setAt(obj, dotted, value) {
  const segs = String(dotted).split('.');
  const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const out = isPlain(obj) ? { ...obj } : {};
  let cur = out;
  for (let i = 0; i < segs.length - 1; i += 1) {
    const s = segs[i];
    cur[s] = isPlain(cur[s]) ? { ...cur[s] } : {};
    cur = cur[s];
  }
  cur[segs[segs.length - 1]] = value;
  return out;
}

/** Every page, depth-first, parents before their children. */
export function orderedPages(pages = PAGES) {
  const roots = pages.filter((p) => !p.parent);
  const out = [];
  const walk = (page, depth) => {
    out.push({ ...page, depth });
    for (const child of pages.filter((p) => p.parent === page.id)) walk(child, depth + 1);
  };
  roots.forEach((r) => walk(r, 0));
  return out;
}

export function pageById(id, pages = PAGES) { return pages.find((p) => p.id === id) || null; }

/**
 * Every control in the schema as a flat list of search entries. This is what
 * the preferences search bar filters, so a match on the Logging page is found
 * while the user is looking at Panels.
 */
/* ================================================================== */
/* options that are stored but not yet honoured                        */
/* ================================================================== */

/**
 * WinSCP options this port stores faithfully and does NOT yet act on.
 *
 * docs/porting-mandate.md is blunt about this: "a setting that persists but
 * changes no behaviour is NOT ported". Removing the controls would be worse —
 * the values are already in the store, an imported WinSCP configuration
 * carries them, and a control that vanished is a value the user can no longer
 * see or reset. So they stay, and every one of them says on its own row that
 * nothing reads it yet. Nobody has to run a grep to find out.
 *
 * The list is asserted against a real consumer scan in test/preferences.test.js:
 * a key listed here that HAS gained a consumer fails, and a wired key that
 * loses its consumer fails too. Wiring one is a two-line change — implement the
 * behaviour, delete the entry.
 *
 * "A consumer" means production code under design/, outside this dialog, that
 * READS the key — see test/helpers/consumer-scan.js. It is deliberately not
 * "the key is mentioned somewhere": the scan used to walk test/ as well, where
 * test/preferences.test.js names every key it asserts, and it used to match
 * inside comments. Eleven options were stored, rendered and read by nothing
 * while this list stayed green, eight of them because their own test named
 * them and three because one doc comment did.
 */
export const PENDING_KEYS = new Set([
  'dDAllowMoveInit',
  // Drag & drop out of the application is Explorer's IDataObject and the
  // DragExt shell extension, neither of which this port has: the panel drags
  // through the browser's own drag events. Until that lands, "drag a fake file
  // and download to where it lands", the network-drive allow list and the
  // shell-extension switch are three settings with nothing behind them.
  'dDDrives',
  'dDFakeFile',
  'editor.autoFont',
  'editor.disableSmoothScroll',
  'editor.fontCharset',
  'editor.fontName',
  'editor.sDIShellEditor',
  'editor.warnOnEncodingFallback',
  // editors.js:589 names this option in the doc comment above findOrphans()
  // and then never asks it anything: the leftover-temporary-files list is
  // reachable only when the user opens it from the Editors dialog or Cleanup,
  // so there is no startup warning for the option to suppress. The comment was
  // also the ONLY mention in the whole tree, which is how it stayed off this
  // list — the guard used to read a comment as a consumer.
  'editor.warnOrphans',
  'integration.autoOpenInPutty',
  'integration.dragExtEnabled',
  'integration.localIconsFromExplorer',
  'logging.logWindowComplete',
  'panel.showFullPathOnAddressBar',
  'queue.disconnectOnceEmpty',
  'queue.individualTransfers',
  'queue.parallelDuplicateTransfers',
  'security.randomSeedFile',
  // session.js:532-537 documents four sessionReopen* settings above
  // _scheduleReconnect, and that function reads two of them —
  // sessionReopenAuto for the delay and sessionReopenTimeout for the budget.
  // sessionReopenBackground was here too until the queue's reconnect supervisor
  // in ipc.js started reading it. Nothing measures a stall, so this one still
  // describes behaviour that does not exist.
  'security.sessionReopenAutoStall',
  'showInaccessibleDirectories',
  'timeoutOnStartup',
  'updates.authenticationEmail',
  'versionHistory.snapshotSettings',
  'versionHistory.snapshotSites',
  'window.largeToolbarIcons',
  // There is no tray icon to minimise to yet.
  'window.minimizeToTray',
  'window.openedTabsShortcut',
  'window.sessionTabCaptionTruncation',
]);

/** True when the option is stored but nothing in the application reads it yet. */
export function isPending(key) { return PENDING_KEYS.has(key); }

/** The user-facing explanation shared by every unavailable preference row. */
export function pendingMessage(language = getLanguage()) {
  const en = 'Unavailable in this build. The stored value is kept for imported configurations, but this control is read-only until the capability is ported.';
  const yue = '呢個版本未有呢項能力。設定值會保留俾匯入嘅設定，但能力未移植之前呢個掣係唯讀。';
  if (language === 'yue') return yue;
  if (language === 'both') return `${en} · ${yue}`;
  return en;
}

export function flattenControls(pages = PAGES) {
  const out = [];
  for (const page of pages) {
    for (const section of page.sections || []) {
      for (const control of section.controls || []) {
        out.push({
          pageId: page.id,
          pageTitle: page.title,
          sectionId: section.id,
          sectionTitle: section.title,
          control,
        });
      }
    }
  }
  return out;
}

/** Every distinct key the schema writes, including fan-out targets. */
export function allKeys(pages = PAGES) {
  const keys = new Set();
  for (const { control } of flattenControls(pages)) {
    if (control.key) keys.add(control.key);
    for (const k of control.alsoKeys || []) keys.add(k);
  }
  return Array.from(keys);
}

const isBoth = () => getLanguage() === 'both';

/**
 * Resolve a bilingual string for the active language mode. Short pairs inline
 * with a middle dot exactly as i18n.bilingualNode does; this variant returns a
 * plain string because it is also used for titles, aria-labels and the search
 * corpus, where a DocumentFragment is no use.
 */
export function localized(pair, language = getLanguage()) {
  if (pair == null) return '';
  if (typeof pair === 'string') return pair;
  if (language === 'yue') return pair.yue || pair.en || '';
  if (language === 'both') {
    const en = pair.en || '';
    const yue = pair.yue || '';
    if (!yue || en === yue) return en;
    return `${en} · ${yue}`;
  }
  return pair.en || pair.yue || '';
}

/** Both languages, whatever the mode — the search always indexes both. */
export function bothOf(pair) {
  if (pair == null) return [];
  if (typeof pair === 'string') return [pair];
  return [pair.en, pair.yue].filter(Boolean);
}

/** The value a control shows, given the stored value (scale applied). */
export function toUiValue(control, stored) {
  if (control.scale && typeof stored === 'number') {
    const ui = stored / control.scale;
    return Math.abs(ui - Math.round(ui)) < 1e-9 ? Math.round(ui) : Number(ui.toFixed(3));
  }
  return stored;
}

/** The value a control stores, given what the user typed (scale applied). */
export function toStoredValue(control, ui) {
  if (control.scale) {
    const n = Number(ui);
    if (!Number.isFinite(n)) return control.def;
    const scaled = n * control.scale;
    return Math.abs(scaled - Math.round(scaled)) < 1e-9 ? Math.round(scaled) : scaled;
  }
  if (control.type === 'number' || control.type === 'slider') {
    const n = Number(ui);
    return Number.isFinite(n) ? n : control.def;
  }
  return ui;
}

/** Clamp a numeric control's value into its declared range. */
export function clampToRange(control, ui) {
  const n = Number(ui);
  if (!Number.isFinite(n)) return control.min ?? 0;
  let v = n;
  if (typeof control.min === 'number') v = Math.max(control.min, v);
  if (typeof control.max === 'number') v = Math.min(control.max, v);
  return v;
}

/** Normalize a numeric editor to the exact value that will be persisted. */
export function normalizeNumberInput(control, ui) {
  const clamped = clampToRange(control, ui);
  return { ui: clamped, stored: toStoredValue(control, clamped) };
}

/**
 * A human-readable rendering of a control's current value, in both languages.
 * The search matches against this, so typing "Debug 2" finds the logging level
 * even though the stored value is the number 2.
 */
export function describeValue(control, stored, language = getLanguage()) {
  if (control.type === 'custom') {
    const n = Array.isArray(stored) ? stored.length : 0;
    return language === 'yue' ? `${n} 項` : `${n} entries`;
  }
  if (control.type === 'action') return '';
  if (control.options) {
    const hit = control.options.find((o) => o.value === stored);
    if (hit) return localized(hit.label, language);
    return String(stored ?? '');
  }
  if (typeof stored === 'boolean') {
    if (language === 'yue') return stored ? '開' : '熄';
    if (language === 'both') return stored ? 'On · 開' : 'Off · 熄';
    return stored ? 'On' : 'Off';
  }
  if (stored === '' || stored == null) {
    return language === 'yue' ? '（空白）' : '(empty)';
  }
  const ui = toUiValue(control, stored);
  const unit = control.unit ? ` ${localized(control.unit, language)}` : '';
  return `${ui}${unit}`;
}

/**
 * The strings one control contributes to the search corpus: its label and hint
 * in BOTH languages, its key, its option labels and its current value. Both
 * languages are always indexed so a Cantonese user searching "記錄" and an
 * English user searching "log" reach the same row.
 */
export function searchFieldsFor(entry, stored) {
  const c = entry.control;
  const fields = [
    ...bothOf(c.label),
    ...bothOf(c.hint),
    ...bothOf(entry.pageTitle),
    ...bothOf(entry.sectionTitle),
    c.key || '',
  ];
  for (const o of c.options || []) fields.push(...bothOf(o.label));
  fields.push(describeValue(c, stored, 'en'));
  fields.push(describeValue(c, stored, 'yue'));
  return fields.filter(Boolean);
}

/**
 * Apply a search-bar predicate to the flattened control list.
 * `read(key)` supplies the current value so a search can match it.
 */
export function matchPreferences(entries, predicate, read = () => undefined) {
  if (!predicate || !predicate.ok) return [];
  return entries.filter((entry) => {
    const fields = searchFieldsFor(entry, read(entry.control.key));
    return fields.some((f) => predicate.test(f));
  });
}

/** Matches grouped by page, in schema order, with counts. */
export function matchesByPage(matches, pages = PAGES) {
  const counts = new Map();
  for (const m of matches) counts.set(m.pageId, (counts.get(m.pageId) || 0) + 1);
  return orderedPages(pages)
    .filter((p) => counts.has(p.id))
    .map((p) => ({ pageId: p.id, title: p.title, depth: p.depth, count: counts.get(p.id) }));
}

/**
 * Whether a control's precondition holds. `dependsOn` is a key name, or
 * { key, equals } / { key, not } / { key, greaterThan }, or a predicate.
 */
export function controlEnabled(control, read) {
  const dep = control.dependsOn;
  if (!dep) return true;
  if (typeof dep === 'function') return !!dep(read);
  if (typeof dep === 'string') return !!read(dep);
  const value = read(dep.key);
  if ('equals' in dep) return value === dep.equals;
  if ('not' in dep) return value !== dep.not;
  if ('greaterThan' in dep) return Number(value) > Number(dep.greaterThan);
  return !!value;
}

export const CONTROL_TYPES = new Set([
  'check', 'radio', 'select', 'number', 'slider', 'text', 'path', 'color', 'font', 'action', 'custom',
]);

/**
 * Validate the schema against the real defaults. Used by the test suite, and
 * deliberately returns every problem rather than throwing on the first: a
 * partial report of a schema this size is not worth reading.
 *
 * `stores` maps a descriptor's `store` name to the defaults object that backs
 * it — 'prefs' (design/main/defaults.js) and 'renderer' (state.js).
 */
export function validateSchema({ pages = PAGES, stores = {} } = {}) {
  const errors = [];
  const seenPages = new Set();
  const seenControlKeys = new Map();
  let checked = 0;

  const deepEqual = (a, b) => {
    if (a === b) return true;
    if (typeof a !== typeof b || a == null || b == null) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (typeof a !== 'object') return false;
    const ka = Object.keys(a); const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => deepEqual(a[k], b[k]));
  };

  for (const page of pages) {
    if (seenPages.has(page.id)) errors.push(`duplicate page id "${page.id}"`);
    seenPages.add(page.id);
    if (!page.title || !page.title.en || !page.title.yue) errors.push(`page "${page.id}" needs a bilingual title`);
    if (page.parent && !pages.some((p) => p.id === page.parent)) {
      errors.push(`page "${page.id}" names a parent "${page.parent}" that does not exist`);
    }
    for (const section of page.sections || []) {
      if (!section.title || !section.title.en || !section.title.yue) {
        errors.push(`section "${page.id}/${section.id}" needs a bilingual title`);
      }
      for (const control of section.controls || []) {
        checked += 1;
        const where = `${page.id}/${section.id}/${control.key}`;
        if (!control.key) { errors.push(`${where}: a control has no key`); continue; }
        if (!CONTROL_TYPES.has(control.type)) errors.push(`${where}: unknown control type "${control.type}"`);
        if (!control.label || !control.label.en || !control.label.yue) errors.push(`${where}: needs a bilingual label`);
        if ((control.type === 'number' || control.type === 'slider')
          && control.min != null && control.max != null) {
          if (!Number.isFinite(control.min) || !Number.isFinite(control.max) || control.min > control.max) {
            errors.push(`${where}: invalid numeric range`);
          }
          const uiDefault = typeof control.def === 'number' ? toUiValue(control, control.def) : control.def;
          if (typeof uiDefault === 'number' && (uiDefault < control.min || uiDefault > control.max)) {
            errors.push(`${where}: default ${control.def} is outside its numeric range`);
          }
        }

        const storeName = control.store || 'prefs';
        const defaults = stores[storeName];
        if (!defaults) { errors.push(`${where}: unknown backing store "${storeName}"`); continue; }

        for (const key of [control.key, ...(control.alsoKeys || [])]) {
          const resolved = getAt(defaults, key);
          if (resolved === undefined) {
            errors.push(`${where}: "${key}" does not exist in the ${storeName} defaults`);
          }
        }

        if ('def' in control) {
          const real = getAt(defaults, control.key);
          if (real !== undefined && !deepEqual(real, control.def)) {
            errors.push(`${where}: declared default ${JSON.stringify(control.def)} but the ${storeName} defaults say ${JSON.stringify(real)}`);
          }
        }

        if (control.options) {
          const values = control.options.map((o) => o.value);
          if (new Set(values.map((v) => JSON.stringify(v))).size !== values.length) {
            errors.push(`${where}: duplicate option values`);
          }
          for (const o of control.options) {
            if (!o.label || !o.label.en || !o.label.yue) errors.push(`${where}: option "${o.value}" needs a bilingual label`);
          }
          const hasDefault = values.some((v) => deepEqual(v, control.def));
          if (!hasDefault) errors.push(`${where}: the default ${JSON.stringify(control.def)} is not one of the offered options`);
        }

        if (control.dependsOn && typeof control.dependsOn === 'object' && !control.dependsOn.key) {
          errors.push(`${where}: dependsOn needs a key`);
        }
        const depKey = typeof control.dependsOn === 'string'
          ? control.dependsOn
          : (control.dependsOn && control.dependsOn.key);
        if (depKey && getAt(stores[control.store || 'prefs'], depKey) === undefined
          && getAt(stores.prefs, depKey) === undefined) {
          errors.push(`${where}: dependsOn "${depKey}" is not a real key`);
        }

        // Virtual controls are rendered by a custom frame and legitimately
        // appear twice; anything else appearing twice is a copy-paste slip.
        if (!control.virtual) {
          const prev = seenControlKeys.get(control.key);
          if (prev) errors.push(`${where}: "${control.key}" is also declared at ${prev}`);
          else seenControlKeys.set(control.key, where);
        }
      }
    }
  }
  return { errors, checked };
}

/* ================================================================== */
/* the generic control renderer                                        */
/* ================================================================== */
//
// Everything below touches the DOM, and nothing above it does. renderControl()
// is shared by the preferences pages and by the transfer-settings frame, so a
// checkbox looks and behaves identically wherever it appears.
//
// ctx:
//   read(key)              current value
//   write(control, value)  commit (the caller decides how it persists)
//   language               active language mode
//   custom                 { color, font, action, <customKind> } factories
//   refresh()              re-render the page (dependencies changed)

function labelText(pair, language) { return localized(pair, language); }

/**
 * Accept either a Node or one of this codebase's `{ element, destroy }` module
 * handles. Several shared components (the colour swatch, the list editors)
 * return the handle, and appending a handle silently renders "[object Object]"
 * — so it is unwrapped here once rather than at every call site.
 */
function asNode(value) {
  if (!value) return null;
  if (value instanceof Node) return value;
  if (value.element instanceof Node) return value.element;
  return null;
}

/** A row wrapper carrying the label, the control and its hint. */
function row(control, language, controlNode, opts = {}) {
  const id = opts.id || uid('pref');
  const hintId = control.hint ? uid('pref-hint') : null;
  const pendingId = opts.pending ? uid('pref-pending') : null;
  const parts = [];

  if (opts.labelInline) {
    parts.push(controlNode);
  } else {
    const lab = h('label', { class: 'pref-label', for: id }, labelText(control.label, language));
    parts.push(lab, controlNode);
  }

  const meta = [];
  if (control.hint) meta.push(h('p', { class: 'pref-hint', id: hintId }, labelText(control.hint, language)));
  if (control.restart) {
    meta.push(h('p', { class: 'pref-hint is-restart' },
      language === 'yue' ? '要下次啟動先生效。'
        : language === 'both' ? 'Applies on the next start. · 要下次啟動先生效。'
          : 'Applies on the next start.'));
  }
  if (opts.pending) {
    meta.push(h('p', { class: 'pref-hint is-pending', id: pendingId }, pendingMessage(language)));
  }
  if (control.danger) {
    meta.push(h('p', { class: 'pref-hint is-danger' },
      language === 'yue' ? '呢個選項會令資料冇咁安全。'
        : language === 'both' ? 'This option lowers the protection of stored data. · 呢個選項會令資料冇咁安全。'
          : 'This option lowers the protection of stored data.'));
  }

  const rowEl = h('div', {
    class: `pref-row pref-row-${control.type}${opts.disabled ? ' is-disabled' : ''}${opts.pending ? ' is-unavailable' : ''}`,
    'data-pref-key': control.key,
    'data-pref-status': opts.pending ? 'unavailable' : 'wired',
    // Keep the row's announced state in sync with both dependency-disabled
    // controls and settings unavailable in this build. Native descendants
    // already carry their own disabled state; the wrapper must tell assistive
    // technology the same thing when focus lands on a composite editor.
    'aria-disabled': (opts.disabled || opts.pending) ? 'true' : 'false',
  }, ...parts, ...meta);
  appearanceTarget(rowEl, `pref-row-${control.key}`, `Preference: ${control.label.en}`);
  const describedBy = [hintId, pendingId].filter(Boolean).join(' ');
  if (describedBy) controlNode.setAttribute?.('aria-describedby', describedBy);
  return rowEl;
}

/**
 * Enable or disable a whole row's controls. An option the build marked
 * `data-perm-disabled` stays disabled whatever the row's dependency says: that
 * flag is how the schema greys out something this port genuinely cannot do
 * (registry storage), and re-enabling it here would offer the user a choice
 * that cannot be honoured — the exact failure the disabled state exists to
 * prevent.
 */
function applyDisabled(node, disabled) {
  if (!node) return;
  const set = (el) => {
    const isDisabled = el.dataset?.permDisabled === '1' ? true : !!disabled;
    el.disabled = isDisabled;
    // Native disabled controls announce their state automatically. Shared
    // preference editors may instead expose a focusable button or composite;
    // mirror the state explicitly so assistive technology gets the same
    // answer regardless of which renderer supplied the control.
    el.setAttribute('aria-disabled', String(isDisabled));
  };
  if (node.tagName === 'INPUT' || node.tagName === 'SELECT' || node.tagName === 'BUTTON' || node.tagName === 'TEXTAREA') {
    set(node);
    return;
  }
  // A custom renderer may hand back a fragment or a text node; those have no
  // controls to disable and must not take the whole page down with them.
  if (typeof node.querySelectorAll !== 'function') return;
  for (const el of node.querySelectorAll('input, select, button, textarea')) set(el);
  if (node.getAttribute?.('tabindex') !== null) node.setAttribute('aria-disabled', String(!!disabled));
}

/**
 * Build the DOM for one control. Returns an element; the caller appends it.
 * A control that cannot be represented (an unknown type) renders its stored
 * value read-only with the reason, rather than disappearing and silently
 * dropping what the user had.
 */
export function renderControl(control, ctx) {
  const language = ctx.language || getLanguage();
  const enabled = controlEnabled(control, ctx.read);
  const pending = isPending(control.key);
  const stored = ctx.read(control.key);
  const id = uid('pref');
  const commit = (value) => ctx.write(control, value);

  const build = () => {
    switch (control.type) {
      case 'check': {
        const input = h('input', {
          type: 'checkbox', id, class: 'pref-check-input',
          onchange: () => commit(input.checked),
        });
        input.checked = !!stored;
        const wrap = h('label', { class: 'pref-check', for: id },
          input,
          h('span', { class: 'pref-check-box' }),
          h('span', { class: 'pref-check-label' }, labelText(control.label, language)));
        return { node: wrap, labelInline: true, focusable: input };
      }
      case 'radio': {
        const name = uid('pref-radio');
        const group = h('div', { role: 'radiogroup', class: 'pref-radios', 'aria-labelledby': `${id}-legend` });
        for (const o of control.options) {
          const rid = uid('pref-opt');
          const input = h('input', {
            type: 'radio', name, id: rid, class: 'pref-radio-input',
            onchange: () => { if (input.checked) commit(o.value); },
          });
          input.checked = stored === o.value;
          if (o.disabled) { input.disabled = true; input.dataset.permDisabled = '1'; }
          const item = h('label', { class: `pref-radio${o.disabled ? ' is-disabled' : ''}`, for: rid },
            input,
            h('span', { class: 'pref-radio-dot' }),
            h('span', { class: 'pref-radio-label' }, labelText(o.label, language)));
          group.appendChild(item);
          if (o.disabled && o.disabledReason) {
            group.appendChild(h('p', { class: 'pref-hint is-unsupported' }, labelText(o.disabledReason, language)));
          }
        }
        const fs = h('div', { class: 'pref-fieldset' },
          h('span', { class: 'pref-label', id: `${id}-legend` }, labelText(control.label, language)),
          group);
        return { node: fs, labelInline: true, focusable: group.querySelector('input') };
      }
      case 'select': {
        const sel = h('select', { id, class: 'field-input pref-select', onchange: () => {
          const chosen = control.options[sel.selectedIndex];
          if (chosen) commit(chosen.value);
        } });
        control.options.forEach((o, i) => {
          const optEl = h('option', { value: String(i) }, labelText(o.label, language));
          if (o.disabled) optEl.disabled = true;
          sel.appendChild(optEl);
        });
        const idx = control.options.findIndex((o) => o.value === stored);
        sel.selectedIndex = idx >= 0 ? idx : 0;
        if (idx < 0) {
          // Never silently drop a stored value the list cannot show.
          const extra = h('option', { value: 'x', selected: true }, String(stored));
          sel.appendChild(extra);
          sel.selectedIndex = sel.options.length - 1;
        }
        return { node: sel, id, focusable: sel };
      }
      case 'number': {
        const input = h('input', {
          type: 'number', id, class: 'field-input pref-number', inputmode: 'decimal',
          min: control.min, max: control.max, step: control.step || 1,
          onchange: () => {
            const normalized = normalizeNumberInput(control, input.value);
            input.value = String(normalized.ui);
            commit(normalized.stored);
          },
        });
        input.value = String(toUiValue(control, stored ?? control.def));
        const wrap = control.unit
          ? h('span', { class: 'pref-inline' }, input, h('span', { class: 'pref-unit' }, labelText(control.unit, language)))
          : input;
        return { node: wrap, id, focusable: input };
      }
      case 'slider': {
        const input = h('input', {
          type: 'range', id, class: 'slider',
          min: String(control.min ?? 0), max: String(control.max ?? 100), step: String(control.step ?? 1),
        });
        input.value = String(toUiValue(control, stored ?? control.def));
        const out = h('output', { class: 'slider-value' });
        const paint = () => {
          const n = Number(input.value);
          const text_ = control.valueLabel ? control.valueLabel(n, language) : String(n);
          out.textContent = text_;
          input.setAttribute('aria-valuetext', text_);
        };
        input.addEventListener('input', () => { paint(); commit(toStoredValue(control, input.value)); });
        paint();
        return { node: h('span', { class: 'slider-wrap' }, input, out), id, focusable: input };
      }
      case 'text': {
        const input = h('input', {
          type: control.inputType || 'text', id, class: 'field-input pref-text',
          autocomplete: 'off', spellcheck: 'false',
          placeholder: control.placeholder || '',
          maxlength: control.maxLength,
          onchange: () => commit(input.value),
        });
        input.value = stored == null ? '' : String(stored);
        if (control.mask && ctx.custom && typeof ctx.custom.mask === 'function') {
          return { node: ctx.custom.mask(control, input), id, focusable: input };
        }
        return { node: input, id, focusable: input };
      }
      case 'path': {
        const input = h('input', {
          type: 'text', id, class: 'field-input pref-text', autocomplete: 'off', spellcheck: 'false',
          placeholder: control.placeholder || '',
          onchange: () => commit(input.value),
        });
        input.value = stored == null ? '' : String(stored);
        const browse = h('button', {
          type: 'button', class: 'btn-text pref-browse',
          onclick: async () => {
            const picked = await ctx.pickPath?.(control, input.value);
            if (picked) { input.value = picked; commit(picked); }
          },
        }, language === 'yue' ? '瀏覽…' : 'Browse…');
        if (!ctx.pickPath) browse.disabled = true;
        return { node: h('span', { class: 'pref-inline' }, input, browse), id, focusable: input };
      }
      case 'color': {
        if (ctx.custom && typeof ctx.custom.color === 'function') {
          const node = asNode(ctx.custom.color(control, stored, commit));
          if (node) return { node, id, focusable: node.querySelector?.('button') || node };
        }
        const input = h('input', {
          type: 'text', id, class: 'field-input pref-text mono', spellcheck: 'false',
          onchange: () => commit(input.value),
        });
        input.value = stored == null ? '' : String(stored);
        return { node: input, id, focusable: input };
      }
      case 'font': {
        if (ctx.custom && typeof ctx.custom.font === 'function') {
          const node = asNode(ctx.custom.font(control, stored, commit));
          if (node) return { node, id, focusable: node.querySelector?.('input, select, button') || node };
        }
        const input = h('input', {
          type: 'text', id, class: 'field-input pref-text', spellcheck: 'false',
          onchange: () => commit(input.value),
        });
        input.value = stored == null ? '' : String(stored);
        return { node: input, id, focusable: input };
      }
      case 'action': {
        const btn = h('button', {
          type: 'button', class: 'btn-tonal pref-action', id,
          onclick: () => ctx.runAction?.(control),
        }, labelText(control.buttonLabel || control.label, language));
        if (!ctx.runAction) btn.disabled = true;
        return { node: btn, id, focusable: btn };
      }
      case 'custom': {
        const factory = ctx.custom && ctx.custom[control.custom];
        const node = typeof factory === 'function' ? asNode(factory(control, stored, commit)) : null;
        if (node) return { node, labelInline: true };
        return {
          node: h('p', { class: 'pref-hint is-unsupported' },
            language === 'yue'
              ? `「${control.label.yue}」呢個編輯器喺呢度未載入到，你嘅設定原封不動。`
              : `The editor for "${control.label.en}" is not loaded in this surface; your stored value is untouched.`),
          labelInline: true,
        };
      }
      default: {
        return {
          node: h('p', { class: 'pref-hint is-unsupported' },
            `${control.type} is not a control type this build can render. The stored value ${JSON.stringify(stored)} is kept.`),
          labelInline: true,
        };
      }
    }
  };

  const built = build();
  applyDisabled(built.node, !enabled || pending);
  // A colour swatch or a font button is built by a shared component that owns
  // its own markup, so the id the row's <label for> points at has to be put
  // onto whatever inside it takes focus. Without this the label is an orphan:
  // clicking it does nothing and it names no control.
  const rowId = built.id || id;
  if (!built.labelInline && built.focusable instanceof Element && !built.focusable.id) {
    built.focusable.id = rowId;
  }
  return row(control, language, built.node, {
    id: rowId, labelInline: built.labelInline,
    disabled: !enabled || pending, pending,
  });
}
