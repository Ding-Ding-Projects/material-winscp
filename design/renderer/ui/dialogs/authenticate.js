// ui/dialogs/authenticate.js — the authentication surface (Authenticate.dfm).
//
// Everything a session can stop and ask for before it will connect:
//
//   password / newPassword / passphrase / account   one field
//   keyboardInteractive / twoFactor                 N fields, N labels, echo
//                                                   flags honoured per prompt
//   hostKey                                         the fingerprint, and whether
//                                                   it is NEW or CHANGED
//   certificate                                     the TLS chain's identity
//
// Two rules govern this file and neither is negotiable:
//
//   1. A CHANGED host key must be impossible to mistake for a new one. A new
//      key is an unremarkable first meeting; a changed key is the signature of
//      a machine-in-the-middle, and the two must not share a look, a colour, a
//      default button or a word. The changed case therefore gets its own
//      banner, its own heading, both fingerprints side by side with the stored
//      one struck through, a default of REJECT, and a second confirmation
//      before the new key can be stored.
//
//   2. Accept-once and accept-and-store are DISTINCT choices, never one button
//      with a checkbox that a user can miss. "Trust this machine for the next
//      ten minutes" and "trust it until I delete the entry" are different
//      decisions with different consequences.
//
// Secrets never leave this module except through session.answerPrompt: nothing
// is logged, put in a title, announced, or written to the store.

import {
  h, icon, uid, appearanceTarget, openModal, layer, focusMemory, copyText, announce,
} from '../../dom.js';
import { bus, session } from '../../state.js';
import { t, bindText } from '../../i18n.js';
import { notify } from '../notifications.js';
import {
  defineStrings, injectTransferStyles, bridge, onMainEvent, transferPref, setTransferPref,
} from '../queue.js';
import { messageDialog } from './messagedlg.js';

defineStrings({
  txAuTitle: ['Authentication', '認證'],
  txAuPasswordTitle: ['Password required', '要密碼'],
  txAuPassphraseTitle: ['Key passphrase required', '要密鑰口令'],
  txAuNewPasswordTitle: ['The server wants a new password', '伺服器要你改新密碼'],
  txAuAccountTitle: ['Account required', '要帳戶名'],
  txAuKbdTitle: ['Server challenge', '伺服器提問'],
  txAu2faTitle: ['Two-factor authentication', '雙重認證'],
  txAuFor: ['{0} at {1}', '{1} 上面嘅 {0}'],
  txAuRememberSession: ['Remember for this session only', '淨係呢個工作階段記住'],
  txAuRememberStored: ['Change the stored password for this site to this one', '將呢個站點儲存嘅密碼改做呢個'],
  txAuCancelled: ['The server withdrew the question before it was answered.', '伺服器喺你答之前就收返條問題。'],
  txAuRefused: ['The prompt was cancelled, so the session did not connect.', '提示取消咗，所以冇連到線。'],
  txAuNoBridge: ['This window cannot reach the session manager, so the answer cannot be delivered.', '呢個視窗連唔到工作階段管理員，所以答案送唔到。'],
  txAuLogTitle: ['Authentication log', '認證記錄'],
  txAuLogEmpty: ['No session log lines yet.', '暫時未有工作階段記錄。'],

  txHkNewTitle: ['This server has not been seen before', '未見過呢個伺服器'],
  txHkNewBody: ['There is no stored host key for {0}. Check the fingerprint below against one you obtained from the server’s administrator before you continue.', '{0} 冇儲存過主機密鑰。繼續之前，同管理員俾你嘅指紋核對下面呢個。'],
  txHkChangedTitle: ['WARNING — THE HOST KEY HAS CHANGED', '警告——主機密鑰變咗'],
  txHkChangedBody: [[
    'The key {0} presented does not match the key stored for it. This happens when a server is rebuilt or its key is rotated — and it is also exactly what a machine-in-the-middle attack looks like. Do not continue until you have confirmed the new fingerprint with whoever runs the server.',
    'The key {0} presented is not the key stored for it. A rebuilt or rotated server does this — so does a machine-in-the-middle. Confirm the new fingerprint with whoever runs the server before continuing.',
    'The key {0} showed up with is NOT the one on file. Could be an honest rebuild. Could be someone sitting in the middle of your connection. Check with whoever runs the server before you go any further.',
    'The key {0} presented is not the key on file for it. A rebuilt server explains this innocently; so does somebody quietly sitting between you and it. Confirm the new fingerprint with the server’s owner before you continue.',
    'The key {0} just waved at you is NOT the one on file. Maybe the server had a nice honest rebuild. Maybe somebody is sitting in the middle of your connection wearing the server’s hat. Go ask whoever runs it, in person if you can, before you go one step further.'], [
    '{0} 俾嘅密鑰同儲存嗰個唔一樣。伺服器重裝或者換密鑰會咁，但中間人攻擊都係一模一樣咁樣。搵返管理員確認新指紋先好繼續。',
    '{0} 俾嘅密鑰唔係儲存嗰個。重裝伺服器會咁，中間人攻擊都會咁。搵管理員確認咗新指紋先繼續。',
    '{0} 攞出嚟嗰條密鑰唔係檔案入面嗰條。可能真係重裝過，都可能有人坐咗喺你條線中間。行多一步之前，去問清楚管理員。',
    '{0} 俾嘅密鑰唔係記錄入面嗰條。伺服器重裝可以好無辜咁解釋到，但有人靜靜雞坐咗喺你同佢中間都一樣解釋到。搵伺服器主人確認新指紋先好繼續。',
    '{0} 啱啱同你揮手嗰條密鑰唔係記錄入面嗰條。可能真係老老實實重裝過，又可能有人戴住伺服器頂帽坐咗喺你條線中間。行多一步之前，最好親自去問返管理員。']],
  txHkStored: ['Fingerprint stored previously', '之前儲存嘅指紋'],
  txHkPresented: ['Fingerprint the server presented now', '伺服器而家俾嘅指紋'],
  txHkFingerprint: ['SHA-256 fingerprint', 'SHA-256 指紋'],
  txHkMd5: ['MD5 fingerprint', 'MD5 指紋'],
  txHkAlgorithm: ['Key algorithm', '密鑰演算法'],
  txHkLength: ['Key size', '密鑰長度'],
  txHkBits: ['{0} bits', '{0} 位元'],
  txHkAcceptOnce: ['Connect this once', '淨係今次連'],
  txHkAcceptOnceHint: ['The key is used for this connection only and nothing is stored. You will be asked again next time.', '呢條密鑰淨係今次用，唔會儲存。下次會再問你。'],
  txHkAcceptStore: ['Trust and store the key', '信任並記住條密鑰'],
  txHkAcceptStoreHint: ['The key is stored and this question is not asked again until the key changes.', '條密鑰會儲存低，除非佢再變，否則唔會再問。'],
  txHkReject: ['Reject and do not connect', '拒絕，唔連'],
  txHkConfirmReplace: ['Replace the stored key for {0} with the new one?', '要用新嗰條換走 {0} 儲存嘅密鑰？'],
  txHkConfirmReplaceDetail: ['Do this only after confirming the new fingerprint with the person who runs the server. Once stored, the changed key will be accepted silently.', '確認咗新指紋先好做。一儲存咗，之後呢條變咗嘅密鑰會靜靜雞照收。'],
  txHkAcceptedOnce: ['The host key for {0} was accepted for this connection only.', '{0} 嘅主機密鑰淨係今次接受咗。'],
  txHkAcceptedStored: ['The host key for {0} was accepted and stored.', '{0} 嘅主機密鑰接受咗，仲儲存埋。'],
  txHkRejected: ['The host key for {0} was rejected. The session did not connect.', '拒絕咗 {0} 嘅主機密鑰，所以冇連到線。'],
  txHkCopy: ['Copy the fingerprint', '複製指紋'],

  txCertTitle: ['The TLS certificate could not be verified', 'TLS 憑證核對唔到'],
  txCertBody: ['The certificate {0} presented was not accepted by the system trust store. What is wrong with it is listed below.', '{0} 俾嘅憑證，系統信任庫唔收。下面列咗佢有咩問題。'],
  txCertSubject: ['Issued to', '發俾'],
  txCertIssuer: ['Issued by', '邊個發'],
  txCertValidFrom: ['Valid from', '生效日'],
  txCertValidTo: ['Valid until', '到期日'],
  txCertSha256: ['SHA-256 fingerprint', 'SHA-256 指紋'],
  txCertSha1: ['SHA-1 fingerprint', 'SHA-1 指紋'],
  txCertProblems: ['Problems found', '搵到嘅問題'],
  txCertAcceptOnce: ['Accept this once', '淨係今次接受'],
  txCertAcceptStore: ['Accept and store', '接受並記住'],
  txCertRejected: ['The certificate for {0} was rejected.', '拒絕咗 {0} 嘅憑證。'],

  txBannerTitle: ['Message from {0}', '{0} 嘅訊息'],
  txBannerShow: ['Read it', '睇下'],
  txBannerNever: ['Never show this message again', '唔好再顯示呢個訊息'],
  txBannerHidden: ['Messages from {0} are hidden from now on.', '由而家開始唔會顯示 {0} 嘅訊息。'],
});

/* ================================================================== */
/* delivering an answer                                                */
/* ================================================================== */

const openPrompts = new Map();     // promptId -> { close }

/** Read-only view of the main-process log while authentication is pending. */
function authenticationLog(sessionId) {
  const list = h('div', { class: 'tx-au-log', role: 'log', 'aria-live': 'polite' });
  let lastSeq = 0;
  let destroyed = false;
  const render = (records) => {
    if (destroyed) return;
    for (const record of records || []) {
      if (!record || typeof record.seq !== 'number' || record.seq <= lastSeq) continue;
      lastSeq = record.seq;
      list.appendChild(h('div', { class: 'tx-au-log-line' }, String(record.text || record.message || '')));
    }
    if (!list.childNodes.length) list.appendChild(h('span', { class: 'muted' }, t('txAuLogEmpty')));
    while (list.children.length > 200) list.firstElementChild.remove();
  };
  const off = onMainEvent('event:log', (payload) => {
    if (payload?.sessionId === sessionId) render([payload.line]);
  });
  if (sessionId) {
    const b = bridge();
    Promise.resolve(b?.session?.log?.(sessionId, 0)).then((res) => {
      const value = unwrapSync(res);
      render(value?.lines || []);
    }).catch(() => { /* the authentication prompt remains usable without a log */ });
  } else render([]);
  return { element: h('div', { class: 'stack' }, h('span', { class: 'tx-pg-stat-label' }, t('txAuLogTitle')), list), destroy() { destroyed = true; off(); } };
}

function unwrapSync(res) {
  if (res == null) return null;
  if (typeof res === 'object' && 'ok' in res) {
    if (res.ok) return res.value;
    throw new Error((res.error && res.error.message) || 'The session manager refused the answer.');
  }
  return res;
}

/**
 * Send the answer. A null answer is a refusal, which is what every path that is
 * not an explicit accept resolves to — there is deliberately no default yes.
 *
 * `onAnswer` lets a caller route the reply somewhere other than
 * session:answerPrompt — ui/queue.js uses it for a credential the QUEUE asked
 * for mid-transfer, which is answered through queue:answerPrompt instead.
 */
async function deliver(request, answer) {
  const { sessionId, promptId, onAnswer } = request;
  if (typeof onAnswer === 'function') {
    try { await onAnswer(answer); return true; }
    catch (err) { notify.error(t('txAuTitle'), err.message); return false; }
  }
  const b = bridge();
  if (!b?.session?.answerPrompt) {
    notify.error(t('txAuTitle'), t('txAuNoBridge'));
    return false;
  }
  try {
    unwrapSync(await b.session.answerPrompt(sessionId, promptId, answer));
    return true;
  } catch (err) {
    notify.error(t('txAuTitle'), err.message);
    return false;
  }
}

/* ================================================================== */
/* credential prompts                                                  */
/* ================================================================== */

const CREDENTIAL_TITLES = {
  password: 'txAuPasswordTitle',
  newPassword: 'txAuNewPasswordTitle',
  passphrase: 'txAuPassphraseTitle',
  account: 'txAuAccountTitle',
  keyboardInteractive: 'txAuKbdTitle',
  twoFactor: 'txAu2faTitle',
};

/** True for the kinds whose fields are secrets by default. */
export function isSecretKind(kind) {
  return kind !== 'account';
}

/**
 * Build the field list for a credential prompt. `echo` from the server decides
 * whether a field is visible: a keyboard-interactive challenge may legitimately
 * ask for something that is not a secret (a token serial, a user name), and
 * masking it would only make it harder to type correctly.
 */
export function credentialFields(payload = {}, kind = 'password') {
  const prompts = Array.isArray(payload.prompts) && payload.prompts.length
    ? payload.prompts
    : [{ text: 'Password:', echo: false }];
  return prompts.map((p, i) => ({
    index: i,
    text: String(p.text || '').replace(/&/g, ''),
    secret: !p.echo && isSecretKind(kind),
  }));
}

function openCredentialDialog(request) {
  const { promptId, kind, payload } = request;
  const fields = credentialFields(payload, kind);
  const inputs = [];
  let remember = false;

  const rows = fields.map((f) => {
    const id = uid('tx-au-f');
    const input = h('input', {
      type: f.secret ? 'password' : 'text',
      class: 'field-input', id,
      autocomplete: f.secret ? 'current-password' : 'username',
      spellcheck: 'false',
      autocapitalize: 'off',
    });
    inputs.push(input);
    return h('label', { class: 'field tx-au-prompt', for: id },
      h('span', { class: 'field-label' }, f.text || t('password')),
      input);
  });

  let rememberRow = null;
  if (payload?.canRemember) {
    const id = uid('tx-au-rem');
    const cb = h('input', { type: 'checkbox', id, onchange: () => { remember = cb.checked; } });
    rememberRow = h('label', { class: 'check', for: id }, cb,
      h('span', {}, kind === 'passphrase' || kind === 'password' ? t('txAuRememberStored') : t('txAuRememberSession')));
  }

  const log = authenticationLog(request.sessionId);
  const body = h('div', { class: 'stack' },
    h('div', { class: 'tx-au-kv' },
      h('span', {}, t('userName')), h('span', {}, payload?.userName || '—'),
      h('span', {}, t('hostName')), h('span', {}, payload?.hostPort || '—')),
    payload?.instructions ? h('pre', { class: 'tx-au-instructions' }, String(payload.instructions)) : null,
    ...rows,
    rememberRow,
    log.element);

  let answered = false;
  let submitting = false;

  async function submit(close) {
    if (answered || submitting) return;
    submitting = true;
    const ok = await deliver(request, { results: inputs.map((i) => i.value), remember });
    if (!ok) {
      // Keep the prompt open and the user's typed answer available for a retry
      // when the bridge is temporarily unavailable. It is not an answer until
      // the session manager confirms delivery.
      submitting = false;
      return;
    }
    answered = true;
    for (const input of inputs) input.value = '';
    close?.('action');
    announce(t('authenticating'));
  }

  const handle = openModal({
    title: t(CREDENTIAL_TITLES[kind] || 'txAuTitle'),
    width: 520,
    dismissOnScrim: false,
    content: body,
    onClose: (reason) => {
      log.destroy();
      openPrompts.delete(promptId);
      for (const input of inputs) input.value = '';
      if (answered || reason === 'prompt-cancelled') return;
      answered = true;
      // Closing without answering is a refusal, and it is reported as one.
      deliver(request, null).then(() => notify.warning(t('txAuTitle'), t('txAuRefused')));
    },
    actions: [
      { label: t('cancel'), kind: 'text', onSelect: () => submitting ? true : undefined },
      {
        label: t('ok'),
        kind: 'filled',
        autofocus: false,
        onSelect: (close) => {
          // The values go straight across the bridge; they are never stored in
          // a variable that outlives this call, logged, or announced.
          void submit(close);
          return true;
        },
      },
    ],
  });

  // Enter in any field submits, as it does in the original.
  for (const input of inputs) {
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      void submit((reason) => handle.close(reason));
    });
  }
  requestAnimationFrame(() => inputs[0]?.focus());
  if (promptId) openPrompts.set(promptId, handle);
  return handle;
}

/* ================================================================== */
/* host key verification                                               */
/* ================================================================== */

function fingerprintBlock(labelKey, value, extraClass) {
  const box = h('div', { class: 'tx-au-fingerprint mono' }, value || '—');
  const copy = h('button', {
    type: 'button', class: 'btn-text',
    onclick: () => copyText(String(value || '')).then((ok) => ok && notify.success(t('copiedClip'), t('txHkFingerprint'))),
  }, icon('content_copy', 15), h('span', {}, t('txHkCopy')));
  const wrap = h('div', { class: `stack ${extraClass || ''}`, style: { gap: '4px' } },
    h('span', { class: 'tx-pg-stat-label' }, t(labelKey)), box, copy);
  appearanceTarget(wrap, `auth-fingerprint-${labelKey}`, `Fingerprint: ${labelKey}`);
  return wrap;
}

function openHostKeyDialog(request) {
  const { promptId, payload } = request;
  const changed = !!payload?.changed;
  const hostPort = payload?.hostPort || '—';
  const presentedFingerprint = String(payload?.fingerprintSHA256 || '').trim();
  let answered = false;
  let submitting = false;

  const facts = h('div', { class: 'tx-au-kv' },
    h('span', {}, t('hostName')), h('span', { class: 'mono' }, hostPort),
    h('span', {}, t('txHkAlgorithm')), h('span', { class: 'mono' }, payload?.algorithm || '—'),
    h('span', {}, t('txHkLength')), h('span', { class: 'mono' }, payload?.keyLength ? t('txHkBits', payload.keyLength) : '—'),
    h('span', {}, t('txHkMd5')), h('span', { class: 'mono' }, payload?.fingerprintMD5 || '—'));

  const banner = changed
    ? h('div', { class: 'tx-au-banner-changed' },
      h('h3', {}, icon('warning', 22), h('span', {}, t('txHkChangedTitle'))),
      h('p', { class: 'prose' }, t('txHkChangedBody', hostPort)))
    : h('div', { class: 'tx-au-banner-new' },
      h('h3', {}, icon('shield_lock', 20), h('span', {}, t('txHkNewTitle'))),
      h('p', { class: 'prose' }, t('txHkNewBody', hostPort)));

  const log = authenticationLog(request.sessionId);
  const body = h('div', { class: `stack ${changed ? 'tx-au-changed' : ''}` },
    banner,
    changed
      ? h('div', { class: 'tx-au-expected' }, fingerprintBlock('txHkStored', payload?.expected))
      : null,
    fingerprintBlock(changed ? 'txHkPresented' : 'txHkFingerprint', presentedFingerprint),
    facts,
    h('p', { class: 'tx-sy-note' }, t('txHkAcceptOnceHint')),
    h('p', { class: 'tx-sy-note' }, t('txHkAcceptStoreHint')),
    log.element);

  function accept(remember, close) {
    if (answered || submitting) return;
    // A missing fingerprint is an incomplete verification result, never a
    // reason to let the user approve a key that the dialog cannot identify.
    if (!presentedFingerprint) {
      notify.error(t('hostKeyTitle'), t('txHkRejected', hostPort));
      return;
    }
    submitting = true;
    deliver(request, { accept: true, remember })
      .then((ok) => {
        if (!ok) { submitting = false; return; }
        answered = true;
        close?.('action');
        notify.success(t('hostKeyTitle'),
          remember ? t('txHkAcceptedStored', hostPort) : t('txHkAcceptedOnce', hostPort));
      });
  }

  const handle = openModal({
    title: t('hostKeyTitle'),
    width: 640,
    dismissOnScrim: false,
    content: body,
    onClose: (reason) => {
      log.destroy();
      openPrompts.delete(promptId);
      if (answered || reason === 'prompt-cancelled') return;
      answered = true;
      deliver(request, { accept: false })
        .then(() => notify.warning(t('hostKeyTitle'), t('txHkRejected', hostPort)));
    },
    actions: [
      // Reject is first AND focused for every untrusted key: the safe answer
      // must be the one a reflexive Enter or Escape produces.
      { label: t('txHkReject'), kind: changed ? 'danger' : 'text', autofocus: true },
      { label: t('txHkAcceptOnce'), kind: 'text', onSelect: (close) => { accept(false, close); return true; } },
      {
        label: t('txHkAcceptStore'),
        kind: 'filled',
        autofocus: false,
        onSelect: (close) => {
          if (!changed) { accept(true, close); return true; }
          // Storing a CHANGED key overwrites the evidence that it changed, so
          // it takes a second, explicit yes.
          messageDialog({
            title: t('hostKeyTitle'),
            kind: 'warning',
            message: t('txHkConfirmReplace', hostPort),
            detail: t('txHkConfirmReplaceDetail'),
            buttons: 'yesNo',
            danger: true,
            defaultAnswer: 'no',
          }).then((r) => { if (r.answer === 'yes') accept(true, close); });
          return true;
        },
      },
    ],
  });
  if (promptId) openPrompts.set(promptId, handle);
  return handle;
}

/* ================================================================== */
/* TLS certificate verification                                        */
/* ================================================================== */

function openCertificateDialog(request) {
  const { promptId, payload } = request;
  const hostPort = payload?.hostPort || '—';
  const presentedFingerprint = String(payload?.fingerprintSHA256 || '').trim();
  let answered = false;
  let submitting = false;
  const errors = Array.isArray(payload?.errors) ? payload.errors : [];

  const log = authenticationLog(request.sessionId);
  const body = h('div', { class: 'stack' },
    h('div', { class: 'tx-au-banner-changed' },
      h('h3', {}, icon('warning', 20), h('span', {}, t('txCertTitle'))),
      h('p', { class: 'prose' }, t('txCertBody', hostPort))),
    errors.length
      ? h('div', { class: 'stack', style: { gap: '4px' } },
        h('span', { class: 'tx-pg-stat-label' }, t('txCertProblems')),
        h('ul', { class: 'tx-au-errors' }, ...errors.map((e) => h('li', {}, String(e)))))
      : null,
    h('div', { class: 'tx-au-kv' },
      h('span', {}, t('txCertSubject')), h('span', { class: 'mono' }, payload?.subject || '—'),
      h('span', {}, t('txCertIssuer')), h('span', { class: 'mono' }, payload?.issuer || '—'),
      h('span', {}, t('txCertValidFrom')), h('span', { class: 'mono' }, payload?.validFrom || '—'),
      h('span', {}, t('txCertValidTo')), h('span', { class: 'mono' }, payload?.validTo || '—')),
    fingerprintBlock('txCertSha256', presentedFingerprint),
    h('div', { class: 'tx-au-kv' },
      h('span', {}, t('txCertSha1')), h('span', { class: 'mono' }, payload?.fingerprintSHA1 || '—')),
    payload?.pem
      ? h('details', { class: 'tx-md-details' },
        h('summary', {}, t('txMsgMore')),
        h('pre', { class: 'tx-md-detail' }, String(payload.pem)))
      : null,
    log.element);

  function accept(remember, close) {
    if (answered || submitting) return;
    if (!presentedFingerprint) {
      notify.error(t('txCertTitle'), t('txCertRejected', hostPort));
      return;
    }
    submitting = true;
    deliver(request, { accept: true, remember })
      .then((ok) => {
        if (!ok) { submitting = false; return; }
        answered = true;
        close?.('action');
        notify.success(t('txCertTitle'), hostPort);
      });
  }

  const handle = openModal({
    title: t('txCertTitle'),
    width: 660,
    dismissOnScrim: false,
    content: body,
    onClose: (reason) => {
      log.destroy();
      openPrompts.delete(promptId);
      if (answered || reason === 'prompt-cancelled') return;
      answered = true;
      deliver(request, { accept: false })
        .then(() => notify.warning(t('txCertTitle'), t('txCertRejected', hostPort)));
    },
    actions: [
      { label: t('txHkReject'), kind: 'danger', autofocus: true },
      { label: t('txCertAcceptOnce'), kind: 'text', onSelect: (close) => { accept(false, close); return true; } },
      { label: t('txCertAcceptStore'), kind: 'filled', onSelect: (close) => { accept(true, close); return true; } },
    ],
  });
  if (promptId) openPrompts.set(promptId, handle);
  return handle;
}

/* ================================================================== */
/* the entry point                                                     */
/* ================================================================== */

/**
 * openAuthenticationDialog({ sessionId, promptId, kind, payload, onAnswer })
 *
 * `onAnswer(answer)` replaces the session:answerPrompt route — ui/queue.js
 * passes one so a credential the transfer queue asked for is answered through
 * queue:answerPrompt instead. Returns the handle, or null for a kind this
 * dialog does not own.
 */
export function openAuthenticationDialog(request = {}) {
  injectTransferStyles();
  const { kind } = request;
  if (request.promptId && openPrompts.has(request.promptId)) return openPrompts.get(request.promptId);
  if (kind === 'hostKey') return openHostKeyDialog(request);
  if (kind === 'certificate') return openCertificateDialog(request);
  if (CREDENTIAL_TITLES[kind]) return openCredentialDialog(request);
  return null;
}

/* ---- server banners ---- */

let bannerWindow = null;

/** The banner is informational, so it never blocks; it toasts and offers to open. */
export function showSessionBanner({ sessionId, hostPort, text }) {
  const key = `banners.${String(hostPort || sessionId || 'unknown').replace(/\./g, '_')}`;
  if (transferPref(key, false) === true) return;
  notify.info(t('txBannerTitle', hostPort || sessionId || ''), String(text || '').split('\n')[0], {
    actions: [{ label: t('txBannerShow'), onSelect: () => openBannerWindow({ key, hostPort, text }) }],
  });
}

function openBannerWindow({ key, hostPort, text }) {
  injectTransferStyles();
  if (bannerWindow) bannerWindow.close();
  const restore = focusMemory();
  const titleId = uid('tx-banner');
  const cbId = uid('tx-banner-cb');
  const cb = h('input', {
    type: 'checkbox',
    id: cbId,
    onchange: () => {
      setTransferPref(key, cb.checked, `Banner visibility for ${hostPort}`);
      if (cb.checked) notify.info(t('txBannerTitle', hostPort || ''), t('txBannerHidden', hostPort || ''));
    },
  });
  const closeBtn = h('button', { type: 'button', class: 'icon-btn', onclick: () => close() }, icon('close', 18));
  bindText(closeBtn, 'close', { attr: 'aria-label' });
  const root = h('div', {
    class: 'tx-pg-window surface-3', role: 'dialog', 'aria-modal': 'false',
    'aria-labelledby': titleId, tabindex: '-1',
  },
  h('header', { class: 'nc-head' },
    icon('mark_email', 18),
    h('span', { class: 'nc-head-title', id: titleId }, t('txBannerTitle', hostPort || '')),
    closeBtn),
  h('div', { class: 'tx-pg' },
    h('pre', { class: 'tx-au-instructions' }, String(text || '')),
    h('label', { class: 'check', for: cbId }, cb, h('span', {}, t('txBannerNever')))));
  appearanceTarget(root, 'session-banner', 'Server banner');
  layer('popover').appendChild(root);
  root.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
  function close() { root.remove(); bannerWindow = null; restore(); }
  bannerWindow = { element: root, close, focus: () => root.focus() };
  requestAnimationFrame(() => root.focus());
  return bannerWindow;
}

/* ================================================================== */
/* wiring                                                              */
/* ================================================================== */

onMainEvent('event:prompt', (payload) => {
  if (!payload || typeof payload.promptId !== 'string') return;   // queue queries are ui/queue.js's
  if (payload.payload?.source === 'queue') return;
  openAuthenticationDialog({
    sessionId: payload.sessionId,
    promptId: payload.promptId,
    kind: payload.kind,
    payload: payload.payload || {},
  });
});

onMainEvent('event:prompt-cancelled', (payload) => {
  const handle = openPrompts.get(payload?.promptId);
  if (!handle) return;
  openPrompts.delete(payload.promptId);
  // The session already resolved this prompt. Tag the close so the modal's
  // normal unanswered-close handler does not send a second refusal.
  handle.close('prompt-cancelled');
  notify.info(t('txAuTitle'), t('txAuCancelled'));
});

onMainEvent('event:session', (payload) => {
  if (payload?.type !== 'banner') return;
  showSessionBanner({ sessionId: payload.sessionId, hostPort: payload.hostPort, text: payload.text });
});

// Republished so a session panel can react to the same events.
bus.on('session:prompt', (payload) => openAuthenticationDialog(payload || {}));

// Not in the shell's dialog registry: openDialog() builds one modal from the
// returned spec, and this module opens a different modal per prompt kind and
// must own it so an unanswered close still delivers a refusal. Callers use
// openAuthenticationDialog(), or simply let the `event:prompt` wiring above do
// its work — which is how every real session reaches it.

// The active session id is published so a dialog opened from a menu knows which
// session it belongs to without every caller threading it through.
bus.on('session:activated', (payload) => session.set('activeSessionId', payload?.sessionId || payload?.id || null));
