// paths.js — every on-disk location the app owns, in one place.
'use strict';
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

let overrideRoot = null;

/** Tests and portable mode can redirect the whole data tree. */
function setRoot(dir) { overrideRoot = dir; }

function root() {
  if (overrideRoot) return overrideRoot;
  return app.getPath('userData');
}

function ensure(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const P = {
  setRoot,
  root,
  /** Main settings + sites (the equivalent of WinSCP.ini). */
  config: () => path.join(root(), 'winscp-material.json'),
  /** INI-format export, for WinSCP interoperability. */
  ini: () => path.join(root(), 'winscp-material.ini'),
  /** Session logs. */
  logs: () => ensure(path.join(root(), 'logs')),
  /** Temporary download area used by the editor and "open" actions. */
  temp: () => ensure(path.join(root(), 'temp')),
  /** Git-backed version history. Deliberately beside our data, never inside
   *  a folder the user owns. */
  history: () => ensure(path.join(root(), 'history')),
  /** Cached remote directory listings. */
  cache: () => ensure(path.join(root(), 'cache')),
  /** User-saved themes and appearance presets. */
  themes: () => ensure(path.join(root(), 'themes')),
  /** Known host keys / certificates. */
  hostkeys: () => path.join(root(), 'hostkeys.json'),
  ensure,
};

module.exports = P;
