# Funny levels

## What it does

Two independent sliders, 1 to 5, one per language:

- **English funny level** — `funnyLevel.en`
- **粵語 funny level** — `funnyLevel.yue`

Level 1 reads fully professional. Level 5 is maximum playfulness. They are
adjusted separately, so a user can have serious English beside playful
Cantonese, or the reverse.

Both are a **shipping requirement**: two controls, actually wired to rendered
copy, persisted across restarts, reachable from the settings surface. One shared
slider does not satisfy it; neither does a slider that changes nothing.

## What changes, and what does not

**Voice changes. Facts never do.**

The same event at level 1 and level 5:

| Level | English |
| --- | --- |
| 1 | `Target "report.pdf" already exists. Overwrite it?` |
| 5 | `Plot twist — "report.pdf" already lives there! Shall the newcomer dramatically shove it off the shelf?` |

| Level | 粵語 |
| --- | --- |
| 1 | `目標「report.pdf」已存在。要覆寫嗎？` |
| 5 | `劇情反轉——「report.pdf」原來一早住咗喺度！新嚟嗰位要唔要好有戲劇性咁推佢落架？` |

Both levels name the file, both state that it exists, both ask the same
question. The joke is around the facts, never instead of them.

## No category is exempt

The level applies to **every** category of message — including destructive,
financial, security, accessibility and error copy. There is no carve-out,
because the user is told what the setting affects before they opt in.

What is fixed at every level:

- What happened, or is about to happen.
- What will be affected — which file, which site, which account.
- Whether it is irreversible.
- What the options are.
- Every identifier: paths, hostnames, fingerprints, counts, error codes.

**A warning nobody can act on is a broken warning, not a funny one.**

## Disclosure

At first run and in the setting itself, the app states plainly that the funny
level styles **all** messages including errors and warnings, and that it can be
changed or reset at any time. `disclosureAccepted` records that this was shown.

The default is **3** in both languages — a middle setting this audience would
expect. Defaulting to maximum playfulness assumes something about the user that
has not been established.

## Configuration

| Option | Default | Meaning |
| --- | --- | --- |
| `funnyLevel.en` | `3` | 1–5. |
| `funnyLevel.yue` | `3` | 1–5, independent. |
| `disclosureAccepted` | `false` | Whether the disclosure was shown. |

Both sliders are in **Preferences → Interface → Language**, with a live preview
showing a real message at the chosen level in the chosen language — so the effect
is visible before it is committed.

## Failure modes

| Situation | What the user sees | Recoverable |
| --- | --- | --- |
| A key has no variant at the chosen level | Falls back to the nearest defined level. Never a raw key, never an empty string. | Yes |
| A level-5 variant loses a parameter | Caught by a dictionary test over every key and level. It cannot ship. | n/a |
| A level-5 variant is much longer | Layout is validated at the longest variant of every key, which is usually level 5 in bilingual mode. | n/a |
| Level changed mid-session | Applied live, including to open dialogs and to the notification centre's stored messages, which re-render at the new level. | n/a |
| A screen reader at level 5 | Reads the playful text. The accessible name still contains the identifiers, because they are in the string rather than added alongside it. | n/a |

## Security considerations

- **A security prompt at level 5 is still a security prompt.** Host key changes,
  destructive confirmations and permission errors keep every fact, every
  fingerprint and every count. Dictionary tests assert this specifically for
  security-relevant keys.
- **Humour never softens a failure into ambiguity.** "Something went a bit wonky"
  is not an acceptable level-5 rendering of an authentication failure; the level-5
  variant still says the authentication failed and how.
- **Cantonese humour stays respectful** — never mocking the user, their data
  loss, their money or their disability.
- **The disclosure is honest and up front**, so the absence of category
  exemptions is a choice the user made rather than a surprise they discovered.

## Verification

- Every levelled key is asserted to have five variants per language with
  identical parameter sets.
- Security-relevant keys are asserted, at every level in both languages, to
  contain their parameters and their required facts.
- Live application is tested by moving each slider and asserting rendered copy
  changes — **at every level**, in both languages, independently.
- Persistence across restart is tested for both sliders separately.
- Layout is validated at the longest variant of every key.
- The disclosure is asserted to appear before the setting can be changed on a
  fresh profile.

## Suggested articles

- [Language modes](language-modes.md) — the dictionary these levels index into.
- [The narrator](narrator.md) — which follows the same levels when speaking.
- [Notifications](../interface-and-appearance/notifications.md) — where most levelled copy appears.
- [The changelog viewer](../packaging-and-updates/changelog.md) — which is levelled too, including security fixes.
