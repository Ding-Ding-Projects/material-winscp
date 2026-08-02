# Tunnels and proxies

## What it does

Two different ways to reach a server you cannot connect to directly.

A **tunnel** opens an SSH connection to a jump host and forwards a local port
through it, then connects the real session to that port. Two authentications,
one visible session. This is how you reach a database server that only listens
on a private network.

A **proxy** routes the connection through an intermediary — SOCKS, HTTP CONNECT,
Telnet, a local command, or the system's configured proxy.

They compose: the tunnel connection itself can go through a proxy.

## Configuration

### Tunnel — **Site → Advanced → Tunnel**

| Option | Default | Meaning |
| --- | --- | --- |
| `tunnel` | `false` | Enable it. |
| `tunnelHostName`, `tunnelPortNumber` | `''`, `22` | The jump host. |
| `tunnelUserName`, `tunnelPassword` | `''` | Its credentials, stored separately from the session's. |
| `tunnelPublicKeyFile`, `tunnelPassphrase` | `''` | Key authentication for the jump host. |
| `tunnelLocalPortNumber` | `0` | Local port to bind. `0` picks a free one, which is the right answer. |
| `tunnelHostKey` | `''` | Expected jump-host key fingerprint. |

### Proxy — **Site → Advanced → Connection → Proxy**

| Option | Default | Meaning |
| --- | --- | --- |
| `proxyMethod` | `none` | `socks4`, `socks5`, `http`, `telnet`, `cmd`, `system`. |
| `proxyHost`, `proxyPort` | `''`, `0` | |
| `proxyUsername`, `proxyPassword` | `''` | |
| `proxyTelnetCommand` | `connect %host %port\n` | Sent for the `telnet` method. |
| `proxyLocalCommand` | `''` | Command whose stdio becomes the connection, for `cmd`. |
| `proxyDNS` | `auto` | Whether names are resolved locally or by the proxy. |
| `proxyLocalhost` | `false` | Whether to proxy connections to localhost too. |

`proxyDNS` matters more than it looks: resolving locally tells your DNS server
every host you connect to, and can fail outright for names that only exist
inside the proxied network.

## Failure modes

| Situation | What the user sees | Recoverable |
| --- | --- | --- |
| Jump host authentication fails | The error distinguishes the tunnel authentication from the session's — otherwise users retype the wrong password repeatedly. | Yes |
| `tunnelLocalPortNumber` already in use | Reported with the port number and the suggestion to use `0`. | Yes |
| Jump host reachable, target not reachable *from it* | The tunnel opens and the session fails. The message names which hop failed. | Yes |
| Jump host key changed | The same blocking verification dialog as any host key — for the jump host, clearly labelled as such. | Yes |
| Tunnel drops mid-session | The session drops with it, and reconnection re-establishes both hops in order. | Yes |
| `proxyDNS` local, name only resolvable remotely | `ENOTFOUND` before any proxy traffic. The message suggests the setting. | Yes |
| SOCKS5 authentication rejected | Reported as a proxy failure, not a server failure. | Yes |
| HTTP proxy refuses CONNECT to a non-443 port | Common policy. The proxy's own status line is quoted. | Depends on the proxy |
| `cmd` proxy command exits immediately | The command's stderr is captured and shown; a silent failure here is otherwise impossible to debug. | Yes |
| `system` proxy configured with a PAC file | The PAC result is resolved once per connection and logged at debug level. | Yes |

## Security considerations

- **A tunnel means two sets of credentials, and both deserve protection.** The
  jump-host password and passphrase go through `crypto.js` exactly like the
  session's, and are stored separately so revoking one does not disturb the other.
- **Verify the jump host's key.** A compromised jump host sees every byte of the
  forwarded connection before its own encryption — pinning `tunnelHostKey` is the
  defence, and it is offered on first connect.
- **`proxyPassword` is a credential in the same protected store.** It is never
  written to the session log, and never included in a generated session URL.
- **`proxyLocalCommand` executes an arbitrary program.** That is the feature, and
  it is also the largest local-execution surface in the app. The field warns, the
  command is shown in full before it runs, and it is never populated by an import
  without an explicit confirmation.
- **`proxyTelnetCommand` is sent verbatim** with `%host`/`%port` substituted, and
  the substitution is escaped. A hostname is attacker-influenced data if it came
  from an imported site.
- **Local DNS resolution leaks your destinations** to whoever runs your resolver.
  `proxyDNS` is the control, and the option explains the trade rather than just
  offering three words.
- **`proxyLocalhost` off by default** — proxying loopback traffic is almost never
  intended and can route a local connection off the machine.

## Verification

- Tunnel setup order (authenticate jump host, bind port, connect session, tear
  down in reverse) is tested against a synthetic forwarder.
- Automatic local port selection and the in-use error are tested directly.
- Each proxy method's handshake is tested against a synthetic proxy: SOCKS4/4a,
  SOCKS5 with and without authentication, HTTP CONNECT including a `407`
  challenge, and the Telnet command form.
- `%host`/`%port` escaping is tested with hostile hostnames.
- Teardown is tested to assert no forwarded port survives a failed session.

## Suggested articles

- [The site manager](site-manager.md) — where these options are stored and exported.
- [Reconnection](reconnection.md) — how a two-hop connection is re-established.
- [SFTP](../protocols/sftp.md) — the transport a tunnel is built from.
- [Host key verification](../security-and-credentials/host-keys.md) — pinning the jump host.
