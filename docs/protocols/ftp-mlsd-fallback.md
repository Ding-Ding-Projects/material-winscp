# FTP MLSD and LIST fallback

`MLST` and `MLSD` are different FTP commands. `MLST` describes one named path;
`MLSD` lists a directory. The adapter therefore selects `MLSD` only when the
server advertises `MLSD` itself. A server that advertises only `MLST` uses the
configured `LIST -a` / `LIST` fallback instead of receiving an unsupported
`MLSD` command.

This matters for older servers and gateways that implement precise path
metadata but retain a legacy directory-listing dialect. The fallback still
passes the raw response through the Unix, DOS/IIS, VMS and MLSD parsers, and
the configured `ftpUseMlsd: on` setting remains an explicit request: if the
server does not advertise `MLSD`, the adapter uses `LIST` because there is no
machine-readable directory command available.

## Verification

`test/ftp-list-candidates.test.js` asserts both cases: `MLST` alone selects
`LIST -a` then `LIST`, while a server advertising `MLSD` selects `MLSD`.
