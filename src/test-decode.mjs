import { readFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { peekDcr, iterateSpeexFrames, wavHeader } from "../js/dcr.js";
import { SpeexDecoder } from "../js/speex.js";

const wasmPath = new URL("../wasm/speex.wasm", import.meta.url);
const wasmBytes = await readFile(wasmPath);
const { instance } = await WebAssembly.instantiate(wasmBytes, {
  env: {
    floor: Math.floor,
    log: Math.log,
    fabs: Math.abs,
    pow: Math.pow,
  },
});

async function convert(path, { lieSize } = {}) {
  const buf = await readFile(path);
  let file = new Blob([buf], { type: "application/octet-stream" });
  file.name = path.split("/").pop();
  if (lieSize) {
    const inner = file;
    file = new Proxy(inner, {
      get(target, prop) {
        if (prop === "size") return 0;
        const v = target[prop];
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    file.name = path.split("/").pop();
  }
  const info = await peekDcr(file);
  const decoder = await SpeexDecoder.create(info.wfx.nSamplesPerSec, instance);
  const pcmParts = [];
  let frames = 0;
  const t0 = Date.now();
  try {
    for await (const frame of iterateSpeexFrames(file, info.data, info.wfx.nBlockAlign, {
      stripAudiMarkers: info.videoCount > 0,
    })) {
      const pcm = decoder.decode(frame);
      pcmParts.push(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
      frames++;
    }
  } finally {
    decoder.close();
  }
  const pcm = Buffer.concat(pcmParts);
  const header = Buffer.from(wavHeader(info.wfx.nSamplesPerSec, 1, pcm.length));
  const ms = Date.now() - t0;
  return { info, frames, pcm, wav: Buffer.concat([header, pcm]), ms };
}

const files = process.argv.slice(2);
if (!files.length) {
  files.push(
    "/home/dylan/Projects/dcr/samples/vendor-archive/Music_20120301.dcr",
    "/home/dylan/Projects/dcr/samples/vendor/kqdps_rm1_20091015_115918.dcr"
  );
}

for (const f of files) {
  const r = await convert(f);
  console.log(
    JSON.stringify({
      file: r.info.fileName,
      app: r.info.appName,
      channels: r.info.channels.map((c) => c.name),
      video: r.info.videoCount,
      rate: r.info.wfx.nSamplesPerSec,
      align: r.info.wfx.nBlockAlign,
      frames: r.frames,
      seconds: +(r.frames * 0.02).toFixed(2),
      pcmBytes: r.pcm.length,
      ms: r.ms,
      scanned: !!r.info.scanned,
    })
  );
  if (process.env.WRITE_WAV) {
    const out = f.replace(/\.dcr$/i, ".browser.wav");
    writeFileSync(out, r.wav);
    console.log("wrote", out);
  }
}

const music = "/home/dylan/Projects/dcr/samples/vendor-archive/Music_20120301.dcr";
if (!process.argv.slice(2).length) {
  const r = await convert(music, { lieSize: true });
  console.log(
    JSON.stringify({
      lieSize: true,
      frames: r.frames,
      seconds: +(r.frames * 0.02).toFixed(2),
      scanned: !!r.info.scanned,
    })
  );
}
