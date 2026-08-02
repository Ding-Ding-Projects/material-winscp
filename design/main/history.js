// history.js — git-backed version history for everything the user owns.
//
// Sites, folders, workspaces and settings are all one JSON document, and every
// mutation offers a snapshot of it here. The repository lives beside the app's
// own data (paths.history()) and never inside a folder the user owns — a `.git`
// appearing in someone's Documents because a file manager wanted an undo stack
// is exactly the surprise this avoids.
//
// Two invariants, and they are the whole point of the module:
//
//   1. APPEND-ONLY. Restoring an old revision writes a *new* revision holding
//      the old state. The branch tip only ever moves forward, so an undo can be
//      undone, and that undo undone in turn. The one exception is retention
//      pruning, which drops revisions that have aged out of the configured
//      window — that is deleting old history, not rewriting recent history.
//
//   2. A HISTORY FAILURE NEVER FAILS THE CALLER. Every method resolves to
//      { ok: true, value } or { ok: false, error } and never throws. If the
//      user deleted a site, the site stays deleted whether or not we managed to
//      record it.
'use strict';
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const git = require('isomorphic-git');

/** The single document every revision contains. */
const STATE_FILE = 'state.json';
const BRANCH = 'main';

/** Recorded as the author of every revision. Deliberately not the OS account:
 *  this repository is a local undo stack, not a record of who was at the
 *  keyboard, and there is no reason to write an account name into it. */
const DEFAULT_AUTHOR = { name: 'WinSCP Material', email: 'history@winscp-material.local' };

function ok(value) { return { ok: true, value }; }
function fail(e, code) {
  return { ok: false, error: { message: e && e.message ? e.message : String(e), code: code || (e && e.code) || 'HISTORY_ERROR' } };
}

function nowSeconds() { return Math.floor(Date.now() / 1000); }

/** git stores the offset the other way round from JavaScript. */
function tzOffsetMinutes(d) { return -(d || new Date()).getTimezoneOffset(); }

function stable(value) {
  // Stable key order so an unchanged state produces an identical blob and
  // therefore records no revision at all.
  return JSON.stringify(sortKeys(value), null, 2) + '\n';
}

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
    return out;
  }
  return v;
}

class History extends EventEmitter {
  /**
   * @param {string} dir           repository directory (paths.history())
   * @param {object} [options]
   * @param {() => object} [options.getPrefs]  supplies prefs.versionHistory
   * @param {object} [options.author]
   */
  constructor(dir, options) {
    super();
    this.dir = dir;
    this.opts = options || {};
    this.author = this.opts.author || DEFAULT_AUTHOR;
    this._ready = null;
    this._queue = Promise.resolve();   // git writes are serialized: one index
  }

  get statePath() { return path.join(this.dir, STATE_FILE); }

  retention() {
    const p = (this.opts.getPrefs && this.opts.getPrefs()) || {};
    return {
      enabled: p.enabled !== false,
      retentionDays: Number(p.retentionDays) > 0 ? Number(p.retentionDays) : 0,
      maxRevisions: Number(p.maxRevisions) > 0 ? Number(p.maxRevisions) : 0,
    };
  }

  /** Create the repository on first use. Idempotent. */
  async init() {
    if (this._ready) return this._ready;
    this._ready = (async () => {
      fs.mkdirSync(this.dir, { recursive: true });
      if (!fs.existsSync(path.join(this.dir, '.git'))) {
        await git.init({ fs, dir: this.dir, defaultBranch: BRANCH });
      }
      return true;
    })().catch((e) => { this._ready = null; throw e; });
    return this._ready;
  }

  /**
   * Resolve once every write queued so far has finished.
   *
   * config.js records revisions fire-and-forget (a history write must never
   * delay the user's save), which means a read issued immediately afterwards
   * could miss the revision that was just written. Anything that reads the log
   * waits on this first, so the panel never shows a history that is one event
   * behind what the user just did.
   */
  settled() { return this._queue; }

  /** Serialize every mutating operation; isomorphic-git shares one index file. */
  _serial(fn) {
    const run = this._queue.then(fn, fn);
    // Swallow here so one failure does not poison the chain for the next call.
    this._queue = run.then(() => undefined, () => undefined);
    return run;
  }

  async _head() {
    try { return await git.resolveRef({ fs, dir: this.dir, ref: 'HEAD' }); } catch { return null; }
  }

  async _stateAt(oid) {
    const { blob } = await git.readBlob({ fs, dir: this.dir, oid, filepath: STATE_FILE });
    return JSON.parse(Buffer.from(blob).toString('utf8'));
  }

  // ------------------------------------------------------------ snapshot
  /**
   * Record a revision. `label` names what changed ("Deleted the site X"), not
   * that something changed. An identical state records nothing so the panel
   * stays a list of real events.
   */
  async snapshot(label, state) {
    try {
      await this.init();
      return await this._serial(async () => {
        const payload = stable(state);

        const head = await this._head();
        if (head) {
          try {
            const { blob } = await git.readBlob({ fs, dir: this.dir, oid: head, filepath: STATE_FILE });
            if (Buffer.from(blob).toString('utf8') === payload) {
              return ok({ oid: head, unchanged: true });
            }
          } catch { /* first revision, or the file was not there yet */ }
        }

        fs.writeFileSync(this.statePath, payload, 'utf8');
        await git.add({ fs, dir: this.dir, filepath: STATE_FILE });
        const when = new Date();
        const oid = await git.commit({
          fs,
          dir: this.dir,
          message: String(label || 'Updated'),
          author: { ...this.author, timestamp: nowSeconds(), timezoneOffset: tzOffsetMinutes(when) },
        });
        this.emit('revision', { oid, label });
        return ok({ oid, unchanged: false });
      });
    } catch (e) {
      this.emit('error', e);
      return fail(e);
    }
  }

  // ---------------------------------------------------------------- list
  /** Newest first. `{ oid, short, label, time, author }`. */
  async list(options) {
    const o = options || {};
    try {
      await this.init();
      let entries;
      try {
        entries = await git.log({ fs, dir: this.dir, ref: BRANCH, depth: o.limit || undefined });
      } catch (e) {
        if (e && (e.code === 'NotFoundError' || e.name === 'NotFoundError')) return ok([]);
        throw e;
      }
      let rows = entries.map((e) => ({
        oid: e.oid,
        short: e.oid.slice(0, 8),
        label: (e.commit.message || '').trim(),
        time: e.commit.author.timestamp * 1000,
        author: e.commit.author.name,
      }));
      if (o.since) rows = rows.filter((r) => r.time >= o.since);
      if (o.until) rows = rows.filter((r) => r.time <= o.until);
      if (o.action) {
        const wanted = new Set([].concat(o.action).map((a) => String(a).toLowerCase()));
        rows = rows.filter((r) => wanted.has(actionOf(r.label)));
      }
      return ok(rows.map((r) => ({ ...r, action: actionOf(r.label) })));
    } catch (e) {
      this.emit('error', e);
      return fail(e);
    }
  }

  /**
   * The real actions present in the history, with counts, so the filter UI
   * offers what was actually recorded rather than a hard-coded list that
   * drifts from it.
   */
  async actions() {
    const res = await this.list({});
    if (!res.ok) return res;
    const counts = new Map();
    for (const r of res.value) counts.set(r.action, (counts.get(r.action) || 0) + 1);
    return ok([...counts.entries()].map(([action, count]) => ({ action, count }))
      .sort((a, b) => b.count - a.count || a.action.localeCompare(b.action)));
  }

  // ---------------------------------------------------------------- read
  /** The state stored in a revision. Does NOT write anything. */
  async read(rev) {
    try {
      await this.init();
      const oid = await this._resolve(rev);
      if (!oid) return fail(new Error(`No such revision: ${rev}`), 'NO_SUCH_REVISION');
      return ok(await this._stateAt(oid));
    } catch (e) {
      this.emit('error', e);
      return fail(e);
    }
  }

  async _resolve(rev) {
    if (!rev || rev === 'HEAD') return this._head();
    // Accept a full oid or the abbreviation shown in the UI.
    const res = await this.list({});
    if (!res.ok) return null;
    const hit = res.value.find((r) => r.oid === rev || r.short === rev || r.oid.startsWith(rev));
    return hit ? hit.oid : null;
  }

  // ------------------------------------------------------------- restore
  /**
   * Bring an old revision back as the current state — as a NEW revision.
   * Returns the state so the caller can apply it to the live store too.
   *
   * Nothing is rewound: the revision that was current before the restore is
   * still in the log, which is what makes "undo the undo" possible.
   */
  async restore(rev, label) {
    try {
      await this.init();
      const oid = await this._resolve(rev);
      if (!oid) return fail(new Error(`No such revision: ${rev}`), 'NO_SUCH_REVISION');
      const state = await this._stateAt(oid);
      const previous = await this._head();
      const name = label || `Restored revision ${oid.slice(0, 8)}`;
      const snap = await this.snapshot(name, state);
      if (!snap.ok) return snap;
      return ok({ state, oid: snap.value.oid, from: oid, previous, unchanged: snap.value.unchanged });
    } catch (e) {
      this.emit('error', e);
      return fail(e);
    }
  }

  // ---------------------------------------------------------------- diff
  /**
   * Structured difference between two revisions (or between a revision and the
   * live state when `b` is an object). Paths are dotted so the UI can render a
   * tree without re-walking the documents itself.
   */
  async diff(a, b) {
    try {
      await this.init();
      const left = typeof a === 'object' && a !== null ? a : (await this.read(a)).value;
      const right = typeof b === 'object' && b !== null ? b : (await this.read(b === undefined ? 'HEAD' : b)).value;
      if (!left || !right) return fail(new Error('One of the revisions could not be read'), 'NO_SUCH_REVISION');
      const out = { added: [], removed: [], changed: [] };
      walkDiff('', left, right, out);
      out.count = out.added.length + out.removed.length + out.changed.length;
      return ok(out);
    } catch (e) {
      this.emit('error', e);
      return fail(e);
    }
  }

  // --------------------------------------------------------------- prune
  /**
   * Retention. Drops revisions older than `retentionDays` and anything beyond
   * `maxRevisions`, keeping the newest. The retained commits are re-linked onto
   * a new parentless root, so the oldest kept revision still carries the FULL
   * state — pruning loses intermediate steps, never the ability to restore.
   */
  async prune(force) {
    try {
      await this.init();
      const r = this.retention();
      if (!force && !r.enabled) return ok({ pruned: 0, kept: 0, skipped: 'disabled' });
      if (!r.retentionDays && !r.maxRevisions) return ok({ pruned: 0, kept: 0, skipped: 'no-limits' });

      return await this._serial(async () => {
        let entries;
        try { entries = await git.log({ fs, dir: this.dir, ref: BRANCH }); } catch { return ok({ pruned: 0, kept: 0 }); }
        if (entries.length <= 1) return ok({ pruned: 0, kept: entries.length });

        const cutoff = r.retentionDays ? nowSeconds() - r.retentionDays * 86400 : 0;
        let keep = entries;                                   // newest first
        if (r.maxRevisions) keep = keep.slice(0, r.maxRevisions);
        if (cutoff) {
          const within = keep.filter((e) => e.commit.author.timestamp >= cutoff);
          keep = within.length ? within : keep.slice(0, 1);    // never prune to nothing
        }
        if (keep.length >= entries.length) return ok({ pruned: 0, kept: entries.length });

        // Re-link oldest -> newest. Trees are reused as-is, so this touches no
        // blobs and is cheap even for a long history.
        let parent = null;
        let tip = null;
        for (let i = keep.length - 1; i >= 0; i--) {
          const e = keep[i];
          tip = await git.writeCommit({
            fs,
            dir: this.dir,
            commit: {
              message: e.commit.message,
              tree: e.commit.tree,
              parent: parent ? [parent] : [],
              author: e.commit.author,
              committer: e.commit.committer || e.commit.author,
            },
          });
          parent = tip;
        }
        await git.writeRef({ fs, dir: this.dir, ref: `refs/heads/${BRANCH}`, value: tip, force: true });
        const pruned = entries.length - keep.length;
        this.emit('pruned', { pruned, kept: keep.length });
        return ok({ pruned, kept: keep.length });
      });
    } catch (e) {
      this.emit('error', e);
      return fail(e);
    }
  }

  /** Export the whole history as a portable JSON bundle. */
  async export_() {
    try {
      const rows = await this.list({});
      if (!rows.ok) return rows;
      const revisions = [];
      for (const r of rows.value) {
        const s = await this.read(r.oid);
        revisions.push({ ...r, state: s.ok ? s.value : null });
      }
      return ok({ app: 'WinSCP Material', exportedAt: Date.now(), revisions });
    } catch (e) {
      return fail(e);
    }
  }
}

/** Derive the action from the label so the filter reflects what was recorded. */
function actionOf(label) {
  const l = String(label || '').toLowerCase();
  if (l.startsWith('restored')) return 'restored';
  if (l.startsWith('undid') || l.startsWith('undone')) return 'undone';
  if (l.startsWith('deleted') || l.startsWith('removed') || l.startsWith('forgot')) return 'deleted';
  if (l.startsWith('added') || l.startsWith('created') || l.startsWith('duplicated')) return 'created';
  if (l.startsWith('imported')) return 'imported';
  if (l.startsWith('changed setting') || l.startsWith('changed settings')) return 'settings';
  return 'updated';
}

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

function walkDiff(prefix, a, b, out) {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of keys) {
    const p = prefix ? `${prefix}.${k}` : k;
    const av = a ? a[k] : undefined;
    const bv = b ? b[k] : undefined;
    if (av === undefined) { out.added.push({ path: p, to: bv }); continue; }
    if (bv === undefined) { out.removed.push({ path: p, from: av }); continue; }
    if (isObj(av) && isObj(bv)) { walkDiff(p, av, bv, out); continue; }
    if (JSON.stringify(av) !== JSON.stringify(bv)) out.changed.push({ path: p, from: av, to: bv });
  }
}

module.exports = { History, STATE_FILE, BRANCH, actionOf };
