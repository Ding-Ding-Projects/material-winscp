// security.js — WinSCP's own security formats.
//
// Ported from core/Security.cpp (the stored-password obfuscation),
// core/Cryptography.cpp (the scramble table, the AES-256 password-manager
// primitives and TEncryption, WinSCP's at-rest file encryption) and the
// portable half of core/PuttyTools.h (key-file sniffing, fingerprints,
// checksums).
//
// ===========================================================================
// READ THIS BEFORE USING encryptPassword/decryptPassword FOR ANYTHING
// ===========================================================================
// `encryptPassword` and `decryptPassword` are NOT encryption. They are
// WinSCP's password *obfuscation*: a fixed XOR against a constant magic byte,
// hex-encoded, with random padding. The key is the site's own
// "username + hostname", which is stored in the same file, in clear, right
// next to the password. Anyone holding the configuration file can recover
// every password in it in microseconds. WinSCP has always documented this and
// so do we.
//
// They exist here for exactly one reason: INTEROPERABILITY. A site imported
// from a real WinSCP installation (WinSCP.ini, the registry export, a .netrc-
// style session URL) carries its password in this format, and an import that
// silently produced a site that cannot log in would be a broken import.
//
// This application's OWN storage never uses this format. Secrets we write go
// through design/main/crypto.js: the OS keychain, or AES-256-GCM under a
// scrypt key derived from the master password — and when neither is available,
// nothing is written at all.
// ===========================================================================
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const {
  FileBuffer, calculateCompoundVersion,
} = require('./filebuffer');

// ---------------------------------------------------------------------------
// core/Security.cpp — the "simple" password obfuscation
// ---------------------------------------------------------------------------

const PWALG_SIMPLE = 1;
const PWALG_SIMPLE_MAGIC = 0xA3;
const PWALG_SIMPLE_MAXLEN = 50;
const PWALG_SIMPLE_FLAG = 0xFF;

const PWALG_SIMPLE_INTERNAL = 0x00;
const PWALG_SIMPLE_EXTERNAL = 0x01;
const PWALG_SIMPLE_INTERNAL2 = 0x02;

/** PWALG_SIMPLE_STRING. Upper case only — WinSCP's Pos() is case sensitive. */
const PWALG_SIMPLE_STRING = '0123456789ABCDEF';

/**
 * SimpleEncryptChar: one byte becomes two upper-case hex characters of
 * (~byte) ^ 0xA3.
 */
function simpleEncryptChar(ch) {
  const b = ((~ch) ^ PWALG_SIMPLE_MAGIC) & 0xFF;
  return PWALG_SIMPLE_STRING[(b & 0xF0) >> 4] + PWALG_SIMPLE_STRING[b & 0x0F];
}

/**
 * SimpleDecryptNextChar: consume two characters off the front of `state.s` and
 * return the byte.
 *
 * The C++ uses Pos()-1, which is -1 for a character that is not a hex digit,
 * and then does signed arithmetic on it. That is reproduced exactly rather
 * than rejected, because a corrupted stored password must decode to the same
 * garbage WinSCP decodes it to — otherwise an imported site would appear to
 * work here and fail there, or vice versa.
 *
 * Running off the end of the string yields 0x00, exactly as the C++ does.
 */
function simpleDecryptNextChar(state) {
  if (state.s.length > 0) {
    const hi = PWALG_SIMPLE_STRING.indexOf(state.s[0]);
    // With one character left the C++ reads the string's NUL terminator, and
    // Pos() of that is 0, so the low nibble comes out as -1. Same here.
    const lo = state.s.length > 1 ? PWALG_SIMPLE_STRING.indexOf(state.s[1]) : -1;
    const result = (~(((hi << 4) + (lo << 0)) ^ PWALG_SIMPLE_MAGIC)) & 0xFF;
    state.s = state.s.slice(2);
    return result;
  }
  return 0x00;
}

/**
 * The key a site's stored password is obfuscated under, per
 * TSessionData::GetSessionPasswordEncryptionKey. It is the user name
 * concatenated with the host name — both of which sit unobfuscated in the same
 * configuration file. See the header comment.
 */
function sessionPasswordEncryptionKey(userName, hostName) {
  return String(userName || '') + String(hostName || '');
}

/**
 * EncryptPassword. Returns the hex-ish string WinSCP stores.
 *
 * The layout, in obfuscated bytes:
 *   [flag 0xFF][version][length ...][shift][shift random bytes][key+password]
 *   then random bytes until the whole thing is PWALG_SIMPLE_MAXLEN*2 characters.
 *
 * `rng(n)` is injectable so tests can pin the padding; production uses
 * crypto.randomInt, which is strictly better than the C++'s Randomize()/random()
 * and produces an identically-shaped blob.
 */
function encryptPassword(password, key, algorithm = PWALG_SIMPLE, rng = defaultRng) {
  void algorithm; // WinSCP ignores it too — there has only ever been one algorithm
  const keyBytes = Buffer.from(String(key || ''), 'utf8');
  const passBytes = Buffer.concat([keyBytes, Buffer.from(String(password || ''), 'utf8')]);

  let result = '';
  result += simpleEncryptChar(PWALG_SIMPLE_FLAG);
  const len = passBytes.length;
  if (len > 0xFF) {
    result += simpleEncryptChar(PWALG_SIMPLE_INTERNAL2);
    result += simpleEncryptChar((len >> 8) & 0xFF);
    result += simpleEncryptChar(len & 0xFF);
  } else {
    result += simpleEncryptChar(PWALG_SIMPLE_INTERNAL);
    result += simpleEncryptChar(len & 0xFF);
  }

  // Result.Length()/2 is the number of bytes emitted so far; +1 for the shift
  // byte itself.
  const dataLen = (result.length / 2) + 1 + len;
  const shift = dataLen < PWALG_SIMPLE_MAXLEN ? rng(PWALG_SIMPLE_MAXLEN - dataLen) : 0;
  result += simpleEncryptChar(shift & 0xFF);
  for (let i = 0; i < shift; i++) result += simpleEncryptChar(rng(256));
  for (let i = 0; i < passBytes.length; i++) result += simpleEncryptChar(passBytes[i]);
  while (result.length < PWALG_SIMPLE_MAXLEN * 2) result += simpleEncryptChar(rng(256));
  return result;
}

function defaultRng(n) {
  return n <= 0 ? 0 : crypto.randomInt(n);
}

/**
 * DecryptPassword. Returns the password, or '' when the embedded key does not
 * match the one supplied — which is WinSCP's way of saying "this password was
 * stored for a different user@host, do not use it". It is a refusal, not an
 * error: WinSCP prompts for the password instead of failing the connection.
 *
 * A blob with no 0xFF flag byte is the pre-flag legacy layout: the first byte
 * IS the length and no key is embedded, so no key check happens.
 */
function decryptPassword(password, key, algorithm = PWALG_SIMPLE) {
  void algorithm;
  const state = { s: String(password || '') };
  let length;
  const flag = simpleDecryptNextChar(state);
  if (flag === PWALG_SIMPLE_FLAG) {
    const version = simpleDecryptNextChar(state);
    if (version === PWALG_SIMPLE_INTERNAL) {
      length = simpleDecryptNextChar(state);
    } else if (version === PWALG_SIMPLE_INTERNAL2) {
      length = (simpleDecryptNextChar(state) << 8) + simpleDecryptNextChar(state);
    } else {
      length = -1;
    }
  } else {
    length = flag;
  }

  let result = Buffer.alloc(0);
  if (length >= 0) {
    // The shift byte is consumed here, then that many *bytes* (two characters
    // each) of random padding are skipped.
    const shift = simpleDecryptNextChar(state);
    state.s = state.s.slice(shift * 2);
    const bytes = Buffer.alloc(length);
    for (let i = 0; i < length; i++) bytes[i] = simpleDecryptNextChar(state);
    result = bytes;

    if (flag === PWALG_SIMPLE_FLAG) {
      const keyBytes = Buffer.from(String(key || ''), 'utf8');
      if (!result.subarray(0, keyBytes.length).equals(keyBytes)) {
        result = Buffer.alloc(0);
      } else {
        result = result.subarray(keyBytes.length);
      }
    }
  }
  return result.toString('utf8');
}

/** BytesToHex, upper case, no separator — WinSCP's default. */
function bytesToHex(bytes, upperCase = true, separator = '') {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const digits = upperCase ? '0123456789ABCDEF' : '0123456789abcdef';
  const parts = [];
  for (const b of buf) parts.push(digits[(b & 0xF0) >> 4] + digits[b & 0x0F]);
  return parts.join(separator);
}

/**
 * HexToBytes. Returns an empty buffer for an odd-length string or any
 * non-hex character — the C++ clears the whole result rather than decoding a
 * prefix, and callers depend on "empty means invalid".
 */
function hexToBytes(hex) {
  const s = String(hex || '');
  if (s.length % 2 !== 0) return Buffer.alloc(0);
  const digits = '0123456789ABCDEF';
  const out = Buffer.alloc(s.length / 2);
  for (let i = 0; i < s.length; i += 2) {
    const p1 = digits.indexOf(s[i].toUpperCase());
    const p2 = digits.indexOf(s[i + 1].toUpperCase());
    if (p1 < 0 || p2 < 0) return Buffer.alloc(0);
    out[i / 2] = p1 * 16 + p2;
  }
  return out;
}

/**
 * SetExternalEncryptedPassword. Marks a blob as "this password is held by an
 * external store" (Windows Credential Manager, or here the OS keychain via
 * crypto.js). Only the two header bytes are obfuscated; the payload is plain
 * hex, because it is already ciphertext from somewhere else.
 */
function setExternalEncryptedPassword(passwordBytes) {
  const bytes = Buffer.isBuffer(passwordBytes)
    ? passwordBytes : Buffer.from(String(passwordBytes), 'utf8');
  return simpleEncryptChar(PWALG_SIMPLE_FLAG) +
    simpleEncryptChar(PWALG_SIMPLE_EXTERNAL) +
    bytesToHex(bytes);
}

/**
 * GetExternalEncryptedPassword. Returns the payload bytes, or null when the
 * blob is not externally-stored — the caller then falls back to
 * decryptPassword.
 */
function getExternalEncryptedPassword(encrypted) {
  const state = { s: String(encrypted || '') };
  const ok = (simpleDecryptNextChar(state) === PWALG_SIMPLE_FLAG) &&
    (simpleDecryptNextChar(state) === PWALG_SIMPLE_EXTERNAL);
  if (!ok) return null;
  return hexToBytes(state.s);
}

// ---------------------------------------------------------------------------
// core/Cryptography.cpp — the scramble table
// ---------------------------------------------------------------------------

/**
 * SScrambleTable. A fixed permutation of 0..255 used by ScramblePassword,
 * which is what WinSCP uses for the password it hands to a child process
 * (/passwordsFromFiles, the scripting handoff) so it does not sit in a command
 * line in clear. Like the obfuscation above this is not encryption — the table
 * is a compile-time constant in a public source tree.
 */
const SCRAMBLE_TABLE = Uint8Array.from([
  0, 223, 235, 233, 240, 185, 88, 102, 22, 130, 27, 53, 79, 125, 66, 201,
  90, 71, 51, 60, 134, 104, 172, 244, 139, 84, 91, 12, 123, 155, 237, 151,
  192, 6, 87, 32, 211, 38, 149, 75, 164, 145, 52, 200, 224, 226, 156, 50,
  136, 190, 232, 63, 129, 209, 181, 120, 28, 99, 168, 94, 198, 40, 238, 112,
  55, 217, 124, 62, 227, 30, 36, 242, 208, 138, 174, 231, 26, 54, 214, 148,
  37, 157, 19, 137, 187, 111, 228, 39, 110, 17, 197, 229, 118, 246, 153, 80,
  21, 128, 69, 117, 234, 35, 58, 67, 92, 7, 132, 189, 5, 103, 10, 15,
  252, 195, 70, 147, 241, 202, 107, 49, 20, 251, 133, 76, 204, 73, 203, 135,
  184, 78, 194, 183, 1, 121, 109, 11, 143, 144, 171, 161, 48, 205, 245, 46,
  31, 72, 169, 131, 239, 160, 25, 207, 218, 146, 43, 140, 127, 255, 81, 98,
  42, 115, 173, 142, 114, 13, 2, 219, 57, 56, 24, 126, 3, 230, 47, 215,
  9, 44, 159, 33, 249, 18, 93, 95, 29, 113, 220, 89, 97, 182, 248, 64,
  68, 34, 4, 82, 74, 196, 213, 165, 179, 250, 108, 254, 59, 14, 236, 175,
  85, 199, 83, 106, 77, 178, 167, 225, 45, 247, 163, 158, 8, 221, 61, 191,
  119, 16, 253, 105, 186, 23, 170, 100, 216, 65, 162, 122, 150, 176, 154, 193,
  206, 222, 188, 152, 210, 243, 96, 41, 86, 180, 101, 177, 166, 141, 212, 116,
]);

/** CryptographyInitialize builds the inverse table once; so do we. */
const UNSCRAMBLE_TABLE = (() => {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) t[SCRAMBLE_TABLE[i]] = i;
  return t;
})();

function isDigitCode(c) { return c >= 0x30 && c <= 0x39; }

/**
 * ScramblePassword. The blob is padded to a multiple of 17 bytes, carries the
 * length as three decimal digits (least significant first) and is then run
 * through a running-sum substitution.
 *
 * The padding bytes must be 1..255 and must not be ASCII digits, because
 * unscrambling finds the length header by scanning forward to the first digit.
 * A digit in the padding would make the blob undecodable — that constraint is
 * load-bearing, not decoration.
 */
function scramblePassword(password, rng = defaultRng) {
  const utf = Buffer.from(String(password || ''), 'utf8');
  const len = utf.length;
  const padding = (Math.trunc((len + 3) / 17) * 17 + 17) - 3 - len;
  const buf = Buffer.alloc(padding + 3 + len);
  for (let i = 0; i < padding; i++) {
    // The C++ rejection-samples 1..255 until it draws a non-digit. Drawing
    // straight from the 245 acceptable values gives the identical uniform
    // distribution and cannot spin forever on a degenerate rng.
    let p = 1 + rng(245);
    if (p >= 0x30) p += 10;
    buf[i] = p;
  }
  buf[padding] = 0x30 + (len % 10);
  buf[padding + 1] = 0x30 + (Math.trunc(len / 10) % 10);
  buf[padding + 2] = 0x30 + (Math.trunc(len / 100) % 10);
  utf.copy(buf, padding + 3);

  let last = 31;
  for (let i = 0; i < buf.length; i++) {
    last = (last + buf[i]) % 255 + 1;
    buf[i] = SCRAMBLE_TABLE[last];
  }
  return buf;
}

/**
 * UnscramblePassword. Returns the password, or null when the blob fails any of
 * WinSCP's three consistency checks (length header present, total length
 * consistent, header positioned exactly `len` bytes from the end). WinSCP
 * returns false and an empty password; a null here forces the caller to notice.
 */
function unscramblePassword(scrambled) {
  const buf = Buffer.from(Buffer.isBuffer(scrambled) ? scrambled : Buffer.from(String(scrambled), 'binary'));
  let last = 31;
  for (let i = 0; i < buf.length; i++) {
    let x = UNSCRAMBLE_TABLE[buf[i]] - 1 - (last % 255);
    if (x <= 0) x += 255;
    buf[i] = x;
    last = (last + x) % 255 + 1;
  }

  // A damaged padding byte can itself become an ASCII digit. Do not trust the
  // first digit run: try each three-digit candidate and accept only the one
  // whose encoded length and position agree with the complete blob. This is
  // what preserves the format's self-synchronizing property without making a
  // malformed blob look valid.
  let s = -1;
  let len = 0;
  for (let i = 0; i + 2 < buf.length; i++) {
    if (!isDigitCode(buf[i]) || !isDigitCode(buf[i + 1]) || !isDigitCode(buf[i + 2])) continue;
    const candidate = (buf[i] - 0x30) + 10 * (buf[i + 1] - 0x30) + 100 * (buf[i + 2] - 0x30);
    const total = Math.trunc((candidate + 3) / 17) * 17 + 17;
    if (total === buf.length && total - i - 3 === candidate) {
      s = i;
      len = candidate;
      break;
    }
  }
  if (s < 0) return null;
  return buf.subarray(buf.length - len).toString('utf8');
}

// ---------------------------------------------------------------------------
// core/Cryptography.cpp — AES-256 with a MAC (the "password manager" layer)
// ---------------------------------------------------------------------------
//
// This is Dr Brian Gladman's fcrypt, the same construction WinZip AES uses:
// PBKDF2-HMAC-SHA1 (1000 iterations) derives an AES key, an HMAC key and a
// two-byte verifier; the data goes through AES in a counter mode whose counter
// is the low eight bytes of the block, little-endian, starting at 1; the tag is
// HMAC-SHA1 over the *ciphertext*, truncated to 10 bytes.
//
// The counter is NOT the standard big-endian 128-bit CTR, which is why this is
// built out of AES-ECB by hand instead of handing it to aes-256-ctr.

const AES_BLOCK_SIZE = 16;
const PASSWORD_MANAGER_AES_MODE = 3;
const KEYING_ITERATIONS = 1000;
const PWD_VER_LENGTH = 2;

function keyLength(mode) { return 8 * (mode & 3) + 8; }
function saltLength(mode) { return 4 * (mode & 3) + 4; }
function macLength() { return 10; }

const AES256_KEY_LENGTH = keyLength(PASSWORD_MANAGER_AES_MODE);   // 32
const AES256_SALT_LENGTH = saltLength(PASSWORD_MANAGER_AES_MODE); // 16
const AES256_MAC_LENGTH = macLength();                            // 10

/** AES256Salt. */
function aes256Salt() {
  return crypto.randomBytes(AES256_SALT_LENGTH);
}

function deriveFcryptKeys(password, salt) {
  const pwd = Buffer.isBuffer(password) ? password : Buffer.from(String(password), 'utf8');
  const kbuf = crypto.pbkdf2Sync(pwd, salt, KEYING_ITERATIONS,
    2 * AES256_KEY_LENGTH + PWD_VER_LENGTH, 'sha1');
  return {
    encKey: kbuf.subarray(0, AES256_KEY_LENGTH),
    macKey: kbuf.subarray(AES256_KEY_LENGTH, 2 * AES256_KEY_LENGTH),
    verifier: kbuf.subarray(2 * AES256_KEY_LENGTH),
  };
}

/** encr_data: XOR in place against the little-endian counter keystream. */
function fcryptXor(data, encKey) {
  const nonce = Buffer.alloc(AES_BLOCK_SIZE);
  let block = Buffer.alloc(AES_BLOCK_SIZE);
  let pos = AES_BLOCK_SIZE; // forces the first increment before the first byte
  for (let i = 0; i < data.length; i++) {
    if (pos === AES_BLOCK_SIZE) {
      // Only the first eight bytes take part in the increment; the top half
      // stays zero for the whole message.
      let j = 0;
      while (j < 8) { nonce[j] = (nonce[j] + 1) & 0xFF; if (nonce[j] !== 0) break; j++; }
      const c = crypto.createCipheriv('aes-256-ecb', encKey, null);
      c.setAutoPadding(false);
      block = Buffer.concat([c.update(nonce), c.final()]);
      pos = 0;
    }
    data[i] ^= block[pos++];
  }
}

/**
 * AES256EncyptWithMAC (the C++ spells it that way). With an explicit salt it
 * returns the pieces; the convenience form concatenates salt + ciphertext + MAC.
 */
function aes256EncryptWithMACParts(input, password, salt) {
  const useSalt = salt && salt.length ? Buffer.from(salt) : aes256Salt();
  if (useSalt.length !== AES256_SALT_LENGTH) {
    throw new Error(`AES-256 salt must be ${AES256_SALT_LENGTH} bytes`);
  }
  const { encKey, macKey } = deriveFcryptKeys(password, useSalt);
  const output = Buffer.from(input);
  fcryptXor(output, encKey);
  const mac = crypto.createHmac('sha1', macKey).update(output).digest().subarray(0, AES256_MAC_LENGTH);
  return { salt: useSalt, output, mac };
}

function aes256EncryptWithMAC(input, password) {
  const { salt, output, mac } = aes256EncryptWithMACParts(input, password, null);
  return Buffer.concat([salt, output, mac]);
}

/**
 * AES256DecryptWithMAC. Returns the plaintext, or null when the MAC does not
 * match — a wrong password and a tampered blob are indistinguishable and both
 * refuse, which is the point.
 */
function aes256DecryptWithMACParts(input, password, salt, mac) {
  const { encKey, macKey } = deriveFcryptKeys(password, salt);
  const output = Buffer.from(input);
  const mac2 = crypto.createHmac('sha1', macKey).update(output).digest().subarray(0, AES256_MAC_LENGTH);
  fcryptXor(output, encKey);
  if (mac2.length !== mac.length || !crypto.timingSafeEqual(mac2, Buffer.from(mac))) return null;
  return output;
}

function aes256DecryptWithMAC(input, password) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, 'binary');
  // Strictly greater: a blob of exactly salt+MAC length carries no ciphertext
  // and WinSCP rejects it rather than returning an empty plaintext.
  if (!(buf.length > AES256_SALT_LENGTH + AES256_MAC_LENGTH)) return null;
  const salt = buf.subarray(0, AES256_SALT_LENGTH);
  const encrypted = buf.subarray(AES256_SALT_LENGTH, buf.length - AES256_MAC_LENGTH);
  const mac = buf.subarray(buf.length - AES256_MAC_LENGTH);
  return aes256DecryptWithMACParts(encrypted, password, salt, mac);
}

/**
 * AES256CreateVerifier. Note what this stores: salt, then a random block in
 * *clear*, then the MAC of that block encrypted under the password. The
 * plaintext is public on purpose — the verifier proves the password without
 * ever holding anything the password protects.
 */
function aes256CreateVerifier(input) {
  const dummy = aes256Salt();
  const { salt, mac } = aes256EncryptWithMACParts(dummy, input, null);
  return Buffer.concat([salt, dummy, mac]);
}

/** AES256Verify. */
function aes256Verify(input, verifier) {
  const buf = Buffer.isBuffer(verifier) ? verifier : Buffer.from(verifier, 'binary');
  // The verifier has one unambiguous serialized shape. Reject trailing bytes
  // as well as truncation; accepting an edited suffix would make malformed
  // stored security state look valid to callers that do not canonicalize it.
  const verifierLength = AES256_SALT_LENGTH * 2 + AES256_MAC_LENGTH;
  if (buf.length !== verifierLength) return false;
  const salt = buf.subarray(0, AES256_SALT_LENGTH);
  const dummy = buf.subarray(AES256_SALT_LENGTH, AES256_SALT_LENGTH * 2);
  const mac = buf.subarray(AES256_SALT_LENGTH * 2, AES256_SALT_LENGTH * 2 + AES256_MAC_LENGTH);
  const { mac: mac2 } = aes256EncryptWithMACParts(dummy, input, salt);
  return crypto.timingSafeEqual(mac, mac2);
}

/** PasswordMaxLength. */
function passwordMaxLength() { return 128; }

/**
 * IsValidPassword. Tri-state, as in the C++: -1 for "unusable" (empty or over
 * the maximum), 1 for "strong enough", 0 for "weak". WinSCP shows the master
 * password strength hint from this and refuses only on -1.
 */
function isValidPassword(password) {
  const s = String(password === undefined || password === null ? '' : password);
  if (s.length === 0 || s.length > passwordMaxLength()) return -1;
  let a = 0; let b = 0; let c = 0; let d = 0;
  for (const ch of s) {
    if (ch >= 'a' && ch <= 'z') a = 1;
    else if (ch >= 'A' && ch <= 'Z') b = 1;
    else if (ch >= '0' && ch <= '9') c = 1;
    else d = 1;
  }
  return (s.length >= 6 && (a + b + c + d) >= 2) ? 1 : 0;
}

// ---------------------------------------------------------------------------
// TEncryption — WinSCP's at-rest file encryption
// ---------------------------------------------------------------------------
//
// Format, and it is deliberately simple so a file encrypted by WinSCP opens
// here and vice versa:
//
//   [ "aesctr.........." (16 bytes) ][ salt/IV (16 bytes) ][ AES-256-CTR data ]
//
// The cipher is PuTTY's ssh_aes256_sdctr, which is textbook AES-256-CTR with a
// big-endian 128-bit counter seeded from the salt — so node's 'aes-256-ctr' is
// bit-for-bit the same cipher. (This is a DIFFERENT counter convention from
// the fcrypt code above; they are two unrelated formats that happen to live in
// the same source file.)
//
// There is no MAC. WinSCP's file encryption gives confidentiality only; a
// truncated or altered file decrypts to garbage without complaint. That is
// WinSCP's design, and changing it here would make the files unreadable by
// WinSCP, so it stands — it is recorded as what it is rather than papered over.

/** Sixteen bytes, fixed, even for a future algorithm — it must match a block. */
const AES_CTR_MAGIC = Buffer.from('aesctr..........', 'binary');
const AES_CTR_EXT = '.aesctr.enc';

/** GenerateEncryptKey: 32 random bytes, shown to the user as 64 hex digits. */
function generateEncryptKey() {
  return crypto.randomBytes(AES256_KEY_LENGTH);
}

/**
 * ValidateEncryptKey. WinSCP's message names the algorithm and both the byte
 * and the hex-digit count, because the user types the key as hex.
 */
function validateEncryptKey(key) {
  const len = AES256_KEY_LENGTH;
  const buf = Buffer.isBuffer(key) ? key : Buffer.alloc(0);
  if (buf.length !== len) {
    throw new Error(
      `The key is not a valid AES-256 encryption key. It has to be ${len} bytes ` +
      `long (${len * 2} hexadecimal digits).`);
  }
}

/** The site stores the key as hex; these are the two ends of that. */
function encryptKeyToHex(key) { return bytesToHex(key); }
function encryptKeyFromHex(hex) { return hexToBytes(hex); }

class Encryption {
  /**
   * @param {Buffer} key 32 raw bytes. An empty key means "encryption off" and
   *   the object is inert, exactly as TEncryption with an empty FKey is.
   */
  constructor(key) {
    this.key = Buffer.isBuffer(key) ? Buffer.from(key) : Buffer.alloc(0);
    this.salt = null;
    this.inputHeader = Buffer.alloc(0);
    this.overflow = Buffer.alloc(0);
    this.outputtedHeader = false;
    this.cipher = null;
    if (this.key.length) validateEncryptKey(this.key);
  }

  static getOverhead() { return AES_CTR_MAGIC.length + AES256_SALT_LENGTH; }

  static roundToBlock(size) {
    const m = size % AES_BLOCK_SIZE;
    return m === 0 ? size : size + (AES_BLOCK_SIZE - m);
  }

  static roundToBlockDown(size) { return size - (size % AES_BLOCK_SIZE); }

  /**
   * IsEncryptedFileName. The length test matters: ".aesctr.enc" on its own, or
   * with fewer characters than a base64-encoded salt, cannot be one of ours and
   * must not be mistaken for a file whose name failed to decrypt.
   */
  static isEncryptedFileName(fileName) {
    const name = String(fileName || '');
    const saltBase64Len = Math.trunc((4 * AES256_SALT_LENGTH + 2) / 3);
    return name.endsWith(AES_CTR_EXT) && (name.length > AES_CTR_EXT.length + saltBase64Len);
  }

  _setSalt() {
    if (!this.key.length) {
      // TEncryption with an empty key has a NULL cipher context and would
      // crash if used. Say what actually went wrong instead.
      throw new Error('File encryption is not configured for this site (no encryption key).');
    }
    // A fresh cipher per IV set: node has no "re-key the IV" call, and the
    // counter must restart from the salt exactly as ssh_cipher_setiv does.
    this.cipher = crypto.createCipheriv('aes-256-ctr', this.key, this.salt);
    this.cipher.setAutoPadding(false);
  }

  _needSalt() {
    if (!this.salt) {
      this.salt = aes256Salt();
      this._setSalt();
    }
  }

  _aesBytes(buf) {
    if (!this.salt) throw new Error('Encryption salt has not been established');
    return this.cipher.update(buf);
  }

  /**
   * The chunked core. Whole blocks go through the cipher; a partial tail is
   * held over to the next call so the counter never advances past data we have
   * not seen. On the last call the tail is padded up to a block, run through,
   * and the padding discarded — CTR is a stream cipher, so the visible bytes
   * are identical either way, but the *chunking* of the output is what the SFTP
   * write loop depends on.
   */
  _aesBuffer(fileBuffer, last) {
    if (this.overflow.length) {
      fileBuffer.insert(0, this.overflow, this.overflow.length);
      this.overflow = Buffer.alloc(0);
    }

    let size = 0;
    if (last) {
      size = fileBuffer.size;
      fileBuffer.size = Encryption.roundToBlock(size);
    } else {
      const rounded = Encryption.roundToBlockDown(fileBuffer.size);
      if (rounded !== fileBuffer.size) {
        this.overflow = Buffer.concat([
          this.overflow,
          Buffer.from(fileBuffer.data.subarray(rounded, fileBuffer.size)),
        ]);
        fileBuffer.size = rounded;
      }
    }

    if (fileBuffer.size > 0) {
      const out = this._aesBytes(fileBuffer.data);
      out.copy(fileBuffer.data, 0);
    }

    if (last) fileBuffer.size = size;
  }

  /** Encrypt: prepends the magic + salt header on the first output. */
  encrypt(fileBuffer, last) {
    this._needSalt();
    this._aesBuffer(fileBuffer, last);
    if (!this.outputtedHeader) {
      const header = Buffer.concat([AES_CTR_MAGIC, this.salt]);
      fileBuffer.insert(0, header, header.length);
      this.outputtedHeader = true;
    }
  }

  /**
   * Decrypt: eats the header first, then streams. A file that does not begin
   * with the magic is refused — WinSCP raises "unknown file encryption" rather
   * than handing the user 32 bytes of noise followed by their file.
   */
  decrypt(fileBuffer) {
    if (this.inputHeader.length < Encryption.getOverhead()) {
      const headerSize = Math.min(Encryption.getOverhead() - this.inputHeader.length, fileBuffer.size);
      this.inputHeader = Buffer.concat([this.inputHeader, Buffer.from(fileBuffer.data.subarray(0, headerSize))]);
      fileBuffer.delete(0, headerSize);

      if (this.inputHeader.length >= Encryption.getOverhead()) {
        if (!this.inputHeader.subarray(0, AES_CTR_MAGIC.length).equals(AES_CTR_MAGIC)) {
          throw new Error('Unknown file encryption');
        }
        this.salt = Buffer.from(this.inputHeader.subarray(
          AES_CTR_MAGIC.length, AES_CTR_MAGIC.length + AES256_SALT_LENGTH));
        this._setSalt();
      }
    }

    if (fileBuffer.size > 0) this._aesBuffer(fileBuffer, false);
  }

  /**
   * DecryptEnd: flushes the held-over partial block into `fileBuffer`.
   * Returns whether there was anything to flush, which is how the download
   * loop knows to write one more time.
   */
  decryptEnd(fileBuffer) {
    const result = this.overflow.length > 0;
    if (result) this._aesBuffer(fileBuffer, true);
    return result;
  }

  /**
   * The destructor's check, made explicit. A file whose header never completed
   * was truncated (or was never encrypted), and WinSCP raises rather than
   * leaving a silently-empty download in place. Call this when the transfer
   * ends.
   */
  finish() {
    if (this.inputHeader.length > 0 && this.inputHeader.length < Encryption.getOverhead()) {
      throw new Error('Unknown file encryption');
    }
  }

  /**
   * EncryptFileName. base64 of salt + AES(name), '/' rewritten to '_' and '='
   * padding stripped, then ".aesctr.enc".
   *
   * WinSCP constructs a fresh TEncryption for every single name (see
   * TTerminal::EncryptFileName), which is what keeps the counter starting from
   * the salt each time. Reusing one instance across names would emit the same
   * salt with a advanced keystream and produce names that cannot be decrypted;
   * so this resets the cipher per call and does not depend on the caller
   * knowing that.
   */
  encryptFileName(fileName) {
    this.salt = aes256Salt();
    this._setSalt();
    const nameBytes = Buffer.from(String(fileName), 'utf8');
    const encrypted = this._aesBytes(nameBytes);
    const blob = Buffer.concat([this.salt, encrypted]);
    let base64 = blob.toString('base64').split('/').join('_');
    while (base64.endsWith('=')) base64 = base64.slice(0, -1);
    return base64 + AES_CTR_EXT;
  }

  /** DecryptFileName. Refuses anything that is not one of ours. */
  decryptFileName(fileName) {
    const name = String(fileName);
    if (!Encryption.isEncryptedFileName(name)) throw new Error('Not an encrypted file name');
    let base64 = name.slice(0, name.length - AES_CTR_EXT.length).split('_').join('/');
    const padding = 4 - (base64.length % 4);
    if (padding > 0 && padding < 4) base64 += '='.repeat(padding);
    const blob = Buffer.from(base64, 'base64');
    if (blob.length <= AES256_SALT_LENGTH) throw new Error('Empty encrypted filename');
    this.salt = Buffer.from(blob.subarray(0, AES256_SALT_LENGTH));
    this._setSalt();
    return this._aesBytes(blob.subarray(AES256_SALT_LENGTH)).toString('utf8');
  }

  // --- whole-buffer conveniences, for the editor and small files ------------

  /** Encrypt a complete buffer in one call, header included. */
  encryptBuffer(buf) {
    const fb = new FileBuffer(buf);
    this.encrypt(fb, true);
    return fb.toBuffer();
  }

  /** Decrypt a complete buffer in one call. */
  decryptBuffer(buf) {
    const fb = new FileBuffer(buf);
    this.decrypt(fb);
    const head = fb.toBuffer();
    const tail = new FileBuffer(Buffer.alloc(0));
    const more = this.decryptEnd(tail);
    this.finish();
    return more ? Buffer.concat([head, tail.toBuffer()]) : head;
  }
}

/**
 * The size a remote encrypted file reports minus our header, per
 * TRemoteFile::SetEncrypted. A file smaller than the header is left alone —
 * a negative size would be worse than a wrong one.
 */
function decryptedFileSize(size) {
  return size > Encryption.getOverhead() ? size - Encryption.getOverhead() : size;
}

// ---------------------------------------------------------------------------
// core/PuttyTools.h — the parts that are format handling, not SSH
// ---------------------------------------------------------------------------
//
// Key loading itself belongs to the ssh2 engine that replaces PuTTY. What does
// NOT belong there is the file sniffing WinSCP does before it ever tries: the
// site dialog has to tell the user "this is an OpenSSH key, it is encrypted,
// its comment is X" without a connection and without the passphrase.

const KEY_TYPE = {
  UNOPENABLE: 'unopenable',
  UNKNOWN: 'unknown',
  SSH1: 'ssh1',
  SSH2: 'ssh2',                          // PuTTY .ppk
  OPENSSH_PEM: 'openssh-pem',
  OPENSSH_NEW: 'openssh-new',
  SSHCOM: 'sshcom',
  SSH1_PUBLIC: 'ssh1-public',
  SSH2_PUBLIC_RFC4716: 'ssh2-public-rfc4716',
  SSH2_PUBLIC_OPENSSH: 'ssh2-public-openssh',
};

/** all_keyalgs, in PuTTY's order, with the cache_id each one reports. */
const PUBKEY_ALGS = [
  { sshId: 'ssh-rsa', cacheId: 'rsa2' },
  { sshId: 'rsa-sha2-256', cacheId: 'rsa2' },
  { sshId: 'rsa-sha2-512', cacheId: 'rsa2' },
  { sshId: 'ssh-dss', cacheId: 'dss' },
  { sshId: 'ecdsa-sha2-nistp256', cacheId: 'ecdsa-sha2-nistp256' },
  { sshId: 'ecdsa-sha2-nistp384', cacheId: 'ecdsa-sha2-nistp384' },
  { sshId: 'ecdsa-sha2-nistp521', cacheId: 'ecdsa-sha2-nistp521' },
  { sshId: 'ssh-ed25519', cacheId: 'ssh-ed25519' },
  { sshId: 'ssh-ed448', cacheId: 'ssh-ed448' },
  { sshId: 'ssh-dss-cert-v01@openssh.com', cacheId: 'opensshcert-ssh-dss' },
  { sshId: 'ssh-rsa-cert-v01@openssh.com', cacheId: 'opensshcert-ssh-rsa' },
  { sshId: 'rsa-sha2-256-cert-v01@openssh.com', cacheId: 'opensshcert-ssh-rsa' },
  { sshId: 'rsa-sha2-512-cert-v01@openssh.com', cacheId: 'opensshcert-ssh-rsa' },
  { sshId: 'ssh-ed25519-cert-v01@openssh.com', cacheId: 'opensshcert-ssh-ed25519' },
  { sshId: 'ecdsa-sha2-nistp256-cert-v01@openssh.com', cacheId: 'opensshcert-ecdsa-sha2-nistp256' },
  { sshId: 'ecdsa-sha2-nistp384-cert-v01@openssh.com', cacheId: 'opensshcert-ecdsa-sha2-nistp384' },
  { sshId: 'ecdsa-sha2-nistp521-cert-v01@openssh.com', cacheId: 'opensshcert-ecdsa-sha2-nistp521' },
];

function findPubkeyAlg(name) {
  return PUBKEY_ALGS.find((a) => a.sshId === name) || null;
}

const RSA1_SIGNATURE = 'SSH PRIVATE KEY FILE FORMAT 1.1\n\u0000';

/**
 * key_type_s, ported from putty/sshpubk.c. Signature sniffing only: the order
 * matters because "-----BEGIN OPENSSH PRIVATE KEY" also starts with
 * "-----BEGIN ", so the new format must be tested first.
 */
function keyTypeFromContent(content) {
  const s = Buffer.isBuffer(content) ? content.toString('binary') : String(content);
  if (s.startsWith(RSA1_SIGNATURE)) return KEY_TYPE.SSH1;
  if (s.startsWith('---- BEGIN SSH2 PUBLIC KEY')) return KEY_TYPE.SSH2_PUBLIC_RFC4716;
  if (s.startsWith('PuTTY-User-Key-File-')) return KEY_TYPE.SSH2;
  if (s.startsWith('-----BEGIN OPENSSH PRIVATE KEY')) return KEY_TYPE.OPENSSH_NEW;
  if (s.startsWith('-----BEGIN ')) return KEY_TYPE.OPENSSH_PEM;
  if (s.startsWith('---- BEGIN SSH2 ENCRYPTED PRIVAT')) return KEY_TYPE.SSHCOM;

  // An SSH-1 public key is "bits exponent modulus", three decimal runs
  // separated by single spaces, with nothing but space or newline after.
  const ssh1Public = /^\d+ \d+ \d+(?=[ \n]|$)/;
  if (ssh1Public.test(s)) return KEY_TYPE.SSH1_PUBLIC;

  // An OpenSSH public key is a known algorithm name, one space, then base64.
  const m = /^([^ \n]+) ([0-9A-Za-z+/=]+)(?=[ \n]|$)/.exec(s);
  if (m && findPubkeyAlg(m[1])) return KEY_TYPE.SSH2_PUBLIC_OPENSSH;

  return KEY_TYPE.UNKNOWN;
}

/**
 * KeyType. An unreadable file is `unopenable`, not an exception — WinSCP shows
 * "unable to open file" as a key type so the site dialog can say which of the
 * two problems the user has.
 */
function keyType(fileName) {
  let content;
  try {
    // PuTTY reads the first 1024 bytes to sniff; more than that cannot help.
    const fd = fs.openSync(fileName, 'r');
    try {
      const buf = Buffer.alloc(1024);
      const read = fs.readSync(fd, buf, 0, 1024, 0);
      content = buf.subarray(0, read);
    } finally { fs.closeSync(fd); }
  } catch {
    return KEY_TYPE.UNOPENABLE;
  }
  return keyTypeFromContent(content);
}

/**
 * ppk_encrypted_s plus import_encrypted, reduced to what can be answered from
 * the file alone: is a passphrase needed, and what is the key's comment.
 *
 * Returns { encrypted, comment }. For a type WinSCP does not ask this about
 * (a public key, an unknown file) it reports not-encrypted with no comment,
 * matching the DebugFail()/false branch rather than raising.
 */
function isKeyEncrypted(type, fileName) {
  let text;
  try { text = fs.readFileSync(fileName, 'utf8'); } catch { return { encrypted: false, comment: '' }; }
  return isKeyEncryptedFromContent(type, text, fileName);
}

/** Read `Name: value` headers off the front of a key file, first wins. */
function readKeyHeaders(text) {
  const headers = new Map();
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const name = line.slice(0, idx).trim();
    if (!/^[A-Za-z0-9-]+$/.test(name)) continue;
    if (!headers.has(name)) headers.set(name, line.slice(idx + 1).trim());
  }
  return headers;
}

/** Decode a PEM/ssh.com style base64 body, ignoring headers and delimiters. */
function decodeKeyBody(text) {
  const body = text
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => !l.startsWith('----') && !l.startsWith('-----') && l.indexOf(':') < 0 && !l.endsWith('\\'))
    .join('');
  return Buffer.from(body.replace(/[^0-9A-Za-z+/=]/g, ''), 'base64');
}

const SSHCOM_MAGIC_NUMBER = 0x3f6ff9eb;

function isKeyEncryptedFromContent(type, content, fileName = '') {
  const text = Buffer.isBuffer(content) ? content.toString('binary') : String(content);
  const headers = readKeyHeaders(text);

  let encrypted = false;
  // For the OpenSSH formats PuTTY has no comment to report and substitutes the
  // key's own path, which WinSCP then shortens to the file name. Reproduced,
  // because the site dialog shows this string.
  const baseName = String(fileName).split(/[\\/]/).pop();
  let comment = '';

  switch (type) {
    case KEY_TYPE.SSH2: {
      // Only the versions PuTTY accepts count; anything else is not a .ppk at
      // all and is reported as not-encrypted with no comment.
      const version = [...headers.keys()].find((k) => /^PuTTY-User-Key-File-[123]$/.test(k));
      if (!version) return { encrypted: false, comment: '' };
      if (!headers.has('Encryption')) return { encrypted: false, comment: '' };
      encrypted = headers.get('Encryption') === 'aes256-cbc';
      comment = headers.get('Comment') || '';
      break;
    }
    case KEY_TYPE.OPENSSH_PEM:
      // The old PEM format announces its cipher in a Proc-Type/DEK-Info pair.
      encrypted = /^Proc-Type:\s*4,ENCRYPTED\s*$/im.test(text);
      comment = baseName;
      break;
    case KEY_TYPE.OPENSSH_NEW: {
      // The new format keeps the cipher name in the blob; "none" means the
      // private half is in clear. The comment is inside the encrypted section,
      // which is why PuTTY cannot report it either.
      comment = baseName;
      const blob = decodeKeyBody(text);
      const magic = Buffer.from('openssh-key-v1\u0000', 'binary');
      if (blob.length > magic.length + 4 && blob.subarray(0, magic.length).equals(magic)) {
        const len = blob.readUInt32BE(magic.length);
        if (magic.length + 4 + len <= blob.length) {
          const cipher = blob.subarray(magic.length + 4, magic.length + 4 + len).toString('binary');
          encrypted = cipher !== 'none';
        }
      }
      break;
    }
    case KEY_TYPE.SSHCOM: {
      // magic, total length, key type string, then the cipher name.
      comment = (headers.get('Comment') || '').replace(/^"|"$/g, '');
      const blob = decodeKeyBody(text);
      if (blob.length >= 8 && blob.readUInt32BE(0) === SSHCOM_MAGIC_NUMBER) {
        let p = 8;
        for (let field = 0; field < 2 && p + 4 <= blob.length; field++) {
          const len = blob.readUInt32BE(p);
          p += 4;
          if (p + len > blob.length) { p = -1; break; }
          if (field === 1) {
            encrypted = blob.subarray(p, p + len).toString('binary') !== 'none';
          }
          p += len;
        }
      }
      break;
    }
    default:
      // A public key, an SSH-1 key or an unrecognised file: WinSCP hits
      // DebugFail() and answers "not encrypted" rather than raising.
      return { encrypted: false, comment: '' };
  }

  return { encrypted, comment };
}

/** Base64ToUrlSafe: strip '=' padding, '+' -> '-', '/' -> '_'. */
function base64ToUrlSafe(s) {
  let r = String(s);
  while (r.endsWith('=')) r = r.slice(0, -1);
  return r.split('+').join('-').split('/').join('_');
}

const NORMALIZED_FINGERPRINT_SEPARATOR = '-';

/** MD5ToUrlSafe: the colons in an MD5 fingerprint become dashes. */
function md5ToUrlSafe(s) {
  return String(s).split(':').join(NORMALIZED_FINGERPRINT_SEPARATOR);
}

/**
 * DoNormalizeFingerprint. A host key line arrives either as
 * "ssh-ed25519 255 SHA256:abc..." (algorithm, bit count, fingerprint) or
 * already normalized as "ssh-ed25519-SHA256:abc...". Both are reduced to
 * { fingerprint, keyName, keyType }.
 *
 * The bit count must be a number. If it is not, the input is something else
 * entirely — commonly a pasted OpenSSH public key — and WinSCP leaves it
 * untouched rather than mangling it into a fingerprint.
 */
function normalizeFingerprint(fingerprint) {
  const input = String(fingerprint || '');
  for (const alg of PUBKEY_ALGS) {
    const name = alg.sshId;
    if (input.startsWith(name + ' ')) {
      const rest = input.slice(name.length + 1);
      const space = rest.indexOf(' ');
      const bits = space < 0 ? rest : rest.slice(0, space);
      if (/^\d+$/.test(bits) && space >= 0) {
        let fp = rest.slice(space + 1);
        fp = base64ToUrlSafe(fp);
        fp = md5ToUrlSafe(fp);
        return { fingerprint: fp, keyName: name, keyType: alg.cacheId };
      }
    } else if (input.startsWith(name + NORMALIZED_FINGERPRINT_SEPARATOR)) {
      return {
        fingerprint: input.slice(name.length + 1),
        keyName: name,
        keyType: alg.cacheId,
      };
    }
  }
  return { fingerprint: input, keyName: '', keyType: '' };
}

/** KeyTypeFromFingerprint. */
function keyTypeFromFingerprint(fingerprint) {
  return normalizeFingerprint(fingerprint).keyType;
}

/** The checksum algorithm names WinSCP registers (Configuration.cpp). */
const CHECKSUM_ALGS = { 'sha-1': 'sha1', 'sha-256': 'sha256', md5: 'md5' };

function hashAlgFor(alg) {
  const node = CHECKSUM_ALGS[String(alg).toLowerCase()];
  if (!node) throw new Error(`Unknown checksum algorithm '${alg}'.`);
  return node;
}

/** Sha256: upper-case hex, as BytesToHex produces it. */
function sha256Hex(data) {
  return bytesToHex(crypto.createHash('sha256').update(data).digest());
}

/** CalculateFileChecksum, over a readable stream, in 32 KiB blocks. */
function calculateFileChecksum(stream, alg) {
  const hash = crypto.createHash(hashAlgFor(alg));
  return new Promise((resolve, reject) => {
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(bytesToHex(hash.digest())));
  });
}

/**
 * SameChecksum. Base64 checksums compare case-sensitively after url-safing;
 * hex/MD5 ones compare case-insensitively after the colon rewrite, because
 * servers disagree about both.
 */
function sameChecksum(checksum1, checksum2, base64) {
  if (base64) return base64ToUrlSafe(checksum1) === base64ToUrlSafe(checksum2);
  return md5ToUrlSafe(String(checksum1)).toLowerCase() === md5ToUrlSafe(String(checksum2)).toLowerCase();
}

/** IsOpenSSH: Sun SSH is OpenSSH-derived and inherits the same bug list. */
function isOpenSSH(sshImplementation) {
  const s = String(sshImplementation || '');
  return s.startsWith('OpenSSH') || s.startsWith('Sun_SSH');
}

/**
 * GetPuTTYVersion's trimming rule, kept because the update check compares the
 * SSH engine version string the same way: everything up to and including the
 * last space is a label ("Release", "Pre-release", "Development snapshot").
 */
function trimVersionLabel(version) {
  const s = String(version || '');
  const p = s.lastIndexOf(' ');
  return p < 0 ? s : s.slice(p + 1);
}

module.exports = {
  // password obfuscation (interop only — see the header)
  PWALG_SIMPLE, PWALG_SIMPLE_MAGIC, PWALG_SIMPLE_MAXLEN, PWALG_SIMPLE_FLAG,
  PWALG_SIMPLE_INTERNAL, PWALG_SIMPLE_EXTERNAL, PWALG_SIMPLE_INTERNAL2,
  simpleEncryptChar, simpleDecryptNextChar,
  encryptPassword, decryptPassword, sessionPasswordEncryptionKey,
  setExternalEncryptedPassword, getExternalEncryptedPassword,
  bytesToHex, hexToBytes,
  // scramble
  scramblePassword, unscramblePassword, SCRAMBLE_TABLE, UNSCRAMBLE_TABLE,
  // AES-256 + MAC
  aes256EncryptWithMAC, aes256DecryptWithMAC, aes256EncryptWithMACParts,
  aes256DecryptWithMACParts, aes256CreateVerifier, aes256Verify, aes256Salt,
  AES256_KEY_LENGTH, AES256_SALT_LENGTH, AES256_MAC_LENGTH,
  isValidPassword, passwordMaxLength,
  // file encryption
  Encryption, generateEncryptKey, validateEncryptKey,
  encryptKeyToHex, encryptKeyFromHex, decryptedFileSize,
  AES_CTR_EXT, AES_CTR_MAGIC,
  // key files, fingerprints, checksums
  KEY_TYPE, PUBKEY_ALGS, findPubkeyAlg, keyType, keyTypeFromContent,
  isKeyEncrypted, isKeyEncryptedFromContent,
  base64ToUrlSafe, md5ToUrlSafe, normalizeFingerprint, keyTypeFromFingerprint,
  NORMALIZED_FINGERPRINT_SEPARATOR,
  CHECKSUM_ALGS, sha256Hex, calculateFileChecksum, sameChecksum,
  isOpenSSH, trimVersionLabel,
  // re-exported so callers need one require for the About dialog's version maths
  calculateCompoundVersion,
};
