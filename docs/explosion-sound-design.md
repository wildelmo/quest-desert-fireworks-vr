# How the firework explosion sound was built

This documents the design behind the boom/detonation sound in this app, so it
can be reproduced in another project without re-deriving it from scratch.

Source of truth is the code — this doc should stay in sync with:
- `src/synth.js` — `renderBoom()`, `renderDesertIR()`
- `src/audio.js` — `AudioEngine.init()`, `AudioEngine.boom()`, `AudioEngine.play()`

## The core idea

It is **not** a single sample with reverb slapped on, and it is **not** pure
synthesis either. It's a real recording used as one texture layer inside a
5-layer synthesized structure, all baked offline into an `AudioBuffer` once at
load time. Only the *playback routing* (panning, reverb send, distance delay)
happens live per explosion — the layering itself is pre-rendered.

## Step 1 — Pre-render a small library of boom buffers offline

At startup, render 3-4 seeded variants per size tier (big/med/small) so no two
shots sound identical (`audio.js:90-117`, `variants()` calls). Each buffer is
the sum of 5 layers (`synth.js:74-217`, `renderBoom()`):

**Layer 1 — Report (blast pulse).** Asymmetric envelope
`(1 - t/T) * exp(-1.5*t/T)`, `T = 6-15ms` depending on size, through a
one-pole lowpass (cutoff ~1000-1900 Hz) for a natural rise time. Add a second,
inverted, darker copy 14-36ms later (cutoff ~550Hz) — a ground-bounce echo.

**Layer 2 — Crack edge.** White noise band-passed to 1.2-6.5kHz (difference
of two one-pole lowpasses), fast decay (τ = 5-10ms) plus a small secondary
30ms tail. This is what reads as "sharp."

**Layer 3 — Body (the real recording).** Real CC0 explosion recording
(`assets/sounds/explosion1.wav` / `explosion2.wav`, Kenney, see
`assets/sounds/LICENSE.txt`), resampled at
`rate = (1.28 - size*0.42) * (0.92 to 1.08 random)` — **rate < 1 = literally
slowed down**, more for bigger shells. Pushed through a lowpass whose cutoff
collapses over time: `420 + 2600*exp(-t*7)` Hz, so it starts bright and darkens
fast (simulates air absorption over distance). Enveloped by
`exp(-t/(0.30+size*0.28))` so it stays impulsive instead of sounding like a
sustained movie boom. Gain boosted ~4x. Falls back to filtered noise if the
recording fails to load.

**Layer 4 — Chest thump.** A second, slower low-frequency-only pulse
(T = 20-34ms), lowpassed hard at 120Hz, then soft-clipped with `tanh`
(drive 1.9). **Deliberately not a pitch-sweep/sine-glide** — a sweep gives an
unwanted "rubber-band boing" character (noted directly in the code). This is
what gives the "detonation" weight.

**Layer 5 — Rolling rumble tail.** Leaky-integrated brown noise (leak
coefficient 0.996), lowpassed at 130Hz, amplitude-modulated by a slow ~1.6Hz
undulator so it rolls instead of hissing flat. Tail length 0.9-2.0s depending
on size.

**Glue pass:** sum all 5 layers, run the mix through a gentle `tanh` soft-clip
(drive 1.25), apply a DC-blocking filter, then peak-normalize to 0.95.

## Step 2 — Build one shared reverb impulse response (also synthesized)

`renderDesertIR()` (`synth.js:1114-1163`) — a 4.2-second stereo buffer meant to
sound like an open desert with distant rock walls, **not** a recorded IR file:

- Direct head: tiny spike at t=0 (gain 0.12)
- 5 discrete slapback echoes at t = 0.45, 0.78, 1.25, 1.9, 2.6s, gains falling
  0.30 → 0.055, each a lowpassed noise burst that gets progressively darker
  and wider (cutoff 900 → 320Hz) — farther "walls" sound duller and more
  diffuse
- A continuous diffuse tail: noise lowpassed at 1400Hz, enveloped by
  `exp(-t/1.15)*0.16` across the full 4.2s
- Random stereo pan per echo, baked in once

Loaded into a single `ConvolverNode` shared by every sound in the scene
(`audio.js:63-64`).

## Step 3 — Live playback chain per explosion

```
AudioBufferSource (random pre-rendered variant matching size tier)
  → [optional distance lowpass, only active beyond 80m]
  → per-voice GainNode
  → PannerNode (equalpower panning, NOT HRTF — HRTF is too CPU-heavy once
                20+ voices stack during a finale;
                distanceModel: inverse, refDistance: 12, rolloffFactor: 1)
      ├── straight to master bus (dry)
      └── through a send-gain → shared ConvolverNode → wet gain (0.9) → master bus
```

Parameters actually used (`audio.js:302-334`, `boom()`):
- Base gain: `3.0 * (0.7 + size*0.6)`
- Playback rate: `(size > 0.75 ? 0.9 : 0.94) + random()*0.12` — random
  pitch/rate variance per play, ±6-12%
- Reverb send amount: `0.4 + size*0.25` (40-65% wet)
- Distance-based delay: `delay = distance / 340` (real speed of sound in m/s)
  — big/far shells' booms arrive audibly late relative to the visual flash
- Optional trailing layer: 120ms later, a separate "crackle" sample (dense
  stochastic bandpassed noise snaps) for crackle-type shells; or for any large
  shell, a fainter sizzle tail 250ms later (gain 0.45, rate 0.78-0.86)
  representing burning stars

## Step 4 — Master bus (shared, applied once to everything)

```
Master GainNode (0.85)
  → Lowshelf filter (110 Hz, +4.5 dB)   ← adds "chest" sub-bass weight
  → DynamicsCompressor (threshold -12dB, knee 24, ratio 3.5,
                         attack 6ms, release 300ms)
  → destination
```

The compressor is what lets many simultaneous booms during a finale glue
together without clipping or fighting each other.

## Condensed version, for briefing another LLM/coding assistant

> Don't just play a boom sample with reverb. Pre-render each boom as an
> offline mix of: (1) a fast asymmetric pressure-pulse "crack" through a
> lowpass, with an inverted ground-bounce echo ~20ms later, (2) a short bright
> bandpassed-noise transient, (3) a real explosion recording slowed down
> (playbackRate < 1, more for bigger shells) and run through a lowpass whose
> cutoff decays exponentially over the sample's duration, (4) a second slow
> low-end-only pulse pushed through tanh soft-clipping (not a pitch sweep) for
> detonation weight, (5) a long undulating brown-noise rumble tail. Sum,
> soft-clip the mix lightly, normalize. Build 3-4 random-seeded variants per
> size tier so it never repeats identically. For reverb, synthesize your own
> impulse response (a few darkened/widened discrete "wall echo" noise bursts +
> a diffuse decaying tail) rather than using a generic hall IR — it reads as
> an outdoor space with real distant reflections instead of an indoor room.
> Route each voice through panning + a reverb send, delay trigger time by
> distance/343 for physical realism, and finish with a low-shelf boost around
> 100-110Hz into a compressor on the master bus so multiple simultaneous
> booms don't clip.

## Key files

- `src/synth.js:74-217` — `renderBoom()`
- `src/synth.js:1114-1163` — `renderDesertIR()`
- `src/audio.js:302-334` — `boom()` trigger/routing
- `src/audio.js:38-60` — master bus
- `assets/sounds/explosion1.wav`, `explosion2.wav` — the recorded source
  layer (CC0, Kenney; see `assets/sounds/LICENSE.txt`)
