// TC-H1..H6: the fixes from the 2026-09-22 honest-tester baseline (tools/sim-participant/runs/honest-4), each pinned.
// The simulated meeting heard the robot read its screen notes aloud, announce "The box contains ..." five times in a
// row, greet over someone reading, and deny it could move its own screen. Each test below states the fixed behaviour.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.mjs';
import { watchPointerTruth } from '../src/screen-truth.mjs';
import { encodeFrame, KEYFRAME_MS } from '../src/screen-feed.mjs';
import { viewText } from '../src/screen-context.mjs';
import { readyToGreet, PAUSE_MS } from '../src/greet-policy.mjs';
import { realBriefing } from '../tools/sim-participant/briefing.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (predicate, timeout = 5000) => { const end = Date.now() + timeout; while (Date.now() < end) { if (predicate()) return true; await wait(10); } return false; };
const SRC = new URL('../public/slides/projectile-motion-deck/', import.meta.url);

// The truth watcher exactly as bin/start-live.mjs runs it: no phraseOf.
async function production(t) {
  const dir = await mkdtemp(join(tmpdir(), 'robomeet-honestfix-'));
  const publicDir = join(dir, 'public');
  await mkdir(join(publicDir, 'slides', 'pm'), { recursive: true });
  for (const name of ['deck.json', 'page-1.png', 'page-1-view-1.png', 'page-1-view-2.png', 'page-1-view-3.png']) await copyFile(new URL(name, SRC), join(publicDir, 'slides', 'pm', name));
  const facts = [], orders = [];
  const app = await createApp({ port: 0, dataDir: join(dir, 'data'), publicDir,
    workerFactory: () => ({ leave: async () => {}, join: async () => {}, present: async () => {}, syncStage: async () => {} }),
    liveFactory: () => ({ sessions: new Map(), closeAll: async () => {}, setMode() {}, activeSession: () => ({ id: 's' }),
      context: text => { facts.push(text); return true; }, instruct: async text => { orders.push(text); return true; }, onTranscript: () => () => {} }) });
  const stop = watchPointerTruth({ store: app.store, live: app.live, publicDir, debounceMs: 5 });
  t.after(async () => { stop(); await app.close(); await rm(dir, { recursive: true, force: true }); });
  await app.command({ type: 'present-deck', slug: 'pm' });
  return { app, facts, orders };
}

test('TC-H1: in production configuration a correct box is a quiet fact, not an order to speak', async t => {
  const { app, facts, orders } = await production(t);
  await app.command({ type: 'highlight', phrase: 'ẏ(0) = v0 sin θ' });
  assert.equal(app.store.state.pointer.phrase, 'ẏ(0) = v0 sin θ', 'the pointer records what was asked for');
  assert.ok(await until(() => facts.length > 0), 'the robot is told what the box holds');
  await wait(50);
  assert.match(facts[0].normalize('NFC'), /contains exactly/, 'checked against the request, so exact');
  assert.match(facts[0], /not to read out/);
  assert.equal(orders.length, 0, 'no instruction: an instruction makes the model speak, and there is nothing to forbid');
});

test('TC-H2: a box by equation number asks for no words, so it is a fact without "say only that" and no instruction', async t => {
  const { app, facts, orders } = await production(t);
  await app.command({ type: 'highlight', phrase: '(3)' });
  assert.equal(app.store.state.pointer.phrase, null, 'an equation number is not a phrase to check words against');
  assert.ok(await until(() => facts.length > 0));
  await wait(50);
  assert.doesNotMatch(facts[0], /Say only that/);
  assert.equal(orders.length, 0);
});

test('TC-H3: a box that is not what was asked for is still forbidden, in production configuration', async t => {
  const { app, facts, orders } = await production(t);
  // "x(0) = 0," is resolved at line level when the words cannot be matched alone; ask for a phrase the line pointer
  // widens: the whole velocity pair's line holds more than the asked half.
  await app.command({ type: 'highlight', phrase: 'Initial conditions' });
  assert.ok(await until(() => facts.length > 0));
  await wait(50);
  const verdict = facts[0].normalize('NFC');
  if (/contains exactly/.test(verdict)) assert.equal(orders.length, 0, 'exact: no order');
  else assert.ok(orders.length > 0, 'not exact: the over-claim is forbidden');
});

test('TC-H4: screen notes are marked as reference, and an unchanged screen is not re-sent by default', () => {
  assert.equal(KEYFRAME_MS, Infinity);
  const frame = encodeFrame({ sharing: true, title: 'Projectile Motion', page: 1, pages: 1, part: 1, parts: 3, moving: false, shows: 'Setup', box: null }, null);
  assert.match(frame, /^SCREEN: Projectile Motion, page 1 of 1, part 1 of 3; no box is drawn\./);
  assert.match(frame, /not to read out/);
  assert.ok(frame.length <= 440, 'still inside one context append');
  const text = viewText({ title: 'Projectile motion', slideIndex: 0, viewIndex: 0, slides: [{ views: [{ lines: ['A point mass', 'm ẍ = 0 (1)'] }] }] });
  assert.match(text, /^On your shared screen now: Projectile motion, page 1, part 1 of 1\./);
  assert.match(text, /not something to read out/);
  assert.match(text, /\[line n\] labels are not equation numbers/);
});

test('TC-H5: the greeting waits for a pause in someone\'s speech', () => {
  const now = 100000;
  assert.equal(readyToGreet({ media: { input: 'active', lastAudibleAt: now }, now }), false, 'not while someone is talking');
  assert.equal(readyToGreet({ media: { input: 'idle', lastAudibleAt: now - 500 }, now }), false, 'not in the middle of a sentence');
  assert.equal(readyToGreet({ media: { input: 'idle', lastAudibleAt: now - PAUSE_MS - 1 }, now }), true, 'after a pause');
  assert.equal(readyToGreet({ media: {}, now }), true, 'nobody has spoken yet');
  const attend = await_read('bin/attend.mjs');
  assert.match(attend, /readyToGreet\(\{ media, now \}\)/, 'attend greets only when the policy allows');
});
function await_read(path) { return require_text(new URL(`../${path}`, import.meta.url)); }
import { readFileSync } from 'node:fs';
function require_text(url) { return readFileSync(url, 'utf8'); }

test('TC-H6: the briefing says what the robot can really do, and does not decide who is speaking', async () => {
  delete process.env.HONEST_ATTEND_SRC;
  const b = await realBriefing({ purpose: 'Alex is meeting you.' });
  assert.ok(!b.includes('Only the coding session can move it'), 'the stale claim is gone: the robot has scroll');
  assert.ok(b.includes('You move it yourself with scroll'));
  assert.ok(b.includes('point_at draws an amber box') && b.includes('scroll moves your shared screen'), 'the tool list names every tool');
  assert.ok(!b.includes('The person speaking is Vivek'), 'no default speaker');
  assert.ok(b.includes('never guess who is speaking'));
  assert.ok(b.includes('never read them out'), 'screen notes are not to be read out');
  assert.ok(b.includes('Only your tools act'), 'no claimed action without a tool');
  assert.ok(b.includes('just listen'), 'the listening dial');
  assert.ok(b.includes('Be yourself'), "Vivek's own line is kept");
});

test('TC-H7: the robot is given the displayed formulas written out correctly, not only the flattened text layer', async () => {
  const deck = JSON.parse(await readFile(new URL('deck.json', SRC), 'utf8'));
  const part2 = deck.slides[0].views[1];
  assert.ok(part2.lines.map(line => typeof line === 'string' ? line : line.text).includes('v 0 2 sin 2 θ'), 'the text layer really does flatten H = v0² sin²θ / 2g');
  assert.ok(part2.math.some(line => line.startsWith('(8)') && line.includes('sin²θ') && line.includes('2g')), '(8) is transcribed with sin²θ');
  assert.ok(part2.math.some(line => line.startsWith('(9)') && line.includes('sin 2θ')), '(9) keeps sin 2θ');
  const text = viewText({ title: 'Projectile Motion', slideIndex: 0, viewIndex: 1, slides: deck.slides });
  assert.match(text, /written out correctly/);
  assert.ok(text.includes(part2.math.find(line => line.startsWith('(8)'))), 'the transcription reaches the robot with the part');
  assert.ok(text.length <= 4400, 'still one bounded context update');
});

import { Store } from '../src/store.mjs';
import { watchScreen } from '../src/screen-context.mjs';
import { cueFor, RESTART_CUE, REJOIN_CUE } from '../src/greet-policy.mjs';

test('TC-H8: the full screen text waits for someone to speak, instead of landing in a quiet room', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'robomeet-hold-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(dir), sent = [];
  const live = { activeSession: () => ({ id: 's' }), context: text => { sent.push(text); return true; } };
  const stop = watchScreen({ store, live, debounceMs: 5, untilSpeech: true });
  t.after(stop);
  store.update({ meeting: { ...store.state.meeting, sharing: true }, title: 'Notes', slides: [{ views: [{ lines: ['one'] }, { lines: ['two'] }] }], slideIndex: 0, viewIndex: 1 }, 'presentation.stage', {});
  await wait(60);
  assert.equal(sent.length, 0, 'a move in a quiet room sends nothing yet');
  store.event('stage-input', { phase: 'onset', at: Date.now() });
  assert.ok(await until(() => sent.length === 1), 'it goes out when someone starts speaking');
  assert.match(sent[0], /part 2 of 2/);
  store.event('stage-input', { phase: 'end', at: Date.now() });
  store.event('stage-input', { phase: 'onset', at: Date.now() });
  await wait(60);
  assert.equal(sent.length, 1, 'once per position');
});

test('TC-H9: after a voice restart or a rejoin the robot is told the truth, not that someone joined', () => {
  const greeting = 'Someone just joined the meeting with you.';
  assert.equal(cueFor({ greeting }), greeting, 'first time: greet');
  assert.equal(cueFor({ greetedBefore: true, greeting }), RESTART_CUE, 'voice restarted, same people');
  assert.equal(cueFor({ greetedBefore: true, leftAlone: true, greeting }), greeting, 'everyone left and someone came: greet');
  assert.equal(cueFor({ rejoined: true, greeting }), REJOIN_CUE, 'a relaunch with a recap');
  const attend = readFileSync(new URL('../bin/attend.mjs', import.meta.url), 'utf8');
  assert.match(attend, /cueFor\(\{ greetedBefore, leftAlone, rejoined, greeting: greetingCue \}\)/);
  assert.match(attend, /'You' : 'Someone'/, 'the recap does not name who spoke');
});

import { deckMap } from '../src/screen-context.mjs';
test('TC-H10: the deck\'s content reaches the robot once, as a map of parts with clean formulas, and a move sends no text', async t => {
  const deck = JSON.parse(await readFile(new URL('deck.json', SRC), 'utf8'));
  const map = deckMap({ title: 'Projectile Motion', slides: deck.slides });
  assert.match(map, /part 2: Three results; Time of flight: y = 0 again/);
  assert.ok(map.includes('sin²θ') || map.includes('sin² θ'), 'the formulas are written out');
  assert.ok(!/2v 0 2 cos 2 θ/.test(map), 'no flattened maths as headings');
  assert.ok(map.length < 2000);
  const dir = await mkdtemp(join(tmpdir(), 'robomeet-map-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(dir), sent = [];
  const stop = watchScreen({ store, live: { activeSession: () => ({ id: 's' }), context: text => { sent.push(text); return true; } }, debounceMs: 5, mapOnce: true });
  t.after(stop);
  store.update({ meeting: { ...store.state.meeting, sharing: true }, title: 'Projectile Motion', deckSlug: 'pm', slides: deck.slides, slideIndex: 0, viewIndex: 0 }, 'presentation.present', {});
  assert.ok(await until(() => sent.length === 1), 'the map goes out when the deck is shared');
  store.update({ viewIndex: 1 }, 'presentation.stage', {}); store.update({ viewIndex: 2 }, 'presentation.stage', {});
  await wait(60);
  assert.equal(sent.length, 1, 'moves add no text (the SCREEN feed reports them)');
  assert.ok(readFileSync(new URL('../src/server.mjs', import.meta.url), 'utf8').includes('watchScreen({ store, live, mapOnce: true })'), 'production uses the map');
});
