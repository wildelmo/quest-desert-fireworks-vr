// Feature exercise: drone console press mechanics + swarm show lifecycle —
// liftoff, formation morphs, skipping, landing, console re-arm.
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
  const { fireworks, world, THREE } = app;
  const con = world.droneConsole;
  const show = world.droneShow;
  const N = show.N;
  const out = {};
  const waitGame = (sec) => new Promise((res) => {
    const t0 = fireworks.time;
    const id = setInterval(() => {
      if (fireworks.time - t0 >= sec) { clearInterval(id); res(); }
    }, 50);
  });
  const finite = (arr) => {
    for (let k = 0; k < arr.length; k++) if (!Number.isFinite(arr[k])) return false;
    return true;
  };
  const meanY = () => {
    let s = 0;
    for (let i = 0; i < N; i++) s += show.pos[i * 3 + 1];
    return s / N;
  };

  // ---- 1) the prop exists, armed; the swarm is parked on the pad ----
  out.armed = con.armed === true && show.state === 'idle';
  out.fleetSize = N === 840;
  out.parkedOnSand = Math.abs(show.pos[1] - (fireworks.groundHeight(show.pos[0], show.pos[2]) + 0.15)) < 0.3;
  out.pointsInScene = !!show.points.parent;

  // ---- 2) press: show starts, console disarms, LIFT-OFF is scene 0 ----
  const padY = meanY();
  con.autoPress();
  out.launched = show.state === 'flying' && show.sceneIndex === 0;
  out.disarmed = con.armed === false;
  out.statusShown = con._status === 'LIFT-OFF';

  // ---- 3) the swarm actually climbs off the pad ----
  await waitGame(9);
  out.climbing = meanY() > padY + 3;
  out.posFinite = finite(show.pos);

  // ---- 4) pressing again skips to the next formation ----
  await waitGame(1.5); // clear the console's debounce
  con.autoPress();
  await waitGame(0.3);
  out.skipAdvances = show.sceneIndex === 1 && con._status === show.scenes[1].label;

  // ---- 5) walk the whole program: every formation distinct and finite ----
  const sums = new Set();
  let allFinite = true;
  const v = new THREE.Vector3();
  let walked = 0;
  while (true) {
    const s = show.scenes[show.sceneIndex];
    allFinite = allFinite && finite(s.data.pts);
    // index-weighted checksum: same-center symmetric shapes can't collide
    let sum = 0;
    for (let j = 0; j < N; j += 7) {
      show._slotWorld(s.data, j, 1, 0, 1, v);
      sum += (v.x * 1.3 + v.y * 2.7 + v.z * 3.1) * ((j % 13) + 1);
    }
    sums.add(Math.round(sum));
    walked++;
    if (s.land) break;
    show.sceneT = s.dur;  // jump to the scene's end
    await waitGame(0.25); // let the switch land
  }
  out.formationsFinite = allFinite;
  out.formationsDistinct = sums.size === walked && walked === show.scenes.length - 1;
  out.onLandingLeg = show.scenes[show.sceneIndex].land === true;
  out.skipRefusedWhileLanding = show.skip() === false;

  // ---- 6) touch down: teleport each drone onto ITS pad slot, let it settle ----
  for (let i = 0; i < N; i++) {
    show.delay[i] = 0;
    const sl = show.slot[i] = show.pend[i];
    show.pos[i * 3] = show.pad.pts[sl * 3];
    show.pos[i * 3 + 1] = show.pad.pts[sl * 3 + 1];
    show.pos[i * 3 + 2] = show.pad.pts[sl * 3 + 2];
    show.vel[i * 3] = show.vel[i * 3 + 1] = show.vel[i * 3 + 2] = 0;
  }
  await waitGame(5);
  out.showEnded = show.state === 'idle';
  out.rearmed = con.armed === true && con._status === 'READY';

  // ---- 7) standby: parked LEDs are a faint ember, not full show color ----
  await waitGame(1);
  let maxC = 0;
  const cols = show.points.geometry.getAttribute('aColor').array;
  for (let k = 0; k < cols.length; k++) maxC = Math.max(maxC, cols[k]);
  out.standbyDim = maxC > 0.001 && maxC < 0.25;

  // ---- 8) it re-launches ----
  con.autoPress();
  out.relaunches = show.state === 'flying' && show.sceneIndex === 0;
  // clean up: park it again for whoever runs next
  for (let i = 0; i < N; i++) {
    show.delay[i] = 0;
    show.slot[i] = show.pend[i] = i;
  }
  show.sceneIndex = show.scenes.length - 1;
  show.sceneT = show.scenes[show.scenes.length - 1].dur;
  await waitGame(0.3);
  out.cleanShutdown = show.state === 'idle';

  return out;
});

console.log(JSON.stringify(r, null, 1));
const realErrs = errs.filter((e) => !e.includes('404'));
console.log(realErrs.length ? 'ERRORS:\n' + realErrs.join('\n') : 'no page errors');
await browser.close();
process.exit(Object.values(r).every((v) => v === true) && !realErrs.length ? 0 : 1);
