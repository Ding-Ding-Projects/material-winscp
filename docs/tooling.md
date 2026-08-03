# Repository tooling

Seven scripts under `tools/` keep this project's claims honest. Each exists
because a number that a person types is a number that quietly stops being true,
and this port makes a lot of claims about its own completeness.

Run them from the repository root.

## The porting ledger

```bash
node tools/port-matrix.js          # regenerate docs/port-coverage.md
node tools/port-matrix.js --check  # exit non-zero if a mapping is broken
```

Walks WinSCP's own source tree, pairs each translation unit with the file here
that carries its behaviour (from `tools/port-map.json`), and reports coverage.

It is deliberately hostile to optimistic reporting:

- A unit with **no mapping counts as not started**, never as "probably fine".
- A mapping naming a file that **does not exist counts as zero**, and is
  reported as a broken claim rather than silently dropped.
- Coverage is weighted by source lines, so a large subsystem cannot be made to
  look finished by porting the small files around it.

**It reports two numbers, and only one of them is worth quoting.** WinSCP's
`.dfm` files embed icon sheets and animation frames as page after page of hex —
`Animations144.dfm` is 18,155 lines of which 15,747 are pure hex, behind a
14-line `.cpp`. That is 108,113 lines of the tree, and classifying those eight
units as replaced moved the raw figure from 9.1% to 39.5% without a single
behaviour being ported. So the tool computes **logic coverage** separately and
says plainly which to use.

## Extracting the specification from WinSCP itself

```bash
node tools/extract-actions.js   # -> design/renderer/actions.js
node tools/extract-forms.js     # -> design/renderer/forms.json, docs/dialog-inventory.md
```

Porting 300 commands and 50 dialogs from memory guarantees quiet omissions, so
both are read out of the original:

- **301 actions** from `NonVisual.dfm`, with captions, hints, categories and 79
  keyboard shortcuts.
- **48 dialogs, 2,982 controls** (1,059 interactive) from the `.dfm` files.

> A `.dfm` holds several top-level objects — the form plus its popup menus and
> image lists. The first version of the form extractor kept only the last one
> and confidently reported Preferences as a two-control dialog. Collecting every
> root took the count from 1,294 to 2,982.

## The changelog

```bash
node tools/changelog.js          # regenerate the DEVELOPMENT block
node tools/changelog.js --check  # exit non-zero if it is stale
```

Generates the in-app changelog from `git log`. A hand-maintained one had already
drifted seven commits behind within a day.

- Every entry carries the **full** object name, verified with `git cat-file`
  before it is written. A wrong SHA is worse than none: it sends a reader
  somewhere confidently irrelevant.
- Bilingual commit bodies are split, so the Cantonese half is real copy from the
  commit rather than a machine translation.
- A commit with no body produces an **empty** change list, not a manufactured
  bullet announcing that it is empty — the viewer already renders that, and two
  components explaining the same absence is how they eventually disagree.
- Commits that only refresh `HANDOFF.md`, `ROADMAP.md` or the generated
  changelog block are bookkeeping, so they are intentionally omitted from the
  in-app history and cannot make `--check` stale after a report refresh.

## The handoff and roadmap

```bash
node tools/handoff.js            # regenerate HANDOFF.md and ROADMAP.md
node tools/handoff.js --no-tests # skip the test run (much faster)
node tools/handoff.js --check    # exit non-zero if stale
```

Reads the ledger, a real test run, the git log, the open issues and the built
installer artifacts. Nothing in the generated sections is typed by a person, so
the handoff cannot flatter the state of the work.

Prose between the `<!-- hand-written -->` markers is **preserved** across
regeneration — judgement ("this subsystem is riskier than its percentage
suggests") does not come out of a tool.

If the test output cannot be read it says so, rather than reporting a blank as a
pass.

## The line count

```bash
node tools/count-lines.js            # human-readable
node tools/count-lines.js --markdown # the table CI pastes into a release
node tools/count-lines.js --json     # every number, machine-readable
node tools/count-lines.js --no-blame # size only, skips attribution
```

Counts only files git tracks, split by part, with both total and non-blank
lines, and states its exclusions out loud rather than applying them quietly:
`vendor/winscp` is 421,584 lines of someone else's C++ and folding it in would
inflate this project roughly tenfold. Generated files are reported on their own
row, because a person did not type them. The excluded rows are printed **in the
same table** as the totals they are held out of, so **Project total** and **Grand
total — every file this repository tracks** are two visible numbers rather than
one number with a silent asterisk.

> The figures themselves are deliberately not repeated here. This file opens by
> saying that a number a person types is a number that quietly stops being true,
> and a file count pasted into prose drifts the moment anyone adds a file — which
> is exactly what happened to the two that used to sit in this paragraph.

### Who wrote it

Authorship is attributed **per surviving line** with `git blame`, never by
summing added lines out of `git log`. Churn is not authorship: a line written in
one commit and deleted in the next belongs to nobody, and a log-based tally
credits whoever rewrote a file most often. Blame answers the only question worth
asking — of the code that is here *now*, who wrote it.

A commit counts as agent-written under exactly two rules, both printed with the
numbers so the split can be re-derived:

1. **Automation author** — the commit author's own name or e-mail is an agent
   identity (`Claude <noreply@anthropic.com>`, anything `[bot]`, and so on).
2. **Agent co-author** — a person authored the commit but its message carries a
   `Co-Authored-By:` trailer naming an agent.

Anything matching neither is human-written; lines not yet committed are their
own row rather than being folded into either.

Two failure modes it refuses rather than guesses through:

- **A shallow clone.** `git blame` does not fail on one — it exits 0 and credits
  every line of every file to the single grafted boundary commit, which prints a
  tidy and completely fictional 100%. The counter detects the shallow clone,
  prints no split, and says how to fix it. This is why both CI checkouts set
  `fetch-depth: 0`.
- **Its own arithmetic disagreeing.** The size table counts bytes and the
  authorship table counts what blame accounts for; if the two totals differ then
  one is wrong and a reader cannot tell which. The counter withholds the split
  and **exits non-zero**, which fails the release step rather than publishing two
  numbers that do not add up. (The classic cause is counting the empty string
  after a file's trailing newline as a line, which blame does not.)

Blaming the whole tree takes about **2 seconds** at concurrency 8 — one `git
blame --porcelain` per file, run through a small pool, because on Windows the
process spawn dominates everything else. Serially it is closer to 14. The run
prints its own timing and file count, so that claim is checkable rather than
taken on trust.

### Where the number gets published

CI does the counting, not a person and not an agent. The release job runs the
committed script over the tagged commit:

```bash
node tools/count-lines.js --markdown > LINE_COUNT.md
```

`build/release-notes.js` reads that file through `LINE_COUNT_PATH` and embeds the
table in the release body under **How much code this is**, together with the
command above so a reader can reproduce it. The same table is written to the
workflow run summary. If the file is missing the notes say so plainly instead of
dropping the section, because an absent section is indistinguishable from a
release that never had one.

## Node 26 build workarounds

```bash
node tools/fix-node26-deps.js          # patch node_modules
node tools/fix-node26-deps.js --check  # report without patching
```

Two packaging dependencies are broken on Node 26, and one of them lies about it:

| Package | Failure |
|---|---|
| `extract-zip` 2.0.1 | Unpacks exactly **one** entry, then the promise never settles and the process exits **0**. No error, no rejection — success with nothing to show for it. |
| `cross-zip` | Calls `fs.rmdir(path, { recursive: true })`, removed in Node 26. At least it throws. |

The first is why `npm run make` sat at *Finalizing package* and then reported
success with no `out/` directory. **A build that claims success and produces no
installer is worse than one that fails.**

This patches `node_modules`, which is not committed; CI runs on a Node where
both behave. It refuses to silently "succeed" if upstream source has moved.

### It also re-unpacks Electron, because the patch arrives too late to help

npm runs Electron's postinstall **during** `npm install`, when `extract-zip` is
still the broken upstream copy. So `npm install` unpacks the Electron binary
with the very bug this tool exists to fix, and patching afterwards does nothing
for the damage already done: `node_modules/electron/dist` is left holding a
single file (`LICENSES.chromium.html`, whichever entry the zip happened to list
first) and no `path.txt`.

Nothing reports this. What you actually see is three layers away from the cause:

| Layer | What it looks like |
|---|---|
| `require('electron')` | `Electron failed to install correctly` |
| An e2e suite | Every test fails, each blaming its own assertion |
| `npm test` | **Hangs.** The runner never exits, so there is no summary at all |

So the tool now checks `path.txt` against the binary it names, and re-runs
Electron's own `install.js` when that pointer leads nowhere. It re-reads the
same cached zip, so there is no download. `--check` reports the state and exits
non-zero when an unpack is needed.

> Run it **after** `npm install`, never before — it repairs what that install
> broke.

## Progress reporting

```bash
node tools/post-progress.js "what landed this round"
node tools/roadmap-issues.js          # create/refresh the roadmap issues
```

`post-progress.js` regenerates the ledger, runs the tests and posts a formatted
bilingual comment to the rolling Discussion. **It accepts no percentage
argument** — the only number it can post is the one the ledger computed.

`roadmap-issues.js` is idempotent: an issue whose title already exists is left
alone rather than duplicated.

## Suggested reading

- [`porting-mandate.md`](porting-mandate.md) — what "ported" means here
- [`port-coverage.md`](port-coverage.md) — the live ledger
- [`protocol-gaps.md`](protocol-gaps.md) — capabilities the replacements lack
- [`architecture.md`](architecture.md) — the module contract
