// Offline narration-sync oracle (docs/presentation-spec.md TC-S1, S2, S4, L3). No Meet, no OpenAI.
// The real Meet-page stack (src/meet-media.js + src/meet-live.js + src/meet-stage.js) runs in Chrome; a fake "GPT Live"
// peer answers RoboMeetLive.createOffer() and speaks a tone whose length follows each beat's words. The real
// src/presenter.mjs and src/stage-sync.mjs drive the stage through a real Store, exactly as the server does.
// Checks: the stage moves to each beat's view before the robot speaks it (lead 0..1.5 s), the stage shows the beat's
// view at every speech onset, gaps between beats, and that a person talking holds the presentation until "continue".
// Usage: node tools/present-lab/sync-fixture.mjs [--headful]
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/store.mjs';
import { createPresenter } from '../../src/presenter.mjs';
import { createStageSync } from '../../src/stage-sync.mjs';

const app = new URL('../../', import.meta.url).pathname;
const { chromium } = createRequire(app + 'package.json')('playwright');
const headful = process.argv.includes('--headful');
const read = file => readFile(join(app, file), 'utf8');
const [mediaScript, liveScript, stageScript] = await Promise.all([read('src/meet-media.js'), read('src/meet-live.js'), read('src/meet-stage.js')]);
const deckJson = JSON.parse(await read('public/slides/projectile-motion-deck/deck.json'));
const results = { checks: [], beats: [] };
const check = (name, ok, detail) => { results.checks.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`); };

const server = createServer((_request, response) => response.end('<!doctype html><title>sync fixture</title>'));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: !headful, args: ['--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling'] });
const page = await browser.newPage();
const store = new Store(await mkdtemp(join(tmpdir(), 'sync-fixture-')));
await page.exposeFunction('__robomeetStageEvent', data => store.event(data.type, data));
await page.addInitScript({ content: `window.fixtureNativePC = window.RTCPeerConnection;\n${mediaScript}\n${liveScript}\n${stageScript}` });
await page.goto(`http://127.0.0.1:${server.address().port}`);

// ---- in-page: a "human" meeting peer (so meet-live has meeting audio) and a fake model peer whose tone we gate
await page.evaluate(async () => {
  const fx = window.fx = { audio: new AudioContext() };
  await fx.audio.resume();
  fx.waitIce = peer => new Promise(resolve => { if (peer.iceGatheringState === 'complete') return resolve(); const timer = setTimeout(resolve, 2000); peer.addEventListener('icegatheringstatechange', () => { if (peer.iceGatheringState === 'complete') { clearTimeout(timer); resolve(); } }); });
  const tone = (frequency, level) => { const oscillator = fx.audio.createOscillator(); oscillator.frequency.value = frequency; const gain = fx.audio.createGain(); gain.gain.value = level; const destination = fx.audio.createMediaStreamDestination(); oscillator.connect(gain).connect(destination); oscillator.start(); return { track: destination.stream.getAudioTracks()[0], gain }; };
  const human = new window.fixtureNativePC({ iceServers: [] });
  const meet = new RTCPeerConnection({ iceServers: [] });
  human.addTrack(tone(440, 0.0).track);
  meet.addTrack((await navigator.mediaDevices.getUserMedia({ audio: true })).getAudioTracks()[0]);
  await human.setLocalDescription(await human.createOffer()); await fx.waitIce(human);
  await meet.setRemoteDescription(human.localDescription);
  await meet.setLocalDescription(await meet.createAnswer()); await fx.waitIce(meet);
  await human.setRemoteDescription(meet.localDescription);
  await new Promise(resolve => { const tick = () => meet.connectionState === 'connected' ? resolve() : setTimeout(tick, 20); tick(); });
  await new Promise(resolve => setTimeout(resolve, 400));
  const offer = await RoboMeetLive.createOffer();
  const model = new window.fixtureNativePC({ iceServers: [] });
  await model.setRemoteDescription({ type: 'offer', sdp: offer });
  const voice = tone(880, 0);
  const transceiver = model.getTransceivers().find(item => item.receiver.track.kind === 'audio');
  await transceiver.sender.replaceTrack(voice.track);
  transceiver.direction = 'sendrecv';
  await model.setLocalDescription(await model.createAnswer()); await fx.waitIce(model);
  await RoboMeetLive.accept('live_fixture', model.localDescription.sdp);
  await new Promise(resolve => { const tick = () => RoboMeetLive.health().session?.connection === 'connected' ? resolve() : setTimeout(tick, 20); tick(); });
  RoboMeetLive.setMode('speak');
  window.RoboMeetStage.configure({ speechEndMs: 350 });
  fx.speakTimer = null;
  fx.speak = ms => { clearTimeout(fx.speakTimer); voice.gain.gain.value = 0.2; fx.speakTimer = setTimeout(() => { voice.gain.gain.value = 0; }, ms); };
  fx.silence = () => { clearTimeout(fx.speakTimer); voice.gain.gain.value = 0; };
});

// ---- Node: the deck (three beats), a fake live that "speaks" through the fake model, the real presenter + sync
const says = [
  'This page derives projectile motion from Newton second law, splitting the motion into horizontal and vertical parts.',
  'Eliminating t gives the trajectory, and the three results are time of flight, maximum height and range.',
  'The observations box: best angle forty five degrees, complementary angles share the range, and mass never appears.',
];
const slides = deckJson.slides.map(slide => ({ title: slide.title, body: slide.body, views: slide.views.map((view, index) => ({ x: view.x, y: view.y, w: view.w, h: view.h, asset: view.asset, lines: (view.lines || []).map(line => typeof line === 'string' ? line : line.text), ...(says[index] ? { say: says[index] } : {}) })) }));
store.update({ title: deckJson.title, slides, slideIndex: 0, viewIndex: 0, mode: 'speak', voice: { desired: 'started', status: 'active' }, meeting: { status: 'joined', admitted: true, sharing: true } }); // the presenter narrates only to a shared screen
const listeners = new Set();
let interruptBeat = 1, interrupted = false, cues = [];
const emitTranscript = (role, text) => { for (const listener of listeners) listener({ sessionId: 'live_fixture', role, delta: text, startMs: 0, endMs: 0, at: Date.now() }); store.event('transcript', { sessionId: 'live_fixture', role, text }); };
const live = {
  activeSession: () => ({ id: 'live_fixture', startedAt: Date.now() }),
  onTranscript: listener => { listeners.add(listener); return () => listeners.delete(listener); },
  context: () => true,
  async narrate(text, { beforeCue, note = '' } = {}) {
    const beat = cues.length;
    await beforeCue?.(); // the real narrate awaits this after the instruction is acknowledged
    cues.push({ at: Date.now(), text, note });
    const words = text.split(/\s+/).length;
    const ms = 400 + words * 110;
    setTimeout(async () => {
      await page.evaluate(ms => window.fx.speak(ms), ms);
      // transcript follows the audio in a few chunks
      const chunks = text.split(/(?<=,|\.)\s+/);
      const cutAt = beat === interruptBeat && !interrupted ? ms / 2 : Infinity; // an interrupted robot stops mid-part
      chunks.forEach((chunk, index) => { const at = (ms / chunks.length) * index + 100; if (at < cutAt) setTimeout(() => emitTranscript('assistant', chunk + ' '), at); });
      // a person interrupts the second beat once, halfway through, then says continue
      if (beat === interruptBeat && !interrupted) {
        interrupted = true;
        setTimeout(async () => {
          await page.evaluate(() => window.fx.silence());
          emitTranscript('user', 'wait, what does that mean?');
          setTimeout(() => emitTranscript('user', 'okay, continue'), 2500);
        }, ms / 2);
      }
    }, 700); // the model's own start latency
    return { sent: true, acked: true, sessionId: 'live_fixture' };
  },
};
const publicDir = join(app, 'public');
const sync = createStageSync({ getPage: () => page, getState: () => store.snapshot(), publicDir, emit: event => store.event(event.type, event) });
const presenter = createPresenter({ store, live, sync: () => sync.sync() });
await sync.sync();
const startCursor = store.state.cursor;
const startedAt = Date.now();
presenter.start({ style: 'own-words' });
const deadline = Date.now() + 90000;
while (Date.now() < deadline && !['done', 'stopped'].includes(store.state.presenter?.status)) await new Promise(resolve => setTimeout(resolve, 250));
const events = store.readEvents(startCursor, 2000).events;
const of = type => events.filter(event => event.type === type);
check('presenter finished', store.state.presenter?.status === 'done', store.state.presenter);
const onsets = of('stage-speech').filter(event => event.data.phase === 'onset');
const ends = of('stage-speech').filter(event => event.data.phase === 'end');
const shown = of('stage-shown');
const paused = of('presenter.paused');
const resumed = of('presenter.resumed');
check('a person talking paused the presentation', paused.some(event => event.data.reason === 'person_speaking'), paused.map(event => event.data));
check('"okay, continue" resumed it', resumed.length >= 1, resumed.map(event => event.data));
// For every cue: the beat it belongs to (presenter.beat), the first speech onset after it and the view on stage then,
// and — when the cue needed a move — the stage move that preceded it.
const beatEvents = of('presenter.beat');
for (const [index, cue] of cues.entries()) {
  const beat = [...beatEvents].reverse().find(event => event.data.cueAt <= cue.at + 5) || null;
  const expected = beat ? `${beat.data.slide}:${beat.data.view}` : null;
  const previousCue = cues[index - 1];
  const move = [...shown].reverse().find(event => event.data.at <= cue.at + 50 && (!previousCue || event.data.at > previousCue.at) && `${event.data.slide}:${event.data.view}` === expected);
  const onset = onsets.find(event => event.data.at > cue.at);
  const end = onset && ends.find(event => event.data.at > onset.data.at);
  const next = cues[index + 1];
  const nextOnset = next && onsets.find(event => event.data.at > next.at);
  results.beats.push({ cue: index, beat: beat?.data.beat ?? null, expected, moved: Boolean(move), leadMs: onset && move ? onset.data.at - move.data.at : null, viewAtOnset: onset ? `${onset.data.slide}:${onset.data.view}` : null, speechMs: end ? end.data.at - onset.data.at : null, gapToNextMs: end && nextOnset ? nextOnset.data.at - end.data.at : null, interrupted: index === interruptBeat });
}
console.table(results.beats);
const leads = results.beats.map(beat => beat.leadMs).filter(value => value !== null);
check('TC-S1 every stage move came before its beat was spoken, lead 0..1500 ms', leads.length >= 2 && leads.every(value => value > 0 && value <= 1500), leads);
check('TC-S2 the stage showed the beat view at every speech onset', results.beats.every(beat => beat.expected && beat.viewAtOnset === beat.expected), results.beats.map(beat => [beat.expected, beat.viewAtOnset]));
const gaps = results.beats.filter(beat => !beat.interrupted).map(beat => beat.gapToNextMs).filter(value => value !== null).sort((a, b) => a - b);
const median = gaps.length ? gaps[Math.floor(gaps.length / 2)] : null;
check('TC-L3 median gap between beats <= 2000 ms (excluding the interruption)', median !== null && median <= 2000, { gaps, median });
// The part is re-sent unchanged; RoboMeet's guidance to continue from where it stopped travels beside it as the note.
check('the interrupted, unfinished beat continued after resume ("continue from where you stopped")', cues.length === says.length + 1 && /^You were interrupted/.test(cues[interruptBeat + 1]?.note || '') && cues[interruptBeat + 1]?.text === cues[interruptBeat]?.text, { cues: cues.map(cue => `${cue.note ? `[${cue.note.slice(0, 40)}] ` : ''}${cue.text.slice(0, 50)}`) });
// TC-P5 (docs/problems/presenting-v1.md): the robot is in a 6 s answer when the walk is restarted, as the server's narrate
// does (stop 'restarted', then start). The first cue must wait for its real audio to end plus about a second.
{
  const cuesBefore = cues.length, restartCursor = store.state.cursor;
  await page.evaluate(() => window.fx.speak(6000));
  await new Promise(resolve => setTimeout(resolve, 1500));
  presenter.stop('restarted');
  presenter.start({ style: 'own-words' });
  const until = Date.now() + 20000;
  while (Date.now() < until && cues.length === cuesBefore) await new Promise(resolve => setTimeout(resolve, 50));
  const after = store.readEvents(restartCursor, 500).events;
  const answerEnd = after.find(event => event.type === 'stage-speech' && event.data.phase === 'end');
  const firstCue = cues[cuesBefore];
  const waited = firstCue && answerEnd ? firstCue.at - answerEnd.data.at : null;
  check('TC-P5 a restart during a long answer cues only after the robot finished and paused about a second', waited !== null && waited >= 900 && waited <= 3500, { waitedAfterRobotAudioMs: waited });
  presenter.stop('fixture_restart_done');
}
results.presenterEvents = events.filter(event => event.type.startsWith('presenter.')).map(event => ({ type: event.type, at: event.at, data: event.data }));
results.elapsedMs = Date.now() - startedAt;
const out = join(app, 'tools/present-lab/runs', `sync-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
await writeFile(out, JSON.stringify(results, null, 2));
console.log('wrote', out, `${results.checks.filter(item => item.ok).length}/${results.checks.length} checks passed`);
presenter.stop('fixture_done');
await browser.close();
server.close();
process.exit(results.checks.every(item => item.ok) ? 0 : 1);
