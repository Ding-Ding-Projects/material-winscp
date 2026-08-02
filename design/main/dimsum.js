// dimsum.js — access to the bundled dim sum catalog.
//
// Two consumers:
//   * the 10%-per-launch startup surprise, which needs a random dish that has
//     a real picture on disk;
//   * the release code name, which needs the *next unused* dish so two builds
//     are never called the same thing.
//
// Hard rule: this module only ever returns an image that exists on disk right
// now. It never generates, downloads or invents one. A catalog that is still
// being filled in is reported as `in-progress` and the records without a real
// PNG are simply not candidates — a code name whose picture 404s is worse than
// no code name at all.
'use strict';
const fs = require('fs');
const path = require('path');

/** Where the bundled PNGs live, relative to this file. */
const ASSET_DIR = path.join(__dirname, '..', 'assets');

/** Files are named `dim-<number>-<slug>.png`. */
const FILE_RE = /^dim-(\d+)-([a-z0-9-]+)\.png$/i;

/**
 * Traditional Chinese names for the dishes bundled with this build.
 * These are the standard names of well-known dim sum, not invented ones; a
 * slug with no entry here falls back to its English title alone rather than
 * having a Chinese name made up for it.
 */
const NAMES = {
  'har-gow': { en: 'Har Gow', zh: '蝦餃' },
  'siu-mai': { en: 'Siu Mai', zh: '燒賣' },
  'char-siu-bao': { en: 'Char Siu Bao', zh: '叉燒包' },
  'custard-bao': { en: 'Custard Bao', zh: '奶黃包' },
  'radish-cake': { en: 'Radish Cake', zh: '蘿蔔糕' },
  'egg-tarts': { en: 'Egg Tarts', zh: '蛋撻' },
};

/** Title-case a slug so an un-named dish still reads like a dish. */
function titleFromSlug(slug) {
  return slug.split('-').map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
}

/**
 * An index JSON is optional. When the full catalog lands it will carry the
 * authored names and prompts; until then the file names are the index.
 * Both `index.json` and `dim-sum/index.json` are honoured because the catalog
 * repository uses the latter shape.
 */
function readIndex() {
  const candidates = [
    path.join(ASSET_DIR, 'index.json'),
    path.join(ASSET_DIR, 'dim-sum', 'index.json'),
    path.join(ASSET_DIR, 'dim-sum.json'),
  ];
  for (const f of candidates) {
    try {
      if (!fs.existsSync(f)) continue;
      const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
      const records = Array.isArray(raw) ? raw : (raw.records || raw.items || raw.dishes || []);
      if (Array.isArray(records) && records.length) return { file: f, records, meta: Array.isArray(raw) ? {} : raw };
    } catch {
      // A malformed index must not take the surprise down with it; the file
      // names on disk are always the fallback source of truth.
    }
  }
  return null;
}

/** Everything that has a decodable PNG on disk. */
function loadCatalog() {
  const byId = new Map();

  let files = [];
  try { files = fs.readdirSync(ASSET_DIR); } catch { files = []; }

  for (const f of files) {
    const m = FILE_RE.exec(f);
    if (!m) continue;
    const full = path.join(ASSET_DIR, f);
    let size = 0;
    try { size = fs.statSync(full).size; } catch { continue; }
    if (size <= 0) continue;                     // a zero-byte placeholder is not an image
    if (!looksLikePng(full)) continue;           // and neither is a renamed text file
    const slug = m[2].toLowerCase();
    const named = NAMES[slug];
    byId.set(m[1], {
      id: m[1],
      slug,
      file: f,
      path: full,
      bytes: size,
      en: named ? named.en : titleFromSlug(slug),
      zh: named ? named.zh : '',
    });
  }

  // An index may add names for records whose picture already exists. It never
  // adds a record: a record with no PNG is not a candidate for anything.
  const idx = readIndex();
  if (idx) {
    for (const r of idx.records) {
      const id = String(r.id || r.number || '').padStart(4, '0');
      const rec = byId.get(id);
      if (!rec) continue;
      if (r.en || r.nameEn) rec.en = r.en || r.nameEn;
      if (r.zh || r.nameZh || r.chinese) rec.zh = r.zh || r.nameZh || r.chinese;
      if (r.category) rec.category = r.category;
    }
  }

  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** The PNG signature. Cheap proof the bytes really are an image. */
function looksLikePng(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(8);
    if (fs.readSync(fd, head, 0, 8, 0) < 8) return false;
    return head.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  } catch {
    return false;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

let cached = null;
function catalog(force) {
  if (!cached || force) cached = loadCatalog();
  return cached;
}

/** The catalog is built incrementally; say so rather than implying completeness. */
function status() {
  const items = catalog();
  const idx = readIndex();
  const expected = idx && idx.meta && Number(idx.meta.expected) ? Number(idx.meta.expected) : 0;
  return {
    available: items.length,
    expected,
    catalogStatus: expected && items.length >= expected ? 'complete' : 'in-progress',
    assetDir: ASSET_DIR,
  };
}

/**
 * A dish for the startup surprise. `exclude` lets the caller pass the ids it
 * has already shown so the same dish does not come up twice in a row.
 */
function pick(exclude) {
  const items = catalog();
  if (!items.length) return null;
  const skip = new Set(exclude || []);
  let pool = items.filter((d) => !skip.has(d.id));
  if (!pool.length) pool = items;               // everything seen: start again
  return { ...pool[Math.floor(Math.random() * pool.length)] };
}

/** A fresh draw per launch. Never more frequent than the stated 10%. */
function shouldSurprise(chance) {
  const p = typeof chance === 'number' ? chance : 0.1;
  return Math.random() < p;
}

/**
 * The next unused release code name. `used` is the list of dish ids previous
 * releases took, so a name is never handed out twice for one project.
 * Returns null when nothing is left — the caller ships the version alone
 * rather than blocking the release.
 */
function codeName(used) {
  const items = catalog();
  if (!items.length) return null;
  const taken = new Set((used || []).map(String));
  const next = items.find((d) => !taken.has(d.id));
  if (!next) return null;
  return {
    id: next.id,
    slug: next.slug,
    en: next.en,
    zh: next.zh,
    label: next.zh ? `${next.en} · ${next.zh}` : next.en,
    file: next.file,
    path: next.path,
    alt: next.zh ? `${next.en} (${next.zh})` : next.en,
  };
}

/** Read the bytes of a bundled image, for embedding in a page or a release. */
function imageBuffer(id) {
  const rec = catalog().find((d) => d.id === String(id));
  if (!rec) return null;
  try { return fs.readFileSync(rec.path); } catch { return null; }
}

/** A data: URI, so the renderer never needs a file:// or a network fetch. */
function dataUri(id) {
  const buf = imageBuffer(id);
  return buf ? `data:image/png;base64,${buf.toString('base64')}` : null;
}

module.exports = { catalog, status, pick, shouldSurprise, codeName, imageBuffer, dataUri, ASSET_DIR };
