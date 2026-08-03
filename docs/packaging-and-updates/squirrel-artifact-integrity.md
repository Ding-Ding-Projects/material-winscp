# Squirrel artifact integrity

The CI packaging job treats the Squirrel update set as one deliverable. It
requires a non-empty `Setup.exe`, `.nupkg`, and `RELEASES` manifest before the
release step can run.

`Setup.exe` handles a fresh installation. The package and `RELEASES` manifest
are also required for an installed copy to discover and apply later updates.
Publishing only the installer would create a release that appears healthy but
cannot complete the update path.

The gate runs immediately after `npm run make`, reports every missing artifact,
and stops before release publication. The focused regression is in
`test/packaging.test.js`; it checks that the workflow retains all three
requirements.

## Verification

Run:

```text
node --test test/packaging.test.js
```

The release workflow remains the authority for validating that the files are
also non-empty in the actual Windows build.
