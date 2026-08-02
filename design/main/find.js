// find.js — recursive file search over any adapter.
//
// Port of the Find dialog's search loop (forms/FileFind.cpp) onto the Adapter
// contract, so the same search runs over the local disk, an SFTP server or an
// S3 bucket without knowing which.
//
// Results are STREAMED. A search over a large remote tree can take minutes and
// the user wants the first hit immediately, not a list when it is all over —
// so the core is an async generator and the EventEmitter wrapper is a thin
// convenience over it.
//
// Content search ("containing text") is streamed too, line by line, which is
// what makes it safe on a 4 GB log: a match never needs more than one line in
// memory, boundaries between read chunks cannot split a match, and a file that
// looks binary is skipped rather than scanned byte by byte for a string that
// could not be there.
'use strict';

const { EventEmitter } = require('events');
const { StringDecoder } = require('string_decoder');

const { FileMask } = require('./masks');

const DEFAULTS = {
  mask: '',                 // WinSCP file mask, '' matches everything
  grep: null,               // string or RegExp — search inside file contents
  caseSensitive: false,
  regex: false,             // treat a string `grep` as a regular expression
  wholeWord: false,
  maxDepth: Infinity,       // 0 = only the root directory's own entries
  followSymlinks: false,
  includeDirectories: true, // may a directory itself be a result?
  includeFiles: true,
  hidden: true,             // include hidden entries
  limit: Infinity,          // stop after this many results
  maxFileSize: 32 * 1024 * 1024,  // never grep a file bigger than this
  maxLineLength: 1024 * 1024,     // a "line" this long is flushed as-is
  encoding: 'utf8',
  searchBinary: false,      // grep files that look binary
  maxMatchesPerFile: 100,
  signal: null,             // AbortSignal
};

class SearchCancelled extends Error {
  constructor() { super('Search cancelled'); this.name = 'SearchCancelled'; }
}

/** Build the content matcher from the `grep` option. */
function buildMatcher(options) {
  const { grep } = options;
  if (!grep) return null;
  if (grep instanceof RegExp) {
    // Strip 'g'/'y': a sticky or global regex carries lastIndex between calls,
    // which would silently skip matches on later lines.
    const flags = grep.flags.replace(/[gy]/g, '');
    return { re: new RegExp(grep.source, flags), source: grep.source };
  }
  const text = String(grep);
  let source = options.regex ? text : text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (options.wholeWord) source = `\\b(?:${source})\\b`;
  return { re: new RegExp(source, options.caseSensitive ? '' : 'i'), source };
}

/** Cheap binary sniff: a NUL byte in the first block means "not text". */
function looksBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/**
 * Stream a file and return the lines matching `matcher`.
 * Returns null when the file was skipped (too big, or binary).
 */
async function grepFile(adapter, path, size, matcher, options) {
  if (size > options.maxFileSize) return null;

  const rs = await adapter.createReadStream(path, {});
  const decoder = new StringDecoder(options.encoding);
  const matches = [];
  let pending = '';
  let lineNumber = 0;
  let first = true;

  const testLine = (line) => {
    lineNumber += 1;
    if (matches.length >= options.maxMatchesPerFile) return;
    const m = matcher.re.exec(line);
    if (m) {
      matches.push({ lineNumber, line: line.length > 4096 ? `${line.slice(0, 4096)}…` : line, index: m.index });
    }
  };

  try {
    for await (const chunk of rs) {
      if (options.signal && options.signal.aborted) throw new SearchCancelled();
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (first) {
        first = false;
        if (!options.searchBinary && looksBinary(buf)) {
          if (typeof rs.destroy === 'function') rs.destroy();
          return null;
        }
      }
      pending += decoder.write(buf);
      let nl = pending.indexOf('\n');
      while (nl >= 0) {
        const line = pending[nl - 1] === '\r' ? pending.slice(0, nl - 1) : pending.slice(0, nl);
        testLine(line);
        pending = pending.slice(nl + 1);
        nl = pending.indexOf('\n');
      }
      // A file with no newlines must not grow the buffer without bound.
      if (pending.length > options.maxLineLength) {
        testLine(pending);
        pending = '';
      }
    }
    pending += decoder.end();
    if (pending.length) testLine(pending);
  } finally {
    if (typeof rs.destroy === 'function' && !rs.destroyed) rs.destroy();
  }

  return matches;
}

/**
 * The search itself, as an async generator.
 *
 *   for await (const hit of search(adapter, '/var/log', { mask: '*.log', grep: 'error' })) ...
 *
 * Each hit is { path, name, type, size, mtime, depth, entry, matches }.
 * `matches` is present only when a content search was requested.
 *
 * Errors reading one directory are reported through `options.onError` (or
 * skipped) instead of aborting the walk: one unreadable directory in a large
 * tree should not lose every result found so far.
 */
async function* search(adapter, root, userOptions = {}) {
  const options = { ...DEFAULTS, ...userOptions };
  const matcher = buildMatcher(options);
  const mask = new FileMask(options.mask, { caseSensitive: options.caseSensitive, root });

  const checkCancel = () => {
    if (options.signal && options.signal.aborted) throw new SearchCancelled();
  };

  // Guards against a symlink cycle turning the walk into an infinite one.
  const visited = new Set();
  let yielded = 0;

  const startPath = adapter.normalize(root);
  const stack = [{ path: startPath, depth: 0 }];

  while (stack.length) {
    checkCancel();
    const { path, depth } = stack.pop();

    if (options.followSymlinks) {
      let real = path;
      try { real = await adapter.realpath(path); } catch { real = path; }
      if (visited.has(real)) continue;
      visited.add(real);
    }

    let entries;
    try {
      entries = await adapter.list(path);
    } catch (err) {
      err.searchPath = path;
      if (options.onError) options.onError(err, path);
      if (options.throwOnError) throw err;
      continue;
    }

    // Depth-first, and alphabetical within a directory, so the output order is
    // reproducible instead of whatever the server happened to return.
    const sorted = entries
      .filter((e) => e.name !== '.' && e.name !== '..')
      .sort((a, b) => a.name.localeCompare(b.name));

    const descend = [];
    for (const entry of sorted) {
      checkCancel();
      if (!options.hidden && entry.hidden) continue;

      const full = adapter.join(path, entry.name);
      const isDir = entry.type === 'dir';
      const params = {
        isDir, size: entry.size, mtime: entry.mtime, path: full, root: startPath,
      };
      const verdict = mask.matchesEx(entry.name, params);

      if (isDir) {
        if (verdict.matched && options.includeDirectories && !matcher) {
          yield {
            path: full, name: entry.name, type: 'dir', size: entry.size,
            mtime: entry.mtime, depth, entry, matches: null,
          };
          yielded += 1;
          if (yielded >= options.limit) return;
        }
        // An explicitly excluded directory is pruned; that is what stops the
        // walk descending into node_modules when the mask said not to.
        if (verdict.matched && depth < options.maxDepth) {
          if (entry.isSymlink && !options.followSymlinks) continue;
          descend.push({ path: full, depth: depth + 1 });
        }
        continue;
      }

      if (!options.includeFiles) continue;
      if (!verdict.matched) continue;
      if (entry.isSymlink && !options.followSymlinks && entry.type === 'link') continue;

      let matches = null;
      if (matcher) {
        try {
          matches = await grepFile(adapter, full, entry.size || 0, matcher, options);
        } catch (err) {
          if (err instanceof SearchCancelled) throw err;
          err.searchPath = full;
          if (options.onError) options.onError(err, full);
          if (options.throwOnError) throw err;
          continue;
        }
        if (!matches || matches.length === 0) continue;   // skipped or no hit
      }

      yield {
        path: full, name: entry.name, type: entry.type, size: entry.size,
        mtime: entry.mtime, depth, entry, matches,
      };
      yielded += 1;
      if (yielded >= options.limit) return;
    }

    // Push in reverse so the stack pops them back in alphabetical order.
    for (let i = descend.length - 1; i >= 0; i--) stack.push(descend[i]);
  }
}

/**
 * EventEmitter wrapper for the UI, which wants results pushed at it rather
 * than pulled. Emits 'match', 'error', 'done' and supports cancel().
 */
class Finder extends EventEmitter {
  constructor(adapter, root, options = {}) {
    super();
    this.adapter = adapter;
    this.root = root;
    this.options = options;
    this.results = [];
    this.done = false;
    this.cancelled = false;
    this._controller = new AbortController();
  }

  cancel() {
    this.cancelled = true;
    this._controller.abort();
    return this;
  }

  /** Runs the search; resolves with the collected results. */
  async run() {
    const options = {
      ...this.options,
      signal: this.options.signal || this._controller.signal,
      onError: (err, path) => this.emit('error', err, path),
    };
    try {
      for await (const hit of search(this.adapter, this.root, options)) {
        this.results.push(hit);
        this.emit('match', hit);
      }
      this.done = true;
      this.emit('done', { results: this.results, cancelled: false });
    } catch (err) {
      this.done = true;
      if (err instanceof SearchCancelled || this.cancelled) {
        this.emit('done', { results: this.results, cancelled: true });
      } else {
        this.emit('error', err, this.root);
        this.emit('done', { results: this.results, cancelled: false, error: err });
        throw err;
      }
    }
    return this.results;
  }

  /** Lets a caller iterate the Finder directly, same stream, no collection. */
  [Symbol.asyncIterator]() {
    const options = {
      ...this.options,
      signal: this.options.signal || this._controller.signal,
      onError: (err, path) => this.emit('error', err, path),
    };
    return search(this.adapter, this.root, options)[Symbol.asyncIterator]();
  }
}

/** Start a search and return the Finder (already running). */
function find(adapter, root, options = {}) {
  const finder = new Finder(adapter, root, options);
  // Swallow here: the rejection is already reported through 'error'/'done',
  // and an unhandled rejection would take the process down.
  finder.run().catch(() => {});
  return finder;
}

/** Convenience: run to completion and return an array. */
async function findAll(adapter, root, options = {}) {
  const out = [];
  for await (const hit of search(adapter, root, options)) out.push(hit);
  return out;
}

module.exports = {
  search,
  find,
  findAll,
  Finder,
  grepFile,
  buildMatcher,
  looksBinary,
  SearchCancelled,
  DEFAULTS,
};
