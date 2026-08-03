# S3 multipart cleanup

The S3 adapter uses multipart upload after the configured part threshold. Any
failed part, cancellation, or completion error sends `AbortMultipartUpload` so
the incomplete upload does not remain stored and incur cost.

Cleanup is idempotent within one upload stream. Stream finalization and stream
destruction can both observe the same failure; they share one abort request and
preserve the original transfer error. A failed abort is deliberately swallowed
during error cleanup so it cannot replace the useful transfer failure.

Verification is in `test/protocols-s3-remove.test.js`, covering cancellation and
a completion failure that would otherwise send duplicate abort requests.
