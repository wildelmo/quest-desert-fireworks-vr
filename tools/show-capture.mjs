// Capture the finale show: plunge the detonator, aim the camera at the
// mortar battery, and screenshot at the requested show times.
//   node show-capture.mjs outDir t1,t2,t3,...
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const outDir = process.argv[2] ?? 'show-shots';
const times = (process.argv[3] ?? '4,9,15,20,26,31,36,42,48,56,61,68,74,80,86,93,100,107,112,117,121,126,131,136,139,142,145,148,151,155')
  .split(',').map(Number).sort((a, b) => a - b);
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto('http://localhost:8080/?autostart=desktop', { waitUntil: 'load' });
await page.waitForTimeout(2500);
page.setDefaultTimeout(600000);

// aim at the battery (pads z≈-48..-82; the show now stacks three altitude
// bands, mines at the sand up to ~150 m crowns, so frame the full column)
// and start the show
await page.evaluate(() => {
  const app = window.__app;
  // frame the whole display column: back off to the camp's south edge, open
  // the FOV wide (a VR viewer just looks up — a fixed 2D frame can't), and
  // aim above the battery so the high band (breaks to ~150 m at ~75 m out,
  // >60° elevation) isn't cropped by the frame top
  app.camera.parent.position.set(0, 0, 14);
  app.camera.fov = 92;
  app.camera.updateProjectionMatrix();
  app.camera.lookAt(6, 66, -74);
  app.world.detonator.autoPlunge();
});

const stats = [];
for (const t of times) {
  await page.waitForFunction(
    (tt) => window.__app.world.show.time >= tt || !window.__app.world.show.running && window.__app.world.show.time > 1,
    t, { polling: 100 },
  );
  const file = `${outDir}/t${String(t).padStart(3, '0')}.png`;
  await page.screenshot({ path: file });
  const s = await page.evaluate(() => {
    const app = window.__app;
    return {
      showT: Math.round(app.world.show.time * 10) / 10,
      running: app.world.show.running,
      pulse: Math.round(app.fireworks.ambientPulse.energy * 100) / 100,
      pendingEvents: app.world.show.events.length - app.world.show._ei,
    };
  });
  stats.push({ file, ...s });
  console.log('saved', file, JSON.stringify(s));
}
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
