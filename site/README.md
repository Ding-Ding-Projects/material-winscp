# The site

The Material 3 landing page and documentation site. The full article lives at
[`docs/packaging-and-updates/site.md`](../docs/packaging-and-updates/site.md);
this is the short version for anyone standing in this directory.

```sh
node site/build.js            # build into site/_site/
node site/build.js --verify   # build, then check the emitted output; exits 1 on any problem
node site/build.js --serve    # build and serve at http://localhost:8080/material-winscp/
```

No dependencies. `node:fs` and `node:path`, nothing else — there is no `npm ci`
step for the site, locally or in CI.

## What is here

| Path | |
| --- | --- |
| `build.js` | The whole builder: markdown renderer, content model, emitter, verifier and dev server. |
| `config.json` | `base`, `version`, `title`, `tagline`, `repository`. |
| `src/` | The static sources. `{{BASE}}`, `{{VERSION}}`, `{{TITLE}}` and `{{REPOSITORY}}` are substituted on copy, in subdirectories too. |
| `_site/` | The build output. Git-ignored; never edit it. |

> [!IMPORTANT]
> **`src/app.js` and `src/app.css` do not exist yet.** `index.html` references
> them, so `--verify` reports both as missing and exits 1. That is the verifier
> working. The page cannot run, and the Pages workflow will not publish it,
> until they are written.

## The base path

The site is served from `/material-winscp/`, not from a domain root. An asset
URL that loses that prefix produces a build that is green, a deployment that is
green, and a page where every request 404s — so `--verify` reads the **emitted
files** and fails on any root-absolute URL that does not carry it. Override the
prefix with `--base /x/` or `SITE_BASE`; CI takes it from Pages itself.

## Adding to it

Articles are generated from `docs/`, so writing a feature article there is how a
page appears here — do not copy documentation into `src/`.

The application may be split into modules: `src/app/ui/tabs.js` and friends are
copied recursively, with the same substitution, and `--verify` walks the whole
output tree looking for bad URLs.

Run `node --test test/site-build.test.js` after touching `build.js`.
