// Offline oracle for presentation quality and latency (docs/presentation-spec.md TC-R1..R4, TC-S3, TC-S5).
// No Google Meet: a local page plays Meet's part. It calls getDisplayMedia exactly as Meet does, sends the track
// through a real WebRTC hop with a bitrate cap and a chosen codec, and receives it in the same page. The received
// frame is scored against the pixel-exact render of the same view with ffmpeg SSIM/PSNR.
//
// Paths compared:
//   old-720   the path of tests 1-4: renderer canvas 1280x720 @12 fps -> loopback bridge -> meet-media.js 1280x720 canvas
//   old-1080  test 5: renderer canvas 1920x1080 @24 fps -> loopback bridge -> meet-media.js 1280x720 canvas
//   new-exact src/meet-stage.js drawing the pixel-exact 1920x1080 render of the view, in the Meet page
//   new-page  src/meet-stage.js drawing the view from the 2400 px page picture (resampled), in the Meet page
// Usage: node tools/present-lab/fixture.mjs [--quick] [--out DIR]
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const app = new URL('../../', import.meta.url).pathname;
const { chromium } = createRequire(app + 'package.json')('playwright');
const args = process.argv.slice(2);
const quick = args.includes('--quick');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : join(app, 'tools/present-lab/runs', stamp);
mkdirSync(out, { recursive: true });
const deckDir = join(app, 'public/slides/projectile-motion-deck');
const deck = JSON.parse(readFileSync(join(deckDir, 'deck.json'), 'utf8'));
const view1 = deck.slides[0].views[0];
const view2 = deck.slides[0].views[1];
const b64 = file => readFileSync(file).toString('base64');
const pagePng = b64(join(deckDir, 'page-1.png'));
const view1Png = b64(join(deckDir, 'page-1-view-1.png'));
const view2Png = b64(join(deckDir, 'page-1-view-2.png'));
const ideal1 = join(deckDir, 'page-1-view-1.png');
const log = (...values) => console.log(new Date().toISOString().slice(11, 23), ...values);

// ---- tiny local "meet.google.com" and "renderer" pages (127.0.0.1 is a secure context)
const server = createServer((request, response) => {
  const body = request.url.startsWith('/renderer')
    ? '<!doctype html><title>renderer</title><body style="background:#111"></body>'
    : '<!doctype html><title>fake meet</title><body style="margin:0;background:#202124"><video id="rx" muted playsinline autoplay style="width:960px;height:540px;background:#000;display:block"></video><div id="label" style="color:#ddd;font:14px sans-serif;padding:6px"></div></body>';
  response.writeHead(200, { 'Content-Type': 'text/html' });
  response.end(body);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: false,
  env: { ...process.env, DISPLAY: process.env.DISPLAY || ':1' },
  args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--window-size=1000,640', '--window-position=40,40'],
});

// ---- in-page helpers -------------------------------------------------------------------------------------
async function meetHop({ codec, maxBitrate, hint }) {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
  const track = stream.getVideoTracks()[0];
  if (hint !== null && hint !== undefined) track.contentHint = hint;
  const tx = new RTCPeerConnection();
  const rx = new RTCPeerConnection();
  tx.onicecandidate = event => event.candidate && rx.addIceCandidate(event.candidate);
  rx.onicecandidate = event => event.candidate && tx.addIceCandidate(event.candidate);
  const transceiver = tx.addTransceiver(track, { direction: 'sendonly' });
  const all = RTCRtpSender.getCapabilities('video').codecs;
  const chosen = all.filter(item => item.mimeType.toLowerCase() === `video/${codec.toLowerCase()}`);
  if (!chosen.length) throw new Error(`codec ${codec} not available`);
  transceiver.setCodecPreferences([...chosen, ...all.filter(item => !chosen.includes(item))]);
  const video = document.getElementById('rx');
  rx.ontrack = event => { video.srcObject = new MediaStream([event.track]); video.play().catch(() => {}); };
  await tx.setLocalDescription();
  await rx.setRemoteDescription(tx.localDescription);
  await rx.setLocalDescription();
  await tx.setRemoteDescription(rx.localDescription);
  const params = transceiver.sender.getParameters();
  params.encodings = params.encodings?.length ? params.encodings : [{}];
  params.encodings[0].maxBitrate = maxBitrate;
  await transceiver.sender.setParameters(params);
  // Frame-change watcher on the receiver: a 48x27 luminance signature of every presented frame.
  const probe = document.createElement('canvas');
  probe.width = 48; probe.height = 27;
  const pctx = probe.getContext('2d', { willReadFrequently: true });
  const frames = [];
  const signature = () => { pctx.drawImage(video, 0, 0, 48, 27); const data = pctx.getImageData(0, 0, 48, 27).data; const sig = new Float32Array(48 * 27); for (let i = 0; i < sig.length; i++) sig[i] = data[i * 4] * 0.3 + data[i * 4 + 1] * 0.59 + data[i * 4 + 2] * 0.11; return sig; };
  const onFrame = (now, meta) => { if (video.videoWidth) frames.push({ at: Date.now(), w: meta.width, h: meta.height, sig: signature() }); if (frames.length > 900) frames.shift(); video.requestVideoFrameCallback(onFrame); };
  video.requestVideoFrameCallback(onFrame);
  window.__hop = { tx, rx, transceiver, video, track, frames };
  document.getElementById('label').textContent = `${codec} ${Math.round(maxBitrate / 1000)} kbps hint=${hint ?? '(unset)'} track=${track.contentHint || '(none)'}`;
  return { contentHint: track.contentHint, settings: track.getSettings() };
}
async function grab() {
  const video = window.__hop.video;
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth; canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  return { dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height };
}
async function hopStats() {
  const pick = (report, keys) => Object.fromEntries(keys.filter(key => report[key] !== undefined).map(key => [key, report[key]]));
  const result = { outbound: {}, inbound: {}, codec: null };
  for (const report of (await window.__hop.tx.getStats()).values()) {
    if (report.type === 'outbound-rtp' && report.kind === 'video') result.outbound = pick(report, ['frameWidth', 'frameHeight', 'framesPerSecond', 'framesEncoded', 'bytesSent', 'targetBitrate', 'qualityLimitationReason', 'encoderImplementation', 'contentType', 'keyFramesEncoded', 'qpSum', 'totalEncodeTime', 'scalabilityMode']);
    if (report.type === 'codec') result.codec = report.mimeType;
  }
  for (const report of (await window.__hop.rx.getStats()).values()) {
    if (report.type === 'inbound-rtp' && report.kind === 'video') result.inbound = pick(report, ['frameWidth', 'frameHeight', 'framesPerSecond', 'framesDecoded', 'bytesReceived', 'contentType', 'decoderImplementation', 'freezeCount', 'qpSum']);
  }
  if (result.outbound.qpSum && result.outbound.framesEncoded) result.outbound.avgQp = +(result.outbound.qpSum / result.outbound.framesEncoded).toFixed(1);
  return result;
}
// First received frame that differs from the frame shown just before the change, and the receiver fps after it.
function changeTiming(changedAt) {
  const frames = window.__hop.frames;
  const before = [...frames].reverse().find(frame => frame.at <= changedAt);
  if (!before) return { error: 'no frame before change' };
  const diff = (a, b) => { let sum = 0; for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]); return sum / a.length; };
  const first = frames.find(frame => frame.at > changedAt && diff(frame.sig, before.sig) > 2);
  const after = frames.filter(frame => frame.at > changedAt && frame.at <= changedAt + 1000);
  const last = frames.at(-1);
  let settle = null;
  for (let i = frames.length - 1; i > 0; i--) { if (frames[i].at <= changedAt) break; if (diff(frames[i].sig, frames[i - 1].sig) > 0.5) { settle = frames[i].at - changedAt; break; } }
  return { firstChangeMs: first ? first.at - changedAt : null, receivedFramesFirstSecond: after.length, settledMs: settle, lastFrameAt: last?.at - changedAt };
}

// Old path, renderer page: the image mode of public/media.js paintSlides, repainted every 200 ms, into the bridge.
async function setupRenderer({ width, height, fps, image }) {
  const screen = document.createElement('canvas'); screen.width = width; screen.height = height;
  const camera = document.createElement('canvas'); camera.width = 1280; camera.height = 720;
  const sctx = screen.getContext('2d', { alpha: false });
  const cctx = camera.getContext('2d');
  const audio = new AudioContext();
  const destination = audio.createMediaStreamDestination();
  const keep = audio.createConstantSource(); keep.offset.value = 0; keep.connect(destination); keep.start();
  const decode = async data => { const bin = atob(data); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); return createImageBitmap(new Blob([bytes], { type: 'image/png' })); };
  const state = { bitmap: await decode(image), changedAt: null };
  const paint = () => {
    sctx.fillStyle = '#ffffff'; sctx.fillRect(0, 0, width, height);
    const img = state.bitmap; const r = Math.min(width / img.width, height / img.height); const dw = img.width * r; const dh = img.height * r;
    sctx.imageSmoothingEnabled = true; sctx.imageSmoothingQuality = 'high';
    sctx.drawImage(img, (width - dw) / 2, (height - dh) / 2, dw, dh);
    cctx.fillStyle = '#182820'; cctx.fillRect(0, 0, 1280, 720);
  };
  paint();
  setInterval(paint, 200);
  window.__renderer = { tracks: { audio: destination.stream.getAudioTracks()[0], camera: camera.captureStream(24).getVideoTracks()[0], screen: screen.captureStream(fps).getVideoTracks()[0] }, async swap(data) { state.bitmap = await decode(data); state.changedAt = Date.now(); paint(); return state.changedAt; } };
  return true;
}
async function rendererOffer(epoch) {
  const tracks = window.__renderer.tracks;
  const peer = new RTCPeerConnection({ iceServers: [] });
  const pending = [];
  const transceivers = {};
  for (const role of ['audio', 'camera', 'screen']) transceivers[role] = peer.addTransceiver(tracks[role], { direction: role === 'audio' ? 'sendrecv' : 'sendonly', streams: [new MediaStream([tracks[role]])] });
  peer.onicecandidate = ({ candidate }) => { if (candidate) window.__robomeetSignal({ epoch, candidate: candidate.toJSON() }).catch(() => {}); };
  window.__robomeetAppBridge = { async addCandidate(item) { if (!peer.remoteDescription) pending.push(item.candidate); else await peer.addIceCandidate(item.candidate); }, async setAnswer(description) { await peer.setRemoteDescription(description); for (const candidate of pending.splice(0)) await peer.addIceCandidate(candidate); } };
  await peer.setLocalDescription(await peer.createOffer());
  return { description: peer.localDescription.toJSON(), roles: Object.fromEntries(Object.entries(transceivers).map(([role, item]) => [role, item.mid])), epoch };
}

// ---- one scenario -----------------------------------------------------------------------------------------
async function scenario({ mode, codec, maxBitrate, hint = 'keep', idleFrameMs, settleMs = quick ? 3500 : 5000, latency = false }) {
  const name = `${mode}_${codec}_${Math.round(maxBitrate / 1000)}k${hint !== 'keep' ? `_hint-${hint || 'none'}` : ''}${idleFrameMs !== undefined ? `_idle${idleFrameMs}` : ''}`;
  const context = await browser.newContext({ viewport: { width: 980, height: 600 } });
  const meet = await context.newPage();
  await meet.addInitScript({ path: join(app, 'src/meet-media.js') });
  if (mode.startsWith('new')) await meet.addInitScript({ path: join(app, 'src/meet-stage.js') });
  let renderer = null;
  const result = { name, mode, codec, maxBitrate, hint, idleFrameMs };
  try {
    if (mode.startsWith('old')) {
      renderer = await context.newPage();
      await meet.exposeFunction('__robomeetSignal', item => renderer.evaluate(item => window.__robomeetAppBridge?.addCandidate(item), item).catch(() => {}));
      await renderer.exposeFunction('__robomeetSignal', item => meet.evaluate(item => window.RoboMeetMedia?.addCandidate(item), item).catch(() => {}));
      await renderer.goto(`${base}/renderer`);
      await meet.goto(`${base}/meet`);
      await meet.bringToFront();
      const size = mode === 'old-720' ? { width: 1280, height: 720, fps: 12 } : { width: 1920, height: 1080, fps: 24 };
      await renderer.evaluate(setupRenderer, { ...size, image: view1Png });
      const offer = await renderer.evaluate(rendererOffer, 1);
      const answer = await meet.evaluate(offer => window.RoboMeetMedia.answer(offer), offer);
      await renderer.evaluate(answer => window.__robomeetAppBridge.setAnswer(answer), answer);
      await meet.waitForFunction(() => window.RoboMeetMedia.health().screenFrames > 10, undefined, { timeout: 15000 });
    } else {
      await meet.goto(`${base}/meet`);
      await meet.evaluate(async ({ pagePng, view1Png, view2Png, view1, view2, exact, idleFrameMs }) => {
        const stage = window.RoboMeetStage;
        if (idleFrameMs !== undefined) stage.configure({ idleFrameMs });
        await stage.putAsset('page', pagePng);
        if (exact) { await stage.putAsset('v1', view1Png); await stage.putAsset('v2', view2Png); }
        stage.setDeck({ title: 'Projectile Motion', slides: [{ kind: 'image', asset: 'page', views: [{ ...view1, asset: exact ? 'v1' : null }, { ...view2, asset: exact ? 'v2' : null }] }] });
        await stage.show({ slide: 0, view: 0 });
      }, { pagePng, view1Png, view2Png, view1: { x: view1.x, y: view1.y, w: view1.w, h: view1.h }, view2: { x: view2.x, y: view2.y, w: view2.w, h: view2.h }, exact: mode === 'new-exact', idleFrameMs });
    }
    result.track = await meet.evaluate(meetHop, { codec, maxBitrate, hint: hint === 'keep' ? null : hint });
    await meet.waitForFunction(() => window.__hop.video.videoWidth > 0, undefined, { timeout: 15000 });
    await meet.waitForTimeout(settleMs);
    const frame = await meet.evaluate(grab);
    const png = join(out, `${name}.png`);
    writeFileSync(png, Buffer.from(frame.dataUrl.split(',')[1], 'base64'));
    result.received = { width: frame.width, height: frame.height, file: png };
    result.stats = await meet.evaluate(hopStats);
    if (mode.startsWith('new')) result.stage = await meet.evaluate(() => { const h = window.RoboMeetStage.health(); return { fps: h.fps, contentHint: h.contentHint, trackSettings: h.trackSettings, displayRequests: h.displayRequests }; });
    else result.bridgeHealth = await meet.evaluate(() => window.RoboMeetMedia.health());
    if (latency) {
      const changedAt = mode.startsWith('new')
        ? (await meet.evaluate(() => window.RoboMeetStage.show({ slide: 0, view: 1 }))).changedAt
        : await renderer.evaluate(data => window.__renderer.swap(data), view2Png);
      await meet.waitForTimeout(2500);
      result.change = await meet.evaluate(changeTiming, changedAt);
    }
    Object.assign(result, score(png, ideal1));
  } catch (error) {
    result.error = String(error.message).split('\n')[0];
  } finally {
    await context.close();
  }
  log(name, result.error || `${result.received?.width}x${result.received?.height} SSIM-Y ${result.ssimY} PSNR ${result.psnr} qp ${result.stats?.outbound?.avgQp} hint ${result.track?.contentHint || '-'} ${result.stats?.outbound?.qualityLimitationReason || ''}${result.change ? ` change ${result.change.firstChangeMs} ms, ${result.change.receivedFramesFirstSecond} fr/s` : ''}`);
  return result;
}

// SSIM / PSNR of the received frame against the ideal 1920x1080 render (received frames are scaled up if smaller).
function score(received, ideal) {
  // ffmpeg prints the ssim/psnr summaries on stderr.
  const run = metric => spawnSync('ffmpeg', ['-hide_banner', '-i', received, '-i', ideal, '-lavfi', `[0:v]scale=1920:1080:flags=bicubic,format=yuv444p[a];[1:v]format=yuv444p[b];[a][b]${metric}`, '-f', 'null', '-'], { encoding: 'utf8' }).stderr || '';
  const ssim = run('ssim');
  const psnr = run('psnr');
  const y = ssim.match(/SSIM Y:([0-9.]+)/);
  const all = ssim.match(/All:([0-9.]+)/);
  const py = psnr.match(/PSNR y:([0-9.]+|inf)/);
  return { ssimY: y ? +(+y[1]).toFixed(4) : null, ssimAll: all ? +(+all[1]).toFixed(4) : null, psnr: py ? py[1] : null };
}
export { score };

// ---- matrix ----------------------------------------------------------------------------------------------
const codecs = quick ? ['VP9'] : ['VP9', 'VP8', 'AV1'];
const rates = quick ? [1_200_000] : [2_500_000, 800_000];
const results = [];
for (const codec of codecs) for (const maxBitrate of rates) for (const mode of ['old-720', 'old-1080', 'new-exact', 'new-page']) {
  results.push(await scenario({ mode, codec, maxBitrate, latency: maxBitrate === rates[0] && codec === codecs[0] }));
}
if (!quick) {
  for (const hint of ['', 'motion', 'detail', 'text']) results.push(await scenario({ mode: 'new-exact', codec: 'VP9', maxBitrate: 800_000, hint }));
  for (const idleFrameMs of [33, 100, 250]) results.push(await scenario({ mode: 'new-exact', codec: 'VP9', maxBitrate: 800_000, idleFrameMs }));
}
writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 2));
const rows = results.map(r => `| ${r.name} | ${r.received ? `${r.received.width}x${r.received.height}` : '-'} | ${r.ssimY ?? '-'} | ${r.psnr ?? '-'} | ${r.stats?.outbound?.avgQp ?? '-'} | ${r.stats?.outbound?.qualityLimitationReason ?? '-'} | ${r.track?.contentHint || '-'} | ${r.change ? `${r.change.firstChangeMs} ms / ${r.change.receivedFramesFirstSecond} fps` : ''} | ${r.error || ''} |`);
writeFileSync(join(out, 'summary.md'), ['| scenario | received | SSIM-Y | PSNR-Y | avg QP | limit | hint | change latency / fps | error |', '|---|---|---|---|---|---|---|---|---|', ...rows].join('\n') + '\n');
log('wrote', out);
await browser.close();
server.close();
