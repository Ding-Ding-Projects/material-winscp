// site-app.test.js — the documentation site's client application.
//
// The site had no client application at all: index.html referenced app.js and
// app.css, neither had ever been committed, and every path under the published
// URL served a page that fetched two 404s and rendered nothing. These tests
// cover the parts of what replaced it that can be wrong QUIETLY — where a
// screenshot looks fine and the behaviour is broken:
//
//   * the router, whose article ids and in-page anchors are ambiguous by shape
//     (site/build.js emits `#/cat/article-anchor`, and every slug has hyphens);
//   * the regex engine behind every search bar, including the refusal that
//     stops a catastrophic pattern hanging the page;
//   * the colour translator, whose whole contract is that everything it prints
//     reads back as the same colour;
//   * the language system, where a level-5 rewrite that drops a parameter
//     still reads beautifully and has stopped telling the reader a fact;
//   * the settings store's normalisation, which is what stands between a
//     hand-edited export and an unstyled page.
//
// The modules are browser ES modules, loaded here with dynamic import exactly
// as design/renderer's tests load theirs. Anything that genuinely needs a DOM
// (the popover anchoring, the tab strip's width measurement, the colour field's
// pointer handling) is NOT tested here and is named in the handoff rather than
// pretended at.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const SRC = path.join(__dirname, '..', 'site', 'src', 'lib');
const load = (name) => import(pathToFileURL(path.join(SRC, `${name}.js`)).href);

/* ================================================================== */
/* the router                                                          */
/* ================================================================== */

/** A miniature content model with the shapes that actually break: a slug that
 *  contains hyphens, and a second slug that is a prefix of the first. */
function fixtureIndex() {
  const data = {
    categories: [
      {
        id: '/protocols',
        slug: 'protocols',
        label: ['Protocols', '協定'],
        articles: [
          { id: '/protocols/sftp', title: 'SFTP' },
          { id: '/protocols/sftp-extensions', title: 'SFTP extensions' },
        ],
      },
      { id: '/search-and-regex', slug: 'search-and-regex', label: ['Search', '搵'], articles: [] },
    ],
  };
  return { data };
}

test('parse() splits the hash into a path and a decoded query', async () => {
  const { parse } = await load('router');
  assert.deepStrictEqual(parse('#/search?q=har%20gow'), { path: '/search', query: { q: 'har gow' } });
  assert.deepStrictEqual(parse('#/protocols'), { path: '/protocols', query: {} });
  assert.deepStrictEqual(parse(''), { path: '/', query: {} });
  // A "+" in a query string is a space; leaving it literal makes a search for
  // "har gow" find nothing and look like the corpus is missing.
  assert.strictEqual(parse('#/search?q=har+gow').query.q, 'har gow');
});

test('the longest known id wins, so a hyphenated slug is not read as an anchor', async () => {
  const { buildIndex, resolve } = await load('router');
  const index = buildIndex(fixtureIndex().data);

  const exact = resolve('#/protocols/sftp-extensions', index);
  assert.strictEqual(exact.kind, 'article');
  assert.strictEqual(exact.article.id, '/protocols/sftp-extensions');
  assert.strictEqual(exact.anchor, '');
});

test('an unknown tail becomes the in-page anchor of the article that does exist', async () => {
  const { buildIndex, resolve } = await load('router');
  const index = buildIndex(fixtureIndex().data);

  // site/build.js turns `sftp.md#known-hosts` into `#/protocols/sftp-known-hosts`.
  const r = resolve('#/protocols/sftp-known-hosts', index);
  assert.strictEqual(r.kind, 'article');
  assert.strictEqual(r.article.id, '/protocols/sftp');
  assert.strictEqual(r.anchor, 'known-hosts');
});

test('categories resolve, and their anchors do too', async () => {
  const { buildIndex, resolve } = await load('router');
  const index = buildIndex(fixtureIndex().data);
  assert.strictEqual(resolve('#/protocols', index).kind, 'category');
  // The category slug itself contains hyphens — the prefix walk must not chop
  // "search-and-regex" down to "search".
  const cat = resolve('#/search-and-regex', index);
  assert.strictEqual(cat.kind, 'category');
  assert.strictEqual(cat.category.id, '/search-and-regex');
  const anchored = resolve('#/search-and-regex-the-rule', index);
  assert.strictEqual(anchored.category.id, '/search-and-regex');
  assert.strictEqual(anchored.anchor, 'the-rule');
});

test('the fixed routes and the unknown one', async () => {
  const { buildIndex, resolve, searchHref } = await load('router');
  const index = buildIndex(fixtureIndex().data);
  assert.strictEqual(resolve('#/', index).kind, 'home');
  assert.strictEqual(resolve('', index).kind, 'home');
  assert.strictEqual(resolve('#/settings', index).kind, 'settings');
  assert.strictEqual(resolve('#/search?q=x', index).q, 'x');
  assert.strictEqual(resolve('#/nope/at/all', index).kind, 'notfound');
  assert.strictEqual(searchHref('a b&c'), '#/search?q=a%20b%26c');
});

/* ================================================================== */
/* the regex engine behind every search bar                            */
/* ================================================================== */

test('plain text is the default and is a case-insensitive substring test', async () => {
  const { makePredicate } = await load('regex');
  const p = makePredicate({ query: 'ReGeX', mode: 'text' });
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.mode, 'text');
  assert.strictEqual(p.describe, 'contains "ReGeX"');
  assert.strictEqual(p.test('Search and regex'), true);
  assert.strictEqual(p.test('transfers'), false);
  // A dot is a dot in plain text, not "any character".
  assert.strictEqual(makePredicate({ query: 'a.c', mode: 'text' }).test('abc'), false);
  assert.strictEqual(makePredicate({ query: 'a.c', mode: 'text' }).test('a.c'), true);
});

test('an empty query is refused rather than treated as matching everything', async () => {
  const { makePredicate, invert } = await load('regex');
  const p = makePredicate({ query: '', mode: 'text' });
  assert.strictEqual(p.ok, false);
  assert.strictEqual(p.empty, true);
  assert.strictEqual(p.test('anything'), false);
  // Inverting an unusable predicate must not turn it into "matches all" — that
  // is the bug that closes every tab.
  const inv = invert(p);
  assert.strictEqual(inv.ok, false);
  assert.strictEqual(inv.test('anything'), false);
});

test('the inverse is built from the same predicate, so the two cannot drift', async () => {
  const { makePredicate, invert } = await load('regex');
  const base = makePredicate({ pattern: '^q[1-4]', flags: 'i', mode: 'regex' });
  const inv = invert(base);
  for (const s of ['Q1 report', 'q4', 'annual', 'xq1']) {
    assert.strictEqual(inv.test(s), !base.test(s), s);
  }
  // The negated description is carried, not assembled from the positive one:
  // "does not " + "matches …" reads "does not matches", and this string is
  // shown in a destructive confirmation.
  assert.strictEqual(inv.describe, 'does not match /^q[1-4]/i');
  assert.strictEqual(invert(inv).describe, base.describe, 'inverting twice did not come back');

  const text = makePredicate({ query: 'report', mode: 'text' });
  assert.strictEqual(text.describe, 'contains "report"');
  assert.strictEqual(invert(text).describe, 'does not contain "report"');
});

test('a regex predicate never carries /g, so .test() cannot alternate', async () => {
  const { makePredicate } = await load('regex');
  const p = makePredicate({ pattern: 'a', flags: 'gi', mode: 'regex' });
  // With a sticky lastIndex this returns true, false, true, … on the SAME
  // string, which is the single most confusing bug a search box can have.
  assert.strictEqual(p.test('banana'), true);
  assert.strictEqual(p.test('banana'), true);
  assert.strictEqual(p.test('banana'), true);
});

test('catastrophic shapes are refused before they are run', async () => {
  const { backtrackingRisk, makePredicate, evaluate, RUNAWAY_REFUSAL } = await load('regex');
  for (const bad of ['(a+)+$', '(a|aa)*b', '(\\w*)+@', '(x+){2,}']) {
    assert.strictEqual(backtrackingRisk(bad), RUNAWAY_REFUSAL, bad);
  }
  for (const fine of ['^q[1-4]', 'a+b+', '(foo|bar)', '\\d{3}-\\d{4}', '(?:ab)+']) {
    assert.strictEqual(backtrackingRisk(fine), null, fine);
  }
  const p = makePredicate({ pattern: '(a+)+$', flags: '', mode: 'regex' });
  assert.strictEqual(p.ok, false);
  assert.strictEqual(p.runaway, true);
  const e = evaluate('(a+)+$', '', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaa!');
  assert.strictEqual(e.ok, false);
  assert.strictEqual(e.runaway, true);
});

test('an invalid pattern is reported, not thrown', async () => {
  const { makePredicate, evaluate, compile } = await load('regex');
  assert.strictEqual(compile('[unclosed', '').ok, false);
  const p = makePredicate({ pattern: '[unclosed', flags: '', mode: 'regex' });
  assert.strictEqual(p.ok, false);
  assert.ok(p.error);
  assert.strictEqual(p.test('anything'), false);
  assert.strictEqual(evaluate('[unclosed', '', 'abc').ok, false);
});

test('evaluate() reports matches, capture groups and named groups', async () => {
  const { evaluate } = await load('regex');
  const r = evaluate('(?<word>\\w+)@(\\w+)', 'g', 'ann@example bob@sample');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.matches.length, 2);
  assert.strictEqual(r.matches[0].text, 'ann@example');
  assert.strictEqual(r.matches[0].index, 0);
  assert.deepStrictEqual(r.matches[0].groups.map((g) => g.text), ['ann', 'example']);
  assert.strictEqual(r.matches[0].named.word, 'ann');
});

test('a zero-width match advances instead of spinning forever', async () => {
  const { evaluate } = await load('regex');
  // Without the lastIndex nudge this never returns.
  const r = evaluate('a*', 'g', 'bbb', { timeBudget: 1000 });
  assert.strictEqual(r.ok, true);
  assert.ok(r.matches.length > 0 && r.matches.length <= 500);
  assert.strictEqual(r.matches.every((m) => m.empty), true);
});

test('evaluation is bounded by match count, sample size and wall clock', async () => {
  const { evaluate, MAX_SAMPLE } = await load('regex');
  const many = evaluate('a', 'g', 'a'.repeat(2000), { maxMatches: 10 });
  assert.strictEqual(many.matches.length, 10);
  assert.strictEqual(many.truncated, true);

  const huge = evaluate('a', 'g', 'a'.repeat(MAX_SAMPLE + 500), { maxMatches: 5 });
  assert.strictEqual(huge.sampleTruncated, true);

  // A time budget of zero stops after the first match rather than running the
  // corpus, which is what makes the budget real rather than decorative.
  let t = 0;
  const timed = evaluate('a', 'g', 'a'.repeat(1000), { timeBudget: 0, now: () => (t += 5) });
  assert.strictEqual(timed.timedOut, true);
  assert.ok(timed.matches.length < 1000);
});

test('escapeLiteral makes a literal mean itself, so text → regex keeps meaning', async () => {
  const { escapeLiteral, makePredicate } = await load('regex');
  const literal = 'a.c[1]+ (x)';
  const escaped = escapeLiteral(literal);
  const asText = makePredicate({ query: literal, mode: 'text' });
  const asRegex = makePredicate({ pattern: escaped, flags: 'i', mode: 'regex' });
  for (const [probe, expected] of [['zzz a.c[1]+ (x) zzz', true], ['abc1 x', false]]) {
    assert.strictEqual(asText.test(probe), expected, `text: ${probe}`);
    assert.strictEqual(asRegex.test(probe), expected, `regex: ${probe}`);
  }
});

/* ================================================================== */
/* the colour translator                                               */
/* ================================================================== */

const SAMPLES = ['#000000', '#ffffff', '#0b57d0', '#663399', '#ff0000', '#7f7f7f', '#123456', '#00ff7f'];

test('every notation the picker prints reads back as the same colour', async () => {
  const { rgbFromHex, formatColor, parseAnyColor, NOTATIONS, hexFromRgb } = await load('color');
  for (const hex of SAMPLES) {
    const { rgb } = rgbFromHex(hex);
    for (const notation of NOTATIONS) {
      const printed = formatColor(rgb, 1, notation);
      if (printed === '(no CSS name)') continue;      // honest, and not parseable
      const back = parseAnyColor(printed);
      assert.ok(back, `${notation} produced unparseable ${JSON.stringify(printed)}`);
      const got = back.rgb.map((v) => Math.round(v));
      for (let i = 0; i < 3; i++) {
        assert.ok(Math.abs(got[i] - Math.round(rgb[i])) <= 1,
          `${hex} via ${notation} (${printed}) came back ${hexFromRgb(back.rgb)}`);
      }
    }
  }
});

test('alpha survives the notations that can carry it, and is flagged in the ones that cannot', async () => {
  const { rgbFromHex, formatColor, parseAnyColor, translate, ALPHA_FREE } = await load('color');
  const { rgb } = rgbFromHex('#0b57d0');
  for (const n of ['HEX8', 'RGBA', 'HSLA']) {
    const back = parseAnyColor(formatColor(rgb, 0.5, n));
    assert.ok(Math.abs(back.a - 0.5) < 0.01, `${n} lost alpha`);
  }
  const rows = translate(rgb, 0.5);
  for (const row of rows) {
    assert.strictEqual(row.losesAlpha, ALPHA_FREE.has(row.notation), row.notation);
  }
  // The point of the flag: the UI can say so instead of dropping it silently.
  assert.ok(rows.some((r) => r.losesAlpha));
});

test('parseAnyColor is liberal about separators and refuses nonsense', async () => {
  const { parseAnyColor, hexFromRgb } = await load('color');
  for (const s of ['rgb(11,87,208)', 'rgb(11 87 208)', 'RGB( 11 , 87 , 208 )', '#0b57d0', '0b57d0']) {
    assert.strictEqual(hexFromRgb(parseAnyColor(s).rgb), '#0b57d0', s);
  }
  assert.strictEqual(parseAnyColor('rgb(11 87 208 / 50%)').a, 0.5);
  assert.strictEqual(hexFromRgb(parseAnyColor('rebeccapurple').rgb), '#663399');
  assert.deepStrictEqual(parseAnyColor('transparent'), { rgb: [0, 0, 0], a: 0, notation: 'Named' });
  for (const bad of ['', 'not a colour', 'rgb(', 'hsl(1)', null, undefined, '#gg']) {
    assert.strictEqual(parseAnyColor(bad), null, JSON.stringify(bad));
  }
});

test('contrast is the real WCAG ratio, not an approximation', async () => {
  const { contrastHex } = await load('color');
  // The two anchors every implementation must agree on.
  assert.ok(Math.abs(contrastHex('#000000', '#ffffff') - 21) < 0.01);
  assert.ok(Math.abs(contrastHex('#ffffff', '#ffffff') - 1) < 0.001);
  assert.ok(Math.abs(contrastHex('#767676', '#ffffff') - 4.54) < 0.05);
});

test('a scheme built from any seed keeps its foreground pairs readable', async () => {
  const { buildScheme, contrastHex } = await load('color');
  const pairs = [
    ['primary', 'onPrimary'], ['primaryContainer', 'onPrimaryContainer'],
    ['secondaryContainer', 'onSecondaryContainer'], ['surface', 'onSurface'],
    ['error', 'onError'], ['errorContainer', 'onErrorContainer'],
  ];
  for (const seed of ['#0b57d0', '#663399', '#b3261e', '#00ff7f', '#000000', '#ffffff']) {
    for (const dark of [false, true]) {
      const s = buildScheme(seed, dark);
      for (const [bg, fg] of pairs) {
        const ratio = contrastHex(s[bg], s[fg]);
        assert.ok(ratio >= 4.5,
          `seed ${seed} ${dark ? 'dark' : 'light'}: ${bg}/${fg} is ${ratio.toFixed(2)}:1`);
      }
    }
  }
});

test('the extra-contrast control actually increases contrast', async () => {
  const { buildScheme, contrastHex } = await load('color');
  for (const dark of [false, true]) {
    const plain = buildScheme('#0b57d0', dark, 0);
    const boosted = buildScheme('#0b57d0', dark, 1);
    assert.ok(contrastHex(boosted.surface, boosted.onSurface) >= contrastHex(plain.surface, plain.onSurface));
  }
});

test('tone 0 is black, tone 100 is white, and the ladder is monotonic', async () => {
  const { toneHex, tonalPalettes, relativeLuminance, rgbFromHex } = await load('color');
  const pals = tonalPalettes('#0b57d0');
  assert.strictEqual(toneHex(pals.neutral.hue, pals.neutral.chroma, 0), '#000000');
  assert.strictEqual(toneHex(pals.neutral.hue, pals.neutral.chroma, 100), '#ffffff');
  let previous = -1;
  for (const tone of [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]) {
    const l = relativeLuminance(rgbFromHex(toneHex(pals.primary.hue, pals.primary.chroma, tone)).rgb);
    assert.ok(l > previous, `tone ${tone} is not lighter than the one below it`);
    previous = l;
  }
});

test('the CSS variable name for a role is the Material one', async () => {
  const { cssVarName } = await load('color');
  assert.strictEqual(cssVarName('onSurfaceVariant'), '--md-sys-color-on-surface-variant');
  assert.strictEqual(cssVarName('surfaceContainerHighest'), '--md-sys-color-surface-container-highest');
});

/* ================================================================== */
/* the language system                                                 */
/* ================================================================== */

test('every language mode renders, and bilingual carries both halves', async () => {
  const { text, resolve } = await load('i18n');
  const en = text('settings', { lang: 'en' });
  const yue = text('settings', { lang: 'yue' });
  assert.strictEqual(en, 'Settings');
  assert.strictEqual(yue, '設定');
  assert.strictEqual(text('settings', { lang: 'both' }), 'Settings · 設定');
  const r = resolve('settings', { lang: 'en' });
  assert.deepStrictEqual([r.en, r.yue], ['Settings', '設定']);
});

test('the two funny levels are independent, and each changes only its own language', async () => {
  const { resolve } = await load('i18n');
  const a = resolve('heroTitle', { funnyEn: 1, funnyYue: 1 });
  const b = resolve('heroTitle', { funnyEn: 5, funnyYue: 1 });
  const c = resolve('heroTitle', { funnyEn: 1, funnyYue: 5 });
  assert.notStrictEqual(a.en, b.en, 'the English slider did not change English');
  assert.strictEqual(a.yue, b.yue, 'the English slider changed Cantonese');
  assert.notStrictEqual(a.yue, c.yue, 'the Cantonese slider did not change Cantonese');
  assert.strictEqual(a.en, c.en, 'the Cantonese slider changed English');
});

test('every leveled entry has five distinct-enough levels in both languages', async () => {
  const { DICT, leveledKeys } = await load('i18n');
  const keys = leveledKeys();
  assert.ok(keys.length >= 8, `only ${keys.length} leveled entries`);
  for (const key of keys) {
    for (const side of [0, 1]) {
      const levels = DICT[key][side];
      assert.strictEqual(Array.isArray(levels), true, `${key}[${side}] is not leveled`);
      assert.strictEqual(levels.length, 5, `${key}[${side}] has ${levels.length} levels`);
      for (const l of levels) assert.ok(String(l).trim().length, `${key}[${side}] has an empty level`);
      // Level 1 must actually be more serious than level 5 — five copies of one
      // sentence is a slider that does nothing.
      assert.notStrictEqual(levels[0], levels[4], `${key}[${side}] levels 1 and 5 are identical`);
    }
  }
});

/**
 * THE CENTRAL LANGUAGE TEST: the level changes voice, never facts.
 *
 * Every parameter of every leveled entry is substituted with a byte-distinct
 * sentinel and the sentinel must survive — same bytes, the same number of
 * times — at all five levels in both languages. A rewrite that loses "{0}"
 * from a warning still reads beautifully and has silently stopped naming the
 * thing the warning is about, and no screenshot catches that.
 */
test('no funny level drops, mangles or duplicates a parameter', async () => {
  const { DICT, resolve, paramsOf } = await load('i18n');
  for (const [key, entry] of Object.entries(DICT)) {
    const params = paramsOf(entry);
    if (!params.length) continue;
    const highest = Math.max(...params.map((p) => Number(p.slice(1, -1))));
    const sentinels = Array.from({ length: highest + 1 }, (_, i) => `☃SENTINEL${i}☃`);
    for (let level = 1; level <= 5; level++) {
      const r = resolve(key, { funnyEn: level, funnyYue: level }, sentinels);
      for (const side of ['en', 'yue']) {
        for (const p of params) {
          const s = sentinels[Number(p.slice(1, -1))];
          const count = r[side].split(s).length - 1;
          assert.strictEqual(count, 1,
            `${key}.${side} level ${level}: ${p} appears ${count} times, not once — ${JSON.stringify(r[side])}`);
        }
        assert.ok(!/\{\d+\}/.test(r[side]),
          `${key}.${side} level ${level} left an unsubstituted placeholder: ${JSON.stringify(r[side])}`);
      }
    }
  }
});

test('a missing key is reported rather than rendering "undefined"', async () => {
  const { text } = await load('i18n');
  assert.strictEqual(text('noSuchKeyAnywhere', { lang: 'en' }), '(missing copy)');
});

/* ================================================================== */
/* the settings store                                                  */
/* ================================================================== */

test('normalize fills every gap, so an old profile cannot produce undefined', async () => {
  const { normalize, DEFAULTS } = await load('store');
  const n = normalize({ theme: 'dark' });
  assert.deepStrictEqual(Object.keys(n).sort(), Object.keys(DEFAULTS).sort());
  assert.strictEqual(n.theme, 'dark');
  assert.strictEqual(n.fontSize, DEFAULTS.fontSize);
  for (const v of [null, undefined, 'nonsense', 42, []]) {
    assert.deepStrictEqual(normalize(v), DEFAULTS, JSON.stringify(v));
  }
});

test('normalize clamps ranges and rejects values outside an enum', async () => {
  const { normalize, DEFAULTS } = await load('store');
  assert.strictEqual(normalize({ funnyEn: 99 }).funnyEn, 5);
  assert.strictEqual(normalize({ funnyYue: -4 }).funnyYue, 1);
  assert.strictEqual(normalize({ fontSize: 400 }).fontSize, 24);
  assert.strictEqual(normalize({ density: 7 }).density, 0);
  assert.strictEqual(normalize({ theme: 'chartreuse' }).theme, DEFAULTS.theme);
  assert.strictEqual(normalize({ lang: 'klingon' }).lang, DEFAULTS.lang);
  assert.strictEqual(normalize({ fontFamily: 'comic' }).fontFamily, DEFAULTS.fontFamily);
  // A seed that is not a real hex would reach a CSS variable and unstyle the page.
  assert.strictEqual(normalize({ seed: 'red' }).seed, DEFAULTS.seed);
  assert.strictEqual(normalize({ seed: '#ABCDEF' }).seed, '#abcdef');
});

test('the store persists, notifies exactly the changed keys, and resets', async () => {
  const { createStore, memoryBackend, DEFAULTS, STORAGE_KEY } = await load('store');
  const backend = memoryBackend();
  const store = createStore(backend);
  const seen = [];
  store.subscribe((_, changed) => seen.push(changed));

  assert.deepStrictEqual(store.set({ funnyEn: 5 }), ['funnyEn']);
  assert.deepStrictEqual(store.set({ funnyEn: 5 }), [], 'an unchanged value still notified');
  assert.deepStrictEqual(seen, [['funnyEn']]);
  assert.strictEqual(JSON.parse(backend.getItem(STORAGE_KEY)).funnyEn, 5);

  store.reset('funnyEn');
  assert.strictEqual(store.get().funnyEn, DEFAULTS.funnyEn);

  // A reloaded store sees what the previous one wrote.
  store.set({ lang: 'both', seed: '#663399' });
  const reloaded = createStore(backend);
  assert.strictEqual(reloaded.get().lang, 'both');
  assert.strictEqual(reloaded.get().seed, '#663399');
});

test('a storage backend that throws degrades instead of breaking the page', async () => {
  const { createStore } = await load('store');
  const hostile = {
    getItem() { throw new Error('private mode'); },
    setItem() { throw new Error('private mode'); },
  };
  const store = createStore(hostile);
  assert.strictEqual(store.persistenceBroken, true);
  assert.doesNotThrow(() => store.set({ lang: 'yue' }));
  assert.strictEqual(store.get().lang, 'yue');
});

test('export round-trips, and a foreign file is rejected with a reason', async () => {
  const { makeExport, parseExport, DEFAULTS, EXPORT_KIND } = await load('store');
  const settings = { ...DEFAULTS, lang: 'both', seed: '#663399', funnyYue: 5 };
  const file = makeExport(settings, { site: 'https://example.invalid' });
  assert.strictEqual(JSON.parse(file).kind, EXPORT_KIND);

  const back = parseExport(file);
  assert.strictEqual(back.ok, true);
  assert.strictEqual(back.settings.lang, 'both');
  assert.strictEqual(back.settings.seed, '#663399');

  for (const [bad, why] of [['{ not json', /JSON/], ['{"kind":"something-else"}', /kind/], ['null', /object/]]) {
    const r = parseExport(bad);
    assert.strictEqual(r.ok, false);
    assert.match(r.error, why);
  }
  // A tampered export is normalised on the way in rather than trusted.
  const tampered = JSON.stringify({ kind: EXPORT_KIND, settings: { fontSize: 9999, theme: 'neon' } });
  assert.strictEqual(parseExport(tampered).settings.fontSize, 24);
  assert.strictEqual(parseExport(tampered).settings.theme, DEFAULTS.theme);
});

/* ================================================================== */
/* tab-strip model and the dim sum draw                                */
/* ================================================================== */

test('the stored tab strip is normalised: home survives, junk does not', async () => {
  const { normalizeTabs } = await load('tabs');
  const titleFor = (id) => ({ '/': 'Home', '/protocols': 'Protocols', '/protocols/sftp': 'SFTP' }[id] || null);

  const fresh = normalizeTabs(null, { titleFor });
  assert.deepStrictEqual(fresh.open, [{ id: '/', pinned: true }]);
  assert.strictEqual(fresh.active, '/');

  const stored = normalizeTabs({
    open: [{ id: '/protocols', pinned: false }, { id: '/gone', pinned: true },
      { id: '/protocols', pinned: true }, { id: null }],
    active: '/protocols',
  }, { titleFor });
  // A tab whose page no longer exists is dropped, a duplicate is collapsed,
  // and home is always present as the floor.
  assert.deepStrictEqual(stored.open, [{ id: '/', pinned: true }, { id: '/protocols', pinned: false }]);
  assert.strictEqual(stored.active, '/protocols');

  // An active id that no longer resolves falls back to home rather than
  // rendering a blank page on the next visit.
  assert.strictEqual(normalizeTabs({ open: [], active: '/gone' }, { titleFor }).active, '/');
});

test('the dim sum draw is exactly the advertised chance and never fires on an empty catalog', async () => {
  const { draw, CHANCE } = await load('dimsum');
  const catalog = [{ id: 'a', en: 'Har Gow', zh: '蝦餃', file: 'a.png' }, { id: 'b', en: 'Siu Mai', zh: '燒賣', file: 'b.png' }];
  assert.strictEqual(CHANCE, 0.10);
  assert.ok(draw(catalog, () => 0.0));
  assert.ok(draw(catalog, () => 0.0999));
  assert.strictEqual(draw(catalog, () => 0.1), null);
  assert.strictEqual(draw(catalog, () => 0.5), null);
  assert.strictEqual(draw([], () => 0), null);
  assert.strictEqual(draw(null, () => 0), null);

  // Over a uniform sweep the observed rate is the stated one, so the surprise
  // cannot quietly become more frequent than the page claims.
  let hits = 0;
  for (let i = 0; i < 1000; i++) if (draw(catalog, () => i / 1000)) hits++;
  assert.strictEqual(hits, 100);
});

/* ================================================================== */
/* the site search                                                     */
/* ================================================================== */

test('searchArticles finds a hit in a title and in body text, and honours the predicate', async () => {
  const { searchArticles } = await import(pathToFileURL(path.join(SRC, 'pages.js')).href);
  const { makePredicate } = await load('regex');
  const data = {
    categories: [{
      id: '/protocols', title: 'Protocols', label: ['Protocols', '協定'],
      articles: [
        { id: '/protocols/sftp', title: 'SFTP', summary: '', headings: [], html: '<p>known hosts</p>' },
        { id: '/protocols/s3', title: 'S3', summary: '', headings: [{ text: 'Signing' }], html: '<p>nothing</p>' },
      ],
    }],
  };
  assert.strictEqual(searchArticles(data, makePredicate({ query: 'sftp', mode: 'text' })).length, 1);
  assert.strictEqual(searchArticles(data, makePredicate({ query: 'known hosts', mode: 'text' }))[0].in, 'body');
  assert.strictEqual(searchArticles(data, makePredicate({ query: 'signing', mode: 'text' }))[0].article.id, '/protocols/s3');
  // A refused predicate returns nothing rather than everything.
  assert.deepStrictEqual(searchArticles(data, makePredicate({ query: '', mode: 'text' })), []);
  assert.deepStrictEqual(searchArticles(data, makePredicate({ pattern: '(a+)+$', mode: 'regex' })), []);
  // Regex mode reaches the same corpus as plain text.
  assert.strictEqual(searchArticles(data, makePredicate({ pattern: '^S\\d$', flags: '', mode: 'regex' }))[0].article.id, '/protocols/s3');
});
