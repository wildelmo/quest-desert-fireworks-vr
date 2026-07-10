// The detonator finale: a choreographed two-minute pyromusical (minus the
// music — the desert supplies the silence between waves). Plunging the TNT
// box sends a spark racing down the wire to a battery of mortar pads out in
// the dunes, then runs a scripted program: opening salvo, color chases, a
// hushed golden interlude, the niagara waterfall curtains (long-burning
// horsetail shells fired in a line so their striated trails pour down the
// sky in sheets), an escalation, and a barrage finale with salutes.

import * as THREE from 'three';
import { randRange, randPick, clamp } from './utils.js';
import { PALETTES } from './fireworks.js';

const WATERFALL_PALETTE = { name: 'molten silver', a: 0xfff3d8, b: 0xffd489 };
const GOLD = { name: 'pure gold', a: 0xffc04d, b: 0xfff2bb };
const PAL = (name) => PALETTES.find((p) => p.name === name) ?? randPick(PALETTES);
const _sparkPos = new THREE.Vector3();

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

    // mortar battery: an arc of pads out in the dunes north of camp,
    // 60-90 m from the campsite so the breaks fill the sky, not the lap
    this.pads = [];
    for (let i = 0; i < 9; i++) {
      const x = 6 - 44 + i * 11 + randRange(-2.5, 2.5);
      const z = -72 - Math.abs(i - 4) * 2.5 + randRange(-6, 6);
      this.pads.push(new THREE.Vector3(x, terrainHeight(x, z), z));
    }
  }

  /** Fire one shell from pad index `p` (with lateral fuzz). */
  _shell(p, pattern, size, opts = {}) {
    const pad = this.pads[clamp(p, 0, this.pads.length - 1)];
    this.fw.mortarShot(pad, {
      pattern, size,
      palette: opts.palette ?? randPick(PALETTES),
      sound: opts.sound, // mortarShot picks the report class from size
      speed: opts.speed ?? (43 + size * 12) * randRange(0.95, 1.05),
      flightT: opts.flightT ?? randRange(2.4, 2.8) + size * 0.4,
      spread: opts.spread ?? 0.10,
    });
  }

  /**
   * The waterfall moment: a line of horsetail shells timed to break
   * simultaneously, high and wide, so their trails hang as one curtain.
   * A positional molten-sizzle loop plays under it while the sheet pours.
   */
  _curtain(padIndices, size, height) {
    const flightT = 2.6;
    const speed = height / 1.55; // rough inverse of the drag/gravity arc at t=2.6
    for (const p of padIndices) {
      this._shell(p, 'waterfall', size, {
        palette: WATERFALL_PALETTE, sound: 'small',
        speed, flightT, spread: 0.03,
      });
    }
    // the frying-metal hush arrives WITH the break, not the launch — start
    // the loop after the shells' flight time, fading in as the sheet blooms
    // and holding as long as the long-burn stars actually pour (~9 s)
    const mid = this.pads[padIndices[(padIndices.length / 2) | 0]];
    const pos = new THREE.Vector3(mid.x, height * 0.6, mid.z);
    this.curtains.push({ pos, delay: flightT, t: 0, dur: 9, sink: 3.5, handle: null });
  }

  /** Build and start the full program. wireCurve carries the opening zap. */
  start(wireCurve) {
    if (this.running) return false;
    this.running = true;
    this.time = 0;
    this.events = [];
    this._ei = 0;
    const at = (t, fn) => this.events.push({ t, fn });
    const shell = (t, p, pattern, size, opts) => at(t, () => this._shell(p, pattern, size, opts));

    // --- 0-2.6s: the zap races down the wire to the battery ---
    this.sparkRun = {
      curve: wireCurve, t0: 0.15, dur: 2.45,
      sound: this.audio.play('fuse', wireCurve.getPoint(0), {
        gain: 0.9, loop: true, refDistance: 1.2, send: 0.15, rate: 1.7, hrtf: true,
      }),
    };

    // --- 3-17s: opening — one grand kamuro crown, then the sky fills ---
    shell(2.7, 4, 'kamuro', 1.8, { palette: GOLD, flightT: 3.3, speed: 62 });
    shell(6.3, 2, 'peony', 1.1);
    shell(6.9, 6, 'peony', 1.1);
    for (let i = 0; i < 10; i++) {
      shell(8.5 + i * 0.85, (i * 3 + 1) % 9, randPick(['peony', 'dahlia', 'ring', 'chrys', 'saturn']), randRange(0.8, 1.2));
    }

    // --- 18-33s: color chases, left to right and back — the return chase
    // is all ghost shells, so the whole line changes color in mid-air ---
    const palA = randPick(PALETTES), palB = randPick(PALETTES);
    for (let i = 0; i < 9; i++) {
      shell(18 + i * 0.42, i, i % 2 ? 'ring' : 'peony', 0.75, { palette: i % 2 ? palB : palA });
    }
    for (let i = 0; i < 9; i++) {
      shell(23.5 + i * 0.42, 8 - i, 'ghost', 0.75, { palette: i % 2 ? palA : palB });
    }
    shell(28.5, 4, 'crossette', 1.3);
    shell(30.2, 1, 'crossette', 1.0);
    shell(30.9, 7, 'crossette', 1.0);

    // --- 34-45s: variety wave — serpents, palms, strobes, a Saturn ---
    shell(34, 3, 'serpents', 1.2);
    shell(35.6, 5, 'palm', 1.3);
    shell(37.4, 1, 'strobe', 1.1);
    shell(38.9, 7, 'saturn', 1.3);
    shell(40.6, 4, 'serpents', 1.35);
    shell(42.4, 2, 'strobe', 1.0);
    shell(43.2, 6, 'chrys', 1.2);

    // --- 46-53s: the hush — slow golden willows over drifting horsetails,
    // and one eerie falling-leaves shell blinking between colors ---
    shell(46.5, 2, 'willow', 1.6, { palette: GOLD, flightT: 3.2, speed: 58 });
    shell(48.2, 4, 'horsetail', 1.2, { palette: GOLD, flightT: 2.8, speed: 50 });
    shell(49.5, 6, 'willow', 1.6, { palette: GOLD, flightT: 3.2, speed: 58 });
    shell(51.5, 4, 'leaves', 1.1, { flightT: 3.0, speed: 54 });

    // --- 54-70s: THE WATERFALL — twin curtains pouring down the sky ---
    at(54, () => this._curtain([0, 2, 4, 6, 8], 1.35, 62));
    at(59.5, () => this._curtain([1, 3, 5, 7], 1.1, 52));
    // lone horsetails keep the sheet fed as it thins
    shell(65, 2, 'waterfall', 0.8, { palette: WATERFALL_PALETTE, sound: 'small', flightT: 2.3, speed: 36, spread: 0.04 });
    shell(66.5, 6, 'waterfall', 0.8, { palette: WATERFALL_PALETTE, sound: 'small', flightT: 2.3, speed: 36, spread: 0.04 });

    // --- 71-90s: second build — multibreaks, then the postcard tableau:
    // the reference-photo sky, scarlet and teal dahlias flanking one huge
    // golden chrysanthemum, violet off the right shoulder ---
    shell(71.5, 4, 'timerain', 1.5, { palette: GOLD });
    shell(73.4, 1, 'multibreak', 1.2);
    shell(75.6, 7, 'multibreak', 1.2);
    shell(78, 1, 'dahlia', 1.15, { palette: PAL('scarlet pink') });
    shell(78.55, 3, 'dahlia', 1.2, { palette: PAL('teal ember') });
    shell(79.1, 4, 'chrys', 1.75, { palette: PAL('golden brocade'), flightT: 3.1, speed: 58 });
    shell(79.8, 7, 'dahlia', 1.05, { palette: PAL('royal violet') });
    shell(80.5, 8, 'dahlia', 1.0, { palette: PAL('scarlet pink') });
    shell(81.4, 0, 'dahlia', 1.0, { palette: PAL('oasis teal') });
    shell(83.5, 4, 'salute', 0.9, { sound: 'big' });
    shell(85, 2, 'palm', 1.4);
    shell(86.5, 6, 'chrys', 1.4);
    shell(88.5, 4, 'multibreak', 1.5);

    // --- 91-104s: escalation — volleys tightening ---
    let t = 91;
    let gap = 1.25;
    while (t < 104) {
      const p = (Math.random() * 9) | 0;
      shell(t, p, randPick(['peony', 'dahlia', 'ring', 'chrys', 'palm', 'brocade', 'ghost', 'saturn']), randRange(1.0, 1.4));
      if (Math.random() < 0.3) shell(t + 0.18, (p + 4) % 9, 'salute', 0.8, { sound: 'big' });
      t += gap;
      gap = Math.max(0.55, gap * 0.93);
    }

    // --- 105-122s: FINALE — the sky wall ---
    t = 105;
    while (t < 117.5) {
      shell(t, (Math.random() * 9) | 0,
        randPick(['peony', 'dahlia', 'palm', 'brocade', 'chrys', 'multibreak', 'crackle', 'kamuro', 'ghost']),
        randRange(1.2, 1.7));
      t += randRange(0.3, 0.55);
    }
    shell(118, 3, 'multibreak', 1.7, { flightT: 3.2, speed: 60 });
    shell(118.4, 5, 'multibreak', 1.7, { flightT: 3.2, speed: 60 });
    shell(119, 4, 'kamuro', 2.0, { palette: GOLD, flightT: 3.5, speed: 64 });
    // closing salute chain — the triple thunderclap that says "that's all"
    shell(121.6, 2, 'salute', 1.0, { sound: 'big', flightT: 2.2 });
    shell(122.0, 6, 'salute', 1.0, { sound: 'big', flightT: 2.2 });
    shell(122.4, 4, 'salute', 1.2, { sound: 'big', flightT: 2.4 });

    this.events.sort((a, b) => a.t - b.t);
    this.duration = 129; // last break + its echo, then the desert gets quiet
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
    // sheet down and fade with it
    for (let i = this.curtains.length - 1; i >= 0; i--) {
      const c = this.curtains[i];
      if (c.delay > 0) {
        c.delay -= dt;
        if (c.delay > 0) continue;
        const dist = this.audio.listenerPos.distanceTo(c.pos);
        c.handle = this.audio.play('waterfall', c.pos, {
          gain: 0.001, loop: true, refDistance: 30, send: 0.5,
          lowpass: Math.max(1400, 9000 - dist * 55),
          rate: randRange(0.92, 1.02),
        });
        if (!c.handle) { this.curtains.splice(i, 1); continue; }
        c.handle.setGain(1.1);
      }
      c.t += dt;
      c.pos.y -= c.sink * dt;
      c.handle.setPosition(c.pos);
      if (c.t > c.dur) {
        c.handle.stop(1.2);
        this.curtains.splice(i, 1);
      } else if (c.dur - c.t < 2.5) {
        c.handle.setGain(1.1 * (c.dur - c.t) / 2.5);
      }
    }

    if (this._ei >= this.events.length && this.time >= this.duration) {
      this.running = false;
      for (const c of this.curtains) c.handle?.stop(0.5);
      this.curtains.length = 0;
      this.onEnd?.();
    }
  }
}
