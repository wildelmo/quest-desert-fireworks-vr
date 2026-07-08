// Feature exercise: held-rocket restraint + pinwheel lifecycle.
import { chromium } from 'playwright-core';

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 480, height: 320 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await page.goto('http://localhost:8080/?autostart=desktop', { waitUntil: 'load' });
await page.waitForTimeout(2500);
page.setDefaultTimeout(300000);

const r = await page.evaluate(async () => {
  const app = window.__app;
  const { fireworks, interactions, THREE } = app;
  const d = interactions.desktop;
  const out = {};
  // headless swiftshader runs the frame loop far below realtime; wait on the
  // game clock, not the wall clock
  const waitGame = (sec) => new Promise((res) => {
    const t0 = fireworks.time;
    const id = setInterval(() => {
      if (fireworks.time - t0 >= sec) { clearInterval(id); res(); }
    }, 50);
  });
  const grabLikeDesktop = (item) => {
    interactions.grab(item, d.handAnchor, d);
    d.held = item;
    item.root.position.set(0, -(item.grabY ?? 0.1), 0);
    item.root.quaternion.identity();
  };

  // ---- 1) rocket held down: motor fires but it stays in the hand ----
  const rkt = fireworks.createItem('rocketMed');
  grabLikeDesktop(rkt);
  fireworks.activate(rkt); // skip the fuse, motor lights in the grip
  const rec = fireworks.rockets.find((rr) => rr.item === rkt);
  out.heldRecord = !!rec && rec.held === true;
  out.stateActive = rkt.state === 'active';
  out.stillHeld = rkt.holder === d;

  await waitGame(0.5); // motor burning in hand
  const handWorld = d.handAnchor.getWorldPosition(new THREE.Vector3());
  // rec.pos is the stick BASE, which hangs grabY below the grip point
  out.pinnedToHand = rkt.root.parent === d.handAnchor
    && rec.pos.distanceTo(handWorld) < rkt.grabY + 0.25;
  out.clockRan = rec.age > 0.4;

  // release: it should take off from the hand and climb
  const releaseY = rec.pos.y;
  interactions.release(rkt);
  d.held = null;
  await waitGame(0.6);
  out.flewOnRelease = rec.held === false && rkt.root.parent !== d.handAnchor
    && rec.pos.y > releaseY + 1.0;

  // ---- 2) rocket held to the very end: pops right in the hand ----
  const rkt2 = fireworks.createItem('rocketSmall'); // explodeAt ≈ 1.8-2.2 s
  grabLikeDesktop(rkt2);
  fireworks.activate(rkt2);
  await waitGame(2.6);
  out.heldToBurst = !fireworks.items.has(rkt2) && d.held === null
    && !fireworks.rockets.some((rr) => rr.item === rkt2);

  // ---- 3) pinwheel spins up, sprays, winds down, chars ----
  const pw = fireworks.createItem('pinwheel');
  pw.root.position.set(3, fireworks.groundHeight(3, -4), -4);
  pw.state = 'planted';
  fireworks.activate(pw);
  await waitGame(1.5);
  const em = fireworks.emitters.find((e) => e.kind === 'pinwheel' && e.item === pw);
  out.pinwheelEmitter = !!em;
  out.spunUp = !!em && em.spinVel > 10;
  out.wheelTurning = Math.abs(pw.wheel.rotation.y) > 3;
  out.flaresRiding = !!em && em.flares.length === 4
    && em.flares.every((f) => f.parent && pw.driverAnchors.includes(f.parent));
  out.soundLooping = !!em && !!em.sound;

  // grab a live one — should be allowed, like fountains
  out.liveGrabbable = interactions.grabbables().includes(pw);
  fireworks.removeItem(pw);

  // despawn mid-spin must clean up flares + emitter
  const pw2 = fireworks.createItem('pinwheel');
  pw2.root.position.set(-3, fireworks.groundHeight(-3, -4), -4);
  pw2.state = 'planted';
  fireworks.activate(pw2);
  await waitGame(0.3);
  const em2 = fireworks.emitters.find((e) => e.kind === 'pinwheel' && e.item === pw2);
  fireworks.removeItem(pw2);
  await waitGame(0.2);
  out.despawnCleanup = !fireworks.emitters.includes(em2) && em2.flares.length === 0;

  // pinwheel appears in the restock lottery
  const names = new Set();
  for (let i = 0; i < 400; i++) names.add(fireworks.randomTypeName());
  out.inLottery = names.has('pinwheel');

  return out;
});

console.log(JSON.stringify(r, null, 1));
const realErrs = errs.filter((e) => !e.includes('404'));
console.log(realErrs.length ? 'ERRORS:\n' + realErrs.join('\n') : 'no page errors');
await browser.close();
process.exit(Object.values(r).every((v) => v === true) && !realErrs.length ? 0 : 1);
