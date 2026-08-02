// filebuffer.js — the transfer buffer, its EOL conversion state machine, and
// the version-info reader.
//
// Ported from WinSCP's core/FileBuffer.cpp (TFileBuffer, TEOLType, the
// cpRemoveBOM/cpRemoveCtrlZ scrubbers) and core/FileInfo.cpp (the Win32
// version-resource reader behind the About dialog and the update check).
//
// WHY this exists as its own module: WinSCP does text-mode conversion *inside*
// the transfer loop, one fixed-size block at a time, carrying a single boolean
// ("Token") across block boundaries. That boolean is the entire reason a CRLF
// split across two reads survives. Getting it wrong silently corrupts files, so
// it lives here, alone, with tests, rather than being re-derived per protocol.
'use strict';
const fs = require('fs');

// ---------------------------------------------------------------------------
// EOL types
// ---------------------------------------------------------------------------

/** WinSCP's TEOLType, in its declaration order — the ordinal is persisted. */
const EOL_LF = 0;
const EOL_CRLF = 1;
const EOL_CR = 2;

/** WinSCP's EOLTypeNames, used by the Preferences combo. */
const EOL_TYPE_NAMES = 'LF;CRLF;CR';

/** Names this application uses in config; the ordinal is WinSCP's. */
const EOL_NAMES = ['lf', 'crlf', 'cr'];

const EOL_STRINGS = ['\n', '\r\n', '\r'];

/** cpRemoveCtrlZ / cpRemoveBOM from FileBuffer.h. */
const CP_REMOVE_CTRL_Z = 0x01;
const CP_REMOVE_BOM = 0x02;

const BOM = Buffer.from([0xEF, 0xBB, 0xBF]);
const CTRL_Z = 0x1A;

/**
 * EOLToStr. Accepts the ordinal, our config name, or a literal EOL string, so
 * callers do not have to normalize before calling.
 *
 * WinSCP's EOLToStr calls DebugFail() on an unknown type and returns "" — an
 * empty EOL would mean "convert nothing", which quietly disables text mode. We
 * throw instead: a bad EOL setting must not silently become a binary transfer.
 */
function eolToStr(eol) {
  if (typeof eol === 'number') {
    if (eol >= 0 && eol < EOL_STRINGS.length) return EOL_STRINGS[eol];
    throw new Error(`Unknown EOL type: ${eol}`);
  }
  if (typeof eol === 'string') {
    const idx = EOL_NAMES.indexOf(eol.toLowerCase());
    if (idx >= 0) return EOL_STRINGS[idx];
    if (eol === '\n' || eol === '\r\n' || eol === '\r') return eol;
  }
  throw new Error(`Unknown EOL type: ${String(eol)}`);
}

/** The inverse: an EOL string back to its TEOLType ordinal, or -1. */
function eolTypeFromStr(str) {
  return EOL_STRINGS.indexOf(str);
}

// ---------------------------------------------------------------------------
// TFileBuffer
// ---------------------------------------------------------------------------

/**
 * A growable byte buffer with WinSCP's exact Insert/Delete/Size semantics and
 * its EOL Convert state machine.
 *
 * TFileBuffer sits on a TMemoryStream, so it has both a *size* (the valid
 * bytes) and a *position* (how far the transfer loop has read/written). Both
 * are reproduced: `reset()`, `position` and `needSpace()` are what the SFTP and
 * SCP loops drive, and dropping them would make this a different object that
 * merely looks similar.
 */
class FileBuffer {
  constructor(initial) {
    if (Buffer.isBuffer(initial)) {
      this._buf = Buffer.from(initial);
      this._size = initial.length;
    } else if (typeof initial === 'string') {
      const b = Buffer.from(initial, 'binary');
      this._buf = b;
      this._size = b.length;
    } else {
      this._buf = Buffer.alloc(typeof initial === 'number' ? initial : 0);
      this._size = typeof initial === 'number' ? initial : 0;
    }
    this._position = 0;
  }

  get size() { return this._size; }

  /** SetSize: growing keeps existing bytes; shrinking just forgets the tail. */
  set size(value) {
    if (value === this._size) return;
    if (value > this._buf.length) this._reserve(value);
    // Zero the newly exposed region. TMemoryStream does not promise this, but
    // leaving stale bytes visible is how a previous transfer's data ends up in
    // the next file — a real risk here that C++ avoided only by luck.
    if (value > this._size) this._buf.fill(0, this._size, value);
    this._size = value;
    if (this._position > value) this._position = value;
  }

  _reserve(capacity) {
    if (capacity <= this._buf.length) return;
    const next = Buffer.alloc(Math.max(capacity, this._buf.length * 2, 64));
    this._buf.copy(next, 0, 0, this._size);
    this._buf = next;
  }

  /** The valid bytes. A view, not a copy — mutating it mutates the buffer. */
  get data() { return this._buf.subarray(0, this._size); }

  /** A detached copy, for callers that keep the bytes past the next convert. */
  toBuffer() { return Buffer.from(this._buf.subarray(0, this._size)); }

  get position() { return this._position; }
  set position(value) { this._position = Math.max(0, Math.min(value, this._size)); }

  /** TFileBuffer::Reset — rewinds the read/write cursor, keeps the bytes. */
  reset() { this._position = 0; }

  /** NeedSpace: make room for Len more bytes at the current position. */
  needSpace(len) { this.size = this._position + len; }

  /**
   * ProcessRead: a short read shrinks the buffer by the shortfall, then the
   * cursor advances by what was actually read.
   */
  processRead(len, result) {
    if (result !== len) this.size = this._size - len + result;
    this._position += result;
  }

  /**
   * ReadStream, for an already-materialized chunk. Node gives us a Buffer
   * rather than a blocking stream handle, so the "read into my memory" shape of
   * the C++ becomes "copy this chunk in at the cursor" — same effect, same
   * short-read accounting.
   */
  readChunk(chunk, len) {
    const want = len === undefined ? chunk.length : len;
    this.needSpace(want);
    const got = Math.min(want, chunk.length);
    chunk.copy(this._buf, this._position, 0, got);
    this.processRead(want, got);
    return got;
  }

  /** LoadStream: rewind, then read. */
  loadChunk(chunk, len) {
    this._position = 0;
    return this.readChunk(chunk, len);
  }

  /**
   * WriteToStream / WriteToOut. The C++ hands `Len` bytes starting at the
   * current position to a stream or a transfer-out callback and then advances
   * the position by exactly `Len` — the write side of the same cursor
   * readChunk() drives, and the reason a download loop can fill, convert and
   * drain one buffer without ever reallocating.
   *
   * Node has no blocking TStream, so the bytes are returned instead of pushed;
   * the cursor arithmetic, which is the part callers get wrong, is identical.
   * A request that runs past the valid bytes is refused rather than quietly
   * short-writing: the C++ WriteBuffer raises EWriteError there and WinSCP
   * turns that into a failed transfer, and a silent short write would truncate
   * the user's file with no error at all.
   */
  writeChunk(len) {
    const n = len === undefined ? this._size - this._position : len;
    if (n < 0 || this._position + n > this._size) {
      throw new Error('Attempt to write past the end of the file buffer');
    }
    const out = Buffer.from(this._buf.subarray(this._position, this._position + n));
    this._position += n;
    return out;
  }

  /** Insert: shift right from Index and copy Len bytes in. */
  insert(index, buf, len) {
    const src = Buffer.isBuffer(buf) ? buf : Buffer.from(buf, 'binary');
    const n = len === undefined ? src.length : len;
    if (n <= 0) return;
    const oldSize = this._size;
    this.size = oldSize + n;
    this._buf.copy(this._buf, index + n, index, oldSize);
    src.copy(this._buf, index, 0, n);
  }

  /**
   * Delete: shift left over the hole and shrink. The C++ trusts its caller and
   * would happily produce a negative size; clamping here cannot change a
   * correct call and stops an incorrect one becoming a buffer that reports a
   * nonsense length to a protocol adapter.
   */
  delete(index, len) {
    const n = Math.min(Math.max(len, 0), Math.max(this._size - index, 0));
    if (n <= 0) return;
    this._buf.copy(this._buf, index, index + n, this._size);
    this._size -= n;
    if (this._position > this._size) this._position = this._size;
  }

  /**
   * TFileBuffer::Convert — the EOL state machine, ported byte for byte.
   *
   * `source` and `dest` are EOL types or literal 1-2 char EOL strings. `token`
   * is carried between calls: it records that the previous buffer ended on the
   * first character of a two-character destination EOL, which was already
   * expanded, so the matching second character at the head of *this* buffer has
   * to be dropped. Returns the new token; the caller must pass it back next
   * time or a CRLF straddling a block boundary is duplicated or lost.
   *
   * Deliberate faithfulness notes, because these look like bugs and are not
   * mistakes in the transcription:
   *
   *  - The BOM and Ctrl-Z scrubbers run on *every* buffer, not only the first
   *    and last, exactly as WinSCP runs them per transfer block. Callers that
   *    want the sane per-stream behaviour use EolConverter below, which is what
   *    the transfer path actually uses.
   *  - With a two-character source, a trailing first-character at the end of the
   *    buffer is deleted outright. That is how the CRLF-across-a-boundary case
   *    is handled (the LF at the head of the next buffer is already in the
   *    destination form), and it means a genuine lone CR at the very end of a
   *    CRLF->LF conversion is dropped. WinSCP loses that byte too.
   */
  convert(source, dest, params, token) {
    const src = Buffer.from(eolToStr(source), 'binary');
    const dst = Buffer.from(eolToStr(dest), 'binary');

    if ((params & CP_REMOVE_BOM) && this._size >= 3 &&
        this._buf[0] === BOM[0] && this._buf[1] === BOM[1] && this._buf[2] === BOM[2]) {
      this.delete(0, 3);
    }

    if ((params & CP_REMOVE_CTRL_Z) && this._size > 0 && this._buf[this._size - 1] === CTRL_Z) {
      this.delete(this._size - 1, 1);
    }

    // Nothing to do — and, faithfully, the token is left exactly as it came in.
    if (src.equals(dst)) return token;

    const src0 = src[0];
    // C++ indexes past the end of a 1-char literal and reads its NUL
    // terminator; the comparisons below depend on that zero, so spell it out.
    const dst0 = dst[0];
    const dst1 = dst.length > 1 ? dst[1] : 0;
    const dstHasSecond = dst.length > 1;

    let ptr = 0;

    if (src.length === 1) {
      const prevToken = token;
      token = false;

      for (let index = 0; index < this._size; index++) {
        if ((index < this._size - 1) && (this._buf[ptr] === dst0) && (this._buf[ptr + 1] === dst1)) {
          // Already in destination form: pass both bytes through untouched.
          index++;
          ptr++;
        } else if ((index === 0) && prevToken && (this._buf[ptr] === dst1)) {
          // The previous buffer ended on dst0 and we expanded it to the full
          // destination EOL. This is the orphaned second half; drop it.
          this.delete(index, 1);
          index--;
          ptr = index;
        } else if ((this._buf[ptr] === dst0) && (index === this._size - 1) && dstHasSecond) {
          // Ends on the first half of a two-character destination EOL: finish
          // it now and remember to strip the partner from the next buffer.
          token = true;
          this.insert(index + 1, dst.subarray(1, 2), 1);
          index++;
          ptr = index;
        } else if (this._buf[ptr] === src0) {
          this._buf[ptr] = dst0;
          if (dstHasSecond) {
            this.insert(index + 1, dst.subarray(1, 2), 1);
            index++;
            ptr = index;
          }
        }
        ptr++;
      }
    } else {
      const src1 = src[1];
      let index;
      for (index = 0; index < this._size - 1; index++) {
        if ((this._buf[ptr] === src0) && (this._buf[ptr + 1] === src1)) {
          this._buf[ptr] = dst0;
          if (dstHasSecond) {
            this._buf[ptr + 1] = dst1;
            index++;
            ptr++;
          } else {
            this.delete(index + 1, 1);
            ptr = index;
          }
        }
        ptr++;
      }
      // See the note above: a dangling first character is removed, on the
      // assumption that its partner opens the next buffer.
      if ((index < this._size) && (this._buf[ptr] === src0)) {
        this.delete(index, 1);
      }
    }

    return token;
  }
}

// ---------------------------------------------------------------------------
// The streaming converter the transfer path uses
// ---------------------------------------------------------------------------

/**
 * Chunk-oriented EOL conversion. This is the single implementation the queue,
 * the editors and every protocol adapter share; nothing else should own a
 * private copy of this logic.
 *
 * Two source modes:
 *
 *  - An explicit source EOL ('lf' | 'crlf' | 'cr'), which is WinSCP's model:
 *    the local EOL type on upload, the session EOL type on download. Bytes go
 *    through FileBuffer.convert with the token carried across chunks, so this
 *    is byte-identical to WinSCP.
 *  - 'auto' (the default), which treats any CRLF *and* any lone LF as a line
 *    break and leaves a lone CR alone. This is what a modern transfer wants
 *    when the peer's real EOL is unknown, and it is what the existing queue
 *    does; keeping it here means the queue can drop its private converter and
 *    require this one without any behaviour change.
 *
 * Divergence from the C++, stated plainly: WinSCP applies the BOM and Ctrl-Z
 * scrubbers to every transfer block, so a block that happens to begin with a
 * BOM or end with 0x1A is silently truncated mid-file. We apply the BOM check
 * only to the first chunk and the Ctrl-Z check only at the true end of the
 * stream. That is the documented intent of both options ("strip the byte-order
 * mark", "strip the DOS end-of-file marker"); reproducing the block artefact
 * would corrupt user data for no behavioural benefit.
 */
class EolConverter {
  constructor({ source = 'auto', dest = 'lf', removeBOM = false, removeCtrlZ = false } = {}) {
    this.source = source === 'auto' ? 'auto' : source;
    this.destStr = eolToStr(dest);
    this.removeBOM = removeBOM;
    this.removeCtrlZ = removeCtrlZ;

    this.first = true;
    this.token = false;      // WinSCP's ConvertToken, for the explicit-source path
    this.pendingCR = false;  // a trailing CR whose partner may open the next chunk
    this.pendingZ = false;   // a trailing Ctrl-Z that may be the last byte of all
    this.sourceStr = this.source === 'auto' ? null : eolToStr(this.source);
  }

  /** Feed one chunk; returns the converted bytes (possibly empty). */
  convert(chunk) {
    let buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'binary');

    // Re-attach anything held back from the previous chunk before deciding
    // anything about this one. Order matters and is the reverse of the order
    // they were taken off: the CR was the last byte of that chunk and the
    // Ctrl-Z the one before it, so it goes back as [Ctrl-Z][CR]. Prepending
    // them the other way round silently transposes two bytes of the user's
    // file whenever a 0x1A immediately precedes a CR at a chunk boundary.
    const held = [];
    if (this.pendingZ) { held.push(CTRL_Z); this.pendingZ = false; }
    if (this.pendingCR) { held.push(0x0D); this.pendingCR = false; }
    if (held.length) buf = Buffer.concat([Buffer.from(held), buf]);

    if (this.first) {
      this.first = false;
      if (this.removeBOM && buf.length >= 3 && buf.subarray(0, 3).equals(BOM)) buf = buf.subarray(3);
    }

    if (this.sourceStr === null) {
      // Hold a trailing CR: we cannot yet tell a lone CR from the first half of
      // a CRLF that straddles the boundary.
      if (buf.length && buf[buf.length - 1] === 0x0D) {
        this.pendingCR = true;
        buf = buf.subarray(0, buf.length - 1);
      }
    }
    if (this.removeCtrlZ && buf.length && buf[buf.length - 1] === CTRL_Z) {
      this.pendingZ = true;
      buf = buf.subarray(0, buf.length - 1);
    }

    return this._translate(buf, false);
  }

  /** Call once at end of stream to release anything still held back. */
  flush() {
    const tail = [];
    // A held Ctrl-Z is only the DOS end-of-file marker when nothing follows it.
    // If a CR was also held back then the CR is the file's last byte and the
    // Ctrl-Z is ordinary data one place earlier, so it has to be written out.
    if (this.pendingZ && this.pendingCR) tail.push(CTRL_Z);
    if (this.pendingCR) tail.push(0x0D);
    this.pendingCR = false;
    this.pendingZ = false;
    return this._translate(Buffer.from(tail), true);
  }

  _translate(buf, last) {
    if (this.sourceStr !== null) {
      // WinSCP's own path, token carried across chunks.
      if (!buf.length && !last) return buf;
      const fb = new FileBuffer(buf);
      this.token = fb.convert(this.sourceStr, this.destStr, 0, this.token);
      return fb.toBuffer();
    }

    if (!buf.length) return buf;
    // Source-agnostic normalization: drop the CR of every CRLF, then expand
    // every remaining LF if the destination wants CRLF. A lone CR is data.
    const crlf = this.destStr === '\r\n';
    const cr = this.destStr === '\r';
    const out = Buffer.allocUnsafe(buf.length * 2);
    let n = 0;
    for (let i = 0; i < buf.length; i++) {
      const b = buf[i];
      if (b === 0x0D && buf[i + 1] === 0x0A) continue;
      if (b === 0x0A) {
        if (crlf) { out[n++] = 0x0D; out[n++] = 0x0A; continue; }
        if (cr) { out[n++] = 0x0D; continue; }
      }
      out[n++] = b;
    }
    return out.subarray(0, n);
  }
}

/**
 * The queue's converter signature, kept so `design/main/queue.js` can delete
 * its private copy and `require('./filebuffer')` instead — same constructor,
 * same convert()/flush(), same bytes out.
 */
class TextConverter extends EolConverter {
  constructor(targetEol, { removeBOM = false, removeCtrlZ = false } = {}) {
    super({ source: 'auto', dest: targetEol === 'crlf' ? 'crlf' : 'lf', removeBOM, removeCtrlZ });
  }
}

// ---------------------------------------------------------------------------
// FileInfo.cpp — version numbers
// ---------------------------------------------------------------------------

/** CalculateCompoundVersion: 1.2.3 -> 1020300 * 10000-scaled build slot. */
function calculateCompoundVersion(majorVer, minorVer, release) {
  return 10000 * (release + 100 * (minorVer + 100 * majorVer));
}

/** ZeroBuildNumber: strip the build slot, keeping major.minor.release. */
function zeroBuildNumber(compoundVersion) {
  return Math.trunc(compoundVersion / 10000) * 10000;
}

/**
 * StrToCompoundVersion. Each component is clamped to 99 — WinSCP's compound
 * form has exactly two decimal digits per component, so 1.100.0 and 1.99.0 are
 * genuinely the same number to it. The release component is optional.
 *
 * StrToInt raises on a non-numeric component and so do we: a malformed version
 * must not silently compare as 0.0.0, which would read as "older than
 * everything" and could trigger a spurious update.
 */
function strToCompoundVersion(s) {
  let rest = String(s);
  const cut = () => {
    const p = rest.indexOf('.');
    if (p < 0) { const r = rest; rest = ''; return r; }
    const r = rest.slice(0, p);
    rest = rest.slice(p + 1);
    return r;
  };
  const toInt = (part) => {
    if (!/^[+-]?\d+$/.test(part.trim())) throw new Error(`'${part}' is not a valid integer value`);
    return parseInt(part.trim(), 10);
  };
  const majorVer = Math.min(toInt(cut()), 99);
  const minorVer = Math.min(toInt(cut()), 99);
  const release = rest === '' ? 0 : Math.min(toInt(cut()), 99);
  return calculateCompoundVersion(majorVer, minorVer, release);
}

/**
 * CompareVersion: component-wise, missing components read as 0, so "1.0" and
 * "1" and "1.0.0" all compare equal. Returns -1, 0 or 1.
 */
function compareVersion(v1, v2) {
  let a = String(v1);
  let b = String(v2);
  const cut = (s) => {
    const p = s.indexOf('.');
    if (p < 0) return [s, ''];
    return [s.slice(0, p), s.slice(p + 1)];
  };
  const toIntDef = (part) => (/^[+-]?\d+$/.test(part.trim()) ? parseInt(part.trim(), 10) : 0);
  let result = 0;
  while (result === 0 && (a !== '' || b !== '')) {
    let p1; let p2;
    [p1, a] = cut(a);
    [p2, b] = cut(b);
    const c1 = toIntDef(p1);
    const c2 = toIntDef(p2);
    result = c1 < c2 ? -1 : (c1 > c2 ? 1 : 0);
  }
  return result;
}

// ---------------------------------------------------------------------------
// FileInfo.cpp — the Win32 version resource
// ---------------------------------------------------------------------------
//
// CreateFileInfo/GetFixedFileInfo/GetTranslation/GetFileInfoString are thin
// wrappers over GetFileVersionInfo and VerQueryValue. Neither API exists here,
// so the block is parsed directly: the VS_VERSIONINFO layout is a documented,
// stable on-disk structure and reading it ourselves is the port, not a
// substitute for it. This is what the About dialog and the update check need.

const VS_FFI_SIGNATURE = 0xFEEF04BD;

function alignDword(n) { return (n + 3) & ~3; }

/**
 * One node of a VS_VERSIONINFO tree: { key, type, value, children }.
 * `type` 1 means the value is text (UTF-16LE), 0 means binary.
 */
function parseVersionNode(buf, offset) {
  if (offset + 6 > buf.length) return null;
  const length = buf.readUInt16LE(offset);
  const valueLength = buf.readUInt16LE(offset + 2);
  const type = buf.readUInt16LE(offset + 4);
  if (length < 6 || offset + length > buf.length) return null;

  let p = offset + 6;
  let keyEnd = p;
  while (keyEnd + 1 < offset + length && buf.readUInt16LE(keyEnd) !== 0) keyEnd += 2;
  const key = buf.toString('utf16le', p, keyEnd);
  p = alignDword(keyEnd + 2 - offset) + offset;

  // A text value's wValueLength counts UTF-16 characters, a binary value's
  // counts bytes. Getting this wrong is the classic way to mis-parse the block.
  const valueBytes = type === 1 ? valueLength * 2 : valueLength;
  const valueStart = p;
  const valueEnd = Math.min(valueStart + valueBytes, offset + length);
  const value = buf.subarray(valueStart, valueEnd);
  p = alignDword(valueEnd - offset) + offset;

  const children = [];
  while (p + 6 <= offset + length) {
    const child = parseVersionNode(buf, p);
    if (!child || child.length === 0) break;
    children.push(child);
    p = alignDword(p + child.length - offset) + offset;
  }

  return { key, type, value, children, length, offset };
}

/**
 * Parse a raw version-info block (what GetFileVersionInfo hands back) into
 * something the callers of VerQueryValue would recognise.
 *
 * Returns null when the block is not a VS_VERSIONINFO, mirroring
 * CreateFileInfo returning NULL rather than raising.
 */
function parseVersionInfo(block) {
  if (!Buffer.isBuffer(block) || block.length < 6) return null;
  const root = parseVersionNode(block, 0);
  if (!root || root.key !== 'VS_VERSION_INFO') return null;

  // `hasTranslations` records whether a \VarFileInfo\Translation node exists at
  // all, which is a different question from how many entries it holds:
  // VerQueryValue *fails* when the node is absent and GetTranslationCount turns
  // that failure into an exception, so a resource with no translation block
  // must not be reported as "zero translations, nothing wrong".
  const info = { root, fixed: null, translations: [], strings: new Map(), hasTranslations: false };

  if (root.value.length >= 52 && root.value.readUInt32LE(0) === VS_FFI_SIGNATURE) {
    const v = root.value;
    info.fixed = {
      signature: v.readUInt32LE(0),
      strucVersion: v.readUInt32LE(4),
      fileVersionMS: v.readUInt32LE(8),
      fileVersionLS: v.readUInt32LE(12),
      productVersionMS: v.readUInt32LE(16),
      productVersionLS: v.readUInt32LE(20),
      fileFlagsMask: v.readUInt32LE(24),
      fileFlags: v.readUInt32LE(28),
      fileOS: v.readUInt32LE(32),
      fileType: v.readUInt32LE(36),
      fileSubtype: v.readUInt32LE(40),
      fileDateMS: v.readUInt32LE(44),
      fileDateLS: v.readUInt32LE(48),
    };
    info.fixed.fileVersion = [
      info.fixed.fileVersionMS >>> 16, info.fixed.fileVersionMS & 0xFFFF,
      info.fixed.fileVersionLS >>> 16, info.fixed.fileVersionLS & 0xFFFF,
    ];
    info.fixed.productVersion = [
      info.fixed.productVersionMS >>> 16, info.fixed.productVersionMS & 0xFFFF,
      info.fixed.productVersionLS >>> 16, info.fixed.productVersionLS & 0xFFFF,
    ];
  }

  for (const child of root.children) {
    if (child.key === 'VarFileInfo') {
      for (const varNode of child.children) {
        if (varNode.key !== 'Translation') continue;
        info.hasTranslations = true;
        for (let i = 0; i + 4 <= varNode.value.length; i += 4) {
          info.translations.push({
            language: varNode.value.readUInt16LE(i),
            charSet: varNode.value.readUInt16LE(i + 2),
          });
        }
      }
    } else if (child.key === 'StringFileInfo') {
      for (const table of child.children) {
        const entries = new Map();
        for (const str of table.children) {
          // PackStr: the stored value is NUL-terminated and padded; keep only
          // what precedes the first NUL.
          let text = str.value.toString('utf16le');
          const nul = text.indexOf('\u0000');
          if (nul >= 0) text = text.slice(0, nul);
          entries.set(str.key, text);
        }
        info.strings.set(table.key.toUpperCase(), entries);
      }
    }
  }

  return info;
}

/**
 * GetTranslationCount. Throws when the block carries no translation node,
 * because that is the VerQueryValue failure the C++ converts into an
 * exception — returning 0 instead would let the About dialog silently show a
 * binary with no version strings as if it simply had none to show.
 */
function getTranslationCount(info) {
  if (!info || !info.hasTranslations) throw new Error('File info translations not available');
  return info.translations.length;
}

/** GetTranslation: the i-th translation, or a throw — as in the C++. */
function getTranslation(info, i) {
  if (!info || !info.hasTranslations) throw new Error('File info translations not available');
  if (i < 0 || i >= info.translations.length) throw new Error('Specified translation not available');
  return info.translations[i];
}

function hex4(n) { return (n & 0xFFFF).toString(16).toUpperCase().padStart(4, '0'); }

/**
 * GetFileInfoString. The sub-block name is the language and charset as two
 * four-digit hex numbers, exactly as IntToHex(...,4) builds it.
 *
 * With AllowEmpty the C++ returns "" for a missing string; without it, it
 * throws. Both are preserved: the About dialog relies on the throw to notice a
 * binary built without the string it expects.
 */
function getFileInfoString(info, translation, stringName, allowEmpty = false) {
  const key = hex4(translation.language) + hex4(translation.charSet);
  const table = info && info.strings.get(key);
  const value = table && table.get(stringName);
  if (value === undefined) {
    if (!allowEmpty) throw new Error('Specified file info string not available');
    return '';
  }
  return value;
}

/** GetFixedFileInfo. */
function getFixedFileInfo(info) {
  if (!info || !info.fixed) throw new Error('Fixed file info not available');
  return info.fixed;
}

// --- extracting the block out of a PE image ---------------------------------

function rvaToOffset(sections, rva) {
  for (const s of sections) {
    if (rva >= s.virtualAddress && rva < s.virtualAddress + Math.max(s.virtualSize, s.sizeOfRawData)) {
      return s.pointerToRawData + (rva - s.virtualAddress);
    }
  }
  return -1;
}

function readResourceDirectory(buf, base, offset) {
  if (base + offset + 16 > buf.length) return null;
  const namedCount = buf.readUInt16LE(base + offset + 12);
  const idCount = buf.readUInt16LE(base + offset + 14);
  const entries = [];
  let p = base + offset + 16;
  for (let i = 0; i < namedCount + idCount; i++, p += 8) {
    if (p + 8 > buf.length) break;
    const name = buf.readUInt32LE(p);
    const data = buf.readUInt32LE(p + 4);
    entries.push({
      id: (name & 0x80000000) ? null : name,
      isDirectory: (data & 0x80000000) !== 0,
      offset: data & 0x7FFFFFFF,
    });
  }
  return entries;
}

/**
 * CreateFileInfo: read a PE image's RT_VERSION resource and return the parsed
 * block, or null when the file has none (CreateFileInfo returns NULL for a
 * zero-sized version block, and callers already handle that).
 *
 * A file that cannot be read is null too, not an exception:
 * GetFileVersionInfoSize returns 0 for a missing or unopenable file and
 * CreateFileInfo turns that into NULL, so every caller is already written for
 * "no version info" and none of them is written for a throw.
 */
function readVersionInfo(fileName) {
  let buf;
  try {
    buf = fs.readFileSync(fileName);
  } catch {
    return null;
  }
  return readVersionInfoFromImage(buf);
}

/** The same, for an image already in memory. */
function readVersionInfoFromImage(buf) {
  if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5A4D) return null; // 'MZ'
  const peOffset = buf.readUInt32LE(0x3C);
  if (peOffset + 24 > buf.length || buf.readUInt32LE(peOffset) !== 0x00004550) return null; // 'PE\0\0'

  const coff = peOffset + 4;
  const numberOfSections = buf.readUInt16LE(coff + 2);
  const sizeOfOptionalHeader = buf.readUInt16LE(coff + 16);
  const optional = coff + 20;
  if (optional + 2 > buf.length) return null;
  const magic = buf.readUInt16LE(optional);
  // PE32 puts the data directories at +96, PE32+ at +112 (eight extra bytes of
  // 64-bit fields, minus the BaseOfData that PE32+ drops).
  const dirOffset = magic === 0x20B ? optional + 112 : optional + 96;
  const resourceDirIndex = 2;
  const dirEntry = dirOffset + resourceDirIndex * 8;
  if (dirEntry + 8 > buf.length) return null;
  const resourceRva = buf.readUInt32LE(dirEntry);
  const resourceSize = buf.readUInt32LE(dirEntry + 4);
  if (!resourceRva || !resourceSize) return null;

  const sections = [];
  let sp = optional + sizeOfOptionalHeader;
  for (let i = 0; i < numberOfSections; i++, sp += 40) {
    if (sp + 40 > buf.length) break;
    sections.push({
      virtualSize: buf.readUInt32LE(sp + 8),
      virtualAddress: buf.readUInt32LE(sp + 12),
      sizeOfRawData: buf.readUInt32LE(sp + 16),
      pointerToRawData: buf.readUInt32LE(sp + 20),
    });
  }

  const base = rvaToOffset(sections, resourceRva);
  if (base < 0) return null;

  const types = readResourceDirectory(buf, base, 0);
  if (!types) return null;
  const versionType = types.find((e) => e.id === 16); // RT_VERSION
  if (!versionType || !versionType.isDirectory) return null;

  const names = readResourceDirectory(buf, base, versionType.offset);
  if (!names || !names.length || !names[0].isDirectory) return null;

  const langs = readResourceDirectory(buf, base, names[0].offset);
  if (!langs || !langs.length || langs[0].isDirectory) return null;

  const dataEntry = base + langs[0].offset;
  if (dataEntry + 16 > buf.length) return null;
  const dataRva = buf.readUInt32LE(dataEntry);
  const dataSize = buf.readUInt32LE(dataEntry + 4);
  const dataOffset = rvaToOffset(sections, dataRva);
  if (dataOffset < 0 || dataOffset + dataSize > buf.length) return null;

  return parseVersionInfo(buf.subarray(dataOffset, dataOffset + dataSize));
}

module.exports = {
  // EOL
  EOL_LF, EOL_CRLF, EOL_CR, EOL_NAMES, EOL_STRINGS, EOL_TYPE_NAMES,
  CP_REMOVE_CTRL_Z, CP_REMOVE_BOM, BOM, CTRL_Z,
  eolToStr, eolTypeFromStr,
  // buffers
  FileBuffer, EolConverter, TextConverter,
  // versions
  calculateCompoundVersion, zeroBuildNumber, strToCompoundVersion, compareVersion,
  parseVersionInfo, parseVersionNode, getFixedFileInfo, getTranslation,
  getTranslationCount, getFileInfoString, readVersionInfo, readVersionInfoFromImage,
};
