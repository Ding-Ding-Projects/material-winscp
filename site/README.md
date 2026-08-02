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
| `src/index.html` | The shell. The only place `{{BASE}}` appears in a URL. |
| `src/app.js` | The client application's entry module (`type="module"`). |
| `src/app.css` | Material 3 tokens and every component. One file, no `@import`. |
| `src/lib/` | The application's modules: router, regex, colour, i18n, store, theme, tabs, settings, pages, dim sum. |
| `release.json` | The installer manifest, **generated at publish time and git-ignored**. See below. |
| `_site/` | The build output. Git-ignored; never edit it. |

Plain ES modules, loaded directly by the browser — no bundler, no transpiler,
no build step beyond `build.js`. `app.js` imports `./lib/*.js` by relative
specifier, so `lib/` ships under whatever prefix the deployment has without the
build substituting anything into an import.

> [!IMPORTANT]
> **A module import is a subresource.** `--verify` resolves every
> `import … from '…'` in the emitted JavaScript against its importer and fails
> the build if the target is not there. It has to: a missing `lib/` file appears
> in no `src=`, `href=` or `url()`, and an unresolvable import fails the whole
> module graph — a blank page, not a degraded one.

## The download button

The landing page shows a download button only when `release.json` is present and
every asset URL in it is the immutable `<repo>/releases/download/<tag>/<file>`
form. `pages.yml` generates it with `gh release view`; it is never committed,
because a checked-in copy is stale the moment the next release ships. No
manifest means no button — the page will not guess a URL.

```sh
# what CI does, if you want the button locally
gh release view --repo Ding-Ding-Projects/material-winscp \
  --json tagName,name,publishedAt,isDraft,assets > site/release.json
```

## The base path

The site is served from `/material-winscp/`, not from a domain root. An asset
URL that loses that prefix produces a build that is green, a deployment that is
green, and a page where every request 404s — so `--verify` reads the **emitted
files** and fails on any root-absolute URL that does not carry it. Override the
prefix with `--base /x/` or `SITE_BASE`; CI takes it from Pages itself.

## Adding to it

Articles are generated from `docs/`, so writing a feature article there is how a
page appears here — do not copy documentation into `src/`.

The application is already split into modules under `src/lib/`; they are copied
recursively, with the same substitution, and `--verify` walks the whole output
tree looking for bad URLs and unresolvable imports.

Run `node --test test/site-build.test.js` after touching `build.js`, and
`node --test test/site-app.test.js` after touching anything under `src/lib/`.
The second suite covers the parts that can be wrong quietly: the router's
ambiguous-anchor resolution, the regex predicate and its refusals, the colour
translator's round trip, the funny levels' parameter survival, and the settings
store's normalisation.
