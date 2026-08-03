# PuTTY private-key preflight

The external PuTTY launcher performs a bounded, metadata-only check for local
`.ppk` files before it starts the child process. This is the production seam for
the `core/PuttyTools` port: it catches a truncated or malformed PuTTY file early
without asking for, logging, decrypting, or returning private-key bytes.

## Supported metadata

The parser accepts the PuTTY v2 and v3 envelope supported by the bundled
WinSCP reference. Encrypted v3 keys may contain the upstream Argon2 block:

- `Key-Derivation` (`Argon2d`, `Argon2i`, or `Argon2id`)
- bounded positive memory, pass-count, and parallelism values
- a bounded hexadecimal salt

The parser reports those parameters as metadata only. It never runs Argon2 or
AES-CBC, and it never treats a valid envelope as proof that a passphrase is
correct. The SSH/PuTTY process remains responsible for using the key.

## Failure behaviour

If an existing `.ppk` path fails the metadata check, launching PuTTY stops with
the generic `INVALID_KEY` setup error and does not spawn the child. Missing or
unresolved paths are left to PuTTY, because relative paths are resolved from
the child process's working directory. OpenSSH and other non-`.ppk` key formats
are not inspected by this preflight.

The returned error contains no path, comment, header, key material, or
passphrase. A valid metadata envelope still does not establish server trust;
host-key verification remains a separate explicit decision.

## Verification

Focused coverage is in:

- [`test/putty.test.js`](../../test/putty.test.js) — PPK metadata and Argon2
  header validation.
- [`test/putty-tools.test.js`](../../test/putty-tools.test.js) — launcher
  acceptance and fail-closed spawn prevention.

```text
node --test test/putty.test.js test/putty-tools.test.js
```

The tests use synthetic, non-secret base64 bodies and never load a real key or
passphrase.
