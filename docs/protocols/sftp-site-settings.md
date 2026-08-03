# SFTP site settings

The SiteAdvanced SFTP page exposes settings used by this port's SFTP adapter:
the stored protocol-version preference, the subsystem command, path and rename
compatibility, known-server workarounds, packet sizing, and request pipelining.
The current `ssh2` integration still negotiates SFTP v3 only; `sftpMaxVersion`
is retained for imported profiles but does not change that live negotiation.

The page does not expose an SCP-fallback switch. The stored `allowScpFallback`
field is retained only for compatibility with imported WinSCP-style settings;
this port has no runtime consumer for it. Showing the switch would imply that
an SFTP connection could silently change protocol, so the setting is deliberately
not advertised or applied.

Verification: `test/sitedata.test.js` asserts that no SiteAdvanced control binds
to `allowScpFallback`; `design/main/session.js` and the protocol adapters contain
no fallback path driven by that field. Protocol regression tests also verify that
unsafe remote entry names are rejected, special-file types are preserved, and
zero user-quota free space is not replaced with physical free space.
