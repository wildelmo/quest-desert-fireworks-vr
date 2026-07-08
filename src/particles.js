// Stateless GPU particle pool. The CPU only writes spawn data (position,
// velocity, color, timing, physics params); the vertex shader integrates
// ballistic motion with linear drag analytically every frame, so 30k+
// particles cost almost nothing on the CPU — important for Quest.

import * as THREE from 'three';

function makeGlowSprite() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0.0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.85)');
  grad.addColorStop(0.55, 'rgba(255,255,255,0.28)');
  grad.addColorStop(1.0, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

const VERT = /* glsl */`
  attribute vec3 aVel;
  attribute vec3 aColor;
  attribute vec2 aTiming;   // birth, life
  attribute vec4 aMisc;     // size, gravityScale, drag, twinkleFreq
  attribute float aGroundY; // sand height where this particle will land

  uniform float uTime;
  uniform float uHeight;    // drawing buffer height in px

  varying vec3 vColor;
  varying float vAlpha;

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
      return;
    }

    float d = max(aMisc.z, 0.0001);
    float k = (1.0 - exp(-d * age)) / d;                    // drag-integrated time
    vec3 g = vec3(0.0, -9.81 * aMisc.y, 0.0);
    vec3 pos = position + aVel * k + g * ((age - k) / d);

    // settle on the sand instead of raining through it — embers land and
    // glow on the dunes until they die
    if (pos.y < aGroundY) pos.y = aGroundY;

    float tw = aMisc.w;
    float env;
    float sizeFalloff;
    if (tw < -0.5) {
      // smoke/haze mode: bloom in gently, linger, thin out — and GROW the
      // whole time, the way a dust cloud spreads. No ignition flash.
      env = smoothstep(0.0, 0.12, n) * pow(1.0 - n, 1.6);
      sizeFalloff = 0.55 + n * 1.45;
      vColor = aColor;
    } else {
      // brightness envelope: hot flash then exponential decay — the decay is
      // deliberately gentle so the display holds its brilliance through the
      // middle of its life instead of dimming right after the break
      env = exp(-n * 1.6) * (1.0 - smoothstep(0.72, 1.0, n));
      // white-hot ignition spike: fresh stars overdrive toward white for the
      // first ~150ms (ACES pushes >1 to white), then cool into their color
      env *= 1.0 + 2.8 * exp(-age * 13.0);

      // twinkle / strobe for crackle stars — seed from velocity, since all
      // stars of one shell share the same spawn position
      if (tw > 0.0) {
        float seed = fract(sin(dot(position.xy + aVel.xy + aVel.zx, vec2(12.9898, 78.233))) * 43758.5453);
        float s = 0.5 + 0.5 * sin(age * tw + seed * 40.0);
        env *= 0.22 + 2.4 * s * s * s;
      }

      // embers shift warm as they die
      vColor = mix(aColor, aColor * vec3(1.0, 0.45, 0.18) + vec3(0.25, 0.05, 0.0), n * n * 0.7);
      sizeFalloff = 1.0 - n * 0.55;
    }
    vAlpha = env;

    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = aMisc.x * sizeFalloff * uHeight * projectionMatrix[1][1] * 0.5 / max(0.1, -mv.z);
  }
`;

const FRAG = /* glsl */`
  uniform sampler2D uMap;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    if (vAlpha <= 0.001) discard;
    float a = texture2D(uMap, gl_PointCoord).a;
    gl_FragColor = vec4(vColor * vAlpha, a * vAlpha);
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
    this.aTiming = new THREE.BufferAttribute(new Float32Array(capacity * 2), 2);
    this.aMisc = new THREE.BufferAttribute(new Float32Array(capacity * 4), 4);
    this.aGround = new THREE.BufferAttribute(new Float32Array(capacity), 1);
    // birth = -1e3 marks dead
    for (let i = 0; i < capacity; i++) {
      this.aTiming.array[i * 2] = -1e3;
      this.aGround.array[i] = -1e6;
    }

    geo.setAttribute('position', this.aPos);
    geo.setAttribute('aVel', this.aVel);
    geo.setAttribute('aColor', this.aColor);
    geo.setAttribute('aTiming', this.aTiming);
    geo.setAttribute('aMisc', this.aMisc);
    geo.setAttribute('aGroundY', this.aGround);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 10000);

    this.uniforms = {
      uTime: { value: 0 },
      uHeight: { value: 1024 },
      uMap: { value: makeGlowSprite() },
    };

    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
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

  set(i, px, py, pz, vx, vy, vz, r, g, b, birth, life, size, gravity, drag, twinkle) {
    const p = this.aPos.array, v = this.aVel.array, c = this.aColor.array;
    const t = this.aTiming.array, m = this.aMisc.array;
    p[i * 3] = px; p[i * 3 + 1] = py; p[i * 3 + 2] = pz;
    v[i * 3] = vx; v[i * 3 + 1] = vy; v[i * 3 + 2] = vz;
    c[i * 3] = r; c[i * 3 + 1] = g; c[i * 3 + 2] = b;
    t[i * 2] = birth; t[i * 2 + 1] = life;
    m[i * 4] = size; m[i * 4 + 1] = gravity; m[i * 4 + 2] = drag; m[i * 4 + 3] = twinkle;

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

  update(time, drawingBufferHeight) {
    this.uniforms.uTime.value = time;
    if (drawingBufferHeight) this.uniforms.uHeight.value = drawingBufferHeight;

    if (this.dirtyRuns.length > 0) {
      for (const [attr, itemSize] of [
        [this.aPos, 3], [this.aVel, 3], [this.aColor, 3], [this.aTiming, 2], [this.aMisc, 4],
        [this.aGround, 1],
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
