/** Liberty / High Criteria DCR reader. All offsets are file-absolute. */

const MAGIC = "HGCRLCRS";
const CADR_BGN = asciiBytes("cadr#bgn");
const AUDI_MRK = asciiBytes("audi#mrk");

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

export async function peekDcr(file) {
  if (file.size < 36) throw new Error("file is too small to be a Liberty DCR");
  const head = await readSlice(file, 0, 16);
  const magic = String.fromCharCode(...head.subarray(0, 8));
  if (magic !== MAGIC) {
    throw new Error("not a Liberty DCR file (missing HGCRLCRS header)");
  }
  const hv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const version = u32(hv, 8);
  const flags = u32(hv, 12);

  const tail = await readSlice(file, Math.max(0, file.size - 20), 20);
  if (String.fromCharCode(...tail.subarray(0, 4)) !== "head") {
    throw new Error("could not find DCR trailer (not a Liberty recording?)");
  }
  const tv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  const trailerOff = u64(tv, 4);
  const trailerSize = u64(tv, 12);
  if (trailerOff + trailerSize !== file.size) {
    throw new Error("DCR trailer does not match file size");
  }

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

  const wfmtSec = sections.find((s) => s.name === "wfmt");
  const dataSec = sections.find((s) => s.name === "data");
  if (!wfmtSec || !dataSec) throw new Error("file is missing audio (wfmt/data) sections");

  const wfmtRaw = await readSlice(file, wfmtSec.offset, wfmtSec.size);
  const wfx = parseWfx(payloadOf(wfmtRaw, "wfmt"));

  let metaText = "";
  const metaSec = sections.find((s) => s.name === "meta");
  if (metaSec) {
    const raw = await readSlice(file, metaSec.offset, metaSec.size);
    metaText = xmlPayload(payloadOf(raw, "meta"));
  }

  let rinfText = "";
  const rinfSec = sections.find((s) => s.name === "rinf");
  if (rinfSec) {
    const raw = await readSlice(file, rinfSec.offset, rinfSec.size);
    rinfText = xmlPayload(payloadOf(raw, "rinf"));
  }

  const channelNames = parseChannelNames(rinfText);
  const nAudio = wfx.nChannels || 1;
  const channels = [];
  for (let c = 0; c < nAudio; c++) {
    channels.push({
      index: c,
      name: channelNames[c] || `Channel ${c + 1}`,
    });
  }

  return {
    version,
    flags,
    fileName: file.name || "recording.dcr",
    fileSize: file.size,
    sections,
    wfx,
    data: dataSec,
    appName: cdata(metaText, "NAMEAPP") || "Liberty",
    created: cdata(metaText, "TIMECR"),
    channels,
    videoCount: sections.filter((s) => s.name === "vdeo").length,
  };
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
  const body = payload.length >= 22 && payload[0] === 0 && payload[1] === 0
    && payload[2] === 0 && payload[3] === 0
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

class Cursor {
  constructor(blob, start, end) {
    this.blob = blob;
    this.pos = start;
    this.end = end;
    this.buf = new Uint8Array(0);
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

/**
 * Yield packed Speex frames. Video `cadr` chunks are skipped by advancing
 * the file cursor so their bodies are never loaded.
 *
 * `audi#mrk` tokens are real bookmarks only in video recordings (they sit on
 * Speex frame boundaries in the gaps around `cadr`). Audio-only files can
 * contain the same eight bytes inside the bitstream, so we must not strip
 * them there.
 */
export async function* iterateSpeexFrames(file, dataSection, blockAlign, options = {}) {
  const stripAudiMarkers = Boolean(options.stripAudiMarkers);
  const payloadStart = dataSection.offset + 8;
  const payloadEnd = dataSection.offset + dataSection.size - 8;
  const cur = new Cursor(file, payloadStart, payloadEnd);
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

  while (cur.pos < cur.end || cur.buffered() > 0) {
    await cur.fill(12);
    if (cur.buffered() === 0) break;

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
    let cut = cur.buf.length;
    if (cadrAt >= 0) cut = Math.min(cut, cadrAt);
    if (audiAt >= 0) cut = Math.min(cut, audiAt);

    if (cut === cur.buf.length) {
      const keep = Math.min(7, cur.buf.length);
      const take = cur.buf.length - keep;
      if (take <= 0) {
        if (cur.pos >= cur.end) {
          const frames = emitFrom(cur.consume(cur.buffered()));
          for (const f of frames) yield f;
          break;
        }
        await cur.fill(cur.buffered() + 64 * 1024);
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
