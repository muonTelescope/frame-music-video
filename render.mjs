// Renders the video frame-by-frame in headless Chromium (WebGL via SwiftShader) and muxes
// it with build/audio.wav using ffmpeg.
//
//   node render.mjs                         full video -> dist/cosmic-rain.mp4
//   node render.mjs --stills 20,64.5,130    review stills (beats) -> build/stills/
//   options: --w 1920 --h 1080 --workers 3 --from 0 --to <frame> --keep
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
  return acc;
}, []));
const W = +(args.w || 1920), H = +(args.h || 1080);
const WORKERS = +(args.workers || 3);
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const CHROME = process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.json': 'application/json', '.woff2': 'font/woff2', '.wav': 'audio/wav' };
const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (!p.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(p, (err, data) => {
    if (err) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
    res.end(data);
  });
});
await new Promise((r) => server.listen(0, r));
const PORT = server.address().port;

async function openPage(browser) {
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  page.on('pageerror', (e) => console.error('page error:', e));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.error('console:', m.text()); });
  await page.goto(`http://localhost:${PORT}/video/index.html?w=${W}&h=${H}`);
  await page.waitForFunction('window.ready === true', null, { timeout: 120000 });
  return page;
}
const launch = () => chromium.launch({
  executablePath: CHROME,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-gpu-sandbox'],
});
const decode = (dataUrl) => Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');

if (args.stills) {
  const out = path.join(ROOT, 'build/stills');
  fs.mkdirSync(out, { recursive: true });
  const browser = await launch();
  const page = await openPage(browser);
  for (const b of String(args.stills).split(',').map(Number)) {
    const t0 = Date.now();
    await page.evaluate((x) => window.renderBeat(x), b);
    const img = decode(await page.evaluate(() => window.grab(0.92)));
    const f = path.join(out, `beat_${String(b).padStart(6, '0')}.jpg`);
    fs.writeFileSync(f, img);
    console.log(`${f}  (${Date.now() - t0} ms)`);
  }
  await browser.close();
  server.close();
  process.exit(0);
}

// ---- full render
const frameDir = path.join(ROOT, 'build/frames');
fs.mkdirSync(frameDir, { recursive: true });
const probe = await launch();
const probePage = await openPage(probe);
const total = await probePage.evaluate(() => window.totalFrames);
await probe.close();
const from = +(args.from || 0), to = Math.min(total, +(args.to || total));
const todo = [];
for (let f = from; f < to; f++) if (!fs.existsSync(path.join(frameDir, `${String(f).padStart(5, '0')}.jpg`))) todo.push(f);
console.log(`rendering ${todo.length} of ${to - from} frames at ${W}x${H} with ${WORKERS} workers`);

let done = 0; const t0 = Date.now();
async function worker(id) {
  const browser = await launch();
  const page = await openPage(browser);
  while (todo.length) {
    const f = todo.shift();
    await page.evaluate((x) => window.renderFrame(x), f);
    fs.writeFileSync(path.join(frameDir, `${String(f).padStart(5, '0')}.jpg`), decode(await page.evaluate(() => window.grab(0.94))));
    done++;
    if (done % 50 === 0) {
      const el = (Date.now() - t0) / 1000;
      console.log(`  ${done} frames, ${(el / done).toFixed(2)} s/frame, eta ${((todo.length * el) / done / 60).toFixed(1)} min`);
    }
  }
  await browser.close();
}
await Promise.all(Array.from({ length: WORKERS }, (_, i) => worker(i)));
server.close();

if (from === 0 && to === total) {
  fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
  const out = path.join(ROOT, 'dist/cosmic-rain.mp4');
  // light temporal denoise (the retro pass adds film grain) + two-pass 3.2 Mbps keeps the file ~66 MB
  const log = path.join(ROOT, 'build/x264');
  const common = ['-y', '-v', 'error', '-framerate', '30', '-i', path.join(frameDir, '%05d.jpg')];
  const vopts = ['-vf', 'hqdn3d=4:3:6:6', '-c:v', 'libx264', '-preset', 'slow', '-b:v', '3200k', '-pix_fmt', 'yuv420p', '-passlogfile', log];
  for (const pass of [1, 2]) {
    const tail = pass === 1
      ? ['-pass', '1', '-an', '-f', 'mp4', '/dev/null']
      : ['-i', path.join(ROOT, 'build/audio.wav'), '-pass', '2', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-shortest', out];
    const args = pass === 1 ? [...common, ...vopts, ...tail] : [...common, tail[0], tail[1], ...vopts, ...tail.slice(2)];
    const r = spawnSync(FFMPEG, args, { stdio: 'inherit' });
    if (r.status !== 0) process.exit(r.status || 1);
  }
  console.log(`wrote ${out}`);
}
