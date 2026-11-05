import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';

export async function launchTestBrowser() {
  const executablePath = [process.env.CHROMIUM_PATH, '/opt/pw-browsers/chromium',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find((p) => p && existsSync(p));
  return chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader',
      '--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
  });
}
