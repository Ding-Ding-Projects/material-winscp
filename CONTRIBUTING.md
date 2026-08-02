# Contributing to WinSCP Material

Thank you for wanting to help. This document is short on ceremony and specific
about the things that actually cause problems here.

## Before you write code

**Read [`docs/architecture.md`](docs/architecture.md).** It is the contract every
module in this repository is written against, and it is what lets independently
written modules fit together. Most review comments on a first contribution are
"this is already solved by the adapter contract".

Then read the feature article for the area you are touching, under
[`docs/`](docs/README.md).

## Setting up

```sh
git clone https://github.com/Ding-Ding-Projects/material-winscp
cd material-winscp
npm ci
npm test
npm start
```

**Use Node 22 LTS on Windows.** On Node 26 the packaging chain stalls silently —
`npm run make` exits with status 0 and produces nothing at all. It reads exactly
like a configuration mistake and is not one. See
[`docs/packaging-and-updates/building.md`](docs/packaging-and-updates/building.md).

`vendor/winscp` is a git submodule holding the upstream WinSCP source. It is the
porting reference and is **read-only to this project** — never edit it and never
commit into it. You do not need it checked out to build or test.

## What "done" means

A change is finished when all of these are true. They are not a wish list; a
change missing any of them will be asked to come back.

- [ ] The behaviour works.
- [ ] `npm test` passes.
- [ ] Any new option is in `design/main/defaults.js` **and** surfaced in the
      Preferences UI. **An option with no UI is not shipped.**
- [ ] Any new adapter capability has both the `caps` flag *and* the method.
      A flag without an implementation is a bug that reaches users as a broken
      menu item.
- [ ] Any new search bar has the **regex builder anchored beside it**, plain text
      as the default, and its own state — never shared with another field.
- [ ] Any new rendered element exposes **Edit appearance…** from its context
      menu *and* from a keyboard command.
- [ ] Anything that only informs is a **corner notification**, not a modal.
      Modals are for decisions the user must make before continuing.
- [ ] Accessibility holds: keyboard reachable, visible focus, correct role, name
      and state, sufficient contrast, reduced motion respected.
- [ ] Nothing clips, truncates, overlaps or goes off-screen — checked in
      **bilingual mode**, at the longest string, at 100/125/150/200% scale.
- [ ] User-facing copy exists in **both languages**, at **all five funny levels**
      where the string is voiced, with **identical parameters** in every variant.
- [ ] The feature has its article under `docs/` and its section on the site,
      updated in the same change.

## The rules that are not negotiable

### Facts survive humour

The funny-level sliders change **voice, never facts**. A level-5 message still
names the file, the count, the irreversibility and the options. If your level-5
variant drops a parameter that level 1 had, the dictionary test will fail — and
it should.

### Secrets are protected or not stored

There is no third option. If the OS keychain is unavailable and no master
password is set, the secret is **not written** and the app asks each time. Do not
add obfuscation that looks like encryption; it is worse than asking, because it
makes the user believe something false.

### Nothing destructive without a preview

Synchronize, bulk close, prefix delete: the user sees a count and a list first.
Deletions are distinguished by shape and label, not colour alone.

### Quote everything that reaches a shell

A remote file named `; rm -rf ~` is attacker-controlled input. Every substituted
filename goes through the quoting layer. Any code path that builds a command by
string concatenation is a bug to fix, not a style preference.

### Images come from the repository

Do not generate, download, scrape or fetch an image. The bundled dim sum catalog
under `design/assets/` is the only image source, used byte-for-byte from its
tracked path. If no suitable tracked image exists, omit it and say so.

### History is append-only

Restoring writes a *new* revision. Nothing is ever rewritten or discarded. And
authenticated-encryption AAD binds to a **stable identifier that survives delete
and restore** — bind it to a row id and a restored record's secret becomes
permanently undecryptable in a way that looks exactly like corruption.

## Commit messages

Bilingual — English and playful Hong Kong-style Cantonese — and genuinely funny
in both. Roast the *code*, never a person.

But humour styles the telling, not the facts. **The subject line stays a precise,
scannable summary**: someone reading `git log` must learn what happened without
decoding a joke. The body names the real behaviour, the real cause and the real
fix.

```
Fix FTP listing parser dropping entries with two-space filenames

The Unix LIST parser split on whitespace and cheerfully assumed the
filename was the last field, which worked beautifully until someone
named a file "annual  report.txt" and it became "report.txt" — a file
that did not exist, in a directory that swore it did.

Now it splits on the first eight fields and treats the remainder as the
name, spaces and all.

FTP 列表解析器以前見到空格就亂斬，"annual  report.txt" 斬完變咗
"report.txt"，然後成個目錄扮晒無辜。而家只斬頭八個欄位，
剩返嘅一律當係檔案名，幾多個空格都照收。
```

## Pull requests

- One concern per pull request. A protocol fix and a theme change are two.
- Say what you verified and how. "Tests pass" is less useful than "added three
  cases to `masks.test.js` covering negated classes; all 47 pass".
- If the change has a **visible surface**, include a screenshot of it —
  from the real built app, framed on the thing that changed, cropped so a
  reviewer sees it without hunting. Before/after where a before exists.
- If it has **no visible surface**, say so and give the failing-then-passing test
  names instead. Do not substitute an unrelated screenshot.
- Never claim CI is green before it is. "Running" is an honest state.

## Reporting bugs

Open an issue with:

- What you did, what happened, what you expected.
- The protocol and, where you can share it, the server software and version.
- The app version, and whether it was an installed build or a local one.
- A session log at debug level 1 if the problem is protocol-related — **check it
  for hostnames and paths you would rather not publish first**. Never attach a
  log captured with `logSensitive` enabled; it contains credentials.

## Reporting a security issue

**Do not open a public issue.** See [`SECURITY.md`](SECURITY.md).

## Code of conduct

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Licence

Contributions are licensed under **GPL-3.0-or-later**, matching the project and
matching WinSCP upstream. By contributing you confirm you have the right to
submit the work under that licence.
