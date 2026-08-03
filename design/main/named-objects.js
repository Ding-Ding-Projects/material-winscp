'use strict';

// A small lifecycle boundary for objects that cross session, queue, operation,
// and renderer-bridge code. The registry deliberately stores no user data in
// its export format: names and kinds are identifiers, not object snapshots.

const KINDS = Object.freeze(['session', 'queue-item', 'operation', 'ui-bridge']);
const DEFAULT_MAX_ENTRIES = 1024;
const DEFAULT_MAX_NAME_LENGTH = 80;
const NAME_RE = /^[A-Za-z][A-Za-z0-9_.:-]*$/;
const COLLISIONS = Object.freeze(['suffix', 'error']);
const OWNERSHIP = Object.freeze(['explicit', 'weak']);

function failure(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isObject(value) {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

function validateKind(kind) {
  if (!KINDS.includes(kind)) throw failure(`Unsupported named-object kind: ${kind}`, 'INVALID_KIND');
  return kind;
}

function validateName(name, maxLength, label = 'Name') {
  if (typeof name !== 'string' || name.length === 0 || name.length > maxLength || !NAME_RE.test(name)) {
    throw failure(`${label} must be a bounded identifier`, 'INVALID_NAME');
  }
  return name;
}

function validateOwner(owner) {
  if (!isObject(owner)) throw failure('Owner must be an object or function', 'INVALID_OWNER');
  return owner;
}

function sortedNames(records) {
  return [...records.keys()].sort((a, b) => a.localeCompare(b));
}

class NamedObjectRegistry {
  /**
   * @param {{maxEntries?: number, maxNameLength?: number}} [options]
   */
  constructor(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('Registry options must be an object');
    }
    const maxEntries = options.maxEntries === undefined ? DEFAULT_MAX_ENTRIES : options.maxEntries;
    const maxNameLength = options.maxNameLength === undefined ? DEFAULT_MAX_NAME_LENGTH : options.maxNameLength;
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw failure('maxEntries must be a positive safe integer', 'INVALID_LIMIT');
    }
    if (!Number.isSafeInteger(maxNameLength) || maxNameLength < 8 || maxNameLength > 256) {
      throw failure('maxNameLength must be a safe integer from 8 to 256', 'INVALID_LIMIT');
    }

    this.maxEntries = maxEntries;
    this.maxNameLength = maxNameLength;
    this.records = new Map();
    this.ownerIds = new WeakMap();
    this.ownerTokens = new Map();
    this.nextOwnerId = 1;
    this.nextSerial = 1;
    this.nextGenerated = new Map();
    this.valueFinalizer = typeof FinalizationRegistry === 'function'
      ? new FinalizationRegistry((token) => this._valueCollected(token))
      : null;
    this.ownerFinalizer = typeof FinalizationRegistry === 'function'
      ? new FinalizationRegistry((token) => this._ownerCollected(token))
      : null;
  }

  get size() {
    this.sweep();
    return this.records.size;
  }

  _ownerId(owner) {
    if (!owner) return null;
    const existing = this.ownerIds.get(owner);
    if (existing) return existing;
    const id = this.nextOwnerId++;
    this.ownerIds.set(owner, id);
    return id;
  }

  _ensureOwnerFinalizer(owner, ownerId) {
    if (!this.ownerFinalizer || this.ownerTokens.has(ownerId)) return;
    const token = {};
    this.ownerTokens.set(ownerId, token);
    this.ownerFinalizer.register(owner, { ownerId }, token);
  }

  _nextName(kind) {
    let sequence = this.nextGenerated.get(kind) || 1;
    while (true) {
      const name = `${kind}-${sequence}`;
      sequence += 1;
      if (name.length <= this.maxNameLength && !this.records.has(name)) {
        this.nextGenerated.set(kind, sequence);
        return name;
      }
      if (sequence > this.maxEntries + 1 || `${kind}-${sequence}`.length > this.maxNameLength) {
        throw failure(`No generated name is available for ${kind}`, 'NAME_SPACE_EXHAUSTED');
      }
    }
  }

  _collisionFree(base) {
    if (!this.records.has(base)) return base;
    for (let suffix = 2; suffix <= this.maxEntries + 1; suffix += 1) {
      const name = `${base}-${suffix}`;
      if (name.length > this.maxNameLength) break;
      if (!this.records.has(name)) return name;
    }
    throw failure(`No collision-free name is available for ${base}`, 'NAME_SPACE_EXHAUSTED');
  }

  _deref(record) {
    const value = record.weak ? record.valueRef.deref() : record.value;
    if (value === undefined) this._remove(record.name, record);
    return value;
  }

  _remove(name, expected) {
    const record = this.records.get(name);
    if (!record || (expected && record !== expected)) return false;
    this.records.delete(name);
    if (record.weak && this.valueFinalizer) this.valueFinalizer.unregister(record.valueToken);
    if (record.ownership === 'weak' && record.ownerId !== null) {
      // The unregister token can still be shared by other records owned by the
      // same object, so only remove it when no weak record uses that owner id.
      const stillOwned = [...this.records.values()].some((item) => item.ownerId === record.ownerId && item.ownership === 'weak');
      if (!stillOwned) {
        const token = this.ownerTokens.get(record.ownerId);
        if (token && this.ownerFinalizer) this.ownerFinalizer.unregister(token);
        this.ownerTokens.delete(record.ownerId);
      }
    }
    return true;
  }

  _valueCollected(token) {
    const record = this.records.get(token.name);
    if (record && record.serial === token.serial) this._remove(record.name, record);
  }

  _ownerCollected(token) {
    for (const record of [...this.records.values()]) {
      if (record.ownerId === token.ownerId && record.ownership === 'weak') this._remove(record.name, record);
    }
    this.ownerTokens.delete(token.ownerId);
  }

  /** Remove weak entries whose values have already become unreachable. */
  sweep() {
    let removed = 0;
    for (const record of [...this.records.values()]) {
      if (record.weak && record.valueRef.deref() === undefined && this._remove(record.name, record)) removed += 1;
    }
    return removed;
  }

  /**
   * Register an object and return an explicit lease for deterministic disposal.
   * Weak ownership also removes all of an owner's entries when the owner is
   * collected, while explicit ownership retains no owner object and requires a
   * lease or disposeOwner(owner) call.
   */
  register(kind, value, options = {}) {
    validateKind(kind);
    if (!isObject(value)) throw failure('Registered value must be an object or function', 'INVALID_VALUE');
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('Registration options must be an object');
    }
    this.sweep();
    if (this.records.size >= this.maxEntries) throw failure('Named-object registry limit exceeded', 'REGISTRY_LIMIT');

    const ownership = options.ownership === undefined ? 'explicit' : options.ownership;
    if (!OWNERSHIP.includes(ownership)) throw failure(`Unsupported ownership mode: ${ownership}`, 'INVALID_OWNERSHIP');
    const collision = options.collision === undefined ? 'suffix' : options.collision;
    if (!COLLISIONS.includes(collision)) throw failure(`Unsupported collision policy: ${collision}`, 'INVALID_COLLISION');
    const owner = options.owner === undefined || options.owner === null ? null : validateOwner(options.owner);
    if (ownership === 'weak' && !owner) throw failure('Weak ownership requires an owner', 'OWNER_REQUIRED');

    const requested = options.name === undefined ? this._nextName(kind) : validateName(options.name, this.maxNameLength);
    const name = this.records.has(requested)
      ? (collision === 'error' ? (() => { throw failure(`Named-object collision: ${requested}`, 'NAME_COLLISION'); })() : this._collisionFree(requested))
      : requested;
    const ownerId = this._ownerId(owner);
    const weak = options.weak === undefined ? ownership === 'weak' : Boolean(options.weak);
    if (weak && typeof WeakRef !== 'function') throw failure('Weak references are not supported by this runtime', 'WEAK_UNSUPPORTED');
    const serial = this.nextSerial++;
    const record = {
      name,
      kind,
      ownership,
      ownerId,
      weak,
      serial,
      value: weak ? undefined : value,
      valueRef: weak ? new WeakRef(value) : null,
      valueToken: weak ? {} : null,
    };
    this.records.set(name, record);
    if (weak && this.valueFinalizer) this.valueFinalizer.register(value, { name, serial }, record.valueToken);
    if (ownership === 'weak') this._ensureOwnerFinalizer(owner, ownerId);

    let disposed = false;
    const thisRegistry = this;
    return Object.freeze({
      name,
      kind,
      get disposed() { return disposed || !thisRegistry.records.has(name); },
      get: () => {
        if (disposed) return undefined;
        const current = thisRegistry.records.get(name);
        return current && current.serial === serial ? thisRegistry._deref(current) : undefined;
      },
      dispose: () => {
        if (disposed) return false;
        disposed = true;
        return thisRegistry._remove(name, record);
      },
    });
  }

  get(name, options = {}) {
    validateName(name, this.maxNameLength);
    const record = this.records.get(name);
    if (!record) return undefined;
    if (options && options.kind !== undefined && validateKind(options.kind) !== record.kind) return undefined;
    return this._deref(record);
  }

  has(name, options = {}) {
    return this.get(name, options) !== undefined;
  }

  /** Return live values in lexical name order. */
  find(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('Lookup options must be an object');
    const kind = options.kind === undefined ? undefined : validateKind(options.kind);
    const ownerId = options.owner === undefined || options.owner === null ? undefined : this._ownerId(validateOwner(options.owner));
    const found = [];
    for (const name of sortedNames(this.records)) {
      const record = this.records.get(name);
      if (kind !== undefined && record.kind !== kind) continue;
      if (ownerId !== undefined && record.ownerId !== ownerId) continue;
      const value = this._deref(record);
      if (value !== undefined) found.push({ name, kind: record.kind, value });
    }
    return found;
  }

  dispose(name) {
    validateName(name, this.maxNameLength);
    return this._remove(name);
  }

  /** Dispose every entry owned by the supplied object, regardless of mode. */
  disposeOwner(owner) {
    const ownerId = this._ownerId(validateOwner(owner));
    let removed = 0;
    for (const record of [...this.records.values()]) {
      if (record.ownerId === ownerId && this._remove(record.name, record)) removed += 1;
    }
    return removed;
  }

  disposeAll(options = {}) {
    const kind = options.kind === undefined ? undefined : validateKind(options.kind);
    let removed = 0;
    for (const record of [...this.records.values()]) {
      if (kind === undefined || record.kind === kind) {
        if (this._remove(record.name, record)) removed += 1;
      }
    }
    return removed;
  }

  /** Only stable identifiers are exported; values, owners, and metadata stay private. */
  identifiers() {
    this.sweep();
    return sortedNames(this.records).map((name) => {
      const record = this.records.get(name);
      return { name: record.name, kind: record.kind };
    });
  }

  serialize() {
    return JSON.stringify(this.identifiers());
  }
}

module.exports = {
  NamedObjectRegistry,
  KINDS,
  OWNERSHIP,
  COLLISIONS,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_MAX_NAME_LENGTH,
};
