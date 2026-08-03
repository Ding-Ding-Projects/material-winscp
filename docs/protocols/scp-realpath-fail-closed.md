# SCP realpath failure handling

SCP canonicalizes a path through the remote shell. When neither `cd && pwd`
nor `readlink -f` produces a result, the adapter reports the failure instead of
returning the input path as if it had been verified.

This matters for callers that use `realpath()` to compare or display the
server's canonical location. An unresolved path is not equivalent to its
uncanonicalized input, especially when the path is missing, the account has no
`readlink`, or the shell returns an error.

## Failure mode and security

The operation rejects with the server's stderr when available. No remote file
is changed, and the adapter does not retry with a guessed path. Shell quoting
continues to protect the original path from command interpretation.

## Verification

The focused end-to-end protocol test stubs a failed shell resolution and checks
that the precise error is surfaced. Successful `realpath()` behavior remains
covered by the existing SCP protocol suite.
