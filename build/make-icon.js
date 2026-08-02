// build/make-icon.js — produce build/icon.ico from the tracked vector app logo.
//
// The source of truth is design/assets/app-logo.svg. This script validates its
// exact geometry, renders that geometry locally at high resolution, box-samples
// it to the Windows icon sizes and encodes a multi-size .ico. Nothing is
// downloaded or fetched. Run it with:
//
//     node build/make-icon.js
//
// It is deterministic: the same tracked input always yields the same icon.
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const REPO = path.resolve(__dirname, '..');
const SOURCE = path.join(REPO, 'design', 'assets', 'app-logo.svg');
const OUT = path.join(__dirname, 'icon.ico');
const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const VIEWBOX = 64;

const LOGO = Object.freeze({
  background: { x: 0, y: 0, width: 64, height: 64, radius: 16, color: '#0B57D0' },
  panes: [
    { x: 10, y: 14, width: 17, height: 36, radius: 5, color: '#EADDFF' },
    { x: 37, y: 14, width: 17, height: 36, radius: 5, color: '#D0BCFF' },
  ],
  arrows: [
    { color: '#FFFFFF', points: [[17, 23], [37, 23], [37, 19], [47, 28], [37, 37], [37, 33], [17, 33]] },
    { color: '#FFD8E4', points: [[47, 34], [27, 34], [27, 30], [17, 39], [27, 48], [27, 44], [47, 44]] },
  ],
});

function logoSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" data-logo-version="1">
  <title>WinSCP Material</title>
  <desc>Two file panes exchanging files in both directions</desc>
  <rect width="64" height="64" rx="16" fill="#0B57D0"/>
  <rect x="10" y="14" width="17" height="36" rx="5" fill="#EADDFF"/>
  <rect x="37" y="14" width="17" height="36" rx="5" fill="#D0BCFF"/>
  <path d="M17 23h20v-4l10 9-10 9v-4H17z" fill="#FFFFFF"/>
  <path d="M47 34H27v-4l-10 9 10 9v-4h20z" fill="#FFD8E4"/>
</svg>`;
}

/* ------------------------------------------------------------------ decode */

/** Minimal PNG decoder: 8-bit truecolour (type 2) and truecolour+alpha (6). */
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');

  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  const idat = [];

  let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error('interlaced PNG is not supported');
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }

  if (depth !== 8) throw new Error(`unsupported bit depth ${depth}`);
  const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : 0;
  if (!channels) throw new Error(`unsupported colour type ${colorType}`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  let p = 0;

  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    const line = Buffer.from(raw.subarray(p, p + stride));
    p += stride;

    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v = line[i];
      switch (filter) {
        case 0: break;
        case 1: v = (v + a) & 0xff; break;
        case 2: v = (v + b) & 0xff; break;
        case 3: v = (v + ((a + b) >> 1)) & 0xff; break;
        case 4: {
          const pp = a + b - c;
          const pa = Math.abs(pp - a);
          const pb = Math.abs(pp - b);
          const pc = Math.abs(pp - c);
          const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          v = (v + pred) & 0xff;
          break;
        }
        default: throw new Error(`unknown filter ${filter}`);
      }
      line[i] = v;
    }

    for (let x = 0; x < width; x++) {
      const s = x * channels;
      const d = (y * width + x) * 4;
      out[d] = line[s];
      out[d + 1] = line[s + 1];
      out[d + 2] = line[s + 2];
      out[d + 3] = channels === 4 ? line[s + 3] : 255;
    }
    prev = line;
  }

  return { width, height, rgba: out };
}

/* ---------------------------------------------------------- vector render */

function rgba(hex) {
  const text = String(hex).replace(/^#/, '');
  if (!/^[0-9a-f]{6}$/i.test(text)) throw new Error(`invalid logo colour ${hex}`);
  return [
    Number.parseInt(text.slice(0, 2), 16),
    Number.parseInt(text.slice(2, 4), 16),
    Number.parseInt(text.slice(4, 6), 16),
    255,
  ];
}

function setPixel(image, x, y, color) {
  const i = (y * image.width + x) * 4;
  image.rgba[i] = color[0];
  image.rgba[i + 1] = color[1];
  image.rgba[i + 2] = color[2];
  image.rgba[i + 3] = color[3];
}

function inRoundedRect(px, py, shape) {
  const { x, y, width, height, radius } = shape;
  if (px < x || px > x + width || py < y || py > y + height) return false;
  const nearestX = Math.max(x + radius, Math.min(px, x + width - radius));
  const nearestY = Math.max(y + radius, Math.min(py, y + height - radius));
  const dx = px - nearestX;
  const dy = py - nearestY;
  return dx * dx + dy * dy <= radius * radius;
}

function paintRoundedRect(image, shape) {
  const scale = image.width / VIEWBOX;
  const color = rgba(shape.color);
  const left = Math.max(0, Math.floor(shape.x * scale));
  const top = Math.max(0, Math.floor(shape.y * scale));
  const right = Math.min(image.width, Math.ceil((shape.x + shape.width) * scale));
  const bottom = Math.min(image.height, Math.ceil((shape.y + shape.height) * scale));
  for (let y = top; y < bottom; y++) {
    const py = (y + 0.5) / scale;
    for (let x = left; x < right; x++) {
      const px = (x + 0.5) / scale;
      if (inRoundedRect(px, py, shape)) setPixel(image, x, y, color);
    }
  }
}

function pointInPolygon(px, py, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    const crosses = ((yi > py) !== (yj > py)) &&
      (px < ((xj - xi) * (py - yi)) / (yj - yi) + xi);
    if (crosses) inside = !inside;
  }
  return inside;
}

function paintPolygon(image, shape) {
  const scale = image.width / VIEWBOX;
  const color = rgba(shape.color);
  const xs = shape.points.map((p) => p[0]);
  const ys = shape.points.map((p) => p[1]);
  const left = Math.max(0, Math.floor(Math.min(...xs) * scale));
  const top = Math.max(0, Math.floor(Math.min(...ys) * scale));
  const right = Math.min(image.width, Math.ceil(Math.max(...xs) * scale));
  const bottom = Math.min(image.height, Math.ceil(Math.max(...ys) * scale));
  for (let y = top; y < bottom; y++) {
    const py = (y + 0.5) / scale;
    for (let x = left; x < right; x++) {
      const px = (x + 0.5) / scale;
      if (pointInPolygon(px, py, shape.points)) setPixel(image, x, y, color);
    }
  }
}

/** Render the exact tracked mark without a browser or an image dependency. */
function rasterizeLogo(size = 1024) {
  const image = { width: size, height: size, rgba: Buffer.alloc(size * size * 4) };
  paintRoundedRect(image, LOGO.background);
  for (const pane of LOGO.panes) paintRoundedRect(image, pane);
  for (const arrow of LOGO.arrows) paintPolygon(image, arrow);
  return image;
}

/* ---------------------------------------------------------------- resample */

/** Box filter down-sample. The source is far larger than any icon size, so a
 *  simple area average is both correct and cheap. */
function resample(src, size) {
  const { width: sw, height: sh, rgba } = src;
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const y0 = Math.floor((y * sh) / size);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * sh) / size));
    for (let x = 0; x < size; x++) {
      const x0 = Math.floor((x * sw) / size);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * sw) / size));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * sw + sx) * 4;
          r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2]; a += rgba[i + 3];
          n++;
        }
      }
      const d = (y * size + x) * 4;
      out[d] = Math.round(r / n);
      out[d + 1] = Math.round(g / n);
      out[d + 2] = Math.round(b / n);
      out[d + 3] = Math.round(a / n);
    }
  }
  return out;
}

/** Round the corners so the icon reads as an app tile rather than a photo. */
function roundCorners(rgba, size) {
  const radius = Math.max(2, Math.round(size * 0.22));
  const corners = [
    [radius, radius, 0, 0],
    [size - radius, radius, size, 0],
    [radius, size - radius, 0, size],
    [size - radius, size - radius, size, size],
  ];
  for (const [cx, cy, ox, oy] of corners) {
    const xs = Math.min(cx, ox);
    const xe = Math.max(cx, ox);
    const ys = Math.min(cy, oy);
    const ye = Math.max(cy, oy);
    for (let y = ys; y < ye; y++) {
      for (let x = xs; x < xe; x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d <= radius - 0.5) continue;
        const i = (y * size + x) * 4;
        const cover = d >= radius + 0.5 ? 0 : radius + 0.5 - d;
        rgba[i + 3] = Math.round(rgba[i + 3] * Math.max(0, Math.min(1, cover)));
      }
    }
  }
  return rgba;
}

/* ----------------------------------------------------------------- encode */

/** A single ICO image entry as a 32bpp bottom-up DIB with an AND mask. */
function dibEntry(rgba, size) {
  const rowBits = ((size + 31) >> 5) << 5;      // AND mask rows pad to 32 bits
  const maskStride = rowBits >> 3;
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);                  // biSize
  header.writeInt32LE(size, 4);                 // biWidth
  header.writeInt32LE(size * 2, 8);             // biHeight (colour + mask)
  header.writeUInt16LE(1, 12);                  // biPlanes
  header.writeUInt16LE(32, 14);                 // biBitCount
  header.writeUInt32LE(0, 16);                  // BI_RGB
  header.writeUInt32LE(size * size * 4 + maskStride * size, 20);

  const pixels = Buffer.alloc(size * size * 4);
  const mask = Buffer.alloc(maskStride * size);
  for (let y = 0; y < size; y++) {
    const srcRow = size - 1 - y;                // DIBs are bottom-up
    for (let x = 0; x < size; x++) {
      const s = (srcRow * size + x) * 4;
      const d = (y * size + x) * 4;
      pixels[d] = rgba[s + 2];                  // B
      pixels[d + 1] = rgba[s + 1];              // G
      pixels[d + 2] = rgba[s];                  // R
      pixels[d + 3] = rgba[s + 3];              // A
      if (rgba[s + 3] < 128) mask[y * maskStride + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return Buffer.concat([header, pixels, mask]);
}

function buildIco(images) {
  const count = images.length;
  const dir = Buffer.alloc(6 + count * 16);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2);                      // 1 = icon
  dir.writeUInt16LE(count, 4);

  let offset = dir.length;
  images.forEach((img, i) => {
    const e = 6 + i * 16;
    dir[e] = img.size >= 256 ? 0 : img.size;    // 0 means 256
    dir[e + 1] = img.size >= 256 ? 0 : img.size;
    dir[e + 2] = 0;                             // palette entries
    dir[e + 3] = 0;                             // reserved
    dir.writeUInt16LE(1, e + 4);                // planes
    dir.writeUInt16LE(32, e + 6);               // bit count
    dir.writeUInt32LE(img.data.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += img.data.length;
  });

  return Buffer.concat([dir, ...images.map((i) => i.data)]);
}

/* -------------------------------------------------------------------- main */

function main() {
  if (!fs.existsSync(SOURCE)) {
    throw new Error(`tracked vector logo is missing: ${SOURCE}`);
  }
  const tracked = fs.readFileSync(SOURCE, 'utf8').replace(/\r\n/g, '\n').trim();
  if (tracked !== logoSvg().trim()) {
    throw new Error('design/assets/app-logo.svg no longer matches the icon renderer; update both together.');
  }
  const src = rasterizeLogo(1024);
  console.log(`source ${path.relative(REPO, SOURCE)} — validated 64x64 vector, rendered ${src.width}x${src.height}`);

  const images = SIZES.map((size) => ({
    size,
    data: dibEntry(resample(src, size), size),
  }));

  const ico = buildIco(images);
  fs.writeFileSync(OUT, ico);
  console.log(`wrote ${path.relative(REPO, OUT)} — ${SIZES.join(', ')} px, ${ico.length} bytes`);
}

if (require.main === module) main();

module.exports = { decodePng, resample, buildIco, dibEntry, logoSvg, rasterizeLogo };
