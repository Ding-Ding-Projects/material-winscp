// ui/dialogs/properties.js — forms/Properties.dfm (TPropertiesDialog).
//
// The three sheets WinSCP has — Common, Checksum and Value (S3 object tags) —
// with every control from design/renderer/forms.json wired to something real:
//
//   * the aggregate view of a multi-file selection (counts, total size, the
//     intersection of the permissions, the owner/group only when every file
//     agrees), which is TRemoteProperties::CommonProperties,
//   * "Calculate" for directory sizes, streamed so a big tree reports as it
//     walks instead of freezing the dialog,
//   * the permission frame with recursion, owner and group,
//   * checksums, per file, over whatever algorithm the server can do,
//   * the link target for a symlink,
//   * and an OK button that only lights up when something actually changed,
//     exactly as TPropertiesDialog::UpdateControls decides it.
//
// The aggregate itself is a pure function (`aggregateSelection`) so it can be
// tested headless — test/dialogs-fileops.test.js does exactly that.

import { h, icon, uid, clear, appearanceTarget, announce, copyText, oneLine } from '../../dom.js';
import { t, bindRender } from '../../i18n.js';
import { api } from '../../state.js';
import { registerDialog, openDialog } from '../../app.js';
import { notify } from '../notifications.js';
import { createSearchBar, noMatchMessage } from '../searchbar.js';
import {
  createRightsEditor, fromNumber, looksLikeRights, parseRights, intersect,
  isUndef, equals, RF,
  makeTranslator, ops, createSheets, joinPath, separatorOf,
  formatBytes, formatExactBytes, formatTimestamp, checkRow,
} from './rights.js';

const STRINGS = {
  propsUnknownSize: ['Unknown', '未知'],
  propsCalculate: ['Calculate', '計算'],
  propsCalculating: ['Calculating… {0}', '計算緊… {0}'],
  propsStopCalc: ['Stop', '停'],
  propsPartialSize: [
    'Stopped. This is what had been counted when you stopped, not the whole tree.',
    '停咗。 呢個係你叫停嗰陣已經數到嘅數，唔係成棵樹。',
  ],
  propsFileCount: ['{0} file', '{0} 個檔案'],
  propsFilesCount: ['{0} files', '{0} 個檔案'],
  propsDirCount: ['{0} folder', '{0} 個資料夾'],
  propsDirsCount: ['{0} folders', '{0} 個資料夾'],
  propsSymlinkCount: ['{0} symbolic link', '{0} 個符號連結'],
  propsSymlinksCount: ['{0} symbolic links', '{0} 個符號連結'],
  propsFilesCaption: ['{0}, … properties', '{0}, … 屬性'],
  propsModified: ['Modified', '修改時間'],
  propsAccessed: ['Accessed', '存取時間'],
  propsModifiedRange: ['{0} — {1}', '{0} — {1}'],
  propsChecksumSheet: ['Checksum', '檢查碼'],
  propsCommonSheet: ['Common', '一般'],
  propsValueSheet: ['Value', '數值'],
  propsAlgorithm: ['Algorithm', '演算法'],
  propsCalcChecksum: ['Calculate checksum', '計算檢查碼'],
  propsChecksumUnknown: ['Unknown', '未知'],
  propsChecksumBusy: ['Calculating {0} of {1}…', '計算緊第 {0} 個，共 {1} 個…'],
  propsChecksumUnsupported: ['{0} cannot calculate checksums, so this sheet is read-only.', '{0} 計唔到檢查碼，所以呢版淨係睇得。'],
  propsOwnerUnsupported: ['{0} has no concept of an owner or a group.', '{0} 冇擁有者同群組呢樣嘢。'],
  propsRightsUnsupported: ['{0} does not support changing permissions.', '{0} 唔支援改權限。'],
  propsSearchPh: ['Search these properties', '搵呢啲屬性'],
  propsNothingChanged: ['Nothing was changed.', '乜都冇改到。'],
  propsSaved: [[
    'Properties of {0} item(s) updated.',
    'Updated the properties of {0} item(s).',
    '{0} item(s) freshly re-tagged.',
    '{0} item(s) got a whole new set of paperwork.',
    'Paperwork filed, stamped and sealed — {0} item(s) are officially new and improved!'], [
    '已更新 {0} 個項目嘅屬性。',
    '{0} 個項目嘅屬性更新咗。',
    '{0} 個項目換咗新標籤。',
    '{0} 個項目啱啱換晒新文件。',
    '文件搞掂、蓋咗印、封好——{0} 個項目正式煥然一新！']],
  propsFailed: ['Properties were not changed: {0}', '改唔到屬性：{0}'],
  propsSizeCalculated: ['{0} in {1} file(s) and {2} folder(s).', '{1} 個檔案、{2} 個資料夾，共 {0}。'],
  propsCopyValue: ['Copy value', '複製數值'],
  propsTagKey: ['Key', '鍵'],
  propsTagValue: ['Value', '值'],
  propsTagAdd: ['Add tag…', '加標籤…'],
  propsTagEdit: ['Edit tag…', '改標籤…'],
  propsTagRemove: ['Remove tag', '刪標籤'],
  propsTagDuplicate: ['A tag with the key "{0}" already exists.', '已經有個鍵叫「{0}」嘅標籤。'],
  propsRecursiveHint: [
    'With recursion on, a permission left as "leave as is" stays untouched everywhere in the subtree.',
    '開咗遞迴之後，設成「維持原狀」嘅權限喺成個子樹入面都唔會郁。'],
  propsOnOtherSheet: ['Found on sheet: {0}', '喺呢版搵到：{0}'],
  propsLinkTarget: ['Links to', '連結去'],
};

const tx = makeTranslator(STRINGS);

/* ================================================================== */
/* the aggregate — TRemoteProperties::CommonProperties + LoadInfo      */
/* ================================================================== */

/**
 * Fold a selection into what the dialog can honestly display.
 *
 * Rights intersect (a bit the files disagree about becomes undefined), and
 * the owner and the group survive only while every file reports the same one.
 * `statsNotCalculated` mirrors WinSCP: as soon as one real directory is in the
 * selection the total size is a lie until "Calculate" has run.
 *
 * @param {Array} files entries as the panels carry them
 *        ({ name, type, size, mtime, rights, owner, group, isSymlink, linkTarget })
 */
export function aggregateSelection(files) {
  const list = Array.isArray(files) ? files : [];
  const out = {
    count: list.length,
    multiple: list.length > 1,
    files: 0,
    directories: 0,
    symlinks: 0,
    bytes: 0,
    anyDirectories: false,
    allowCalculateSize: false,
    statsNotCalculated: false,
    rights: null,
    rightsAllowUndef: false,
    rightsKnown: false,
    owner: null,
    group: null,
    ownerKnown: false,
    groupKnown: false,
    linkTarget: '',
    isSymlink: false,
    mtimeFrom: 0,
    mtimeTo: 0,
    name: '',
  };

  list.forEach((file, index) => {
    const isDir = file.type === 'dir';
    if (isDir) {
      out.directories += 1;
      // A symlinked directory is not recursed into, so it does not make the
      // size unknown — the same test TTerminal::CanRecurseToDirectory makes.
      if (!file.isSymlink) {
        out.allowCalculateSize = true;
        out.statsNotCalculated = true;
      }
    } else {
      out.files += 1;
    }
    if (file.isSymlink) out.symlinks += 1;
    out.bytes += Number(file.size) || 0;

    const mtime = Number(file.mtime) || 0;
    if (mtime) {
      out.mtimeFrom = out.mtimeFrom ? Math.min(out.mtimeFrom, mtime) : mtime;
      out.mtimeTo = Math.max(out.mtimeTo, mtime);
    }

    const rights = looksLikeRights(file.rights) ? parseRights(file.rights, { allowUndef: true }) : null;
    const owner = file.owner === undefined || file.owner === null ? '' : String(file.owner);
    const group = file.group === undefined || file.group === null ? '' : String(file.group);

    if (index === 0) {
      if (rights) {
        out.rights = rights;
        out.rightsKnown = true;
        // The C++ only allows undefined bits here when the file itself already
        // has them; the dialog re-decides that once "recursive" is involved.
        out.rightsAllowUndef = isUndef(rights);
      }
      if (owner) { out.owner = owner; out.ownerKnown = true; }
      if (group) { out.group = group; out.groupKnown = true; }
    } else {
      if (out.rightsKnown) {
        if (rights) {
          out.rights = intersect(out.rights, rights, true);
          out.rightsAllowUndef = true;
        } else {
          out.rightsKnown = false;
          out.rights = null;
        }
      }
      if (out.owner !== owner) { out.owner = null; out.ownerKnown = false; }
      if (out.group !== group) { out.group = null; out.groupKnown = false; }
    }
  });

  out.anyDirectories = out.directories > 0;
  if (list.length === 1) {
    const only = list[0];
    out.name = only.name || '';
    out.isSymlink = !!only.isSymlink;
    out.linkTarget = only.linkTarget || '';
  } else if (list.length) {
    out.name = list[0].name || '';
  }
  return out;
}

/** TPropertiesDialog::LoadStats — "2 files, 1 folder (1 symbolic link)". */
export function describeSelection(agg) {
  if (!agg.count) return t('nothingSelected');
  if (!agg.multiple && !agg.statsCalculated) return agg.name;
  let text = '';
  if (agg.files > 0) {
    text = agg.files === 1 ? tx('propsFileCount', agg.files) : tx('propsFilesCount', agg.files);
    if (agg.directories > 0) text += ', ';
  }
  if (agg.directories > 0) {
    text += agg.directories === 1 ? tx('propsDirCount', agg.directories) : tx('propsDirsCount', agg.directories);
  }
  if (agg.symlinks > 0) {
    const links = agg.symlinks === 1
      ? tx('propsSymlinkCount', agg.symlinks)
      : tx('propsSymlinksCount', agg.symlinks);
    text = `${text} (${links})`;
  }
  return text || agg.name;
}

/** The size cell: short form plus the exact byte count when they differ. */
export function describeSize(bytes, unknown) {
  if (unknown) return tx('propsUnknownSize');
  const short = formatBytes(bytes);
  const exact = formatExactBytes(bytes);
  return short === exact ? short : `${short} (${exact})`;
}

const DEFAULT_ALGORITHMS = ['md5', 'sha-1', 'sha-256', 'sha-512'];

/** Tags are editable only when metadata, capability, and a write seam agree. */
export function canEditTags(props = {}) {
  return Array.isArray(props.tags)
    && props.caps?.tags === true
    && typeof props.onApplyTags === 'function';
}

/* ================================================================== */
/* the dialog                                                          */
/* ================================================================== */

registerDialog('properties', ({ props, close }) => {
  const files = Array.isArray(props.files) ? props.files : [];
  const directory = props.directory || '';
  const sep = separatorOf(directory || (files[0] && files[0].path) || '/');
  const local = props.side === 'local' || !props.sessionId;
  const pathOf = (f) => f.path || joinPath(directory, f.name, sep);
  const targets = files.map(pathOf);
  const agg = aggregateSelection(files);
  const protocolName = props.protocolName || (local ? 'The local file system' : 'This protocol');

  // Capabilities decide what is even offered. Anything the backend cannot do is
  // shown disabled with the reason, never offered and then failed.
  // The local side has no chmod, no chown, and neither fs:checksum nor
  // fs:setTimes accepts a session-less call, so those are honestly false here
  // rather than offered and then failed.
  let caps = props.caps || (local
    ? { rights: false, owner: false, checksum: false, timestamp: false, calculateSize: true }
    : {});
  const searchRows = [];
  let rightsEditor = null;
  let ownerInput = null;
  let groupInput = null;
  let recursiveInput = null;
  let modifiedInput = null;
  let sizeValue = null;
  let calcButton = null;
  let okButton = null;
  let sheets = null;
  let statsCalculated = false;
  let rightsTouched = false;
  let calculatedBytes = agg.bytes;
  let calculatedStats = null;
  let cancelCalculation = null;

  const original = {
    rights: agg.rights ? { ...agg.rights } : null,
    owner: agg.owner || '',
    group: agg.group || '',
    mtime: files.length === 1 ? (Number(files[0].mtime) || 0) : 0,
  };
  let current = {
    rights: agg.rights ? { ...agg.rights } : (agg.rightsKnown ? null : fromNumber(RF.default)),
    addX: false,
    owner: original.owner,
    group: original.group,
    recursive: false,
    mtime: original.mtime,
  };

  /* ---------------- rows ---------------- */

  /**
   * Register a row with the sheet search. Every properties surface carries its
   * own search bar (the shared instructions make no exception for a dialog),
   * and a match on another sheet is reported rather than silently hidden.
   */
  function searchable(sheetId, element, label, valueFn) {
    searchRows.push({ sheetId, element, label, value: valueFn || (() => '') });
    return element;
  }

  function readOnlyValue(text, opts = {}) {
    const el = h('div', {
      class: opts.mono ? 'mono' : '',
      tabindex: '0',
      style: {
        minHeight: 'var(--control-h)',
        display: 'flex', alignItems: 'center',
        padding: '0 calc(12px * var(--den))',
        border: '1px solid var(--outline-var)',
        borderRadius: 'var(--shape-xs)',
        background: 'var(--c-low)',
        color: 'var(--onsfc)',
        fontSize: 'var(--type-body-sm)',
        userSelect: 'text',
        wordBreak: 'break-all',
        flex: '1 1 auto',
        minWidth: 0,
      },
    }, text);
    if (opts.title !== false) el.title = String(text || '');
    return el;
  }

  function labelledRow(key, control, opts = {}) {
    const id = control.id || uid('p');
    if (!control.id) control.id = id;
    const labelEl = h('label', {
      class: 'field-label', for: id,
      style: { flex: '0 0 auto', width: 'calc(13ch * var(--uiscale))' },
    });
    bindRender(labelEl, () => { labelEl.textContent = opts.rawLabel || tx(key); });
    const row = h('div', {
      class: 'row',
      style: { alignItems: 'center', gap: 'calc(10px * var(--den))', flexWrap: 'nowrap' },
    }, labelEl, control);
    if (opts.trailing) row.appendChild(opts.trailing);
    return row;
  }

  /* ---------------- common sheet ---------------- */

  const nameValue = readOnlyValue(describeSelection({ ...agg, statsCalculated }));
  const locationValue = readOnlyValue(directory || (files[0] ? pathOf(files[0]) : ''));
  sizeValue = readOnlyValue(describeSize(agg.bytes, agg.statsNotCalculated), { mono: true });

  calcButton = h('button', {
    type: 'button', class: 'btn-text',
    onclick: () => calculateSizes(),
  });
  bindRender(calcButton, () => {
    calcButton.textContent = t('calcSize');
    calcButton.title = t('calcSize');
  });
  calcButton.hidden = !agg.allowCalculateSize;
  appearanceTarget(calcButton, 'props-calculate', 'Calculate directory sizes');

  const commonRows = [];
  commonRows.push(searchable('common', labelledRow('name', nameValue, { rawLabel: t('name') }), t('name'), () => nameValue.textContent));
  commonRows.push(searchable('common', labelledRow('location', locationValue, { rawLabel: t('location') }), t('location'), () => locationValue.textContent));
  commonRows.push(searchable('common', labelledRow('size', sizeValue, { rawLabel: t('sizeLbl'), trailing: calcButton }), t('sizeLbl'), () => sizeValue.textContent));

  // Timestamps. A single file on a backend that can set them gets a real
  // editor; everything else is shown as the fact it is.
  if (files.length === 1 && original.mtime && caps.timestamp) {
    modifiedInput = h('input', {
      type: 'datetime-local', class: 'field-input',
      style: { flex: '1 1 auto', minWidth: 0 },
      oninput: () => {
        const value = modifiedInput.value ? new Date(modifiedInput.value).getTime() : 0;
        current.mtime = Number.isFinite(value) ? value : original.mtime;
        updateOk();
      },
    });
    modifiedInput.value = toLocalInputValue(original.mtime);
    commonRows.push(searchable('common', labelledRow('propsModified', modifiedInput), tx('propsModified'), () => formatTimestamp(current.mtime)));
  } else if (agg.mtimeTo) {
    const text = agg.mtimeFrom === agg.mtimeTo
      ? formatTimestamp(agg.mtimeTo)
      : tx('propsModifiedRange', formatTimestamp(agg.mtimeFrom), formatTimestamp(agg.mtimeTo));
    const value = readOnlyValue(text, { mono: true });
    commonRows.push(searchable('common', labelledRow('propsModified', value), tx('propsModified'), () => text));
  }

  if (files.length === 1 && agg.isSymlink) {
    const linkValue = readOnlyValue(agg.linkTarget || '', { mono: true });
    commonRows.push(searchable('common', labelledRow('linksTo', linkValue, { rawLabel: t('linksTo') }), t('linksTo'), () => linkValue.textContent));
    // The panel may not carry the target; ask the server for it.
    if (!agg.linkTarget && !local && props.sessionId) {
      ops.fs.readlink(props.sessionId, targets[0])
        .then((target) => { if (target) { linkValue.textContent = target; linkValue.title = target; } })
        .catch(() => { /* a link whose target cannot be read stays blank */ });
    }
  }

  // Both hosts are filled by buildRights()/buildOwner(), which run again when
  // the session's capabilities arrive — so they register with the search once,
  // here, and their value is read live from whatever is inside them.
  const rightsHost = h('div', { style: { display: 'flex', flexDirection: 'column', gap: 'calc(6px * var(--den))' } });
  const ownerHost = h('div', { style: { display: 'flex', flexDirection: 'column', gap: 'calc(6px * var(--den))' } });
  searchable('common', rightsHost, t('colRights'), () => (rightsEditor ? rightsEditor.text : ''));
  searchable('common', ownerHost, `${t('ownerRow')} ${t('groupRow')}`,
    () => `${ownerInput ? ownerInput.value : ''} ${groupInput ? groupInput.value : ''}`);

  const recursive = checkRow(h('span', {}, t('recurse')), false, (checked) => {
    current.recursive = checked;
    // One file may only carry undefined bits when the change is recursive —
    // TPropertiesDialog::UpdateControls, and the reason it matters is that a
    // subtree's files each keep the bits the dialog did not name.
    if (rightsEditor) rightsEditor.allowUndef = checked || agg.multiple;
    updateOk();
  });
  recursiveInput = recursive.input;
  bindRender(recursive.element, () => {
    recursive.element.lastChild.textContent = t('recurse');
    recursive.element.title = tx('propsRecursiveHint');
  });

  const commonSheet = h('div', {
    style: { display: 'flex', flexDirection: 'column', gap: 'calc(10px * var(--den))' },
  }, ...commonRows, rightsHost, ownerHost, recursive.element);

  /* ---------------- checksum sheet ---------------- */

  const algorithms = (Array.isArray(props.checksumAlgs) && props.checksumAlgs.length)
    ? props.checksumAlgs.slice()
    : DEFAULT_ALGORITHMS.slice();
  let algorithm = props.checksumAlg && algorithms.includes(props.checksumAlg)
    ? props.checksumAlg
    : algorithms[0];

  const algSelect = h('select', {
    class: 'field-input',
    style: { minWidth: 'calc(16ch * var(--uiscale))', flex: '0 1 auto' },
    onchange: () => { algorithm = algSelect.value; resetChecksums(); },
  }, ...algorithms.map((a) => h('option', { value: a }, a)));
  algSelect.value = algorithm;

  const checksumStatus = h('div', { class: 'muted', style: { fontSize: 'var(--type-label-md)' } });
  const checksumList = h('div', {
    style: {
      display: 'flex', flexDirection: 'column', gap: '2px',
      maxHeight: 'calc(240px * var(--uiscale))', overflow: 'auto',
      border: '1px solid var(--outline-var)', borderRadius: 'var(--shape-sm)',
      padding: '6px', background: 'var(--c-lowest)',
    },
  });

  const checksumButton = h('button', {
    type: 'button', class: 'btn-tonal',
    onclick: () => calculateChecksums(),
  });
  bindRender(checksumButton, () => { checksumButton.textContent = tx('propsCalcChecksum'); });
  appearanceTarget(checksumButton, 'props-checksum', 'Calculate checksum');

  const checksumSheet = h('div', {
    style: { display: 'flex', flexDirection: 'column', gap: 'calc(10px * var(--den))' },
  },
  searchable('checksum', labelledRow('propsAlgorithm', algSelect, { trailing: checksumButton }), tx('propsAlgorithm'), () => algorithm),
  checksumStatus,
  checksumList);

  const checksums = new Map();     // path -> hash
  function resetChecksums() {
    checksums.clear();
    paintChecksums();
  }
  function paintChecksums() {
    clear(checksumList);
    if (!checksums.size) {
      checksumList.appendChild(h('div', { class: 'muted', style: { padding: 'calc(8px * var(--den))', fontSize: 'var(--type-body-sm)' } },
        tx('propsChecksumUnknown')));
      return;
    }
    for (const [path, hash] of checksums) {
      const value = h('span', { class: 'mono ellipsis', style: { flex: '1 1 auto', fontSize: 'var(--type-label-md)' }, title: hash }, hash);
      const copyBtn = h('button', {
        type: 'button', class: 'icon-btn', 'aria-label': tx('propsCopyValue'), title: tx('propsCopyValue'),
        onclick: async () => { if (await copyText(hash)) notify.success(t('copiedClip'), oneLine(hash, 60)); },
      }, icon('content_copy', 15));
      checksumList.appendChild(h('div', {
        style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '2px 4px', minWidth: 0 },
      },
      h('span', { class: 'ellipsis', style: { flex: '0 1 20ch', fontSize: 'var(--type-body-sm)' }, title: path }, path.split(/[\\/]/).pop()),
      value, copyBtn));
    }
  }
  paintChecksums();

  async function calculateChecksums() {
    if (!props.sessionId) {
      notify.warning(tx('propsChecksumSheet'), tx('propsChecksumUnsupported', protocolName));
      return;
    }
    checksumButton.disabled = true;
    resetChecksums();
    let done = 0;
    for (const path of targets) {
      checksumStatus.textContent = tx('propsChecksumBusy', done + 1, targets.length);
      try {
        const hash = await ops.fs.checksum(props.sessionId, path, algorithm);
        checksums.set(path, String(hash || ''));
        paintChecksums();
      } catch (err) {
        checksumStatus.textContent = err.message;
        checksumButton.disabled = false;
        return;
      }
      done += 1;
    }
    checksumStatus.textContent = '';
    checksumButton.disabled = false;
    // Remember the algorithm that worked, as GUIConfiguration->ChecksumAlg does.
    try { await api.configSet({ integration: { checksumAlg: algorithm } }, `Chose the ${algorithm} checksum algorithm`); }
    catch { /* remembering the choice is a convenience, never a failure */ }
  }

  /* ---------------- value (tags) sheet ---------------- */
  // S3 object tags. The sheet exists only when the caller can actually store
  // them; a tab whose OK does nothing would be worse than no tab at all
  // (docs/porting-mandate.md), and no adapter exposes tagging yet.
  const tags = canEditTags(props) ? props.tags.map((x) => ({ ...x })) : null;
  const tagsList = h('div', {
    style: {
      display: 'flex', flexDirection: 'column', gap: '2px',
      minHeight: 'calc(140px * var(--uiscale))', maxHeight: 'calc(260px * var(--uiscale))',
      overflow: 'auto', border: '1px solid var(--outline-var)',
      borderRadius: 'var(--shape-sm)', padding: '6px', background: 'var(--c-lowest)',
    },
    role: 'list',
  });
  let tagIndex = -1;

  function paintTags() {
    clear(tagsList);
    if (!tags || !tags.length) {
      tagsList.appendChild(h('div', { class: 'muted', style: { padding: 'calc(8px * var(--den))' } }, t('none')));
      return;
    }
    tags.forEach((tag, i) => {
      const row = h('div', {
        role: 'listitem', tabindex: '0',
        style: {
          display: 'flex', gap: '10px', alignItems: 'center',
          padding: '4px 6px', borderRadius: 'var(--shape-xs)',
          background: i === tagIndex ? 'var(--secc)' : 'transparent',
          color: i === tagIndex ? 'var(--onsecc)' : 'var(--onsfc)',
          fontSize: 'var(--type-body-sm)',
        },
        onclick: () => { tagIndex = i; paintTags(); },
        ondblclick: () => editTag(i),
      },
      h('span', { class: 'ellipsis', style: { flex: '0 0 14ch', fontWeight: '600' }, title: tag.key }, tag.key),
      h('span', { class: 'ellipsis', style: { flex: '1 1 auto' }, title: tag.value }, tag.value));
      tagsList.appendChild(row);
    });
  }

  function editTag(index) {
    const isAdd = index < 0;
    const keyInput = h('input', { type: 'text', class: 'field-input', 'aria-label': tx('propsTagKey') });
    const valueInput = h('input', { type: 'text', class: 'field-input', 'aria-label': tx('propsTagValue') });
    if (!isAdd) { keyInput.value = tags[index].key; valueInput.value = tags[index].value; }
    openDialog('properties-tag', {
      title: isAdd ? tx('propsTagAdd') : tx('propsTagEdit'),
      keyInput,
      valueInput,
      onOk: () => {
        const key = keyInput.value.trim();
        if (!key) return;
        const clash = tags.findIndex((x, i) => x.key === key && i !== index);
        if (clash >= 0) { notify.warning(tx('propsValueSheet'), tx('propsTagDuplicate', key)); return; }
        if (isAdd) tags.push({ key, value: valueInput.value });
        else tags[index] = { key, value: valueInput.value };
        paintTags();
        updateOk();
      },
    });
  }

  const tagButtons = h('div', { class: 'row' },
    h('button', { type: 'button', class: 'btn-text', onclick: () => editTag(-1) }, tx('propsTagAdd')),
    h('button', { type: 'button', class: 'btn-text', onclick: () => { if (tagIndex >= 0) editTag(tagIndex); } }, tx('propsTagEdit')),
    h('button', { type: 'button', class: 'btn-text', onclick: () => { if (tagIndex >= 0) { tags.splice(tagIndex, 1); tagIndex = -1; paintTags(); updateOk(); } } }, tx('propsTagRemove')));

  const tagsSheet = h('div', { style: { display: 'flex', flexDirection: 'column', gap: 'calc(10px * var(--den))' } },
    tagsList, tagButtons);
  paintTags();

  /* ---------------- search over the sheets ---------------- */

  const search = createSearchBar({
    id: 'properties-dialog',
    persist: false,
    compact: true,
    labelKey: 'search',
    placeholder: tx('propsSearchPh'),
    sampleProvider: () => searchRows.map((r) => `${r.label} ${r.value()}`).join('\n'),
    onChange: applySearch,
  });

  const searchNote = h('div', {
    class: 'muted',
    style: { fontSize: 'var(--type-label-sm)', minHeight: '1.4em' },
  });

  function applySearch() {
    if (!sheets) return;                 // fires once while the strip is built
    const active = !!search.isActive;
    const predicate = search.predicate;
    const elsewhere = new Set();
    let visible = 0;
    for (const row of searchRows) {
      const hay = `${row.label} ${row.value()}`;
      const match = !active || (predicate.ok && predicate.test(hay));
      row.element.hidden = active && !match;
      if (!active || match) {
        visible += 1;
        if (row.sheetId !== sheets.active) elsewhere.add(row.sheetId);
      }
    }
    if (!active) { searchNote.textContent = ''; return; }
    if (!predicate.ok) { searchNote.textContent = t('invalidPattern', predicate.error); return; }
    const others = Array.from(elsewhere).map((id) => sheets.labelOf(id));
    if (others.length) searchNote.textContent = tx('propsOnOtherSheet', others.join(', '));
    else if (!visible) searchNote.textContent = noMatchMessage(predicate, t('properties'));
    else searchNote.textContent = '';
  }

  /* ---------------- size calculation ---------------- */

  async function calculateSizes() {
    if (cancelCalculation) { cancelCalculation(); return; }
    const dirs = files.filter((f) => f.type === 'dir' && !f.isSymlink).map(pathOf);
    const otherBytes = files.filter((f) => !(f.type === 'dir' && !f.isSymlink))
      .reduce((sum, f) => sum + (Number(f.size) || 0), 0);
    if (!dirs.length) return;

    // The button becomes Stop for the duration. Disabling it, as this used to,
    // made the `if (cancelCalculation)` branch above unreachable and left the
    // dialog frozen on a deep tree with no way out.
    let stopped = false;
    cancelCalculation = () => { stopped = true; };
    calcButton.textContent = tx('propsStopCalc');
    calcButton.title = tx('propsStopCalc');

    const report = (bytes, stats) => {
      sizeValue.textContent = describeSize(otherBytes + bytes, false);
      if (stats) {
        nameValue.textContent = tx('propsSizeCalculated',
          formatBytes(otherBytes + bytes), stats.files + agg.files, stats.dirs + agg.directories);
      }
    };

    try {
      if (props.sessionId) {
        const cid = uid('calc');
        let lastBytes = 0;
        let lastStats = null;
        const off = ops.onProgress((payload) => {
          if (!payload || payload.correlationId !== cid) return;
          lastBytes = Number(payload.bytes) || 0;
          lastStats = payload;
          report(lastBytes, payload);
        });
        try {
          const total = await ops.fs.calculateSize(props.sessionId, dirs, cid);
          if (stopped) {
            // main has no cancel channel for fs:calculateSize, so the walk on
            // the server runs to completion either way. What Stop can honestly
            // do is stop claiming the number: the dialog keeps the last figure
            // it actually reported and says it is partial, rather than pretending
            // the user's Stop reached the server.
            calculatedBytes = otherBytes + lastBytes;
            calculatedStats = lastStats;
          } else {
            calculatedBytes = otherBytes + (Number(total.bytes) || 0);
            calculatedStats = total;
          }
        } finally { off(); }
      } else {
        // The local side has no calculateSize channel, so the walk happens here
        // — bounded by the same cancel the button offers.
        let bytes = 0; let fileCount = 0; let dirCount = 0;
        const stack = dirs.slice();
        while (stack.length && !stopped) {
          const dir = stack.pop();
          let listing = null;
          try { listing = await ops.fs.localList(dir, {}); } catch { continue; }
          for (const e of (listing.entries || [])) {
            if (e.name === '..' || e.name === '.') continue;
            if (e.type === 'dir') { dirCount += 1; stack.push(joinPath(dir, e.name, sep)); }
            else { fileCount += 1; bytes += Number(e.size) || 0; }
          }
          report(bytes, { files: fileCount, dirs: dirCount });
        }
        calculatedBytes = otherBytes + bytes;
        calculatedStats = { bytes, files: fileCount, dirs: dirCount };
      }
      statsCalculated = true;
      sizeValue.textContent = describeSize(calculatedBytes, false);
      if (calculatedStats) {
        nameValue.textContent = tx('propsSizeCalculated',
          formatBytes(calculatedBytes),
          (calculatedStats.files || 0) + agg.files,
          (calculatedStats.dirs || 0) + agg.directories);
      }
      if (stopped) sizeValue.title = tx('propsPartialSize');
      announce(`${t('sizeLbl')}: ${sizeValue.textContent}${stopped ? ` — ${tx('propsPartialSize')}` : ''}`);
    } catch (err) {
      notify.error(t('calcSize'), err.message);
      sizeValue.textContent = describeSize(agg.bytes, agg.statsNotCalculated);
    } finally {
      cancelCalculation = null;
      calcButton.textContent = t('calcSize');
      calcButton.title = t('calcSize');
    }
  }

  /* ---------------- capability-driven build ---------------- */

  function buildRights() {
    clear(rightsHost);
    if (caps.rights === false) {
      rightsEditor = null;
      rightsHost.appendChild(h('p', { class: 'prose muted', style: { fontSize: 'var(--type-label-md)' } },
        tx('propsRightsUnsupported', protocolName)));
      return;
    }
    const initial = current.rights || (agg.rights ? { ...agg.rights } : fromNumber(RF.default));
    rightsEditor = createRightsEditor({
      rights: initial,
      allowUndef: agg.multiple || agg.rightsAllowUndef,
      allowAddXToDirectories: agg.anyDirectories,
      onChange: (rights, addX) => {
        current.rights = rights;
        current.addX = addX;
        rightsTouched = true;
        updateOk();
      },
    });
    current.rights = rightsEditor.rights;
    const label = h('div', { class: 'field-label' });
    bindRender(label, () => { label.textContent = t('colRights'); });
    rightsHost.append(label, rightsEditor.element);
  }

  function buildOwner() {
    clear(ownerHost);
    if (caps.owner === false) {
      ownerInput = null;
      groupInput = null;
      ownerHost.appendChild(h('p', { class: 'prose muted', style: { fontSize: 'var(--type-label-md)' } },
        tx('propsOwnerUnsupported', protocolName)));
      return;
    }
    const ownerListId = uid('owners');
    const groupListId = uid('groups');
    ownerInput = h('input', {
      type: 'text', class: 'field-input', list: ownerListId, autocomplete: 'off',
      style: { flex: '1 1 auto', minWidth: 0 },
      oninput: () => { current.owner = ownerInput.value; updateOk(); },
    });
    groupInput = h('input', {
      type: 'text', class: 'field-input', list: groupListId, autocomplete: 'off',
      style: { flex: '1 1 auto', minWidth: 0 },
      oninput: () => { current.group = groupInput.value; updateOk(); },
    });
    ownerInput.value = agg.ownerKnown ? agg.owner : '';
    groupInput.value = agg.groupKnown ? agg.group : '';
    ownerInput.placeholder = agg.ownerKnown ? '' : t('none');
    groupInput.placeholder = agg.groupKnown ? '' : t('none');

    const owners = h('datalist', { id: ownerListId },
      ...((props.users || []).map((u) => h('option', { value: String(u) }))));
    const groups = h('datalist', { id: groupListId },
      ...((props.groups || []).map((g) => h('option', { value: String(g) }))));

    const ownerRow = labelledRow('ownerRow', ownerInput, { rawLabel: t('ownerRow') });
    const groupRow = labelledRow('groupRow', groupInput, { rawLabel: t('groupRow') });
    ownerHost.append(ownerRow, groupRow, owners, groups);
  }

  function buildCapabilityDependent() {
    buildRights();
    buildOwner();
    // Recursion only makes sense when something recursive can be changed.
    recursive.element.hidden = !agg.anyDirectories
      || (caps.rights === false && caps.owner === false);
    if (rightsEditor && (agg.multiple || current.recursive)) rightsEditor.allowUndef = true;
    checksumButton.disabled = caps.checksum === false || !props.sessionId;
    checksumStatus.textContent = caps.checksum === false
      ? tx('propsChecksumUnsupported', protocolName)
      : '';
    updateOk();
  }

  /* ---------------- OK gating ---------------- */

  /** TRemoteProperties::ChangedProperties — what an OK would actually write. */
  function changedProperties() {
    const changes = { rights: false, owner: false, group: false, mtime: false, tags: false };
    if (rightsEditor) {
      const next = rightsEditor.rights;
      // With no permissions to compare against (a backend that reports none)
      // only a deliberate edge counts, so opening and closing writes nothing.
      changes.rights = current.recursive
        || rightsEditor.addXToDirectories
        || (original.rights ? !equals(original.rights, next, true) : rightsTouched);
    }
    if (ownerInput) changes.owner = ownerInput.value.trim() !== original.owner;
    if (groupInput) changes.group = groupInput.value.trim() !== original.group;
    if (modifiedInput) changes.mtime = current.mtime !== original.mtime;
    if (tags) changes.tags = JSON.stringify(tags) !== JSON.stringify(props.tags || []);
    return changes;
  }

  function anythingChanged() {
    const c = changedProperties();
    return c.rights || c.owner || c.group || c.mtime || c.tags
      || (current.recursive && (!!rightsEditor || !!ownerInput));
  }

  function updateOk() {
    if (okButton) okButton.disabled = !files.length || !anythingChanged();
  }

  /* ---------------- apply ---------------- */

  async function apply() {
    const changes = changedProperties();
    const applied = [];
    try {
      if (changes.rights && rightsEditor) {
        const mode = rightsEditor.chmodString(agg.anyDirectories);
        await ops.fs.setRights(props.sessionId, targets, mode, {
          recursive: current.recursive,
          addXToDirectories: rightsEditor.addXToDirectories,
        });
        applied.push(`${t('colRights')} ${rightsEditor.text}`);
      }
      if ((changes.owner || changes.group) && (ownerInput || groupInput)) {
        await ops.fs.setOwner(
          props.sessionId, targets,
          ownerInput ? ownerInput.value.trim() : '',
          groupInput ? groupInput.value.trim() : '',
          { recursive: current.recursive },
        );
        applied.push(`${t('ownerRow')}/${t('groupRow')}`);
      }
      if (changes.mtime && files.length === 1) {
        await ops.fs.setTimes(props.sessionId, targets[0], current.mtime, current.mtime);
        applied.push(tx('propsModified'));
      }
      if (changes.tags && typeof props.onApplyTags === 'function') {
        await props.onApplyTags(tags);
        applied.push(tx('propsValueSheet'));
      }
      if (!applied.length) { notify.info(t('properties'), tx('propsNothingChanged')); return; }
      notify.success(tx('propsSaved', targets.length), applied.join(' · '));
      props.onApplied?.({
        rights: rightsEditor ? rightsEditor.rights : null,
        mode: rightsEditor ? rightsEditor.chmodString(agg.anyDirectories) : '',
        owner: ownerInput ? ownerInput.value.trim() : '',
        group: groupInput ? groupInput.value.trim() : '',
        recursive: current.recursive,
        tags,
      });
    } catch (err) {
      notify.error(t('properties'), tx('propsFailed', err.message));
    }
  }

  /* ---------------- assemble ---------------- */

  sheets = createSheets([
    { id: 'common', label: tx('propsCommonSheet'), content: commonSheet },
    { id: 'checksum', label: tx('propsChecksumSheet'), content: checksumSheet },
    { id: 'tags', label: tx('propsValueSheet'), content: tagsSheet },
  ], { id: 'properties', label: t('properties'), onSelect: () => applySearch() });
  sheets.setVisible('tags', !!tags && files.length === 1 && !agg.anyDirectories);

  const content = h('div', { class: 'stack', style: { gap: 'calc(10px * var(--den))' } },
    h('div', { class: 'row' }, search.element),
    searchNote,
    sheets.element);
  appearanceTarget(content, 'props-dialog', 'Properties dialog');

  buildCapabilityDependent();

  // Capabilities the caller did not supply come from the session itself, and
  // the dialog rebuilds the moment they land rather than guessing.
  if (!props.caps && props.sessionId) {
    ops.session.info(props.sessionId)
      .then((info) => { if (info && info.caps) { caps = info.caps; buildCapabilityDependent(); } })
      .catch(() => { /* an unreachable session leaves the conservative build */ });
  }

  const title = files.length === 1
    ? t('propsTitle', files[0].name)
    : tx('propsFilesCaption', files[0] ? files[0].name : '');

  return {
    title,
    width: 640,
    content,
    actions: [
      { label: t('cancel'), kind: 'text' },
      {
        label: t('ok'), kind: 'filled', autofocus: true,
        ref: (btn) => { okButton = btn; updateOk(); },
        onSelect: () => { apply(); close(); },
      },
    ],
  };
});

/** The tiny key/value prompt the Value sheet uses. */
registerDialog('properties-tag', ({ props }) => ({
  title: props.title,
  width: 420,
  content: h('div', { class: 'stack' },
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, tx('propsTagKey')), props.keyInput),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, tx('propsTagValue')), props.valueInput)),
  actions: [
    { label: t('cancel'), kind: 'text' },
    { label: t('ok'), kind: 'filled', autofocus: true, onSelect: () => props.onOk() },
  ],
}));

/** epoch ms -> the value an <input type="datetime-local"> expects (local time). */
function toLocalInputValue(ms) {
  const d = new Date(Number(ms) || 0);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Open the properties dialog for a selection. */
export function openProperties(props) { return openDialog('properties', props); }
