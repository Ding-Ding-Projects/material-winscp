# Configuration

This category documents the durable configuration store and its migration
boundaries. The project exposes no HTTP API, so API artifacts are not
applicable.

## Articles

| Article | Covers |
| --- | --- |
| [migration.md](migration.md) | Legacy JSON and portable WinSCP INI migration, protection, rollback and verification. |
| [portable-ini-import.md](portable-ini-import.md) | Detection of the real `WinSCP.ini` portable source and preservation of the app export path. |
| [import-validation.md](import-validation.md) | Malformed JSON errors, parser causes, and no-mutation import failure behavior. |
| [configuration-sanitization.md](configuration-sanitization.md) | Startup normalization and atomic state-import rejection. |
