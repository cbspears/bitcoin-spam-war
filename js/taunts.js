// taunts.js — pure data module for THE BATTLE FOR BLOCKSPACE.
// Zero DOM / window references so `node --test` can exercise it (Node 18).
// Copy is satirical pro-spam but technically accurate and non-defamatory;
// lines are paraphrased from the real 2026 filter-war debate (see
// docs/research/cast.json). Knight catchphrases below are VERBATIM from
// cast.json. Every line is trimmed to <=110 chars for the ticker/bubbles.
//
// Template slots understood by pickTaunt(): {height} {share} {pool}.

export const TAUNTS = {
  // General war banter, rotated on the ticker between events.
  ambient: [
    'Policy is not consensus, Sir Knight — your mempool is a suggestion box.',
    'datacarriersize=0? Adorable. My data identifies as program code, officer.',
    'Your node, your rules. My miner, my template. My monkey, your block.',
    'Spam filters are cardio for your CPU before the block arrives anyway.',
    'CVE-2023-50428. Severity rating: hurt feelings.',
    'Filters are security theater with worse uptime than the actors.',
    'Every sat is equal. Some sats are simply wearing wizard hats.',
    'Datacarrier limits are velvet ropes at a club with no walls.',
    "It's not blockchain bloat. It's blockchain culture.",
    'Satoshi put a headline in the genesis block. We are apprentices, not attackers.',
    '25% of nodes run Knots and 100% of my JPEGs still confirm. Filters vote; miners decide.',
    'First you filtered OP_RETURN, so we moved into the witness. Adapt. Inscribe. Overcome.',
    "Chain split risk? Bold threat from a fork that can't stop a cat picture.",
    'Core un-capped OP_RETURN to 100,000 bytes. The floodgates were removed and sold as a collectible.',
  ],
  // Fired when a block confirms (a "breach").
  breach: [
    'BLOCK {height} BREACHED — {share} spam by vsize, mined by {pool}. Receipts filed.',
    'Your full node bravely refused to relay this — I handed it to the miner directly.',
    'Another block, another horde waved through. Thank you for your service.',
    'Filtered by one pool, mined by the next. Not a wall — a toll-free detour.',
    'Two forks scheduled for August, zero JPEGs scheduled to stop.',
  ],
  // Fired on a whale inscription / very large data tx.
  bigSpam: [
    'A whale just inscribed. Your grandchildren will sync this one.',
    'Taproot Wizards once lobbed a ~4MB spellbook over the wall. Biggest block in history.',
    'I pay 200 sat/vB for art. You pay 1 and call yourselves the economic majority.',
    'Block 840,000 paid 37 BTC in fees for rune etchings. Your security budget says thanks.',
  ],
  // Fired on a genuinely clean (zero-violator) full-block scan.
  pureBlock: [
    'A PURE BLOCK. Frame it, knights — the horde took a coffee break.',
    'Zero violators this block. Enjoy it; the monkeys are just reloading.',
    'Clean block! Statistically inevitable, emotionally devastating for us. Encore?',
  ],
  // Fired when the mining pool is Ocean.
  ocean: [
    'OCEAN HOLDS THE LINE. Their template filters; the mempool shrugs and waits.',
    "Ocean calls the Core template 'the most spam.' We call it 'the most fees.'",
    'Ocean filters me. The next pool mines me. Same chain, different cope.',
  ],
  // Fired when a block signals BIP-110 (bit 4).
  signaling: [
    'Block {height} signals BIP-110, mined by {pool}. Mandatory for whom, exactly?',
    'Bit 4 is lit. The UASF of legends: a User-Activated Strongly-worded Forum post.',
    'Signal or be signaled. Block 961,632 approaches — and so do my inscriptions.',
  ],
  // Fired when a compliant data unit (mostly Runes) strolls the checkpoint.
  infiltrator: [
    'COMPLIANT ✓ (regrettably). My spam files its paperwork in OP_RETURN like a good citizen.',
    'A Rune strolls the checkpoint, briefcase in hand. Perfectly legal. Deeply annoying.',
    'Small runestone, big smirk. BIP-110 says I am fine. The knights disagree, quietly.',
    'Lawful evil, waved right through. The wall was never the point.',
  ],
  // Defender speech-bubble lines — VERBATIM catchphrases from cast.json.
  knightLines: {
    luke: [
      'Inscriptions are EXPLOITING A VULNERABILITY!',
      'datacarriersize=0!',
      "Spam filters DO work — they've worked since 2013!",
      'Fixed in Knots v25.1!',
      'Reject v30, or Bitcoin fails!',
    ],
    mechanic: [
      'Nobody is ENTITLED to relay!',
      'Miners, build your OWN templates!',
      "It's not censorship — it's a template!",
      'Your JPEG is not a financial transaction!',
      'Fewest spam, most Bitcoin!',
    ],
    kratter: [
      'Bitcoin Core has been COMPROMISED!',
      'Stay on Core 29 — or run Knots!',
      'The pleb migration cannot be stopped!',
      '1% to 25% and climbing!',
      'I have answered ALL objections!',
    ],
    zucco: [
      'Spam is bad. BIP-110 is ALSO bad!',
      'Satoshi filtered spam HIMSELF!',
      'Read the Lady Gaga thread!',
      'Filters yes — reckless forks no!',
    ],
    dathon: [
      'Block 961632 approaches!',
      'One year of clean blocks!',
      'Signal — or be signaled!',
      'Temporary fork, eternal message!',
    ],
  },
};

// Track the last line returned per pool so we never repeat back-to-back.
const lastPick = Object.create(null);

function poolFor(kind) {
  if (Array.isArray(TAUNTS[kind])) return TAUNTS[kind];
  if (TAUNTS.knightLines[kind]) return TAUNTS.knightLines[kind];
  return TAUNTS.ambient;
}

function fillSlots(line, ctx) {
  if (!ctx) return line;
  return line.replace(/\{(\w+)\}/g, (m, key) =>
    ctx[key] != null ? String(ctx[key]) : m
  );
}

// pickTaunt(kind, ctx) -> string. kind is a category key ('ambient',
// 'breach', 'bigSpam', 'pureBlock', 'ocean', 'signaling', 'infiltrator')
// or a knight id ('luke','mechanic','kratter','zucco','dathon'). ctx fills
// {height}/{share}/{pool} slots. Never returns the same line twice in a row
// for a given kind.
export function pickTaunt(kind, ctx) {
  const pool = poolFor(kind);
  if (!pool.length) return '';
  let choices = pool;
  if (pool.length > 1 && lastPick[kind] != null) {
    choices = pool.filter((l) => l !== lastPick[kind]);
    if (!choices.length) choices = pool;
  }
  const line = choices[Math.floor(Math.random() * choices.length)];
  lastPick[kind] = line;
  return fillSlots(line, ctx);
}
