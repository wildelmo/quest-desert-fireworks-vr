// THE COLOSSUS — a monumental fire-wheel out in the western dunes, on the
// scale of the London Eye (104 m of wheel on a 68 m hub, 120 m to the top
// of the arc). It is scenery with a heartbeat: an autonomous set piece that
// kindles, roars at full glory, sputters out and freewheels dark, all night,
// whether anyone watches or not.
//
// Everything here is in service of one illusion — SIZE — and the cues are
// deliberate:
//   real distance ..... it stands 280 m from camp, so walking around the
//                       campsite barely moves it against the sky (the
//                       parallax of a far mountain, not a nearby prop);
//   slow arc .......... peak spin is ~0.32 rad/s — one revolution every
//                       twenty seconds (the hand pinwheel turns 100x
//                       faster). Drive torque fights quadratic aero drag,
//                       so it takes half a minute to wind up and coasts
//                       for minutes when the drivers die;
//   hierarchy ......... no smooth circles: segmented rim chords with gusset
//                       plates, a mid ring, trussed spokes, cable stays —
//                       structure inside structure, so there is always one
//                       more level of detail to read as you approach;
//   human units ....... a service shed with a lit window at its foot, a
//                       telegraph line marching down the access track,
//                       lamps you can count;
//   air ............... it burns inside its own gunpowder plume and a bank
//                       of night dust (in-world haze, not lens blur), throws
//                       a halo of light pollution, and paints the dunes
//                       around its base with its fire;
//   sound-at-distance . salutes flash first and BOOM ~0.8 s later (true
//                       speed-of-sound delay), the driver roar arrives as
//                       lowpassed bass from camp and becomes a furnace as
//                       you walk up, and near the base the bearings groan
//                       under the load.
//
// Perf: the whole monument is ~25 draw calls and ~12k triangles (instanced
// bars for every truss member), one extra PointLight that exists from
// startup (the scene's light count never changes — see FlashPool), and it
// feeds the shared GPU particle pool at a peak of ~1k spawns/s.

import * as THREE from 'three';
import { mergeGeometries } from '../lib/BufferGeometryUtils.js';
import { terrainHeight } from './terrain.js';
import { PALETTES } from './fireworks.js';
import { CELL } from './particles.js';
import { randRange, randPick, clamp } from './utils.js';

export const COLOSSUS_POS = new THREE.Vector3(-201, 0, -195);

const R_OUT = 52;        // outer rim radius -> 104 m wheel
const R_IN = 43;         // inner rim radius
const R_MID = 22;        // mid ring radius
const R_POD = 49.6;      // driver pods ride just inside the outer rim
const HUB_H = 68;        // hub height above the base
const N_OUT = 48;        // outer rim chords
const N_IN = 24;         // inner rim chords
const N_PODS = 8;

// steady-state spin ~= sqrt(8 * POD_ACCEL / AERO): 0.32 rad/s at full burn
const POD_ACCEL = 0.0019; // rad/s^2 of drive per pod
const AERO = 0.145;       // quadratic aero drag on the wheel
const BEARING = 0.00012;  // constant bearing friction (what finally stops it)

const WIND = new THREE.Vector3(1.5, 0, 0.35); // matches the shells' smoke drift

const UP = new THREE.Vector3(0, 1, 0);
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _c1 = new THREE.Color();
const _c2 = new THREE.Color();

// ---------------------------------------------------------------------------
// small builders

/**
 * One InstancedMesh of bars, each spanning two endpoints.
 * pairs: [ax,ay,az, bx,by,bz, r?] — r overrides defR per bar.
 * kind: 'tube' (open cylinder), 'cyl' (capped), 'box'.
 */
function bars(pairs, defR, kind, material) {
  const geo = kind === 'box'
    ? new THREE.BoxGeometry(1, 1, 1)
    : new THREE.CylinderGeometry(1, 1, 1, 7, 1, kind === 'tube');
  const mesh = new THREE.InstancedMesh(geo, material, pairs.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), mid = new THREE.Vector3(), d = new THREE.Vector3();
  pairs.forEach((p, i) => {
    a.set(p[0], p[1], p[2]);
    b.set(p[3], p[4], p[5]);
    mid.addVectors(a, b).multiplyScalar(0.5);
    d.subVectors(b, a);
    const len = d.length() || 0.001;
    q.setFromUnitVectors(UP, d.divideScalar(len));
    const r = p[6] ?? defR;
    mesh.setMatrixAt(i, m.compose(mid, q, s.set(r, len, r)));
  });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  return mesh;
}

function lineSegs(pairs, color, opacity = 1) {
  const pos = new Float32Array(pairs.length * 6);
  pairs.forEach((p, i) => pos.set(p, i * 6));
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.LineBasicMaterial({
    color, transparent: opacity < 1, opacity,
  });
  return new THREE.LineSegments(geo, mat);
}

function glowTexture(hard = 0.18) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(hard, 'rgba(255,255,255,0.85)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.25)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

// Marker-lamp points: world-scaled soft dots with a floor of ~1.6 px so the
// string of lights never scintillates away at 280 m. aBeacon=1 points ignore
// the twinkle and follow uBeacon (the aviation double-flash at the apexes).
function lampMaterial(uRes, tex) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uRes,                       // SHARED with the particle pool (kept current)
      uTime: { value: 0 },
      uGlow: { value: 1 },
      uBeacon: { value: 1 },
      uMap: { value: tex },
    },
    vertexShader: /* glsl */`
      attribute float aSize;
      attribute vec3 aTint;
      attribute float aPhase;
      attribute float aBeacon;
      uniform vec2 uRes;
      uniform float uTime, uGlow, uBeacon;
      varying vec3 vC;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        float tw = 0.78 + 0.22 * sin(uTime * (0.9 + fract(aPhase)) + aPhase * 9.0);
        vC = aTint * mix(tw * uGlow, uBeacon, aBeacon);
        float px = aSize * uRes.y * projectionMatrix[1][1] * 0.5 / max(0.1, -mv.z);
        gl_PointSize = clamp(px, 1.6, 200.0);
      }
    `,
    fragmentShader: /* glsl */`
      uniform sampler2D uMap;
      varying vec3 vC;
      void main() {
        float a = texture2D(uMap, gl_PointCoord).a;
        if (a < 0.01) discard;
        gl_FragColor = vec4(vC * a, 0.0);
      }
    `,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    transparent: true,
    depthWrite: false,
  });
}

function lampPoints(mat, pts) {
  // pts: {p:[x,y,z], size, tint:[r,g,b], beacon?}
  const n = pts.length;
  const pos = new Float32Array(n * 3);
  const size = new Float32Array(n);
  const tint = new Float32Array(n * 3);
  const phase = new Float32Array(n);
  const beacon = new Float32Array(n);
  pts.forEach((l, i) => {
    pos.set(l.p, i * 3);
    size[i] = l.size;
    tint.set(l.tint, i * 3);
    phase[i] = Math.random() * 7;
    beacon[i] = l.beacon ? 1 : 0;
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  geo.setAttribute('aTint', new THREE.BufferAttribute(tint, 3));
  geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
  geo.setAttribute('aBeacon', new THREE.BufferAttribute(beacon, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), R_OUT + HUB_H);
  return new THREE.Points(geo, mat);
}

function signTexture() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#5f4a30';
  g.fillRect(0, 0, 512, 256);
  g.strokeStyle = 'rgba(28,18,8,0.5)';
  for (let i = 0; i < 6; i++) {
    g.lineWidth = 1 + Math.random() * 2;
    g.beginPath();
    g.moveTo(0, 24 + i * 38 + Math.random() * 10);
    g.lineTo(512, 24 + i * 38 + Math.random() * 10);
    g.stroke();
  }
  g.fillStyle = '#f2e3bc';
  g.font = 'bold 58px Georgia, serif';
  g.textAlign = 'center';
  g.fillText('THE COLOSSUS', 256, 82);
  g.font = '34px Georgia, serif';
  g.fillStyle = '#e8cf9a';
  g.fillText('grand fire-wheel · ¼ mile', 256, 146);
  g.font = '28px Georgia, serif';
  g.fillStyle = '#c9ab72';
  g.fillText('runs all night — mind the sparks', 256, 204);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------------------------------------------------------------------------

export function createColossus(scene, fireworks, pool, audio) {
  const baseY = terrainHeight(COLOSSUS_POS.x, COLOSSUS_POS.z);

  // local frame: +Z looks back at camp (twisted ~17 degrees so the wheel
  // presents a little depth — the near rim and far rim move at visibly
  // different angular rates, which is parallax you can't fake)
  const faceYaw = Math.atan2(-COLOSSUS_POS.x, -COLOSSUS_POS.z) + 0.30;
  const root = new THREE.Group();
  root.position.set(COLOSSUS_POS.x, baseY, COLOSSUS_POS.z);
  root.rotation.y = faceYaw;
  scene.add(root);
  root.updateMatrixWorld(true);

  const groundLocal = (lx, lz) => {
    _v1.set(lx, 0, lz);
    root.localToWorld(_v1);
    return terrainHeight(_v1.x, _v1.z) - baseY;
  };

  // -- materials --
  const steel = new THREE.MeshStandardMaterial({
    color: 0x39404c, roughness: 0.48, metalness: 0.72, envMapIntensity: 0.65,
  });
  const darkSteel = new THREE.MeshStandardMaterial({
    color: 0x272c36, roughness: 0.6, metalness: 0.6, envMapIntensity: 0.5,
  });
  const podMat = new THREE.MeshStandardMaterial({
    color: 0x4c3e33, roughness: 0.58, metalness: 0.35, envMapIntensity: 0.5,
    emissive: 0x000000,
  });
  const stone = new THREE.MeshStandardMaterial({
    color: 0x3b342c, roughness: 0.95, metalness: 0, envMapIntensity: 0.25,
  });
  const wood = new THREE.MeshStandardMaterial({
    color: 0x5c4830, roughness: 0.8, metalness: 0, envMapIntensity: 0.35,
  });

  // =========================================================================
  // static structure
  // =========================================================================

  // paved apron, conformed to the dunes
  {
    const geo = new THREE.RingGeometry(0.5, 24, 40, 4);
    geo.rotateX(-Math.PI / 2);
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      p.setY(i, groundLocal(p.getX(i), p.getZ(i)) + 0.14);
    }
    geo.computeVertexNormals();
    const apron = new THREE.Mesh(geo, stone);
    root.add(apron);
  }

  const FEET = [
    [-17, 8.5], [17, 8.5], [-17, -8.5], [17, -8.5],
  ].map(([x, z]) => [x, groundLocal(x, z), z]);
  const APEX = [[0, HUB_H, 8.5], [0, HUB_H, -8.5]];

  // legs: two A-frames straddling the axle, plus the cross-links up top
  {
    const legPairs = [];
    for (let i = 0; i < 4; i++) {
      legPairs.push([FEET[i][0], FEET[i][1] - 1, FEET[i][2], ...APEX[i < 2 ? 0 : 1]]);
    }
    legPairs.push([-2.8, 58, -8.5, -2.8, 58, 8.5, 0.5]);
    legPairs.push([2.8, 63, -8.5, 2.8, 63, 8.5, 0.5]);
    root.add(bars(legPairs, 1.05, 'cyl', steel));

    // ladder braces across each A-frame
    const bracePairs = [];
    for (const side of [0, 1]) {
      const [fa, fb] = side === 0 ? [FEET[0], FEET[1]] : [FEET[2], FEET[3]];
      const apex = APEX[side];
      for (const h of [12, 24, 36, 48, 58]) {
        const ta = (h - fa[1]) / (apex[1] - fa[1]);
        const tb = (h - fb[1]) / (apex[1] - fb[1]);
        bracePairs.push([
          fa[0] + (apex[0] - fa[0]) * ta, h, fa[2],
          fb[0] + (apex[0] - fb[0]) * tb, h, fb[2],
        ]);
      }
    }
    root.add(bars(bracePairs, 0.34, 'box', darkSteel));
  }

  // axle between the apexes
  root.add(bars([[0, HUB_H, -9.8, 0, HUB_H, 9.8]], 1.7, 'cyl', steel));

  // stay cables + their anchors
  const ANCHORS = [
    [0, 42], [0, -42], [33, 16], [-33, 16], [33, -16], [-33, -16],
  ].map(([x, z]) => [x, groundLocal(x, z), z]);
  {
    const stayPairs = [];
    stayPairs.push([...APEX[0], ...ANCHORS[0]]);
    stayPairs.push([...APEX[1], ...ANCHORS[1]]);
    stayPairs.push([...APEX[0], ...ANCHORS[2]], [...APEX[0], ...ANCHORS[3]]);
    stayPairs.push([...APEX[1], ...ANCHORS[4]], [...APEX[1], ...ANCHORS[5]]);
    root.add(lineSegs(stayPairs.map((p) => p.slice(0, 6)), 0x161b26));

    const blockPairs = [];
    for (const f of FEET) blockPairs.push([f[0], f[1] - 1.4, f[2], f[0], f[1] + 1.4, f[2], 1.9]);
    for (const a of ANCHORS) blockPairs.push([a[0], a[1] - 0.9, a[2], a[0], a[1] + 0.7, a[2], 1.15]);
    root.add(bars(blockPairs, 1, 'box', stone));
  }

  // the keeper's shed — the human-scale yardstick at the foot of the thing
  {
    const shed = new THREE.Group();
    const gy = groundLocal(28, 12);
    shed.position.set(28, gy, 12);
    shed.rotation.y = -0.35;
    const body = new THREE.Mesh(new THREE.BoxGeometry(4.4, 3.0, 3.4), wood);
    body.position.y = 1.5;
    shed.add(body);
    const roof = new THREE.Mesh(new THREE.BoxGeometry(4.9, 0.24, 3.9), darkSteel);
    roof.position.y = 3.1;
    roof.rotation.z = 0.07;
    shed.add(roof);
    // a lit window: at night, one warm rectangle says "person-sized" louder
    // than any amount of geometry
    const win = new THREE.Mesh(
      new THREE.PlaneGeometry(0.72, 0.56),
      new THREE.MeshBasicMaterial({ color: 0xffb469 }),
    );
    win.position.set(0.9, 1.62, 1.71);
    shed.add(win);
    const door = new THREE.Mesh(new THREE.BoxGeometry(0.95, 2.05, 0.08), darkSteel);
    door.position.set(-1.05, 1.02, 1.68);
    shed.add(door);
    root.add(shed);
  }

  // =========================================================================
  // the wheel
  // =========================================================================

  const wheel = new THREE.Group();
  wheel.position.y = HUB_H;
  root.add(wheel);

  const outV = [], inV = [], midV = [];
  for (let k = 0; k < N_OUT; k++) {
    const a = (k / N_OUT) * Math.PI * 2;
    outV.push([Math.cos(a) * R_OUT, Math.sin(a) * R_OUT]);
  }
  for (let k = 0; k < N_IN; k++) {
    const a = (k / N_IN) * Math.PI * 2;
    inV.push([Math.cos(a) * R_IN, Math.sin(a) * R_IN]);
  }
  for (let k = 0; k < N_PODS; k++) {
    const a = (k / N_PODS) * Math.PI * 2;
    midV.push([Math.cos(a) * R_MID, Math.sin(a) * R_MID]);
  }

  // rims: chords, not circles — the polygon facets are the point
  {
    const outPairs = [];
    for (let k = 0; k < N_OUT; k++) {
      const b = outV[(k + 1) % N_OUT];
      outPairs.push([outV[k][0], outV[k][1], 0, b[0], b[1], 0]);
    }
    wheel.add(bars(outPairs, 0.5, 'tube', steel));

    const inPairs = [];
    for (let k = 0; k < N_IN; k++) {
      const b = inV[(k + 1) % N_IN];
      inPairs.push([inV[k][0], inV[k][1], 0, b[0], b[1], 0]);
    }
    wheel.add(bars(inPairs, 0.34, 'tube', steel));

    // gusset plates at every rim joint (they also hide the tube ends)
    const gussets = [];
    for (let k = 0; k < N_OUT; k++) {
      const a = (k / N_OUT) * Math.PI * 2;
      const tx = -Math.sin(a) * 0.7, ty = Math.cos(a) * 0.7;
      gussets.push([outV[k][0] - tx, outV[k][1] - ty, 0, outV[k][0] + tx, outV[k][1] + ty, 0, 1.05]);
    }
    for (let k = 0; k < N_IN; k++) {
      const a = (k / N_IN) * Math.PI * 2;
      const tx = -Math.sin(a) * 0.55, ty = Math.cos(a) * 0.55;
      gussets.push([inV[k][0] - tx, inV[k][1] - ty, 0, inV[k][0] + tx, inV[k][1] + ty, 0, 0.8]);
    }
    wheel.add(bars(gussets, 1, 'box', steel));

    // ring truss between the rims + mid ring + ties: the lattice that makes
    // it read "engineered", never "drawn"
    const truss = [];
    for (let j = 0; j < N_IN; j++) {
      const o1 = outV[(2 * j + 1) % N_OUT];
      truss.push([o1[0], o1[1], 0, inV[j][0], inV[j][1], 0, 0.27]);
      const j2 = (j + 1) % N_IN;
      truss.push([o1[0], o1[1], 0, inV[j2][0], inV[j2][1], 0, 0.27]);
      const o0 = outV[(2 * j) % N_OUT];
      truss.push([o0[0], o0[1], 0, inV[j][0], inV[j][1], 0, 0.27]);
    }
    for (let k = 0; k < N_PODS; k++) {
      const b = midV[(k + 1) % N_PODS];
      truss.push([midV[k][0], midV[k][1], 0, b[0], b[1], 0, 0.3]);
      // ties from the mid ring out to the inner rim, splayed
      const j = k * 3;
      const t1 = inV[(j + 1) % N_IN], t2 = inV[(j + N_IN - 1) % N_IN];
      truss.push([midV[k][0], midV[k][1], 0, t1[0], t1[1], 0, 0.26]);
      truss.push([midV[k][0], midV[k][1], 0, t2[0], t2[1], 0, 0.26]);
    }
    wheel.add(bars(truss, 0.27, 'box', darkSteel));

    // primary spokes
    const spokes = [];
    for (let k = 0; k < N_PODS; k++) {
      const a = (k / N_PODS) * Math.PI * 2;
      spokes.push([Math.cos(a) * 4.4, Math.sin(a) * 4.4, 0, Math.cos(a) * R_IN, Math.sin(a) * R_IN, 0]);
    }
    wheel.add(bars(spokes, 0.48, 'cyl', steel));

    // cable spokes to every unspoked rim joint
    const cables = [];
    for (let k = 0; k < N_OUT; k++) {
      if (k % (N_OUT / N_PODS) === 0) continue;
      const a = (k / N_OUT) * Math.PI * 2;
      cables.push([Math.cos(a) * 4.8, Math.sin(a) * 4.8, 0, outV[k][0], outV[k][1], 0]);
    }
    wheel.add(lineSegs(cables, 0x11151d));
  }

  // hub drum (+ bolt ring so the rotation reads up close)
  {
    const parts = [];
    const drum = new THREE.CylinderGeometry(3.4, 3.4, 4.4, 18);
    drum.rotateX(Math.PI / 2);
    parts.push(drum);
    for (const zc of [-2.3, 2.3]) {
      const flange = new THREE.CylinderGeometry(4.3, 4.3, 0.35, 18);
      flange.rotateX(Math.PI / 2);
      flange.translate(0, 0, zc);
      parts.push(flange);
    }
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const bolt = new THREE.BoxGeometry(0.55, 0.55, 0.5);
      bolt.translate(Math.cos(a) * 2.5, Math.sin(a) * 2.5, 2.55);
      parts.push(bolt);
    }
    const hub = new THREE.Mesh(mergeGeometries(parts), darkSteel);
    wheel.add(hub);
  }

  // driver pods: car-sized clusters of rocket motors, one per spoke tip.
  // Local frame: +Y radial out, +X tangent (against the spin), +Z axial.
  const podAnchors = [];
  {
    const parts = [];
    const bracket = new THREE.BoxGeometry(2.6, 1.5, 1.7);
    parts.push(bracket);
    for (let i = -1; i <= 1; i++) {
      const tube = new THREE.CylinderGeometry(0.42, 0.42, 3.6, 8);
      tube.rotateZ(Math.PI / 2);
      const noz = new THREE.ConeGeometry(0.56, 0.85, 8);
      noz.rotateZ(-Math.PI / 2);
      noz.translate(2.15, 0, 0);
      const m = new THREE.Matrix4()
        .makeRotationZ(i * 0.13)
        .setPosition(0, 0.35, i * 0.58);
      tube.applyMatrix4(m);
      noz.applyMatrix4(m);
      parts.push(tube, noz);
    }
    const podGeo = mergeGeometries(parts);
    const pods = new THREE.InstancedMesh(podGeo, podMat, N_PODS);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    for (let k = 0; k < N_PODS; k++) {
      const a = (k / N_PODS) * Math.PI * 2;
      q.setFromEuler(e.set(0, 0, a - Math.PI / 2));
      m.compose(_v1.set(Math.cos(a) * R_POD, Math.sin(a) * R_POD, 0), q, _v2.set(1, 1, 1));
      pods.setMatrixAt(k, m);
      // exhaust anchor at the nozzles, trailing the spin
      const anchor = new THREE.Object3D();
      anchor.position.set(
        Math.cos(a) * R_POD + Math.sin(a) * 2.6,
        Math.sin(a) * R_POD - Math.cos(a) * 2.6,
        0.3,
      );
      wheel.add(anchor);
      podAnchors.push(anchor);
    }
    pods.instanceMatrix.needsUpdate = true;
    pods.computeBoundingSphere();
    wheel.add(pods);
  }

  // marker lamps: two wheeling circles of amber points + a hub ring. At
  // 280 m these are what tell you it's turning; up close they're gas lamps.
  const dotTex = glowTexture(0.22);
  const wheelLampMat = lampMaterial(pool.uniforms.uRes, dotTex);
  {
    const pts = [];
    for (let k = 0; k < N_OUT; k++) {
      pts.push({ p: [outV[k][0], outV[k][1], 0.9], size: 0.55, tint: [1.0, 0.55, 0.2] });
    }
    for (let k = 0; k < N_IN; k += 2) {
      pts.push({ p: [inV[k][0], inV[k][1], 0.9], size: 0.4, tint: [0.55, 0.3, 0.11] });
    }
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2 + 0.4;
      pts.push({ p: [Math.cos(a) * 5.8, Math.sin(a) * 5.8, 2.6], size: 0.45, tint: [1.0, 0.72, 0.4] });
    }
    wheel.add(lampPoints(wheelLampMat, pts));
  }

  // static lamps: legs, anchors, the shed door — and the two red aviation
  // beacons on the apexes (every real megastructure wears them)
  const staticLampMat = lampMaterial(pool.uniforms.uRes, dotTex);
  {
    const pts = [];
    for (let i = 0; i < 4; i++) {
      const apex = APEX[i < 2 ? 0 : 1];
      for (const t of [0.35, 0.68]) {
        pts.push({
          p: [
            FEET[i][0] + (apex[0] - FEET[i][0]) * t,
            FEET[i][1] + (apex[1] - FEET[i][1]) * t,
            FEET[i][2] + (apex[2] - FEET[i][2]) * t,
          ],
          size: 0.5, tint: [1.0, 0.8, 0.5],
        });
      }
    }
    for (const a of ANCHORS) pts.push({ p: [a[0], a[1] + 1.1, a[2]], size: 0.32, tint: [0.8, 0.45, 0.16] });
    pts.push({ p: [26.9, groundLocal(28, 12) + 2.2, 13.5], size: 0.4, tint: [1.0, 0.7, 0.42] });
    pts.push({ p: [0, HUB_H + 2.6, 8.5], size: 0.95, tint: [1.0, 0.1, 0.05], beacon: true });
    pts.push({ p: [0, HUB_H + 2.6, -8.5], size: 0.95, tint: [1.0, 0.1, 0.05], beacon: true });
    root.add(lampPoints(staticLampMat, pts));
  }

  // pod exhaust flares: one Points cloud, sizes/tints driven per frame.
  // Custom soft profile — the lamp-dot texture's fat core reads as an
  // orange slab once ACES saturates it; fire wants a long feathered skirt.
  const flareTex = (() => {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.14, 'rgba(255,255,255,0.55)');
    grad.addColorStop(0.42, 'rgba(255,255,255,0.16)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  })();
  let flareMat, flareSize, flareTint;
  {
    const pos = new Float32Array(N_PODS * 3);
    podAnchors.forEach((a, k) => pos.set([a.position.x, a.position.y, a.position.z], k * 3));
    flareSize = new THREE.BufferAttribute(new Float32Array(N_PODS), 1);
    flareTint = new THREE.BufferAttribute(new Float32Array(N_PODS * 3), 3);
    flareSize.setUsage(THREE.DynamicDrawUsage);
    flareTint.setUsage(THREE.DynamicDrawUsage);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSize', flareSize);
    geo.setAttribute('aTint', flareTint);
    geo.setAttribute('aPhase', new THREE.BufferAttribute(new Float32Array(N_PODS), 1));
    geo.setAttribute('aBeacon', new THREE.BufferAttribute(new Float32Array(N_PODS), 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), R_OUT + 8);
    flareMat = lampMaterial(pool.uniforms.uRes, flareTex);
    wheel.add(new THREE.Points(geo, flareMat));
  }

  // light-pollution halo: the scattered glow a distant burning thing wears.
  // Reads through/behind the lattice because it depth-tests against it.
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture(0.04), transparent: true, opacity: 0, depthWrite: false,
    blending: THREE.AdditiveBlending, color: 0xff9a50, fog: false,
  }));
  halo.position.y = HUB_H;
  halo.scale.setScalar(130);
  root.add(halo);

  // the wheel's one real light: paints its dunes, its plume paints the sky.
  // Created at startup and never removed (light-count changes recompile
  // every shader on Quest — see FlashPool for the same dance).
  const fireLight = new THREE.PointLight(0xff9a50, 0, 0, 1.7);
  fireLight.position.set(0, HUB_H - 6, 0);
  root.add(fireLight);

  // =========================================================================
  // access track: ruts, telegraph poles, a signpost — repeated known-size
  // objects diminishing toward the wheel make the distance legible
  // =========================================================================
  {
    const dir = _v1.set(COLOSSUS_POS.x, 0, COLOSSUS_POS.z).normalize().clone();
    const perp = new THREE.Vector3(-dir.z, 0, dir.x);
    const dist = Math.hypot(COLOSSUS_POS.x, COLOSSUS_POS.z);

    // wheel-rut track
    const verts = [], idx = [];
    let n = 0;
    for (let d = 15; d <= dist - 25; d += 6) {
      const wob = Math.sin(d * 0.045) * 2.2 + Math.sin(d * 0.013) * 4.5;
      const cx = dir.x * d + perp.x * wob;
      const cz = dir.z * d + perp.z * wob;
      const w = 1.9;
      for (const s of [-1, 1]) {
        const x = cx + perp.x * w * s, z = cz + perp.z * w * s;
        verts.push(x, terrainHeight(x, z) + 0.12, z);
      }
      if (n > 0) idx.push(n * 2 - 2, n * 2 - 1, n * 2, n * 2 + 1, n * 2, n * 2 - 1);
      n++;
    }
    const roadGeo = new THREE.BufferGeometry();
    roadGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
    roadGeo.setIndex(idx);
    const road = new THREE.Mesh(roadGeo, new THREE.MeshBasicMaterial({
      color: 0x191410, transparent: true, opacity: 0.45, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, side: THREE.DoubleSide,
    }));
    road.renderOrder = 1;
    scene.add(road);

    // telegraph line
    const polePairs = [], armPairs = [], wirePairs = [];
    const tops = [];
    for (let d = 36; d <= dist - 30; d += 22) {
      const wob = Math.sin(d * 0.045) * 2.2 + Math.sin(d * 0.013) * 4.5;
      const x = dir.x * d + perp.x * (wob + 4.4);
      const z = dir.z * d + perp.z * (wob + 4.4);
      const g = terrainHeight(x, z);
      polePairs.push([x, g - 0.4, z, x, g + 7.3, z]);
      armPairs.push([x - perp.x * 0.95, g + 6.8, z - perp.z * 0.95, x + perp.x * 0.95, g + 6.8, z + perp.z * 0.95]);
      tops.push([x, g + 6.8, z]);
    }
    for (let i = 1; i < tops.length; i++) {
      const [ax, ay, az] = tops[i - 1], [bx, by, bz] = tops[i];
      const SEG = 5;
      for (const s of [-0.85, 0.85]) {
        for (let k = 0; k < SEG; k++) {
          const t0 = k / SEG, t1 = (k + 1) / SEG;
          const sag = (t) => Math.sin(t * Math.PI) * 0.85;
          wirePairs.push([
            ax + (bx - ax) * t0 + perp.x * s, ay + (by - ay) * t0 - sag(t0), az + (bz - az) * t0 + perp.z * s,
            ax + (bx - ax) * t1 + perp.x * s, ay + (by - ay) * t1 - sag(t1), az + (bz - az) * t1 + perp.z * s,
          ]);
        }
      }
    }
    scene.add(bars(polePairs, 0.13, 'cyl', wood));
    scene.add(bars(armPairs, 0.09, 'box', wood));
    scene.add(lineSegs(wirePairs, 0x0d0f16));

    // signpost at the trailhead
    const sign = new THREE.Group();
    const sx = dir.x * 13.5 + perp.x * 2.6, sz = dir.z * 13.5 + perp.z * 2.6;
    sign.position.set(sx, terrainHeight(sx, sz), sz);
    sign.rotation.y = Math.atan2(-sx, -sz) + Math.PI; // board faces camp
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 1.5, 7), wood);
    post.position.set(0, 0.75, 0.035);
    sign.add(post);
    const board = new THREE.Mesh(
      new THREE.BoxGeometry(1.15, 0.58, 0.045),
      [wood, wood, wood, wood,
        new THREE.MeshStandardMaterial({
          map: signTexture(), roughness: 0.72, envMapIntensity: 0.4,
          emissive: 0xffffff, emissiveMap: signTexture(), emissiveIntensity: 0.14,
        }),
        wood],
    );
    board.position.y = 1.42;
    board.rotation.z = -0.02;
    board.rotation.y = Math.PI; // +z face carries the art; flip toward camp
    sign.add(board);
    scene.add(sign);
  }

  root.updateMatrixWorld(true);
  const hubWorld = wheel.getWorldPosition(new THREE.Vector3());
  const axisW = _v1.set(0, 0, 1).applyQuaternion(root.quaternion).clone(); // fixed spin axis

  // =========================================================================
  // the program — dark / kindle / glory / sputter, forever
  // =========================================================================

  const pods = [];
  for (let k = 0; k < N_PODS; k++) {
    pods.push({
      angle0: (k / N_PODS) * Math.PI * 2,
      burn: 0, target: 0, ember: 0, boost: 0,
      sparkAcc: 0, smokeAcc: 0, emberAcc: 0, wasBottom: false,
    });
  }

  const palA = new THREE.Color(PALETTES[0].a);
  const palB = new THREE.Color(PALETTES[6].a);
  const palTargetA = new THREE.Color().copy(palA);
  const palTargetB = new THREE.Color().copy(palB);
  const fireCol = new THREE.Color();
  const WARM = new THREE.Color(0xffa050);
  const EMBER = new THREE.Color(0.7, 0.16, 0.03);

  let phase = 'dark';
  let phaseT = 0;
  let phaseDur = 3.5;       // short first night-watch so newcomers see it wake
  let omega = 0;
  let angle = Math.random() * Math.PI * 2;
  let burnAvg = 0, emberAvg = 0;
  let saluteT = 0, chaseT = 0, chaseLeft = 0, chaseStepT = 0, chaseIdx = 0;
  let paletteT = 0, creakT = 6, dustAcc = 0;
  let roar = null;
  const events = []; // {t, fn} against phaseT

  const podWorld = (k, out) => podAnchors[k].getWorldPosition(out);

  function whoomph(k) {
    if (!audio.ready) return;
    const p = podWorld(k, _v3);
    audio.play('lift', p, {
      gain: 1.5, rate: randRange(0.48, 0.56), refDistance: 26, send: 0.55,
      delayBySound: true, lowpass: 2600,
    });
    audio.play('thud', p, {
      gain: 1.2, rate: 0.45, refDistance: 20, send: 0.4, delayBySound: true,
    });
  }

  function setPhase(name) {
    phase = name;
    phaseT = 0;
    events.length = 0;
    if (name === 'kindle') {
      // fresh colors for tonight's burn
      palTargetA.set(randPick(PALETTES).a);
      palTargetB.set(randPick(PALETTES).a);
      const banks = [[0, 4], [1, 5], [2, 6], [3, 7]].sort(() => Math.random() - 0.5);
      banks.forEach((bank, i) => {
        events.push({
          t: 1 + i * 3.1 + Math.random() * 0.8,
          fn: () => bank.forEach((k) => {
            pods[k].target = 1;
            pods[k].boost = 1.6;
            whoomph(k);
          }),
        });
      });
      phaseDur = 16;
    } else if (name === 'glory') {
      for (const p of pods) p.target = 1;
      phaseDur = randRange(72, 100);
      saluteT = 6;
      chaseT = randRange(24, 38);
      chaseLeft = 0;
    } else if (name === 'sputter') {
      const order = pods.map((_, k) => k).sort(() => Math.random() - 0.5);
      order.forEach((k, i) => {
        events.push({
          t: i * randRange(1.0, 1.9),
          fn: () => {
            pods[k].target = 0;
            if (audio.ready) {
              const p = podWorld(k, _v3);
              audio.play('thud', p, {
                gain: 0.8, rate: randRange(0.55, 0.7), refDistance: 16,
                send: 0.4, delayBySound: true,
              });
            }
          },
        });
      });
      phaseDur = 16;
    } else { // dark
      for (const p of pods) p.target = 0;
      phaseDur = randRange(24, 40);
    }
    events.sort((a, b) => a.t - b.t);
  }

  function salute() {
    // prefer a burning pod riding the top half of the arc
    const lit = pods.map((p, k) => k).filter((k) => pods[k].burn > 0.35);
    if (!lit.length) return null;
    const high = lit.filter((k) => Math.sin(pods[k].angle0 + angle) > 0.2);
    const k = randPick(high.length ? high : lit);
    const p = podWorld(k, new THREE.Vector3());
    p.addScaledVector(axisW, randRange(2, 6));
    p.y += randRange(1, 4);
    pods[k].boost = 2.4;
    // burst() brings the whole kit: white-hot FlashPool light on the smoke,
    // the anamorphic flare, a basin-wide ambient pulse, the lingering smoke
    // ball — and audio.boom's true propagation delay: from camp the flash
    // arrives ~0.8 s before the report. That gap IS the size.
    fireworks.burst(p, { pattern: 'salute', size: randRange(0.95, 1.25), sound: 'big' });
    return p;
  }

  function chaseStrobe() {
    chaseIdx = (chaseIdx + 1) % N_PODS;
    const pod = pods[chaseIdx];
    if (pod.burn < 0.3) return;
    pod.boost = 2.2;
    const p = podWorld(chaseIdx, _v3);
    const px = p.x, py = p.y, pz = p.z;
    const rx = (px - hubWorld.x) / R_POD, ry = (py - hubWorld.y) / R_POD, rz = (pz - hubWorld.z) / R_POD;
    pool.spawn(22, (i) => {
      const sp = randRange(3, 10);
      pool.set(i,
        px + randRange(-1, 1), py + randRange(-1, 1), pz + randRange(-1, 1),
        rx * sp + randRange(-2, 2), ry * sp + randRange(-2, 2), rz * sp + randRange(-2, 2),
        3.4, 3.2, 2.9,
        fireworks.time, randRange(0.5, 1.1),
        randRange(0.3, 0.5), 0.5, 1.2, 30, CELL.STAR4);
    });
    audio.play('shot', p, {
      gain: 0.55, rate: 0.66, refDistance: 16, send: 0.45, delayBySound: true,
    });
  }

  // ---- public-ish state (tests, tinkering) ----
  const api = {
    group: root,
    wheel,
    pods,
    forcePhase(name, primed = true) {
      setPhase(name);
      if (name === 'glory' && primed) {
        for (const p of pods) { p.burn = 0.75; p.target = 1; }
      }
    },
    forceSalute: salute,
    get state() {
      return { phase, phaseT, omega, angle, burnAvg, emberAvg };
    },
  };

  // =========================================================================

  api.update = (dt, time) => {
    // ---- program clock ----
    phaseT += dt;
    while (events.length && events[0].t <= phaseT) events.shift().fn();
    if (phaseT >= phaseDur) {
      setPhase(phase === 'dark' ? 'kindle'
        : phase === 'kindle' ? 'glory'
          : phase === 'glory' ? 'sputter' : 'dark');
    }

    // ---- pod envelopes ----
    let bSum = 0, eSum = 0;
    for (const p of pods) {
      const tau = p.target > p.burn ? 2.0 : 3.2;
      p.burn += (p.target - p.burn) * (1 - Math.exp(-dt / tau));
      p.ember = Math.max(p.ember * Math.exp(-dt / 26), p.burn);
      p.boost *= Math.exp(-dt / 0.35);
      bSum += p.burn;
      eSum += p.ember;
    }
    burnAvg = bSum / N_PODS;
    emberAvg = eSum / N_PODS;

    // ---- rotation: torque vs quadratic aero drag vs bearing friction.
    // The inertia is the point — nothing about this wheel is instant. ----
    const drive = bSum * POD_ACCEL;
    omega += (drive - AERO * omega * Math.abs(omega) - (omega > 0.001 ? BEARING : 0)) * dt;
    if (omega < 0) omega = 0;
    angle += omega * dt;
    wheel.rotation.z = angle;

    // ---- palette drift ----
    paletteT -= dt;
    if (paletteT <= 0) {
      paletteT = 22;
      if (phase === 'glory') {
        palTargetA.set(randPick(PALETTES).a);
        palTargetB.set(randPick(PALETTES).a);
      }
    }
    const palK = 1 - Math.exp(-dt / 6);
    palA.lerp(palTargetA, palK);
    palB.lerp(palTargetB, palK);
    const flick = 0.8 + 0.14 * Math.sin(time * 11.3) + 0.1 * Math.sin(time * 4.7 + 1.3);
    fireCol.copy(palA).lerp(palB, 0.5).lerp(WARM, 0.35);

    // ---- glory events ----
    if (phase === 'glory') {
      saluteT -= dt;
      if (saluteT <= 0) {
        saluteT = randRange(8, 15);
        salute();
      }
      if (chaseLeft > 0) {
        chaseLeft -= dt;
        chaseStepT -= dt;
        if (chaseStepT <= 0) {
          chaseStepT = 0.26;
          chaseStrobe();
        }
      } else {
        chaseT -= dt;
        if (chaseT <= 0) {
          chaseT = randRange(30, 45);
          chaseLeft = 7;
        }
      }
    }

    // ---- lights, halo, lamps, smoke-light ----
    fireLight.color.copy(fireCol);
    fireLight.intensity = burnAvg * (2000 + 850 * flick) + emberAvg * 60;
    halo.material.color.copy(fireCol);
    halo.material.opacity = 0.13 * burnAvg * flick + 0.018 * emberAvg;
    halo.scale.setScalar(130 + 105 * burnAvg);
    wheelLampMat.uniforms.uTime.value = time;
    wheelLampMat.uniforms.uGlow.value = 1.05 + 0.55 * burnAvg;
    staticLampMat.uniforms.uTime.value = time;
    // aviation double-flash on the apex beacons
    const bt = time % 2.6;
    staticLampMat.uniforms.uBeacon.value = (bt < 0.18 || (bt > 0.42 && bt < 0.6)) ? 1.0 : 0.06;
    podMat.emissive.copy(EMBER).multiplyScalar(emberAvg * 0.8);
    const uf = pool.uniforms;
    uf.uFirePos.value.set(hubWorld.x, hubWorld.y, hubWorld.z, 380 * burnAvg * flick + 26 * emberAvg);
    uf.uFireColor.value.copy(fireCol);

    // ---- per-pod fire: flares, sparks, smoke, embers ----
    const listener = audio.listenerPos;
    const camDist = listener.distanceTo(hubWorld);
    for (let k = 0; k < N_PODS; k++) {
      const pod = pods[k];
      const podFlick = 0.75 + 0.25 * Math.sin(time * 10.7 + k * 2.43);
      flareSize.array[k] = pod.burn * 5.2 * podFlick + pod.boost * 3.2 + pod.ember * 0.7;
      _c1.copy(k % 2 ? palB : palA).lerp(WARM, 0.4);
      _c2.copy(_c1).multiplyScalar(0.85 * pod.burn * podFlick + 2.0 * pod.boost);
      const emberGlow = pod.ember * 0.4;
      flareTint.array[k * 3] = _c2.r + EMBER.r * emberGlow;
      flareTint.array[k * 3 + 1] = _c2.g + EMBER.g * emberGlow;
      flareTint.array[k * 3 + 2] = _c2.b + EMBER.b * emberGlow;

      const active = pod.burn > 0.02;
      const glow = pod.ember > 0.05;
      if (!active && !glow) { pod.wasBottom = false; continue; }

      const p = podWorld(k, _v3);
      const rx = (p.x - hubWorld.x), ry = (p.y - hubWorld.y), rz = (p.z - hubWorld.z);
      const rl = Math.hypot(rx, ry, rz) || 1;
      // motion direction: spin axis x radial
      let tx = axisW.y * rz - axisW.z * ry;
      let ty = axisW.z * rx - axisW.x * rz;
      let tz = axisW.x * ry - axisW.y * rx;
      const tl = Math.hypot(tx, ty, tz) || 1;
      tx /= tl; ty /= tl; tz /= tl;
      const tip = omega * rl;

      if (active) {
        // sparks: the drivers hose fire backward along the rim; each spark
        // inherits the (slow!) tip speed, so the spray combs into long arcs
        // that fall away beneath the wheel
        pod.sparkAcc += 105 * pod.burn * (0.7 + 0.5 * podFlick) * dt;
        let cnt = pod.sparkAcc | 0;
        pod.sparkAcc -= cnt;
        if (cnt > 0) {
          const col = _c1.copy(k % 2 ? palB : palA);
          pool.spawn(cnt, (i) => {
            const exh = randRange(15, 34);
            const white = Math.random() < 0.22;
            const star = Math.random() < 0.06;
            pool.set(i,
              p.x + randRange(-0.9, 0.9), p.y + randRange(-0.9, 0.9), p.z + randRange(-0.9, 0.9),
              tx * (tip - exh) + randRange(-2.2, 2.2) + (rx / rl) * randRange(-1, 2.5),
              ty * (tip - exh) + randRange(-2.2, 2.2) + (ry / rl) * randRange(-1, 2.5),
              tz * (tip - exh) + randRange(-2.2, 2.2) + (rz / rl) * randRange(-1, 2.5),
              white ? 3.6 : col.r * 3.2, white ? 3.4 : col.g * 3.2, white ? 3.1 : col.b * 3.2,
              time, randRange(1.1, 2.9),
              randRange(0.26, 0.5), 0.85, 0.3, 0,
              star ? CELL.STAR6 : CELL.GLOW, 0.07);
          });
        }

        // its own gunpowder plume, drifting downwind and lit by its fire
        pod.smokeAcc += 3.0 * pod.burn * dt;
        cnt = pod.smokeAcc | 0;
        pod.smokeAcc -= cnt;
        if (cnt > 0) {
          pool.spawn(cnt, (i) => {
            pool.set(i,
              p.x + randRange(-1, 1), p.y + randRange(-0.5, 1.5), p.z + randRange(-1, 1),
              tx * tip * 0.35 + WIND.x * randRange(0.7, 1.3) + randRange(-0.4, 0.4),
              randRange(0.8, 1.8),
              tz * tip * 0.35 + WIND.z * randRange(0.7, 1.3) + randRange(-0.4, 0.4),
              0.34 + fireCol.r * 0.08, 0.34 + fireCol.g * 0.08, 0.37 + fireCol.b * 0.08,
              time, randRange(7, 14),
              randRange(3.2, 6.5), -0.015, 0.8, -1);
          });
        }

        // pass-by: a pod sweeping the bottom of the arc, heard from beneath
        const bottom = Math.sin(pod.angle0 + angle) < -0.92;
        if (bottom && !pod.wasBottom && camDist < 90 && pod.burn > 0.25 && audio.ready) {
          audio.play('whoosh', p, {
            gain: clamp(40 / camDist, 0.3, 1.0) * 0.4,
            rate: 0.42, refDistance: 9, send: 0.25,
          });
        }
        pod.wasBottom = bottom;
      } else if (glow) {
        // dying coals drip off the cold pods
        pod.emberAcc += 2.0 * pod.ember * dt;
        let cnt = pod.emberAcc | 0;
        pod.emberAcc -= cnt;
        if (cnt > 0) {
          pool.spawn(cnt, (i) => {
            pool.set(i,
              p.x + randRange(-0.6, 0.6), p.y + randRange(-0.6, 0.3), p.z + randRange(-0.6, 0.6),
              tx * tip + randRange(-0.5, 0.5), randRange(-0.5, 0.2), tz * tip + randRange(-0.5, 0.5),
              1.6, 0.45, 0.1,
              time, randRange(0.8, 1.9),
              randRange(0.12, 0.2), 0.8, 0.5, 0);
          });
        }
      }
    }
    flareSize.needsUpdate = true;
    flareTint.needsUpdate = true;

    // ---- the dust bank: a standing haze around the base so the monument
    // never sits in optically empty air (in-world atmosphere, not lens DoF)
    dustAcc += 1.7 * dt;
    let dcnt = dustAcc | 0;
    dustAcc -= dcnt;
    if (dcnt > 0) {
      pool.spawn(dcnt, (i) => {
        const a = Math.random() * Math.PI * 2;
        const r = randRange(16, 55);
        const x = COLOSSUS_POS.x + Math.cos(a) * r;
        const z = COLOSSUS_POS.z + Math.sin(a) * r;
        pool.set(i,
          x, terrainHeight(x, z) + randRange(0.6, 2.6), z,
          WIND.x * randRange(0.5, 1.1), randRange(0.05, 0.22), WIND.z * randRange(0.5, 1.1),
          0.20, 0.195, 0.215,
          time, randRange(12, 24),
          randRange(6, 11), -0.004, 0.6, -1);
      });
    }

    // ---- the roar ----
    if (!roar && burnAvg > 0.03 && audio.ready) {
      roar = audio.play('colossus', hubWorld, {
        gain: 0.01, loop: true, refDistance: 55, send: 0.5, lowpass: 3000,
      });
    }
    if (roar) {
      if (burnAvg < 0.02) {
        roar.stop(3);
        roar = null;
      } else {
        roar.setGain(1.35 * Math.min(1, burnAvg * 1.15));
        roar.setRate(0.85 + 0.3 * burnAvg);
        // air absorption: bass mountain from camp, furnace up close
        roar.setLowpass(clamp(8000 - Math.max(0, camDist - 45) * 26, 850, 8000));
      }
    }

    // ---- bearing groans, for pilgrims only ----
    creakT -= dt;
    if (creakT <= 0 && camDist < 170 && omega > 0.012 && audio.ready) {
      creakT = randRange(4.5, 10);
      const g = clamp(60 / camDist, 0.25, 1) * randRange(0.5, 1);
      if (Math.random() < 0.65) {
        audio.play('groan', hubWorld, {
          gain: g * 0.9, rate: randRange(0.75, 1.15), refDistance: 18, send: 0.3,
        });
      } else {
        _v4.copy(hubWorld);
        _v4.y = baseY + 4;
        audio.play('tick', _v4, { gain: g * 0.5, rate: 0.32, refDistance: 10 });
      }
    } else if (creakT <= 0) {
      creakT = 2;
    }
  };

  return api;
}
