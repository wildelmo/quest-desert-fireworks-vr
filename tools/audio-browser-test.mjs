// Real browser coverage: source allocations are audited outside AudioEngine,
// then the actual world/fireworks/show run against a stepped offline audio
// clock. No copied cue schedule and no simulated voice-admission policy.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { launchTestBrowser } from './test-browser.mjs';

const base = process.env.TEST_URL || 'http://127.0.0.1:8081';
const server = process.env.TEST_URL ? null : spawn(process.execPath, ['tools/serve.mjs'], {
  env: { ...process.env, PORT: '8081' }, stdio: 'pipe', windowsHide: true,
});
let browser;
try {
  for (let i = 0; ; i++) {
    try { if ((await fetch(base)).ok) break; } catch {}
    if (i === 100) throw new Error('Test server did not start');
    await delay(100);
  }
  browser = await launchTestBrowser();
  const page = await browser.newPage({ viewport: { width: 480, height: 320 } });
  page.setDefaultTimeout(240000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript(() => {
    // Count allocated graphs until explicit disconnection, including
    // sources already stopped whose ended callback hasn't run yet.
    window.audioAudit = { live: new Set(), peak: 0, violations: [], panners: new Set(), peakHrtf: 0 };
    for (const proto of [AudioContext.prototype, OfflineAudioContext.prototype]) {
      const create = proto.createBufferSource;
      proto.createBufferSource = function (...args) {
        const src = create.apply(this, args);
        const a = window.audioAudit;
        a.live.add(src);
        a.peak = Math.max(a.peak, a.live.size);
        if (a.live.size > 24) a.violations.push(a.live.size);
        const disconnect = src.disconnect.bind(src);
        src.disconnect = (...args) => { disconnect(...args); a.live.delete(src); };
        return src;
      };
      const createPanner = proto.createPanner;
      proto.createPanner = function (...args) {
        const panner = createPanner.apply(this, args);
        const a = window.audioAudit;
        a.panners.add(panner);
        const disconnect = panner.disconnect.bind(panner);
        panner.disconnect = (...args) => { disconnect(...args); a.panners.delete(panner); };
        return panner;
      };
    }
  });
  await page.goto(`${base}/?autostart=desktop`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__app?.audio.ready);
  const live = await page.evaluate(async () => {
    const { audio, renderer, fireworks, THREE } = window.__app;
    renderer.setAnimationLoop(null);
    clearInterval(audio._gustTimer);
    const pos = new THREE.Vector3(0, 1.6, -2);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    for (const v of audio._voices) v.stop(0.01);
    await wait(150);
    const a = window.audioAudit;
    a.peak = 0;
    for (let i = 0; i < 20; i++) audio.play('boomBig', pos, { gain: 0.1 });
    await wait(220); // report attacks finish; fresh reports may retire old rumble
    for (let wave = 0; wave < 12; wave++) {
      for (let i = 0; i < 180; i++) {
        const o = { gain: 0.1 + i / 10, startDelay: i % 5 === 0 ? 10 : 0,
          loop: i % 13 === 0, hrtf: true, lowpass: 2500 };
        if (i % 3 === 0) audio.playFlat('tick', o);
        else if (i % 3 === 1) audio.play('boomBig', pos, o);
        else audio.boom(pos, 1, { crackle: true });
        const hrtf = [...a.panners].filter((p) => p.panningModel === 'HRTF').length;
        a.peakHrtf = Math.max(a.peakHrtf, hrtf);
        if (hrtf > 2) a.violations.push(`HRTF:${hrtf}`);
        if (a.live.size !== audio.getDiagnostics().voices) a.violations.push('counter mismatch');
      }
      // Saturating audio must never break rocket launch behavior.
      fireworks._recedeWhoosh(null);
      for (const v of audio._voices) v.stop(0.01);
      await wait(120);
    }
    await audio.ctx.suspend();
    for (let i = 0; i < 200; i++) audio.play('boomBig', pos, { startDelay: 5, gain: i + 1 });
    const suspended = a.live.size;
    for (const v of audio._voices) v.stop();
    await audio.ctx.resume();
    await wait(200);
    const out = { peak: a.peak, peakHrtf: a.peakHrtf, suspended, remaining: a.live.size,
      violations: a.violations, diagnostics: audio.getDiagnostics() };
    await audio.ctx.close();
    return out;
  });
  console.log('Live Web Audio stress:', JSON.stringify(live));
  assert.deepEqual(live.violations, []);
  assert.ok(live.peak <= 24 && live.peak >= 20);
  assert.ok(live.peakHrtf <= 2);
  assert.equal(live.remaining, 0);
  assert.ok(live.diagnostics.refused > 1000);
  assert.ok(live.diagnostics.retired > 0, 'real browser must exercise fading under pressure');
  await page.close();

  const offline = await browser.newPage();
  offline.setDefaultTimeout(240000);
  offline.on('pageerror', (e) => errors.push(e.message));
  offline.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  // Keep the normal app bootstrap out: build the real world below using an
  // OfflineAudioContext so audio and physics advance on the SAME clock.
  await offline.route('**/src/main.js*', (r) => r.fulfill({ body: '', contentType: 'text/javascript' }));
  await offline.goto(base);
  const full = await offline.evaluate(async () => {
    const THREE = await import('three');
    const { AudioEngine, AUDIO_LIMITS } = await import('./src/audio.js');
    const { FireworksSystem, PALETTES, ITEM_TYPES } = await import('./src/fireworks.js');
    const { ParticlePool } = await import('./src/particles.js');
    const { terrainHeight } = await import('./src/terrain.js');
    const { createWorld } = await import('./src/world.js');
    let seed = 1234567;
    Math.random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    const sr = 48000;
    const duration = 190;
    const ctx = new OfflineAudioContext(2, duration * sr, sr);
    const sources = new Set();
    const panners = new Set();
    let peak = 0, peakHrtf = 0, peakNodes = 0, nodes = 0;
    const failures = [];
    const reportAttempts = Array(7).fill(0), reportAccepted = Array(7).fill(0);
    const counts = {};
    const accepted = {};
    for (const name of ['createBufferSource', 'createGain', 'createPanner', 'createDelay', 'createBiquadFilter']) {
      const original = ctx[name].bind(ctx);
      ctx[name] = (...args) => {
        const node = original(...args);
        nodes++; peakNodes = Math.max(peakNodes, nodes);
        if (name === 'createBufferSource') {
          sources.add(node); peak = Math.max(peak, sources.size);
          if (sources.size > AUDIO_LIMITS.voices) failures.push('actual allocated source ceiling exceeded');
        }
        if (name === 'createPanner') panners.add(node);
        const disconnect = node.disconnect.bind(node);
        let disposed = false;
        node.disconnect = (...args) => {
          disconnect(...args);
          if (!disposed) { nodes--; sources.delete(node); panners.delete(node); disposed = true; }
        };
        return node;
      };
    }
    const RealAC = window.AudioContext;
    const resume = ctx.resume.bind(ctx);
    ctx.resume = () => Promise.resolve(); // init's user-gesture resume; rendering starts below
    window.AudioContext = function () { return ctx; };
    const audio = new AudioEngine();
    await audio.init();
    ctx.resume = resume;
    window.AudioContext = RealAC;
    clearInterval(audio._gustTimer);
    const play = audio.play.bind(audio);
    audio.play = (name, pos, opts) => {
      counts[name] = (counts[name] ?? 0) + 1;
      const section = Math.min(6, Math.floor(ctx.currentTime / 30));
      if (name.startsWith('boom')) reportAttempts[section]++;
      const h = play(name, pos, opts);
      if (h) {
        accepted[name] = (accepted[name] ?? 0) + 1;
        if (name.startsWith('boom')) reportAccepted[section]++;
      }
      if (sources.size !== audio.getDiagnostics().voices) failures.push('engine counter differs from allocated graph');
      return h;
    };
    const scene = new THREE.Scene();
    const pool = new ParticlePool(96000, terrainHeight);
    const fireworks = new FireworksSystem(scene, pool, audio, terrainHeight);
    const world = createWorld(scene, fireworks, pool, audio);
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(0, 1.6, 0);
    audio.listenerPos.copy(camera.position);
    world.show.start(world.detonator.wireCurve);
    // Actual sandbox emitters overlap the show. Include every item type
    // through the ordinary activation path, not just the finale schedule.
    const exerciseSandbox = () => {
      for (const type of Object.keys(ITEM_TYPES)) {
        const item = fireworks.createItem(type);
        item.root.position.set(4 + Math.random() * 10, terrainHeight(4, -12), -12);
        item.state = 'planted';
        fireworks.activate(item);
      }
      world.colossus.ignite();
      for (const pattern of ['dragoneggs', 'thousandbloom', 'crackle', 'multibreak']) {
        fireworks.burst(new THREE.Vector3(0, 45, -60), { pattern, size: 0.8, palette: PALETTES[0], sound: 'big' });
      }
    };
    let last = 0, stress = 0, ceilingStress = false;
    const step = 0.05;
    const advance = () => {
      const t = ctx.currentTime;
      const dt = t - last;
      last = t;
      world.update(dt, t);
      fireworks.update(dt, t);
      audio.updateListener(camera);
      if (stress < 3 && t > 30 + stress * 50) { exerciseSandbox(); stress++; }
      // Force extreme summing after the show to test the output ceiling,
      // rather than relying on a particular show's randomized mix to hit it.
      if (!ceilingStress && t > 170) {
        ceilingStress = true;
        for (let i = 0; i < 8; i++) audio.playFlat('boomBig', { gain: 100 });
      }
      const hrtf = [...panners].filter((p) => p.panningModel === 'HRTF').length;
      peakHrtf = Math.max(peakHrtf, hrtf);
      if (hrtf > AUDIO_LIMITS.hrtf || sources.size > AUDIO_LIMITS.voices) failures.push(`limit at ${t}`);
    };
    // Offline suspension lets the browser deliver genuine ended events and
    // run cleanup between simulation steps. Never disable the live cap.
    let paused = ctx.suspend(0);
    const rendering = ctx.startRendering();
    await paused;
    for (let t = 0; t < duration - step; t += step) {
      advance();
      if (t >= duration - 8) for (const v of audio._voices) v.stop(0.01);
      paused = ctx.suspend(Math.min(duration - 0.003, t + step));
      await ctx.resume();
      await paused;
    }
    await ctx.resume();
    const buffer = await rendering;
    let outputPeak = 0, overCeiling = 0, nonFinite = 0;
    const rms = [];
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < data.length; i++) {
        const a = Math.abs(data[i]);
        if (!Number.isFinite(a)) nonFinite++;
        outputPeak = Math.max(outputPeak, a);
        if (a > 0.981) overCeiling++;
      }
    }
    const data = buffer.getChannelData(0);
    for (let s = 0; s < duration; s++) {
      let energy = 0;
      for (let i = s * sr; i < (s + 1) * sr; i++) energy += data[i] ** 2;
      rms.push(Math.sqrt(energy / sr));
    }
    return { peak, peakHrtf, peakNodes, failures: failures.slice(0, 10), outputPeak,
      overCeiling, nonFinite, reportAttempts, reportAccepted, counts, accepted,
      showEnded: !world.show.running, stress, ceilingStress, remaining: sources.size,
      diagnostics: audio.getDiagnostics(), rms };
  });
  console.log('Full show + sandbox:', JSON.stringify({ ...full, rms: '(per-second levels omitted)' }));
  assert.deepEqual(full.failures, []);
  assert.ok(full.peak <= 24);
  assert.ok(full.peakHrtf <= 2);
  assert.ok(full.outputPeak > 0.97, 'ceiling stress must actually reach the soft knee');
  assert.equal(full.overCeiling, 0);
  assert.equal(full.nonFinite, 0);
  assert.ok(full.showEnded);
  assert.equal(full.stress, 3);
  assert.equal(full.ceilingStress, true);
  assert.equal(full.remaining, 0);
  // Every part of the show must retain explosion reports; no silent scenes
  // hidden behind a passing global peak assertion.
  for (let i = 0; i < 6; i++) {
    if (full.reportAttempts[i]) assert.ok(full.reportAccepted[i] / full.reportAttempts[i] > 0.8,
      `too many reports refused in section ${i}`);
  }
  assert.deepEqual(errors, []);
  console.log('PASS: actual graphs stay bounded, all show sections retain reports, output stays below full scale.');
} finally {
  await browser?.close();
  server?.kill();
}
