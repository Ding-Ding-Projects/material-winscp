#!/usr/bin/env node
// winscp-com — the console front-end binary.
//
// This is `winscp.com`: the console-subsystem half of WinSCP, the thing a shell
// actually launches when it runs a script. It owns the terminal, hands the
// scripting engine a console it can print and prompt through, and returns the
// exit code a batch file tests with `if errorlevel 1`.
//
// Everything it does lives in design/main/console.js; this file exists only so
// that code is reachable from a command line. Without it the front-end is an
// island: complete, tested, and impossible for a user to run.
//
//   node bin/winscp-com.js /script=deploy.txt
//   node bin/winscp-com.js /command "open sftp://host/" "put file" "exit"
//   node bin/winscp-com.js /console < script.txt
//
// Declaring it in package.json's "bin" is what turns it into a `winscp-com`
// command after an install; that file is not owned by this module, so the
// declaration is left to whoever owns it.
'use strict';

const packageInfo = require('../package.json');
const { runConsoleFrontEnd } = require('../design/main/console');

const HELP = `winscp-com ${packageInfo.version} — console-compatible WinSCP command line

Usage:
  winscp-com /script=FILE [switches]
  winscp-com /command COMMAND... [switches]
  winscp-com /console < script.txt

Use winscp --help for the headless drag/drop simulation and convenience commands.
`;

// The console runner treats these as ordinary switches. The executable owns
// them instead, including when they appear after a variadic /command or
// /parameter group. Skip the value belonging to a value-taking switch so a
// command whose literal text happens to be "--help" is not stolen by the
// wrapper.
const VALUE_SWITCHES = new Set([
  'script', 'command', 'parameter', 'log', 'loglevel', 'xmllog', 'ini',
  'rawsettings', 'stdout', 'stdin', 'consolechild', 'consoleinstance',
]);

function hasMetaFlag(args, names) {
  const wanted = new Set(names);
  for (let i = 0; i < args.length; i++) {
    const token = String(args[i]);
    if (token === '--') return false;
    if (wanted.has(token.toLowerCase())) return true;
    if (!/^[-/]/.test(token)) continue;
    const body = token.slice(1);
    const equals = body.indexOf('=');
    const key = (equals < 0 ? body : body.slice(0, equals)).toLowerCase();
    if (equals < 0 && VALUE_SWITCHES.has(key) && i + 1 < args.length) i++;
  }
  return false;
}

const args = process.argv.slice(2);
if (hasMetaFlag(args, ['--help', '-h']) || args[0] === 'help') {
  process.stdout.write(HELP);
  process.exitCode = 0;
  return;
}
if (hasMetaFlag(args, ['--version', '-v']) || args[0] === 'version') {
  process.stdout.write(`${packageInfo.version}\n`);
  process.exitCode = 0;
  return;
}

runConsoleFrontEnd(args).then(
  (code) => { finish(code); },
  (error) => {
    // runConsoleFrontEnd turns every failure it knows about into an exit code,
    // so reaching here means a defect rather than a user error. Report it the
    // way the front-end reports its own failures — plain text on the terminal,
    // never a stack trace a script would have to parse — and use
    // RESULT_GLOBAL_ERROR, which is what wmain returns for a failure outside
    // the event loop.
    process.stderr.write(`${error && error.message ? error.message : String(error)}\n`);
    finish(1);
  },
);

/**
 * Stop reading the terminal and let the process end on its own. `process.exit`
 * would be wrong here: on Windows a redirected stdout is asynchronous, and
 * exiting immediately truncates the last of a script's output — which is the
 * one thing the front-end exists to deliver.
 */
function finish(code) {
  process.exitCode = code;
  if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
    try { process.stdin.setRawMode(false); } catch { /* the terminal is already gone */ }
  }
  try { process.stdin.pause(); } catch { /* already closed */ }
  try { process.stdin.unref(); } catch { /* not a handle that can be unref'd */ }
}
