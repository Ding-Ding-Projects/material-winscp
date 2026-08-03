// squirrel.js — Squirrel.Windows install lifecycle.
// Squirrel launches the freshly installed exe with a flag so the app can create
// shortcuts, clean them up, or step out of the way during an update.
'use strict';
let app = null;
try { ({ app } = require('electron')); } catch { /* headless tests and tooling */ }
const path = require('path');
const cp = require('child_process');

function updateExe() {
  // Squirrel places Update.exe one level above the versioned app folder.
  return path.resolve(path.dirname(process.execPath), '..', 'Update.exe');
}

function runUpdate(args, done, spawn = cp.spawn) {
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    done();
  };
  try {
    const child = spawn(updateExe(), args, { detached: true, windowsHide: true });
    child.once('close', finish);
    child.once('error', finish);
  } catch {
    finish();
  }
}

/**
 * Handle the Squirrel command-line events. Returns true when the process was
 * started purely to service an install/update step and must quit immediately.
 */
function handleSquirrelEvent() {
  if (process.platform !== 'win32' || process.argv.length === 1) return false;

  const exeName = path.basename(process.execPath);
  const cmd = process.argv[1];

  switch (cmd) {
    case '--squirrel-install':
    case '--squirrel-updated':
      // Create Desktop and Start Menu shortcuts, then quit.
      runUpdate(['--createShortcut', exeName], () => app && app.quit());
      return true;

    case '--squirrel-uninstall':
      runUpdate(['--removeShortcut', exeName], () => app && app.quit());
      return true;

    case '--squirrel-obsolete':
      // The outgoing version is told to step aside before it is deleted.
      if (app) app.quit();
      return true;

    case '--squirrel-firstrun':
      // Not an install step: the app really is starting for the first time.
      return false;

    default:
      return false;
  }
}

module.exports = { handleSquirrelEvent, updateExe, runUpdate };
