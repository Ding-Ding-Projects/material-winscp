// The local backend, exercised against a real temporary directory. Nothing here
// is mocked: if these pass, the Commander's local panel genuinely works on the
// host that ran them.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { LocalAdapter } = require('../design/main/protocols/local');

const isWindows = process.platform === 'win32';
let root;
let adapter;

async function drain(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks);
}

test.before(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'winscp-local-'));
  adapter = new LocalAdapter({});
  await adapter.connect();
});

test.after(async () => {
  await adapter.disconnect();
  await fsp.rm(root, { recursive: true, force: true });
});

test('connect reports the host it is running on', () => {
  assert.equal(adapter.connected, true);
  assert.equal(adapter.protocolName, 'Local');
  assert.equal(adapter.serverInfo.platform, process.platform);
  assert.ok(adapter.home && adapter.home.length, 'the home directory is known');
});

test('mkdir creates a directory and list finds it', async () => {
  const dir = adapter.join(root, 'sub');
  await adapter.mkdir(dir);
  const rows = await adapter.list(root);
  const found = rows.find((r) => r.name === 'sub');
  assert.ok(found, 'the new directory appears in the listing');
  assert.equal(found.type, 'dir');
  assert.equal(found.isSymlink, false);
  assert.ok(found.mtime > 0, 'the listing carries a modification time');
});

test('mkdir recursive builds the whole chain', async () => {
  const deep = adapter.join(root, 'a', 'b', 'c');
  await adapter.mkdir(deep, { recursive: true });
  const st = await adapter.stat(deep);
  assert.equal(st.type, 'dir');
});

test('writeFile and readFile round-trip through the streams', async () => {
  const file = adapter.join(root, 'sub', 'hello.txt');
  const payload = Buffer.from('Hello, WinSCP Material.\n', 'utf8');
  await adapter.writeFile(file, payload);
  const back = await adapter.readFile(file);
  assert.deepEqual(back, payload);

  const rows = await adapter.list(adapter.join(root, 'sub'));
  const row = rows.find((r) => r.name === 'hello.txt');
  assert.ok(row);
  assert.equal(row.type, 'file');
  assert.equal(row.size, payload.length);
});

test('createReadStream honours start and end', async () => {
  const file = adapter.join(root, 'sub', 'hello.txt');
  const part = await drain(await adapter.createReadStream(file, { start: 7, end: 10 }));
  assert.equal(part.toString('utf8'), 'WinS');
});

test('createWriteStream with a start offset resumes instead of truncating', async () => {
  const file = adapter.join(root, 'resume.bin');
  await adapter.writeFile(file, Buffer.from('HelloWorld'));

  const ws = await adapter.createWriteStream(file, { start: 5 });
  await new Promise((resolve, reject) => {
    ws.on('error', reject);
    ws.on('close', resolve);
    ws.end(Buffer.from('THERE'));
  });

  assert.equal((await adapter.readFile(file)).toString('utf8'), 'HelloTHERE');
  assert.equal(adapter.caps.resume, true);
});

test('stat describes a file the same way list does', async () => {
  const file = adapter.join(root, 'sub', 'hello.txt');
  const st = await adapter.stat(file);
  assert.equal(st.name, 'hello.txt');
  assert.equal(st.type, 'file');
  assert.equal(st.size, 24);
  assert.equal(st.isSymlink, false);
  assert.equal(st.raw.path, adapter.normalize(file));
});

test('rename moves a file within the tree', async () => {
  const from = adapter.join(root, 'sub', 'hello.txt');
  const to = adapter.join(root, 'sub', 'renamed.txt');
  await adapter.rename(from, to);
  assert.equal(await adapter.exists(from), false);
  assert.equal(await adapter.exists(to), true);
  await adapter.rename(to, from);
});

test('setTimes writes the modification time back', async () => {
  const file = adapter.join(root, 'sub', 'hello.txt');
  const when = Date.UTC(2021, 4, 17, 8, 30, 0);
  await adapter.setTimes(file, when);
  const st = await adapter.stat(file);
  assert.ok(Math.abs(st.mtime - when) < 2000, `mtime ${st.mtime} is close to ${when}`);
  assert.equal(adapter.caps.timestamp, true);
});

test('setRights applies a permission string', async () => {
  const file = adapter.join(root, 'sub', 'hello.txt');
  await adapter.setRights(file, 'rw-r--r--');
  const st = await adapter.stat(file);
  if (adapter.caps.rights) assert.equal(st.rights, 'rw-r--r--');
  else assert.equal(st.readOnly, false, 'Windows keeps only the read-only flag');
});

test('checksum hashes the real bytes', async () => {
  const file = adapter.join(root, 'checksum.txt');
  await adapter.writeFile(file, Buffer.from('abc'));
  // The published SHA-256 of "abc".
  assert.equal(await adapter.checksum(file, 'sha256'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(await adapter.checksum(file, 'md5'), '900150983cd24fb0d6963f7d28e17f72');
});

test('calculateSize walks the tree', async () => {
  const dir = adapter.join(root, 'sized');
  await adapter.mkdir(dir);
  await adapter.mkdir(adapter.join(dir, 'inner'));
  await adapter.writeFile(adapter.join(dir, 'one.bin'), Buffer.alloc(100, 1));
  await adapter.writeFile(adapter.join(dir, 'inner', 'two.bin'), Buffer.alloc(50, 2));
  const totals = await adapter.calculateSize(dir);
  assert.equal(totals.bytes, 150);
  assert.equal(totals.files, 2);
  assert.equal(totals.dirs, 1);
});

test('spaceInfo reports the volume', async () => {
  const info = await adapter.spaceInfo(root);
  assert.ok(info, 'the volume answered');
  assert.ok(info.total > 0, 'a total size was reported');
  assert.ok(info.free >= 0 && info.free <= info.total);
  assert.equal(adapter.caps.spaceInfo, true);
});

test('symlink creates a link, or a junction where Windows insists', async () => {
  const target = adapter.join(root, 'linktarget');
  await adapter.mkdir(target);
  const link = adapter.join(root, 'thelink');
  let kind;
  try {
    ({ kind } = await adapter.symlink(target, link, 'dir'));
  } catch (e) {
    // Without Developer Mode and without elevation even a junction can be
    // refused; that is a host policy, not a defect in the adapter.
    assert.ok(['EPERM', 'EACCES', 'ENOSYS'].includes(e.code), `unexpected error ${e.message}`);
    return;
  }
  assert.ok(kind === 'symlink' || kind === 'junction');
  const st = await adapter.stat(link);
  assert.equal(st.isSymlink, true);
  assert.equal(st.type, 'dir', 'a link to a directory still navigates like one');
  assert.ok(st.linkTarget.length > 0);
  assert.equal(adapter.normalize(await adapter.readlink(link)).toLowerCase(),
    adapter.normalize(target).toLowerCase());
  await adapter.remove(link);
});

test('remove deletes files, and directories only when told to recurse', async () => {
  const dir = adapter.join(root, 'doomed');
  await adapter.mkdir(dir);
  await adapter.writeFile(adapter.join(dir, 'inside.txt'), Buffer.from('x'));

  await assert.rejects(() => adapter.remove(dir), /not empty|ENOTEMPTY/i);
  await adapter.remove(dir, { recursive: true });
  assert.equal(await adapter.exists(dir), false);

  const file = adapter.join(root, 'single.txt');
  await adapter.writeFile(file, Buffer.from('x'));
  await adapter.remove(file);
  assert.equal(await adapter.exists(file), false);
});

test('a Recycle Bin delete never silently becomes a permanent one', async () => {
  const file = adapter.join(root, 'recycle-me.txt');
  await adapter.writeFile(file, Buffer.from('x'));

  if (!adapter.caps.recycleBin) {
    await assert.rejects(() => adapter.remove(file, { toRecycleBin: true }), /Recycle Bin/);
    assert.equal(await adapter.exists(file), true, 'the file survived the refusal');
    // Only an explicit fallback may delete it for good.
    await adapter.remove(file, { toRecycleBin: true, allowPermanentFallback: true });
    assert.equal(await adapter.exists(file), false);
  } else {
    await adapter.remove(file, { toRecycleBin: true });
    assert.equal(await adapter.exists(file), false);
  }
});

test('the log channel reports what the adapter did', async () => {
  const seen = [];
  const listener = (e) => seen.push(e);
  adapter.on('log', listener);
  await adapter.mkdir(adapter.join(root, 'logged'));
  adapter.off('log', listener);
  assert.ok(seen.some((e) => e.level === 'debug' && /Created directory/.test(e.message)));
});

test('hidden and read-only come from the Windows file attributes', { skip: !isWindows }, async () => {
  const dir = adapter.join(root, 'attrs');
  await adapter.mkdir(dir);
  const hidden = adapter.join(dir, 'hidden.txt');
  const readonly = adapter.join(dir, 'readonly.txt');
  await adapter.writeFile(hidden, Buffer.from('h'));
  await adapter.writeFile(readonly, Buffer.from('r'));
  execFileSync('attrib', ['+H', hidden], { windowsHide: true });
  execFileSync('attrib', ['+R', readonly], { windowsHide: true });

  const rows = await adapter.list(dir);
  const h = rows.find((r) => r.name === 'hidden.txt');
  const r = rows.find((r) => r.name === 'readonly.txt');
  assert.equal(h.hidden, true, 'FILE_ATTRIBUTE_HIDDEN was picked up');
  assert.equal(h.readOnly, false);
  assert.equal(r.readOnly, true, 'FILE_ATTRIBUTE_READONLY was picked up');
  assert.equal(r.hidden, false);

  execFileSync('attrib', ['-H', hidden], { windowsHide: true });
  execFileSync('attrib', ['-R', readonly], { windowsHide: true });
});

test('the virtual root lists the drives', { skip: !isWindows }, async () => {
  assert.ok(adapter.isVirtualRoot(''));
  const drives = await adapter.list('');
  assert.ok(drives.length > 0, 'at least one drive answered');
  for (const d of drives) {
    assert.equal(d.type, 'dir');
    assert.match(d.name, /^[A-Z]:$/);
    assert.equal(d.raw.drive, true);
  }
  const here = adapter.normalize(root).slice(0, 2);
  assert.ok(drives.some((d) => d.name === here), `the drive holding ${root} is listed`);
  assert.equal(adapter.dirname(here + '\\'), '', 'a drive root sits under the virtual root');
});

test('the adapter states its own separator, and join agrees with it', async () => {
  // queue.js:_buildPlan prunes empty directories with a prefix test built from
  // `dst.sep`. That is only correct if `sep` really is the character `join`
  // puts between segments — sniffing process.platform there would have been
  // wrong for a session constructed with an explicit platform, and a wrong
  // separator prunes directories that are full of files.
  assert.equal(adapter.sep, isWindows ? '\\' : '/');
  const joined = adapter.join('base', 'child');
  assert.equal(joined, `base${adapter.sep}child`);
  assert.ok(joined.startsWith(`base${adapter.sep}`), 'the prefix test the queue relies on holds');

  // Both shapes are reachable regardless of the host, because `session.platform`
  // selects the helpers (local.js:208-209) while file-system calls stay real.
  const { LocalAdapter: LA } = require('../design/main/protocols/local');
  assert.equal(new LA({ platform: 'win32' }).sep, '\\');
  assert.equal(new LA({ platform: 'linux' }).sep, '/');
  assert.equal(new LA({ platform: 'win32' }).join('C:\\work', 'sub'), 'C:\\work\\sub');
});

test('POSIX listings carry rights and owner', { skip: isWindows }, async () => {
  const file = adapter.join(root, 'perms.txt');
  await adapter.writeFile(file, Buffer.from('x'));
  await adapter.setRights(file, 'rwxr-x---');
  const rows = await adapter.list(root);
  const row = rows.find((r) => r.name === 'perms.txt');
  assert.equal(row.rights, 'rwxr-x---');
  assert.equal(row.owner, String(process.getuid()));
  assert.equal(adapter.caps.owner, true);
});
