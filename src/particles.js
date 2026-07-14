// Stateless GPU particle pool. The CPU only writes spawn data (position,
// velocity, color, timing, physics params); the vertex shader integrates
// ballistic motion with linear drag analytically every frame, so 30k+
// particles cost almost nothing on the CPU — important for Quest.
//
// Rendering upgrades over a plain additive point cloud, all in ONE draw call:
//  - a texture atlas of real particle sprites (Kenney Particle Pack, CC0 —
//    see assets/textures/particles/): billowy smoke puffs, 4/6-point star
//    sparkles, a branchy crackle burst — plus a procedural gaussian core;
//  - velocity-stretched stars: each glowing star is smeared along its
//    screen-space motion like a long-exposure photo, so bursts read as
//    streaks of fire instead of strings of dots;
//  - premultiplied-alpha blending, so glowing stars stay purely additive
//    while smoke actually OCCLUDES what's behind it — real gunpowder haze
//    that hangs, drifts, and dims the stars falling through it;
//  - smoke is lit: a moonlit ambient base plus the strongest live burst
//    flash, fed in as uniforms — every shell lights its own smoke from
//    inside, and old smoke blooms when the next shell goes off next to it;
//  - relay (color-change) stars: an optional second color + switch point,
//    with an ignition pop at the changeover, like real two-composition stars.

import * as THREE from 'three';

// Atlas layout: 4 columns x 2 rows of 256px cells.
export const CELL = {
  GLOW: 0,       // procedural gaussian core — the default star
  STAR4: 1,      // star_06: 4-point twinkle cross (strobe/glitter)
  STAR6: 2,      // star_09: 6-point flare (ignition sparkles, ray tips)
  CRACKLE: 3,    // spark_04: branchy micro-burst (crackle stars)
  SMOKE_A: 4,    // smoke_04
  SMOKE_B: 5,    // smoke_07
  SMOKE_C: 6,    // smoke_08
  FLASH: 7,      // flare_01: anamorphic burst flash (used by flash sprites)
};
const ATLAS_COLS = 4, ATLAS_ROWS = 2, ATLAS_CELL_PX = 256;
const ATLAS_DIR = 'assets/textures/particles/';
const ATLAS_FILES = {
  [CELL.STAR4]: 'star_06.png',
  [CELL.STAR6]: 'star_09.png',
  [CELL.CRACKLE]: 'spark_04.png',
  [CELL.SMOKE_A]: 'smoke_04.png',
  [CELL.SMOKE_B]: 'smoke_07.png',
  [CELL.SMOKE_C]: 'smoke_08.png',
  [CELL.FLASH]: 'flare_01.png',
};

function drawGaussian(g, cx, cy, r, hard = 0.25) {
  const grad = g.createRadialGradient(cx, cy, 0, cx, cy, r);
  grad.addColorStop(0.0, 'rgba(255,255,255,1)');
  grad.addColorStop(hard, 'rgba(255,255,255,0.85)');
  grad.addColorStop(0.55, 'rgba(255,255,255,0.28)');
  grad.addColorStop(1.0, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(cx - r, cy - r, r * 2, r * 2);
}

/**
 * Composite the sprite atlas at load time: the gaussian core is drawn
 * immediately (so the pool renders from frame one), and each sourced PNG is
 * blitted into its cell as it arrives. No build step — the repo is the site.
 */
function makeAtlas() {
  const c = document.createElement('canvas');
  c.width = ATLAS_COLS * ATLAS_CELL_PX;
  c.height = ATLAS_ROWS * ATLAS_CELL_PX;
  const g = c.getContext('2d');
  const tex = new THREE.CanvasTexture(c);
  tex.flipY = false; // uv math below assumes canvas rows = texture rows
  // placeholder gaussians so nothing renders black before the images land
  for (let i = 0; i < ATLAS_COLS * ATLAS_ROWS; i++) {
    const x = (i % ATLAS_COLS) * ATLAS_CELL_PX, y = ((i / ATLAS_COLS) | 0) * ATLAS_CELL_PX;
    drawGaussian(g, x + 128, y + 128, 120);
  }
  for (const [cell, file] of Object.entries(ATLAS_FILES)) {
    const img = new Image();
    img.onload = () => {
      const x = (cell % ATLAS_COLS) * ATLAS_CELL_PX, y = ((cell / ATLAS_COLS) | 0) * ATLAS_CELL_PX;
      g.clearRect(x, y, ATLAS_CELL_PX, ATLAS_CELL_PX);
      g.drawImage(img, x, y, ATLAS_CELL_PX, ATLAS_CELL_PX);
      tex.needsUpdate = true;
    };
    img.src = ATLAS_DIR + file;
  }
  return tex;
}

const VERT = /* glsl */`
  attribute vec3 aVel;
  attribute vec3 aColor;
  attribute vec3 aColor2;  // relay star's second composition (rgb)
  attribute vec2 aTiming;  // birth, life
  attribute vec4 aMisc;    // size, gravityScale, drag, twinkleFreq
  attribute vec4 aShape;   // atlas cell, stretch (shutter s), spin (rad/s), shiftT
  attribute float aGroundY; // sand height where this particle will land

  uniform float uTime;
  uniform vec2 uRes;        // drawing buffer size in px
  uniform vec3 uSmokeAmbient; // moonlit night base for smoke
  uniform vec3 uSmokePulse;   // basin-wide burst wash (color * energy)
  uniform vec4 uFlashPos;     // strongest live flash light: xyz, w = intensity
  uniform vec3 uFlashColor;
  uniform vec4 uFirePos;      // steady long-lived fire (the colossus): xyz, w
  uniform vec3 uFireColor;

  varying vec3 vColor;
  varying float vAlpha;
  varying float vSmoke;     // 1 = alpha-blended smoke, 0 = additive star
  varying vec4 vSprite;     // rot cos, rot sin, capsule half-length, cell
  varying float vDim;       // streak energy conservation

  void main() {
    float birth = aTiming.x;
    float life = max(aTiming.y, 0.001);
    float age = uTime - birth;
    float n = age / life;

    if (age < 0.0 || n >= 1.0) {
      gl_Position = vec4(0.0, 0.0, 2.0, 1.0); // clipped away
      gl_PointSize = 0.0;
      vAlpha = 0.0;
      vColor = vec3(0.0);
      vSmoke = 0.0;
      vSprite = vec4(1.0, 0.0, 0.0, 0.0);
      vDim = 1.0;
      return;
    }

    float d = max(aMisc.z, 0.0001);
    float e = exp(-d * age);
    float k = (1.0 - e) / d;                                // drag-integrated time
    float gAcc = 9.81 * aMisc.y;
    vec3 pos = position + aVel * k + vec3(0.0, -gAcc, 0.0) * ((age - k) / d);

    // settle on the sand instead of raining through it — embers land and
    // glow on the dunes until they die
    bool settled = pos.y < aGroundY;
    if (settled) pos.y = aGroundY;

    // stable per-particle hash (all stars of one shell share spawn position,
    // so fold velocity in)
    float hash = fract(sin(dot(position.xy + aVel.xy + aVel.zx, vec2(12.9898, 78.233))) * 43758.5453);

    float tw = aMisc.w;
    float cell = aShape.x;
    float env;
    float sizeFalloff;
    if (tw < -0.5) {
      // smoke/haze mode: bloom in gently, linger, thin out — and GROW the
      // whole time, the way a dust cloud spreads. No ignition flash.
      env = smoothstep(0.0, 0.12, n) * pow(1.0 - n, 1.6);
      sizeFalloff = 0.55 + n * 1.45;
      // aColor is the smoke's albedo; light it with the moonlit base, the
      // basin burst-wash, and the strongest live flash (inverse-square-ish)
      vec3 toFlash = uFlashPos.xyz - pos;
      float dist2 = dot(toFlash, toFlash);
      vec3 toFire = uFirePos.xyz - pos;
      float fire2 = dot(toFire, toFire);
      vec3 lit = uSmokeAmbient + uSmokePulse * 0.55
               + uFlashColor * (uFlashPos.w / (60.0 + dist2 * 0.55))
               + uFireColor * (uFirePos.w / (400.0 + fire2 * 0.15));
      vColor = aColor * lit;
      vSmoke = 1.0;
    } else {
      // brightness envelope: hot flash then exponential decay — the decay is
      // deliberately gentle so the display holds its brilliance through the
      // middle of its life instead of dimming right after the break
      env = exp(-n * 1.6) * (1.0 - smoothstep(0.72, 1.0, n));
      // white-hot ignition spike: fresh stars overdrive toward white for the
      // first ~150ms (ACES pushes >1 to white), then cool into their color
      env *= 1.0 + 2.8 * exp(-age * 13.0);

      // twinkle / strobe for crackle stars
      if (tw > 0.0) {
        float s = 0.5 + 0.5 * sin(age * tw + hash * 40.0);
        env *= 0.22 + 2.4 * s * s * s;
      }

      float shiftT = aShape.w;
      if (shiftT > 0.0) {
        // relay star: the first composition burns out and the second catches,
        // with a hot ignition pop right at the changeover
        float relay = smoothstep(shiftT - 0.10, shiftT + 0.10, n);
        vColor = mix(aColor, aColor2, relay);
        env *= 1.0 + 1.5 * exp(-abs(n - shiftT) * 16.0);
      } else {
        // embers shift warm as they die
        vColor = mix(aColor, aColor * vec3(1.0, 0.45, 0.18) + vec3(0.25, 0.05, 0.0), n * n * 0.7);
      }
      sizeFalloff = 1.0 - n * 0.55;
      vSmoke = 0.0;
    }
    vAlpha = env;

    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    vec4 clip = projectionMatrix * mv;
    gl_Position = clip;
    float basePx = aMisc.x * sizeFalloff * uRes.y * projectionMatrix[1][1] * 0.5 / max(0.1, -mv.z);

    // velocity stretch: smear the sprite along its screen-space motion like
    // a long-exposure photo — this is what turns dot-clouds into fire
    float shutter = aShape.y;
    float half_ = 0.0;
    vec2 dir = vec2(1.0, 0.0);
    if (shutter > 0.0 && !settled && basePx > 0.5) {
      vec3 velNow = aVel * e - vec3(0.0, gAcc, 0.0) * (1.0 - e) / d;
      vec4 clipT = projectionMatrix * (modelViewMatrix * vec4(pos - velNow * shutter, 1.0));
      vec2 dpx = (clip.xy / clip.w - clipT.xy / clipT.w) * 0.5 * uRes;
      float lenPx = length(dpx);
      // fill-rate guard: thin stars may stretch far (long thin lines are
      // cheap), but never past an absolute screen-space cap
      lenPx = min(lenPx, min(basePx * 18.0, 260.0));
      if (lenPx > 1.0) {
        float totalPx = basePx + lenPx;
        dir = dpx / max(length(dpx), 1e-4);
        half_ = 1.0 - basePx / totalPx;
        basePx = totalPx;
      }
    }
    // spin / static tilt for textured sprites (smoke tumbles, glitter tilts)
    if (half_ <= 0.0 && cell > 0.5) {
      float baseAng = cell > 2.5 ? hash * 6.2832 : (hash - 0.5) * 0.9;
      float ang = baseAng + aShape.z * age;
      dir = vec2(cos(ang), sin(ang));
    }
    // streaks spread the same light over more pixels — dim them accordingly
    // (gently: the streaks ARE the look, they must stay brilliant)
    vDim = mix(1.0, 1.0 - half_, 0.45);
    vSprite = vec4(dir, half_, cell);
    gl_PointSize = min(basePx, 440.0);
  }
`;

const FRAG = /* glsl */`
  uniform sampler2D uMap;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vSmoke;
  varying vec4 vSprite;
  varying float vDim;

  void main() {
    if (vAlpha <= 0.001) discard;
    // point-space coords in [-1,1], y matching screen-space (NDC) up
    vec2 p = vec2(gl_PointCoord.x * 2.0 - 1.0, 1.0 - gl_PointCoord.y * 2.0);
    // rotate into the sprite/streak frame
    vec2 q = vec2(vSprite.x * p.x + vSprite.y * p.y, -vSprite.y * p.x + vSprite.x * p.y);
    float h = vSprite.z;
    float taper = 1.0;
    if (h > 0.0) {
      // capsule sweep: sample the radial texture along the streak segment.
      // Taper the tail like a long-exposure spark: the head (direction of
      // motion, +x) burns hot, the trail dies away behind it.
      float along = clamp((q.x / h) * 0.5 + 0.5, 0.0, 1.0);
      float r = max(1.0 - h, 1e-3);
      q = vec2(q.x - clamp(q.x, -h, h), q.y) / r;
      if (dot(q, q) > 1.0) discard;
      taper = mix(0.22, 1.15, along * along);
    }
    // atlas cell lookup (4x2). flipY=false: canvas y-down == texture v-down,
    // and our q.y is NDC-up, so flip v.
    float cell = vSprite.w;
    vec2 uv = (q * vec2(0.5, -0.5) + 0.5);
    uv = (vec2(mod(cell, 4.0), floor(cell / 4.0)) + uv) * vec2(0.25, 0.5);
    vec4 t = texture2D(uMap, uv);
    float shape = t.a * t.g;
    if (shape <= 0.004) discard;

    if (vSmoke > 0.5) {
      // alpha-blended smoke: premultiplied output, occludes what's behind
      float a = shape * vAlpha * 0.62;
      gl_FragColor = vec4(vColor * a, a);
    } else {
      // glowing star: pure additive (premultiplied with zero alpha)
      gl_FragColor = vec4(vColor * (shape * vAlpha * vDim * taper), 0.0);
    }
  }
`;

export class ParticlePool {
  constructor(capacity = 32000, groundHeight = null) {
    this.capacity = capacity;
    this.groundHeight = groundHeight; // (x, z) => sand height, for settling
    this.cursor = 0;
    this.dirtyRuns = []; // contiguous [start, count] runs written this frame

    const geo = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(new Float32Array(capacity * 3), 3);
    this.aVel = new THREE.BufferAttribute(new Float32Array(capacity * 3), 3);
    this.aColor = new THREE.BufferAttribute(new Float32Array(capacity * 3), 3);
    this.aColor2 = new THREE.BufferAttribute(new Float32Array(capacity * 3), 3);
    this.aTiming = new THREE.BufferAttribute(new Float32Array(capacity * 2), 2);
    this.aMisc = new THREE.BufferAttribute(new Float32Array(capacity * 4), 4);
    this.aShape = new THREE.BufferAttribute(new Float32Array(capacity * 4), 4);
    this.aGround = new THREE.BufferAttribute(new Float32Array(capacity), 1);
    // birth = -1e3 marks dead
    for (let i = 0; i < capacity; i++) {
      this.aTiming.array[i * 2] = -1e3;
      this.aGround.array[i] = -1e6;
    }

    geo.setAttribute('position', this.aPos);
    geo.setAttribute('aVel', this.aVel);
    geo.setAttribute('aColor', this.aColor);
    geo.setAttribute('aColor2', this.aColor2);
    geo.setAttribute('aTiming', this.aTiming);
    geo.setAttribute('aMisc', this.aMisc);
    geo.setAttribute('aShape', this.aShape);
    geo.setAttribute('aGroundY', this.aGround);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 10000);

    this.atlas = makeAtlas();
    this.uniforms = {
      uTime: { value: 0 },
      uRes: { value: new THREE.Vector2(1024, 1024) },
      uMap: { value: this.atlas },
      // smoke lighting: a cool moonlit base; the pulse and flash slots are
      // fed every frame by FireworksSystem
      uSmokeAmbient: { value: new THREE.Color(0.085, 0.095, 0.13) },
      uSmokePulse: { value: new THREE.Color(0, 0, 0) },
      uFlashPos: { value: new THREE.Vector4(0, -1000, 0, 0) },
      uFlashColor: { value: new THREE.Color(1, 1, 1) },
      // steady fire slot (fed by the colossus; w=0 means "off")
      uFirePos: { value: new THREE.Vector4(0, -1000, 0, 0) },
      uFireColor: { value: new THREE.Color(1, 0.6, 0.3) },
    };

    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      // premultiplied alpha: stars write (rgb, 0) = additive, smoke writes
      // (rgb*a, a) = proper occluding haze — both in the same draw call
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
      fog: false,
    });

    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
  }

  /**
   * Reserve `count` slots; call `fill(i)` for each where the callback sets
   * all per-particle data at pool index i. Runs are recorded per contiguous
   * segment so a ring-buffer wrap uploads two small ranges, not the whole
   * buffer.
   */
  spawn(count, fill) {
    const { capacity } = this;
    let remaining = Math.min(count, capacity);
    while (remaining > 0) {
      const start = this.cursor;
      const run = Math.min(remaining, capacity - start);
      for (let k = 0; k < run; k++) fill(start + k);
      this.cursor = (start + run) % capacity;
      remaining -= run;
      const last = this.dirtyRuns[this.dirtyRuns.length - 1];
      if (last && last[0] + last[1] === start) last[1] += run;
      else this.dirtyRuns.push([start, run]);
    }
  }

  /**
   * Optional trailing args (all effects opt in without touching old sites):
   *   cell     atlas cell (CELL.*); default: smoke cells for smoke mode,
   *            STAR4 cross for fast strobes (twinkle >= 20), else GLOW
   *   stretch  motion-blur shutter in seconds (0 = none); stars default to
   *            a subtle streak, textured sprites to none
   *   spin     sprite rotation rad/s (smoke defaults to a slow tumble)
   *   shiftT   life fraction where a relay star switches to color2 (0 = off)
   *   r2,g2,b2 the second composition's color
   */
  set(i, px, py, pz, vx, vy, vz, r, g, b, birth, life, size, gravity, drag, twinkle,
    cell, stretch, spin, shiftT, r2, g2, b2) {
    const p = this.aPos.array, v = this.aVel.array, c = this.aColor.array;
    const c2 = this.aColor2.array, t = this.aTiming.array, m = this.aMisc.array;
    const sh = this.aShape.array;
    p[i * 3] = px; p[i * 3 + 1] = py; p[i * 3 + 2] = pz;
    v[i * 3] = vx; v[i * 3 + 1] = vy; v[i * 3 + 2] = vz;
    c[i * 3] = r; c[i * 3 + 1] = g; c[i * 3 + 2] = b;
    t[i * 2] = birth; t[i * 2 + 1] = life;
    m[i * 4] = size; m[i * 4 + 1] = gravity; m[i * 4 + 2] = drag; m[i * 4 + 3] = twinkle;

    const smoke = twinkle < -0.5;
    if (cell === undefined) {
      cell = smoke ? CELL.SMOKE_A + ((Math.random() * 3) | 0)
        : twinkle >= 20 ? CELL.STAR4 : CELL.GLOW;
    }
    if (stretch === undefined) stretch = cell === CELL.GLOW ? 0.02 : 0;
    if (spin === undefined) {
      spin = smoke ? (Math.random() < 0.5 ? -1 : 1) * (0.15 + Math.random() * 0.4) : 0;
    }
    sh[i * 4] = cell; sh[i * 4 + 1] = stretch; sh[i * 4 + 2] = spin;
    sh[i * 4 + 3] = shiftT ?? 0;
    c2[i * 3] = r2 ?? r; c2[i * 3 + 1] = g2 ?? g; c2[i * 3 + 2] = b2 ?? b;

    // Sample the sand where this particle ends up (with linear drag the
    // horizontal path converges to spawn + v*k(life)), so the shader can
    // settle it there. Clamped to the spawn height so a particle born in a
    // hollow never pops up onto a sampled crest.
    let gy = -1e6;
    if (this.groundHeight) {
      const d = Math.max(drag, 0.0001);
      const k = (1 - Math.exp(-d * Math.max(life, 0))) / d;
      gy = Math.min(this.groundHeight(px + vx * k, pz + vz * k) + 0.02, py);
    }
    this.aGround.array[i] = gy;
  }

  update(time, drawingBufferWidth, drawingBufferHeight) {
    this.uniforms.uTime.value = time;
    if (drawingBufferHeight) {
      this.uniforms.uRes.value.set(drawingBufferWidth || drawingBufferHeight, drawingBufferHeight);
    }

    if (this.dirtyRuns.length > 0) {
      for (const [attr, itemSize] of [
        [this.aPos, 3], [this.aVel, 3], [this.aColor, 3], [this.aColor2, 3],
        [this.aTiming, 2], [this.aMisc, 4], [this.aShape, 4], [this.aGround, 1],
      ]) {
        attr.clearUpdateRanges();
        if (this.dirtyRuns.length > 64) {
          attr.addUpdateRange(0, this.capacity * itemSize); // degenerate case
        } else {
          for (const [start, count] of this.dirtyRuns) {
            attr.addUpdateRange(start * itemSize, count * itemSize);
          }
        }
        attr.needsUpdate = true;
      }
      this.dirtyRuns.length = 0;
    }
  }
}
