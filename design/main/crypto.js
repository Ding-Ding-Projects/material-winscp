// crypto.js — credential protection.
//
// Two layers, mirroring WinSCP's model:
//   * Without a master password, secrets are protected by the OS keychain
//     (Electron safeStorage / DPAPI on Windows) so a stolen config file alone
//     is not enough.
//   * With a master password, secrets are additionally wrapped with a key
//     derived from that password (scrypt), so the OS account alone is not
//     enough either.
//
// The plaintext of a secret never reaches disk and is never logged.
'use strict';
const crypto = require('crypto');
const { TextDecoder } = require('util');

let safeStorage = null;
try { ({ safeStorage } = require('electron')); } catch { /* tests run headless */ }

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
const MASTER_PROBE = 'winscp-material-master-probe';
const AES_GCM_IV_LENGTH = 12;
const AES_GCM_TAG_LENGTH = 16;
const AES_GCM_OVERHEAD = AES_GCM_IV_LENGTH + AES_GCM_TAG_LENGTH;

/** Session-scoped master key; null until the master password is entered. */
let masterKey = null;

function hasMaster() { return masterKey !== null; }

/** Clear key material before dropping the last JavaScript reference to it. */
function wipe(buffer) {
  if (Buffer.isBuffer(buffer)) buffer.fill(0);
}

function lockMaster() {
  wipe(masterKey);
  masterKey = null;
}

function decodeSalt(saltB64) {
  if (typeof saltB64 !== 'string' || !/^[A-Za-z0-9+/]{22}==$/u.test(saltB64)) {
    throw new Error('Master-password verifier has an invalid salt.');
  }
  const salt = Buffer.from(saltB64, 'base64');
  if (salt.length !== 16) throw new Error('Master-password verifier has an invalid salt.');
  return salt;
}

function deriveKey(password, saltB64) {
  const salt = decodeSalt(saltB64);
  const passwordBytes = Buffer.from(String(password), 'utf8');
  try {
    return crypto.scryptSync(passwordBytes, salt, SCRYPT.keylen, {
      N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 128 * SCRYPT.N * SCRYPT.r * 2,
    });
  } finally {
    wipe(passwordBytes);
    wipe(salt);
  }
}

/** Create the verifier blob stored in config so a master password can be checked. */
function makeVerifier(password) {
  const salt = crypto.randomBytes(16);
  const key = deriveKey(password, salt.toString('base64'));
  try {
    return { salt: salt.toString('base64'), probe: encryptWithKey(key, MASTER_PROBE) };
  } finally {
    wipe(key);
    wipe(salt);
  }
}

/** Verify and, on success, unlock the session master key. */
function unlockMaster(password, verifier) {
  if (!verifier || !verifier.salt) return false;
  let key;
  try {
    key = deriveKey(password, verifier.salt);
  } catch {
    return false;
  }
  let accepted = false;
  try {
    accepted = decryptWithKey(key, verifier.probe) === MASTER_PROBE;
  } catch { accepted = false; }
  if (!accepted) {
    wipe(key);
    return false;
  }
  wipe(masterKey);
  masterKey = key;
  return true;
}

function encryptWithKey(key, plain) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error('AES-GCM requires a 32-byte key.');
  }
  const input = Buffer.isBuffer(plain) ? Buffer.from(plain) : Buffer.from(String(plain), 'utf8');
  const iv = crypto.randomBytes(AES_GCM_IV_LENGTH);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  try {
    const ct = Buffer.concat([c.update(input), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
  } finally {
    wipe(input);
  }
}

function decryptWithKey(key, blob) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error('AES-GCM requires a 32-byte key.');
  }
  // Buffer.from(value, 'base64') silently ignores non-base64 characters and
  // accepts impossible padding. Reject those inputs before authentication so
  // damaged config cannot be normalized into a different ciphertext.
  if (typeof blob !== 'string' || blob.length === 0 || blob.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(blob)) {
    throw new Error('AES-GCM envelope is not valid base64.');
  }
  const buf = Buffer.from(blob, 'base64');
  if (buf.toString('base64') !== blob) throw new Error('AES-GCM envelope is not canonical base64.');
  if (buf.length < AES_GCM_OVERHEAD) throw new Error('AES-GCM envelope is truncated.');
  const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, AES_GCM_IV_LENGTH));
  d.setAuthTag(buf.subarray(AES_GCM_IV_LENGTH, AES_GCM_OVERHEAD));
  const plaintext = Buffer.concat([d.update(buf.subarray(AES_GCM_OVERHEAD)), d.final()]);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
  } catch {
    throw new Error('AES-GCM envelope contains invalid UTF-8.');
  } finally {
    wipe(plaintext);
  }
}

/**
 * Protect a secret for storage. Returns a tagged string so the format is
 * self-describing and can be migrated later.
 */
function protect(plain) {
  if (plain === undefined || plain === null || plain === '') return '';
  if (masterKey) return 'mp:' + encryptWithKey(masterKey, plain);
  if (safeStorage && safeStorage.isEncryptionAvailable()) {
    return 'os:' + safeStorage.encryptString(plain).toString('base64');
  }
  // No protection available: refuse to write a secret in clear rather than
  // pretending it was stored safely.
  return '';
}

/** Recover a protected secret. Returns '' when it cannot be unwrapped. */
function unprotect(stored) {
  if (!stored) return '';
  try {
    if (stored.startsWith('mp:')) {
      if (!masterKey) return '';
      return decryptWithKey(masterKey, stored.slice(3));
    }
    if (stored.startsWith('os:')) {
      if (!safeStorage || !safeStorage.isEncryptionAvailable()) return '';
      return safeStorage.decryptString(Buffer.from(stored.slice(3), 'base64'));
    }
  } catch { return ''; }
  return '';
}

/** True when a stored secret needs the master password to be readable. */
function needsMaster(stored) { return typeof stored === 'string' && stored.startsWith('mp:'); }

/** Available for the "encrypt files" site option (WinSCP file encryption). */
function fileKeyFromPassphrase(passphrase, salt) {
  const passwordBytes = Buffer.from(String(passphrase), 'utf8');
  const saltBytes = Buffer.from(salt);
  try {
    return crypto.scryptSync(passwordBytes, saltBytes, 32, {
      N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 128 * SCRYPT.N * SCRYPT.r * 2,
    });
  } finally {
    wipe(passwordBytes);
    wipe(saltBytes);
  }
}

module.exports = {
  protect, unprotect, needsMaster,
  hasMaster, lockMaster, unlockMaster, makeVerifier,
  encryptWithKey, decryptWithKey, deriveKey, fileKeyFromPassphrase,
  isOsEncryptionAvailable: () => !!(safeStorage && safeStorage.isEncryptionAvailable()),
};
