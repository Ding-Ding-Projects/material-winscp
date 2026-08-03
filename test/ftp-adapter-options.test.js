// Focused FTP adapter option plumbing.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { FtpAdapter, passiveClientOptions, assertSafeFtpArgument } = require('../design/main/protocols/ftp');

test('passive host policy forces the control host only when explicitly on', () => {
  assert.deepEqual(passiveClientOptions('on'), { allowSeparateTransferHost: false });
  assert.deepEqual(passiveClientOptions(true), { allowSeparateTransferHost: false });
  // Auto retains basic-ftp's NAT-aware replacement of private PASV addresses.
  assert.deepEqual(passiveClientOptions('auto'), { allowSeparateTransferHost: true });
  assert.deepEqual(passiveClientOptions('off'), { allowSeparateTransferHost: true });
  // Session-data imports may still expose the historical enum integer.
  assert.deepEqual(passiveClientOptions(0), { allowSeparateTransferHost: false });
  assert.deepEqual(passiveClientOptions(1), { allowSeparateTransferHost: true });
  assert.deepEqual(passiveClientOptions(2), { allowSeparateTransferHost: true });
});

test('FTP authentication arguments reject command record separators', () => {
  assert.doesNotThrow(() => assertSafeFtpArgument('normal-user', 'username'));
  assert.throws(() => assertSafeFtpArgument('user\r\nNOOP', 'username'), /username contains a line break/);
  assert.throws(() => assertSafeFtpArgument('secret\nPASS injected', 'password'), /password contains a line break/);
  assert.throws(() => assertSafeFtpArgument('acct\rvalue', 'account'), /account contains a line break/);
});

test('FTP post-login commands reject command record separators', () => {
  assert.doesNotThrow(() => assertSafeFtpArgument('SITE HELP', 'post-login command'));
  assert.throws(() => assertSafeFtpArgument('SITE HELP\r\nDELE important.txt', 'post-login command'),
    /post-login command contains a line break/);
});

test('FTPS data sockets must match the already accepted control certificate', () => {
  const adapter = new FtpAdapter({ hostName: 'ftp.example.test' });
  adapter.serverInfo.certificate = { fingerprint256: 'AA:AA' };
  const socket = (fingerprint256, authorized = false) => ({
    getPeerCertificate: () => ({ fingerprint256 }),
    authorized,
  });

  assert.throws(() => adapter._verifyDataPeer(socket('BB:BB')),
    /data certificate does not match the control certificate/);
  assert.doesNotThrow(() => adapter._verifyDataPeer(socket('AA:AA')));
});
