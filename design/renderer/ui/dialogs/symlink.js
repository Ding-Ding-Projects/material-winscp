// ui/dialogs/symlink.js — forms/Symlink.dfm (TSymlinkDialog).
//
// Creating and editing a link, both sides. The rules are TSymlinkDialog's:
//
//   * editing locks the file name (the link keeps its name; only its target
//     moves) and forbids switching between symbolic and hard,
//   * the hard-link box is offered only on a remote side that reports
//     fcHardLink — here, `caps.hardlink` — because a hard link the protocol
//     cannot make is an offer that would fail,
//   * OK stays disabled until both the name and the target are filled in.
//
// Editing really does what TCustomScpExplorerForm::AddEditLink does: the old
// link is removed and a new one created, because no protocol here can retarget
// a link in place. The dialog says so before the user presses OK rather than
// after — it is a deletion, even if what it deletes is one inode.

import { h, uid, appearanceTarget, announce } from '../../dom.js';
import { t, bindRender } from '../../i18n.js';
import { registerDialog, openDialog } from '../../app.js';
import { notify } from '../notifications.js';
import {
  makeTranslator, txLabel, ops, checkRow, joinPath, separatorOf,
} from './rights.js';

const STRINGS = {
  slAddCaption: ['Add link/shortcut', '加連結／捷徑'],
  slEditCaption: ['Edit link/shortcut', '改連結／捷徑'],
  slFileName: ['Link/shortcut file', '連結／捷徑檔案'],
  slPointTo: ['Point link/shortcut to', '連結／捷徑指向'],
  slHardLink: ['Hard link', '硬連結'],
  slHardUnsupported: ['{0} cannot create hard links.', '{0} 整唔到硬連結。'],
  slEditReplaces: [
    'Saving replaces the link: the existing one is removed and a new one is created in its place. The file it points at is not touched.',
    '儲存會換走條連結：舊嗰條會刪走，然後喺原位整條新嘅。佢指住嗰個檔案唔會郁到。'],
  slLocalHint: [
    'A local shortcut is created as a symbolic link; Windows needs Developer Mode or an elevated session to allow that.',
    '本機捷徑會整做符號連結；Windows 要開咗開發人員模式或者用管理員身分先做得到。'],
  slUnsupported: ['{0} does not support links, so nothing can be created here.', '{0} 唔支援連結，所以呢度整唔到嘢。'],
  slNoChannel: [
    'This panel is browsing without a session, and links are created through a session’s file system. Open the folder in a session to create one.',
    '呢個面板冇連住工作階段，而連結要經工作階段嘅檔案系統整。喺工作階段度開返個資料夾先整得到。'],
  slCreated: [[
    'Link "{0}" now points at "{1}".',
    'Created the link "{0}" -> "{1}".',
    '"{0}" now points straight at "{1}".',
    '"{0}" has been taught exactly where "{1}" lives.',
    'Signpost planted! "{0}" now points at "{1}" with great confidence!'], [
    '連結「{0}」而家指住「{1}」。',
    '整咗連結「{0}」→「{1}」。',
    '「{0}」而家直接指住「{1}」。',
    '「{0}」已經學識咗「{1}」喺邊度。',
    '路牌插好！「{0}」而家好自信咁指住「{1}」！']],
  slFailed: ['The link was not created: {0}', '整唔到連結：{0}'],
  slReplaceFailed: ['The old link was not removed, so nothing was changed: {0}', '刪唔到舊連結，所以乜都冇改：{0}'],
  slBothRequired: ['Both the link name and its target are needed.', '連結名同目標兩樣都要有。'],
  slInvalidName: ['The link name must be one safe file name, not a path.', '連結名要係一個安全檔名，唔可以係條路徑。'],
};

const tx = makeTranslator(STRINGS);

/** Return a stable validation code for the user-editable link name. */
export function validateSymlinkName(value) {
  const name = String(value ?? '').trim();
  if (!name) return 'required';
  if (name === '.' || name === '..') return 'dot-segment';
  if (/[\\/]/.test(name)) return 'separator';
  if ([...name].some((ch) => ch.charCodeAt(0) < 32)) return 'control';
  return '';
}

/**
 * props:
 *   sessionId, side, directory, caps, protocolName
 *   name          the link's file name (locked in edit mode)
 *   pointTo       what it points at
 *   edit          true when an existing link is being retargeted
 *   symbolic      false for a hard link (edit mode keeps whatever it is)
 *   onDone(path)  called once the link exists
 */
registerDialog('symlink', ({ props, close }) => {
  const local = props.side === 'local' || !props.sessionId;
  const caps = props.caps || {};
  const edit = !!props.edit;
  const directory = props.directory || '';
  const sep = separatorOf(directory);
  const protocolName = props.protocolName || (local ? 'The local file system' : 'This protocol');
  // Links go through the session's adapter — including the local one, which
  // makes real symlinks and hard links. A local panel browsing without a
  // session has no channel for it, and the dialog says so instead of failing
  // at the last step.
  const canLink = props.sessionId ? caps.symlink !== false : false;
  const canHardLink = !!props.sessionId && caps.hardlink === true && !edit;

  const nameId = uid('linkname');
  const targetId = uid('linkto');

  const nameInput = h('input', {
    type: 'text', class: 'field-input', id: nameId, autocomplete: 'off', spellcheck: 'false',
    style: { flex: '1 1 auto', minWidth: 0 },
  });
  nameInput.value = props.name || '';
  if (edit) {
    nameInput.readOnly = true;
    nameInput.tabIndex = -1;
    nameInput.style.background = 'var(--c-low)';
  }

  const targetInput = h('input', {
    type: 'text', class: 'field-input', id: targetId, autocomplete: 'off', spellcheck: 'false',
    style: { flex: '1 1 auto', minWidth: 0 },
  });
  targetInput.value = props.pointTo || '';

  const nameLabel = h('label', { class: 'field-label', for: nameId, style: { width: 'calc(17ch * var(--uiscale))' } });
  const targetLabel = h('label', { class: 'field-label', for: targetId, style: { width: 'calc(17ch * var(--uiscale))' } });
  bindRender(nameLabel, () => { nameLabel.textContent = tx('slFileName'); });
  bindRender(targetLabel, () => { targetLabel.textContent = t('linkPointTo'); });

  const hard = checkRow(txLabel(tx, 'slHardLink'), props.symbolic === false, () => updateOk());
  hard.input.disabled = !canHardLink;
  hard.element.title = canHardLink ? '' : tx('slHardUnsupported', protocolName);

  const note = h('p', { class: 'prose muted', style: { fontSize: 'var(--type-label-md)' } });
  bindRender(note, () => {
    note.textContent = !canLink
      ? (props.sessionId ? tx('slUnsupported', protocolName) : tx('slNoChannel'))
      : edit
        ? tx('slEditReplaces')
        : local
          ? tx('slLocalHint')
          : '';
    note.hidden = !note.textContent;
  });

  const content = h('div', { class: 'stack' },
    h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, nameLabel, nameInput),
    h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, targetLabel, targetInput),
    hard.element,
    note);
  appearanceTarget(content, 'symlink-dialog', 'Link dialog');

  let okButton = null;

  function updateOk() {
    if (okButton) {
      okButton.disabled = !canLink || !!validateSymlinkName(nameInput.value) || !targetInput.value.trim();
    }
  }
  nameInput.addEventListener('input', updateOk);
  targetInput.addEventListener('input', updateOk);

  async function createLink() {
    const name = nameInput.value.trim();
    const target = targetInput.value.trim();
    if (!name || !target) { notify.warning(t('symlinkTitle'), tx('slBothRequired')); return; }
    if (validateSymlinkName(name)) { notify.warning(t('symlinkTitle'), tx('slInvalidName')); return; }
    const linkPath = /^([A-Za-z]:[\\/]|\/|\\\\)/.test(name) ? name : joinPath(directory, name, sep);

    try {
      if (edit) {
        // AddEditLink deletes the old link first; a link cannot be retargeted
        // in place on any of these protocols.
        try {
          await ops.fs.remove(props.sessionId, [linkPath], { recursive: false });
        } catch (err) {
          notify.error(t('symlinkTitle'), tx('slReplaceFailed', err.message));
          return;
        }
      }
      await ops.fs.symlink(props.sessionId, target, linkPath, hard.input.checked === true);
      notify.success(tx('slCreated', name, target));
      announce(t('createdMsg', name));
      props.onDone?.(linkPath);
    } catch (err) {
      notify.error(t('symlinkTitle'), tx('slFailed', err.message));
    }
  }

  return {
    title: edit ? tx('slEditCaption') : tx('slAddCaption'),
    width: 560,
    content,
    actions: [
      { label: t('cancel'), kind: 'text' },
      {
        label: t('ok'), kind: 'filled', autofocus: true,
        ref: (btn) => { okButton = btn; updateOk(); },
        onSelect: () => { createLink(); close(); },
      },
    ],
  };
});

/** Open the link dialog. */
export function openSymlinkDialog(props) { return openDialog('symlink', props); }
