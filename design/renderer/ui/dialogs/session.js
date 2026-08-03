// SessionDialog lifecycle seam.
//
// This module is deliberately DOM-free.  The dialog can use these helpers
// without retaining credentials or allowing a late reconnect reply to revive
// a session that the user has already closed.

const SECRET_FIELDS = new Set([
  'password', 'passphrase', 'newPassword', 'proxyPassword', 'tunnelPassword',
  'tunnelPassphrase', 'encryptKey',
]);

export function validateSessionEndpoint(input = {}) {
  const protocol = String(input.protocol || 'sftp').toLowerCase();
  if (protocol === 'local') {
    if (!String(input.localDirectory || '').trim()) {
      return { field: 'localDirectory', message: 'Choose a local directory.' };
    }
    return null;
  }
  const hostName = String(input.hostName || '').trim();
  if (!hostName) return { field: 'hostName', message: 'Enter a host name.' };
  const port = Number(input.portNumber);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { field: 'portNumber', message: 'Enter a port from 1 to 65535.' };
  }
  return null;
}

/** Return a request safe to keep in renderer state or attach to diagnostics. */
export function secretFreeSessionState(input = {}) {
  const output = {};
  for (const [key, value] of Object.entries(input)) {
    if (!SECRET_FIELDS.has(key)) output[key] = value;
  }
  return output;
}

/**
 * Make close/reconnect transitions single-owner and stale-reply safe.
 * `beginReconnect` returns a token; only its matching `finishReconnect`
 * callback can publish a connected state, and close invalidates all tokens.
 */
export function createSessionLifecycle(onState = () => {}) {
  let closed = false;
  let generation = 0;
  let reconnecting = false;
  return {
    beginReconnect() {
      if (closed || reconnecting) return null;
      reconnecting = true;
      const token = ++generation;
      onState({ status: 'reconnecting' });
      return token;
    },
    finishReconnect(token, ok, error = null) {
      if (closed || token !== generation || !reconnecting) return false;
      reconnecting = false;
      onState(ok ? { status: 'connected' } : { status: 'disconnected', error: String(error || 'Reconnect failed') });
      return true;
    },
    close() {
      if (closed) return false;
      closed = true;
      reconnecting = false;
      generation += 1;
      onState({ status: 'closed' });
      return true;
    },
    get closed() { return closed; },
  };
}
