// The detonator finale, re-choreographed to Victoria Harbour scale: a
// ~150-second six-scene program fired as VOLLEYS, never polite singles.
// Plunging the TNT box sends a spark racing down the wire to a battery of
// nine mortar pads in the dunes plus a nearer five-pad "pontoon" row for
// mines and fan work. The grammar is the real thing's: all-pad hits,
// galloping ripple chases, woven fan crisscrosses, three altitude bands
// stacked at the peaks, one hushed lyrical scene with a lone giant shell
// and the niagara waterfall curtains, a silence-then-GOLD-WALL payoff, and
// a three-stage salute-capped finale that cuts hard to black.
//
// Build discipline: every launched effect registers a cue first, so the
// builder can count launch events per second and run the deterministic
// sound-budget demotion (big→med→small→null on overflow, anchors and
// salute chains untouched) before the event list is frozen. All "volume"
// comes from firing more and bigger reports through the LOCKED samples.

import * as THREE from 'three';
import { randRange, randPick, clamp } from './utils.js';
import { PALETTES } from './fireworks.js';

const WATERFALL_PALETTE = { name: 'molten silver', a: 0xfff3d8, b: 0xffd489 };
const GOLD = { name: 'pure gold', a: 0xffc04d, b: 0xfff2bb };
const PAL = (name) => PALETTES.find((p) => p.name === name) ?? randPick(PALETTES);
const _sparkPos = new THREE.Vector3();
const _padFlash = new THREE.Vector3();

// Three altitude bands, tuned so breaks land ~25-45 m (low — still above
// the dune line from camp, even off the near row), ~60-90 m (mid) and
// ~110-150 m (high). Layered simultaneous fire = the HK barge look.
// Break heights tuned against captures from the campsite (88 m out, mesas
// at ~12 deg): mid must clear ~65 m and high ~100 m or the whole body of
// the show huddles in a sliver above the mesa line and reads polite again.
const LAYERS = {
  low: { speed: [24, 32], flightT: [1.25, 1.65] },
  mid: { speed: [46, 54], flightT: [2.4, 2.8] },
  high: { speed: [64, 74], flightT: [3.4, 4.0] },
};

// pad groupings for the rhythm devices
const ALL9 = [0, 1, 2, 3, 4, 5, 6, 7, 8];
const EVENS = [0, 2, 4, 6, 8];
const ODDS = [1, 3, 5, 7];
const L2R = ALL9;
const R2L = [8, 7, 6, 5, 4, 3, 2, 1, 0];
const OUTSIDE_IN = [0, 8, 1, 7, 2, 6, 3, 5, 4];
const LOW = [9, 10, 11, 12, 13];

// one-shot VOICES allowed per second, sustained (lifts + reports + the
// crackle/sizzle tails boom() tows behind crackle patterns and big
// reports); brief peaks above this are reserved for the salute chains
// and the wall
const SOUND_CAP = 15;
const SOUND_RANK = { big: 3, med: 2, small: 1 };

export class FinaleShow {
  constructor(fireworks, audio, terrainHeight) {
    this.fw = fireworks;
    this.audio = audio;
    this.running = false;
    this.time = 0;
    this.events = [];
    this._ei = 0;
    this.duration = 0;
    this.sparkRun = null;   // the zap racing down the wire
    this.curtains = [];     // live waterfall sizzle loops
    this.onEnd = null;
    this._cues = [];        // launch cues (built, budgeted, then frozen)
    this.cues = [];         // frozen copy the QA harness reads
    this.soundBudget = null;

    // mortar battery: an arc of pads out in the dunes north of camp,
    // 60-90 m from the campsite so the breaks fill the sky, not the lap
    this.pads = [];
    for (let i = 0; i < 9; i++) {
      const x = 6 - 44 + i * 11 + randRange(-2.5, 2.5);
      const z = -72 - Math.abs(i - 4) * 2.5 + randRange(-6, 6);
      this.pads.push(new THREE.Vector3(x, terrainHeight(x, z), z));
    }
    // the pontoon row (pads 9-13): five nearer pads for mines and fan
    // comets — the low band that keeps the space under the shells alive.
    // (The detonator wire still lands on pads[4]; 0-8 are untouched.)
    for (let i = 0; i < 5; i++) {
      const x = 6 - 30 + i * 15 + randRange(-2, 2);
      const z = -48 - Math.abs(i - 2) * 2 + randRange(-1.5, 1.5);
      this.pads.push(new THREE.Vector3(x, terrainHeight(x, z), z));
    }
  }

  // ---- firing primitives -------------------------------------------------

  /** Fire one shell from pad index `p` through the engine's mortar (plays
   *  its own lift). Used for feature shells that want engine-side extras
   *  like the tremalon glitter tail; unknown opts pass through harmlessly. */
  _shell(p, pattern, size, opts = {}) {
    const pad = this.pads[clamp(p, 0, this.pads.length - 1)];
    this.fw.mortarShot(pad, {
      pattern, size,
      palette: opts.palette ?? randPick(PALETTES),
      sound: opts.sound, // may be null after demotion — respected downstream
      speed: opts.speed ?? (43 + size * 12) * randRange(0.95, 1.05),
      flightT: opts.flightT ?? randRange(2.4, 2.8) + size * 0.4,
      spread: opts.spread ?? 0.10,
      dir: opts.dir, tail: opts.tail, burst: opts.burst,
    });
  }

  /**
   * Manual mortar: same ballistics as the engine's mortarShot, but the show
   * keeps control of the lift audio (a volley of nine can't afford nine
   * thoomps — the sound budget allows two per cue) and of the full burst
   * spec (pistil hearts, silent fizzle comets for the fans). Reuses the
   * locked 'lift' sample at position/gain/rate — never edits it.
   */
  _mortar(pad, pattern, size, o = {}) {
    const fw = this.fw;
    if (typeof fw._fireShot !== 'function') { // engine refactor safety net
      fw.mortarShot(pad, { pattern, size, ...o });
      return;
    }
    const spread = o.spread ?? 0.09;
    const dir = o.dir
      ? _padFlash.copy(o.dir).normalize()
      : _padFlash.set(randRange(-1, 1) * spread, 1, randRange(-1, 1) * spread).normalize();
    if (o.lift) {
      this.audio.play('lift', pad, {
        gain: 1.2, refDistance: 4, send: 0.45, rate: randRange(0.88, 1.08), delayBySound: true,
      });
      fw.flashes.flash(_sparkPos.copy(pad).setY(pad.y + 0.4), 0xffc890, 55, 0.16);
    }
    const palette = o.palette ?? randPick(PALETTES);
    const flightT = o.flightT ?? 2.4;
    const vel = new THREE.Vector3().copy(dir).multiplyScalar(o.speed ?? 46);
    fw._fireShot(pad.clone(), vel, new THREE.Color(palette.a), o.comet ?? (size >= 0.9 ? 1.4 : 1.0), {
      gravity: 0.9, drag: 0.35, flightT,
      onBurst: (p, v) => {
        if (o.burst === false) {
          // fan comet: dies the same quiet death as an engine-fired fan —
          // one fizzle implementation, not a drifting copy
          fw._fizzle(p, palette);
          return;
        }
        fw.burst(p, {
          pattern, size, palette, sound: o.sound ?? null,
          pistil: o.pistil, drift: v?.clone().multiplyScalar(0.5),
        });
      },
    });
  }

  /** Execute one frozen cue (sound class may have been demoted at build). */
  _fire(c) {
    const pad = this.pads[clamp(c.pad, 0, this.pads.length - 1)];
    const o = c.o;
    if (c.kind === 'mine') {
      if (typeof this.fw.mine === 'function') {
        this.fw.mine(pad, {
          size: c.size, palette: o.palette, kind: o.mineKind ?? 'color', sound: !!c.lift,
        });
      } else {
        // the engine's mine() hasn't landed yet: a low snap-peony from the
        // same pad stands in for the column until the real eruption arrives
        this._mortar(pad, 'peony', 0.3, {
          palette: o.palette, sound: c.sound, lift: c.lift, speed: 26, flightT: 1.05, spread: 0.05,
        });
      }
      return;
    }
    if (o.engine) {
      this._shell(c.pad, c.pattern, c.size, { ...o, sound: c.sound });
      return;
    }
    this._mortar(pad, c.pattern, c.size, {
      palette: o.palette, sound: c.sound, lift: c.lift, pistil: o.pistil,
      dir: o.dir, speed: o.speed, flightT: o.flightT, spread: o.spread,
      burst: o.burst, comet: o.comet,
    });
  }

  // ---- cue layer: every launch is registered before it is scheduled -----

  _cue(t, pad, pattern, size, o = {}) {
    const c = {
      t, pad, pattern, size, o,
      kind: o.kind ?? 'shell',
      lift: (o.engine || o.lift) ? 1 : 0,
      sound: o.sound ?? null,
      anchor: !!o.anchor,
      exempt: pattern === 'salute', // salute chains are the point, and brief
      tBurst: t + (o.flightT ?? 2.4),
    };
    this._cues.push(c);
    return c;
  }

  /** VOLLEY — the atomic unit: N effects on one cue, staggered a few
   *  frames so the cluster blooms as one gesture. Two audible lifts max.
   *  ONE ballistic draw per volley: per-pad speed/flight draws scattered
   *  the break order and smeared the chord into an arpeggio. Pads keep
   *  the launch stagger; jitter is bounded to a fraction of ONE step so
   *  wide staggers can't invert pad order. */
  _volley(t, padIdxs, pattern, size, o = {}, stagger = 0.06) {
    const lifts = o.lifts ?? 2;
    const L = LAYERS[o.layer ?? 'mid'];
    const speed = o.speed ?? randRange(L.speed[0], L.speed[1]);
    const flightT = o.flightT ?? randRange(L.flightT[0], L.flightT[1]);
    padIdxs.forEach((p, k) => {
      this._cue(t + k * stagger + randRange(-0.25, 0.25) * stagger, p, pattern, size * randRange(0.85, 1.15), {
        ...o,
        lift: k < lifts,
        sound: o.sound !== undefined ? o.sound
          : (size > 0.75 ? 'big' : size > 0.45 ? 'med' : 'small'),
        speed,
        flightT: flightT + randRange(-0.03, 0.03),
      });
    });
    return padIdxs.length;
  }

  /** SALVO — the all-pad "hit": everything inside <100 ms. Used 6-10x. */
  _salvo(t, padIdxs, pattern, size, o = {}) {
    return this._volley(t, padIdxs, pattern, size, { lifts: o.lifts ?? 3, ...o }, 0.011);
  }

  /** CHASE — running fire across the arc at a fixed 60-120 ms offset;
   *  the wave crosses the front in ~0.6-1.1 s. HK's galloping horses.
   *  One ballistic draw for the whole line: with a shared flightT the
   *  BREAKS sweep in pad order at the launch gap — per-pad flight draws
   *  were shuffling the very ripple the chase exists for. Jitter stays
   *  under half a step, so the sweep is monotonic by construction. */
  _chase(t0, gap, order, pattern, size, o = {}) {
    const L = LAYERS[o.layer ?? 'mid'];
    const speed = o.speed ?? randRange(L.speed[0], L.speed[1]);
    const flightT = o.flightT ?? randRange(L.flightT[0], L.flightT[1]);
    order.forEach((p, k) => {
      this._cue(t0 + k * gap, p, pattern, size * randRange(0.9, 1.1), {
        ...o,
        lift: k === 0 || k === order.length - 1,
        sound: o.sound ?? 'small',
        speed,
        flightT: flightT + randRange(-0.45, 0.45) * Math.min(gap, 0.07),
      });
    });
    return order.length;
  }

  /** FAN — n comets in a planar crisscross fan off one pontoon pad,
   *  burst:false so they draw rising gold ribs and die without a report.
   *  ~60-90 particles per comet: the cheapest way to keep the low band
   *  alive. Alternating lean across adjacent pads weaves the lattice. */
  _fan(t, padIdx, n, spreadDeg, leanDeg, o = {}) {
    for (let k = 0; k < n; k++) {
      const a = THREE.MathUtils.degToRad(
        leanDeg + (n > 1 ? (k / (n - 1) - 0.5) * spreadDeg : 0) + randRange(-1.5, 1.5));
      const dir = new THREE.Vector3(Math.sin(a), Math.cos(a), randRange(-0.10, 0.02));
      this._cue(t + k * 0.035, padIdx, 'peony', 0.5, {
        ...o,
        dir, burst: false,
        lift: k === 0 && o.lift !== false,
        sound: null,
        speed: o.speed ?? randRange(27, 34),
        flightT: o.flightT ?? randRange(1.35, 1.75),
        comet: o.comet ?? 1.0,
      });
    }
    return n;
  }

  /** MINE FRONT — ground eruptions across the pontoon row. */
  _mineFront(t, padIdxs, o = {}) {
    const lifts = o.lifts ?? 2;
    padIdxs.forEach((p, k) => {
      this._cue(t + k * 0.05 * randRange(0.6, 1.4), p, 'mine', (o.size ?? 1.0) * randRange(0.85, 1.1), {
        ...o, kind: 'mine', lift: k < lifts, sound: null, flightT: 0.9,
      });
    });
    return padIdxs.length;
  }

  /**
   * The waterfall moment (kept — and featured): a line of horsetail shells
   * timed to break simultaneously, high and wide, so their trails hang as
   * one curtain, with the positional molten-sizzle loop riding the sheet.
   */
  _curtainCue(t, padIndices, size, height) {
    const flightT = 2.6;
    const speed = height / 1.55; // rough inverse of the drag/gravity arc at t=2.6
    padIndices.forEach((p, k) => {
      // anchor: the CEO's moment keeps its hush intact — demotion hands off
      this._cue(t + k * 0.02, p, 'waterfall', size, {
        palette: WATERFALL_PALETTE, sound: 'small', anchor: true, lift: k < 2,
        speed, flightT, spread: 0.03,
      });
    });
    // the frying-metal hush arrives WITH the break, not the launch. The
    // ~58 m sheet is not a point source: three decorrelated sizzle voices
    // (shuffle-bag variants + rate detune) spread across the pad span,
    // per-voice gain 1.1/sqrt(3) so total energy matches the old single.
    this.events.push({
      t, fn: () => {
        const a = this.pads[padIndices[0]];
        const b = this.pads[padIndices[padIndices.length - 1]];
        const poss = [0.12, 0.5, 0.88].map((u) => new THREE.Vector3(
          a.x + (b.x - a.x) * u, height * 0.6, a.z + (b.z - a.z) * u));
        this.curtains.push({ poss, delay: flightT, t: 0, dur: 9, sink: 3.5, handles: null, gain: 0.64 });
      },
    });
  }

  /**
   * THE SUPER WALL (handover 2017): after the silence, every pad fires
   * inside ~150 ms and keeps firing for ~12 s — mines instant at ground,
   * low peonies and spiders as the body, woven fans underneath, brocade
   * crowns staggered on top. Sky reads solid gold, no black gaps.
   *
   * Budget arithmetic (per second, steady state, measured against the
   * real engine): ~4 small peony (0.42 ≈ 2.6k) + 2 spider (0.8 ≈ 1k) +
   * 10 fan comets (~60 ea ≈ 0.6k) + 1 mine (~0.5k) + 0.67 brocade anchor
   * (0.6 ≈ 4.6k → 3k/s) ≈ 16k spawned/s; average lives 2.6-5 s → ~50k
   * concurrent. Inside the 96k ring with the finale crowns still to come.
   */
  _wall(t0) {
    let n = 0;
    // the instant: five ground mines + a rolling fireball right off the
    // silence, then nine low breaks landing as one sheet 1.4 s later
    n += this._mineFront(t0 + 0.06, LOW, { palette: GOLD, size: 1.05, lifts: 3 });
    this._cue(t0 + 0.2, 11, 'lampare', 1.0, {
      palette: GOLD, sound: 'big', anchor: true, lift: true, speed: 24, flightT: 1.25,
    }); n++;
    n += this._salvo(t0 + 0.1, EVENS, 'peony', 0.62, { palette: GOLD, sound: 'med', layer: 'low' });
    n += this._salvo(t0 + 0.16, ODDS, 'spider', 0.95, { palette: GOLD, sound: 'med', layer: 'low' });
    // then the sustained roar: three layers cycling for twelve seconds
    const end = t0 + 12.2;
    let t = t0 + 0.9;
    let beat = 0;
    while (t < end) {
      // mid band: rotating trio volleys, spiders every third beat (cheap
      // and huge — they do the "no black gaps" work). Stride 4 is coprime
      // with 9, so consecutive beats walk the trio across every pad in the
      // arc — a stride of 3 would nail the same three pads all twelve
      // seconds and leave dark lanes through the wall.
      const base = (beat * 4) % 9;
      const trio = [base, (base + 3) % 9, (base + 6) % 9];
      const spider = beat % 3 === 2;
      n += this._volley(t, trio, spider ? 'spider' : beat % 2 ? 'crackle' : 'peony', spider ? 0.9 : 0.55, {
        palette: GOLD, sound: 'med', layer: beat % 2 ? 'mid' : 'low', lifts: 1,
      }, 0.05);
      // low band: woven fans off both wings, alternating lean; mines on
      // the off-beats
      if (beat % 2 === 0) {
        const wing = ((beat / 2) | 0) % 5;
        n += this._fan(t + 0.22, 9 + wing, 5, 48, wing % 2 ? 15 : -15, { palette: GOLD });
        n += this._fan(t + 0.30, 9 + ((wing + 2) % 5), 5, 48, wing % 2 ? -15 : 15, { palette: GOLD });
      } else {
        n += this._mineFront(t + 0.25, [9 + (beat % 5)], { palette: GOLD, size: 0.9, lifts: 1 });
      }
      // high band: one brocade crown every third beat, walking the arc —
      // the sparse anchors the budget allows (brocade 0.6 ≈ 4.6k living
      // ~5 s → ~3 alive ≈ 15k standing overhead; a chrys here would cost
      // 8k each and double that). No anchors in the last two seconds, so
      // the terminal kamuro's break second isn't shared with a wall crown.
      if (beat % 3 === 0 && t < end - 2.2) {
        this._cue(t + 0.1, [2, 6, 4, 0, 8][((beat / 3) | 0) % 5], 'brocade', 0.6, {
          palette: GOLD, sound: 'big', anchor: true, lift: true,
          speed: randRange(58, 64), flightT: randRange(3.2, 3.5),
        }); n++;
      }
      beat++;
      t += randRange(0.46, 0.55);
    }
    return n;
  }

  // ---- build-time sound budget ------------------------------------------

  /**
   * Deterministic demotion: bucket every one-shot play (lift at launch,
   * report at break) per second of the program; where a bucket overflows
   * the cap, demote the quietest non-anchor report one class at a time
   * (big→med→small→null) until it fits. Salute chains are exempt — their
   * seconds are the sanctioned brief peaks. The roar comes from overlap
   * of the locked samples, never from clipping the audio graph.
   */
  _applySoundBudget() {
    // a cue's TRUE voice cost: the engine's boom() tows a crackle tail
    // (+1 voice) behind crackle/multibreak breaks and a sizzle (+1) behind
    // every 'big' report (soundSize 1 > 0.7 downstream) — a budget that
    // counts those as one play is lying about the second of the break
    const voices = (c) => (!c.sound ? 0
      : (c.sound === 'big' || c.pattern === 'crackle' || c.pattern === 'multibreak') ? 2 : 1);
    const buckets = new Map();
    const get = (s) => {
      let b = buckets.get(s);
      if (!b) { b = { lifts: 0, booms: [] }; buckets.set(s, b); }
      return b;
    };
    for (const c of this._cues) {
      if (c.lift) get(Math.floor(c.t)).lifts++;
      if (c.sound) get(Math.floor(c.tBurst)).booms.push(c);
    }
    let demoted = 0;
    for (const [, b] of buckets) {
      // count-reducing demotion of the overflow (voice-weighted)
      const total = () => b.lifts + b.booms.reduce((n, c) => n + voices(c), 0);
      let guard = 200;
      while (total() > SOUND_CAP && guard-- > 0) {
        let pick = null;
        for (const c of b.booms) {
          if (c.anchor || c.exempt || !c.sound) continue;
          if (!pick || SOUND_RANK[c.sound] < SOUND_RANK[pick.sound]
            || (SOUND_RANK[c.sound] === SOUND_RANK[pick.sound] && c.size < pick.size)) pick = c;
        }
        if (!pick) break; // only anchors/salutes left — sanctioned peak
        if (pick.sound === 'small') pick.sound = null;
        else pick.sound = pick.sound === 'big' ? 'med' : 'small';
        demoted++;
      }
      // and never stack more than 5 big reports into one second — the
      // extra bigs step down to med (anchors keep their class)
      let bigs = b.booms.filter((c) => c.sound === 'big' && !c.anchor && !c.exempt);
      while (b.booms.filter((c) => c.sound === 'big').length > 5 && bigs.length) {
        bigs.sort((a, x) => a.size - x.size);
        bigs.shift().sound = 'med';
        bigs = b.booms.filter((c) => c.sound === 'big' && !c.anchor && !c.exempt);
        demoted++;
      }
    }
    // report the post-demotion profile for the QA harness — voice-weighted,
    // so the number states what the engine will actually spawn
    let maxPlays = 0;
    for (const [, b] of buckets) {
      maxPlays = Math.max(maxPlays, b.lifts + b.booms.reduce((n, c) => n + voices(c), 0));
    }
    this.soundBudget = { cap: SOUND_CAP, demoted, maxPlaysPerSec: maxPlays };
  }

  // ---- the program -------------------------------------------------------

  /** Build and start the full program. wireCurve carries the opening zap. */
  start(wireCurve) {
    if (this.running) return false;
    this.running = true;
    this.time = 0;
    this.events = [];
    this._ei = 0;
    this._cues = [];
    const at = (t, fn) => this.events.push({ t, fn });

    // --- 0-2.6s: the zap races down the wire to the battery ---
    this.sparkRun = {
      curve: wireCurve, t0: 0.15, dur: 2.45,
      sound: this.audio.play('fuse', wireCurve.getPoint(0), {
        gain: 0.9, loop: true, refDistance: 1.2, send: 0.15, rate: 1.7, hrtf: true,
      }),
    };
    const T = (s) => 2.7 + s; // program clock: scene seconds → show seconds

    // ================= SCENE 1 — "GOLDEN HERD" (0-15) =================
    // HK CNY 2026 opening: full width and full altitude inside the first
    // seconds — three all-pad hits at t=0/4/8 with the galloping-horse
    // horsetail ripples (80 ms offsets) charging between them, each pass
    // a size louder. Crimson and gold trade the sky, and hit 2 is a cold
    // teal-ember splash so the first fifteen seconds read red+gold+accent
    // rather than a red block (the ghost hit at t=8 relights to a random
    // palette mid-air — free variety the engine hands us).
    const CRIMSON = PAL('crimson gold');
    {
      // hit 1: nine mid-band crimson peonies inside 100 ms under one grand
      // gold dahlia. ~9 × 2.8k stars in the break second — the largest
      // single spend outside the finale, on purpose: HK opens at FULL
      // power. (Dahlia, not kamuro, for the crown: a kamuro's 7 s hang
      // would still be alive when hit 3 lands and tip the 96k ring.)
      this._salvo(T(0), ALL9, 'peony', 0.62, { palette: CRIMSON, layer: 'mid', sound: 'med' });
      this._cue(T(0.08), 4, 'dahlia', 1.35, {
        palette: GOLD, sound: 'big', anchor: true, engine: true, tail: 'glitter',
        speed: 62, flightT: 3.4,
      });
      // herd pass 1: gold horsetails L→R (cheap shells, ~0.9k each)
      this._chase(T(1.7), 0.08, L2R, 'horsetail', 0.42, { palette: GOLD, sound: 'small' });
      // hit 2: the cold answer — teal stars over ember tips — and the
      // pontoon row wakes up underneath in gold
      this._salvo(T(4), ALL9, 'crackle', 0.68, { palette: PAL('teal ember'), layer: 'mid', sound: 'med' });
      this._mineFront(T(4.12), LOW, { palette: GOLD, size: 0.9 });
      // herd pass 2: back R→L, a size up
      this._chase(T(5.7), 0.08, R2L, 'horsetail', 0.48, { palette: GOLD, sound: 'small' });
      // hit 3: the full stack — mid crimson, low fans weaving, a dahlia
      // and a giant spider on the shoulders (the spider is huge but ~1k)
      this._salvo(T(8), ALL9, 'ghost', 0.75, { palette: CRIMSON, layer: 'mid', sound: 'med' });
      this._fan(T(8.15), 10, 5, 52, -15, { palette: GOLD });
      this._fan(T(8.22), 12, 5, 52, 15, { palette: GOLD });
      this._cue(T(8.45), 2, 'dahlia', 1.2, {
        palette: CRIMSON, sound: 'big', anchor: true, engine: true, speed: 60, flightT: 3.3,
      });
      this._cue(T(8.6), 6, 'spider', 1.2, {
        palette: GOLD, sound: 'big', anchor: true, engine: true, speed: 60, flightT: 3.3,
      });
      // herd pass 3: outside-in pincer, the loudest
      this._chase(T(9.8), 0.07, OUTSIDE_IN, 'horsetail', 0.55, { palette: GOLD, sound: 'med' });
      // close the statement: a crossette pair and one spider stretched
      // across the whole arc (few stars, huge streaks — basically free)
      this._volley(T(12.4), [3, 5], 'crossette', 1.0, { palette: CRIMSON, sound: 'med' }, 0.25);
      this._cue(T(13.6), 4, 'spider', 1.3, {
        palette: GOLD, sound: 'med', lift: true, speed: 52, flightT: 2.9,
      });
    }

    // ================= SCENE 2 — "CRIMSON TIDE" (15-45) =================
    // The spectacle scene as a COLOR CONVERSATION: crimson still leads —
    // it is the tide — but every statement bar is answered by two or three
    // quicker, smaller bars in cold and gold palettes before red speaks
    // again. Bars pulse ~1.6 s (never metronomic); statement bars are the
    // big mid-band gestures, answer bars are small-quick and sometimes
    // low — the caliber contrast is what makes the pulse read as pace.
    // At the half the whole rotation shifts a family (strontium/copper/
    // brocade/teal-ember) so the scene evolves without going monochrome.
    // Anchors deliberately CONTRAST the field they land over.
    {
      const SCARLET = PAL('scarlet pink');
      // red leads, cold answers, gold glues — rotation A then B at the half
      const ROT_A = [CRIMSON, PAL('oasis teal'), SCARLET, PAL('blue gold')];
      const ROT_B = [PAL('strontium red'), PAL('copper blue'), PAL('golden brocade'), PAL('teal ember')];
      const hitTimes = [T(22.8), T(37.4)]; // the all-pad hits ARE those bars
      // PHRASING, not a metronome: two written-in rests (hold the breath,
      // then speak again — the first lands right before hit 1, so the hit
      // arrives out of silence), a lyrical window where ONE big shell owns
      // the sky, and a four-bar double-time sprint around T(32) before the
      // second rest. Scene length and the anchor cadence are untouched.
      const rests = [T(20.9), T(34.0)];
      let restI = 0;
      const LYRIC = [T(23.9), T(27.1)]; // held for the lone scarlet peony
      let bar = T(15.6), k = 0, sprintBars = -1; // -1 armed, 4..1 running, 0 spent
      while (bar < T(43.5)) {
        // a bar that would collide with an all-pad hit steps past it — the
        // hit takes that beat, the pulse never stops
        const hit = hitTimes.find((h) => Math.abs(bar - h) < 1.15);
        if (hit) bar = hit + randRange(1.2, 1.5);
        if (bar >= LYRIC[0] && bar < LYRIC[1]) bar = LYRIC[1] + randRange(0, 0.2);
        // the double-time passage: exactly FOUR bars at half stride, armed
        // by the first bar past T(30.4) — a window test here let a bar at
        // 30.3 stride 1.6 s across half the passage
        if (sprintBars < 0 && bar >= T(30.4)) sprintBars = 4;
        const sprint = sprintBars > 0;
        if (sprint) sprintBars--;
        const pal = (bar < T(30) ? ROT_A : ROT_B)[k % 4];
        const statement = k % 4 === 0; // the red bar: bigger, slower, mid band
        // odd bars borrow a pontoon pad: same volley, one break nearer the
        // camp — cheap depth the real barges get for free
        const group = k % 2 ? [...ODDS, 9 + (k % 5)] : EVENS;
        const fam = k % 5; // rotate shell families bar to bar (5 vs 4-color
        // rotation is coprime, so family x color combinations keep walking)
        // per-bar stagger phrasing: statements roll; answers land as a
        // tight hit, a normal cluster or a lazy smear — never one width
        const stag = statement ? 0.07 : sprint ? 0.03 : [0.014, 0.05, 0.12][k % 3];
        this._volley(bar, group,
          fam === 1 ? 'ghost' : fam === 2 ? 'crossette' : fam === 3 ? 'serpents' : fam === 4 ? 'dragoneggs' : 'peony',
          statement && !sprint ? randRange(0.62, 0.72) : randRange(0.42, 0.52), {
            palette: pal, layer: statement ? 'mid' : k % 3 === 2 ? 'low' : 'mid',
            sound: statement && !sprint ? 'med' : 'small',
            pistil: fam === 0 ? { color: pal.b, ratio: 0.38 } : undefined,
          }, stag);
        if (k % 2 === 0 && !sprint) {
          // the woven crisscross: adjacent pontoon pads lean opposite ways;
          // gold under the statements, the bar's color under the answers
          const lowPad = 9 + ((k / 2) | 0) % 5;
          this._fan(bar + randRange(0.9, 1.15), lowPad, 5, 52, k % 4 === 0 ? -16 : 16,
            { palette: k % 4 === 0 ? GOLD : pal });
        }
        if (k % 5 === 3) this._mineFront(bar + 0.5, [9 + (k % 5)], { palette: pal, size: 0.8, lifts: 1 });
        k++;
        bar += sprint ? randRange(0.72, 0.88) : randRange(1.45, 1.75); // on the beat, never on a grid
        if (restI < rests.length && bar >= rests[restI]) {
          bar += randRange(1.2, 1.5); // the rest: a real hole in the pulse
          restI++;
        }
      }
      // the lyrical bar: one big scarlet peony fired into the held gap —
      // the only break in its ±1.2 s window, the tide taking one breath
      this._cue(T(25.0), 4, 'peony', 1.3, {
        palette: SCARLET, sound: 'big', anchor: true, lift: true,
        speed: 58, flightT: 3.3, pistil: { color: SCARLET.b, ratio: 0.35 },
      });
      // sparse anchors: big ray shells with tremalon rise, one at a time —
      // the middle two are COLD against the warm field (contrast, the
      // thing that keeps a 30 s scene from reading as one red block)
      this._cue(T(19.6), 2, 'chrys', 1.2, {
        palette: CRIMSON, sound: 'big', anchor: true, engine: true, tail: 'glitter', speed: 60, flightT: 3.3,
      });
      this._cue(T(27.2), 6, 'dahlia', 1.15, {
        palette: PAL('oasis teal'), sound: 'big', anchor: true, engine: true, tail: 'glitter', speed: 61, flightT: 3.4,
      });
      this._cue(T(35.1), 3, 'chrys', 1.15, {
        palette: PAL('blue gold'), sound: 'big', anchor: true, engine: true, tail: 'glitter', speed: 60, flightT: 3.3,
      });
      this._cue(T(42.6), 5, 'dahlia', 1.25, {
        palette: SCARLET, sound: 'big', anchor: true, engine: true, tail: 'glitter', speed: 62, flightT: 3.4,
      });
      // two all-pad hits keep the scene honest
      this._salvo(T(22.8), ALL9, 'ring', 0.6, { palette: CRIMSON, layer: 'mid', sound: 'med' });
      this._salvo(T(37.4), ALL9, 'ghost', 0.62, { palette: SCARLET, layer: 'mid', sound: 'med' });
      // one rolling fireball low over the dunes to close the tide
      this._cue(T(40.9), 11, 'lampare', 1.0, {
        palette: CRIMSON, sound: 'big', anchor: true, lift: true, speed: 24, flightT: 1.3,
      });
    }

    // ================ SCENE 3 — "LANTERN GARDEN" (45-70) ================
    // The novelty scene (HK since 2018): shaped shells mid-altitude in
    // matched pairs and trios with real breathing room between gestures.
    // The garden plants the WHOLE roster — violet, emerald, teal, copper
    // blue, blue-gold, scarlet, silver — no two consecutive gestures from
    // the same family, and every 2D shell plane faces the campsite: the
    // free upgrade over the real harbour.
    {
      const VIOLET = PAL('royal violet');
      const TEAL = PAL('oasis teal');
      const BLUEGOLD = PAL('blue gold');
      // palette pivot: a ghost-shell chase — the whole line changes color
      // in mid-air, announcing the new scene's family
      this._chase(T(45.2), 0.11, L2R, 'ghost', 0.55, { palette: VIOLET, sound: 'small' });
      // smiley trio beaming at camp
      this._volley(T(48.6), [2, 4, 6], 'smiley', 1.8, { palette: VIOLET, sound: 'med', lifts: 3 }, 0.12);
      this._mineFront(T(50.4), [11], { palette: VIOLET, size: 0.7, lifts: 1 });
      // hydrangea I: pistil rings in changing colors (NatDay 2023 scene 5)
      // — barium emerald's debut, a color the show never wore before
      this._volley(T(51.5), EVENS, 'ring', 0.95, {
        palette: PAL('barium emerald'), sound: 'small', pistil: { ratio: 0.4 },
      }, 0.08);
      // twin hearts toward camp, then a smaller echo pair
      this._volley(T(54.8), [3, 5], 'heart', 1.85, { palette: PAL('scarlet pink'), sound: 'med', lifts: 2 }, 0.1);
      this._volley(T(56.4), [2, 6], 'heart', 1.35, { palette: PAL('scarlet pink'), sound: 'small', lifts: 1 }, 0.1);
      this._volley(T(57.7), [0, 8], 'peony', 0.45, { palette: PAL('copper blue'), sound: 'small' }, 0.15);
      // silver corkscrews and butterflies — the silent novelties (the
      // butterflies in teal-over-ember, not more violet)
      this._volley(T(58.6), [1, 7], 'tourbillon', 1.3, { palette: PAL('silver'), sound: null }, 0.15);
      this._volley(T(59.5), [3, 5], 'farfalle', 1.3, { palette: PAL('teal ember'), sound: null }, 0.2);
      // emerald go-getters wriggle through the gap before the stars land
      this._volley(T(60.9), [1, 7], 'serpents', 0.9, {
        palette: PAL('barium emerald'), sound: 'small', speed: 46, flightT: 2.2,
      }, 0.2);
      // red five-pointed stars: the strongly SHAPED statement, full width
      this._volley(T(61.7), [2, 4, 6], 'star5', 1.75, { palette: PAL('strontium red'), sound: 'med', lifts: 3 }, 0.12);
      // a fish shell swims across the gap
      this._cue(T(63.2), 3, 'fish', 1.0, { palette: TEAL, sound: null, speed: 46, flightT: 2.4, lift: true });
      // hydrangea II + a saturn pair in blue-gold
      this._volley(T(64.2), ODDS, 'ring', 0.9, {
        palette: BLUEGOLD, sound: 'small', pistil: { ratio: 0.4 },
      }, 0.08);
      this._volley(T(65.6), [2, 6], 'saturn', 1.1, { palette: BLUEGOLD, sound: 'med' }, 0.3);
      this._mineFront(T(66.4), [9, 13], { palette: BLUEGOLD, size: 0.7, lifts: 1 });
      // bees: a frantic little gold swarm under the closing tableau
      this._cue(T(66.9), 4, 'bees', 1.0, { palette: GOLD, sound: null, speed: 40, flightT: 2.2, lift: true });
      // the tableau: five shapes alight at once, then breathe out
      this._cue(T(68.0), 4, 'smiley', 1.85, { palette: VIOLET, sound: 'med', lift: true, speed: 44, flightT: 2.4 });
      this._volley(T(68.1), [2, 6], 'heart', 1.5, { palette: PAL('scarlet pink'), sound: 'small', lifts: 1 }, 0.06);
      this._volley(T(68.2), [0, 8], 'star5', 1.5, { palette: PAL('strontium red'), sound: 'small', lifts: 1 }, 0.06);
    }

    // ================= SCENE 4 — "DESERT SEA" (70-90) =================
    // The lyrical scene, quiet but never empty: parachute flares hanging
    // over a shimmering mine-front, a strobewillow sea, then the Nagaoka
    // moment — ONE sanshakudama-class gold kamuro, high and alone — and
    // the niagara waterfall curtains pouring down the sky. Gold and
    // silver only. This hush is what makes the finale land.
    {
      const SILVER = PAL('silver');
      // three parachute flares drift for the whole scene
      this._cue(T(70.3), 4, 'flare', 1.0, { palette: SILVER, sound: null, speed: 60, flightT: 3.3, lift: true });
      this._mineFront(T(71.6), LOW, { palette: GOLD, size: 0.75, lifts: 1 });
      // the sea: asynchronous blinking curtains, silver on black
      this._volley(T(72.9), [3, 5], 'strobewillow', 1.0, { palette: SILVER, sound: 'small', lifts: 2 }, 0.4);
      // THE BIG ONE: gold kamuro at 2.4, max altitude, nothing else in the
      // sky for four seconds either side (~17k stars, 8 s hang — the one
      // place the budget spends like this, because the sky is otherwise dark)
      this._cue(T(76.5), 4, 'kamuro', 2.4, {
        palette: GOLD, sound: 'big', anchor: true, engine: true, tail: 'glitter',
        speed: 66, flightT: 3.7,
      });
      // THE WATERFALL — twin curtains, the CEO's moment, kept and fed.
      // (Curtain 1 is ~30k stars living 7+ s; curtain 2 rides in smaller
      // so the pair never stacks the ring while the kamuro still hangs.)
      this._curtainCue(T(81.5), [0, 2, 4, 6, 8], 1.25, 58);
      this._curtainCue(T(85.2), [1, 3, 5, 7], 0.8, 46);
      this._cue(T(86.0), 4, 'strobewillow', 0.7, { palette: SILVER, sound: null, speed: 42, flightT: 2.3 });
      // lone horsetails keep the sheet fed as it thins — small on purpose:
      // their 6 s stars share ring time with scene 5's first chases
      this._cue(T(87.5), 2, 'waterfall', 0.55, {
        palette: WATERFALL_PALETTE, sound: 'small', anchor: true, speed: 36, flightT: 2.3, spread: 0.04, lift: true,
      });
      this._cue(T(88.4), 6, 'waterfall', 0.55, {
        palette: WATERFALL_PALETTE, sound: 'small', anchor: true, speed: 36, flightT: 2.3, spread: 0.04, lift: true,
      });
    }

    // ================ SCENE 5 — "THE GATHERING" (90-120) ================
    // The build: ripple chases with the interval shrinking every pass,
    // altitude layers stacking one by one, novelty textures (bees, fish,
    // dragon eggs, thousand-bloom) threaded through, and a closing
    // accelerando that halves the volley interval until it's continuous.
    // The gathering gathers COLORS too: teal, violet, copper blue, teal
    // ember and a crimson callback to the opening all pass back through
    // before the palette narrows to gold and white at ~108 — the narrowing
    // is the crescendo, so gold has to be arrived at, not squatted on.
    {
      const BROC = PAL('golden brocade');
      // pass 1 waits for curtain 1's 7-second stars to die (~92) — peony,
      // not brocade, and light: the ring cursor laps every ~96k spawns,
      // so heavy fire here would wrap onto the curtain while it still hangs
      this._chase(T(92.2), 0.12, L2R, 'crackle', 0.55, { palette: BROC, sound: 'small' });
      this._chase(T(94.4), 0.10, R2L, 'peony', 0.58, { palette: PAL('oasis teal'), sound: 'small' });
      this._cue(T(95.2), 3, 'bees', 1.0, { palette: GOLD, sound: null, speed: 42, flightT: 2.3, lift: true });
      this._cue(T(95.9), 5, 'fish', 1.0, { palette: PAL('copper blue'), sound: null, speed: 44, flightT: 2.4 });
      this._chase(T(96.7), 0.09, OUTSIDE_IN, 'ghost', 0.62, { palette: PAL('royal violet'), sound: 'small' });
      // second layer joins: fans weaving under the chases
      this._fan(T(96.9), 10, 5, 48, -14, { palette: GOLD });
      this._fan(T(97.0), 12, 5, 48, 14, { palette: GOLD });
      // all-pad hit + mines — the opening's crimson comes back for one bar
      this._salvo(T(99.4), ALL9, 'peony', 0.65, { palette: CRIMSON, layer: 'mid', sound: 'med' });
      this._mineFront(T(99.5), [10, 12], { palette: GOLD, size: 0.9, lifts: 1 });
      // spiders: gold lightning across the whole arc, almost free
      this._chase(T(100.9), 0.08, L2R, 'spider', 0.8, { palette: GOLD, sound: 'small' });
      // dragon eggs crackle texture, teal over ember
      this._cue(T(102.5), 2, 'dragoneggs', 1.0, { palette: PAL('teal ember'), sound: null, speed: 44, flightT: 2.3, lift: true });
      this._cue(T(103.2), 6, 'dragoneggs', 1.0, { palette: PAL('teal ember'), sound: null, speed: 44, flightT: 2.3 });
      // blue-gold crossettes: the hinge — blue streaks breaking to gold,
      // the literal handover into the all-gold run. Five shells, not nine,
      // on a wider gap: every crossette star re-breaks into a beaded peony
      // (~376 spawns per split x 11 splits per shell), so a nine-shell
      // 75 ms chase piles ~37k spawns into one second and laps the ring —
      // the body's worst spike. Half the shells, double the read time.
      this._chase(T(104.0), 0.14, [8, 6, 4, 2, 0], 'crossette', 0.62, { palette: PAL('blue gold'), sound: 'small' });
      // thousand-bloom: dim ember cloud, then every ember pops at once —
      // fired into a held gap so the synchronized pop owns the sky
      this._cue(T(106.6), 4, 'thousandbloom', 1.1, {
        palette: BROC, sound: 'med', anchor: true, lift: true, speed: 56, flightT: 3.0,
      });
      this._chase(T(108.5), 0.07, OUTSIDE_IN, 'crackle', 0.6, { palette: BROC, sound: 'small' });
      // all-pad hit + the first pre-finale thunderclap
      this._salvo(T(110.7), ALL9, 'crackle', 0.68, { palette: GOLD, layer: 'mid', sound: 'med' });
      this._cue(T(110.9), 4, 'salute', 0.7, { sound: 'big', lift: true, speed: 44, flightT: 2.1 });
      this._volley(T(112.1), [2, 6], 'thousandbloom', 1.0, { palette: BROC, sound: 'med', lifts: 2 }, 0.15);
      // accelerando: trio volleys, interval 1.5 → 0.28 s — the herd breaks
      // into a stampede and hands off to the finale at full gallop
      let t = T(113.5), gap = 1.5, w = 0;
      while (t < T(119.7)) {
        const base = (w * 4) % 9;
        this._volley(t, [base, (base + 3) % 9, (base + 6) % 9], 'peony', 0.44, {
          palette: w % 2 ? GOLD : BROC, layer: w % 3 === 2 ? 'low' : 'mid', sound: 'small', lifts: 1,
        }, 0.04);
        if (w % 2 === 1) this._fan(t + 0.15, 9 + w % 5, 4, 42, w % 4 === 1 ? 13 : -13, { palette: GOLD });
        t += gap;
        gap = Math.max(0.34, gap * 0.72);
        w++;
      }
      this._cue(T(115.9), 3, 'salute', 0.7, { sound: 'big', lift: true, speed: 44, flightT: 2.1 });
      this._cue(T(118.3), 5, 'salute', 0.75, { sound: 'big', lift: true, speed: 44, flightT: 2.1 });
    }

    // ============ SCENE 6 — "SUNRISE AT MIDNIGHT" (120-150) ============
    // Finale, three stages per the harbour anatomy: ripple build → 2.5 s
    // of genuine dead air → the SUPER GOLD WALL for twelve seconds → a
    // thirty-salute terminal ripple over three giant crowns → hard cut.
    // ~45% of the show's launch events live in these thirty seconds.
    {
      const BROC = PAL('golden brocade');
      // Stage 1 (120-126.8): continuous ripple barrages, interval 0.58 →
      // 0.30 s, volleys of 2-3. Long-lived brocade only early and rarely —
      // the last three seconds are short-lived peony/spider so the sky can
      // actually go dark for the silence beat (and so the accelerando's
      // pileup doesn't ride the ring into the wall).
      let t = T(120.4), gap = 0.62, w = 0;
      while (t < T(126.8)) {
        const base = (w * 2) % 9;
        const late = t > T(124);
        const pat = w % 4 === 3 ? 'spider' : (!late && w % 4 === 1 ? 'brocade' : 'peony');
        const pads = w % 2 ? [base, (base + 4) % 9, (base + 7) % 9] : [base, (base + 5) % 9];
        this._volley(t, pads, pat, pat === 'spider' ? 0.8 : 0.46, {
          palette: w % 2 ? GOLD : BROC, layer: w % 3 === 0 ? 'low' : 'mid', sound: 'small', lifts: 1,
        }, 0.04);
        if (w % 3 === 0) {
          this._fan(t + 0.15, 9 + ((w / 3) | 0) % 5, 4, 40, ((w / 3) | 0) % 2 ? 12 : -12, { palette: GOLD });
        }
        t += gap;
        gap = Math.max(0.30, gap * 0.90);
        w++;
      }
      // SILENCE (126.8-131.7): nothing. The last break fades ~129.3 and
      // the desert gets 2.5 s of real dark — the wall lands because of it.
      // (The 14 lift thumps at 131.7 firing in the dark are the tease.)
      // The ambience beds duck ~5 dB under the wall and the salutes — the
      // gold roar owns the noise floor, the wind comes back with the dark.
      at(T(131.5), () => this.audio.duckAmbience?.(20));
      this._wall(T(131.7));
      // Stage 3 (144-148): the terminal salvo — three giant crowns to max
      // altitude, then thirty salutes rippling L→R→L→outside-in across
      // the arc OVER the wall's afterglow, sizes ramping. Salute chain is
      // exempt from demotion: it IS the point. The crowns are staggered
      // ~1.3 s so their breaks (17k + 2×10k stars) land in different
      // seconds — center crown blooms first, the twins bloom higher into
      // the back half of the chain.
      const t3 = T(144.0);
      this._cue(t3 + 0.05, 4, 'kamuro', 2.0, {
        palette: GOLD, sound: 'big', anchor: true, engine: true, tail: 'glitter', speed: 66, flightT: 3.3,
      });
      this._cue(t3 + 1.70, 1, 'dahlia', 1.25, {
        palette: BROC, sound: 'big', anchor: true, engine: true, speed: 63, flightT: 3.3,
      });
      this._cue(t3 + 1.85, 7, 'dahlia', 1.25, {
        palette: BROC, sound: 'big', anchor: true, engine: true, speed: 63, flightT: 3.3,
      });
      const ripple = [...L2R, ...R2L, ...OUTSIDE_IN];
      ripple.forEach((p, k) => {
        // reports alternate big/med: at 0.12 s spacing the ear hears one
        // accelerating thunder roll either way, but half the pileup — 30
        // simultaneous big-class voices (each towing a crackle tail) were
        // overloading the audio thread into dropouts on Quest. The final
        // two step down to med so the crescendo HANDS OFF to the triple
        // instead of stepping on it.
        this._cue(t3 + 0.35 + k * 0.12, p, 'salute', 0.55 + 0.3 * (k / ripple.length), {
          palette: PAL('silver'),
          sound: k >= ripple.length - 2 ? 'med' : k % 2 ? 'med' : 'big',
          lift: k % 3 === 0,
          speed: randRange(41, 46), flightT: randRange(2.0, 2.3),
        });
      });
      // the last word: a tight center triple, biggest reports of the night,
      // held until ~1.1 s AFTER the ripple's last report has rolled off —
      // fired inside the tail it was three more raindrops, not a last word
      [3, 5, 4].forEach((p, k) => {
        this._cue(t3 + 4.9 + k * 0.22, p, 'salute', 0.95, {
          palette: PAL('silver'), sound: 'big', lift: true, speed: 45, flightT: 2.3,
        });
      });
      // HARD CUT: last launch ≈ 149.3, last report ≈ 151.6 — then nothing
      // but glitter fallout and the echo rolling off the dunes. Black.
    }

    // ---- budget pass + freeze ----
    this._applySoundBudget();
    this._cues.sort((a, b) => a.t - b.t);
    this.cues = this._cues;
    for (const c of this._cues) at(c.t, () => this._fire(c));
    this.events.sort((a, b) => a.t - b.t);
    // duration follows the program — last scheduled report plus fallout,
    // then the desert gets quiet. Derived, so a re-cut of the finale can
    // never silently truncate the show again.
    let lastBurst = 0;
    for (const c of this._cues) lastBurst = Math.max(lastBurst, c.tBurst ?? c.t);
    this.duration = lastBurst + 4.0;
    return true;
  }

  update(dt, time) {
    if (!this.running) return;
    this.time += dt;

    while (this._ei < this.events.length && this.events[this._ei].t <= this.time) {
      this.events[this._ei++].fn();
    }

    // the zap: a knot of sparks racing along the wire toward the battery
    const run = this.sparkRun;
    if (run) {
      const n = (this.time - run.t0) / run.dur;
      if (n >= 1) {
        run.sound?.stop(0.15);
        this.sparkRun = null;
      } else if (n >= 0) {
        // ease in — it accelerates as it goes, like a burning fuse in a hurry
        const p = run.curve.getPoint(Math.pow(n, 0.8), _sparkPos);
        run.sound?.setPosition(p);
        const pool = this.fw.pool;
        const px = p.x, py = p.y, pz = p.z;
        pool.spawn(3, (i) => {
          pool.set(i,
            px + randRange(-0.02, 0.02), py + randRange(0, 0.03), pz + randRange(-0.02, 0.02),
            randRange(-0.5, 0.5), randRange(0.2, 1.0), randRange(-0.5, 0.5),
            1.4, 1.0, 0.4,
            time, randRange(0.15, 0.4),
            randRange(0.01, 0.022), 0.4, 2.4, 0);
        });
      }
    }

    // waterfall sizzle loops: wait out the shells' flight, then ride the
    // sheet down and fade with it — three voices per curtain, one span
    for (let i = this.curtains.length - 1; i >= 0; i--) {
      const c = this.curtains[i];
      if (c.delay > 0) {
        c.delay -= dt;
        if (c.delay > 0) continue;
        c.handles = c.poss.map((p) => {
          const dist = this.audio.listenerPos.distanceTo(p);
          return this.audio.play('waterfall', p, {
            gain: 0.001, loop: true, refDistance: 30, send: 0.5,
            lowpass: Math.max(1400, 9000 - dist * 55),
            rate: randRange(0.90, 1.04),
          });
        }).filter(Boolean);
        if (!c.handles.length) { this.curtains.splice(i, 1); continue; }
        for (const h of c.handles) h.setGain(c.gain);
      }
      c.t += dt;
      for (let j = 0; j < c.poss.length; j++) {
        c.poss[j].y -= c.sink * dt;
        c.handles[j]?.setPosition(c.poss[j]);
      }
      if (c.t > c.dur) {
        for (const h of c.handles) h.stop(1.2);
        this.curtains.splice(i, 1);
      } else if (c.dur - c.t < 2.5) {
        const g = c.gain * (c.dur - c.t) / 2.5;
        for (const h of c.handles) h.setGain(g);
      }
    }

    if (this._ei >= this.events.length && this.time >= this.duration) {
      this.running = false;
      for (const c of this.curtains) for (const h of c.handles ?? []) h.stop(0.5);
      this.curtains.length = 0;
      this.onEnd?.();
    }
  }
}
