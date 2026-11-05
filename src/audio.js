// Positional audio engine. Uses raw Web Audio rather than
// three.js audio so we can do things three doesn't: true speed-of-sound
// propagation delay (a shell bursting 150 m up arrives ~0.44 s late), a
// shared convolver carrying a synthesized "open desert with distant rock"
// impulse response, and a master compressor that lets the sub-bass thumps
// hit hard without clipping.

import * as THREE from 'three';
import { clamp } from './utils.js';
import {
  renderBoom, renderCrackle, renderWhoosh, renderLift, renderFuseLoop,
  renderFountainLoop, renderPinwheelLoop, renderShot, renderTorchLoop,
  renderWindLoop, renderThud, renderTick, renderDesertIR,
  renderFirecrackerLoop, renderCrackerPop, renderWaterfallLoop,
  renderColossusLoop, renderGroan, renderRustle, renderCrunch,
  renderKnock, renderSwing, renderWhistle, renderCreak,
} from './synth.js';

const SPEED_OF_SOUND = 340;

// Resource limits, not a per-second show budget. EVERY allocated playback
// graph counts, including delayed starts, loops, flat audio and fade-outs.
// Leave headroom between ordinary traffic and the absolute ceiling so an
// old rumble can fade while a fresh report starts. At the ceiling, refuse
// BEFORE allocating nodes; a fading voice is never a free slot.
export const AUDIO_LIMITS = Object.freeze({
  voices: 24,
  steadyVoices: 20,
  decorativeVoices: 12,
  loops: 8,
  hrtf: 2,
});

const finitePosition = (p) => p && [p.x, p.y, p.z].every(Number.isFinite);

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this._pos = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._quat = new THREE.Quaternion();
    this.listenerPos = new THREE.Vector3(0, 1.6, 0);
    this._bags = {};        // per-sample shuffle bags (no immediate repeats)
    this._lastVariant = {};
    this._voices = new Set();
    this._audioStats = { peakVoices: 0, peakLoops: 0, peakHrtf: 0, admitted: 0, refused: 0, retired: 0 };
    this._windLevelAt = 0;  // last time the world drove setWindLevel
  }

  // Must be called from a user gesture (button click / controller select).
  async init() {
    if (this.ctx) return;
    const ctx = new (window.AudioContext || window.webkitAudioContext)({
      // Request some callback slack on mobile. This is only a hint: the
      // hard resource limits hold even when the browser ignores it.
      latencyHint: 0.06,
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

    // Peak compression. A finite ratio and nonzero attack do NOT guarantee
    // a ceiling; the final waveshaper below catches transient overshoots.
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -2;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.001;
    this.limiter.release.value = 0.12;

    this.clipIn = ctx.createGain();
    this.clipIn.gain.value = 0.5;
    this.clip = ctx.createWaveShaper();
    const curve = new Float32Array(4097);
    for (let i = 0; i < curve.length; i++) {
      const x = 4 * i / (curve.length - 1) - 2;
      const a = Math.abs(x);
      curve[i] = Math.sign(x) * (a <= 0.8 ? a : 0.8 + 0.18 * Math.tanh((a - 0.8) / 0.18));
    }
    this.clip.curve = curve;
    this.clip.oversample = 'none';

    this.master.connect(this.shelf);
    this.shelf.connect(this.comp);
    this.comp.connect(this.limiter);
    this.limiter.connect(this.clipIn);
    this.clipIn.connect(this.clip);
    this.clip.connect(ctx.destination);

    // shared desert reverb
    this.convolver = ctx.createConvolver();
    this.convolver.buffer = renderDesertIR(ctx);
    this.wet = ctx.createGain();
    // 1.5, not the old 0.9: the per-voice send now taps PRE-panner (see
    // play()) with a 0.6 floor on its distance curve, so anything inside
    // its refDistance sees 0.6 x 1.5 = the old 0.9 exactly — the close
    // mix is unchanged, only the far field gains its missing slapback.
    this.wet.gain.value = 1.5;
    this.convolver.connect(this.wet);
    this.wet.connect(this.master);

    // ambience bus: the wind bed hangs off one gain so the show can duck
    // it under the gold wall without touching the master or the bed's own
    // wind-level automation (the two multiply; the duck wins audibly)
    this.amb = ctx.createGain();
    this.amb.gain.value = 1;
    this.amb.connect(this.master);

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
    // pinwheel: the gain passed at play() is a pre-ramp placeholder —
    // fireworks.js re-drives gain (~0.95 x spin power) and rate every frame
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
    // prop foley bank — the interaction layer plays these by name through
    // the same unknown-name-safe play() path
    variants('rustle', 2, (s) => renderRustle(ctx, s));
    variants('crunch', 2, (s) => renderCrunch(ctx, s));
    variants('knock', 2, (s) => renderKnock(ctx, s));
    variants('swing', 2, (s) => renderSwing(ctx, s));
    variants('whistle', 3, (s) => renderWhistle(ctx, s));
    variants('creak', 2, (s) => renderCreak(ctx, s));
    this.lib = lib;

    if (ctx.state === 'suspended') await ctx.resume();
    this.ready = true;

    // ambience bed (non-positional, very quiet); the world drives its
    // level through setWindLevel — if it never does, gust on our own
    this.windBed = this.playFlat('wind', { gain: 0.08, loop: true, bus: this.amb });
    this._gust = 0.4;
    this._gustTimer = setInterval(() => {
      if (Date.now() - this._windLevelAt < 6000) return; // world is driving
      this._gust = clamp(this._gust + (Math.random() * 2 - 1) * 0.35, 0, 1);
      this._setWindGain(this._gust, 1.4);
    }, 2600);
  }

  /**
   * Wind gust level, 0..1 (the world calls this from its gust scalar).
   * Maps onto the bed's gain between ~0.04 and ~0.14, always through
   * setTargetAtTime so a gust can never click. Scene 6's duckAmbience()
   * multiplies downstream on the ambience bus, so during the finale the
   * duck takes precedence over whatever the weather is doing.
   */
  setWindLevel(level) {
    this._windLevelAt = Date.now();
    this._setWindGain(level, 0.6);
  }

  _setWindGain(level, tau) {
    if (!this.windBed) return;
    const g = 0.04 + clamp(level, 0, 1) * 0.10;
    this.windBed.gainNode.gain.setTargetAtTime(g, this.ctx.currentTime, tau);
  }

  /** Duck the ambience bus ~5 dB for `seconds`, smooth both ways; the
   *  release is pre-scheduled on the context clock so a suspended context
   *  resumes it in the right place. The show fires this at the gold wall. */
  duckAmbience(seconds = 12, depth = 0.56) {
    if (!this.amb) return;
    const t = this.ctx.currentTime;
    this.amb.gain.setTargetAtTime(depth, t, 0.6);
    this.amb.gain.setTargetAtTime(1, t + seconds, 2.0);
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
    if (!arr || !arr.length) return null; // unknown sample: caller no-ops
    if (arr.length === 1) return arr[0];
    // shuffle bag: draw without replacement — a uniform pick over 3
    // variants repeats itself immediately ~30% of the time, and the ear
    // catches a doubled boom instantly
    let bag = this._bags[name];
    if (!bag || !bag.length) bag = this._bags[name] = arr.map((_, i) => i);
    let k = (Math.random() * bag.length) | 0;
    // a freshly refilled bag may still lead with the previous draw
    if (bag.length === arr.length && bag[k] === this._lastVariant[name]) {
      k = (k + 1) % bag.length;
    }
    const idx = bag.splice(k, 1)[0];
    this._lastVariant[name] = idx;
    return arr[idx];
  }

  /** Snapshot for headset debugging; counts include scheduled and fading voices. */
  getDiagnostics() {
    const live = [...this._voices];
    return {
      limits: AUDIO_LIMITS,
      voices: live.length,
      loops: live.filter((v) => v.loop).length,
      hrtf: live.filter((v) => v.hrtf).length,
      fading: live.filter((v) => v.stopping).length,
      scheduled: live.filter((v) => v.when > this.ctx.currentTime).length,
      ...this._audioStats,
      baseLatency: this.ctx?.baseLatency ?? null,
      outputLatency: this.ctx?.outputLatency ?? null,
    };
  }

  _reserveVoice(opts, attenuation) {
    const loop = !!opts.loop;
    const live = [...this._voices];
    const refuse = () => { this._audioStats.refused++; return null; };
    if (loop && live.filter((v) => v.loop).length >= AUDIO_LIMITS.loops) return refuse();
    if (opts.decorative && live.length >= AUDIO_LIMITS.decorativeVoices) return refuse();
    // Never fade an existing sound on behalf of a request we cannot admit.
    if (live.length >= AUDIO_LIMITS.voices) return refuse();
    const pri = (opts.priority ?? opts.gain ?? 1) * attenuation;
    if (live.length >= AUDIO_LIMITS.steadyVoices) {
      const now = this.ctx.currentTime;
      let worst = null;
      let score = Infinity;
      for (const v of live) {
        // Keep loops under their own limit, and preserve each report's
        // attack. Scheduled sounds haven't aged into expendable tails.
        if (v.loop || v.stopping || now < v.when + 0.12) continue;
        const rank = v.pri * Math.exp(-(now - v.when) / 1.0);
        if (rank < score) { score = rank; worst = v; }
      }
      if (worst && (loop || score < pri)) {
        worst.stop(0.02);
        this._audioStats.retired++;
      } else if (!loop) {
        return refuse();
      }
    }
    // Retiring above does not free anything! Wait for onended and node
    // disconnection before reusing that slot, even during a same-tick flood.
    const hrtf = !!opts.hrtf && live.filter((v) => v.hrtf).length < AUDIO_LIMITS.hrtf;
    const voice = { pri, loop, hrtf, stopping: false, nodes: [] };
    this._voices.add(voice);
    return voice;
  }

  _finishVoice(voice) {
    if (!this._voices.has(voice)) return;
    // Disconnect the source AND optional lowpass, not just downstream
    // gains. A slot represents the complete graph until this point.
    for (const node of voice.nodes) node.disconnect();
    this._voices.delete(voice);
  }

  /**
   * Positional sample. All playback paths share _play's admission gate.
   * opts: gain, rate, loop, send, delayBySound, refDistance, lowpass,
   * startDelay, priority, hrtf, decorative (sacrificed first under load).
   */
  play(name, position, opts = {}) {
    if (!finitePosition(position)) return null;
    return this._play(name, position, opts);
  }

  // Ambience and UI obey exactly the same resource ceiling as fireworks.
  playFlat(name, opts = {}) {
    return this._play(name, null, opts);
  }

  _play(name, position, opts) {
    if (!this.ready) return null;
    const buf = this._buffer(name);
    if (!buf) return null;
    const ctx = this.ctx;
    const level = opts.gain ?? 1;
    const rate = opts.rate ?? 1;
    const ref = opts.refDistance ?? 4;
    const delay = opts.startDelay ?? 0;
    const sendLevel = opts.send ?? 0.25;
    if (![level, rate, ref, delay, sendLevel, opts.priority ?? 1, opts.lowpass ?? 0].every(Number.isFinite)
      || level < 0 || rate <= 0 || ref <= 0 || delay < 0 || sendLevel < 0
      || (opts.lowpass ?? 0) < 0 || !finitePosition(this.listenerPos)) return null;
    const dist = position ? this.listenerPos.distanceTo(position) : 0;
    if (!Number.isFinite(dist)) return null;
    const att = ref / Math.max(dist, ref);
    const voice = this._reserveVoice(position ? opts : { ...opts, hrtf: false }, att);
    if (!voice) return null;
    const own = (node) => { voice.nodes.push(node); return node; };
    try {
      const src = own(ctx.createBufferSource());
      src.buffer = buf;
      src.loop = voice.loop;
      src.playbackRate.value = rate;
      const gain = own(ctx.createGain());
      gain.gain.value = level;
      let head = src;
      let lpNode = null;
      if (opts.lowpass) {
        lpNode = own(ctx.createBiquadFilter());
        lpNode.type = 'lowpass';
        lpNode.frequency.value = Math.min(opts.lowpass, ctx.sampleRate / 2);
        head.connect(lpNode);
        head = lpNode;
      }
      head.connect(gain);
      let panner = null;
      if (position) {
        panner = own(ctx.createPanner());
        panner.panningModel = voice.hrtf ? 'HRTF' : 'equalpower';
        panner.distanceModel = 'inverse';
        panner.refDistance = ref;
        panner.rolloffFactor = 1;
        panner.positionX.value = position.x;
        panner.positionY.value = position.y;
        panner.positionZ.value = position.z;
        gain.connect(panner);
        panner.connect(this.master);
        if (sendLevel > 0) {
          // Pre-panner reverb: retain the distance attenuation while
          // letting far shells arrive wetter. Only one shared convolver.
          const send = own(ctx.createGain());
          send.gain.value = sendLevel * att * clamp(dist / 35, 0.6, 2.6);
          const pre = own(ctx.createDelay(0.4));
          pre.delayTime.value = Math.min(0.35, dist / SPEED_OF_SOUND * 0.15);
          gain.connect(send);
          send.connect(pre);
          pre.connect(this.convolver);
        }
      } else {
        gain.connect(opts.bus ?? this.master);
      }
      voice.when = ctx.currentTime + delay + (position && opts.delayBySound ? dist / SPEED_OF_SOUND : 0);
      const stop = (fade = 0.05) => {
        if (voice.stopping || !this._voices.has(voice)) return;
        voice.stopping = true;
        const t = ctx.currentTime;
        const duration = Number.isFinite(fade) ? clamp(fade, 0.005, 2) : 0.05;
        if (gain.gain.cancelAndHoldAtTime) gain.gain.cancelAndHoldAtTime(t);
        else { gain.gain.cancelScheduledValues(t); gain.gain.setValueAtTime(gain.gain.value, t); }
        gain.gain.linearRampToValueAtTime(0, t + duration);
        src.stop(voice.when > t ? t : t + duration);
      };
      voice.stop = stop;
      const alive = () => !voice.stopping && this._voices.has(voice);
      const handle = {
        source: src, gainNode: gain, panner, stop,
        get ended() { return !alive(); },
        setPosition: (p) => {
          if (!alive() || !panner || !finitePosition(p)) return;
          const t = ctx.currentTime;
          panner.positionX.setTargetAtTime(p.x, t, 0.03);
          panner.positionY.setTargetAtTime(p.y, t, 0.03);
          panner.positionZ.setTargetAtTime(p.z, t, 0.03);
        },
        setGain: (v) => {
          if (alive() && Number.isFinite(v) && v >= 0) gain.gain.setTargetAtTime(v, ctx.currentTime, 0.03);
        },
        setRate: (v) => {
          if (alive() && Number.isFinite(v) && v > 0) src.playbackRate.setTargetAtTime(v, ctx.currentTime, 0.08);
        },
        setLowpass: (v) => {
          if (alive() && lpNode && Number.isFinite(v) && v > 0) {
            lpNode.frequency.setTargetAtTime(Math.min(v, ctx.sampleRate / 2), ctx.currentTime, 0.15);
          }
        },
      };
      src.onended = () => this._finishVoice(voice);
      src.start(voice.when);
      this._audioStats.admitted++;
      const live = [...this._voices];
      this._audioStats.peakVoices = Math.max(this._audioStats.peakVoices, live.length);
      this._audioStats.peakLoops = Math.max(this._audioStats.peakLoops, live.filter((v) => v.loop).length);
      this._audioStats.peakHrtf = Math.max(this._audioStats.peakHrtf, live.filter((v) => v.hrtf).length);
      return handle;
    } catch (err) {
      this._finishVoice(voice);
      this._audioStats.refused++;
      console.warn('Audio voice could not start', err);
      return null;
    }
  }

  /**
   * The big one. Plays a shell burst at a world position with realistic
   * propagation delay, size-scaled sample choice, slight random detune,
   * and a crackle tail when requested.
   */
  boom(position, size = 1, { crackle = false } = {}) {
    if (!this.ready || !finitePosition(position) || !Number.isFinite(size)) return;
    const name = size > 0.75 ? 'boomBig' : size > 0.45 ? 'boomMed' : 'boomSmall';
    const dist = this.listenerPos.distanceTo(position);
    // very distant booms lose their highs
    const lowpass = dist > 80 ? Math.max(900, 8000 - (dist - 80) * 40) : 0;
    const report = this.play(name, position, {
      gain: 3.0 * (0.7 + size * 0.6),
      // depth is baked into the samples now; keep rate variation tight so
      // slowing the buffer doesn't smear the report's attack into mush
      rate: (size > 0.75 ? 0.9 : 0.94) + Math.random() * 0.12,
      send: 0.4 + size * 0.25,
      delayBySound: true,
      refDistance: 12,
      lowpass: lowpass || undefined,
    });
    if (!report) return;
    // tails ride the CONTEXT clock (startDelay -> src.start(when)), not
    // setTimeout: they can't drift under main-thread load, and a suspend
    // freezes them in place instead of banking wall-clock callbacks that
    // all blare into the resumed context later
    if (crackle) {
      this.play('crackle', position, {
        decorative: true, priority: 0.4,
        gain: 1.4, rate: 0.95 + Math.random() * 0.1,
        send: 0.4, delayBySound: true, refDistance: 10, startDelay: 0.12,
      });
    } else if (size > 0.7) {
      // big shells leave a faint sizzle of burning stars after the report
      this.play('crackle', position, {
        decorative: true, priority: 0.1,
        gain: 0.45, rate: 0.78 + Math.random() * 0.08,
        send: 0.35, delayBySound: true, refDistance: 10, startDelay: 0.25,
      });
    }
  }
}
