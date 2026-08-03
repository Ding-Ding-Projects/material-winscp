# Porting mandate

> This is a standing, non-negotiable instruction for this repository, recorded
> here so it survives any session, any agent, and any handoff. Read it before
> deciding that something is "enough".

## The mandate

**Port 100% of WinSCP. Every feature. However many lines it takes.**

Not a subset. Not the common paths. Not "the parts a typical user touches."
If WinSCP does it, this application does it — and it actually works, not a
dialog that renders and does nothing.

Scale is explicitly not an excuse. WinSCP's own source is ~316,000 lines
(172,000 lines of C++ plus 144,000 lines of form definitions). If it were a
million lines, the answer would be the same. Work continues until the coverage
ledger reads 100%.

## What "ported" means

A unit counts as ported only when **all** of these hold:

1. The behaviour exists in this application and a user can reach it.
2. It works against a real server — not a stub, not a mock, not a simulation.
3. Its failure modes behave like the original: the same confirmations, the same
   refusals, the same error reporting.
4. It is documented under `docs/`, and surfaced on the landing page.
5. It has verification behind it — a test, or recorded evidence from a real run.

A dialog that opens but whose OK button does nothing is **not ported**. A
setting that persists but changes no behaviour is **not ported**. A menu entry
wired to a handler that throws "not implemented" is **not ported**, and is worse
than an absent one because it lies to the user.

## What is legitimately *replaced* rather than transcribed

WinSCP vendors two third-party engines it did not author:

| Vendored | Lines | Replacement in this port |
|---|---:|---|
| `putty/` | 82,710 | `ssh2` — SSH transport, authentication, SFTP |
| `filezilla/` | 19,447 | `basic-ftp` — FTP/FTPS engine |

Replacing a third-party engine with a maintained equivalent is a port of that
layer, not a gap in it. **The test is behavioural**: every capability WinSCP
exposes through those engines must be exposed here too. If PuTTY supports a key
exchange, a cipher, an authentication method or a bug workaround that the
replacement does not, that is a real gap and it goes in the ledger as one.

This exemption covers only those two directories. It is not a precedent for
skipping anything in `core/`, `windows/`, `forms/`, `components/`, `console/`,
`dragext/` or `resource/`.

## How "a setting that persists but changes no behaviour" is enforced

That sentence is the easiest clause in this document to violate by accident,
because the option looks finished from every angle: it is in `defaults.js`, it
has a control, it round-trips through the dialog, it survives a restart. Only
one thing is missing, and nothing about the screen shows it.

Two mechanisms hold the line:

- **`PENDING_KEYS`** in `design/renderer/ui/dialogs/prefpages.js` — the options
  this port stores and does not yet act on. Every one of them says so on its own
  row, in both languages, so a user never has to run a grep to find out.
- **The consumer scan** in `test/helpers/consumer-scan.js`, asserted by
  `test/preferences.test.js`. It finds every option nothing reads and holds
  `PENDING_KEYS` to exactly that set — failing in both directions, so an option
  that loses its consumer fails and so does one that gained a consumer while
  still claiming to have none.

What counts as a consumer is the whole game, and getting it wrong has cost this
repository three separate times:

| The scan counted… | What it let through |
|---|---|
| a leaf NOT preceded by a dot | three honoured options reported as dead (the guard's own lie, inverted) |
| a mention anywhere under `test/` | eight dead options reported as honoured — `test/preferences.test.js` names every key it asserts, so the guard proved its own subject matter consumed |
| a mention inside a comment | three more, each described in one doc comment above a function that never reads it |

So: a consumer is **production code under `design/`, outside the preferences
surface, that reads the key** — comments and prose discounted, tests never. When
adding a scan rule, remember which direction is expensive: a consumer the scan
cannot see gets called an orphan, and the honest-looking fix is to declare a
working option pending, which is the exact lie the guard exists to stop.

## How progress is measured

`node tools/port-matrix.js` regenerates [`port-coverage.md`](port-coverage.md)
from the vendored source and `tools/port-map.json`. It is deliberately hostile
to optimistic reporting:

- A unit with no mapping counts as **not started**.
- A mapping that names a file which does not exist is reported as **broken** and
  counts as **zero**, not as coverage.
- Coverage is weighted by source lines, so a large subsystem cannot be made to
  look finished by porting a handful of small files around it.

Run it after any significant change. `--check` exits non-zero when a mapping is
broken, so CI can hold the line.

## Rules for anyone continuing this work

- **Never narrow the scope to make it finishable.** If a subsystem is too big
  for one sitting, split it across sittings — do not decide it is out of scope.
- **Never mark a unit done to move on.** The ledger is only useful while it is
  honest; a false ✅ costs more than an ⬜ because nobody revisits it.
- **Report what is actually true.** "38% ported, here is what remains" is a good
  report. "Ported the core features" is not a report at all.
- **Finish the unblocked work before raising a blocker**, then name the blocker
  precisely and keep going on everything else.
