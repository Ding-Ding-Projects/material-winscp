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
    '{0} cannot duplicate on the server, so the copy goes through this computer.',
    '{0} 唔可以喺伺服器自己複製，所以要經你部機行一轉。'],
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
  let targetId = sourceId;
  let directCopy = props.directCopy !== false;

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

  const notDirect = checkRow(txLabel(tx, 'rtNotDirect'), false, (checked) => {
    if (targetId === sourceId) directCopy = !checked;
    update();
  });

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
    style: {
      fontSize: 'var(--type-label-md)', lineHeight: '1.45',
      background: 'var(--terc)', color: 'var(--onterc)',
      borderRadius: 'var(--shape-sm)', padding: '7px 9px',
    },
  });
  warning.hidden = true;

  const content = h('div', { class: 'stack' },
    headline,
    h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, sessionLabel, sessionSelect),
    h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, pathLabel, pathInput),
    historyList,
    notDirect.element,
    warning);
  appearanceTarget(content, 'remotetransfer-dialog', 'Duplicate dialog');

  let okButton = null;

  function paintSessions() {
    sessionSelect.replaceChildren(...sessions.map((s) => {
      const option = h('option', { value: s.id }, s.name || s.id);
      return option;
    }));
    if (sessions.some((s) => s.id === targetId)) sessionSelect.value = targetId;
    else if (sessions.length) { targetId = sessions[0].id; sessionSelect.value = targetId; }
    sessionSelect.disabled = sessions.length <= 1;
    updateNotDirect();
  }

  /** UpdateNotDirectCopyCheck: another session forces the local round trip. */
  function updateNotDirect() {
    const sameSession = targetId === sourceId;
    const source = sessions.find((s) => s.id === sourceId)
      || { caps: props.caps, protocol: props.protocolName };
    const canDirect = sameSession && !!(source.caps && (source.caps.copyRemote || source.caps.exec));
    notDirect.input.checked = sameSession ? !directCopy : true;
    notDirect.input.disabled = !canDirect;
    notDirect.element.title = sameSession
      ? (canDirect ? tx('rtNotDirectHint') : tx('rtUnsupported', source.protocol || 'This protocol'))
      : tx('rtNotDirectForced');
  }

  function update() {
    const { directory, mask } = splitTarget(pathInput.value);
    const problem = !pathInput.value.trim()
      ? tx('rtNoTarget')
      : (!sessions.length ? tx('rtNoSession')
        : (files.length > 1 && !isFileNameMask(mask) ? tx('rtMultiToOne', files.length, mask) : ''));
    warning.textContent = problem;
    warning.hidden = !problem;
    if (okButton) okButton.disabled = !pathInput.value.trim() || !sessions.length;
    return { directory, mask };
  }

  async function queue() {
    const { directory, mask } = splitTarget(pathInput.value);
    const sources = files.map((f) => f.path || joinPath(props.directory || '', f.name)).filter(Boolean);
    if (!sources.length) return;
    const sameSession = targetId === sourceId;
    try {
      const target = directory || '/';
      // Same session with a server-side copy: one remote-copy job. Another
      // session: download then upload, which the queue expresses as a download
      // to a temporary directory followed by an upload — the queue owns that
      // pairing, so the request names the target session and the intent.
      const request = {
        sessionId: sameSession ? sourceId : targetId,
        direction: 'remote-copy',
        files: sources,
        target,
        copyParam: {
          fileMask: mask && mask !== '*.*' ? mask : '',
          move,
          viaLocalTemporary: notDirect.input.checked,
          sourceSessionId: sourceId,
        },
      };
      const added = await ops.queue.add(request);
      await pushHistory(HISTORY_KEY, pathInput.value.trim());
      const count = Array.isArray(added) ? added.length : sources.length;
      notify.success(tx('rtQueued', count, target));
      announce(tx('rtQueued', count, target));
      props.onQueued?.(added);
    } catch (err) {
      notify.error(tx('rtTitle'), tx('rtFailed', err.message));
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
        onSelect: () => { queue(); close(); },
      },
    ],
  };
});

/** Open the duplicate / remote-move dialog. */
export function openRemoteTransfer(props) { return openDialog('remotetransfer', props); }
