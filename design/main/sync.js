// sync.js — directory comparison and synchronization.
//
// Port of TTerminal::SynchronizeCollectDirectory / SynchronizedFileCheckModified
// (core/Terminal.cpp) and TSynchronizeChecklist (core/RemoteFiles.h), driven
// entirely through the Adapter contract so "local vs remote" is really just
// "side A vs side B" and works for every protocol pair.
//
// Vocabulary, kept deliberately identical to WinSCP's dialog:
//
//   direction  local   make the LOCAL side match the remote  (downloads)
//              remote  make the REMOTE side match the local  (uploads)
//              both    propagate whichever side is newer
//   mode       synchronize  ordinary two-way/one-way transfer
//              mirror       the target becomes a copy of the source even when
//                           the target's file is the newer one
//              timestamp    only timestamps are touched, never content
//   criteria   time | size | either | none
//
// Some combinations are refused rather than guessed at, because WinSCP itself
// forbids them (the dialog greys them out) and any answer we invented would be
// wrong for half the users. See `validateOptions`.
//
// The DST handling is the reason this file exists as much as the comparison
// is: a Windows local file system and a Unix server disagree about what a
// timestamp means across a daylight-saving boundary, and getting it wrong
// makes every file in a tree look modified twice a year.
'use strict';

const { EventEmitter } = require('events');

const { FileMask } = require('./masks');
const { COPY_PARAM_DEFAULTS } = require('./defaults');

/** CompareFileTime's "FAT precision" window: under two seconds is the same. */
const DEFAULT_TIME_TOLERANCE = 2000;

const ACTIONS = ['upload', 'download', 'deleteLocal', 'deleteRemote', 'nothing'];

class SyncOptionError extends Error {
  constructor(message) { super(message); this.name = 'SyncOptionError'; }
}

// ---------------------------------------------------------------------------
// time
// ---------------------------------------------------------------------------

/**
 * Port of DSTDifferenceForTime: how far the offset in effect at `ms` sits from
 * this zone's STANDARD offset. 0 in winter, -3600000 ms in summer for a normal
 * northern-hemisphere zone (Windows' DaylightBias sign convention).
 */
function dstDifferenceMs(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  // getTimezoneOffset is minutes to ADD to local to reach UTC, so standard
  // time is whichever half of the year has the larger value. Sampling January
  // and July covers both hemispheres.
  const jan = new Date(y, 0, 1).getTimezoneOffset();
  const jul = new Date(y, 6, 1).getTimezoneOffset();
  const standard = Math.max(jan, jul);
  return (d.getTimezoneOffset() - standard) * 60000;
}

/**
 * Port of AdjustDateTimeFromUnix.
 *
 *   'unix'  (default) the server's timestamps are true UTC-based instants and
 *           need no correction. This is right for SFTP/FTP against any sane
 *           server and is why it is the default.
 *   'keep'  same arithmetic as 'unix' — the timestamps are taken as they are,
 *           including whatever DST skew the server already baked in.
 *   'win'   emulate the Windows/FAT rule, where a timestamp is re-interpreted
 *           through the offset in force *at that timestamp*. Only this mode
 *           shifts anything, and only by the DST difference for that date.
 *
 * Applied to the REMOTE side, because that is the side whose timestamps came
 * off the wire as Unix seconds.
 */
function adjustRemoteTime(ms, dSTMode, timeDifferenceSeconds) {
  let out = ms;
  if (timeDifferenceSeconds) out += timeDifferenceSeconds * 1000;
  if (dSTMode === 'win') out += dstDifferenceMs(out);
  return out;
}

/** Port of CompareFileTime with a configurable tolerance. */
function compareTime(t1, t2, tolerance) {
  const tol = tolerance === undefined ? DEFAULT_TIME_TOLERANCE : tolerance;
  if (t1 === t2) return 0;
  if (t1 < t2 && t2 - t1 >= tol) return -1;
  if (t1 > t2 && t1 - t2 >= tol) return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// options
// ---------------------------------------------------------------------------

const OPTION_DEFAULTS = {
  direction: 'both',        // local | remote | both
  mode: 'synchronize',      // synchronize | mirror | timestamp
  criteria: 'time',         // time | size | either | none
  recursive: true,
  deleteFiles: false,
  existingOnly: false,
  preview: false,           // include unchanged pairs so the whole tree is shown
  caseSensitive: false,
  transferMode: 'binary',   // passed through to the copyParam apply() builds
  fileMask: '',
  excludeHiddenFiles: false,
  timeTolerance: DEFAULT_TIME_TOLERANCE,
  dSTMode: 'unix',          // unix | keep | win
  timeDifference: 0,        // seconds, per-site clock correction
  followDirectorySymlinks: false,
  copyParam: null,
};

/**
 * Reject the combinations WinSCP itself forbids. Guessing here would be worse
 * than refusing: with criteria "size" and direction "both" there is no answer
 * to "which side wins" that is right more than half the time.
 */
function validateOptions(o) {
  if (!['local', 'remote', 'both'].includes(o.direction)) {
    throw new SyncOptionError(`Unknown direction "${o.direction}". Expected local, remote or both.`);
  }
  if (!['synchronize', 'mirror', 'timestamp'].includes(o.mode)) {
    throw new SyncOptionError(`Unknown mode "${o.mode}". Expected synchronize, mirror or timestamp.`);
  }
  if (!['time', 'size', 'either', 'none'].includes(o.criteria)) {
    throw new SyncOptionError(`Unknown criteria "${o.criteria}". Expected time, size, either or none.`);
  }

  const timestamp = o.mode === 'timestamp';
  const notByTime = o.criteria === 'size' || o.criteria === 'none';
  const bySize = o.criteria === 'size' || o.criteria === 'either';

  if (timestamp && o.deleteFiles) {
    throw new SyncOptionError('Timestamp mode never deletes anything; turn deleteFiles off.');
  }
  if (timestamp && notByTime) {
    throw new SyncOptionError(
      `Timestamp mode compares timestamps, so criteria "${o.criteria}" is meaningless. `
      + 'Use "time" or "either".');
  }
  if (o.direction === 'both' && (notByTime || bySize)) {
    throw new SyncOptionError(
      `Criteria "${o.criteria}" cannot be combined with direction "both": when the two sides `
      + 'differ only in size there is no way to tell which one should win. '
      + 'Pick a direction, or compare by time.');
  }
}

// ---------------------------------------------------------------------------
// comparison
// ---------------------------------------------------------------------------

function fileInfo(adapter, dir, entry, mtime) {
  return {
    name: entry.name,
    directory: dir,
    path: adapter.join(dir, entry.name),
    size: entry.type === 'dir' ? 0 : (entry.size || 0),
    mtime: mtime === undefined ? (entry.mtime || 0) : mtime,
    rawMtime: entry.mtime || 0,
    isDirectory: entry.type === 'dir',
    rights: entry.rights || '',
    exists: true,
  };
}

function missing(adapter, dir, name) {
  return {
    name, directory: dir, path: adapter.join(dir, name),
    size: 0, mtime: 0, rawMtime: 0, isDirectory: false, rights: '', exists: false,
  };
}

/**
 * Compare two trees and return the checklist.
 *
 * Returns { items, context, counts } where each item is
 *   { action, isDirectory, checked, reason, local, remote, timestampOnly }
 */
async function compare(localAdapter, localPath, remoteAdapter, remotePath, options = {}) {
  const o = { ...OPTION_DEFAULTS, ...options };
  validateOptions(o);

  const timestamp = o.mode === 'timestamp';
  const mirror = o.mode === 'mirror';
  const notByTime = o.criteria === 'size' || o.criteria === 'none';
  const bySize = o.criteria === 'size' || o.criteria === 'either';
  const dir = o.direction;

  const mask = new FileMask(o.fileMask, { caseSensitive: o.caseSensitive, root: localPath });
  const items = [];

  const key = (name) => (o.caseSensitive ? name : name.toLowerCase());

  const listSide = async (adapter, path, isRemote) => {
    let entries;
    try {
      entries = await adapter.list(path);
    } catch (err) {
      // A directory we cannot read is reported, not fatal: half a comparison
      // is still useful, and the caller sees exactly what was skipped.
      err.syncPath = path;
      throw err;
    }
    const out = new Map();
    for (const e of entries) {
      if (e.name === '.' || e.name === '..') continue;
      if (o.excludeHiddenFiles && e.hidden) continue;
      if (e.isSymlink && e.type === 'dir' && !o.followDirectorySymlinks) continue;
      const isDir = e.type === 'dir';
      const full = adapter.join(path, e.name);
      if (!mask.matches(e.name, {
        isDir, size: e.size, mtime: e.mtime, path: full, root: isRemote ? remotePath : localPath,
      })) continue;
      const mtime = isRemote
        ? adjustRemoteTime(e.mtime || 0, o.dSTMode, o.timeDifference)
        : (e.mtime || 0);
      const normalized = key(e.name);
      if (out.has(normalized)) {
        const prior = out.get(normalized);
        throw new SyncOptionError(
          `Case-insensitive name collision in ${path}: "${prior.name}" and "${e.name}". `
          + 'Enable case-sensitive comparison or rename one entry before synchronizing.');
      }
      out.set(normalized, fileInfo(adapter, path, e, mtime));
    }
    return out;
  };

  const walk = async (lPath, rPath) => {
    const [locals, remotes] = await Promise.all([
      listSide(localAdapter, lPath, false),
      listSide(remoteAdapter, rPath, true),
    ]);

    const seen = new Set();

    // --- items present on the remote side ---------------------------------
    for (const [k, remote] of remotes) {
      seen.add(k);
      const local = locals.get(k);

      if (!local) {
        // New on the remote side.
        if (dir === 'both' || dir === 'local') {
          if (!timestamp) {
            items.push(makeItem('download', remote.isDirectory,
              !o.existingOnly && (!remote.isDirectory || o.recursive),
              'new-on-remote', missing(localAdapter, lPath, remote.name), remote, timestamp));
          }
        } else if (dir === 'remote' && !timestamp) {
          items.push(makeItem('deleteRemote', remote.isDirectory,
            !o.existingOnly && o.deleteFiles && (!remote.isDirectory || o.recursive),
            'not-on-local', missing(localAdapter, lPath, remote.name), remote, timestamp));
        }
        continue;
      }

      if (local.isDirectory !== remote.isDirectory) {
        // A directory on one side and a file on the other is never something
        // we resolve automatically — report it and move on.
        items.push(makeItem('nothing', false, false, 'type-mismatch', local, remote, timestamp));
        continue;
      }

      if (local.isDirectory) {
        if (o.preview) {
          items.push(makeItem('nothing', true, false, 'directory', local, remote, timestamp));
        }
        if (o.recursive) await walk(local.path, remote.path);
        continue;
      }

      const decision = decide(local, remote, {
        timestamp, mirror, notByTime, bySize, direction: dir, tolerance: o.timeTolerance,
      });

      if (decision.action === 'nothing') {
        if (o.preview) items.push(makeItem('nothing', false, false, decision.reason, local, remote, timestamp));
      } else {
        items.push(makeItem(decision.action, false, true, decision.reason, local, remote, timestamp));
      }
    }

    // --- items only on the local side -------------------------------------
    for (const [k, local] of locals) {
      if (seen.has(k)) continue;
      if (dir === 'both' || dir === 'remote') {
        if (!timestamp) {
          items.push(makeItem('upload', local.isDirectory,
            !o.existingOnly && (!local.isDirectory || o.recursive),
            'new-on-local', local, missing(remoteAdapter, rPath, local.name), timestamp));
        }
      } else if (dir === 'local' && !timestamp) {
        items.push(makeItem('deleteLocal', local.isDirectory,
          o.deleteFiles && (!local.isDirectory || o.recursive),
          'not-on-remote', local, missing(remoteAdapter, rPath, local.name), timestamp));
      }
    }
  };

  await walk(localAdapter.normalize(localPath), remoteAdapter.normalize(remotePath));

  const counts = { upload: 0, download: 0, deleteLocal: 0, deleteRemote: 0, nothing: 0 };
  for (const it of items) counts[it.action] += 1;

  return {
    items,
    counts,
    context: {
      localAdapter, remoteAdapter, localPath, remotePath, options: o,
    },
  };
}

function makeItem(action, isDirectory, checked, reason, local, remote, timestamp) {
  if (!ACTIONS.includes(action)) throw new Error(`Unknown sync action "${action}"`);
  return {
    action,
    isDirectory: !!isDirectory,
    checked: !!checked,
    reason,
    timestampOnly: !!timestamp,
    local: { ...local },
    remote: { ...remote },
  };
}

/**
 * Port of SynchronizedFileCheckModified + SynchronizedFileNewOrModified for a
 * pair of files that exist on both sides.
 *
 * `remoteModified` means the remote copy is the one to propagate (a download),
 * `localModified` the other way round. Mirror mode inverts the "newer wins"
 * rule so the source side always overwrites, which is the whole point of it.
 */
function decide(local, remote, ctx) {
  const { timestamp, mirror, notByTime, bySize, direction, tolerance } = ctx;

  let timeCompare = 0;
  // In timestamp+size mode the sizes must agree before the times are even
  // looked at, otherwise a half-written file would get its clock "fixed".
  if (!notByTime && (!timestamp || !bySize || local.size === remote.size)) {
    timeCompare = compareTime(local.mtime, remote.mtime, tolerance);
  }

  let remoteModified = false;
  let localModified = false;
  let reason = 'identical';

  if (timeCompare < 0) {
    reason = 'remote-newer';
    if ((!timestamp && !mirror) || direction === 'both' || direction === 'local') remoteModified = true;
    else localModified = true;
  } else if (timeCompare > 0) {
    reason = 'local-newer';
    if ((!timestamp && !mirror) || direction === 'both' || direction === 'remote') localModified = true;
    else remoteModified = true;
  } else if (bySize && local.size !== remote.size && !timestamp) {
    reason = 'size-differs';
    remoteModified = true;
    localModified = true;
  }

  if (remoteModified && (direction === 'both' || direction === 'local')) {
    return { action: 'download', reason };
  }
  if (localModified && (direction === 'both' || direction === 'remote')) {
    return { action: 'upload', reason };
  }
  return { action: 'nothing', reason };
}

// ---------------------------------------------------------------------------
// applying a checklist
// ---------------------------------------------------------------------------

/**
 * Turn a checklist into queue items (and, when asked, perform the deletions).
 *
 * options:
 *   onlyChecked        act on ticked items only (default true)
 *   performDeletions   actually delete (default true when the checklist asked
 *                      for deletions); set false to get them reported instead
 *   copyParam          overrides merged over the comparison's own copyParam
 *
 * Returns { items, deletions, errors }.
 */
async function apply(checklist, queue, options = {}) {
  const ctx = checklist.context;
  if (!ctx) throw new Error('apply() needs a checklist produced by compare().');
  const o = ctx.options;
  const onlyChecked = options.onlyChecked !== false;
  const performDeletions = options.performDeletions !== false;

  const copyParam = {
    ...COPY_PARAM_DEFAULTS,
    // Synchronizing by time is meaningless unless the timestamp travels with
    // the file — GetSynchronizeCopyParam forces this in the C++ too.
    preserveTime: o.criteria !== 'none',
    transferMode: o.transferMode,
    includeFileMask: '',      // the checklist is already filtered
    ...(o.copyParam || {}),
    ...(options.copyParam || {}),
  };

  const created = [];
  const deletions = [];
  const errors = [];

  for (const item of checklist.items) {
    if (onlyChecked && !item.checked) continue;
    if (item.action === 'nothing') continue;

    if (item.action === 'upload' || item.action === 'download') {
      if (item.timestampOnly) {
        // Timestamp mode never moves bytes: it copies the modification time
        // from the authoritative side onto the other one.
        const target = item.action === 'upload'
          ? { adapter: ctx.remoteAdapter, path: item.remote.path, mtime: item.local.rawMtime }
          : { adapter: ctx.localAdapter, path: item.local.path, mtime: item.remote.rawMtime };
        try {
          if (!target.adapter.caps.timestamp) {
            throw new Error(`${target.adapter.protocolName} cannot set timestamps.`);
          }
          await target.adapter.setTimes(target.path, { mtime: target.mtime, atime: target.mtime });
        } catch (err) {
          errors.push({ item, error: err });
        }
        continue;
      }

      const upload = item.action === 'upload';
      created.push(queue.add({
        side: upload ? 'upload' : 'download',
        source: upload ? item.local.path : item.remote.path,
        target: upload
          ? ctx.remoteAdapter.join(item.remote.directory, item.local.name)
          : ctx.localAdapter.join(item.local.directory, item.remote.name),
        sourceAdapter: upload ? ctx.localAdapter : ctx.remoteAdapter,
        targetAdapter: upload ? ctx.remoteAdapter : ctx.localAdapter,
        copyParam,
      }));
      continue;
    }

    // deleteLocal / deleteRemote
    const del = item.action === 'deleteLocal'
      ? { adapter: ctx.localAdapter, path: item.local.path }
      : { adapter: ctx.remoteAdapter, path: item.remote.path };
    deletions.push({ ...del, item });
    if (performDeletions) {
      try {
        await del.adapter.remove(del.path, { recursive: item.isDirectory });
      } catch (err) {
        errors.push({ item, error: err });
      }
    }
  }

  return { items: created, deletions, errors };
}

// ---------------------------------------------------------------------------
// keep remote directory up to date
// ---------------------------------------------------------------------------

/**
 * Watch one side and push changes to the other — WinSCP's "Keep remote
 * directory up to date".
 *
 * It re-runs `compare` rather than trying to translate individual file-system
 * events into transfers. That is slower per tick but it is the only approach
 * that stays correct across a rename, a mass copy, or an event the OS dropped,
 * and it works for every adapter instead of only the local one.
 *
 * A native watcher is used when the adapter offers `watch(path, cb)`; it only
 * triggers a tick, it never decides what to transfer.
 */
class Watcher extends EventEmitter {
  constructor(localAdapter, localPath, remoteAdapter, remotePath, queue, options = {}) {
    super();
    this.localAdapter = localAdapter;
    this.localPath = localPath;
    this.remoteAdapter = remoteAdapter;
    this.remotePath = remotePath;
    this.queue = queue;
    this.options = { ...OPTION_DEFAULTS, direction: 'remote', ...options };
    this.intervalMs = options.intervalMs === undefined ? 2000 : options.intervalMs;
    this.running = false;
    this._timer = null;
    this._ticking = false;
    this._again = false;
    // Invalidate comparisons that are still awaiting adapter I/O when the
    // watcher is stopped, so a late result cannot enqueue new work.
    this._generation = 0;
    this._native = null;
    // Paths already handed to the queue and not yet finished, so a slow upload
    // is not queued again on the next tick.
    this._inFlight = new Set();
  }

  start() {
    if (this.running) return this;
    this.running = true;

    this._onDone = (view) => this._inFlight.delete(view.source);
    // Queue error payloads can be transport-level failures without an item
    // (for example a connection drop before a queue item is materialized).
    // Do not let cleanup throw while handling that error, or the watcher can
    // lose its error event and remain stuck with stale in-flight paths.
    this._onError = (e) => {
      const source = e && e.item && e.item.source;
      if (source) this._inFlight.delete(source);
    };
    this.queue.on('item-done', this._onDone);
    this.queue.on('item-error', this._onError);

    if (typeof this.localAdapter.watch === 'function') {
      try {
        this._native = this.localAdapter.watch(this.localPath, (event) => {
          // A monitor can become invalid (for example when its watched
          // directory disappears).  Treat an Error callback as a terminal
          // change-source failure, like SynchronizeInvalid does upstream.
          // Stop first so a late callback cannot start another comparison.
          if (event instanceof Error) {
            this.stop();
            this.emit('error', event);
            return;
          }
          this.tick();
        });
      } catch (err) {
        this.emit('error', err);
        this._native = null;
      }
    }
    if (!this._native) {
      this._timer = setInterval(() => this.tick(), this.intervalMs);
      if (this._timer.unref) this._timer.unref();
    }
    this.emit('started', { native: !!this._native });
    // One immediate pass so an already-diverged tree is fixed at once.
    this.tick();
    return this;
  }

  stop() {
    if (!this.running) return this;
    this.running = false;
    this._generation += 1;
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this._native) {
      if (typeof this._native.close === 'function') this._native.close();
      else if (typeof this._native === 'function') this._native();
      this._native = null;
    }
    this.queue.removeListener('item-done', this._onDone);
    this.queue.removeListener('item-error', this._onError);
    this.emit('stopped');
    return this;
  }

  /** Run one comparison pass. Overlapping calls collapse into one re-run. */
  async tick() {
    if (!this.running) return null;
    if (this._ticking) { this._again = true; return null; }
    this._ticking = true;
    try {
      let result = null;
      do {
        this._again = false;
        result = await this._runOnce();
      } while (this._again && this.running);
      return result;
    } finally {
      this._ticking = false;
    }
  }

  async _runOnce() {
    const generation = this._generation;
    try {
      const checklist = await compare(
        this.localAdapter, this.localPath, this.remoteAdapter, this.remotePath, this.options);
      if (!this.running || generation !== this._generation) return null;
      const fresh = {
        ...checklist,
        items: checklist.items.filter((i) => {
          const src = i.action === 'upload' ? i.local.path : i.remote.path;
          if (i.action === 'upload' || i.action === 'download') {
            if (this._inFlight.has(src)) return false;
          }
          return true;
        }),
      };
      const applied = await apply(fresh, this.queue, {});
      for (const it of applied.items) this._inFlight.add(it.source);
      if (applied.items.length || applied.deletions.length) {
        this.emit('changes', { items: applied.items, deletions: applied.deletions });
      }
      this.emit('tick', { checked: checklist.items.length, enqueued: applied.items.length });
      return applied;
    } catch (err) {
      this.emit('error', err);
      return null;
    }
  }
}

function startWatch(localAdapter, localPath, remoteAdapter, remotePath, queue, options) {
  return new Watcher(localAdapter, localPath, remoteAdapter, remotePath, queue, options).start();
}

function stopWatch(watcher) {
  if (watcher && typeof watcher.stop === 'function') watcher.stop();
  return watcher;
}

module.exports = {
  compare,
  apply,
  startWatch,
  stopWatch,
  Watcher,
  SyncOptionError,
  validateOptions,
  compareTime,
  adjustRemoteTime,
  dstDifferenceMs,
  decide,
  ACTIONS,
  OPTION_DEFAULTS,
  DEFAULT_TIME_TOLERANCE,
};
