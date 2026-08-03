// userinterface.js — how the application talks to the user.
//
// Sources ported here:
//   windows/WinInterface.cpp   the message-dialog contract: which buttons a
//                              question gets, which one is default, which one
//                              answers a closed window, the "never ask again"
//                              check and what it turns an answer into, the
//                              query timeout, the busy cursor, minimize/
//                              restore and the interface start/finish hooks
//   windows/UserInterface.cpp  the exception-to-dialog mapping, the fatal
//                              "reconnect" query, the taskbar flash rule,
//                              CheckSafe/CheckLogParam/CheckXmlLogParam
//   windows/WinMain.cpp        the startup and shutdown sequence: which mode
//                              the command line selects, in what order the
//                              interface comes up and comes down
//   windows/VCLCommon.cpp      only the portable parts: accessible names from
//                              labels, the dialog sizing rules, the path word
//                              break, the small validation/state helpers
//   forms/MessageDlg.cpp       button captions, button order, default/cancel
//                              selection, alias grouping
//   forms/Progress.cpp         the progress-window contract: the delayed
//                              popup, the cancel refusal, cancel escalation
//   core/Exceptions.cpp        which exceptions are shown at all, which are
//                              "internal" and get a Report button
//   core/Common.cpp            CancelAnswer / AbortAnswer / ContinueAnswer
//
// This module is deliberately pure: it decides, it does not draw. Every
// function here answers a question the UI is about to ask ("which buttons?",
// "what does the X button mean?", "may this question offer never-ask-again?",
// "what does a timeout answer?") and the renderer renders the result. That is
// what makes the refusals testable, and the refusals are the point: a port
// that proceeds where WinSCP asked first is a data-loss bug.
//
// DELIBERATELY NOT PORTED from VCLCommon.cpp (VCL/Win32 with no meaning here):
//   - TFormCustomizationComponent, ChangeControlScale, ChangeFormPixelsPerInch,
//     the WM_DPICHANGED plumbing: the renderer is CSS and scales itself.
//   - ApplyDarkModeOnControl / UseDarkMode / TBXSetTheme: theme.js owns theming
//     through Material 3 tokens; there is no per-HWND brush to repaint.
//   - ReadOnlyControl / DoReadOnlyControl / the edit subclassing WindowProcs,
//     FixComboBoxResizeBug, FocusableLabel*, HintLabel, LinkLabel: these fix
//     VCL control bugs that do not exist in the DOM.
//   - InstallPathWordBreakProc's subclassing — the *algorithm* IS ported below
//     as pathWordBreak(); only the EM_SETWORDBREAKPROC hook is dropped.
//   - SetAccessibleName/SetAccessibleRole's IAccPropServices calls: the DOM
//     equivalent is aria-label / role, so accessibleNamesFrom() computes the
//     NAMES and the renderer sets the attributes.
//   - FixFormIcons, UseDesktopFont, ShowFormNoActivate, HookFormActivation,
//     CountClicksForWindowPrint (the hidden screenshot debug gesture).
//   - TTrayIcon (WinInterface.cpp): Electron owns the tray.
//   - TCallstackThread / JclDebug stack capture: Node gives us Error.stack, so
//     formatStackTrace() below normalises that instead.
'use strict';

const {
  extractMainInstructions, mainInstructions, unformatMessage,
} = require('./common');

// ===========================================================================
// Answers — Interface.h:64. The VALUES matter: the button order on a dialog is
// the numeric order of the answer bits, so these cannot be renumbered.
// ===========================================================================

const ANSWER = Object.freeze({
  yes: 0x00000001,
  no: 0x00000004,
  ok: 0x00000008,
  cancel: 0x00000010,
  yesToAll: 0x00000020,
  noToAll: 0x00000040,
  abort: 0x00000080,
  retry: 0x00000100,
  ignore: 0x00000200,
  skip: 0x00000400,
  all: 0x00000800,
  help: 0x00001000,
  report: 0x00002000,
});

const ANSWER_FIRST = ANSWER.yes;
const ANSWER_LAST = ANSWER.report;

/**
 * qaNeverAskAgain. Not a button — no dialog ever shows one. It is what
 * ExecuteMessageDialog *returns instead of* the positive answer when the
 * check box was ticked, so every caller that offers the check box has to
 * handle it, and a caller that forgets silently loses the user's "never".
 */
const NEVER_ASK_AGAIN = 0x00010000;

/** Bit -> the string name terminal.js and the IPC layer speak. */
const ANSWER_NAME = Object.freeze({
  [ANSWER.yes]: 'yes',
  [ANSWER.no]: 'no',
  [ANSWER.ok]: 'ok',
  [ANSWER.cancel]: 'cancel',
  [ANSWER.yesToAll]: 'yesToAll',
  [ANSWER.noToAll]: 'noToAll',
  [ANSWER.abort]: 'abort',
  [ANSWER.retry]: 'retry',
  [ANSWER.ignore]: 'ignore',
  [ANSWER.skip]: 'skip',
  [ANSWER.all]: 'all',
  [ANSWER.help]: 'help',
  [ANSWER.report]: 'report',
  [NEVER_ASK_AGAIN]: 'neverAskAgain',
});

const NAME_ANSWER = Object.freeze(Object.fromEntries(
  Object.entries(ANSWER_NAME).map(([bit, name]) => [name, Number(bit)])));

/** TQueryType — Interface.h:112. */
const QUERY_TYPE = Object.freeze({
  confirmation: 'confirmation',
  warning: 'warning',
  error: 'error',
  information: 'information',
});

/** mpXxx — WinInterface.h:26. */
const MP = Object.freeze({
  neverAskAgainCheck: 0x01,
  allowContinueOnError: 0x02,
});

/** qpXxx — Interface.h:84. The core-side spelling of the same two flags. */
const QP = Object.freeze({
  fatalAbort: 0x01,
  neverAskAgainCheck: 0x02,
  allowContinueOnError: 0x04,
  ignoreAbort: 0x08,
  waitInBatch: 0x10,
});

/** HELP_INTERNAL_ERROR — the one keyword that turns a dialog into a report. */
const HELP_INTERNAL_ERROR = 'internal_error';
const HELP_NONE = '';

class UserInterfaceError extends Error {
  constructor(message) { super(message); this.name = 'UserInterfaceError'; }
}

/**
 * StripHotkey (Vcl.Menus). '&' marks the accelerator and disappears; '&&' is a
 * literal ampersand. Our buttons carry the letter as an accessKey instead of a
 * underlined glyph, so every caption is stored stripped and the letter kept.
 */
function stripHotkey(caption) {
  const s = String(caption == null ? '' : caption);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '&') {
      if (s[i + 1] === '&') { out += '&'; i++; }
      continue;
    }
    out += s[i];
  }
  return out;
}

/** The accelerator letter a caption declares, or '' when it declares none. */
function hotkeyOf(caption) {
  const s = String(caption == null ? '' : caption);
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '&') continue;
    if (s[i + 1] === '&') { i++; continue; }
    return s[i + 1] || '';
  }
  return '';
}

/**
 * AnswerNameAndCaption — MessageDlg.cpp:709. Note the two captions WinSCP
 * writes itself rather than taking from the VCL: "A&ll" and "Yes to A&ll",
 * because the VCL's own accelerators collide with "&Abort" on a dialog that
 * offers both. An answer with no caption is a programming error, and the
 * original throws rather than rendering a blank button.
 */
function answerNameAndCaption(answer) {
  switch (answer) {
    case ANSWER.yes: return { name: 'Yes', caption: '&Yes' };
    case ANSWER.no: return { name: 'No', caption: '&No' };
    case ANSWER.ok: return { name: 'OK', caption: 'OK' };
    case ANSWER.cancel: return { name: 'Cancel', caption: 'Cancel' };
    case ANSWER.abort: return { name: 'Abort', caption: '&Abort' };
    case ANSWER.retry: return { name: 'Retry', caption: '&Retry' };
    case ANSWER.ignore: return { name: 'Ignore', caption: '&Ignore' };
    case ANSWER.all: return { name: 'All', caption: 'A&ll' };
    case ANSWER.noToAll: return { name: 'NoToAll', caption: 'N&o to All' };
    case ANSWER.yesToAll: return { name: 'YesToAll', caption: 'Yes to A&ll' };
    case ANSWER.help: return { name: 'Help', caption: '&Help' };
    case ANSWER.skip: return { name: 'Skip', caption: '&Skip' };
    case ANSWER.report: return { name: 'Report', caption: 'Re&port' };
    default: throw new UserInterfaceError('Undefined answer');
  }
}

/** The answers present in a set, in the order the buttons appear. */
function answerList(answers) {
  const out = [];
  for (let a = ANSWER_FIRST; a <= ANSWER_LAST; a <<= 1) {
    if ((answers & a) !== 0) out.push(a);
  }
  return out;
}

function answerName(answer) {
  return ANSWER_NAME[answer] || '';
}

function answerBit(name) {
  const bit = NAME_ANSWER[name];
  if (bit === undefined) throw new UserInterfaceError(`Undefined answer '${name}'`);
  return bit;
}

/** Accepts a bit mask, an array of bits, or an array of names. */
function toAnswerMask(answers) {
  if (typeof answers === 'number') return answers;
  if (!Array.isArray(answers)) throw new UserInterfaceError('Answers must be a mask or a list');
  let mask = 0;
  for (const a of answers) mask |= (typeof a === 'number' ? a : answerBit(a));
  return mask;
}

/**
 * CancelAnswer (Common.cpp:2550). THE most important function in this file:
 * closing a dialog with the window X, or Windows logging the user off, does
 * not produce an answer, and WinSCP has to turn "no answer" into one. Note the
 * last resort — a dialog that only offers OK answers OK when it is dismissed.
 * There is no way to decline an OK-only question, and pretending otherwise
 * would leave the caller waiting forever.
 */
function cancelAnswer(answers) {
  const mask = toAnswerMask(answers);
  if ((mask & ANSWER.cancel) !== 0) return ANSWER.cancel;
  if ((mask & ANSWER.no) !== 0) return ANSWER.no;
  if ((mask & ANSWER.abort) !== 0) return ANSWER.abort;
  if ((mask & ANSWER.ok) !== 0) return ANSWER.ok;
  // DebugFail() in the original: a question with none of these is malformed.
  return ANSWER.cancel;
}

/** AbortAnswer (Common.cpp:2577). */
function abortAnswer(answers) {
  const mask = toAnswerMask(answers);
  if ((mask & ANSWER.abort) !== 0) return ANSWER.abort;
  return cancelAnswer(mask);
}

/**
 * ContinueAnswer (Common.cpp:2591). "Carry on past this error" — skip beats
 * ignore beats yes beats ok beats retry, and when the question offers none of
 * them, continuing means cancelling.
 */
function continueAnswer(answers) {
  const mask = toAnswerMask(answers);
  if ((mask & ANSWER.skip) !== 0) return ANSWER.skip;
  if ((mask & ANSWER.ignore) !== 0) return ANSWER.ignore;
  if ((mask & ANSWER.yes) !== 0) return ANSWER.yes;
  if ((mask & ANSWER.ok) !== 0) return ANSWER.ok;
  if ((mask & ANSWER.retry) !== 0) return ANSWER.retry;
  return cancelAnswer(mask);
}

/**
 * The default button — MessageDlg.cpp:806. Yes wins over OK even when both are
 * present (the host-key prompt has both, with OK grouped under Yes). When the
 * question offers neither, Retry is default; when it offers none of the three
 * there IS no default button, and pressing Enter does nothing.
 */
function defaultAnswer(answers) {
  const mask = toAnswerMask(answers);
  if ((mask & ANSWER.yes) !== 0) return ANSWER.yes;
  if ((mask & ANSWER.ok) !== 0) return ANSWER.ok;
  return ANSWER.retry;
}

/** IsPositiveAnswer — WinInterface.cpp:86. */
function isPositiveAnswer(answer) {
  return (answer === ANSWER.yes) || (answer === ANSWER.ok) || (answer === ANSWER.yesToAll);
}

function isInternalErrorHelpKeyword(helpKeyword) {
  return String(helpKeyword || '') === HELP_INTERNAL_ERROR;
}

/**
 * MergeHelpKeyword (Common.cpp). A specific keyword wins over a generic one,
 * except that the internal-error keyword never gets overwritten — an internal
 * error must keep its Report button no matter what wrapped it.
 */
function mergeHelpKeyword(primary, secondary) {
  const p = String(primary || '');
  const s = String(secondary || '');
  if (p !== '' && !isInternalErrorHelpKeyword(s)) return p;
  return s;
}

// ===========================================================================
// Message parameters — TMessageParams, WinInterface.h:65
// ===========================================================================

/**
 * TMessageParams::Reset (WinInterface.cpp:63) is the list of defaults, and two
 * of them decide behaviour rather than looks:
 *   allowHelp = true   -> every dialog gets a Help button unless asked not to
 *   timerQueryType = -1 -> "no override", which is why it is null here and not
 *                          a query type: 0 would silently mean "confirmation".
 */
class MessageParams {
  constructor(init) {
    const o = (typeof init === 'number') ? { params: init } : (init || {});
    this.params = o.params || 0;
    this.aliases = o.aliases ? o.aliases.slice() : [];
    this.timer = o.timer || 0;
    this.timerEvent = o.timerEvent || null;
    this.timerMessage = o.timerMessage || '';
    this.timerAnswers = o.timerAnswers || 0;
    this.timerQueryType = (o.timerQueryType === undefined) ? null : o.timerQueryType;
    this.timeout = o.timeout || 0;
    this.timeoutAnswer = o.timeoutAnswer || 0;
    this.timeoutResponse = o.timeoutResponse || 0;
    this.neverAskAgainTitle = o.neverAskAgainTitle || '';
    this.neverAskAgainAnswer = o.neverAskAgainAnswer || 0;
    this.neverAskAgainCheckedInitially = !!o.neverAskAgainCheckedInitially;
    this.allowHelp = (o.allowHelp === undefined) ? true : !!o.allowHelp;
    this.imageName = o.imageName || '';
    this.moreMessagesUrl = o.moreMessagesUrl || '';
    this.moreMessagesSize = o.moreMessagesSize || null;
    this.customCaption = o.customCaption || '';
  }

  /**
   * TMessageParams(const TQueryParams *) — WinInterface.cpp:35. Only these
   * fields cross over: the core layer knows about timers, timeouts and aliases,
   * and about exactly two of the flags. Everything else (the never-ask-again
   * TITLE, the custom caption, the image) is a windows-layer decision, so a
   * core query cannot smuggle one in.
   */
  static fromQueryParams(queryParams) {
    const p = new MessageParams();
    if (!queryParams) return p;
    const q = queryParams;
    p.aliases = q.aliases ? q.aliases.slice() : [];
    p.timer = q.timer || 0;
    p.timerEvent = q.timerEvent || null;
    p.timerMessage = q.timerMessage || '';
    p.timerAnswers = q.timerAnswers || 0;
    p.timerQueryType = (q.timerQueryType === undefined) ? null : q.timerQueryType;
    p.timeout = q.timeout || 0;
    p.timeoutAnswer = q.timeoutAnswer || 0;
    p.timeoutResponse = q.timeoutResponse || 0;
    const flags = q.params || 0;
    if ((flags & QP.neverAskAgainCheck) !== 0) p.params |= MP.neverAskAgainCheck;
    if ((flags & QP.allowContinueOnError) !== 0) p.params |= MP.allowContinueOnError;
    return p;
  }

  get hasNeverAskAgain() {
    return (this.params & MP.neverAskAgainCheck) !== 0;
  }

  clone() {
    const p = new MessageParams(this);
    p.aliases = this.aliases.slice();
    return p;
  }
}

const NEVER_ASK_AGAIN_CAPTION = 'Never ask me a&gain';
const NEVER_SHOW_AGAIN_CAPTION = 'Never show this message a&gain';

/**
 * WinInterface.cpp:202. The wording flips on the ANSWER SET, not on the
 * question: a dialog that only says OK is not asking anything, so its check
 * box says "never show" rather than "never ask". qaOK|qaIgnore counts as the
 * same case — that combination is how WinSCP adds a custom "non-answer" button
 * (e.g. "Open" on the transfer-finished notice) to an otherwise OK-only box.
 */
function neverAskAgainCaption(actualAnswers, title) {
  if (title) return title;
  const onlyOk = (actualAnswers === ANSWER.ok) ||
    (actualAnswers === (ANSWER.ok | ANSWER.ignore));
  return onlyOk ? NEVER_SHOW_AGAIN_CAPTION : NEVER_ASK_AGAIN_CAPTION;
}

/**
 * The verified catalogue of questions that may offer "never ask again", built
 * from every qpNeverAskAgainCheck / mpNeverAskAgainCheck call site in the
 * vendored source. `setting` is what ticking the box actually changes — and
 * note that three of these do NOT suppress the question:
 *   addBookmark        stores a preference (shared vs. private bookmarks) and
 *                      starts CHECKED when that preference is already on;
 *   tooManyWatchDirs   raises the limit instead of hiding the warning;
 *   sessionDisconnect  and inactiveTermination pick a reconnect policy.
 * A question not listed here must not render the check box: an unlisted
 * "never" has nowhere to be stored, so it would silently do nothing.
 */
const NEVER_ASK_AGAIN_QUESTIONS = Object.freeze({
  fileOverwrite: { setting: 'confirmOverwriting', suppresses: true, source: 'core/Terminal.cpp:4964' },
  directoryOverwrite: { setting: 'confirmOverwriting', suppresses: true, source: 'core/ScpFileSystem.cpp:1754' },
  resumeTransfer: { setting: 'confirmResume', suppresses: true, source: 'core/SftpFileSystem.cpp:4582' },
  deleteFiles: { setting: 'confirmDeleting', suppresses: true, source: 'forms/CustomScpExplorer.cpp:2988' },
  recycleFiles: { setting: 'confirmRecycling', suppresses: true, source: 'forms/CustomScpExplorer.cpp:2988' },
  closeSession: { setting: 'confirmClosingSession', suppresses: true, source: 'forms/CustomScpExplorer.cpp:5588' },
  exitOnCompletion: { setting: 'confirmExitOnCompletion', suppresses: true, source: 'windows/UserInterface.cpp:233' },
  commandSession: { setting: 'confirmCommandSession', suppresses: true, source: 'forms/CustomScpExplorer.cpp:7244' },
  remoteCopyCommandSession: { setting: 'confirmCommandSession', suppresses: true, source: 'forms/RemoteTransfer.cpp:168' },
  synchronizeSummary: { setting: 'synchronizeSummary', suppresses: true, source: 'forms/CustomScpExplorer.cpp:6466' },
  synchronizeBeforeKeepUpToDate: { setting: 'synchronizeBeforeKeepUpToDate', suppresses: true, source: 'forms/Synchronize.cpp:443' },
  ddLackOfTempSpace: { setting: 'ddWarnLackOfTempSpace', suppresses: true, source: 'forms/CustomScpExplorer.cpp:7113' },
  temporaryDirectoryCleanup: { setting: 'confirmTemporaryDirectoryCleanup', suppresses: true, source: 'windows/Setup.cpp:745' },
  copyParamAutoSelect: { setting: 'copyParamAutoSelectNotice', suppresses: true, source: 'forms/CustomScpExplorer.cpp:9868' },
  editorLargeFile: { setting: 'editor.warnOnLargeFile', suppresses: true, source: 'forms/Editor.cpp:1476' },
  editorEncoding: { setting: 'editor.encoding', suppresses: true, source: 'forms/Editor.cpp:1428' },
  showTips: { setting: 'showTips', suppresses: true, source: 'windows/Setup.cpp:2176' },
  addBookmark: { setting: 'useSharedBookmarks', suppresses: false, source: 'forms/CustomScpExplorer.cpp:7161' },
  tooManyWatchDirectories: { setting: 'maxWatchDirectories', suppresses: false, source: 'forms/CustomScpExplorer.cpp:6153' },
  sessionDisconnect: { setting: 'sessionSilentDisconnect', suppresses: false, source: 'windows/UserInterface.cpp:321' },
  inactiveTermination: { setting: 'sessionReopenAutoInactive', suppresses: false, source: 'windows/UserInterface.cpp:314' },
  // "Session '%s' is disconnected, reconnect to save '%s'?" — the box is
  // offered only while SessionReopenAutoInactive is still off (FLAGMASK), and
  // ticking it turns that on, so the reconnect happens without asking next
  // time. It is the same setting inactiveTermination writes, from the editor.
  editSessionReconnect: { setting: 'sessionReopenAutoInactive', suppresses: false, source: 'forms/CustomScpExplorer.cpp:4033' },
  // "The editor was closed before the file was uploaded" — the box is offered
  // only when an instance of that editor is still running (AnyFound), and it
  // turns the MDI auto-detection off rather than hiding the warning.
  editorEarlyClosed: { setting: 'editor.disableMdiDetect', suppresses: false, source: 'forms/CustomScpExplorer.cpp:4270' },
});

function mayOfferNeverAskAgain(questionId) {
  return Object.prototype.hasOwnProperty.call(NEVER_ASK_AGAIN_QUESTIONS, String(questionId));
}

/** The persisted setting a ticked box writes, or null when the id is unknown. */
function neverAskAgainSetting(questionId) {
  const q = NEVER_ASK_AGAIN_QUESTIONS[String(questionId)];
  return q ? q.setting : null;
}

// ===========================================================================
// Building a message dialog — CreateMessageDialogEx / CreateMoreMessageDialogEx
// ===========================================================================

/**
 * The button list for a question. Answers appear in numeric order; an alias
 * may rename a button, attach a submit handler, mark it as a menu button, or
 * fold it under another button as a drop-down item.
 *
 * Two rules here are load-bearing and easy to get wrong:
 *
 * 1. A button with a submit handler has NO modal result. Clicking it runs the
 *    handler; the dialog only closes if the handler produces an answer. That
 *    is how "Open" on the download-finished notice opens a folder without
 *    answering the question, and it is why such a button is never disabled by
 *    the never-ask-again check box.
 *
 * 2. A grouped button is not a button at all — it becomes an item under the
 *    button it is grouped with. So it is never the default, never the cancel
 *    and never the timeout button, and the grouping is refused outright when
 *    it would swallow one of those three.
 */
function buildButtons(answers, opts) {
  const o = opts || {};
  const aliases = o.aliases || [];
  const timeoutAnswer = o.timeoutAnswer || 0;
  const theDefault = defaultAnswer(answers);
  const theCancel = cancelAnswer(answers);

  const buttons = [];
  const byAnswer = new Map();
  let timeoutButton = null;
  let activeAnswer = 0;

  for (const answer of answerList(answers)) {
    const { name, caption: stdCaption } = answerNameAndCaption(answer);
    let caption = stdCaption;
    let onSubmit = null;
    let groupWith = -1;
    let grouppedShiftState = '';
    let elevationRequired = false;
    let menuButton = false;
    let actionAlias = '';

    for (const alias of aliases) {
      if (alias.button !== answer) continue;
      if (alias.alias) caption = alias.alias;
      onSubmit = alias.onSubmit || null;
      groupWith = (alias.groupWith === undefined) ? -1 : alias.groupWith;
      grouppedShiftState = alias.grouppedShiftState || '';
      elevationRequired = !!alias.elevationRequired;
      menuButton = !!alias.menuButton;
      actionAlias = alias.actionAlias || '';
      break;
    }

    // ActionAlias renders as a link rather than a button (MessageDlg.cpp:926).
    if (actionAlias && onSubmit && groupWith < 0) {
      buttons.push({
        answer, name, kind: 'link', caption: stripHotkey(actionAlias),
        accessKey: hotkeyOf(actionAlias), onSubmit,
        default: false, cancel: false, timeout: false, modalResult: 0,
        elevationRequired: false, menuButton: false, groupWith: -1, grouppedShiftState: '',
      });
      continue;
    }

    if (groupWith >= 0) {
      // MessageDlg.cpp:940 — refuse a grouping that would hide the button the
      // dialog needs to be able to point at.
      if (groupWith >= answer || answer === timeoutAnswer ||
          answer === theDefault || answer === theCancel ||
          !byAnswer.has(groupWith)) {
        groupWith = -1;
      }
    }

    if (groupWith >= 0) {
      const host = byAnswer.get(groupWith);
      if (!host.dropDown) {
        // The host button gains a default item repeating itself, so the menu
        // never presents fewer choices than the button already offered.
        host.dropDown = [{
          answer: host.answer, caption: host.caption, accessKey: host.accessKey,
          default: true, onSubmit: host.onSubmit || null, shiftState: '',
        }];
        host.kind = 'splitButton';
      }
      host.dropDown.push({
        answer, caption: stripHotkey(caption), accessKey: hotkeyOf(caption),
        default: false, onSubmit, shiftState: grouppedShiftState,
      });
      continue;
    }

    const isTimeoutButton = (timeoutAnswer !== 0) && (answer === timeoutAnswer);
    if (answer === ANSWER.help) onSubmit = onSubmit || 'help';
    if (answer === ANSWER.report) onSubmit = onSubmit || 'report';

    const button = {
      answer, name, kind: 'button',
      caption: stripHotkey(caption), accessKey: hotkeyOf(caption),
      onSubmit,
      // A submit handler replaces the modal result: the button no longer
      // closes the dialog by itself.
      modalResult: onSubmit ? 0 : answer,
      default: answer === theDefault,
      cancel: answer === theCancel,
      timeout: isTimeoutButton,
      elevationRequired, menuButton,
      groupWith: -1, grouppedShiftState: '',
      dropDown: null,
    };
    // ActiveControl follows ButtonControls, which in the original is a separate
    // vector from the link control — so a link rendered ahead of the buttons
    // must not stop the first real button from taking the focus. Counting
    // `buttons` (which holds both) would leave the dialog with no focused
    // control at all on the one dialog that has a link: the update notice.
    if (activeAnswer === 0) activeAnswer = answer;
    buttons.push(button);
    byAnswer.set(answer, button);
    if (isTimeoutButton) timeoutButton = button;
  }

  return { buttons, timeoutButton, activeAnswer, defaultAnswer: theDefault, cancelAnswer: theCancel };
}

/**
 * CreateMoreMessageDialogEx + CreateMessageDialogEx, as one descriptor.
 *
 * Order matters and is preserved: the timer overrides come FIRST (a timer can
 * replace the message, the answer set and even the query type), and only then
 * are Help and Report added — so a timer's answer set also gets a Help button.
 */
function buildMessageDialog(message, moreMessages, type, answers, helpKeyword, params) {
  const p = (params instanceof MessageParams) ? params
    : (params ? new MessageParams(params) : null);

  let msg = String(message == null ? '' : message);
  let queryType = type || QUERY_TYPE.confirmation;
  let requestedAnswers = toAnswerMask(answers);
  let timer = null;

  if (p && p.timer > 0) {
    timer = { interval: p.timer, event: p.timerEvent || null };
    if (p.timerAnswers > 0) requestedAnswers = p.timerAnswers;
    if (p.timerQueryType !== null && p.timerQueryType !== undefined) queryType = p.timerQueryType;
    if (p.timerMessage) msg = p.timerMessage;
  }

  // ActualAnswers — the set as it stands AFTER any timer override but BEFORE
  // Help and Report are added. The never-ask-again wording is decided on this,
  // so an automatically added Help button cannot turn a notice into a question.
  const actualAnswers = requestedAnswers;
  let allAnswers = requestedAnswers;
  if (p === null || p.allowHelp) allAnswers |= ANSWER.help;
  if (isInternalErrorHelpKeyword(helpKeyword)) allAnswers |= ANSWER.report;

  let more = moreMessages;
  if (Array.isArray(more) && more.length === 0) more = null;
  if (typeof more === 'string') more = more.length ? more.split('\n') : null;

  const built = buildButtons(allAnswers, {
    aliases: p ? p.aliases : [],
    timeoutAnswer: p ? p.timeoutAnswer : 0,
  });

  let neverAskAgain = null;
  if (p && p.hasNeverAskAgain) {
    const caption = neverAskAgainCaption(actualAnswers, p.neverAskAgainTitle);
    neverAskAgain = {
      caption: stripHotkey(caption),
      accessKey: hotkeyOf(caption),
      checked: p.neverAskAgainCheckedInitially,
      // The tag: which answer the tick applies to. 0 means "whichever button
      // is the positive one", resolved at click time.
      answer: p.neverAskAgainAnswer || 0,
    };
  }

  let timeout = null;
  if (p && p.timeout > 0) {
    timeout = {
      milliseconds: p.timeout,
      // WHICH button counts down.
      button: built.timeoutButton ? built.timeoutButton.answer : 0,
      // WHAT the expiry answers, overriding the button's own answer when set.
      // Confusing these two is how a timeout becomes an unintended "yes".
      response: p.timeoutResponse || 0,
      // A timeout whose answer has no button cannot be armed. The original
      // would dereference a null button here; refusing to arm is the safe
      // reading — the dialog then simply waits for a human.
      armed: !!built.timeoutButton,
    };
  }

  return {
    message: msg,
    moreMessages: more,
    type: queryType,
    // The answer set the dialog is BUILT from — after a timer override. The
    // buttons and the never-ask-again wording follow this.
    answers: actualAnswers,
    // The answer set the CALLER asked for. MoreMessageDialog passes this, not
    // the timer-overridden set, to ExecuteMessageDialog, so a dismissal is
    // resolved against what the caller can handle rather than against whatever
    // the timer happened to be showing. The two differ only when a timer
    // replaces the answers (the SSH "host is not communicating" prompt).
    requestedAnswers: toAnswerMask(answers),
    // What the dialog actually shows, Help and Report included.
    allAnswers,
    buttons: built.buttons,
    activeAnswer: built.activeAnswer,
    defaultAnswer: built.defaultAnswer,
    cancelAnswer: built.cancelAnswer,
    neverAskAgain,
    timeout,
    timer,
    helpKeyword: String(helpKeyword || HELP_NONE),
    imageName: p ? p.imageName : '',
    moreMessagesUrl: p ? p.moreMessagesUrl : '',
    moreMessagesSize: p ? p.moreMessagesSize : null,
    customCaption: p ? p.customCaption : '',
    allowContinueOnError: !!(p && (p.params & MP.allowContinueOnError)),
  };
}

/**
 * NeverAskAgainCheckClick — WinInterface.cpp:91. Ticking the box narrows the
 * dialog to a single answer, because "never ask again" only makes sense
 * attached to one outcome: you cannot say "always do whatever I pick".
 *
 * The exceptions are exact and each one matters:
 *   - Cancel stays enabled. You can always change your mind about the whole
 *     operation, even after ticking the box.
 *   - A button with no modal result (an alias with a submit handler, e.g.
 *     "Open" or "Configure") stays enabled — it does not answer the question.
 *   - Drop-down items keep only their default entry.
 */
function neverAskAgainEnablement(dialog, checked, neverAskAgainAnswerOverride) {
  const buttons = dialog.buttons || [];
  const tag = (neverAskAgainAnswerOverride !== undefined && neverAskAgainAnswerOverride !== null)
    ? neverAskAgainAnswerOverride
    : (dialog.neverAskAgain ? dialog.neverAskAgain.answer : 0);

  let positiveAnswer = 0;
  if (checked) {
    if (tag > 0) {
      positiveAnswer = tag;
    } else {
      for (const b of buttons) {
        if (isPositiveAnswer(b.modalResult)) { positiveAnswer = b.modalResult; break; }
      }
    }
  }

  const enabled = new Map();
  const dropDown = new Map();
  for (const b of buttons) {
    if (b.modalResult !== 0 && b.modalResult !== ANSWER.cancel) {
      enabled.set(b.answer, !checked || (b.modalResult === positiveAnswer));
    } else {
      enabled.set(b.answer, true);
    }
    if (b.dropDown) {
      dropDown.set(b.answer, b.dropDown.map((i) => ({
        answer: i.answer, enabled: i.default || !checked,
      })));
    }
  }
  return { positiveAnswer, enabled, dropDown };
}

/**
 * ExecuteMessageDialog — WinInterface.cpp:242. Turns what the window produced
 * into the answer the caller gets.
 *
 * `raw.answer` may be null: the X button, Escape without a Cancel button, and
 * a Windows log-off all arrive as "no answer at all". Those become
 * CancelAnswer(answers) — computed on what the caller ASKED for, not on the
 * button set, so the automatically added Help button can never be the answer.
 *
 * When the check box is ticked AND the answer is the one it applies to, the
 * caller gets qaNeverAskAgain INSTEAD of that answer. A caller that only
 * handles qaYes therefore silently drops the ticked case, which is why every
 * never-ask-again call site in WinSCP falls through from qaNeverAskAgain to
 * its positive answer.
 */
function resolveMessageAnswer(dialog, raw) {
  const r = raw || {};
  let answer = (r.answer === undefined || r.answer === null) ? null : r.answer;
  if (typeof answer === 'string') answer = answerBit(answer);
  if (answer === null || answer === 0) {
    // Deliberately the caller's set, not the dialog's: see requestedAnswers.
    answer = cancelAnswer(
      dialog.requestedAnswers === undefined ? dialog.answers : dialog.requestedAnswers);
  }

  if (dialog.neverAskAgain && r.neverAskAgainChecked) {
    const tag = dialog.neverAskAgain.answer;
    const positive = (tag > 0) ? (answer === tag) : isPositiveAnswer(answer);
    if (positive) answer = NEVER_ASK_AGAIN;
  }

  return answer;
}

// ===========================================================================
// The query timeout — TMessageTimeout, WinInterface.cpp:306
// ===========================================================================

const TIMEOUT_TICK_MS = 1000;
const TIMEOUT_SUSPEND_MS = 30 * 1000;
const TIMEOUT_MOUSE_THRESHOLD = 8;

/** FormatTimeoutCaption — "%s (%d s)". */
function formatTimeoutCaption(caption, remainingMs) {
  return `${caption} (${Math.trunc(remainingMs / TIMEOUT_TICK_MS)} s)`;
}

/**
 * A counting-down button.
 *
 * The behaviour that matters is what STOPS the countdown, because a timeout
 * that fires while the user is reading the dialog answers for them:
 *   - any key press or mouse button press cancels the timeout permanently;
 *   - moving the mouse more than the threshold does not cancel it but
 *     postpones it to at least 30 seconds (never below the original timeout),
 *     and each further move postpones it again.
 * The caption always shows the remaining whole seconds, so an expiry is never
 * a surprise.
 */
class MessageTimeout {
  /**
   * @param {number} timeoutMs  the configured timeout
   * @param {object} opts       { caption, answer, scale, cursor }
   *                            `answer` is the TimeoutResponse: what the
   *                            expiry answers, overriding the button's own.
   */
  constructor(timeoutMs, opts) {
    const o = opts || {};
    this.origTimeout = timeoutMs;
    this.remaining = timeoutMs;
    // TMessageTimeout: Enabled = (FTimeout >= 0). A negative timeout is
    // "disarmed", which is how RestartToolbarDialogTimeout switches the
    // keep-up-to-date dialog back to manual.
    this.enabled = timeoutMs >= 0;
    this.origCaption = o.caption || '';
    this.answer = o.answer || 0;
    this.threshold = TIMEOUT_MOUSE_THRESHOLD * (o.scale || 1);
    this.origCursor = o.cursor || { x: 0, y: 0 };
    this.fired = false;
  }

  get caption() {
    return this.enabled ? formatTimeoutCaption(this.origCaption, this.remaining) : this.origCaption;
  }

  get remainingSeconds() {
    return Math.trunc(this.remaining / TIMEOUT_TICK_MS);
  }

  /** One 1-second tick. Returns true when the timeout fired on this tick. */
  tick() {
    if (!this.enabled) return false;
    if (this.remaining <= TIMEOUT_TICK_MS) {
      this.enabled = false;
      this.fired = true;
      return true;
    }
    this.remaining -= TIMEOUT_TICK_MS;
    return false;
  }

  /**
   * A mouse move. Beyond the threshold this postpones the expiry rather than
   * cancelling it — someone is at the machine but has not decided yet.
   */
  mouseMove(pos) {
    if (!this.enabled) return false;
    const p = pos || { x: 0, y: 0 };
    const delta = Math.max(
      Math.abs(this.origCursor.x - p.x),
      Math.abs(this.origCursor.y - p.y));
    if (delta <= this.threshold) return false;
    this.origCursor = { x: p.x, y: p.y };
    this.remaining = Math.max(this.origTimeout, TIMEOUT_SUSPEND_MS);
    return true;
  }

  /** A key press or a mouse button: the user is here, stop counting. */
  interrupt() {
    this.enabled = false;
  }

  /** Restart — used by the keep-up-to-date dialog between runs. */
  restart(timeoutMs) {
    this.remaining = timeoutMs;
    this.enabled = timeoutMs >= 0;
    this.fired = false;
  }

  /**
   * TButtonMessageTimeout::Timeouted — what the expiry actually answers.
   * `buttonAnswer` is the button's own modal result (0 when it is an aliased
   * submit button, which then runs its handler instead of answering).
   */
  expiryAnswer(buttonAnswer) {
    return this.answer !== 0 ? this.answer : (buttonAnswer || 0);
  }
}

/**
 * The whole timeout decision in one call, for callers that do not want to run
 * a ticking object: given the dialog and how it ended, what is the answer?
 *
 * `outcome` is 'expired' | 'answered' | 'dismissed'. A dialog whose timeout was
 * never armed cannot report 'expired'; asking for it is a programming error
 * rather than a licence to invent an answer.
 */
function timeoutAnswerFor(dialog, outcome, answered) {
  if (outcome !== 'expired') {
    return resolveMessageAnswer(dialog, { answer: answered });
  }
  const t = dialog.timeout;
  if (!t || !t.armed) {
    throw new UserInterfaceError('Dialog has no armed timeout; it cannot expire');
  }
  if (t.response !== 0) return t.response;
  const button = (dialog.buttons || []).find((b) => b.answer === t.button);
  // An aliased submit button has no modal result: expiring it runs the alias,
  // it does not answer. Reporting 0 keeps that distinction visible instead of
  // inventing a "yes".
  return button ? button.modalResult : 0;
}

// ===========================================================================
// Exceptions -> dialogs — Exceptions.cpp + WinInterface.cpp:698
// ===========================================================================

/**
 * REPORT_ERROR. This is the invitation an internal error carries, and it is
 * NOT a promotional ask — it appears only on a genuine programming fault, the
 * user has to press Report for anything to happen, and nothing is sent without
 * that press.
 *
 * The destination is a real decision the shell must make: WinSCP's own string
 * names WinSCP's support forum, and sending THIS application's crash reports
 * there would put our bugs in front of the wrong maintainers. The wording is
 * kept faithful and the venue is left to the caller of the Report button.
 */
const REPORT_ERROR_FORMAT = (message) =>
  `${message}\n\nPlease help us improving WinSCP by reporting the error on WinSCP support forum.`;

const STACK_TRACE_CAPTION = 'Stack trace:';

/**
 * An abort. EAbort is how WinSCP unwinds a user cancellation, and it is never
 * shown: the user already knows they cancelled.
 */
class AbortError extends Error {
  constructor(message) { super(message || ''); this.name = 'AbortError'; }
}

/**
 * ExtException — an error that carries extra lines for the "more info" panel
 * and, optionally, a help keyword.
 */
class ExtError extends Error {
  /**
   * `cause` is the exception being wrapped. Its help keyword is inherited, so
   * an internal error that gets wrapped in a friendlier message keeps its
   * Report button — the same thing ExtException's constructor does with
   * MergeHelpKeyword(HelpKeyword, GetExceptionHelpKeyword(E)).
   */
  constructor(message, moreMessages, helpKeyword, cause) {
    super(String(message == null ? '' : message));
    this.name = 'ExtError';
    this.moreMessages = Array.isArray(moreMessages) ? moreMessages.slice()
      : (moreMessages ? String(moreMessages).split('\n') : []);
    this.helpKeyword = cause
      ? mergeHelpKeyword(helpKeyword || '', getExceptionHelpKeyword(cause))
      : (helpKeyword || '');
    if (cause) this.cause = cause;
  }
}

function isAbort(e) {
  return !!e && (e instanceof AbortError || e.name === 'AbortError' || e.name === 'EAbort');
}

/**
 * WellKnownException (Exceptions.cpp:26) picks out the exceptions that mean
 * "we have a bug", as opposed to "the server said no". WinSCP's list is
 * EAccessViolation, EIntError/EListError/EVariantError/EInvalidOperation/
 * EFilerError, EExternal and EHeapException — every one of them a programming
 * fault rather than an operational one.
 *
 * Node's equivalents are the built-in error types a correct program never
 * throws: TypeError, RangeError, ReferenceError, SyntaxError, EvalError,
 * URIError and assertion failures. Marking these "internal" is what earns the
 * dialog its Report button and its internal-error help keyword.
 */
const INTERNAL_ERROR_NAMES = new Set([
  'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'EvalError',
  'URIError', 'AssertionError', 'InternalError',
]);

function isInternalException(e) {
  if (!e) return false;
  if (e.internalError === true) return true;
  return INTERNAL_ERROR_NAMES.has(e.name);
}

/**
 * ExceptionMessage (Exceptions.cpp:127). Returns whether the exception is
 * shown at all, and with what text.
 *
 * Two exceptions are NOT shown: an abort, and an exception with an empty
 * message. The second is not an oversight — an empty message means the code
 * that raised it already reported the problem, and a blank dialog would be
 * worse than none.
 */
function exceptionMessage(e, opts) {
  const o = opts || {};
  const formatted = !!o.formatted;
  if (isAbort(e)) return { display: false, message: '', internalError: false };

  let internalError = false;
  let message;
  if (isInternalException(e)) {
    internalError = true;
    message = mainInstructions(String(e.message || ''));
  } else if (!e || !e.message) {
    return { display: false, message: '', internalError: false };
  } else {
    message = String(e.message);
  }

  if (!formatted) message = unformatMessage(message);
  if (internalError) message = REPORT_ERROR_FORMAT(message);

  return { display: true, message, internalError };
}

function exceptionMessageFormatted(e) {
  return exceptionMessage(e, { formatted: true });
}

/** ShouldDisplayException (Exceptions.cpp:191). */
function shouldDisplayException(e) {
  return exceptionMessageFormatted(e).display;
}

/** ExceptionToMoreMessages (Exceptions.cpp:197). */
function exceptionToMoreMessages(e) {
  const m = exceptionMessage(e);
  if (!m.display) return null;
  const out = [m.message];
  if (e && Array.isArray(e.moreMessages)) out.push(...e.moreMessages);
  return out;
}

/** ExceptionFullMessage (Exceptions.cpp:214). */
function exceptionFullMessage(e) {
  const m = exceptionMessage(e);
  if (!m.display) return null;
  let message = `${m.message}\n`;
  if (e && Array.isArray(e.moreMessages) && e.moreMessages.length) {
    message += `${e.moreMessages.join('\n')}\n`;
  }
  return message;
}

/**
 * GetExceptionHelpKeyword (Exceptions.cpp:229). The structure is an else-if,
 * not a fall-through: an ExtException's keyword is used even when it is empty,
 * because an ExtException that wrapped an internal error already inherited the
 * internal-error keyword when it was constructed. Falling through would give a
 * plain wrapper a Report button it was deliberately not given.
 */
function getExceptionHelpKeyword(e) {
  if (e instanceof ExtError) return e.helpKeyword || '';
  if (e && e.helpKeyword) return e.helpKeyword;
  if (e && isInternalException(e)) return HELP_INTERNAL_ERROR;
  return '';
}

/**
 * FormatStackTrace (WinInterface.cpp:598). The original strips the calling
 * convention noise and the absolute load address, so that two reports of the
 * same crash are textually identical and can be grouped.
 *
 * The same intent applied to a Node stack: drop the absolute file path (it
 * contains the user's home directory, which is both noise and a small privacy
 * leak in a bug report) and keep the file name, line and column.
 */
function formatStackTrace(stack) {
  const lines = Array.isArray(stack) ? stack.slice()
    : String(stack == null ? '' : stack).split('\n');
  return lines.map((line) => {
    let frame = String(line)
      .split('__fastcall ').join('')
      .split('__linkproc__ ').join('');
    // C++ frames: "(module) [0043210F] Unit.Func" — the address goes.
    if (frame.startsWith('(')) {
      const start = frame.indexOf('[');
      const end = frame.indexOf(']');
      if (start > 1 && end > start && frame[start - 1] === ' ') {
        frame = frame.slice(0, start - 1) + frame.slice(end + 1);
      }
    }
    // Node frames: keep the basename of the file, drop the directory.
    frame = frame.replace(/\(([^()]*[\\/])([^\\/()]+:\d+:\d+)\)/g, '($2)');
    return frame;
  });
}

/**
 * AppendExceptionStackTrace (WinInterface.cpp:671). Only an INTERNAL exception
 * gets a stack trace attached: a "permission denied" from the server is not
 * made more useful by 40 frames of our own code, and a user pasting it into a
 * forum post would be pasting their own directory layout.
 */
function appendExceptionStackTrace(e, moreMessages) {
  const out = Array.isArray(moreMessages) ? moreMessages.slice() : [];
  if (!isInternalException(e) || !e.stack) return { moreMessages: moreMessages || null, appended: false };
  const trace = formatStackTrace(String(e.stack).split('\n').slice(1));
  if (out.length) out.push('');
  out.push(STACK_TRACE_CAPTION);
  out.push(...trace);
  return { moreMessages: out, appended: true };
}

/**
 * ExceptionMessageDialog (WinInterface.cpp:698).
 *
 * `messageFormat` wraps the exception text — and it is applied to the
 * UNFORMATTED message, so a main-instructions tag inside the exception does
 * not fight with the tag the format string adds around it.
 */
function buildExceptionDialog(e, type, opts) {
  const o = opts || {};
  const formatted = exceptionMessageFormatted(e);
  if (!formatted.display) {
    // ExceptionMessageDialog is only ever reached through a ShouldDisplayException
    // check; being called anyway means the caller skipped that check.
    throw new UserInterfaceError('Exception is not displayable');
  }

  let message = formatted.message;
  if (o.messageFormat) {
    message = String(o.messageFormat).split('%s').join(unformatMessage(message));
  }

  const helpKeyword = mergeHelpKeyword(o.helpKeyword || '', getExceptionHelpKeyword(e));

  let more = (e && Array.isArray(e.moreMessages) && e.moreMessages.length)
    ? e.moreMessages.slice() : null;
  const withTrace = appendExceptionStackTrace(e, more);
  more = withTrace.moreMessages;

  const answers = (o.answers === undefined) ? ANSWER.ok : toAnswerMask(o.answers);
  return buildMessageDialog(message, more, type || QUERY_TYPE.error, answers, helpKeyword, o.params);
}

const RECONNECT_BUTTON = '&Reconnect';

/**
 * FatalExceptionMessageDialog (WinInterface.cpp:730). A fatal error always
 * grows a Retry button aliased "Reconnect" — the session is gone, and the only
 * thing the user can usefully do is bring it back. The original asserts that
 * the caller did not already pass qaRetry, and that it did not already supply
 * aliases; both would silently lose the Reconnect button, so they are refused
 * here rather than merged.
 */
function buildFatalExceptionDialog(e, type, opts) {
  const o = opts || {};
  const answers = (o.answers === undefined) ? ANSWER.ok : toAnswerMask(o.answers);
  if ((answers & ANSWER.retry) !== 0) {
    throw new UserInterfaceError('A fatal error dialog adds Retry itself');
  }
  const params = (o.params instanceof MessageParams) ? o.params.clone()
    : new MessageParams(o.params || {});
  if (params.aliases.length > 0) {
    throw new UserInterfaceError('A fatal error dialog owns the button aliases');
  }
  params.aliases = [{ button: ANSWER.retry, alias: RECONNECT_BUTTON }];

  return buildExceptionDialog(e, type, {
    ...o,
    answers: answers | ANSWER.retry,
    params,
  });
}

/** SimpleErrorDialog (WinInterface.cpp:579). */
function simpleErrorDialog(message, moreMessages) {
  const more = (moreMessages === undefined || moreMessages === null || moreMessages === '')
    ? null : moreMessages;
  return buildMessageDialog(message, more, QUERY_TYPE.error, ANSWER.ok, HELP_NONE, null);
}

const HELP_SEND_MESSAGE_QUESTION =
  '**Do you want to send the message to WinSCP site?**\n\n' +
  'There is no help page associated with the message. WinSCP can search its ' +
  'documentation site for the message text for you.\n\n' +
  'Note: WinSCP will send the message as is over unsecure Internet connection. ' +
  'Please check that the message does not contain any data you want to protect, ' +
  'such as names of files, accounts or hosts.';

/**
 * MessageWithNoHelp (UserInterface.cpp:1448). Pressing Help on a message with
 * no help page offers to search the site — and asks first, because the search
 * puts the message text on the wire. Note allowHelp:false: without it the
 * confirmation would itself grow a Help button and recurse.
 */
function buildNoHelpDialog() {
  return buildMessageDialog(
    HELP_SEND_MESSAGE_QUESTION, null, QUERY_TYPE.confirmation,
    ANSWER.ok | ANSWER.cancel, HELP_NONE,
    new MessageParams({ allowHelp: false }));
}

// ===========================================================================
// Busy cursor and modal state — WinInterface.cpp:754, VCLCommon.cpp:1450
// ===========================================================================

const CURSOR = Object.freeze({ default: 'default', hourGlass: 'wait' });

/**
 * Screen->Cursor, and BusyStart/BusyEnd on top of it.
 *
 * BusyEnd restores the cursor that BusyStart SAVED, not "the previous one" —
 * so out-of-order ends restore an older cursor rather than corrupting a stack.
 * That is the original's behaviour and long-running code depends on it.
 */
class BusyState {
  constructor(cursor) {
    this.cursor = cursor || CURSOR.default;
    this.depth = 0;
  }

  /** BusyStart — returns the token BusyEnd needs. */
  start() {
    const token = this.cursor;
    this.cursor = CURSOR.hourGlass;
    this.depth++;
    return token;
  }

  /** BusyEnd. */
  end(token) {
    this.cursor = (token === undefined) ? CURSOR.default : token;
    if (this.depth > 0) this.depth--;
  }

  get busy() {
    return this.cursor === CURSOR.hourGlass;
  }
}

/** TOperationVisualizer (CoreMain.cpp:213) — the busy cursor as a scope. */
class OperationVisualizer {
  constructor(busyState, useBusyCursor) {
    this.busy = busyState;
    this.useBusyCursor = (useBusyCursor === undefined) ? true : !!useBusyCursor;
    this.token = this.useBusyCursor ? busyState.start() : undefined;
    this.disposed = false;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.useBusyCursor) this.busy.end(this.token);
  }
}

const INSTANT_OPERATION_MIN_MS = 250;

/**
 * TInstantOperationVisualizer (CoreMain.cpp:231). An operation that finishes
 * instantly still shows its feedback for a quarter of a second, so a
 * successful action does not look like nothing happened.
 */
class InstantOperationVisualizer {
  constructor(now) {
    this.start = (typeof now === 'number') ? now : Date.now();
  }

  /** How much longer the feedback must stay up. */
  remainingMs(now) {
    const elapsed = ((typeof now === 'number') ? now : Date.now()) - this.start;
    return Math.max(0, INSTANT_OPERATION_MIN_MS - elapsed);
  }

  async dispose(now) {
    const wait = this.remainingMs(now);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    return wait;
  }
}

/**
 * ShowAsModal / HideAsModal (VCLCommon.cpp:1450) tracked as state.
 *
 * What is portable here is the bookkeeping, and it is not decoration: the
 * progress window uses it to decide whether it may pop up over a dialog that
 * appeared after the operation started. The Win32 halves (DisableTaskWindows,
 * SaveFocusState, CM_ACTIVATE) have DOM equivalents the renderer owns; what
 * this class keeps is the nesting, the focus stack and the cursor reset that
 * the original performs on every as-modal show.
 */
class ModalState {
  constructor(busyState) {
    this.busy = busyState || new BusyState();
    this.modalLevel = 0;
    this.stack = [];
    this.focusedForm = null;
    this.onModalBegin = null;
    this.onModalFinished = null;
  }

  showAsModal(form, opts) {
    const o = opts || {};
    const triggerModalStarted = (o.triggerModalStarted === undefined) ? true : !!o.triggerModalStarted;
    if (triggerModalStarted) {
      this.modalLevel++;
      if (this.onModalBegin) this.onModalBegin(form);
    }
    const storage = {
      form,
      triggerModalFinished: triggerModalStarted,
      previousFocusedForm: this.focusedForm,
      savedCursor: this.busy.cursor,
      savedDepth: this.busy.depth,
    };
    this.focusedForm = form;
    // The original resets the cursor here explicitly: the progress window can
    // be shown while a download-to-temp has the hourglass up, and a modal
    // window with a hidden or busy cursor is unusable.
    this.busy.cursor = CURSOR.default;
    this.stack.push(storage);
    return storage;
  }

  hideAsModal(storage) {
    if (!storage) throw new UserInterfaceError('Not shown as modal');
    const index = this.stack.indexOf(storage);
    if (index >= 0) this.stack.splice(index, 1);
    this.busy.cursor = (this.busy.depth === storage.savedDepth)
      ? storage.savedCursor : CURSOR.default;
    this.focusedForm = storage.previousFocusedForm;
    if (storage.triggerModalFinished) {
      this.modalLevel = Math.max(0, this.modalLevel - 1);
      if (this.onModalFinished) this.onModalFinished(storage.form);
    }
  }

  /** ReleaseAsModal — tolerates never having been shown. */
  releaseAsModal(storage) {
    if (!storage) return false;
    this.hideAsModal(storage);
    return true;
  }
}

// ===========================================================================
// Foreground, flashing and minimize — UserInterface.cpp:87, WinInterface.cpp:1265
// ===========================================================================

/**
 * SetOnForeground / FlashOnBackground. WinSCP flashes the taskbar button when
 * a dialog opens while the user is in another application — but not during
 * startup, because a message box on launch is expected and flashing for it is
 * just noise. Execute() sets the flag on at the very start and clears it right
 * before the main window opens.
 */
class ForegroundState {
  constructor() { this.forcedOnForeground = false; }

  setOnForeground(onForeground) { this.forcedOnForeground = !!onForeground; }

  /** Whether the taskbar button should flash now. */
  shouldFlash(opts) {
    const o = opts || {};
    const flashTaskbar = (o.flashTaskbar === undefined) ? true : !!o.flashTaskbar;
    return flashTaskbar && !this.forcedOnForeground && !o.foregroundTask;
  }
}

/**
 * SetGlobalMinimizeHandler (WinInterface.cpp:1265). Only the FIRST registered
 * handler wins, and clearing only works from that same handler — so a nested
 * progress window cannot steal the minimize behaviour from the one below it.
 */
class GlobalMinimizeHandler {
  constructor() { this.handler = null; this.count = 0; }

  set(handler) {
    if (this.handler === null) this.handler = handler;
    return this.handler === handler;
  }

  clear(handler) {
    if (this.handler === handler) { this.handler = null; return true; }
    return false;
  }

  call(sender) {
    this.count++;
    if (this.handler) { this.handler(sender); return true; }
    return false;
  }
}

/**
 * IsMainFormMinimized (WinInterface.cpp:1394). Either the application or the
 * main window being iconic counts, because the two can disagree when a child
 * window did the minimizing.
 */
function isMainFormMinimized(state) {
  const s = state || {};
  return !!s.applicationMinimized || !!s.mainFormMinimized;
}

/** HandleMinimizeSysCommand (WinInterface.cpp:1410). */
function isMinimizeSysCommand(cmdType) {
  return (Number(cmdType) & 0xFFF0) === 0xF020; // SC_MINIMIZE
}

// ===========================================================================
// The progress-window contract — forms/Progress.cpp
// ===========================================================================

const PROGRESS_DELAY_START_MS = 500;
const PROGRESS_UPDATE_MS = 1000;
/** TDateTime(0,0,3,0) — three seconds. */
const IGNORE_CANCEL_BEFORE_FINISH_MS = 3000;

/** TCancelStatus, ordered: SetCancelLower only ever raises. */
const CANCEL_STATUS = Object.freeze({
  continue: 0,
  cancelFile: 1,
  cancel: 2,
  cancelTransfer: 3,
  remoteAbort: 4,
});

/** TOnceDoneOperation. */
const ONCE_DONE = Object.freeze({
  idle: 'idle',
  disconnect: 'disconnect',
  suspend: 'suspend',
  shutDown: 'shutDown',
});

const CANCEL_OPERATION_FATAL_QUESTION =
  '**Cancel file transfer?**\n \n' +
  "Operation can't be canceled in the middle of file transfer.\n" +
  "Press 'Yes' to cancel file transfer and to close connection.\n" +
  "Press 'No' to finish current file transfer.\n" +
  "Press 'Cancel' to continue operation.";

/**
 * The progress window's decisions, without the window.
 *
 * The delayed popup is the part that looks like a detail and is not: an
 * operation that finishes in under half a second must never flash a window,
 * and a window must never pop up over a dialog that opened after the operation
 * started (which would steal the keystroke aimed at that dialog). Both rules
 * live in receiveData().
 */
class ProgressDialogState {
  constructor(opts) {
    const o = opts || {};
    this.started = (typeof o.now === 'number') ? o.now : Date.now();
    this.dataGot = false;
    this.dataReceived = false;
    this.modalLevel = -1;
    this.modalBeginHooked = false;
    this.cancel = CANCEL_STATUS.continue;
    this.pendingSkip = false;
    this.moveToQueue = false;
    this.readOnly = false;
    this.onceDoneOperation = ONCE_DONE.idle;
    this.allowMinimize = (o.allowMinimize === undefined) ? true : !!o.allowMinimize;
    this.suspended = false;
    this.minimizedByMe = false;
    this.sinceLastUpdate = 0;
  }

  /** SetProgressData's half: data arrived, the window may now consider showing. */
  setData(now) {
    this.dataGot = true;
    return this.receiveData(false, 0, now);
  }

  /**
   * TProgressForm::ReceiveData (Progress.cpp:390). Returns true when the
   * window should become visible on this call.
   *
   * @param force            true from the modal-begin hook: a dialog is about
   *                         to open, so show now rather than behind it
   * @param modalLevelOffset -1 from that same hook, because the level has been
   *                         incremented for a dialog that does not exist yet
   */
  receiveData(force, modalLevelOffset, now, env) {
    const e = env || {};
    const at = (typeof now === 'number') ? now : Date.now();
    if (!this.dataGot || this.dataReceived) return false;

    const appModalLevel = e.applicationModalLevel || 0;
    if (!((this.modalLevel < 0) || (appModalLevel + (modalLevelOffset || 0) <= this.modalLevel))) {
      return false;
    }

    const minimized = isMainFormMinimized(e);
    if (!minimized && (force || (at - this.started > PROGRESS_DELAY_START_MS))) {
      this.dataReceived = true;
      return true;
    }

    if (!this.modalBeginHooked && this.modalLevel < 0) {
      // Remember the modal level as of the moment the window WOULD have been
      // shown, so a dialog opened later still counts as "later".
      this.modalBeginHooked = true;
      this.modalLevel = appModalLevel;
    }
    return false;
  }

  /** ApplicationModalBegin (Progress.cpp:435). */
  applicationModalBegin(now, env) {
    return this.receiveData(true, -1, now, env);
  }

  /** UpdateTimerTimer's throttle: repaint once a second, not once a tick. */
  advanceUpdateTimer(intervalMs) {
    if (!this.dataReceived) return false;
    this.sinceLastUpdate += intervalMs;
    if (this.sinceLastUpdate >= PROGRESS_UPDATE_MS) {
      this.sinceLastUpdate = 0;
      return true;
    }
    return false;
  }

  /** UpdateControls (Progress.cpp:133) — which commands are available. */
  controlState() {
    return {
      cancel: !this.readOnly && (this.cancel < CANCEL_STATUS.cancel),
      skip: !this.readOnly && (this.cancel < CANCEL_STATUS.cancelFile) && !this.pendingSkip,
      moveToQueue: !this.moveToQueue && (this.cancel === CANCEL_STATUS.continue) && !this.pendingSkip,
      minimize: this.allowMinimize,
    };
  }

  /** SetCancelLower (Progress.cpp:775) — escalates, never de-escalates. */
  setCancelLower(status) {
    if (this.cancel < status) { this.cancel = status; return true; }
    return false;
  }

  /**
   * ClearCancel (Progress.cpp:765). Only a single-file cancel can be taken
   * back; anything stronger has already told the transfer to stop. (The
   * original clears FCancel unconditionally, but its sole caller —
   * CustomScpExplorer.cpp:1667 — has already tested for csCancelFile, so
   * refusing here is the same behaviour with the unreachable case made safe.)
   *
   * Taking the cancel back also RAISES pendingSkip: the file system has
   * accepted the skip and is now finishing it, so offering Skip again before
   * the next file starts would let the user queue a second skip against a file
   * that is already going. It is lowered again when the file — or the whole
   * operation — changes (Progress.cpp:161, :300).
   */
  clearCancel() {
    if (this.cancel !== CANCEL_STATUS.cancelFile) return false;
    this.pendingSkip = true;
    this.cancel = CANCEL_STATUS.continue;
    return true;
  }

  /**
   * The two places UpdateControls lowers FPendingSkip: the displayed file name
   * changed (Progress.cpp:300), or the operation/side changed (:161). Either
   * means the skip the user asked for has happened.
   */
  noteFileChanged() {
    const was = this.pendingSkip;
    this.pendingSkip = false;
    return was;
  }

  /**
   * CancelOperation (Progress.cpp:548) — the refusal that matters most in this
   * file. Cancelling mid-file cannot be done cleanly, so when a file is being
   * transferred and more than IgnoreCancelBeforeFinish of it remains, WinSCP
   * asks a three-way question instead of just stopping:
   *   Yes    -> kill the transfer and the connection with it
   *   No     -> let this file finish, then stop
   *   Cancel -> do not stop at all
   * Note the default: anything that is not Yes or No means CONTINUE. A user
   * who closes that question with the X does not lose the transfer.
   *
   * @param ask  (dialog) => answer. Called only when the question is needed.
   */
  cancelOperation(ask, opts) {
    const o = opts || {};
    // "if (!FData.Suspended)": a second cancel while the first question is up
    // does nothing.
    if (this.suspended) return { asked: false, cancel: this.cancel, changed: false };

    const ignoreBefore = (o.ignoreCancelBeforeFinishMs === undefined)
      ? IGNORE_CANCEL_BEFORE_FINISH_MS : o.ignoreCancelBeforeFinishMs;

    this.suspended = true;
    try {
      let target;
      let asked = false;
      let dialog = null;
      if (o.transferringFile && (o.timeExpectedMs || 0) > ignoreBefore) {
        asked = true;
        dialog = buildMessageDialog(
          CANCEL_OPERATION_FATAL_QUESTION, null, QUERY_TYPE.warning,
          ANSWER.yes | ANSWER.no | ANSWER.cancel, 'progress_cancel', null);
        const answer = resolveMessageAnswer(dialog, { answer: ask ? ask(dialog) : null });
        if (answer === ANSWER.yes) target = CANCEL_STATUS.cancelTransfer;
        else if (answer === ANSWER.no) target = CANCEL_STATUS.cancel;
        else target = CANCEL_STATUS.continue;
      } else {
        target = CANCEL_STATUS.cancel;
      }
      const changed = this.setCancelLower(target);
      return { asked, dialog, cancel: this.cancel, changed };
    } finally {
      this.suspended = false;
    }
  }

  /**
   * SetReadOnly (Progress.cpp:647). A read-only progress window is one being
   * shown for somebody else's operation (the queue): UpdateControls hides the
   * "what to do when finished" item entirely while it is read-only, so the
   * stored choice is untouched on the way IN and reset on the way OUT.
   *
   * The direction is the whole point and it is easy to get backwards. The
   * choice that survives here is "disconnect / suspend / shut down when the
   * transfer finishes". Resetting it when the window BECOMES read-only would
   * leave a stale shut-down request behind when it is handed back to the user
   * — a window they can now see and change, still carrying a decision made for
   * a different operation. WinSCP resets on the transition to writable, and
   * only when the value actually changed.
   */
  setReadOnly(value) {
    const changed = this.readOnly !== !!value;
    if (!changed) return false;
    this.readOnly = !!value;
    if (!this.readOnly) this.onceDoneOperation = ONCE_DONE.idle;
    return true;
  }

  setOnceDoneOperation(value) {
    if (this.readOnly && value !== ONCE_DONE.idle) return false;
    this.onceDoneOperation = value;
    return true;
  }
}

// ===========================================================================
// The extended-exception decision — UserInterface.cpp:168
// ===========================================================================

/** ESshTerminate::Operation — what a "finished, now what" error asks for. */
const TERMINATE_OPERATION = Object.freeze({
  idle: 'idle',
  disconnect: 'disconnect',
  suspend: 'suspend',
  shutDown: 'shutDown',
});

const EXIT_ON_COMPLETION = 'Do you want to close application?';
const DISCONNECT_ON_COMPLETION = (count) =>
  `Do you want to terminate ${count} remaining session(s) and close the application?`;
/**
 * SessionReopenAutoIdleDefault (GUIConfiguration.cpp:17). WinSCP keeps TWO
 * settings here and this port currently keeps only one: the boolean
 * `security.sessionReopenAutoIdle` is WinSCP's SessionReopenAutoIdleOn, while
 * the interval itself — how long the Reconnect button counts down — has no
 * preference of its own yet. The original's 9 seconds is used when the caller
 * does not supply one, so the countdown is never accidentally zero (which
 * would make the dialog answer itself on its first tick).
 */
const SESSION_REOPEN_AUTO_IDLE_DEFAULT_MS = 9000;

const ALWAYS_RECONNECT = '&Always reconnect automatically';
const NEVER_POPUP_DISCONNECT = '&Never popup disconnect messages';
const OPEN_BUTTON = '&Open';

/**
 * ShowExtendedExceptionEx, as a decision rather than a dialog.
 *
 * This is the single most consequential branch in the interaction layer: it
 * decides whether an error is shown at all, whether it offers to reconnect,
 * whether it offers to close the application, and whether the user may switch
 * any of those off permanently. Each returned plan says exactly what to ask;
 * applyExtendedExceptionAnswer() below says what the answer then means.
 *
 * @param e    the exception
 * @param ctx  {
 *   terminal, activeTerminal, sessionCount, whileIdle,
 *   noInteractiveInput, xmlLog,
 *   fatal, terminate: { operation, targetLocalPath, destLocalFileName },
 *   inactiveTerminationMessage, permanentTerminal,
 *   confirmExitOnCompletion, sessionSilentDisconnect,
 *   sessionReopenAutoIdleOn, sessionReopenAutoIdle,
 *   sessionReopenTimeout, reopenElapsedMs,
 * }
 */
function planExtendedException(e, ctx) {
  const c = ctx || {};
  const show = shouldDisplayException(e);

  // /nointeractiveinput (always set by the .NET assembly): nothing may be
  // shown, and the failure is recorded to the XML log instead so that it is
  // not simply lost.
  if (c.noInteractiveInput) {
    return {
      display: false,
      logFailure: show && !!c.xmlLog,
      dialog: null,
      kind: 'none',
      closeOnCompletion: false,
    };
  }

  const terminate = c.terminate || null;
  const closeOnCompletion = !!terminate;
  const forActiveTerminal = !!c.fatal && !!c.terminal &&
    (c.activeTerminal === c.terminal);

  if (closeOnCompletion) {
    const confirm =
      (terminate.operation === TERMINATE_OPERATION.disconnect ||
       terminate.operation === TERMINATE_OPERATION.suspend) &&
      !!c.confirmExitOnCompletion;

    // Suspend happens BEFORE the question, so that the exit prompt is waiting
    // when the machine wakes up rather than being answered by nobody.
    const suspendFirst = terminate.operation === TERMINATE_OPERATION.suspend;

    if (!confirm) {
      return {
        display: show, logFailure: false, dialog: null, kind: 'closeOnCompletion',
        closeOnCompletion: true, forActiveTerminal, suspendFirst,
        disconnectFirst: forActiveTerminal,
        impliedAnswer: ANSWER.yes, terminateOperation: terminate.operation,
      };
    }

    const params = new MessageParams(MP.neverAskAgainCheck);
    let answers = 0;
    // The "Open" button appears only when a download actually produced a local
    // path AND this is not the active session's own fatal error — offering to
    // open a folder while telling the user their session died is nonsense.
    if (terminate.targetLocalPath && !forActiveTerminal) {
      params.aliases = [{
        button: ANSWER.ignore, alias: OPEN_BUTTON, menuButton: true,
        onSubmit: 'openLocalPath',
      }];
      answers |= ANSWER.ignore;
    }

    let dialog;
    if (forActiveTerminal) {
      const text = (c.sessionCount > 1)
        ? DISCONNECT_ON_COMPLETION((c.sessionCount || 1) - 1)
        : EXIT_ON_COMPLETION;
      const messageFormat = `${mainInstructions(text)}\n\n%s`;
      dialog = buildFatalExceptionDialog(e, QUERY_TYPE.information, {
        messageFormat, answers: answers | ANSWER.yes | ANSWER.no,
        helpKeyword: HELP_NONE, params,
      });
    } else {
      dialog = buildExceptionDialog(e, QUERY_TYPE.information, {
        messageFormat: '', answers: answers | ANSWER.ok,
        helpKeyword: HELP_NONE, params,
      });
    }

    return {
      display: true, logFailure: false, dialog,
      kind: forActiveTerminal ? 'exitOnCompletionFatal' : 'exitOnCompletion',
      closeOnCompletion: true, forActiveTerminal, suspendFirst,
      disconnectFirst: forActiveTerminal,
      terminateOperation: terminate.operation,
      neverAskAgainQuestion: 'exitOnCompletion',
    };
  }

  if (!show) {
    return {
      display: false, logFailure: false, dialog: null, kind: 'silent',
      closeOnCompletion: false, forActiveTerminal, impliedAnswer: ANSWER.ok,
    };
  }

  if (!forActiveTerminal) {
    return {
      display: true, logFailure: false, kind: 'error',
      closeOnCompletion: false, forActiveTerminal: false,
      dialog: buildExceptionDialog(e, QUERY_TYPE.error, { answers: ANSWER.ok }),
    };
  }

  const inactiveTermination = !!c.fatal && !!c.inactiveTerminationMessage;

  // "Silently disconnect" only applies while idle: an error that interrupted
  // something the user just asked for is always reported.
  if (!inactiveTermination && c.sessionSilentDisconnect && c.whileIdle) {
    return {
      display: false, logFailure: false, dialog: null, kind: 'silentDisconnect',
      closeOnCompletion: false, forActiveTerminal: true,
      impliedAnswer: ANSWER.ok,
      disconnectError: (e && e.message) ? String(e.message) : '',
    };
  }

  const params = new MessageParams();
  // The auto-retry countdown is offered only while the reconnect attempts are
  // still inside the configured window; past it, the user must decide.
  const withinReopenWindow =
    (!c.sessionReopenTimeout) ||
    (c.reopenElapsedMs === undefined) ||
    (c.reopenElapsedMs < c.sessionReopenTimeout);
  if (withinReopenWindow) {
    params.timeout = c.sessionReopenAutoIdleOn
      ? ((c.sessionReopenAutoIdle === undefined || c.sessionReopenAutoIdle === true)
        ? SESSION_REOPEN_AUTO_IDLE_DEFAULT_MS : (c.sessionReopenAutoIdle || 0))
      : 0;
    params.timeoutAnswer = ANSWER.retry;
    // TimeoutResponse deliberately equals TimeoutAnswer: the countdown button
    // IS the reconnect button, and letting it expire reconnects — it never
    // answers something the button does not say.
    params.timeoutResponse = params.timeoutAnswer;
  }

  let neverAskAgainQuestion = null;
  if (inactiveTermination) {
    params.params |= MP.neverAskAgainCheck;
    params.neverAskAgainTitle = ALWAYS_RECONNECT;
    params.neverAskAgainAnswer = ANSWER.retry;
    neverAskAgainQuestion = 'inactiveTermination';
  } else if (c.permanentTerminal && c.whileIdle) {
    params.params |= MP.neverAskAgainCheck;
    params.neverAskAgainTitle = NEVER_POPUP_DISCONNECT;
    params.neverAskAgainAnswer = ANSWER.ok;
    neverAskAgainQuestion = 'sessionDisconnect';
  }

  return {
    display: true, logFailure: false, kind: 'fatal',
    closeOnCompletion: false, forActiveTerminal: true,
    inactiveTermination,
    permanentTerminal: !!c.permanentTerminal,
    neverAskAgainQuestion,
    neverAskAgainAnswer: params.neverAskAgainAnswer,
    dialog: buildFatalExceptionDialog(e, QUERY_TYPE.error, {
      messageFormat: '', answers: ANSWER.ok, helpKeyword: HELP_NONE, params,
    }),
  };
}

/**
 * The second half of ShowExtendedExceptionEx: what the answer means.
 *
 * qaNeverAskAgain is resolved BACK to the answer it stood for, after recording
 * the setting — so ticking "never ask again" and pressing Yes still closes the
 * application, exactly as pressing Yes alone would.
 */
function applyExtendedExceptionAnswer(plan, answer) {
  const actions = { settings: {}, terminate: false, shutDown: false, reconnect: false, disconnect: false };
  let a = answer;

  if (a === NEVER_ASK_AGAIN) {
    if (plan.kind === 'exitOnCompletionFatal' || plan.kind === 'exitOnCompletion') {
      actions.settings.confirmExitOnCompletion = false;
      a = ANSWER.yes;
    } else if (plan.kind === 'fatal') {
      a = plan.neverAskAgainAnswer || ANSWER.ok;
      if (plan.inactiveTermination) actions.settings.sessionReopenAutoInactive = true;
      else actions.settings.sessionSilentDisconnect = true;
    }
  }

  actions.answer = a;

  if (a === ANSWER.yes) {
    // Only ever reached for a close-on-completion plan; the original asserts it.
    if (!plan.closeOnCompletion) {
      throw new UserInterfaceError('Yes is only an answer to a close-on-completion query');
    }
    actions.terminate = true;
    if (plan.terminateOperation === TERMINATE_OPERATION.shutDown) actions.shutDown = true;
  } else if (a === ANSWER.retry) {
    actions.reconnect = true;
  } else if (plan.forActiveTerminal) {
    // "Disconnect if permanent, free otherwise" — an ad-hoc session is thrown
    // away, a saved one is kept in the list showing as disconnected.
    actions.disconnect = true;
    actions.disconnectError = plan.disconnectError || '';
  }

  return actions;
}

// ===========================================================================
// Startup and shutdown — WinMain.cpp
// ===========================================================================

/** TConsoleMode (WinInterface.h:464). */
const CONSOLE_MODE = Object.freeze({
  none: 'none',
  scripting: 'scripting',
  help: 'help',
  batchSettings: 'batchSettings',
  keyGen: 'keyGen',
  fingerprintScan: 'fingerprintScan',
  dumpCallstack: 'dumpCallstack',
  info: 'info',
  comRegistration: 'comRegistration',
  copyId: 'copyId',
});

function switchLookup(switches) {
  if (!switches) return () => false;
  if (switches instanceof Map) return (n) => switches.has(String(n).toLowerCase());
  if (switches instanceof Set) return (n) => switches.has(String(n).toLowerCase());
  if (Array.isArray(switches)) {
    const set = new Set(switches.map((s) => String(s).toLowerCase()));
    return (n) => set.has(String(n).toLowerCase());
  }
  if (typeof switches.has === 'function') return (n) => switches.has(n);
  const keys = new Set(Object.keys(switches).map((k) => k.toLowerCase()));
  return (n) => keys.has(String(n).toLowerCase());
}

function switchValue(switches, name) {
  if (!switches) return undefined;
  if (switches instanceof Map) return switches.get(String(name).toLowerCase());
  if (typeof switches.value === 'function') return switches.value(name);
  if (typeof switches === 'object' && !Array.isArray(switches) && !(switches instanceof Set)) {
    for (const [k, v] of Object.entries(switches)) {
      if (k.toLowerCase() === String(name).toLowerCase()) return v;
    }
  }
  return undefined;
}

/**
 * WinMain.cpp:909. The precedence is not alphabetical and it is not arbitrary:
 * /console is tested LAST because winscp.com always passes it (to hand over
 * the console version string), so testing it first would swallow /keygen,
 * /info and every other console mode.
 */
function consoleModeFromSwitches(switches) {
  const has = switchLookup(switches);
  if (has('help') || has('h') || has('?')) return CONSOLE_MODE.help;
  if (has('batchsettings')) return CONSOLE_MODE.batchSettings;
  if (has('keygen')) return CONSOLE_MODE.keyGen;
  if (has('copyid')) return CONSOLE_MODE.copyId;
  if (has('fingerprintscan')) return CONSOLE_MODE.fingerprintScan;
  if (has('dumpcallstack')) return CONSOLE_MODE.dumpCallstack;
  if (has('info')) return CONSOLE_MODE.info;
  if (has('comregistration')) return CONSOLE_MODE.comRegistration;
  if (has('console') || has('script') || has('command')) return CONSOLE_MODE.scripting;
  return CONSOLE_MODE.none;
}

/**
 * CheckSafe (UserInterface.cpp:1488). /Unsafe is added by the URL-handler
 * registration, so it marks a command line that a WEB PAGE produced. Such a
 * command line may open a session; it may not enable logging to an arbitrary
 * path, register protocol handlers or touch the search path.
 *
 * The original deliberately does NOT warn when the check fails: a warning
 * would tell an attacker exactly which switch was rejected.
 */
function checkSafe(switches) {
  return !switchLookup(switches)('unsafe');
}

/** GetCommandLineParseUrlFlags (WinMain.cpp:93). */
const PUF = Object.freeze({
  allowStoredSiteWithProtocol: 0x01,
  unsafe: 0x02,
  parseOnly: 0x04,
});

function getCommandLineParseUrlFlags(switches) {
  return PUF.allowStoredSiteWithProtocol | (checkSafe(switches) ? 0 : PUF.unsafe);
}

/** CheckLogParam (UserInterface.cpp:1459). */
function checkLogParam(switches) {
  const value = switchValue(switches, 'log');
  const present = switchLookup(switches)('log');
  if (!present || !checkSafe(switches)) return { logging: false, file: '' };
  return { logging: true, file: String(value == null ? '' : value) };
}

/** CheckXmlLogParam (UserInterface.cpp:1469). */
function checkXmlLogParam(switches) {
  const has = switchLookup(switches);
  if (!has('xmllog') || !checkSafe(switches)) return { logging: false, file: '', required: false };
  return {
    logging: true,
    file: String(switchValue(switches, 'xmllog') || ''),
    required: has('xmllogrequired'),
  };
}

/**
 * /loglevel (WinMain.cpp:852). A '*' anywhere in the value turns SENSITIVE
 * logging on; '*-' turns it explicitly off. The numeric part must parse and be
 * at least -1, otherwise the level is left alone rather than reset to zero —
 * a typo must not silently disable logging.
 */
function parseLogLevelSwitch(value) {
  let s = String(value == null ? '' : value);
  const result = { logSensitive: null, logProtocol: null };
  const starPos = s.indexOf('*');
  if (starPos >= 0) {
    let logSensitive = true;
    s = s.slice(0, starPos) + s.slice(starPos + 1);
    if (starPos < s.length && s[starPos] === '-') {
      logSensitive = false;
      s = s.slice(0, starPos) + s.slice(starPos + 1);
    }
    s = s.trim();
    result.logSensitive = logSensitive;
  }
  if (s !== '') {
    const n = Number(s);
    if (Number.isInteger(n) && n >= -1) result.logProtocol = n;
  }
  return result;
}

/**
 * /logsize (WinMain.cpp:878). "count*size" — and note the guard: a count that
 * fails to parse becomes -1, which then suppresses BOTH settings. A malformed
 * /logsize leaves log rotation alone rather than applying half of it.
 */
function parseLogSizeSwitch(value, parseSize) {
  let s = String(value == null ? '' : value);
  let logMaxCount = 0;
  const starPos = s.indexOf('*');
  if (starPos > 0) {
    const head = s.slice(0, starPos);
    const n = Number(head);
    logMaxCount = (Number.isInteger(n) && head.trim() !== '') ? n : -1;
    s = s.slice(starPos + 1).trim();
  }
  if (logMaxCount < 0 || s === '') return { logMaxCount: null, logMaxSize: null };
  const size = parseSize ? parseSize(s) : (Number.isFinite(Number(s)) ? Number(s) : null);
  if (size === null || size === undefined || Number.isNaN(size)) {
    return { logMaxCount: null, logMaxSize: null };
  }
  return { logMaxCount, logMaxSize: size };
}

/**
 * AddStartupSequence — WinMain.cpp records a letter at each startup milestone
 * so that a slow start can be attributed afterwards. The letters and their
 * order are the original's: X (Execute), C (console decided), G (glyphs),
 * N (non-visual data), B (before login), A (after login), E (explorer),
 * R (running), I (interface started).
 */
const STARTUP_STEPS = Object.freeze({
  execute: 'X',
  commandLine: 'C',
  glyphs: 'G',
  nonVisual: 'N',
  beforeLogin: 'B',
  afterLogin: 'A',
  explorer: 'E',
  running: 'R',
  interfaceStarted: 'I',
});

/**
 * InterfaceStarted / InterfaceStartDontMeasure (WinMain.cpp:481).
 *
 * The measurement is abandoned — not merely ignored — for any run that is not
 * a normal interactive start: a console run, a maintenance task, or a
 * command-line operation. Timing those and reporting them as startup time
 * would make the statistic meaningless.
 */
class StartupTiming {
  constructor(now) {
    this.started = (typeof now === 'number') ? now : Date.now();
    this.measuring = true;
    this.sequence = '';
    this.startupSeconds = null;
  }

  add(step) {
    this.sequence += (STARTUP_STEPS[step] || step);
    return this.sequence;
  }

  dontMeasure() {
    this.measuring = false;
    this.started = 0;
  }

  /**
   * Returns the recorded startup time, or null when not measuring.
   *
   * The original signals "not measuring" by zeroing the start TDateTime; here
   * that is an explicit flag, because epoch zero is a valid JS timestamp and
   * conflating the two would silently discard a measurement in a test or on a
   * machine with a badly set clock.
   */
  interfaceStarted(now) {
    if (!this.measuring) return null;
    const at = (typeof now === 'number') ? now : Date.now();
    const tensOfSecond = Math.trunc((at - this.started) / 100);
    this.startupSeconds = Math.trunc(tensOfSecond / 10);
    this.measuring = false;
    this.add('interfaceStarted');
    return {
      seconds: this.startupSeconds,
      tenths: tensOfSecond % 10,
      sequence: this.sequence,
    };
  }
}

const READONLY_INI_FILE_OVERWRITE = (name) =>
  `**Do you want to overwrite a read-only INI file '${name}' to save your current configuration?**` +
  'This question is asked, when you hold down Shift key while closing WinSCP and your INI file ' +
  'is set read-only. Normally read-only INI files are not overwritten and any changes to ' +
  'configuration are lost when closing WinSCP.';

/**
 * CheckConfigurationForceSave (WinInterface.cpp:1459). A read-only INI file is
 * treated as a deliberate choice: WinSCP throws the session's configuration
 * changes away rather than overwriting it, and only offers to overwrite when
 * every one of these holds. Answering anything but OK keeps the file intact.
 *
 * The first condition in the original is UseAlternativeFunction() — the Shift
 * key being held as the application closes. Without it this becomes a prompt
 * on every single shutdown for anyone who has deliberately marked their INI
 * read-only, which is both a nag and a flat contradiction of the question's own
 * text ("This question is asked, when you hold down Shift key..."). It is
 * `alternativeFunction` here rather than a raw key read because the shell owns
 * the keyboard; the default is false, so a caller that does not pass it gets
 * silence rather than an unasked-for prompt.
 */
function checkConfigurationForceSave(state, ask) {
  const s = state || {};
  if (!s.alternativeFunction) return { asked: false, forceSave: false, dialog: null };
  if (!(s.persistent && s.storage === 'ini' && s.iniFileExists && !s.forceSave)) {
    return { asked: false, forceSave: false, dialog: null };
  }
  if (!s.iniFileReadOnly) return { asked: false, forceSave: false, dialog: null };
  const dialog = buildMessageDialog(
    READONLY_INI_FILE_OVERWRITE(s.iniFileName || ''), null, QUERY_TYPE.confirmation,
    ANSWER.ok | ANSWER.cancel, 'readonly_ini_file', null);
  const answer = resolveMessageAnswer(dialog, { answer: ask ? ask(dialog) : null });
  return { asked: true, forceSave: answer === ANSWER.ok, dialog };
}

/**
 * The startup branch Execute() takes, as a decision.
 *
 * The order here is the original's and it is observable: a console mode wins
 * over everything (including the maintenance switches), the maintenance
 * switches win over opening a window, and /Exit and /MaintenanceTask are
 * separate no-ops that still suppress the configuration save.
 */
function startupPlan(switches, opts) {
  const o = opts || {};
  const has = switchLookup(switches);

  const mode = consoleModeFromSwitches(switches);
  if (mode !== CONSOLE_MODE.none) {
    return { kind: 'console', mode, measureStartup: false, dontSave: false };
  }

  // [switch, task, gated on CheckSafe, suppresses the configuration save].
  // The three flags are independent and the original sets them independently:
  // /UninstallCleanup is not gated but does suppress the save; /Usage and
  // /Update are neither; the four registry/path tasks are both, and their
  // suppression only applies when the safety check passed (a refused task
  // changes nothing, so it has no reason to discard the user's settings).
  const maintenance = [
    ['uninstallcleanup', 'uninstallCleanup', false, true],
    ['registerfordefaultprotocols', 'registerForDefaultProtocols', true, true],
    ['registerasurlhandler', 'registerForDefaultProtocols', true, true],
    ['unregisterforprotocols', 'unregisterForProtocols', true, true],
    ['addsearchpath', 'addSearchPath', true, true],
    ['removesearchpath', 'removeSearchPath', true, true],
    ['importsitesifany', 'importSitesIfAny', false, false],
    ['usage', 'usage', false, false],
    ['update', 'update', false, false],
  ];
  for (const [sw, task, guarded, suppressesSave] of maintenance) {
    if (!has(sw)) continue;
    const refused = guarded && !checkSafe(switches);
    const plan = {
      kind: 'maintenance', task, mode: CONSOLE_MODE.none,
      refused: refused ? 'unsafe' : null,
      measureStartup: false,
      dontSave: suppressesSave && !refused,
    };
    if (sw === 'uninstallcleanup') {
      // The installer cannot skip this task for a silent uninstall, so it
      // signals "silent" with a mutex instead; the cleanup still runs, only
      // the dialog is suppressed.
      plan.cleanupDialog = !o.silentUninstall;
    }
    return plan;
  }

  if (o.updatesAvailableShown) {
    return { kind: 'updates', mode: CONSOLE_MODE.none, measureStartup: false, dontSave: false };
  }
  if (has('exit') || has('maintenancetask')) {
    return { kind: 'noop', mode: CONSOLE_MODE.none, measureStartup: false, dontSave: true };
  }

  const commandOperation =
    has('upload') || has('uploadifany') || has('synchronize') ||
    has('keepuptodate') || has('edit') || has('refresh');

  return {
    kind: 'interface',
    mode: CONSOLE_MODE.none,
    // A command-line operation is not a normal start, so it is not measured.
    measureStartup: !commandOperation,
    standaloneOperation: commandOperation,
    dontSave: false,
    newInstance: has('newinstance'),
  };
}

/**
 * The shutdown order from Execute()'s __finally (WinMain.cpp:1399), plus the
 * two steps that run before it.
 *
 * The __finally matters: these run even when the body threw, so a crash while
 * the explorer is up still tears the session manager down. runShutdown()
 * reproduces that — a failing step is recorded and the remaining steps still
 * run, because skipping them is how a crash becomes a hung process.
 */
const SHUTDOWN_ORDER = Object.freeze([
  'checkConfigurationForceSave',
  'updateFinalStaticUsage',
  'nonVisualDataModule',
  'releaseImagesModules',
  'glyphsModule',
  'terminalManager',
  'commandParams',
]);

function runShutdown(handlers) {
  const h = handlers || {};
  const ran = [];
  const errors = [];
  for (const step of SHUTDOWN_ORDER) {
    const fn = h[step];
    if (typeof fn !== 'function') continue;
    ran.push(step);
    try { fn(); } catch (e) { errors.push({ step, error: e }); }
  }
  return { ran, errors };
}

// ===========================================================================
// VCLCommon — the portable parts
// ===========================================================================

/** TitleSeparator (Common.cpp:38) — an en dash with spaces. */
const TITLE_SEPARATOR = ' \u2013 ';
const APP_NAME = 'WinSCP';

/**
 * FormatMainFormCaption (VCLCommon.cpp:557). The suffix is appended only when
 * it is not already there, so repeated captions do not accumulate " – WinSCP".
 */
function formatMainFormCaption(caption, sessionName, appName) {
  const app = appName || APP_NAME;
  let suffix = app;
  if (sessionName) suffix = `${sessionName}${TITLE_SEPARATOR}${suffix}`;
  const text = String(caption == null ? '' : caption);
  if (text === '') return suffix;
  const withSeparator = TITLE_SEPARATOR + suffix;
  return text.endsWith(withSeparator) ? text : text + withSeparator;
}

/** FormatFormCaption (VCLCommon.cpp:580) — only main-form-like windows get it. */
function formatFormCaption(isMainFormLike, caption, sessionName, appName) {
  if (!isMainFormLike) return String(caption == null ? '' : caption);
  return formatMainFormCaption(caption, sessionName, appName);
}

/**
 * CalculateCheckBoxWidth (VCLCommon.cpp:503). 13px box + 3px padding + 8px
 * buffer, all scaled by text height, plus the caption without its accelerator
 * marker. Our layout is CSS, but the RATIO is what stops a "never ask again"
 * check box from being clipped in a long translation, so the rule is kept.
 */
function calculateCheckBoxWidth(textWidth, scale) {
  return Math.round((13 + 3 + 8) * (scale || 1)) + (textWidth || 0);
}

/**
 * AutoSizeButton (VCLCommon.cpp:3117). A button never shrinks; it grows to fit
 * its caption, and a right-anchored button grows leftwards so it does not walk
 * off the dialog. That is the rule our button min-width must respect.
 */
function autoSizeButton(button, textWidth, scale) {
  const b = button || {};
  const minWidth = (textWidth || 0) + Math.round(2 * 8 * (scale || 1));
  if ((b.width || 0) >= minWidth) return { width: b.width || 0, left: b.left || 0, grew: false };
  const left = b.anchoredRight ? (b.left || 0) - (minWidth - (b.width || 0)) : (b.left || 0);
  return { width: minWidth, left, grew: true };
}

/** MessageDlg.cpp: never shrink a message button below 80 scaled units. */
const MESSAGE_BUTTON_MIN_WIDTH = 80;

function messageButtonWidth(textWidth, scale, opts) {
  const o = opts || {};
  const s = scale || 1;
  let width = (textWidth || 0) + Math.round(16 * s);
  if (o.elevationRequired) width += Math.round(16 * s);
  if (o.menuButton) width += Math.round(16 * s);
  if (o.splitButton) width += Math.round(15 * s);
  return Math.max(Math.round(MESSAGE_BUTTON_MIN_WIDTH * s), width);
}

/** CutFormToDesktop (VCLCommon.cpp:1949). */
function cutFormToDesktop(bounds, workarea) {
  const b = { ...bounds };
  if (b.top + b.height > workarea.bottom) b.height = workarea.bottom - b.top;
  if (b.left + b.width >= workarea.right) b.width = workarea.right - b.left;
  return b;
}

/** CenterFormOn (VCLCommon.cpp:1983) — never off the top-left of the desktop. */
function centerFormOn(bounds, centerRect, desktopRect) {
  const d = desktopRect || { left: 0, top: 0 };
  const x = Math.max(d.left, Math.trunc(((centerRect.width - bounds.width) / 2)) + centerRect.left);
  const y = Math.max(d.top, Math.trunc(((centerRect.height - bounds.height) / 2)) + centerRect.top);
  return { ...bounds, left: x, top: y };
}

/**
 * ResizeForm (VCLCommon.cpp:2020). The rules a dialog's size must obey, in the
 * original's order:
 *   1. never larger than the work area;
 *   2. never smaller than its own minimum constraints;
 *   3. re-centred on its previous position, then pulled back inside the work
 *      area — including the LEFT and TOP edges, which are not zero when a
 *      second monitor sits above or to the left of the primary one;
 *   4. re-centred again, because a minimum constraint can have made it larger
 *      than asked and it would otherwise sit off-centre.
 */
function resizeForm(bounds, width, height, workarea, constraints) {
  const c = constraints || {};
  const waWidth = workarea.right - workarea.left;
  const waHeight = workarea.bottom - workarea.top;

  let w = Math.min(width, waWidth);
  let h = Math.min(height, waHeight);
  if (c.minHeight !== undefined && h < c.minHeight) h = c.minHeight;
  if (c.minWidth !== undefined && w < c.minWidth) w = c.minWidth;
  // A pathological minimum must not defeat the desktop boundary. The outer
  // form still has to remain reachable when a layout asks for more space.
  w = Math.min(w, waWidth);
  h = Math.min(h, waHeight);

  let top = bounds.top + Math.trunc((bounds.height - h) / 2);
  let left = bounds.left + Math.trunc((bounds.width - w) / 2);
  if (top + h > workarea.bottom) top = workarea.bottom - h;
  if (left + w >= workarea.right) left = workarea.right - w;
  if (top < workarea.top) top = workarea.top;
  if (left < workarea.left) left = workarea.left;

  // The second SetBounds: the form may have come out LARGER than asked,
  // because a child control's own minimum won. The original re-centres by the
  // difference so the oversized dialog stays centred on where it was, rather
  // than hanging off one side. `constraints.actual` reports what the layout
  // really produced; without it the size is taken at face value.
  const actual = (typeof c.actual === 'function') ? c.actual(w, h) : { width: w, height: h };
  left += Math.trunc((w - actual.width) / 2);
  top += Math.trunc((h - actual.height) / 2);

  return { left, top, width: w, height: h, actualWidth: actual.width, actualHeight: actual.height };
}

/**
 * The message-dialog width rule (MessageDlg.cpp:1035). Two exceptions to the
 * maximum width, both real:
 *   - a message containing a 32-byte colon-separated fingerprint (the TLS
 *     certificate dialog) may be half again as wide, so the fingerprint is not
 *     wrapped into something a user cannot compare by eye;
 *   - a dialog whose buttons are already wider than the maximum does not
 *     squeeze its text into a narrow column beside all that empty space.
 */
const FINGERPRINT_RE = /([0-9a-fA-F]{2}[:-]){31}[0-9a-fA-F]{2}/;

function maxMessageTextWidth(message, maxDialogWidth, buttonGroupWidth, iconWidth) {
  let max = maxDialogWidth;
  if (FINGERPRINT_RE.test(String(message || ''))) max = Math.trunc((max * 3) / 2);
  const forButtons = (buttonGroupWidth || 0) - (iconWidth || 0);
  if (max < forButtons) max = forButtons;
  return max;
}

/**
 * ControlExposeLabels (VCLCommon.cpp:980). A control with no accessible name
 * of its own borrows the caption of the label that focuses it — which is what
 * makes a screen reader say "Host name, edit" instead of just "edit".
 *
 * The positional rule is the subtle part: a label ABOVE or to the LEFT of the
 * control wins outright, while a label to the right or below is only used when
 * nothing better is available. That is how a units suffix ("KB/s") loses to
 * the real caption in front of the field.
 *
 * @param root  { children: [ { kind, caption, showAccelChar, focusControl,
 *                             left, top, parent, handleAllocated, children } ] }
 * @returns Map control -> accessible name
 */
function accessibleNamesFrom(root) {
  const names = new Map();

  const walk = (control) => {
    const children = (control && control.children) || [];
    for (const child of children) {
      const focus = child && child.focusControl;
      if (child && child.kind === 'label' && focus) {
        const allocated = (focus.handleAllocated === undefined) ? true : !!focus.handleAllocated;
        if (allocated && child.parent === focus.parent) {
          const before = (child.left < focus.left) || (child.top < focus.top);
          if (before) {
            // Overwrites: a leading label always wins.
            names.set(focus, child);
          } else if (!names.has(focus)) {
            names.set(focus, child);
          }
        }
      }
      if (child && child.children) walk(child);
    }
  };
  walk(root);

  const out = new Map();
  for (const [control, label] of names) {
    const showAccel = (label.showAccelChar === undefined) ? true : !!label.showAccelChar;
    out.set(control, showAccel ? stripHotkey(label.caption) : String(label.caption || ''));
  }
  return out;
}

/** ROLE_SYSTEM_DIALOG and friends, for the roles WinSCP actually sets. */
const ACC_ROLE = Object.freeze({
  dialog: 'dialog',
  alert: 'alertdialog',
  document: 'document',
});

/**
 * The role a message dialog announces. MessageDlg.cpp sets ROLE_SYSTEM_DIALOG
 * on every message window; an error or warning is an alert dialog in ARIA
 * terms, which is the closer equivalent because it makes the reader announce
 * the message immediately.
 */
function messageDialogRole(type) {
  return (type === QUERY_TYPE.error || type === QUERY_TYPE.warning)
    ? ACC_ROLE.alert : ACC_ROLE.dialog;
}

// --- path word break (VCLCommon.cpp:1664) -----------------------------------

const PATH_WORD_DELIMITERS = '\\/ ;,.\r\n=';

function isPathWordDelimiter(ch) {
  return ch !== undefined && ch !== '' && PATH_WORD_DELIMITERS.indexOf(ch) >= 0;
}

/** WB_* codes, as the Win32 callback receives them. */
const WORD_BREAK = Object.freeze({ left: 0, right: 1, isDelimiter: 2 });

/**
 * PathWordBreakProc (VCLCommon.cpp:1680). Ctrl+Left/Right in a path field must
 * stop at each path component, not at each space — the default word break
 * treats "C:\Program Files\WinSCP" as two words. Note that WB_ISDELIMITER
 * returns the NEGATION of what the Win32 documentation says; the original says
 * so in a comment and relies on it.
 */
function pathWordBreak(text, current, code) {
  const s = String(text == null ? '' : text);
  const len = s.length;

  if (code === WORD_BREAK.isDelimiter) {
    return !isPathWordDelimiter(s[current]);
  }

  if (code === WORD_BREAK.left) {
    let cur = current;
    // Skip the run of delimiters we are sitting in.
    while (cur > 0 && isPathWordDelimiter(s[cur - 1])) cur--;
    const head = s.slice(0, Math.max(0, cur - 1));
    for (let i = head.length - 1; i >= 0; i--) {
      if (isPathWordDelimiter(head[i])) return i + 1;
    }
    return 0;
  }

  if (code === WORD_BREAK.right) {
    // Position 0 is answered 0 so that Windows asks again from 1.
    if (current === 0) return 0;
    let idx = -1;
    for (let i = current - 1; i < len; i++) {
      if (isPathWordDelimiter(s[i])) { idx = i; break; }
    }
    if (idx < 0) return len;
    let result = idx + 1;
    while (result < len && isPathWordDelimiter(s[result])) result++;
    return result;
  }

  throw new UserInterfaceError(`Unknown word break code ${code}`);
}

// --- small state helpers ----------------------------------------------------

/** TListViewCheckAll. */
const CHECK_ALL = Object.freeze({ check: 'check', uncheck: 'uncheck', toggle: 'toggle' });

/** ListViewAnyChecked (VCLCommon.cpp:1568). */
function listAnyChecked(items, checked) {
  return (items || []).some((i) => !!i.checked === !!checked);
}

/**
 * ListViewCheckAll (VCLCommon.cpp:1582). Toggle means "check everything unless
 * everything is already checked" — it is not a per-item inversion, so a mixed
 * selection becomes all-checked rather than swapping.
 */
function listCheckAll(items, mode) {
  const list = items || [];
  let check;
  if (mode === CHECK_ALL.toggle) check = listAnyChecked(list, false);
  else check = (mode === CHECK_ALL.check);
  return list.map((i) => ({ ...i, checked: check }));
}

/**
 * TAutoSwitch (Configuration.h:19) — the NUMERIC enum, which has to keep these
 * values because it matches PuTTY's FORCE_ON / FORCE_OFF / AUTO and because
 * the combo-box index below is arithmetic on it. Elsewhere in this port the
 * same tri-state is spelled with strings; this is the control mapping, not the
 * stored preference.
 */
const AUTO_SWITCH = Object.freeze({ on: 0, off: 1, auto: 2 });

/** ComboAutoSwitchLoad/Save (VCLCommon.cpp:1621) — the combo lists Auto, Off, On. */
function comboAutoSwitchIndex(value) {
  const index = 2 - value;
  return index < 0 ? 0 : index;
}

function comboAutoSwitchValue(index) {
  return 2 - index;
}

/** CheckBoxAutoSwitchLoad/Save — a tri-state check box. */
function checkBoxAutoSwitchState(value) {
  if (value === AUTO_SWITCH.on) return 'checked';
  if (value === AUTO_SWITCH.off) return 'unchecked';
  return 'indeterminate';
}

function checkBoxAutoSwitchValue(state) {
  if (state === 'checked') return AUTO_SWITCH.on;
  if (state === 'unchecked') return AUTO_SWITCH.off;
  return AUTO_SWITCH.auto;
}

/**
 * RemoveHiddenControlsFromOrder + SetVerticalControlsOrder (VCLCommon.cpp:1853).
 * Hidden controls are removed from the order FIRST, so a hidden row does not
 * leave a gap. The stacking then starts at the topmost of the visible controls,
 * not at the first one in the list.
 */
function verticalControlsOrder(controls) {
  const visible = (controls || []).filter((c) => c.visible !== false);
  if (visible.length === 0) return [];
  let top = visible[0].top;
  for (const c of visible) if (c.top < top) top = c.top;

  const out = [];
  for (let i = 0; i < visible.length; i++) {
    const c = visible[i];
    out.push({ ...c, top });
    const align = c.align || 'none';
    const next = visible[i + 1];
    if (align === 'top' || align === 'bottom' ||
        (i === visible.length - 1) || (next && next.align === 'bottom')) {
      top += c.height || 0;
    }
  }
  return out;
}

/** SetHorizontalControlsOrder (VCLCommon.cpp:1891). */
function horizontalControlsOrder(controls) {
  const visible = (controls || []).filter((c) => c.visible !== false);
  if (visible.length === 0) return [];
  let left = visible[0].left;
  for (const c of visible) if (c.left < left) left = c.left;

  const out = [];
  for (let i = 0; i < visible.length; i++) {
    const c = visible[i];
    out.push({ ...c, left });
    const align = c.align || 'none';
    const next = visible[i + 1];
    if (align === 'left' || align === 'right' ||
        (i === visible.length - 1) || (next && next.align === 'right')) {
      left += c.width || 0;
    }
    // A bottom-aligned control starts a new row at the very left.
    if ((i === visible.length - 1) || (next && next.align === 'bottom')) left = 0;
  }
  return out;
}

/**
 * IsCancelButtonBeingClicked (VCLCommon.cpp:3100). Validation on focus loss is
 * skipped when the user is on their way to Cancel — nobody should have to fix
 * a field in order to abandon a dialog.
 *
 * The original's own comment is the important part and is repeated here
 * because it changes what callers must do: the click can still be released
 * outside the button, in which case validation IS bypassed and the dialog is
 * submitted with unvalidated data anyway. Every dialog therefore has to cope
 * with unvalidated input at submit time; this is a courtesy, not a guarantee.
 */
function shouldSkipValidationOnExit(state) {
  const s = state || {};
  return !!s.cancelButtonBeingClicked;
}

module.exports = {
  // errors
  UserInterfaceError, AbortError, ExtError,
  // answers
  ANSWER, NEVER_ASK_AGAIN, ANSWER_NAME, QUERY_TYPE, MP, QP,
  HELP_NONE, HELP_INTERNAL_ERROR,
  answerNameAndCaption, answerList, answerName, answerBit, toAnswerMask,
  cancelAnswer, abortAnswer, continueAnswer, defaultAnswer, isPositiveAnswer,
  isInternalErrorHelpKeyword, mergeHelpKeyword,
  stripHotkey, hotkeyOf,
  // message dialogs
  MessageParams, neverAskAgainCaption,
  NEVER_ASK_AGAIN_QUESTIONS, mayOfferNeverAskAgain, neverAskAgainSetting,
  NEVER_ASK_AGAIN_CAPTION, NEVER_SHOW_AGAIN_CAPTION,
  buildButtons, buildMessageDialog, neverAskAgainEnablement, resolveMessageAnswer,
  simpleErrorDialog, buildNoHelpDialog,
  // timeout
  MessageTimeout, formatTimeoutCaption, timeoutAnswerFor,
  TIMEOUT_TICK_MS, TIMEOUT_SUSPEND_MS, TIMEOUT_MOUSE_THRESHOLD,
  // exceptions
  isAbort, isInternalException, exceptionMessage, exceptionMessageFormatted,
  shouldDisplayException, exceptionToMoreMessages, exceptionFullMessage,
  getExceptionHelpKeyword, formatStackTrace, appendExceptionStackTrace,
  buildExceptionDialog, buildFatalExceptionDialog,
  planExtendedException, applyExtendedExceptionAnswer, TERMINATE_OPERATION,
  SESSION_REOPEN_AUTO_IDLE_DEFAULT_MS,
  // busy / modal
  CURSOR, BusyState, OperationVisualizer, InstantOperationVisualizer, ModalState,
  INSTANT_OPERATION_MIN_MS,
  ForegroundState, GlobalMinimizeHandler, isMainFormMinimized, isMinimizeSysCommand,
  // progress
  ProgressDialogState, CANCEL_STATUS, ONCE_DONE,
  PROGRESS_DELAY_START_MS, PROGRESS_UPDATE_MS, IGNORE_CANCEL_BEFORE_FINISH_MS,
  // startup / shutdown
  CONSOLE_MODE, consoleModeFromSwitches, checkSafe, PUF, getCommandLineParseUrlFlags,
  checkLogParam, checkXmlLogParam, parseLogLevelSwitch, parseLogSizeSwitch,
  STARTUP_STEPS, StartupTiming, checkConfigurationForceSave,
  startupPlan, SHUTDOWN_ORDER, runShutdown,
  // VCLCommon
  TITLE_SEPARATOR, APP_NAME, formatMainFormCaption, formatFormCaption,
  calculateCheckBoxWidth, autoSizeButton, messageButtonWidth, MESSAGE_BUTTON_MIN_WIDTH,
  cutFormToDesktop, centerFormOn, resizeForm, maxMessageTextWidth,
  accessibleNamesFrom, ACC_ROLE, messageDialogRole,
  PATH_WORD_DELIMITERS, WORD_BREAK, isPathWordDelimiter, pathWordBreak,
  CHECK_ALL, listAnyChecked, listCheckAll,
  AUTO_SWITCH, comboAutoSwitchIndex, comboAutoSwitchValue,
  checkBoxAutoSwitchState, checkBoxAutoSwitchValue,
  verticalControlsOrder, horizontalControlsOrder, shouldSkipValidationOnExit,
};
