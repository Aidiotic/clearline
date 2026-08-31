/* Wiring. Preferences in, room out, and the render loop that keeps the page
   agreeing with the call. */

import { bind, el, showView, setState, setStatus, announce, setLevel, fail, renderQR, Stage } from './ui.js';
import { Room } from './room.js';
import { SLOT, getMic, getCam, getScreen, listDevices, stopStream, onShareEnded, describeTrack } from './media.js';
import { ensureContext, meterForStream, contextRate, tierBitrate, tierLabel, TIERS, FORMATS,
         DEFAULT_TIER, TIER_ORDER, tierForRoom, stepDown, tierBytesPerSecond } from './pcm.js';
import { presetLabel } from './remaster.js';
import { newCode, normaliseCode, isCode, formatCode, bitrate, safeName } from './util.js';

const PREFS_KEY = 'clearline-prefs';

// Loss above this is not jitter, it is the link refusing to carry the rate.
const LOSS_TRIGGER = 0.05;

// Stands in for "no ceiling". High enough that no encoder reaches it, present
// so the rate controller does not fall back to a conservative default.
const UNCAPPED_BPS = 200e6;

const DEFAULTS = {
  audio: 'pcm',
  tier: DEFAULT_TIER,
  // The tier above is a ceiling, not a promise. What actually goes out is the
  // best setting that fits this much total upstream across the whole mesh.
  budget: 25,
  autoQuality: true,
  remaster: '',
  dsp: false,
  screenRes: 'native',
  screenBitrate: 60,
  screenFps: 60,
  screenHint: 'detail',
  screenCodec: 'auto',
  camRes: 'native',
  camFps: 60,
  camBitrate: 0,
  camHint: 'detail',
  camCodec: 'auto',
  camPrefer: 'resolution',
  micDevice: '',
  camDevice: '',
  name: '',
  theme: 'system',
};

let prefs = load();
let room = null;
let stage = null;
let profile = null;

const local = { mic: null, cam: null, screen: null, meter: null };
const peers = new Map();   // peerId -> { streams: {}, meter }
let muted = false;
let statsTimer = null;
let startedAt = 0;

/* Effective quality, as opposed to the ceiling in prefs. Two things push it
   down: the arithmetic of the room size against the budget, and peers telling
   us they are actually losing what we send. */
const quality = { tier: DEFAULT_TIER, floor: null, cleanTicks: 0, lossyTicks: 0 };

/* ── preferences ── */

function load() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

function save() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* private mode */ }
}

/* The profile is the whole quality argument in one object. Everything that
   ends up in an SDP or a setParameters call is derived here, so there is one
   place to look when a call does not sound or look the way it should. */
function buildProfile() {
  const voice = prefs.audio === 'voice';
  // "No ceiling" still needs a number in the SDP — the b= line and the
  // x-google-* keys are what lift the encoder's own internal cap, and leaving
  // them out means the cap stays where the browser put it. So it becomes a
  // figure nothing will reach rather than an absent one.
  const UNCAPPED_KBPS = 200000;
  const screenKbps = prefs.screenBitrate ? prefs.screenBitrate * 1000 : UNCAPPED_KBPS;
  const camKbps = prefs.camBitrate ? prefs.camBitrate * 1000 : UNCAPPED_KBPS;

  return {
    opus: {
      // Voice mode is the only one that asks the encoder to save anything.
      bitrate: voice ? 64000 : 510000,
      stereo: !voice,
      fec: true,
      dtx: voice,
      ptime: 20,
    },
    video: {
      // One ceiling covers every video m-section; the per-sender limits below
      // are what actually separate a camera from a screen.
      maxKbps: Math.max(screenKbps, camKbps),
      startKbps: Math.min(screenKbps, 20000),
    },
    /* "No ceiling" sets a number nothing will reach rather than leaving
       maxBitrate unset. Absent is not the same as unlimited: with no explicit
       maximum the rate controller falls back to its own conservative default
       for the stream type, which for a camera is well under a megabit and is
       exactly what a soft, blocky picture looks like. */
    screenBitrate: prefs.screenBitrate ? prefs.screenBitrate * 1e6 : UNCAPPED_BPS,
    screenFps: Number(prefs.screenFps),
    screenHint: prefs.screenHint,
    screenCodec: prefs.screenCodec,
    camBitrate: prefs.camBitrate ? prefs.camBitrate * 1e6 : UNCAPPED_BPS,
    camFps: Number(prefs.camFps),
    camHint: prefs.camHint,
    camCodec: prefs.camCodec,
    tier: prefs.tier,
    // What the send gate measures its queue against, so the allowance stays a
    // fixed number of milliseconds rather than a fixed number of bytes.
    pcmBytesPerSecond: tierBytesPerSecond(quality.tier || prefs.tier),
    // A higher sample rate means each packet covers the same 10 ms, so the
    // buffer target in milliseconds holds regardless of tier.
    jitterMs: 40,
  };
}

function config() {
  const custom = window.CLEARLINE_CONFIG || {};
  return {
    iceServers: custom.iceServers || [
      { urls: ['stun:stun.l.google.com:19302', 'stun:global.stun.twilio.com:3478'] },
    ],
    peerServer: custom.peerServer || null,
  };
}

/* ── start ── */

bind();
applyTheme();
stage = new Stage(el.stage, { onPin: (key) => stage.pin(key) });
wireControls();
wireSettings();
route();

/* A link can arrive at a tab that is already open — clicked out of a chat
   window that reuses the tab, or pasted into the bar of a page sitting on the
   lobby. Reading the hash once at startup misses both. */
window.addEventListener('hashchange', () => {
  if (!room) route();
});

function route() {
  // Checked before anything else, so a site taken out of service cannot be
  // talked into opening a room by arriving with a code in the URL.
  const cfg = window.CLEARLINE_CONFIG || {};
  if (cfg.disabled) {
    fail(cfg.notice || 'clearline is temporarily out of service.');
    el.errorReset.hidden = true;
    return;
  }

  const code = normaliseCode(location.hash);
  if (isCode(code)) {
    el.joinCode.value = formatCode(code);
    el.actJoin.textContent = `Join ${formatCode(code)}`;
    el.actJoin.classList.add('act-strong');
    el.actCreate.classList.remove('act-strong');
    setStatus('You were sent a room.');
  }
  setState('idle');
  showView('viewStart');
}

/* ── controls ── */

function wireControls() {
  el.actCreate.addEventListener('click', () => create());
  el.joinForm.addEventListener('submit', (e) => { e.preventDefault(); join(el.joinCode.value); });

  el.joinCode.addEventListener('input', () => {
    // Reformat as they type so the grouping is never half-applied.
    const code = normaliseCode(el.joinCode.value);
    el.joinCode.value = formatCode(code);
  });

  el.copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(el.shareLink.value);
      el.copyBtn.textContent = 'Copied';
      setTimeout(() => { el.copyBtn.textContent = 'Copy link'; }, 1600);
    } catch {
      el.shareLink.select();
    }
  });

  if (navigator.share) {
    el.shareBtn.hidden = false;
    el.shareBtn.addEventListener('click', () => {
      navigator.share({ title: 'clearline', url: el.shareLink.value }).catch(() => { /* dismissed */ });
    });
  }

  el.enterBtn.addEventListener('click', () => enterRoom());
  el.btnMic.addEventListener('click', () => toggleMic());
  el.btnCam.addEventListener('click', () => toggleCam());
  el.btnScreen.addEventListener('click', () => toggleScreen());
  el.btnInvite.addEventListener('click', () => showInvite());
  el.btnSettings.addEventListener('click', () => el.settings.showModal());
  el.btnLeave.addEventListener('click', () => leave());
  el.errorReset.addEventListener('click', () => { location.hash = ''; location.reload(); });
}

async function create() {
  const code = newCode();
  location.hash = code;
  await open(code, true);
}

async function join(input) {
  const code = normaliseCode(input);
  if (!isCode(code)) { setStatus('That code is not nine letters long.'); return; }
  location.hash = code;
  await open(code, false);
}

async function open(code, asHost) {
  if ((window.CLEARLINE_CONFIG || {}).disabled) return;
  setState('connecting');
  setStatus(asHost ? 'Opening a room…' : 'Looking for the room…');
  el.actCreate.disabled = true;
  el.actJoin.disabled = true;

  profile = buildProfile();

  room = new Room({
    code,
    profile,
    config: config(),
    on: {
      track: onTrack,
      trackMuted: onTrackMuted,
      roster: onRoster,
      left: (id) => { peers.get(id)?.meter?.close(); peers.delete(id); stage.removeOwner(id); },
      linkState: onLinkState,
      gone: (msg) => fail(msg || 'Nobody is hosting that room. Codes only live while someone is inside.'),
      dropped: (id, reason) => console.warn('[clearline] link dropped', id, reason),
      error: (err) => console.warn('[clearline]', err?.name || '', err?.message || err),
    },
  });

  try {
    await room.start({ asHost });
  } catch (err) {
    fail(err.message || 'Could not reach the signalling service.');
    return;
  }

  room.setName(prefs.name);
  showInvite();

  if (asHost) {
    setState('waiting');
    setStatus('Room is open. Waiting for someone.');
  } else {
    // A joiner has no reason to look at an invite screen — they came from one.
    await enterRoom();
  }
}

function showInvite() {
  const url = `${location.origin}${location.pathname}#${room.code}`;
  el.shareLink.value = url;
  el.codeDisplay.textContent = formatCode(room.code);
  renderQR(url);
  if (document.body.classList.contains('in-room')) {
    // Already inside: the sheet is the wrong metaphor, so just copy it.
    navigator.clipboard?.writeText(url).then(
      () => setStatus('Link copied.'),
      () => setStatus(`Code ${formatCode(room.code)}`),
    );
    return;
  }
  showView('viewInvite');
}

/* ── entering ── */

async function enterRoom() {
  showView('viewRoom');
  setState('connecting');
  setStatus('Getting your microphone…');

  // Opened on the click that got us here, which is the gesture the browser
  // wants before it will start an audio graph.
  await ensureContext(prefs.audio === 'pcm' ? TIERS[prefs.tier].rate : 48000);

  try {
    local.mic = await getMic({ deviceId: prefs.micDevice, dsp: dspWanted() });
  } catch (err) {
    // A call you can only listen to is still a call.
    setStatus(err.name === 'NotAllowedError'
      ? 'No microphone — you can still hear everyone.'
      : 'No microphone found — listening only.');
  }

  if (local.mic) {
    local.meter = meterForStream(local.mic);
    await applyAudioMode();
    setMicButton(true);
  } else {
    setMicButton(false);
  }

  await refreshDevices();
  setState('live');
  startedAt = Date.now();
  updateStage();
  loop();
  if (!statsTimer) statsTimer = setInterval(updateStats, 1000);
  announce('You are in the room.');
}

function dspWanted() {
  return prefs.audio === 'voice' ? true : prefs.dsp;
}

async function applyAudioMode() {
  if (!local.mic || !room) return;

  // The setting is a ceiling; what goes out is whatever also fits the room.
  const budget = prefs.autoQuality && prefs.budget ? prefs.budget * 1e6 : 0;
  quality.tier = tierForRoom(room.links.size, budget, prefs.tier);
  if (quality.floor && TIER_ORDER.indexOf(quality.floor) > TIER_ORDER.indexOf(quality.tier)) {
    quality.tier = quality.floor;
  }
  profile.pcmBytesPerSecond = tierBytesPerSecond(quality.tier);

  await room.configureAudio({
    mode: prefs.audio === 'pcm' ? 'pcm' : 'opus',
    tier: quality.tier,
    remaster: prefs.remaster || null,
    stream: local.mic,
  });
  room.setMuted(muted);

  /* Asking for 192 kHz and getting 48 is not a failure, but it does mean the
     tier's name is now a lie, and saying nothing would be the dishonest part.
     The samples are still uncompressed either way. */
  if (prefs.audio === 'pcm') {
    const asked = TIERS[quality.tier].rate;
    const got = contextRate();
    if (got && got !== asked) {
      setStatus(`Asked for ${(asked / 1000).toFixed(0)} kHz, this machine runs at ${(got / 1000).toFixed(1)} kHz.`);
    }
  }
  updateQualityNote();
}

/* ── adapting to the room ──

   Two things force the quality down from the ceiling the user picked. The
   first is arithmetic and is known in advance: a mesh sends everything once
   per other person, so the room's size decides what fits in the upstream
   budget. The second is evidence — peers reporting that what we send is not
   arriving — which catches every case where the budget was optimistic. */

async function adaptQuality() {
  if (!room || room.closed || prefs.audio !== 'pcm') return;

  const budget = prefs.autoQuality && prefs.budget ? prefs.budget * 1e6 : 0;
  let want = tierForRoom(room.links.size, budget, prefs.tier);

  // A floor set by observed loss outranks the calculation that failed to
  // predict it.
  if (quality.floor && TIER_ORDER.indexOf(quality.floor) > TIER_ORDER.indexOf(want)) {
    want = quality.floor;
  }
  if (want === quality.tier) return;

  quality.tier = want;
  profile.pcmBytesPerSecond = tierBytesPerSecond(want);
  await room.configureAudio({ tier: want });
  updateQualityNote();
  updateStats();
}

/* Loss is measured over the last interval, not since the call began — a burst
   while the connection was still settling should not hold the quality down
   for the rest of the hour. */
function reportLossUpstream() {
  if (!room) return;
  for (const [peerId, rx] of room.pcmIn) {
    const rec = peerRecord(peerId);
    const prev = rec.lossMark || { lost: 0, played: 0 };
    const lost = rx.stats.lost - prev.lost;
    const played = rx.stats.played - prev.played;
    rec.lossMark = { lost: rx.stats.lost, played: rx.stats.played };

    const total = lost + played;
    if (total <= 0) continue;
    const ratio = lost / total;
    rec.recentLoss = ratio;
    // Only worth a message when it is bad enough to act on.
    if (ratio > LOSS_TRIGGER) room.links.get(peerId)?.send({ t: 'quality', loss: ratio });
  }
}

function respondToReportedLoss() {
  if (!room || prefs.audio !== 'pcm') return;
  let worst = 0;
  for (const link of room.links.values()) {
    worst = Math.max(worst, link.reportedLoss || 0);
    link.reportedLoss = 0;
  }

  if (worst > LOSS_TRIGGER) {
    quality.cleanTicks = 0;
    quality.lossyTicks++;
    // Two consecutive bad seconds, so one hiccup does not cost a step.
    if (quality.lossyTicks >= 2) {
      quality.lossyTicks = 0;
      const floor = stepDown(quality.floor || quality.tier);
      if (floor !== quality.floor) {
        quality.floor = floor;
        setStatus(`Stepping audio down — ${Math.round(worst * 100)}% of it was not arriving.`);
        adaptQuality();
      }
    }
    return;
  }

  quality.lossyTicks = 0;
  // A clean minute earns one step back, which is slow enough not to oscillate.
  if (quality.floor && ++quality.cleanTicks >= 60) {
    quality.cleanTicks = 0;
    const i = TIER_ORDER.indexOf(quality.floor);
    quality.floor = i <= 0 ? null : TIER_ORDER[i - 1];
    adaptQuality();
  }
}

/* ── toggles ── */

async function toggleMic() {
  if (!local.mic) {
    try {
      local.mic = await getMic({ deviceId: prefs.micDevice, dsp: dspWanted() });
      local.meter = meterForStream(local.mic);
      await applyAudioMode();
      muted = false;
      setMicButton(true);
    } catch {
      setStatus('Could not open the microphone.');
    }
    return;
  }
  muted = !muted;
  room.setMuted(muted);
  room.announce();
  setMicButton(!muted);
  updateStage();
}

function setMicButton(on) {
  el.btnMic.setAttribute('aria-pressed', String(!!on));
  el.btnMic.textContent = on ? 'Mic' : 'Muted';
}

async function toggleCam() {
  if (local.cam) {
    stopStream(local.cam);
    local.cam = null;
    await room.setTrack(SLOT.CAM, null);
    stage.remove('self', 'cam');
    el.btnCam.setAttribute('aria-pressed', 'false');
  } else {
    try {
      local.cam = await getCam({
        deviceId: prefs.camDevice,
        res: prefs.camRes,
        fps: Number(prefs.camFps),
        hint: prefs.camHint,
        prefer: prefs.camPrefer,
      });
      await room.setTrack(SLOT.CAM, local.cam.getVideoTracks()[0]);
      el.btnCam.setAttribute('aria-pressed', 'true');
      const s = describeTrack(local.cam.getVideoTracks()[0]);
      if (s?.width) setStatus(`Camera at ${s.width}×${s.height}, ${s.frameRate} fps.`);
    } catch {
      setStatus('Could not open the camera.');
      return;
    }
  }
  updateStage();
}

async function toggleScreen() {
  if (local.screen) {
    await stopScreen();
    return;
  }
  try {
    local.screen = await getScreen({
      fps: Number(prefs.screenFps),
      hint: prefs.screenHint,
      res: prefs.screenRes,
    });
  } catch {
    return;   // the picker was dismissed; nothing to report
  }

  await room.setTrack(SLOT.SCREEN, local.screen.getVideoTracks()[0]);
  const sysAudio = local.screen.getAudioTracks()[0];
  if (sysAudio) await room.setTrack(SLOT.SCREEN_AUDIO, sysAudio);

  // The browser's own stop-sharing bar is how most shares end.
  onShareEnded(local.screen, () => stopScreen());

  el.btnScreen.setAttribute('aria-pressed', 'true');
  updateStage();
  stage.pin(stage.key('self', 'screen'));

  const s = describeTrack(local.screen.getVideoTracks()[0]);
  if (s?.width) setStatus(`Sharing ${s.width}×${s.height} at ${s.frameRate} fps.`);
}

async function stopScreen() {
  if (!local.screen) return;
  stopStream(local.screen);
  local.screen = null;
  await room.setTrack(SLOT.SCREEN, null);
  await room.setTrack(SLOT.SCREEN_AUDIO, null);
  stage.remove('self', 'screen');
  el.btnScreen.setAttribute('aria-pressed', 'false');
  updateStage();
}

function leave() {
  room?.close();
  location.hash = '';
  location.reload();
}

/* ── incoming ── */

function peerRecord(id) {
  if (!peers.has(id)) peers.set(id, { streams: {}, meter: null });
  return peers.get(id);
}

function onTrack(peerId, slot, track, stream) {
  const rec = peerRecord(peerId);
  rec.streams[slot] = stream;

  if (slot === SLOT.MIC || slot === SLOT.SCREEN_AUDIO) {
    stage.attachAudio(peerId, track);
    if (slot === SLOT.MIC && !rec.meter) rec.meter = meterForStream(stream);
  }
  updateStage();
}

function onTrackMuted(peerId, slot, isMuted) {
  const rec = peerRecord(peerId);
  rec[`muted${slot}`] = isMuted;
  updateStage();
}

function onRoster() {
  updateStage();
  updateStats();
  // Someone arriving or leaving changes what the mesh costs everyone.
  adaptQuality();
}

function onLinkState(peerId, state) {
  if (state === 'connected') {
    setState('live');
    setStatus('');
  } else if (state === 'connecting') {
    setStatus('Connecting…');
  } else if (state === 'failed') {
    setStatus('A connection failed. Some networks need a relay.');
  }
}

/* ── rendering ── */

function labelFor(entry) {
  return entry.name || 'Someone';
}

// What the far end is actually sending, in the fewest characters that still
// say it: "24/192" is a claim you can check, "HD" is not.
function badgeFor(entry) {
  if (entry.mode !== 'pcm') return null;
  const tier = TIERS[entry.tier];
  if (!tier) return 'lossless';
  return `${FORMATS[tier.format].bits}/${tier.rate / 1000}`;
}

function updateStage() {
  if (!room) return;

  // Self
  if (local.cam) {
    stage.upsert('self', 'cam', {
      stream: local.cam,
      label: prefs.name ? `${prefs.name} (you)` : 'You',
      self: true,
      muted,
    });
  } else if (!local.screen) {
    stage.upsert('self', 'audio', {
      label: prefs.name ? `${prefs.name} (you)` : 'You',
      self: true,
      muted,
    });
  } else {
    stage.remove('self', 'audio');
  }

  if (local.screen) {
    stage.upsert('self', 'screen', {
      stream: local.screen,
      label: 'Your screen',
      badge: 'sharing',
      self: true,
    });
  }

  // Everyone else
  const roster = room.describe();
  for (const entry of roster) {
    const rec = peerRecord(entry.id);
    const label = labelFor(entry);
    const badge = badgeFor(entry);

    const camStream = rec.streams[SLOT.CAM];
    const showCam = entry.cam && camStream && !rec[`muted${SLOT.CAM}`];
    if (showCam) {
      stage.upsert(entry.id, 'cam', { stream: camStream, label, badge, muted: !entry.mic });
      stage.remove(entry.id, 'audio');
    } else {
      stage.remove(entry.id, 'cam');
      if (!entry.screen) {
        stage.upsert(entry.id, 'audio', { label, badge, muted: !entry.mic });
      } else {
        stage.remove(entry.id, 'audio');
      }
    }

    const screenStream = rec.streams[SLOT.SCREEN];
    const showScreen = entry.screen && screenStream && !rec[`muted${SLOT.SCREEN}`];
    if (showScreen) {
      const key = stage.key(entry.id, 'screen');
      const isNew = !stage.tiles.has(key);
      stage.upsert(entry.id, 'screen', { stream: screenStream, label: `${label}'s screen`, badge: 'sharing' });
      // A share that has just started is almost always the thing to look at.
      if (isNew) stage.pin(key);
    } else {
      stage.remove(entry.id, 'screen');
    }
  }
}

function loop() {
  if (!room || room.closed) return;
  const own = muted ? 0 : (room.audio.level || local.meter?.read() || 0);
  setLevel(own);
  stage.level('self', local.cam ? 'cam' : 'audio', own);

  for (const entry of room.describe()) {
    const rec = peers.get(entry.id);
    const level = room.levelFor(entry.id) || rec?.meter?.read() || 0;
    stage.level(entry.id, 'cam', level);
    stage.level(entry.id, 'audio', level);
  }
  requestAnimationFrame(loop);
}

async function updateStats() {
  if (!room || room.closed) return;
  reportLossUpstream();
  respondToReportedLoss();

  const s = await room.sampleStats();
  const bits = [];
  bits.push(`${s.peers + 1} ${s.peers === 0 ? 'person' : 'people'}`);
  if (s.send) bits.push(`${bitrate(s.send)} up`);
  if (s.recv) bits.push(`${bitrate(s.recv)} down`);
  if (s.rtt) bits.push(`${Math.round(s.rtt)} ms`);
  if (s.loss > 0.005) bits.push(`${(s.loss * 100).toFixed(1)}% loss`);
  bits.push(audioLabel());
  el.dockMeta.textContent = bits.join(' · ');
}

function audioLabel() {
  const chain = prefs.remaster ? ` · remastered (${presetLabel(prefs.remaster)})` : '';
  if (prefs.audio === 'pcm') {
    // Say when the room forced it below what was asked for, rather than
    // reporting the setting and letting it look like nothing happened.
    const stepped = quality.tier !== prefs.tier ? ' (room)' : '';
    return tierLabel(quality.tier) + stepped + chain;
  }
  if (prefs.audio === 'voice') return 'Voice · 64 kbps' + chain;
  return 'Opus · 510 kbps stereo' + chain;
}

function audioBitrate() {
  if (prefs.audio === 'pcm') return tierBitrate(quality.tier);
  return prefs.audio === 'voice' ? 64000 : 510000;
}

function updateQualityNote() {
  el.qualityNote.textContent = `${audioLabel()} · ${bitrate(audioBitrate())} per person`;

  el.audioNote.textContent = prefs.audio === 'pcm'
    ? 'Raw samples down their own data channel. No encoder anywhere in the path — not lossless compression, no compression.'
    : prefs.audio === 'voice'
      ? 'Mono, gated and cheap. For a bad connection or a phone on data.'
      : 'Opus at the top of its range, stereo, full band. Transparent in listening tests, and a fraction of the bandwidth of lossless.';

  /* The number that matters is not the tier's own bitrate but that bitrate
     times the number of other people, because a mesh sends it once each. That
     multiplication is what a room of eight ran into. */
  const links = Math.max(1, room ? room.links.size : 1);
  const each = tierBitrate(prefs.tier);
  const tier = TIERS[prefs.tier];
  el.tierNote.textContent =
    `${bitrate(each)} each way per person — ${bitrate(each * links)} upstream ` +
    `with ${links === 1 ? 'one other person' : `${links} others`} in the room, because a mesh sends it once each. ` +
    (tier.rate > 48000
      ? 'Above 48 kHz needs an interface that actually captures at that rate; anything else is upsampling.'
      : 'Every machine can do this rate natively.');
}

/* ── settings ── */

function wireSettings() {
  el.sheetClose.addEventListener('click', () => el.settings.close());
  el.settings.addEventListener('close', () => save());

  el.prefAudio.addEventListener('change', async (e) => {
    prefs.audio = e.target.value;
    save();
    syncSettings();
    if (room) {
      // Voice mode forces processing back on, which means a new capture.
      await recaptureMic();
      Object.assign(profile, buildProfile());
      await applyAudioMode();
      // Switching between lossless and Opus changes whether the microphone
      // transceiver carries anything, which the far end has to be told about.
      for (const link of room.links.values()) if (link.initiator) await link.negotiate();
    }
    updateQualityNote();
  });

  el.prefTier.addEventListener('change', async (e) => {
    prefs.tier = e.target.value;
    save();
    Object.assign(profile, buildProfile());
    await applyAudioMode();
    updateQualityNote();
  });

  el.prefBudget.addEventListener('change', async (e) => {
    prefs.budget = Number(e.target.value);
    save();
    await adaptQuality();
    updateQualityNote();
  });

  el.prefAutoQuality.addEventListener('change', async (e) => {
    prefs.autoQuality = e.target.checked;
    save();
    syncSettings();
    await adaptQuality();
    updateQualityNote();
  });

  el.prefRemaster.addEventListener('change', async (e) => {
    prefs.remaster = e.target.value;
    save();
    await applyAudioMode();
    updateQualityNote();
  });

  el.prefDsp.addEventListener('change', async (e) => {
    prefs.dsp = e.target.checked;
    save();
    await recaptureMic();
  });

  el.prefScreenBitrate.addEventListener('change', (e) => { prefs.screenBitrate = Number(e.target.value); save(); reprofile(); });
  el.prefScreenRes.addEventListener('change', async (e) => {
    prefs.screenRes = e.target.value;
    save();
    // A resolution constraint is fixed when the capture starts, so a running
    // share has to be taken and re-taken to honour it.
    if (local.screen) { await stopScreen(); await toggleScreen(); }
  });
  el.prefScreenFps.addEventListener('change', async (e) => {
    prefs.screenFps = Number(e.target.value);
    save();
    reprofile();
    if (local.screen) { await stopScreen(); await toggleScreen(); }
  });
  el.prefScreenCodec.addEventListener('change', (e) => { prefs.screenCodec = e.target.value; save(); reprofile(true); });

  el.prefScreenHint.addEventListener('change', (e) => {
    prefs.screenHint = e.target.value;
    save();
    const track = local.screen?.getVideoTracks()[0];
    if (track) track.contentHint = prefs.screenHint === 'motion' ? 'motion' : 'detail';
    reprofile();
  });

  el.prefCamBitrate.addEventListener('change', (e) => { prefs.camBitrate = Number(e.target.value); save(); reprofile(); });

  el.prefCamCodec.addEventListener('change', (e) => { prefs.camCodec = e.target.value; save(); reprofile(true); });

  // Resolution, frame rate, the detail hint and the resolution/rate trade are
  // all capture constraints, so a running camera has to be reopened for any of
  // them to mean anything.
  for (const [node, key, cast] of [
    [el.prefCamRes, 'camRes', String], [el.prefCamFps, 'camFps', Number],
    [el.prefCamHint, 'camHint', String], [el.prefCamPrefer, 'camPrefer', String],
  ]) {
    node.addEventListener('change', async (e) => {
      prefs[key] = cast(e.target.value);
      save();
      Object.assign(profile, buildProfile());
      if (local.cam) { await toggleCam(); await toggleCam(); }
    });
  }

  el.prefMicDevice.addEventListener('change', async (e) => {
    prefs.micDevice = e.target.value;
    save();
    await recaptureMic();
  });

  el.prefCamDevice.addEventListener('change', async (e) => {
    prefs.camDevice = e.target.value;
    save();
    if (local.cam) { await toggleCam(); await toggleCam(); }
  });

  el.prefName.addEventListener('input', (e) => {
    prefs.name = safeName(e.target.value);
    room?.setName(prefs.name);
    updateStage();
  });

  el.prefTheme.addEventListener('change', (e) => {
    prefs.theme = e.target.value;
    save();
    applyTheme();
  });

  syncSettings();
  updateQualityNote();
}

// Changing bitrates or frame rates only needs setParameters; changing the
// codec is a property of the SDP and has to go round again.
async function reprofile(renegotiate = false) {
  if (!room) return;
  Object.assign(profile, buildProfile());
  for (const link of room.links.values()) {
    await link.reapplyEncodings();
    if (renegotiate && link.initiator) { link.applyCodecPreferences(); await link.negotiate(); }
    else if (renegotiate) link.send({ t: 'renegotiate' });
  }
}

async function recaptureMic() {
  if (!local.mic || !room) return;
  const wasMuted = muted;
  stopStream(local.mic);
  local.meter?.close();
  try {
    local.mic = await getMic({ deviceId: prefs.micDevice, dsp: dspWanted() });
  } catch {
    local.mic = null;
    setMicButton(false);
    return;
  }
  local.meter = meterForStream(local.mic);
  await applyAudioMode();
  muted = wasMuted;
  room.setMuted(muted);
}

async function refreshDevices() {
  const { mics, cams } = await listDevices();
  fillDevices(el.prefMicDevice, mics, prefs.micDevice, 'Default microphone');
  fillDevices(el.prefCamDevice, cams, prefs.camDevice, 'Default camera');
}

function fillDevices(select, devices, chosen, fallback) {
  select.innerHTML = '';
  const auto = new Option(fallback, '');
  select.append(auto);
  devices.forEach((d, i) => select.append(new Option(d.label || `${fallback} ${i + 1}`, d.deviceId)));
  select.value = devices.some((d) => d.deviceId === chosen) ? chosen : '';
}

function syncSettings() {
  for (const input of el.prefAudio.querySelectorAll('input')) input.checked = input.value === prefs.audio;
  for (const input of el.prefRemaster.querySelectorAll('input')) input.checked = input.value === prefs.remaster;
  for (const input of el.prefTheme.querySelectorAll('input')) input.checked = input.value === prefs.theme;

  el.prefTier.value = prefs.tier;
  el.prefBudget.value = String(prefs.budget);
  el.prefAutoQuality.checked = prefs.autoQuality;
  el.prefBudget.disabled = !prefs.autoQuality;
  el.pcmOpts.hidden = prefs.audio !== 'pcm';
  el.budgetOpts.hidden = prefs.audio !== 'pcm';
  el.prefDsp.checked = dspWanted();
  el.prefDsp.disabled = prefs.audio === 'voice';

  el.prefScreenRes.value = prefs.screenRes;
  el.prefScreenBitrate.value = String(prefs.screenBitrate);
  el.prefScreenFps.value = String(prefs.screenFps);
  el.prefScreenHint.value = prefs.screenHint;
  el.prefScreenCodec.value = prefs.screenCodec;
  el.prefCamRes.value = String(prefs.camRes);
  el.prefCamFps.value = String(prefs.camFps);
  el.prefCamBitrate.value = String(prefs.camBitrate);
  el.prefCamHint.value = prefs.camHint;
  el.prefCamPrefer.value = prefs.camPrefer;
  el.prefCamCodec.value = prefs.camCodec;
  el.prefName.value = prefs.name;
}

function applyTheme() {
  const root = document.documentElement;
  if (prefs.theme === 'system') root.removeAttribute('data-theme');
  else root.dataset.theme = prefs.theme;
}

// Leaving without a word makes everyone else wait on an ICE timeout.
window.addEventListener('pagehide', () => room?.close());

// A handle on the live call, for reading negotiated SDP and jitter-buffer
// counters while working on it. Local only — it is not a supported interface.
if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
  window.clearline = {
    get room() { return room; },
    get profile() { return profile; },
    local, peers, prefs,
  };
}
