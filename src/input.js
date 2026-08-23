// Interaction: grabbing, planting, lighting, throwing.
//
// VR:      grip to grab (fireworks or the torch), release near the sand to
//          plant at whatever angle you're holding, or let go mid-swing to
//          throw (release hands the item its hand velocity). Touch the torch
//          flame to a fuse to light it. Left stick walks (comfort vignette),
//          right stick snap-turns (blink flash). Haptics run through a small
//          per-hand mixer: grabs/ignites preempt ambient booms and rumbles.
// Desktop: WASD + pointer-lock mouse, E grab/drop, scroll tilts, click plants
//          or lights, F quick-launches a rocket. Shares the same plant/ignite
//          logic so the whole game is testable without a headset.

import * as THREE from 'three';
import { terrainHeight, terrainNormal } from './terrain.js';
import { clamp, randRange, randPick } from './utils.js';

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _fA = new THREE.Vector3();
const _fB = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _qA = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);
const RIGHT = new THREE.Vector3(1, 0, 0);
const _grabList = []; // grabbables() scratch — consumed synchronously

const GRAB_RADIUS = 0.22;
const HOVER_RADIUS = GRAB_RADIUS * 1.4; // "you could grab this" halo range
const RING_N = 4;                // grip pose ring frames for throw velocity
const RELEASE_DEBOUNCE = 0.12;   // s the grip must stay open to count
const PLANT_MAX_HEIGHT = 0.35;   // base must be this close to the ground
const FLAME_LIGHT_RADIUS = 0.16; // capsule-to-fuse distance that catches
const FLAME_GLOW_RADIUS = 0.32;  // fuse tip warms up on approach (2x light)

// ---------------------------------------------------------------------------
// comfort overlay: one head-locked quad drives the locomotion vignette and
// the snap-turn / teleport blink. teleport.js imports this directly so
// world.js never has to know about it. ?comfort=0 disables the visuals
// (haptics are not comfort visuals and stay on).

const COMFORT_VISUALS = typeof location === 'undefined'
  || new URLSearchParams(location.search).get('comfort') !== '0';

export const comfort = {
  hands: null,   // set by Interactions: dual-hand arrival thump
  _mesh: null,
  _mat: null,
  _loco: 0,
  _locoTarget: 0,
  _flash: 0,
  _hold: 0,
  _fadeDur: 0.1,

  bind(camera) {
    if (!COMFORT_VISUALS || this._mesh) return;
    const mat = new THREE.ShaderMaterial({
      uniforms: { uVig: { value: 0 }, uFlash: { value: 0 } },
      // ndc-based radius: the vignette hugs the screen edge per eye no
      // matter the fov, and the quad itself can be lazily oversized
      vertexShader: `
        varying vec2 vNdc;
        void main() {
          vec4 cp = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          vNdc = cp.xy / cp.w;
          gl_Position = cp;
        }`,
      fragmentShader: `
        uniform float uVig;
        uniform float uFlash;
        varying vec2 vNdc;
        void main() {
          float d = length(vNdc);
          float a = clamp(uFlash + uVig * smoothstep(0.55, 1.15, d), 0.0, 1.0);
          gl_FragColor = vec4(0.0, 0.0, 0.0, a);
        }`,
      transparent: true, depthTest: false, depthWrite: false,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    // camera child: in webxr the camera object tracks the head, so this quad
    // is glued to the view in both modes
    mesh.position.z = -0.35;
    mesh.scale.set(4, 4, 1);
    mesh.renderOrder = 9999;
    mesh.frustumCulled = false;
    mesh.visible = false;
    camera.add(mesh);
    this._mesh = mesh;
    this._mat = mat;
  },

  /** smooth-stick speed 0..1, re-asserted every moving frame; decays when absent */
  setLocomotion(mag) {
    this._locoTarget = Math.max(this._locoTarget, clamp(mag, 0, 1) * 0.55);
  },

  /** snap turn: a 60-80 ms dip to dark */
  snapFlash() {
    if (!COMFORT_VISUALS) return;
    this._flash = Math.max(this._flash, 0.85);
    this._hold = Math.max(this._hold, 0.07);
    this._fadeDur = 0.07;
  },

  /** teleport landed: full blink (the move itself stays synchronous) + arrival thump */
  teleported() {
    if (COMFORT_VISUALS) {
      this._flash = 1;
      this._hold = 0.12;
      this._fadeDur = 0.15;
    }
    if (this.hands) for (const h of this.hands) h.pulse?.(0.4, 90, 2);
  },

  clear() {
    this._loco = 0; this._locoTarget = 0; this._flash = 0; this._hold = 0;
    if (this._mesh) this._mesh.visible = false;
  },

  update(dt) {
    // vignette eases toward the stick speed (~0.15 s either way)
    this._loco += (this._locoTarget - this._loco) * Math.min(1, dt * 10);
    if (this._loco < 0.003) this._loco = 0;
    this._locoTarget = 0;
    if (this._hold > 0) this._hold -= dt;
    else if (this._flash > 0) this._flash = Math.max(0, this._flash - dt / this._fadeDur);
    if (!this._mat) return;
    this._mat.uniforms.uVig.value = this._loco;
    this._mat.uniforms.uFlash.value = this._flash;
    this._mesh.visible = this._loco > 0.002 || this._flash > 0.002;
  },
};

function makeGhostRing() {
  const group = new THREE.Group();
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.14, 0.012, 8, 24),
    new THREE.MeshBasicMaterial({ color: 0x7fff9a, transparent: true, opacity: 0.55, depthWrite: false }),
  );
  ring.rotation.x = Math.PI / 2;
  group.add(ring);
  group.visible = false;
  group.userData.mat = ring.material; // tinted red/green by plant validity
  return group;
}

// soft radial sprite for the per-hand grab halo (item materials are cached
// and shared across siblings — never touch their emissive for this)
let _haloTex = null;
function haloTexture() {
  if (_haloTex) return _haloTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,0.85)');
  grad.addColorStop(0.45, 'rgba(255,255,255,0.25)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  _haloTex = new THREE.CanvasTexture(c);
  return _haloTex;
}

// world-space point the hand should be near to grab this item
function grabCenter(item, out) {
  out.set(0, item.grabY ?? 0.1, 0);
  return item.root.localToWorld(out);
}

// Distance from a hand to the item's whole central axis (base to tip), so a
// torch or rocket can be grabbed anywhere along its stick — much more
// forgiving than a single grab point.
const _segA = new THREE.Vector3();
const _segB = new THREE.Vector3();
const _segAB = new THREE.Vector3();
const _segP = new THREE.Vector3();
function grabDistance(item, point, outClosest = null) {
  // belts: the strand is a world-space rope — you can grab it anywhere
  if (item.beltPts) {
    let best = Infinity, bp = null;
    for (const pt of item.beltPts) {
      const d = pt.p.distanceTo(point);
      if (d < best) { best = d; bp = pt.p; }
    }
    if (outClosest && bp) outClosest.copy(bp);
    return best;
  }
  _segA.set(0, 0, 0);
  item.root.localToWorld(_segA);
  _segB.set(0, item.grabTop ?? ((item.grabY ?? 0.1) * 2), 0);
  item.root.localToWorld(_segB);
  _segAB.subVectors(_segB, _segA);
  const lenSq = _segAB.lengthSq();
  const t = lenSq > 1e-8
    ? clamp(_segP.subVectors(point, _segA).dot(_segAB) / lenSq, 0, 1)
    : 0;
  _segP.copy(_segA).addScaledVector(_segAB, t);
  if (outClosest) outClosest.copy(_segP);
  return _segP.distanceTo(point);
}

// point-to-segment distance (the torch flame is a short capsule, not a point)
function segPointDist(a, b, p) {
  _segAB.subVectors(b, a);
  const lenSq = _segAB.lengthSq();
  const t = lenSq > 1e-8
    ? clamp(_segP.subVectors(p, a).dot(_segAB) / lenSq, 0, 1)
    : 0;
  return _segP.copy(a).addScaledVector(_segAB, t).distanceTo(p);
}

export class Interactions {
  constructor({ scene, camera, player, renderer, fireworks, world, audio }) {
    this.scene = scene;
    this.camera = camera;
    this.player = player;
    this.renderer = renderer;
    this.fireworks = fireworks;
    this.world = world;
    this.audio = audio;

    this.ghost = makeGhostRing();
    this.ghostMat = this.ghost.userData.mat;
    scene.add(this.ghost);

    this.hands = []; // XR hands
    this.desktop = null;
    this.onExit = null; // set by main.js: leave to the menu
    this._glowMax = 0;  // strongest fuseGlow this frame (torch-hand rumble)

    // the torch's staked home: releasing it near here racks it back upright
    this.torchHome = world.torch.root.position.clone();
    this.torchHomeQuat = world.torch.root.quaternion.clone();

    // comfort overlay rides the camera; teleport.js pokes the same singleton
    comfort.bind(camera);
    comfort.hands = this.hands;

    // haptic hook for explosions
    fireworks.onBoom = (pos, size) => this.onBoom(pos, size);

    // leaving vr: dump queued haptics and any comfort fade mid-flight
    renderer.xr?.addEventListener?.('sessionend', () => {
      for (const h of this.hands) h.resetFeel?.();
      comfort.clear();
    });
  }

  grabbables() {
    // held items stay in the list so the other hand can take them over.
    // reused module array: this runs per hand per frame for the hover halo
    const list = _grabList;
    list.length = 0;
    for (const item of this.fireworks.items) {
      if (item.state === 'idle' || item.state === 'planted' || item.state === 'lying'
        || item.state === 'held') list.push(item);
      // an erupting fountain, firing candle, spinning pinwheel or ripping
      // belt can be picked back up (bravely) and waved around
      else if (item.state === 'active'
        && (item.type.kind === 'fountain' || item.type.kind === 'candle'
          || item.type.kind === 'pinwheel' || item.type.kind === 'belt')) list.push(item);
    }
    list.push(this.world.torch);
    return list;
  }

  // ---- shared actions ----

  grab(item, holderObject, holderTag, grabPoint = null) {
    if (item.holder) return false;
    item.holder = holderTag;
    // 'active' (erupting fountain, firing candle) and 'spent' keep their
    // state — overwriting would let the item read as unlit and re-ignite
    if (item.state !== 'active' && item.state !== 'spent') item.state = 'held';
    item.fallVel = 0;
    // a re-grabbed item must not remember its last throw
    item.vel = null;
    item.angVel = null;
    if (item.slotHome) item.slotHome.notifyTaken(item);
    holderObject.attach(item.root);
    item.onGrabbed?.(holderObject, grabPoint); // belts pin the rope point nearest the grab
    this.audio.play('rustle', grabCenter(item, _v1), { gain: 0.7, refDistance: 0.8 });
    return true;
  }

  /** Release a held item; plants it if its base is near the ground. */
  release(item) {
    item.holder = null;
    this.scene.attach(item.root);

    if (item.isTorch) {
      // let go over the stake spot and it racks itself back upright
      const home = this.torchHome;
      const p = item.root.position;
      if (home && Math.hypot(p.x - home.x, p.z - home.z) < 0.35
        && Math.abs(p.y - home.y) < 1.2) {
        p.copy(home);
        item.root.quaternion.copy(this.torchHomeQuat);
        item.state = 'idle';
        item.fallVel = 0;
        this.audio.play('knock', home, { gain: 0.7, refDistance: 1.0 });
        return 'staked';
      }
      item.state = 'idle';
      item.fallVel = -0.01;
      return 'dropped';
    }

    // a rocket whose motor lit in your grip: letting go IS the launch — the
    // flight integrator picks it up from right here, mid-air
    if (item.state === 'active' && item.type.kind === 'rocket') {
      return 'dropped';
    }

    // belts fly with whatever momentum the rope carries — the verlet sim
    // owns the fall and the drape, so no plant/topple logic applies
    if (item.type.kind === 'belt') {
      if (item.state !== 'active' && item.state !== 'spent') item.state = 'lying';
      return 'dropped';
    }

    const p = item.root.position;
    const groundY = terrainHeight(p.x, p.z);
    const canSettle = p.y - groundY < PLANT_MAX_HEIGHT && item.axis(_v1).y > 0.2;

    // terminal/self-running states keep their state: an erupting fountain set
    // down keeps erupting, a spent husk stays spent (never resurrect it)
    if (item.state === 'active' || item.state === 'spent') {
      if (canSettle) {
        p.y = groundY;
        this.audio.play('thud', p, { gain: 0.9, refDistance: 1.2 });
      } else {
        item.fallVel = -0.01;
      }
      return 'dropped';
    }

    if (canSettle) {
      // planting a lit one still works — brave
      p.y = groundY;
      item.state = 'planted';
      // a stick pushed into sand crunches; the thud was a crate sound
      this.audio.play('crunch', p, { gain: 0.9, refDistance: 1.2 });
      return 'planted';
    }
    item.state = 'lying';
    item.fallVel = -0.01;
    return 'dropped';
  }

  /**
   * Sweep the torch flame (a short capsule from flamePos toward flameTip)
   * against every unlit fuse. Fuse tips inside the glow radius get
   * item.fuseGlow = 0..1 (1 = touching) for the renderer to brighten;
   * inside the light radius the fuse catches.
   */
  tryIgniteNear(flamePos, flameTip = flamePos, igniterHand = null) {
    let lit = null;
    let glowMax = 0;
    for (const item of this.fireworks.items) {
      if (item.isLit || item.state === 'active' || item.state === 'spent') {
        item.fuseGlow = 0;
        continue;
      }
      const fuse = item.fuseWorldPos(_v2);
      const d = segPointDist(flamePos, flameTip, fuse);
      item.fuseGlow = d < FLAME_GLOW_RADIUS ? 1 - d / FLAME_GLOW_RADIUS : 0;
      if (item.fuseGlow > glowMax) glowMax = item.fuseGlow;
      if (d < FLAME_LIGHT_RADIUS && !lit && item.ignite()) {
        lit = item;
        item.fuseGlow = 0; // the burning fuse takes over from here
        igniterHand?.pulse(0.7, 90, 2);
        // the hand HOLDING the item that just caught feels it too
        if (item.holder && item.holder !== igniterHand) item.holder.pulse?.(0.9, 140, 2);
      }
    }
    this._glowMax = glowMax;
    return lit;
  }

  updateGhost(item) {
    // plant preview under a held firework (not one already going off, and
    // not a belt — belts drape, they don't plant)
    if (!item || item.isTorch || item.state === 'active' || item.type.kind === 'belt') { this.ghost.visible = false; return; }
    const p = item.root.getWorldPosition(_v1);
    const groundY = terrainHeight(p.x, p.z);
    const axis = item.axis(_v2);
    // honest ghost: stays visible, green only when this release will plant,
    // red when it's too high off the sand or held too flat
    const ok = p.y - groundY < PLANT_MAX_HEIGHT && axis.y > 0.2;
    this.ghost.visible = true;
    this.ghost.position.set(p.x, groundY + 0.02, p.z);
    this.ghost.quaternion.setFromUnitVectors(UP, terrainNormal(p.x, p.z, _v3));
    this.ghostMat.color.setHex(ok ? 0x7fff9a : 0xff4040);
    this.ghostMat.opacity = ok ? 0.55 : 0.4;
  }

  onBoom(pos, size) {
    // haptic thump scaled by proximity, on both controllers — scheduled on
    // the per-hand mixer at sound-arrival time (low priority: a grab or an
    // ignite in the same instant wins the actuator)
    const dist = this.camera.getWorldPosition(_v1).distanceTo(pos);
    const k = clamp(1.6 * size / Math.max(1, dist / 14), 0, 1);
    if (k > 0.03) {
      const delayMs = (dist / 340) * 1000;
      for (const h of this.hands) h.pulse(k, 120 + size * 120, 0, delayMs);
    }
  }

  update(dt, time) {
    // torch lights fuses wherever it is (held or staked): sweep the flame
    // capsule first so fuseGlow / rumble read this frame's pose
    const torch = this.world.torch;
    const flamePos = torch.flameWorldPos(_fA);
    torch.root.getWorldQuaternion(_q1);
    const flameTip = _fB.set(0, 1, 0).applyQuaternion(_q1).multiplyScalar(0.14).add(flamePos);
    const holderHand = this.hands.find((h) => h.held === torch) ?? null;
    this.tryIgniteNear(flamePos, flameTip, holderHand);

    // in-hand feel: fuse rumble ramps toward the pop; an erupting item held
    // on rumbles flat out; the torch hand feels a fuse warming under it
    for (const h of this.hands) {
      let amp = 0;
      const it = h.held;
      if (it && !it.isTorch) {
        if (it.state === 'active') amp = 0.25;
        else if (it.fuseRemaining > 0 && it.type?.fuseTime) {
          amp = 0.05 + 0.2 * (1 - clamp(it.fuseRemaining / it.type.fuseTime, 0, 1));
        }
      }
      if (h === holderHand) amp = Math.max(amp, 0.15 * this._glowMax);
      h.setRumble(amp);
    }

    let heldForGhost = null;
    for (const h of this.hands) {
      h.update(dt);
      if (h.held && !h.held.isTorch) heldForGhost = h.held;
    }
    if (this.desktop) {
      this.desktop.update(dt);
      if (this.desktop.held && !this.desktop.held.isTorch) heldForGhost = this.desktop.held;
    }
    this.updateGhost(heldForGhost);

    comfort.update(dt);
  }
}

// ---------------------------------------------------------------------------
// XR hand (one controller)

function buildControllerVisual(handedness) {
  const group = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.022, 0.07, 3, 8),
    // smooth dark plastic, like the real controller in your hand
    new THREE.MeshStandardMaterial({ color: 0x2a2d38, roughness: 0.4, metalness: 0.1, envMapIntensity: 0.8 }),
  );
  body.rotation.x = Math.PI / 2.6;
  group.add(body);
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.042, 0.007, 6, 18),
    new THREE.MeshStandardMaterial({
      color: 0x11131a, roughness: 0.5,
      emissive: handedness === 'left' ? 0x2f6fff : 0xff7a30,
      emissiveIntensity: 0.35,
    }),
  );
  ring.rotation.x = Math.PI / 2.6;
  ring.position.z = -0.02;
  group.add(ring);
  return group;
}

export class XRHand {
  constructor(index, interactions) {
    this.ix = interactions;
    const { renderer } = interactions;
    this.grip = renderer.xr.getControllerGrip(index);
    this.grip.name = `grip${index}`;
    interactions.player.add(this.grip);
    this.held = null;
    this.gamepad = null;
    this.handedness = null;
    this.visual = null;
    this.snapReady = true;

    // ring of recent grip poses — release differentiates it into a throw
    this._ring = [];
    for (let i = 0; i < RING_N; i++) {
      this._ring.push({ t: -1, p: new THREE.Vector3(), q: new THREE.Quaternion() });
    }
    this._ringHead = 0;
    this._throwVel = new THREE.Vector3();
    this._throwAng = new THREE.Vector3();
    this._throwValid = false;

    // grip hysteresis: events and the analog value merge into one edge;
    // release waits out a short debounce so a knuckle flutter can't launch
    // a lit rocket
    this._gripDown = false;
    this._releaseTimer = -1;

    // haptic mixer: queued one-shots by priority over an ambient rumble bed
    this._hq = [];
    this._rumble = 0;
    this._hUntil = 0;
    this._hPrio = -1;
    this._hAmp = 0;

    // hover halo state
    this._hoverItem = null;
    this._hoverPt = new THREE.Vector3();
    this.halo = null;

    this.grip.addEventListener('connected', (e) => {
      this.gamepad = e.data.gamepad ?? null;
      this.handedness = e.data.handedness;
      if (!this.visual) {
        this.visual = buildControllerVisual(this.handedness);
        this.grip.add(this.visual);
      }
    });
    this.grip.addEventListener('disconnected', () => {
      this.gamepad = null;
      // don't strand a held item (or the torch, or the plunger!) on a dead
      // controller — that hand could otherwise never grab again
      if (this.held) {
        this.ix.release(this.held);
        this.held = null;
      }
      if (this.plunger) {
        this.plunger.endGrab();
        this.plunger = null;
      }
      this.resetFeel();
    });
    this.grip.addEventListener('squeezestart', () => this._gripEdge(true));
    this.grip.addEventListener('squeezeend', () => this._gripEdge(false));
    // trigger also grabs — friendlier for first-time players
    this.grip.addEventListener('selectstart', () => { if (!this.held) this._gripEdge(true, true); });
    this.grip.addEventListener('selectend', () => { if (this.triggerHeld) this._gripEdge(false, true); });
  }

  /**
   * Schedule a haptic event. prio: 2 = direct touch (grab/ignite/pass),
   * 1 = ui ticks, 0 = ambient (booms). delayMs lets booms arrive with their
   * sound. The mixer in update() plays the strongest due event; call sites
   * that only pass (intensity, ms) still work.
   */
  pulse(intensity, ms, prio = 1, delayMs = 0) {
    this._hq.push({ due: performance.now() + delayMs, amp: intensity, dur: ms, prio });
  }

  /** ambient rumble bed 0..1, re-asserted every frame (0 = off) */
  setRumble(amp) {
    this._rumble = amp;
  }

  resetFeel() {
    this._hq.length = 0;
    this._rumble = 0;
    this._hUntil = 0;
    this._hPrio = -1;
    this._hAmp = 0;
    this._releaseTimer = -1;
    this._gripDown = false;
    if (this.halo) this.halo.visible = false;
    this._hoverItem = null;
  }

  // raw actuator with fallback: xr hapticActuators, else gamepad rumble
  _fireHaptic(amp, ms, prio, nowMs) {
    this._hUntil = nowMs + ms;
    this._hPrio = prio;
    this._hAmp = amp;
    const gp = this.gamepad;
    const a = clamp(amp, 0, 1);
    const act = gp?.hapticActuators?.[0];
    if (act?.pulse) {
      try { act.pulse(a, ms); return; } catch { /* unsupported */ }
    }
    const va = gp?.vibrationActuator;
    if (va?.playEffect) {
      try { va.playEffect('dual-rumble', { duration: ms, strongMagnitude: a, weakMagnitude: a * 0.6 }); } catch { /* no-op */ }
    }
  }

  _updateHaptics(nowMs) {
    const q = this._hq;
    // pick the strongest due event (priority first, then amplitude), drop
    // the rest of the due ones — that's the mix
    let win = null;
    for (let i = q.length - 1; i >= 0; i--) {
      const e = q[i];
      if (e.due > nowMs) continue;
      if (!win || e.prio > win.prio || (e.prio === win.prio && e.amp > win.amp)) win = e;
      q[i] = q[q.length - 1];
      q.pop();
    }
    if (win) {
      const activeLive = nowMs < this._hUntil;
      if (!activeLive || win.prio > this._hPrio
        || (win.prio === this._hPrio && win.amp >= this._hAmp)) {
        this._fireHaptic(win.amp, win.dur, win.prio, nowMs);
      }
    } else if (this._rumble > 0.02 && nowMs >= this._hUntil) {
      // ambient bed refreshes itself whenever nothing louder is playing
      this._fireHaptic(this._rumble, 70, -1, nowMs);
    }
  }

  // true when `item` is in the other hand and this grip isn't reaching for
  // a part clearly away from the holder — hand-offs mean grabbing the free
  // end, not fumbling at the same spot
  _stealBlocked(item, d, gripPos) {
    const holder = item.holder;
    if (!holder || holder === this || !holder.grip) return false;
    return d >= holder.grip.getWorldPosition(_v2).distanceTo(gripPos) * 0.6;
  }

  onSqueeze(fromTrigger = false) {
    if (this.held || this.plunger) return;
    const gripPos = this.grip.getWorldPosition(_v1);

    // grabbing the EXIT sign board leaves the game
    const exitBoard = this.ix.world.exitBoard;
    if (exitBoard && exitBoard.getWorldPosition(_v2).distanceTo(gripPos) < 0.3) {
      this.pulse(0.5, 80, 2);
      this.ix.onExit?.();
      return;
    }

    // teleport wayposts: grabbing the glowing ring rides it
    for (const tp of this.ix.world.teleporters ?? []) {
      if (tp.ringWorldPos(_v2).distanceTo(gripPos) < 0.32) {
        if (tp.use(this.ix.player, this.ix.camera)) this.pulse(0.8, 140, 2);
        return;
      }
    }

    let best = null, bestD = GRAB_RADIUS;
    for (const item of this.ix.grabbables()) {
      const d = grabDistance(item, gripPos);
      if (d >= bestD) continue;
      if (this._stealBlocked(item, d, gripPos)) continue;
      best = item; bestD = d;
    }

    // a detonator's T-handle competes on distance like anything else — a
    // belt draped over the box must still be grabbable — and only one hand
    // can own a plunger at a time
    for (const det of this.ix.world.detonators ?? []) {
      if (det.grabbed) continue;
      const detD = det.barWorldPos(_v2).distanceTo(gripPos);
      if (detD < 0.17 && detD < bestD && det.beginGrab()) {
        this.plunger = det;
        this.triggerHeld = fromTrigger;
        this.pulse(0.4, 50, 2);
        return;
      }
    }

    if (best) {
      // hand-to-hand pass: the donor feels it leave, the paper rustles
      for (const h of this.ix.hands) {
        if (h !== this && h.held === best) {
          h.pulse(0.5, 70, 2);
          h._releaseTimer = -1;
          h.held = null;
          best.holder = null;
          this.ix.audio.play('rustle', grabCenter(best, _v2), { gain: 0.8, refDistance: 0.8 });
        }
      }
      if (this.ix.grab(best, this.grip, this, _v3.copy(gripPos))) {
        this.held = best;
        this.triggerHeld = fromTrigger;
        this.pulse(0.35, 45, 2);
      }
    } else {
      // closed on air: soft double tick so the miss is felt, not guessed
      this.pulse(0.1, 20, 1);
      this.pulse(0.1, 20, 1, 90);
    }
  }

  // merged grip edge from squeeze events, the trigger, and the analog value.
  // engaging cancels a pending release (that's the flutter save); letting go
  // snapshots the throw immediately but confirms after the debounce.
  _gripEdge(down, fromTrigger = false) {
    if (down) {
      this._releaseTimer = -1;
      if (!fromTrigger) {
        if (this._gripDown) return;
        this._gripDown = true;
      }
      if (!this.held && !this.plunger) this.onSqueeze(fromTrigger);
    } else {
      if (!fromTrigger) this._gripDown = false;
      if (this.plunger) { this.onRelease(); return; }
      if (!this.held || this._releaseTimer >= 0) return;
      this._snapshotThrow();
      this._releaseTimer = RELEASE_DEBOUNCE;
    }
  }

  onRelease() {
    // immediate path (plunger hand-back, disconnects) — held releases from
    // the grip go through _gripEdge's debounce instead
    if (this.plunger) {
      this.plunger.endGrab();
      this.plunger = null;
      this.triggerHeld = false;
      return;
    }
    if (!this.held) return;
    this._snapshotThrow();
    this._confirmRelease();
  }

  _confirmRelease() {
    this._releaseTimer = -1;
    const item = this.held;
    if (!item) return;
    const result = this.ix.release(item);
    // a drop carries the hand's momentum (the integrator treats a missing
    // vel as the legacy straight drop, so this is always safe to set)
    if (result === 'dropped' && this._throwValid) {
      item.vel = (item.vel ?? new THREE.Vector3()).copy(this._throwVel);
      item.angVel = (item.angVel ?? new THREE.Vector3()).copy(this._throwAng);
    }
    if (result === 'planted') this.pulse(0.5, 60, 2);
    if (result === 'staked') this.pulse(0.4, 70, 2);
    this.held = null;
    this.triggerHeld = false;
  }

  // differentiate the pose ring into world-space linear + angular velocity
  _snapshotThrow() {
    this._throwValid = false;
    const ring = this._ring;
    const newest = ring[(this._ringHead + RING_N - 1) % RING_N];
    if (newest.t < 0) return;
    let oldest = newest;
    for (let i = 2; i <= RING_N; i++) {
      const e = ring[(this._ringHead + RING_N - i) % RING_N];
      if (e.t < 0 || newest.t - e.t > 0.2) break;
      oldest = e;
    }
    const span = newest.t - oldest.t;
    if (span < 0.004) return;
    // slight overdrive — vr throws always read weaker than they felt
    this._throwVel.subVectors(newest.p, oldest.p).multiplyScalar(1.15 / span);
    const sp = this._throwVel.length();
    if (sp > 14) this._throwVel.multiplyScalar(14 / sp); // tracking-glitch guard
    // angular velocity from the quaternion delta over the same window
    _qA.copy(oldest.q).invert().premultiply(newest.q);
    let w = clamp(_qA.w, -1, 1);
    if (w < 0) { _qA.x = -_qA.x; _qA.y = -_qA.y; _qA.z = -_qA.z; w = -w; }
    const s = Math.sqrt(Math.max(0, 1 - w * w));
    const ang = 2 * Math.acos(w);
    if (s > 1e-4 && ang > 1e-4) {
      this._throwAng.set(_qA.x / s, _qA.y / s, _qA.z / s)
        .multiplyScalar(Math.min(ang / span, 25));
    } else {
      this._throwAng.set(0, 0, 0);
    }
    this._throwValid = true;
  }

  _ensureHalo() {
    if (this.halo) return;
    this.halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: haloTexture(), color: 0xffe9b8, transparent: true, opacity: 0.4,
      blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false,
    }));
    this.halo.renderOrder = 9998;
    this.halo.scale.setScalar(0.08);
    this.ix.scene.add(this.halo);
  }

  // per-frame reach preview: the same candidate query onSqueeze runs, a bit
  // wider — halo at the grab point, tick when the candidate changes
  _updateHover() {
    if (this.held || this.plunger) {
      if (this.halo) this.halo.visible = false;
      this._hoverItem = null;
      return;
    }
    const gripPos = this.grip.getWorldPosition(_v1);
    let best = null, bestD = HOVER_RADIUS;
    for (const item of this.ix.grabbables()) {
      const d = grabDistance(item, gripPos, _v4);
      if (d >= bestD) continue;
      if (this._stealBlocked(item, d, gripPos)) continue;
      best = item; bestD = d;
      this._hoverPt.copy(_v4);
    }
    if (best !== this._hoverItem) {
      if (best) this.pulse(0.12, 12, 1);
      this._hoverItem = best;
    }
    if (best) {
      this._ensureHalo();
      const k = 1 - bestD / HOVER_RADIUS;
      this.halo.visible = true;
      this.halo.position.copy(this._hoverPt);
      this.halo.material.opacity = 0.18 + 0.4 * k;
      this.halo.scale.setScalar(0.06 + 0.035 * k);
    } else if (this.halo) {
      this.halo.visible = false;
    }
  }

  update(dt) {
    // record the grip pose for throw velocity (cheap, runs even off-stick)
    const rec = this._ring[this._ringHead];
    this._ringHead = (this._ringHead + 1) % RING_N;
    rec.t = performance.now() * 0.001;
    this.grip.getWorldPosition(rec.p);
    this.grip.getWorldQuaternion(rec.q);

    if (this.plunger) this.plunger.dragTo(this.grip.getWorldPosition(_v1), this);
    if (this.held && this.held.holder !== this) {
      this.held = null; // stolen
      this._releaseTimer = -1;
    }

    // pending release: confirm once the debounce runs out un-regripped
    if (this._releaseTimer >= 0) {
      this._releaseTimer -= dt;
      if (this._releaseTimer < 0) this._confirmRelease();
    }

    this._updateHaptics(performance.now());

    const gp = this.gamepad;
    if (!gp) {
      if (this.halo) this.halo.visible = false;
      return;
    }

    // analog grip hysteresis: engage above 0.6, let go below 0.25 — event
    // runtimes hit the same edge via squeezestart/squeezeend
    const gb = gp.buttons?.[1];
    if (gb) {
      const v = typeof gb.value === 'number' ? gb.value : (gb.pressed ? 1 : 0);
      if (v > 0.6 && !this._gripDown) this._gripEdge(true);
      else if (v < 0.25 && this._gripDown) this._gripEdge(false);
    }

    this._updateHover();

    if (!gp.axes) return;
    const ix = this.ix;
    let ax = gp.axes[2] ?? 0;
    let ay = gp.axes[3] ?? 0;
    // some runtimes report the stick on axes 0/1 (2/3 missing or dead)
    if (ax === 0 && ay === 0 && ((gp.axes[0] ?? 0) !== 0 || (gp.axes[1] ?? 0) !== 0)) {
      ax = gp.axes[0] ?? 0;
      ay = gp.axes[1] ?? 0;
    }

    if (this.handedness === 'left') {
      // head-relative smooth locomotion
      const mag = Math.min(1, Math.hypot(ax, ay));
      if (mag > 0.12) {
        const cam = ix.camera;
        _v1.set(0, 0, -1).applyQuaternion(cam.getWorldQuaternion(_q1));
        _v1.y = 0; _v1.normalize();
        _v2.crossVectors(_v1, UP).negate(); // left
        const speed = 3.0;
        ix.player.position.addScaledVector(_v1, -ay * speed * dt);
        ix.player.position.addScaledVector(_v2, -ax * speed * dt);
        comfort.setLocomotion(mag);
      }
    } else if (this.handedness === 'right') {
      // snap turn
      if (Math.abs(ax) > 0.6 && this.snapReady) {
        this.snapReady = false;
        const angle = -Math.sign(ax) * Math.PI / 6;
        // rotate the rig around the head position so the world doesn't slide
        const head = ix.camera.getWorldPosition(_v1);
        ix.player.position.sub(head);
        ix.player.position.applyAxisAngle(UP, angle);
        ix.player.position.add(head);
        ix.player.rotateY(angle);
        comfort.snapFlash();
        this.pulse(0.25, 30, 1);
        ix.audio.playFlat('tick', { gain: 0.18, rate: 1.5 });
      } else if (Math.abs(ax) < 0.3) {
        this.snapReady = true;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Desktop fallback

export class DesktopControls {
  constructor(interactions) {
    this.ix = interactions;
    this.enabled = false;
    this.yaw = 0;
    this.pitch = 0;
    this.keys = new Set();
    this.held = null;
    this.tilt = 0; // planting tilt, radians from vertical
    this.raycaster = new THREE.Raycaster();
    this.handAnchor = new THREE.Object3D();
    this.handAnchor.position.set(0.32, -0.28, -0.65);
    interactions.camera.add(this.handAnchor);
    this.hud = document.getElementById('hud');
    this.reticle = document.getElementById('reticle');

    document.addEventListener('keydown', (e) => {
      if (!this.enabled) return;
      // when some OTHER element owns the pointer lock the game isn't the
      // focus — don't buffer walks it can never key-up
      if (document.pointerLockElement
        && document.pointerLockElement !== this.ix.renderer.domElement) return;
      this.keys.add(e.code);
      if (e.code === 'KeyE') this.toggleGrab();
      if (e.code === 'KeyF') this.quickRocket();
    });
    document.addEventListener('keyup', (e) => this.keys.delete(e.code));
    // stuck-walk bug: blur / lock-exit eats the keyup, so drop everything
    window.addEventListener('blur', () => this.keys.clear());
    document.addEventListener('pointerlockchange', () => {
      if (document.pointerLockElement !== this.ix.renderer.domElement) this.keys.clear();
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.enabled || document.pointerLockElement !== this.ix.renderer.domElement) return;
      this.yaw -= e.movementX * 0.0022;
      this.pitch = clamp(this.pitch - e.movementY * 0.0022, -1.45, 1.45);
    });
    document.addEventListener('mousedown', (e) => {
      if (!this.enabled) return;
      if (document.pointerLockElement !== this.ix.renderer.domElement) {
        this.ix.renderer.domElement.requestPointerLock();
        return;
      }
      if (e.button === 0) this.primaryAction();
    });
    document.addEventListener('wheel', (e) => {
      if (!this.enabled || !this.held || this.held.isTorch) return;
      this.tilt = clamp(this.tilt + Math.sign(e.deltaY) * 0.09, -1.1, 1.1);
    });
  }

  enable() {
    this.enabled = true;
    this.reticle.style.display = 'block';
    this.hud.style.display = 'block';
  }

  disable() {
    this.enabled = false;
    this.reticle.style.display = 'none';
    this.hud.style.display = 'none';
    this.keys.clear();
  }

  aimingAtExit() {
    const board = this.ix.world.exitBoard;
    if (!board) return false;
    this.raycaster.setFromCamera({ x: 0, y: 0 }, this.ix.camera);
    const hit = this.raycaster.intersectObject(board, false);
    return hit.length > 0 && hit[0].distance < 4;
  }

  /** The teleport ring the crosshair rests on (anywhere on its sign/post). */
  aimedTeleporter() {
    this.raycaster.setFromCamera({ x: 0, y: 0 }, this.ix.camera);
    for (const tp of this.ix.world.teleporters ?? []) {
      const hit = this.raycaster.intersectObject(tp.aimRoot, true);
      if (hit.length > 0 && hit[0].distance < 4.5) return tp;
    }
    return null;
  }

  /** The detonator box the crosshair rests on, with its aim distance. */
  aimedDetonator() {
    for (const det of this.ix.world.detonators ?? []) {
      const d = det.aimDistance(this.raycaster, this.ix.camera);
      if (d != null) return { det, distance: d };
    }
    return null;
  }

  pulse() { /* no haptics on desktop */ }

  aimHit() {
    this.raycaster.setFromCamera({ x: 0, y: 0 }, this.ix.camera);
    const targets = [];
    for (const item of this.ix.grabbables()) targets.push(item.root);
    const hits = this.raycaster.intersectObjects(targets, true);
    for (const h of hits) {
      let o = h.object;
      while (o && !o.userData.item) o = o.parent;
      if (o && h.distance < 3.6) return { item: o.userData.item, point: h.point, distance: h.distance };
    }
    // terrain fallback: march the ray
    const origin = this.raycaster.ray.origin, dir = this.raycaster.ray.direction;
    for (let t = 0.5; t < 14; t += 0.25) {
      _v1.copy(origin).addScaledVector(dir, t);
      if (_v1.y <= terrainHeight(_v1.x, _v1.z)) {
        _v1.y = terrainHeight(_v1.x, _v1.z);
        return { item: null, point: _v1.clone(), distance: t };
      }
    }
    return null;
  }

  toggleGrab() {
    if (this.held) {
      const item = this.held;
      const r = this.ix.release(item);
      // dropped items inherit the look direction at walking-toss speed and
      // tumble forward instead of falling stiffly out of frame
      if (r === 'dropped' && !item.isTorch) {
        _v2.set(0, 0, -1).applyQuaternion(this.ix.camera.getWorldQuaternion(_q1));
        item.vel = (item.vel ?? new THREE.Vector3()).copy(_v2).multiplyScalar(2.0);
        _v3.crossVectors(_v2, UP);
        if (_v3.lengthSq() < 1e-4) _v3.copy(RIGHT);
        item.angVel = (item.angVel ?? new THREE.Vector3()).copy(_v3.normalize()).multiplyScalar(3.0);
      }
      this.held = null;
      this.tilt = 0;
      return r;
    }
    const hit = this.aimHit();
    if (hit?.item) {
      if (this.ix.grab(hit.item, this.handAnchor, this, hit.point)) {
        this.held = hit.item;
        hit.item.root.position.set(0, hit.item.isTorch ? -0.25 : -(hit.item.grabY ?? 0.1), 0);
        hit.item.root.quaternion.identity();
      }
    }
    return null;
  }

  primaryAction() {
    const ix = this.ix;
    if (!this.held && this.aimingAtExit()) {
      ix.onExit?.();
      return;
    }
    // teleport wayposts: click one empty-handed to ride its ring
    if (!this.held) {
      const tp = this.aimedTeleporter();
      if (tp) {
        tp.use(ix.player, ix.camera, (d) => { this.yaw += d; });
        return;
      }
    }
    // a detonator: click it and the handle throws itself — unless an
    // item is lying in front of it, in which case the click-grab wins
    if (!this.held) {
      const aimed = this.aimedDetonator();
      if (aimed) {
        const hit = this.aimHit();
        if (!(hit?.item && hit.distance < aimed.distance)) {
          aimed.det.autoPlunge();
          return;
        }
      }
    }
    if (this.held && !this.held.isTorch) {
      // a rocket already firing in your grip can't be click-planted across
      // the sand — letting go (E) is the launch
      if (this.held.state === 'active' && this.held.type.kind === 'rocket') return;
      // a belt can't teleport-plant either: clicking just lets it drop here
      if (this.held.type.kind === 'belt') { this.toggleGrab(); return; }
      // plant at the aimed ground point with the current tilt
      const hit = this.aimHit();
      if (hit && !hit.item && hit.distance < 8) {
        const item = this.held;
        this.held = null;
        item.holder = null;
        ix.scene.attach(item.root);
        item.root.position.copy(hit.point);
        // tilt away from the camera's yaw so "up + toward where you look"
        const q = new THREE.Quaternion().setFromAxisAngle(
          _v1.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw)).normalize(),
          -this.tilt,
        );
        item.root.quaternion.copy(q);
        // an active fountain/candle set down keeps its state; never overwrite
        if (item.state !== 'active' && item.state !== 'spent') item.state = 'planted';
        ix.audio.play('crunch', hit.point, { gain: 0.9, refDistance: 1.2 });
        this.tilt = 0;
      }
      return;
    }
    if (this.held?.isTorch) {
      // light whatever fuse we're aiming at (generous reach on desktop)
      let best = null, bestD = 2.6;
      const camPos = ix.camera.getWorldPosition(_v1);
      this.raycaster.setFromCamera({ x: 0, y: 0 }, ix.camera);
      for (const item of ix.fireworks.items) {
        if (item.isLit || item.state === 'active' || item.state === 'spent') continue;
        const fuse = item.fuseWorldPos(_v2);
        const t = _v3.copy(fuse).sub(camPos).dot(this.raycaster.ray.direction);
        if (t < 0.2 || t > 3.5) continue;
        const along = _v3.copy(this.raycaster.ray.origin).addScaledVector(this.raycaster.ray.direction, t);
        const off = along.distanceTo(fuse);
        if (off < 0.35 && t < bestD) { best = item; bestD = t; }
      }
      // if it catches in someone's grip, that hand feels it
      if (best?.ignite()) best.holder?.pulse?.(0.9, 140, 2);
      return;
    }
    // empty hand: click also grabs, for convenience
    this.toggleGrab();
  }

  quickRocket() {
    // sandbox shortcut: a lit rocket appears planted a few meters ahead
    if ((this._qrCd ?? 0) > 0) return; // held F must not carpet-bomb the dunes
    this._qrCd = 0.5;
    const ix = this.ix;
    const dir = _v1.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const pos = ix.player.position.clone().addScaledVector(dir, randRange(4.5, 8));
    pos.x += randRange(-2, 2); pos.z += randRange(-2, 2);
    pos.y = terrainHeight(pos.x, pos.z);
    const item = ix.fireworks.createItem(randPick(['rocketSmall', 'rocketMed', 'rocketLarge', 'rocketGrand', 'cake']));
    item.root.position.copy(pos);
    item.root.rotateOnWorldAxis(_v2.set(randRange(-1, 1), 0, randRange(-1, 1)).normalize(), randRange(0, 0.25));
    item.state = 'planted';
    item.ignite();
  }

  update(dt) {
    if (!this.enabled) return;
    const ix = this.ix;
    ix.player.rotation.y = this.yaw;
    ix.camera.rotation.set(this.pitch, 0, 0, 'YXZ');
    this._qrCd = Math.max(0, (this._qrCd ?? 0) - dt);

    // the scroll tilt is live on the held item, not just a number in the hud
    // (belts drape and active rockets are pinned — leave those alone)
    const held = this.held;
    if (held && !held.isTorch && held.type?.kind !== 'belt' && held.state !== 'active') {
      held.root.quaternion.setFromAxisAngle(RIGHT, -this.tilt);
    }

    const speed = this.keys.has('ShiftLeft') ? 7 : 3.4;
    _v1.set(0, 0, 0);
    if (this.keys.has('KeyW')) _v1.z -= 1;
    if (this.keys.has('KeyS')) _v1.z += 1;
    if (this.keys.has('KeyA')) _v1.x -= 1;
    if (this.keys.has('KeyD')) _v1.x += 1;
    if (_v1.lengthSq() > 0) {
      _v1.normalize().applyAxisAngle(UP, this.yaw);
      ix.player.position.addScaledVector(_v1, speed * dt);
    }

    // hud hint (throttled — aimHit raycasts and samples terrain)
    this._hudTimer = (this._hudTimer ?? 0) - dt;
    if (this.hud && this._hudTimer <= 0) {
      this._hudTimer = 0.15;
      let msg;
      if (this.held?.isTorch) msg = '🔥 Click a fuse to light it · E to drop the torch';
      else if (this.held?.state === 'active' && this.held.type.kind === 'rocket') msg = `${this.held.type.label} — motor burning! E to let it fly`;
      else if (this.held?.type?.kind === 'belt') msg = `${this.held.type.label} — light the dangling end, then click/E to toss it`;
      else if (this.held) msg = `${this.held.type.label} — click the sand to plant · scroll to tilt (${Math.round(this.tilt * 57)}°) · E to drop`;
      else if (this.aimedTeleporter()) msg = `✨ ${this.aimedTeleporter().hint}`;
      else if (this.aimingAtExit()) msg = 'Click — exit to menu';
      else if (this.aimedDetonator()) {
        const det = this.aimedDetonator().det;
        msg = det.armed ? det.hintArmed : det.hintBusy;
      } else {
        const hit = this.aimHit();
        if (hit?.item) msg = hit.item.isTorch ? 'E — take the torch' : `E — grab ${hit.item.type.label}`;
        else msg = 'E — grab · F — quick rocket';
      }
      if (msg !== this._lastMsg) { this.hud.textContent = msg; this._lastMsg = msg; }
    }
  }
}
