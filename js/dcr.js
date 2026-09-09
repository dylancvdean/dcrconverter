/** Liberty / High Criteria DCR reader. */

const MAGIC = "HGCRLCRS";
const CADR_BGN = asciiBytes("cadr#bgn");
const AUDI_MRK = asciiBytes("audi#mrk");
const DATA_END = asciiBytes("data#end");
const SMALL_SECTION_LIMIT = 2 * 1024 * 1024;
const MATERIALIZE_CAP = 512 * 1024 * 1024;

function asciiBytes(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function startsWith(buf, seq, off = 0) {
  if (off + seq.length > buf.length) return false;
  for (let i = 0; i < seq.length; i++) {
    if (buf[off + i] !== seq[i]) return false;
  }
  return true;
}

function indexOfSeq(buf, seq, start = 0) {
  outer: for (let i = start; i + seq.length <= buf.length; i++) {
    for (let j = 0; j < seq.length; j++) {
      if (buf[i + j] !== seq[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function concatBytes(chunks) {
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

function u16(view, off) {
  return view.getUint16(off, true);
}

function u32(view, off) {
  return view.getUint32(off, true);
}

function u64(view, off) {
  const lo = view.getUint32(off, true);
  const hi = view.getUint32(off + 4, true);
  if (hi > 0xfffff) throw new Error("file offset too large for this browser");
  return hi * 0x100000000 + lo;
}

async function readSlice(blob, start, length) {
  const end = Math.min(blob.size, start + length);
  if (end <= start) return new Uint8Array(0);
  const buf = await blob.slice(start, end).arrayBuffer();
  return new Uint8Array(buf);
}

function hasMagic(bytes) {
  return bytes && bytes.length >= 8 && String.fromCharCode(...bytes.subarray(0, 8)) === MAGIC;
}

function emptyFileError(file) {
  const reported = typeof file.size === "number" ? file.size : 0;
  return new Error(
    `Could not read “${file.name || "this file"}” (browser reported ${reported} bytes). ` +
      "If it is in iCloud, OneDrive, or Google Drive, wait for it to finish downloading to this device, then choose it again."
  );
}

/**
 * Read the first n bytes even when File.size is 0 (Safari / cloud stubs).
 * Stream first so a large recording is not forced into RAM.
 */
async function readPrefix(file, n) {
  if (file.size >= n) {
    const sliced = await readSlice(file, 0, n);
    if (sliced.length >= n) return { bytes: sliced, via: "slice" };
  }
  if (typeof file.stream === "function") {
    const reader = file.stream().getReader();
    const chunks = [];
    let got = 0;
    try {
      while (got < n) {
        const { done, value } = await reader.read();
        if (done) break;
        const piece = value instanceof Uint8Array ? value : new Uint8Array(value);
        chunks.push(piece);
        got += piece.byteLength;
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
    }
    if (got >= n) return { bytes: concatBytes(chunks).subarray(0, n), via: "stream" };
  }
  const whole = await readWholeCapped(file);
  if (whole && whole.length >= n) {
    return { bytes: whole.subarray(0, n), via: "buffer", whole };
  }
  return { bytes: new Uint8Array(0), via: "empty" };
}

function readWholeCapped(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onprogress = (ev) => {
      if (ev.loaded > MATERIALIZE_CAP) {
        r.abort();
        reject(
          new Error(
            "This file is too large to load without a real size from the OS. Copy it fully onto the device and try again."
          )
        );
      }
    };
    r.onload = () => resolve(new Uint8Array(r.result));
    r.onerror = () => reject(r.error || new Error("could not read file"));
    r.onabort = () =>
      reject(new Error("stopped reading a huge file with no reported size"));
    try {
      r.readAsArrayBuffer(file);
    } catch (err) {
      reject(err);
    }
  });
}

function fileFromBytes(bytes, original) {
  const copy = bytes.slice();
  try {
    return new File([copy], original.name || "recording.dcr", {
      type: original.type || "application/octet-stream",
      lastModified: original.lastModified || Date.now(),
    });
  } catch {
    const blob = new Blob([copy], { type: original.type || "application/octet-stream" });
    blob.name = original.name || "recording.dcr";
    return blob;
  }
}

export async function peekDcr(file) {
  const prefix = await readPrefix(file, 16);
  if (prefix.via === "buffer" && prefix.whole) {
    file = fileFromBytes(prefix.whole, file);
  }
  if (!hasMagic(prefix.bytes)) {
    if (prefix.via === "empty" || prefix.bytes.length < 8) throw emptyFileError(file);
    throw new Error("not a Liberty DCR file (missing HGCRLCRS header)");
  }

  let info = null;
  if (file.size >= 36 && prefix.via === "slice") {
    try {
      info = await peekFromTrailer(file);
    } catch {
      info = null;
    }
  }
  if (!info) info = await peekByScan(file);

  info.file = file;
  info.fileName = file.name || info.fileName || "recording.dcr";
  if (!info.fileSize) info.fileSize = file.size;
  return info;
}

async function peekFromTrailer(file) {
  const head = await readSlice(file, 0, 16);
  const hv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const version = u32(hv, 8);
  const flags = u32(hv, 12);

  const tail = await readSlice(file, Math.max(0, file.size - 20), 20);
  if (String.fromCharCode(...tail.subarray(0, 4)) !== "head") {
    throw new Error("no trailer");
  }
  const tv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  const trailerOff = u64(tv, 4);
  const trailerSize = u64(tv, 12);
  if (trailerOff + trailerSize !== file.size) throw new Error("trailer size mismatch");

  const trailer = await readSlice(file, trailerOff, trailerSize);
  const sections = [];
  let i = 0;
  while (i + 24 <= trailer.length - 20) {
    const name = String.fromCharCode(...trailer.subarray(i, i + 4));
    const dv = new DataView(trailer.buffer, trailer.byteOffset + i, 24);
    sections.push({
      name,
      index: u32(dv, 4),
      offset: u64(dv, 8),
      size: u64(dv, 16),
    });
    i += 24;
  }
  return finishPeek(file, version, flags, sections, false);
}

async function peekByScan(file) {
  const cur = await openCursor(file, 0, file.size > 0 ? file.size : Infinity);
  await cur.fill(16);
  if (cur.buffered() < 16) throw emptyFileError(file);
  const head = cur.consume(16);
  if (!hasMagic(head)) throw new Error("not a Liberty DCR file (missing HGCRLCRS header)");
  const hv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const version = u32(hv, 8);
  const flags = u32(hv, 12);
  const sections = [];

  while (!cur.eof) {
    await cur.fill(8);
    if (cur.buffered() < 8) break;
    const tag = String.fromCharCode(...cur.buf.subarray(0, 8));
    if (tag.slice(4) !== "#bgn" || !/^[A-Za-z]{4}$/.test(tag.slice(0, 4))) break;
    const name = tag.slice(0, 4);
    const start = cur.start;
    cur.consume(8);
    const endTag = asciiBytes(name + "#end");
    if (name === "data") {
      sections.push({ name, index: 0, offset: start, size: 0, unbounded: true });
      break;
    }
    const payload = await readUntilTag(cur, endTag, SMALL_SECTION_LIMIT);
    sections.push({
      name,
      index: 0,
      offset: start,
      size: 8 + payload.length + 8,
      payload,
    });
  }

  return finishPeek(file, version, flags, sections, true);
}

async function finishPeek(file, version, flags, sections, scanned) {
  const wfmtSec = sections.find((s) => s.name === "wfmt");
  const dataSec = sections.find((s) => s.name === "data");
  if (!wfmtSec || !dataSec) throw new Error("file is missing audio (wfmt/data) sections");

  const wfmtRaw = wfmtSec.payload
    ? tagged(wfmtSec.payload, "wfmt")
    : payloadOf(await readSlice(file, wfmtSec.offset, wfmtSec.size), "wfmt");
  const wfx = parseWfx(wfmtRaw);

  let metaText = "";
  const metaSec = sections.find((s) => s.name === "meta");
  if (metaSec) {
    const raw = metaSec.payload
      ? tagged(metaSec.payload, "meta")
      : payloadOf(await readSlice(file, metaSec.offset, metaSec.size), "meta");
    metaText = xmlPayload(raw);
  }

  let rinfText = "";
  const rinfSec = sections.find((s) => s.name === "rinf");
  if (rinfSec) {
    const raw = rinfSec.payload
      ? tagged(rinfSec.payload, "rinf")
      : payloadOf(await readSlice(file, rinfSec.offset, rinfSec.size), "rinf");
    rinfText = xmlPayload(raw);
  }

  const channelNames = parseChannelNames(rinfText);
  const nAudio = wfx.nChannels || 1;
  const channels = [];
  for (let c = 0; c < nAudio; c++) {
    channels.push({ index: c, name: channelNames[c] || `Channel ${c + 1}` });
  }

  return {
    version,
    flags,
    fileName: file.name || "recording.dcr",
    fileSize: file.size,
    sections,
    wfx,
    data: dataSec,
    scanned,
    appName: cdata(metaText, "NAMEAPP") || "Liberty",
    created: cdata(metaText, "TIMECR"),
    channels,
    videoCount: sections.filter((s) => s.name === "vdeo").length,
  };
}

function tagged(payload, name) {
  return payload;
}

function payloadOf(sectionBytes, name) {
  const begin = name + "#bgn";
  const end = name + "#end";
  const head = String.fromCharCode(...sectionBytes.subarray(0, 8));
  const tail = String.fromCharCode(
    ...sectionBytes.subarray(sectionBytes.length - 8)
  );
  if (head === begin && tail === end) {
    return sectionBytes.subarray(8, sectionBytes.length - 8);
  }
  return sectionBytes;
}

function parseWfx(payload) {
  const body =
    payload.length >= 22 &&
    payload[0] === 0 &&
    payload[1] === 0 &&
    payload[2] === 0 &&
    payload[3] === 0
      ? payload.subarray(4)
      : payload;
  const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const wFormatTag = u16(dv, 0);
  const nChannels = u16(dv, 2);
  const nSamplesPerSec = u32(dv, 4);
  const nAvgBytesPerSec = u32(dv, 8);
  const nBlockAlign = u16(dv, 12);
  const wBitsPerSample = u16(dv, 14);
  const cbSize = body.length >= 18 ? u16(dv, 16) : 0;
  if (wFormatTag !== 0xa109) {
    throw new Error(
      `unsupported audio codec 0x${wFormatTag.toString(16)} (expected Speex)`
    );
  }
  if (!nBlockAlign) throw new Error("invalid Speex block size");
  return {
    wFormatTag,
    nChannels,
    nSamplesPerSec,
    nAvgBytesPerSec,
    nBlockAlign,
    wBitsPerSample,
    cbSize,
  };
}

function xmlPayload(payload) {
  let bytes = payload;
  if (
    bytes.length >= 4 &&
    bytes[0] === 0 &&
    bytes[1] === 0 &&
    bytes[2] === 0 &&
    bytes[3] === 0
  ) {
    bytes = bytes.subarray(4);
  }
  const z = bytes.indexOf(0);
  if (z >= 0) bytes = bytes.subarray(0, z);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function cdata(xml, tag) {
  const re = new RegExp(`<${tag}>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>`, "i");
  const m = xml.match(re);
  return m ? m[1].trim() : "";
}

function parseChannelNames(xml) {
  if (!xml) return [];
  const names = [];
  const re = /<NAMEDV>\s*<!\[CDATA\[([\s\S]*?)\]\]>/gi;
  let m;
  while ((m = re.exec(xml))) names.push(m[1].trim());
  return names;
}

class BlobCursor {
  constructor(blob, start, end) {
    this.blob = blob;
    this.pos = start;
    this.end = end;
    this.buf = new Uint8Array(0);
  }

  get start() {
    return this.pos - this.buf.length;
  }

  get eof() {
    return this.buf.length === 0 && this.pos >= this.end;
  }

  get sourceDrained() {
    return this.pos >= this.end;
  }

  buffered() {
    return this.buf.length;
  }

  async fill(n) {
    while (this.buf.length < n && this.pos < this.end) {
      const take = Math.min(256 * 1024, this.end - this.pos, Math.max(n, 64 * 1024));
      const chunk = await readSlice(this.blob, this.pos, take);
      this.pos += chunk.length;
      if (!chunk.length) break;
      const next = new Uint8Array(this.buf.length + chunk.length);
      next.set(this.buf, 0);
      next.set(chunk, this.buf.length);
      this.buf = next;
    }
  }

  async skip(n) {
    if (n <= this.buf.length) {
      this.buf = this.buf.subarray(n);
      return;
    }
    n -= this.buf.length;
    this.buf = new Uint8Array(0);
    this.pos = Math.min(this.end, this.pos + n);
  }

  consume(n) {
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }
}

class StreamCursor {
  constructor(stream) {
    this.reader = stream.getReader();
    this.buf = new Uint8Array(0);
    this.consumed = 0;
    this.done = false;
    this.end = Infinity;
  }

  get start() {
    return this.consumed;
  }

  get pos() {
    return this.consumed + this.buf.length;
  }

  get eof() {
    return this.buf.length === 0 && this.done;
  }

  get sourceDrained() {
    return this.done;
  }

  buffered() {
    return this.buf.length;
  }

  async pull() {
    if (this.done) return;
    const { done, value } = await this.reader.read();
    if (done) {
      this.done = true;
      return;
    }
    const piece = value instanceof Uint8Array ? value : new Uint8Array(value);
    const next = new Uint8Array(this.buf.length + piece.length);
    next.set(this.buf, 0);
    next.set(piece, this.buf.length);
    this.buf = next;
  }

  async fill(n) {
    while (this.buf.length < n && !this.done) await this.pull();
  }

  async skip(n) {
    if (n <= this.buf.length) {
      this.buf = this.buf.subarray(n);
      this.consumed += n;
      return;
    }
    n -= this.buf.length;
    this.consumed += this.buf.length;
    this.buf = new Uint8Array(0);
    while (n > 0 && !this.done) {
      const { done, value } = await this.reader.read();
      if (done) {
        this.done = true;
        return;
      }
      const piece = value instanceof Uint8Array ? value : new Uint8Array(value);
      if (piece.length <= n) {
        n -= piece.length;
        this.consumed += piece.length;
      } else {
        this.buf = piece.subarray(n);
        this.consumed += n;
        n = 0;
      }
    }
  }

  consume(n) {
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    this.consumed += n;
    return out;
  }
}

async function openCursor(file, start, end) {
  const canSeek = file.size > 0 && end !== Infinity && file.size >= Math.min(end, start + 1);
  if (canSeek && start < file.size) {
    return new BlobCursor(file, start, end);
  }
  if (typeof file.stream !== "function") throw emptyFileError(file);
  const cur = new StreamCursor(file.stream());
  if (start) await cur.skip(start);
  return cur;
}

async function readUntilTag(cur, endTag, limit) {
  const chunks = [];
  let total = 0;
  while (!cur.eof) {
    await cur.fill(endTag.length);
    if (cur.buffered() < endTag.length) break;
    const hit = indexOfSeq(cur.buf, endTag);
    if (hit >= 0) {
      if (hit) {
        chunks.push(cur.consume(hit).slice());
        total += hit;
      }
      cur.consume(endTag.length);
      return concatBytes(chunks);
    }
    const keep = endTag.length - 1;
    const take = cur.buffered() - keep;
    if (take > 0) {
      chunks.push(cur.consume(take).slice());
      total += take;
      if (total > limit) throw new Error("DCR section is larger than expected");
    } else {
      await cur.fill(cur.buffered() + 64 * 1024);
      if (cur.eof) break;
    }
  }
  throw new Error("unclosed DCR section");
}

async function* iterateFromCursor(cur, blockAlign, stripAudiMarkers, unbounded) {
  await cur.fill(4);
  if (cur.buffered() >= 4) cur.consume(4);

  let pending = new Uint8Array(0);

  const emitFrom = (bytes) => {
    if (!pending.length) {
      pending = bytes.length ? bytes.slice() : pending;
    } else if (bytes.length) {
      const n = new Uint8Array(pending.length + bytes.length);
      n.set(pending, 0);
      n.set(bytes, pending.length);
      pending = n;
    }
    const frames = [];
    while (pending.length >= blockAlign) {
      frames.push(pending.subarray(0, blockAlign).slice());
      pending = pending.subarray(blockAlign);
    }
    return frames;
  };

  while (!cur.eof || cur.buffered() > 0) {
    await cur.fill(12);
    if (cur.buffered() === 0) break;

    if (unbounded && cur.buffered() >= 8 && startsWith(cur.buf, DATA_END)) break;

    if (cur.buffered() >= 8 && startsWith(cur.buf, CADR_BGN)) {
      await cur.fill(12);
      if (cur.buffered() < 12) break;
      const dv = new DataView(cur.buf.buffer, cur.buf.byteOffset, cur.buf.byteLength);
      const total = u32(dv, 8);
      if (total < 16) throw new Error("invalid video chunk in DCR data");
      await cur.skip(total);
      continue;
    }

    if (stripAudiMarkers && cur.buffered() >= 8 && startsWith(cur.buf, AUDI_MRK)) {
      await cur.skip(8);
      continue;
    }

    const cadrAt = indexOfSeq(cur.buf, CADR_BGN);
    const audiAt = stripAudiMarkers ? indexOfSeq(cur.buf, AUDI_MRK) : -1;
    const dataEndAt = unbounded ? indexOfSeq(cur.buf, DATA_END) : -1;
    let cut = cur.buf.length;
    if (cadrAt >= 0) cut = Math.min(cut, cadrAt);
    if (audiAt >= 0) cut = Math.min(cut, audiAt);
    if (dataEndAt >= 0) cut = Math.min(cut, dataEndAt);

    if (cut === cur.buf.length) {
      const keep = Math.min(7, cur.buf.length);
      const take = cur.buf.length - keep;
      if (take <= 0) {
        if (cur.eof || cur.sourceDrained) {
          const frames = emitFrom(cur.consume(cur.buffered()));
          for (const f of frames) yield f;
          break;
        }
        const before = cur.buffered();
        await cur.fill(cur.buffered() + 64 * 1024);
        if (cur.buffered() <= before) {
          const frames = emitFrom(cur.consume(cur.buffered()));
          for (const f of frames) yield f;
          break;
        }
        continue;
      }
      const frames = emitFrom(cur.consume(take));
      for (const f of frames) yield f;
      continue;
    }

    if (cut > 0) {
      const frames = emitFrom(cur.consume(cut));
      for (const f of frames) yield f;
    }
  }

  if (pending.length >= blockAlign) {
    const frames = emitFrom(new Uint8Array(0));
    for (const f of frames) yield f;
  }
}

/**
 * Yield packed Speex frames. Video `cadr` chunks are skipped without keeping
 * their bodies. If File.size is missing, the file is read as a stream so the
 * OS can hydrate iCloud/OneDrive/iOS placeholders.
 */
export async function* iterateSpeexFrames(file, dataSection, blockAlign, options = {}) {
  const stripAudiMarkers = Boolean(options.stripAudiMarkers);
  const unbounded = Boolean(dataSection.unbounded);
  const payloadStart = dataSection.offset + 8;
  const payloadEnd = unbounded
    ? (file.size > payloadStart ? file.size : Infinity)
    : dataSection.offset + dataSection.size - 8;
  const cur = await openCursor(file, payloadStart, payloadEnd);
  yield* iterateFromCursor(cur, blockAlign, stripAudiMarkers, unbounded);
}

export function wavHeader(sampleRate, nChannels, dataBytes) {
  const blockAlign = nChannels * 2;
  const byteRate = sampleRate * blockAlign;
  const buf = new ArrayBuffer(44);
  const dv = new DataView(buf);
  const riffSize = dataBytes === 0xffffffff ? 0xffffffff : 36 + dataBytes;
  writeFour(dv, 0, "RIFF");
  dv.setUint32(4, riffSize, true);
  writeFour(dv, 8, "WAVE");
  writeFour(dv, 12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, nChannels, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, byteRate, true);
  dv.setUint16(32, blockAlign, true);
  dv.setUint16(34, 16, true);
  writeFour(dv, 36, "data");
  dv.setUint32(40, dataBytes, true);
  return new Uint8Array(buf);
}

function writeFour(dv, off, s) {
  for (let i = 0; i < 4; i++) dv.setUint8(off + i, s.charCodeAt(i));
}

export function stemName(filename) {
  const base = (filename || "recording").split(/[/\\]/).pop();
  return base.replace(/\.dcr$/i, "") || "recording";
}

export function channelFileName(dcrName, channel) {
  const n = String(channel.index + 1).padStart(2, "0");
  const label = (channel.name || `channel-${n}`)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return `${stemName(dcrName)}-${label || "channel-" + n}.wav`;
}
