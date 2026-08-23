// Procedural audio: every sound in the game is rendered here, at load time,
// into AudioBuffers. Recipes are layered DSP built from first principles and
// tuned against measured firework acoustics: a shell report is a Friedlander
// blast pulse (sharp asymmetric pressure spike + rarefaction dip, a few ms
// long) whose energy sits almost entirely below 125 Hz, followed by seconds
// of rolling low rumble. Two hard rules keep everything from going "tin
// drum": no high-Q resonators anywhere near a transient (a damped sinusoid
// IS a drum shell), and no pure-sine pops (a sine burst IS a metallic ding) —
// every snap and crack here is shaped noise. Rendering several seeded
// variants of each sample plus randomized playback rate means no two shots
// sound identical.

import { mulberry32 } from './utils.js';

const TWO_PI = Math.PI * 2;

function softClip(x, drive = 1.2) {
  return Math.tanh(x * drive) / Math.tanh(drive);
}

function normalize(channels, peakTarget = 0.92) {
  let peak = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) {
      const a = Math.abs(ch[i]);
      if (a > peak) peak = a;
    }
  }
  if (peak < 1e-6) return;
  const s = peakTarget / peak;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) ch[i] *= s;
  }
}

function toBuffer(ctx, channels, sr) {
  const buf = ctx.createBuffer(channels.length, channels[0].length, sr);
  for (let c = 0; c < channels.length; c++) buf.copyToChannel(channels[c], c);
  return buf;
}

// Crossfade the tail of a rendered loop into its head so it loops seamlessly.
function makeSeamless(ch, sr, fadeSec = 0.12) {
  const f = Math.min(ch.length >> 1, Math.floor(fadeSec * sr));
  const N = ch.length;
  for (let i = 0; i < f; i++) {
    const t = i / f;
    ch[i] = ch[i] * t + ch[N - f + i] * (1 - t);
  }
  return ch.subarray(0, N - f);
}

// One-pole lowpass coefficient for cutoff fc
const lpCoef = (fc, sr) => Math.exp(-TWO_PI * Math.min(fc, sr * 0.45) / sr);

// ---------------------------------------------------------------------------
// THE BOOM — the star of the show.
// size: 0..1 (small pop .. finale shell)
// body: optional Float32Array of a real explosion recording (at ctx rate).
//       Synthesis nails the pressure wave and the rumble, but the dense
//       chaotic mid texture of a genuine blast is not synthesizable — so a
//       CC0 recording (assets/sounds/) carries the body, pitched and tilted
//       per variant, and the DSP layers wrap around it.
//
// Anatomy, matched to what a shell actually does at spectator distance:
//   crack-BOOM ...................... Friedlander pulse + its ground bounce
//        \_ body .................... real recording (or filtered noise)
//           \_ chest thump .......... a second, slow, LF-only pressure pulse.
//                                     Deliberately NOT a pitch glide — a
//                                     swept sine reads as a rubber-band boing
//              \_ rolling rumble .... undulating brown noise, seconds long
// The envelope peaks AT the report (t≈0), never later — a boom that swells
// after the hit reads as mush, not impact.
export function renderBoom(ctx, seed = 1, size = 1.0, body = null) {
  const sr = ctx.sampleRate;
  const dur = 2.6 + size * 2.2;
  const N = Math.floor(dur * sr);
  const rand = mulberry32(seed * 7919 + 13);
  // mono: these buffers play through PannerNodes, which downmix anyway
  const M = new Float32Array(N);

  // Friedlander blast pulse: instant overpressure spike decaying through a
  // rarefaction undershoot. One-pole smoothing sets the rise time (distance
  // and air absorption round off the shock front — kills the digital tick).
  const addReport = (at, amp, Tpos, fcRise) => {
    const i0 = Math.floor(at * sr);
    const a = lpCoef(fcRise, sr);
    let lp = 0;
    const len = Math.min(N - i0, Math.floor(Tpos * 7 * sr));
    for (let k = 0; k < len; k++) {
      const t = k / sr;
      const x = (1 - t / Tpos) * Math.exp(-1.5 * t / Tpos);
      lp = a * lp + (1 - a) * x;
      M[i0 + k] += lp * amp;
    }
  };

  // 1) The report — big shells push a longer positive phase (deeper "BOOM",
  // less "crack"); the ground reflection lands a couple hundredths later,
  // inverted and duller, which doubles the report the way open terrain does.
  const Tpos = 0.006 + size * 0.009;
  addReport(0, 3.4, Tpos, 1900 - size * 900);
  addReport(0.014 + rand() * 0.022, -1.4, Tpos * 1.2, 550);

  // 2) Crack edge — a burst of 1.2-6.5 kHz noise with a ~10 ms decay (NOT a
  // one-sample click): the brilliant "tssh" edge riding the front of the
  // report. Fades fast so the low end owns everything after 50 ms.
  {
    let lo = 0, hi = 0;
    const aLo = lpCoef(6500, sr), aHi = lpCoef(1200, sr);
    const tau = 0.005 + size * 0.005;
    const end = Math.min(N, Math.floor(0.09 * sr));
    for (let i = 0; i < end; i++) {
      const t = i / sr;
      const x = rand() * 2 - 1;
      lo = aLo * lo + (1 - aLo) * x;
      hi = aHi * hi + (1 - aHi) * x;
      const env = Math.exp(-t / tau) + 0.18 * Math.exp(-t / 0.03);
      M[i] += (lo - hi) * env * (1.1 - size * 0.35);
    }
  }

  // 3) Body — the meat of the boom. Preferred: a real recording, resampled
  // so big shells play deep and slow, then tilted dark by a collapsing
  // lowpass (a mortar 100 m up has lost its crunchy top by the time it
  // reaches you). Fallback: filtered noise, thick and non-tonal.
  if (body && body.length) {
    // linear resample: rate < 1 = deeper/longer. Two seeded rates so no two
    // variants share a pitch.
    const rate = (1.28 - size * 0.42) * (0.92 + rand() * 0.16);
    let lp = 0, lp2 = 0;
    const outLen = Math.min(N, Math.floor(body.length / rate));
    for (let i = 0; i < outLen; i++) {
      const t = i / sr;
      const p = i * rate;
      const i0 = p | 0;
      const fr = p - i0;
      const s = body[i0] * (1 - fr) + (body[Math.min(i0 + 1, body.length - 1)] ?? 0) * fr;
      // air-absorption tilt: opens dark, closes darker
      const a = lpCoef(420 + 2600 * Math.exp(-t * 7), sr);
      lp = a * lp + (1 - a) * s;
      lp2 = a * lp2 + (1 - a) * lp;
      // the raw recording sustains a movie-explosion roar; a mortar report
      // peaks instantly and rolls off, so impose that decay on it
      const env = Math.exp(-t / (0.30 + size * 0.28));
      M[i] += lp2 * env * 4.2 * (1 + size * 0.4);
    }
  } else {
    let lp = 0, lp2 = 0;
    const bodyTau = 0.11 + size * 0.10;
    for (let i = 0; i < N; i++) {
      const t = i / sr;
      const cutoff = 110 + 900 * Math.exp(-t * 9);
      const a = lpCoef(cutoff, sr);
      const env = Math.exp(-t / bodyTau);
      const x = rand() * 2 - 1;
      lp = a * lp + (1 - a) * x;
      lp2 = a * lp2 + (1 - a) * lp;
      M[i] += lp2 * env * 7.5;
      if (env < 0.001) break;
    }
  }

  // 4) Chest thump — a second pressure pulse, much slower and LF-only: the
  // concussion that arrives through your sternum. A shaped pulse, NOT a
  // pitch glide (a swept sine reads as a rubber band, not a mortar). Soft
  // clipping folds a little of it up into 100-250 Hz for small speakers.
  {
    const Tth = 0.020 + size * 0.014;
    const a = lpCoef(120, sr);
    let lp = 0;
    const len = Math.min(N, Math.floor(Tth * 9 * sr));
    for (let k = 0; k < len; k++) {
      const t = k / sr;
      const x = (1 - t / Tth) * Math.exp(-1.5 * t / Tth);
      lp = a * lp + (1 - a) * x;
      M[k] += softClip(lp * (3.2 + size * 1.4), 1.9) * (1.1 + size * 0.5);
    }
  }

  // 5) Rolling rumble — brown noise, heavily lowpassed, with a slow random
  // undulation so the tail *rolls* across the desert instead of hissing away
  // at a constant level. Normalized by its steady-state deviation so it can't
  // swamp the report in the final normalize pass.
  {
    let b = 0, lp2 = 0, und = 0;
    const leak = 0.996;
    const stepAmp = 0.04;
    const steady = stepAmp / Math.sqrt(1 - leak * leak);
    const a = lpCoef(130, sr);
    const aUnd = lpCoef(1.6, sr);
    // one-pole noise steady-state std (uniform input, var 1/3) — normalize
    // the undulator to unit-ish deviation or the modulation depth vanishes
    const undSteady = Math.sqrt((1 - aUnd) / ((1 + aUnd) * 3));
    const start = Math.floor(0.03 * sr);
    const tail = 0.9 + size * 1.1;
    for (let i = start; i < N; i++) {
      const t = (i - start) / sr;
      b = b * leak + (rand() * 2 - 1) * stepAmp;
      lp2 = a * lp2 + (1 - a) * b;
      und = aUnd * und + (1 - aUnd) * (rand() * 2 - 1);
      const roll = 0.5 + 0.5 * Math.min(2.2, Math.abs(und / undSteady));
      const env = Math.min(1, t / 0.08) * Math.exp(-t / tail);
      M[i] += (lp2 / steady) * env * roll * 0.42;
    }
  }

  // glue: gentle tanh so the layers intermodulate like air does, then a DC
  // blocker (the pulse undershoot and brown noise both drift a little)
  let dc = 0, px = 0;
  for (let i = 0; i < N; i++) {
    const y = softClip(M[i], 1.25);
    dc = y - px + 0.9995 * dc; px = y; M[i] = dc;
  }
  normalize([M], 0.95);
  return toBuffer(ctx, [M], sr);
}

// ---------------------------------------------------------------------------
// Crackle tail — a dying rain of tiny snaps (for crackle shells)
export function renderCrackle(ctx, seed = 1, dur = 2.4) {
  const sr = ctx.sampleRate;
  const N = Math.floor(dur * sr);
  const rand = mulberry32(seed * 104729 + 7);
  const M = new Float32Array(N);

  let t = 0.02;
  while (t < dur - 0.05) {
    const rate = 20 + 480 * Math.exp(-t * 2.2); // events/sec, decaying
    t += -Math.log(1 - rand()) / rate;
    const i0 = Math.floor(t * sr);
    if (i0 >= N) break;
    // Every event is shaped noise — a sine burst reads as a metallic ding.
    // Mostly tiny bright snaps; occasionally a deeper hollow micro-boom.
    const big = rand() < 0.07;
    const tau = big ? 0.009 + rand() * 0.014 : 0.0012 + rand() * 0.003;
    const amp = (big ? 1.6 : 0.3 + rand() * 0.9) * Math.exp(-t * 0.9);
    // bandpass via difference of two one-poles, randomized per snap
    const fHi = big ? 900 + rand() * 700 : 2200 + rand() * 5000;
    const aLo = lpCoef(fHi, sr);
    const aHi = lpCoef(big ? 120 : fHi * 0.3, sr);
    let lo = 0, hi = 0;
    const len = Math.min(N - i0, Math.floor(tau * 7 * sr));
    for (let k = 0; k < len; k++) {
      const tt = k / sr;
      const x = rand() * 2 - 1;
      lo = aLo * lo + (1 - aLo) * x;
      hi = aHi * hi + (1 - aHi) * x;
      M[i0 + k] += (lo - hi) * Math.exp(-tt / tau) * amp;
    }
  }
  normalize([M], 0.7);
  return toBuffer(ctx, [M], sr);
}

// ---------------------------------------------------------------------------
// A single firecracker report, written into an existing buffer at time `at`.
// Tuned against measured cracker acoustics: the report is an N-wave — a
// near-instant overpressure spike with a rarefaction undershoot — whose
// spectator-distance energy is broad (500 Hz - 6 kHz) with a small LF thump
// underneath, the whole event over in well under 100 ms. Built from the same
// vocabulary as the shell booms (Friedlander pulse + shaped noise), just
// small, fast and BRIGHT — a cracker is close and unmuffled, unlike a shell
// 100 m up.
function addCrackerReport(M, sr, rand, at, amp) {
  const N = M.length;
  const i0 = Math.floor(at * sr);
  if (i0 >= N) return;

  // 1) the crack: a tiny Friedlander pulse with a fast, bright rise
  {
    const Tpos = 0.0012 + rand() * 0.0012;
    const a = lpCoef(2800 + rand() * 1600, sr);
    let lp = 0;
    const len = Math.min(N - i0, Math.floor(Tpos * 7 * sr));
    for (let k = 0; k < len; k++) {
      const t = k / sr;
      const x = (1 - t / Tpos) * Math.exp(-1.5 * t / Tpos);
      lp = a * lp + (1 - a) * x;
      M[i0 + k] += lp * amp * 2.6;
    }
  }

  // 2) the "tssh" edge: a burst of 1.6-7.5 kHz noise, a few ms long — this
  // brilliance is what makes the string RIP instead of thud
  {
    const tau = 0.003 + rand() * 0.004;
    const aLo = lpCoef(7500, sr), aHi = lpCoef(1600, sr);
    let lo = 0, hi = 0;
    const len = Math.min(N - i0, Math.floor(tau * 7 * sr));
    for (let k = 0; k < len; k++) {
      const t = k / sr;
      const x = rand() * 2 - 1;
      lo = aLo * lo + (1 - aLo) * x;
      hi = aHi * hi + (1 - aHi) * x;
      M[i0 + k] += (lo - hi) * Math.exp(-t / tau) * amp * 2.6;
    }
  }

  // 3) the TAH body: a slower LF-mid thump under the crack (what
  // distinguishes a real cracker from a cap gun) — present but not dominant
  {
    const Tth = 0.007 + rand() * 0.007;
    const a = lpCoef(240, sr);
    let lp = 0;
    const len = Math.min(N - i0, Math.floor(Tth * 8 * sr));
    for (let k = 0; k < len; k++) {
      const t = k / sr;
      const x = (1 - t / Tth) * Math.exp(-1.5 * t / Tth);
      lp = a * lp + (1 - a) * x;
      M[i0 + k] += lp * amp * 1.05;
    }
  }

  // 4) ground bounce: the report again, ~10-20 ms later, inverted and dark
  {
    const dt = 0.010 + rand() * 0.012;
    const j0 = i0 + Math.floor(dt * sr);
    const Tpos = 0.002 + rand() * 0.002;
    const a = lpCoef(600, sr);
    let lp = 0;
    const len = Math.min(N - j0, Math.floor(Tpos * 7 * sr));
    for (let k = 0; k < len; k++) {
      const t = k / sr;
      const x = (1 - t / Tpos) * Math.exp(-1.5 * t / Tpos);
      lp = a * lp + (1 - a) * x;
      M[j0 + k] -= lp * amp * 0.9;
    }
  }
}

// ---------------------------------------------------------------------------
// Firecracker belt at full rip — the "RRRAHTAHTAHTAH" (seamless loop).
// Matched to real celebration strings/rolls (measured rolls average ~12-25
// crackers/sec): the rate is NOT steady — braided fuse ignites crackers in
// clusters, so the storm is a modulated Poisson process with near-simultaneous
// "brrr" clusters and momentary lulls, every cracker a different loudness.
// Under the pops, the overlapped report tails pile into a rolling LF roar
// that breathes with the pop density.
export function renderFirecrackerLoop(ctx, seed = 1) {
  const sr = ctx.sampleRate;
  const fadeSec = 0.15;
  const dur = 3.4 + fadeSec;
  const N = Math.floor(dur * sr);
  const rand = mulberry32(seed * 15013 + 41);
  let M = new Float32Array(N);

  // density envelope for the roar: raised by every pop, decaying ~80 ms
  const dens = new Float32Array(N);

  // modulated Poisson rain of crackers
  let rate = 22;               // events/sec, wanders 14..32
  let t = 0.01;
  while (t < dur) {
    rate += (rand() * 2 - 1) * 6;
    rate = Math.max(14, Math.min(32, rate));
    t += -Math.log(1 - rand()) / rate;
    if (t >= dur) break;
    // per-cracker loudness: wide spread, a few standouts
    const big = rand() < 0.08;
    const amp = (big ? 1.5 + rand() * 0.5 : 0.30 + rand() * rand() * 0.85);
    addCrackerReport(M, sr, rand, t, amp);
    const di = Math.floor(t * sr);
    if (di < N) dens[di] += amp;
    // braided fuse: 25% chance the flame catches 1-3 neighbors almost
    // simultaneously — the "brrr" clusters inside the rattle
    if (rand() < 0.25) {
      const extra = 1 + (rand() * 2.2 | 0);
      for (let e = 0; e < extra; e++) {
        const te = t + 0.004 + rand() * 0.030;
        if (te < dur) {
          addCrackerReport(M, sr, rand, te, 0.3 + rand() * 0.7);
          const dj = Math.floor(te * sr);
          if (dj < N) dens[dj] += 0.5;
        }
      }
    }
  }

  // rolling roar: brown noise gated by smoothed pop density — the pile-up of
  // report tails and echo you hear as "RRRR" between the distinct TAHs
  {
    let b = 0, lp2 = 0, env = 0;
    const leak = 0.995;
    const stepAmp = 0.05;
    const steady = stepAmp / Math.sqrt(1 - leak * leak);
    const a = lpCoef(300, sr);
    const aEnv = Math.exp(-1 / (0.08 * sr)); // ~80 ms decay
    for (let i = 0; i < N; i++) {
      env = env * aEnv + dens[i];
      b = b * leak + (rand() * 2 - 1) * stepAmp;
      lp2 = a * lp2 + (1 - a) * b;
      M[i] += (lp2 / steady) * Math.min(1.4, env * 0.5) * 0.22;
    }
  }

  // glue + DC blocker (pop undershoots drift), then loop the storm
  let dc = 0, px = 0;
  for (let i = 0; i < N; i++) {
    const y = softClip(M[i], 1.2);
    dc = y - px + 0.9995 * dc; px = y; M[i] = dc;
  }
  M = makeSeamless(M, sr, fadeSec);
  normalize([M], 0.85);
  return toBuffer(ctx, [M], sr);
}

// A single stray cracker — for the sparse pops while the belt's fuse is
// still catching, accents riding the storm (played at the moving burn front
// so the rattle travels), and the last few stragglers at the end.
export function renderCrackerPop(ctx, seed = 1) {
  const sr = ctx.sampleRate;
  const N = Math.floor(0.28 * sr);
  const rand = mulberry32(seed * 5407 + 61);
  const M = new Float32Array(N);
  addCrackerReport(M, sr, rand, 0.002, 1.0);
  // a couple of paper scraps flutter down after a lone pop
  let t = 0.03;
  while (t < 0.2) {
    t += -Math.log(1 - rand()) / 40;
    const i0 = Math.floor(t * sr);
    if (i0 >= N) break;
    const tau = 0.0008 + rand() * 0.0015;
    const f = 2500 + rand() * 4500;
    const aLo = lpCoef(f, sr), aHi = lpCoef(f * 0.35, sr);
    let lo = 0, hi = 0;
    const len = Math.min(N - i0, Math.floor(tau * 7 * sr));
    for (let k = 0; k < len; k++) {
      const x = rand() * 2 - 1;
      lo = aLo * lo + (1 - aLo) * x;
      hi = aHi * hi + (1 - aHi) * x;
      M[i0 + k] += (lo - hi) * Math.exp(-(k / sr) / tau) * 0.2;
    }
  }
  let dc = 0, px = 0;
  for (let i = 0; i < N; i++) {
    const y = softClip(M[i], 1.2);
    dc = y - px + 0.9995 * dc; px = y; M[i] = dc;
  }
  normalize([M], 0.9);
  return toBuffer(ctx, [M], sr);
}

// ---------------------------------------------------------------------------
// Waterfall / niagara shell — the sustained molten-metal cascade (seamless
// loop). A real waterfall effect sounds like heavy rain frying in a skillet:
// a bright continuous hiss (thousands of burning titanium flakes), dense
// micro-crackle, and a soft mid roar underneath, all breathing slowly. No
// pops, no booms — this is the hush-with-teeth that plays while the curtain
// hangs in the sky. Distance darkening comes from the play()-side lowpass.
export function renderWaterfallLoop(ctx, seed = 1) {
  const sr = ctx.sampleRate;
  const fadeSec = 0.25;
  const dur = 3.2 + fadeSec;
  const N = Math.floor(dur * sr);
  const rand = mulberry32(seed * 9257 + 83);
  let M = new Float32Array(N);

  // slow aperiodic breathing (random walk, like the wind bed)
  let sw = 0.7, swTarget = 0.7, swTimer = 0;

  let hiss = 0, hp = 0, mid = 0, mid2 = 0;
  const aHiss = lpCoef(8200, sr);
  const aHp = lpCoef(2400, sr);
  const aMid = lpCoef(650, sr);
  for (let i = 0; i < N; i++) {
    if (--swTimer <= 0) {
      swTimer = Math.floor((0.5 + rand() * 1.2) * sr);
      swTarget = 0.55 + rand() * 0.45;
    }
    sw += (swTarget - sw) / (sr * 0.7);
    const x = rand() * 2 - 1;
    // bright frying hiss 2.4-8 kHz
    hiss = aHiss * hiss + (1 - aHiss) * x;
    hp = aHp * hp + (1 - aHp) * x;
    // soft mid roar
    mid = aMid * mid + (1 - aMid) * x;
    mid2 = aMid * mid2 + (1 - aMid) * mid;
    M[i] = (hiss - hp) * 0.85 * sw + mid2 * 1.35 * (0.5 + 0.5 * sw);
  }

  // dense molten crackle: fast Poisson rain of tiny snaps, no big events
  let t = 0;
  while (t < dur) {
    t += -Math.log(1 - rand()) / 260;
    const i0 = Math.floor(t * sr);
    if (i0 >= N) break;
    const tau = 0.0006 + rand() * 0.0018;
    const f = 2800 + rand() * 5200;
    const aLo = lpCoef(f, sr), aHi = lpCoef(f * 0.4, sr);
    const amp = 0.15 + rand() * 0.4;
    let lo = 0, hi = 0;
    const len = Math.min(N - i0, Math.floor(tau * 7 * sr));
    for (let k = 0; k < len; k++) {
      const x = rand() * 2 - 1;
      lo = aLo * lo + (1 - aLo) * x;
      hi = aHi * hi + (1 - aHi) * x;
      M[i0 + k] += (lo - hi) * Math.exp(-(k / sr) / tau) * amp;
    }
  }

  M = makeSeamless(M, sr, fadeSec);
  normalize([M], 0.5);
  return toBuffer(ctx, [M], sr);
}

// ---------------------------------------------------------------------------
// Rocket ascent — the launch "PSSHHEW". Matched to real model-rocket /
// firework-rocket liftoffs: the sound peaks essentially INSTANTLY (the motor
// comes up to pressure in milliseconds — v2's 50 ms fade-in read as a hair
// dryer, not a launch), stays at full fury only for a couple tenths of a
// second, then amplitude and brightness recede *together* as the rocket
// leaves — the sharp swoosh contour. Layers:
//   ignition spit ... one bright crackly burst right at t=0
//   turbulence bed .. granulated slices of the real CC0 explosion recordings,
//                     pitched up and tilted bright — genuinely recorded
//                     chaos that pure synthesis can't fake
//   exhaust hiss .... broadband noise through a collapsing lowpass
//                     (8 kHz at ignition -> ~1 kHz as the sky swallows it)
//   pad rumble ...... LF thrust shaking the ground, gone once it's high
//   sizzle .......... Poisson rain of propellant snaps, densest at liftoff
// Still no resonators anywhere — a swept resonance whistles like a theremin.
export function renderWhoosh(ctx, seed = 1, body = null, dur = 2.2) {
  const sr = ctx.sampleRate;
  const N = Math.floor(dur * sr);
  const rand = mulberry32(seed * 31337 + 3);
  const M = new Float32Array(N);

  // master swoosh contour: ~15 ms attack, brief peak, long powered recede
  const swoosh = (t) => {
    const n = t / dur;
    return Math.min(1, t / 0.015)
      * (n < 0.09 ? 1 : Math.pow(Math.max(0, 1 - (n - 0.09) / 0.91), 1.9));
  };

  // 1) granulated real-recording turbulence: short Hann-windowed grains from
  // the middle of the blast recording, resampled up 1.6-2.4x so the boom's
  // rumble becomes exhaust roar, overlap-added into a continuous bed
  if (body && body.length > sr * 0.4) {
    const G = new Float32Array(N);
    let tg = 0;
    while (tg < dur) {
      const gl = 0.05 * (0.7 + rand() * 0.7);
      const gN = Math.floor(gl * sr);
      const i0 = Math.floor(tg * sr);
      const rate = 1.6 + rand() * 0.8;
      const srcStart = Math.floor((0.10 + rand() * 0.55) * body.length);
      const kMax = Math.min(gN, Math.floor((body.length - 1 - srcStart) / rate), N - i0);
      for (let k = 0; k < kMax; k++) {
        const w = 0.5 - 0.5 * Math.cos(TWO_PI * k / gN); // Hann
        G[i0 + k] += body[srcStart + Math.floor(k * rate)] * w;
      }
      tg += gl * 0.45; // >2x overlap: no gaps, no flutter at grain rate
    }
    // tilt bright (remove the recording's boomy lows) and ride the contour
    let lo = 0;
    const aLo = lpCoef(650, sr);
    for (let i = 0; i < N; i++) {
      lo = aLo * lo + (1 - aLo) * G[i];
      M[i] += (G[i] - lo) * swoosh(i / sr) * 1.5;
    }
  }

  // 2) synthesized exhaust hiss with collapsing brightness
  let lp = 0, lp2 = 0, hp = 0, rum = 0, rum2 = 0, flut = 0;
  const aHp = lpCoef(420, sr);
  const aRum = lpCoef(170, sr);
  const aFlut = lpCoef(15, sr);
  // normalize the flutter to unit-ish deviation (see rumble in renderBoom)
  const flutSteady = Math.sqrt((1 - aFlut) / ((1 + aFlut) * 3));
  for (let i = 0; i < N; i++) {
    const t = i / sr;
    const n = t / dur;
    const x = rand() * 2 - 1;

    // brilliant at ignition, then air absorption + distance close it down
    const fc = 1100 + 6900 * Math.exp(-t * 2.3);
    const a = lpCoef(fc, sr);
    lp = a * lp + (1 - a) * x;
    lp2 = a * lp2 + (1 - a) * lp;
    hp = aHp * hp + (1 - aHp) * x;

    // low thrust rumble, strongest on the pad, gone once it's high up
    rum = aRum * rum + (1 - aRum) * x;
    rum2 = aRum * rum2 + (1 - aRum) * rum;

    // unsteady combustion flutter — the "brap" texture of a motor
    flut = aFlut * flut + (1 - aFlut) * x;
    const mod = 0.6 + 0.38 * Math.min(2.5, Math.abs(flut / flutSteady));

    const env = swoosh(t);
    const pad = Math.pow(Math.max(0, 1 - n / 0.5), 2); // rumble dies early
    M[i] += ((lp2 - hp) * 1.9 * mod + rum2 * 3.4 * pad) * env;
  }

  // 3) ignition spit — the sharp "psst" edge right at t=0: a fast bright
  // noise burst, distinct from the hiss bed (shorter, brighter, louder)
  {
    let lo = 0, hi = 0;
    const aLoS = lpCoef(8200, sr), aHiS = lpCoef(1400, sr);
    const end = Math.min(N, Math.floor(0.16 * sr));
    for (let i = 0; i < end; i++) {
      const t = i / sr;
      const x = rand() * 2 - 1;
      lo = aLoS * lo + (1 - aLoS) * x;
      hi = aHiS * hi + (1 - aHiS) * x;
      M[i] += (lo - hi) * Math.min(1, t / 0.004) * Math.exp(-t / 0.045) * 1.35;
    }
  }

  // 4) propellant sizzle — tiny snaps riding the exhaust, densest at liftoff
  let ts = 0.005;
  while (ts < dur * 0.8) {
    ts += -Math.log(1 - rand()) / (30 + 220 * Math.exp(-ts * 2.0));
    const i0 = Math.floor(ts * sr);
    if (i0 >= N) break;
    const tau = 0.0008 + rand() * 0.002;
    const f = 2000 + rand() * 5500;
    const aLoC = lpCoef(f, sr), aHiC = lpCoef(f * 0.35, sr);
    const amp = (0.35 + rand() * 0.75) * swoosh(ts);
    let lo = 0, hi = 0;
    const len = Math.min(N - i0, Math.floor(tau * 7 * sr));
    for (let k = 0; k < len; k++) {
      const x = rand() * 2 - 1;
      lo = aLoC * lo + (1 - aLoC) * x;
      hi = aHiC * hi + (1 - aHiC) * x;
      M[i0 + k] += (lo - hi) * Math.exp(-(k / sr) / tau) * amp;
    }
  }

  normalize([M], 0.6);
  return toBuffer(ctx, [M], sr);
}

// ---------------------------------------------------------------------------
// Mortar lift — the deep hollow "thoomp" when a shell leaves the tube:
// a muffled Friedlander pulse (muzzle blast), a saturated 145->50 Hz drop,
// and a dark noise puff of smoke and grit chasing the shell out.
export function renderLift(ctx, seed = 1) {
  const sr = ctx.sampleRate;
  const dur = 0.7;
  const N = Math.floor(dur * sr);
  const rand = mulberry32(seed * 271 + 5);
  const M = new Float32Array(N);

  // muzzle blast: band-limited blast pulse, no highs (it's aimed at the sky)
  {
    const Tpos = 0.007;
    const a = lpCoef(650, sr);
    let lpP = 0;
    const len = Math.floor(Tpos * 7 * sr);
    for (let k = 0; k < len; k++) {
      const t = k / sr;
      const x = (1 - t / Tpos) * Math.exp(-1.5 * t / Tpos);
      lpP = a * lpP + (1 - a) * x;
      M[k] += lpP * 2.4;
    }
  }

  let phase = 0, lp = 0, lp2 = 0;
  for (let i = 0; i < N; i++) {
    const t = i / sr;
    const f = 50 + 95 * Math.exp(-t * 22);
    phase += TWO_PI * f / sr;
    const env = Math.min(1, t / 0.006) * Math.exp(-t / 0.14);
    // smoke puff: dark noise, cutoff collapsing 600 -> 130 Hz
    const a = lpCoef(130 + 470 * Math.exp(-t * 18), sr);
    const x = rand() * 2 - 1;
    lp = a * lp + (1 - a) * x;
    lp2 = a * lp2 + (1 - a) * lp;
    M[i] += softClip(Math.sin(phase) * 1.9, 1.7) * env * 0.9 + lp2 * env * 4.5;
  }
  normalize([M], 0.9);
  return toBuffer(ctx, [M], sr);
}

// ---------------------------------------------------------------------------
// Burning fuse — sputtering sparkler hiss (seamless loop)
export function renderFuseLoop(ctx, seed = 1) {
  const sr = ctx.sampleRate;
  const dur = 1.4;
  const N = Math.floor(dur * sr);
  const rand = mulberry32(seed * 911 + 77);
  let M = new Float32Array(N);

  // dense micro-pops
  let t = 0;
  while (t < dur) {
    t += -Math.log(1 - rand()) / 620;
    const i0 = Math.floor(t * sr);
    if (i0 >= N) break;
    const tau = 0.0004 + rand() * 0.0012;
    const amp = 0.2 + rand() * 0.8;
    const f = 2500 + rand() * 6000;
    const len = Math.min(N - i0, Math.floor(tau * 6 * sr));
    for (let k = 0; k < len; k++) {
      const tt = k / sr;
      M[i0 + k] += Math.sin(TWO_PI * f * tt) * Math.exp(-tt / tau) * amp;
    }
  }
  // hiss bed
  let lp = 0;
  for (let i = 0; i < N; i++) {
    const x = rand() * 2 - 1;
    lp = 0.7 * lp + 0.3 * x;
    M[i] += (x - lp) * 0.22 * (0.8 + 0.2 * Math.sin(TWO_PI * i / sr * 13));
  }
  M = makeSeamless(M, sr);
  normalize([M], 0.5);
  return toBuffer(ctx, [M], sr);
}

// ---------------------------------------------------------------------------
// Fountain — sustained pressurized spray with sparkle (seamless loop)
export function renderFountainLoop(ctx, seed = 1) {
  const sr = ctx.sampleRate;
  const dur = 2.6;
  const N = Math.floor(dur * sr);
  const rand = mulberry32(seed * 4241 + 9);
  let M = new Float32Array(N);

  let lp = 0, bp1 = 0, bp2 = 0;
  const a = lpCoef(5200, sr);
  for (let i = 0; i < N; i++) {
    const x = rand() * 2 - 1;
    lp = a * lp + (1 - a) * x;
    // slow breathing of the jet
    const breathe = 0.75 + 0.25 * Math.sin(TWO_PI * i / sr * 0.9 + seed);
    M[i] = lp * 0.9 * breathe;
    // resonant low "pressure" tone
    const y = 1.988 * Math.cos(TWO_PI * 130 / sr) * bp1 - 0.988 * bp2 + x * 0.004;
    bp2 = bp1; bp1 = y;
    M[i] += y * 0.35;
  }
  // sparkle crackles
  let t = 0;
  while (t < dur) {
    t += -Math.log(1 - rand()) / 90;
    const i0 = Math.floor(t * sr);
    if (i0 >= N) break;
    const tau = 0.001 + rand() * 0.003;
    const f = 3000 + rand() * 5000;
    const amp = 0.3 + rand() * 0.6;
    const len = Math.min(N - i0, Math.floor(tau * 6 * sr));
    for (let k = 0; k < len; k++) {
      const tt = k / sr;
      M[i0 + k] += Math.sin(TWO_PI * f * tt) * Math.exp(-tt / tau) * amp;
    }
  }
  M = makeSeamless(M, sr);
  normalize([M], 0.55);
  return toBuffer(ctx, [M], sr);
}

// ---------------------------------------------------------------------------
// Pinwheel whirl — the swishing roar of drivers whipping past (seamless
// loop). Rendered at a fixed swish rate; the game scales playbackRate with
// the wheel's spin speed, so slow lazy swishes at ignition wind up into a
// fast bright whirl at full spin — pitch and swish rate rise together, the
// way the real thing does. Content is one exhaust hiss whose loudness AND
// brightness pump with each driver pass (a swish is a brightness event, not
// just a volume event), over a faint continuous jet bed. As everywhere else:
// shaped noise only, no resonators.
export function renderPinwheelLoop(ctx, seed = 1) {
  const sr = ctx.sampleRate;
  const fadeSec = 0.12;
  const period = 1.6;          // trimmed loop length after makeSeamless
  const dur = period + fadeSec;
  const N = Math.floor(dur * sr);
  const rand = mulberry32(seed * 6871 + 19);
  let M = new Float32Array(N);

  // 8 swishes per period — every periodic component must repeat with the
  // trimmed length or the crossfade leaves an audible AM hiccup at the seam
  const swishRate = 8 / period;

  let lp = 0, lp2 = 0, hp = 0, rum = 0;
  const aHp = lpCoef(520, sr);
  const aRum = lpCoef(160, sr);
  for (let i = 0; i < N; i++) {
    const t = i / sr;
    const x = rand() * 2 - 1;
    // swish envelope: sharpened half-sine peaks — whoosh, not helicopter chop
    const u = (t * swishRate) % 1;
    const s = Math.sin(Math.PI * u);
    const swish = s * s * s;
    // brightness rides the swish: dull tail, brilliant as the driver passes
    const a = lpCoef(750 + 4200 * swish, sr);
    lp = a * lp + (1 - a) * x;
    lp2 = a * lp2 + (1 - a) * lp;
    hp = aHp * hp + (1 - aHp) * x;
    // faint LF thrust flutter underneath, also pumping with the pass
    rum = aRum * rum + (1 - aRum) * x;
    M[i] = (lp2 - hp) * (0.35 + 1.7 * swish) + rum * 1.3 * (0.3 + 0.7 * swish);
  }

  // propellant sizzle riding the jet — stationary rain, loop-safe as-is
  let ts = 0;
  while (ts < dur) {
    ts += -Math.log(1 - rand()) / 110;
    const i0 = Math.floor(ts * sr);
    if (i0 >= N) break;
    const tau = 0.0008 + rand() * 0.002;
    const f = 2400 + rand() * 5200;
    const aLoC = lpCoef(f, sr), aHiC = lpCoef(f * 0.35, sr);
    const amp = 0.25 + rand() * 0.5;
    let lo = 0, hi = 0;
    const len = Math.min(N - i0, Math.floor(tau * 7 * sr));
    for (let k = 0; k < len; k++) {
      const xx = rand() * 2 - 1;
      lo = aLoC * lo + (1 - aLoC) * xx;
      hi = aHiC * hi + (1 - aHiC) * xx;
      M[i0 + k] += (lo - hi) * Math.exp(-(k / sr) / tau) * amp;
    }
  }

  M = makeSeamless(M, sr, fadeSec);
  normalize([M], 0.55);
  return toBuffer(ctx, [M], sr);
}

// ---------------------------------------------------------------------------
// The Colossus — the monumental fire-wheel's driver banks at full burn
// (seamless loop). This is NOT the hand pinwheel scaled up: at a hundred
// meters of wheel there is no swish-swish, just the massed roar of many
// rocket motors — a rocket-test-stand rumble. Anatomy: a deep brown-noise
// mass with two slow undulations riding it (integer cycles per loop so the
// seam can't hiccup), a mid "furnace breath" band, and a sparse sizzle of
// burning composition. The game scales gain with how many banks are lit and
// walks a lowpass with listener distance, so from camp it's a soft mountain
// of bass and up close it's a furnace.
export function renderColossusLoop(ctx, seed = 1) {
  const sr = ctx.sampleRate;
  const fadeSec = 0.25;
  const period = 3.2;            // trimmed loop length after makeSeamless
  const dur = period + fadeSec;
  const N = Math.floor(dur * sr);
  const rand = mulberry32(seed * 9377 + 41);
  let M = new Float32Array(N);

  // undulators must complete whole cycles over the trimmed period
  const f1 = 2 / period, f2 = 7 / period;
  const ph1 = rand() * TWO_PI, ph2 = rand() * TWO_PI;

  let b = 0, lpDeep = 0, mid1 = 0, mid2 = 0, hpMid = 0;
  const leak = 0.997;
  const aDeep = lpCoef(110, sr);
  const aMid = lpCoef(620, sr);
  const aHpMid = lpCoef(170, sr);
  for (let i = 0; i < N; i++) {
    const t = i / sr;
    const x = rand() * 2 - 1;
    // the mass: leaky-integrated (brown) noise, lowpassed hard
    b = b * leak + x * 0.05;
    lpDeep = aDeep * lpDeep + (1 - aDeep) * b;
    // slow rolling of the whole bank — two incommensurate-feeling rates
    const roll = 0.72 + 0.20 * Math.sin(TWO_PI * f1 * t + ph1)
      + 0.12 * Math.sin(TWO_PI * f2 * t + ph2);
    // furnace breath: a 170-620 Hz band that flutters faster than the roll
    mid1 = aMid * mid1 + (1 - aMid) * x;
    mid2 = aMid * mid2 + (1 - aMid) * mid1;
    hpMid = aHpMid * hpMid + (1 - aHpMid) * mid2;
    M[i] = lpDeep * 9.0 * roll + (mid2 - hpMid) * 1.1 * (0.55 + 0.45 * roll);
  }

  // composition sizzle: stationary Poisson rain of tiny bright snaps —
  // loop-safe as-is, and what tells your ear "burning metal", not "wind"
  let ts = 0;
  while (ts < dur) {
    ts += -Math.log(1 - rand()) / 70;
    const i0 = Math.floor(ts * sr);
    if (i0 >= N) break;
    const tau = 0.0008 + rand() * 0.0025;
    const f = 2100 + rand() * 4800;
    const aLoC = lpCoef(f, sr), aHiC = lpCoef(f * 0.32, sr);
    const amp = (0.10 + rand() * 0.22);
    let lo = 0, hi = 0;
    const len = Math.min(N - i0, Math.floor(tau * 7 * sr));
    for (let k = 0; k < len; k++) {
      const xx = rand() * 2 - 1;
      lo = aLoC * lo + (1 - aLoC) * xx;
      hi = aHiC * hi + (1 - aHiC) * xx;
      M[i0 + k] += (lo - hi) * Math.exp(-(k / sr) / tau) * amp;
    }
  }

  M = makeSeamless(M, sr, fadeSec);
  normalize([M], 0.6);
  return toBuffer(ctx, [M], sr);
}

// ---------------------------------------------------------------------------
// Colossus bearing groan — a hundred tons easing over a plain bearing. A
// two-pole resonance swept slowly DOWN (mass settling, never up — up reads
// as a question mark) over stick-slip brown noise: the drive is gated at a
// slipping rate that itself decelerates, which is what a heavy shaft
// actually sounds like as it grabs. Ends in a soft wooden settle. Played
// only near the wheel, quiet, rate-randomized.
export function renderGroan(ctx, seed = 1) {
  const sr = ctx.sampleRate;
  const dur = 1.7;
  const N = Math.floor(dur * sr);
  const rand = mulberry32(seed * 5501 + 77);
  const M = new Float32Array(N);

  const f0 = 150 + rand() * 60;   // start pitch of the complaint
  const f1 = 55 + rand() * 20;    // where it settles
  let y1 = 0, y2 = 0, b = 0, lp = 0;
  const aDrv = lpCoef(900, sr);
  let slipPhase = rand();
  // pass 1: the raw ring. A two-pole this low has enormous, sweep-dependent
  // gain, so level is set afterward by measuring — clipping the raw ring
  // flattens the whole groan into a kazoo plateau.
  let rawPeak = 1e-6;
  for (let i = 0; i < N; i++) {
    const t = i / sr;
    const n = t / dur;
    // stick-slip gate: pulse train decelerating 13 -> 5 Hz, soft-edged
    const slipRate = 13 - 8 * n;
    slipPhase += slipRate / sr;
    const g = Math.pow(0.5 + 0.5 * Math.sin(TWO_PI * slipPhase), 3.0);
    // drive: brown-ish noise, gated by the slipping
    b = b * 0.995 + (rand() * 2 - 1) * 0.06;
    lp = aDrv * lp + (1 - aDrv) * b;
    const drive = lp * (0.25 + 0.75 * g) * 0.01;
    // swept resonance (modest r — a violin-tight Q would ring metallic)
    const fc = f0 + (f1 - f0) * Math.min(1, n * 1.4);
    const r = 0.988;
    const th = TWO_PI * fc / sr;
    const y = 2 * r * Math.cos(th) * y1 - r * r * y2 + drive;
    y2 = y1; y1 = y;
    M[i] = y;
    const ab = Math.abs(y);
    if (ab > rawPeak) rawPeak = ab;
  }
  // pass 2: mild saturation at a known level, THEN the envelope — it leans
  // in, complains, and dies before the buffer does
  for (let i = 0; i < N; i++) {
    const t = i / sr;
    const env = Math.min(1, t / 0.14) * Math.exp(-Math.max(0, t - 0.9) / 0.28);
    M[i] = softClip((M[i] / rawPeak) * 1.25, 1.1) * env;
  }
  // the settle: one soft low knock as the load comes to rest
  {
    const i0 = Math.floor((dur - 0.45) * sr);
    const a = lpCoef(190, sr);
    let k1 = 0;
    for (let k = 0; k < Math.floor(0.12 * sr) && i0 + k < N; k++) {
      const t = k / sr;
      k1 = a * k1 + (1 - a) * (rand() * 2 - 1);
      M[i0 + k] += k1 * Math.exp(-t / 0.03) * 1.1;
    }
  }
  normalize([M], 0.5);
  return toBuffer(ctx, [M], sr);
}

// ---------------------------------------------------------------------------
// Roman candle / cake single shot — compact "pop-foomp": a small quick blast
// pulse with a breathy mid puff behind it. Snappier and brighter than the
// mortar lift, but still all pressure and air, no ringing.
export function renderShot(ctx, seed = 1) {
  const sr = ctx.sampleRate;
  const dur = 0.5;
  const N = Math.floor(dur * sr);
  const rand = mulberry32(seed * 631 + 21);
  const M = new Float32Array(N);

  // pop: small fast blast pulse, brighter than the mortar's
  {
    const Tpos = 0.0035;
    const a = lpCoef(1300, sr);
    let lpP = 0;
    const len = Math.floor(Tpos * 7 * sr);
    for (let k = 0; k < len; k++) {
      const t = k / sr;
      const x = (1 - t / Tpos) * Math.exp(-1.5 * t / Tpos);
      lpP = a * lpP + (1 - a) * x;
      M[k] += lpP * 2.2;
    }
  }

  let phase = 0, lp = 0, lp2 = 0;
  for (let i = 0; i < N; i++) {
    const t = i / sr;
    const f = 70 + 170 * Math.exp(-t * 38);
    phase += TWO_PI * f / sr;
    const env = Math.min(1, t / 0.004) * Math.exp(-t / 0.07);
    const a = lpCoef(200 + 800 * Math.exp(-t * 30), sr);
    const x = rand() * 2 - 1;
    lp = a * lp + (1 - a) * x;
    lp2 = a * lp2 + (1 - a) * lp;
    M[i] += softClip(Math.sin(phase) * 1.6, 1.6) * env * 0.7 + lp2 * env * 3.6;
  }
  normalize([M], 0.85);
  return toBuffer(ctx, [M], sr);
}

// ---------------------------------------------------------------------------
// Torch flame — low fluttering fire loop
export function renderTorchLoop(ctx, seed = 1) {
  const sr = ctx.sampleRate;
  const dur = 2.2;
  const N = Math.floor(dur * sr);
  const rand = mulberry32(seed * 149 + 31);
  let M = new Float32Array(N);
  let lp = 0, lp2 = 0;
  const a = lpCoef(700, sr);
  const a2 = lpCoef(60, sr);
  for (let i = 0; i < N; i++) {
    const x = rand() * 2 - 1;
    lp = a * lp + (1 - a) * x;
    lp2 = a2 * lp2 + (1 - a2) * x; // slow flutter
    M[i] = lp * (0.5 + 2.2 * Math.abs(lp2));
    if (rand() < 0.0012) M[i] += (rand() * 2 - 1) * 0.5; // fire snaps
  }
  M = makeSeamless(M, sr);
  normalize([M], 0.4);
  return toBuffer(ctx, [M], sr);
}

// ---------------------------------------------------------------------------
// Desert night wind — barely-there ambience bed (seamless loop).
// Deliberately aperiodic: sinusoidal amplitude swells read as ocean surf, so
// gusts come from a slow random walk instead, with a faintly whistling
// band resonance that drifts around and a dry, high "sand hiss" on top.
export function renderWindLoop(ctx, seed = 1) {
  const sr = ctx.sampleRate;
  const dur = 9.0;
  const N = Math.floor(dur * sr);
  const rand = mulberry32(seed * 51 + 2);
  let L = new Float32Array(N);
  let R = new Float32Array(N);

  let lpL = 0, lpR = 0, hpL = 0, hpR = 0;
  const a = lpCoef(380, sr);
  const aHiss = lpCoef(2600, sr);

  // slow aperiodic gust level: heavily-smoothed random walk, kept in [0.35,1]
  let gust = 0.6, gustTarget = 0.6, gustTimer = 0;
  // drifting whistle resonance
  let wf = 500, wfTarget = 500, y1L = 0, y2L = 0, y1R = 0, y2R = 0;

  for (let i = 0; i < N; i++) {
    if (--gustTimer <= 0) {
      gustTimer = Math.floor((0.8 + rand() * 2.5) * sr);
      gustTarget = 0.35 + rand() * 0.65;
      wfTarget = 380 + rand() * 420;
    }
    gust += (gustTarget - gust) / (sr * 1.4);
    wf += (wfTarget - wf) / (sr * 2.0);

    const xL = rand() * 2 - 1, xR = rand() * 2 - 1;
    // low airy body
    lpL = a * lpL + (1 - a) * xL;
    lpR = a * lpR + (1 - a) * xR;
    // faint whistle: two-pole resonator with drifting center
    const r = 0.994;
    const th = TWO_PI * wf / sr;
    const yL = 2 * r * Math.cos(th) * y1L - r * r * y2L + xL * 0.012;
    y2L = y1L; y1L = yL;
    const yR = 2 * r * Math.cos(th * 1.02) * y1R - r * r * y2R + xR * 0.012;
    y2R = y1R; y1R = yR;
    // dry sand hiss, stronger in gusts
    hpL = aHiss * hpL + (1 - aHiss) * xL;
    hpR = aHiss * hpR + (1 - aHiss) * xR;
    const hissL = (xL - hpL) * 0.10 * gust * gust;
    const hissR = (xR - hpR) * 0.10 * gust * gust;

    L[i] = (lpL * 0.8 + yL * 0.5) * gust + hissL;
    R[i] = (lpR * 0.8 + yR * 0.5) * gust + hissR;
  }
  L = makeSeamless(L, sr, 0.8);
  R = makeSeamless(R, sr, 0.8);
  const n = Math.min(L.length, R.length);
  normalize([L, R], 0.5);
  return toBuffer(ctx, [L.subarray(0, n), R.subarray(0, n)], sr);
}

// ---------------------------------------------------------------------------
// Small foley: planting a stick in sand, and picking something up
export function renderThud(ctx, seed = 1) {
  const sr = ctx.sampleRate;
  const N = Math.floor(0.16 * sr);
  const rand = mulberry32(seed * 17 + 4);
  const M = new Float32Array(N);
  let lp = 0;
  const a = lpCoef(260, sr);
  for (let i = 0; i < N; i++) {
    const t = i / sr;
    lp = a * lp + (1 - a) * (rand() * 2 - 1);
    M[i] = lp * Math.exp(-t / 0.035) * 2.0;
  }
  normalize([M], 0.6);
  return toBuffer(ctx, [M], sr);
}

export function renderTick(ctx, seed = 1) {
  const sr = ctx.sampleRate;
  const N = Math.floor(0.05 * sr);
  const rand = mulberry32(seed * 23 + 6);
  const M = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const t = i / sr;
    M[i] = (rand() * 2 - 1) * Math.exp(-t / 0.006) * Math.sin(TWO_PI * 1800 * t);
  }
  normalize([M], 0.35);
  return toBuffer(ctx, [M], sr);
}

// ---------------------------------------------------------------------------
// Prop foley bank — the hand-scale sounds (crate handling, stakes, torch
// swings, box knocks). Same laws as the pyro: every contact is shaped
// noise, resonators only where a real cavity actually rings (knock, creak)
// and then at wooden Q, buffers kept tiny — these live in the hands.

// Paper/cardboard rustle — handling a shell wrap or crate flap. Physics:
// paper moving is a chain of micro-buckling events — each crease snaps
// through in under 2 ms and radiates one bright click — riding a broadband
// friction hiss that swells with every hand move. Two-three distinct moves
// per take so it reads as handling, not steady static.
export function renderRustle(ctx, seed = 1) {
  const sr = ctx.sampleRate;
  const dur = 0.72;
  const N = Math.floor(dur * sr);
  const rand = mulberry32(seed * 20101 + 11);
  const M = new Float32Array(N);
  // 2-3 hand moves: soft humps the whole texture rides. The first is
  // pinned near t=0 — this plays on grab, and a grab that answers 200 ms
  // late reads as broken, not casual.
  const nm = 2 + (rand() * 2 | 0);
  const step = (dur * 0.8) / nm;
  const moves = [];
  for (let m = 0; m < nm; m++) {
    moves.push({ at: 0.02 + m * step + rand() * step * 0.35, w: 0.11 + rand() * 0.13 });
  }
  const env = (t) => {
    let e = 0.05; // faint contact bed between moves
    for (const mv of moves) {
      const u = (t - mv.at) / mv.w;
      if (u > 0 && u < 1) e = Math.max(e, Math.pow(Math.sin(Math.PI * u), 1.6));
    }
    return e;
  };
  // friction hiss: 900 Hz - 5.2 kHz band, gated by the moves
  let lo = 0, hi = 0;
  const aLo = lpCoef(5200, sr), aHi = lpCoef(900, sr);
  for (let i = 0; i < N; i++) {
    const x = rand() * 2 - 1;
    lo = aLo * lo + (1 - aLo) * x;
    hi = aHi * hi + (1 - aHi) * x;
    M[i] = (lo - hi) * env(i / sr) * 0.42;
  }
  // crease snaps: Poisson micro-clicks, only while a move is in progress
  let t = 0.02;
  while (t < dur - 0.03) {
    t += -Math.log(1 - rand()) / 150;
    const e = env(t);
    if (e < 0.16) continue; // creases only happen while the hand moves
    const i0 = Math.floor(t * sr);
    if (i0 >= N) break;
    const tau = 0.0007 + rand() * 0.0016;
    const f = 1800 + rand() * 4400;
    const aL = lpCoef(f, sr), aH = lpCoef(f * 0.35, sr);
    const amp = (0.35 + rand() * 0.8) * e;
    let l2 = 0, h2 = 0;
    const len = Math.min(N - i0, Math.floor(tau * 7 * sr));
    for (let k = 0; k < len; k++) {
      const xx = rand() * 2 - 1;
      l2 = aL * l2 + (1 - aL) * xx;
      h2 = aH * h2 + (1 - aH) * xx;
      M[i0 + k] += (l2 - h2) * Math.exp(-(k / sr) / tau) * amp;
    }
  }
  normalize([M], 0.5);
  return toBuffer(ctx, [M], sr);
}

// Stick pushed into coarse sand — the detonator stake, a mortar re-set.
// Physics: grain jamming — hundreds of micro stick-slip fractures as the
// grains lock and shear (a dense 1.5-5 kHz crush whose event rate dies as
// the stick stops) over a damped LF push from the ground taking the load,
// with a 300-1100 Hz shear grind between them. Body first, fizz on top —
// a crunch with no low half is just a click.
export function renderCrunch(ctx, seed = 1) {
  const sr = ctx.sampleRate;
  const dur = 0.38;
  const N = Math.floor(dur * sr);
  const rand = mulberry32(seed * 24239 + 29);
  const M = new Float32Array(N);
  // ground push + mid grind, one pass: both rise a few ms, decay together
  let lp = 0, glo = 0, ghi = 0;
  const aTh = lpCoef(230, sr);
  const aGl = lpCoef(1100, sr), aGh = lpCoef(300, sr);
  for (let i = 0; i < N; i++) {
    const t = i / sr;
    const x = rand() * 2 - 1;
    lp = aTh * lp + (1 - aTh) * x;
    glo = aGl * glo + (1 - aGl) * x;
    ghi = aGh * ghi + (1 - aGh) * x;
    const rise = Math.min(1, t / 0.008);
    M[i] = lp * rise * Math.exp(-t / 0.055) * 2.6
      + (glo - ghi) * rise * Math.exp(-t / 0.09) * 0.75;
  }
  // grain crush: Poisson micro-snaps, ~1400/s at contact dying to nothing
  let t = 0.002;
  while (t < dur) {
    t += -Math.log(1 - rand()) / (90 + 1400 * Math.exp(-t * 14));
    const i0 = Math.floor(t * sr);
    if (i0 >= N) break;
    const tau = 0.0005 + rand() * 0.0016;
    const f = 1500 + rand() * 3500;
    const aL = lpCoef(f, sr), aH = lpCoef(f * 0.3, sr);
    const amp = (0.25 + rand() * 0.65) * Math.exp(-t * 7);
    let lo = 0, hi = 0;
    const len = Math.min(N - i0, Math.floor(tau * 7 * sr));
    for (let k = 0; k < len; k++) {
      const xx = rand() * 2 - 1;
      lo = aL * lo + (1 - aL) * xx;
      hi = aH * hi + (1 - aH) * xx;
      M[i0 + k] += (lo - hi) * Math.exp(-(k / sr) / tau) * amp;
    }
  }
  normalize([M], 0.65);
  return toBuffer(ctx, [M], sr);
}

// Hollow wood / cardboard knock — knuckles on the TNT box or a crate lid.
// Physics: the impact itself is a lowpassed thump (skin, not box); the
// "hollow" is the cavity answering on one low mode plus a weak inharmonic
// second. Wooden Q only (τ ≈ 50 ms — the groan precedent): tighter rings
// like a marimba bar, and a knock is over in a tenth of a second.
export function renderKnock(ctx, seed = 1) {
  const sr = ctx.sampleRate;
  const dur = 0.22;
  const N = Math.floor(dur * sr);
  const rand = mulberry32(seed * 30011 + 17);
  const M = new Float32Array(N);
  // impact thump, kept as the resonator drive too
  const drive = new Float32Array(Math.floor(0.012 * sr));
  {
    let lp = 0;
    const a = lpCoef(500, sr);
    for (let i = 0; i < drive.length; i++) {
      lp = a * lp + (1 - a) * (rand() * 2 - 1);
      drive[i] = lp * Math.exp(-(i / sr) / 0.004);
    }
  }
  // cavity answer: two damped modes rung by the thump. A low two-pole has
  // enormous drive-dependent gain, so ring first, measure, then scale —
  // clipping the raw ring flattens the knock into a held square (the same
  // trap the groan documents).
  const f0 = 115 + rand() * 75;
  const ring = new Float32Array(N);
  const modes = [[f0, 1.0, 0.05], [f0 * (2.3 + rand() * 0.6), 0.22, 0.024]];
  let rawPeak = 1e-6;
  for (const [fm, g, tau] of modes) {
    const r = Math.exp(-1 / (tau * sr));
    const th = TWO_PI * fm / sr;
    let y1 = 0, y2 = 0;
    for (let i = 0; i < N; i++) {
      const y = 2 * r * Math.cos(th) * y1 - r * r * y2 + (i < drive.length ? drive[i] : 0);
      y2 = y1; y1 = y;
      ring[i] += y * g;
      const ab = Math.abs(ring[i]);
      if (ab > rawPeak) rawPeak = ab;
    }
  }
  // thump on top of the scaled ring, gentle glue, die inside the buffer
  for (let i = 0; i < N; i++) {
    const t = i / sr;
    const x = (ring[i] / rawPeak) * 1.05 + (i < drive.length ? drive[i] * 2.2 : 0);
    M[i] = softClip(x, 1.25) * Math.exp(-Math.max(0, t - 0.02) / 0.055);
  }
  normalize([M], 0.6);
  return toBuffer(ctx, [M], sr);
}

// Torch swing — a short air whoosh. Physics: the flame head dragged
// through air is turbulence whose loudness AND brightness rise with tip
// speed (a swish is a brightness event — same law as the pinwheel), on a
// hump that eases in and decelerates into the catch, with the flame's own
// slow flutter riding it.
export function renderSwing(ctx, seed = 1) {
  const sr = ctx.sampleRate;
  const dur = 0.42;
  const N = Math.floor(dur * sr);
  const rand = mulberry32(seed * 40093 + 53);
  const M = new Float32Array(N);
  const peak = 0.38 + rand() * 0.16; // where the arc is fastest
  let lp = 0, lp2 = 0, hp = 0, flut = 0;
  const aHp = lpCoef(240, sr);
  const aFl = lpCoef(26, sr);
  const flutSteady = Math.sqrt((1 - aFl) / ((1 + aFl) * 3));
  for (let i = 0; i < N; i++) {
    const u = (i / sr) / dur;
    // tip speed: slow wind-up, brisk recede
    const v = u < peak ? Math.pow(u / peak, 1.7)
      : Math.pow(Math.max(0, 1 - (u - peak) / (1 - peak)), 1.35);
    const x = rand() * 2 - 1;
    const a = lpCoef(480 + 2700 * v, sr); // brightness rides the speed
    lp = a * lp + (1 - a) * x;
    lp2 = a * lp2 + (1 - a) * lp;
    hp = aHp * hp + (1 - aHp) * x;
    flut = aFl * flut + (1 - aFl) * x;
    const mod = 0.72 + 0.28 * Math.min(2.2, Math.abs(flut / flutSteady));
    M[i] = (lp2 - hp) * (0.08 + v) * mod * 1.6;
  }
  normalize([M], 0.5);
  return toBuffer(ctx, [M], sr);
}

// Firework riser whistle. Physics: whistle mix burning in a tube is an
// organ pipe whose resonating gas column LENGTHENS as the charge burns
// down, so pitch falls through the flight; combustion is unsteady, so
// pitch and level both warble at ~9-14 Hz, deepening as the motor dies.
// Tone is a slightly-saturated sine + weak partials with breath noise
// tracking the fundamental — a bare sine reads as a test oscillator. (The
// no-resonator law targets transients; a 2 s sustained tone IS the event.)
// Seeds land the three variants at ~1.7/2.2/2.7 s.
export function renderWhistle(ctx, seed = 1) {
  const sr = ctx.sampleRate;
  const rand = mulberry32(seed * 50021 + 71);
  const dur = 1.6 + ((seed - 1) % 3) * 0.5 + rand() * 0.25;
  const N = Math.floor(dur * sr);
  const M = new Float32Array(N);
  const f0 = 2350 + rand() * 650; // shriek start
  const f1 = 780 + rand() * 220;  // dying moan
  let phase = 0, vib = 0, drift = 0, bn = 0, bh = 0;
  const aDrift = lpCoef(1.3, sr); // slow random pitch wander
  const driftSteady = Math.sqrt((1 - aDrift) / ((1 + aDrift) * 3));
  const vibHz = 9 + rand() * 4;
  for (let i = 0; i < N; i++) {
    const t = i / sr;
    const u = t / dur;
    // exponential glide, holding early and falling harder late
    const glide = Math.pow(f1 / f0, Math.pow(u, 1.15));
    drift = aDrift * drift + (1 - aDrift) * (rand() * 2 - 1);
    vib += TWO_PI * (vibHz + 3 * u) / sr;
    const depth = 0.006 + 0.045 * u * u; // warble deepens as it dies
    const f = f0 * glide * (1 + depth * Math.sin(vib) + 0.01 * (drift / driftSteady) * u);
    phase += TWO_PI * f / sr;
    // breath: narrow noise band riding the fundamental
    const aB = lpCoef(f * 1.15, sr), aH = lpCoef(f * 0.6, sr);
    const x = rand() * 2 - 1;
    bn = aB * bn + (1 - aB) * x;
    bh = aH * bh + (1 - aH) * x;
    // envelope: 30 ms attack, easy sustain, spent-motor die-off
    const env = Math.min(1, t / 0.03)
      * (u < 0.86 ? 1 : Math.pow(Math.max(0, 1 - (u - 0.86) / 0.14), 1.6))
      * (1 - 0.22 * u);
    const tremolo = 1 - (0.10 + 0.22 * u) * (0.5 + 0.5 * Math.sin(vib - 0.9));
    const tone = softClip(
      Math.sin(phase) + 0.16 * Math.sin(2 * phase) + 0.05 * Math.sin(3 * phase), 1.35);
    M[i] = (tone * 0.85 + (bn - bh) * 0.5) * env * tremolo;
  }
  normalize([M], 0.55);
  return toBuffer(ctx, [M], sr);
}

// Wood creak — the detonator handle or a crate lid easing over. Physics:
// stick-slip at a dry wooden joint — friction pulses at a decelerating
// 16→7 Hz feeding a small wooden mode that settles DOWN a little as the
// joint gives. The colossus groan's law, two octaves lighter and a tenth
// the mass; same measure-then-scale pass so the ring can't clip flat.
export function renderCreak(ctx, seed = 1) {
  const sr = ctx.sampleRate;
  const dur = 0.8;
  const N = Math.floor(dur * sr);
  const rand = mulberry32(seed * 60013 + 91);
  const M = new Float32Array(N);
  const f0 = 310 + rand() * 130; // start of the complaint
  const f1 = 180 + rand() * 60;  // where it settles
  let y1 = 0, y2 = 0, b = 0, lp = 0, slipPhase = rand();
  const aDrv = lpCoef(1300, sr);
  let rawPeak = 1e-6;
  for (let i = 0; i < N; i++) {
    const t = i / sr;
    const n = t / dur;
    // stick-slip gate: soft pulse train decelerating as the joint grabs
    slipPhase += (16 - 9 * n) / sr;
    const g = Math.pow(0.5 + 0.5 * Math.sin(TWO_PI * slipPhase), 3.5);
    b = b * 0.993 + (rand() * 2 - 1) * 0.07;
    lp = aDrv * lp + (1 - aDrv) * b;
    const drive = lp * (0.2 + 0.8 * g) * 0.01;
    const fc = f0 + (f1 - f0) * Math.min(1, n * 1.3);
    const r = 0.9905; // wooden, not violin
    const th = TWO_PI * fc / sr;
    const y = 2 * r * Math.cos(th) * y1 - r * r * y2 + drive;
    y2 = y1; y1 = y;
    M[i] = y;
    const ab = Math.abs(y);
    if (ab > rawPeak) rawPeak = ab;
  }
  for (let i = 0; i < N; i++) {
    const t = i / sr;
    const env = Math.min(1, t / 0.06) * Math.exp(-Math.max(0, t - 0.5) / 0.12);
    M[i] = softClip((M[i] / rawPeak) * 1.2, 1.1) * env;
  }
  normalize([M], 0.45);
  return toBuffer(ctx, [M], sr);
}

// ---------------------------------------------------------------------------
// Impulse response for the shared reverb: wide-open desert with distant
// rock faces — sparse discrete slapbacks plus a soft diffuse tail.
export function renderDesertIR(ctx) {
  const sr = ctx.sampleRate;
  const dur = 4.2;
  const N = Math.floor(dur * sr);
  const rand = mulberry32(424243);
  const L = new Float32Array(N);
  const R = new Float32Array(N);

  // direct-ish head so dry/wet blend stays coherent
  L[0] = 0.12; R[0] = 0.12;

  // Distant echoes off canyon walls / mesas. These must be diffuse washes —
  // a cluster of discrete impulses turns every boom into a granular "brrrp"
  // rattle (one of the things that read as tin). Each echo is a soft-edged
  // burst of dark noise, wider and darker the farther the wall.
  const slaps = [
    { t: 0.45, g: 0.30, w: 0.10, fc: 900 }, { t: 0.78, g: 0.22, w: 0.16, fc: 700 },
    { t: 1.25, g: 0.15, w: 0.24, fc: 520 }, { t: 1.9, g: 0.09, w: 0.34, fc: 400 },
    { t: 2.6, g: 0.055, w: 0.45, fc: 320 },
  ];
  for (const { t, g, w, fc } of slaps) {
    const i0 = Math.floor(t * sr);
    const len = Math.min(N - i0, Math.floor(w * sr));
    const pan = 0.25 + rand() * 0.5;
    const a = lpCoef(fc, sr);
    let nL = 0, nR = 0;
    for (let k = 0; k < len; k++) {
      const u = k / len;
      // fast rise, long soft fall
      const env = Math.min(1, u / 0.12) * (1 - u) * (1 - u);
      nL = a * nL + (1 - a) * (rand() * 2 - 1);
      nR = a * nR + (1 - a) * (rand() * 2 - 1);
      L[i0 + k] += nL * env * g * 3.2 * (1 - pan * 0.7);
      R[i0 + k] += nR * env * g * 3.2 * (0.3 + pan * 0.7);
    }
  }

  // diffuse tail, lowpassed (air absorption over distance)
  let lpL = 0, lpR = 0;
  const a = lpCoef(1400, sr);
  for (let i = 0; i < N; i++) {
    const t = i / sr;
    const env = Math.exp(-t / 1.15) * 0.16;
    lpL = a * lpL + (1 - a) * (rand() * 2 - 1);
    lpR = a * lpR + (1 - a) * (rand() * 2 - 1);
    L[i] += lpL * env;
    R[i] += lpR * env;
  }
  return toBuffer(ctx, [L, R], sr);
}
