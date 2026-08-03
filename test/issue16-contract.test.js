'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(REPO, relative), 'utf8');

test('shared search bars expose a named landmark and complete regex trigger state', () => {
  const source = read('design/renderer/ui/searchbar.js');
  assert.match(source, /role: 'search'/);
  assert.match(source, /'aria-label': t\(opts\.labelKey \|\| 'search'\)/);
  assert.match(source, /'aria-haspopup': 'dialog'/);
  assert.match(source, /'aria-expanded': 'false'/);
  assert.match(source, /setAttribute\('aria-controls', builder\.element\.id\)/);
  assert.match(source, /removeAttribute\('aria-controls'\)/);
});

test('search copy is live-bound instead of hard-coded English', () => {
  const source = read('design/renderer/ui/searchbar.js');
  assert.match(source, /bindRender\(root, paint\)/);
  assert.match(source, /t\('searchPlainHint'\)/);
  assert.match(source, /t\('searchRegexHint', state\.flags \|\| 'none'\)/);
  assert.match(source, /t\('searchNoMatch', scopeLabel, what\)/);
  assert.doesNotMatch(source, /Plain text search\. Press the \.\* button/);
});

test('regex builder exposes live labels, invalid state and preview semantics', () => {
  const source = read('design/renderer/ui/regexbuilder.js');
  assert.match(source, /bindRender\(root/);
  assert.match(source, /'aria-labelledby': ids\.title/);
  assert.match(source, /'aria-invalid', String\(!c\.ok\)/);
  assert.match(source, /role: 'region', 'aria-live': 'polite'/);
  assert.match(source, /RB_CONSTRUCT_KEYS/);
  assert.match(source, /RB_FLAG_KEYS/);
  assert.match(source, /t\('rbLiteralPrompt'\)/);
  assert.match(source, /unbindI18n\(\)/);
});

test('regex-builder dictionary covers every shipped guided construct, category and flag', async () => {
  const { RB_CONSTRUCT_KEYS, RB_CONSTRUCT_DESCRIPTION_KEYS, RB_CATEGORY_KEYS, RB_FLAG_KEYS, has } = await import('../design/renderer/i18n.js');
  const data = await import('../design/winscp-data.js');
  for (const item of data.REGEX_CONSTRUCTS) {
    assert.ok(has(RB_CONSTRUCT_KEYS[item.l]), item.l);
    assert.ok(has(RB_CONSTRUCT_DESCRIPTION_KEYS[item.l]), `${item.l} description`);
  }
  for (const item of data.RB_FLAGS) assert.ok(has(RB_FLAG_KEYS[item.f]), item.f);
  for (const key of Object.values(RB_CATEGORY_KEYS)) assert.ok(has(key), key);
});

test('search and regex messages preserve facts across both funny-level sliders', async () => {
  const [i18n, state] = await Promise.all([
    import('../design/renderer/i18n.js'),
    import('../design/renderer/state.js'),
  ]);
  state.setPersistenceEnabled(false);
  const sentinel = 'SCOPE-Δ / pattern';
  for (const language of ['en', 'yue']) {
    i18n.setLanguage(language);
    for (const level of [1, 3, 5]) {
      i18n.setFunnyLevel('en', level);
      i18n.setFunnyLevel('yue', level);
      const message = i18n.t('searchNoMatch', sentinel, sentinel);
      assert.equal(message.split(sentinel).length - 1, 2, `${language} level ${level}`);
      const valid = i18n.t('rbValid', 7, i18n.t('rbMatchMany'), 42);
      assert.match(valid, /7/);
      assert.match(valid, /42/);
    }
  }
  i18n.setLanguage('en');
  i18n.setFunnyLevel('en', 3);
  i18n.setFunnyLevel('yue', 3);
});

test('reduced-motion contract disables motion and explicit smooth scrolling', () => {
  const tokens = read('design/renderer/styles/tokens.css');
  const dom = read('design/renderer/dom.js');
  const preferences = read('design/renderer/ui/dialogs/preferences.js');
  const media = tokens.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/)?.[1] || '';
  assert.match(media, /animation: none !important/);
  assert.match(media, /transition: none !important/);
  assert.match(dom, /export function isReducedMotion\(\)/);
  assert.match(preferences, /behavior: isReducedMotion\(\) \? 'auto' : 'smooth'/);
});

test('dim-sum UI uses verified local assets in bridge and fallback paths', async () => {
  const dimsum = await import('../design/renderer/ui/dimsum.js');
  const data = await import('../design/winscp-data.js');
  const fallback = dimsum.normalizeDish(data.DISHES[0]);
  assert.ok(fallback.img.startsWith('file:'), fallback.img);
  assert.match(fallback.img, /dim-0001-har-gow\.png$/);

  const dataUri = dimsum.normalizeDish({
    id: 'main-catalog', en: 'Har Gow', zh: '蝦餃',
    dataUri: 'data:image/png;base64,AAAA',
    img: 'https://invalid.example/remote.png',
  });
  assert.equal(dataUri.img, 'data:image/png;base64,AAAA');
  assert.equal(dimsum.normalizeDish({ en: 'Remote', zh: '遠端', img: 'https://invalid.example/x.png' }), null);
});
