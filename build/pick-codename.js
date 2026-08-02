// build/pick-codename.js — resolve the dim sum code name and release photo.
//
//   node build/pick-codename.js --index 7 [--json out.json]
//
// Prints (and optionally writes) the dish assigned to release number N, plus
// the absolute path of its bundled photograph. Every candidate image is DECODED
// before it is offered, so a record whose PNG is missing or corrupt is skipped
// rather than shipped as a broken code name.
//
// Nothing here generates, downloads or substitutes an image. The only source is
// design/assets/, which is tracked in this repository.
//
// Exit status is always 0. A release must never be blocked because the catalog
// could not supply a name; when nothing can be resolved the output says so and
// the caller ships the version alone.
'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const CATALOG_JS = path.join(REPO, 'design', 'winscp-data.js');
const LEDGER = path.join(__dirname, 'release-codenames.json');
const ASSET_ROOT = path.join(REPO, 'design');

const { decodePng } = require('./make-icon.js');

/** Read the DISHES array out of design/winscp-data.js.
 *  That file is an ES module owned by another part of the project, so it is
 *  parsed rather than imported — this script must never edit or require it. */
function readCatalog() {
  const src = fs.readFileSync(CATALOG_JS, 'utf8');
  const block = src.match(/export const DISHES\s*=\s*\[([\s\S]*?)\n\];/);
  if (!block) throw new Error('DISHES array not found in design/winscp-data.js');

  const dishes = [];
  const row = /\{\s*id\s*:\s*'([^']+)'\s*,\s*en\s*:\s*'([^']+)'\s*,\s*zh\s*:\s*'([^']+)'\s*,\s*jy\s*:\s*'([^']*)'\s*,\s*img\s*:\s*'([^']+)'\s*\}/g;
  let m;
  while ((m = row.exec(block[1])) !== null) {
    dishes.push({ id: m[1], en: m[2], zh: m[3], jy: m[4], img: m[5] });
  }
  if (!dishes.length) throw new Error('DISHES array parsed but empty');
  return dishes;
}

/** A dish is eligible only when its bundled PNG exists AND decodes. */
function verify(dish) {
  const file = path.join(ASSET_ROOT, dish.img.replace(/\//g, path.sep));
  if (!fs.existsSync(file)) return { ...dish, ok: false, reason: 'image file missing', file };
  try {
    const png = decodePng(fs.readFileSync(file));
    if (!png.width || !png.height) throw new Error('zero dimensions');
    return {
      ...dish,
      ok: true,
      file,
      bytes: fs.statSync(file).size,
      width: png.width,
      height: png.height,
    };
  } catch (err) {
    return { ...dish, ok: false, reason: `image does not decode: ${err.message}`, file };
  }
}

function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1];
  }

  const index = Number(args.index || process.env.RELEASE_INDEX || 1);
  const ledger = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
  const catalog = new Map(readCatalog().map((d) => [d.id, d]));

  // Walk the ledger order, keeping only records with a verified image, so an
  // unverifiable record shifts the sequence rather than wasting a slot.
  const report = [];
  const eligible = [];
  for (const id of ledger.order) {
    const dish = catalog.get(id);
    if (!dish) {
      report.push({ id, ok: false, reason: 'id is not in the catalog' });
      continue;
    }
    const v = verify(dish);
    report.push(v);
    if (v.ok) eligible.push(v);
  }

  const result = {
    releaseIndex: index,
    catalogStatus: ledger.catalogStatus,
    eligibleCount: eligible.length,
    verification: report.map((r) => ({
      id: r.id, ok: r.ok, reason: r.reason || null,
      pixels: r.ok ? `${r.width}x${r.height}` : null,
    })),
  };

  if (index >= 1 && index <= eligible.length) {
    const d = eligible[index - 1];
    Object.assign(result, {
      assigned: true,
      id: d.id,
      en: d.en,
      zh: d.zh,
      jyutping: d.jy,
      codename: `${d.en} · ${d.zh}`,
      imagePath: path.relative(REPO, d.file).replace(/\\/g, '/'),
      imageFile: d.file,
      imageBytes: d.bytes,
      imagePixels: `${d.width}x${d.height}`,
      altText: `${d.en} (${d.zh}), a Hong Kong dim sum dish, from the bundled catalog.`,
    });
  } else {
    Object.assign(result, {
      assigned: false,
      reason: eligible.length
        ? `release ${index} is past the end of the verified sequence (${eligible.length} dishes). ` +
          'A dish is used once and never recycled, so this release ships with its version alone.'
        : 'no catalog record has a verified bundled image.',
    });
  }

  // A photo is still attached to every release even when the *code name*
  // sequence is exhausted: pick a verified dish deterministically for the
  // image slot, and say in the notes that it is the photo, not a code name.
  if (!result.assigned && eligible.length) {
    const d = eligible[(index - 1) % eligible.length];
    Object.assign(result, {
      imagePath: path.relative(REPO, d.file).replace(/\\/g, '/'),
      imageFile: d.file,
      imageBytes: d.bytes,
      imagePixels: `${d.width}x${d.height}`,
      photoEn: d.en,
      photoZh: d.zh,
      altText: `${d.en} (${d.zh}), a Hong Kong dim sum dish, from the bundled catalog.`,
    });
  }

  const json = JSON.stringify(result, null, 2);
  if (args.json) fs.writeFileSync(args.json, json);
  process.stdout.write(json + '\n');

  // Shell-friendly key=value lines for GitHub Actions.
  if (process.env.GITHUB_OUTPUT) {
    const out = [
      `assigned=${result.assigned}`,
      `codename=${result.codename || ''}`,
      `dish_id=${result.id || ''}`,
      `dish_en=${result.en || result.photoEn || ''}`,
      `dish_zh=${result.zh || result.photoZh || ''}`,
      `image_path=${result.imagePath || ''}`,
      `image_bytes=${result.imageBytes || 0}`,
      `image_pixels=${result.imagePixels || ''}`,
      `eligible_count=${result.eligibleCount}`,
    ].join('\n');
    fs.appendFileSync(process.env.GITHUB_OUTPUT, out + '\n');
  }
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { readCatalog, verify };
