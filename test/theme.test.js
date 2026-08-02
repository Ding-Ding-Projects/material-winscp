// theme.test.js — the HCT colour engine in design/renderer/theme.js.
//
// theme.js derives the whole Material 3 scheme from a single seed using a real
// CAM16 implementation rather than an HSL approximation. That distinction is
// invisible in a screenshot and decisive in a contrast audit: an HSL "tonal
// palette" produces containers that look plausible and still fail WCAG at the
// same tone number, because HSL lightness is not perceptual. So the maths is
// asserted here with numbers.
//
// Everything under test is deliberately DOM-free — applyTheme() writes to
// :root, but buildScheme/tonalPalettes/hexFromHct/contrastHex do not touch the
// document — so this file runs headlessly with no browser stub.
'use strict';
const test = require('node:test');
const assert = require('node:assert');

/** theme.js is an ES module; CommonJS reaches it through dynamic import. */
const load = () => import('../design/renderer/theme.js');

/** Seeds spanning the hue circle plus the achromatic and clipping extremes. */
const SEEDS = [
  '#0B57D0', // the app's default
  '#146C2E', '#B3261E', '#6750A4', '#00696E', '#FFDE3F',
  '#FF00FF', '#00FF00', '#123456',
  '#000000', '#FFFFFF', '#7F7F7F', // achromatic: chroma ~0, hue undefined
];

/**
 * Every foreground/background pair the UI actually composes. A role map that
 * passes in isolation but pairs a light "on" role against a light container is
 * the failure this table exists to catch.
 */
const CONTRAST_PAIRS = [
  ['onSurface', 'surface'],
  ['onBackground', 'background'],
  ['onSurfaceVariant', 'surfaceVariant'],
  ['onPrimary', 'primary'],
  ['onPrimaryContainer', 'primaryContainer'],
  ['onSecondary', 'secondary'],
  ['onSecondaryContainer', 'secondaryContainer'],
  ['onTertiary', 'tertiary'],
  ['onTertiaryContainer', 'tertiaryContainer'],
  ['onError', 'error'],
  ['onErrorContainer', 'errorContainer'],
  ['inverseOnSurface', 'inverseSurface'],
  ['onSurface', 'surfaceContainerLowest'],
  ['onSurface', 'surfaceContainerHighest'],
  ['onSurfaceVariant', 'surfaceContainer'],
];

/* ================================================================== */
/* tone is CIE L*                                                      */
/* ================================================================== */

test('tone is CIE L*: yFromLstar and lstarFromY are exact inverses', async () => {
  const { yFromLstar, lstarFromY } = await load();

  for (let tone = 0; tone <= 100; tone += 1) {
    const back = lstarFromY(yFromLstar(tone));
    assert.ok(Math.abs(back - tone) < 1e-9,
      `tone ${tone} round-tripped to ${back}`);
  }

  // The anchors the rest of the engine is calibrated against.
  assert.strictEqual(yFromLstar(0), 0);
  assert.strictEqual(yFromLstar(100), 100);
  // Mid grey: L* 50 is 18.42 % relative luminance, not 50 %. This single number
  // is why tones cannot be derived from HSL lightness.
  assert.ok(Math.abs(yFromLstar(50) - 18.418651) < 1e-5,
    `yFromLstar(50) was ${yFromLstar(50)}`);

  // Strictly increasing, so the tone ladder never doubles back.
  let prev = -1;
  for (let tone = 0; tone <= 100; tone += 0.5) {
    const y = yFromLstar(tone);
    assert.ok(y > prev, `Y did not increase at tone ${tone}`);
    prev = y;
  }
});

/* ================================================================== */
/* CAM16 forward / inverse                                             */
/* ================================================================== */

test('CAM16 round-trips every in-gamut sRGB colour exactly', async () => {
  const { hctFromHex, rgbFromHct, hexFromRgb } = await load();

  let checked = 0;
  for (let r = 0; r < 256; r += 17) {
    for (let g = 0; g < 256; g += 17) {
      for (let b = 0; b < 256; b += 17) {
        const hex = hexFromRgb([r, g, b]);
        const { hue, chroma, tone } = hctFromHex(hex);
        // Below tone 5 / above tone 95 and below chroma 1 the solver takes its
        // documented neutral shortcut; that branch is asserted separately.
        if (tone < 5 || tone > 95 || chroma < 1) continue;
        checked += 1;
        // `+ 0` normalises the -0 a clamped-to-zero channel can carry; it is
        // invisible to hexFromRgb but not to deepStrictEqual.
        const back = rgbFromHct(hue, chroma, tone).map((v) => v + 0);
        assert.deepStrictEqual(back, [r, g, b],
          `${hex} -> H${hue.toFixed(2)} C${chroma.toFixed(2)} T${tone.toFixed(2)} -> ${hexFromRgb(back)}`);
        assert.strictEqual(hexFromRgb(back), hex);
      }
    }
  }
  // Guard the guard: if the filter above ever swallowed the whole sweep the
  // assertions inside would silently stop running.
  assert.ok(checked > 1500, `only ${checked} colours were exercised`);
});

test('hexFromHct lands on the requested tone', async () => {
  const { hexFromHct, hctFromHex, TONES } = await load();

  let worst = 0;
  for (const hue of [0, 45, 90, 135, 180, 225, 270, 315]) {
    for (const tone of TONES) {
      const actual = hctFromHex(hexFromHct(hue, 48, tone)).tone;
      worst = Math.max(worst, Math.abs(actual - tone));
    }
  }
  // The solver's own acceptance window is 0.2 L*; a quarter of a step is the
  // contract, and anything looser would let a container drift into its
  // neighbour's tone.
  assert.ok(worst <= 0.25, `worst tone error was ${worst.toFixed(3)} L*`);

  // The endpoints are exact, not merely close.
  assert.strictEqual(hexFromHct(270, 80, 0), '#000000');
  assert.strictEqual(hexFromHct(270, 80, 100), '#ffffff');
});

test('hue wraps rather than clipping', async () => {
  const { hexFromHct } = await load();
  const at270 = hexFromHct(270, 48, 40);
  assert.strictEqual(hexFromHct(-90, 48, 40), at270);
  assert.strictEqual(hexFromHct(630, 48, 40), at270);
  assert.match(at270, /^#[0-9a-f]{6}$/);
});

test('a chroma below 1 or a tone at either end returns the documented neutral', async () => {
  const { hexFromHct, hctFromHex } = await load();

  for (const [hue, chroma, tone] of [[270, 0.5, 40], [30, 0, 60], [180, 0.9, 20]]) {
    const hex = hexFromHct(hue, chroma, tone);
    const rgb = [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)];
    assert.strictEqual(new Set(rgb).size, 1, `${hex} is not a grey`);
    // The grey still sits on the requested tone.
    assert.ok(Math.abs(hctFromHex(hex).tone - tone) < 0.6, `${hex} missed tone ${tone}`);
  }
});

/* ================================================================== */
/* the chroma gamut solver                                             */
/* ================================================================== */

test('an out-of-gamut chroma degrades the chroma, never the hue or the tone', async () => {
  const { hexFromHct, hctFromHex } = await load();

  for (const hue of [25, 145, 258, 300]) {
    for (const tone of [20, 40, 50, 80, 90]) {
      const hex = hexFromHct(hue, 200, tone);      // far outside sRGB
      assert.match(hex, /^#[0-9a-f]{6}$/);
      const got = hctFromHex(hex);

      assert.ok(Math.abs(got.tone - tone) <= 0.25,
        `hue ${hue} tone ${tone}: tone drifted to ${got.tone.toFixed(2)}`);

      let hueErr = Math.abs(got.hue - hue);
      hueErr = Math.min(hueErr, 360 - hueErr);
      assert.ok(hueErr <= 4.5,
        `hue ${hue} tone ${tone}: hue drifted ${hueErr.toFixed(2)}° to ${got.hue.toFixed(2)}`);

      assert.ok(got.chroma < 200, 'sRGB cannot hold chroma 200; the solver claimed it did');
      assert.ok(got.chroma > 5, `hue ${hue} tone ${tone}: solver collapsed to chroma ${got.chroma.toFixed(2)}`);
    }
  }
});

test('the delivered chroma never falls as the request rises', async () => {
  const { hexFromHct, hctFromHex } = await load();

  for (const tone of [20, 40, 50, 80]) {
    let prev = -1;
    for (const request of [10, 20, 40, 60, 80, 120, 200]) {
      const got = hctFromHex(hexFromHct(258, request, tone)).chroma;
      // 0.5 of slack: the ceiling search terminates on a 0.4-wide bracket.
      assert.ok(got >= prev - 0.5,
        `tone ${tone}: chroma ${request} delivered ${got.toFixed(2)} after ${prev.toFixed(2)}`);
      // A request inside the gamut is honoured, not merely approached.
      if (request <= 20) assert.ok(Math.abs(got - request) <= 1.5,
        `tone ${tone}: in-gamut chroma ${request} came back as ${got.toFixed(2)}`);
      prev = got;
    }
  }
});

test('the chroma ceiling peaks at mid tone', async () => {
  const { hexFromHct, hctFromHex } = await load();
  const ceiling = (tone) => hctFromHex(hexFromHct(258, 200, tone)).chroma;

  const dark = ceiling(20);
  const mid = ceiling(50);
  const light = ceiling(90);
  assert.ok(mid > dark, `mid ${mid.toFixed(1)} should beat dark ${dark.toFixed(1)}`);
  assert.ok(mid > light, `mid ${mid.toFixed(1)} should beat light ${light.toFixed(1)}`);
});

/* ================================================================== */
/* tonal palettes                                                      */
/* ================================================================== */

test('a tonal palette holds its seed hue across every tone', async () => {
  const { tonalPalettes, hctFromHex } = await load();

  for (const seed of SEEDS) {
    const seedHue = hctFromHex(seed).hue;
    const primary = tonalPalettes(seed).primary;
    for (const tone of [10, 20, 30, 40, 50, 60, 70, 80, 90]) {
      const got = hctFromHex(primary.tone(tone));
      if (got.chroma < 5) continue;              // near-neutral: hue is meaningless
      let drift = Math.abs(got.hue - seedHue);
      drift = Math.min(drift, 360 - drift);
      assert.ok(drift <= 4.5,
        `${seed} tone ${tone}: hue drifted ${drift.toFixed(2)}° (${seedHue.toFixed(1)} -> ${got.hue.toFixed(1)})`);
    }
  }
});

test('neutral palettes are neutral and neutralVariant is not', async () => {
  const { tonalPalettes, hctFromHex } = await load();
  const pals = tonalPalettes('#0B57D0');

  for (const tone of [10, 30, 50, 70, 90]) {
    const n = hctFromHex(pals.neutral.tone(tone)).chroma;
    const nv = hctFromHex(pals.neutralVariant.tone(tone)).chroma;
    assert.ok(n <= 5, `neutral tone ${tone} carried chroma ${n.toFixed(2)}`);
    assert.ok(nv > n, `neutralVariant tone ${tone} (${nv.toFixed(2)}) is not more chromatic than neutral (${n.toFixed(2)})`);
  }

  // The error palette is fixed red regardless of the seed — a red error is not
  // a theming decision.
  for (const seed of ['#0B57D0', '#146C2E', '#FFDE3F']) {
    const errHue = hctFromHex(tonalPalettes(seed).error.tone(40)).hue;
    assert.ok(Math.abs(errHue - 25) < 2, `error hue was ${errHue.toFixed(2)} for seed ${seed}`);
  }
});

test('a palette exposes every tone in the M3 ladder', async () => {
  const { tonalPalettes, TONES } = await load();
  const all = tonalPalettes('#0B57D0').primary.all();

  assert.strictEqual(Object.keys(all).length, TONES.length);
  for (const tone of TONES) assert.match(all[tone], /^#[0-9a-f]{6}$/, `tone ${tone}`);
  assert.strictEqual(all[0], '#000000');
  assert.strictEqual(all[100], '#ffffff');
  // Cached lookups are stable, not recomputed into a slightly different answer.
  const pal = tonalPalettes('#0B57D0').primary;
  assert.strictEqual(pal.tone(40), pal.tone(40));
});

/* ================================================================== */
/* WCAG contrast                                                       */
/* ================================================================== */

test('contrastHex implements the WCAG ratio', async () => {
  const { contrastHex } = await load();

  assert.strictEqual(contrastHex('#000000', '#ffffff'), 21);
  assert.strictEqual(contrastHex('#ffffff', '#000000'), 21);   // symmetric
  assert.strictEqual(contrastHex('#123456', '#123456'), 1);
  // #767676 on white is the canonical "exactly AA" grey.
  const aaGrey = contrastHex('#767676', '#ffffff');
  assert.ok(aaGrey >= 4.5 && aaGrey < 4.6, `#767676 on white was ${aaGrey.toFixed(3)}`);
});

test('meetsAA uses 4.5 for body text and 3 for large text', async () => {
  const { meetsAA } = await load();
  assert.strictEqual(meetsAA('#767676', '#ffffff'), true);
  assert.strictEqual(meetsAA('#8a8a8a', '#ffffff'), false);
  assert.strictEqual(meetsAA('#8a8a8a', '#ffffff', true), true);   // large text
  assert.strictEqual(meetsAA('#bbbbbb', '#ffffff', true), false);
});

test('every generated scheme meets WCAG AA in light and in dark', async () => {
  const { buildScheme, contrastHex } = await load();

  for (const seed of SEEDS) {
    for (const dark of [false, true]) {
      const scheme = buildScheme(seed, dark, 0);
      for (const [fg, bg] of CONTRAST_PAIRS) {
        const ratio = contrastHex(scheme[fg], scheme[bg]);
        assert.ok(ratio >= 4.5,
          `${dark ? 'dark' : 'light'} seed ${seed}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1 `
          + `(${scheme[fg]} on ${scheme[bg]})`);
      }
    }
  }
});

test('body text on its surface clears WCAG AAA in both modes', async () => {
  const { buildScheme, contrastHex } = await load();

  for (const seed of SEEDS) {
    for (const dark of [false, true]) {
      const scheme = buildScheme(seed, dark, 0);
      const ratio = contrastHex(scheme.onSurface, scheme.surface);
      assert.ok(ratio >= 7,
        `${dark ? 'dark' : 'light'} seed ${seed}: onSurface/surface is only ${ratio.toFixed(2)}:1`);
    }
  }
});

test('raising the contrast setting raises real separation', async () => {
  const { buildScheme, contrastHex } = await load();

  for (const dark of [false, true]) {
    const measure = (level) => {
      const s = buildScheme('#0B57D0', dark, level);
      return {
        surface: contrastHex(s.onSurface, s.surface),
        variant: contrastHex(s.onSurfaceVariant, s.surfaceVariant),
        outline: contrastHex(s.outline, s.surface),
      };
    };
    const standard = measure(0);
    const medium = measure(0.5);
    const high = measure(1);

    for (const key of ['surface', 'variant', 'outline']) {
      assert.ok(medium[key] > standard[key],
        `${dark ? 'dark' : 'light'} ${key}: medium ${medium[key].toFixed(2)} did not beat standard ${standard[key].toFixed(2)}`);
      assert.ok(high[key] > medium[key],
        `${dark ? 'dark' : 'light'} ${key}: high ${high[key].toFixed(2)} did not beat medium ${medium[key].toFixed(2)}`);
    }
    // High contrast must not be cosmetic: outline is the role most likely to be
    // borderline at standard contrast.
    assert.ok(high.outline >= 6.5, `${dark ? 'dark' : 'light'} high-contrast outline was ${high.outline.toFixed(2)}`);
  }
});

/* ================================================================== */
/* the role map                                                        */
/* ================================================================== */

test('every M3 role resolves to a valid sRGB hex', async () => {
  const { buildScheme } = await load();
  const REQUIRED = [
    'primary', 'onPrimary', 'primaryContainer', 'onPrimaryContainer', 'inversePrimary',
    'secondary', 'onSecondary', 'secondaryContainer', 'onSecondaryContainer',
    'tertiary', 'onTertiary', 'tertiaryContainer', 'onTertiaryContainer',
    'error', 'onError', 'errorContainer', 'onErrorContainer',
    'background', 'onBackground', 'surface', 'onSurface',
    'surfaceVariant', 'onSurfaceVariant', 'outline', 'outlineVariant',
    'shadow', 'scrim', 'inverseSurface', 'inverseOnSurface',
    'surfaceDim', 'surfaceBright', 'surfaceContainerLowest', 'surfaceContainerLow',
    'surfaceContainer', 'surfaceContainerHigh', 'surfaceContainerHighest', 'surfaceTint',
  ];

  for (const dark of [false, true]) {
    const scheme = buildScheme('#0B57D0', dark, 0);
    for (const role of REQUIRED) {
      assert.match(String(scheme[role]), /^#[0-9a-f]{6}$/, `${role} in ${dark ? 'dark' : 'light'}`);
    }
    assert.strictEqual(Object.keys(scheme).length, REQUIRED.length,
      'the role map gained or lost a role; update this list and the token emitter together');
  }
});

test('light and dark are genuinely different schemes, not one palette re-labelled', async () => {
  const { buildScheme, hctFromHex } = await load();
  const light = buildScheme('#0B57D0', false, 0);
  const dark = buildScheme('#0B57D0', true, 0);

  assert.notStrictEqual(light.surface, dark.surface);
  assert.ok(hctFromHex(light.surface).tone > 80, 'light surface is not light');
  assert.ok(hctFromHex(dark.surface).tone < 20, 'dark surface is not dark');
  assert.ok(hctFromHex(light.onSurface).tone < 20, 'light onSurface is not dark');
  assert.ok(hctFromHex(dark.onSurface).tone > 80, 'dark onSurface is not light');
});

/* ================================================================== */
/* hex parsing and the font stack                                      */
/* ================================================================== */

test('rgbFromHex accepts the CSS spellings and rejects nonsense', async () => {
  const { rgbFromHex, hexFromRgb } = await load();

  assert.deepStrictEqual(rgbFromHex('#0B57D0'), [11, 87, 208]);
  assert.deepStrictEqual(rgbFromHex('0b57d0'), [11, 87, 208]);
  assert.deepStrictEqual(rgbFromHex('  #0B57D0  '), [11, 87, 208]);
  assert.deepStrictEqual(rgbFromHex('#abc'), [170, 187, 204]);      // shorthand expands
  assert.deepStrictEqual(rgbFromHex('#11223344'), [17, 34, 51]);    // hex8: alpha dropped
  assert.strictEqual(rgbFromHex('nope'), null);
  assert.strictEqual(rgbFromHex(''), null);
  assert.strictEqual(rgbFromHex(null), null);
  assert.strictEqual(rgbFromHex('#12345'), null);

  assert.strictEqual(hexFromRgb([11, 87, 208]), '#0b57d0');
  assert.strictEqual(hexFromRgb([-40, 300, 127.6]), '#00ff80');     // clamped and rounded
});

test('every font stack ends in a CJK-safe fallback and never reaches the network', async () => {
  const { fontStack } = await load();

  for (const family of ['system-ui', 'Segoe UI', 'My Custom Face', '', undefined]) {
    const stack = fontStack(family);
    assert.ok(/sans-serif$/.test(stack), `"${family}" produced "${stack}"`);
    assert.ok(/Noto Sans HK|Microsoft JhengHei/.test(stack),
      `"${family}" produced "${stack}" with no CJK fallback — bilingual mode would tofu`);
    // No CDN, ever: a stack is a list of family names, never a url() or import.
    assert.ok(!/url\(|@import|https?:/i.test(stack), `"${family}" produced a networked stack`);
  }

  // A family name containing a space is quoted so the stack stays parseable.
  assert.ok(fontStack('Segoe UI').startsWith("'Segoe UI'"));
  // A quote in the requested name cannot escape the quoting.
  assert.ok(!/''/.test(fontStack("Bad'Name Face")));
});
