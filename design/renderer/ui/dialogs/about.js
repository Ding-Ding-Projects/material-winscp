// ui/dialogs/about.js — the About dialog (About.dfm).
//
// About.dfm's controls, one for one: the application name, the version label,
// the copyright line, the "report bugs at" line with its links, the
// "Portions copyright:" third-party panel, the homepage and forum links, and
// the OK / License… / Help buttons.
//
// Two things the original does not have and this build must:
//
//   * THE RELEASE CODE NAME with its bundled photo. The name comes from
//     winscp-data.js (one dish per release, used once) and the picture from
//     main's dim sum catalog as a data: URI, so it never touches the network.
//     If the catalog has no image for that dish the name is shown WITHOUT a
//     photo — a broken image beside a code name is worse than no image.
//   * A ROUTE TO THE CHANGELOG, because "reachable from Help/About" is where
//     the changelog viewer is required to be.
//
// Every version here is either reported by the process at runtime or is a
// constant this build was compiled with. Nothing is guessed: the npm engines
// have no runtime version to report, so they are named with their role and the
// file that pins them, rather than being given a number that could drift.
//
// About.dfm also carries a registration box (licensee, licence count, product
// id). WinSCP shows it only for a registered build; this build has no
// registration of any kind, so the section is genuinely absent rather than
// rendered empty.

import {
  h, icon, clear, appearanceTarget, copyText, oneLine,
} from '../../dom.js';
import { t, bindRender, getLanguage, getFunnyLevel, languageSummary } from '../../i18n.js';
import { resolveI18n } from '../../../winscp-i18n.js';
import { api, store, LAUNCH_ID } from '../../state.js';
import { styleSheet } from '../../theme.js';
import { notify } from '../notifications.js';
import { registerContextMenu, SEPARATOR } from '../contextmenu.js';
import { VERSION, CODENAME } from '../../../winscp-data.js';
import { openLicense, LICENSE_ID } from './license.js';
import { openChangelog } from '../changelog.js';
import { openHistoryPanel } from '../historypanel.js';
import { appMark } from '../appmark.js';
import { registerDialog, openDialog } from '../../app.js';

/* ------------------------------------------------------------------ */
/* module-local strings                                                */
/* ------------------------------------------------------------------ */

const STR = {
  abVersion: ['Version {0}', '版本 {0}'],
  abCopyright: [
    'Copyright © 2026 Ding-Ding-Projects and contributors. Original WinSCP © Martin Přikryl.',
    '版權所有 © 2026 Ding-Ding-Projects 同各位貢獻者。原版 WinSCP © Martin Přikryl。'],
  abReport: ['To report a problem or send comments, open an issue:', '想報 bug 或者講兩句，可以開個 issue：'],
  abRepo: ['Project repository', '專案 repository'],
  abIssues: ['Report a problem', '報告問題'],
  abUpstream: ['WinSCP — the original', 'WinSCP——原版'],
  abPortions: ['Portions copyright', '部分版權'],
  abRuntime: ['Runtime', '執行環境'],
  abPackaged: ['Packaged as', '打包版本'],
  abEngines: ['Engines', '引擎'],
  abEngineNote: [
    'Exact versions of the npm packages are resolved at install time and recorded in package-lock.json; the process does not report them, so they are not printed here as if it did.',
    'npm 套件嘅確實版本係安裝嗰陣先鎖定，記喺 package-lock.json 度；行緊嗰個程序報唔到出嚟，所以呢度唔會扮到報到。'],
  abSsh2: ['SSH transport, SFTP and SCP', 'SSH 傳輸、SFTP 同 SCP'],
  abFtp: ['FTP and FTPS', 'FTP 同 FTPS'],
  abGit: ['The git-backed version history', 'Git 版本歷史'],
  abPaths: ['Where this build keeps things', '呢個 build 啲嘢擺喺邊'],
  abPathConfig: ['Configuration', '設定'],
  abPathLogs: ['Logs', '記錄'],
  abPathTemp: ['Temporary files', '暫存檔'],
  abPathHistory: ['Version history', '版本歷史'],
  abPathThemes: ['Themes', '主題'],
  abChangelog: ['Changelog…', '更新記錄…'],
  abHistory: ['Version history…', '版本歷史…'],
  abLicenseBtn: ['License…', '授權條款…'],
  abCopyDetails: ['Copy these details', '複製呢啲資料'],
  abCopied: ['The build details were copied.', '版本資料複製咗。'],
  abCopyFailed: ['The clipboard refused the copy. Nothing was changed.', '剪貼簿唔肯收，冇嘢改動咗。'],
  abLinkFailed: ['{0} could not be opened.', '開唔到 {0}。'],
  abCodeNoPhoto: [
    'This release’s code name has no bundled photo in the catalog yet, so the name is shown on its own.',
    '呢個版本嘅代號喺目錄度仲未有相，所以淨係顯示個名。'],
  abUnknown: ['not reported', '報唔到'],
  abLaunch: ['This launch', '今次開機'],
};

function s(key, ...params) {
  const raw = resolveI18n(STR[key], getLanguage(), getFunnyLevel('en'), getFunnyLevel('yue'));
  const out = raw == null ? key : raw;
  return params.length
    ? String(out).replace(/\{(\d+)\}/g, (m, i) => (params[Number(i)] === undefined ? m : String(params[Number(i)])))
    : out;
}

/**
 * Links About offers. Only URLs this repository actually documents appear
 * here; About.dfm's `winscp.net/forum/` has no counterpart for this project,
 * so the issues page takes that role under its own honest label rather than
 * a forum address being invented for it.
 */
export const ABOUT_LINKS = [
  { key: 'abRepo', url: 'https://github.com/Ding-Ding-Projects/material-winscp', icon: 'open_in_new' },
  { key: 'abIssues', url: 'https://github.com/Ding-Ding-Projects/material-winscp/issues', icon: 'error' },
  { key: 'abUpstream', url: 'https://winscp.net/', icon: 'open_in_new' },
];

/** The engines this port uses in place of WinSCP's vendored ones. */
export const COMPONENTS = [
  { name: 'ssh2', roleKey: 'abSsh2' },
  { name: 'basic-ftp', roleKey: 'abFtp' },
  { name: 'isomorphic-git', roleKey: 'abGit' },
];

/* ------------------------------------------------------------------ */
/* the main-process bridge                                             */
/* ------------------------------------------------------------------ */

async function callMain(path, ...args) {
  const raw = api.raw;
  if (!raw) return null;
  let owner = null;
  let fn = raw;
  for (const seg of path.split('.')) { owner = fn; fn = fn == null ? undefined : fn[seg]; }
  if (typeof fn !== 'function') return null;
  const res = await fn.apply(owner, args);
  if (res && typeof res === 'object' && 'ok' in res) {
    if (res.ok) return res.value;
    throw new Error((res.error && res.error.message) || 'The call failed.');
  }
  return res;
}

/* ------------------------------------------------------------------ */
/* styles                                                              */
/* ------------------------------------------------------------------ */

let stylesWritten = false;
function ensureStyles() {
  if (stylesWritten || typeof document === 'undefined') return;
  stylesWritten = true;
  styleSheet('about').set(`
.ab { display: flex; flex-direction: column; gap: calc(12px * var(--den)); }
.ab-head { display: flex; align-items: center; gap: calc(14px * var(--den)); }
.ab-logo { width: calc(52px * var(--uiscale)); height: calc(52px * var(--uiscale));
  border-radius: var(--shape-lg); object-fit: contain; display: block; flex: none; }
.ab-name { font-size: var(--type-title-lg); font-weight: 700; }
.ab-ver { font-size: var(--type-label-lg); color: var(--onsv); font-variant-numeric: tabular-nums; }
.ab-code { display: flex; align-items: center; gap: calc(12px * var(--den));
  background: var(--c-low); border-radius: var(--shape-md); padding: calc(10px * var(--den)); }
.ab-code img { width: calc(64px * var(--uiscale)); height: calc(64px * var(--uiscale));
  border-radius: var(--shape-md); object-fit: cover; flex: none; }
.ab-code-label { font-size: var(--type-label-sm); font-weight: 700; letter-spacing: .04em;
  text-transform: uppercase; color: var(--onsv); }
.ab-code-name { font-size: var(--type-title-md); font-weight: 600; }
.ab-section-title { font-size: var(--type-label-sm); font-weight: 700; letter-spacing: .04em;
  text-transform: uppercase; color: var(--onsv); margin-bottom: calc(4px * var(--den)); }
.ab-grid { display: grid; grid-template-columns: minmax(10ch, auto) 1fr;
  gap: calc(3px * var(--den)) calc(12px * var(--den)); font-size: var(--type-label-md); }
.ab-grid > span:nth-child(odd) { color: var(--onsv); }
.ab-grid > span:nth-child(even) { overflow-wrap: anywhere; }
.ab-links { display: flex; flex-direction: column; gap: calc(4px * var(--den)); }
.ab-link { display: inline-flex; align-items: center; gap: 6px; color: var(--p);
  font-size: var(--type-label-md); font-weight: 600; text-align: left;
  min-height: calc(30px * var(--den)); border-radius: var(--shape-sm);
  padding: 0 calc(6px * var(--den)); overflow-wrap: anywhere; }
.ab-link:hover { background: color-mix(in srgb, var(--p) 10%, transparent); }
.ab-note { font-size: var(--type-label-sm); color: var(--onsv); line-height: 1.5; }
.ab-actions { display: flex; align-items: center; gap: calc(6px * var(--den)); flex-wrap: wrap; }
`);
}

/* ------------------------------------------------------------------ */
/* the dialog body                                                     */
/* ------------------------------------------------------------------ */

/** createAboutBody() -> { element, destroy() } */
export function createAboutBody() {
  ensureStyles();

  let info = null;
  const runtimeGrid = h('div', { class: 'ab-grid mono' });
  const pathsGrid = h('div', { class: 'ab-grid mono' });
  const codeWrap = h('div', { class: 'ab-code' });
  const verEl = h('div', { class: 'ab-ver mono' }, s('abVersion', VERSION));

  function link(spec) {
    const btn = h('button', {
      type: 'button', class: 'ab-link', title: spec.url,
      onclick: async () => {
        const ok = await api.openExternal(spec.url);
        // openExternal resolves false when main refused the scheme or there is
        // no bridge; the URL is put on the clipboard so the user can still get
        // there rather than being left with a button that did nothing.
        if (ok === false) {
          const copied = await copyText(spec.url);
          notify.warning(t('aboutMenu'), `${s('abLinkFailed', spec.url)}${copied ? ' ' + t('copiedClip') : ''}`);
        }
      },
    }, icon(spec.icon, 15), h('span', {}, `${s(spec.key)} — ${spec.url}`));
    return btn;
  }

  function paintRuntime() {
    clear(runtimeGrid);
    const unknown = s('abUnknown');
    const rows = [
      // The product version above is the constant this build was compiled
      // with; this is what the packaging layer reports, which is a different
      // number and belongs in a bug report too.
      [s('abPackaged'), (info && info.version) || unknown],
      ['Electron', (info && info.electron) || unknown],
      ['Chromium', (info && info.chrome) || unknown],
      ['Node.js', (info && info.node) || unknown],
      ['Platform', info ? `${info.platform} ${info.arch}` : unknown],
      ['Locale', (info && info.locale) || unknown],
      [t('langMode'), languageSummary()],
      [s('abLaunch'), LAUNCH_ID],
    ];
    for (const [k, v] of rows) {
      runtimeGrid.appendChild(h('span', {}, k));
      runtimeGrid.appendChild(h('span', {}, String(v)));
    }
  }

  function paintPaths() {
    clear(pathsGrid);
    const paths = (info && info.paths) || null;
    if (!paths) { pathsGrid.appendChild(h('span', {}, s('abUnknown'))); pathsGrid.appendChild(h('span', {}, '—')); return; }
    const rows = [
      [s('abPathConfig'), paths.root],
      [s('abPathLogs'), paths.logs],
      [s('abPathTemp'), paths.temp],
      [s('abPathHistory'), paths.history],
      [s('abPathThemes'), paths.themes],
    ];
    for (const [k, v] of rows) {
      pathsGrid.appendChild(h('span', {}, k));
      pathsGrid.appendChild(h('span', { title: String(v) }, oneLine(String(v), 70)));
    }
  }

  function paintCodeName(dataUri) {
    clear(codeWrap);
    const nameText = CODENAME.zh ? `${CODENAME.en} · ${CODENAME.zh}` : CODENAME.en;
    if (dataUri) {
      const img = h('img', {
        src: dataUri, width: 64, height: 64,
        alt: CODENAME.zh ? `${CODENAME.en} (${CODENAME.zh})` : CODENAME.en,
      });
      img.addEventListener('error', () => img.remove());
      codeWrap.appendChild(img);
    }
    codeWrap.appendChild(h('div', {},
      h('div', { class: 'ab-code-label' }, t('aboutCodename')),
      h('div', { class: 'ab-code-name' }, nameText),
      dataUri ? null : h('div', { class: 'ab-note' }, s('abCodeNoPhoto'))));
  }

  const componentsList = h('div', { class: 'ab-grid' });
  for (const c of COMPONENTS) {
    componentsList.appendChild(h('span', { class: 'mono' }, c.name));
    componentsList.appendChild(h('span', {}, s(c.roleKey)));
  }

  const root = h('div', { class: 'ab' },
    h('div', { class: 'ab-head' },
      appMark('ab-logo'),
      h('div', {},
        h('div', { class: 'ab-name' }, t('appName')),
        verEl,
        h('div', { class: 'ab-note mono' }, LICENSE_ID))),
    codeWrap,
    h('p', { class: 'prose' }, t('aboutBody')),
    h('div', {},
      h('div', { class: 'ab-section-title' }, s('abReport')),
      h('div', { class: 'ab-links' }, ...ABOUT_LINKS.map(link))),
    h('div', {},
      h('div', { class: 'ab-section-title' }, s('abRuntime')),
      runtimeGrid),
    h('div', {},
      h('div', { class: 'ab-section-title' }, `${s('abPortions')} — ${s('abEngines')}`),
      componentsList,
      h('div', { class: 'ab-note' }, s('abEngineNote'))),
    h('div', {},
      h('div', { class: 'ab-section-title' }, s('abPaths')),
      pathsGrid),
    h('p', { class: 'ab-note' }, t('aboutMemory')),
    h('p', { class: 'ab-note' }, s('abCopyright')));
  appearanceTarget(root, 'about-dialog', 'About dialog');
  appearanceTarget(codeWrap, 'about-codename', 'Release code name');

  function detailsText() {
    const rows = [
      `${t('appName')} ${VERSION}`,
      `${t('aboutCodename')}: ${CODENAME.en} · ${CODENAME.zh}`,
      `${s('abPackaged')}: ${(info && info.version) || 'n/a'}`,
      `License: ${LICENSE_ID}`,
      `Electron: ${(info && info.electron) || 'n/a'}`,
      `Chromium: ${(info && info.chrome) || 'n/a'}`,
      `Node.js: ${(info && info.node) || 'n/a'}`,
      `Platform: ${info ? `${info.platform} ${info.arch}` : 'n/a'}`,
      `Theme: ${store.get('theme.mode')} · seed ${store.get('theme.seed')}`,
      `Language: ${languageSummary()}`,
      `Launch: ${LAUNCH_ID}`,
    ];
    return rows.join('\n');
  }

  registerContextMenu(root, () => [
    { label: s('abCopyDetails'), icon: 'content_copy', onSelect: () => copyDetails() },
    SEPARATOR,
    { label: s('abChangelog'), icon: 'receipt_long', onSelect: () => openChangelog() },
    { label: s('abLicenseBtn'), icon: 'description', onSelect: () => openLicense() },
  ]);

  async function copyDetails() {
    const ok = await copyText(detailsText());
    if (ok) notify.success(t('aboutMenu'), s('abCopied'));
    else notify.error(t('aboutMenu'), s('abCopyFailed'));
  }

  paintRuntime();
  paintPaths();
  paintCodeName(null);

  // Both of these are asynchronous and neither may hold the dialog open: it
  // renders with what it already knows and fills in when main answers.
  // The headline version stays the product version this build was compiled
  // with — the same string the title bar and the status bar show. Main's
  // packaged version is a different number and gets its own row rather than
  // overwriting this one, which is how a dev run ended up announcing itself as
  // "Version 33.4.11" (Electron's) in the first place.
  api.appInfo().then((got) => {
    info = got;
    paintRuntime();
    paintPaths();
  }).catch(() => { /* the constants above are already on screen */ });

  callMain('app.codeName', []).then((cn) => {
    // Only ever the picture that belongs to THIS release's dish: main hands out
    // the next unused code name, which may be a different dish entirely.
    const wantFile = String(CODENAME.img || '').split('/').pop();
    if (cn && cn.dataUri && cn.file === wantFile) paintCodeName(cn.dataUri);
  }).catch(() => { /* no catalog image: the name stands on its own */ });

  const unbind = bindRender(root, () => { paintRuntime(); paintPaths(); });

  return {
    element: root,
    copyDetails,
    get details() { return detailsText(); },
    destroy() { unbind(); root.remove(); },
  };
}

/* ------------------------------------------------------------------ */
/* registration                                                        */
/* ------------------------------------------------------------------ */

let installed = false;

/**
 * Registers the `about` dialog. app.js keeps a single `app.about` command that
 * delegates to this dialog the moment it is registered, so F1 and the title-bar
 * menu reach the full About.dfm surface without two modules claiming the same
 * command id — a second registration would silently win by load order.
 */
export function registerAboutDialog() {
  if (installed) return;
  installed = true;
  ensureStyles();

  registerDialog('about', () => {
    const body = createAboutBody();
    return {
      title: t('aboutMenu'),
      width: 620,
      content: body.element,
      onClose: () => body.destroy(),
      actions: [
        { label: s('abCopyDetails'), kind: 'text', onSelect: () => { body.copyDetails(); return true; } },
        { label: s('abChangelog'), kind: 'text', onSelect: () => { openChangelog(); return true; } },
        { label: s('abHistory'), kind: 'text', onSelect: () => { openHistoryPanel(); return true; } },
        { label: s('abLicenseBtn'), kind: 'text', onSelect: () => { openLicense(); return true; } },
        { label: t('ok'), kind: 'filled', autofocus: true },
      ],
    };
  });
}

export function openAbout() {
  registerAboutDialog();
  return openDialog('about');
}

if (typeof document !== 'undefined') {
  queueMicrotask(() => {
    try { registerAboutDialog(); } catch (err) { console.error('[about] registration failed', err); }
  });
}
