'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const R = (rel) => pathToFileURL(path.join(ROOT, 'design', 'renderer', rel)).href;

let M;
let C;
let ACTIONS;

test.before(async () => {
  M = await import(R('ui/menus.js'));
  C = await import(R('ui/contextmenu.js'));
  ({ ACTIONS } = await import(R('actions.js')));
});

function walk(nodes, out = []) {
  for (const node of nodes || []) {
    if (node?.action) out.push(node);
    if (node?.items) walk(node.items, out);
  }
  return out;
}

function rendered(items, out = []) {
  for (const item of items || []) {
    if (item?.action || item?.label) out.push(item);
    if (item?.submenu) rendered(item.submenu, out);
  }
  return out;
}

test('every menu action with registered shortcut exposes it to the menu renderer', () => {
  const trees = [
    ...M.COMMANDER_MENUS,
    ...M.EXPLORER_MENUS,
    { items: M.fileContextItems({ side: 'local' }) },
    { items: M.fileContextItems({ side: 'remote' }) },
    { items: M.panelContextItems({ side: 'local' }) },
    { items: M.panelContextItems({ side: 'remote' }) },
  ];
  const actions = trees.flatMap((tree) => tree.items ? walk(tree.items) : []);
  const known = new Map(ACTIONS.map((action) => [action.name, action]));
  for (const node of actions) {
    const action = known.get(node.action);
    if (!action?.shortcut) continue;
    const [item] = M.buildMenuItems([{ action: node.action }]);
    assert.equal(item.shortcut, C.shortcutForAction({ action: node.action }), node.action);
    assert.ok(item.shortcut, `${node.action} lost its shortcut`);
  }
});

test('focused action aliases retain inherited shortcuts in rendered context menus', () => {
  const items = rendered([
    ...M.fileContextItems({ side: 'local' }),
    ...M.fileContextItems({ side: 'remote' }),
  ]);
  const shortcutItems = items.filter((item) => item.shortcut);
  assert.ok(shortcutItems.length >= 8);
  for (const item of shortcutItems) assert.ok(C.shortcutForAction(item), item.label);
});

test('descriptor shortcuts survive the menu tree and nested submenu renderer', () => {
  const [openedTabs] = M.buildMenuItems([{ action: 'OpenedTabsAction' }]);
  assert.equal(openedTabs.action, 'OpenedTabsAction');
  assert.equal(openedTabs.shortcut, 'Ctrl+Shift+Tab');
  assert.equal(C.shortcutForMenu(openedTabs, { platform: 'win32' }), 'Ctrl+Shift+Tab');

  const rendered = [
    ...M.COMMANDER_MENUS,
    ...M.EXPLORER_MENUS,
  ].flatMap((menu) => M.buildMenuItems(menu.items));
  const contexts = ['local', 'remote']
    .flatMap((side) => [M.fileContextItems({ side }), M.panelContextItems({ side })])
    .flat();
  const all = renderedItems([...rendered, ...contexts]);
  const menuActions = new Set();
  const shortcutMenuActions = new Set();
  for (const item of all) {
    if (!item.action) continue;
    menuActions.add(item.action);
    const command = ACTIONS.find((action) => action.name === item.action);
    if (command?.shortcut || item.action === 'OpenedTabsAction') {
      if (command?.shortcut) shortcutMenuActions.add(item.action);
      assert.equal(item.shortcut, C.shortcutForAction(item), item.action);
      assert.ok(item.shortcut, `${item.action} lost its shortcut`);
    }
  }

  // This is the concrete menu-bearing slice; the remaining action shortcuts
  // are keyboard-only or exposed by a different surface, so this test does
  // not pretend that the issue is fully closed.
  assert.ok(menuActions.size >= 60, `only ${menuActions.size} action-backed menu entries were audited`);
  assert.equal(shortcutMenuActions.size, 66, 'the current menu-bearing slice must stay explicit');
});

function renderedItems(items, out = []) {
  for (const item of items || []) {
    if (!item || item.separator) continue;
    out.push(item);
    if (item.submenu) renderedItems(item.submenu, out);
  }
  return out;
}

test('the shared formatter exposes all 79 extracted action shortcuts to menus', () => {
  const shortcutActions = ACTIONS.filter((action) => action.shortcut);
  assert.equal(shortcutActions.length, 79);
  for (const action of shortcutActions) {
    const item = { action: action.name };
    assert.equal(C.shortcutForAction(item), action.shortcut, action.name);
    assert.ok(C.shortcutForMenu(item, { platform: 'win32' }), `${action.name} has no Windows menu rendering`);
    assert.ok(C.ariaShortcutForMenu(item), `${action.name} has no ARIA shortcut`);
  }
});
