/* One link = one other person.

   PeerJS is used only as a signalling courier: its DataConnection carries the
   offers, answers, candidates and small control messages, and nothing else.
   The connection that carries media is a plain RTCPeerConnection this file
   owns outright — which is the whole reason for the split. PeerJS's own media
   API gives you no say over the SDP, and the SDP is where the quality is.

   Each side creates the four transceivers it sends on — microphone, camera,
   screen, screen audio — and only those. They are send-only, made up front,
   and never removed, so a slot that is not in use just sits there with a null
   track costing nothing.

   Both sides doing this, rather than one side making all eight, is not
   symmetry for its own sake. A transceiver that a browser creates for you
   while applying a remote offer has an empty encodings list, and an encoding
   cannot be added afterwards — setParameters rejects it as a read-only field.
   So the peer that merely answered would have no way to set its own bitrate,
   frame rate, or degradation preference, and whoever happened to join second
   would quietly get worse screen sharing than the person who started the room.
   Owning what you send is the only way to control how you send it.

   Which m-line is which is then agreed explicitly: after each local
   description, a side publishes the mids it just had assigned, and the other
   maps mid to slot. Inferring it from transceiver order would work in Chrome
   and break elsewhere, because browsers differ on whether an unassociated
   transceiver gets reused by an incoming offer. */

import { tune, preferCodec, applyEncoding } from './sdp.js';
import { SLOT } from './media.js';
import { isPolite } from './util.js';

const SLOT_KINDS = ['audio', 'video', 'video', 'audio'];

// Reliable, ordered, and negotiated out of band so neither side waits on an
// ondatachannel event that PeerJS has historically been happy to intercept.
const PCM_CHANNEL_ID = 1;

// Comfortably under the signalling channel's per-message ceiling, with room
// for the part wrapper on top of the payload.
const MAX_PART = 8000;

// How much audio may sit queued for the wire before packets start being
// dropped instead. Roughly one jitter buffer's worth: past this the link is
// not keeping up and the backlog is pure added latency.
const PCM_QUEUE_MS = 60;

export class Link {
  constructor({ selfId, peerId, initiator, signal, config, profile, handlers }) {
    this.selfId = selfId;
    this.peerId = peerId;
    this.initiator = initiator;
    this.signal = signal;
    this.config = config;
    this.profile = profile;
    this.handlers = handlers;

    // Exactly one polite peer per pair, agreed without a round trip.
    this.polite = isPolite(selfId, peerId);

    this.pc = null;
    this.pcm = null;
    this.sendT = [];                 // my four, indexed by slot
    this.midToSlot = new Map();      // their mids -> slot
    this.orphanTracks = [];          // arrived before the mapping did
    this.remote = { name: '', mic: false, cam: false, screen: false, mode: 'opus', tier: null, remaster: null };
    this.closed = false;

    this.makingOffer = false;
    this.ignoreOffer = false;
    this.settingRemoteAnswer = false;
    this.answered = false;
    this.wantsNegotiation = false;
    this.pendingCandidates = [];
    this.outbox = [];
    this.inbox = new Map();
    this.partSeq = 0;
    this.chain = Promise.resolve();

    this.stats = { send: 0, recv: 0, rtt: 0, loss: 0 };
    this.pcmDropped = 0;
    this.reportedLoss = 0;
    this._lastStats = null;
  }

  async open() {
    const pc = new RTCPeerConnection({
      iceServers: this.config.iceServers,
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
      iceCandidatePoolSize: 4,
    });
    this.pc = pc;

    // Both ends open the same channel by id, so it exists from the moment the
    // SCTP transport does. Unreliable and unordered on purpose: a late audio
    // packet is worse than a missing one, and head-of-line blocking on a
    // realtime stream is the thing that makes it stutter.
    this.pcm = pc.createDataChannel('pcm', {
      ordered: false,
      maxRetransmits: 0,
      negotiated: true,
      id: PCM_CHANNEL_ID,
    });
    this.pcm.binaryType = 'arraybuffer';
    this.pcm.onmessage = (e) => this.handlers.onPcm?.(this, e.data);
    this.pcm.onopen = () => this.handlers.onPcmOpen?.(this);

    /* My four, and only mine. sendEncodings is what guarantees there is an
       encoding object to configure at all — without it the list can come back
       empty and every later setParameters is a no-op. */
    this.sendT = SLOT_KINDS.map((kind) => pc.addTransceiver(kind, {
      direction: 'sendonly',
      sendEncodings: [{ active: true }],
    }));
    this.applyCodecPreferences();

    /* Both sides now have something to publish, so both need a turn as the
       offerer. The dialling side goes first; the answering side waits until it
       has answered once, so the two openings cannot collide. After that,
       either may renegotiate at any time and perfect negotiation sorts it. */
    pc.onnegotiationneeded = () => {
      if (this.initiator || this.answered) this.negotiate();
      else this.wantsNegotiation = true;
    };

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.send({ t: 'ice', c: candidate.toJSON() });
    };

    pc.ontrack = (ev) => {
      const stream = ev.streams[0] || new MediaStream([ev.track]);
      const slot = this.midToSlot.get(ev.transceiver.mid);
      if (slot === undefined) {
        // The mapping is a separate message and can lose the race.
        this.orphanTracks.push({ mid: ev.transceiver.mid, track: ev.track, stream });
        return;
      }
      this.deliverTrack(slot, ev.track, stream);
    };

    pc.onconnectionstatechange = () => {
      this.handlers.onState?.(this, pc.connectionState);
      if (pc.connectionState === 'failed') this.restartIce();
    };

    return this;
  }

  deliverTrack(slot, track, stream) {
    this.handlers.onTrack?.(this, slot, track, stream);
    // replaceTrack(null) on the far side mutes rather than ends the track,
    // so this is how a stopped camera actually shows up here.
    track.addEventListener('mute', () => this.handlers.onTrackMuted?.(this, slot, true));
    track.addEventListener('unmute', () => this.handlers.onTrackMuted?.(this, slot, false));
  }

  // Codec choice is a property of the m-line you send on, so it only ever
  // applies to transceivers this side created.
  applyCodecPreferences() {
    if (this.sendT[SLOT.SCREEN]) preferCodec(this.sendT[SLOT.SCREEN], this.profile.screenCodec);
    if (this.sendT[SLOT.CAM]) preferCodec(this.sendT[SLOT.CAM], this.profile.camCodec);
  }

  /* Announced after every local description, because that is when mids get
     assigned — an answer names the transceivers the offer created, an offer
     names any new ones this side has added since. */
  publishSlots() {
    const mids = this.sendT.map((t) => t.mid);
    if (mids.every((m) => m === null || m === undefined)) return;
    this.send({ t: 'slots', mids });
  }

  onSlots(mids) {
    this.midToSlot.clear();
    (mids || []).forEach((mid, slot) => {
      if (mid !== null && mid !== undefined) this.midToSlot.set(mid, slot);
    });
    for (const orphan of this.orphanTracks.splice(0)) {
      const slot = this.midToSlot.get(orphan.mid);
      if (slot !== undefined) this.deliverTrack(slot, orphan.track, orphan.stream);
    }
  }

  /* ── negotiation ──
     Perfect negotiation, in full. Either side may need to renegotiate at any
     moment — someone starts a screen share mid-sentence — and without this the
     two offers collide and the connection wedges in have-local-offer. */

  /* Every call that touches the peer connection's description goes through
     here, one at a time. createOffer and setRemoteDescription are both
     multi-turn async operations, and letting an arriving offer interleave with
     an outgoing one leaves the connection in a state neither of them expected
     — in practice, a setLocalDescription that fails to start SCTP at all. */
  enqueue(fn) {
    this.chain = this.chain.then(fn).catch((err) => this.handlers.onError?.(this, err));
    return this.chain;
  }

  negotiate() {
    if (this.closed) return Promise.resolve();
    return this.enqueue(async () => {
      if (this.closed || this.pc.signalingState !== 'stable') return;
      this.makingOffer = true;
      try {
        const offer = await this.pc.createOffer();
        offer.sdp = tune(offer, this.profile).sdp;
        await this.pc.setLocalDescription(offer);
        this.send({ t: 'desc', desc: this.pc.localDescription });
        this.publishSlots();
      } finally {
        this.makingOffer = false;
      }
    });
  }

  onSignal(msg) {
    if (this.closed) return;
    if (msg.t === 'part') {
      const whole = this.reassemble(msg);
      if (!whole) return;
      msg = whole;
    }
    if (msg.t === 'state') { this.onRemoteState(msg); return; }
    // The far end telling us what it is failing to receive from us.
    if (msg.t === 'quality') { this.reportedLoss = Math.max(this.reportedLoss, msg.loss || 0); return; }
    if (msg.t === 'slots') { this.onSlots(msg.mids); return; }
    if (msg.t === 'renegotiate') { this.negotiate(); return; }
    if (msg.t === 'desc') this.enqueue(() => this.onDescription(msg.desc));
    else if (msg.t === 'ice') this.enqueue(() => this.onCandidate(msg.c));
  }

  async onDescription(desc) {
    const pc = this.pc;
    const readyForOffer =
      !this.makingOffer && (pc.signalingState === 'stable' || this.settingRemoteAnswer);
    const collision = desc.type === 'offer' && !readyForOffer;

    // The impolite peer simply refuses to be interrupted; the polite one rolls
    // its own offer back. Someone has to give way, and it must be exactly one.
    this.ignoreOffer = !this.polite && collision;
    if (this.ignoreOffer) return;

    this.settingRemoteAnswer = desc.type === 'answer';
    await pc.setRemoteDescription(desc);
    this.settingRemoteAnswer = false;

    // Candidates that raced ahead of the description they belong to.
    for (const c of this.pendingCandidates.splice(0)) {
      try { await pc.addIceCandidate(c); } catch { /* stale, harmless */ }
    }

    if (desc.type === 'offer') {
      const answer = await pc.createAnswer();
      answer.sdp = tune(answer, this.profile).sdp;
      await pc.setLocalDescription(answer);
      this.send({ t: 'desc', desc: pc.localDescription });
      this.publishSlots();

      /* First answer done. The answering side has been holding its own four
         transceivers back until this moment precisely so the two opening
         offers could not collide; now it takes its turn. */
      if (!this.answered) {
        this.answered = true;
        if (this.wantsNegotiation || this.sendT.some((t) => t.mid === null)) {
          this.wantsNegotiation = false;
          this.negotiate();
        }
      }
    }

    await this.reapplyEncodings();
  }

  async onCandidate(candidate) {
    if (!this.pc.remoteDescription) { this.pendingCandidates.push(candidate); return; }
    try {
      await this.pc.addIceCandidate(candidate);
    } catch (err) {
      // A candidate belonging to an offer we chose to ignore is expected.
      if (!this.ignoreOffer) throw err;
    }
  }

  /* Either side may restart now that either side may offer — restartIce()
     raises a negotiationneeded and the offer follows from there. Only the
     impolite peer acts on it, so a pair that both notice the failure at the
     same moment do not restart twice and collide. */
  restartIce() {
    if (this.closed || this.polite) return;
    try { this.pc.restartIce(); } catch { /* older browser: wait it out */ }
  }

  /* ── sending ── */

  // The one place a local track is attached. replaceTrack keeps the
  // transceiver and its mid, so swapping a camera or ending a share does not
  // cost a renegotiation — the picture just changes.
  async setSlot(slot, track) {
    const transceiver = this.sendT[slot];
    if (!transceiver) return;
    const sender = transceiver.sender;
    try {
      await sender.replaceTrack(track || null);
    } catch (err) {
      this.handlers.onError?.(this, err);
      return;
    }
    if (track) await this.applyEncodingFor(slot, sender);
  }

  async applyEncodingFor(slot, sender) {
    const p = this.profile;
    if (slot === SLOT.SCREEN) {
      await applyEncoding(sender, {
        maxBitrate: p.screenBitrate,
        maxFramerate: p.screenFps,
        // The default trades resolution away first, which is precisely wrong
        // for a screen — unreadable text at a smooth frame rate is useless.
        degradationPreference: p.screenHint === 'motion' ? 'balanced' : 'maintain-resolution',
      });
    } else if (slot === SLOT.CAM) {
      await applyEncoding(sender, {
        maxBitrate: p.camBitrate,
        maxFramerate: p.camFps,
        // Same reasoning as the screen: dropping resolution is the first thing
        // a browser reaches for under load, and it is the one thing a person
        // who asked for the best picture does not want traded away.
        degradationPreference: p.camHint === 'motion' ? 'balanced' : 'maintain-resolution',
      });
    } else {
      await applyEncoding(sender, { maxBitrate: p.opus.bitrate, priority: 'high' });
    }
  }

  async reapplyEncodings() {
    for (let slot = 0; slot < this.sendT.length; slot++) {
      const sender = this.sendT[slot]?.sender;
      if (sender?.track) await this.applyEncodingFor(slot, sender);
    }
  }

  /* The queue is bounded in milliseconds of audio, not bytes. A fixed byte
     figure means something completely different at each quality setting — a
     256 KB allowance is 1.4 seconds of 16-bit/48 kHz but only 227 ms of
     24-bit/192 kHz, and 227 ms of audio waiting to go out is 227 ms of delay
     that no jitter buffer can take back out.

     Dropping the newest packet is the right call once it is full: sending it
     late only pushes the far end further behind, and the receiver conceals a
     gap it never got far better than it recovers from a growing backlog. */
  sendPcm(buf) {
    if (this.pcm?.readyState !== 'open') return;

    const bytesPerSecond = this.profile.pcmBytesPerSecond || 1152000;
    const budget = bytesPerSecond * (PCM_QUEUE_MS / 1000);
    if (this.pcm.bufferedAmount > budget) { this.pcmDropped++; return; }

    try { this.pcm.send(buf); } catch { /* channel closing */ }
  }

  /* Adding the transceivers fires negotiationneeded almost immediately, while
     the signalling channel is still completing its own handshake — so the
     very first offer is generated before there is anywhere to put it. Dropping
     it deadlocks the call outright: negotiationneeded does not fire twice for
     the same change, so nothing ever asks again. Hence an outbox. */
  send(msg) {
    if (!this.signal || this.closed) return;
    if (!this.signal.open) { this.outbox.push(msg); return; }
    this.transmit(msg);
  }

  flush() {
    if (!this.signal?.open) return;
    for (const msg of this.outbox.splice(0)) this.transmit(msg);
  }

  /* A full offer — eight m-lines, every codec the browser knows, and whatever
     candidates have been gathered — runs to tens of kilobytes, and the
     signalling channel will not take a message that size in one piece. So
     anything large goes as numbered parts and is put back together on
     arrival. Everything else, which is almost everything, goes as it is. */
  transmit(msg) {
    let json;
    try { json = JSON.stringify(msg); } catch { return; }

    if (json.length <= MAX_PART) {
      try { this.signal.send(msg); } catch { /* connection going away */ }
      return;
    }

    const id = ++this.partSeq;
    const total = Math.ceil(json.length / MAX_PART);
    for (let i = 0; i < total; i++) {
      try {
        this.signal.send({ t: 'part', id, i, n: total, s: json.slice(i * MAX_PART, (i + 1) * MAX_PART) });
      } catch { return; }
    }
  }

  // Returns the whole message once the last part lands, and null until then.
  reassemble({ id, i, n, s }) {
    let parts = this.inbox.get(id);
    if (!parts) {
      // A sender that reconnects restarts its ids, so an abandoned partial
      // must not sit in here forever.
      if (this.inbox.size > 8) this.inbox.clear();
      parts = { got: 0, n, chunks: new Array(n).fill(null) };
      this.inbox.set(id, parts);
    }
    if (parts.chunks[i] === null) { parts.chunks[i] = s; parts.got++; }
    if (parts.got < parts.n) return null;

    this.inbox.delete(id);
    try { return JSON.parse(parts.chunks.join('')); } catch { return null; }
  }

  announce(state) {
    this.send({ t: 'state', ...state });
  }

  onRemoteState(msg) {
    this.remote = {
      name: msg.name ?? this.remote.name,
      mic: msg.mic ?? this.remote.mic,
      cam: msg.cam ?? this.remote.cam,
      screen: msg.screen ?? this.remote.screen,
      mode: msg.mode ?? this.remote.mode,
      tier: msg.tier ?? this.remote.tier,
      remaster: msg.remaster ?? this.remote.remaster,
    };
    this.handlers.onRemoteState?.(this);
  }

  /* ── stats ──
     Bitrates are differences between two samples; the cumulative totals the
     API returns would otherwise report an average over the whole call. */
  async sample() {
    if (!this.pc || this.pc.connectionState !== 'connected') return this.stats;
    let report;
    try { report = await this.pc.getStats(); } catch { return this.stats; }

    let sent = 0, received = 0, rtt = 0, lost = 0, packets = 0;
    report.forEach((s) => {
      if (s.type === 'outbound-rtp' && !s.isRemote) sent += s.bytesSent || 0;
      if (s.type === 'inbound-rtp' && !s.isRemote) {
        received += s.bytesReceived || 0;
        lost += s.packetsLost || 0;
        packets += (s.packetsReceived || 0) + (s.packetsLost || 0);
      }
      if (s.type === 'candidate-pair' && s.state === 'succeeded' && s.currentRoundTripTime) {
        rtt = s.currentRoundTripTime * 1000;
      }
      if (s.type === 'data-channel') {
        sent += s.bytesSent || 0;
        received += s.bytesReceived || 0;
      }
    });

    const now = performance.now();
    const prev = this._lastStats;
    if (prev && now > prev.at) {
      const secs = (now - prev.at) / 1000;
      this.stats.send = ((sent - prev.sent) * 8) / secs;
      this.stats.recv = ((received - prev.received) * 8) / secs;
    }
    this.stats.rtt = rtt;
    this.stats.loss = packets > 0 ? lost / packets : 0;
    this._lastStats = { at: now, sent, received };
    return this.stats;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.pcm?.close(); } catch { /* already closed */ }
    try { this.pc?.close(); } catch { /* already closed */ }
    try { this.signal?.close(); } catch { /* already closed */ }
    this.pc = null;
    this.pcm = null;
  }
}
