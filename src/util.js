/* Pure helpers. No DOM, no network — everything here is testable in isolation,
   which is why it never touches a browser global at load time. */

// The alphabet people can read off a screen and type without a second look:
// no i/l/1, no o/0. 31 symbols, 9 of them is ~44 bits.
export const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

const CODE_LEN = 9;

export function newCode(randomBytes = defaultRandom) {
  // Rejection sampling. 256 % 31 != 0, so taking the modulus of a raw byte
  // would quietly favour the first few letters.
  const out = [];
  const limit = 256 - (256 % ALPHABET.length);
  while (out.length < CODE_LEN) {
    for (const b of randomBytes(CODE_LEN)) {
      if (b >= limit) continue;
      out.push(ALPHABET[b % ALPHABET.length]);
      if (out.length === CODE_LEN) break;
    }
  }
  return out.join('');
}

function defaultRandom(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

// Anything a person might paste — with dashes, spaces, capitals, or a whole
// URL wrapped around it — reduces to the same nine characters.
export function normaliseCode(input) {
  const raw = String(input || '').trim().toLowerCase();
  const afterHash = raw.includes('#') ? raw.slice(raw.lastIndexOf('#') + 1) : raw;
  const kept = [...afterHash].filter((c) => ALPHABET.includes(c)).join('');
  return kept.slice(0, CODE_LEN);
}

export function isCode(code) {
  return typeof code === 'string' && code.length === CODE_LEN &&
    [...code].every((c) => ALPHABET.includes(c));
}

export function formatCode(code) {
  return String(code || '').replace(/(.{3})(?=.)/g, '$1-');
}

export function bitrate(bitsPerSecond) {
  if (!isFinite(bitsPerSecond) || bitsPerSecond < 0) return '—';
  if (bitsPerSecond < 1000) return `${Math.round(bitsPerSecond)} bps`;
  if (bitsPerSecond < 1e6) return `${(bitsPerSecond / 1e3).toFixed(0)} kbps`;
  return `${(bitsPerSecond / 1e6).toFixed(bitsPerSecond < 1e7 ? 1 : 0)} Mbps`;
}

export function duration(secs) {
  if (!isFinite(secs) || secs < 0) return '0:00';
  const s = Math.floor(secs % 60);
  const m = Math.floor(secs / 60) % 60;
  const h = Math.floor(secs / 3600);
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return h ? `${h}:${mm}:${String(s).padStart(2, '0')}` : `${mm}:${String(s).padStart(2, '0')}`;
}

// Exponential moving average — a naive total/elapsed keeps reporting a number
// from thirty seconds ago, which is useless for a live link.
export function ema(previous, sample, alpha = 0.3) {
  if (previous === null || previous === undefined || !isFinite(previous)) return sample;
  return previous + alpha * (sample - previous);
}

export function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

export function throttle(fn, ms) {
  let last = 0;
  return (...args) => {
    const now = Date.now();
    if (now - last < ms) return;
    last = now;
    fn(...args);
  };
}

// Names come off the wire from another browser: they land in textContent, but
// a 4000-character "name" would still wreck the layout.
export function safeName(name) {
  const trimmed = String(name ?? '').replace(/\s+/g, ' ').trim();
  return trimmed.slice(0, 24);
}

/* Perfect negotiation needs exactly one polite peer per pair, and both ends
   must agree on which without talking about it. Comparing the two ids gives
   the same answer on both sides. */
export function isPolite(selfId, otherId) {
  return String(selfId) > String(otherId);
}

export function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
