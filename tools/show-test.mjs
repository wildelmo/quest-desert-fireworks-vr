// Feature exercise: TNT detonator plunge mechanics + finale show lifecycle
// + waterfall burst pattern.
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
  const { fireworks, world, interactions, THREE } = app;
  const det = world.detonator;
  const show = world.show;
  const out = {};
  const waitGame = (sec) => new Promise((res) => {
    const t0 = fireworks.time;
    const id = setInterval(() => {
      if (fireworks.time - t0 >= sec) { clearInterval(id); res(); }
    }, 50);
  });

  // ---- 1) the prop exists, armed, handle up, wire laid ----
  out.armed = det.armed === true && det.norm === 1;
  out.wireLaid = !!det.wireCurve && det.wireCurve.getPoint(1).distanceTo(show.pads[4]) < 2;

  // ---- 2) VR-style drag: handle follows the hand down its rails ----
  const bar = det.barWorldPos(new THREE.Vector3());
  det.beginGrab();
  det.dragTo(new THREE.Vector3(bar.x, bar.y - det.travel * 0.5, bar.z));
  out.dragsHalfway = det.norm > 0.2 && det.norm < 0.8;
  out.notFiredEarly = det.armed === true && !show.running;
  // shove it all the way home
  det.dragTo(new THREE.Vector3(bar.x, bar.y - det.travel * 1.5, bar.z));
  det.endGrab();
  out.firedAtBottom = det.armed === false;
  out.showRunning = show.running === true;
  out.sparkRunner = !!show.sparkRun;
  out.programDense = show.events.length > 90;
  out.programSorted = show.events.every((e, i) => i === 0 || show.events[i - 1].t <= e.t);
  out.lastEventBeforeEnd = show.events[show.events.length - 1].t < show.duration;

  // ---- 3) opening actually launches shells (events -> scheduled bursts) ----
  await waitGame(8);
  out.zapArrived = show.sparkRun === null;
  out.openingLaunched = fireworks.events.length > 0 || fireworks.ambientPulse.energy > 0;

  // ---- 4) plunging again mid-show does nothing ----
  det.autoPlunge();
  await waitGame(0.5);
  out.noDoubleFire = det.armed === false && det.anim !== 'down';

  // ---- 5) jump to the end: show wraps up, detonator re-arms ----
  show._ei = show.events.length;
  show.time = show.duration - 0.05;
  await waitGame(0.4);
  out.showEnded = show.running === false;
  out.rearming = det.anim === 'up' || det.norm > 0;
  await waitGame(1.2);
  out.rearmed = det.armed === true && det.norm === 1;

  // ---- 6) desktop auto-plunge path fires again ----
  det.autoPlunge();
  await waitGame(0.8);
  out.autoPlungeFires = det.armed === false && show.running === true;
  // clean up: kill the second run
  show._ei = show.events.length;
  show.time = show.duration;
  await waitGame(0.3);

  // ---- 7) waterfall pattern spawns a long-lived curtain ----
  const before = app.pool.cursor;
  fireworks.burst(new THREE.Vector3(0, 60, -70), {
    pattern: 'waterfall', size: 1.3,
    palette: { name: 'molten silver', a: 0xfff3d8, b: 0xffd489 }, sound: null,
  });
  const spawned = (app.pool.cursor - before + app.pool.capacity) % app.pool.capacity;
  out.waterfallDense = spawned > 1500; // stars * 6 trail beads + shimmer
  // long burn: sample the timing attribute of recent spawns for life > 4s
  let longLived = 0;
  for (let k = 0; k < spawned; k++) {
    const idx = (before + k) % app.pool.capacity;
    if (app.pool.aTiming.array[idx * 2 + 1] > 4) longLived++;
  }
  out.waterfallLongBurn = longLived > 400;

  // ---- 8) salute pattern exists ----
  fireworks.burst(new THREE.Vector3(0, 60, -70), { pattern: 'salute', size: 1, sound: null });
  out.saluteOk = true; // no throw

  return out;
});

console.log(JSON.stringify(r, null, 1));
const realErrs = errs.filter((e) => !e.includes('404'));
console.log(realErrs.length ? 'ERRORS:\n' + realErrs.join('\n') : 'no page errors');
await browser.close();
process.exit(Object.values(r).every((v) => v === true) && !realErrs.length ? 0 : 1);
