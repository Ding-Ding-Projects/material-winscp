'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  EolConverter,
  FileBuffer,
  CP_REMOVE_BOM,
  CP_REMOVE_CTRL_Z,
} = require('../design/main/filebuffer');

function output(converter, chunks) {
  const out = chunks.map((chunk) => converter.convert(Buffer.from(chunk))).concat(converter.flush());
  return Buffer.concat(out);
}

test('removeBOM recognizes a UTF-8 BOM split across any first-read boundary', () => {
  const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
  const body = Buffer.from('payload\r\n', 'utf8');
  for (let split = 0; split <= bom.length; split++) {
    const got = output(new EolConverter({ dest: 'lf', removeBOM: true }), [
      bom.subarray(0, split),
      bom.subarray(split),
      body,
    ]);
    assert.deepStrictEqual(got, Buffer.from('payload\n'), `split after ${split}`);
  }
});

test('removeBOM preserves an incomplete marker at end of stream', () => {
  const one = output(new EolConverter({ dest: 'lf', removeBOM: true }), [Buffer.from([0xEF])]);
  const two = output(new EolConverter({ dest: 'lf', removeBOM: true }), [Buffer.from([0xEF, 0xBB])]);
  assert.deepStrictEqual(one, Buffer.from([0xEF]));
  assert.deepStrictEqual(two, Buffer.from([0xEF, 0xBB]));
});

test('a non-BOM prefix is emitted unchanged after the bounded probe', () => {
  const got = output(new EolConverter({ dest: 'lf', removeBOM: true }), [
    Buffer.from([0xEF]),
    Buffer.from([0xBB, 0x41, 0x0D]),
    Buffer.from([0x0A]),
  ]);
  assert.deepStrictEqual(got, Buffer.from([0xEF, 0xBB, 0x41, 0x0A]));
});

test('the raw FileBuffer flags remain block-local to match WinSCP Convert', () => {
  const fb = new FileBuffer(Buffer.from([0xEF, 0xBB, 0xBF, 0x41, 0x1A]));
  fb.convert('lf', 'lf', CP_REMOVE_BOM | CP_REMOVE_CTRL_Z, false);
  assert.deepStrictEqual(fb.toBuffer(), Buffer.from('A'));
});

test('an incomplete BOM candidate still receives EOF Ctrl-Z handling', () => {
  const got = output(new EolConverter({ dest: 'lf', removeBOM: true, removeCtrlZ: true }), [
    Buffer.from([0xEF, 0x1A]),
  ]);
  assert.deepStrictEqual(got, Buffer.from([0xEF]));
});
