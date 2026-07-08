// Procedural desert terrain: rolling dunes flattened near the campsite,
// with an analytic height function so gameplay code can sample the ground
// anywhere (planting fireworks, walking, item drops).

import * as THREE from 'three';
import { fbm2, valueNoise2, smoothstep, mulberry32 } from './utils.js';

export const TERRAIN_SIZE = 700;
const SEGMENTS = 180;

export function terrainHeight(x, z) {
  // Long soft dune swells, slightly anisotropic (wind direction), plus fine ripple.
  const dunes = fbm2(x * 0.006, z * 0.011, 4) * 9.0;
  const swell = valueNoise2(x * 0.0016 + 3.7, z * 0.0016 - 1.2) * 14.0;
  const ripple = valueNoise2(x * 0.35, z * 0.09) * 0.05;
  let h = dunes + swell + ripple;

  // Flatten the campsite: full flatness within ~9 m of origin, blending out to 40 m.
  const d = Math.hypot(x, z);
  const flat = smoothstep(9, 40, d);
  return h * flat;
}

export function terrainNormal(x, z, out = new THREE.Vector3()) {
  const e = 0.35;
  const hL = terrainHeight(x - e, z), hR = terrainHeight(x + e, z);
  const hD = terrainHeight(x, z - e), hU = terrainHeight(x, z + e);
  return out.set(hL - hR, 2 * e, hD - hU).normalize();
}

function makeSandTexture() {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#8a6f4d';
  ctx.fillRect(0, 0, size, size);

  // grain
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * 26;
    d[i] += n; d[i + 1] += n * 0.9; d[i + 2] += n * 0.75;
  }
  ctx.putImageData(img, 0, 0);

  // faint wind ripples
  ctx.globalAlpha = 0.08;
  ctx.strokeStyle = '#5c4830';
  ctx.lineWidth = 3;
  for (let y = -20; y < size + 20; y += 9) {
    ctx.beginPath();
    for (let x = 0; x <= size; x += 16) {
      const yy = y + Math.sin(x * 0.05 + y * 0.7) * 4 + Math.sin(x * 0.013) * 6;
      x === 0 ? ctx.moveTo(x, yy) : ctx.lineTo(x, yy);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(60, 60);
  tex.anisotropy = 4;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Tangent-space normal map for the sand: wind ripples plus per-pixel grain,
// baked from a heightfield. Everything is built from integer-cycle sines (or
// pure per-pixel noise), so the texture tiles with no seam at repeat 60.
function makeSandNormalMap() {
  const size = 256;
  const TAU = Math.PI * 2;
  const rand = mulberry32(9182);
  const H = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      // ripple crests, meandering, with drifting amplitude (~50 cm
      // wavelength at repeat 60 over the 700 m terrain). Kept faint —
      // regular stripes read as corduroy, not sand; the meander and the
      // patchy amplitude are what keep them organic.
      const meander = 2.3 * Math.sin(TAU * (v * 2 + 0.13)) + 1.1 * Math.sin(TAU * (v * 7 + 0.61))
        + 0.6 * Math.sin(TAU * (u * 3 + v * 4));
      const patch = Math.max(0, Math.sin(TAU * (v * 3) + Math.sin(TAU * u * 2)) * 0.7 + 0.5);
      const ripple = Math.sin(TAU * (u * 23) + meander) * patch;
      // secondary faint set at a slight angle (cross-wind history)
      const ripple2 = 0.3 * Math.sin(TAU * (u * 41 + v * 5) + 1.7);
      const grain = (rand() - 0.5) * 0.9;
      H[y * size + x] = ripple * 0.35 + ripple2 + grain;
    }
  }
  const img = new Uint8ClampedArray(size * size * 4);
  const at = (x, y) => H[((y + size) % size) * size + ((x + size) % size)];
  const S = 1.4; // slope strength
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * S;
      const dy = (at(x, y + 1) - at(x, y - 1)) * S;
      const inv = 1 / Math.hypot(dx, dy, 1);
      const o = (y * size + x) * 4;
      img[o] = (-dx * inv * 0.5 + 0.5) * 255;
      img[o + 1] = (-dy * inv * 0.5 + 0.5) * 255;
      img[o + 2] = (inv * 0.5 + 0.5) * 255;
      img[o + 3] = 255;
    }
  }
  const c = document.createElement('canvas');
  c.width = c.height = size;
  c.getContext('2d').putImageData(new ImageData(img, size, size), 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(60, 60);
  tex.anisotropy = 4;
  return tex;
}

// View-dependent sand glitter, injected into the standard shader: sparse
// hashed cells flare as the view direction (or the light on the sand)
// changes — moonlit sand sparkles, and every burst overhead makes the
// dunes shimmer. Head sway in VR is what sells it.
function injectGlitter(shader) {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
    .replace('#include <fog_vertex>',
      '#include <fog_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
    .replace('#include <opaque_fragment>', /* glsl */`
      {
        vec3 gDir = normalize(cameraPosition - vWPos);
        vec2 gCell = floor(vWPos.xz * 220.0);
        float gh = fract(sin(dot(gCell, vec2(12.9898, 78.233))) * 43758.5453);
        // each grain has its own view-angle phase; a narrow window shines
        float gPhase = fract(gh + dot(gDir, vec3(2.17, 3.61, 2.93)) * (0.35 + gh));
        float glint = smoothstep(0.996, 1.0, gPhase);
        float gDist = length(cameraPosition - vWPos);
        // brighter sand (burst flashes, torch) -> hotter glints
        float gLum = dot(outgoingLight, vec3(1.2));
        outgoingLight += vec3(0.9, 0.95, 1.0)
          * (glint * exp(-gDist * 0.12) * (0.08 + min(1.0, gLum * 1.4)) * 0.22);
      }
      #include <opaque_fragment>`);
}

export function createTerrain() {
  const geo = new THREE.PlaneGeometry(TERRAIN_SIZE, TERRAIN_SIZE, SEGMENTS, SEGMENTS);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const base = new THREE.Color('#8f7350');
  const crest = new THREE.Color('#a8815a');
  const low = new THREE.Color('#6d5a40');
  const c = new THREE.Color();

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const h = terrainHeight(x, z);
    pos.setY(i, h);
    // tint crests lighter, hollows darker; subtle patchiness
    const t = smoothstep(-8, 12, h) + valueNoise2(x * 0.02 + 9, z * 0.02) * 0.15;
    c.copy(low).lerp(base, Math.min(1, Math.max(0, t * 1.4))).lerp(crest, smoothstep(0.55, 1, t));
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({
    map: makeSandTexture(),
    normalMap: makeSandNormalMap(),
    normalScale: new THREE.Vector2(0.4, 0.4),
    vertexColors: true,
    roughness: 0.93,
    metalness: 0,
    envMapIntensity: 0.35,
  });
  mat.onBeforeCompile = injectGlitter;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'terrain';
  mesh.receiveShadow = true;
  return mesh;
}
