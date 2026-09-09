/* Same-origin streaming download helper. Audio never leaves this origin. */

const pending = new Map();

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type !== "open-download") return;
  const port = event.ports && event.ports[0];
  if (!port || !data.id) return;
  pending.set(data.id, { port, filename: data.filename || "audio.wav" });
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (!url.pathname.endsWith("/__dl") && !url.pathname.includes("/__dl")) return;
  const id = url.searchParams.get("id");
  event.respondWith(streamDownload(id));
});

async function streamDownload(id) {
  const started = Date.now();
  let rec = pending.get(id);
  while (!rec && Date.now() - started < 4000) {
    await new Promise((r) => setTimeout(r, 25));
    rec = pending.get(id);
  }
  if (!rec) {
    return new Response("download expired", { status: 404 });
  }
  pending.delete(id);

  const stream = new ReadableStream({
    start(controller) {
      rec.port.onmessage = (event) => {
        const msg = event.data;
        if (msg && msg.type === "done") {
          controller.close();
          rec.port.close();
          return;
        }
        if (msg && msg.type === "abort") {
          try {
            controller.error(new Error("abort"));
          } catch {
            /* ignore */
          }
          rec.port.close();
          return;
        }
        if (msg instanceof ArrayBuffer) {
          controller.enqueue(new Uint8Array(msg));
        } else if (msg instanceof Uint8Array) {
          controller.enqueue(msg);
        } else if (msg && msg.buffer) {
          controller.enqueue(new Uint8Array(msg.buffer, msg.byteOffset, msg.byteLength));
        }
      };
      rec.port.postMessage({ type: "ready" });
    },
    cancel() {
      try {
        rec.port.postMessage({ type: "abort" });
        rec.port.close();
      } catch {
        /* ignore */
      }
    },
  });

  const name = rec.filename.replace(/"/g, "");
  return new Response(stream, {
    headers: {
      "Content-Type": "audio/wav",
      "Content-Disposition": `attachment; filename="${name}"`,
    },
  });
}
