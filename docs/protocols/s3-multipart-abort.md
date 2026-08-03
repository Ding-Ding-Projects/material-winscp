# S3 multipart cleanup

The S3 adapter uses multipart upload after the configured part threshold. Any
failed part, cancellation, or completion error sends `AbortMultipartUpload` so
the incomplete upload does not remain stored and incur cost.

Cleanup is idempotent within one upload stream. Stream finalization, stream
destruction, and cancellation can all observe the same failure; they share one
abort request and preserve the original transfer error. A failed abort is
deliberately swallowed during error cleanup so it cannot replace the useful
transfer failure. Explicitly destroying a live stream without an error also
aborts its multipart upload.

Verification is in `test/protocols-s3-remove.test.js` and
`test/protocols-s3-stream.test.js`, covering cancellation, explicit destruction,
and a completion failure that would otherwise send duplicate abort requests.
