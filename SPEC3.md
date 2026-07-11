# SPEC3 — Phase 3: "WAR DRUMS" — adaptive epic score, toggleable

Dramatic, SERIOUS, epic music synthesized entirely with the Web Audio API
(zero assets, zero deps — consistent with the site). It must not sound like
a toy: rich detuned saw stacks, generated convolver reverb, compressed
master bus. Think trailer-orchestra rendered by synths, not chiptune.
The score is ADAPTIVE: it tracks the battle and hits stingers on real
chain events.

## Files (single builder owns all; nothing else may change)

```
js/music.js      NEW — the whole score engine (no DOM, no imports)
js/main.js       wire-up (toggle handle creation, pass to hud)
js/hud.js        toggle button state + stinger/intensity calls
index.html       header toggle button + one modal line ("The score")
css/style.css    button styling (match .live-badge / .btn-ghost patterns)
```

## js/music.js contract

```js
export function createWarScore(opts = {}) -> {
  enabled: boolean,          // current state
  toggle() -> boolean,       // flips, returns new state; MUST be safe to call
                             // from a click handler (creates/resumes
                             // AudioContext inside the gesture)
  setEnabled(bool),
  pulse(amount),             // battle energy injection, clamped; decays
                             // internally (tau ~8s) toward AMBIENT_BASE 0.35
  stinger(kind),             // 'breach' | 'pure' | 'ocean' | 'signaling'
                             // no-ops silently when disabled
  intensity() -> 0..1,       // current smoothed intensity (for debugging)
  dispose(),
}
// TEST/PREVIEW EXPORT (browser-only, used by QA + to render a preview clip):
export async function renderScoreToWav({seconds = 32, intensityCurve = [[0,0.3],[10,0.6],[20,1.0],[26,0.5]], stingers = [[20,'breach']]}) -> Blob  // audio/wav
// Implemented on OfflineAudioContext by parameterizing the same scheduler —
// the live path and the render path MUST share the composition code.
```

No AudioContext at import time (import-safe under node --check and until
the user gestures). Live path uses one lookahead scheduler (setInterval
~25ms, schedule ~120ms ahead) driving per-bar composition.

## The composition (binding)

- **Key/tempo**: D minor, 100 BPM, 4/4. Chord loop A: Dm | B♭ | F | A7.
  Loop B (every other cycle): Dm | B♭ | Gm | A7. 4 beats per chord.
- **Layer 1 — Doom drone** (always on): sub sine at root (D1/D2) + two saws
  an octave up detuned ±8 cents through a lowpass (~300Hz), slow gain swell
  per chord. This alone must feel ominous at intensity 0.
- **Layer 2 — Choir pad** (intensity ≥ 0.15): detuned triangle+saw stack,
  bandpass formants (~700Hz + ~1200Hz peaks), slow 5Hz→4Hz vibrato, whole
  notes on chord tones, very soft attack (0.8s).
- **Layer 3 — String ostinato** (≥ 0.3): 8th notes (16ths when ≥ 0.55) on
  a root-fifth-octave-arp pattern, saw stack ×3 detuned ±6 cents, lowpass
  1.2-2.4kHz opening with intensity, short envelope (a=5ms d=180ms),
  accent beats 1 and 3. This is the engine of the epicness.
- **Layer 4 — Percussion** (≥ 0.45): taiko = sine pitch-drop 120→45Hz over
  90ms + lowpassed noise burst; pattern: hits on 1 and 3.5, fill (3 rising
  hits) every 4th bar; add snare-ish mid noise on 2/4 when ≥ 0.7; cymbal
  swell (highpassed noise, 1.5s crescendo) into every 4-bar downbeat.
- **Layer 5 — Horn theme** (≥ 0.65): the melody, long heroic-doom notes,
  2 saws + 1 square detuned, lowpass ~900Hz, 120ms attack swell, plays an
  8-bar theme once per 16 bars (rest otherwise so it stays special).
  Theme (scale degrees in D natural minor, beats in parens):
  D4(2) F4(2) | E4(3) C4(1) | D4(2) A4(2) | B♭4(3) A4(1) |
  F4(2) G4(2) | A4(4) | G4(2) E4(2) | D4(4).
- **Stingers** (work even at low intensity; also pulse(1)):
  - breach: 6-hit rising timpani roll → big Dm brass hit + cymbal.
  - pure: two-chord resolution B♭ → D MAJOR (picardy), warm, reverent.
  - ocean: solemn low horn open fifth (D2+A2), 3s swell and fade.
  - signaling: low tritone cluster (D2+G#2) with slow beating, 4s — dread.
- **Mix bus**: everything → DynamicsCompressorNode (threshold -18, ratio 4,
  knee 20) → master gain 0.38 → destination. Reverb: ConvolverNode with a
  generated impulse (2.8s exponential-decay stereo noise), ~22% wet send
  from pads/horn/percussion, less (~10%) from ostinato, none from sub.
- No clipping at intensity 1.0 with a breach stinger on top (verify in the
  offline render: peak < 0.95).

## Adaptive wiring (hud.js)

- On 'tx' events: violator → music.pulse(0.04 + 0.02*log10(1+dataBytes/100));
  infiltrator → music.pulse(0.008). (Cheap, already in onTx path.)
- In applyReport (animate only): music.stinger(report.pure ? 'pure'
  : isOcean(report.pool) ? 'ocean' : report.signaling ? 'signaling'
  : 'breach').
- All calls guarded: `music && music.stinger(...)` — hud must work when
  music is absent (tests, degraded boot).

## Toggle UX (main.js + index.html + css)

- Header button next to the LIVE badge: id `music-toggle`, text
  "♪ WAR DRUMS: OFF" / "♪ WAR DRUMS: ON" (aria-pressed, styled like the
  ghost button; ON state gets the gold accent). Click → music.toggle().
- Keyboard shortcut "m" (not when typing in an input/textarea — check
  e.target).
- Persist in localStorage key `tbfb-music` ('on'/'off'). Default OFF.
  If stored ON: do NOT autoplay (browsers block it); arm a one-time
  pointerdown/keydown listener that starts the score on first gesture,
  and show the button already in its ON visual state.
- Modal line (in "How this works", after the Trench Chat block): "The
  score: synthesized live in your browser with the Web Audio API — no
  samples, no files. It tracks the battle: drums build with the spam wave,
  stingers land on real block events. Toggle with the ♪ button or press M."

## Verification

- node --check on all touched js; `node --test test/` stays 45/45
  (music.js is never imported by tests; hud guards make it inert there).
- Offline render QA (headless chrome, --autoplay-policy=no-user-gesture-required):
  call renderScoreToWav for a 32s clip with the default curve; decode and
  assert: RMS in [-30dB, -10dB] window-wise (no silence, no wall of sound),
  peak < 0.95, spectral energy visibly increases between t=5s (low
  intensity) and t=22s (post-breach full intensity), stinger transient
  present near t=20s. Save the wav to scratchpad for the coordinator.
- Live QA: toggle ON via real click → context.state === 'running', audio
  time advances, no console errors; toggle OFF stops sound (suspend or
  gain 0 + scheduler halt); localStorage persists across reload; 'm' works;
  button reflects state.
