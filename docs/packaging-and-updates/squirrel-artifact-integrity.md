# Squirrel artifact integrity

The CI packaging job treats the Squirrel update set as one deliverable. It
requires a non-empty `Setup.exe`, `.nupkg`, and `RELEASES` manifest before the
release step can run.

`Setup.exe` handles a fresh installation. The package and `RELEASES` manifest
are also required for an installed copy to discover and apply later updates.
Publishing only the installer would create a release that appears healthy but
cannot complete the update path.

The gate runs immediately after `npm run make`, reports every missing artifact,
then runs `build/verify-squirrel-artifacts.js` before release publication. The
verifier checks that the selected package name appears in the Squirrel
`SHA1 filename byteCount` `RELEASES` record and that
its recorded byte count and SHA-1 match the bytes being attached. A different
or stale package therefore cannot be published under a truthful-looking
manifest.

## Verification

Run:

```text
node --test test/packaging.test.js
```

For a built set, run:

```text
node build/verify-squirrel-artifacts.js --setup <Setup.exe> --nupkg <package.nupkg> --releases <RELEASES>
```

The release workflow remains the authority for validating that the files are
also non-empty in the actual Windows build.
