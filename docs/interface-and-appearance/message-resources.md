# Message resources

User-visible WinSCP wording is resolved from the extracted table in
`design/renderer/messages.json` through `design/main/messages.js`. The main
process is the only formatter; the renderer reaches it through the named
`window.api.messages.load` preload method and the `messages:load` IPC channel.

## Formatting contract

`messages.load(id)` returns the resource verbatim. A positional resource uses an
array, for example:

```js
window.api.messages.load('CHANGE_DIR_ERROR', ['/var/www']);
```

Resources with Delphi named slots use a plain object keyed without the percent
signs:

```js
window.api.messages.load('NET_TRANSL_TIMEOUT2', { HOST: 'sftp.example.com' });
```

The bridge accepts both shapes. It rejects unknown resource ids and malformed
arguments through the normal `{ ok: false, error }` IPC envelope. Positional
formatting still refuses missing arguments instead of showing a sentence with a
literal `%s` hole. A named slot with no supplied value follows WinSCP's
behaviour and remains literal; this is intentional for resources such as
`PATH_ENV_TOO_LONG`, where `%PATH%` names an environment variable rather than a
substitution.

## Security and failure modes

Only resource ids and bounded JSON-compatible argument values cross the
preload boundary. The renderer cannot read the resource table from disk or
invoke an arbitrary IPC channel. Callers must not pass passwords, tokens or
private keys as message arguments: resource arguments are rendered text and
may be visible in notifications, dialogs or logs. Formatting failures are
returned as IPC errors instead of crossing the bridge as thrown exceptions.

## Verification

- `test/messages.test.js` covers Delphi positional and named formatting,
  literal percent handling, missing arguments and unknown ids.
- `test/e2e-reconcile.test.js` boots the real Electron main process and preload,
  then verifies that `NET_TRANSL_TIMEOUT2` substitutes `%HOST%` before the text
  reaches the renderer.
