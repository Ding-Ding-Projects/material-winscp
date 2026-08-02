// ui/statusbar.js — the session status bar and the per-panel file status bars.
//
// WinSCP has two kinds of status bar and this file has both:
//
//   * the session bar (TCustomScpExplorerForm::UpdateStatusBar): a note panel,
//     the protocol name, a security indicator and the session duration.
//   * the file bar under each panel (UpdateFileStatusBar): "<selected size> of
//     <total size> in <selected count> of <total count>", plus a hidden-files
//     panel and a filtered-files panel that only appear when they are non-zero.
//     Clicking the hidden panel toggles hidden files and clicking the filtered
//     panel opens the filter — the same click targets the original has.
//
// While an incremental search is running the file bar shows the search state
// instead of the counts, exactly as FormatIncrementalSearchStatus does.

import { h, icon, appearanceTarget, oneLine } from '../dom.js';
import { t } from '../i18n.js';
import { bus } from '../state.js';
import { registerContextMenu, SEPARATOR } from './contextmenu.js';
import {
  backend, runAction, actionLabel, commandState, formatBytes, readPref, ensureStyle,
} from './commands.js';

const CSS = `
.fpstatus{display:flex;align-items:center;gap:calc(8px*var(--den,1));min-height:calc(24px*var(--den,1));
  padding:0 calc(8px*var(--den,1));font-size:var(--type-label-sm,.75rem);
  color:var(--md-sys-color-on-surface-variant,var(--onsfcv,#49454F));
  border-top:1px solid var(--md-sys-color-outline-variant,var(--outv,rgba(0,0,0,.12)));
  background:var(--md-sys-color-surface-container-low,transparent);overflow:hidden}
.fpstatus[hidden]{display:none}
.fpstatus-main{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fpstatus-chip{display:inline-flex;align-items:center;gap:calc(4px*var(--den,1));border:0;background:transparent;
  cursor:pointer;color:inherit;font:inherit;border-radius:var(--shape-xs,4px);padding:0 calc(4px*var(--den,1));
  min-height:calc(20px*var(--den,1));white-space:nowrap}
.fpstatus-chip:hover{background:var(--md-sys-color-surface-container-high,rgba(0,0,0,.06))}
.fpstatus-chip[hidden]{display:none}
.fpstatus.is-searching .fpstatus-main{color:var(--md-sys-color-primary,var(--pri,#0B57D0));font-weight:600}
.fpstatus.is-searching.is-nomatch .fpstatus-main{color:var(--md-sys-color-error,var(--err,#B3261E))}
`;

/* ================================================================== */
/* the per-panel file status bar                                       */
/* ================================================================== */

/**
 * createPanelStatusBar(panel) -> { element, sync(), destroy() }
 *
 * `panel` must expose counts() -> { files, size, selected, selectedSize,
 * hidden, filtered } and incrementalSearch() -> { active, text, matched }.
 */
export function createPanelStatusBar(panel) {
  ensureStyle('winscp-statusbar', CSS);
  const side = panel.side;

  const main = h('span', { class: 'fpstatus-main' });
  const hiddenChip = h('button', {
    type: 'button', class: 'fpstatus-chip', hidden: true,
    onclick: () => runAction('ShowHiddenFilesAction', { side, panel }),
  }, icon('visibility', 13), h('span', {}));
  const filteredChip = h('button', {
    type: 'button', class: 'fpstatus-chip', hidden: true,
    onclick: () => runAction(side === 'local' ? 'LocalFilterAction' : 'RemoteFilterAction', { side, panel }),
  }, icon('filter', 13), h('span', {}));
  const spaceChip = h('button', {
    type: 'button', class: 'fpstatus-chip', hidden: true,
    onclick: () => runAction('FileSystemInfoAction', { side, panel }),
  }, icon('database', 13), h('span', {}));

  const root = h('div', {
    class: 'fpstatus', role: 'status',
    'aria-label': `${side === 'local' ? t('localPanel') : t('remotePanel')} ${t('statusBarMenu')}`,
  }, main, hiddenChip, filteredChip, spaceChip);
  appearanceTarget(root, `panel-status-${side}`, `${side === 'local' ? 'Local' : 'Remote'} panel status bar`);

  registerContextMenu(root, () => {
    const over = { side, panel };
    const toggle = side === 'local' ? 'LocalStatusBarAction2' : 'RemoteStatusBarAction2';
    return [
      { label: actionLabel('ShowHiddenFilesAction'), checked: commandState('ShowHiddenFilesAction', over).checked, onSelect: () => runAction('ShowHiddenFilesAction', over) },
      { label: actionLabel(side === 'local' ? 'LocalFilterAction' : 'RemoteFilterAction'), onSelect: () => runAction(side === 'local' ? 'LocalFilterAction' : 'RemoteFilterAction', over) },
      SEPARATOR,
      { label: actionLabel('FormatSizeBytesNoneAction'), radio: true, checked: commandState('FormatSizeBytesNoneAction').checked, onSelect: () => runAction('FormatSizeBytesNoneAction') },
      { label: actionLabel('FormatSizeBytesKilobytesAction'), radio: true, checked: commandState('FormatSizeBytesKilobytesAction').checked, onSelect: () => runAction('FormatSizeBytesKilobytesAction') },
      { label: actionLabel('FormatSizeBytesShortAction'), radio: true, checked: commandState('FormatSizeBytesShortAction').checked, onSelect: () => runAction('FormatSizeBytesShortAction') },
      SEPARATOR,
      { label: actionLabel(toggle), checked: true, onSelect: () => runAction(toggle, over) },
    ];
  });

  let space = null;

  function sync() {
    const visible = readPref(
      side === 'local' ? 'scpCommander.localPanel.statusBar' : 'scpCommander.remotePanel.statusBar', true,
    ) !== false;
    root.hidden = !visible;
    if (!visible) return;

    const search = panel.incrementalSearch ? panel.incrementalSearch() : null;
    if (search && search.active) {
      root.classList.add('is-searching');
      root.classList.toggle('is-nomatch', !search.matched);
      // WinSCP shows the typed text and says plainly when nothing matches, so a
      // user never wonders whether the keystroke registered.
      main.textContent = search.matched
        ? `${t('search')}: ${search.text}`
        : `${t('search')}: ${search.text} — ${t('noMatches')}`;
      hiddenChip.hidden = true;
      filteredChip.hidden = true;
      return;
    }
    root.classList.remove('is-searching', 'is-nomatch');

    const c = panel.counts();
    // FILE_INFO_FORMAT: "<selected size> of <total size> in <selected> of <total>"
    main.textContent = `${formatBytes(c.selectedSize)} of ${formatBytes(c.size)} in ${c.selected.toLocaleString()} of ${c.files.toLocaleString()}`;
    main.title = main.textContent;

    hiddenChip.hidden = !c.hidden;
    if (c.hidden) {
      hiddenChip.querySelector('span').textContent = t('hiddenCount', String(c.hidden));
      hiddenChip.title = `${t('hiddenCount', String(c.hidden))} — ${actionLabel('ShowHiddenFilesAction')}`;
    }
    filteredChip.hidden = !c.filtered;
    if (c.filtered) {
      filteredChip.querySelector('span').textContent = `${t('filterActive')} (${c.filtered})`;
      filteredChip.title = `${t('filterActive')} — ${panel.filter() || ''}`;
    }
    spaceChip.hidden = !space;
    if (space) {
      spaceChip.querySelector('span').textContent = space;
      spaceChip.title = `${t('srvSpace')}: ${space}`;
    }
  }

  /** Free-space, when the protocol reports it. Refreshed on navigation. */
  async function refreshSpace() {
    space = null;
    const info = panel.sessionInfo ? panel.sessionInfo() : null;
    if (!info || !info.connected || !info.caps || !info.caps.spaceInfo) { sync(); return; }
    try {
      const s = await backend.fs('spaceInfo', info.id, panel.path());
      if (s && (s.free || s.total)) {
        space = `${formatBytes(s.free || 0)} ${t('srvSpace').toLowerCase()}`;
      }
    } catch { space = null; }
    sync();
  }

  const offs = [
    bus.on('panel:selectionChanged', (e) => { if (!e || e.side === side) sync(); }),
    bus.on('panel:entriesChanged', (e) => { if (!e || e.side === side) sync(); }),
    bus.on('panel:pathChanged', (e) => { if (!e || e.side === side) refreshSpace(); }),
    bus.on('panel:searchChanged', (e) => { if (!e || e.side === side) sync(); }),
    bus.on('prefs:changed', sync),
    bus.on('i18n:changed', sync),
  ];

  sync();

  return {
    element: root,
    sync,
    refreshSpace,
    destroy() { offs.forEach((off) => off()); root.remove(); },
  };
}

/* ================================================================== */
/* the session status bar                                              */
/* ================================================================== */

function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h2 = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(h2)}:${pad(m)}:${pad(s)}`;
}

/**
 * installSessionStatus({ workspace, registerStatusItem, refreshStatus })
 *
 * Registers the protocol / security / duration items in the shell's status bar
 * and keeps them live. The shell owns the bar; this only supplies items, so
 * nothing here fights app.js for the same DOM.
 */
export function installSessionStatus(opts = {}) {
  ensureStyle('winscp-statusbar', CSS);
  const register = opts.registerStatusItem;
  const refresh = opts.refreshStatus || (() => {});
  if (typeof register !== 'function') return { destroy() {} };

  const state = { info: null, fsInfo: null, note: '' };

  function activeInfo() {
    const ws = opts.workspace;
    const panel = ws && ws.panel ? ws.panel('remote') : null;
    return (panel && panel.sessionInfo && panel.sessionInfo()) || state.info;
  }

  const disposers = [];

  disposers.push(register({
    id: 'winscp-note', side: 'left', order: 15, label: 'Status note',
    render: () => (state.note
      ? h('span', { class: 'chip is-quiet', title: state.note }, icon('info', 13), h('span', {}, oneLine(state.note, 60)))
      : null),
  }));

  disposers.push(register({
    id: 'winscp-protocol', side: 'left', order: 30, label: 'Protocol status',
    render: () => {
      const info = activeInfo();
      if (!info) return null;
      const name = (info.protocol || '').toUpperCase();
      const title = info.connected
        ? `${name} — ${info.userName ? `${info.userName}@` : ''}${info.hostName}${info.portNumber ? `:${info.portNumber}` : ''}`
        : t('notConnected');
      return h('span', {
        class: 'chip', title,
        onclick: () => runAction('FileSystemInfoAction'),
      }, icon('lan', 13), h('span', {}, name || t('notConnected')));
    },
  }));

  disposers.push(register({
    id: 'winscp-security', side: 'left', order: 40, label: 'Security status',
    render: () => {
      const info = activeInfo();
      if (!info || !info.connected) return null;
      const cipher = state.fsInfo && (state.fsInfo.cipher || state.fsInfo.securityProtocol || '');
      // The insecure case is stated in words, never left to the absence of an
      // icon — a missing padlock is not a warning anybody reads.
      const secure = !!cipher || info.protocol === 'sftp' || info.protocol === 'scp';
      return h('span', {
        class: secure ? 'chip' : 'chip is-warn',
        title: secure
          ? `${t('srvCipher')}: ${cipher || info.protocol.toUpperCase()}`
          : 'This connection is not encrypted. Anything sent over it, including your password, can be read in transit.',
      }, icon(secure ? 'shield_lock' : 'warning', 13),
      h('span', {}, secure ? (cipher || 'TLS/SSH') : 'Not encrypted'));
    },
  }));

  disposers.push(register({
    id: 'winscp-duration', side: 'right', order: 20, label: 'Session duration',
    render: () => {
      const info = activeInfo();
      if (!info || !info.connected || !info.openedAt) return null;
      return h('span', { class: 'mono', title: t('statusOf') }, formatDuration(Date.now() - info.openedAt));
    },
  }));

  // The duration ticks once a second; everything else repaints on an event.
  const timer = setInterval(() => { if (activeInfo()?.connected) refresh('winscp-duration'); }, 1000);

  const offs = [
    bus.on('session:opened', async (info) => {
      state.info = info;
      state.fsInfo = null;
      refresh();
      try { state.fsInfo = await backend.session('fsInfo', info.id); refresh(); }
      catch { /* the chip falls back to the protocol name */ }
    }),
    bus.on('panel:pathChanged', () => refresh()),
    bus.on('panel:activeSideChanged', () => refresh()),
    bus.on('status:note', (note) => { state.note = String(note || ''); refresh(); }),
  ];

  const offEvent = backend.on('event:session', (payload) => {
    if (!payload) return;
    if (payload.info) state.info = payload.info;
    if (payload.banner) state.note = String(payload.banner);
    refresh();
  });

  return {
    setNote(note) { state.note = String(note || ''); refresh(); },
    destroy() {
      clearInterval(timer);
      offs.forEach((off) => off());
      offEvent();
      disposers.forEach((d) => { try { d(); } catch { /* already gone */ } });
    },
  };
}
