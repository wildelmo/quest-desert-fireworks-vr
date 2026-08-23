// Shared desert wind: one slowly-wandering horizontal vector that every
// system reads — burst smoke drift, torch lean, ambient dust, the audio
// wind bed — so the whole scene agrees on which way the night is blowing.
//
// world.update() calls updateWind() once per frame; everyone else imports
// WIND and treats it as read-only. windGust() is a 0..1 scalar for things
// that should surge with the gusts (dust density, wind-loop gain).

import * as THREE from 'three';
import { valueNoise2 } from './utils.js';

export const WIND = new THREE.Vector3(0.55, 0, 0.25); // m/s, horizontal

let _gust = 0;

export function updateWind(dt, time) {
  // azimuth wanders over minutes, speed breathes over ~30 s, gusts ride on top
  const az = valueNoise2(time * 0.006, 3.7) * Math.PI;
  const base = 0.85 + valueNoise2(time * 0.03, 11.3) * 0.45;
  _gust = Math.max(0, valueNoise2(time * 0.12, 27.1)) * Math.max(0, valueNoise2(time * 0.31, 51.7));
  const s = base + _gust * 1.4;
  const k = Math.min(1, dt * 0.4); // ease so direction changes read as weather
  WIND.x += (Math.cos(az) * s - WIND.x) * k;
  WIND.z += (Math.sin(az) * s - WIND.z) * k;
  return WIND;
}

export function windGust() { return _gust; }
