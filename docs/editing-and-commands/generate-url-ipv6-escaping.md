# Generate URL: IPv6 zone identifiers

The Generate URL dialog emits scoped IPv6 hosts using the URI-safe form
required for zone identifiers. For example, `fe80::1%12` is generated as
`[fe80::1%2512]` so the percent sign is not mistaken for an incomplete escape.

When the application parses that URL, it decodes the zone identifier back to
the site value. Plain IPv6 literals remain bracketed, and ordinary host names
continue to use component escaping.

This protects copy/paste and hand-off through URL-aware tools while preserving
the actual address. The behavior is covered by the Generate URL round-trip
tests in `test/sitedata.test.js`.
