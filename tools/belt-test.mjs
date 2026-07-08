// Feature exercise: firecracker belt lifecycle — coil, grab/pin, rope sim,
// burn-front consumption, throw momentum, spend + cleanup.
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
page.setDefaultTimeout(400000);

const r = await page.evaluate(async () => {
  const app = window.__app;
  const { fireworks, interactions, THREE } = app;
  const d = interactions.desktop;
  const out = {};
  const waitGame = (sec) => new Promise((res) => {
    const t0 = fireworks.time;
    const id = setInterval(() => {
      if (fireworks.time - t0 >= sec) { clearInterval(id); res(); }
    }, 50);
  });

  // ---- 1) coiled in place while idle ----
  const belt = fireworks.createItem('belt');
  belt.root.position.set(2, fireworks.groundHeight(2, -3), -3);
  await waitGame(0.4);
  out.frozenCoil = belt.beltFrozen === true;
  const spanIdle = belt.beltPts[0].p.distanceTo(belt.beltPts[belt.beltPts.length - 1].p);
  out.coilCompact = spanIdle < 0.3; // rolled up, not a meter-long line

  // ---- 2) grab: unfreezes, pins nearest point, dangles from the hand ----
  interactions.grab(belt, d.handAnchor, d);
  d.held = belt;
  await waitGame(1.2);
  out.unfrozen = belt.beltFrozen === false;
  const hand = d.handAnchor.getWorldPosition(new THREE.Vector3());
  out.pinnedToHand = belt.beltPts[belt.beltPinned].p.distanceTo(hand) < 0.15;
  // dangling: lowest point well below the hand
  let lowest = Infinity;
  for (const pt of belt.beltPts) lowest = Math.min(lowest, pt.p.y);
  // grabbed mid-coil the strand halves, so each side hangs ~length/2
  out.dangles = hand.y - lowest > 0.35;
  // rope length approximately conserved
  let len = 0;
  for (let i = 0; i < belt.beltPts.length - 1; i++) len += belt.beltPts[i].p.distanceTo(belt.beltPts[i + 1].p);
  out.ropeLengthOk = Math.abs(len - belt.type.length) < 0.12;

  // ---- 3) fuse anchor tracks the dangling far end ----
  const fusePos = belt.fuseWorldPos(new THREE.Vector3());
  const endPos = belt.beltPts[belt.beltPts.length - 1].p;
  out.fuseAtEnd = fusePos.distanceTo(endPos) < 0.12;

  // ---- 4) light it while held, then toss: pops, consumption, writhing ----
  belt.ignite();
  out.lit = belt.isLit;
  await waitGame(2.2); // fuse 1.8s -> active
  out.active = belt.state === 'active';
  interactions.release(belt);
  d.held = null;
  out.releasedState = belt.state === 'active';
  await waitGame(3.0);
  const emitter = fireworks.emitters.find((e) => e.kind === 'belt' && e.item === belt);
  out.emitterRunning = !!emitter;
  out.consuming = belt.beltConsumed > 8 && belt.beltConsumed < belt.type.crackers;
  out.loopPlaying = !!emitter?.loop;
  // rope should have landed on the sand
  let onGround = 0;
  for (const pt of belt.beltPts) {
    if (pt.p.y - fireworks.groundHeight(pt.p.x, pt.p.z) < 0.1) onGround++;
  }
  out.draped = onGround >= belt.beltPts.length - 3;

  // ---- 5) runs to completion, spends, cleans up ----
  await waitGame(11.5);
  out.allConsumed = belt.beltConsumed === belt.type.crackers;
  out.spent = belt.state === 'spent';
  out.emitterGone = !fireworks.emitters.some((e) => e.kind === 'belt' && e.item === belt);
  out.notReignitable = belt.ignite() === false;
  fireworks.removeItem(belt);

  // ---- 6) demo path: created, planted and lit in the SAME frame — the
  // strand must rip at the planted spot, not at world origin ----
  const b2 = fireworks.createItem('belt');
  b2.root.position.set(-2, fireworks.groundHeight(-2, -3), -3);
  b2.state = 'planted';
  fireworks.activate(b2);
  await waitGame(2.0);
  const e2 = fireworks.emitters.find((e) => e.kind === 'belt' && e.item === b2);
  out.midRipEmitter = !!e2;
  out.ripsWherePlanted = b2.beltPts.every((pt) =>
    Math.hypot(pt.p.x - -2, pt.p.z - -3) < 1.5);
  fireworks.removeItem(b2);
  await waitGame(0.3);
  out.despawnCleanup = !fireworks.emitters.some((e) => e.kind === 'belt' && e.item === b2);

  // ---- 7) belts in the restock lottery ----
  const names = new Set();
  for (let i = 0; i < 500; i++) names.add(fireworks.randomTypeName());
  out.inLottery = names.has('belt');

  return out;
});

console.log(JSON.stringify(r, null, 1));
const realErrs = errs.filter((e) => !e.includes('404'));
console.log(realErrs.length ? 'ERRORS:\n' + realErrs.join('\n') : 'no page errors');
await browser.close();
process.exit(Object.values(r).every((v) => v === true) && !realErrs.length ? 0 : 1);
