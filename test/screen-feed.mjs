// TC-V8: the feed. GPT Live takes audio and text ("Unsupported modalities: image, video"), so a real-time visual
// feed into it has to be text. This is a frame loop with a frame rate, a keyframe, deltas, and dropped identical
// frames, which is what makes it a feed rather than a sequence of events.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { sampleScreen, encodeFrame, startScreenFeed, DEFAULT_FPS } from '../src/screen-feed.mjs';
import { wordBoxesForPdf, wordsInView } from '../src/word-boxes.mjs';
import { findPhrase } from '../src/fine-pointer.mjs';
import { EventEmitter } from 'node:events';

const deck = JSON.parse(await readFile(new URL('../public/slides/projectile-motion-deck/deck.json', import.meta.url), 'utf8'));
const pages = await wordBoxesForPdf(new URL('../docs/projectile-motion/projectile_motion.pdf', import.meta.url).pathname, 1);
const WORDS = { pages };
const VIEWS = deck.slides[0].views.map((v, i) => ({ x: v.x, y: v.y, w: v.w, h: v.h, asset: `/a/page-1-view-${i + 1}.png` }));
const HIT = findPhrase(wordsInView(pages[0].words, deck.slides[0].views[0]), 'ẏ(0) = v 0 sin θ');
const base = { meeting: { sharing: true }, title: 'Projectile Motion', slides: [{ title: 'Projectile Motion', page: 1, views: VIEWS }], slideIndex: 0, viewIndex: 0, pointer: null };
const boxed = () => { const slides = structuredClone(base.slides); slides[0].views[0].highlight = HIT.rect; return { ...base, slides, pointer: { slide: 0, view: 0 } }; };

test('TC-V8: a frame says where the screen is and what the box holds; no sharing says so once', () => {
  const frame = encodeFrame(sampleScreen(base, WORDS), null);
  assert.match(frame, /^SCREEN: Projectile Motion, page 1 of 1, part 1 of 3; no box is drawn\./);
  const withBox = encodeFrame(sampleScreen(boxed(), WORDS), null);
  assert.ok(withBox.normalize('NFC').includes('contains exactly "ẏ(0) = v 0 sin θ"'), withBox);
  assert.match(withBox, /and nothing else/);
  const off = sampleScreen({ ...base, meeting: { sharing: false } }, WORDS);
  assert.equal(off.sharing, false);
  assert.match(encodeFrame(off, null), /not sharing/);
  assert.equal(encodeFrame(off, off), null, 'not-sharing is not repeated every frame');
});

test('TC-V8: identical frames are dropped and changes are sent as deltas, not whole frames', () => {
  const still = sampleScreen(base, WORDS);
  assert.equal(encodeFrame(still, still), null, 'nothing moved: no frame at all');
  const moved = sampleScreen({ ...base, viewIndex: 1 }, WORDS);
  const delta = encodeFrame(moved, still);
  assert.match(delta, /^SCREEN: now on .*part 2 of 3\./, 'a move sends only the move');
  assert.ok(!/box/.test(delta), 'the unchanged box is not repeated');
  const appeared = encodeFrame(sampleScreen(boxed(), WORDS), still);
  assert.ok(/box contains exactly/.test(appeared) && !/now on/.test(appeared), 'a box sends only the box');
  assert.ok(!/It shows:/.test(appeared), 'a box appearing does not change what is visible, so the index is not resent');
});

test('TC-V8: a box RoboMeet cannot check is reported as uncheckable, never described', () => {
  const frame = encodeFrame(sampleScreen(boxed(), null), null); // no word boxes for this deck
  assert.match(frame, /cannot check what is in it, so claim nothing about it/);
  // A pointer left on another view is not on this screen, so it is not reported as a box here.
  const elsewhere = sampleScreen({ ...boxed(), viewIndex: 1 }, WORDS);
  assert.equal(elsewhere.box, null, 'a box on part 1 is not a box on part 2');
});

test('TC-V8: the loop runs at a frame rate, keyframes on a timer, and never sends past the append cap', async () => {
  const store = new EventEmitter();
  store.state = base;
  const sent = [];
  const live = { activeSession: () => ({ id: 's' }), context: text => { sent.push(text); return true; } };
  let clock = 0;
  const feed = startScreenFeed({ store, live, wordsFor: async () => WORDS, fps: DEFAULT_FPS, keyframeMs: 1000, now: () => clock });
  await feed.tick();
  assert.equal(sent.length, 1, 'the first frame is a keyframe');
  await feed.tick();
  assert.equal(sent.length, 1, 'an unchanged screen sends nothing');
  store.state = boxed();
  await feed.tick();
  assert.equal(sent.length, 2, 'the box is a frame');
  clock += 2000; // past the keyframe interval
  await feed.tick();
  assert.equal(sent.length, 3, 'a keyframe resends the whole state so a dropped delta cannot desync');
  assert.match(sent[2], /page 1 of 1, part 1 of 3/, 'the keyframe is whole, not a delta');
  for (const frame of sent) assert.ok(frame.length <= 420, `${frame.length} chars is inside the 500-token append cap`);
  assert.ok(feed.stats.frames >= 4 && feed.stats.dropped >= 1);
  feed.stop();
});

test('TC-V8: encoding a frame costs microseconds, which is what makes it a feed and not a request', async () => {
  const withBox = boxed();
  const times = [];
  for (let i = 0; i < 2000; i++) {
    const started = process.hrtime.bigint();
    encodeFrame(sampleScreen(i % 2 ? withBox : base, WORDS), null);
    times.push(Number(process.hrtime.bigint() - started) / 1000);
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  assert.ok(median < 1000, `${median.toFixed(1)} us median is under a millisecond`);
});

test('TC-V8: a feed never throws into its interval, and stops cleanly', async () => {
  const store = new EventEmitter();
  Object.defineProperty(store, 'state', { get() { throw new Error('store exploded'); } });
  const feed = startScreenFeed({ store, live: { activeSession: () => null }, wordsFor: async () => null });
  await feed.tick(); // must not reject
  feed.stop();
  const quiet = startScreenFeed({ store: Object.assign(new EventEmitter(), { state: base }), live: { activeSession: () => null }, wordsFor: async () => WORDS });
  await quiet.tick();
  assert.equal(quiet.stats.sent, 0, 'no voice session: nothing is sent');
  quiet.stop();
});

test('TC-V8: a move carries a short index of what is visible, so "is X on screen?" is answerable', () => {
  // The behavioural loop (BL5) caught this: with only a position, the robot could not say whether the range formula
  // was up even while standing on the part that shows it, and an honest "I was not told" grades as refusing a truth.
  const withLines = { ...base, slides: [{ title: 'Projectile Motion', page: 1, views: deck.slides[0].views.map((v, i) => ({ ...v, asset: `/a/v${i}.png` })) }] };
  const part1 = encodeFrame(sampleScreen({ ...withLines, viewIndex: 0 }, WORDS), null);
  const part3 = encodeFrame(sampleScreen({ ...withLines, viewIndex: 2 }, WORDS), sampleScreen({ ...withLines, viewIndex: 0 }, WORDS));
  assert.match(part1, /It shows:/);
  assert.ok(part1.normalize('NFC').includes('Initial conditions:'), 'part 1 lists its own landmarks');
  assert.ok(!/Range/.test(part1), 'and not another part\'s');
  assert.ok(/Range/.test(part3), 'part 3 lists the range heading, which is what BL5 asked about');
  for (const frame of [part1, part3]) assert.ok(frame.length <= 440, `${frame.length} chars stays inside the append cap`);
  // A long paragraph is not a landmark and must not crowd out the labels.
  assert.ok(!part1.includes('A point mass m is launched'), 'paragraphs are excluded');
});
