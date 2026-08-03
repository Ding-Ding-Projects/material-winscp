'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let C;
let P;

test.before(async () => {
  C = await import('../design/renderer/ui/commands.js');
  P = await import('../design/renderer/ui/panels.js');
});

function panel(isLocal, connected = true) {
  return {
    isLocal,
    path: () => (isLocal ? 'C:\\work' : '/srv'),
    sessionInfo: () => (isLocal ? null : { id: 's1', connected }),
  };
}

test('LocalRootDirAction preserves a UNC server/share root', () => {
  assert.equal(P.panelRootPath('local', '\\\\server\\share\\folder'), '\\\\server\\share');
  assert.equal(P.panelRootPath('local', '\\\\server\\share'), '\\\\server\\share');
  assert.equal(P.panelRootPath('local', 'C:\\work\\folder'), 'C:\\');
  assert.equal(P.panelRootPath('remote', '/srv/work'), '/');
});

test('Other directory is disabled when its destination panel is disconnected', () => {
  const local = panel(true);
  const remoteDown = panel(false, false);
  const localCommand = C.getCommand('LocalOtherDirAction');
  const localContext = C.makeContext(localCommand, { side: 'local', panel: local, other: remoteDown });
  assert.equal(localCommand._spec.enabled(localContext), false);

  const remoteCommand = C.getCommand('RemoteOtherDirAction');
  const remoteContext = C.makeContext(remoteCommand, { side: 'remote', panel: remoteDown, other: local });
  assert.equal(remoteCommand._spec.enabled(remoteContext), false);
});

test('Other directory stays reachable when both Commander panels are usable', () => {
  const local = panel(true);
  const remote = panel(false, true);
  for (const [name, side, source, target] of [
    ['LocalOtherDirAction', 'local', local, remote],
    ['RemoteOtherDirAction', 'remote', remote, local],
  ]) {
    const command = C.getCommand(name);
    const context = C.makeContext(command, { side, panel: source, other: target });
    assert.equal(command._spec.enabled(context), true, name);
  }
});

test('Commander panel headers are hidden in Explorer and enabled in Commander', () => {
  const previous = C.services.workspace;
  try {
    C.services.workspace = { interfaceMode: () => 'explorer' };
    assert.equal(C.commandState('CommanderLocalPanelAction').visible, false);
    assert.equal(C.commandState('CommanderRemotePanelAction').visible, false);

    C.services.workspace = { interfaceMode: () => 'commander', setActiveSide: () => {} };
    assert.equal(C.commandState('CommanderLocalPanelAction').visible, true);
    assert.equal(C.commandState('CommanderLocalPanelAction').enabled, true);
    assert.equal(C.commandState('CommanderRemotePanelAction').enabled, true);
  } finally {
    C.services.workspace = previous;
  }
});

test('panel splitter keyboard math is clamped and persistable', async () => {
  const { clampPanelWidth, adjustPanelWidth, panelWidthFraction, adjustTreeWidth } =
    await import('../design/renderer/ui/panels.js');
  assert.equal(clampPanelWidth(-50, 1000), 160);
  assert.equal(clampPanelWidth(950, 1000), 840);
  assert.equal(adjustPanelWidth(500, -400, 1000), 160);
  assert.equal(adjustPanelWidth(500, 400, 1000), 840);
  assert.equal(panelWidthFraction(500, 1000), 0.5);
  assert.equal(adjustTreeWidth(120, -16), 120);
  assert.equal(adjustTreeWidth(520, 16), 520);
});
