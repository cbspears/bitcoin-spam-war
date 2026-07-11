// test/integration.check.mjs — NODE-ONLY integration harness (kept, not a unit test).
//
// Drives the REAL MempoolFeed (js/feed.js) end-to-end with a fake WebSocket and
// a fake fetch, using the actual classify.js + rawtx.js modules (loaded via the
// feed's own dynamic import). It:
//   1. delivers a captured real inscription tx as a 'mempool-transactions' added
//      delta and asserts a SPEC-shaped 'tx' {tx, verdict} event fires;
//   2. delivers a ws 'block' and serves a fabricated 2-tx RAW BLOCK (real coinbase
//      + a real tx from test/fixtures/rawtx-selfcheck.json) for /api/block/:id/raw,
//      then asserts SPEC-shaped 'block' {block,minedTxids,report} and 'blockreport'
//      {block,report} events fire, with the report carrying the exact contract keys.
//
// Run: node test/integration.check.mjs   (exit 0 = pass, non-zero = fail)
// This file is intentionally standalone (not picked up by `node --test`, which it
// would be if named *.test.mjs) so the real WS/fetch stubs never leak into unit runs.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(__dirname, 'fixtures');

function hexToBytes(hex) {
  const n = hex.length >> 1;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

// --- Build a fabricated 2-tx raw block: real coinbase + a real fixture tx ------
// Legacy (non-segwit) coinbase: version|1-in(null prevout,ffffffff)|1-out|locktime.
const COINBASE_HEX =
  '01000000' +                                     // version
  '01' +                                           // vin count
  '00'.repeat(32) + 'ffffffff' +                   // null prevout + index
  '0100' +                                         // scriptSig len 1 + OP_0
  'ffffffff' +                                     // sequence
  '01' +                                           // vout count
  '00f2052a01000000' +                             // value (50 BTC LE)
  '00' +                                           // scriptPubKey len 0
  '00000000';                                      // locktime

const selfcheck = JSON.parse(fs.readFileSync(path.join(FIX, 'rawtx-selfcheck.json'), 'utf8'));

const HEADER_HEX =
  '10000020' +          // version 0x20000010 LE (header value; report uses ws block.version)
  '11'.repeat(32) +     // prevHash
  '22'.repeat(32) +     // merkleRoot
  '00000000' +          // time
  'ffff001d' +          // bits
  '00000000';           // nonce
const RAW_BLOCK_HEX = HEADER_HEX + '02' + COINBASE_HEX + selfcheck.hex; // varint 2 txs
const RAW_BLOCK_BYTES = hexToBytes(RAW_BLOCK_HEX);

const BLOCK_ID = 'deadbeefcafeblockid';
const inscriptionTx = JSON.parse(
  fs.readFileSync(path.join(FIX, '1f122ba9c7228dfcabd2cec75e396809c29d3be91bcc82e6cdfeeea0c4e578aa.json'), 'utf8')
);

// --- Fake WebSocket ----------------------------------------------------------
let liveWS = null;
class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0; // CONNECTING
    this.sent = [];
    this.onopen = this.onmessage = this.onerror = this.onclose = null;
    liveWS = this;
  }
  send(data) { this.sent.push(data); }
  close() { this.readyState = 3; }
  // test helpers
  _open() { this.readyState = 1; if (this.onopen) this.onopen(); }
  _emit(obj) { if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) }); }
}

// --- Fake fetch (matches only the endpoints the feed hits at boot) -----------
function jsonResponse(body) {
  return Promise.resolve({
    ok: true, status: 200,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
  });
}
function bufResponse(bytes) {
  return Promise.resolve({
    ok: true, status: 200,
    json: () => Promise.resolve(null),
    text: () => Promise.resolve(''),
    // return a copy so the feed's Uint8Array view is independent
    arrayBuffer: () => Promise.resolve(bytes.slice().buffer),
  });
}
function fakeFetch(url) {
  const u = String(url);
  if (u.endsWith('/api/v1/blocks')) return jsonResponse([]);       // no backfill noise
  if (u.endsWith('/api/v1/prices')) return jsonResponse({ USD: 65000 });
  if (u.includes('/api/block/') && u.endsWith('/raw')) {
    assert.ok(u.includes(BLOCK_ID), `raw-block fetch should target the ws block id, got ${u}`);
    return bufResponse(RAW_BLOCK_BYTES);
  }
  return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve(null), text: () => Promise.resolve(''), arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) });
}

// --- install stubs, then import the feed -------------------------------------
globalThis.WebSocket = FakeWebSocket;
globalThis.fetch = fakeFetch;

const { MempoolFeed } = await import('../js/feed.js');
const { CONFIG } = await import('../js/config.js');

const events = { tx: [], block: [], blockreport: [], status: [], stats: [] };
const feed = new MempoolFeed(CONFIG);
for (const name of Object.keys(events)) {
  feed.addEventListener(name, (e) => events[name].push(e.detail));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms = 4000, label = 'condition') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (pred()) return; await sleep(15); }
  throw new Error(`timeout waiting for ${label}`);
}

let failed = false;
function check(name, fn) {
  return (async () => {
    try { await fn(); console.log(`ok   ${name}`); }
    catch (e) { failed = true; console.error(`FAIL ${name}\n     ${e.message}`); }
  })();
}

feed.start();

// wait for _boot() to finish its dynamic imports + open the fake socket
await waitFor(() => liveWS != null, 4000, 'feed to construct the WebSocket');
liveWS._open();

await check('boot: classify.js + rawtx.js loaded via dynamic import', async () => {
  assert.equal(typeof feed._classify, 'function', 'classifyTx should be cached on the feed');
  assert.equal(typeof feed._parseRawBlock, 'function', 'parseRawBlock should be cached on the feed');
});

await check("status: 'live' emitted on socket open", async () => {
  await waitFor(() => events.status.some((s) => s.mode === 'live'), 2000, "a 'live' status");
  const s = events.status.find((x) => x.mode === 'live');
  assert.deepEqual(Object.keys(s).sort(), ['connected', 'message', 'mode'].sort());
  assert.equal(s.connected, true);
});

// 1) a real inscription tx arriving on the full-tx stream ---------------------
await check("'tx' event fires with SPEC-shaped {tx, verdict}", async () => {
  liveWS._emit({ 'mempool-transactions': { added: [inscriptionTx], sequence: 1 } });
  await waitFor(() => events.tx.length > 0, 2000, "a 'tx' event");
  const d = events.tx[0];
  assert.deepEqual(Object.keys(d).sort(), ['tx', 'verdict'], "'tx' detail must be exactly {tx, verdict}");
  assert.equal(d.tx.txid, inscriptionTx.txid, 'the streamed tx is passed through untouched');
  const v = d.verdict;
  for (const k of ['archetype', 'compliant', 'violations', 'protocol', 'faction', 'label', 'emoji', 'details', 'dataBytes', 'contentType', 'payloadPreview']) {
    assert.ok(k in v, `verdict is missing SPEC key '${k}'`);
  }
  assert.ok(['violator', 'infiltrator', 'citizen'].includes(v.archetype), 'archetype enum');
  assert.equal(v.protocol, 'inscription', 'the captured tx is an inscription');
  assert.equal(v.archetype, 'violator', 'an inscription envelope violates rule 7');
  assert.ok(Array.isArray(v.violations) && v.violations.length > 0, 'violator has violations[]');
});

// 2) a new block + raw-block roundtrip ----------------------------------------
await check("'block' event fires immediately with {block, minedTxids:Set, report:null}", async () => {
  const wsBlock = {
    id: BLOCK_ID, height: 957515, version: 0x20000010,
    tx_count: 2, extras: { pool: { slug: 'foundry', name: 'Foundry USA' } },
  };
  liveWS._emit({ block: wsBlock, 'mempool-transactions': { mined: [selfcheck.txid] } });
  await waitFor(() => events.block.length > 0, 2000, "a 'block' event");
  const d = events.block[0];
  assert.deepEqual(Object.keys(d).sort(), ['block', 'minedTxids', 'report'], "'block' detail keys");
  assert.equal(d.report, null, 'block.report is null until the scan completes');
  assert.ok(d.minedTxids instanceof Set, 'minedTxids is a Set');
  assert.ok(d.minedTxids.has(selfcheck.txid), 'mined[] txids flow into the Set');
});

await check("'blockreport' fires after raw parse+classify with the full report contract", async () => {
  await waitFor(() => events.blockreport.length > 0, 4000, "a 'blockreport' event");
  const d = events.blockreport[0];
  assert.deepEqual(Object.keys(d).sort(), ['block', 'report'], "'blockreport' detail keys");
  const r = d.report;
  for (const k of ['height', 'id', 'totalTx', 'scannedTx', 'counts', 'spamVBytes', 'totalVBytes', 'spamShare', 'signaling', 'pool', 'topOffenders', 'pure']) {
    assert.ok(k in r, `report is missing SPEC key '${k}'`);
  }
  // coinbase (index 0) excluded from the scan, kept in the denominator
  assert.equal(r.totalTx, 2, 'totalTx counts every tx incl. coinbase');
  assert.equal(r.scannedTx, 1, 'scannedTx excludes the coinbase');
  assert.ok(r.counts.byArchetype && typeof r.counts.byArchetype.violator === 'number', 'counts.byArchetype shape (the hud/battle contract)');
  assert.ok(r.counts.byProtocol && typeof r.counts.byProtocol === 'object', 'counts.byProtocol present');
  assert.ok(r.totalVBytes > 0, 'totalVBytes includes the coinbase weight');
  assert.equal(r.signaling, true, 'ws block.version 0x20000010 signals bit-4');
  assert.equal(r.pool.slug, 'foundry', 'pool carried from block.extras');
  assert.equal(r.height, 957515, 'height carried from the ws block');
  assert.ok(Array.isArray(r.topOffenders), 'topOffenders is an array');
  assert.equal(typeof r.pure, 'boolean', 'pure is boolean');
});

feed.stop();
await sleep(20);

// Use process.exitCode (not process.exit) so this file is well-behaved both when
// run standalone (`node test/integration.check.mjs`) AND when node's test runner
// picks it up via the test/ directory glob — a forced exit would fight the runner.
if (failed) { console.error('\nINTEGRATION HARNESS: FAIL'); process.exitCode = 1; }
else { console.log('\nINTEGRATION HARNESS: PASS'); }
