// Bootstrap: renderer, scene, player rig, system wiring, XR session and the
// frame loop. Also a ?demo=1 mode that plants and lights fireworks on its
// own — used for automated screenshots and nice for spectating.

import * as THREE from 'three';
import { terrainHeight } from './terrain.js';
import { ParticlePool } from './particles.js';
import { AudioEngine } from './audio.js';
import { FireworksSystem } from './fireworks.js';
import { createWorld } from './world.js';
import { COLOSSUS_POS } from './colossus.js';
import { Interactions, XRHand, DesktopControls } from './input.js';
import { randRange, randPick, clamp } from './utils.js';

const params = new URLSearchParams(location.search);

// ---------------------------------------------------------------------------
// renderer / scene / rig

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.xr.enabled = true;
// fixed foveated rendering OFF by default (three.js defaults it to 1.0):
// FFR's screen-fixed tile boundaries are glaring on this content — thin
// bright lattice and soft glows on near-black sky — showing up as a dark
// seam that sweeps the Colossus when you tilt your head, and a vertical
// resolution step at the lens edge. The scene is cheap enough to render
// the periphery at full res; ?foveation=0..1 opts back in on weak GPUs.
const foveation = parseFloat(params.get('foveation'));
renderer.xr.setFoveation(Number.isFinite(foveation) ? clamp(foveation, 0, 1) : 0);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
// real moon shadows over the campsite (?shadows=0 to opt out on weak GPUs);
// the shadow frustum is a tight box around the play area, so the extra pass
// only redraws the campsite props
if (params.get('shadows') !== '0') {
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
}
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x04050c);

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 4000);

const player = new THREE.Group();       // the rig locomotion moves
player.position.set(-0.7, 0, 0.2);      // spawn right by the supply crate
player.add(camera);
camera.position.set(0, 1.65, 0);        // desktop eye height; XR overrides
scene.add(player);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------------------------------------------------------------------------
// systems

const pool = new ParticlePool(96000, terrainHeight);
scene.add(pool.points);

const audio = new AudioEngine();
const fireworks = new FireworksSystem(scene, pool, audio, terrainHeight);
const world = createWorld(scene, fireworks, pool, audio);
const interactions = new Interactions({ scene, camera, player, renderer, fireworks, world, audio });

// XR hands
interactions.hands.push(new XRHand(0, interactions), new XRHand(1, interactions));

// ---------------------------------------------------------------------------
// entry buttons

const overlay = document.getElementById('overlay');
const btnVR = document.getElementById('btn-vr');
const btnDesktop = document.getElementById('btn-desktop');

let xrSession = null;

async function checkVR() {
  try {
    if (navigator.xr && await navigator.xr.isSessionSupported('immersive-vr')) {
      btnVR.disabled = false;
      btnVR.textContent = 'Start VR';
      return;
    }
  } catch { /* fall through */ }
  btnVR.textContent = 'VR not available here';
}
checkVR();

btnVR.addEventListener('click', async () => {
  try {
    await audio.init();
    xrSession = await navigator.xr.requestSession('immersive-vr', {
      optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'],
    });
    xrSession.addEventListener('end', () => {
      xrSession = null;
      overlay.classList.remove('hidden');
      btnVR.textContent = 'Start VR';
      // back at the menu: don't leave desert wind playing in the flat tab
      audio.setActive(false);
    });
    await renderer.xr.setSession(xrSession);
    overlay.classList.add('hidden');
    audio.setActive(true);
  } catch (err) {
    console.error('Failed to start VR session:', err);
    btnVR.textContent = 'VR failed to start';
    audio.setActive(false);
  }
});

async function startDesktop(withPointerLock) {
  await audio.init();
  audio.setActive(true);
  overlay.classList.add('hidden');
  if (params.get('demo')) return; // spectator mode: no controls fighting the orbit
  if (!interactions.desktop) {
    interactions.desktop = new DesktopControls(interactions);
  }
  interactions.desktop.enable();
  if (withPointerLock) {
    try {
      const p = renderer.domElement.requestPointerLock?.();
      p?.catch?.(() => { /* headless / no gesture */ });
    } catch { /* unsupported */ }
  }
}
btnDesktop.addEventListener('click', () => startDesktop(true));

// the in-world EXIT sign: end the VR session / drop back to the menu.
// A web page can't close the browser itself; window.close() is attempted as
// a best effort (it only works for script-opened tabs).
let exiting = false;
interactions.onExit = () => {
  if (exiting) return;
  exiting = true;
  setTimeout(() => { exiting = false; }, 1500);
  if (renderer.xr.isPresenting) {
    xrSession?.end(); // the session 'end' handler shows the menu and mutes
  } else {
    interactions.desktop?.disable();
    document.exitPointerLock?.();
    overlay.classList.remove('hidden');
    audio.setActive(false);
  }
  setTimeout(() => { try { window.close(); } catch { /* not script-opened */ } }, 500);
};

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    audio.setActive(false);
  } else if (xrSession || interactions.desktop?.enabled) {
    audio.setActive(true);
  }
});

// ---------------------------------------------------------------------------
// demo mode: the desert entertains itself

let demo = null;
if (params.get('demo')) {
  demo = { next: 1.2, orbit: params.get('orbit') !== '0' };
  // ?look=up pitches the spectator camera at the sky — bursts break 50-100 m
  // nearly overhead, so the default horizon view never catches them in
  // screenshots
  if (params.get('look') === 'up') camera.rotation.x = 1.05;
  // ?look=wheel aims at the Colossus for screenshots of the big fire-wheel
  if (params.get('look') === 'wheel') {
    player.rotation.y = Math.atan2(-COLOSSUS_POS.x, -COLOSSUS_POS.z);
    camera.rotation.x = 0.12;
    demo.orbit = false;
  }
}

const _demoQ = new THREE.Quaternion();
const _demoFwd = new THREE.Vector3();

function demoUpdate(dt, time) {
  demo.next -= dt;
  if (demo.next <= 0) {
    demo.next = randRange(1.6, 3.2);
    const type = randPick(['rocketSmall', 'rocketMed', 'rocketMed', 'rocketLarge', 'rocketLarge', 'rocketGrand', 'cake', 'fountain', 'candle', 'pinwheel', 'pinwheel', 'belt', 'belt']);
    const item = fireworks.createItem(type);
    // spawn in front of wherever the camera actually faces
    _demoFwd.set(0, 0, -1).applyQuaternion(camera.getWorldQuaternion(_demoQ));
    _demoFwd.y = 0;
    if (_demoFwd.lengthSq() < 0.01) _demoFwd.set(0, 0, -1);
    _demoFwd.normalize();
    const r = randRange(7, 18);
    const x = player.position.x + _demoFwd.x * r - _demoFwd.z * randRange(-8, 8);
    const z = player.position.z + _demoFwd.z * r + _demoFwd.x * randRange(-8, 8);
    item.root.position.set(x, terrainHeight(x, z), z);
    item.root.rotateOnWorldAxis(
      new THREE.Vector3(randRange(-1, 1), 0, randRange(-1, 1)).normalize(),
      randRange(0, 0.3),
    );
    item.state = 'planted';
    item.ignite();
  }
  if (demo.orbit) {
    player.rotation.y += dt * 0.02;
  }
}

// autostart hooks for automated testing
if (params.get('autostart') === 'desktop' || params.get('demo')) {
  setTimeout(() => startDesktop(false), 50);
}

// expose for tests / tinkering
window.__app = { scene, camera, player, renderer, fireworks, world, audio, pool, interactions, THREE };

// ---------------------------------------------------------------------------
// frame loop

const clock = new THREE.Clock();
const _headWorld = new THREE.Vector3();
let time = 0;

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  time += dt;

  // keep the rig glued to the dunes under the head
  camera.getWorldPosition(_headWorld);
  const targetY = terrainHeight(_headWorld.x, _headWorld.z);
  player.position.y += (targetY - player.position.y) * Math.min(1, dt * 12);

  world.update(dt, time);
  fireworks.update(dt, time);
  interactions.update(dt, time);
  if (demo) demoUpdate(dt, time);

  // gl_PointSize is in framebuffer pixels — in XR that's the eye buffer,
  // not the mirror canvas
  let fbWidth = renderer.domElement.width;
  let fbHeight = renderer.domElement.height;
  if (renderer.xr.isPresenting) {
    const layer = renderer.xr.getBaseLayer?.();
    fbWidth = (layer?.framebufferWidth ?? layer?.textureWidth ?? fbWidth * 2) / 2; // per-eye
    fbHeight = layer?.framebufferHeight ?? layer?.textureHeight ?? fbHeight;
  }
  pool.update(time, fbWidth, fbHeight);
  audio.updateListener(renderer.xr.isPresenting ? renderer.xr.getCamera() : camera);

  renderer.render(scene, camera);
});
