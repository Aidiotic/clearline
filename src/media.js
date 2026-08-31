/* Getting hold of local media, with the constraints that actually matter.

   The defaults a browser picks are tuned for a conference call on a laptop
   speaker: mono, gated, gain-ridden, and a screen capture at whatever frame
   rate is cheapest. Every constraint here is a deliberate move away from that. */

export const SLOT = { MIC: 0, CAM: 1, SCREEN: 2, SCREEN_AUDIO: 3 };
export const SLOT_COUNT = 4;

/* ── microphone ──

   With processing off the signal reaching the encoder is what the capsule
   heard. That is the point, and it is also why headphones stop being optional:
   nothing is left to stop the far end's voice looping back through the room. */
export async function getMic({ deviceId, dsp = false } = {}) {
  const audio = {
    echoCancellation: dsp,
    noiseSuppression: dsp,
    autoGainControl: dsp,
    channelCount: { ideal: 2 },
    sampleRate: { ideal: 48000 },
    sampleSize: { ideal: 16 },
    latency: { ideal: 0.01 },
  };
  // Newer Chrome ships a separate speech-isolation stage that survives the
  // three classic flags being off.
  if ('voiceIsolation' in (navigator.mediaDevices.getSupportedConstraints?.() || {})) {
    audio.voiceIsolation = dsp;
  }
  if (deviceId) audio.deviceId = { exact: deviceId };

  try {
    return await navigator.mediaDevices.getUserMedia({ audio, video: false });
  } catch (err) {
    // A pinned device that has since been unplugged fails as OverconstrainedError.
    if (deviceId && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError')) {
      return getMic({ dsp });
    }
    throw err;
  }
}

export const CAM_RES = {
  native: { label: 'Native (uncapped)', w: 7680, h: 4320 },
  '720': { label: '720p', w: 1280, h: 720 },
  '1080': { label: '1080p', w: 1920, h: 1080 },
  '1440': { label: '1440p', w: 2560, h: 1440 },
  '2160': { label: '4K', w: 3840, h: 2160 },
  '4320': { label: '8K', w: 7680, h: 4320 },
};

export const CAM_FPS = [30, 60, 120, 240];

/* Same principle as the screen: ask for the ceiling as an ideal and let the
   webcam hand back whatever it actually has.

   Resolution and frame rate genuinely fight each other here, which is not
   obvious and costs real picture quality. A webcam exposes a fixed list of
   modes, and a camera that can do 4K30 and 1080p60 has no 4K60 to give you —
   ask for 60 as an *ideal* and the driver satisfies it by handing back the
   smaller mode. So "resolution" asks for the frame rate only as a ceiling and
   lets the sensor pick its best mode underneath, while "framerate" demands the
   rate and accepts whatever size comes with it. */
export async function getCam({ deviceId, res = 'native', fps = 60, hint = 'detail', prefer = 'resolution' } = {}) {
  const size = CAM_RES[res] || CAM_RES.native;
  const video = {
    width: { ideal: size.w },
    height: { ideal: size.h },
    frameRate: prefer === 'framerate' ? { ideal: fps, max: fps } : { max: fps },
  };
  if (deviceId) video.deviceId = { exact: deviceId };

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video });
    const track = stream.getVideoTracks()[0];
    /* 'motion' tells the encoder it may trade spatial detail away to hold the
       frame rate, which is precisely how a face ends up soft. Detail is the
       right default for someone who asked for the highest quality available. */
    if (track) track.contentHint = hint === 'motion' ? 'motion' : 'detail';
    return stream;
  } catch (err) {
    if (deviceId && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError')) {
      return getCam({ res, fps, hint, prefer });
    }
    throw err;
  }
}

/* Asking for more than the source has costs nothing — a constraint expressed
   as an ideal is a request, not a demand, so a 1440p panel simply hands back
   1440p. Which means the honest default is to ask for the ceiling and take
   whatever the display actually is. */
export const SCREEN_RES = {
  native: { label: 'Native (uncapped)', w: 15360, h: 8640 },
  '1080': { label: '1080p', w: 1920, h: 1080 },
  '1440': { label: '1440p', w: 2560, h: 1440 },
  '2160': { label: '4K', w: 3840, h: 2160 },
  '4320': { label: '8K', w: 7680, h: 4320 },
  '8640': { label: '16K', w: 15360, h: 8640 },
};

export const SCREEN_FPS = [30, 60, 120, 144, 240, 360];

/* ── screen ──

   Nothing is downscaled and nothing is capped. systemAudio include is what
   lets a shared game or video bring its sound with it. */
export async function getScreen({ fps = 60, hint = 'detail', res = 'native' } = {}) {
  const size = SCREEN_RES[res] || SCREEN_RES.native;
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      frameRate: { ideal: fps, max: fps },
      width: { ideal: size.w },
      height: { ideal: size.h },
      displaySurface: 'monitor',
    },
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: { ideal: 2 },
      sampleRate: { ideal: 48000 },
    },
    systemAudio: 'include',
    surfaceSwitching: 'include',
    selfBrowserSurface: 'exclude',
  });

  const track = stream.getVideoTracks()[0];
  if (track) {
    // The hint reaches the encoder's rate control. detail spends bits on
    // sharp edges and holds still frames crisp; motion does the opposite.
    track.contentHint = hint === 'motion' ? 'motion' : 'detail';
  }
  return stream;
}

export function describeTrack(track) {
  if (!track) return null;
  const s = track.getSettings?.() || {};
  return {
    width: s.width || null,
    height: s.height || null,
    frameRate: s.frameRate ? Math.round(s.frameRate) : null,
    channels: s.channelCount || null,
    sampleRate: s.sampleRate || null,
  };
}

export async function listDevices() {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    return {
      mics: all.filter((d) => d.kind === 'audioinput'),
      cams: all.filter((d) => d.kind === 'videoinput'),
    };
  } catch {
    return { mics: [], cams: [] };
  }
}

export function stopStream(stream) {
  stream?.getTracks().forEach((t) => t.stop());
}

/* Chrome fires this when the user hits the browser's own "Stop sharing" bar
   rather than ours, which is the way most people end a share. */
export function onShareEnded(stream, fn) {
  const track = stream?.getVideoTracks()[0];
  if (track) track.addEventListener('ended', fn, { once: true });
}
