// roadmap-issues.js — keep the roadmap mirrored as GitHub issues.
//
// The roadmap lives in two places on purpose: docs/ for readers of the repo,
// and issues for anyone watching the project. This creates the issues once and
// is safe to re-run — an issue whose title already exists is left alone rather
// than duplicated.
//
// Run: node tools/roadmap-issues.js [--dry]
'use strict';
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = 'Ding-Ding-Projects/material-winscp';

const ISSUES = [
  {
    title: '🗺️ Roadmap: SFTP + SCP protocol layer · SFTP 同 SCP 協定層',
    labels: ['roadmap', 'protocol'],
    body: `Port \`core/SftpFileSystem\` (5,930 lines), \`core/ScpFileSystem\`, \`core/SecureShell\`, \`core/PuttyIntf\`.

**Scope** — full SFTP v3–v6, SCP over shell, every authentication method (password, keyboard-interactive, public key + passphrase, agent, GSSAPI), SSH tunnels, proxies (HTTP/SOCKS4/SOCKS5/local command), compression, rekey limits, keepalives, every SFTP/SSH bug workaround WinSCP detects, resume via stream offsets, chmod/chown/utimes, symlinks, checksums, statvfs.

**Replacement note** — \`putty/\` (82,710 lines) is a third-party engine WinSCP vendors rather than authors; \`ssh2\` supplies that layer. Any capability PuTTY exposes that \`ssh2\` does not is a **real gap** tracked here, not waved through.

**範圍** — 完整 SFTP v3–v6、SCP、全部認證方式、SSH tunnel、proxy、壓縮、rekey、keepalive，同埋 WinSCP 識得繞開嘅每一個伺服器 bug。做唔到嘅唔准當做咗。

Tracked in \`docs/port-coverage.md\` · mandate in \`docs/porting-mandate.md\`.`,
  },
  {
    title: '🗺️ Roadmap: FTP, WebDAV and S3 protocol layers · FTP、WebDAV、S3 協定層',
    labels: ['roadmap', 'protocol'],
    body: `Port \`core/FtpFileSystem\` (4,270 lines), \`core/WebDAVFileSystem\`, \`core/S3FileSystem\`, \`core/NeonIntf\`, \`core/Http\`.

**Scope**
- **FTP/FTPS** — explicit + implicit TLS, passive/active, MLSD and LIST parsing across unix/DOS/VMS dialects, MFMT, SITE CHMOD, REST resume, certificate verification that actually prompts.
- **WebDAV** — PROPFIND with real XML parsing across server dialects, Basic + Digest auth, Range resume, MOVE/COPY.
- **S3** — hand-written AWS SigV4 (no AWS SDK), ListObjectsV2 paging, multipart upload with abort-on-failure so no orphan parts are left, STS AssumeRole, virtual-host vs path style, S3-compatible endpoints.

**Replacement note** — \`filezilla/\` (19,447 lines) is vendored third-party; \`basic-ftp\` supplies that layer.

**範圍** — FTP/FTPS、WebDAV、S3 三條協定全部原生寫，唔用 AWS SDK，SigV4 自己簽，仲要用 AWS 官方測試向量驗證。`,
  },
  {
    title: '🗺️ Roadmap: transfer queue and copy parameters · 傳輸佇列同傳輸參數',
    labels: ['roadmap', 'transfers'],
    body: `Port \`core/Queue\`, \`core/CopyParam\`, \`core/FileOperationProgress\`, \`windows/QueueController\`, \`forms/Progress\` (3,811 .dfm lines), \`forms/Copy\`, \`forms/CopyParams\`, \`forms/CopyParamPreset\`.

**Scope** — parallel transfers, per-item and global pause/resume, reordering, speed limits enforced by a real token bucket (not a sleep loop), resume (on/off/smart + threshold + \`.filepart\`), overwrite/resume/append prompts with all-and-skip-all, text-mode EOL conversion driven by the ASCII mask, BOM and Ctrl-Z handling, filename case conversion, invalid-character replacement, timestamp and permission preservation, once-done actions (disconnect/suspend/shutdown/idle), and reconnect-and-**resume** rather than restart.

**範圍** — 並行傳輸、暫停續傳、限速、覆寫確認、文字模式換行轉換、斷線之後接返落去而唔係由頭嚟過。`,
  },
  {
    title: '🗺️ Roadmap: synchronization and comparison checklist · 同步同比較清單',
    labels: ['roadmap', 'sync'],
    body: `Port synchronization from \`core/Terminal\`, \`windows/SynchronizeController\`, \`forms/FullSynchronize\`, \`forms/Synchronize\`, \`forms/SynchronizeChecklist\` (3,738 .dfm lines), \`forms/SynchronizeProgress\`.

**Scope** — every direction (local/remote/both) × mode (synchronize/mirror/timestamp) × criteria (time/size/either/none), delete-extra, existing-only, a preview checklist with per-item override, and keep-remote-directory-up-to-date watching.

> [!WARNING]
> DST and timezone adjustment is the classic source of "everything looks changed". It must be implemented the way WinSCP does it **and** covered by tests.

**範圍** — 所有方向 × 模式 × 比較準則，仲有預覽清單。夏令時間嗰part一定要照 WinSCP 做，唔係就成個 folder 睇落好似全部改晒。`,
  },
  {
    title: '🗺️ Roadmap: session management, terminal and reconnect · 工作階段管理',
    labels: ['roadmap', 'sessions'],
    body: `Port \`core/Terminal\`, \`core/SessionInfo\`, \`core/SessionData\`, \`windows/TerminalManager\`, \`forms/Authenticate\`, \`forms/FileSystemInfo\`, \`forms/Console\` (2,368 .dfm lines).

**Scope** — multiple concurrent sessions, host key and certificate verification that genuinely **prompts** (never auto-accept), credential prompts including 2FA/keyboard-interactive, automatic reconnect with the configured backoff, directory caching, session log at normal/debug1/debug2 plus the XML actions log, change password, generate session URL/code, and the remote command console.

**範圍** — 多開session、host key 一定要問過你先接受、斷線自動接返、完整 log。`,
  },
  {
    title: '🗺️ Roadmap: configuration, sites, workspaces, import/export · 設定同站點',
    labels: ['roadmap', 'config'],
    body: `Port \`core/Configuration\`, \`core/HierarchicalStorage\`, \`windows/WinConfiguration\`, \`windows/CustomWinConfiguration\`, \`windows/GUIConfiguration\`, \`core/Bookmarks\`, \`forms/ImportSessions\`, \`forms/LocationProfiles\` (1,268 .dfm lines), \`forms/Cleanup\`.

**Scope** — the full option set, site folders, workspaces, bookmarks and location profiles, combo histories, INI import/export for WinSCP interoperability, importing sites from PuTTY / FileZilla / OpenSSH config, and configuration cleanup.

**範圍** — 全部設定、站點資料夾、工作區、書籤，同埋由 PuTTY/FileZilla/OpenSSH 匯入站點。`,
  },
  {
    title: '🗺️ Roadmap: Preferences dialog — 293 controls across 9 pages · 偏好設定',
    labels: ['roadmap', 'dialogs'],
    body: `Port \`forms/Preferences\` (3,776 .dfm lines).

**293 interactive controls across 9 tab sheets.** The exact control list is extracted from the original into \`docs/dialog-inventory.md\` and \`design/renderer/forms.json\`.

> [!IMPORTANT]
> Every option must change real behaviour. A setting that persists but does nothing is **not ported** — see \`docs/porting-mandate.md\`.

Each page also carries its own search bar wired to the full regex builder, per the shared instructions.

**注意** — 每個選項都要真係有作用。淨係識記住但係乜都唔做嘅設定，唔算做完。`,
  },
  {
    title: '🗺️ Roadmap: Advanced Site Settings — 247 controls across 18 pages · 進階站點設定',
    labels: ['roadmap', 'dialogs'],
    body: `Port \`forms/SiteAdvanced\` (4,010 .dfm lines).

**247 interactive controls across 18 tab sheets**: Environment, Directories, Recycle bin, Encryption, SFTP, SCP/Shell, Connection, Proxy, Tunnel, SSH, Key exchange, Authentication, Bugs, Note, FTP, TLS/SSL, S3, PuTTY.

Includes every SSH/SFTP bug-workaround toggle and the full algorithm-preference ordering lists (cipher, key exchange, host key, GSSAPI library order).

**範圍** — 18 版嘢，247 個控制項，連每個 SSH bug 嘅繞道開關同演算法排序都要有。`,
  },
  {
    title: '🗺️ Roadmap: the remaining 46 dialogs · 其餘 46 個對話框',
    labels: ['roadmap', 'dialogs'],
    body: `Port every remaining dialog listed in \`docs/dialog-inventory.md\`: Login, Properties, Rights, CustomCommand, FileFind, Editor, EditorPreferences, GenerateUrl, OpenDirectory, EditMask, SelectMask, Symlink, RemoteTransfer, CreateDirectory, About, License, MessageDlg, Custom, CopyLocal, CopyParamCustom, and the rest.

**Application-wide totals: 48 dialogs · 2,982 controls · 1,059 interactive.**

**全個 app 加埋：48 個對話框、2,982 個控制項、其中 1,059 個要真係做到嘢。**`,
  },
  {
    title: '🗺️ Roadmap: Commander/Explorer panels and all 301 actions · 檔案面板同 301 個指令',
    labels: ['roadmap', 'ui'],
    body: `Port \`forms/CustomScpExplorer\`, \`forms/ScpCommander\`, \`forms/ScpExplorer\`, and \`components/\` (the file panel controls).

**All 301 actions** are already extracted from the original's \`NonVisual.dfm\` into \`design/renderer/actions.js\` with captions, hints and 79 keyboard shortcuts.

> [!IMPORTANT]
> Every action must resolve to a real handler. A menu entry wired to "not implemented" is worse than an absent one, because it lies to the user.

Includes both interfaces, drive and tree views, column sets and sorting, incremental search, filters, thumbnails, drag and drop, and synchronized browsing.

**301 個指令全部要有真嘅handler。**撳落去彈「未做」比冇個menu更差。`,
  },
  {
    title: '🗺️ Roadmap: internal and external editor · 內建同外部編輯器',
    labels: ['roadmap', 'editor'],
    body: `Port \`forms/Editor\` (6,264 .dfm lines), \`forms/EditorPreferences\`, \`windows/EditorManager\`.

**Scope** — internal editor with find/replace, encoding detection and selection, word wrap, tab size and fonts; external editor launching with change watching and upload-on-save; editor selection by file mask; "check the remote file has not changed before saving it"; temporary file retention and cleanup; orphan warnings.

**範圍** — 內建編輯器同外部編輯器，改完自動上傳，上傳前仲要check返伺服器嗰份有冇畀人改過。`,
  },
  {
    title: '🗺️ Roadmap: security, master password and host keys · 保安同主密碼',
    labels: ['roadmap', 'security'],
    body: `Port \`core/Security\`, \`core/Cryptography\`, and WinSCP's credential handling.

**Scope** — OS-keychain protection by default, scrypt-wrapped secrets under a master password, master password set/change/disable with re-wrapping of every stored secret, the host key and TLS certificate trust store, WinSCP password-format compatibility for imported sites, and the at-rest file-encryption site option.

> [!IMPORTANT]
> A secret is never written in clear. If no protection is available it is **not stored** — a password in plaintext is not storage, it is a leak with extra steps.

**重點** — 冇得加密就唔存。寫明文出去唔叫「儲存」，叫漏底。`,
  },
  {
    title: '🗺️ Roadmap: scripting, console and command line · 指令稿同命令列',
    labels: ['roadmap', 'scripting'],
    body: `Port \`core/Script\`, \`core/Option\`, \`console/\`, \`windows/ConsoleRunner\`, \`windows/ProgParams\`.

**Scope** — the full scripting command set, \`winscp://\` and \`sftp://\` URL handling, command-line switches (\`/console\`, \`/script\`, \`/command\`, \`/log\`, \`/ini\`, \`/rawsettings\`), session URL and code generation, and batch/non-interactive behaviour.

**範圍** — 完整指令稿、URL handler、命令列參數、批次模式。`,
  },
  {
    title: '🗺️ Roadmap: packaging, Squirrel installer, CI and updates · 打包同安裝程式',
    labels: ['roadmap', 'packaging'],
    body: `Electron Forge + \`@electron-forge/maker-squirrel\` producing a real Windows installer.

**Scope** — the Squirrel install/update/uninstall lifecycle (shortcut creation and removal), CI on every push and \`workflow_dispatch\` that runs the tests and, **only on green**, publishes exactly one uniquely tagged non-draft release carrying the genuine installer built by that run, a real dim sum photo asset, and a dim sum code name used once per release; plus in-app update checking.

> [!NOTE]
> Failed tests must produce **no** release. A release with no installer attached, or an installer that was not built by that run, does not count.

**注意** — 測試唔過就唔出 release。冇裝到嘅安裝檔唔算數。`,
  },
  {
    title: '🗺️ Roadmap: interface requirements from the shared instructions · 共用規範嘅介面要求',
    labels: ['roadmap', 'ui'],
    body: `Beyond WinSCP parity, these are shipping requirements — not polish:

- [ ] **Material Design 3** throughout — tokens, typography, shape, elevation, motion, no legacy chrome
- [ ] **Three language modes** (English, playful Hong Kong Cantonese, bilingual) and **two independent funny-level sliders** (1–5, one per language) wired to real rendered copy
- [ ] **Regex builder** anchored beside *every* search bar, including every settings surface
- [ ] **Tabbed navigation** with overflow, reordering, pinning, grouping and all four tab-discovery searches
- [ ] **Appearance editor** per element, Word-depth typography, infinite colour picker + colour translator
- [ ] **Non-blocking notifications** plus a notification centre
- [ ] **Local Git-backed version history**, append-only, covering settings and sites as well as documents
- [ ] **Changelog viewer** with an advanced date filter and regex search
- [ ] **Dim sum surprise** — 10% per launch, non-blocking, no opt-out
- [ ] **Accessibility** — keyboard, visible focus, roles/names/states, contrast, reduced motion
- [ ] **Landing page + documentation site**, fully local, one article per feature

**除咗要同 WinSCP 一模一樣，呢啲都係出貨要求，唔係做完先算靚仔嘅嘢。**`,
  },
  {
    title: '🗺️ Roadmap: drag-and-drop and Explorer shell integration · 拖放同 Explorer 整合',
    labels: ['roadmap', 'ui'],
    body: `Port \`dragext/\` and the drag-and-drop paths in \`forms/CustomScpExplorer\`.

**Scope** — drag and drop between panels and to/from Windows Explorer, the drag-move confirmation and temp-space warning, paste from clipboard, file lists to clipboard and to the command line, the Explorer upload shortcut, and the "add to search path" / desktop-icon integration options.

**範圍** — 面板之間同同 Windows Explorer 之間拖放、剪貼簿、Explorer 右鍵上載捷徑。`,
  },
];

function sh(args, opts = {}) {
  return cp.execFileSync('gh', args, { encoding: 'utf8', ...opts });
}

function existingTitles() {
  try {
    const out = sh(['issue', 'list', '--repo', REPO, '--state', 'all', '--limit', '200', '--json', 'title']);
    return new Set(JSON.parse(out).map((i) => i.title));
  } catch { return new Set(); }
}

function ensureLabel(name) {
  try {
    sh(['label', 'create', name, '--repo', REPO, '--color', 'B39DDB', '--description', 'Roadmap tracking'],
      { stdio: 'ignore' });
  } catch { /* already exists */ }
}

function main() {
  const dry = process.argv.includes('--dry');
  const have = existingTitles();
  const labels = new Set(ISSUES.flatMap((i) => i.labels || []));
  if (!dry) for (const l of labels) ensureLabel(l);

  let created = 0, skipped = 0;
  for (const issue of ISSUES) {
    if (have.has(issue.title)) {
      console.log('  = exists  ' + issue.title);
      skipped++;
      continue;
    }
    if (dry) { console.log('  + would create  ' + issue.title); created++; continue; }
    // --body-file avoids every shell-quoting hazard in the Markdown.
    const tmp = path.join(os.tmpdir(), 'issue-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.md');
    fs.writeFileSync(tmp, issue.body, 'utf8');
    try {
      const url = sh(['issue', 'create', '--repo', REPO, '--title', issue.title,
        '--body-file', tmp, ...(issue.labels || []).flatMap((l) => ['--label', l])]).trim();
      console.log('  + created ' + url);
      created++;
    } catch (e) {
      console.error('  ! failed  ' + issue.title + '\n    ' + (e.stderr || e.message).toString().trim());
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
  console.log(`\n${created} created, ${skipped} already present, ${ISSUES.length} total.`);
}

if (require.main === module) main();
module.exports = { ISSUES };
