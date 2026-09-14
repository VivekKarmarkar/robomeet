import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { chromium } from 'playwright';

test('isolated media bridge carries both directions and excludes generated voice from the meeting mix', { timeout: 45_000 }, async () => {
  const script = await readFile(new URL('../src/meet-media.js', import.meta.url), 'utf8');
  const server = createServer((_req, res) => res.end('<!doctype html><title>RoboMeet media fixture</title>'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
    const page = await browser.newPage();
    await page.addInitScript({ content: `window.fixtureNativePC = window.RTCPeerConnection;\n${script}` });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const initial = await page.evaluate(async () => {
      window.fixture = { audio: new AudioContext() };
      fixture.gum = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      fixture.gdm = await navigator.mediaDevices.getDisplayMedia({ video: true });
      return {
        kinds: fixture.gum.getTracks().map(track => track.kind).sort(),
        distinctVideo: fixture.gum.getVideoTracks()[0].id !== fixture.gdm.getVideoTracks()[0].id,
        health: RoboMeetMedia.health(),
      };
    });
    assert.deepEqual(initial.kinds, ['audio', 'video']);
    assert.equal(initial.distinctVideo, true);
    assert.equal(initial.health.input, 'no-input');

    await page.evaluate(async () => {
      fixture.waitIce = peer => new Promise(resolve => {
        if (peer.iceGatheringState === 'complete') return resolve();
        const timeout = setTimeout(resolve, 2000);
        peer.addEventListener('icegatheringstatechange', () => {
          if (peer.iceGatheringState === 'complete') { clearTimeout(timeout); resolve(); }
        });
      });
      fixture.tone = frequency => {
        const oscillator = fixture.audio.createOscillator();
        oscillator.frequency.value = frequency;
        const gain = fixture.audio.createGain();
        gain.gain.value = 0.1;
        const destination = fixture.audio.createMediaStreamDestination();
        oscillator.connect(gain).connect(destination);
        oscillator.start();
        return destination.stream.getAudioTracks()[0];
      };
      fixture.connectHuman = async () => {
        fixture.human = new fixtureNativePC({ iceServers: [] });
        fixture.meet = new RTCPeerConnection({ iceServers: [] });
        fixture.human.ontrack = ({ track }) => {
          const stream = new MediaStream([track]);
          fixture.humanPlayback = new Audio();
          fixture.humanPlayback.muted = true;
          fixture.humanPlayback.srcObject = stream;
          fixture.humanPlayback.play();
          fixture.humanMeter = fixture.audio.createAnalyser();
          const source = fixture.audio.createMediaStreamSource(stream);
          const quiet = fixture.audio.createGain(); quiet.gain.value = 0;
          source.connect(fixture.humanMeter).connect(quiet).connect(fixture.audio.destination);
        };
        fixture.human.addTrack(fixture.tone(440));
        fixture.meet.addTrack(fixture.gum.getAudioTracks()[0]);
        await fixture.human.setLocalDescription(await fixture.human.createOffer());
        await fixture.waitIce(fixture.human);
        await fixture.meet.setRemoteDescription(fixture.human.localDescription);
        await fixture.meet.setLocalDescription(await fixture.meet.createAnswer());
        await fixture.waitIce(fixture.meet);
        await fixture.human.setRemoteDescription(fixture.meet.localDescription);
      };
      await fixture.audio.resume();
      await fixture.connectHuman();
    });
    await page.waitForFunction(() => RoboMeetMedia.health().input === 'active', undefined, { timeout: 10_000 }).catch(async error => {
      console.error('Fixture audio diagnostic:', JSON.stringify(await page.evaluate(async () => ({ health: RoboMeetMedia.health(), stats: await RoboMeetMedia.publicationStats(), audio: fixture.audio.state, human: fixture.human.connectionState, meet: fixture.meet.connectionState }))));
      throw error;
    });
    assert.equal(await page.evaluate(() => RoboMeetMedia.health().inputTracks), 1);

    await page.evaluate(async () => {
      fixture.app = new fixtureNativePC({ iceServers: [] });
      fixture.app.ontrack = ({ track }) => {
        fixture.receivedAudio = fixture.audio.createMediaStreamSource(new MediaStream([track]));
        fixture.meter = fixture.audio.createAnalyser();
        fixture.receivedAudio.connect(fixture.meter);
      };
      const makeVideo = color => {
        const canvas = document.createElement('canvas');
        canvas.width = 64; canvas.height = 64;
        const painter = canvas.getContext('2d');
        painter.fillStyle = color; painter.fillRect(0, 0, 64, 64);
        const track = canvas.captureStream(10).getVideoTracks()[0];
        fixture.paintTimer = setInterval(() => painter.fillRect(0, 0, 64, 64), 100);
        return track;
      };
      const tracks = { audio: fixture.tone(880), camera: makeVideo('red'), screen: makeVideo('green') };
      const transceivers = {};
      for (const [role, track] of Object.entries(tracks)) transceivers[role] = fixture.app.addTransceiver(track, { direction: role === 'audio' ? 'sendrecv' : 'sendonly' });
      const candidates = [];
      window.__robomeetSignal = async item => {
        if (fixture.app.remoteDescription) await fixture.app.addIceCandidate(item.candidate);
        else candidates.push(item.candidate);
      };
      await fixture.app.setLocalDescription(await fixture.app.createOffer());
      await fixture.waitIce(fixture.app);
      const answer = await RoboMeetMedia.answer({ description: fixture.app.localDescription.toJSON(), roles: Object.fromEntries(Object.entries(transceivers).map(([role, transceiver]) => [role, transceiver.mid])), epoch: 1 });
      await fixture.app.setRemoteDescription(answer);
      for (const candidate of candidates) await fixture.app.addIceCandidate(candidate);
    });
    await page.waitForFunction(() => {
      if (!fixture.meter) return false;
      const samples = new Float32Array(fixture.meter.fftSize);
      fixture.meter.getFloatTimeDomainData(samples);
      const returned = new Float32Array(fixture.humanMeter?.fftSize || 256);
      fixture.humanMeter?.getFloatTimeDomainData(returned);
      return samples.some(sample => Math.abs(sample) > 0.01) && returned.some(sample => Math.abs(sample) > 0.01) && RoboMeetMedia.health().cameraFrames > 0 && RoboMeetMedia.health().screenFrames > 0;
    }, undefined, { timeout: 10_000 });
    const connected = await page.evaluate(async () => ({ health: RoboMeetMedia.health(), stats: await RoboMeetMedia.publicationStats() }));
    assert.equal(connected.health.bridge, 'connected');
    assert.equal(connected.health.inputTracks, 1, 'app-output bridge must not be counted as a meeting source');
    assert.equal(connected.stats.length, 1, 'only the platform peer belongs in publication stats');
    assert(connected.stats[0].streams.some(stream => stream.type === 'inbound-rtp' && stream.bytesReceived > 0));
    assert(connected.stats[0].streams.some(stream => stream.type === 'outbound-rtp' && stream.bytesSent > 0));
    await page.evaluate(() => { fixture.meet.close(); fixture.human.close(); });
    await page.waitForFunction(() => RoboMeetMedia.health().inputTracks === 0);
    await page.evaluate(() => fixture.connectHuman());
    await page.waitForFunction(() => RoboMeetMedia.health().input === 'active');
    assert.equal(await page.evaluate(() => RoboMeetMedia.health().inputTracks), 1, 'late replacement meeting peer is wired into the same mix');
    await page.evaluate(() => RoboMeetMedia.close());
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
