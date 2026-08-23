// Renders the ENTIRE finale show's audio schedule through the real
// AudioEngine graph (samples, panners, reverb sends, convolver, master
// chain) into an OfflineAudioContext, then hunts the rendered waveform for
// the cutouts players hear live: windows where the whole mix collapses
// far below its surroundings while the program is still firing.
//
//   node tools/serve.mjs &            # server must be running
//   node tools/show-audio-test.mjs [--bypass] [--json out.json]
//
// --bypass renders the same schedule with the master compressor+limiter
// bypassed (shelf straight to destination) so the two envelopes can be
// diffed: envBypass - envFull ≈ the gain reduction the dynamics chain is
// applying at that moment. A "cutout" that exists in the full render but
// not the bypass render is the master chain pumping; one that exists in
// neither is not a mix-domain bug at all (look at the audio thread).
//
// Determinism: Math.random is seeded in-page, so full and bypass renders
// fire an identical schedule and their envelopes line up bin for bin.

import { chromium } from 'playwright-core';
import fs from 'node:fs';

const args = process.argv.slice(2);
const bypass = args.includes('--bypass');
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox',
    '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
page.on('pageerror', (err) => { console.error('[pageerror]', err.message); });
page.on('console', (m) => { if (m.type() === 'error') console.error('[console]', m.text()); });
// the live app (attract mode) would share the page and race the seeded
// Math.random stream — this harness renders the show schedule itself, so
// keep main.js out and the schedule is bit-identical run to run
await page.route('**/src/main.js*', (r) => r.fulfill({ body: '', contentType: 'text/javascript' }));
await page.goto('http://localhost:8080/', { waitUntil: 'load' });
page.setDefaultTimeout(600000);

const r = await page.evaluate(async (mode) => {
  // deterministic schedule: both render modes must fire identical cues
  let seed = 0x9e3779b9;
  Math.random = () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const THREE = await import('three');
  const sr = 48000;
  const DUR = 165;
  const off = new OfflineAudioContext(2, DUR * sr, sr);
  // the engine schedules everything relative to ctx.currentTime; shadow it
  // with a settable clock so the whole show can be laid out ahead of render
  let fakeTime = 0;
  Object.defineProperty(off, 'currentTime', { get: () => fakeTime, configurable: true });
  off.resume = () => Promise.resolve();

  const RealAC = window.AudioContext;
  window.AudioContext = function () { return off; };
  const { AudioEngine } = await import('./src/audio.js');
  const eng = new AudioEngine();
  await eng.init();
  window.AudioContext = RealAC;
  clearInterval(eng._gustTimer);
  // the offline clock never advances during scheduling, so onended never
  // fires between plays — neutralize the live voice cap (it is measured
  // separately from the play log below)
  eng._voices.add = () => {};

  if (mode === 'bypass') {
    eng.shelf.disconnect();
    eng.shelf.connect(off.destination);
  }

  // log every voice the schedule actually spawns: audible start (after
  // propagation delay), duration, priority — the live voice-count timeline
  const plays = [];
  const origPlay = eng.play.bind(eng);
  eng.play = (name, pos, o = {}) => {
    const dist = eng.listenerPos.distanceTo(pos);
    const h = origPlay(name, pos, o);
    if (h && !o.loop) {
      plays.push({
        name,
        callT: fakeTime,
        t: fakeTime + (o.startDelay ?? 0) + (o.delayBySound ? dist / 340 : 0),
        dur: h.source.buffer.duration / (o.rate ?? 1),
        gain: o.gain ?? 1,
        ref: o.refDistance ?? 4,
        dist: Math.round(dist),
      });
    }
    return h;
  };

  // listener camps where the player stands for the show
  eng.listenerPos.set(0, 1.6, 0);
  fakeTime = 0;
  eng.setWindLevel(0.5);

  // ---- build the real program ----
  const { FinaleShow } = await import('./src/show.js');
  const { terrainHeight } = await import('./src/terrain.js');
  const show = new FinaleShow({}, eng, terrainHeight);
  const wireCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(2, 0, -2), new THREE.Vector3(3, 0, -30), show.pads[4].clone(),
  ]);
  show.start(wireCurve);
  // the zap's fuse loop dies when the spark reaches the battery
  fakeTime = 2.6;
  show.sparkRun?.sound?.stop(0.15);

  // ---- schedule the cues' audio exactly as _fire() would ----
  const clampi = (v, a, b) => Math.min(Math.max(v, a), b);
  const bpos = new THREE.Vector3();
  for (const c of show.cues) {
    const pad = show.pads[clampi(c.pad, 0, show.pads.length - 1)];
    if (c.lift) {
      fakeTime = c.t;
      eng.play('lift', pad, {
        gain: c.kind === 'mine' ? 1.15 : 1.2, refDistance: 4,
        send: c.kind === 'mine' ? 0.4 : 0.45,
        rate: 0.88 + Math.random() * 0.2, delayBySound: true,
      });
    }
    if (c.sound) {
      // break altitude from the cue's ballistics (drag/gravity arc ≈ 0.58·v·T)
      const flight = Math.max(0.2, (c.tBurst ?? c.t) - c.t);
      const alt = c.kind === 'mine' ? 2
        : clampi((c.o.speed ?? 46) * flight * 0.58, 4, 160);
      bpos.set(pad.x, pad.y + alt, pad.z);
      fakeTime = c.tBurst;
      const soundSize = c.sound === 'big' ? 1 : c.sound === 'med' ? 0.6 : 0.3;
      eng.boom(bpos, soundSize, {
        crackle: c.pattern === 'crackle' || c.pattern === 'multibreak',
      });
    }
  }

  // ---- the waterfall curtains' positional sizzle loops ----
  const T = (s) => 2.7 + s;
  const curtain = (t0, padIdxs, height, gain) => {
    const a = show.pads[padIdxs[0]];
    const b = show.pads[padIdxs[padIdxs.length - 1]];
    for (const u of [0.12, 0.5, 0.88]) {
      const p = new THREE.Vector3(
        a.x + (b.x - a.x) * u, height * 0.6, a.z + (b.z - a.z) * u);
      const dist = eng.listenerPos.distanceTo(p);
      fakeTime = t0 + 2.6;
      const h = eng.play('waterfall', p, {
        gain, loop: true, refDistance: 30, send: 0.5,
        lowpass: Math.max(1400, 9000 - dist * 55), rate: 0.9 + Math.random() * 0.14,
      });
      fakeTime = t0 + 2.6 + 9;
      h?.stop(1.2);
    }
  };
  curtain(T(81.5), [0, 2, 4, 6, 8], 58, 0.64);
  curtain(T(85.2), [1, 3, 5, 7], 46, 0.64);

  // the show ducks the ambience bus under the gold wall
  fakeTime = T(131.5);
  eng.duckAmbience?.(20);

  fakeTime = 0;
  const rendered = await off.startRendering();

  // ---- envelope: 10 ms RMS in dBFS ----
  const L = rendered.getChannelData(0);
  const R = rendered.getChannelData(1);
  const hop = Math.floor(sr * 0.01);
  const bins = Math.floor(L.length / hop);
  const env = new Array(bins);
  let clipped = 0;
  const clipBySec = {};
  for (let b = 0; b < bins; b++) {
    let s = 0;
    for (let i = b * hop; i < (b + 1) * hop; i++) {
      const m = (L[i] + R[i]) * 0.5;
      s += m * m;
      const pk = Math.max(Math.abs(L[i]), Math.abs(R[i]));
      if (pk > 1.0) {
        clipped++;
        const sec = Math.floor(i / sr);
        clipBySec[sec] = (clipBySec[sec] ?? 0) + 1;
      }
    }
    const rms = Math.sqrt(s / hop);
    env[b] = Math.round(Math.max(-100, 20 * Math.log10(rms + 1e-10)) * 10) / 10;
  }

  // live one-shot voice count per 100 ms from the play log
  const vbins = Math.ceil(DUR * 10);
  const voices = new Array(vbins).fill(0);
  for (const p of plays) {
    const b0 = Math.max(0, Math.floor(p.t * 10));
    const b1 = Math.min(vbins, Math.ceil((p.t + p.dur) * 10));
    for (let b = b0; b < b1; b++) voices[b]++;
  }
  // play-call starts per second (graph-mutation churn)
  const starts = {};
  for (const p of plays) {
    const sSec = Math.floor(p.t);
    starts[sSec] = (starts[sSec] ?? 0) + 1;
  }

  return {
    env, hop: 0.01, voices, starts, clipped, clipBySec,
    plays,
    nPlays: plays.length,
    cueCount: show.cues.length,
    soundBudget: show.soundBudget,
    duration: show.duration,
  };
}, bypass ? 'bypass' : 'full');

// ---- analysis: find the cutouts ----
const env = r.env;
const dt = r.hop;
const smooth = (arr, n) => arr.map((_, i) => {
  let s = 0, c = 0;
  for (let j = Math.max(0, i - n); j <= Math.min(arr.length - 1, i + n); j++) { s += arr[j]; c++; }
  return s / c;
});
// context level: median-ish over ±1 s (mean of dB is fine for this)
const ctx1s = smooth(env, 100);

// a dip: envelope ≥12 dB under its ±1 s surroundings for ≥120 ms, inside
// the active program (skip the written-in silence beat and the ending)
const dips = [];
let cur = null;
for (let i = 0; i < env.length; i++) {
  const t = i * dt;
  const below = ctx1s[i] - env[i];
  if (below >= 12 && env[i] > -95) {
    if (!cur) cur = { t0: t, minEnv: env[i], maxBelow: below };
    cur.t1 = t;
    cur.minEnv = Math.min(cur.minEnv, env[i]);
    cur.maxBelow = Math.max(cur.maxBelow, below);
  } else if (cur) {
    if (cur.t1 - cur.t0 >= 0.12) dips.push(cur);
    cur = null;
  }
}

const fmt = (x) => Math.round(x * 100) / 100;
console.log(`mode: ${bypass ? 'BYPASS (no comp/limiter)' : 'FULL chain'}`);
console.log(`cues: ${r.cueCount}, one-shot plays: ${r.nPlays}, show duration: ${fmt(r.duration)}s`);
console.log(`sound budget: ${JSON.stringify(r.soundBudget)}`);
console.log(`peak live voices: ${Math.max(...r.voices)} (100ms bins)`);
const busiest = Object.entries(r.starts).sort((a, b) => b[1] - a[1]).slice(0, 5);
console.log(`busiest play-start seconds: ${busiest.map(([s, n]) => `t=${s}s:${n}`).join(', ')}`);
console.log(`samples clipped (|s|>1.0 → DAC hard-clip live): ${r.clipped}`);
if (r.clipped) {
  const secs = Object.entries(r.clipBySec).sort((a, b) => b[1] - a[1]).slice(0, 10);
  console.log(`  worst clip seconds: ${secs.map(([s, n]) => `t=${s}s:${n}`).join(', ')}`);
}
console.log(`dips ≥12 dB under ±1s context for ≥120 ms: ${dips.length}`);
for (const d of dips.slice(0, 20)) {
  console.log(`  t=${fmt(d.t0)}–${fmt(d.t1)}s  depth ${fmt(d.maxBelow)} dB  floor ${fmt(d.minEnv)} dBFS`);
}

// voice-count hot spots (the audio-thread load the offline render can't feel)
const v = r.voices;
let vmaxT = 0;
for (let i = 0; i < v.length; i++) if (v[i] > v[vmaxT]) vmaxT = i;
console.log(`voice-count peak ${v[vmaxT]} at t=${fmt(vmaxT / 10)}s (uncapped offered load)`);
const over = [];
for (let i = 0; i < v.length; i++) if (v[i] >= 40) over.push(i);
if (over.length) {
  console.log(`seconds with ≥40 live one-shot voices: ${fmt(over.length / 10)}s total, ` +
    `from t=${fmt(over[0] / 10)} to t=${fmt(over[over.length - 1] / 10)}`);
}

// ---- replay the engine's live voice-cap policy over the offered load ----
// The offline clock can't exercise the cap (onended never fires during
// scheduling), so simulate it: same ranking as AudioEngine.play/_evict.
const CAP = 32;
const TAU = 1.5;
const evs = [...r.plays].sort((a, b) => a.callT - b.callT);
let live = [];
let peakLive = 0;
let evictions = 0;
let refusals = 0;
const evictedNames = {};
const refusedNames = {};
for (const p of evs) {
  live = live.filter((x) => x.endT > p.callT);
  const pri = p.gain * (p.ref / Math.max(p.dist, p.ref));
  if (live.length >= CAP) {
    let worst = null;
    let worstPri = Infinity;
    for (const x of live) {
      const q = x.pri * Math.exp(-Math.max(0, p.callT - x.callT) / TAU);
      if (q < worstPri) { worstPri = q; worst = x; }
    }
    if (worstPri >= pri) {
      refusals++;
      refusedNames[p.name] = (refusedNames[p.name] ?? 0) + 1;
      continue;
    }
    evictions++;
    evictedNames[worst.name] = (evictedNames[worst.name] ?? 0) + 1;
    live.splice(live.indexOf(worst), 1);
  }
  live.push({ name: p.name, pri, callT: p.callT, endT: p.t + p.dur });
  peakLive = Math.max(peakLive, live.length);
}
console.log(`cap policy (CAP=${CAP}): peak live ${peakLive}, evictions ${evictions}, refusals ${refusals}`);
if (evictions) console.log(`  evicted: ${JSON.stringify(evictedNames)}`);
if (refusals) console.log(`  refused: ${JSON.stringify(refusedNames)}`);
if (peakLive > CAP) console.log('  !! cap policy failed to bound live voices');

if (jsonOut) {
  fs.writeFileSync(jsonOut, JSON.stringify(r));
  console.log(`raw data -> ${jsonOut}`);
}
await browser.close();
