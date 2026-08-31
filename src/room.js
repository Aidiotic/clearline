/* The room.

   There is no server holding a room open, so a room is really just a peer id
   that everyone can work out from the code: the person who created it parks on
   `cl-<code>` and answers the door. Everyone else takes a random id, knocks,
   and is told who else is inside.

   From there it is a full mesh — every pair has its own direct connection, and
   nothing is relayed through the creator. That is what keeps the audio
   uncompressed end to end; the moment anything in the middle decodes a stream
   to mix it, the quality argument is over. It is also why the ceiling is a
   handful of people rather than a hundred: each extra person costs everyone
   else another upstream copy.

   If the creator leaves, the remaining members elect the next one to take the
   door key, so a room outlives whoever opened it. */

import { Link } from './link.js';
import { LocalAudio, PcmReceiver, context, DEFAULT_TIER } from './pcm.js';
import { SLOT } from './media.js';
import { safeName } from './util.js';

const PREFIX = 'cl-';
export const MAX_PEERS = 8;

export class Room {
  constructor({ code, profile, config, on }) {
    this.code = code;
    this.profile = profile;
    this.config = config;
    this.on = on;

    this.hostId = PREFIX + code;
    this.selfId = null;
    this.isHost = false;

    this.peer = null;
    this.links = new Map();      // peerId -> Link
    this.pcmIn = new Map();      // peerId -> PcmReceiver
    this.audio = new LocalAudio();

    this.name = '';
    this.mode = 'opus';
    this.tier = DEFAULT_TIER;
    this.micStream = null;
    this.tracks = { mic: null, cam: null, screen: null, screenAudio: null };

    this.closed = false;
    this._pcmSink = (buf) => {
      for (const link of this.links.values()) link.sendPcm(buf);
    };
  }

  /* ── joining ── */

  async start({ asHost }) {
    // The creator takes the predictable id. Everyone else is anonymous, which
    // also means nobody can be dialled directly from outside the room.
    const id = asHost ? this.hostId : this.hostId + '-' + randomSuffix();
    this.peer = await openPeer(id, this.config);
    this.selfId = this.peer.id;
    this.isHost = this.peer.id === this.hostId;

    this.peer.on('connection', (conn) => this.accept(conn));
    this.peer.on('error', (err) => {
      // Dialling a room nobody is hosting lands here rather than as a timeout.
      if (err.type === 'peer-unavailable') this.on.gone?.(err.message);
      else this.on.error?.(err);
    });
    this.peer.on('disconnected', () => {
      if (!this.closed) this.peer.reconnect();
    });

    if (!this.isHost) await this.dial(this.hostId);
    return this;
  }

  // Opening the connection is what makes you the initiator for that pair, and
  // the initiator is the side that owns negotiation. One rule, applied
  // everywhere, is what keeps two peers from offering at each other.
  async dial(peerId) {
    if (peerId === this.selfId || this.links.has(peerId)) return;
    /* JSON, with the link doing its own splitting for anything large. The
       obvious alternative — PeerJS's binary mode, which chunks by itself —
       accepts an oversized message and then never reassembles it at the far
       end, so an offer simply vanishes and the call hangs with no error
       anywhere. A visible limit we handle ourselves beats an invisible one
       that swallows the most important message in the handshake. */
    const conn = this.peer.connect(peerId, { reliable: true, serialization: 'json' });
    await this.attach(conn, peerId, true);
  }

  async accept(conn) {
    if (this.links.has(conn.peer)) {
      // A duplicate can only mean both sides dialled at once; the existing
      // link is already negotiating, so this one is noise.
      try { conn.close(); } catch { /* nothing to clean up */ }
      return;
    }
    if (this.links.size >= MAX_PEERS - 1) {
      conn.on('open', () => { conn.send({ t: 'full' }); conn.close(); });
      return;
    }
    await this.attach(conn, conn.peer, false);
  }

  async attach(conn, peerId, initiator) {
    const link = new Link({
      selfId: this.selfId,
      peerId,
      initiator,
      signal: conn,
      config: this.config,
      profile: this.profile,
      handlers: {
        onTrack: (l, slot, track, stream) => this.on.track?.(l.peerId, slot, track, stream),
        onTrackMuted: (l, slot, muted) => this.on.trackMuted?.(l.peerId, slot, muted),
        onPcm: (l, buf) => this.receivePcm(l.peerId, buf),
        onRemoteState: (l) => this.on.roster?.(this.describe()),
        onState: (l, state) => this.on.linkState?.(l.peerId, state),
        onError: (l, err) => this.on.error?.(err),
      },
    });

    this.links.set(peerId, link);
    await link.open();

    conn.on('data', (msg) => this.route(link, msg));
    conn.on('close', () => this.drop(peerId, 'closed'));
    // Swallowing this makes a dropped link indistinguishable from someone
    // leaving, which is the difference between a bug and normal behaviour.
    conn.on('error', (err) => {
      this.on.error?.(err);
      this.drop(peerId, `signalling error: ${err?.type || err?.message || err}`);
    });

    const ready = () => this.onLinkOpen(link);
    if (conn.open) ready();
    else conn.on('open', ready);
  }

  async onLinkOpen(link) {
    // Anything the peer connection wanted to say before there was a channel
    // to say it on — including, always, the first offer.
    link.flush();
    link.announce(this.selfState());

    // The host is the only one who knows the full membership, so it is the
    // only one that says anything about it.
    if (this.isHost) {
      const others = [...this.links.keys()].filter((id) => id !== link.peerId);
      link.send({ t: 'roster', peers: others });
      this.broadcastRoster();
    }

    await this.pushTracks(link);
    this.on.roster?.(this.describe());
  }

  route(link, msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'roster') { this.onRoster(msg.peers); return; }
    if (msg.t === 'full') { this.on.gone?.('That room is full.'); return; }
    link.onSignal(msg);
  }

  /* A roster only ever adds people. Whoever has the smaller id dials, so each
     new pair produces exactly one connection even when two people join in the
     same instant and each hears about the other from the host. */
  onRoster(peers) {
    for (const id of peers || []) {
      if (id === this.selfId || this.links.has(id)) continue;
      if (this.selfId < id) this.dial(id);
    }
  }

  broadcastRoster() {
    if (!this.isHost) return;
    const all = [...this.links.keys()];
    for (const link of this.links.values()) {
      link.send({ t: 'roster', peers: all.filter((id) => id !== link.peerId) });
    }
  }

  drop(peerId, reason = 'closed') {
    const link = this.links.get(peerId);
    if (!link) return;
    this.on.dropped?.(peerId, reason);
    this.links.delete(peerId);
    link.close();
    this.pcmIn.get(peerId)?.stop();
    this.pcmIn.delete(peerId);
    this.on.left?.(peerId);
    this.on.roster?.(this.describe());
    if (this.isHost) this.broadcastRoster();
    else if (peerId === this.hostId) this.electHost();
  }

  /* ── host migration ──
     The door key is not the call. Losing the creator costs nobody their
     connection; it only means nobody new could get in, so the lowest id still
     present picks the key up. */
  async electHost() {
    if (this.closed || this.isHost) return;
    const candidates = [this.selfId, ...this.links.keys()].sort();
    if (candidates[0] !== this.selfId) return;

    for (let attempt = 0; attempt < 3; attempt++) {
      // The broker takes a moment to free the departed id.
      await sleep(600 * (attempt + 1));
      if (this.closed) return;
      try {
        const claimed = await openPeer(this.hostId, this.config);
        const old = this.peer;
        this.peer = claimed;
        this.isHost = true;
        // The random id stays valid for existing links; only new arrivals
        // come through the claimed one.
        claimed.on('connection', (conn) => this.accept(conn));
        claimed.on('error', (err) => this.on.error?.(err));
        old.off?.('connection');
        this.broadcastRoster();
        this.on.roster?.(this.describe());
        return;
      } catch { /* someone else got there first, or it is not free yet */ }
    }
  }

  /* ── local media ── */

  selfState() {
    return {
      name: this.name,
      mic: !!(this.tracks.mic || (this.mode === 'pcm' && this.micStream)),
      cam: !!this.tracks.cam,
      screen: !!this.tracks.screen,
      mode: this.mode,
      tier: this.tier,
      remaster: this.audio.remasterPreset || null,
    };
  }

  announce() {
    const state = this.selfState();
    for (const link of this.links.values()) link.announce(state);
    this.on.roster?.(this.describe());
  }

  async pushTracks(link) {
    await link.setSlot(SLOT.MIC, this.tracks.mic);
    await link.setSlot(SLOT.CAM, this.tracks.cam);
    await link.setSlot(SLOT.SCREEN, this.tracks.screen);
    await link.setSlot(SLOT.SCREEN_AUDIO, this.tracks.screenAudio);
  }

  async setTrack(slot, track) {
    const key = ['mic', 'cam', 'screen', 'screenAudio'][slot];
    this.tracks[key] = track || null;
    for (const link of this.links.values()) await link.setSlot(slot, track || null);
    this.announce();
  }

  setName(name) {
    this.name = safeName(name);
    this.announce();
  }

  /* ── audio ──
     Lossless and Opus are mutually exclusive per person: in lossless mode the
     microphone transceiver carries nothing at all and the samples go down the
     data channel instead. Running both would just be sending the voice twice. */
  async configureAudio({ mode, tier, remaster, stream } = {}) {
    if (stream) this.micStream = stream;
    if (mode) this.mode = mode;
    if (tier) this.tier = tier;

    const before = context();
    await this.audio.setup({
      stream: this.micStream,
      mode: this.mode,
      tier: this.tier,
      remaster,
    });

    // A tier change can mean a new AudioContext at a new rate, and every
    // receiver hanging off the old one is now attached to a closed graph.
    // They are rebuilt on the next packet, so dropping them is enough.
    if (context() !== before) {
      for (const rx of this.pcmIn.values()) rx.stop();
      this.pcmIn.clear();
    }

    if (this.mode === 'pcm') {
      this.audio.addSink(this._pcmSink);
      await this.setTrack(SLOT.MIC, null);
    } else {
      this.audio.removeSink(this._pcmSink);
      await this.setTrack(SLOT.MIC, this.audio.outboundTrack);
    }
    this.announce();
  }

  setMuted(muted) {
    this.audio.setMuted(muted);
  }

  // Receivers are made on first packet rather than on a state message, so a
  // reordered announcement can never cost someone their audio.
  async receivePcm(peerId, buf) {
    let rx = this.pcmIn.get(peerId);
    if (!rx) {
      rx = new PcmReceiver();
      this.pcmIn.set(peerId, rx);
      await rx.start(this.profile.jitterMs);
      this.on.roster?.(this.describe());
    }
    rx.push(buf);
  }

  /* ── reporting ── */

  describe() {
    return [...this.links.values()].map((link) => ({
      id: link.peerId,
      name: link.remote.name,
      mic: link.remote.mic,
      cam: link.remote.cam,
      screen: link.remote.screen,
      mode: link.remote.mode,
      tier: link.remote.tier,
      remaster: link.remote.remaster,
      state: link.pc?.connectionState || 'new',
      level: this.pcmIn.get(link.peerId)?.level ?? 0,
    }));
  }

  async sampleStats() {
    let send = 0, recv = 0, rtt = 0, loss = 0, n = 0;
    for (const link of this.links.values()) {
      const s = await link.sample();
      send += s.send; recv += s.recv;
      rtt = Math.max(rtt, s.rtt);
      loss = Math.max(loss, s.loss);
      n++;
    }
    for (const rx of this.pcmIn.values()) loss = Math.max(loss, rx.lossRatio);
    return { send, recv, rtt, loss, peers: n };
  }

  levelFor(peerId) {
    return this.pcmIn.get(peerId)?.level ?? 0;
  }

  close() {
    this.closed = true;
    this.audio.removeSink(this._pcmSink);
    this.audio.stop();
    for (const rx of this.pcmIn.values()) rx.stop();
    this.pcmIn.clear();
    for (const link of this.links.values()) link.close();
    this.links.clear();
    try { this.peer?.destroy(); } catch { /* already gone */ }
  }
}

/* ── plumbing ── */

function randomSuffix() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 8);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function openPeer(id, config) {
  return new Promise((resolve, reject) => {
    const options = { debug: 0, config: { iceServers: config.iceServers } };
    if (config.peerServer) Object.assign(options, config.peerServer);

    const peer = new Peer(id, options);
    const timer = setTimeout(() => {
      peer.destroy();
      reject(new Error('The signalling service did not answer.'));
    }, 15000);

    peer.once('open', () => { clearTimeout(timer); resolve(peer); });
    peer.once('error', (err) => {
      // Only failures during setup are fatal here; later ones belong to the
      // handler the caller installs.
      if (peer.open) return;
      clearTimeout(timer);
      peer.destroy();
      reject(err);
    });
  });
}
