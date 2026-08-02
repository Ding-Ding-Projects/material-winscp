# Search and regex

Every search bar in this application — without exception — has the full regex
builder anchored beside it. Plain text is always the default; regex is always an
explicit opt-in.

## Articles

| Article | Covers |
| --- | --- |
| [regex-builder.md](regex-builder.md) | The builder itself: guided construction, the raw editor, live matches, and the engine it targets. |
| [search-surfaces.md](search-surfaces.md) | Every search bar in the app, and the rule that settings surfaces have one too. |
| [file-search.md](file-search.md) | Recursive remote and local file search. |

## The rule

> Every search bar must provide direct access to the full-featured builder and
> support the resulting pattern and flags in its search operation.

And its corollary, which is the part usually missed:

> Every settings, preferences, properties or adjustment surface carries its own
> search bar wired to that same builder — the global preferences, every tab
> within them, every properties panel, and the appearance editor itself.

## Postman

Not applicable — this project exposes no HTTP API. See the
[documentation index](../README.md).

## Suggested articles

- [File masks](../editing-and-commands/file-masks.md) — the other pattern language, and how it converts.
- [Tab search](../tabs-and-navigation/tab-search.md) — four searches, four builders.
- [Version history](../version-history/) — whose history panel has one too.
