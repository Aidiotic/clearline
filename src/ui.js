/* Everything that touches the DOM.

   The stage is the only part with real logic in it. A tile is keyed by
   "who-what", so a camera arriving, a share ending and a person leaving are
   all the same operation on the same map, and the layout is recomputed from
   scratch afterwards rather than patched in place. */

export const el = {};

export function bind() {
  const ids = [
    'app', 'statusline', 'live', 'view-start', 'view-invite', 'view-room', 'view-error',
    'act-create', 'join-form', 'join-code', 'act-join',
    'qr', 'code-display', 'share-link', 'copy-btn', 'share-btn', 'enter-btn',
    'stage', 'btn-mic', 'btn-cam', 'btn-screen', 'btn-invite', 'btn-settings', 'btn-leave',
    'dock-meta', 'error-msg', 'error-reset', 'quality-note',
    'settings', 'sheet-close', 'pref-audio', 'pref-tier', 'tier-note', 'pcm-opts',
    'budget-opts', 'pref-budget', 'pref-auto-quality',
    'pref-remaster', 'pref-dsp', 'audio-note',
    'pref-screen-res', 'pref-screen-bitrate', 'pref-screen-fps', 'pref-screen-hint', 'pref-screen-codec',
    'pref-cam-res', 'pref-cam-fps', 'pref-cam-bitrate', 'pref-cam-hint', 'pref-cam-prefer',
    'pref-cam-codec', 'pref-mic-device', 'pref-cam-device',
    'pref-name', 'pref-theme',
  ];
  for (const id of ids) el[camel(id)] = document.getElementById(id);
  return el;
}

const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

const VIEWS = ['viewStart', 'viewInvite', 'viewRoom', 'viewError'];

export function showView(name) {
  for (const v of VIEWS) el[v].hidden = v !== name;
  document.body.classList.toggle('in-room', name === 'viewRoom');
}

export function setState(state) {
  el.app.dataset.state = state;
}

export function setStatus(text) {
  el.statusline.textContent = text || '';
}

// Screen readers need the change announced; the status line alone is silent.
export function announce(text) {
  el.live.textContent = text;
}

export function setLevel(value) {
  el.app.style.setProperty('--level', value.toFixed(3));
}

export function fail(message) {
  el.errorMsg.textContent = message;
  setState('failed');
  showView('viewError');
}

export function renderQR(url) {
  el.qr.innerHTML = '';
  try {
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    el.qr.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  } catch {
    // A code too long for the smallest version is not worth failing over.
    el.qr.hidden = true;
  }
}

/* ── the stage ── */

export class Stage {
  constructor(root, { onPin }) {
    this.root = root;
    this.onPin = onPin;
    this.tiles = new Map();
    this.audio = new Map();
    this.pinned = null;
    this.strip = document.createElement('div');
    this.strip.className = 'strip';
    this.empty = null;
  }

  key(owner, kind) { return `${owner}::${kind}`; }

  upsert(owner, kind, { stream, label, badge, self = false, level = 0, muted = false }) {
    const key = this.key(owner, kind);
    let tile = this.tiles.get(key);

    if (!tile) {
      tile = { el: document.createElement('div'), owner, kind, self };
      tile.el.className = 'tile';
      tile.el.dataset.kind = kind;
      if (self) tile.el.dataset.self = '1';

      if (kind === 'audio') {
        tile.avatar = document.createElement('div');
        tile.avatar.className = 'tile-avatar';
        tile.el.append(tile.avatar);
      } else {
        tile.video = document.createElement('video');
        tile.video.autoplay = true;
        tile.video.playsInline = true;
        // Audio never comes through a tile — it has its own element per peer,
        // so a muted camera tile cannot silence someone.
        tile.video.muted = true;
        tile.el.append(tile.video);
      }

      tile.labelEl = document.createElement('div');
      tile.labelEl.className = 'tile-label';
      tile.dot = document.createElement('span');
      tile.dot.className = 'dot';
      tile.text = document.createElement('span');
      tile.labelEl.append(tile.dot, tile.text);
      tile.el.append(tile.labelEl);

      if (kind !== 'audio') {
        const pin = document.createElement('button');
        pin.type = 'button';
        pin.className = 'tile-pin';
        pin.setAttribute('aria-label', 'Focus this');
        pin.addEventListener('click', () => this.onPin?.(key === this.pinned ? null : key));
        tile.el.append(pin);
      }

      this.tiles.set(key, tile);
    }

    if (stream && tile.video && tile.video.srcObject !== stream) tile.video.srcObject = stream;
    tile.text.textContent = label;
    tile.dot.dataset.muted = muted ? '1' : '0';
    tile.el.style.setProperty('--level', level.toFixed(3));

    if (badge) {
      if (!tile.badgeEl) {
        tile.badgeEl = document.createElement('div');
        tile.badgeEl.className = 'tile-badge';
        tile.el.append(tile.badgeEl);
      }
      tile.badgeEl.textContent = badge;
    } else if (tile.badgeEl) {
      tile.badgeEl.remove();
      tile.badgeEl = null;
    }

    this.layout();
    return tile;
  }

  level(owner, kind, value) {
    const tile = this.tiles.get(this.key(owner, kind));
    if (tile) tile.el.style.setProperty('--level', value.toFixed(3));
  }

  remove(owner, kind) {
    const key = this.key(owner, kind);
    const tile = this.tiles.get(key);
    if (!tile) return;
    if (tile.video) tile.video.srcObject = null;
    tile.el.remove();
    this.tiles.delete(key);
    if (this.pinned === key) this.pinned = null;
    this.layout();
  }

  removeOwner(owner) {
    for (const [key, tile] of [...this.tiles]) {
      if (tile.owner === owner) this.remove(tile.owner, tile.kind);
    }
    const audio = this.audio.get(owner);
    if (audio) { audio.srcObject = null; audio.remove(); this.audio.delete(owner); }
  }

  /* Remote audio lives on its own element per peer rather than riding a video
     tile, so it survives the camera being switched off and never picks up the
     muted flag a self-view needs. */
  attachAudio(owner, track) {
    let audio = this.audio.get(owner);
    if (!audio) {
      audio = document.createElement('audio');
      audio.autoplay = true;
      audio.hidden = true;
      document.body.append(audio);
      this.audio.set(owner, audio);
    }
    const stream = audio.srcObject instanceof MediaStream ? audio.srcObject : new MediaStream();
    if (!stream.getTracks().includes(track)) stream.addTrack(track);
    audio.srcObject = stream;
    audio.play?.().catch(() => { /* resumed by the next gesture */ });
  }

  detachAudio(owner, track) {
    const audio = this.audio.get(owner);
    const stream = audio?.srcObject;
    if (stream instanceof MediaStream && stream.getTracks().includes(track)) stream.removeTrack(track);
  }

  pin(key) {
    this.pinned = this.tiles.has(key) ? key : null;
    this.layout();
  }

  setVolume(v) {
    for (const audio of this.audio.values()) audio.volume = v;
  }

  layout() {
    const pinnedTile = this.pinned ? this.tiles.get(this.pinned) : null;
    this.root.dataset.pinned = pinnedTile ? '1' : '0';

    for (const tile of this.tiles.values()) {
      tile.el.classList.toggle('tile-pinned', tile === pinnedTile);
    }

    if (pinnedTile) {
      this.root.append(pinnedTile.el, this.strip);
      for (const tile of this.tiles.values()) {
        if (tile !== pinnedTile) this.strip.append(tile.el);
      }
    } else {
      this.strip.remove();
      for (const tile of this.tiles.values()) this.root.append(tile.el);
    }

    if (!this.tiles.size) {
      if (!this.empty) {
        this.empty = document.createElement('p');
        this.empty.className = 'tile-empty';
        this.empty.textContent = 'Nobody here yet. Send someone the link.';
      }
      this.root.append(this.empty);
    } else if (this.empty) {
      this.empty.remove();
    }
  }
}
