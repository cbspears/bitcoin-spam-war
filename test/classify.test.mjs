// classify.test.mjs — protocol-detection tests against real transactions.
//
// Fixtures are the mempool.space GET /api/tx/:txid JSON for the verified sample
// txids in docs/research/taxonomy.json, fetched ONCE and committed under
// test/fixtures/ so this suite runs fully offline. If a fixture is missing
// (e.g. it was never fetched), that case is skipped gracefully rather than failing.
//
// Node 18: JSON is read with fs.readFileSync (no import assertions).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { classifyTx } from '../js/classify.js';
import { parseRawTx } from '../js/rawtx.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(__dirname, 'fixtures');

// Expected {protocol, archetype} for each verified sample. These match the
// taxonomy's own semantics *including precedence*: the "large OP_RETURN"
// samples are really an ACME OP_RETURN and a 196-byte runestone, so they
// resolve to acme / runes (runes/acme rank above the op_return_large bucket).
const EXPECT = {
  // Ordinals / BRC-20 (inscription envelope, fails BIP-110 rule 7)
  '00134c0c77cb699e504d1f2cec073891033cb17c2b77f3725bed766ba51d4f20': { protocol: 'brc20', archetype: 'violator' },
  '9788161d619121551c068b69a2575002debc356e65051e6852531f40f7c73816': { protocol: 'brc20', archetype: 'violator' },
  '7f76a3892d2c08ff4a0163d2cbae3a9827ce99b1f673d3eccd2395b50eefc419': { protocol: 'brc20', archetype: 'violator' },
  '1f122ba9c7228dfcabd2cec75e396809c29d3be91bcc82e6cdfeeea0c4e578aa': { protocol: 'inscription', archetype: 'violator' },
  // Runes (small = BIP-110-compliant infiltrator; oversized runestone = violator)
  '3a1b177dbd3134c25e04382c7da373b641b07f52e0909f5a16baa8366b67198d': { protocol: 'runes', archetype: 'infiltrator' },
  'cc0dee5d12611c100058b049fa5476e167c373bf60dd50fa6f410185714a3846': { protocol: 'runes', archetype: 'infiltrator' },
  'ff4d2874edc2ce48caec3857ddf923d677c164cc170dd964bdd53723b61bc2b6': { protocol: 'runes', archetype: 'infiltrator' },
  '9d8ce1d04189ebfdd97a732db922fded0bfb5d788ee0bdda08def8fc2877ff5b': { protocol: 'runes', archetype: 'violator' },
  // Bitcoin Stamps / SRC-20 (bare multisig, fails rule 1)
  'd0fe8c85a33aa9c0417f047cbc8d47d653606074376fdf20243858e990d3332d': { protocol: 'src20', archetype: 'violator' },
  'b308836059e47fe66468a2db6fcfc6ed220c777ab6fe9761b5e035cd50de7cb8': { protocol: 'src20', archetype: 'violator' },
  'dddbd5ddc8ab8e12389f08e76d5050dbf2bbd47103d37701de85ddccc4b0b315': { protocol: 'src20', archetype: 'violator' },
  // Counterparty (ARC4). OP_RETURN send = compliant infiltrator; MPMA multisig = violator
  'bc75d6b89b0641439b97e28bd03569df02e42b6552bd386593728243a236cf90': { protocol: 'counterparty', archetype: 'infiltrator' },
  'f7db487f67ca6c0231a5771f47cb7e4ab816472f53aafa591cfae331e11d361b': { protocol: 'counterparty', archetype: 'violator' },
  '077c8f21ada04441a5e4b6d632d9ad6a075bd923776b288907b4b36689d82216': { protocol: 'counterparty', archetype: 'violator' },
  // ACME (envelope form carries big files; OP_RETURN form is > 83 bytes)
  'c3a776a2894614706a1799f3ee00a811191547308a2c00e1817851b397508651': { protocol: 'acme', archetype: 'violator' },
  '4b8ddab63f3ece86012277a82db59d7a3e39aa62c852e884fc61374d13e7bf52': { protocol: 'acme', archetype: 'violator' },
  '12964554c905de5e1da6e258b5dc82ca15510afaef806bb976a055236b888cf1': { protocol: 'acme', archetype: 'violator' },
  // Clean payments
  'fbff1c9eda6887df3b6279ec1a4303b3d98f21406dbc5a4db06ca3b6215f0f98': { protocol: 'clean', archetype: 'citizen' },
  '198c2c1e2ccc0418ab819b08f0d3bcef04a62fbdb5fb06ee193b6bdbb6696918': { protocol: 'clean', archetype: 'citizen' },
  '962ea4a3b8be87bfbd1870ae75e11591d565a653695bc8c5f5dc22a44bd272cd': { protocol: 'clean', archetype: 'citizen' }
};

function loadFixture(txid) {
  const p = path.join(FIX, `${txid}.json`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

for (const [txid, exp] of Object.entries(EXPECT)) {
  test(`${exp.protocol}/${exp.archetype} — ${txid.slice(0, 12)}…`, (t) => {
    const tx = loadFixture(txid);
    if (!tx) { t.skip(`fixture ${txid}.json not present (run fetch script online)`); return; }

    const v = classifyTx(tx);
    assert.equal(v.protocol, exp.protocol, `protocol for ${txid}`);
    assert.equal(v.archetype, exp.archetype, `archetype for ${txid}`);

    // Core invariant: violator <=> at least one BIP-110 violation.
    assert.equal(v.violations.length > 0, v.archetype === 'violator', 'violator <=> has violations');
    assert.equal(v.compliant, v.violations.length === 0, 'compliant <=> no violations');

    // Protocol-specific spot checks on decoded payloads.
    if (exp.protocol === 'brc20') {
      assert.ok(v.contentType, 'brc20 should expose a content-type');
      const parsed = JSON.parse(v.payloadPreview);
      assert.equal(parsed.p, 'brc-20', 'brc20 payload should be JSON with p="brc-20"');
    }
    if (exp.protocol === 'inscription') {
      assert.ok(v.contentType, 'inscription should expose a content-type');
    }
    if (exp.protocol === 'src20') {
      assert.ok(v.payloadPreview && v.payloadPreview.startsWith('stamp:'),
        `src20 should ARC4-decode to a "stamp:" payload, got ${v.payloadPreview}`);
    }
    if (exp.protocol === 'counterparty') {
      assert.ok(v.payloadPreview && v.payloadPreview.includes('CNTRPRTY'),
        `counterparty should ARC4-decode to CNTRPRTY, got ${v.payloadPreview}`);
    }
    if (exp.protocol === 'runes') {
      assert.ok(v.payloadPreview && v.payloadPreview.startsWith('runestone'), 'runes preview');
    }
  });
}

// --- rawtx.js txid round-trip (validates sha256 + rawtx against a real tx) ---
test('rawtx.js reproduces a real txid from raw hex', (t) => {
  const p = path.join(FIX, 'rawtx-selfcheck.json');
  if (!fs.existsSync(p)) { t.skip('rawtx-selfcheck.json not present'); return; }
  const { txid, hex } = JSON.parse(fs.readFileSync(p, 'utf8'));
  const bytes = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  const { tx, bytesRead } = parseRawTx(bytes);
  assert.equal(bytesRead, bytes.length, 'should consume the full tx');
  assert.equal(tx.txid, txid, 'double-sha256 txid must match the API');
});
