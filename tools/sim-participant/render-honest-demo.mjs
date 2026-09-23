// Render a built honest demo (build-honest-demo.mjs) to video: headless Chrome, page pixels only, frame n at n/fps.
// Usage: node tools/sim-participant/render-honest-demo.mjs <builtDir> <out.mp4>
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';

const run = promisify(execFile);
const ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const { chromium } = createRequire(join(ROOT, 'package.json'))('playwright');
const [dirArg, outArg] = process.argv.slice(2);
const dir = resolve(dirArg), outFile = resolve(outArg);
const demo = JSON.parse(await readFile(join(dir, 'demo.json'), 'utf8'));
const FPS = demo.fps;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.startsWith('/demo/') ? join(dir, path.slice(6)) : join(ROOT, path);
  if (!file.startsWith(ROOT) && !file.startsWith(dir)) { res.writeHead(403).end(); return; }
  let body; try { body = await readFile(file); } catch { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' }).end(body);
}).listen(0, '127.0.0.1');
await new Promise(r => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, executablePath: process.env.ROBOMEET_CHROME_PATH || '/usr/bin/google-chrome' });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
page.on('pageerror', e => console.log('page error:', e.message));
await page.goto(`${base}/tools/sim-participant/honest-demo.html?demo=/demo/demo.json`, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => window.__demo?.ready, null, { timeout: 60000 });
await page.evaluate(() => { const img = document.getElementById('shot'); const set = img.setAttribute.bind(img); img.setAttribute = (k, v) => set(k, k === 'src' && !v.startsWith('/') ? `/demo/${v}` : v); });
const frames = Math.ceil(demo.duration * FPS);
console.log(`rendering ${frames} frames (${demo.duration.toFixed(0)} s), headless`);
const enc = spawn('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
  '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', join(dir, 'robot.pcm'), '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', join(dir, 'alex.pcm'),
  '-filter_complex', '[1:a][2:a]amix=inputs=2:normalize=0,aresample=48000[a]', '-map', '0:v', '-map', '[a]',
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-shortest', outFile], { stdio: ['pipe', 'ignore', 'inherit'] });
const started = Date.now();
let lastSrc = null;
for (let i = 0; i < frames; i++) {
  const src = await page.evaluate(([n, fps]) => { window.__demo.renderFrame(n, fps); return document.getElementById('shot').getAttribute('src'); }, [i, FPS]);
  await page.waitForFunction(() => [...document.querySelectorAll('#full img')].every(img => img.complete), null, { timeout: 10000 }).catch(() => {});
  if (src !== lastSrc) { await page.waitForFunction(() => { const img = document.getElementById('shot'); return !img.getAttribute('src') || img.complete; }, null, { timeout: 10000 }).catch(() => {}); lastSrc = src; }
  const jpg = await page.screenshot({ type: 'jpeg', quality: 90 });
  if (!enc.stdin.write(jpg)) await new Promise(r => enc.stdin.once('drain', r));
  if (i % (FPS * 30) === 0) console.log(`  ${(i / FPS).toFixed(0)} s / ${demo.duration.toFixed(0)} s  (${((Date.now() - started) / 1000).toFixed(0)} s elapsed)`);
}
enc.stdin.end();
await new Promise(r => enc.once('exit', r));
await browser.close(); server.close();
const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,size', '-of', 'default=nw=1', outFile]);
console.log(stdout.trim());
process.exit(0);
