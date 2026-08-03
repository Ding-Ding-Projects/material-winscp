'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { FtpAdapter } = require('../design/main/protocols/ftp');

function adapter(features, ftpUseMlsd = 'auto') {
  const a = new FtpAdapter({ ftpUseMlsd, ftpListAll: 'auto' });
  a.features = new Map(features.map((name) => [name, '']));
  return a;
}

test('MLST alone does not select MLSD for directory listings', () => {
  assert.deepEqual(adapter(['MLST'])._listCandidates(), ['LIST -a', 'LIST']);
});

test('MLSD is selected when the server advertises the directory-list command', () => {
  assert.deepEqual(adapter(['MLST', 'MLSD'])._listCandidates(), ['MLSD', 'LIST -a', 'LIST']);
});
