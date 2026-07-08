// The drone light show: a swarm of 840 LED quadcopters staged on a pad out
// in the dunes northwest of camp. Each drone is one moving point of light —
// a shape is a point cloud the swarm occupies, and the show is as much the
// morph BETWEEN shapes as the shapes themselves: drones peel off in waves,
// cruise on slow graceful arcs, and arrive together as the next formation
// blooms into place. Deliberately the anti-firework: silent (a faint motor
// hum on the wind), nothing explodes, no particles — just pure saturated
// LED color that can change instantly, ripple, and sweep across the swarm.
//
// Implementation notes:
// - One additive THREE.Points draw call renders every LED; the CPU flies
//   the swarm (840 spring-damper integrations/frame is beneath notice, and
//   it keeps every behavior — staggering, assignment, per-drone color —
//   trivially scriptable).
// - Formations are generated once (deterministic seeds) as N-slot point
//   clouds in a show-local frame whose Z axis faces the campsite, so flat
//   "picture" formations (heart, text) read correctly from camp while 3D
//   ones (sphere, helix, cactus) rotate about the vertical.
// - Retargeting matches drones to slots by rank (height band, then across),
//   which kills most path crossings without an O(n^2) assignment solve.

import * as THREE from 'three';
import { clamp, mulberry32 } from './utils.js';

export const DRONE_COUNT = 1200;

const TWO_PI = Math.PI * 2;

// autopilot: near-critically-damped seek. KP/KD give ~3 s settle; the accel
// clamp keeps departures gentle and the speed clamp sets cruise pace (real
// show drones fly their transitions at a stately 3-8 m/s).
const KP = 2.4;
const KD = 3.1;
const ACC_MAX = 7.0;
const LED = 3.2;            // master LED brightness (HDR — ACES blooms it)
const COLOR_EASE = 4.5;     // 1/s low-pass toward the scene's color

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _c1 = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);

// LED palette — pure saturated emitter colors, kin to the shell PALETTES.
const AMBER = new THREE.Color(0xffb347);
const WARM = new THREE.Color(0xfff3d0);
const TEAL = new THREE.Color(0x17e2c9);
const VIOLET = new THREE.Color(0x9a50ff);
const GOLD = new THREE.Color(0xffc255);
const SCARLET = new THREE.Color(0xff2b36);
const PINK = new THREE.Color(0xff8fae);
const GREEN = new THREE.Color(0x3ce668);
const BLOSSOM = new THREE.Color(0xffe9f0);
const SILVER = new THREE.Color(0xdfe8ff);

// ---------------------------------------------------------------------------
// LED sprite: hard hot core, tight halo — "point of light", not the fat glow
// ball the firework stars use.
function makeLedSprite() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0.0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.3, 'rgba(255,255,255,0.95)');
  grad.addColorStop(0.55, 'rgba(255,255,255,0.3)');
  grad.addColorStop(1.0, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

const VERT = /* glsl */`
  attribute vec3 aColor;
  uniform float uHeight;   // drawing buffer height in px (eye buffer in XR)
  uniform float uSize;     // LED apparent diameter in meters
  varying vec3 vColor;
  void main() {
    vColor = aColor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = clamp(
      uSize * uHeight * projectionMatrix[1][1] * 0.5 / max(0.1, -mv.z),
      1.5, 72.0);
  }
`;

const FRAG = /* glsl */`
  uniform sampler2D uMap;
  varying vec3 vColor;
  void main() {
    float a = texture2D(uMap, gl_PointCoord).a;
    if (a < 0.02) discard;
    // premultiplied with alpha 1: the sprite falloff attenuates linearly
    // (a^2 through the blend equation reads dim at 2-3 px — these LEDs must
    // outshine the background stars, like the real things do)
    gl_FragColor = vec4(vColor * a, 1.0);
  }
`;

// ---------------------------------------------------------------------------
// Formation generators. Each fills exactly N slots and returns
//   { pts: Float32Array(N*3), u: Float32Array(N), v?: Float32Array(N) }
// in show-local meters (x = viewer's right, y = up, z = toward camp), with
// u/v as free per-slot parameters for the scene's coloring (rim-ness,
// strand id, ray fraction, ...). Pad formations are world-space instead
// (world: true) — they drape the actual dunes.

function alloc(N) {
  return { pts: new Float32Array(N * 3), u: new Float32Array(N), v: new Float32Array(N) };
}

// the staging pad: a 40 x 30 grid draped over the sand under the show
function genPad(N, rand, frame) {
  const f = alloc(N);
  f.world = true;
  const COLS = 40;
  const ROWS = N / COLS;
  const { center, right, front, ground } = frame;
  for (let i = 0; i < N; i++) {
    const c = i % COLS, r = (i / COLS) | 0;
    const gx = (c - (COLS - 1) / 2) * 1.5;
    const gz = (r - (ROWS - 1) / 2) * 1.5;
    const x = center.x + right.x * gx + front.x * gz;
    const z = center.z + right.z * gx + front.z * gz;
    f.pts[i * 3] = x;
    f.pts[i * 3 + 1] = ground(x, z) + 0.15;
    f.pts[i * 3 + 2] = z;
    f.u[i] = c / (COLS - 1);
    f.v[i] = r / (ROWS - 1);
  }
  return f;
}

// opening formation: a great glowing wall, 40 x 30, facing camp
function genWall(N, rand) {
  const f = alloc(N);
  const COLS = 40;
  const ROWS = N / COLS;
  for (let i = 0; i < N; i++) {
    const c = i % COLS, r = (i / COLS) | 0;
    f.pts[i * 3] = (c - (COLS - 1) / 2) * 1.9;
    f.pts[i * 3 + 1] = (r - (ROWS - 1) / 2) * 1.55;
    f.pts[i * 3 + 2] = (rand() - 0.5) * 0.9;
    f.u[i] = r / (ROWS - 1);      // 0 bottom -> 1 top
    f.v[i] = c / (COLS - 1);
  }
  return f;
}

function genSphere(N, rand, R = 36) {
  const f = alloc(N);
  const GA = Math.PI * (3 - Math.sqrt(5)); // golden angle
  for (let i = 0; i < N; i++) {
    const y = 1 - 2 * (i + 0.5) / N;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const a = i * GA;
    f.pts[i * 3] = Math.cos(a) * r * R + (rand() - 0.5) * 0.5;
    f.pts[i * 3 + 1] = y * R + (rand() - 0.5) * 0.5;
    f.pts[i * 3 + 2] = Math.sin(a) * r * R + (rand() - 0.5) * 0.5;
    f.u[i] = (1 - y) / 2;         // latitude, 0 bottom -> 1 top
  }
  return f;
}

// double helix: two strands + rungs, a slowly turning ladder of light
function genHelix(N, rand) {
  const f = alloc(N);
  const R = 13, H = 70, TURNS = 2.8;
  const STRAND = 460;             // per strand; the rest are rungs
  let i = 0;
  for (let s = 0; s < 2; s++) {
    for (let k = 0; k < STRAND; k++, i++) {
      const yn = k / (STRAND - 1);
      const th = yn * TURNS * TWO_PI + s * Math.PI;
      f.pts[i * 3] = Math.cos(th) * R + (rand() - 0.5) * 0.5;
      f.pts[i * 3 + 1] = (yn - 0.5) * H;
      f.pts[i * 3 + 2] = Math.sin(th) * R + (rand() - 0.5) * 0.5;
      f.u[i] = s;
      f.v[i] = yn;
    }
  }
  const RUNGS = 25, PER = Math.floor((N - i) / RUNGS); // 8 lights per rung
  for (let rIx = 0; rIx < RUNGS; rIx++) {
    const yn = (rIx + 0.5) / RUNGS;
    const th = yn * TURNS * TWO_PI;
    const ax = Math.cos(th) * R, az = Math.sin(th) * R;
    for (let k = 0; k < PER; k++, i++) {
      const t = (k + 1) / (PER + 1);
      f.pts[i * 3] = ax * (1 - 2 * t);
      f.pts[i * 3 + 1] = (yn - 0.5) * H;
      f.pts[i * 3 + 2] = az * (1 - 2 * t);
      f.u[i] = 0.5;
      f.v[i] = yn;
    }
  }
  // any slots left over from the integer split rejoin the strands
  for (; i < N; i++) {
    const src = (i * 37) % (2 * STRAND);
    f.pts[i * 3] = f.pts[src * 3] + (rand() - 0.5);
    f.pts[i * 3 + 1] = f.pts[src * 3 + 1] + (rand() - 0.5);
    f.pts[i * 3 + 2] = f.pts[src * 3 + 2] + (rand() - 0.5);
    f.u[i] = f.u[src];
    f.v[i] = f.v[src];
  }
  return f;
}

// a monumental saguaro: trunk + two elbowed arms, built from capsule strokes
function genCactus(N, rand) {
  const f = alloc(N);
  // {ax..bz: axis segment, R: radius, n: lights, tipY: crown above this}
  const pieces = [
    { a: [0, -42, 0], b: [0, 42, 0], R: 7.2, n: 570, tipY: 35 },
    { a: [-6.4, -14.4, 0], b: [-20.8, -14.4, 0], R: 4.8, n: 115, tipY: null },
    { a: [-20.8, -14.4, 0], b: [-20.8, 17.6, 0], R: 4.8, n: 215, tipY: 13 },
    { a: [6.4, -1.6, 0], b: [18.4, -1.6, 0], R: 4.8, n: 115, tipY: null },
    { a: [18.4, -1.6, 0], b: [18.4, 24, 0], R: 4.8, n: 185, tipY: 18 },
  ];
  const dir = new THREE.Vector3(), p1 = new THREE.Vector3(), p2 = new THREE.Vector3();
  let i = 0;
  for (const pc of pieces) {
    dir.fromArray(pc.b).sub(p1.fromArray(pc.a));
    const len = dir.length();
    dir.normalize();
    // perpendicular basis for the tube circle
    p1.set(0, 0, 1);
    if (Math.abs(dir.z) > 0.9) p1.set(1, 0, 0);
    p2.crossVectors(dir, p1).normalize();
    p1.crossVectors(p2, dir).normalize();
    for (let k = 0; k < pc.n; k++, i++) {
      const t = rand();
      // rounded ends: radius eases off near the caps
      const cap = Math.min(1, Math.min(t, 1 - t) * len / pc.R + 0.15);
      const rr = pc.R * Math.sqrt(cap) * (0.85 + rand() * 0.3);
      const th = rand() * TWO_PI;
      const x = pc.a[0] + dir.x * len * t + (p1.x * Math.cos(th) + p2.x * Math.sin(th)) * rr;
      const y = pc.a[1] + dir.y * len * t + (p1.y * Math.cos(th) + p2.y * Math.sin(th)) * rr;
      const z = pc.a[2] + dir.z * len * t + (p1.z * Math.cos(th) + p2.z * Math.sin(th)) * rr;
      f.pts[i * 3] = x;
      f.pts[i * 3 + 1] = y;
      f.pts[i * 3 + 2] = z;
      f.u[i] = pc.tipY !== null && y > pc.tipY ? 1 : 0; // 1 = blossom crown
      f.v[i] = (y + 42) / 84;
    }
  }
  // the piece budgets are tuned to DRONE_COUNT; if that ever drifts, park
  // any leftover slots on the trunk instead of letting them pile at origin
  for (; i < N; i++) {
    f.pts[i * 3] = (rand() - 0.5) * 13;
    f.pts[i * 3 + 1] = (rand() - 0.5) * 78;
    f.pts[i * 3 + 2] = (rand() - 0.5) * 13;
    f.v[i] = (f.pts[i * 3 + 1] + 42) / 84;
  }
  return f;
}

// the classic parametric heart, mostly rim with a scattering of fill
function genHeart(N, rand) {
  const f = alloc(N);
  const K = 1.9;
  const heart = (t, out) => {
    const s = Math.sin(t);
    out.x = 16 * s * s * s * K;
    out.y = (13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)) * K + 5;
    return out;
  };
  const p = new THREE.Vector2();
  const RIM = 850;
  for (let i = 0; i < N; i++) {
    const onRim = i < RIM;
    heart(rand() * TWO_PI, p);
    // fill points shrink toward the visual center (0, -3)
    const s = onRim ? 1 : Math.sqrt(rand()) * 0.88;
    f.pts[i * 3] = p.x * s + (rand() - 0.5) * 1.2;
    f.pts[i * 3 + 1] = -3 + (p.y + 3) * s + (rand() - 0.5) * 1.2;
    f.pts[i * 3 + 2] = (rand() - 0.5) * 4.5;
    f.u[i] = onRim ? 1 : s;       // rim-ness for coloring
  }
  return f;
}

// homage to the host: a firework the size of a real break, rebuilt in
// drones — drooping rays around a hot core (and it detonates; see the scene)
function genBurst(N, rand) {
  const f = alloc(N);
  const RAYS = 24, PER = 42;
  const GA = Math.PI * (3 - Math.sqrt(5));
  let i = 0;
  for (let rIx = 0; rIx < RAYS; rIx++) {
    const y = 1 - 2 * (rIx + 0.5) / RAYS;
    const rr = Math.sqrt(Math.max(0, 1 - y * y));
    const a = rIx * GA;
    const dx = Math.cos(a) * rr, dy = y, dz = Math.sin(a) * rr;
    for (let k = 0; k < PER; k++, i++) {
      const q = (k + 0.5) / PER;
      const r = 4 + 40 * Math.pow(q, 0.9);
      const jit = 0.5 + q * 1.0;
      f.pts[i * 3] = dx * r + (rand() - 0.5) * jit;
      f.pts[i * 3 + 1] = dy * r - 10 * q * q + (rand() - 0.5) * jit; // willow droop
      f.pts[i * 3 + 2] = dz * r + (rand() - 0.5) * jit;
      f.u[i] = q;                 // 0 core -> 1 tip, drives the outward wave
      f.v[i] = rIx / (RAYS - 1);
    }
  }
  for (; i < N; i++) {            // the hot core
    const r = 4.5 * Math.cbrt(rand());
    const th = rand() * TWO_PI, ph = Math.acos(2 * rand() - 1);
    f.pts[i * 3] = Math.sin(ph) * Math.cos(th) * r;
    f.pts[i * 3 + 1] = Math.cos(ph) * r;
    f.pts[i * 3 + 2] = Math.sin(ph) * Math.sin(th) * r;
    f.u[i] = 0;
    f.v[i] = 0;
  }
  return f;
}

// crescent moon with a star riding in its hollow
function genMoonStar(N, rand) {
  const f = alloc(N);
  const MOON = 900;
  for (let i = 0; i < MOON; i++) {
    let x = 0, y = 0;
    // sample the outer disc, reject the offset cutout disc -> crescent
    for (let tries = 0; tries < 40; tries++) {
      const r = 26 * Math.sqrt(rand());
      const th = rand() * TWO_PI;
      x = Math.cos(th) * r;
      y = Math.sin(th) * r;
      const cx = x - 10, cy = y;
      if (cx * cx + cy * cy > 22.3 * 22.3) break;
    }
    f.pts[i * 3] = x;
    f.pts[i * 3 + 1] = y;
    f.pts[i * 3 + 2] = (rand() - 0.5) * 3.5;
    f.u[i] = 0;
  }
  // 5-point star at the crescent's opening
  const SCX = 18.5, SCY = 10.5, RO = 8.7, RI = 3.7;
  const vx = [], vy = [];
  for (let k = 0; k < 10; k++) {
    const a = -Math.PI / 2 + k * Math.PI / 5;
    const r = k % 2 === 0 ? RO : RI;
    vx.push(Math.cos(a) * r);
    vy.push(Math.sin(a) * r);
  }
  for (let i = MOON; i < N; i++) {
    const p = rand() * 10;
    const seg = p | 0, fr = p - seg;
    const x0 = vx[seg], y0 = vy[seg];
    const x1 = vx[(seg + 1) % 10], y1 = vy[(seg + 1) % 10];
    const s = i < MOON + 200 ? 1 : Math.sqrt(rand()); // outline + light fill
    f.pts[i * 3] = SCX + (x0 + (x1 - x0) * fr) * s;
    f.pts[i * 3 + 1] = SCY + (y0 + (y1 - y0) * fr) * s;
    f.pts[i * 3 + 2] = (rand() - 0.5) * 2.8;
    f.u[i] = 1;
  }
  return f;
}

// closing card: text sampled off a canvas into the sky
function genText(N, rand, text = 'GOOD NIGHT') {
  const f = alloc(N);
  const W = 800, H = 160;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  let px = 104;
  g.font = `bold ${px}px Georgia, serif`;
  while (g.measureText(text).width > W - 40 && px > 40) {
    px -= 4;
    g.font = `bold ${px}px Georgia, serif`;
  }
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, W / 2, H / 2);
  const data = g.getImageData(0, 0, W, H).data;
  const cand = [];
  for (let y = 0; y < H; y += 2) {
    for (let x = 0; x < W; x += 2) {
      if (data[(y * W + x) * 4 + 3] > 100) cand.push(x, y);
    }
  }
  if (cand.length === 0) {
    // no glyph pixels (headless font weirdness): fall back to a plain bar
    for (let x = 120; x < W - 120; x += 2) cand.push(x, H / 2);
  }
  // deterministic shuffle, then take the first N (re-jittered if short)
  for (let i = cand.length / 2 - 1; i > 0; i--) {
    const j = (rand() * (i + 1)) | 0;
    const tx = cand[i * 2], ty = cand[i * 2 + 1];
    cand[i * 2] = cand[j * 2]; cand[i * 2 + 1] = cand[j * 2 + 1];
    cand[j * 2] = tx; cand[j * 2 + 1] = ty;
  }
  let minX = W, maxX = 0;
  for (let k = 0; k < cand.length; k += 2) {
    if (cand[k] < minX) minX = cand[k];
    if (cand[k] > maxX) maxX = cand[k];
  }
  const M = Math.max(1, cand.length / 2);
  const SCALE = 0.145;
  for (let i = 0; i < N; i++) {
    const k = i % M;
    const x = cand[k * 2] + (rand() - 0.5) * 2;
    const y = cand[k * 2 + 1] + (rand() - 0.5) * 2;
    f.pts[i * 3] = (x - W / 2) * SCALE;
    f.pts[i * 3 + 1] = (H / 2 - y) * SCALE + 4;
    f.pts[i * 3 + 2] = (rand() - 0.5) * 3;
    f.u[i] = maxX > minX ? (x - minX) / (maxX - minX) : 0.5;
  }
  return f;
}

// the flyover centerpiece: a huge ring with an aurora dome swirling above
// it, built DIRECTLY OVER THE CAMPSITE — you stand inside it and look up
function genHalo(N, rand) {
  const f = alloc(N);
  const RING = 500, R = 40;
  for (let i = 0; i < RING; i++) {
    const a = (i / RING) * TWO_PI;
    const rr = R + (rand() - 0.5) * 2.4;
    f.pts[i * 3] = Math.cos(a) * rr;
    f.pts[i * 3 + 1] = (rand() - 0.5) * 1.8;
    f.pts[i * 3 + 2] = Math.sin(a) * rr;
    f.u[i] = i / RING;            // angle around the ring (comet track)
    f.v[i] = 0;                   // 0 = ring
  }
  // dome: a spiral cap climbing from the ring toward an apex
  for (let i = RING; i < N; i++) {
    const k = (i - RING) / (N - RING);
    const a = k * 6.5 * Math.PI;
    const rr = 36 * (1 - k * 0.93) + (rand() - 0.5) * 2.4;
    f.pts[i * 3] = Math.cos(a) * rr;
    f.pts[i * 3 + 1] = 26 * Math.pow(k, 0.75) + (rand() - 0.5) * 1.6;
    f.pts[i * 3 + 2] = Math.sin(a) * rr;
    f.u[i] = (a / TWO_PI) % 1;
    f.v[i] = 0.02 + k * 0.98;     // >0 = dome, climbing to the apex
  }
  return f;
}

// ---------------------------------------------------------------------------
// scene color helpers

// a heartbeat: lub-dub as two gaussian pulses per cycle
function heartbeat(t) {
  const p = (t * 0.95) % 1;
  const g = (c, w) => Math.exp(-((p - c) / w) * ((p - c) / w));
  return g(0.10, 0.045) + 0.55 * g(0.28, 0.05);
}

// the starburst's detonation cycle: assemble small and dense, then surge
// outward fast and relax slowly back — the drone-show cover of a shell
// break, played at drone speed. (The targets outrun the speed cap during
// the surge, so drones lag by radius exactly like real stars do.)
function detScale(t) {
  if (t < 8) return 0.55;         // still assembling the charge
  const p = (t - 8) % 10;
  return p < 1.4
    ? 0.55 + 0.6 * (1 - Math.pow(1 - p / 1.4, 3))
    : 1.15 - (p - 1.4) * 0.07;
}

function detFlash(t) {
  if (t < 8) return 0;
  return 2.4 * Math.exp(-((t - 8) % 10) * 2.2);
}

// ---------------------------------------------------------------------------

export class DroneShow {
  constructor(scene, audio, groundHeight) {
    this.audio = audio;
    const N = DRONE_COUNT;
    this.N = N;

    // show site: high over the dunes due west of camp — the finale's mortar
    // battery owns the northern sky and the moon hangs northwest, so the
    // swarm gets its own dark quarter (and both shows can run at once).
    // Close enough that the big formations span half the sky: awe is an
    // angular quantity, and a drone show you could cover with a thumb is
    // just a screensaver.
    const cx = -72, cz = -25;
    this.center = new THREE.Vector3(cx, groundHeight(cx, cz) + 58, cz);
    // show-local frame: z toward camp so flat formations read from there
    this.front = new THREE.Vector3(-cx, 0, -cz).normalize();
    this.right = new THREE.Vector3().crossVectors(UP, this.front).normalize();

    this.state = 'idle';      // idle | flying
    this.sceneIndex = -1;
    this.sceneT = 0;
    this.onEnd = null;        // hooks for the console
    this.onScene = null;      // (label) => {}
    this.hum = null;

    // program: label / duration / spin (rad/s about vertical) / departure
    // staggering mode ('wave' = raster across the formation, 'sync' = far
    // movers leave first so everyone lands the shape together). A scene may
    // carry its own center — the HALO forms straight over the campsite, and
    // the transit out and back is a river of lights crossing the whole sky.
    const beatScale = (t) => 1 + 0.05 * heartbeat(t);
    this.scenes = [
      {
        label: 'LIFT-OFF', dur: 20, spin: 0, stagger: 5.5, mode: 'wave', vmax: 7,
        gen: genWall,
        color: (i, u, v, t, out) => {
          out.copy(AMBER).lerp(WARM, u);
          out.multiplyScalar(1 + 0.3 * Math.sin(t * 1.7 - u * 5));
        },
      },
      {
        label: 'SPHERE', dur: 22, spin: 0.18, stagger: 2.6, mode: 'sync',
        gen: (n, r) => genSphere(n, r, 36),
        scale: (t) => 1 + 0.05 * Math.sin(t * 0.45), // slow breathing
        color: (i, u, v, t, out) => {
          out.copy(TEAL).lerp(VIOLET, u);
          out.multiplyScalar(1 + 0.42 * Math.sin(t * 1.8 - u * 7)); // climbing ring
        },
      },
      {
        label: 'HALO', dur: 28, spin: 0.2, stagger: 6, mode: 'wave', vmax: 12,
        center: new THREE.Vector3(0, 48, 0), // right over the campsite
        gen: genHalo,
        color: (i, u, v, t, out) => {
          if (v > 0) {
            // aurora dome swirling toward the apex
            out.copy(TEAL).lerp(VIOLET, v * 0.75);
            out.multiplyScalar(0.75 + 0.5 * Math.sin(t * 1.6 - v * 10 + u * 6.3));
          } else {
            // the ring, with two warm comets chasing each other around it
            out.copy(TEAL).multiplyScalar(0.5);
            const w = (t * 0.11) % 1;
            for (const off of [0, 0.5]) {
              let d = Math.abs(u - ((w + off) % 1));
              d = Math.min(d, 1 - d) / 0.045;
              const k = Math.exp(-d * d);
              out.r += 2.6 * k;
              out.g += 2.3 * k;
              out.b += 1.7 * k;
            }
          }
        },
      },
      {
        label: 'DNA HELIX', dur: 24, spin: 0.55, stagger: 4, mode: 'sync',
        gen: genHelix,
        color: (i, u, v, t, out) => {
          if (u < 0.25) out.copy(GOLD);
          else if (u > 0.75) out.copy(TEAL);
          else out.copy(WARM).multiplyScalar(0.4); // rungs, dimmer
          out.multiplyScalar(1 + 0.5 * Math.sin(t * 2.2 - v * 9)); // wave up the ladder
        },
      },
      {
        label: 'SAGUARO', dur: 22, spin: 0.14, stagger: 2.6, mode: 'sync',
        gen: genCactus,
        color: (i, u, v, t, out) => {
          if (u > 0.5) {
            // blossom crowns twinkle white-pink
            out.copy(BLOSSOM).multiplyScalar(1.15 + 0.7 * Math.sin(t * 6 + i * 1.7));
          } else {
            out.copy(GREEN).multiplyScalar(0.65 + 0.55 * v);
          }
        },
      },
      {
        label: 'HEART', dur: 20, spin: 0, stagger: 2.6, mode: 'sync',
        gen: genHeart, scale: beatScale,
        color: (i, u, v, t, out) => {
          out.copy(SCARLET).lerp(PINK, u * u * u);
          out.multiplyScalar(0.8 + 0.6 * heartbeat(t));
        },
      },
      {
        label: 'STARBURST', dur: 30, spin: 0.09, stagger: 2.6, mode: 'sync',
        gen: genBurst,
        scale: detScale,
        color: (i, u, v, t, out) => {
          out.copy(GOLD).lerp(SCARLET, u).lerp(PINK, Math.max(0, u - 0.82) * 5);
          // brightness wave rolling out along the rays + the detonation flash
          const w = (t * 0.3) % 1;
          const d = (u - w) / 0.13;
          out.multiplyScalar(0.75 + 1.5 * Math.exp(-d * d) + detFlash(t));
        },
      },
      {
        label: 'CRESCENT', dur: 20, spin: 0, stagger: 2.6, mode: 'sync',
        gen: genMoonStar,
        color: (i, u, v, t, out) => {
          if (u > 0.5) out.copy(GOLD).multiplyScalar(1.1 + 0.55 * Math.sin(t * 5 + i * 2.1));
          else out.copy(SILVER).multiplyScalar(0.8 + 0.12 * Math.sin(t * 1.1 + i * 0.9));
        },
      },
      {
        label: 'GOOD NIGHT', dur: 24, spin: 0, stagger: 2.6, mode: 'sync',
        gen: (n, r) => genText(n, r, 'GOOD NIGHT'),
        color: (i, u, v, t, out) => {
          const d = (u - ((t * 0.16) % 1.3)) / 0.09; // slow L->R glimmer sweep
          out.copy(WARM).multiplyScalar(0.85 + 0.9 * Math.exp(-d * d));
        },
      },
      {
        label: 'LANDING', dur: 45, spin: 0, stagger: 6, mode: 'wave', vmax: 5.5,
        land: true,
        gen: null, // pad, filled in below
        color: (i, u, v, t, out) => out.copy(AMBER).multiplyScalar(0.8),
      },
    ];

    // per-drone state (flat arrays; the update loop never allocates)
    this.pos = new Float32Array(N * 3);
    this.vel = new Float32Array(N * 3);
    this.tgt = new Float32Array(N * 3);
    this.colStore = new Float32Array(N * 3); // eased LED color, pre-twinkle
    this.slot = new Uint16Array(N);          // drone -> slot in current formation
    this.pend = new Uint16Array(N);
    this.delay = new Float32Array(N);        // departure hold (s)
    this.landedAt = new Float32Array(N).fill(-1);
    const rnd = mulberry32(4242);
    this.phase = new Float32Array(N);        // twinkle/jitter phases
    this.rate = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      this.phase[i] = rnd() * TWO_PI;
      this.rate[i] = 0.7 + rnd() * 1.1;
    }

    // the pad (world space, drapes the dunes) — also the parked formation
    this.pad = genPad(N, mulberry32(99), {
      center: this.center, right: this.right, front: this.front, ground: groundHeight,
    });
    this.scenes[this.scenes.length - 1].data = this.pad;

    // park everyone
    for (let i = 0; i < N; i++) {
      this.pos[i * 3] = this.tgt[i * 3] = this.pad.pts[i * 3];
      this.pos[i * 3 + 1] = this.tgt[i * 3 + 1] = this.pad.pts[i * 3 + 1];
      this.pos[i * 3 + 2] = this.tgt[i * 3 + 2] = this.pad.pts[i * 3 + 2];
      this.slot[i] = this.pend[i] = i;
    }

    // render: one Points, additive, sized in world meters like the pool
    const geo = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos.slice(), 3); // display copy (with hover jitter)
    this.aColor = new THREE.BufferAttribute(new Float32Array(N * 3), 3);
    this.aPos.setUsage(THREE.DynamicDrawUsage);
    this.aColor.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.aPos);
    geo.setAttribute('aColor', this.aColor);
    geo.boundingSphere = new THREE.Sphere(this.center.clone(), 260);
    this.uniforms = {
      uHeight: { value: 1024 },
      uSize: { value: 0.72 },
      uMap: { value: makeLedSprite() },
    };
    this.points = new THREE.Points(geo, new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    }));
    this.points.frustumCulled = false;
    this.points.renderOrder = 4;
    scene.add(this.points);

    // the desert answers the sky: a single pooled light rides the swarm
    // centroid and pools its color on the dunes (always in the scene at
    // intensity 0 when idle — same no-recompile rule as the flash pool),
    // plus a hemisphere contribution world.js folds into the basin wash
    this.light = new THREE.PointLight(0xffffff, 0, 0, 1.8);
    scene.add(this.light);
    this.glow = { color: new THREE.Color(0.5, 0.6, 0.7), energy: 0 };

    // seed display buffers so the parked swarm shows its standby glow
    this.aPos.array.set(this.pos);
    this._scratch = { key: new Float32Array(N), orderA: new Uint16Array(N), orderB: new Uint16Array(N) };
  }

  get running() {
    return this.state !== 'idle';
  }

  get sceneLabel() {
    return this.sceneIndex >= 0 ? this.scenes[this.sceneIndex].label : 'READY';
  }

  setViewHeight(h) {
    if (h) this.uniforms.uHeight.value = h;
  }

  start() {
    if (this.state !== 'idle') return false;
    this.state = 'flying';
    this._enter(0);
    return true;
  }

  /** Jump to the end of the current formation (the console's second press). */
  skip() {
    if (this.state === 'idle') return false;
    const s = this.scenes[this.sceneIndex];
    if (s.land) return false; // landing always plays out
    this.sceneT = s.dur;
    return true;
  }

  // world position of scene `s` slot j at spin angle (c,sn) and scale k
  _slotWorld(s, j, c, sn, k, out) {
    const data = s.data;
    if (data.world) return out.fromArray(data.pts, j * 3);
    const lx0 = data.pts[j * 3], ly = data.pts[j * 3 + 1], lz0 = data.pts[j * 3 + 2];
    const lx = (lx0 * c + lz0 * sn) * k;
    const lz = (-lx0 * sn + lz0 * c) * k;
    const center = s.center ?? this.center;
    const { right, front } = this;
    return out.set(
      center.x + right.x * lx + front.x * lz,
      center.y + ly * k,
      center.z + right.z * lx + front.z * lz,
    );
  }

  /**
   * Retarget the swarm onto scene k's formation. Drones and slots are both
   * ranked by (height band, then across) in the show-local frame and paired
   * by rank — cheap, and it kills the ugly long crossings. Departures are
   * then staggered so the swarm flows instead of snapping.
   */
  _enter(k) {
    this.sceneIndex = k;
    this.sceneT = 0;
    const s = this.scenes[k];
    if (!s.data) s.data = s.gen(this.N, mulberry32(k * 7919 + 11));
    const N = this.N;
    const { key, orderA, orderB } = this._scratch;
    const center = s.center ?? this.center;
    const { right, front } = this;

    // rank key: 4 m height bands, then left-to-right (local x), then depth
    const keyOf = (lx, ly, lz) => ((ly + 300) / 4 | 0) * 4096 + clamp(lx + 200, 0, 400) * 8 + clamp(lz + 200, 0, 400) * 0.01;

    for (let i = 0; i < N; i++) {
      const dx = this.pos[i * 3] - center.x;
      const dy = this.pos[i * 3 + 1] - center.y;
      const dz = this.pos[i * 3 + 2] - center.z;
      key[i] = keyOf(dx * right.x + dz * right.z, dy, dx * front.x + dz * front.z);
      orderA[i] = i;
    }
    orderA.sort((a, b) => key[a] - key[b]);
    const droneRank = orderA.slice();

    for (let j = 0; j < N; j++) {
      if (s.data.world) {
        const dx = s.data.pts[j * 3] - center.x;
        const dy = s.data.pts[j * 3 + 1] - center.y;
        const dz = s.data.pts[j * 3 + 2] - center.z;
        key[j] = keyOf(dx * right.x + dz * right.z, dy, dx * front.x + dz * front.z);
      } else {
        key[j] = keyOf(s.data.pts[j * 3], s.data.pts[j * 3 + 1], s.data.pts[j * 3 + 2]);
      }
      orderB[j] = j;
    }
    orderB.sort((a, b) => key[a] - key[b]);

    // pair by rank, then stagger departures
    const rnd = mulberry32(k * 131 + 7);
    let dmax = 1;
    if (s.mode === 'sync') {
      for (let r = 0; r < N; r++) {
        const i = droneRank[r];
        this._slotWorld(s, orderB[r], 1, 0, 1, _v1);
        const d = Math.hypot(_v1.x - this.pos[i * 3], _v1.y - this.pos[i * 3 + 1], _v1.z - this.pos[i * 3 + 2]);
        key[i] = d; // reuse as distance store
        if (d > dmax) dmax = d;
      }
    }
    for (let r = 0; r < N; r++) {
      const i = droneRank[r];
      this.pend[i] = orderB[r];
      this.delay[i] = s.mode === 'wave'
        ? (r / N) * s.stagger + rnd() * 0.3
        : (1 - key[i] / dmax) * s.stagger + rnd() * 0.25; // far movers first
      this.landedAt[i] = -1;
    }
    this.onScene?.(s.label);
  }

  _finish() {
    this.state = 'idle';
    this.sceneIndex = -1;
    // settle exactly onto the pad and go dark
    for (let i = 0; i < this.N; i++) {
      this.pos[i * 3] = this.tgt[i * 3];
      this.pos[i * 3 + 1] = this.tgt[i * 3 + 1];
      this.pos[i * 3 + 2] = this.tgt[i * 3 + 2];
      this.vel[i * 3] = this.vel[i * 3 + 1] = this.vel[i * 3 + 2] = 0;
    }
    this.aPos.array.set(this.pos);
    this.aPos.needsUpdate = true;
    this.light.intensity = 0;
    this.glow.energy = 0;
    this.hum?.stop(2.0);
    this.hum = null;
    this.onEnd?.();
  }

  update(dt, time) {
    const N = this.N;
    const colArr = this.aColor.array;

    if (this.state === 'idle') {
      this.glow.energy = 0;
      this.light.intensity = 0;
      // parked: a faint red standby breath (walk out to the pad and you'll
      // find a sleeping swarm, not a void); no physics, no position upload
      for (let i = 0; i < N; i++) {
        const b = 0.028 + 0.02 * Math.sin(time * 1.2 * this.rate[i] + this.phase[i]);
        const cs = this.colStore;
        cs[i * 3] += (b - cs[i * 3]) * Math.min(1, dt * COLOR_EASE);
        cs[i * 3 + 1] += (b * 0.09 - cs[i * 3 + 1]) * Math.min(1, dt * COLOR_EASE);
        cs[i * 3 + 2] += (b * 0.04 - cs[i * 3 + 2]) * Math.min(1, dt * COLOR_EASE);
        colArr[i * 3] = cs[i * 3];
        colArr[i * 3 + 1] = cs[i * 3 + 1];
        colArr[i * 3 + 2] = cs[i * 3 + 2];
      }
      this.aColor.needsUpdate = true;
      return;
    }

    // ---- flying ----
    this.sceneT += dt;
    let s = this.scenes[this.sceneIndex];
    if (this.sceneT >= s.dur) {
      if (s.land) { this._finish(); return; }
      this._enter(this.sceneIndex + 1);
      s = this.scenes[this.sceneIndex];
    }

    const t = this.sceneT;
    const spinC = Math.cos(s.spin * t), spinS = Math.sin(s.spin * t);
    const scale = s.scale ? s.scale(t) : 1;
    const vmax = s.vmax ?? 9.5;
    const ease = Math.min(1, dt * COLOR_EASE);
    let cxSum = 0, cySum = 0, czSum = 0, spdSum = 0;
    let mr = 0, mg = 0, mb = 0;
    let landed = 0;

    for (let i = 0; i < N; i++) {
      const i3 = i * 3;

      // departure staggering: held drones keep their frozen target (and
      // their old color) until their wave leaves — the color change sweeps
      // through the swarm with the motion
      let held = false;
      if (this.delay[i] > 0) {
        this.delay[i] -= dt;
        if (this.delay[i] <= 0) this.slot[i] = this.pend[i];
        else held = true;
      } else if (this.slot[i] !== this.pend[i]) {
        this.slot[i] = this.pend[i];
      }

      if (!held) {
        this._slotWorld(s, this.slot[i], spinC, spinS, scale, _v1);
        this.tgt[i3] = _v1.x;
        this.tgt[i3 + 1] = _v1.y;
        this.tgt[i3 + 2] = _v1.z;
      }

      // spring-damper autopilot with acceleration + speed limits
      let ax = KP * (this.tgt[i3] - this.pos[i3]) - KD * this.vel[i3];
      let ay = KP * (this.tgt[i3 + 1] - this.pos[i3 + 1]) - KD * this.vel[i3 + 1];
      let az = KP * (this.tgt[i3 + 2] - this.pos[i3 + 2]) - KD * this.vel[i3 + 2];
      const am = Math.hypot(ax, ay, az);
      if (am > ACC_MAX) { const f = ACC_MAX / am; ax *= f; ay *= f; az *= f; }
      let vx = this.vel[i3] + ax * dt;
      let vy = this.vel[i3 + 1] + ay * dt;
      let vz = this.vel[i3 + 2] + az * dt;
      const vm = Math.hypot(vx, vy, vz);
      if (vm > vmax) { const f = vmax / vm; vx *= f; vy *= f; vz *= f; }
      this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
      this.pos[i3] += vx * dt;
      this.pos[i3 + 1] += vy * dt;
      this.pos[i3 + 2] += vz * dt;

      // touch-down bookkeeping on the landing leg
      if (s.land && !held && this.landedAt[i] < 0) {
        const ddx = this.pos[i3] - this.tgt[i3];
        const ddy = this.pos[i3 + 1] - this.tgt[i3 + 1];
        const ddz = this.pos[i3 + 2] - this.tgt[i3 + 2];
        if (ddx * ddx + ddy * ddy + ddz * ddz < 0.16 && vm < 0.7) {
          this.landedAt[i] = t;
        }
      }
      if (this.landedAt[i] >= 0) landed++;

      // LED color: scene scheme (held drones keep the previous scene's look
      // until they depart), eased, then a shimmer of desert air on top
      if (!held) {
        s.color(i, s.data.u[this.slot[i]], s.data.v[this.slot[i]], t, _c1);
        let b = LED;
        if (this.landedAt[i] >= 0) b *= Math.max(0, 1 - (t - this.landedAt[i]) / 1.8);
        const cs = this.colStore;
        cs[i3] += (_c1.r * b - cs[i3]) * ease;
        cs[i3 + 1] += (_c1.g * b - cs[i3 + 1]) * ease;
        cs[i3 + 2] += (_c1.b * b - cs[i3 + 2]) * ease;
      }
      const tw = 1 + 0.13 * Math.sin(time * (6 + this.rate[i] * 8) + this.phase[i]);
      colArr[i3] = this.colStore[i3] * tw;
      colArr[i3 + 1] = this.colStore[i3 + 1] * tw;
      colArr[i3 + 2] = this.colStore[i3 + 2] * tw;
      mr += colArr[i3]; mg += colArr[i3 + 1]; mb += colArr[i3 + 2];

      // display position: sim + a whisper of hover wander
      const jp = this.phase[i], jr = this.rate[i];
      const pArr = this.aPos.array;
      pArr[i3] = this.pos[i3] + 0.06 * Math.sin(time * jr + jp);
      pArr[i3 + 1] = this.pos[i3 + 1] + 0.06 * Math.sin(time * jr * 1.31 + jp * 2.1);
      pArr[i3 + 2] = this.pos[i3 + 2] + 0.06 * Math.sin(time * jr * 0.83 + jp * 3.7);

      cxSum += this.pos[i3]; cySum += this.pos[i3 + 1]; czSum += this.pos[i3 + 2];
      spdSum += vm;
    }
    this.aPos.needsUpdate = true;
    this.aColor.needsUpdate = true;

    // everyone down (plus a beat of quiet) or the timer runs out -> done
    if (s.land && landed === N && this.sceneT < s.dur - 2.5) {
      this.sceneT = s.dur - 2.5;
    }

    // the desert answers: swarm color pools on the dunes below the fleet
    // and washes the basin — the light is what sells 1200 LEDs as REAL
    // objects hanging over real sand, not pixels on the sky
    const lum = (mr + mg + mb) / (3 * N);           // mean LED brightness
    const cX = cxSum / N, cY = cySum / N, cZ = czSum / N;
    const listDist = this.audio.listenerPos
      ? Math.hypot(cX - this.audio.listenerPos.x, cY - this.audio.listenerPos.y, cZ - this.audio.listenerPos.z)
      : 90;
    const prox = clamp(60 / Math.max(25, listDist), 0.3, 1.4);
    this.light.position.set(cX, cY, cZ);
    this.light.intensity = lum * prox * 30;
    if (lum > 0.001) {
      this.glow.color.setRGB(mr / (N * 3 * lum), mg / (N * 3 * lum), mb / (N * 3 * lum));
    }
    this.glow.energy = clamp(lum * prox * 0.4, 0, 0.7);

    // the swarm hum: one positional HRTF loop parked at the centroid —
    // during the halo transit it audibly crosses the sky over your head —
    // louder and slightly higher when the whole fleet is on the move
    const meanSpd = spdSum / N;
    if (!this.hum && this.audio.ready) {
      this.hum = this.audio.play('droneswarm', _v2.set(cX, cY, cZ), {
        gain: 0.0, loop: true, refDistance: 26, send: 0.25, hrtf: true,
      });
    }
    if (this.hum) {
      this.hum.setPosition(_v2.set(cX, cY, cZ));
      this.hum.setGain(clamp(0.5 + meanSpd * 0.08, 0.5, 1.1));
      this.hum.setRate(0.96 + Math.min(0.1, meanSpd * 0.012));
    }
  }
}
