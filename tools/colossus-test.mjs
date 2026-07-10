// Colossus exercise: the monumental fire-wheel wakes, spins SLOWLY (the
// whole point), sprays from its pods, salutes, and freewheels when the
// drivers die.
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
  const { fireworks, world } = app;
  const col = world.colossus;
  const out = {};
  const waitGame = (sec) => new Promise((res) => {
    const t0 = fireworks.time;
    const id = setInterval(() => {
      if (fireworks.time - t0 >= sec) { clearInterval(id); res(); }
    }, 50);
  });

  // ---- 1) it exists, and it is genuinely monumental ----
  out.built = !!col && !!col.group && !!col.wheel;
  const box = new app.THREE.Box3().setFromObject(col.wheel);
  const size = box.getSize(new app.THREE.Vector3());
  out.wheelIsHuge = Math.max(size.x, size.y) > 95; // ~104 m of wheel
  const dist = col.group.position.length();
  out.farFromCamp = dist > 230 && dist < 340;

  // ---- 2) glory: all pods burn, and it spins SLOWLY with real inertia ----
  col.forcePhase('glory');
  const a0 = col.state.angle;
  await waitGame(6);
  const s1 = col.state;
  out.spinningUp = s1.omega > 0.02;
  out.slowLikeAMonument = s1.omega < 0.45; // the hand pinwheel hits 36 rad/s
  out.wheelTurned = s1.angle > a0 + 0.05 && s1.angle < a0 + 3.0;
  out.podsBurning = col.pods.filter((p) => p.burn > 0.5).length >= 6;

  // ---- 3) a salute fires from a pod on the wheel ----
  const sp = col.forceSalute();
  out.saluteFired = !!sp && sp.y > col.group.position.y + 10;

  // ---- 4) drivers die -> it freewheels (keeps turning; only the residual
  // burn/throttle tails add a whisker of drive while they die off) ----
  col.forcePhase('dark');
  await waitGame(8);
  const s2 = col.state;
  out.driversOut = col.pods.every((p) => p.target === 0);
  out.freewheeling = s2.omega > 0.01 && s2.omega <= s1.omega + 0.15;

  // ---- 4b) overdrive: at full throttle it winds up to a genuine rip and
  // the rim smears into a hoop of light ----
  col.forcePhase('glory');
  col.forceOverdrive(1);
  await waitGame(14);
  const s3 = col.state;
  out.overdriveRips = s3.omega > 0.8 && s3.omega < 2.2;
  out.ringOfLight = col.speedRing.material.opacity > 0.05;

  // ---- 5) it never touches the gameplay items/lottery ----
  out.notAnItem = ![...fireworks.items].some((i) => i.type?.label?.includes('Colossus'));
  const names = new Set();
  for (let i = 0; i < 300; i++) names.add(fireworks.randomTypeName());
  out.lotteryUnchanged = !names.has('colossus') && names.has('pinwheel');

  return out;
});

console.log(JSON.stringify(r, null, 1));
const realErrs = errs.filter((e) => !e.includes('404'));
console.log(realErrs.length ? 'ERRORS:\n' + realErrs.join('\n') : 'no page errors');
await browser.close();
process.exit(Object.values(r).every((v) => v === true) && !realErrs.length ? 0 : 1);
