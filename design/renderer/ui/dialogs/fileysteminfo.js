// ui/dialogs/fileysteminfo.js — "Server and protocol information"
// (FileSystemInfo.dfm).
//
// The important property of this window is not that it lists facts, it is WHERE
// the facts come from. `session:fsInfo` returns `capabilities: { ...adapter.caps }`
// — the very object design/main/protocols/base.js hands the rest of the
// application to decide whether a command is offered. This window renders that
// object directly.
//
// So "SFTP cannot set the owner" appears here for exactly the same reason the
// Owner command is greyed out over there: one object, read twice. The two
// cannot drift apart, which is the whole point — a capability list that is
// maintained separately from the capability check is worse than none, because
// it teaches users to trust a document that is quietly wrong.
//
// It informs and never decides, so it is a non-modal window rather than a
// modal, in line with the shell's rule.

import {
  h, icon, clear, uid, appearanceTarget, layer, focusMemory, copyText,
} from '../../dom.js';
import { session } from '../../state.js';
import { t, bindText } from '../../i18n.js';
import { notify } from '../notifications.js';
import { registerCommand } from '../../app.js';
import { createSearchBar, filterBy, noMatchMessage } from '../searchbar.js';
import { defineStrings, injectTransferStyles, bridge, formatBytes } from '../queue.js';

defineStrings({
  txFsiTitle: ['Server and protocol information', '伺服器同協定資訊'],
  txFsiTabProtocol: ['Protocol', '協定'],
  txFsiTabCaps: ['Capabilities', '功能'],
  txFsiTabSpace: ['Space available', '可用空間'],
  txFsiSearchPh: ['Search this information', '搵呢啲資訊'],
  txFsiScope: ['this page', '呢一頁'],
  txFsiCopyAll: ['Copy everything', '複製全部'],
  txFsiNoSession: ['No connected session is selected, so there is nothing to report.', '冇揀到連線中嘅工作階段，所以冇嘢好報。'],
  txFsiNoBridge: ['This window cannot reach the session manager, so the server cannot be asked.', '呢個視窗連唔到工作階段管理員，所以問唔到伺服器。'],
  txFsiSupported: ['Supported', '支援'],
  txFsiUnsupported: ['Not supported', '唔支援'],
  txFsiCapsExplain: [[
    'A command that needs an unsupported capability is greyed out instead of being offered and failing. This list is the same object the application checks.',
    'A command needing an unsupported capability is greyed out rather than offered and failed. This list IS the object the application checks.',
    'Anything needing a capability marked “not supported” is greyed out rather than offered and then failing on you. Same list the app itself reads.',
    'A command that needs a capability marked “not supported” is greyed out rather than offered and then failing halfway. This is not a separate document — it is the same object the application checks.',
    'Anything needing a “not supported” capability gets greyed out rather than dangled in front of you and then falling over halfway. And no, this is not a hand-written list that quietly rots — it is literally the same object the app itself consults.'], [
    '需要唔支援功能嘅指令會直接變灰，唔會俾你㩒完先失敗。呢張表就係程式自己查嗰個物件。',
    '需要唔支援功能嘅指令會變灰，唔會俾咗你之後又失敗。呢張表就係程式查嗰個物件。',
    '凡係需要「唔支援」功能嘅嘢都會變灰，唔會俾你撳完先仆街。同程式自己睇嗰張表一模一樣。',
    '需要「唔支援」功能嘅指令會變灰，唔會俾咗你揀然後做到一半仆街。呢個唔係另一份文件——係程式查緊嗰個同一個物件。',
    '凡係要用「唔支援」功能嘅嘢都會變灰，唔會吊住你玩然後做到一半仆街。而且呢張表唔係人手抄落嚟慢慢發霉嗰種——佢就係程式自己查緊嗰個物件本身。']],
  txFsiNoSpace: ['{0} does not report free space, so there is nothing to show here.', '{0} 唔會報可用空間，所以呢度冇嘢顯示。'],
  txFsiSpaceFailed: ['The server was asked for free space and refused: {0}', '問過伺服器可用空間，佢拒絕咗：{0}'],
  txFsiSpaceTotal: ['Total', '總共'],
  txFsiSpaceUsed: ['Used', '用咗'],
  txFsiSpaceFree: ['Free', '剩返'],
  txFsiSpacePath: ['Path', '路徑'],
  txFsiRemoteSystem: ['Remote system', '遠端系統'],
  txFsiSessionProtocol: ['Session protocol', '工作階段協定'],
  txFsiServerSoftware: ['Server software', '伺服器軟件'],
  txFsiServerVersion: ['Server version', '伺服器版本'],
  txFsiHome: ['Home directory', '主目錄'],
  txFsiHostKeyAlg: ['Host key algorithm', '主機密鑰演算法'],
  txFsiHostKeySha: ['Host key SHA-256', '主機密鑰 SHA-256'],
  txFsiHostKeyMd5: ['Host key MD5', '主機密鑰 MD5'],
  txFsiCertSha: ['Certificate SHA-256', '憑證 SHA-256'],
  txFsiCertSha1: ['Certificate SHA-1', '憑證 SHA-1'],
  txFsiAdditional: ['Additional information', '附加資訊'],
  txFsiRefresh: ['Ask the server again', '再問多次伺服器'],
  txFsiCopied: ['Server information copied.', '伺服器資訊複製咗。'],

  txCapRights: ['Change permissions', '改權限'],
  txCapOwner: ['Change owner and group', '改擁有者同群組'],
  txCapSymlink: ['Symbolic links', '符號連結'],
  txCapHardlink: ['Hard links', '硬連結'],
  txCapExec: ['Run a command on the server', '喺伺服器行指令'],
  txCapResume: ['Resume an interrupted transfer', '續傳中斷咗嘅傳輸'],
  txCapTimestamp: ['Preserve the modification time', '保留修改時間'],
  txCapRecycleBin: ['Recycle bin', '回收筒'],
  txCapChecksum: ['Calculate a checksum', '計檢查碼'],
  txCapFind: ['Search recursively', '遞迴搜尋'],
  txCapRename: ['Rename', '改名'],
  txCapMove: ['Move', '移動'],
  txCapCopyRemote: ['Duplicate a file on the server', '喺伺服器度複製檔案'],
  txCapCalculateSize: ['Calculate directory sizes', '計目錄大細'],
  txCapNativeMove: ['Move without re-uploading', '唔使重新上載就移到'],
  txCapHiddenFiles: ['List hidden files', '列出隱藏檔'],
  txCapSpaceInfo: ['Report free space', '報可用空間'],
});

/** The caps in the order they are worth reading, with their label keys. */
export const CAPABILITY_KEYS = [
  ['rights', 'txCapRights'],
  ['owner', 'txCapOwner'],
  ['timestamp', 'txCapTimestamp'],
  ['resume', 'txCapResume'],
  ['symlink', 'txCapSymlink'],
  ['hardlink', 'txCapHardlink'],
  ['rename', 'txCapRename'],
  ['move', 'txCapMove'],
  ['nativeMove', 'txCapNativeMove'],
  ['copyRemote', 'txCapCopyRemote'],
  ['exec', 'txCapExec'],
  ['checksum', 'txCapChecksum'],
  ['find', 'txCapFind'],
  ['calculateSize', 'txCapCalculateSize'],
  ['hiddenFiles', 'txCapHiddenFiles'],
  ['recycleBin', 'txCapRecycleBin'],
  ['spaceInfo', 'txCapSpaceInfo'],
];

/**
 * The capability rows for an fsInfo reply: [{ name, labelKey, supported }].
 * Any capability the adapter reports that this list does not name is appended
 * with its raw name, so a protocol that grows a new one is still shown rather
 * than silently omitted.
 */
export function capabilityRows(info) {
  const caps = (info && info.capabilities) || {};
  const named = new Set(CAPABILITY_KEYS.map(([k]) => k));
  const rows = CAPABILITY_KEYS.map(([name, labelKey]) => ({
    name, labelKey, supported: !!caps[name],
  }));
  for (const [name, value] of Object.entries(caps)) {
    if (named.has(name)) continue;
    rows.push({ name, labelKey: '', label: name, supported: !!value });
  }
  return rows;
}

/** The protocol facts as [{ labelKey|label, value }], skipping empty ones. */
export function protocolRows(info) {
  if (!info) return [];
  const rows = [
    { labelKey: 'srvProtocol', value: info.protocol || info.protocolBaseName || '' },
    { labelKey: 'txFsiRemoteSystem', value: info.remoteSystem || '' },
    { labelKey: 'txFsiSessionProtocol', value: info.sessionProtocol || '' },
    { labelKey: 'srvCipher', value: info.cryptographicProtocol || '' },
    { labelKey: 'srvCompression', value: info.compression || '' },
    { labelKey: 'txFsiServerSoftware', value: info.serverSoftware || '' },
    { labelKey: 'txFsiServerVersion', value: info.serverVersion || '' },
    { labelKey: 'txFsiHome', value: info.home || '' },
    { labelKey: 'txFsiHostKeyAlg', value: info.hostKey?.algorithm || info.hostKey?.keyType || '' },
    { labelKey: 'txFsiHostKeySha', value: info.hostKey?.fingerprintSHA256 || info.hostKey?.fingerprint || '' },
    { labelKey: 'txFsiHostKeyMd5', value: info.hostKey?.fingerprintMD5 || '' },
    { labelKey: 'txFsiCertSha', value: info.certificate?.fingerprintSHA256 || '' },
    { labelKey: 'txFsiCertSha1', value: info.certificate?.fingerprintSHA1 || '' },
  ].filter((r) => r.value);
  for (const [key, value] of Object.entries(info.additional || {})) {
    if (value === null || value === undefined || value === '') continue;
    rows.push({ label: key, value: typeof value === 'object' ? JSON.stringify(value) : String(value) });
  }
  return rows;
}

/** The space rows, or an honest explanation of why there are none. */
export function spaceRows(info) {
  const space = info?.space;
  if (!space) return [];
  const rows = [];
  if (space.path) rows.push({ labelKey: 'txFsiSpacePath', value: String(space.path) });
  const total = Number(space.total ?? space.bytesTotal);
  const free = Number(space.free ?? space.bytesAvailable ?? space.available);
  const used = Number.isFinite(total) && Number.isFinite(free) ? total - free : Number(space.used);
  if (Number.isFinite(total)) rows.push({ labelKey: 'txFsiSpaceTotal', value: formatBytes(total) });
  if (Number.isFinite(used)) rows.push({ labelKey: 'txFsiSpaceUsed', value: formatBytes(used) });
  if (Number.isFinite(free)) rows.push({ labelKey: 'txFsiSpaceFree', value: formatBytes(free) });
  for (const [key, value] of Object.entries(space)) {
    if (['path', 'total', 'bytesTotal', 'free', 'bytesAvailable', 'available', 'used'].includes(key)) continue;
    rows.push({ label: key, value: String(value) });
  }
  return rows;
}

/* ------------------------------------------------------------------ */
/* the capability cache other surfaces read                            */
/* ------------------------------------------------------------------ */

const capsCache = new Map();      // sessionId -> capabilities object

/**
 * The capability matrix for a session, or null when it has not been fetched.
 * A command surface greys itself out from this, and this window renders the
 * same object, so the two can never disagree.
 */
export function capabilitiesOf(sessionId) { return capsCache.get(sessionId) || null; }

function unwrapSync(res) {
  if (res == null) return null;
  if (typeof res === 'object' && 'ok' in res) {
    if (res.ok) return res.value;
    throw new Error((res.error && res.error.message) || 'The session manager refused the call.');
  }
  return res;
}

/** Fetch (and cache) the file system information for a session. */
export async function fetchFileSystemInfo(sessionId, path) {
  const b = bridge();
  if (!b?.session?.fsInfo) throw new Error(t('txFsiNoBridge'));
  const info = unwrapSync(await b.session.fsInfo(sessionId, path));
  if (info?.capabilities) capsCache.set(sessionId, info.capabilities);
  return info;
}

/** The first connected session, so the command works without an explicit id. */
async function resolveSessionId(preferred) {
  if (preferred) return preferred;
  const known = session.get('activeSessionId');
  if (known) return known;
  const b = bridge();
  if (!b?.session?.list) return null;
  try {
    const list = unwrapSync(await b.session.list()) || [];
    const connected = list.find((s) => s.state === 'connected' || s.connected) || list[0];
    return connected ? connected.id : null;
  } catch { return null; }
}

/* ------------------------------------------------------------------ */
/* the window                                                          */
/* ------------------------------------------------------------------ */

let infoWindow = null;

export function openFileSystemInfoDialog(props = {}) {
  injectTransferStyles();
  injectFsiStyles();
  if (infoWindow) { infoWindow.focus(); return infoWindow; }

  const restore = focusMemory();
  const titleId = uid('tx-fsi-title');
  // ONE panel id, referenced by all three tabs. Minting an id per tab and
  // applying only the active one leaves two tabs pointing at nothing, which is
  // a dangling aria-controls to every screen reader.
  const panelId = uid('tx-fsi-panel');
  const bodyEl = h('div', {
    class: 'tx-pg', id: panelId, role: 'tabpanel', tabindex: '0',
    'aria-labelledby': `${panelId}-protocol`,
  });
  const tabsEl = h('div', { class: 'tx-fsi-tabs', role: 'tablist', 'aria-label': t('txFsiTitle') });
  let active = 'protocol';
  let info = null;
  let error = '';
  let sessionId = props.sessionId || null;

  const search = createSearchBar({
    id: 'filesystem-info',
    labelKey: 'txFsiSearchPh',
    placeholderKey: 'txFsiSearchPh',
    compact: true,
    persist: false,
    appearanceKey: 'search-filesystem-info',
    appearanceLabel: 'Server information search',
    sampleProvider: () => plainText(),
    onChange: render,
  });

  const closeBtn = h('button', { type: 'button', class: 'icon-btn', onclick: () => close() }, icon('close', 18));
  bindText(closeBtn, 'close', { attr: 'aria-label' });
  bindText(closeBtn, 'close', { attr: 'title' });

  const refreshBtn = h('button', { type: 'button', class: 'icon-btn', onclick: () => load() }, icon('refresh', 18));
  bindText(refreshBtn, 'txFsiRefresh', { attr: 'aria-label' });
  bindText(refreshBtn, 'txFsiRefresh', { attr: 'title' });

  const copyBtn = h('button', {
    type: 'button', class: 'btn-text',
    onclick: () => copyText(plainText()).then((ok) => ok && notify.success(t('txFsiCopied'), '')),
  }, icon('content_copy', 15), h('span', {}, t('txFsiCopyAll')));

  const root = h('div', {
    class: 'tx-pg-window surface-3', role: 'dialog', 'aria-modal': 'false',
    'aria-labelledby': titleId, tabindex: '-1',
  },
  h('header', { class: 'nc-head' },
    icon('dns', 18),
    h('span', { class: 'nc-head-title', id: titleId }, t('txFsiTitle')),
    refreshBtn, closeBtn),
  h('div', { class: 'tx-fsi-head' }, tabsEl, h('div', { class: 'tx-q-searchwrap' }, search.element)),
  bodyEl,
  h('div', { class: 'tx-q-toolbar' }, copyBtn));
  appearanceTarget(root, 'filesystem-info-window', 'Server information window');

  layer('popover').appendChild(root);
  root.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });

  function tabButton(id, labelKey) {
    const selected = active === id;
    const btn = h('button', {
      // One tab stop for the strip (roving focus below), the panel wired up,
      // and the selected state where a screen reader reads it.
      type: 'button', class: 'tx-fsi-tab', role: 'tab', id: `${panelId}-${id}`,
      'aria-selected': String(selected), 'aria-controls': panelId,
      tabindex: selected ? '0' : '-1',
      onclick: () => activate(id),
    }, t(labelKey));
    appearanceTarget(btn, `fsi-tab-${id}`, `Server information tab: ${id}`);
    return btn;
  }

  /**
   * Activating a tab rebuilds the strip, so focus has to be put back
   * deliberately — otherwise a keyboard user lands on the document body the
   * moment they change tab and cannot reach the next one.
   */
  function activate(id) {
    active = id;
    render();
    bodyEl.setAttribute('aria-labelledby', `${panelId}-${id}`);
    const btn = tabsEl.querySelector(`#${CSS.escape(`${panelId}-${id}`)}`);
    if (btn) btn.focus({ preventScroll: true });
  }

  const TAB_ORDER = ['protocol', 'caps', 'space'];
  tabsEl.addEventListener('keydown', (e) => {
    const delta = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (delta) {
      e.preventDefault();
      const next = TAB_ORDER[(TAB_ORDER.indexOf(active) + delta + TAB_ORDER.length) % TAB_ORDER.length];
      activate(next);
    } else if (e.key === 'Home') { e.preventDefault(); activate(TAB_ORDER[0]); }
    else if (e.key === 'End') { e.preventDefault(); activate(TAB_ORDER[TAB_ORDER.length - 1]); }
  });

  function currentRows() {
    if (active === 'caps') {
      return capabilityRows(info).map((r) => ({
        label: r.labelKey ? t(r.labelKey) : r.label,
        value: r.supported ? t('txFsiSupported') : t('txFsiUnsupported'),
        supported: r.supported,
        name: r.name,
      }));
    }
    const rows = active === 'space' ? spaceRows(info) : protocolRows(info);
    return rows.map((r) => ({ label: r.labelKey ? t(r.labelKey) : r.label, value: r.value }));
  }

  function plainText() {
    const sections = [
      [t('txFsiTabProtocol'), protocolRows(info).map((r) => [r.labelKey ? t(r.labelKey) : r.label, r.value])],
      [t('txFsiTabCaps'), capabilityRows(info).map((r) => [r.labelKey ? t(r.labelKey) : r.label, r.supported ? t('txFsiSupported') : t('txFsiUnsupported')])],
      [t('txFsiTabSpace'), spaceRows(info).map((r) => [r.labelKey ? t(r.labelKey) : r.label, r.value])],
    ];
    return sections
      .map(([title, rows]) => `${title}\n${rows.map(([k, v]) => `  ${k}: ${v}`).join('\n')}`)
      .join('\n\n');
  }

  function render() {
    clear(tabsEl);
    tabsEl.append(
      tabButton('protocol', 'txFsiTabProtocol'),
      tabButton('caps', 'txFsiTabCaps'),
      tabButton('space', 'txFsiTabSpace'));

    clear(bodyEl);
    if (error) { bodyEl.appendChild(h('p', { class: 'tx-sy-refuse' }, error)); return; }
    if (!info) { bodyEl.appendChild(h('p', { class: 'muted' }, t('authenticating'))); return; }

    const rows = search.isActive
      ? filterBy(currentRows(), search.predicate, (r) => [r.label, String(r.value)])
      : currentRows();

    if (active === 'caps') {
      bodyEl.appendChild(h('p', { class: 'tx-sy-note' }, t('txFsiCapsExplain')));
      if (!rows.length) { bodyEl.appendChild(h('p', { class: 'muted' }, noMatchMessage(search.predicate, t('txFsiScope')))); return; }
      const grid = h('div', { class: 'tx-fsi-caps' });
      for (const r of rows) {
        grid.appendChild(h('div', { class: `tx-fsi-cap ${r.supported ? 'is-on' : 'is-off'}` },
          icon(r.supported ? 'check_circle' : 'close', 15),
          h('span', { class: 'tx-fsi-cap-name' }, r.label),
          h('span', { class: 'mono', style: { fontSize: 'var(--type-label-sm)' } }, r.name)));
      }
      bodyEl.appendChild(grid);
      return;
    }

    if (active === 'space' && !spaceRows(info).length) {
      const caps = info.capabilities || {};
      bodyEl.appendChild(h('p', { class: 'tx-sy-note' }, info.spaceError
        ? t('txFsiSpaceFailed', info.spaceError)
        : t('txFsiNoSpace', info.protocol || info.protocolBaseName || '—')));
      if (!caps.spaceInfo) bodyEl.appendChild(h('p', { class: 'muted' }, `${t('txCapSpaceInfo')}: ${t('txFsiUnsupported')}`));
      return;
    }

    if (!rows.length) { bodyEl.appendChild(h('p', { class: 'muted' }, noMatchMessage(search.predicate, t('txFsiScope')))); return; }
    const table = h('div', { class: 'tx-fsi-table' });
    for (const r of rows) {
      table.append(h('span', {}, r.label), h('span', { class: 'mono' }, String(r.value)));
    }
    bodyEl.appendChild(table);
  }

  async function load() {
    error = '';
    info = null;
    render();
    try {
      sessionId = await resolveSessionId(sessionId);
      if (!sessionId) { error = t('txFsiNoSession'); render(); return; }
      info = await fetchFileSystemInfo(sessionId, props.path);
    } catch (err) {
      error = err.message;
    }
    render();
  }

  function close() {
    search.destroy();
    root.remove();
    infoWindow = null;
    restore();
  }

  infoWindow = { element: root, close, focus: () => root.focus(), reload: load };
  load();
  requestAnimationFrame(() => root.focus());
  return infoWindow;
}

registerCommand({
  id: 'session.fileSystemInfo',
  labelKey: 'serverInfo',
  icon: 'dns',
  run: (props) => openFileSystemInfoDialog(props || {}),
});

const FSI_CSS = `
.tx-fsi-head { display: flex; align-items: center; gap: calc(8px * var(--den)); padding: calc(8px * var(--den)) calc(14px * var(--den)) 0; flex-wrap: wrap; }
.tx-fsi-head .tx-fsi-tabs { flex: 1 1 auto; border-bottom: none; }
`;

let injected = false;
function injectFsiStyles() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const el = document.createElement('style');
  el.id = 'sheet-transfer-fsinfo';
  el.textContent = FSI_CSS;
  document.head.appendChild(el);
}
