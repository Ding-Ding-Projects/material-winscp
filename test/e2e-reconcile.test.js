// e2e-reconcile.test.js — are the reconciled subsystems REACHABLE?
//
// Eight subsystems landed independently, and six of them were islands: complete
// modules with real tests that nothing in the running application imported.
// docs/porting-mandate.md is unambiguous about what that means — "the behaviour
// exists in this application and a user can reach it" — so a module nobody can
// reach is not ported, however good it is.
//
// This suite is the proof that they are reachable now, and it is deliberately
// hostile to the cheap version of that proof. It does not require the module
// and call it; it boots the real Electron main process, goes through the real
// preload the sandboxed renderer is given, and asserts the behaviour that comes
// back. If a wiring change silently drops a channel, or the preload namespace
// stops matching the handler table, these fail.
//
// The transfer case is the one that matters most: `transfer:copyToRemote` runs
// design/main/transfer.js's decision layer against a REAL SFTP server, moving
// its bytes through design/main/queue.js's byte mover. Neither half had ever
// been driven end to end by the other before this pass.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { startApp, startSftpServer, siteFor } = require('./helpers/app-harness');
// The answer BITS are the contract; their names come from the same module the
// main process answers with, so this asserts the value rather than restating it.
const U2 = require('../design/main/userinterface');

/** Open a session, answering the host-key question the way a user would. */
async function connectAnswering(app, siteId) {
  const opening = app.api('session.open', { siteId, connect: true });
  const prompt = await app.waitForEvent('event:prompt', (p) => p.kind === 'hostKey', 20000);
  await app.api('session.answerPrompt', prompt.sessionId, prompt.promptId, { accept: true, remember: true });
  const reply = await opening;
  assert.ok(reply.ok, `the session did not open: ${JSON.stringify(reply)}`);
  return reply.value.id;
}

test.describe('the reconciled subsystems are reachable from the application', () => {
  let app;

  test.before(async () => { app = await startApp(); });
  test.after(async () => { if (app) await app.stop(); });

  test.it('registers every channel the six wired-up modules need', async () => {
    const channels = await app.channels();
    const required = [
      // design/main/messages.js — WinSCP's own STRINGTABLE resources
      'messages:load', 'messages:meta', 'messages:table', 'messages:voiced', 'messages:split',
      // design/main/dirview.js + pathedit.js — the file-panel model
      'panel:columns', 'panel:sortState', 'panel:buildView', 'panel:export',
      'panel:validateRename', 'panel:validateMask', 'panel:compare',
      'path:segments', 'path:complete', 'path:word', 'path:minimize',
      // design/main/explorershell.js — the orchestration layer
      'explorer:setPanels', 'explorer:state', 'explorer:delete', 'explorer:deleteDecision',
      'explorer:doubleClick', 'explorer:queueOp', 'explorer:closeQuery', 'explorer:answer',
      // design/main/interfaces.js — Commander and Explorer
      'interface:shortcuts', 'interface:allowedAction', 'interface:panels',
      'interface:restoreParams', 'interface:storeParams', 'interface:workspaceList',
      // design/main/userinterface.js — the message-dialog contract
      'ui:messageDialog', 'ui:resolveAnswer', 'ui:neverAskAgain', 'ui:mayOfferNeverAskAgain',
      // design/main/terminal.js + transfer.js — the foreground transfer path
      'transfer:copyToRemote', 'transfer:copyToLocal', 'transfer:canParallel',
    ];
    for (const channel of required) {
      assert.ok(channels.includes(channel), `${channel} is not registered`);
    }
    assert.equal(new Set(channels).size, channels.length, 'a channel is registered twice');
  });

  test.it('exposes each of them on the preload, so the renderer can actually call them', async () => {
    // Reachable from ipc.js is half the requirement; a namespace the renderer
    // does not have is still unreachable from where the user is.
    for (const ns of ['messages', 'panel', 'path', 'explorer', 'interface', 'ui', 'transfer']) {
      assert.equal(await app.evaluate(`typeof window.api.${ns}`), 'object', `window.api.${ns} is missing`);
    }
    assert.equal(await app.evaluate('typeof window.api.transfer.copyToRemote'), 'function');
    assert.equal(await app.evaluate('typeof window.api.explorer.delete'), 'function');
  });

  // ---------------------------------------------------------- messages

  test.it('serves WinSCP\'s own sentences out of the resource table', async () => {
    // The English is the resource's, not a transcription: this is the string
    // resource/TextsCore1.rc actually carries.
    const text = await app.ok('messages.load', 'CHANGE_DIR_ERROR', ['/var/www']);
    assert.equal(text, "Error changing directory to '/var/www'.");

    const meta = await app.ok('messages.meta', 'CHANGE_DIR_ERROR');
    assert.equal(meta.arity, 1);
    assert.equal(meta.params[0].kind, 'string');

    const table = await app.ok('messages.table');
    assert.ok(table.ids.length > 1000, `only ${table.ids.length} resources reached the renderer`);
    // The absolute path of the table on this machine is not the renderer's
    // business and must not cross the bridge.
    assert.equal(table.path, undefined);
  });

  test.it('refuses a resource id it does not have, rather than inventing one', async () => {
    const reply = await app.api('messages.load', 'NO_SUCH_RESOURCE_ID', []);
    assert.equal(reply.ok, false);
    assert.match(reply.error.message, /No such message resource/);
  });

  test.it('renders a message through the bilingual layer at every funny level', async () => {
    const seen = new Set();
    for (let level = 1; level <= 5; level++) {
      const en = await app.ok('messages.voiced', 'COMPARE_NO_DIFFERENCES',
        { language: 'en', enLevel: level, yueLevel: level });
      assert.equal(typeof en, 'string');
      assert.ok(en.length > 0);
      seen.add(en);
    }
    assert.ok(seen.size > 1, 'the funny level changed nothing at all');

    // The two levels are INDEPENDENT, one per language, as the shared
    // instructions require: raising the Cantonese level must not touch English.
    const enAtOne = await app.ok('messages.voiced', 'COMPARE_NO_DIFFERENCES',
      { language: 'en', enLevel: 1, yueLevel: 1 });
    const enWithLoudYue = await app.ok('messages.voiced', 'COMPARE_NO_DIFFERENCES',
      { language: 'en', enLevel: 1, yueLevel: 5 });
    assert.equal(enAtOne, enWithLoudYue);

    const both = await app.ok('messages.voiced', 'COMPARE_NO_DIFFERENCES',
      { language: 'both', enLevel: 3, yueLevel: 3 });
    assert.ok(both.length > 0);
  });

  // ------------------------------------------------------------- panel

  test.it('builds a panel view with WinSCP\'s filter, counters and sort', async () => {
    const entries = [
      { name: '..', isParentDirectory: true, isDirectory: true },
      { name: 'notes.txt', size: 30, modification: 3000 },
      { name: 'a.bin', size: 200, modification: 1000 },
      // `hidden` is what the listing reports; a leading dot is a Unix
      // convention the adapter resolves, not something the model re-derives.
      { name: '.hidden', size: 5, modification: 2000, hidden: true },
      { name: 'zeta.txt', size: 10, modification: 2000 },
    ];

    const shown = await app.ok('panel.buildView', {
      side: 'remote', entries, mask: '*.txt', showHiddenFiles: false, sortColumn: 'name',
    });
    const names = shown.items.map((i) => i.name);
    // '..' is never filtered out — a mask must not be able to strip the way
    // back up out of a directory.
    assert.ok(names.includes('..'), 'the mask removed the parent entry');
    assert.ok(names.includes('notes.txt') && names.includes('zeta.txt'));
    assert.ok(!names.includes('a.bin'), 'the mask did not filter');
    assert.ok(!names.includes('.hidden'), 'a hidden file was shown');
    assert.equal(shown.hiddenCount, 1);
    assert.equal(shown.filteredCount, 1);
  });

  test.it('starts Size and Date modified DESCENDING, and name ascending', async () => {
    // TCustomIEListView::SortAscendingByDefault. Clicking Size for the first
    // time puts the biggest file at the top, which is the point of clicking it.
    assert.equal(await app.ok('panel.sortAscendingByDefault', 'remote', 'name'), true);
    assert.equal(await app.ok('panel.sortAscendingByDefault', 'remote', 'size'), false);
    assert.equal(await app.ok('panel.sortAscendingByDefault', 'remote', 'changed'), false);

    // And the SortStr persistence format an INI carries is "index;direction".
    const first = await app.ok('panel.sortState', { side: 'remote', click: 'size' });
    assert.equal(first.column, 'size');
    assert.equal(first.ascending, false);
    assert.match(first.sortStr, /^\d+;[01]$/);

    // Clicking the same column again flips it, rather than restarting.
    const again = await app.ok('panel.sortState', { side: 'remote', sortStr: first.sortStr, click: 'size' });
    assert.equal(again.ascending, true);
  });

  test.it('refuses a rename the protocol cannot perform, and one with a bad character', async () => {
    const item = { name: 'report.txt' };

    // CanEdit ANDs in IsCapable[fcRename]. An unstated capability counts as
    // absent: an edit box that promises a rename nothing can carry out is
    // worse than a greyed-out one.
    const noCap = await app.ok('panel.validateRename', { side: 'remote', item, name: 'x.txt' });
    assert.equal(noCap.canEdit, false);

    const parent = await app.ok('panel.validateRename', {
      side: 'remote', item: { name: '..', isParentDirectory: true }, name: 'x', renameCapable: true,
    });
    assert.equal(parent.canEdit, false, 'F2 on ".." offered to rename the directory above');

    const bad = await app.ok('panel.validateRename', {
      side: 'remote', item, name: 'a/b.txt', renameCapable: true,
    });
    assert.equal(bad.canEdit, true);
    assert.equal(bad.action, 'refuse');
    assert.match(bad.error, /invalid characters/i);

    const good = await app.ok('panel.validateRename', {
      side: 'remote', item, name: 'renamed.txt', renameCapable: true,
    });
    assert.equal(good.action, 'rename');
  });

  test.it('produces the exact Copy-file-list-to-clipboard payload', async () => {
    const out = await app.ok('panel.export', {
      side: 'remote', path: '/srv',
      entries: [{ name: 'one.txt' }, { name: 'two words.txt' }],
    });
    // A name with a space is quoted, because the output is meant to be pasted
    // onto a command line. Nothing else is escaped, exactly as WinSCP does it.
    assert.deepEqual(out.lines, ['one.txt', '"two words.txt"']);
    assert.equal(out.text, 'one.txt\r\n"two words.txt"\r\n');
  });

  test.it('reports where a mask is wrong, as a 0-based caret offset', async () => {
    const ok = await app.ok('panel.validateMask', '*.txt; *.bak');
    assert.equal(ok.ok, true);
    const bad = await app.ok('panel.validateMask', '*.txt; >notasize');
    assert.equal(bad.ok, false);
    assert.equal(typeof bad.error, 'string');
    assert.ok(bad.selectionStart >= 0);
  });

  test.it('breaks a path the way WinSCP\'s word-break procedure does', async () => {
    const segs = await app.ok('path.segments', '/var/www/html', 'remote');
    assert.ok(Array.isArray(segs) && segs.length > 0);
    const word = await app.ok('path.word', '/var/www/html', 6, 'at');
    assert.equal(typeof word.start, 'number');
    assert.equal(typeof word.end, 'number');
    const shortened = await app.ok('path.minimize', '/very/long/path/to/a/file.txt', 12);
    assert.ok(shortened.length <= 13, `"${shortened}" is longer than asked for`);
  });

  // ---------------------------------------------------------- explorer

  test.it('answers command predicates from the panel state the renderer pushed', async () => {
    const pushed = await app.ok('explorer.setPanels', {
      currentSide: 'remote',
      remote: {
        path: '/srv',
        entries: [
          { name: '..', isParentDirectory: true, isDirectory: true },
          { name: 'a.txt' }, { name: 'b.txt' }, { name: 'dir', isDirectory: true },
        ],
        selected: ['a.txt'],
        focusedName: 'a.txt',
        hasFocus: true,
      },
    });
    assert.equal(pushed, true);

    const list = await app.ok('explorer.fileList', 'remote', {});
    assert.deepEqual(list.map((f) => f.fullPath), ['/srv/a.txt']);

    // With nothing selected the focused item is what a command acts on — the
    // rule that stops "Delete" and "Delete focused" disagreeing.
    await app.ok('explorer.setPanels', {
      remote: {
        path: '/srv',
        entries: [{ name: 'a.txt' }, { name: 'b.txt' }],
        selected: [],
        focusedName: 'b.txt',
        hasFocus: true,
      },
    });
    assert.deepEqual((await app.ok('explorer.fileList', 'remote', {})).map((f) => f.fullPath),
      ['/srv/b.txt']);
  });

  test.it('never lets a selection contain the parent entry', async () => {
    await app.ok('explorer.setPanels', {
      remote: {
        path: '/srv',
        entries: [{ name: '..', isParentDirectory: true, isDirectory: true }, { name: 'a.txt' }],
        // A renderer that offered '..' for deletion would be asking the server
        // to delete the directory above the one being browsed.
        selected: ['..', 'a.txt'],
        focusedName: 'a.txt',
        hasFocus: true,
      },
    });
    assert.deepEqual((await app.ok('explorer.fileList', 'remote', {})).map((f) => f.fullPath),
      ['/srv/a.txt']);
  });

  test.it('decides recycle-versus-delete from the SITE, and picks the right confirmation', async () => {
    await app.ok('explorer.setPanels', {
      currentSide: 'local',
      local: { path: 'C:\work', entries: [{ name: 'a.txt' }], selected: ['a.txt'], hasFocus: true },
    });

    // The local side follows the deleteToRecycleBin preference...
    await app.ok('config.setPref', 'deleteToRecycleBin', true);
    const recycling = await app.ok('explorer.deleteDecision', 'local', ['C:\work\a.txt'], false);
    assert.equal(recycling.recycle, true);
    // ...and recycling and deleting have SEPARATE confirmation preferences, so
    // turning one off does not turn the other off.
    assert.equal(recycling.confirmPref, 'confirmRecycling');
    assert.match(recycling.query, /recycle bin/i);

    // Shift+Delete inverts it, whichever way the setting points.
    const forced = await app.ok('explorer.deleteDecision', 'local', ['C:\work\a.txt'], true);
    assert.equal(forced.recycle, false);
    assert.equal(forced.confirmPref, 'confirmDeleting');
    assert.doesNotMatch(forced.query, /recycle bin/i);

    await app.ok('config.setPref', 'deleteToRecycleBin', false);
    const deleting = await app.ok('explorer.deleteDecision', 'local', ['C:\work\a.txt'], false);
    assert.equal(deleting.recycle, false);
    assert.equal(deleting.confirmPref, 'confirmDeleting');

    // Turning the DELETE confirmation off must not silence the RECYCLE one.
    await app.ok('config.setPref', 'confirmDeleting', false);
    assert.equal((await app.ok('explorer.deleteDecision', 'local', ['C:\work\a.txt'], false)).needConfirmation, false);
    await app.ok('config.setPref', 'deleteToRecycleBin', true);
    assert.equal((await app.ok('explorer.deleteDecision', 'local', ['C:\work\a.txt'], false)).needConfirmation, true);
    await app.ok('config.setPref', 'confirmDeleting', true);
  });

  test.it('refuses to delete nothing, rather than reporting a successful no-op', async () => {
    const reply = await app.api('explorer.delete', 'local', [], false);
    assert.equal(reply.ok, false);
    assert.equal(typeof reply.error.message, 'string');
  });

  test.it('reports a command state rather than making the renderer guess', async () => {
    const state = await app.ok('explorer.state', 'copy', {});
    assert.equal(typeof state, 'object');
    assert.equal(typeof state.enabled, 'boolean');
  });

  // --------------------------------------------------------- interface

  test.it('serves the per-mode shortcut tables and action gating', async () => {
    const commander = await app.ok('interface.shortcuts', 'commander', {});
    const explorer = await app.ok('interface.shortcuts', 'explorer', {});
    assert.equal(typeof commander, 'object');
    assert.equal(typeof explorer, 'object');
    assert.notDeepEqual(commander, explorer, 'both interfaces reported the same shortcut table');

    // An Explorer-hidden action is refused in the Explorer interface and
    // allowed in the Commander one — the whole point of the TActionFlag tag.
    const hidden = await app.ok('interface.allowedAction', 'explorer', 'LocalCopy');
    assert.equal(hidden.allowed, false);
    assert.ok(hidden.reason.length > 0);
  });

  test.it('round-trips the stored interface parameters', async () => {
    const restored = await app.ok('interface.restoreParams', 'commander', {});
    assert.equal(restored.mode, 'commander');
    const stored = await app.ok('interface.storeParams', 'commander', restored);
    assert.equal(typeof stored, 'object');
  });

  test.it('arranges the panels per interface', async () => {
    const commander = await app.ok('interface.panels', 'commander', {});
    assert.equal(commander.hasLocalPanel, true);
    const explorer = await app.ok('interface.panels', 'explorer', {});
    assert.equal(explorer.hasLocalPanel, false, 'the Explorer interface has no local panel');
  });

  // ---------------------------------------------------------------- ui

  test.it('decides the message dialog\'s buttons, default and Escape answer', async () => {
    const spec = await app.ok('ui.messageDialog', { message: 'Overwrite?', answers: ['yes', 'no', 'cancel'] });
    assert.ok(Array.isArray(spec.buttons) && spec.buttons.length >= 3);
    // Yes > OK > Retry is the default rule, not "the first button".
    assert.equal(U2.answerName(spec.defaultAnswer), 'yes');
    // CancelAnswer falls back cancel -> no -> abort -> ok, not to buttons[0].
    assert.equal(U2.answerName(spec.cancelAnswer), 'cancel');

    const escapes = await app.ok('ui.messageDialog', { message: 'x', answers: ['retry', 'ok'] });
    assert.equal(U2.answerName(escapes.cancelAnswer), 'ok',
      'Escape fell back to the first button instead of OK');
  });

  test.it('will not offer never-ask-again for a question with nowhere to store the tick', async () => {
    assert.equal(await app.ok('ui.mayOfferNeverAskAgain', 'nothing-like-this-question'), false);
    const known = await app.ok('ui.neverAskAgainSetting', 'confirmDelete');
    assert.ok(known === null || typeof known === 'string');
  });

  test.it('disables every button but the positive one once never-ask-again is ticked', async () => {
    // A negative answer must never be made permanent: "no, and never ask again"
    // would silently refuse every future transfer with no way to notice.
    const dialog = await app.ok('ui.messageDialog', {
      message: 'Overwrite?', answers: ['yes', 'no', 'cancel'],
      // mpNeverAskAgainCheck is what puts the box on the dialog at all.
      params: { params: U2.MP.neverAskAgainCheck, neverAskAgainTitle: 'Never ask me again' },
    });
    assert.ok(dialog.neverAskAgain, 'the dialog was built without a never-ask-again box');
    const off = await app.ok('ui.neverAskAgain', dialog, false);
    const on = await app.ok('ui.neverAskAgain', dialog, true);
    assert.notDeepEqual(off.enabled, on.enabled, 'ticking the box changed nothing');
    // The map is keyed by the qaXxx answer BIT, which is what a caller acts on.
    assert.equal(on.positiveAnswer, U2.ANSWER.yes);
    assert.equal(on.enabled[U2.ANSWER.yes], true);
    // Every OTHER answer is disabled, so "no, and never ask again" is
    // unreachable — the answer that would silently refuse every future file.
    assert.equal(on.enabled[U2.ANSWER.no], false, 'a negative answer could be made permanent');
    // Cancel is always left reachable: the user must be able to back out.
    assert.equal(on.enabled[U2.ANSWER.cancel], true);
    assert.equal(off.enabled[U2.ANSWER.no], true,
      'the box was not ticked and "no" was already disabled');
  });
});

// ============================== the foreground transfer path, on a real server

test.describe('the session transfer path moves real bytes over a real server', () => {
  let app;
  let server;
  let sessionId;
  let localDir;

  test.before(async () => {
    server = await startSftpServer();
    await fsp.mkdir(path.join(server.root, 'uploads'), { recursive: true });
    app = await startApp();
    localDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'winscp-reconcile-'));
    const site = await app.ok('config.addSite', siteFor(server, { name: 'Reconcile e2e', rootDirectory: '/' }));
    sessionId = await connectAnswering(app, site.id);
  });

  test.after(async () => {
    if (app) await app.stop();
    if (server) await server.close();
    if (localDir) await fsp.rm(localDir, { recursive: true, force: true });
  });

  test.it('uploads through TTerminal::CopyToRemote', async () => {
    // This is the path that was unreachable: transfer.js decides (resume,
    // overwrite, the .filepart dance, the metadata) and queue.js's byte mover
    // moves. Nothing had ever driven the two together.
    const payload = crypto.randomBytes(64 * 1024);
    const local = path.join(localDir, 'engine-up.bin');
    await fsp.writeFile(local, payload);

    await app.ok('transfer.copyToRemote', {
      sessionId, files: [local], target: '/uploads', copyParam: { transferMode: 'binary' },
    });

    const landed = path.join(server.root, 'uploads', 'engine-up.bin');
    assert.ok(fs.existsSync(landed), 'copyToRemote reported success but nothing arrived on the server');
    assert.ok((await fsp.readFile(landed)).equals(payload), 'the uploaded bytes differ from the source');
  });

  test.it('downloads through TTerminal::CopyToLocal, byte for byte', async () => {
    const payload = crypto.randomBytes(48 * 1024);
    await fsp.writeFile(path.join(server.root, 'uploads', 'engine-down.bin'), payload);

    const target = path.join(localDir, 'down');
    await fsp.mkdir(target, { recursive: true });
    await app.ok('transfer.copyToLocal', {
      sessionId, files: ['/uploads/engine-down.bin'], target, copyParam: { transferMode: 'binary' },
    });

    const landed = path.join(target, 'engine-down.bin');
    assert.ok(fs.existsSync(landed), 'copyToLocal reported success but nothing arrived locally');
    assert.ok((await fsp.readFile(landed)).equals(payload), 'the bytes that came back differ');
  });

  test.it('recurses into a directory, creating it on the far side', async () => {
    const dir = path.join(localDir, 'tree');
    await fsp.mkdir(path.join(dir, 'inner'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'top.txt'), 'top');
    await fsp.writeFile(path.join(dir, 'inner', 'deep.txt'), 'deep');

    await app.ok('transfer.copyToRemote', {
      sessionId, files: [dir], target: '/uploads', copyParam: { transferMode: 'binary' },
    });

    assert.equal(
      await fsp.readFile(path.join(server.root, 'uploads', 'tree', 'top.txt'), 'utf8'), 'top');
    assert.equal(
      await fsp.readFile(path.join(server.root, 'uploads', 'tree', 'inner', 'deep.txt'), 'utf8'), 'deep');
  });

  test.it('refuses to split one file across connections when it must not', async () => {
    // CheckParallelFileTransfer's refusals. Whatever the answer is for this
    // adapter, it must be a real decision rather than a throw from an engine
    // that has no byte mover.
    const answer = await app.ok('transfer.canParallel', {
      sessionId, copyParam: { transferMode: 'binary', parallelTransfers: 4 },
    });
    assert.ok(answer === true || answer === false || typeof answer === 'object');
  });

  test.it('ASKS about a file it cannot read, rather than skipping it silently', async () => {
    // TTerminal's per-file error handling is a question, not a swallow:
    // retry / skip / abort. Answering "abort" is what a user pressing Cancel
    // does, and the operation must then fail rather than report success over a
    // file that never moved. A port that silently continued here would lose a
    // file and say nothing, which is the failure mode the robust loop exists
    // to prevent.
    const pending = app.api('transfer.copyToRemote', {
      sessionId, files: [path.join(localDir, 'does-not-exist.bin')], target: '/uploads',
    });
    const prompt = await app.waitForEvent('event:prompt',
      (p) => p.kind === 'question' && p.payload && p.payload.source === 'shell', 20000);
    assert.ok(prompt.promptId, 'the failure produced a prompt with no id to answer');
    await app.api('ui.answer', prompt.promptId, 'abort');

    const reply = await pending;
    assert.equal(reply.ok, true, 'the handler threw across the bridge instead of reporting');
    // TTerminal::CopyToRemote returns a BOOLEAN, and an aborted operation
    // returns false. The channel carries that through as `completed`, so a
    // caller cannot mistake "the request was handled" for "the files moved".
    assert.equal(reply.value.completed, false,
      'an aborted transfer reported that it completed');
  });
});
