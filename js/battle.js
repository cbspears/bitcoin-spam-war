// js/battle.js — THE BATTLE FOR BLOCKSPACE, engine + game loop.
//
// A side-view Canvas 2D diorama. Every combat unit is a REAL classified mempool
// transaction (see js/classify.js Verdict shape). The three Filter Knights
// (LUKE-JR, MECHANIC, KRATTER) defend the castle gate — "THE BLOCKCHAIN" — and
// lose, gloriously and repeatedly. Blocks confirm; spam storms through.
//
// Public API (integration contract — see SPEC §js/battle.js):
//   new Battlefield(canvas, { onUnitClick, getTaunt })
//   .spawnTx({ tx, verdict })
//   .confirmBlock({ block, report, minedTxids })   // legacy: confirmBlock(report)
//   .setProjected(mempoolBlocks)
//   .resize()
//
// Constraints honored here:
//  * window / document / requestAnimationFrame are touched ONLY inside methods,
//    never at import time, so the integrator can `import` this under Node for
//    wiring checks (`node --check --input-type=module`).
//  * Nothing is imported except the sibling drawing helpers in ./sprites.js.
//  * Per-frame allocations kept near zero: fixed pools for particles & shots,
//    a recycle list for units, a reused z-order buffer.

import {
  drawSky, drawGround, drawScorch, drawScanlines, drawCastle, drawKnight,
  drawCameo, drawCoin, drawInfiltrator, drawViolator, drawProjectile,
  drawDing, drawSpeechBubble, drawBanner, pickPfp,
} from './sprites.js';

const PFP_BASE = 'assets/pfps/'; // collection-art assets, same-origin

// ---- palette (duplicated from sprites.js on purpose; see SPEC §Style) ------
const C = {
  bg: '#0b0e14',
  orange: '#ff6b35',
  magenta: '#ff3df5',
  gold: '#f7b32b',
  steel: '#9fb4c7',
  green: '#3ddc84',
  purple: '#b06bff',
};

// ---- tunables --------------------------------------------------------------
const CAP_UNITS = 150;          // mosh-pit soft cap; oldest loiterers fade out
const HARD_UNITS = CAP_UNITS + 24;
const CAP_PARTICLES = 400;
const POOL_SHOTS = 64;
const CAP_BUBBLES = 22;
const WHALE_BYTES = 100 * 1024; // slow-mo + shake + permanent scorch
const MAX_DELTA = 0.05;         // clamp frame dt (also absorbs tab-resume jumps)
const MAX_SCORCH = 28;
const INFILTRATOR_SHARE = 0.40; // keep suits at ≤ ~40% of on-screen units

// ---- knights ---------------------------------------------------------------
const KNIGHTS = [
  { key: 'luke', name: 'LUKE-JR', accent: '#8c6bff', emblem: '🛡' },
  { key: 'mechanic', name: 'MECHANIC', accent: '#2ec5b6', emblem: '⚓' },
  { key: 'kratter', name: 'KRATTER', accent: '#ff6b35', emblem: '🎓' },
];
const SHOT_LABELS = ['datacarriersize=42', '-permitbaremultisig=0', 'datacarrier=0', '-rejectparasites'];

// ---- fallback taunt pools (used when no getTaunt hook is supplied) ----------
// Paraphrased from RESEARCH.md §Cast — short enough for a speech bubble.
const KNIGHT_LINES = {
  luke: ['datacarriersize=0!', 'Fixed in Knots v25.1!', 'Inscriptions exploit a vulnerability!', 'Reject v30, or Bitcoin fails!'],
  mechanic: ['Nobody is ENTITLED to relay!', 'Build your OWN templates!', 'Your JPEG is not a financial transaction!', "It's a template, not censorship!"],
  kratter: ['Core has been COMPROMISED!', 'Stay on Core 29 — or run Knots!', '1% to 25% and climbing!', 'I answered ALL objections!'],
  zucco: ['Spam is bad. BIP-110 is ALSO bad!', 'Satoshi filtered spam himself!', 'Read the Lady Gaga thread!', 'Filters yes — reckless forks no!'],
  dathon: ['Block 961632 approaches.', 'Signal — or be signaled.', 'One year of clean blocks.', 'Temporary fork, eternal message.'],
};
const SPAM_LINES = [
  'Policy is not consensus, Sir Knight.',
  'My data identifies as program code, officer.',
  'Every sat is equal. Some wear wizard hats.',
  'Filters are just cardio for your CPU.',
  'Your wall is a velvet rope at a club with no walls.',
  'Nice filter. My JPEG still confirmed.',
  'LFPUPPETS.',
];
const FUME_LINES = ['COMPLIANT?! It files paperwork in OP_RETURN!', 'A small runestone... regrettably legal.', 'This is lawful evil and you know it.', 'Wave it through. WAVE. IT. THROUGH.'];
const BREACH_LINES = ['They got in again.', 'Hold the line! ...it did not hold.', 'Next block, surely.'];
const CELEBRATE_LINES = ['We did it! A clean block!', 'The filters HELD!', 'Screenshot this one, plebs.'];

// ---- tiny pure helpers -----------------------------------------------------
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);

function factionEmojiFor(proto) {
  switch (proto) {
    case 'inscription': return pick(['🐒', '🤡', '🐱', '🧙', '🐸', '👁️']);
    case 'brc20': return '📄';
    case 'runes': return pick(['⚡', '🪨']);
    case 'stamps': case 'src20': return '📮';
    case 'counterparty': return '🃏';
    case 'acme': return '🧪';
    case 'op_return_large': return '📜';
    case 'memo': return '📝';
    default: return '🖼️';
  }
}
function hueFor(proto) {
  switch (proto) {
    case 'stamps': case 'src20': return C.orange;
    case 'runes': case 'op_return_large': return C.gold;
    case 'counterparty': return C.purple;
    case 'brc20': return C.green;
    default: return C.magenta;
  }
}
function extractViolatorCount(rep) {
  if (!rep) return 0;
  const c = rep.counts || rep.archetypeCounts || rep.archetypes || {};
  const cands = [
    rep.violators,
    c.byArchetype && c.byArchetype.violator, // feed.js buildBlockReport() shape
    c.archetypes && c.archetypes.violator,
    c.archetype && c.archetype.violator,
    c.violator, c.violators,
  ];
  for (const v of cands) if (typeof v === 'number') return v;
  if (Array.isArray(rep.topOffenders)) return rep.topOffenders.length;
  return 0;
}

// mempool.space pool is an object {name, slug, id} (or null). Tolerate a bare
// string too. Returns {name, slug, isOcean}.
function readPool(rep, block) {
  const raw = (rep && rep.pool) || (block && block.extras && block.extras.pool) || null;
  let name = '', slug = '';
  if (raw && typeof raw === 'object') {
    slug = String(raw.slug || '');
    name = String(raw.name || raw.slug || '');
  } else if (raw != null) {
    name = slug = String(raw);
  }
  return { name, slug, isOcean: slug.toLowerCase() === 'ocean' || /ocean/i.test(name) };
}
function normalizeMinedSet(mined) {
  if (mined instanceof Set) return mined;
  const s = new Set();
  if (Array.isArray(mined)) for (const t of mined) s.add(typeof t === 'string' ? t : (t && t.txid));
  return s;
}

// ===========================================================================
export class Battlefield {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onUnitClick = typeof opts.onUnitClick === 'function' ? opts.onUnitClick : null;
    this.getTaunt = typeof opts.getTaunt === 'function' ? opts.getTaunt : null;

    // scene state
    this.time = 0;
    this._last = 0;
    this._resumed = false;
    this.dpr = 1;
    this.W = 800;
    this.H = 400;

    this.units = [];
    this._deadUnits = [];
    this._z = [];               // reused z-order index buffer
    this.bubbles = [];
    this.scorches = [];
    this.breachQueue = [];

    // fixed pools
    this.particles = new Array(CAP_PARTICLES);
    for (let i = 0; i < CAP_PARTICLES; i++) this.particles[i] = { active: false };
    this.shots = new Array(POOL_SHOTS);
    for (let i = 0; i < POOL_SHOTS; i++) this.shots[i] = { active: false };

    // knights
    this.knights = KNIGHTS.map((def, i) => ({
      def, homeX: 0, phase: i * 1.7, castTimer: rand(1.2, 3),
      tempPose: 'idle', poseTimer: 0,
    }));
    this.moodPose = 'idle';
    this.moodTimer = 0;

    // effects
    this.shake = 0;
    this.slowmo = 0;
    this.gate = { open: 0, target: 0, hold: 0 };
    this.banner = null;
    this.cameo = null;

    // block / forecast display
    this.height = null;
    this.projectedText = '';

    // collection PFPs (loaded async; emoji fallback until then / on failure)
    this.manifest = null;
    this.pfpImages = new Map(); // fileRel -> HTMLImageElement

    // ambient schedulers
    this.knightSpeakTimer = rand(3, 7);
    this.spamSpeakTimer = rand(4, 8);
    this.ambientTimer = rand(6, 12);
    this.cameoTimer = rand(20, 45);

    // bound listeners
    this._loop = (now) => this.frame(now);
    this._onClick = (e) => this.handlePointer(e, true);
    this._onMove = (e) => this.handlePointer(e, false);
    this._onResize = () => this.resize();
    this._onVis = () => { if (!(typeof document !== 'undefined' && document.hidden)) this._resumed = true; };

    this.resize();
    canvas.addEventListener('click', this._onClick);
    canvas.addEventListener('mousemove', this._onMove);
    window.addEventListener('resize', this._onResize);
    document.addEventListener('visibilitychange', this._onVis);
    this.loadPfps();
    this._raf = requestAnimationFrame(this._loop);
  }

  // ---- collection PFPs ----------------------------------------------------
  // Fetch the manifest and lazily preload the (tiny, 64x64) collection images.
  // Non-blocking: construction never waits on it, and any failure leaves the
  // horde on the emoji fallback with zero console errors.
  loadPfps() {
    if (typeof fetch !== 'function') return;
    fetch(PFP_BASE + 'manifest.json')
      .then((r) => (r && r.ok ? r.json() : null))
      .then((m) => {
        if (!m || !m.collections) return;
        this.manifest = m;
        if (typeof Image === 'function') {
          for (const slug in m.collections) {
            const files = (m.collections[slug] && m.collections[slug].files) || [];
            for (const file of files) {
              if (this.pfpImages.has(file)) continue;
              const img = new Image();
              img.decoding = 'async';
              img.onerror = () => { /* stays incomplete → emoji fallback */ };
              img.src = PFP_BASE + file;
              this.pfpImages.set(file, img);
            }
          }
        }
        // retro-skin violators already on the field (manifest may land after
        // the first backfill surge has spawned).
        for (const u of this.units) {
          if (u.kind === 'violator' && !u.pfp) this.assignPfp(u);
        }
      })
      .catch(() => { /* no manifest → emoji everywhere */ });
  }

  // Deterministic face for a violator unit; also stamps verdict._pfp so the HUD
  // dossier shows the same art (see hud.js pfpFor). Safe to call before the
  // manifest loads (no-op) — resets are done by the caller.
  assignPfp(u) {
    if (!this.manifest) return;
    const proto = u.verdict && u.verdict.protocol;
    const pick = pickPfp(proto, u.txid, this.manifest);
    if (!pick) return;
    u.pfp = pick;
    u.pfpImg = this.pfpImages.get(pick.file) || null;
    if (u.verdict) u.verdict._pfp = { collection: pick.name, file: pick.file };
  }

  destroy() {
    cancelAnimationFrame(this._raf);
    this.canvas.removeEventListener('click', this._onClick);
    this.canvas.removeEventListener('mousemove', this._onMove);
    window.removeEventListener('resize', this._onResize);
    document.removeEventListener('visibilitychange', this._onVis);
  }

  // ---- layout / sizing ----------------------------------------------------
  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const cssW = Math.max(1, rect.width || this.canvas.clientWidth || 800);
    const cssH = Math.max(1, rect.height || this.canvas.clientHeight || 400);
    const dpr = clamp(window.devicePixelRatio || 1, 1, 3);
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.W = cssW; this.H = cssH; this.dpr = dpr;
    this.spd = clamp(cssW / 900, 0.6, 1.6);
    this.layout();
  }

  layout() {
    const W = this.W, H = this.H;
    const groundY = Math.round(H * 0.84);
    const castTop = Math.round(H * 0.18);
    const castW = clamp(W * 0.22, 150, 360);
    const gateW = clamp(castW * 0.34, 46, 92);
    const gateH = clamp((groundY - castTop) * 0.52, 70, 160);
    const gateX = castW - gateW - 8;
    const gateTop = groundY - gateH;
    const doorW = 26, doorH = 42;
    const doorX = castW - doorW - 4;
    const doorY = groundY - doorH;

    this.groundY = groundY;
    this.castTop = castTop;
    this.castW = castW;
    this.geo = {
      x: 0, top: castTop, w: castW,
      gateX, gateW, gateTop, gateH,
      doorX, doorY, doorW, doorH,
    };
    // interaction anchors (units approach from the right)
    this.wallX = castW + 10;
    this.wallY = gateTop + gateH * 0.45;
    this.checkX = castW + 6;
    this.checkY = groundY - 14;
    this.gateInX = gateX + gateW * 0.4;
    this.gateInY = gateTop + gateH * 0.6;
    this.spawnX = W + 40;
    this.pitX0 = castW + 110;
    this.pitX1 = clamp(W * 0.62, castW + 200, W - 40);
    this.pitTop = groundY - Math.min(140, gateH * 0.9);

    const kSpacing = Math.min(56, (this.pitX0 - (castW + 34)) / 3 + 34);
    for (let i = 0; i < this.knights.length; i++) {
      this.knights[i].homeX = castW + 40 + i * kSpacing;
    }
  }

  // ---- public: spawn a mempool unit --------------------------------------
  spawnTx(payload) {
    if (!payload || !payload.verdict) return;
    const verdict = payload.verdict;
    const tx = payload.tx || {};
    const kind = verdict.archetype === 'infiltrator' || verdict.archetype === 'citizen'
      ? verdict.archetype : (verdict.violations && verdict.violations.length ? 'violator' : 'citizen');

    // throttle the suit army so infiltrators never dominate the screen
    if (kind === 'infiltrator' && this.overInfiltratorCap()) return;

    const dataBytes = num(verdict.dataBytes) || 0;
    if (dataBytes > WHALE_BYTES) this.triggerWhale(dataBytes, verdict);

    const hidden = typeof document !== 'undefined' && document.hidden;
    const u = this._deadUnits.pop() || {};
    u.active = true;
    u.kind = kind;
    u.tx = tx;
    u.verdict = verdict;
    u.txid = tx.txid || verdict.txid || '';
    u.dataBytes = dataBytes;
    u.emoji = verdict.emoji || factionEmojiFor(verdict.protocol);
    u.hue = hueFor(verdict.protocol);
    u.dim = verdict.protocol === 'memo';
    u.born = this.time;
    u.age = 0;
    u.phase = Math.random() * 6.283;
    u.fade = 1;
    u.fadeIn = hidden ? 1 : 0;
    u.stamp = 0;
    u.timer = 0;
    u.reload = rand(3, 7);
    u.wanderT = 0;
    u.tx0 = 0; u.ty0 = 0;

    if (kind === 'violator') {
      // Floor of 34px: most violators are tiny BRC-20s (~60B payloads) but
      // their collection-art faces are the whole show — keep them readable.
      u.size = clamp(34 + 8 * Math.log10(1 + dataBytes / 100), 34, 92);
    } else if (kind === 'infiltrator') {
      u.size = 24;
    } else {
      u.size = 20; // citizen coin diameter-ish
    }

    // collection art (reset first — units are recycled from _deadUnits)
    u.pfp = null;
    u.pfpImg = null;
    if (kind === 'violator') this.assignPfp(u);

    if (hidden) {
      // tab is backgrounded: drop straight into the pit so we don't get a
      // marching stampede on resume (the loop is paused anyway).
      u.state = kind === 'violator' ? 'loiter' : 'through';
      u.x = kind === 'violator' ? rand(this.pitX0, this.pitX1) : this.checkX + rand(0, 30);
      u.y = kind === 'violator' ? rand(this.pitTop, this.groundY - 20) : this.checkY;
      u.tx0 = u.x; u.ty0 = u.y;
    } else {
      u.state = kind === 'violator' ? 'charge' : 'march';
      u.x = this.spawnX + rand(0, 60);
      u.y = kind === 'violator' ? this.wallY + rand(-40, 60) : this.checkY + rand(-4, 4);
    }

    this.units.push(u);
    this.enforceCap();
  }

  overInfiltratorCap() {
    const total = this.units.length;
    if (total < 12) return false;
    let inf = 0;
    for (const u of this.units) if (u.kind === 'infiltrator') inf++;
    return inf >= INFILTRATOR_SHARE * total;
  }

  triggerWhale(dataBytes, verdict) {
    this.slowmo = Math.max(this.slowmo, 0.9);
    this.shake = Math.max(this.shake, 15);
    const x = clamp(this.wallX + rand(20, 120), this.castW + 20, this.W - 20);
    this.scorches.push({ x, y: this.groundY + 2, r: clamp(28 + Math.log10(dataBytes) * 8, 30, 90) });
    if (this.scorches.length > MAX_SCORCH) this.scorches.shift();
    this.burst(x, this.groundY - 10, 40, 'ember');
    const kb = (dataBytes / 1024).toFixed(0);
    this.addBubble(x, this.groundY - 60, `🖼 JPEG NUKE — ${kb}KB inscription`, C.magenta, true);
  }

  // ---- public: block confirmed -------------------------------------------
  // Accepts the merged {block, report, minedTxids} shape (task contract) OR a
  // bare report object (SPEC's confirmBlock(report)); both are tolerated.
  confirmBlock(arg) {
    if (!arg) return;
    let block, report, mined;
    if ('minedTxids' in arg || ('block' in arg && 'report' in arg)) {
      block = arg.block; report = arg.report; mined = arg.minedTxids;
    } else {
      report = arg; // legacy: the report itself
    }
    const b = block || {};
    const rep = report || null;

    const height = num(b.height != null ? b.height : rep && rep.height);
    if (height != null) this.height = height;

    const pool = readPool(rep, b);

    let signaling = rep && rep.signaling;
    if (signaling == null && typeof b.version === 'number') {
      signaling = (b.version & 0xE0000010) === 0x20000010;
    }
    signaling = !!signaling;

    const pure = !!(rep && rep.pure);
    // prefer report.spamShare; else derive from spamVBytes / totalVBytes
    let pct = null;
    const share = rep && rep.spamShare;
    if (typeof share === 'number') pct = Math.round(share <= 1 ? share * 100 : share);
    else if (rep && num(rep.totalVBytes)) pct = Math.round((num(rep.spamVBytes) || 0) / rep.totalVBytes * 100);

    this.breachQueue.push({
      height, poolName: pool.name || 'an unknown pool', isOcean: pool.isOcean,
      signaling, pure, pct,
      violators: extractViolatorCount(rep), minedSet: normalizeMinedSet(mined),
      hasReport: !!rep,
    });
    if (this.breachQueue.length > 8) this.breachQueue.shift();
  }

  // ---- public: projected next-block forecast -----------------------------
  setProjected(mempoolBlocks) {
    if (!Array.isArray(mempoolBlocks) || mempoolBlocks.length === 0) {
      this.projectedText = '';
      return;
    }
    let vbytes = 0;
    for (const mb of mempoolBlocks) vbytes += num(mb.blockVSize) || num(mb.blockSize) || 0;
    const mb = (vbytes / 1e6).toFixed(1);
    this.projectedText = `↧ ${mempoolBlocks.length} blocks queued · ~${mb}MB pending`;
  }

  // ---- the loop -----------------------------------------------------------
  frame(now) {
    this._raf = requestAnimationFrame(this._loop);
    if (this._last === 0) this._last = now;
    let dt = (now - this._last) / 1000;
    this._last = now;
    if (this._resumed) { this._resumed = false; dt = Math.min(dt, 0.032); }
    if (!(dt > 0)) dt = 0.016;
    dt = Math.min(dt, MAX_DELTA);
    this.update(dt);
    this.render();
  }

  update(realDt) {
    if (this.slowmo > 0) this.slowmo -= realDt;
    if (this.shake > 0) this.shake = Math.max(0, this.shake - realDt * 34);
    const dt = realDt * (this.slowmo > 0 ? 0.35 : 1);
    this.time += dt;

    this.processBreachQueue();
    this.updateGate(dt);
    this.updateKnights(dt);
    this.updateCameo(dt);
    this.updateUnits(dt);
    this.updateShots(dt);
    this.updateParticles(dt);
    this.updateBubbles(dt);
    this.updateBanner(dt);
    this.schedule(dt);
  }

  // ---- breach handling ----------------------------------------------------
  processBreachQueue() {
    // one breach at a time; wait until the gate has mostly closed again
    if (this.breachQueue.length === 0) return;
    if (this.gate.target === 1 || this.gate.open > 0.25) return;
    this.runBreach(this.breachQueue.shift());
  }

  runBreach(ev) {
    if (ev.height != null) this.height = ev.height;
    this.gate.target = 1;
    this.gate.hold = 2.4;

    // mark confirmed units to storm the gate
    let matched = 0;
    if (ev.minedSet.size) {
      for (const u of this.units) {
        if (u.state !== 'through' && u.txid && ev.minedSet.has(u.txid)) {
          u.state = 'storm'; matched++;
        }
      }
    }
    // representative surge when few (or none) of our sampled units matched
    if (matched < 6 && !ev.pure) {
      let want = Math.min(12 - matched, this.units.length);
      // prefer violators, then infiltrators, then anyone loitering
      const order = ['violator', 'infiltrator', 'citizen'];
      for (const kind of order) {
        for (const u of this.units) {
          if (want <= 0) break;
          if (u.kind === kind && (u.state === 'loiter' || u.state === 'march')) {
            u.state = 'storm'; want--;
          }
        }
      }
    }

    // headline + mood (priority: pure > ocean > signaling > breached)
    let text, color, mood, sub;
    const h = ev.height != null ? ev.height.toLocaleString('en-US') : '???';
    const pctTxt = ev.pct != null ? ev.pct + '% spam by vsize' : 'spam share n/a';
    if (ev.pure) {
      text = '✨ PURE BLOCK ✨'; color = C.gold; mood = 'cheer';
      sub = `block ${h} · ZERO violators · the knights earned this one`;
    } else if (ev.isOcean) {
      text = '🌊 OCEAN HOLDS THE LINE'; color = C.steel; mood = 'cheer';
      sub = `block ${h} · only ${ev.pct != null ? ev.pct + '%' : '—'} spam — filters actually held`;
    } else if (ev.signaling) {
      text = '⚠ THIS BLOCK SIGNALS BIP-110'; color = C.gold; mood = 'rally';
      sub = `block ${h} · bit-4 set · ${pctTxt} · mined by ${ev.poolName}`;
    } else {
      text = `BLOCK ${h} BREACHED`; color = C.magenta; mood = 'fume';
      const vio = ev.violators ? `${ev.violators} violators in · ` : '';
      sub = `${pctTxt} · ${vio}mined by ${ev.poolName}`;
    }
    if (ev.signaling && !/SIGNALS/.test(text)) sub += ' · signals BIP-110 ⚠';

    this.banner = { text, sub, color, age: 0, ttl: 3.6, flash: 1 };
    this.moodPose = mood; this.moodTimer = 3.2;

    // confetti + shake
    const celebrate = ev.pure || ev.isOcean;
    const cols = celebrate ? [C.gold, C.steel, C.green] : [C.magenta, C.orange, C.gold];
    this.burst(this.geo.gateX + this.geo.gateW / 2, this.geo.gateTop + 8, celebrate ? 70 : 90, 'confetti', cols);
    this.shake = Math.max(this.shake, ev.violators > 120 ? 10 : 6);

    // a knight reacts out loud — pass real ctx so {height}/{share}/{pool} slots
    // in the breach/signaling lines resolve (the pctTxt already trails " spam by
    // vsize", so {share} is the bare percentage here).
    const speaker = pick(this.knights);
    const tctx = { height: h, share: ev.pct != null ? ev.pct + '%' : '—', pool: ev.poolName };
    let line;
    if (ev.pure || ev.isOcean) line = this.taunt(ev.pure ? 'pureBlock' : 'ocean', CELEBRATE_LINES, tctx);
    else if (ev.signaling) line = this.taunt('signaling', KNIGHT_LINES[speaker.def.key], tctx);
    else line = this.taunt('breach', BREACH_LINES, tctx);
    this.addBubble(speaker.homeX, this.groundY - 74, line, speaker.def.accent);
  }

  updateGate(dt) {
    const g = this.gate;
    if (g.hold > 0) { g.hold -= dt; if (g.hold <= 0) g.target = 0; }
    g.open += (g.target - g.open) * Math.min(1, dt * 6);
    if (g.open < 0.002) g.open = 0;
  }

  // ---- knights ------------------------------------------------------------
  updateKnights(dt) {
    if (this.moodTimer > 0) this.moodTimer -= dt;
    for (const k of this.knights) {
      if (k.poseTimer > 0) k.poseTimer -= dt;
      k.castTimer -= dt;
      if (k.castTimer <= 0) {
        k.castTimer = rand(1.4, 3.2);
        this.knightFire(k);
      }
    }
  }

  knightFire(k) {
    // aim at the nearest violator in the forward zone
    let target = null, best = Infinity;
    const minX = this.castW + 60, maxX = this.W * 0.72;
    for (const u of this.units) {
      if (u.kind !== 'violator' || u.state === 'storm' || u.state === 'through') continue;
      if (u.x < minX || u.x > maxX) continue;
      const d = Math.abs(u.x - k.homeX);
      if (d < best) { best = d; target = u; }
    }
    const ox = k.homeX + 8, oy = this.groundY - 40;
    let tx, ty;
    if (target) { tx = target.x; ty = target.y - target.size * 0.3; }
    else { tx = ox + rand(120, 220); ty = this.wallY + rand(-30, 40); } // fire into the pit anyway
    const s = this.allocShot();
    if (!s) return;
    const dx = tx - ox, dy = ty - oy;
    const d = Math.hypot(dx, dy) || 1;
    const spd = 340 * this.spd;
    s.active = true; s.x = ox; s.y = oy;
    s.vx = dx / d * spd; s.vy = dy / d * spd;
    s.life = 2.4; s.bounced = false; s.hue = k.def.accent;
    s.label = pick(SHOT_LABELS);
    k.tempPose = 'cast'; k.poseTimer = 0.4;
  }

  knightPose(k) {
    if (k.poseTimer > 0) return k.tempPose;
    if (this.moodTimer > 0) return this.moodPose;
    return 'idle';
  }

  // ---- units --------------------------------------------------------------
  updateUnits(dt) {
    for (let i = this.units.length - 1; i >= 0; i--) {
      const u = this.units[i];
      u.age += dt;
      if (u.fadeIn < 1) u.fadeIn = Math.min(1, u.fadeIn + dt * 4);
      let dead = false;

      switch (u.state) {
        case 'march': dead = this.stepMarch(u, dt); break;
        case 'charge': this.stepCharge(u, dt); break;
        case 'loiter': this.stepLoiter(u, dt); break;
        case 'stamp': this.stepStamp(u, dt); break;
        case 'storm': dead = this.stepStorm(u, dt); break;
        case 'through': dead = this.stepThrough(u, dt); break;
        case 'leaving':
          u.fade -= dt * 0.7;
          if (u.fade <= 0) dead = true;
          break;
      }
      if (dead) {
        const last = this.units.length - 1;
        this.units[i] = this.units[last];
        this.units.pop();
        u.active = false;
        this._deadUnits.push(u);
      }
    }
  }

  stepMarch(u, dt) {
    const speed = (u.kind === 'infiltrator' ? 46 : 74) * this.spd;
    const arrived = this.moveToward(u, this.checkX + 8, this.checkY, speed, dt);
    if (arrived) {
      if (u.kind === 'infiltrator') { u.state = 'stamp'; u.timer = 1.0; u.stamp = 1; this.fumeNearestKnight(u); }
      else { u.state = 'through'; }
    }
    return false;
  }

  stepCharge(u, dt) {
    const speed = 92 * this.spd;
    const arrived = this.moveToward(u, this.wallX + 6, u.ty0 || this.wallY, speed, dt);
    if (arrived) {
      // bounce off the wall into the mosh pit
      u.state = 'loiter';
      u.reload = rand(4, 9);
      u.wanderT = 0;
      this.burst(u.x, u.y, 4, 'ember', [u.hue]);
      if (Math.random() < 0.25) this.addBubble(u.x, u.y - u.size, this.taunt('bigSpam', SPAM_LINES), u.hue);
    }
    return false;
  }

  stepLoiter(u, dt) {
    u.reload -= dt; u.wanderT -= dt;
    if (u.wanderT <= 0) {
      u.tx0 = rand(this.pitX0, this.pitX1);
      u.ty0 = rand(this.pitTop, this.groundY - 18);
      u.wanderT = rand(1.4, 3.2);
    }
    this.moveToward(u, u.tx0, u.ty0, 30 * this.spd, dt);
    if (u.reload <= 0 && Math.random() < 0.4) { u.state = 'charge'; u.ty0 = this.wallY + rand(-30, 50); }
    return false;
  }

  stepStamp(u, dt) {
    u.timer -= dt;
    u.stamp = clamp(u.timer / 1.0, 0, 1);
    if (u.timer <= 0) u.state = 'through';
    return false;
  }

  stepStorm(u, dt) {
    const arrived = this.moveToward(u, this.gateInX, this.gateInY, 170 * this.spd, dt);
    if (Math.random() < dt * 6) this.burst(u.x, u.y, 2, 'confetti', [C.magenta, C.gold]);
    if (arrived || u.x < this.geo.gateX + 4) {
      u.fade -= dt * 3;
      if (u.fade <= 0) { this.burst(u.x, u.y, 6, 'confetti', [C.magenta, C.gold, C.green]); return true; }
    }
    return false;
  }

  stepThrough(u, dt) {
    // citizens / infiltrators pass legally through the checkpoint door
    this.moveToward(u, this.castW - 6, this.checkY, 90 * this.spd, dt);
    u.fade -= dt * 1.6;
    return u.fade <= 0;
  }

  moveToward(u, tx, ty, speed, dt) {
    const dx = tx - u.x, dy = ty - u.y;
    const d = Math.hypot(dx, dy);
    const step = speed * dt;
    if (d <= step || d < 0.5) { u.x = tx; u.y = ty; return true; }
    u.x += dx / d * step; u.y += dy / d * step;
    return false;
  }

  fumeNearestKnight(u) {
    let k = null, best = Infinity;
    for (const kn of this.knights) {
      const d = Math.abs(kn.homeX - u.x);
      if (d < best) { best = d; k = kn; }
    }
    if (!k) return;
    k.tempPose = 'fume'; k.poseTimer = 1.6;
    if (Math.random() < 0.3) this.addBubble(k.homeX, this.groundY - 74, this.taunt('infiltrator', FUME_LINES), k.def.accent);
  }

  // ---- projectiles (filter shots) ----------------------------------------
  allocShot() {
    for (const s of this.shots) if (!s.active) return s;
    return null;
  }

  updateShots(dt) {
    for (const s of this.shots) {
      if (!s.active) continue;
      s.life -= dt;
      s.x += s.vx * dt; s.y += s.vy * dt;
      if (!s.bounced) {
        // reflect off the first violator we clip
        for (const u of this.units) {
          if (u.kind !== 'violator' || u.state === 'storm' || u.state === 'through') continue;
          const r = u.size * 0.55 + 6;
          if ((s.x - u.x) ** 2 + (s.y - u.y) ** 2 <= r * r) {
            const nx = (s.x - u.x) || 1, ny = (s.y - u.y) || -1;
            const nl = Math.hypot(nx, ny) || 1;
            // bounce away from the violator, kicked upward — filters never land
            s.vx = (nx / nl) * 220 + rand(20, 80);
            s.vy = (ny / nl) * 160 - rand(60, 140);
            s.bounced = true;
            s.life = Math.min(s.life, 0.55);
            if (Math.random() < 0.22) this.addDing(u.x, u.y - u.size * 0.6);
            else this.burst(s.x, s.y, 3, 'ember', [s.hue]);
            break;
          }
        }
      }
      if (s.life <= 0 || s.x < -20 || s.x > this.W + 20 || s.y > this.H + 20) s.active = false;
    }
  }

  // ---- particles ----------------------------------------------------------
  allocParticle() {
    for (const p of this.particles) if (!p.active) return p;
    return null;
  }

  burst(x, y, n, kind, cols) {
    const palette = cols || [C.magenta, C.gold, C.orange];
    for (let i = 0; i < n; i++) {
      const p = this.allocParticle();
      if (!p) return;
      p.active = true;
      p.kind = kind;
      p.x = x; p.y = y;
      p.color = pick(palette);
      if (kind === 'confetti') {
        p.vx = rand(-90, 90); p.vy = rand(-220, -40);
        p.grav = 340; p.size = rand(3, 6);
        p.rot = Math.random() * 6.28; p.spin = rand(-10, 10);
        p.ttl = p.life = rand(0.9, 1.8);
      } else { // ember
        p.vx = rand(-70, 70); p.vy = rand(-120, -10);
        p.grav = 120; p.size = rand(1.5, 3.5);
        p.rot = 0; p.spin = 0;
        p.ttl = p.life = rand(0.4, 0.9);
      }
    }
  }

  updateParticles(dt) {
    for (const p of this.particles) {
      if (!p.active) continue;
      p.life -= dt;
      if (p.life <= 0) { p.active = false; continue; }
      p.vy += p.grav * dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.rot += p.spin * dt;
    }
  }

  // ---- bubbles ------------------------------------------------------------
  addBubble(x, y, text, color, big) {
    if (!text) return;
    let t = String(text);
    if (t.length > 74) t = t.slice(0, 72) + '…';
    // nudge up to avoid stacking on an existing bubble at a similar x
    let by = y;
    for (let tries = 0; tries < 5; tries++) {
      let clash = false;
      for (const b of this.bubbles) {
        if (Math.abs(b.x - x) < 130 && Math.abs(b.y - by) < 30) { clash = true; break; }
      }
      if (!clash) break;
      by -= 30;
    }
    if (by < 14) by = 14;
    this.bubbles.push({ x, y: by, text: t, color: color || C.steel, age: 0, ttl: big ? 3.4 : 2.6, drift: rand(6, 14) });
    while (this.bubbles.length > CAP_BUBBLES) this.bubbles.shift();
  }

  addDing(x, y) {
    this.bubbles.push({ x, y, text: 'POLICY ≠ CONSENSUS', color: C.orange, age: 0, ttl: 1.1, drift: 26, ding: true });
    while (this.bubbles.length > CAP_BUBBLES) this.bubbles.shift();
  }

  updateBubbles(dt) {
    for (let i = this.bubbles.length - 1; i >= 0; i--) {
      const b = this.bubbles[i];
      b.age += dt;
      b.y -= b.drift * dt;
      if (b.age >= b.ttl) this.bubbles.splice(i, 1);
    }
  }

  updateBanner(dt) {
    if (!this.banner) return;
    this.banner.age += dt;
    this.banner.flash = Math.max(0, this.banner.flash - dt * 3);
    if (this.banner.age >= this.banner.ttl) this.banner = null;
  }

  // ---- cameo walk-ons -----------------------------------------------------
  updateCameo(dt) {
    const cam = this.cameo;
    if (!cam) return;
    cam.p += dt / cam.dur;
    cam.x = lerp(cam.x0, cam.x1, clamp(cam.p, 0, 1));
    cam.speakT -= dt;
    if (cam.speakT <= 0) {
      cam.speakT = rand(2.0, 3.2);
      let line;
      if (cam.kind === 'dathon') line = this.taunt('dathon', KNIGHT_LINES.dathon);
      else {
        // Zucco argues with BOTH sides — alternate the target
        cam.side = !cam.side;
        line = cam.side ? this.taunt('zucco', KNIGHT_LINES.zucco) : pick(['Spam is STILL an attack, plebs.', 'And your fork could split the chain!']);
      }
      this.addBubble(cam.x, cam.y - 14, line, cam.kind === 'dathon' ? C.magenta : C.gold);
    }
    if (cam.p >= 1) this.cameo = null;
  }

  startCameo() {
    const kind = Math.random() < 0.5 ? 'zucco' : 'dathon';
    const y = this.castTop - 2;
    this.cameo = {
      kind, y, dur: rand(8, 12), p: 0, speakT: 0.4, side: false,
      x0: this.castW - 10, x1: 10, x: this.castW - 10,
    };
  }

  // ---- ambient scheduler --------------------------------------------------
  schedule(dt) {
    this.knightSpeakTimer -= dt;
    if (this.knightSpeakTimer <= 0) {
      this.knightSpeakTimer = rand(5, 11);
      const k = pick(this.knights);
      this.addBubble(k.homeX, this.groundY - 74, this.taunt(k.def.key, KNIGHT_LINES[k.def.key]), k.def.accent);
    }
    this.spamSpeakTimer -= dt;
    if (this.spamSpeakTimer <= 0) {
      this.spamSpeakTimer = rand(4, 9);
      const loiterers = this.units.filter((u) => u.kind === 'violator' && u.state === 'loiter');
      if (loiterers.length) {
        const u = pick(loiterers);
        this.addBubble(u.x, u.y - u.size, this.taunt('bigSpam', SPAM_LINES), u.hue);
      }
    }
    this.ambientTimer -= dt;
    if (this.ambientTimer <= 0) {
      this.ambientTimer = rand(8, 16);
      if (this.units.length) {
        const u = pick(this.units);
        this.addBubble(u.x, u.y - 20, this.taunt('ambient', SPAM_LINES), C.steel);
      }
    }
    this.cameoTimer -= dt;
    if (this.cameoTimer <= 0) {
      this.cameoTimer = rand(28, 55);
      if (!this.cameo) this.startCameo();
    }
  }

  // getTaunt hook is optional; always fall back to a built-in line. `ctx` fills
  // {height}/{share}/{pool} template slots — without it, breach/signaling lines
  // leak raw placeholders into the speech bubble.
  taunt(kind, fallback, ctx) {
    let s = '';
    if (this.getTaunt) { try { s = this.getTaunt(kind, ctx || {}); } catch (_) { s = ''; } }
    if (typeof s !== 'string' || !s) s = pick(fallback || SPAM_LINES);
    return s;
  }

  // ---- input --------------------------------------------------------------
  handlePointer(e, isClick) {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const u = this.hitTest(x, y);
    if (!isClick) {
      this.canvas.style.cursor = u ? 'pointer' : 'default';
      return;
    }
    if (u && this.onUnitClick) {
      // build the dossier payload lazily: real tx fields + the verdict
      const info = Object.assign({}, u.tx, { verdict: u.verdict, tx: u.tx });
      this.onUnitClick(info);
    }
  }

  hitTest(x, y) {
    // front-to-back: prefer the visually nearest (largest y) hit. Hit regions
    // are centered on the DRAWN center of each sprite (see drawUnit), not the
    // feet, so the whole visible unit is clickable.
    let hit = null, bestY = -Infinity;
    for (const u of this.units) {
      if (u.state === 'through') continue;
      let cy, r;
      if (u.kind === 'violator') { cy = u.y - u.size * 0.5; r = u.size * 0.62; }
      else if (u.kind === 'infiltrator') { cy = u.y - u.size * 0.6; r = u.size * 0.72; }
      else { cy = u.y - u.size * 0.5; r = u.size * 0.62; } // citizen coin
      const dy = y - cy;
      if ((x - u.x) ** 2 + dy ** 2 <= r * r) {
        if (u.y > bestY) { bestY = u.y; hit = u; }
      }
    }
    return hit;
  }

  // ---- render -------------------------------------------------------------
  render() {
    const ctx = this.ctx, W = this.W, H = this.H;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, W, H);

    ctx.save();
    if (this.shake > 0.2) {
      ctx.translate((Math.random() - 0.5) * this.shake, (Math.random() - 0.5) * this.shake);
    }

    drawSky(ctx, W, H, this.time);
    for (const s of this.scorches) drawScorch(ctx, s.x, s.y, s.r);
    drawGround(ctx, W, H, this.groundY);

    drawCastle(ctx, this.geo, this.groundY, {
      open: this.gate.open,
      height: this.height,
      lampOn: true,
      projected: this.projectedText,
      mood: this.moodPose,
    });

    // knights (behind the horde so charging units read as "in front")
    for (const k of this.knights) {
      drawKnight(ctx, k.homeX, this.groundY, 40, {
        accent: k.def.accent, name: k.def.name, emblem: k.def.emblem,
        t: this.time, phase: k.phase, facing: 1, pose: this.knightPose(k),
      });
    }

    // units, painted back-to-front by y
    this._z.length = 0;
    for (let i = 0; i < this.units.length; i++) this._z.push(i);
    this._z.sort((a, b) => this.units[a].y - this.units[b].y);
    for (const idx of this._z) this.drawUnit(ctx, this.units[idx]);

    // filter shots
    for (const s of this.shots) if (s.active) drawProjectile(ctx, s.x, s.y, 3, s.hue);

    // cameo on the battlement
    if (this.cameo) drawCameo(ctx, this.cameo.x, this.cameo.y, 34, this.cameo.kind, this.time);

    // particles over the field
    this.drawParticles(ctx);

    // speech bubbles (top of the world layer)
    for (const b of this.bubbles) {
      const a = b.age < 0.2 ? b.age / 0.2 : clamp((b.ttl - b.age) / 0.5, 0, 1);
      if (b.ding) drawDing(ctx, b.x, b.y, b.text, a);
      else drawSpeechBubble(ctx, b.x, b.y, b.text, a, b.color);
    }

    if (this.banner) {
      drawBanner(ctx, W, H, this.banner.text, this.banner.sub, this.banner.color, this.banner.flash);
    }

    ctx.restore();

    // CRT overlay in screen space (unaffected by shake)
    drawScanlines(ctx, W, H);
  }

  drawUnit(ctx, u) {
    const a = Math.min(u.fade, u.fadeIn);
    if (a <= 0) return;
    ctx.globalAlpha = a;
    if (u.kind === 'citizen') {
      drawCoin(ctx, u.x, u.y - u.size * 0.5, u.size * 0.5, this.time, u.dim);
    } else if (u.kind === 'infiltrator') {
      drawInfiltrator(ctx, u.x, u.y, u.size, this.time, { emoji: u.emoji, stamp: u.stamp });
    } else {
      drawViolator(ctx, u.x, u.y - u.size * 0.5, u.size, {
        emoji: u.emoji, hue: u.hue, t: this.time,
        charge: u.state === 'charge' ? 1 : 0,
        image: u.pfpImg, pixel: u.pfp ? u.pfp.pixel : false,
      });
    }
    ctx.globalAlpha = 1;
  }

  drawParticles(ctx) {
    for (const p of this.particles) {
      if (!p.active) continue;
      const a = clamp(p.life / p.ttl, 0, 1);
      ctx.globalAlpha = a;
      ctx.fillStyle = p.color;
      if (p.kind === 'confetti') {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
        ctx.restore();
      } else {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  // ---- cap enforcement ----------------------------------------------------
  enforceCap() {
    if (this.units.length <= CAP_UNITS) return;
    // fade the oldest loiterer
    let oldest = null;
    for (const u of this.units) {
      if (u.state === 'loiter' && (!oldest || u.born < oldest.born)) oldest = u;
    }
    if (oldest) oldest.state = 'leaving';
    // hard ceiling: recycle outright so we never grow unbounded
    while (this.units.length > HARD_UNITS) {
      let oi = 0;
      for (let i = 1; i < this.units.length; i++) {
        if (this.units[i].born < this.units[oi].born) oi = i;
      }
      const u = this.units[oi];
      const last = this.units.length - 1;
      this.units[oi] = this.units[last];
      this.units.pop();
      u.active = false;
      this._deadUnits.push(u);
    }
  }
}
