// Narrated presentation beat loop (src/presenter.mjs) against a real Store, a fake GPT Live (narrate, activeSession,
// onTranscript, context) and a simulated Meet page: the robot's own audio arrives as store 'stage-speech' events, as
// src/meet-stage.js reports it. No browser, no network, no OpenAI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { createPresenter, beatsFrom, wordsIn, speechBudgetMs, coverageOf, echoShare, contentWords, RESUME, cleanUtterance } from '../src/presenter.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
// The simulated page's timers; cleared when a test ends, so nothing writes into a removed store directory.
const timers = new Set();
const later = (fn, ms) => { const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms); timers.add(timer); };
async function until(predicate, label = 'condition', timeout = 4000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = predicate(); if (value) return value; await wait(4); }
  throw new Error(`timed out waiting for ${label}`);
}
// Fast clock for tests; each test overrides what it exercises.
const FAST = { quietMs: 40, utteranceQuietMs: 80, quietMaxMs: 400, retryMs: 30, onsetTimeoutMs: 150, ownWordsTailMs: 60, verbatimTailMs: 120, interruptWindowMs: 150, utteranceGapMs: 60, resumeConfirmMs: 30, shownWaitMs: 50, tickMs: 4, budget: () => 1500 };
const SAYS = ['Part one explains the launch angle of thirty degrees.', 'Part two shows the range formula for 45 degrees.', 'Part three compares measured and predicted heights.'];
// Page 1 has two views (beats 0 and 1), page 2 one view (beat 2).
const deck = () => ({ title: 'Projectile motion', mode: 'speak', slideIndex: 0, viewIndex: 0, slides: [
  { title: 'Page 1', body: 'image:/slides/pm/p1.png', views: [{ x: 0, y: 0, w: 1, h: 0.5, say: SAYS[0], lines: ['Launch angle 30 degrees', { text: 'Initial speed 20 m/s' }] }, { x: 0, y: 0.5, w: 1, h: 0.5, say: SAYS[1] }] },
  { title: 'Page 2', body: 'image:/slides/pm/p2.png', views: [{ x: 0, y: 0, w: 1, h: 1, say: SAYS[2], lines: ['Measured vs predicted'] }] },
] });
const POSITION = [{ slide: 0, view: 0 }, { slide: 0, view: 1 }, { slide: 1, view: 0 }];

function fakeLive() {
  return {
    session: { id: 'session-1' }, listeners: new Set(), log: [], accept: () => ({ sent: true, acked: true }), onNarrate: null,
    get narrations() { return this.log.filter(entry => entry.kind === 'narrate'); },
    get contexts() { return this.log.filter(entry => entry.kind === 'context').map(entry => entry.text); },
    // Like src/live.mjs: the instruction goes out, is acknowledged, beforeCue runs (the presenter moves the stage
    // there), then the "begin" cue. `at` is the moment of that cue.
    async narrate(text, options) {
      const call = { kind: 'narrate', text, ...options, at: Date.now(), sessionId: this.session?.id ?? null };
      this.log.push(call);
      const result = this.accept(call);
      if (result.sent && result.acked) { await options?.beforeCue?.(); call.at = Date.now(); this.onNarrate?.(call); }
      return { ...result, sessionId: call.sessionId };
    },
    activeSession() { return this.session; },
    onTranscript(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); },
    context(text) { this.log.push({ kind: 'context', text, at: Date.now() }); },
    hush() { this.log.push({ kind: 'hush', at: Date.now() }); return true; },
    say(role, delta) { for (const listener of [...this.listeners]) listener({ sessionId: this.session?.id ?? null, role, delta, startMs: null, endMs: null, at: Date.now() }); },
  };
}
// The page's report of the robot's own audio (src/meet-stage.js speech watcher).
const onset = store => store.event('stage-speech', { type: 'stage-speech', phase: 'onset', at: Date.now() });
const end = store => store.event('stage-speech', { type: 'stage-speech', phase: 'end', at: Date.now() });
// After each accepted cue the robot speaks: onset, its output transcript, then (unless end: false) an end.
function robotVoice(store, live, { onsetMs = 8, speakMs = 25, words = call => call.text, ends = true } = {}) {
  live.onNarrate = call => later(() => {
    onset(store);
    const text = words(call);
    if (text) live.say('assistant', ` ${text}`);
    if (ends) later(() => end(store), speakMs);
  }, onsetMs);
}
async function setup(t, { state = deck(), timing = {}, voice = true, sharing = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'robomeet-presenter-'));
  const store = new Store(directory);
  store.update({ meeting: { status: 'joined', admitted: true, sharing }, ...state });
  const live = fakeLive(), syncs = [];
  const sync = async () => { syncs.push({ slide: store.state.slideIndex, view: store.state.viewIndex, at: Date.now() }); };
  const presenter = createPresenter({ store, live, sync, timing: { ...FAST, ...timing } });
  if (voice) robotVoice(store, live);
  t.after(async () => { for (const timer of timers) clearTimeout(timer); timers.clear(); presenter.stop('test_end'); await wait(20); await rm(directory, { recursive: true, force: true }); });
  return { store, live, presenter, syncs };
}
const events = (store, type) => store.state.events.filter(event => event.type === type);
const last = (store, type) => events(store, type).at(-1);

test('pure helpers: beats, budget, coverage, echo, resume phrases', () => {
  assert.deepEqual(beatsFrom(deck()).map(beat => [beat.slide, beat.view]), [[0, 0], [0, 1], [1, 0]]);
  assert.deepEqual(beatsFrom({ slides: [{ views: [{ say: '  ' }] }] }), []);
  assert.equal(wordsIn(' two  words '), 2);
  assert.equal(speechBudgetMs('one two three'), 4000 + 3 * 520);
  assert.deepEqual(contentWords('The 2 big ox ran at 45 km'), ['2', 'big', 'ran', '45']);
  // The robot paraphrases: live, a fully covered part scored 0.75 on exact words (sin/sine, 2/two, eliminate/eliminating).
  assert.equal(coverageOf('Eliminating t gives the trajectory; time of flight T equals two v zero sine theta over g, maximum height H.', "If we eliminate t we get the trajectory. The time of flight is 2 v zero sin theta over g, and the max height is H."), 1);
  assert.ok(coverageOf('Eliminating t gives the trajectory, a parabola through the origin, then the time of flight and maximum height.', 'It is giving the trajectory.') < 0.3, 'a first sentence is not the part');
  assert.equal(coverageOf('Launch angle of thirty degrees', 'the launch angle is thirty degrees'), 1);
  assert.equal(coverageOf('Launch angle of thirty degrees', 'launch'), 0.25);
  assert.equal(echoShare('the launch angle', 'Part one explains the launch angle.'), 1);
  assert.equal(echoShare('wait a second', 'Part one explains the launch angle.'), 0);
  // Resume phrases are matched after punctuation is stripped: live, GPT Live sent "Okay, continue" as " Okay" + ", continue".
  for (const phrase of ['continue', 'Go on.', 'okay, keep going', 'Ok next slide!', 'next part', 'move on', 'Resume', 'please continue', ' Okay' + ', continue', 'yes, go ahead', 'continue please']) assert.match(cleanUtterance(phrase), RESUME);
  for (const phrase of ['next question is about drag', 'go on then', 'continue with the next one', 'wait, what does that equation mean']) assert.doesNotMatch(cleanUtterance(phrase), RESUME);
});

test('start refuses a deck without narration', async t => {
  const { presenter } = await setup(t, { state: { title: 'Empty', mode: 'speak', slides: [{ title: 'x', body: 'y', views: [{ x: 0, y: 0, w: 1, h: 1 }] }] } });
  assert.throws(() => presenter.start(), error => error.status === 400);
  assert.deepEqual(presenter.status(), { status: 'idle' });
});

test('walks 3 beats in order; the stage moves before each part is spoken and the model hears the screen with each cue', async t => {
  const { store, live, presenter, syncs } = await setup(t);
  const started = presenter.start();
  assert.equal(started.status, 'running');
  assert.equal(started.total, 3);
  assert.equal(started.style, 'own-words');
  await until(() => last(store, 'presenter.done'), 'presenter.done');
  assert.deepEqual(live.narrations.map(call => call.text), SAYS);
  assert.deepEqual(live.narrations.map(call => call.screen), ['page 1, part 1 of 3', 'page 1, part 2 of 3', 'page 2, part 3 of 3']);
  assert.ok(live.narrations.every(call => call.style === 'own-words'));
  // The briefing comes first, once; each view with lines gets its screen context right after its cue (sent before the
  // cue it delayed GPT Live's acknowledgment of the cue, live 2026-09-15).
  assert.equal(live.log[0].text, 'You are about to present Projectile motion in 3 parts. RoboMeet moves your shared screen to each part and asks you to present it. If someone asks something, answer briefly; do not move ahead on your own. RoboMeet continues when someone says continue or next.');
  assert.equal(live.contexts.filter(text => text.startsWith('You are about to present')).length, 1);
  assert.equal(live.log[1].kind, 'narrate');
  assert.equal(live.log[2].text, 'On your shared screen now: Projectile motion, page 1, part 1 of 3. Visible text: Launch angle 30 degrees Initial speed 20 m/s');
  assert.equal(live.contexts.filter(text => text.startsWith('On your shared screen now')).length, 2); // beat 1 has no lines
  // Stage before cue: the last sync before each narration showed that beat's view, and the store event order agrees.
  live.narrations.forEach((call, index) => {
    const synced = syncs.filter(item => item.at <= call.at).at(-1);
    assert.deepEqual({ slide: synced.slide, view: synced.view }, POSITION[index]);
  });
  const moves = events(store, 'presentation.stage'), beats = events(store, 'presenter.beat'), done = events(store, 'presenter.beat_done');
  assert.deepEqual(beats.map(event => [event.data.beat, event.data.slide, event.data.view]), [[0, 0, 0], [1, 0, 1], [2, 1, 0]]);
  // The move happens once the voice has accepted the cue (beforeCue), after 'presenter.beat' and before the robot speaks.
  beats.forEach((event, index) => {
    const next = beats[index + 1];
    const move = moves.find(item => item.cursor > event.cursor && (!next || item.cursor < next.cursor));
    const spoke = store.state.events.find(item => item.type === 'stage-speech' && item.data.phase === 'onset' && item.cursor > event.cursor);
    assert.ok(move && (!spoke || move.cursor < spoke.cursor), `beat ${index} moved before it was spoken`);
    assert.ok(Number.isFinite(event.data.cueAt));
  });
  assert.deepEqual(done.map(event => event.data.beat), [0, 1, 2]);
  assert.ok(done.every(event => event.data.endedBy === 'speech_end' && event.data.coverage === 1 && event.data.speechMs >= 0));
  assert.equal(done[0].data.gapMs, null);
  assert.ok(done.slice(1).every(event => Number.isFinite(event.data.gapMs) && event.data.gapMs >= 0));
  assert.deepEqual(presenter.status(), { id: started.id, status: 'done', beat: 3, total: 3, reason: null, style: 'own-words' });
  assert.equal(store.state.presenter.status, 'done');
  assert.ok(last(store, 'presenter.started'));
  await wait(10);
  assert.equal(live.listeners.size, 0); // transcript listener and store pump are released when the walk ends
  assert.equal(store.listenerCount('change'), 0);
});

// One narrated view; the robot speaks in two stretches with a short silence between them (breath, sentence break).
const oneBeat = () => ({ title: 'One', mode: 'speak', slides: [{ title: 'Only', body: 'text', views: [{ x: 0, y: 0, w: 1, h: 1, say: 'Alpha bravo charlie delta echo foxtrot golf hotel india juliet.' }] }] });
function twoStretches(store, live, first, second, gapMs = 40) {
  live.onNarrate = () => later(() => {
    onset(store); live.say('assistant', first);
    later(() => {
      end(store);
      later(() => { onset(store); live.say('assistant', second); later(() => end(store), 20); }, gapMs);
    }, 15);
  }, 8);
}
const cursorOf = (store, type, phase, nth = 0) => store.state.events.filter(event => event.type === type && (!phase || event.data.phase === phase))[nth]?.cursor;

test('verbatim: an end with >= 80% of the content words ends the beat at once', async t => {
  const { store, live, presenter } = await setup(t, { state: oneBeat(), voice: false });
  twoStretches(store, live, 'Alpha bravo charlie delta echo foxtrot golf hotel india', ' juliet.', 150); // 9 of 10 before the first end
  presenter.start({ style: 'verbatim' });
  const done = await until(() => last(store, 'presenter.beat_done'), 'beat_done');
  assert.equal(done.data.endedBy, 'speech_end');
  assert.ok(done.cursor < cursorOf(store, 'stage-speech', 'onset', 1) || !cursorOf(store, 'stage-speech', 'onset', 1)); // did not wait for more
  assert.equal(done.data.coverage, 0.9);
  assert.equal(live.narrations[0].style, 'verbatim');
});

test('verbatim: an end with less coverage waits for the next onset, then ends on the covered end', async t => {
  const { store, live, presenter } = await setup(t, { state: oneBeat(), voice: false });
  twoStretches(store, live, 'Alpha bravo charlie', ' delta echo foxtrot golf hotel india juliet.');
  presenter.start({ style: 'verbatim' });
  const done = await until(() => last(store, 'presenter.beat_done'), 'beat_done');
  assert.equal(done.data.endedBy, 'speech_end');
  assert.ok(done.cursor > cursorOf(store, 'stage-speech', 'end', 1), 'ended only after the second stretch');
  assert.equal(done.data.coverage, 1);
});

test('verbatim: low coverage and no new onset within the tail ends the beat as partial', async t => {
  const { store, live, presenter } = await setup(t, { state: oneBeat(), voice: false });
  live.onNarrate = () => later(() => { onset(store); live.say('assistant', 'Alpha bravo'); later(() => end(store), 15); }, 8);
  presenter.start({ style: 'verbatim' });
  const done = await until(() => last(store, 'presenter.beat_done'), 'beat_done');
  assert.equal(done.data.endedBy, 'speech_end_partial');
  assert.equal(done.data.coverage, 0.2);
  const endedAt = Date.parse(store.state.events.find(event => event.cursor === cursorOf(store, 'stage-speech', 'end')).at);
  assert.ok(Date.parse(done.at) - endedAt >= FAST.verbatimTailMs - 5, 'waited the verbatim tail');
});

test('own-words: an end followed by a new onset within the tail does not end the beat; a quiet tail does', async t => {
  const { store, live, presenter } = await setup(t, { state: oneBeat(), voice: false });
  twoStretches(store, live, 'Alpha bravo charlie delta echo foxtrot golf hotel india juliet', ' and that is the whole list.', 30); // 30 < 60 ms tail
  presenter.start();
  const done = await until(() => last(store, 'presenter.beat_done'), 'beat_done');
  assert.equal(done.data.endedBy, 'speech_end');
  assert.ok(done.cursor > cursorOf(store, 'stage-speech', 'end', 1), 'the first end was not the end of the beat');
  const secondEnd = Date.parse(store.state.events.find(event => event.cursor === cursorOf(store, 'stage-speech', 'end', 1)).at);
  assert.ok(Date.parse(done.at) - secondEnd >= FAST.ownWordsTailMs - 5, 'waited the own-words tail after the last end');
});

test('no voice session pauses before any cue; resume with a session briefs the model and continues', async t => {
  const { store, live, presenter } = await setup(t);
  live.session = null;
  presenter.start();
  await until(() => presenter.status().status === 'paused', 'paused');
  assert.equal(presenter.status().reason, 'no_voice_session');
  assert.equal(last(store, 'presenter.paused').data.reason, 'no_voice_session');
  assert.equal(store.state.presenter.reason, 'no_voice_session');
  await wait(30);
  assert.equal(live.log.length, 0);
  live.session = { id: 'session-1' };
  await presenter.control('resume');
  assert.equal(last(store, 'presenter.resumed').data.by, 'command');
  await until(() => last(store, 'presenter.done'), 'presenter.done');
  assert.ok(live.log[0].text.startsWith('You are about to present Projectile motion in 3 parts.'));
  assert.equal(live.narrations.length, 3);
});

test('not in speak mode pauses before any cue', async t => {
  const { store, live, presenter } = await setup(t, { state: { ...deck(), mode: 'listen' } });
  presenter.start();
  await until(() => presenter.status().status === 'paused', 'paused');
  assert.equal(presenter.status().reason, 'not_in_speak_mode');
  await wait(30);
  assert.equal(live.narrations.length, 0);
  store.update({ mode: 'speak' });
  await presenter.control('resume');
  await until(() => live.narrations.length === 1, 'first cue');
});

test('a person speaking during a beat pauses it; a spoken "continue" resumes and the unfinished beat continues', async t => {
  const { store, live, presenter } = await setup(t, { voice: false });
  // The robot is cut off after two words of part one, so the part is not covered and is picked up again.
  robotVoice(store, live, { speakMs: 250, words: call => (live.narrations.length === 1 ? 'Part one' : call.text) });
  presenter.start();
  await until(() => cursorOf(store, 'stage-speech', 'onset'), 'first onset');
  live.say('user', ' Wait,');
  live.say('user', ' can you');
  await until(() => presenter.status().status === 'paused', 'paused');
  assert.equal(presenter.status().reason, 'person_speaking');
  assert.equal(presenter.status().beat, 0);
  await wait(FAST.utteranceGapMs + 40); // the question's utterance ended; it is not a resume phrase
  assert.equal(presenter.status().status, 'paused');
  live.say('user', ' Okay');
  live.say('user', ', continue.');
  await until(() => last(store, 'presenter.resumed'), 'resumed');
  assert.equal(last(store, 'presenter.resumed').data.by, 'voice');
  await until(() => last(store, 'presenter.done'), 'presenter.done', 6000);
  const texts = live.narrations.map(call => call.text);
  assert.equal(texts.length, 4);
  assert.deepEqual([texts[0], texts[2], texts[3]], [SAYS[0], SAYS[1], SAYS[2]]);
  assert.equal(texts[1], SAYS[0], 'the part itself is sent unchanged');
  assert.match(live.narrations[1].note, /^You were interrupted while presenting this part\. Continue from where you stopped/, 'the guidance goes beside it');
  assert.deepEqual(events(store, 'presenter.beat_done').map(event => event.data.beat), [0, 1, 2]);
});

test('after an interruption, a part the robot already covered is not presented again', async t => {
  const { store, live, presenter } = await setup(t, { voice: false });
  robotVoice(store, live, { speakMs: 250 }); // the robot says the whole part before the person speaks
  presenter.start();
  await until(() => cursorOf(store, 'stage-speech', 'onset'), 'first onset');
  await wait(40);
  live.say('user', ' Wait,');
  live.say('user', ' can you');
  await until(() => presenter.status().status === 'paused', 'paused');
  await wait(FAST.utteranceGapMs + 40);
  live.say('user', ' go on');
  await until(() => last(store, 'presenter.done'), 'presenter.done', 6000);
  assert.deepEqual(live.narrations.map(call => call.text), [SAYS[0], SAYS[1], SAYS[2]]);
  const first = events(store, 'presenter.beat_done')[0];
  assert.equal(first.data.beat, 0);
  assert.equal(first.data.endedBy, 'covered_after_interruption');
});

test('the robot hearing its own words (echo) does not pause the beat', async t => {
  const { store, live, presenter } = await setup(t, { state: oneBeat(), voice: false });
  live.onNarrate = () => later(() => {
    onset(store); live.say('assistant', 'Alpha bravo charlie delta echo foxtrot golf hotel india juliet.');
    later(() => live.say('user', ' Charlie delta echo'), 10);
    later(() => live.say('user', ' foxtrot golf.'), 20);
    later(() => end(store), 60);
  }, 8);
  presenter.start();
  await until(() => last(store, 'presenter.done'), 'presenter.done');
  assert.equal(events(store, 'presenter.paused').length, 0);
});

test('the share stopping pauses the walk; resume continues the unfinished part', async t => {
  const { store, live, presenter } = await setup(t, { voice: false });
  // The robot had said two words of part one when the share stopped.
  robotVoice(store, live, { speakMs: 200, words: call => (live.narrations.length === 1 ? 'Part one' : call.text) });
  presenter.start();
  await until(() => cursorOf(store, 'stage-speech', 'onset'), 'first onset');
  store.event('stage-sharing', { type: 'stage-sharing', sharing: false });
  await until(() => presenter.status().status === 'paused', 'paused');
  assert.equal(presenter.status().reason, 'share_stopped');
  store.event('stage-sharing', { type: 'stage-sharing', sharing: true });
  await presenter.control('resume');
  await until(() => live.narrations.length === 2, 'part one picked up again');
  assert.equal(live.narrations[1].text, SAYS[0]);
  assert.match(live.narrations[1].note, /^You were interrupted while presenting this part\. Continue from where you stopped/);
});

test('a voice session restart pauses the walk; resume first sends a recap, then repeats the beat', async t => {
  const { store, live, presenter } = await setup(t, { voice: false });
  robotVoice(store, live);
  const narrate = live.onNarrate;
  live.onNarrate = call => { if (live.narrations.length === 2) { live.session = { id: 'session-2' }; return; } narrate(call); }; // beat 1: the voice restarts
  presenter.start();
  await until(() => presenter.status().status === 'paused', 'paused');
  assert.equal(presenter.status().reason, 'voice_restarted');
  assert.equal(presenter.status().beat, 1);
  const before = live.log.length;
  live.onNarrate = narrate;
  await presenter.control('resume');
  await until(() => last(store, 'presenter.done'), 'presenter.done');
  const after = live.log.slice(before);
  assert.equal(after[0].kind, 'context');
  assert.equal(after[0].text, 'Your voice session restarted during the presentation of Projectile motion (3 parts). Parts covered so far: 1. Continuing with part 2. RoboMeet moves your shared screen to each part and asks you to present it. If someone asks something, answer briefly; do not move ahead on your own. RoboMeet continues when someone says continue or next.');
  assert.deepEqual(after.filter(entry => entry.kind === 'narrate').map(call => [call.text, call.sessionId]), [[SAYS[1], 'session-2'], [SAYS[2], 'session-2']]);
  assert.equal(live.contexts.filter(text => text.startsWith('Your voice session restarted')).length, 1);
});

test('the voice session closing mid-part pauses the walk; the part stays open and the new session hears where it stopped', async t => {
  const { store, live, presenter } = await setup(t, { voice: false });
  // Part one: the robot says three words, then its session closes (its audio stops, so an end arrives).
  robotVoice(store, live, { speakMs: 60, words: call => (live.narrations.length === 1 ? 'Part one explains' : call.text) });
  const narrate = live.onNarrate;
  live.onNarrate = call => { narrate(call); if (live.narrations.length === 1) later(() => { live.session = null; }, 30); };
  presenter.start();
  await until(() => presenter.status().status === 'paused', 'paused');
  assert.equal(presenter.status().reason, 'voice_session_lost');
  assert.equal(presenter.status().beat, 0);
  await wait(FAST.ownWordsTailMs + 100); // the end of the robot's audio has arrived by now
  assert.equal(events(store, 'presenter.beat_done').length, 0, 'the silence after a lost session is not the end of the part');
  live.session = { id: 'session-2' };
  live.onNarrate = narrate;
  await presenter.control('resume');
  await until(() => last(store, 'presenter.done'), 'presenter.done');
  const texts = live.narrations.map(call => call.text);
  assert.equal(texts[1], SAYS[0]);
  assert.match(live.narrations[1].note, /^Your voice session restarted while you were presenting this part\. Your last words on it were: "\.\.\.Part one explains"\. Continue from there/);
  assert.deepEqual(texts.slice(2), [SAYS[1], SAYS[2]]);
  assert.deepEqual(events(store, 'presenter.beat_done').map(event => event.data.beat), [0, 1, 2]);
});

test('switching the robot out of speak mode mid-part pauses the walk without marking the part covered', async t => {
  const { store, live, presenter } = await setup(t, { voice: false });
  robotVoice(store, live, { speakMs: 150 });
  presenter.start();
  await until(() => cursorOf(store, 'stage-speech', 'onset'), 'first onset');
  store.update({ mode: 'listen' });
  await until(() => presenter.status().status === 'paused', 'paused');
  assert.equal(presenter.status().reason, 'not_in_speak_mode');
  await wait(250);
  assert.equal(events(store, 'presenter.beat_done').length, 0);
});

test('someone who starts talking as a part ends is not talked over: the next cue waits a full transcript-chunk gap', async t => {
  const { store, live, presenter } = await setup(t, { voice: false, timing: { utteranceQuietMs: 200 } });
  robotVoice(store, live); // onset 8 ms after the cue, end 25 ms later, then the 60 ms own-words tail
  let asked = null;
  const narrate = live.onNarrate;
  live.onNarrate = call => {
    narrate(call);
    if (live.narrations.length !== 1) return;
    // GPT Live's input transcript: " Hmm," inside part one's tail, the rest of the question one chunk later.
    later(() => live.say('user', ' Hmm,'), 8 + 25 + 20);
    later(() => { live.say('user', ' can you go back to the launch angle?'); asked = Date.now(); }, 8 + 25 + 20 + 120);
  };
  presenter.start();
  await until(() => live.narrations.length >= 2, 'second cue');
  assert.ok(asked && live.narrations[1].at >= asked, 'part two is cued only after the whole question arrived');
  assert.ok(live.narrations[1].at - asked >= 190, `cued ${live.narrations[1].at - asked} ms after the question`);
});

test('a share stopped while paused keeps the walk paused on "continue", and the robot is told why', async t => {
  const { store, live, presenter } = await setup(t, { voice: false });
  robotVoice(store, live, { speakMs: 250, words: call => (live.narrations.length === 1 ? 'Part one' : call.text) });
  presenter.start();
  await until(() => cursorOf(store, 'stage-speech', 'onset'), 'first onset');
  live.say('user', ' Wait,');
  live.say('user', ' can you');
  await until(() => presenter.status().status === 'paused', 'paused');
  store.update({ meeting: { ...store.state.meeting, sharing: false } }); // someone else presents, or Meet stopped ours
  store.event('stage-sharing', { type: 'stage-sharing', sharing: false });
  await wait(FAST.utteranceGapMs + 40);
  live.say('user', ' continue');
  await until(() => presenter.status().reason === 'not_sharing', 'paused: not sharing');
  assert.equal(presenter.status().status, 'paused');
  assert.equal(live.narrations.length, 1, 'nothing is narrated to a screen nobody sees');
  assert.ok(live.contexts.includes('Your shared screen is off, so the presentation is paused. It continues when the screen is shared again and someone says continue.'));
  store.update({ meeting: { ...store.state.meeting, sharing: true } });
  await presenter.control('resume');
  await until(() => last(store, 'presenter.done'), 'presenter.done', 6000);
});

test('pause can carry the reason of the command that caused it', async t => {
  const { store, live, presenter } = await setup(t, { voice: false });
  robotVoice(store, live, { speakMs: 250 });
  presenter.start();
  await until(() => cursorOf(store, 'stage-speech', 'onset'), 'first onset');
  await presenter.control('pause', 'screen_moved');
  assert.deepEqual([presenter.status().status, presenter.status().reason], ['paused', 'screen_moved']);
  await presenter.control('resume');
  await presenter.control('pause', 'Not A Reason!');
  assert.equal(presenter.status().reason, 'paused_by_command');
});

test('verbatim: after an interruption the robot is told where it stopped, beside the unchanged part', async t => {
  const { store, live, presenter } = await setup(t, { voice: false });
  robotVoice(store, live, { speakMs: 250, words: call => (live.narrations.length === 1 ? 'Part one explains' : call.text) });
  presenter.start({ style: 'verbatim' });
  await until(() => cursorOf(store, 'stage-speech', 'onset'), 'first onset');
  live.say('user', ' Wait,');
  live.say('user', ' sorry');
  await until(() => presenter.status().status === 'paused', 'paused');
  await wait(FAST.utteranceGapMs + 40);
  live.say('user', ' continue');
  await until(() => live.narrations.length === 2, 'part one picked up again');
  assert.equal(live.narrations[1].text, SAYS[0]);
  assert.equal(live.narrations[1].note, 'You were interrupted after saying: "...Part one explains". Say the rest of the text between the triple quotes from there.');
});

test('a part paused twice keeps everything said: covered across two stretches, it is not presented a third time', async t => {
  const { store, live, presenter } = await setup(t, { voice: false });
  // SAYS[0] has 8 content words: the first stretch says 5, the resumed one the other 3.
  robotVoice(store, live, { speakMs: 250, words: call => ({ 1: 'Part one explains the launch', 2: 'angle of thirty degrees' })[live.narrations.length] ?? call.text });
  presenter.start();
  const interrupt = async nth => {
    await until(() => cursorOf(store, 'stage-speech', 'onset', nth), `onset ${nth}`);
    await wait(20);
    live.say('user', ' Hold on,');
    live.say('user', ' one second');
    await until(() => presenter.status().status === 'paused', `paused ${nth}`);
    await wait(FAST.utteranceGapMs + 40);
    live.say('user', ' continue');
  };
  await interrupt(0);
  await interrupt(1);
  await until(() => last(store, 'presenter.done'), 'presenter.done', 6000);
  assert.deepEqual(live.narrations.map(call => call.text), [SAYS[0], SAYS[0], SAYS[1], SAYS[2]]);
  const first = events(store, 'presenter.beat_done')[0].data;
  assert.deepEqual([first.beat, first.endedBy, first.coverage], [0, 'covered_after_interruption', 1]);
});

test('goto the part that was interrupted presents it from the start', async t => {
  const { store, live, presenter } = await setup(t, { voice: false });
  robotVoice(store, live, { speakMs: 250 }); // the robot says the whole part, and is interrupted before it ends
  presenter.start();
  await until(() => cursorOf(store, 'stage-speech', 'onset'), 'first onset');
  await wait(40);
  live.say('user', ' Wait,');
  live.say('user', ' again please');
  await until(() => presenter.status().status === 'paused', 'paused');
  await presenter.control('goto', 0);
  await until(() => live.narrations.length === 2, 'part one cued again');
  assert.deepEqual([live.narrations[1].text, live.narrations[1].note], [SAYS[0], '']);
  assert.equal(events(store, 'presenter.beat_done').filter(event => event.data.endedBy === 'covered_after_interruption').length, 0);
});

test('a "continue" said just before a command pause does not undo the pause', async t => {
  const { store, live, presenter } = await setup(t, { voice: false });
  robotVoice(store, live, { speakMs: 400 });
  presenter.start();
  await until(() => cursorOf(store, 'stage-speech', 'onset'), 'first onset');
  live.say('user', ' continue'); // said while running: nothing to resume
  await presenter.control('pause', 'screen_moved'); // the agent moves the screen a moment later
  await wait(FAST.utteranceGapMs + 60); // the utterance's end timer has fired
  assert.deepEqual([presenter.status().status, presenter.status().reason], ['paused', 'screen_moved']);
});

test('after a spoken "continue", one more word does not pause the resumed part; a lead-in alone never pauses', async t => {
  const { store, live, presenter } = await setup(t, { voice: false });
  robotVoice(store, live, { speakMs: 300, words: call => (live.narrations.length === 1 ? 'Part one' : call.text) });
  presenter.start();
  await until(() => cursorOf(store, 'stage-speech', 'onset'), 'first onset');
  live.say('user', ' Wait,');
  live.say('user', ' a question');
  await until(() => presenter.status().status === 'paused', 'paused');
  await wait(FAST.utteranceGapMs + 40);
  live.say('user', ' continue');
  await until(() => live.narrations.length === 2, 'resumed and cued');
  live.say('user', ' thanks'); // inside the interrupt window of "continue"
  await wait(60);
  assert.equal(presenter.status().status, 'running', '"continue thanks" is not a new question');
  await wait(FAST.utteranceGapMs + 40);
  live.say('user', ' All right,'); // the first chunk of "All right, continue"
  await wait(30);
  assert.equal(presenter.status().status, 'running', 'a lead-in alone is not a question');
  assert.equal(events(store, 'presenter.paused').length, 1);
});

test('next, a command pause and stop stop the robot talking over the moved screen; a paused walk is not hushed', async t => {
  const { store, live, presenter } = await setup(t, { voice: false });
  robotVoice(store, live, { speakMs: 5000, ends: false }); // mid-part, no end
  presenter.start();
  await until(() => cursorOf(store, 'stage-speech', 'onset'), 'first onset');
  await presenter.control('next');
  const hushes = () => live.log.filter(entry => entry.kind === 'hush').length;
  assert.equal(hushes(), 1, 'next hushes the part in progress');
  await until(() => live.narrations.length === 2, 'part two cued');
  await wait(20);
  await presenter.control('pause');
  assert.equal(hushes(), 2, 'a command pause hushes');
  presenter.stop('stopped');
  assert.equal(hushes(), 2, 'stopping a paused walk has nothing to hush');
});

test('a cue whose "begin" could not be sent is retried', async t => {
  const { store, live, presenter } = await setup(t);
  let first = true;
  live.accept = () => { if (first) { first = false; return { sent: true, acked: true, cued: false }; } return { sent: true, acked: true }; };
  presenter.start();
  await until(() => last(store, 'presenter.done'), 'presenter.done');
  assert.equal(events(store, 'presenter.retry')[0]?.data.reason, 'not_accepted');
  assert.deepEqual(live.narrations.map(call => call.text), [SAYS[0], SAYS[0], SAYS[1], SAYS[2]]);
});

test('a transcript with no meeting audio behind it does not pause the part; real speech does', async t => {
  const { store, live, presenter } = await setup(t, { voice: false, timing: { inputLagMs: 100 } });
  robotVoice(store, live, { speakMs: 600 });
  // The page reports meeting audio: someone spoke earlier and stopped.
  store.event('stage-input', { type: 'stage-input', phase: 'onset', at: Date.now() - 5000 });
  store.event('stage-input', { type: 'stage-input', phase: 'end', at: Date.now() - 4000 });
  presenter.start();
  await until(() => cursorOf(store, 'stage-speech', 'onset'), 'first onset');
  live.say('user', ' this slide presents'); // speech recognition on a silent room
  await wait(40);
  assert.equal(presenter.status().status, 'running', 'no audio, no person');
  store.event('stage-input', { type: 'stage-input', phase: 'onset', at: Date.now() }); // a person really starts talking
  await wait(20);
  live.say('user', ' Wait, one question');
  await until(() => presenter.status().status === 'paused', 'paused by real speech');
  assert.equal(presenter.status().reason, 'person_speaking');
});

test('next / previous / goto move the stage at once and cue the new beat', async t => {
  // The robot never finishes on its own here (no end events, long budget), so only the commands move the walk.
  const { store, live, presenter, syncs } = await setup(t, { voice: false, timing: { quietMaxMs: 60, budget: () => 60000 } });
  robotVoice(store, live, { ends: false });
  presenter.start();
  await until(() => live.narrations.length === 1, 'beat 0 cue');
  const moves = [['next', undefined, 1], ['previous', undefined, 0], ['goto', 2, 2]];
  for (const [action, arg, beat] of moves) {
    const cues = live.narrations.length;
    const status = await presenter.control(action, arg);
    assert.equal(status.beat, beat);
    assert.equal(status.status, 'running');
    assert.deepEqual({ slide: store.state.slideIndex, view: store.state.viewIndex }, POSITION[beat]); // on stage when control returns
    assert.deepEqual({ slide: syncs.at(-1).slide, view: syncs.at(-1).view }, POSITION[beat]);
    assert.equal(last(store, 'presenter.moved').data.action, action);
    await until(() => live.narrations.length === cues + 1, `${action} cue`);
    assert.equal(live.narrations.at(-1).text, SAYS[beat]);
  }
  assert.equal((await presenter.control('next')).beat, 2); // no part after the last: nothing happens
  await assert.rejects(presenter.control('goto', 7), error => error.status === 400);
  await assert.rejects(presenter.control('jump'), error => error.status === 400);
  assert.equal(events(store, 'presenter.beat_done').length, 0);
});

test('a finished walk can go back; a paused walk continues from the moved-to beat', async t => {
  const { store, live, presenter } = await setup(t);
  presenter.start({ from: 1 });
  await until(() => last(store, 'presenter.done'), 'presenter.done');
  assert.deepEqual(live.narrations.map(call => call.text), [SAYS[1], SAYS[2]]);
  await presenter.control('previous');
  assert.equal(last(store, 'presenter.resumed').data.by, 'previous');
  await until(() => events(store, 'presenter.done').length === 2, 'second done');
  assert.equal(live.narrations.at(-1).text, SAYS[2]);
  await presenter.control('goto', 0);
  await presenter.control('pause');
  assert.equal(presenter.status().status, 'paused');
  assert.equal(presenter.status().reason, 'paused_by_command');
  await presenter.control('goto', 1);
  assert.equal(presenter.status().status, 'running');
  await until(() => events(store, 'presenter.done').length === 3, 'third done');
  assert.equal(live.narrations.at(-2).text, SAYS[1]);
});

test('pause holds during the quiet wait; stop ends the walk, releases listeners and refuses later moves', async t => {
  const { store, live, presenter } = await setup(t, { voice: false, timing: { quietMaxMs: 5000 } });
  robotVoice(store, live, { ends: false });
  const talk = setInterval(() => live.say('user', ' yes'), 10); // the room keeps talking: no quiet, no cue
  t.after(() => clearInterval(talk));
  presenter.start();
  await wait(60);
  assert.equal(live.narrations.length, 0);
  await presenter.control('pause');
  assert.equal(presenter.status().status, 'paused');
  clearInterval(talk);
  await presenter.control('resume');
  await until(() => live.narrations.length === 1, 'cue after quiet');
  const status = await presenter.control('stop');
  assert.equal(status.status, 'stopped');
  assert.equal(status.reason, 'stopped');
  assert.equal(last(store, 'presenter.stopped').data.reason, 'stopped');
  assert.equal(store.state.presenter.status, 'stopped');
  await wait(60);
  assert.equal(live.narrations.length, 1);
  assert.equal(live.listeners.size, 0);
  assert.equal(store.listenerCount('change'), 0);
  await assert.rejects(presenter.control('next'), error => error.status === 409);
  assert.equal((await presenter.control('stop')).status, 'stopped');
});

test('missing end events do not stall the walk: each beat ends by its time budget', async t => {
  const { store, live, presenter } = await setup(t, { voice: false, timing: { quietMaxMs: 60, budget: () => 80 } });
  robotVoice(store, live, { ends: false });
  presenter.start();
  await until(() => last(store, 'presenter.done'), 'presenter.done');
  const done = events(store, 'presenter.beat_done');
  assert.deepEqual(done.map(event => [event.data.beat, event.data.endedBy]), [[0, 'time_budget'], [1, 'time_budget'], [2, 'time_budget']]);
  assert.ok(done.every(event => event.data.speechMs >= 70));
  assert.equal(live.narrations.length, 3);
});

test('a cue the voice does not accept is retried once, then pauses; a silent voice is re-cued once, then pauses', async t => {
  const { store, live, presenter } = await setup(t, { voice: false });
  live.accept = () => ({ sent: true, acked: false });
  presenter.start();
  await until(() => presenter.status().status === 'paused', 'paused (not accepted)');
  assert.equal(presenter.status().reason, 'voice_did_not_accept');
  assert.equal(live.narrations.length, 2);
  assert.equal(last(store, 'presenter.retry').data.reason, 'not_accepted');
  live.accept = () => ({ sent: true, acked: true }); // accepted from now on, but the robot never starts speaking
  await presenter.control('resume');
  await until(() => presenter.status().reason === 'voice_silent', 'paused (silent)');
  assert.equal(live.narrations.length, 4);
  assert.equal(last(store, 'presenter.retry').data.reason, 'no_onset');
  assert.equal(events(store, 'presenter.beat_done').length, 0);
});

test('when the page reports stage moves, each cue waits for the report of its own move', async t => {
  const { store, live, presenter } = await setup(t, { timing: { shownWaitMs: 1000 } });
  // A page that reports moves, late (stage-sync coalescing a run in progress): 'stage-shown' 40 ms after each sync.
  store.event('stage-shown', { type: 'stage-shown', slide: 0, view: 0, at: Date.now() });
  const reported = [];
  const presenterWithPage = createPresenter({ store, live, timing: FAST, sync: async () => {
    const position = { slide: store.state.slideIndex, view: store.state.viewIndex };
    later(() => { reported.push({ ...position, at: Date.now() }); store.event('stage-shown', { type: 'stage-shown', ...position, at: Date.now() }); }, 40);
  } });
  t.after(() => presenterWithPage.stop('test_end'));
  presenter.stop('unused');
  presenterWithPage.start({ from: 1 });
  await until(() => last(store, 'presenter.done'), 'presenter.done');
  assert.deepEqual(live.narrations.map(call => call.text), [SAYS[1], SAYS[2]]);
  live.narrations.forEach((call, index) => {
    const shownFirst = reported.find(item => item.slide === POSITION[index + 1].slide && item.view === POSITION[index + 1].view);
    assert.ok(shownFirst && shownFirst.at <= call.at, `beat ${index + 1} was on stage before its cue`);
  });
});
