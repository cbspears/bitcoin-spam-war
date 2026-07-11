// hud.js — DOM panels for THE BATTLE FOR BLOCKSPACE.
// Listens to MempoolFeed events, updates the header/doomsday-clock/scoreboard/
// kill-feed/ticker/dossier/modal, and forwards stream+block events on to the
// Battlefield engine (spawnTx / confirmBlock / setProjected). No canvas code.
//
// Contract: initHud({feed, battlefield, taunts}) -> { showDossier }.
//   feed        : MempoolFeed (EventTarget) from js/feed.js
//   battlefield : Battlefield from js/battle.js (we call spawnTx/confirmBlock/
//                 setProjected)
//   taunts      : the js/taunts.js module namespace ({ pickTaunt, TAUNTS })
//
// Every getElementById target used here MUST exist in index.html.

import { RULES } from './classify.js';

// --- BIP-110 deployment constants (from docs/research/bip110.json) ----------
const MANDATORY_SIGNALING_BLOCK = 961632; // blocks not signaling get rejected
const MAX_ACTIVATION_BLOCK = 965664;      // ~Sep 1 2026
const SIGNALING_THRESHOLD = 0.55;         // 55% (1109 / 2016)
const MINUTES_PER_BLOCK = 10;             // ETA math
const SIGNAL_WINDOW = 100;                // "N of last M blocks" window
const KILLFEED_MAX = 60;                  // cap kill-feed rows
const STREAM_RING = 600;                  // observed-spam rolling sample size
const STREAM_VIOLATOR_CAP = 800;          // remembered streamed violators
const BLOCK_CONFIRM_FALLBACK_MS = 30000;  // fire breach off bare 'block' if no report
const CONFIRMED_BLOCKS_CAP = 256;         // bound the "already-breached" id set

const RULE_BY_ID = Object.create(null);
for (const r of RULES || []) RULE_BY_ID[r.id] = r;

// --- small DOM + format helpers --------------------------------------------
const $ = (id) => document.getElementById(id);
const setText = (id, text) => { const el = $(id); if (el) el.textContent = text; };

function fmtInt(n) {
  if (!Number.isFinite(n)) return '—';
  return Math.round(n).toLocaleString('en-US');
}
function fmtBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
function fmtPct(x) {
  if (!Number.isFinite(x)) return '—';
  return `${(x * 100).toFixed(1)}%`;
}
function shortTxid(txid) {
  if (!txid || typeof txid !== 'string') return '????????';
  return `${txid.slice(0, 8)}…${txid.slice(-4)}`;
}
function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : undefined; }

// Read a per-archetype count from a block report. The report's exact `counts`
// shape is the one soft point in the feed contract, so we probe the likely
// nestings before giving up. Flagged for the integrator in the README notes.
function reportArch(report, name) {
  const c = report && report.counts;
  if (!c) return 0;
  return (
    num(c?.byArchetype?.[name]) ?? // feed.js reduceReport() shape (the contract)
    num(c?.archetypes?.[name]) ??
    num(c?.archetype?.[name]) ??
    num(c?.[name]) ??
    0
  );
}

const PROTOCOL_EMOJI = {
  inscription: '🧙', brc20: '📄', stamps: '📮', src20: '📮',
  counterparty: '🃏', runes: '⚡', acme: '👁️', op_return_large: '🪨',
  memo: '📝', clean: '🪙', unknown_data: '❓',
};
function unitEmoji(verdict) {
  if (verdict && verdict.emoji) return verdict.emoji;
  return (verdict && PROTOCOL_EMOJI[verdict.protocol]) || '🃏';
}
const KNIGHTS = ['LUKE-JR', 'MECHANIC', 'KRATTER', 'ZUCCO', 'the Filter Knights'];
let knightIdx = 0;
const nextKnight = () => KNIGHTS[knightIdx++ % KNIGHTS.length];

export function initHud({ feed, battlefield, taunts }) {
  const pickTaunt = (taunts && taunts.pickTaunt) || (() => '');

  // ---- session state -------------------------------------------------------
  const state = {
    height: null,
    price: null,                 // USD per BTC (for dossier conversions)
    // FULL-block-scan tallies (violators + infiltrators + blockspace share):
    violators: 0,
    infiltrators: 0,
    spamVBytes: 0,
    totalVBytes: 0,
    blocksSincePure: 0,
    sawPureEver: false,
    signalHistory: [],           // booleans, most-recent last, capped
    // streamed "observed" spam ring (labeled, not headline):
    obs: [],                     // {vsize, spam}
    obsSpam: 0,
    obsTotal: 0,
    streamViolators: new Map(),  // txid -> {tx, verdict} awaiting confirmation
    lastReactive: 0,
    // block-confirm plumbing: the 'block' event carries the mined txid Set but
    // the breach animation runs off the follow-up 'blockreport'. Stash the Set
    // by block id so applyReport can hand the engine the real confirmed units,
    // and keep a fallback timer per block for when no report ever arrives.
    minedByBlock: new Map(),     // block id -> minedTxids Set
    confirmedBlocks: new Set(),  // block ids already breach-animated
    confirmTimers: new Map(),    // block id -> fallback setTimeout handle
  };

  // Record a block as breach-animated, bounding the set so it can't grow
  // unbounded over a long session (these ids are never re-queried once passed).
  function markConfirmed(id) {
    if (!id) return;
    state.confirmedBlocks.add(id);
    if (state.confirmedBlocks.size > CONFIRMED_BLOCKS_CAP) {
      const it = state.confirmedBlocks.values();
      for (let i = 0; i < CONFIRMED_BLOCKS_CAP >> 1; i++) {
        const v = it.next();
        if (v.done) break;
        state.confirmedBlocks.delete(v.value);
      }
    }
  }

  // ---- header / status -----------------------------------------------------
  function onStatus(detail) {
    const { mode = 'down', message = '' } = detail || {};
    const badge = $('live-badge');
    if (badge) {
      badge.classList.remove('is-live', 'is-degraded', 'is-down');
      if (mode === 'live') { badge.textContent = '● LIVE'; badge.classList.add('is-live'); }
      else if (mode === 'degraded') { badge.textContent = '● DEGRADED'; badge.classList.add('is-degraded'); }
      else { badge.textContent = '● OFFLINE'; badge.classList.add('is-down'); }
    }
    setText('status-line', message || (mode === 'live'
      ? 'Streaming the mempool. The horde is on the move.'
      : mode === 'degraded'
        ? 'Stream running hot — sampling to stay polite to mempool.space.'
        : 'Reconnecting to the front…'));
  }

  // ---- doomsday clock ------------------------------------------------------
  function renderDoomsday() {
    if (!Number.isFinite(state.height)) return;
    renderCountdown('dc-primary', 'MANDATORY BIP-110 SIGNALING', MANDATORY_SIGNALING_BLOCK);
    renderCountdown('dc-secondary', 'Max activation', MAX_ACTIVATION_BLOCK);

    const hist = state.signalHistory;
    const seen = hist.length;
    const signaled = hist.filter(Boolean).length;
    const share = seen ? signaled / seen : 0;
    setText('dc-signaling',
      seen
        ? `Signaling: ${signaled} of last ${seen} blocks (${(share * 100).toFixed(1)}% — need 55%)`
        : 'Signaling: no blocks scanned yet (need 55%)');
    const bar = $('dc-bar');
    if (bar) bar.style.width = `${Math.min(100, (share / SIGNALING_THRESHOLD) * 100).toFixed(1)}%`;
  }
  function renderCountdown(id, label, target) {
    const blocks = target - state.height;
    if (blocks <= 0) {
      setText(id, `${label}: block ${fmtInt(target)} — WINDOW OPEN (T-0)`);
      return;
    }
    const mins = blocks * MINUTES_PER_BLOCK;
    const days = Math.floor(mins / 1440);
    const hours = Math.floor((mins % 1440) / 60);
    setText(id,
      `${label}: block ${fmtInt(target)} — T-minus ${fmtInt(blocks)} blocks (~${days}d ${hours}h)`);
  }

  // ---- scoreboard ----------------------------------------------------------
  function renderScoreboard() {
    setText('stat-violators', fmtInt(state.violators));
    setText('stat-spam-mb', `${(state.spamVBytes / 1e6).toFixed(2)} MB`);
    setText('stat-spam-share',
      state.totalVBytes ? fmtPct(state.spamVBytes / state.totalVBytes) : '—');
    setText('stat-infiltrators', fmtInt(state.infiltrators));
    const obsShare = state.obsTotal ? state.obsSpam / state.obsTotal : 0;
    setText('stat-observed', state.obsTotal ? fmtPct(obsShare) : '—');
    setText('stat-since-pure', state.sawPureEver ? fmtInt(state.blocksSincePure) : '∞');
    // Filter-effectiveness gag: set once, stays 0.0% forever. (See onScoreTick.)
  }

  // ---- kill feed -----------------------------------------------------------
  function addKill({ tx, verdict }, minedTag) {
    const feedEl = $('kill-feed');
    if (!feedEl || !tx || !verdict) return;
    const empty = feedEl.querySelector('.kill-empty');
    if (empty) empty.remove();

    const li = document.createElement('li');
    li.className = 'kill-row';
    const bytesLabel = verdict.dataBytes > 0
      ? fmtBytes(verdict.dataBytes)
      : `${fmtInt(tx.vsize)} vB`;
    const proto = verdict.protocol || 'data';
    li.innerHTML =
      `<span class="kill-emoji">${unitEmoji(verdict)}</span>` +
      `<span class="kill-body">` +
        `<span class="kill-proto">${proto}</span> ` +
        `<span class="kill-bytes">${bytesLabel}</span>` +
        `<span class="kill-tag">${minedTag || `slipped past ${nextKnight()}`}</span>` +
        `<a class="kill-txid" href="https://mempool.space/tx/${tx.txid}" ` +
          `target="_blank" rel="noopener">${shortTxid(tx.txid)}</a>` +
      `</span>`;
    // Clicking the row (but not the outbound link) opens the dossier.
    li.addEventListener('click', (e) => {
      if (e.target.closest('a')) return;
      showDossier({ tx, verdict });
    });
    feedEl.prepend(li);
    while (feedEl.children.length > KILLFEED_MAX) feedEl.lastElementChild.remove();
  }

  // ---- ticker (bottom commentary) -----------------------------------------
  function setTicker(text) {
    const el = $('ticker');
    if (!el || !text) return;
    el.textContent = text;
    el.classList.remove('ticker-flash');
    void el.offsetWidth; // restart CSS animation
    el.classList.add('ticker-flash');
  }
  // One-shot reactive taunt, gently throttled so bursts don't thrash the line.
  function reactTaunt(kind, ctx, minGapMs = 3500) {
    const now = Date.now();
    if (now - state.lastReactive < minGapMs) return;
    state.lastReactive = now;
    setTicker(pickTaunt(kind, ctx));
  }

  // ---- dossier -------------------------------------------------------------
  function showDossier(unit) {
    const tx = unit && (unit.tx || (unit.txid ? unit : null));
    const verdict = unit && (unit.verdict || unit);
    const panel = $('dossier');
    const body = $('dossier-body');
    if (!panel || !body || !verdict) return;

    setText('dossier-title', verdict.label || 'Unidentified unit');

    const rows = [];
    const complyClass = verdict.compliant ? 'ok' : 'bad';
    const complyText = verdict.compliant
      ? 'BIP-110 COMPLIANT ✓ (would pass if the fork were active)'
      : 'BIP-110 NONCOMPLIANT ✗ (would violate BIP-110 if the fork were active)';
    rows.push(`<p class="dossier-verdict ${complyClass}">${complyText}</p>`);

    rows.push(field('Archetype', verdict.archetype));
    rows.push(field('Faction', verdict.faction));
    rows.push(field('Protocol', verdict.protocol));
    if (tx) {
      rows.push(field('vsize', Number.isFinite(tx.vsize) ? `${fmtInt(tx.vsize)} vB` : 'n/a'));
      if (num(tx.fee) != null) {
        const feerate = tx.vsize ? ` (${(tx.fee / tx.vsize).toFixed(1)} sat/vB)` : '';
        const usd = state.price ? ` ≈ $${(tx.fee / 1e8 * state.price).toFixed(2)}` : '';
        rows.push(field('Fee', `${fmtInt(tx.fee)} sat${feerate}${usd}`));
      } else {
        rows.push(field('Fee', 'n/a (block scan — prevouts absent)'));
      }
    }
    if (verdict.dataBytes > 0) rows.push(field('Payload', fmtBytes(verdict.dataBytes)));
    if (verdict.contentType) rows.push(field('Content-type', verdict.contentType));

    // Violated rules with full BIP-110 rule text from classify.RULES.
    if (Array.isArray(verdict.violations) && verdict.violations.length) {
      const items = verdict.violations.map((v) => {
        const rule = RULE_BY_ID[v.ruleId];
        const title = rule ? escapeHtml(rule.title || `Rule ${v.ruleId}`) : `Rule ${v.ruleId}`;
        const text = rule ? `<span class="rule-text">${escapeHtml(rule.text)}</span>` : '';
        const detail = v.detail ? `<span class="rule-detail">${escapeHtml(v.detail)}</span>` : '';
        return `<li><strong>${title}</strong>${text}${detail}</li>`;
      }).join('');
      rows.push(`<div class="dossier-block"><h3>Violated rules</h3><ul class="rule-list">${items}</ul></div>`);
    } else {
      rows.push(`<p class="dossier-clean">No BIP-110 rule violations. This unit is legal — regrettably.</p>`);
    }

    // "Why" bullets straight from the classifier.
    if (Array.isArray(verdict.details) && verdict.details.length) {
      const bullets = verdict.details.map((d) => `<li>${escapeHtml(d)}</li>`).join('');
      rows.push(`<div class="dossier-block"><h3>Notes</h3><ul>${bullets}</ul></div>`);
    }

    if (verdict.payloadPreview) {
      rows.push(`<div class="dossier-block"><h3>Payload preview</h3>` +
        `<pre class="payload"><code>${escapeHtml(verdict.payloadPreview)}</code></pre></div>`);
    }

    if (tx && tx.txid) {
      rows.push(`<p class="dossier-link"><a href="https://mempool.space/tx/${tx.txid}" ` +
        `target="_blank" rel="noopener">Inspect on mempool.space ↗</a></p>`);
    }

    body.innerHTML = rows.join('');
    panel.classList.add('open');
    panel.removeAttribute('hidden');
  }
  function field(label, value) {
    if (value == null || value === '') return '';
    return `<div class="dossier-field"><span class="k">${escapeHtml(label)}</span>` +
      `<span class="v">${escapeHtml(String(value))}</span></div>`;
  }
  function closeDossier() {
    const panel = $('dossier');
    if (!panel) return;
    panel.classList.remove('open');
    panel.setAttribute('hidden', '');
  }

  // ---- modal ---------------------------------------------------------------
  function openModal() {
    const m = $('modal');
    if (!m) return;
    m.classList.add('open');
    m.removeAttribute('hidden');
  }
  function closeModal() {
    const m = $('modal');
    if (!m) return;
    m.classList.remove('open');
    m.setAttribute('hidden', '');
  }

  // ---- feed event handlers -------------------------------------------------
  function onTx(detail) {
    if (!detail || !detail.tx || !detail.verdict) return;
    const { tx, verdict } = detail;
    // Forward to the battlefield engine.
    try { battlefield && battlefield.spawnTx(detail); } catch (_) { /* never crash HUD */ }

    // Observed-spam rolling sample (labeled "observed", NOT a headline stat).
    const vsize = num(tx.vsize) || 0;
    const spam = verdict.archetype === 'violator';
    state.obs.push({ vsize, spam });
    state.obsTotal += vsize;
    if (spam) state.obsSpam += vsize;
    if (state.obs.length > STREAM_RING) {
      const old = state.obs.shift();
      state.obsTotal -= old.vsize;
      if (old.spam) state.obsSpam -= old.vsize;
    }
    // Remember streamed violators so we can credit them when they get mined.
    if (spam && tx.txid) {
      state.streamViolators.set(tx.txid, detail);
      if (state.streamViolators.size > STREAM_VIOLATOR_CAP) {
        const first = state.streamViolators.keys().next().value;
        state.streamViolators.delete(first);
      }
    }
    renderScoreboard();

    // Occasional event-reactive banter.
    if (verdict.dataBytes > 100000) reactTaunt('bigSpam', null, 6000);
    else if (verdict.archetype === 'infiltrator') reactTaunt('infiltrator', null, 15000);
  }

  function onBlock(detail) {
    if (!detail || !detail.block) return;
    const b = detail.block;
    if (Number.isFinite(b.height)) { state.height = b.height; renderDoomsday(); }

    const mined = detail.minedTxids;

    // Stash the actually-confirmed txids so the follow-up 'blockreport' can hand
    // the engine the real mined set (battle.js storms those exact units through
    // the gate instead of a fake representative surge).
    if (b.id) state.minedByBlock.set(b.id, mined || new Set());

    // Fallback: if the raw-block scan never yields a 'blockreport' (token
    // starvation at load, 429, parse error — feed.js swallows those), still fire
    // the breach off the bare 'block' event so the gate animates and the tally
    // advances instead of producing no gate event at all.
    if (b.id && !state.confirmTimers.has(b.id) && !state.confirmedBlocks.has(b.id)) {
      const timer = setTimeout(() => {
        state.confirmTimers.delete(b.id);
        if (state.confirmedBlocks.has(b.id)) return;
        markConfirmed(b.id);
        try {
          battlefield && battlefield.confirmBlock({
            block: b, report: null, minedTxids: state.minedByBlock.get(b.id),
          });
        } catch (_) { /* keep HUD alive */ }
        state.minedByBlock.delete(b.id);
      }, BLOCK_CONFIRM_FALLBACK_MS);
      state.confirmTimers.set(b.id, timer);
    }

    // Credit any streamed violators that just confirmed → kill feed.
    if (mined && typeof mined.forEach === 'function') {
      mined.forEach((txid) => {
        const hit = state.streamViolators.get(txid);
        if (hit) {
          addKill(hit, 'mined — confirmed in the wild');
          state.streamViolators.delete(txid);
        }
      });
    }
  }

  // blockreport (live) and backfill (historical seed) share tally logic.
  // Only live reports drive the battlefield breach animation + reactive taunts.
  function applyReport(report, { animate }) {
    if (!report) return;
    // Backfill blockreports carry real heights and land seconds after load —
    // well before the first live WS 'block' push. Adopt the max so the doomsday
    // clock + T-minus countdowns light up immediately instead of showing
    // "awaiting first block…" for up to ~10min. (Backfill is newest-first.)
    if (Number.isFinite(report.height) && !(state.height >= report.height)) {
      state.height = report.height;
    }
    state.violators += reportArch(report, 'violator');
    state.infiltrators += reportArch(report, 'infiltrator');
    state.spamVBytes += num(report.spamVBytes) || 0;
    state.totalVBytes += num(report.totalVBytes) || 0;

    if (report.pure) { state.blocksSincePure = 0; state.sawPureEver = true; }
    else if (state.sawPureEver) state.blocksSincePure += 1;

    state.signalHistory.push(!!report.signaling);
    if (state.signalHistory.length > SIGNAL_WINDOW) state.signalHistory.shift();

    renderScoreboard();
    renderDoomsday();

    // Kill feed: the largest offenders from the full-block scan.
    if (Array.isArray(report.topOffenders)) {
      for (const off of report.topOffenders) addKill(off, null);
    }

    if (animate) {
      const bid = report.id;
      // We have the real report — cancel the no-report fallback for this block.
      if (bid && state.confirmTimers.has(bid)) {
        clearTimeout(state.confirmTimers.get(bid));
        state.confirmTimers.delete(bid);
      }
      const already = bid ? state.confirmedBlocks.has(bid) : false;
      markConfirmed(bid);
      const minedTxids = bid ? state.minedByBlock.get(bid) : undefined;
      if (bid) state.minedByBlock.delete(bid);
      // Hand the engine the merged {block, report, minedTxids} shape so the
      // storm-match runs on the actually-confirmed units (SPEC: "units whose
      // txid is in minedTxids storm through"). Guard against a double breach if
      // the fallback already fired for this block.
      if (!already) {
        try {
          battlefield && battlefield.confirmBlock({
            block: { height: report.height, id: report.id },
            report,
            minedTxids,
          });
        } catch (_) { /* keep HUD alive */ }
      }
      const pool = poolName(report.pool);
      const share = report.totalVBytes
        ? fmtPct((num(report.spamVBytes) || 0) / report.totalVBytes)
        : '—';
      const ctx = { height: fmtInt(report.height ?? state.height), share, pool };
      if (report.pure) reactTaunt('pureBlock', ctx, 0);
      else if (report.signaling) reactTaunt('signaling', ctx, 0);
      else if (isOcean(report.pool)) reactTaunt('ocean', ctx, 0);
      else reactTaunt('breach', ctx, 0);
    }
  }

  function onStats(detail) {
    if (!detail) return;
    if (num(detail.price) != null) state.price = detail.price;
  }

  function onProjected(detail) {
    if (!detail) return;
    try { battlefield && battlefield.setProjected(detail.mempoolBlocks); } catch (_) { /* */ }
  }

  // ---- wire feed events ----------------------------------------------------
  const on = (name, fn) => feed.addEventListener(name, (e) => {
    try { fn(e.detail); } catch (err) { /* one bad payload must not kill the feed */ }
  });
  on('status', onStatus);
  on('tx', onTx);
  on('block', onBlock);
  on('blockreport', (d) => applyReport(d && d.report, { animate: true }));
  on('backfill', (d) => applyReport(d && d.report, { animate: false }));
  on('stats', onStats);
  on('projected', onProjected);

  // ---- static UI wiring ----------------------------------------------------
  setText('stat-filter', '0.0%'); // the gag tile; never updated again
  wireClick('dossier-close', closeDossier);
  wireClick('modal-close', closeModal);
  wireClick('open-modal', openModal);
  wireClick('open-modal-footer', openModal);
  // Close overlays on backdrop click + Escape.
  const modalEl = $('modal');
  if (modalEl) modalEl.addEventListener('click', (e) => { if (e.target === modalEl) closeModal(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeDossier(); closeModal(); }
  });

  // ---- ambient rotations ---------------------------------------------------
  setTicker(pickTaunt('ambient'));
  setText('subtitle-taunt', pickTaunt('ambient'));
  setInterval(() => setTicker(pickTaunt('ambient')), 9000);
  setInterval(() => setText('subtitle-taunt', pickTaunt('ambient')), 13000);

  return { showDossier, openModal, closeModal };
}

function wireClick(id, fn) {
  const el = document.getElementById(id);
  if (el) el.addEventListener('click', fn);
}
function isOcean(pool) {
  if (!pool) return false;
  const slug = (pool.slug || '').toLowerCase();
  const name = (pool.name || '').toLowerCase();
  return slug === 'ocean' || name.includes('ocean');
}
function poolName(pool) {
  if (!pool) return 'an unknown pool';
  return pool.name || pool.slug || 'an unknown pool';
}
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
