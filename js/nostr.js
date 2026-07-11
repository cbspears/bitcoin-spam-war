// js/nostr.js — pure Nostr transport for Trench Chat (NIP-28 kind-42 over
// public relays). No DOM. Uses the committed vendored crypto bundle for
// BIP-340 schnorr + sha256. Everything here is verified against
// docs/research/nostr.json (relay behavior, wire frames, id serialization).
//
// Exports:
//   class RelayPool                         — connections, subscribe, publish
//   function buildSignedEvent({...})        — sign a kind-42 event (NIP-01)
//   function verifyEvent(e)                 — recompute id + schnorr verify
//   function burnerIdentity(storage)        — persisted browser burner key
//   function defaultNick(pubHex)            — deterministic war-name from pubkey

import {
  schnorrSign,
  schnorrVerify,
  getPublicKeyX,
  sha256,
  randomPrivateKey,
  bytesToHex,
  hexToBytes,
} from './vendor/nostr-crypto.js';

const enc = new TextEncoder();

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

// --- NIP-01 event id serialization -----------------------------------------
// id = sha256 over the UTF-8 BYTES of JSON.stringify of the 6-element array
// [0, pubkey, created_at, kind, tags, content]. Native JSON.stringify already
// produces NIP-01-compliant escaping (verified byte-exact in research). Never
// hand-concatenate — the array-stringify IS the spec.
function serializeForId(e) {
  return enc.encode(
    JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]),
  );
}

function toSk(privkey) {
  if (privkey instanceof Uint8Array) return privkey;
  if (typeof privkey === 'string' && HEX64.test(privkey)) return hexToBytes(privkey);
  throw new Error('buildSignedEvent: privkey must be 32-byte Uint8Array or 64-char hex');
}

/**
 * Build + sign a Nostr event. created_at is forced to an integer second so the
 * signer and any verifier serialize identical bytes (float timestamps would
 * diverge — see research gotcha).
 */
export function buildSignedEvent({ kind, tags, content, privkey, created_at }) {
  const sk = toSk(privkey);
  const ev = {
    pubkey: bytesToHex(getPublicKeyX(sk)),
    created_at: Number.isInteger(created_at) ? created_at : Math.floor(Date.now() / 1000),
    kind,
    tags: tags || [],
    content: content == null ? '' : String(content),
  };
  const idBytes = sha256(serializeForId(ev));
  ev.id = bytesToHex(idBytes);
  ev.sig = bytesToHex(schnorrSign(idBytes, sk));
  return ev;
}

/**
 * Recompute the id and verify the schnorr signature of an incoming event.
 * Returns boolean; never throws (schnorrVerify returns false on malformed
 * input, and every field is shape-checked first).
 */
export function verifyEvent(e) {
  try {
    if (!e || typeof e !== 'object') return false;
    if (typeof e.id !== 'string' || typeof e.pubkey !== 'string' || typeof e.sig !== 'string') return false;
    if (!HEX64.test(e.id) || !HEX64.test(e.pubkey) || !HEX128.test(e.sig)) return false;
    if (!Number.isInteger(e.created_at) || !Number.isInteger(e.kind)) return false;
    if (!Array.isArray(e.tags) || typeof e.content !== 'string') return false;
    const idBytes = sha256(serializeForId(e));
    if (bytesToHex(idBytes) !== e.id) return false;
    return schnorrVerify(hexToBytes(e.sig), idBytes, hexToBytes(e.pubkey));
  } catch (_) {
    return false;
  }
}

// --- Burner identity --------------------------------------------------------
const WAR_NAMES = [
  'Wizard', 'Spammer', 'Degen', 'Knight', 'Filter', 'Ordinal', 'Runecaster',
  'Jeet', 'Maxi', 'Node', 'Miner', 'Frog', 'Puppet', 'Monke', 'Stamper',
  'Pepe', 'Shitposter', 'Anon', 'Grunt', 'Sapper', 'Trench', 'Warlord',
  'Zealot', 'Cypher', 'Sat', 'Whale', 'Mempool', 'Relay', 'Envelope',
  'Bagholder', 'Sybil', 'Inscriber', 'Purist', 'Heretic',
];

/** Deterministic default nick from an x-only pubkey hex: "Wizard-3fa9". */
export function defaultNick(pubHex) {
  const idx = parseInt(pubHex.slice(0, 8), 16) % WAR_NAMES.length;
  return `${WAR_NAMES[idx]}-${pubHex.slice(-4)}`;
}

/**
 * Load-or-mint a persistent browser burner identity. Private key lives in
 * localStorage (`tbfb-nostr-key`); a chosen nick in `tbfb-nick`. Returns
 * {priv (hex), pub (hex), nick}. `storage` is any Storage-like object.
 */
export function burnerIdentity(storage) {
  let privHex = null;
  try { privHex = storage.getItem('tbfb-nostr-key'); } catch (_) { /* ignore */ }
  let sk;
  if (privHex && HEX64.test(privHex)) {
    sk = hexToBytes(privHex);
  } else {
    sk = randomPrivateKey();
    privHex = bytesToHex(sk);
    try { storage.setItem('tbfb-nostr-key', privHex); } catch (_) { /* ignore */ }
  }
  const pub = bytesToHex(getPublicKeyX(sk));
  let nick = null;
  try { nick = storage.getItem('tbfb-nick'); } catch (_) { /* ignore */ }
  if (!nick || typeof nick !== 'string') nick = defaultNick(pub);
  return { priv: privHex, pub, nick };
}

// --- RelayPool --------------------------------------------------------------
// Manages one WebSocket per relay with independent exponential-backoff + jitter
// reconnect. Dedupes events by id per subscription, verifies id+sig, drops
// non-kind-42 and far-future events, and matches per-event OK frames on publish
// with a ~10s timeout. NEVER counts a write relay toward durability unless it is
// in `countUrls` (nostr.mom shadow-accepts kind-42 then drops it silently).
export class RelayPool {
  constructor({ readUrls = [], writeUrls = [], countUrls = [], backoff, WebSocketImpl } = {}) {
    this.readUrls = Array.from(new Set(readUrls));
    this.writeUrls = Array.from(new Set(writeUrls));
    this.countUrls = new Set(countUrls);
    this.urls = Array.from(new Set([...this.readUrls, ...this.writeUrls]));
    const bo = backoff || {};
    this.backoffSchedule = bo.scheduleMs || [1000, 2000, 4000, 8000, 15000, 30000];
    this.jitter = bo.jitter == null ? 0.25 : bo.jitter;
    this.capMs = bo.capMs == null ? 30000 : bo.capMs;
    this.okTimeoutMs = 10000;
    this._WS = WebSocketImpl || (typeof WebSocket !== 'undefined' ? WebSocket : null);
    this.conns = new Map();   // url -> {url, ws, open, attempt, timer, isRead, isWrite}
    this.subs = new Map();    // subId -> {filters, onEvent, onEose, seen:Set, eosed}
    this.pending = new Map(); // eventId -> {sentUrls:Set, okByUrl:Map, resolve, done, timer, settle}
    this._statusCb = null;
    this._closed = false;
  }

  connect() {
    if (!this._WS) return;
    for (const url of this.urls) this._open(url);
  }

  onStatus(cb) { this._statusCb = cb; this._emitStatus(); }

  _emitStatus() {
    if (!this._statusCb) return;
    let readOpen = 0;
    for (const url of this.readUrls) {
      const c = this.conns.get(url);
      if (c && c.open) readOpen++;
    }
    let open = 0;
    for (const [, c] of this.conns) if (c.open) open++;
    try { this._statusCb({ readOpen, readTotal: this.readUrls.length, open }); } catch (_) { /* ignore */ }
  }

  _open(url) {
    if (this._closed || !this._WS) return;
    let conn = this.conns.get(url);
    if (!conn) { conn = { url, ws: null, open: false, attempt: 0, timer: null }; this.conns.set(url, conn); }
    conn.isRead = this.readUrls.includes(url);
    conn.isWrite = this.writeUrls.includes(url);
    let ws;
    try { ws = new this._WS(url); } catch (_) { this._scheduleReconnect(url); return; }
    conn.ws = ws;
    conn.open = false;
    ws.onopen = () => {
      if (conn.ws !== ws) return;
      conn.open = true;
      conn.attempt = 0;
      if (conn.isRead) for (const [subId, sub] of this.subs) this._sendReq(url, subId, sub);
      this._emitStatus();
    };
    ws.onmessage = (msg) => this._onMessage(url, msg.data);
    ws.onerror = () => { /* close handler drives reconnect */ };
    ws.onclose = () => {
      if (conn.ws === ws) { conn.ws = null; conn.open = false; }
      this._emitStatus();
      this._scheduleReconnect(url);
    };
  }

  _scheduleReconnect(url) {
    if (this._closed) return;
    const conn = this.conns.get(url) || { url, ws: null, open: false, attempt: 0, timer: null };
    this.conns.set(url, conn);
    const i = Math.min(conn.attempt, this.backoffSchedule.length - 1);
    let delay = Math.min(this.backoffSchedule[i], this.capMs);
    delay = delay * (1 + (Math.random() * 2 - 1) * this.jitter);
    delay = Math.max(250, delay);
    conn.attempt += 1;
    clearTimeout(conn.timer);
    conn.timer = setTimeout(() => this._open(url), delay);
  }

  _onMessage(url, data) {
    let frame;
    try { frame = JSON.parse(typeof data === 'string' ? data : String(data)); } catch (_) { return; }
    if (!Array.isArray(frame) || frame.length === 0) return;
    switch (frame[0]) {
      case 'EVENT':
        this._handleEvent(frame[1], frame[2]);
        break;
      case 'EOSE': {
        const sub = this.subs.get(frame[1]);
        if (sub && !sub.eosed) {
          sub.eosed = true;
          try { if (sub.onEose) sub.onEose(); } catch (_) { /* ignore */ }
        }
        break;
      }
      case 'OK':
        this._handleOk(url, frame[1], !!frame[2], typeof frame[3] === 'string' ? frame[3] : '');
        break;
      // NOTICE / AUTH / CLOSED / anything else: ignore safely.
      default:
        break;
    }
  }

  _handleEvent(subId, e) {
    const sub = this.subs.get(subId);
    if (!sub) return;
    if (!e || typeof e !== 'object') return;
    if (e.kind !== 42) return;                         // drop non-chat kinds
    if (!Number.isInteger(e.created_at)) return;
    const now = Math.floor(Date.now() / 1000);
    if (e.created_at > now + 600) return;              // drop far-future (>10min)
    if (typeof e.id !== 'string' || sub.seen.has(e.id)) return; // dedupe across relays
    if (!verifyEvent(e)) return;                        // drop forged id/sig
    sub.seen.add(e.id);
    try { sub.onEvent(e); } catch (_) { /* ignore consumer errors */ }
  }

  _handleOk(url, eventId, ok, message) {
    const pend = this.pending.get(eventId);
    if (!pend) return;
    pend.okByUrl.set(url, { ok, message });
    for (const u of pend.sentUrls) if (!pend.okByUrl.has(u)) return; // still waiting
    pend.settle();
  }

  /**
   * subscribe(id, filters, onEvent, onEose)
   * filters: array of NIP-01 filter objects (REQ payload after the sub id).
   * onEvent: called once per unique, verified kind-42 event.
   * onEose:  called once, on the FIRST EOSE from any read relay.
   * Returns an unsubscribe function.
   */
  subscribe(id, filters, onEvent, onEose) {
    const sub = { filters: filters || [], onEvent, onEose, seen: new Set(), eosed: false };
    this.subs.set(id, sub);
    for (const url of this.readUrls) {
      const c = this.conns.get(url);
      if (c && c.open) this._sendReq(url, id, sub);
    }
    return () => this.unsubscribe(id);
  }

  _sendReq(url, id, sub) {
    const c = this.conns.get(url);
    if (!c || !c.open || !c.ws) return;
    try { c.ws.send(JSON.stringify(['REQ', id, ...sub.filters])); } catch (_) { /* ignore */ }
  }

  unsubscribe(id) {
    if (!this.subs.has(id)) return;
    this.subs.delete(id);
    for (const url of this.readUrls) {
      const c = this.conns.get(url);
      if (c && c.open && c.ws) { try { c.ws.send(JSON.stringify(['CLOSE', id])); } catch (_) { /* ignore */ } }
    }
  }

  /**
   * publish(event) -> Promise<{accepted:number, reasons:[{relay,ok,message}]}>
   * Sends to every currently-open write relay, resolves when all sent relays
   * have OK'd or ~10s elapses. `accepted` counts ONLY countUrls that returned
   * OK:true (durability), so nostr.mom's shadow-accept never inflates it.
   */
  publish(event) {
    const sentUrls = new Set();
    for (const url of this.writeUrls) {
      const c = this.conns.get(url);
      if (c && c.open && c.ws) {
        try { c.ws.send(JSON.stringify(['EVENT', event])); sentUrls.add(url); } catch (_) { /* ignore */ }
      }
    }
    return new Promise((resolve) => {
      const pend = { sentUrls, okByUrl: new Map(), resolve, done: false, timer: null, settle: null };
      pend.settle = () => {
        if (pend.done) return;
        pend.done = true;
        clearTimeout(pend.timer);
        this.pending.delete(event.id);
        const reasons = [];
        let accepted = 0;
        for (const url of this.writeUrls) {
          const r = pend.okByUrl.get(url);
          if (r) {
            reasons.push({ relay: url, ok: r.ok, message: r.message });
            if (r.ok && this.countUrls.has(url)) accepted += 1;
          } else {
            reasons.push({ relay: url, ok: false, message: sentUrls.has(url) ? 'timeout' : 'offline' });
          }
        }
        resolve({ accepted, reasons });
      };
      this.pending.set(event.id, pend);
      if (sentUrls.size === 0) { pend.settle(); return; }
      pend.timer = setTimeout(pend.settle, this.okTimeoutMs);
    });
  }

  close() {
    this._closed = true;
    for (const [, c] of this.conns) {
      clearTimeout(c.timer);
      if (c.ws) { try { c.ws.close(); } catch (_) { /* ignore */ } }
    }
    this.conns.clear();
    this.subs.clear();
    for (const [, p] of this.pending) { clearTimeout(p.timer); }
    this.pending.clear();
  }
}
