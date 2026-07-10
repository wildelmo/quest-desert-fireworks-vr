// Interaction: grabbing, planting, lighting.
//
// VR:      grip to grab (fireworks or the torch), release near the sand to
//          plant at whatever angle you're holding, touch the torch flame to a
//          fuse to light it. Left stick walks, right stick snap-turns.
//          Haptics on grab / ignite / nearby booms.
// Desktop: WASD + pointer-lock mouse, E grab/drop, scroll tilts, click plants
//          or lights, F quick-launches a rocket. Shares the same plant/ignite
//          logic so the whole game is testable without a headset.

import * as THREE from 'three';
import { terrainHeight, terrainNormal } from './terrain.js';
import { clamp, randRange, randPick } from './utils.js';

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);

const GRAB_RADIUS = 0.22;
const PLANT_MAX_HEIGHT = 0.35;   // base must be this close to the ground
const FLAME_LIGHT_RADIUS = 0.1;

function makeGhostRing() {
  const group = new THREE.Group();
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.14, 0.012, 8, 24),
    new THREE.MeshBasicMaterial({ color: 0x7fff9a, transparent: true, opacity: 0.55, depthWrite: false }),
  );
  ring.rotation.x = Math.PI / 2;
  group.add(ring);
  group.visible = false;
  return group;
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
function grabDistance(item, point) {
  // belts: the strand is a world-space rope — you can grab it anywhere
  if (item.beltPts) {
    let best = Infinity;
    for (const pt of item.beltPts) best = Math.min(best, pt.p.distanceTo(point));
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
  return _segP.copy(_segA).addScaledVector(_segAB, t).distanceTo(point);
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
    scene.add(this.ghost);

    this.hands = []; // XR hands
    this.desktop = null;
    this.onExit = null; // set by main.js: leave to the menu

    // haptic hook for explosions
    fireworks.onBoom = (pos, size) => this.onBoom(pos, size);
  }

  grabbables() {
    // held items stay in the list so the other hand can take them over
    const list = [];
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
    if (item.slotHome) item.slotHome.notifyTaken(item);
    holderObject.attach(item.root);
    item.onGrabbed?.(holderObject, grabPoint); // belts pin the rope point nearest the grab
    this.audio.play('tick', grabCenter(item, _v1), { gain: 0.8, refDistance: 0.8 });
    return true;
  }

  /** Release a held item; plants it if its base is near the ground. */
  release(item) {
    item.holder = null;
    this.scene.attach(item.root);

    if (item.isTorch) {
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
      this.audio.play('thud', p, { gain: 0.9, refDistance: 1.2 });
      return 'planted';
    }
    item.state = 'lying';
    item.fallVel = -0.01;
    return 'dropped';
  }

  tryIgniteNear(flamePos, igniterHand = null) {
    for (const item of this.fireworks.items) {
      if (item.isLit || item.state === 'active' || item.state === 'spent') continue;
      const fuse = item.fuseWorldPos(_v2);
      if (fuse.distanceTo(flamePos) < FLAME_LIGHT_RADIUS) {
        if (item.ignite()) {
          igniterHand?.pulse(0.7, 90);
          return item;
        }
      }
    }
    return null;
  }

  updateGhost(item) {
    // show plant preview under a held firework (not one already going off,
    // and not a belt — belts drape, they don't plant)
    if (!item || item.isTorch || item.state === 'active' || item.type.kind === 'belt') { this.ghost.visible = false; return; }
    const p = item.root.getWorldPosition(_v1);
    const groundY = terrainHeight(p.x, p.z);
    const axis = item.axis(_v2);
    if (p.y - groundY < PLANT_MAX_HEIGHT && axis.y > 0.2) {
      this.ghost.visible = true;
      this.ghost.position.set(p.x, groundY + 0.02, p.z);
      this.ghost.quaternion.setFromUnitVectors(UP, terrainNormal(p.x, p.z, _v3));
    } else {
      this.ghost.visible = false;
    }
  }

  onBoom(pos, size) {
    // haptic thump scaled by proximity, on both controllers
    const dist = this.camera.getWorldPosition(_v1).distanceTo(pos);
    const k = clamp(1.6 * size / Math.max(1, dist / 14), 0, 1);
    if (k > 0.03) {
      const delayMs = (dist / 340) * 1000;
      setTimeout(() => {
        for (const h of this.hands) h.pulse(k, 120 + size * 120);
      }, delayMs);
    }
  }

  update(dt, time) {
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

    // torch lights fuses wherever it is (held or staked), if flame touches
    const torch = this.world.torch;
    const flamePos = torch.flameWorldPos(_v3);
    const holderHand = this.hands.find((h) => h.held === torch) ?? null;
    this.tryIgniteNear(flamePos, holderHand);
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
    this._lastPos = new THREE.Vector3();

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
    });
    this.grip.addEventListener('squeezestart', () => this.onSqueeze());
    this.grip.addEventListener('squeezeend', () => this.onRelease());
    // trigger also grabs — friendlier for first-time players
    this.grip.addEventListener('selectstart', () => { if (!this.held) this.onSqueeze(true); });
    this.grip.addEventListener('selectend', () => { if (this.triggerHeld) this.onRelease(); });
  }

  pulse(intensity, ms) {
    const act = this.gamepad?.hapticActuators?.[0];
    if (act?.pulse) {
      try { act.pulse(clamp(intensity, 0, 1), ms); } catch { /* unsupported */ }
    }
  }

  onSqueeze(fromTrigger = false) {
    if (this.held || this.plunger) return;
    const gripPos = this.grip.getWorldPosition(_v1);

    // grabbing the EXIT sign board leaves the game
    const exitBoard = this.ix.world.exitBoard;
    if (exitBoard && exitBoard.getWorldPosition(_v2).distanceTo(gripPos) < 0.3) {
      this.pulse(0.5, 80);
      this.ix.onExit?.();
      return;
    }

    let best = null, bestD = GRAB_RADIUS;
    for (const item of this.ix.grabbables()) {
      const d = grabDistance(item, gripPos);
      if (d < bestD) { best = item; bestD = d; }
    }

    // the detonator's T-handle competes on distance like anything else — a
    // belt draped over the box must still be grabbable — and only one hand
    // can own the plunger at a time
    const det = this.ix.world.detonator;
    if (det && !det.grabbed) {
      const detD = det.barWorldPos(_v2).distanceTo(gripPos);
      if (detD < 0.17 && detD < bestD && det.beginGrab()) {
        this.plunger = det;
        this.triggerHeld = fromTrigger;
        this.pulse(0.4, 50);
        return;
      }
    }

    if (best) {
      // steal from the other hand if needed
      for (const h of this.ix.hands) {
        if (h !== this && h.held === best) { h.held = null; best.holder = null; }
      }
      if (this.ix.grab(best, this.grip, this, _v3.copy(gripPos))) {
        this.held = best;
        this.triggerHeld = fromTrigger;
        this.pulse(0.35, 45);
      }
    }
  }

  onRelease() {
    if (this.plunger) {
      this.plunger.endGrab();
      this.plunger = null;
      this.triggerHeld = false;
      return;
    }
    if (!this.held) return;
    const result = this.ix.release(this.held);
    if (result === 'planted') this.pulse(0.5, 60);
    this.held = null;
    this.triggerHeld = false;
  }

  update(dt) {
    if (this.plunger) this.plunger.dragTo(this.grip.getWorldPosition(_v1), this);
    if (this.held && this.held.holder !== this) this.held = null; // stolen
    const gp = this.gamepad;
    if (!gp || !gp.axes) return;
    const ix = this.ix;
    const ax = gp.axes[2] ?? 0;
    const ay = gp.axes[3] ?? 0;

    if (this.handedness === 'left') {
      // head-relative smooth locomotion
      if (Math.abs(ax) > 0.12 || Math.abs(ay) > 0.12) {
        const cam = ix.camera;
        _v1.set(0, 0, -1).applyQuaternion(cam.getWorldQuaternion(_q1));
        _v1.y = 0; _v1.normalize();
        _v2.crossVectors(_v1, UP).negate(); // left
        const speed = 3.0;
        ix.player.position.addScaledVector(_v1, -ay * speed * dt);
        ix.player.position.addScaledVector(_v2, -ax * speed * dt);
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
      this.keys.add(e.code);
      if (e.code === 'KeyE') this.toggleGrab();
      if (e.code === 'KeyF') this.quickRocket();
    });
    document.addEventListener('keyup', (e) => this.keys.delete(e.code));
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
      const r = this.ix.release(this.held);
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
    // the detonator: click it and the handle throws itself — unless an
    // item is lying in front of it, in which case the click-grab wins
    if (!this.held) {
      const detDist = ix.world.detonator?.aimDistance(this.raycaster, ix.camera);
      if (detDist != null) {
        const hit = this.aimHit();
        if (!(hit?.item && hit.distance < detDist)) {
          ix.world.detonator.autoPlunge();
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
        ix.audio.play('thud', hit.point, { gain: 0.9, refDistance: 1.2 });
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
      best?.ignite();
      return;
    }
    // empty hand: click also grabs, for convenience
    this.toggleGrab();
  }

  quickRocket() {
    // sandbox shortcut: a lit rocket appears planted a few meters ahead
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
      else if (this.aimingAtExit()) msg = 'Click — exit to menu';
      else if (this.ix.world.detonator?.aimDistance(this.raycaster, this.ix.camera) != null) {
        msg = this.ix.world.detonator.armed ? '💥 Click — PLUNGE (grand finale)' : 'the finale is running…';
      } else {
        const hit = this.aimHit();
        if (hit?.item) msg = hit.item.isTorch ? 'E — take the torch' : `E — grab ${hit.item.type.label}`;
        else msg = 'E — grab · F — quick rocket';
      }
      if (msg !== this._lastMsg) { this.hud.textContent = msg; this._lastMsg = msg; }
    }
  }
}
