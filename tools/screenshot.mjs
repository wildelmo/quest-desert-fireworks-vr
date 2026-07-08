// Headless QA harness: loads the game in demo mode, collects console
// errors, waits for fireworks to go off, and saves screenshots.
//
//   node tools/screenshot.mjs [outDir] [--url URL] [--waits t1,t2,...]

import { chromium } from 'playwright-core';
import fs from 'node:fs';

const outDir = process.argv[2] && !process.argv[2].startsWith('--')
  ? process.argv[2] : 'shots';
const urlArg = process.argv.indexOf('--url');
const url = urlArg > -1 ? process.argv[urlArg + 1] : 'http://localhost:8080/?demo=1&orbit=0';
const waitsArg = process.argv.indexOf('--waits');
const waits = waitsArg > -1
  ? process.argv[waitsArg + 1].split(',').map(Number)
  : [3, 6, 9, 14];

fs.mkdirSync(outDir, { recursive: true });

const browserCandidates = [
  process.env.PW_CHROMIUM_PATH,
  '/opt/pw-browsers/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].filter(Boolean);
const executablePath = browserCandidates.find((p) => fs.existsSync(p));

const browser = await chromium.launch({
  executablePath,
  args: [
    '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--autoplay-policy=no-user-gesture-required',
    '--no-sandbox',
  ],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const errors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error' || msg.type() === 'warning') {
    errors.push(`[${msg.type()}] ${msg.text()}`);
  }
});
page.on('pageerror', (err) => errors.push(`[pageerror] ${err.message}`));

await page.goto(url, { waitUntil: 'load' });
let prev = 0;
for (const t of waits) {
  await page.waitForTimeout((t - prev) * 1000);
  prev = t;
  const file = `${outDir}/t${String(t).padStart(2, '0')}.png`;
  await page.screenshot({ path: file });
  console.log('saved', file);
}

const state = await page.evaluate(() => {
  const app = window.__app;
  if (!app) return { app: false };
  return {
    app: true,
    items: app.fireworks.items.size,
    rockets: app.fireworks.rockets.length,
    audioReady: app.audio.ready,
    xrPresenting: app.renderer.xr.isPresenting,
    calls: app.renderer.info.render.calls,
    triangles: app.renderer.info.render.triangles,
  };
});
console.log('state:', JSON.stringify(state));
console.log(errors.length ? `CONSOLE ISSUES (${errors.length}):\n` + errors.slice(0, 20).join('\n') : 'no console errors');
await browser.close();
process.exit(errors.filter((e) => e.startsWith('[pageerror]') || e.startsWith('[error')).length ? 1 : 0);
