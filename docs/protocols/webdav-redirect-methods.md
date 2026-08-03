# WebDAV redirect methods

The WebDAV adapter follows HTTP redirects only within the configured origin by
default. HTTPS sessions never downgrade to HTTP, and streamed uploads are not
replayed because their request body cannot be safely rewound.

A `303 See Other` response is special: the follow-up request is a bodyless
`GET`, as required by HTTP. This prevents a redirected `PUT` from being sent
again to the result URL. Other supported redirects preserve the original
method and replayable body.

## Failure modes and security

Cross-origin redirects are rejected unless the site explicitly allows them;
credentials are never forwarded across that origin boundary. Redirect loops
are bounded, and a streamed upload that receives a redirect fails rather than
silently truncating or duplicating data.

## Verification

The focused protocol suite covers a real local HTTP server returning `303`,
checking that the first request is `PUT` and the redirected request is a
bodyless `GET`.
