# Case-colliding names

Synchronization compares names case-insensitively by default, matching the
usual Windows directory view. Two entries on the same side that differ only in
case — for example `Readme.txt` and `README.txt` — cannot be represented
unambiguously by that comparison. The engine now refuses the comparison with a
clear error instead of silently replacing one entry in its checklist.

## Behaviour

- The error identifies the directory and both colliding names.
- No transfer or deletion is queued when the comparison is refused.
- Enable **Case-sensitive comparison** only when the two names are intentional
  and the target protocol/filesystem can preserve that distinction.
- Renaming one entry to a distinct name is the safest cross-platform fix.

## Failure mode and safety

This is a safety boundary, not a transfer failure: the engine cannot know which
same-key entry should win. A case-sensitive retry may produce two actions, but
it can still fail later if the target cannot store both names.

## Verification

`test/sync.test.js` verifies both the fail-closed default and the explicit
case-sensitive escape hatch. The comparison does not mutate either adapter
before returning its error.

- [Comparison checklist](comparison-checklist.md)
- [Synchronize](synchronize.md)
- [Keep up to date](keep-up-to-date.md)
