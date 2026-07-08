// One-off regression exercise for the review fixes.
import { chromium } from 'playwright-core';

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1024, height: 640 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await page.goto('http://localhost:8080/?autostart=desktop', { waitUntil: 'load' });
await page.waitForTimeout(2500);

const r = await page.evaluate(async () => {
  const app = window.__app;
  const { fireworks, interactions, world, THREE } = app;
  const d = interactions.desktop;
  const out = {};

  // 1) grab an active fountain: state must stay 'active', then release keeps it active
  const f = fireworks.createItem('fountain');
  f.root.position.set(2, 0, -3);
  f.state = 'planted';
  fireworks.activate(f);                 // skip fuse, straight to erupting
  interactions.grab(f, d.handAnchor, d);
  out.grabKeepsActive = f.state === 'active';
  d.held = f;
  interactions.release(f);
  d.held = null;
  out.releaseKeepsActive = f.state === 'active';

  // 2) spent item release must not resurrect
  const c = fireworks.createItem('candle');
  c.state = 'active';
  fireworks._spend(c);
  interactions.grab(c, d.handAnchor, d);
  d.held = c;
  interactions.release(c);
  d.held = null;
  out.spentStaysSpent = c.state === 'spent';
  out.spentNotIgnitable = c.ignite() === false;

  // 3) removeItem clears the holder
  const rkt = fireworks.createItem('rocketSmall');
  interactions.grab(rkt, d.handAnchor, d);
  d.held = rkt;
  fireworks.removeItem(rkt);
  out.holderCleared = d.held === null && rkt.holder === null;

  // 4) held items are steal-able (present in grabbables)
  const rkt2 = fireworks.createItem('rocketSmall');
  interactions.grab(rkt2, d.handAnchor, d);
  d.held = rkt2;
  out.heldInGrabbables = interactions.grabbables().includes(rkt2);
  fireworks.removeItem(rkt2);

  // 5) shared label materials across same-palette items (texture leak fix)
  const a1 = fireworks.createItem('rocketMed');
  const a2 = fireworks.createItem('rocketMed');
  a2.palette = a1.palette;
  const mats = new Set();
  const collect = (it) => it.root.traverse((o) => { if (o.isMesh && o.material.map) mats.add(o.material); });
  collect(a1); a2._buildMesh === undefined; collect(a2);
  out.paletteMatCount = mats.size; // should be small (1 if same palette)
  fireworks.removeItem(a1); fireworks.removeItem(a2);

  // 6) particle pool wrap produces two runs, not a full-buffer range
  const pool = app.pool;
  pool.cursor = pool.capacity - 5;
  pool.dirtyRuns.length = 0;
  pool.spawn(10, () => {});
  out.wrapRuns = pool.dirtyRuns.map((r2) => r2.slice());
  return out;
});

console.log(JSON.stringify(r, null, 1));
console.log(errs.length ? 'ERRORS:\n' + errs.filter((e) => !e.includes('404')).join('\n') : 'no page errors');
await browser.close();
