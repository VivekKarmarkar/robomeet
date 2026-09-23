// TC-S1..S3: the simulated participant and the animated faces.
// S1: Alex's session request is rewritten to her persona, with no tools, and nothing else is touched.
// S2: the face hook swaps the camera Meet gets for the face, and the mouth follows the voice Meet sends.
// S3: the face can be stepped deterministically from measured bands, for offline rendering.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { personaFetch } from '../src/participant-live.mjs';

const ROOT = new URL('../', import.meta.url).pathname;
const { chromium } = createRequire(ROOT + 'package.json')('playwright');
const CHROME = process.env.ROBOMEET_CHROME_PATH || '/usr/bin/google-chrome';

test('TC-S1: the persona replaces the instructions, voice and tools of the session request only', async () => {
  const seen = [];
  const f = personaFetch(async (url, options) => { seen.push({ url, options }); return { ok: true }; }, { instructions: 'You are Alex.', voice: 'cedar' });
  const session = { model: 'gpt-live-1', instructions: 'You are Vivek Bot.', audio: { output: { voice: 'marin' } }, delegation: { type: 'responses', responses: { model: 'gpt-5.6-sol', tools: [{ name: 'scroll' }, { name: 'point_at' }] } } };
  await f('https://api.openai.com/v1/live/sessions', { method: 'POST', body: JSON.stringify({ session, transport: { type: 'webrtc', sdp: 'SDP' } }) });
  const body = JSON.parse(seen[0].options.body);
  assert.equal(body.session.instructions, 'You are Alex.');
  assert.equal(body.session.audio.output.voice, 'cedar');
  assert.deepEqual(body.session.delegation.responses.tools, [], 'a persona can never act in the meeting');
  assert.equal(body.session.delegation.responses.tool_choice, 'none');
  assert.equal(body.session.model, 'gpt-live-1', 'the model is kept');
  assert.equal(body.transport.sdp, 'SDP', 'the transport is kept');
  await f('https://api.openai.com/v1/live/sessions/x/accept', { method: 'POST', body: '{"a":1}' });
  await f('https://api.openai.com/v1/live/sessions', { method: 'GET' });
  assert.equal(seen[1].options.body, '{"a":1}', 'other requests pass through untouched');
  assert.equal(seen[2].options.body, undefined);
});

async function page(t) {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--autoplay-policy=no-user-gesture-required'] });
  t.after(() => browser.close());
  const p = await browser.newPage();
  await p.route('https://robomeet.test/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body></body></html>' }));
  return p;
}

test('TC-S2: the face hook sends the face as the camera, and its mouth follows the voice Meet sends', async t => {
  const p = await page(t);
  // Stand-ins for meet-media.js + meet-live.js: an oscillator "voice" and a plain camera track.
  await p.addInitScript(() => {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator(), gain = ctx.createGain(); gain.gain.value = 0;
    const dest = ctx.createMediaStreamDestination(); osc.connect(gain); gain.connect(dest); osc.start();
    Object.assign(window, { __gain: gain, __ctx: ctx });
    const plain = document.createElement('canvas').captureStream(5).getVideoTracks()[0];
    navigator.mediaDevices.getUserMedia = async c => new MediaStream([...(c?.audio ? dest.stream.getAudioTracks() : []), ...(c?.video ? [plain] : [])]);
    window.RoboMeetLive = { health: () => ({ lastInputAudibleAt: 0 }) };
  });
  await p.addInitScript(cfg => { window.__robomeetFaceConfig = cfg; }, { character: 'human', name: 'Alex' });
  await p.addInitScript({ path: `${ROOT}src/face.js` });
  await p.addInitScript({ path: `${ROOT}src/meet-face-hook.js` });
  await p.goto('https://robomeet.test/');
  const r = await p.evaluate(async () => {
    await window.__ctx.resume();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    const wait = ms => new Promise(res => setTimeout(res, ms));
    const open = () => window.RoboMeetFaceHook.health().face.open;
    await wait(500); const silent = open();
    window.__gain.gain.value = 0.6; await wait(600); const speaking = open();
    window.__gain.gain.value = 0; await wait(900); const after = open();
    const settings = stream.getVideoTracks()[0].getSettings();
    const hook = window.RoboMeetFaceHook.health();
    window.RoboMeetFaceHook.close();
    // Behaviour, not source text: after close() the camera is the plain track again (a 300x150 canvas), not the face.
    const again = (await navigator.mediaDevices.getUserMedia({ video: true })).getVideoTracks()[0].getSettings();
    return { videoTracks: stream.getVideoTracks().length, width: settings.width, height: settings.height, silent, speaking, after, hook, restored: again.width !== 1280 };
  });
  assert.equal(r.videoTracks, 1, 'exactly one camera track');
  assert.deepEqual([r.width, r.height], [1280, 720], 'it is the face canvas');
  assert.equal(r.hook.swapped, 1); assert.equal(r.hook.tapped, true); assert.equal(r.hook.character, 'human');
  assert.ok(r.silent < 0.05, `closed while silent (${r.silent})`);
  assert.ok(r.speaking > 0.3, `open while the voice plays (${r.speaking})`);
  assert.ok(r.after < 0.1, `closed again after (${r.after})`);
  assert.equal(r.restored, true, 'close() puts the wrapped getUserMedia back');
});

test('TC-S3: stepped offline, the face opens on measured speech and closes on silence', async t => {
  const p = await page(t);
  await p.goto('https://robomeet.test/');
  await p.addScriptTag({ path: `${ROOT}src/face.js` });
  const r = await p.evaluate(() => {
    const f = window.RoboMeetFace.create({ character: 'robot' });
    f.stop();
    const run = (level, low, n) => { for (let i = 0; i < n; i++) { f.setBands(level, low); f.advance(1 / 25); } return f.state(); };
    return { rest: run(0, 0.5, 10).open, talk: run(0.9, 0.8, 10), quiet: run(0, 0.5, 20).open };
  });
  assert.ok(r.rest < 0.02);
  assert.ok(r.talk.open > 0.5, 'loud speech opens the mouth');
  assert.ok(r.talk.round > 0.5, 'low-band speech rounds it');
  assert.ok(r.quiet < 0.05, 'and silence closes it');
});
