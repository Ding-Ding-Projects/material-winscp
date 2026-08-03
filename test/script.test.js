// script.test.js — the scripting engine and the console runner.
//
// The tests are weighted towards the things that actually break scripts:
// tokenizing quoted arguments, deciding whether `-x` is a switch, resolving a
// command from a prefix, the batch/confirm semantics, and the exit code. Every
// remote operation runs against a real Adapter implementation (an in-memory
// one built on protocols/base.js) and every transfer runs through the real
// TransferQueue and the real LocalAdapter over a temp directory, so a passing
// test means the command genuinely moved a file rather than that a stub was
// called.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const nodePath = require('path');
const { Readable, Writable } = require('stream');

const S = require('../design/main/script');
const CR = require('../design/main/consolerunner');
const { Adapter, entry, DEFAULT_CAPS } = require('../design/main/protocols/base');
const { LocalAdapter } = require('../design/main/protocols/local');
const { TransferQueue } = require('../design/main/queue');
const { PREF_DEFAULTS } = require('../design/main/defaults');

const {
  Script, ManagementScript, ScriptTerminal, Options, ScriptProcParams,
  cutToken, findCommand, maskFileName, isFileNameMask, maskFilePart,
  rightsFromOctal, maskPasswordInCommandLine, parseOpenUrl, listingStr,
  minimizeName, applyCriteria, syncOptionsFrom, SP,
} = S;

// ---------------------------------------------------------------------------
// an in-memory Adapter, same contract as protocols/base.js
// ---------------------------------------------------------------------------

class MemoryAdapter extends Adapter {
  constructor(name = 'memory', caps = {}) {
    super(null);
    this.name = name;
    this.caps = {
      ...DEFAULT_CAPS,
      rights: true,
      symlink: true,
      timestamp: true,
      resume: true,
      move: true,
      copyRemote: true,
      exec: true,
      checksum: true,
      ...caps,
    };
    this.connected = true;
    this.home = '/home/user';
    this.files = new Map([
      ['/', { type: 'dir', mtime: 0, rights: 'rwxr-xr-x' }],
      ['/home', { type: 'dir', mtime: 0, rights: 'rwxr-xr-x' }],
      ['/home/user', { type: 'dir', mtime: 0, rights: 'rwxr-xr-x' }],
    ]);
    this.execCalls = [];
    this.execResult = { code: 0, stdout: 'ok\n', stderr: '' };
    this.disconnected = false;
  }

  get protocolName() { return this.name; }

  put(p, contents, mtime = 1600000000000) {
    const np = this.normalize(p);
    this._parents(np);
    this.files.set(np, {
      type: 'file',
      data: Buffer.isBuffer(contents) ? contents : Buffer.from(String(contents)),
      mtime,
      rights: 'rw-r--r--',
    });
    return np;
  }

  putDir(p, mtime = 0) {
    const np = this.normalize(p);
    this._parents(np);
    if (!this.files.has(np)) this.files.set(np, { type: 'dir', mtime, rights: 'rwxr-xr-x' });
    return np;
  }

  read(p) {
    const r = this.files.get(this.normalize(p));
    return r && r.type === 'file' ? r.data : null;
  }

  has(p) { return this.files.has(this.normalize(p)); }

  _parents(np) {
    const parts = np.split('/').filter(Boolean);
    let cur = '';
    for (let i = 0; i < parts.length - 1; i++) {
      cur += `/${parts[i]}`;
      if (!this.files.has(cur)) this.files.set(cur, { type: 'dir', mtime: 0, rights: 'rwxr-xr-x' });
    }
  }

  async connect() { this.connected = true; }

  async disconnect() { this.disconnected = true; this.connected = false; }

  async list(dir) {
    const d = this.normalize(dir);
    const rec = this.files.get(d);
    if (!rec) { const e = new Error(`No such directory: ${d}`); e.code = 'ENOENT'; throw e; }
    if (rec.type !== 'dir') { const e = new Error(`Not a directory: ${d}`); e.code = 'ENOTDIR'; throw e; }
    const prefix = d === '/' ? '/' : `${d}/`;
    const out = [];
    for (const [p, r] of this.files) {
      if (p === d || !p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      if (rest.includes('/')) continue;
      out.push(entry({
        name: rest,
        type: r.type,
        size: r.type === 'dir' ? 0 : r.data.length,
        mtime: r.mtime,
        rights: r.rights,
        owner: 'martin',
        group: 'users',
        linkTarget: r.linkTarget || '',
        isSymlink: r.type === 'link',
      }));
    }
    return out;
  }

  async stat(p) {
    const np = this.normalize(p);
    const r = this.files.get(np);
    if (!r) { const e = new Error(`No such file: ${np}`); e.code = 'ENOENT'; throw e; }
    return entry({
      name: this.basename(np),
      type: r.type,
      size: r.type === 'dir' ? 0 : r.data.length,
      mtime: r.mtime,
      rights: r.rights,
      owner: 'martin',
      group: 'users',
      linkTarget: r.linkTarget || '',
      isSymlink: r.type === 'link',
    });
  }

  async mkdir(p) {
    const np = this.normalize(p);
    if (this.files.has(np)) { const e = new Error('exists'); e.code = 'EEXIST'; throw e; }
    this._parents(np);
    this.files.set(np, { type: 'dir', mtime: Date.now(), rights: 'rwxr-xr-x' });
  }

  async remove(p, opts = {}) {
    const np = this.normalize(p);
    if (!this.files.has(np)) { const e = new Error(`No such file: ${np}`); e.code = 'ENOENT'; throw e; }
    if (opts.recursive) {
      for (const k of [...this.files.keys()]) {
        if (k === np || k.startsWith(`${np}/`)) this.files.delete(k);
      }
    } else this.files.delete(np);
  }

  async rename(a, b) {
    const from = this.normalize(a);
    const to = this.normalize(b);
    const r = this.files.get(from);
    if (!r) { const e = new Error(`No such file: ${from}`); e.code = 'ENOENT'; throw e; }
    this.files.delete(from);
    this._parents(to);
    this.files.set(to, r);
  }

  async copy(a, b) {
    const r = this.files.get(this.normalize(a));
    if (!r) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
    this._parents(this.normalize(b));
    this.files.set(this.normalize(b), { ...r, data: r.data ? Buffer.from(r.data) : undefined });
  }

  async symlink(target, linkPath) {
    const np = this.normalize(linkPath);
    this._parents(np);
    this.files.set(np, { type: 'link', mtime: Date.now(), rights: 'rwxrwxrwx', linkTarget: target });
  }

  async setRights(p, rights) {
    const r = this.files.get(this.normalize(p));
    if (!r) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
    r.rights = String(rights);
  }

  async setTimes(p, times) {
    const r = this.files.get(this.normalize(p));
    if (r) r.mtime = times.mtime;
  }

  async exec(command, opts = {}) {
    this.execCalls.push({ command, opts });
    return this.execResult;
  }

  async checksum(p, alg) {
    const r = this.files.get(this.normalize(p));
    if (!r) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
    return require('crypto').createHash(String(alg).replace(/-/g, ''))
      .update(r.data).digest('hex');
  }

  async createReadStream(p, opts = {}) {
    const rec = this.files.get(this.normalize(p));
    if (!rec || rec.type !== 'file') { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
    const start = opts.start || 0;
    const end = opts.end === undefined ? rec.data.length - 1 : opts.end;
    return Readable.from([Buffer.from(rec.data.subarray(start, end + 1))]);
  }

  async createWriteStream(p, opts = {}) {
    const np = this.normalize(p);
    const self = this;
    this._parents(np);
    const start = opts.start || 0;
    if (start === 0 && !opts.append) {
      self.files.set(np, { type: 'file', data: Buffer.alloc(0), mtime: Date.now(), rights: 'rw-r--r--' });
    } else if (!self.files.has(np)) {
      self.files.set(np, { type: 'file', data: Buffer.alloc(0), mtime: Date.now(), rights: 'rw-r--r--' });
    }
    let pos = start;
    return new Writable({
      write(chunk, enc, cb) {
        const rec = self.files.get(np);
        let data = rec.data;
        if (pos > data.length) data = Buffer.concat([data, Buffer.alloc(pos - data.length)]);
        const head = data.subarray(0, pos);
        const ts = pos + chunk.length;
        const tail = data.length > ts ? data.subarray(ts) : Buffer.alloc(0);
        rec.data = Buffer.concat([head, Buffer.from(chunk), tail]);
        pos += chunk.length;
        cb();
      },
    });
  }
}

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

function makeScript(overrides = {}) {
  const out = [];
  const errors = [];
  const progress = [];
  const script = new ManagementScript({
    onPrint: (_s, text, isError) => { out.push(text); if (isError) errors.push(text); },
    onPrintProgress: (_s, first, text) => progress.push({ first, text }),
    ...overrides,
  });
  return {
    script,
    out,
    errors,
    progress,
    text: () => out.join(''),
    lines: () => out.join('').split('\n').filter((l) => l !== ''),
    clear: () => { out.length = 0; errors.length = 0; },
  };
}

/** A script whose errors are reported (like the console runner) not thrown. */
function makeReportingScript(overrides = {}) {
  const reported = [];
  const h = makeScript({
    onShowExtendedException: (_t, e) => reported.push(e && e.message ? e.message : String(e)),
    ...overrides,
  });
  h.reported = reported;
  return h;
}

function attach(script, adapter, name = 'memory', cwd = '/home/user') {
  const t = new ScriptTerminal({ adapter, name, currentDirectory: cwd });
  script.terminals.push(t);
  script.terminal = t;
  return t;
}

function tempDir(label) {
  return fs.mkdtempSync(nodePath.join(os.tmpdir(), `winscp-script-${label}-`));
}

function newQueue() {
  return new TransferQueue({
    prefs: { ...PREF_DEFAULTS, confirmOverwriting: true },
    progressMs: 0,
  });
}

// ===========================================================================
// 1. the tokenizer
// ===========================================================================

test('cutToken splits on the first unquoted space', () => {
  const r = cutToken('get index.html d:\\www\\');
  assert.equal(r.ok, true);
  assert.equal(r.token, 'get');
  assert.equal(r.rest, 'index.html d:\\www\\');
  assert.equal(r.separator, ' ');
  assert.equal(r.raw, 'get');
});

test('cutToken keeps a quoted argument with spaces together', () => {
  const r = cutToken('"my file.txt" second');
  assert.equal(r.token, 'my file.txt');
  assert.equal(r.rest, 'second');
  assert.equal(r.raw, '"my file.txt"');
});

test('cutToken treats "" as one literal quote character', () => {
  assert.equal(cutToken('a""b').token, 'a"b');
  // The plain CutToken (used by the script parser) turns a bare "" into a
  // quote; CutTokenEx makes it an empty string instead.
  assert.equal(cutToken('""').token, '"');
  assert.equal(cutToken('""', true).token, '');
});

test('cutToken escapes a quote inside quotes in both modes', () => {
  assert.equal(cutToken('"a""b"', true).token, 'a"b');
  assert.equal(cutToken('"a""b"').token, 'a"b');
});

test('cutToken skips leading whitespace and reports the separator', () => {
  const r = cutToken('\t  \tvalue\trest');
  assert.equal(r.token, 'value');
  assert.equal(r.separator, '\t');
  assert.equal(r.rest, 'rest');
});

test('cutToken on whitespace only reports no token', () => {
  const r = cutToken('   \t ');
  assert.equal(r.ok, false);
  assert.equal(r.rest, '');
});

test('cutToken with no trailing separator leaves an empty rest', () => {
  const r = cutToken('only');
  assert.equal(r.token, 'only');
  assert.equal(r.rest, '');
  assert.equal(r.separator, '');
});

test('tokenize splits a whole line the way the parser will', () => {
  assert.deepEqual(S.tokenize('put -delete "a b.txt" /remote/'),
    ['put', '-delete', 'a b.txt', '/remote/']);
});

test('addQuotes keeps tab-containing CLI arguments as one token', () => {
  const value = 'folder\twith-tab.txt';
  assert.deepEqual(S.tokenize(`put ${S.addQuotes(value)}`), ['put', value]);
});

// ===========================================================================
// 2. option / switch parsing
// ===========================================================================

test('Options treats -x as a switch and a bare word as a parameter', () => {
  const o = new Options();
  o.parse('-delete file.txt');
  assert.equal(o.paramCount, 1);
  assert.equal(o.param(1), 'file.txt');
  assert.equal(o.findSwitch('delete'), true);
  assert.equal(o.findSwitch('DELETE'), true, 'switch matching is case-insensitive');
});

test('Options reads a switch value after = or :', () => {
  const o = new Options();
  o.parse('-speed=100 -transfer:ascii');
  assert.equal(o.switchValueOf('speed'), '100');
  assert.equal(o.switchValueOf('transfer'), 'ascii');
});

test('Options strips the array brackets from -switch[value]', () => {
  const o = new Options();
  o.parse('-rawsettings[Key=1]');
  assert.equal(o.switchValueOf('rawsettings'), 'Key=1');
});

test('Options distinguishes a set-but-empty value from an absent one', () => {
  const o = new Options();
  o.parse('-speed= -delete');
  assert.equal(o.locateSwitch('speed').valueSet, true);
  assert.equal(o.locateSwitch('delete').valueSet, false);
});

test('Options stops treating tokens as switches after --', () => {
  const o = new Options();
  o.parse('-a -- -b');
  assert.equal(o.findSwitch('a'), true);
  assert.equal(o.findSwitch('b'), false);
  assert.equal(o.paramCount, 1);
  assert.equal(o.param(1), '-b');
});

test('Options refuses to call /home/martin a switch', () => {
  // A slash followed by letters then a slash: the second slash is not a value
  // delimiter and not a letter, so the switch hypothesis is abandoned.
  const o = new Options();
  o.parse('/home/martin');
  assert.equal(o.paramCount, 1);
  assert.equal(o.param(1), '/home/martin');
});

test('Options accepts a --long-switch only behind a double dash mark', () => {
  const o = new Options();
  o.parse('--puttygen-switch -a-b');
  assert.equal(o.findSwitch('-puttygen-switch'), true);
  // `-a-b` has a dash after a single-dash mark, which is not allowed.
  assert.equal(o.paramCount, 1);
  assert.equal(o.param(1), '-a-b');
});

test('Options reports the first switch nobody consumed', () => {
  const o = new Options();
  o.parse('-known -bogus');
  o.findSwitch('known');
  assert.equal(o.unusedSwitch(), 'bogus');
  o.findSwitch('bogus');
  assert.equal(o.unusedSwitch(), null);
});

test('findSwitchParams consumes the parameters that follow the switch', () => {
  const o = new Options();
  o.parse('open host -rawsettings a=1 b=2');
  assert.deepEqual(o.findSwitchParams('rawsettings'), ['a=1', 'b=2']);
  // Consumed parameters are gone: only the ones before the switch remain.
  assert.equal(o.paramCount, 2);
  assert.equal(o.param(1), 'open');
  assert.equal(o.param(2), 'host');
});

test('findSwitchParams honours a numeric count in the switch value', () => {
  const o = new Options();
  o.parse('-command=1 first second');
  assert.deepEqual(o.findSwitchParams('command'), ['first']);
  assert.equal(o.paramCount, 1);
});

test('logOptions reports every original token, including consumed ones', () => {
  const o = new Options();
  o.parse('-speed=100 file.txt');
  o.findSwitch('speed');
  const logged = [];
  o.logOptions((s) => logged.push(s));
  assert.deepEqual(logged, ['Switch:    /speed=100', 'Parameter: file.txt']);
});

// ---------------------------------------------------------------------------

test('ScriptProcParams drops / from the switch marks', () => {
  const p = new ScriptProcParams('cd', '/home/martin');
  assert.equal(p.paramCount, 1);
  assert.equal(p.param(1), '/home/martin');
  assert.equal(p.findSwitch('home'), false);
});

test('ScriptProcParams still honours -switches and keeps paramsStr intact', () => {
  const p = new ScriptProcParams('get', '-latest -delete *.log d:\\logs\\');
  assert.equal(p.findSwitch('latest'), true);
  assert.equal(p.findSwitch('delete'), true);
  assert.equal(p.paramCount, 2);
  assert.equal(p.paramsStr, '-latest -delete *.log d:\\logs\\');
});

// ===========================================================================
// 3. command resolution
// ===========================================================================

test('findCommand matches exactly, then by unique prefix', () => {
  const names = ['cd', 'checksum', 'close'];
  assert.equal(findCommand(names, 'cd').index, 0);
  assert.equal(findCommand(names, 'CD').index, 0);
  assert.equal(findCommand(names, 'check').index, 1);
});

test('findCommand reports -2 with every match for an ambiguous prefix', () => {
  const r = findCommand(['lcd', 'lls', 'lpwd'], 'l');
  assert.equal(r.index, -2);
  assert.equal(r.matches, 'lcd, lls, lpwd');
});

test('findCommand reports -1 for something that matches nothing', () => {
  assert.equal(findCommand(['cd', 'ls'], 'zzz').index, -1);
});

test('an exact name wins even when it is a prefix of another command', () => {
  // `ls` is a prefix of nothing here, but `cd` vs `cdx` exercises the rule.
  assert.equal(findCommand(['cd', 'cdx'], 'cd').index, 0);
});

test('the script resolves a unique prefix to the full command', async () => {
  const h = makeScript();
  assert.equal(h.script.resolveCommand('synchr'), 'synchronize');
  assert.equal(h.script.resolveCommand('mkd'), 'mkdir');
  assert.equal(h.script.resolveCommand('nope'), '');
});

test('an ambiguous command is refused, listing every match in sorted order', async () => {
  const h = makeScript();
  await assert.rejects(() => h.script.command('l'),
    /Ambiguous command 'l'\. Possible matches are: lcd, lls, ln, lpwd, ls/);
});

test('an unknown command is refused', async () => {
  const h = makeScript();
  await assert.rejects(() => h.script.command('frobnicate'), /Unknown command 'frobnicate'\./);
});

test('too few parameters is refused with the resolved command name', async () => {
  const h = makeScript();
  await assert.rejects(() => h.script.command('mkd'), /Missing parameter for command 'mkdir'\./);
});

test('too many parameters is refused', async () => {
  const h = makeScript();
  await assert.rejects(() => h.script.command('pwd extra'), /Too many parameters for command 'pwd'\./);
});

test('a switch on a command that takes none is refused', async () => {
  const h = makeScript();
  await assert.rejects(() => h.script.command('ls -recursive'), /Unknown switch 'recursive'\./);
});

test('an unknown switch on a command that does take switches is still refused', async () => {
  const h = makeScript();
  const a = new MemoryAdapter();
  a.put('/home/user/a.txt', 'x');
  attach(h.script, a);
  await assert.rejects(() => h.script.command('rm -bogus a.txt'), /Unknown switch 'bogus'\./);
});

// ===========================================================================
// 4. comments and echo
// ===========================================================================

test('a line starting with ; or # is a comment', async () => {
  const h = makeScript();
  await h.script.command('; this is a note');
  await h.script.command('# so is this');
  await h.script.command('');
  await h.script.command('   ');
  assert.equal(h.text(), '');
});

test('a comment marker that is not in column one is NOT a comment', async () => {
  // WinSCP checks the first character of the untrimmed line, so an indented
  // semicolon is parsed as a command. Ported deliberately.
  const h = makeScript();
  await assert.rejects(() => h.script.command('  ; indented'), /Unknown command ';'\./);
});

test('option echo on makes every later command echo itself', async () => {
  const h = makeScript();
  await h.script.command('option echo on');
  h.clear();
  await h.script.command('echo hello');
  assert.deepEqual(h.lines(), ['echo hello', 'hello']);
});

test('echo prints its argument string verbatim, dashes included', async () => {
  const h = makeScript();
  await h.script.command('echo -delete is not a switch here');
  assert.deepEqual(h.lines(), ['-delete is not a switch here']);
});

// ===========================================================================
// 5. option
// ===========================================================================

test('option with no arguments lists the five listed options', async () => {
  const h = makeScript();
  await h.script.command('option');
  const names = h.lines().map((l) => l.split(/\s+/)[0]);
  assert.deepEqual(names, ['echo', 'batch', 'confirm', 'reconnecttime', 'failonnomatch']);
});

test('a script starts in batch abort with confirmations off', async () => {
  const h = makeScript();
  await h.script.command('option batch');
  await h.script.command('option confirm');
  assert.deepEqual(h.lines().map((l) => l.trim()), ['batch           abort', 'confirm         off']);
});

test('option uses a fixed two-column layout', async () => {
  const h = makeScript();
  await h.script.command('option echo');
  assert.equal(h.text(), `${'echo'.padEnd(15)} ${'off'.padEnd(10)}\n`);
});

test('option batch accepts off/on/abort/continue and refuses anything else', async () => {
  const h = makeScript();
  for (const mode of ['off', 'on', 'abort', 'continue']) {
    h.clear();
    await h.script.command(`option batch ${mode}`);
    assert.equal(h.script.batch, mode);
  }
  await assert.rejects(() => h.script.command('option batch maybe'),
    /Unknown value 'maybe' of option 'batch'\./);
});

test('option batch resolves its value by prefix too', async () => {
  const h = makeScript();
  await h.script.command('option batch cont');
  assert.equal(h.script.batch, 'continue');
});

test('turning batch on caps the reconnect time at 120 seconds and says so', async () => {
  const h = makeScript();
  await h.script.command('option reconnecttime off');
  h.clear();
  await h.script.command('option batch on');
  const lines = h.lines().map((l) => l.trim());
  assert.deepEqual(lines, ['batch           on', 'reconnecttime   120']);
  assert.equal(h.script.sessionReopenTimeout, 120000);
});

test('option reconnecttime takes seconds or off, and refuses other words', async () => {
  const h = makeScript();
  await h.script.command('option reconnecttime 45');
  assert.equal(h.script.sessionReopenTimeout, 45000);
  h.clear();
  await h.script.command('option reconnecttime off');
  assert.equal(h.script.sessionReopenTimeout, 0);
  assert.equal(h.lines()[0].trim(), 'reconnecttime   off');
  await assert.rejects(() => h.script.command('option reconnecttime soon'),
    /Unknown value 'soon' of option 'reconnecttime'\./);
});

test('option confirm on turns overwrite confirmation back on', async () => {
  const h = makeScript();
  await h.script.command('option confirm on');
  assert.equal(h.script.confirm, true);
  assert.equal(h.script.interactiveConfirm, true);
});

test('option transfer is settable but is not part of the listing', async () => {
  const h = makeScript();
  await h.script.command('option transfer ascii');
  assert.equal(h.script.copyParam.transferMode, 'text');
  assert.equal(h.lines()[0].trim(), 'transfer        ascii');
  h.clear();
  await h.script.command('option');
  assert.ok(!h.text().includes('transfer'));
});

test('the ascii and binary commands are shorthand for option transfer', async () => {
  const h = makeScript();
  await h.script.command('ascii');
  assert.equal(h.script.copyParam.transferMode, 'text');
  await h.script.command('binary');
  assert.equal(h.script.copyParam.transferMode, 'binary');
  await assert.rejects(() => h.script.command('option transfer sideways'),
    /Unknown value 'transfer' of option 'sideways'\./);
});

test('option include and exclude share one mask, and clear resets it', async () => {
  const h = makeScript();
  await h.script.command('option include *.txt');
  assert.equal(h.script.copyParam.includeFileMask, '*.txt');
  await h.script.command('option exclude *.tmp');
  assert.equal(h.script.copyParam.includeFileMask, '|*.tmp');
  await h.script.command('option include clear');
  assert.equal(h.script.copyParam.includeFileMask, '');
  assert.equal(h.script.includeFileMaskOptionUsed, false);
});

test('option synchdelete toggles the delete flag used by synchronize', async () => {
  const h = makeScript();
  await h.script.command('option synchdelete on');
  assert.equal(!!(h.script.synchronizeParams & SP.DELETE), true);
  await h.script.command('option synchdelete off');
  assert.equal(!!(h.script.synchronizeParams & SP.DELETE), false);
});

test('an unknown option name is refused', async () => {
  const h = makeScript();
  await assert.rejects(() => h.script.command('option colour on'), /Unknown option 'colour'\./);
});

test('option failonnomatch on turns an empty match into an error', async () => {
  const h = makeScript();
  const a = new MemoryAdapter();
  attach(h.script, a);
  await h.script.command('ls *.nothing');
  assert.ok(h.text().includes("No file matching '*.nothing' found."));
  h.clear();
  await h.script.command('option failonnomatch on');
  h.clear();
  await assert.rejects(() => h.script.command('ls *.nothing'),
    /No file matching '\*\.nothing' found\./);
});

test('startInteractive swaps in the interactive batch and confirm settings', async () => {
  const h = makeScript();
  assert.equal(h.script.batch, 'abort');
  assert.equal(h.script.confirm, false);
  h.script.startInteractive();
  assert.equal(h.script.batch, 'off');
  assert.equal(h.script.confirm, true);
});

// ===========================================================================
// 6. help
// ===========================================================================

test('help lists every command that has a description, sorted', async () => {
  const h = makeScript();
  await h.script.command('help');
  const names = h.lines().map((l) => l.split(/\s+/)[0]);
  assert.ok(names.includes('get'));
  assert.ok(names.includes('keepuptodate'));
  assert.ok(names.includes('synchronize'));
  // Aliases carry no description and are therefore not listed.
  assert.ok(!names.includes('mget'));
  assert.ok(!names.includes('bye'));
  assert.deepEqual(names, [...names].sort());
});

test('help <command> prints that command help, resolved by prefix', async () => {
  const h = makeScript();
  await h.script.command('help synchr');
  assert.ok(h.text().startsWith('synchronize local|remote|both'));
  assert.ok(h.text().includes('-criteria=<criteria>'));
});

test('help for something unknown is refused', async () => {
  const h = makeScript();
  await assert.rejects(() => h.script.command('help frob'), /Unknown command 'frob'\./);
});

test('man is an alias for help', async () => {
  const h = makeScript();
  await h.script.command('man pwd');
  assert.ok(h.text().includes('Prints current remote working directory'));
});

// ===========================================================================
// 7. operation masks
// ===========================================================================

test('maskFileName renames through * and ? the way WinSCP does', () => {
  assert.equal(maskFileName('index.html', '*.bak'), 'index.bak');
  assert.equal(maskFileName('index.html', 'about.*'), 'about.html');
  assert.equal(maskFileName('index.html', '*.*'), 'index.html');
  assert.equal(maskFileName('index.html', ''), 'index.html');
  assert.equal(maskFileName('index.html', 'about.htm'), 'about.htm');
  assert.equal(maskFileName('report.txt', '?????.dat'), 'repor.dat');
});

test('maskFileName treats a leading dot as part of the name', () => {
  assert.equal(maskFileName('.htaccess', '*.bak'), '.htaccess.bak');
});

test('maskFileName escapes a wildcard behind a backslash', () => {
  assert.equal(maskFilePart('abc', '\\*').result, '*');
  assert.equal(maskFilePart('abc', '\\*').masked, false);
});

test('isFileNameMask is true only when the mask actually varies', () => {
  assert.equal(isFileNameMask(''), true);
  assert.equal(isFileNameMask('*.bak'), true);
  assert.equal(isFileNameMask('a?c'), true);
  assert.equal(isFileNameMask('literal.txt'), false);
  assert.equal(isFileNameMask('\\*'), false);
});

test('rightsFromOctal handles three and four digit modes', () => {
  assert.equal(rightsFromOctal('644'), 'rw-r--r--');
  assert.equal(rightsFromOctal('0755'), 'rwxr-xr-x');
  assert.equal(rightsFromOctal('1700'), 'rwx-----T');
  assert.equal(rightsFromOctal('4755'), 'rwsr-xr-x');
  assert.throws(() => rightsFromOctal('64x'), /Unknown value/);
  assert.throws(() => rightsFromOctal('9999'), /Unknown value/);
});

test('minimizeName keeps the tail of a long path', () => {
  assert.equal(minimizeName('short.txt', 25), 'short.txt');
  assert.equal(minimizeName('/a/very/long/remote/path/to/a/file.txt', 20).length, 20);
  assert.ok(minimizeName('/a/very/long/remote/path/to/a/file.txt', 20).endsWith('file.txt'));
});

// ===========================================================================
// 8. remote commands
// ===========================================================================

test('pwd, cd and cd with no argument all report the directory', async () => {
  const h = makeScript();
  const a = new MemoryAdapter();
  a.putDir('/var/www');
  attach(h.script, a);

  await h.script.command('pwd');
  assert.deepEqual(h.lines(), ['/home/user']);
  h.clear();
  await h.script.command('cd /var/www');
  assert.deepEqual(h.lines(), ['/var/www']);
  h.clear();
  await h.script.command('cd');
  assert.deepEqual(h.lines(), ['/home/user']);
});

test('every session command refuses to run without a session', async () => {
  const h = makeScript();
  for (const cmd of ['pwd', 'cd /x', 'ls', 'rm a', 'rmdir a', 'mv a b', 'cp a b',
    'chmod 644 a', 'ln a b', 'mkdir a', 'stat a', 'checksum md5 a', 'call ls',
    'get a', 'put a', 'synchronize remote', 'close', 'session']) {
    await assert.rejects(() => h.script.command(cmd), /No session\./, `${cmd} needs a session`);
  }
});

test('ls prints one listing line per entry', async () => {
  const h = makeScript();
  const a = new MemoryAdapter();
  a.put('/home/user/index.html', 'hello', 1600000000000);
  a.putDir('/home/user/sub');
  attach(h.script, a);
  await h.script.command('ls');
  const lines = h.lines();
  assert.equal(lines.length, 2);
  assert.ok(lines.some((l) => l.startsWith('-rw-r--r--') && l.endsWith('index.html')));
  assert.ok(lines.some((l) => l.startsWith('drwxr-xr-x') && l.endsWith('sub')));
});

test('ls with a wildcard filters, and says so when nothing matches', async () => {
  const h = makeScript();
  const a = new MemoryAdapter();
  a.put('/home/user/a.html', 'x');
  a.put('/home/user/b.txt', 'x');
  attach(h.script, a);
  await h.script.command('ls *.html');
  assert.equal(h.lines().length, 1);
  assert.ok(h.text().includes('a.html'));
  h.clear();
  await h.script.command('ls *.png');
  assert.deepEqual(h.lines(), ["No file matching '*.png' found."]);
});

test('dir is an alias for ls', async () => {
  const h = makeScript();
  const a = new MemoryAdapter();
  a.put('/home/user/a.txt', 'x');
  attach(h.script, a);
  await h.script.command('dir');
  assert.ok(h.text().includes('a.txt'));
});

test('mkdir creates a directory and rmdir removes it recursively', async () => {
  const h = makeScript();
  const a = new MemoryAdapter();
  attach(h.script, a);
  await h.script.command('mkdir public_html');
  assert.equal(a.has('/home/user/public_html'), true);
  a.put('/home/user/public_html/index.html', 'x');
  await h.script.command('rmdir public_html');
  assert.equal(a.has('/home/user/public_html'), false);
  assert.equal(a.has('/home/user/public_html/index.html'), false);
});

test('rm expands a wildcard against the server listing', async () => {
  const h = makeScript();
  const a = new MemoryAdapter();
  a.put('/home/user/a.log', 'x');
  a.put('/home/user/b.log', 'x');
  a.put('/home/user/keep.txt', 'x');
  attach(h.script, a);
  await h.script.command('rm *.log');
  assert.equal(a.has('/home/user/a.log'), false);
  assert.equal(a.has('/home/user/b.log'), false);
  assert.equal(a.has('/home/user/keep.txt'), true);
});

test('rm -onlyfile refuses to delete a directory', async () => {
  const h = makeScript();
  const a = new MemoryAdapter();
  a.putDir('/home/user/adir');
  attach(h.script, a);
  await assert.rejects(() => h.script.command('rm -onlyfile adir'), /'adir' is not file!/);
  assert.equal(a.has('/home/user/adir'), true);
});

test('a path ending in a slash produces the ambiguity warning', async () => {
  const h = makeScript();
  const a = new MemoryAdapter();
  a.putDir('/home/user/sub');
  attach(h.script, a);
  await h.script.command('rmdir sub/');
  assert.ok(h.text().includes('Selecting files using a path ending with slash is ambiguous.'));
});

test('mv renames through an operation mask', async () => {
  const h = makeScript();
  const a = new MemoryAdapter();
  a.put('/home/user/index.html', 'x');
  a.put('/home/user/about.html', 'y');
  attach(h.script, a);
  await h.script.command('mv *.html /backup/*.bak');
  assert.equal(a.has('/backup/index.bak'), true);
  assert.equal(a.has('/backup/about.bak'), true);
  assert.equal(a.has('/home/user/index.html'), false);
});

test('rename is an alias for mv', async () => {
  const h = makeScript();
  const a = new MemoryAdapter();
  a.put('/home/user/a.txt', 'x');
  attach(h.script, a);
  await h.script.command('rename a.txt b.txt');
  assert.equal(a.has('/home/user/b.txt'), true);
});

test('mv warns when several files would collapse onto one name, then refuses the collision', async () => {
  const h = makeScript();
  const a = new MemoryAdapter();
  a.put('/home/user/a.txt', 'x');
  a.put('/home/user/b.txt', 'y');
  attach(h.script, a);

  // WinSCP prints the multi-files-to-one warning and proceeds, but scripted
  // mv passes DontOverwrite, so the SECOND file hitting the now-occupied name
  // is a real error rather than a silent clobber. Both halves matter: the
  // warning alone would let a user believe it worked, and the error alone
  // would not tell them what they actually meant to type.
  await assert.rejects(
    () => h.script.command('mv a.txt b.txt one.txt'),
    /already exists/);

  assert.ok(h.text().includes('multiple files to a single file'),
    'the warning must be printed before the failure, not instead of it');
  assert.ok(h.text().includes('terminate the path with a slash'),
    'the warning must say what the user probably meant');

  // The first move really happened; the second really did not. Reporting
  // otherwise in either direction would be a lie about the filesystem.
  assert.equal(a.has('/home/user/one.txt'), true);
  assert.equal(a.has('/home/user/a.txt'), false);
  assert.equal(a.has('/home/user/b.txt'), true, 'b.txt must be left where it was');
  assert.equal(String(a.read('/home/user/one.txt')), 'x');
});

test('cp duplicates through the server-side copy when the protocol has one', async () => {
  const h = makeScript();
  const a = new MemoryAdapter();
  a.put('/home/user/index.html', 'body');
  attach(h.script, a);
  await h.script.command('cp index.html about.html');
  assert.equal(a.has('/home/user/index.html'), true);
  assert.equal(String(a.read('/home/user/about.html')), 'body');
});

test('cp is refused when the protocol cannot copy on the server', async () => {
  const h = makeScript();
  const a = new MemoryAdapter('nocopy', { copyRemote: false });
  a.put('/home/user/a.txt', 'x');
  attach(h.script, a);
  await assert.rejects(() => h.script.command('cp a.txt b.txt'), /Operation not supported\./);
});

test('chmod validates the mode before touching anything', async () => {
  const h = makeScript();
  const a = new MemoryAdapter();
  a.put('/home/user/a.txt', 'x');
  attach(h.script, a);
  await assert.rejects(() => h.script.command('chmod 8xx a.txt'), /Unknown value/);
  assert.equal(a.files.get('/home/user/a.txt').rights, 'rw-r--r--');
  await h.script.command('chmod 600 a.txt');
  assert.equal(a.files.get('/home/user/a.txt').rights, '600');
});

test('chmod is refused on a protocol without permissions', async () => {
  const h = makeScript();
  const a = new MemoryAdapter('norights', { rights: false });
  a.put('/home/user/a.txt', 'x');
  attach(h.script, a);
  await assert.rejects(() => h.script.command('chmod 644 a.txt'), /Operation not supported\./);
});

test('ln creates the link with the arguments in WinSCP order', async () => {
  const h = makeScript();
  const a = new MemoryAdapter();
  a.putDir('/home/user/public_html');
  attach(h.script, a);
  await h.script.command('ln /home/user/public_html www');
  assert.equal(a.files.get('/home/user/www').linkTarget, '/home/user/public_html');
});

test('ln is refused where symbolic links do not exist', async () => {
  const h = makeScript();
  const a = new MemoryAdapter('nolinks', { symlink: false });
  attach(h.script, a);
  await assert.rejects(() => h.script.command('ln target link'), /Operation not supported\./);
});

test('stat prints the same listing line as ls', async () => {
  const h = makeScript();
  const a = new MemoryAdapter();
  a.put('/home/user/index.html', 'hello');
  attach(h.script, a);
  await h.script.command('stat index.html');
  assert.ok(h.lines()[0].startsWith('-rw-r--r--'));
  assert.ok(h.lines()[0].endsWith('index.html'));
});

test('checksum prints "<hash> <name>"', async () => {
  const h = makeScript();
  const a = new MemoryAdapter();
  a.put('/home/user/index.html', 'hello');
  attach(h.script, a);
  await h.script.command('checksum md5 index.html');
  const expected = require('crypto').createHash('md5').update('hello').digest('hex');
  assert.deepEqual(h.lines(), [`${expected} index.html`]);
});

test('checksum refuses a directory', async () => {
  const h = makeScript();
  const a = new MemoryAdapter();
  a.putDir('/home/user/sub');
  attach(h.script, a);
  await assert.rejects(() => h.script.command('checksum md5 sub'), /is not file!/);
});

test('checksum falls back to a shell hash when the protocol has none', async () => {
  const h = makeScript();
  const a = new MemoryAdapter('shellonly', { checksum: false, exec: true });
  a.put('/home/user/f.txt', 'x');
  a.execResult = { code: 0, stdout: 'deadbeef  f.txt\n', stderr: '' };
  attach(h.script, a);
  await h.script.command('checksum sha-1 f.txt');
  assert.ok(a.execCalls[0].command.startsWith('sha1sum -- '));
  assert.deepEqual(h.lines(), ['deadbeef f.txt']);
});

test('checksum is refused where there is neither a hash nor a shell', async () => {
  const h = makeScript();
  const a = new MemoryAdapter('bare', { checksum: false, exec: false });
  a.put('/home/user/f.txt', 'x');
  attach(h.script, a);
  await assert.rejects(() => h.script.command('checksum md5 f.txt'), /Operation not supported\./);
});

test('call runs the remote command and prints both streams', async () => {
  const h = makeScript();
  const a = new MemoryAdapter();
  a.execResult = { code: 0, stdout: 'line one\nline two\n', stderr: 'a warning\n' };
  attach(h.script, a);
  await h.script.command('call ls -la /tmp');
  assert.equal(a.execCalls[0].command, 'ls -la /tmp');
  assert.deepEqual(h.lines(), ['line one', 'line two', 'a warning']);
});

test('! is an alias for call', async () => {
  const h = makeScript();
  const a = new MemoryAdapter();
  a.execResult = { code: 0, stdout: 'pong\n', stderr: '' };
  attach(h.script, a);
  await h.script.command('! echo ping');
  assert.equal(a.execCalls[0].command, 'echo ping');
});

test('call is refused where the protocol cannot execute anything', async () => {
  const h = makeScript();
  attach(h.script, new MemoryAdapter('noexec', { exec: false }));
  await assert.rejects(() => h.script.command('call whoami'), /Operation not supported\./);
});

// ===========================================================================
// 9. local commands
// ===========================================================================

test('lpwd and lcd move the script local directory without touching the process', async () => {
  const h = makeScript();
  const dir = tempDir('lcd');
  const before = process.cwd();
  await h.script.command('lpwd');
  h.clear();
  await h.script.command(`lcd ${dir}`);
  assert.equal(h.lines()[0], fs.realpathSync(dir) === dir ? dir : h.lines()[0]);
  assert.equal(h.script.localDirectory, nodePath.resolve(dir));
  assert.equal(process.cwd(), before, 'the process working directory is untouched');
});

test('lcd into something that is not a directory is refused', async () => {
  const h = makeScript();
  const dir = tempDir('lcd-bad');
  await assert.rejects(() => h.script.command(`lcd ${nodePath.join(dir, 'nope')}`),
    /Error changing directory to/);
});

test('lls lists the local directory and honours a wildcard', async () => {
  const h = makeScript();
  const dir = tempDir('lls');
  fs.writeFileSync(nodePath.join(dir, 'a.txt'), 'one');
  fs.writeFileSync(nodePath.join(dir, 'b.log'), 'two');
  fs.mkdirSync(nodePath.join(dir, 'sub'));
  h.script.localDirectory = dir;

  await h.script.command('lls');
  assert.equal(h.lines().length, 3);
  assert.ok(h.text().includes('<DIR>'));
  h.clear();
  await h.script.command(`lls ${nodePath.join(dir, '*.txt')}`);
  assert.equal(h.lines().length, 1);
  assert.ok(h.text().includes('a.txt'));
});

test('lls with no match reports it, and fails when failonnomatch is on', async () => {
  const h = makeScript();
  const dir = tempDir('lls-empty');
  h.script.localDirectory = dir;
  await h.script.command(`lls ${nodePath.join(dir, '*.png')}`);
  assert.ok(h.text().includes("No file matching '*.png' found."));
  h.script.failOnNoMatch = true;
  await assert.rejects(() => h.script.command(`lls ${nodePath.join(dir, '*.png')}`),
    /No file matching/);
});

// ===========================================================================
// 10. transfers through the real queue
// ===========================================================================

async function transferFixture(label) {
  const dir = tempDir(label);
  const local = new LocalAdapter({});
  await local.connect();
  const remote = new MemoryAdapter();
  const queue = newQueue();
  const h = makeScript({ queue, localAdapter: local, localDirectory: dir });
  attach(h.script, remote);
  return { h, dir, local, remote, queue };
}

test('get downloads into the local working directory', async () => {
  const { h, dir, remote } = await transferFixture('get');
  remote.put('/home/user/index.html', 'the body');
  await h.script.command('get index.html');
  assert.equal(fs.readFileSync(nodePath.join(dir, 'index.html'), 'utf8'), 'the body');
});

test('get applies the operation mask in the last parameter', async () => {
  const { h, dir, remote } = await transferFixture('get-mask');
  remote.put('/home/user/index.html', 'a');
  remote.put('/home/user/about.html', 'b');
  await h.script.command(`get *.html ${nodePath.join(dir, '*.bak')}`);
  assert.equal(fs.readFileSync(nodePath.join(dir, 'index.bak'), 'utf8'), 'a');
  assert.equal(fs.readFileSync(nodePath.join(dir, 'about.bak'), 'utf8'), 'b');
});

test('mget and recv are aliases for get', async () => {
  const { h, dir, remote } = await transferFixture('mget');
  remote.put('/home/user/a.txt', '1');
  remote.put('/home/user/b.txt', '2');
  await h.script.command('mget a.txt');
  await h.script.command('recv b.txt');
  assert.equal(fs.readFileSync(nodePath.join(dir, 'a.txt'), 'utf8'), '1');
  assert.equal(fs.readFileSync(nodePath.join(dir, 'b.txt'), 'utf8'), '2');
});

test('get -latest transfers only the newest matching file', async () => {
  const { h, dir, remote } = await transferFixture('get-latest');
  remote.put('/home/user/old.log', 'old', 1000);
  remote.put('/home/user/new.log', 'new', 9000);
  await h.script.command('get -latest *.log');
  assert.equal(fs.existsSync(nodePath.join(dir, 'old.log')), false);
  assert.equal(fs.readFileSync(nodePath.join(dir, 'new.log'), 'utf8'), 'new');
});

test('get -delete removes the remote file only after it arrived', async () => {
  const { h, dir, remote } = await transferFixture('get-delete');
  remote.put('/home/user/tmp.txt', 'gone soon');
  await h.script.command('get -delete tmp.txt');
  assert.equal(fs.readFileSync(nodePath.join(dir, 'tmp.txt'), 'utf8'), 'gone soon');
  assert.equal(remote.has('/home/user/tmp.txt'), false);
});

test('get with no match reports it and transfers nothing', async () => {
  const { h, dir, remote } = await transferFixture('get-nomatch');
  remote.put('/home/user/a.txt', 'x');
  await h.script.command('get *.png');
  assert.ok(h.text().includes("No file matching '*.png' found."));
  assert.equal(fs.readdirSync(dir).length, 0);
});

test('put uploads into the remote working directory', async () => {
  const { h, dir, remote } = await transferFixture('put');
  fs.writeFileSync(nodePath.join(dir, 'index.html'), 'uploaded');
  await h.script.command(`put ${nodePath.join(dir, 'index.html')}`);
  assert.equal(String(remote.read('/home/user/index.html')), 'uploaded');
});

test('put expands a local wildcard and honours an operation mask', async () => {
  const { h, dir, remote } = await transferFixture('put-mask');
  fs.writeFileSync(nodePath.join(dir, 'a.txt'), '1');
  fs.writeFileSync(nodePath.join(dir, 'b.txt'), '2');
  remote.putDir('/upload');
  await h.script.command(`put ${nodePath.join(dir, '*.txt')} /upload/*.bak`);
  assert.equal(String(remote.read('/upload/a.bak')), '1');
  assert.equal(String(remote.read('/upload/b.bak')), '2');
});

test('mput and send are aliases for put', async () => {
  const { h, dir, remote } = await transferFixture('mput');
  fs.writeFileSync(nodePath.join(dir, 'a.txt'), '1');
  fs.writeFileSync(nodePath.join(dir, 'b.txt'), '2');
  await h.script.command(`mput ${nodePath.join(dir, 'a.txt')}`);
  await h.script.command(`send ${nodePath.join(dir, 'b.txt')}`);
  assert.equal(String(remote.read('/home/user/a.txt')), '1');
  assert.equal(String(remote.read('/home/user/b.txt')), '2');
});

test('put -delete removes the local file after a successful upload', async () => {
  const { h, dir, remote } = await transferFixture('put-delete');
  const f = nodePath.join(dir, 'once.txt');
  fs.writeFileSync(f, 'bye');
  await h.script.command(`put -delete ${f}`);
  assert.equal(String(remote.read('/home/user/once.txt')), 'bye');
  assert.equal(fs.existsSync(f), false);
});

test('put -latest uploads only the newest match, and fails fast on a missing name', async () => {
  const { h, dir, remote } = await transferFixture('put-latest');
  const older = nodePath.join(dir, 'old.log');
  const newer = nodePath.join(dir, 'new.log');
  fs.writeFileSync(older, 'old');
  fs.writeFileSync(newer, 'new');
  fs.utimesSync(older, new Date(1000000), new Date(1000000));
  fs.utimesSync(newer, new Date(2000000), new Date(2000000));
  await h.script.command(`put -latest ${nodePath.join(dir, '*.log')}`);
  assert.equal(remote.has('/home/user/old.log'), false);
  assert.equal(String(remote.read('/home/user/new.log')), 'new');

  await assert.rejects(
    () => h.script.command(`put -latest ${nodePath.join(dir, 'absent.log')}`),
    /does not exist/);
});

test('put of a name that does not exist and is not a mask fails in the transfer', async () => {
  const { h, dir } = await transferFixture('put-missing');
  await assert.rejects(() => h.script.command(`put ${nodePath.join(dir, 'missing.txt')}`),
    /ENOENT|no such file/i);
});

test('-preservetime and -nopreservetime reach the copy parameters', async () => {
  const { h, dir, queue, remote } = await transferFixture('preservetime');
  fs.writeFileSync(nodePath.join(dir, 'a.txt'), 'x');
  remote.putDir('/upload');
  await h.script.command(`put -nopreservetime ${nodePath.join(dir, 'a.txt')} /upload/`);
  assert.equal(queue.list()[0].copyParam.preserveTime, false);
  await h.script.command(`put -preservetime=all ${nodePath.join(dir, 'a.txt')} /upload/`);
  const last = queue.list()[queue.list().length - 1];
  assert.equal(last.copyParam.preserveTime, true);
  assert.equal(last.copyParam.preserveTimeDirs, true);
});

test('-permissions and -nopermissions reach the copy parameters', async () => {
  const { h, dir, queue } = await transferFixture('permissions');
  fs.writeFileSync(nodePath.join(dir, 'a.txt'), 'x');
  await h.script.command(`put -permissions=640 ${nodePath.join(dir, 'a.txt')}`);
  assert.equal(queue.list()[0].copyParam.preserveRights, true);
  assert.equal(queue.list()[0].copyParam.rights, 'rw-r-----');
  await h.script.command(`put -nopermissions ${nodePath.join(dir, 'a.txt')}`);
  assert.equal(queue.list()[1].copyParam.preserveRights, false);
});

test('-speed sets a per-item limit in bytes per second', async () => {
  const { h, dir, queue } = await transferFixture('speed');
  fs.writeFileSync(nodePath.join(dir, 'a.txt'), 'x');
  await h.script.command(`put -speed=64 ${nodePath.join(dir, 'a.txt')}`);
  assert.equal(queue.list()[0].copyParam.cpsLimit, 64 * 1024);
});

test('-transfer picks the mode and refuses an unknown one', async () => {
  const { h, dir, queue } = await transferFixture('transfer-switch');
  fs.writeFileSync(nodePath.join(dir, 'a.txt'), 'x');
  await h.script.command(`put -transfer=ascii ${nodePath.join(dir, 'a.txt')}`);
  assert.equal(queue.list()[0].copyParam.transferMode, 'text');
  await assert.rejects(
    () => h.script.command(`put -transfer=sideways ${nodePath.join(dir, 'a.txt')}`),
    /Unknown value 'transfer' of option 'sideways'\./);
});

test('-resumesupport takes on, off or a threshold in KB', async () => {
  const { h, dir, queue } = await transferFixture('resumesupport');
  fs.writeFileSync(nodePath.join(dir, 'a.txt'), 'x');
  await h.script.command(`put -resumesupport=off ${nodePath.join(dir, 'a.txt')}`);
  assert.equal(queue.list()[0].copyParam.resumeSupport, 'off');
  await h.script.command(`put -resumesupport=100 ${nodePath.join(dir, 'a.txt')}`);
  assert.equal(queue.list()[1].copyParam.resumeSupport, 'smart');
  assert.equal(queue.list()[1].copyParam.resumeThreshold, 100 * 1024);
  await assert.rejects(
    () => h.script.command(`put -resumesupport=maybe ${nodePath.join(dir, 'a.txt')}`),
    /Unknown value/);
});

test('-filemask filters the files that are actually walked', async () => {
  const { h, dir, remote } = await transferFixture('filemask');
  remote.putDir('/home/user/tree');
  remote.put('/home/user/tree/keep.txt', 'k');
  remote.put('/home/user/tree/drop.bin', 'd');
  await h.script.command('get -filemask=*.txt tree');
  assert.equal(fs.existsSync(nodePath.join(dir, 'tree', 'keep.txt')), true);
  assert.equal(fs.existsSync(nodePath.join(dir, 'tree', 'drop.bin')), false);
});

test('-neweronly and -noneweronly toggle the same copy parameter', async () => {
  const { h, dir, queue } = await transferFixture('neweronly');
  fs.writeFileSync(nodePath.join(dir, 'a.txt'), 'x');
  await h.script.command(`put -neweronly ${nodePath.join(dir, 'a.txt')}`);
  assert.equal(queue.list()[0].copyParam.newerOnly, true);
  await h.script.command(`put -noneweronly ${nodePath.join(dir, 'a.txt')}`);
  assert.equal(queue.list()[1].copyParam.newerOnly, false);
});

test('confirm off overwrites silently; confirm on refuses in batch mode', async () => {
  const { h, dir, remote } = await transferFixture('overwrite');
  fs.writeFileSync(nodePath.join(dir, 'a.txt'), 'new content');
  remote.put('/home/user/a.txt', 'old content');

  await h.script.command(`put ${nodePath.join(dir, 'a.txt')}`);
  assert.equal(String(remote.read('/home/user/a.txt')), 'new content');

  remote.put('/home/user/a.txt', 'old again');
  await h.script.command('option confirm on');
  await assert.rejects(() => h.script.command(`put ${nodePath.join(dir, 'a.txt')}`),
    /Overwrite confirmation was refused in batch mode\./);
  assert.equal(String(remote.read('/home/user/a.txt')), 'old again');
});

test('confirm on with batch continue skips the file instead of failing', async () => {
  const { h, dir, remote } = await transferFixture('overwrite-continue');
  fs.writeFileSync(nodePath.join(dir, 'a.txt'), 'new content');
  remote.put('/home/user/a.txt', 'old content');
  await h.script.command('option confirm on');
  await h.script.command('option batch continue');
  await h.script.command(`put ${nodePath.join(dir, 'a.txt')}`);
  assert.equal(String(remote.read('/home/user/a.txt')), 'old content');
});

test('a transfer emits a formatted progress line', async () => {
  const { h, dir, remote } = await transferFixture('progress');
  remote.put('/home/user/big.bin', Buffer.alloc(4096, 7));
  await h.script.command('get big.bin');
  assert.ok(h.progress.length > 0, 'progress was reported');
  assert.ok(/\|.*KB\/s \|/.test(h.progress[h.progress.length - 1].text));
  assert.equal(fs.statSync(nodePath.join(dir, 'big.bin')).size, 4096);
});

test('get - streams the file out instead of writing it', async () => {
  const chunks = [];
  const dir = tempDir('stdout');
  const local = new LocalAdapter({});
  await local.connect();
  const remote = new MemoryAdapter();
  remote.put('/home/user/a.txt', 'streamed');
  const h = makeScript({
    queue: newQueue(),
    localAdapter: local,
    localDirectory: dir,
    onTransferOut: (_s, buf) => chunks.push(buf),
  });
  attach(h.script, remote);
  await h.script.command('get a.txt -');
  assert.equal(Buffer.concat(chunks).toString(), 'streamed');
  assert.equal(fs.existsSync(nodePath.join(dir, 'a.txt')), false);
});

test('put - reads the file from the stream and refuses a masked target', async () => {
  const dir = tempDir('stdin');
  const local = new LocalAdapter({});
  await local.connect();
  const remote = new MemoryAdapter();
  const h = makeScript({
    queue: newQueue(),
    localAdapter: local,
    localDirectory: dir,
    onTransferIn: async () => Buffer.from('from stdin'),
  });
  attach(h.script, remote);
  await h.script.command('put - /home/user/piped.txt');
  assert.equal(String(remote.read('/home/user/piped.txt')), 'from stdin');

  await assert.rejects(() => h.script.command('put - /home/user/*.txt'),
    /only one source can be specified/);
  await assert.rejects(() => h.script.command('put - a b'),
    /only one source can be specified/);
});

// ===========================================================================
// 11. synchronize and keepuptodate
// ===========================================================================

async function syncFixture(label) {
  const dir = tempDir(label);
  const local = new LocalAdapter({});
  await local.connect();
  const remote = new MemoryAdapter();
  remote.putDir('/site');
  const queue = newQueue();
  const h = makeScript({ queue, localAdapter: local, localDirectory: dir });
  attach(h.script, remote);
  return { h, dir, local, remote, queue };
}

test('synchronize remote uploads the files the remote side is missing', async () => {
  const { h, dir, remote } = await syncFixture('sync-remote');
  fs.writeFileSync(nodePath.join(dir, 'a.txt'), 'aaa');
  await h.script.command(`synchronize remote ${dir} /site`);
  assert.equal(String(remote.read('/site/a.txt')), 'aaa');
  assert.ok(h.text().includes('Comparing...'));
  assert.ok(h.text().includes('Synchronizing...'));
});

test('synchronize -preview lists the differences without transferring', async () => {
  const { h, dir, remote } = await syncFixture('sync-preview');
  fs.writeFileSync(nodePath.join(dir, 'a.txt'), 'aaa');
  await h.script.command(`synchronize remote -preview ${dir} /site`);
  assert.ok(h.text().includes('Differences found:'));
  assert.ok(/New local file .*a\.txt \[3, /.test(h.text()));
  assert.equal(remote.has('/site/a.txt'), false);
});

test('synchronize with nothing to do says so, and can be made to fail', async () => {
  const { h, dir } = await syncFixture('sync-nodiff');
  await h.script.command(`synchronize remote ${dir} /site`);
  assert.ok(h.text().includes('Nothing to synchronize.'));
  h.script.failOnNoMatch = true;
  await assert.rejects(() => h.script.command(`synchronize remote ${dir} /site`),
    /Nothing to synchronize\./);
});

test('synchronize -delete removes the orphan on the target side', async () => {
  const { h, dir, remote } = await syncFixture('sync-delete');
  remote.put('/site/orphan.txt', 'x');
  await h.script.command(`synchronize remote -delete ${dir} /site`);
  assert.equal(remote.has('/site/orphan.txt'), false);
  assert.ok(h.text().includes("'/site/orphan.txt' deleted"));
});

test('synchronize refuses an unknown mode and too many parameters', async () => {
  const { h, dir } = await syncFixture('sync-bad');
  await assert.rejects(() => h.script.command('synchronize sideways'), /Unknown option 'sideways'\./);
  await assert.rejects(() => h.script.command(`synchronize remote ${dir} /site extra`),
    /Too many parameters for command 'synchronize'\./);
});

test('synchronize needs its mode parameter', async () => {
  const { h } = await syncFixture('sync-noparam');
  await assert.rejects(() => h.script.command('synchronize'),
    /Missing parameter for command 'synchronize'\./);
});

test('-criteria maps onto the comparison flags, and "both" drops them', () => {
  assert.ok(applyCriteria(0, 'none') & SP.NOT_BY_TIME);
  assert.ok(applyCriteria(0, 'either') & SP.BY_SIZE);
  assert.ok(!(applyCriteria(0, 'either') & SP.NOT_BY_TIME));
  const list = applyCriteria(0, 'size,checksum');
  assert.ok(list & SP.BY_SIZE);
  assert.ok(list & SP.BY_CHECKSUM);
  assert.ok(list & SP.NOT_BY_TIME, 'a list without "time" means not by time');
  // An unrecognised token leaves the flags untouched rather than guessing.
  assert.equal(applyCriteria(SP.BY_SIZE, 'time,nonsense'), SP.BY_SIZE);
});

test('syncOptionsFrom translates the flag word for the sync engine', () => {
  const o = syncOptionsFrom('remote', SP.DELETE | SP.MIRROR, { includeFileMask: '*.txt', transferMode: 'binary' });
  assert.equal(o.direction, 'remote');
  assert.equal(o.mode, 'mirror');
  assert.equal(o.deleteFiles, true);
  assert.equal(o.fileMask, '*.txt');
  const both = syncOptionsFrom('both', SP.BY_SIZE, {});
  assert.equal(both.criteria, 'time', 'size comparison is meaningless for "both"');
});

test('synchronize by checksum is refused where no hash can be computed', async () => {
  const dir = tempDir('sync-checksum');
  const local = new LocalAdapter({});
  await local.connect();
  const remote = new MemoryAdapter('bare', { checksum: false, exec: false });
  remote.putDir('/site');
  const h = makeScript({ queue: newQueue(), localAdapter: local, localDirectory: dir });
  attach(h.script, remote);
  await assert.rejects(
    () => h.script.command(`synchronize remote -criteria=checksum ${dir} /site`),
    /Operation not supported\./);
});

test('keepuptodate hands the directories to the watcher host', async () => {
  const dir = tempDir('kutd');
  const local = new LocalAdapter({});
  await local.connect();
  const remote = new MemoryAdapter();
  remote.putDir('/site');
  const seen = [];
  const h = makeScript({
    queue: newQueue(),
    localAdapter: local,
    localDirectory: dir,
    onSynchronizeStartStop: async (_s, l, r, cp, params) => { seen.push({ l, r, cp, params }); },
  });
  attach(h.script, remote);
  await h.script.command(`keepuptodate -delete ${dir} /site`);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].l, dir);
  assert.equal(seen[0].r, '/site');
  assert.ok(seen[0].params & SP.DELETE);
  assert.ok(h.text().includes('Watching for changes'));
});

// ===========================================================================
// 12. sessions
// ===========================================================================

function openable() {
  const opened = [];
  const openTerminal = async (data) => {
    const a = new MemoryAdapter(data.hostName || 'memory');
    const t = new ScriptTerminal({
      adapter: a,
      name: data.name || data.hostName,
      currentDirectory: data.remoteDirectory || a.home,
    });
    opened.push({ data, terminal: t });
    return t;
  };
  return { opened, openTerminal };
}

test('open connects and reports the active session', async () => {
  const { opened, openTerminal } = openable();
  const h = makeScript({ openTerminal });
  await h.script.command('open sftp://martin@example.com:2222');
  assert.equal(opened.length, 1);
  assert.equal(opened[0].data.protocol, 'sftp');
  assert.equal(opened[0].data.hostName, 'example.com');
  assert.equal(opened[0].data.portNumber, 2222);
  assert.equal(opened[0].data.userName, 'martin');
  assert.deepEqual(h.lines(), ['Active session: [1] example.com']);
});

test('session lists the open sessions and switches between them', async () => {
  const { openTerminal } = openable();
  const h = makeScript({ openTerminal });
  await h.script.command('open sftp://a.example.com');
  await h.script.command('open sftp://b.example.com');
  h.clear();
  await h.script.command('session');
  assert.deepEqual(h.lines(), [
    '  1  a.example.com',
    '  2  b.example.com',
    'Active session: [2] b.example.com',
  ]);
  h.clear();
  await h.script.command('session 1');
  assert.deepEqual(h.lines(), ['Active session: [1] a.example.com']);
});

test('an out-of-range session number is refused', async () => {
  const { openTerminal } = openable();
  const h = makeScript({ openTerminal });
  await h.script.command('open sftp://a.example.com');
  await assert.rejects(() => h.script.command('session 9'), /Invalid session number '9'\./);
  await assert.rejects(() => h.script.command('close 0'), /Invalid session number '0'\./);
});

test('close drops the session; the active one is only re-announced when it went', async () => {
  const { openTerminal } = openable();
  const h = makeScript({ openTerminal });
  await h.script.command('open sftp://a.example.com');
  await h.script.command('open sftp://b.example.com');
  h.clear();
  // Closing an inactive session leaves the active one alone and says nothing
  // more about it, exactly as DoClose does.
  await h.script.command('close 1');
  assert.deepEqual(h.lines(), ["Session 'a.example.com' closed."]);
  assert.equal(h.script.terminal.name, 'b.example.com');
  h.clear();
  await h.script.command('close');
  assert.deepEqual(h.lines(), ["Session 'b.example.com' closed.", 'No session.']);
  assert.equal(h.script.terminal, null);
});

test('closing the active session falls through to the one that took its place', async () => {
  const { openTerminal } = openable();
  const h = makeScript({ openTerminal });
  await h.script.command('open sftp://a.example.com');
  await h.script.command('open sftp://b.example.com');
  await h.script.command('session 1');
  h.clear();
  await h.script.command('close');
  assert.deepEqual(h.lines(), [
    "Session 'a.example.com' closed.",
    'Active session: [1] b.example.com',
  ]);
});

test('open prompts for a host when the URL carries none', async () => {
  const { opened, openTerminal } = openable();
  const prompts = [];
  const h = makeScript({
    openTerminal,
    onInput: async (_s, prompt) => { prompts.push(prompt); return 'typed.example.com'; },
  });
  await h.script.command('open');
  assert.deepEqual(prompts, ['Host: ']);
  assert.equal(opened[0].data.hostName, 'typed.example.com');
});

test('open refuses a site folder', async () => {
  const { openTerminal } = openable();
  const h = makeScript({
    openTerminal,
    storedSessions: { isFolder: (n) => n === 'group', isWorkspace: () => false },
  });
  await assert.rejects(() => h.script.command('open group'),
    /Cannot open site folder or workspace\./);
});

test('open warns about relying on a stored site and prints the explicit command', async () => {
  const { openTerminal } = openable();
  const h = makeScript({
    openTerminal,
    storedSessions: {
      findByName: (n) => (n === 'mysite'
        ? {
          name: 'mysite',
          protocol: 'sftp',
          hostName: 'example.com',
          portNumber: 22,
          userName: 'martin',
          password: 'secret',
          hostKey: 'ssh-ed25519 256 aa:bb',
        } : null),
    },
  });
  await h.script.command('open mysite');
  assert.ok(h.text().includes('In scripting you should not rely on saved sites'));
  assert.ok(h.text().includes('open sftp://martin:***@example.com:22/'));
  assert.ok(!h.text().includes('secret'), 'the password never reaches the output');
});

test('a stored site still takes the command-line switches', async () => {
  const { opened, openTerminal } = openable();
  const h = makeScript({
    openTerminal,
    usageWarnings: false,
    storedSessions: {
      findByName: (n) => (n === 'mysite'
        ? { name: 'mysite', protocol: 'sftp', hostName: 'example.com', portNumber: 22 } : null),
    },
  });
  h.script.usageWarnings = false;
  await h.script.command('open mysite -privatekey=key.ppk -timeout=15');
  assert.equal(opened[0].data.publicKeyFile, 'key.ppk');
  assert.equal(opened[0].data.timeout, 15);
});

test('an unknown switch on open is still reported', async () => {
  const { openTerminal } = openable();
  const h = makeScript({ openTerminal });
  await assert.rejects(() => h.script.command('open sftp://h -nosuchswitch'),
    /Unknown switch 'nosuchswitch'\./);
});

test('open refuses more than one bare parameter', async () => {
  const { openTerminal } = openable();
  const h = makeScript({ openTerminal });
  await assert.rejects(() => h.script.command('open sftp://h extra'),
    /Too many parameters for command 'open'\./);
});

test('exit stops the loop without closing anything itself', async () => {
  const { openTerminal } = openable();
  const h = makeScript({ openTerminal });
  await h.script.command('open sftp://a.example.com');
  assert.equal(h.script.continue, true);
  await h.script.command('exit');
  assert.equal(h.script.continue, false);
  h.script.continue = true;
  await h.script.command('bye');
  assert.equal(h.script.continue, false);
});

// ===========================================================================
// 13. URL parsing and password masking
// ===========================================================================

test('parseOpenUrl understands each protocol scheme and its default port', () => {
  assert.deepEqual(
    { p: parseOpenUrl('sftp://h').protocol, n: parseOpenUrl('sftp://h').portNumber }, { p: 'sftp', n: 22 });
  assert.equal(parseOpenUrl('ftp://h').portNumber, 21);
  assert.equal(parseOpenUrl('ftpes://h').ftps, 'explicitTls');
  assert.equal(parseOpenUrl('ftps://h').ftps, 'implicit');
  assert.equal(parseOpenUrl('davs://h').protocol, 'webdav');
  assert.equal(parseOpenUrl('davs://h').portNumber, 443);
  assert.equal(parseOpenUrl('s3://h').protocol, 's3');
  assert.throws(() => parseOpenUrl('gopher://h'), /Unknown protocol 'gopher'\./);
});

test('the ftps:// scheme dials the implicit-TLS port, not the plaintext one', () => {
  // TSessionData::GetDefaultPort — fsFTP + ftpsImplicit is 990. Answering 21
  // connects to the plaintext control port and then tries to negotiate TLS on a
  // socket the server never expected it on.
  assert.equal(parseOpenUrl('ftps://h').portNumber, 990);
  assert.equal(parseOpenUrl('ftp://h').portNumber, 21);
  assert.equal(parseOpenUrl('ftpes://h').portNumber, 21);
  // A port in the URL always wins.
  assert.equal(parseOpenUrl('ftps://h:2121').portNumber, 2121);
});

test('the TLS switches read their VALUE, so -implicit=off means off', () => {
  // Options is built from a command line, the way `open` receives its switches.
  const url = (u, args) => parseOpenUrl(u, new Options().parse(args.join(' ')));

  // Presence alone is "on", exactly as before.
  assert.equal(url('ftp://h', ['-implicit']).ftps, 'implicit');
  assert.equal(url('ftp://h', ['-implicit']).portNumber, 990);
  // And a value of off turns it OFF. Treating the switch's presence as "on"
  // dialled implicit TLS for a user who had asked for plaintext — a
  // wrong-protocol connection, not a missing feature.
  assert.equal(url('ftp://h', ['-implicit=off']).ftps, 'none');
  assert.equal(url('ftp://h', ['-implicit=off']).portNumber, 21);

  assert.equal(url('ftp://h', ['-explicit']).ftps, 'explicitTls');
  assert.equal(url('ftp://h', ['-explicit=off']).ftps, 'none');

  // The 5.5.x backward-compatibility spellings are consumed too; before this
  // an existing script carrying one stopped with "Unknown switch".
  assert.equal(url('ftp://h', ['-explicittls']).ftps, 'explicitTls');
  assert.equal(url('ftp://h', ['-explicitssl']).ftps, 'explicitSsl');
  assert.equal(url('ftp://h', ['-explicitssl=off']).ftps, 'none');

  // An explicit port survives every one of them.
  assert.equal(url('ftp://h:2121', ['-implicit']).portNumber, 2121);
});

test('-sessionname, -newpassword and -hostkey do what the switch promises', () => {
  const url = (args) => parseOpenUrl('sftp://h', new Options().parse(args.join(' ')));

  assert.equal(url(['-sessionname=Production']).name, 'Production');

  // ChangePassword is the flag that actually triggers the change; recording the
  // new password without it left the switch doing nothing at all.
  const changed = url(['-newpassword=n3w']);
  assert.equal(changed.newPassword, 'n3w');
  assert.equal(changed.changePassword, true);

  // FOverrideCachedHostKey — without it a fingerprint pinned on the command
  // line does not override the one already cached.
  const pinned = url(['-hostkey="ssh-rsa 2048 aa:bb"']);
  assert.equal(pinned.hostKey, 'ssh-rsa 2048 aa:bb');
  assert.equal(pinned.overrideCachedHostKey, true);
  assert.equal(url(['-certificate=aa:bb']).overrideCachedHostKey, true);
});

test('parseOpenUrl splits credentials, port, IPv6 host and remote path', () => {
  const d = parseOpenUrl('sftp://martin:p%40ss@example.com:2222/var/www');
  assert.equal(d.userName, 'martin');
  assert.equal(d.password, 'p@ss');
  assert.equal(d.hostName, 'example.com');
  assert.equal(d.portNumber, 2222);
  assert.equal(d.remoteDirectory, '/var/www');
  const v6 = parseOpenUrl('sftp://[2001:db8::1]:2200');
  assert.equal(v6.hostName, '2001:db8::1');
  assert.equal(v6.portNumber, 2200);
});

test('parseOpenUrl applies the documented open switches', () => {
  const o = new Options();
  o.parse('-privatekey=key.ppk -hostkey=ssh-rsa -timeout=30 -username=u -password=p -implicit');
  const d = parseOpenUrl('ftp://example.com', o);
  assert.equal(d.publicKeyFile, 'key.ppk');
  assert.equal(d.hostKey, 'ssh-rsa');
  assert.equal(d.timeout, 30);
  assert.equal(d.userName, 'u');
  assert.equal(d.password, 'p');
  assert.equal(d.ftps, 'implicit');
});

test('parseOpenUrl collects -rawsettings key=value pairs', () => {
  const o = new Options();
  o.parse('sftp://h -rawsettings FSProtocol=2 Compression=1');
  o.param(1);
  const d = parseOpenUrl('sftp://h', o);
  assert.deepEqual(d.rawSettings, { FSProtocol: '2', Compression: '1' });
});

test('maskPasswordInCommandLine hides the URL password and sensitive switches', () => {
  assert.equal(
    maskPasswordInCommandLine('open sftp://martin:hunter2@example.com'),
    'open sftp://martin:***@example.com');
  assert.equal(
    maskPasswordInCommandLine('open example.com -password=hunter2'),
    'open example.com -password=***');
  assert.equal(
    maskPasswordInCommandLine('open example.com -passphrase=hunter2 -timeout=30'),
    'open example.com -passphrase=*** -timeout=30');
});

test('an open command is masked before it is logged or echoed', async () => {
  const { openTerminal } = openable();
  const logged = [];
  const h = makeScript({
    openTerminal,
    log: (kind, text) => logged.push(`${kind}: ${text}`),
  });
  await h.script.command('option echo on');
  h.clear();
  await h.script.command('open sftp://martin:hunter2@example.com');
  assert.ok(!h.text().includes('hunter2'), 'the echo is masked');
  assert.ok(!logged.join('\n').includes('hunter2'), 'the log is masked');
  assert.ok(logged.some((l) => l.includes('***')));
});

test('a command that is not open is logged unchanged', async () => {
  const logged = [];
  const h = makeScript({ log: (kind, text) => logged.push(text) });
  await h.script.command('echo not an open command');
  assert.ok(logged.some((l) => l === 'Script: echo not an open command'));
});

// ===========================================================================
// 14. listing format
// ===========================================================================

test('listingStr matches the WinSCP column layout', () => {
  const line = listingStr({
    name: 'index.html', type: 'file', size: 1234, mtime: Date.UTC(2024, 0, 2, 3, 4, 5),
    rights: 'rw-r--r--', owner: 'martin', group: 'users',
  });
  assert.ok(line.startsWith('-rw-r--r--   1 martin   users         1234 '));
  assert.ok(line.endsWith('index.html'));
});

test('listingStr shows the link target for a symbolic link', () => {
  const line = listingStr({
    name: 'www', type: 'link', size: 0, mtime: 0, rights: 'rwxrwxrwx',
    linkTarget: '/var/www', isSymlink: true,
  });
  assert.ok(line.startsWith('lrwxrwxrwx'));
  assert.ok(line.endsWith('www -> /var/www'));
});

// ===========================================================================
// 15. %-expansion
// ===========================================================================

test('expandCommand substitutes %1%..%N% from the script parameters', () => {
  assert.equal(
    CR.expandCommand('put %1% %2%', ['a.txt', '/remote/'], { env: {}, now: 0 }),
    'put a.txt /remote/');
});

test('expandCommand replaces %TIMESTAMP% with a sortable stamp', () => {
  const now = new Date(2024, 4, 6, 7, 8, 9).getTime();
  assert.equal(
    CR.expandCommand('get log.txt log_%TIMESTAMP%.txt', [], { env: {}, now }),
    'get log.txt log_20240506070809.txt');
});

test('an external TIMESTAMP environment variable wins over the built-in one', () => {
  const now = new Date(2024, 4, 6, 7, 8, 9).getTime();
  assert.equal(
    CR.expandCommand('echo %TIMESTAMP%', [], { env: { TIMESTAMP: 'pinned' }, now }),
    'echo pinned');
});

test('expandCommand honours the %TIMESTAMP#format% form', () => {
  const now = new Date(2024, 4, 6, 7, 8, 9).getTime();
  assert.equal(
    CR.expandCommand('get %TIMESTAMP#yyyy-mm-dd%.log', [], { env: {}, now }),
    'get 2024-05-06.log');
});

test('expandCommand honours a relative %TIMESTAMP-1D#format%', () => {
  const now = new Date(2024, 4, 6, 7, 8, 9).getTime();
  assert.equal(
    CR.expandCommand('get %TIMESTAMP-1D#yyyymmdd%.log', [], { env: {}, now }),
    'get 20240505.log');
  assert.equal(
    CR.expandCommand('get %TIMESTAMP+2D#yyyymmdd%.log', [], { env: {}, now }),
    'get 20240508.log');
});

test('an unparseable relative timestamp is left alone rather than guessed', () => {
  const now = new Date(2024, 4, 6, 7, 8, 9).getTime();
  const text = CR.expandCommand('get %TIMESTAMP-1Q#yyyymmdd%.log', [], { env: {}, now });
  assert.ok(text.includes('%TIMESTAMP-1Q#yyyymmdd%'));
});

test('expandCommand expands environment variables last', () => {
  assert.equal(
    CR.expandCommand('put %SRC%', [], { env: { SRC: 'c:\\data' }, now: 0 }),
    'put c:\\data');
  assert.equal(
    CR.expandCommand('put %NOSUCHVAR%', [], { env: {}, now: 0 }),
    'put %NOSUCHVAR%');
});

test('formatDateTime uses nn for minutes and mm for months', () => {
  const d = new Date(2024, 0, 2, 3, 4, 5);
  assert.equal(CR.formatDateTime('yyyymmdd', d), '20240102');
  assert.equal(CR.formatDateTime('hhnnss', d), '030405');
  assert.equal(CR.formatDateTime('yy-mm-dd hh:nn', d), '24-01-02 03:04');
});

// ===========================================================================
// 16. script files
// ===========================================================================

test('loadScriptFromFile reads UTF-8 with or without a BOM', () => {
  const dir = tempDir('scriptfile');
  const plain = nodePath.join(dir, 'plain.txt');
  fs.writeFileSync(plain, 'open host\r\nls\r\nexit\r\n');
  assert.deepEqual(CR.loadScriptFromFile(plain), ['open host', 'ls', 'exit']);

  const bom = nodePath.join(dir, 'bom.txt');
  fs.writeFileSync(bom, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('echo héllo\n')]));
  assert.deepEqual(CR.loadScriptFromFile(bom), ['echo héllo']);
});

test('loadScriptFromFile reads UTF-16 with a BOM', () => {
  const dir = tempDir('scriptfile16');
  const f = nodePath.join(dir, 'u16.txt');
  fs.writeFileSync(f, Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from('echo wide\n', 'utf16le')]));
  assert.deepEqual(CR.loadScriptFromFile(f), ['echo wide']);
});

test('loadScriptFromFile refuses a file that is not valid text', () => {
  const dir = tempDir('scriptfilebad');
  const f = nodePath.join(dir, 'bad.txt');
  fs.writeFileSync(f, Buffer.from([0x61, 0xFF, 0xFE, 0x80, 0x0A]));
  assert.throws(() => CR.loadScriptFromFile(f), /not a valid UTF-8 text file/);
});

// ===========================================================================
// 17. the console runner
// ===========================================================================

function runner(consoleOptions = {}, deps = {}) {
  const c = new CR.BufferConsole(consoleOptions);
  return { c, r: new CR.ConsoleRunner(c, deps) };
}

test('a script that succeeds exits 0', async () => {
  const { c, r } = runner();
  const code = await r.run({ scriptCommands: ['echo one', 'echo two', 'exit'] });
  assert.equal(code, CR.RESULT_SUCCESS);
  assert.deepEqual(c.lines, ['one', 'two']);
});

test('a script with any failure exits 1', async () => {
  const { r } = runner();
  const code = await r.run({ scriptCommands: ['bogus', 'exit'] });
  assert.equal(code, CR.RESULT_ANY_ERROR);
});

test('batch abort stops the script at the first failure', async () => {
  const { c, r } = runner();
  const code = await r.run({ scriptCommands: ['bogus', 'echo never'] });
  assert.equal(code, CR.RESULT_ANY_ERROR);
  assert.ok(c.output.includes("Unknown command 'bogus'."));
  assert.ok(!c.output.includes('never'), 'nothing after the failure runs');
});

test('batch continue runs to the end and still exits 1', async () => {
  const { c, r } = runner();
  const code = await r.run({
    scriptCommands: ['option batch continue', 'bogus', 'echo reached', 'exit'],
  });
  assert.equal(code, CR.RESULT_ANY_ERROR);
  assert.ok(c.output.includes('reached'), 'the rest of the script still ran');
});

test('an error goes to the error stream as well as the output', async () => {
  const { c, r } = runner();
  await r.run({ scriptCommands: ['bogus'] });
  assert.ok(c.errors.includes("Unknown command 'bogus'."));
});

test('a script with no commands and no input exits 0 without hanging', async () => {
  const { r } = runner();
  const code = await r.run({ scriptCommands: [] });
  assert.equal(code, CR.RESULT_SUCCESS);
});

test('commands typed at the prompt run after the script commands', async () => {
  const { c, r } = runner({ input: ['echo typed', 'exit'], interactive: true });
  const code = await r.run({ scriptCommands: ['echo scripted'] });
  assert.equal(code, CR.RESULT_SUCCESS);
  assert.ok(c.output.includes('scripted'));
  assert.ok(c.output.includes('typed'));
  assert.ok(c.output.includes('winscp> '), 'the prompt is printed');
});

test('%1% is expanded from the script parameters before the command runs', async () => {
  const { c, r } = runner({}, { env: {} });
  await r.run({ scriptCommands: ['echo %1%-%2%'], scriptParameters: ['a', 'b'] });
  assert.deepEqual(c.lines, ['a-b']);
});

test('the runner reports a session from the command line as deprecated', async () => {
  const { opened, openTerminal } = openable();
  const { c, r } = runner({}, { openTerminal });
  await r.run({ session: 'sftp://cmdline.example.com', scriptCommands: ['exit'] });
  assert.ok(c.output.includes("Opening session using command-line parameter in scripting is deprecated"));
  assert.equal(opened.length, 1);
});

test('a failure to open the command-line session makes the run exit 1', async () => {
  const { c, r } = runner({}, {
    openTerminal: async () => { throw new Error('Connection refused'); },
  });
  const code = await r.run({ session: 'sftp://down.example.com', scriptCommands: ['exit'] });
  assert.equal(code, CR.RESULT_ANY_ERROR);
  assert.ok(c.output.includes('Connection refused'));
});

test('the title tracks the active session', async () => {
  const { c, r } = runner({}, openable());
  await r.run({ scriptCommands: ['exit'] });
  assert.ok(c.titles.length > 0);
  assert.equal(c.titles[0], 'WinSCP Material');
});

test('runConsole reads the commands from a /script= file', async () => {
  const dir = tempDir('runconsole');
  const f = nodePath.join(dir, 's.txt');
  fs.writeFileSync(f, 'echo from file\nexit\n');
  const c = new CR.BufferConsole({});
  const code = await CR.runConsole([`/script=${f}`], { console: c, env: {} });
  assert.equal(code, CR.RESULT_SUCCESS);
  assert.deepEqual(c.lines, ['from file']);
});

test('runConsole appends /command arguments after the script file', async () => {
  const dir = tempDir('runconsole-cmd');
  const f = nodePath.join(dir, 's.txt');
  fs.writeFileSync(f, 'echo first\n');
  const c = new CR.BufferConsole({});
  const code = await CR.runConsole([`/script=${f}`, '/command', 'echo second', 'exit'],
    { console: c, env: {} });
  assert.equal(code, CR.RESULT_SUCCESS);
  assert.deepEqual(c.lines, ['first', 'second']);
});

test('runConsole passes /parameter values through to %1%', async () => {
  const c = new CR.BufferConsole({});
  const code = await CR.runConsole(['/command', 'echo <%1%>', 'exit', '/parameter', 'VALUE'],
    { console: c, env: {} });
  assert.equal(code, CR.RESULT_SUCCESS);
  assert.deepEqual(c.lines, ['<VALUE>']);
});

test('runConsole reports a missing script file and exits 1', async () => {
  const c = new CR.BufferConsole({});
  const code = await CR.runConsole(['/script=C:\\nope\\missing.txt'], { console: c, env: {} });
  assert.equal(code, CR.RESULT_ANY_ERROR);
  assert.ok(/ENOENT|no such file/i.test(c.output));
});

test('runConsole ignores /script and /command under /unsafe', async () => {
  const dir = tempDir('runconsole-unsafe');
  const f = nodePath.join(dir, 's.txt');
  fs.writeFileSync(f, 'echo should not run\n');
  const c = new CR.BufferConsole({});
  const code = await CR.runConsole([`/script=${f}`, '/unsafe'], { console: c, env: {} });
  assert.equal(code, CR.RESULT_SUCCESS);
  assert.ok(!c.output.includes('should not run'));
});

test('stdin scripting runs the commands piped into the process', async () => {
  const stdin = Readable.from(['echo piped one\necho piped two\nexit\n']);
  const chunks = [];
  const stdout = new Writable({ write(chunk, enc, cb) { chunks.push(chunk); cb(); } });
  stdout.isTTY = false;
  const consoleInstance = new CR.StdConsole({ stdin, stdout, stderr: stdout, interactive: false });
  const code = await CR.runConsole(['/console'], { console: consoleInstance, env: {} });
  assert.equal(code, CR.RESULT_SUCCESS);
  const text = Buffer.concat(chunks).toString();
  assert.ok(text.includes('piped one'));
  assert.ok(text.includes('piped two'));
});

test('the exit code is logged at the end of the run', async () => {
  const logged = [];
  const { r } = runner({}, { log: (kind, text) => logged.push(text) });
  await r.run({ scriptCommands: ['exit'] });
  assert.ok(logged.some((l) => l === 'Script: Exit code: 0'));
});

test('the runner closes every session it opened', async () => {
  const adapters = [];
  const openTerminal = async (data) => {
    const a = new MemoryAdapter(data.hostName);
    adapters.push(a);
    return new ScriptTerminal({ adapter: a, name: data.hostName, currentDirectory: a.home });
  };
  const { r } = runner({}, { openTerminal });
  await r.run({ scriptCommands: ['open sftp://a.example.com', 'open sftp://b.example.com', 'exit'] });
  assert.equal(adapters.length, 2);
  assert.ok(adapters.every((a) => a.disconnected), 'both adapters were disconnected');
});

test('an aborted console makes the run exit 1', async () => {
  const c = new CR.BufferConsole({});
  const r = new CR.ConsoleRunner(c, {});
  c.abort();
  const code = await r.run({ scriptCommands: ['echo one', 'echo two'] });
  assert.equal(code, CR.RESULT_ANY_ERROR);
  assert.ok(c.output.includes('Terminated by user.'));
});

// ===========================================================================
// 18. the XML log
// ===========================================================================

test('the XML log brackets each command in a group when /xmlgroups is on', async () => {
  const dir = tempDir('xmllog');
  const f = nodePath.join(dir, 'log.xml');
  const c = new CR.BufferConsole({});
  const code = await CR.runConsole(['/command', 'echo one', 'bogus', `/xmllog=${f}`, '/xmlgroups'],
    { console: c, env: {} });
  assert.equal(code, CR.RESULT_ANY_ERROR);
  const xml = fs.readFileSync(f, 'utf8');
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.ok(xml.includes('<group name="echo one"'));
  assert.ok(xml.includes('<group name="bogus"'));
  assert.ok(xml.includes('<message>Unknown command &apos;bogus&apos;.</message>')
    || xml.includes("<message>Unknown command 'bogus'.</message>"));
  assert.ok(xml.trim().endsWith('</session>'), 'the root element is closed');
});

test('no /xmlgroups means no group elements', async () => {
  const dir = tempDir('xmllog-nogroups');
  const f = nodePath.join(dir, 'log.xml');
  const c = new CR.BufferConsole({});
  await CR.runConsole(['/command', 'bogus', `/xmllog=${f}`], { console: c, env: {} });
  const xml = fs.readFileSync(f, 'utf8');
  assert.ok(!xml.includes('<group'));
  assert.ok(xml.includes('<failure>'));
});

test('XML group names redact credentials from /command open lines', async () => {
  const dir = tempDir('xmllog-redaction');
  const f = nodePath.join(dir, 'log.xml');
  const c = new CR.BufferConsole({});
  const code = await CR.runConsole([
    '/command', 'open sftp://martin:hunter2@example.com -password=second-secret',
    `/xmllog=${f}`, '/xmlgroups',
  ], { console: c, env: {} });

  assert.equal(code, CR.RESULT_ANY_ERROR, 'the fixture has no session manager, so open must fail');
  const xml = fs.readFileSync(f, 'utf8');
  assert.ok(xml.includes('open sftp://martin:***@example.com -password=***'));
  assert.ok(!xml.includes('hunter2'));
  assert.ok(!xml.includes('second-secret'));
});

test('a ScriptXmlLog that cannot be written is fatal only when it is required', () => {
  const bad = nodePath.join(tempDir('xmllog-bad'), 'sub', 'x.xml');
  const optional = new CR.ScriptXmlLog(bad, {
    fs: { mkdirSync() { throw new Error('nope'); } },
  });
  assert.doesNotThrow(() => optional.beginGroup('x'));
  const required = new CR.ScriptXmlLog(bad, {
    required: true,
    fs: { mkdirSync() { throw new Error('nope'); } },
  });
  assert.throws(() => required.beginGroup('x'), /nope/);
});

// ===========================================================================
// 19. odds and ends that only show up in real scripts
// ===========================================================================

test('a quoted path with a space survives the whole pipeline', async () => {
  const { h, dir, remote } = await transferFixture('quoted');
  const sub = nodePath.join(dir, 'my folder');
  fs.mkdirSync(sub);
  fs.writeFileSync(nodePath.join(sub, 'a file.txt'), 'spaces');
  remote.putDir('/my remote');
  await h.script.command(`put "${nodePath.join(sub, 'a file.txt')}" "/my remote/"`);
  assert.equal(String(remote.read('/my remote/a file.txt')), 'spaces');
});

test('a switch-looking parameter after -- is treated as a file name', async () => {
  const h = makeScript();
  const a = new MemoryAdapter();
  a.put('/home/user/-weird.txt', 'x');
  attach(h.script, a);
  await h.script.command('rm -- -weird.txt');
  assert.equal(a.has('/home/user/-weird.txt'), false);
});

test('the pending log lines are replayed into the first session log', async () => {
  const logged = [];
  const sessionLog = { add: (kind, text) => logged.push(`${kind}|${text}`) };
  const openTerminal = async (data) => new ScriptTerminal({
    adapter: new MemoryAdapter(data.hostName),
    session: { log: sessionLog },
    name: data.hostName,
    currentDirectory: '/home/user',
  });
  const h = makeScript({ openTerminal });
  await h.script.command('option batch on');
  assert.equal(logged.length, 0, 'nothing is logged before a session exists');
  await h.script.command('open sftp://example.com');
  assert.ok(logged.some((l) => l.includes('Retrospectively logging previous script records')));
  assert.ok(logged.some((l) => l.includes('option batch on')));
});

test('a reporting script swallows the error and lets the next command run', async () => {
  const h = makeReportingScript();
  await h.script.command('bogus');
  await h.script.command('echo still here');
  assert.deepEqual(h.reported, ["Unknown command 'bogus'."]);
  assert.ok(h.text().includes('still here'));
});

test('synchronize local downloads what the local side is missing', async () => {
  const { h, dir, remote } = await syncFixture('sync-local');
  remote.put('/site/fromremote.txt', 'rrr');
  await h.script.command(`synchronize local ${dir} /site`);
  assert.equal(fs.readFileSync(nodePath.join(dir, 'fromremote.txt'), 'utf8'), 'rrr');
});

test('synchronize with no directories uses both current working directories', async () => {
  const { h, dir, remote } = await syncFixture('sync-cwd');
  h.script.terminal.currentDirectory = '/site';
  h.script.localDirectory = dir;
  fs.writeFileSync(nodePath.join(dir, 'implicit.txt'), 'x');
  await h.script.command('synchronize remote');
  assert.equal(String(remote.read('/site/implicit.txt')), 'x');
});

test('cd into a directory that does not exist reports the failure', async () => {
  const h = makeScript();
  attach(h.script, new MemoryAdapter());
  await assert.rejects(() => h.script.command('cd /nowhere'), /No such directory/);
  assert.equal(h.script.terminal.currentDirectory, '/home/user', 'the old directory is kept');
});

test('a bare - is an ordinary parameter when no stream is wired up', async () => {
  const p = new ScriptProcParams('get', '- target.txt');
  assert.equal(p.paramCount, 2);
  assert.equal(p.param(1), '-');
});

test('copyid refuses anything that is not a public key', async () => {
  const dir = tempDir('copyid');
  const priv = nodePath.join(dir, 'id_rsa');
  fs.writeFileSync(priv, '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n');
  const pub = nodePath.join(dir, 'id_rsa.pub');
  fs.writeFileSync(pub, 'ssh-ed25519 AAAAC3Nza martin@host\n');

  const a = new MemoryAdapter();
  const h = makeScript({ localDirectory: dir });
  attach(h.script, a);

  await assert.rejects(() => h.script.command(`copyid ${priv}`), /is not an SSH public key file/);
  await h.script.command(`copyid ${pub}`);
  assert.ok(a.execCalls[0].command.includes('authorized_keys'));
  assert.ok(a.execCalls[0].opts.stdin.startsWith('ssh-ed25519 '));
});

// ---------------------------------------------------------------------------
// the same timer rule, in the module that actually ships
//
// design/main/console.js had an unref'd prompt timer, and fixing it there left
// the identical shape one file over — in consolerunner.js, which IS the process
// `winscp.com` runs (console.js:1668 spawns `runConsole` from here). So the
// version a user meets still exited at code 0, silently, with a timed prompt
// unanswered.
//
// Worse than its sibling: that one only misbehaved on the Node the CI pins,
// while this reproduced on every runtime tested, because StdConsole.input's
// timer is the last ref'd handle rather than merely a fragile one.
//
// Run in a bare `node -e` child for the same reason the console tests are: the
// test runner's own handles would hold the loop open and hide it.
// ---------------------------------------------------------------------------

test('a timed prompt in the shipped console host outlives a drained event loop', () => {
  const { spawnSync } = require('child_process');
  const modulePath = require.resolve('../design/main/consolerunner');
  const source = `
    const fs = require('fs');
    const { PassThrough } = require('stream');
    const CR = require(${JSON.stringify(modulePath)});
    // A stdin that never delivers a line and never ends: the timeout timer is
    // then the only thing that can settle the promise.
    const c = new CR.StdConsole({ stdin: new PassThrough() });
    let settled = false;
    c.input(true, 25).then((v) => { settled = true; fs.writeSync(1, 'input=' + String(v)); });
    process.on('exit', () => { if (!settled) fs.writeSync(1, 'EXITED-UNANSWERED'); });
  `;
  const child = spawnSync(process.execPath, ['-e', source], { encoding: 'utf8' });
  assert.strictEqual(child.status, 0, `child failed: ${child.stderr}`);
  assert.strictEqual(child.stdout, 'input=null',
    'an unref\'d timer here lets winscp.com exit code 0 with the prompt unanswered');
});

test('keepuptodate does not fall out of its wait loop when the watcher is idle', () => {
  // The 250 ms tick is the only thing on the loop between filesystem events,
  // so unref'ing it ended the command whenever nothing happened to be changing
  // — which is the state it exists to sit in.
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'design', 'main', 'consolerunner.js'), 'utf8');
  // Comments are stripped first: this file now explains at both former sites
  // why the timer is deliberately ref'd, and a guard that trips on its own
  // rationale is the CRLF bug all over again.
  const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/\.unref\s*\(/.test(code),
    'no timer in the shipped console host may be unref\'d — each one is the only '
    + 'thing that can end the wait it belongs to');
});
