// Live-engine voice-cap exercise: floods the REAL AudioEngine (real-time
// AudioContext, real app boot) with a finale-scale burst of booms and
// asserts the hard cap holds, eviction admits louder newcomers, the
// non-finite guard refuses poison, and voices drain cleanly afterwards.
// The offline show render (show-audio-test.mjs) can only SIMULATE the cap
// policy — this is the check that the shipping code path enforces it.
//
//   node tools/serve.mjs &          # server must be running
//   node tools/audio-cap-test.mjs
import { chromium } from 'playwright-core';

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox',
    '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await page.goto('http://localhost:8080/?autostart=desktop', { waitUntil: 'load' });
await page.waitForFunction(() => window.__app?.audio?.ready, null, { timeout: 60000 });

const r = await page.evaluate(async () => {
  const { audio, THREE } = window.__app;
  const out = { states: [], evictWorks: false, capHeld: true, ctxState: audio.ctx.state };
  const pos = new THREE.Vector3(30, 60, -80);
  // flood: 60 big booms over ~1.2 s of real time
  for (let i = 0; i < 60; i++) {
    pos.set(-40 + Math.random() * 80, 40 + Math.random() * 80, -60 - Math.random() * 40);
    audio.boom(pos, 0.5 + Math.random() * 0.5, { crackle: i % 4 === 0 });
    if (audio._voices.size > 32) out.capHeld = false;
    if (i % 10 === 9) out.states.push(audio._voices.size);
    await new Promise((res) => setTimeout(res, 20));
  }
  out.peak = Math.max(...out.states);
  // a near, loud play should evict rather than be refused at a full house
  const before = audio._voices.size;
  const h = audio.play('thud', new THREE.Vector3(0, 1.6, -1), { gain: 1.2, refDistance: 1.5 });
  out.evictWorks = h !== null && audio._voices.size <= 32;
  out.sizeAfter = audio._voices.size;
  out.before = before;
  // NaN guard
  out.nanRefused = audio.play('thud', new THREE.Vector3(NaN, 0, 0), { gain: 1 }) === null
    && audio.play('thud', new THREE.Vector3(0, 1, 0), { gain: NaN }) === null;
  // voices drain naturally
  await new Promise((res) => setTimeout(res, 6000));
  out.drained = audio._voices.size;
  return out;
});
console.log(JSON.stringify(r, null, 1));
console.log(errs.length ? 'ERRORS:\n' + errs.join('\n') : 'no page errors');
await browser.close();
process.exit(r.capHeld && r.evictWorks && r.nanRefused && r.drained < 32 && !errs.length ? 0 : 1);
