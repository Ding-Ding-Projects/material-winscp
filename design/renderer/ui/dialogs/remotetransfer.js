// ui/dialogs/remotetransfer.js — forms/RemoteTransfer.dfm.
//
// "Duplicate": copying or moving files from one place on a server to another
// place, on the same session or on a different one. Every control from the
// .dfm is here — the target session combo, the target path/mask history combo,
// "Duplicate via local temporary copy" — and so is the behaviour that hangs
// off them:
//
//   * changing the session rewrites the path to that session's directory but
//     keeps the file mask, exactly as SessionComboChange does,
//   * the target is split into a directory and a file mask, which is what
//     lets a duplicate be renamed in the same step ('/tmp/*.bak'),
//   * "via local temporary copy" is the only option when the target session is
//     not the source one, because a server cannot copy to another server; the
//     box is then checked and locked rather than quietly ignored,
//   * more than one file into a single non-mask name is confirmed before it
//     happens, not discovered afterwards.

import { h, uid, appearanceTarget, announce } from '../../dom.js';
import { t, bindRender } from '../../i18n.js';
import { registerDialog, openDialog } from '../../app.js';
import { notify } from '../notifications.js';
import {
  makeTranslator, txLabel, ops, checkRow, joinPath, readHistory, pushHistory,
} from './rights.js';

const STRINGS = {
  rtTitle: ['Duplicate', '複製一份'],
  rtTargetSession: ['Target session', '目標工作階段'],
  rtTargetPath: ['Target remote path', '目標遠端路徑'],
  rtNotDirect: ['Duplicate via local temporary copy', '經本機臨時檔複製'],
  rtNotDirectForced: [
    'The target is a different session, so the files travel through this computer.',
    '目標係另一個工作階段，所以啲檔案要經你部機行一轉。'],
  rtNotDirectHint: [
    'Off, the server copies the files itself. On, they are downloaded and uploaded again.',
    '唔剔就由伺服器自己複製；剔咗就下載返上嚟再上載。'],
  rtOneFile: ['Duplicate file "{0}" to remote directory:', '將檔案「{0}」複製去遠端目錄：'],
  rtManyFiles: ['Duplicate {0} files to remote directory:', '將 {0} 個檔案複製去遠端目錄：'],
  rtMoveOneFile: ['Move file "{0}" to remote directory:', '將檔案「{0}」移去遠端目錄：'],
  rtMoveManyFiles: ['Move {0} files to remote directory:', '將 {0} 個檔案移去遠端目錄：'],
  rtMultiToOne: [
    '{0} files would all be written to the single name "{1}", so each one would overwrite the last. Add * to the name to keep them apart.',
    '{0} 個檔案會全部寫入同一個名「{1}」，後面嗰個會冚咗前面嗰個。喺個名度加返個 * 就唔會撞。'],
  rtNoTarget: ['Type a target path first.', '要先打個目標路徑。'],
  rtNoSession: ['No session is open to duplicate into.', '冇開住嘅工作階段可以複製過去。'],
  rtNoFiles: ['Select at least one file first.', '要先揀最少一個檔案。'],
  rtQueued: [[
    '{0} item(s) queued to {1}.',
    'Queued {0} item(s) for {1}.',
    '{0} item(s) lined up for {1}.',
    '{0} item(s) are queued and elbowing each other towards {1}.',
    '{0} item(s) have joined the queue to {1}, single file, no pushing!'], [
    '已排隊 {0} 個項目去 {1}。',
    '{0} 個項目排咗隊去 {1}。',
    '{0} 個項目排緊隊去 {1}。',
    '{0} 個項目排緊隊，你推我擁咁去 {1}。',
    '{0} 個項目排好隊去 {1}，一個跟一個，唔准打尖！']],
  rtFailed: ['Nothing was queued: {0}', '一單都排唔到隊：{0}'],
  rtUnsupported: [
    '{0} cannot duplicate on the server, and this build has no route that copies through this computer instead, so there is nothing to queue.',
    '{0} 喺伺服器度自己複製唔到，而呢個版本亦都冇經你部機行一轉嘅路，所以冇嘢可以排隊。'],
  rtCrossSession: [
    'Only the source session can be a target. Copying between two servers would have to travel through this computer, and the transfer engine in this build has no path for it — picking another session here would send these paths to the WRONG server.',
    '目標淨係可以揀返來源嗰個工作階段。 兩部伺服器之間複製要經你部機行一轉，但係呢個版本嘅傳輸引擎冇呢條路——揀第二個工作階段會將呢啲路徑send去錯嘅伺服器。'],
  rtOtherSession: ['{0} — not available as a target', '{0} — 唔可以做目標'],
};

const tx = makeTranslator(STRINGS);

const HISTORY_KEY = 'remoteCopy';

/** Split '/tmp/*.bak' into its directory and its file mask. */
export function splitTarget(text) {
  const value = String(text || '');
  const i = value.lastIndexOf('/');
  if (i < 0) return { directory: '', mask: value };
  return { directory: value.slice(0, i + 1), mask: value.slice(i + 1) };
}

/** IsFileNameMask: does the name half actually vary per file? */
export function isFileNameMask(mask) {
  const m = String(mask || '');
  return m === '' || /[*?]/.test(m);
}

/** Validate the fields that must be true before queue:add is attempted. */
export function validateRemoteTransfer({ files = [], target = '', sessions = [], canCopy = true }) {
  const value = String(target || '').trim();
  if (!files.length) return 'noFiles';
  if (!value) return 'noTarget';
  if (!sessions.length) return 'noSession';
  if (!canCopy) return 'unsupported';
  const { mask } = splitTarget(value);
  if (files.length > 1 && !isFileNameMask(mask)) return 'multiToOne';
  return '';
}

/** Server-side duplicate is a distinct capability from generic command execution. */
export function supportsRemoteCopy(caps = {}) {
  return !!caps.copyRemote;
}

/**
 * props:
 *   sessionId          the source session
 *   files              [{ name, path, type }]
 *   directory          the source directory (the default target)
 *   move               true for "Move to…" rather than "Duplicate…"
 *   sessions           [{ id, name, remotePath, caps }] — defaults to session:list
 *   caps               the source session's caps
 *   onQueued(items)
 */
registerDialog('remotetransfer', ({ props, close }) => {
  const files = Array.isArray(props.files) ? props.files : [];
  const move = !!props.move;
  const sourceId = props.sessionId || '';
  let sessions = Array.isArray(props.sessions) ? props.sessions.slice() : [];
  // The target session is always the source session — see paintSessions().
  let targetId = sourceId;

  const pathId = uid('rtpath');
  const sessionId = uid('rtsession');

  const sessionSelect = h('select', {
    class: 'field-input', id: sessionId,
    style: { flex: '1 1 auto', minWidth: 0 },
    onchange: () => {
      const previous = targetId;
      targetId = sessionSelect.value;
      // SessionComboChange: keep the file mask, move the directory.
      const { mask } = splitTarget(pathInput.value);
      const target = sessions.find((s) => s.id === targetId);
      const base = (target && (target.remotePath || target.home)) || '/';
      pathInput.value = `${base.endsWith('/') ? base : `${base}/`}${mask}`;
      if (targetId !== previous) updateNotDirect();
      update();
    },
  });

  const pathInput = h('input', {
    type: 'text', class: 'field-input', id: pathId, autocomplete: 'off', spellcheck: 'false',
    list: `${pathId}-history`,
    style: { flex: '1 1 auto', minWidth: 0 },
    oninput: () => update(),
  });
  const historyList = h('datalist', { id: `${pathId}-history` });

  const startDir = props.directory || '';
  pathInput.value = `${startDir.endsWith('/') ? startDir : `${startDir}/`}*.*`;

  const notDirect = checkRow(txLabel(tx, 'rtNotDirect'), false, () => update());

  const sessionLabel = h('label', { class: 'field-label', for: sessionId, style: { width: 'calc(16ch * var(--uiscale))' } });
  const pathLabel = h('label', { class: 'field-label', for: pathId, style: { width: 'calc(16ch * var(--uiscale))' } });
  bindRender(sessionLabel, () => { sessionLabel.textContent = tx('rtTargetSession'); });
  bindRender(pathLabel, () => { pathLabel.textContent = tx('rtTargetPath'); });

  const headline = h('p', { class: 'prose' });
  bindRender(headline, () => {
    const first = files[0] ? files[0].name : '';
    headline.textContent = files.length === 1
      ? (move ? tx('rtMoveOneFile', first) : tx('rtOneFile', first))
      : (move ? tx('rtMoveManyFiles', files.length) : tx('rtManyFiles', files.length));
  });

  const warning = h('div', {
    role: 'status',
    'aria-live': 'polite',
    style: {
      fontSize: 'var(--type-label-md)', lineHeight: '1.45',
      background: 'var(--terc)', color: 'var(--onterc)',
      borderRadius: 'var(--shape-sm)', padding: '7px 9px',
    },
  });
  warning.hidden = true;
  pathInput.setAttribute('aria-describedby', warning.id = uid('rtwarning'));

  const content = h('div', { class: 'stack' },
    headline,
    h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, sessionLabel, sessionSelect),
    h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, pathLabel, pathInput),
    historyList,
    notDirect.element,
    warning);
  appearanceTarget(content, 'remotetransfer-dialog', 'Duplicate dialog');

  let okButton = null;
  let submitting = false;

  function paintSessions() {
    // Only the source session may be a target. design/main/ipc.js's remote-copy
    // builds BOTH paths from the one session it is handed and its own comment
    // says "both ends are the same server"; `viaLocalTemporary` and
    // `sourceSessionId` are read by nothing. Offering another session would
    // therefore ask the TARGET server to copy the SOURCE server's paths — a
    // silently wrong copy of the wrong file whenever that path happens to
    // exist. So the other sessions stay listed (the user can see they exist)
    // and are disabled with the reason, rather than removed or offered.
    sessionSelect.replaceChildren(...sessions.map((s) => {
      const usable = s.id === sourceId;
      const option = h('option', {
        value: s.id,
        disabled: usable ? undefined : 'disabled',
        title: usable ? undefined : tx('rtCrossSession'),
      }, usable ? (s.name || s.id) : tx('rtOtherSession', s.name || s.id));
      return option;
    }));
    targetId = sourceId;
    if (sessions.some((s) => s.id === sourceId)) sessionSelect.value = sourceId;
    sessionSelect.disabled = sessions.length <= 1;
    if (sessions.length > 1) sessionSelect.title = tx('rtCrossSession');
    updateNotDirect();
  }

  /** UpdateNotDirectCopyCheck: another session forces the local round trip. */
  function sourceSession() {
    return sessions.find((s) => s.id === sourceId) || { caps: props.caps, protocol: props.protocolName };
  }

  /** True when the server can perform the copy itself — the only route there is. */
  function canServerCopy() {
    const caps = sourceSession().caps || props.caps || {};
    return supportsRemoteCopy(caps);
  }

  /**
   * UpdateNotDirectCopyCheck, corrected for what this build can actually do.
   * WinSCP offers a local round trip; nothing in this port implements one, so
   * the box is shown unchecked and disabled with that stated, and OK is
   * refused rather than sending a request main will throw on.
   */
  function updateNotDirect() {
    const direct = canServerCopy();
    notDirect.input.checked = false;
    notDirect.input.disabled = true;
    notDirect.element.title = direct
      ? tx('rtNotDirectHint')
      : tx('rtUnsupported', sourceSession().protocol || props.protocolName || 'This protocol');
  }

  function update() {
    const { directory, mask } = splitTarget(pathInput.value);
    const reason = validateRemoteTransfer({ files, target: pathInput.value, sessions, canCopy: canServerCopy() });
    const problem = reason === 'noFiles' ? tx('rtNoFiles')
      : reason === 'noTarget' ? tx('rtNoTarget')
        : reason === 'noSession' ? tx('rtNoSession')
          : reason === 'unsupported' ? tx('rtUnsupported', sourceSession().protocol || props.protocolName || 'This protocol')
            : reason === 'multiToOne' ? tx('rtMultiToOne', files.length, mask) : '';
    warning.textContent = problem;
    warning.hidden = !problem;
    // OK is refused for the two problems that make the request impossible, not
    // merely awkward: a protocol that cannot copy on the server, and no target.
    if (okButton) okButton.disabled = submitting || !!reason;
    return { directory, mask };
  }

  async function queue() {
    const { directory, mask } = splitTarget(pathInput.value.trim());
    const sources = files.map((f) => f.path || joinPath(props.directory || '', f.name)).filter(Boolean);
    const reason = validateRemoteTransfer({ files: sources, target: pathInput.value, sessions, canCopy: canServerCopy() });
    if (reason) { update(); return false; }
    submitting = true;
    update();
    try {
      const target = directory || '/';
      // One session, one server-side copy. The request carries only fields
      // design/main/ipc.js and design/main/queue.js actually read — a field
      // nobody reads is a promise the engine never made.
      const request = {
        sessionId: sourceId,
        direction: 'remote-copy',
        files: sources,
        target,
        copyParam: {
          fileMask: mask && mask !== '*.*' ? mask : '',
          move,
        },
      };
      const added = await ops.queue.add(request);
      await pushHistory(HISTORY_KEY, pathInput.value.trim());
      const count = Array.isArray(added) ? added.length : sources.length;
      notify.success(tx('rtQueued', count, target));
      announce(tx('rtQueued', count, target));
      props.onQueued?.(added);
      return true;
    } catch (err) {
      notify.error(tx('rtTitle'), tx('rtFailed', err?.message || 'The queue rejected the request.'));
      return false;
    } finally {
      submitting = false;
      update();
    }
  }

  // The session list comes from main unless the caller already had it.
  if (!sessions.length) {
    ops.session.list()
      .then((list) => {
        sessions = (list || []).filter((s) => s.connected !== false);
        paintSessions();
        update();
      })
      .catch(() => { update(); });
  } else {
    paintSessions();
  }
  update();

  readHistory(HISTORY_KEY).then((list) => {
    historyList.replaceChildren(...list.map((value) => h('option', { value })));
  });

  return {
    title: move ? t('moveDots') : tx('rtTitle'),
    width: 600,
    content,
    actions: [
      { label: t('cancel'), kind: 'text' },
      {
        label: t('ok'), kind: 'filled', autofocus: true,
        ref: (btn) => { okButton = btn; update(); },
        onSelect: async (closeDialog) => {
          const queued = await queue();
          if (queued) closeDialog();
          return true;
        },
      },
    ],
  };
});

/** Open the duplicate / remote-move dialog. */
export function openRemoteTransfer(props) { return openDialog('remotetransfer', props); }
