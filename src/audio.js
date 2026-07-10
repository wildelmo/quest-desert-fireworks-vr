// Positional audio engine. Uses raw Web Audio (HRTF panners) rather than
// three.js audio so we can do things three doesn't: true speed-of-sound
// propagation delay (a shell bursting 150 m up arrives ~0.44 s late), a
// shared convolver carrying a synthesized "open desert with distant rock"
// impulse response, and a master compressor that lets the sub-bass thumps
// hit hard without clipping.

import * as THREE from 'three';
import {
  renderBoom, renderCrackle, renderWhoosh, renderLift, renderFuseLoop,
  renderFountainLoop, renderPinwheelLoop, renderShot, renderTorchLoop,
  renderWindLoop, renderThud, renderTick, renderDesertIR,
  renderFirecrackerLoop, renderCrackerPop, renderWaterfallLoop,
  renderColossusLoop, renderGroan,
} from './synth.js';

const SPEED_OF_SOUND = 340;

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this._pos = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._quat = new THREE.Quaternion();
    this.listenerPos = new THREE.Vector3(0, 1.6, 0);
  }

  // Must be called from a user gesture (button click / controller select).
  async init() {
    if (this.ctx) return;
    const ctx = new (window.AudioContext || window.webkitAudioContext)({
      latencyHint: 'interactive',
    });
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 0.85;

    // Chest weight: the booms carry their energy at 40-160 Hz, give that
    // region a shelf so headphones rumble. (Quest speakers just ignore it.)
    this.shelf = ctx.createBiquadFilter();
    this.shelf.type = 'lowshelf';
    this.shelf.frequency.value = 110;
    this.shelf.gain.value = 4.5;

    // Gentle glue, not a squash: ratio 5 with a 2 ms attack was flattening
    // the report's punch envelope. Let the first ~6 ms through untouched and
    // lean on the softer knee for finale pileups.
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -12;
    this.comp.knee.value = 24;
    this.comp.ratio.value = 3.5;
    this.comp.attack.value = 0.006;
    this.comp.release.value = 0.30;

    this.master.connect(this.shelf);
    this.shelf.connect(this.comp);
    this.comp.connect(ctx.destination);

    // shared desert reverb
    this.convolver = ctx.createConvolver();
    this.convolver.buffer = renderDesertIR(ctx);
    this.wet = ctx.createGain();
    this.wet.gain.value = 0.9;
    this.convolver.connect(this.wet);
    this.wet.connect(this.master);

    // Real explosion bodies (CC0, assets/sounds/) — the dense chaotic mid
    // texture of a genuine blast that synthesis can't fake. Decoded at ctx
    // rate; on any failure the booms fall back to pure synthesis.
    let bodies = [];
    try {
      bodies = await Promise.all(
        ['assets/sounds/explosion1.wav', 'assets/sounds/explosion2.wav'].map(
          async (url) => {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`${url}: ${res.status}`);
            const decoded = await ctx.decodeAudioData(await res.arrayBuffer());
            return decoded.getChannelData(0);
          },
        ),
      );
    } catch (err) {
      console.warn('boom recordings unavailable, using pure synthesis', err);
    }
    const body = (i) => (bodies.length ? bodies[i % bodies.length] : null);

    // Sample library — several seeded variants per sound.
    const lib = {};
    const variants = (name, n, fn) => {
      lib[name] = [];
      for (let i = 0; i < n; i++) lib[name].push(fn(i + 1));
    };
    variants('boomBig', 4, (s) => renderBoom(ctx, s * 3 + 1, 1.0, body(s)));
    variants('boomMed', 4, (s) => renderBoom(ctx, s * 5 + 2, 0.6, body(s + 1)));
    variants('boomSmall', 3, (s) => renderBoom(ctx, s * 7 + 3, 0.3, body(s)));
    variants('crackle', 3, (s) => renderCrackle(ctx, s));
    // the launch swoosh granulates the real blast recordings into its
    // turbulence bed — same "real chaos" trick as the booms
    variants('whoosh', 4, (s) => renderWhoosh(ctx, s, body(s)));
    variants('lift', 3, (s) => renderLift(ctx, s));
    variants('fuse', 2, (s) => renderFuseLoop(ctx, s));
    variants('fountain', 2, (s) => renderFountainLoop(ctx, s));
    variants('pinwheel', 2, (s) => renderPinwheelLoop(ctx, s));
    variants('shot', 4, (s) => renderShot(ctx, s));
    variants('firecrackers', 2, (s) => renderFirecrackerLoop(ctx, s));
    variants('cracker', 4, (s) => renderCrackerPop(ctx, s));
    variants('waterfall', 2, (s) => renderWaterfallLoop(ctx, s));
    variants('colossus', 2, (s) => renderColossusLoop(ctx, s));
    variants('groan', 3, (s) => renderGroan(ctx, s));
    variants('torch', 1, (s) => renderTorchLoop(ctx, s));
    variants('wind', 1, (s) => renderWindLoop(ctx, s));
    variants('thud', 2, (s) => renderThud(ctx, s));
    variants('tick', 1, (s) => renderTick(ctx, s));
    this.lib = lib;

    if (ctx.state === 'suspended') await ctx.resume();
    this.ready = true;

    // ambience bed (non-positional, very quiet)
    this.playFlat('wind', { gain: 0.08, loop: true });
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  /**
   * Master on/off for the whole engine. Called when entering/leaving VR or
   * desktop mode and on tab visibility changes, so quitting the headset
   * doesn't leave desert wind playing in a flat browser tab. Fades the
   * master bus, then suspends the context entirely (no CPU, no sound).
   */
  setActive(on) {
    if (!this.ctx) return;
    this._wantActive = on;
    clearTimeout(this._suspendTimer);
    if (on) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      this.master.gain.setTargetAtTime(0.85, this.ctx.currentTime, 0.1);
    } else {
      this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.08);
      this._suspendTimer = setTimeout(() => {
        if (!this._wantActive && this.ctx.state === 'running') this.ctx.suspend();
      }, 450);
    }
  }

  updateListener(camera) {
    if (!this.ready) return;
    const l = this.ctx.listener;
    camera.getWorldPosition(this._pos);
    this.listenerPos.copy(this._pos);
    // world quaternion: desktop keeps yaw on the player rig, not the camera
    camera.getWorldQuaternion(this._quat);
    this._fwd.set(0, 0, -1).applyQuaternion(this._quat);
    this._up.set(0, 1, 0).applyQuaternion(this._quat);
    const t = this.ctx.currentTime;
    if (l.positionX) {
      const T = 0.05;
      l.positionX.setTargetAtTime(this._pos.x, t, T);
      l.positionY.setTargetAtTime(this._pos.y, t, T);
      l.positionZ.setTargetAtTime(this._pos.z, t, T);
      l.forwardX.setTargetAtTime(this._fwd.x, t, T);
      l.forwardY.setTargetAtTime(this._fwd.y, t, T);
      l.forwardZ.setTargetAtTime(this._fwd.z, t, T);
      l.upX.setTargetAtTime(this._up.x, t, T);
      l.upY.setTargetAtTime(this._up.y, t, T);
      l.upZ.setTargetAtTime(this._up.z, t, T);
    } else {
      l.setPosition(this._pos.x, this._pos.y, this._pos.z);
      l.setOrientation(this._fwd.x, this._fwd.y, this._fwd.z, this._up.x, this._up.y, this._up.z);
    }
  }

  _buffer(name) {
    const arr = this.lib[name];
    return arr[(Math.random() * arr.length) | 0];
  }

  /**
   * Play a sample at a world position.
   * opts: gain, rate, loop, send (reverb send 0..1), delayBySound (bool),
   *       refDistance, hf (extra lowpass for distance haze)
   */
  play(name, position, opts = {}) {
    if (!this.ready) return null;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this._buffer(name);
    src.loop = !!opts.loop;
    src.playbackRate.value = opts.rate ?? 1;

    const panner = ctx.createPanner();
    // HRTF is per-sample convolution — reserve it for close, persistent
    // sources (fuse, torch, fountains); one-shot booms during a finale can
    // pile up 20+ voices and equalpower is indistinguishable at range.
    panner.panningModel = opts.hrtf ? 'HRTF' : 'equalpower';
    panner.distanceModel = 'inverse';
    panner.refDistance = opts.refDistance ?? 4;
    panner.rolloffFactor = 1;
    panner.positionX.value = position.x;
    panner.positionY.value = position.y;
    panner.positionZ.value = position.z;

    const gain = ctx.createGain();
    gain.gain.value = opts.gain ?? 1;

    let head = src;
    let lpNode = null;
    if (opts.lowpass) {
      lpNode = ctx.createBiquadFilter();
      lpNode.type = 'lowpass';
      lpNode.frequency.value = opts.lowpass;
      head.connect(lpNode);
      head = lpNode;
    }
    head.connect(gain);
    gain.connect(panner);
    panner.connect(this.master);

    const send = ctx.createGain();
    send.gain.value = opts.send ?? 0.25;
    panner.connect(send);
    send.connect(this.convolver);

    let when = ctx.currentTime;
    if (opts.delayBySound) {
      const dist = this.listenerPos.distanceTo(position);
      when += dist / SPEED_OF_SOUND;
    }
    src.start(when);

    const handle = {
      source: src,
      gainNode: gain,
      panner,
      stop(fade = 0.05) {
        try {
          gain.gain.setTargetAtTime(0, ctx.currentTime, fade / 3);
          src.stop(ctx.currentTime + fade + 0.1);
        } catch { /* already stopped */ }
      },
      setPosition(p) {
        const t = ctx.currentTime;
        panner.positionX.setTargetAtTime(p.x, t, 0.03);
        panner.positionY.setTargetAtTime(p.y, t, 0.03);
        panner.positionZ.setTargetAtTime(p.z, t, 0.03);
      },
      setGain(v) {
        gain.gain.setTargetAtTime(v, ctx.currentTime, 0.03);
      },
      setRate(v) {
        src.playbackRate.setTargetAtTime(v, ctx.currentTime, 0.08);
      },
      // only live when the sound was started with a lowpass — long-lived
      // loops (the colossus roar) re-tilt as the listener walks nearer
      setLowpass(v) {
        lpNode?.frequency.setTargetAtTime(v, ctx.currentTime, 0.15);
      },
    };
    src.onended = () => {
      try {
        gain.disconnect(); panner.disconnect(); send.disconnect();
      } catch { /* noop */ }
    };
    return handle;
  }

  // Non-positional (ambience / UI)
  playFlat(name, opts = {}) {
    if (!this.ready) return null;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this._buffer(name);
    src.loop = !!opts.loop;
    src.playbackRate.value = opts.rate ?? 1;
    const gain = ctx.createGain();
    gain.gain.value = opts.gain ?? 1;
    src.connect(gain);
    gain.connect(this.master);
    src.start();
    return {
      source: src,
      stop(fade = 0.1) {
        try {
          gain.gain.setTargetAtTime(0, ctx.currentTime, fade / 3);
          src.stop(ctx.currentTime + fade + 0.1);
        } catch { /* already stopped */ }
      },
      setGain(v) { gain.gain.setTargetAtTime(v, ctx.currentTime, 0.05); },
    };
  }

  /**
   * The big one. Plays a shell burst at a world position with realistic
   * propagation delay, size-scaled sample choice, slight random detune,
   * and a crackle tail when requested.
   */
  boom(position, size = 1, { crackle = false } = {}) {
    if (!this.ready) return;
    const name = size > 0.75 ? 'boomBig' : size > 0.45 ? 'boomMed' : 'boomSmall';
    const dist = this.listenerPos.distanceTo(position);
    // very distant booms lose their highs
    const lowpass = dist > 80 ? Math.max(900, 8000 - (dist - 80) * 40) : 0;
    this.play(name, position, {
      gain: 3.0 * (0.7 + size * 0.6),
      // depth is baked into the samples now; keep rate variation tight so
      // slowing the buffer doesn't smear the report's attack into mush
      rate: (size > 0.75 ? 0.9 : 0.94) + Math.random() * 0.12,
      send: 0.4 + size * 0.25,
      delayBySound: true,
      refDistance: 12,
      lowpass: lowpass || undefined,
    });
    if (crackle) {
      setTimeout(() => {
        this.play('crackle', position, {
          gain: 1.4, rate: 0.95 + Math.random() * 0.1,
          send: 0.4, delayBySound: true, refDistance: 10,
        });
      }, 120);
    } else if (size > 0.7) {
      // big shells leave a faint sizzle of burning stars after the report
      setTimeout(() => {
        this.play('crackle', position, {
          gain: 0.45, rate: 0.78 + Math.random() * 0.08,
          send: 0.35, delayBySound: true, refDistance: 10,
        });
      }, 250);
    }
  }
}
