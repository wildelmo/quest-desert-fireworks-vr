// Night sky: gradient dome, star field with twinkle, a milky-way band,
// a textured moon, distant mountain silhouettes and occasional shooting stars.

import * as THREE from 'three';
import { mulberry32, clamp } from './utils.js';
import { CELL } from './particles.js';

const SKY_RADIUS = 1500;

function createSkyDome() {
  const geo = new THREE.SphereGeometry(SKY_RADIUS, 32, 20);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      // linear-light values chosen so the ACES+sRGB output pipe reproduces
      // the pre-tonemap night exactly (solved numerically, not eyeballed) —
      // raw-writing linear colors into an sRGB buffer was crushing the
      // gradient into a handful of banded near-black codes
      topColor: { value: new THREE.Color(0x060709) },
      midColor: { value: new THREE.Color(0x090b13) },
      horizonColor: { value: new THREE.Color(0x151117) },
      glowColor: { value: new THREE.Color(0x221811) },
      uMoonDir: { value: MOON_DIR.clone() },
      uPulse: { value: 0 },
      uWash: { value: new THREE.Color(1, 1, 1) },
    },
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_Position.z = gl_Position.w; // pin to far plane
      }
    `,
    fragmentShader: /* glsl */`
      varying vec3 vDir;
      uniform vec3 topColor, midColor, horizonColor, glowColor;
      uniform vec3 uMoonDir, uWash;
      uniform float uPulse;
      void main() {
        float h = clamp(vDir.y, -0.05, 1.0);
        vec3 col = mix(midColor, topColor, smoothstep(0.12, 0.7, h));
        col = mix(horizonColor, col, smoothstep(0.0, 0.14, h));
        // dusty warm glow hugging the horizon
        float glow = pow(clamp(1.0 - h * 6.0, 0.0, 1.0), 2.5);
        col += glowColor * glow * 0.5;
        // the moon hangs in a wide cool halo, not on flat black: a tight
        // gradient around it plus a very broad sky-brightening toward it
        float md = max(dot(normalize(vDir), uMoonDir), 0.0);
        col += vec3(0.040, 0.047, 0.065) * (pow(md, 18.0) * 0.85 + pow(md, 4.0) * 0.12);
        // big bursts wash the vault: strongest in the horizon dust, a
        // whisper at the zenith
        col += uPulse * (0.15 + 0.85 * glow) * uWash;
        // ordered dither: one LSB of noise breaks the gradient's contours
        col += (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898,78.233))) * 43758.5453) - 0.5) / 255.0;
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = -10;
  mesh.frustumCulled = false;
  return mesh;
}

function starSprite() {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  // tight core with a fast falloff — the old soft blob read "screensaver";
  // real stars are pinpricks with just a whisper of glow
  const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.22, 'rgba(255,255,255,0.8)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.18)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 32);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Milky-way great circle: tilted band (shared by the star scatter and the
// haze glow so they stay aligned)
const BAND_NORMAL = new THREE.Vector3(0.75, 0.25, 0.6).normalize();

function createStars() {
  const rand = mulberry32(1234);
  const COUNT = 4400;
  const MW_COUNT = 7000;
  const N = COUNT + MW_COUNT;
  const positions = new Float32Array(N * 3);
  const colors = new Float32Array(N * 3);
  const sizes = new Float32Array(N);
  const phases = new Float32Array(N);

  const bandNormal = BAND_NORMAL;
  const tmp = new THREE.Vector3();

  let i = 0;
  const put = (dir, size, tint, bright) => {
    positions[i * 3] = dir.x * SKY_RADIUS;
    positions[i * 3 + 1] = dir.y * SKY_RADIUS;
    positions[i * 3 + 2] = dir.z * SKY_RADIUS;
    colors[i * 3] = tint.r * bright;
    colors[i * 3 + 1] = tint.g * bright;
    colors[i * 3 + 2] = tint.b * bright;
    sizes[i] = size;
    phases[i] = rand() * Math.PI * 2;
    i++;
  };

  const tints = [
    new THREE.Color(1.0, 1.0, 1.0),
    new THREE.Color(0.75, 0.85, 1.0),
    new THREE.Color(1.0, 0.9, 0.75),
    new THREE.Color(1.0, 0.8, 0.7),
  ];

  for (let k = 0; k < COUNT; k++) {
    // uniform on sphere, keep above horizon-ish
    const y = rand() * 1.04 - 0.04;
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    tmp.set(Math.cos(a) * r, y, Math.sin(a) * r);
    const mag = Math.pow(rand(), 2.8); // few bright, many dim
    put(tmp, 1.3 + mag * 4.4, tints[(rand() * tints.length) | 0], 0.3 + mag * 0.7);
  }

  for (let k = 0; k < MW_COUNT; k++) {
    // scatter near the band plane with gaussian-ish falloff
    const y = rand() * 2 - 1;
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    tmp.set(Math.cos(a) * r, y, Math.sin(a) * r);
    const distFromBand = Math.abs(tmp.dot(bandNormal));
    if (distFromBand > 0.22 * (0.4 + rand())) { k--; continue; }
    if (tmp.y < -0.05) { k--; continue; }
    const mag = Math.pow(rand(), 3.0);
    put(tmp, 0.9 + mag * 1.9, tints[(rand() * tints.length) | 0], 0.12 + mag * 0.42);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geo.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));

  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
    uniforms: {
      uTime: { value: 0 },
      uMap: { value: starSprite() },
      uPxScale: { value: 1 },
    },
    vertexShader: /* glsl */`
      attribute float aSize;
      attribute float aPhase;
      varying vec3 vColor;
      varying float vTwinkle;
      uniform float uTime;
      uniform float uPxScale;
      void main() {
        vColor = color;
        vTwinkle = 0.75 + 0.25 * sin(uTime * (0.5 + fract(aPhase) * 2.0) + aPhase * 7.0);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_Position.z = gl_Position.w * 0.9999;
        // gl_PointSize is eye-buffer pixels: the sizes are authored for a
        // 1080-tall buffer, so a Quest eye buffer (~2000 px) scales them up
        // rather than shrinking every star to sub-pixel shimmer; the floor
        // keeps the dimmest stars from vanishing between samples
        gl_PointSize = max(aSize * uPxScale, 1.5);
      }
    `,
    fragmentShader: /* glsl */`
      varying vec3 vColor;
      varying float vTwinkle;
      uniform sampler2D uMap;
      void main() {
        vec4 t = texture2D(uMap, gl_PointCoord);
        vec3 col = vColor * vTwinkle;
        // ACES+sRGB output boosts dim values hard (a 0.1 star lands ~3x
        // brighter); this peak-keyed gain re-seats the magnitude curve so
        // faint stars stay faint while first-magnitude ones keep their bite
        float pk = max(col.r, max(col.g, col.b));
        col *= 0.21 + 1.15 * pk * pk * pk * pk;
        col += (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898,78.233))) * 43758.5453) - 0.5) / 255.0;
        gl_FragColor = vec4(col, t.a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    vertexColors: true,
  });

  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = -9;
  return points;
}

// Fallback texture if the Gaia photo fails to load (e.g. offline dev server
// missing assets): the old procedural bake — gaussian band, fBm star-cloud
// knots, a dark dust rift. It reads more "silver cloud" than galaxy, which
// is why the real photograph below replaced it as the primary source.
function bakeMilkyWayTexture(bandNormal) {
  const W = 768, H = 384;

  // seeded value noise on a hashed integer lattice
  const rand = mulberry32(9182);
  const perm = new Uint8Array(512);
  for (let i = 0; i < 256; i++) perm[i] = i;
  for (let i = 255; i > 0; i--) {
    const k = (rand() * (i + 1)) | 0;
    const t = perm[i]; perm[i] = perm[k]; perm[k] = t;
  }
  for (let i = 0; i < 256; i++) perm[256 + i] = perm[i];
  const lat = (x, y, z) => perm[(perm[(perm[x & 255] + y) & 255] + z) & 255] / 255;
  const sm = (t) => t * t * (3 - 2 * t);
  const vnoise = (x, y, z) => {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const xf = sm(x - xi), yf = sm(y - yi), zf = sm(z - zi);
    const l = (dx, dy, dz) => lat(xi + dx, yi + dy, zi + dz);
    const mix = (a, b, t) => a + (b - a) * t;
    return mix(
      mix(mix(l(0, 0, 0), l(1, 0, 0), xf), mix(l(0, 1, 0), l(1, 1, 0), xf), yf),
      mix(mix(l(0, 0, 1), l(1, 0, 1), xf), mix(l(0, 1, 1), l(1, 1, 1), xf), yf),
      zf,
    );
  };
  const fbm = (x, y, z, oct) => {
    let v = 0, amp = 0.5, f = 1;
    for (let o = 0; o < oct; o++) {
      v += amp * vnoise(x * f, y * f, z * f);
      amp *= 0.5; f *= 2.03;
    }
    return v / (1 - Math.pow(0.5, oct));
  };

  // orthonormal frame of the band plane — noise is sampled in band
  // coordinates so the wisps stretch along the stream, not across it
  const uAxis = new THREE.Vector3(1, 0, 0).cross(bandNormal).normalize();
  const vAxis = new THREE.Vector3().crossVectors(bandNormal, uAxis).normalize();

  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  const img = g.createImageData(W, H);
  const data = img.data;

  for (let py = 0; py < H; py++) {
    // matches SphereGeometry's equirect UVs: canvas top row = zenith
    const theta = (py / H) * Math.PI;
    const st = Math.sin(theta), y = Math.cos(theta);
    for (let px = 0; px < W; px++) {
      const phi = (px / W) * Math.PI * 2;
      const dx = -Math.cos(phi) * st, dz = Math.sin(phi) * st;
      const d = dx * bandNormal.x + y * bandNormal.y + dz * bandNormal.z;
      if (Math.abs(d) > 0.52) continue; // far off-band: stays black
      // angle along the band's great circle
      const bu = Math.atan2(
        dx * vAxis.x + y * vAxis.y + dz * vAxis.z,
        dx * uAxis.x + y * uAxis.y + dz * uAxis.z,
      );
      // anisotropic sample space: 1 unit along the band ~ 5 units across it
      const nx = Math.cos(bu) * 2.1, ny = Math.sin(bu) * 2.1, nz = d * 10.5;
      const n = fbm(nx, ny, nz, 4);
      const clouds = 0.3 + 1.5 * Math.pow(n, 1.8);
      const core = Math.exp(-(d * d) / (2 * 0.105 * 0.105));
      const wide = 0.2 * Math.exp(-(d * d) / (2 * 0.26 * 0.26));
      // dark dust lane winding slightly off the centerline
      const wander = (vnoise(Math.cos(bu) * 1.4 + 40, Math.sin(bu) * 1.4, 7.7) - 0.5) * 0.1;
      const r2 = fbm(nx + 17.3, ny + 9.1, nz * 0.6, 3);
      const rift = Math.exp(-((d + wander) ** 2) / (2 * 0.055 * 0.055)) *
        (r2 > 0.45 ? Math.min(1, (r2 - 0.45) / 0.2) : 0);
      // faint by design: the belt should whisper behind the star points the
      // way it does over a real high desert, not glow like aurora
      const I = Math.max(0, (core * clouds + wide * (0.35 + 0.65 * n)) * (1 - 0.82 * rift));
      // warm star-cloud cores, cool blue outskirts
      const warm = vnoise(nx * 0.6 + 80, ny * 0.6, nz * 0.4);
      const idx = (py * W + px) * 4;
      data[idx] = Math.min(255, I * (54 + warm * 28));
      data[idx + 1] = Math.min(255, I * (59 + warm * 17));
      data[idx + 2] = Math.min(255, I * (77 - warm * 16));
      data[idx + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Where the galactic core should hang in the scene: ahead of the default
// view and to the right, ~30 degrees up — clear of the moon, over the show.
const CORE_DIR = new THREE.Vector3(0.4, 0.5, -0.75).normalize();

// Base brightness of the Gaia band. Held down so the belt whispers behind
// the star points rather than glowing like aurora; the altitude extinction
// mask below (airmass eats the band near the horizon) is what lets this sit
// higher than the old flat 0.056 without reading as a second moonrise.
const MILKYWAY_LEVEL = 0.13;

// The Milky Way itself: ESA Gaia's all-sky map — an actual image of the
// night sky assembled from ~1.8 billion measured stars — laid over the
// gradient dome additively, so black sky adds nothing and the band, the
// Great Rift dust lanes and the Magellanic Clouds come through for real.
// Returns { group, state }: state.mat lands once a texture is in, so
// update() can breathe the band's level against the burst wash.
function createMilkyWay(bandNormal) {
  const group = new THREE.Group();
  const state = { mat: null };

  const makeDome = (tex) => {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const mat = new THREE.MeshBasicMaterial({
      map: tex, side: THREE.BackSide, blending: THREE.AdditiveBlending,
      transparent: true, depthWrite: false, fog: false,
    });
    mat.color.setScalar(MILKYWAY_LEVEL);
    // altitude extinction: near the horizon the band shines through ~40
    // airmasses of dust and dies out — and it stops the additive texture
    // from washing the warm horizon glow with a hard galactic edge
    mat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying float vAltMW;')
        .replace('#include <begin_vertex>',
          '#include <begin_vertex>\n  vAltMW = normalize((modelMatrix * vec4(position, 1.0)).xyz).y;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vAltMW;')
        .replace('#include <color_fragment>',
          '#include <color_fragment>\n  diffuseColor.rgb *= smoothstep(0.015, 0.26, vAltMW);');
    };
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(SKY_RADIUS * 0.99, 48, 24), mat);
    mesh.renderOrder = -9.5; // over the dome, under the star points
    mesh.frustumCulled = false;
    state.mat = mat;
    return mesh;
  };

  new THREE.TextureLoader().load(
    'assets/textures/milkyway_gaia_4k.jpg',
    (tex) => {
      const mesh = makeDome(tex);
      // the photo is equirect in galactic coordinates, so its equator IS the
      // Milky Way; tip the sphere's pole onto the band normal shared with
      // the star scatter so both layers trace the same great circle
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), bandNormal);
      // then spin about that pole to park the galactic core (texture center,
      // which SphereGeometry maps to local +x) at the band point nearest
      // CORE_DIR
      const coreNow = new THREE.Vector3(1, 0, 0).applyQuaternion(mesh.quaternion);
      const target = CORE_DIR.clone()
        .addScaledVector(bandNormal, -CORE_DIR.dot(bandNormal)).normalize();
      const spin = Math.atan2(
        new THREE.Vector3().crossVectors(coreNow, target).dot(bandNormal),
        coreNow.dot(target),
      );
      mesh.rotateY(spin);
      group.add(mesh);
    },
    undefined,
    () => { group.add(makeDome(bakeMilkyWayTexture(bandNormal))); },
  );

  return { group, state };
}

function moonTexture() {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0.0, 'rgba(235,235,225,1)');
  grad.addColorStop(0.72, 'rgba(210,212,205,1)');
  grad.addColorStop(0.86, 'rgba(180,185,182,0.9)');
  grad.addColorStop(1.0, 'rgba(160,165,165,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  // craters
  const rand = mulberry32(77);
  for (let k = 0; k < 26; k++) {
    const a = rand() * Math.PI * 2;
    const r = rand() * size * 0.34;
    const x = size / 2 + Math.cos(a) * r;
    const y = size / 2 + Math.sin(a) * r;
    const cr = 3 + rand() * 14;
    const cg = g.createRadialGradient(x, y, 0, x, y, cr);
    cg.addColorStop(0, 'rgba(150,152,148,0.35)');
    cg.addColorStop(1, 'rgba(150,152,148,0)');
    g.fillStyle = cg;
    g.beginPath(); g.arc(x, y, cr, 0, Math.PI * 2); g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export const MOON_DIR = new THREE.Vector3(-0.45, 0.62, -0.55).normalize();

// Tiny equirect environment map for image-based lighting: the deep-blue
// vault, the warm dust glow at the horizon, and a bright moon hotspot.
// Assigned to scene.environment so every MeshStandardMaterial picks up a
// believable night sheen — glossy nose cones catch the moon, sand crests
// pick up cool skylight. 128x64 is plenty: it's only ever seen as blur.
export function createNightEnvMap() {
  const w = 128, h = 64;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');

  // sky vault -> horizon -> ground (canvas top row = straight up)
  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0.0, '#05070f');
  grad.addColorStop(0.30, '#0b1126');
  grad.addColorStop(0.46, '#2a2333');
  grad.addColorStop(0.50, '#4a3524');
  grad.addColorStop(0.54, '#241c12');
  grad.addColorStop(1.0, '#0d0a06');
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);

  // moon hotspot at MOON_DIR, matching three's equirect convention:
  // u = atan2(z, x) / 2pi + 0.5, v(up) = asin(y) / pi + 0.5 (canvas y flipped)
  const mu = (Math.atan2(MOON_DIR.z, MOON_DIR.x) / (Math.PI * 2) + 0.5) * w;
  const mv = (1 - (Math.asin(MOON_DIR.y) / Math.PI + 0.5)) * h;
  const glow = g.createRadialGradient(mu, mv, 0, mu, mv, 14);
  glow.addColorStop(0, 'rgba(255,252,240,1)');
  glow.addColorStop(0.25, 'rgba(190,205,235,0.55)');
  glow.addColorStop(1, 'rgba(150,170,215,0)');
  g.fillStyle = glow;
  g.fillRect(0, 0, w, h);

  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Fallback disc if the photo texture fails to load (e.g. offline dev server
// missing assets) — the old painted-canvas moon.
function createSpriteMoon(position) {
  const mat = new THREE.SpriteMaterial({
    map: moonTexture(),
    transparent: true,
    depthWrite: false,
    fog: false,
  });
  const moon = new THREE.Sprite(mat);
  moon.position.copy(position);
  moon.scale.setScalar(95);
  moon.renderOrder = -8;
  return moon;
}

function createMoon() {
  const group = new THREE.Group();
  const position = MOON_DIR.clone().multiplyScalar(SKY_RADIUS * 0.92);

  // The moon itself: a real LRO photo mosaic of the near side wrapped on a
  // sphere, its mapped face turned toward the camp. A full moon is lit
  // head-on and reads flat, so an unlit material is both correct and cheap;
  // the color multiplier keeps the disc luminous through ACES tone mapping.
  new THREE.TextureLoader().load(
    'assets/textures/moon_2k.jpg',
    (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      const mat = new THREE.MeshBasicMaterial({ map: tex, fog: false });
      mat.color.setRGB(1.7, 1.66, 1.56);
      const moon = new THREE.Mesh(new THREE.SphereGeometry(56, 48, 32), mat);
      moon.position.copy(position);
      // sphere UV seam puts the texture's central meridian along local +x;
      // aim that at the origin so the familiar maria face the viewer
      moon.quaternion.setFromUnitVectors(
        new THREE.Vector3(1, 0, 0), MOON_DIR.clone().negate(),
      );
      moon.renderOrder = -8;
      group.add(moon);
    },
    undefined,
    () => { group.add(createSpriteMoon(position)); },
  );

  // halo
  const haloC = document.createElement('canvas');
  haloC.width = haloC.height = 128;
  const hg = haloC.getContext('2d');
  const hgrad = hg.createRadialGradient(64, 64, 0, 64, 64, 64);
  hgrad.addColorStop(0, 'rgba(190,200,220,0.28)');
  hgrad.addColorStop(0.4, 'rgba(170,185,215,0.10)');
  hgrad.addColorStop(1, 'rgba(170,185,215,0)');
  hg.fillStyle = hgrad;
  hg.fillRect(0, 0, 128, 128);
  const haloTex = new THREE.CanvasTexture(haloC);
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: haloTex, transparent: true, depthWrite: false, fog: false,
    blending: THREE.AdditiveBlending,
  }));
  halo.position.copy(position);
  halo.scale.setScalar(340);
  halo.renderOrder = -9;
  group.add(halo);

  return group;
}

// Returns { group, washU }: washU is a shared color uniform both silhouette
// rings add in their fragment stage, so the ridge line lifts with the
// basin-wide burst wash instead of staying dead cardboard mid-finale.
function createMountains() {
  // Two jagged silhouette rings at different distances.
  const group = new THREE.Group();
  const washU = { value: new THREE.Color(0, 0, 0) };
  const make = (radius, baseH, varH, color, seed) => {
    const rand = mulberry32(seed);
    const N = 140;
    const positions = [];
    const heights = [];
    for (let k = 0; k <= N; k++) {
      const a = (k / N) * Math.PI * 2;
      let h = baseH + varH * (
        0.55 * Math.sin(a * 3 + rand() * 0.2) +
        0.9 * Math.abs(Math.sin(a * 7.3 + seed)) +
        rand() * 0.8
      );
      if (rand() < 0.12) h *= 1.5; // occasional peak
      heights.push(Math.max(2, h));
      positions.push(a);
    }
    const verts = [];
    for (let k = 0; k < N; k++) {
      const a0 = positions[k], a1 = positions[k + 1];
      const x0 = Math.cos(a0) * radius, z0 = Math.sin(a0) * radius;
      const x1 = Math.cos(a1) * radius, z1 = Math.sin(a1) * radius;
      const h0 = heights[k], h1 = heights[k + 1];
      // two triangles: base(-20) to peaks
      verts.push(x0, -20, z0, x1, -20, z1, x0, h0, z0);
      verts.push(x1, -20, z1, x1, h1, z1, x0, h0, z0);
    }
    const geo = new THREE.BufferGeometry();
    const posAttr = new Float32Array(verts);
    geo.setAttribute('position', new THREE.BufferAttribute(posAttr, 3));
    // atmospheric perspective: ridgelines dissolve slightly into the sky
    // glow instead of cutting a hard cardboard edge against it. The dissolve
    // target must be the dome's own warm horizon tone — a cool blue lifts
    // the ridge BRIGHTER than the sky behind it and reads as paper cutouts.
    const base = new THREE.Color(color);
    const top = base.clone().lerp(new THREE.Color(0x191410), 0.45);
    const cols = new Float32Array(posAttr.length);
    const cTmp = new THREE.Color();
    for (let k = 0; k < posAttr.length; k += 3) {
      const t = Math.min(1, Math.max(0, (posAttr[k + 1] + 20) / (baseH + varH * 2 + 20)));
      cTmp.copy(base).lerp(top, t * t);
      cols[k] = cTmp.r; cols[k + 1] = cTmp.g; cols[k + 2] = cTmp.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, side: THREE.DoubleSide });
    // burst wash: additive lift keyed to the vertex color so the already-
    // brighter ridge tops answer hardest (multiplying near-black does nothing)
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uWash = washU;
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform vec3 uWash;')
        .replace('#include <color_fragment>',
          '#include <color_fragment>\n  diffuseColor.rgb += uWash * (0.2 + dot(vColor.rgb, vec3(6.0)));');
    };
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = -7;
    return mesh;
  };
  group.add(make(1250, 40, 90, 0x070911, 5));
  group.add(make(950, 25, 55, 0x0b0e18, 11));
  return { group, washU };
}

// A shooting star drawn through the shared particle pool: ~26 short-lived
// glow grains ignite in sequence along the path (velocity-stretched into a
// continuous streak) with a brief flare where the meteor burns out. Costs
// zero draw calls — the two old 1-px THREE.Line streaks are gone.
const METEOR_TINTS = [
  [1.0, 1.0, 1.0], [1.0, 1.0, 1.0],       // most are white-hot
  [0.78, 1.0, 0.84],                      // magnesium green
  [1.0, 0.84, 0.62],                      // sodium orange
];

class ShootingStar {
  constructor(pool) {
    this.pool = pool;
    this.cooldown = 6 + Math.random() * 14;
  }

  update(dt, time) {
    this.cooldown -= dt;
    if (this.cooldown > 0) return;
    this.cooldown = 8 + Math.random() * 20;
    const pool = this.pool;
    if (!pool) return;

    const a = Math.random() * Math.PI * 2;
    const y = 0.45 + Math.random() * 0.4;
    const r = Math.sqrt(1 - y * y);
    const R = SKY_RADIUS * 0.95;
    const ox = Math.cos(a) * r * R, oy = y * R, oz = Math.sin(a) * r * R;
    const dx0 = Math.random() - 0.5, dy0 = -0.35 - Math.random() * 0.3, dz0 = Math.random() - 0.5;
    const dl = Math.hypot(dx0, dy0, dz0);
    const dx = dx0 / dl, dy = dy0 / dl, dz = dz0 / dl;
    const len = 250 + Math.random() * 300;
    const dur = 0.55 + Math.random() * 0.25;
    const speed = len / dur;
    const tint = METEOR_TINTS[(Math.random() * METEOR_TINTS.length) | 0];

    const N = 26;
    let k = 0;
    pool.spawn(N, (i) => {
      const t = k++ / (N - 1);
      // each grain ignites as the head passes it, drifts on at a fraction
      // of meteor speed (the stretch shader smears it along that motion),
      // and cools out behind — a long-exposure streak, not a dotted line
      const b = 0.4 + 0.55 * t; // the head end burns brightest
      pool.set(i,
        ox + dx * len * t, oy + dy * len * t, oz + dz * len * t,
        dx * speed * 0.22, dy * speed * 0.22, dz * speed * 0.22,
        tint[0] * b, tint[1] * b, tint[2] * b,
        time + t * dur, 0.2 + 0.16 * Math.random(),
        4.5 + Math.random() * 2.5, 0, 0, 0,
        CELL.GLOW, 0.28, 0);
    });
    // terminal flare: the pop where it burns out
    const ex = ox + dx * len, ey = oy + dy * len, ez = oz + dz * len;
    pool.spawn(3, (i) => {
      const j = i % 3;
      pool.set(i,
        ex, ey, ez,
        dx * 8, dy * 8, dz * 8,
        tint[0] * 1.1, tint[1] * 1.05, tint[2],
        time + dur, j === 2 ? 0.7 : 0.4,
        j === 0 ? 13 : j === 1 ? 22 : 6, 0, 0, 0,
        j === 0 ? CELL.STAR6 : CELL.GLOW, 0, 0);
    });
  }
}

export function createSky(scene, pool = null) {
  const dome = createSkyDome();
  const stars = createStars();
  const moon = createMoon();
  const mountains = createMountains();
  const haze = createMilkyWay(BAND_NORMAL);
  scene.add(dome, stars, haze.group, moon, mountains.group);
  const shooters = [new ShootingStar(pool), new ShootingStar(pool)];

  const du = dome.material.uniforms;
  const su = stars.material.uniforms;
  // the horizon/fog handshake: world.js seeds scene.fog from this so far
  // terrain and the mesas dissolve INTO the dome's horizon band instead of
  // fogging toward some unrelated navy (linear-light, same space fog mixes in)
  const fogColor = du.horizonColor.value.clone().lerp(du.glowColor.value, 0.4);

  return {
    fogColor,
    update(dt, time, pulse) {
      su.uTime.value = time;
      for (const s of shooters) s.update(dt, time);
      // the vault answers big bursts: dome wash up, milky way politely down
      // (the band must never fight the show for the same sky)
      const e = pulse ? Math.min(pulse.energy, 2.6) : 0;
      du.uPulse.value = e * 0.045;
      if (pulse) du.uWash.value.copy(pulse.color);
      if (pulse) mountains.washU.value.copy(pulse.color).multiplyScalar(e * 0.02);
      const mw = haze.state.mat;
      if (mw) mw.color.setScalar(MILKYWAY_LEVEL * (1 - 0.7 * Math.min(1, e)));
    },
    setViewport(fbWidth, fbHeight) {
      // star sizes are authored in 1080-buffer pixels; rescale to the real
      // eye buffer so stars hold their angular size across devices
      su.uPxScale.value = clamp((fbHeight || 1080) / 1080, 1, 2.5);
    },
  };
}
