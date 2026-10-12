# Windows native verification preservation

Status: evidence preserved; application repair unfinished. No application source
or regression test was changed during the interrupted callback-repair follow-up.
This branch is for evidence review only, not integration or release acceptance.

## Provenance

- Verified source: `0fe6fc793681410f48fcb08cfc72b6e9e9e3a383`.
- Evidence-preservation base: `a4176bbfa14b28c7b0b65425bd45c78396654f84`.
- The newer base contains the separately completed CRLF repair. It was not
  rerun on Windows before work was stopped; do not transfer the old runtime
  results to that newer source revision.
- Windows x64; build Node 22.20.0; native Electron 33.4.11.
- Verified packaged `app.asar` SHA-256:
  `d9e2361ca86e8b5271c797d4e13c16bd43ca8eea79488f72ca8250a90815d5d0`.

The two adjacent `.cjs` files are unchanged copies of the executed verification
harnesses. They preserve the original task layout and fixed source binding.
They are not application startup code, not a new portable runner, and were not
executed again during preservation. The driver expects a sibling
`winscp-verify` checkout relative to its containing evidence directory, with its
own Electron dependency and packaged output. Running it writes local reports,
captures and disposable profiles alongside the harness. These outputs contain
machine paths and must not be committed. Only use it in a separate disposable
workspace after reviewing its layout assumptions.

## Completed checks at the verified source

```text
npm.cmd ci --no-audit --no-fund
npm.cmd run package
node --test --test-timeout=120000 test/editors.test.js test/history.test.js test/document-restore-ipc.test.js test/editor-dialog.test.js test/history-panel.test.js
node --test --test-timeout=120000 test/changelog-validation.test.js test/changelog.test.js test/site-build.test.js test/site-app.test.js test/port-matrix.test.js
node --test --test-timeout=600000 test/site-build.test.js
node tools/changelog.js --check
node evidence/winscp-native.cjs
```

Dependency installation and unpacked Windows packaging succeeded. The focused
recovery tests passed 81/81. The source/site batch had 118 passes and one timeout
cancellation; the site-build-only rerun passed 38/38 with the extended timeout.
The full aggregate suite was not rerun. The previously reported Linux baseline
of 28 failures and 36 cancellations remains unresolved; this is not a green
aggregate-suite claim.

Native scenarios: eight passed and one failed; the harness exited 1 and kept
the failure visible. Successful scenarios covered Cancel/Escape, normal Discard,
repeated close requests, separate recovery copies, exact-byte history recovery,
and injected close/write/open/audit failures. Original files were unchanged;
history restore preserved configuration at the IPC boundary. Subsequent UI
changes were limited to notification history and history-panel search state.
No sessions, queued transfers or outbound network attempts occurred.

## Outstanding findings

1. The original Windows checkout's changelog freshness command exited 1 even
   though existing and generated blocks matched after CRLF normalization.
   That finding belongs to the original verified revision. The preservation
   base already includes the separate repair; no duplicate repair was made.
2. Two synchronous activations of the same Discard callback produced one
   exclusive recovery copy and one discard revision, but left the renderer
   editor open and marked clean. The second activation targeted a detached
   button. This demonstrates callback re-entry, not an ordinary physical
   double-click failure. A per-confirmation pending-action guard and a
   baseline-failing regression were discussed but never implemented.

## Acceptance limits and retained local exceptions

The unchanged packaged main modules, preload and renderer ran in a hidden,
offscreen, task-only Electron lifecycle host. Failure injection changed named
backend methods only inside that disposable process. This does not establish
physical-input, normal-startup, installer, release or deployment acceptance.

Raw JSON, logs, PNG captures, previous-attempt directories, temporary documents,
Chromium profiles and synthetic configuration/history repositories remain local.
They expose derived filesystem paths and include synthetic nonfunctional
protected-configuration fixtures. Dependencies, downloaded toolchains and
unpacked build products also remain local. Nothing in this preservation branch
uploads those materials, runs package operations, or repairs the application.
The source scripts were inspected for literal credentials, host/user paths and
known private vocabulary before inclusion; generated outputs are not sanitized
by preserving their source.
