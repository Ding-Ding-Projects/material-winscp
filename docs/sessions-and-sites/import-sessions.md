# Import sessions

The Import Sessions dialog is the production boundary for bringing saved
connections from PuTTY, KiTTY, FileZilla, OpenSSH, WinSCP INI files and
`known_hosts` into the site tree. It parses user-supplied text in the renderer,
shows the same records it will write, and only adds checked records after the
preview is confirmed.

## Behaviour

- PuTTY and KiTTY registry exports support session names, host/user splitting,
  ports, compression, authentication flags, algorithm order, proxy settings
  and SSH TCP/IP tunnels.
- PuTTY session names use the same URL-style decoding as WinSCP: `+` becomes a
  space and consecutive `%XX` bytes are decoded together as UTF-8. This keeps
  non-ASCII names such as `香港 + Prod 1` intact instead of importing mojibake.
- FileZilla XML, OpenSSH client configuration, WinSCP INI, and OpenSSH
  `known_hosts` each have their own bounded parser and preview source label.
- Passwords are never shown in the preview. An imported password is carried to
  the protected configuration boundary and only represented in the list as
  included metadata.

## Configuration and failure modes

The dialog accepts a file or pasted text, caps input at 8 MiB and caps output at
5,000 sites. Malformed records are not guessed into a different protocol or
host; unsupported protocol values remain visible in `puttyProtocol` and get a
warning while the import uses SFTP as the safe file-transfer default. A
malformed percent-encoded name remains escaped rather than throwing or being
silently rewritten.

The main-process `design/main/putty.js` helper remains the private-key and
PuTTY-config metadata boundary. The renderer import parser deliberately does
not load that CommonJS module across Electron's isolated context; its registry
decoder is kept behaviorally aligned with the vendored WinSCP URL decoder and
the resulting site still passes through the normal main-process config
validation.

## Security considerations

Registry, XML, INI and SSH files are untrusted input. The parser does not
execute commands, fetch external entities or log imported values. Secret-like
fields are not copied into diagnostics, and PuTTY private-key contents are not
loaded by the import dialog. Imported host keys still require the normal host
key policy before a connection is trusted.

## Verification

Focused coverage is in [`test/sitedata.test.js`](../../test/sitedata.test.js):

```text
node --test test/sitedata.test.js
```

The PuTTY regression checks Unicode UTF-8 percent runs, `+` spaces, registry
session-name propagation and preservation of malformed escapes. The vendor
reference is `vendor/winscp/source/core/Common.cpp`, `DecodeUrlChars`.

## Suggested articles

- [Site manager](site-manager.md) — review and organize imported sites.
- [PuTTY interoperability](../security-and-credentials/putty-interop.md) —
  safe key and setting metadata boundaries.
- [Host keys](../security-and-credentials/host-keys.md) — verify the endpoint
  separately from imported connection metadata.
