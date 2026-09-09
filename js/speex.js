const imports = {
  env: {
    floor: Math.floor,
    log: Math.log,
    fabs: Math.abs,
    pow: Math.pow,
  },
};

export class SpeexDecoder {
  constructor(instance) {
    this.instance = instance;
    this.exp = instance.exports;
    this.frameSize = 0;
  }

  static async load(url) {
    const src = url || new URL("../wasm/speex.wasm", import.meta.url);
    let result;
    try {
      const res = await fetch(src);
      result = await WebAssembly.instantiateStreaming(res, imports);
    } catch {
      const res = await fetch(src);
      const buf = await res.arrayBuffer();
      result = await WebAssembly.instantiate(buf, imports);
    }
    return result.instance;
  }

  static async create(sampleRate, instance) {
    const inst = instance || (SpeexDecoder._shared ||= await SpeexDecoder.load());
    const dec = new SpeexDecoder(inst);
    dec.frameSize = dec.exp.speex_open(sampleRate | 0);
    if (!dec.frameSize) throw new Error("could not start Speex decoder");
    return dec;
  }

  decode(frame) {
    const mem = this.exp.memory;
    const inPtr = this.exp.speex_in_ptr();
    const bytes = new Uint8Array(mem.buffer, inPtr, frame.length);
    bytes.set(frame);
    this.exp.speex_decode_frame(frame.length);
    const pcmPtr = this.exp.speex_pcm_ptr();
    const samples = new Int16Array(
      this.exp.memory.buffer,
      pcmPtr,
      this.frameSize
    );
    return new Int16Array(samples);
  }

  close() {
    this.exp.speex_close();
  }
}
