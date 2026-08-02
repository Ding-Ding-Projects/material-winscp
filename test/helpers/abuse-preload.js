// abuse-preload.js — a HOSTILE renderer's preload, for the IPC contract tests.
//
// design/preload/preload.js deliberately exposes no generic `invoke(channel)`,
// so that the set of things a renderer can ask for is exactly the list in that
// file. That refusal is worth having — and it is also why proving the handler
// table survives arbitrary input needs a renderer that ignores it.
//
// This preload is that renderer. It is never shipped and never loaded by the
// application; it exists so the suite can send any channel any argument and
// assert what ipc.js promises:
//
//   * every reply is the { ok } envelope;
//   * no handler ever REJECTS across the bridge — the test can tell, because
//     this wrapper reports the rejection instead of swallowing it into an
//     envelope the way the real preload does.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__abuse', {
  /**
   * Unlike the real preload's `call()`, this does NOT normalize a rejection
   * into an envelope. `threw: true` in the reply means a handler threw across
   * the process boundary, which is the failure the contract forbids.
   */
  invoke(channel, ...args) {
    return ipcRenderer.invoke(channel, ...args).then(
      (reply) => ({ threw: false, reply }),
      (e) => ({ threw: true, message: e && e.message ? e.message : String(e) }),
    );
  },
});
