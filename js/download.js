/** Stream a WAV to disk. Prefer a real file handle so PCM is not buffered. */

export function canStreamToDisk() {
  return typeof window !== "undefined" && typeof window.showSaveFilePicker === "function";
}

let swReady = null;

export function registerDownloadWorker() {
  if (typeof navigator === "undefined" || !navigator.serviceWorker) return;
  swReady = navigator.serviceWorker
    .register(new URL("../sw.js", import.meta.url))
    .then(() => navigator.serviceWorker.ready)
    .catch(() => null);
}

export async function openWavWriter(suggestedName, sampleRate, nChannels) {
  if (canStreamToDisk()) {
    try {
      return await openFileHandleWriter(suggestedName, sampleRate, nChannels);
    } catch (err) {
      if (err && err.name === "AbortError") throw err;
    }
  }
  const sw = await openServiceWorkerWriter(suggestedName, sampleRate, nChannels);
  if (sw) return sw;
  return openBlobWriter(suggestedName, sampleRate, nChannels);
}

async function openFileHandleWriter(suggestedName, sampleRate, nChannels) {
  const handle = await window.showSaveFilePicker({
    suggestedName,
    types: [
      {
        description: "WAV audio",
        accept: { "audio/wav": [".wav"] },
      },
    ],
  });
  const writable = await handle.createWritable();
  await writable.write(new Uint8Array(44));
  const queue = [];
  let queued = 0;
  let dataBytes = 0;

  async function flush() {
    if (!queued) return;
    if (queue.length === 1) {
      await writable.write(queue[0]);
    } else {
      const all = new Uint8Array(queued);
      let o = 0;
      for (const part of queue) {
        all.set(part, o);
        o += part.byteLength;
      }
      await writable.write(all);
    }
    dataBytes += queued;
    queue.length = 0;
    queued = 0;
  }

  return {
    kind: "fs",
    async write(bytes) {
      queue.push(bytes);
      queued += bytes.byteLength;
      if (queued >= 64 * 1024) await flush();
    },
    async close() {
      await flush();
      const { wavHeader } = await import("./dcr.js");
      await writable.seek(0);
      await writable.write(wavHeader(sampleRate, nChannels, dataBytes));
      await writable.close();
    },
    async abort() {
      try {
        await writable.abort();
      } catch {
        /* ignore */
      }
    },
  };
}

async function openServiceWorkerWriter(suggestedName, sampleRate, nChannels) {
  if (!swReady) return null;
  const ready = await swReady;
  const worker = ready && (ready.active || (navigator.serviceWorker && navigator.serviceWorker.controller));
  if (!worker) return null;

  const { wavHeader } = await import("./dcr.js");
  const id = crypto.randomUUID();
  const channel = new MessageChannel();

  const readyWait = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), 3000);
    channel.port1.onmessage = (ev) => {
      if (ev.data && ev.data.type === "ready") {
        clearTimeout(t);
        resolve();
      }
    };
  });

  worker.postMessage(
    { type: "open-download", id, filename: suggestedName },
    [channel.port2]
  );

  const iframe = document.createElement("iframe");
  iframe.setAttribute("hidden", "");
  iframe.src = new URL(
    `__dl?id=${encodeURIComponent(id)}`,
    document.baseURI
  ).href;
  document.body.appendChild(iframe);

  try {
    await readyWait;
  } catch {
    iframe.remove();
    return null;
  }

  let headerSent = false;
  return {
    kind: "sw",
    async write(bytes) {
      if (!headerSent) {
        headerSent = true;
        channel.port1.postMessage(wavHeader(sampleRate, nChannels, 0xffffffff));
      }
      const copy = bytes.slice();
      channel.port1.postMessage(copy, [copy.buffer]);
    },
    async close() {
      if (!headerSent) {
        headerSent = true;
        channel.port1.postMessage(wavHeader(sampleRate, nChannels, 0));
      }
      channel.port1.postMessage({ type: "done" });
      setTimeout(() => iframe.remove(), 8000);
    },
    async abort() {
      channel.port1.postMessage({ type: "abort" });
      iframe.remove();
    },
  };
}

function openBlobWriter(suggestedName, sampleRate, nChannels) {
  const parts = [];
  let dataBytes = 0;
  return {
    kind: "blob",
    async write(bytes) {
      parts.push(bytes);
      dataBytes += bytes.byteLength;
    },
    async close() {
      const { wavHeader } = await import("./dcr.js");
      const blob = new Blob([wavHeader(sampleRate, nChannels, dataBytes), ...parts], {
        type: "audio/wav",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = suggestedName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 15_000);
    },
    async abort() {
      parts.length = 0;
    },
  };
}
