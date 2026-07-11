// js/feed.js — the data layer.
//
// MempoolFeed opens one WebSocket to mempool.space, classifies the live tx
// stream, does full raw-block scans on every new block, and re-broadcasts
// everything as CustomEvents the UI + canvas engine listen to. It never
// throws out of an event handler and never lets one failed fetch kill the
// loop.
//
// Node note: this module is import-safe under node18. The heavy siblings
// (classify.js, rawtx.js) are loaded via dynamic import inside start(), and
// WebSocket is constructed lazily — so nothing browser-only runs on import.
// The pure helper buildBlockReport() is unit-tested directly (see
// test/feed.smoke.mjs); node just smoke-tests the helpers.

import { CONFIG } from './config.js';

// --- pure helpers (exported for tests) --------------------------------------

// A tx is the coinbase if it's first in the block or explicitly flagged.
function isCoinbase(tx, index) {
  return index === 0 || !!(tx && tx.vin && tx.vin[0] && tx.vin[0].is_coinbase);
}

// BIP9 bit-4 (`reduced_data`) signaling. version may be missing → false.
// Normalize with >>>0 because versions with bit31 set go negative in int32.
export function isSignaling(version, config = CONFIG) {
  if (typeof version !== 'number') return false;
  const { mask, value } = config.signaling;
  return ((version & mask) >>> 0) === value;
}

// Fold an array of classified block txs into the report shape the UI wants.
// `classified` excludes the coinbase; `allTxs` is the full parsed list (used
// only for the vsize denominator). blockMeta is a mempool.space-shaped block
// (ws {block} object, or an /api/v1/blocks entry — identical shape).
export function reduceReport(classified, blockMeta, allTxs, config = CONFIG) {
  const byProtocol = {};
  const byArchetype = { violator: 0, infiltrator: 0, citizen: 0 };
  let spamVBytes = 0;
  const violators = [];

  for (const entry of classified) {
    const { tx, verdict } = entry;
    if (!verdict) continue;
    const proto = verdict.protocol || 'unknown';
    byProtocol[proto] = (byProtocol[proto] || 0) + 1;
    const arch = verdict.archetype || 'citizen';
    if (byArchetype[arch] === undefined) byArchetype[arch] = 0;
    byArchetype[arch] += 1;
    if (arch === 'violator') {
      spamVBytes += tx.vsize || 0;
      violators.push(entry);
    }
  }

  let totalVBytes = 0;
  for (const tx of allTxs) totalVBytes += tx.vsize || 0;

  // Top offenders = biggest data payloads, trimmed to a light event payload.
  violators.sort(
    (a, b) => (b.verdict.dataBytes || 0) - (a.verdict.dataBytes || 0)
  );
  const topOffenders = violators
    .slice(0, config.killfeed.topOffenders)
    .map(({ tx, verdict }) => ({
      tx: { txid: tx.txid, vsize: tx.vsize },
      verdict,
    }));

  const version =
    blockMeta && typeof blockMeta.version === 'number' ? blockMeta.version : undefined;

  return {
    height: blockMeta ? blockMeta.height : undefined,
    id: blockMeta ? blockMeta.id : undefined,
    totalTx: (blockMeta && blockMeta.tx_count) || allTxs.length,
    scannedTx: classified.length,
    counts: { byProtocol, byArchetype },
    spamVBytes,
    totalVBytes,
    spamShare: totalVBytes > 0 ? spamVBytes / totalVBytes : 0,
    signaling: isSignaling(version, config),
    pool: (blockMeta && blockMeta.extras && blockMeta.extras.pool) || null,
    topOffenders,
    pure: violators.length === 0,
  };
}

// Synchronous full-block report (used by tests; runtime uses the chunked
// path in the class to avoid frame stutter). classifyFn === classify.classifyTx.
export function buildBlockReport(parsedTxs, blockMeta, classifyFn, config = CONFIG) {
  const classified = [];
  for (let i = 0; i < parsedTxs.length; i++) {
    const tx = parsedTxs[i];
    if (isCoinbase(tx, i)) continue;
    let verdict = null;
    try {
      verdict = classifyFn(tx);
    } catch (e) {
      verdict = null; // one unparseable tx must not sink the whole report
    }
    classified.push({ tx, verdict });
  }
  return reduceReport(classified, blockMeta, parsedTxs, config);
}

// --- the feed ---------------------------------------------------------------

export class MempoolFeed extends EventTarget {
  constructor(config = CONFIG) {
    super();
    this.config = config;

    // lifecycle
    this._started = false;
    this.stopped = true;

    // loaded lazily in start()
    this._classify = null;
    this._parseRawBlock = null;

    // connection
    this.ws = null;
    this.connected = false;
    this.mode = 'down'; // 'live' | 'degraded' | 'down'
    this.hostIndex = 0;
    this.consecutiveFailures = 0;
    this.consecutiveRestFailures = 0;
    this._backoffAttempt = 0;

    // timers
    this._pingTimer = null;
    this._priceTimer = null;
    this._reconnectTimer = null;
    this._returnHomeTimer = null;

    // stream stats
    this._streamSamples = []; // [{t, n}] rolling window for hot detection
    this._lastSeq = null;

    // latest snapshots (folded into 'stats')
    this.mempoolInfo = null;
    this.fees = null;
    this.vBytesPerSecond = null;
    this.price = null;

    // token bucket
    this.tokens = config.tokenBucket.capacity;
    this._lastRefill = Date.now();

    this.recentBlocks = [];
  }

  // ---- lifecycle ----------------------------------------------------------

  start() {
    if (this._started) return;
    this._started = true;
    this.stopped = false;
    this._boot();
  }

  async _boot() {
    // Dynamic import keeps feed.js import-safe in node18 (these siblings are
    // built by the classifier builder and exist in the browser bundle).
    try {
      const [cm, rm] = await Promise.all([
        import('./classify.js'),
        import('./rawtx.js'),
      ]);
      this._classify = cm.classifyTx;
      this._parseRawBlock = rm.parseRawBlock;
    } catch (e) {
      this._emitStatus('down', 'classifier modules unavailable: ' + e.message);
      return;
    }
    if (this.stopped) return;
    this._connectWS();
    this._startPricePoll();
    this._init();
  }

  stop() {
    this.stopped = true;
    this._started = false;
    this._clearTimer('_pingTimer');
    this._clearTimer('_priceTimer');
    this._clearTimer('_reconnectTimer');
    this._clearTimer('_returnHomeTimer');
    if (this.ws) {
      try {
        this.ws.onopen = this.ws.onclose = this.ws.onmessage = this.ws.onerror = null;
        this.ws.close();
      } catch (e) {
        /* ignore */
      }
      this.ws = null;
    }
    this.connected = false;
  }

  _clearTimer(name) {
    if (this[name]) {
      clearTimeout(this[name]);
      clearInterval(this[name]);
      this[name] = null;
    }
  }

  // ---- dispatch (never throws) -------------------------------------------

  _dispatch(type, detail) {
    let ev;
    const Ctor = globalThis.CustomEvent;
    if (Ctor) {
      ev = new Ctor(type, { detail });
    } else {
      // node18 has Event but not CustomEvent
      ev = new Event(type);
      ev.detail = detail;
    }
    try {
      this.dispatchEvent(ev);
    } catch (e) {
      /* a listener threw — that's the UI's problem, not ours */
    }
  }

  _emitStatus(mode, message) {
    this.mode = mode;
    this._dispatch('status', { connected: this.connected, mode, message });
  }

  _safe(fn) {
    try {
      fn();
    } catch (e) {
      /* swallow — an event handler must never crash the loop */
    }
  }

  // ---- host rotation ------------------------------------------------------

  _host() {
    return this.config.hosts[this.hostIndex] || this.config.hosts[0];
  }

  _restBase() {
    return this._host().rest;
  }

  _wsUrl() {
    return this._host().ws + this.config.ws.path;
  }

  _rotateHost() {
    this.hostIndex = (this.hostIndex + 1) % this.config.hosts.length;
    this._emitStatus(this.mode, 'rotated to ' + this._restBase());
    // schedule a drift back to the primary host after an hour
    if (this.hostIndex !== 0 && !this._returnHomeTimer) {
      this._returnHomeTimer = setTimeout(() => {
        this._returnHomeTimer = null;
        this.hostIndex = 0;
      }, this.config.rotation.returnToPrimaryMs);
    }
  }

  // ---- WebSocket ----------------------------------------------------------

  _connectWS() {
    const WS = globalThis.WebSocket;
    if (!WS) {
      this._emitStatus('down', 'WebSocket unavailable in this environment');
      return;
    }
    let ws;
    try {
      ws = new WS(this._wsUrl());
    } catch (e) {
      this._emitStatus('down', 'ws construct failed');
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.connected = true;
      this._backoffAttempt = 0;
      this.consecutiveFailures = 0;
      this._streamSamples = [];
      this._subscribeLive();
      this._startPing();
      this._emitStatus('live', 'connected to ' + this._restBase());
    };
    ws.onmessage = (ev) => this._safe(() => this._handleMessage(ev.data));
    ws.onerror = () => this._emitStatus(this.connected ? this.mode : 'down', 'socket error');
    ws.onclose = () => {
      this.connected = false;
      this._stopPing();
      this._emitStatus('down', 'socket closed');
      this._scheduleReconnect();
    };
  }

  _wsSend(obj) {
    try {
      if (this.ws && this.ws.readyState === 1) {
        this.ws.send(JSON.stringify(obj));
      }
    } catch (e) {
      /* ignore transient send errors */
    }
  }

  _subscribeLive() {
    this._wsSend({ action: 'want', data: this.config.ws.want });
    this._wsSend({ 'track-mempool': true });
    this.mode = 'live';
  }

  _scheduleReconnect() {
    if (this.stopped) return;
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.config.rotation.afterFailures) {
      this._rotateHost();
      this.consecutiveFailures = 0;
    }
    const delay = this._nextBackoff();
    this._clearTimer('_reconnectTimer');
    this._reconnectTimer = setTimeout(() => {
      if (!this.stopped) this._connectWS();
    }, delay);
  }

  _nextBackoff() {
    const sched = this.config.backoff.scheduleMs;
    const base = Math.min(
      sched[Math.min(this._backoffAttempt, sched.length - 1)],
      this.config.backoff.capMs
    );
    this._backoffAttempt += 1;
    const j = this.config.backoff.jitter;
    const factor = 1 + (Math.random() * 2 - 1) * j; // 1 ± jitter
    return Math.round(base * factor);
  }

  _startPing() {
    this._stopPing();
    this._pingTimer = setInterval(() => {
      this._wsSend({ action: 'ping' });
    }, this.config.pingMs);
  }

  _stopPing() {
    this._clearTimer('_pingTimer');
  }

  // ---- message routing ----------------------------------------------------

  _handleMessage(data) {
    let msg;
    try {
      msg = JSON.parse(typeof data === 'string' ? data : String(data));
    } catch (e) {
      return; // non-JSON frame (shouldn't happen) — ignore
    }
    if (!msg || typeof msg !== 'object') return;

    // Each branch is independently guarded so one bad key can't stop the rest.
    if (msg.block) this._safe(() => this._handleBlock(msg));
    if (Array.isArray(msg.blocks)) this._safe(() => { this.recentBlocks = msg.blocks; });
    if (msg['mempool-transactions'])
      this._safe(() => this._handleMempoolTransactions(msg['mempool-transactions']));
    if (msg['mempool-txids'])
      this._safe(() => this._handleMempoolTxids(msg['mempool-txids']));
    if (msg['mempool-blocks'])
      this._safe(() => this._dispatch('projected', { mempoolBlocks: msg['mempool-blocks'] }));

    // stats fields arrive bundled in every ~1.7s update
    let statsChanged = false;
    if ('mempoolInfo' in msg) { this.mempoolInfo = msg.mempoolInfo; statsChanged = true; }
    if ('fees' in msg) { this.fees = msg.fees; statsChanged = true; }
    if ('vBytesPerSecond' in msg) { this.vBytesPerSecond = msg.vBytesPerSecond; statsChanged = true; }
    if (statsChanged) this._safe(() => this._emitStats());
  }

  _emitStats() {
    this._dispatch('stats', {
      mempoolInfo: this.mempoolInfo,
      fees: this.fees,
      vBytesPerSecond: this.vBytesPerSecond,
      price: this.price,
    });
  }

  // ---- tx stream (live: full objects) ------------------------------------

  _handleMempoolTransactions(delta) {
    this._checkSequence(delta.sequence);
    const added = Array.isArray(delta.added) ? delta.added : [];
    this._recordStreamSample(added.length);

    const max = this.config.stream.maxClassifyPerBatch;
    let classified = 0;
    for (let i = 0; i < added.length && classified < max; i++) {
      const tx = added[i];
      try {
        const verdict = this._classify(tx);
        this._dispatch('tx', { tx, verdict });
        classified += 1;
      } catch (e) {
        /* skip one bad tx */
      }
    }
    // Over budget, the remainder of this batch (added.length - classified) is
    // intentionally dropped: the hot-stream detector below downgrades to
    // txid-only + REST sampling, and the "observed" tile is labeled as a sample.
    this._maybeDowngrade();
  }

  // ---- tx stream (degraded: txids only, REST-sampled) --------------------

  _handleMempoolTxids(delta) {
    this._checkSequence(delta.sequence);
    const added = Array.isArray(delta.added) ? delta.added : [];
    this._recordStreamSample(added.length);

    const sampleMax = this.config.stream.sampleMaxPerBatch;
    let sampled = 0;
    for (let i = 0; i < added.length && sampled < sampleMax; i++) {
      if (!this._tokenAvailable()) break;
      sampled += 1;
      this._sampleTx(added[i]);
    }
    this._maybeUpgrade();
  }

  async _sampleTx(txid) {
    const tx = await this._restJson('/api/tx/' + txid, { sample: true });
    if (tx && this._classify) {
      try {
        this._dispatch('tx', { tx, verdict: this._classify(tx) });
      } catch (e) {
        /* skip */
      }
    }
  }

  // ---- sequence gaps ------------------------------------------------------

  _checkSequence(seq) {
    if (typeof seq !== 'number') return;
    if (this._lastSeq != null && seq > this._lastSeq + 1) {
      // Missed one or more delta cycles — re-assert subscriptions to be safe.
      this._safe(() => this._resubscribe());
    }
    this._lastSeq = seq;
  }

  _resubscribe() {
    if (this.mode === 'degraded') {
      this._wsSend({ action: 'want', data: this.config.ws.want });
      this._wsSend({ 'track-mempool-txids': true });
    } else {
      this._subscribeLive();
    }
  }

  // ---- hot-stream detection ----------------------------------------------

  _recordStreamSample(n) {
    const now = Date.now();
    this._streamSamples.push({ t: now, n });
    const cutoff = now - this.config.hotStream.windowMs;
    while (this._streamSamples.length && this._streamSamples[0].t < cutoff) {
      this._streamSamples.shift();
    }
  }

  // Returns {rate, perUpdate, full} for the rolling window.
  _streamStats() {
    const s = this._streamSamples;
    if (s.length < 2) return { rate: 0, perUpdate: 0, full: false };
    let total = 0;
    for (const x of s) total += x.n;
    const spanMs = s[s.length - 1].t - s[0].t;
    const seconds = spanMs / 1000 || 1;
    return {
      rate: total / seconds,
      perUpdate: total / s.length,
      full: spanMs >= this.config.hotStream.windowMs * 0.9,
    };
  }

  _maybeDowngrade() {
    if (this.mode !== 'live') return;
    const { rate, perUpdate, full } = this._streamStats();
    if (!full) return; // must be sustained across the window
    const cfg = this.config.hotStream;
    if (perUpdate > cfg.addedPerUpdate || rate > cfg.txPerSecond) {
      this._wsSend({ 'track-mempool': false });
      this._wsSend({ 'track-mempool-txids': true });
      this._streamSamples = [];
      this._emitStatus('degraded', 'stream hot — sampling via REST');
    }
  }

  _maybeUpgrade() {
    if (this.mode !== 'degraded') return;
    const { rate, full } = this._streamStats();
    if (!full) return;
    if (rate < this.config.hotStream.unDowngradeTxPerSecond) {
      this._wsSend({ 'track-mempool-txids': false });
      this._wsSend({ 'track-mempool': true });
      this._streamSamples = [];
      this._emitStatus('live', 'stream cooled — full tx stream restored');
    }
  }

  // ---- block events -------------------------------------------------------

  _handleBlock(msg) {
    const block = msg.block;
    // mined[] pairs from whichever stream is active
    const mt = msg['mempool-transactions'];
    const mtx = msg['mempool-txids'];
    const mined =
      (mt && Array.isArray(mt.mined) && mt.mined) ||
      (mtx && Array.isArray(mtx.mined) && mtx.mined) ||
      [];
    const minedTxids = new Set(mined);

    // Fire immediately; the full report follows async.
    this._dispatch('block', { block, minedTxids, report: null });

    // Full raw-block scan (no sampling bias).
    this._scanBlock(block, 'blockreport');
  }

  async _scanBlock(block, eventName) {
    if (!block || !block.id) return;
    try {
      const buf = await this._restArrayBuffer('/api/block/' + block.id + '/raw');
      if (!buf) return;
      const bytes = new Uint8Array(buf);
      const parsed = this._parseRawBlock(bytes); // {header, txs}
      if (!parsed || !Array.isArray(parsed.txs)) return;
      const report = await this._classifyBlockChunked(parsed.txs, block);
      this._dispatch(eventName, { block, report });
    } catch (e) {
      // A failed raw fetch/parse must never kill the loop.
      this._emitStatus(this.mode, 'block scan failed: ' + e.message);
    }
  }

  // Classify a full block in idle-time slices so the battle never stutters.
  _classifyBlockChunked(txs, blockMeta) {
    return new Promise((resolve) => {
      const classified = [];
      const slice = this.config.rawBlock.sliceSize;
      let i = 0;
      const step = () => {
        const end = Math.min(i + slice, txs.length);
        for (; i < end; i++) {
          const tx = txs[i];
          if (isCoinbase(tx, i)) continue;
          let verdict = null;
          try {
            verdict = this._classify(tx);
          } catch (e) {
            verdict = null;
          }
          classified.push({ tx, verdict });
        }
        if (i < txs.length) {
          setTimeout(step, 0);
        } else {
          resolve(reduceReport(classified, blockMeta, txs, this.config));
        }
      };
      step();
    });
  }

  // ---- init + backfill ----------------------------------------------------

  async _init() {
    let blocks = null;
    try {
      blocks = await this._restJson('/api/v1/blocks');
    } catch (e) {
      /* handled below */
    }
    if (!Array.isArray(blocks)) return;
    this.recentBlocks = blocks;

    // Raw-scan the N most recent blocks, spaced out, dispatched as 'backfill'.
    const n = this.config.backfill.blockCount;
    const targets = blocks.slice(0, n);
    targets.forEach((b, idx) => {
      setTimeout(() => {
        if (!this.stopped) this._scanBlock(b, 'backfill');
      }, idx * this.config.backfill.spacingMs);
    });
  }

  // ---- price poll ---------------------------------------------------------

  _startPricePoll() {
    const poll = async () => {
      if (this.stopped) return;
      try {
        const p = await this._restJson('/api/v1/prices');
        if (p && typeof p.USD === 'number') {
          this.price = p.USD;
          this._emitStats();
        }
      } catch (e) {
        /* ignore — price is cosmetic */
      }
    };
    poll();
    this._priceTimer = setInterval(poll, this.config.pollMs.price);
  }

  // ---- REST + token bucket ------------------------------------------------

  _refillTokens() {
    const now = Date.now();
    const elapsed = (now - this._lastRefill) / 1000;
    this.tokens = Math.min(
      this.config.tokenBucket.capacity,
      this.tokens + elapsed * this.config.tokenBucket.refillPerSec
    );
    this._lastRefill = now;
  }

  _tokenAvailable() {
    this._refillTokens();
    return this.tokens >= 1;
  }

  // Acquire a token. Blocking acquires wait up to maxWaitMs; non-blocking
  // (sampling) acquires give up immediately if the bucket is empty.
  _acquireToken(nonBlocking) {
    this._refillTokens();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return Promise.resolve(true);
    }
    if (nonBlocking) return Promise.resolve(false);
    return new Promise((resolve) => {
      const start = Date.now();
      const check = () => {
        this._refillTokens();
        if (this.tokens >= 1) {
          this.tokens -= 1;
          resolve(true);
          return;
        }
        if (Date.now() - start > this.config.tokenBucket.maxWaitMs) {
          resolve(false);
          return;
        }
        setTimeout(check, 200);
      };
      setTimeout(check, 200);
    });
  }

  async _restFetch(path, opts = {}) {
    const ok = await this._acquireToken(!!opts.sample);
    if (!ok) return null;
    const url = this._restBase() + path;
    try {
      const res = await fetch(url);
      if (res.status === 429) {
        this._onRestFailure('rate limited (429)');
        return null;
      }
      if (!res.ok) {
        this._onRestFailure('HTTP ' + res.status);
        return null;
      }
      this.consecutiveRestFailures = 0;
      return res;
    } catch (e) {
      this._onRestFailure(e.message);
      return null;
    }
  }

  async _restJson(path, opts) {
    const res = await this._restFetch(path, opts);
    return res ? res.json() : null;
  }

  async _restArrayBuffer(path, opts) {
    const res = await this._restFetch(path, opts);
    return res ? res.arrayBuffer() : null;
  }

  _onRestFailure(message) {
    this.consecutiveRestFailures += 1;
    if (this.consecutiveRestFailures >= this.config.rotation.afterFailures) {
      this._rotateHost();
      this.consecutiveRestFailures = 0;
      this._emitStatus(this.mode, 'REST failing (' + message + ') — rotated host');
    }
  }
}

export default MempoolFeed;
