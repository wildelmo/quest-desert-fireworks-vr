// Probe: run the whole show under the fast-forward loop and dump the
// per-second spawn histogram + live-count estimate to find hot seconds.
import { chromium } from 'playwright-core';

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 480, height: 320 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto('http://localhost:8080/?autostart=desktop', { waitUntil: 'load' });
await page.waitForTimeout(2500);
page.setDefaultTimeout(480000);

const r = await page.evaluate(async () => {
  const app = window.__app;
  const { fireworks, world } = app;
  const pool = app.pool;
  const show = world.show;
  pool.trackStomp = true;
  const samples = [];
  world.detonator.autoPlunge();
  await new Promise((res) => {
    const id = setInterval(() => { if (show.running) { clearInterval(id); res(); } }, 50);
  });
  let ffTime = fireworks.time;
  const stompBySec = new Map();
  let prevStomp = 0;
  app.renderer.setAnimationLoop(() => {
    for (let s = 0; s < 6; s++) {
      const dt = 0.04;
      ffTime += dt;
      world.update(dt, ffTime);
      fireworks.update(dt, ffTime);
      pool.update(ffTime, app.renderer.domElement.width, app.renderer.domElement.height);
    }
    samples.push([fireworks.time, pool.cursor]);
    const sec = Math.floor(fireworks.time);
    stompBySec.set(sec, (stompBySec.get(sec) ?? 0) + (pool.stompedAlive - prevStomp));
    prevStomp = pool.stompedAlive;
    app.renderer.render(app.scene, app.camera);
  });
  await new Promise((res) => {
    const id = setInterval(() => { if (!show.running) { clearInterval(id); res(); } }, 200);
    setTimeout(() => { clearInterval(id); res(); }, 360000);
  });
  const cap = pool.capacity;
  const perSec = new Map();
  let total = 0;
  for (let i = 1; i < samples.length; i++) {
    const d = (samples[i][1] - samples[i - 1][1] + cap) % cap;
    total += d;
    const s = Math.floor(samples[i - 1][0]);
    perSec.set(s, (perSec.get(s) ?? 0) + d);
  }
  const rows = [...perSec.entries()].sort((a, b) => a[0] - b[0])
    .map(([s, n]) => [s, n, stompBySec.get(s) ?? 0]);
  return { total, stomped: pool.stompedAlive, rows };
});

console.log('total spawned', r.total, 'stomped', r.stomped);
for (const [s, n, st] of r.rows) {
  const bar = '#'.repeat(Math.round(n / 1000));
  console.log(String(s).padStart(4), String(n).padStart(6), String(st).padStart(6), bar);
}
console.log(errs.length ? 'ERRORS:\n' + errs.join('\n') : 'no page errors');
await browser.close();
