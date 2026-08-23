// Integration checks for the AAA polish wave: cross-system contracts
// (throw physics, ground marks, foley bank, wind), light-count stability
// (a changing PointLight count would force a mid-show shader recompile on
// Quest), and idle draw-call budget. Requires `npm start` on :8080.
import { chromium } from 'playwright-core';

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto('http://localhost:8080/?autostart=desktop', { waitUntil: 'load' });
const t0 = Date.now();
try {
  // NB: waitForFunction(fn, ARG, options) — options is the third parameter
  await page.waitForFunction(() => window.__app?.audio?.ready, undefined, { timeout: 120000, polling: 500 });
} catch (e) {
  const probe = await page.evaluate(() => ({
    app: !!window.__app,
    audio: !!window.__app?.audio,
    ctx: !!window.__app?.audio?.ctx,
    ready: window.__app?.audio?.ready,
    overlayHidden: document.getElementById('overlay')?.classList.contains('hidden'),
  })).catch((err) => String(err));
  console.error(`audio never became ready after ${Date.now() - t0} ms; probe:`, JSON.stringify(probe));
  console.error('page errors so far:', errors.length ? errors.join('\n') : 'none');
  await browser.close();
  process.exit(1);
}
await page.waitForTimeout(1000);

const results = await page.evaluate(async () => {
  const app = window.__app;
  const out = {};

  // --- contract: foley bank registered
  const lib = app.audio.lib || {};
  for (const name of ['rustle', 'crunch', 'knock', 'swing', 'whistle', 'creak']) {
    out['sample_' + name] = Array.isArray(lib[name]) && lib[name].length > 0;
  }
  // unknown names must no-op, not throw
  try { app.audio.play('definitely-not-a-sample', new app.THREE.Vector3()); out.unknownSampleSafe = true; }
  catch { out.unknownSampleSafe = false; }

  // --- contract: ground scorch API installed by world on the fireworks system
  out.groundMarkInstalled = typeof app.fireworks.groundMark === 'function';
  if (out.groundMarkInstalled) {
    try { app.fireworks.groundMark(2, 2, 0.5, 0.8); out.groundMarkCallable = true; }
    catch { out.groundMarkCallable = false; }
  }

  // --- contract: WIND is live and sane
  out.windSane = app.WIND && app.WIND.length() > 0.05 && app.WIND.length() < 6 && Math.abs(app.WIND.y) < 0.01;

  // --- contract: thrown items fly ballistically (vel consumed by integrator).
  // Gate on SIM state, not wall time — under SwiftShader the page may render
  // at a couple of fps, so wall-clock waits see almost no integration.
  const item = app.fireworks.createItem('rocketSmall');
  item.root.position.set(0, 3, -6);
  item.state = 'lying';       // what release() leaves an unlit item in
  item.fallVel = -0.01;       // legacy "integrator owns this" sentinel
  item.vel = new app.THREE.Vector3(4, 2, 0);
  item.angVel = new app.THREE.Vector3(0, 0, 6);
  const x0 = item.root.position.x, z0 = item.root.position.z;
  await new Promise((res) => {
    let n = 0;
    const iv = setInterval(() => {
      if (!item.vel || ++n > 600) { clearInterval(iv); res(); }
    }, 100);
  });
  out.throwDx = Math.hypot(item.root.position.x - x0, item.root.position.z - z0);
  out.throwMovedHorizontally = out.throwDx > 1.5; // a 4 m/s lob lands ~2.5-3.5 m out
  out.throwCameToRest = !item.vel && item.root.position.y < 1.5;

  // --- light-count stability + budget snapshot (t=now)
  const countLights = () => {
    let n = 0;
    app.scene.traverse((o) => { if (o.isPointLight) n++; });
    return n;
  };
  out.lightsBefore = countLights();
  window.__countLights = countLights;
  out.callsIdle = app.renderer.info.render.calls;
  out.trisIdle = app.renderer.info.render.triangles;
  return out;
});

// let the demo-less desert idle, then splash a few bursts via quick launch
await page.evaluate(() => {
  for (let i = 0; i < 6; i++) {
    setTimeout(() => window.__app.interactions.desktop?.quickRocket?.(), i * 800);
  }
});
await page.waitForTimeout(9000);
const after = await page.evaluate(() => ({
  lightsAfter: window.__countLights(),
  calls: window.__app.renderer.info.render.calls,
}));

results.lightsAfter = after.lightsAfter;
results.lightCountStable = results.lightsBefore === after.lightsAfter;
results.callsDuringBursts = after.calls;
results.callsBudgetOk = results.callsIdle < 175;

console.log(JSON.stringify(results, null, 1));
console.log(errors.length ? `PAGE ERRORS:\n${errors.join('\n')}` : 'no page errors');
await browser.close();

const failed = Object.entries(results).filter(([k, v]) => v === false).map(([k]) => k);
if (failed.length || errors.length) {
  console.error('FAILED:', failed.join(', ') || '(page errors only)');
  process.exit(1);
}
console.log('polish-test OK');
