// vectors.test.mjs — the ground-truth gate.
// Parse each of the 16 official BIP-110 consensus test vectors with rawtx.js,
// attach the given spent-output scriptPubKeys as vin[].prevout, classify, and
// assert: expected 'valid' <=> verdict.violations.length === 0, and for
// 'invalid' vectors the violated ruleId includes the vector's rule number.
//
// Node 18: read JSON with fs.readFileSync (no import assertions).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { parseRawTx } from '../js/rawtx.js';
import { classifyTx } from '../js/classify.js';
import { sha256, hash256 } from '../js/sha256.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function hexToBytes(hex) {
  const n = hex.length >> 1;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
function bytesToHex(b) {
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

const vectors = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'docs/research/bip110-test-vectors.json'), 'utf8')
).vectors;

// --- SHA-256 known-answer sanity (the txid machinery leans on this) ---------
test('sha256 known-answer vectors', () => {
  assert.equal(bytesToHex(sha256(new TextEncoder().encode('abc'))),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(bytesToHex(sha256(new Uint8Array(0))),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  // double-sha256 of empty
  assert.equal(bytesToHex(hash256(new Uint8Array(0))),
    '5df6e0e2761359d30a8275058e299fcc0381534545f55cf43e41983f5d4c9456');
});

// --- The 16 consensus vectors -----------------------------------------------
for (const vec of vectors) {
  test(`rule ${vec.rule} — ${vec.name} (${vec.expected})`, () => {
    const bytes = hexToBytes(vec.tx);
    const { tx, bytesRead } = parseRawTx(bytes);

    // Parser must consume the whole transaction exactly.
    assert.equal(bytesRead, bytes.length, 'parseRawTx did not consume the full tx');

    // Attach spent outputs as prevouts, carrying the grandfathering flag.
    const grandfathered = vec.spent_utxo === 'pre-activation';
    vec.spent_outputs.forEach((so, i) => {
      if (tx.vin[i]) {
        tx.vin[i].prevout = {
          scriptpubkey: so.scriptPubKey,
          value: so.amount,
          grandfathered
        };
      }
    });

    const verdict = classifyTx(tx);

    if (vec.expected === 'valid') {
      assert.equal(verdict.violations.length, 0,
        `expected VALID but got violations: ${JSON.stringify(verdict.violations)}`);
    } else {
      assert.ok(verdict.violations.length > 0,
        `expected INVALID (rule ${vec.rule}) but classifier found no violations`);
      const hit = verdict.violations.some(v => v.ruleId === String(vec.rule));
      assert.ok(hit,
        `expected a rule-${vec.rule} violation, got: ${JSON.stringify(verdict.violations)}`);
    }
  });
}
