# File find streaming and limits

The file-find engine streams matching entries as they are discovered and
honours an `AbortSignal` between directory entries and read-stream chunks.
Callers that need no results can pass `limit: 0` (or a negative limit); the
search returns immediately without normalizing the root, listing a directory,
or opening a file stream. Positive limits stop the stream as soon as that many
matching entries have been yielded.

This matters for remote adapters: an empty result request must not start a
network listing, and cancellation must not turn into a late match after the
caller has stopped consuming the stream. A permitted `test/filefind.test.js`
is not present in this checkout; the existing find test suite remains outside
the requested file scope and was not modified.
