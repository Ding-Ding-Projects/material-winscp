'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const R = (rel) => pathToFileURL(path.join(ROOT, 'design', 'renderer', rel)).href;

let C;
let M;
let ACTIONS;

test.before(async () => {
  C = await import(R('ui/contextmenu.js'));
  M = await import(R('ui/menus.js'));
  ({ ACTIONS } = await import(R('actions.js')));
});

test('action descriptors resolve through the shared registry and use platform notation', () => {
  assert.equal(C.shortcutForAction({ action: 'LocalBackAction' }), 'Alt+Left');
  assert.equal(C.shortcutForMenu({ action: 'LocalBackAction' }, { platform: 'win32' }), 'Alt+←');
  assert.deepEqual(C.shortcutPartsForMenu({ action: 'LocalBackAction' }, { platform: 'win32' }), ['Alt', '←']);
  assert.equal(C.shortcutForMenu({ action: 'LocalBackAction' }, { platform: 'darwin' }), '⌥+←');
  assert.equal(C.shortcutForMenu({ action: 'LocalBackAction' }, { platform: 'MacIntel' }), '⌥+←');
  assert.equal(C.ariaShortcutForMenu({ action: 'LocalBackAction' }), 'Alt+ArrowLeft');
});

test('special keys are tokenized without losing a plus key', () => {
  const cases = [
    [{ shortcut: 'Ctrl+Num +' }, ['Ctrl', 'Num+'], 'Ctrl+Num+'],
    [{ shortcut: 'Num +' }, ['Num+'], 'Num+'],
    [{ shortcut: 'Alt+Right' }, ['Alt', '→'], 'Alt+→'],
    [{ shortcut: 'Ctrl+Enter' }, ['Ctrl', '↵'], 'Ctrl+↵'],
    [{ shortcut: 'Shift+F3' }, ['Shift', 'F3'], 'Shift+F3'],
  ];
  for (const [descriptor, parts, text] of cases) {
    assert.deepEqual(C.shortcutPartsForMenu(descriptor, { platform: 'win32' }), parts, text);
    assert.equal(C.shortcutForMenu(descriptor, { platform: 'win32' }), text);
  }
});

test('explicit values win, while missing values fall back to action metadata', () => {
  assert.equal(C.shortcutForMenu({ action: 'LocalBackAction', shortcut: 'Ctrl+S' }), 'Ctrl+S');
  assert.equal(C.shortcutForMenu({ action: 'NoSuchAction' }), '');
  assert.equal(C.normalizeMenuItem({ action: 'LocalBackAction', disabled: true, checked: false, submenu: [] }, { platform: 'win32' }).disabled, true);
  const item = C.normalizeMenuItem({ action: 'LocalBackAction', disabled: true, checked: false, submenu: [] }, { platform: 'win32' });
  assert.equal(item.checked, false);
  assert.deepEqual(item.submenu, []);
  assert.equal(item.ariaKeyShortcuts, 'Alt+ArrowLeft');
});

test('action aliases use the same shortcut and ARIA normalization path', () => {
  for (const key of ['actionId', 'command']) {
    const item = C.normalizeMenuItem({ [key]: 'LocalBackAction' }, { platform: 'win32' });
    assert.equal(item.shortcut, 'Alt+←', key);
    assert.equal(item.ariaKeyShortcuts, 'Alt+ArrowLeft', key);
  }
});

function walk(nodes, out = []) {
  for (const node of nodes || []) {
    if (!node || node.separator) continue;
    if (node.action) out.push(node);
    if (node.items) walk(node.items, out);
  }
  return out;
}

function walkRendered(items, out = []) {
  for (const item of items || []) {
    if (!item || item.separator) continue;
    out.push(item);
    if (item.submenu) walkRendered(item.submenu, out);
  }
  return out;
}

test('real action-backed context providers keep every registered shortcut', () => {
  const providers = [
    M.fileContextItems({ side: 'local' }),
    M.fileContextItems({ side: 'remote' }),
    M.panelContextItems({ side: 'local' }),
    M.panelContextItems({ side: 'remote' }),
  ];
  const rendered = providers.flatMap((items) => walkRendered(items));
  const shortcutItems = rendered.filter((item) => item.shortcut);
  assert.ok(shortcutItems.length >= 8, `only ${shortcutItems.length} shortcut-bearing context items were audited`);
  for (const item of shortcutItems) {
    assert.ok(C.shortcutForMenu(item, { platform: 'win32' }), `${item.label} lost its shortcut`);
    assert.ok(!C.shortcutPartsForMenu(item, { platform: 'win32' }).some((part) => !part), `${item.label} has an empty key token`);
  }

  // Audit the declarative menu trees too: these are the same action-backed
  // descriptors the panel providers use, not a synthetic fixture list.
  for (const node of walk([...M.COMMANDER_MENUS, ...M.EXPLORER_MENUS])) {
    const action = ACTIONS.find((candidate) => candidate.name === node.action);
    if (!action?.shortcut) continue;
    assert.equal(C.shortcutForMenu({ action: node.action }, { platform: 'win32' }),
      C.shortcutForMenu({ shortcut: action.shortcut }, { platform: 'win32' }), node.action);
  }
});

test('all real direct context-menu shortcut literals have a non-empty canonical rendering', () => {
  const files = [
    'design/renderer/app.js',
    'design/renderer/ui/toolbars.js',
    'design/renderer/ui/tabs.js',
    'design/renderer/ui/statusbar.js',
    'design/renderer/ui/log.js',
    'design/renderer/ui/historypanel.js',
    'design/renderer/ui/driveview.js',
    'design/renderer/ui/panelcolumns.js',
    'design/renderer/ui/queue.js',
    'design/renderer/ui/dialogs/checklist.js',
    'design/renderer/ui/dialogs/console.js',
    'design/renderer/ui/dialogs/editor.js',
    'design/renderer/ui/dialogs/filefind.js',
    'design/renderer/ui/dialogs/license.js',
    'design/renderer/ui/dialogs/login.js',
    'design/renderer/ui/dialogs/preferences.js',
    'design/renderer/ui/dialogs/rights.js',
    'design/renderer/ui/dialogs/sitetree.js',
  ];
  let count = 0;
  for (const rel of files) {
    const source = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const match of source.matchAll(/\bshortcut\s*:\s*(['"])(.*?)\1/g)) {
      const raw = match[2];
      if (!raw.trim()) continue;
      count += 1;
      const parts = C.shortcutPartsForMenu({ shortcut: raw }, { platform: 'win32' });
      assert.ok(parts.length > 0 && parts.every(Boolean), `${rel} contains an unrenderable ${raw}`);
    }
  }
  assert.ok(count >= 20, `only ${count} direct shortcut descriptors were audited`);
});

test('narrow menus have a viewport-safe width contract', () => {
  const source = fs.readFileSync(path.join(ROOT, 'design/renderer/ui/contextmenu.js'), 'utf8');
  assert.match(source, /root\.style\.minWidth\s*=\s*'min\(220px, calc\(100vw - 12px\)\)'/);
  assert.match(source, /root\.style\.maxWidth\s*=\s*'min\(420px, calc\(100vw - 12px\)\)'/);
  const normalized = C.normalizeMenuItem({ label: 'A very long bilingual label', shortcut: 'Ctrl+Shift+F7', disabled: true, checked: true, submenu: [{ label: 'Child', shortcut: 'F3' }] }, { platform: 'win32' });
  assert.equal(normalized.shortcut, 'Ctrl+Shift+F7');
  assert.equal(normalized.disabled, true);
  assert.equal(normalized.checked, true);
  assert.equal(normalized.submenu.length, 1);
});
