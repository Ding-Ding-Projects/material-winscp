// i18n.test.js — three language modes, two funny-level sliders, one rule.
//
// The rule the whole language system stands on is "the level changes VOICE,
// never FACTS". It is easy to state and easy to break: a rewrite at level 5
// that drops "{1}" from a delete confirmation still reads beautifully and
// silently stops telling the user which files are about to be destroyed.
//
// So the central test here substitutes a byte-distinct sentinel for every
// parameter of every leveled entry and asserts the sentinel survives — same
// bytes, same number of times — at all five levels, in both languages. If a
// future rewrite loses a parameter, mangles it, or reorders it away, this file
// fails before a screenshot ever would.
//
// design/renderer/i18n.js resolves and formats without touching the DOM (only
// bindText/bilingualNode do), so the whole resolution path runs headlessly.
'use strict';
const test = require('node:test');
const assert = require('node:assert');

let mods = null;
async function load() {
  if (!mods) {
    const dict = await import('../design/winscp-i18n.js');
    const i18n = await import('../design/renderer/i18n.js');
    const state = await import('../design/renderer/state.js');
    state.setPersistenceEnabled(false);          // no config writes from a test
    mods = { dict, i18n, state };
  }
  return mods;
}

const LEVELS = [1, 2, 3, 4, 5];

/**
 * Sentinels for parameter slots. Each is byte-distinct, none is a substring of
 * another, and each mixes scripts, punctuation and digits so a level that
 * lower-cases, transliterates or truncates a parameter is caught too.
 */
const SENTINEL = [
  'A7Ω-srv-01.example.com',
  'B9Δ-«Q1 報表 v2».tar.gz',
  'C3Ξ-42949672960',
  'D5Ψ-/var/log/α β',
];

/** The placeholder indices a template actually uses, in ascending order. */
function placeholders(str) {
  return [...String(str).matchAll(/\{(\d+)\}/g)].map((m) => Number(m[1])).sort((a, b) => a - b);
}

function countOf(haystack, needle) {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) { n += 1; i = haystack.indexOf(needle, i + needle.length); }
  return n;
}

const isLeveled = (entry) => Array.isArray(entry[0]);

/**
 * `tips` is stored in the leveled shape but is a six-item tips carousel, not a
 * five-step slider. It is the one documented exception to the 5-level rule and
 * is asserted separately.
 */
const TIPS_KEY = 'tips';

/** Keys whose Cantonese is legitimately identical to the English. */
const SHARED_LITERAL_KEYS = ['appName', 'urlTab', 'pCommander', 'pExplorer', 'cpHex'];

/** Put the language system in a known state and run `fn`. */
async function withLanguage(language, enLevel, yueLevel, fn) {
  const { i18n } = await load();
  i18n.setLanguage(language);
  i18n.setFunnyLevel('en', enLevel);
  i18n.setFunnyLevel('yue', yueLevel);
  return fn(i18n);
}

test.afterEach(async () => {
  const { i18n } = await load();
  i18n.setLanguage('en');
  i18n.setFunnyLevel('en', 3);
  i18n.setFunnyLevel('yue', 3);
});

/* ================================================================== */
/* dictionary shape                                                    */
/* ================================================================== */

test('every key carries a Cantonese counterpart', async () => {
  const { dict } = await load();
  const keys = Object.keys(dict.I18N);

  assert.ok(keys.length > 600, `only ${keys.length} keys in the dictionary`);

  for (const key of keys) {
    const entry = dict.I18N[key];
    assert.ok(Array.isArray(entry) && entry.length === 2,
      `${key} is not an [english, cantonese] pair`);

    const [en, yue] = entry;
    const enList = Array.isArray(en) ? en : [en];
    const yueList = Array.isArray(yue) ? yue : [yue];

    assert.strictEqual(Array.isArray(en), Array.isArray(yue),
      `${key}: one language is leveled and the other is not`);
    assert.strictEqual(enList.length, yueList.length,
      `${key}: ${enList.length} English variants against ${yueList.length} Cantonese`);

    for (const [i, value] of yueList.entries()) {
      assert.strictEqual(typeof value, 'string', `${key}[${i}] Cantonese is not a string`);
      assert.ok(value.trim().length > 0, `${key}[${i}] has an empty Cantonese counterpart`);
    }
    for (const [i, value] of enList.entries()) {
      assert.strictEqual(typeof value, 'string', `${key}[${i}] English is not a string`);
      assert.ok(value.trim().length > 0, `${key}[${i}] has an empty English string`);
    }
  }
});

test('the Cantonese is a translation, not a copy of the English', async () => {
  const { dict } = await load();
  const copies = [];

  for (const [key, entry] of Object.entries(dict.I18N)) {
    if (isLeveled(entry)) {
      entry[0].forEach((en, i) => { if (en === entry[1][i]) copies.push(`${key}[${i}]`); });
    } else if (entry[0] === entry[1]) {
      copies.push(key);
    }
  }

  // Product names and three-letter acronyms are the same in both languages;
  // anything else in this list is an untranslated string.
  assert.deepStrictEqual(copies.sort(), [...SHARED_LITERAL_KEYS].sort(),
    'a key is rendering English text as its Cantonese');
});

test('a leveled entry has exactly five levels per language', async () => {
  const { dict } = await load();
  const leveled = Object.keys(dict.I18N).filter((k) => isLeveled(dict.I18N[k]));

  assert.ok(leveled.length >= 20, `only ${leveled.length} leveled entries`);

  for (const key of leveled) {
    if (key === TIPS_KEY) continue;
    assert.strictEqual(dict.I18N[key][0].length, 5, `${key}: English is not a 5-level entry`);
    assert.strictEqual(dict.I18N[key][1].length, 5, `${key}: Cantonese is not a 5-level entry`);
  }

  // The documented exception: a tips carousel stored in the leveled shape.
  assert.strictEqual(dict.I18N[TIPS_KEY][0].length, 6);
  assert.strictEqual(dict.I18N[TIPS_KEY][1].length, 6);
});

/* ================================================================== */
/* THE rule: voice changes, facts do not                               */
/* ================================================================== */

test('every level of every leveled entry uses the same parameters', async () => {
  const { dict } = await load();

  for (const [key, entry] of Object.entries(dict.I18N)) {
    if (!isLeveled(entry)) continue;
    for (const [langIndex, langName] of [[0, 'English'], [1, 'Cantonese']]) {
      const sets = entry[langIndex].map((s) => placeholders(s).join(','));
      const unique = new Set(sets);
      assert.strictEqual(unique.size, 1,
        `${key} (${langName}): parameter set differs between levels — ${[...unique].map((s) => `"${s}"`).join(' vs ')}`);
    }
    // A Cantonese rewrite that drops a parameter the English keeps is the same
    // defect seen from the other side.
    assert.strictEqual(placeholders(entry[0][0]).join(','), placeholders(entry[1][0]).join(','),
      `${key}: English and Cantonese take different parameters`);
  }
});

test('substituted facts are byte-identical at every funny level', async () => {
  const { dict, i18n } = await load();
  const leveled = Object.entries(dict.I18N).filter(([, e]) => isLeveled(e));
  let assertions = 0;
  let covered = 0;

  for (const [key, entry] of leveled) {
    const indices = placeholders(entry[0][0]);
    if (!indices.length) continue;                      // nothing to substitute
    covered += 1;
    const params = [];
    for (const i of indices) params[i] = SENTINEL[i % SENTINEL.length];

    for (const language of ['en', 'yue']) {
      const counts = new Map(indices.map((i) => [i, null]));

      for (const level of LEVELS) {
        i18n.setLanguage(language);
        i18n.setFunnyLevel('en', level);
        i18n.setFunnyLevel('yue', level);
        const rendered = i18n.t(key, ...params);

        assert.ok(!/\{\d+\}/.test(rendered),
          `${key} (${language}, level ${level}): an unsubstituted placeholder survived — "${rendered}"`);

        for (const i of indices) {
          const sentinel = params[i];
          const n = countOf(rendered, sentinel);
          assert.ok(n >= 1,
            `${key} (${language}, level ${level}): parameter {${i}} is missing from "${rendered}"`);
          const seen = counts.get(i);
          if (seen === null) counts.set(i, n);
          else assert.strictEqual(n, seen,
            `${key} (${language}): parameter {${i}} appears ${n} times at level ${level} but ${seen} times at level 1 — the level changed a fact`);
          assertions += 1;
        }
      }
    }
  }

  // 11 leveled entries carry parameters today: 13 slots x 5 levels x 2
  // languages. The floor guards against the loop silently skipping everything.
  assert.ok(covered >= 10, `only ${covered} leveled entries carry parameters`);
  assert.ok(assertions >= 100, `only ${assertions} fact assertions ran`);
});

test('the voice really does change between level 1 and level 5', async () => {
  const { dict, i18n } = await load();

  for (const [key, entry] of Object.entries(dict.I18N)) {
    if (!isLeveled(entry) || key === TIPS_KEY) continue;
    for (const language of ['en', 'yue']) {
      i18n.setLanguage(language);
      i18n.setFunnyLevel(language, 1);
      const serious = i18n.t(key);
      i18n.setFunnyLevel(language, 5);
      const playful = i18n.t(key);

      assert.notStrictEqual(serious, playful,
        `${key} (${language}): level 1 and level 5 are the same string, so the slider does nothing here`);
      assert.ok(new Set(entry[language === 'en' ? 0 : 1]).size >= 3,
        `${key} (${language}): fewer than three distinct voices across five levels`);
    }
  }
});

test('a plain entry is identical at every level', async () => {
  const { dict, i18n } = await load();
  const plain = Object.keys(dict.I18N).filter((k) => !isLeveled(dict.I18N[k]));

  for (const language of ['en', 'yue']) {
    i18n.setLanguage(language);
    for (const key of plain) {
      i18n.setFunnyLevel(language, 1);
      const atOne = i18n.t(key);
      for (const level of [2, 3, 4, 5]) {
        i18n.setFunnyLevel(language, level);
        assert.strictEqual(i18n.t(key), atOne,
          `${key} (${language}) changed at level ${level} but has no leveled copy`);
      }
    }
  }
});

test('the two sliders are independent', async () => {
  const { i18n } = await load();
  const host = SENTINEL[0];

  const seriousEnPlayfulYue = await withLanguage('both', 1, 5, (m) => m.t('connEstablished', host));
  const playfulEnSeriousYue = await withLanguage('both', 5, 1, (m) => m.t('connEstablished', host));
  const enOnlySerious = await withLanguage('en', 1, 5, (m) => m.t('connEstablished', host));
  const enOnlyPlayful = await withLanguage('en', 5, 1, (m) => m.t('connEstablished', host));
  const yueOnlySerious = await withLanguage('yue', 5, 1, (m) => m.t('connEstablished', host));
  const yueOnlyPlayful = await withLanguage('yue', 1, 5, (m) => m.t('connEstablished', host));

  // Bilingual mode joins the two halves with a middle dot.
  assert.ok(seriousEnPlayfulYue.startsWith(enOnlySerious),
    'the English half of bilingual mode did not follow the English slider');
  assert.ok(seriousEnPlayfulYue.endsWith(yueOnlyPlayful),
    'the Cantonese half of bilingual mode did not follow the Cantonese slider');
  assert.ok(playfulEnSeriousYue.startsWith(enOnlyPlayful));
  assert.ok(playfulEnSeriousYue.endsWith(yueOnlySerious));

  assert.notStrictEqual(seriousEnPlayfulYue, playfulEnSeriousYue);
  // The fact survives every combination.
  for (const s of [seriousEnPlayfulYue, playfulEnSeriousYue, enOnlySerious, enOnlyPlayful, yueOnlySerious, yueOnlyPlayful]) {
    assert.ok(s.includes(host), `the host name vanished from "${s}"`);
  }
  assert.strictEqual(countOf(seriousEnPlayfulYue, host), 2, 'bilingual mode should state the host in each half');

  i18n.setLanguage('en');
});

/* ================================================================== */
/* language modes                                                      */
/* ================================================================== */

test('each language mode renders the language it names', async () => {
  const { i18n } = await load();
  const hasHan = (s) => /[㐀-鿿]/.test(s);

  const en = await withLanguage('en', 3, 3, (m) => m.t('deleteTitle'));
  const yue = await withLanguage('yue', 3, 3, (m) => m.t('deleteTitle'));
  const both = await withLanguage('both', 3, 3, (m) => m.t('deleteTitle'));

  assert.strictEqual(en, 'Confirm deletion');
  assert.ok(hasHan(yue) && !/[A-Za-z]/.test(yue), `Cantonese mode returned "${yue}"`);
  assert.strictEqual(both, `${en} · ${yue}`);
  assert.ok(both.includes(en) && both.includes(yue));

  // When the two languages agree there is nothing to join.
  assert.strictEqual(await withLanguage('both', 3, 3, (m) => m.t('appName')), 'WinSCP Material');

  // An unknown mode is ignored rather than blanking the interface.
  i18n.setLanguage('klingon');
  assert.strictEqual(i18n.getLanguage(), 'both');
  i18n.setLanguage('en');
  assert.deepStrictEqual(i18n.LANG_MODES, ['en', 'yue', 'both']);
});

test('tPair and tIn ignore the active mode', async () => {
  const { i18n } = await load();
  await withLanguage('en', 1, 5, () => {});

  const pair = i18n.tPair('transferDone', 12, '/srv/www');
  assert.ok(pair.en.includes('12') && pair.en.includes('/srv/www'));
  assert.ok(pair.yue.includes('12') && pair.yue.includes('/srv/www'));
  assert.ok(/[㐀-鿿]/.test(pair.yue));
  assert.ok(!/[㐀-鿿]/.test(pair.en));
  // Each half still obeys its own slider, even though the mode is English-only.
  assert.strictEqual(pair.en, i18n.tIn('en', 'transferDone', 12, '/srv/www'));
  assert.strictEqual(pair.yue, i18n.tIn('yue', 'transferDone', 12, '/srv/www'));

  assert.strictEqual(i18n.tPair('__missing__').en, '__missing__');
  assert.strictEqual(i18n.tPair('__missing__').yue, '__missing__');
});

test('every key renders non-empty in every mode at every level', async () => {
  const { dict, i18n } = await load();
  const keys = Object.keys(dict.I18N);

  for (const language of ['en', 'yue', 'both']) {
    for (const level of LEVELS) {
      await withLanguage(language, level, level, () => {});
      for (const key of keys) {
        const value = i18n.t(key);
        assert.strictEqual(typeof value, 'string', `${key} (${language}/${level}) is not a string`);
        assert.ok(value.length > 0, `${key} (${language}/${level}) rendered empty`);
      }
    }
  }
});

/* ================================================================== */
/* slider mechanics                                                    */
/* ================================================================== */

test('funny levels clamp to 1..5 and fall back to 3', async () => {
  const { i18n, state } = await load();

  for (const [input, expected] of [[1, 1], [5, 5], [0, 1], [-9, 1], [6, 5], [999, 5], [3.4, 3], [3.6, 4]]) {
    i18n.setFunnyLevel('en', input);
    assert.strictEqual(i18n.getFunnyLevel('en'), expected, `level ${input}`);
  }

  // A corrupt stored value must not blank the interface.
  state.store.set('funnyLevel.en', 'not a number');
  assert.strictEqual(i18n.getFunnyLevel('en'), 3);
  assert.ok(i18n.t('deleteTitle').length > 0);

  // Only the two real languages have sliders.
  i18n.setFunnyLevel('klingon', 5);
  assert.strictEqual(i18n.getFunnyLevel('klingon'), 3);   // reads as the English slider

  i18n.setFunnyLevel('en', 3);
  assert.strictEqual(i18n.FUNNY_LABELS.en.length, 5);
  assert.strictEqual(i18n.FUNNY_LABELS.yue.length, 5);
});

test('cycleLanguage visits all three modes and returns', async () => {
  const { i18n } = await load();
  i18n.setLanguage('en');
  const seen = [i18n.getLanguage()];
  for (let i = 0; i < 3; i += 1) { i18n.cycleLanguage(); seen.push(i18n.getLanguage()); }
  assert.deepStrictEqual(seen, ['en', 'yue', 'both', 'en']);
});

/* ================================================================== */
/* parameter substitution                                              */
/* ================================================================== */

test('parameter substitution is literal and never blanks a template', async () => {
  const { i18n } = await load();
  await withLanguage('en', 1, 1, () => {});

  // A missing parameter leaves its placeholder visible rather than rendering a
  // sentence with a hole in it.
  assert.strictEqual(i18n.t('renamedMsg'), 'Renamed "{0}" to "{1}".');
  assert.strictEqual(i18n.t('renamedMsg', 'a.txt'), 'Renamed "a.txt" to "{1}".');

  // Zero is a value, not an absence.
  assert.strictEqual(i18n.t('findResults', 0), '0 file(s) found.');
  assert.strictEqual(i18n.t('hiddenCount', 0), '0 hidden');

  // Replacement patterns inside a parameter are inserted verbatim: a file
  // called "$& $1 $$" must not be re-expanded by the substitution itself.
  const nasty = '$& $1 $$ {0}';
  assert.strictEqual(i18n.t('createdMsg', nasty), `Created "${nasty}".`);

  // An unknown key renders as the key, so a gap is visible in a screenshot.
  assert.strictEqual(i18n.t('__no_such_key__'), '__no_such_key__');
  assert.strictEqual(i18n.has('__no_such_key__'), false);
  assert.strictEqual(i18n.has('deleteTitle'), true);
  assert.ok(i18n.keys().includes('deleteTitle'));
});

test('a byte-count, a host name and a path survive every mode and level', async () => {
  const { i18n } = await load();
  const cases = [
    ['statusOf', ['1073741824', '4294967296', '17', '2048']],
    ['connEstablished', ['sftp.中文-host.example.com']],
    ['transferDone', ['9', '/srv/www/été 2026/報表']],
    ['deleteBody', ['3', 'a.txt, b.txt, секрет.key']],
  ];

  for (const [key, params] of cases) {
    for (const language of ['en', 'yue', 'both']) {
      for (const level of LEVELS) {
        await withLanguage(language, level, level, () => {});
        const rendered = i18n.t(key, ...params);
        for (const param of params) {
          assert.ok(rendered.includes(param),
            `${key} (${language}/${level}) lost "${param}" — got "${rendered}"`);
        }
      }
    }
  }
});

/* ================================================================== */
/* the disclosure                                                      */
/* ================================================================== */

test('the disclosure states that the level touches errors and warnings', async () => {
  const { i18n } = await load();

  const en = await withLanguage('en', 3, 3, (m) => m.disclosureText());
  assert.match(en, /error/i);
  assert.match(en, /warning/i);
  assert.match(en, /never changes|facts?/i);
  assert.match(en, /reset|change/i);

  const yue = await withLanguage('yue', 3, 3, (m) => m.disclosureText());
  assert.ok(yue.includes('錯誤'), 'the Cantonese disclosure does not mention errors');
  assert.ok(yue.includes('警告'), 'the Cantonese disclosure does not mention warnings');

  const both = await withLanguage('both', 3, 3, (m) => m.disclosureText());
  assert.ok(both.includes(en) && both.includes(yue));

  // The in-app copy of the same promise.
  const key = await withLanguage('en', 3, 3, (m) => m.t('funnyDisclose'));
  assert.match(key, /error/i);
  assert.match(key, /warning/i);

  i18n.setLanguage('en');
});

test('languageSummary names the mode and both levels', async () => {
  const { i18n } = await load();
  const summary = await withLanguage('both', 2, 4, (m) => m.languageSummary());
  assert.match(summary, /Bilingual/);
  assert.match(summary, /2\/5/);
  assert.match(summary, /4\/5/);
});
