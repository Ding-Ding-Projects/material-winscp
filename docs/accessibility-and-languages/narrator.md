# The spoken narrator

## What it does

Optionally speaks app events aloud — a transfer finished, a connection dropped,
the queue drained. It is **off by default** and is enabled only by the user.

## Configuration

Under **Preferences → Interface → Narrator**, stored in `PREF_DEFAULTS.narrator`.

| Option | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Off until the user turns it on. |
| `language` | `en` | `en`, `yue`, or `both`. |
| `voiceEn`, `voiceYue` | `''` | Selected platform voices. A Hong Kong Cantonese voice is used for the Cantonese track. |
| `rate`, `pitch`, `volume` | `1`, `1`, `0.9` | |
| `cooldownMs` | `8000` | Minimum gap between utterances in a category. |
| `categories` | transfer, error, connection, queue — all on | Per-category enable. |

With `language: both`, English is spoken **then** Cantonese, strictly
serialized — never overlapping, never interleaved.

## Behaviour

- **One utterance at a time**, through a serialized queue. Nothing overlaps.
- **A superseded queued line is replaced, not stacked.** Ten transfers finishing
  in a second produce one summary, not ten announcements four minutes long.
- **Debounced, plus a per-category cooldown**, so narration stays infrequent.
- **Tone follows the [funny level](funny-levels.md)** for the language being
  spoken, in every category including errors.
- **Content is fixed regardless of tone.** A spoken error still names the actual
  failure and what to do about it.
- **Error narration is never suppressed by the rate limits.** Debouncing may
  merge several errors into one utterance; it never drops the last one.

## Coexisting with assistive technology

- **Yields to or ducks under an active screen reader.** Two synthetic voices
  talking over each other is worse than either alone.
- Respects the app's reduced-sound and quiet-hours settings where they exist, and
  the OS's do-not-disturb state.
- Narration is **additional** to the visual notification, never a replacement.
  Everything spoken is also on screen and in the notification centre.

## Failure modes

| Situation | What the user sees or hears | Recoverable |
| --- | --- | --- |
| No Cantonese voice installed | The setting says so and offers the English track alone. It does not read Cantonese text with an English voice, which is unintelligible. | Yes |
| A voice is uninstalled while selected | Falls back to the platform default and says which voice is in use. | Yes |
| A burst of events | Debounced and merged into one summary utterance with a count. | n/a |
| A screen reader starts mid-utterance | The narrator finishes the current line and yields for subsequent ones. | n/a |
| Speech synthesis unavailable | The narrator disables itself with a one-time notification. It never fails an operation. | Yes |
| `both` with a very long message | Spoken sequentially; the queue prevents overlap even for long lines. A newer superseding message replaces the pending one. | n/a |
| An error during a quiet period | Still spoken — errors are exempt from suppression, though not from merging. | n/a |

## Security considerations

- **The narrator never speaks a credential.** Fields marked as secret are
  excluded from narration entirely, including in error messages that would
  otherwise quote a value.
- **Speech is audible to everyone in the room.** Hostnames, site names and file
  paths spoken aloud are a disclosure in an open office; the setting says so, and
  the per-category controls exist so a user can narrate only what they are
  comfortable being overheard.
- **Off by default**, and never enabled by an import, a preset or an update.
- **Nothing is sent anywhere.** Platform text-to-speech or bundled pre-generated
  narration assets — no cloud synthesis, no network request.

## Verification

- Serialization is tested with overlapping requests, asserting one utterance at
  a time and correct English-then-Cantonese ordering in `both`.
- Supersession is tested by queueing a newer message and asserting the older one
  is replaced rather than spoken.
- Cooldown and debouncing are tested per category, and error exemption from
  suppression is tested explicitly.
- Funny-level application is tested per language for spoken text.
- Screen-reader yielding is tested against a simulated active reader.
- Secret exclusion is tested by driving an error containing a credential and
  asserting it is not in the spoken string.
- Missing-voice fallback is tested for both languages.

## Suggested articles

- [Funny levels](funny-levels.md) — the tone the narrator follows.
- [Language modes](language-modes.md) — the dictionary it speaks from.
- [Accessibility](accessibility.md) — coexisting with assistive technology.
- [Notifications](../interface-and-appearance/notifications.md) — the visual half, which narration never replaces.
