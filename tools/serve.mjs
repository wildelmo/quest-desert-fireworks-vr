// Tiny static file server for local dev.
//
//   npm start             -> http://localhost:8080  (fine for desktop testing)
//   npm run start:https   -> https://<your-lan-ip>:8443  (needed for the Quest browser,
//                            which only allows WebXR on secure origins; accept the
//                            self-signed cert warning once)
//
// No dependencies. The --https mode shells out to `openssl` to mint a
// self-signed cert into .devcert/ on first run.

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const useHttps = process.argv.includes('--https');
const port = Number(process.env.PORT || (useHttps ? 8443 : 8080));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
  '.ico': 'image/x-icon',
};

function handler(req, res) {
  let urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (urlPath.endsWith('/')) urlPath += 'index.html';
  const file = path.join(root, path.normalize(urlPath));
  if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

function lanIPs() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

if (useHttps) {
  const dir = path.join(root, '.devcert');
  const keyFile = path.join(dir, 'key.pem');
  const certFile = path.join(dir, 'cert.pem');
  if (!fs.existsSync(keyFile)) {
    fs.mkdirSync(dir, { recursive: true });
    execSync(
      `openssl req -x509 -newkey rsa:2048 -keyout "${keyFile}" -out "${certFile}" ` +
      `-days 3650 -nodes -subj "/CN=desert-fireworks.local"`,
      { stdio: 'ignore' },
    );
    console.log('Generated self-signed cert in .devcert/');
  }
  https.createServer({ key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) }, handler)
    .listen(port, () => {
      console.log('Serving over HTTPS (accept the cert warning on the Quest):');
      for (const ip of lanIPs()) console.log(`  https://${ip}:${port}`);
      console.log(`  https://localhost:${port}`);
    });
} else {
  http.createServer(handler).listen(port, () => {
    console.log(`Serving at http://localhost:${port}`);
    console.log('Note: the Quest browser needs HTTPS for WebXR — use `npm run start:https` or GitHub Pages.');
  });
}
