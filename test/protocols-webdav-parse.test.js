// protocols-webdav-parse.test.js — the PROPFIND multistatus parser, the path
// escaper and the Digest authentication builder.
//
// Every XML sample below is in the shape a real server family emits. The
// namespace prefix is the thing that varies most between them (`D:`, `d:`,
// `a:`/`lp1:` on IIS, or a defaulted `xmlns="DAV:"`), which is precisely why
// the parser resolves prefixes instead of matching strings.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const {
  parseMultistatus, parseXml, findAll, parseAuthenticate,
  buildDigestHeader, encodePath, encodeSegment,
} = require('../design/main/protocols/webdav');

// --- Apache mod_dav --------------------------------------------------------

const APACHE = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/dav/</D:href>
    <D:propstat>
      <D:prop>
        <D:displayname>dav</D:displayname>
        <D:resourcetype><D:collection/></D:resourcetype>
        <D:getlastmodified>Tue, 03 Mar 2020 09:22:00 GMT</D:getlastmodified>
        <D:creationdate>2019-01-12T10:15:00Z</D:creationdate>
        <D:quota-available-bytes>10737418240</D:quota-available-bytes>
        <D:quota-used-bytes>1048576</D:quota-used-bytes>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/report%20final.txt</D:href>
    <D:propstat>
      <D:prop>
        <D:displayname>report final.txt</D:displayname>
        <D:getcontentlength>1234</D:getcontentlength>
        <D:getlastmodified>Tue, 03 Mar 2020 09:22:00 GMT</D:getlastmodified>
        <D:getetag>"1a2b3c-4d2-59f8a1"</D:getetag>
        <D:getcontenttype>text/plain</D:getcontenttype>
        <D:resourcetype/>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
    <D:propstat>
      <D:prop><D:executable/></D:prop>
      <D:status>HTTP/1.1 404 Not Found</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/sub/</D:href>
    <D:propstat>
      <D:prop>
        <D:displayname>sub</D:displayname>
        <D:resourcetype><D:collection/></D:resourcetype>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`;

test('Apache mod_dav: collections, files, escaped hrefs and quota', () => {
  const items = parseMultistatus(APACHE, { baseUrl: 'https://example.com/dav/' });
  assert.strictEqual(items.length, 3);

  const [root, file, sub] = items;

  assert.strictEqual(root.path, '/dav');
  assert.strictEqual(root.type, 'dir');
  assert.strictEqual(root.isCollection, true);
  assert.strictEqual(root.quota.available, 10737418240);
  assert.strictEqual(root.quota.used, 1048576);
  assert.strictEqual(root.mtime, Date.parse('Tue, 03 Mar 2020 09:22:00 GMT'));
  assert.strictEqual(root.ctime, Date.parse('2019-01-12T10:15:00Z'));

  // The href is percent-encoded; the name is not.
  assert.strictEqual(file.name, 'report final.txt');
  assert.strictEqual(file.path, '/dav/report final.txt');
  assert.strictEqual(file.type, 'file');
  assert.strictEqual(file.size, 1234);
  assert.strictEqual(file.etag, '1a2b3c-4d2-59f8a1');   // quotes stripped
  assert.strictEqual(file.contentType, 'text/plain');
  // The 404 propstat lists properties the server does NOT have; nothing from
  // it may leak into the result.
  assert.strictEqual(file.props.executable, undefined);

  assert.strictEqual(sub.name, 'sub');
  assert.strictEqual(sub.type, 'dir');
  assert.strictEqual(sub.size, 0);
});

// --- Microsoft IIS ---------------------------------------------------------

const IIS = `<?xml version="1.0"?>
<a:multistatus xmlns:b="urn:uuid:c2f41010-65b3-11d1-a29f-00aa00c14882/" xmlns:c="xml:" xmlns:a="DAV:">
  <a:response>
    <a:href>http://files.example.com:8080/share/</a:href>
    <a:propstat>
      <a:status>HTTP/1.1 200 OK</a:status>
      <a:prop>
        <a:getcontentlength b:dt="int">0</a:getcontentlength>
        <a:getlastmodified b:dt="dateTime.rfc1123">Mon, 05 Jun 2023 08:00:00 GMT</a:getlastmodified>
        <a:displayname>share</a:displayname>
        <a:resourcetype><a:collection/></a:resourcetype>
        <a:iscollection b:dt="boolean">1</a:iscollection>
      </a:prop>
    </a:propstat>
  </a:response>
  <a:response>
    <a:href>http://files.example.com:8080/share/Q1%20%26%20Q2.xlsx</a:href>
    <a:propstat>
      <a:status>HTTP/1.1 200 OK</a:status>
      <a:prop>
        <a:getcontentlength b:dt="int">98765</a:getcontentlength>
        <a:getlastmodified b:dt="dateTime.rfc1123">Wed, 07 Jun 2023 12:30:45 GMT</a:getlastmodified>
        <a:displayname>Q1 &amp; Q2.xlsx</a:displayname>
        <a:resourcetype/>
      </a:prop>
    </a:propstat>
  </a:response>
</a:multistatus>`;

test('IIS: a different prefix, absolute hrefs and entity-encoded names', () => {
  const items = parseMultistatus(IIS, { baseUrl: 'http://files.example.com:8080/share/' });
  assert.strictEqual(items.length, 2);

  assert.strictEqual(items[0].path, '/share');
  assert.strictEqual(items[0].type, 'dir');
  assert.strictEqual(items[0].name, 'share');

  assert.strictEqual(items[1].type, 'file');
  assert.strictEqual(items[1].size, 98765);
  assert.strictEqual(items[1].name, 'Q1 & Q2.xlsx');
  assert.strictEqual(items[1].displayName, 'Q1 & Q2.xlsx');
  assert.strictEqual(items[1].mtime, Date.parse('Wed, 07 Jun 2023 12:30:45 GMT'));
});

// --- sabre/dav (Nextcloud, ownCloud) --------------------------------------

const SABRE = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns">
 <d:response>
  <d:href>/remote.php/dav/files/alice/</d:href>
  <d:propstat>
   <d:prop>
    <d:getlastmodified>Fri, 01 Dec 2023 09:00:00 GMT</d:getlastmodified>
    <d:resourcetype><d:collection/></d:resourcetype>
    <d:quota-used-bytes>5242880</d:quota-used-bytes>
    <d:quota-available-bytes>-3</d:quota-available-bytes>
    <oc:size>5242880</oc:size>
   </d:prop>
   <d:status>HTTP/1.1 200 OK</d:status>
  </d:propstat>
  <d:propstat>
   <d:prop><d:getcontentlength/><d:getcontenttype/></d:prop>
   <d:status>HTTP/1.1 404 Not Found</d:status>
  </d:propstat>
 </d:response>
 <d:response>
  <d:href>/remote.php/dav/files/alice/Documents/notes.md</d:href>
  <d:propstat>
   <d:prop>
    <d:getlastmodified>Sat, 02 Dec 2023 11:11:11 GMT</d:getlastmodified>
    <d:getcontentlength>4096</d:getcontentlength>
    <d:resourcetype/>
    <d:getetag>&quot;99a0c3ce3fd2f1c8e0f5a0c9e1c2b3a4&quot;</d:getetag>
    <d:getcontenttype>text/markdown</d:getcontenttype>
    <oc:permissions>RGDNVW</oc:permissions>
   </d:prop>
   <d:status>HTTP/1.1 200 OK</d:status>
  </d:propstat>
 </d:response>
</d:multistatus>`;

test('sabre/dav: vendor namespaces are kept without colliding with DAV:', () => {
  const items = parseMultistatus(SABRE, { baseUrl: 'https://cloud.example.com/remote.php/dav/files/alice/' });
  assert.strictEqual(items.length, 2);

  const [home, note] = items;
  assert.strictEqual(home.type, 'dir');
  assert.strictEqual(home.path, '/remote.php/dav/files/alice');
  assert.strictEqual(home.name, 'alice');
  assert.strictEqual(home.quota.used, 5242880);
  // Nextcloud reports -3 for "unlimited"; that is the server's value and the
  // parser passes it through rather than inventing a number.
  assert.strictEqual(home.quota.available, -3);
  // A vendor property lives under its own namespace key, so it cannot be
  // mistaken for a DAV: property of the same local name.
  assert.strictEqual(home.props['http://owncloud.org/ns#size'].text, '5242880');
  assert.strictEqual(home.props.size, undefined);

  assert.strictEqual(note.name, 'notes.md');
  assert.strictEqual(note.type, 'file');
  assert.strictEqual(note.size, 4096);
  assert.strictEqual(note.etag, '99a0c3ce3fd2f1c8e0f5a0c9e1c2b3a4');
  assert.strictEqual(note.props['http://owncloud.org/ns#permissions'].text, 'RGDNVW');
});

// --- default namespace, no prefix at all ----------------------------------

const DEFAULT_NS = `<?xml version="1.0" encoding="utf-8"?>
<multistatus xmlns="DAV:">
  <response>
    <href>/files/archive.tar.gz</href>
    <propstat>
      <prop>
        <getcontentlength>52428800</getcontentlength>
        <getlastmodified>Thu, 01 Feb 2024 06:00:00 GMT</getlastmodified>
        <resourcetype/>
      </prop>
      <status>HTTP/1.1 200 OK</status>
    </propstat>
  </response>
</multistatus>`;

test('a defaulted DAV: namespace with no prefix parses identically', () => {
  const items = parseMultistatus(DEFAULT_NS, { baseUrl: 'http://h/files/' });
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].name, 'archive.tar.gz');
  assert.strictEqual(items[0].size, 52428800);
  assert.strictEqual(items[0].type, 'file');
});

test('a collection signalled only by a trailing slash is still a directory', () => {
  const xml = `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">
    <D:response><D:href>/pub/incoming/</D:href></D:response></D:multistatus>`;
  const items = parseMultistatus(xml, { baseUrl: 'http://h/pub/' });
  assert.strictEqual(items[0].type, 'dir');
  assert.strictEqual(items[0].name, 'incoming');
});

test('per-response failure statuses survive for MOVE/DELETE reporting', () => {
  const xml = `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">
    <D:response>
      <D:href>/a/locked.txt</D:href>
      <D:status>HTTP/1.1 423 Locked</D:status>
    </D:response>
    <D:response>
      <D:href>/a/gone.txt</D:href>
      <D:status>HTTP/1.1 424 Failed Dependency</D:status>
    </D:response>
  </D:multistatus>`;
  const items = parseMultistatus(xml, { baseUrl: 'http://h/a/' });
  assert.deepStrictEqual(items.map((i) => [i.name, i.status]), [['locked.txt', 423], ['gone.txt', 424]]);
});

test('CDATA, comments and the XML declaration do not confuse the reader', () => {
  const xml = `<?xml version="1.0"?>
  <!-- generated by a proxy -->
  <D:multistatus xmlns:D="DAV:">
    <D:response>
      <D:href><![CDATA[/weird/a&b<c.txt]]></D:href>
      <D:propstat><D:prop><D:getcontentlength>5</D:getcontentlength></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status></D:propstat>
    </D:response>
  </D:multistatus>`;
  const items = parseMultistatus(xml, { baseUrl: 'http://h/' });
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].size, 5);
  assert.strictEqual(items[0].name, 'a&b<c.txt');
});

test('parseXml exposes attributes and resolves nested prefix redefinitions', () => {
  const doc = parseXml('<r xmlns="DAV:"><a:x xmlns:a="urn:one" id="1"><y/></a:x><x/></r>');
  const outer = findAll(doc, 'urn:one', 'x');
  assert.strictEqual(outer.length, 1);
  assert.strictEqual(outer[0].attrs.id, '1');
  // <y/> inherits the default namespace, not the prefixed one.
  assert.strictEqual(findAll(doc, 'DAV:', 'y').length, 1);
  // The second <x/> is in the default namespace, so it is a different element.
  assert.strictEqual(findAll(doc, 'DAV:', 'x').length, 1);
});

// --- path escaping ---------------------------------------------------------

test('path escaping: default keeps sub-delimiters, liberal escapes them', () => {
  assert.strictEqual(encodePath('/a b/c.txt', false), '/a%20b/c.txt');
  assert.strictEqual(encodePath('/a b/c.txt', true), '/a%20b/c.txt');

  // Sub-delimiters are legal in a path segment and stay readable by default.
  assert.strictEqual(encodeSegment("re+port,v1;x=1&y(2)", false), "re+port,v1;x=1&y(2)");
  assert.strictEqual(
    encodeSegment("re+port,v1;x=1&y(2)", true),
    're%2Bport%2Cv1%3Bx%3D1%26y%282%29',
  );

  // Non-ASCII is UTF-8 percent-encoded in both modes.
  assert.strictEqual(encodePath('/文件/報告.txt', false), '/%E6%96%87%E4%BB%B6/%E5%A0%B1%E5%91%8A.txt');
  assert.strictEqual(encodePath('/文件/報告.txt', true), '/%E6%96%87%E4%BB%B6/%E5%A0%B1%E5%91%8A.txt');

  // A literal percent is always escaped, or the URL would be ambiguous.
  assert.strictEqual(encodeSegment('100%.txt', false), '100%25.txt');
  assert.strictEqual(encodeSegment('#anchor?q', false), '%23anchor%3Fq');
});

// --- authentication --------------------------------------------------------

test('parseAuthenticate splits multiple challenges and quoted commas', () => {
  const header = 'Digest realm="test, realm", qop="auth,auth-int", nonce="dcd98b71", '
    + 'opaque="5ccc069c", algorithm=MD5, Basic realm="fallback"';
  const challenges = parseAuthenticate(header);
  const digest = challenges.find((c) => c.scheme === 'Digest');
  const basic = challenges.find((c) => c.scheme === 'Basic');

  assert.ok(digest, 'digest challenge present');
  assert.strictEqual(digest.params.realm, 'test, realm');
  assert.strictEqual(digest.params.qop, 'auth,auth-int');
  assert.strictEqual(digest.params.nonce, 'dcd98b71');
  assert.strictEqual(digest.params.algorithm, 'MD5');
  assert.ok(basic, 'basic challenge present');
  assert.strictEqual(basic.params.realm, 'fallback');
});

test('Digest MD5 with qop=auth matches the RFC 7616 worked example', () => {
  // RFC 7616 §3.9.1: user "Mufasa", password "Circle of Life",
  // GET /dir/index.html, realm "http-auth@example.org".
  const challenge = {
    scheme: 'Digest',
    params: {
      realm: 'http-auth@example.org',
      qop: 'auth',
      algorithm: 'MD5',
      nonce: '7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v',
      opaque: 'FQhe/qaU925kfnzjCev0ciny7QMkPqMAFRtzCUYo5tdS',
    },
  };
  const header = buildDigestHeader({
    username: 'Mufasa',
    password: 'Circle of Life',
    method: 'GET',
    uri: '/dir/index.html',
    challenge,
    nc: 1,
    cnonce: 'f2/wE4q74E6zIJEtWaHKaf5wv/H5QzzpXusqGemxURZJ',
  });

  assert.match(header, /^Digest /);
  assert.match(header, /nc=00000001/);
  assert.match(header, /qop=auth/);
  assert.match(header, /algorithm=MD5/);
  assert.match(header, /opaque="FQhe\/qaU925kfnzjCev0ciny7QMkPqMAFRtzCUYo5tdS"/);
  assert.match(header, /response="8ca523f5e9506fed4657c9700eebdbec"/);
});

test('Digest SHA-256 with qop=auth matches the RFC 7616 worked example', () => {
  const challenge = {
    scheme: 'Digest',
    params: {
      realm: 'http-auth@example.org',
      qop: 'auth',
      algorithm: 'SHA-256',
      nonce: '7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v',
      opaque: 'FQhe/qaU925kfnzjCev0ciny7QMkPqMAFRtzCUYo5tdS',
    },
  };
  const header = buildDigestHeader({
    username: 'Mufasa',
    password: 'Circle of Life',
    method: 'GET',
    uri: '/dir/index.html',
    challenge,
    nc: 1,
    cnonce: 'f2/wE4q74E6zIJEtWaHKaf5wv/H5QzzpXusqGemxURZJ',
  });
  assert.match(
    header,
    /response="753927fa0e85d155564e2e272a28d1802ca10daf4496794697cf8db5856cb6c1"/,
  );
});

test('Digest without qop falls back to the RFC 2069 response form', () => {
  const challenge = { scheme: 'Digest', params: { realm: 'r', nonce: 'n' } };
  const header = buildDigestHeader({
    username: 'u', password: 'p', method: 'PROPFIND', uri: '/dav/', challenge, nc: 1, cnonce: 'c',
  });
  const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');
  const expected = md5(`${md5('u:r:p')}:n:${md5('PROPFIND:/dav/')}`);
  assert.match(header, new RegExp(`response="${expected}"`));
  assert.ok(!header.includes('qop='), 'no qop parameters when the server offered none');
  assert.ok(!header.includes('nc='), 'no nonce count when there is no qop');
});

test('Digest MD5-sess mixes the nonces into HA1', () => {
  const params = { realm: 'r', nonce: 'n', qop: 'auth', algorithm: 'MD5-sess' };
  const header = buildDigestHeader({
    username: 'u', password: 'p', method: 'GET', uri: '/x', challenge: { scheme: 'Digest', params },
    nc: 2, cnonce: 'cn',
  });
  const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');
  const ha1 = md5(`${md5('u:r:p')}:n:cn`);
  const expected = md5(`${ha1}:n:00000002:cn:auth:${md5('GET:/x')}`);
  assert.match(header, new RegExp(`response="${expected}"`));
  assert.match(header, /nc=00000002/);
});
