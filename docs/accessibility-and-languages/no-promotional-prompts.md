# No promotional prompts

## What it does

The port does not show unsolicited donation, sponsorship, review, rating,
upgrade, subscription or purchase prompts. The upstream donation action remains
available only when the user deliberately chooses the user-facing Donate menu
entry, which opens the upstream page in the browser.

## Configuration

There is no opt-out switch because there is no unsolicited prompt to disable.
The excluded resource identifiers and their policy reasons are recorded by
`design/main/messages.js` and `design/renderer/messages.json`.

## Failure modes

If a future caller asks for an excluded promotional resource, message lookup
fails with the policy reason instead of silently rendering a prompt. A user-
initiated browser action may still fail because the operating system or browser
cannot open the link; that failure does not interrupt application startup.

## Security considerations

No promotional URL is fetched at startup, and no telemetry or recurring
reminder is attached to the policy. The only browser navigation is the explicit
user action and is directed to the upstream donation page.

## Verification

The extracted resource table records the seven withheld donation/store strings,
`test/autoupdate.test.js` checks that update code contains no prompt or restart
nag, and the coverage ledger records the deliberate exclusion under
`resource/TextsWin1`. Re-run `node --test test/autoupdate.test.js` after changing
resource extraction or menu wiring.

## Suggested articles

- [Language modes](language-modes.md) — the policy applies in every language.
- [Notifications](../interface-and-appearance/notifications.md) — the
  non-blocking notification contract.
