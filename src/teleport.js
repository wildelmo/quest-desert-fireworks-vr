// Teleport rings: a glowing brass pull-ring on a rope. Grab it (VR) or click
// it (desktop) and it whisks you across the desert in a flash of gold — out
// to the Colossus's feet, and back home to camp. The 280 m is real and
// walkable (the distance is the point), but nobody should have to make the
// pilgrimage twice.
//
// TeleportRing is just the rope + ring + magic, and hangs off any parent
// (the Colossus trailhead sign carries one under its board). TeleportStation
// is a free-standing waypost that exists to hold a ring where there's no
// sign to borrow.

import * as THREE from 'three';
import { terrainHeight } from './terrain.js';
import { randRange } from './utils.js';
import { CELL } from './particles.js';

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);

let _glowTex = null;
function glowTex() {
  if (_glowTex) return _glowTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,0.9)');
  grad.addColorStop(0.4, 'rgba(255,255,255,0.28)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  _glowTex = new THREE.CanvasTexture(c);
  return _glowTex;
}

function boardTexture(title, sub1, sub2) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#54422a';
  g.fillRect(0, 0, 512, 256);
  g.strokeStyle = 'rgba(26,17,8,0.5)';
  for (let i = 0; i < 6; i++) {
    g.lineWidth = 1 + Math.random() * 2;
    g.beginPath();
    g.moveTo(0, 24 + i * 38 + Math.random() * 10);
    g.lineTo(512, 24 + i * 38 + Math.random() * 10);
    g.stroke();
  }
  g.fillStyle = '#f2e3bc';
  g.font = 'bold 52px Georgia, serif';
  g.textAlign = 'center';
  g.fillText(title, 256, 84);
  g.font = '30px Georgia, serif';
  g.fillStyle = '#e8cf9a';
  g.fillText(sub1, 256, 150);
  g.font = '26px Georgia, serif';
  g.fillStyle = '#c9ab72';
  g.fillText(sub2, 256, 206);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class TeleportRing {
  /**
   * parent: any Object3D the rope ties onto (a sign, a waypost arm).
   * attach: the local point in `parent` the rope hangs from; drop: rope length.
   * dest/destFace: where the rider's head lands (XZ) and what they face on
   * arrival — you always come out of the flash looking at the payoff.
   * aimRoot: what the desktop crosshair may rest on to count as "aimed at
   * this ring" (defaults to the parent, so clicking the whole sign works).
   */
  constructor({ parent, audio, pool, attach, drop = 0.3, dest, destFace, hint, aimRoot = null }) {
    this.audio = audio;
    this.pool = pool;
    this.dest = dest.clone();
    this.destFace = destFace.clone();
    this.hint = hint;
    this.aimRoot = aimRoot ?? parent;
    this.cooldown = 0;
    this.time = 0;
    this._phase = Math.random() * 7;
    this._ringY = attach.y - drop - 0.085;

    const root = new THREE.Group();
    this.root = root;

    const rope = new THREE.Mesh(
      new THREE.CylinderGeometry(0.008, 0.008, drop, 5),
      new THREE.MeshStandardMaterial({ color: 0x3a2f20, roughness: 0.95 }),
    );
    rope.position.set(attach.x, attach.y - drop / 2, attach.z);
    root.add(rope);

    this.ringMat = new THREE.MeshStandardMaterial({
      color: 0x8a6f3a, roughness: 0.3, metalness: 0.85, envMapIntensity: 1.0,
      emissive: 0xff9540, emissiveIntensity: 0.55,
    });
    this.ring = new THREE.Mesh(new THREE.TorusGeometry(0.095, 0.016, 8, 24), this.ringMat);
    this.ring.position.set(attach.x, this._ringY, attach.z);
    root.add(this.ring);

    // soft additive halo: at night this is what says "the magic part"
    this.glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTex(), color: 0xffa050, transparent: true, opacity: 0.3,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.glow.scale.setScalar(0.5);
    this.glow.position.copy(this.ring.position);
    root.add(this.glow);

    parent.add(root);
  }

  ringWorldPos(out) {
    return this.ring.getWorldPosition(out);
  }

  /**
   * Whisk the rig to the destination. onYaw (optional) receives the applied
   * yaw delta — desktop controls track their own yaw and must be told.
   * Returns false while the previous flash is still cooling down.
   */
  use(player, camera, onYaw = null) {
    if (this.cooldown > 0) return false;
    this.cooldown = 2;

    const head = camera.getWorldPosition(_v1);
    this._sparkle(head.x, head.y - 1.3, head.z);
    if (this.audio.ready) {
      this.audio.play('whoosh', head, { gain: 0.8, rate: 1.25, refDistance: 4 });
    }

    // yaw the rig so you arrive facing the landmark — rotate about the head
    // (like snap-turn) so the world pivots around you instead of sliding
    const fwd = _v2.set(0, 0, -1).applyQuaternion(camera.getWorldQuaternion(_q1));
    fwd.y = 0;
    if (fwd.lengthSq() > 1e-4) {
      fwd.normalize();
      const dx = this.destFace.x - this.dest.x, dz = this.destFace.z - this.dest.z;
      const dl = Math.hypot(dx, dz) || 1;
      const delta = Math.atan2(
        fwd.z * (dx / dl) - fwd.x * (dz / dl),
        fwd.x * (dx / dl) + fwd.z * (dz / dl),
      );
      player.position.sub(head);
      player.position.applyAxisAngle(UP, delta);
      player.position.add(head);
      player.rotateY(delta);
      onYaw?.(delta);
    }

    // then slide the rig so the head lands on the destination
    player.position.x += this.dest.x - head.x;
    player.position.z += this.dest.z - head.z;
    player.position.y = terrainHeight(this.dest.x, this.dest.z);

    this._sparkle(this.dest.x, player.position.y, this.dest.z);
    if (this.audio.ready) {
      _v2.set(this.dest.x, player.position.y + 1.5, this.dest.z);
      this.audio.play('whoosh', _v2, { gain: 0.9, rate: 1.1, refDistance: 4 });
      this.audio.play('thud', _v2, { gain: 0.5, rate: 1.3, refDistance: 3 });
    }
    return true;
  }

  // a person-sized column of golden sparks — played at both ends of the trip
  _sparkle(x, y, z) {
    const { pool } = this;
    const t = this.time;
    pool.spawn(60, (i) => {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * 0.55;
      const gold = Math.random() < 0.7;
      pool.set(i,
        x + Math.cos(a) * r, y + randRange(0, 1.9), z + Math.sin(a) * r,
        Math.cos(a) * randRange(0.1, 0.5), randRange(0.8, 2.4), Math.sin(a) * randRange(0.1, 0.5),
        gold ? 2.4 : 2.8, gold ? 1.7 : 2.6, gold ? 0.6 : 2.4,
        t, randRange(0.5, 1.1),
        randRange(0.02, 0.045), -0.06, 1.6, 20,
        Math.random() < 0.3 ? CELL.STAR4 : CELL.GLOW);
    });
  }

  update(dt, time) {
    this.time = time;
    if (this.cooldown > 0) this.cooldown -= dt;
    // the ring bobs, sways and breathes so it reads as "grab me" from afar
    const bob = Math.sin(time * 1.7 + this._phase) * 0.025;
    this.ring.position.y = this._ringY + bob;
    this.ring.rotation.y = Math.sin(time * 0.9 + this._phase) * 0.35;
    this.glow.position.y = this.ring.position.y;
    const pulse = 0.75 + 0.25 * Math.sin(time * 2.6 + this._phase);
    this.ringMat.emissiveIntensity = 0.35 + 0.45 * pulse;
    this.glow.material.opacity = 0.16 + 0.2 * pulse;
  }
}

export class TeleportStation {
  /**
   * A free-standing waypost carrying a board and a ring, for spots with no
   * existing sign. position/faceTarget: where it stands, what the board faces.
   */
  constructor({ scene, audio, pool, position, faceTarget, dest, destFace, title, sub1, sub2, hint }) {
    const root = new THREE.Group();
    this.root = root;
    root.position.set(position.x, terrainHeight(position.x, position.z), position.z);
    root.rotation.y = Math.atan2(faceTarget.x - position.x, faceTarget.z - position.z);

    const wood = new THREE.MeshStandardMaterial({
      color: 0x5a442c, roughness: 0.8, metalness: 0, envMapIntensity: 0.35,
    });
    const woodDark = new THREE.MeshStandardMaterial({
      color: 0x4a3a26, roughness: 0.8, metalness: 0, envMapIntensity: 0.35,
    });

    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.05, 2.1, 7), wood);
    post.position.y = 1.05;
    post.castShadow = true;
    root.add(post);

    // gallows arm (plus a diagonal brace) that the ring hangs from
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.055, 0.055), wood);
    arm.position.set(0.3, 2.02, 0);
    arm.castShadow = true;
    root.add(arm);
    const brace = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.04, 0.04), woodDark);
    brace.position.set(0.16, 1.85, 0);
    brace.rotation.z = 0.75;
    root.add(brace);

    const tex = boardTexture(title, sub1, sub2);
    const board = new THREE.Mesh(
      new THREE.BoxGeometry(0.95, 0.48, 0.04),
      [woodDark, woodDark, woodDark, woodDark,
        new THREE.MeshStandardMaterial({
          map: tex, roughness: 0.72, envMapIntensity: 0.4,
          // faint self-glow so the invitation reads by moonlight
          emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.16,
        }),
        woodDark],
    );
    // nailed to the FRONT of the post (post radius ≈0.04 at this height,
    // board back face at z=0.045) so the post can never cross the text — the
    // same never-occlude-the-words rule as the camp and exit signs
    board.position.set(0, 1.38, 0.065);
    board.rotation.z = 0.015;
    board.castShadow = true;
    root.add(board);

    scene.add(root);

    this.ring = new TeleportRing({
      parent: root, audio, pool,
      attach: new THREE.Vector3(0.58, 1.99, 0),
      drop: 0.3,
      dest, destFace, hint,
      aimRoot: root,
    });
    this.hint = hint;
    this.aimRoot = root;
  }

  ringWorldPos(out) { return this.ring.ringWorldPos(out); }

  use(player, camera, onYaw = null) { return this.ring.use(player, camera, onYaw); }

  update(dt, time) { this.ring.update(dt, time); }
}
