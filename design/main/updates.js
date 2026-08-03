// updates.js — checking for a newer release.
//
// Three things this must not do, all of which ordinary updaters get wrong:
//   * block startup — the check is scheduled after the window is usable and
//     runs entirely off the critical path;
//   * nag — the period in prefs.updates is honoured and the result is a corner
//     notification, never a modal;
//   * download or install anything by itself — Squirrel owns that (squirrel.js).
//     This module answers "is there something newer" and reports where it is.
'use strict';
const https = require('https');
const http = require('http');
const { URL } = require('url');
const { EventEmitter } = require('events');

/** Where releases are published. Overridable so a fork can point elsewhere. */
const DEFAULT_FEED = 'https://api.github.com/repos/Ding-Ding-Projects/material-winscp/releases';

const USER_AGENT = 'WinSCP-Material-UpdateCheck';

/**
 * A GitHub release is updateable only when it carries the complete
 * Squirrel.Windows feed. A release page can exist with notes or source assets
 * alone; offering that as an update leaves the installed app with nothing it
 * can download or apply.
 */
function hasSquirrelUpdateSet(release) {
  const names = new Set((Array.isArray(release && release.assets) ? release.assets : [])
    .map((asset) => String(asset && asset.name || '').trim())
    .filter(Boolean));
  return [...names].some((name) => /setup\.exe$/i.test(name))
    && [...names].some((name) => /\.nupkg$/i.test(name))
    && [...names].some((name) => name.toUpperCase() === 'RELEASES');
}

// ------------------------------------------------------------------ semver

/** Split a version into its comparable parts. Returns null for nonsense. */
function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/.exec(String(v || '').trim());
  if (!m) return null;
  return {
    major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]),
    prerelease: m[4] ? m[4].split('.') : [],
    build: m[5] || '',
    raw: String(v).trim(),
  };
}

/**
 * Full semver 2.0.0 precedence, including the two rules people usually skip:
 * a prerelease sorts BEFORE its release, and prerelease identifiers compare
 * numerically when both are numeric and lexically otherwise.
 */
function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x && !y) return 0;
  if (!x) return -1;
  if (!y) return 1;
  for (const k of ['major', 'minor', 'patch']) {
    if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  }
  if (!x.prerelease.length && !y.prerelease.length) return 0;
  if (!x.prerelease.length) return 1;      // 1.0.0 > 1.0.0-rc1
  if (!y.prerelease.length) return -1;
  const n = Math.max(x.prerelease.length, y.prerelease.length);
  for (let i = 0; i < n; i++) {
    const ai = x.prerelease[i];
    const bi = y.prerelease[i];
    if (ai === undefined) return -1;       // fewer identifiers sorts lower
    if (bi === undefined) return 1;
    const an = /^\d+$/.test(ai);
    const bn = /^\d+$/.test(bi);
    if (an && bn) { if (Number(ai) !== Number(bi)) return Number(ai) < Number(bi) ? -1 : 1; continue; }
    if (an !== bn) return an ? -1 : 1;     // numeric identifiers sort lower
    if (ai !== bi) return ai < bi ? -1 : 1;
  }
  return 0;
}

function isNewer(candidate, current) { return compareVersions(candidate, current) > 0; }

// -------------------------------------------------------------- transport

/**
 * A small HTTPS GET with redirect handling.
 *
 * `connectionType` mirrors prefs.updates.connectionType:
 *   'auto'   — use a proxy if the environment defines one (HTTPS_PROXY), else direct
 *   'direct' — never use a proxy
 *   'proxy'  — require a proxy and fail clearly when none is configured
 */
function fetchJson(rawUrl, options) {
  const o = options || {};
  const connectionType = o.connectionType || 'auto';
  const proxy = proxyFor(connectionType);
  if (connectionType === 'proxy' && !proxy) {
    return Promise.reject(new Error('The update check is configured to use a proxy, but no proxy is configured (HTTPS_PROXY / HTTP_PROXY).'));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };

    const go = (urlStr, depth) => {
      if (depth > 5) return done(reject, new Error('Too many redirects while checking for updates.'));
      let url;
      try { url = new URL(urlStr); } catch { return done(reject, new Error(`Invalid update URL: ${urlStr}`)); }
      if (url.protocol !== 'https:') {
        // The check reports a download location; taking it over plain HTTP
        // would let anyone on the path point the user at their own installer.
        return done(reject, new Error('Update checks are only made over HTTPS.'));
      }

      const headers = { 'User-Agent': USER_AGENT, Accept: 'application/vnd.github+json' };
      let req;
      if (proxy) {
        req = requestThroughProxy(proxy, url, headers, (err, res) => {
          if (err) return done(reject, err);
          handle(res, depth);
        });
      } else {
        req = https.request({
          protocol: url.protocol, hostname: url.hostname, port: url.port || 443,
          path: url.pathname + url.search, method: 'GET', headers,
        }, (res) => handle(res, depth));
      }

      const handle = (res, d) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return go(new URL(res.headers.location, url).toString(), d + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return done(reject, new Error(`The update service replied ${res.statusCode}.`));
        }
        let body = '';
        let bytes = 0;
        res.setEncoding('utf8');
        res.on('data', (c) => {
          bytes += c.length;
          // A feed is a few kilobytes; anything enormous is not a feed.
          if (bytes > 4 * 1024 * 1024) { res.destroy(); return done(reject, new Error('The update feed was unexpectedly large.')); }
          body += c;
        });
        res.on('end', () => {
          try { done(resolve, JSON.parse(body)); } catch (e) { done(reject, new Error(`The update feed could not be parsed: ${e.message}`)); }
        });
        res.on('error', (e) => done(reject, e));
      };

      if (req) {
        req.setTimeout(o.timeoutMs || 20000, () => { req.destroy(new Error('The update check timed out.')); });
        req.on('error', (e) => done(reject, e));
        req.end();
      }
    };

    go(rawUrl, 0);
  });
}

function proxyFor(connectionType) {
  if (connectionType === 'direct') return null;
  const raw = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (!raw) return null;
  try { return new URL(raw); } catch { return null; }
}

/** CONNECT tunnel, so an HTTPS request still terminates its TLS at the origin. */
function requestThroughProxy(proxy, url, headers, cb) {
  const connectReq = http.request({
    host: proxy.hostname,
    port: proxy.port || 80,
    method: 'CONNECT',
    path: `${url.hostname}:${url.port || 443}`,
    headers: proxy.username
      ? { 'Proxy-Authorization': 'Basic ' + Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password || '')}`).toString('base64') }
      : {},
  });
  connectReq.on('connect', (res, socket) => {
    if (res.statusCode !== 200) { cb(new Error(`The proxy refused the connection (${res.statusCode}).`)); return; }
    const req = https.request({
      socket, servername: url.hostname, host: url.hostname,
      path: url.pathname + url.search, method: 'GET', headers, agent: false,
    }, (r) => cb(null, r));
    req.on('error', (e) => cb(e));
    req.end();
  });
  connectReq.on('error', (e) => cb(e));
  // The caller owns the lifetime: it sets the timeout and calls end().
  return connectReq;
}

// ------------------------------------------------------------- the checker

class Updates extends EventEmitter {
  /**
   * @param {object} deps
   * @param {object} deps.config       the Config store
   * @param {string} deps.currentVersion
   * @param {(ch:string, payload:object)=>void} [deps.emit]
   * @param {string} [deps.feedUrl]
   */
  constructor(deps) {
    super();
    const d = deps || {};
    this.config = d.config;
    this.currentVersion = d.currentVersion || '0.0.0';
    this._send = d.emit || (() => {});
    this.feedUrl = d.feedUrl || DEFAULT_FEED;
    // Injection keeps the release-selection contract testable without making
    // a network request. Production still uses the HTTPS implementation above.
    this._fetch = d.fetch || fetchJson;
    this._timer = null;
    this._inFlight = null;
  }

  prefs() { return (this.config && this.config.prefs.updates) || {}; }

  /** Whether prereleases count, per prefs.updates.betaVersions. */
  wantsBeta() {
    const mode = this.prefs().betaVersions || 'auto';
    if (mode === 'on') return true;
    if (mode === 'off') return false;
    // 'auto': someone already running a prerelease wants prereleases.
    const cur = parseVersion(this.currentVersion);
    return !!(cur && cur.prerelease.length);
  }

  dueNow() {
    const p = this.prefs();
    const period = Number(p.period) || 0;
    if (!period) return false;                       // 0 = never
    const last = Number(p.lastCheck) || 0;
    return (Date.now() / 1000) - last >= period;
  }

  /**
   * Schedule the check well after startup. Deliberately not on the ready
   * handler: the first seconds belong to showing the user their sites.
   */
  scheduleStartupCheck(delayMs) {
    if (this._timer) clearTimeout(this._timer);
    const p = this.prefs();
    if (!p.showOnStartup || !this.dueNow()) return false;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.check({ reason: 'startup' }).catch(() => { /* check() already reported */ });
    }, delayMs === undefined ? 30000 : delayMs);
    if (this._timer.unref) this._timer.unref();      // never hold the app open
    return true;
  }

  stop() { if (this._timer) { clearTimeout(this._timer); this._timer = null; } }

  /**
   * Do the check. Resolves to a result object; never throws at the caller —
   * a failed update check is a notification, not an error the user must clear.
   */
  async check(options) {
    const o = options || {};
    if (this._inFlight) return this._inFlight;

    this._inFlight = (async () => {
      const p = this.prefs();
      try {
        this.emit('checking');
        const feed = await this._fetch(this.feedUrl, {
          connectionType: p.connectionType || 'auto',
          timeoutMs: o.timeoutMs,
        });

        const releases = (Array.isArray(feed) ? feed : [feed])
          .filter((r) => r && !r.draft)
          .filter((r) => (this.wantsBeta() ? true : !r.prerelease))
          .filter(hasSquirrelUpdateSet)
          .map((r) => ({
            version: String(r.tag_name || r.name || '').replace(/^v/, ''),
            name: r.name || r.tag_name || '',
            url: r.html_url || '',
            notes: r.body || '',
            publishedAt: r.published_at ? Date.parse(r.published_at) : 0,
            prerelease: !!r.prerelease,
            assets: (r.assets || []).map((a) => ({ name: a.name, size: a.size, url: a.browser_download_url })),
          }))
          .filter((r) => parseVersion(r.version));

        releases.sort((a, b) => compareVersions(b.version, a.version));
        const latest = releases[0] || null;
        const available = !!(latest && isNewer(latest.version, this.currentVersion));

        const result = {
          checkedAt: Date.now(),
          currentVersion: this.currentVersion,
          available,
          // Keep the small legacy shape consumed by the renderer command while
          // retaining the richer `latest` record for the About/update surface.
          version: latest ? latest.version : null,
          newVersion: available ? latest.version : null,
          latest,
          beta: this.wantsBeta(),
          error: null,
        };

        if (this.config) {
          this.config.setPrefs({
            updates: { lastCheck: Math.floor(Date.now() / 1000), results: result, shownResults: false },
          }, 'Checked for updates');
        }

        this.emit('result', result);
        this._send('event:notify', available
          ? {
            kind: 'info',
            title: `Version ${latest.version} is available`,
            body: latest.name || '',
            actions: [{ id: 'open-release', label: 'Release notes', url: latest.url }],
            sticky: false,
          }
          : {
            kind: 'success',
            title: 'WinSCP Material is up to date',
            body: `Version ${this.currentVersion}`,
            sticky: false,
            quiet: o.reason === 'startup',   // an up-to-date startup check is not news
          });
        return result;
      } catch (e) {
        const result = {
          checkedAt: Date.now(), currentVersion: this.currentVersion,
          available: false, latest: null, beta: this.wantsBeta(),
          error: { message: e.message },
        };
        // Record the attempt so a permanently offline machine does not retry
        // on every single launch.
        if (this.config) {
          this.config.setPrefs({ updates: { lastCheck: Math.floor(Date.now() / 1000), results: result } }, 'Checked for updates');
        }
        this.emit('result', result);
        // A failed check is only worth a toast when the user asked for it.
        if (o.reason !== 'startup') {
          this._send('event:notify', {
            kind: 'error', title: 'The update check failed', body: e.message, sticky: true,
          });
        }
        return result;
      } finally {
        this._inFlight = null;
      }
    })();

    return this._inFlight;
  }

  /** The last result, for the About surface, without going near the network. */
  lastResult() { return this.prefs().results || null; }
}

module.exports = {
  Updates, compareVersions, parseVersion, isNewer, fetchJson, hasSquirrelUpdateSet, DEFAULT_FEED,
};
