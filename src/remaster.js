/* The remaster chain.

   Worth being straight about what this is. It cannot add detail the capsule
   never captured, and switching it on means what leaves this machine is no
   longer bit-identical to what the microphone heard — the transport stays
   lossless, the source stops being raw. It is a colouration, chosen on
   purpose, and it is off by default for exactly that reason.

   What it does do is the work a mastering engineer would do to a spoken or
   sung take before anyone else hears it: get the rumble out, unpick the mud
   around 300 Hz, put back the presence and air that a close mic and a
   directional pattern take away, tame sibilance, then even out the level with
   a slow compressor and stop the peaks with a fast one.

   Every stage is a real filter with a real reason. The order matters: correct
   before you enhance, enhance before you level, level before you limit. */

const PRESETS = {
  // Speech through a close mic: lift presence hard, control sibilance hard,
  // and hold a tight dynamic range so a quiet aside is still audible.
  voice: {
    label: 'Voice',
    highpass: 80,
    lowShelf: { freq: 140, gain: 1.5 },
    mud: { freq: 320, gain: -2.5, q: 1.1 },
    presence: { freq: 3400, gain: 3.5, q: 0.9 },
    air: { freq: 11000, gain: 3 },
    deEss: { freq: 6800, q: 1.2, threshold: -32, ratio: 6 },
    glue: { threshold: -20, knee: 10, ratio: 3, attack: 0.008, release: 0.22 },
    makeup: 3,
    limiter: { threshold: -1.5, ratio: 20, attack: 0.002, release: 0.06 },
  },

  // Anything musical: barely touch the dynamics, keep the low end whole, and
  // shape only the top where a room and a diaphragm cost you the most.
  music: {
    label: 'Music',
    highpass: 28,
    lowShelf: { freq: 110, gain: 1 },
    mud: { freq: 300, gain: -1.2, q: 0.9 },
    presence: { freq: 3000, gain: 1.5, q: 0.7 },
    air: { freq: 13000, gain: 2.5 },
    deEss: { freq: 7400, q: 1.4, threshold: -26, ratio: 4 },
    glue: { threshold: -16, knee: 14, ratio: 2, attack: 0.02, release: 0.35 },
    makeup: 1.5,
    limiter: { threshold: -1, ratio: 20, attack: 0.003, release: 0.09 },
  },

  // The loud one. Everything lands at the same level, which is what you want
  // when the other end is on a laptop speaker in a noisy room.
  broadcast: {
    label: 'Broadcast',
    highpass: 90,
    lowShelf: { freq: 150, gain: 2 },
    mud: { freq: 340, gain: -3, q: 1.2 },
    presence: { freq: 3600, gain: 4.5, q: 1 },
    air: { freq: 10500, gain: 3.5 },
    deEss: { freq: 6600, q: 1.1, threshold: -36, ratio: 8 },
    glue: { threshold: -26, knee: 8, ratio: 4.5, attack: 0.005, release: 0.16 },
    makeup: 5,
    limiter: { threshold: -1, ratio: 20, attack: 0.001, release: 0.05 },
  },
};

export const PRESET_NAMES = Object.keys(PRESETS);
export const presetLabel = (name) => PRESETS[name]?.label || name;

export class Remaster {
  constructor(ctx, preset = 'voice') {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.build();
    this.setPreset(preset);
  }

  build() {
    const ctx = this.ctx;

    this.highpass = biquad(ctx, 'highpass');
    this.lowShelf = biquad(ctx, 'lowshelf');
    this.mud = biquad(ctx, 'peaking');
    this.presence = biquad(ctx, 'peaking');
    this.air = biquad(ctx, 'highshelf');

    /* De-essing, done by subtraction. The sibilant band is split off, squashed
       on its own, phase-inverted and added back — so the chain only removes
       energy in the moments the band is actually loud, and a take with no
       sibilance passes through untouched. Compressing the whole signal with a
       high-frequency key would dip the entire voice on every "s". */
    this.essBand = biquad(ctx, 'bandpass');
    this.essComp = ctx.createDynamicsCompressor();
    this.essInvert = ctx.createGain();
    this.essInvert.gain.value = -1;

    this.glue = ctx.createDynamicsCompressor();
    this.makeup = ctx.createGain();

    // A limiter is a compressor with the ratio pushed to the point of being a
    // brick wall and an attack fast enough to catch a transient.
    this.limiter = ctx.createDynamicsCompressor();

    // Main path.
    this.input
      .connect(this.highpass)
      .connect(this.lowShelf)
      .connect(this.mud)
      .connect(this.presence)
      .connect(this.air)
      .connect(this.glue)
      .connect(this.makeup)
      .connect(this.limiter)
      .connect(this.output);

    // De-esser sidechain, tapped after the tone shaping and summed back in
    // ahead of the compressor so the glue stage never sees the sibilance.
    this.air.connect(this.essBand);
    this.essBand.connect(this.essComp);
    this.essComp.connect(this.essInvert);
    this.essInvert.connect(this.glue);
  }

  setPreset(name) {
    const p = PRESETS[name] || PRESETS.voice;
    this.preset = name in PRESETS ? name : 'voice';
    const now = this.ctx.currentTime;

    set(this.highpass.frequency, p.highpass, now);
    this.highpass.Q.setTargetAtTime(0.707, now, 0.01);

    set(this.lowShelf.frequency, p.lowShelf.freq, now);
    set(this.lowShelf.gain, p.lowShelf.gain, now);

    set(this.mud.frequency, p.mud.freq, now);
    set(this.mud.gain, p.mud.gain, now);
    set(this.mud.Q, p.mud.q, now);

    set(this.presence.frequency, p.presence.freq, now);
    set(this.presence.gain, p.presence.gain, now);
    set(this.presence.Q, p.presence.q, now);

    set(this.air.frequency, p.air.freq, now);
    set(this.air.gain, p.air.gain, now);

    set(this.essBand.frequency, p.deEss.freq, now);
    set(this.essBand.Q, p.deEss.q, now);
    set(this.essComp.threshold, p.deEss.threshold, now);
    set(this.essComp.ratio, p.deEss.ratio, now);
    set(this.essComp.attack, 0.001, now);
    set(this.essComp.release, 0.05, now);
    set(this.essComp.knee, 6, now);

    set(this.glue.threshold, p.glue.threshold, now);
    set(this.glue.knee, p.glue.knee, now);
    set(this.glue.ratio, p.glue.ratio, now);
    set(this.glue.attack, p.glue.attack, now);
    set(this.glue.release, p.glue.release, now);

    set(this.makeup.gain, dbToGain(p.makeup), now);

    set(this.limiter.threshold, p.limiter.threshold, now);
    set(this.limiter.knee, 0, now);
    set(this.limiter.ratio, p.limiter.ratio, now);
    set(this.limiter.attack, p.limiter.attack, now);
    set(this.limiter.release, p.limiter.release, now);
  }

  // How hard the levelling stages are working right now, in dB. Worth showing:
  // a chain pinned at 20 dB of reduction is a chain set too aggressively.
  get reduction() {
    return Math.abs(this.glue.reduction || 0) + Math.abs(this.limiter.reduction || 0);
  }

  disconnect() {
    for (const node of [this.input, this.highpass, this.lowShelf, this.mud, this.presence,
      this.air, this.essBand, this.essComp, this.essInvert, this.glue, this.makeup,
      this.limiter, this.output]) {
      try { node.disconnect(); } catch { /* already gone */ }
    }
  }
}

function biquad(ctx, type) {
  const node = ctx.createBiquadFilter();
  node.type = type;
  return node;
}

// Ramped rather than assigned: changing a preset mid-sentence should not put
// a click in the middle of a word.
function set(param, value, now) {
  param.setTargetAtTime(value, now, 0.01);
}

function dbToGain(db) {
  return Math.pow(10, db / 20);
}
