/* Runtime configuration. Deliberately not bundled, so it can be edited on a
   deployed site without touching anything else.
 *
 * With this file untouched, clearline runs on public STUN and PeerJS's free
 * public broker. That is enough for most pairs of networks.
 */

window.CLEARLINE_CONFIG = {
  // ── kill switch ──
  // Set to true to stop the app opening or joining rooms, with the notice
  // below shown instead. This file is not bundled and not fingerprinted, so
  // it can be edited straight from GitHub's web UI to take the site out of
  // service in about thirty seconds without a code change or a rebuild.
  //
  // It cannot reach sessions that are already loaded in someone's tab.
  disabled: false,
  notice: 'clearline is temporarily out of service. Back shortly.',

  // Extra ICE servers. Roughly 10-20% of network pairs — symmetric NAT on both
  // ends, mostly — cannot reach each other without a TURN relay.
  //
  // iceServers: [
  //   { urls: 'stun:stun.example.net:3478' },
  //   { urls: 'turn:turn.example.net:3478', username: '…', credential: '…' },
  // ],

  // Point at your own signalling server instead of the public PeerJS broker.
  // The broker only ever sees the handshake — never audio, never video — but
  // it is a shared free service with no uptime guarantee.
  //
  // peerServer: { host: 'signal.example.com', port: 443, path: '/', secure: true },
};
