# Deploying clearline

Static files. There is no build step and no bundler — the browser loads the ES
modules directly — so deploying is copying the repository to any host that
serves files over HTTPS.

WebRTC and `getUserMedia` both require a secure context. HTTPS, or `localhost`.

## GitHub Pages

`.github/workflows/pages.yml` publishes `main` on every push. Once, in the
repository settings, set **Pages → Build and deployment → Source** to *GitHub
Actions*. After that it is automatic.

```bash
git push origin main
```

Pages' CDN lags its build API, so poll the served page rather than the API when
you want to know whether a change is live:

```bash
curl -s https://<user>.github.io/clearline/ | grep -c clearline
```

## Anywhere else

Serve the directory. Nothing needs rewriting or routing — room codes live in
the URL fragment, which never reaches the server.

Two headers are worth setting if you can, though neither is required:

- `Cache-Control: max-age=0, must-revalidate` on `index.html` and `config.js`
- A long `max-age` on `style.css` and `src/*.js` only if you fingerprint them;
  they are not fingerprinted here, so leave them revalidating

## config.js

Deliberately not bundled, so a deployed site can be reconfigured by editing one
file. Untouched, clearline runs on public STUN and the public PeerJS broker,
which is enough for most pairs of networks.

### TURN

Roughly 10–20% of network pairs — symmetric NAT at both ends, mostly — cannot
reach each other without a relay. Those calls fail rather than degrade. If that
matters, add credentials:

```js
window.CLEARLINE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'turn:turn.example.net:3478', username: '…', credential: '…' },
  ],
};
```

Long-lived credentials in a static file are readable by anyone who loads the
page. For anything public, hand out short-lived ones from an endpoint instead.

Note that a relay carries the media, and at 9.2 Mbps of lossless audio per
person — plus whatever the screen is doing — a TURN server priced by the
gigabyte will notice.

### Your own signalling

The public PeerJS broker only ever sees the handshake — offers, answers, ICE
candidates — and never audio, video or screen content. It is also a shared free
service with no uptime guarantee. To run your own:

```js
window.CLEARLINE_CONFIG = {
  peerServer: { host: 'signal.example.com', port: 443, path: '/', secure: true },
};
```

Both peers must be pointed at the same one. A room code is only meaningful
relative to the broker that resolves it.

## What deployment cannot fix

The mesh is the design, and it sets the ceiling on room size: each additional
person costs everyone else another upstream copy of everything they send. At
the default audio setting that is 9.2 Mbps per person, per direction. Four
people on lossless is roughly 28 Mbps up each, before any video.

Nothing in the middle mixes or transcodes, which is exactly why the audio stays
uncompressed end to end. An SFU would lift the ceiling and cost the property
the whole thing is for.
