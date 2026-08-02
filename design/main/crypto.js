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

let safeStorage = null;
try { ({ safeStorage } = require('electron')); } catch { /* tests run headless */ }

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

/** Session-scoped master key; null until the master password is entered. */
let masterKey = null;

function hasMaster() { return masterKey !== null; }
function lockMaster() { masterKey = null; }

function deriveKey(password, saltB64) {
  const salt = Buffer.from(saltB64, 'base64');
  return crypto.scryptSync(Buffer.from(password, 'utf8'), salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 128 * SCRYPT.N * SCRYPT.r * 2,
  });
}

/** Create the verifier blob stored in config so a master password can be checked. */
function makeVerifier(password) {
  const salt = crypto.randomBytes(16);
  const key = deriveKey(password, salt.toString('base64'));
  const probe = encryptWithKey(key, 'winscp-material-master-probe');
  return { salt: salt.toString('base64'), probe };
}

/** Verify and, on success, unlock the session master key. */
function unlockMaster(password, verifier) {
  if (!verifier || !verifier.salt) return false;
  const key = deriveKey(password, verifier.salt);
  try {
    if (decryptWithKey(key, verifier.probe) !== 'winscp-material-master-probe') return false;
  } catch { return false; }
  masterKey = key;
  return true;
}

function encryptWithKey(key, plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(Buffer.from(plain, 'utf8')), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

function decryptWithKey(key, blob) {
  const buf = Buffer.from(blob, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
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
  return crypto.scryptSync(Buffer.from(passphrase, 'utf8'), Buffer.from(salt), 32, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 128 * SCRYPT.N * SCRYPT.r * 2,
  });
}

module.exports = {
  protect, unprotect, needsMaster,
  hasMaster, lockMaster, unlockMaster, makeVerifier,
  encryptWithKey, decryptWithKey, deriveKey, fileKeyFromPassphrase,
  isOsEncryptionAvailable: () => !!(safeStorage && safeStorage.isEncryptionAvailable()),
};
