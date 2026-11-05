// Rendering work and particle-lifetime invariants. Desktop timings aren't
// Quest timings; assert removed work rather than promising a headset FPS.
import assert from 'node:assert/strict';
import { launchTestBrowser } from './test-browser.mjs';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const base = process.env.TEST_URL || 'http://127.0.0.1:8082';
const server = process.env.TEST_URL ? null : spawn(process.execPath, ['tools/serve.mjs'], {
  env: { ...process.env, PORT: '8082' }, stdio: 'pipe', windowsHide: true,
});
let browser;
try {
  for (let i = 0; ; i++) {
    try { if ((await fetch(base)).ok) break; } catch {}
    if (i === 100) throw new Error('Performance test server did not start');
    await delay(100);
  }
  browser = await launchTestBrowser();
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base + '/?autostart=desktop');
  await page.waitForFunction(() => window.__app?.audio.ready, null, { timeout: 60000 });
  const result = await page.evaluate(async () => {
    const { renderer, pool, world, audio, THREE } = window.__app;
    renderer.setAnimationLoop(null);
    clearInterval(audio._gustTimer);
    const { ParticlePool } = await import('./src/particles.js');
    const checks = {};
    renderer.xr.dispatchEvent({ type: 'sessionstart' });
    checks.vrShadowsOff = renderer.shadowMap.enabled === false;
    renderer.xr.dispatchEvent({ type: 'sessionend' });
    renderer.setAnimationLoop(null);
    checks.desktopShadowsRestored = renderer.shadowMap.enabled === true;
    checks.xrResolutionHeadroom = window.__app.getPerformance().xrScale === 0.9;
    const p = new ParticlePool(512);
    const write = (i, birth, life) => p.set(i, 0, 5, -5, 0, 0, 0, 1, 1, 1, birth, life, 0.1, 1, 0.1, 0);
    p.update(0);
    checks.emptySkipsAllSlots = p.points.geometry.drawRange.count === 0;
    p.spawn(256, (i) => write(i, 0, 100));
    p.spawn(256, (i) => write(i, 0, 1));
    p.spawn(1, (i) => write(i, 0, 1));
    p.update(2);
    checks.partialOverwriteKeepsNeighbors = p.points.geometry.drawRange.count === 256;
    p.spawn(255, (i) => write(i, 0, 1));
    p.update(2);
    checks.fullOverwriteDropsOldExpiry = p.points.geometry.drawRange.count === 0;
    p.spawn(1, (i) => write(i, 10, 2));
    p.update(3);
    checks.futureChildrenKept = p.points.geometry.drawRange.count > 0;
    p.update(11);
    checks.futureChildStillPresent = p.points.geometry.drawRange.count > 0;
    p.update(12);
    checks.expiryDrains = p.points.geometry.drawRange.count === 0;
    checks.dynamicBuffers = Object.values(p.points.geometry.attributes).every((a) => a.usage === THREE.DynamicDrawUsage);

    // Compare the conservative submitted range to the actual lifetimes,
    // including wrapping, partial writes and children born in the future.
    const q = new ParticlePool(777);
    let seed = 7;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    let safe = true;
    for (let frame = 0; frame < 600; frame++) {
      const t = frame / 30;
      q.spawn(Math.floor(random() * 80), (i) => q.set(i, 0, 5, -5, 0, 0, 0, 1, 1, 1,
        t + random() * 3, 0.1 + random() * 4, 0.1, 1, 0.1, 0));
      q.update(t);
      const { start, count } = q.points.geometry.drawRange;
      if (start < 0 || start + count > q.capacity) safe = false;
      for (let i = 0; i < q.capacity; i++) {
        const timings = q.aTiming.array;
        if (timings[i * 2] + timings[i * 2 + 1] > t && (i < start || i >= start + count)) safe = false;
      }
    }
    checks.randomizedLifetimesNeverCulled = safe;

    const col = world.colossus;
    col.forcePhase('glory'); col.forceOverdrive(1);
    const measure = (pos, time) => {
      audio.listenerPos.copy(pos);
      const before = pool.cursor;
      for (let i = 0; i < 216; i++) col.update(1 / 72, time + i / 72);
      return (pool.cursor - before + pool.capacity) % pool.capacity;
    };
    const far = measure(new THREE.Vector3(0, 1.6, 0), 10);
    const near = measure(col.group.position.clone().add(new THREE.Vector3(0, 60, 10)), 13);
    checks.distantWheelUsesFewerParticles = far < near * 0.6;
    checks.wheelStillTurns = col.state.angle > 0 && col.state.omega > 0;
    const size = new THREE.Box3().setFromObject(col.wheel).getSize(new THREE.Vector3());
    checks.wheelKept = Math.max(size.x, size.y) > 95;
    return { checks, farParticles: far, nearParticles: near,
      startupSubmittedSlots: pool.points.geometry.drawRange.count, poolCapacity: pool.capacity };
  });
  console.log(JSON.stringify(result, null, 2));
  for (const [name, passed] of Object.entries(result.checks)) assert.equal(passed, true, name);
  assert.ok(result.startupSubmittedSlots < result.poolCapacity / 4, 'idle draw must skip most of the unused pool');
  assert.deepEqual(errors, []);
  const override = await browser.newPage();
  await override.goto(base + '/?xrScale=1&shadows=1');
  await override.waitForFunction(() => window.__app);
  const settings = await override.evaluate(() => {
    window.__app.renderer.xr.dispatchEvent({ type: 'sessionstart' });
    return window.__app.getPerformance();
  });
  assert.equal(settings.xrScale, 1);
  assert.equal(settings.shadows, true);
  console.log('PASS: less rendering work, wheel preserved, and no live/future particles trimmed.');
} finally {
  await browser?.close();
  server?.kill();
}
