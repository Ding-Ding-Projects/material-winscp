// bookmarks.js — ordered local/remote location profiles.
//
// WinSCP stores one bookmark list per SessionKey plus a shared list.  The
// original implementation spreads the data over a hierarchical INI store;
// this port keeps the same identity and ordering rules in a small, explicit
// model that can safely be embedded in the app's JSON configuration later.
'use strict';

const { sessionKey } = require('./sessiondata');

const SCHEMA_NAME = 'material-winscp.bookmarks';
const SCHEMA_VERSION = 1;
// TBookmarks uses TNamedObjectList::HiddenPrefix + "shared" for this key.
const SHARED_SCOPE = '_!_shared';
const MAX_NAME_LENGTH = 512;
const MAX_NODE_LENGTH = 4096;
const MAX_DIRECTORY_LENGTH = 32768;
const MAX_SCOPE_LENGTH = 4096;
const MAX_SHORTCUT = 0xffff;

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function text(value, field, { allowEmpty = true, max = Infinity } = {}) {
  if (typeof value !== 'string') {
    throw new BookmarkValidationError(`${field} must be a string.`, { field });
  }
  if (!allowEmpty && value.length === 0) {
    throw new BookmarkValidationError(`${field} cannot be empty.`, { field });
  }
  if (value.length > max) {
    throw new BookmarkValidationError(`${field} is too long.`, { field, max });
  }
  // Control characters make the hierarchical store and diagnostics
  // ambiguous.  Newlines are especially dangerous in exported text.
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new BookmarkValidationError(`${field} contains a control character.`, { field });
  }
  return value;
}

function validateName(value) {
  const name = text(value, 'name', { allowEmpty: false, max: MAX_NAME_LENGTH });
  if (/^\d+$/.test(name)) {
    throw new BookmarkValidationError(`Bookmark name '${name}' cannot be only digits.`, {
      field: 'name', code: 'INVALID_BOOKMARK_NAME',
    });
  }
  // A slash is the folder separator in the persisted key.  A backslash is
  // rejected too so a Windows path can never smuggle another hierarchy into
  // the JSON representation.
  if (name.includes('/') || name.includes('\\')) {
    throw new BookmarkValidationError(`Bookmark name '${name}' cannot contain a path separator.`, {
      field: 'name', code: 'INVALID_BOOKMARK_NAME',
    });
  }
  return name;
}

function validateNode(value) {
  const node = text(value, 'node', { max: MAX_NODE_LENGTH });
  if (node === '') return node;
  if (node.startsWith('/') || node.endsWith('/') || node.includes('\\') || node.includes('//')) {
    throw new BookmarkValidationError(`Bookmark folder '${node}' is not a valid folder path.`, {
      field: 'node', code: 'INVALID_BOOKMARK_FOLDER',
    });
  }
  const parts = node.split('/');
  if (parts.some((part) => part === '.' || part === '..' || part === '')) {
    throw new BookmarkValidationError(`Bookmark folder '${node}' contains an invalid segment.`, {
      field: 'node', code: 'INVALID_BOOKMARK_FOLDER',
    });
  }
  return node;
}

function validateDirectory(value, field) {
  return text(value, field, { max: MAX_DIRECTORY_LENGTH });
}

function validateShortcut(value) {
  if (!Number.isInteger(value) || value < 0 || value > MAX_SHORTCUT) {
    throw new BookmarkValidationError('shortcut must be an integer from 0 to 65535.', {
      field: 'shortcut', code: 'INVALID_BOOKMARK_SHORTCUT',
    });
  }
  return value;
}

function validateScope(value) {
  const scope = text(value, 'scope', { allowEmpty: false, max: MAX_SCOPE_LENGTH });
  if (scope === '.' || scope === '..') {
    throw new BookmarkValidationError(`Scope '${scope}' is reserved.`, {
      field: 'scope', code: 'INVALID_BOOKMARK_SCOPE',
    });
  }
  return scope;
}

function fold(value) { return value.toLocaleLowerCase('en-US'); }

function bookmarkKey(node, name) {
  // WinSCP's list is CaseSensitive=false and keys the node and name together.
  return `${fold(node)}\u0001${fold(name)}`;
}

function valueFrom(input, ...keys) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(input, key)) return input[key];
  }
  return undefined;
}

class BookmarkError extends Error {
  constructor(message, code = 'BOOKMARK_ERROR', details = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    Object.assign(this, details);
  }
}

class BookmarkValidationError extends BookmarkError {
  constructor(message, details = {}) { super(message, details.code || 'INVALID_BOOKMARK', details); }
}

class DuplicateBookmarkError extends BookmarkError {
  constructor(message, details = {}) { super(message, details.code || 'DUPLICATE_BOOKMARK', details); }
}

class BookmarkSerializationError extends BookmarkError {
  constructor(message, details = {}) { super(message, details.code || 'INVALID_BOOKMARK_DATA', details); }
}

/** A frozen, secret-free location profile. */
class Bookmark {
  constructor(input = {}) {
    if (!isPlainObject(input)) {
      throw new BookmarkValidationError('Bookmark must be created from an object.');
    }
    const shortcut = valueFrom(input, 'shortcut', 'shortCut', 'Shortcut');
    this.name = validateName(valueFrom(input, 'name', 'Name'));
    this.local = validateDirectory(valueFrom(input, 'local', 'Local') ?? '', 'local');
    this.remote = validateDirectory(valueFrom(input, 'remote', 'Remote') ?? '', 'remote');
    this.node = validateNode(valueFrom(input, 'node', 'Node') ?? '');
    this.shortcut = validateShortcut(shortcut ?? 0);
    Object.freeze(this);
  }

  get key() { return bookmarkKey(this.node, this.name); }
  get shortCut() { return this.shortcut; }

  getSideDirectory(side) {
    if (side === 'local' || side === 'Local' || side === 0) return this.local;
    if (side === 'remote' || side === 'Remote' || side === 1) return this.remote;
    throw new BookmarkValidationError(`Unknown bookmark side '${side}'.`, {
      field: 'side', code: 'INVALID_BOOKMARK_SIDE',
    });
  }

  with(patch = {}) {
    if (!isPlainObject(patch)) throw new BookmarkValidationError('Bookmark changes must be an object.');
    return new Bookmark({
      name: valueFrom(patch, 'name', 'Name') ?? this.name,
      local: valueFrom(patch, 'local', 'Local') ?? this.local,
      remote: valueFrom(patch, 'remote', 'Remote') ?? this.remote,
      node: valueFrom(patch, 'node', 'Node') ?? this.node,
      shortcut: valueFrom(patch, 'shortcut', 'shortCut', 'Shortcut') ?? this.shortcut,
    });
  }

  toJSON() {
    return {
      name: this.name,
      local: this.local,
      remote: this.remote,
      node: this.node,
      shortcut: this.shortcut,
    };
  }

  static fromJSON(value) { return new Bookmark(value); }
}

function compareText(a, b) {
  return a.localeCompare(b, 'en', { sensitivity: 'base' }) || (a < b ? -1 : a > b ? 1 : 0);
}

function cloneBookmark(value) { return value instanceof Bookmark ? value : new Bookmark(value); }

/** One ordered list for a site or for the shared scope. */
class BookmarkList {
  constructor(values = [], options = {}) {
    if (!Array.isArray(values)) throw new BookmarkValidationError('Bookmark list must be an array.');
    this._items = [];
    this._openedNodes = new Set();
    this._modified = false;
    this._onDuplicate = options.onDuplicate || 'reject';
    this._onShortcutDuplicate = options.onShortcutDuplicate || 'reject';
    if (!['reject', 'skip', 'replace', 'rename'].includes(this._onDuplicate)) {
      throw new BookmarkValidationError(`Unknown duplicate policy '${this._onDuplicate}'.`);
    }
    if (!['reject', 'skip', 'replace'].includes(this._onShortcutDuplicate)) {
      throw new BookmarkValidationError(`Unknown shortcut duplicate policy '${this._onShortcutDuplicate}'.`);
    }
    for (const value of values) this.add(value, { onDuplicate: this._onDuplicate });
    this._modified = false;
  }

  get count() { return this._items.length; }
  get length() { return this._items.length; }
  get modified() { return this._modified; }
  get items() { return this._items.slice(); }
  get openedNodes() { return [...this._openedNodes].sort(compareText); }

  at(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.count) return null;
    return this._items[index];
  }

  [Symbol.iterator]() { return this._items[Symbol.iterator](); }

  findByName(name, node = '') {
    const candidate = new Bookmark({ name, node });
    return this.findByKey(candidate.key);
  }

  findByKey(key) {
    if (typeof key !== 'string') return null;
    return this._items.find((item) => item.key === key || item.key === fold(key)) || null;
  }

  findByShortcut(shortcut) {
    const value = validateShortcut(shortcut);
    return value === 0 ? null : this._items.find((item) => item.shortcut === value) || null;
  }

  /** WinSCP's TBookmarkList::ShortCuts: occupied shortcuts, in bookmark order. */
  shortcuts() {
    return this._items
      .filter((item) => item.shortcut !== 0)
      .map((item) => item.shortcut);
  }

  _indexOf(ref) {
    if (ref instanceof Bookmark) return this._items.findIndex((item) => item.key === ref.key);
    if (Number.isInteger(ref)) return ref >= 0 && ref < this.count ? ref : -1;
    if (typeof ref === 'string') return this._items.findIndex((item) => item.key === ref || item.key === fold(ref));
    return -1;
  }

  _duplicateFor(candidate, except = null) {
    return this._items.find((item) => item.key === candidate.key && item !== except) || null;
  }

  _shortcutDuplicateFor(candidate, except = null) {
    if (candidate.shortcut === 0) return null;
    return this._items.find((item) => item.shortcut === candidate.shortcut && item !== except) || null;
  }

  _renamed(candidate) {
    const base = candidate.name;
    for (let suffix = 2; suffix < Number.MAX_SAFE_INTEGER; suffix++) {
      const name = `${base} (${suffix})`;
      const renamed = candidate.with({ name });
      if (!this._duplicateFor(renamed) && !this._shortcutDuplicateFor(renamed)) return renamed;
    }
    throw new DuplicateBookmarkError(`Could not find a unique name for '${base}'.`);
  }

  _prepare(candidate, options, except = null) {
    let result = candidate;
    const duplicate = this._duplicateFor(result, except);
    const shortcutDuplicate = this._shortcutDuplicateFor(result, except);
    const onDuplicate = options.onDuplicate || this._onDuplicate;
    const onShortcutDuplicate = options.onShortcutDuplicate || this._onShortcutDuplicate;

    if (duplicate) {
      if (onDuplicate === 'skip') return { action: 'skipped', bookmark: duplicate };
      if (onDuplicate === 'replace') return { action: 'replaced', bookmark: result, existing: duplicate };
      if (onDuplicate === 'rename') result = this._renamed(result);
      else throw new DuplicateBookmarkError(`Bookmark '${candidate.name}' already exists in '${candidate.node || '/'}'.`, {
        existing: duplicate, candidate,
      });
    }
    if (shortcutDuplicate) {
      if (onShortcutDuplicate === 'skip') return { action: 'skipped', bookmark: shortcutDuplicate };
      if (onShortcutDuplicate === 'replace') return { action: 'replaced', bookmark: result, existing: shortcutDuplicate };
      throw new DuplicateBookmarkError(`Shortcut ${candidate.shortcut} is already assigned to '${shortcutDuplicate.name}'.`, {
        code: 'DUPLICATE_BOOKMARK_SHORTCUT', existing: shortcutDuplicate, candidate: result,
      });
    }
    return { action: duplicate ? 'renamed' : 'added', bookmark: result, existing: duplicate };
  }

  addWithResult(value, options = {}) {
    const candidate = cloneBookmark(value);
    const prepared = this._prepare(candidate, options);
    if (prepared.action === 'skipped') return prepared;
    if (prepared.action === 'replaced') {
      const index = this._items.indexOf(prepared.existing);
      this._items[index] = prepared.bookmark;
    } else {
      const index = options.index === undefined ? this.count : options.index;
      if (!Number.isInteger(index) || index < 0 || index > this.count) {
        throw new BookmarkValidationError('Bookmark insertion index is out of range.', { field: 'index' });
      }
      this._items.splice(index, 0, prepared.bookmark);
    }
    this._modified = true;
    return prepared;
  }

  add(value, options = {}) { return this.addWithResult(value, options).bookmark; }

  insert(index, value, options = {}) { return this.add(value, { ...options, index }); }

  update(ref, patch, options = {}) {
    const index = this._indexOf(ref);
    if (index < 0) return null;
    const previous = this._items[index];
    const candidate = previous.with(patch);
    const prepared = this._prepare(candidate, options, previous);
    if (prepared.action === 'skipped') return prepared.bookmark;
    if (prepared.action === 'replaced') {
      const replaceIndex = this._items.indexOf(prepared.existing);
      this._items[replaceIndex] = prepared.bookmark;
      if (replaceIndex !== index) this._items.splice(index, 1);
    } else {
      this._items[index] = prepared.bookmark;
    }
    this._modified = true;
    return prepared.bookmark;
  }

  rename(ref, name, options = {}) { return this.update(ref, { name }, options); }

  remove(ref) {
    const index = this._indexOf(ref);
    if (index < 0) return null;
    const [removed] = this._items.splice(index, 1);
    this._modified = true;
    return removed;
  }

  delete(ref) { return this.remove(ref); }

  move(ref, index) {
    const from = this._indexOf(ref);
    if (from < 0) return null;
    if (!Number.isInteger(index) || index < 0 || index >= this.count) {
      throw new BookmarkValidationError('Bookmark destination index is out of range.', { field: 'index' });
    }
    if (from === index) return this._items[from];
    const [item] = this._items.splice(from, 1);
    this._items.splice(index, 0, item);
    this._modified = true;
    return item;
  }

  moveTo(targetRef, bookmarkRef, before = true) {
    const target = this._indexOf(targetRef);
    const bookmark = this._indexOf(bookmarkRef);
    if (target < 0 || bookmark < 0) return null;
    let destination = before ? target : target + 1;
    if (bookmark < destination) destination--;
    destination = Math.max(0, Math.min(destination, this.count - 1));
    return this.move(bookmark, destination);
  }

  clear() {
    const removed = this.count;
    if (removed || this._openedNodes.size) this._modified = true;
    this._items = [];
    this._openedNodes.clear();
    return removed;
  }

  isNodeOpened(node) {
    return this._openedNodes.has(validateNode(node));
  }

  setNodeOpened(node, opened) {
    const value = validateNode(node);
    if (value === '') throw new BookmarkValidationError('The root folder cannot be opened as a bookmark folder.', { field: 'node' });
    const has = this._openedNodes.has(value);
    if (Boolean(opened) !== has) {
      if (opened) this._openedNodes.add(value); else this._openedNodes.delete(value);
      this._modified = true;
    }
    return Boolean(opened);
  }

  toJSON() {
    return {
      version: SCHEMA_VERSION,
      bookmarks: this._items.map((item) => item.toJSON()),
      openedNodes: this.openedNodes,
    };
  }

  serialize() { return JSON.stringify(this.toJSON()); }

  static fromJSON(value, options = {}) {
    let raw = value;
    try {
      if (typeof raw === 'string') raw = JSON.parse(raw);
    } catch (error) {
      throw new BookmarkSerializationError(`Bookmark JSON could not be parsed: ${error.message}`, { cause: error });
    }
    if (!isPlainObject(raw)) throw new BookmarkSerializationError('Bookmark list must be a JSON object.');
    if (raw.version !== undefined && raw.version !== SCHEMA_VERSION) {
      throw new BookmarkSerializationError(`Unsupported bookmark schema version '${raw.version}'.`, { version: raw.version });
    }
    const values = raw.bookmarks || raw.items;
    if (!Array.isArray(values)) throw new BookmarkSerializationError('Bookmark list has no bookmarks array.');
    const list = new BookmarkList([], options);
    for (const item of values) {
      try { list.add(item, options); }
      catch (error) {
        if (error instanceof BookmarkError) throw error;
        throw new BookmarkSerializationError(`Bookmark item could not be loaded: ${error.message}`, { cause: error });
      }
    }
    if (raw.openedNodes !== undefined) {
      if (!Array.isArray(raw.openedNodes)) throw new BookmarkSerializationError('openedNodes must be an array.');
      for (const node of raw.openedNodes) list.setNodeOpened(node, true);
    }
    list._modified = false;
    return list;
  }
}

function scopeForSession(session) {
  if (!isPlainObject(session)) throw new BookmarkValidationError('A session object is required to find its bookmark scope.');
  const scope = sessionKey(session);
  return validateScope(scope);
}

function normalizeScope(scope) {
  if (scope === undefined || scope === null || scope === '' || scope === 'shared') return SHARED_SCOPE;
  return validateScope(scope);
}

/** The per-site plus shared collection used by the application configuration. */
class Bookmarks {
  constructor(input = {}, options = {}) {
    if (!isPlainObject(input)) throw new BookmarkValidationError('Bookmark store must be created from an object.');
    this._options = { ...options };
    this._lists = new Map();
    this._lists.set(SHARED_SCOPE, new BookmarkList([], options));

    const lists = input.lists || input.scopes || {};
    if (!isPlainObject(lists)) throw new BookmarkSerializationError('Bookmark store lists must be an object.');
    let sharedLoaded = false;
    for (const scope of Object.keys(lists)) {
      const key = normalizeScope(scope);
      if (this._lists.has(key)) {
        if (key === SHARED_SCOPE && !sharedLoaded) {
          this._lists.set(key, BookmarkList.fromJSON(lists[scope], options));
          sharedLoaded = true;
          continue;
        }
        throw new DuplicateBookmarkError(`Bookmark scope '${scope}' appears more than once.`, { code: 'DUPLICATE_BOOKMARK_SCOPE' });
      }
      this._lists.set(key, BookmarkList.fromJSON(lists[scope], options));
      if (key === SHARED_SCOPE) sharedLoaded = true;
    }
    // A legacy/export-friendly top-level bookmarks array is the shared list.
    if (Array.isArray(input.bookmarks)) {
      const shared = BookmarkList.fromJSON({ bookmarks: input.bookmarks, openedNodes: input.openedNodes }, options);
      this._lists.set(SHARED_SCOPE, shared);
    }
  }

  get shared() { return this.list(SHARED_SCOPE); }
  get sharedBookmarks() { return this.shared; }

  list(scope = SHARED_SCOPE) {
    const key = normalizeScope(scope);
    let list = this._lists.get(key);
    if (!list) {
      list = new BookmarkList([], this._options);
      this._lists.set(key, list);
    }
    return list;
  }

  listForSession(session) { return this.list(scopeForSession(session)); }

  scopes() { return [...this._lists.keys()].sort(compareText); }

  add(scope, value, options = {}) { return this.list(scope).add(value, options); }
  addForSession(session, value, options = {}) { return this.listForSession(session).add(value, options); }
  remove(scope, ref) { return this.list(scope).remove(ref); }
  removeForSession(session, ref) { return this.listForSession(session).remove(ref); }

  deleteScope(scope) {
    const key = normalizeScope(scope);
    if (key === SHARED_SCOPE) return false;
    return this._lists.delete(key);
  }

  toJSON() {
    const lists = {};
    for (const scope of this.scopes()) lists[scope] = this._lists.get(scope).toJSON();
    return { schema: SCHEMA_NAME, version: SCHEMA_VERSION, lists };
  }

  serialize() { return JSON.stringify(this.toJSON()); }

  static fromJSON(value, options = {}) {
    let raw = value;
    try {
      if (typeof raw === 'string') raw = JSON.parse(raw);
    } catch (error) {
      throw new BookmarkSerializationError(`Bookmark JSON could not be parsed: ${error.message}`, { cause: error });
    }
    if (!isPlainObject(raw)) throw new BookmarkSerializationError('Bookmark store must be a JSON object.');
    if (raw.schema !== undefined && raw.schema !== SCHEMA_NAME) {
      throw new BookmarkSerializationError(`Unsupported bookmark schema '${raw.schema}'.`, { schema: raw.schema });
    }
    if (raw.version !== undefined && raw.version !== SCHEMA_VERSION) {
      throw new BookmarkSerializationError(`Unsupported bookmark schema version '${raw.version}'.`, { version: raw.version });
    }
    return new Bookmarks(raw, options);
  }
}

function createBookmark(value) { return new Bookmark(value); }
function createBookmarkList(values, options) { return new BookmarkList(values, options); }
function createBookmarks(input, options) { return new Bookmarks(input, options); }

module.exports = {
  SCHEMA_NAME,
  SCHEMA_VERSION,
  SHARED_SCOPE,
  MAX_NAME_LENGTH,
  MAX_NODE_LENGTH,
  MAX_DIRECTORY_LENGTH,
  MAX_SCOPE_LENGTH,
  MAX_SHORTCUT,
  BookmarkError,
  BookmarkValidationError,
  DuplicateBookmarkError,
  BookmarkSerializationError,
  Bookmark,
  BookmarkList,
  Bookmarks,
  bookmarkKey,
  scopeForSession,
  createBookmark,
  createBookmarkList,
  createBookmarks,
};
