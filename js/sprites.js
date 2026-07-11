// js/sprites.js — procedural Canvas 2D drawing helpers for the Battlefield.
//
// Everything here is painted with rects / paths / fillText (emoji). NO images,
// NO external assets, NO fonts beyond the system monospace stack. Each helper
// takes a live CanvasRenderingContext2D and draws in *CSS pixels* (battle.js
// applies the devicePixelRatio transform once, so these functions never touch
// devicePixelRatio, window, or document — they are pure paint routines).
//
// Palette is intentionally DUPLICATED here (battle.js keeps its own copy) so
// this module imports nothing. Keep the two copies in sync with SPEC §Style.

const P = {
  bg: '#0b0e14',
  bgHi: '#141a26',
  orange: '#ff6b35',
  magenta: '#ff3df5',
  gold: '#f7b32b',
  steel: '#9fb4c7',
  steelDk: '#5b6b7d',
  green: '#3ddc84',
  brick: '#232c3b',
  brickHi: '#33405a',
  ink: '#0b0e14',
  paper: '#e9edf2',
  shadow: 'rgba(0,0,0,0.45)',
};

const MONO = 'ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace';

// ---- low-level ------------------------------------------------------------

export function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function px(ctx, x, y, w, h, color) {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

// ---- backdrop -------------------------------------------------------------

// Parallax layered sky. `t` is elapsed seconds; distant ridges drift slowly so
// the scene feels alive even though the camera is fixed.
export function drawSky(ctx, w, h, t) {
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#080b12');
  g.addColorStop(0.5, '#0b0e14');
  g.addColorStop(1, '#05070c');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  // faint blood-orange horizon glow (the war is always burning somewhere)
  const glow = ctx.createRadialGradient(w * 0.5, h * 0.9, 20, w * 0.5, h * 0.9, h);
  glow.addColorStop(0, 'rgba(255,107,53,0.10)');
  glow.addColorStop(1, 'rgba(255,107,53,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);

  // three parallax ridge layers
  ridge(ctx, w, h, h * 0.55, 0.05, t * 6, '#0d1220', 90);
  ridge(ctx, w, h, h * 0.66, 0.09, t * 11, '#101728', 70);
  ridge(ctx, w, h, h * 0.74, 0.14, t * 19, '#131c30', 55);
}

function ridge(ctx, w, h, baseY, amp, offset, color, period) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, h);
  ctx.lineTo(0, baseY);
  for (let x = 0; x <= w; x += 12) {
    const y = baseY - Math.sin((x + offset) / period) * (amp * h) * 0.25
      - Math.sin((x + offset) / (period * 2.7)) * (amp * h) * 0.15;
    ctx.lineTo(x, y);
  }
  ctx.lineTo(w, h);
  ctx.closePath();
  ctx.fill();
}

export function drawGround(ctx, w, h, groundY) {
  const g = ctx.createLinearGradient(0, groundY, 0, h);
  g.addColorStop(0, '#0e131d');
  g.addColorStop(1, '#070a10');
  ctx.fillStyle = g;
  ctx.fillRect(0, groundY, w, h - groundY);
  // scored top edge — the mud line where the horde meets the wall
  ctx.strokeStyle = 'rgba(159,180,199,0.18)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, groundY + 0.5);
  ctx.lineTo(w, groundY + 0.5);
  ctx.stroke();
  // sparse vertical scoring
  ctx.strokeStyle = 'rgba(0,0,0,0.25)';
  for (let x = (Math.floor(w) % 40); x < w; x += 40) {
    ctx.beginPath();
    ctx.moveTo(x, groundY + 4);
    ctx.lineTo(x - 6, h);
    ctx.stroke();
  }
}

// Permanent scorch mark from a whale event.
export function drawScorch(ctx, x, y, r) {
  const g = ctx.createRadialGradient(x, y, 2, x, y, r);
  g.addColorStop(0, 'rgba(0,0,0,0.85)');
  g.addColorStop(0.6, 'rgba(20,5,0,0.55)');
  g.addColorStop(1, 'rgba(20,5,0,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(x, y, r, r * 0.42, 0, 0, Math.PI * 2);
  ctx.fill();
  // charred flecks of blood-orange ember
  ctx.fillStyle = 'rgba(255,107,53,0.14)';
  ctx.beginPath();
  ctx.ellipse(x, y, r * 0.5, r * 0.2, 0, 0, Math.PI * 2);
  ctx.fill();
}

// CRT scanline + vignette overlay, drawn last, in screen space (no shake).
export function drawScanlines(ctx, w, h) {
  ctx.save();
  ctx.globalAlpha = 0.06;
  ctx.fillStyle = '#000';
  for (let y = 0; y < h; y += 3) ctx.fillRect(0, y, w, 1);
  ctx.restore();
  const vig = ctx.createRadialGradient(w / 2, h / 2, h * 0.35, w / 2, h / 2, h * 0.85);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(0,0,0,0.45)');
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, w, h);
}

// ---- the castle -----------------------------------------------------------

// Draws the fortress on the left. Returns nothing; battle.js already knows the
// gate/checkpoint geometry (it computes layout and passes it in).
//   geo = {x, top, w, wallH, gateX, gateW, gateTop, gateH, doorX, doorY, doorW, doorH}
//   state = {open:0..1, height:number|null, lampOn:bool, projected:string, mood}
export function drawCastle(ctx, geo, groundY, state) {
  const { x, w, gateX, gateW, gateTop, gateH, doorX, doorY, doorW, doorH } = geo;
  const top = geo.top;
  const wallH = groundY - top;

  // silhouette shadow
  ctx.fillStyle = P.shadow;
  ctx.fillRect(x, top + 6, w + 6, wallH);

  // wall body with brick courses
  px(ctx, x, top, w, wallH, P.brick);
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 1;
  const bh = 14;
  for (let by = top; by < groundY; by += bh) {
    ctx.beginPath();
    ctx.moveTo(x, by + 0.5);
    ctx.lineTo(x + w, by + 0.5);
    ctx.stroke();
    const stagger = (Math.floor((by - top) / bh) % 2) * 18;
    for (let bx = x + stagger; bx < x + w; bx += 36) {
      ctx.beginPath();
      ctx.moveTo(bx + 0.5, by);
      ctx.lineTo(bx + 0.5, by + bh);
      ctx.stroke();
    }
  }
  // subtle top-lit face
  const face = ctx.createLinearGradient(x, top, x, groundY);
  face.addColorStop(0, 'rgba(51,64,90,0.35)');
  face.addColorStop(0.5, 'rgba(0,0,0,0)');
  ctx.fillStyle = face;
  ctx.fillRect(x, top, w, wallH);

  // crenellations
  ctx.fillStyle = P.brickHi;
  for (let cx = x; cx < x + w; cx += 30) px(ctx, cx, top - 12, 18, 12, P.brickHi);

  // ---- main gate (portcullis) ----
  px(ctx, gateX - 4, gateTop - 6, gateW + 8, 8, P.brickHi); // lintel
  // dark archway
  ctx.fillStyle = '#04060a';
  ctx.fillRect(gateX, gateTop, gateW, gateH);
  // interior breach glow, intensifies as the gate opens
  if (state.open > 0.02) {
    const gg = ctx.createLinearGradient(gateX, gateTop, gateX, gateTop + gateH);
    const a = 0.15 + state.open * 0.5;
    gg.addColorStop(0, `rgba(255,61,245,${a})`);
    gg.addColorStop(1, `rgba(255,107,53,${a * 0.6})`);
    ctx.fillStyle = gg;
    ctx.fillRect(gateX, gateTop, gateW, gateH);
  }
  // portcullis bars, raised by `open`
  const lift = state.open * (gateH + 6);
  ctx.strokeStyle = '#8a94a6';
  ctx.lineWidth = 2;
  ctx.save();
  ctx.beginPath();
  ctx.rect(gateX - 2, gateTop - 8, gateW + 4, gateH + 8);
  ctx.clip();
  const barTop = gateTop - lift;
  for (let bx = gateX + 4; bx < gateX + gateW; bx += 8) {
    ctx.beginPath();
    ctx.moveTo(bx, barTop);
    ctx.lineTo(bx, barTop + gateH);
    ctx.stroke();
  }
  for (let by = barTop + 6; by < barTop + gateH; by += 12) {
    ctx.beginPath();
    ctx.moveTo(gateX + 3, by);
    ctx.lineTo(gateX + gateW - 3, by);
    ctx.stroke();
  }
  ctx.restore();

  // ---- "THE BLOCKCHAIN" wall plate ----
  const plateY = top + 10;
  ctx.fillStyle = 'rgba(11,14,20,0.85)';
  roundRect(ctx, x + 8, plateY, Math.min(w - 16, 150), 20, 4);
  ctx.fill();
  ctx.strokeStyle = P.steelDk;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = P.steel;
  ctx.font = `700 11px ${MONO}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('THE BLOCKCHAIN', x + 15, plateY + 11);

  // height banner above the keep
  const hLabel = state.height != null ? '#' + state.height.toLocaleString('en-US') : '#—';
  ctx.textAlign = 'center';
  ctx.font = `700 15px ${MONO}`;
  const bw = Math.max(90, ctx.measureText(hLabel).width + 20);
  const bx = x + w / 2 - bw / 2;
  const byy = top - 34;
  ctx.fillStyle = P.gold;
  roundRect(ctx, bx, byy, bw, 20, 3);
  ctx.fill();
  ctx.fillStyle = P.ink;
  ctx.fillText(hLabel, x + w / 2, byy + 11);
  // little flagpole notch
  px(ctx, x + w / 2 - 1, byy - 8, 2, 8, P.steelDk);

  // projected forecast sub-label
  if (state.projected) {
    ctx.font = `600 9px ${MONO}`;
    ctx.fillStyle = 'rgba(159,180,199,0.7)';
    ctx.fillText(state.projected, x + w / 2, byy + 30);
  }

  // ---- compliance checkpoint side-door ----
  ctx.fillStyle = '#04060a';
  ctx.fillRect(doorX, doorY, doorW, doorH);
  ctx.strokeStyle = P.steelDk;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(doorX + 0.5, doorY + 0.5, doorW, doorH);
  // green lamp
  const lampX = doorX + doorW / 2;
  const lampY = doorY - 6;
  if (state.lampOn) {
    const lg = ctx.createRadialGradient(lampX, lampY, 0, lampX, lampY, 12);
    lg.addColorStop(0, 'rgba(61,220,132,0.9)');
    lg.addColorStop(1, 'rgba(61,220,132,0)');
    ctx.fillStyle = lg;
    ctx.beginPath();
    ctx.arc(lampX, lampY, 12, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = state.lampOn ? P.green : '#1c3a2a';
  ctx.beginPath();
  ctx.arc(lampX, lampY, 3, 0, Math.PI * 2);
  ctx.fill();
  // checkpoint label
  ctx.save();
  ctx.translate(doorX + doorW + 4, doorY + doorH);
  ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = 'rgba(159,180,199,0.65)';
  ctx.font = `600 8px ${MONO}`;
  ctx.textAlign = 'left';
  ctx.fillText('COMPLIANCE ✓', 0, 0);
  ctx.restore();
}

// ---- knights --------------------------------------------------------------

// A blocky pixel knight with a name banner. opts:
//   accent (color), name, t (seconds), pose ('idle'|'cast'|'rally'|'cheer'|'fume'),
//   facing (1 right / -1 left), shieldEmblem (string)
export function drawKnight(ctx, x, groundY, s, opts) {
  const pose = opts.pose || 'idle';
  const t = opts.t || 0;
  const face = opts.facing || 1;
  const accent = opts.accent || P.steel;
  const step = Math.sin(t * 4 + (opts.phase || 0)); // pacing bob
  const bob = Math.abs(step) * s * 0.06;
  const baseY = groundY - bob;

  ctx.save();
  ctx.translate(x, baseY);
  ctx.scale(face, 1);

  // shadow
  ctx.fillStyle = P.shadow;
  ctx.beginPath();
  ctx.ellipse(0, 0, s * 0.5, s * 0.12, 0, 0, Math.PI * 2);
  ctx.fill();

  const u = s / 18; // pixel unit

  // legs (alternate stride)
  ctx.fillStyle = P.steelDk;
  const stride = step * 2 * u;
  ctx.fillRect(-3 * u + stride, -6 * u, 2.4 * u, 6 * u);
  ctx.fillRect(0.6 * u - stride, -6 * u, 2.4 * u, 6 * u);

  // tunic / body
  ctx.fillStyle = accent;
  ctx.fillRect(-3.4 * u, -13 * u, 6.8 * u, 8 * u);
  ctx.fillStyle = 'rgba(255,255,255,0.10)';
  ctx.fillRect(-3.4 * u, -13 * u, 6.8 * u, 2 * u);

  // arm + weapon; raise on cast/rally/cheer
  let armAng = -0.2;
  if (pose === 'cast') armAng = -1.1 + Math.sin(t * 12) * 0.15;
  else if (pose === 'rally' || pose === 'cheer') armAng = -2.2;
  ctx.save();
  ctx.translate(2.6 * u, -12 * u);
  ctx.rotate(armAng);
  ctx.fillStyle = P.steel;
  ctx.fillRect(0, -1 * u, 6.5 * u, 2 * u); // lance / filter wand
  ctx.fillStyle = P.gold;
  ctx.fillRect(6.2 * u, -1.4 * u, 1.6 * u, 2.8 * u); // wand tip
  ctx.restore();

  // shield (front arm)
  ctx.fillStyle = '#2b3446';
  roundRect(ctx, -6.4 * u, -12.5 * u, 4.4 * u, 7 * u, 1.5 * u);
  ctx.fill();
  ctx.strokeStyle = accent;
  ctx.lineWidth = Math.max(1, u * 0.8);
  ctx.stroke();
  // shield glows on rally
  if (pose === 'rally' || pose === 'cheer') {
    ctx.save();
    ctx.globalAlpha = 0.5 + 0.3 * Math.sin(t * 8);
    ctx.strokeStyle = P.gold;
    ctx.stroke();
    ctx.restore();
  }
  ctx.fillStyle = P.steel;
  ctx.font = `${3.2 * u}px ${MONO}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.save();
  ctx.scale(face, 1); // un-mirror the emblem glyph
  ctx.fillText(opts.shieldEmblem || '🛡', face * -4.2 * u, -9 * u);
  ctx.restore();

  // head + helmet
  ctx.fillStyle = P.steel;
  ctx.fillRect(-2.6 * u, -18 * u, 5.2 * u, 5 * u);
  ctx.fillStyle = '#05070a';
  ctx.fillRect(-2.6 * u, -16.2 * u, 5.2 * u, 1.4 * u); // visor slit
  ctx.fillStyle = accent;
  ctx.fillRect(-0.6 * u, -20 * u, 1.2 * u, 2.4 * u); // plume

  // fuming steam
  if (pose === 'fume') {
    ctx.fillStyle = 'rgba(255,61,245,0.5)';
    for (let i = 0; i < 3; i++) {
      const p = (t * 2 + i * 0.5) % 1;
      ctx.globalAlpha = (1 - p) * 0.6;
      ctx.beginPath();
      ctx.arc((i - 1) * 2 * u, -20 * u - p * 8 * u, (1 + p) * u, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  ctx.restore();

  // name banner (screen-upright, drawn after un-scaling)
  if (opts.name) {
    ctx.save();
    ctx.font = `700 9px ${MONO}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const label = opts.name;
    const bw = ctx.measureText(label).width + 10;
    const byy = groundY + 6;
    ctx.fillStyle = 'rgba(11,14,20,0.9)';
    roundRect(ctx, x - bw / 2, byy, bw, 13, 2);
    ctx.fill();
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = P.paper;
    ctx.fillText(label, x, byy + 7);
    ctx.restore();
  }
}

// Cameo walk-ons along the battlement. kind: 'zucco' | 'dathon'
export function drawCameo(ctx, x, y, s, kind, t) {
  ctx.save();
  ctx.translate(x, y);
  const u = s / 18;
  if (kind === 'dathon') {
    // hooded figure holding the doomsday scroll
    ctx.fillStyle = '#1a1030';
    ctx.beginPath();
    ctx.moveTo(-4 * u, 0);
    ctx.lineTo(4 * u, 0);
    ctx.lineTo(3 * u, -12 * u);
    ctx.quadraticCurveTo(0, -18 * u, -3 * u, -12 * u);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#000';
    ctx.fillRect(-2.2 * u, -12 * u, 4.4 * u, 3 * u); // hood shadow
    ctx.fillStyle = P.gold; // scroll
    ctx.fillRect(3 * u, -9 * u, 5 * u, 2 * u);
    ctx.fillStyle = P.magenta;
    ctx.globalAlpha = 0.6 + 0.4 * Math.sin(t * 3);
    ctx.fillRect(4 * u, -8.6 * u, 3 * u, 1 * u); // glowing sigil
    ctx.globalAlpha = 1;
  } else {
    // Zucco — pacing, arms crossed, exasperated
    const sway = Math.sin(t * 3) * 1.5 * u;
    ctx.fillStyle = '#3a2f22';
    ctx.fillRect(-3 * u + sway, -12 * u, 6 * u, 8 * u); // coat
    ctx.fillStyle = P.steel;
    ctx.fillRect(-2.2 * u + sway, -18 * u, 4.4 * u, 5 * u); // head
    ctx.fillStyle = '#111';
    ctx.fillRect(-2.2 * u + sway, -14 * u, 4.4 * u, 1.4 * u); // brow
    ctx.fillStyle = '#000';
    ctx.fillRect(-3 * u + sway, -9 * u, 6 * u, 1.5 * u); // crossed arms
  }
  ctx.restore();
}

// ---- combat units ---------------------------------------------------------

// CITIZEN — a brisk gold coin. t = seconds (for the spin shimmer)
export function drawCoin(ctx, x, y, r, t, dim) {
  ctx.save();
  ctx.fillStyle = P.shadow;
  ctx.beginPath();
  ctx.ellipse(x, y + r * 0.9, r * 0.9, r * 0.3, 0, 0, Math.PI * 2);
  ctx.fill();
  const wob = Math.abs(Math.cos(t * 5 + x)) * 0.6 + 0.4; // edge-on wobble
  ctx.translate(x, y);
  ctx.scale(wob, 1);
  ctx.fillStyle = dim ? '#7a6a3a' : P.gold;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = dim ? '#5a4e2c' : '#b98a1e';
  ctx.lineWidth = Math.max(1, r * 0.15);
  ctx.stroke();
  ctx.restore();
  ctx.fillStyle = dim ? '#d9d2c0' : '#7a5a12';
  ctx.font = `700 ${Math.round(r * 1.1)}px ${MONO}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('₿', x, y + 0.5);
}

// INFILTRATOR — suit + briefcase, strolling smugly. opts.stamp (0..1) flashes
// the COMPLIANT ✓ stamp; opts.emoji overrides the head glyph (⚡ Runes etc.)
export function drawInfiltrator(ctx, x, y, s, t, opts) {
  const u = s / 18;
  const glide = Math.sin(t * 3 + x) * 0.8;
  ctx.save();
  ctx.fillStyle = P.shadow;
  ctx.beginPath();
  ctx.ellipse(x, y + 0.5 * u, s * 0.4, s * 0.1, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.translate(x, y - Math.abs(glide) * u);

  // legs
  ctx.fillStyle = '#12161f';
  ctx.fillRect(-2.8 * u, -6 * u, 2.2 * u, 6 * u);
  ctx.fillRect(0.6 * u, -6 * u, 2.2 * u, 6 * u);
  // suit body
  ctx.fillStyle = '#20293a';
  ctx.fillRect(-3.2 * u, -14 * u, 6.4 * u, 9 * u);
  // lapels + shirt
  ctx.fillStyle = P.paper;
  ctx.beginPath();
  ctx.moveTo(-0.6 * u, -14 * u);
  ctx.lineTo(0.6 * u, -14 * u);
  ctx.lineTo(0, -8 * u);
  ctx.closePath();
  ctx.fill();
  // magenta power-tie (lawful-evil)
  ctx.fillStyle = P.magenta;
  ctx.fillRect(-0.5 * u, -12 * u, 1 * u, 4 * u);
  // briefcase
  ctx.fillStyle = '#4a3620';
  ctx.fillRect(3.2 * u, -8 * u, 4 * u, 5 * u);
  ctx.strokeStyle = P.gold;
  ctx.lineWidth = 1;
  ctx.strokeRect(3.2 * u, -8 * u, 4 * u, 5 * u);
  // head
  ctx.fillStyle = '#c9a37a';
  ctx.fillRect(-2 * u, -19 * u, 4 * u, 5 * u);
  // shades (smug)
  ctx.fillStyle = '#05070a';
  ctx.fillRect(-2 * u, -17.5 * u, 4 * u, 1.4 * u);
  ctx.restore();

  // faction glyph floating over the shoulder
  if (opts && opts.emoji) {
    ctx.font = `${Math.round(s * 0.5)}px ${MONO}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(opts.emoji, x + s * 0.42, y - s * 0.95);
  }

  // COMPLIANT ✓ stamp flash
  if (opts && opts.stamp > 0) {
    drawStamp(ctx, x, y - s * 1.15, 'COMPLIANT ✓', opts.stamp);
  }
}

// VIOLATOR — a framed JPEG creature charging the wall. opts: emoji, hue, t,
// hp (unused, cosmetic), charge (0..1 lean)
export function drawViolator(ctx, x, y, size, opts) {
  const t = opts.t || 0;
  const hue = opts.hue || P.magenta;
  const half = size / 2;
  ctx.save();
  // shadow
  ctx.fillStyle = P.shadow;
  ctx.beginPath();
  ctx.ellipse(x, y + half * 0.85, half * 0.9, half * 0.28, 0, 0, Math.PI * 2);
  ctx.fill();

  const shake = Math.sin(t * 20) * (opts.charge ? size * 0.03 : 0);
  ctx.translate(x + shake, y);

  // little legs stomping
  ctx.fillStyle = hue;
  const st = Math.sin(t * 9);
  ctx.fillRect(-half * 0.5 + st * 2, half * 0.55, size * 0.16, size * 0.28);
  ctx.fillRect(half * 0.34 - st * 2, half * 0.55, size * 0.16, size * 0.28);

  // JPEG frame (the horde is literally framed art)
  ctx.fillStyle = '#0d1017';
  roundRect(ctx, -half, -half, size, size, size * 0.1);
  ctx.fill();
  // glitchy border
  ctx.lineWidth = Math.max(2, size * 0.06);
  ctx.strokeStyle = hue;
  ctx.stroke();
  // subtle scanline texture inside
  ctx.save();
  roundRect(ctx, -half, -half, size, size, size * 0.1);
  ctx.clip();
  ctx.globalAlpha = 0.12;
  ctx.fillStyle = hue;
  for (let yy = -half; yy < half; yy += 4) ctx.fillRect(-half, yy, size, 1.5);
  ctx.globalAlpha = 1;
  // corner "compression" chunks
  ctx.fillStyle = 'rgba(255,61,245,0.25)';
  ctx.fillRect(-half, -half, size * 0.22, size * 0.22);
  ctx.fillRect(half - size * 0.28, half - size * 0.3, size * 0.28, size * 0.3);
  ctx.restore();

  // face emoji
  ctx.font = `${Math.round(size * 0.66)}px ${MONO}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(opts.emoji || '🖼️', 0, size * 0.02);
  ctx.restore();
}

// ---- effects & chrome -----------------------------------------------------

export function drawProjectile(ctx, x, y, r, hue) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r * 2.2);
  g.addColorStop(0, hue);
  g.addColorStop(1, 'rgba(159,180,199,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r * 2.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#eaf1f7';
  ctx.beginPath();
  ctx.arc(x, y, r * 0.6, 0, Math.PI * 2);
  ctx.fill();
}

export function drawStamp(ctx, x, y, text, alpha) {
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
  const scale = 1 + (1 - alpha) * 0.6; // pops in big then settles
  ctx.translate(x, y);
  ctx.rotate(-0.18);
  ctx.scale(scale, scale);
  ctx.font = `800 12px ${MONO}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const w = ctx.measureText(text).width + 12;
  ctx.strokeStyle = P.green;
  ctx.lineWidth = 2;
  roundRect(ctx, -w / 2, -9, w, 18, 3);
  ctx.stroke();
  ctx.fillStyle = P.green;
  ctx.fillText(text, 0, 1);
  ctx.restore();
}

// "POLICY ≠ CONSENSUS" ding when a filter shot bounces.
export function drawDing(ctx, x, y, text, alpha) {
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
  ctx.font = `800 11px ${MONO}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(0,0,0,0.7)';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = P.orange;
  ctx.fillText(text, x, y);
  ctx.restore();
}

// Non-overlapping-ish speech bubble. opts: color, align ('down'|'up' tail)
export function drawSpeechBubble(ctx, x, y, text, alpha, color) {
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
  ctx.font = `600 10px ${MONO}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const lines = wrap(ctx, text, 190);
  let maxW = 0;
  for (const l of lines) maxW = Math.max(maxW, ctx.measureText(l).width);
  const padX = 8, padY = 6, lh = 13;
  const w = maxW + padX * 2;
  const h = lines.length * lh + padY * 2 - 2;
  let bx = x - w / 2;
  bx = Math.max(4, bx); // keep on-screen-ish
  const by = y - h;

  ctx.fillStyle = 'rgba(8,11,17,0.92)';
  roundRect(ctx, bx, by, w, h, 5);
  ctx.fill();
  ctx.strokeStyle = color || P.steelDk;
  ctx.lineWidth = 1;
  ctx.stroke();
  // tail
  ctx.beginPath();
  ctx.moveTo(x - 4, by + h - 0.5);
  ctx.lineTo(x, by + h + 6);
  ctx.lineTo(x + 4, by + h - 0.5);
  ctx.fillStyle = 'rgba(8,11,17,0.92)';
  ctx.fill();

  ctx.fillStyle = P.paper;
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], bx + padX, by + padY + i * lh + lh / 2);
  }
  ctx.restore();
  return h; // caller uses height for stacking
}

function wrap(ctx, text, maxW) {
  const words = String(text).split(' ');
  const lines = [];
  let cur = '';
  for (const word of words) {
    const test = cur ? cur + ' ' + word : word;
    if (ctx.measureText(test).width > maxW && cur) {
      lines.push(cur);
      cur = word;
    } else {
      cur = test;
    }
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 3);
}

// Big breach banner across the field. opts: color, sub, flash (0..1)
export function drawBanner(ctx, w, h, text, sub, color, flash) {
  ctx.save();
  const cy = h * 0.28;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // headline
  const size = Math.max(20, Math.min(42, w / (text.length * 0.62)));
  ctx.font = `900 ${size}px ${MONO}`;
  const tw = ctx.measureText(text).width;

  // plate
  ctx.globalAlpha = 0.86;
  ctx.fillStyle = 'rgba(6,8,13,0.9)';
  roundRect(ctx, w / 2 - tw / 2 - 22, cy - size * 0.7 - 6, tw + 44, size * 1.4 + (sub ? 26 : 12), 8);
  ctx.fill();
  ctx.globalAlpha = 1;

  // flash halo
  if (flash > 0) {
    ctx.save();
    ctx.globalAlpha = flash * 0.5;
    ctx.fillStyle = color;
    roundRect(ctx, w / 2 - tw / 2 - 22, cy - size * 0.7 - 6, tw + 44, size * 1.4 + (sub ? 26 : 12), 8);
    ctx.fill();
    ctx.restore();
  }

  ctx.lineWidth = 4;
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.strokeText(text, w / 2, cy);
  ctx.fillStyle = color;
  ctx.fillText(text, w / 2, cy);

  if (sub) {
    ctx.font = `700 ${Math.max(11, size * 0.36)}px ${MONO}`;
    ctx.fillStyle = P.paper;
    ctx.fillText(sub, w / 2, cy + size * 0.72 + 8);
  }
  ctx.restore();
}

export { P as PALETTE };
