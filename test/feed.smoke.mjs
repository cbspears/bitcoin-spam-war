// test/feed.smoke.mjs — node18 smoke test for the feed's pure helpers.
//
// feed.js is import-safe in node (its browser-only siblings load via dynamic
// import inside start(), which we never call here). We unit-test the pure
// report builder + the BIP9 signaling check, then optionally ping the live
// API once (skips cleanly offline).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildBlockReport,
  reduceReport,
  isSignaling,
} from '../js/feed.js';
import { CONFIG } from '../js/config.js';

// A fake classifier keyed off txid — no need to load the real classify.js.
function fakeClassify(tx) {
  if (tx.txid === 'violator1') {
    return {
      archetype: 'violator',
      compliant: false,
      violations: [{ ruleId: '7', detail: 'tapscript executes OP_IF' }],
      protocol: 'inscription',
      faction: 'Taproot Wizards',
      label: 'Ordinal inscription (image/webp, 50 KB)',
      emoji: '🧙',
      details: [],
      dataBytes: 51200,
      contentType: 'image/webp',
      payloadPreview: null,
    };
  }
  if (tx.txid === 'violator2') {
    return {
      archetype: 'violator',
      compliant: false,
      violations: [{ ruleId: '1', detail: 'op_return > 83 bytes' }],
      protocol: 'op_return_large',
      faction: 'OP_RETURN',
      label: 'Large OP_RETURN',
      emoji: '📮',
      details: [],
      dataBytes: 400,
      contentType: null,
      payloadPreview: null,
    };
  }
  if (tx.txid === 'runes1') {
    return {
      archetype: 'infiltrator',
      compliant: true,
      violations: [],
      protocol: 'runes',
      faction: 'Runes',
      label: 'Runestone (compliant)',
      emoji: '⚡',
      details: [],
      dataBytes: 40,
      contentType: null,
      payloadPreview: null,
    };
  }
  return {
    archetype: 'citizen',
    compliant: true,
    violations: [],
    protocol: 'clean',
    faction: '',
    label: 'Clean payment',
    emoji: '🪙',
    details: [],
    dataBytes: 0,
    contentType: null,
    payloadPreview: null,
  };
}

function tx(txid, vsize, coinbase = false) {
  return { txid, vsize, vin: [{ is_coinbase: coinbase }], vout: [] };
}

test('buildBlockReport folds a mixed block correctly', () => {
  const txs = [
    tx('coinbase', 200, true), // index 0 → excluded
    tx('violator1', 1000),
    tx('violator2', 300),
    tx('runes1', 150),
    tx('citizen1', 150),
  ];
  const blockMeta = {
    id: 'blockhash',
    height: 957515,
    version: 0x20000010, // signals bit-4
    tx_count: 5,
    extras: { pool: { slug: 'foundry', name: 'Foundry USA' } },
  };

  const report = buildBlockReport(txs, blockMeta, fakeClassify, CONFIG);

  // coinbase excluded from scan, kept in the vsize denominator
  assert.equal(report.totalTx, 5);
  assert.equal(report.scannedTx, 4);
  assert.equal(report.totalVBytes, 200 + 1000 + 300 + 150 + 150);
  assert.equal(report.spamVBytes, 1000 + 300);
  assert.ok(Math.abs(report.spamShare - 1300 / 1800) < 1e-9);

  // archetype + protocol tallies
  assert.equal(report.counts.byArchetype.violator, 2);
  assert.equal(report.counts.byArchetype.infiltrator, 1);
  assert.equal(report.counts.byArchetype.citizen, 1);
  assert.equal(report.counts.byProtocol.inscription, 1);
  assert.equal(report.counts.byProtocol.op_return_large, 1);
  assert.equal(report.counts.byProtocol.runes, 1);
  assert.equal(report.counts.byProtocol.clean, 1);

  // top offenders sorted by dataBytes desc, trimmed to {txid, vsize}
  assert.equal(report.topOffenders.length, 2);
  assert.equal(report.topOffenders[0].tx.txid, 'violator1');
  assert.equal(report.topOffenders[0].tx.vsize, 1000);
  assert.equal(report.topOffenders[0].verdict.dataBytes, 51200);
  assert.equal(report.topOffenders[1].tx.txid, 'violator2');
  assert.deepEqual(Object.keys(report.topOffenders[0].tx).sort(), ['txid', 'vsize']);

  assert.equal(report.pure, false);
  assert.equal(report.signaling, true);
  assert.equal(report.pool.slug, 'foundry');
  assert.equal(report.height, 957515);
});

test('buildBlockReport flags a pure, non-signaling block', () => {
  const txs = [tx('coinbase', 200, true), tx('citizen1', 150), tx('citizen2', 150)];
  const blockMeta = { id: 'h', height: 1, version: 0x20000000, tx_count: 3, extras: {} };
  const report = buildBlockReport(txs, blockMeta, fakeClassify, CONFIG);

  assert.equal(report.pure, true);
  assert.equal(report.spamVBytes, 0);
  assert.equal(report.spamShare, 0);
  assert.equal(report.signaling, false);
  assert.equal(report.pool, null);
  assert.equal(report.topOffenders.length, 0);
});

test('buildBlockReport survives a throwing classifier on one tx', () => {
  const boom = (t) => {
    if (t.txid === 'bad') throw new Error('unparseable');
    return fakeClassify(t);
  };
  const txs = [tx('coinbase', 200, true), tx('bad', 500), tx('citizen1', 100)];
  const blockMeta = { id: 'h', height: 2, version: 1, tx_count: 3 };
  const report = buildBlockReport(txs, blockMeta, boom, CONFIG);
  // the bad tx yields a null verdict → not counted, but denominator intact
  assert.equal(report.scannedTx, 2);
  assert.equal(report.totalVBytes, 800);
  assert.equal(report.counts.byArchetype.citizen, 1);
});

test('reduceReport tolerates an empty block', () => {
  const report = reduceReport([], { id: 'h', version: 0 }, [], CONFIG);
  assert.equal(report.totalVBytes, 0);
  assert.equal(report.spamShare, 0);
  assert.equal(report.pure, true);
});

test('isSignaling matches the BIP9 bit-4 mask', () => {
  assert.equal(isSignaling(0x20000010), true);
  assert.equal(isSignaling(0x20000000), false); // no bit-4
  assert.equal(isSignaling(0x60000010), false); // top bits 011, not 001
  assert.equal(isSignaling(0x30000010), true); // bit-28 not in mask → still signals
  assert.equal(isSignaling(undefined), false);
  assert.equal(isSignaling(null), false);
});

// Optional live check — skips gracefully offline / on rate-limit.
test('live tip height (network, optional)', async (t) => {
  let res;
  try {
    res = await fetch('https://mempool.space/api/blocks/tip/height');
  } catch (e) {
    t.skip('no network: ' + e.message);
    return;
  }
  if (!res.ok) {
    t.skip('non-OK status: ' + res.status);
    return;
  }
  const txt = (await res.text()).trim();
  assert.match(txt, /^\d+$/);
});
