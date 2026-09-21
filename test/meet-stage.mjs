// src/meet-stage.js in headless Chrome, loaded like src/meet-worker-live.mjs does: meet-media.js, meet-live.js, then the stage.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { chromium } from 'playwright';

const source = name => readFile(new URL(`../src/${name}`, import.meta.url), 'utf8');
let browser;
let server;
let base;
let scripts;

before(async () => {
  scripts = { media: await source('meet-media.js'), live: await source('meet-live.js'), stage: await source('meet-stage.js') };
  server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    if (req.url.startsWith('/frame')) res.end('<!doctype html><title>inner frame</title>');
    else if (req.url.startsWith('/with-frame')) res.end('<!doctype html><title>RoboMeet stage fixture</title><iframe src="/frame"></iframe>');
    else res.end('<!doctype html><title>RoboMeet stage fixture</title>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
});
after(async () => {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
});

// `beforeStage` records the globals the stage wraps; `stageEvents` collects window.__robomeetStageEvent calls.
async function stagePage(path = '/', { live = true } = {}) {
  const page = await browser.newPage();
  await page.addInitScript({ content: `window.fixtureNativePC = window.RTCPeerConnection;\n${scripts.media}` });
  if (live) await page.addInitScript({ content: scripts.live });
  await page.addInitScript({ content: 'window.stageEvents = []; window.__robomeetStageEvent = data => { window.stageEvents.push({ ...data, receivedAt: Date.now() }); }; window.beforeStage = { getDisplayMedia: navigator.mediaDevices.getDisplayMedia, RTCPeerConnection: window.RTCPeerConnection };' });
  await page.addInitScript({ content: scripts.stage });
  await page.goto(base + path);
  return page;
}
// A PNG made in the page (public/slides is not in the repo), returned to Node as a Uint8Array.
// 'exact': a 1920x1080 view render, two colour halves and a 1-px checkerboard at (100..163, 100..163), so any
// resampling or offset shows. 'page': a picture in other colours, with dark "text lines".
function makePng({ width, height, kind, color }) {
  const canvas = new OffscreenCanvas(width, height);
  const c = canvas.getContext('2d');
  if (kind === 'solid') { c.fillStyle = color; c.fillRect(0, 0, width, height); }
  else if (kind === 'exact') {
    c.fillStyle = 'rgb(10,120,200)'; c.fillRect(0, 0, width / 2, height);
    c.fillStyle = 'rgb(230,40,60)'; c.fillRect(width / 2, 0, width / 2, height);
    for (let y = 100; y < 164; y++) for (let x = 100; x < 164; x++) { c.fillStyle = (x + y) % 2 ? '#fff' : '#000'; c.fillRect(x, y, 1, 1); }
  } else {
    c.fillStyle = 'rgb(40,200,90)'; c.fillRect(0, 0, width, height);
    c.fillStyle = 'rgb(20,20,20)';
    for (let y = 0; y < height; y += 60) c.fillRect(100, y, width - 200, 12);
  }
  return canvas.convertToBlob({ type: 'image/png' }).then(blob => blob.arrayBuffer()).then(buffer => new Uint8Array(buffer));
}
// Pixels of the current stage frame (RoboMeetStage.snapshot(), the pre-encode picture) at the given points.
function snapshotPixels(points) {
  return fetch(RoboMeetStage.snapshot()).then(response => response.blob()).then(createImageBitmap).then(bitmap => {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const c = canvas.getContext('2d', { willReadFrequently: true });
    c.drawImage(bitmap, 0, 0);
    return { width: bitmap.width, height: bitmap.height, pixels: points.map(([x, y]) => Array.from(c.getImageData(x, y, 1, 1).data.slice(0, 3))) };
  });
}
const framesOver = async (page, ms) => {
  const start = await page.evaluate(() => RoboMeetStage.health().frames);
  await page.waitForTimeout(ms);
  return (await page.evaluate(() => RoboMeetStage.health().frames)) - start;
};

test('stage installs only in the top frame (init scripts also run in iframes)', { timeout: 30_000 }, async () => {
  const page = await stagePage('/with-frame');
  try {
    const frame = page.frames().find(item => item !== page.mainFrame());
    assert(frame, 'fixture iframe loaded');
    assert.equal(await page.evaluate(() => typeof window.RoboMeetStage), 'object');
    assert.equal(await frame.evaluate(() => typeof window.RoboMeetMedia), 'object', 'init scripts do run in the iframe');
    assert.equal(await frame.evaluate(() => typeof window.RoboMeetStage), 'undefined');
  } finally { await page.context().close(); }
});

test('putAsset takes a Uint8Array, and a settled view with an exact render shows it 1:1', { timeout: 30_000 }, async () => {
  const page = await stagePage();
  try {
    const exact = await page.evaluate(makePng, { width: 1920, height: 1080, kind: 'exact' });
    const picture = await page.evaluate(makePng, { width: 2400, height: 3000, kind: 'page' });
    assert(exact instanceof Uint8Array && picture instanceof Uint8Array);
    const put = await page.evaluate(async ([exact, picture]) => ({
      exact: await RoboMeetStage.putAsset('exact', exact, 'image/png'),
      picture: await RoboMeetStage.putAsset('page', picture.buffer.slice(picture.byteOffset, picture.byteOffset + picture.byteLength)), // an ArrayBuffer
    }), [exact, picture]);
    assert.deepEqual(put, { exact: { id: 'exact', width: 1920, height: 1080 }, picture: { id: 'page', width: 2400, height: 3000 } });
    // base64 keeps working (src/stage-sync.mjs sends it); a Node Buffer reaches the page as a plain object and is refused.
    assert.deepEqual(await page.evaluate(data => RoboMeetStage.putAsset('b64', data), Buffer.from(exact).toString('base64')), { id: 'b64', width: 1920, height: 1080 });
    assert.equal(await page.evaluate(data => RoboMeetStage.putAsset('buffer', data).then(() => 'resolved', error => error.name), Buffer.from(exact)), 'TypeError');
    assert.deepEqual(await page.evaluate(() => RoboMeetStage.hasAssets(['exact', 'page', 'b64', 'buffer'])), ['exact', 'page', 'b64']);

    await page.evaluate(async () => {
      RoboMeetStage.setDeck({ title: 'fixture', slides: [{ kind: 'image', asset: 'page', views: [{ x: 0, y: 0, w: 1, h: 0.36, asset: 'exact' }] }] });
      await RoboMeetStage.show({ slide: 0, view: 0 });
    });
    await page.waitForTimeout(450); // a new deck fades in (P6)
    const points = [[0, 0], [959, 540], [960, 540], [1919, 1079], [100, 100], [101, 100], [150, 151], [163, 163]];
    const shot = await page.evaluate(snapshotPixels, points);
    assert.equal(shot.width, 1920);
    assert.equal(shot.height, 1080);
    const blue = [10, 120, 200], red = [230, 40, 60], black = [0, 0, 0], white = [255, 255, 255];
    assert.deepEqual(shot.pixels, [blue, blue, red, red, black, white, white, black]);
  } finally { await page.context().close(); }
});

test('a highlight fades in over the pixel-exact view render, never a resampled page', { timeout: 30_000 }, async () => {
  const page = await stagePage();
  try {
    const exact = await page.evaluate(makePng, { width: 1920, height: 1080, kind: 'exact' });
    const picture = await page.evaluate(makePng, { width: 2400, height: 3000, kind: 'page' });
    await page.evaluate(async ([exact, picture]) => { await RoboMeetStage.putAsset('exact', exact); await RoboMeetStage.putAsset('page', picture); }, [exact, picture]);
    // Highlight box in page coordinates -> stage pixels: x 0.6*1920 = 1152, y 0.1*(1080/0.36) = 300 (pad 14 -> stroke at x 1138).
    const points = [[100, 100], [101, 100], [150, 151], [163, 163], [1138, 375]];
    // The picture is on screen first; the highlight then arrives as the same deck with a box (how a pointer lands).
    await page.evaluate(async () => { RoboMeetStage.setDeck({ title: 'fixture', slides: [{ kind: 'image', asset: 'page', views: [{ x: 0, y: 0, w: 1, h: 0.36, asset: 'exact' }] }] }); await RoboMeetStage.show({ slide: 0, view: 0 }); });
    await page.waitForTimeout(450);
    const shownAt = await page.evaluate(async () => {
      RoboMeetStage.setDeck({ title: 'fixture', slides: [{ kind: 'image', asset: 'page', views: [{ x: 0, y: 0, w: 1, h: 0.36, asset: 'exact', highlight: { x: 0.6, y: 0.1, w: 0.2, h: 0.05 } }] }] });
      return (await RoboMeetStage.show({ slide: 0, view: 0 })).changedAt;
    });
    const during = await page.evaluate(snapshotPixels, points);
    const age = await page.evaluate(at => Date.now() - at, shownAt);
    assert(age < 300, `snapshot taken inside the 320 ms fade (${age} ms)`);
    const black = [0, 0, 0], white = [255, 255, 255];
    assert.deepEqual(during.pixels.slice(0, 4), [black, white, white, black], `checkerboard exact during the fade: ${JSON.stringify(during.pixels)}`);
    await page.waitForTimeout(500);
    const settled = await page.evaluate(snapshotPixels, points);
    assert.deepEqual(settled.pixels.slice(0, 4), [black, white, white, black], 'and after it');
    const [r, g, b] = settled.pixels[4];
    assert(r > 200 && g > 120 && b < 80, `highlight stroke drawn at full strength: ${settled.pixels[4]}`);
  } finally { await page.context().close(); }
});

test('TC-P3a: a highlight added to the view on screen shows within 300 ms without moving the picture', { timeout: 30_000 }, async () => {
  const page = await stagePage();
  try {
    const exact = await page.evaluate(makePng, { width: 1920, height: 1080, kind: 'exact' });
    const picture = await page.evaluate(makePng, { width: 2400, height: 3000, kind: 'page' });
    await page.evaluate(async ([exact, picture]) => { await RoboMeetStage.putAsset('exact', exact); await RoboMeetStage.putAsset('page', picture); }, [exact, picture]);
    const view = { x: 0, y: 0, w: 1, h: 0.36, asset: 'exact' };
    await page.evaluate(async view => { RoboMeetStage.setDeck({ title: 't', slides: [{ kind: 'image', asset: 'page', views: [view] }] }); await RoboMeetStage.show({ slide: 0, view: 0 }); }, view);
    await page.waitForTimeout(500);
    const points = [[100, 100], [101, 100], [1138, 375]];
    const before = await page.evaluate(snapshotPixels, points);
    // What stage-sync does when the server adds a pointer: the same deck with a highlight on the current view.
    const at = await page.evaluate(async view => { RoboMeetStage.setDeck({ title: 't', slides: [{ kind: 'image', asset: 'page', views: [{ ...view, highlight: { x: 0.6, y: 0.1, w: 0.2, h: 0.05 } }] }] }); return (await RoboMeetStage.show({ slide: 0, view: 0 })).changedAt; }, view);
    await page.waitForTimeout(Math.max(0, 300 - (Date.now() - at)));
    const after = await page.evaluate(snapshotPixels, points);
    assert.deepEqual(after.pixels.slice(0, 2), before.pixels.slice(0, 2), 'the picture did not move');
    const [r, g, b] = after.pixels[2];
    assert(r > 200 && g > 120 && b < 80, `box stroke visible by 300 ms: ${after.pixels[2]}`);
  } finally { await page.context().close(); }
});

test('TC-P6: a new deck fades in over several frames; a highlight-only change keeps the position so a move still scrolls', { timeout: 30_000 }, async () => {
  const page = await stagePage();
  try {
    const picture = await page.evaluate(makePng, { width: 2400, height: 3000, kind: 'page' });
    await page.evaluate(async picture => { await RoboMeetStage.putAsset('page', picture); }, picture);
    const views = [{ x: 0, y: 0, w: 1, h: 0.36 }, { x: 0, y: 0.5, w: 1, h: 0.36 }];
    const first = await page.evaluate(async views => { RoboMeetStage.setDeck({ title: 't', slides: [{ kind: 'image', asset: 'page', views }] }); return RoboMeetStage.show({ slide: 0, view: 0 }); }, views);
    assert.equal(first.kind, 'fade', 'a new deck fades in, it does not cut');
    await page.waitForTimeout(450);
    const restyle = await page.evaluate(async views => { RoboMeetStage.setDeck({ title: 't', slides: [{ kind: 'image', asset: 'page', views: [{ ...views[0], highlight: { x: 0.1, y: 0.1, w: 0.2, h: 0.05 } }, views[1]] }] }); return RoboMeetStage.show({ slide: 0, view: 0 }); }, views);
    assert.equal(restyle.kind, 'restyle');
    await page.waitForTimeout(400);
    // the pointer is cleared and the screen moves in the same step, as the presenter's next does
    const moved = await page.evaluate(async views => { RoboMeetStage.setDeck({ title: 't', slides: [{ kind: 'image', asset: 'page', views }] }); return RoboMeetStage.show({ slide: 0, view: 1 }); }, views);
    assert.equal(moved.kind, 'move', 'a scroll, not a cut');
    assert.ok(await framesOver(page, 500) >= 10, 'the scroll paints many frames');
  } finally { await page.context().close(); }
});

test('senders() and the sender log also find a presentation Meet sends through a track of its own', { timeout: 45_000 }, async () => {
  const page = await stagePage();
  try {
    await page.evaluate(async () => {
      const clone = (await navigator.mediaDevices.getDisplayMedia({ video: true })).getVideoTracks()[0];
      // Meet's own track: the clone's frames through a processor/generator pair (the hint does not survive that),
      // which Meet then marks as screen content itself.
      const generator = new MediaStreamTrackGenerator({ kind: 'video' });
      new MediaStreamTrackProcessor({ track: clone }).readable.pipeTo(generator.writable).catch(() => {});
      generator.contentHint = 'detail';
      const camera = document.createElement('canvas');
      camera.width = 320; camera.height = 180;
      const painter = camera.getContext('2d');
      window.cameraTimer = setInterval(() => { painter.fillStyle = `hsl(${Date.now() % 360} 60% 50%)`; painter.fillRect(0, 0, 320, 180); }, 100);
      const tx = new RTCPeerConnection();
      const rx = new RTCPeerConnection();
      tx.onicecandidate = event => event.candidate && rx.addIceCandidate(event.candidate);
      rx.onicecandidate = event => event.candidate && tx.addIceCandidate(event.candidate);
      const screen = tx.addTransceiver(generator, { direction: 'sendonly' });
      tx.addTransceiver(camera.captureStream(10).getVideoTracks()[0], { direction: 'sendonly' });
      await tx.setLocalDescription();
      await rx.setRemoteDescription(tx.localDescription);
      await rx.setLocalDescription();
      await tx.setRemoteDescription(rx.localDescription);
      window.loop = { tx, rx, screen };
    });
    let found = [];
    for (const deadline = Date.now() + 15_000; Date.now() < deadline; await page.waitForTimeout(250)) {
      found = await page.evaluate(() => RoboMeetStage.senders());
      if (found.some(item => item.matchedBy === 'contentType')) break;
    }
    assert.equal(found.length, 1, `only the presentation sender: ${JSON.stringify(found)}`);
    assert.equal(found[0].matchedBy, 'contentType');
    const logged = await page.evaluate(async () => {
      const params = loop.screen.sender.getParameters();
      params.degradationPreference = 'maintain-resolution';
      await loop.screen.sender.setParameters(params);
      return RoboMeetStage.health().senderLog.at(-1);
    });
    assert.equal(logged?.matchedBy, 'contentType', JSON.stringify(logged));
    assert.equal(logged.degradationPreference, 'maintain-resolution');
    await page.evaluate(() => { clearInterval(cameraTimer); loop.tx.close(); loop.rx.close(); });
  } finally { await page.context().close(); }
});

test('a slide change during a crossfade fades on from the half-blended frame, never cutting to the halfway target', { timeout: 30_000 }, async () => {
  const page = await stagePage();
  try {
    for (const [id, color] of [['a', 'rgb(0,0,255)'], ['b', 'rgb(255,0,0)'], ['c', 'rgb(0,255,0)']]) {
      const png = await page.evaluate(makePng, { width: 1920, height: 1080, kind: 'solid', color });
      await page.evaluate(([id, png]) => RoboMeetStage.putAsset(id, png), [id, png]);
    }
    await page.evaluate(async () => {
      RoboMeetStage.setDeck({ title: 'fades', slides: ['a', 'b', 'c'].map(asset => ({ kind: 'image', asset, views: [{ x: 0, y: 0, w: 1, h: 1 }] })) });
      await RoboMeetStage.show({ slide: 0, view: 0 });
      await new Promise(resolve => setTimeout(resolve, 450)); // the new deck has faded in (P6)
      await RoboMeetStage.show({ slide: 1, view: 0, transitionMs: 600 }); // blue -> red
    });
    await page.waitForTimeout(280); // about halfway
    await page.evaluate(() => RoboMeetStage.show({ slide: 2, view: 0, transitionMs: 600 })); // -> green, mid-fade
    const [[r, g, b]] = (await page.evaluate(snapshotPixels, [[960, 540]])).pixels;
    assert(b > 40 && r < 235, `the first frame is still a blue/red blend, not pure red: ${[r, g, b]}`);
    assert(g < 80, `and the new fade to green has only begun: ${[r, g, b]}`);
  } finally { await page.context().close(); }
});

test('motion frames of fit-width views sample the 1920-wide copy with low smoothing; zoomed ones the full picture', { timeout: 30_000 }, async () => {
  const page = await stagePage();
  try {
    const picture = await page.evaluate(makePng, { width: 2400, height: 3000, kind: 'page' });
    await page.evaluate(async picture => {
      await RoboMeetStage.putAsset('page', picture);
      RoboMeetStage.setDeck({ slides: [{ kind: 'image', asset: 'page', views: [{ x: 0, y: 0, w: 1, h: 0.36 }, { x: 0, y: 0.5, w: 1, h: 0.36 }, { x: 0.25, y: 0.3, w: 0.5, h: 0.18 }] }] });
      await RoboMeetStage.show({ slide: 0, view: 0 });
      // Every picture the stage draws onto its 1920x1080 canvases, with the smoothing it used.
      window.draws = [];
      const drawImage = CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage = function (image, ...rest) {
        if (image instanceof ImageBitmap && this.canvas.width === 1920) window.draws.push({ w: image.width, h: image.height, quality: this.imageSmoothingQuality });
        return drawImage.call(this, image, ...rest);
      };
    }, picture);
    const move = async view => {
      await page.evaluate(view => { window.draws = []; return RoboMeetStage.show({ slide: 0, view, transitionMs: 400 }); }, view);
      await page.waitForFunction(() => !RoboMeetStage.health().moving, undefined, { timeout: 5000 });
      await page.waitForTimeout(150);
      return page.evaluate(() => window.draws);
    };
    const scroll = await move(1); // fit-width -> fit-width
    const motion = scroll.filter(draw => draw.quality !== 'high');
    assert(motion.length >= 3, `painted motion frames: ${motion.length}`);
    assert(motion.every(draw => draw.w === 1920 && draw.h === 2400 && draw.quality === 'low'), JSON.stringify(motion.slice(0, 3)));
    assert.deepEqual(scroll.at(-1), { w: 2400, h: 3000, quality: 'high' }, 'settled frame: full picture, high smoothing');

    const zoom = await move(2); // fit-width -> half-width zoom
    const zoomMotion = zoom.filter(draw => draw.quality !== 'high');
    assert(zoomMotion.some(draw => draw.w === 2400 && draw.quality === 'medium'), 'zoomed motion frames use the full picture');
    assert(zoomMotion.every(draw => (draw.w === 1920 && draw.quality === 'low') || (draw.w === 2400 && draw.quality === 'medium')), JSON.stringify(zoomMotion));
    assert.deepEqual(zoom.at(-1), { w: 2400, h: 3000, quality: 'high' });
  } finally { await page.context().close(); }
});

test('getDisplayMedia hands Meet a 1920x1080 detail clone; frames run at 1 fps unshared, 10 fps shared', { timeout: 30_000 }, async () => {
  const page = await stagePage();
  try {
    await page.waitForTimeout(400);
    const unshared = await framesOver(page, 2000);
    assert(unshared <= 3, `frames in 2 s while not sharing: ${unshared}`);
    const shared = await page.evaluate(async () => {
      window.clone = (await navigator.mediaDevices.getDisplayMedia({ video: true })).getVideoTracks()[0];
      const { width, height, displaySurface } = clone.getSettings();
      return { width, height, displaySurface, contentHint: clone.contentHint, health: RoboMeetStage.health(), events: stageEvents.filter(item => item.type === 'stage-sharing') };
    });
    assert.deepEqual([shared.width, shared.height, shared.displaySurface, shared.contentHint], [1920, 1080, 'browser', 'detail']);
    assert.equal(shared.health.sharing, true);
    assert.equal(shared.health.liveClones, 1);
    assert.equal(shared.health.displayRequests, 1);
    assert.deepEqual(shared.events.map(item => [item.sharing, item.liveClones, typeof item.at]), [[true, 1, 'number']]);
    const sharing = await framesOver(page, 1500);
    // 10 fps idle; a 33 ms tick against a strict 100 ms threshold gave 7.6 fps (11 frames), so require 13.
    assert(sharing >= 13 && sharing <= 18, `frames in 1.5 s while sharing: ${sharing}`);
    const instance = shared.health.instance;
    assert(typeof instance === 'string' && instance.length >= 8);
    await page.reload();
    const reloaded = await page.evaluate(() => RoboMeetStage.health());
    assert.notEqual(reloaded.instance, instance, 'a reload gets a new instance id');
    assert.equal(reloaded.sharing, false);
  } finally { await page.context().close(); }
});

test('sharing follows the clones: stop() ends it at once, endShare() ends and fires ended, a dead clone is seen by the frame timer', { timeout: 30_000 }, async () => {
  const page = await stagePage();
  try {
    const result = await page.evaluate(async () => {
      const present = async () => (await navigator.mediaDevices.getDisplayMedia({ video: true })).getVideoTracks()[0];
      const sharingEvents = () => stageEvents.filter(item => item.type === 'stage-sharing').map(item => [item.sharing, item.liveClones]);
      const first = await present();
      const started = RoboMeetStage.health().sharing;
      first.stop(); // what Meet does when it stops presenting
      const afterStop = { sharing: RoboMeetStage.health().sharing, liveClones: RoboMeetStage.health().liveClones, events: sharingEvents() };
      const second = await present();
      let endedFired = 0;
      second.addEventListener('ended', () => endedFired++);
      const ended = RoboMeetStage.endShare();
      return { started, afterStop, ended, secondState: second.readyState, endedFired, sharing: RoboMeetStage.health().sharing, events: sharingEvents(), shareEnded: stageEvents.filter(item => item.type === 'stage-share-ended').map(item => item.clones) };
    });
    assert.equal(result.started, true);
    assert.deepEqual(result.afterStop, { sharing: false, liveClones: 0, events: [[true, 1], [false, 0]] });
    assert.equal(result.ended, 1);
    assert.equal(result.secondState, 'ended');
    assert.equal(result.endedFired, 1);
    assert.equal(result.sharing, false);
    assert.deepEqual(result.events, [[true, 1], [false, 0], [true, 1], [false, 0]]);
    assert.deepEqual(result.shareEnded, [1]);
    // A clone that ends without its wrapped stop() (native stop, as if its source ended): caught by the readyState check.
    await page.evaluate(async () => { window.third = (await navigator.mediaDevices.getDisplayMedia({ video: true })).getVideoTracks()[0]; MediaStreamTrack.prototype.stop.call(third); });
    await page.waitForFunction(() => RoboMeetStage.health().sharing === false, undefined, { timeout: 2000 });
    assert.deepEqual(await page.evaluate(() => stageEvents.filter(item => item.type === 'stage-sharing').slice(-2).map(item => [item.sharing, item.liveClones])), [[true, 1], [false, 0]]);
  } finally { await page.context().close(); }
});

test('stats() reads the outbound-rtp of the clone Meet sends, and the layers below still see Meet peers', { timeout: 45_000 }, async () => {
  const page = await stagePage();
  try {
    await page.evaluate(async () => {
      const clone = (await navigator.mediaDevices.getDisplayMedia({ video: true })).getVideoTracks()[0];
      const other = document.createElement('canvas'); // a second video track that is not the stage: must not be reported
      other.width = 320; other.height = 180;
      const painter = other.getContext('2d');
      window.otherTimer = setInterval(() => { painter.fillStyle = `hsl(${Date.now() % 360} 60% 50%)`; painter.fillRect(0, 0, 320, 180); }, 100);
      const audio = new AudioContext();
      const oscillator = audio.createOscillator();
      const tone = audio.createMediaStreamDestination();
      oscillator.connect(tone);
      oscillator.start();
      const tx = new RTCPeerConnection(); // plays Meet's sending peer
      const rx = new RTCPeerConnection(); // plays the remote side
      tx.onicecandidate = event => event.candidate && rx.addIceCandidate(event.candidate);
      rx.onicecandidate = event => event.candidate && tx.addIceCandidate(event.candidate);
      tx.addTransceiver(clone, { direction: 'sendonly' });
      tx.addTransceiver(other.captureStream(10).getVideoTracks()[0], { direction: 'sendonly' });
      tx.addTransceiver(tone.stream.getAudioTracks()[0], { direction: 'sendonly' });
      await tx.setLocalDescription();
      await rx.setRemoteDescription(tx.localDescription);
      await rx.setLocalDescription();
      await tx.setRemoteDescription(rx.localDescription);
      window.loop = { tx, rx, audio };
    });
    let reports = [];
    for (const deadline = Date.now() + 15_000; Date.now() < deadline; await page.waitForTimeout(250)) {
      reports = await page.evaluate(() => RoboMeetStage.stats());
      if (reports.some(report => report.frameWidth === 1920 && report.contentType)) break;
    }
    assert.equal(reports.length, 1, `only the stage clone is reported: ${JSON.stringify(reports)}`);
    const [report] = reports;
    assert.equal(report.frameWidth, 1920, JSON.stringify(report));
    assert.equal(report.frameHeight, 1080);
    assert.equal(report.contentType, 'screenshare');
    assert.match(report.codec, /^video\//);
    assert(report.bytesSent > 0);
    const layers = await page.evaluate(async () => ({ media: (await RoboMeetMedia.publicationStats()).length, mediaInputs: RoboMeetMedia.health().inputTracks, liveInputs: RoboMeetLive.health().inputTracks }));
    assert.deepEqual(layers, { media: 2, mediaInputs: 1, liveInputs: 1 }, 'meet-media.js and meet-live.js proxies still see both peers and the received audio');
    await page.evaluate(() => { loop.tx.close(); loop.rx.close(); });
    assert.deepEqual(await page.evaluate(() => RoboMeetStage.stats()), [], 'closed peers are dropped');
  } finally { await page.context().close(); }
});

test('close() restores getDisplayMedia and RTCPeerConnection; a kept wrapper then delegates to what it wrapped', { timeout: 30_000 }, async () => {
  const page = await stagePage();
  try {
    const result = await page.evaluate(async () => {
      const stale = navigator.mediaDevices.getDisplayMedia;
      const clone = (await stale({ video: true })).getVideoTracks()[0];
      RoboMeetStage.close();
      const restored = { getDisplayMedia: navigator.mediaDevices.getDisplayMedia === beforeStage.getDisplayMedia, RTCPeerConnection: window.RTCPeerConnection === beforeStage.RTCPeerConnection };
      const delegated = (await stale({ video: true })).getVideoTracks()[0];
      const afterDelegation = RoboMeetStage.health();
      RoboMeetLive.close();
      RoboMeetMedia.close();
      const closedError = await stale({ video: true }).then(() => null, error => error.name);
      return {
        restored, cloneState: clone.readyState, delegatedLive: delegated.readyState === 'live', delegatedWidth: delegated.getSettings().width,
        displayRequests: afterDelegation.displayRequests, sharing: afterDelegation.sharing,
        lastSharing: stageEvents.filter(item => item.type === 'stage-sharing').at(-1)?.sharing, closedError, native: window.RTCPeerConnection === fixtureNativePC,
      };
    });
    assert.deepEqual(result.restored, { getDisplayMedia: true, RTCPeerConnection: true });
    assert.equal(result.cloneState, 'ended');
    assert.equal(result.sharing, false);
    assert.equal(result.lastSharing, false, 'closing while shared reports the share ended');
    assert.equal(result.delegatedLive, true, "after close the kept wrapper returns meet-media.js's own screen track");
    assert.equal(result.delegatedWidth, 1280, "meet-media.js screen canvas, not the 1920 stage");
    assert.equal(result.displayRequests, 1, 'the stage handed out nothing after close');
    assert.equal(result.closedError, 'InvalidStateError', 'once meet-media.js is closed too, it throws like meet-media.js');
    assert.equal(result.native, true, 'layers restored in reverse order end at the native constructor');
  } finally { await page.context().close(); }
  // Something installed after the stage stays installed.
  const page2 = await stagePage('/', { live: false });
  try {
    const kept = await page2.evaluate(() => {
      const laterPC = new Proxy(window.RTCPeerConnection, {});
      const laterGDM = async () => null;
      window.RTCPeerConnection = laterPC;
      navigator.mediaDevices.getDisplayMedia = laterGDM;
      RoboMeetStage.close();
      return { RTCPeerConnection: window.RTCPeerConnection === laterPC, getDisplayMedia: navigator.mediaDevices.getDisplayMedia === laterGDM };
    });
    assert.deepEqual(kept, { RTCPeerConnection: true, getDisplayMedia: true }, 'close() only restores globals that are still the stage\'s');
  } finally { await page2.context().close(); }
});

test('meeting audio from the other participants is reported as stage-input onset and end', { timeout: 30_000 }, async () => {
  const page = await stagePage('/', { live: false });
  try {
    const result = await page.evaluate(async () => {
      const start = Date.now();
      window.fakeLive = { lastInputAudibleAt: null };
      window.RoboMeetLive = { health: () => window.fakeLive };
      await new Promise(resolve => { const timer = setInterval(() => { fakeLive.lastInputAudibleAt = Date.now(); if (Date.now() - start >= 400) { clearInterval(timer); resolve(); } }, 20); });
      const lastHeard = fakeLive.lastInputAudibleAt;
      await new Promise(resolve => setTimeout(resolve, 1100));
      return { lastHeard, input: stageEvents.filter(item => item.type === 'stage-input'), health: RoboMeetStage.health().input };
    });
    assert.deepEqual(result.input.map(item => item.phase), ['onset', 'end']);
    assert.equal(result.input[1].at, result.lastHeard);
    assert.equal(result.health.speaking, false);
  } finally { await page.context().close(); }
});

test('configure({ speechEndMs: 350 }) is honoured by the speech watcher', { timeout: 30_000 }, async () => {
  const page = await stagePage('/', { live: false });
  try {
    const result = await page.evaluate(async () => {
      const tune = RoboMeetStage.configure({ speechEndMs: 350 });
      const start = Date.now();
      // Stands in for src/meet-live.js health(): audible output for 400 ms, refreshed every 20 ms like its meter.
      window.fakeLive = { outputOnsetAt: start, lastOutputAudibleAt: start };
      window.RoboMeetLive = { health: () => window.fakeLive };
      await new Promise(resolve => { const timer = setInterval(() => { fakeLive.lastOutputAudibleAt = Date.now(); if (Date.now() - start >= 400) { clearInterval(timer); resolve(); } }, 20); });
      const lastAudible = fakeLive.lastOutputAudibleAt;
      await new Promise(resolve => setTimeout(resolve, 1200));
      return { speechEndMs: tune.speechEndMs, start, lastAudible, speech: stageEvents.filter(item => item.type === 'stage-speech'), health: RoboMeetStage.health().speech };
    });
    assert.equal(result.speechEndMs, 350);
    assert.deepEqual(result.speech.map(item => item.phase), ['onset', 'end']);
    assert.equal(result.speech[0].at, result.start);
    assert.equal(result.speech[1].at, result.lastAudible);
    const detectedAfter = result.speech[1].receivedAt - result.lastAudible;
    assert(detectedAfter >= 350 && detectedAfter < 700, `end detected ${detectedAfter} ms after the last audible output (default 800 would be >= 800)`);
    assert.deepEqual(result.health, { speaking: false, onsetAt: result.start, endAt: result.lastAudible });
  } finally { await page.context().close(); }
});
