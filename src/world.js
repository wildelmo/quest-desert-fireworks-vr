// World assembly: lighting, terrain, sky, and the little campsite you play
// from — a supply crate that never runs dry, a torch to light fuses with,
// an instruction sign, rocks and scrub. Also owns the crate restocker.

import * as THREE from 'three';
import { createTerrain, terrainHeight, terrainNormal } from './terrain.js';
import { createSky, createNightEnvMap, MOON_DIR } from './sky.js';
import { FinaleShow } from './show.js';
import { createLounge } from './props.js';
import { createColossus } from './colossus.js';
import { mulberry32, randRange, clamp } from './utils.js';

const WOOD = 0x6b5236;
const WOOD_DARK = 0x4a3a26;

function woodMat(color = WOOD) {
  // weathered wood: matte but not dead — a hint of sheen catches the torch
  return new THREE.MeshStandardMaterial({ color, roughness: 0.78, metalness: 0, envMapIntensity: 0.4 });
}

// Soft dark disc that hugs the sand under a prop — cheap contact shadow.
// Directional moon shadows ground the tall silhouettes; these ground
// everything else (ambient occlusion where a thing meets the ground).
let _aoTex = null;
function contactShadow(x, z, rx, rz, opacity = 0.4) {
  if (!_aoTex) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(32, 32, 2, 32, 32, 32);
    grad.addColorStop(0, 'rgba(0,0,0,0.85)');
    grad.addColorStop(0.55, 'rgba(0,0,0,0.35)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    _aoTex = new THREE.CanvasTexture(c);
  }
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.MeshBasicMaterial({
      map: _aoTex, transparent: true, opacity, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2,
    }),
  );
  // hug the local slope (rocks out on the dunes sit on real gradients)
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), terrainNormal(x, z));
  m.scale.set(rx, rz, 1);
  m.position.set(x, terrainHeight(x, z) + 0.02, z);
  m.renderOrder = 1;
  return m;
}

// ---------------------------------------------------------------------------
export class Torch {
  constructor(scene, pool, audio) {
    this.pool = pool;
    this.audio = audio;
    this.isTorch = true;
    this.state = 'idle'; // idle | held | planted
    this.holder = null;
    this.fallVel = 0;
    this.sound = null;

    const root = new THREE.Group();
    this.root = root;
    root.userData.item = this;

    const handle = new THREE.Mesh(
      new THREE.CylinderGeometry(0.013, 0.017, 0.62, 7),
      woodMat(0x5a442c),
    );
    handle.position.y = 0.31;
    handle.castShadow = true;
    root.add(handle);

    const wrap = new THREE.Mesh(
      new THREE.CylinderGeometry(0.03, 0.024, 0.11, 8),
      new THREE.MeshStandardMaterial({
        color: 0x2a2018, roughness: 0.9,
        emissive: 0x903808, emissiveIntensity: 0.55,
      }),
    );
    wrap.position.y = 0.64;
    root.add(wrap);

    this.grabY = 0.28;
    this.grabTop = 0.7; // whole handle is grabbable
    this.flameAnchor = new THREE.Object3D();
    this.flameAnchor.position.y = 0.72;
    root.add(this.flameAnchor);

    // flame sprite — 8-frame procedural sheet, so the fire actually licks
    // and tears instead of just pulsing one static gradient
    const FRAMES = 8;
    const FW = 40, FH = 64;
    const c = document.createElement('canvas');
    c.width = FW * FRAMES; c.height = FH;
    const g = c.getContext('2d');
    const frand = mulberry32(515);
    for (let f = 0; f < FRAMES; f++) {
      const cx = f * FW + FW / 2;
      const ph = (f / FRAMES) * Math.PI * 2;
      // stacked blobs: white-hot base, orange body, red tongue — the upper
      // ones sway more, and the tongue occasionally tears off
      const blobs = [
        { x: 0, y: 46, r: 13, c: ['rgba(255,244,200,1)', 'rgba(255,190,80,0.55)', 'rgba(255,120,30,0)'] },
        { x: Math.sin(ph) * 3.5, y: 33, r: 11, c: ['rgba(255,190,90,0.9)', 'rgba(255,130,40,0.45)', 'rgba(230,80,20,0)'] },
        { x: Math.sin(ph + 1.1) * 5.5, y: 21 - Math.sin(ph * 2) * 2, r: 8, c: ['rgba(255,140,50,0.8)', 'rgba(235,90,25,0.35)', 'rgba(200,50,10,0)'] },
        { x: Math.sin(ph + 2.3) * 7, y: 11 - Math.sin(ph * 2 + 1) * 3, r: 4.5 + frand() * 2, c: ['rgba(245,105,35,0.7)', 'rgba(210,60,15,0.25)', 'rgba(180,40,10,0)'] },
      ];
      for (const b of blobs) {
        const grad = g.createRadialGradient(cx + b.x, b.y, 0.5, cx + b.x, b.y, b.r);
        grad.addColorStop(0, b.c[0]);
        grad.addColorStop(0.55, b.c[1]);
        grad.addColorStop(1, b.c[2]);
        g.fillStyle = grad;
        g.fillRect(cx - FW / 2, 0, FW, FH);
      }
    }
    const tex = new THREE.CanvasTexture(c);
    tex.repeat.set(1 / FRAMES, 1);
    this.flameTex = tex;
    this.flameFrames = FRAMES;
    this.flame = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, fog: false,
    }));
    this.flame.scale.set(0.1, 0.17, 1);
    this.flame.position.y = 0.03;
    this.flameAnchor.add(this.flame);

    this.light = new THREE.PointLight(0xff9540, 3.2, 0, 1.9);
    this.light.position.y = 0.05;
    this.flameAnchor.add(this.light);

    scene.add(root);
    this._sparkAcc = 0;
    this._pos = new THREE.Vector3();
  }

  flameWorldPos(out = this._pos) {
    return this.flameAnchor.getWorldPosition(out);
  }

  update(dt, time, groundHeight) {
    // flicker
    this.light.intensity = 2.6 + Math.sin(time * 23) * 0.5 + Math.sin(time * 7.3) * 0.4;
    const s = 1 + Math.sin(time * 19) * 0.12 + Math.sin(time * 47) * 0.06;
    this.flame.scale.set(0.1 * s, 0.17 * (2 - s) * s, 1);
    // step through the flame sheet (13 fps reads as fire, not a strobe)
    this.flameTex.offset.x = (Math.floor(time * 13) % this.flameFrames) / this.flameFrames;

    // ember sparks curling off the head
    const p = this.flameWorldPos();
    this._sparkAcc += dt * 26;
    const n = Math.floor(this._sparkAcc);
    this._sparkAcc -= n;
    if (n > 0) {
      const pool = this.pool;
      pool.spawn(n, (i) => {
        pool.set(i,
          p.x + randRange(-0.015, 0.015), p.y + randRange(-0.01, 0.02), p.z + randRange(-0.015, 0.015),
          randRange(-0.12, 0.12), randRange(0.25, 0.7), randRange(-0.12, 0.12),
          1.0, 0.55, 0.15,
          time, randRange(0.4, 1.1),
          randRange(0.012, 0.024), -0.12, 1.8, 0); // negative gravity: heat rise
      });
    }

    // fire loop follows the torch
    if (!this.sound && this.audio.ready) {
      this.sound = this.audio.play('torch', p, { gain: 0.16, loop: true, refDistance: 0.5, send: 0.05, hrtf: true });
    }
    this.sound?.setPosition(p);

    // falling after a drop: stake upright into the sand
    if (this.state === 'idle' && this.fallVel !== 0) {
      this.fallVel = Math.max(this.fallVel - 9.81 * dt, -12);
      this.root.position.y += this.fallVel * dt;
      const gy = groundHeight(this.root.position.x, this.root.position.z);
      if (this.root.position.y <= gy) {
        this.root.position.y = gy;
        this.fallVel = 0;
        this.root.quaternion.identity();
        this.root.rotateY(Math.random() * Math.PI);
        this.audio.play('thud', this.root.position, { gain: 0.6, refDistance: 1.5 });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The TNT detonator — the cartoon plunger box. Grab the T-handle and shove
// it all the way down; a spark races along the wire to a mortar battery out
// in the dunes and the two-minute grand finale begins. It re-arms (handle
// creaks back up) once the show ends.

function detonatorLabelTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 160;
  const g = c.getContext('2d');
  g.fillStyle = '#7e1a10';
  g.fillRect(0, 0, 256, 160);
  // hazard chevrons top and bottom
  g.fillStyle = '#d8b83a';
  for (let x = -20; x < 256; x += 40) {
    g.beginPath();
    g.moveTo(x, 0); g.lineTo(x + 20, 0); g.lineTo(x + 40, 18); g.lineTo(x + 20, 18);
    g.fill();
    g.beginPath();
    g.moveTo(x + 20, 142); g.lineTo(x + 40, 142); g.lineTo(x + 20, 160); g.lineTo(x, 160);
    g.fill();
  }
  g.fillStyle = '#f4e6c2';
  g.font = 'bold 52px Georgia, serif';
  g.textAlign = 'center';
  g.fillText('DANGER', 128, 76);
  g.font = 'bold 24px Georgia, serif';
  g.fillStyle = '#e8c890';
  g.fillText('GRAND FINALE', 128, 108);
  g.font = '18px Georgia, serif';
  g.fillText('— plunge to fire —', 128, 132);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class Detonator {
  constructor(scene, audio, wireTarget) {
    this.audio = audio;
    this.armed = true;
    this.grabbed = false;
    this.norm = 1;        // 1 = handle up, 0 = plunged
    this.anim = null;     // 'down' (desktop auto-plunge) | 'up' (re-arm)
    this.onFire = null;

    const root = new THREE.Group();
    this.root = root;

    const W = 0.34, D = 0.26, H = 0.28;
    const labelTex = detonatorLabelTexture();
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(W, H, D),
      [woodMat(WOOD_DARK), woodMat(WOOD_DARK), woodMat(0x53402a), woodMat(WOOD_DARK),
        new THREE.MeshStandardMaterial({
          map: labelTex, roughness: 0.7, envMapIntensity: 0.5,
          // faint self-glow so DANGER reads by moonlight, like the wrappers
          emissive: 0xffffff, emissiveMap: labelTex, emissiveIntensity: 0.22,
        }),
        woodMat(WOOD_DARK)],
    );
    box.position.y = H / 2;
    box.castShadow = box.receiveShadow = true;
    root.add(box);

    const brass = new THREE.MeshStandardMaterial({
      color: 0x8a6f3a, roughness: 0.35, metalness: 0.85, envMapIntensity: 0.9,
    });
    // brass top plate + plunger collar
    const plate = new THREE.Mesh(new THREE.BoxGeometry(W * 0.92, 0.015, D * 0.92), brass);
    plate.position.y = H + 0.0075;
    root.add(plate);
    const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.034, 0.06, 10), brass);
    collar.position.y = H + 0.03;
    root.add(collar);
    // terminal posts on the back edge
    for (const s of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.05, 8), brass);
      post.position.set(s * 0.08, H + 0.03, -D / 2 + 0.03);
      root.add(post);
    }
    // the armed lamp: a little red jewel that blinks while the box is live
    this.lampMat = new THREE.MeshBasicMaterial({ color: 0xff2010 });
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.013, 8, 6), this.lampMat);
    lamp.position.set(0.11, H + 0.02, D / 2 - 0.035);
    root.add(lamp);

    // the plunger: steel shaft + worn wooden T-handle
    this.travel = 0.24;
    this.handleBase = H - 0.02; // handle group's Y at norm 0
    const handle = new THREE.Group();
    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(0.013, 0.013, 0.34, 8),
      new THREE.MeshStandardMaterial({ color: 0x4b4f58, roughness: 0.35, metalness: 0.8, envMapIntensity: 0.8 }),
    );
    shaft.position.y = -0.15;
    handle.add(shaft);
    const bar = new THREE.Mesh(
      new THREE.CylinderGeometry(0.024, 0.024, 0.34, 9),
      woodMat(0x7a5c38),
    );
    bar.rotation.z = Math.PI / 2;
    bar.castShadow = true;
    handle.add(bar);
    this.handle = handle;
    this.bar = bar;
    root.add(handle);

    scene.add(root);
    this._applyNorm();
    this._pos = new THREE.Vector3();
    this._local = new THREE.Vector3();
    this.wireTarget = wireTarget;
    this.wireCurve = null;
  }

  // Call after root is positioned: lays the red firing wire from the
  // terminals out across the dunes toward the mortar battery.
  layWire(scene) {
    this.root.updateMatrixWorld(true);
    const start = new THREE.Vector3(0, this.handleBase + 0.02, -0.16);
    this.root.localToWorld(start);
    const end = this.wireTarget;
    const pts = [start];
    const N = 16;
    for (let i = 1; i <= N; i++) {
      const t = i / N;
      const x = start.x + (end.x - start.x) * t + Math.sin(t * 9.2) * 1.6 * t;
      const z = start.z + (end.z - start.z) * t + Math.cos(t * 7.1) * 1.4 * t;
      pts.push(new THREE.Vector3(x, terrainHeight(x, z) + 0.025, z));
    }
    this.wireCurve = new THREE.CatmullRomCurve3(pts);
    const tube = new THREE.Mesh(
      new THREE.TubeGeometry(this.wireCurve, 120, 0.007, 5),
      new THREE.MeshStandardMaterial({ color: 0x8a2318, roughness: 0.55, envMapIntensity: 0.5 }),
    );
    scene.add(tube);
  }

  _applyNorm() {
    this.handle.position.y = this.handleBase + this.travel * this.norm;
  }

  barWorldPos(out) {
    return this.bar.getWorldPosition(out);
  }

  grabTest(handPos) {
    return this.bar.getWorldPosition(this._pos).distanceTo(handPos) < 0.17;
  }

  /** Distance to the center-screen aim hit, or null if not aimed at. */
  aimDistance(raycaster, camera) {
    raycaster.setFromCamera({ x: 0, y: 0 }, camera);
    const hit = raycaster.intersectObject(this.root, true);
    return hit.length > 0 && hit[0].distance < 4 ? hit[0].distance : null;
  }

  /** One hand owns the plunger at a time. Returns whether the grab took. */
  beginGrab() {
    if (this.grabbed) return false;
    this.grabbed = true;
    this.anim = null;
    return true;
  }

  /** VR: the handle follows the gripping hand's height, clamped to its rails. */
  dragTo(handWorld, hand = null) {
    if (!this.grabbed) return;
    this._local.copy(handWorld);
    this.root.worldToLocal(this._local);
    const prev = this.norm;
    this.norm = clamp((this._local.y - this.handleBase) / this.travel, 0, 1);
    this._applyNorm();
    // ratchet clicks on the way down — the cartoon wants them
    if (((prev * 6) | 0) !== ((this.norm * 6) | 0)) {
      this.audio.play('tick', this.bar.getWorldPosition(this._pos), { gain: 0.5, refDistance: 0.7, rate: 0.7 });
      hand?.pulse?.(0.2, 20);
    }
    // fire on the downstroke crossing the floor — never just for being held
    // at the bottom (or the handle would re-fire the instant rearm() lands)
    if (prev > 0.02 && this.norm <= 0.02 && this.armed) this._fire(hand);
  }

  endGrab() {
    this.grabbed = false;
  }

  /** Desktop: click the box and the handle throws itself. */
  autoPlunge() {
    if (!this.armed || this.anim === 'down') return;
    this.anim = 'down';
  }

  _fire(hand) {
    this.armed = false;
    this.anim = null;
    hand?.pulse?.(1.0, 250);
    const p = this.bar.getWorldPosition(this._pos);
    // the CHUNK of the rack bottoming out, then the generator whine is
    // covered by the zap already racing down the wire
    this.audio.play('thud', p, { gain: 1.35, refDistance: 1.6, rate: 0.72 });
    this.audio.play('tick', p, { gain: 0.9, refDistance: 0.9, rate: 0.5 });
    this.onFire?.();
  }

  /** Handle springs back up and the box is live again (post-show). */
  rearm() {
    this.armed = true;
    this.anim = 'up';
  }

  update(dt) {
    // armed lamp: slow confident blink when live, dark while the show runs
    this._lampT = (this._lampT ?? 0) + dt;
    const blink = this.armed ? (Math.sin(this._lampT * 4.2) > -0.2 ? 1 : 0.12) : 0.05;
    this.lampMat.color.setRGB(blink, blink * 0.12, blink * 0.06);

    if (this.anim === 'down') {
      this.norm = Math.max(0, this.norm - dt * 3.2);
      this._applyNorm();
      if (this.norm <= 0 && this.armed) this._fire(null);
    } else if (this.anim === 'up') {
      this.norm = Math.min(1, this.norm + dt * 2.2);
      this._applyNorm();
      if (this.norm >= 1) {
        this.anim = null;
        this.audio.play('tick', this.bar.getWorldPosition(this._pos), { gain: 0.7, refDistance: 0.8, rate: 0.9 });
      }
    } else if (!this.grabbed && this.armed && this.norm < 1) {
      // nobody won: the spring shoves the handle back up
      this.norm = Math.min(1, this.norm + dt * 3.5);
      this._applyNorm();
    }
  }
}

// ---------------------------------------------------------------------------
// Crate + restocking

export class Restocker {
  constructor(fireworks, slots) {
    this.fireworks = fireworks;
    this.slots = slots.map((anchor) => ({ anchor, item: null, timer: 0.5 + Math.random() }));
    this.spawnAnims = [];
  }

  notifyTaken(item) {
    for (const s of this.slots) {
      if (s.item === item) {
        s.item = null;
        s.timer = randRange(2.0, 3.5);
      }
    }
  }

  update(dt) {
    for (const s of this.slots) {
      if (s.item) {
        // vacate when the item left, was taken, or was lit in place (a lit
        // item keeps state 'idle' through its fuse — don't restock onto it)
        if (s.item.state !== 'idle' || s.item.isLit || !this.fireworks.items.has(s.item)) {
          s.item = null;
          s.timer = randRange(2.0, 3.5);
        }
        continue;
      }
      s.timer -= dt;
      if (s.timer <= 0) {
        // don't spawn into something still occupying the slot (e.g. a
        // fountain someone lit right in the crate — respect the chaos)
        const anchorPos = s.anchor.getWorldPosition(new THREE.Vector3());
        let blocked = false;
        for (const other of this.fireworks.items) {
          if (other.root.position.distanceToSquared(anchorPos) < 0.09) { blocked = true; break; }
        }
        if (blocked) { s.timer = 1.0; continue; }
        const item = this.fireworks.createItem(this.fireworks.randomTypeName());
        item.root.position.copy(anchorPos);
        item.root.quaternion.copy(s.anchor.getWorldQuaternion(new THREE.Quaternion()));
        item.slotHome = this;
        s.item = item;
        this.spawnAnims.push({ item, t: 0 });
      }
    }
    for (let i = this.spawnAnims.length - 1; i >= 0; i--) {
      const a = this.spawnAnims[i];
      a.t += dt * 2.2;
      if (a.t >= 1 || a.item.state !== 'idle') {
        a.item.root.scale.setScalar(1);
        this.spawnAnims.splice(i, 1);
        continue;
      }
      const k = 1 - Math.pow(1 - a.t, 3);
      a.item.root.scale.setScalar(0.01 + 0.99 * k);
    }
  }
}

function buildCrate() {
  const crate = new THREE.Group();
  const plankMat = woodMat();
  const darkMat = woodMat(WOOD_DARK);
  const W = 0.95, D = 0.6, H = 0.42, T = 0.03;

  const bottom = new THREE.Mesh(new THREE.BoxGeometry(W, T, D), darkMat);
  bottom.position.y = T / 2;
  crate.add(bottom);

  for (const [dx, dz, w, d] of [
    [0, D / 2 - T / 2, W, T], [0, -D / 2 + T / 2, W, T],
    [W / 2 - T / 2, 0, T, D], [-W / 2 + T / 2, 0, T, D],
  ]) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(w, H, d), plankMat);
    wall.position.set(dx, H / 2, dz);
    wall.castShadow = wall.receiveShadow = true;
    crate.add(wall);
  }
  // slats
  for (let i = -1; i <= 1; i += 2) {
    const slat = new THREE.Mesh(new THREE.BoxGeometry(W + 0.02, 0.07, T), darkMat);
    slat.position.set(0, H * 0.55, i * (D / 2 - T / 2 + 0.005));
    slat.castShadow = true;
    crate.add(slat);
  }
  // sandy straw filler
  const straw = new THREE.Mesh(
    new THREE.BoxGeometry(W - T * 2, 0.02, D - T * 2),
    new THREE.MeshStandardMaterial({ color: 0x9a8354, roughness: 0.95 }),
  );
  straw.position.y = H - 0.13;
  crate.add(straw);
  return { crate, W, D, H };
}

function signTexture() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#6b5236';
  g.fillRect(0, 0, 512, 256);
  g.strokeStyle = 'rgba(30,20,10,0.5)';
  for (let i = 0; i < 6; i++) {
    g.lineWidth = 1 + Math.random() * 2;
    g.beginPath();
    g.moveTo(0, 20 + i * 40 + Math.random() * 12);
    g.lineTo(512, 20 + i * 40 + Math.random() * 12);
    g.stroke();
  }
  g.fillStyle = '#f2e3bc';
  g.font = 'bold 62px Georgia, serif';
  g.textAlign = 'center';
  g.fillText('FIREWORKS', 256, 78);
  g.font = '36px Georgia, serif';
  g.fillStyle = '#e8cf9a';
  g.fillText('grab · plant · light', 256, 138);
  g.font = '26px Georgia, serif';
  g.fillStyle = '#c9ab72';
  g.fillText('the crate refills itself', 256, 194);
  g.fillText('— management', 256, 228);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function buildSign() {
  const group = new THREE.Group();
  // post stops at the bottom edge of the board AND sits behind its front face
  // (z = -0.03, front edge ≈ +0.01, board face at +0.02) so the opaque board
  // always hides the post — no occlusion of the text even when looked at from
  // below, where perspective would otherwise throw the post across the sign.
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.04, 1.12, 7), woodMat(0x5a442c));
  post.position.set(0, 0.56, -0.03);
  group.add(post);
  post.castShadow = true;
  const board = new THREE.Mesh(
    new THREE.BoxGeometry(1.0, 0.5, 0.04),
    [woodMat(WOOD_DARK), woodMat(WOOD_DARK), woodMat(WOOD_DARK), woodMat(WOOD_DARK),
      new THREE.MeshStandardMaterial({ map: signTexture(), roughness: 0.72, envMapIntensity: 0.4 }),
      woodMat(WOOD_DARK)],
  );
  board.position.y = 1.35;
  board.rotation.z = 0.02;
  board.castShadow = true;
  group.add(board);
  return group;
}

function exitSignTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#1a0d08';
  g.fillRect(0, 0, 256, 128);
  g.strokeStyle = '#8f2418';
  g.lineWidth = 8;
  g.strokeRect(8, 8, 240, 112);
  g.fillStyle = '#ff5040';
  g.shadowColor = '#ff3020';
  g.shadowBlur = 18;
  g.font = 'bold 64px Georgia, serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('EXIT', 128, 62);
  g.shadowBlur = 0;
  g.font = '20px Georgia, serif';
  g.fillStyle = '#d88a70';
  g.fillText('grab to leave', 128, 104);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function buildExitSign() {
  const group = new THREE.Group();
  // post stops at the bottom edge of the board AND sits behind its front face
  // (z = -0.025, front edge ≈ +0.01, board face at +0.0175) so the opaque
  // board always hides the post — no occlusion of the glowing "EXIT" text,
  // even when looked at from below where perspective would cross it over.
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.035, 1.2, 7), woodMat(0x4a3626));
  post.position.set(0, 0.6, -0.025);
  post.castShadow = true;
  group.add(post);
  // MeshBasic so it glows in the dark like a real exit sign
  const board = new THREE.Mesh(
    new THREE.BoxGeometry(0.5, 0.25, 0.035),
    [woodMat(WOOD_DARK), woodMat(WOOD_DARK), woodMat(WOOD_DARK), woodMat(WOOD_DARK),
      new THREE.MeshBasicMaterial({ map: exitSignTexture() }), woodMat(WOOD_DARK)],
  );
  board.position.y = 1.32;
  board.rotation.z = -0.015;
  group.add(board);
  return { group, board };
}

function buildRocksAndScrub(scene) {
  const rand = mulberry32(2026);
  const rockGeo = new THREE.DodecahedronGeometry(1, 0);
  // faceted stone with a dry mineral sheen — the flat facets catch burst
  // light like real rock faces do
  const rockMat = new THREE.MeshStandardMaterial({
    color: 0x54483a, roughness: 0.82, metalness: 0.05, envMapIntensity: 0.5,
    flatShading: true,
  });
  const rocks = new THREE.InstancedMesh(rockGeo, rockMat, 60);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  for (let i = 0; i < 60; i++) {
    const a = rand() * Math.PI * 2;
    const r = 12 + rand() * 200;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const s = 0.15 + rand() * rand() * 1.6;
    e.set(rand() * 3, rand() * 3, rand() * 3);
    q.setFromEuler(e);
    m.compose(
      new THREE.Vector3(x, terrainHeight(x, z) + s * 0.2, z),
      q,
      new THREE.Vector3(s, s * (0.5 + rand() * 0.6), s),
    );
    rocks.setMatrixAt(i, m);
    // ground each rock with a soft occlusion disc
    if (r < 60) scene.add(contactShadow(x, z, s * 1.5, s * 1.5, 0.35));
  }
  rocks.castShadow = true;
  rocks.receiveShadow = true;
  scene.add(rocks);

  // dead scrub: star-shaped tufts of line segments
  const positions = [];
  for (let b = 0; b < 42; b++) {
    const a = rand() * Math.PI * 2;
    const r = 10 + rand() * 160;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const y = terrainHeight(x, z);
    const twigs = 8 + (rand() * 8) | 0;
    for (let t = 0; t < twigs; t++) {
      const ta = rand() * Math.PI * 2;
      const tl = 0.15 + rand() * 0.4;
      positions.push(
        x, y, z,
        x + Math.cos(ta) * tl * 0.7, y + tl, z + Math.sin(ta) * tl * 0.7,
      );
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  const scrub = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x3d3226 }));
  scene.add(scrub);
}

// ---------------------------------------------------------------------------

export function createWorld(scene, fireworks, pool, audio) {
  // -- light rig --
  const HEMI_SKY = new THREE.Color(0x2b3555);
  const HEMI_INTENSITY = 0.72;
  const hemi = new THREE.HemisphereLight(HEMI_SKY, 0x241d14, HEMI_INTENSITY);
  scene.add(hemi);
  const moon = new THREE.DirectionalLight(0xb8c8e8, 0.65);
  moon.position.copy(MOON_DIR).multiplyScalar(100);
  scene.add(moon);
  scene.add(moon.target); // aims at the origin — the campsite

  // moonlight shadows: a tight ortho box over the play area only, so the
  // shadow pass re-renders a handful of props, not the desert
  moon.castShadow = true;
  moon.shadow.mapSize.set(1024, 1024);
  moon.shadow.camera.left = -22;
  moon.shadow.camera.right = 22;
  moon.shadow.camera.top = 22;
  moon.shadow.camera.bottom = -22;
  moon.shadow.camera.near = 55;
  moon.shadow.camera.far = 150;
  moon.shadow.bias = -0.0004;
  moon.shadow.normalBias = 0.05;
  moon.shadow.radius = 4;

  // image-based night lighting: gives every PBR surface a believable sheen
  // (cool sky from above, warm dust at the horizon, a moon glint)
  scene.environment = createNightEnvMap();

  scene.fog = new THREE.FogExp2(0x0a0d18, 0.0022);

  // -- terrain & sky --
  scene.add(createTerrain());
  const sky = createSky(scene);

  buildRocksAndScrub(scene);

  // -- campsite --
  const { crate, W, D, H } = buildCrate();
  crate.position.set(-1.4, terrainHeight(-1.4, -1.1), -1.1);
  crate.rotation.y = 0.5;
  scene.add(crate);

  // lantern hanging on a hook by the crate (behind where the exit sign now sits)
  const lanternPost = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.025, 1.7, 7), woodMat(0x5a442c));
  lanternPost.position.set(-2.8, terrainHeight(-2.8, -1.4) + 0.85, -1.4);
  lanternPost.rotation.z = 0.06;
  lanternPost.castShadow = true;
  scene.add(lanternPost);
  const lanternBody = new THREE.Mesh(
    new THREE.CylinderGeometry(0.05, 0.06, 0.12, 8),
    // brass housing around a glowing mantle
    new THREE.MeshStandardMaterial({
      color: 0x6a5636, roughness: 0.35, metalness: 0.85,
      emissive: 0xffb050, emissiveIntensity: 0.9,
    }),
  );
  lanternBody.position.set(-2.75, terrainHeight(-2.8, -1.4) + 1.62, -1.4);
  scene.add(lanternBody);
  const lanternLight = new THREE.PointLight(0xffb050, 6, 0, 1.8);
  lanternLight.position.copy(lanternBody.position);
  scene.add(lanternLight);

  // sign
  const sign = buildSign();
  sign.position.set(1.9, terrainHeight(1.9, -1.6), -1.6);
  sign.rotation.y = -0.5;
  scene.add(sign);

  // exit sign — just left of the supply crate, glowing, grab it to leave
  // (moved forward to the old lantern spot so it sits closer to the player)
  const exit = buildExitSign();
  exit.group.position.set(-2.1, terrainHeight(-2.1, -0.4), -0.4);
  exit.group.rotation.y = 0.9;
  scene.add(exit.group);

  // contact shadows: soft occlusion where the campsite meets the sand
  scene.add(
    contactShadow(-1.4, -1.1, 0.75, 0.55, 0.5),   // crate
    contactShadow(1.9, -1.6, 0.35, 0.3, 0.4),     // sign
    contactShadow(-2.1, -0.4, 0.25, 0.22, 0.4),   // exit sign
    contactShadow(-2.8, -1.4, 0.22, 0.2, 0.4),    // lantern post
    contactShadow(-0.5, -1.7, 0.16, 0.16, 0.4),   // torch stake
  );

  // crate slots (3x2 grid of upright anchors inside the crate)
  const slots = [];
  for (let ix = 0; ix < 3; ix++) {
    for (let iz = 0; iz < 2; iz++) {
      const anchor = new THREE.Object3D();
      anchor.position.set(
        (ix - 1) * (W / 3.4),
        H - 0.12,
        (iz - 0.5) * (D / 2.6),
      );
      anchor.rotation.set(randRange(-0.12, 0.12), randRange(0, 6.28), randRange(-0.12, 0.12));
      crate.add(anchor);
      slots.push(anchor);
    }
  }
  const restocker = new Restocker(fireworks, slots);

  // torch, staked by the crate
  const torch = new Torch(scene, pool, audio);
  torch.root.position.set(-0.5, terrainHeight(-0.5, -1.7), -1.7);
  torch.root.rotation.y = 1.2;

  // the TNT detonator, off to the right of camp, wire trailing away toward
  // the mortar battery hidden out in the dunes
  const show = new FinaleShow(fireworks, audio, terrainHeight);
  const detonator = new Detonator(scene, audio, show.pads[4].clone());
  detonator.root.position.set(3.4, terrainHeight(3.4, 0.6), 0.6);
  detonator.root.rotation.y = -1.67; // label toward the campsite
  detonator.layWire(scene);
  scene.add(contactShadow(3.4, 0.6, 0.3, 0.26, 0.45));
  detonator.onFire = () => show.start(detonator.wireCurve);
  show.onEnd = () => detonator.rearm();

  // the spectator lounge behind spawn — scanned furniture, streams in async
  const lounge = createLounge(scene, terrainHeight, contactShadow);

  // THE COLOSSUS — the monumental fire-wheel out west, running its own
  // program all night (see colossus.js for how it earns its size)
  const colossus = createColossus(scene, fireworks, pool, audio);

  return {
    sky,
    torch,
    restocker,
    lanternLight,
    detonator,
    show,
    colossus,
    exitBoard: exit.board,
    update(dt, time) {
      sky.update(dt, time);
      colossus.update(dt, time);
      restocker.update(dt);
      torch.update(dt, time, terrainHeight);
      detonator.update(dt);
      show.update(dt, time);
      lounge.update(time);
      lanternLight.intensity = 5.4 + Math.sin(time * 11) * 0.5 + Math.sin(time * 5.1) * 0.3;
      // bursts overhead wash the whole basin: the hemisphere light briefly
      // brightens and tints toward the shell color, so distant dunes and the
      // campsite flicker with each detonation
      const pulse = fireworks.ambientPulse;
      const e = Math.min(pulse.energy, 2.6);
      hemi.intensity = HEMI_INTENSITY * (1 + e * 1.05);
      hemi.color.copy(HEMI_SKY).lerp(pulse.color, Math.min(0.65, e * 0.45));
    },
  };
}
