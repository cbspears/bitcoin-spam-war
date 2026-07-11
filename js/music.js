// music.js — "WAR DRUMS": the adaptive epic score for THE BATTLE FOR BLOCKSPACE.
//
// Everything is synthesized live with the Web Audio API — zero samples, zero
// files, zero deps, consistent with the rest of the site. The score is a
// trailer-orchestra rendered by oscillators: a doom drone, a choir pad, a
// string ostinato, taiko percussion, and a heroic horn theme, each layer fading
// in as the battle's INTENSITY climbs. Real chain events fire stingers.
//
// One composition core is shared by two callers:
//   • the LIVE path (createWarScore) — an AudioContext + lookahead scheduler,
//   • the OFFLINE path (renderScoreToWav) — an OfflineAudioContext preview.
// Both drive the SAME per-bar composition (scheduleBar) and the SAME voice
// synths, so the preview clip sounds exactly like the live score.
//
// IMPORT-SAFE: no AudioContext / window / OfflineAudioContext is touched at
// module load. `node --check` parses this cleanly; the ctx is only built once
// the user gestures (toggle) or a render is explicitly requested.
//
// Public surface (see SPEC3 §js/music.js contract):
//   createWarScore(opts) -> { enabled, toggle, setEnabled, pulse, stinger,
//                             intensity, state, dispose }
//   renderScoreToWav({seconds, intensityCurve, stingers}) -> Promise<Blob>

// ---------------------------------------------------------------------------
// Musical constants (binding — SPEC3 "The composition")
// ---------------------------------------------------------------------------
const BPM = 100;
const BEATS = 4;                     // 4/4
const SPB = 60 / BPM;                // seconds per beat = 0.6
const BAR = SPB * BEATS;             // seconds per bar   = 2.4

const AMBIENT_BASE = 0.35;           // resting intensity the score decays toward
const INTENSITY_TAU = 8;             // pulse decay time-constant, seconds
const MASTER_GAIN = 0.55;            // post-compressor master level (SPEC3 mix)

// Layer intensity gates.
const GATE_PAD = 0.15;
const GATE_OST = 0.30;
const GATE_OST_16 = 0.55;            // ostinato switches 8ths -> 16ths
const GATE_PERC = 0.45;
const GATE_SNARE = 0.70;
const GATE_HORN = 0.65;

// MIDI -> frequency (A4 = 69 = 440Hz). Detune is applied in CENTS on the node.
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

// Chord tones as MIDI. `rootPc` (pitch-class 0-11) drives the octave-1 drone
// root; `triad` are mid-register chord tones for pad/ostinato voicing.
//   C=0 C#=1 D=2 D#=3 E=4 F=5 F#=6 G=7 G#=8 A=9 A#/Bb=10 B=11 ; C3=48, C4=60
const CHORDS = {
  Dm:  { rootPc: 2,  triad: [50, 53, 57] },      // D3  F3  A3
  Bb:  { rootPc: 10, triad: [46, 50, 53] },      // Bb2 D3  F3
  F:   { rootPc: 5,  triad: [53, 57, 60] },      // F3  A3  C4
  A7:  { rootPc: 9,  triad: [45, 49, 52, 55] },  // A2  C#3 E3  G3  (dominant 7)
  Gm:  { rootPc: 7,  triad: [43, 46, 50] },      // G2  Bb2 D3
};
// Chord loop A every even 4-bar cycle, loop B every odd cycle (SPEC3).
const LOOP_A = ['Dm', 'Bb', 'F',  'A7'];
const LOOP_B = ['Dm', 'Bb', 'Gm', 'A7'];

// The 8-bar horn theme (D natural minor). {b: start beat, d: duration beats,
// m: MIDI}. Plays once per 16-bar cycle then rests, so it stays special.
const HORN_THEME = [
  [{ b: 0, d: 2, m: 62 }, { b: 2, d: 2, m: 65 }], // D4(2) F4(2)
  [{ b: 0, d: 3, m: 64 }, { b: 3, d: 1, m: 60 }], // E4(3) C4(1)
  [{ b: 0, d: 2, m: 62 }, { b: 2, d: 2, m: 69 }], // D4(2) A4(2)
  [{ b: 0, d: 3, m: 70 }, { b: 3, d: 1, m: 69 }], // Bb4(3) A4(1)
  [{ b: 0, d: 2, m: 65 }, { b: 2, d: 2, m: 67 }], // F4(2) G4(2)
  [{ b: 0, d: 4, m: 69 }],                         // A4(4)
  [{ b: 0, d: 2, m: 67 }, { b: 2, d: 2, m: 64 }], // G4(2) E4(2)
  [{ b: 0, d: 4, m: 62 }],                         // D4(4)
];

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
// Map `x` from [inLo,inHi] onto [outLo,outHi], clamped.
function imap(x, inLo, inHi, outLo, outHi) {
  const t = clamp01((x - inLo) / (inHi - inLo || 1));
  return outLo + (outHi - outLo) * t;
}
// Piecewise-linear sample of an intensity curve [[t,val],...] at time `t`.
function sampleCurve(curve, t) {
  if (!curve || !curve.length) return AMBIENT_BASE;
  if (t <= curve[0][0]) return curve[0][1];
  for (let i = 1; i < curve.length; i++) {
    if (t <= curve[i][0]) {
      const [t0, v0] = curve[i - 1];
      const [t1, v1] = curve[i];
      return v0 + (v1 - v0) * ((t - t0) / (t1 - t0 || 1));
    }
  }
  return curve[curve.length - 1][1];
}
// Which chord governs a given bar.
function chordForBar(barIndex) {
  const cycle = Math.floor(barIndex / 4);
  const loop = cycle % 2 === 0 ? LOOP_A : LOOP_B;
  return CHORDS[loop[((barIndex % 4) + 4) % 4]];
}

// ---------------------------------------------------------------------------
// Buses + generated buffers (built per-context; shared shape live/offline)
// ---------------------------------------------------------------------------
// Signal flow (SPEC3 mix bus): every voice -> compressor -> master(0.38) ->
// destination. A generated 2.8s convolver reverb sits on a parallel send.
function buildBuses(ctx) {
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -18;
  comp.ratio.value = 4;
  comp.knee.value = 20;
  comp.attack.value = 0.003;
  comp.release.value = 0.25;

  const master = ctx.createGain();
  master.gain.value = MASTER_GAIN;
  comp.connect(master);
  master.connect(ctx.destination);

  const reverb = ctx.createConvolver();
  reverb.buffer = makeImpulse(ctx, 2.8);
  const reverbReturn = ctx.createGain();
  reverbReturn.gain.value = 0.9;
  reverb.connect(reverbReturn);
  reverbReturn.connect(comp);

  return { comp, master, reverb, noise: makeNoise(ctx, 1.0) };
}

// Stereo exponential-decay noise impulse response for the reverb (SPEC3: 2.8s).
function makeImpulse(ctx, seconds) {
  const rate = ctx.sampleRate;
  const len = Math.max(1, Math.floor(seconds * rate));
  const buf = ctx.createBuffer(2, len, rate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) {
      const t = i / len;
      // pow() thins the early field, exp() gives the long exponential tail.
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 2.5) * Math.exp(-3.0 * t);
    }
  }
  return buf;
}
// One second of white noise, reused by every percussion hit / cymbal.
function makeNoise(ctx, seconds) {
  const rate = ctx.sampleRate;
  const len = Math.max(1, Math.floor(seconds * rate));
  const buf = ctx.createBuffer(1, len, rate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

// ---------------------------------------------------------------------------
// Node lifecycle
// ---------------------------------------------------------------------------
// Every voice hands its source nodes + full subgraph here. We stop the sources
// at `stopTime` and, on the last onended, disconnect the whole subgraph so it
// is garbage-collectable. On the LIVE ctx we also register the voice in
// E.live (a bounded Set self-pruned by onended) so toggle-OFF can hard-kill
// anything still sounding. OFFLINE renders pass E.live = null (no registry).
function register(E, voice, stopTime) {
  const { sources, nodes } = voice;
  let ended = 0;
  const cleanup = () => { for (const n of nodes) { try { n.disconnect(); } catch (_) { /* already gone */ } } };
  for (const s of sources) {
    try { s.stop(stopTime); } catch (_) { /* double-stop is harmless */ }
    s.onended = () => {
      if (++ended >= sources.length) cleanup();
      if (E.live) E.live.delete(voice);
    };
  }
  if (E.live) E.live.add(voice);
}
// gain node with an optional initial value.
function gainNode(ctx, v) {
  const g = ctx.createGain();
  if (v != null) g.gain.value = v;
  return g;
}
// Wire a voice's output to the dry compressor bus and (optionally) a reverb
// send. Pushes the send node into `nodes` so cleanup disconnects it too.
function wetDry(E, node, wet, nodes) {
  node.connect(E.buses.comp);
  if (wet > 0) {
    const s = gainNode(E.ctx, wet);
    node.connect(s);
    s.connect(E.buses.reverb);
    nodes.push(s);
  }
}

// ===========================================================================
// LAYER SYNTHS — each is a pure function of (E, when, params). Pattern
// generation (which note, which beat) is separated into the *Notes helpers so
// the live scheduler and the offline render call byte-identical composition.
// ===========================================================================

// Layer 1 — Doom drone (always on). Sub sine at the octave-1 root (+ its
// octave) plus two saws an octave up detuned ±8 cents through a 300Hz lowpass,
// swelling per chord. Ominous even at intensity 0. No reverb send (SPEC3).
function voiceDrone(E, when, chord) {
  const { ctx } = E;
  const root = 24 + chord.rootPc;         // e.g. Dm -> D1 (MIDI 26, 36.7Hz)
  const g = gainNode(ctx, null);
  const peak = 0.11;
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(peak, when + 1.0);       // slow swell in
  g.gain.setValueAtTime(peak, when + BAR * 0.62);
  g.gain.exponentialRampToValueAtTime(peak * 0.72, when + BAR); // ease back
  const sources = [];
  const nodes = [g];

  // Sub sines: fundamental + octave (the octave a touch quieter for body).
  for (const [m, mul] of [[root, 1.0], [root + 12, 0.5]]) {
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = mtof(m);
    const og = gainNode(ctx, mul);
    o.connect(og); og.connect(g);
    o.start(when);
    sources.push(o); nodes.push(o, og);
  }
  // Detuned saws an octave up, filtered dark.
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 300; lp.Q.value = 0.7;
  lp.connect(g); nodes.push(lp);
  for (const cents of [8, -8]) {
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = mtof(root + 12);
    o.detune.value = cents;
    const og = gainNode(ctx, 0.32);
    o.connect(og); og.connect(lp);
    o.start(when);
    sources.push(o); nodes.push(o, og);
  }
  g.connect(E.buses.comp);                          // sub gets no reverb send
  register(E, { sources, nodes }, when + BAR + 0.25);
}

// Layer 2 — Choir pad (≥0.15). Detuned triangle+saw per chord tone, parallel
// bandpass formants (~700Hz + ~1200Hz), a shared 5Hz→4Hz vibrato, very soft
// 0.8s attack, whole notes. Heavy reverb send.
function voicePad(E, when, chord, inten) {
  const { ctx } = E;
  const amp = imap(inten, GATE_PAD, 1, 0.09, 0.18);
  const dur = BAR;
  for (const m of chord.triad) {
    const g = gainNode(ctx, null);
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(amp, when + 0.8);          // soft attack
    g.gain.setValueAtTime(amp, when + dur - 0.4);
    g.gain.linearRampToValueAtTime(0.0001, when + dur + 0.3);
    const f1 = ctx.createBiquadFilter();
    f1.type = 'bandpass'; f1.frequency.value = 700; f1.Q.value = 3;
    const f2 = ctx.createBiquadFilter();
    f2.type = 'bandpass'; f2.frequency.value = 1200; f2.Q.value = 4;
    f1.connect(g); f2.connect(g);
    const nodes = [g, f1, f2];
    const sources = [];
    // One vibrato LFO drifting 5Hz -> 4Hz, driving both oscillators' detune.
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.setValueAtTime(5, when);
    lfo.frequency.linearRampToValueAtTime(4, when + dur);
    const lg = gainNode(ctx, 5);                              // ±5 cents depth
    lfo.connect(lg);
    lfo.start(when);
    sources.push(lfo); nodes.push(lfo, lg);
    for (const [type, cents, mul] of [['triangle', -6, 0.6], ['sawtooth', 6, 0.4]]) {
      const o = ctx.createOscillator();
      o.type = type; o.frequency.value = mtof(m); o.detune.value = cents;
      lg.connect(o.detune);
      const og = gainNode(ctx, mul);
      o.connect(og); og.connect(f1); og.connect(f2);
      o.start(when);
      sources.push(o); nodes.push(o, og);
    }
    wetDry(E, g, 0.22, nodes);
    register(E, { sources, nodes }, when + dur + 0.4);
  }
}

// Layer 3 — String ostinato (≥0.3). Root-fifth-octave arp, 8ths (16ths ≥0.55),
// ×3 saw stack detuned ±6 cents, lowpass 1.2→2.4kHz opening with intensity,
// short pluck envelope, accents on beats 1 & 3. The engine of the epicness.
function ostinatoNotes(barIndex, chord, inten) {
  const steps = inten >= GATE_OST_16 ? 16 : 8;
  const stepBeats = BEATS / steps;
  const base = chord.triad[0] + 12;             // up an octave (D4-ish)
  const cell = [0, 7, 12, 7];                   // root, fifth, octave, fifth
  const out = [];
  for (let i = 0; i < steps; i++) {
    const beat = i * stepBeats;
    // Accent the downbeats (beat 0 and beat 2 within the bar).
    const accent = Math.abs(beat % 2) < 1e-6;
    out.push({ beat, midi: base + cell[i % cell.length], accent });
  }
  return out;
}
function voiceOstinato(E, when, midi, accent, inten) {
  const { ctx } = E;
  const cutoff = imap(inten, GATE_OST, 1, 1200, 2400);
  const amp = accent ? 0.46 : 0.32;
  const g = gainNode(ctx, null);
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(amp, when + 0.005);      // a = 5ms
  g.gain.exponentialRampToValueAtTime(0.0001, when + 0.185);   // d = 180ms
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = cutoff; lp.Q.value = 1;
  lp.connect(g);
  const nodes = [g, lp];
  const sources = [];
  for (const cents of [6, -6, 0]) {
    const o = ctx.createOscillator();
    o.type = 'sawtooth'; o.frequency.value = mtof(midi); o.detune.value = cents;
    const og = gainNode(ctx, 0.33);
    o.connect(og); og.connect(lp);
    o.start(when);
    sources.push(o); nodes.push(o, og);
  }
  wetDry(E, g, 0.10, nodes);
  register(E, { sources, nodes }, when + 0.25);
}

// Layer 4 — Percussion (≥0.45). Taiko = 120→45Hz sine pitch-drop + a lowpassed
// noise thump. Hits on 1 and 3.5; a 3-hit rising fill every 4th bar; snare on
// 2/4 ≥0.7; a highpassed cymbal swell crescendos into every 4-bar downbeat.
function voiceTaiko(E, when, amp, startHz, endHz) {
  const { ctx, buses } = E;
  startHz = startHz || 120; endHz = endHz || 45;
  const g = gainNode(ctx, null);
  g.gain.setValueAtTime(amp, when);
  g.gain.exponentialRampToValueAtTime(0.0001, when + 0.35);
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(startHz, when);
  o.frequency.exponentialRampToValueAtTime(endHz, when + 0.09); // 90ms drop
  o.connect(g); o.start(when);
  // Noise transient for the skin attack.
  const ns = ctx.createBufferSource();
  ns.buffer = buses.noise;
  const nlp = ctx.createBiquadFilter();
  nlp.type = 'lowpass'; nlp.frequency.value = 800;
  const ng = gainNode(ctx, null);
  ng.gain.setValueAtTime(amp * 0.5, when);
  ng.gain.exponentialRampToValueAtTime(0.0001, when + 0.12);
  ns.connect(nlp); nlp.connect(ng);
  ns.start(when);
  const nodes = [g, o, nlp, ng];
  ng.connect(buses.comp);
  wetDry(E, g, 0.18, nodes);
  register(E, { sources: [o, ns], nodes: nodes.concat(ns) }, when + 0.4);
}
function voiceSnare(E, when, amp) {
  const { ctx, buses } = E;
  const src = ctx.createBufferSource();
  src.buffer = buses.noise;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass'; bp.frequency.value = 1800; bp.Q.value = 0.8;
  const g = gainNode(ctx, null);
  g.gain.setValueAtTime(amp, when);
  g.gain.exponentialRampToValueAtTime(0.0001, when + 0.13);
  src.connect(bp); bp.connect(g);
  const nodes = [src, bp, g];
  wetDry(E, g, 0.18, nodes);
  src.start(when);
  register(E, { sources: [src], nodes }, when + 0.2);
}
// Highpassed noise. `crash` = fast attack + decay (a hit); otherwise a swell
// that rises across `rise` seconds and peaks at `peak`.
function voiceCymbal(E, peak, rise, amp, crash) {
  const { ctx, buses } = E;
  const src = ctx.createBufferSource();
  src.buffer = buses.noise; src.loop = true;
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass'; hp.frequency.value = 6000; hp.Q.value = 0.5;
  const g = gainNode(ctx, null);
  let start, stop;
  if (crash) {
    start = peak; stop = peak + 1.3;
    g.gain.setValueAtTime(0.0001, peak);
    g.gain.exponentialRampToValueAtTime(amp, peak + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, peak + 1.2);
  } else {
    start = Math.max(0, peak - rise); stop = peak + 0.35;
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(amp, peak);           // 1.5s crescendo
    g.gain.exponentialRampToValueAtTime(0.0001, peak + 0.3);
  }
  src.connect(hp); hp.connect(g);
  const nodes = [src, hp, g];
  wetDry(E, g, 0.22, nodes);
  src.start(start);
  register(E, { sources: [src], nodes }, stop);
}
function percEvents(barIndex, inten) {
  const ev = { taiko: [{ beat: 0, amp: 0.68 }, { beat: 2.5, amp: 0.5 }], fill: [], snare: [] };
  if (((barIndex % 4) + 4) % 4 === 3) {          // rising fill on every 4th bar
    ev.fill.push({ beat: 3.0, amp: 0.30, hz: 90 });
    ev.fill.push({ beat: 3.33, amp: 0.38, hz: 105 });
    ev.fill.push({ beat: 3.66, amp: 0.46, hz: 120 });
  }
  if (inten >= GATE_SNARE) { ev.snare.push({ beat: 1 }); ev.snare.push({ beat: 3 }); }
  return ev;
}

// Layer 5 — Horn theme (≥0.65). 2 saws + 1 square detuned, lowpass ~900Hz,
// 120ms attack swell. Long heroic-doom notes.
function voiceHorn(E, when, midi, durBeats, inten) {
  const { ctx } = E;
  const dur = durBeats * SPB;
  const amp = imap(inten, GATE_HORN, 1, 0.28, 0.46);
  const g = gainNode(ctx, null);
  g.gain.setValueAtTime(0.0001, when);
  g.gain.linearRampToValueAtTime(amp, when + 0.12);            // 120ms swell
  g.gain.setValueAtTime(amp, when + Math.max(0.12, dur - 0.15));
  g.gain.linearRampToValueAtTime(0.0001, when + dur + 0.1);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 900; lp.Q.value = 0.8;
  lp.connect(g);
  const nodes = [g, lp];
  const sources = [];
  for (const [type, cents, mul] of [['sawtooth', -7, 0.5], ['sawtooth', 7, 0.5], ['square', 0, 0.26]]) {
    const o = ctx.createOscillator();
    o.type = type; o.frequency.value = mtof(midi); o.detune.value = cents;
    const og = gainNode(ctx, mul);
    o.connect(og); og.connect(lp);
    o.start(when);
    sources.push(o); nodes.push(o, og);
  }
  wetDry(E, g, 0.22, nodes);
  register(E, { sources, nodes }, when + dur + 0.2);
}

// A generic sustained saw+square chord tone (used by stinger brass / drones).
function voiceSustain(E, when, midi, dur, amp, opts) {
  const { ctx } = E;
  opts = opts || {};
  const attack = opts.attack != null ? opts.attack : 0.06;
  const lpHz = opts.lp || 1000;
  const wet = opts.wet != null ? opts.wet : 0.22;
  const g = gainNode(ctx, null);
  g.gain.setValueAtTime(0.0001, when);
  g.gain.linearRampToValueAtTime(amp, when + attack);
  g.gain.setValueAtTime(amp, when + Math.max(attack, dur - 0.4));
  g.gain.linearRampToValueAtTime(0.0001, when + dur + 0.3);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = lpHz; lp.Q.value = 0.8;
  lp.connect(g);
  const nodes = [g, lp];
  const sources = [];
  const stack = opts.stack || [['sawtooth', -7, 0.5], ['sawtooth', 7, 0.5], ['square', 0, 0.22]];
  for (const [type, cents, mul] of stack) {
    const o = ctx.createOscillator();
    o.type = type; o.frequency.value = mtof(midi); o.detune.value = cents;
    const og = gainNode(ctx, mul);
    o.connect(og); og.connect(lp);
    o.start(when);
    sources.push(o); nodes.push(o, og);
  }
  wetDry(E, g, wet, nodes);
  register(E, { sources, nodes }, when + dur + 0.35);
}

// ===========================================================================
// STINGERS — one-shot dramatic events. They stand on their own at any
// intensity (in the live path stinger() also pulse(1)s the meter).
// ===========================================================================
function stingerBreach(E, when) {
  const hz = [70, 80, 92, 105, 120, 138];        // 6-hit rising timpani roll
  for (let i = 0; i < 6; i++) voiceTaiko(E, when + i * 0.13, 0.50 + 0.05 * i, hz[i], 50);
  const hit = when + 6 * 0.13 + 0.05;
  for (const m of [50, 53, 57, 62]) voiceSustain(E, hit, m, 1.2, 0.32, { attack: 0.02, lp: 1200 });
  voiceCymbal(E, hit, 0.6, 0.17, true);           // crash
}
function stingerPure(E, when) {
  // Bb major -> D MAJOR (picardy third): reverent, warm, resolving.
  const warm = { attack: 0.35, lp: 1500, wet: 0.30, stack: [['triangle', -5, 0.6], ['sawtooth', 5, 0.35]] };
  for (const m of [46, 50, 53, 58]) voiceSustain(E, when, m, 1.6, 0.17, warm);            // Bb D F Bb
  for (const m of [50, 54, 57, 62]) voiceSustain(E, when + 1.6, m, 2.4, 0.19, warm);      // D F# A D
}
function stingerOcean(E, when) {
  // Solemn low open fifth D2 + A2, 3s swell + fade.
  const opt = { attack: 0.8, lp: 520, wet: 0.28, stack: [['sawtooth', -6, 0.45], ['sawtooth', 6, 0.45], ['sine', 0, 0.6]] };
  for (const m of [38, 45]) voiceSustain(E, when, m, 3.0, 0.20, opt);
}
function stingerSignaling(E, when) {
  // Low tritone D2 + G#2 with slow beating (±5c pairs) — dread. 4s.
  const { ctx } = E;
  for (const m of [38, 44]) {
    const g = gainNode(ctx, null);
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(0.17, when + 1.2);
    g.gain.setValueAtTime(0.17, when + 3.0);
    g.gain.linearRampToValueAtTime(0.0001, when + 4.0);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 400; lp.Q.value = 0.9;
    lp.connect(g);
    const nodes = [g, lp];
    const sources = [];
    for (const cents of [6, -6]) {                 // detuned pair -> ~1Hz beat
      const o = ctx.createOscillator();
      o.type = 'sawtooth'; o.frequency.value = mtof(m); o.detune.value = cents;
      const og = gainNode(ctx, 0.4);
      o.connect(og); og.connect(lp);
      o.start(when);
      sources.push(o); nodes.push(o, og);
    }
    const sub = ctx.createOscillator();
    sub.type = 'sine'; sub.frequency.value = mtof(m);
    const sg = gainNode(ctx, 0.5);
    sub.connect(sg); sg.connect(g); sub.start(when);
    sources.push(sub); nodes.push(sub, sg);
    wetDry(E, g, 0.2, nodes);
    register(E, { sources, nodes }, when + 4.3);
  }
}
function fireStinger(E, when, kind) {
  switch (kind) {
    case 'pure': return stingerPure(E, when);
    case 'ocean': return stingerOcean(E, when);
    case 'signaling': return stingerSignaling(E, when);
    case 'breach':
    default: return stingerBreach(E, when);
  }
}

// ===========================================================================
// COMPOSITION CORE — scheduleBar is the single entry both paths call. Pure in
// (barIndex, intensity): the SAME notes land whether we're rendering live or
// offline. It only ever *creates* nodes on the passed context.
// ===========================================================================
function scheduleBar(E, barIndex, when, inten) {
  const chord = chordForBar(barIndex);
  voiceDrone(E, when, chord);                                          // always
  if (inten >= GATE_PAD) voicePad(E, when, chord, inten);
  if (inten >= GATE_OST) {
    for (const n of ostinatoNotes(barIndex, chord, inten))
      voiceOstinato(E, when + n.beat * SPB, n.midi, n.accent, inten);
  }
  if (inten >= GATE_PERC) {
    const ev = percEvents(barIndex, inten);
    for (const h of ev.taiko) voiceTaiko(E, when + h.beat * SPB, h.amp);
    for (const h of ev.fill) voiceTaiko(E, when + h.beat * SPB, h.amp, h.hz, 45);
    for (const s of ev.snare) voiceSnare(E, when + s.beat * SPB, imap(inten, GATE_SNARE, 1, 0.14, 0.22));
    // Cymbal swell crescendos INTO the next 4-bar downbeat (peaks at bar end).
    if (((barIndex + 1) % 4) === 0) voiceCymbal(E, when + BAR, 1.5, imap(inten, GATE_PERC, 1, 0.05, 0.11), false);
  }
  if (inten >= GATE_HORN) {
    const pos = ((barIndex % 16) + 16) % 16;
    if (pos < 8) for (const n of HORN_THEME[pos]) voiceHorn(E, when + n.b * SPB, n.m, n.d, inten);
  }
}

// ---------------------------------------------------------------------------
// WAV encode (16-bit PCM) — browser-only (returns a Blob).
// ---------------------------------------------------------------------------
function encodeWav(buf) {
  const nCh = buf.numberOfChannels;
  const len = buf.length;
  const sr = buf.sampleRate;
  const blockAlign = nCh * 2;
  const dataLen = len * blockAlign;
  const ab = new ArrayBuffer(44 + dataLen);
  const dv = new DataView(ab);
  let o = 0;
  const wStr = (s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o++, s.charCodeAt(i)); };
  const w32 = (v) => { dv.setUint32(o, v, true); o += 4; };
  const w16 = (v) => { dv.setUint16(o, v, true); o += 2; };
  wStr('RIFF'); w32(36 + dataLen); wStr('WAVE');
  wStr('fmt '); w32(16); w16(1); w16(nCh); w32(sr); w32(sr * blockAlign); w16(blockAlign); w16(16);
  wStr('data'); w32(dataLen);
  const chans = [];
  for (let c = 0; c < nCh; c++) chans.push(buf.getChannelData(c));
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < nCh; c++) {
      let s = chans[c][i];
      s = s < -1 ? -1 : s > 1 ? 1 : s;
      dv.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([ab], { type: 'audio/wav' });
}

// ===========================================================================
// OFFLINE PREVIEW — renders the identical composition to a WAV Blob. Intensity
// comes from the passed curve (sampled per bar); stingers land at absolute
// times. Shares scheduleBar + fireStinger with the live path verbatim.
// ===========================================================================
export async function renderScoreToWav(opts = {}) {
  const seconds = opts.seconds || 32;
  const curve = opts.intensityCurve || [[0, 0.3], [10, 0.6], [20, 1.0], [26, 0.5]];
  const stingers = opts.stingers || [[20, 'breach']];
  const sampleRate = 44100;
  const OAC = (typeof OfflineAudioContext !== 'undefined')
    ? OfflineAudioContext
    : (typeof webkitOfflineAudioContext !== 'undefined' ? webkitOfflineAudioContext : null);
  if (!OAC) throw new Error('OfflineAudioContext unavailable');

  const ctx = new OAC(2, Math.ceil(seconds * sampleRate), sampleRate);
  const buses = buildBuses(ctx);
  const E = { ctx, buses, live: null };

  const nBars = Math.ceil(seconds / BAR) + 1;
  for (let b = 0; b < nBars; b++) {
    const when = b * BAR;
    if (when >= seconds) break;
    scheduleBar(E, b, when, clamp01(sampleCurve(curve, when)));
  }
  for (const [t, kind] of stingers) if (t < seconds) fireStinger(E, t, kind);

  const rendered = await ctx.startRendering();
  return encodeWav(rendered);
}

// ===========================================================================
// LIVE SCORE — AudioContext + a lookahead scheduler (setInterval ~25ms,
// scheduling ~120ms ahead) driving per-bar composition. Import-safe: the ctx
// is only built inside toggle()/start(), i.e. within the user's gesture.
// ===========================================================================
export function createWarScore(opts = {}) {
  const LOOKAHEAD = 0.12;              // schedule this far ahead of ctx time (s)
  const TICK_MS = 25;                  // scheduler wakeup interval

  let ctx = null;
  let buses = null;
  let E = null;
  let scheduler = null;               // setInterval handle (null when halted)
  let barIndex = 0;                   // monotonic musical bar counter
  let nextBarTime = 0;                // ctx time of the next bar to schedule
  let level = AMBIENT_BASE;           // smoothed intensity
  let lastUpdate = 0;                 // ctx time of the last decay integration
  let enabled = false;

  function ensureCtx() {
    if (ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();
    buses = buildBuses(ctx);
    E = { ctx, buses, live: new Set() };
  }

  // Integrate the intensity decay toward AMBIENT_BASE using real elapsed time.
  function decay(now) {
    const dt = Math.max(0, now - lastUpdate);
    lastUpdate = now;
    level += (AMBIENT_BASE - level) * (1 - Math.exp(-dt / INTENSITY_TAU));
    level = clamp01(level);
  }

  function tick() {
    if (!ctx) return;
    const now = ctx.currentTime;
    decay(now);
    // Emit any bars that fall inside the lookahead window.
    while (nextBarTime < now + LOOKAHEAD) {
      scheduleBar(E, barIndex, nextBarTime, level);
      barIndex += 1;
      nextBarTime += BAR;
    }
  }

  // Start / resume — MUST run inside a user gesture so the ctx is allowed to
  // produce sound. Realigns the timeline so bars resume at the next boundary.
  function start() {
    ensureCtx();
    enabled = true;
    const ready = ctx.resume ? ctx.resume() : Promise.resolve();
    Promise.resolve(ready).then(() => {
      if (!enabled) return;                          // toggled off mid-resume
      const now = ctx.currentTime;
      buses.master.gain.cancelScheduledValues(now);
      buses.master.gain.setValueAtTime(0.0001, now);
      buses.master.gain.linearRampToValueAtTime(MASTER_GAIN, now + 0.08);
      nextBarTime = now + 0.06;
      lastUpdate = now;
      if (!scheduler) scheduler = setInterval(tick, TICK_MS);
      tick();
    }).catch(() => { /* resume rejects only without a gesture; ignore */ });
  }

  // Stop — silence within ~100ms (ramp master to 0, kill every live voice) and
  // halt the scheduler, then suspend the ctx so it costs nothing while off.
  function hardStop() {
    enabled = false;
    if (scheduler) { clearInterval(scheduler); scheduler = null; }
    if (!ctx) return;
    const now = ctx.currentTime;
    try {
      buses.master.gain.cancelScheduledValues(now);
      buses.master.gain.setValueAtTime(buses.master.gain.value, now);
      buses.master.gain.linearRampToValueAtTime(0.0001, now + 0.04);
    } catch (_) { /* ignore */ }
    setTimeout(() => {
      if (enabled) return;                           // toggled back on already
      if (E && E.live) {
        for (const v of E.live) {
          for (const s of v.sources) { try { s.stop(); } catch (_) { /* */ } }
          for (const n of v.nodes) { try { n.disconnect(); } catch (_) { /* */ } }
        }
        E.live.clear();
      }
      if (ctx && ctx.state === 'running' && ctx.suspend) ctx.suspend().catch(() => {});
    }, 60);
  }

  // --- public surface -------------------------------------------------------
  function toggle() {
    if (enabled) hardStop(); else start();
    return enabled;
  }
  function setEnabled(v) {
    if (v && !enabled) start();
    else if (!v && enabled) hardStop();
    return enabled;
  }
  // Battle energy injection: shove intensity up (clamped); it decays on its own.
  function pulse(amount) {
    if (!enabled) return;
    if (!(amount > 0)) return;
    level = clamp01(level + amount);
  }
  // Fire a dramatic one-shot and give the meter a full jolt. No-op when off.
  function stinger(kind) {
    if (!enabled || !ctx) return;
    try { fireStinger(E, ctx.currentTime + 0.02, kind); } catch (_) { /* */ }
    pulse(1);
  }
  function intensity() { return clamp01(level); }
  function state() { return ctx ? ctx.state : 'closed'; }
  function dispose() {
    hardStop();
    setTimeout(() => {
      if (ctx && ctx.close) { try { ctx.close(); } catch (_) { /* */ } }
      ctx = null; buses = null; E = null;
    }, 120);
  }

  return {
    get enabled() { return enabled; },
    toggle, setEnabled, pulse, stinger, intensity, state, dispose,
  };
}
