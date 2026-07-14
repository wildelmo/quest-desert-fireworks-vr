// Fireworks gameplay: the items you hold and plant, burning fuses, rocket
// flight, and the shell-burst choreography (peony, dahlia, chrysanthemum,
// willow, palm, ring, saturn, crossette, crackle, strobe, serpents, brocade,
// kamuro, ghost, horsetail, falling leaves, time-rain, multi-break) drawn
// through the GPU particle pool. Also owns the pooled flash lights that slam
// the terrain with color on every burst.

import * as THREE from 'three';
import { randRange, randPick, clamp } from './utils.js';
import { CELL } from './particles.js';

// Colorways matched to a classic display photo: a huge amber-gold
// chrysanthemum, scarlet shells with pale pink tips, teal/aqua shells (one
// breaking over a warm ember core), royal violet — plus gold and silver for
// brocade/glitter work, and the real pyro-chemistry colors (barium green,
// copper blue, strontium red) a display crew would actually shoot.
// a = the shell's stars, b = tips/pistil/accents.
export const PALETTES = [
  { name: 'golden brocade', a: 0xffab42, b: 0xffe9b0 },
  { name: 'scarlet pink', a: 0xff2430, b: 0xff8fae },
  { name: 'oasis teal', a: 0x1fe8c6, b: 0xa9fff2 },
  { name: 'teal ember', a: 0x25e0b4, b: 0xff8632 },
  { name: 'royal violet', a: 0xa14fff, b: 0xff5ad2 },
  { name: 'crimson gold', a: 0xff4033, b: 0xffb347 },
  { name: 'pure gold', a: 0xffc04d, b: 0xfff2bb },
  { name: 'silver', a: 0xeef2ff, b: 0xcfd8ff },
  { name: 'barium emerald', a: 0x2ee94e, b: 0xc2ffd4 },
  { name: 'copper blue', a: 0x3c78ff, b: 0xa8c9ff },
  { name: 'blue gold', a: 0x4a82ff, b: 0xffc04d },
  { name: 'strontium red', a: 0xff2d12, b: 0xffa06b },
];

export const ITEM_TYPES = {
  rocketSmall: {
    kind: 'rocket', label: 'Bottle Rocket',
    bodyR: 0.018, bodyLen: 0.11, stickLen: 0.55,
    size: 0.32, fuseTime: 2.0, thrust: 46, burnTime: 0.85, coast: 1.15,
    shells: ['peony', 'dahlia', 'ring', 'crackle', 'strobe', 'ghost'],
    weight: 3,
  },
  rocketMed: {
    kind: 'rocket', label: 'Sky Rocket',
    bodyR: 0.028, bodyLen: 0.17, stickLen: 0.72,
    size: 0.6, fuseTime: 2.6, thrust: 42, burnTime: 1.4, coast: 1.5,
    shells: ['peony', 'dahlia', 'chrys', 'willow', 'ring', 'saturn', 'crossette', 'crackle', 'serpents', 'ghost'],
    weight: 3,
  },
  rocketLarge: {
    kind: 'rocket', label: 'Mammoth Rocket',
    bodyR: 0.042, bodyLen: 0.26, stickLen: 0.92,
    size: 1.3, fuseTime: 3.2, thrust: 43, burnTime: 2.1, coast: 2.2,
    shells: ['peony', 'dahlia', 'chrys', 'willow', 'palm', 'crossette', 'brocade', 'serpents', 'multibreak', 'kamuro', 'ghost', 'saturn', 'horsetail'],
    weight: 2,
  },
  rocketGrand: {
    kind: 'rocket', label: 'Grand Shell Rocket',
    bodyR: 0.058, bodyLen: 0.36, stickLen: 1.14,
    size: 1.8, fuseTime: 3.6, thrust: 45, burnTime: 2.45, coast: 2.45,
    // dahlia twice: the grand shells are the display pieces, and the
    // long-ray dahlia is the postcard look they exist for
    shells: ['peony', 'dahlia', 'dahlia', 'chrys', 'willow', 'palm', 'brocade', 'serpents', 'multibreak', 'kamuro', 'kamuro', 'ghost', 'timerain', 'horsetail', 'leaves'],
    weight: 2,
  },
  fountain: {
    kind: 'fountain', label: 'Desert Bloom Fountain',
    baseR: 0.075, height: 0.17,
    size: 0.5, fuseTime: 2.2, duration: 10,
    weight: 1,
  },
  pinwheel: {
    kind: 'pinwheel', label: 'Dust Devil Pinwheel',
    stickLen: 0.85, wheelR: 0.14, drivers: 4,
    size: 0.5, fuseTime: 2.0, duration: 9,
    weight: 2,
  },
  candle: {
    kind: 'candle', label: 'Roman Candle',
    bodyR: 0.017, bodyLen: 0.48,
    size: 0.45, fuseTime: 2.0, shots: 8, shotInterval: 0.85,
    weight: 2,
  },
  cake: {
    kind: 'cake', label: 'Finale Cake',
    boxW: 0.2, boxH: 0.15,
    size: 1.0, fuseTime: 3.0, shots: 16, shotInterval: 0.55,
    weight: 1,
  },
  belt: {
    kind: 'belt', label: 'Firecracker Belt',
    // a three-foot double-braided belt: ships as a flat roll, dangles from
    // whatever point you grab, and rips end-to-end once the fuse catches
    length: 0.95, crackers: 96, ropePoints: 14,
    size: 0.4, fuseTime: 1.8, duration: 12, rampTime: 1.2,
    weight: 2,
  },
};

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _c1 = new THREE.Color();
const _c2 = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);
const X_AXIS = new THREE.Vector3(1, 0, 0);
// belt-strand scratch (kept separate from _v1.._v4, which the same call
// frames also use)
const _bm = new THREE.Matrix4();
const _bq = new THREE.Quaternion();
const _bs = new THREE.Vector3();
const _bp = new THREE.Vector3();
const _bt = new THREE.Vector3();
const _bn = new THREE.Vector3();
const _bd = new THREE.Vector3();

// Where a drag-integrated particle will be after t seconds (matches shader).
function ballistic(p0, v0, t, gravity, drag, out) {
  const d = Math.max(drag, 0.0001);
  const k = (1 - Math.exp(-d * t)) / d;
  return out.set(
    p0.x + v0.x * k,
    p0.y + v0.y * k - 9.81 * gravity * (t - k) / d,
    p0.z + v0.z * k,
  );
}

// Velocity along that same arc (d/dt of ballistic).
function ballisticVel(v0, t, gravity, drag, out) {
  const d = Math.max(drag, 0.0001);
  const e = Math.exp(-d * t);
  return out.set(
    v0.x * e,
    v0.y * e - 9.81 * gravity * (1 - e) / d,
    v0.z * e,
  );
}

// How much of the impact speed survives a bounce off the sand — soft, so
// things skip a little instead of ping-ponging around the desert.
const BOUNCE_RESTITUTION = 0.42;
const BOUNCE_DAMPING = 0.72;

// ---------------------------------------------------------------------------
// Pooled burst flash lights — these are what paint the dunes with color.
// Real bursts light the ground in two phases: a hard white-hot pop at the
// break, then a softer colored glow that lingers as long as the stars burn.
const FLASH_WHITE = new THREE.Color(1, 1, 1);
class FlashPool {
  constructor(scene, count = 4) {
    this.lights = [];
    for (let i = 0; i < count; i++) {
      // lights stay visible with intensity 0 when idle: toggling visibility
      // changes the scene's light count, which forces shader rebuilds on
      // every lit material mid-show — a guaranteed hitch on Quest
      const l = new THREE.PointLight(0xffffff, 0, 0, 1.6);
      scene.add(l);
      this.lights.push({
        light: l, t: 1e9, peak: 0, dur: 0.4, sink: 0,
        hot: new THREE.Color(), tail: new THREE.Color(),
      });
    }
    this.cursor = 0;
  }

  /**
   * sink: how fast the light drifts downward (m/s) — burning stars fall,
   * and the pool of light on the sand should follow them.
   */
  flash(pos, color, intensity, dur = 0.45, sink = 0) {
    const slot = this.lights[this.cursor];
    this.cursor = (this.cursor + 1) % this.lights.length;
    slot.light.position.copy(pos);
    slot.tail.set(color);
    // the break itself is nearly white; it cools into the star color
    slot.hot.copy(slot.tail).lerp(FLASH_WHITE, 0.72);
    slot.light.color.copy(slot.hot);
    slot.peak = intensity;
    slot.dur = dur;
    slot.sink = sink;
    slot.t = 0;
  }

  update(dt) {
    for (const s of this.lights) {
      if (s.peak === 0) continue;
      s.t += dt;
      const n = s.t / s.dur;
      if (n >= 1) { s.peak = 0; s.light.intensity = 0; continue; }
      // phase 1: white-hot pop (~80ms half-life); phase 2: colored afterglow
      // that flickers like burning stars and fades out over the full dur
      const pop = Math.exp(-s.t * 9.0);
      const glow = Math.exp(-n * 2.4) * (1 - n * n);
      const flicker = 0.88 + Math.random() * 0.24;
      s.light.intensity = s.peak * (pop + 0.24 * glow * flicker);
      s.light.color.copy(s.tail).lerp(s.hot, pop);
      s.light.position.y -= s.sink * dt;
    }
  }
}

// The burst-point flash: an expanding radial glow plus an anamorphic lens
// flare (a real streak-flare texture) — together they read like the blown-out
// frame a camera catches at the instant of the break.
class FlashSprites {
  constructor(scene, count = 4) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.35, 'rgba(255,255,255,0.45)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    const tex = new THREE.CanvasTexture(c);
    const flareTex = new THREE.TextureLoader().load('assets/textures/particles/flare_01.png');
    this.sprites = [];
    for (let i = 0; i < count; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: tex, transparent: true, opacity: 0, depthWrite: false,
        blending: THREE.AdditiveBlending, fog: false,
      }));
      s.visible = false;
      scene.add(s);
      const f = new THREE.Sprite(new THREE.SpriteMaterial({
        map: flareTex, transparent: true, opacity: 0, depthWrite: false,
        blending: THREE.AdditiveBlending, fog: false,
      }));
      f.visible = false;
      scene.add(f);
      this.sprites.push({ sprite: s, flare: f, t: 1e9, dur: 0.35, from: 2, to: 20, fw: 10 });
    }
    this.cursor = 0;
  }

  burst(pos, color, size) {
    const s = this.sprites[this.cursor];
    this.cursor = (this.cursor + 1) % this.sprites.length;
    s.sprite.position.copy(pos);
    s.sprite.material.color.set(color);
    s.sprite.visible = true;
    s.flare.position.copy(pos);
    // the flare burns nearly white with just a kiss of the shell's color
    s.flare.material.color.set(color).lerp(FLASH_WHITE, 0.55);
    s.flare.material.rotation = randRange(-0.22, 0.22);
    s.flare.visible = true;
    s.t = 0;
    s.dur = 0.45;
    s.from = 2.5 * size;
    s.to = 20 * size;
    s.fw = 26 * size;
  }

  update(dt) {
    for (const s of this.sprites) {
      if (!s.sprite.visible) continue;
      s.t += dt;
      const n = s.t / s.dur;
      if (n >= 1) {
        s.sprite.visible = false; s.sprite.material.opacity = 0;
        s.flare.visible = false; s.flare.material.opacity = 0;
        continue;
      }
      const k = 1 - Math.pow(1 - n, 3);
      s.sprite.scale.setScalar(s.from + (s.to - s.from) * k);
      s.sprite.material.opacity = 0.9 * (1 - n);
      // the anamorphic streak pops hard and dies faster than the glow ball
      const fn = Math.min(1, n * 1.8);
      s.flare.scale.set(s.fw * (0.5 + k * 0.9), s.fw * 0.26 * (0.5 + k * 0.5), 1);
      s.flare.material.opacity = 0.95 * (1 - fn) * (1 - fn);
      if (fn >= 1) s.flare.visible = false;
    }
  }
}

// ---------------------------------------------------------------------------
// Item visuals

// Printed wrapper art: colored bands with gold pinstripes, a starburst
// emblem, and fake fine print — reads "fireworks stand" at arm's length
// instead of "colored cylinder". One texture per palette (cached above).
function labelTexture(palette) {
  const W = 128, H = 256;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  const colA = new THREE.Color(palette.a);
  const colB = new THREE.Color(palette.b);
  const css = (col, k = 1) => `rgb(${(col.r * 255 * k) | 0},${(col.g * 255 * k) | 0},${(col.b * 255 * k) | 0})`;

  // aged paper
  g.fillStyle = '#ded2b8';
  g.fillRect(0, 0, W, H);

  // main bands, dark-edged like cheap offset print
  g.fillStyle = css(colA);
  g.fillRect(0, 12, W, 52);
  g.fillRect(0, H - 64, W, 52);
  g.fillStyle = css(colA, 0.55);
  for (const y of [12, 62, H - 64, H - 14]) g.fillRect(0, y, W, 3);
  // gold pinstripes framing the middle
  g.fillStyle = '#c9a544';
  g.fillRect(0, 74, W, 3);
  g.fillRect(0, H - 78, W, 3);

  // starburst emblem in the middle panel
  const cx = W / 2, cy = H / 2;
  g.strokeStyle = css(colB, 0.85);
  g.lineWidth = 3;
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const r0 = i % 2 ? 12 : 7, r1 = i % 2 ? 34 : 22;
    g.beginPath();
    g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
    g.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
    g.stroke();
  }
  g.fillStyle = css(colA);
  g.beginPath(); g.arc(cx, cy, 8, 0, Math.PI * 2); g.fill();

  // fake fine print above/below the emblem
  g.fillStyle = 'rgba(60,45,25,0.55)';
  for (const y of [86, 94, H - 96, H - 88]) {
    for (let x = 14; x < W - 14; x += 10) g.fillRect(x, y, 6 + (x * 7) % 4, 2);
  }

  // wear: scuffs and a couple of scratches
  g.fillStyle = 'rgba(30,20,10,0.30)';
  for (let i = 0; i < 6; i++) g.fillRect(0, (i * 47 + 23) % H, W, 1);
  g.fillStyle = 'rgba(255,250,235,0.20)';
  for (let i = 0; i < 4; i++) g.fillRect((i * 37 + 11) % W, 0, 1, H);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const GEO_CACHE = {};
function cachedGeo(key, make) {
  if (!GEO_CACHE[key]) GEO_CACHE[key] = make();
  return GEO_CACHE[key];
}

// The restocker spawns items forever; per-item textures/materials would be an
// unbounded GPU leak, so everything visual is cached per palette (8 entries).
const MAT_CACHE = {};
function paletteMats(palette) {
  let m = MAT_CACHE[palette.name];
  if (!m) {
    m = {
      // glossy printed wrapper — the sheen is what reads "store-bought
      // firework" instead of "painted cylinder"
      label: new THREE.MeshStandardMaterial({
        map: labelTexture(palette),
        roughness: 0.38, metalness: 0, envMapIntensity: 0.7,
        emissive: new THREE.Color(palette.a).multiplyScalar(0.14),
      }),
      // metallic-paint nose cone: catches the moon and every burst
      nose: new THREE.MeshStandardMaterial({
        color: palette.b, roughness: 0.28, metalness: 0.6, envMapIntensity: 0.9,
      }),
    };
    MAT_CACHE[palette.name] = m;
  }
  return m;
}
const WOOD_ITEM_MAT = new THREE.MeshStandardMaterial({ color: 0x9c8a6a, roughness: 0.8 });
const TUBE_MAT = new THREE.MeshStandardMaterial({ color: 0x443830, roughness: 0.85 });
const CHAR_MAT = new THREE.MeshStandardMaterial({ color: 0x2c241c, roughness: 0.98 });
const FUSE_MAT = new THREE.LineBasicMaterial({ color: 0x304028 });
// glossy red cracker paper (per-instance color carries the shade variation);
// the emissive floor keeps the roll readable scarlet in moonlight instead of
// collapsing to black-on-black like pure diffuse red would
const BELT_MAT = new THREE.MeshStandardMaterial({
  color: 0xffffff, roughness: 0.38, metalness: 0, envMapIntensity: 0.9,
  emissive: 0x4a080c,
});
const BELT_CORD_MAT = new THREE.LineBasicMaterial({ color: 0x77181a });
const BELT_CORD_CHAR_MAT = new THREE.LineBasicMaterial({ color: 0x1e1713 });

let itemIdCounter = 0;

export class FireworkItem {
  /**
   * Root origin sits at the plant point (bottom of stick / base), +Y runs
   * up through the body toward the nose, so planting = position + orient root.
   */
  constructor(typeName, system) {
    this.id = itemIdCounter++;
    this.typeName = typeName;
    this.type = ITEM_TYPES[typeName];
    this.system = system;
    this.state = 'idle'; // idle | held | planted | lying | active | spent
    this.fuseRemaining = -1;
    this.palette = randPick(PALETTES);
    this.shell = this.type.shells ? randPick(this.type.shells) : null;
    this.holder = null;
    this.fallVel = 0;
    this.sounds = {};
    this.root = new THREE.Group();
    this.root.userData.item = this;
    this._buildMesh();
  }

  _buildMesh() {
    const t = this.type;
    const root = this.root;
    const woodMat = WOOD_ITEM_MAT;
    const labelMat = paletteMats(this.palette).label;

    if (t.kind === 'rocket') {
      const stick = new THREE.Mesh(
        cachedGeo(`stick`, () => new THREE.CylinderGeometry(0.004, 0.004, 1, 5)),
        woodMat,
      );
      stick.scale.y = t.stickLen;
      stick.position.y = t.stickLen / 2;
      root.add(stick);

      const body = new THREE.Mesh(
        cachedGeo('body', () => new THREE.CylinderGeometry(1, 1, 1, 10)),
        labelMat,
      );
      body.scale.set(t.bodyR, t.bodyLen, t.bodyR);
      body.position.y = t.stickLen - t.bodyLen / 2;
      root.add(body);

      const nose = new THREE.Mesh(
        cachedGeo('nose', () => new THREE.ConeGeometry(1, 1, 10)),
        paletteMats(this.palette).nose,
      );
      nose.scale.set(t.bodyR, t.bodyR * 2.4, t.bodyR);
      nose.position.y = t.stickLen + t.bodyR * 1.2;
      root.add(nose);

      this.grabY = t.stickLen - t.bodyLen / 2; // hold at the body
      this.grabTop = t.stickLen + t.bodyR * 2.4; // grabbable anywhere on the stick
      this.fuseBase = new THREE.Vector3(t.bodyR + 0.006, t.stickLen - t.bodyLen, 0);
      this.fuseTip = new THREE.Vector3(t.bodyR + 0.012, t.stickLen - t.bodyLen - 0.035, 0);
    } else if (t.kind === 'fountain') {
      const cone = new THREE.Mesh(
        cachedGeo('fcone', () => new THREE.CylinderGeometry(0.35, 1, 1, 12)),
        labelMat,
      );
      cone.scale.set(t.baseR, t.height, t.baseR);
      cone.position.y = t.height / 2;
      root.add(cone);
      this.grabY = t.height / 2;
      this.grabTop = t.height;
      this.fuseBase = new THREE.Vector3(0, t.height, 0);
      this.fuseTip = new THREE.Vector3(0.012, t.height + 0.045, 0);
      this.nozzleY = t.height;
    } else if (t.kind === 'pinwheel') {
      // a wheel of rocket drivers nailed to a stake: the stake runs up local
      // +Y, the wheel hangs just in front of it and spins around local Z
      const stake = new THREE.Mesh(
        cachedGeo('pwstake', () => new THREE.CylinderGeometry(0.008, 0.011, 1, 6)),
        woodMat,
      );
      stake.scale.y = t.stickLen;
      stake.position.y = t.stickLen / 2;
      root.add(stake);

      // pivot: rotates the wheel assembly so its spin axis (local Y inside)
      // points along the root's +Z — the "nail" through the stake
      const pivot = new THREE.Group();
      pivot.position.y = t.stickLen;
      pivot.rotation.x = Math.PI / 2;
      root.add(pivot);

      const nail = new THREE.Mesh(
        cachedGeo('pwnail', () => new THREE.CylinderGeometry(0.007, 0.007, 0.06, 6)),
        paletteMats(this.palette).nose,
      );
      pivot.add(nail);

      // the spinning part: FireworksSystem animates wheel.rotation.y
      const wheel = new THREE.Group();
      wheel.position.y = 0.035; // sit in front of the stake, off the nail
      pivot.add(wheel);
      this.wheel = wheel;

      const rim = new THREE.Mesh(
        cachedGeo('pwrim', () => {
          const g = new THREE.TorusGeometry(1, 0.055, 6, 22);
          g.rotateX(Math.PI / 2); // torus lies in X-Z so it spins around Y
          return g;
        }),
        TUBE_MAT,
      );
      rim.scale.setScalar(t.wheelR);
      wheel.add(rim);

      // driver motors mounted tangentially around the rim, plus an exhaust
      // anchor at each one's tail for flames and spark spray at runtime
      this.driverAnchors = [];
      const driverGeo = cachedGeo('pwdriver', () => new THREE.CylinderGeometry(0.014, 0.014, 0.09, 8));
      for (let i = 0; i < t.drivers; i++) {
        const a = (i / t.drivers) * Math.PI * 2;
        const driver = new THREE.Mesh(driverGeo, labelMat);
        driver.position.set(Math.cos(a) * t.wheelR, 0, Math.sin(a) * t.wheelR);
        driver.rotation.order = 'YXZ';
        driver.rotation.y = -a;      // face the tube along the tangent
        driver.rotation.x = Math.PI / 2;
        wheel.add(driver);
        const exhaust = new THREE.Object3D();
        exhaust.position.y = -0.05;  // tail of the tube (local -Y = backward)
        driver.add(exhaust);
        this.driverAnchors.push(exhaust);
      }

      this.grabY = t.stickLen * 0.5;
      this.grabTop = t.stickLen;
      // fuse dangles off the bottom driver's tail, in front of the wheel
      this.fuseBase = new THREE.Vector3(t.wheelR * 0.7, t.stickLen - t.wheelR * 0.7, 0.05);
      this.fuseTip = new THREE.Vector3(t.wheelR * 0.7 + 0.012, t.stickLen - t.wheelR * 0.7 - 0.045, 0.055);
    } else if (t.kind === 'candle') {
      const tube = new THREE.Mesh(
        cachedGeo('ctube', () => new THREE.CylinderGeometry(1, 1, 1, 10)),
        labelMat,
      );
      tube.scale.set(t.bodyR, t.bodyLen, t.bodyR);
      tube.position.y = t.bodyLen / 2;
      root.add(tube);
      this.grabY = t.bodyLen * 0.4;
      this.grabTop = t.bodyLen;
      this.fuseBase = new THREE.Vector3(0, t.bodyLen, 0);
      this.fuseTip = new THREE.Vector3(0.01, t.bodyLen + 0.04, 0);
      this.nozzleY = t.bodyLen;
    } else if (t.kind === 'belt') {
      // The strand is a verlet rope simulated in WORLD space; the instanced
      // crackers live in a group whose world matrix is pinned to identity,
      // so the belt hangs, drapes and dances no matter where the root (the
      // grab handle) goes. Idle in the crate it holds a flat-roll coil.
      const NP = t.ropePoints;
      this.beltPts = [];
      for (let i = 0; i < NP; i++) {
        this.beltPts.push({ p: new THREE.Vector3(), pp: new THREE.Vector3() });
      }
      this.beltSeg = t.length / (NP - 1);
      this.beltPinned = 0;     // rope point pinned to the hand while held
      this.beltFrozen = true;  // crate state: hold the rolled-up coil shape
      this.beltConsumed = 0;   // crackers eaten by the burn front (far end first)

      this.strand = new THREE.Group();
      this.strand.matrixAutoUpdate = false;
      this.strand.matrixWorldAutoUpdate = false;
      root.add(this.strand);

      const mesh = new THREE.InstancedMesh(
        cachedGeo('beltcracker', () => new THREE.CylinderGeometry(0.0085, 0.0085, 0.042, 6)),
        BELT_MAT, t.crackers,
      );
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      // hide everything until the first strand update stamps real matrices
      _bm.makeScale(0, 0, 0);
      for (let i = 0; i < t.crackers; i++) {
        mesh.setMatrixAt(i, _bm);
        // paper shades: bright scarlet through crimson, like a real roll
        _c1.setHSL(0.993 + Math.random() * 0.017, 0.9, 0.42 + Math.random() * 0.16);
        mesh.setColorAt(i, _c1);
      }
      this.crackerMesh = mesh;
      this.strand.add(mesh);

      // the braid cord running through the whole belt
      const cordGeo = new THREE.BufferGeometry();
      cordGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(NP * 3), 3));
      this.cordLine = new THREE.Line(cordGeo, BELT_CORD_MAT);
      this.cordLine.frustumCulled = false;
      this.strand.add(this.cordLine);

      // per-item GPU buffers (instance attributes, cord) — the restocker
      // spawns belts forever, so they must go when the item goes
      this.dispose = () => {
        mesh.dispose();
        cordGeo.dispose();
      };

      this.grabY = 0.02; // reach is per-rope-point — see grabDistance in input.js
      this.fuseBase = new THREE.Vector3();       // both repositioned every
      this.fuseTip = new THREE.Vector3(0, -0.045, 0); // frame to the strand's far end
      this._initCoil();
    } else if (t.kind === 'cake') {
      const box = new THREE.Mesh(
        cachedGeo('cakebox', () => new THREE.BoxGeometry(1, 1, 1)),
        labelMat,
      );
      box.scale.set(t.boxW, t.boxH, t.boxW);
      box.position.y = t.boxH / 2;
      root.add(box);
      const tubeGeo = cachedGeo('caketube', () => new THREE.CylinderGeometry(0.016, 0.016, 0.05, 8));
      const tubeMat = TUBE_MAT;
      for (let ix = -1; ix <= 1; ix++) {
        for (let iz = -1; iz <= 1; iz++) {
          const tube = new THREE.Mesh(tubeGeo, tubeMat);
          tube.position.set(ix * 0.055, t.boxH + 0.02, iz * 0.055);
          root.add(tube);
        }
      }
      this.grabY = t.boxH / 2;
      this.grabTop = t.boxH;
      this.fuseBase = new THREE.Vector3(t.boxW / 2, t.boxH * 0.6, 0);
      this.fuseTip = new THREE.Vector3(t.boxW / 2 + 0.04, t.boxH * 0.35, 0);
      this.nozzleY = t.boxH + 0.045;
    }

    // items throw moon shadows like everything else on the sand
    root.traverse((o) => { if (o.isMesh) o.castShadow = true; });

    // the fuse cord
    const fuseGeo = new THREE.BufferGeometry().setFromPoints([this.fuseBase, this.fuseTip]);
    this.fuseLine = new THREE.Line(fuseGeo, FUSE_MAT);
    root.add(this.fuseLine);

    // where fuse sparks live (moves toward fuseBase as it burns)
    this.fuseAnchor = new THREE.Object3D();
    this.fuseAnchor.position.copy(this.fuseTip);
    root.add(this.fuseAnchor);
  }

  fuseWorldPos(out = new THREE.Vector3()) {
    return this.fuseAnchor.getWorldPosition(out);
  }

  // Rolled-up belt: a flat spiral (how the real things ship), in root-local
  // coords, stamped to world every frame while the item idles in the crate.
  _initCoil() {
    this.beltCoil = [];
    const NP = this.beltPts.length;
    let theta = 0;
    for (let i = 0; i < NP; i++) {
      const k = i / (NP - 1);
      const r = 0.022 + 0.052 * k;
      this.beltCoil.push(new THREE.Vector3(
        Math.cos(theta) * r, 0.016 + k * 0.012, Math.sin(theta) * r,
      ));
      theta += this.beltSeg / r;
    }
  }

  // Called by Interactions.grab: a belt is grabbed wherever the hand (or
  // the desktop aim ray) actually touched it — pin the nearest rope point
  // there, and bring the root (now a child of the hand) to the grip origin
  // so the pin follows it.
  onGrabbed(holderObject, grabPoint) {
    if (!this.beltPts) return;
    if (grabPoint) _bp.copy(grabPoint);
    else holderObject.getWorldPosition(_bp);
    let best = 0, bestD = Infinity;
    for (let i = 0; i < this.beltPts.length; i++) {
      const d = this.beltPts[i].p.distanceToSquared(_bp);
      if (d < bestD) { bestD = d; best = i; }
    }
    this.beltPinned = best;
    this.root.position.set(0, 0, 0);
    this.root.quaternion.identity();
  }

  // World position along the strand at parameter u (0 = head, 1 = the far
  // end you light). All pop/light/sound/stamping sites share this so they
  // can never drift apart on the rope.
  beltPointAt(u, out) {
    const pts = this.beltPts;
    const NP = pts.length;
    const f = clamp(u, 0, 1) * (NP - 1);
    const i0 = Math.min(NP - 2, Math.floor(f));
    return out.lerpVectors(pts[i0].p, pts[i0 + 1].p, f - i0);
  }

  // Per-frame strand work: verlet rope (or frozen coil), cracker instance
  // stamping, cord + fuse bookkeeping. Runs for every belt in any state.
  _updateBelt(dt) {
    const sys = this.system;
    const pts = this.beltPts;
    const NP = pts.length;
    // a spent belt that has settled is just a charred cord on the sand —
    // no sim, no restamp, no buffer uploads until removal
    if (this.beltStatic) return;
    this.root.updateWorldMatrix(true, false);

    if (this.beltFrozen) {
      // stamp the coil from the root BEFORE any unfreeze can happen, so a
      // belt planted-and-lit in its creation frame (demo mode) starts its
      // sim from the coil at the spawn point, not from zeroed points
      const m = this.root.matrixWorld;
      const moved = !this._coilStamped || !this._coilMatrix.equals(m);
      if (moved) {
        for (let i = 0; i < NP; i++) {
          pts[i].p.copy(this.beltCoil[i]).applyMatrix4(m);
          pts[i].pp.copy(pts[i].p);
        }
        this._coilMatrix = (this._coilMatrix ?? new THREE.Matrix4()).copy(m);
        this._coilStamped = true;
      }
      if (this.state !== 'idle' || this.holder) this.beltFrozen = false;
      else if (!moved) return; // static coil in the crate: nothing to update
    } else {
      const h = Math.min(dt, 0.033);
      const g = 9.81 * h * h;
      for (let i = 0; i < NP; i++) {
        const pt = pts[i];
        const vx = (pt.p.x - pt.pp.x) * 0.985;
        const vy = (pt.p.y - pt.pp.y) * 0.985;
        const vz = (pt.p.z - pt.pp.z) * 0.985;
        pt.pp.copy(pt.p);
        pt.p.x += vx; pt.p.y += vy - g; pt.p.z += vz;
      }
      const held = !!this.holder;
      const pin = this.beltPinned;
      if (held) pts[pin].p.copy(this.root.getWorldPosition(_bp));
      // terrain is an analytic noise field — sample it once per point per
      // frame (points move sub-millimeter between constraint iterations)
      const ground = this._beltGround ?? (this._beltGround = new Float32Array(NP));
      for (let i = 0; i < NP; i++) {
        ground[i] = sys.groundHeight(pts[i].p.x, pts[i].p.z) + 0.012;
      }
      for (let iter = 0; iter < 7; iter++) {
        for (let i = 0; i < NP - 1; i++) {
          const a = pts[i], b = pts[i + 1];
          _bd.subVectors(b.p, a.p);
          const d = _bd.length() || 1e-6;
          const corr = (d - this.beltSeg) / d * 0.5;
          if (held && i === pin) b.p.addScaledVector(_bd, -corr * 2);
          else if (held && i + 1 === pin) a.p.addScaledVector(_bd, corr * 2);
          else {
            a.p.addScaledVector(_bd, corr);
            b.p.addScaledVector(_bd, -corr);
          }
        }
        for (let i = 0; i < NP; i++) {
          if (held && i === pin) continue;
          const pt = pts[i];
          if (pt.p.y < ground[i]) {
            pt.p.y = ground[i];
            // sand friction: kill most of the slide where it touches
            pt.pp.x += (pt.p.x - pt.pp.x) * 0.5;
            pt.pp.z += (pt.p.z - pt.pp.z) * 0.5;
          }
        }
      }
      // nobody holding it: the grab handle rides the rope
      if (!held) {
        this.root.position.copy(pts[pin].p);
        this.root.quaternion.identity();
        this.root.updateWorldMatrix(true, false);
      }
    }

    // fuse tracks the strand's far end (that's the end you light)
    const endW = pts[NP - 1].p;
    _bp.copy(endW);
    this.root.worldToLocal(_bp);
    this.fuseBase.copy(_bp);
    _bp.copy(endW); _bp.y -= 0.045;
    this.root.worldToLocal(_bp);
    this.fuseTip.copy(_bp);
    if (!this.isLit) this.fuseAnchor.position.copy(this.fuseTip);
    const fp = this.fuseLine.geometry.attributes.position;
    fp.setXYZ(0, this.fuseBase.x, this.fuseBase.y, this.fuseBase.z);
    fp.setXYZ(1, this.fuseAnchor.position.x, this.fuseAnchor.position.y, this.fuseAnchor.position.z);
    fp.needsUpdate = true;
    this.fuseLine.visible = this.state !== 'active' && this.state !== 'spent';

    // stamp the crackers along the strand, herringbone-braided in pairs
    const mesh = this.crackerMesh;
    const count = this.type.crackers;
    const aliveBelow = 1 - this.beltConsumed / count; // u past this is ash
    const scale = this.root.getWorldScale(_bs).y || 1;
    for (let k = 0; k < count; k++) {
      const u = (k + 0.5) / count;
      if (u > aliveBelow) {
        _bm.makeScale(0, 0, 0);
        mesh.setMatrixAt(k, _bm);
        continue;
      }
      const f = u * (NP - 1);
      const i0 = Math.min(NP - 2, Math.floor(f));
      const fr = f - i0;
      _bp.lerpVectors(pts[i0].p, pts[i0 + 1].p, fr);
      _bt.subVectors(pts[i0 + 1].p, pts[i0].p).normalize();
      _bn.crossVectors(_bt, UP);
      if (_bn.lengthSq() < 0.01) _bn.crossVectors(_bt, X_AXIS);
      _bn.normalize();
      const side = k % 2 ? 1 : -1;
      // lean ~50° off the cord, alternating sides — the braided look
      _bd.copy(_bt).multiplyScalar(0.62).addScaledVector(_bn, side * 0.78).normalize();
      _bq.setFromUnitVectors(UP, _bd);
      _bp.addScaledVector(_bn, side * 0.010);
      _bm.compose(_bp, _bq, _bs.setScalar(scale));
      mesh.setMatrixAt(k, _bm);
    }
    mesh.instanceMatrix.needsUpdate = true;
    // the strand moves in world space — stale bounding spheres would make
    // desktop raycasts miss a belt that walked away from its spawn point
    mesh.boundingSphere = null;

    const cp = this.cordLine.geometry.attributes.position;
    for (let i = 0; i < NP; i++) cp.setXYZ(i, pts[i].p.x, pts[i].p.y, pts[i].p.z);
    cp.needsUpdate = true;
    this.cordLine.geometry.boundingSphere = null;
  }

  get isLit() {
    return this.fuseRemaining > 0 || this.state === 'active';
  }

  ignite() {
    if (this.isLit || this.state === 'active' || this.state === 'spent') return false;
    this.fuseRemaining = this.type.fuseTime;
    const sys = this.system;
    this.sounds.fuse = sys.audio.play('fuse', this.fuseWorldPos(_v1), {
      gain: 0.8, loop: true, refDistance: 0.6, send: 0.1, hrtf: true,
    });
    return true;
  }

  extinguishSounds() {
    for (const k of Object.keys(this.sounds)) {
      this.sounds[k]?.stop();
      delete this.sounds[k];
    }
  }

  // Axis the item fires along (world space)
  axis(out = _v1) {
    return out.set(0, 1, 0).applyQuaternion(this.root.getWorldQuaternion(_q1)).normalize();
  }

  update(dt, time) {
    const sys = this.system;

    // belt strand: rope sim + instance stamping, before the fuse logic so
    // the fuse anchors chase the strand's current end
    if (this.beltPts) this._updateBelt(dt);

    // fuse burn
    if (this.fuseRemaining > 0) {
      this.fuseRemaining -= dt;
      const n = clamp(this.fuseRemaining / this.type.fuseTime, 0, 1);
      this.fuseAnchor.position.lerpVectors(this.fuseBase, this.fuseTip, n);
      // shorten the fuse cord as it burns toward the body
      const fp = this.fuseLine.geometry.attributes.position;
      fp.setXYZ(1, this.fuseAnchor.position.x, this.fuseAnchor.position.y, this.fuseAnchor.position.z);
      fp.needsUpdate = true;
      // sputtering sparks
      const p = this.fuseWorldPos(_v1);
      sys.spawnFuseSparks(p, time, dt);
      this.sounds.fuse?.setPosition(p);
      if (this.fuseRemaining <= 0) {
        this.sounds.fuse?.stop();
        delete this.sounds.fuse;
        sys.activate(this);
      }
    }

    // free fall when dropped (belts drape themselves — the rope owns motion)
    if (!this.beltPts
      && (this.state === 'lying' || this.state === 'active' || this.state === 'spent') && this.fallVel !== 0) {
      this.fallVel = Math.max(this.fallVel - 9.81 * dt, -12);
      this.root.position.y += this.fallVel * dt;
      const ground = sys.groundHeight(this.root.position.x, this.root.position.z);
      if (this.root.position.y <= ground + 0.02) {
        this.root.position.y = ground + 0.02;
        this.fallVel = 0;
        if (this.state === 'lying') {
          // unlit items topple flat; active ones stay as they landed
          this.root.quaternion.setFromAxisAngle(
            _v2.set(Math.random() - 0.5, 0, Math.random() - 0.5).normalize(),
            Math.PI / 2 * 0.96,
          );
        }
        sys.audio.play('thud', this.root.position, { gain: 0.7, refDistance: 1.5 });
      }
    }
  }
}

// ---------------------------------------------------------------------------

export class FireworksSystem {
  constructor(scene, pool, audio, groundHeight) {
    this.scene = scene;
    this.pool = pool;
    this.audio = audio;
    this.groundHeight = groundHeight;
    this.items = new Set();
    this.rockets = [];   // in-flight
    this.emitters = [];  // fountains / candles / cakes running
    this.events = [];    // {time, fn}
    this.time = 0;
    this.flashes = new FlashPool(scene, 4);
    this.flashSprites = new FlashSprites(scene, 4);
    this.onBoom = null; // hook for haptics: (pos, size) => {}
    this._fuseSparkAcc = 0;

    // aggregate "the sky just lit up" signal — world.js feeds this into the
    // hemisphere light so a burst overhead washes the whole basin, not just
    // the point-light radius. energy spikes on each burst and decays fast.
    this.ambientPulse = { color: new THREE.Color(1, 1, 1), energy: 0 };

    // small shared light that rides the most recent rocket — like the flash
    // pool it stays visible at intensity 0 so the light count (and thus the
    // compiled shaders) never changes mid-flight
    this.rocketLight = new THREE.PointLight(0xffa040, 0, 0, 1.8);
    scene.add(this.rocketLight);

    // shared glow texture for motor flares (one sprite per burning rocket)
    {
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const g = c.getContext('2d');
      const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      grad.addColorStop(0, 'rgba(255,255,235,1)');
      grad.addColorStop(0.28, 'rgba(255,200,120,0.75)');
      grad.addColorStop(0.6, 'rgba(255,140,50,0.25)');
      grad.addColorStop(1, 'rgba(255,90,20,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, 64, 64);
      this._flareTex = new THREE.CanvasTexture(c);
    }

    // pooled fountain lights, same reasoning: fountains used to add/remove
    // their PointLight per run, and every change of scene light count forces
    // a full shader recompile — a guaranteed hitch mid-show on Quest
    this.emitterLights = [];
    for (let i = 0; i < 2; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 0, 1.9);
      scene.add(l);
      this.emitterLights.push({ light: l, owner: null });
    }
  }

  _acquireEmitterLight(owner) {
    for (const s of this.emitterLights) {
      if (!s.owner) { s.owner = owner; return s; }
    }
    return null; // a third simultaneous fountain just goes unlit
  }

  _releaseEmitterLight(slot) {
    if (!slot) return;
    slot.owner = null;
    slot.light.intensity = 0;
  }

  createItem(typeName) {
    const item = new FireworkItem(typeName, this);
    this.items.add(item);
    this.scene.add(item.root);
    return item;
  }

  removeItem(item) {
    item.extinguishSounds();
    item.fuseLine?.geometry.dispose(); // per-item buffer, unlike the cached meshes
    item.dispose?.();
    // never leave a hand pointing at a despawned item — that hand could
    // otherwise never grab again
    if (item.holder) {
      if (item.holder.held === item) item.holder.held = null;
      item.holder = null;
    }
    this.items.delete(item);
    item.root.removeFromParent();
  }

  randomTypeName() {
    const entries = Object.entries(ITEM_TYPES);
    const total = entries.reduce((s, [, t]) => s + t.weight, 0);
    let r = Math.random() * total;
    for (const [name, t] of entries) {
      r -= t.weight;
      if (r <= 0) return name;
    }
    return 'rocketMed';
  }

  schedule(delay, fn) {
    this.events.push({ time: this.time + delay, fn });
  }

  // ---- ignition outcomes ----

  activate(item) {
    const kind = item.type.kind;
    if (kind === 'rocket') this._launchRocket(item);
    else if (kind === 'fountain') this._startFountain(item);
    else if (kind === 'pinwheel') this._startPinwheel(item);
    else if (kind === 'candle') this._startCandle(item);
    else if (kind === 'cake') this._startCake(item);
    else if (kind === 'belt') this._startBelt(item);
  }

  _startBelt(item) {
    item.state = 'active';
    const t = item.type;
    this.emitters.push({
      kind: 'belt', item, age: 0, duration: t.duration, ramp: t.rampTime,
      loop: null, accents: 0.3, lightSlot: null, done: false,
    });
  }

  /**
   * One cracker going off at belt parameter u (1 = the lit far end, 0 = the
   * head of the strand). Muzzle flash, shredded red paper, hot ember or two,
   * a smoke puff every few pops, and a verlet kick so the belt jumps and
   * writhes the way the real thing does. During the catching phase (sparse)
   * every pop is its own audible cracker.
   */
  _beltPop(item, u, sparse) {
    const pts = item.beltPts;
    const NP = pts.length;
    const pos = item.beltPointAt(u, _v1);
    const pool = this.pool;
    const time = this.time;
    const px = pos.x, py = pos.y, pz = pos.z;

    if (sparse) {
      this.audio.play('cracker', pos, {
        gain: randRange(0.55, 0.9), refDistance: 2.2, send: 0.35, rate: randRange(0.9, 1.25),
      });
    }

    // white-hot muzzle flash, gone in a tenth of a second
    pool.spawn(4, (i) => {
      pool.set(i,
        px + randRange(-0.01, 0.01), py + randRange(-0.01, 0.01), pz + randRange(-0.01, 0.01),
        randRange(-2.4, 2.4), randRange(0.4, 2.4), randRange(-2.4, 2.4),
        2.5, 2.2, 1.7,
        time, randRange(0.05, 0.14),
        randRange(0.025, 0.045), 0.5, 2.0, 0);
    });
    // shredded red paper, fluttering out and settling on the sand
    pool.spawn(6, (i) => {
      pool.set(i,
        px, py, pz,
        randRange(-2.4, 2.4), randRange(0.5, 2.8), randRange(-2.4, 2.4),
        0.55, 0.05, 0.045,
        time, randRange(0.6, 1.6),
        randRange(0.012, 0.022), 1.15, 2.4, 0);
    });
    // a couple of hot embers
    pool.spawn(2, (i) => {
      pool.set(i,
        px, py, pz,
        randRange(-1.4, 1.4), randRange(0.3, 1.8), randRange(-1.4, 1.4),
        1.4, 0.9, 0.35,
        time, randRange(0.2, 0.5),
        randRange(0.012, 0.022), 0.8, 2.2, 0);
    });
    // gunpowder smoke builds along the belt as it rips
    if (item.beltConsumed % 3 === 0) {
      pool.spawn(2, (i) => {
        pool.set(i,
          px, py + 0.04, pz,
          randRange(-0.3, 0.3), randRange(0.25, 0.6), randRange(-0.3, 0.3),
          0.42, 0.42, 0.46,
          time, randRange(2.2, 4.4),
          randRange(0.28, 0.5), -0.02, 1.6, -1);
      });
    }
    // the kick: crackers physically jolt the strand
    const kick = pts[Math.round(clamp(u, 0, 1) * (NP - 1))];
    kick.pp.x -= randRange(-1.7, 1.7) * 0.016;
    kick.pp.y -= randRange(0.9, 2.8) * 0.016;
    kick.pp.z -= randRange(-1.7, 1.7) * 0.016;
    // occasional visible flash on the surroundings
    if (Math.random() < 0.12) this.flashes.flash(pos, 0xffd9a8, 5 + Math.random() * 7, 0.05);
  }

  _spendBelt(item) {
    if (!this.items.has(item)) return;
    item.state = 'spent';
    item.extinguishSounds();
    // nothing left but the charred braid cord on the sand
    item.cordLine.material = BELT_CORD_CHAR_MAT;
    // give the rope a moment to settle, then stop simulating it entirely
    this.schedule(3, () => { item.beltStatic = true; });
    this.schedule(18, () => this.removeItem(item));
  }

  _launchRocket(item) {
    item.state = 'active';
    item.fallVel = 0; // flight integrator owns the motion now
    // gripped like a real bottle rocket: your hand pins it down, so the
    // motor burns (and the timer runs) right where you hold it — the update
    // loop hands it over to free flight the moment you let go
    const held = !!item.holder;
    if (!held) this.scene.attach(item.root); // ensure standalone transform
    const t = item.type;
    const dir = item.axis(new THREE.Vector3());
    const base = item.root.getWorldPosition(new THREE.Vector3());
    const pos = base.clone().addScaledVector(dir, t.stickLen);

    // liftoff kicks a blast of sand and a swirl of dust off the pad
    if (!held) this._padDust(base.clone(), t.size);

    // motor flare: an additive glow riding the nozzle while the motor burns
    const flare = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this._flareTex, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, color: 0xffc080, fog: false,
    }));
    flare.scale.setScalar(0.22 + t.size * 0.22);
    this.scene.add(flare);

    this.audio.play('lift', pos, { gain: 1.1, refDistance: 3, send: 0.35 });
    const whoosh = this.audio.play('whoosh', pos, {
      gain: 1.15, refDistance: 3, send: 0.3, rate: randRange(0.94, 1.14),
    });
    // cheap doppler: the roar pitches down as the rocket accelerates away —
    // exponential approach, fastest right off the pad (matches real recedes).
    // A held rocket isn't going anywhere yet: the ramp waits for the release.
    if (whoosh && !held) this._recedeWhoosh(whoosh);

    this.rockets.push({
      item,
      held,
      pos: base,
      vel: dir.clone().multiplyScalar(2.5),
      dir,
      age: 0,
      burnTime: t.burnTime,
      explodeAt: t.burnTime + t.coast * randRange(0.8, 1.2),
      thrust: t.thrust * randRange(0.9, 1.1),
      wobblePhase: Math.random() * 10,
      whoosh,
      flare,
      flareOffset: t.stickLen - t.bodyLen - 0.02,
    });
  }

  _recedeWhoosh(whoosh) {
    const pr = whoosh.source.playbackRate;
    const t0 = this.audio.ctx.currentTime;
    pr.setValueAtTime(pr.value, t0);
    pr.setTargetAtTime(pr.value * 0.76, t0, 0.65);
  }

  _dropFlare(r) {
    if (!r.flare) return;
    r.flare.removeFromParent();
    r.flare.material.dispose(); // texture is shared, material is per-rocket
    r.flare = null;
  }

  // The blast of grit and the rolling dust cloud a motor kicks off the pad.
  _padDust(pos, size) {
    const pool = this.pool;
    const time = this.time;
    pos.y = this.groundHeight(pos.x, pos.z);
    // sharp radial sand kick
    pool.spawn(24 + Math.round(20 * size), (i) => {
      const a = Math.random() * Math.PI * 2;
      const sp = randRange(1.5, 4.2) * (0.6 + size);
      pool.set(i,
        pos.x + Math.cos(a) * 0.05, pos.y + 0.04, pos.z + Math.sin(a) * 0.05,
        Math.cos(a) * sp, randRange(0.4, 1.6), Math.sin(a) * sp,
        0.85, 0.62, 0.34,
        time, randRange(0.4, 0.9),
        randRange(0.02, 0.05), 1.3, 2.6, 0);
    });
    // billowing dust that hangs around the pad after the rocket is gone
    pool.spawn(9 + Math.round(8 * size), (i) => {
      const a = Math.random() * Math.PI * 2;
      const sp = randRange(0.5, 1.5) * (0.6 + size);
      pool.set(i,
        pos.x, pos.y + 0.15, pos.z,
        Math.cos(a) * sp, randRange(0.25, 0.8), Math.sin(a) * sp,
        0.46, 0.36, 0.24,
        time, randRange(1.8, 3.2),
        randRange(0.45, 0.85) * (0.6 + size), -0.02, 1.8, -1);
    });
  }

  _startFountain(item) {
    item.state = 'active';
    const t = item.type;
    const nozzle = new THREE.Vector3(0, item.nozzleY, 0);
    item.root.localToWorld(nozzle);
    const sound = this.audio.play('fountain', nozzle, {
      gain: 1.0, loop: true, refDistance: 2.5, send: 0.3, hrtf: true,
    });
    this.emitters.push({
      kind: 'fountain', item, age: 0, duration: t.duration, sound,
      phase: Math.random() * 7,
    });
  }

  _startPinwheel(item) {
    item.state = 'active';
    const t = item.type;
    const hub = item.wheel.getWorldPosition(new THREE.Vector3());
    const sound = this.audio.play('pinwheel', hub, {
      gain: 0.4, loop: true, refDistance: 2.5, send: 0.3, hrtf: true, rate: 0.3,
    });
    // one motor flare per driver, riding its exhaust anchor — the same
    // additive glow the rockets fly with, whipped around in a circle
    const flares = item.driverAnchors.map(() => {
      const flare = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this._flareTex, transparent: true, depthWrite: false,
        blending: THREE.AdditiveBlending, color: 0xffc080, fog: false,
      }));
      flare.scale.setScalar(0.001); // grows in as the drivers come up to pressure
      return flare;
    });
    flares.forEach((f, i) => item.driverAnchors[i].add(f));
    this.emitters.push({
      kind: 'pinwheel', item, age: 0, duration: t.duration, sound, flares,
      spin: 0, spinVel: 0, phase: Math.random() * 7, acc: 0,
    });
  }

  _endPinwheel(e) {
    e.sound?.stop(0.5);
    this._releaseEmitterLight(e.lightSlot);
    e.lightSlot = null;
    for (const f of e.flares) {
      f.removeFromParent();
      f.material.dispose();
    }
    e.flares.length = 0;
  }

  _startCandle(item) {
    item.state = 'active';
    const t = item.type;
    for (let i = 0; i < t.shots; i++) {
      this.schedule(i * t.shotInterval * randRange(0.92, 1.08), () => this._candleShot(item, i));
    }
    this.schedule(t.shots * t.shotInterval + 1.5, () => this._spend(item));
  }

  _candleShot(item, index) {
    if (!this.items.has(item)) return;
    const muzzle = new THREE.Vector3(0, item.nozzleY, 0);
    item.root.localToWorld(muzzle);
    const dir = item.axis(new THREE.Vector3());
    this.audio.play('shot', muzzle, { gain: 1.0, refDistance: 3, send: 0.3, rate: randRange(0.9, 1.15) });
    this.flashes.flash(muzzle, item.palette.a, 35, 0.14);

    // comet star — bounces off the sand if the candle is aimed at the ground
    const col = new THREE.Color(index % 2 ? item.palette.a : item.palette.b);
    const speed = randRange(26, 31);
    const vel = _v2.copy(dir).multiplyScalar(speed);
    vel.x += randRange(-1, 1); vel.z += randRange(-1, 1);
    this._fireShot(muzzle, vel.clone(), col, 1.05, {
      gravity: 0.75, drag: 0.55, flightT: 1.2,
      onBurst: (p, v) => this.burst(p, {
        pattern: 'peony', size: 0.26, palette: item.palette,
        count: 100, speed: 9, sound: 'small', drift: v?.multiplyScalar(0.4),
      }),
    });
  }

  _startCake(item) {
    item.state = 'active';
    const t = item.type;
    for (let i = 0; i < t.shots; i++) {
      const isFinale = i >= t.shots - 3;
      const delay = isFinale
        ? (t.shots - 3) * t.shotInterval + (i - (t.shots - 3)) * 0.18 + 0.6
        : i * t.shotInterval * randRange(0.9, 1.1);
      this.schedule(delay, () => this._cakeShot(item, i, isFinale));
    }
    this.schedule((t.shots + 2) * t.shotInterval + 2.5, () => this._spend(item));
  }

  _cakeShot(item, index, isFinale) {
    if (!this.items.has(item)) return;
    const muzzle = new THREE.Vector3(randRange(-0.05, 0.05), item.nozzleY, randRange(-0.05, 0.05));
    item.root.localToWorld(muzzle);
    const dir = item.axis(new THREE.Vector3());
    // slight per-shot spread
    dir.x += randRange(-0.09, 0.09);
    dir.z += randRange(-0.09, 0.09);
    dir.normalize();

    this.audio.play('lift', muzzle, { gain: 1.2, refDistance: 4, send: 0.4, rate: randRange(0.9, 1.1) });
    this.flashes.flash(muzzle, 0xffc890, 55, 0.16);

    // real mortar pacing: the star streaks upward for a couple of seconds,
    // goes quiet near apex, THEN breaks — bursts land 50-70 m up
    const speed = isFinale ? randRange(48, 56) : randRange(40, 46);
    const vel = dir.clone().multiplyScalar(speed);
    const col = new THREE.Color(item.palette.a);
    const flightT = isFinale ? 3.0 : randRange(2.3, 2.7);
    const pattern = isFinale
      ? randPick(['multibreak', 'palm', 'dahlia', 'chrys', 'brocade', 'serpents', 'kamuro', 'timerain', 'saturn'])
      : randPick(['peony', 'dahlia', 'ring', 'crackle', 'strobe', 'willow', 'serpents', 'ghost', 'saturn', 'leaves']);
    this._fireShot(muzzle, vel, col, 1.35, {
      gravity: 0.9, drag: 0.35, flightT,
      onBurst: (p, v) => this.burst(p, {
        pattern,
        size: isFinale ? 1.25 : 0.6,
        palette: randPick(PALETTES),
        sound: isFinale ? 'big' : 'med',
        drift: v?.multiplyScalar(0.5),
      }),
    });
  }

  /**
   * A display shell fired from a bare mortar pad (no item — the finale show
   * launches these from out in the dunes). pos is the pad; the star streaks
   * up for flightT seconds and breaks into `pattern` at `size`.
   * opts: {pattern, size, palette, sound, speed, flightT, spread, dir?}
   */
  mortarShot(pos, opts) {
    const dir = opts.dir
      ? _v1.copy(opts.dir).normalize()
      : _v1.set(randRange(-1, 1) * (opts.spread ?? 0.1), 1, randRange(-1, 1) * (opts.spread ?? 0.1)).normalize();
    this.audio.play('lift', pos, {
      gain: 1.25, refDistance: 4, send: 0.45, rate: randRange(0.88, 1.08), delayBySound: true,
    });
    this.flashes.flash(_v2.copy(pos).setY(pos.y + 0.4), 0xffc890, 60, 0.18);
    const palette = opts.palette ?? randPick(PALETTES);
    const size = opts.size ?? 1;
    const vel = dir.clone().multiplyScalar(opts.speed ?? 52);
    this._fireShot(pos.clone(), vel, new THREE.Color(palette.a), 1.5, {
      gravity: 0.9, drag: 0.35, flightT: opts.flightT ?? 2.8,
      onBurst: (p, v) => this.burst(p, {
        pattern: opts.pattern, size, palette,
        // default report class scales with the shell, same mapping the
        // rocket bursts use — callers only override for odd shells
        sound: opts.sound !== undefined ? opts.sound
          : (size > 0.75 ? 'big' : size > 0.45 ? 'med' : 'small'),
        drift: v?.multiplyScalar(0.5),
      }),
    });
  }

  _spend(item) {
    if (!this.items.has(item)) return;
    item.state = 'spent';
    item.extinguishSounds();
    // char the item (shared material — item visuals are palette-cached),
    // fade it away a bit later
    item.root.traverse((o) => {
      if (o.isMesh) o.material = CHAR_MAT;
    });
    this.schedule(25, () => this.removeItem(item));
  }

  // ---- ground contact ----

  _groundNormal(x, z, out) {
    const e = 0.35;
    const h = this.groundHeight;
    return out.set(h(x - e, z) - h(x + e, z), 2 * e, h(x, z - e) - h(x, z + e)).normalize();
  }

  // A kick of sparks and sand where something smacks the ground.
  _groundSplash(pos, color, power = 1) {
    const pool = this.pool;
    const time = this.time;
    const count = 8 + Math.round(14 * power);
    pool.spawn(count, (i) => {
      const a = Math.random() * Math.PI * 2;
      const sp = randRange(0.6, 2.6) * (0.5 + power);
      const sandy = Math.random() < 0.45;
      pool.set(i,
        pos.x + randRange(-0.03, 0.03), pos.y + 0.03, pos.z + randRange(-0.03, 0.03),
        Math.cos(a) * sp, randRange(0.8, 2.6) * (0.5 + power * 0.7), Math.sin(a) * sp,
        sandy ? 0.9 : color.r * 2.0, sandy ? 0.65 : color.g * 2.0, sandy ? 0.35 : color.b * 2.0,
        time, randRange(0.25, 0.6),
        randRange(0.02, 0.05) * (0.7 + power * 0.5), 1.1, 2.4, 0);
    });
  }

  /**
   * A comet star that respects the ground: the analytic arc is marched to
   * find a sand strike before its burst time; on impact it splashes, thuds
   * and continues as a damped bounce (a couple of times max), and the burst
   * fires wherever the ball actually is when its charge goes off.
   */
  _fireShot(pos, vel, color, sizeMul, opts, bounceNum = 0) {
    const { gravity, drag, flightT } = opts;

    // march the arc looking for a ground strike
    let tHit = -1;
    const step = 1 / 40;
    let prevT = 0;
    for (let t = step; prevT < flightT; t += step) {
      const tt = Math.min(t, flightT);
      ballistic(pos, vel, tt, gravity, drag, _v3);
      if (_v3.y <= this.groundHeight(_v3.x, _v3.z)) {
        let lo = prevT, hi = tt;
        for (let k = 0; k < 8; k++) {
          const mid = (lo + hi) / 2;
          ballistic(pos, vel, mid, gravity, drag, _v3);
          if (_v3.y <= this.groundHeight(_v3.x, _v3.z)) hi = mid; else lo = mid;
        }
        tHit = hi;
        break;
      }
      prevT = tt;
    }

    if (tHit <= 0 || bounceNum >= 3) {
      // clear flight (or out of bounces): burst at the end of the arc,
      // handing the residual shell velocity to the burst so it drifts
      this._spawnComet(pos, vel, color, sizeMul, { gravity, drag, life: flightT });
      const burstPos = ballistic(pos, vel, flightT, gravity, drag, new THREE.Vector3());
      const burstVel = ballisticVel(vel, flightT, gravity, drag, new THREE.Vector3());
      this.schedule(flightT, () => opts.onBurst(burstPos, burstVel));
      return;
    }

    // streak until the strike, then bounce off the sand
    this._spawnComet(pos, vel, color, sizeMul, { gravity, drag, life: tHit });
    const hitPos = ballistic(pos, vel, tHit, gravity, drag, new THREE.Vector3());
    const hitVel = ballisticVel(vel, tHit, gravity, drag, new THREE.Vector3());
    this.schedule(tHit, () => {
      const n = this._groundNormal(hitPos.x, hitPos.z, _v2);
      const vn = hitVel.dot(n);
      if (vn < 0) hitVel.addScaledVector(n, -(1 + BOUNCE_RESTITUTION) * vn);
      hitVel.multiplyScalar(BOUNCE_DAMPING);
      hitPos.y = this.groundHeight(hitPos.x, hitPos.z) + 0.04;
      this._groundSplash(hitPos, color, clamp(-vn / 16, 0.3, 1.2) * sizeMul);
      this.audio.play('thud', hitPos, { gain: 0.55, refDistance: 2, rate: randRange(1.15, 1.45) });
      const remaining = flightT - tHit;
      if (remaining < 0.06 || hitVel.length() < 2.5) {
        // out of steam: fizz on the sand until the charge pops
        this._spawnComet(hitPos, _v1.set(randRange(-0.2, 0.2), 0.5, randRange(-0.2, 0.2)),
          color, sizeMul * 0.7, { gravity: 1, drag: 3, life: Math.max(remaining, 0.05) });
        this.schedule(Math.max(remaining, 0), () => opts.onBurst(hitPos));
      } else {
        this._fireShot(hitPos, hitVel, color, sizeMul, { ...opts, flightT: remaining }, bounceNum + 1);
      }
    });
  }

  // ---- particles ----

  spawnFuseSparks(pos, time, dt) {
    this._fuseSparkAcc += dt * 90;
    const n = Math.floor(this._fuseSparkAcc);
    this._fuseSparkAcc -= n;
    if (n <= 0) return;
    const pool = this.pool;
    pool.spawn(n, (i) => {
      pool.set(i,
        pos.x + randRange(-0.008, 0.008), pos.y + randRange(-0.008, 0.008), pos.z + randRange(-0.008, 0.008),
        randRange(-0.5, 0.5), randRange(0.1, 0.9), randRange(-0.5, 0.5),
        1.0, 0.75, 0.3,
        time, randRange(0.15, 0.45),
        randRange(0.008, 0.02), 0.35, 2.5, 0);
    });
  }

  /**
   * A single glowing star streaking along a ballistic arc. gravity/drag/life
   * must match the ballistic() prediction of the caller so the scheduled
   * burst happens exactly where the streak dies.
   */
  _spawnComet(pos, vel, color, sizeMul = 1, { gravity = 0.75, drag = 0.55, life = 1.0 } = {}) {
    const pool = this.pool;
    const time = this.time;
    // the comet head plus a short stagger of followers = glowing streak
    // (heads get a long shutter so the rise reads as a line of fire)
    pool.spawn(14, (i) => {
      const lag = Math.random() * 0.1;
      pool.set(i,
        pos.x, pos.y, pos.z,
        vel.x * (1 - lag * 2), vel.y * (1 - lag * 2), vel.z * (1 - lag * 2),
        color.r * 3.4, color.g * 3.4, color.b * 3.4,
        time + lag * 0.5, life * randRange(0.95, 1.1),
        randRange(0.09, 0.14) * sizeMul, gravity, drag, 0,
        undefined, 0.03);
    });
    // display shells climb on a glitter tail: strobing gold flecks shed all
    // along the arc, precomputed with the same closed-form ballistics the
    // shader integrates — they hang and wink where the shell passed
    if (sizeMul >= 1.2) {
      const d = Math.max(drag, 1e-4);
      const gA = 9.81 * gravity;
      pool.spawn(Math.round(26 * sizeMul), (i) => {
        const ts = Math.random() * life;
        const k = (1 - Math.exp(-d * ts)) / d;
        const e = Math.exp(-d * ts);
        pool.set(i,
          pos.x + vel.x * k, pos.y + vel.y * k - gA * (ts - k) / d, pos.z + vel.z * k,
          vel.x * e * 0.12 + randRange(-0.7, 0.7), vel.y * e * 0.12 + randRange(-0.9, 0.3), vel.z * e * 0.12 + randRange(-0.7, 0.7),
          3.4, 2.4, 1.1,
          time + ts, randRange(0.5, 1.1),
          randRange(0.05, 0.09) * sizeMul, 0.3, 1.6, 28);
      });
    }
  }

  // Exhaust from a motor pinned in a fist: the flare rides the nozzle and a
  // jet of flame blasts back down the stick instead of streaking behind a
  // moving rocket.
  _heldExhaust(r, dt, time) {
    const size = r.item.type.size;
    const nozzle = _v4.copy(r.pos).addScaledVector(r.dir, r.flareOffset);
    if (r.flare) {
      r.flare.position.copy(nozzle);
      r.flare.scale.setScalar((0.22 + size * 0.22) * randRange(0.75, 1.25));
    }
    const pool = this.pool;
    const nx = nozzle.x, ny = nozzle.y, nz = nozzle.z;
    const dx = r.dir.x, dy = r.dir.y, dz = r.dir.z;
    const count = Math.max(1, Math.round(dt * 170 * (0.5 + size)));
    pool.spawn(count, (i) => {
      const sp = randRange(2.5, 6.5);
      pool.set(i,
        nx + randRange(-0.012, 0.012), ny + randRange(-0.012, 0.012), nz + randRange(-0.012, 0.012),
        -dx * sp + randRange(-0.9, 0.9), -dy * sp + randRange(-0.9, 0.9), -dz * sp + randRange(-0.9, 0.9),
        1.0, 0.62, 0.22,
        time, randRange(0.25, 0.6),
        randRange(0.02, 0.045) * (0.6 + size), 0.4, 2.2, 0);
    });
  }

  spawnTrail(pos, vel, dt, time, size) {
    const pool = this.pool;
    const count = Math.max(1, Math.round(dt * 220 * (0.5 + size)));
    pool.spawn(count, (i) => {
      const back = Math.random() * dt;
      pool.set(i,
        pos.x - vel.x * back + randRange(-0.015, 0.015),
        pos.y - vel.y * back + randRange(-0.015, 0.015),
        pos.z - vel.z * back + randRange(-0.015, 0.015),
        randRange(-1.2, 1.2), randRange(-1.5, 0.4), randRange(-1.2, 1.2),
        1.0, 0.62, 0.22,
        time - back, randRange(0.3, 0.8),
        randRange(0.02, 0.045) * (0.6 + size), 0.4, 2.2, 0);
    });
  }

  /**
   * A shell burst. spec: {pattern, size (0..2.0), palette, count?, speed?,
   * sound: 'big'|'med'|'small'|null, noFlash?, drift? (Vector3 — residual
   * shell velocity the whole burst inherits, so it keeps moving)}
   *
   * Expansion pacing: a star's spread radius is speed/drag, reached with
   * time constant 1/drag. Low speed + low drag = the same (or bigger)
   * final diameter but a slow, majestic bloom instead of an instant pop.
   */
  burst(pos, spec) {
    // never burst under the sand — lift to just above it so ground-level
    // breaks read as a splash across the surface
    const bgy = this.groundHeight(pos.x, pos.z);
    if (pos.y < bgy + 0.15) pos.y = bgy + 0.15;

    const size = spec.size ?? 0.6;
    const palette = spec.palette ?? randPick(PALETTES);
    const pattern = spec.pattern ?? 'peony';
    const pool = this.pool;
    const time = this.time;
    const dvx = spec.drift?.x ?? 0, dvy = spec.drift?.y ?? 0, dvz = spec.drift?.z ?? 0;

    const colA = _c1.set(palette.a);
    const colB = _c2.set(palette.b);

    const soundSize = spec.sound === 'big' ? 1 : spec.sound === 'med' ? 0.6 : 0.3;
    if (spec.sound) {
      this.audio.boom(pos, soundSize, { crackle: pattern === 'crackle' || pattern === 'multibreak' });
    }
    if (!spec.noFlash) {
      // white-hot pop then a colored afterglow that burns as long as the
      // stars do, sinking with them as they fall
      this.flashes.flash(pos, palette.a, 2500 * size * size + 420, 2.1 + size * 1.3, 3.0);
      this.flashSprites.burst(pos, palette.b, 0.6 + size);
      // and a basin-wide wash: bigger bursts kick the ambient light harder
      const pulse = this.ambientPulse;
      const add = 0.42 + 1.6 * size * size;
      pulse.color.lerp(colB, add / (pulse.energy + add));
      pulse.energy = Math.min(pulse.energy + add, 2.6);

      // lingering smoke haze: a real occluding cloud (albedo, lit by the
      // moon and by later bursts — see the particle shader) that swells and
      // drifts downwind after the stars die. What keeps a big shell from
      // just vanishing into clean air, and what the next shell lights up.
      if (size > 0.3) {
        pool.spawn(10 + Math.round(12 * size), (i) => {
          const u = Math.random() * 2 - 1;
          const a = Math.random() * Math.PI * 2;
          const rr = Math.sqrt(1 - u * u);
          const sp = randRange(1.2, 3.2) * (0.5 + size);
          pool.set(i,
            pos.x, pos.y, pos.z,
            rr * Math.cos(a) * sp + dvx * 0.4 + 0.5, u * sp * 0.6 + dvy * 0.3 + 0.25, rr * Math.sin(a) * sp + dvz * 0.4,
            0.34 + colA.r * 0.10, 0.34 + colA.g * 0.10, 0.37 + colA.b * 0.10,
            time, randRange(3.5, 6.5) * (0.7 + size * 0.5),
            randRange(0.9, 1.6) * (0.5 + size), -0.012, 1.2, -1);
        });
      }
    }
    this.onBoom?.(pos, size);

    // display brightness scales with shell size: the big far-away breaks
    // need the extra output to still read brilliant from the campsite
    const glow = 1 + Math.max(0, size - 0.55) * 0.6;

    /**
     * opts.trail: number of tracer beads strung behind each star. Beads
     * share the star's exact velocity but are born a beat later, so they
     * ride the same drag/gravity arc a step behind — from the campsite that
     * reads as the runner streaks real stars burn into the sky. Streaks are
     * longest right after the break (fast expansion spreads the beads) and
     * tighten as drag slows everything down, which is how the real thing
     * behaves. Costs (trail+1)x particles for a trailed layer.
     */
    /**
     * Extra realism knobs (all optional):
     *   cell     atlas sprite for the stars (or [cellA, cellB, probB] to mix)
     *   stretch  motion-blur shutter seconds (undefined = pool default)
     *   shift    {color, t} — relay stars: every star switches to `color`
     *            at life fraction t, with an ignition pop at the changeover
     */
    const spawnSphere = (count, speed, opts = {}) => {
      const gravity = opts.gravity ?? 0.35;
      const drag = opts.drag ?? 0.65;
      const twinkle = opts.twinkle ?? 0;
      const beads = opts.trail ?? 0;
      const seg1 = beads + 1;
      const shift = opts.shift;
      const sc = shift ? new THREE.Color(shift.color) : null;
      // per-star state carried across the star's beads (fill runs in order)
      let j = -1, vx, vy, vz, cr, cg, cb, life, psz, lag, shiftT, sr, sg, sb;
      pool.spawn(count * seg1, (i) => {
        j++;
        const seg = j % seg1;
        if (seg === 0) {
          // uniform direction
          const u = Math.random() * 2 - 1;
          const a = Math.random() * Math.PI * 2;
          const r = Math.sqrt(1 - u * u);
          let dx = r * Math.cos(a), dy = u, dz = r * Math.sin(a);
          if (opts.hemisphereBias) dy = Math.abs(dy) * 0.8 + dy * 0.2;
          if (opts.flatten) dy *= opts.flatten; // pancake the break (waterfall)
          const sp = speed * (opts.shellSkin ? randRange(0.92, 1.0) : randRange(0.35, 1.0));
          const white = Math.random() < (opts.whiteCore ?? 0.08);
          const c = white ? null
            : opts.color === 'a' ? colA
            : opts.color === 'b' ? colB
            : (Math.random() < 0.5 ? colA : colB);
          const bright = opts.brightness ?? glow;
          vx = dx * sp + dvx + randRange(-0.5, 0.5);
          vy = dy * sp + dvy + randRange(-0.5, 0.5);
          vz = dz * sp + dvz + randRange(-0.5, 0.5);
          cr = white ? 7.4 * bright : c.r * 5.7 * bright;
          cg = white ? 7.2 * bright : c.g * 5.7 * bright;
          cb = white ? 6.7 * bright : c.b * 5.7 * bright;
          if (sc) {
            shiftT = shift.t * randRange(0.88, 1.12);
            sr = sc.r * 5.7 * bright; sg = sc.g * 5.7 * bright; sb = sc.b * 5.7 * bright;
          } else shiftT = 0;
          life = (opts.life ?? 2.4) * randRange(0.75, 1.25);
          psz = (opts.psize ?? 0.12) * randRange(0.7, 1.4) * (0.6 + size * 0.7);
          lag = randRange(0.022, 0.036);
          const cell = Array.isArray(opts.cell)
            ? (Math.random() < opts.cell[2] ? opts.cell[1] : opts.cell[0])
            : opts.cell;
          pool.set(i, pos.x, pos.y, pos.z, vx, vy, vz, cr, cg, cb,
            time, life, psz, gravity, drag, twinkle,
            cell, opts.stretch, undefined, shiftT, sr, sg, sb);
        } else {
          // tracer bead: dimmer, smaller, no strobe — a clean streak segment
          const fade = (1 - seg / seg1) * 0.55;
          pool.set(i, pos.x, pos.y, pos.z, vx, vy, vz,
            cr * fade, cg * fade, cb * fade,
            time + seg * lag, life * (1 - 0.1 * (seg / seg1)),
            psz * (0.5 + 0.4 * (1 - seg / seg1)), gravity, drag, 0,
            undefined, opts.stretch, undefined, shiftT,
            sc ? sr * fade : undefined, sc ? sg * fade : undefined, sc ? sb * fade : undefined);
        }
      });
    };

    /**
     * The long-exposure-photo chrysanthemum: stars ride near-uniform radial
     * rays and shed glowing flakes along the way. Each flake is precomputed
     * at break time — born at the moment its star passes (birth offset),
     * placed by the same closed-form ballistics the shader integrates, given
     * a fraction of the shed velocity and heavy drag so it slides a couple
     * of meters and then hangs where it was dropped. A flake shed at ts
     * lives until the head dies, so every ray stays lit from core to tip and
     * then fades as one — and because outer flakes are younger, each ray is
     * naturally rim-bright / center-dim, exactly how the real thing reads.
     * opts.tipSparkle finishes each ray with strobing near-white glitter.
     * Costs (1 + flakes + 2·tipSparkle) particles per ray.
     */
    const spawnRays = (rays, speed, opts = {}) => {
      const gravity = opts.gravity ?? 0.36;
      const drag = opts.drag ?? 0.5;
      const flakes = opts.flakes ?? 22;
      const tips = opts.tipSparkle ? 2 : 0;
      const seg1 = 1 + flakes + tips;
      const bright = opts.brightness ?? glow;
      const flakeTw = opts.flakeTwinkle ?? 0;
      const baseLife = opts.life ?? 2.6;
      const scale = 0.6 + size * 0.7;
      const d = Math.max(drag, 0.0001);
      const gAcc = 9.81 * gravity;
      // strobing flakes (>= 20 Hz) render as textured star crosses, which
      // can't stretch; smooth flakes get a long shutter that smears each one
      // along its ray — thin continuous lines instead of fat bead strings
      const fCell = flakeTw >= 20 ? undefined : CELL.GLOW;
      const fStretch = flakeTw >= 20 ? undefined : 0.05;
      // per-ray state carried across the ray's flakes (fill runs in order)
      let j = -1, vx, vy, vz, cr, cg, cb, tr, tg, tb, life;
      pool.spawn(rays * seg1, (i) => {
        j++;
        const seg = j % seg1;
        if (seg === 0) {
          // the head star: uniform direction, near-uniform speed — the
          // photo's bursts are clean spheres of same-length rays
          const u = Math.random() * 2 - 1;
          const a = Math.random() * Math.PI * 2;
          const r = Math.sqrt(1 - u * u);
          const sp = speed * randRange(0.93, 1.0);
          vx = r * Math.cos(a) * sp + dvx;
          vy = u * sp + dvy;
          vz = r * Math.sin(a) * sp + dvz;
          cr = colA.r; cg = colA.g; cb = colA.b;
          // tip tone: the ray color pushed most of the way to white —
          // pink-white on scarlet, pale gold on amber, mint on teal
          tr = cr + (1 - cr) * 0.72; tg = cg + (1 - cg) * 0.72; tb = cb + (1 - cb) * 0.72;
          life = baseLife * randRange(0.9, 1.1);
          pool.set(i, pos.x, pos.y, pos.z, vx, vy, vz,
            cr * 5.7 * bright, cg * 5.7 * bright, cb * 5.7 * bright,
            time, life, (opts.psize ?? 0.12) * randRange(0.85, 1.2) * scale,
            gravity, drag, 0, CELL.GLOW, 0.055);
        } else if (seg <= flakes) {
          // a flake shed on the way out (jittered even spacing, skipping the
          // dark core the photo shows around the break point). Flakes keep a
          // healthy share of the shed velocity with moderate drag, so each
          // one smears a few meters along the ray — that's what fuses the
          // beads into the photo's solid lines instead of dotted strings.
          const f = (seg - 1 + Math.random() * 0.9) / flakes;
          const ts = life * (0.04 + 0.74 * f);
          const k = (1 - Math.exp(-d * ts)) / d;
          const e = Math.exp(-d * ts);
          const svy = (vy + gAcc / d) * e - gAcc / d; // shed-point velocity
          // outer flakes tint gently toward the tip tone; the photo's rays
          // hold saturation nearly to the end. flakeBright is the hue knob:
          // saturated primaries survive heavy HDR overdrive, but golds have
          // to stay under ~3x or ACES compresses them to silver-white.
          const w = f * 0.22 * (opts.flakeTint ?? 1);
          const fb = (opts.flakeBright ?? 4.4) * (1 - f * 0.2) * bright;
          pool.set(i,
            pos.x + vx * k, pos.y + vy * k - gAcc * (ts - k) / d, pos.z + vz * k,
            vx * e * 0.5 + randRange(-0.5, 0.5), svy * 0.5 + randRange(-0.5, 0.5), vz * e * 0.5 + randRange(-0.5, 0.5),
            (cr + (tr - cr) * w) * fb, (cg + (tg - cg) * w) * fb, (cb + (tb - cb) * w) * fb,
            time + ts, (life - ts) * randRange(0.9, 1.12) + 0.3,
            0.21 * randRange(0.8, 1.3) * scale, 0.08, 1.3, flakeTw,
            fCell, fStretch);
        } else {
          // ray tip: a strobing near-white spark that lands right where the
          // ray dies — the bright bead ends the photo's rays all carry.
          // Rendered with the 6-point flare sprite so each ray finishes on a
          // tiny lens-star, the way tips bloom in real display photos.
          const ts = life * randRange(0.78, 0.94);
          const k = (1 - Math.exp(-d * ts)) / d;
          const e = Math.exp(-d * ts);
          const svy = (vy + gAcc / d) * e - gAcc / d;
          pool.set(i,
            pos.x + vx * k, pos.y + vy * k - gAcc * (ts - k) / d, pos.z + vz * k,
            vx * e * 0.5 + randRange(-0.6, 0.6), svy * 0.5 + randRange(-0.6, 0.6), vz * e * 0.5 + randRange(-0.6, 0.6),
            tr * 7.2 * bright, tg * 7.2 * bright, tb * 7.2 * bright,
            time + ts, randRange(0.45, 0.85),
            0.19 * randRange(0.8, 1.25) * scale, 0.15, 1.2, 24,
            CELL.STAR6, 0);
        }
      });
    };

    const grand = Math.max(0, size - 0.75);
    const grandCount = 1 + grand * 0.65;
    const grandLife = 1 + grand * 0.45;
    const grandPSize = 1 + grand * 0.45;
    const slowGrandDrag = (base) => Math.max(0.28, base - grand * 0.24);
    const wideGrandSpeed = (base) => base * (1 + grand * 0.22);

    /** A trailed ring of stars in the plane perpendicular to nVec. */
    const spawnRing = (nVec, count, speed) => {
      const uAxis = _v2.crossVectors(nVec, Math.abs(nVec.y) < 0.9 ? UP : X_AXIS).normalize();
      const vAxis = _v3.crossVectors(nVec, uAxis).normalize();
      const rDrag = slowGrandDrag(0.7);
      let rj = -1, rvx, rvy, rvz, rLife, rLag;
      pool.spawn(count * 3, (i) => {
        rj++;
        const seg = rj % 3;
        if (seg === 0) {
          const a = (rj / (count * 3)) * Math.PI * 2 + Math.random() * 0.05;
          const dx = uAxis.x * Math.cos(a) + vAxis.x * Math.sin(a);
          const dy = uAxis.y * Math.cos(a) + vAxis.y * Math.sin(a);
          const dz = uAxis.z * Math.cos(a) + vAxis.z * Math.sin(a);
          const sp = speed * randRange(0.95, 1.05);
          rvx = dx * sp + dvx; rvy = dy * sp + dvy; rvz = dz * sp + dvz;
          rLife = (randRange(1.8, 2.4) + size * 0.6) * grandLife;
          rLag = randRange(0.022, 0.036);
          pool.set(i, pos.x, pos.y, pos.z, rvx, rvy, rvz,
            colA.r * 5.7 * glow, colA.g * 5.7 * glow, colA.b * 5.7 * glow,
            time, rLife, 0.11 * grandPSize, 0.3, rDrag, 0, CELL.GLOW, 0.05);
        } else {
          const fade = (1 - seg / 3) * 0.55;
          pool.set(i, pos.x, pos.y, pos.z, rvx, rvy, rvz,
            colA.r * 5.7 * glow * fade, colA.g * 5.7 * glow * fade, colA.b * 5.7 * glow * fade,
            time + seg * rLag, rLife * 0.95,
            0.11 * grandPSize * (0.5 + 0.4 * (1 - seg / 3)), 0.3, rDrag, 0, CELL.GLOW, 0.05);
        }
      });
    };

    switch (pattern) {
      case 'peony':
        // small stars on a long shutter: each one draws a fine line radiating
        // from the break, longest right at the break and tightening as drag
        // bites — the long-exposure streamer look of the real thing
        spawnSphere(spec.count ?? Math.round((310 + 720 * size) * grandCount), spec.speed ?? wideGrandSpeed(12 + 14 * size), {
          shellSkin: true, life: (2.2 + 1.2 * size) * grandLife, drag: slowGrandDrag(0.6), gravity: 0.35,
          psize: 0.12 * grandPSize, trail: 2, stretch: 0.06,
        });
        spawnSphere(Math.round((120 + 230 * size) * grandCount), 7 + 8 * size, {
          life: 1.6 * grandLife, psize: 0.075 * grandPSize, drag: slowGrandDrag(0.7), stretch: 0.04,
        });
        // ~40% of peonies carry a pistil: a slow contrast-color heart inside
        // the sphere, the way real ball shells are often built two-stage
        if (Math.random() < 0.4) {
          spawnSphere(Math.round((90 + 150 * size) * grandCount), (4 + 5 * size), {
            shellSkin: true, color: 'b', life: 1.9 * grandLife, drag: 0.8, gravity: 0.3,
            psize: 0.16 * grandPSize, brightness: glow * 0.8, whiteCore: 0.02,
          });
        }
        break;

      case 'dahlia': {
        // The postcard shell: saturated single-color rays held lit from core
        // to tip, near-white sparkle at every ray end, breaking over a loose
        // pistil core in the palette's accent color (teal over ember, scarlet
        // over pink, violet over magenta…).
        const rays = spec.count ?? Math.min(300, Math.round(100 + 115 * size + 50 * grand));
        const speed = spec.speed ?? wideGrandSpeed(11.5 + 12.5 * size);
        spawnRays(rays, speed, {
          life: (2.5 + size) * grandLife, drag: slowGrandDrag(0.52), gravity: 0.34,
          flakes: Math.round(20 + 11 * Math.min(size, 1.6)), tipSparkle: true,
          psize: 0.12 * grandPSize,
        });
        // the pistil rides dimmer than the rays on purpose: overdriving warm
        // accent colors would ACES-compress them to white, and the photo's
        // cores are unmistakably orange/pink — density carries the punch
        spawnSphere(Math.round((150 + 190 * size) * grandCount), speed * 0.42, {
          color: 'b', life: 2.2 * grandLife, drag: 0.75, gravity: 0.3,
          psize: 0.18 * grandPSize, trail: 1, whiteCore: 0.02, brightness: glow * 0.75,
        });
        break;
      }

      case 'chrys': // brocade-crown chrysanthemum: dense hanging glitter rays
        spawnRays(Math.min(340, Math.round(110 + 120 * size + 48 * grand)), wideGrandSpeed(11 + 13 * size), {
          life: (2.9 + 1.1 * size) * grandLife, drag: slowGrandDrag(0.48), gravity: 0.45,
          flakes: Math.round(22 + 11 * Math.min(size, 1.6)), tipSparkle: true,
          flakeTwinkle: 15, psize: 0.10 * grandPSize,
          flakeBright: 2.6, flakeTint: 0.4, // hold the amber — see spawnRays
        });
        break;

      case 'willow':
        // long shutter: the drooping branches smear into molten threads
        spawnSphere(Math.round((220 + 440 * size) * grandCount), wideGrandSpeed(8 + 9 * size), {
          shellSkin: true, life: (3.8 + size * 1.4) * grandLife, drag: slowGrandDrag(0.4), gravity: 0.4, psize: 0.085 * grandPSize,
          trail: 4, stretch: 0.055,
        });
        break;

      case 'palm': {
        const arms = 14 + Math.round(size * 10);
        const speed = wideGrandSpeed(13 + 15 * size);
        const starsPerArm = Math.round(25 + 9 * grand);
        const pDrag = slowGrandDrag(0.6);
        let pj = -1, pvx, pvy, pvz, pLife, pSize, pLag;
        pool.spawn(arms * starsPerArm * 3, (i) => {
          pj++;
          const seg = pj % 3;
          if (seg === 0) {
            const star = (pj / 3) | 0;
            const arm = (star % arms) / arms;
            const theta = arm * Math.PI * 2 + Math.random() * 0.12;
            const elev = randRange(0.25, 1.0); // biased upward
            const dx = Math.cos(theta) * (1 - elev * 0.6);
            const dz = Math.sin(theta) * (1 - elev * 0.6);
            const dy = elev;
            const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
            const sp = speed * randRange(0.45, 1.0);
            pvx = dx / len * sp + dvx; pvy = dy / len * sp + dvy; pvz = dz / len * sp + dvz;
            pLife = (randRange(2.2, 3.2) + size) * grandLife;
            pSize = randRange(0.11, 0.17) * grandPSize;
            pLag = randRange(0.024, 0.04);
            pool.set(i, pos.x, pos.y, pos.z, pvx, pvy, pvz,
              colA.r * 5.7 * glow, colA.g * 5.7 * glow, colA.b * 5.7 * glow,
              time, pLife, pSize, 0.45, pDrag, 0, CELL.GLOW, 0.05);
          } else {
            const fade = (1 - seg / 3) * 0.55;
            pool.set(i, pos.x, pos.y, pos.z, pvx, pvy, pvz,
              colA.r * 5.7 * glow * fade, colA.g * 5.7 * glow * fade, colA.b * 5.7 * glow * fade,
              time + seg * pLag, pLife * 0.95,
              pSize * (0.5 + 0.4 * (1 - seg / 3)), 0.45, pDrag, 0, CELL.GLOW, 0.05);
          }
        });
        break;
      }

      case 'ring': {
        // ring in a random plane
        const n = _v1.set(randRange(-1, 1), randRange(-0.4, 0.4), randRange(-1, 1)).normalize();
        spawnRing(n, spec.count ?? Math.round((230 + 320 * size) * grandCount),
          spec.speed ?? wideGrandSpeed(14 + 14 * size));
        break;
      }

      case 'saturn': {
        // the classic Saturn shell: a tight contrast-color peony core with a
        // flat ring orbiting it, the ring plane tilted a little off level
        spawnSphere(Math.round((140 + 240 * size) * grandCount), 5.5 + 6.5 * size, {
          shellSkin: true, color: 'b', life: 2.0 * grandLife, drag: 0.75, gravity: 0.3,
          psize: 0.15 * grandPSize, trail: 1, whiteCore: 0.03,
        });
        const n = _v1.set(randRange(-0.35, 0.35), 1, randRange(-0.35, 0.35)).normalize();
        spawnRing(n, Math.round((250 + 310 * size) * grandCount), wideGrandSpeed(15 + 15 * size));
        break;
      }

      case 'crossette': {
        // a modest primary break whose stars each split again
        spawnSphere(Math.round((180 + 290 * size) * grandCount), wideGrandSpeed(12 + 12 * size), {
          life: 1.3 * grandLife, drag: slowGrandDrag(0.7), psize: 0.13 * grandPSize, trail: 2, stretch: 0.055,
        });
        const splits = 7 + Math.round(size * 7);
        for (let s = 0; s < splits; s++) {
          const u = Math.random() * 2 - 1;
          const a = Math.random() * Math.PI * 2;
          const r = Math.sqrt(1 - u * u);
          const dir = new THREE.Vector3(r * Math.cos(a), u, r * Math.sin(a));
          const sp = (14 + 12 * size) * randRange(0.8, 1.0);
          const vel = dir.multiplyScalar(sp);
          if (spec.drift) vel.add(spec.drift);
          const splitT = randRange(0.55, 0.85);
          const p2 = ballistic(pos, vel, splitT, 0.35, 0.7, new THREE.Vector3());
          this.schedule(splitT, () => {
            this.burst(p2, {
              pattern: 'peony', size: 0.2, palette,
              count: 70, speed: 8, sound: Math.random() < 0.4 ? 'small' : null, noFlash: true,
            });
          });
        }
        break;
      }

      case 'crackle':
        // a third of the stars render as branchy micro-bursts (a real
        // crackle-burst sprite, randomly rolled) — the frying-pan look
        spawnSphere(Math.round((400 + 760 * size) * grandCount), wideGrandSpeed(12 + 15 * size), {
          shellSkin: true, life: (2.4 + size) * grandLife, drag: slowGrandDrag(0.85), gravity: 0.45,
          twinkle: 55, psize: 0.10 * grandPSize, whiteCore: 0.5,
          cell: [CELL.STAR4, CELL.CRACKLE, 0.35],
        });
        break;

      case 'strobe':
        // slow blinkers get the 4-point cross sprite: from the campsite the
        // shell hangs as a cloud of winking star-crosses, like real strobe
        spawnSphere(Math.round((320 + 570 * size) * grandCount), wideGrandSpeed(11 + 13 * size), {
          shellSkin: true, life: (3.0 + size) * grandLife, drag: slowGrandDrag(0.9), gravity: 0.3,
          twinkle: 11, psize: 0.13 * grandPSize, whiteCore: 0.3,
          cell: CELL.STAR4, stretch: 0,
        });
        break;

      case 'brocade': {
        // Huge slow golden crown: opens wide, then hangs and rains down.
        spawnSphere(Math.round((300 + 530 * size) * grandCount), wideGrandSpeed(9 + 10 * size), {
          shellSkin: true, life: (4.4 + size * 1.7) * grandLife, drag: slowGrandDrag(0.35),
          gravity: 0.52, psize: 0.10 * grandPSize, twinkle: 18, whiteCore: 0.04, trail: 4, stretch: 0.05,
        });
        spawnSphere(Math.round((160 + 240 * size) * grandCount), 5 + 5 * size, {
          life: 2.3 * grandLife, drag: slowGrandDrag(0.55), gravity: 0.32,
          psize: 0.08 * grandPSize, twinkle: 34, whiteCore: 0.2,
        });
        break;
      }

      case 'serpents': {
        // "Go-getter" stars: small self-propelled comets that wriggle away
        // from the break point instead of flying on a clean ballistic ray.
        const snakes = Math.round(12 + size * 11 + grand * 10);
        const steps = Math.round(13 + size * 5);
        const baseSpeed = 10 + size * 8;
        spawnSphere(Math.round(160 + size * 240), 8 + size * 8, {
          life: 1.25 + size * 0.4, drag: 0.7, gravity: 0.28,
          psize: 0.075 * grandPSize, twinkle: 48, whiteCore: 0.18,
        });
        for (let s = 0; s < snakes; s++) {
          const u = randRange(-0.35, 0.75);
          const a = Math.random() * Math.PI * 2;
          const rr = Math.sqrt(1 - u * u);
          const dir = new THREE.Vector3(rr * Math.cos(a), u, rr * Math.sin(a)).normalize();
          const side = new THREE.Vector3(-dir.z, 0, dir.x);
          if (side.lengthSq() < 0.001) side.set(1, 0, 0);
          side.normalize();
          const lift = randRange(-0.15, 0.45);
          const color = Math.random() < 0.5 ? colA.clone() : colB.clone();
          const phase = Math.random() * Math.PI * 2;
          const speed = baseSpeed * randRange(0.82, 1.22);
          const amp = randRange(1.15, 2.5) * (0.7 + size * 0.35);
          const duration = randRange(1.25, 2.1) * grandLife;
          for (let k = 0; k < steps; k++) {
            const delay = (k / steps) * duration;
            this.schedule(delay, () => {
              const n = delay / duration;
              const forward = speed * delay;
              const wiggle = Math.sin(n * Math.PI * 5.5 + phase) * amp * (1 - n * 0.25);
              const p = pos.clone()
                .addScaledVector(dir, forward)
                .addScaledVector(side, wiggle)
                .add(_v2.set(dvx * delay, dvy * delay + lift * delay - 2.1 * delay * delay, dvz * delay));
              const tangent = dir.clone().multiplyScalar(speed)
                .addScaledVector(side, Math.cos(n * Math.PI * 5.5 + phase) * amp * 16)
                .add(_v3.set(dvx, dvy + lift - 4.2 * delay, dvz))
                .normalize();
              const headSpeed = randRange(1.2, 3.4);
              pool.spawn(8, (i) => {
                const lag = i * 0.03;
                pool.set(i,
                  p.x - tangent.x * lag, p.y - tangent.y * lag, p.z - tangent.z * lag,
                  tangent.x * headSpeed + randRange(-0.45, 0.45),
                  tangent.y * headSpeed + randRange(-0.45, 0.45),
                  tangent.z * headSpeed + randRange(-0.45, 0.45),
                  color.r * 7.5, color.g * 7.5, color.b * 7.5,
                  this.time, randRange(0.55, 1.05),
                  randRange(0.08, 0.13) * grandPSize, 0.25, 1.05, 35);
              });
            });
          }
        }
        break;
      }

      case 'waterfall': {
        // Niagara horsetail: stars flung gently outward in a flattened disc,
        // then surrendered to gravity — long-burning, low drag, each hauling
        // a heavy bead trail. From the campsite the trails merge into
        // striated molten columns pouring down the sky.
        spawnSphere(Math.round((230 + 260 * size) * grandCount), 3.5 + 3.5 * size, {
          flatten: 0.32, life: (4.8 + 1.8 * size) * grandLife, drag: 0.32, gravity: 0.55,
          psize: 0.09 * grandPSize, trail: 5, whiteCore: 0.35, brightness: glow * 1.15,
          stretch: 0.06, // pouring, not falling — the long shutter sells it
        });
        // shimmer threaded through the curtain — molten flakes strobing
        spawnSphere(Math.round(90 + 130 * size), 2.5 + 2 * size, {
          flatten: 0.4, life: (3.6 + 1.2 * size) * grandLife, drag: 0.4, gravity: 0.5,
          psize: 0.07 * grandPSize, twinkle: 22, whiteCore: 0.5,
        });
        break;
      }

      case 'salute': {
        // a report shell: one blinding white flash-bang, almost no stars —
        // plus a single huge 6-point flare frame right at the detonation
        spawnSphere(Math.round(110 + 90 * size), 16 + 10 * size, {
          life: 0.34, drag: 0.55, gravity: 0.2,
          psize: 0.2 * grandPSize, whiteCore: 1, brightness: 2.3, stretch: 0.045,
        });
        pool.spawn(1, (i) => pool.set(i, pos.x, pos.y, pos.z, 0, 0.5, 0,
          9.2, 9.0, 8.4, time, 0.24, 2.4 * grandPSize, 0, 0.5, 0, CELL.STAR6, 0));
        break;
      }

      case 'multibreak': {
        spawnSphere(Math.round((340 + 720 * size) * grandCount), wideGrandSpeed(14 + 17 * size), {
          shellSkin: true, life: (2.2 + size) * grandLife, drag: slowGrandDrag(0.7), gravity: 0.35, trail: 2,
          stretch: 0.055,
        });
        const pal2 = randPick(PALETTES);
        this.schedule(0.5, () => {
          this.burst(_v1.copy(pos).add(_v2.set(randRange(-10, 10), randRange(-2, 7), randRange(-10, 10))).clone(), {
            pattern: randPick(['ring', 'dahlia', 'serpents', 'ghost']), size: size * 0.78, palette: pal2, sound: 'med',
          });
        });
        this.schedule(1.0, () => {
          this.burst(_v1.copy(pos).add(_v2.set(randRange(-11, 11), randRange(-6, 4), randRange(-11, 11))).clone(), {
            pattern: randPick(['crackle', 'brocade', 'timerain']), size: size * 0.66, palette: pal2, sound: 'med',
          });
        });
        break;
      }

      case 'kamuro': {
        // the crown jewel of Japanese shells: a dense gold crown that opens
        // slow, hangs, then pours toward the ground in strobing glitter —
        // the long-life rays droop under gravity and blink as they fall
        spawnRays(Math.min(360, Math.round(120 + 130 * size + 52 * grand)), wideGrandSpeed(9.5 + 10.5 * size), {
          life: (4.4 + 1.7 * size) * grandLife, drag: slowGrandDrag(0.34), gravity: 0.52,
          flakes: Math.round(24 + 12 * Math.min(size, 1.6)), tipSparkle: true,
          flakeTwinkle: 21, flakeBright: 2.5, flakeTint: 0.35, psize: 0.10 * grandPSize,
        });
        // silver-white glitter dust threaded through the crown
        spawnSphere(Math.round((140 + 220 * size) * grandCount), 6 + 6 * size, {
          life: 2.8 * grandLife, drag: 0.6, gravity: 0.42,
          psize: 0.08 * grandPSize, twinkle: 26, whiteCore: 0.65,
        });
        break;
      }

      case 'ghost': {
        // relay-star peony: every star burns the first composition, then the
        // second catches with a hot little pop and the whole sphere blinks
        // over to a different color mid-fall — the "ghost shell" magic trick
        const pal2 = spec.palette2 ?? randPick(PALETTES);
        const to = pal2.a === palette.a ? palette.b : pal2.a;
        spawnSphere(spec.count ?? Math.round((300 + 640 * size) * grandCount), spec.speed ?? wideGrandSpeed(11 + 13 * size), {
          shellSkin: true, color: 'a', life: (2.6 + 1.2 * size) * grandLife, drag: slowGrandDrag(0.55), gravity: 0.35,
          psize: 0.12 * grandPSize, trail: 2, whiteCore: 0, stretch: 0.05,
          shift: { color: to, t: 0.44 },
        });
        // inner dust holds the first color a beat longer, so the change
        // sweeps outward-in like a real relay taking light
        spawnSphere(Math.round((110 + 200 * size) * grandCount), 6 + 7 * size, {
          life: 1.9 * grandLife, psize: 0.08 * grandPSize, drag: 0.7, color: 'a',
          shift: { color: to, t: 0.62 }, whiteCore: 0,
        });
        break;
      }

      case 'horsetail': {
        // a handful of heavy long-burn comets lobbed gently up — almost no
        // break, just molten tails surrendering to gravity, pouring down in
        // thick smeared strands (single-shell cousin of the waterfall)
        spawnSphere(Math.round((70 + 90 * size) * grandCount), 3.6 + 3.2 * size, {
          hemisphereBias: true, life: (4.4 + 1.6 * size) * grandLife, drag: 0.4, gravity: 0.6,
          psize: 0.14 * grandPSize, trail: 6, whiteCore: 0.15, stretch: 0.06,
          brightness: glow * 1.1,
        });
        // sizzling flecks shed off the falling tails
        spawnSphere(Math.round(90 + 120 * size), 2.6 + 2 * size, {
          hemisphereBias: true, life: (3.4 + size) * grandLife, drag: 0.5, gravity: 0.55,
          psize: 0.07 * grandPSize, twinkle: 24, whiteCore: 0.4,
        });
        break;
      }

      case 'leaves': {
        // falling leaves: featherweight relay embers that all but stop in
        // the air, then flutter down for ages, each one slowly blinking from
        // one color to another as it tumbles — an eerie, quiet shell
        const pal2 = randPick(PALETTES);
        const to = pal2.a === palette.a ? palette.b : pal2.a;
        spawnSphere(Math.round((170 + 260 * size) * grandCount), 6 + 6 * size, {
          life: (5.4 + 1.4 * size) * grandLife, drag: 1.15, gravity: 0.14,
          psize: 0.11 * grandPSize, twinkle: 7,
          shift: { color: to, t: 0.5 }, stretch: 0,
        });
        break;
      }

      case 'timerain': {
        // time-rain: a golden sphere whose wake keeps POPPING after the
        // stars die — delayed micro-charges precomputed along each fall
        // path (closed-form ballistics, zero runtime cost), so 6-point
        // glitter keeps igniting out of the black for seconds afterward
        const trSpeed = wideGrandSpeed(10 + 12 * size);
        spawnSphere(Math.round((240 + 420 * size) * grandCount), trSpeed, {
          shellSkin: true, life: (2.4 + size) * grandLife, drag: slowGrandDrag(0.5), gravity: 0.45,
          psize: 0.10 * grandPSize, trail: 3, stretch: 0.05,
        });
        const drops = Math.round((260 + 380 * size) * grandCount);
        const dDrag = 0.5, gA = 9.81 * 0.45;
        const maxT = (2.6 + size) * grandLife;
        pool.spawn(drops, (i) => {
          const u = Math.random() * 2 - 1;
          const a = Math.random() * Math.PI * 2;
          const rr = Math.sqrt(1 - u * u);
          const sp = trSpeed * randRange(0.4, 1.0);
          const vx = rr * Math.cos(a) * sp + dvx, vy = u * sp + dvy, vz = rr * Math.sin(a) * sp + dvz;
          const ts = randRange(0.5, maxT);
          const k = (1 - Math.exp(-dDrag * ts)) / dDrag;
          pool.set(i,
            pos.x + vx * k, pos.y + vy * k - gA * (ts - k) / dDrag, pos.z + vz * k,
            randRange(-0.8, 0.8), randRange(-0.6, 0.6), randRange(-0.8, 0.8),
            7.0 * glow, 6.4 * glow, 4.6 * glow,
            time + ts, randRange(0.1, 0.3),
            0.14 * randRange(0.7, 1.3) * (0.6 + size * 0.7), 0.2, 1.4, 0,
            CELL.STAR6, 0);
        });
        break;
      }
    }

    // sparkle pass: a halo of strobing white-hot glitter dust threaded
    // through every real break. Patterns built around twinkle already carry
    // their own; this gives the smooth ones (peony, willow, palm, ring…)
    // the same crackling life without changing their silhouette. The dahlia
    // sits this out too — white dust inside it would dilute the saturated
    // rays that ARE the look, and its ray tips already sparkle.
    const selfTwinkling = pattern === 'chrys' || pattern === 'crackle' || pattern === 'strobe'
      || pattern === 'dahlia' || pattern === 'kamuro' || pattern === 'timerain'
      || pattern === 'leaves' || pattern === 'ghost' || pattern === 'horsetail';
    if (!selfTwinkling && size >= 0.4) {
      spawnSphere(Math.round((140 + 300 * size) * grandCount), wideGrandSpeed(9 + 11 * size), {
        life: (2.3 + size * 0.9) * grandLife, drag: slowGrandDrag(0.75), gravity: 0.32,
        psize: 0.08 * grandPSize, twinkle: 30, whiteCore: 0.45,
      });
    }
  }

  // ---- frame update ----

  update(dt, time) {
    this.time = time;

    // due events
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (this.events[i].time <= time) {
        const e = this.events[i];
        this.events.splice(i, 1);
        e.fn();
      }
    }

    // items (fuses, falls)
    for (const item of this.items) item.update(dt, time);

    // rockets in flight (or pinned in a fist with the motor roaring)
    for (let i = this.rockets.length - 1; i >= 0; i--) {
      const r = this.rockets[i];
      r.age += dt;
      const burning = r.age < r.burnTime;

      if (r.held && !r.item.holder) {
        // let go: free flight from wherever the hand left it, with whatever
        // motor burn and coast remain on the clock — hold it long enough and
        // it barely climbs before the charge goes off
        r.held = false;
        r.pos.copy(r.item.root.position); // release() re-parented it to the scene
        r.item.axis(r.dir);
        r.vel.copy(r.dir).multiplyScalar(2.5);
        if (r.whoosh && burning) this._recedeWhoosh(r.whoosh);
      }

      if (r.held) {
        // gripped like a real bottle rocket: the hand wins the tug-of-war,
        // so no flight — just the motor straining and blasting exhaust
        r.item.root.getWorldPosition(r.pos);
        r.item.axis(r.dir);
        if (burning) {
          this._heldExhaust(r, dt, time);
          r.item.holder.pulse?.(0.28 + Math.random() * 0.22, 20);
        }
      } else {
        if (burning) {
          // thrust along current velocity direction (weathervane), slight wobble
          r.dir.copy(r.vel).normalize();
          const wob = 0.35;
          _v1.set(
            Math.sin(r.age * 31 + r.wobblePhase) * wob,
            0,
            Math.cos(r.age * 27 + r.wobblePhase) * wob,
          );
          r.vel.addScaledVector(r.dir, r.thrust * dt);
          r.vel.add(_v1.multiplyScalar(dt * 12));
        }
        r.vel.y -= 9.81 * dt;
        r.vel.multiplyScalar(1 - 0.12 * dt); // air drag
        r.pos.addScaledVector(r.vel, dt);

        // orient the mesh along velocity
        r.item.root.position.copy(r.pos);
        _v1.copy(r.vel).normalize();
        r.item.root.quaternion.setFromUnitVectors(UP, _v1);

        // exhaust
        if (burning) {
          this.spawnTrail(r.pos, r.vel, dt, time, r.item.type.size);
          if (r.flare) {
            // ride the nozzle, flickering like real motor exhaust
            r.flare.position.copy(r.pos).addScaledVector(_v1, r.flareOffset);
            const fs = (0.22 + r.item.type.size * 0.22) * randRange(0.75, 1.25);
            r.flare.scale.setScalar(fs);
          }
        }

        // ground contact: ricochet off the sand instead of tunneling into it —
        // a rocket aimed at the floor skips away and bursts wherever it ends up
        const groundY = this.groundHeight(r.pos.x, r.pos.z);
        if (r.pos.y < groundY + 0.04) {
          r.pos.y = groundY + 0.04;
          const n = this._groundNormal(r.pos.x, r.pos.z, _v2);
          const vn = r.vel.dot(n);
          if (vn < -2.0) {
            // hard strike: damped bounce plus a kick of sand
            r.vel.addScaledVector(n, -(1 + BOUNCE_RESTITUTION) * vn);
            r.vel.multiplyScalar(BOUNCE_DAMPING);
            this._groundSplash(r.pos, _c1.set(0xffb060), clamp(-vn / 14, 0.4, 1.4));
            this.audio.play('thud', r.pos, { gain: 0.8, refDistance: 2.5, rate: randRange(0.95, 1.2) });
          } else if (vn < 0) {
            // shallow scrape: shed the downward component and drag in the sand
            r.vel.addScaledVector(n, -vn);
            r.vel.multiplyScalar(Math.max(0, 1 - 2.5 * dt));
          }
        }
      }

      if (!burning && !r.burnedOut) {
        // motor burnout: kill the roar so the shell coasts up in silence —
        // the hush before the report is half of what makes the boom land
        r.burnedOut = true;
        r.whoosh?.stop(0.5);
        this._dropFlare(r);
      }
      r.whoosh?.setPosition(r.pos);

      if (r.age >= r.explodeAt) {
        r.whoosh?.stop(0.1);
        this._dropFlare(r);
        this.rockets.splice(i, 1);
        const item = r.item;
        const t = item.type;
        this.removeItem(item);
        this.burst(r.pos.clone(), {
          pattern: item.shell,
          size: t.size,
          palette: item.palette,
          sound: t.size > 0.75 ? 'big' : t.size > 0.45 ? 'med' : 'small',
          drift: r.vel.clone().multiplyScalar(0.55),
        });
      }
    }

    // the shared exhaust light rides the newest rocket that is still burning
    let burning = null;
    for (let k = this.rockets.length - 1; k >= 0; k--) {
      if (this.rockets[k].age < this.rockets[k].burnTime) { burning = this.rockets[k]; break; }
    }
    if (burning) {
      this.rocketLight.position.copy(burning.pos);
      this.rocketLight.intensity = 18 + Math.random() * 8;
    } else if (this.rocketLight.intensity > 0) {
      this.rocketLight.intensity *= Math.max(0, 1 - dt * 12);
      if (this.rocketLight.intensity < 0.5) this.rocketLight.intensity = 0;
    }

    // fountains / running emitters
    for (let i = this.emitters.length - 1; i >= 0; i--) {
      const e = this.emitters[i];
      e.age += dt;
      if (e.kind === 'fountain') {
        const item = e.item;
        const n = e.age / e.duration;
        if (n >= 1 || !this.items.has(item)) {
          e.sound?.stop(0.6);
          this._releaseEmitterLight(e.lightSlot);
          e.lightSlot = null;
          this.emitters.splice(i, 1);
          if (this.items.has(item)) this._spend(item);
          continue;
        }
        // ramp up, sustain, sputter out
        const power = n < 0.1 ? n / 0.1 : n > 0.85 ? Math.max(0.15, 1 - (n - 0.85) / 0.15) : 1;
        const nozzle = _v3.set(0, item.nozzleY, 0);
        item.root.localToWorld(nozzle);
        const dir = item.axis(new THREE.Vector3());
        e.sound?.setPosition(nozzle);
        e.sound?.setGain(power);

        // color slowly cycles between palette endpoints
        const mixT = 0.5 + 0.5 * Math.sin(e.age * 0.7 + e.phase);
        const c = _c1.set(item.palette.a).lerp(_c2.set(item.palette.b), mixT);

        const pool = this.pool;
        const rate = 320 * power * (0.85 + 0.3 * Math.sin(e.age * 9 + e.phase * 3));
        e.acc = (e.acc ?? 0) + rate * dt;
        const count = Math.floor(e.acc);
        e.acc -= count;
        if (count > 0) {
          pool.spawn(count, (idx) => {
            const spread = 0.16;
            _v1.copy(dir);
            _v1.x += randRange(-spread, spread);
            _v1.z += randRange(-spread, spread);
            _v1.normalize().multiplyScalar(randRange(6.5, 13) * (0.7 + power * 0.4));
            const white = Math.random() < 0.12;
            // thin smeared sparks — a spray of fine fire threads, not balls
            pool.set(idx,
              nozzle.x + randRange(-0.01, 0.01), nozzle.y, nozzle.z + randRange(-0.01, 0.01),
              _v1.x, _v1.y, _v1.z,
              white ? 3.8 : c.r * 3.0, white ? 3.7 : c.g * 3.0, white ? 3.4 : c.b * 3.0,
              time, randRange(0.6, 1.4),
              randRange(0.018, 0.038), 1.0, 1.6, Math.random() < 0.2 ? 40 : 0,
              CELL.GLOW, 0.03);
          });
        }
        // flickering ground light (from the shared pool — see constructor)
        if (!e.lightSlot) e.lightSlot = this._acquireEmitterLight(e);
        if (e.lightSlot) {
          const L = e.lightSlot.light;
          L.position.copy(nozzle).y += 0.5;
          L.color.copy(c);
          L.intensity = 5 * power * (0.7 + Math.random() * 0.6);
        }
      } else if (e.kind === 'belt') {
        const item = e.item;
        if (!this.items.has(item)) { // despawned mid-rip
          e.loop?.stop(0.2);
          this._releaseEmitterLight(e.lightSlot);
          e.lightSlot = null;
          this.emitters.splice(i, 1);
          continue;
        }
        const total = item.type.crackers;

        // burn progress: a slow catching phase (single pops as the flame
        // finds the braid), then the full end-to-end rip
        const rampFrac = 0.08;
        const prog = e.age < e.ramp
          ? rampFrac * Math.pow(e.age / e.ramp, 1.4)
          : rampFrac + (1 - rampFrac) * (e.age - e.ramp) / (e.duration - e.ramp);
        const target = Math.min(total, Math.floor(total * prog));
        while (item.beltConsumed < target) {
          this._beltPop(item, 1 - (item.beltConsumed + 0.5) / total, e.age < e.ramp);
          item.beltConsumed++;
        }

        // burn front world position (VFX above already used _v1 — use _v3)
        const NP = item.beltPts.length;
        const frontPos = item.beltPointAt(1 - item.beltConsumed / total, _v3);

        // the storm: the pre-rendered rip loop rides the burn front, with
        // lone louder crackers scattered on top so the rattle stays alive
        // and travels in 3D
        if (e.age >= e.ramp && !e.loop && !e.done) {
          e.loop = this.audio.play('firecrackers', frontPos, {
            gain: 0.001, loop: true, refDistance: 2.6, send: 0.4, hrtf: true,
            rate: randRange(0.96, 1.06),
          });
          e.loop?.setGain(1.2);
        }
        e.loop?.setPosition(frontPos);
        if (e.loop && !e.done) {
          e.accents -= dt;
          if (e.accents <= 0) {
            e.accents = randRange(0.12, 0.4);
            this.audio.play('cracker', frontPos, {
              gain: randRange(0.5, 1.0), refDistance: 2.2, send: 0.35, rate: randRange(0.85, 1.3),
            });
          }
        }

        // flickering muzzle light at the front (release the shared slot the
        // moment the last cracker pops — a finished belt must not squat on
        // one of the two pool lights another fountain could be using)
        if (!e.lightSlot && !e.done) e.lightSlot = this._acquireEmitterLight(e);
        if (e.lightSlot) {
          const L = e.lightSlot.light;
          L.position.copy(frontPos);
          L.position.y += 0.1;
          L.color.setHex(0xffc27a);
          L.intensity = (e.age < e.ramp ? 1.4 : 3.6) * (0.5 + Math.random());
        }

        // a belt ripping in your fist rattles the whole hand, harder as the
        // burn closes in on your fingers
        if (item.holder && !e.done) {
          const handDist = frontPos.distanceTo(item.beltPts[item.beltPinned].p);
          item.holder.pulse?.(clamp(0.58 - handDist * 0.38, 0.12, 0.6), 30);
        }

        if (item.beltConsumed >= total && !e.done) {
          e.done = true;
          e.loop?.stop(0.25);
          e.loop = null;
          this._releaseEmitterLight(e.lightSlot);
          e.lightSlot = null;
          // stragglers: the last couple of crackers pop alone in the smoke
          const fp = frontPos.clone();
          this.schedule(randRange(0.25, 0.45), () => this.audio.play('cracker', fp, {
            gain: 0.9, refDistance: 2.2, send: 0.4, rate: randRange(0.8, 1.0),
          }));
          this.schedule(randRange(0.75, 1.05), () => this.audio.play('cracker', fp, {
            gain: 1.25, refDistance: 2.4, send: 0.45, rate: 0.72,
          }));
          // and the pall of smoke the whole belt earned
          const pool = this.pool;
          pool.spawn(10, (idx) => {
            const a = item.beltPointAt(Math.random(), _v4);
            pool.set(idx,
              a.x + randRange(-0.1, 0.1), a.y + 0.08, a.z + randRange(-0.1, 0.1),
              randRange(-0.3, 0.3), randRange(0.3, 0.7), randRange(-0.3, 0.3),
              0.40, 0.40, 0.44,
              time, randRange(4, 8),
              randRange(0.4, 0.8), -0.015, 1.4, -1);
          });
        }

        if (e.age > e.duration + 1.6) {
          this._releaseEmitterLight(e.lightSlot);
          e.lightSlot = null;
          this.emitters.splice(i, 1);
          this._spendBelt(item);
        }
      } else if (e.kind === 'pinwheel') {
        const item = e.item;
        if (!this.items.has(item)) { // despawned mid-spin
          this._endPinwheel(e);
          this.emitters.splice(i, 1);
          continue;
        }
        const n = e.age / e.duration;
        // drive ramps in, sustains, then sputters; once the fuel is gone the
        // wheel freewheels down on bearing friction alone
        const power = n < 0.08 ? n / 0.08 : n > 0.85 ? Math.max(0, 1 - (n - 0.85) / 0.15) : 1;
        // driver thrust vs. bearing drag: terminal ≈ 80/2.2 ≈ 36 rad/s (~6 rev/s)
        e.spinVel += (80 * power - e.spinVel * 2.2) * dt;
        e.spin += e.spinVel * dt;
        // drivers are built tail-forward around the rim, so thrust spins -Y
        item.wheel.rotation.y = -e.spin;

        if (n >= 1 && e.spinVel < 1.2) {
          this._endPinwheel(e);
          this.emitters.splice(i, 1);
          this._spend(item);
          continue;
        }

        const hub = item.wheel.getWorldPosition(_v3);
        e.sound?.setPosition(hub);
        // roar tracks the thrust; swish rate and pitch climb with the spin
        e.sound?.setGain(0.95 * power + 0.06 * Math.min(1, e.spinVel / 30));
        e.sound?.setRate(0.22 + (e.spinVel / 36) * 0.95);

        // a wheel screaming in a fist buzzes the hand that holds it
        item.holder?.pulse?.(Math.min(0.4, e.spinVel / 110), 20);

        // color drifts between palette endpoints like the fountain does
        const mixT = 0.5 + 0.5 * Math.sin(e.age * 0.9 + e.phase);
        const c = _c1.set(item.palette.a).lerp(_c2.set(item.palette.b), mixT);
        const axis = _v2.set(0, 1, 0).applyQuaternion(item.wheel.getWorldQuaternion(_q1));

        const pool = this.pool;
        for (let d = 0; d < e.flares.length; d++) {
          const flare = e.flares[d];
          flare.scale.setScalar((0.02 + 0.16 * power) * randRange(0.75, 1.25));
          if (power <= 0) continue; // fuel gone: embers only, no spray
          const p = item.driverAnchors[d].getWorldPosition(_v4);
          const rx = p.x - hub.x, ry = p.y - hub.y, rz = p.z - hub.z;
          // exhaust points backward along the spin: normalize(axis × radial)
          let ex = axis.y * rz - axis.z * ry;
          let ey = axis.z * rx - axis.x * rz;
          let ez = axis.x * ry - axis.y * rx;
          const el = Math.hypot(ex, ey, ez) || 1;
          ex /= el; ey /= el; ez /= el;
          // the driver itself whips the other way at ω·R — sparks inherit it,
          // which is what smears the spray into those spiral arms
          const tipSpeed = e.spinVel * Math.hypot(rx, ry, rz);
          const want = 160 * power * dt;
          let cnt = Math.floor(want);
          if (Math.random() < want - cnt) cnt++;
          if (cnt === 0) continue;
          pool.spawn(cnt, (idx) => {
            const sp = randRange(5, 14) - tipSpeed * 0.85;
            const white = Math.random() < 0.35;
            // tiny base size + explicit motion smear: each spark draws as a
            // millimeters-thin streak of fire (the streak's thickness IS the
            // base size), like real driver exhaust — not the thick tubes the
            // old 3-6cm sparks smeared into, and not static glowing balls
            pool.set(idx,
              p.x + randRange(-0.012, 0.012), p.y + randRange(-0.012, 0.012), p.z + randRange(-0.012, 0.012),
              ex * sp + randRange(-0.7, 0.7), ey * sp + randRange(-0.7, 0.7), ez * sp + randRange(-0.7, 0.7),
              white ? 4.2 : c.r * 3.4, white ? 4.0 : c.g * 3.4, white ? 3.7 : c.b * 3.4,
              time, randRange(0.35, 0.9),
              randRange(0.007, 0.015), 0.9, 1.5, Math.random() < 0.25 ? 45 : 0,
              CELL.GLOW, 0.022);
          });
        }

        // flickering colored light at the hub (shared pool — see constructor)
        if (!e.lightSlot) e.lightSlot = this._acquireEmitterLight(e);
        if (e.lightSlot) {
          const L = e.lightSlot.light;
          L.position.copy(hub);
          L.color.copy(c);
          L.intensity = 4.5 * power * (0.7 + Math.random() * 0.6);
        }
      }
    }
    this.flashes.update(dt);
    this.flashSprites.update(dt);
    // basin wash from recent bursts dies off quickly (half-life ~150ms)
    this.ambientPulse.energy *= Math.exp(-4.6 * dt);

    // feed the particle shader's smoke lighting: the strongest live flash
    // plus the basin-wide burst wash — this is what makes every shell light
    // its own smoke from inside, and old smoke bloom when a new one breaks
    const u = this.pool.uniforms;
    if (u?.uFlashPos) {
      let best = null;
      for (const s of this.flashes.lights) {
        if (s.peak > 0 && (!best || s.light.intensity > best.light.intensity)) best = s;
      }
      if (best) {
        const p = best.light.position;
        u.uFlashPos.value.set(p.x, p.y, p.z, best.light.intensity);
        u.uFlashColor.value.copy(best.light.color);
      } else {
        u.uFlashPos.value.w = 0;
      }
      u.uSmokePulse.value.copy(this.ambientPulse.color)
        .multiplyScalar(this.ambientPulse.energy * 0.5);
    }
  }
}
