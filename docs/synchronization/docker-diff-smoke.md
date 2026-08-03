# Docker diff smoke

## What it does

`npm run smoke:docker` starts two disposable local servers — `atmoz/sftp` and
`stilliard/pure-ftpd` — then drives the real Electron application through its
IPC bridge. It creates divergent local and remote trees containing unchanged,
local-only, remote-only, size-different, equal-size-but-different, nested,
Unicode, whitespace, empty and case-folded names. It compares and applies the
checklist in both directions, including the non-recursive boundary.
It then runs independent policy probes for include masks, `deleteFiles: false`
(deletions may be listed for review but must be unticked), `existingOnly: true`, and checksum comparison when the real server exposes a
checksum capability. The output records checksum support explicitly instead of
pretending a size comparison tested it.

The containers use explicit CPU, memory and process limits, loopback-only
published ports and generated credentials. The password enters Docker through
a short-lived OS-temporary env file rather than a command-line argument or
printed environment value; that file is deleted as soon as the containers are
created, and the script removes only the two containers and its fixture
directory when it exits.

## Configuration

Docker and the two images must already be available locally. Pull them with:

```sh
docker pull atmoz/sftp:latest
docker pull stilliard/pure-ftpd:latest
```

The optional `DOCKER` environment variable selects another Docker executable.
The smoke is intentionally opt-in and is not included in `npm test`, because
the default suite must remain runnable without a container engine.

## Failure modes

The command fails if Docker is unavailable or unresponsive, either image cannot
be inspected, the bounded port search cannot start a server, a real session
cannot authenticate, a comparison loses a fixture, or an applied transfer does
not produce the expected bytes.
It does not silently replace a missing container with an in-process mock.

If the process is forcibly terminated before its `finally` block runs, inspect
only the uniquely named `winscp-docker-diff-*` container shown by Docker and
remove that named container manually. Cleanup commands are bounded so an
unresponsive Docker Desktop daemon cannot turn one failed startup into a long
retry loop; if Docker reports removal is already in progress, wait for that
exact named container to disappear before retrying. Do not use a global prune
command.

## Security considerations

Credentials are generated per run and are never printed or placed in a Docker
command argument. They briefly exist in a mode-restricted OS-temporary env file
and are removed after container creation, including on normal setup failure.
Servers bind to `127.0.0.1`, have no host directory mounts, and are limited to
the disposable test data. The smoke is for local development; it is not a
production server hardening test.

## Verification

Run:

```sh
npm run smoke:docker
```

The command reports one sanitized result line per protocol and a final cleanup
line. Each result includes the main checklist counts, mask-policy count,
existing-only count and checksum support/result. `npm test` remains the required
deterministic gate; this smoke adds real container-network evidence for SFTP and
FTP diff, checklist, transfer, policy and (when available) checksum paths.

## Suggested articles

- [Synchronize](synchronize.md) — directions, modes and comparison criteria.
- [Comparison checklist](comparison-checklist.md) — review and apply policy.
- [Transfers and the queue](../transfers-and-queue/) — where accepted rows go.
