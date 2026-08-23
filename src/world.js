// World assembly: lighting, terrain, sky, and the little campsite you play
// from — a supply crate that never runs dry, a torch to light fuses with,
// a campfire, an instruction sign, rocks, mesas and scrub. Also owns the
// crate restocker, the shared ground-decal batch (contact shadows + burn
// scorch), and the ambient life that keeps the desert breathing between
// bursts: wind-blown dust, moths at the flames, shooting stars via sky.js.

import * as THREE from 'three';
import { createTerrain, terrainHeight, terrainNormal } from './terrain.js';
import { createSky, createNightEnvMap, MOON_DIR } from './sky.js';
import { FinaleShow } from './show.js';
import { createColossus, COLOSSUS_POS } from './colossus.js';
import { TeleportRing, TeleportStation } from './teleport.js';
import { WIND, updateWind, windGust } from './wind.js';
import { CELL } from './particles.js';
import { mulberry32, randRange, clamp, smoothstep } from './utils.js';
import { mergeGeometries } from '../lib/BufferGeometryUtils.js';

const WOOD = 0x6b5236;
const WOOD_DARK = 0x4a3a26;

function woodMat(color = WOOD) {
  // weathered wood: matte but not dead — a hint of sheen catches the torch
  return new THREE.MeshStandardMaterial({ color, roughness: 0.78, metalness: 0, envMapIntensity: 0.4 });
}

// one shared dark-wood material for every box body / board back — the
// multi-material BoxGeometry idiom cost a draw call per face group
let _darkWood = null;
function darkWoodMat() {
  if (!_darkWood) _darkWood = woodMat(WOOD_DARK);
  return _darkWood;
}

// ---------------------------------------------------------------------------
// Ground decals: ONE InstancedMesh carrying every soft contact-shadow disc
// AND the ring-buffered burn scorch marks the fireworks system stamps down.
// This used to be ~22 separate transparent meshes; now it's one draw call.
// Per-instance opacity rides an InstancedBufferAttribute, and the shader
// fades every decal out by ~130 m from the camera (which also replaces the
// old hard 60 m gate on rock shadows).

const SCORCH_SLOTS = 48;
const _dM = new THREE.Matrix4();
const _dQ = new THREE.Quaternion();
const _dQ2 = new THREE.Quaternion();
const _dV = new THREE.Vector3();
const _dP = new THREE.Vector3();
const _dS = new THREE.Vector3();
const _Z_AXIS = new THREE.Vector3(0, 0, 1);

function decalAtlas() {
  // two cells side by side: [ soft AO disc | ragged char splat ]
  const c = document.createElement('canvas');
  c.width = 256; c.height = 128;
  const g = c.getContext('2d');
  let grad = g.createRadialGradient(64, 64, 2, 64, 64, 62);
  grad.addColorStop(0, 'rgba(0,0,0,0.85)');
  grad.addColorStop(0.55, 'rgba(0,0,0,0.35)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);

  const rand = mulberry32(606);
  g.save();
  g.translate(192, 64);
  grad = g.createRadialGradient(0, 0, 1, 0, 0, 60);
  grad.addColorStop(0, 'rgba(12,8,5,0.95)');
  grad.addColorStop(0.45, 'rgba(13,9,6,0.72)');
  grad.addColorStop(0.78, 'rgba(16,10,6,0.28)');
  grad.addColorStop(1, 'rgba(18,11,6,0)');
  g.fillStyle = grad;
  g.beginPath(); g.arc(0, 0, 60, 0, Math.PI * 2); g.fill();
  // soot rays thrown outward by the blast
  for (let i = 0; i < 26; i++) {
    const a = rand() * Math.PI * 2;
    const r0 = 6 + rand() * 22, r1 = r0 + 12 + rand() * 30;
    g.strokeStyle = `rgba(9,6,4,${0.14 + rand() * 0.3})`;
    g.lineWidth = 1.5 + rand() * 4;
    g.beginPath();
    g.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
    g.lineTo(Math.cos(a) * r1, Math.sin(a) * r1);
    g.stroke();
  }
  // ragged rim: bite nibbles out so the edge never reads as a stamped circle
  g.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 12; i++) {
    const a = rand() * Math.PI * 2;
    const rr = 44 + rand() * 18;
    const nx = Math.cos(a) * rr, ny = Math.sin(a) * rr;
    const nib = g.createRadialGradient(nx, ny, 0, nx, ny, 10 + rand() * 16);
    nib.addColorStop(0, 'rgba(0,0,0,0.85)');
    nib.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = nib;
    g.beginPath(); g.arc(nx, ny, 26, 0, Math.PI * 2); g.fill();
  }
  g.restore();
  return new THREE.CanvasTexture(c);
}

class GroundDecals {
  constructor(scene, capacity = 224) {
    this.capacity = capacity;
    this.staticCount = 0;
    this.cursor = 0;
    this.marks = [];
    for (let i = 0; i < SCORCH_SLOTS; i++) this.marks.push({ active: false, age: 0, life: 1, peak: 0 });
    this._dirty = false;

    const mat = new THREE.MeshBasicMaterial({
      map: decalAtlas(), transparent: true, depthWrite: false, fog: false,
      polygonOffset: true, polygonOffsetFactor: -2,
    });
    mat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>',
          '#include <common>\nattribute float aFade;\nattribute float aCell;\nvarying float vFade;')
        .replace('#include <uv_vertex>',
          '#include <uv_vertex>\n  vMapUv = vMapUv * vec2(0.5, 1.0) + vec2(aCell * 0.5, 0.0);')
        .replace('#include <fog_vertex>',
          // distance fade instead of a pop-gate: decals dissolve by 130 m
          '#include <fog_vertex>\n  vFade = aFade * (1.0 - smoothstep(45.0, 130.0, -mvPosition.z));');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vFade;')
        .replace('#include <map_fragment>', '#include <map_fragment>\n  diffuseColor.a *= vFade;');
    };

    const geo = new THREE.PlaneGeometry(2, 2);
    this.aFade = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    this.aFade.setUsage(THREE.DynamicDrawUsage);
    this.aCell = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    geo.setAttribute('aFade', this.aFade);
    geo.setAttribute('aCell', this.aCell);

    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // instanceMatrix starts all-zero = zero-scale = no fragments for unused slots
    this.mesh.renderOrder = 1;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  _compose(slot, x, z, rx, rz, lift, spin = 0) {
    // hug the local slope (rocks out on the dunes sit on real gradients)
    terrainNormal(x, z, _dV);
    _dQ.setFromUnitVectors(_Z_AXIS, _dV);
    if (spin !== 0) {
      _dQ2.setFromAxisAngle(_Z_AXIS, spin);
      _dQ.multiply(_dQ2);
    }
    _dP.set(x, terrainHeight(x, z) + lift, z);
    _dS.set(rx, rz, 1);
    _dM.compose(_dP, _dQ, _dS);
    this.mesh.setMatrixAt(slot, _dM);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Soft occlusion disc where a prop meets the sand. Set-and-forget. */
  addStatic(x, z, rx, rz, opacity = 0.4) {
    if (this.staticCount >= this.capacity - SCORCH_SLOTS) return;
    const slot = this.staticCount++;
    this._compose(slot, x, z, rx, rz, 0.02);
    this.aFade.array[slot] = opacity;
    this.aCell.array[slot] = 0;
    this.aFade.needsUpdate = true;
    this.aCell.needsUpdate = true;
  }

  /** Burn scorch under a ground effect. FIFO ring: the oldest mark is reused. */
  mark(x, z, radius = 1, strength = 1) {
    const idx = this.cursor;
    this.cursor = (this.cursor + 1) % SCORCH_SLOTS;
    const slot = this.staticCount + idx;
    const r = clamp(radius, 0.25, 7);
    const s = clamp(strength, 0, 1);
    this._compose(slot, x, z, r, r * (0.85 + Math.random() * 0.3), 0.035, Math.random() * Math.PI * 2);
    const m = this.marks[idx];
    m.active = true;
    m.age = 0;
    m.life = 70 + 50 * s; // char lingers, then the wind takes it
    m.peak = 0.3 + 0.45 * s;
    this.aFade.array[slot] = 0;
    this.aCell.array[slot] = 1;
    this.aCell.needsUpdate = true;
    this._dirty = true;
  }

  update(dt) {
    let any = this._dirty;
    for (let i = 0; i < SCORCH_SLOTS; i++) {
      const m = this.marks[i];
      if (!m.active) continue;
      any = true;
      m.age += dt;
      const n = m.age / m.life;
      let a = 0;
      if (n >= 1) m.active = false;
      else a = m.peak * Math.min(1, m.age * 4) * (1 - smoothstep(0.5, 1, n));
      this.aFade.array[this.staticCount + i] = a;
    }
    if (any) {
      this.aFade.needsUpdate = true;
      this._dirty = false;
    }
  }
}

// ---------------------------------------------------------------------------
// Flame sprite sheet — 8 procedural frames, so fire actually licks and tears
// instead of just pulsing one static gradient. Shared by the torch and the
// campfire (different seeds, different tongues).
function makeFlameSheet(seed) {
  const FRAMES = 8;
  const FW = 40, FH = 64;
  const c = document.createElement('canvas');
  c.width = FW * FRAMES; c.height = FH;
  const g = c.getContext('2d');
  const frand = mulberry32(seed);
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
  return { tex, frames: FRAMES };
}

// ---------------------------------------------------------------------------
const _windQ = new THREE.Quaternion();
const _windV = new THREE.Vector3();

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

    const { tex, frames } = makeFlameSheet(515);
    this.flameTex = tex;
    this.flameFrames = frames;
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

    // the flame leans a few centimetres downwind (WIND is world-space; the
    // torch may be held at any angle, so rotate into the anchor's frame)
    this.flameAnchor.getWorldQuaternion(_windQ);
    _windV.copy(WIND).multiplyScalar(0.02).applyQuaternion(_windQ.invert());
    this.flame.position.set(_windV.x, 0.03 + _windV.y, _windV.z);

    // ember sparks curling off the head, drifting with the night's wind
    const p = this.flameWorldPos();
    this._sparkAcc += dt * 26;
    const n = Math.floor(this._sparkAcc);
    this._sparkAcc -= n;
    if (n > 0) {
      const pool = this.pool;
      pool.spawn(n, (i) => {
        pool.set(i,
          p.x + randRange(-0.015, 0.015), p.y + randRange(-0.01, 0.02), p.z + randRange(-0.015, 0.015),
          randRange(-0.12, 0.12) + WIND.x * 0.3, randRange(0.25, 0.7), randRange(-0.12, 0.12) + WIND.z * 0.3,
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
// The campfire — the heart of camp. A ring of stones, crossed logs with
// ember-hot cores, its own flame sheet, one warm point light (created
// unconditionally at startup: the scene's light count must never change),
// embers and woodsmoke from the shared pool, and a low crackling loop.

class Campfire {
  constructor(scene, pool, audio, x, z) {
    this.pool = pool;
    this.audio = audio;
    const gy = terrainHeight(x, z);
    this.pos = new THREE.Vector3(x, gy, z);
    this.flamePos = new THREE.Vector3(x, gy + 0.42, z);

    const group = new THREE.Group();
    group.position.set(x, gy, z);
    scene.add(group);
    this.group = group;

    // stone ring: one InstancedMesh reusing the desert rock kit
    const kit = rockKit();
    const stones = new THREE.InstancedMesh(kit.geo, kit.mat, 9);
    const rand = mulberry32(771);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const sv = new THREE.Vector3();
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2 + rand() * 0.35;
      const r = 0.58 + rand() * 0.09;
      const s = 0.10 + rand() * 0.05;
      e.set(rand() * 3, rand() * 3, rand() * 3);
      q.setFromEuler(e);
      m.compose(
        sv.set(Math.cos(a) * r, s * 0.32, Math.sin(a) * r),
        q,
        new THREE.Vector3(s, s * (0.6 + rand() * 0.5), s),
      );
      stones.setMatrixAt(i, m);
    }
    stones.receiveShadow = true;
    group.add(stones);

    // crossed logs: five cylinders merged into one geometry; open-ended so
    // there are no cap UVs to fight — the emissive map runs hot at v=0.5,
    // which is each log's midpoint, and the logs all cross at the center
    const logGeos = [];
    const lrand = mulberry32(772);
    for (let i = 0; i < 5; i++) {
      const len = 0.55 + lrand() * 0.14;
      const r = 0.032 + lrand() * 0.013;
      const g = new THREE.CylinderGeometry(r * 0.85, r, len, 7, 1, true);
      g.rotateZ(Math.PI / 2 - (0.16 + lrand() * 0.2)); // nearly flat, tips up
      g.rotateY((i / 5) * Math.PI * 2 + (lrand() - 0.5) * 0.5);
      g.translate((lrand() - 0.5) * 0.05, 0.085 + i * 0.022, (lrand() - 0.5) * 0.05);
      logGeos.push(g);
    }
    this.logMat = new THREE.MeshStandardMaterial({
      color: 0x241a10, roughness: 0.95, envMapIntensity: 0.2,
      emissive: 0xff8a28, emissiveMap: this._emberTexture(), emissiveIntensity: 0.8,
    });
    const logs = new THREE.Mesh(mergeGeometries(logGeos), this.logMat);
    logs.castShadow = true;
    group.add(logs);

    // ash bed with a coal-glow heart
    this.ashMat = new THREE.MeshStandardMaterial({
      color: 0x161009, roughness: 1,
      emissive: 0xb04812, emissiveMap: this._coalTexture(), emissiveIntensity: 0.34,
    });
    const ash = new THREE.Mesh(new THREE.CircleGeometry(0.5, 20), this.ashMat);
    ash.rotation.x = -Math.PI / 2;
    ash.position.y = 0.012;
    group.add(ash);

    // flame: the torch's animated-sheet approach at ~1.6x scale
    const { tex, frames } = makeFlameSheet(909);
    this.flameTex = tex;
    this.flameFrames = frames;
    this.flame = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, fog: false,
    }));
    this.flame.scale.set(0.17, 0.29, 1);
    this.flame.position.y = 0.33;
    group.add(this.flame);

    // the ONE new scene light — warm, short throw, no shadow pass
    this.light = new THREE.PointLight(0xff9a40, 1.7, 9, 2.0);
    this.light.position.y = 0.5;
    group.add(this.light);

    this.sound = null;
    this._emberAcc = 0;
    this._smokeAcc = 0;
    this._popT = 4 + Math.random() * 6;
  }

  _emberTexture() {
    // hot band across the middle of v (the logs' crossing point), charring
    // out toward the ends; vertical streaks break the gradient into bark
    const c = document.createElement('canvas');
    c.width = 64; c.height = 64;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 0, 64);
    grad.addColorStop(0, '#000000');
    grad.addColorStop(0.3, '#0d0502');
    grad.addColorStop(0.45, '#c86a20');
    grad.addColorStop(0.5, '#ffd090');
    grad.addColorStop(0.55, '#c86a20');
    grad.addColorStop(0.7, '#0d0502');
    grad.addColorStop(1, '#000000');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    const rand = mulberry32(773);
    g.globalCompositeOperation = 'multiply';
    for (let i = 0; i < 22; i++) {
      const x = rand() * 64;
      const w = 1 + rand() * 3;
      const d = 0.55 + rand() * 0.45;
      g.fillStyle = `rgb(${(d * 255) | 0},${(d * 255) | 0},${(d * 255) | 0})`;
      g.fillRect(x, 0, w, 64);
    }
    return new THREE.CanvasTexture(c);
  }

  _coalTexture() {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 64;
    const g = c.getContext('2d');
    g.fillStyle = '#000';
    g.fillRect(0, 0, 64, 64);
    const grad = g.createRadialGradient(32, 32, 2, 32, 32, 30);
    grad.addColorStop(0, '#ffb060');
    grad.addColorStop(0.45, '#a04a14');
    grad.addColorStop(1, '#000000');
    g.fillStyle = grad;
    g.beginPath(); g.arc(32, 32, 30, 0, Math.PI * 2); g.fill();
    return new THREE.CanvasTexture(c);
  }

  update(dt, time) {
    // ONE flicker term drives the light, the log cores, the coal bed and
    // the flame together, so the whole fire breathes as a single thing
    const flick = Math.sin(time * 12.7) * 0.35 + Math.sin(time * 5.3) * 0.22 + Math.sin(time * 2.1) * 0.13;
    this.light.intensity = 1.7 + flick * 0.62;
    this.logMat.emissiveIntensity = 0.72 + flick * 0.3;
    this.ashMat.emissiveIntensity = 0.3 + flick * 0.14;
    const s = 1 + Math.sin(time * 16.3) * 0.1 + Math.sin(time * 43) * 0.05;
    this.flame.scale.set(0.17 * s, 0.29 * (2 - s) * s, 1);
    // offset the frame walk so torch and campfire never strobe in sync
    this.flameTex.offset.x = ((Math.floor(time * 12.5) + 3) % this.flameFrames) / this.flameFrames;
    this.flame.position.x = WIND.x * 0.05;
    this.flame.position.z = WIND.z * 0.05;

    const P = this.pos;
    const pool = this.pool;

    // embers ride the heat column and bend downwind; the odd log-pop throws
    // a burst of them with an audible crack
    this._emberAcc += dt * (3.2 + windGust() * 5);
    let n = Math.floor(this._emberAcc);
    this._emberAcc -= n;
    this._popT -= dt;
    let popKick = 0;
    if (this._popT <= 0) {
      this._popT = 4 + Math.random() * 8;
      popKick = 9 + ((Math.random() * 6) | 0);
      this.audio.play('tick', this.flamePos, {
        gain: 0.3, rate: 0.5 + Math.random() * 0.22, refDistance: 1.1, send: 0.1,
      });
    }
    const total = n + popKick;
    if (total > 0) {
      let k = 0;
      pool.spawn(total, (i) => {
        const pop = k++ < popKick;
        const vr = pop ? 0.5 : 0.16;
        pool.set(i,
          P.x + randRange(-0.14, 0.14), P.y + randRange(0.08, 0.3), P.z + randRange(-0.14, 0.14),
          randRange(-vr, vr) + WIND.x * 0.35,
          pop ? randRange(1.3, 2.6) : randRange(0.35, 0.9),
          randRange(-vr, vr) + WIND.z * 0.35,
          1.0, 0.5, 0.13,
          time, pop ? randRange(0.5, 1.0) : randRange(1.0, 2.4),
          randRange(0.011, 0.022), -0.1, 1.5, 0);
      });
    }

    // thin woodsmoke, barely there, sliding off downwind
    this._smokeAcc += dt * 1.6;
    n = Math.floor(this._smokeAcc);
    this._smokeAcc -= n;
    if (n > 0) {
      pool.spawn(n, (i) => {
        pool.set(i,
          P.x + randRange(-0.1, 0.1), P.y + randRange(0.35, 0.6), P.z + randRange(-0.1, 0.1),
          WIND.x * 0.45 + randRange(-0.05, 0.05), randRange(0.3, 0.55), WIND.z * 0.45 + randRange(-0.05, 0.05),
          0.16, 0.14, 0.12,
          time, randRange(2.6, 4.6),
          randRange(0.24, 0.4), -0.01, 0.5, -1);
      });
    }

    // low fire loop (the torch loop slowed until it growls) + crackle above
    if (!this.sound && this.audio.ready) {
      this.sound = this.audio.play('torch', this.flamePos, {
        gain: 0.3, rate: 0.75, loop: true, refDistance: 0.9, send: 0.08, hrtf: true,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// The TNT detonator — the cartoon plunger box. Grab the T-handle and shove
// it all the way down; a spark races along the wire to a mortar battery out
// in the dunes and the two-minute grand finale begins. It re-arms (handle
// creaks back up) once the show ends.

function detonatorLabelTexture(line1 = 'GRAND FINALE', line2 = '— plunge to fire —') {
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
  g.fillText(line1, 128, 108);
  g.font = '18px Georgia, serif';
  g.fillText(line2, 128, 132);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class Detonator {
  constructor(scene, audio, wireTarget, opts = {}) {
    this.audio = audio;
    this.armed = true;
    this.grabbed = false;
    this.norm = 1;        // 1 = handle up, 0 = plunged
    this.anim = null;     // 'down' (desktop auto-plunge) | 'up' (re-arm)
    this.onFire = null;
    // desktop HUD lines (each box announces its own purpose)
    this.hintArmed = opts.hintArmed ?? '💥 Click — PLUNGE (grand finale)';
    this.hintBusy = opts.hintBusy ?? 'the finale is running…';

    const root = new THREE.Group();
    this.root = root;

    const W = 0.34, D = 0.26, H = 0.28;
    // one dark box + a thin label quad on the face: the six-material
    // BoxGeometry was six draw calls per detonator
    const box = new THREE.Mesh(new THREE.BoxGeometry(W, H, D), darkWoodMat());
    box.position.y = H / 2;
    box.castShadow = box.receiveShadow = true;
    root.add(box);
    const labelTex = detonatorLabelTexture(opts.labelLine1, opts.labelLine2);
    const label = new THREE.Mesh(
      new THREE.PlaneGeometry(W, H),
      new THREE.MeshStandardMaterial({
        map: labelTex, roughness: 0.7, envMapIntensity: 0.5,
        // faint self-glow so DANGER reads by moonlight, like the wrappers
        emissive: 0xffffff, emissiveMap: labelTex, emissiveIntensity: 0.22,
      }),
    );
    label.position.set(0, H / 2, D / 2 + 0.002);
    root.add(label);

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

// How far the crate rides above the sand on its trestle: puts the item
// slots at ~0.80 m world height — grab height, not an ankle crouch. Slot
// anchors stay children of the crate, so every world-position consumer
// (Restocker, interactions, tests) reads the raised spots automatically.
const CRATE_RAISE = 0.5;

function buildTrestle(W, D) {
  // simple splayed-leg timber stand, merged to a single mesh
  const parts = [];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const leg = new THREE.BoxGeometry(0.075, CRATE_RAISE, 0.075);
      leg.rotateX(sz * -0.09);
      leg.rotateZ(sx * 0.09);
      leg.translate(sx * (W / 2 - 0.1), CRATE_RAISE / 2, sz * (D / 2 - 0.08));
      parts.push(leg);
    }
  }
  for (const sz of [-1, 1]) {
    const rail = new THREE.BoxGeometry(W + 0.06, 0.07, 0.09);
    rail.translate(0, CRATE_RAISE - 0.035, sz * (D / 2 - 0.08));
    parts.push(rail);
  }
  const brace = new THREE.BoxGeometry(0.07, 0.055, D - 0.1);
  brace.translate(0, CRATE_RAISE - 0.17, 0);
  parts.push(brace);
  const mesh = new THREE.Mesh(mergeGeometries(parts), darkWoodMat());
  mesh.castShadow = mesh.receiveShadow = true;
  return mesh;
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
  // dark box + one lettering quad (was a six-material box = six draw calls)
  const board = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.5, 0.04), darkWoodMat());
  board.position.y = 1.35;
  board.rotation.z = 0.02;
  board.castShadow = true;
  const face = new THREE.Mesh(
    new THREE.PlaneGeometry(1.0, 0.5),
    new THREE.MeshStandardMaterial({ map: signTexture(), roughness: 0.72, envMapIntensity: 0.4 }),
  );
  face.position.z = 0.022;
  board.add(face);
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
  // (z = -0.025, front edge ≈ +0.01, face quad at +0.0195) so the opaque
  // board always hides the post — no occlusion of the glowing "EXIT" text,
  // even when looked at from below where perspective would cross it over.
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.035, 1.2, 7), woodMat(0x4a3626));
  post.position.set(0, 0.6, -0.025);
  post.castShadow = true;
  group.add(post);
  // dark box + one glowing quad; the box mesh stays the raycast/grab target
  const board = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.25, 0.035), darkWoodMat());
  board.position.y = 1.32;
  board.rotation.z = -0.015;
  // MeshBasic so it glows in the dark like a real exit sign
  const face = new THREE.Mesh(
    new THREE.PlaneGeometry(0.5, 0.25),
    new THREE.MeshBasicMaterial({ map: exitSignTexture() }),
  );
  face.position.z = 0.0195;
  board.add(face);
  group.add(board);
  return { group, board };
}

// ---------------------------------------------------------------------------
// Rocks: faceted stone with a dry mineral sheen — the flat facets catch
// burst light like real rock faces do. One geometry + material kit shared
// by the desert field and the campfire's stone ring.

let _rockKit = null;
function rockKit() {
  if (!_rockKit) {
    _rockKit = {
      geo: new THREE.DodecahedronGeometry(1, 0),
      mat: new THREE.MeshStandardMaterial({
        color: 0x54483a, roughness: 0.82, metalness: 0.05, envMapIntensity: 0.5,
        flatShading: true,
      }),
    };
  }
  return _rockKit;
}

// jittered variant: displace the dodecahedron's corners. Coincident corners
// (polyhedron geometries are non-indexed) get identical offsets keyed by
// position, so the faces stay welded — no cracks, just a new silhouette.
function jitteredRockGeo(seed) {
  const geo = new THREE.DodecahedronGeometry(1, 0);
  const rand = mulberry32(seed);
  const pos = geo.attributes.position;
  const seen = new Map();
  for (let i = 0; i < pos.count; i++) {
    const key = `${Math.round(pos.getX(i) * 1e3)},${Math.round(pos.getY(i) * 1e3)},${Math.round(pos.getZ(i) * 1e3)}`;
    let o = seen.get(key);
    if (!o) {
      o = [(rand() - 0.5) * 0.5, (rand() - 0.5) * 0.5, (rand() - 0.5) * 0.5];
      seen.set(key, o);
    }
    pos.setXYZ(i, pos.getX(i) + o[0], pos.getY(i) + o[1], pos.getZ(i) + o[2]);
  }
  return geo;
}

function buildRockField(scene, decals) {
  const rand = mulberry32(2026);
  const kit = rockKit();
  const variants = [kit.geo, jitteredRockGeo(101), jitteredRockGeo(202), jitteredRockGeo(303)];
  // four distance bands, area-uniform within each annulus (r = sqrt(u)
  // form), out to ~450 m so the mid distance isn't an empty shelf; the far
  // bands run bigger stones so something still reads through the haze
  const SETS = [
    { geo: 0, count: 74, r0: 12, r1: 95, sMin: 0.15, shadow: true, ao: 120 },
    { geo: 1, count: 72, r0: 55, r1: 200, sMin: 0.2, shadow: false, ao: 120 },
    { geo: 2, count: 84, r0: 140, r1: 340, sMin: 0.4, shadow: false, ao: 0 },
    { geo: 3, count: 76, r0: 200, r1: 450, sMin: 0.5, shadow: false, ao: 0 },
  ];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const p = new THREE.Vector3();
  const sc = new THREE.Vector3();
  for (const set of SETS) {
    const mesh = new THREE.InstancedMesh(variants[set.geo], kit.mat, set.count);
    for (let i = 0; i < set.count; i++) {
      const hero = set.geo === 0 && i >= set.count - 5;
      let x = 0, z = 0, r = 0;
      const inner = (set.r0 / set.r1) ** 2;
      // rejection keeps every stone over actual terrain (the 700 m square)
      for (let tries = 0; tries < 20; tries++) {
        const a = rand() * Math.PI * 2;
        r = hero
          ? 20 + rand() * 60
          : Math.sqrt(inner + rand() * (1 - inner)) * set.r1;
        x = Math.cos(a) * r;
        z = Math.sin(a) * r;
        if (Math.abs(x) < 342 && Math.abs(z) < 342) break;
      }
      // hero boulders: 2.5-4 m landmarks in the near-mid field
      const s = hero ? 1.25 + rand() * 0.75 : set.sMin + rand() * rand() * 1.6;
      e.set(rand() * 3, rand() * 3, rand() * 3);
      q.setFromEuler(e);
      m.compose(
        p.set(x, terrainHeight(x, z) + s * 0.2, z),
        q,
        sc.set(s, s * (0.5 + rand() * 0.6), s),
      );
      mesh.setMatrixAt(i, m);
      // ground the near stones with soft occlusion; the shader distance-fade
      // replaces the old hard 60 m cutoff
      if (set.ao && r < set.ao) {
        decals.addStatic(x, z, s * 1.5, s * 1.5, hero ? 0.4 : 0.35);
      }
    }
    mesh.castShadow = set.shadow;
    mesh.receiveShadow = set.shadow;
    scene.add(mesh);
  }
}

// ---------------------------------------------------------------------------
// Mesas: 8 flat-topped buttes at 300-750 m filling the void between the
// rock field and the mountain silhouettes. One merged geometry, standard
// material so moonlight and burst washes shape them, placed OFF the show
// axis (the show fires north over the pads) and clear of the Colossus
// sightline to the northwest. Bases sink far below the dunes so no seam
// shows over the terrain edge.

function buildMesas(scene) {
  const rand = mulberry32(4127);
  // [math-angle deg, distance, height, top radius] — angles avoid
  // t ∈ [-125,-48] (the show's north sector) and the Colossus bearing
  // (t ≈ -136° ≡ 224°) with margin on both sides
  const SPOTS = [
    [-25, 340, 55, 30], [8, 520, 72, 44], [40, 410, 44, 22], [66, 660, 85, 55],
    [130, 360, 62, 34], [156, 700, 90, 60], [179, 460, 48, 26], [196, 580, 70, 40],
  ];
  // profile rings: [radius factor, height factor] top → sunken apron
  const PROFILE = [
    [1.0, 1.0], [1.08, 0.78], [1.26, 0.36], [1.9, 0.09], [2.8, 0],
  ];
  const N = 16;
  const APRON_Y = -55; // below any possible dune hollow on the sightline
  const positions = [];
  const colors = [];
  const strata = [
    new THREE.Color(0x6b4a33), // dusted plateau top
    new THREE.Color(0x5a3c2b), // cliff brow
    new THREE.Color(0x4e372a), // cliff body
    new THREE.Color(0x413127), // talus
    new THREE.Color(0x362a22), // apron
  ];
  const cTmp = new THREE.Color();
  const pushV = (v, col) => {
    positions.push(v[0], v[1], v[2]);
    colors.push(col.r, col.g, col.b);
  };
  for (const [angDeg, dist0, h0, rt0] of SPOTS) {
    const ang = ((angDeg + (rand() - 0.5) * 9) * Math.PI) / 180;
    const dist = dist0 + (rand() - 0.5) * 50;
    const h = h0 * (0.88 + rand() * 0.28);
    const rt = rt0 * (0.88 + rand() * 0.28);
    const cx = Math.cos(ang) * dist;
    const cz = Math.sin(ang) * dist;
    const base = terrainHeight(cx, cz);
    const warm = 0.9 + rand() * 0.22; // per-mesa tint drift
    // ring vertex grid first, so shared corners agree between bands
    const rings = [];
    for (let ri = 0; ri < PROFILE.length; ri++) {
      const [rf, hf] = PROFILE[ri];
      const ring = [];
      for (let k = 0; k < N; k++) {
        const a = (k / N) * Math.PI * 2;
        const jr = rf * rt * (0.86 + rand() * 0.28);
        const jy = ri < 2 ? (rand() - 0.5) * h * 0.09 : 0; // broken rim
        const y = ri === PROFILE.length - 1 ? APRON_Y : base + h * hf + jy;
        ring.push([cx + Math.cos(a) * jr, y, cz + Math.sin(a) * jr]);
      }
      rings.push(ring);
    }
    // top cap fan
    const top = [cx, base + h * 1.02, cz];
    cTmp.copy(strata[0]).multiplyScalar(warm);
    for (let k = 0; k < N; k++) {
      pushV(top, cTmp);
      pushV(rings[0][(k + 1) % N], cTmp);
      pushV(rings[0][k], cTmp);
    }
    // side bands, colored by stratum
    for (let ri = 0; ri < PROFILE.length - 1; ri++) {
      cTmp.copy(strata[ri + 1]).multiplyScalar(warm);
      for (let k = 0; k < N; k++) {
        const u0 = rings[ri][k], u1 = rings[ri][(k + 1) % N];
        const l0 = rings[ri + 1][k], l1 = rings[ri + 1][(k + 1) % N];
        pushV(u0, cTmp); pushV(l1, cTmp); pushV(l0, cTmp);
        pushV(u0, cTmp); pushV(u1, cTmp); pushV(l1, cTmp);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(colors), 3));
  geo.computeVertexNormals(); // non-indexed → true flat facets
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.96, metalness: 0, envMapIntensity: 0.18,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'mesas';
  scene.add(mesh);
}

// ---------------------------------------------------------------------------
// Vegetation: three species of crossed-quad billboards — dead bush, yucca
// rosette, ocotillo — canvas-drawn, alpha-TESTED (no blend cost), standard
// material so burst light reaches them, with a vertex sway driven by the
// shared wind. Replaces the old 42 unlit line-segment tufts.

const _vegU = {
  uTime: { value: 0 },
  uSway: { value: 0.03 },
  uDir: { value: new THREE.Vector2(1, 0) },
};

function vegWindInject(sh) {
  sh.uniforms.uTime = _vegU.uTime;
  sh.uniforms.uSway = _vegU.uSway;
  sh.uniforms.uDir = _vegU.uDir;
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>',
      '#include <common>\nuniform float uTime;\nuniform float uSway;\nuniform vec2 uDir;')
    .replace('#include <project_vertex>', /* glsl */`
      #ifdef USE_INSTANCING
        vec4 vegWp = modelMatrix * instanceMatrix * vec4(transformed, 1.0);
      #else
        vec4 vegWp = modelMatrix * vec4(transformed, 1.0);
      #endif
      // world-space sway: tips move, roots hold; phase keyed off position so
      // no two plants nod together
      float vegPh = vegWp.x * 0.83 + vegWp.z * 1.27;
      vegWp.xz += uDir * (uv.y * uv.y * uSway
        * (sin(uTime * 2.1 + vegPh) + 0.4 * sin(uTime * 4.7 + vegPh * 1.9)));
      vec4 mvPosition = viewMatrix * vegWp;
      gl_Position = projectionMatrix * mvPosition;
    `);
}

function bushTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const rand = mulberry32(313);
  const branch = (x, y, ang, len, w, depth) => {
    const nx = x + Math.cos(ang) * len;
    const ny = y - Math.sin(ang) * len;
    g.strokeStyle = depth > 2 ? '#4b3a26' : '#5d4930';
    g.lineWidth = Math.max(1.6, w);
    g.beginPath(); g.moveTo(x, y); g.lineTo(nx, ny); g.stroke();
    if (depth >= 5 || len < 5) return;
    const kids = 2 + (rand() * 2) | 0;
    for (let i = 0; i < kids; i++) {
      branch(nx, ny, ang + (rand() - 0.5) * 1.3, len * (0.6 + rand() * 0.2), w * 0.65, depth + 1);
    }
  };
  for (let t = 0; t < 3; t++) {
    branch(64 + (t - 1) * 7, 126, Math.PI / 2 + (t - 1) * 0.35 + (rand() - 0.5) * 0.2,
      22 + rand() * 12, 3.4, 1);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function yuccaTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const rand = mulberry32(414);
  // dead thatch skirt first, green rosette over it
  for (let pass = 0; pass < 2; pass++) {
    const n = pass ? 22 : 10;
    for (let i = 0; i < n; i++) {
      const ang = pass
        ? 0.35 + (i / (n - 1)) * (Math.PI - 0.7) + (rand() - 0.5) * 0.14
        : 0.1 + (i / (n - 1)) * (Math.PI - 0.2);
      const len = pass ? 38 + rand() * 26 : 22 + rand() * 12;
      const tipX = 64 + Math.cos(ang) * len;
      const tipY = 124 - Math.sin(ang) * (pass ? len : len * 0.4);
      const bw = pass ? 3 + rand() * 3 : 2.5;
      const t = rand();
      g.fillStyle = pass
        ? `rgb(${72 + t * 24},${86 + t * 22},${58 + t * 16})`
        : `rgb(${118 + t * 24},${100 + t * 18},${64 + t * 10})`;
      g.beginPath();
      g.moveTo(64 - bw, 126);
      g.lineTo(tipX, tipY);
      g.lineTo(64 + bw, 126);
      g.closePath();
      g.fill();
      if (pass && rand() < 0.5) {
        // pale tip highlight catches the moon
        g.fillStyle = 'rgba(190,196,150,0.8)';
        g.beginPath(); g.arc(tipX, tipY, 1.6, 0, Math.PI * 2); g.fill();
      }
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function ocotilloTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const rand = mulberry32(616);
  const wands = 6 + (rand() * 2) | 0;
  for (let i = 0; i < wands; i++) {
    const spread = (i / (wands - 1) - 0.5) * 1.6 + (rand() - 0.5) * 0.2;
    let x = 64, y = 126;
    let ang = Math.PI / 2 + spread * 0.35;
    g.strokeStyle = '#3d3428';
    g.lineWidth = 2.6;
    g.beginPath(); g.moveTo(x, y);
    const segs = 7;
    for (let sgt = 0; sgt < segs; sgt++) {
      ang += spread * 0.09 + (rand() - 0.5) * 0.1;
      const len = 15 + rand() * 6;
      x += Math.cos(ang) * len * 0.55;
      y -= Math.sin(ang) * len;
      g.lineTo(x, y);
      g.lineWidth = Math.max(1.6, 2.6 - sgt * 0.15);
    }
    g.stroke();
    // spring bloom at the wand tip
    g.fillStyle = 'rgba(150,58,30,0.95)';
    g.beginPath(); g.arc(x, y, 2.4, 0, Math.PI * 2); g.fill();
    // thorn/leaf specks along the wand
    g.fillStyle = 'rgba(92,81,54,0.8)';
    for (let sp = 0; sp < 10; sp++) {
      const t = rand();
      g.fillRect(64 + (x - 64) * t + (rand() - 0.5) * 3, 126 + (y - 126) * t, 1.4, 1.4);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function buildVegetation(scene) {
  // crossed quads, bottom-anchored so sway pivots at the root
  const p1 = new THREE.PlaneGeometry(1, 1);
  p1.translate(0, 0.5, 0);
  const p2 = p1.clone();
  p2.rotateY(Math.PI / 2);
  const crossGeo = mergeGeometries([p1, p2]);

  const SPECIES = [
    { tex: bushTexture(), count: 92, sx: [0.55, 1.0], sy: [0.4, 0.75] },
    { tex: yuccaTexture(), count: 62, sx: [0.5, 0.9], sy: [0.42, 0.8] },
    { tex: ocotilloTexture(), count: 44, sx: [0.9, 1.4], sy: [1.2, 2.2] },
  ];

  const rand = mulberry32(5150);
  // keep the wheel-rut track to the Colossus clear of shrubbery
  const trailDir = new THREE.Vector2(COLOSSUS_POS.x, COLOSSUS_POS.z).normalize();
  const trailPerp = new THREE.Vector2(-trailDir.y, trailDir.x);
  const spot = () => {
    for (let tries = 0; tries < 24; tries++) {
      const a = rand() * Math.PI * 2;
      // denser near the camp paths, sparse out to ~180 m
      const r = rand() < 0.62 ? 7.5 + Math.sqrt(rand()) * 52 : 48 + Math.sqrt(rand()) * 130;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      const d = x * trailDir.x + z * trailDir.y;
      if (d > 10 && d < 260) {
        const wob = Math.sin(d * 0.045) * 2.2 + Math.sin(d * 0.013) * 4.5;
        if (Math.abs(x * trailPerp.x + z * trailPerp.y - wob) < 4.2) continue;
      }
      return [x, z];
    }
    return [30 + rand() * 20, 30 + rand() * 20];
  };

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  const Y_AXIS = new THREE.Vector3(0, 1, 0);
  for (const sp of SPECIES) {
    const mat = new THREE.MeshStandardMaterial({
      map: sp.tex, alphaTest: 0.35, side: THREE.DoubleSide,
      roughness: 0.9, metalness: 0, envMapIntensity: 0.25,
    });
    mat.onBeforeCompile = vegWindInject;
    const mesh = new THREE.InstancedMesh(crossGeo, mat, sp.count);
    for (let i = 0; i < sp.count; i++) {
      const [x, z] = spot();
      q.setFromAxisAngle(Y_AXIS, rand() * Math.PI * 2);
      const w = randLerp(rand, sp.sx);
      m.compose(
        p.set(x, terrainHeight(x, z) - 0.02, z),
        q,
        s.set(w, randLerp(rand, sp.sy), w),
      );
      mesh.setMatrixAt(i, m);
    }
    scene.add(mesh);
  }
}

const randLerp = (rand, [a, b]) => a + rand() * (b - a);

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

  // -- terrain & sky --
  scene.add(createTerrain());
  const sky = createSky(scene, pool);

  // fog derives FROM the dome: far terrain and the mesas dissolve into the
  // same horizon band the sky paints, so distance reads as haze, not a seam.
  // Density up from 0.0022 so the terrain edge is gone and the buttes emerge
  // from the murk — but held where the Colossus (280 m) still reads clearly.
  scene.fog = new THREE.FogExp2(sky.fogColor.getHex(), 0.0027);
  scene.fog.color.copy(sky.fogColor);

  // shared ground-decal batch: contact shadows + scorch, ONE draw call
  const decals = new GroundDecals(scene);

  buildRockField(scene, decals);
  buildMesas(scene);
  buildVegetation(scene);

  // -- campsite --
  const { crate, W, D, H } = buildCrate();
  crate.add(buildTrestle(W, D).translateY(-CRATE_RAISE));
  crate.position.set(-1.4, terrainHeight(-1.4, -1.1) + CRATE_RAISE, -1.1);
  crate.rotation.y = 0.5;
  scene.add(crate);

  // lantern hanging on a hook by the crate (behind where the exit sign now sits)
  const lanternPost = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.025, 1.7, 7), woodMat(0x5a442c));
  const lgy = terrainHeight(-2.8, -1.4);
  lanternPost.position.set(-2.8, lgy + 0.85, -1.4);
  lanternPost.rotation.z = 0.06;
  lanternPost.castShadow = true;
  scene.add(lanternPost);
  const lanternBodyMat = new THREE.MeshStandardMaterial({
    // brass housing around a glowing mantle
    color: 0x6a5636, roughness: 0.35, metalness: 0.85,
    emissive: 0xffb050, emissiveIntensity: 0.9,
  });
  const lanternBody = new THREE.Mesh(
    new THREE.CylinderGeometry(0.05, 0.06, 0.12, 8), lanternBodyMat,
  );
  lanternBody.position.set(-2.75, lgy + 1.62, -1.4);
  lanternBody.castShadow = true;
  scene.add(lanternBody);
  // the missing hardware: a brass crook off the post top and the bail the
  // lantern actually hangs from (merged, one mesh)
  {
    const brass = new THREE.MeshStandardMaterial({
      color: 0x6a5636, roughness: 0.4, metalness: 0.85, envMapIntensity: 0.8,
    });
    const arm = new THREE.CylinderGeometry(0.011, 0.011, 0.13, 6);
    arm.rotateZ(Math.PI / 2);
    arm.translate(-2.79, lgy + 1.678, -1.4);
    const bail = new THREE.TorusGeometry(0.026, 0.006, 6, 14);
    bail.rotateY(0.35);
    bail.translate(-2.75, lgy + 1.669, -1.4);
    const hardware = new THREE.Mesh(mergeGeometries([arm, bail]), brass);
    scene.add(hardware);
  }
  // glass sleeve: no light of its own, just the mantle's glow made visible
  const lanternGlassMat = new THREE.MeshBasicMaterial({
    color: 0xffb46a, transparent: true, opacity: 0.3, depthWrite: false,
    blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const lanternGlass = new THREE.Mesh(
    new THREE.CylinderGeometry(0.054, 0.06, 0.09, 8, 1, true), lanternGlassMat,
  );
  lanternGlass.position.set(-2.75, lgy + 1.625, -1.4);
  scene.add(lanternGlass);
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

  // the campfire: south of the crate, clear of the walk line to the
  // detonator, close enough that its light laps at the camp props
  const campfire = new Campfire(scene, pool, audio, -1.3, 2.0);

  // contact shadows: soft occlusion where the campsite meets the sand
  decals.addStatic(-1.4, -1.1, 0.85, 0.65, 0.48);  // crate on its trestle
  decals.addStatic(1.9, -1.6, 0.35, 0.3, 0.4);     // sign
  decals.addStatic(-2.1, -0.4, 0.25, 0.22, 0.4);   // exit sign
  decals.addStatic(-2.8, -1.4, 0.22, 0.2, 0.4);    // lantern post
  decals.addStatic(-0.5, -1.7, 0.16, 0.16, 0.4);   // torch stake
  decals.addStatic(-1.3, 2.0, 0.8, 0.8, 0.3);      // fire pit ash halo

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
  decals.addStatic(3.4, 0.6, 0.3, 0.26, 0.45);
  detonator.onFire = () => show.start(detonator.wireCurve);
  show.onEnd = () => detonator.rearm();

  // THE COLOSSUS — the monumental fire-wheel out west, running its own
  // program all night (see colossus.js for how it earns its size)
  const colossus = createColossus(scene, fireworks, pool, audio);

  // teleport rings: one hanging under the Colossus trailhead sign that
  // whisks you out to stand at the wheel's feet, and a waypost out there
  // that brings you home. The 280 m stays real — the ride is a courtesy,
  // not a shrinking of the world.
  const colDir = new THREE.Vector3(COLOSSUS_POS.x, 0, COLOSSUS_POS.z).normalize();
  const colPerp = new THREE.Vector3(-colDir.z, 0, colDir.x);
  const hubXZ = new THREE.Vector3(COLOSSUS_POS.x, 0, COLOSSUS_POS.z);
  // land ~8 m off the paved apron, camp side, right under the arc of the rim
  const colossusArrive = hubXZ.clone().addScaledVector(colDir, -32);
  const toColossus = new TeleportRing({
    parent: colossus.trailSign, audio, pool,
    // tied under the board's bottom edge, on the camp-facing side of the post
    attach: new THREE.Vector3(0, 1.12, -0.06),
    drop: 0.12,
    dest: colossusArrive,
    destFace: hubXZ, // arrive facing the wheel — the whole point
    hint: 'Click the ring — ride out to the Colossus',
  });
  const toCamp = new TeleportStation({
    scene, audio, pool,
    position: colossusArrive.clone().addScaledVector(colPerp, 3.4),
    faceTarget: colossusArrive, // board faces where riders land
    dest: new THREE.Vector3(0.6, 0, 1.8),
    destFace: new THREE.Vector3(-1.4, 0, -1.1), // arrive facing the crate
    title: 'BACK TO CAMP',
    sub1: 'grab the ring below',
    sub2: '— home in a blink —',
    hint: 'Click the ring — snap back to camp',
  });
  const teleporters = [toColossus, toCamp];
  decals.addStatic(toCamp.root.position.x, toCamp.root.position.z, 0.3, 0.26, 0.4);

  // the keeper's firing box: a second plunger by the landing spot, wired to
  // the near A-frame foot. When the wheel has sputtered out (or gone dark
  // between shows), plunge it to kindle the whole program over again — it
  // re-arms itself whenever the Colossus is askable.
  const colossusDet = new Detonator(scene, audio, colossus.wireAnchor.clone(), {
    labelLine1: 'THE COLOSSUS',
    labelLine2: '— plunge to wake —',
    hintArmed: '💥 Click — PLUNGE (wake the Colossus)',
    hintBusy: 'the Colossus is burning…',
  });
  const detPos = colossusArrive.clone().addScaledVector(colPerp, -2.8);
  colossusDet.root.position.set(detPos.x, terrainHeight(detPos.x, detPos.z), detPos.z);
  colossusDet.root.rotation.y = Math.atan2(colossusArrive.x - detPos.x, colossusArrive.z - detPos.z);
  colossusDet.layWire(scene);
  decals.addStatic(detPos.x, detPos.z, 0.3, 0.26, 0.45);
  colossusDet.onFire = () => colossus.ignite();

  // ground-scorch contract: the fireworks system stamps char under ground
  // effects via fireworks.groundMark?.(x, z, radius, strength)
  fireworks.groundMark = (x, z, radius, strength) => decals.mark(x, z, radius, strength);

  // -- ambient life state --
  // moths: warm specks orbiting the two flames in wobbly ellipses, redrawn
  // from the pool every frame — alive, and zero draw calls
  const moths = [];
  {
    const mr = mulberry32(88);
    for (let i = 0; i < 4; i++) {
      moths.push({
        fire: i >= 2, // two on the torch, two on the campfire
        a: mr() * 6.28, w: 2.4 + mr() * 2.4, ph: mr() * 6.28,
        ra: 0.12 + mr() * 0.16, rb: 0.08 + mr() * 0.1,
        x: 0, y: 0, z: 0, has: false, acc: 0,
      });
    }
  }
  const _mothC = new THREE.Vector3();
  let dustAcc = 0;
  let windLvl = 0;

  return {
    sky,
    torch,
    restocker,
    lanternLight,
    campfire,
    detonator,
    show,
    colossus,
    teleporters,
    colossusDetonator: colossusDet,
    detonators: [detonator, colossusDet],
    exitBoard: exit.board,
    setViewport(fbWidth, fbHeight) {
      sky.setViewport(fbWidth, fbHeight);
    },
    update(dt, time) {
      updateWind(dt, time); // the one place the shared wind advances
      sky.update(dt, time, fireworks.ambientPulse);
      colossus.update(dt, time);
      for (const tp of teleporters) tp.update(dt, time);
      restocker.update(dt);
      torch.update(dt, time, terrainHeight);
      campfire.update(dt, time);
      detonator.update(dt);
      colossusDet.update(dt);
      // the keeper's box springs live again once the wheel can take a light
      const cph = colossus.state.phase;
      if (!colossusDet.armed && !colossusDet.grabbed && colossusDet.anim !== 'down'
        && (cph === 'dark' || cph === 'sputter')) colossusDet.rearm();
      show.update(dt, time);
      decals.update(dt);

      // lantern: light, mantle and glass all breathe on the same term
      const lFlick = Math.sin(time * 11) * 0.5 + Math.sin(time * 5.1) * 0.3;
      lanternLight.intensity = 5.4 + lFlick;
      lanternBodyMat.emissiveIntensity = 0.9 + lFlick * 0.28;
      lanternGlassMat.opacity = 0.3 + lFlick * 0.05;

      // vegetation leans into the shared wind
      _vegU.uTime.value = time;
      const wl = Math.hypot(WIND.x, WIND.z);
      _vegU.uSway.value = Math.min(0.13, 0.012 + wl * 0.028 + windGust() * 0.05);
      if (wl > 1e-4) _vegU.uDir.value.set(WIND.x / wl, WIND.z / wl);

      // wind-blown dust: long-lived near-transparent grains drifting through
      // the play area — felt, not seen; density surges with the gusts
      dustAcc += dt * (9 + 9 * windGust());
      const dn = Math.floor(dustAcc);
      dustAcc -= dn;
      if (dn > 0) {
        pool.spawn(dn, (i) => {
          const a = Math.random() * Math.PI * 2;
          const r = 8 + Math.sqrt(Math.random()) * 38;
          const x = Math.cos(a) * r, z = Math.sin(a) * r;
          const alb = 0.75 + Math.random() * 0.5;
          pool.set(i,
            x, terrainHeight(x, z) + randRange(0.3, 1.8), z,
            WIND.x * randRange(0.65, 1.2), randRange(-0.04, 0.05), WIND.z * randRange(0.65, 1.2),
            0.36 * alb, 0.305 * alb, 0.235 * alb,
            time, randRange(7, 12),
            randRange(1.1, 2.0), 0, 0.12, -1);
        });
      }

      // moths at the flames
      for (const mo of moths) {
        const c = mo.fire ? campfire.flamePos : torch.flameWorldPos(_mothC);
        mo.a += dt * mo.w * (0.7 + 0.5 * Math.sin(time * 0.83 + mo.ph));
        const ra = mo.ra * (1 + 0.3 * Math.sin(time * 1.13 + mo.ph * 2));
        const nx = c.x + Math.cos(mo.a) * ra + Math.sin(time * 6.1 + mo.ph) * 0.02;
        const ny = c.y + 0.04 + Math.sin(mo.a * 2 + mo.ph) * 0.07 + Math.sin(time * 2.9 + mo.ph) * 0.04;
        const nz = c.z + Math.sin(mo.a) * mo.rb + Math.cos(time * 5.3 + mo.ph) * 0.02;
        const vx = mo.has && dt > 0 ? (nx - mo.x) / dt : 0;
        const vy = mo.has && dt > 0 ? (ny - mo.y) / dt : 0;
        const vz = mo.has && dt > 0 ? (nz - mo.z) / dt : 0;
        mo.x = nx; mo.y = ny; mo.z = nz; mo.has = true;
        mo.acc += dt * 34;
        const mn = Math.floor(mo.acc);
        mo.acc -= mn;
        if (mn > 0) {
          pool.spawn(mn, (i) => {
            pool.set(i, nx, ny, nz, vx, vy, vz,
              0.5, 0.35, 0.15,
              time, 0.08, 0.012, 0, 0, 0, CELL.GLOW, 0.05, 0);
          });
        }
      }

      // the audio wind bed breathes with the same gusts the dust rides
      windLvl += (windGust() - windLvl) * Math.min(1, dt * 1.3);
      audio.setWindLevel?.(clamp(windLvl, 0, 1));

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
