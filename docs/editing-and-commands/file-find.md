# File find streaming and limits

The file-find engine streams matching entries as they are discovered and
honours an `AbortSignal` between directory entries and read-stream chunks.
Callers that need no results can pass `limit: 0` (or a negative limit); the
search returns immediately without normalizing the root, listing a directory,
or opening a file stream. Positive limits stop the stream as soon as that many
matching entries have been yielded.

While a search is running, the mask field and both mask editors—including the
regular-expression builder—are disabled together. This keeps keyboard users
from opening the builder and applying a new mask to a field that the active
search can no longer read, and makes the Stop/Start state unambiguous.

The destructive Delete action keeps its confirmation dialog open until the
filesystem bridge responds: a wholly failed deletion remains available for
retry, while successful or partial results remove only confirmed paths and
report failed paths explicitly.

This matters for remote adapters: an empty result request must not start a
network listing, and cancellation must not turn into a late match after the
caller has stopped consuming the stream. A permitted `test/filefind.test.js`
is not present in this checkout; the existing find test suite remains outside
the requested file scope and was not modified.
