# Configuration sanitization

Configuration is a user-data boundary. JSON backups and portable files can be
edited by hand, copied from an older build, or partially damaged. The loader
normalizes malformed collections before the renderer or session manager sees
them: sites, folder names, workspaces, workspace session records, preference
collections and host-key maps are kept at their documented shapes. Invalid
records are discarded rather than passed to a consumer that expects an object.
Duplicate site IDs are regenerated while preserving both site records. Workspace
session secrets are either re-protected or removed; they are never written as
clear text.

State imports are stricter than startup recovery. A backup that supplies a
collection must supply the right collection type and valid record shapes; an
invalid import is rejected and the live configuration is restored without a
flush. This keeps a bad backup from replacing good sites or folders with a
half-applied state.

## Failure modes

- A malformed startup collection is sanitized and migrated back to the JSON
  store. It does not make the application crash while opening a session list.
- A non-object site or invalid workspace record is ignored during startup;
  valid records remain addressable, receive legacy IDs when needed, and do not
  share an ID with another loaded site.
- A state import containing a non-array collection, an invalid folder entry or
  an unnamed workspace fails with a configuration error before saving.
- Host-key JSON that is not an object is treated as an empty trust store. It is
  never iterated as if an array were a hostname map.
- A malformed workspace password is removed during migration, and a new
  workspace containing an unprotectable password is refused before persistence.

## Security considerations

Sanitization does not make untrusted configuration trusted. Secrets still pass
through the existing protection boundary; clear-text imported passwords are
not persisted. Never put a password or host-key private material in a backup,
command argument or issue comment.

## Verification

`test/config-ini.test.js` covers startup sanitization and all-or-nothing state
imports. Run:

```text
node --test test/config-ini.test.js
```

See [`README.md`](README.md) for the configuration category index and
[`import-validation.md`](import-validation.md) for the broader import rules.
