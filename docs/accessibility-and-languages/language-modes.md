# Language modes

## What it does

Three modes, persisted and switchable at runtime:

| Mode | `language` | Behaviour |
| --- | --- | --- |
| English | `en` | English only. |
| 粵語 | `yue` | Playful Hong Kong Cantonese only. |
| Bilingual | `both` | Both, without crowding the interface. |

## The dictionary

`design/winscp-i18n.js` holds every string. Two shapes:

```js
// Plain: the same voice at every funny level.
ok: ['OK', '好'],

// Levelled: five English variants, five Cantonese variants.
connecting: [[
  'Connecting to {0}…', 'Connecting to {0}…', 'Dialling {0} now…',
  'Ringing up {0} — hold tight…', 'Summoning {0} from the digital mists…'],[
  '連緊去 {0}…', '連緊去 {0}…', '撥緊號去 {0}…',
  'Call 緊 {0}——揸穩扶手…', '施法緊，喺數碼雲霧召喚 {0}…']],
```

`{0}`, `{1}` are parameters. **They are identical across every level and both
languages**, because a level that drops a parameter drops a fact.

Localization resources stay separate from logic: no module builds a
user-facing string by concatenation, so no string is unreachable from the
dictionary.

## Bilingual layout

Showing two languages must not double the interface's size:

- The **primary label stays prominent**; the secondary is compact, in a smaller
  type scale with reduced emphasis.
- Where space is genuinely tight, **progressive disclosure** — the secondary
  appears in the tooltip and the accessible description rather than being
  dropped.
- Which language is primary follows the user's choice, so a Cantonese-first
  reader is not given English as the loud one.
- **Bilingual mode is the worst case for layout** — longest strings, tallest
  labels — and every surface is validated in it at narrow widths and at
  100/125/150/200% display scale.

## Fallback

- A key missing in one language falls back to the other and logs the gap at
  debug level; it never renders a raw key.
- A missing funny level falls back to the nearest defined one.
- A Latin-only font falls back through a CJK-safe chain — see
  [Material Design 3](../interface-and-appearance/material-3.md).

## Configuration

| Option | Default | Meaning |
| --- | --- | --- |
| `language` | `en` | `en`, `yue`, `both`. |
| `funnyLevel.en`, `funnyLevel.yue` | `3`, `3` | See [funny levels](funny-levels.md). |
| `disclosureAccepted` | `false` | Whether the first-run disclosure has been shown. |

Non-UI libraries and infrastructure are exempt until they expose a user-facing
surface — an adapter's internal error code is not a translated string; the
message the user reads about it is.

## Failure modes

| Situation | What the user sees | Recoverable |
| --- | --- | --- |
| Missing key in the selected language | The other language, logged at debug level. Never a raw key. | Yes |
| Parameter count mismatch between variants | Caught by a test over the whole dictionary, so it cannot ship. | n/a |
| Very long bilingual string in a narrow control | Truncated with the full text in the tooltip and the accessible name, never clipped. | n/a |
| CJK font unavailable | The fallback chain renders it; the font picker marks CJK coverage. | Yes |
| Language changed mid-session | Applied live to every rendered surface, including open dialogs. | n/a |
| A screen reader in bilingual mode | The accessible name is the primary language; the secondary is the accessible description. Both are read, not merged into one confusing run-on. | n/a |

## Security considerations

- **A translation must not weaken a warning.** Destructive confirmations, error
  messages and security prompts carry the same facts in both languages — the file
  count, the irreversibility, the fingerprint. Dictionary tests assert every
  parameter survives every variant.
- **Cantonese copy stays respectful.** It never mocks the user, their data loss,
  their money or their disability.
- **Identifiers stay exact in both languages** — hostnames, fingerprints, file
  paths, version numbers and error codes are not translated, transliterated or
  reflowed.

## Verification

- Every key is asserted present in both languages, with matching parameter sets
  across all variants.
- Every levelled key is asserted to have exactly five variants per language.
- Layout is validated for the longest string per key, in all three modes, at
  every display scale and density.
- Live switching is tested with dialogs open.
- Screen-reader naming in bilingual mode is tested for name/description
  assignment.
- Security-relevant strings are asserted to retain their parameters at every
  level in both languages.

## Suggested articles

- [Funny levels](funny-levels.md) — the sliders that pick a variant.
- [Accessibility](accessibility.md) — naming, focus and announcement rules.
- [The narrator](narrator.md) — the spoken counterpart.
- [Material Design 3](../interface-and-appearance/material-3.md) — CJK-safe fonts.
