// Feature exercise: TNT detonator plunge mechanics + finale show lifecycle
// + waterfall burst pattern + the re-choreographed program's budgets:
//   - launch-rate profile per scene (volley grammar, wall peak, silence beat)
//   - sound budget (one-shot plays per second, build-time demotion ran)
//   - particle budget (real full-show run under a fast-forward loop,
//     sampling pool cursor deltas per game-second; stomp tracking if the
//     pool supports it)
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
page.setDefaultTimeout(480000);

const r = await page.evaluate(async () => {
  const app = window.__app;
  const { fireworks, world, THREE } = app;
  const pool = app.pool;
  const det = world.detonator;
  const show = world.show;
  const out = {};
  const prof = {}; // numeric profile, reported alongside the booleans
  const waitGame = (sec) => new Promise((res) => {
    const t0 = fireworks.time;
    const id = setInterval(() => {
      if (fireworks.time - t0 >= sec) { clearInterval(id); res(); }
    }, 50);
  });

  // ---- 1) the prop exists, armed, handle up, wire laid ----
  out.armed = det.armed === true && det.norm === 1;
  out.wireLaid = !!det.wireCurve && det.wireCurve.getPoint(1).distanceTo(show.pads[4]) < 2;

  // ---- 2) VR-style drag: handle follows the hand down its rails ----
  const bar = det.barWorldPos(new THREE.Vector3());
  det.beginGrab();
  det.dragTo(new THREE.Vector3(bar.x, bar.y - det.travel * 0.5, bar.z));
  out.dragsHalfway = det.norm > 0.2 && det.norm < 0.8;
  out.notFiredEarly = det.armed === true && !show.running;
  // shove it all the way home — and start the particle-budget sampler
  // right away so the opening salvo (a top-3 spawn second) is covered
  if ('trackStomp' in pool) { pool.trackStomp = true; pool.stompedAlive = 0; }
  const samples = [];
  let rtSampler = setInterval(() => samples.push([fireworks.time, pool.cursor]), 100);
  det.dragTo(new THREE.Vector3(bar.x, bar.y - det.travel * 1.5, bar.z));
  det.endGrab();
  out.firedAtBottom = det.armed === false;
  out.showRunning = show.running === true;
  out.sparkRunner = !!show.sparkRun;
  out.programDense = show.events.length > 90;
  out.programSorted = show.events.every((e, i) => i === 0 || show.events[i - 1].t <= e.t);
  out.lastEventBeforeEnd = show.events[show.events.length - 1].t < show.duration;

  // ---- 3) static profile of the built program (cues carry the metadata) ----
  const T0 = 2.7; // program clock offset: the zap's travel time to the battery
  const cues = show.cues;
  const rel = (c) => c.t - T0;
  const inWin = (a, b) => cues.filter((c) => rel(c) >= a && rel(c) < b);
  prof.launchTotal = cues.length;
  out.volleyProgram = cues.length >= 550 && cues.length <= 1100;

  // launch-rate profile: brief targets per scene
  prof.opening = inWin(0, 15).length;
  out.openingStatement = prof.opening >= 55 && prof.opening <= 115; // 3 all-pad salvos + herd
  prof.bodyRate = inWin(15, 45).length / 30;
  out.bodyRateOk = prof.bodyRate >= 3.5 && prof.bodyRate <= 7.5;    // 4-8/s pulsed volleys
  prof.noveltyRate = inWin(45, 70).length / 25;
  out.noveltyRateOk = prof.noveltyRate >= 1.2 && prof.noveltyRate <= 4.5;
  prof.lyricalRate = inWin(70, 90).length / 20;
  out.lyricalQuiet = prof.lyricalRate <= 2.0;                       // interlude 0.3-1/s-ish
  prof.buildRate = inWin(90, 120).length / 30;
  out.buildRateOk = prof.buildRate >= 3.0 && prof.buildRate <= 8.5;
  prof.finaleLaunches = inWin(120, 151).length;
  out.finaleShare = prof.finaleLaunches >= 200;                     // ~30%+ of the show

  // per-second buckets across the finale: wall peak 15-25(+jitter)/s
  const finaleBuckets = new Map();
  for (const c of inWin(120, 151)) {
    const s = Math.floor(rel(c));
    finaleBuckets.set(s, (finaleBuckets.get(s) ?? 0) + 1);
  }
  prof.finalePeakPerSec = Math.max(...finaleBuckets.values());
  out.finalePeakOk = prof.finalePeakPerSec >= 15 && prof.finalePeakPerSec <= 28;

  // the silence-then-wall beat: a >=2 s launch gap right before a >=12
  // launch second (the all-pad wall slam)
  const preWall = inWin(122, 134).map(rel).sort((a, b) => a - b);
  let maxGap = 0;
  for (let i = 1; i < preWall.length; i++) maxGap = Math.max(maxGap, preWall[i] - preWall[i - 1]);
  prof.silenceGap = Math.round(maxGap * 100) / 100;
  out.silenceBeat = maxGap >= 2.0;
  out.wallSlam = [...finaleBuckets.entries()].some(([s, n]) => s >= 129 && s <= 136 && n >= 12);

  // terminal salute chain over the wall
  prof.terminalSalutes = cues.filter((c) => c.pattern === 'salute' && rel(c) >= 142).length;
  out.saluteChain = prof.terminalSalutes >= 24;

  // all-pad "hits": >=8 distinct main-arc pads launching within 150 ms,
  // counted once per second — the brief wants 6-10 per show
  const mains = cues.filter((c) => c.pad <= 8).map((c) => [c.t, c.pad]).sort((a, b) => a[0] - b[0]);
  let hits = 0;
  let lastHit = -10;
  for (let i = 0; i < mains.length; i++) {
    if (mains[i][0] - lastHit < 1) continue;
    const padsSeen = new Set();
    for (let j = i; j < mains.length && mains[j][0] - mains[i][0] <= 0.15; j++) padsSeen.add(mains[j][1]);
    if (padsSeen.size >= 8) { hits++; lastHit = mains[i][0]; }
  }
  prof.allPadHits = hits;
  out.allPadHitsOk = hits >= 6 && hits <= 14;

  // three altitude bands all occupied during the wall window
  const wallCues = inWin(131, 144);
  out.threeLayers =
    wallCues.some((c) => c.kind === 'mine' || (c.o.flightT ?? 2.4) <= 1.8) &&
    wallCues.some((c) => (c.o.flightT ?? 2.4) > 1.9 && (c.o.flightT ?? 2.4) < 2.9) &&
    wallCues.some((c) => (c.o.flightT ?? 2.4) >= 3.0);

  // sound budget: one-shot plays (lift at launch, report at break) per
  // second — <=15 sustained with brief peaks <=25 (salute chains, wall)
  const plays = new Map();
  const addPlay = (t) => { const s = Math.floor(t); plays.set(s, (plays.get(s) ?? 0) + 1); };
  for (const c of cues) {
    if (c.lift) addPlay(c.t);
    if (c.sound) addPlay(c.tBurst);
  }
  const playCounts = [...plays.values()];
  prof.soundPeakPerSec = Math.max(...playCounts);
  prof.soundBusySeconds = playCounts.filter((n) => n > 15).length;
  out.soundPeakOk = prof.soundPeakPerSec <= 25;
  out.soundSustainedOk = prof.soundBusySeconds <= 8;
  prof.soundDemoted = show.soundBudget?.demoted ?? -1;
  out.soundDemotionRan = !!show.soundBudget && show.soundBudget.maxPlaysPerSec <= 25;

  // ---- 4) opening actually launches shells (events -> scheduled bursts) ----
  await waitGame(8);
  out.zapArrived = show.sparkRun === null;
  out.openingLaunched = fireworks.events.length > 0 || fireworks.ambientPulse.energy > 0;

  // ---- 5) plunging again mid-show does nothing ----
  det.autoPlunge();
  await waitGame(0.5);
  out.noDoubleFire = det.armed === false && det.anim !== 'down';

  // ---- 6) particle budget: run the WHOLE show under a fast-forward loop ----
  // Swap the frame loop for a five-substep version: the identical update
  // calls at dt=0.04 game-time, decoupled from the wall clock, rendering
  // once per frame. The real program with its real spawns, ~3-5x wall
  // speed; per-game-second cursor deltas stay exact.
  clearInterval(rtSampler);
  rtSampler = null;
  let ffTime = fireworks.time;
  app.renderer.setAnimationLoop(() => {
    for (let s = 0; s < 5; s++) {
      const dt = 0.04;
      ffTime += dt;
      world.update(dt, ffTime);
      fireworks.update(dt, ffTime);
      pool.update(ffTime, app.renderer.domElement.width, app.renderer.domElement.height);
    }
    samples.push([fireworks.time, pool.cursor]);
    app.audio.updateListener(app.camera);
    app.renderer.render(app.scene, app.camera);
  });
  // let it run to the natural end (hard cut, fallout, onEnd -> rearm)
  await new Promise((res) => {
    const id = setInterval(() => { if (!show.running) { clearInterval(id); res(); } }, 200);
    setTimeout(() => { clearInterval(id); res(); }, 360000);
  });
  out.showEnded = show.running === false;

  // per-game-second spawn totals from the sampled cursor deltas
  const cap = pool.capacity;
  const spawnPerSec = new Map();
  let totalSpawn = 0;
  for (let i = 1; i < samples.length; i++) {
    const d = (samples[i][1] - samples[i - 1][1] + cap) % cap;
    totalSpawn += d;
    const s = Math.floor(samples[i - 1][0]);
    spawnPerSec.set(s, (spawnPerSec.get(s) ?? 0) + d);
  }
  prof.sampledSeconds = spawnPerSec.size;
  prof.totalSpawned = totalSpawn;
  prof.peakSpawnPerSec = Math.max(...spawnPerSec.values());
  out.spawnCoverage = prof.sampledSeconds > 120; // sampler saw ~the whole show
  out.spawnPeakOk = prof.peakSpawnPerSec < 35000;
  prof.stompedAlive = pool.stompedAlive ?? null;
  out.stompOk = pool.stompedAlive == null ? true : pool.stompedAlive < totalSpawn * 0.02;

  // ---- 7) show wrapped up: detonator re-arms, then fires again ----
  await waitGame(0.4);
  out.rearming = det.anim === 'up' || det.norm > 0;
  await waitGame(2.0);
  out.rearmed = det.armed === true && det.norm === 1;
  det.autoPlunge();
  await waitGame(0.8);
  out.autoPlungeFires = det.armed === false && show.running === true;
  // clean up: kill the second run
  show._ei = show.events.length;
  show.time = show.duration;
  await waitGame(0.3);

  // ---- 8) waterfall pattern spawns a long-lived curtain ----
  const before = pool.cursor;
  fireworks.burst(new THREE.Vector3(0, 60, -70), {
    pattern: 'waterfall', size: 1.3,
    palette: { name: 'molten silver', a: 0xfff3d8, b: 0xffd489 }, sound: null,
  });
  const spawned = (pool.cursor - before + pool.capacity) % pool.capacity;
  out.waterfallDense = spawned > 1500; // stars * 6 trail beads + shimmer
  // long burn: sample the timing attribute of recent spawns for life > 4s
  let longLived = 0;
  for (let k = 0; k < spawned; k++) {
    const idx = (before + k) % pool.capacity;
    if (pool.aTiming.array[idx * 2 + 1] > 4) longLived++;
  }
  out.waterfallLongBurn = longLived > 400;

  // ---- 9) salute pattern exists ----
  fireworks.burst(new THREE.Vector3(0, 60, -70), { pattern: 'salute', size: 1, sound: null });
  out.saluteOk = true; // no throw

  return { out, prof };
});

console.log('profile:', JSON.stringify(r.prof, null, 1));
console.log(JSON.stringify(r.out, null, 1));
const realErrs = errs.filter((e) => !e.includes('404'));
console.log(realErrs.length ? 'ERRORS:\n' + realErrs.join('\n') : 'no page errors');
await browser.close();
process.exit(Object.values(r.out).every((v) => v === true) && !realErrs.length ? 0 : 1);
