// overlay.test.js — the shared geometry contract for floating UI surfaces.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let DOM;
test.before(async () => {
  DOM = await import(pathToFileURL(path.join(__dirname, '..', 'design', 'renderer', 'dom.js')).href);
});

test('a tall anchored surface is capped to the actual side space', () => {
  const layout = DOM.overlayLayout({
    anchor: { left: 100, right: 120, top: 100, bottom: 120, width: 20, height: 20 },
    width: 300, height: 900, viewportWidth: 320, viewportHeight: 220,
    placement: 'bottom-start', gap: 6, padding: 8,
  });
  assert.equal(layout.side, 'bottom');
  assert.equal(layout.maxHeight, 86);
  assert.equal(layout.top, 126);
  assert.ok(layout.top + layout.height <= 220 - 8);
  assert.ok(layout.top >= 120 + 6, 'the capped surface still covers the anchor');
});

test('a surface flips when the opposite side genuinely has room', () => {
  const layout = DOM.overlayLayout({
    anchor: { left: 120, right: 140, top: 190, bottom: 210, width: 20, height: 20 },
    width: 180, height: 100, viewportWidth: 320, viewportHeight: 280,
    placement: 'bottom-start', gap: 6, padding: 8,
  });
  assert.equal(layout.side, 'top');
  assert.equal(layout.maxHeight, 176);
  assert.ok(layout.top + layout.height <= 280 - 8);
  assert.ok(layout.top + layout.height <= 190 - 6);
});

test('width and height remain bounded even below normal desktop dimensions', () => {
  const layout = DOM.overlayLayout({
    anchor: { left: 0, right: 2, top: 20, bottom: 22, width: 2, height: 2 },
    width: 900, height: 900, viewportWidth: 20, viewportHeight: 18,
    placement: 'bottom-start', gap: 2, padding: 3,
  });
  assert.ok(layout.width <= 20 - 6);
  assert.ok(layout.height <= 18 - 6);
  assert.ok(layout.left >= 3 && layout.top >= 3);
  assert.ok(layout.left + layout.width <= 20 - 3);
  assert.ok(layout.top + layout.height <= 18 - 3);
});

test('an off-screen anchor cannot donate space beyond the viewport', () => {
  const layout = DOM.overlayLayout({
    anchor: { left: 100, right: 120, top: 464, bottom: 492, width: 20, height: 28 },
    width: 300, height: 448, viewportWidth: 420, viewportHeight: 260,
    placement: 'bottom-start', gap: 6, padding: 8,
  });
  assert.equal(layout.side, 'top');
  assert.equal(layout.maxHeight, 244);
  assert.ok(layout.top >= 8 && layout.top + layout.height <= 260 - 8);
});

test('the production overlay surfaces have an explicit scroll/background contract', () => {
  const components = fs.readFileSync(path.join(__dirname, '..', 'design', 'renderer', 'styles', 'components.css'), 'utf8');
  const queue = fs.readFileSync(path.join(__dirname, '..', 'design', 'renderer', 'ui', 'queue.js'), 'utf8');
  const contextMenu = fs.readFileSync(path.join(__dirname, '..', 'design', 'renderer', 'ui', 'contextmenu.js'), 'utf8');
  assert.match(components, /\.rb-popover, \.cp-popover, \.ts, \.ap, \.nc\s*\{[\s\S]*?background: var\(--c-high\)/);
  assert.match(queue, /\.tx-q-popover\s*\{[\s\S]*?overflow: hidden;/);
  assert.match(queue, /\.tx-q-popbody\s*\{[\s\S]*?min-height: 0;[\s\S]*?overflow: hidden;/);
  assert.match(contextMenu, /root\.style\.maxHeight = `\$\{Math\.max\(1, viewportHeight - 12\)\}px`/);
});

test('blocking dialogs keep a scrollable body inside a narrow viewport', () => {
  const components = fs.readFileSync(path.join(__dirname, '..', 'design', 'renderer', 'styles', 'components.css'), 'utf8');
  assert.match(components, /padding: clamp\(8px, 4vh, 24px\) clamp\(8px, 4vw, 24px\)/);
  assert.match(components, /\.modal \{[\s\S]*?max-width: 100%;[\s\S]*?max-height: 100%;[\s\S]*?min-height: 0;[\s\S]*?box-sizing: border-box;[\s\S]*?overflow: hidden;/);
  assert.match(components, /\.modal-body \{[\s\S]*?overflow-y: auto;[\s\S]*?min-height: 0;/);
});
