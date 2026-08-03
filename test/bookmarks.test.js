'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  Bookmark,
  BookmarkList,
  Bookmarks,
  BookmarkSerializationError,
  BookmarkValidationError,
  DuplicateBookmarkError,
  SHARED_SCOPE,
  bookmarkKey,
  scopeForSession,
} = require('../design/main/bookmarks');
const { defaultSessionData } = require('../design/main/sessiondata');

const mark = (name, extra = {}) => ({
  name,
  local: `C:\\Users\\martin\\${name}`,
  remote: `/srv/${name}`,
  ...extra,
});

test('bookmark validation rejects ambiguous names, folders, paths and shortcuts', () => {
  for (const input of [
    { name: '' }, { name: '123' }, { name: 'a/b' }, { name: 'a\\b' },
    { name: 'a', node: '../secret' }, { name: 'a', node: 'one//two' },
    { name: 'a', local: 'bad\u0000path' }, { name: 'a', shortcut: 65536 },
    { name: 'a', shortcut: 1.5 },
  ]) assert.throws(() => new Bookmark(input), BookmarkValidationError);

  const valid = new Bookmark({ name: 'Release ν3', node: 'Production/EU', shortcut: 42 });
  assert.equal(valid.name, 'Release ν3');
  assert.equal(valid.node, 'Production/EU');
  assert.equal(valid.shortCut, 42);
});

test('bookmark identity is case-insensitive over folder and name', () => {
  assert.equal(bookmarkKey('Prod', 'Nightly'), bookmarkKey('prod', 'nightly'));
  const list = new BookmarkList([mark('Nightly', { node: 'Prod' })]);
  assert.equal(list.findByName('nightly', 'prod').name, 'Nightly');
  assert.throws(() => list.add(mark('NIGHTLY', { node: 'PROD' })), DuplicateBookmarkError);
});

test('bookmark list preserves insertion order and supports stable moves', () => {
  const list = new BookmarkList();
  list.add(mark('one'));
  list.add(mark('three'));
  list.insert(1, mark('two'));
  assert.deepEqual(list.items.map((item) => item.name), ['one', 'two', 'three']);
  list.move('one\u0001three', 0); // an unknown key is a no-op, not a guessed name
  list.move(list.findByName('three'), 0);
  assert.deepEqual(list.items.map((item) => item.name), ['three', 'one', 'two']);
  list.moveTo(list.findByName('two'), list.findByName('three'), false);
  assert.deepEqual(list.items.map((item) => item.name), ['one', 'two', 'three']);
});

test('duplicate policies are explicit and replacement keeps the original order', () => {
  const list = new BookmarkList([mark('A'), mark('B')]);
  const skipped = list.addWithResult(mark('a', { remote: '/new' }), { onDuplicate: 'skip' });
  assert.equal(skipped.action, 'skipped');
  assert.equal(list.findByName('A').remote, '/srv/A');

  const replaced = list.addWithResult(mark('a', { remote: '/replacement' }), { onDuplicate: 'replace' });
  assert.equal(replaced.action, 'replaced');
  assert.deepEqual(list.items.map((item) => item.name), ['a', 'B']);
  assert.equal(list.findByName('A').remote, '/replacement');

  const renamed = list.addWithResult(mark('a'), { onDuplicate: 'rename' });
  assert.equal(renamed.action, 'renamed');
  assert.equal(renamed.bookmark.name, 'a (2)');
  assert.deepEqual(list.items.map((item) => item.name), ['a', 'B', 'a (2)']);
});

test('shortcuts are unique within a list and can be found or cleared', () => {
  const list = new BookmarkList();
  list.add(mark('one', { shortcut: 7 }));
  assert.equal(list.findByShortcut(7).name, 'one');
  assert.throws(() => list.add(mark('two', { shortcut: 7 })), (error) => {
    assert.equal(error.code, 'DUPLICATE_BOOKMARK_SHORTCUT');
    return true;
  });
  assert.equal(list.findByShortcut(0), null);
  list.update('bad', { shortcut: 0 });
  list.remove(list.findByName('one'));
  assert.equal(list.count, 0);
});

test('updates are immutable and a failed rename leaves the old record intact', () => {
  const list = new BookmarkList([mark('one'), mark('two')]);
  const old = list.findByName('one');
  const updated = list.update(old, { remote: '/changed' });
  assert.notEqual(updated, old);
  assert.equal(old.remote, '/srv/one');
  assert.equal(list.findByName('one').remote, '/changed');
  assert.throws(() => list.rename(updated, 'two'), DuplicateBookmarkError);
  assert.equal(list.findByName('one').name, 'one');
});

test('opened folders and list order survive a deterministic persistence round trip', () => {
  const list = new BookmarkList([mark('z'), mark('a', { node: 'Work' })]);
  list.setNodeOpened('Work', true);
  const encoded = list.serialize();
  assert.equal(encoded, list.serialize());
  const parsed = JSON.parse(encoded);
  assert.deepEqual(Object.keys(parsed), ['version', 'bookmarks', 'openedNodes']);
  assert.deepEqual(parsed.bookmarks[0], {
    name: 'z', local: 'C:\\Users\\martin\\z', remote: '/srv/z', node: '', shortcut: 0,
  });
  assert.deepEqual(BookmarkList.fromJSON(encoded).items.map((item) => item.name), ['z', 'a']);
  assert.equal(BookmarkList.fromJSON(encoded).isNodeOpened('Work'), true);
});

test('persistence rejects unsupported versions, malformed records and duplicate records', () => {
  assert.throws(() => BookmarkList.fromJSON('{not-json'), BookmarkSerializationError);
  assert.throws(() => BookmarkList.fromJSON({ version: 99, bookmarks: [] }), BookmarkSerializationError);
  assert.throws(() => BookmarkList.fromJSON({ bookmarks: [{ name: 'x' }, { name: 'X' }] }), DuplicateBookmarkError);
  assert.throws(() => BookmarkList.fromJSON({ bookmarks: [], openedNodes: 'Work' }), BookmarkSerializationError);
});

test('session scope follows WinSCP SessionKey and never includes a password', () => {
  const session = defaultSessionData();
  session.protocol = 'sftp';
  session.hostName = 'sftp.example.com';
  session.userName = 'alice';
  session.password = 'do-not-store';
  session.portNumber = 22;
  assert.equal(scopeForSession(session), 'alice@sftp.example.com');
  session.portNumber = 2200;
  assert.equal(scopeForSession(session), 'alice@sftp.example.com:2200');
});

test('the store keeps shared and per-session lists separate and serializes scopes safely', () => {
  const session = defaultSessionData();
  session.hostName = 'host.example';
  session.userName = 'alice';
  const store = new Bookmarks();
  store.shared.add(mark('shared'));
  store.addForSession(session, mark('site-only'));
  assert.equal(store.shared.findByName('shared').name, 'shared');
  assert.equal(store.listForSession(session).findByName('site-only').name, 'site-only');
  assert.equal(store.listForSession(session).findByName('shared'), null);

  const encoded = store.serialize();
  assert.doesNotMatch(encoded, /do-not-store|password|passphrase/i);
  const restored = Bookmarks.fromJSON(encoded);
  assert.deepEqual(restored.scopes(), [SHARED_SCOPE, 'alice@host.example']);
  assert.equal(restored.listForSession(session).findByName('site-only').remote, '/srv/site-only');
  assert.equal(restored.shared.findByName('shared').local, 'C:\\Users\\martin\\shared');
});

test('legacy top-level bookmarks are treated as the shared list', () => {
  const store = Bookmarks.fromJSON({ bookmarks: [mark('legacy')], openedNodes: ['Old'] });
  assert.equal(store.shared.findByName('legacy').name, 'legacy');
  assert.equal(store.shared.isNodeOpened('Old'), true);
});
