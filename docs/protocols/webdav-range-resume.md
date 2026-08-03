# WebDAV range reads

WebDAV downloads can request a byte range when the connected server advertises
`Accept-Ranges: bytes`. The adapter sends an inclusive `Range` header and
requires the server to answer `206 Partial Content`; a `200` response is
rejected so a resumed transfer cannot accidentally append a complete file to a
partial one.

The transfer queue still keeps WebDAV `caps.resume` disabled. HTTP range reads
can continue a download, but WebDAV `PUT` replaces the complete resource and
cannot safely continue an interrupted upload at an offset.

Range offsets must be non-negative safe integers. An optional end offset must
also be an integer no smaller than the start. Invalid offsets fail before any
HTTP request is made, rather than becoming a full download or an invalid HTTP
header.

## Verification

The focused WebDAV protocol test suite verifies that negative, non-finite and
reversed offsets are rejected locally, and that a valid bounded request sends
the exact inclusive `bytes=start-end` header.
