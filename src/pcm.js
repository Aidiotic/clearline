/* Main-thread half of the uncompressed path, plus the meters.

   One capture node exists per tab no matter how many people are in the room —
   the microphone is sampled once and the resulting packets are fanned out to
   every peer's data channel. Playback is the other way round: one node per
   remote peer, each with its own jitter buffer, because they drift apart. */

import { ema } from './util.js';
import { Remaster } from './remaster.js';

const WORKLET_URL = new URL('../audio/pcm-worklets.js', import.meta.url);

export const FORMATS = {
  i16: { code: 1, bits: 16, label: '16-bit' },
  i24: { code: 3, bits: 24, label: '24-bit' },
  f32: { code: 2, bits: 32, label: '32-bit float' },
};

/* Five quality settings, smallest to largest, named after the models. Opus
   High is the one that matches Apple Music's hi-res lossless ceiling — 24-bit,
   192 kHz — except that here it is not even losslessly compressed. It is the
   samples. Fable spends a third again as much to skip the quantisation step
   altogether and send the graph's own floats.

   The name is a label; the numbers beside it are the specification, and those
   are what the far end actually receives. */
export const TIERS = {
  haiku:      { rate: 48000,  format: 'i16', label: 'Haiku 4.5 · 16-bit / 48 kHz' },
  sonnetLow:  { rate: 48000,  format: 'i24', label: 'Sonnet Low · 24-bit / 48 kHz' },
  sonnetHigh: { rate: 96000,  format: 'i24', label: 'Sonnet High · 24-bit / 96 kHz' },
  opusHigh:   { rate: 192000, format: 'i24', label: 'Opus High · 24-bit / 192 kHz' },
  fable:      { rate: 192000, format: 'f32', label: 'Fable · 32-bit float / 192 kHz' },
};

export const DEFAULT_TIER = 'opusHigh';

export function tierBitrate(tier) {
  const t = TIERS[tier] || TIERS[DEFAULT_TIER];
  return t.rate * 2 * FORMATS[t.format].bits;
}

export function tierLabel(tier) {
  return (TIERS[tier] || TIERS[DEFAULT_TIER]).label;
}

let ctx = null;
let workletReady = null;

/* One context per tab, at whatever rate the chosen tier asks for. Changing
   rate means a new context — an AudioContext's sample rate is fixed for its
   lifetime — so everything hanging off it has to be rebuilt too. */
export async function ensureContext(rate = 48000) {
  if (ctx && ctx.state !== 'closed' && ctx.sampleRate === rate) {
    if (ctx.state === 'suspended') await ctx.resume();
    return ctx;
  }
  if (ctx && ctx.state !== 'closed') {
    try { await ctx.close(); } catch { /* already going */ }
  }
  try {
    ctx = new AudioContext({ sampleRate: rate, latencyHint: 'interactive' });
  } catch {
    // A device that will not run at the asked-for rate: take what it gives
    // rather than failing outright, and let the caller report the difference.
    ctx = new AudioContext({ latencyHint: 'interactive' });
  }
  workletReady = null;
  if (ctx.state === 'suspended') await ctx.resume();
  return ctx;
}

export function context() { return ctx; }
export function contextRate() { return ctx ? ctx.sampleRate : null; }

async function loadWorklet(rate) {
  const context = await ensureContext(rate);
  if (!workletReady) workletReady = context.audioWorklet.addModule(WORKLET_URL.href);
  await workletReady;
  return context;
}

/* ── metering ──

   Drives the clay square and the per-tile dots. Deliberately cheap: one
   analyser, read on the animation frame, smoothed so it reads as a voice
   rather than a strobe. */
export class Meter {
  constructor(node) {
    this.analyser = node.context.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = 0.2;
    node.connect(this.analyser);
    this.buf = new Float32Array(this.analyser.fftSize);
    this.level = 0;
  }

  read() {
    this.analyser.getFloatTimeDomainData(this.buf);
    let sum = 0;
    for (let i = 0; i < this.buf.length; i++) sum += this.buf[i] * this.buf[i];
    const rms = Math.sqrt(sum / this.buf.length);
    // Voice sits low in a linear scale; the cube root spreads the useful part
    // of the range across the whole animation.
    const shaped = Math.min(1, Math.cbrt(rms) * 1.6);
    this.level = ema(this.level, shaped, shaped > this.level ? 0.55 : 0.12);
    return this.level;
  }

  close() {
    try { this.analyser.disconnect(); } catch { /* already gone */ }
  }
}

export function meterForStream(stream) {
  if (!ctx || !stream || !stream.getAudioTracks().length) return null;
  try {
    return new Meter(ctx.createMediaStreamSource(stream));
  } catch {
    return null;
  }
}

/* ── local audio ──

   Owns the graph from the microphone to whatever is going out: raw packets
   down the data channels in lossless mode, or a processed track handed to the
   peer connections in Opus mode. The remaster chain, when it is on, sits in
   the same place for both. */
export class LocalAudio {
  constructor() {
    this.ctx = null;
    this.source = null;
    this.remaster = null;
    this.capture = null;
    this.dest = null;
    this.meter = null;
    this.sinks = new Set();

    this.stream = null;
    this.mode = 'opus';
    this.tier = DEFAULT_TIER;
    this.remasterPreset = null;
    this.muted = false;
    this.bytesOut = 0;
    this.deviceRate = null;
  }

  get rate() { return TIERS[this.tier]?.rate || 48000; }
  get format() { return TIERS[this.tier]?.format || 'i24'; }

  /* Rebuilt wholesale on any change that matters. The graph is small and a
     call only reconfigures on a deliberate action, so tearing it down is
     cheaper in bugs than trying to patch it in place. */
  async setup({ stream, mode, tier, remaster }) {
    this.stream = stream || this.stream;
    this.mode = mode || this.mode;
    if (tier) this.tier = tier;
    this.remasterPreset = remaster === undefined ? this.remasterPreset : remaster;

    this.teardown();
    if (!this.stream) return this;

    const context = await loadWorklet(this.mode === 'pcm' ? this.rate : 48000);
    this.ctx = context;

    const track = this.stream.getAudioTracks()[0];
    this.deviceRate = track?.getSettings?.().sampleRate || null;

    this.source = context.createMediaStreamSource(this.stream);
    let tail = this.source;

    if (this.remasterPreset) {
      this.remaster = new Remaster(context, this.remasterPreset);
      tail.connect(this.remaster.input);
      tail = this.remaster.output;
    }

    if (this.mode === 'pcm') {
      this.capture = new AudioWorkletNode(context, 'pcm-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 2,
        // Explicit, so a mono microphone is upmixed by the graph and the
        // worklet always sees the two channels it packs.
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
        processorOptions: {
          frames: Math.round(context.sampleRate / 100),
          format: FORMATS[this.format].code,
        },
      });
      this.capture.port.onmessage = (e) => {
        const buf = e.data;
        this.bytesOut += buf.byteLength;
        for (const sink of this.sinks) sink(buf);
      };
      tail.connect(this.capture);
      this.capture.port.postMessage({ muted: this.muted });
    } else if (this.remaster) {
      // Opus mode only needs a graph at all when something is processing the
      // signal; otherwise the raw track goes straight to the senders.
      this.dest = context.createMediaStreamDestination();
      tail.connect(this.dest);
    }

    this.meter = new Meter(tail);
    return this;
  }

  /* What the peer connections should send in Opus mode: the processed track
     if there is a chain, else the microphone's own. */
  get outboundTrack() {
    if (this.mode === 'pcm') return null;
    if (this.dest) return this.dest.stream.getAudioTracks()[0] || null;
    return this.stream?.getAudioTracks()[0] || null;
  }

  setMuted(muted) {
    this.muted = muted;
    this.capture?.port.postMessage({ muted });
    // In Opus mode the track itself is what gets gated, including the
    // processed one coming off the chain.
    const track = this.outboundTrack;
    if (track) track.enabled = !muted;
  }

  setRemasterPreset(preset) {
    if (preset && this.remaster) { this.remaster.setPreset(preset); this.remasterPreset = preset; return false; }
    // Turning the chain on or off changes the graph's shape, so it has to be
    // rebuilt; changing which preset is only parameters.
    this.remasterPreset = preset;
    return true;
  }

  addSink(fn) { this.sinks.add(fn); }
  removeSink(fn) { this.sinks.delete(fn); }

  get level() { return this.meter ? this.meter.read() : 0; }
  get reduction() { return this.remaster?.reduction || 0; }

  teardown() {
    this.meter?.close();
    this.remaster?.disconnect();
    for (const node of [this.source, this.capture, this.dest]) {
      try { node?.disconnect(); } catch { /* already gone */ }
    }
    if (this.capture) this.capture.port.onmessage = null;
    this.meter = null;
    this.remaster = null;
    this.source = null;
    this.capture = null;
    this.dest = null;
  }

  stop() {
    this.teardown();
    this.sinks.clear();
    this.stream = null;
  }
}

/* ── playback, one per peer ── */

export class PcmReceiver {
  constructor() {
    this.node = null;
    this.gain = null;
    this.meter = null;
    this.stats = { late: 0, lost: 0, under: 0, played: 0, held: 0, srcRate: 0 };
    this.bytesIn = 0;
  }

  async start(targetMs = 40) {
    // Whatever rate the local context already runs at; the worklet resamples
    // if the sender turns out to be on a different one.
    const context = await loadWorklet(contextRate() || 48000);
    this.stop();

    this.node = new AudioWorkletNode(context, 'pcm-playback', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { targetMs },
    });

    this.node.port.onmessage = (e) => {
      if (e.data && e.data.stats) this.stats = { ...e.data.stats, held: e.data.held, srcRate: e.data.srcRate };
    };

    this.gain = context.createGain();
    this.node.connect(this.gain);
    this.gain.connect(context.destination);
    this.meter = new Meter(this.node);
    return this;
  }

  // Called straight off the data channel's message event.
  push(buf) {
    if (!this.node) return;
    this.bytesIn += buf.byteLength;
    this.node.port.postMessage(buf, [buf]);
  }

  setVolume(v) { if (this.gain) this.gain.gain.value = v; }
  setTarget(ms) { this.node?.port.postMessage({ targetMs: ms }); }

  get level() { return this.meter ? this.meter.read() : 0; }

  // Fraction of frames that never arrived. Shown in the dock so a bad link is
  // visible rather than just audible.
  get lossRatio() {
    const total = this.stats.played + this.stats.lost;
    return total > 0 ? this.stats.lost / total : 0;
  }

  stop() {
    this.meter?.close();
    try { this.node?.disconnect(); } catch { /* already gone */ }
    try { this.gain?.disconnect(); } catch { /* already gone */ }
    this.meter = null;
    this.node = null;
    this.gain = null;
  }
}
