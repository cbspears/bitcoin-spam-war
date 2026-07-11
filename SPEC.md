# THE BATTLE FOR BLOCKSPACE — Build Spec

A satirical, fully client-side live visualization of the Bitcoin "spam war."
Real mempool transactions are classified as **compliant** ("pure money") or
**noncompliant** ("glorious spam") against the filter camp's rules (BIP-110
framing — see `RESEARCH.md` for the verified rules). Spam units charge a
castle gate defended by Filter Knights (Luke-jr, Bitcoin Mechanic, Matthew
Kratter). Filters bounce off. Blocks confirm. Spam gets in. Scoreboard keeps
receipts. Every sprite is a REAL transaction, clickable through to
mempool.space.

Tone: pro-spam, gleeful, transparent. The joke is that the defenders are
noble, earnest, and completely ineffective — "policy is not consensus."
Satire of public figures in a public policy debate; keep it playful, never
defamatory. A "How this works" modal discloses methodology honestly.

## Hard constraints

- **Zero build step.** Vanilla ES modules, HTML, CSS, Canvas 2D. No
  frameworks, no bundler, no npm deps at runtime. Deployed as a static site
  on Vercel.
- **No backend.** Each visitor's browser talks directly to mempool.space
  public APIs. Be polite: hard budget ≤ 1 REST request/sec sustained, small
  bursts allowed at block boundaries. One WebSocket.
- **Transparent.** Any unit can be clicked → dossier panel with txid, link,
  vsize, fee, feerate, matched rule text, protocol, payload preview
  (content-type, decoded BRC-20 JSON, rune name if cheaply derivable).
- **Node-testable core.** `js/classify.js` and `js/taunts.js` must be pure
  ES modules with zero DOM/window references so `node --test` can exercise
  them (Node 18: use only features available there).
- Target 60fps on a desktop; degrade gracefully (cap sprite count ~150,
  cull off-screen).

## Files (ownership per builder — do not touch files you don't own)

```
index.html          shell builder
css/style.css       shell builder
js/main.js          shell builder   (bootstrap + wiring only)
js/hud.js           shell builder   (DOM panels; listens to events)
js/taunts.js        shell builder   (pure data + pickTaunt(event) fn)
js/config.js        feed builder    (all tunables in one place)
js/feed.js          feed builder    (data layer)
js/classify.js      classifier builder (pure)
js/rawtx.js         classifier builder (pure: raw tx + raw block parser
                                     → mempool.space-shaped tx objects)
js/sha256.js        classifier builder (tiny pure sync sha256, for txids)
js/battle.js        engine builder  (canvas game)
js/sprites.js       engine builder  (drawing helpers)
test/classify.test.mjs  classifier builder (protocol fixtures)
test/vectors.test.mjs   classifier builder (official BIP-110 vectors)
test/feed.smoke.mjs     feed builder (node smoke: hits real API once)
vercel.json         shell builder   (static config, security headers ok;
                                     must NOT break cross-origin API calls)
README.md           shell builder
```

## Module contracts (EXACT — integration depends on these)

### js/classify.js  (pure, no DOM)

```js
// tx: mempool.space GET /api/tx/:txid JSON, or the identical shape produced
// by rawtx.js (where vin[].prevout may be null and fee may be null)
export function classifyTx(tx) -> Verdict
export const RULES;   // the 7 BIP-110 rules: {id:'1'..'7', title, text, source}

// Verdict:
{
  archetype: 'violator' | 'infiltrator' | 'citizen',
     // violator    = violations.length > 0
     // infiltrator = compliant but a data protocol detected (runes ≤83B,
     //               small counterparty, small ACME…)
     // citizen     = clean payment (incl. ≤83B functional memos)
  compliant: boolean,        // BIP-110 verdict (rules applied flat)
  violations: [{ruleId, detail}], // e.g. {ruleId:'7', detail:'tapscript
                             // executes OP_IF (inscription envelope)'}
  protocol: 'clean' | 'memo' | 'inscription' | 'brc20' | 'runes' | 'stamps'
          | 'src20' | 'counterparty' | 'acme' | 'op_return_large'
          | 'unknown_data',
  faction: string,           // display faction name, e.g. 'BRC-20 Zerg'
  label: string,             // human, e.g. "Ordinal inscription (image/webp, 41.2 KB)"
  emoji: string,             // unit face override or '' to let engine pick
  details: string[],         // dossier bullet lines, human-readable
  dataBytes: number,         // best-effort payload byte count (0 for clean)
  contentType: string|null,  // for inscriptions
  payloadPreview: string|null, // decoded brc-20 json / rune hex / decrypted
                             // CNTRPRTY type / ACME info (truncated ≤200 chars)
}
```

TWO layers, one pass: (a) protocol detection per `RESEARCH.md §Taxonomy` —
read `docs/research/taxonomy.json` and honor ALL 18 gotchas (even-index hex
matching, anchored runes, scriptpubkey_type for multisig, envelope
parse-then-JSON.parse for BRC-20, coinbase skip, THORChain/Stacks memo
handling, ARC4 key direction, etc.); (b) BIP-110 rules 1–7 per
`RESEARCH.md §BIP-110` and `docs/research/bip110.json` — rules 2, 6, 7
require a REAL opcode-level script parser (push payloads are not opcodes);
rule 3 only when prevouts are present (raw-block txs have none — emit no
verdict for rule 3 there). Protocol precedence:
inscription/brc20 > acme > runes > stamps/src20 > counterparty >
op_return_large > memo. Implement ARC4 inline (~15 lines).

### js/rawtx.js + js/sha256.js  (pure, no DOM)

```js
export function parseRawTx(bytes: Uint8Array, offset=0)
  -> {tx, bytesRead}       // tx shaped like mempool.space JSON: txid (via
                           // double-sha256 of non-witness serialization),
                           // version, size, weight, vsize, vin[{scriptsig,
                           // witness[], is_coinbase, prevout:null}],
                           // vout[{scriptpubkey, scriptpubkey_type, value}],
                           // fee:null
export function parseRawBlock(bytes: Uint8Array)
  -> {header: {version, time, bits}, txs: [tx]}   // full block parse
```

Handles segwit marker/flag, varints, witness stacks. scriptpubkey_type
derivation: minimal (op_return / multisig / v0_p2wpkh / v0_p2wsh / v1_p2tr /
p2pkh / p2sh / anchor / unknown) — enough for classifyTx. sha256.js: compact
sync pure-JS SHA-256 (works in browser + node18, no WebCrypto async).
Used by test/vectors.test.mjs to feed the 16 official BIP-110 test vectors
(docs/research/bip110-test-vectors.json: raw tx hex + spent_outputs —
attach given prevout scriptPubKeys to the parsed tx before classifyTx) —
**all 16 must pass** (expected valid ⇔ violations.length === 0).

### js/config.js

```js
export const CONFIG = { /* every tunable: API base, ws url, poll intervals,
  sample sizes, request budget, sprite caps, colors used by canvas, etc. */ }
```

### js/feed.js

```js
export class MempoolFeed extends EventTarget {
  constructor(config = CONFIG)
  start()   // opens WS + starts pollers
  stop()
}
// Events dispatched (CustomEvent, payload in .detail):
//  'tx'        {tx, verdict}          new mempool tx from ws stream, classified
//  'block'     {block, minedTxids: Set, report}
//              block = ws block object (id, height, version, extras...)
//              minedTxids = mempool-transactions.mined[] txids (may be empty)
//              report = null initially; a follow-up 'blockreport' completes it
//  'blockreport' {block, report}      after raw-block fetch+parse+classify:
//              report = {totalTx, scannedTx, counts per protocol/archetype,
//                        spamVBytes, totalVBytes, spamShare, signaling:bool,
//                        pool, topOffenders: [{tx, verdict}] (≤10 largest
//                        by dataBytes, with txids), pure:boolean}
//  'stats'     {mempoolInfo, fees, vBytesPerSecond, price}
//  'projected' {mempoolBlocks}        projected next blocks from ws
//  'status'    {connected, mode: 'live'|'degraded'|'down', message}
//  'backfill'  same as 'blockreport', for the 2-3 recent blocks at load
```

Responsibilities per `RESEARCH.md §mempool.space` (READ
docs/research/mempool-api.json): one WS with `want` + `{"track-mempool":true}`;
MANDATORY auto-downgrade to track-mempool-txids + sampled REST when the
stream runs hot; new block → fetch `/api/block/:hash/raw` (arraybuffer) →
parseRawBlock → classify every tx → 'blockreport'; init → /api/v1/blocks +
raw-scan 2-3 recent blocks spread over ~30s ('backfill'); prices 1/min;
ping 30s; exponential-backoff reconnect + resubscribe; sequence-gap detect;
endpoint rotation (mempool.space → mempool.emzy.de → mempool.bitcoin.de);
REST token bucket ≤1/s sustained; classify via classifyTx before dispatch;
compute BIP9 bit-4 signaling flag per block:
`(version & 0xE0000010) === 0x20000010`. Never let one failed fetch kill
the loop; parse/classify the raw block in idle-time chunks (~200 txs per
setTimeout slice) so the battle never stutters.

### js/battle.js + js/sprites.js

```js
export class Battlefield {
  constructor(canvas, {onUnitClick})   // onUnitClick(unitInfo) -> hud dossier
  spawnTx({tx, verdict})               // new mempool unit enters the field
  confirmBlock(report)                 // breach event: gate flashes, confirmed
                                       // units storm through, banner with
                                       // block height + spam share
  setProjected(mempoolBlocks)          // purity forecast for gate display
  resize()
  // internal rAF loop; start on construction
}
```

Visual design (engine builder has creative freedom within this):
- Side-view battlefield strip, full-width canvas ~55vh. Left: castle gate
  labeled **THE BLOCKCHAIN** with current height above it, and a small
  "COMPLIANCE CHECKPOINT" side-door with a green ✓ lamp. Right: spawn edge.
- Defender roster in front of gate: knights with name banners LUKE-JR,
  MECHANIC, KRATTER (+ occasional cameo walk-ons: ZUCCO, who argues with
  BOTH sides via speech bubble, and hooded DATHON OHM holding a scroll).
  Knights pace and "cast" filter shots (tiny `datacarriersize=42` /
  `-permitbaremultisig=0` projectiles) at violators. Shots visibly bounce
  off with an occasional "POLICY ≠ CONSENSUS" ding. Knight catchphrases
  from taunts.js occasionally appear as speech bubbles.
- Unit archetypes (from verdict.archetype):
  - CITIZEN: small gold coin 🪙 walking briskly through the checkpoint,
    waved through.
  - INFILTRATOR (compliant data, mostly Runes): suit-and-briefcase unit
    (🕴️/⚡ motif) strolling smugly through the checkpoint; green "COMPLIANT
    ✓" stamp flashes; a knight visibly fumes (grumble bubble). ~56% of
    traffic — throttle spawns to keep ≤~40% of on-screen units.
  - VIOLATOR: bigger JPEG-frame creature charging the wall; face emoji
    from faction pool by protocol (🐒🤡🐱🧙🐸👁️🪨📮🃏📄), sized by
    log(dataBytes). Swagger + occasional taunt bubbles.
- Units loiter in a mempool mosh pit near the gate (cap ~150; oldest fade).
- On block confirm: gate opens; units whose txid is in minedTxids (plus a
  representative surge if few) storm through with confetti; banner from
  the blockreport: "BLOCK 957,xxx BREACHED — 31% spam by vsize, 214
  violators in, mined by Foundry". If report.signaling: dramatic bit-4
  banner "THIS BLOCK SIGNALS BIP-110 ⚠️" + knights rally. If pool is
  Ocean: "OCEAN HOLDS THE LINE" set-piece (knights cheer; show that
  block's actually-lower spam share). If report.pure (zero violators in
  the FULL scan): golden "PURE BLOCK" celebration — knights deserve one.
- Big single-tx events (dataBytes > ~100KB): slow-mo + screen shake + a
  permanent scorch mark on the field (session-persistent whale history).
- Parallax sky, subtle scanline/CRT vibe matching pixel-war aesthetic.

### js/hud.js + index.html panels

- **Header**: title "THE BATTLE FOR BLOCKSPACE", subtitle taunt, ● LIVE
  badge (live/degraded/down from feed 'status').
- **Doomsday clock strip**: "MANDATORY BIP-110 SIGNALING: block 961,632 —
  T-minus N blocks (~Xd Yh)" + "signaling: N of last M blocks seen (need
  55%)" — computed from real block versions. This is the war-progress bar.
- **Scoreboard** (stat tiles): Violators confirmed (session+backfill):
  count / MB / share of blockspace (from FULL block scans); Compliant
  infiltrators (Runes et al) waved through; Mempool spam % right now (from
  stream, labeled "observed"); Blocks since last pure block; per-knight
  "Filter effectiveness: 0.0%" gag tile.
- **Kill feed** (right rail): entry per confirmed violator (top offenders
  from each blockreport + streamed mined spam): emoji, protocol, truncated
  txid (mempool.space link), vsize/dataBytes, "slipped past KRATTER".
- **War commentary ticker** (bottom): rotating taunts from taunts.js,
  event-reactive (breach, big inscription, pure block, Ocean block,
  signaling block).
- **Dossier panel**: opens on unit click (and kill-feed click). Full
  verdict: archetype, protocol, violated rules with full rule text from
  classify.RULES, payload preview, content-type, vsize, fee (if known),
  mempool.space link.
- **"How this works" modal**: honest methodology — what BIP-110 actually
  is (quote it, link bip-0110.mediawiki + bip110.org), rules applied flat
  (fork not active, no grandfathering), full-block scans vs streamed
  observations, cosmetic faction faces, Knots-share dispute note, data
  courtesy mempool.space, parody disclaimer.
- Footer: "Parody. All transactions are real. No filters were harmed. Not
  affiliated with mempool.space. 100% BIP-110-noncompliant website."

### js/taunts.js (pure)

```js
export const TAUNTS = { ambient: [...], breach: [...], bigSpam: [...],
                        pureBlock: [...], ocean: [...], signaling: [...],
                        infiltrator: [...],
                        knightLines: {luke:[], mechanic:[], kratter:[],
                                      zucco:[], dathon:[]} }
export function pickTaunt(kind, ctx) -> string  // no repeats back-to-back
```

Content sourced from RESEARCH.md §Cast (real debate memes, paraphrased).

## Style

Dark pixel-war aesthetic: near-black `#0b0e14` field, blood-orange accents
`#ff6b35`, spam magenta `#ff3df5`, pure gold `#f7b32b`, knight steel
`#9fb4c7`. Font: system monospace stack + `Press Start 2P`-ish look via
CSS (NO external fonts — must be self-hosted-free; use monospace + text
effects instead). Everything must remain readable; the dataviz-style tiles
follow accessible contrast.

## Testing / verification

- `node --test test/` green: (a) vectors.test.mjs — ALL 16 official BIP-110
  vectors pass via rawtx.js + classifyTx; (b) classify.test.mjs — protocol
  detection against fixtures fetched ONCE from mempool.space for the
  verified sample txids in docs/research/taxonomy.json and saved to
  test/fixtures/*.json (committed, so tests run offline thereafter);
  (c) feed.smoke.mjs hits the live API once, skips gracefully offline.
- Manual: `python3 -m http.server` + browser; visual check.

## Deploy

Vercel static (`npx vercel deploy --prod`), project name `bitcoin-spam-war`,
account charlie-9292.
