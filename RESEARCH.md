# RESEARCH.md — verified facts + design decisions

Curated digest of the research fan-out (full structured results in
`docs/research/*.json` — READ the relevant one for your module). All API
claims below were empirically verified on 2026-07-10 against the live
public mempool.space instance.

## BIP-110 (the thing we're satirizing) — `docs/research/bip110.json`

**Real.** "Reduced Data Temporary Softfork", author pseudonymous **Dathon
Ohm** (BIP credits: "Original draft and advice: Luke-Jr"). Status: Complete.
Temporary one-year consensus soft fork. Deployment: modified BIP9, name
`reduced_data`, **bit 4**, 55% threshold, **mandatory signaling blocks
961,632–963,647** (~Aug 7 2026 — blocks not signaling are rejected,
URSF-style), max_activation_height 965,664 (~Sep 1 2026), active 52,416
blocks then EXPIRED. Current miner signaling ≈ 0.31% of hashrate; ~20-25%
of listening nodes run Knots (Sybil-inflation disputed — cite as
"~20-25%, disputed"). Full rule text + detection notes in the JSON. The 7
rules, abbreviated:

1. Output scriptPubKey > 34 bytes invalid, unless OP_RETURN first opcode
   (then ≤ 83 bytes total script). Kills Stamps bare multisig (105B),
   large runestones, big OP_RETURNs.
2. OP_PUSHDATA* payloads and script-argument witness items > 256 bytes
   invalid (except P2SH redeemScript push; witnessScript/tapleaf scripts
   themselves exempt as scripts-not-data). Kills inscription content chunks.
3. Spending undefined witness versions (not v0, v1 taproot, or P2A
   `51024e73`) invalid; tapleaf version byte must be 0xc0. Needs prevout.
4. Taproot annex (last witness element starts 0x50, ≥2 elements) invalid.
5. Taproot control block > 257 bytes invalid (taptree depth > 7).
6. Tapscript containing any OP_SUCCESSx opcode (80,98,126–129,131–134,
   137–138,141–142,149–153,187–254) invalid — REAL opcode parse, bytes
   inside push payloads do NOT count.
7. Tapscript containing OP_IF (0x63) or OP_NOTIF (0x64) invalid — the
   inscription-envelope killer. Real opcode parse required.

**DECISION — grandfathering:** BIP-110 exempts inputs spending pre-activation
UTXOs; the fork is not active, so we apply rules 1–7 flat and label the
verdict "would violate BIP-110 if active". Disclose in the modal.

**Official test vectors:** `docs/research/bip110-test-vectors.json` — 16
consensus vectors (all 7 rules, valid+invalid, raw tx hex + spent outputs).
The classifier MUST pass all 16 (that's what `test/vectors.test.mjs` runs).

Flavor quotes for HUD/modal (verbatim, from bip110.json): "Yes, this
proposal intentionally breaks user space…", "…way more than anyone could
ever need.", Lopp's "Fork around and find out." etc.

## Protocol taxonomy — `docs/research/taxonomy.json` (READ IT — exact hex patterns, verified sample txids, 18 gotchas)

Verified prevalence (blocks 957508–957515, 29,562 txs): **Runes ~56% of all
txs** (17–92% per block), ordinals/BRC-20 ~1.3% (~96% of ordinals are
BRC-20), ACME ~6-7 tx/block, SRC-20/Stamps a few per block, Counterparty
~1 per 5-10 blocks, >83B OP_RETURN ~23 outputs/block, annex 0, Atomicals 0.

Key detection anchors (details + gotchas in JSON — respect ALL 18 gotchas,
especially: even-index hex matching, runes anchored at position 0,
`scriptpubkey_type === "multisig"` not raw-byte matching, envelope
parse-then-JSON.parse for BRC-20, coinbase exclusion, THORChain/Stacks
memo false-positives):

- Inscriptions: witness element contains `0063036f7264` at even index;
  content-type after `0101` tag push; body = concat pushes after OP_0 until
  OP_ENDIF. `inner_witnessscript_asm` alternative confirmed.
- BRC-20: envelope body JSON.parse → `p === "brc-20"`.
- Runes: vout `scriptpubkey_type === "op_return"` AND hex starts `6a5d`.
- Stamps/SRC-20: `scriptpubkey_type === "multisig"`; ARC4 decode (key =
  vin[0].txid bytes AS DISPLAYED, no reversal) → `stamp:` or len+`CNTRPRTY`.
- Counterparty OP_RETURN: ARC4 decode payload → `CNTRPRTY` prefix.
- ACME: OP_RETURN payload starts `41434d45`, or witness envelope
  `00630461636d65` (substring, NOT anchored — can start at byte 0).
- Large OP_RETURN: total script bytes > 83.
- Annex: last witness elem starts `50` with ≥2 elems (expect ~0 hits).

## The metaphor mapping (DECISION — resolves the critic's central tension)

Protocol-spam and BIP-110-noncompliance are different sets (small runestones
are culturally "spam" but BIP-110-COMPLIANT). We embrace this as the best
joke in the project. Three unit archetypes from one classifier:

- **VIOLATOR** (bip110.violations.length > 0): inscriptions, BRC-20, Stamps,
  large runestones, ACME, big OP_RETURNs → the charging JPEG horde.
  Rate ~0.1-0.2 tx/s (one attacker every 5-10s — good battle pacing).
- **INFILTRATOR** (data protocol detected but BIP-110-compliant — mostly
  small runestones, small Counterparty): suit + briefcase, strolls through
  the checkpoint LEGALLY, knights visibly seething, stamp reads
  "COMPLIANT ✓ (regrettably)". ~56% of traffic = constant comedy.
- **CITIZEN** (clean payment, incl. ≤83B functional memos like THORChain
  '=:' / Stacks 'X2['): small gold coin, waved through. Memos get a gray
  tint + "memo" note in dossier, not counted as spam.

## mempool.space integration — `docs/research/mempool-api.json` (READ IT)

- ONE WebSocket `wss://mempool.space/api/v1/ws`. Send BOTH:
  `{"action":"want","data":["blocks","stats","mempool-blocks"]}` and
  `{"track-mempool":true}`.
- Init message: last 8 blocks WITH extras (totalFees, pool, feeRange…),
  8 projected mempool-blocks. Updates every ~1.7s include `fees`,
  `mempoolInfo`, `vBytesPerSecond`, `da`, `mempool-blocks`.
- `mempool-transactions` deltas: `added[]` = FULL tx objects (vin[].witness,
  vin[].prevout, vout[], fee, vsize, effectiveFeePerVsize…) — classify
  directly, ZERO REST per tx. `mined[]` on block = which streamed txs
  confirmed. `sequence` for gap detection. ~5KB/s quiet; MANDATORY
  auto-downgrade: if added[] exceeds ~25 tx/update sustained (~15 tx/s),
  unsubscribe track-mempool, subscribe `{"track-mempool-txids":true}` and
  REST-sample ≤2 tx/s via /api/tx/:txid.
- New block: WS pushes `{"block":{…extras…}}`. Then fetch
  **`/api/block/:hash/raw`** (binary, ~1-2MB, ONE request) and parse
  client-side with our rawtx parser → classify 100% of the block, no
  sampling bias. (Raw txs lack prevouts → rule 3 and per-tx fees are
  unavailable in block scans; mark "n/a" — rule 3 has ~0 real hits anyway.
  Fees for killfeed come from the mempool stream; block totals from
  extras.totalFees.)
- Init backfill: `/api/v1/blocks` (15 blocks with extras) + raw-scan the
  most recent 2-3 blocks (spread over ~30s) to seed the tally.
- `/api/v1/prices` ~1/min for USD. Pagination of /txs is path-segment
  /txs/25 style (multiples of 25) — only as fallback if raw parse fails.
- CORS `*` verified on REST + WS. Rate limits unpublished; keep ≤1 REST/s
  sustained, back off on 429. Keepalive `{"action":"ping"}` every 30s.
  Reconnect w/ exponential backoff + resubscribe.
- Fallback endpoint rotation on repeated failure: mempool.emzy.de,
  mempool.bitcoin.de (same API) — try in order, return to primary hourly.

## Defender-side live data (DECISION per critic)

- **BIP9 bit-4 signaling check** on every block: `(version & 0xE0000010)
  === 0x20000010`. Show per-block signal flag + "N of last 100 signaled /
  1109 of 2016 needed". (Verify mask against a known Ocean block in tests
  if one is found; guard with plain bit-4 check `(version >> 4) & 1` plus
  top-bits check as specced.)
- **Countdown**: blocks until 961,632 (mandatory signaling) and 965,664
  (max activation), ETA at ~10 min/block. This is the doomsday clock.
- **Ocean blocks**: `extras.pool.slug === 'ocean'` (check name too) →
  "OCEAN HOLDS THE LINE" set-piece; their blocks genuinely filter, so the
  per-block spam tally will actually be lower — let the data show it.

## Battlefield inspiration — `docs/research/battlefield.json`

Nick Greenawalt's Bitcoin Battlefield = 3D Three.js toy-soldier war driven
by Binance 1s klines. We stay 2D canvas (zero-dep constraint) but steal:
FPS killfeed as comedy engine, log-scale unit sizing, streak escalation
set-pieces, permanent scorch marks for whale events, honest headline stat
measured against real data, screen-shake + slow-mo on big events, ambient
leave-on-a-monitor pacing, ● LIVE badge with graceful degraded mode.

## Cast & copy — `docs/research/cast.json` (READ IT for all lines)

Defenders (Filter Knights): **Luke Dashjr** "The Filter Patriarch",
**Bitcoin Mechanic** "The Template Crusader", **Matthew Kratter** "The Pleb
Whisperer" (confirmed: dictated 'Matthew Crater' = Kratter, Bitcoin
University), plus cameo **Giacomo Zucco** "The Reluctant Inquisitor"
(anti-spam AND anti-BIP-110 — walks the battlement arguing with everyone)
and **Dathon Ohm** "The Forkbringer" (hooded, pseudonymous, holds the
doomsday scroll). Each has verified catchphrases in the JSON.

Spam factions (11, with emoji): NodeMonkes 🐒, Bitcoin Puppets 🤡, Quantum
Cats 🐱, Taproot Wizards 🧙, Bitcoin Frogs 🐸, OMB 👁️, Runestone 🪨,
Stamps 📮, Rare Pepe/Counterparty 🃏, BRC-20 📄, Runes ⚡ (the "lawful
evil" infiltrators). 29 taunt lines + 2026 war-context paragraph in JSON.

Sprite-face mapping is COSMETIC (we can't cheaply resolve collection
membership) — protocol → faction pool, random face per unit; disclosed in
the "How this works" modal.

## Honesty requirements (non-negotiable)

- Headline stats computed from FULL raw-block scans (not the biased
  first-100 sample). Anything sampled is labeled "sampled".
- Every unit clickable → real txid → mempool.space link + matched rule text.
- Modal discloses: heuristic classification, flat rule application (no
  grandfathering, fork not active), cosmetic faces, Knots-share dispute,
  data courtesy mempool.space.
