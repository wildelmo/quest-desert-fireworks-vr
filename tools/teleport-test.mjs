// Teleport wayposts: the ring at the trailhead carries you out to the
// Colossus's feet facing the wheel, the ring out there brings you home,
// and neither can be double-grabbed mid-flash.
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
  const { world, player, camera, fireworks } = app;
  const out = {};
  const waitGame = (sec) => new Promise((res) => {
    const t0 = fireworks.time;
    const id = setInterval(() => {
      if (fireworks.time - t0 >= sec) { clearInterval(id); res(); }
    }, 50);
  });
  const head = () => camera.getWorldPosition(new app.THREE.Vector3());

  // ---- 1) two stations exist: trailhead outbound, colossus return ----
  const tps = world.teleporters ?? [];
  out.twoStations = tps.length === 2;
  const [toCol, toCamp] = tps;
  const hub = world.colossus.group.position;
  out.trailheadNearCamp = toCol.root.position.length() < 25;

  // ---- 2) ride out: land close under the wheel, facing it ----
  out.rideOut = toCol.use(player, camera) === true;
  const h1 = head();
  const d1 = Math.hypot(h1.x - hub.x, h1.z - hub.z);
  out.landedClose = d1 > 20 && d1 < 45;
  const fwd = new app.THREE.Vector3(0, 0, -1)
    .applyQuaternion(camera.getWorldQuaternion(new app.THREE.Quaternion()));
  fwd.y = 0; fwd.normalize();
  const toHub = new app.THREE.Vector3(hub.x - h1.x, 0, hub.z - h1.z).normalize();
  out.facingTheWheel = fwd.dot(toHub) > 0.9;

  // ---- 3) the return ring stands within a few steps of where you land ----
  out.returnAtHand = toCamp.ringWorldPos(new app.THREE.Vector3()).distanceTo(h1) < 6;

  // ---- 4) cooldown: the same ring refuses a double-grab mid-flash ----
  out.cooldownHolds = toCol.use(player, camera) === false;

  // ---- 5) ride home: back at the campsite ----
  await waitGame(2.5);
  out.rideHome = toCamp.use(player, camera) === true;
  const h2 = head();
  out.backAtCamp = Math.hypot(h2.x, h2.z) < 8;

  return out;
});

console.log(JSON.stringify(r, null, 1));
const realErrs = errs.filter((e) => !e.includes('404'));
console.log(realErrs.length ? 'ERRORS:\n' + realErrs.join('\n') : 'no page errors');
await browser.close();
process.exit(Object.values(r).every((v) => v === true) && !realErrs.length ? 0 : 1);
