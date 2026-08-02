// autoupdate.js — silent background updates, the way Chrome does it.
//
// The user never sees an update prompt. There is no "a new version is
// available, would you like to download it?", no changelog modal on launch, no
// restart nag. The app checks quietly, downloads in the background, and the
// next time it starts it is simply newer.
//
// How that works on Windows: Squirrel stages the new version alongside the
// running one and swaps them at exit, so installing costs nothing at quit time
// and there is no installer window. Electron's built-in autoUpdater drives it.
//
// What this module will NOT do:
//   * prompt, at any point, for anything;
//   * block startup, quit or any user action;
//   * restart the app underneath someone who is mid-transfer;
//   * report a failure to the user — a failed update check is the updater's
//     problem, not theirs. Failures go to the log and the next check retries.
//
// The one thing it surfaces is a passive indicator once an update is staged, so
// a curious user can see "you're running 0.1.4, 0.1.7 applies on next start".
// That is information on a surface they chose to open, not an interruption.
'use strict';
const { EventEmitter } = require('events');

let electron = null;
try { electron = require('electron'); } catch { /* headless tests */ }

/**
 * update.electronjs.org serves a Squirrel.Windows-compatible feed straight from
 * a public repository's GitHub releases. It is free, run by the Electron team,
 * and needs no infrastructure of ours — but it is strict, and every one of
 * these is a silent no-update if we get it wrong:
 *   * the repository must be public;
 *   * the release must NOT be a draft and NOT a prerelease;
 *   * the tag must be plain semver — `v0.1.0-build.7` is a PRERELEASE and is
 *     skipped, which is why CI tags `v0.1.<run>`;
 *   * the release must carry the Squirrel trio: Setup.exe, the .nupkg, RELEASES;
 *   * and the app version must actually increase, or Squirrel sees nothing new.
 */
const FEED_HOST = 'https://update.electronjs.org';
const REPO = 'Ding-Ding-Projects/material-winscp';

/** Chrome checks roughly every five hours; there is no reason to be keener. */
const DEFAULT_INTERVAL_MS = 5 * 60 * 60 * 1000;
/** Let the window become usable first. Startup is not the moment for network. */
const STARTUP_DELAY_MS = 45 * 1000;

class AutoUpdater extends EventEmitter {
  constructor({ config, logger, isPackaged } = {}) {
    super();
    this.config = config || null;
    this.log = logger || (() => {});
    this.state = 'idle';        // idle | checking | downloading | staged | unsupported
    this.stagedVersion = '';
    this.lastCheck = 0;
    this.lastError = null;      // recorded, never shown
    this._timer = null;
    this._started = false;

    const app = electron && electron.app;
    this.isPackaged = isPackaged !== undefined ? isPackaged : !!(app && app.isPackaged);
    this.currentVersion = app ? app.getVersion() : '0.0.0';
  }

  /**
   * Squirrel's updater only exists in an installed app. Running from source, or
   * from the unpacked directory, there is nothing to update and calling
   * setFeedURL throws. Report that plainly rather than swallowing it, because
   * "updates silently do nothing" is indistinguishable from "updates work" and
   * that is exactly the bug nobody finds until a release goes out.
   */
  get supported() {
    if (!electron || !electron.autoUpdater) return false;
    if (process.platform !== 'win32') return false;
    return this.isPackaged;
  }

  feedUrl() {
    return `${FEED_HOST}/${REPO}/${process.platform}-${process.arch}/${this.currentVersion}`;
  }

  start() {
    if (this._started) return this;
    this._started = true;

    if (!this.supported) {
      this.state = 'unsupported';
      this.log({
        level: 'info',
        message: this.isPackaged
          ? 'Automatic updates are only wired for Windows/Squirrel builds.'
          : 'Automatic updates are disabled: this is not an installed build.',
      });
      return this;
    }

    const { autoUpdater } = electron;

    try {
      autoUpdater.setFeedURL({ url: this.feedUrl() });
    } catch (err) {
      // A bad feed URL must never take the app down with it.
      this.state = 'unsupported';
      this.lastError = err;
      this.log({ level: 'warn', message: 'Update feed could not be set: ' + err.message });
      return this;
    }

    autoUpdater.on('checking-for-update', () => {
      this.state = 'checking';
      this.emit('state', this.snapshot());
    });

    autoUpdater.on('update-not-available', () => {
      this.state = this.stagedVersion ? 'staged' : 'idle';
      this.lastCheck = Date.now();
      this.emit('state', this.snapshot());
    });

    autoUpdater.on('update-available', () => {
      // Downloading starts on its own and runs in the background. Deliberately
      // silent: the user did not ask, so the user is not told.
      this.state = 'downloading';
      this.log({ level: 'info', message: 'A newer version is downloading in the background.' });
      this.emit('state', this.snapshot());
    });

    autoUpdater.on('update-downloaded', (_e, _notes, releaseName) => {
      this.state = 'staged';
      this.stagedVersion = releaseName || '';
      this.lastCheck = Date.now();
      this.log({ level: 'info', message: `Update ${this.stagedVersion} is staged and applies on next start.` });
      // Passive only. Anything listening may show a quiet indicator; nothing
      // may raise a dialog, a toast or a restart prompt.
      this.emit('staged', this.snapshot());
      this.emit('state', this.snapshot());
    });

    autoUpdater.on('error', (err) => {
      // A failed update is the updater's problem. Log it, keep the previous
      // state, and let the next interval try again.
      this.lastError = err;
      this.state = this.stagedVersion ? 'staged' : 'idle';
      this.log({ level: 'debug', message: 'Update check failed: ' + (err && err.message) });
      this.emit('state', this.snapshot());
    });

    this._timer = setTimeout(() => {
      this.checkNow();
      this._timer = setInterval(() => this.checkNow(), this.intervalMs());
      // An interval must never hold the process open at quit.
      if (this._timer.unref) this._timer.unref();
    }, STARTUP_DELAY_MS);
    if (this._timer.unref) this._timer.unref();

    return this;
  }

  intervalMs() {
    // prefs.updates.period is in seconds and 0 means "never" for the manual
    // check. Automatic updates still run — silent updating is the product's
    // behaviour, not a preference — but a longer period slows the cadence.
    const period = this.config && this.config.getPref ? this.config.getPref('updates.period') : 0;
    if (!period) return DEFAULT_INTERVAL_MS;
    return Math.max(DEFAULT_INTERVAL_MS, Number(period) * 1000);
  }

  checkNow() {
    if (!this.supported) return false;
    // Once something is staged there is nothing further to fetch until restart.
    if (this.state === 'downloading' || this.state === 'staged') return false;
    try {
      electron.autoUpdater.checkForUpdates();
      return true;
    } catch (err) {
      this.lastError = err;
      return false;
    }
  }

  /**
   * Apply now, by explicit user request only — never called on a timer and
   * never in response to an update simply being ready. Squirrel restarts the
   * app; the caller is responsible for having saved state first.
   */
  applyAndRestart() {
    if (this.state !== 'staged') return false;
    try {
      electron.autoUpdater.quitAndInstall();
      return true;
    } catch (err) {
      this.lastError = err;
      return false;
    }
  }

  /** What a passive indicator renders. Never an interruption. */
  snapshot() {
    return {
      state: this.state,
      supported: this.supported,
      currentVersion: this.currentVersion,
      stagedVersion: this.stagedVersion,
      lastCheck: this.lastCheck,
      // The message is informational and only ever read from a surface the user
      // opened themselves.
      summary: this.state === 'staged' && this.stagedVersion
        ? `Version ${this.stagedVersion} applies the next time the app starts.`
        : '',
    };
  }

  stop() {
    if (this._timer) { clearTimeout(this._timer); clearInterval(this._timer); this._timer = null; }
    this._started = false;
  }
}

module.exports = { AutoUpdater, FEED_HOST, REPO, DEFAULT_INTERVAL_MS, STARTUP_DELAY_MS };
