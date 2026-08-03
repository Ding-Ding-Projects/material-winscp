// Tests for design/main/security.js and design/main/filebuffer.js.
//
// The vectors here are derived from the C++ itself (core/Security.cpp,
// core/Cryptography.cpp, core/FileBuffer.cpp, core/FileInfo.cpp), not from
// running WinSCP: every constant below is traceable to a line of that source,
// so a regression shows up as a disagreement with the original rather than
// with a previous run of this port.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');

const S = require('../design/main/security');
const FB = require('../design/main/filebuffer');
const C = require('../design/main/crypto');
const { Config } = require('../design/main/config');

const zeroRng = () => 0;

// ===========================================================================
// core/Security.cpp — the password obfuscation
// ===========================================================================

test('simpleEncryptChar matches the C++ formula for the bytes that matter', () => {
  // Ch = (~Ch) ^ 0xA3, hex, upper case.
  assert.strictEqual(S.simpleEncryptChar(0x00), '5C'); // ~00=FF, FF^A3=5C
  assert.strictEqual(S.simpleEncryptChar(0xFF), 'A3'); // ~FF=00, 00^A3=A3
  assert.strictEqual(S.simpleEncryptChar(0xA3), 'FF');
  assert.strictEqual(S.simpleEncryptChar(0x01), '5D');
  assert.strictEqual(S.simpleEncryptChar(0x02), '5E');
  // Therefore every flagged WinSCP blob begins "A3" (the 0xFF flag) and an
  // internal, short-length blob continues "5C" (version 0x00).
});

test('simpleDecryptNextChar is the exact inverse and consumes two characters', () => {
  for (let b = 0; b <= 0xFF; b++) {
    const state = { s: S.simpleEncryptChar(b) + 'ZZ' };
    assert.strictEqual(S.simpleDecryptNextChar(state), b, `byte ${b}`);
    assert.strictEqual(state.s, 'ZZ');
  }
});

test('simpleDecryptNextChar returns 0 past the end, as the C++ does', () => {
  const state = { s: '' };
  assert.strictEqual(S.simpleDecryptNextChar(state), 0x00);
  assert.strictEqual(S.simpleDecryptNextChar(state), 0x00);
});

test('encryptPassword produces the exact WinSCP layout for a known input', () => {
  // Hand-computed from EncryptPassword() with random() pinned to 0:
  //   A3  flag 0xFF
  //   5C  version PWALG_SIMPLE_INTERNAL (0x00)
  //   5F  length 3
  //   5C  shift 0
  //   3D 3E 3F  'a' 'b' 'c'
  //   then random padding to PWALG_SIMPLE_MAXLEN*2 == 100 characters
  const out = S.encryptPassword('abc', '', 1, zeroRng);
  assert.strictEqual(out.slice(0, 14), 'A35C5F5C3D3E3F');
  assert.strictEqual(out.length, 100);
  assert.strictEqual(out, 'A35C5F5C3D3E3F' + '5C'.repeat(43));
});

test('a real blob always starts with the 0xFF flag byte, whatever the padding', () => {
  for (let i = 0; i < 20; i++) {
    const out = S.encryptPassword('secret', 'userhost');
    assert.strictEqual(out.slice(0, 2), 'A3', 'flag byte');
    assert.strictEqual(out.length, 100, 'padded to PWALG_SIMPLE_MAXLEN*2');
    assert.ok(/^[0-9A-F]+$/.test(out), 'only upper-case hex digits are emitted');
  }
});

test('an imported site password round-trips under its user+host key', () => {
  const key = S.sessionPasswordEncryptionKey('bob', 'example.com');
  assert.strictEqual(key, 'bobexample.com');
  const blob = S.encryptPassword('Tr0ub4dor&3', key);
  assert.strictEqual(S.decryptPassword(blob, key), 'Tr0ub4dor&3');
});

test('a password stored for a different user or host is refused, not mangled', () => {
  const blob = S.encryptPassword('secret', S.sessionPasswordEncryptionKey('bob', 'example.com'));
  // WinSCP treats a key mismatch as "this is not your password" and returns an
  // empty string so the caller prompts instead.
  assert.strictEqual(S.decryptPassword(blob, S.sessionPasswordEncryptionKey('eve', 'example.com')), '');
  assert.strictEqual(S.decryptPassword(blob, S.sessionPasswordEncryptionKey('bob', 'evil.com')), '');
});

test('an empty password round-trips as an empty password', () => {
  const blob = S.encryptPassword('', 'k');
  assert.strictEqual(S.decryptPassword(blob, 'k'), '');
});

test('a UTF-8 password survives the byte-oriented format', () => {
  const pw = 'p\u00e4ssw\u00f6rd\u4e2d\u6587\u{1F600}';
  const blob = S.encryptPassword(pw, 'k\u00e9y');
  assert.strictEqual(S.decryptPassword(blob, 'k\u00e9y'), pw);
});

test('a password over 255 bytes switches to the two-byte length header', () => {
  const pw = 'x'.repeat(300);
  const blob = S.encryptPassword(pw, '', 1, zeroRng);
  // flag, then PWALG_SIMPLE_INTERNAL2 (0x02) rather than 0x00.
  assert.strictEqual(blob.slice(0, 2), S.simpleEncryptChar(0xFF));
  assert.strictEqual(blob.slice(2, 4), S.simpleEncryptChar(0x02));
  assert.strictEqual(blob.slice(4, 6), S.simpleEncryptChar(300 >> 8));
  assert.strictEqual(blob.slice(6, 8), S.simpleEncryptChar(300 & 0xFF));
  assert.strictEqual(S.decryptPassword(blob, ''), pw);
  // Long passwords legitimately exceed the 100-character minimum.
  assert.ok(blob.length > 100);
});

test('the length boundary at exactly 255 bytes still uses the one-byte header', () => {
  const pw = 'y'.repeat(255);
  const blob = S.encryptPassword(pw, '', 1, zeroRng);
  assert.strictEqual(blob.slice(2, 4), S.simpleEncryptChar(0x00));
  assert.strictEqual(S.decryptPassword(blob, ''), pw);
});

test('the shift padding is skipped correctly for every shift value', () => {
  // Drive the shift deterministically across its whole range so the
  // "delete shift*2 characters" step is exercised, not just shift 0.
  for (let shift = 0; shift < 20; shift++) {
    let first = true;
    const rng = () => {
      if (first) { first = false; return shift; }
      return 7;
    };
    const blob = S.encryptPassword('pw', 'key', 1, rng);
    assert.strictEqual(S.decryptPassword(blob, 'key'), 'pw', `shift ${shift}`);
  }
});

test('the legacy no-flag layout decodes without a key check', () => {
  // A blob whose first byte is not 0xFF: that byte IS the length, and there is
  // no embedded key, so any key argument is ignored.
  const blob = S.simpleEncryptChar(2) +          // length 2
    S.simpleEncryptChar(0) +                     // shift 0
    S.simpleEncryptChar(0x68) + S.simpleEncryptChar(0x69); // 'h' 'i'
  assert.strictEqual(S.decryptPassword(blob, 'anything at all'), 'hi');
});

test('an unknown version byte yields no password rather than garbage', () => {
  const blob = S.simpleEncryptChar(0xFF) + S.simpleEncryptChar(0x7F) + '5C'.repeat(20);
  assert.strictEqual(S.decryptPassword(blob, ''), '');
});

test('a truncated blob decodes to NUL bytes rather than throwing', () => {
  // SimpleDecryptNextChar returns 0x00 past the end; the C++ happily collects
  // those, and so must we, or an import would crash on a damaged config.
  const blob = S.simpleEncryptChar(0x03) + S.simpleEncryptChar(0x00); // length 3, shift 0, no data
  assert.strictEqual(S.decryptPassword(blob, ''), '\u0000\u0000\u0000');
});

test('external passwords are tagged and hex-encoded, not obfuscated', () => {
  const payload = Buffer.from([0xDE, 0xAD, 0xBE, 0xEF, 0x00, 0x7F]);
  const blob = S.setExternalEncryptedPassword(payload);
  assert.strictEqual(blob.slice(0, 4), S.simpleEncryptChar(0xFF) + S.simpleEncryptChar(0x01));
  assert.strictEqual(blob.slice(4), 'DEADBEEF007F');
  assert.deepStrictEqual(S.getExternalEncryptedPassword(blob), payload);
});

test('a malformed external password payload is refused instead of becoming empty', () => {
  const blob = S.setExternalEncryptedPassword(Buffer.from('AB'));
  assert.strictEqual(S.getExternalEncryptedPassword(`${blob}!`), null);
  assert.strictEqual(S.getExternalEncryptedPassword(blob.slice(0, -1)), null);
  assert.deepStrictEqual(S.getExternalEncryptedPassword(S.setExternalEncryptedPassword(Buffer.alloc(0))), Buffer.alloc(0));
});

test('getExternalEncryptedPassword declines an ordinary obfuscated password', () => {
  const blob = S.encryptPassword('secret', 'key');
  assert.strictEqual(S.getExternalEncryptedPassword(blob), null);
  assert.strictEqual(S.getExternalEncryptedPassword(''), null);
});

// ===========================================================================
// design/main/crypto.js — session master-key handling
// ===========================================================================

test('master-password protection round-trips and lock removes session access', () => {
  C.lockMaster();
  const verifier = C.makeVerifier('correct horse battery staple');
  assert.strictEqual(C.unlockMaster('correct horse battery staple', verifier), true);
  const stored = C.protect('session-secret-fixture');
  assert.match(stored, /^mp:/);
  assert.strictEqual(C.unprotect(stored), 'session-secret-fixture');

  C.lockMaster();
  assert.strictEqual(C.hasMaster(), false);
  assert.strictEqual(C.unprotect(stored), '');
  assert.strictEqual(C.unlockMaster('correct horse battery staple', verifier), true);
  assert.strictEqual(C.unprotect(stored), 'session-secret-fixture');
  C.lockMaster();
});

test('malformed master-password verifiers fail closed without throwing', () => {
  C.lockMaster();
  assert.strictEqual(C.unlockMaster('anything', { salt: 'not-base64', probe: 'x' }), false);
  assert.strictEqual(C.unlockMaster('anything', { salt: 'AAAAAAAAAAAAAAAAAAAAAA==', probe: 'x' }), false);
  assert.strictEqual(C.hasMaster(), false);
});

test('a failed unlock cannot replace an already-unlocked session key', () => {
  C.lockMaster();
  const verifier = C.makeVerifier('right password');
  assert.strictEqual(C.unlockMaster('right password', verifier), true);
  const stored = C.protect('still-private');
  assert.strictEqual(C.unlockMaster('wrong password', verifier), false);
  assert.strictEqual(C.unprotect(stored), 'still-private');
  C.lockMaster();
});

test('AES-GCM helpers reject invalid key sizes and truncated envelopes', () => {
  assert.throws(() => C.encryptWithKey(Buffer.alloc(31), 'x'), /32-byte key/);
  assert.throws(() => C.decryptWithKey(Buffer.alloc(31), 'x'), /32-byte key/);
  assert.throws(() => C.decryptWithKey(Buffer.alloc(32), 'AA=='), /truncated/);
});

test('AES-GCM rejects permissively decoded envelope text', () => {
  const key = crypto.randomBytes(32);
  const blob = C.encryptWithKey(key, 'secret');
  assert.throws(() => C.decryptWithKey(key, ` ${blob}`), /valid base64/);
  assert.throws(() => C.decryptWithKey(key, `${blob}!`), /valid base64/);
  assert.throws(() => C.decryptWithKey(key, blob.replace(/=+$/u, '')), /valid base64/);
  assert.strictEqual(C.decryptWithKey(key, blob), 'secret');
});

test('protected OS envelopes require canonical base64 before keychain access', () => {
  const key = crypto.randomBytes(32);
  const blob = C.encryptWithKey(key, 'secret');
  assert.equal(C.isCanonicalBase64(blob), true);
  assert.equal(C.isCanonicalBase64(` ${blob}`), false);
  assert.equal(C.isCanonicalBase64(`${blob}!`), false);
  assert.equal(C.isCanonicalBase64(blob.replace(/=+$/u, '')), false);
});

test('AES-GCM rejects authenticated ciphertext that is not UTF-8 text', () => {
  const key = crypto.randomBytes(32);
  const blob = C.encryptWithKey(key, Buffer.from([0xC3, 0x28]));
  assert.throws(() => C.decryptWithKey(key, blob), /invalid UTF-8/);
});

test('AES-GCM storage rejects malformed base64 before decoding', () => {
  C.lockMaster();
  const verifier = C.makeVerifier('strict envelope password');
  assert.strictEqual(C.unlockMaster('strict envelope password', verifier), true);
  const stored = C.protect('keep this secret');
  const payload = stored.slice(3);
  assert.strictEqual(C.unprotect(`mp:${payload.slice(0, 4)}!${payload.slice(4)}`), '');
  assert.strictEqual(C.unprotect(`mp:${payload.replace(/=+$/u, '')}`), '');
  C.lockMaster();
});

test('master-password rewrap refuses to delete an unreadable stored secret', () => {
  C.lockMaster();
  const config = new Config();
  config.data.sites = [{ id: 'site-corrupt', password: 'mp:not-valid', passphrase: '',
    proxyPassword: '', tunnelPassword: '', tunnelPassphrase: '', encryptKey: '', s3SessionToken: '' }];
  const before = JSON.stringify(config.data);

  assert.strictEqual(config.enableMasterPassword('new master password'), false);
  assert.strictEqual(JSON.stringify(config.data), before);

  const verifier = C.makeVerifier('current master password');
  config.data.prefs.security.useMasterPassword = true;
  config.data.prefs.security.masterPasswordVerifier = verifier;
  assert.strictEqual(config.disableMasterPassword('current master password'), false);
  assert.strictEqual(config.data.sites[0].password, 'mp:not-valid');
  C.lockMaster();
});

test('credential writes fail closed when protection is unavailable', () => {
  const originalProtect = C.protect;
  try {
    C.protect = () => '';
    const config = new Config();
    config.save = () => {};
    assert.throws(
      () => config.addSite({ name: 'Unprotectable', hostName: 'example.com', password: 'secret', savePassword: true }),
      (error) => error && error.code === 'SECRET_PROTECTION_UNAVAILABLE',
    );
    assert.deepEqual(config.sites, [], 'a failed protection attempt must not add a half-saved site');
  } finally {
    C.protect = originalProtect;
  }
});

test('hexToBytes clears the whole result on any bad input', () => {
  assert.deepStrictEqual(S.hexToBytes('4142'), Buffer.from('AB'));
  assert.deepStrictEqual(S.hexToBytes('4142ab'), Buffer.from([0x41, 0x42, 0xAB]));
  assert.strictEqual(S.hexToBytes('414').length, 0, 'odd length');
  assert.strictEqual(S.hexToBytes('41G2').length, 0, 'non-hex digit');
  assert.strictEqual(S.bytesToHex(Buffer.from([0x0A, 0xFF])), '0AFF');
  assert.strictEqual(S.bytesToHex(Buffer.from([0x0A, 0xFF]), false), '0aff');
  assert.strictEqual(S.bytesToHex(Buffer.from([1, 2, 3]), true, ':'), '01:02:03');
});

// ===========================================================================
// core/Cryptography.cpp — the scramble table
// ===========================================================================

test('the scramble table is a permutation and its inverse is exact', () => {
  assert.strictEqual(S.SCRAMBLE_TABLE.length, 256);
  assert.strictEqual(new Set(S.SCRAMBLE_TABLE).size, 256, 'every byte appears once');
  for (let i = 0; i < 256; i++) {
    assert.strictEqual(S.UNSCRAMBLE_TABLE[S.SCRAMBLE_TABLE[i]], i);
  }
});

test('scramblePassword round-trips and pads to a multiple of 17 plus 17', () => {
  for (const pw of ['', 'a', 'hunter2', 'x'.repeat(14), 'x'.repeat(200), 'p\u00e4ss\u4e2d']) {
    const blob = S.scramblePassword(pw);
    const len = Buffer.from(pw, 'utf8').length;
    assert.strictEqual(blob.length, Math.trunc((len + 3) / 17) * 17 + 17, `length for ${len}`);
    assert.strictEqual(S.unscramblePassword(blob), pw);
  }
});

test('scrambled output never contains a NUL, which would truncate the C string', () => {
  for (let i = 0; i < 50; i++) {
    const blob = S.scramblePassword('some password ' + i);
    assert.ok(!blob.includes(0), 'no NUL byte');
  }
});

test('the scramble is self-synchronizing, so damage stays local', () => {
  // Worth pinning down because it is surprising: the running value works out
  // to depend only on the *previous scrambled byte*, never on the whole
  // prefix. Corrupting one byte therefore disturbs exactly two plaintext
  // bytes, not the rest of the blob. Damage inside the padding is invisible.
  const blob = S.scramblePassword('hunter2'); // 7 bytes of payload, 7 of padding
  const inPadding = Buffer.from(blob);
  inPadding[0] ^= 0xFF;
  assert.strictEqual(S.unscramblePassword(inPadding), 'hunter2');

  const inPayload = Buffer.from(blob);
  inPayload[blob.length - 1] ^= 0xFF;
  const damaged = S.unscramblePassword(inPayload);
  assert.notStrictEqual(damaged, 'hunter2');
});

test('unscramblePassword refuses a blob that fails its consistency checks', () => {
  const blob = S.scramblePassword('hunter2');
  // A blob of the wrong total length fails outright.
  assert.strictEqual(S.unscramblePassword(blob.subarray(0, blob.length - 1)), null);
  assert.strictEqual(S.unscramblePassword(Buffer.alloc(0)), null);
  // Corrupting the three-digit length header makes the arithmetic disagree.
  const header = Buffer.from(blob);
  header[7] ^= 0x55;
  header[8] ^= 0x55;
  assert.strictEqual(S.unscramblePassword(header), null);
});

// ===========================================================================
// core/Cryptography.cpp — AES-256 with a MAC
// ===========================================================================

test('the fcrypt keystream is the little-endian 8-byte counter, not standard CTR', () => {
  // encr_data increments only the low eight bytes of the nonce, little-endian,
  // and does it *before* the first block, so the counter blocks are
  // 01 00.., 02 00.., 03 00.. — deliberately not the big-endian 128-bit
  // counter every AES-CTR library implements. This test re-derives the
  // keystream independently and would fail the moment somebody "simplified"
  // the implementation into crypto's aes-256-ctr.
  const password = 'a password';
  const salt = Buffer.alloc(S.AES256_SALT_LENGTH, 0x11);
  const zeros = Buffer.alloc(48);
  const { output } = S.aes256EncryptWithMACParts(zeros, password, salt);

  const kbuf = crypto.pbkdf2Sync(Buffer.from(password, 'utf8'), salt, 1000, 66, 'sha1');
  const encKey = kbuf.subarray(0, 32);
  const expected = [];
  for (let counter = 1; counter <= 3; counter++) {
    const block = Buffer.alloc(16);
    block.writeUInt32LE(counter, 0);
    const c = crypto.createCipheriv('aes-256-ecb', encKey, null);
    c.setAutoPadding(false);
    expected.push(Buffer.concat([c.update(block), c.final()]));
  }
  assert.deepStrictEqual(output, Buffer.concat(expected));

  // The first block coincides with standard CTR; the rest must not.
  const stdIv = Buffer.alloc(16); stdIv[0] = 1;
  const std = crypto.createCipheriv('aes-256-ctr', encKey, stdIv).update(zeros);
  assert.deepStrictEqual(output.subarray(0, 16), std.subarray(0, 16));
  assert.notDeepStrictEqual(output.subarray(16), std.subarray(16));
});

test('aes256EncryptWithMAC lays the blob out as salt + ciphertext + MAC', () => {
  const plain = Buffer.from('the quick brown fox');
  const blob = S.aes256EncryptWithMAC(plain, 'pass');
  assert.strictEqual(blob.length, S.AES256_SALT_LENGTH + plain.length + S.AES256_MAC_LENGTH);
  assert.strictEqual(S.AES256_SALT_LENGTH, 16);
  assert.strictEqual(S.AES256_KEY_LENGTH, 32);
  assert.strictEqual(S.AES256_MAC_LENGTH, 10);
  assert.deepStrictEqual(S.aes256DecryptWithMAC(blob, 'pass'), plain);
});

test('a wrong password or a tampered blob is refused by the MAC', () => {
  const blob = S.aes256EncryptWithMAC(Buffer.from('secret data'), 'right');
  assert.strictEqual(S.aes256DecryptWithMAC(blob, 'wrong'), null);

  const tamperedCt = Buffer.from(blob);
  tamperedCt[S.AES256_SALT_LENGTH] ^= 0x01;
  assert.strictEqual(S.aes256DecryptWithMAC(tamperedCt, 'right'), null);

  const tamperedMac = Buffer.from(blob);
  tamperedMac[tamperedMac.length - 1] ^= 0x01;
  assert.strictEqual(S.aes256DecryptWithMAC(tamperedMac, 'right'), null);
});

test('a blob with no room for ciphertext is refused, not decoded as empty', () => {
  // The C++ test is strictly greater than salt+MAC.
  const tooShort = Buffer.alloc(S.AES256_SALT_LENGTH + S.AES256_MAC_LENGTH);
  assert.strictEqual(S.aes256DecryptWithMAC(tooShort, 'p'), null);
  assert.strictEqual(S.aes256DecryptWithMAC(Buffer.alloc(0), 'p'), null);
});

test('the verifier stores its probe in clear and still proves the password', () => {
  const verifier = S.aes256CreateVerifier('master password');
  // salt(16) + dummy plaintext(16) + MAC(10)
  assert.strictEqual(verifier.length, S.AES256_SALT_LENGTH * 2 + S.AES256_MAC_LENGTH);
  assert.strictEqual(S.aes256Verify('master password', verifier), true);
  assert.strictEqual(S.aes256Verify('Master password', verifier), false);
  assert.strictEqual(S.aes256Verify('', verifier), false);
});

test('aes256Verify refuses a short verifier instead of reading past its end', () => {
  assert.strictEqual(S.aes256Verify('p', Buffer.alloc(4)), false);
});

test('aes256Verify refuses a verifier with trailing bytes', () => {
  const verifier = S.aes256CreateVerifier('p');
  assert.strictEqual(S.aes256Verify('p', Buffer.concat([verifier, Buffer.from([0])])), false);
});

test('isValidPassword is tri-state exactly as IsValidPassword is', () => {
  assert.strictEqual(S.isValidPassword(''), -1, 'empty is unusable');
  assert.strictEqual(S.isValidPassword('x'.repeat(129)), -1, 'over the maximum');
  assert.strictEqual(S.isValidPassword('x'.repeat(128)), 0, 'at the maximum but one class');
  assert.strictEqual(S.passwordMaxLength(), 128);
  assert.strictEqual(S.isValidPassword('abcdef'), 0, 'long enough, one character class');
  assert.strictEqual(S.isValidPassword('abcde1'), 1, 'two classes and six characters');
  assert.strictEqual(S.isValidPassword('Abc1!'), 0, 'four classes but too short');
  assert.strictEqual(S.isValidPassword('Abc1!x'), 1);
});

// ===========================================================================
// TEncryption — WinSCP's at-rest file encryption
// ===========================================================================

test('the encrypted file header is the magic plus the salt, 32 bytes', () => {
  assert.strictEqual(S.Encryption.getOverhead(), 32);
  assert.strictEqual(S.AES_CTR_MAGIC.length, 16);
  assert.strictEqual(S.AES_CTR_MAGIC.toString('binary'), 'aesctr..........');

  const key = S.generateEncryptKey();
  const plain = Buffer.from('hello encrypted world');
  const blob = new S.Encryption(key).encryptBuffer(plain);
  assert.deepStrictEqual(blob.subarray(0, 16), S.AES_CTR_MAGIC);
  assert.strictEqual(blob.length, plain.length + 32);
  assert.deepStrictEqual(new S.Encryption(key).decryptBuffer(blob), plain);
});

test('the ciphertext really is AES-256-CTR keyed by the header salt', () => {
  const key = S.generateEncryptKey();
  const plain = crypto.randomBytes(100);
  const blob = new S.Encryption(key).encryptBuffer(plain);
  const salt = blob.subarray(16, 32);
  const ref = crypto.createCipheriv('aes-256-ctr', key, salt);
  assert.deepStrictEqual(blob.subarray(32), ref.update(plain));
});

test('every possible chunk split of an encrypted file decrypts identically', () => {
  const key = S.generateEncryptKey();
  // Deliberately not a multiple of the 16-byte block, so the overflow buffer
  // is exercised at almost every boundary.
  const plain = crypto.randomBytes(133);

  const oneShot = new S.Encryption(key).encryptBuffer(plain);

  for (let split = 1; split < plain.length; split++) {
    const enc = new S.Encryption(key);
    const parts = [];
    const a = new FB.FileBuffer(plain.subarray(0, split));
    enc.encrypt(a, false);
    parts.push(a.toBuffer());
    const b = new FB.FileBuffer(plain.subarray(split));
    enc.encrypt(b, true);
    parts.push(b.toBuffer());
    const blob = Buffer.concat(parts);
    assert.strictEqual(blob.length, oneShot.length, `split ${split} length`);

    // And it must decrypt, split at a different, equally awkward, point.
    const dec = new S.Encryption(key);
    const out = [];
    const cut = (split * 7) % blob.length;
    const d1 = new FB.FileBuffer(blob.subarray(0, cut));
    dec.decrypt(d1); out.push(d1.toBuffer());
    const d2 = new FB.FileBuffer(blob.subarray(cut));
    dec.decrypt(d2); out.push(d2.toBuffer());
    const tail = new FB.FileBuffer(Buffer.alloc(0));
    if (dec.decryptEnd(tail)) out.push(tail.toBuffer());
    dec.finish();
    assert.deepStrictEqual(Buffer.concat(out), plain, `split ${split} round trip`);
  }
});

test('a byte-at-a-time transfer still decrypts', () => {
  const key = S.generateEncryptKey();
  const plain = Buffer.from('one byte at a time, which is the worst case for the overflow buffer');
  const enc = new S.Encryption(key);
  const encoded = [];
  for (let i = 0; i < plain.length; i++) {
    const fb = new FB.FileBuffer(plain.subarray(i, i + 1));
    enc.encrypt(fb, i === plain.length - 1);
    encoded.push(fb.toBuffer());
  }
  const blob = Buffer.concat(encoded);
  assert.strictEqual(blob.length, plain.length + 32);

  const dec = new S.Encryption(key);
  const out = [];
  for (let i = 0; i < blob.length; i++) {
    const fb = new FB.FileBuffer(blob.subarray(i, i + 1));
    dec.decrypt(fb);
    out.push(fb.toBuffer());
  }
  const tail = new FB.FileBuffer(Buffer.alloc(0));
  if (dec.decryptEnd(tail)) out.push(tail.toBuffer());
  dec.finish();
  assert.deepStrictEqual(Buffer.concat(out), plain);
});

test('an empty file encrypts to the header alone and back', () => {
  const key = S.generateEncryptKey();
  const blob = new S.Encryption(key).encryptBuffer(Buffer.alloc(0));
  assert.strictEqual(blob.length, 32);
  assert.deepStrictEqual(new S.Encryption(key).decryptBuffer(blob), Buffer.alloc(0));
});

test('a file that is not one of ours is refused, not decoded to noise', () => {
  const key = S.generateEncryptKey();
  const notOurs = Buffer.concat([Buffer.from('not the magic!!!'), crypto.randomBytes(48)]);
  assert.throws(() => new S.Encryption(key).decryptBuffer(notOurs), /Unknown file encryption/);
});

test('a truncated header is reported at the end of the transfer', () => {
  const key = S.generateEncryptKey();
  const dec = new S.Encryption(key);
  dec.decrypt(new FB.FileBuffer(S.AES_CTR_MAGIC.subarray(0, 10)));
  // The header never completed, which means the file was cut short.
  assert.throws(() => dec.finish(), /Unknown file encryption/);
});

test('a file with no bytes at all is not treated as a truncated encrypted file', () => {
  const dec = new S.Encryption(S.generateEncryptKey());
  dec.decrypt(new FB.FileBuffer(Buffer.alloc(0)));
  dec.finish(); // must not throw: nothing was read, nothing is wrong
});

test('encrypted file names round-trip and stay URL- and path-safe', () => {
  const key = S.generateEncryptKey();
  for (const name of ['report.txt', 'a', '\u4e2d\u6587\u6587\u4ef6.pdf', 'x'.repeat(120)]) {
    const enc = new S.Encryption(key).encryptFileName(name);
    assert.ok(enc.endsWith(S.AES_CTR_EXT));
    assert.ok(!enc.includes('/'), 'a slash would make it a path');
    assert.ok(!enc.includes('='), 'base64 padding is stripped');
    assert.ok(S.Encryption.isEncryptedFileName(enc));
    assert.strictEqual(new S.Encryption(key).decryptFileName(enc), name);
  }
});

test('two names encrypted through the same object still both decrypt', () => {
  // TTerminal builds a fresh TEncryption per name precisely because the cipher
  // counter would otherwise carry over. This port resets it per call, so
  // reusing one object is safe here.
  const key = S.generateEncryptKey();
  const enc = new S.Encryption(key);
  const a = enc.encryptFileName('first.txt');
  const b = enc.encryptFileName('second.txt');
  assert.strictEqual(new S.Encryption(key).decryptFileName(a), 'first.txt');
  assert.strictEqual(new S.Encryption(key).decryptFileName(b), 'second.txt');
});

test('isEncryptedFileName rejects names too short to hold a salt', () => {
  assert.strictEqual(S.Encryption.isEncryptedFileName('.aesctr.enc'), false);
  assert.strictEqual(S.Encryption.isEncryptedFileName('short.aesctr.enc'), false);
  assert.strictEqual(S.Encryption.isEncryptedFileName('plain.txt'), false);
  assert.strictEqual(S.Encryption.isEncryptedFileName(''), false);
  // 22 characters is exactly the base64 length of the 16-byte salt, and the
  // C++ requires strictly more than that.
  assert.strictEqual(S.Encryption.isEncryptedFileName('x'.repeat(22) + '.aesctr.enc'), false);
  assert.strictEqual(S.Encryption.isEncryptedFileName('x'.repeat(23) + '.aesctr.enc'), true);
});

test('decryptFileName refuses a name that is not encrypted', () => {
  const enc = new S.Encryption(S.generateEncryptKey());
  assert.throws(() => enc.decryptFileName('plain.txt'), /Not an encrypted file name/);
});

test('rounding helpers and the reported size of an encrypted remote file', () => {
  assert.strictEqual(S.Encryption.roundToBlock(0), 0);
  assert.strictEqual(S.Encryption.roundToBlock(1), 16);
  assert.strictEqual(S.Encryption.roundToBlock(16), 16);
  assert.strictEqual(S.Encryption.roundToBlock(17), 32);
  assert.strictEqual(S.Encryption.roundToBlockDown(0), 0);
  assert.strictEqual(S.Encryption.roundToBlockDown(15), 0);
  assert.strictEqual(S.Encryption.roundToBlockDown(33), 32);
  // TRemoteFile::SetEncrypted subtracts the overhead, but never below zero.
  assert.strictEqual(S.decryptedFileSize(100), 68);
  assert.strictEqual(S.decryptedFileSize(32), 32);
  assert.strictEqual(S.decryptedFileSize(0), 0);
});

test('the encryption key is 32 bytes, entered as 64 hex digits, and validated', () => {
  const key = S.generateEncryptKey();
  assert.strictEqual(key.length, 32);
  const hex = S.encryptKeyToHex(key);
  assert.strictEqual(hex.length, 64);
  assert.deepStrictEqual(S.encryptKeyFromHex(hex), key);

  S.validateEncryptKey(key); // must not throw
  assert.throws(() => S.validateEncryptKey(Buffer.alloc(31)),
    /32 bytes long \(64 hexadecimal digits\)/);
  assert.throws(() => S.validateEncryptKey(S.encryptKeyFromHex('nonsense')), /32 bytes/);
});

test('an object built with no key refuses to encrypt rather than crashing', () => {
  const enc = new S.Encryption(Buffer.alloc(0));
  assert.throws(() => enc.encryptBuffer(Buffer.from('x')), /not configured/);
});

// ===========================================================================
// core/PuttyTools.h — key files, fingerprints, checksums
// ===========================================================================

const PPK_ENCRYPTED = [
  'PuTTY-User-Key-File-3: ssh-ed25519',
  'Encryption: aes256-cbc',
  'Comment: bob@example',
  'Public-Lines: 2',
  'AAAAC3NzaC1lZDI1NTE5AAAAIH',
  'abc=',
  '',
].join('\n');

const PPK_PLAIN = PPK_ENCRYPTED.replace('aes256-cbc', 'none');

test('key type sniffing matches PuTTY key_type, including its ordering trap', () => {
  const T = S.KEY_TYPE;
  assert.strictEqual(S.keyTypeFromContent(PPK_ENCRYPTED), T.SSH2);
  // "-----BEGIN OPENSSH PRIVATE KEY" also matches the generic "-----BEGIN "
  // prefix, so the new format has to be tested first or every new-format key
  // would be reported as an old PEM one.
  assert.strictEqual(
    S.keyTypeFromContent('-----BEGIN OPENSSH PRIVATE KEY-----\nAAA\n'), T.OPENSSH_NEW);
  assert.strictEqual(S.keyTypeFromContent('-----BEGIN RSA PRIVATE KEY-----\nAAA\n'), T.OPENSSH_PEM);
  assert.strictEqual(S.keyTypeFromContent('-----BEGIN EC PRIVATE KEY-----\nAAA\n'), T.OPENSSH_PEM);
  assert.strictEqual(
    S.keyTypeFromContent('---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ----\n'), T.SSHCOM);
  assert.strictEqual(
    S.keyTypeFromContent('---- BEGIN SSH2 PUBLIC KEY ----\n'), T.SSH2_PUBLIC_RFC4716);
  assert.strictEqual(
    S.keyTypeFromContent('SSH PRIVATE KEY FILE FORMAT 1.1\n\u0000rest'), T.SSH1);
  assert.strictEqual(S.keyTypeFromContent('1024 35 12345678901234567890\n'), T.SSH1_PUBLIC);
  assert.strictEqual(
    S.keyTypeFromContent('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 bob@host\n'), T.SSH2_PUBLIC_OPENSSH);
  assert.strictEqual(
    S.keyTypeFromContent('ecdsa-sha2-nistp256 AAAAE2VjZHNh comment\n'), T.SSH2_PUBLIC_OPENSSH);
  // An unknown algorithm name is not an OpenSSH public key.
  assert.strictEqual(S.keyTypeFromContent('ssh-magic AAAAE2Vj x\n'), T.UNKNOWN);
  assert.strictEqual(S.keyTypeFromContent('random text\n'), T.UNKNOWN);
});

test('a file that cannot be opened reports unopenable, not an exception', () => {
  const missing = path.join(os.tmpdir(), 'winscp-material-no-such-key-' + Date.now());
  assert.strictEqual(S.keyType(missing), S.KEY_TYPE.UNOPENABLE);
});

test('keyType reads a real file off disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wscp-key-'));
  try {
    const file = path.join(dir, 'id.ppk');
    fs.writeFileSync(file, PPK_ENCRYPTED);
    assert.strictEqual(S.keyType(file), S.KEY_TYPE.SSH2);
    const info = S.isKeyEncrypted(S.KEY_TYPE.SSH2, file);
    assert.strictEqual(info.encrypted, true);
    assert.strictEqual(info.comment, 'bob@example');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a PuTTY key reports its passphrase state and its comment', () => {
  const enc = S.isKeyEncryptedFromContent(S.KEY_TYPE.SSH2, PPK_ENCRYPTED, 'C:\\keys\\id.ppk');
  assert.deepStrictEqual(enc, { encrypted: true, comment: 'bob@example' });
  const plain = S.isKeyEncryptedFromContent(S.KEY_TYPE.SSH2, PPK_PLAIN, 'C:\\keys\\id.ppk');
  assert.deepStrictEqual(plain, { encrypted: false, comment: 'bob@example' });
  // A file claiming to be a .ppk but with no version header is not one.
  assert.deepStrictEqual(
    S.isKeyEncryptedFromContent(S.KEY_TYPE.SSH2, 'Encryption: aes256-cbc\n', 'x'),
    { encrypted: false, comment: '' });
});

test('an old-format OpenSSH key is read from its Proc-Type header', () => {
  const encrypted = [
    '-----BEGIN RSA PRIVATE KEY-----',
    'Proc-Type: 4,ENCRYPTED',
    'DEK-Info: AES-128-CBC,0123456789ABCDEF0123456789ABCDEF',
    '',
    'AAAA',
    '-----END RSA PRIVATE KEY-----',
  ].join('\n');
  const info = S.isKeyEncryptedFromContent(S.KEY_TYPE.OPENSSH_PEM, encrypted, '/home/bob/id_rsa');
  assert.strictEqual(info.encrypted, true);
  // PEM carries no comment, so PuTTY substitutes the path and WinSCP shortens
  // it to the file name.
  assert.strictEqual(info.comment, 'id_rsa');

  const plain = '-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----';
  assert.strictEqual(
    S.isKeyEncryptedFromContent(S.KEY_TYPE.OPENSSH_PEM, plain, '/home/bob/id_rsa').encrypted, false);
});

function buildOpensshNew(cipherName) {
  const magic = Buffer.from('openssh-key-v1\u0000', 'binary');
  const cipher = Buffer.from(cipherName, 'binary');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(cipher.length);
  const blob = Buffer.concat([magic, len, cipher, Buffer.alloc(16)]);
  const b64 = blob.toString('base64').replace(/(.{64})/g, '$1\n');
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${b64}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

test('a new-format OpenSSH key is read from the cipher name inside the blob', () => {
  const enc = S.isKeyEncryptedFromContent(
    S.KEY_TYPE.OPENSSH_NEW, buildOpensshNew('aes256-ctr'), '/home/bob/id_ed25519');
  assert.strictEqual(enc.encrypted, true);
  assert.strictEqual(enc.comment, 'id_ed25519');
  assert.strictEqual(S.isKeyEncryptedFromContent(
    S.KEY_TYPE.OPENSSH_NEW, buildOpensshNew('none'), '/home/bob/id_ed25519').encrypted, false);
});

function buildSshCom(cipherName, comment) {
  const body = Buffer.concat([
    (() => { const b = Buffer.alloc(4); b.writeUInt32BE(0x3f6ff9eb); return b; })(),
    (() => { const b = Buffer.alloc(4); b.writeUInt32BE(0); return b; })(),
    (() => {
      const t = Buffer.from('if-modn{sign{rsa-pkcs1-sha1}}', 'binary');
      const l = Buffer.alloc(4); l.writeUInt32BE(t.length);
      return Buffer.concat([l, t]);
    })(),
    (() => {
      const c = Buffer.from(cipherName, 'binary');
      const l = Buffer.alloc(4); l.writeUInt32BE(c.length);
      return Buffer.concat([l, c]);
    })(),
  ]);
  return [
    '---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ----',
    `Comment: "${comment}"`,
    body.toString('base64'),
    '---- END SSH2 ENCRYPTED PRIVATE KEY ----',
    '',
  ].join('\n');
}

test('an ssh.com key is read from the cipher name in its blob, comment included', () => {
  const enc = S.isKeyEncryptedFromContent(S.KEY_TYPE.SSHCOM, buildSshCom('3des-cbc', 'my key'), 'k');
  assert.deepStrictEqual(enc, { encrypted: true, comment: 'my key' });
  const plain = S.isKeyEncryptedFromContent(S.KEY_TYPE.SSHCOM, buildSshCom('none', 'my key'), 'k');
  assert.deepStrictEqual(plain, { encrypted: false, comment: 'my key' });
});

test('the encryption question is answered "no" for a type it cannot apply to', () => {
  // The C++ hits DebugFail() and falls through to false for a public key.
  assert.deepStrictEqual(
    S.isKeyEncryptedFromContent(S.KEY_TYPE.SSH2_PUBLIC_OPENSSH, 'ssh-rsa AAAA x', 'x'),
    { encrypted: false, comment: '' });
  assert.deepStrictEqual(
    S.isKeyEncryptedFromContent(S.KEY_TYPE.UNKNOWN, 'nonsense', 'x'),
    { encrypted: false, comment: '' });
});

test('fingerprints normalize from both the spaced and the joined form', () => {
  const spaced = S.normalizeFingerprint('ssh-ed25519 255 SHA256:abc+def/ghi=');
  assert.strictEqual(spaced.keyName, 'ssh-ed25519');
  assert.strictEqual(spaced.keyType, 'ssh-ed25519');
  // Both rewrites are applied unconditionally, so the "SHA256:" prefix's colon
  // becomes a dash as well. That is what DoNormalizeFingerprint produces and
  // what the stored host-key cache therefore contains.
  assert.strictEqual(spaced.fingerprint, 'SHA256-abc-def_ghi');

  const joined = S.normalizeFingerprint('ssh-rsa-SHA256:abc');
  assert.strictEqual(joined.keyName, 'ssh-rsa');
  assert.strictEqual(joined.keyType, 'rsa2', 'ssh-rsa caches as rsa2');
  assert.strictEqual(joined.fingerprint, 'SHA256:abc');

  const md5 = S.normalizeFingerprint('ssh-dss 1024 aa:bb:cc:dd');
  assert.strictEqual(md5.keyType, 'dss');
  assert.strictEqual(md5.fingerprint, 'aa-bb-cc-dd');
});

test('a pasted public key is left alone rather than mangled into a fingerprint', () => {
  // The bit count is not a number, so DoNormalizeFingerprint declines.
  const input = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIabc bob@host';
  const out = S.normalizeFingerprint(input);
  assert.strictEqual(out.fingerprint, input);
  assert.strictEqual(out.keyName, '');
  assert.strictEqual(out.keyType, '');
  assert.strictEqual(S.keyTypeFromFingerprint('nothing recognisable'), '');
});

test('checksum helpers use the names WinSCP registers', () => {
  // Sha256() returns upper-case hex via BytesToHex; the About box and the
  // update check both compare that string literally.
  assert.strictEqual(S.sha256Hex(Buffer.alloc(0)),
    'E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855');
  assert.deepStrictEqual(Object.keys(S.CHECKSUM_ALGS).sort(), ['md5', 'sha-1', 'sha-256']);
  // An algorithm the server offered but WinSCP does not know is refused by
  // name rather than silently falling back to a different digest.
  assert.throws(() => S.calculateFileChecksum(Readable.from([]), 'crc32'),
    /Unknown checksum algorithm 'crc32'/);
});

test('calculateFileChecksum hashes a stream in the algorithms WinSCP offers', async () => {
  const data = Buffer.from('winscp material');
  const expect = (alg) => S.bytesToHex(crypto.createHash(alg).update(data).digest());
  assert.strictEqual(await S.calculateFileChecksum(Readable.from([data]), 'sha-256'), expect('sha256'));
  assert.strictEqual(await S.calculateFileChecksum(Readable.from([data]), 'sha-1'), expect('sha1'));
  assert.strictEqual(await S.calculateFileChecksum(Readable.from([data]), 'md5'), expect('md5'));
  // Chunked input must give the same answer as one block.
  const chunks = [data.subarray(0, 3), data.subarray(3, 9), data.subarray(9)];
  assert.strictEqual(await S.calculateFileChecksum(Readable.from(chunks), 'sha-256'), expect('sha256'));
});

test('sameChecksum applies the case rules each encoding needs', () => {
  assert.strictEqual(S.sameChecksum('AA:BB:CC', 'aa-bb-cc', false), true, 'MD5 is case-insensitive');
  assert.strictEqual(S.sameChecksum('abc+def/ghi=', 'abc-def_ghi', true), true, 'base64 url-safed');
  assert.strictEqual(S.sameChecksum('abc', 'ABC', true), false, 'base64 is case-sensitive');
});

test('OpenSSH detection covers Sun SSH, which inherits its bugs', () => {
  assert.strictEqual(S.isOpenSSH('OpenSSH_5.3'), true);
  assert.strictEqual(S.isOpenSSH('Sun_SSH_1.1'), true);
  assert.strictEqual(S.isOpenSSH('mod_sftp/0.9.8 OpenSSH'), false, 'must be a prefix');
  assert.strictEqual(S.isOpenSSH(''), false);
});

test('version labels are trimmed the way GetPuTTYVersion trims them', () => {
  assert.strictEqual(S.trimVersionLabel('Release 0.64'), '0.64');
  assert.strictEqual(S.trimVersionLabel('Pre-release 0.65:2015-07-20.95501a1'), '0.65:2015-07-20.95501a1');
  assert.strictEqual(S.trimVersionLabel('Development snapshot 2015-12-22.51465fa'), '2015-12-22.51465fa');
  assert.strictEqual(S.trimVersionLabel('0.78'), '0.78');
});

// ===========================================================================
// core/FileBuffer.cpp — the buffer itself
// ===========================================================================

test('FileBuffer insert and delete move the right bytes', () => {
  const fb = new FB.FileBuffer(Buffer.from('abcdef'));
  fb.insert(3, Buffer.from('XY'), 2);
  assert.strictEqual(fb.toBuffer().toString(), 'abcXYdef');
  assert.strictEqual(fb.size, 8);
  fb.delete(3, 2);
  assert.strictEqual(fb.toBuffer().toString(), 'abcdef');
  fb.insert(0, Buffer.from('!'), 1);
  assert.strictEqual(fb.toBuffer().toString(), '!abcdef');
  fb.delete(6, 1);
  assert.strictEqual(fb.toBuffer().toString(), '!abcde');
});

test('growing a FileBuffer exposes zeroes, never a previous transfer', () => {
  const fb = new FB.FileBuffer(Buffer.from('abcd'));
  fb.size = 2;
  fb.size = 6;
  assert.deepStrictEqual(fb.toBuffer(), Buffer.from([0x61, 0x62, 0, 0, 0, 0]));
});

test('the position cursor and short-read accounting behave like TMemoryStream', () => {
  const fb = new FB.FileBuffer();
  fb.loadChunk(Buffer.from('hello'), 5);
  assert.strictEqual(fb.size, 5);
  assert.strictEqual(fb.position, 5);
  fb.reset();
  assert.strictEqual(fb.position, 0);

  // Asking for 10 but only getting 4 shrinks the buffer by the shortfall.
  const short = new FB.FileBuffer();
  short.loadChunk(Buffer.from('abcd'), 10);
  assert.strictEqual(short.size, 4);
  assert.strictEqual(short.position, 4);
});

// ===========================================================================
// core/FileBuffer.cpp — the EOL state machine
// ===========================================================================

function convertOnce(input, source, dest, params = 0, token = false) {
  const fb = new FB.FileBuffer(Buffer.from(input, 'binary'));
  const next = fb.convert(source, dest, params, token);
  return { out: fb.toBuffer().toString('binary'), token: next };
}

test('CRLF to LF, the two-character source path', () => {
  assert.strictEqual(convertOnce('a\r\nb\r\n', 'crlf', 'lf').out, 'a\nb\n');
  assert.strictEqual(convertOnce('\r\n\r\n', 'crlf', 'lf').out, '\n\n');
  assert.strictEqual(convertOnce('no line breaks', 'crlf', 'lf').out, 'no line breaks');
  // A lone LF is not a CRLF and is left alone.
  assert.strictEqual(convertOnce('a\nb', 'crlf', 'lf').out, 'a\nb');
});

test('CRLF to LF drops a trailing CR — WinSCP loses that byte too', () => {
  // This is the documented edge case: with a two-character source, a dangling
  // first character at the end of a buffer is deleted on the assumption that
  // its partner opens the next buffer. A genuine lone CR at end of file is
  // therefore lost. Reproduced deliberately, not by accident.
  assert.strictEqual(convertOnce('a\r', 'crlf', 'lf').out, 'a');
  // Which is exactly what makes the split case work:
  assert.strictEqual(convertOnce('a\r', 'crlf', 'lf').out +
    convertOnce('\nb', 'crlf', 'lf').out, 'a\nb');
});

test('LF to CRLF carries its token across a chunk boundary', () => {
  // "a\r" | "\nb": the first buffer ends on the destination EOL's first half,
  // gets completed, and sets the token so the orphan LF is dropped next time.
  const first = convertOnce('a\r', 'lf', 'crlf');
  assert.strictEqual(first.out, 'a\r\n');
  assert.strictEqual(first.token, true);
  const second = convertOnce('\nb', 'lf', 'crlf', 0, first.token);
  assert.strictEqual(second.out, 'b');
  assert.strictEqual(second.token, false);
});

test('LF to CRLF leaves an existing CRLF untouched', () => {
  assert.strictEqual(convertOnce('a\r\nb', 'lf', 'crlf').out, 'a\r\nb');
  assert.strictEqual(convertOnce('a\nb', 'lf', 'crlf').out, 'a\r\nb');
  assert.strictEqual(convertOnce('\n\n', 'lf', 'crlf').out, '\r\n\r\n');
});

test('CR to CRLF and LF to CR', () => {
  assert.strictEqual(convertOnce('a\rb', 'cr', 'crlf').out, 'a\r\nb');
  assert.strictEqual(convertOnce('a\r\nb', 'cr', 'crlf').out, 'a\r\nb', 'already destination form');
  assert.strictEqual(convertOnce('a\nb\nc', 'lf', 'cr').out, 'a\rb\rc');
});

test('an identical source and destination is a no-op that leaves the token alone', () => {
  const r = convertOnce('a\r\nb', 'crlf', 'crlf', 0, true);
  assert.strictEqual(r.out, 'a\r\nb');
  assert.strictEqual(r.token, true, 'Convert returns before touching Token');
});

test('the BOM and Ctrl-Z scrubbers do exactly what their flags say', () => {
  const bom = '\u00EF\u00BB\u00BF';
  assert.strictEqual(convertOnce(bom + 'text', 'lf', 'lf', FB.CP_REMOVE_BOM).out, 'text');
  assert.strictEqual(convertOnce(bom + 'text', 'lf', 'lf', 0).out, bom + 'text');
  assert.strictEqual(convertOnce('text\u001A', 'lf', 'lf', FB.CP_REMOVE_CTRL_Z).out, 'text');
  assert.strictEqual(convertOnce('text\u001A', 'lf', 'lf', 0).out, 'text\u001A');
  // Only a trailing Ctrl-Z; one in the middle is data.
  assert.strictEqual(convertOnce('a\u001Ab', 'lf', 'lf', FB.CP_REMOVE_CTRL_Z).out, 'a\u001Ab');
  // A two-byte buffer cannot hold a BOM.
  assert.strictEqual(convertOnce('\u00EF\u00BB', 'lf', 'lf', FB.CP_REMOVE_BOM).out, '\u00EF\u00BB');
  // Both at once, and the conversion still runs afterwards.
  assert.strictEqual(
    convertOnce(bom + 'a\nb\u001A', 'lf', 'crlf', FB.CP_REMOVE_BOM | FB.CP_REMOVE_CTRL_Z).out,
    'a\r\nb');
});

test('eolToStr covers the ordinals, our names and literal strings, and refuses the rest', () => {
  assert.strictEqual(FB.eolToStr(FB.EOL_LF), '\n');
  assert.strictEqual(FB.eolToStr(FB.EOL_CRLF), '\r\n');
  assert.strictEqual(FB.eolToStr(FB.EOL_CR), '\r');
  assert.strictEqual(FB.eolToStr('crlf'), '\r\n');
  assert.strictEqual(FB.eolToStr('\r'), '\r');
  assert.strictEqual(FB.EOL_TYPE_NAMES, 'LF;CRLF;CR');
  assert.strictEqual(FB.eolTypeFromStr('\r\n'), FB.EOL_CRLF);
  // An unknown EOL must not silently disable text mode.
  assert.throws(() => FB.eolToStr('lfcr'), /Unknown EOL type/);
  assert.throws(() => FB.eolToStr(9), /Unknown EOL type/);
});

// ---------------------------------------------------------------------------
// Adversarial chunk splits
// ---------------------------------------------------------------------------

function runChunked(conv, chunks) {
  const out = chunks.map((c) => conv.convert(Buffer.from(c, 'binary')));
  out.push(conv.flush());
  return Buffer.concat(out).toString('binary');
}

function allSplits(text) {
  const result = [];
  for (let i = 0; i <= text.length; i++) result.push([text.slice(0, i), text.slice(i)]);
  return result;
}

test('every single split point of an LF file uploaded as CRLF gives the same bytes', () => {
  const text = 'alpha\nbeta\n\ngamma\n';
  const expected = runChunked(new FB.EolConverter({ source: 'lf', dest: 'crlf' }), [text]);
  assert.strictEqual(expected, 'alpha\r\nbeta\r\n\r\ngamma\r\n');
  for (const [a, b] of allSplits(text)) {
    const got = runChunked(new FB.EolConverter({ source: 'lf', dest: 'crlf' }), [a, b]);
    assert.strictEqual(got, expected, `split after ${a.length}`);
  }
});

test('every single split point of a CRLF file downloaded as LF gives the same bytes', () => {
  const text = 'alpha\r\nbeta\r\n\r\ngamma\r\n';
  const expected = 'alpha\nbeta\n\ngamma\n';
  assert.strictEqual(runChunked(new FB.EolConverter({ source: 'crlf', dest: 'lf' }), [text]), expected);
  for (const [a, b] of allSplits(text)) {
    const got = runChunked(new FB.EolConverter({ source: 'crlf', dest: 'lf' }), [a, b]);
    assert.strictEqual(got, expected, `split after ${a.length}`);
  }
});

test('a CRLF straddling a boundary survives every three-way split too', () => {
  const text = 'x\r\ny\r\nz';
  const expected = 'x\ny\nz';
  for (let i = 0; i <= text.length; i++) {
    for (let j = i; j <= text.length; j++) {
      const got = runChunked(new FB.EolConverter({ source: 'crlf', dest: 'lf' }),
        [text.slice(0, i), text.slice(i, j), text.slice(j)]);
      assert.strictEqual(got, expected, `splits ${i}/${j}`);
    }
  }
});

test('byte-at-a-time conversion is identical to one shot, both directions', () => {
  const cases = [
    { source: 'lf', dest: 'crlf', text: 'a\nb\n\nc\n' },
    { source: 'crlf', dest: 'lf', text: 'a\r\nb\r\n\r\nc\r\n' },
    { source: 'cr', dest: 'crlf', text: 'a\rb\r\rc\r' },
    { source: 'lf', dest: 'cr', text: 'a\nb\n\nc\n' },
  ];
  for (const { source, dest, text } of cases) {
    const whole = runChunked(new FB.EolConverter({ source, dest }), [text]);
    const bytes = runChunked(new FB.EolConverter({ source, dest }), text.split(''));
    assert.strictEqual(bytes, whole, `${source}->${dest}`);
  }
});

test('the auto-source converter survives the same adversarial splits', () => {
  const text = 'mixed\r\nfile\nwith\r\nboth\n';
  const expected = 'mixed\r\nfile\r\nwith\r\nboth\r\n';
  assert.strictEqual(runChunked(new FB.EolConverter({ dest: 'crlf' }), [text]), expected);
  for (const [a, b] of allSplits(text)) {
    assert.strictEqual(runChunked(new FB.EolConverter({ dest: 'crlf' }), [a, b]), expected,
      `split after ${a.length}`);
  }
  assert.strictEqual(runChunked(new FB.EolConverter({ dest: 'crlf' }), text.split('')), expected);
});

test('the auto converter keeps a lone CR that the strict CRLF source would drop', () => {
  // This is the deliberate difference between the two modes, and the reason
  // 'auto' is the default for a transfer whose peer EOL is unknown.
  assert.strictEqual(runChunked(new FB.EolConverter({ dest: 'lf' }), ['a\r']), 'a\r');
  assert.strictEqual(runChunked(new FB.EolConverter({ source: 'crlf', dest: 'lf' }), ['a\r']), 'a');
});

test('BOM is stripped once at the head, never mid-stream', () => {
  const bom = '\u00EF\u00BB\u00BF';
  const conv = new FB.EolConverter({ dest: 'lf', removeBOM: true });
  assert.strictEqual(runChunked(conv, [bom + 'first', bom + 'second']), 'first' + bom + 'second',
    'a BOM in the middle of a file is data, not a marker');

  // Even when the BOM itself is split across the first two chunks it is not
  // recognised — WinSCP only ever looks at the head of a block, and the queue
  // reads at least a block at a time.
  const whole = new FB.EolConverter({ dest: 'lf', removeBOM: true });
  assert.strictEqual(runChunked(whole, [bom + 'text']), 'text');
});

test('Ctrl-Z is stripped only when it really is the last byte of the file', () => {
  const conv = new FB.EolConverter({ dest: 'lf', removeCtrlZ: true });
  assert.strictEqual(runChunked(conv, ['line\u001A', 'more\u001A']), 'line\u001Amore');
  const single = new FB.EolConverter({ dest: 'lf', removeCtrlZ: true });
  assert.strictEqual(runChunked(single, ['text\u001A']), 'text');
  const off = new FB.EolConverter({ dest: 'lf', removeCtrlZ: false });
  assert.strictEqual(runChunked(off, ['text\u001A']), 'text\u001A');
});

test('a Ctrl-Z immediately before a CR at a chunk boundary keeps its order', () => {
  // Both bytes get held back — the CR because it might open a CRLF, the Ctrl-Z
  // because it might be the DOS end-of-file marker — and they must go back in
  // the order they came out. Prepending them the wrong way round transposes two
  // bytes of the user's file, which no amount of later processing recovers.
  const conv = new FB.EolConverter({ dest: 'lf', removeCtrlZ: true });
  assert.strictEqual(runChunked(conv, ['a\u001A\r', 'b']), 'a\u001A\rb');

  // And at the true end of stream: the CR is the last byte, so the Ctrl-Z that
  // precedes it is ordinary data and must survive.
  const eof = new FB.EolConverter({ dest: 'lf', removeCtrlZ: true });
  assert.strictEqual(runChunked(eof, ['a\u001A\r']), 'a\u001A\r');

  // Whereas a Ctrl-Z that really is the last byte is still dropped.
  const marker = new FB.EolConverter({ dest: 'lf', removeCtrlZ: true });
  assert.strictEqual(runChunked(marker, ['a\r\u001A']), 'a\r');
});

test('writeChunk drains the buffer at the cursor and refuses to over-read', () => {
  // TFileBuffer::WriteToStream hands out Len bytes from the current position
  // and advances by exactly Len; a download loop fills and drains one buffer.
  const fb = new FB.FileBuffer(Buffer.from('abcdefgh'));
  assert.strictEqual(fb.position, 0);
  assert.strictEqual(fb.writeChunk(3).toString(), 'abc');
  assert.strictEqual(fb.position, 3);
  assert.strictEqual(fb.writeChunk(5).toString(), 'defgh');
  assert.strictEqual(fb.position, 8);

  fb.reset();
  assert.strictEqual(fb.writeChunk().toString(), 'abcdefgh', 'no length means the rest');

  // A short write would truncate the file with no error at all, so it raises
  // instead — the C++ WriteBuffer raises EWriteError on the same condition.
  fb.reset();
  assert.throws(() => fb.writeChunk(9), /past the end/);
  assert.strictEqual(fb.position, 0, 'a refused write does not move the cursor');

  // The returned bytes are detached: converting afterwards must not rewrite
  // what was already handed to the stream.
  const round = new FB.FileBuffer(Buffer.from('a\nb'));
  const taken = round.writeChunk(3);
  round.convert('lf', 'crlf', 0, false);
  assert.strictEqual(taken.toString(), 'a\nb');
});

test('TextConverter is a drop-in for the queue\'s converter', () => {
  // These three assertions are the queue's own tests, run against this class,
  // so queue.js can require it instead of keeping a second copy.
  const conv = new FB.TextConverter('lf');
  const a = conv.convert(Buffer.from('a\r'));
  const b = conv.convert(Buffer.from('\nb'));
  const c = conv.flush();
  assert.strictEqual(Buffer.concat([a, b, c]).toString(), 'a\nb');

  const up = new FB.TextConverter('crlf');
  const parts = ['li', 'ne1\n', 'line2\n'].map((s) => up.convert(Buffer.from(s)));
  parts.push(up.flush());
  assert.strictEqual(Buffer.concat(parts).toString(), 'line1\r\nline2\r\n');

  const lone = new FB.TextConverter('lf');
  const x = lone.convert(Buffer.from('a\r'));
  const y = lone.flush();
  assert.strictEqual(Buffer.concat([x, y]).toString(), 'a\r');
});

test('TextConverter honours the two scrubbers the copy parameters carry', () => {
  const conv = new FB.TextConverter('lf', { removeBOM: true, removeCtrlZ: true });
  const out = [conv.convert(Buffer.from('\uFEFFline1\r\nline2\u001A', 'utf8')), conv.flush()];
  assert.strictEqual(Buffer.concat(out).toString('utf8'), 'line1\nline2');
});

// ===========================================================================
// core/FileInfo.cpp — versions
// ===========================================================================

test('the compound version is the packed decimal WinSCP compares', () => {
  assert.strictEqual(FB.calculateCompoundVersion(1, 2, 3), 10203 * 10000);
  assert.strictEqual(FB.calculateCompoundVersion(0, 0, 0), 0);
  assert.strictEqual(FB.calculateCompoundVersion(6, 3, 5), 60305 * 10000);
  assert.strictEqual(FB.zeroBuildNumber(FB.calculateCompoundVersion(6, 3, 5) + 4321),
    FB.calculateCompoundVersion(6, 3, 5));
});

test('strToCompoundVersion clamps each component to 99 and defaults the release', () => {
  assert.strictEqual(FB.strToCompoundVersion('6.3.5'), FB.calculateCompoundVersion(6, 3, 5));
  assert.strictEqual(FB.strToCompoundVersion('6.3'), FB.calculateCompoundVersion(6, 3, 0));
  // Two decimal digits per component is all the format has.
  assert.strictEqual(FB.strToCompoundVersion('1.100.200'), FB.calculateCompoundVersion(1, 99, 99));
  assert.strictEqual(FB.strToCompoundVersion('6.3.5.9'), FB.calculateCompoundVersion(6, 3, 5),
    'the fourth component is not part of the compound form');
  // A malformed version must not read as 0.0.0, which would look older than
  // everything and could trigger a spurious update.
  assert.throws(() => FB.strToCompoundVersion('beta'), /not a valid integer/);
  assert.throws(() => FB.strToCompoundVersion('6.x.1'), /not a valid integer/);
});

test('compareVersion treats missing components as zero', () => {
  assert.strictEqual(FB.compareVersion('1.0', '1'), 0);
  assert.strictEqual(FB.compareVersion('1.0.0', '1.0'), 0);
  assert.strictEqual(FB.compareVersion('1.2', '1.10'), -1);
  assert.strictEqual(FB.compareVersion('2.0', '1.99.99'), 1);
  assert.strictEqual(FB.compareVersion('6.3.5', '6.3.5'), 0);
  assert.strictEqual(FB.compareVersion('6.3.5.1', '6.3.5'), 1);
  assert.strictEqual(FB.compareVersion('', ''), 0);
  // A non-numeric component reads as 0 here (StrToIntDef), unlike
  // strToCompoundVersion, because CompareVersion must never raise mid-check.
  assert.strictEqual(FB.compareVersion('1.beta', '1.0'), 0);
});

// ===========================================================================
// core/FileInfo.cpp — the version resource
// ===========================================================================

function utf16z(s) {
  return Buffer.from(s + '\u0000', 'utf16le');
}

function pad4(buf) {
  const rem = buf.length % 4;
  return rem === 0 ? buf : Buffer.concat([buf, Buffer.alloc(4 - rem)]);
}

/** Build one VS_VERSIONINFO node the way a resource compiler would. */
function versionNode(key, type, value, children = []) {
  const keyBuf = utf16z(key);
  const head = pad4(Buffer.concat([Buffer.alloc(6), keyBuf]));
  const valueBuf = value || Buffer.alloc(0);
  const withValue = children.length ? pad4(Buffer.concat([head, valueBuf]))
    : Buffer.concat([head, valueBuf]);
  const childBufs = [];
  let total = withValue.length;
  for (const child of children) {
    const padded = total % 4 === 0 ? child : Buffer.concat([Buffer.alloc(4 - (total % 4)), child]);
    childBufs.push(padded);
    total += padded.length;
  }
  const out = Buffer.concat([withValue, ...childBufs]);
  out.writeUInt16LE(out.length, 0);
  out.writeUInt16LE(type === 1 ? valueBuf.length / 2 : valueBuf.length, 2);
  out.writeUInt16LE(type, 4);
  return out;
}

function buildVersionBlock() {
  const fixed = Buffer.alloc(52);
  fixed.writeUInt32LE(0xFEEF04BD, 0);
  fixed.writeUInt32LE(0x00010000, 4);
  fixed.writeUInt32LE((6 << 16) | 3, 8);    // FileVersionMS  = 6.3
  fixed.writeUInt32LE((5 << 16) | 12, 12);  // FileVersionLS  = 5.12
  fixed.writeUInt32LE((6 << 16) | 3, 16);
  fixed.writeUInt32LE((5 << 16) | 0, 20);

  const strings = versionNode('040904B0', 1, null, [
    versionNode('CompanyName', 1, utf16z('Martin Prikryl')),
    versionNode('FileDescription', 1, utf16z('WinSCP: SFTP, FTP, WebDAV, S3 and SCP client')),
    versionNode('FileVersion', 1, utf16z('6.3.5.0')),
    versionNode('ProductName', 1, utf16z('WinSCP')),
  ]);
  const stringFileInfo = versionNode('StringFileInfo', 1, null, [strings]);

  const translation = Buffer.alloc(4);
  translation.writeUInt16LE(0x0409, 0);
  translation.writeUInt16LE(0x04B0, 2);
  const varFileInfo = versionNode('VarFileInfo', 1, null, [
    versionNode('Translation', 0, translation),
  ]);

  return versionNode('VS_VERSION_INFO', 0, fixed, [stringFileInfo, varFileInfo]);
}

test('a version block parses into fixed info, translations and strings', () => {
  const info = FB.parseVersionInfo(buildVersionBlock());
  assert.ok(info, 'block parsed');

  const fixed = FB.getFixedFileInfo(info);
  assert.strictEqual(fixed.signature, 0xFEEF04BD);
  assert.deepStrictEqual(fixed.fileVersion, [6, 3, 5, 12]);
  assert.deepStrictEqual(fixed.productVersion, [6, 3, 5, 0]);

  assert.strictEqual(FB.getTranslationCount(info), 1);
  const t = FB.getTranslation(info, 0);
  assert.deepStrictEqual(t, { language: 0x0409, charSet: 0x04B0 });

  assert.strictEqual(FB.getFileInfoString(info, t, 'ProductName'), 'WinSCP');
  assert.strictEqual(FB.getFileInfoString(info, t, 'FileVersion'), '6.3.5.0');
  assert.strictEqual(FB.getFileInfoString(info, t, 'CompanyName'), 'Martin Prikryl');
});

test('a missing string throws unless the caller allows it to be empty', () => {
  const info = FB.parseVersionInfo(buildVersionBlock());
  const t = FB.getTranslation(info, 0);
  assert.throws(() => FB.getFileInfoString(info, t, 'LegalTrademarks'),
    /Specified file info string not available/);
  assert.strictEqual(FB.getFileInfoString(info, t, 'LegalTrademarks', true), '');
  assert.throws(() => FB.getTranslation(info, 1), /Specified translation not available/);
});

test('a block with no translation node is a failure, not "zero translations"', () => {
  // VerQueryValue fails outright when \VarFileInfo\Translation is absent and
  // GetTranslationCount turns that failure into an exception. Reporting 0 would
  // let the About dialog treat a binary with no version strings as a binary
  // that merely has none, and print nothing without ever saying why.
  const fixed = Buffer.alloc(52);
  fixed.writeUInt32LE(0xFEEF04BD, 0);
  const block = versionNode('VS_VERSION_INFO', 0, fixed, []);
  const info = FB.parseVersionInfo(block);
  assert.ok(info, 'the block itself still parses');
  assert.strictEqual(FB.getFixedFileInfo(info).signature, 0xFEEF04BD);
  assert.throws(() => FB.getTranslationCount(info), /File info translations not available/);
  assert.throws(() => FB.getTranslation(info, 0), /File info translations not available/);
});

test('readVersionInfo declines a file it cannot open, as CreateFileInfo does', () => {
  // GetFileVersionInfoSize returns 0 for a missing file, so CreateFileInfo
  // returns NULL. Every caller is written for "no version info"; none is
  // written for an exception.
  const missing = path.join(os.tmpdir(), 'winscp-material-no-such-image-' + Date.now() + '.exe');
  assert.strictEqual(FB.readVersionInfo(missing), null);
});

test('a block that is not a version resource is rejected', () => {
  assert.strictEqual(FB.parseVersionInfo(Buffer.alloc(0)), null);
  assert.strictEqual(FB.parseVersionInfo(Buffer.from('not a version block')), null);
  assert.throws(() => FB.getFixedFileInfo(null), /Fixed file info not available/);
  assert.throws(() => FB.getTranslationCount(null), /translations not available/);
});

/** A minimal PE image whose only resource is the version block above. */
function buildPeWithVersion(block, { pe32Plus = false } = {}) {
  const sectionRva = 0x1000;
  const rawBase = 0x400;

  // type dir (24) + name dir (24) + lang dir (24) + data entry (16) = 88
  const rsrc = Buffer.alloc(88 + block.length);
  const dir = (buf, off, entryId, target, isDir) => {
    buf.writeUInt16LE(0, off + 12);  // named entries
    buf.writeUInt16LE(1, off + 14);  // id entries
    buf.writeUInt32LE(entryId, off + 16);
    buf.writeUInt32LE(isDir ? (target | 0x80000000) >>> 0 : target, off + 20);
  };
  dir(rsrc, 0, 16, 24, true);    // RT_VERSION
  dir(rsrc, 24, 1, 48, true);    // resource id 1
  dir(rsrc, 48, 1033, 72, false); // language 1033 -> data entry
  rsrc.writeUInt32LE(sectionRva + 88, 72);
  rsrc.writeUInt32LE(block.length, 76);
  block.copy(rsrc, 88);

  const optionalSize = pe32Plus ? 240 : 224;
  const headerSize = rawBase;
  const image = Buffer.alloc(headerSize + Math.ceil(rsrc.length / 512) * 512);
  image.writeUInt16LE(0x5A4D, 0);
  image.writeUInt32LE(0x80, 0x3C);

  const pe = 0x80;
  image.writeUInt32LE(0x00004550, pe);
  const coff = pe + 4;
  image.writeUInt16LE(pe32Plus ? 0x8664 : 0x014C, coff);
  image.writeUInt16LE(1, coff + 2);            // one section
  image.writeUInt16LE(optionalSize, coff + 16);

  const optional = coff + 20;
  image.writeUInt16LE(pe32Plus ? 0x20B : 0x10B, optional);
  const dirOffset = optional + (pe32Plus ? 112 : 96);
  image.writeUInt32LE(sectionRva, dirOffset + 2 * 8);
  image.writeUInt32LE(rsrc.length, dirOffset + 2 * 8 + 4);

  const section = optional + optionalSize;
  image.write('.rsrc\u0000\u0000\u0000', section, 'binary');
  image.writeUInt32LE(rsrc.length, section + 8);
  image.writeUInt32LE(sectionRva, section + 12);
  image.writeUInt32LE(Math.ceil(rsrc.length / 512) * 512, section + 16);
  image.writeUInt32LE(rawBase, section + 20);

  rsrc.copy(image, rawBase);
  return image;
}

test('the version resource is read straight out of a PE image', () => {
  for (const pe32Plus of [false, true]) {
    const image = buildPeWithVersion(buildVersionBlock(), { pe32Plus });
    const info = FB.readVersionInfoFromImage(image);
    assert.ok(info, `parsed (pe32Plus=${pe32Plus})`);
    assert.deepStrictEqual(FB.getFixedFileInfo(info).fileVersion, [6, 3, 5, 12]);
    const t = FB.getTranslation(info, 0);
    assert.strictEqual(FB.getFileInfoString(info, t, 'ProductName'), 'WinSCP');
  }
});

test('readVersionInfo reads from disk and declines a file with no resource', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wscp-pe-'));
  try {
    const good = path.join(dir, 'app.exe');
    fs.writeFileSync(good, buildPeWithVersion(buildVersionBlock()));
    const info = FB.readVersionInfo(good);
    assert.strictEqual(FB.getFileInfoString(info, FB.getTranslation(info, 0), 'FileVersion'), '6.3.5.0');

    const bad = path.join(dir, 'notes.txt');
    fs.writeFileSync(bad, 'this is not a PE image');
    assert.strictEqual(FB.readVersionInfo(bad), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the version reader survives a truncated or malformed image', () => {
  const image = buildPeWithVersion(buildVersionBlock());
  assert.strictEqual(FB.readVersionInfoFromImage(image.subarray(0, 0x40)), null);
  assert.strictEqual(FB.readVersionInfoFromImage(Buffer.alloc(0)), null);
  const noPe = Buffer.from(image);
  noPe.writeUInt32LE(0, 0x80); // clobber the PE signature
  assert.strictEqual(FB.readVersionInfoFromImage(noPe), null);
});
