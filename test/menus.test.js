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
