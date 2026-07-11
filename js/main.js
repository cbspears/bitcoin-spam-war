// main.js — bootstrap + wiring only. Instantiates the data feed, the canvas
// engine, and the HUD, then connects them and starts the stream. All real
// logic lives in feed.js / battle.js / hud.js / classify.js.

import { CONFIG } from './config.js';
import { MempoolFeed } from './feed.js';
import { Battlefield } from './battle.js';
import * as taunts from './taunts.js';
import { initHud } from './hud.js';

const canvas = document.getElementById('battlefield');

// Reduced-motion: set a body class the engine also respects. The engine reads
// matchMedia itself for its own rAF decisions (per SPEC seam); this class lets
// CSS disable shake/confetti/scanline animation too.
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const applyReduceMotion = () =>
  document.body.classList.toggle('reduced-motion', reduceMotion.matches);
applyReduceMotion();
reduceMotion.addEventListener('change', applyReduceMotion);

const feed = new MempoolFeed(CONFIG);

// showDossier is filled in once the HUD is built; the engine's onUnitClick
// closes over it so units are clickable immediately.
let showDossier = () => {};

const battlefield = new Battlefield(canvas, {
  onUnitClick: (unit) => showDossier(unit),
  getTaunt: (kind, ctx) => taunts.pickTaunt(kind, ctx),
});

const hud = initHud({ feed, battlefield, taunts });
showDossier = hud.showDossier;

// Keep the battlefield sized to its container.
window.addEventListener('resize', () => {
  try { battlefield.resize(); } catch (_) { /* ignore transient resize errors */ }
});

// The feed manages its own WS keepalive/backoff; we simply note tab visibility
// so a future revision could pause spawns while hidden. The feed keeps running
// so the tally stays honest when the operator returns.
document.addEventListener('visibilitychange', () => {
  // no-op hook: feed + engine intentionally continue in the background.
});

feed.start();
