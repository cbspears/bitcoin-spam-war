// rawtx.js — pure raw Bitcoin transaction + block parser.
// Produces objects shaped like mempool.space's GET /api/tx/:txid JSON so the
// same classifyTx() can consume both a live API tx and a locally-parsed block tx.
//
// Notes / constraints:
//  - txid = reversed-hex double-SHA256 of the NON-witness (legacy) serialization
//    (version || vin || vout || locktime — no marker/flag/witness). wtxid unused.
//  - weight = base*3 + total (base = legacy-serialization size, total = full size
//    including marker/flag/witness), per BIP141; vsize = ceil(weight/4).
//  - raw-block txs have no prevout data, so vin[].prevout is null (rule 3 + per-tx
//    fee are unavailable downstream — the classifier skips rule 3 when prevout null).

import { hash256 } from './sha256.js';

const HEX = [];
for (let i = 0; i < 256; i++) HEX[i] = i.toString(16).padStart(2, '0');

function bytesToHex(bytes, start = 0, end = bytes.length) {
  let s = '';
  for (let i = start; i < end; i++) s += HEX[bytes[i]];
  return s;
}

// A tiny cursor over a Uint8Array with little-endian integer readers.
class Reader {
  constructor(bytes, offset = 0) { this.b = bytes; this.i = offset; }
  u8() { return this.b[this.i++]; }
  u16() { const v = this.b[this.i] | (this.b[this.i + 1] << 8); this.i += 2; return v >>> 0; }
  u32() {
    const b = this.b, i = this.i; this.i += 4;
    return (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
  }
  // 64-bit LE as a JS Number (safe: satoshi amounts < 2^53).
  u64() {
    const lo = this.u32();
    const hi = this.u32();
    return hi * 0x100000000 + lo;
  }
  varint() {
    const v = this.u8();
    if (v < 0xfd) return v;
    if (v === 0xfd) return this.u16();
    if (v === 0xfe) return this.u32();
    return this.u64();
  }
  slice(n) { const s = this.b.subarray(this.i, this.i + n); this.i += n; return s; }
}

/**
 * Minimal scriptPubKey type derivation — enough for classifyTx (op_return,
 * multisig, the witness-program families, p2pkh, p2sh, anchor/P2A, else unknown).
 * Trusts structure, not loose byte patterns (avoids the P2TR-looks-like-multisig
 * false positive by requiring a full OP_M ...pubkeys... OP_N OP_CHECKMULTISIG parse).
 * @param {Uint8Array} spk
 * @returns {string}
 */
export function deriveScriptType(spk) {
  const n = spk.length;
  if (n === 0) return 'unknown';
  if (spk[0] === 0x6a) return 'op_return';
  if (n === 25 && spk[0] === 0x76 && spk[1] === 0xa9 && spk[2] === 0x14 &&
      spk[23] === 0x88 && spk[24] === 0xac) return 'p2pkh';
  if (n === 23 && spk[0] === 0xa9 && spk[1] === 0x14 && spk[22] === 0x87) return 'p2sh';
  if (n === 22 && spk[0] === 0x00 && spk[1] === 0x14) return 'v0_p2wpkh';
  if (n === 34 && spk[0] === 0x00 && spk[1] === 0x20) return 'v0_p2wsh';
  if (n === 34 && spk[0] === 0x51 && spk[1] === 0x20) return 'v1_p2tr';
  if (n === 4 && spk[0] === 0x51 && spk[1] === 0x02 && spk[2] === 0x4e && spk[3] === 0x73) return 'anchor';
  if (isBareMultisig(spk)) return 'multisig';
  return 'unknown';
}

// Structural bare-multisig test: OP_M <push>xN OP_N OP_CHECKMULTISIG, exactly.
function isBareMultisig(spk) {
  const n = spk.length;
  if (n < 4 || spk[n - 1] !== 0xae) return false;         // OP_CHECKMULTISIG
  if (spk[0] < 0x51 || spk[0] > 0x60) return false;        // OP_M in 1..16
  const nByte = spk[n - 2];
  if (nByte < 0x51 || nByte > 0x60) return false;          // OP_N in 1..16
  const M = spk[0] - 0x50, N = nByte - 0x50;
  let i = 1, keys = 0;
  while (i < n - 2) {
    const op = spk[i];
    if (op >= 0x01 && op <= 0x4b) { i += 1 + op; keys++; }  // direct data push
    else return false;                                      // pubkeys are direct pushes
  }
  return i === n - 2 && keys === N && M >= 1 && M <= N;
}

/**
 * Parse a single transaction.
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @returns {{tx: object, bytesRead: number}}
 */
export function parseRawTx(bytes, offset = 0) {
  const r = new Reader(bytes, offset);
  const start = r.i;
  const version = r.u32();
  const inputsStart = r.i;             // byte position where the legacy body begins
  let segwit = false;

  let nIn = r.varint();
  let bodyStart = inputsStart;         // start of (vin count..vout end) region for stripped hash
  if (nIn === 0) {                     // segwit marker 0x00, flag byte follows
    const flag = r.u8();               // eslint-disable-line no-unused-vars
    segwit = true;
    bodyStart = r.i;                   // skip marker+flag: legacy body = vin count onward
    nIn = r.varint();
  }

  const vin = [];
  for (let k = 0; k < nIn; k++) {
    const prevHash = r.slice(32);      // stored little-endian on the wire
    const prevN = r.u32();
    const sLen = r.varint();
    const scriptsig = r.slice(sLen);
    const sequence = r.u32();
    const txidBE = bytesToHex(reversed(prevHash));
    const isCoinbase = prevN === 0xffffffff && isAllZero(prevHash);
    vin.push({
      txid: txidBE,
      vout: prevN,
      prevout: null,
      scriptsig: bytesToHex(scriptsig),
      witness: [],
      is_coinbase: isCoinbase,
      sequence
    });
  }

  const nOut = r.varint();
  const vout = [];
  for (let k = 0; k < nOut; k++) {
    const value = r.u64();
    const sLen = r.varint();
    const spk = r.slice(sLen);
    vout.push({
      scriptpubkey: bytesToHex(spk),
      scriptpubkey_type: deriveScriptType(spk),
      value
    });
  }
  const bodyEnd = r.i;                  // end of vout region

  if (segwit) {
    for (let k = 0; k < nIn; k++) {
      const nItems = r.varint();
      const items = [];
      for (let w = 0; w < nItems; w++) {
        const iLen = r.varint();
        items.push(bytesToHex(r.slice(iLen)));
      }
      vin[k].witness = items;
    }
  }

  const locktimeStart = r.i;
  const locktime = r.u32();
  const end = r.i;

  // Non-witness (legacy) serialization for the txid: version || body || locktime.
  const base = 4 + (bodyEnd - bodyStart) + 4;
  let stripped;
  if (segwit) {
    stripped = new Uint8Array(base);
    stripped.set(bytes.subarray(start, start + 4), 0);
    stripped.set(bytes.subarray(bodyStart, bodyEnd), 4);
    stripped.set(bytes.subarray(locktimeStart, locktimeStart + 4), 4 + (bodyEnd - bodyStart));
  } else {
    stripped = bytes.subarray(start, end);
  }
  const txid = bytesToHex(reversed(hash256(stripped)));

  const total = end - start;
  const weight = base * 3 + total;
  const vsize = Math.ceil(weight / 4);

  const tx = {
    txid,
    version,
    locktime,
    size: total,
    weight,
    vsize,
    vin,
    vout,
    fee: null
  };
  return { tx, bytesRead: end - offset };
}

/**
 * Parse a full raw block (80-byte header, then a varint tx count, then txs).
 * @param {Uint8Array} bytes
 * @returns {{header: {version:number, time:number, bits:number, prevHash:string, merkleRoot:string, nonce:number}, txs: object[]}}
 */
export function parseRawBlock(bytes) {
  const r = new Reader(bytes, 0);
  const version = r.u32();
  const prevHash = bytesToHex(reversed(r.slice(32)));
  const merkleRoot = bytesToHex(reversed(r.slice(32)));
  const time = r.u32();
  const bits = r.u32();
  const nonce = r.u32();
  const nTx = r.varint();

  const txs = [];
  let off = r.i;
  for (let k = 0; k < nTx; k++) {
    const { tx, bytesRead } = parseRawTx(bytes, off);
    txs.push(tx);
    off += bytesRead;
  }
  return { header: { version, time, bits, prevHash, merkleRoot, nonce }, txs };
}

function reversed(bytes) {
  const n = bytes.length;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = bytes[n - 1 - i];
  return out;
}

function isAllZero(bytes) {
  for (let i = 0; i < bytes.length; i++) if (bytes[i] !== 0) return false;
  return true;
}
