# Error contract

`design/main/exceptions.js` is the boundary between native protocol/runtime
failures and user-facing error handling. It keeps the useful classification and
the user's available next actions while preventing a raw adapter error from
crossing the IPC boundary.

## Categories and decisions

| Category | Meaning | User decisions | Automatic retry default |
| --- | --- | --- | --- |
| `protocol` | The peer returned malformed, unsupported or contradictory protocol data. | Retry, skip, abort | No |
| `validation` | Input or an operation precondition is invalid. | Abort | No |
| `cancellation` | The user or an abort signal stopped the operation. | Abort | No |
| `authentication` | The peer rejected the login or authentication exchange. | Retry, abort | No |
| `permission` | The peer or local system refused access. | Skip, abort | No |
| `transport` | The connection, socket, DNS or TLS path failed. | Retry, skip, abort | Yes |
| `unknown` | The source did not provide enough evidence for a more specific class. | Retry, abort | No |

`retry`, `skip` and `abort` are decisions offered to the user; `retryable` is a
separate fact for an automatic retry loop. An unknown error therefore permits a
deliberate retry but is not retried automatically.

## Safe usage

```js
const { serializeError } = require('./exceptions');

try {
  await adapter.list(path);
} catch (cause) {
  return { ok: false, error: serializeError(cause, {
    operation: 'list',
    protocol: session.protocol,
    secrets: [session.password],
  }) };
}
```

`classifyError` returns a `ContractError`. Its native `cause` is retained as a
non-enumerable diagnostic property, but `toFacts()`, `toJSON()` and
`serializeError()` omit the cause, stack and arbitrary native fields. They also
remove sensitive object keys and redact supplied secrets, URL credentials,
password-like assignments and PEM private-key blocks. Do not send the original
error, `cause`, stack or adapter response over IPC.

Known categories preserve a bounded, redacted message. Unknown errors use the
truthful generic message `The operation failed unexpectedly.` because an
implementation message cannot safely be assumed to be suitable for a user.

## Failure modes and verification

- Invalid category or decision input falls back to the stable category contract;
  it cannot invent a new action.
- Large or deeply nested details are bounded, and binary values are not exposed.
- A cause can still be inspected by a local diagnostic sink, while its content is
  absent from serializable user-facing facts.
- Focused verification: `node --test test/exceptions.test.js`.

There is no HTTP API for this feature; the category index records that API
collections are not applicable.
