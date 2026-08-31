# Testing clearline

There is no unit test suite. Almost everything here is a browser talking to
another browser, and the parts that matter — negotiation, the jitter buffer,
the encoder ceilings — only misbehave against a real peer connection. So the
checks below are run in the browser console, and each one asserts a number you
can compare against a value you worked out beforehand.

`window.clearline` is exposed on `localhost` only and gives you `room`,
`profile`, `local`, `peers` and `prefs`.

## Setting up a call to yourself

Two tabs. Create a room in the first, take the code from `location.hash`, and
in the second set the join field and submit:

```js
document.getElementById('join-code').value = '<code>';
document.getElementById('act-join').click();
```

The hash is read once at load, so pasting a link into a tab that is already
open goes through the `hashchange` path instead — worth exercising both.

## The checks that actually catch things

### Both sides can set encoder parameters

The failure this guards against is silent and asymmetric: whoever answered gets
worse video than whoever offered, and nothing reports it.

```js
const l = [...clearline.room.links.values()][0];
l.sendT.every(t => t.sender.getParameters().encodings.length === 1)   // must be true on BOTH tabs
```

An empty `encodings` array means the transceiver was created by
`setRemoteDescription` rather than by this side, and every later
`setParameters` is a no-op that throws `InvalidModificationError` if you look
too closely.

### The slot mapping agrees

Each side sends on four transceivers and maps the other side's mids to slots.
On a healthy call each tab has eight transceivers, four of its own mids, and
four entries in the map:

```js
const l = [...clearline.room.links.values()][0];
({ mine: l.sendT.map(t => t.mid), theirs: [...l.midToSlot], total: l.pc.getTransceivers().length })
```

### The lossless path really is lossless-rate

Feed a tone in place of a microphone and measure what leaves. Measure elapsed
time with `performance.now()` rather than trusting the `setTimeout` — a
background tab throttles timers and you will over-report by half.

```js
const gen = new AudioContext({ sampleRate: 48000 });
const osc = gen.createOscillator(); osc.frequency.value = 440;
const g = gen.createGain(); g.gain.value = 0.3;
const dst = gen.createMediaStreamDestination();
osc.connect(g).connect(dst); osc.start();
await clearline.room.configureAudio({ mode: 'pcm', tier: 'opusHigh', stream: dst.stream });

const t0 = performance.now(), b0 = clearline.room.audio.bytesOut;
await new Promise(r => setTimeout(r, 2000));
((clearline.room.audio.bytesOut - b0) * 8 / ((performance.now() - t0) / 1000)) / 1e6;
```

Expected, in Mbps: 1.536 · 2.304 · 4.608 · 9.216 · 12.288 for the five
settings. Anything materially above that is a measurement error; anything below
means packets are being dropped before they reach the channel.

### The far end plays it back

```js
const rx = [...clearline.room.pcmIn.values()][0];
({ srcRate: rx.stats.srcRate, under: rx.stats.under,
   loss: (rx.lossRatio * 100).toFixed(3) + '%',
   heldMs: (rx.stats.held / rx.stats.srcRate * 1000).toFixed(1) })
```

`srcRate` must match the sender's setting. `under` should stay at 0 — every
underrun is an audible gap. `held` should sit near the 40 ms target; steadily
climbing means clock drift is not being corrected, and steadily falling means
the buffer is losing the race.

To confirm the audio is the audio and not silence, look for the tone:

```js
const an = rx.node.context.createAnalyser(); an.fftSize = 8192;
rx.node.connect(an);
await new Promise(r => setTimeout(r, 600));
const bins = new Float32Array(an.frequencyBinCount); an.getFloatFrequencyData(bins);
let p = 0; for (let i = 1; i < bins.length; i++) if (bins[i] > bins[p]) p = i;
p * rx.node.context.sampleRate / an.fftSize;      // within one bin of 440
```

At 192 kHz a bin is 23 Hz wide, so 445 is a pass.

### SDP munging survives a round trip

The whole file is a rewrite of a string the browser has to parse back. The
cheapest guard is that tuning an SDP with nothing to tune changes nothing:

```js
const { tune } = await import('/src/sdp.js');
const pc = new RTCPeerConnection(); pc.createDataChannel('x');
const o = await pc.createOffer();
tune(o, clearline.profile).sdp === o.sdp;    // true; no audio or video to touch
pc.close();
```

And that a tuned offer has no blank lines in it, which is what an appended
attribute lands on if the trailing terminator is mishandled:

```js
tune(offer, clearline.profile).sdp.split('\r\n').filter(l => l === '').length;   // exactly 1
```

## Things worth breaking on purpose

- **Join with the page already open.** Set `location.hash` on a tab sitting on
  the lobby. Reading the hash only at startup misses this.
- **Start a screen share mid-call.** This is the renegotiation path, and it is
  where two offers can collide.
- **Change the quality setting mid-call.** Above 48 kHz this closes the
  `AudioContext` and opens a new one, which invalidates every receiver hanging
  off it; they should rebuild on the next packet rather than going silent.
- **Close the host's tab.** The remaining members should elect a new one and
  keep talking; a new joiner should still get in afterwards.
- **Ask for 192 kHz on hardware that runs at 48.** The status line has to say
  so. Quietly upsampling and still calling it hi-res is the dishonest failure.

## Known environment traps

- The in-app browser pane blocks `getUserMedia`, so a microphone cannot be
  tested there. Use a real browser, or substitute an oscillator as above.
- Its console keeps history across navigations — an error you are looking at
  may predate the fix you just made. Check the ids in the message.
- Navigating to a URL that differs only in the fragment does not reload the
  page, so the module you are testing may not be the one on disk. Force it with
  `location.reload()`.
