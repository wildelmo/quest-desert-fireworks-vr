// Fireworks gameplay: the items you hold and plant, burning fuses, rocket
// flight, and the shell-burst choreography (peony, dahlia, chrysanthemum,
// willow, palm, ring, saturn, crossette, crackle, strobe, serpents, brocade,
// kamuro, ghost, horsetail, falling leaves, time-rain, multi-break) drawn
// through the GPU particle pool. Also owns the pooled flash lights that slam
// the terrain with color on every burst.

import * as THREE from 'three';
import { randRange, randPick, clamp, mulberry32 } from './utils.js';
import { CELL } from './particles.js';
import { WIND } from './wind.js';

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
    shells: ['peony', 'dahlia', 'ring', 'crackle', 'strobe', 'ghost', 'bees', 'dragoneggs'],
    weight: 3,
  },
  rocketMed: {
    kind: 'rocket', label: 'Sky Rocket',
    bodyR: 0.028, bodyLen: 0.17, stickLen: 0.72,
    size: 0.6, fuseTime: 2.6, thrust: 42, burnTime: 1.4, coast: 1.5,
    shells: ['peony', 'dahlia', 'chrys', 'willow', 'ring', 'saturn', 'crossette', 'crackle', 'serpents', 'ghost', 'spider', 'fish', 'dragoneggs', 'tourbillon'],
    weight: 3,
  },
  rocketLarge: {
    kind: 'rocket', label: 'Mammoth Rocket',
    bodyR: 0.042, bodyLen: 0.26, stickLen: 0.92,
    size: 1.3, fuseTime: 3.2, thrust: 43, burnTime: 2.1, coast: 2.2,
    shells: ['peony', 'dahlia', 'chrys', 'willow', 'palm', 'crossette', 'brocade', 'serpents', 'multibreak', 'kamuro', 'ghost', 'saturn', 'horsetail', 'spider', 'farfalle', 'tourbillon', 'strobewillow', 'dragoneggs'],
    weight: 2,
  },
  rocketGrand: {
    kind: 'rocket', label: 'Grand Shell Rocket',
    bodyR: 0.058, bodyLen: 0.36, stickLen: 1.14,
    size: 1.8, fuseTime: 3.6, thrust: 45, burnTime: 2.45, coast: 2.45,
    // dahlia twice: the grand shells are the display pieces, and the
    // long-ray dahlia is the postcard look they exist for
    shells: ['peony', 'dahlia', 'dahlia', 'chrys', 'willow', 'palm', 'brocade', 'serpents', 'multibreak', 'kamuro', 'kamuro', 'ghost', 'timerain', 'horsetail', 'leaves', 'thousandbloom', 'strobewillow', 'spider', 'heart', 'smiley', 'star5', 'flare'],
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
// fuse + item-flight scratch (item.update runs inside frames that already
// lean on _v1.._v4)
const _fv1 = new THREE.Vector3();
const _fv2 = new THREE.Vector3();
const _fv3 = new THREE.Vector3();
const _fq = new THREE.Quaternion();

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

// ---------------------------------------------------------------------------
// Pattern-shell point sets. Real pattern shells glue their stars to a
// cardboard former inside the casing; ours are unit-scale XY outlines baked
// once at module load. Layout: flat triples [x, y, accent] where accent = 1
// marks points that burn the palette's second color (smiley eyes + grin).
const HEART_PTS = (() => {
  const pts = [];
  for (let i = 0; i < 90; i++) {
    // the classic cardioid-ish heart curve, normalized to ~unit radius
    const t = (i / 90) * Math.PI * 2;
    const x = 16 * Math.pow(Math.sin(t), 3);
    const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
    pts.push(x / 16, (y + 2.4) / 16, 0);
  }
  return pts;
})();
const SMILEY_PTS = (() => {
  const pts = [];
  for (let i = 0; i < 60; i++) { // the face ring
    const a = (i / 60) * Math.PI * 2;
    pts.push(Math.cos(a), Math.sin(a), 0);
  }
  for (const sx of [-1, 1]) { // eyes: two tight knots of stars
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.6;
      pts.push(sx * 0.36 + Math.cos(a) * 0.09, 0.34 + Math.sin(a) * 0.09, 1);
    }
  }
  for (let i = 0; i < 14; i++) { // the grin: a lower arc in the accent color
    const a = Math.PI * (1.13 + 0.74 * (i / 13));
    pts.push(Math.cos(a) * 0.58, Math.sin(a) * 0.58 + 0.08, 1);
  }
  return pts;
})();
const STAR5_PTS = (() => {
  // five-point star outline: 10 edges walked with 8 stars each, point up
  const pts = [];
  const R = 1, r = 0.40;
  for (let v = 0; v < 10; v++) {
    const a0 = Math.PI / 2 + (v / 10) * Math.PI * 2;
    const a1 = Math.PI / 2 + ((v + 1) / 10) * Math.PI * 2;
    const r0 = v % 2 ? r : R, r1 = v % 2 ? R : r;
    const x0 = Math.cos(a0) * r0, y0 = Math.sin(a0) * r0;
    const x1 = Math.cos(a1) * r1, y1 = Math.sin(a1) * r1;
    for (let i = 0; i < 8; i++) {
      const f = i / 8;
      pts.push(x0 + (x1 - x0) * f, y0 + (y1 - y0) * f, 0);
    }
  }
  return pts;
})();

// The new-generation patterns carry their own texture — dark phases before
// pops, silent swarms, planar shapes, bare flares. The generic white sparkle
// halo the classic breaks get would pollute all of them, so they sit it out.
const SELF_TEXTURED = new Set(['thousandbloom', 'bees', 'fish', 'dragoneggs',
  'spider', 'farfalle', 'tourbillon', 'heart', 'smiley', 'star5', 'flare',
  'strobewillow', 'lampare']);

// How much of the impact speed survives a bounce off the sand — soft, so
// things skip a little instead of ping-ponging around the desert.
const BOUNCE_RESTITUTION = 0.42;
const BOUNCE_DAMPING = 0.72;

// Thrown items hit softer than comet stars: cardboard on sand barely skips,
// and most of the slide dies in the grit on first contact.
const ITEM_RESTITUTION = 0.25;
const ITEM_FRICTION = 0.62;      // tangential speed kept per ground hit
const ITEM_DRAG_K = 0.05;        // quadratic air drag (tumbling cardboard)

// Cake tube firing order: a fixed scramble of the 3x3 grid (built row-major
// in _buildMesh) so consecutive shots hop corners instead of marching rows.
const CAKE_FIRE_ORDER = [4, 0, 8, 2, 6, 1, 5, 3, 7];

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
  }

  /**
   * sink: how fast the light drifts downward (m/s) — burning stars fall,
   * and the pool of light on the sand should follow them.
   *
   * Slot policy: free slot first; otherwise evict whichever flash has the
   * least light LEFT in it (peak scaled by its remaining envelope) — and
   * refuse outright if the newcomer is dimmer than that. A grand shell's
   * four-second afterglow can no longer be round-robined away by a volley
   * of muzzle pops.
   */
  flash(pos, color, intensity, dur = 0.45, sink = 0) {
    let slot = null, weakest = Infinity;
    for (const s of this.lights) {
      if (s.peak === 0) { slot = s; break; }
      const left = s.peak * Math.max(0, 1 - s.t / s.dur);
      if (left < weakest) { weakest = left; slot = s; }
    }
    if (slot.peak !== 0 && intensity <= weakest) return; // dimmer than everything burning
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
  constructor(scene, count = 4, atlas = null) {
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
    // the particle atlas already carries flare_01 in its FLASH cell — window
    // a clone onto that region instead of fetching + uploading the PNG a
    // second time (clones share the Source, so the GPU holds one copy; the
    // streak is vertically symmetric, so the atlas's flipY=false is moot)
    let flareTex;
    if (atlas) {
      flareTex = atlas.clone();
      flareTex.offset.set(0.75, 0.5); // CELL.FLASH: col 3, row 1 of the 4x2 grid
      flareTex.repeat.set(0.25, 0.5);
      flareTex.needsUpdate = true;
    } else {
      flareTex = new THREE.TextureLoader().load('assets/textures/particles/flare_01.png');
    }
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
  }

  burst(pos, color, size) {
    // same policy as the light pool: free slot, else the most-faded one —
    // and a small flash never steals a big one mid-bloom
    let s = null, weakest = Infinity;
    for (const c of this.sprites) {
      if (!c.sprite.visible) { s = c; break; }
      const left = c.to * Math.max(0, 1 - c.t / c.dur);
      if (left < weakest) { weakest = left; s = c; }
    }
    if (s.sprite.visible && 20 * size <= weakest) return;
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

// Pooled fuse lights: a sputtering fuse must actually light the tube and the
// hand holding it. Four small warm points, created at startup like every
// other light here (visible at intensity 0 — see the FlashPool note),
// acquired on ignite() and released the moment the item activates.
class FuseLightPool {
  constructor(scene, count = 4) {
    this.slots = [];
    for (let i = 0; i < count; i++) {
      const l = new THREE.PointLight(0xffa14e, 0, 0.9, 2.0);
      scene.add(l);
      this.slots.push({ light: l, owner: null, phase: Math.random() * 9 });
    }
  }

  acquire(item) {
    for (const s of this.slots) {
      if (!s.owner) { s.owner = item; return s; }
    }
    return null; // a fifth simultaneous fuse burns unlit — sparks still sell it
  }

  release(item) {
    for (const s of this.slots) {
      if (s.owner === item) {
        s.owner = null;
        s.light.intensity = 0;
      }
    }
  }

  update(time) {
    for (const s of this.slots) {
      if (!s.owner) continue;
      s.owner.fuseWorldPos(_v1);
      s.light.position.copy(_v1);
      // sputter: fast flicker with occasional near-dropouts, like a real
      // visco fuse choking on its own powder
      const chug = Math.sin(time * 31 + s.phase) * 0.35 + Math.sin(time * 8.7 + s.phase * 2.3) * 0.25;
      const dropout = Math.sin(time * 3.1 + s.phase) > 0.93 ? 0.25 : 1;
      s.light.intensity = Math.max(0.3, (1.8 + chug * 1.4) * dropout);
    }
  }
}

// ---------------------------------------------------------------------------
// Item visuals

// Printed wrapper art, one composition per KIND: rocket wrap, cake box art,
// candle tube, fountain cone, belt band — each printing its real type label
// ('Mammoth Rocket'…), house branding, the caution line, a lot number and
// palette-accented trim. 512x1024 + anisotropy so the print survives being
// held 20 cm from the lens. Deterministic per (type, palette): the same
// wrapper off the same press run.
const BRAND = 'DESERT BLOOM PYRO CO.';
const CAUTION = 'LIGHT FUSE — RETIRE QUICKLY';

function labelTexture(typeName, palette) {
  const t = ITEM_TYPES[typeName];
  const W = 512, H = 1024;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  const colA = new THREE.Color(palette.a);
  const colB = new THREE.Color(palette.b);
  const css = (col, k = 1) => `rgb(${(col.r * 255 * k) | 0},${(col.g * 255 * k) | 0},${(col.b * 255 * k) | 0})`;
  // per-press-run determinism: lot numbers, crookedness, wear all reproduce
  let seed = 0;
  const key = typeName + palette.name;
  for (let i = 0; i < key.length; i++) seed = (seed * 31 + key.charCodeAt(i)) | 0;
  const rand = mulberry32(seed >>> 0);
  const lot = `LOT ${((rand() * 90 + 10) | 0)}-${((rand() * 900 + 100) | 0)} · NEC 1.4G`;

  // aged kraft base
  g.fillStyle = '#dcd0b4';
  g.fillRect(0, 0, W, H);
  // the whole print sits a hair crooked on the paper, like cheap offset work
  g.save();
  g.translate(W / 2, H / 2);
  g.rotate((rand() - 0.5) * 0.02);
  g.translate(-W / 2, -H / 2);

  const starburst = (cx, cy, R, lw = 5) => {
    g.strokeStyle = css(colB, 0.85);
    g.lineWidth = lw;
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const r0 = i % 2 ? R * 0.35 : R * 0.2, r1 = i % 2 ? R : R * 0.62;
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      g.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      g.stroke();
    }
    g.fillStyle = css(colA);
    g.beginPath(); g.arc(cx, cy, R * 0.24, 0, Math.PI * 2); g.fill();
  };
  const finePrint = (x0, x1, y, rows) => {
    g.fillStyle = 'rgba(60,45,25,0.55)';
    for (let r2 = 0; r2 < rows; r2++) {
      for (let x = x0; x < x1; x += 22) g.fillRect(x, y + r2 * 13, 13 + ((x * 7) % 8), 4);
    }
  };
  // brand + caution + lot, shared footer/header voice across every wrapper
  const stamps = (cx, yBrand, yCaution, yLot, scale = 1) => {
    g.textAlign = 'center';
    g.fillStyle = '#7a2f1a';
    g.font = `bold ${(26 * scale) | 0}px Georgia, serif`;
    g.fillText(BRAND, cx, yBrand);
    g.fillStyle = '#4a3517';
    g.font = `bold ${(21 * scale) | 0}px Georgia, serif`;
    g.fillText(CAUTION, cx, yCaution);
    g.font = `${(18 * scale) | 0}px Georgia, serif`;
    g.fillStyle = 'rgba(60,45,25,0.8)';
    g.fillText(lot, cx, yLot);
  };
  const title = (cx, cy, size, maxW) => {
    g.textAlign = 'center';
    g.fillStyle = '#2e2312';
    g.font = `bold ${size}px Georgia, serif`;
    const words = t.label.toUpperCase().split(' ');
    // wrap to two lines when the name runs long (SKY ROCKET fits one)
    if (g.measureText(t.label.toUpperCase()).width > maxW && words.length > 1) {
      const half = Math.ceil(words.length / 2);
      g.fillText(words.slice(0, half).join(' '), cx, cy - size * 0.55, maxW);
      g.fillText(words.slice(half).join(' '), cx, cy + size * 0.65, maxW);
    } else {
      g.fillText(t.label.toUpperCase(), cx, cy, maxW);
    }
  };

  const kind = t.kind;
  if (kind === 'cake') {
    // box art: framed panel, the name in lights, a 3x3 tube chart, hazard tape
    g.fillStyle = css(colA, 0.9);
    g.fillRect(0, 0, W, 118);
    g.fillRect(0, H - 118, W, 118);
    g.fillStyle = '#d8b83a';
    for (let x = -30; x < W; x += 60) { // chevrons
      g.beginPath();
      g.moveTo(x, 0); g.lineTo(x + 30, 0); g.lineTo(x + 60, 34); g.lineTo(x + 30, 34); g.fill();
      g.beginPath();
      g.moveTo(x + 30, H - 34); g.lineTo(x + 60, H - 34); g.lineTo(x + 30, H); g.lineTo(x, H); g.fill();
    }
    g.strokeStyle = '#c9a544';
    g.lineWidth = 8;
    g.strokeRect(36, 160, W - 72, H - 320);
    starburst(W / 2, 400, 150, 8);
    title(W / 2, 620, 64, W - 120);
    g.fillStyle = css(colB, 0.9);
    g.font = 'bold 40px Georgia, serif';
    g.fillText(`${t.shots} SHOTS · FINALE GRADE`, W / 2, 705);
    // the tube chart: nine dots, the firing order a buyer never reads
    g.fillStyle = css(colA, 0.7);
    for (let ix = 0; ix < 3; ix++) {
      for (let iz = 0; iz < 3; iz++) {
        g.beginPath(); g.arc(W / 2 - 70 + ix * 70, 760 + iz * 46, 14, 0, Math.PI * 2); g.fill();
      }
    }
    stamps(W / 2, 145, H - 140, H - 168, 1.15);
    finePrint(70, W - 70, 895, 2);
  } else if (kind === 'candle') {
    // barber-pole: the classic roman candle diagonals, title run vertically
    g.fillStyle = css(colA);
    g.save();
    g.beginPath(); g.rect(0, 90, W, H - 180); g.clip();
    for (let y = -W; y < H + W; y += 108) {
      g.beginPath();
      g.moveTo(0, y); g.lineTo(W, y - W); g.lineTo(W, y - W + 54); g.lineTo(0, y + 54);
      g.fill();
    }
    g.restore();
    g.fillStyle = css(colB, 0.9);
    g.fillRect(0, 90, W, 10);
    g.fillRect(0, H - 100, W, 10);
    // title reads down the tube, twice around so any facing shows it
    g.fillStyle = '#f4ecd8';
    g.font = 'bold 46px Georgia, serif';
    g.textAlign = 'center';
    for (const cx of [W * 0.25, W * 0.75]) {
      g.save();
      g.translate(cx, H / 2);
      g.rotate(Math.PI / 2);
      g.fillText(t.label.toUpperCase(), 0, 16, H - 400);
      g.restore();
    }
    stamps(W / 2, 60, H - 62, H - 30);
    finePrint(60, W - 60, 18, 1);
  } else if (kind === 'belt') {
    // the shipping band around the rolled belt: scarlet, gold lettering
    g.fillStyle = '#a01818';
    g.fillRect(0, 0, W, H);
    g.fillStyle = '#7c0f0f';
    for (let y = 0; y < H; y += 64) g.fillRect(0, y, W, 8);
    g.fillStyle = '#e8b84a';
    g.font = 'bold 88px Georgia, serif';
    g.textAlign = 'center';
    for (const cy of [H * 0.3, H * 0.72]) {
      title(W / 2, cy, 76, W - 60);
    }
    g.fillStyle = '#e8b84a';
    g.font = 'bold 40px Georgia, serif';
    g.fillText(`${t.crackers} CRACKERS`, W / 2, H * 0.5);
    g.fillStyle = '#f4d890';
    g.font = 'bold 24px Georgia, serif';
    g.fillText(BRAND, W / 2, H * 0.5 + 44);
    g.font = 'bold 21px Georgia, serif';
    g.fillText(CAUTION, W / 2, H * 0.5 + 76);
    g.font = '18px Georgia, serif';
    g.fillText(lot, W / 2, H * 0.5 + 104);
  } else if (kind === 'fountain') {
    // cone: bloom rays pouring from the apex, band of type at the base
    g.fillStyle = css(colA, 0.85);
    g.fillRect(0, 0, W, 150);
    g.strokeStyle = css(colB, 0.8);
    g.lineWidth = 7;
    for (let i = 0; i < 22; i++) { // the printed spray
      const a = Math.PI * (0.15 + 0.7 * (i / 21));
      g.beginPath();
      g.moveTo(W / 2, 170);
      g.quadraticCurveTo(
        W / 2 + Math.cos(a) * 190, 320 - Math.sin(a) * 120,
        W / 2 + Math.cos(a) * 260, 470 - Math.sin(a) * 40,
      );
      g.stroke();
    }
    starburst(W / 2, 200, 70, 4);
    g.fillStyle = css(colA);
    g.fillRect(0, 520, W, 130);
    title(W / 2, 600, 52, W - 90);
    stamps(W / 2, 700, 745, 782);
    finePrint(60, W - 60, 830, 3);
    g.fillStyle = css(colB, 0.75);
    g.fillRect(0, H - 60, W, 22);
  } else {
    // rocket wrap (pinwheel drivers borrow it): bands, emblem, name — the
    // fireworks-stand classic, repeated on both faces of the wrap
    g.fillStyle = css(colA);
    g.fillRect(0, 40, W, 190);
    g.fillRect(0, H - 230, W, 190);
    g.fillStyle = css(colA, 0.55);
    for (const y of [40, 226, H - 230, H - 44]) g.fillRect(0, y, W, 10);
    g.fillStyle = '#c9a544';
    g.fillRect(0, 270, W, 10);
    g.fillRect(0, H - 282, W, 10);
    for (const cx of [W * 0.25, W * 0.75]) {
      starburst(cx, 420, 92, 5);
      title(cx, 590, 44, W * 0.44);
      g.textAlign = 'center';
      g.fillStyle = '#7a2f1a';
      g.font = 'bold 22px Georgia, serif';
      g.fillText(BRAND, cx, 680, W * 0.46);
      g.fillStyle = '#4a3517';
      g.font = 'bold 17px Georgia, serif';
      g.fillText(CAUTION, cx, 712, W * 0.46);
      g.font = '15px Georgia, serif';
      g.fillStyle = 'rgba(60,45,25,0.8)';
      g.fillText(lot, cx, 738, W * 0.46);
    }
    g.fillStyle = '#f4ecd8';
    g.font = 'bold 30px Georgia, serif';
    g.textAlign = 'center';
    g.fillText('★ ★ ★', W * 0.25, 145);
    g.fillText('★ ★ ★', W * 0.75, 145);
    finePrint(40, W - 40, 780, 2);
  }
  g.restore();

  // wear: scuffs and a couple of scratches, deterministic per run
  g.fillStyle = 'rgba(30,20,10,0.30)';
  for (let i = 0; i < 9; i++) g.fillRect(0, (rand() * H) | 0, W, 2);
  g.fillStyle = 'rgba(255,250,235,0.20)';
  for (let i = 0; i < 6; i++) g.fillRect((rand() * W) | 0, 0, 2, H);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8; // the print stays legible at grazing wrap angles
  return tex;
}

// Shared paper-grain surface: one procedural normal map (machine-direction
// kraft fibers) and one roughness mottle, tiled by every wrapper material —
// tubes read as lacquered paper under the torch instead of smooth plastic.
let _paperMaps = null;
function paperMaps() {
  if (_paperMaps) return _paperMaps;
  const S = 256;
  const rand = mulberry32(90210);
  // height field: per-column fiber jitter + fine grain, box-blurred once
  const h = new Float32Array(S * S);
  const fiber = new Float32Array(S);
  for (let x = 0; x < S; x++) fiber[x] = rand();
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      h[y * S + x] = fiber[x] * 0.55 + rand() * 0.45;
    }
  }
  const blur = new Float32Array(S * S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let s = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          s += h[((y + dy + S) % S) * S + ((x + dx + S) % S)];
        }
      }
      blur[y * S + x] = s / 9;
    }
  }
  const nc = document.createElement('canvas');
  nc.width = nc.height = S;
  const ng = nc.getContext('2d');
  const nd = ng.createImageData(S, S);
  const AMP = 2.2;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dhx = (blur[y * S + ((x + 1) % S)] - blur[y * S + ((x - 1 + S) % S)]) * AMP;
      const dhy = (blur[((y + 1) % S) * S + x] - blur[((y - 1 + S) % S) * S + x]) * AMP;
      const il = 1 / Math.hypot(dhx, dhy, 1);
      const o = (y * S + x) * 4;
      nd.data[o] = (-dhx * il * 0.5 + 0.5) * 255;
      nd.data[o + 1] = (-dhy * il * 0.5 + 0.5) * 255;
      nd.data[o + 2] = il * 255;
      nd.data[o + 3] = 255;
    }
  }
  ng.putImageData(nd, 0, 0);
  const normal = new THREE.CanvasTexture(nc);
  normal.wrapS = normal.wrapT = THREE.RepeatWrapping;
  normal.repeat.set(3, 6);

  const rc = document.createElement('canvas');
  rc.width = rc.height = S;
  const rg = rc.getContext('2d');
  const rd = rg.createImageData(S, S);
  for (let i = 0; i < S * S; i++) {
    // lacquer mottle: mostly glossy (~0.4) with matte scuffed patches
    const v = (0.40 + (blur[i] - 0.5) * 0.3 + rand() * 0.1) * 255;
    rd.data[i * 4] = rd.data[i * 4 + 1] = rd.data[i * 4 + 2] = v;
    rd.data[i * 4 + 3] = 255;
  }
  rg.putImageData(rd, 0, 0);
  const rough = new THREE.CanvasTexture(rc);
  rough.wrapS = rough.wrapT = THREE.RepeatWrapping;
  rough.repeat.set(3, 6);

  _paperMaps = { normal, rough };
  return _paperMaps;
}

// Parachute canopy for illumination flares: a shallow dome as two crossed
// bowed quads (alpha-tested panel texture) + four shroud lines down to the
// candle. Geometry and texture built once; each flare gets its own tinted
// material (disposed with the flare) and rides the emitter's sway path.
let _canopyGeo = null;
let _canopyTex = null;
let _shroudGeo = null;
const SHROUD_MAT = new THREE.LineBasicMaterial({ color: 0x3a3a40, fog: false });
function makeFlareCanopy(col) {
  if (!_canopyGeo) {
    const quad = new THREE.PlaneGeometry(0.62, 0.30, 6, 1);
    const p = quad.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      p.setZ(i, -x * x * 1.1); // bow the panel into a shallow dome section
    }
    quad.rotateX(-Math.PI / 2);
    const quad2 = quad.clone().rotateY(Math.PI / 2);
    // merge by hand: two quads, one geometry (positions + uv only)
    const g = new THREE.BufferGeometry();
    const pa = quad.attributes, pb = quad2.attributes;
    const join = (name, itemSize) => {
      const a = pa[name].array, b = pb[name].array;
      const out = new Float32Array(a.length + b.length);
      out.set(a); out.set(b, a.length);
      g.setAttribute(name, new THREE.BufferAttribute(out, itemSize));
    };
    join('position', 3);
    join('uv', 2);
    const ia = quad.index.array, ib = quad2.index.array;
    const idx = new Uint16Array(ia.length + ib.length);
    idx.set(ia);
    const off = pa.position.count;
    for (let i = 0; i < ib.length; i++) idx[ia.length + i] = ib[i] + off;
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    _canopyGeo = g;

    const c = document.createElement('canvas');
    c.width = 64; c.height = 32;
    const gg = c.getContext('2d');
    gg.clearRect(0, 0, 64, 32);
    gg.fillStyle = '#e8e2d0';
    gg.beginPath(); // the scalloped arc silhouette of a small chute panel
    gg.moveTo(2, 30);
    gg.quadraticCurveTo(32, -14, 62, 30);
    gg.quadraticCurveTo(47, 24, 32, 29);
    gg.quadraticCurveTo(17, 24, 2, 30);
    gg.closePath(); gg.fill();
    gg.strokeStyle = 'rgba(90,80,60,0.8)'; // panel seams
    gg.lineWidth = 1.5;
    for (const x of [17, 32, 47]) {
      gg.beginPath(); gg.moveTo(x, 30); gg.quadraticCurveTo(x, 8, 32, 2); gg.stroke();
    }
    _canopyTex = new THREE.CanvasTexture(c);
    _canopyTex.colorSpace = THREE.SRGBColorSpace;

    const pts = [];
    for (const [sx, sz] of [[0.26, 0], [-0.26, 0], [0, 0.26], [0, -0.26]]) {
      pts.push(sx, 0.5, sz, 0, -0.06, 0); // rim down to the candle head
    }
    _shroudGeo = new THREE.BufferGeometry();
    _shroudGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3));
  }
  const group = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({
    map: _canopyTex, alphaTest: 0.4, side: THREE.DoubleSide, fog: false,
    color: new THREE.Color(0.55 + col[0] * 0.4, 0.55 + col[1] * 0.4, 0.55 + col[2] * 0.4),
  });
  const dome = new THREE.Mesh(_canopyGeo, mat);
  dome.position.y = 0.5;
  group.add(dome);
  group.add(new THREE.LineSegments(_shroudGeo, SHROUD_MAT));
  group.userData.mat = mat; // per-flare tint — dispose with the flare
  return group;
}

// Soft round bead for fuse tips (shared by every item; sprites carry their
// own materials for per-item opacity, but the texture is one canvas).
let _fuseTipTex = null;
function fuseTipTexture() {
  if (_fuseTipTex) return _fuseTipTex;
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.4, 'rgba(255,255,255,0.5)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 32);
  _fuseTipTex = new THREE.CanvasTexture(c);
  return _fuseTipTex;
}

const GEO_CACHE = {};
function cachedGeo(key, make) {
  if (!GEO_CACHE[key]) GEO_CACHE[key] = make();
  return GEO_CACHE[key];
}

// The restocker spawns items forever; per-item textures/materials would be an
// unbounded GPU leak, so everything visual is cached — noses per palette
// (12 entries), wrappers per (type, palette), generated lazily on the first
// item of each combination.
const MAT_CACHE = {};
function paletteMats(palette) {
  let m = MAT_CACHE[palette.name];
  if (!m) {
    m = {
      // metallic-paint nose cone: catches the moon and every burst
      nose: new THREE.MeshStandardMaterial({
        color: palette.b, roughness: 0.28, metalness: 0.6, envMapIntensity: 0.9,
      }),
    };
    MAT_CACHE[palette.name] = m;
  }
  return m;
}

// Wrapper cache, bounded: 9 types x 12 palettes could otherwise pin ~100
// 512x1024 canvases in VRAM over a long night. Entries carry a refcount
// (_buildMesh acquires, removeItem releases); past the cap, the oldest
// unreferenced wrapper is disposed and will simply regenerate if that
// combination ever comes off the press again.
const LABEL_CACHE = new Map();
const LABEL_CACHE_MAX = 36;
function labelMat(typeName, palette) {
  const key = `${typeName}|${palette.name}`;
  let m = LABEL_CACHE.get(key);
  if (!m) {
    if (LABEL_CACHE.size >= LABEL_CACHE_MAX) {
      for (const [k, old] of LABEL_CACHE) {
        if ((old.userData.refs ?? 0) <= 0) {
          old.map?.dispose(); // per-entry canvas; paper grain maps are shared
          old.dispose();
          LABEL_CACHE.delete(k);
          break;
        }
      }
    }
    const paper = paperMaps();
    // lacquered printed wrapper — sheen + fiber grain is what reads
    // "store-bought firework" instead of "painted cylinder"
    m = new THREE.MeshStandardMaterial({
      map: labelTexture(typeName, palette),
      normalMap: paper.normal,
      normalScale: new THREE.Vector2(0.4, 0.4),
      roughnessMap: paper.rough,
      roughness: 1.0, // the map carries the actual value
      metalness: 0, envMapIntensity: 0.75,
      emissive: new THREE.Color(palette.a).multiplyScalar(0.14),
    });
    m.userData.refs = 0;
    LABEL_CACHE.set(key, m);
  }
  return m;
}
const WOOD_ITEM_MAT = new THREE.MeshStandardMaterial({ color: 0x9c8a6a, roughness: 0.8 });
const TUBE_MAT = new THREE.MeshStandardMaterial({ color: 0x443830, roughness: 0.85 });
const CHAR_MAT = new THREE.MeshStandardMaterial({ color: 0x2c241c, roughness: 0.98 });
// physical odds and ends every stand-bought piece carries
const CLAY_MAT = new THREE.MeshStandardMaterial({ color: 0xa06a48, roughness: 0.92 });
const TAPE_MAT = new THREE.MeshStandardMaterial({ color: 0xc9b98e, roughness: 0.55, envMapIntensity: 0.6 });
// visco fuse: green-braided cord, and the charred remnant behind the front.
// The tip carries a faint pale emissive so an unlit fuse is findable by
// moonlight (the glow sprite on top does the burning).
const FUSE_MAT = new THREE.MeshStandardMaterial({ color: 0x46523a, roughness: 0.9 });
const FUSE_CHAR_MAT = new THREE.MeshStandardMaterial({ color: 0x16120e, roughness: 1.0 });
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
    const wrapMat = labelMat(this.typeName, this.palette);
    wrapMat.userData.refs = (wrapMat.userData.refs ?? 0) + 1;
    this.wrapMat = wrapMat; // released in removeItem
    // per-instance identity: spin the wrap seam so two same-palette pieces
    // from the crate never present byte-identical faces (free — shared
    // geometry + material, only the mesh's rotation differs)
    const seamSpin = Math.random() * Math.PI * 2;

    if (t.kind === 'rocket') {
      const stick = new THREE.Mesh(
        cachedGeo(`stick`, () => new THREE.CylinderGeometry(0.004, 0.004, 1, 8)),
        woodMat,
      );
      stick.scale.y = t.stickLen;
      stick.position.y = t.stickLen / 2;
      root.add(stick);

      const body = new THREE.Mesh(
        cachedGeo('body', () => new THREE.CylinderGeometry(1, 1, 1, 16)),
        wrapMat,
      );
      body.scale.set(t.bodyR, t.bodyLen, t.bodyR);
      body.position.y = t.stickLen - t.bodyLen / 2;
      body.rotation.y = seamSpin;
      root.add(body);

      const nose = new THREE.Mesh(
        cachedGeo('nose', () => new THREE.ConeGeometry(1, 1, 16)),
        paletteMats(this.palette).nose,
      );
      nose.scale.set(t.bodyR, t.bodyR * 2.4, t.bodyR);
      nose.position.y = t.stickLen + t.bodyR * 1.2;
      root.add(nose);

      // seam line where the nose cap presses over the wrap
      const seam = new THREE.Mesh(
        cachedGeo('noseseam', () => new THREE.CylinderGeometry(1.015, 1.015, 1, 16, 1, true)),
        CHAR_MAT,
      );
      seam.scale.set(t.bodyR, 0.004, t.bodyR);
      seam.position.y = t.stickLen - 0.003;
      root.add(seam);

      // clay nozzle ring at the motor base — the bit that actually throats
      // the burn on a real black-powder motor
      const nozzle = new THREE.Mesh(
        cachedGeo('claynozzle', () => new THREE.CylinderGeometry(0.86, 1.0, 1, 16, 1, true)),
        CLAY_MAT,
      );
      nozzle.scale.set(t.bodyR * 0.98, t.bodyR * 0.55, t.bodyR * 0.98);
      nozzle.position.y = t.stickLen - t.bodyLen - t.bodyR * 0.1;
      root.add(nozzle);

      // two tape wraps binding the guide stick to the tube
      const tapeGeo = cachedGeo('tape', () => new THREE.CylinderGeometry(1.03, 1.03, 1, 16, 1, true));
      for (const f of [0.16, 0.78]) {
        const tape = new THREE.Mesh(tapeGeo, TAPE_MAT);
        tape.scale.set(t.bodyR, 0.008, t.bodyR);
        tape.position.y = t.stickLen - t.bodyLen + t.bodyLen * f;
        tape.rotation.y = seamSpin * 1.7;
        root.add(tape);
      }

      this.grabY = t.stickLen - t.bodyLen / 2; // hold at the body
      this.grabTop = t.stickLen + t.bodyR * 2.4; // grabbable anywhere on the stick
      this.fuseBase = new THREE.Vector3(t.bodyR + 0.006, t.stickLen - t.bodyLen, 0);
      this.fuseTip = new THREE.Vector3(t.bodyR + 0.012, t.stickLen - t.bodyLen - 0.035, 0);
    } else if (t.kind === 'fountain') {
      const cone = new THREE.Mesh(
        cachedGeo('fcone', () => new THREE.CylinderGeometry(0.35, 1, 1, 16)),
        wrapMat,
      );
      cone.scale.set(t.baseR, t.height, t.baseR);
      cone.position.y = t.height / 2;
      cone.rotation.y = seamSpin;
      root.add(cone);
      this.coneMesh = cone; // burn-down shader hooks on while erupting
      // wooden base plate so it sits on the sand like the store sold it
      const plate = new THREE.Mesh(
        cachedGeo('fplate', () => new THREE.CylinderGeometry(1, 1.06, 1, 16)),
        woodMat,
      );
      plate.scale.set(t.baseR * 1.18, 0.012, t.baseR * 1.18);
      plate.position.y = 0.006;
      root.add(plate);
      this.grabY = t.height / 2;
      this.grabTop = t.height;
      this.fuseBase = new THREE.Vector3(0, t.height, 0);
      this.fuseTip = new THREE.Vector3(0.012, t.height + 0.045, 0);
      this.nozzleY = t.height;
    } else if (t.kind === 'pinwheel') {
      // a wheel of rocket drivers nailed to a stake: the stake runs up local
      // +Y, the wheel hangs just in front of it and spins around local Z
      const stake = new THREE.Mesh(
        cachedGeo('pwstake', () => new THREE.CylinderGeometry(0.008, 0.011, 1, 8)),
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
          const g = new THREE.TorusGeometry(1, 0.055, 8, 28);
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
        const driver = new THREE.Mesh(driverGeo, wrapMat);
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
        cachedGeo('ctube', () => new THREE.CylinderGeometry(1, 1, 1, 16)),
        wrapMat,
      );
      tube.scale.set(t.bodyR, t.bodyLen, t.bodyR);
      tube.position.y = t.bodyLen / 2;
      tube.rotation.y = seamSpin;
      root.add(tube);
      // char band: a sleeve that creeps down the tube one shot at a time
      // (scaled to zero until the first shot chars it)
      const sleeve = new THREE.Mesh(
        cachedGeo('charsleeve', () => new THREE.CylinderGeometry(1.025, 1.025, 1, 16, 1, true)),
        CHAR_MAT,
      );
      sleeve.scale.set(t.bodyR, 0.0001, t.bodyR);
      sleeve.position.y = t.bodyLen;
      root.add(sleeve);
      this.charSleeve = sleeve;
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

      // shipping band around the flat roll — rips away the moment the coil
      // unfreezes (grabbed or lit), like the paper it is
      const band = new THREE.Mesh(
        cachedGeo('beltband', () => new THREE.CylinderGeometry(1, 1, 1, 16, 1, true)),
        wrapMat,
      );
      band.scale.set(0.081, 0.034, 0.081);
      band.position.y = 0.024;
      band.rotation.y = seamSpin;
      root.add(band);
      this.beltBand = band;

      this.grabY = 0.02; // reach is per-rope-point — see grabDistance in input.js
      this.fuseBase = new THREE.Vector3();       // both repositioned every
      this.fuseTip = new THREE.Vector3(0, -0.045, 0); // frame to the strand's far end
      this._initCoil();
    } else if (t.kind === 'cake') {
      const box = new THREE.Mesh(
        cachedGeo('cakebox', () => new THREE.BoxGeometry(1, 1, 1)),
        wrapMat,
      );
      box.scale.set(t.boxW, t.boxH, t.boxW);
      box.position.y = t.boxH / 2;
      root.add(box);
      const tubeGeo = cachedGeo('caketube', () => new THREE.CylinderGeometry(0.016, 0.016, 0.05, 8));
      const tubeMat = TUBE_MAT;
      // keep the meshes indexed: _cakeShot fires from these REAL tubes in a
      // scrambled-but-fixed order and chars each rim as it goes
      this.cakeTubes = [];
      for (let ix = -1; ix <= 1; ix++) {
        for (let iz = -1; iz <= 1; iz++) {
          const tube = new THREE.Mesh(tubeGeo, tubeMat);
          tube.position.set(ix * 0.055, t.boxH + 0.02, iz * 0.055);
          root.add(tube);
          this.cakeTubes.push(tube);
        }
      }
      this.grabY = t.boxH / 2;
      this.grabTop = t.boxH;
      this.fuseBase = new THREE.Vector3(t.boxW / 2, t.boxH * 0.6, 0);
      this.fuseTip = new THREE.Vector3(t.boxW / 2 + 0.04, t.boxH * 0.35, 0);
      this.nozzleY = t.boxH + 0.045;
    }

    // items throw moon shadows like everything else on the sand — and catch
    // each other's (a rocket shades the crate straw it leans on)
    root.traverse((o) => {
      if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
    });

    // the fuse cord: a real braided tube (1-px lines vanish at fuse-lighting
    // distance, which is exactly where you stare at it). Two pieces sharing
    // cached unit geometry: live cord base->burn front, charred remnant
    // burn front->tip. Both are restretched every frame by _updateFuse.
    this.fuseLive = new THREE.Mesh(
      cachedGeo('fusetube', () => new THREE.TubeGeometry(
        new THREE.CatmullRomCurve3([
          new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.004, 0.33, 0.002),
          new THREE.Vector3(0.005, 0.66, -0.002), new THREE.Vector3(0, 1, 0),
        ]), 7, 0.0016, 6, false)),
      FUSE_MAT,
    );
    this.fuseChar = new THREE.Mesh(
      cachedGeo('fusechartube', () => new THREE.TubeGeometry(
        new THREE.CatmullRomCurve3([
          new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.006, 0.4, 0.003),
          new THREE.Vector3(0.002, 0.75, -0.004), new THREE.Vector3(-0.004, 1, 0),
        ]), 7, 0.001, 6, false)),
      FUSE_CHAR_MAT,
    );
    this.fuseLive.castShadow = false;
    this.fuseChar.castShadow = false;
    root.add(this.fuseLive, this.fuseChar);

    // where fuse sparks live (moves toward fuseBase as it burns)
    this.fuseAnchor = new THREE.Object3D();
    this.fuseAnchor.position.copy(this.fuseTip);
    root.add(this.fuseAnchor);

    // the tip bead: pale so an unlit fuse is findable by moonlight, blooming
    // hot while burning, and warming under a hovering torch flame (fuseGlow)
    this.fuseTipSprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: fuseTipTexture(), transparent: true, opacity: 0.14, depthWrite: false,
      blending: THREE.AdditiveBlending, color: 0xd8d2b8, fog: false,
    }));
    this.fuseTipSprite.scale.setScalar(0.014);
    this.fuseAnchor.add(this.fuseTipSprite);
    this._updateFuse();
  }

  // One fuse segment: stretch `mesh` from `from` to `to` along its local +Y.
  _fuseSeg(mesh, from, to, hidden) {
    _fv1.subVectors(to, from);
    const len = _fv1.length();
    if (len < 0.004 || hidden) { mesh.visible = false; return; }
    mesh.visible = true;
    mesh.position.copy(from);
    mesh.quaternion.setFromUnitVectors(UP, _fv1.multiplyScalar(1 / len));
    mesh.scale.y = len;
  }

  // Stretch the live/char fuse tubes between base, burn front and tip, and
  // run the tip bead's glow state. Pure local-space math, no allocations.
  _updateFuse() {
    const anchor = this.fuseAnchor.position;
    const hidden = !!this.beltPts && (this.state === 'active' || this.state === 'spent');
    this._fuseSeg(this.fuseLive, this.fuseBase, anchor, hidden);
    this._fuseSeg(this.fuseChar, anchor, this.fuseTip, hidden);
    const tip = this.fuseTipSprite;
    if (hidden) { tip.visible = false; return; }
    tip.visible = true;
    const glow = clamp(this.fuseGlow ?? 0, 0, 1);
    if (this.fuseRemaining > 0) {
      // burning: hot orange bead, sputter-flickering
      tip.material.color.setHex(0xffb050);
      tip.material.opacity = 0.75 + Math.random() * 0.25;
      tip.scale.setScalar(0.022 + Math.random() * 0.012);
    } else if (glow > 0.01) {
      // torch hovering: the 'almost lit' warm-up must be visible
      tip.material.color.setHex(0xffc878);
      tip.material.opacity = 0.14 + glow * 0.7;
      tip.scale.setScalar(0.014 + glow * 0.012);
    } else {
      tip.material.color.setHex(0xd8d2b8);
      tip.material.opacity = 0.14;
      tip.scale.setScalar(0.014);
    }
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
    // the shipping band exists only while the roll is still a roll
    if (this.beltBand) this.beltBand.visible = this.beltFrozen;

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
    // a burning fuse really lights the tube and the hand around it
    sys.fuseLights?.acquire(this);
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
      // sputtering sparks off the burn front
      const p = this.fuseWorldPos(_v1);
      sys.spawnFuseSparks(this, p, time, dt);
      this.sounds.fuse?.setPosition(p);
      if (this.fuseRemaining <= 0) {
        this.sounds.fuse?.stop();
        delete this.sounds.fuse;
        sys.activate(this);
      }
    } else if ((this.fuseGlow ?? 0) > 0.01 && this.state !== 'active' && this.state !== 'spent') {
      // torch hovering at the tip: a couple of anticipation sparks before it
      // actually catches — the 'almost lit' state must be visible
      sys.spawnFuseGlowSparks(this, this.fuseWorldPos(_v1), time, dt, this.fuseGlow);
    }
    // fuseGlow is fed by the torch hand each frame; fade it ourselves so a
    // withdrawn torch doesn't leave a tip warmed forever
    if (this.fuseGlow) this.fuseGlow = Math.max(0, this.fuseGlow - dt * 4);
    this._updateFuse();

    // stale throw state can't survive a plant or a re-grab: the integrator
    // only ever owns an item that is actually loose in the air
    if (this.vel && (this.holder || this.state === 'planted' || this.state === 'idle' || this.state === 'held')) {
      this.vel = null;
      this.angVel = null;
      this._bounced = this._grounded = false;
      this._settle = null;
    }

    // thrown/dropped flight (belts drape themselves — the rope owns motion):
    // full 3D tumble when the release handed over a velocity (input sets
    // item.vel/item.angVel — see the hand-off contract); the legacy straight
    // drop when it didn't
    if (!this.beltPts && !this.holder
      && (this.state === 'lying' || this.state === 'active' || this.state === 'spent')) {
      if (this.vel) {
        this._integrateFlight(dt, time);
      } else if (this.fallVel !== 0) {
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

  /**
   * Thrown-item flight: ballistic + light quadratic drag + tumble, one soft
   * bounce off the sand with tangential friction, then an eased settle to a
   * natural rest pose grown out of the impact orientation. A lit item burns
   * straight through all of it — its emitters read the root every frame, so
   * a thrown erupting fountain sprays all along its arc (and keeps spraying
   * however it lands; hard landings never extinguish anything).
   */
  _integrateFlight(dt, time) {
    const sys = this.system;
    const v = this.vel;

    if (this._settle) {
      // easing to rest from the impact orientation
      const s = this._settle;
      s.t += dt;
      const k = Math.min(1, dt * 7);
      this.root.quaternion.slerp(s.q, k);
      const gy = sys.groundHeight(this.root.position.x, this.root.position.z) + 0.02;
      this.root.position.y += (gy - this.root.position.y) * Math.min(1, dt * 9);
      if (s.t > 0.55) {
        this.root.quaternion.copy(s.q);
        this.root.position.y = gy;
        this.vel = null;
        this.angVel = null;
        this._settle = null;
        this._bounced = this._grounded = false;
        this.fallVel = 0;
      }
      return;
    }

    // air phase
    v.y -= 9.81 * dt;
    const sp = v.length();
    v.multiplyScalar(1 / (1 + ITEM_DRAG_K * sp * dt));
    this.root.position.addScaledVector(v, dt);
    if (this.angVel) {
      const w = this.angVel.length();
      if (w > 1e-4) {
        _fq.setFromAxisAngle(_fv1.copy(this.angVel).multiplyScalar(1 / w), w * dt);
        this.root.quaternion.premultiply(_fq);
        this.angVel.multiplyScalar(Math.max(0, 1 - 0.55 * dt)); // spin bleeds off in air
      }
    }

    // ground contact: test the item's axis ends (base sits at the root, the
    // far end grabTop up the local axis) so a tumbling tube touches down on
    // whichever end actually arrives first
    const base = this.root.position;
    this.axis(_fv2);
    _fv3.copy(base).addScaledVector(_fv2, this.grabTop ?? 0.1);
    const penBase = sys.groundHeight(base.x, base.z) + 0.015 - base.y;
    const penTip = sys.groundHeight(_fv3.x, _fv3.z) + 0.015 - _fv3.y;
    const pen = Math.max(penBase, penTip);
    if (pen > 0) {
      base.y += pen;
      const n = sys._groundNormal(base.x, base.z, _fv2);
      const vn = v.dot(n);
      const impact = -vn;
      if (vn < 0) {
        if (!this._bounced && impact > 1.4) {
          // the one bounce: soft restitution, most of the slide ground away
          this._bounced = true;
          v.addScaledVector(n, -(1 + ITEM_RESTITUTION) * vn);
          const kn = v.dot(n);
          _fv3.copy(n).multiplyScalar(kn);
          v.sub(_fv3).multiplyScalar(ITEM_FRICTION).add(_fv3);
          // skid torque: the hit converts travel into tumble
          if (!this.angVel) this.angVel = new THREE.Vector3();
          _fv1.crossVectors(n, v);
          if (_fv1.lengthSq() > 1e-4) {
            this.angVel.addScaledVector(_fv1.normalize(), Math.min(6, impact * 0.8));
          }
        } else {
          // down for good: grind out whatever motion is left
          v.addScaledVector(n, -vn);
          v.multiplyScalar(Math.max(0, 1 - 7 * dt));
          this.angVel?.multiplyScalar(Math.max(0, 1 - 7 * dt));
          this._grounded = true;
        }
        // landing thud weighted by how hard it came in
        if (impact > 0.9 && time - (this._thudT ?? -9) > 0.22) {
          this._thudT = time;
          sys.audio.play('thud', base, {
            gain: clamp(0.25 + impact * 0.11, 0.3, 1.1),
            refDistance: 1.5, rate: randRange(0.92, 1.12),
          });
          if (impact > 3.2) {
            sys._groundSplash(base, _c1.set(0xc9a06a), Math.min(1.1, impact / 9));
          }
        }
      }
    }

    // slow and grounded: pick the rest pose and ease into it
    if (this._grounded && v.lengthSq() < 0.09
      && (!this.angVel || this.angVel.lengthSq() < 0.5)) {
      if (this.state === 'active') {
        // an erupting piece stays exactly as it landed — a fountain on its
        // side hosing sparks across the sand is the whole reward
        this.vel = null;
        this.angVel = null;
        this._bounced = this._grounded = false;
        this.fallVel = 0;
        return;
      }
      const axis = this.axis(_fv1);
      const kind = this.type.kind;
      _fq.copy(this.root.quaternion);
      if ((kind === 'fountain' || kind === 'cake') && axis.y > 0.75) {
        // flat-bottomed piece that came down near-upright: rock upright
        _fv2.copy(axis);
        _fq.setFromUnitVectors(_fv2, UP).multiply(this.root.quaternion);
      } else {
        // everything else keels over along whichever way it was already
        // leaning (or sliding), and lies there
        _fv2.set(axis.x, 0, axis.z);
        if (_fv2.lengthSq() < 0.003) _fv2.set(v.x, 0, v.z);
        if (_fv2.lengthSq() < 0.003) _fv2.set(Math.random() - 0.5, 0, Math.random() - 0.5);
        _fq.setFromUnitVectors(UP, _fv2.normalize());
      }
      this._settle = { q: _fq.clone(), t: 0 };
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
    this.debris = [];    // tumbling charred sticks etc. (capped, FIFO)
    this.time = 0;
    // shell flashes get depth (8 lights / 10 sprites, weakest-evicted);
    // muzzle-class pops (lifts, candle/cake shots, belt crackers) live in
    // their own tiny pool so they can never evict a grand shell's afterglow
    this.flashes = new FlashPool(scene, 8);
    this.utilFlashes = new FlashPool(scene, 2);
    this.flashSprites = new FlashSprites(scene, 10, pool.atlas);
    this.fuseLights = new FuseLightPool(scene, 4);
    this.onBoom = null; // hook for haptics: (pos, size) => {}
    this._riserT = -9;    // throttle: risers thin out during walls
    this._padShots = 0;   // every ~4th ground launch feeds the pad haze

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

    // spent-belt confetti: torn red paper scraps left on the sand. One
    // shared instanced mesh for the whole desert, 64 scraps FIFO — old ones
    // quietly vanish under new belts, nothing ever allocates mid-session.
    {
      const c = document.createElement('canvas');
      c.width = c.height = 32;
      const g = c.getContext('2d');
      g.clearRect(0, 0, 32, 32);
      g.fillStyle = '#b42222';
      g.beginPath(); // a ragged little polygon of cracker paper
      g.moveTo(6, 2); g.lineTo(26, 5); g.lineTo(30, 18); g.lineTo(22, 29);
      g.lineTo(8, 27); g.lineTo(2, 14);
      g.closePath(); g.fill();
      g.fillStyle = '#7c1010';
      g.fillRect(6, 12, 20, 3);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      const mesh = new THREE.InstancedMesh(
        new THREE.PlaneGeometry(0.028, 0.02),
        new THREE.MeshStandardMaterial({
          map: tex, alphaTest: 0.5, side: THREE.DoubleSide,
          roughness: 0.8, emissive: 0x30060a,
        }),
        64,
      );
      _bm.makeScale(0, 0, 0);
      for (let i = 0; i < 64; i++) {
        mesh.setMatrixAt(i, _bm);
        _c1.setHSL(0.995 + Math.random() * 0.015, 0.85, 0.4 + Math.random() * 0.2);
        mesh.setColorAt(i, _c1);
      }
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      scene.add(mesh);
      this.scrapMesh = mesh;
      this._scrapCursor = 0;
    }
  }

  // Lay one paper scrap flat on the sand (spent-belt litter).
  _dropScrap(x, z) {
    const mesh = this.scrapMesh;
    const i = this._scrapCursor;
    this._scrapCursor = (this._scrapCursor + 1) % 64;
    const y = this.groundHeight(x, z) + 0.006;
    this._groundNormal(x, z, _bn);
    _bq.setFromUnitVectors(_bt.set(0, 0, 1), _bn); // plane faces up the slope normal
    _fq.setFromAxisAngle(_bn, Math.random() * Math.PI * 2);
    _bq.premultiply(_fq);
    _bm.compose(_bp.set(x, y, z), _bq, _bs.setScalar(randRange(0.8, 1.4)));
    mesh.setMatrixAt(i, _bm);
    mesh.instanceMatrix.needsUpdate = true;
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
    this.fuseLights.release(item);
    item.fuseTipSprite?.material.dispose(); // per-item (opacity varies); texture is shared
    if (item.wrapMat) item.wrapMat.userData.refs = Math.max(0, (item.wrapMat.userData.refs ?? 1) - 1);
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
    // fuse burned down: the tube owns the light now
    this.fuseLights.release(item);
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
    // gunpowder smoke builds along the belt as it rips, rolling downwind
    if (item.beltConsumed % 3 === 0) {
      const wdx = WIND.x * 0.45, wdz = WIND.z * 0.45;
      pool.spawn(2, (i) => {
        pool.set(i,
          px, py + 0.04, pz,
          randRange(-0.3, 0.3) + wdx, randRange(0.25, 0.6), randRange(-0.3, 0.3) + wdz,
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
    // occasional visible flash on the surroundings (muzzle-class — the
    // utility pool, so a ripping belt can't strip a shell's afterglow)
    if (Math.random() < 0.12) this.utilFlashes.flash(pos, 0xffd9a8, 5 + Math.random() * 7, 0.05);
  }

  _spendBelt(item) {
    if (!this.items.has(item)) return;
    item.state = 'spent';
    item.extinguishSounds();
    // nothing left but the charred braid cord on the sand...
    item.cordLine.material = BELT_CORD_CHAR_MAT;
    // ...plus torn paper and a scorch trail where the rip ran the cord
    const scraps = 3 + ((Math.random() * 3) | 0);
    for (let s = 0; s < scraps; s++) {
      const p = item.beltPointAt(Math.random(), _v1);
      this._dropScrap(p.x + randRange(-0.06, 0.06), p.z + randRange(-0.06, 0.06));
    }
    for (let s = 0; s < 4; s++) {
      const p = item.beltPointAt((s + 0.5) / 4, _v1);
      this.groundMark?.(p.x, p.z, randRange(0.08, 0.14), 0.35);
    }
    this.audio.play('rustle', item.beltPointAt(0.5, _v1), { gain: 0.5, refDistance: 1.2 });
    // give the rope a moment to settle, then stop simulating it entirely;
    // the charred cord stays as evidence for a good while
    this.schedule(3, () => { item.beltStatic = true; });
    this.schedule(45, () => this.removeItem(item));
  }

  _launchRocket(item) {
    item.state = 'active';
    item.fallVel = 0;   // flight integrator owns the motion now
    item.vel = null;    // ...including over any throw the hand handed off
    item.angVel = null;
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

  // A charred guide stick tumbling out of a big rocket's break. Debris is
  // capped FIFO — a long finale can't accumulate scene nodes — and every
  // stick shares the cached geometry + CHAR_MAT (nothing to dispose).
  _dropStick(pos, vel, stickLen) {
    if (this.debris.length >= 8) {
      const old = this.debris.shift();
      old.mesh.removeFromParent();
    }
    const mesh = new THREE.Mesh(
      cachedGeo('stick', () => new THREE.CylinderGeometry(0.004, 0.004, 1, 8)),
      CHAR_MAT,
    );
    mesh.scale.y = stickLen;
    mesh.position.copy(pos);
    this.debris.push({
      mesh,
      vel: new THREE.Vector3(vel.x * 0.3 + randRange(-2, 2), randRange(-1, 1), vel.z * 0.3 + randRange(-2, 2)),
      angVel: new THREE.Vector3(randRange(-9, 9), randRange(-3, 3), randRange(-9, 9)),
      rest: false, t: 0,
    });
    this.scene.add(mesh);
  }

  _updateDebris(dt) {
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i];
      d.t += dt;
      if (d.t > 60) { // long enough that the sand remembers the show
        d.mesh.removeFromParent();
        this.debris.splice(i, 1);
        continue;
      }
      if (d.rest) continue;
      d.vel.y -= 9.81 * dt;
      d.vel.multiplyScalar(1 / (1 + 0.10 * d.vel.length() * dt)); // sticks flutter
      d.mesh.position.addScaledVector(d.vel, dt);
      const w = d.angVel.length();
      if (w > 1e-4) {
        _fq.setFromAxisAngle(_fv1.copy(d.angVel).multiplyScalar(1 / w), w * dt);
        d.mesh.quaternion.premultiply(_fq);
      }
      const p = d.mesh.position;
      const gy = this.groundHeight(p.x, p.z);
      if (p.y <= gy + 0.015) {
        p.y = gy + 0.015;
        // one dead-stick thud, then lie flat along the current heading
        this.audio.play('thud', p, { gain: 0.35, refDistance: 2, rate: randRange(1.2, 1.5) });
        _fv2.set(0, 1, 0).applyQuaternion(d.mesh.quaternion);
        _fv1.set(_fv2.x, 0, _fv2.z);
        if (_fv1.lengthSq() < 0.01) _fv1.set(Math.random() - 0.5, 0, Math.random() - 0.5);
        d.mesh.quaternion.setFromUnitVectors(UP, _fv1.normalize());
        d.rest = true;
      }
    }
  }

  // The blast of grit and the rolling dust cloud a motor kicks off the pad —
  // the sheet hugs the local dune face (ground normal), not world-XZ, so a
  // launch off a slope blows its dust down the slope. Scorches the sand.
  _padDust(pos, size) {
    const pool = this.pool;
    const time = this.time;
    pos.y = this.groundHeight(pos.x, pos.z);
    this.groundMark?.(pos.x, pos.z, 0.28 + 0.3 * size, 0.45);
    // slope basis: u/w span the ground plane, n lifts off it
    const n = this._groundNormal(pos.x, pos.z, _fv1);
    const u = _fv2.crossVectors(n, Math.abs(n.x) < 0.9 ? X_AXIS : UP).normalize();
    const w = _fv3.crossVectors(n, u).normalize();
    const nx = n.x, ny = n.y, nz = n.z;
    const ux2 = u.x, uy2 = u.y, uz2 = u.z;
    const wx2 = w.x, wy2 = w.y, wz2 = w.z;
    // sharp radial sand kick, sprayed in the ground plane
    pool.spawn(24 + Math.round(20 * size), (i) => {
      const a = Math.random() * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      const sp = randRange(1.5, 4.2) * (0.6 + size);
      const lift = randRange(0.4, 1.6);
      pool.set(i,
        pos.x + (ux2 * ca + wx2 * sa) * 0.05, pos.y + 0.04, pos.z + (uz2 * ca + wz2 * sa) * 0.05,
        (ux2 * ca + wx2 * sa) * sp + nx * lift,
        (uy2 * ca + wy2 * sa) * sp + ny * lift,
        (uz2 * ca + wz2 * sa) * sp + nz * lift,
        0.85, 0.62, 0.34,
        time, randRange(0.4, 0.9),
        randRange(0.02, 0.05), 1.3, 2.6, 0);
    });
    // billowing dust that hangs around the pad and rides the night's wind
    const wdx = WIND.x * 0.6, wdz = WIND.z * 0.6;
    pool.spawn(9 + Math.round(8 * size), (i) => {
      const a = Math.random() * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      const sp = randRange(0.5, 1.5) * (0.6 + size);
      const lift = randRange(0.25, 0.8);
      pool.set(i,
        pos.x, pos.y + 0.15, pos.z,
        (ux2 * ca + wx2 * sa) * sp + nx * lift + wdx,
        (uy2 * ca + wy2 * sa) * sp + ny * lift,
        (uz2 * ca + wz2 * sa) * sp + nz * lift + wdz,
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
    // burn-down: the cone chars from the nozzle toward the base over the
    // run. The shared wrapper material is cloned ONLY while erupting (and
    // disposed at the end); the constant program cache key means every
    // burning fountain ever shares one compiled shader variant.
    let uBurn = null, burnMat = null;
    if (item.coneMesh) {
      uBurn = { value: 0 };
      burnMat = item.coneMesh.material.clone();
      burnMat.onBeforeCompile = (sh) => {
        sh.uniforms.uBurn = uBurn;
        sh.vertexShader = 'varying float vBurnY;\n' + sh.vertexShader.replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\n\tvBurnY = position.y;',
        );
        sh.fragmentShader = 'varying float vBurnY;\nuniform float uBurn;\nfloat burnK;\n'
          + sh.fragmentShader
            .replace('#include <color_fragment>',
              '#include <color_fragment>\n'
              + '\t// char front sweeps from the nozzle (local y +0.5) down the cone\n'
              + '\tfloat burnEdge = 0.5 - uBurn * 1.12;\n'
              + '\tburnK = smoothstep(burnEdge - 0.1, burnEdge + 0.04, vBurnY);\n'
              + '\tdiffuseColor.rgb *= mix(1.0, 0.1, burnK);')
            .replace('#include <emissivemap_fragment>',
              '#include <emissivemap_fragment>\n'
              + '\ttotalEmissiveRadiance *= mix(1.0, 0.04, burnK);');
      };
      burnMat.customProgramCacheKey = () => 'fountain-burn';
      item.coneMesh.material = burnMat;
    }
    this.emitters.push({
      kind: 'fountain', item, age: 0, duration: t.duration, sound,
      phase: Math.random() * 7, uBurn, burnMat,
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
    this.utilFlashes.flash(muzzle, item.palette.a, 35, 0.14);
    // each shot chars the tube a little further down from the mouth
    if (item.charSleeve) {
      const frac = (index + 1) / item.type.shots;
      const len = item.type.bodyLen * frac * 0.92;
      item.charSleeve.scale.y = Math.max(0.002, len);
      item.charSleeve.position.y = item.type.bodyLen - len / 2;
    }

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
    // fire from the REAL tubes, dancing around the 3x3 grid in a fixed
    // scramble so successive shots come from different corners of the box
    const tube = item.cakeTubes?.[CAKE_FIRE_ORDER[index % 9]];
    const muzzle = tube
      ? new THREE.Vector3(tube.position.x, item.nozzleY, tube.position.z)
      : new THREE.Vector3(randRange(-0.05, 0.05), item.nozzleY, randRange(-0.05, 0.05));
    item.root.localToWorld(muzzle);
    if (tube) tube.material = CHAR_MAT; // the rim blackens the moment it fires
    const dir = item.axis(new THREE.Vector3());
    // slight per-shot spread
    dir.x += randRange(-0.09, 0.09);
    dir.z += randRange(-0.09, 0.09);
    dir.normalize();

    this.audio.play('lift', muzzle, { gain: 1.2, refDistance: 4, send: 0.4, rate: randRange(0.9, 1.1) });
    this.utilFlashes.flash(muzzle, 0xffc890, 55, 0.16);
    // muzzle smoke curling off the fired tube
    {
      const pool = this.pool;
      const time = this.time;
      const mx = muzzle.x, my = muzzle.y, mz = muzzle.z;
      const wdx = WIND.x * 0.5, wdz = WIND.z * 0.5;
      pool.spawn(2, (i) => {
        pool.set(i,
          mx, my + 0.02, mz,
          randRange(-0.15, 0.15) + wdx, randRange(0.3, 0.7), randRange(-0.15, 0.15) + wdz,
          0.4, 0.4, 0.44,
          time, randRange(1.6, 3.0),
          randRange(0.14, 0.24), -0.02, 1.6, -1);
      });
    }

    // real mortar pacing: the star streaks upward for a couple of seconds,
    // goes quiet near apex, THEN breaks — bursts land 50-70 m up
    const speed = isFinale ? randRange(48, 56) : randRange(40, 46);
    const vel = dir.clone().multiplyScalar(speed);
    const col = new THREE.Color(item.palette.a);
    const flightT = isFinale ? 3.0 : randRange(2.3, 2.7);
    const pattern = isFinale
      ? randPick(['multibreak', 'palm', 'dahlia', 'chrys', 'brocade', 'serpents', 'kamuro', 'timerain', 'saturn', 'thousandbloom', 'strobewillow', 'farfalle'])
      : randPick(['peony', 'dahlia', 'ring', 'crackle', 'strobe', 'willow', 'serpents', 'ghost', 'saturn', 'leaves', 'spider', 'dragoneggs', 'bees', 'tourbillon']);
    this._fireShot(muzzle, vel, col, 1.35, {
      gravity: 0.9, drag: 0.35, flightT, pattern,
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
   * opts: {pattern, size, palette, sound, speed, flightT, spread, dir?,
   *   tail?: 'glitter' — tremalon rise, the wake keeps flashing after the
   *          comet passes (dense delayed micro-stars along the arc),
   *   burst?: false — the comet is a fan/chase piece with no charge: it
   *          dies in a faint fizzle instead of a pattern (and no report),
   *   onBurst?: hook called at the burst moment with (pos, vel), after the
   *          default action — lets the choreography chain follow-ups}
   */
  mortarShot(pos, opts) {
    const dir = opts.dir
      ? _v1.copy(opts.dir).normalize()
      : _v1.set(randRange(-1, 1) * (opts.spread ?? 0.1), 1, randRange(-1, 1) * (opts.spread ?? 0.1)).normalize();
    this.audio.play('lift', pos, {
      gain: 1.25, refDistance: 4, send: 0.45, rate: randRange(0.88, 1.08), delayBySound: true,
    });
    this.utilFlashes.flash(_v2.copy(pos).setY(pos.y + 0.4), 0xffc890, 60, 0.18);
    const palette = opts.palette ?? randPick(PALETTES);
    const size = opts.size ?? 1;
    const vel = dir.clone().multiplyScalar(opts.speed ?? 52);
    this._fireShot(pos.clone(), vel, new THREE.Color(palette.a), 1.5, {
      gravity: 0.9, drag: 0.35, flightT: opts.flightT ?? 2.8,
      tail: opts.tail, pattern: opts.pattern,
      onBurst: (p, v) => {
        if (opts.burst === false) this._fizzle(p, palette);
        else {
          this.burst(p, {
            pattern: opts.pattern, size, palette,
            // default report class scales with the shell, same mapping the
            // rocket bursts use — callers only override for odd shells
            sound: opts.sound !== undefined ? opts.sound
              : (size > 0.75 ? 'big' : size > 0.45 ? 'med' : 'small'),
            // clone: the hook below is promised the TRUE burst velocity on
            // both paths, so the default action must not mutate v
            drift: v?.clone().multiplyScalar(0.5),
          });
        }
        opts.onBurst?.(p, v);
      },
    });
  }

  /**
   * A dud by design: fan/chase comets (mortarShot burst:false) carry no
   * charge, so the head just crumbles into a pinch of dim gold sparks and a
   * wisp of smoke — no pattern, no report. Real comet tubes end like this.
   */
  _fizzle(pos, palette) {
    const pool = this.pool;
    const time = this.time;
    const c = _c1.set(palette.a);
    pool.spawn(16, (i) => {
      const u = Math.random() * 2 - 1;
      const a = Math.random() * Math.PI * 2;
      const rr = Math.sqrt(1 - u * u);
      const sp = randRange(1.2, 3.4);
      pool.set(i,
        pos.x, pos.y, pos.z,
        rr * Math.cos(a) * sp, u * sp - 0.6, rr * Math.sin(a) * sp,
        c.r * 1.7 + 0.5, c.g * 1.5 + 0.4, c.b * 1.0 + 0.2,
        time, randRange(0.3, 0.75),
        randRange(0.03, 0.06), 0.6, 1.4, 28);
    });
    pool.spawn(3, (i) => {
      pool.set(i,
        pos.x, pos.y, pos.z,
        randRange(-0.3, 0.3) + WIND.x * 0.4, randRange(0.2, 0.6), randRange(-0.3, 0.3) + WIND.z * 0.4,
        0.38, 0.38, 0.42,
        time, randRange(1.8, 3.2),
        randRange(0.3, 0.55), -0.015, 1.4, -1);
    });
  }

  /**
   * A mine (pot à feu): no shell, no apex break — the whole charge erupts
   * off the pad at once as a cone of stars that climb 20-60 m, decelerate
   * and arc back down. The ground-level counterpart of a shell burst; what
   * ties the sky show to the dunes (and, in VR, puts a wall of fire RIGHT
   * THERE). opts: {size=1, palette, kind: 'color'|'crackle'|'serpents',
   * dir? (tilted cone axis), coneDeg=16, sound=true}
   */
  mine(pos, opts = {}) {
    const size = opts.size ?? 1;
    const palette = opts.palette ?? randPick(PALETTES);
    const kind = opts.kind ?? 'color';
    const coneRad = (opts.coneDeg ?? 16) * Math.PI / 180;
    const pool = this.pool;
    const time = this.time;
    const colA = _c1.set(palette.a);
    const colB = _c2.set(palette.b);

    // cone axis + an orthonormal basis around it (plain scalars so the
    // spawn fill below owns no scratch vectors)
    const axis = opts.dir ? _v1.copy(opts.dir).normalize() : _v1.set(0, 1, 0);
    const ax = axis.x, ay = axis.y, az = axis.z;
    const u = _v2.crossVectors(axis, Math.abs(axis.y) < 0.9 ? UP : X_AXIS).normalize();
    const ux = u.x, uy = u.y, uz = u.z;
    const w = _v3.crossVectors(axis, u).normalize();
    const wx = w.x, wy = w.y, wz = w.z;

    if (opts.sound !== false) {
      // the same mortar thump, pitched a touch up — a mine is all muzzle
      this.audio.play('lift', pos, {
        gain: 1.15, refDistance: 4, send: 0.4, rate: randRange(1.0, 1.18), delayBySound: true,
      });
    }
    this.utilFlashes.flash(_v4.copy(pos).setY(pos.y + 0.6), palette.a, 38 + 46 * size, 0.3);
    this._padDust(pos.clone(), size);
    this.groundMark?.(pos.x, pos.z, 0.5 + 0.4 * size, 0.6); // mines burn their pit black

    const spMul = 0.7 + size * 0.5;
    const grav = 1.0, drg = 0.55;
    const crackle = kind === 'crackle';

    if (kind === 'serpents') {
      // a mine of serpents: fewer stars, each rising in 3 chained legs that
      // veer between them — precomputed closed-form like the bees swarm,
      // one particle per leg, so the squirming column costs nothing at
      // runtime
      const n = Math.round(34 + 40 * Math.min(size, 1.05));
      const legDur = 0.42;
      let mj = -1, mx, my, mz, mvx, mvy, mvz, mBirth, cr, cg, cb;
      pool.spawn(n * 6, (i) => {
        mj++;
        const seg = mj % 6; // 3 legs x (head + bead)
        if (seg === 0) {
          // fresh star: sample the cone (uniform over the disc)
          const t = coneRad * Math.sqrt(Math.random());
          const a = Math.random() * Math.PI * 2;
          const st = Math.sin(t), ct = Math.cos(t);
          const dx = ax * ct + (ux * Math.cos(a) + wx * Math.sin(a)) * st;
          const dy = ay * ct + (uy * Math.cos(a) + wy * Math.sin(a)) * st;
          const dz = az * ct + (uz * Math.cos(a) + wz * Math.sin(a)) * st;
          const sp = randRange(28, 55) * spMul;
          mx = pos.x; my = pos.y + 0.2; mz = pos.z;
          mvx = dx * sp; mvy = dy * sp; mvz = dz * sp;
          mBirth = Math.random() * 0.2; // the 0.2 s stagger = column body
          const c = Math.random() < 0.5 ? colA : colB;
          cr = c.r * 6.4; cg = c.g * 6.4; cb = c.b * 6.4;
        } else if (seg % 2 === 0) {
          // veer into the next leg: advance to the closed-form end of the
          // previous one, then kick the heading sideways
          const d = Math.max(drg, 1e-4);
          const k = (1 - Math.exp(-d * legDur)) / d;
          const e = Math.exp(-d * legDur);
          const gA = 9.81 * grav;
          mx += mvx * k; my += mvy * k - gA * (legDur - k) / d; mz += mvz * k;
          mvx = mvx * e + randRange(-7, 7);
          mvy = mvy * e - gA * (1 - e) / d + randRange(-2, 5);
          mvz = mvz * e + randRange(-7, 7);
          mBirth += legDur;
        }
        const head = seg % 2 === 0;
        pool.set(i, mx, my, mz, mvx, mvy, mvz,
          head ? cr : cr * 0.45, head ? cg : cg * 0.45, head ? cb : cb * 0.45,
          time + mBirth + (head ? 0 : 0.035), legDur * (head ? randRange(1.1, 1.35) : 1.0),
          randRange(0.07, 0.11) * (0.7 + size * 0.4), grav, drg, head ? 42 : 0,
          CELL.GLOW, 0.07);
      });
    } else {
      // color / crackle column: staggered heads + one tracer bead each,
      // long shutters so the eruption reads as a sheaf of fire threads
      const n = Math.round(60 + 76 * Math.min(size, 1.05));
      let mj = -1, mvx, mvy, mvz, mBirth, mLife, cr, cg, cb, mSz;
      pool.spawn(n * 2, (i) => {
        mj++;
        if (mj % 2 === 0) {
          const t = coneRad * Math.sqrt(Math.random());
          const a = Math.random() * Math.PI * 2;
          const st = Math.sin(t), ct = Math.cos(t);
          const dx = ax * ct + (ux * Math.cos(a) + wx * Math.sin(a)) * st;
          const dy = ay * ct + (uy * Math.cos(a) + wy * Math.sin(a)) * st;
          const dz = az * ct + (uz * Math.cos(a) + wz * Math.sin(a)) * st;
          const sp = randRange(28, 55) * spMul;
          mvx = dx * sp; mvy = dy * sp; mvz = dz * sp;
          mBirth = Math.random() * 0.2;
          mLife = randRange(1.5, 2.6);
          mSz = randRange(0.08, 0.12) * (0.7 + size * 0.4);
          const white = Math.random() < (crackle ? 0.45 : 0.1);
          const c = Math.random() < 0.5 ? colA : colB;
          cr = white ? 6.9 : c.r * 6.4; cg = white ? 6.7 : c.g * 6.4; cb = white ? 6.2 : c.b * 6.4;
          pool.set(i, pos.x, pos.y + 0.2, pos.z, mvx, mvy, mvz, cr, cg, cb,
            time + mBirth, mLife, mSz, grav, drg, crackle ? 55 : 0,
            crackle ? (Math.random() < 0.35 ? CELL.CRACKLE : CELL.STAR4) : CELL.GLOW,
            0.07);
        } else {
          pool.set(i, pos.x, pos.y + 0.2, pos.z, mvx, mvy, mvz,
            cr * 0.45, cg * 0.45, cb * 0.45,
            time + mBirth + 0.035, mLife * 0.92, mSz * 0.7, grav, drg, 0,
            CELL.GLOW, 0.07);
        }
      });
    }

    if (crackle && opts.sound !== false) {
      // the payload cooks off around the top of the column: drop the
      // crackle chorus at the analytic apex of a mid-speed star
      const vMid = 41 * spMul;
      const apexT = Math.log(1 + vMid * drg / 9.81) / drg;
      const d = Math.max(drg, 1e-4);
      const k = (1 - Math.exp(-d * apexT)) / d;
      const apex = pos.clone();
      apex.x += ax * vMid * k; apex.z += az * vMid * k;
      apex.y += ay * vMid * k - 9.81 * grav * (apexT - k) / d;
      this.schedule(apexT * 0.85, () => this.audio.play('crackle', apex, {
        gain: 0.9, refDistance: 6, send: 0.4, rate: randRange(0.9, 1.05),
      }));
    }
  }

  _spend(item) {
    if (!this.items.has(item)) return;
    item.state = 'spent';
    item.extinguishSounds();
    // char the item (shared material — item visuals are palette-cached);
    // the husk stands as evidence for a good while before fading away
    item.root.traverse((o) => {
      if (o.isMesh) o.material = CHAR_MAT;
    });
    // scorch the sand under a piece that burned out on (or near) it
    const p = item.root.getWorldPosition(_v1);
    if (p.y - this.groundHeight(p.x, p.z) < 0.5) {
      this.groundMark?.(p.x, p.z, 0.16 + item.type.size * 0.14, 0.5);
    }
    this.schedule(90, () => this.removeItem(item));
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

    if (bounceNum === 0) {
      // riser voices: whistling inserts (serpents, tourbillons, fish)
      // announce themselves on the way up; big display comets get a quiet
      // secondary whoosh with the receding pitch ramp the rockets use.
      // Throttled — a finale wall stays a wall of reports, not thirty
      // overlapping whooshes.
      const whistler = opts.pattern === 'serpents' || opts.pattern === 'tourbillon'
        || opts.pattern === 'fish';
      if ((whistler || sizeMul >= 1.2) && this.time - this._riserT > 0.28) {
        this._riserT = this.time;
        if (whistler) {
          const h = this.audio.play('whistle', pos, {
            gain: 0.55, refDistance: 5, send: 0.35, rate: randRange(0.92, 1.12), delayBySound: true,
          });
          if (h) { // pyro whistles sweep upward as the insert climbs
            const pr = h.source.playbackRate;
            pr.setTargetAtTime(pr.value * 1.18, this.audio.ctx.currentTime, flightT * 0.45);
          }
        } else {
          const h = this.audio.play('whoosh', pos, {
            gain: 0.3, refDistance: 4, send: 0.3, rate: randRange(0.95, 1.1), delayBySound: true,
          });
          if (h) this._recedeWhoosh(h);
        }
      }
      // ground-launch theater: a mortar or cake tube coughs grit and muzzle
      // smoke; every ~4th launch also feeds a long-hanging haze puff, so a
      // battery that has been firing for a minute stands in its own shroud
      // (lit from inside by later breaks — that's the payoff)
      const gy = this.groundHeight(pos.x, pos.z);
      if (sizeMul >= 1.2 && pos.y - gy < 0.6) {
        const pool = this.pool;
        const time = this.time;
        const px = pos.x, py = pos.y, pz = pos.z;
        const wdx = WIND.x, wdz = WIND.z;
        pool.spawn(8, (i) => {
          const a = Math.random() * Math.PI * 2;
          const sp = randRange(0.8, 2.4);
          pool.set(i,
            px, py + 0.05, pz,
            Math.cos(a) * sp, randRange(0.3, 1.2), Math.sin(a) * sp,
            0.8, 0.6, 0.34,
            time, randRange(0.35, 0.7),
            randRange(0.02, 0.04), 1.2, 2.6, 0);
        });
        pool.spawn(3, (i) => {
          pool.set(i,
            px, py + 0.2, pz,
            randRange(-0.2, 0.2) + wdx * 0.5, randRange(0.4, 0.9), randRange(-0.2, 0.2) + wdz * 0.5,
            0.42, 0.42, 0.46,
            time, randRange(2.0, 3.5),
            randRange(0.3, 0.55), -0.02, 1.6, -1);
        });
        this.groundMark?.(px, pz, 0.35, 0.3);
        this._padShots++;
        if (this._padShots % 4 === 0) {
          pool.spawn(2, (i) => {
            pool.set(i,
              px + randRange(-0.6, 0.6), py + randRange(0.8, 1.8), pz + randRange(-0.6, 0.6),
              wdx * 0.45 + randRange(-0.1, 0.1), randRange(0.1, 0.3), wdz * 0.45 + randRange(-0.1, 0.1),
              0.30, 0.30, 0.33, // low albedo: the shroud reads by depth, not density
              time, randRange(12, 20),
              randRange(1.6, 2.6), -0.006, 1.1, -1);
          });
        }
      }
    }

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
      this._spawnComet(pos, vel, color, sizeMul, { gravity, drag, life: flightT, tail: opts.tail });
      const burstPos = ballistic(pos, vel, flightT, gravity, drag, new THREE.Vector3());
      const burstVel = ballisticVel(vel, flightT, gravity, drag, new THREE.Vector3());
      this.schedule(flightT, () => opts.onBurst(burstPos, burstVel));
      return;
    }

    // streak until the strike, then bounce off the sand
    this._spawnComet(pos, vel, color, sizeMul, { gravity, drag, life: tHit, tail: opts.tail });
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

  /**
   * Per-item fuse fire: a steady fizz plus Poisson gouts — irregular spitting
   * bursts of 6-10 stretched sparks with the odd grey wisp, each fuse on its
   * own clock (two burning fuses must sputter independently, so the old
   * shared accumulator is gone).
   */
  spawnFuseSparks(item, pos, time, dt) {
    const pool = this.pool;
    const px = pos.x, py = pos.y, pz = pos.z;
    // baseline fizz
    item._fuseAcc = (item._fuseAcc ?? Math.random()) + dt * 34;
    const n = Math.floor(item._fuseAcc);
    item._fuseAcc -= n;
    if (n > 0) {
      pool.spawn(n, (i) => {
        pool.set(i,
          px + randRange(-0.008, 0.008), py + randRange(-0.008, 0.008), pz + randRange(-0.008, 0.008),
          randRange(-0.5, 0.5), randRange(0.1, 0.9), randRange(-0.5, 0.5),
          1.0, 0.75, 0.3,
          time, randRange(0.15, 0.45),
          randRange(0.008, 0.02), 0.35, 2.5, 0);
      });
    }
    // the gouts: the fuse finds a pocket of powder and SPITS
    item._fuseGout = (item._fuseGout ?? randRange(0.1, 0.4)) - dt;
    if (item._fuseGout <= 0) {
      item._fuseGout = randRange(0.14, 0.55);
      const burst = 6 + ((Math.random() * 5) | 0);
      pool.spawn(burst, (i) => {
        const sp = randRange(0.7, 2.1);
        const a = Math.random() * Math.PI * 2;
        const u = randRange(-0.3, 1);
        const rr = Math.sqrt(1 - u * u);
        pool.set(i,
          px, py, pz,
          rr * Math.cos(a) * sp, u * sp + 0.4, rr * Math.sin(a) * sp,
          Math.random() < 0.3 ? 3.4 : 1.3, Math.random() < 0.5 ? 1.0 : 0.7, 0.3,
          time, randRange(0.2, 0.55),
          randRange(0.01, 0.022), 0.5, 1.9, 0,
          Math.random() < 0.3 ? CELL.STAR6 : CELL.GLOW, 0.05);
      });
      if (Math.random() < 0.35) { // a wisp of grey off the burn front
        pool.spawn(1, (i) => {
          pool.set(i,
            px, py + 0.01, pz,
            WIND.x * 0.3 + randRange(-0.06, 0.06), randRange(0.12, 0.3), WIND.z * 0.3 + randRange(-0.06, 0.06),
            0.42, 0.42, 0.45,
            time, randRange(1.2, 2.4),
            randRange(0.05, 0.1), -0.02, 1.5, -1);
        });
      }
    }
  }

  // The torch is CLOSE: the tip cooks and throws a couple of anticipation
  // sparks before it actually catches (driven by item.fuseGlow, 0..1).
  spawnFuseGlowSparks(item, pos, time, dt, glow) {
    item._fuseAcc = (item._fuseAcc ?? Math.random()) + dt * 10 * glow;
    const n = Math.floor(item._fuseAcc);
    item._fuseAcc -= n;
    if (n <= 0) return;
    const pool = this.pool;
    const px = pos.x, py = pos.y, pz = pos.z;
    pool.spawn(n, (i) => {
      pool.set(i,
        px + randRange(-0.006, 0.006), py + randRange(-0.006, 0.006), pz + randRange(-0.006, 0.006),
        randRange(-0.25, 0.25), randRange(0.1, 0.5), randRange(-0.25, 0.25),
        1.1, 0.7, 0.25,
        time, randRange(0.12, 0.3),
        randRange(0.006, 0.014), 0.3, 2.4, 0);
    });
  }

  /**
   * A single glowing star streaking along a ballistic arc. gravity/drag/life
   * must match the ballistic() prediction of the caller so the scheduled
   * burst happens exactly where the streak dies.
   */
  _spawnComet(pos, vel, color, sizeMul = 1, { gravity = 0.75, drag = 0.55, life = 1.0, tail } = {}) {
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
    // tremalon rise (tail:'glitter'): glitter chemistry keeps cooking in the
    // wake AFTER the head is gone — dense gold micro-stars shed along the
    // arc, each hanging DARK for a beat and then flashing white-gold for a
    // tenth of a second. Same closed-form precompute as the flecks above:
    // shed point = arc position at ts, birth = ts + its dark delay, near-zero
    // inherited velocity + heavy drag so each flash ignites right where the
    // comet dropped it. The column stays twinkling for ~a second behind.
    if (tail === 'glitter') {
      const d = Math.max(drag, 1e-4);
      const gA = 9.81 * gravity;
      pool.spawn(Math.round(55 + 65 * sizeMul), (i) => {
        const ts = Math.random() * life;
        const k = (1 - Math.exp(-d * ts)) / d;
        pool.set(i,
          pos.x + vel.x * k, pos.y + vel.y * k - gA * (ts - k) / d, pos.z + vel.z * k,
          randRange(-0.5, 0.5), randRange(-0.7, 0.3), randRange(-0.5, 0.5),
          6.8, 5.7, 3.1,
          time + ts + randRange(0.1, 0.8), randRange(0.12, 0.2),
          randRange(0.07, 0.12) * sizeMul, 0.15, 1.6, 0,
          CELL.STAR6, 0);
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

  /**
   * Motor exhaust in three passes: white-hot grit right off the nozzle,
   * flame tinted by the shell's own colors blended toward white-hot, and a
   * long-life grey smoke column that keeps hanging (and drifting downwind)
   * after the rocket is gone — every rise leaves a trace in the air.
   */
  spawnTrail(pos, vel, dt, time, size, palette) {
    const pool = this.pool;
    const px = pos.x, py = pos.y, pz = pos.z;
    const vx = vel.x, vy = vel.y, vz = vel.z;
    // flame tone: the palette's star color pushed most of the way to furnace
    const c = _c1.set(palette?.a ?? 0xffab42);
    const fr = c.r + (1 - c.r) * 0.62, fg = c.g + (1 - c.g) * 0.5, fb = c.b + (1 - c.b) * 0.3;
    const grit = Math.max(1, Math.round(dt * 130 * (0.5 + size)));
    pool.spawn(grit, (i) => {
      const back = Math.random() * dt;
      pool.set(i,
        px - vx * back + randRange(-0.012, 0.012),
        py - vy * back + randRange(-0.012, 0.012),
        pz - vz * back + randRange(-0.012, 0.012),
        randRange(-1.6, 1.6), randRange(-1.8, 0.4), randRange(-1.6, 1.6),
        2.4, 2.0, 1.4,
        time - back, randRange(0.1, 0.3),
        randRange(0.012, 0.028) * (0.6 + size), 0.5, 2.2, 0,
        CELL.GLOW, 0.05);
    });
    const flame = Math.max(1, Math.round(dt * 110 * (0.5 + size)));
    pool.spawn(flame, (i) => {
      const back = Math.random() * dt;
      pool.set(i,
        px - vx * back + randRange(-0.015, 0.015),
        py - vy * back + randRange(-0.015, 0.015),
        pz - vz * back + randRange(-0.015, 0.015),
        randRange(-1.2, 1.2), randRange(-1.5, 0.4), randRange(-1.2, 1.2),
        fr * 1.6, fg * 1.3, fb * 0.9,
        time - back, randRange(0.3, 0.8),
        randRange(0.02, 0.045) * (0.6 + size), 0.4, 2.2, 0);
    });
    // the hanging column (cheap: a few long-lived puffs per second of burn)
    const smoke = Math.floor(dt * 26 * (0.5 + size) + Math.random());
    if (smoke > 0) {
      const wdx = WIND.x * 0.55, wdz = WIND.z * 0.55;
      pool.spawn(smoke, (i) => {
        const back = Math.random() * dt;
        pool.set(i,
          px - vx * back, py - vy * back, pz - vz * back,
          wdx + randRange(-0.2, 0.2), randRange(0.05, 0.35), wdz + randRange(-0.2, 0.2),
          0.38, 0.38, 0.42,
          time - back, randRange(2.5, 4.0),
          randRange(0.22, 0.42) * (0.6 + size), -0.012, 1.4, -1);
      });
    }
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

      // the luminous heart: a knot of big soft glows drifting out from the
      // break point, alive for a second or so after the flash sprite dies —
      // the blown-out core a photo shows where hundreds of trails overlap
      // into one mass of light, and a cheap stand-in for lens bloom
      pool.spawn(Math.round(8 + 8 * size), (i) => {
        const u = Math.random() * 2 - 1;
        const a = Math.random() * Math.PI * 2;
        const rr = Math.sqrt(1 - u * u);
        const sp = randRange(0.9, 2.2) * (1 + size);
        pool.set(i,
          pos.x, pos.y, pos.z,
          rr * Math.cos(a) * sp + dvx * 0.6, u * sp + dvy * 0.6, rr * Math.sin(a) * sp + dvz * 0.6,
          (colA.r + (1 - colA.r) * 0.35) * 0.6, (colA.g + (1 - colA.g) * 0.35) * 0.6, (colA.b + (1 - colA.b) * 0.35) * 0.6,
          time, randRange(0.7, 1.3),
          randRange(0.9, 1.5) * (0.5 + size), 0.1, 1.5, 0,
          CELL.GLOW, 0);
      });

      // lingering smoke haze: a real occluding cloud (albedo, lit by the
      // moon and by later bursts — see the particle shader) that swells and
      // drifts on the shared desert WIND after the stars die. What keeps a
      // big shell from vanishing into clean air, and what the next shell
      // lights up. Big shells hang more of it, for longer.
      const bigShell = size > 0.9;
      if (size > 0.3) {
        const wdx = WIND.x * 0.55, wdz = WIND.z * 0.55;
        pool.spawn(bigShell ? Math.round(18 + 22 * size) : 10 + Math.round(12 * size), (i) => {
          const u = Math.random() * 2 - 1;
          const a = Math.random() * Math.PI * 2;
          const rr = Math.sqrt(1 - u * u);
          const sp = randRange(1.2, 3.2) * (0.5 + size);
          pool.set(i,
            pos.x, pos.y, pos.z,
            rr * Math.cos(a) * sp + dvx * 0.4 + wdx, u * sp * 0.6 + dvy * 0.3 + 0.25, rr * Math.sin(a) * sp + dvz * 0.4 + wdz,
            0.34 + colA.r * 0.10, 0.34 + colA.g * 0.10, 0.37 + colA.b * 0.10,
            time, bigShell ? randRange(6, 11) : randRange(3.5, 6.5) * (0.7 + size * 0.5),
            randRange(0.9, 1.6) * (0.5 + size), -0.012, 1.2, -1);
        });
      }
      if (bigShell) {
        // the smoke ring: a real shell leaves a slowly widening torus on
        // its burst plane, hanging long after the color is gone
        const wdx = WIND.x * 0.5, wdz = WIND.z * 0.5;
        const ringN = 15 + Math.round(6 * size);
        pool.spawn(ringN, (i) => {
          const a = (i / ringN) * Math.PI * 2 + Math.random() * 0.25;
          const sp = randRange(2.4, 3.4) * (0.6 + size * 0.4);
          pool.set(i,
            pos.x + Math.cos(a) * 0.6, pos.y + randRange(-0.3, 0.3), pos.z + Math.sin(a) * 0.6,
            Math.cos(a) * sp + dvx * 0.3 + wdx, randRange(-0.1, 0.35), Math.sin(a) * sp + dvz * 0.3 + wdz,
            0.32, 0.32, 0.35,
            time + randRange(0.1, 0.5), randRange(7, 11),
            randRange(1.0, 1.7) * (0.5 + size * 0.5), -0.008, 0.75, -1);
        });
        // heavy fallout: slow embers that actually REACH the sand and die
        // there as coals (the pool's aGroundY settling holds them on the
        // dunes) — after a grand shell the ground below glitters and cools
        pool.spawn(18 + Math.round(12 * Math.min(size, 1.6)), (i) => {
          const u = Math.random() * 2 - 1;
          const a = Math.random() * Math.PI * 2;
          const rr = Math.sqrt(1 - u * u);
          const sp = randRange(3, 8);
          pool.set(i,
            pos.x, pos.y, pos.z,
            rr * Math.cos(a) * sp + dvx * 0.5, u * sp * 0.6 - 1 + dvy * 0.4, rr * Math.sin(a) * sp + dvz * 0.5,
            2.3, 1.15, 0.35,
            time, randRange(6, 9),
            randRange(0.05, 0.09), 0.55, 0.35, 7);
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
     * a share of the shed velocity and heavy drag so it slides along the ray
     * and then hangs where it was dropped. A flake shed at ts lives until
     * the head dies, so every ray stays lit from core to tip and then fades
     * as one — and because outer flakes are younger, each ray is naturally
     * rim-bright / center-dim, exactly how the real thing reads. Flake
     * spacing and smear are matched so neighbours overlap: the ray draws as
     * ONE continuous thread of fire, not a dotted string.
     *
     * Ray directions come from a Fibonacci sphere (jittered, with a random
     * azimuth per shell), not random sampling — real stars are packed
     * evenly in the shell casing, and the even comb of same-length rays is
     * most of what makes a display photo read "perfect dandelion".
     *
     * opts.tipSparkle finishes each ray with strobing near-white glitter.
     * opts.tipColor/tipMix: bi-color rays — the ray blends from the shell
     * color at the core to tipColor at the rim (tipMix = how far it gets).
     * Every head star tows a fat dim glow halo, faking the lens bloom that
     * makes photo rays luminous instead of hard-drawn.
     * Costs (2 + flakes + 2·tipSparkle) particles per ray.
     */
    const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
    const spawnRays = (rays, speed, opts = {}) => {
      const gravity = opts.gravity ?? 0.36;
      const drag = opts.drag ?? 0.5;
      const flakes = opts.flakes ?? 22;
      const tips = opts.tipSparkle ? 2 : 0;
      const seg1 = 2 + flakes + tips;
      const bright = opts.brightness ?? glow;
      const flakeTw = opts.flakeTwinkle ?? 0;
      const baseLife = opts.life ?? 2.6;
      const scale = 0.6 + size * 0.7;
      const d = Math.max(drag, 0.0001);
      const gAcc = 9.81 * gravity;
      const phase = Math.random() * Math.PI * 2; // spin the comb per shell
      const tip = opts.tipColor !== undefined ? new THREE.Color(opts.tipColor) : null;
      const tipMix = opts.tipMix ?? 0.22;
      // strobing flakes (>= 20 Hz) render as textured star crosses, which
      // can't stretch; smooth flakes get a long shutter that smears each one
      // along its ray — thin continuous lines instead of fat bead strings
      const fCell = flakeTw >= 20 ? undefined : CELL.GLOW;
      const fStretch = flakeTw >= 20 ? undefined : 0.09;
      // per-ray state carried across the ray's flakes (fill runs in order)
      let j = -1, vx, vy, vz, cr, cg, cb, tr, tg, tb, life, hsz;
      pool.spawn(rays * seg1, (i) => {
        j++;
        const seg = j % seg1;
        if (seg === 0) {
          // the head star: Fibonacci-sphere direction (evenly combed rays),
          // near-uniform speed — same-length rays, like the photo
          const si = (j / seg1) | 0;
          const u = clamp(1 - (2 * (si + 0.5)) / rays + randRange(-0.025, 0.025), -1, 1);
          const a = si * GOLDEN_ANGLE + phase + randRange(-0.04, 0.04);
          const r = Math.sqrt(1 - u * u);
          const sp = speed * randRange(0.96, 1.0);
          vx = r * Math.cos(a) * sp + dvx;
          vy = u * sp + dvy;
          vz = r * Math.sin(a) * sp + dvz;
          cr = colA.r; cg = colA.g; cb = colA.b;
          // tip tone: the palette accent for bi-color shells, otherwise the
          // ray color pushed most of the way to white — pink-white on
          // scarlet, pale gold on amber, mint on teal
          if (tip) { tr = tip.r; tg = tip.g; tb = tip.b; }
          else { tr = cr + (1 - cr) * 0.72; tg = cg + (1 - cg) * 0.72; tb = cb + (1 - cb) * 0.72; }
          life = baseLife * randRange(0.9, 1.1);
          hsz = (opts.psize ?? 0.12) * randRange(0.85, 1.2) * scale;
          // the head rides the rim, so on bi-color shells it burns mostly tip
          const hw = tip ? Math.min(1, tipMix) * 0.8 : 0;
          pool.set(i, pos.x, pos.y, pos.z, vx, vy, vz,
            (cr + (tr - cr) * hw) * 5.7 * bright, (cg + (tg - cg) * hw) * 5.7 * bright, (cb + (tb - cb) * hw) * 5.7 * bright,
            time, life, hsz,
            gravity, drag, 0, CELL.GLOW, 0.055);
        } else if (seg === 1) {
          // bloom halo: a fat, dim glow towing the head on the exact same
          // arc — the soft light-bleed a camera lens paints around every
          // bright star. Costs one big-but-faint quad per ray.
          pool.set(i, pos.x, pos.y, pos.z, vx, vy, vz,
            (cr + (tr - cr) * 0.4) * 0.85 * bright, (cg + (tg - cg) * 0.4) * 0.85 * bright, (cb + (tb - cb) * 0.4) * 0.85 * bright,
            time, life * 0.96, hsz * 3.4,
            gravity, drag, 0, CELL.GLOW, 0.04);
        } else if (seg <= flakes + 1) {
          // a flake shed on the way out (jittered even spacing, skipping the
          // dark core the photo shows around the break point). Flakes keep a
          // healthy share of the shed velocity with moderate drag, so each
          // one smears along the ray far enough to overlap its neighbours —
          // that's what fuses the beads into the photo's solid threads.
          const f = (seg - 2 + Math.random() * 0.9) / flakes;
          const ts = life * (0.04 + 0.74 * f);
          const k = (1 - Math.exp(-d * ts)) / d;
          const e = Math.exp(-d * ts);
          const svy = (vy + gAcc / d) * e - gAcc / d; // shed-point velocity
          // outer flakes tint toward the tip tone (all the way on bi-color
          // shells, gently otherwise; the photo's single-color rays hold
          // saturation nearly to the end). flakeBright is the hue knob:
          // saturated primaries survive heavy HDR overdrive, but golds have
          // to stay under ~3x or ACES compresses them to silver-white.
          const w = Math.min(1, f * tipMix * (opts.flakeTint ?? 1) * (tip ? 1.25 : 1));
          const fb = (opts.flakeBright ?? 4.4) * (1 - f * 0.2) * bright;
          pool.set(i,
            pos.x + vx * k, pos.y + vy * k - gAcc * (ts - k) / d, pos.z + vz * k,
            vx * e * 0.65 + randRange(-0.4, 0.4), svy * 0.65 + randRange(-0.4, 0.4), vz * e * 0.65 + randRange(-0.4, 0.4),
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

    /**
     * spec.pistil — the yae-shin double-petal core: a concentric contrast
     * sphere fired from the same origin at a fraction of the outer speed
     * with the SAME gravity/drag, so inner and outer spheres stay nested as
     * they grow (real two-stage ball shells are pasted exactly this way).
     * Layered onto peony/chrys/ring/spider/strobewillow by their cases.
     * Runs dimmer than the petals on purpose — overdriven accent colors
     * ACES-compress to white, and a pistil must read as COLOR.
     */
    const spawnPistil = (outerSpeed, gravity, drag) => {
      const pc = spec.pistil.color !== undefined
        ? new THREE.Color(spec.pistil.color) : colB;
      const ratio = clamp(spec.pistil.ratio ?? 0.38, 0.2, 0.5);
      const psp = outerSpeed * ratio;
      const pr = pc.r * 5.7 * glow * 0.85, pg = pc.g * 5.7 * glow * 0.85, pb = pc.b * 5.7 * glow * 0.85;
      let qj = -1, qvx, qvy, qvz, qLife, qLag;
      pool.spawn(Math.round((100 + 150 * size) * grandCount) * 2, (i) => {
        qj++;
        if (qj % 2 === 0) {
          const u = Math.random() * 2 - 1;
          const a = Math.random() * Math.PI * 2;
          const rr = Math.sqrt(1 - u * u);
          const sp = psp * randRange(0.9, 1.0); // crisp skin, like the petals
          qvx = rr * Math.cos(a) * sp + dvx; qvy = u * sp + dvy; qvz = rr * Math.sin(a) * sp + dvz;
          qLife = randRange(1.7, 2.2) * grandLife;
          qLag = randRange(0.024, 0.038);
          pool.set(i, pos.x, pos.y, pos.z, qvx, qvy, qvz, pr, pg, pb,
            time, qLife, 0.15 * grandPSize, gravity, drag, 0, CELL.GLOW, 0.045);
        } else {
          pool.set(i, pos.x, pos.y, pos.z, qvx, qvy, qvz,
            pr * 0.45, pg * 0.45, pb * 0.45,
            time + qLag, qLife * 0.95, 0.10 * grandPSize, gravity, drag, 0, CELL.GLOW, 0.045);
        }
      });
    };

    switch (pattern) {
      case 'peony': {
        // small stars on a long shutter: each one draws a fine line radiating
        // from the break, longest right at the break and tightening as drag
        // bites — the long-exposure streamer look of the real thing
        const pSpeed = spec.speed ?? wideGrandSpeed(12 + 14 * size);
        spawnSphere(spec.count ?? Math.round((310 + 720 * size) * grandCount), pSpeed, {
          shellSkin: true, life: (2.2 + 1.2 * size) * grandLife, drag: slowGrandDrag(0.6), gravity: 0.35,
          psize: 0.12 * grandPSize, trail: 2, stretch: 0.06,
        });
        spawnSphere(Math.round((120 + 230 * size) * grandCount), 7 + 8 * size, {
          life: 1.6 * grandLife, psize: 0.075 * grandPSize, drag: slowGrandDrag(0.7), stretch: 0.04,
        });
        // ~40% of peonies carry a pistil: a slow contrast-color heart inside
        // the sphere, the way real ball shells are often built two-stage —
        // unless the choreography demanded one via spec.pistil, which owns
        // the core alone (two stacked cores overdrive the accent to white)
        if (!spec.pistil && Math.random() < 0.4) {
          spawnSphere(Math.round((90 + 150 * size) * grandCount), (4 + 5 * size), {
            shellSkin: true, color: 'b', life: 1.9 * grandLife, drag: 0.8, gravity: 0.3,
            psize: 0.16 * grandPSize, brightness: glow * 0.8, whiteCore: 0.02,
          });
        }
        if (spec.pistil) spawnPistil(pSpeed, 0.35, slowGrandDrag(0.6));
        break;
      }

      case 'dahlia': {
        // The postcard shell: bi-color rays that burn the shell color at the
        // core and blend to the palette accent at the rim (blue-to-gold,
        // scarlet-to-pink, teal-to-ember…), near-white sparkle at every ray
        // end, breaking over a loose pistil core in the accent color.
        const rays = spec.count ?? Math.min(240, Math.round(90 + 100 * size + 45 * grand));
        const speed = spec.speed ?? wideGrandSpeed(11.5 + 12.5 * size);
        spawnRays(rays, speed, {
          life: (2.5 + size) * grandLife, drag: slowGrandDrag(0.52), gravity: 0.34,
          flakes: Math.round(28 + 15 * Math.min(size, 1.6)), tipSparkle: true,
          psize: 0.12 * grandPSize,
          tipColor: palette.b, tipMix: 1.0,
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

      case 'chrys': { // brocade-crown chrysanthemum: dense hanging glitter rays
        const cSpeed = wideGrandSpeed(11 + 13 * size);
        spawnRays(Math.min(260, Math.round(95 + 105 * size + 40 * grand)), cSpeed, {
          life: (2.9 + 1.1 * size) * grandLife, drag: slowGrandDrag(0.48), gravity: 0.45,
          flakes: Math.round(30 + 15 * Math.min(size, 1.6)), tipSparkle: true,
          flakeTwinkle: 15, psize: 0.10 * grandPSize,
          flakeBright: 2.6, flakeTint: 0.4, // hold the amber — see spawnRays
        });
        if (spec.pistil) spawnPistil(cSpeed, 0.45, slowGrandDrag(0.48));
        break;
      }

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
        const rSpeed = spec.speed ?? wideGrandSpeed(14 + 14 * size);
        const n = _v1.set(randRange(-1, 1), randRange(-0.4, 0.4), randRange(-1, 1)).normalize();
        spawnRing(n, spec.count ?? Math.round((230 + 320 * size) * grandCount), rSpeed);
        if (spec.pistil) spawnPistil(rSpeed, 0.3, slowGrandDrag(0.7));
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
        spawnRays(Math.min(280, Math.round(105 + 115 * size + 45 * grand)), wideGrandSpeed(9.5 + 10.5 * size), {
          life: (4.4 + 1.7 * size) * grandLife, drag: slowGrandDrag(0.34), gravity: 0.52,
          flakes: Math.round(32 + 16 * Math.min(size, 1.6)), tipSparkle: true,
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

      case 'thousandbloom': {
        // senrin-giku, "a thousand chrysanthemums": the shell opens almost
        // invisibly, scattering dim embers across a huge volume — then, on
        // ONE cue, every ember pops into a tiny bright color sphere and the
        // whole sky polka-dots in a single instant. The simultaneity IS the
        // effect (multibreak scatters its pops; this one must land as one),
        // so every child star is precomputed here with a shared birth
        // offset ± 50 ms of fuse tolerance — zero scheduled work per ember.
        const popT = randRange(1.2, 1.6);
        const nE = Math.round(120 + 60 * size);
        const kids = 11;
        const seg1 = 2 + kids; // ember head + tracer bead + its children
        const eDrag = 0.5, eGrav = 0.3;
        const gA = 9.81 * eGrav;
        // confetti mix: this shell's own colors plus a few strangers
        const mixCols = [[colA.r, colA.g, colA.b], [colB.r, colB.g, colB.b]];
        for (let m = 0; m < 3; m++) {
          const c = new THREE.Color(randPick(PALETTES).a);
          mixCols.push([c.r, c.g, c.b]);
        }
        let tj = -1, evx, evy, evz, eT;
        pool.spawn(nE * seg1, (i) => {
          tj++;
          const seg = tj % seg1;
          if (seg === 0) {
            // a dim gold ember, thrown wide and burning low — from the camp
            // it barely registers, which makes the pop land harder
            const u = Math.random() * 2 - 1;
            const a = Math.random() * Math.PI * 2;
            const rr = Math.sqrt(1 - u * u);
            const sp = randRange(14, 18) * (0.6 + 0.4 * size);
            evx = rr * Math.cos(a) * sp + dvx;
            evy = u * sp + dvy;
            evz = rr * Math.sin(a) * sp + dvz;
            eT = popT + randRange(-0.05, 0.05); // per-ember fuse tolerance
            pool.set(i, pos.x, pos.y, pos.z, evx, evy, evz,
              1.6, 1.1, 0.42,
              time, eT, 0.07 * (0.7 + size * 0.4), eGrav, eDrag, 0,
              CELL.GLOW, 0.045);
          } else if (seg === 1) {
            // one faint tracer bead — a "mild trail", not a streamer
            pool.set(i, pos.x, pos.y, pos.z, evx, evy, evz,
              0.8, 0.55, 0.2,
              time + 0.05, eT * 0.95, 0.05 * (0.7 + size * 0.4), eGrav, eDrag, 0,
              CELL.GLOW, 0.045);
          } else {
            // a pop star: born exactly where its ember is at eT (closed-form
            // arc), keeping a bit of the ember's dying velocity plus its own
            // small sphere kick — a 5-8 m bloom in a saturated mixed color
            const k = (1 - Math.exp(-eDrag * eT)) / eDrag;
            const e = Math.exp(-eDrag * eT);
            const u = Math.random() * 2 - 1;
            const a = Math.random() * Math.PI * 2;
            const rr = Math.sqrt(1 - u * u);
            const cs = randRange(3.2, 5.2) * (0.75 + 0.35 * size);
            const col = mixCols[(Math.random() * mixCols.length) | 0];
            pool.set(i,
              pos.x + evx * k, pos.y + evy * k - gA * (eT - k) / eDrag, pos.z + evz * k,
              evx * e * 0.3 + rr * Math.cos(a) * cs,
              (evy * e - gA * (1 - e) / eDrag) * 0.3 + u * cs,
              evz * e * 0.3 + rr * Math.sin(a) * cs,
              col[0] * 5.7 * glow, col[1] * 5.7 * glow, col[2] * 5.7 * glow,
              time + eT, randRange(0.8, 1.2),
              0.085 * randRange(0.8, 1.25) * (0.7 + size * 0.4), 0.32, 0.85, 0,
              CELL.GLOW, 0.03);
          }
        });
        // the pop is a CLOUD of small reports, not one boom: overlapping
        // slow crackle plus a few lone crackers placed inside the cloud
        // (a handful of whole-cloud schedules — never one per ember)
        const cpos = pos.clone();
        this.schedule(popT, () => this.audio.play('crackle', cpos, {
          gain: 1.0, refDistance: 8, send: 0.45, rate: randRange(0.6, 0.72),
        }));
        this.schedule(popT + 0.05, () => this.audio.play('crackle', cpos, {
          gain: 0.8, refDistance: 8, send: 0.45, rate: randRange(0.74, 0.86),
        }));
        for (let c = 0; c < 3; c++) {
          const cp = pos.clone();
          cp.x += randRange(-9, 9); cp.y += randRange(-5, 5); cp.z += randRange(-9, 9);
          this.schedule(popT + randRange(-0.04, 0.12), () => this.audio.play('cracker', cp, {
            gain: randRange(0.5, 0.8), refDistance: 5, send: 0.4, rate: randRange(0.8, 1.05),
          }));
        }
        break;
      }

      case 'bees':
      case 'fish': {
        // poka-shell swarms: stars that refuse to fall ballistically. Each
        // one darts through 6-9 straight-ish legs, veering hard between
        // them — a panicked bee cloud (tight, frantic, ~2 s) or a school of
        // fish swimming clean across the sky (faster, longer legs, 3 s).
        // Every leg is its own precomputed particle: spawn point = the
        // closed-form end of the previous leg, birth = the moment the star
        // gets there — the chain reads as ONE continuous living streak with
        // zero runtime cost. Silent, like the real inserts.
        const beesKind = pattern === 'bees';
        const nStars = beesKind ? Math.round(30 + 20 * size) : Math.round(21 + 14 * size);
        const grav = 0.25, drg = beesKind ? 0.4 : 0.3;
        const beads = beesKind ? 2 : 3; // fish tow fatter tails
        const per = beads + 1;
        // chain the legs first (flat records), then spawn them in one call
        const legs = [];
        const dir = new THREE.Vector3(), axis = new THREE.Vector3();
        const pp = new THREE.Vector3(), pv = new THREE.Vector3();
        for (let s = 0; s < nStars; s++) {
          const nSeg = beesKind ? 6 + ((Math.random() * 4) | 0) : 7 + ((Math.random() * 3) | 0);
          const spd = beesKind ? randRange(8, 13) : randRange(18, 26);
          const u0 = randRange(-0.55, 0.9); // hang the swarm in view, not below it
          const a0 = Math.random() * Math.PI * 2;
          const rr0 = Math.sqrt(Math.max(0, 1 - u0 * u0));
          dir.set(rr0 * Math.cos(a0), u0, rr0 * Math.sin(a0));
          pp.copy(pos);
          let t0 = 0;
          const flip = Math.random() < 0.5 ? 1 : 0;
          for (let g2 = 0; g2 < nSeg; g2++) {
            const dur = beesKind ? randRange(0.2, 0.3) : randRange(0.35, 0.5);
            pv.set(dir.x * spd + dvx, dir.y * spd + dvy, dir.z * spd + dvz);
            legs.push(pp.x, pp.y, pp.z, pv.x, pv.y, pv.z, t0, dur, flip);
            ballistic(pp, pv, dur, grav, drg, pp);
            t0 += dur;
            // the veer: rotate the heading 40-70° (bees) / 30-55° (fish)
            // around a random axis perpendicular to it
            axis.set(randRange(-1, 1), randRange(-1, 1), randRange(-1, 1)).cross(dir);
            if (axis.lengthSq() < 1e-4) axis.set(dir.y, -dir.x, 0.11);
            axis.normalize();
            _q1.setFromAxisAngle(axis,
              (beesKind ? randRange(0.7, 1.22) : randRange(0.52, 0.96)) * (Math.random() < 0.5 ? -1 : 1));
            dir.applyQuaternion(_q1);
            // never let the school bore straight down out of the sky
            if (dir.y < -0.75) { dir.y = -dir.y * 0.5; dir.normalize(); }
          }
        }
        const nLegs = legs.length / 9;
        const br = (beesKind ? 5.0 : 6.3) * glow;
        let lj = -1;
        pool.spawn(nLegs * per, (i) => {
          lj++;
          const leg = (lj / per) | 0;
          const seg = lj - leg * per;
          const o = leg * 9;
          const c = legs[o + 8] ? colA : colB;
          const fade = seg === 0 ? 1 : (1 - seg / per) * 0.5;
          pool.set(i,
            legs[o], legs[o + 1], legs[o + 2],
            legs[o + 3], legs[o + 4], legs[o + 5],
            c.r * br * fade, c.g * br * fade, c.b * br * fade,
            time + legs[o + 6] + seg * 0.035,
            legs[o + 7] * (seg === 0 ? randRange(1.08, 1.3) : randRange(0.95, 1.1)),
            (beesKind ? randRange(0.055, 0.08) : randRange(0.10, 0.14))
              * (seg === 0 ? 1 : 0.7) * (0.7 + size * 0.4),
            grav, drg, 0,
            CELL.GLOW, beesKind ? 0.085 : 0.07);
        });
        break;
      }

      case 'dragoneggs': {
        // bismuth delayed-crackle microstars: a dense cloud of dim amber
        // embers hangs almost still (high drag), then pops off like corn —
        // each ember relays to a white-gold flash (shiftT + the shader's
        // ignition pop) and throws a couple of branchy crackle children,
        // the cluster spreading over ~1.2 s. All precomputed at break.
        const nE = Math.round(360 + 240 * size);
        const eGrav = 0.22, eDrag = 1.1;
        const gA = 9.81 * eGrav;
        let dj = -1, evx, evy, evz, eTp;
        pool.spawn(nE * 3, (i) => {
          dj++;
          const seg = dj % 3;
          if (seg === 0) {
            const u = Math.random() * 2 - 1;
            const a = Math.random() * Math.PI * 2;
            const rr = Math.sqrt(1 - u * u);
            const sp = randRange(8, 14) * (0.65 + 0.35 * size);
            evx = rr * Math.cos(a) * sp + dvx;
            evy = u * sp + dvy;
            evz = rr * Math.sin(a) * sp + dvz;
            eTp = randRange(0.5, 1.7); // lazy drift, then the crack
            const life = eTp + randRange(0.1, 0.16);
            pool.set(i, pos.x, pos.y, pos.z, evx, evy, evz,
              1.3, 0.82, 0.3, // dim amber — the "is that all?" phase
              time, life, randRange(0.06, 0.09) * (0.7 + size * 0.4),
              eGrav, eDrag, 0,
              CELL.GLOW, 0, undefined, eTp / life,
              7.2, 6.4, 4.2); // ...it was not
          } else {
            // a crackle child popping off the flash, dead in a fifth of a
            // second — placed on the ember's arc at its pop time
            const k = (1 - Math.exp(-eDrag * eTp)) / eDrag;
            const u = Math.random() * 2 - 1;
            const a = Math.random() * Math.PI * 2;
            const rr = Math.sqrt(1 - u * u);
            const cs = randRange(1.2, 2.8);
            pool.set(i,
              pos.x + evx * k, pos.y + evy * k - gA * (eTp - k) / eDrag, pos.z + evz * k,
              rr * Math.cos(a) * cs, u * cs, rr * Math.sin(a) * cs,
              6.8, 5.8, 3.4,
              time + eTp, randRange(0.1, 0.2),
              randRange(0.10, 0.16) * (0.7 + size * 0.4), 0.3, 1.2, 0,
              CELL.CRACKLE, 0);
          }
        });
        // the frying-pan chorus rides the pop window, two takes offset
        const cpos = pos.clone();
        this.schedule(0.55, () => this.audio.play('crackle', cpos, {
          gain: 0.85, refDistance: 7, send: 0.4, rate: randRange(0.86, 0.96),
        }));
        this.schedule(0.95, () => this.audio.play('crackle', cpos, {
          gain: 0.7, refDistance: 7, send: 0.4, rate: randRange(0.74, 0.84),
        }));
        break;
      }

      case 'spider': {
        // the spider shell: a violent break driving FEW stars out near twice
        // peony speed on maximum shutter — each arm is one star smeared into
        // a long straight metallic thread, and heavy gravity droops only the
        // tips. Wider than a same-caliber peony for a tenth of the stars —
        // the cheapest huge shell in the book.
        const n = Math.round(55 + 40 * size);
        const speed = wideGrandSpeed((12 + 14 * size) * 1.7);
        const beads = 6;
        const grav = randRange(1.1, 1.3);
        // metallic: the shell color pushed most of the way to white-silver
        const mr = (colA.r + (1 - colA.r) * 0.55) * 5.7 * glow;
        const mg = (colA.g + (1 - colA.g) * 0.55) * 5.7 * glow;
        const mb = (colA.b + (1 - colA.b) * 0.55) * 5.7 * glow;
        // half the spiders relay their tips to the accent color late in the
        // fall — the arm ends catch a second composition as they droop
        const tipShift = Math.random() < 0.5 ? 0.74 : 0;
        const s2r = colB.r * 5.7 * glow, s2g = colB.g * 5.7 * glow, s2b = colB.b * 5.7 * glow;
        let sj = -1, svx, svy, svz, sLife, sLag, sSz, sStretch;
        pool.spawn(n * (beads + 1), (i) => {
          sj++;
          const seg = sj % (beads + 1);
          if (seg === 0) {
            const u = Math.random() * 2 - 1;
            const a = Math.random() * Math.PI * 2;
            const rr = Math.sqrt(1 - u * u);
            const sp = speed * randRange(0.94, 1.0); // hard, even break
            svx = rr * Math.cos(a) * sp + dvx;
            svy = u * sp + dvy;
            svz = rr * Math.sin(a) * sp + dvz;
            sLife = randRange(2.0, 2.6) * grandLife;
            sLag = randRange(0.02, 0.032);
            sSz = randRange(0.10, 0.14) * grandPSize;
            sStretch = randRange(0.09, 0.12);
            pool.set(i, pos.x, pos.y, pos.z, svx, svy, svz, mr, mg, mb,
              time, sLife, sSz, grav, 0.35, 0,
              CELL.GLOW, sStretch, undefined, tipShift, s2r, s2g, s2b);
          } else {
            const fade = (1 - seg / (beads + 1)) * 0.55;
            pool.set(i, pos.x, pos.y, pos.z, svx, svy, svz,
              mr * fade, mg * fade, mb * fade,
              time + seg * sLag, sLife * (1 - 0.08 * (seg / (beads + 1))),
              sSz * (0.5 + 0.4 * (1 - seg / (beads + 1))), grav, 0.35, 0,
              CELL.GLOW, sStretch, undefined, tipShift,
              s2r * fade, s2g * fade, s2b * fade);
          }
        });
        if (spec.pistil) spawnPistil(speed, grav, 0.35);
        break;
      }

      case 'farfalle': {
        // Italian butterflies: spinning inserts with two opposed vents, each
        // spraying a pair of spark jets that rotate 2-4 rev/s as the insert
        // tumbles away — every insert paints a fluttering glowing bow-tie.
        // The rotating opposed-pair emission is all precomputed: spark pair
        // p is placed on the insert's closed-form arc at its emission time
        // with the vent azimuth advanced to that moment. Real ones hum;
        // ours honor the audio lock and flutter silently.
        const inserts = Math.round(10 + 8 * size);
        const pairs = 26;
        const seg1 = 1 + pairs * 2;
        const iGrav = 0.35, iDrag = 0.8;
        const gA = 9.81 * iGrav;
        let fj = -1, ivx, ivy, ivz, iT, iPhase, iOmega, iFlip,
          iux, iuy, iuz, iwx, iwy, iwz;
        pool.spawn(inserts * seg1, (i) => {
          fj++;
          const seg = fj % seg1;
          if (seg === 0) {
            const u = Math.random() * 2 - 1;
            const a = Math.random() * Math.PI * 2;
            const rr = Math.sqrt(1 - u * u);
            const sp = randRange(8, 12) * (0.75 + 0.35 * size);
            ivx = rr * Math.cos(a) * sp + dvx;
            ivy = u * sp + dvy;
            ivz = rr * Math.sin(a) * sp + dvz;
            iT = randRange(1.9, 2.7);
            iPhase = Math.random() * Math.PI * 2;
            iOmega = randRange(2, 4) * Math.PI * 2;
            iFlip = Math.random() < 0.5;
            // vent plane: two axes roughly perpendicular to the toss
            const il = Math.hypot(ivx, ivy, ivz) || 1;
            const nx2 = ivx / il, ny2 = ivy / il, nz2 = ivz / il;
            let cx = -nz2, cy = 0, cz = nx2; // n × UP
            let cl = Math.hypot(cx, cy, cz);
            if (cl < 0.05) { cx = 1; cy = 0; cz = 0; cl = 1; }
            iux = cx / cl; iuy = cy / cl; iuz = cz / cl;
            iwx = ny2 * iuz - nz2 * iuy;
            iwy = nz2 * iux - nx2 * iuz;
            iwz = nx2 * iuy - ny2 * iux;
            // the insert itself: a modest tumbling ember
            pool.set(i, pos.x, pos.y, pos.z, ivx, ivy, ivz,
              colA.r * 3.2 * glow, colA.g * 3.2 * glow, colA.b * 3.2 * glow,
              time, iT, 0.09 * (0.7 + size * 0.4), iGrav, iDrag, 0,
              CELL.GLOW, 0.03);
          } else {
            // one wing spark of an opposed pair, on the arc at its moment
            const p = (seg - 1) >> 1;
            const sgn = (seg - 1) & 1 ? -1 : 1;
            const te = ((p + Math.random() * 0.7) / pairs) * iT * 0.96;
            const k = (1 - Math.exp(-iDrag * te)) / iDrag;
            const e = Math.exp(-iDrag * te);
            const phi = iPhase + iOmega * te;
            const jx = iux * Math.cos(phi) + iwx * Math.sin(phi);
            const jy = iuy * Math.cos(phi) + iwy * Math.sin(phi);
            const jz = iuz * Math.cos(phi) + iwz * Math.sin(phi);
            const js = randRange(3.5, 6.5) * sgn;
            const c = iFlip ? colA : colB;
            pool.set(i,
              pos.x + ivx * k, pos.y + ivy * k - gA * (te - k) / iDrag, pos.z + ivz * k,
              jx * js + ivx * e * 0.5, jy * js + (ivy * e - gA * (1 - e) / iDrag) * 0.5, jz * js + ivz * e * 0.5,
              c.r * 6.0 * glow, c.g * 6.0 * glow, c.b * 6.0 * glow,
              time + te, randRange(0.3, 0.45),
              randRange(0.055, 0.075) * (0.7 + size * 0.4), 0.25, 1.0, 0,
              CELL.GLOW, 0.075);
          }
        });
        break;
      }

      case 'tourbillon': {
        // whirlwinds (Handel fired these in 1749): silver spinners thrown
        // up-and-out of the break, each corkscrewing a tight helical ribbon
        // of sparks behind it — drill-bits of light climbing the sky. The
        // helix is pure precompute: spark k sits on the riser's closed-form
        // arc with the emission azimuth advanced 5-8 rev/s, offset 0.8-1.5 m
        // sideways, and hangs where the spinner left it.
        const spinners = Math.round(7 + 5 * size);
        const sparks = 86, popStars = 4;
        const seg1 = 1 + sparks + popStars;
        const tGrav = 0.16, tDrag = 0.55; // burning spinners barely fall
        const gA = 9.81 * tGrav;
        let hj = -1, hvx, hvy, hvz, hT, hPhase, hOmega, hR,
          hux, huy, huz, hwx, hwy, hwz;
        pool.spawn(spinners * seg1, (i) => {
          hj++;
          const seg = hj % seg1;
          if (seg === 0) {
            // the riser: strongly up-biased, with a random lean
            const dy = randRange(0.72, 0.96);
            const a = Math.random() * Math.PI * 2;
            const rr = Math.sqrt(1 - dy * dy);
            const sp = randRange(18, 28) * (0.75 + 0.35 * size);
            hvx = rr * Math.cos(a) * sp + dvx;
            hvy = dy * sp + dvy;
            hvz = rr * Math.sin(a) * sp + dvz;
            hT = 1.4 * randRange(0.85, 1.15);
            hPhase = Math.random() * Math.PI * 2;
            hOmega = randRange(5, 8) * Math.PI * 2;
            hR = randRange(0.8, 1.5);
            const il = Math.hypot(hvx, hvy, hvz) || 1;
            const nx2 = hvx / il, ny2 = hvy / il, nz2 = hvz / il;
            let cx = -nz2, cy = 0, cz = nx2;
            let cl = Math.hypot(cx, cy, cz);
            if (cl < 0.05) { cx = 1; cy = 0; cz = 0; cl = 1; }
            hux = cx / cl; huy = cy / cl; huz = cz / cl;
            hwx = ny2 * huz - nz2 * huy;
            hwy = nz2 * hux - nx2 * huz;
            hwz = nx2 * huy - ny2 * hux;
            pool.set(i, pos.x, pos.y, pos.z, hvx, hvy, hvz,
              5.4 * glow, 5.5 * glow, 6.0 * glow, // silver head
              time, hT, 0.11 * (0.7 + size * 0.4), tGrav, tDrag, 0,
              CELL.GLOW, 0.06);
          } else if (seg <= sparks) {
            const ts = ((seg - 1 + Math.random() * 0.9) / sparks) * hT;
            const k = (1 - Math.exp(-tDrag * ts)) / tDrag;
            const e = Math.exp(-tDrag * ts);
            const phi = hPhase + hOmega * ts;
            const ox = hux * Math.cos(phi) + hwx * Math.sin(phi);
            const oy = huy * Math.cos(phi) + hwy * Math.sin(phi);
            const oz = huz * Math.cos(phi) + hwz * Math.sin(phi);
            pool.set(i,
              pos.x + hvx * k + ox * hR,
              pos.y + hvy * k - gA * (ts - k) / tDrag + oy * hR,
              pos.z + hvz * k + oz * hR,
              ox * randRange(1.2, 2.4) + hvx * e * 0.3,
              oy * randRange(1.2, 2.4) + (hvy * e - gA * (1 - e) / tDrag) * 0.3,
              oz * randRange(1.2, 2.4) + hvz * e * 0.3,
              4.9 * glow, 5.0 * glow, 5.5 * glow,
              time + ts, randRange(0.35, 0.6),
              randRange(0.05, 0.08) * (0.7 + size * 0.4), 0.12, 1.3, 0,
              CELL.GLOW, 0.04);
          } else {
            // terminal mini-pop: a few bright stars where the burn dies
            const k = (1 - Math.exp(-tDrag * hT)) / tDrag;
            const u = Math.random() * 2 - 1;
            const a = Math.random() * Math.PI * 2;
            const rr = Math.sqrt(1 - u * u);
            const cs = randRange(4.5, 7);
            pool.set(i,
              pos.x + hvx * k, pos.y + hvy * k - gA * (hT - k) / tDrag, pos.z + hvz * k,
              rr * Math.cos(a) * cs, u * cs, rr * Math.sin(a) * cs,
              6.5, 6.4, 6.0,
              time + hT, randRange(0.5, 0.8),
              randRange(0.09, 0.13) * (0.7 + size * 0.4), 0.3, 0.9, 0,
              CELL.STAR6, 0);
          }
        });
        // one or two dry cracker pops as spinners spend themselves at apex
        for (let c = 0; c < 2; c++) {
          const cp = pos.clone();
          cp.x += randRange(-8, 8); cp.y += randRange(14, 24); cp.z += randRange(-8, 8);
          this.schedule(1.4 * randRange(0.9, 1.1), () => this.audio.play('cracker', cp, {
            gain: randRange(0.5, 0.7), refDistance: 5, send: 0.4, rate: randRange(0.85, 1.0),
          }));
        }
        break;
      }

      case 'heart':
      case 'smiley':
      case 'star5': {
        // pattern shells: stars pasted to a cardboard former, so the break
        // throws them outward preserving a 2D arrangement. Real crews fire
        // several and hope one faces the crowd; in VR we cheat the plane
        // toward the campsite — normal aimed at the basin's sky-line, then
        // tipped a random 15-25° so volleys don't look machine-aimed. Two
        // tracer beads give the shape enough depth to survive side angles.
        const pts = pattern === 'heart' ? HEART_PTS
          : pattern === 'smiley' ? SMILEY_PTS : STAR5_PTS;
        const n = _v1.set(-pos.x, 40 - pos.y, -pos.z).normalize();
        _q1.setFromAxisAngle(n, Math.random() * Math.PI * 2); // random tilt bearing
        _v2.crossVectors(n, Math.abs(n.y) < 0.9 ? UP : X_AXIS).normalize().applyQuaternion(_q1);
        _q1.setFromAxisAngle(_v2, randRange(0.26, 0.44) * (Math.random() < 0.5 ? -1 : 1));
        n.applyQuaternion(_q1);
        // in-plane frame: u horizontal, w = u × n points sky-up so the
        // heart's notch and the smiley's grin land the right way round
        const ub = _v2.crossVectors(n, UP);
        if (ub.lengthSq() < 0.01) ub.crossVectors(n, X_AXIS);
        ub.normalize();
        const wb = _v3.crossVectors(ub, n).normalize();
        const ux = ub.x, uy = ub.y, uz = ub.z;
        const wx = wb.x, wy = wb.y, wz = wb.z;
        const nx2 = n.x, ny2 = n.y, nz2 = n.z;
        const sp = 13 + 8 * size; // ~1 s expansion to a 25-30 m figure
        const nPts = pts.length / 3;
        // ±6% of the expansion speed in depth (a real former isn't flat) and
        // a dim second copy of the outline shifted off the plane: edge-on
        // the figure reads as a soft double stroke, never a 1-px line
        let gj = -1, gvx, gvy, gvz, gcr, gcg, gcb, gLife, gLag;
        pool.spawn(nPts * 4, (i) => {
          gj++;
          const seg = gj % 4;
          if (seg === 0) {
            const o = ((gj / 4) | 0) * 3;
            const px2 = pts[o], py2 = pts[o + 1];
            const c = pts[o + 2] ? colB : colA;
            const jn = sp * randRange(-0.06, 0.06); // whisker of depth
            gvx = (ux * px2 + wx * py2) * sp + nx2 * jn + dvx + randRange(-0.15, 0.15);
            gvy = (uy * px2 + wy * py2) * sp + ny2 * jn + dvy + randRange(-0.15, 0.15);
            gvz = (uz * px2 + wz * py2) * sp + nz2 * jn + dvz + randRange(-0.15, 0.15);
            gcr = c.r * 5.7 * glow; gcg = c.g * 5.7 * glow; gcb = c.b * 5.7 * glow;
            gLife = randRange(2.2, 2.8);
            gLag = randRange(0.024, 0.038);
            pool.set(i, pos.x, pos.y, pos.z, gvx, gvy, gvz, gcr, gcg, gcb,
              time, gLife, 0.13 * (0.7 + size * 0.5), 0.22, 0.8, 0,
              CELL.GLOW, 0.035);
          } else if (seg < 3) {
            const fade = (1 - seg / 3) * 0.55;
            pool.set(i, pos.x, pos.y, pos.z, gvx, gvy, gvz,
              gcr * fade, gcg * fade, gcb * fade,
              time + seg * gLag, gLife * 0.95,
              0.13 * (0.7 + size * 0.5) * 0.7, 0.22, 0.8, 0,
              CELL.GLOW, 0.035);
          } else {
            // the offset plane: same outline point pushed ~0.8 m/s along the
            // normal, at a third of the light
            pool.set(i, pos.x, pos.y, pos.z,
              gvx + nx2 * 0.8, gvy + ny2 * 0.8, gvz + nz2 * 0.8,
              gcr * 0.33, gcg * 0.33, gcb * 0.33,
              time + gLag, gLife * 0.9,
              0.13 * (0.7 + size * 0.5) * 0.8, 0.22, 0.8, 0,
              CELL.GLOW, 0.035);
          }
        });
        break;
      }

      case 'flare': {
        // parachute flares: the show's breather. A soft pop drops 1 (small)
        // or 3 (display) brilliant magnesium lights that sink at ~3 m/s for
        // 12-18 s, pendulum-swaying, shedding thin smoke and the odd gold
        // drip. The whole descent is precomputed as chained sway legs
        // (closed-form, like every delayed effect here); one emitter entry
        // follows the lead flare's path to drive a pooled light so the
        // desert really is lit by the thing — unlit gracefully if both
        // slots are working fountains. Silent.
        const nF = size < 1 ? 1 : 3;
        const gF = 1.0, dF = 3.2; // terminal ≈ 9.81/3.2 ≈ 3 m/s under canopy
        // stock magnesium loadout: white, strontium red, barium green. A
        // choreographed scene owns its palette instead: the lead flare
        // burns near-white and the wingmen carry the scene's two tones, so
        // a gold-silver interlude never gets a stray green lantern.
        const FLARE_COLS = spec.palette
          ? [[colA.r + (1 - colA.r) * 0.75, colA.g + (1 - colA.g) * 0.75, colA.b + (1 - colA.b) * 0.75],
            [colA.r, colA.g, colA.b], [colB.r, colB.g, colB.b]]
          : [[1, 0.97, 0.9], [1, 0.24, 0.17], [0.38, 1, 0.44]];
        for (let f = 0; f < nF; f++) {
          const col = spec.palette
            ? FLARE_COLS[f % FLARE_COLS.length]
            : FLARE_COLS[(Math.random() * FLARE_COLS.length) | 0];
          const L = randRange(12, 18);
          const p0 = pos.clone();
          p0.x += randRange(-4, 4); p0.y += randRange(-1.5, 1.5); p0.z += randRange(-4, 4);
          // pendulum: one sway plane per flare, legs alternating direction
          const swA = Math.random() * Math.PI * 2;
          const swx = Math.cos(swA), swz = Math.sin(swA);
          const path = [];
          const pp = p0.clone();
          const pv = new THREE.Vector3();
          let t0 = 0, sgn = Math.random() < 0.5 ? 1 : -1;
          while (t0 < L) {
            const dur = Math.min(randRange(1.5, 2.0), L - t0 + 0.01);
            const A = randRange(2.4, 3.8);
            pv.set(
              swx * A * sgn + (t0 === 0 ? dvx * 0.5 : 0),
              -2.6,
              swz * A * sgn + (t0 === 0 ? dvz * 0.5 : 0),
            );
            path.push({ t0, dur, x: pp.x, y: pp.y, z: pp.z, vx: pv.x, vy: pv.y, vz: pv.z });
            ballistic(pp, pv, dur, gF, dF, pp);
            t0 += dur;
            sgn = -sgn;
          }
          // visuals: per sway leg — the flare head, its bloom halo, a few
          // smoke wisps and a couple of gold drips, all birth-offset onto
          // the leg's exact arc
          const seg1 = 9; // head + halo + 5 smoke + 2 drips
          // sized to read from camp: an illumination flare is the brightest
          // object in the valley, and at 80-100 m a 0.25 m glow vanished —
          // the head needs real diameter and the halo needs to swallow it
          const fsz = 0.42 * (0.75 + 0.35 * size);
          const gA = 9.81 * gF;
          let pj = -1;
          pool.spawn(path.length * seg1, (i) => {
            pj++;
            const leg = path[(pj / seg1) | 0];
            const seg = pj % seg1;
            if (seg === 0) {
              // the flare itself: brilliant, with the slow ~5 Hz waver a
              // burning magnesium candle has under a rocking parachute
              pool.set(i, leg.x, leg.y, leg.z, leg.vx, leg.vy, leg.vz,
                col[0] * 7.8, col[1] * 7.8, col[2] * 7.8,
                time + leg.t0 - (leg.t0 > 0 ? 0.02 : 0), leg.dur + 0.1,
                fsz, gF, dF, 5,
                CELL.GLOW, 0);
            } else if (seg === 1) {
              // fat dim halo on the same arc — the lens bloom of a light
              // source far too bright for the night around it
              pool.set(i, leg.x, leg.y, leg.z, leg.vx, leg.vy, leg.vz,
                col[0] * 1.35, col[1] * 1.35, col[2] * 1.35,
                time + leg.t0, leg.dur,
                fsz * 7, gF, dF, 0,
                CELL.GLOW, 0);
            } else if (seg <= 6) {
              // the thin smoke thread every flare hangs above itself
              const ts = Math.random() * leg.dur;
              const k = (1 - Math.exp(-dF * ts)) / dF;
              pool.set(i,
                leg.x + leg.vx * k + randRange(-0.2, 0.2),
                leg.y + leg.vy * k - gA * (ts - k) / dF,
                leg.z + leg.vz * k + randRange(-0.2, 0.2),
                randRange(-0.25, 0.25) + WIND.x * 0.35, randRange(0.1, 0.45), randRange(-0.25, 0.25) + WIND.z * 0.35,
                0.42, 0.42, 0.45,
                time + leg.t0 + ts, randRange(2.5, 5),
                randRange(0.35, 0.65), -0.01, 1.3, -1);
            } else {
              // an occasional gold drip spilling off the burning end
              const ts = Math.random() * leg.dur;
              const k = (1 - Math.exp(-dF * ts)) / dF;
              const e = Math.exp(-dF * ts);
              pool.set(i,
                leg.x + leg.vx * k, leg.y + leg.vy * k - gA * (ts - k) / dF, leg.z + leg.vz * k,
                leg.vx * e + randRange(-1.6, 1.6), -randRange(0.5, 1.5), leg.vz * e + randRange(-1.6, 1.6),
                3.4, 2.4, 1.0,
                time + leg.t0 + ts, randRange(0.6, 1.2) * (Math.random() < 0.55 ? 1 : 0.3),
                randRange(0.04, 0.06), 0.55, 0.9, 26);
            }
          });
          // every flare tows a little canopy prop down its sway path (the
          // 15 s dune-lighting descent has to read at close range too), but
          // only the LEAD flare gets a pooled light — flares come in threes,
          // fountain slots come in twos, and one moving key light already
          // sells the whole cluster
          const canopy = makeFlareCanopy(col);
          canopy.visible = false; // placed on the first update tick
          this.scene.add(canopy);
          this.emitters.push({
            kind: 'flare', age: 0, duration: L, path, g: gF, d: dF,
            color: new THREE.Color(col[0], col[1], col[2]), lightSlot: null,
            intensity: 260 + 240 * Math.min(size, 1.6),
            lit: f === 0, canopy,
          });
        }
        break;
      }

      case 'strobewillow': {
        // strobe willow, the "shimmering sea": a golden willow that goes
        // near-dark a quarter into the fall — and then hundreds of white
        // STAR4 flashes blink asynchronously all down the hanging curtain
        // for seconds, moonlight on waves. Every blink is precomputed on
        // its star's exact fall path (same gravity/drag), phased 0.3-0.5 s
        // apart at random offsets — no scheduled work, no sound.
        const n = Math.round(180 + 105 * size);
        const beads = 3, blinks = 10;
        const seg1 = 1 + beads + blinks;
        const wGrav = 0.42, wDrag = 0.38;
        const gA = 9.81 * wGrav;
        const spBase = randRange(7, 9) * (0.7 + 0.3 * size);
        const dkr = colA.r * 0.4, dkg = colA.g * 0.4, dkb = colA.b * 0.4; // near-dark relay
        let wj = -1, wvx, wvy, wvz, wLife, wLag, wSz;
        pool.spawn(n * seg1, (i) => {
          wj++;
          const seg = wj % seg1;
          if (seg === 0) {
            const u = Math.random() * 2 - 1;
            const a = Math.random() * Math.PI * 2;
            const rr = Math.sqrt(1 - u * u);
            const sp = spBase * randRange(0.55, 1.0);
            wvx = rr * Math.cos(a) * sp + dvx;
            wvy = u * sp + dvy;
            wvz = rr * Math.sin(a) * sp + dvz;
            wLife = randRange(5, 7);
            wLag = randRange(0.026, 0.042);
            wSz = randRange(0.075, 0.105) * (0.7 + size * 0.4);
            pool.set(i, pos.x, pos.y, pos.z, wvx, wvy, wvz,
              colA.r * 5.7 * glow, colA.g * 5.7 * glow, colA.b * 5.7 * glow,
              time, wLife, wSz, wGrav, wDrag, 0,
              CELL.GLOW, 0.055, undefined, 0.25, dkr, dkg, dkb);
          } else if (seg <= beads) {
            const fade = (1 - seg / (beads + 1)) * 0.55;
            pool.set(i, pos.x, pos.y, pos.z, wvx, wvy, wvz,
              colA.r * 5.7 * glow * fade, colA.g * 5.7 * glow * fade, colA.b * 5.7 * glow * fade,
              time + seg * wLag, wLife * 0.96,
              wSz * (0.5 + 0.4 * (1 - seg / (beads + 1))), wGrav, wDrag, 0,
              CELL.GLOW, 0.055, undefined, 0.25, dkr * fade, dkg * fade, dkb * fade);
          } else {
            // a blink: 0.1 s of white STAR4 riding the star's fall path,
            // stratified phases so neighbours never sync up
            const b = seg - beads - 1;
            const bt = wLife * (0.28 + 0.64 * (b + Math.random() * 0.8) / blinks);
            const k = (1 - Math.exp(-wDrag * bt)) / wDrag;
            const e = Math.exp(-wDrag * bt);
            pool.set(i,
              pos.x + wvx * k, pos.y + wvy * k - gA * (bt - k) / wDrag, pos.z + wvz * k,
              wvx * e * 0.92, (wvy * e - gA * (1 - e) / wDrag) * 0.92, wvz * e * 0.92,
              7.5, 7.4, 7.0,
              time + bt, randRange(0.08, 0.13),
              randRange(0.12, 0.18) * (0.7 + size * 0.4), wGrav, wDrag, 0,
              CELL.STAR4, 0);
          }
        });
        if (spec.pistil) spawnPistil(spBase, wGrav, wDrag);
        break;
      }

      case 'lampare': {
        // the lampare: an Italian shell carrying liquid fuel — not sparks,
        // a FIREBALL. A boiling mass of flame quads blooms in a third of a
        // second, rolls white-yellow → orange → deep red (shiftT relay),
        // then leaves a rising ring of black smoke and a handful of gold
        // stragglers. Reads like a movie explosion; the choreography fires
        // it rarely and with sound:'big' — the locked boom already IS the
        // right voice for it.
        const nFl = Math.round(200 + 130 * size);
        const scale2 = 0.65 + 0.45 * size;
        pool.spawn(nFl, (i) => {
          const u2 = Math.random(); // birth stagger: later = looser + bigger
          const u = Math.random() * 2 - 1;
          const a = Math.random() * Math.PI * 2;
          const rr = Math.sqrt(1 - u * u);
          const sp = randRange(8, 15) * scale2 * (0.7 + u2 * 0.6);
          const smoky = Math.random() < 0.6;
          const life = randRange(0.8, 1.4);
          pool.set(i,
            pos.x, pos.y, pos.z,
            rr * Math.cos(a) * sp + dvx, u * sp * 0.85 + dvy, rr * Math.sin(a) * sp + dvz,
            5.6, 4.4, 2.4, // white-yellow furnace core...
            time + u2 * 0.35, life,
            randRange(0.5, 1.0) * scale2 * (1 + u2 * 0.9), -0.06, 1.7, 0,
            smoky ? CELL.SMOKE_A + ((Math.random() * 3) | 0) : CELL.GLOW,
            0, smoky ? randRange(-1.8, 1.8) : 0,
            randRange(0.32, 0.5),
            1.5, 0.22, 0.06); // ...rolling over to deep fuel-fire red
        });
        // the soot: a dark ring of real occluding smoke rising off the ball
        pool.spawn(10, (i) => {
          const a = (i / 10) * Math.PI * 2 + Math.random() * 0.3;
          const rr = randRange(2.5, 4) * scale2;
          pool.set(i,
            pos.x + Math.cos(a) * rr, pos.y + randRange(0.5, 1.5), pos.z + Math.sin(a) * rr,
            Math.cos(a) * 0.7 + WIND.x * 0.4, randRange(1.0, 1.8), Math.sin(a) * 0.7 + WIND.z * 0.4,
            0.16, 0.15, 0.15,
            time + randRange(0.5, 0.9), randRange(4.5, 7.5),
            randRange(1.2, 2.2) * scale2, -0.02, 1.3, -1);
        });
        // gold stragglers thrown clear of the ball
        pool.spawn(14, (i) => {
          const u = Math.random() * 2 - 1;
          const a = Math.random() * Math.PI * 2;
          const rr = Math.sqrt(1 - u * u);
          const sp = randRange(6, 12) * scale2;
          pool.set(i,
            pos.x, pos.y, pos.z,
            rr * Math.cos(a) * sp + dvx, Math.abs(u) * sp * 0.8 + dvy, rr * Math.sin(a) * sp + dvz,
            3.6, 2.5, 1.0,
            time, randRange(1.4, 2.4),
            randRange(0.06, 0.09) * scale2, 0.55, 0.8, 22);
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
      || pattern === 'leaves' || pattern === 'ghost' || pattern === 'horsetail'
      || SELF_TEXTURED.has(pattern);
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
          this.spawnTrail(r.pos, r.vel, dt, time, r.item.type.size, r.item.palette);
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
        // the big rockets leave a body: a charred guide stick tumbles out
        // of the break, thuds into the dunes and lies there
        if (item.typeName === 'rocketLarge' || item.typeName === 'rocketGrand') {
          this._dropStick(r.pos, r.vel, t.stickLen);
        }
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
          e.burnMat?.dispose(); // _spend swaps the husk to CHAR_MAT anyway
          this.emitters.splice(i, 1);
          if (this.items.has(item)) this._spend(item);
          continue;
        }
        if (e.uBurn) e.uBurn.value = n; // the char front tracks the burn
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
          // and the pall of smoke the whole belt earned, drifting downwind
          const pool = this.pool;
          const wdx = WIND.x * 0.5, wdz = WIND.z * 0.5;
          pool.spawn(10, (idx) => {
            const a = item.beltPointAt(Math.random(), _v4);
            pool.set(idx,
              a.x + randRange(-0.1, 0.1), a.y + 0.08, a.z + randRange(-0.1, 0.1),
              randRange(-0.3, 0.3) + wdx, randRange(0.3, 0.7), randRange(-0.3, 0.3) + wdz,
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
      } else if (e.kind === 'flare') {
        // a parachute flare descending: chase the precomputed sway path
        // (burst 'flare' laid it down leg by leg) with one of the pooled
        // emitter lights, so the flare genuinely sweeps light and shadow
        // across the dunes as it sways. If both slots are busy fountains it
        // simply runs unlit — the particle itself carries the brilliance.
        if (e.age >= e.duration) {
          this._releaseEmitterLight(e.lightSlot);
          e.lightSlot = null;
          if (e.canopy) {
            e.canopy.removeFromParent();
            e.canopy.userData.mat?.dispose(); // per-flare tint; geo/tex shared
            e.canopy = null;
          }
          this.emitters.splice(i, 1);
          continue;
        }
        let seg = e.path[0];
        for (let k = 1; k < e.path.length && e.path[k].t0 <= e.age; k++) seg = e.path[k];
        _v3.set(seg.x, seg.y, seg.z);
        _v4.set(seg.vx, seg.vy, seg.vz);
        const legT = e.age - seg.t0;
        ballistic(_v3, _v4, legT, e.g, e.d, _v3);
        if (e.canopy) {
          // the chute rides above the candle and heels away from the swing,
          // like any pendulum bob's suspension
          e.canopy.visible = true;
          e.canopy.position.copy(_v3);
          ballisticVel(_v4, legT, e.g, e.d, _v4);
          _v4.y = 6; // mostly-up suspension direction, leaned by the sway
          e.canopy.quaternion.setFromUnitVectors(UP, _v4.normalize());
        }
        if (e.lit !== false && !e.lightSlot) e.lightSlot = this._acquireEmitterLight(e);
        if (e.lightSlot) {
          const L = e.lightSlot.light;
          L.position.copy(_v3);
          L.color.copy(e.color);
          // snap alight, gutter out over the last stretch, waver in between
          const env = Math.min(1, e.age / 0.4) * Math.min(1, (e.duration - e.age) / 1.5);
          L.intensity = e.intensity * env * (0.8 + Math.random() * 0.4);
        }
      }
    }
    this._updateDebris(dt);
    this.flashes.update(dt);
    this.utilFlashes.update(dt);
    this.flashSprites.update(dt);
    this.fuseLights.update(time);
    // basin wash from recent bursts dies off quickly (half-life ~150ms)
    this.ambientPulse.energy *= Math.exp(-4.6 * dt);

    // feed the particle shader's smoke lighting: the strongest live flash
    // (either pool — a candle muzzle lights nearby haze too) plus the
    // basin-wide burst wash — this is what makes every shell light its own
    // smoke from inside, and old smoke bloom when a new one breaks
    const u = this.pool.uniforms;
    if (u?.uFlashPos) {
      let best = null;
      for (const s of this.flashes.lights) {
        if (s.peak > 0 && (!best || s.light.intensity > best.light.intensity)) best = s;
      }
      for (const s of this.utilFlashes.lights) {
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
