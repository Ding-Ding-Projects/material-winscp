# File masks

## What it does

`design/main/masks.js` implements WinSCP's file mask language. A mask decides
which files an operation applies to, and it is used in more places than anywhere
else in the application: transfer include/exclude, synchronization filtering,
panel filtering, editor association, custom-command applicability, transfer
preset auto-selection, file colouring and search.

Getting it exactly right matters, because the same syntax means the same thing
everywhere — and because a mask that excludes a file also excludes it from
deletion during a synchronize, which people rely on for safety.

## The language

### Wildcards

| Pattern | Matches |
| --- | --- |
| `*` | Any sequence, including empty. Does not cross a `/`. |
| `?` | Exactly one character. |
| `[abc]`, `[a-z]` | One character from a set or range. |
| `[!abc]` | One character *not* in the set. |

### Structure

- Masks are separated by `;` or a comma. `*.txt; *.md` matches either.
- A mask beginning with `-` **excludes**. `*.log; -debug.log` matches every log
  except that one.
- A mask ending in `/` applies to **directories only**. `node_modules/` excludes
  the directory rather than a file with that name.
- A mask containing `/` is matched against the **path** relative to the operation
  root; one without is matched against the **filename** alone.
- Matching is case-insensitive, matching Windows expectations. This is a
  deliberate choice, not an oversight, and it means a mask behaves the same for a
  local and a remote panel.

### Size and time filters

Beyond names:

| Form | Meaning |
| --- | --- |
| `>1M`, `<100K` | Size greater or less than. Suffixes `K`, `M`, `G`. |
| `>=2024-01-01` | Modified on or after a date. |
| `<7D`, `>2H` | Relative time: within the last 7 days, older than 2 hours. Units `S`, `N` (minutes), `H`, `D`, `Y`. |

These combine with name masks: `*.log; >10M; <30D` — log files over 10 MB
modified in the last 30 days.

## Configuration

Masks are not a setting of their own; they appear as fields throughout the app.
Every mask field offers the **mask editor**, which explains each part of the
mask as you type and previews what it would match against the current directory.

Masks and regular expressions are related but not the same. Any mask can be
converted to an equivalent regex, and the mask editor shows that conversion —
which is also how a mask field hands over to the
[regex builder](../search-and-regex/regex-builder.md) when a user needs more
power than the mask language has.

## Failure modes

| Situation | What the user sees | Recoverable |
| --- | --- | --- |
| Unclosed `[` | Reported inline with the position, and the mask does not apply. It is not silently treated as a literal. | Yes |
| A mask matching nothing | Not an error. The preview shows zero matches, so the mistake is visible before the operation runs. | Yes |
| Only exclusions (`-*.tmp`) | An include of everything is implied. The editor states this, because it surprises people. | n/a |
| Case expectation from a POSIX background | Matching is case-insensitive. The editor says so; there is no case-sensitive mode, because two behaviours would be worse than one documented one. | n/a |
| `*` expected to cross directories | It does not. Use a path mask or a leading `**/`-style path form. The editor's explanation says which. | Yes |
| A relative time mask on a server with clock skew | Uses the same time correction as synchronization. Without it, filters can select the wrong files. | Yes |
| Very long mask lists | Compiled once and cached; matching stays linear in the number of masks. | n/a |

## Security considerations

- **Masks are a safety mechanism, not just a filter.** In a
  [synchronize with delete](../synchronization/synchronize.md), an excluded file
  is also protected from deletion. That property must hold exactly, which is why
  mask evaluation is one of the most heavily tested pieces of the codebase.
- **A mask that fails to parse must not silently match everything.** It applies
  nothing and reports the error — failing open here would delete files the user
  believed were excluded.
- **Masks are user input compiled into a matcher.** Compilation is bounded so a
  pathological mask cannot become a denial of service, and mask-to-regex
  conversion produces a pattern free of catastrophic backtracking rather than a
  naive translation.
- **Excluding secrets is a documented use** — `.env`, `*.pem`, `id_*`, `.git/` —
  and the [keep-up-to-date](../synchronization/keep-up-to-date.md) start dialog
  suggests them.

## Verification

- `test/masks.test.js` covers wildcards, character classes, negated classes,
  directory-only masks, path versus filename matching, exclusion precedence,
  case-insensitivity, size filters, absolute and relative time filters, and
  malformed masks.
- Mask-to-regex conversion is tested for equivalence over a filename corpus and
  for the absence of catastrophic backtracking on adversarial input.
- The exclusion-protects-from-deletion property is tested from the
  synchronization side as well, because that is where it matters.

## Suggested articles

- [Transfer settings](../transfers-and-queue/transfer-settings.md) — `includeFileMask` and `asciiFileMask`.
- [Synchronize](../synchronization/synchronize.md) — where exclusion becomes a safety property.
- [The regex builder](../search-and-regex/regex-builder.md) — where a mask hands over.
- [Custom commands](custom-commands.md) — masks decide which commands apply to a file.
