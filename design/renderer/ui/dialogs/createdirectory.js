// ui/dialogs/createdirectory.js — forms/CreateDirectory.dfm.
//
// Every control the .dfm declares: the name field, the Attributes group with
// the permission frame behind "Set permissions", "Use same settings next time"
// (which really does persist), and OK/Cancel. The frame is created with
// AllowAddXToDirectories off, exactly as TCreateDirectoryDialog's constructor
// does — a directory being created does not need the "+x" trick applied to
// itself, the permissions are simply what it is created with.
//
// The transfer-settings link is offered when the caller can honour it. A panel
// that knows how to open the transfer-settings surface passes
// `onTransferSettings`; when nobody can, the link is absent rather than
// present and dead.

import { h, uid, appearanceTarget, announce } from '../../dom.js';
import { t, bindRender } from '../../i18n.js';
import { registerDialog, openDialog } from '../../app.js';
import { notify } from '../notifications.js';
import {
  createRightsEditor, parseRights, looksLikeRights, fromNumber, RF, chmodStrOf,
  makeTranslator, txLabel, ops, checkRow, joinPath, separatorOf, readPref, writePrefs,
} from './rights.js';

const STRINGS = {
  cdAttributes: ['Attributes', '屬性'],
  cdSetRights: ['Set permissions', '設定權限'],
  cdSameSettings: ['Use same settings next time', '下次用返同樣設定'],
  cdNameRequired: ['Type a folder name first.', '要先打個資料夾名。'],
  cdRightsUnsupported: ['{0} cannot set permissions, so the folder is created with the server’s default.', '{0} 設唔到權限，所以資料夾會用伺服器預設。'],
  cdTransferSettings: ['Transfer settings…', '傳輸設定…'],
  cdWillCreate: ['Creates {0}', '會建立 {0}'],
  cdCreated: [[
    'Folder "{0}" created.',
    'Created the folder "{0}".',
    'New folder "{0}" is on the server.',
    'Freshly minted folder "{0}", still warm.',
    'TA-DAA! Folder "{0}" materialised out of thin air, ribbon and all!'], [
    '已建立資料夾「{0}」。',
    '整咗個資料夾「{0}」。',
    '新資料夾「{0}」已經喺伺服器度。',
    '啱啱出爐嘅資料夾「{0}」，仲熱辣辣。',
    '鏘鏘！資料夾「{0}」憑空出現，仲紮埋蝴蝶結添！']],
  cdFailed: ['The folder was not created: {0}', '整唔到資料夾：{0}'],
  cdRightsFailed: ['The folder was created, but its permissions were not set: {0}', '資料夾整咗，但係設唔到權限：{0}'],
};

const tx = makeTranslator(STRINGS);

const PREF_PATH = 'newDirectory';

/**
 * props:
 *   sessionId, side ('local'|'remote'), directory, caps, protocolName
 *   name                 pre-filled name
 *   onCreated(path)      called after the directory really exists
 *   onTransferSettings() opens the transfer-settings surface, when the caller has one
 */
registerDialog('createdirectory', ({ props, close }) => {
  const local = props.side === 'local' || !props.sessionId;
  const caps = props.caps || (local ? { rights: false } : {});
  const directory = props.directory || '';
  const sep = separatorOf(directory);
  const protocolName = props.protocolName || (local ? 'The local file system' : 'This protocol');
  const canSetRights = caps.rights !== false && !!props.sessionId;

  const nameId = uid('newdir');
  const nameInput = h('input', {
    type: 'text', class: 'field-input', id: nameId, autocomplete: 'off', spellcheck: 'false',
    style: { flex: '1 1 auto', minWidth: 0 },
  });
  nameInput.value = props.name || '';

  const nameLabel = h('label', { class: 'field-label', for: nameId });
  bindRender(nameLabel, () => { nameLabel.textContent = t('dirName'); });

  const preview = h('div', { class: 'muted mono', style: { fontSize: 'var(--type-label-sm)', wordBreak: 'break-all' } });

  const rightsEditor = createRightsEditor({
    rights: fromNumber(RF.default),
    allowUndef: false,
    // TCreateDirectoryDialog turns this off: the frame is describing the new
    // directory's own mode, not a mode being applied across a tree.
    allowAddXToDirectories: false,
    disabled: true,
    onChange: () => updatePreview(),
  });

  const setRights = checkRow(txLabel(tx, 'cdSetRights'), false, (checked) => {
    rightsEditor.setEnabled(checked && canSetRights);
    updatePreview();
  });
  setRights.input.disabled = !canSetRights;

  const saveSettings = checkRow(txLabel(tx, 'cdSameSettings'), false, () => {});

  const attributes = h('fieldset', {
    style: {
      border: '1px solid var(--outline-var)',
      borderRadius: 'var(--shape-md)',
      padding: 'calc(10px * var(--den))',
      display: 'flex', flexDirection: 'column', gap: 'calc(8px * var(--den))',
      margin: 0, minWidth: 0,
    },
  },
  h('legend', { class: 'field-label' }, tx('cdAttributes')),
  setRights.element,
  canSetRights ? null : h('p', { class: 'prose muted', style: { fontSize: 'var(--type-label-md)' } },
    tx('cdRightsUnsupported', protocolName)),
  rightsEditor.element);

  const transferLink = typeof props.onTransferSettings === 'function'
    ? h('button', {
      type: 'button', class: 'btn-text',
      onclick: () => props.onTransferSettings(),
    }, tx('cdTransferSettings'))
    : null;

  const content = h('div', { class: 'stack' },
    h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, nameLabel, nameInput),
    preview,
    attributes,
    h('div', { class: 'row' }, saveSettings.element, transferLink));
  appearanceTarget(content, 'createdir-dialog', 'Create directory dialog');

  let okButton = null;

  function targetPath() {
    const name = nameInput.value.trim();
    if (!name) return '';
    if (/^([A-Za-z]:[\\/]|\/|\\\\)/.test(name)) return name;    // already absolute
    return joinPath(directory, name, sep);
  }

  function updatePreview() {
    const path = targetPath();
    preview.textContent = path ? tx('cdWillCreate', path) : tx('cdNameRequired');
    if (okButton) okButton.disabled = !path;
  }

  nameInput.addEventListener('input', updatePreview);
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && targetPath()) { e.preventDefault(); okButton?.click(); }
  });
  updatePreview();

  // "Use same settings next time" is a real preference, so the dialog opens
  // where the user left it.
  readPref(PREF_PATH, null).then((saved) => {
    if (!saved || typeof saved !== 'object') return;
    saveSettings.input.checked = true;
    if (saved.rights && looksLikeRights(saved.rights)) {
      rightsEditor.rights = parseRights(saved.rights);
    }
    if (saved.setRights && canSetRights) {
      setRights.input.checked = true;
      rightsEditor.setEnabled(true);
    }
    updatePreview();
  });

  async function create() {
    const path = targetPath();
    if (!path) return;
    try {
      const created = local
        ? await ops.fs.localMkdir(path)
        : await ops.fs.mkdir(props.sessionId, path);
      const finalPath = created || path;

      if (setRights.input.checked && canSetRights) {
        try {
          await ops.fs.setRights(props.sessionId, [finalPath], chmodStrOf(rightsEditor.rights, true), {
            recursive: false, addXToDirectories: false,
          });
        } catch (err) {
          notify.warning(t('createDirTitle'), tx('cdRightsFailed', err.message));
        }
      }

      if (saveSettings.input.checked) {
        await writePrefs({
          [PREF_PATH]: {
            setRights: setRights.input.checked,
            rights: rightsEditor.text.replace(' (+x)', ''),
          },
        }, 'Remembered the new-folder attributes');
      } else {
        await writePrefs({ [PREF_PATH]: null }, 'Forgot the new-folder attributes');
      }

      notify.success(tx('cdCreated', finalPath));
      announce(t('createdMsg', finalPath));
      props.onCreated?.(finalPath);
    } catch (err) {
      notify.error(t('createDirTitle'), tx('cdFailed', err.message));
    }
  }

  return {
    title: t('createDirTitle'),
    width: 560,
    content,
    actions: [
      { label: t('cancel'), kind: 'text' },
      {
        label: t('ok'), kind: 'filled', autofocus: true,
        ref: (btn) => { okButton = btn; updatePreview(); },
        onSelect: () => { create(); close(); },
      },
    ],
  };
});

/** Open the create-directory dialog. */
export function openCreateDirectory(props) { return openDialog('createdirectory', props); }
