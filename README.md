# clearline

Calls between browsers with uncompressed audio and an uncapped screen. A room
code, not an account.

**<https://aidiotic.github.io/clearline/>**

Start a room, send someone the link, and you are talking. Nothing to install,
nothing to sign up for, and no server in the middle of the call — audio and
video go straight from one browser to the other.

Same idea as [dropline](https://github.com/Aidiotic/dropline), and the same
visual language, applied to a call instead of a file.

---

## What is actually different

Most video calls sound like a phone because the encoder is tuned for the median
case: mono Opus around 32 kbit with discontinuous transmission, and video held
under a conservative internal ceiling no matter what the app asks for. Those are
defaults, not limits. clearline undoes each of them deliberately.

### Audio that is not compressed at all

There is no way to make WebRTC's own audio track carry raw samples — a
`MediaStreamTrack` going into a peer connection is always encoded. So the
lossless path sidesteps it entirely: the microphone is captured on an
`AudioWorklet`, packed as raw PCM, and sent down its own data channel, unordered
and unretransmitted so a late packet can never stall the ones behind it. The far
end reassembles it in a jitter buffer keyed by absolute frame index and plays it
out. What comes out is sample-for-sample what went in.

Five quality settings, named after the models:

| Setting | Format | Bitrate, each way, per person |
|---|---|---|
| Haiku 4.5 | 16-bit / 48 kHz | 1.5 Mbps |
| Sonnet Low | 24-bit / 48 kHz | 2.3 Mbps |
| Sonnet High | 24-bit / 96 kHz | 4.6 Mbps |
| **Opus High** (default) | 24-bit / 192 kHz | 9.2 Mbps |
| Fable | 32-bit float / 192 kHz | 12.3 Mbps |

Opus High matches Apple Music's hi-res lossless ceiling, except that here it is
not even losslessly *compressed* — it is the samples. Fable skips the
quantisation step entirely and sends the audio graph's own floats.

Measured on the wire, each setting lands within 0.7% of its theoretical raw
bitrate. The only overhead is a 12-byte header per 10 ms packet.

Runs of exact digital silence are not sent at all. The receiver fills an unsent
stretch with zeroes, so what it plays is bit-identical to what was captured, and
an idle or muted person costs nothing instead of 9.2 Mbps to everyone. The test
is for exact zero rather than a threshold — a noise gate is a judgement about
what counts as quiet, and getting it wrong clips the front of a word.

Two honest caveats. Above 48 kHz you need an interface that genuinely captures
at that rate — ask for 192 kHz on a machine that runs at 48 and the browser will
happily upsample, so the app tells you when the rate it got is not the rate you
asked for.

And a mesh sends everything once per other person, so the cost multiplies with
the room: 9.2 Mbps to one person is 64.5 Mbps to seven, which no ordinary
connection has. The setting is therefore a **ceiling**, not a promise — the best
quality that fits an upstream budget (25 Mbps by default) is what actually goes
out, so eight people land around 16 Mbps while a two-person call is untouched at
full quality. Peers also report loss back to whoever is sending to them, so a
budget that turns out to be optimistic gets corrected by evidence.

If you would rather not spend the bandwidth, **Compressed** is Opus at 510 kbps,
stereo, full band, DTX off — the top of what the codec can do, and transparent
in listening tests. **Voice** is 64 kbps mono for a bad connection.

### A screen with nothing clamped down

Up to 16K at up to 360 fps, with a bitrate ceiling up to 400 Mbps or none at
all. Asking for more than the source has costs nothing — an ideal constraint is
a request, so a 1440p panel simply returns 1440p — which is why the default is
to ask for the ceiling and take whatever the display actually is.

`degradationPreference` is set to `maintain-resolution` for text, which is the
opposite of the default. Browsers drop resolution first and hold the frame rate,
and unreadable code at a smooth 30 fps is not a trade anyone reading it wants.
Codec is selectable — AV1 and VP9 both handle screen content far better than
H.264 at the same bitrate.

The camera works the same way: native resolution, up to 240 fps, no ceiling by
default, `detail` content hint and `maintain-resolution` so a face stays sharp
rather than being softened to hold a frame rate.

One thing worth knowing about webcams: they expose a fixed list of modes, and
4K60 is usually not one of them. Asking for 60 fps on a camera that only offers
4K30 gets you the smaller mode instead, which is the usual reason a picture
looks soft. **Prefer resolution** (the default) treats the frame rate as a
ceiling and lets the sensor pick its best mode underneath.

### Remaster

An optional mastering chain on your own signal — high-pass, corrective EQ, a
subtractive de-esser, a glue compressor and a limiter, in that order, with Voice,
Music and Broadcast presets.

It is worth being straight about what it is. It cannot add detail the microphone
never captured, and switching it on means what leaves your machine is no longer
bit-identical to what was heard: the transport stays lossless, the source stops
being raw. It is a colouration, chosen on purpose, and it is off by default.

---

## How a room works

There is no server holding a room open. A room is a peer id everyone can work
out from the code: whoever created it parks on `cl-<code>` and answers the door,
and everyone else takes a random id and knocks.

From there it is a full mesh — every pair has its own direct connection, and
nothing is relayed. That is what keeps the audio uncompressed end to end; the
moment anything in the middle decodes a stream to mix it, the argument is over.
It is also why the ceiling is a handful of people rather than a hundred.

If the person who created the room leaves, the remaining members elect the next
one to take the door key, so a room outlives whoever opened it.

Codes are nine characters from an alphabet with no `i`, `l`, `1`, `o` or `0`,
which is about 44 bits. A room exists only while someone is inside it.

### What the signalling service sees

The public PeerJS broker is used to introduce two browsers to each other. It
carries the handshake — offers, answers, ICE candidates — and never any audio,
video or screen content. It is a shared free service with no uptime guarantee;
point `config.js` at your own if that matters.

---

## Running it

Static files. No build step, no bundler — the browser loads the ES modules
directly.

```bash
npx serve .
```

Then open <http://localhost:3000>. WebRTC needs a secure context, and
`localhost` counts as one.

To open a call to yourself, use two tabs: create a room in one, then paste the
link into the other.

---

## Configuration

`config.js` is deliberately not bundled, so it can be edited on a deployed site
without touching anything else. With it untouched, clearline runs on public STUN
and the public PeerJS broker.

Roughly 10–20% of network pairs — symmetric NAT at both ends, mostly — cannot
reach each other without a TURN relay. Add one there if you need it.

---

## Layout

```
index.html            markup and the settings sheet
style.css             the whole visual language
config.js             runtime configuration, unbundled on purpose
audio/
  pcm-worklets.js     capture and playback, on the audio thread
src/
  app.js              wiring: preferences in, room out, render loop
  room.js             room codes, mesh, roster, host migration
  link.js             one peer: negotiation, transceivers, data channel
  sdp.js              the SDP surgery that lifts the quality ceilings
  pcm.js              main-thread half of the lossless path, meters
  remaster.js         the mastering chain
  media.js            capture constraints
  ui.js               everything that touches the DOM
  util.js             pure helpers
```

## Browser support

Chrome and Edge are the target. Safari and Firefox will connect and call, but
the `x-google-*` bitrate keys are Chrome-specific, and AV1 for screen sharing is
not available everywhere. Anything above 48 kHz depends on the audio hardware
more than the browser.

## Licence

MIT.
