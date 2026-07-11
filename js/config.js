// js/config.js — every tunable knob in one place.
// Owned by the feed builder; read by feed.js (data layer) and the canvas
// engine (colors + spawn hints). No DOM, no side effects: safe to import
// anywhere (browser or node).

export const CONFIG = {
  // --- API endpoints ------------------------------------------------------
  // Primary first, then verified drop-in mirrors (same REST + WS API,
  // CORS `*`). We rotate on repeated failure and drift home hourly.
  hosts: [
    { rest: 'https://mempool.space', ws: 'wss://mempool.space' },
    { rest: 'https://mempool.emzy.de', ws: 'wss://mempool.emzy.de' },
    { rest: 'https://mempool.bitcoin.de', ws: 'wss://mempool.bitcoin.de' },
  ],

  ws: {
    path: '/api/v1/ws',
    // `want` channels: blocks + stats + projected mempool blocks.
    want: ['blocks', 'stats', 'mempool-blocks'],
  },

  // --- Poll cadences ------------------------------------------------------
  pollMs: {
    price: 60000, // /api/v1/prices — USD is not in the WS stream
  },
  pingMs: 30000, // {"action":"ping"} keepalive so intermediaries don't idle-kill

  // --- Reconnect backoff (exponential, capped, jittered) ------------------
  backoff: {
    scheduleMs: [1000, 2000, 4000, 8000, 15000, 30000, 60000],
    capMs: 60000,
    jitter: 0.25, // ±25% randomization to avoid thundering herds
  },

  // --- Endpoint rotation --------------------------------------------------
  rotation: {
    afterFailures: 3, // consecutive WS/REST failures before trying next host
    returnToPrimaryMs: 3600000, // drift back to host[0] after an hour
  },

  // --- Hot-stream auto-downgrade -----------------------------------------
  // When track-mempool `added[]` runs hot (sustained >25 tx/update OR
  // >15 tx/s across a 30s window), unsubscribe the full-tx firehose and
  // switch to track-mempool-txids + REST sampling. Probe back up when the
  // stream cools below the un-downgrade rate for a full window.
  hotStream: {
    windowMs: 30000, // sustained-measurement window
    txPerSecond: 25, // sustained tx/s across the window that trips downgrade
    // (no per-update threshold: the server batches deltas on its own cadence,
    // observed anywhere from ~1.7s to ~10s, so batch size ≠ network volume.
    // 25/s: normal traffic is ~2-8/s and a block boundary can burst a few
    // hundred re-added txs into one window — that alone must not trip it.)
    unDowngradeTxPerSecond: 15, // cool-off rate to probe back to live
  },

  // --- Stream classification budget --------------------------------------
  stream: {
    maxClassifyPerBatch: 30, // classify at most first N of each added[] batch
    sampleMaxPerBatch: 2, // degraded mode: REST-sample at most N txids/batch
  },

  // --- REST token bucket (≤1 req/s sustained, small bursts) ---------------
  tokenBucket: {
    capacity: 5, // burst allowance (e.g. the 4 block-scan calls + one spare)
    refillPerSec: 1, // steady-state 1 request/second
    maxWaitMs: 8000, // how long a blocking acquire waits before giving up
  },

  // --- Raw-block full scan ------------------------------------------------
  rawBlock: {
    sliceSize: 200, // classify this many txs per setTimeout slice (no stutter)
  },

  // --- Init backfill ------------------------------------------------------
  backfill: {
    blockCount: 3, // raw-scan the 3 most recent blocks at load
    spacingMs: 10000, // spaced ~10s apart (≈30s total) to stay polite
  },

  // --- BIP9 bit-4 signaling check -----------------------------------------
  // (version & mask) === value  →  block signals `reduced_data` (BIP-110).
  signaling: {
    mask: 0xe0000010,
    value: 0x20000010,
  },

  // --- Kill feed ----------------------------------------------------------
  killfeed: {
    topOffenders: 10, // N largest-payload violators surfaced per blockreport
  },

  // --- Engine spawn hints (read by battle.js) -----------------------------
  engine: {
    maxInfiltratorShare: 0.4, // Runes et al are ~56% of traffic; throttle to
                              // ≤40% of on-screen units so the field breathes
    spriteCap: 150, // hard cap on simultaneous on-screen units
    whaleBytes: 100000, // dataBytes over this = slow-mo + shake + scorch mark
  },

  // --- Trench Chat (Nostr NIP-28 kind-42) ---------------------------------
  // Relay roles are split per docs/research/nostr.json: read from the two
  // relays that both accept AND serve anonymous kind-42 (damus + primal);
  // write to those plus nostr.mom (a free extra copy), but NEVER count
  // nostr.mom toward durability — it shadow-accepts kind-42 then drops it.
  chat: {
    enabled: true,
    channelId: 'e7896af04cf2fcdea9b209f801547f1ff529c73eb24c760855889bcdda481aa5',
    readRelays: ['wss://relay.primal.net', 'wss://relay.damus.io'],
    writeRelays: ['wss://relay.primal.net', 'wss://relay.damus.io', 'wss://nostr.mom'],
    countRelays: ['wss://relay.primal.net', 'wss://relay.damus.io'],
    maxLen: 240,
    cooldownMs: 3000,
    historyHours: 6,
  },

  // --- Palette (near-black pixel-war; mirrored in css/style.css) -----------
  colors: {
    field: '#0b0e14', // near-black battlefield
    orange: '#ff6b35', // blood-orange accent
    magenta: '#ff3df5', // spam magenta (violators)
    gold: '#f7b32b', // pure gold (citizens / pure blocks)
    steel: '#9fb4c7', // knight steel (defenders)
    compliant: '#3ddc84', // green "COMPLIANT ✓" (infiltrators)
    ink: '#e6edf3', // primary text on dark
  },
};

export default CONFIG;
