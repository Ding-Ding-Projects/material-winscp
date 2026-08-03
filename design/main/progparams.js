// progparams.js — the production command-line boundary.
//
// The upstream TProgramParams is a thin entry-point wrapper around TOptions.
// Keep that same shape here: the application-specific startup dispatcher can
// ask for its known switches, while all token classification and ordering stay
// in design/main/options.js.
'use strict';

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

module.exports = { parseSwitches };
