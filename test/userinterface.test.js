// userinterface.test.js — WinInterface.cpp, UserInterface.cpp, WinMain.cpp and
// the portable parts of VCLCommon.cpp.
//
// The rows here are the behaviours that decide what the application does when
// it cannot decide for itself: which button a closed window counts as, what a
// ticked "never ask again" turns an answer into, what a countdown answers when
// it runs out, and — the one that costs data if it is wrong — what happens
// when a user cancels in the middle of a file transfer.
'use strict';
const test = require('node:test');
const assert = require('node:assert');

const U = require('../design/main/userinterface');
const { ANSWER, NEVER_ASK_AGAIN, QUERY_TYPE, MP } = U;

// ---------------------------------------------------------------------------
// Answers, captions and order
// ---------------------------------------------------------------------------

test('answer bits keep the values the button order depends on', () => {
  assert.strictEqual(ANSWER.yes, 0x01);
  assert.strictEqual(ANSWER.no, 0x04);
  assert.strictEqual(ANSWER.ok, 0x08);
  assert.strictEqual(ANSWER.cancel, 0x10);
  assert.strictEqual(NEVER_ASK_AGAIN, 0x10000);
  // qaNeverAskAgain is above the button range so it can never be a button.
  assert.ok(NEVER_ASK_AGAIN > ANSWER.report);
});

test('answerList returns the answers in button order, not set order', () => {
  const mask = ANSWER.cancel | ANSWER.yes | ANSWER.noToAll | ANSWER.no;
  assert.deepStrictEqual(U.answerList(mask),
    [ANSWER.yes, ANSWER.no, ANSWER.cancel, ANSWER.noToAll]);
});

test('WinSCP writes its own All/YesToAll captions to dodge the Abort accelerator', () => {
  assert.strictEqual(U.answerNameAndCaption(ANSWER.all).caption, 'A&ll');
  assert.strictEqual(U.answerNameAndCaption(ANSWER.yesToAll).caption, 'Yes to A&ll');
  assert.strictEqual(U.answerNameAndCaption(ANSWER.abort).caption, '&Abort');
  // 'l' rather than 'A', so it cannot collide with Abort.
  assert.strictEqual(U.hotkeyOf(U.answerNameAndCaption(ANSWER.all).caption), 'l');
});

test('an answer with no caption is refused rather than rendered blank', () => {
  assert.throws(() => U.answerNameAndCaption(0x4000), U.UserInterfaceError);
  assert.throws(() => U.answerBit('shrug'), U.UserInterfaceError);
});

test('stripHotkey keeps a literal doubled ampersand', () => {
  assert.strictEqual(U.stripHotkey('Save && Close'), 'Save & Close');
  assert.strictEqual(U.hotkeyOf('Save && &Close'), 'C');
  assert.strictEqual(U.hotkeyOf('No accelerator'), '');
});

// ---------------------------------------------------------------------------
// CancelAnswer / AbortAnswer / ContinueAnswer
// ---------------------------------------------------------------------------

test('cancelAnswer falls through Cancel, No, Abort, OK in that order', () => {
  assert.strictEqual(U.cancelAnswer(ANSWER.yes | ANSWER.no | ANSWER.cancel), ANSWER.cancel);
  assert.strictEqual(U.cancelAnswer(ANSWER.yes | ANSWER.no), ANSWER.no);
  assert.strictEqual(U.cancelAnswer(ANSWER.abort | ANSWER.retry | ANSWER.ok), ANSWER.abort);
  assert.strictEqual(U.cancelAnswer(ANSWER.ok | ANSWER.retry), ANSWER.ok);
});

test('an OK-only question answers OK when it is dismissed — there is no "no"', () => {
  assert.strictEqual(U.cancelAnswer(ANSWER.ok), ANSWER.ok);
});

test('abortAnswer prefers Abort, otherwise defers to cancelAnswer', () => {
  assert.strictEqual(U.abortAnswer(ANSWER.abort | ANSWER.cancel), ANSWER.abort);
  assert.strictEqual(U.abortAnswer(ANSWER.no | ANSWER.cancel), ANSWER.cancel);
});

test('continueAnswer prefers Skip, then Ignore, Yes, OK, Retry, then cancels', () => {
  assert.strictEqual(U.continueAnswer(ANSWER.skip | ANSWER.ignore | ANSWER.yes), ANSWER.skip);
  assert.strictEqual(U.continueAnswer(ANSWER.ignore | ANSWER.yes), ANSWER.ignore);
  assert.strictEqual(U.continueAnswer(ANSWER.yes | ANSWER.ok), ANSWER.yes);
  assert.strictEqual(U.continueAnswer(ANSWER.ok | ANSWER.retry), ANSWER.ok);
  assert.strictEqual(U.continueAnswer(ANSWER.retry | ANSWER.cancel), ANSWER.retry);
  // Nothing to continue with: continuing means cancelling.
  assert.strictEqual(U.continueAnswer(ANSWER.no | ANSWER.cancel), ANSWER.cancel);
});

test('Yes is the default even when OK is present (the host key prompt has both)', () => {
  assert.strictEqual(U.defaultAnswer(ANSWER.yes | ANSWER.ok | ANSWER.cancel), ANSWER.yes);
  assert.strictEqual(U.defaultAnswer(ANSWER.ok | ANSWER.cancel), ANSWER.ok);
  assert.strictEqual(U.defaultAnswer(ANSWER.retry | ANSWER.abort), ANSWER.retry);
});

test('a question with no Yes/OK/Retry has no default button at all', () => {
  const d = U.buildMessageDialog('x', null, QUERY_TYPE.error,
    ANSWER.abort | ANSWER.cancel, '', new U.MessageParams({ allowHelp: false }));
  assert.deepStrictEqual(d.buttons.filter((b) => b.default), []);
});

// ---------------------------------------------------------------------------
// Building a dialog
// ---------------------------------------------------------------------------

test('every dialog grows a Help button unless the caller forbids it', () => {
  const withHelp = U.buildMessageDialog('m', null, QUERY_TYPE.confirmation, ANSWER.ok, '', null);
  assert.ok(withHelp.buttons.some((b) => b.answer === ANSWER.help));

  const noHelp = U.buildMessageDialog('m', null, QUERY_TYPE.confirmation, ANSWER.ok, '',
    new U.MessageParams({ allowHelp: false }));
  assert.ok(!noHelp.buttons.some((b) => b.answer === ANSWER.help));
});

test('an internal-error help keyword adds the Report button', () => {
  const d = U.buildMessageDialog('boom', null, QUERY_TYPE.error, ANSWER.ok,
    U.HELP_INTERNAL_ERROR, null);
  assert.ok(d.buttons.some((b) => b.answer === ANSWER.report));
  const ordinary = U.buildMessageDialog('boom', null, QUERY_TYPE.error, ANSWER.ok, 'anything', null);
  assert.ok(!ordinary.buttons.some((b) => b.answer === ANSWER.report));
});

test('Help and Report do not answer the question — they have no modal result', () => {
  const d = U.buildMessageDialog('boom', null, QUERY_TYPE.error, ANSWER.ok,
    U.HELP_INTERNAL_ERROR, null);
  const help = d.buttons.find((b) => b.answer === ANSWER.help);
  const report = d.buttons.find((b) => b.answer === ANSWER.report);
  assert.strictEqual(help.modalResult, 0);
  assert.strictEqual(report.modalResult, 0);
});

test('an empty more-messages list is no more-messages at all', () => {
  assert.strictEqual(
    U.buildMessageDialog('m', [], QUERY_TYPE.error, ANSWER.ok, '', null).moreMessages, null);
  assert.deepStrictEqual(
    U.buildMessageDialog('m', ['a', 'b'], QUERY_TYPE.error, ANSWER.ok, '', null).moreMessages,
    ['a', 'b']);
});

test('focus goes to the first button in answer order, not to the default', () => {
  // No/Cancel only: No is first, and No is also the cancel answer.
  const d = U.buildMessageDialog('m', null, QUERY_TYPE.confirmation,
    ANSWER.retry | ANSWER.no, '', new U.MessageParams({ allowHelp: false }));
  assert.strictEqual(d.activeAnswer, ANSWER.no);
  assert.strictEqual(d.defaultAnswer, ANSWER.retry);
});

test('an alias renames a button and a submit alias stops it answering', () => {
  const d = U.buildMessageDialog('done', null, QUERY_TYPE.information,
    ANSWER.ok | ANSWER.ignore, '', new U.MessageParams({
      allowHelp: false,
      aliases: [{ button: ANSWER.ignore, alias: '&Open', menuButton: true, onSubmit: 'openLocalPath' }],
    }));
  const open = d.buttons.find((b) => b.answer === ANSWER.ignore);
  assert.strictEqual(open.caption, 'Open');
  assert.strictEqual(open.accessKey, 'O');
  assert.strictEqual(open.menuButton, true);
  assert.strictEqual(open.modalResult, 0);
});

test('a grouped answer becomes a drop-down item, never a button of its own', () => {
  const d = U.buildMessageDialog('overwrite?', null, QUERY_TYPE.confirmation,
    ANSWER.yes | ANSWER.no | ANSWER.cancel | ANSWER.yesToAll, '',
    new U.MessageParams({
      allowHelp: false,
      aliases: [{ button: ANSWER.yesToAll, alias: 'Yes to A&ll', groupWith: ANSWER.yes }],
    }));
  assert.ok(!d.buttons.some((b) => b.answer === ANSWER.yesToAll));
  const yes = d.buttons.find((b) => b.answer === ANSWER.yes);
  assert.strictEqual(yes.kind, 'splitButton');
  assert.deepStrictEqual(yes.dropDown.map((i) => i.answer), [ANSWER.yes, ANSWER.yesToAll]);
  assert.strictEqual(yes.dropDown[0].default, true);
});

test('grouping is refused when it would swallow the default, cancel or timeout button', () => {
  const params = new U.MessageParams({
    allowHelp: false,
    timeout: 5000, timeoutAnswer: ANSWER.retry,
    aliases: [
      { button: ANSWER.cancel, alias: 'C', groupWith: ANSWER.yes },
      { button: ANSWER.retry, alias: 'R', groupWith: ANSWER.yes },
    ],
  });
  const d = U.buildMessageDialog('m', null, QUERY_TYPE.confirmation,
    ANSWER.yes | ANSWER.cancel | ANSWER.retry, '', params);
  // Both stay real buttons.
  assert.ok(d.buttons.some((b) => b.answer === ANSWER.cancel));
  assert.ok(d.buttons.some((b) => b.answer === ANSWER.retry));
  assert.strictEqual(d.buttons.find((b) => b.answer === ANSWER.yes).dropDown, null);
});

test('grouping with a button that does not exist leaves an ordinary button', () => {
  const d = U.buildMessageDialog('m', null, QUERY_TYPE.confirmation,
    ANSWER.no | ANSWER.cancel, '', new U.MessageParams({
      allowHelp: false,
      aliases: [{ button: ANSWER.no, alias: 'N', groupWith: ANSWER.yes }],
    }));
  const no = d.buttons.find((b) => b.answer === ANSWER.no);
  assert.ok(no);
  assert.strictEqual(no.kind, 'button');
});

test('an actionAlias renders as a link rather than a button', () => {
  const d = U.buildMessageDialog('m', null, QUERY_TYPE.information,
    ANSWER.ok | ANSWER.ignore, '', new U.MessageParams({
      allowHelp: false,
      aliases: [{ button: ANSWER.ignore, actionAlias: 'What is &this?', onSubmit: 'explain' }],
    }));
  const link = d.buttons.find((b) => b.answer === ANSWER.ignore);
  assert.strictEqual(link.kind, 'link');
  assert.strictEqual(link.caption, 'What is this?');
});

test('a link ahead of the buttons does not steal the initial focus', () => {
  // MessageDlg.cpp keeps LinkControl out of ButtonControls, so ActiveControl is
  // still the first real button. qaNo (0x04) sorts before qaOK (0x08), so the
  // link is built first here and the focus must land on OK regardless.
  const d = U.buildMessageDialog('m', null, QUERY_TYPE.information,
    ANSWER.no | ANSWER.ok, '', new U.MessageParams({
      allowHelp: false,
      aliases: [{ button: ANSWER.no, actionAlias: '&Details', onSubmit: 'details' }],
    }));
  assert.strictEqual(d.buttons[0].kind, 'link');
  assert.strictEqual(d.activeAnswer, ANSWER.ok);
});

// ---------------------------------------------------------------------------
// Never ask again
// ---------------------------------------------------------------------------

test('the check box says "never show" on a notice and "never ask" on a question', () => {
  assert.strictEqual(U.neverAskAgainCaption(ANSWER.ok, ''), U.NEVER_SHOW_AGAIN_CAPTION);
  // qaOK|qaIgnore is the custom "non-answer" button case and still counts as a notice.
  assert.strictEqual(U.neverAskAgainCaption(ANSWER.ok | ANSWER.ignore, ''), U.NEVER_SHOW_AGAIN_CAPTION);
  assert.strictEqual(U.neverAskAgainCaption(ANSWER.yes | ANSWER.no, ''), U.NEVER_ASK_AGAIN_CAPTION);
  assert.strictEqual(U.neverAskAgainCaption(ANSWER.ok, 'Always reconnect'), 'Always reconnect');
});

test('the wording is decided before Help is added, so Help does not change it', () => {
  const d = U.buildMessageDialog('done', null, QUERY_TYPE.information, ANSWER.ok, '',
    new U.MessageParams(MP.neverAskAgainCheck));
  assert.ok(d.buttons.some((b) => b.answer === ANSWER.help));
  assert.strictEqual(d.neverAskAgain.caption, U.stripHotkey(U.NEVER_SHOW_AGAIN_CAPTION));
});

test('ticking the box narrows the dialog to the single positive answer', () => {
  const d = U.buildMessageDialog('overwrite?', null, QUERY_TYPE.confirmation,
    ANSWER.yes | ANSWER.no | ANSWER.cancel, '', new U.MessageParams(MP.neverAskAgainCheck));
  const off = U.neverAskAgainEnablement(d, false);
  assert.strictEqual(off.enabled.get(ANSWER.no), true);

  const on = U.neverAskAgainEnablement(d, true);
  assert.strictEqual(on.positiveAnswer, ANSWER.yes);
  assert.strictEqual(on.enabled.get(ANSWER.yes), true);
  assert.strictEqual(on.enabled.get(ANSWER.no), false);
  // Cancel is never taken away: you may still abandon the whole operation.
  assert.strictEqual(on.enabled.get(ANSWER.cancel), true);
});

test('a submit-alias button stays enabled when the box is ticked (it answers nothing)', () => {
  const d = U.buildMessageDialog('done', null, QUERY_TYPE.information,
    ANSWER.ok | ANSWER.ignore, '', new U.MessageParams({
      params: MP.neverAskAgainCheck,
      aliases: [{ button: ANSWER.ignore, alias: '&Open', onSubmit: 'openLocalPath' }],
    }));
  const on = U.neverAskAgainEnablement(d, true);
  assert.strictEqual(on.positiveAnswer, ANSWER.ok);
  assert.strictEqual(on.enabled.get(ANSWER.ignore), true);
});

test('an explicit neverAskAgainAnswer overrides "whichever button is positive"', () => {
  const params = new U.MessageParams({
    params: MP.neverAskAgainCheck,
    neverAskAgainTitle: '&Always reconnect automatically',
    neverAskAgainAnswer: ANSWER.retry,
  });
  const d = U.buildMessageDialog('lost', null, QUERY_TYPE.error,
    ANSWER.ok | ANSWER.retry, '', params);
  const on = U.neverAskAgainEnablement(d, true);
  assert.strictEqual(on.positiveAnswer, ANSWER.retry);
  assert.strictEqual(on.enabled.get(ANSWER.retry), true);
  assert.strictEqual(on.enabled.get(ANSWER.ok), false);
});

test('a ticked box leaves only the default item in a drop-down', () => {
  const d = U.buildMessageDialog('overwrite?', null, QUERY_TYPE.confirmation,
    ANSWER.yes | ANSWER.no | ANSWER.cancel | ANSWER.yesToAll, '',
    new U.MessageParams({
      params: MP.neverAskAgainCheck,
      aliases: [{ button: ANSWER.yesToAll, alias: 'Yes to All', groupWith: ANSWER.yes }],
    }));
  const on = U.neverAskAgainEnablement(d, true);
  assert.deepStrictEqual(on.dropDown.get(ANSWER.yes),
    [{ answer: ANSWER.yes, enabled: true }, { answer: ANSWER.yesToAll, enabled: false }]);
});

test('the catalogue of questions allowed to offer "never ask again"', () => {
  assert.ok(U.mayOfferNeverAskAgain('fileOverwrite'));
  assert.ok(U.mayOfferNeverAskAgain('confirmDeleting') === false);
  assert.strictEqual(U.neverAskAgainSetting('deleteFiles'), 'confirmDeleting');
  assert.strictEqual(U.neverAskAgainSetting('somethingElse'), null);
  // Three of them do not suppress the question at all.
  assert.strictEqual(U.NEVER_ASK_AGAIN_QUESTIONS.addBookmark.suppresses, false);
  assert.strictEqual(U.NEVER_ASK_AGAIN_QUESTIONS.tooManyWatchDirectories.suppresses, false);
  assert.strictEqual(U.NEVER_ASK_AGAIN_QUESTIONS.tooManyWatchDirectories.setting, 'maxWatchDirectories');
  // The two editor-side questions that also carry the box: refusing them would
  // silently drop a check box WinSCP does render.
  assert.strictEqual(U.neverAskAgainSetting('editSessionReconnect'), 'sessionReopenAutoInactive');
  assert.strictEqual(U.neverAskAgainSetting('editorEarlyClosed'), 'editor.disableMdiDetect');
  // Every catalogued question names a setting; an entry with none would be a
  // check box whose tick has nowhere to go.
  for (const [id, q] of Object.entries(U.NEVER_ASK_AGAIN_QUESTIONS)) {
    assert.ok(q.setting && typeof q.setting === 'string', `${id} has no setting`);
    assert.ok(q.source && q.source.includes(':'), `${id} has no source`);
  }
});

test('a preference-style check box can start already ticked', () => {
  const d = U.buildMessageDialog('Add bookmark?', null, QUERY_TYPE.confirmation,
    ANSWER.yes | ANSWER.cancel, '', new U.MessageParams({
      params: MP.neverAskAgainCheck,
      neverAskAgainTitle: '&Shared bookmark',
      neverAskAgainCheckedInitially: true,
    }));
  assert.strictEqual(d.neverAskAgain.checked, true);
  assert.strictEqual(d.neverAskAgain.caption, 'Shared bookmark');
});

// ---------------------------------------------------------------------------
// Resolving the answer
// ---------------------------------------------------------------------------

test('a closed window answers CancelAnswer of what the CALLER asked for', () => {
  const d = U.buildMessageDialog('m', null, QUERY_TYPE.confirmation,
    ANSWER.yes | ANSWER.no, '', null);
  // Help was added to the dialog but must never be the answer to a dismissal.
  assert.strictEqual(U.resolveMessageAnswer(d, { answer: null }), ANSWER.no);
  assert.strictEqual(U.resolveMessageAnswer(d, {}), ANSWER.no);
});

test('dismissing an OK-only notice answers OK', () => {
  const d = U.buildMessageDialog('note', null, QUERY_TYPE.information, ANSWER.ok, '', null);
  assert.strictEqual(U.resolveMessageAnswer(d, { answer: null }), ANSWER.ok);
});

test('a ticked box turns the positive answer into qaNeverAskAgain, and only that one', () => {
  const d = U.buildMessageDialog('overwrite?', null, QUERY_TYPE.confirmation,
    ANSWER.yes | ANSWER.no | ANSWER.cancel, '', new U.MessageParams(MP.neverAskAgainCheck));
  assert.strictEqual(
    U.resolveMessageAnswer(d, { answer: ANSWER.yes, neverAskAgainChecked: true }), NEVER_ASK_AGAIN);
  assert.strictEqual(
    U.resolveMessageAnswer(d, { answer: ANSWER.no, neverAskAgainChecked: true }), ANSWER.no);
  assert.strictEqual(
    U.resolveMessageAnswer(d, { answer: ANSWER.yes, neverAskAgainChecked: false }), ANSWER.yes);
});

test('with an explicit tag, only that answer converts', () => {
  const d = U.buildMessageDialog('lost', null, QUERY_TYPE.error,
    ANSWER.ok | ANSWER.retry, '', new U.MessageParams({
      params: MP.neverAskAgainCheck, neverAskAgainAnswer: ANSWER.retry,
    }));
  assert.strictEqual(
    U.resolveMessageAnswer(d, { answer: ANSWER.retry, neverAskAgainChecked: true }), NEVER_ASK_AGAIN);
  // OK is positive, but it is not the tagged answer.
  assert.strictEqual(
    U.resolveMessageAnswer(d, { answer: ANSWER.ok, neverAskAgainChecked: true }), ANSWER.ok);
});

test('a dialog with no check box ignores a stray checked flag', () => {
  const d = U.buildMessageDialog('m', null, QUERY_TYPE.confirmation,
    ANSWER.yes | ANSWER.no, '', null);
  assert.strictEqual(
    U.resolveMessageAnswer(d, { answer: ANSWER.yes, neverAskAgainChecked: true }), ANSWER.yes);
});

test('answers can be given by name as well as by bit', () => {
  const d = U.buildMessageDialog('m', null, QUERY_TYPE.confirmation, ['yes', 'no'], '', null);
  assert.strictEqual(d.answers, ANSWER.yes | ANSWER.no);
  assert.strictEqual(U.resolveMessageAnswer(d, { answer: 'no' }), ANSWER.no);
});

// ---------------------------------------------------------------------------
// Timers and timeouts
// ---------------------------------------------------------------------------

test('a timer may replace the message, the answers and the query type', () => {
  const d = U.buildMessageDialog('original', null, QUERY_TYPE.confirmation,
    ANSWER.ok, '', new U.MessageParams({
      allowHelp: false,
      timer: 1000, timerMessage: 'still working',
      timerAnswers: ANSWER.abort | ANSWER.cancel,
      timerQueryType: QUERY_TYPE.warning,
    }));
  assert.strictEqual(d.message, 'still working');
  assert.strictEqual(d.type, QUERY_TYPE.warning);
  assert.strictEqual(d.answers, ANSWER.abort | ANSWER.cancel);
  assert.strictEqual(d.timer.interval, 1000);
});

test('a dismissal is resolved against the CALLER\'s answers, not the timer\'s', () => {
  // MoreMessageDialog hands ExecuteMessageDialog the answers it was called
  // with; the timer override never reaches it.
  // The two sets must fall out DIFFERENTLY under CancelAnswer, or the
  // assertion proves nothing: here the caller offered OK|Retry (CancelAnswer
  // -> OK) while the timer replaced the buttons with Cancel (-> Cancel).
  const d = U.buildMessageDialog('waiting', null, QUERY_TYPE.information,
    ANSWER.ok | ANSWER.retry, '', new U.MessageParams({
      allowHelp: false, timer: 500, timerAnswers: ANSWER.cancel,
    }));
  assert.strictEqual(d.answers, ANSWER.cancel, 'the dialog shows only Cancel');
  assert.strictEqual(d.requestedAnswers, ANSWER.ok | ANSWER.retry);
  assert.notStrictEqual(U.cancelAnswer(d.answers), U.cancelAnswer(d.requestedAnswers));
  assert.strictEqual(U.resolveMessageAnswer(d, { answer: null }), ANSWER.ok);

  // And the real case it exists for: the SSH stall prompt, where both sets
  // happen to resolve to Abort.
  const ssh = U.buildMessageDialog('waiting', null, QUERY_TYPE.information,
    ANSWER.retry | ANSWER.abort, '', new U.MessageParams({
      allowHelp: false, timer: 500, timerAnswers: ANSWER.abort,
    }));
  assert.strictEqual(ssh.answers, ANSWER.abort, 'the dialog shows only Abort');
  assert.strictEqual(ssh.requestedAnswers, ANSWER.retry | ANSWER.abort);
  assert.strictEqual(U.resolveMessageAnswer(ssh, { answer: null }), ANSWER.abort);
});

test('the SSH stall prompt: the countdown sits on Abort but answers No', () => {
  // TSecureShell::TimeoutPrompt. Both answers abort, but the caller counts
  // them differently — an auto-stall abort is not a user abort — so the
  // expiry must not be reported as a press of the Abort button.
  const d = U.buildMessageDialog('Host is not communicating', null, QUERY_TYPE.information,
    ANSWER.retry | ANSWER.abort, 'host_is_not_communicating', new U.MessageParams({
      allowHelp: false,
      timer: 500, timerAnswers: ANSWER.abort, timerQueryType: QUERY_TYPE.information,
      timeout: 30000, timeoutAnswer: ANSWER.abort, timeoutResponse: ANSWER.no,
    }));
  assert.strictEqual(d.timeout.button, ANSWER.abort);
  assert.strictEqual(U.timeoutAnswerFor(d, 'expired'), ANSWER.no);
  // Pressing the button itself still answers Abort.
  assert.strictEqual(U.resolveMessageAnswer(d, { answer: ANSWER.abort }), ANSWER.abort);
});

test('timerQueryType null means "do not override", not "confirmation"', () => {
  const d = U.buildMessageDialog('m', null, QUERY_TYPE.error, ANSWER.ok, '',
    new U.MessageParams({ allowHelp: false, timer: 500 }));
  assert.strictEqual(d.type, QUERY_TYPE.error);
});

test('a timeout picks the button that counts down and the answer the expiry gives', () => {
  const d = U.buildMessageDialog('reconnect?', null, QUERY_TYPE.error,
    ANSWER.ok | ANSWER.retry, '', new U.MessageParams({
      allowHelp: false, timeout: 9000, timeoutAnswer: ANSWER.retry, timeoutResponse: ANSWER.retry,
    }));
  assert.strictEqual(d.timeout.armed, true);
  assert.strictEqual(d.timeout.button, ANSWER.retry);
  assert.strictEqual(d.buttons.find((b) => b.answer === ANSWER.retry).timeout, true);
  assert.strictEqual(U.timeoutAnswerFor(d, 'expired'), ANSWER.retry);
});

test('timeoutResponse overrides the button, which is how a timeout stops meaning "yes"', () => {
  // The countdown sits on Yes but the expiry answers No: letting it run out
  // must not agree to the thing the user did not answer.
  const d = U.buildMessageDialog('overwrite?', null, QUERY_TYPE.confirmation,
    ANSWER.yes | ANSWER.no, '', new U.MessageParams({
      allowHelp: false, timeout: 5000, timeoutAnswer: ANSWER.yes, timeoutResponse: ANSWER.no,
    }));
  assert.strictEqual(d.timeout.button, ANSWER.yes);
  assert.strictEqual(d.timeout.response, ANSWER.no);
  assert.strictEqual(U.timeoutAnswerFor(d, 'expired'), ANSWER.no);
});

test('a timeout whose answer has no button is not armed and cannot expire', () => {
  const d = U.buildMessageDialog('m', null, QUERY_TYPE.error, ANSWER.ok, '',
    new U.MessageParams({ allowHelp: false, timeout: 5000, timeoutAnswer: ANSWER.retry }));
  assert.strictEqual(d.timeout.armed, false);
  assert.throws(() => U.timeoutAnswerFor(d, 'expired'), U.UserInterfaceError);
  // It still behaves as an ordinary dialog.
  assert.strictEqual(U.timeoutAnswerFor(d, 'answered', ANSWER.ok), ANSWER.ok);
});

test('expiring an aliased submit button answers nothing — it runs the alias', () => {
  const d = U.buildMessageDialog('done', null, QUERY_TYPE.information,
    ANSWER.ok | ANSWER.ignore, '', new U.MessageParams({
      allowHelp: false, timeout: 3000, timeoutAnswer: ANSWER.ignore,
      aliases: [{ button: ANSWER.ignore, alias: '&Open', onSubmit: 'openLocalPath' }],
    }));
  assert.strictEqual(d.timeout.armed, true);
  assert.strictEqual(U.timeoutAnswerFor(d, 'expired'), 0);
});

test('the countdown caption shows whole remaining seconds', () => {
  const t = new U.MessageTimeout(3000, { caption: 'Reconnect' });
  assert.strictEqual(t.caption, 'Reconnect (3 s)');
  assert.strictEqual(t.tick(), false);
  assert.strictEqual(t.caption, 'Reconnect (2 s)');
  assert.strictEqual(t.tick(), false);
  assert.strictEqual(t.remainingSeconds, 1);
  assert.strictEqual(t.tick(), true);
  assert.strictEqual(t.caption, 'Reconnect');
  // Already fired: further ticks do nothing.
  assert.strictEqual(t.tick(), false);
});

test('a keystroke or a mouse click cancels the countdown for good', () => {
  const t = new U.MessageTimeout(5000, { caption: 'Reconnect' });
  t.interrupt();
  assert.strictEqual(t.enabled, false);
  assert.strictEqual(t.tick(), false);
  assert.strictEqual(t.caption, 'Reconnect');
});

test('a real mouse move postpones the expiry to at least 30 seconds', () => {
  const t = new U.MessageTimeout(5000, { caption: 'Reconnect', cursor: { x: 100, y: 100 } });
  assert.strictEqual(t.mouseMove({ x: 104, y: 100 }), false, 'jitter under the threshold is ignored');
  assert.strictEqual(t.remaining, 5000);
  assert.strictEqual(t.mouseMove({ x: 130, y: 100 }), true);
  assert.strictEqual(t.remaining, 30000);
  assert.strictEqual(t.enabled, true, 'postponed, not cancelled');
});

test('a mouse move never shortens a timeout longer than the suspend time', () => {
  const t = new U.MessageTimeout(60000, { caption: 'Reconnect', cursor: { x: 0, y: 0 } });
  t.mouseMove({ x: 100, y: 0 });
  assert.strictEqual(t.remaining, 60000);
});

test('restart re-arms the countdown; a negative timeout disarms it', () => {
  const t = new U.MessageTimeout(2000, { caption: 'Stop' });
  t.tick(); t.tick();
  assert.strictEqual(t.fired, true);
  t.restart(3000);
  assert.strictEqual(t.enabled, true);
  assert.strictEqual(t.fired, false);
  t.restart(-1);
  assert.strictEqual(t.enabled, false);
});

test('the expiry answer prefers the response over the button', () => {
  assert.strictEqual(new U.MessageTimeout(1000, { answer: ANSWER.no }).expiryAnswer(ANSWER.yes), ANSWER.no);
  assert.strictEqual(new U.MessageTimeout(1000, {}).expiryAnswer(ANSWER.yes), ANSWER.yes);
});

// ---------------------------------------------------------------------------
// Exceptions
// ---------------------------------------------------------------------------

test('an abort is never shown — the user already knows they cancelled', () => {
  assert.strictEqual(U.shouldDisplayException(new U.AbortError('anything')), false);
  assert.strictEqual(U.exceptionMessage(new U.AbortError()).display, false);
});

test('an exception with an empty message is not shown either', () => {
  assert.strictEqual(U.shouldDisplayException(new Error('')), false);
  assert.strictEqual(U.shouldDisplayException(new Error('Permission denied')), true);
});

test('a programming error is "internal": report wording, report keyword, Report button', () => {
  const e = new TypeError('x is not a function');
  assert.strictEqual(U.isInternalException(e), true);
  const m = U.exceptionMessage(e);
  assert.ok(m.internalError);
  assert.match(m.message, /reporting the error on WinSCP support forum/);
  assert.strictEqual(U.getExceptionHelpKeyword(e), U.HELP_INTERNAL_ERROR);

  const d = U.buildExceptionDialog(e, QUERY_TYPE.error, {});
  assert.ok(d.buttons.some((b) => b.answer === ANSWER.report));
});

test('a server error is not internal and gets no Report button and no stack trace', () => {
  const e = new Error('Permission denied');
  e.stack = 'Error: Permission denied\n    at foo (C:\\x\\y.js:1:1)';
  const d = U.buildExceptionDialog(e, QUERY_TYPE.error, {});
  assert.ok(!d.buttons.some((b) => b.answer === ANSWER.report));
  assert.strictEqual(d.moreMessages, null);
});

test('an internal error attaches its stack trace to the more-info panel', () => {
  const e = new TypeError('bad');
  e.stack = 'TypeError: bad\n    at run (C:\\Users\\someone\\app\\design\\main\\x.js:12:5)';
  const d = U.buildExceptionDialog(e, QUERY_TYPE.error, {});
  assert.ok(d.moreMessages.includes('Stack trace:'));
  // The absolute path is stripped: a pasted bug report should not carry the
  // reporter's home directory.
  assert.ok(d.moreMessages.some((l) => l.includes('(x.js:12:5)')));
  assert.ok(!d.moreMessages.some((l) => l.includes('Users')));
});

test('formatStackTrace strips the C++ noise the original strips', () => {
  const out = U.formatStackTrace([
    '(WinSCP.exe) [0043210F] __fastcall Unit::Method',
    '(WinSCP.exe) [00401000] __linkproc__ Other',
  ]);
  assert.deepStrictEqual(out, ['(WinSCP.exe) Unit::Method', '(WinSCP.exe) Other']);
});

test('an ExtError carries more messages and a help keyword into the dialog', () => {
  const e = new U.ExtError('Cannot open', ['Server said: 550', 'Try again later'], 'no_such_file');
  const d = U.buildExceptionDialog(e, QUERY_TYPE.error, { answers: ANSWER.ok | ANSWER.retry });
  assert.deepStrictEqual(d.moreMessages, ['Server said: 550', 'Try again later']);
  assert.strictEqual(d.helpKeyword, 'no_such_file');
});

test('wrapping an internal error in a friendlier message keeps its Report button', () => {
  const wrapped = new U.ExtError('Could not list the directory', ['see below'], 'list_failed',
    new TypeError('x is not a function'));
  assert.strictEqual(wrapped.helpKeyword, U.HELP_INTERNAL_ERROR);
  const d = U.buildExceptionDialog(wrapped, QUERY_TYPE.error, {});
  assert.ok(d.buttons.some((b) => b.answer === ANSWER.report));
});

test('a plain wrapper with no keyword is not given a Report button by accident', () => {
  const wrapped = new U.ExtError('Could not list the directory', ['550']);
  assert.strictEqual(U.getExceptionHelpKeyword(wrapped), '');
  const d = U.buildExceptionDialog(wrapped, QUERY_TYPE.error, {});
  assert.ok(!d.buttons.some((b) => b.answer === ANSWER.report));
});

test('mergeHelpKeyword never lets a specific keyword hide an internal error', () => {
  assert.strictEqual(U.mergeHelpKeyword('mine', 'theirs'), 'mine');
  assert.strictEqual(U.mergeHelpKeyword('', 'theirs'), 'theirs');
  assert.strictEqual(U.mergeHelpKeyword('mine', U.HELP_INTERNAL_ERROR), U.HELP_INTERNAL_ERROR);
});

test('a message format wraps the unformatted exception text', () => {
  const e = new Error('Connection lost');
  const d = U.buildExceptionDialog(e, QUERY_TYPE.error, {
    messageFormat: 'Session ended.\n\n%s', answers: ANSWER.ok,
  });
  assert.strictEqual(d.message, 'Session ended.\n\nConnection lost');
});

test('building a dialog for a non-displayable exception is refused', () => {
  assert.throws(() => U.buildExceptionDialog(new U.AbortError(), QUERY_TYPE.error, {}),
    U.UserInterfaceError);
});

test('a fatal error always grows a Reconnect button', () => {
  const d = U.buildFatalExceptionDialog(new Error('Connection lost'), QUERY_TYPE.error, {
    answers: ANSWER.ok,
  });
  const retry = d.buttons.find((b) => b.answer === ANSWER.retry);
  assert.ok(retry);
  assert.strictEqual(retry.caption, 'Reconnect');
});

test('a fatal dialog refuses a caller that already supplied Retry or aliases', () => {
  assert.throws(() => U.buildFatalExceptionDialog(new Error('x'), QUERY_TYPE.error, {
    answers: ANSWER.ok | ANSWER.retry,
  }), U.UserInterfaceError);
  assert.throws(() => U.buildFatalExceptionDialog(new Error('x'), QUERY_TYPE.error, {
    answers: ANSWER.ok,
    params: new U.MessageParams({ aliases: [{ button: ANSWER.ok, alias: 'Fine' }] }),
  }), U.UserInterfaceError);
});

test('exceptionToMoreMessages and exceptionFullMessage fold the extra lines in', () => {
  const e = new U.ExtError('Cannot open', ['line 1', 'line 2']);
  assert.deepStrictEqual(U.exceptionToMoreMessages(e), ['Cannot open', 'line 1', 'line 2']);
  assert.strictEqual(U.exceptionFullMessage(e), 'Cannot open\nline 1\nline 2\n');
  assert.strictEqual(U.exceptionToMoreMessages(new U.AbortError()), null);
});

test('the no-help fallback asks before putting the message on the wire', () => {
  const d = U.buildNoHelpDialog();
  assert.strictEqual(d.answers, ANSWER.ok | ANSWER.cancel);
  // No Help button: otherwise pressing Help here would recurse.
  assert.ok(!d.buttons.some((b) => b.answer === ANSWER.help));
});

test('simpleErrorDialog is an OK-only error with the text as more messages', () => {
  const d = U.simpleErrorDialog('It broke', 'because\nreasons');
  assert.strictEqual(d.type, QUERY_TYPE.error);
  assert.strictEqual(d.answers, ANSWER.ok);
  assert.deepStrictEqual(d.moreMessages, ['because', 'reasons']);
});

// ---------------------------------------------------------------------------
// The extended-exception decision
// ---------------------------------------------------------------------------

test('/nointeractiveinput shows nothing and logs the failure instead', () => {
  const plan = U.planExtendedException(new Error('boom'), { noInteractiveInput: true, xmlLog: true });
  assert.strictEqual(plan.display, false);
  assert.strictEqual(plan.logFailure, true);
  assert.strictEqual(plan.dialog, null);

  const noLog = U.planExtendedException(new Error('boom'), { noInteractiveInput: true });
  assert.strictEqual(noLog.logFailure, false);
});

test('an ordinary error on a non-active session is just an error dialog', () => {
  const plan = U.planExtendedException(new Error('Permission denied'), {});
  assert.strictEqual(plan.kind, 'error');
  assert.strictEqual(plan.dialog.type, QUERY_TYPE.error);
  assert.strictEqual(plan.dialog.answers, ANSWER.ok);
});

test('a fatal error on the active session offers Reconnect with a countdown', () => {
  const terminal = {};
  const plan = U.planExtendedException(new Error('Connection lost'), {
    terminal, activeTerminal: terminal, fatal: true,
    sessionReopenAutoIdleOn: true, sessionReopenAutoIdle: 9000,
  });
  assert.strictEqual(plan.kind, 'fatal');
  assert.strictEqual(plan.dialog.timeout.armed, true);
  assert.strictEqual(plan.dialog.timeout.button, ANSWER.retry);
  // The countdown button IS the reconnect button; expiry cannot mean anything else.
  assert.strictEqual(plan.dialog.timeout.response, ANSWER.retry);
  assert.strictEqual(U.timeoutAnswerFor(plan.dialog, 'expired'), ANSWER.retry);
});

test('the reconnect countdown falls back to nine seconds, never to zero', () => {
  // security.sessionReopenAutoIdle is stored as the ON/OFF flag; the interval
  // has no preference yet. A zero interval would make the dialog answer itself
  // on its first tick, so the original's default is used instead.
  const terminal = {};
  const plan = U.planExtendedException(new Error('Connection lost'), {
    terminal, activeTerminal: terminal, fatal: true, sessionReopenAutoIdleOn: true,
  });
  assert.strictEqual(plan.dialog.timeout.milliseconds, U.SESSION_REOPEN_AUTO_IDLE_DEFAULT_MS);
  assert.strictEqual(U.SESSION_REOPEN_AUTO_IDLE_DEFAULT_MS, 9000);

  const off = U.planExtendedException(new Error('Connection lost'), {
    terminal, activeTerminal: terminal, fatal: true, sessionReopenAutoIdleOn: false,
  });
  assert.strictEqual(off.dialog.timeout, null, 'switched off means no countdown at all');
});

test('past the reopen timeout the countdown is not offered at all', () => {
  const terminal = {};
  const plan = U.planExtendedException(new Error('Connection lost'), {
    terminal, activeTerminal: terminal, fatal: true,
    sessionReopenAutoIdleOn: true, sessionReopenAutoIdle: 9000,
    sessionReopenTimeout: 60000, reopenElapsedMs: 120000,
  });
  assert.strictEqual(plan.dialog.timeout, null);
});

test('an inactive-termination error offers "always reconnect", tagged to Retry', () => {
  const terminal = {};
  const plan = U.planExtendedException(new Error('Session idle'), {
    terminal, activeTerminal: terminal, fatal: true, inactiveTerminationMessage: true,
  });
  assert.strictEqual(plan.neverAskAgainQuestion, 'inactiveTermination');
  assert.strictEqual(plan.dialog.neverAskAgain.caption, 'Always reconnect automatically');
  assert.strictEqual(plan.dialog.neverAskAgain.answer, ANSWER.retry);

  const actions = U.applyExtendedExceptionAnswer(plan, NEVER_ASK_AGAIN);
  assert.strictEqual(actions.settings.sessionReopenAutoInactive, true);
  assert.strictEqual(actions.reconnect, true);
});

test('a permanent session, disconnected while idle, may be told never to popup again', () => {
  const terminal = {};
  const plan = U.planExtendedException(new Error('Connection lost'), {
    terminal, activeTerminal: terminal, fatal: true, permanentTerminal: true, whileIdle: true,
  });
  assert.strictEqual(plan.neverAskAgainQuestion, 'sessionDisconnect');
  assert.strictEqual(plan.dialog.neverAskAgain.caption, 'Never popup disconnect messages');

  const actions = U.applyExtendedExceptionAnswer(plan, NEVER_ASK_AGAIN);
  assert.strictEqual(actions.settings.sessionSilentDisconnect, true);
  assert.strictEqual(actions.answer, ANSWER.ok);
  assert.strictEqual(actions.disconnect, true);
});

test('silent disconnect applies only while idle, never to an error the user provoked', () => {
  const terminal = {};
  const idle = U.planExtendedException(new Error('Connection lost'), {
    terminal, activeTerminal: terminal, fatal: true,
    sessionSilentDisconnect: true, whileIdle: true,
  });
  assert.strictEqual(idle.display, false);
  assert.strictEqual(idle.kind, 'silentDisconnect');
  assert.strictEqual(idle.disconnectError, 'Connection lost');

  const busy = U.planExtendedException(new Error('Connection lost'), {
    terminal, activeTerminal: terminal, fatal: true,
    sessionSilentDisconnect: true, whileIdle: false,
  });
  assert.strictEqual(busy.display, true);
  assert.strictEqual(busy.kind, 'fatal');
});

test('a finished command-line transfer asks before closing, and offers to open the folder', () => {
  const plan = U.planExtendedException(new Error('Transfer done'), {
    terminate: { operation: U.TERMINATE_OPERATION.disconnect, targetLocalPath: 'C:\\dl', destLocalFileName: 'C:\\dl\\a.txt' },
    confirmExitOnCompletion: true,
  });
  assert.strictEqual(plan.kind, 'exitOnCompletion');
  assert.ok(plan.dialog.buttons.some((b) => b.answer === ANSWER.ignore && b.caption === 'Open'));
  assert.ok(plan.dialog.neverAskAgain);
  assert.strictEqual(plan.suspendFirst, false);
});

test('the Open button is withheld when the active session is the one that died', () => {
  const terminal = {};
  const plan = U.planExtendedException(new Error('Transfer done'), {
    terminal, activeTerminal: terminal, fatal: true, sessionCount: 3,
    terminate: { operation: U.TERMINATE_OPERATION.disconnect, targetLocalPath: 'C:\\dl' },
    confirmExitOnCompletion: true,
  });
  assert.strictEqual(plan.kind, 'exitOnCompletionFatal');
  assert.ok(!plan.dialog.buttons.some((b) => b.answer === ANSWER.ignore));
  assert.match(plan.dialog.message, /terminate 2 remaining session/);
  assert.ok(plan.dialog.buttons.some((b) => b.answer === ANSWER.retry), 'still fatal, still reconnectable');
});

test('with the confirmation switched off the application just closes', () => {
  const plan = U.planExtendedException(new Error('Transfer done'), {
    terminate: { operation: U.TERMINATE_OPERATION.disconnect },
    confirmExitOnCompletion: false,
  });
  assert.strictEqual(plan.dialog, null);
  assert.strictEqual(plan.impliedAnswer, ANSWER.yes);
  const actions = U.applyExtendedExceptionAnswer(plan, ANSWER.yes);
  assert.strictEqual(actions.terminate, true);
  assert.strictEqual(actions.shutDown, false);
});

test('a suspend-on-completion suspends BEFORE asking, so the prompt survives the wake', () => {
  const plan = U.planExtendedException(new Error('done'), {
    terminate: { operation: U.TERMINATE_OPERATION.suspend },
    confirmExitOnCompletion: true,
  });
  assert.strictEqual(plan.suspendFirst, true);
});

test('a shutdown-on-completion shuts the machine down after terminating', () => {
  const plan = U.planExtendedException(new Error('done'), {
    terminate: { operation: U.TERMINATE_OPERATION.shutDown },
    confirmExitOnCompletion: false,
  });
  const actions = U.applyExtendedExceptionAnswer(plan, ANSWER.yes);
  assert.strictEqual(actions.terminate, true);
  assert.strictEqual(actions.shutDown, true);
});

test('ticking "never ask" on the exit question still exits, and records the setting', () => {
  const plan = U.planExtendedException(new Error('done'), {
    terminate: { operation: U.TERMINATE_OPERATION.disconnect },
    confirmExitOnCompletion: true,
  });
  const actions = U.applyExtendedExceptionAnswer(plan, NEVER_ASK_AGAIN);
  assert.strictEqual(actions.settings.confirmExitOnCompletion, false);
  assert.strictEqual(actions.terminate, true);
});

test('Yes is refused as an answer to anything but a close-on-completion query', () => {
  const plan = U.planExtendedException(new Error('boom'), {});
  assert.throws(() => U.applyExtendedExceptionAnswer(plan, ANSWER.yes), U.UserInterfaceError);
});

// ---------------------------------------------------------------------------
// Busy cursor and modal state
// ---------------------------------------------------------------------------

test('the busy cursor restores what it saved, not "the previous one"', () => {
  const busy = new U.BusyState();
  const outer = busy.start();
  assert.strictEqual(busy.cursor, U.CURSOR.hourGlass);
  const inner = busy.start();
  busy.end(inner);
  // The inner scope saved the hourglass, so ending it keeps us busy.
  assert.strictEqual(busy.cursor, U.CURSOR.hourGlass);
  busy.end(outer);
  assert.strictEqual(busy.cursor, U.CURSOR.default);
});

test('an operation visualizer can decline the busy cursor and disposes once', () => {
  const busy = new U.BusyState();
  const quiet = new U.OperationVisualizer(busy, false);
  assert.strictEqual(busy.cursor, U.CURSOR.default);
  quiet.dispose(); quiet.dispose();

  const loud = new U.OperationVisualizer(busy, true);
  assert.strictEqual(busy.busy, true);
  loud.dispose();
  assert.strictEqual(busy.busy, false);
});

test('an instant operation keeps its feedback up for a quarter of a second', () => {
  const v = new U.InstantOperationVisualizer(1000);
  assert.strictEqual(v.remainingMs(1000), 250);
  assert.strictEqual(v.remainingMs(1100), 150);
  assert.strictEqual(v.remainingMs(1250), 0);
  assert.strictEqual(v.remainingMs(5000), 0);
});

test('showing as modal counts the level and resets the cursor, hiding restores it', () => {
  const busy = new U.BusyState();
  const modal = new U.ModalState(busy);
  const token = busy.start();
  assert.strictEqual(busy.cursor, U.CURSOR.hourGlass);

  const storage = modal.showAsModal('progress');
  assert.strictEqual(modal.modalLevel, 1);
  assert.strictEqual(busy.cursor, U.CURSOR.default, 'a modal window must not inherit the hourglass');
  assert.strictEqual(modal.focusedForm, 'progress');

  modal.hideAsModal(storage);
  assert.strictEqual(modal.modalLevel, 0);
  assert.strictEqual(busy.cursor, U.CURSOR.hourGlass);
  assert.strictEqual(modal.focusedForm, null);
  busy.end(token);
});

test('releaseAsModal tolerates a window that was never shown', () => {
  const modal = new U.ModalState();
  assert.strictEqual(modal.releaseAsModal(null), false);
  assert.throws(() => modal.hideAsModal(null), U.UserInterfaceError);
});

test('showAsModal without triggering modal-started does not raise the level', () => {
  const modal = new U.ModalState();
  const s = modal.showAsModal('f', { triggerModalStarted: false });
  assert.strictEqual(modal.modalLevel, 0);
  modal.hideAsModal(s);
  assert.strictEqual(modal.modalLevel, 0);
});

// ---------------------------------------------------------------------------
// Foreground, flashing, minimize
// ---------------------------------------------------------------------------

test('the taskbar does not flash during startup or when we are already in front', () => {
  const fg = new U.ForegroundState();
  assert.strictEqual(fg.shouldFlash({ flashTaskbar: true, foregroundTask: false }), true);
  fg.setOnForeground(true);
  assert.strictEqual(fg.shouldFlash({ flashTaskbar: true, foregroundTask: false }), false);
  fg.setOnForeground(false);
  assert.strictEqual(fg.shouldFlash({ flashTaskbar: true, foregroundTask: true }), false);
  assert.strictEqual(fg.shouldFlash({ flashTaskbar: false }), false);
});

test('the first registered minimize handler wins and only it can clear itself', () => {
  const h = new U.GlobalMinimizeHandler();
  const first = () => {};
  const second = () => {};
  assert.strictEqual(h.set(first), true);
  assert.strictEqual(h.set(second), false);
  assert.strictEqual(h.clear(second), false);
  assert.strictEqual(h.clear(first), true);
  assert.strictEqual(h.call(null), false);
});

test('either the application or the main window being iconic counts as minimized', () => {
  assert.strictEqual(U.isMainFormMinimized({ applicationMinimized: true }), true);
  assert.strictEqual(U.isMainFormMinimized({ mainFormMinimized: true }), true);
  assert.strictEqual(U.isMainFormMinimized({}), false);
  assert.strictEqual(U.isMinimizeSysCommand(0xF020), true);
  assert.strictEqual(U.isMinimizeSysCommand(0xF022), true, 'the low nibble is ignored');
  assert.strictEqual(U.isMinimizeSysCommand(0xF030), false);
});

// ---------------------------------------------------------------------------
// The progress window
// ---------------------------------------------------------------------------

test('a fast operation never flashes a progress window', () => {
  const p = new U.ProgressDialogState({ now: 1000 });
  assert.strictEqual(p.setData(1400), false, 'under half a second: stay hidden');
  assert.strictEqual(p.dataReceived, false);
  assert.strictEqual(p.setData(1600), true);
  assert.strictEqual(p.dataReceived, true);
  // Once shown it does not report "show" again.
  assert.strictEqual(p.setData(2000), false);
});

test('the progress window waits while the application is minimized', () => {
  const p = new U.ProgressDialogState({ now: 0 });
  p.dataGot = true;
  assert.strictEqual(p.receiveData(false, 0, 5000, { applicationMinimized: true }), false);
  assert.strictEqual(p.receiveData(false, 0, 5000, {}), true);
});

test('the progress window does not pop up over a dialog that opened after it started', () => {
  const p = new U.ProgressDialogState({ now: 0 });
  p.dataGot = true;
  // First call at a moment it would not yet show: it records the modal level.
  assert.strictEqual(p.receiveData(false, 0, 100, { applicationModalLevel: 0 }), false);
  assert.strictEqual(p.modalLevel, 0);
  // A confirmation dialog has since opened; the progress window stays put.
  assert.strictEqual(p.receiveData(false, 0, 5000, { applicationModalLevel: 1 }), false);
  assert.strictEqual(p.dataReceived, false);
});

test('the modal-begin hook shows the window before the dialog it would hide behind', () => {
  const p = new U.ProgressDialogState({ now: 0 });
  p.dataGot = true;
  // The level was already incremented for a dialog that does not exist yet,
  // which is what the -1 offset compensates for.
  assert.strictEqual(p.applicationModalBegin(100, { applicationModalLevel: 1 }), true);
  assert.strictEqual(p.dataReceived, true);
});

test('the progress window repaints once a second, not once a tick', () => {
  const p = new U.ProgressDialogState({ now: 0 });
  p.dataReceived = true;
  assert.strictEqual(p.advanceUpdateTimer(200), false);
  assert.strictEqual(p.advanceUpdateTimer(200), false);
  assert.strictEqual(p.advanceUpdateTimer(600), true);
  assert.strictEqual(p.advanceUpdateTimer(200), false);
});

test('cancelling in mid-file asks a three-way question instead of just stopping', () => {
  const p = new U.ProgressDialogState({ now: 0 });
  p.dataReceived = true;
  const asked = [];
  const r = p.cancelOperation((d) => { asked.push(d); return ANSWER.yes; },
    { transferringFile: true, timeExpectedMs: 10000 });
  assert.strictEqual(r.asked, true);
  assert.strictEqual(asked[0].type, QUERY_TYPE.warning);
  assert.strictEqual(asked[0].answers, ANSWER.yes | ANSWER.no | ANSWER.cancel);
  assert.strictEqual(p.cancel, U.CANCEL_STATUS.cancelTransfer);
});

test('"No" to that question finishes the current file first', () => {
  const p = new U.ProgressDialogState({ now: 0 });
  p.dataReceived = true;
  p.cancelOperation(() => ANSWER.no, { transferringFile: true, timeExpectedMs: 10000 });
  assert.strictEqual(p.cancel, U.CANCEL_STATUS.cancel);
});

test('dismissing the cancel question does NOT cancel — the transfer continues', () => {
  const p = new U.ProgressDialogState({ now: 0 });
  p.dataReceived = true;
  // Closing with the X resolves to Cancel, which here means "keep going".
  const r = p.cancelOperation(() => null, { transferringFile: true, timeExpectedMs: 10000 });
  assert.strictEqual(r.cancel, U.CANCEL_STATUS.continue);
  assert.strictEqual(r.changed, false);
});

test('a file about to finish is cancelled without asking anything', () => {
  const p = new U.ProgressDialogState({ now: 0 });
  p.dataReceived = true;
  const r = p.cancelOperation(() => { throw new Error('must not ask'); },
    { transferringFile: true, timeExpectedMs: 1000 });
  assert.strictEqual(r.asked, false);
  assert.strictEqual(p.cancel, U.CANCEL_STATUS.cancel);
});

test('not transferring a file at all: cancel is immediate', () => {
  const p = new U.ProgressDialogState({ now: 0 });
  p.dataReceived = true;
  const r = p.cancelOperation(() => { throw new Error('must not ask'); }, { transferringFile: false });
  assert.strictEqual(r.asked, false);
  assert.strictEqual(p.cancel, U.CANCEL_STATUS.cancel);
});

test('cancel escalates and never de-escalates; only a file cancel can be taken back', () => {
  const p = new U.ProgressDialogState({ now: 0 });
  assert.strictEqual(p.setCancelLower(U.CANCEL_STATUS.cancelFile), true);
  assert.strictEqual(p.clearCancel(), true);
  assert.strictEqual(p.cancel, U.CANCEL_STATUS.continue);

  p.setCancelLower(U.CANCEL_STATUS.cancelTransfer);
  assert.strictEqual(p.setCancelLower(U.CANCEL_STATUS.cancel), false, 'never weaken a cancel');
  assert.strictEqual(p.cancel, U.CANCEL_STATUS.cancelTransfer);
  assert.strictEqual(p.clearCancel(), false, 'a transfer cancel cannot be taken back');
});

test('a second cancel while the question is up does nothing', () => {
  const p = new U.ProgressDialogState({ now: 0 });
  p.dataReceived = true;
  let depth = 0;
  const r = p.cancelOperation(() => {
    depth++;
    const inner = p.cancelOperation(() => ANSWER.yes, { transferringFile: true, timeExpectedMs: 9000 });
    assert.strictEqual(inner.asked, false);
    return ANSWER.no;
  }, { transferringFile: true, timeExpectedMs: 9000 });
  assert.strictEqual(depth, 1);
  assert.strictEqual(r.cancel, U.CANCEL_STATUS.cancel);
  assert.strictEqual(p.suspended, false, 'the suspend is released even so');
});

test('which progress commands are available follows the cancel state', () => {
  const p = new U.ProgressDialogState({ now: 0 });
  assert.deepStrictEqual(p.controlState(),
    { cancel: true, skip: true, moveToQueue: true, minimize: true });

  p.setCancelLower(U.CANCEL_STATUS.cancelFile);
  const afterFile = p.controlState();
  assert.strictEqual(afterFile.cancel, true);
  assert.strictEqual(afterFile.skip, false, 'already skipping this file');
  assert.strictEqual(afterFile.moveToQueue, false);

  p.setCancelLower(U.CANCEL_STATUS.cancel);
  assert.strictEqual(p.controlState().cancel, false);
});

test('a read-only progress window offers nothing', () => {
  const p = new U.ProgressDialogState({ now: 0 });
  p.setOnceDoneOperation(U.ONCE_DONE.disconnect);
  assert.strictEqual(p.onceDoneOperation, U.ONCE_DONE.disconnect);
  p.setReadOnly(true);
  assert.strictEqual(p.setOnceDoneOperation(U.ONCE_DONE.shutDown), false);
  const state = p.controlState();
  assert.strictEqual(state.cancel, false);
  assert.strictEqual(state.skip, false);
});

test('the once-done choice is kept ON the way into read-only and reset on the way out', () => {
  // Progress.cpp:647 — SetReadOnly resets only when the value CHANGES and only
  // when it becomes writable. The choice being kept or dropped is "shut the
  // machine down when this finishes", so the direction is not cosmetic:
  // clearing it on the way in would drop the caller's InitialOnceDoneOperation
  // (CustomScpExplorer.cpp:1626 sets it, :2237 marks the window read-only a
  // moment later), and NOT clearing it on the way out would hand the user a
  // window still carrying a decision taken for somebody else's operation.
  const p = new U.ProgressDialogState({ now: 0 });
  p.setOnceDoneOperation(U.ONCE_DONE.shutDown);
  assert.strictEqual(p.setReadOnly(true), true);
  assert.strictEqual(p.onceDoneOperation, U.ONCE_DONE.shutDown, 'kept while read-only');
  assert.strictEqual(p.setReadOnly(true), false, 'no change, no reset');
  assert.strictEqual(p.onceDoneOperation, U.ONCE_DONE.shutDown);
  assert.strictEqual(p.setReadOnly(false), true);
  assert.strictEqual(p.onceDoneOperation, U.ONCE_DONE.idle, 'reset on becoming writable');
});

test('taking a file cancel back raises the pending skip until the file changes', () => {
  // Progress.cpp:769 — ClearCancel sets FPendingSkip, which is what stops the
  // user queueing a second Skip against a file the file system has already
  // agreed to skip. UpdateControls lowers it again when the displayed file
  // name (:300) or the operation (:161) changes.
  const p = new U.ProgressDialogState({ now: 0 });
  p.setCancelLower(U.CANCEL_STATUS.cancelFile);
  assert.strictEqual(p.clearCancel(), true);
  assert.strictEqual(p.cancel, U.CANCEL_STATUS.continue);
  assert.strictEqual(p.pendingSkip, true);

  const pending = p.controlState();
  assert.strictEqual(pending.skip, false, 'Skip is not offered twice for one file');
  assert.strictEqual(pending.moveToQueue, false);
  assert.strictEqual(pending.cancel, true, 'the whole operation can still be cancelled');

  assert.strictEqual(p.noteFileChanged(), true);
  assert.strictEqual(p.pendingSkip, false);
  assert.strictEqual(p.controlState().skip, true, 'the next file may be skipped');
});

// ---------------------------------------------------------------------------
// Startup and shutdown
// ---------------------------------------------------------------------------

test('/console is tested last, because winscp.com always passes it', () => {
  assert.strictEqual(U.consoleModeFromSwitches({ console: '5.21', keygen: '' }), U.CONSOLE_MODE.keyGen);
  assert.strictEqual(U.consoleModeFromSwitches({ console: '5.21', info: '' }), U.CONSOLE_MODE.info);
  assert.strictEqual(U.consoleModeFromSwitches({ console: '5.21' }), U.CONSOLE_MODE.scripting);
  assert.strictEqual(U.consoleModeFromSwitches({ script: 's.txt' }), U.CONSOLE_MODE.scripting);
  assert.strictEqual(U.consoleModeFromSwitches({ '?': '' }), U.CONSOLE_MODE.help);
  assert.strictEqual(U.consoleModeFromSwitches({}), U.CONSOLE_MODE.none);
});

test('CheckSafe refuses a command line that came from a web page', () => {
  assert.strictEqual(U.checkSafe({}), true);
  assert.strictEqual(U.checkSafe({ unsafe: '' }), false);
  assert.strictEqual(U.checkSafe(new Set(['unsafe'])), false);
  assert.strictEqual(U.checkSafe(['Unsafe']), false, 'switch names are case-insensitive');
});

test('an unsafe command line is parsed with the unsafe URL flag', () => {
  assert.strictEqual(U.getCommandLineParseUrlFlags({}), U.PUF.allowStoredSiteWithProtocol);
  assert.strictEqual(U.getCommandLineParseUrlFlags({ unsafe: '' }),
    U.PUF.allowStoredSiteWithProtocol | U.PUF.unsafe);
});

test('an unsafe command line may not enable logging to a path of its choosing', () => {
  assert.deepStrictEqual(U.checkLogParam({ log: 'C:\\a.log' }), { logging: true, file: 'C:\\a.log' });
  assert.deepStrictEqual(U.checkLogParam({ log: 'C:\\a.log', unsafe: '' }), { logging: false, file: '' });
  assert.deepStrictEqual(U.checkLogParam({}), { logging: false, file: '' });
});

test('the XML log switch carries its "required" companion, and is gated too', () => {
  assert.deepStrictEqual(U.checkXmlLogParam({ xmllog: 'x.xml', xmllogrequired: '' }),
    { logging: true, file: 'x.xml', required: true });
  assert.deepStrictEqual(U.checkXmlLogParam({ xmllog: 'x.xml', unsafe: '' }),
    { logging: false, file: '', required: false });
});

test('/loglevel: a star turns sensitive logging on, star-minus turns it off', () => {
  assert.deepStrictEqual(U.parseLogLevelSwitch('*'), { logSensitive: true, logProtocol: null });
  assert.deepStrictEqual(U.parseLogLevelSwitch('*2'), { logSensitive: true, logProtocol: 2 });
  assert.deepStrictEqual(U.parseLogLevelSwitch('2*-'), { logSensitive: false, logProtocol: 2 });
  assert.deepStrictEqual(U.parseLogLevelSwitch('1'), { logSensitive: null, logProtocol: 1 });
  assert.deepStrictEqual(U.parseLogLevelSwitch('-1'), { logSensitive: null, logProtocol: -1 });
});

test('/loglevel leaves the level alone rather than resetting it on a typo', () => {
  assert.deepStrictEqual(U.parseLogLevelSwitch('-2'), { logSensitive: null, logProtocol: null });
  assert.deepStrictEqual(U.parseLogLevelSwitch('loud'), { logSensitive: null, logProtocol: null });
  assert.deepStrictEqual(U.parseLogLevelSwitch(''), { logSensitive: null, logProtocol: null });
});

test('/logsize applies both halves or neither', () => {
  const parseSize = (s) => (/^\d+$/.test(s) ? Number(s) : null);
  assert.deepStrictEqual(U.parseLogSizeSwitch('5*10240', parseSize),
    { logMaxCount: 5, logMaxSize: 10240 });
  assert.deepStrictEqual(U.parseLogSizeSwitch('10240', parseSize),
    { logMaxCount: 0, logMaxSize: 10240 });
  // A malformed count discards the size too, rather than rotating unboundedly.
  assert.deepStrictEqual(U.parseLogSizeSwitch('x*10240', parseSize),
    { logMaxCount: null, logMaxSize: null });
  assert.deepStrictEqual(U.parseLogSizeSwitch('5*nope', parseSize),
    { logMaxCount: null, logMaxSize: null });
});

test('the startup sequence records a letter per milestone', () => {
  const t = new U.StartupTiming(0);
  t.add('execute'); t.add('commandLine'); t.add('beforeLogin'); t.add('running');
  assert.strictEqual(t.sequence, 'XCBR');
  const measured = t.interfaceStarted(2400);
  assert.strictEqual(measured.seconds, 2);
  assert.strictEqual(measured.tenths, 4);
  assert.strictEqual(measured.sequence, 'XCBRI');
});

test('a console or command-line run abandons the startup measurement entirely', () => {
  const t = new U.StartupTiming(0);
  t.dontMeasure();
  assert.strictEqual(t.interfaceStarted(5000), null);
});

test('a read-only INI file is only overwritten when the user says so', () => {
  const base = {
    alternativeFunction: true,
    persistent: true, storage: 'ini', iniFileExists: true, forceSave: false,
    iniFileReadOnly: true, iniFileName: 'C:\\WinSCP.ini',
  };
  assert.strictEqual(U.checkConfigurationForceSave(base, () => ANSWER.ok).forceSave, true);
  assert.strictEqual(U.checkConfigurationForceSave(base, () => ANSWER.cancel).forceSave, false);
  // Dismissing keeps the file intact.
  assert.strictEqual(U.checkConfigurationForceSave(base, () => null).forceSave, false);
  // UseAlternativeFunction() is the FIRST condition in the original: the
  // question belongs to a Shift-held shutdown, and asking it on every ordinary
  // one would nag anyone who marked their INI read-only on purpose.
  assert.strictEqual(
    U.checkConfigurationForceSave({ ...base, alternativeFunction: false },
      () => { throw new Error('must not ask'); }).asked,
    false);
});

test('a writable INI file, a registry store or an already-forced save is not asked about', () => {
  const base = {
    alternativeFunction: true,
    persistent: true, storage: 'ini', iniFileExists: true, forceSave: false,
  };
  const boom = () => { throw new Error('must not ask'); };
  assert.strictEqual(U.checkConfigurationForceSave({ ...base, iniFileReadOnly: false }, boom).asked, false);
  assert.strictEqual(U.checkConfigurationForceSave({ ...base, storage: 'registry', iniFileReadOnly: true }, boom).asked, false);
  assert.strictEqual(U.checkConfigurationForceSave({ ...base, forceSave: true, iniFileReadOnly: true }, boom).asked, false);
  assert.strictEqual(U.checkConfigurationForceSave({ ...base, persistent: false, iniFileReadOnly: true }, boom).asked, false);
});

test('a console mode beats every maintenance switch', () => {
  const plan = U.startupPlan({ keygen: 'id', addsearchpath: '' });
  assert.strictEqual(plan.kind, 'console');
  assert.strictEqual(plan.mode, U.CONSOLE_MODE.keyGen);
});

test('the registry and search-path tasks are refused for an unsafe command line', () => {
  for (const sw of ['registerfordefaultprotocols', 'registerasurlhandler',
    'unregisterforprotocols', 'addsearchpath', 'removesearchpath']) {
    const plan = U.startupPlan({ [sw]: '', unsafe: '' });
    assert.strictEqual(plan.refused, 'unsafe', sw);
    assert.strictEqual(plan.dontSave, false, `${sw}: a refused task changes nothing`);
  }
});

test('/UninstallCleanup is not gated but still suppresses the configuration save', () => {
  const plan = U.startupPlan({ uninstallcleanup: '', unsafe: '' });
  assert.strictEqual(plan.refused, null);
  assert.strictEqual(plan.dontSave, true);
  assert.strictEqual(plan.cleanupDialog, true);
  assert.strictEqual(U.startupPlan({ uninstallcleanup: '' }, { silentUninstall: true }).cleanupDialog, false);
});

test('/Usage and /Update run and DO save; /Exit does neither', () => {
  assert.strictEqual(U.startupPlan({ usage: 'x' }).dontSave, false);
  assert.strictEqual(U.startupPlan({ update: '' }).dontSave, false);
  const exit = U.startupPlan({ exit: '' });
  assert.strictEqual(exit.kind, 'noop');
  assert.strictEqual(exit.dontSave, true);
});

test('a command-line operation opens the interface but is not measured as a startup', () => {
  const upload = U.startupPlan({ upload: 'a.txt' });
  assert.strictEqual(upload.kind, 'interface');
  assert.strictEqual(upload.standaloneOperation, true);
  assert.strictEqual(upload.measureStartup, false);

  const normal = U.startupPlan({});
  assert.strictEqual(normal.standaloneOperation, false);
  assert.strictEqual(normal.measureStartup, true);
});

test('shutdown runs in the original order and finishes even when a step throws', () => {
  const seen = [];
  const { ran, errors } = U.runShutdown({
    checkConfigurationForceSave: () => seen.push('config'),
    updateFinalStaticUsage: () => seen.push('usage'),
    nonVisualDataModule: () => { seen.push('nonVisual'); throw new Error('boom'); },
    glyphsModule: () => seen.push('glyphs'),
    terminalManager: () => seen.push('terminals'),
  });
  assert.deepStrictEqual(seen, ['config', 'usage', 'nonVisual', 'glyphs', 'terminals']);
  assert.deepStrictEqual(ran,
    ['checkConfigurationForceSave', 'updateFinalStaticUsage', 'nonVisualDataModule',
      'glyphsModule', 'terminalManager']);
  assert.strictEqual(errors.length, 1);
  assert.strictEqual(errors[0].step, 'nonVisualDataModule');
});

test('the session manager is torn down before the command parameters', () => {
  assert.ok(U.SHUTDOWN_ORDER.indexOf('terminalManager') < U.SHUTDOWN_ORDER.indexOf('commandParams'));
  assert.ok(U.SHUTDOWN_ORDER.indexOf('checkConfigurationForceSave') === 0);
});

// ---------------------------------------------------------------------------
// VCLCommon — captions, sizing, accessibility, word break
// ---------------------------------------------------------------------------

test('the window caption gains the app suffix once, not once per update', () => {
  assert.strictEqual(U.formatMainFormCaption('/home/me', 'prod'), '/home/me \u2013 prod \u2013 WinSCP');
  assert.strictEqual(U.formatMainFormCaption('', 'prod'), 'prod \u2013 WinSCP');
  assert.strictEqual(U.formatMainFormCaption('', ''), 'WinSCP');
  const once = U.formatMainFormCaption('/home/me', 'prod');
  assert.strictEqual(U.formatMainFormCaption(once, 'prod'), once);
});

test('only a main-form-like window gets the suffix', () => {
  assert.strictEqual(U.formatFormCaption(false, 'Preferences', 'prod'), 'Preferences');
  assert.strictEqual(U.formatFormCaption(true, 'Preferences', 'prod'),
    'Preferences \u2013 prod \u2013 WinSCP');
});

test('a check box reserves room for the box, the padding and a buffer', () => {
  assert.strictEqual(U.calculateCheckBoxWidth(100, 1), 124);
  assert.strictEqual(U.calculateCheckBoxWidth(100, 2), 148);
});

test('a button grows to fit its caption, leftwards when it is right-anchored', () => {
  assert.deepStrictEqual(
    U.autoSizeButton({ width: 80, left: 300, anchoredRight: true }, 100, 1),
    { width: 116, left: 264, grew: true });
  assert.deepStrictEqual(
    U.autoSizeButton({ width: 80, left: 20, anchoredRight: false }, 100, 1),
    { width: 116, left: 20, grew: true });
  assert.strictEqual(U.autoSizeButton({ width: 200, left: 0 }, 100, 1).grew, false);
});

test('a message button never shrinks below the minimum, and pays for its extras', () => {
  assert.strictEqual(U.messageButtonWidth(10, 1), U.MESSAGE_BUTTON_MIN_WIDTH);
  assert.strictEqual(U.messageButtonWidth(100, 1), 116);
  assert.strictEqual(U.messageButtonWidth(100, 1, { menuButton: true }), 132);
  assert.strictEqual(U.messageButtonWidth(100, 1, { splitButton: true }), 131);
});

test('a fingerprint may make the dialog wider so it can be compared by eye', () => {
  const fingerprint = Array.from({ length: 32 }, (_, i) => (i % 16).toString(16).padStart(2, '0')).join(':');
  assert.strictEqual(U.maxMessageTextWidth('no fingerprint here', 400, 0, 0), 400);
  assert.strictEqual(U.maxMessageTextWidth(`ssl: ${fingerprint}`, 400, 0, 0), 600);
});

test('a dialog whose buttons are already wide does not squeeze its text', () => {
  assert.strictEqual(U.maxMessageTextWidth('short', 400, 700, 50), 650);
  assert.strictEqual(U.maxMessageTextWidth('short', 400, 300, 50), 400);
});

test('a form is cut to the work area rather than hanging off it', () => {
  assert.deepStrictEqual(
    U.cutFormToDesktop({ left: 900, top: 700, width: 400, height: 300 },
      { left: 0, top: 0, right: 1000, bottom: 800 }),
    { left: 900, top: 700, width: 100, height: 100 });
});

test('centering never puts a form above or left of the desktop', () => {
  assert.deepStrictEqual(
    U.centerFormOn({ left: 0, top: 0, width: 100, height: 100 },
      { left: 0, top: 0, width: 800, height: 600 }, { left: 0, top: 0 }),
    { left: 350, top: 250, width: 100, height: 100 });
  // A form larger than what it centres on would go negative: it is pinned.
  assert.deepStrictEqual(
    U.centerFormOn({ left: 0, top: 0, width: 1000, height: 800 },
      { left: 0, top: 0, width: 800, height: 600 }, { left: 0, top: 0 }),
    { left: 0, top: 0, width: 1000, height: 800 });
});

test('resizing clamps to the work area, honours the minimum and re-centres', () => {
  const workarea = { left: 0, top: 0, right: 1000, bottom: 800 };
  const bigger = U.resizeForm({ left: 0, top: 0, width: 100, height: 100 },
    2000, 2000, workarea, {});
  assert.strictEqual(bigger.width, 1000);
  assert.strictEqual(bigger.height, 800);

  const smaller = U.resizeForm({ left: 400, top: 300, width: 200, height: 200 },
    50, 50, workarea, { minWidth: 300, minHeight: 250 });
  assert.strictEqual(smaller.width, 300);
  assert.strictEqual(smaller.height, 250);
});

test('resizing respects a work area that starts left of or above zero', () => {
  // A second monitor placed left of and above the primary one.
  const workarea = { left: -1600, top: -200, right: 0, bottom: 700 };
  const r = U.resizeForm({ left: -1590, top: -190, width: 200, height: 200 },
    400, 400, workarea, {});
  assert.ok(r.left >= workarea.left, 'never off the left edge');
  assert.ok(r.top >= workarea.top, 'never off the top edge');
});

test('an impossible minimum is capped so the form remains reachable', () => {
  const workarea = { left: 0, top: 0, right: 1000, bottom: 800 };
  const r = U.resizeForm({ left: 100, top: 100, width: 200, height: 200 },
    300, 300, workarea, { minWidth: 1600, minHeight: 1200 });
  assert.equal(r.width, 1000);
  assert.equal(r.height, 800);
  assert.ok(r.left >= workarea.left && r.left + r.width <= workarea.right);
  assert.ok(r.top >= workarea.top && r.top + r.height <= workarea.bottom);
});

test('an oversized form is re-centred by the difference the layout forced', () => {
  const workarea = { left: 0, top: 0, right: 1000, bottom: 800 };
  const r = U.resizeForm({ left: 400, top: 400, width: 200, height: 200 },
    300, 300, workarea, { actual: () => ({ width: 400, height: 300 }) });
  // Asked for 300 wide, got 400: shift left by 50 so it stays centred.
  assert.strictEqual(r.left, 350 - 50);
  assert.strictEqual(r.actualWidth, 400);
});

test('a label in front of a field lends the field its accessible name', () => {
  const parent = { id: 'panel' };
  const edit = { id: 'hostEdit', left: 100, top: 10, parent, handleAllocated: true };
  const root = {
    children: [
      { kind: 'label', caption: '&Host name:', focusControl: edit, left: 10, top: 10, parent },
      edit,
    ],
  };
  const names = U.accessibleNamesFrom(root);
  assert.strictEqual(names.get(edit), 'Host name:');
});

test('a label in front beats a label behind, whichever order they appear in', () => {
  const parent = {};
  const edit = { left: 100, top: 100, parent, handleAllocated: true };
  const behind = { kind: 'label', caption: 'KB/s', focusControl: edit, left: 200, top: 100, parent };
  const infront = { kind: 'label', caption: '&Speed:', focusControl: edit, left: 10, top: 100, parent };

  assert.strictEqual(U.accessibleNamesFrom({ children: [behind, infront, edit] }).get(edit), 'Speed:');
  assert.strictEqual(U.accessibleNamesFrom({ children: [infront, behind, edit] }).get(edit), 'Speed:');
  // With only the trailing label, it is used rather than nothing.
  assert.strictEqual(U.accessibleNamesFrom({ children: [behind, edit] }).get(edit), 'KB/s');
});

test('a label above a field counts as being in front of it', () => {
  const parent = {};
  const edit = { left: 10, top: 100, parent, handleAllocated: true };
  const above = { kind: 'label', caption: 'Comment', focusControl: edit, left: 10, top: 80, parent };
  assert.strictEqual(U.accessibleNamesFrom({ children: [above, edit] }).get(edit), 'Comment');
});

test('a label whose field lives elsewhere, or has no handle, is ignored', () => {
  const parent = {};
  const other = {};
  const elsewhere = { left: 10, top: 10, parent: other, handleAllocated: true };
  const unrealized = { left: 10, top: 10, parent, handleAllocated: false };
  const names = U.accessibleNamesFrom({
    children: [
      { kind: 'label', caption: 'A', focusControl: elsewhere, left: 0, top: 10, parent },
      { kind: 'label', caption: 'B', focusControl: unrealized, left: 0, top: 10, parent },
    ],
  });
  assert.strictEqual(names.size, 0);
});

test('accessible names are collected through nested containers', () => {
  const inner = {};
  const edit = { left: 100, top: 10, parent: inner, handleAllocated: true };
  const root = {
    children: [{
      kind: 'panel', children: [
        { kind: 'label', caption: '&Port:', focusControl: edit, left: 10, top: 10, parent: inner },
        edit,
      ],
    }],
  };
  assert.strictEqual(U.accessibleNamesFrom(root).get(edit), 'Port:');
});

test('an error dialog announces itself as an alert so a reader speaks it at once', () => {
  assert.strictEqual(U.messageDialogRole(QUERY_TYPE.error), U.ACC_ROLE.alert);
  assert.strictEqual(U.messageDialogRole(QUERY_TYPE.warning), U.ACC_ROLE.alert);
  assert.strictEqual(U.messageDialogRole(QUERY_TYPE.confirmation), U.ACC_ROLE.dialog);
});

test('Ctrl+Right in a path field stops at each path component, not each space', () => {
  const path = 'C:\\Program Files\\WinSCP';
  // From inside "C:" the next stop is the start of "Program".
  assert.strictEqual(U.pathWordBreak(path, 1, U.WORD_BREAK.right), 3);
  // From inside "Program" the next stop is the start of "Files".
  assert.strictEqual(U.pathWordBreak(path, 4, U.WORD_BREAK.right), 11);
  // Position 0 is answered 0 so Windows asks again from 1.
  assert.strictEqual(U.pathWordBreak(path, 0, U.WORD_BREAK.right), 0);
  // No delimiter left: the end of the text.
  assert.strictEqual(U.pathWordBreak(path, 18, U.WORD_BREAK.right), path.length);
});

test('Ctrl+Left skips the run of delimiters it is sitting in', () => {
  const path = 'C:\\Program Files\\WinSCP';
  assert.strictEqual(U.pathWordBreak(path, 11, U.WORD_BREAK.left), 3);
  assert.strictEqual(U.pathWordBreak(path, 3, U.WORD_BREAK.left), 0);
});

test('the delimiter test is the negation of what the Win32 docs say', () => {
  const path = 'C:\\Program Files';
  assert.strictEqual(U.pathWordBreak(path, 2, U.WORD_BREAK.isDelimiter), false, '\\ IS a delimiter');
  assert.strictEqual(U.pathWordBreak(path, 3, U.WORD_BREAK.isDelimiter), true);
  assert.throws(() => U.pathWordBreak(path, 0, 99), U.UserInterfaceError);
});

test('every path separator, and the punctuation around one, breaks a word', () => {
  for (const ch of ['\\', '/', ' ', ';', ',', '.', '\r', '\n', '=']) {
    assert.strictEqual(U.isPathWordDelimiter(ch), true, JSON.stringify(ch));
  }
  assert.strictEqual(U.isPathWordDelimiter(':'), false, 'a drive colon is part of the word');
  assert.strictEqual(U.isPathWordDelimiter(undefined), false);
});

test('check-all toggles to checked unless everything is checked already', () => {
  const mixed = [{ checked: true }, { checked: false }];
  assert.strictEqual(U.listAnyChecked(mixed, false), true);
  assert.deepStrictEqual(U.listCheckAll(mixed, U.CHECK_ALL.toggle).map((i) => i.checked),
    [true, true]);
  const all = [{ checked: true }, { checked: true }];
  assert.deepStrictEqual(U.listCheckAll(all, U.CHECK_ALL.toggle).map((i) => i.checked),
    [false, false]);
  assert.deepStrictEqual(U.listCheckAll(mixed, U.CHECK_ALL.uncheck).map((i) => i.checked),
    [false, false]);
});

test('the tri-state maps to the Auto/Off/On combo and back', () => {
  assert.strictEqual(U.comboAutoSwitchIndex(U.AUTO_SWITCH.auto), 0);
  assert.strictEqual(U.comboAutoSwitchIndex(U.AUTO_SWITCH.off), 1);
  assert.strictEqual(U.comboAutoSwitchIndex(U.AUTO_SWITCH.on), 2);
  for (const v of [U.AUTO_SWITCH.on, U.AUTO_SWITCH.off, U.AUTO_SWITCH.auto]) {
    assert.strictEqual(U.comboAutoSwitchValue(U.comboAutoSwitchIndex(v)), v);
  }
  // An unset combo falls back to Auto rather than to a silent "On".
  assert.strictEqual(U.comboAutoSwitchIndex(3), 0);
});

test('the tri-state check box round-trips through its three states', () => {
  assert.strictEqual(U.checkBoxAutoSwitchState(U.AUTO_SWITCH.on), 'checked');
  assert.strictEqual(U.checkBoxAutoSwitchState(U.AUTO_SWITCH.off), 'unchecked');
  assert.strictEqual(U.checkBoxAutoSwitchState(U.AUTO_SWITCH.auto), 'indeterminate');
  for (const v of [U.AUTO_SWITCH.on, U.AUTO_SWITCH.off, U.AUTO_SWITCH.auto]) {
    assert.strictEqual(U.checkBoxAutoSwitchValue(U.checkBoxAutoSwitchState(v)), v);
  }
});

test('hidden controls are removed from a stacking order, leaving no gap', () => {
  // b is hidden, so a and c stack as if it were not there — and the stack
  // starts at the topmost of the VISIBLE controls (30), not at the first one
  // in the list (50).
  const out = U.verticalControlsOrder([
    { id: 'a', top: 50, height: 20, visible: true, align: 'top' },
    { id: 'b', top: 10, height: 20, visible: false, align: 'top' },
    { id: 'c', top: 30, height: 20, visible: true, align: 'top' },
  ]);
  assert.deepStrictEqual(out.map((c) => [c.id, c.top]), [['a', 30], ['c', 50]]);
});

test('an unaligned control does not push the next one down — only aligned ones stack', () => {
  // The original advances the running Top only for alTop/alBottom controls,
  // for the last control, and before an alBottom one. Unaligned siblings are
  // positioned by their own layout, so they share the same Top.
  const out = U.verticalControlsOrder([
    { id: 'a', top: 50, height: 20, align: 'none' },
    { id: 'b', top: 30, height: 20, align: 'none' },
  ]);
  assert.deepStrictEqual(out.map((c) => [c.id, c.top]), [['a', 30], ['b', 30]]);
});

test('horizontal stacking resets to the left edge around a bottom-aligned control', () => {
  // Vertical alignment wins, so a bottom-aligned control starts at the very
  // left and the run after it starts from the left again too.
  const out = U.horizontalControlsOrder([
    { id: 'a', left: 20, width: 30, align: 'left' },
    { id: 'b', left: 10, width: 30, align: 'bottom' },
    { id: 'c', left: 60, width: 30, align: 'left' },
  ]);
  assert.deepStrictEqual(out.map((c) => [c.id, c.left]), [['a', 10], ['b', 0], ['c', 0]]);
});

test('a run of left-aligned controls packs left to right from the leftmost one', () => {
  const out = U.horizontalControlsOrder([
    { id: 'a', left: 20, width: 30, align: 'left' },
    { id: 'b', left: 10, width: 40, align: 'left' },
    { id: 'c', left: 60, width: 30, align: 'left' },
  ]);
  assert.deepStrictEqual(out.map((c) => [c.id, c.left]), [['a', 10], ['b', 40], ['c', 80]]);
});

test('validation is skipped on the way to Cancel, but only as a courtesy', () => {
  assert.strictEqual(U.shouldSkipValidationOnExit({ cancelButtonBeingClicked: true }), true);
  assert.strictEqual(U.shouldSkipValidationOnExit({}), false);
});
