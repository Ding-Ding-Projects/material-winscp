# Portable WinSCP INI import

When the JSON store does not exist, startup checks the application-data
directory for WinSCP's real portable filename, `WinSCP.ini`. If present, its
stored sessions and folder hierarchy are imported into the protected JSON
store. The source file is never rewritten.

The application also keeps `winscp-material.ini` as its explicit
WinSCP-compatible export target. That export filename is not the portable
source filename, so detecting only the export path would silently skip a
portable installation.

If both files exist, the real `WinSCP.ini` source takes precedence. A malformed
or empty source is reported and does not replace the current configuration.

Verification:

```powershell
node --test test/config-ini.test.js
```
