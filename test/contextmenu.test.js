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

class MenuTestNode {
  constructor(tagName = 'div', text = '') {
    this.tagName = String(tagName).toUpperCase();
    this.textContent = text;
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.dataset = {};
    this.style = {};
    this.listeners = new Map();
    this.classList = {
      toggle: (name, force) => {
        const on = force === undefined ? !this.classList[name] : !!force;
        this.classList[name] = on;
        return on;
      },
    };
    this.isConnected = false;
  }

  setAttribute(name, value) {
    const key = String(name);
    const text = String(value);
    this.attributes.set(key, text);
    if (key === 'id') this.id = text;
    if (key.startsWith('data-')) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = text;
  }

  getAttribute(name) { return this.attributes.get(String(name)) ?? null; }
  removeAttribute(name) { this.attributes.delete(String(name)); }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    child.isConnected = this.isConnected;
    for (const descendant of child.children) descendant.isConnected = child.isConnected;
    return child;
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentNode = null;
    child.isConnected = false;
    return child;
  }

  remove() { this.parentNode?.removeChild(this); }
  addEventListener(type, fn) {
    const handlers = this.listeners.get(type) || [];
    handlers.push(fn);
    this.listeners.set(type, handlers);
  }
  removeEventListener(type, fn) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter((handler) => handler !== fn));
  }
  dispatchEvent(event) {
    if (!event.target) event.target = this;
    event.preventDefault ||= (() => { event.defaultPrevented = true; });
    event.stopPropagation ||= (() => { event.cancelBubble = true; });
    for (const handler of this.listeners.get(event.type) || []) handler(event);
    if (!event.cancelBubble) this.parentNode?.dispatchEvent(event);
    return !event.defaultPrevented;
  }
  focus() { if (this.isConnected) global.document.activeElement = this; }
  contains(node) { return node === this || this.children.some((child) => child.contains(node)); }
  getBoundingClientRect() { return { left: 10, right: 110, top: 10, bottom: 30, width: 100, height: 20 }; }
}

function installMenuDom() {
  const previous = {
    document: global.document,
    window: global.window,
    Node: global.Node,
    requestAnimationFrame: global.requestAnimationFrame,
    setTimeout: global.setTimeout,
    clearTimeout: global.clearTimeout,
  };
  const body = new MenuTestNode('body');
  body.isConnected = true;
  const document = {
    body,
    activeElement: body,
    documentElement: { clientWidth: 1200, clientHeight: 800 },
    createElement: (tag) => new MenuTestNode(tag),
    createElementNS: (_namespace, tag) => new MenuTestNode(tag),
    createTextNode: (text) => new MenuTestNode('#text', text),
    getElementById(id) {
      const visit = (node) => {
        if (node.id === id) return node;
        for (const child of node.children) {
          const found = visit(child);
          if (found) return found;
        }
        return null;
      };
      return visit(body);
    },
    addEventListener() {},
    removeEventListener() {},
  };
  global.document = document;
  global.window = { innerWidth: 1200, innerHeight: 800, addEventListener() {}, removeEventListener() {} };
  global.Node = MenuTestNode;
  global.requestAnimationFrame = (fn) => { fn(); return 1; };
  global.setTimeout = (fn) => { fn(); return 1; };
  global.clearTimeout = () => {};
  return () => {
    C.closeAllMenus();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete global[key];
      else global[key] = value;
    }
  };
}

function keyEvent(key) { return { type: 'keydown', key, target: null }; }

function nodeText(node) {
  return node.textContent || (node.children || []).map((child) => nodeText(child)).join('');
}

test('action descriptors resolve through the shared registry and use platform notation', () => {
  assert.equal(C.shortcutForAction({ action: 'LocalBackAction' }), 'Alt+Left');
  assert.equal(C.shortcutForMenu({ action: 'LocalBackAction' }, { platform: 'win32' }), 'Alt+←');
  assert.deepEqual(C.shortcutPartsForMenu({ action: 'LocalBackAction' }, { platform: 'win32' }), ['Alt', '←']);
  assert.equal(C.shortcutForMenu({ action: 'LocalBackAction' }, { platform: 'darwin' }), '⌥+←');
  assert.equal(C.shortcutForMenu({ action: 'LocalBackAction' }, { platform: 'MacIntel' }), '⌥+←');
  assert.equal(C.ariaShortcutForMenu({ action: 'LocalBackAction' }), 'Alt+ArrowLeft');
});

test('Meta uses the host platform name while ARIA keeps the canonical modifier', () => {
  const item = { shortcut: 'Meta+S' };
  assert.equal(C.shortcutForMenu(item, { platform: 'win32' }), 'Win+S');
  assert.equal(C.shortcutForMenu(item, { platform: 'linux' }), 'Super+S');
  assert.equal(C.shortcutForMenu(item, { platform: 'darwin' }), '⌘+S');
  assert.equal(C.ariaShortcutForMenu(item), 'Meta+S');
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

test('focused context actions inherit only their exact registered counterpart shortcut', () => {
  assert.equal(C.shortcutForAction({ action: 'CurrentCopyToClipboardFocusedAction2' }), 'Ctrl+C');
  assert.equal(C.shortcutForMenu({ action: 'CurrentCopyToClipboardFocusedAction2' }, { platform: 'win32' }), 'Ctrl+C');
  assert.equal(C.ariaShortcutForMenu({ action: 'CurrentCopyToClipboardFocusedAction2' }), 'Ctrl+C');
  // Local and remote focused actions have no counterpart accelerator and must
  // not borrow a shortcut from the other side.
  assert.equal(C.shortcutForAction({ action: 'LocalCopyFocusedAction' }), '');
  assert.equal(C.shortcutForAction({ action: 'RemoteCopyFocusedAction' }), '');
});

test('file context providers retain the focused side while resolving shortcuts', () => {
  for (const side of ['local', 'remote']) {
    const items = M.fileContextItems({ side });
    assert.ok(items.length > 0, `${side} provider has menu items`);
    // buildMenuItems has already resolved the side-specific focused action;
    // every shortcut it exposes must still be renderable by the shared layer.
    for (const item of walkRendered(items).filter((entry) => entry.shortcut)) {
      assert.equal(C.shortcutForMenu(item, { platform: 'win32' }),
        C.shortcutForMenu({ shortcut: item.shortcut }, { platform: 'win32' }), `${side}:${item.label}`);
    }
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

test('anchored menus cap height before positioning so long dropdowns scroll', () => {
  const source = fs.readFileSync(path.join(ROOT, 'design/renderer/ui/contextmenu.js'), 'utf8');
  assert.match(source, /const viewportHeight = document\.documentElement\.clientHeight \|\| window\.innerHeight \|\| 0;/);
  assert.match(source, /root\.style\.maxHeight = `\$\{Math\.max\(1, viewportHeight - 12\)\}px`;/);
  assert.match(source, /if \(opts\.anchor\) \{/);
});

test('nested shortcut rows expose normalized visual and accessible key text', () => {
  const restore = installMenuDom();
  try {
    const parent = C.openMenu({
      platform: 'darwin',
      items: [{
        id: 'parent', label: 'Parent', shortcut: 'Ctrl+Shift+F7',
        submenu: [{ id: 'child', label: 'Back', shortcut: 'Alt+Left' }],
      }],
      x: 10, y: 10,
    });
    const parentRow = parent.element.children[0];
    const parentShortcut = parentRow.children[2];
    assert.equal(parentRow.getAttribute('aria-keyshortcuts'), 'Ctrl+Shift+F7');
    assert.equal(parentRow.getAttribute('aria-describedby'), parentShortcut.getAttribute('id'));
    assert.equal(parentShortcut.getAttribute('aria-label'), 'Ctrl+Shift+F7');
    assert.equal(nodeText(parentShortcut), '⌃+⇧+F7');

    parent.focusFirst();
    parent.element.dispatchEvent(keyEvent('ArrowRight'));
    const menuLayer = document.getElementById('layer-menu');
    const childMenu = menuLayer.children.find((menu) => menu !== parent.element);
    const childRow = childMenu.children[0];
    const childShortcut = childRow.children[2];
    assert.equal(childRow.getAttribute('aria-keyshortcuts'), 'Alt+ArrowLeft');
    assert.equal(childRow.getAttribute('aria-describedby'), childShortcut.getAttribute('id'));
    assert.equal(childShortcut.getAttribute('aria-label'), 'Alt+ArrowLeft');
    assert.equal(nodeText(childShortcut), '⌥+←');
  } finally {
    restore();
  }
});

test('submenu dismissal returns focus and clears the parent expanded state', () => {
  const restore = installMenuDom();
  try {
    const parent = C.openMenu({
      items: [{ id: 'more', label: 'More', submenu: [{ id: 'child', label: 'Child' }] }],
      x: 10, y: 10,
    });
    const parentRow = parent.element.children[0];
    parent.focusFirst();
    parent.element.dispatchEvent(keyEvent('ArrowRight'));

    const menuLayer = document.getElementById('layer-menu');
    assert.equal(menuLayer.children.length, 2, 'the child menu opened');
    const child = menuLayer.children.find((menu) => menu !== parent.element);
    child.dispatchEvent(keyEvent('ArrowLeft'));

    assert.equal(document.activeElement, parentRow, 'focus returns to the submenu owner');
    assert.equal(parentRow.getAttribute('aria-expanded'), 'false', 'the owner is no longer expanded');
    assert.equal(menuLayer.children.length, 1, 'the disposed child is removed');

    // The parent handle must not retain the disposed child: reopening with the
    // same row is the keyboard path used after ArrowLeft/Escape.
    parent.element.dispatchEvent(keyEvent('ArrowRight'));
    assert.equal(menuLayer.children.length, 2, 'the submenu can be reopened');
    const reopened = menuLayer.children.find((menu) => menu !== parent.element);
    reopened.dispatchEvent(keyEvent('Escape'));
    assert.equal(document.activeElement, parentRow, 'Escape also returns focus to the owner');
    assert.equal(parentRow.getAttribute('aria-expanded'), 'false');
  } finally {
    restore();
  }
});

test('selecting a dropdown item clears the opener state so keyboard can reopen it', () => {
  const restore = installMenuDom();
  try {
    const button = new MenuTestNode('button');
    button.isConnected = true;
    document.body.appendChild(button);
    C.attachMenuButton(button, () => [{ id: 'run', label: 'Run', onSelect: () => {} }], { label: 'Actions' });

    button.dispatchEvent({ type: 'click', target: button });
    assert.equal(button.getAttribute('aria-expanded'), 'true');
    const menu = document.getElementById('layer-menu');
    assert.equal(menu.children.length, 1);
    menu.children[0].children[0].dispatchEvent({ type: 'click', target: menu.children[0].children[0] });

    assert.equal(menu.children.length, 0, 'selection closes the menu');
    assert.equal(button.getAttribute('aria-expanded'), 'false', 'selection resets the opener state');
    button.dispatchEvent({ type: 'click', target: button });
    assert.equal(menu.children.length, 1, 'the same button can reopen the menu');
  } finally {
    restore();
  }
});
