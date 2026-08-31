/* SDP surgery.

   Browsers negotiate for the median call: Opus lands around 32 kbit mono with
   DTX, and video gets held under a conservative internal ceiling no matter what
   you pass to setParameters. Both of those are decisions made in the offer, and
   the only place to undo them is the SDP itself. Everything here rewrites an
   offer or answer on its way out.

   Munging SDP is unsupported in the sense that no spec promises these knobs
   exist. They do exist in every browser that matters, and they are the
   difference between a call that sounds like a phone and one that doesn't. */

/* Split an SDP into its session block and one entry per m-section, so a rule
   can be applied to the audio line without touching the video ones. */
function sections(sdp) {
  /* Empty lines are dropped rather than carried through. An SDP ends with a
     line terminator, so splitting it always yields a trailing empty string,
     and that string lands inside the *last* m-section — where any rule that
     appends a line (a=ptime, say) would put its line after the blank one and
     produce an SDP the browser refuses to parse. SDP has no meaningful blank
     lines, so there is nothing to preserve. */
  const lines = sdp.split(/\r\n|\n/).filter((l) => l !== '');
  const out = { head: [], media: [] };
  let current = null;
  for (const line of lines) {
    if (line.startsWith('m=')) {
      current = { kind: line.slice(2).split(' ')[0], lines: [line] };
      out.media.push(current);
    } else if (current) {
      current.lines.push(line);
    } else {
      out.head.push(line);
    }
  }
  return out;
}

function join(parsed) {
  const all = [...parsed.head, ...parsed.media.flatMap((m) => m.lines)];
  return all.join('\r\n') + '\r\n';
}

// Payload types in this m-section whose rtpmap names the given codec.
function payloadsFor(section, codec) {
  const re = new RegExp(`^a=rtpmap:(\\d+) ${codec}\\/`, 'i');
  return section.lines.map((l) => l.match(re)).filter(Boolean).map((m) => m[1]);
}

/* Merge key=value pairs into this payload's fmtp, creating the line if the
   browser did not emit one. Existing keys are overwritten, unknown ones kept —
   dropping a key the browser put there (a profile-id, say) breaks the codec. */
function setFmtp(section, payload, params) {
  const idx = section.lines.findIndex((l) => l.startsWith(`a=fmtp:${payload} `));
  const existing = new Map();
  if (idx !== -1) {
    for (const pair of section.lines[idx].slice(`a=fmtp:${payload} `.length).split(';')) {
      const eq = pair.indexOf('=');
      if (eq === -1) { if (pair.trim()) existing.set(pair.trim(), null); continue; }
      existing.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }
  for (const [k, v] of Object.entries(params)) existing.set(k, String(v));

  const body = [...existing.entries()]
    .map(([k, v]) => (v === null ? k : `${k}=${v}`))
    .join(';');
  const line = `a=fmtp:${payload} ${body}`;

  if (idx !== -1) section.lines[idx] = line;
  else {
    // fmtp has to follow its rtpmap, not float to the end of the section.
    const rtpmap = section.lines.findIndex((l) => l.startsWith(`a=rtpmap:${payload} `));
    section.lines.splice(rtpmap === -1 ? section.lines.length : rtpmap + 1, 0, line);
  }
}

/* Bandwidth lines belong immediately after c=, per RFC 4566's ordering, and
   Chrome ignores them anywhere else. */
function setBandwidth(section, kbps) {
  section.lines = section.lines.filter((l) => !l.startsWith('b=AS:') && !l.startsWith('b=TIAS:'));
  if (!kbps) return;
  const at = section.lines.findIndex((l) => l.startsWith('c='));
  const insert = at === -1 ? 1 : at + 1;
  section.lines.splice(insert, 0, `b=AS:${Math.round(kbps)}`, `b=TIAS:${Math.round(kbps * 1000)}`);
}

/* ── audio ──

   maxaveragebitrate is the one that matters. 510000 is the top of Opus's range
   and is transparent for music, let alone speech; stereo=1 plus sprop-stereo=1
   is what keeps both channels — without them the encoder downmixes and the
   bitrate is wasted. usedtx=0 stops the encoder cutting out between words,
   which sounds like a dropout when the room is quiet. */
export function tuneOpus(sdp, opts = {}) {
  const {
    bitrate = 510000,
    stereo = true,
    fec = true,
    dtx = false,
    ptime = 20,
    cbr = false,
  } = opts;

  const parsed = sections(sdp);
  for (const section of parsed.media) {
    if (section.kind !== 'audio') continue;
    const payloads = payloadsFor(section, 'opus');
    if (!payloads.length) continue;

    for (const pt of payloads) {
      setFmtp(section, pt, {
        'maxaveragebitrate': Math.round(bitrate),
        'maxplaybackrate': 48000,
        'sprop-maxcapturerate': 48000,
        'stereo': stereo ? 1 : 0,
        'sprop-stereo': stereo ? 1 : 0,
        'useinbandfec': fec ? 1 : 0,
        'usedtx': dtx ? 1 : 0,
        'cbr': cbr ? 1 : 0,
        'minptime': 10,
      });
    }

    section.lines = section.lines.filter((l) => !l.startsWith('a=ptime:') && !l.startsWith('a=maxptime:'));
    section.lines.push(`a=ptime:${ptime}`, 'a=maxptime:60');

    // Opus at half a megabit needs the headroom declared, or Chrome's own
    // bandwidth estimate holds it down regardless of the fmtp.
    setBandwidth(section, Math.ceil((bitrate / 1000) * 1.25));
  }
  return join(parsed);
}

/* ── video ──

   setParameters({maxBitrate}) is the documented control and it is necessary,
   but on its own it is not sufficient: libwebrtc keeps a separate internal
   ceiling per codec that only the x-google-* fmtp keys move. Setting the start
   bitrate high matters as much as the max — otherwise a share ramps from
   300 kbit and the first ten seconds look like a fax. */
export function tuneVideo(sdp, opts = {}) {
  const { maxKbps = 0, startKbps = 0, minKbps = 0 } = opts;
  if (!maxKbps) return sdp;

  const parsed = sections(sdp);
  for (const section of parsed.media) {
    if (section.kind !== 'video') continue;

    for (const codec of ['VP9', 'VP8', 'H264', 'AV1', 'AV1X', 'H265']) {
      for (const pt of payloadsFor(section, codec)) {
        setFmtp(section, pt, {
          'x-google-max-bitrate': Math.round(maxKbps),
          'x-google-min-bitrate': Math.round(minKbps || Math.min(1000, maxKbps / 10)),
          'x-google-start-bitrate': Math.round(startKbps || Math.min(maxKbps, maxKbps / 2)),
        });
      }
    }
    setBandwidth(section, maxKbps);
  }
  return join(parsed);
}

/* Everything applied to one description, in the order the m-sections appear.
   Called on both the local offer and the local answer: a knob set on only one
   side of the handshake is negotiated away. */
export function tune(description, profile) {
  let sdp = description.sdp;
  sdp = tuneOpus(sdp, profile.opus);
  sdp = tuneVideo(sdp, profile.video);
  return { type: description.type, sdp };
}

/* ── codec preference ──

   setCodecPreferences is a real API rather than a munge, and it is how a
   screen share gets VP9 or AV1 instead of whatever the browser ranks first.
   Screen content is mostly flat colour and sharp edges, which the newer
   codecs handle far better at the same bitrate. */
export function preferCodec(transceiver, name) {
  if (!name || name === 'auto' || !transceiver.setCodecPreferences) return null;
  const supported = RTCRtpSender.getCapabilities?.('video')?.codecs;
  if (!supported) return null;

  const wanted = name.toLowerCase();
  const preferred = supported.filter((c) => c.mimeType.toLowerCase() === `video/${wanted}`);
  if (!preferred.length) return null;

  const rest = supported.filter((c) => c.mimeType.toLowerCase() !== `video/${wanted}`);
  try {
    transceiver.setCodecPreferences([...preferred, ...rest]);
    return name;
  } catch {
    // A codec the receiver cannot decode throws here rather than failing later.
    return null;
  }
}

export function codecAvailable(name) {
  const supported = RTCRtpSender.getCapabilities?.('video')?.codecs || [];
  return supported.some((c) => c.mimeType.toLowerCase() === `video/${String(name).toLowerCase()}`);
}

/* ── sender parameters ──

   maintain-resolution is the important half of this. The default,
   maintain-framerate, is exactly the behaviour that makes shared text
   unreadable: under load the browser drops resolution first and holds 30 fps,
   when what a person reading code wants is every pixel at whatever rate. */
export async function applyEncoding(sender, opts = {}) {
  if (!sender) return;
  const { maxBitrate, maxFramerate, degradationPreference, priority = 'high' } = opts;

  const params = sender.getParameters();
  if (!params.encodings || !params.encodings.length) params.encodings = [{}];

  for (const encoding of params.encodings) {
    if (maxBitrate !== undefined) {
      if (maxBitrate) encoding.maxBitrate = maxBitrate;
      else delete encoding.maxBitrate;
    }
    if (maxFramerate !== undefined) encoding.maxFramerate = maxFramerate;
    encoding.scaleResolutionDownBy = 1;
    encoding.priority = priority;
    encoding.networkPriority = priority;
    encoding.active = true;
  }
  if (degradationPreference) params.degradationPreference = degradationPreference;

  try {
    await sender.setParameters(params);
  } catch (err) {
    // Firefox rejects degradationPreference outright; the bitrate is worth
    // keeping even when the hint is not.
    if (degradationPreference) {
      delete params.degradationPreference;
      try { await sender.setParameters(params); } catch { /* nothing more to try */ }
    }
  }
}
