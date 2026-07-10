// Renders the procedural sound library to .wav files so you can audition
// synth.js recipes without a headset (the sounds are built at load time in
// the browser, so this drives headless Chromium against the dev server).
//
//   node tools/serve.mjs &          # server must be running
//   node tools/render-sounds.mjs [outDir] [name ...]
//
// With no names, renders one variant of everything. Also prints simple
// envelope/brightness metrics per file — useful for checking "does the
// launch actually peak instantly and recede" without ears.

import { chromium } from 'playwright-core';
import fs from 'node:fs';

const args = process.argv.slice(2);
const outDir = args[0] && !args[0].startsWith('--') ? args[0] : 'sound-renders';
const names = args.slice(1);
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox',
    '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
page.on('pageerror', (err) => { console.error('[pageerror]', err.message); });
await page.goto('http://localhost:8080/', { waitUntil: 'load' });

const files = await page.evaluate(async (wanted) => {
  const synth = await import('./src/synth.js');
  const sr = 48000;
  const ctx = new OfflineAudioContext(1, sr, sr);

  let bodies = [];
  try {
    bodies = await Promise.all(
      ['assets/sounds/explosion1.wav', 'assets/sounds/explosion2.wav'].map(
        async (url) => (await ctx.decodeAudioData(await (await fetch(url)).arrayBuffer())).getChannelData(0),
      ),
    );
  } catch { /* metrics still work without the recordings */ }
  const body = (i) => (bodies.length ? bodies[i % bodies.length] : null);

  const recipes = {
    whoosh: (s) => synth.renderWhoosh(ctx, s, body(s)),
    boomBig: (s) => synth.renderBoom(ctx, s * 3 + 1, 1.0, body(s)),
    boomSmall: (s) => synth.renderBoom(ctx, s * 7 + 3, 0.3, body(s)),
    lift: (s) => synth.renderLift(ctx, s),
    shot: (s) => synth.renderShot(ctx, s),
    crackle: (s) => synth.renderCrackle(ctx, s),
    fuse: (s) => synth.renderFuseLoop(ctx, s),
    firecrackers: (s) => synth.renderFirecrackerLoop(ctx, s),
    cracker: (s) => synth.renderCrackerPop(ctx, s),
    waterfall: (s) => synth.renderWaterfallLoop(ctx, s),
    colossus: (s) => synth.renderColossusLoop(ctx, s),
    groan: (s) => synth.renderGroan(ctx, s),
    fountain: (s) => synth.renderFountainLoop(ctx, s),
    torch: (s) => synth.renderTorchLoop(ctx, s),
    wind: (s) => synth.renderWindLoop(ctx, s),
  };

  const toWav = (buf) => {
    const ch = [];
    for (let c = 0; c < buf.numberOfChannels; c++) ch.push(buf.getChannelData(c));
    const frames = ch[0].length, nCh = ch.length;
    const bytes = 44 + frames * nCh * 2;
    const ab = new ArrayBuffer(bytes);
    const dv = new DataView(ab);
    const wstr = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    wstr(0, 'RIFF'); dv.setUint32(4, bytes - 8, true); wstr(8, 'WAVE');
    wstr(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
    dv.setUint16(22, nCh, true); dv.setUint32(24, buf.sampleRate, true);
    dv.setUint32(28, buf.sampleRate * nCh * 2, true); dv.setUint16(32, nCh * 2, true);
    dv.setUint16(34, 16, true); wstr(36, 'data'); dv.setUint32(40, frames * nCh * 2, true);
    let o = 44;
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < nCh; c++) {
        const v = Math.max(-1, Math.min(1, ch[c][i]));
        dv.setInt16(o, v * 32767, true); o += 2;
      }
    }
    let bin = '';
    const u8 = new Uint8Array(ab);
    for (let i = 0; i < u8.length; i += 8192) bin += String.fromCharCode(...u8.subarray(i, i + 8192));
    return btoa(bin);
  };

  // envelope + brightness metrics: when does it peak, how fast does it fall,
  // and does the spectrum open bright and close dark (zero-crossing proxy)
  const metrics = (buf) => {
    const d = buf.getChannelData(0);
    const srb = buf.sampleRate;
    const win = Math.floor(srb * 0.02);
    let peakT = 0, peakV = 0;
    const rmsAt = (t) => {
      const i0 = Math.min(d.length - win, Math.floor(t * srb));
      if (i0 < 0) return 0;
      let s = 0;
      for (let i = i0; i < i0 + win; i++) s += d[i] * d[i];
      return Math.sqrt(s / win);
    };
    for (let t = 0; t < d.length / srb - 0.02; t += 0.01) {
      const r = rmsAt(t);
      if (r > peakV) { peakV = r; peakT = t; }
    }
    const zcr = (t) => {
      const i0 = Math.min(d.length - win, Math.max(0, Math.floor(t * srb)));
      let z = 0;
      for (let i = i0 + 1; i < i0 + win; i++) z += (d[i - 1] < 0) !== (d[i] < 0) ? 1 : 0;
      return Math.round(z / (win / srb) / 2); // ~Hz
    };
    const r = (x) => Math.round(x * 1000) / 1000;
    return {
      dur: r(d.length / srb), peakT: r(peakT),
      rms: [0.05, 0.3, 0.8, 1.5].map((t) => r(rmsAt(t) / (peakV || 1))),
      brightHz: [0.05, 0.8].map(zcr),
    };
  };

  const out = [];
  const list = wanted.length ? wanted : Object.keys(recipes);
  for (const name of list) {
    if (!recipes[name]) { out.push({ name, error: 'unknown sample' }); continue; }
    for (const seed of [1, 2]) {
      const buf = recipes[name](seed);
      out.push({ name: `${name}${seed}`, wav: toWav(buf), metrics: metrics(buf) });
    }
  }
  return out;
}, names);

for (const f of files) {
  if (f.error) { console.error(`${f.name}: ${f.error}`); continue; }
  fs.writeFileSync(`${outDir}/${f.name}.wav`, Buffer.from(f.wav, 'base64'));
  console.log(`${outDir}/${f.name}.wav`, JSON.stringify(f.metrics));
}
await browser.close();
