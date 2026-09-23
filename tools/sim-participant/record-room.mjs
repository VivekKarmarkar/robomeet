// Render a recorded conversation in the meeting-room page to video, frame by frame, headless.
//
// Nothing here touches the desktop. An earlier version screen-recorded the display and captured unrelated windows;
// this one runs Chrome headless and screenshots only the page, one frame at a time, so the video can hold nothing
// but the room. Frame n is drawn at exactly n/fps seconds of the audio clock, so the faces cannot drift from the
// voices: each face is moved by its own voice's loudness and band balance measured at that instant (room.html
// renderFrame). The two voices are mixed under the frames. --tighten shortens stretches where neither voice is on
// air (a tool running) to a short gap, remapping screen changes and captions; nothing anyone said is re-timed.
//
// Usage: node tools/sim-participant/record-room.mjs <runDir> <out.mp4> [--tighten 1.2] [--fps 25]
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';

const run = promisify(execFile);
const ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const { chromium } = createRequire(join(ROOT, 'package.json'))('playwright');
const [runArg, outArg] = process.argv.slice(2).filter(a => !a.startsWith('--') && !/^\d+(\.\d+)?$/.test(a));
const runDir = resolve(runArg), outFile = resolve(outArg);
const opt = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? Number(process.argv[i + 1]) : d; };
const TIGHTEN = opt('tighten', 0), FPS = opt('fps', 25);
const readWav = buf => ({ head: buf.subarray(0, 44), pcm: buf.subarray(44) });

async function tighten(dir, keepSec) {
  const tl = JSON.parse(await readFile(join(dir, 'timeline.json'), 'utf8'));
  const robot = readWav(await readFile(join(dir, 'robot.wav'))), alex = readWav(await readFile(join(dir, 'alex.wav')));
  const per = 24000 * 2 * tl.tickMs / 1000, n = Math.floor(robot.pcm.length / per);
  const loud = (pcm, i) => { let s = 0; for (let k = i * per; k < (i + 1) * per; k += 2) { const v = pcm.readInt16LE(k); s += v * v; } return Math.sqrt(s / (per / 2)) > 300; };
  const keep = [], map = new Array(n); let silentRun = 0;
  for (let i = 0; i < n; i++) {
    const on = loud(robot.pcm, i) || loud(alex.pcm, i);
    silentRun = on ? 0 : silentRun + 1;
    if (on || silentRun * tl.tickMs / 1000 <= keepSec) keep.push(i);
    map[i] = Math.max(0, keep.length - 1);
  }
  const pick = pcm => Buffer.concat(keep.map(i => pcm.subarray(i * per, (i + 1) * per)));
  const out = `${dir}-tight`;
  await mkdir(out, { recursive: true });
  const wavOf = (head, pcm) => { const h = Buffer.from(head); h.writeUInt32LE(36 + pcm.length, 4); h.writeUInt32LE(pcm.length, 40); return Buffer.concat([h, pcm]); };
  await writeFile(join(out, 'robot.wav'), wavOf(robot.head, pick(robot.pcm)));
  await writeFile(join(out, 'alex.wav'), wavOf(alex.head, pick(alex.pcm)));
  const sec = s => (map[Math.min(n - 1, Math.max(0, Math.round(s * 1000 / tl.tickMs)))] || 0) * tl.tickMs / 1000;
  await writeFile(join(out, 'timeline.json'), JSON.stringify({ ...tl, ticks: keep.length,
    screen: tl.screen.map(s => ({ ...s, tick: map[Math.min(n - 1, s.tick)] || 0 })),
    captions: tl.captions.map(c => ({ ...c, sec: sec(c.sec), end: sec(c.end) })) }));
  console.log(`tightened ${(n * tl.tickMs / 1000).toFixed(0)}s -> ${(keep.length * tl.tickMs / 1000).toFixed(0)}s (silences kept to ${keepSec}s)`);
  return out;
}

const playDir = TIGHTEN > 0 ? await tighten(runDir, TIGHTEN) : runDir;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.wav': 'audio/wav' };
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.startsWith('/slides/') ? join(ROOT, 'public', path) : join(ROOT, path);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  try { const body = await readFile(file); res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' }).end(body); }
  catch { res.writeHead(404).end(); }
}).listen(0, '127.0.0.1');
await new Promise(r => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ headless: true, executablePath: process.env.ROBOMEET_CHROME_PATH || '/usr/bin/google-chrome' });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
page.on('pageerror', e => console.log('page error:', e.message));
await page.goto(`${base}/tools/sim-participant/room.html?run=${encodeURIComponent(playDir.slice(ROOT.length))}`, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => window.__room?.ready, null, { timeout: 90000 });
const duration = await page.evaluate(() => window.__room.duration);
const frames = Math.ceil(duration * FPS);
console.log(`rendering ${frames} frames (${duration.toFixed(0)}s at ${FPS} fps), headless`);
const enc = spawn('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
  '-i', join(playDir, 'robot.wav'), '-i', join(playDir, 'alex.wav'),
  '-filter_complex', '[1:a][2:a]amix=inputs=2:normalize=0,aresample=48000[a]', '-map', '0:v', '-map', '[a]',
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-shortest', outFile], { stdio: ['pipe', 'ignore', 'inherit'] });
const started = Date.now();
for (let i = 0; i < frames; i++) {
  await page.evaluate(([n, fps]) => window.__room.renderFrame(n, fps), [i, FPS]);
  const jpg = await page.screenshot({ type: 'jpeg', quality: 90 });
  if (!enc.stdin.write(jpg)) await new Promise(r => enc.stdin.once('drain', r));
  if (i % (FPS * 30) === 0) console.log(`  ${(i / FPS).toFixed(0)}s / ${duration.toFixed(0)}s  (${((Date.now() - started) / 1000).toFixed(0)}s elapsed)`);
}
enc.stdin.end();
await new Promise(r => enc.once('exit', r));
await browser.close(); server.close();
const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,size', '-of', 'default=nw=1', outFile]);
console.log(stdout.trim());
