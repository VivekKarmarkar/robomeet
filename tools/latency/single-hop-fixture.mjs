// Fixture test for meet-live.js layered over the UNCHANGED src/meet-media.js, in headless Chrome, no server, no OpenAI.
// Intended destination once adopted: test/meet-live.mjs (new file), in the style of test/meet-media.mjs.
//   human PC (native)  --loopback-->  meet PC (through both proxies, like Google Meet's own peer)  -> both mixes
//   RoboMeetLive.createOffer()  -> fixture "model" PC (native) answers with its own tone (stands in for GPT Live)
// Asserts: (1) the meeting tone reaches the model-bound track; (2) Meet's captured microphone is silent in listen
// mode and carries the model tone in speak mode; (3) the model tone never re-enters the model-bound mix;
// (4) meet-media.js keeps working underneath (health(), getUserMedia video); (5) close() restores the globals in order.
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
const require = createRequire(new URL('../../package.json', import.meta.url));
const { chromium } = require('playwright');
const mediaScript = await readFile(new URL('../../src/meet-media.js', import.meta.url), 'utf8');
const liveScript = await readFile(new URL('../../src/meet-live.js', import.meta.url), 'utf8');
const out = fileURLToPath(new URL('./meet-live-fixture-result.json', import.meta.url));
const report = { at: new Date().toISOString(), checks: [], errors: [] };
const check = (name, ok, detail) => { report.checks.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`); };
const server = createServer((_req, res) => res.end('<!doctype html><title>RoboMeet single-hop fixture</title>'));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.ROBOMEET_CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  page.on('pageerror', error => report.errors.push(`page: ${error.message}`));
  // Same order as the proposed worker: meet-media.js first, meet-live.js second.
  await page.addInitScript({ content: `window.fixtureNativePC = window.RTCPeerConnection;\n${mediaScript}\n${liveScript}` });
  await page.goto(`http://127.0.0.1:${server.address().port}`);

  const setup = await page.evaluate(async () => {
    const fx = window.fixture = { audio: new AudioContext(), events: [] };
    window.__robomeetLiveEvent = data => fx.events.push(data);
    await fx.audio.resume();
    fx.gum = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    fx.waitIce = peer => new Promise(resolve => { if (peer.iceGatheringState === 'complete') return resolve(); const t = setTimeout(resolve, 2000); peer.addEventListener('icegatheringstatechange', () => { if (peer.iceGatheringState === 'complete') { clearTimeout(t); resolve(); } }); });
    fx.tone = frequency => { const o = fx.audio.createOscillator(); o.frequency.value = frequency; const g = fx.audio.createGain(); g.gain.value = 0.1; const d = fx.audio.createMediaStreamDestination(); o.connect(g).connect(d); o.start(); return d.stream.getAudioTracks()[0]; };
    // Dominant frequency (Hz) and RMS of a track, sampled after `ms` milliseconds.
    fx.analyse = (track, ms = 1500) => new Promise(resolve => {
      const el = document.createElement('audio'); el.muted = true; el.srcObject = new MediaStream([track]); el.play().catch(() => {});
      const source = fx.audio.createMediaStreamSource(new MediaStream([track]));
      const analyser = fx.audio.createAnalyser(); analyser.fftSize = 4096;
      const mute = fx.audio.createGain(); mute.gain.value = 0;
      source.connect(analyser).connect(mute).connect(fx.audio.destination);
      setTimeout(() => {
        const time = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(time);
        const rms = Math.sqrt(time.reduce((s, x) => s + x * x, 0) / time.length);
        const freq = new Float32Array(analyser.frequencyBinCount); analyser.getFloatFrequencyData(freq);
        let best = 0; for (let i = 1; i < freq.length; i++) if (freq[i] > freq[best]) best = i;
        const hz = Math.round(best * fx.audio.sampleRate / analyser.fftSize);
        const at = h => { const bin = Math.round(h * analyser.fftSize / fx.audio.sampleRate); return Math.round(Math.max(freq[bin - 1], freq[bin], freq[bin + 1])); };
        source.disconnect(); el.pause(); el.srcObject = null;
        resolve({ rms: Math.round(rms * 10000) / 10000, dominantHz: hz, db440: at(440), db880: at(880) });
      }, ms);
    });
    // A "human" participant (native peer) sending 440 Hz into a "Meet" peer built through both proxies.
    fx.human = new window.fixtureNativePC({ iceServers: [] });
    fx.meet = new RTCPeerConnection({ iceServers: [] });
    fx.humanHears = new Promise(resolve => { fx.human.ontrack = ({ track }) => resolve(track); });
    fx.human.addTrack(fx.tone(440));
    fx.meet.addTrack(fx.gum.getAudioTracks()[0]); // Meet publishes the robot's captured microphone back to the human
    // Both sides wait for ICE gathering to complete, so the exchanged SDPs already carry every candidate (no trickle).
    await fx.human.setLocalDescription(await fx.human.createOffer()); await fx.waitIce(fx.human);
    await fx.meet.setRemoteDescription(fx.human.localDescription);
    await fx.meet.setLocalDescription(await fx.meet.createAnswer()); await fx.waitIce(fx.meet);
    await fx.human.setRemoteDescription(fx.meet.localDescription);
    await new Promise(resolve => { const tick = () => fx.meet.connectionState === 'connected' ? resolve() : setTimeout(tick, 20); tick(); });
    await new Promise(resolve => setTimeout(resolve, 500));
    return { kinds: fx.gum.getTracks().map(t => t.kind).sort(), mediaHealth: RoboMeetMedia.health(), liveHealth: RoboMeetLive.health() };
  });
  check('getUserMedia still returns audio+video through both overrides', JSON.stringify(setup.kinds) === '["audio","video"]', setup.kinds);
  check('meet-media.js still sees the meeting track underneath', setup.mediaHealth.inputTracks === 1, { inputTracks: setup.mediaHealth.inputTracks });
  check('meet-live.js sees the meeting track', setup.liveHealth.inputTracks === 1 && setup.liveHealth.session === null, { inputTracks: setup.liveHealth.inputTracks });

  // Session: createOffer() -> fixture model peer answers and sends 880 Hz (stands in for the GPT Live answer).
  const session = await page.evaluate(async () => {
    const fx = window.fixture;
    const t0 = performance.now();
    const offer = await RoboMeetLive.createOffer();
    const offerMs = Math.round(performance.now() - t0);
    fx.model = new window.fixtureNativePC({ iceServers: [] });
    fx.modelHears = new Promise(resolve => { fx.model.ontrack = ({ track }) => resolve(track); });
    await fx.model.setRemoteDescription({ type: 'offer', sdp: offer });
    const transceiver = fx.model.getTransceivers().find(t => t.receiver.track.kind === 'audio');
    await transceiver.sender.replaceTrack(fx.tone(880));
    transceiver.direction = 'sendrecv';
    await fx.model.setLocalDescription(await fx.model.createAnswer()); await fx.waitIce(fx.model);
    const accepted = await RoboMeetLive.accept('live_fixture', fx.model.localDescription.sdp);
    await new Promise(resolve => { const tick = () => RoboMeetLive.health().session?.connection === 'connected' ? resolve() : setTimeout(tick, 20); tick(); });
    const modelTrack = await fx.modelHears;
    const offerLines = offer.split(/\r?\n/).filter(l => l.startsWith('m=')).map(l => l.split(' ').slice(0, 3).join(' '));
    const hasHostCandidate = /a=candidate:.* typ host/.test(offer);
    return { offerMs, offerLines, hasHostCandidate, accepted, modelSide: await fx.analyse(modelTrack), health: RoboMeetLive.health() };
  });
  check('offer has audio + data channel m-lines (same shape as public/live.js today)', session.offerLines.length === 2 && session.offerLines[0].startsWith('m=audio') && session.offerLines[1].startsWith('m=application'), session.offerLines);
  check('offer contains gathered host candidates (one-shot SDP relay)', session.hasHostCandidate, { offerMs: session.offerMs });
  check('model-bound track carries the meeting tone (440 Hz)', session.modelSide.dominantHz >= 420 && session.modelSide.dominantHz <= 460 && session.modelSide.rms > 0.01, session.modelSide);
  check('model tone (880 Hz) does not re-enter the model-bound mix', session.modelSide.db880 < session.modelSide.db440 - 20, { db440: session.modelSide.db440, db880: session.modelSide.db880 });
  check('health reports connected session with model track and open channel', session.health.session?.connection === 'connected' && session.health.session?.modelTrack === true, session.health.session);

  const gates = await page.evaluate(async () => {
    const fx = window.fixture;
    const heard = await fx.humanHears; // the robot's microphone as published by "Meet" to the human
    RoboMeetLive.setMode('listen');
    const listen = await fx.analyse(heard, 1200);
    RoboMeetLive.setMode('speak');
    const speak = await fx.analyse(heard, 1500);
    RoboMeetLive.setMode('quiet');
    const quietOut = await fx.analyse(heard, 1200);
    const quietIn = await fx.analyse(await fx.modelHears, 1200);
    RoboMeetLive.setMode('speak');
    return { listen, speak, quietOut, quietIn, health: RoboMeetLive.health() };
  });
  check('listen mode: microphone silent in the room', gates.listen.rms < 0.002, gates.listen);
  check('speak mode: model tone (880 Hz) reaches the room through the fake microphone', gates.speak.dominantHz >= 860 && gates.speak.dominantHz <= 900 && gates.speak.rms > 0.01, gates.speak);
  check('quiet mode: microphone silent', gates.quietOut.rms < 0.002, gates.quietOut);
  check('quiet mode: meeting audio no longer reaches the model', gates.quietIn.rms < 0.002, gates.quietIn);
  check('output onset event emitted for Node (latency instrumentation hook)', await page.evaluate(() => window.fixture.events.some(e => e.type === 'live-output-onset')), await page.evaluate(() => window.fixture.events.map(e => e.type)));

  const teardown = await page.evaluate(async () => {
    const id = RoboMeetLive.closeSession('fixture_done');
    const afterClose = RoboMeetLive.health();
    const modelState = window.fixture.model.connectionState;
    RoboMeetLive.close();
    const liveRestored = window.RTCPeerConnection !== undefined && navigator.mediaDevices.getUserMedia !== undefined;
    const mediaStillThere = typeof RoboMeetMedia?.health === 'function' && RoboMeetMedia.health().inputTracks === 1;
    RoboMeetMedia.close();
    const nativeRestored = window.RTCPeerConnection === window.fixtureNativePC;
    return { id, afterClose: afterClose.session, modelState, liveRestored, mediaStillThere, nativeRestored };
  });
  check('closeSession returns the id and clears the session', teardown.id === 'live_fixture' && teardown.afterClose === null, teardown);
  check('RoboMeetLive.close() then RoboMeetMedia.close() restores the native RTCPeerConnection', teardown.nativeRestored && teardown.mediaStillThere, teardown);
} catch (error) {
  report.errors.push(error.message);
  console.log('ERROR', error.message);
} finally {
  await browser?.close();
  server.close();
}
report.passed = report.checks.filter(c => c.ok).length;
report.failed = report.checks.filter(c => !c.ok).length;
await writeFile(out, JSON.stringify(report, null, 2));
console.log(`\n${report.passed} passed, ${report.failed} failed, ${report.errors.length} errors -> ${out}`);
process.exitCode = report.failed || report.errors.length ? 1 : 0;
