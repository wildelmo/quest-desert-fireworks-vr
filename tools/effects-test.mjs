// Effects exercise: every new-generation burst() pattern (thousandbloom,
// bees/fish, dragoneggs, spider, farfalle, tourbillon, pattern shells,
// flares, strobe willow, lampare), the spec.pistil option, mine(), the
// mortarShot tail/burst additions, and the pool's guarded stomp counter.
// Verifies the precompute contracts: pop synchrony, chained short segments,
// planar shape velocities, blink children, emitter-light lifecycle.
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
  const { fireworks, THREE } = app;
  const pool = app.pool;
  const out = {};
  const costs = {};
  const waitGame = (sec) => new Promise((res) => {
    const t0 = fireworks.time;
    const id = setInterval(() => {
      if (fireworks.time - t0 >= sec) { clearInterval(id); res(); }
    }, 40);
  });
  const P = { name: 'test gold', a: 0xffab42, b: 0xffe9b0 };
  const BURST_POS = [0, 60, -40]; // camp target (0,40,0) => plane normal ≈ (0,-0.447,0.894)

  // noFlash + sound:null strips the generic glow/smoke/report overhead, so
  // the cursor delta is the pattern's own particle cost at size 1.0
  const burstAt = (pattern, spec = {}) => {
    const before = pool.cursor;
    const t0 = fireworks.time;
    fireworks.burst(new THREE.Vector3(...BURST_POS),
      { pattern, size: 1.0, palette: P, sound: null, noFlash: true, ...spec });
    const spawned = (pool.cursor - before + pool.capacity) % pool.capacity;
    costs[pattern + (spec.pistil ? '+pistil' : '')] = spawned;
    return { before, spawned, t0 };
  };
  const scan = (h, fn) => {
    for (let k = 0; k < h.spawned; k++) fn((h.before + k) % pool.capacity);
  };

  // ---- 1) every new pattern spawns a sensible particle count ----
  const mins = {
    thousandbloom: 2000, bees: 700, fish: 800, dragoneggs: 1500, spider: 500,
    farfalle: 700, tourbillon: 900, heart: 200, smiley: 200, star5: 200,
    flare: 120, strobewillow: 3000, lampare: 300,
  };
  const handles = {};
  let allSpawn = true;
  for (const p of Object.keys(mins)) {
    handles[p] = burstAt(p);
    if (handles[p].spawned < mins[p]) { allSpawn = false; out['thin_' + p] = handles[p].spawned; }
  }
  out.allPatternsSpawn = allSpawn;

  // ---- 2) thousandbloom: ALL pops share one delay (±~50ms fuse jitter) ----
  {
    const h = handles.thousandbloom;
    let minB = 1e9, maxB = -1e9, kids = 0;
    scan(h, (idx) => {
      const rel = pool.aTiming.array[idx * 2] - h.t0;
      if (rel > 0.7) { kids++; if (rel < minB) minB = rel; if (rel > maxB) maxB = rel; }
    });
    out.bloomManyKids = kids > 1200;
    out.bloomSynchronous = kids > 0 && (maxB - minB) < 0.16 && minB > 1.0 && maxB < 1.8;
  }

  // ---- 3) bees/fish: many short-lived chained segments along the paths ----
  {
    const hb = handles.bees;
    let short = 0, minB = 1e9, maxB = -1e9;
    scan(hb, (idx) => {
      const life = pool.aTiming.array[idx * 2 + 1];
      const rel = pool.aTiming.array[idx * 2] - hb.t0;
      if (life > 0 && life < 0.75) short++;
      if (rel < minB) minB = rel;
      if (rel > maxB) maxB = rel;
    });
    out.beesShortSegments = short > 700;
    out.beesChainedOverTime = (maxB - minB) > 0.8; // legs strung along the flight
    const hf = handles.fish;
    let fshort = 0, spd = 0;
    scan(hf, (idx) => {
      const life = pool.aTiming.array[idx * 2 + 1];
      if (life > 0 && life < 1.0) fshort++;
      const v = pool.aVel.array;
      spd += Math.hypot(v[idx * 3], v[idx * 3 + 1], v[idx * 3 + 2]);
    });
    out.fishShortSegments = fshort > 800;
    out.fishSwimFast = spd / hf.spawned > 14; // 18-26 m/s streaks
  }

  // ---- 4) pattern shells: velocities planar, plane facing the campsite ----
  {
    const planar = (h) => {
      const vs = [];
      scan(h, (idx) => {
        const v = pool.aVel.array;
        vs.push([v[idx * 3], v[idx * 3 + 1], v[idx * 3 + 2]]);
      });
      // normal from aligned cross products of many velocity pairs
      let nx = 0, ny = 0, nz = 0;
      for (let k = 0; k + 7 < vs.length; k += 5) {
        const a = vs[k], b = vs[k + 4];
        let cx = a[1] * b[2] - a[2] * b[1];
        let cy = a[2] * b[0] - a[0] * b[2];
        let cz = a[0] * b[1] - a[1] * b[0];
        if (cx * nx + cy * ny + cz * nz < 0) { cx = -cx; cy = -cy; cz = -cz; }
        nx += cx; ny += cy; nz += cz;
      }
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;
      // energy off-plane vs total: near zero when the shape is truly flat
      let off = 0, tot = 0;
      for (const v of vs) {
        const d = v[0] * nx + v[1] * ny + v[2] * nz;
        off += d * d;
        tot += v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
      }
      return { offPlane: Math.sqrt(off / Math.max(tot, 1e-9)), nx, ny, nz };
    };
    // expected normal: burst pos -> (0, 40, 0)
    const ex = 0, ey = -0.4472, ez = 0.8944;
    for (const p of ['heart', 'smiley', 'star5']) {
      const q = planar(handles[p]);
      const facing = Math.abs(q.nx * ex + q.ny * ey + q.nz * ez);
      out[p + 'Planar'] = q.offPlane < 0.12;
      out[p + 'FacesCamp'] = facing > 0.85; // within the 15-25° tilt budget
    }
  }

  // ---- 5) strobewillow: long willow base + a curtain of STAR4 blinks ----
  {
    const h = handles.strobewillow;
    let blinks = 0, longBase = 0;
    scan(h, (idx) => {
      const life = pool.aTiming.array[idx * 2 + 1];
      const cell = pool.aShape.array[idx * 4];
      if (cell === 1 && life < 0.15) blinks++; // CELL.STAR4 flash children
      if (life > 4) longBase++;
    });
    out.strobewillowBlinks = blinks > 1500;
    out.strobewillowBase = longBase > 700;
  }

  // ---- 6) flare: emitter follows the path, pooled light released at end ----
  {
    const e = fireworks.emitters.find((em) => em.kind === 'flare');
    out.flareEmitter = !!e && e.duration >= 12 && e.duration <= 18 && e.path.length >= 6;
    if (e) {
      e.age = e.duration + 1; // jump to burnout
      await waitGame(0.3);
      out.flareReleased = !fireworks.emitters.includes(e)
        && fireworks.emitterLights.every((s) => s.owner !== e);
    }
  }

  // ---- 7) spec.pistil layers a nested core onto a supporting pattern ----
  {
    const plain = burstAt('ring');
    const cored = burstAt('ring', { pistil: { color: 0xff2430, ratio: 0.35 } });
    out.pistilAddsCore = cored.spawned - plain.spawned > 300;
  }

  // ---- 8) mine(): ground eruptions, all three payloads ----
  {
    const gy = fireworks.groundHeight(0, -46);
    let ok = true;
    for (const kind of ['color', 'crackle', 'serpents']) {
      const before = pool.cursor;
      const t0 = fireworks.time;
      fireworks.mine(new THREE.Vector3(0, gy, -46), { size: 1, palette: P, kind, sound: false });
      const spawned = (pool.cursor - before + pool.capacity) % pool.capacity;
      costs['mine:' + kind] = spawned;
      if (spawned < 250) ok = false;
      // the column has body: births staggered across the 0.2 s window
      let maxB = 0;
      for (let k = 0; k < spawned; k++) {
        const idx = (before + k) % pool.capacity;
        const rel = pool.aTiming.array[idx * 2] - t0;
        if (rel > maxB) maxB = rel;
      }
      if (kind === 'color' && !(maxB > 0.1 && maxB < 0.45)) ok = false;
    }
    out.minesErupt = ok;
  }

  // ---- 9) mortarShot: glitter tremalon tail + burst:false + onBurst hook ----
  {
    const gy = fireworks.groundHeight(6, -40);
    const pad = new THREE.Vector3(6, gy + 0.1, -40);
    const b1 = pool.cursor;
    fireworks.mortarShot(pad, { pattern: 'peony', size: 0.5, palette: P, speed: 30, flightT: 0.7, sound: null });
    const plainRise = (pool.cursor - b1 + pool.capacity) % pool.capacity;
    const b2 = pool.cursor;
    window.__mortarHook = false;
    fireworks.mortarShot(pad, {
      size: 0.5, palette: P, speed: 30, flightT: 0.7, sound: null,
      tail: 'glitter', burst: false, onBurst: () => { window.__mortarHook = true; },
    });
    const glitterRise = (pool.cursor - b2 + pool.capacity) % pool.capacity;
    costs['mortar rise'] = plainRise;
    costs['mortar rise+glitter'] = glitterRise;
    out.glitterTailDenser = glitterRise - plainRise > 80;
    await waitGame(1.1); // let both shells reach their burst moment
    out.mortarBurstFalse = window.__mortarHook === true;
  }

  // ---- 10) pool.trackStomp: guarded counter, off by default ----
  {
    out.stompDefaultOff = pool.trackStomp === false && pool.stompedAlive === 0;
    pool.trackStomp = true;
    const c0 = pool.cursor;
    pool.spawn(20, (i) => pool.set(i, 0, -500, 0, 0, 0, 0, 1, 1, 1,
      fireworks.time, 60, 0.01, 0, 1, 0));
    const counted0 = pool.stompedAlive;
    pool.cursor = c0; // wind back and stomp the 20 long-lived live particles
    pool.spawn(20, (i) => pool.set(i, 0, -500, 0, 0, 0, 0, 1, 1, 1,
      fireworks.time, 0.01, 0.01, 0, 1, 0));
    out.stompCounted = pool.stompedAlive - counted0 >= 20;
    pool.trackStomp = false;
    pool.stompedAlive = 0;
  }

  out.costs = costs;
  return out;
});

const { costs, ...checks } = r;
console.log('per-pattern particle cost @ size 1.0 (pattern-only, noFlash):');
console.log(JSON.stringify(costs, null, 1));
console.log(JSON.stringify(checks, null, 1));
const realErrs = errs.filter((e) => !e.includes('404'));
console.log(realErrs.length ? 'ERRORS:\n' + realErrs.join('\n') : 'no page errors');
await browser.close();
process.exit(Object.values(checks).every((v) => v === true) && !realErrs.length ? 0 : 1);
