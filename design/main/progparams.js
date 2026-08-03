// progparams.js — the production command-line boundary.
//
// The upstream TProgramParams is a thin entry-point wrapper around TOptions.
// Keep that same shape here: the application-specific startup dispatcher can
// ask for its known switches, while all token classification and ordering stay
// in design/main/options.js.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ProgramParams, OPTION_SWITCH } = require('./options');

/**
 * Convert the reference option sequence to the small lookup used by main.js.
 * TOptions::FindSwitch returns the first matching switch, so repeated options
 * deliberately keep their first value rather than letting a later token
 * override it silently.
 */
function parseSwitches(argv) {
  const params = ProgramParams.fromArgv(Array.isArray(argv) ? argv : []);
  const switches = new Map();
  const bareParams = [];

  for (const entry of params.entries()) {
    if (entry.type === OPTION_SWITCH) {
      const name = entry.name.toLowerCase();
      if (!switches.has(name)) {
        switches.set(name, { value: entry.value, valueSet: entry.valueSet });
      }
    } else {
      bareParams.push(entry.value);
    }
  }

  return { switches, params: bareParams };
}

/**
 * Resolve the root used by a portable /ini launch and report a recoverable
 * warning when the requested file is not present or cannot be inspected.
 * WinSCP keeps the parent location usable for a first save; silently doing so
 * makes a typo look like the user's configuration disappeared.
 */
function resolveIniLocation(ini, cwd = process.cwd(), fsApi = fs) {
  if (!ini || String(ini).toLowerCase() === 'nul') return { root: null, warning: null, target: null };
  const target = path.resolve(cwd, String(ini));
  try {
    const stat = fsApi.statSync(target);
    return { root: stat.isDirectory() ? target : path.dirname(target), warning: null, target };
  } catch (error) {
    const detail = error && error.code === 'ENOENT' ? 'was not found' : 'could not be inspected';
    return {
      root: path.dirname(target),
      target,
      warning: `The INI file "${target}" ${detail}. The parent directory will be used for this run.`,
    };
  }
}

module.exports = { parseSwitches, resolveIniLocation };
