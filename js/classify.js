// classify.js — pure, DOM-free transaction classifier.
//
// TWO layers computed in one pass over a mempool.space-shaped tx object
// (from GET /api/tx/:txid, or the identical shape produced by rawtx.js):
//   (a) PROTOCOL detection — what data protocol (if any) is riding this tx.
//   (b) BIP-110 rules 1-7 — would a block containing this tx be rejected while
//       the "reduced_data" soft fork is active? We apply the rules flat (the
//       fork is not active on mainnet) — "would violate BIP-110 if active".
//
// Grandfathering: BIP-110 exempts inputs spending pre-activation UTXOs from
// rules 2-7. The live site has no activation context, so it applies rules flat.
// The official test vectors DO exercise grandfathering, so an input whose
// prevout carries `grandfathered === true` skips rules 2-7 (rule 1 always
// applies to newly-created outputs). See docs/research/bip110.json.

// ---------------------------------------------------------------------------
// The 7 BIP-110 rules (verbatim text from docs/research/bip110.json).
// ---------------------------------------------------------------------------
const BIP110_URL = 'https://github.com/bitcoin/bips/blob/master/bip-0110.mediawiki';
export const RULES = [
  { id: '1', title: 'Oversized output scripts',
    text: 'New output scriptPubKeys exceeding 34 bytes are invalid, unless the first opcode is OP_RETURN, in which case up to 83 bytes are valid.',
    source: BIP110_URL },
  { id: '2', title: 'Oversized data pushes / witness items',
    text: 'OP_PUSHDATA* payloads and script argument witness items exceeding 256 bytes are invalid, except for the redeemScript push in BIP16 scriptSigs.',
    source: BIP110_URL },
  { id: '3', title: 'Undefined witness / tapleaf versions',
    text: 'Spending undefined witness (or Tapleaf) versions (ie, not Witness v0/BIP 141, Taproot/BIP 341, or P2A) is invalid. (Creating outputs with undefined witness versions is still valid.)',
    source: BIP110_URL },
  { id: '4', title: 'Taproot annex',
    text: 'Witness stacks with a Taproot annex are invalid.',
    source: BIP110_URL },
  { id: '5', title: 'Oversized taproot control block',
    text: 'Taproot control blocks larger than 257 bytes (a merkle tree with 128 script leaves) are invalid.',
    source: BIP110_URL },
  { id: '6', title: 'OP_SUCCESSx in tapscript',
    text: 'Tapscripts including OP_SUCCESS* opcodes anywhere (even unexecuted) are invalid.',
    source: BIP110_URL },
  { id: '7', title: 'OP_IF / OP_NOTIF in tapscript',
    text: 'Tapscripts executing the OP_IF or OP_NOTIF instruction (regardless of result) are invalid. (The inscription-envelope killer.)',
    source: BIP110_URL }
];

// ---------------------------------------------------------------------------
// Small byte / hex utilities (kept local so this module has no dependencies).
// ---------------------------------------------------------------------------
function hexToBytes(hex) {
  if (!hex) return new Uint8Array(0);
  const n = hex.length >> 1;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
function bytesToHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}
const DECODER = new TextDecoder('utf-8', { fatal: false });
function asciiText(bytes) { return DECODER.decode(bytes); }

// Find `pattern` in `hex` at an even (byte-aligned) index, else -1.
function evenIndexOf(hex, pattern) {
  let i = hex.indexOf(pattern);
  while (i >= 0 && (i & 1) === 1) i = hex.indexOf(pattern, i + 1);
  return i;
}

// ---------------------------------------------------------------------------
// ONE shared opcode-level script parser, used by BOTH the protocol layer
// (envelope extraction) and the BIP-110 layer (rules 2/6/7). Push payload
// BYTES are never mistaken for opcodes. Malformed tails stop cleanly.
// Only 0x01-0x4e are data pushes; 0x00 and 0x4f-0xff are bare opcodes
// (OP_0 pushes empty but is treated as a bare marker here — handy for
// envelope-separator detection).
// ---------------------------------------------------------------------------
function tokenizeScript(bytes) {
  const tokens = [];
  let i = 0;
  const n = bytes.length;
  while (i < n) {
    const op = bytes[i++];
    if (op >= 0x01 && op <= 0x4b) {
      const end = i + op;
      tokens.push({ op, isPush: true, data: bytes.subarray(i, end) });
      i = end;
    } else if (op === 0x4c) {
      if (i >= n) break;
      const len = bytes[i]; i += 1;
      const end = i + len;
      tokens.push({ op, isPush: true, data: bytes.subarray(i, end) });
      i = end;
    } else if (op === 0x4d) {
      if (i + 1 >= n) break;
      const len = bytes[i] | (bytes[i + 1] << 8); i += 2;
      const end = i + len;
      tokens.push({ op, isPush: true, data: bytes.subarray(i, end) });
      i = end;
    } else if (op === 0x4e) {
      if (i + 3 >= n) break;
      const len = (bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24)) >>> 0;
      i += 4;
      const end = i + len;
      tokens.push({ op, isPush: true, data: bytes.subarray(i, end) });
      i = end;
    } else {
      tokens.push({ op, isPush: false, data: null });
    }
  }
  return tokens;
}

// BIP342 OP_SUCCESSx opcode bytes.
function isOpSuccess(op) {
  return op === 80 || op === 98 ||
    (op >= 126 && op <= 129) || (op >= 131 && op <= 134) ||
    op === 137 || op === 138 || op === 141 || op === 142 ||
    (op >= 149 && op <= 153) || (op >= 187 && op <= 254);
}

// ---------------------------------------------------------------------------
// ARC4 / RC4 — ~15 lines, used to peel Stamps/SRC-20 and Counterparty data.
// ---------------------------------------------------------------------------
function arc4(key, data) {
  const S = new Uint8Array(256);
  for (let i = 0; i < 256; i++) S[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + S[i] + key[i % key.length]) & 255;
    const t = S[i]; S[i] = S[j]; S[j] = t;
  }
  const out = new Uint8Array(data.length);
  let i = 0; j = 0;
  for (let k = 0; k < data.length; k++) {
    i = (i + 1) & 255; j = (j + S[i]) & 255;
    const t = S[i]; S[i] = S[j]; S[j] = t;
    out[k] = data[k] ^ S[(S[i] + S[j]) & 255];
  }
  return out;
}

// ---------------------------------------------------------------------------
// scriptPubKey helpers.
// ---------------------------------------------------------------------------
function localBareMultisig(spk) {
  const n = spk.length;
  if (n < 4 || spk[n - 1] !== 0xae) return false;
  if (spk[0] < 0x51 || spk[0] > 0x60) return false;
  const nByte = spk[n - 2];
  if (nByte < 0x51 || nByte > 0x60) return false;
  const M = spk[0] - 0x50, N = nByte - 0x50;
  let i = 1, keys = 0;
  while (i < n - 2) {
    const op = spk[i];
    if (op >= 0x01 && op <= 0x4b) { i += 1 + op; keys++; } else return false;
  }
  return i === n - 2 && keys === N && M >= 1 && M <= N;
}

function typeFromSpk(spk) {
  if (spk.length >= 1 && spk[0] === 0x6a) return 'op_return';
  if (spk.length === 22 && spk[0] === 0x00 && spk[1] === 0x14) return 'v0_p2wpkh';
  if (spk.length === 34 && spk[0] === 0x00 && spk[1] === 0x20) return 'v0_p2wsh';
  if (spk.length === 34 && spk[0] === 0x51 && spk[1] === 0x20) return 'v1_p2tr';
  if (spk.length === 4 && spk[0] === 0x51 && spk[1] === 0x02 && spk[2] === 0x4e && spk[3] === 0x73) return 'anchor';
  if (localBareMultisig(spk)) return 'multisig';
  return 'unknown';
}
function voutType(o) {
  return o.scriptpubkey_type || typeFromSpk(hexToBytes(o.scriptpubkey || ''));
}
function prevoutType(prevout) {
  if (!prevout) return null;
  if (prevout.scriptpubkey_type) return prevout.scriptpubkey_type;
  if (prevout.scriptpubkey) return typeFromSpk(hexToBytes(prevout.scriptpubkey));
  return null;
}

// A canonical witness program: [OP_0 | OP_1..OP_16][push 2..40 bytes], exactly.
function witnessProgram(spk) {
  const n = spk.length;
  if (n < 4 || n > 42) return null;
  const op = spk[0];
  let version;
  if (op === 0x00) version = 0;
  else if (op >= 0x51 && op <= 0x60) version = op - 0x50;
  else return null;
  const push = spk[1];
  if (push < 0x02 || push > 0x28) return null;
  if (2 + push !== n) return null;
  return { version, program: spk.subarray(2) };
}

// ---------------------------------------------------------------------------
// Witness-role analysis: split a witness stack into script arguments, the
// executed script, control block and annex, according to the spend type.
// A control block is the last stack element of a taproot script-path spend
// (after any annex); its length is 33 + 32*m for merkle depth m.
// ---------------------------------------------------------------------------
function isControlBlockShape(el) {
  const n = el.length;
  // Length 33 + 32*m (m = merkle depth, 0..128) AND a taproot leaf-version
  // first byte (0xc0/0xc1 — the low bit is the y-parity). Without the leaf
  // byte, every 33-byte compressed pubkey of a P2WPKH/P2SH-P2WPKH spend looks
  // like a control block in the prevout-less block-scan path, poisoning the
  // rule 6/7 scan on the trailing DER-signature "tapscript".
  return n >= 33 && ((n - 33) % 32) === 0 && n <= 33 + 32 * 128 && (el[0] & 0xfe) === 0xc0;
}

function witnessRoles(witness, prevType) {
  const ws = witness.slice();
  const roles = {
    annex: null, tapscript: null, controlBlock: null,
    execScript: null, execType: null, scriptArgs: []
  };

  const takeTaprootScriptPath = () => {
    if (ws.length >= 2 && ws[ws.length - 1][0] === 0x50) roles.annex = ws.pop();
    if (ws.length >= 2) {
      roles.controlBlock = ws.pop();
      roles.tapscript = ws.pop();
      roles.execScript = roles.tapscript;
      roles.execType = 'tapscript';
      roles.scriptArgs = ws;
    }
    // else: keypath spend (single Schnorr sig) — exempt, nothing to check.
  };

  if (prevType === 'v1_p2tr') {
    takeTaprootScriptPath();
  } else if (prevType === 'v0_p2wsh') {
    if (ws.length >= 1) {
      roles.execScript = ws[ws.length - 1];
      roles.execType = 'witnessScript';
      roles.scriptArgs = ws.slice(0, -1);
    }
  } else if (prevType === 'v0_p2wpkh') {
    // [signature, pubkey] — both are keypath data, tiny; nothing to flag.
  } else if (prevType == null) {
    // Block-scan heuristic (no prevout): identify taproot script-path by a
    // trailing control-block-shaped element (this is how ord finds envelopes).
    // Pop a taproot annex FIRST (a trailing element starting 0x50): this catches
    // the keypath+annex form [schnorr sig, annex] that the control-block tests
    // would otherwise miss, and normalizes the script-path+annex form. Witness
    // scripts beginning 0x50/OP_RESERVED are practically nonexistent, so the
    // false-positive risk is negligible.
    if (ws.length >= 2 && ws[ws.length - 1][0] === 0x50) roles.annex = ws.pop();
    if (ws.length >= 2 && isControlBlockShape(ws[ws.length - 1])) {
      roles.controlBlock = ws.pop();
      roles.tapscript = ws.pop();
      roles.execScript = roles.tapscript;
      roles.execType = 'tapscript';
      roles.scriptArgs = ws;
    } else if (ws.length >= 2) {
      roles.execScript = ws[ws.length - 1];
      roles.execType = 'witnessScript';
      roles.scriptArgs = ws.slice(0, -1);
    }
  } else if (ws.length >= 2) {
    roles.execScript = ws[ws.length - 1];
    roles.execType = 'witnessScript';
    roles.scriptArgs = ws.slice(0, -1);
  }
  return roles;
}

// ---------------------------------------------------------------------------
// BIP-110 rule evaluation. Returns a Map<ruleId, detail> (first detail wins).
// ---------------------------------------------------------------------------
function collectViolations(vin, vout) {
  const v = new Map();
  const set = (id, detail) => { if (!v.has(id)) v.set(id, detail); };

  // RULE 1 — outputs (never grandfathered).
  for (const o of vout) {
    const spk = hexToBytes(o.scriptpubkey || '');
    if (spk.length === 0) continue;
    if (spk[0] === 0x6a) {
      if (spk.length > 83) set('1', `OP_RETURN output script is ${spk.length} bytes (> 83-byte cap)`);
    } else if (spk.length > 34) {
      set('1', `output scriptPubKey is ${spk.length} bytes (> 34-byte cap)`);
    }
  }

  // RULES 2-7 — per input.
  for (const input of vin) {
    if (input.prevout && input.prevout.grandfathered === true) continue; // pre-activation UTXO
    analyzeInput(input, set);
  }
  return v;
}

function analyzeInput(input, set) {
  const prevType = prevoutType(input.prevout);

  // scriptSig data pushes (legacy / P2SH). Rule 2 exempts ONLY "the redeemScript
  // push in BIP16 scriptSigs" — so the last-push exemption applies only when the
  // spend is actually P2SH (or the prevout type is unknown/absent, e.g. block
  // scans, where a legacy scriptSig may well be P2SH). When the prevout type is
  // known and is NOT p2sh (spending a P2PKH/P2PK output), the last push is plain
  // data and the >256-byte cap applies to it too.
  const scriptsig = hexToBytes(input.scriptsig || '');
  if (scriptsig.length) {
    const p2shExempt = prevType == null || prevType === 'p2sh' || prevType === 'unknown';
    const pushes = tokenizeScript(scriptsig).filter(t => t.isPush);
    for (let i = 0; i < pushes.length; i++) {
      const p = pushes[i];
      if (i === pushes.length - 1 && p2shExempt) {
        // Potential BIP16 redeemScript: the push itself is exempt, but its
        // internal pushes are still limited.
        if (p.data) checkScriptPushes(p.data, set);
      } else if (p.data && p.data.length > 256) {
        set('2', `scriptSig push payload is ${p.data.length} bytes (> 256)`);
      }
    }
  }

  const witness = (input.witness || []).map(hexToBytes);
  if (witness.length === 0) return;

  const roles = witnessRoles(witness, prevType);

  // RULE 4 — annex.
  if (roles.annex) set('4', 'witness stack carries a taproot annex');

  // RULE 5 — oversized control block.
  if (roles.controlBlock && roles.controlBlock.length > 257) {
    set('5', `taproot control block is ${roles.controlBlock.length} bytes (> 257)`);
  }

  // RULE 3 — undefined witness / tapleaf versions (needs the prevout).
  if (input.prevout && input.prevout.scriptpubkey) {
    const spk = hexToBytes(input.prevout.scriptpubkey);
    const wp = witnessProgram(spk);
    if (wp) {
      const allowed =
        (wp.version === 0 && (wp.program.length === 20 || wp.program.length === 32)) ||
        (wp.version === 1 && wp.program.length === 32) ||
        (wp.version === 1 && wp.program.length === 2 && wp.program[0] === 0x4e && wp.program[1] === 0x73);
      if (!allowed) {
        set('3', `spends an undefined witness v${wp.version} output`);
      } else if (wp.version === 1 && wp.program.length === 32 && roles.controlBlock) {
        const leafVersion = roles.controlBlock[0] & 0xfe;
        if (leafVersion !== 0xc0) {
          set('3', `spends an undefined tapleaf version 0x${leafVersion.toString(16)}`);
        }
      }
    }
  }

  // RULE 2 (b) — script-argument witness items > 256 bytes.
  for (const arg of roles.scriptArgs) {
    if (arg.length > 256) {
      set('2', `witness script-argument item is ${arg.length} bytes (> 256)`);
      break;
    }
  }

  // RULES 2(a) / 6 / 7 — scan the executed script's opcodes.
  if (roles.execScript) {
    if (roles.execType === 'tapscript') {
      for (const t of tokenizeScript(roles.execScript)) {
        if (t.isPush) {
          if (t.data && t.data.length > 256) set('2', `tapscript push payload is ${t.data.length} bytes (> 256)`);
        } else if (t.op === 0x63 || t.op === 0x64) {
          set('7', 'tapscript executes OP_IF/OP_NOTIF (inscription-envelope pattern)');
        } else if (isOpSuccess(t.op)) {
          set('6', `tapscript contains OP_SUCCESS opcode 0x${t.op.toString(16)}`);
        }
      }
    } else {
      checkScriptPushes(roles.execScript, set); // witnessScript: only push-size (rule 2a)
    }
  }
}

function checkScriptPushes(scriptBytes, set) {
  for (const t of tokenizeScript(scriptBytes)) {
    if (t.isPush && t.data && t.data.length > 256) {
      set('2', `script push payload is ${t.data.length} bytes (> 256)`);
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// PROTOCOL layer — precedence (per SPEC):
//   inscription/brc20 > acme > runes > stamps/src20 > counterparty
//   > op_return_large > memo > clean
// ---------------------------------------------------------------------------

// Locate & parse an ord/acme/atom tapscript envelope in any witness element.
function findEnvelope(vin) {
  for (const input of vin) {
    for (const wh of input.witness || []) {
      let proto = null;
      if (evenIndexOf(wh, '0063036f7264') >= 0) proto = 'ord';
      else if (evenIndexOf(wh, '00630461636d65') >= 0) proto = 'acme';
      else if (evenIndexOf(wh, '00630461746f6d') >= 0) proto = 'atom';
      if (!proto) continue;
      const parsed = parseEnvelope(hexToBytes(wh));
      if (parsed) return parsed;
    }
  }
  return null;
}

const ORD_BYTES = [0x6f, 0x72, 0x64];
const ACME_BYTES = [0x61, 0x63, 0x6d, 0x65];
const ATOM_BYTES = [0x61, 0x74, 0x6f, 0x6d];
function dataEquals(data, ref) {
  if (!data || data.length !== ref.length) return false;
  for (let i = 0; i < ref.length; i++) if (data[i] !== ref[i]) return false;
  return true;
}

// The bytes an opcode pushes onto the stack, or null if it isn't a push.
// Envelope tags/values are minimal-encoded in the wild: OP_1 (0x51) is used
// for the content-type tag as often as PUSH1 0x01, and OP_0 (0x00) is the
// empty-push body separator — so both must normalize to their pushed value.
function pushedValue(token) {
  if (token.isPush) return token.data || new Uint8Array(0);
  if (token.op === 0x00) return new Uint8Array(0);            // OP_0 → empty
  if (token.op >= 0x51 && token.op <= 0x60) return Uint8Array.of(token.op - 0x50); // OP_1..OP_16
  if (token.op === 0x4f) return Uint8Array.of(0x81);          // OP_1NEGATE
  return null;                                                // OP_IF / OP_ENDIF / OP_CHECKSIG…
}

function concatBytes(parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

function parseEnvelope(bytes) {
  const tokens = tokenizeScript(bytes);
  for (let k = 0; k + 2 < tokens.length; k++) {
    // OP_FALSE (0x00, bare) OP_IF (0x63) PUSH(protocol)
    if (tokens[k].op !== 0x00 || tokens[k + 1].op !== 0x63 || !tokens[k + 2].isPush) continue;
    const nameData = tokens[k + 2].data;
    let proto;
    if (dataEquals(nameData, ORD_BYTES)) proto = 'ord';
    else if (dataEquals(nameData, ACME_BYTES)) proto = 'acme';
    else if (dataEquals(nameData, ATOM_BYTES)) proto = 'atom';
    else continue;

    // Collect the pushed values of every push between the name and OP_ENDIF.
    const fields = [];
    let j = k + 3;
    for (; j < tokens.length && tokens[j].op !== 0x68; j++) {
      const pv = pushedValue(tokens[j]);
      if (pv !== null) fields.push(pv);
    }

    // ord/brc20: an empty push (OP_0) separates tag/value metadata from the body.
    // acme: TLV header then raw data chunks, no separator — the body is the set
    // of large (> 75-byte) content chunks.
    let sepIdx = -1;
    for (let i = 0; i < fields.length; i++) if (fields[i].length === 0) { sepIdx = i; break; }
    const metaEnd = sepIdx >= 0 ? sepIdx : fields.length;

    let contentType = null;
    for (let i = 0; i + 1 < metaEnd; i += 2) {
      if (fields[i].length === 1 && fields[i][0] === 0x01) contentType = asciiText(fields[i + 1]);
    }

    let bodyParts;
    if (sepIdx >= 0) bodyParts = fields.slice(sepIdx + 1);
    else bodyParts = fields.filter(f => f.length > 75);

    return { proto, contentType, body: concatBytes(bodyParts) };
  }
  return null;
}

// Return the payload bytes of the FIRST data push in an OP_RETURN script.
function opReturnFirstPush(spk) {
  const tokens = tokenizeScript(spk);
  for (const t of tokens) {
    if (t.op === 0x6a) continue;
    if (t.isPush) return t.data;
    return null;
  }
  return null;
}

// Concatenate SRC-20 / Counterparty data bytes across bare-multisig outputs:
// drop the last pubkey (real signer) per output, strip the first (sign) and
// last (nonce) byte of each remaining fake pubkey.
function multisigData(multisigVouts) {
  const parts = [];
  let total = 0;
  for (const o of multisigVouts) {
    const spk = hexToBytes(o.scriptpubkey || '');
    const pushes = tokenizeScript(spk).filter(t => t.isPush && t.data);
    for (let k = 0; k < pushes.length - 1; k++) {
      const pk = pushes[k].data;
      if (pk.length >= 2) { const chunk = pk.subarray(1, pk.length - 1); parts.push(chunk); total += chunk.length; }
    }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

const STAMP_PREFIX = [0x73, 0x74, 0x61, 0x6d, 0x70, 0x3a]; // 'stamp:'
const CNTRPRTY = [0x43, 0x4e, 0x54, 0x52, 0x50, 0x52, 0x54, 0x59]; // 'CNTRPRTY'
function matchAt(bytes, offset, ref) {
  if (bytes.length < offset + ref.length) return false;
  for (let i = 0; i < ref.length; i++) if (bytes[offset + i] !== ref[i]) return false;
  return true;
}

const MEMO_PREFIXES = [
  ['=:', 'THORChain swap memo'], ['OUT:', 'THORChain memo'], ['REFUND:', 'THORChain memo'],
  ['=|', 'THORChain memo'], ['SWAP:', 'swap memo'], ['ADD:', 'liquidity memo'],
  ['WITHDRAW:', 'liquidity memo'], ['to:', 'routing memo'], ['X2[', 'Stacks block-commit'],
  ['id', 'protocol tag'], ['omni', 'Omni Layer'], ['SP', 'Stacks tag']
];

function detectProtocol(tx) {
  const vin = tx.vin || [];
  const vout = tx.vout || [];
  const key = vin[0] ? hexToBytes(vin[0].txid || '') : new Uint8Array(0);

  // 1) Tapscript envelope: ord / brc20 / acme / atom.
  const env = findEnvelope(vin);
  if (env) {
    if (env.proto === 'ord') {
      const brc = tryBrc20(env.body);
      if (brc) {
        const bits = [brc.op, brc.tick, brc.amt].filter(Boolean).join(' ');
        return {
          protocol: 'brc20', dataBytes: env.body.length, contentType: env.contentType || 'text/plain',
          payloadPreview: truncate(asciiText(env.body)),
          note: `BRC-20 ${bits}`.trim()
        };
      }
      return {
        protocol: 'inscription', dataBytes: env.body.length, contentType: env.contentType,
        payloadPreview: previewBody(env.contentType, env.body),
        note: 'Ordinal inscription'
      };
    }
    if (env.proto === 'acme') {
      return {
        protocol: 'acme', dataBytes: env.body.length, contentType: env.contentType,
        payloadPreview: truncate('ACME envelope ' + (env.contentType || '') + ' ' + bytesToHex(env.body.subarray(0, 24))),
        note: 'ACME tapscript envelope'
      };
    }
    // atom = Atomicals (effectively dead) — unrecognized-but-real data envelope.
    return {
      protocol: 'unknown_data', dataBytes: env.body.length, contentType: env.contentType,
      payloadPreview: truncate('Atomicals (atom) envelope ' + bytesToHex(env.body.subarray(0, 24))),
      note: 'Atomicals envelope'
    };
  }

  // 2) ACME OP_RETURN (payload begins 'ACME').
  for (const o of vout) {
    if (voutType(o) !== 'op_return') continue;
    const payload = opReturnFirstPush(hexToBytes(o.scriptpubkey || ''));
    if (payload && matchAt(payload, 0, [0x41, 0x43, 0x4d, 0x45])) {
      return {
        protocol: 'acme', dataBytes: payload.length, contentType: null,
        payloadPreview: truncate('ACME ' + bytesToHex(payload.subarray(0, 32))),
        note: 'ACME OP_RETURN metaprotocol'
      };
    }
  }

  // 3) Runes (OP_RETURN starting 6a5d, anchored at position 0).
  for (const o of vout) {
    if (voutType(o) !== 'op_return') continue;
    const spkHex = o.scriptpubkey || '';
    if (spkHex.startsWith('6a5d')) {
      const spk = hexToBytes(spkHex);
      const oversized = spk.length > 83;
      return {
        protocol: 'runes', dataBytes: Math.max(0, spk.length - 2), contentType: null,
        payloadPreview: truncate('runestone ' + spkHex.slice(4, 64)),
        note: oversized ? 'Runestone (oversized datacarrier)' : 'Runestone (OP_RETURN, compliant)'
      };
    }
  }

  // 4) Stamps / SRC-20 & Counterparty via bare multisig.
  const multis = vout.filter(o => voutType(o) === 'multisig');
  if (multis.length && key.length) {
    const data = multisigData(multis);
    if (data.length) {
      const dec = arc4(key, data);
      if (matchAt(dec, 2, STAMP_PREFIX)) {                 // uint16 len + 'stamp:'
        const len = (dec[0] << 8) | dec[1];
        const json = asciiText(dec.subarray(2, Math.min(dec.length, 2 + Math.max(0, len))));
        return {
          protocol: 'src20', dataBytes: data.length, contentType: null,
          payloadPreview: truncate(json), note: 'Bitcoin Stamps / SRC-20 (bare multisig)'
        };
      }
      if (matchAt(dec, 1, CNTRPRTY)) {                     // len byte + 'CNTRPRTY'
        return {
          protocol: 'counterparty', dataBytes: data.length, contentType: null,
          payloadPreview: truncate('CNTRPRTY (multisig) type ' + (dec[9] ?? '?')),
          note: 'Counterparty (bare multisig)'
        };
      }
      // Multisig data we cannot decode is still unprunable UTXO-set bloat.
      return {
        protocol: 'stamps', dataBytes: data.length, contentType: null,
        payloadPreview: truncate('bare-multisig data ' + bytesToHex(data.subarray(0, 24))),
        note: 'Bare-multisig data embedding'
      };
    }
  }

  // 5) Counterparty OP_RETURN (ARC4 decrypts to 'CNTRPRTY').
  if (key.length) {
    for (const o of vout) {
      if (voutType(o) !== 'op_return') continue;
      const payload = opReturnFirstPush(hexToBytes(o.scriptpubkey || ''));
      if (payload && payload.length >= 8) {
        const dec = arc4(key, payload);
        if (matchAt(dec, 0, CNTRPRTY)) {
          return {
            protocol: 'counterparty', dataBytes: payload.length, contentType: null,
            payloadPreview: truncate('CNTRPRTY type ' + (dec[8] ?? '?')),
            note: 'Counterparty (OP_RETURN)'
          };
        }
      }
    }
  }

  // 6) Large OP_RETURN datacarrier (> 83 script bytes, unrecognized).
  for (const o of vout) {
    if (voutType(o) !== 'op_return') continue;
    const spk = hexToBytes(o.scriptpubkey || '');
    if (spk.length > 83) {
      const payload = opReturnFirstPush(spk);
      return {
        protocol: 'op_return_large', dataBytes: payload ? payload.length : spk.length - 1, contentType: null,
        payloadPreview: truncate(bytesToHex(spk.subarray(0, 40))),
        note: 'Oversized OP_RETURN datacarrier'
      };
    }
  }

  // 7) Small OP_RETURN → functional memo (citizen).
  for (const o of vout) {
    if (voutType(o) !== 'op_return') continue;
    const spk = hexToBytes(o.scriptpubkey || '');
    const payload = opReturnFirstPush(spk) || spk.subarray(1);
    const text = asciiText(payload);
    let kind = null;
    for (const [pfx, name] of MEMO_PREFIXES) { if (text.startsWith(pfx)) { kind = name; break; } }
    return {
      protocol: 'memo', dataBytes: payload.length, contentType: null,
      payloadPreview: truncate(isPrintable(text) ? text : bytesToHex(payload.subarray(0, 24))),
      note: kind || 'OP_RETURN memo'
    };
  }

  // 8) Clean payment.
  return { protocol: 'clean', dataBytes: 0, contentType: null, payloadPreview: null, note: 'Clean payment' };
}

function tryBrc20(body) {
  try {
    const j = JSON.parse(asciiText(body));
    if (j && j.p === 'brc-20') return j;
  } catch (_) { /* not JSON / not brc-20 */ }
  return null;
}
function previewBody(contentType, body) {
  if (contentType && /^(text|application\/json)/.test(contentType)) return truncate(asciiText(body));
  return truncate((contentType ? contentType + ' ' : '') + bytesToHex(body.subarray(0, 24)));
}
function isPrintable(s) {
  return s.length > 0 && /^[\x09\x0a\x0d\x20-\x7e]*$/.test(s);
}
function truncate(s, n = 200) {
  if (s == null) return null;
  s = String(s);
  return s.length > n ? s.slice(0, n) : s;
}

// ---------------------------------------------------------------------------
// Faction / emoji cosmetics (disclosed as cosmetic in the "How this works"
// modal — we can't cheaply resolve collection membership). Deterministic pick
// from txid so a unit keeps the same face across re-renders.
// ---------------------------------------------------------------------------
const INSCRIPTION_POOL = [
  ['NodeMonkes', '🐒'], ['Bitcoin Puppets', '🤡'], ['Quantum Cats', '🐱'],
  ['Taproot Wizards', '🧙'], ['Bitcoin Frogs', '🐸'], ['Ordinal Maxi Biz', '👁️'],
  ['Wizards of Ord', '🪄']
];
function pickFrom(pool, txid) {
  let h = 0;
  const s = txid || '';
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return pool[h % pool.length];
}
function factionFor(protocol, ctx) {
  switch (protocol) {
    case 'brc20': return { faction: 'BRC-20 Zerg', emoji: '📄' };
    case 'inscription': { const p = pickFrom(INSCRIPTION_POOL, ctx.txid); return { faction: p[0], emoji: p[1] }; }
    case 'runes': return ctx.violation ? { faction: 'Runestone Siege', emoji: '🪨' } : { faction: 'Runes Syndicate', emoji: '⚡' };
    case 'src20': return { faction: 'Stamps Legion', emoji: '📮' };
    case 'stamps': return { faction: 'Stamps Legion', emoji: '📮' };
    case 'counterparty': return { faction: 'Rare Pepe Cartel', emoji: '🃏' };
    case 'acme': return { faction: 'ACME Syndicate', emoji: '📦' };
    case 'op_return_large': return { faction: 'Datacarrier Brigade', emoji: '🗄️' };
    case 'unknown_data': return { faction: 'Unknown Payload', emoji: '👾' };
    case 'memo': return { faction: 'Functional Memo', emoji: '' };
    case 'clean': default:
      return ctx.violation ? { faction: 'Nonstandard Spender', emoji: '👾' } : { faction: 'Honest Money', emoji: '' };
  }
}

function fmtBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(2) + ' MB';
}

function labelFor(protocol, proto, violation) {
  const size = fmtBytes(proto.dataBytes);
  switch (protocol) {
    case 'brc20': return `BRC-20 ${proto.note.replace(/^BRC-20 ?/, '') || 'token'} inscription (${size})`;
    case 'inscription': return `Ordinal inscription (${proto.contentType || 'unknown type'}, ${size})`;
    case 'runes': return violation ? `Oversized runestone (${size})` : `Runestone (${size}, compliant)`;
    case 'src20': return `Bitcoin Stamps / SRC-20 (${size})`;
    case 'stamps': return `Bare-multisig data embedding (${size})`;
    case 'counterparty': return `Counterparty message (${size})`;
    case 'acme': return `ACME payload (${size})`;
    case 'op_return_large': return `Large OP_RETURN datacarrier (${size})`;
    case 'unknown_data': return `Unknown data envelope (${size})`;
    case 'memo': return proto.note && proto.note !== 'OP_RETURN memo' ? `Functional memo — ${proto.note}` : 'Functional OP_RETURN memo';
    case 'clean': default: return violation ? 'Nonstandard transaction' : 'Clean payment';
  }
}

// ---------------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------------
/**
 * @param {object} tx mempool.space-shaped tx (or rawtx.js output).
 * @returns {object} Verdict (see SPEC.md for the exact shape).
 */
export function classifyTx(tx) {
  const vin = tx.vin || [];
  const vout = tx.vout || [];

  // Coinbase is never spam — the witness commitment (aa21a9ed) and merge-mining
  // tags are consensus-required, not datacarrier abuse.
  if (vin.some(v => v && v.is_coinbase)) {
    return {
      archetype: 'citizen', compliant: true, violations: [], protocol: 'clean',
      faction: 'Coinbase', label: 'Coinbase (block reward)', emoji: '',
      details: ['Coinbase transaction — the miner\'s reward, exempt from every rule.'],
      dataBytes: 0, contentType: null, payloadPreview: null
    };
  }

  const violMap = collectViolations(vin, vout);
  const violations = [];
  for (const [ruleId, detail] of violMap) violations.push({ ruleId, detail });
  violations.sort((a, b) => a.ruleId.localeCompare(b.ruleId));
  const compliant = violations.length === 0;
  const hasViolation = !compliant;

  const proto = detectProtocol(tx);
  const protocol = proto.protocol;
  const isDataProtocol = protocol !== 'clean' && protocol !== 'memo';

  let archetype;
  if (hasViolation) archetype = 'violator';
  else if (isDataProtocol) archetype = 'infiltrator';
  else archetype = 'citizen';

  const { faction, emoji } = factionFor(protocol, { txid: tx.txid, violation: hasViolation });
  const label = labelFor(protocol, proto, hasViolation);

  const details = [`Protocol: ${label}`];
  if (proto.note && proto.note !== label) details.push(proto.note);
  if (proto.contentType) details.push(`Content-type: ${proto.contentType}`);
  if (proto.dataBytes) details.push(`Payload: ${fmtBytes(proto.dataBytes)}`);
  if (hasViolation) {
    for (const vi of violations) {
      const rule = RULES.find(r => r.id === vi.ruleId);
      details.push(`BIP-110 Rule ${vi.ruleId} (${rule ? rule.title : '?'}): ${vi.detail}`);
    }
    details.push('Would violate BIP-110 if the soft fork were active.');
  } else if (archetype === 'infiltrator') {
    details.push('BIP-110 compliant — strolls through the checkpoint (regrettably).');
  } else {
    details.push('Clean payment — no arbitrary data. Waved through.');
  }

  return {
    archetype,
    compliant,
    violations,
    protocol,
    faction,
    label,
    emoji,
    details,
    dataBytes: proto.dataBytes || 0,
    contentType: proto.contentType || null,
    payloadPreview: proto.payloadPreview || null
  };
}
