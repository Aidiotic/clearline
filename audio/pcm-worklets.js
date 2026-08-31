/* The uncompressed audio path, both ends of it, running on the audio thread.

   There is no way to make WebRTC's own audio track carry raw samples — a
   MediaStreamTrack going into a peer connection is always encoded. So this
   sidesteps that path entirely: capture straight off the graph, ship the
   samples down a data channel, and play them back through a ring buffer. What
   comes out the far end is what went in, sample for sample, at up to
   24-bit / 192 kHz.

   The cost is that everything a codec normally does for free has to be done
   here: packet loss, reordering, jitter and clock drift are all ours now.

   Loaded with AudioWorklet.addModule, so: no imports, no bundler. */

const RING_SECONDS = 1;
const FMT_I16 = 1;
const FMT_F32 = 2;
const FMT_I24 = 3;

const HEADER = 12;   // seq u32 · format u8 · channels u8 · frames u16 · rate u32

function bytesPerSample(format) {
  if (format === FMT_F32) return 4;
  if (format === FMT_I24) return 3;
  return 2;
}

/* ── capture ──

   The graph hands us 128 frames at a time, which is far too small to put on
   the wire on its own — the header alone would be a fifth of the payload. So
   quanta accumulate into a packet (10 ms worth, whatever that is at the
   current rate) and go out together. */
class PcmCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options.processorOptions || {};
    this.frames = opts.frames || Math.round(sampleRate / 100);
    this.format = opts.format || FMT_I16;
    this.channels = 2;
    this.seq = 0;
    this.filled = 0;
    this.muted = false;
    this.acc = [new Float32Array(this.frames), new Float32Array(this.frames)];

    this.port.onmessage = (e) => {
      const msg = e.data;
      if (msg.format) this.format = msg.format;
      if (msg.muted !== undefined) this.muted = !!msg.muted;
    };
  }

  process(inputs) {
    const input = inputs[0];
    // An input with no connected source arrives as an empty array. Feeding
    // silence keeps the far end's clock running rather than starving it.
    const left = (input && input[0]) || null;
    const right = (input && input[1]) || left;
    const quantum = left ? left.length : 128;

    for (let i = 0; i < quantum; i++) {
      this.acc[0][this.filled] = (left && !this.muted) ? left[i] : 0;
      this.acc[1][this.filled] = (right && !this.muted) ? right[i] : 0;
      this.filled++;
      if (this.filled === this.frames) this.flush();
    }
    return true;
  }

  flush() {
    const n = this.frames;
    const format = this.format;
    const buf = new ArrayBuffer(HEADER + n * this.channels * bytesPerSample(format));
    const head = new DataView(buf);
    head.setUint32(0, this.seq >>> 0);
    head.setUint8(4, format);
    head.setUint8(5, this.channels);
    head.setUint16(6, n);
    head.setUint32(8, sampleRate);

    const l = this.acc[0], r = this.acc[1];

    if (format === FMT_F32) {
      const out = new Float32Array(buf, HEADER);
      for (let i = 0; i < n; i++) { out[i * 2] = l[i]; out[i * 2 + 1] = r[i]; }
    } else if (format === FMT_I24) {
      const out = new Uint8Array(buf, HEADER);
      for (let i = 0; i < n; i++) {
        write24(out, i * 6, l[i]);
        write24(out, i * 6 + 3, r[i]);
      }
    } else {
      const out = new Int16Array(buf, HEADER);
      for (let i = 0; i < n; i++) {
        out[i * 2] = to16(l[i]);
        out[i * 2 + 1] = to16(r[i]);
      }
    }

    this.seq = (this.seq + 1) >>> 0;
    this.filled = 0;
    this.port.postMessage(buf, [buf]);
  }
}

// Clamp before scaling: the graph can hand back values past ±1, and letting
// those wrap turns a loud moment into a burst of noise.
function clamp1(x) {
  return x > 1 ? 1 : (x < -1 ? -1 : x);
}

function to16(x) {
  const v = clamp1(x);
  return v < 0 ? v * 0x8000 : v * 0x7FFF;
}

function write24(out, at, x) {
  const v = clamp1(x);
  const i = Math.round(v < 0 ? v * 0x800000 : v * 0x7FFFFF);
  out[at] = i & 0xFF;
  out[at + 1] = (i >> 8) & 0xFF;
  out[at + 2] = (i >> 16) & 0xFF;
}

/* ── playback ──

   A jitter buffer over an absolute frame index. Every packet knows exactly
   where it belongs (seq × frames), so late and out-of-order arrivals land in
   the right slot instead of being played in the wrong order. A gap is zeroed
   on arrival of the packet past it, and repaired in place if the missing one
   turns up before the playhead reaches it.

   The ring holds samples at the *sender's* rate, and the playhead advances by
   senderRate/contextRate per output frame. When both ends run at the same rate
   — the normal case — that step is exactly 1 and nothing is interpolated. */
class PcmPlayback extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options.processorOptions || {};
    this.channels = 2;
    this.targetMs = opts.targetMs || 40;
    this.srcRate = sampleRate;
    this.allocate(sampleRate);
    this.stats = { late: 0, lost: 0, under: 0, played: 0 };
    this.lastReport = 0;

    this.port.onmessage = (e) => {
      if (e.data && e.data.targetMs) { this.targetMs = e.data.targetMs; this.retarget(); return; }
      this.accept(e.data);
    };
  }

  allocate(rate) {
    this.srcRate = rate;
    this.ringFrames = Math.ceil(rate * RING_SECONDS);
    this.ring = new Float32Array(this.ringFrames * this.channels);
    this.playPos = 0;
    this.endFrame = 0;
    this.started = false;
    this.primed = false;
    this.retarget();
  }

  retarget() {
    this.target = Math.round((this.targetMs / 1000) * this.srcRate);
  }

  accept(buf) {
    const head = new DataView(buf);
    const seq = head.getUint32(0);
    const format = head.getUint8(4);
    const frames = head.getUint16(6);
    const rate = head.getUint32(8) || sampleRate;
    if (!frames) return;

    // A sender that changes rate mid-call starts a new timeline entirely.
    if (rate !== this.srcRate) this.allocate(rate);

    const start = seq * frames;
    const end = start + frames;

    if (!this.primed) {
      this.primed = true;
      this.playPos = start;
      this.endFrame = start;
    }

    // Already played past it — nothing useful left to do with it.
    if (end <= this.playPos) { this.stats.late++; return; }

    // Wildly ahead, or the sender restarted: resync rather than zero-fill a
    // hole the size of the ring.
    if (start > this.endFrame + this.ringFrames / 2 || start + this.ringFrames < this.playPos) {
      this.ring.fill(0);
      this.playPos = start;
      this.endFrame = start;
      this.started = false;
    }

    // A gap means packets that never arrived. Zero them so they play as a
    // short silence; if a straggler lands before the playhead gets there, its
    // write below overwrites the silence and the gap never existed.
    if (start > this.endFrame) {
      this.stats.lost += start - this.endFrame;
      for (let f = this.endFrame; f < start; f++) {
        const at = (f % this.ringFrames) * this.channels;
        this.ring[at] = 0;
        this.ring[at + 1] = 0;
      }
    }

    const body = HEADER;
    if (format === FMT_F32) {
      const src = new Float32Array(buf, body);
      this.writeFrames(start, frames, (i) => src[i * 2], (i) => src[i * 2 + 1]);
    } else if (format === FMT_I24) {
      const src = new Uint8Array(buf, body);
      this.writeFrames(start, frames, (i) => read24(src, i * 6), (i) => read24(src, i * 6 + 3));
    } else {
      const src = new Int16Array(buf, body);
      const s = 1 / 0x8000;
      this.writeFrames(start, frames, (i) => src[i * 2] * s, (i) => src[i * 2 + 1] * s);
    }

    if (end > this.endFrame) this.endFrame = end;
  }

  writeFrames(start, frames, left, right) {
    for (let i = 0; i < frames; i++) {
      const f = start + i;
      if (f < this.playPos) continue;             // partially late packet
      const at = (f % this.ringFrames) * this.channels;
      this.ring[at] = left(i);
      this.ring[at + 1] = right(i);
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    if (!out || !out.length) return true;
    const left = out[0];
    const right = out[1] || out[0];
    const quantum = left.length;
    const step = this.srcRate / sampleRate;

    // Hold output until there is enough in hand to ride out normal jitter.
    if (!this.started) {
      if (this.primed && this.endFrame - this.playPos >= this.target) this.started = true;
      else { left.fill(0); if (right !== left) right.fill(0); return true; }
    }

    for (let i = 0; i < quantum; i++) {
      // One frame of headroom, because interpolation reads the next sample.
      if (this.playPos + 1 >= this.endFrame) {
        // Ran dry. Output silence and go back to filling, rather than
        // stuttering through every subsequent quantum.
        left[i] = 0;
        if (right !== left) right[i] = 0;
        this.started = false;
        this.stats.under++;
        continue;
      }

      const base = Math.floor(this.playPos);
      const frac = this.playPos - base;
      const a = (base % this.ringFrames) * this.channels;

      if (frac === 0) {
        left[i] = this.ring[a];
        if (right !== left) right[i] = this.ring[a + 1];
      } else {
        const b = ((base + 1) % this.ringFrames) * this.channels;
        left[i] = this.ring[a] + (this.ring[b] - this.ring[a]) * frac;
        if (right !== left) right[i] = this.ring[a + 1] + (this.ring[b + 1] - this.ring[a + 1]) * frac;
      }

      this.playPos += step;
      this.stats.played++;
    }

    // Drift: if the buffer keeps growing the sender's clock is faster than
    // ours, and the latency would climb all call. Drop back to target.
    const held = this.endFrame - this.playPos;
    if (held > this.target * 4) this.playPos = this.endFrame - this.target;

    if (currentTime - this.lastReport > 1) {
      this.lastReport = currentTime;
      this.port.postMessage({ stats: this.stats, held, srcRate: this.srcRate });
    }
    return true;
  }
}

function read24(src, at) {
  let v = src[at] | (src[at + 1] << 8) | (src[at + 2] << 16);
  if (v & 0x800000) v |= ~0xFFFFFF;   // sign-extend the 24-bit value
  return v / 0x800000;
}

registerProcessor('pcm-capture', PcmCapture);
registerProcessor('pcm-playback', PcmPlayback);
