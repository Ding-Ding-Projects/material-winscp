# FileBuffer transfer conversion

## What it does

`design/main/filebuffer.js` is the byte-level port of WinSCP's
`core/FileBuffer.cpp`. It owns the persisted LF/CRLF/CR ordinals, bounded
chunk conversion, BOM/Ctrl-Z scrubbers, and the cursor/size metadata used by
buffered reads and writes. Text conversion is byte-oriented; it does not guess
or decode a file's character encoding.

The streaming converter carries a CR/LF boundary and a possible DOS Ctrl-Z
across reads. When UTF-8 BOM removal is enabled, it probes at most the two
bytes needed to complete `EF BB BF`, so a split marker is removed without
retaining the file or changing a BOM-like sequence in the middle of the file.
An incomplete marker at end of stream remains data.

## WinSCP contract and deliberate boundaries

- `FileBuffer.convert()` follows WinSCP's block-local `cpRemoveBOM` and
  `cpRemoveCtrlZ` flags and its `Token` EOL state machine.
- `EolConverter` is the stream-safe wrapper: it keeps only boundary bytes,
  strips a BOM once at the true head, and removes Ctrl-Z only at the true end.
- `FileBuffer` keeps separate valid `size` and cursor `position` metadata;
  `readChunk()` accounts for short reads and `writeChunk()` refuses an
  over-read instead of silently truncating output.
- Encoding detection and UTF-16/ANSI decoding belong to the editor's text
  loader, not this transfer-byte module. This module only recognizes the
  UTF-8 BOM required by the WinSCP scrubber flag.

## Failure modes and security

Malformed EOL settings throw instead of silently disabling text conversion.
The converter never fetches or decodes external content. The only retained
look-ahead is a two-byte BOM candidate plus the existing one-byte CR/Ctrl-Z
boundary state; ordinary chunks are emitted as soon as their boundary is
known.

## Verification

Focused coverage exercises every split point of a UTF-8 BOM, incomplete
markers, non-BOM prefixes, CR/LF and Ctrl-Z boundaries, raw scrubber flags,
short reads, cursor metadata, and over-read rejection. The full FileInfo
version-resource parser remains covered by the existing security suite.

Remaining gaps are the native blocking stream callbacks (`LoadStream`,
`WriteToStream`, and `LoadFromIn`) and the queue's still-private production
converter seam; both require a broader transfer integration than this
FileBuffer-only change.
