import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createServer as createHttpsServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import WebSocket from 'ws';
import { buildBridge } from '../bin/bridge-build.mjs';
import { createBridgeLink } from '../src/bridge-link.mjs';
import { createBridgeMeetingWorker } from '../src/meet-bridge-worker.mjs';

// Branded Chrome no longer loads unpacked extensions from the command line; Chromium still does.
const extensionChrome = process.env.ROBOMEET_EXTENSION_CHROME || (existsSync('/snap/bin/chromium') ? '/snap/bin/chromium' : null);
// Snap Chromium can read only non-hidden paths in the home directory, so fixtures live under data/.
const dataRoot = fileURLToPath(new URL('../data/', import.meta.url));
const freePort = () => new Promise(resolve => { const server = createServer().listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); }); });

const appHtml = `<!doctype html><script>
const audio = new AudioContext();
const destination = audio.createMediaStreamDestination();
const tracks = {audio: destination.stream.getAudioTracks()[0]};
for (const role of ['camera','screen']) {
  const canvas = document.createElement('canvas'); canvas.width=64; canvas.height=64;
  const paint=()=>canvas.getContext('2d').fillRect(0,0,64,64); paint(); setInterval(paint,100);
  tracks[role] = canvas.captureStream(10).getVideoTracks()[0];
}
window.robotApp = {ready: audio.resume(), getOutgoingTracks:()=>tracks, setMeetingInput(){}, stopVoice(){}, setMode(){}};
</script>`;
const meetingHtml = `<!doctype html><input placeholder="Your name"><button id="join">Join now</button><script>
document.querySelector('#join').onclick=()=>{
  document.body.innerHTML='<button id="leave">Leave call</button><button id="present">Present now</button>';
  document.querySelector('#leave').onclick=()=>{document.body.innerText='You left the meeting';};
  document.querySelector('#present').onclick=async()=>{
    const stream=await navigator.mediaDevices.getDisplayMedia({video:true});
    const stop=document.createElement('button'); stop.innerText='Stop presenting';
    stop.onclick=()=>{stream.getTracks().forEach(t=>t.stop());stop.remove();}; document.body.append(stop);
  };
};
</script>`;

async function waitFor(predicate, timeout = 20_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('Fixture condition timed out');
}

test('bridge link accepts only the extension origin with the shared secret', async () => {
  const port = await freePort();
  const secret = 'a'.repeat(48);
  const link = createBridgeLink({ port, secret });
  await link.listening;
  try {
    const outcome = (origin, hello) => new Promise(resolve => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/bridge`, { origin });
      socket.on('unexpected-response', (_, response) => resolve(`http-${response.statusCode}`));
      socket.on('open', () => socket.send(JSON.stringify(hello)));
      socket.on('close', () => resolve('closed'));
      socket.on('error', () => {});
      setTimeout(() => resolve(link.connected() ? 'connected' : 'open'), 800);
    });
    assert.equal(await outcome('https://example.com', { type: 'hello', secret }), 'http-401');
    assert.equal(await outcome('chrome-extension://abc', { type: 'hello', secret: 'b'.repeat(48) }), 'closed');
    assert.equal(link.connected(), false);
    assert.equal(await outcome('chrome-extension://abc', { type: 'hello', secret }), 'connected');
  } finally { await link.close(); }
});

test('signed-in bridge worker joins through the extension, presents, isolates other Meet tabs and leaves', { skip: !extensionChrome && 'no Chromium that loads unpacked extensions', timeout: 120_000 }, async () => {
  const temporary = await mkdtemp(`${dataRoot}bridge-test-`);
  const port = await freePort();
  const secretFile = `${temporary}/secret`;
  const { out } = buildBridge({ out: `${temporary}/extension`, ports: [port], secretFile });
  const secret = (await readFile(secretFile, 'utf8')).trim();
  const originalLaunch = chromium.launch;
  const previousHeadless = process.env.ROBOMEET_HEADLESS;
  let worker;
  let extensionContext;
  // Extension-created windows bypass Playwright routing, so the fake Meet is served over local HTTPS
  // and Chromium resolves meet.google.com to it.
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${temporary}/key.pem`, '-out', `${temporary}/cert.pem`, '-days', '1', '-subj', '/CN=meet.google.com'], { stdio: 'ignore' });
  const meet = createHttpsServer({ key: await readFile(`${temporary}/key.pem`), cert: await readFile(`${temporary}/cert.pem`) }, (request, response) => { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end(meetingHtml); });
  await new Promise(resolve => meet.listen(0, '127.0.0.1', resolve));
  chromium.launch = async options => {
    const browser = await originalLaunch.call(chromium, options);
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async contextOptions => {
      const context = await newContext(contextOptions);
      await context.route('**/*', route => new URL(route.request().url()).hostname === 'localhost' ? route.fulfill({ contentType: 'text/html', body: appHtml }) : route.abort());
      return context;
    };
    return browser;
  };
  process.env.ROBOMEET_HEADLESS = '1';
  try {
    extensionContext = await chromium.launchPersistentContext(`${temporary}/profile`, {
      executablePath: extensionChrome, headless: false, env: { ...process.env, DISPLAY: process.env.DISPLAY || ':1' },
      ignoreDefaultArgs: ['--enable-automation', '--disable-extensions'],
      args: [`--load-extension=${out}`, `--disable-extensions-except=${out}`, '--window-size=900,700', `--host-resolver-rules=MAP meet.google.com 127.0.0.1:${meet.address().port}`, '--ignore-certificate-errors'],
      permissions: ['microphone', 'camera'],
    });
    const events = [];
    worker = createBridgeMeetingWorker({ baseUrl: 'http://localhost:4318', port, secret, account: '', connectTimeoutMs: 45_000, onEvent: event => events.push(event) });
    await worker.join({ url: 'https://meet.google.com/abc-defg-hij', name: 'RoboMeet AI' });
    await waitFor(() => { const status = worker.status(); assert.notEqual(status.status, 'error', `${status.error} | events: ${JSON.stringify(events.slice(-8))}`); return status.admitted; }, 60_000)
      .catch(async error => {
        const robotPage = extensionContext.pages().find(page => page.url().includes('#robomeet-robot='));
        const view = robotPage ? await robotPage.evaluate(() => ({ url: location.href.replace(/#.*/, ''), text: document.body.innerText.slice(0, 300), join: window.__robomeetAgent?.join('RoboMeet AI') })).catch(e => e.message) : 'no robot page';
        throw new Error(`${error.message} | status: ${JSON.stringify(worker.status())} | robot page: ${JSON.stringify(view)} | events: ${JSON.stringify(events.slice(-10))}`);
      });
    assert.equal(worker.status().status, 'joined');
    assert.ok(events.some(event => event.type === 'bridge-extension' && event.state === 'connected'));
    assert.ok(events.some(event => event.type === 'browser-profile' && event.mode === 'signed-in-bridge'));
    assert.ok(events.some(event => event.type === 'page-activation' && event.ok), `activation: ${JSON.stringify(events.filter(event => /activation|trusted/.test(event.type)))}`);
    assert.ok(events.some(event => event.type === 'admission-requested' && event.trusted), 'join clicked as real input');
    const robot = extensionContext.pages().find(page => page.url().includes('#robomeet-robot='));
    assert.ok(robot, 'robot window opened by the extension');
    assert.equal(await robot.evaluate(() => Boolean(window.RoboMeetMedia && window.__robomeetAgent)), true);
    await waitFor(async () => (await worker.diagnostics()).media?.bridge === 'connected', 20_000);
    await worker.setMode('listen');
    await worker.present({ enabled: true });
    assert.equal(worker.status().sharing, true);
    await worker.present({ enabled: false });
    assert.equal(worker.status().sharing, false);
    const diagnostics = await worker.diagnostics();
    assert.equal(diagnostics.media.input, 'no-input');
    assert.ok(diagnostics.media.cameraFrames > 0, 'robot camera frames flow through the bridge');
    // An ordinary Meet tab in the same browser must stay untouched.
    const ordinary = await extensionContext.newPage();
    await ordinary.goto('https://meet.google.com/xyz-abcd-efg');
    assert.deepEqual(await ordinary.evaluate(() => [typeof window.__robomeetAgent, typeof window.RoboMeetMedia, String(navigator.mediaDevices.getUserMedia).includes('[native code]')]), ['undefined', 'undefined', true]);
    await ordinary.close();
    await worker.leave();
    assert.equal(worker.status().status, 'ended');
    await waitFor(() => !extensionContext.pages().some(page => page.url().includes('#robomeet-robot=')), 10_000);
  } finally {
    await worker?.close();
    await extensionContext?.close();
    await new Promise(resolve => meet.close(resolve));
    chromium.launch = originalLaunch;
    if (previousHeadless === undefined) delete process.env.ROBOMEET_HEADLESS; else process.env.ROBOMEET_HEADLESS = previousHeadless;
    await rm(temporary, { recursive: true, force: true });
  }
});
