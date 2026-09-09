import { peekDcr, iterateSpeexFrames, channelFileName } from "./dcr.js";
import { SpeexDecoder } from "./speex.js";
import { openWavWriter, registerDownloadWorker } from "./download.js";

const fileInput = document.querySelector("#file");
const statusEl = document.querySelector("#status");
const resultEl = document.querySelector("#result");
const dropEl = document.querySelector("#drop");

registerDownloadWorker();

let current = null;
let busy = false;

fileInput.addEventListener("change", () => {
  const file = fileInput.files && fileInput.files[0];
  if (file) loadFile(file);
});

["dragenter", "dragover"].forEach((ev) => {
  dropEl.addEventListener(ev, (e) => {
    e.preventDefault();
    dropEl.classList.add("over");
  });
});
["dragleave", "drop"].forEach((ev) => {
  dropEl.addEventListener(ev, (e) => {
    e.preventDefault();
    dropEl.classList.remove("over");
  });
});
dropEl.addEventListener("drop", (e) => {
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) loadFile(file);
});

async function loadFile(file) {
  if (busy) return;
  current = null;
  resultEl.hidden = true;
  resultEl.innerHTML = "";
  setStatus("Reading header…");
  try {
    const info = await peekDcr(file);
    current = { file, info };
    setStatus("");
    render(info);
  } catch (err) {
    setStatus(err.message || String(err), true);
  }
}

function render(info) {
  const size = formatBytes(info.fileSize);
  const video = info.videoCount
    ? ` · ${info.videoCount} video stream${info.videoCount === 1 ? "" : "s"} skipped`
    : "";
  resultEl.hidden = false;
  resultEl.innerHTML = `
    <p class="meta">
      <strong>${escapeHtml(info.fileName)}</strong><br>
      ${escapeHtml(info.appName)}${info.created ? " · " + escapeHtml(info.created) : ""}<br>
      ${size} · Speex ${info.wfx.nSamplesPerSec / 1000} kHz${video}
    </p>
    <p class="hint">Each channel is saved as its own WAV</p>
    <ul class="channels"></ul>
  `;
  const list = resultEl.querySelector(".channels");
  for (const ch of info.channels) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = `Save ${ch.name}`;
    btn.addEventListener("click", () => saveChannel(ch, btn));
    li.appendChild(btn);
    list.appendChild(li);
  }
  if (info.channels.length > 1) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "secondary";
    btn.textContent = "Save all channels";
    btn.addEventListener("click", () => saveAll(btn));
    li.appendChild(btn);
    list.appendChild(li);
  }
}

async function saveAll(btn) {
  if (!current || busy) return;
  for (const ch of current.info.channels) {
    await saveChannel(ch, btn);
  }
}

async function saveChannel(channel, btn) {
  if (!current || busy) return;
  busy = true;
  btn.disabled = true;
  const label = btn.textContent;
  const { file, info } = current;
  const name = channelFileName(info.fileName, channel);
  let writer = null;
  try {
    writer = await openWavWriter(name, info.wfx.nSamplesPerSec, 1);
    setStatus(`Decoding ${channel.name}…`);
    const decoder = await SpeexDecoder.create(info.wfx.nSamplesPerSec);
    let frames = 0;
    try {
      for await (const frame of iterateSpeexFrames(file, info.data, info.wfx.nBlockAlign, {
        stripAudiMarkers: info.videoCount > 0,
      })) {
        const pcm = decoder.decode(frame);
        await writer.write(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
        frames++;
        if (frames % 200 === 0) {
          const sec = (frames * decoder.frameSize) / info.wfx.nSamplesPerSec;
          setStatus(`Decoding ${channel.name}… ${sec.toFixed(0)}s`);
          await yieldUi();
        }
      }
    } finally {
      decoder.close();
    }
    await writer.close();
    setStatus(`Saved ${name} (${formatDuration(frames * 0.02)})`);
  } catch (err) {
    if (writer) await writer.abort();
    if (err && err.name === "AbortError") setStatus("Save cancelled.");
    else setStatus(err.message || String(err), true);
  } finally {
    busy = false;
    btn.disabled = false;
    btn.textContent = label;
  }
}

function yieldUi() {
  return new Promise((r) => setTimeout(r, 0));
}

function setStatus(text, isError) {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", Boolean(isError && text));
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(seconds) {
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m ? `${m}m ${r}s` : `${r}s`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
