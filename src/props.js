// The spectator lounge — a little chill-out nook behind the spawn point,
// furnished with real product scans from the Amazon Berkeley Objects
// dataset (CC BY 4.0, see assets/models/ATTRIBUTION.md): two zero-gravity
// loungers aimed at the launch area, a woven rug, a reclaimed-wood side
// table with a candle lantern, a pouf, and a patio heater for the cold
// desert night. Models stream in async after first paint; the scene works
// fine (just barer) until they arrive.

import * as THREE from 'three';
import { GLTFLoader } from '../lib/GLTFLoader.js';

const MODEL_DIR = 'assets/models/';

// [file, x, z, rotY, contact-shadow radii [rx, rz] (null = skip)]
// All ABO models stand on their local Y=0 plane, so terrainHeight is all
// the grounding they need. The nook sits at +z: turn around from spawn and
// it's there; sit down and you face the launch sand.
const LAYOUT = [
  ['rug-diamond.glb', 0.90, 2.55, -1.62, null], // shadows would double-darken a flat rug
  ['lounger-black.glb', 0.30, 3.00, 2.85, [0.55, 0.65]],
  ['lounger-beige.glb', 1.55, 2.90, 3.45, [0.55, 0.65]],
  ['side-table.glb', 0.93, 3.42, 0.35, [0.30, 0.30]],
  ['pouf-boho.glb', 0.05, 2.05, 0.9, [0.34, 0.34]],
];

const HEATER = { x: 2.65, z: 3.55, rotY: -2.5 };

const SIDE_TABLE_H = 0.60; // the lantern sits on top of it

export function createLounge(scene, terrainHeight, contactShadow) {
  const loader = new GLTFLoader().setPath(MODEL_DIR);

  const place = (obj, x, z, rotY, extraY = 0) => {
    obj.position.set(x, terrainHeight(x, z) + extraY, z);
    obj.rotation.y = rotY;
    obj.traverse((n) => {
      if (n.isMesh) {
        n.castShadow = true;
        n.receiveShadow = true;
        // tame the IBL a touch so the scans sit in the same night as the
        // hand-built props (which use 0.4)
        if (n.material) n.material.envMapIntensity = 0.5;
      }
    });
    scene.add(obj);
  };

  for (const [file, x, z, rotY, shadow] of LAYOUT) {
    loader.load(file, (g) => {
      place(g.scene, x, z, rotY);
      if (shadow) scene.add(contactShadow(x, z, shadow[0], shadow[1], 0.45));
    });
  }

  // the candle lantern rides on the side table, and is the nook's light
  const [, tx, tz] = LAYOUT[3];
  const candle = new THREE.PointLight(0xffb050, 0, 9, 1.9);
  candle.position.set(tx, terrainHeight(tx, tz) + SIDE_TABLE_H + 0.16, tz);
  scene.add(candle);
  loader.load('lantern.glb', (g) => {
    place(g.scene, tx, tz, -0.7, SIDE_TABLE_H);
    // let the "flame" surfaces actually glow
    g.scene.traverse((n) => {
      if (n.isMesh && n.material && n.material.emissive) {
        n.material.emissive.set(0xffb050);
        n.material.emissiveIntensity = 0.35;
      }
    });
    candle.intensity = 2.4; // light up only once there's a lantern to blame
  });

  // patio heater: a steady amber column glow from the burn tube
  const heaterGlow = new THREE.PointLight(0xff8a30, 0, 7, 2.0);
  heaterGlow.position.set(HEATER.x, terrainHeight(HEATER.x, HEATER.z) + 1.7, HEATER.z);
  scene.add(heaterGlow);
  loader.load('patio-heater.glb', (g) => {
    place(g.scene, HEATER.x, HEATER.z, HEATER.rotY);
    scene.add(contactShadow(HEATER.x, HEATER.z, 0.4, 0.4, 0.45));
    heaterGlow.intensity = 1.6;
  });

  return {
    update(time) {
      if (candle.intensity > 0) {
        candle.intensity = 2.4 + Math.sin(time * 9.7) * 0.35 + Math.sin(time * 4.3) * 0.2;
      }
      if (heaterGlow.intensity > 0) {
        heaterGlow.intensity = 1.6 + Math.sin(time * 13.1) * 0.12;
      }
    },
  };
}
