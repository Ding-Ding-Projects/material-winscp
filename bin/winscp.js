#!/usr/bin/env node
// Headless command-line entry point for WinSCP Material.
//
// The `run` fallback accepts the same `/script`, `/command`, `/parameter` and
// session arguments as winscp.com. The small subcommands make the parts that
// normally need a Windows drag gesture testable from CI and automation too.
'use strict';

const fsp = require('node:fs/promises');
const os = require('os');
const path = require('path');

const packageInfo = require('../package.json');
const { runConsoleFrontEnd } = require('../design/main/console');
const shell = require('../design/main/shellintegration');

const HELP = `WinSCP Material ${packageInfo.version} — headless command line

Console-compatible commands:
  winscp run ARGS...                 Run the full winscp.com-compatible CLI
  winscp script FILE [options]       Run a script file without a GUI window
  winscp command COMMAND...           Run one or more quoted script commands
  winscp /script=FILE /command ...    Pass legacy WinSCP switches directly

Headless drag/drop simulation:
  winscp drag plan [options]          Calculate a drag/drop operation as JSON
  winscp drop classify PATH...        Classify paths and check upload support
  winscp drag stage PATH...           Stage local fixtures like a remote drag
  winscp drag extension-status        Report the native-extension mode

Drag plan options:
  --source remote|local              Where the dragged items originate
  --destination remote|local         Where they are dropped (derived by default)
  --result copy|move|invalid|none    Shell-reported drag result (remote -> local)
  --last-effect copy|move|none|link  Last OS drop effect (default: none)
  --target PATH                      Target label included in the plan
  --onto-session-tab                 Treat a remote target as a session tab
  --same-session                    The source and session-tab target match
  --target-available=false           Refuse a session-tab target
  --allow-move=false                 Downgrade incoming MOVE to COPY
  --read-only --no-upload --no-mkdir Model remote capability refusals
  --queue                            Force the resulting transfer into the queue

Stage options:
  --file PATH                        Add a path (repeatable; positional paths work too)
  --move                             Simulate a move rather than a copy
  --temp-root PATH                   Use this staging root instead of the OS temp root

All simulation commands print structured JSON and never open Electron, Explorer,
an MCP terminal window, or a network connection. Use 'winscp run' for real sessions.
Use 'winscp --help' for this message or 'winscp --version' for the version.
`;

const EFFECTS = Object.freeze({ none: shell.DROPEFFECT.NONE, copy: shell.DROPEFFECT.COPY,
  move: shell.DROPEFFECT.MOVE, link: shell.DROPEFFECT.LINK });
const VALUE_OPTIONS = new Set([
  'source', 'destination', 'result', 'last-effect', 'effect', 'target', 'windows-build',
  'parameter', 'command', 'session', 'file', 'temp-root',
]);
const BOOLEAN_OPTIONS = new Set([
  'onto-session-tab', 'same-session', 'target-available', 'allow-move', 'read-only',
  'no-upload', 'no-mkdir', 'has-directories', 'queue', 'move', 'json', 'pretty',
]);

function parseOptions(argv) {
  const positional = [];
  const options = Object.create(null);
  let afterMarker = false;
  for (let i = 0; i < argv.length; i++) {
    const token = String(argv[i]);
    if (afterMarker || token === '--') {
      if (token === '--') afterMarker = true;
      else positional.push(token);
      continue;
    }
    if (!token.startsWith('--') || token === '--') {
      positional.push(token);
      continue;
    }
    const body = token.slice(2);
    const equals = body.indexOf('=');
    const key = (equals < 0 ? body : body.slice(0, equals)).toLowerCase();
    let value = equals < 0 ? true : body.slice(equals + 1);
    const next = i + 1 < argv.length ? String(argv[i + 1]) : '';
    const separatedBoolean = BOOLEAN_OPTIONS.has(key) && ['true', 'false', 'yes', 'no', 'on', 'off', '1', '0']
      .includes(next.toLowerCase());
    if (value === true && i + 1 < argv.length && !next.startsWith('--') &&
        (VALUE_OPTIONS.has(key) || separatedBoolean)) {
      value = String(argv[++i]);
    }
    if (options[key] === undefined) options[key] = value;
    else options[key] = Array.isArray(options[key]) ? [...options[key], value] : [options[key], value];
  }
  return { positional, options };
}

function optionValues(options, name) {
  const value = options[String(name).toLowerCase()];
  return value === undefined ? [] : (Array.isArray(value) ? value : [value]);
}

function optionValue(options, name, fallback) {
  const values = optionValues(options, name);
  return values.length ? values[values.length - 1] : fallback;
}

function assertKnownOptions(options, allowed, command) {
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) throw new Error(`${command}: unknown option --${key}`);
  }
}

function windowsBuildOption(options) {
  const value = optionValue(options, 'windows-build', undefined);
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(String(value))) throw new Error('--windows-build expects a non-negative integer');
  const build = Number(value);
  if (!Number.isSafeInteger(build)) throw new Error('--windows-build is too large');
  return build;
}

function looksLikeWindowsPath(value) {
  const p = String(value);
  return /^[A-Za-z]:[\\/]/.test(p) || /^\\\\/.test(p) || /^\/\//.test(p);
}

function localPath(value) {
  if (process.platform !== 'win32' && looksLikeWindowsPath(value)) {
    throw new Error(`Windows path ${JSON.stringify(value)} requires running the CLI on Windows`);
  }
  return path.resolve(String(value));
}

function booleanOption(options, name, fallback = false) {
  const value = optionValue(options, name, undefined);
  if (value === undefined || value === true) return value === true ? true : fallback;
  const normalized = String(value).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`--${name} expects true or false, not ${JSON.stringify(value)}`);
}

function effectValue(value, name) {
  const normalized = String(value || 'none').toLowerCase();
  if (Object.prototype.hasOwnProperty.call(EFFECTS, normalized)) return EFFECTS[normalized];
  if (/^\d+$/.test(normalized)) return Number(normalized);
  throw new Error(`--${name} expects copy, move, none, link, or a numeric drop-effect bitmask`);
}

function resultValue(value) {
  const normalized = String(value || 'invalid').toLowerCase();
  if (['copy', 'move', 'invalid', 'none'].includes(normalized)) return normalized;
  throw new Error('--result expects copy, move, invalid, or none');
}

function printJson(io, value, pretty = false) {
  io.stdout.write(`${JSON.stringify(value, null, pretty ? 2 : 0)}\n`);
}

function outputIsPretty(options) {
  return booleanOption(options, 'pretty', false);
}

function printError(io, error) {
  io.stderr.write(`${error && error.message ? error.message : String(error)}\n`);
}

function dragPlan(argv) {
  const { positional, options } = parseOptions(argv);
  assertKnownOptions(options, new Set([
    'source', 'destination', 'result', 'last-effect', 'effect', 'target', 'onto-session-tab',
    'same-session', 'target-available', 'allow-move', 'read-only', 'no-upload', 'no-mkdir',
    'has-directories', 'queue', 'windows-build', 'json', 'pretty',
  ]), 'drag plan');
  const source = String(optionValue(options, 'source', 'remote')).toLowerCase();
  if (!['remote', 'local'].includes(source)) throw new Error('--source must be remote or local');
  const defaultDestination = source === 'remote' ? 'local' : 'remote';
  const destination = String(optionValue(options, 'destination', defaultDestination)).toLowerCase();
  if (!['remote', 'local'].includes(destination)) throw new Error('--destination must be remote or local');
  if (source === 'local' && destination === 'local') {
    throw new Error('drag plan does not define a local-to-local drop');
  }

  const lastEffect = effectValue(optionValue(options, 'last-effect', optionValue(options, 'effect', 'none')), 'last-effect');
  const result = resultValue(optionValue(options, 'result', 'invalid'));
  const targetAvailable = booleanOption(options, 'target-available', true);
  const sameSession = booleanOption(options, 'same-session', false);
  const ontoSessionTab = booleanOption(options, 'onto-session-tab', false);
  const plan = {
    command: 'drag plan',
    source,
    destination,
    target: optionValue(options, 'target', null),
    dragResult: result,
    lastDropEffect: lastEffect,
    targetAvailable,
    ontoSessionTab,
    sameSession,
    forceQueue: booleanOption(options, 'queue', false),
    extension: shell.dragExtensionStatus({
      windowsBuild: windowsBuildOption(options),
    }),
  };

  if (source === 'remote' && destination === 'remote') {
    plan.operation = shell.remoteDropOperation(lastEffect, {
      ontoSessionTab,
      targetAvailable,
      sameSession,
    });
  } else if (source === 'remote') {
    plan.operation = shell.dropEffectOperation(result, lastEffect);
  } else {
    plan.operation = shell.incomingDropOperation(lastEffect, {
      allowMove: booleanOption(options, 'allow-move', true),
    });
  }

  if (destination === 'remote') {
    const accepted = shell.canAcceptDrop({
      upload: !booleanOption(options, 'no-upload', false),
      mkdir: !booleanOption(options, 'no-mkdir', false),
    }, {
      readOnly: booleanOption(options, 'read-only', false),
      hasDirectories: booleanOption(options, 'has-directories', false),
    });
    plan.accepted = accepted;
    plan.effectiveOperation = accepted.ok ? plan.operation : null;
  } else {
    plan.effectiveOperation = plan.operation;
  }
  plan.arguments = positional;
  return plan;
}

function classifyDrop(argv) {
  const { positional, options } = parseOptions(argv);
  assertKnownOptions(options, new Set([
    'last-effect', 'effect', 'allow-move', 'read-only', 'no-upload', 'no-mkdir', 'file', 'json', 'pretty',
  ]), 'drop classify');
  const paths = [...positional, ...optionValues(options, 'file').map(String)];
  if (paths.length === 0) throw new Error('drop classify needs at least one PATH');
  paths.forEach((value) => { if (process.platform !== 'win32' && looksLikeWindowsPath(value)) localPath(value); });
  const classification = shell.classifyIncomingDrop(paths);
  const plannedOperation = shell.incomingDropOperation(
    effectValue(optionValue(options, 'last-effect', optionValue(options, 'effect', 'copy')), 'last-effect'),
    { allowMove: booleanOption(options, 'allow-move', true) },
  );
  const accepted = shell.canAcceptDrop({
    upload: !booleanOption(options, 'no-upload', false),
    mkdir: !booleanOption(options, 'no-mkdir', false),
  }, {
    readOnly: booleanOption(options, 'read-only', false),
    hasDirectories: classification.directories.length > 0,
  });
  if (accepted.ok && classification.items.length === 0) {
    accepted.ok = false;
    accepted.reason = 'No existing files or directories were found in the drop.';
  }
  const operation = classification.items.length ? plannedOperation : null;
  return {
    command: 'drop classify',
    operation,
    effectiveOperation: accepted.ok ? operation : null,
    accepted,
    classification,
    extension: shell.dragExtensionStatus(),
  };
}

async function stageDrag(argv) {
  const { positional, options } = parseOptions(argv);
  assertKnownOptions(options, new Set(['file', 'move', 'temp-root', 'json', 'pretty']), 'drag stage');
  const sourcePaths = [...positional, ...optionValues(options, 'file').map(String)];
  if (sourcePaths.length === 0) throw new Error('drag stage needs at least one PATH or --file PATH');

  const records = [];
  const names = new Set();
  for (const sourcePath of sourcePaths) {
    const absolutePath = localPath(sourcePath);
    const stat = await fsp.stat(absolutePath);
    const name = path.basename(absolutePath);
    const identity = process.platform === 'win32' ? name.toLowerCase() : name;
    if (names.has(identity)) throw new Error(`drag stage has duplicate item name ${JSON.stringify(name)}`);
    names.add(identity);
    records.push({ sourcePath: absolutePath, name, stat });
  }

  const tempRoot = localPath(optionValue(options, 'temp-root', os.tmpdir()));
  await fsp.mkdir(tempRoot, { recursive: true });
  const sourceByName = new Map(records.map((record) => [record.name, record.sourcePath]));
  const drag = new shell.DragOut({
    tempRoot,
    download: async ({ items, targetDir }) => {
      for (const item of items) {
        const sourcePath = sourceByName.get(item.remoteName);
        const targetPath = path.join(targetDir, item.localName);
        if (item.isDirectory) await fsp.cp(sourcePath, targetPath, { recursive: true });
        else await fsp.copyFile(sourcePath, targetPath);
      }
    },
  });

  const stagingDirectory = drag.begin();
  try {
    for (const record of records) {
      drag.add({
        name: record.name,
        size: record.stat.isDirectory() ? 0 : record.stat.size,
        isDirectory: record.stat.isDirectory(),
      });
    }
    await drag.stage({ move: booleanOption(options, 'move', false) });
    const payload = drag.payload();
    const shellPayload = {};
    drag.startDrag({ startDrag: (item) => {
      if (item.file) shellPayload.file = item.file;
      if (item.files) shellPayload.files = item.files;
    } }, { icon: { isEmpty: () => false } });
    return {
      command: 'drag stage',
      requestedOperation: booleanOption(options, 'move', false) ? 'move' : 'copy',
      operation: 'copy',
      sourcePreserved: true,
      stagingDirectoryBeforeCleanup: stagingDirectory,
      payload,
      shellPayload,
      totalSize: drag.totalSize,
      cleanedUp: true,
    };
  } finally {
    drag.abort();
  }
}

function buildConsoleArgs(argv, kind) {
  const { positional, options } = parseOptions(argv);
  assertKnownOptions(options, new Set(['parameter', 'command', 'session']), `${kind} command`);
  const consoleArgs = ['/console'];
  if (kind === 'script') {
    const file = positional.shift();
    if (!file) throw new Error('script needs a FILE');
    consoleArgs.push(`/script=${file}`);
  }
  for (const value of optionValues(options, 'parameter')) consoleArgs.push('/parameter', String(value));
  const commands = optionValues(options, 'command');
  if (kind === 'command' && commands.length === 0) {
    for (const value of positional.splice(0)) commands.push(value);
  }
  for (const value of commands) consoleArgs.push('/command', String(value));
  const session = optionValue(options, 'session', kind === 'script' ? positional.shift() : undefined);
  if (session) consoleArgs.push(String(session));
  if (positional.length) throw new Error(`unexpected argument ${JSON.stringify(positional[0])}`);
  return consoleArgs;
}

async function runConvenience(argv, kind) {
  return buildConsoleArgs(argv, kind);
}

async function runCli(argv = process.argv.slice(2), io = {}) {
  const streams = { stdout: io.stdout || process.stdout, stderr: io.stderr || process.stderr };
  const args = argv.map(String);
  const first = args[0] || '';
  if (!first || first === '--help' || first === '-h' || first === 'help') {
    streams.stdout.write(HELP);
    return 0;
  }
  if (first === '--version' || first === '-v' || first === 'version') {
    streams.stdout.write(`${packageInfo.version}\n`);
    return 0;
  }

  try {
    if (first === 'drag' || first === 'drop') {
      const subcommand = args[1] || (first === 'drop' ? 'classify' : 'plan');
      const subcommandArgs = args.slice(2);
      const { options } = parseOptions(subcommandArgs);
      if (subcommand === 'plan') printJson(streams, dragPlan(subcommandArgs), outputIsPretty(options));
      else if (subcommand === 'classify') printJson(streams, classifyDrop(subcommandArgs), outputIsPretty(options));
      else if (subcommand === 'stage') printJson(streams, await stageDrag(subcommandArgs), outputIsPretty(options));
      else if (subcommand === 'extension-status') {
        assertKnownOptions(options, new Set(['windows-build', 'json', 'pretty']), 'drag extension-status');
        printJson(streams, shell.dragExtensionStatus({
          windowsBuild: windowsBuildOption(options),
        }), outputIsPretty(options));
      }
      else throw new Error(`unknown ${first} subcommand ${JSON.stringify(subcommand)}`);
      return 0;
    }

    let consoleArgs = args;
    if (first === 'run') consoleArgs = args.slice(1);
    else if (first === 'script' || first === 'command') consoleArgs = await runConvenience(args.slice(1), first);
    return await runConsoleFrontEnd(consoleArgs, {
      stdout: streams.stdout,
      stderr: streams.stderr,
      processStdin: io.stdin || process.stdin,
    });
  } catch (error) {
    printError(streams, error);
    return 2;
  }
}

if (require.main === module) {
  runCli().then((code) => {
    process.exitCode = code;
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
      try { process.stdin.setRawMode(false); } catch { /* terminal already closed */ }
    }
    try { process.stdin.pause(); } catch { /* already closed */ }
  }, (error) => {
    printError({ stderr: process.stderr }, error);
    process.exitCode = 1;
  });
}

module.exports = {
  HELP, EFFECTS, parseOptions, dragPlan, classifyDrop, stageDrag, buildConsoleArgs, runCli,
};
