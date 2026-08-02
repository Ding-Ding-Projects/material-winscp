# WinSCP Material — documentation index

Every feature in this project has its own Markdown file under a category folder.
Each category has an index (`README.md`) that lists its features and records
anything category-wide — including, where relevant, that a thing does **not**
apply.

> [!NOTE]
> **This project has no HTTP API.** It is a desktop application that speaks
> SFTP, SCP, FTP/FTPS, WebDAV and S3 to *other people's* servers; it exposes no
> server, no REST surface and no local HTTP endpoint. **Postman collections are
> therefore not applicable anywhere in this documentation set**, and none are
> invented. The protocol category index states this again in context.

## Reference documents (owned elsewhere in the repository)

| Document | What it is |
| --- | --- |
| [`architecture.md`](architecture.md) | The contract every module is written against. Read it before adding code. |
| [`porting-mandate.md`](porting-mandate.md) | What "port every WinSCP feature" means in practice. |
| [`port-coverage.md`](port-coverage.md) | Feature-by-feature porting status against upstream WinSCP. |
| [`dialog-inventory.md`](dialog-inventory.md) | Every upstream dialog and where it landed in this port. |

## Categories

| Category | Covers |
| --- | --- |
| [protocols/](protocols/) | SFTP, SCP, FTP/FTPS, WebDAV, S3 and the local filesystem backend. |
| [transfers-and-queue/](transfers-and-queue/) | The transfer queue, resume, speed limits, transfer settings and presets. |
| [synchronization/](synchronization/) | Directory synchronization, the comparison checklist and keep-remote-up-to-date. |
| [sessions-and-sites/](sessions-and-sites/) | Sites, folders, workspaces, session URLs, tunnels and reconnection. |
| [security-and-credentials/](security-and-credentials/) | Host key verification, credential storage, master password, at-rest encryption. |
| [editing-and-commands/](editing-and-commands/) | Internal and external editors, custom commands, extensions, the file mask language. |
| [interface-and-appearance/](interface-and-appearance/) | Material 3 theming, per-element appearance editing, the infinite colour picker, notifications. |
| [tabs-and-navigation/](tabs-and-navigation/) | Browser-style tabs, pinning, grouping, overflow and the four tab searches. |
| [search-and-regex/](search-and-regex/) | The regex builder, file search, and every search bar it is wired to. |
| [version-history/](version-history/) | The local git-backed history of every user-managed record, and its filters. |
| [accessibility-and-languages/](accessibility-and-languages/) | Language modes, funny-level sliders, the narrator, accessibility guarantees, the dim sum surprise. |
| [packaging-and-updates/](packaging-and-updates/) | The Squirrel installer, CI, releases, code names and the update lifecycle. |

## How to read a feature article

Every article uses the same five headings, so you can skim to the part you need:

1. **What it does** — the behaviour, in plain terms.
2. **Configuration** — every option, where it lives in `defaults.js`, and where
   it surfaces in the UI. An option with no UI is not shipped.
3. **Failure modes** — what goes wrong, what the user sees, what is recoverable.
4. **Security considerations** — what the feature can leak or damage.
5. **Verification** — the tests and manual checks that prove it works.

Each article ends with **Suggested articles**, so you are never left at a dead
end.

## Status honesty

This documentation describes the port as it stands in the repository. Where a
feature is implemented but not yet verified end-to-end, the article says so in
its Verification section rather than implying it is finished. Nothing here
claims a CI run, a release or a test result that does not exist.
