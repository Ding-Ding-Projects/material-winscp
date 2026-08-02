// ui/dialogs/messagedlg.js — WinSCP's message dialog (MessageDlg.dfm,
// windows/WinInterface.cpp's MessageDialog / MoreMessageDialog).
//
// One dialog serves every confirmation in the application, which is why it has
// to carry all of the original's machinery rather than being a thin confirm():
//
//   * the button sets (OK, OK/Cancel, Yes/No, Yes/No/Cancel, Abort/Retry/Ignore,
//     Retry/Cancel, Yes-to-all/No-to-all, plus arbitrary custom buttons)
//   * "Never ask me again", bound to a REAL preference so the next call is
//     genuinely suppressed instead of the checkbox being decorative
//   * expandable detail — the long error text, collapsed by default, copyable
//
// Anything that only informs must NOT come through here. `notify.*` is the
// non-blocking path, and this dialog blocks, so it is reserved for a decision
// the user has to make before the caller can continue.

import { h, icon, uid, appearanceTarget, openModal, copyText } from '../../dom.js';
import { t } from '../../i18n.js';
import { notify } from '../notifications.js';
import { registerDialog } from '../../app.js';
import { defineStrings, injectTransferStyles, transferPref, setTransferPref } from '../queue.js';

defineStrings({
  txMsgMore: ['Show details', '睇詳情'],
  txMsgNeverAsk: ['Never ask me this again', '唔好再問我呢樣嘢'],
  txMsgNeverAskNote: ['The answer you pick now is the one that will be used from then on. You can undo it from this dialog or from Preferences.', '你而家揀嘅答案之後會一直用。想改返可以喺呢個對話框或者偏好設定度撤銷。'],
  txMsgCopyDetail: ['Copy the details', '複製詳情'],
  txMsgAbort: ['Abort', '中止'],
  txMsgRetry: ['Retry', '再試'],
  txMsgIgnore: ['Ignore', '唔理'],
  txMsgYesToAll: ['Yes to all', '全部都係'],
  txMsgNoToAll: ['No to all', '全部都唔係'],
  txMsgRemembered: ['Answered "{0}" automatically, because you asked not to be asked again.', '自動答咗「{0}」，因為你話過唔好再問。'],
  txMsgSuppressed: ['"{0}" will be answered automatically from now on.', '由而家開始會自動答「{0}」。'],
  txMsgRememberedTitle: ['This question is already answered', '呢條問題已經有答案'],
  txMsgAskAgain: ['Ask me again next time', '下次再問返我'],
  txMsgAskAgainDone: ['This question will be asked again.', '之後會再問返呢條問題。'],
});

/** Every answer this dialog can produce, and the label key it renders with. */
export const MESSAGE_ANSWERS = {
  ok: 'ok',
  cancel: 'cancel',
  yes: 'yes',
  no: 'no',
  abort: 'txMsgAbort',
  retry: 'txMsgRetry',
  ignore: 'txMsgIgnore',
  skip: 'skip_',
  yesToAll: 'txMsgYesToAll',
  noToAll: 'txMsgNoToAll',
  close: 'close',
};

/**
 * The button sets, in the order WinSCP shows them. The LAST entry of each set
 * is the affirmative one and gets the filled treatment; a set containing
 * `cancel` treats it as the escape answer.
 */
export const BUTTON_SETS = {
  ok: ['ok'],
  okCancel: ['cancel', 'ok'],
  yesNo: ['no', 'yes'],
  yesNoCancel: ['cancel', 'no', 'yes'],
  abortRetryIgnore: ['abort', 'ignore', 'retry'],
  retryCancel: ['cancel', 'retry'],
  yesNoAllCancel: ['cancel', 'noToAll', 'no', 'yesToAll', 'yes'],
  okCancelSkip: ['cancel', 'skip', 'ok'],
  close: ['close'],
};

const KINDS = {
  information: { glyph: 'info', cls: '' },
  confirmation: { glyph: 'help', cls: '' },
  warning: { glyph: 'warning', cls: 'is-warning' },
  error: { glyph: 'error', cls: 'is-error' },
};

/** The buttons a set or a custom list resolves to, affirmative one last. */
export function resolveButtons(options = {}) {
  if (Array.isArray(options.buttons) && options.buttons.length) {
    return options.buttons.map((b, i, all) => ({ primary: i === all.length - 1, ...b }));
  }
  const set = BUTTON_SETS[options.buttons] || BUTTON_SETS.okCancel;
  return set.map((answer, i) => ({
    answer,
    primary: i === set.length - 1,
    danger: !!options.danger && i === set.length - 1,
  }));
}

/**
 * The answer Escape and the scrim produce — `CancelAnswer` (Common.cpp:2550).
 *
 * The ladder is cancel -> no -> abort -> ok, and the last rung matters: a set
 * of `['retry','ok']` escapes as OK, not as Retry. Falling back to the first
 * button instead made Escape RUN the operation on any set that happened to list
 * a positive answer first. `design/main/userinterface.js` is the authority for
 * this rule and serves it over `ui:messageDialog`; the copy here exists because
 * Escape must not wait on a round trip.
 */
export function escapeAnswer(options = {}, buttons = resolveButtons(options)) {
  if (options.cancelAnswer) return options.cancelAnswer;
  for (const answer of ['cancel', 'no', 'abort', 'ok']) {
    if (buttons.some((b) => b.answer === answer)) return answer;
  }
  return buttons[0].answer;
}

/**
 * `DefaultAnswer` (Common.cpp:2588) — Yes, else OK, else Retry. Which button is
 * *primary* is a property of the answer set, not of where the button happens to
 * sit in the list.
 */
export function defaultAnswerFor(options = {}, buttons = resolveButtons(options)) {
  if (options.defaultAnswer) return options.defaultAnswer;
  for (const answer of ['yes', 'ok', 'retry']) {
    if (buttons.some((b) => b.answer === answer)) return answer;
  }
  return buttons[buttons.length - 1].answer;
}

/**
 * `IsPositiveAnswer` (WinInterface.cpp:86). Only these three may be made
 * permanent by the never-ask-again box.
 */
export function isPositiveAnswer(answer) {
  return answer === 'yes' || answer === 'ok' || answer === 'yesToAll';
}

/**
 * A remembered answer for this question, or undefined.
 *
 * A NEGATIVE answer is never restored, even if one is somehow stored: WinSCP's
 * NeverAskAgainCheckClick disables every button but the positive one while the
 * box is ticked, so "no, and never ask again" cannot be produced in the first
 * place. Honouring one here would silently refuse every future occurrence of
 * the question with nothing on screen to say why.
 */
export function rememberedAnswer(options = {}) {
  const pref = options.neverAskPref || '';
  if (!pref) return undefined;
  const stored = transferPref(pref, undefined);
  if (!isPositiveAnswer(stored)) return undefined;
  const buttons = resolveButtons(options);
  return buttons.some((b) => b.answer === stored) ? stored : undefined;
}

/**
 * Build the modal spec. Split out from messageDialog() so the shell's dialog
 * registry can open exactly the same dialog through registerDialog/openDialog.
 * `done(result)` is called exactly once.
 */
function buildSpec(options, done) {
  const kind = KINDS[options.kind] ? options.kind : 'confirmation';
  const meta = KINDS[kind];
  const buttons = resolveButtons(options);
  const pref = options.neverAskPref || '';
  const cancelAnswer = escapeAnswer(options, buttons);
  const primaryAnswer = defaultAnswerFor(options, buttons);

  let settled = false;
  let neverAsk = false;

  const detailBlock = options.detail
    ? h('details', { class: 'tx-md-details' },
      h('summary', {}, t('txMsgMore')),
      h('pre', { class: 'tx-md-detail' }, String(options.detail)),
      h('button', {
        type: 'button', class: 'btn-text',
        onclick: () => copyText(String(options.detail)).then((ok) => ok && notify.success(t('copiedClip'), '')),
      }, icon('content_copy', 15), h('span', {}, t('txMsgCopyDetail'))))
    : null;

  let checkboxRow = null;
  if (options.neverAskAgain && pref) {
    const id = uid('tx-md-never');
    const checkbox = h('input', { type: 'checkbox', id, onchange: () => { neverAsk = checkbox.checked; } });
    checkboxRow = h('div', { class: 'tx-md-never' },
      h('label', { class: 'check', for: id }, checkbox, h('span', {}, t('txMsgNeverAsk'))),
      h('p', { class: 'tx-md-never-note' }, t('txMsgNeverAskNote')));
    appearanceTarget(checkboxRow, 'message-never-ask', 'Never ask again');
  } else if (options.neverAskAgain && !pref) {
    // A checkbox with nowhere to persist would be a decorative control, and a
    // decorative control on a confirmation is worse than no control at all.
    console.warn('[messagedlg] neverAskAgain was requested without neverAskPref; the checkbox is omitted.');
  }

  const body = h('div', { class: 'tx-md' },
    h('span', { class: `tx-md-icon ${meta.cls}` }, icon(meta.glyph, 24)),
    h('div', { class: 'tx-md-main' },
      h('p', { class: 'tx-md-text' }, String(options.message ?? '')),
      options.helpTopic ? h('p', { class: 'tx-md-help muted' }, options.helpTopic) : null,
      detailBlock,
      checkboxRow));

  function finish(answer) {
    if (settled) return;
    settled = true;
    if (neverAsk && pref) {
      // Only a positive answer is ever stored, for the same reason
      // rememberedAnswer refuses to restore anything else.
      if (!isPositiveAnswer(answer)) { done({ answer, neverAskAgain: false, remembered: false }); return; }
      setTransferPref(pref, answer, `Remembered the "${answer}" answer for ${pref}`);
      notify.info(options.title || '', t('txMsgSuppressed', t(MESSAGE_ANSWERS[answer] || answer)));
    }
    done({ answer, neverAskAgain: neverAsk, remembered: false });
  }

  const defaultAnswer = primaryAnswer;

  return {
    title: options.title || t(kind === 'error' ? 'error' : 'ok'),
    width: options.width || 560,
    content: body,
    dismissOnScrim: options.dismissOnScrim !== false,
    onClose: () => finish(cancelAnswer),
    actions: buttons.map((b) => ({
      label: b.label || t(b.labelKey || MESSAGE_ANSWERS[b.answer] || b.answer),
      // The primary button is the DEFAULT answer, not the last in the list.
      kind: b.danger ? 'danger' : (b.answer === defaultAnswer || (b.primary && !buttons.some((x) => x.answer === defaultAnswer))) ? 'filled' : 'text',
      autofocus: b.answer === defaultAnswer,
      onSelect: () => finish(b.answer),
    })),
  };
}

/** The spec shown when the question already has a remembered answer. */
function buildRememberedSpec(options, answer, done) {
  const pref = options.neverAskPref;
  let settled = false;
  const finish = (result) => { if (!settled) { settled = true; done(result); } };
  return {
    title: t('txMsgRememberedTitle'),
    width: 520,
    content: h('div', { class: 'tx-md' },
      h('span', { class: 'tx-md-icon' }, icon('info', 24)),
      h('div', { class: 'tx-md-main' },
        h('p', { class: 'tx-md-text' }, String(options.message ?? '')),
        h('p', { class: 'tx-md-text' }, t('txMsgRemembered', t(MESSAGE_ANSWERS[answer] || answer))))),
    onClose: () => finish({ answer, neverAskAgain: true, remembered: true }),
    actions: [
      {
        label: t('txMsgAskAgain'),
        kind: 'text',
        onSelect: () => {
          setTransferPref(pref, null, `Cleared the remembered answer for ${pref}`)
            .then(() => notify.success(t('txMsgAskAgain'), t('txMsgAskAgainDone')));
          finish({ answer, neverAskAgain: false, remembered: true, cleared: true });
        },
      },
      { label: t('ok'), kind: 'filled', autofocus: true, onSelect: () => finish({ answer, neverAskAgain: true, remembered: true }) },
    ],
  };
}

/**
 * messageDialog(options) -> Promise<{ answer, neverAskAgain, remembered }>
 *
 * options:
 *   title, message, detail, helpTopic
 *   kind             information | confirmation | warning | error
 *   buttons          a BUTTON_SETS key, or [{ answer, labelKey|label, danger }]
 *   defaultAnswer    which button is focused; defaults to the affirmative one
 *   cancelAnswer     what Escape and the scrim resolve to
 *   neverAskAgain    show the checkbox (requires neverAskPref)
 *   neverAskPref     dotted preference the checkbox writes
 *
 * When the preference already holds a remembered answer the promise resolves
 * with it WITHOUT blocking — a toast says so, which is what makes the checkbox
 * real rather than decorative.
 */
export function messageDialog(options = {}) {
  injectTransferStyles();
  injectMessageStyles();

  const remembered = rememberedAnswer(options);
  if (remembered !== undefined) {
    notify.info(options.title || '', t('txMsgRemembered', t(MESSAGE_ANSWERS[remembered] || remembered)));
    return Promise.resolve({ answer: remembered, neverAskAgain: true, remembered: true });
  }
  return new Promise((resolve) => { openModal(buildSpec(options, resolve)); });
}

/** Yes/No, resolved to a boolean. */
export function confirmDialog(message, options = {}) {
  return messageDialog({ kind: 'confirmation', buttons: 'yesNo', message, ...options })
    .then((r) => r.answer === 'yes' || r.answer === 'ok');
}

/** An error the caller must acknowledge before it can continue. */
export function errorDialog(message, detail, options = {}) {
  return messageDialog({ kind: 'error', buttons: 'ok', message, detail, ...options });
}

/**
 * Registered so openDialog('message', props) reaches the same dialog. Pass
 * `props.onAnswer` to receive the result, since the registry route is not a
 * promise.
 */
registerDialog('message', ({ props }) => {
  injectTransferStyles();
  injectMessageStyles();
  const done = (result) => props.onAnswer?.(result);
  const remembered = rememberedAnswer(props);
  return remembered !== undefined
    ? buildRememberedSpec(props, remembered, done)
    : buildSpec(props, done);
});

const MESSAGE_CSS = `
.tx-md-details summary { cursor: default; font-size: var(--type-label-lg); font-weight: 600; color: var(--p); min-height: calc(32px * var(--den)); display: flex; align-items: center; }
.tx-md-details[open] summary { margin-bottom: 6px; }
.tx-md-never { display: flex; flex-direction: column; gap: 2px; margin-top: 4px; padding-top: 8px; border-top: 1px solid var(--outline-var); }
.tx-md-never-note { font-size: var(--type-label-sm); color: var(--onsv); line-height: 1.45; }
.tx-md-help { font-size: var(--type-label-md); line-height: 1.45; }
`;

let injected = false;
function injectMessageStyles() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const el = document.createElement('style');
  el.id = 'sheet-transfer-message';
  el.textContent = MESSAGE_CSS;
  document.head.appendChild(el);
}
